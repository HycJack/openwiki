#!/usr/bin/env node
/**
 * CLI 入口 — 使用 Agent (封装 runAgentLoop) 驱动真正的 LLM 对话
 *
 * 参考 pi-mono 的 main.ts + sdk.ts 设计：
 * - Agent 构造函数传入 model/tools/systemPrompt
 * - Agent.agentLoop(input) → 内部调用 runAgentLoop → streamOpenAI
 * - Agent.subscribe() 监听事件 → 驱动 TUI 更新
 * - 支持 --print 非交互模式
 */

import { Agent } from "./agent.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createBuiltinTools } from "./tools/index.js";
import {
  createPluginRuntime,
  loadPlugins,
  discoverPlugins,
  getPluginDir,
  getGlobalPluginDir,
  createPluginRunner,
  PluginRunner,
} from "./plugin/index.js";
import { streamOpenAI } from "./providers/openai.js";
import { createChatTUI } from "./tui/index.js";
import type { ChatTUI } from "./tui/index.js";
import { SessionManager } from "./session-manager.js";
import type { SessionMeta } from "./session-store.js";
import { loadEnv } from "./env.js";
import { loadConfig, TCAConfig } from "./config.js";
import { estimateContextUsage } from "./token-estimate.js";
import {
  findCutPoint,
  buildCompactedMessages,
  buildCompactionPrompt,
  createCompactionEntry,
  isCompactionSummary,
  summaryOffsetOf,
} from "./compaction.js";
import { convertToLlm } from "./llm.js";
import type { AgentTool, ModelConfig, TextContent, AgentMessage, AgentEvent } from "./types.js";

// ============================================================================
// 参数解析
// ============================================================================

