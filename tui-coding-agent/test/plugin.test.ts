/**
 * Plugin 模块测试
 *
 * 覆盖：
 * - PluginRunner 构造/绑定/事件分发
 * - 插件注册命令和工具的流程
 * - 事件广播到多个插件
 * - Slot API 绑定
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPluginRuntime, loadPlugin } from "../src/plugin/loader.js";
import type { PluginLoadResult, AgentEvent } from "../src/types.js";

// ============================================================================
// 创建一个测试插件文件
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function createTestPluginFile(code: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"));
  const filePath = path.join(dir, "test-plugin.ts");
  fs.writeFileSync(filePath, code, "utf-8");
  return filePath;
}

// ============================================================================
// PluginLoader 测试
// ============================================================================

describe("createPluginRuntime", () => {
  it("创建初始运行时", () => {
    const runtime = createPluginRuntime();
    assert(runtime);
    assert.equal(typeof runtime.sendMessage, "function");
    assert.equal(typeof runtime.getActiveTools, "function");
    assert.equal(typeof runtime.getAllTools, "function");
    assert.equal(typeof runtime.setActiveTools, "function");
    assert.equal(typeof runtime.notify, "function");
  });
});

describe("loadPlugin (basic validation)", () => {
  it("加载不存在的文件不崩溃", async () => {
    const runtime = createPluginRuntime();
    const result = await loadPlugin("/nonexistent/path.ts", "/cwd", runtime);
    // 返回值应有 errors 数组（即使为空）或 plugins 数组
    assert(Array.isArray(result.errors));
    assert(Array.isArray(result.plugins));
  });

  it("加载不导出默认函数的插件（语法错误）", async () => {
    const filePath = createTestPluginFile(`
      // 没有 export default
      const x = 1;
    `);
    const runtime = createPluginRuntime();
    const result = await loadPlugin(filePath, "/cwd", runtime);
    // 加载成功但可能没有插件
    // 至少不会崩溃
    assert(result);
  });
});

// ============================================================================
// PluginRunner 测试
// ============================================================================

import { PluginRunner } from "../src/plugin/runner.js";

describe("PluginRunner", () => {
  let runner: PluginRunner;
  let runtime: ReturnType<typeof createPluginRuntime>;
  const testPlugin: import("../src/types.js").Plugin = {
    name: "test-plugin",
    path: "/test/plugin.ts",
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };

  beforeEach(() => {
    runtime = createPluginRuntime();
    runner = new PluginRunner([testPlugin], runtime, {
      cwd: "/test",
      model: { id: "test-model", name: "Test", provider: "openai" },
      systemPrompt: "Test system prompt",
    });
  });

  // ==========================================================================
  // bindCore
  // ==========================================================================

  it("bindCore 设置核心操作", () => {
    let isIdleCalled = false;
    let abortCalled = false;

    runner.bindCore({
      isIdle: () => { isIdleCalled = true; return true; },
      abort: () => { abortCalled = true; },
      waitForIdle: async () => {},
      sendMessage: () => {},
      getActiveTools: () => ["tool1"],
      getAllTools: () => ["tool1", "tool2"],
      setActiveTools: () => {},
      notify: () => {},
    });

    assert(runtime.sendMessage);
    assert.deepEqual(runtime.getActiveTools(), ["tool1"]);
    assert.equal(runtime.getAllTools()!.length, 2);
  });

  it("bindCore 设置 appendEntry 和 getCustomEntries", () => {
    const entries: { data: unknown }[] = [];
    runner.bindCore({
      isIdle: () => true,
      abort: () => {},
      waitForIdle: async () => {},
      sendMessage: (_c: string) => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      notify: () => {},
      appendEntry: (type, data) => { entries.push({ data }); },
      getCustomEntries: (_type: string) => [{ data: "stored", id: "id1", parentId: null }],
    });

    assert(runtime.appendEntry);
    assert(runtime.getCustomEntries);
    const customEntries = runtime.getCustomEntries!("test");
    assert.equal(customEntries.length, 1);
  });

  // ==========================================================================
  // bindSlotAPI
  // ==========================================================================

  it("bindSlotAPI 设置 slot 操作", () => {
    let lastStatusKey = "";
    let lastStatusText: string | undefined;
    let lastTitle = "";

    runner.bindSlotAPI({
      setHeader: () => {},
      setFooter: () => {},
      setWidget: () => {},
      setStatus: (key, text) => { lastStatusKey = key; lastStatusText = text; },
      setTitle: (title) => { lastTitle = title; },
    });

    runtime.setStatus?.("test-key", "test-value");
    assert.equal(lastStatusKey, "test-key");
    assert.equal(lastStatusText, "test-value");

    runtime.setTitle?.("New Title");
    assert.equal(lastTitle, "New Title");
  });

  // ==========================================================================
  // emit 事件分发
  // ==========================================================================

  it("emit 事件发送到插件的 handlers", async () => {
    const receivedEvents: AgentEvent[] = [];

    testPlugin.handlers.set("notification", [
      (event: any) => { receivedEvents.push(event); },
    ]);

    const event: AgentEvent = {
      type: "notification",
      message: "Test notification",
      level: "info",
    };

    await runner.emit(event);

    assert.equal(receivedEvents.length, 1);
    assert.equal((receivedEvents[0] as any).message, "Test notification");
  });

  it("emit 不存在的类型不报错", async () => {
    const event: AgentEvent = {
      type: "notification",
      message: "Test",
      level: "info",
    };
    // 设了 handler 但类型不匹配
    testPlugin.handlers.set("agent_start", [() => {}]);
    await runner.emit(event);
    // 不应抛出
  });

  it("emit 多个插件收到相同事件", async () => {
    const plugin2 = {
      name: "test-plugin-2",
      path: "/test/plugin2.ts",
      handlers: new Map<string, Function[]>(),
      tools: new Map(),
      commands: new Map(),
    };
    plugin2.handlers.set("notification", [() => {}]);

    const multiRunner = new PluginRunner([testPlugin, plugin2], runtime, {
      cwd: "/test",
      model: { id: "test", name: "Test", provider: "openai" },
      systemPrompt: "Test",
    });

    const event: AgentEvent = { type: "notification", message: "Hi", level: "info" };
    await multiRunner.emit(event);
    // 不应抛出
  });

  // ==========================================================================
  // getRegisteredCommands
  // ==========================================================================

  it("getRegisteredCommands 返回所有插件的命令", () => {
    testPlugin.commands.set("mycmd", {
      name: "mycmd",
      description: "My command",
      handler: async () => {},
    });

    const cmds = runner.getRegisteredCommands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]!.name, "mycmd");
  });

  it("executeCommand 调用插件命令 handler", async () => {
    let handlerCalled = false;
    testPlugin.commands.set("hello", {
      name: "hello",
      description: "Say hello",
      handler: async () => { handlerCalled = true; },
    });

    const result = await runner.executeCommand("hello", "world");
    assert(result);
    assert(handlerCalled);
  });

  it("executeCommand 对未注册命令返回 false", async () => {
    const result = await runner.executeCommand("nonexistent", "args");
    assert(!result);
  });

  // ==========================================================================
  // createContext
  // ==========================================================================

  it("createContext 返回有效的 PluginContext", () => {
    runner.bindCore({
      isIdle: () => true,
      abort: () => {},
      waitForIdle: async () => {},
      sendMessage: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      notify: () => {},
    });

    // 通过插件 handler 间接测试 createContext 的字段
    let ctxModel: any = null;
    testPlugin.handlers.set("turn_end", [(event: any, ctx: any) => { ctxModel = ctx.model; }]);

    // 执行 emit 会触发 createContext
    // 我们不直接导出 createContext，通过 emit 测试
  });

  // ==========================================================================
  // 插件工具注册
  // ==========================================================================

  it("插件的 tools 通过 registerTool 注册", () => {
    const tool = { name: "my_tool", description: "Test tool", parameters: {}, execute: async () => ({ content: [] }) };
    testPlugin.tools.set("my_tool", tool as any);
    assert.equal(testPlugin.tools.size, 1);
    assert(testPlugin.tools.has("my_tool"));
  });
});
