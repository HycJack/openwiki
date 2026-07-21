/**
 * Built-in tools
 *
 * 参考 pi-mono coding-agent tools 和 openwiki/tui-coding-agent 设计：
 * - bash: 执行 shell 命令，根据 OS 自动选择 shell
 * - read: 读取文件
 * - write: 写入文件
 * - edit: 编辑文件（搜索替换）
 * - grep: 搜索文件内容
 * - ls: 列出目录
 */

import { Type, type Static } from "typebox";
import { execFile, execSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentTool } from "../types.js";
import type { SandboxManager } from "../sandbox/index.js";

const MAX_OUTPUT = 100_000;

// OS detection
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const OS_NAME = IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";

function hasPwsh(): boolean {
  try {
    execSync("where pwsh", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BashParams = Type.Object({
  command: Type.String({ description: "The shell command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 120)" })),
  isPowerShell: Type.Optional(Type.Boolean({ description: "Set to true to force PowerShell execution on Windows (ignored on Unix)" })),
});

const ReadParams = Type.Object({
  path: Type.String({ description: "File path to read" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start from (1-based)" })),
  limit: Type.Optional(Type.Number({ description: "Max lines to read" })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "File path to write" }),
  content: Type.String({ description: "Content to write" }),
});

const EditParams = Type.Object({
  path: Type.String({ description: "File path to edit" }),
  old_text: Type.String({ description: "Text to find (must be unique in the file)" }),
  new_text: Type.String({ description: "Replacement text" }),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Regex pattern to search for" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default cwd)" })),
  glob: Type.Optional(Type.String({ description: "File glob pattern (e.g. *.ts)" })),
});

const LsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory path (default cwd)" })),
});

export function createBashTool(sandbox?: SandboxManager): AgentTool<typeof BashParams> {
  const shellName = IS_WIN ? (hasPwsh() ? "PowerShell (pwsh)" : "cmd.exe") : "/bin/bash";
  return {
    name: "bash",
    label: "Bash",
    description: `Execute a ${shellName} command and return stdout/stderr. Running on ${OS_NAME}.${sandbox?.isActive ? " [sandboxed]" : ""}`,
    parameters: BashParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const cwd = params.cwd ?? process.cwd();
      const timeout = (params.timeout ?? 120) * 1000;

      // 沙箱激活时走沙箱路径
      if (sandbox?.isActive) {
        const sbResult = await sandbox.run(
          IS_WIN ? (params.isPowerShell ? "pwsh.exe" : "cmd.exe") : "/bin/bash",
          IS_WIN
            ? (params.isPowerShell || hasPwsh()
              ? ["-NoLogo", "-NonInteractive", "-Command", params.command]
              : ["/c", params.command])
            : ["-c", params.command],
          { cwd, timeoutMs: timeout },
        );

        return {
          content: [{ type: "text", text: sbResult.stdout + sbResult.stderr || "(no output)" }],
          details: { exitCode: sbResult.exitCode, stdout: sbResult.stdout, stderr: sbResult.stderr, sandboxed: true },
        };
      }

      // 非沙箱路径（原有逻辑）
      return new Promise((resolve) => {
        let shell: string;
        let shellArgs: string[];

        if (IS_WIN) {
          const usePwsh = params.isPowerShell ?? hasPwsh();
          if (usePwsh) {
            shell = "pwsh.exe";
            shellArgs = ["-NoLogo", "-NonInteractive", "-Command", params.command];
          } else {
            shell = "cmd.exe";
            shellArgs = ["/c", params.command];
          }
        } else {
          shell = "/bin/bash";
          shellArgs = ["-c", params.command];
        }

        const child = execFile(shell, shellArgs, {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout,
        }, (error, stdout, stderr) => {
          // error.code 可能是数字（退出码）或字符串（如 "ETIMEDOUT"），统一转为数字
          const exitCode = error
            ? (typeof error.code === "number" ? error.code : 1)
            : 0;
          const output = [
            stdout ? `stdout:\n${stdout.slice(0, MAX_OUTPUT)}` : "",
            stderr ? `stderr:\n${stderr.slice(0, MAX_OUTPUT)}` : "",
            `exit code: ${exitCode}`,
          ].filter(Boolean).join("\n");

          resolve({
            content: [{ type: "text", text: output || "(no output)" }],
            details: { exitCode, stdout, stderr },
          });
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            child.kill("SIGTERM");
            if (IS_WIN && child.pid) {
              try {
                execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore", timeout: 2000 });
              } catch {
                // ignore
              }
            }
          }, { once: true });
        }
      });
    },
  };
}

