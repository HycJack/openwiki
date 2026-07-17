/**
 * Plugin Runner — 事件分发 + Slot API 绑定
 *
 * 参考 pi-mono ExtensionRunner:
 * - 事件分发到所有插件的 handlers
 * - bindSlotAPI() 注入 TUI 操作
 * - createContext() 构建含 ui 的 PluginContext
 * - 支持热重载 (reloadPlugins)
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
  AgentTool, AgentEvent, ModelConfig, WidgetPlacement,
  PluginUIContext, Plugin, PluginCommand, PluginCommandContext,
  PluginContext, PluginLoadResult, PluginRuntime,
} from "../types.js";
import type { ContextUsage } from "../token-estimate.js";

export interface TuiSlotAPI {
  setHeader(content: string[] | undefined, component?: Component): void;
  setFooter(content: string[] | undefined, component?: Component): void;
  setWidget(key: string, content: string[] | undefined, options?: { placement?: WidgetPlacement; component?: Component }): void;
  setStatus(key: string, text: string | undefined): void;
  setTitle(title: string): void;
}

export class PluginRunner {
  private plugins: Plugin[];
  private runtime: PluginRuntime;
  private cwd: string;
  private model: ModelConfig | undefined;
  private systemPrompt: string;
  private isIdleFn = () => true;
  private abortFn = () => {};
  private waitForIdleFn = async () => {};
  private sendMessageFn = (_: string) => {};
  private getContextUsageFn: () => ContextUsage | null = () => null;
  private compactFn: (options?: { instructions?: string }) => void = () => {};
  private getMessageCountFn: () => number = () => 0;
  private slotAPI: TuiSlotAPI | null = null;

  constructor(
    plugins: Plugin[],
    runtime: PluginRuntime,
    options: { cwd: string; model?: ModelConfig; systemPrompt: string },
  ) {
    this.plugins = plugins;
    this.runtime = runtime;
    this.cwd = options.cwd;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
  }

  bindCore(actions: {
    isIdle: () => boolean;
    abort: () => void;
    waitForIdle: () => Promise<void>;
    sendMessage: (c: string) => void;
    getActiveTools: () => string[];
    getAllTools: () => string[];
    setActiveTools: (t: string[]) => void;
    notify: (m: string, t?: "info" | "warning" | "error") => void;
    appendEntry?: (type: string, data: unknown) => void;
    getCustomEntries?: (type: string) => { data: unknown; id: string; parentId: string | null }[];
    getContextUsage?: () => ContextUsage | null;
    compact?: (options?: { instructions?: string }) => void;
    getMessageCount?: () => number;
  }): void {
    this.isIdleFn = actions.isIdle;
    this.abortFn = actions.abort;
    this.waitForIdleFn = actions.waitForIdle;
    this.sendMessageFn = actions.sendMessage;
    this.runtime.sendMessage = actions.sendMessage;
    this.runtime.getActiveTools = actions.getActiveTools;
    this.runtime.getAllTools = actions.getAllTools;
    this.runtime.setActiveTools = actions.setActiveTools;
    this.runtime.notify = actions.notify;
    if (actions.appendEntry) this.runtime.appendEntry = actions.appendEntry;
    if (actions.getCustomEntries) this.runtime.getCustomEntries = actions.getCustomEntries;
    if (actions.getContextUsage) this.getContextUsageFn = actions.getContextUsage;
    if (actions.compact) this.compactFn = actions.compact;
    if (actions.getMessageCount) this.getMessageCountFn = actions.getMessageCount;
  }

  bindSlotAPI(slotAPI: TuiSlotAPI): void {
    this.slotAPI = slotAPI;
    this.runtime.setStatus = (k, t) => slotAPI.setStatus(k, t);
    this.runtime.setWidget = (k, c, o) => slotAPI.setWidget(k, c, o);
    this.runtime.setHeader = (c, co) => slotAPI.setHeader(c, co);
    this.runtime.setFooter = (c, co) => slotAPI.setFooter(c, co);
    this.runtime.setTitle = (t) => slotAPI.setTitle(t);
  }

  /** Emit an agent lifecycle event to all plugins */
  async emit(event: AgentEvent): Promise<void> {
    const ctx = this.createContext();
    for (const plugin of this.plugins) {
      const handlers = plugin.handlers.get(event.type);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          await handler(event, ctx);
        } catch (err) {
          this.runtime.notify(
            `Plugin error in ${plugin.name}: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      }
    }
  }

  /** Emit a custom event (non-AgentEvent) to all plugins */
  async emitCustom(eventType: string, ...args: unknown[]): Promise<void> {
    const ctx = this.createContext();
    for (const plugin of this.plugins) {
      const handlers = plugin.handlers.get(eventType);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          await handler(...args, ctx);
        } catch (err) {
          this.runtime.notify(
            `Plugin error in ${plugin.name}: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      }
    }
  }

  /** Get all unique tools registered by plugins */
  getRegisteredTools(): AgentTool[] {
    const byName = new Map<string, AgentTool>();
    for (const p of this.plugins) {
      for (const t of p.tools.values()) {
        if (!byName.has(t.name)) byName.set(t.name, t);
      }
    }
    return Array.from(byName.values());
  }

  /** Get all unique commands registered by plugins */
  getRegisteredCommands(): PluginCommand[] {
    const byName = new Map<string, PluginCommand>();
    for (const p of this.plugins) {
      for (const c of p.commands.values()) {
        if (!byName.has(c.name)) byName.set(c.name, c);
      }
    }
    return Array.from(byName.values());
  }

  /** Create a PluginContext for event handlers */
  createContext(): PluginContext {
    const ui: PluginUIContext = {
      notify: (m, t) => this.runtime.notify(m, t),
      setStatus: (k, t) => this.runtime.setStatus?.(k, t),
      setWidget: (k, c, o) => this.runtime.setWidget?.(k, c, o),
      setHeader: (c, co) => this.runtime.setHeader?.(c, co),
      setFooter: (c, co) => this.runtime.setFooter?.(c, co),
      setTitle: (t) => this.runtime.setTitle?.(t),
    };

    return {
      cwd: this.cwd,
      model: this.model,
      isIdle: () => this.isIdleFn(),
      abort: () => this.abortFn(),
      getSystemPrompt: () => this.systemPrompt,
      getContextUsage: () => this.getContextUsageFn(),
      compact: (options) => this.compactFn(options),
      getMessageCount: () => this.getMessageCountFn(),
      ui,
    };
  }

  /** Create a PluginCommandContext for command handlers */
  createCommandContext(): PluginCommandContext {
    const base = this.createContext();
    return {
      ...base,
      waitForIdle: () => this.waitForIdleFn(),
      sendMessage: (c) => this.sendMessageFn(c),
      notify: (m, t) => this.runtime.notify(m, t),
    };
  }

  /** Execute a registered command by name */
  async executeCommand(name: string, args: string): Promise<boolean> {
    for (const plugin of this.plugins) {
      const cmd = plugin.commands.get(name);
      if (cmd) {
        try {
          await cmd.handler(this.createCommandContext(), args);
          return true;
        } catch (err) {
          this.runtime.notify(`Command ${name} failed: ${err}`, "error");
          return true;
        }
      }
    }
    return false;
  }

  getPluginPaths(): string[] {
    return this.plugins.map((p) => p.path);
  }

  reloadPlugins(newPlugins: Plugin[]): void {
    this.plugins = newPlugins.slice();
  }
}

export function createPluginRunner(
  loadResult: PluginLoadResult,
  runtime: PluginRuntime,
  options: { cwd: string; model?: ModelConfig; systemPrompt: string },
): PluginRunner {
  return new PluginRunner(loadResult.plugins, runtime, options);
}
