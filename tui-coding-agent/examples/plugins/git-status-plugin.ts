/**
 * 示例插件：Git 状态工具
 *
 * 参考 pi-mono 的 prompt-url-widget.ts 设计：
 * - 注册自定义工具供 LLM 调用
 * - 注册斜杠命令
 * - 监听事件
 */

import { Type } from "typebox";
import type { PluginAPI } from "../../src/plugin/types.js";

export default function gitStatusPlugin(api: PluginAPI): void {
  // 注册 git_status 工具
  api.registerTool({
    name: "git_status",
    label: "Git Status",
    description: "Get the current git repository status, including branch, staged, and unstaged changes.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Repository path (default: cwd)" })),
    }),
    execute: async (_toolCallId, params) => {
      const cwd = params.path ?? process.cwd();
      const result = await api.exec("git", ["status", "--porcelain=v2", "--branch"], cwd);

      const lines = result.stdout.split("\n").filter(Boolean);
      const branchLine = lines.find((l) => l.startsWith("# branch.head"));
      const branch = branchLine ? branchLine.split(" ").pop() : "unknown";
      const changed = lines.filter((l) => !l.startsWith("#")).length;

      const text = `Branch: ${branch}\nChanged files: ${changed}\n\n${result.stdout.slice(0, 2000)}`;

      return {
        content: [{ type: "text", text }],
        details: { branch, changed, exitCode: result.exitCode },
      };
    },
  });

  // 注册 /git 命令
  api.registerCommand("git", async (ctx, args) => {
    await ctx.waitForIdle();
    const subCommand = args.trim() || "status";
    const result = await api.exec("git", ["status"], ctx.cwd);

    if (result.exitCode !== 0) {
      api.notify(`Git error: ${result.stderr}`, "error");
      return;
    }

    ctx.sendMessage(`Run \`git ${subCommand}\`:\n\n\`\`\`\n${result.stdout.slice(0, 2000)}\n\`\`\``);
  });

  // 监听 agent_start 事件，显示 git 分支信息
  api.on("agent_start", () => {
    // 可以在这里做前置检查
  });

  api.notify("Git status plugin loaded", "info");
}
