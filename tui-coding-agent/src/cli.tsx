#!/usr/bin/env node
/**
 * CLI 入口
 *
 * 参考 openwiki 的 cli.tsx 设计：
 * - 解析命令行参数
 * - 初始化 Agent、插件系统、TUI
 *
 * 参考 pi-mono 的 cli.ts 设计：
 * - 支持 --print 模式（非交互）
 * - 支持指定模型和 provider
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
  type PluginRunner,
} from "./plugin/index.js";
import { renderTUI } from "./tui/app.js";
import { loadEnv } from "./env.js";
import { loadConfig } from "./config.js";
import {
  getOrCreateLatestSession,
  listSessions,
  createSession,
  appendSessionMessage,
  renameSession as renameSessionFile,
  type SessionInfo,
} from "./session.js";
import type { AgentMessage, AgentTool, ModelConfig } from "./types.js";

// ============================================================================
// Token 估算工具函数（与 context-manager-plugin 算法一致）
// ============================================================================

function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code <= 127) tokens += 0.25;
    else if (code >= 0x4e00 && code <= 0x9fff) tokens += 1.5;
    else if (code >= 0x3040 && code <= 0x30ff) tokens += 0.6;
    else if (code >= 0xac00 && code <= 0xd7af) tokens += 0.6;
    else tokens += 0.5;
  }
  return Math.ceil(tokens);
}

interface CliArgs {
  model?: string;
  provider?: string;
  baseURL?: string;
  print?: string;
  plugins?: string[];
  cwd?: string;
  help?: boolean;
  noSession?: boolean;
  resume?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--provider":
      case "-p":
        args.provider = argv[++i];
        break;
      case "--base-url":
        args.baseURL = argv[++i];
        break;
      case "--print":
        args.print = argv[++i];
        break;
      case "--plugin":
        if (!args.plugins) args.plugins = [];
        args.plugins.push(argv[++i]);
        break;
      case "--cwd":
        args.cwd = argv[++i];
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--no-session":
        args.noSession = true;
        break;
      case "--resume":
      case "-r":
        args.resume = true;
        break;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
TUI Coding Agent - A plugin-based TUI coding agent

Usage: tca [options]

Options:
  -m, --model <id>       Model ID (default: gpt-4o, or OPENAI_MODEL/OPENWIKI_MODEL_ID)
  -p, --provider <name>  Provider name (default: openai, or OPENWIKI_PROVIDER)
      --base-url <url>   Custom API base URL (default: OPENAI_BASE_URL/OPENWIKI_BASE_URL)
      --print <prompt>   Run in non-interactive mode with a prompt
      --plugin <path>    Load a plugin from the given path
      --cwd <path>       Working directory (default: current directory)
      --no-session       Ephemeral mode; do not save session
  -r, --resume           Show session picker on startup
  -h, --help             Show this help

Environment Variables:
  OPENAI_API_KEY          API key for OpenAI (required)
  OPENAI_BASE_URL         Custom base URL for OpenAI-compatible APIs
  OPENAI_MODEL            Model ID (default: gpt-4o)

  Compatible (fallback) variables:
    OPENWIKI_MODEL_ID, OPENWIKI_PROVIDER, OPENWIKI_BASE_URL

  You can set these in a .env file in the working directory.
  See .env.example for a template.

Plugin Discovery:
  Plugins are auto-loaded from:
    1. .tca/plugins/ in the working directory
    2. ~/.tca/plugins/ (global)

Commands (in TUI):
  /clear    Clear conversation
  /exit     Exit the agent
  /<cmd>    Run a plugin-registered command
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const cwd = args.cwd ?? process.cwd();

  // 优先从 .env 文件加载环境变量（不覆盖已设置的 process.env）
  await loadEnv(cwd);

  // 从 ~/.tca/config.json 加载配置
  const config = await loadConfig();

  // 构建 model 配置
  // 优先级：cli 参数 > config.json > 环境变量 > 默认值
  const modelId =
    args.model ??
    config.defaultModel ??
    process.env.OPENAI_MODEL ??
    process.env.OPENWIKI_MODEL_ID ??
    "gpt-4o";
  const provider =
    args.provider ??
    config.defaultProvider ??
    process.env.OPENAI_PROVIDER ??
    process.env.OPENWIKI_PROVIDER ??
    "openai";
  const baseURL =
    args.baseURL ??
    config.baseURL ??
    process.env.OPENAI_BASE_URL ??
    process.env.OPENWIKI_BASE_URL;

  const model: ModelConfig = {
    id: modelId,
    name: modelId,
    provider,
    apiKey: process.env.OPENAI_API_KEY,
    baseURL,
  };

  if (!model.apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is required.");
    console.error("Set it in .env file or environment:");
    console.error("  .env:  OPENAI_API_KEY=your-key");
    console.error("  env:   $env:OPENAI_API_KEY=\"your-key\"");
    process.exit(1);
  }

  // 加载插件
  const pluginRuntime = createPluginRuntime();
  const pluginPaths: string[] = [];

  // 1. 命令行指定的插件
  if (args.plugins) {
    pluginPaths.push(...args.plugins);
  }

  // 2. 项目级插件目录
  const localPluginDir = getPluginDir(cwd);
  pluginPaths.push(...discoverPlugins(localPluginDir));

  // 3. 全局插件目录
  const globalPluginDir = getGlobalPluginDir();
  pluginPaths.push(...discoverPlugins(globalPluginDir));

  const loadResult = await loadPlugins(pluginPaths, cwd, pluginRuntime);

  // 报告加载错误
  for (const err of loadResult.errors) {
    console.error(`Plugin load error: ${err.path}: ${err.error}`);
  }

  // 收集所有工具（内置 + 插件注册的）
  const builtinTools = createBuiltinTools();
  const pluginTools = loadResult.plugins.flatMap(
    (p) => Array.from(p.tools.values()),
  );

  // 合并工具（内置优先，插件工具不能覆盖内置工具名）
  const toolMap = new Map<string, AgentTool>();
  for (const tool of builtinTools) {
    toolMap.set(tool.name, tool);
  }
  for (const tool of pluginTools) {
    if (!toolMap.has(tool.name)) {
      toolMap.set(tool.name, tool);
    }
  }
  const allTools = Array.from(toolMap.values());

  // 缓存插件路径供 reload 使用
  const cachedPluginPaths = pluginPaths.slice();

  // 构建系统提示词
  const systemPrompt = buildSystemPrompt({ cwd, tools: allTools });

  // Session 管理
  let sessionId: string | undefined;
  let sessionMessages: AgentMessage[] = [];
  let sessionInfos: SessionInfo[] = [];
  let useSession = !args.noSession;

  if (useSession) {
    sessionInfos = await listSessions(cwd);

    // --resume 或 TTY 交互模式 + 有 session 时，恢复最新 session
    if (args.resume && sessionInfos.length > 0) {
      // resume 模式：恢复最新 session，让用户通过 /sessions 命令选择
      const result = await getOrCreateLatestSession(cwd, model.id);
      sessionId = result.sessionId;
      sessionMessages = result.messages;
      useSession = true;
    } else {
      // 自动恢复最新 session
      const result = await getOrCreateLatestSession(cwd, model.id);
      sessionId = result.sessionId;
      sessionMessages = result.messages;
      useSession = true;
    }
  }

  // 创建插件 runner（必须在 Agent 之前，transformContext 闭包需要引用它）
  const pluginRunner = createPluginRunner(loadResult, pluginRuntime, {
    cwd,
    model,
    systemPrompt,
  });

  // 创建 Agent
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: allTools,
      messages: sessionMessages,
    },
    onMessageEnd: sessionId
      ? (message) => appendSessionMessage(cwd, sessionId!, message)
      : undefined,
    onSessionReset: sessionId
      ? async () => {
          if (sessionId) {
            const result = await createSession(cwd, model.id);
            sessionId = result.sessionId;
          }
        }
      : undefined,
    transformContext: async (messages) => {
      const result = await pluginRunner.emitContext(messages);
      return result as AgentMessage[];
    },
  });

  // 绑定核心操作到插件 runner（需要 Agent 创建后才能引用 agent）
  pluginRunner.bindCore({
    isIdle: () => !agent.state.isStreaming,
    abort: () => agent.abort(),
    waitForIdle: () => agent.waitForIdle(),
    sendMessage: (content: string) => {
      agent.prompt(content).catch((err) => {
        console.error("Agent prompt error:", err);
      });
    },
    getActiveTools: () => agent.tools.map((t) => t.name),
    getAllTools: () => allTools.map((t) => t.name),
    setActiveTools: (toolNames: string[]) => {
      const filtered = allTools.filter((t) => toolNames.includes(t.name));
      agent.tools = filtered;
    },
    notify: (message: string, type?: "info" | "warning" | "error") => {
      const prefix = type === "error" ? "[ERROR]" : type === "warning" ? "[WARN]" : "[INFO]";
      console.log(`${prefix} ${message}`);
      // 同时通过 agent 的事件系统通知 TUI（如果正在输出到 TUI）
      agent.notifyUI(message, type);
    },
    compact: (options) => {
      // 暂无内置压缩实现，但插件可以自行通过 API 实现
      console.log("[INFO] Compaction not yet implemented. Use /new or /clear to reset context.");
    },
    getMessageCount: () => agent.state.messages.length,
    getContextUsage: () => {
      const msgs = agent.state.messages;
      if (msgs.length === 0) return null;
      // 每条消息 ~4 token 开销
      let tokens = msgs.length * 4;
      for (const msg of msgs) {
        if (msg.role === "user" || msg.role === "toolResult") {
          // UserMessage: content = (TextContent | ImageContent)[]
          // ToolResultMessage: content = ToolResultContent[], 每个有嵌套 content
          for (const block of msg.content) {
            if ("content" in block && Array.isArray(block.content)) {
              // ToolResultContent: 嵌套的 text 内容
              for (const inner of block.content) {
                if (inner.type === "text") tokens += estimateTextTokens(inner.text);
              }
            } else if (block.type === "text") {
              tokens += estimateTextTokens(block.text);
            }
          }
        } else if (msg.role === "assistant") {
          // AssistantMessage: content = ContentBlock[] (TextContent | ToolCallContent)
          for (const block of msg.content) {
            if (block.type === "text") {
              tokens += estimateTextTokens(block.text);
            } else if (block.type === "toolCall") {
              tokens += estimateTextTokens(JSON.stringify(block.arguments));
            }
          }
          // 统计 reasoning
          if (msg.reasoning) {
            tokens += estimateTextTokens(msg.reasoning);
          }
        }
      }
      // 加系统提示词
      tokens += estimateTextTokens(systemPrompt);
      const limit = model.contextWindow || 128_000;
      const percent = Math.min((tokens / limit) * 100, 100);
      return { tokens: Math.ceil(tokens), limit, percent: Math.round(percent * 10) / 10 };
    },
  });

  // 触发 session_start 事件
  await pluginRunner.emitCustom("session_start");

  // 运行模式
  if (args.print) {
    // 非交互模式：发送 prompt，打印结果
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const text = event.message.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
        process.stdout.write(text);
      }
      if (event.type === "tool_execution_start") {
        console.log(`\n[Tool: ${event.toolName}]`);
      }
      if (event.type === "tool_execution_end") {
        const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
        const text = result?.content
          ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
        if (text) console.log(text.slice(0, 500));
      }
    });

    await agent.prompt(args.print);
  } else {
    // 交互模式：启动 TUI
    const tuiSetMessagesRef: { current?: (messages: AgentMessage[]) => void } = {};
    await renderTUI(agent, pluginRunner, cwd, {
      onSetInitialMessages: (setter) => { tuiSetMessagesRef.current = setter; },
      sessionId,
      sessions: sessionInfos.map((s) => ({
        id: s.meta.id,
        name: s.meta.name,
        messageCount: s.meta.messageCount,
        updatedAt: s.meta.updatedAt,
      })),
      onNewSession: async () => {
        if (sessionId) {
          const result = await createSession(cwd, model.id);
          sessionId = result.sessionId;
          agent.reset();
        }
      },
      onResumeSession: async (resumeId: string) => {
        if (useSession) {
          const { loadSessionMessages } = await import("./session.js");
          const allSessions = await listSessions(cwd);
          const target = allSessions.find((s) => s.meta.id === resumeId);
          if (target) {
            const msgs = await loadSessionMessages(target.filePath);
            sessionId = resumeId;
            agent.reset();
            agent.loadMessages(msgs);
            // 通知 TUI 显示这些消息
            tuiSetMessagesRef.current?.(msgs);
          }
        }
      },
      onRenameSession: async (name: string) => {
        if (sessionId) {
          await renameSessionFile(cwd, sessionId, name);
        }
      },
      onReloadPlugins: async () => {
        if (!agent.state.isStreaming) {
          const { loadPlugins } = await import("./plugin/loader.js");
          const newRuntime = { ...pluginRuntime };
          const newLoadResult = await loadPlugins(cachedPluginPaths, cwd, newRuntime);
          for (const err of newLoadResult.errors) {
            console.error(`Plugin load error: ${err.path}: ${err.error}`);
          }
          pluginRunner.reloadPlugins(newLoadResult.plugins);
          // 更新 agent 的工具列表（内置工具 + 新插件工具）
          const newPluginTools = newLoadResult.plugins.flatMap((p) => Array.from(p.tools.values()));
          const newToolMap = new Map<string, AgentTool>();
          for (const tool of allTools) {
            newToolMap.set(tool.name, tool);
          }
          for (const tool of newPluginTools) {
            if (!newToolMap.has(tool.name)) {
              newToolMap.set(tool.name, tool);
            }
          }
          agent.tools = Array.from(newToolMap.values());
          agent.notifyUI(`Reloaded ${newLoadResult.plugins.length} plugins.`, "info");
        } else {
          agent.notifyUI("Cannot reload plugins while agent is streaming. Wait for the current turn to finish.", "warning");
        }
      },
    });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
