/**
 * Git Operations Plugin
 *
 * 提供：
 * - /git <args> 命令：在 TUI 中执行任意 git 命令并显示结果
 * - /git-log 命令：显示简洁的 git log
 * - /git-status 命令：显示当前工作区状态（修改/暂存/未跟踪）
 * - /git-diff 命令：显示未暂存的 diff
 * - git_status LLM 工具：让 LLM 可以查询 git 状态
 * - git_log LLM 工具：让 LLM 可以查询 git 日志
 * - git_diff LLM 工具：让 LLM 可以查看 diff
 */

import type { ExtensionAPI } from "../src/types.js";

export default function (api: ExtensionAPI) {

  // ==========================================================================
  // LLM 工具
  // ==========================================================================

  api.registerTool({
    name: "git_status",
    description: "Show the current git working tree status (modified, staged, untracked files)",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (_toolCallId, _params) => {
      const { stdout, stderr, exitCode } = await api.exec("git", ["status", "--short"]);
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `Git status failed:\n${stderr || "exit code " + exitCode}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: stdout || "No changes (clean working tree)" }],
      };
    },
  });

  api.registerTool({
    name: "git_log",
    description: "Show recent git commit history (last 20 commits by default)",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of commits to show (default: 20)",
        },
        branch: {
          type: "string",
          description: "Branch name to show log for (default: current branch)",
        },
      },
      required: [],
    },
    execute: async (_toolCallId, params) => {
      const count = params.count ?? 20;
      const args = ["log", `--max-count=${count}`, "--oneline", "--decorate"];
      if (params.branch) args.push(params.branch);
      const { stdout, stderr, exitCode } = await api.exec("git", args);
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `Git log failed:\n${stderr || "exit code " + exitCode}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: stdout || "(no commits)" }] };
    },
  });

  api.registerTool({
    name: "git_diff",
    description: "Show the diff of unstaged changes (working tree vs index)",
    parameters: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description: "If true, show staged changes (index vs HEAD) instead of unstaged",
        },
        path: {
          type: "string",
          description: "Optional file path to show diff for",
        },
      },
      required: [],
    },
    execute: async (_toolCallId, params) => {
      const args = params.staged ? ["diff", "--cached"] : ["diff"];
      if (params.path) args.push(params.path);
      const { stdout, stderr, exitCode } = await api.exec("git", args);
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `Git diff failed:\n${stderr || "exit code " + exitCode}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: stdout || "(no changes)" }] };
    },
  });

  api.registerTool({
    name: "git_branches",
    description: "List local git branches",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (_toolCallId, _params) => {
      const { stdout, stderr, exitCode } = await api.exec("git", ["branch", "--list"]);
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `Git branches failed:\n${stderr || "exit code " + exitCode}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: stdout }] };
    },
  });

  // ==========================================================================
  // 命令
  // ==========================================================================

  api.registerCommand("git", async (ctx, args) => {
    const trimmed = args.trim();
    if (!trimmed) {
      ctx.notify("Usage: /git <git-args>", "info");
      return;
    }
    ctx.notify(`Running: git ${trimmed}`, "info");

    const { stdout, stderr, exitCode } = await api.exec("git", trimmed.split(/\s+/));

    if (exitCode !== 0) {
      console.log(`\x1b[91m── git ${trimmed} (exit ${exitCode}) ────────────────\x1b[0m`);
      console.log(stderr || "(no stderr)");
      ctx.notify(`Git command failed (exit ${exitCode})`, "error");
    } else {
      const output = stdout || "(empty output)";
      if (output.length > 2000) {
        console.log(`\x1b[90m── git ${trimmed} ──────────────────────────────────\x1b[0m`);
        console.log(output.slice(0, 2000));
        console.log(`\x1b[90m... (${output.length - 2000} more chars)\x1b[0m`);
      } else {
        console.log(`\x1b[90m── git ${trimmed} ──────────────────────────────────\x1b[0m`);
        console.log(output);
      }
      console.log(`\x1b[90m────────────────────────────────────────────────────\x1b[0m`);
      ctx.notify(`Git command completed (exit 0)`, "info");
    }
  }, "Execute any git command: /git <args>");

  api.registerCommand("git-log", async (ctx, args) => {
    const count = args.trim() || "20";
    const { stdout, stderr, exitCode } = await api.exec("git", ["log", `--max-count=${count}`, "--oneline", "--decorate"]);
    if (exitCode !== 0) {
      console.log(`\x1b[91m${stderr}\x1b[0m`);
      ctx.notify("Git log failed", "error");
      return;
    }
    console.log(`\x1b[90m── Recent commits (last ${count}) ─────────────────────\x1b[0m`);
    console.log(stdout || "(no commits)");
    console.log(`\x1b[90m────────────────────────────────────────────────────\x1b[0m`);
  }, "Show recent git log: /git-log [count]");

  api.registerCommand("git-status", async (ctx, _args) => {
    const { stdout, stderr, exitCode } = await api.exec("git", ["status", "--short"]);
    if (exitCode !== 0) {
      console.log(`\x1b[91m${stderr}\x1b[0m`);
      ctx.notify("Git status failed", "error");
      return;
    }
    console.log(`\x1b[90m── Git Status ───────────────────────────────────────\x1b[0m`);
    if (stdout.trim()) {
      console.log(stdout);
    } else {
      console.log("\x1b[32mClean working tree\x1b[0m");
    }
    console.log(`\x1b[90m────────────────────────────────────────────────────\x1b[0m`);
  }, "Show git working tree status");

  api.registerCommand("git-diff", async (ctx, args) => {
    const cmdArgs = args.trim() ? ["diff", ...args.split(/\s+/)] : ["diff"];
    const { stdout, stderr, exitCode } = await api.exec("git", cmdArgs);
    if (exitCode !== 0) {
      console.log(`\x1b[91m${stderr}\x1b[0m`);
      ctx.notify("Git diff failed", "error");
      return;
    }
    console.log(`\x1b[90m── Git Diff ────────────────────────────────────────\x1b[0m`);
    console.log(stdout || "(no changes)");
    console.log(`\x1b[90m────────────────────────────────────────────────────\x1b[0m`);
  }, "Show git diff: /git-diff [--staged] [path]");
}
