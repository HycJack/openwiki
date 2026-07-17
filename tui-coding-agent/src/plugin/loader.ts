import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import type { Plugin, ExtensionAPI, PluginFactory, PluginLoadResult, PluginRuntime, PluginCommandContext, PluginUIContext } from "../types.js";

export function createPluginRuntime(): PluginRuntime {
  const ni = () => { throw new Error("Runtime not initialized"); };
  return { sendMessage: ni, getActiveTools: ni, getAllTools: ni, setActiveTools: ni, notify: () => {} };
}

function createExtensionAPI(plugin: Plugin, runtime: PluginRuntime, cwd: string): ExtensionAPI {
  const ui: PluginUIContext = {
    notify: (m, t) => runtime.notify(m, t),
    setStatus: (k, t) => runtime.setStatus?.(k, t),
    setWidget: (k, c, o) => runtime.setWidget?.(k, c, o),
    setHeader: (c, co) => runtime.setHeader?.(c, co),
    setFooter: (c, co) => runtime.setFooter?.(c, co),
    setTitle: (t) => runtime.setTitle?.(t),
  };

  return {
    on(event, handler) {
      const list = plugin.handlers.get(event) ?? [];
      list.push(handler);
      plugin.handlers.set(event, list);
    },
    registerTool(tool) { plugin.tools.set(tool.name, tool); },
    registerCommand(name, handler, description) {
      plugin.commands.set(name, {
        name,
        description,
        handler: async (ctx: PluginCommandContext, args: string) => {
          await handler(ctx, args);
        },
      });
    },
    notify: (m, t) => runtime.notify(m, t),
    exec(command, args, execCwd) {
      return new Promise((resolve) => {
        const child = execFile(command, args, {
          cwd: execCwd ?? cwd,
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
        }, (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error ? (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? 124 : 1 : 0,
          });
        });
        child.on("error", () => {});
      });
    },
    getActiveTools: () => runtime.getActiveTools(),
    setActiveTools: (t) => runtime.setActiveTools(t),
    appendEntry: (type, data) => runtime.appendEntry?.(type, data),
    getCustomEntries: (type) => runtime.getCustomEntries?.(type) ?? [],
    get ui() { return ui; },
  };
}

function createPlugin(pluginPath: string): Plugin {
  return {
    name: path.basename(pluginPath, path.extname(pluginPath)),
    path: pluginPath,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
}

async function ensurePluginDeps(dirPath: string): Promise<void> {
  const pkgPath = path.join(dirPath, "package.json");
  if (!fs.existsSync(pkgPath) || fs.existsSync(path.join(dirPath, "node_modules"))) return;
  try {
    const { execSync } = await import("node:child_process");
    execSync("npm install --no-audit --no-fund", { cwd: dirPath, stdio: "ignore", timeout: 120_000 });
  } catch {
    // skip dependency installation errors
  }
}

export async function loadPlugin(
  pluginPath: string,
  cwd: string,
  runtime: PluginRuntime,
): Promise<{ plugin: Plugin | null; error: string | null }> {
  try {
    // Windows: URL.pathname 可能以 \ 开头（如 \C:\Users\...），规范化
    const normalCwd = path.win32 ? cwd.replace(/^\\[a-zA-Z]:/, (m) => m.slice(1)) : cwd;
    const resolvedPath = path.resolve(normalCwd, pluginPath);
    const fileUrl = pathToFileURL(resolvedPath).href;
    await ensurePluginDeps(path.dirname(resolvedPath));

    const module = await import(fileUrl);
    const factory = (module.default ?? module) as PluginFactory;
    if (typeof factory !== "function") {
      return { plugin: null, error: `Plugin does not export a factory function: ${pluginPath}` };
    }

    const plugin = createPlugin(resolvedPath);
    const api = createExtensionAPI(plugin, runtime, cwd);
    const result = factory(api);

    // Support async factories (pi-mono style)
    if (result && typeof result === "object" && "then" in result) {
      await result;
    }

    return { plugin, error: null };
  } catch (err) {
    return { plugin: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function discoverPlugins(pluginDir: string): string[] {
  if (!fs.existsSync(pluginDir)) return [];
  const discovered: string[] = [];
  try {
    for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
      const entryPath = path.join(pluginDir, entry.name);
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        discovered.push(entryPath);
      } else if (entry.isDirectory()) {
        // Check for index.ts or index.js in subdirectory
        for (const f of ["index.ts", "index.js"]) {
          const fp = path.join(entryPath, f);
          if (fs.existsSync(fp)) {
            discovered.push(fp);
            break;
          }
        }
      }
    }
  } catch {
    return [];
  }
  return discovered;
}

export async function loadPlugins(
  paths: string[],
  cwd: string,
  runtime: PluginRuntime,
): Promise<PluginLoadResult> {
  const plugins: Plugin[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const p of paths) {
    const { plugin, error } = await loadPlugin(p, cwd, runtime);
    if (error) {
      errors.push({ path: p, error });
    } else if (plugin) {
      plugins.push(plugin);
    }
  }

  return { plugins, errors };
}

export function getPluginDir(cwd: string): string {
  return path.join(cwd, ".tca", "plugins");
}

export function getGlobalPluginDir(): string {
  return path.join(os.homedir(), ".tca", "plugins");
}
