/**
 * 插件加载器
 *
 * 参考 pi-mono 的 extensions/loader.ts 设计：
 * - 使用 dynamic import 加载 TypeScript/JavaScript 插件模块
 * - 从标准位置自动发现插件（.tca/plugins/ 目录）
 * - 支持项目级和全局级插件
 *
 * 简化版：使用 tsx 的 require 机制或 Node.js 的 import() 加载 .js 文件。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import type { Plugin, PluginAPI, PluginFactory, PluginLoadResult, PluginRuntime } from "./types.js";

/**
 * 创建插件运行时（初始为 stub，由 runner.bindCore 替换）。
 */
export function createPluginRuntime(): PluginRuntime {
  const notInit = () => {
    throw new Error("Plugin runtime not initialized. Action methods cannot be called during plugin loading.");
  };
  return {
    sendMessage: notInit,
    getActiveTools: notInit,
    getAllTools: notInit,
    setActiveTools: notInit,
    notify: () => {},
  };
}

/**
 * 创建 PluginAPI，将注册方法绑定到 Plugin 对象。
 */
function createPluginAPI(
  plugin: Plugin,
  runtime: PluginRuntime,
  cwd: string,
): PluginAPI {
  return {
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      const list = plugin.handlers.get(event) ?? [];
      list.push(handler);
      plugin.handlers.set(event, list);
    },

    registerTool(tool): void {
      plugin.tools.set(tool.name, tool);
    },

    registerCommand(name, handler): void {
      plugin.commands.set(name, { name, handler });
    },

    notify(message, type): void {
      runtime.notify(message, type);
    },

    exec(command, args, execCwd): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      return new Promise((resolve) => {
        const child = execFile(
          command,
          args,
          { cwd: execCwd ?? cwd, maxBuffer: 1024 * 1024, timeout: 30_000 },
          (error, stdout, stderr) => {
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: typeof error?.code === "number" ? error.code : (error ? 1 : 0),
            });
          },
        );
        child.on("error", () => { /* handled by callback */ });
      });
    },

    getActiveTools(): string[] {
      return runtime.getActiveTools();
    },

    setActiveTools(toolNames): void {
      runtime.setActiveTools(toolNames);
    },
  };
}

/**
 * 创建空的 Plugin 对象。
 */
function createPlugin(pluginPath: string): Plugin {
  return {
    name: path.basename(pluginPath, path.extname(pluginPath)),
    path: pluginPath,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
}

/**
 * 加载单个插件模块。
 */
export async function loadPlugin(
  pluginPath: string,
  cwd: string,
  runtime: PluginRuntime,
): Promise<{ plugin: Plugin | null; error: string | null }> {
  try {
    const resolvedPath = path.resolve(cwd, pluginPath);
    const fileUrl = pathToFileURL(resolvedPath).href;

    // 动态导入模块
    const module = await import(fileUrl);
    const factory = (module.default ?? module) as PluginFactory;

    if (typeof factory !== "function") {
      return { plugin: null, error: `Plugin does not export a valid factory function: ${pluginPath}` };
    }

    const plugin = createPlugin(resolvedPath);
    const api = createPluginAPI(plugin, runtime, cwd);
    await factory(api);

    return { plugin, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { plugin: null, error: `Failed to load plugin: ${message}` };
  }
}

/**
 * 从目录发现插件文件。
 *
 * 发现规则：
 * 1. 直接文件：.tca/plugins/ 下的 .ts 或 .js 文件
 * 2. 子目录：.tca/plugins/子目录/ 下的 index.ts 或 index.js
 */
export function discoverPlugins(pluginDir: string): string[] {
  if (!fs.existsSync(pluginDir)) return [];

  const discovered: string[] = [];
  try {
    const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(pluginDir, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        discovered.push(entryPath);
      } else if (entry.isDirectory()) {
        const indexTs = path.join(entryPath, "index.ts");
        const indexJs = path.join(entryPath, "index.js");
        if (fs.existsSync(indexTs)) {
          discovered.push(indexTs);
        } else if (fs.existsSync(indexJs)) {
          discovered.push(indexJs);
        }
      }
    }
  } catch {
    return [];
  }
  return discovered;
}

/**
 * 加载多个插件。
 */
export async function loadPlugins(
  paths: string[],
  cwd: string,
  runtime: PluginRuntime,
): Promise<PluginLoadResult> {
  const plugins: Plugin[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const pluginPath of paths) {
    const { plugin, error } = await loadPlugin(pluginPath, cwd, runtime);
    if (error) {
      errors.push({ path: pluginPath, error });
      continue;
    }
    if (plugin) plugins.push(plugin);
  }

  return { plugins, errors };
}

/**
 * 获取插件目录路径。
 */
export function getPluginDir(cwd: string): string {
  return path.join(cwd, ".tca", "plugins");
}

/**
 * 获取全局插件目录。
 */
export function getGlobalPluginDir(): string {
  return path.join(os.homedir(), ".tca", "plugins");
}
