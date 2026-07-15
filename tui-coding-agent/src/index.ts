/**
 * TUI Coding Agent - 主入口
 *
 * 导出所有公共 API。
 */

export { Agent, type AgentOptions } from "./agent.js";
export { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
export { convertToLlm, buildToolDescriptors, type StreamFn, type StreamOptions } from "./llm.js";
export { streamOpenAI } from "./providers/openai.js";
export { buildSystemPrompt, type SystemPromptOptions } from "./system-prompt.js";
export { createBuiltinTools, createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createLsTool } from "./tools/index.js";
export { PluginRunner, createPluginRunner, loadPlugins, discoverPlugins, getPluginDir, getGlobalPluginDir } from "./plugin/index.js";
export type { Plugin, PluginAPI, PluginCommand, PluginContext, PluginCommandContext, PluginRuntime, PluginFactory, PluginLoadResult } from "./plugin/types.js";
export type * from "./types.js";
