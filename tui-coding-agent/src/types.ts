/**
 * Core type definitions for plugin-based TUI agent
 *
 * 参考 pi-mono ExtensionSystem 设计：
 * - ExtensionAPI: 事件订阅/工具注册/命令注册/UI操作
 * - AgentSession: 会话生命周期管理
 * - EventBus: 跨组件通信
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { ContextUsage } from "./token-estimate.js";

// ============================================================================
// LLM Provider types
// ============================================================================

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  apiKey?: string;
  baseURL?: string;
  contextWindow?: number;
}

// ============================================================================
// Message types
// ============================================================================

export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  /** LLM 返回的 arguments，可能是 JSON 字符串或已解析对象 */
  arguments: string | Record<string, unknown>;
}
export interface ToolResultContent {
  type: "toolResult";
  toolCallId: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
}

export type ContentBlock = TextContent | ImageContent | ToolCallContent | ToolResultContent;

export interface UserMessage {
  role: "user";
  content: (TextContent | ImageContent)[];
  timestamp: number;
}
export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: "stop" | "length" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
  reasoning?: string;
  timestamp: number;
  usage?: TokenUsage;
}
export interface ToolResultMessage {
  role: "toolResult";
  content: ToolResultContent[];
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export type AgentMessage = Message;

export interface TokenUsage {
  input: number;
  output: number;
  totalTokens: number;
}

// ============================================================================
// Tool types
// ============================================================================

export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details?: T;
  terminate?: boolean;
}
export type ToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

export interface AgentTool<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdateCallback<TDetails> | undefined,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}

// ============================================================================
// Agent state
// ============================================================================

export interface AgentState {
  systemPrompt: string;
  model: ModelConfig;
  tools: AgentTool[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly errorMessage?: string;
  readonly messageCount: number;
}

export interface AgentConfig {
  systemPrompt?: string;
  model?: ModelConfig;
  tools?: AgentTool[];
  messages?: AgentMessage[];
  streamLLM?: import("./llm.js").StreamFn;
  /** Compaction 完成后的回调，用于持久化 CompactionEntry（由 cli.ts 注入 session-manager） */
  onCompaction?: (summary: string, cutPoint: import("./compaction.js").CutPoint, keptMessages: AgentMessage[]) => Promise<void>;
}

// ============================================================================
// Agent Context — 传递给 agent loop 的运行时上下文
// ============================================================================

export interface AgentContext {
  model: ModelConfig;
  systemPrompt: string;
  tools: AgentTool[];
  messages: AgentMessage[];
}

// ============================================================================
// Agent Loop types
// ============================================================================

export type StreamLLM = (
  model: ModelConfig,
  messages: Message[],
  systemPrompt: string,
  tools: Array<{ name: string; description: string; parameters: unknown }>,
  options?: { signal?: AbortSignal; apiKey?: string },
) => AsyncGenerator<any, void, undefined>;

export interface AgentLoopConfig {
  model: ModelConfig;
  streamLLM?: StreamLLM;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  toolExecution?: "sequential" | "parallel";
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  /** 预留 tokens（给 LLM 回复留空间），默认 16384 */
  reserveTokens?: number;
  /** 压缩时保留的最近 token 数量，默认 20000 */
  keepRecentTokens?: number;
}

export interface BeforeToolCallContext {
  toolCall: ToolCallContent;
  args: unknown;
  context: AgentContext;
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AfterToolCallContext {
  toolCall: ToolCallContent;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

// ============================================================================
// Agent events (pi-mono style event system)
// ============================================================================

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; delta: string }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "notification"; message: string; level: "info" | "warning" | "error" }
  | { type: "context"; usage: ContextUsage };

// ============================================================================
// Event Bus (pi-mono inspired cross-component communication)
// ============================================================================

export type EventBusHandler<T = unknown> = (event: T) => void | Promise<void>;

export interface EventBus {
  on<T>(event: string, handler: EventBusHandler<T>): () => void;
  off<T>(event: string, handler: EventBusHandler<T>): void;
  emit<T>(event: string, data: T): void;
  clear(): void;
}

// ============================================================================
// Plugin / Extension types (pi-mono inspired)
// ============================================================================

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface SlotEntry {
  key: string;
  content?: string[];
  component?: Component;
}

// ============================================================================
// Plugin UI context — base on pi-mono ExtensionUIContext
// ============================================================================

export interface PluginUIContext {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined, options?: { placement?: WidgetPlacement; component?: Component }): void;
  setHeader(content: string[] | undefined, component?: Component): void;
  setFooter(content: string[] | undefined, component?: Component): void;
  setTitle(title: string): void;
}

