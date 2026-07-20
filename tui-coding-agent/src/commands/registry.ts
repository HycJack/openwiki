/**
 * 命令注册表 — 所有内置命令的聚合入口
 *
 * 提供：
 * - 命令名 → 处理函数的映射
 * - 命令列表（用于 TUI 命令面板 + /help）
 * - 命令路由（handleCommand）
 */

import type { PluginRunner } from "../plugin/index.js";
import type { CommandCtx } from "./types.js";

// ============================================================================
// 命令条目
// ============================================================================

export interface CommandEntry {
  name: string;
  description: string;
  handler: (args: string[], ctx: CommandCtx) => void | Promise<void>;
}

// ============================================================================
// 命令注册中心
// ============================================================================

export class CommandRegistry {
  private commands = new Map<string, CommandEntry>();

  register(entry: CommandEntry): void {
    this.commands.set(entry.name, entry);
  }

  get(name: string): CommandEntry | undefined {
    return this.commands.get(name);
  }

  getAll(): CommandEntry[] {
    return Array.from(this.commands.values());
  }

  /** 构建命令面板列表（内置 + 插件） */
  buildCommandList(pluginRunner: PluginRunner): { name: string; description?: string }[] {
    const builtin = this.getAll().map((c) => ({ name: c.name, description: c.description }));
    const pluginCmds = pluginRunner.getRegisteredCommands();
    return [...builtin, ...pluginCmds.map((c) => ({ name: c.name, description: c.description }))];
  }

  /** 处理命令路由 */
  async handleCommand(cmd: string, ctx: CommandCtx): Promise<void> {
    const [name, ...args] = cmd.split(/\s+/);
    const cmdName = name.startsWith("/") ? name.slice(1) : name;

    // 查找内置命令
    const entry = this.commands.get(cmdName);
    if (entry) {
      await entry.handler(args, ctx);
      return;
    }

    // 尝试插件注册的命令
    if (await ctx.pluginRunner.executeCommand(cmdName, args.join(" "))) return;

    ctx.chat.setStatus(`Unknown command: /${cmdName}. Type /help`, "error");
    setTimeout(() => ctx.chat.setStatus("Ready", "idle"), 2000);
  }
}
