/**
 * 内置工具集
 *
 * 参考 pi-mono coding-agent 的 tools/ 目录设计：
 * - bash: 执行 shell 命令
 * - read: 读取文件
 * - write: 写入文件
 * - edit: 编辑文件（搜索替换）
 * - grep: 搜索文件内容
 * - ls: 列出目录
 *
 * 参考 openwiki 的 createOpenWikiConnectorTools 模式，使用 DynamicStructuredTool 风格。
 *
 * 注意：bash 工具根据操作系统自动选择 shell 和语法提示。
 */

import { Type, type Static } from "typebox";
import { execFile, execSync } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "../types.js";

const MAX_OUTPUT = 100_000;

// 操作系统检测
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const OS_NAME = IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";

// Windows 上检测是否可用 pwsh
let _hasPwsh: boolean | null = null;
function hasPwsh(): boolean {
  if (_hasPwsh === null) {
    try {
      execSync("where pwsh", { stdio: "ignore" });
      _hasPwsh = true;
    } catch {
      _hasPwsh = false;
    }
  }
  return _hasPwsh;
}

// 参数类型定义
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

export function createBashTool(): AgentTool<typeof BashParams> {
  const shellName = IS_WIN ? (hasPwsh() ? "PowerShell (pwsh)" : "cmd.exe") : "/bin/bash";
  const shellCommand = IS_WIN ? (hasPwsh() ? "pwsh.exe" : "cmd.exe") : "/bin/bash";
  const shellArg = IS_WIN ? (hasPwsh() ? "-Command" : "/c") : "-c";
  const cmdPrefix = IS_WIN ? "Command" : "Shell command";

  return {
    name: "bash",
    label: "Bash",
    description: `Execute a ${shellName} command and return stdout/stderr. Use for running tests, git, build scripts, etc. Running on ${OS_NAME}. Use correct command syntax for ${OS_NAME}.`,
    parameters: BashParams,
    executionMode: "sequential",
    execute: async (toolCallId, params: Static<typeof BashParams> & { isPowerShell?: boolean }, signal) => {
      const cwd = params.cwd ?? process.cwd();
      const timeout = (params.timeout ?? 120) * 1000;
      let command = params.command;

      // Windows 路径修正：将命令中的 / 路径转换为 Windows 可接受的格式
      // 但保留命令本身的语法

      return new Promise((resolve) => {
        let shell: string;
        let shellArgs: string[];

        if (IS_WIN) {
          const usePwsh = params.isPowerShell ?? hasPwsh();
          if (usePwsh) {
            shell = "pwsh.exe";
            shellArgs = ["-NoLogo", "-NonInteractive", "-Command", command];
          } else {
            shell = "cmd.exe";
            shellArgs = ["/c", command];
          }
        } else {
          shell = "/bin/bash";
          shellArgs = ["-c", command];
        }

        const child = execFile(shell, shellArgs, { cwd, maxBuffer: 10 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
          const exitCode = error?.code ?? 0;
          const output = [
            stdout ? `stdout:\n${stdout.slice(0, MAX_OUTPUT)}` : "",
            stderr ? `stderr:\n${stderr.slice(0, MAX_OUTPUT)}` : "",
            error ? `exit code: ${exitCode}` : "exit code: 0",
          ].filter(Boolean).join("\n");

          resolve({
            content: [{ type: "text", text: output || "(no output)" }],
            details: { exitCode, stdout, stderr },
          });
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            child.kill("SIGTERM");
            // taskkill 确保子进程树也被终止
            if (IS_WIN && child.pid) {
              try {
                execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], { timeout: 2000 });
              } catch {
                // taskkill 可能失败（进程已退出），忽略
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
    execute: async (_toolCallId, params: Static<typeof ReadParams>) => {
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
    execute: async (_toolCallId, params: Static<typeof WriteParams>) => {
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
    execute: async (_toolCallId, params: Static<typeof EditParams>) => {
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
    execute: async (_toolCallId, params: Static<typeof GrepParams>) => {
      const searchPath = params.path ?? process.cwd();
      const pattern = new RegExp(params.pattern, "i");
      const results: string[] = [];
      let fileCount = 0;

      async function searchDir(dir: string, depth: number): Promise<void> {
        if (depth > 10 || results.length > 1000) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            if (params.glob && !matchGlob(entry.name, params.glob)) continue;
            const content = await readFile(fullPath, "utf8").catch(() => "");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i])) {
                results.push(`${path.relative(searchPath, fullPath)}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= 100) return;
              }
            }
            fileCount++;
          }
        }
      }

      await searchDir(searchPath, 0);
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
    execute: async (_toolCallId, params: Static<typeof LsParams>) => {
      const dir = params.path ?? process.cwd();
      const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
        throw new Error(`Cannot list ${dir}: ${err.message}`);
      });
      const items = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          let size = 0;
          let type = entry.isDirectory() ? "dir" : "file";
          if (entry.isFile()) {
            const s = await stat(fullPath).catch(() => ({ size: 0 }));
            size = s.size;
          }
          return { name: entry.name, type, size };
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
  // 简单 glob 匹配，支持 *、?、[abc]、{a,b}
  const regexPattern = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    // 处理 {a,b} -> (a|b)
    .replace(/\{([^}]+)\}/g, (_m, group: string) =>
      `(${group.split(",").map((s: string) => s.trim()).join("|")})`);
  return new RegExp(`^${regexPattern}$`).test(filename);
}

export function createBuiltinTools(): AgentTool[] {
  return [
    createBashTool() as AgentTool,
    createReadTool() as AgentTool,
    createWriteTool() as AgentTool,
    createEditTool() as AgentTool,
    createGrepTool() as AgentTool,
    createLsTool() as AgentTool,
  ];
}
