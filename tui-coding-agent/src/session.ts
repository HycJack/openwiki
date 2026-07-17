/**
 * AgentSession — high-level session management (pi-mono AgentSession style)
 *
 * 管理 agent 生命周期、插件绑定、事件分发。
 * 参考 pi-mono's AgentSession / createAgentSession 设计。
 */

import { Agent } from "./agent.js";
import { createPluginRunner, type PluginRunner } from "./plugin/runner.js";
import type { AgentEvent, AgentMessage, AgentSession as IAgentSession, AgentTool, ModelConfig, Plugin, PluginCommand, PluginRuntime } from "./types.js";

export interface AgentSessionOptions {
  cwd?: string;
  model?: ModelConfig;
  systemPrompt?: string;
  tools?: AgentTool[];
}

export class AgentSession implements IAgentSession {
  readonly agent: Agent;
  private _plugins: Plugin[] = [];
  private _runtime: PluginRuntime;
  private _pluginRunner: PluginRunner | null = null;
  private _cwd: string;
  private _listeners = new Set<(event: AgentEvent) => void>();
  private _unsubscribe: (() => void) | null = null;

  constructor(options: AgentSessionOptions = {}) {
    this._cwd = options.cwd ?? process.cwd();
    this.agent = new Agent({
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools,
    });

    // Create default runtime (will be overridden by bindPlugins)
    this._runtime = this.createDefaultRuntime();

    // Wire agent events to session listeners + plugin runner
    this._unsubscribe = this.agent.subscribe((event, _signal) => {
      this.dispatch(event);
      this._pluginRunner?.emit(event).catch(() => {});
    });
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  async prompt(text: string): Promise<void> {
    await this.agent.agentLoop(text);
  }

  abort(): void {
    this.agent.abort();
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Bind plugins to the session — distributes them to the PluginRunner */
  bindPlugins(plugins: Plugin[]): void {
    this._plugins = plugins.slice();
    this._pluginRunner = createPluginRunner(
      { plugins: this._plugins, errors: [] },
      this._runtime,
      {
        cwd: this._cwd,
        model: this.agent.state.model,
        systemPrompt: this.agent.state.systemPrompt,
      },
    );
    // 绑定 core actions 到 agent
    const agent = this.agent;
    this._pluginRunner.bindCore({
      isIdle: () => !agent.state.isStreaming,
      abort: () => agent.abort(),
      waitForIdle: () => agent.waitForIdle(),
      sendMessage: async (c) => {
        await agent.waitForIdle();
        agent.agentLoop(c).catch(() => {});
      },
      getActiveTools: () => agent.state.tools.map((t) => t.name),
      getAllTools: () => agent.state.tools.map((t) => t.name),
      setActiveTools: (names) => {
        agent.tools = agent.state.tools.filter((t) => names.includes(t.name));
      },
      notify: (m, t) => {
        console.log(`[${t ?? "info"}] ${m}`);
      },
    });
  }

  /** Get the plugin runtime for wiring */
  getRuntime(): PluginRuntime {
    return this._runtime;
  }

  /** Get registered commands from all plugins */
  getCommands(): PluginCommand[] {
    const byName = new Map<string, PluginCommand>();
    for (const p of this._plugins) {
      for (const cmd of p.commands.values()) {
        if (!byName.has(cmd.name)) byName.set(cmd.name, cmd);
      }
    }
    return Array.from(byName.values());
  }

  /** Get registered tools from all plugins */
  getPluginTools(): AgentTool[] {
    const byName = new Map<string, AgentTool>();
    for (const p of this._plugins) {
      for (const t of p.tools.values()) {
        if (!byName.has(t.name)) byName.set(t.name, t);
      }
    }
    return Array.from(byName.values());
  }

  dispose(): void {
    this._unsubscribe?.();
    this._listeners.clear();
    this._plugins = [];
    this._pluginRunner = null;
  }

  // ============================================================================
  // Private
  // ============================================================================

  private dispatch(event: AgentEvent): void {
    for (const listener of this._listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  private createDefaultRuntime(): PluginRuntime {
    const ni = () => { throw new Error("Runtime not initialized. Call bindPlugins() first."); };
    return {
      sendMessage: (text: string) => { this.prompt(text).catch(() => {}); },
      getActiveTools: ni,
      getAllTools: ni,
      setActiveTools: ni,
      notify: () => {},
    };
  }
}

/** Factory function — pi-mono createAgentSession equivalent */
export function createAgentSession(options: AgentSessionOptions = {}): AgentSession {
  return new AgentSession(options);
}
