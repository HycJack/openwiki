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
} from "./plugin/index.js";
import { streamOpenAI } from "./providers/openai.js";
import { createChatTUI } from "./tui/index.js";
import { SessionManager } from "./session-manager.js";
import { loadEnv } from "./env.js";
import { loadConfig } from "./config.js";
import {
  createCompactionEntry,
  summaryOffsetOf,
} from "./compaction.js";
import type { AgentTool, ModelConfig, TextContent } from "./types.js";
import { CommandRegistry, registerAllCommands, type CommandCtx, type CliArgs } from "./commands/index.js";
import { getSandbox } from "./sandbox/index.js";
import * as os from "node:os";

const IS_WIN = process.platform === "win32";

// ============================================================================
// 参数解析
// ============================================================================

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
// 注册内置命令
// ============================================================================

function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerAllCommands(registry);
  return registry;
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

  // 解析工作目录和沙箱配置
  const workspace = userConfig.workspace ?? os.homedir();
  const sandboxEnabled = userConfig.sandboxEnabled !== false; // 默认启用

  // 初始化沙箱
  const sandbox = getSandbox();
  if (sandboxEnabled && IS_WIN) {
    sandbox.init(workspace);
    if (sandbox.isActive) {
      console.log(`[sandbox] Windows sandbox enabled. Workspace: ${workspace}`);
    }
  } else if (!IS_WIN) {
    console.log(`[sandbox] Windows sandbox only available on Windows.`);
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

  // 构建工具（传入沙箱）
  const builtinTools = createBuiltinTools(sandbox.isActive ? sandbox : undefined);
  const pluginTools = loadResult.plugins.flatMap((p) => Array.from(p.tools.values()));
  const toolMap = new Map<string, AgentTool>();
  for (const tool of builtinTools) toolMap.set(tool.name, tool);
  for (const tool of pluginTools) { if (!toolMap.has(tool.name)) toolMap.set(tool.name, tool); }
  const allTools = Array.from(toolMap.values());

  const systemPrompt = buildSystemPrompt({
    cwd,
    tools: allTools,
    customInstructions: sandbox.isActive
      ? `\n## Sandbox restrictions\n- This environment is running inside a Windows sandbox.\n- Writable workspace: ${workspace}\n- Commands can only write to the workspace directory.`
      : undefined,
  });

  // 创建插件 runner
  const pluginRunner = createPluginRunner(loadResult, pluginRuntime, { cwd, model, systemPrompt });

  // 创建命令注册表
  const commandRegistry = createCommandRegistry();

  // 创建 Agent
  const agent = new Agent({
    systemPrompt,
    model,
    tools: allTools,
    streamLLM: streamOpenAI,
  });

  // 初始化 SessionManager
  const sessionMgr = new SessionManager({ cwd, modelId: model.id });
  const savedMessages = await sessionMgr.init();
  if (!sessionMgr.isNew && savedMessages.length > 0) {
    agent.setMessages(savedMessages);
  }

  // 注入 compaction 持久化回调
  agent.setCompactionCallback(async (summary, cutPoint, keptMessages) => {
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
    appendEntry: (type, data) => { sessionMgr.appendCustomEntry(type, data).catch(() => {}); },
    getCustomEntries: (type) => sessionMgr.getCustomEntries(type),
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
    });
    await agent.agentLoop(args.print);
    return;
  }

  // 交互模式 — TUI
  const chat = createChatTUI({
    modelLabel: model.id,
    commands: commandRegistry.buildCommandList(pluginRunner),
    onCtrlC() {
      if (agent.state.isStreaming) {
        agent.abort();
        chat.setStatus("Aborted", "idle");
        return true;
      }
      return false;
    },
  });

  // 构建 CommandCtx
  const commandCtx: CommandCtx = {
    agent,
    chat,
    config: userConfig,
    model,
    cwd,
    allTools,
    sessionMgr,
    pluginRunner,
  };

  // 绑定插件 TUI Slot API
  pluginRunner.bindSlotAPI({
    setHeader: (_content, _component) => chat.tui.requestRender(),
    setFooter: (_content, _component) => chat.tui.requestRender(),
    setWidget: (_key, _content, _options) => chat.tui.requestRender(),
    setStatus: (_key, text) => {
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

    if (cmd.startsWith("/")) {
      chat.inputBar.clear();
      await commandRegistry.handleCommand(cmd, commandCtx);
      return;
    }

    chat.inputBar.clear();
    chat.setStatus("Streaming...", "streaming");
    chat.updateMessages(agent.state.messages);

    agent.agentLoop(cmd)
      .then(() => {
        chat.setStatus("Ready", "idle");
        chat.updateMessages(agent.state.messages);
      })
      .catch((err: Error) => {
        chat.setStatus(`Error: ${err.message}`, "error");
      });
  };

  // 订阅 AI 流式输出
  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.message.role === "assistant" && event.delta) {
          chat.appendStreamingDelta(event.delta);
        }
        break;
      case "turn_end":
        chat.messageList.streamingMessage = null;
        chat.updateMessages(agent.state.messages);
        chat.tui.requestRender();
        break;
      case "agent_end":
        chat.updateMessages(agent.state.messages);
        chat.setStatus("Ready", "idle");
        chat.tui.requestRender();
        sessionMgr.scheduleFlush(agent.state.messages);
        break;
      case "notification":
        if (event.level === "error") {
          chat.setStatus(event.message, "error");
        } else {
          console.log(`\x1b[90m${event.message}\x1b[0m`);
        }
        break;
    }
  });

  chat.tui.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
