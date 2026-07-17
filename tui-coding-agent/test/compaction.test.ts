/**
 * compaction.ts 单元测试
 *
 * 覆盖：findCutPoint, buildCompactionPrompt, createCompactionEntry,
 *       buildCompactedMessages, isCompactionSummary, summaryOffsetOf
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findCutPoint,
  buildCompactionPrompt,
  createCompactionEntry,
  buildCompactedMessages,
  isCompactionSummary,
  summaryOffsetOf,
} from "../src/compaction.js";
import type { AgentMessage } from "../src/types.js";

/** 创建一条用户消息，text 长度影响 token 估算 */
function userMsg(text: string, i = 0): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now() + i * 1000,
  };
}

/** 创建一条 AI 回复（无工具调用） */
function assistantMsg(text: string, i = 0): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now() + i * 1000 + 500,
  };
}

describe("findCutPoint", () => {
  it("returns null for empty or single message", () => {
    assert.equal(findCutPoint([]), null);
    assert.equal(findCutPoint([userMsg("hello")]), null);
  });

  it("returns null when total tokens < keepRecentTokens (2 messages)", () => {
    // 每条消息 token = 4(overhead) + text_tokens
    // small text = ~1 token => ~5 tokens per message, total ~10
    const messages = [userMsg("a"), assistantMsg("b")];
    // keepRecentTokens 默认 20000，远大于 10
    assert.equal(findCutPoint(messages), null);
  });

  it("returns cut point when messages exceed keepRecentTokens", () => {
    // 长文本消息：每条约 4 + ceil(8000 * 0.25) = 4 + 2000 = 2004 tokens
    const longText = "A".repeat(8000);
    const messages = [
      userMsg(longText, 0),
      assistantMsg(longText, 1),
      userMsg(longText, 2),
      assistantMsg(longText, 3),
      userMsg(longText, 4),   // index 4
      assistantMsg("b", 5),    // index 5 — 最后两条
    ];

    // keepRecentTokens = 5000
    const result = findCutPoint(messages, 5000);

    assert(result !== null, "should find a cut point");
    assert(result.firstKeptIndex > 0, "firstKeptIndex should be > 0");
    assert(result.truncatedCount > 0, "truncatedCount should be > 0");

    // 验证被截断的消息数 = firstKeptIndex
    assert.equal(result.truncatedCount, result.firstKeptIndex);
  });

  it("returns null when firstKeptIndex <= 1 (no enough messages to compress)", () => {
    // 2 条超长消息，total tokens 远超 keepRecentTokens
    const longText = "A".repeat(20000); // ~5000 tokens per msg + overhead
    const messages = [userMsg(longText, 0), assistantMsg(longText, 1)];

    // 总 tokens > 5000，但 firstKeptIndex 会 = 0 或 1
    // 函数内部要 firstKeptIndex > 1 才返回
    const result = findCutPoint(messages, 5000);
    assert(result === null, "should return null when only 2 long messages");
  });
});

describe("buildCompactionPrompt", () => {
  it("returns a string containing Goal/Constraints/Accomplished sections", () => {
    const messages = [
      userMsg("Fix the login button"),
      assistantMsg("I'll fix the CSS"),
    ];

    const prompt = buildCompactionPrompt({
      messagesToSummarize: messages,
      keptMessages: [],
    });

    assert(prompt.includes("### Goal"), "should have Goal section");
    assert(prompt.includes("### Constraints"), "should have Constraints section");
    assert(prompt.includes("### Accomplished"), "should have Accomplished section");
    assert(prompt.includes("### Relevant Files"), "should have Relevant Files section");
    assert(prompt.includes("### Key Findings"), "should have Key Findings section");
    assert(prompt.includes("### Next Steps"), "should have Next Steps section");
    assert(prompt.includes("[user]"), "should serialize user role");
    assert(prompt.includes("[assistant]"), "should serialize assistant role");
  });

  it("includes custom instructions when provided", () => {
    const prompt = buildCompactionPrompt({
      messagesToSummarize: [userMsg("hello")],
      keptMessages: [],
      instructions: "Focus on errors",
    });

    assert(prompt.includes("Focus on errors"), "should include custom instructions");
  });
});

describe("createCompactionEntry", () => {
  it("creates a valid CompactionEntry", () => {
    const cutPoint = { firstKeptIndex: 3, truncatedTokens: 5000, truncatedCount: 3 };
    const entry = createCompactionEntry("Summary text", cutPoint, "entry-abc");

    assert.equal(entry.type, "compaction");
    assert.equal(entry.firstKeptEntryId, "entry-abc");
    assert.equal(entry.summary, "Summary text");
    assert.equal(entry.compressedCount, 3);
    assert.equal(entry.compressedTokens, 5000);
    assert(typeof entry.timestamp === "number", "timestamp should be a number");
  });
});

describe("buildCompactedMessages", () => {
  it("prepends summary message to kept messages", () => {
    const messages = [
      userMsg("old stuff", 0),
      assistantMsg("old reply", 1),
      userMsg("keep this", 2),
      assistantMsg("keep reply", 3),
    ];

    const cutPoint = { firstKeptIndex: 2, truncatedTokens: 100, truncatedCount: 2 };
    const compacted = buildCompactedMessages(messages, cutPoint, "Compressed old part");

    assert.equal(compacted.length, 3); // summary + 2 kept
    assert.equal(compacted[0]!.role, "assistant");
    assert((compacted[0]!.content[0] as any).text.startsWith("[Context Compaction Summary]"));
    assert.equal(compacted[1]!.role, "user");
    assert.equal((compacted[1]!.content[0] as any).text, "keep this");
    assert.equal(compacted[2]!.role, "assistant");
    assert.equal((compacted[2]!.content[0] as any).text, "keep reply");
  });

  it("handles empty kept messages gracefully", () => {
    const messages: AgentMessage[] = [userMsg("only one")];
    const cutPoint = { firstKeptIndex: 1, truncatedTokens: 50, truncatedCount: 1 };
    const compacted = buildCompactedMessages(messages, cutPoint, "Summary");

    assert.equal(compacted.length, 1);
    assert(compacted[0]!.content[0]!.type === "text");
  });
});

describe("isCompactionSummary", () => {
  it("returns true for messages with summary prefix", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[Context Compaction Summary]\nCompressed!" }],
      timestamp: Date.now(),
    };
    assert(isCompactionSummary(msg));
  });

  it("returns false for normal messages", () => {
    assert(!isCompactionSummary(userMsg("hello")));
    assert(!isCompactionSummary(assistantMsg("hi")));
  });

  it("returns false for empty content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [],
      timestamp: Date.now(),
    };
    assert(!isCompactionSummary(msg));
  });
});

describe("summaryOffsetOf", () => {
  it("returns 1 when first message is summary", () => {
    const summary: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[Context Compaction Summary]\nxxx" }],
      timestamp: Date.now(),
    };
    assert.equal(summaryOffsetOf([summary, userMsg("hello")]), 1);
  });

  it("returns 0 when no summary", () => {
    assert.equal(summaryOffsetOf([userMsg("hello"), assistantMsg("hi")]), 0);
  });

  it("returns 0 for empty array", () => {
    assert.equal(summaryOffsetOf([]), 0);
  });
});
