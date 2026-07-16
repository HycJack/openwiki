/**
 * Session Store — 树状会话持久化存储（参考 pi-mono 的 branchable session 设计）
 *
 * 核心设计：
 * - 每条消息有 id / parentId，形成树状结构
 * - 存储在 JSONL 文件中，按工作目录组织
 * - 支持分支（/fork）、克隆（/clone）、树状查看（/tree）
 * - 支持 CompactionEntry 和 BranchSummaryEntry
 *
 * 存储路径：~/.tca/sessions/
 * 文件名：<cwd-hash>/<session-id>.jsonl
 */

import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "./types.js";
import type { CompactionEntry } from "./compaction.js";

// ============================================================================
// Entry 类型 — 每条 JSONL 记录可以是消息或元数据 entry
// ============================================================================

export interface SessionEntryMeta {
  /** 消息/entry 的唯一 ID */
  id: string;
  /** 父消息的 ID（形成树） */
  parentId: string | null;
}

export type SessionEntry = (AgentMessage & SessionEntryMeta) | CompactionEntry;

// ============================================================================
// Session meta
// ============================================================================

export interface SessionMeta {
  id: string;
  cwd: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  entryCount: number;
  name?: string;
  /** 当前分支的最后一个 entry id */
  currentEntryId?: string;
}

export interface SessionInfo {
  meta: SessionMeta;
  filePath: string;
}

// ============================================================================
// 树操作结果
// ============================================================================

export interface TreeNode {
  entry: SessionEntry;
  children: TreeNode[];
  depth: number;
}

// ============================================================================
// Paths
// ============================================================================

function getSessionsDir(): string {
  return path.join(os.homedir(), ".tca", "sessions");
}

function cwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function sessionDir(cwd: string): string {
  return path.join(getSessionsDir(), cwdHash(cwd));
}

function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd), `${sessionId}.jsonl`);
}

function metaFilePath(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd), `${sessionId}.meta.json`);
}

// ============================================================================
// ID generation
// ============================================================================

function generateId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

// ============================================================================
// Core API
// ============================================================================

/**
 * 列出工作目录下的所有 session。
 */
export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  const dir = sessionDir(cwd);
  try {
    const files = await readdir(dir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    const sessions: SessionInfo[] = [];

    for (const metaFile of metaFiles) {
      const sessionId = metaFile.replace(".meta.json", "");
      try {
        const content = await readFile(path.join(dir, metaFile), "utf8");
        const meta: SessionMeta = JSON.parse(content);
        sessions.push({ meta, filePath: sessionFilePath(cwd, sessionId) });
      } catch {
        // skip corrupted
      }
    }

    sessions.sort((a, b) => new Date(b.meta.updatedAt).getTime() - new Date(a.meta.updatedAt).getTime());
    return sessions;
  } catch {
    return [];
  }
}

/**
 * 获取或创建最新 session。
 */
export async function getOrCreateLatestSession(
  cwd: string,
  modelId: string,
): Promise<{ sessionId: string; entries: SessionEntry[]; isNew: boolean }> {
  const sessions = await listSessions(cwd);
  if (sessions.length > 0) {
    const latest = sessions[0]!;
    try {
      const entries = await loadSessionEntries(latest.filePath);
      return { sessionId: latest.meta.id, entries, isNew: false };
    } catch {
      // fall through to create
    }
  }
  return createSession(cwd, modelId);
}

/**
 * 创建新 session。
 */
export async function createSession(
  cwd: string,
  modelId: string,
): Promise<{ sessionId: string; entries: SessionEntry[]; isNew: boolean }> {
  const sessionId = generateId();
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id: sessionId,
    cwd,
    modelId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    entryCount: 0,
  };

  const dir = sessionDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(metaFilePath(cwd, sessionId), JSON.stringify(meta, null, 2), "utf8");
  await writeFile(sessionFilePath(cwd, sessionId), "", "utf8");

  return { sessionId, entries: [], isNew: true };
}

/**
 * 从 JSONL 文件加载所有 entry。
 */
export async function loadSessionEntries(filePath: string): Promise<SessionEntry[]> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: SessionEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        continue;
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 从 entries 中提取纯消息（compaction 感知）。
 *
 * 参考 pi-mono 的 buildContextEntries：
 * - 如果 entries 中有 CompactionEntry，找到最后一个，
 *   返回 [compactionSummaryMsg, ...firstKeptEntryId 之后的 messages]
 * - 旧消息（被压缩的）被跳过
 * - 如果没有 CompactionEntry，返回所有消息
 */