// ============================================================================
// Plugin context — passed to event handlers (pi-mono ExtensionContext)
// ============================================================================

export interface PluginContext {
  cwd: string;
  model: ModelConfig | undefined;
  isIdle(): boolean;
  abort(): void;
  getSystemPrompt(): string;
  /** 获取估算的上下文 token 用量 */
  getContextUsage(): ContextUsage | null;
  /** 触发上下文压缩 */
  compact(options?: { instructions?: string }): void;
  getMessageCount(): number;
  readonly ui: PluginUIContext;
}

export interface PluginCommandContext extends PluginContext {
  waitForIdle(): Promise<void>;
  sendMessage(content: string): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

// ============================================================================
// Extension API — the primary interface for plugins (pi-mono ExtensionAPI)
// ============================================================================

export interface ExtensionAPI {
  /** Subscribe to agent lifecycle events */
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  /** Register an LLM-callable tool */
  registerTool(tool: AgentTool): void;
  /** Register a slash command like /mycommand */
  registerCommand(name: string, handler: (ctx: PluginCommandContext, args: string) => Promise<void>): void;
  /** Show a notification */
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Execute a shell command */
  exec(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Get currently active tool names */
  getActiveTools(): string[];
  /** Set which tools are active */
  setActiveTools(toolNames: string[]): void;
  /** UI helpers */
  readonly ui: PluginUIContext;
}

// ============================================================================
// Plugin/Extension data structures
// ============================================================================

export interface PluginCommand {
  name: string;
  description?: string;
  handler: (ctx: PluginCommandContext, args: string) => Promise<void>;
}

export interface Plugin {
  name: string;
  path: string;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  tools: Map<string, AgentTool>;
  commands: Map<string, PluginCommand>;
}

export interface PluginLoadResult {
  plugins: Plugin[];
  errors: Array<{ path: string; error: string }>;
}

export type PluginFactory = (api: ExtensionAPI) => void | Promise<void>;

// ============================================================================
// Plugin Runtime — runtime wiring for plugin system
// ============================================================================

export interface PluginRuntime {
  sendMessage: (content: string) => void;
  getActiveTools: () => string[];
  getAllTools: () => string[];
  setActiveTools: (toolNames: string[]) => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus?: (key: string, text: string | undefined) => void;
  setWidget?: (key: string, content: string[] | undefined, options?: { placement?: WidgetPlacement; component?: Component }) => void;
  setHeader?: (content: string[] | undefined, component?: Component) => void;
  setFooter?: (content: string[] | undefined, component?: Component) => void;
  setTitle?: (title: string) => void;
}

// ============================================================================
// Agent Session — high-level session API (pi-mono AgentSession style)
// ============================================================================

export interface SessionOptions {
  cwd?: string;
  model?: ModelConfig;
  tools?: string[];
  systemPrompt?: string;
}

export interface AgentSession {
  prompt(text: string): Promise<void>;
  abort(): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  readonly agent: AgentLike;
  readonly isStreaming: boolean;
  readonly messages: AgentMessage[];
  bindPlugins(plugins: Plugin[]): void;
}

export interface AgentLike {
  state: AgentState;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
}
