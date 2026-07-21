/**
 * sandbox 模块共享类型
 */

export interface SandboxResult {
  /** 进程退出码 */
  exitCode: number;
  /** stdout 输出 */
  stdout: string;
  /** stderr 输出 */
  stderr: string;
  /** 是否超时 */
  timedOut: boolean;
  /** win32 错误码 */
  win32Error?: number;
}
