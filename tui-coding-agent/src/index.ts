/**
 * TUI Agent Refactor — plugin-based TUI coding agent
 *
 * 参考 pi-mono 架构和 openwiki/tui-coding-agent 设计。
 */

// Core
export { Agent } from "./agent.js";
export { AgentSession, createAgentSession } from "./session.js";
export { createEventBus } from "./event-bus.js";
export { buildSystemPrompt } from "./system-prompt.js";
export { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
export { convertToLlm, buildToolDescriptors } from "./llm.js";

// Plugin system
export {
  loadPlugin,
  loadPlugins,
  discoverPlugins,
  createPluginRuntime,
  getPluginDir,
  getGlobalPluginDir,
  PluginRunner,
  createPluginRunner,
} from "./plugin/index.js";

// Tools
export {
  createBuiltinTools,
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createLsTool,
} from "./tools/index.js";

// Providers
export { streamOpenAI } from "./providers/openai.js";

// Environment & Config
export { loadEnv, parseEnv } from "./env.js";
export { loadConfig, saveConfig, updateConfig } from "./config.js";
export type { TCAConfig } from "./config.js";

// Token estimation
export {
  estimateTextTokens,
  estimateMessageTokens,
  estimateContextUsage,
  shouldCompact,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_RESERVE_TOKENS,
} from "./token-estimate.js";
export type { ContextUsage } from "./token-estimate.js";

// Compaction
export {
  findCutPoint,
  buildCompactedMessages,
  buildCompactionPrompt,
  createCompactionEntry,
} from "./compaction.js";
export type { CompactionEntry, CompactionConfig, CutPoint } from "./compaction.js";

// Session persistence (tree-based)
export {
  listSessions,
  getOrCreateLatestSession,
  createSession,
  loadSessionEntries,
  extractMessages,
  extractBranchEntries,
  appendSessionEntry,
  appendCompactionEntry,
  buildTree,
  renderTreeAsText,
  forkFromEntry,
  cloneSession,
  loadSessionMeta,
  updateSessionMeta,
  renameSession,
  deleteSession,
} from "./session-store.js";
export type {
  SessionMeta,
  SessionInfo,
  SessionEntry,
  SessionEntryMeta,
  TreeNode,
} from "./session-store.js";

// TUI components
export { createChatTUI, MessageList, TitleBar, Footer, InputBar } from "./tui/index.js";
export type { ChatTUI, StatusType } from "./tui/index.js";

// Types
export type * from "./types.js";
