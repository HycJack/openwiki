/**
 * 插件系统类型定义
 *
 * 参考 pi-mono 的 extensions/types.ts 设计：
 * - PluginAPI: 插件可用的注册和操作接口
 * - PluginContext: 事件处理时传入的上下文
 * - Plugin: 已加载的插件实例
 */

import type { AgentTool, ModelConfig } from "../types.js";

export type PluginEvent =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "before_agent_start"
  | "session_start"
  | "shutdown";

export interface PluginCommand {
  name: string;
  description?: string;
  handler: (ctx: PluginCommandContext, args: string) => Promise<void>;
}

export interface PluginContext {
  cwd: string;
  model: ModelConfig | undefined;
  isIdle(): boolean;
  abort(): void;
  getSystemPrompt(): string;
}

export interface PluginCommandContext extends PluginContext {
  waitForIdle(): Promise<void>;
  sendMessage(content: string): void;
}

export interface PluginUIContext {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface PluginAPI {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerTool(tool: AgentTool): void;
  registerCommand(name: string, handler: (ctx: PluginCommandContext, args: string) => Promise<void>): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  exec(
    command: string,
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

export interface Plugin {
  name: string;
  path: string;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  tools: Map<string, AgentTool>;
  commands: Map<string, PluginCommand>;
}

export interface LoadedPlugin {
  plugin: Plugin;
  error: string | null;
}

export interface PluginLoadResult {
  plugins: Plugin[];
  errors: Array<{ path: string; error: string }>;
}

export type PluginFactory = (api: PluginAPI) => void | Promise<void>;

export interface PluginRuntime {
  sendMessage: (content: string) => void;
  getActiveTools: () => string[];
  getAllTools: () => string[];
  setActiveTools: (toolNames: string[]) => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
}
