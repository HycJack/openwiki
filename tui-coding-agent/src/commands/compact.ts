/**
 * /compact — 压缩上下文
 *
 * 使用 LLM 生成结构化摘要，压缩早期消息释放上下文空间。
 *
 * 用法：
 *   /compact                 — 自动压缩
 *   /compact <instructions>  — 带指令的压缩
 */

import type { CommandEntry } from "./registry.js";
import type { CommandCtx } from "./types.js";
import { streamOpenAI } from "../providers/openai.js";
import {
  findCutPoint,
  buildCompactedMessages,
  buildCompactionPrompt,
  createCompactionEntry,
  isCompactionSummary,
  summaryOffsetOf,
} from "../compaction.js";
import type { AgentMessage } from "../types.js";

export const compactCommand: CommandEntry = {
  name: "compact",
  description: "Compact conversation with LLM summary",
  handler: async (args, ctx) => {
    const instructions = args.join(" ") || "";
    await performCompact(ctx, instructions);
  },
};

/**
 * 执行压缩的核心逻辑（被 /compact 和 /ctx compact 共用）
 */
export async function performCompact(ctx: CommandCtx, instructions: string): Promise<void> {
  const messages = ctx.agent.state.messages;
  if (messages.length === 0) {
    console.log(`\x1b[90mNo messages to compact.\x1b[0m`);
    return;
  }

  const cutPoint = findCutPoint(messages, 4000);
  if (!cutPoint) {
    console.log(`\x1b[90mContext is small enough, no compaction needed.\x1b[0m`);
    return;
  }

  ctx.chat.setStatus(`Compacting ${cutPoint.truncatedCount} messages...`, "streaming");

  try {
    const messagesToSummarize = messages.slice(0, cutPoint.firstKeptIndex);
    const prompt = buildCompactionPrompt({
      messagesToSummarize,
      keptMessages: messages.slice(cutPoint.firstKeptIndex),
      instructions: instructions || undefined,
    });

    // 直接调用 streamOpenAI 做压缩摘要
    const response = streamOpenAI(
      ctx.model,
      [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      ctx.agent.state.systemPrompt,
      [], // 不需要工具
      { signal: new AbortController().signal },
    );

    let summary = "";
    const startTime = Date.now();
    for await (const chunk of response) {
      // 流式输出到终端，让用户看到压缩进度
      if (chunk.type === "text_delta" && chunk.delta) {
        summary += chunk.delta;
      }
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\x1b[90mCompaction completed in ${elapsed}s.\x1b[0m`);

    if (!summary) {
      console.log(`\x1b[91mCompaction failed: empty summary.\x1b[0m`);
      return;
    }

    // 找到 firstKeptEntryId
    const summaryOffset = summaryOffsetOf(ctx.agent.state.messages);
    const firstKeptEntryId = ctx.sessionMgr.getEntryIdByMessageIndex(cutPoint.firstKeptIndex, summaryOffset);
    if (!firstKeptEntryId) {
      throw new Error("Cannot find firstKeptEntryId for compaction");
    }

    const compacted = buildCompactedMessages(messages, cutPoint, summary);
    ctx.agent.setMessages(compacted);
    ctx.chat.updateMessages(compacted);

    // 持久化 CompactionEntry
    const entry = createCompactionEntry(summary, cutPoint, firstKeptEntryId);
    await ctx.sessionMgr.appendCompaction(entry);

    ctx.chat.setStatus(`Compacted ${cutPoint.truncatedCount} messages`, "idle");
  } catch (err) {
    ctx.chat.setStatus(`Compaction failed: ${err}`, "error");
    setTimeout(() => ctx.chat.setStatus("Ready", "idle"), 2000);
  }
}
