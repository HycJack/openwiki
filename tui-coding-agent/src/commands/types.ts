/**
 * CLI / 命令模块共享类型
 */

import type { Agent } from "../agent.js";
import type { ChatTUI } from "../tui/index.js";
import type { TCAConfig } from "../config.js";
import type { ModelConfig, AgentTool } from "../types.js";
import type { SessionManager } from "../session-manager.js";
import type { PluginRunner } from "../plugin/index.js";

/** 命令处理上下文 — 所有命令共享 */
export interface CommandCtx {
  agent: Agent;
  chat: ChatTUI;
  config: TCAConfig;
  model: ModelConfig;
  cwd: string;
  allTools: AgentTool[];
  sessionMgr: SessionManager;
  pluginRunner: PluginRunner;
}

/** CLI 参数 */
export interface CliArgs {
  model?: string;
  provider?: string;
  baseURL?: string;
  print?: string;
  plugins?: string[];
  cwd?: string;
  help?: boolean;
}