interface CliArgs {
  model?: string;
  provider?: string;
  baseURL?: string;
  print?: string;
  plugins?: string[];
  cwd?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--model": case "-m": args.model = argv[++i]; break;
      case "--provider": case "-p": args.provider = argv[++i]; break;
      case "--base-url": args.baseURL = argv[++i]; break;
      case "--print": args.print = argv[++i]; break;
      case "--plugin": (args.plugins ??= []).push(argv[++i]); break;
      case "--cwd": args.cwd = argv[++i]; break;
      case "--help": case "-h": args.help = true; break;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
tui-agent-refactor - A pi-tui based coding agent

Usage: npx tsx src/cli.ts [options]

Options:
  -m, --model <id>       Model ID (default: gpt-4o)
  -p, --provider <name>  Provider name (default: openai)
      --base-url <url>   Custom API base URL
      --print <prompt>   Non-interactive mode
      --plugin <path>    Load a plugin
      --cwd <path>       Working directory
  -h, --help             Show this help

Requires OPENAI_API_KEY environment variable (or in .env).
`);
}

// ============================================================================
// 解析模型配置
// ============================================================================

async function resolveModelConfig(args: CliArgs): Promise<ModelConfig> {
  const config = await loadConfig();
  const modelId = args.model ?? config.defaultModel ?? process.env.OPENAI_MODEL ?? "gpt-4o";
  const provider = args.provider ?? config.defaultProvider ?? "openai";
  const baseURL = args.baseURL ?? config.baseURL ?? process.env.OPENAI_BASE_URL;

  return {
    id: modelId,
    name: modelId,
    provider,
    apiKey: process.env.OPENAI_API_KEY,
    baseURL,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const cwd = args.cwd ?? process.cwd();
  await loadEnv(cwd);

  const userConfig = await loadConfig();

  const model = await resolveModelConfig(args);

  if (!model.apiKey) {
    console.error("Error: OPENAI_API_KEY is required.");
    process.exit(1);
  }

  // 加载插件
  const pluginRuntime = createPluginRuntime();
  const pluginPaths = [
    ...(args.plugins ?? []),
    ...discoverPlugins(getPluginDir(cwd)),
    ...discoverPlugins(getGlobalPluginDir()),
  ];
  const loadResult = await loadPlugins(pluginPaths, cwd, pluginRuntime);
  for (const err of loadResult.errors) {
    console.error(`Plugin load error: ${err.path}: ${err.error}`);
  }

  // 构建工具
  const builtinTools = createBuiltinTools();
  const pluginTools = loadResult.plugins.flatMap((p) => Array.from(p.tools.values()));
  const toolMap = new Map<string, AgentTool>();
  for (const tool of builtinTools) toolMap.set(tool.name, tool);
  for (const tool of pluginTools) { if (!toolMap.has(tool.name)) toolMap.set(tool.name, tool); }
  const allTools = Array.from(toolMap.values());

  const systemPrompt = buildSystemPrompt({ cwd, tools: allTools });

  // 创建插件 runner
  const pluginRunner = createPluginRunner(loadResult, pluginRuntime, { cwd, model, systemPrompt });

  // 创建 Agent — 传入 streamLLM provider（默认用 streamOpenAI）
  // onCompaction 回调在 sessionMgr 初始化后注入
  const agent = new Agent({
    systemPrompt,
    model,
    tools: allTools,
    streamLLM: streamOpenAI,
  });

  // 初始化 SessionManager — 自动加载/创建最新 session
  const sessionMgr = new SessionManager({ cwd, modelId: model.id });
  const savedMessages = await sessionMgr.init();
  if (!sessionMgr.isNew && savedMessages.length > 0) {
    // 恢复历史上下文
    agent.setMessages(savedMessages);
  }

  // 注入 compaction 持久化回调（参考 pi-mono 的 appendCompaction）
  // autoCompactIfNeeded 完成后，将 CompactionEntry 追加到 session JSONL
  agent.setCompactionCallback(async (summary, cutPoint, keptMessages) => {
    // 找到 firstKeptEntryId：cutPoint.firstKeptIndex 是 agent._messages 索引，需要映射到 entry id
    // 通过检查 agent（而非 keptMessages）判断是否有 summary 偏移，
    // 因为 keptMessages 是 compacted 结果（一定以 summary 开头），
    // 但 agent._messages 在回调执行时尚未更新
    const summaryOffset = summaryOffsetOf(agent.state.messages);
    const firstKeptEntryId = sessionMgr.getEntryIdByMessageIndex(cutPoint.firstKeptIndex, summaryOffset);
    if (!firstKeptEntryId) {
      throw new Error("Cannot find firstKeptEntryId for compaction");
    }
    const entry = createCompactionEntry(summary, cutPoint, firstKeptEntryId);
    await sessionMgr.appendCompaction(entry);
  });

  // 绑定插件到 agent
  pluginRunner.bindCore({
    isIdle: () => !agent.state.isStreaming,
    abort: () => agent.abort(),
    waitForIdle: () => agent.waitForIdle(),
    sendMessage: (c) => { agent.agentLoop(c).catch(() => {}); },
    getActiveTools: () => agent.state.tools.map((t) => t.name),
    getAllTools: () => allTools.map((t) => t.name),
    setActiveTools: (names) => { agent.tools = allTools.filter((t) => names.includes(t.name)); },
    notify: (m, t) => {
      const prefix = t === "error" ? "[ERROR]" : t === "warning" ? "[WARN]" : "[INFO]";
      console.log(`${prefix} ${m}`);
      agent.notifyUI(m, t ?? "info");
    },
    getMessageCount: () => agent.state.messageCount,
  });

  // 插件事件转发
  agent.subscribe(async (event) => { await pluginRunner.emit(event as any); });

  // 运行模式
  if (args.print) {
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const text = event.message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        process.stdout.write(text);
      }
      // 过滤图片：不打印 base64
    });
    await agent.agentLoop(args.print);
    return;
  }

  // 交互模式 — 使用 pi-mono 风格 TUI
  const chat = createChatTUI({
    modelLabel: model.id,
    onCtrlC() {
      if (agent.state.isStreaming) {
        agent.abort();
        chat.setStatus("Aborted", "idle");
        return true;
      }
      return false;
    },
  });

  // 绑定插件 TUI Slot API，允许插件控制 TUI 组件
  pluginRunner.bindSlotAPI({
    setHeader: (content, component) => content && chat.tui.requestRender(),
    setFooter: (content, component) => content && chat.tui.requestRender(),
    setWidget: (key, content, options) => content && chat.tui.requestRender(),
    setStatus: (key, text) => {
      if (text) chat.statusBar.modelLabel = text;
      chat.tui.requestRender();
    },
    setTitle: (title) => {
      chat.statusBar.modelLabel = title;
      chat.tui.requestRender();
    },
  });

  // Esc 取消当前轮对话
  chat.inputBar.onCancel = () => {
    if (agent.state.isStreaming) {
      agent.abort();
      chat.setStatus("Aborted", "idle");
    }
  };

  // 输入提交
  chat.inputBar.onSubmit = async (text: string) => {
    const cmd = text.trim();
    if (cmd === "") return;

    // 处理命令
    if (cmd.startsWith("/")) {
      chat.inputBar.clear();
      await handleCommand(cmd, { agent, chat, config: userConfig, model, cwd, allTools, sessionMgr, pluginRunner });
      return;
    }

    chat.inputBar.clear();
    chat.setStatus("Streaming...", "streaming");
    chat.updateMessages(agent.state.messages); // 展示用户消息

    agent.agentLoop(cmd)
      .then(() => {
        chat.setStatus("Ready", "idle");
        chat.updateMessages(agent.state.messages);
      })
      .catch((err: Error) => {
        chat.setStatus(`Error: ${err.message}`, "error");
      });
  };

  // 订阅 AI 流式输出 — 实时显示 AI 的增量内容
  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.message.role === "assistant" && event.delta) {
          chat.appendStreamingDelta(event.delta);
        }
        break;
      case "turn_end":
        // 整轮结束，重置流式状态并刷新
        chat.messageList.streamingMessage = null;
        // 从 agent.state.messages 获取最新消息（含本轮 AI 回复和 tool 结果）
        chat.updateMessages(agent.state.messages);
        // 额外重绘确保显示
        chat.tui.requestRender();
        break;
      case "agent_end":
        // 确保所有消息已显示
        chat.updateMessages(agent.state.messages);
        chat.setStatus("Ready", "idle");
        chat.tui.requestRender();
        // 自动保存到 session（链式调用，避免并发问题）
        sessionMgr.scheduleFlush(agent.state.messages);
        break;
      case "notification":
        // 在 TUI 中显示通知
        if (event.level === "error") {
          chat.setStatus(event.message, "error");
        } else {
          // info/warning 级别用 console.log 输出
          console.log(`\x1b[90m${event.message}\x1b[0m`);
        }
        break;
    }
  });

  // 启动 TUI
  chat.tui.start();
}

// ============================================================================
// 命令处理 — 参考 pi-mono 的 commands
// ============================================================================

interface CommandCtx {
  agent: Agent;
  chat: ChatTUI;
  config: TCAConfig;
  model: ModelConfig;
  cwd: string;
  allTools: AgentTool[];
  sessionMgr: SessionManager;
  pluginRunner: PluginRunner;
}

async function handleCommand(cmd: string, ctx: CommandCtx): Promise<void> {
  const [name, ...args] = cmd.split(/\s+/);

  switch (name) {
    case "/exit":
    case "/quit":
      ctx.chat.stop();
      process.exit(0);
      return;

    case "/help":
    case "/?":
      showHelp(ctx);
      return;

    case "/clear":
      process.stdout.write("\x1b[2J\x1b[H");
      return;

    case "/model":
      await handleModelCommand(args, ctx);
      return;

    case "/tokens":
    case "/usage":
      handleTokens(ctx);
      return;

    case "/ctx":
      await handleCtxCommand(args, ctx);
      return;

    case "/compact":
      await handleCompactCommand(args, ctx);
      return;

    case "/sessions":
      await handleSessionsCommand(ctx);
      return;

    case "/session":
      await handleSessionCommand(args, ctx);
      return;

    case "/tree":
      handleTree(ctx);
      return;

    case "/fork":
      await handleForkCommand(args, ctx);
      return;

    default:
      // 尝试插件注册的命令
      if (await ctx.pluginRunner.executeCommand(name, args.join(" "))) return;
      ctx.chat.setStatus(`Unknown command: ${name}. Type /help`, "error");
      setTimeout(() => ctx.chat.setStatus("Ready", "idle"), 2000);
  }
}

function showHelp(ctx: CommandCtx): void {
  type styles = [string, string];
  const hl = (s: string): string => `\x1b[33m${s}\x1b[0m`;  // yellow
  const dim = (s: string): string => `\x1b[90m${s}\x1b[0m`; // gray

  const lines = [
    dim("── Commands ──────────────────────────────────────────────"),
    `${hl("/help")}       ${dim("Show this help")}`,
    `${hl("/clear")}      ${dim("Clear screen")}`,
    `${hl("/model")}      ${dim("Switch model: /model <provider>:<id>")}`,
    `${hl("/tokens")}     ${dim("Show estimated token usage")}`,
    `${hl("/ctx")}        ${dim("Context usage overview")}`,
    `${hl("/ctx compact")} ${dim("Trigger context compression")}`,
    `${hl("/compact")}    ${dim("Compact with instructions: /compact <notes>")}`,
    `${hl("/sessions")}   ${dim("List all sessions")}`,
    `${hl("/session")}    ${dim("Switch session: /session <id>, /session new")}`,
    `${hl("/tree")}       ${dim("Show session tree")}`,
    `${hl("/fork")}       ${dim("Branch from a session entry: /fork <id>")}`,
    `${hl("/exit")}       ${dim("Exit the agent")}`,
    dim("────────────────────────────────────────────────────"),
    `${dim("Model: " + (ctx.config.defaultModel ?? ctx.model.id))}`,
  ];

  const pluginCmds = ctx.pluginRunner.getRegisteredCommands();
  if (pluginCmds.length > 0) {
    lines.push(dim("── Plugin Commands ────────────────────────────────────────"));
    for (const cmd of pluginCmds) {
      lines.push(`${hl("/" + cmd.name)}     ${cmd.description ? dim(cmd.description) : ""}`);
    }
    lines.push(dim("────────────────────────────────────────────────────"));
  }
  console.log(lines.join("\n"));
}

async function handleModelCommand(args: string[], ctx: CommandCtx): Promise<void> {
  const modelArg = args[0];
  if (!modelArg) {
    ctx.chat.setStatus(`Current model: ${ctx.model.id}`, "idle");
    // 显示可用模型列表
    const models = ctx.config.models ?? [];
    if (models.length > 0) {
      console.log(`\x1b[90mAvailable models:\x1b[0m`);
      for (const m of models) {
        console.log(`  \x1b[33m${m.provider}:${m.id}\x1b[0m${m.name ? ` \x1b[90m- ${m.name}\x1b[0m` : ""}`);
      }
    } else {
      console.log(`\x1b[90m  No saved models. Use /model <provider>:<id> to switch.\x1b[0m`);
    }
    return;
  }

  // Parse provider:id
  const colonIdx = modelArg.indexOf(":");
  const provider = colonIdx >= 0 ? modelArg.slice(0, colonIdx) : ctx.model.provider;
  const modelId = colonIdx >= 0 ? modelArg.slice(colonIdx + 1) : modelArg;

  // 查找 config 中的匹配模型
  const savedModel = ctx.config.models?.find(
    (m) => m.id === modelId && m.provider === provider,
  );

  ctx.agent.model = {
    id: modelId,
    name: savedModel?.name ?? modelId,
    provider,
    apiKey: savedModel?.apiKey ?? ctx.model.apiKey,
    baseURL: savedModel?.baseURL ?? ctx.model.baseURL,
  };

  ctx.chat.setModelLabel(modelId);
  ctx.chat.setStatus(`Switched to ${provider}:${modelId}`, "idle");
}

function handleTokens(ctx: CommandCtx): void {
  const usage = estimateContextUsage(
    ctx.agent.state.messages,
    ctx.agent.state.systemPrompt,
    ctx.model.contextWindow ?? 128000,
  );

  const barWidth = 30;
  const filled = Math.round((usage.percent / 100) * barWidth);
  const bar = "\x1b[33m" + "█".repeat(filled) + "\x1b[90m" + "░".repeat(Math.max(0, barWidth - filled)) + "\x1b[0m";
  const pct = usage.percent.toFixed(1);

  console.log([
    `\x1b[90m── Tokens ────────────────────────────\x1b[0m`,
    `  ${bar}  ${pct}%`,
    `  \x1b[2mTokens:\x1b[0m ${usage.tokens} / ${usage.limit}`,
    `\x1b[90m──────────────────────────────────────\x1b[0m`,
  ].join("\n"));
}

async function handleCtxCommand(args: string[], ctx: CommandCtx): Promise<void> {
  const sub = args[0];

  if (sub === "compact") {
    await performCompact(ctx, "");
    return;
  }

  // 默认显示上下文概览
  const usage = estimateContextUsage(
    ctx.agent.state.messages,
    ctx.agent.state.systemPrompt,
    ctx.model.contextWindow ?? 128000,
  );

  const barWidth = 30;
  const filled = Math.round((usage.percent / 100) * barWidth);
  const bar = "\x1b[33m" + "█".repeat(filled) + "\x1b[90m" + "░".repeat(Math.max(0, barWidth - filled)) + "\x1b[0m";
  const pct = usage.percent.toFixed(1);

  console.log([
    `\x1b[90m── Context ────────────────────────────\x1b[0m`,
    `  ${bar}  ${pct}%`,
    `  \x1b[2mTokens:\x1b[0m ${usage.tokens} / ${usage.limit}`,
    `  \x1b[2mMessages:\x1b[0m ${ctx.agent.state.messages.length}`,
    `  \x1b[2mWindow:\x1b[0m ${ctx.model.id} (${usage.limit} tokens)`,
    `\x1b[90m──────────────────────────────────────\x1b[0m`,
    `\x1b[90mUse /ctx compact to compress.\x1b[0m`,
  ].join("\n"));
}

async function handleCompactCommand(args: string[], ctx: CommandCtx): Promise<void> {
  const instructions = args.join(" ") || "";
  await performCompact(ctx, instructions);
}

async function performCompact(ctx: CommandCtx, _instructions: string): Promise<void> {
  const messages = ctx.agent.state.messages;
  if (messages.length === 0) {
    console.log(`\x1b[90mNo messages to compact.\x1b[0m`);
    return;
  }

  const cutPoint = findCutPoint(messages, 4000);
  if (!cutPoint) {
    console.log(`\x1b[90mContext is small enough, no compaction needed.\x1b[0m`);
    return;
  }

  ctx.chat.setStatus(`Compacting ${cutPoint.truncatedCount} messages...`, "streaming");

  try {
    const messagesToSummarize = messages.slice(0, cutPoint.firstKeptIndex);
    const prompt = buildCompactionPrompt({
      messagesToSummarize,
      keptMessages: messages.slice(cutPoint.firstKeptIndex),
      instructions: _instructions || undefined,
    });

    // 直接调用 streamOpenAI 做压缩摘要
    const llmMessages = await convertToLlm([
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      },
    ]);

    const stream = streamOpenAI(
      ctx.model,
      llmMessages,
      "",
      [],
      { signal: ctx.agent.signal },
    );

    let summaryText = "[Compacted by LLM]\n";
    
    // 显示流式输出
    process.stdout.write(`\x1b[90m── Compaction summary ───────────────────────\x1b[0m\n`);
    for await (const event of stream) {
      if (event.type === "text_delta") {
        summaryText += event.delta ?? "";
        process.stdout.write(event.delta ?? "");
      }
      if (event.type === "error") {
        console.log(`\n\x1b[91mCompaction LLM error: ${event.error}\x1b[0m`);
        return;
      }
    }
    process.stdout.write(`\n`);

    const compacted = buildCompactedMessages(messages, cutPoint, summaryText);
    ctx.agent.setMessages(compacted);
    ctx.chat.updateMessages(compacted);

    // 持久化 CompactionEntry 到 session JSONL（参考 pi-mono 的 appendCompaction）
    const summaryOffset = summaryOffsetOf(messages);
    const firstKeptEntryId = ctx.sessionMgr.getEntryIdByMessageIndex(cutPoint.firstKeptIndex, summaryOffset);
    if (firstKeptEntryId) {
      const entry = createCompactionEntry(summaryText, cutPoint, firstKeptEntryId);
      await ctx.sessionMgr.appendCompaction(entry);
    }

    ctx.chat.setStatus("Ready", "idle");
    console.log(`\x1b[90mCompacted: ${messages.length} → ${compacted.length} messages with LLM summary\x1b[0m`);

  } catch (err) {
    ctx.chat.setStatus(`Compaction failed`, "error");
    console.log(`\x1b[91mCompaction error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    setTimeout(() => ctx.chat.setStatus("Ready", "idle"), 2000);
  }
}

async function handleSessionsCommand(ctx: CommandCtx): Promise<void> {
  const sessions = await ctx.sessionMgr.listSessions();
  if (sessions.length === 0) {
    console.log(`\x1b[90mNo sessions found.\x1b[0m`);
    return;
  }

  const lines = [
    `\x1b[90m── Sessions ────────────────────────────\x1b[0m`,
  ];

  for (const s of sessions) {
    const name = s.meta.name ?? s.meta.id.slice(0, 12);
    const date = new Date(s.meta.updatedAt).toLocaleString();
    const msgCount = s.meta.messageCount;
    const marker = s.isCurrent ? ` \x1b[33m◀ current\x1b[0m` : "";
    lines.push(
      `  \x1b[33m${s.meta.id.slice(0, 12)}\x1b[0m  \x1b[1m${name}\x1b[0m  \x1b[90m${date}\x1b[0m  ${msgCount} msgs${marker}`,
    );
  }

  lines.push(`\x1b[90m──────────────────────────────────────\x1b[0m`);
  lines.push(`\x1b[90mUse /session <id> to switch, /session new to create.\x1b[0m`);
  console.log(lines.join("\n"));
}

async function handleSessionCommand(args: string[], ctx: CommandCtx): Promise<void> {
  const sub = args[0];

  if (!sub) {
    console.log(`Current session: \x1b[33m${ctx.sessionMgr.sessionId.slice(0, 12)}\x1b[0m`);
    return;
  }

  if (sub === "new") {
    await ctx.sessionMgr.createNew();
    ctx.agent.setMessages([]);
    ctx.chat.setStatus("New session created", "idle");
    ctx.chat.updateMessages([]);
    console.log(`\x1b[90mSession context cleared.\x1b[0m`);
    return;
  }

  // 查找 session（支持部分匹配）
  const sessions = await ctx.sessionMgr.listSessions();
  const target = sessions.find((s) => s.meta.id.startsWith(sub));
  if (!target) {
    ctx.chat.setStatus(`Session not found: ${sub}`, "error");
    setTimeout(() => ctx.chat.setStatus("Ready", "idle"), 2000);
    return;
  }

  // 切换到目标 session
  const messages = await ctx.sessionMgr.switchTo(target.meta.id);
  ctx.agent.setMessages(messages);
  ctx.chat.updateMessages(messages);
  ctx.chat.setStatus(`Switched to session ${target.meta.id.slice(0, 12)} (${messages.length} msgs)`, "idle");
}

function handleTree(ctx: CommandCtx): void {
  const tree = ctx.sessionMgr.renderTree();
  if (!tree) {
    console.log(`\x1b[90mSession is empty.\x1b[0m`);
    return;
  }
  console.log(`\x1b[90m── Session tree ─────────────────────────\x1b[0m`);
  console.log(tree);
}

async function handleForkCommand(args: string[], ctx: CommandCtx): Promise<void> {
  if (!args[0]) {
    console.log(`\x1b[33mUsage: /fork <entry-id>\x1b[0m`);
    return;
  }

  const entryId = args[0];
  const entry = ctx.sessionMgr.getEntryById(entryId);
  if (!entry) {
    console.log(`\x1b[91mEntry not found: ${entryId}\x1b[0m`);
    return;
  }

  ctx.chat.setStatus(`Forking from ${entryId.slice(0, 8)}...`, "streaming");

  // fork 以一条新的 user 消息表示
  const branchNote = args.slice(1).join(" ") || "fork branch";
  const forkMsg: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: `[Fork: ${branchNote}] Continue from here` }],
    timestamp: Date.now(),
  };

  const newId = await ctx.sessionMgr.forkFrom(entryId, forkMsg);

  // 重建上下文：从 fork 点往后的消息
  const messages = ctx.sessionMgr.branchMessages;
  ctx.agent.setMessages(messages);
  ctx.chat.updateMessages(messages);
  ctx.chat.setStatus(`Forked from ${entryId.slice(0, 8)} (session: ${ctx.sessionMgr.sessionId.slice(0, 12)})`, "idle");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
