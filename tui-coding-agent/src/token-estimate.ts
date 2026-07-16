/**
 * Token 估算工具
 *
 * 参考 pi-mono 的估算算法：
 * - ASCII 字符：0.25 token/字符
 * - 中文字符（CJK）：1.5 token/字符
 * - 日文假名：0.6 token/字符
 * - 韩文（Hangul）：0.6 token/字符
 * - 其他：0.5 token/字符
 * - 每条消息 ~4 token 开销
 * - 工具调用参数额外估算
 */

import type { AgentMessage, ContentBlock, ToolCallContent } from "./types.js";

function charTokens(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code <= 127) return 0.25;
  if (code >= 0x4e00 && code <= 0x9fff) return 1.5;   // CJK Unified Ideographs
  if (code >= 0x3040 && code <= 0x30ff) return 0.6;    // Hiragana + Katakana
  if (code >= 0xac00 && code <= 0xd7af) return 0.6;    // Hangul Syllables
  return 0.5;
}

export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += charTokens(ch);
  }
  return Math.ceil(tokens);
}

/** 每条消息的固定 token 开销 */
const MESSAGE_OVERHEAD = 4;

export function estimateMessageTokens(msg: AgentMessage): number {
  let total = MESSAGE_OVERHEAD;

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        total += estimateTextTokens(block.text);
        break;
      case "image":
        // 图片粗略估算：约 1000 tokens
        total += 1000;
        break;
      case "toolCall":
        total += estimateTextTokens(block.name);
        total += estimateTextTokens(JSON.stringify(block.arguments));
        break;
      case "toolResult": {
        for (const sub of block.content) {
          if (sub.type === "text") total += estimateTextTokens(sub.text);
          if (sub.type === "image") total += 1000;
        }
        break;
      }
    }
  }

  return total;
}

export interface ContextUsage {
  /** 估算的总 tokens */
  tokens: number;
  /** 上下文窗口上限 */
  limit: number;
  /** 使用百分比 0-100 */
  percent: number;
}

/** 默认上下文窗口大小 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 默认预留 tokens（给 LLM 回复留空间） */
export const DEFAULT_RESERVE_TOKENS = 16_384;

export function estimateContextUsage(
  messages: AgentMessage[],
  systemPrompt: string,
  contextWindow?: number,
): ContextUsage {
  const limit = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const total = estimateTextTokens(systemPrompt) + messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  return {
    tokens: total,
    limit,
    percent: limit > 0 ? (total / limit) * 100 : 0,
  };
}

export function shouldCompact(
  usage: ContextUsage,
  reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): boolean {
  return usage.tokens > usage.limit - reserveTokens;
}