export function extractMessages(entries: SessionEntry[]): AgentMessage[] {
  // 找最后一个 CompactionEntry
  let lastCompaction: CompactionEntry | null = null;
  let lastCompactionIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if ((entries[i] as CompactionEntry).type === "compaction") {
      lastCompaction = entries[i] as CompactionEntry;
      lastCompactionIdx = i;
      break;
    }
  }

  if (!lastCompaction) {
    // 没有 compaction，返回所有消息（过滤 compaction entry，剥离 id/parentId）
    return entries
      .filter((e): e is AgentMessage & SessionEntryMeta =>
        (e as CompactionEntry).type !== "compaction",
      )
      .map(({ id: _id, parentId: _parentId, ...msg }) => msg as AgentMessage);
  }

  // 有 compaction：返回 [summaryMsg, ...firstKeptEntryId 之后的 messages]
  const summaryMsg: AgentMessage = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `[Context Compaction Summary]\n${lastCompaction.summary}` }],
    timestamp: lastCompaction.timestamp,
  };

  // 找到 firstKeptEntryId 对应的 entry index
  const firstKeptIdx = entries.findIndex(
    (e) => "id" in (e as SessionEntry) && (e as SessionEntry & SessionEntryMeta).id === lastCompaction!.firstKeptEntryId,
  );

  const keptEntries: AgentMessage[] = [];
  if (firstKeptIdx >= 0) {
    // 从 firstKeptIdx 到 lastCompactionIdx 之间的消息（不含 compaction entry）
    for (let i = firstKeptIdx; i < lastCompactionIdx; i++) {
      const e = entries[i];
      if ((e as CompactionEntry).type === "compaction") continue;
      const { id: _id, parentId: _parentId, ...msg } = e as AgentMessage & SessionEntryMeta;
      keptEntries.push(msg as AgentMessage);
    }
  }
  // compaction 之后的 entries
  for (let i = lastCompactionIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if ((e as CompactionEntry).type === "compaction") continue;
    const { id: _id, parentId: _parentId, ...msg } = e as AgentMessage & SessionEntryMeta;
    keptEntries.push(msg as AgentMessage);
  }

  return [summaryMsg, ...keptEntries];
}

/**
 * 从 entries 中提取指定分支的消息链。
 * 从 currentEntryId 沿 parentId 追溯到根，返回线性消息。
 */
export function extractBranchEntries(entries: SessionEntry[], currentEntryId: string): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) {
    const entryWithMeta = e as SessionEntry;
    if ("id" in entryWithMeta && entryWithMeta.id) {
      byId.set(entryWithMeta.id, e);
    }
  }

  const result: SessionEntry[] = [];
  let current: SessionEntry | undefined = byId.get(currentEntryId);

  while (current) {
    result.unshift(current);
    const entryWithMeta = current as SessionEntry;
    const parentId = "parentId" in entryWithMeta ? entryWithMeta.parentId : null;
    current = parentId ? byId.get(parentId) : undefined;
  }

  return result;
}

/**
 * 追加一条 entry 到 session。
 * 自动分配 id 和 parentId。
 */
export async function appendSessionEntry(
  cwd: string,
  sessionId: string,
  entry: Omit<AgentMessage, "id" | "parentId">,
  parentId: string | null,
): Promise<string> {
  const id = generateId();
  const fullEntry: SessionEntry = { ...entry, id, parentId } as SessionEntry & SessionEntryMeta;

  const dir = sessionDir(cwd);
  await mkdir(dir, { recursive: true });
  await appendFile(sessionFilePath(cwd, sessionId), JSON.stringify(fullEntry) + "\n", "utf8");

  try {
    const metaPath = metaFilePath(cwd, sessionId);
    const content = await readFile(metaPath, "utf8");
    const meta: SessionMeta = JSON.parse(content);
    meta.messageCount += 1;
    meta.entryCount += 1;
    meta.updatedAt = new Date().toISOString();
    meta.currentEntryId = id;
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // ignore meta errors
  }

  return id;
}

/**
 * 追加 CompactionEntry 到 session。
 */
export async function appendCompactionEntry(
  cwd: string,
  sessionId: string,
  entry: CompactionEntry,
  parentId: string | null,
): Promise<string> {
  const id = generateId();
  const fullEntry = { ...entry, id, parentId };

  const dir = sessionDir(cwd);
  await mkdir(dir, { recursive: true });
  await appendFile(sessionFilePath(cwd, sessionId), JSON.stringify(fullEntry) + "\n", "utf8");

  try {
    const metaPath = metaFilePath(cwd, sessionId);
    const content = await readFile(metaPath, "utf8");
    const meta: SessionMeta = JSON.parse(content);
    meta.entryCount += 1;
    meta.updatedAt = new Date().toISOString();
    meta.currentEntryId = id;
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // ignore
  }

  return id;
}

/**
 * 从 entries 构建树结构（用于 /tree 展示）。
 */
