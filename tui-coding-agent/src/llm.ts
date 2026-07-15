/**
 * LLM Provider 抽象层
 *
 * 参考 openwiki 的 createModel 模式，支持 OpenAI 和 Anthropic。
 * 参考 pi-mono 的 streamSimple 接口设计。
 */

import type { ModelConfig, Message, AgentMessage } from "./types.js";

export interface StreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
}

export interface StreamEvent {
  type: "text_delta" | "reasoning_delta" | "text_end" | "tool_call" | "done" | "error";
  delta?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  error?: string;
  usage?: { input: number; output: number; totalTokens: number };
}

export interface StreamResult {
  content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: "stop" | "length" | "tool_use" | "error";
  errorMessage?: string;
  usage?: { input: number; output: number; totalTokens: number };
}

export type StreamFn = (
  model: ModelConfig,
  messages: Message[],
  systemPrompt: string,
  tools: Array<{ name: string; description: string; parameters: unknown }>,
  options?: StreamOptions,
) => AsyncIterable<StreamEvent>;

/**
 * 将 AgentMessage[] 转换为 LLM 可理解的 Message[]。
 * 过滤掉自定义消息类型，只保留 user/assistant/toolResult。
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}

/**
 * 构建 LLM 请求的工具描述。
 */
export function buildToolDescriptors(tools: Array<{ name: string; description: string; parameters: unknown }>) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
