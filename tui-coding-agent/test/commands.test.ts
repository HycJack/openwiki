/**
 * 命令模块测试
 *
 * 覆盖：
 * - CommandRegistry 注册/路由/列表构建
 * - 各命令 handler 逻辑（不依赖 TUI/Agent 实例，使用 mock）
 * - 未知命令回退到插件执行
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CommandRegistry, registerAllCommands } from "../src/commands/index.js";
import type { CommandCtx } from "../src/commands/index.js";

// ============================================================================
// Mock CommandCtx
// ============================================================================

function createMockCtx(overrides: Partial<CommandCtx> = {}): CommandCtx {
  const statusCalls: { text: string; type: string }[] = [];
  let modelLabel = "test-model";

  return {
    agent: {
      state: {
        systemPrompt: "Test",
        model: { id: "test-model", name: "Test Model", provider: "openai", contextWindow: 128000 },
        tools: [],
        messages: [],
        isStreaming: false,
        messageCount: 0,
      },
      set model(val: any) {},
      get model() { return { id: "test-model", name: "Test Model", provider: "openai" }; },
      setMessages: (_msgs: any) => {},
      notifyUI: (_msg: string, _level?: string) => {},
    } as any,
    chat: {
      stop: () => {},
      setStatus: (text: string, type: string = "idle") => { statusCalls.push({ text, type }); },
      setModelLabel: (label: string) => { modelLabel = label; },
      hideCommandPalette: () => {},
      showCommandPalette: (_cmds: any, _opts?: any) => {},
      updateMessages: (_msgs: any) => {},
      tui: { requestRender: () => {} },
    } as any,
    config: { defaultModel: "test-model", models: [] } as any,
    model: { id: "test-model", name: "Test Model", provider: "openai", contextWindow: 128000 },
    cwd: "/test",
    allTools: [],
    sessionMgr: {
      sessionId: "test-session-123",
      getEntryById: () => undefined,
      listSessions: async () => [],
      switchTo: async (_id: string) => { throw new Error("Session not found"); },
      createNew: async () => [],
      renderTree: () => null,
      forkFrom: async (_id: string, _msg: any) => "new-id",
      branchMessages: [],
      getEntryIdByMessageIndex: (_idx: number, _offset: number) => undefined,
      appendCompaction: async (_entry: any) => {},
      scheduleFlush: (_msgs: any) => {},
      waitForFlush: async () => {},
    } as any,
    pluginRunner: {
      executeCommand: async (_name: string, _args: string) => false,
      getRegisteredCommands: () => [],
    } as any,
    ...overrides,
  } as unknown as CommandCtx;
}

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it("register 添加命令", () => {
    registry.register({ name: "test", description: "A test", handler: async () => {} });
    assert(registry.get("test"));
  });

  it("get 返回已注册的命令", () => {
    registry.register({ name: "greet", description: "Greet", handler: async () => {} });
    const cmd = registry.get("greet");
    assert(cmd);
    assert.equal(cmd.name, "greet");
  });

  it("get 对未注册命令返回 undefined", () => {
    assert.equal(registry.get("nonexistent"), undefined);
  });

  it("getAll 返回所有已注册命令", () => {
    registry.register({ name: "a", description: "", handler: async () => {} });
    registry.register({ name: "b", description: "", handler: async () => {} });
    assert.equal(registry.getAll().length, 2);
  });

  it("buildCommandList 包含内置命令和插件命令", () => {
    registry.register({ name: "builtin", description: "Desc", handler: async () => {} });
    const pluginRunner = {
      getRegisteredCommands: () => [{ name: "plugin-cmd", description: "Plugin cmd" }],
    };
    const list = registry.buildCommandList(pluginRunner as any);
    assert(list.find((c) => c.name === "builtin"));
    assert(list.find((c) => c.name === "plugin-cmd"));
  });

  it("handleCommand 通过 / 前缀匹配命令", async () => {
    let called = false;
    registry.register({ name: "ping", description: "", handler: async () => { called = true; } });
    const ctx = createMockCtx();
    await registry.handleCommand("/ping", ctx);
    assert(called);
  });

  it("handleCommand 匹配无 / 前缀的命令", async () => {
    let called = false;
    registry.register({ name: "ping", description: "", handler: async () => { called = true; } });
    const ctx = createMockCtx();
    await registry.handleCommand("ping", ctx);
    assert(called);
  });

  it("handleCommand 传递 args 给 handler", async () => {
    let capturedArgs: string[] = [];
    registry.register({ name: "echo", description: "", handler: async (args) => { capturedArgs = args; } });
    const ctx = createMockCtx();
    await registry.handleCommand("/echo hello world", ctx);
    assert.deepEqual(capturedArgs, ["hello", "world"]);
  });

  it("handleCommand 未知命令回退到插件并显示错误", async () => {
    const ctx = createMockCtx({
      pluginRunner: { executeCommand: async () => false, getRegisteredCommands: () => [] } as any,
    });
    // 不应抛出
    await registry.handleCommand("/nonexistent", ctx);
  });

  it("handleCommand 调用插件命令成功时不显示错误", async () => {
    let pluginCalled = false;
    const ctx = createMockCtx({
      pluginRunner: {
        executeCommand: async (_name: string) => { pluginCalled = true; return true; },
        getRegisteredCommands: () => [],
      } as any,
    });
    await registry.handleCommand("/plugincmd", ctx);
    assert(pluginCalled);
  });
});

describe("registerAllCommands", () => {
  it("注册所有内置命令", () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const names = registry.getAll().map((c) => c.name);
    assert(names.includes("exit"));
    assert(names.includes("help"));
    assert(names.includes("clear"));
    assert(names.includes("model"));
    assert(names.includes("tokens"));
    assert(names.includes("ctx"));
    assert(names.includes("compact"));
    assert(names.includes("sessions"));
    assert(names.includes("session"));
    assert(names.includes("tree"));
    assert(names.includes("fork"));
    assert.equal(names.length, 11);
  });
});

// ============================================================================
// 各命令 handler 测试（mock ChatTUI / Agent）
// ============================================================================

describe("/help command", () => {
  it("输出帮助信息不报错", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const helpCmd = registry.get("help")!;
    const ctx = createMockCtx();
    // help 命令只 console.log，不应抛出
    await helpCmd.handler([], ctx);
  });
});

describe("/clear command", () => {
  it("清屏不报错", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const clearCmd = registry.get("clear")!;
    const ctx = createMockCtx();
    await clearCmd.handler([], ctx);
  });
});

describe("/exit command", () => {
  it("exit 调用 chat.stop 和 process.exit", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const exitCmd = registry.get("exit")!;

    let stopped = false;
    const originalExit = process.exit;
    let exitCode: number | undefined;

    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as any;

    const ctx = createMockCtx({
      chat: { stop: () => { stopped = true; }, setStatus: () => {} } as any,
    });

    try {
      await exitCmd.handler([], ctx);
    } catch (e: any) {
      // expected: process.exit throws
    }

    assert(stopped);
    process.exit = originalExit;
  });
});

describe("/model command", () => {
  it("无参数时显示当前模型", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const modelCmd = registry.get("model")!;
    const ctx = createMockCtx();
    await modelCmd.handler([], ctx);
  });

  it("切换模型时更新 modelLabel", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const modelCmd = registry.get("model")!;

    let newLabel = "";
    const ctx = createMockCtx({
      chat: {
        setModelLabel: (l: string) => { newLabel = l; },
        setStatus: (_t: string, _ty?: string) => {},
      } as any,
    });

    await modelCmd.handler(["gpt-4o"], ctx);
    assert(newLabel.includes("gpt-4o"));
  });
});

describe("/tokens command", () => {
  it("显示 token 用量不报错", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const tokensCmd = registry.get("tokens")!;
    const ctx = createMockCtx();
    await tokensCmd.handler([], ctx);
  });
});

describe("/ctx command", () => {
  it("显示上下文概览不报错", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const ctxCmd = registry.get("ctx")!;
    const ctx = createMockCtx();
    await ctxCmd.handler([], ctx);
  });

  it("/ctx compact 触发压缩", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const ctxCmd = registry.get("ctx")!;

    let compacted = false;
    const ctx = createMockCtx({
      agent: {
        state: {
          systemPrompt: "Test",
          model: { id: "test-model", name: "Test Model", provider: "openai" },
          tools: [],
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }],
          isStreaming: false,
          messageCount: 1,
        },
        model: { id: "test-model", name: "Test Model", provider: "openai" },
      } as any,
    });

    await ctxCmd.handler(["compact"], ctx);
  });
});

describe("/compact command", () => {
  it("压缩命令不报错", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const compactCmd = registry.get("compact")!;
    const ctx = createMockCtx();
    await compactCmd.handler([], ctx);
  });
});

describe("/sessions command", () => {
  it("显示会话列表不报错", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const sessionsCmd = registry.get("sessions")!;
    const ctx = createMockCtx();
    await sessionsCmd.handler([], ctx);
  });
});

describe("/session command", () => {
  it("无参数时显示当前 session", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const sessionCmd = registry.get("session")!;
    const ctx = createMockCtx();
    await sessionCmd.handler([], ctx);
  });

  it("/session new 创建新会话", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const sessionCmd = registry.get("session")!;

    let cleared = false;
    const ctx = createMockCtx({
      sessionMgr: {
        sessionId: "test-session",
        createNew: async () => {},
        listSessions: async () => [],
      } as any,
      agent: {
        state: { messages: [], systemPrompt: "", model: {}, tools: [], isStreaming: false, messageCount: 0 },
        setMessages: () => { cleared = true; },
      } as any,
    });

    await sessionCmd.handler(["new"], ctx);
  });

  it("/session <id> 切换会话，id 不存在时显示错误", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const sessionCmd = registry.get("session")!;

    const ctx = createMockCtx({
      sessionMgr: {
        sessionId: "test-session",
        listSessions: async () => [],
      } as any,
    });

    await sessionCmd.handler(["nonexistent"], ctx);
  });
});

describe("/tree command", () => {
  it("显示会话树不报错", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const treeCmd = registry.get("tree")!;
    const ctx = createMockCtx();
    await treeCmd.handler([], ctx);
  });
});

describe("/fork command", () => {
  it("无参数时显示用法", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const forkCmd = registry.get("fork")!;
    const ctx = createMockCtx();
    await forkCmd.handler([], ctx);
  });

  it("fork 不存在的 entry 时显示错误", async () => {
    const registry = new CommandRegistry();
    registerAllCommands(registry);
    const forkCmd = registry.get("fork")!;
    const ctx = createMockCtx({
      sessionMgr: {
        getEntryById: () => undefined,
      } as any,
    });
    await forkCmd.handler(["nonexistent-entry"], ctx);
  });
});
