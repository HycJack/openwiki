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
  });

  // 创建插件 runner
  const pluginRunner = createPluginRunner(loadResult, pluginRuntime, {
    cwd,
    model,
    systemPrompt,
  });

  // 绑定核心操作到插件 runner
  pluginRunner.bindCore({
    isIdle: () => !agent.state.isStreaming,
    abort: () => agent.abort(),
    waitForIdle: () => agent.waitForIdle(),
    sendMessage: (content: string) => {
      agent.prompt(content).catch((err) => {
        console.error("Agent prompt error:", err);
      });
    },
    getActiveTools: () => allTools.map((t) => t.name),
    getAllTools: () => allTools.map((t) => t.name),
    setActiveTools: (toolNames: string[]) => {
      const filtered = allTools.filter((t) => toolNames.includes(t.name));
      agent.tools = filtered;
    },
    notify: (message: string, type?: "info" | "warning" | "error") => {
      const prefix = type === "error" ? "[ERROR]" : type === "warning" ? "[WARN]" : "[INFO]";
      console.log(`${prefix} ${message}`);
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
    await renderTUI(agent, pluginRunner, cwd, {
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
            // 重建 agent 使用新的 session 消息
            agent.reset();
            agent.loadMessages(msgs);
          }
        }
      },
      onRenameSession: async (name: string) => {
        if (sessionId) {
          await renameSessionFile(cwd, sessionId, name);
        }
      },
    });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
