/**
 * /tokens, /usage — 显示 token 用量
 */

import type { CommandEntry } from "./registry.js";
import { estimateContextUsage } from "../token-estimate.js";

export const tokensCommand: CommandEntry = {
  name: "tokens",
  description: "Show token usage",
  handler: async (_args, ctx) => {
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
      `\x1b[90m── Tokens ────────────────────────────\x1b[0m`,
      `  ${bar}  ${pct}%`,
      `  \x1b[2mTokens:\x1b[0m ${usage.tokens} / ${usage.limit}`,
      `\x1b[90m──────────────────────────────────────\x1b[0m`,
    ].join("\n"));
  },
};
