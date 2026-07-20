/**
 * /help — 显示帮助信息
 */

import type { CommandEntry } from "./registry.js";

const hl = (s: string): string => `\x1b[33m${s}\x1b[0m`;   // yellow
const dim = (s: string): string => `\x1b[90m${s}\x1b[0m`;  // gray

export const helpCommand: CommandEntry = {
  name: "help",
  description: "Show available commands",
  handler: async (_args, ctx) => {
    const lines: string[] = [
      dim("── Commands ──────────────────────────────────────────────"),
      `${hl("/help")}       ${dim("Show this help")}`,
      `${hl("/clear")}      ${dim("Clear screen")}`,
      `${hl("/model")}      ${dim("Switch model: /model <provider>:<id>")}`,
      `${hl("/tokens")}     ${dim("Show estimated token usage")}`,
      `${hl("/ctx")}        ${dim("Context usage overview")}`,
      `${hl("/ctx compact")} ${dim("Trigger context compression")}`,
      `${hl("/compact")}    ${dim("Compact with instructions: /compact <notes>")}`,
      `${hl("/sessions")}   ${dim("List all sessions")}`,
      `${hl("/session")}    ${dim("Switch session: /session <id>, /session new")}`,
      `${hl("/tree")}       ${dim("Show session tree")}`,
      `${hl("/fork")}       ${dim("Branch from a session entry: /fork <id>")}`,
      `${hl("/exit")}       ${dim("Exit the agent")}`,
      dim("────────────────────────────────────────────────────"),
      `${dim("Model: " + (ctx.config.defaultModel ?? ctx.model.id))}`,
    ];

    const pluginCmds = ctx.pluginRunner.getRegisteredCommands();
    if (pluginCmds.length > 0) {
      lines.push(dim("── Plugin Commands ────────────────────────────────────────"));
      for (const cmd of pluginCmds) {
        lines.push(`${hl("/" + cmd.name)}     ${cmd.description ? dim(cmd.description) : ""}`);
      }
      lines.push(dim("────────────────────────────────────────────────────"));
    }
    console.log(lines.join("\n"));
  },
};
