/**
 * /session, /sessions, /tree, /fork — 会话管理命令
 */

import type { CommandEntry } from "./registry.js";
import type { AgentMessage } from "../types.js";

// ============================================================================
// /sessions — 列出所有会话
// ============================================================================

export const sessionsCommand: CommandEntry = {
  name: "sessions",
  description: "List all sessions",
  handler: async (_args, ctx) => {
    const sessions = await ctx.sessionMgr.listSessions();
    if (sessions.length === 0) {
      console.log(`\x1b[90mNo sessions found.\x1b[0m`);
      return;
    }

    const marker = (id: string) =>
      id === ctx.sessionMgr.sessionId ? "\x1b[33m*\x1b[0m " : "  ";

    console.log(`\x1b[90m── Sessions ────────────────────────────\x1b[0m`);
    for (const s of sessions) {
      const name = s.meta.id.slice(0, 12);
      const date = s.meta.createdAt
        ? new Date(s.meta.createdAt).toLocaleDateString()
        : "?";

      console.log(
        `${marker(s.meta.id)}\x1b[33m${name}\x1b[0m  \x1b[90m${date}  ${s.meta.messageCount} msgs\x1b[0m`,
      );
    }
  },
};

// ============================================================================
// /session — 切换 / 创建会话
// ============================================================================

export const sessionCommand: CommandEntry = {
  name: "session",
  description: "Switch session: /session <id> | new",
  handler: async (args, ctx) => {
    const sub = args[0];

    if (!sub) {
      console.log(`Current session: \x1b[33m${ctx.sessionMgr.sessionId.slice(0, 12)}\x1b[0m`);
      return;
    }

    if (sub === "new") {
      await ctx.sessionMgr.createNew();
      ctx.agent.setMessages([]);
      ctx.chat.setStatus("New session created", "idle");
      ctx.chat.updateMessages([]);
      console.log(`\x1b[90mSession context cleared.\x1b[0m`);
      return;
    }

    // 查找 session（支持部分匹配）
    const sessions = await ctx.sessionMgr.listSessions();
    const target = sessions.find((s) => s.meta.id.startsWith(sub));
    if (!target) {
      ctx.chat.setStatus(`Session not found: ${sub}`, "error");
      setTimeout(() => ctx.chat.setStatus("Ready", "idle"), 2000);
      return;
    }

    const messages = await ctx.sessionMgr.switchTo(target.meta.id);
    ctx.agent.setMessages(messages);
    ctx.chat.updateMessages(messages);
    ctx.chat.setStatus(
      `Switched to session ${target.meta.id.slice(0, 12)} (${messages.length} msgs)`,
      "idle",
    );
  },
};

// ============================================================================
// /tree — 显示会话树
// ============================================================================

export const treeCommand: CommandEntry = {
  name: "tree",
  description: "Show session tree",
  handler: async (_args, ctx) => {
    const tree = ctx.sessionMgr.renderTree();
    if (!tree) {
      console.log(`\x1b[90mSession is empty.\x1b[0m`);
      return;
    }
    console.log(`\x1b[90m── Session tree ─────────────────────────\x1b[0m`);
    console.log(tree);
  },
};

// ============================================================================
// /fork — 从某个条目分支
// ============================================================================

export const forkCommand: CommandEntry = {
  name: "fork",
  description: "Fork session: /fork <entry-id>",
  handler: async (args, ctx) => {
    if (!args[0]) {
      console.log(`\x1b[33mUsage: /fork <entry-id>\x1b[0m`);
      return;
    }

    const entryId = args[0];
    const entry = ctx.sessionMgr.getEntryById(entryId);
    if (!entry) {
      console.log(`\x1b[91mEntry not found: ${entryId}\x1b[0m`);
      return;
    }

    ctx.chat.setStatus(`Forking from ${entryId.slice(0, 8)}...`, "streaming");

    const branchNote = args.slice(1).join(" ") || "fork branch";
    const forkMsg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: `[Fork: ${branchNote}] Continue from here` }],
      timestamp: Date.now(),
    };

    await ctx.sessionMgr.forkFrom(entryId, forkMsg);

    const messages = ctx.sessionMgr.branchMessages;
    ctx.agent.setMessages(messages);
    ctx.chat.updateMessages(messages);
    ctx.chat.setStatus(
      `Forked from ${entryId.slice(0, 8)} (session: ${ctx.sessionMgr.sessionId.slice(0, 12)})`,
      "idle",
    );
  },
};
