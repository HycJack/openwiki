/**
 * sandbox-helper resolution — 参考 openhanako win32-sandbox-helper.ts
 *
 * 负责：
 * - 在文件系统中查找 sandbox-helper.exe
 * - 构建调用参数
 * - 解析 stderr 中的退出记录
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SANDBOX_HELPER_NAME = "sandbox-helper.exe";

// ============================================================================
// 查找 helper
// ============================================================================

export interface ResolveHelperOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  arch?: string;
  existsSync?: (p: string) => boolean;
}

export function resolveSandboxHelper(
  options: ResolveHelperOptions = {},
): string | null {
  const {
    env = process.env as Record<string, string | undefined>,
    cwd = process.cwd(),
    arch = process.arch,
    existsSync: exists = existsSync,
  } = options;

  // 项目根目录
  const projectRoot = path.resolve(__dirname, "..", "..");

  const candidates = [
    // 1. 环境变量覆盖
    env.TCA_SANDBOX_HELPER,
    // 2. 编译产物目录 bin/
    path.resolve(projectRoot, "bin", SANDBOX_HELPER_NAME),
    // 3. 同项目 dist-sandbox/ 目录（类似 openhanako 布局）
    path.resolve(projectRoot, "dist-sandbox", `win-${arch}`, SANDBOX_HELPER_NAME),
    // 4. 源码目录
    path.resolve(projectRoot, "sandbox", SANDBOX_HELPER_NAME),
    // 5. cwd 下的 bin/
    path.resolve(cwd, "bin", SANDBOX_HELPER_NAME),
  ].filter(Boolean) as string[];

  return candidates.find((c) => exists(c)) || null;
}

// ============================================================================
// 构建参数
// ============================================================================

export interface HelperGrants {
  writePaths?: string[];
  optionalWritePaths?: string[];
  denyWritePaths?: string[];
}

export interface BuildHelperArgsOptions {
  cwd: string;
  timeoutMs: number;
  grants?: HelperGrants;
  executable: string;
  args?: string[];
}

export function buildHelperArgs(options: BuildHelperArgsOptions): string[] {
  const { cwd, timeoutMs, executable, args = [] } = options;
  const grants = options.grants ?? {};

  const out: string[] = ["--cwd", cwd];
  for (const p of grants.writePaths ?? []) out.push("--writable-root", p);
  for (const p of grants.optionalWritePaths ?? []) out.push("--writable-root-optional", p);
  for (const p of grants.denyWritePaths ?? []) out.push("--deny-write", p);
  out.push("--timeout-ms", String(timeoutMs));
  out.push("--", executable, ...args);
  return out;
}

// ============================================================================
// 从 stderr 解析 terminal record
// ============================================================================

export type SandboxTerminalStatus =
  | "exited"
  | "timed_out"
  | "termination_failed"
  | "launch_failed";

export interface SandboxTerminalRecord {
  version: 1;
  status: SandboxTerminalStatus;
  exitCode: number | null;
  timeoutMs: number;
  win32Error: number;
}

export function parseTerminalRecord(output: unknown): SandboxTerminalRecord | null {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "");
  const prefix = "hana-win-sandbox: terminal-v1";
  const lines = text.split(/\r?\n/);
  let last: SandboxTerminalRecord | null = null;

  for (const line of lines) {
    // hana-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="30000" win32Error="0"
    const match = line.match(
      /^hana-win-sandbox: terminal-v1 status="([^"]*)" exitCode="([^"]*)" timeoutMs="([^"]*)" win32Error="([^"]*)"$/,
    );
    if (!match) continue;
    const status = match[1] as SandboxTerminalStatus;
    if (status !== "exited" && status !== "timed_out" && status !== "termination_failed" && status !== "launch_failed") continue;
    const exitCode = match[2] === "" ? null : Number(match[2]);
    const timeoutMs = Number(match[3]);
    const win32Error = Number(match[4]);
    if ((exitCode !== null && !Number.isSafeInteger(exitCode))
      || !Number.isSafeInteger(timeoutMs)
      || !Number.isSafeInteger(win32Error)) continue;
    last = { version: 1, status, exitCode, timeoutMs, win32Error };
  }

  return last;
}

// ============================================================================
// 诊断参数
// ============================================================================

export function buildDiagnosticArgs(options: BuildHelperArgsOptions): string[] {
  return ["--diagnose-token", ...buildHelperArgs(options)];
}
