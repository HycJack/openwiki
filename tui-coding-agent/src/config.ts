/**
 * Configuration management — ~/.tca/config.json
 *
 * 按工作目录保存和加载用户配置：
 * - 默认 model/provider/apiKey
 * - 用户偏好设置
 * - 插件配置
 *
 * 参考 openwiki/tui-coding-agent 的 config.ts 设计。
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TCAConfig {
  /** 默认模型 ID */
  defaultModel?: string;
  /** 默认 provider */
  defaultProvider?: string;
  /** API base URL */
  baseURL?: string;
  /** 会话切换时自动保存开关 */
  autoSaveSession?: boolean;
  /** 自定义 model 列表（用于 /model 命令切换） */
  models?: Array<{
    id: string;
    provider: string;
    name?: string;
    baseURL?: string;
    apiKey?: string;
  }>;
  /** 启用的插件列表 */
  plugins?: string[];
  /** 启用的工具列表 */
  tools?: string[];
  /** 自定义系统提示 */
  systemPrompt?: string;
}

const CONFIG_PATH = path.join(os.homedir(), ".tca", "config.json");

export async function loadConfig(): Promise<TCAConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(content) as TCAConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(config: TCAConfig): Promise<void> {
  const dir = path.join(os.homedir(), ".tca");
  await mkdir(dir, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

export async function updateConfig(partial: Partial<TCAConfig>): Promise<TCAConfig> {
  const config = await loadConfig();
  Object.assign(config, partial);
  await saveConfig(config);
  return config;
}
