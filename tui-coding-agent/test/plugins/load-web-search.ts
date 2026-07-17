/**
 * 验证 web-search 插件能否正常加载
 *
 * 用法：npx tsx test/plugins/load-web-search.ts
 */
import { loadPlugin, createPluginRuntime } from "../../src/plugin/loader.ts";

const runtime = createPluginRuntime();
const result = await loadPlugin(
  "plugins/web-search.ts",
  process.cwd(),
  runtime,
);

if (result.error) {
  console.error("FAIL:", result.error);
  process.exit(1);
}

const plugin = result.plugin!;
console.log("name:", plugin.name);
console.log("tools:", [...plugin.tools.keys()].join(", "));
