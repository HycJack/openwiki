/**
 * /ctx — 上下文概览 / 触发压缩
 *
 * 用法：
 *   /ctx            — 显示上下文用量
 *   /ctx compact    — 触发压缩
 */

import type { CommandEntry } from "./registry.js";
import { estimateContextUsage } from "../token-estimate.js";
import { performCompact } from "./compact.js";

export const ctxCommand: CommandEntry = {
  name: "ctx",
  description: "Context overview",
  handler: async (args, ctx) => {
    const sub = args[0];

    if (sub === "compact") {
      await performCompact(ctx, "");
      return;
    }

    // 默认显示上下文概览
    const usage = estimateContextUsage(
      ctx.agent.state.messages,
      ctx.agent.state.systemPrompt,
      ctx.model.contextWindow ?? 128000,
    );

    const barWidth = 30;
    const filled = Math.round((usage.percent / 100) * barWidth);
    const bar = "\x1b[33m" + "█".repeat(filled) + "\x1b[90m" + "░".repeat(Math.max(0, barWidth - filled)) + "\x1b[0m";
    const pct = usage.percent.toFixed(1);

    console.log([
      `\x1b[90m── Context ────────────────────────────\x1b[0m`,
      `  ${bar}  ${pct}%`,
      `  \x1b[2mTokens:\x1b[0m ${usage.tokens} / ${usage.limit}`,
      `  \x1b[2mMessages:\x1b[0m ${ctx.agent.state.messages.length}`,
      `  \x1b[2mWindow:\x1b[0m ${ctx.model.id} (${usage.limit} tokens)`,
      `\x1b[90m──────────────────────────────────────\x1b[0m`,
      `\x1b[90mUse /ctx compact to compress.\x1b[0m`,
    ].join("\n"));
  },
};
