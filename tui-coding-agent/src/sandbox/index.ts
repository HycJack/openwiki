/**
 * Sandbox Manager — Windows 沙箱管理器
 *
 * 使用 HanaWindowsSandboxHelper（sandbox-helper.exe）创建受限 token 执行进程。
 *
 * 沙箱原理：
 * 1. 对工作目录设置 ACL，允许受限 SID 写入
 * 2. CreateRestrictedToken + SID restricting → 受限 token
 * 3. 在受限 token 下通过 CreateProcessAsUserW 启动子进程
 * 4. 进程退出后还原 ACL
 *
 * 效果：沙箱内进程只能写入工作目录，对其他目录只有读权限。
 */

import { spawn } from "node:child_process";
import {
  resolveSandboxHelper,
  buildHelperArgs,
  parseTerminalRecord,
  buildDiagnosticArgs,
  type HelperGrants,
} from "./helper.js";
import type { SandboxResult } from "./types.js";

export type { SandboxResult };
export type { HelperGrants } from "./helper.js";
export {
  resolveSandboxHelper,
  buildHelperArgs,
  parseTerminalRecord,
  SANDBOX_HELPER_NAME,
} from "./helper.js";

// ============================================================================
// SandboxManager
// ============================================================================

export class SandboxManager {
  private helperPath: string | null = null;
  private _workspace: string = "";
  private _active = false;

  /** 当前工作区路径 */
  get workspace(): string {
    return this._workspace;
  }

  /** 沙箱是否已激活 */
  get isActive(): boolean {
    return this._active;
  }

  /**
   * 初始化沙箱管理器
   * @param workspace 工作目录（沙箱内可写）
   */
  init(workspace: string): boolean {
    this.helperPath = resolveSandboxHelper();
    this._workspace = workspace;

    if (!this.helperPath) {
      console.warn("[sandbox] sandbox-helper.exe not found. Sandbox disabled.");
      return false;
    }

    this._active = true;
    return true;
  }

  /**
   * 在沙箱中执行命令
   */
  async run(
    executable: string,
    args: string[],
    options: {
      cwd?: string;
      timeoutMs?: number;
      grants?: HelperGrants;
    } = {},
  ): Promise<SandboxResult> {
    const cwd = options.cwd ?? this._workspace;

    if (!this.helperPath) {
      // 沙箱不可用 → 直接 spawn
      return this.spawnDirect(executable, args, cwd, options.timeoutMs);
    }

    const helperArgs = buildHelperArgs({
      cwd,
      timeoutMs: options.timeoutMs ?? 120000,
      grants: options.grants,
      executable,
      args,
    });

    return this.spawnHelper(helperArgs, options.timeoutMs ?? 120000);
  }

  /**
   * 诊断沙箱配置
   */
  async diagnose(): Promise<string[]> {
    if (!this.helperPath) return ["[sandbox] not available"];

    const lines: string[] = [];
    try {
      const args = buildDiagnosticArgs({
        cwd: this._workspace,
        timeoutMs: 5000,
        executable: "cmd.exe",
        args: ["/c", "echo ok"],
      });
      const result = await this.spawnHelper(args, 5000);
      lines.push(...result.stderr.split("\n").filter(Boolean));
    } catch (e: any) {
      lines.push(`[sandbox] diagnose failed: ${e.message}`);
    }
    return lines;
  }

  /**
   * 清理 ACL（沙箱使用结束后调用）
   */
  async cleanup(workspace?: string): Promise<void> {
    const target = workspace ?? this._workspace;
    if (!this.helperPath || !target) return;

    try {
      const result = await this.spawnHelper(
        ["--cleanup-acl", target],
        10000,
      );
      if (result.exitCode !== 0) {
        console.warn(`[sandbox] ACL cleanup exited with code ${result.exitCode}`);
      }
    } catch {
      // 非致命
    }
  }

  // ========================================================================
  // 内部
  // ========================================================================

  private spawnHelper(args: string[], timeoutMs: number): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const child = spawn(this.helperPath!, args, {
        stdio: ["inherit", "pipe", "pipe"],
        windowsHide: true,
        timeout: timeoutMs + 10000, // helper 超时后额外带宽限
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      child.on("close", (code) => {
        // 解析 stderr 中的 terminal record
        const record = parseTerminalRecord(stderr);
        resolve({
          exitCode: record?.exitCode ?? code ?? 1,
          stdout,
          stderr,
          timedOut: record?.status === "timed_out",
          win32Error: record?.win32Error ?? 0,
        });
      });

      child.on("error", (err) => {
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: `spawn error: ${err.message}`,
          timedOut: false,
          win32Error: 0,
        });
      });
    });
  }

  private spawnDirect(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
  ): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
        windowsHide: true,
        timeout: timeoutMs ?? 120000,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: false });
      });
      child.on("error", (err) => {
        resolve({ exitCode: 1, stdout, stderr: `spawn error: ${err.message}`, timedOut: false });
      });
    });
  }
}

// ============================================================================
// 全局单例
// ============================================================================

let _instance: SandboxManager | null = null;

export function getSandbox(): SandboxManager {
  if (!_instance) {
    _instance = new SandboxManager();
  }
  return _instance;
}

export function resetSandbox(): void {
  _instance = null;
}
