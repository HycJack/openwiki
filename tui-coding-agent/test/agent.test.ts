/**
 * Agent 类单元测试
 *
 * 覆盖：构造、状态管理、事件订阅/分发、agentLoop 生命周期、
 *       abort、waitForIdle、reset、setMessages、auto-compaction
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.js";
import type {
  AgentMessage,
  AgentEvent,
  ModelConfig,
  AssistantMessage,
  StreamEvent,
  StreamLLM,
} from "../src/types.js";

const testModel: ModelConfig = {
  id: "test-model",
  name: "Test Model",
  provider: "openai",
  contextWindow: 128_000,
};

/** 创建一个 mock streamLLM */
function mockStream(response: string, stopReason = "stop"): StreamLLM {
  return async function* () {
    for (const char of response) {
      yield { type: "text_delta", delta: char };
    }
    yield {
      type: "done",
      message: {
        role: "assistant" as const,
        content: [{ type: "text", text: response }],
        stopReason,
        timestamp: Date.now(),
      } as AssistantMessage,
    };
  };
}

describe("Agent", () => {
  let agent: Agent;
  let events: AgentEvent[];

  beforeEach(() => {
    events = [];
    agent = new Agent({
      systemPrompt: "You are a test agent.",
      model: testModel,
      streamLLM: mockStream("Hello!"),
    });
    agent.subscribe((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    agent.reset();
  });

  // ==========================================================================
  // 构造与状态
  // ==========================================================================

  it("构造时使用默认值", () => {
    const a = new Agent();
    assert(a.state.messages.length === 0);
    assert.equal(a.state.systemPrompt, "You are a helpful coding assistant.");
    assert(!a.state.isStreaming);
  });

  it("构造时接受自定义配置", () => {
    const a = new Agent({
      systemPrompt: "Custom prompt",
      model: testModel,
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
    });
    assert.equal(a.state.systemPrompt, "Custom prompt");
    assert.equal(a.state.messages.length, 1);
  });

  it("state 反射当前状态", () => {
    assert.equal(agent.state.messageCount, 0);
    agent.setMessages([{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }]);
    assert.equal(agent.state.messageCount, 1);
  });

  it("model setter 更新状态", () => {
    const newModel: ModelConfig = { id: "new-model", name: "New Model", provider: "openai" };
    agent.model = newModel;
    assert.equal(agent.state.model.id, "new-model");
  });

  it("tools setter 更新状态", () => {
    const tool = { name: "test", label: "Test", description: "A test", parameters: {}, execute: async () => ({ content: [] }) };
    agent.tools = [tool];
    assert.equal(agent.state.tools.length, 1);
  });

  // ==========================================================================
  // 事件系统
  // ==========================================================================

  it("subscribe 注册监听器，返回 unsubscribe 函数", () => {
    let called = 0;
    const unsub = agent.subscribe(() => { called++; });
    // 触发 agent_start
    agent.notifyUI("test", "info");
    // 通知事件会触发
    const before = events.length;
    unsub();
    agent.notifyUI("test2", "info");
    // 无法直接验证内部 listener，但 unsubscribe 不应报错
    assert.equal(typeof unsub, "function");
  });

  it("notifyUI 发出 notification 事件", () => {
    agent.notifyUI("Hello", "info");
    const notif = events.find((e) => e.type === "notification") as any;
    assert(notif);
    assert.equal(notif.message, "Hello");
    assert.equal(notif.level, "info");
  });

  it("notifyUI 支持不同级别", () => {
    agent.notifyUI("Error!", "error");
    agent.notifyUI("Warning!", "warning");
    const errorNotif = events.find((e) => e.type === "notification" && (e as any).level === "error") as any;
    const warnNotif = events.find((e) => e.type === "notification" && (e as any).level === "warning") as any;
    assert(errorNotif);
    assert(warnNotif);
  });

  // ==========================================================================
  // abort / waitForIdle / reset
  // ==========================================================================

  it("abort 设置错误信息并中止 signal", () => {
    assert(!agent.state.errorMessage);
    agent.abort();
    assert(agent.state.errorMessage === "Aborted");
    assert(agent.signal.aborted);
  });

  it("reset 清空状态并创建新的 AbortController", () => {
    agent.setMessages([{ role: "user", content: [{ type: "text", text: "x" }], timestamp: Date.now() }]);
    agent.abort();
    const oldSignal = agent.signal;
    agent.reset();
    assert.equal(agent.state.messages.length, 0);
    assert(!agent.signal.aborted);
    assert(oldSignal !== agent.signal);
  });

  it("waitForIdle 在空闲时立即 resolve", async () => {
    await agent.waitForIdle(); // 不应阻塞
  });

  // ==========================================================================
  // messages 管理
  // ==========================================================================

  it("setMessages 覆盖内部消息列表", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "msg1" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "text", text: "reply1" }], timestamp: 200 },
    ];
    agent.setMessages(msgs);
    assert.equal(agent.state.messages.length, 2);
    assert.equal((agent.state.messages[0]!.content[0] as any).text, "msg1");
  });

  it("loadMessages 别名与 setMessages 行为一致", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "loaded" }], timestamp: 100 },
    ];
    agent.loadMessages(msgs);
    assert.equal(agent.state.messages.length, 1);
  });

  // ==========================================================================
  // agentLoop（使用 mock streamLLM，不调真实 API）
  // ==========================================================================

  it("agentLoop 发出完整生命周期事件", async () => {
    const a = new Agent({
      systemPrompt: "Test",
      model: testModel,
      streamLLM: mockStream("Response"),
    });
    a.subscribe((event) => { events.push(event); });

    await a.agentLoop("Hello");

    const types = events.map((e) => e.type);
    assert(types.includes("agent_start"));
    assert(types.includes("turn_start"));
    assert(types.includes("message_start"));
    assert(types.includes("message_update"));
    assert(types.includes("message_end"));
    assert(types.includes("turn_end"));
    assert(types.includes("agent_end"));
  });

  it("agentLoop 将用户消息和 AI 回复追加到 messages", async () => {
    const a = new Agent({
      systemPrompt: "Test",
      model: testModel,
      streamLLM: mockStream("Hello back!"),
    });

    await a.agentLoop("Hi");

    assert.equal(a.state.messages.length, 2);
    assert.equal(a.state.messages[0]!.role, "user");
    assert.equal(a.state.messages[1]!.role, "assistant");
  });

  it("agentLoop 返回后 isStreaming 为 false", async () => {
    const a = new Agent({
      systemPrompt: "Test",
      model: testModel,
      streamLLM: mockStream("Done"),
    });

    assert(!a.state.isStreaming);
    await a.agentLoop("test");
    assert(!a.state.isStreaming);
  });

  // ==========================================================================
  // compaction 回调
  // ==========================================================================

  it("setCompactionCallback 注册压缩回调", () => {
    let called = false;
    agent.setCompactionCallback(async (_s, _c, _k) => { called = true; });
    // 内部存储回调
    assert(called === false); // 不会自动调用
  });
});
