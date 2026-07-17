/**
 * Compaction — 参考 pi-mono 的上下文压缩机制
 *
 * 设计原理：
 * 当上下文超过阈值时，将较早的 messages 压缩成 LLM 生成的结构化摘要，
 * 用一条 CompactionEntry 替换历史，保留最近的 N 条消息。
 *
 * 与 pi-mono 一致：
 * - 不在原地修改消息历史，而是追加一条 CompactionEntry
 * - findCutPoint: 从最新消息向后遍历，累积 token 直到 keepRecentTokens
 * - 压缩后 LLM 看到的是：system + summary + 保留的原始消息
 */

import type { AgentMessage, AssistantMessage, TextContent, ContentBlock, ToolCallContent, ToolResultContent } from "./types.js";
import { estimateMessageTokens, estimateTextTokens } from "./token-estimate.js";

// ============================================================================
// CompactionEntry — 存储在 JSONL 中的压缩记录
// ============================================================================

export interface CompactionEntry {
  type: "compaction";
  /** 保留的原始消息起始 entry id（即保留边界） */
  firstKeptEntryId: string;
  /** 压缩的结构化摘要 */
  summary: string;
  /** 被压缩的原始消息数量 */
  compressedCount: number;
  /** 压缩前用 token 数 */
  compressedTokens: number;
  /** 压缩时间戳 */
  timestamp: number;
  /** entry ID（存储用，由 appendCompactionEntry 分配） */
  id?: string;
  /** 父 entry ID（存储用，由 appendCompactionEntry 分配） */
  parentId?: string | null;
}

// ============================================================================
// 默认配置
// ============================================================================

export interface CompactionConfig {
  /** 保留最近多少 token 的原始消息（默认 20k） */
  keepRecentTokens: number;
  /** 压缩摘要的最大 token 数 */
  maxSummaryTokens: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  keepRecentTokens: 20_000,
  maxSummaryTokens: 2000,
};

// ============================================================================
// Cut Point 查找 — 参考 pi-mono 的 findCutPoint
// ============================================================================

export interface CutPoint {
  /** 第一个要保留的消息索引 */
  firstKeptIndex: number;
  /** 被截断消息的 token 数 */
  truncatedTokens: number;
  /** 被截断的消息数量 */
  truncatedCount: number;
}

/**
 * 从最新消息向后遍历，找到 cut point。
 * 保留最近的 keepRecentTokens token，
 * 更早的消息进入压缩候选区。
 */
export function findCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number = DEFAULT_COMPACTION_CONFIG.keepRecentTokens,
): CutPoint | null {
  if (messages.length <= 1) return null;

  let accumulated = 0;

  // 从后往前累加 token
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // 找到了 cut point
      const firstKeptIndex = i;
      const truncatedTokens = messages
        .slice(0, firstKeptIndex)
        .reduce((sum, m) => sum + estimateMessageTokens(m), 0);

      if (firstKeptIndex <= 1) return null; // 没有足够的消息可压缩

      return {
        firstKeptIndex,
        truncatedTokens,
        truncatedCount: firstKeptIndex,
      };
    }
  }

  // 所有消息加起来都不足 keepRecentTokens，不需要压缩
  return null;
}

// ============================================================================
// 压缩执行
// ============================================================================

export interface CompactionInput {
  /** 需要被压缩的消息（cut point 之前） */
  messagesToSummarize: AgentMessage[];
  /** 保留的消息（cut point 之后） */
  keptMessages: AgentMessage[];
  /** 可选的自定义压缩指令 */
  instructions?: string;
}

/**
 * 构建压缩用的 prompt，调用 LLM 生成摘要。
 * 返回 CompactionEntry 和新的消息列表。
 *
 * 该函数是同步的——它构建 prompt 供外部 LLM 调用，而不是直接调 LLM。
 */
export function buildCompactionPrompt(input: CompactionInput): string {
  const { messagesToSummarize, instructions } = input;

  const serialized = messagesToSummarize
    .map((msg, i) => {
      const role = msg.role;
      const content = msg.content as ContentBlock[];
      const textBlocks = content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const toolCalls = content
        .filter((c): c is ToolCallContent => c.type === "toolCall")
        .map((c) => `${c.name}(${JSON.stringify(c.arguments)})`)
        .join(", ");
      const toolResults = content
        .filter((c): c is ToolResultContent => c.type === "toolResult")
        .map((c) => {
          return c.content
            .filter((sub): sub is TextContent => sub.type === "text")
            .map((sub) => sub.text.slice(0, 500))
            .join("\n");
        })
        .filter(Boolean)
        .join("\n");

      const parts = [`[${role}]`];
      if (textBlocks) parts.push(textBlocks.slice(0, 2000));
      if (toolCalls) parts.push(`Tools: ${toolCalls}`);
      if (toolResults) parts.push(`Results: ${toolResults.slice(0, 2000)}`);

      return `--- Message ${i} ---\n${parts.join("\n")}`;
    })
    .join("\n\n");

  const totalTokens = messagesToSummarize.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  return [
    `You are summarizing a conversation to fit within a context window limit.`,
    `The following ${messagesToSummarize.length} messages (estimated ~${totalTokens} tokens) need to be compressed into a structured summary.`,
    ``,
    instructions ? `Additional instructions: ${instructions}\n` : "",
    `## Messages to summarize`,
    serialized,
    ``,
    `## Summary Format`,
    `Please summarize in the following structured format:`,
    ``,
    `### Goal`,
    `What was the overall goal of this part of the conversation?`,
    ``,
    `### Constraints`,
    `Any constraints or requirements discovered.`,
    ``,
    `### Accomplished`,
    `What was accomplished so far.`,
    ``,
    `### Relevant Files`,
    `Files that were read, created, or modified.`,
    ``,
    `### Key Findings`,
    `Important discoveries, bugs found, decisions made.`,
    ``,
    `### Next Steps`,
    `What remains to be done.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 从 LLM 压缩结果构建 CompactionEntry。
 * firstKeptEntryId 是保留的第一条 entry 的 ID（由调用方从 session entries 中查找）。
 */
export function createCompactionEntry(
  summary: string,
  cutPoint: CutPoint,
  firstKeptEntryId: string,
): CompactionEntry {
  return {
    type: "compaction",
    firstKeptEntryId,
    summary,
    compressedCount: cutPoint.truncatedCount,
    compressedTokens: cutPoint.truncatedTokens,
    timestamp: Date.now(),
  };
}

/**
 * 构建压缩后的消息列表供 LLM 使用。
 * 返回一个只读视图：[compaction summary] + keptMessages。
 * 不会修改原始 messages 数组。
 *
 * 注：systemPrompt 由 Agent 单独管理，不在此处注入。
 */
export function buildCompactedMessages(
  messages: AgentMessage[],
  cutPoint: CutPoint,
  summary: string,
): AgentMessage[] {
  const keptMessages = messages.slice(cutPoint.firstKeptIndex);
  const summaryMsg: AssistantMessage = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `[Context Compaction Summary]\n${summary}`,
      },
    ],
    timestamp: Date.now(),
  };

  return [summaryMsg, ...keptMessages];
}
