/**
 * session-store.ts 单元测试
 *
 * 覆盖：extractMessages, extractBranchEntries, buildTree, forkFromEntry
 * 
 * 注意：appendSessionEntry 等需要文件 I/O 的测试已排除。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractMessages,
  extractBranchEntries,
  buildTree,
  forkFromEntry,
  type SessionEntry,
} from "../src/session-store.js";
import type { AgentMessage } from "../src/types.js";
import type { CompactionEntry } from "../src/compaction.js";

/** 创建一条用户消息 entry */
function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    id,
    parentId,
  } as SessionEntry;
}

/** 创建一条 assistant 消息 entry */
function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    model: "test-model",
    id,
    parentId,
  } as SessionEntry;
}

/** 创建一条 toolResult 消息 entry */
function toolResultEntry(id: string, parentId: string | null, toolCallId: string, text: string): SessionEntry {
  return {
    role: "toolResult" as any,
    content: [{ type: "toolResult", toolCallId, content: [{ type: "text", text }] }],
    timestamp: Date.now(),
    id,
    parentId,
  } as SessionEntry;
}

/** 创建一个 compaction entry */
function compactionEntry(
  id: string,
  parentId: string | null,
  firstKeptEntryId: string,
): CompactionEntry {
  return {
    type: "compaction",
    firstKeptEntryId,
    summary: "Compacted summary",
    compressedCount: 3,
    compressedTokens: 5000,
    timestamp: Date.now(),
    id,
    parentId,
  };
}

describe("extractMessages", () => {
  it("returns messages without compaction entries, stripping id/parentId", () => {
    const entries: SessionEntry[] = [
      userEntry("id1", null, "hello"),
      assistantEntry("id2", "id1", "hi there"),
      toolResultEntry("id3", "id2", "tc1", "result ok"),
    ];

    const messages = extractMessages(entries);
    assert.equal(messages.length, 3);
    assert.equal(messages[0]!.role, "user");
    assert.equal((messages[0]!.content[0] as any).text, "hello");
    // 验证没有 id/parentId
    assert(!("id" in messages[0]!));
  });

  it("filters out compaction entries", () => {
    // compaction(firstKeptEntryId="id4") 表示 id4 及之后的消息保留，
    // id1/id2 被压缩为 summaryMsg
    const entries: SessionEntry[] = [
      userEntry("id1", null, "old"),
      assistantEntry("id2", "id1", "old reply"),
      compactionEntry("id3", "id2", "id4"),
      userEntry("id4", "id3", "new"),
      assistantEntry("id5", "id4", "new reply"),
    ];

    const messages = extractMessages(entries);
    // 结果：[summaryMsg, id4(user: "new"), id5(assistant: "new reply")] = 3
    assert.equal(messages.length, 3);
    assert.equal(messages[0]!.role, "assistant");
    assert((messages[0]!.content[0] as any).text.startsWith("[Context Compaction Summary]"));
    assert.equal((messages[1]!.content[0] as any).text, "new");
    assert.equal((messages[2]!.content[0] as any).text, "new reply");
  });

  it("handles empty entries", () => {
    assert.equal(extractMessages([]).length, 0);
  });

  it("handles entries with compaction as last item (firstKeptEntryId not found)", () => {
    const entries: SessionEntry[] = [
      userEntry("id1", null, "msg1"),
      compactionEntry("id2", "id1", "nonexistent"),
    ];

    const messages = extractMessages(entries);
    // firstKeptEntryId 未找到 → 只有 summaryMsg
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, "assistant");
    assert((messages[0]!.content[0] as any).text.startsWith("[Context Compaction Summary]"));
  });
});

describe("extractBranchEntries", () => {
  it("follows parentId chain from currentEntryId back to root", () => {
    // 树结构：id1 ← id2 ← id3 ← id4 (current)
    //     ├ id5 ← id6
    // 从 id4 出发应得到 id1,id2,id3,id4
    const entries: SessionEntry[] = [
      userEntry("id1", null, "root"),
      assistantEntry("id2", "id1", "reply"),
      userEntry("id3", "id2", "follow-up A"),
      userEntry("id5", "id2", "follow-up B"),
      userEntry("id4", "id3", "follow-up A2"),
    ];

    const branch = extractBranchEntries(entries, "id4");
    assert.equal(branch.length, 4);
    assert.equal((branch[0] as any).id, "id1");
    assert.equal((branch[1] as any).id, "id2");
    assert.equal((branch[2] as any).id, "id3");
    assert.equal((branch[3] as any).id, "id4");
  });

  it("returns empty array when currentEntryId not found", () => {
    const entries = [userEntry("id1", null, "hello")];
    const branch = extractBranchEntries(entries, "nonexistent");
    assert.equal(branch.length, 0);
  });

  it("handles single entry", () => {
    const entries = [userEntry("id1", null, "hello")];
    const branch = extractBranchEntries(entries, "id1");
    assert.equal(branch.length, 1);
  });
});

describe("buildTree", () => {
  it("builds a tree from flat entries", () => {
    const entries: SessionEntry[] = [
      userEntry("id1", null, "root"),
      assistantEntry("id2", "id1", "reply"),
      userEntry("id3", "id1", "another reply"),
      assistantEntry("id4", "id2", "deeper"),
    ];

    const tree = buildTree(entries);
    assert.equal(tree.length, 1, "should have 1 root");
    assert.equal(tree[0]!.children.length, 2, "root should have 2 children");

    // depth 属性
    assert.equal(tree[0]!.depth, 0);
    assert.equal(tree[0]!.children[0]!.depth, 1);
    assert.equal(tree[0]!.children[0]!.children[0]!.depth, 2);
  });

  it("creates multiple roots for orphan entries", () => {
    const entries: SessionEntry[] = [
      userEntry("id1", null, "root1"),
      userEntry("id2", null, "root2"),
    ];

    const tree = buildTree(entries);
    assert.equal(tree.length, 2);
  });

  it("handles empty entries", () => {
    assert.equal(buildTree([]).length, 0);
  });
});

describe("forkFromEntry", () => {
  it("creates a new entry with correct parentId", () => {
    const entries: SessionEntry[] = [
      userEntry("id1", null, "hello"),
      assistantEntry("id2", "id1", "reply"),
      userEntry("id3", "id1", "alternative"),
    ];

    const msg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "forked message" }],
      timestamp: Date.now(),
    };

    const { entry, id } = forkFromEntry(entries, "id1", msg);
    assert.equal((entry as any).parentId, "id1");
    assert((entry as any).content[0].text, "forked message");
    assert(id.length > 0);
  });

  it("throws when fork point not found", () => {
    assert.throws(() => {
      forkFromEntry([], "nonexistent", {
        role: "user",
        content: [{ type: "text", text: "x" }],
        timestamp: Date.now(),
      });
    }, /not found/);
  });
});
