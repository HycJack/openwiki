/**
 * Session 管理 - 消息持久化存储
 *
 * 参考 pi-mono 的 session 设计：
 * - 消息以 JSONL 格式存储
 * - 按工作目录组织
 * - 支持多会话列表、恢复、新建
 *
 * 存储路径：~/.tca/sessions/
 * 文件名：<cwd-hash>/<session-id>.jsonl
 */

import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "./types.js";

// ============================================================================
// 类型
// ============================================================================

export interface SessionMeta {
  id: string;
  cwd: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  name?: string;
}

export interface SessionInfo {
  meta: SessionMeta;
  filePath: string;
}

// ============================================================================
// 路径
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
// 生成 session ID
// ============================================================================

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const uid = randomUUID().slice(0, 8);
  return `s-${ts}-${uid}`;
}

// ============================================================================
// 核心 API
// ============================================================================

/**
 * 列出指定工作目录下的所有 session，按更新时间降序排列。
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
        sessions.push({
          meta,
          filePath: sessionFilePath(cwd, sessionId),
        });
      } catch {
        // skip corrupted meta files
      }
    }

    sessions.sort((a, b) => new Date(b.meta.updatedAt).getTime() - new Date(a.meta.updatedAt).getTime());
    return sessions;
  } catch {
    return [];
  }
}

/**
 * 获取最新的 session，如果没有则创建新 session。
 */
export async function getOrCreateLatestSession(
  cwd: string,
  modelId: string,
): Promise<{ sessionId: string; messages: AgentMessage[]; isNew: boolean }> {
  const sessions = await listSessions(cwd);

  if (sessions.length > 0) {
    const latest = sessions[0]!;
    try {
      const messages = await loadSessionMessages(latest.filePath);
      return { sessionId: latest.meta.id, messages, isNew: false };
    } catch {
      // 加载失败，创建新 session
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
): Promise<{ sessionId: string; messages: AgentMessage[]; isNew: boolean }> {
  const sessionId = generateSessionId();
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id: sessionId,
    cwd,
    modelId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };

  const dir = sessionDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(metaFilePath(cwd, sessionId), JSON.stringify(meta, null, 2), "utf8");
  // 创建空的 JSONL
  await writeFile(sessionFilePath(cwd, sessionId), "", "utf8");

  return { sessionId, messages: [], isNew: true };
}

/**
 * 加载 session 的消息。
 */
export async function loadSessionMessages(filePath: string): Promise<AgentMessage[]> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const messages: AgentMessage[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as AgentMessage);
      } catch {
        // 跳过损坏的行
        continue;
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * 追加消息到 session。
 *
 * 写顺序：先追加 jsonl，再更新 meta。
 * meta 写入单独 try-catch，不影响 jsonl 写入。
 */
export async function appendSessionMessage(
  cwd: string,
  sessionId: string,
  message: AgentMessage,
): Promise<void> {
  const dir = sessionDir(cwd);
  await mkdir(dir, { recursive: true });

  // 先追加到 JSONL（主要数据）
  const filePath = sessionFilePath(cwd, sessionId);
  await appendFile(filePath, JSON.stringify(message) + "\n", "utf8");

  // 再更新 meta（辅助数据），失败不阻断主流程
  try {
    const metaPath = metaFilePath(cwd, sessionId);
    const content = await readFile(metaPath, "utf8");
    const meta: SessionMeta = JSON.parse(content);
    meta.messageCount += 1;
    meta.updatedAt = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // meta 写入失败不影响消息持久化
  }
}

/**
 * 更新 session 名称。
 */
export async function renameSession(cwd: string, sessionId: string, name: string): Promise<void> {
  const metaPath = metaFilePath(cwd, sessionId);
  try {
    const content = await readFile(metaPath, "utf8");
    const meta: SessionMeta = JSON.parse(content);
    meta.name = name;
    meta.updatedAt = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // meta 不存在则忽略
  }
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
    // 文件不存在则忽略
  }
}
