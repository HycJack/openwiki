/**
 * 验证 goal-plugin 能否正常加载
 */
import { loadPlugin, createPluginRuntime } from "../../src/plugin/loader.ts";

const runtime = createPluginRuntime();
const result = await loadPlugin(
  "plugins/goal-plugin.ts",
  process.cwd(),
  runtime,
);

if (result.error) {
  console.error("FAIL:", result.error);
  process.exit(1);
}

const plugin = result.plugin!;
console.log(`name: ${plugin.name}`);
console.log(`tools: ${[...plugin.tools.keys()].join(", ")}`);
console.log(`commands: ${[...plugin.commands.keys()].join(", ")}`);
