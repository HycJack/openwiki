/**
 * Plugin system entry point
 *
 * 统一的插件系统导出，参考 pi-mono 扩展系统。
 */

export {
  loadPlugin,
  loadPlugins,
  discoverPlugins,
  createPluginRuntime,
  getPluginDir,
  getGlobalPluginDir,
} from "./loader.js";

export {
  PluginRunner,
  createPluginRunner,
} from "./runner.js";

export type { TuiSlotAPI } from "./runner.js";
