/**
 * Session 路径工具（从 session-store.ts 中提取为公共导出）
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

function getSessionsDir(): string {
  return path.join(os.homedir(), ".tca", "sessions");
}

function cwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function sessionDir(cwd: string): string {
  return path.join(getSessionsDir(), cwdHash(cwd));
}

export function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd), `${sessionId}.jsonl`);
}

export function metaFilePath(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd), `${sessionId}.meta.json`);
}
