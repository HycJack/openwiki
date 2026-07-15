/**
 * 插件运行器 - 管理插件生命周期和事件分发
 *
 * 参考 pi-mono 的 extensions/runner.ts 设计：
 * - bindCore() 绑定核心操作方法
 * - emit() 分发事件到所有插件的处理器
 * - getRegisteredTools() 收集所有插件注册的工具
 * - getRegisteredCommands() 收集所有插件注册的命令
 */

import type { AgentTool, AgentEvent, ModelConfig } from "../types.js";
import type {
  Plugin,
  PluginAPI,
  PluginCommand,
  PluginCommandContext,
  PluginContext,
  PluginLoadResult,
  PluginRuntime,
} from "./types.js";

export interface PluginRunnerOptions {
  cwd: string;
  model?: ModelConfig;
  systemPrompt: string;
}

export class PluginRunner {
  private plugins: Plugin[];
  private runtime: PluginRuntime;
  private cwd: string;
  private model: ModelConfig | undefined;
  private systemPrompt: string;
  private isIdleFn: () => boolean = () => true;
  private abortFn: () => void = () => {};
  private waitForIdleFn: () => Promise<void> = async () => {};
  private sendMessageFn: (content: string) => void = () => {};

  constructor(plugins: Plugin[], runtime: PluginRuntime, options: PluginRunnerOptions) {
    this.plugins = plugins;
    this.runtime = runtime;
    this.cwd = options.cwd;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
  }

  /**
   * 绑定核心操作方法。
   */
  bindCore(actions: {
    isIdle: () => boolean;
    abort: () => void;
    waitForIdle: () => Promise<void>;
    sendMessage: (content: string) => void;
    getActiveTools: () => string[];
    getAllTools: () => string[];
    setActiveTools: (toolNames: string[]) => void;
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  }): void {
    this.isIdleFn = actions.isIdle;
    this.abortFn = actions.abort;
    this.waitForIdleFn = actions.waitForIdle;
    this.sendMessageFn = actions.sendMessage;

    // 替换 runtime 中的 stub 方法
    this.runtime.sendMessage = actions.sendMessage;
    this.runtime.getActiveTools = actions.getActiveTools;
    this.runtime.getAllTools = actions.getAllTools;
    this.runtime.setActiveTools = actions.setActiveTools;
    this.runtime.notify = actions.notify;
  }

  hasHandlers(eventType: string): boolean {
    for (const plugin of this.plugins) {
      const handlers = plugin.handlers.get(eventType);
      if (handlers && handlers.length > 0) return true;
    }
    return false;
  }

  /**
   * 分发事件到所有插件。
   */
  async emit(event: AgentEvent): Promise<void> {
    const eventType = event.type;
    for (const plugin of this.plugins) {
      const handlers = plugin.handlers.get(eventType);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.runtime.notify(`Plugin error in ${plugin.name}: ${message}`, "error");
        }
      }
    }
  }

  /**
   * 分发自定义事件。
   */
  async emitCustom(eventType: string, ...args: unknown[]): Promise<void> {
    for (const plugin of this.plugins) {
      const handlers = plugin.handlers.get(eventType);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          await handler(...args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.runtime.notify(`Plugin error in ${plugin.name}: ${message}`, "error");
        }
      }
    }
  }

  /**
   * 获取所有插件注册的工具（先注册的优先）。
   */
  getRegisteredTools(): AgentTool[] {
    const toolsByName = new Map<string, AgentTool>();
    for (const plugin of this.plugins) {
      for (const tool of plugin.tools.values()) {
        if (!toolsByName.has(tool.name)) {
          toolsByName.set(tool.name, tool);
        }
      }
    }
    return Array.from(toolsByName.values());
  }

  /**
   * 获取所有插件注册的命令。
   */
  getRegisteredCommands(): PluginCommand[] {
    const commandsByName = new Map<string, PluginCommand>();
    for (const plugin of this.plugins) {
      for (const command of plugin.commands.values()) {
        if (!commandsByName.has(command.name)) {
          commandsByName.set(command.name, command);
        }
      }
    }
    return Array.from(commandsByName.values());
  }

  /**
   * 创建插件上下文（用于事件处理）。
   */
  createContext(): PluginContext {
    return {
      cwd: this.cwd,
      model: this.model,
      isIdle: () => this.isIdleFn(),
      abort: () => this.abortFn(),
      getSystemPrompt: () => this.systemPrompt,
    };
  }

  /**
   * 创建命令上下文（用于命令执行）。
   */
  createCommandContext(): PluginCommandContext {
    return {
      ...this.createContext(),
      waitForIdle: () => this.waitForIdleFn(),
      sendMessage: (content) => this.sendMessageFn(content),
    };
  }

  /**
   * 执行插件命令。
   */
  async executeCommand(name: string, args: string): Promise<boolean> {
    for (const plugin of this.plugins) {
      const command = plugin.commands.get(name);
      if (command) {
        try {
          await command.handler(this.createCommandContext(), args);
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.runtime.notify(`Command ${name} failed: ${message}`, "error");
          return true;
        }
      }
    }
    return false;
  }

  getPluginPaths(): string[] {
    return this.plugins.map((p) => p.path);
  }
}

/**
 * 从加载结果创建 PluginRunner。
 */
export function createPluginRunner(
  loadResult: PluginLoadResult,
  runtime: PluginRuntime,
  options: PluginRunnerOptions,
): PluginRunner {
  return new PluginRunner(loadResult.plugins, runtime, options);
}
