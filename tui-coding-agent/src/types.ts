/**
 * 核心类型定义
 *
 * 参考 pi-mono 的 agent types，设计 AgentMessage / AgentTool / AgentEvent 等核心抽象。
 * 参考 openwiki 的 connector types，设计插件化的 Tool 定义。
 */

import type { Static, TSchema } from "typebox";
import { StreamEvent } from "./llm.js";

// ============================================================================
// 消息类型
// ============================================================================

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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
  /** Thinking/reasoning 内容（deepseek-r1/o1 等模型） */
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

/**
 * 可扩展的消息类型，插件可通过 declaration merging 添加自定义消息类型。
 */
export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ============================================================================
// Token 使用统计
// ============================================================================

export interface TokenUsage {
  input: number;
  output: number;
  totalTokens: number;
}

// ============================================================================
// 工具类型
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
// Agent 状态和上下文
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface AgentState {
  systemPrompt: string;
  model: ModelConfig;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  apiKey?: string;
  baseURL?: string;
  contextWindow?: number;
}

// ============================================================================
// Agent 事件
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
  | { type: "notification"; message: string; level: "info" | "warning" | "error" };

// ============================================================================
// Agent Loop 配置
// ============================================================================

export type StreamLLM = (
  model: ModelConfig,
  messages: Message[],
  systemPrompt: string,
  tools: Array<{ name: string; description: string; parameters: unknown }>,
  options?: { signal?: AbortSignal; apiKey?: string },
) => AsyncGenerator<StreamEvent, void, undefined>;

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
}

export interface BeforeToolCallContext {
  toolCall: Extract<ContentBlock, { type: "toolCall" }>;
  args: unknown;
  context: AgentContext;
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AfterToolCallContext {
  toolCall: Extract<ContentBlock, { type: "toolCall" }>;
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
// 插件系统类型
// ============================================================================

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

export interface PluginDefinition {
  name: string;
  version?: string;
  setup?: (api: PluginAPI) => void | Promise<void>;
}

export interface PluginAPI {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerTool(tool: AgentTool): void;
  registerCommand(name: string, handler: (ctx: PluginCommandContext, args: string) => Promise<void>): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  exec(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

export interface Plugin {
  name: string;
  path: string;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  tools: Map<string, AgentTool>;
  commands: Map<string, { name: string; handler: (ctx: PluginCommandContext, args: string) => Promise<void> }>;
}

export interface LoadedPlugin {
  plugin: Plugin;
  error: string | null;
}

export interface PluginLoadResult {
  plugins: Plugin[];
  errors: Array<{ path: string; error: string }>;
}