export function buildTree(entries: SessionEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byId = new Map<string, TreeNode>();
  const childMap = new Map<string | null, SessionEntry[]>();

  for (const entry of entries) {
    const entryWithMeta = entry as SessionEntry;
    if (!("id" in entryWithMeta) || !entryWithMeta.id) continue;
    const parentId = entryWithMeta.parentId ?? null;
    if (!childMap.has(parentId)) childMap.set(parentId, []);
    childMap.get(parentId)!.push(entry);
  }

  function buildSubTree(entry: SessionEntry, depth: number): TreeNode {
    const entryWithMeta = entry as SessionEntry;
    const id = "id" in entryWithMeta ? entryWithMeta.id : null;
    const node: TreeNode = { entry, children: [], depth };
    if (id && byId.has(id)) {
      // already built
    }
    const children = childMap.get(id ?? null) ?? [];
    for (const child of children) {
      node.children.push(buildSubTree(child, depth + 1));
    }
    return node;
  }

  const rootsEntries = childMap.get(null) ?? [];
  for (const entry of rootsEntries) {
    roots.push(buildSubTree(entry, 0));
  }

  return roots;
}

/**
 * 渲染树为文本（用于 /tree 命令）。
 */
export function renderTreeAsText(
  nodes: TreeNode[],
  currentEntryId?: string,
): string {
  const lines: string[] = [];
  let entryIndex = 0;

  function walk(nodes: TreeNode[], prefix: string): void {
    for (let i = 0; i < nodes.length; i++) {
      const isLast = i === nodes.length - 1;
      const node = nodes[i];
      const entryWithMeta = node.entry as SessionEntry;
      const isCurrent = "id" in entryWithMeta && entryWithMeta.id === currentEntryId;
      const role = (node.entry as { role?: string }).role ?? "compaction";
      const prefix2 = prefix + (isLast ? "└── " : "├── ");
      const marker = isCurrent ? " ◀" : "";

      let label = role;
      if (role === "compaction") {
        label = "📦 compaction";
      }
      lines.push(`${prefix2}${label}${marker}`);

      walk(node.children, prefix + (isLast ? "    " : "│   "));
    }
  }

  walk(nodes, "");
  return lines.join("\n");
}

/**
 * 在指定 entry 后 fork 出新分支（追加新消息）。
 * 自动设置新消息的 parentId 为 currentEntryId。
 */
export function forkFromEntry(
  entries: SessionEntry[],
  currentEntryId: string,
  message: Omit<AgentMessage, "id" | "parentId">,
): { entry: SessionEntry; id: string } {
  const id = generateId();
  const entry: SessionEntry = { ...message, id, parentId: currentEntryId } as SessionEntry & SessionEntryMeta;
  return { entry, id };
}

/**
 * 克隆整个 session 到新 session（复制所有 entry）。
 */
export async function cloneSession(
  cwd: string,
  sourceSessionId: string,
  newModelId: string,
): Promise<{ sessionId: string; meta: SessionMeta }> {
  const sourcePath = sessionFilePath(cwd, sourceSessionId);
  const entries = await loadSessionEntries(sourcePath);
  const { sessionId } = await createSession(cwd, newModelId);

  // 重写所有 entry 的 id/parentId
  const idMap = new Map<string, string>();
  for (const entry of entries) {
    const entryWithMeta = entry as SessionEntry;
    if (!("id" in entryWithMeta) || !entryWithMeta.id) continue;
    const newId = generateId();
    idMap.set(entryWithMeta.id, newId);
  }

  const newPath = sessionFilePath(cwd, sessionId);
  for (const entry of entries) {
    const entryWithMeta = entry as SessionEntry;
    if (!("id" in entryWithMeta) || !entryWithMeta.id) {
      await appendFile(newPath, JSON.stringify(entry) + "\n", "utf8");
      continue;
    }
    const newId = idMap.get(entryWithMeta.id)!;
    const newParentId = entryWithMeta.parentId ? (idMap.get(entryWithMeta.parentId) ?? null) : null;
    const newEntry = { ...entry, id: newId, parentId: newParentId };
    await appendFile(newPath, JSON.stringify(newEntry) + "\n", "utf8");
  }

  const meta = await loadSessionMeta(cwd, sessionId);
  return { sessionId, meta: meta! };
}

/**
 * 加载 session meta。
 */
export async function loadSessionMeta(cwd: string, sessionId: string): Promise<SessionMeta | null> {
  try {
    const content = await readFile(metaFilePath(cwd, sessionId), "utf8");
    return JSON.parse(content) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * 更新 session meta。
 */
export async function updateSessionMeta(
  cwd: string,
  sessionId: string,
  updates: Partial<SessionMeta>,
): Promise<void> {
  const meta = await loadSessionMeta(cwd, sessionId);
  if (!meta) return;
  Object.assign(meta, updates, { updatedAt: new Date().toISOString() });
  await writeFile(metaFilePath(cwd, sessionId), JSON.stringify(meta, null, 2), "utf8");
}

/**
 * 重命名 session。
 */
export async function renameSession(cwd: string, sessionId: string, name: string): Promise<void> {
  await updateSessionMeta(cwd, sessionId, { name });
}

/**
 * 删除 session。
 */
export async function deleteSession(cwd: string, sessionId: string): Promise<void> {
  const dir = sessionDir(cwd);
  try {
    await unlink(path.join(dir, `${sessionId}.jsonl`));
    await unlink(path.join(dir, `${sessionId}.meta.json`));
  } catch {
    // ignore
  }
}
