/**
 * 示例插件：代码统计工具
 *
 * 演示如何注册一个自定义工具，让 LLM 可以调用它来获取项目代码统计信息。
 */

import { Type } from "typebox";
import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginAPI } from "../../src/plugin/types.js";

interface LangStats {
  language: string;
  files: number;
  lines: number;
}

async function countLines(dir: string, stats: Map<string, LangStats>, depth: number): Promise<void> {
  if (depth > 10) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await countLines(fullPath, stats, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1);
      if (!ext) continue;

      const langMap: Record<string, string> = {
        ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
        py: "Python", rs: "Rust", go: "Go", java: "Java",
        c: "C", cpp: "C++", h: "C/C++ Header",
        css: "CSS", html: "HTML", json: "JSON", md: "Markdown",
      };
      const lang = langMap[ext];
      if (!lang) continue;

      const content = await readFile(fullPath, "utf8").catch(() => "");
      const lines = content.split("\n").length;

      const existing = stats.get(lang) ?? { language: lang, files: 0, lines: 0 };
      existing.files++;
      existing.lines += lines;
      stats.set(lang, existing);
    }
  }
}

export default function codeStatsPlugin(api: PluginAPI): void {
  api.registerTool({
    name: "code_stats",
    label: "Code Statistics",
    description: "Count files and lines of code by language in a directory. Useful for understanding project size.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to analyze (default: cwd)" })),
    }),
    execute: async (_toolCallId, params) => {
      const dir = params.path ?? process.cwd();
      const stats = new Map<string, LangStats>();
      await countLines(dir, stats, 0);

      const sorted = Array.from(stats.values()).sort((a, b) => b.lines - a.lines);
      const lines = sorted.map(
        (s) => `${s.language.padEnd(12)} ${String(s.files).padStart(6)} files  ${String(s.lines).padStart(8)} lines`,
      );
      const totalFiles = sorted.reduce((sum, s) => sum + s.files, 0);
      const totalLines = sorted.reduce((sum, s) => sum + s.lines, 0);

      const text = [
        ...lines,
        `${"-".repeat(40)}`,
        `Total         ${String(totalFiles).padStart(6)} files  ${String(totalLines).padStart(8)} lines`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { languages: sorted, totalFiles, totalLines },
      };
    },
  });

  api.registerCommand("stats", async (ctx, _args) => {
    await ctx.waitForIdle();
    ctx.sendMessage("Please use the code_stats tool to analyze the project.");
  });
}