export function createReadTool(): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "Read File",
    description: "Read the contents of a file. Returns up to 100KB of text.",
    parameters: ReadParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params) => {
      const filePath = path.resolve(params.path);
      const content = await readFile(filePath, "utf8");
      let lines = content.split("\n");

      const offset = params.offset ? params.offset - 1 : 0;
      const limit = params.limit ?? lines.length;
      lines = lines.slice(offset, offset + limit);

      const result = lines.map((line, i) => `${String(offset + i + 1).padStart(4)}: ${line}`).join("\n");
      return {
        content: [{ type: "text", text: result.slice(0, MAX_OUTPUT) }],
        details: { path: filePath, totalLines: content.split("\n").length },
      };
    },
  };
}

export function createWriteTool(): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    label: "Write File",
    description: "Write content to a file, creating parent directories if needed.",
    parameters: WriteParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const filePath = path.resolve(params.path);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, params.content, "utf8");
      return {
        content: [{ type: "text", text: `Wrote ${params.content.length} bytes to ${filePath}` }],
        details: { path: filePath, bytes: params.content.length },
      };
    },
  };
}

export function createEditTool(): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    label: "Edit File",
    description: "Edit a file by replacing old_text with new_text. The old_text must appear exactly once.",
    parameters: EditParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const filePath = path.resolve(params.path);
      const content = await readFile(filePath, "utf8");
      const occurrences = content.split(params.old_text).length - 1;
      if (occurrences === 0) {
        throw new Error(`old_text not found in ${filePath}`);
      }
      if (occurrences > 1) {
        throw new Error(`old_text appears ${occurrences} times in ${filePath}; must be unique`);
      }
      const newContent = content.replace(params.old_text, params.new_text);
      await writeFile(filePath, newContent, "utf8");
      return {
        content: [{ type: "text", text: `Edited ${filePath}: replaced ${params.old_text.length} chars with ${params.new_text.length} chars` }],
        details: { path: filePath, oldLength: content.length, newLength: newContent.length },
      };
    },
  };
}

export function createGrepTool(): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    label: "Grep",
    description: "Search for a pattern in files. Returns matching lines with file paths.",
    parameters: GrepParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params) => {
      const searchPath = params.path ?? process.cwd();
      const pattern = new RegExp(params.pattern, "i");
      const results: string[] = [];
      let fileCount = 0;
      const MAX_RESULTS = 1000;
      const MAX_FILE_SIZE = 1024 * 1024; // 1MB，跳过更大文件

      // 用内部异常中断整个递归，避免达到上限后继续无效遍历
      class SearchLimitReached extends Error {}

      async function searchDir(dir: string, depth: number): Promise<void> {
        if (depth > 10) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            if (params.glob && !matchGlob(entry.name, params.glob)) continue;
            // 跳过大文件
            const fileStat = await stat(fullPath).catch(() => null);
            if (fileStat && fileStat.size > MAX_FILE_SIZE) continue;
            const content = await readFile(fullPath, "utf8").catch(() => "");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i]!)) {
                results.push(`${path.relative(searchPath, fullPath)}:${i + 1}: ${lines[i]!.trim()}`);
                if (results.length >= MAX_RESULTS) throw new SearchLimitReached();
              }
            }
            fileCount++;
          }
        }
      }

      try {
        await searchDir(searchPath, 0);
      } catch (err) {
        // 达到上限是预期行为，静默处理
        if (!(err instanceof SearchLimitReached)) throw err;
      }
      const output = results.length > 0 ? results.join("\n") : "No matches found";
      return {
        content: [{ type: "text", text: output.slice(0, MAX_OUTPUT) }],
        details: { matchCount: results.length, filesSearched: fileCount },
      };
    },
  };
}

export function createLsTool(): AgentTool<typeof LsParams> {
  return {
    name: "ls",
    label: "List Directory",
    description: "List files and directories in a path.",
    parameters: LsParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params) => {
      const dir = params.path ?? process.cwd();
      const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
        throw new Error(`Cannot list ${dir}: ${err.message}`);
      });
      const items = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          let size = 0;
          if (entry.isFile()) {
            const s = await stat(fullPath).catch(() => ({ size: 0 }));
            size = s.size;
          }
          return { name: entry.name, type: entry.isDirectory() ? "dir" : "file", size };
        }),
      );
      const output = items
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
        .map((i) => `${i.type === "dir" ? "d" : "f"} ${String(i.size).padStart(8)} ${i.name}`)
        .join("\n");
      return {
        content: [{ type: "text", text: output || "(empty directory)" }],
        details: { path: dir, count: items.length },
      };
    },
  };
}

function matchGlob(filename: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\{([^}]+)\}/g, (_m, group: string) =>
      `(${group.split(",").map((s) => s.trim()).join("|")})`);
  return new RegExp(`^${regexPattern}$`).test(filename);
}

export function createBuiltinTools(sandbox?: SandboxManager): AgentTool[] {
  return [
    createBashTool(sandbox) as AgentTool,
    createReadTool() as AgentTool,
    createWriteTool() as AgentTool,
    createEditTool() as AgentTool,
    createGrepTool() as AgentTool,
    createLsTool() as AgentTool,
  ];
}
