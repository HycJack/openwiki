/**
 * agent-loop.ts 单元测试
 *
 * 覆盖：runAgentLoop 的上下文压缩触发逻辑、
 *       tool call 执行、steering/follow-up 消息
 *
 * 注意：由于 streamOpenAI 需要 API key，测试使用 mock StreamLLM。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../src/agent-loop.js";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  ModelConfig,
  StreamLLM,
  AgentEvent,
  AssistantMessage,
} from "../src/types.js";

// ============================================================================
// 测试用的 ModelConfig
// ============================================================================
const testModel: ModelConfig = {
  id: "test-model",
  name: "Test Model",
  provider: "openai",
  contextWindow: 128_000,
};

// ============================================================================
// Mock StreamLLM — 简单的回复，不调用 OpenAI
// ============================================================================
function mockStreamLLM(response: string, stopReason = "stop"): StreamLLM {
  return async function* () {
    for (const char of response) {
      yield { type: "text_delta", delta: char };
    }
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: response }],
        stopReason,
        timestamp: Date.now(),
      } as AssistantMessage,
    };
  };
}

/** 默认的 message-to-LLM 转换 */
function defaultConvertToLlm(messages: AgentMessage[]) {
  return messages;
}

function defaultGetSteeringMessages() {
  return Promise.resolve<AgentMessage[]>([]);
}

function defaultGetFollowUpMessages() {
  return Promise.resolve<AgentMessage[]>([]);
}

// ============================================================================
// 测试
// ============================================================================

describe("runAgentLoop", () => {
  let events: AgentEvent[] = [];
  let emitCount = 0;

  beforeEach(() => {
    events = [];
    emitCount = 0;
  });

  function collectEmit(event: AgentEvent) {
    events.push(event);
    emitCount++;
  }

  it("emits agent_start and turn_start events", async () => {
    const context: AgentContext = {
      model: testModel,
      systemPrompt: "You are a helpful assistant.",
      tools: [],
      messages: [],
    };

    const config: AgentLoopConfig = {
      model: testModel,
      streamLLM: mockStreamLLM("Hello!"),
      convertToLlm: defaultConvertToLlm,
      getSteeringMessages: defaultGetSteeringMessages,
      getFollowUpMessages: defaultGetFollowUpMessages,
    };

    const userPrompt: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: Date.now(),
    };

    await runAgentLoop([userPrompt], context, config, collectEmit);

    const eventTypes = events.map((e) => e.type);
    assert(eventTypes.includes("agent_start"));
    assert(eventTypes.includes("turn_start"));
    assert(eventTypes.includes("turn_end"));
  });

  it("runs basic user-turn flow and returns new messages", async () => {
    const context: AgentContext = {
      model: testModel,
      systemPrompt: "Be helpful.",
      tools: [],
      messages: [],
    };

    const config: AgentLoopConfig = {
      model: testModel,
      streamLLM: mockStreamLLM("Sure, I can help with that!"),
      convertToLlm: defaultConvertToLlm,
      getSteeringMessages: defaultGetSteeringMessages,
      getFollowUpMessages: defaultGetFollowUpMessages,
    };

    const userMsg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Can you help me?" }],
      timestamp: Date.now(),
    };

    const newMessages = await runAgentLoop([userMsg], context, config, collectEmit);

    // newMessages 包含用户输入 + AI 回复
    assert.equal(newMessages.length, 2);
    assert.equal(newMessages[0]!.role, "user");
    assert((newMessages[0]!.content[0] as any).text, "Can you help me?");
    assert.equal(newMessages[1]!.role, "assistant");
  });

  it("auto-compacts when context exceeds threshold", async () => {
    // 构造大量上下文消息，使得 estimateContextUsage > limit - reserve
    const longText = "A".repeat(10000); // ~2500 tokens * many messages
    const manyMsgs: AgentMessage[] = [];
    for (let i = 0; i < 80; i++) {
      manyMsgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: longText }],
        timestamp: Date.now() + i * 100,
      } as AgentMessage);
    }

    const context: AgentContext = {
      model: testModel,
      systemPrompt: "You are helpful.",
      tools: [],
      messages: manyMsgs,
    };

    // 使用很小的 contextWindow 来触发压缩
    const smallWindowModel: ModelConfig = {
      id: "small",
      name: "Small Window",
      provider: "openai",
      contextWindow: 40_000,
    };

    const config: AgentLoopConfig = {
      model: smallWindowModel,
      streamLLM: mockStreamLLM("Done"),
      convertToLlm: defaultConvertToLlm,
      getSteeringMessages: defaultGetSteeringMessages,
      getFollowUpMessages: defaultGetFollowUpMessages,
      // 极小的 reserveToken 确保触发
      reserveTokens: 1000,
      keepRecentTokens: 5000,
    };

    const userMsg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: Date.now(),
    };

    const msgsBefore = context.messages.length;
    await runAgentLoop([userMsg], context, config, collectEmit);
    const msgsAfter = context.messages.length;

    // 压缩后消息数应该减少（大量的旧消息被 summary 替换）
    assert(msgsAfter < msgsBefore, `messages should be compacted: ${msgsBefore} -> ${msgsAfter}`);

    // 第一条消息应该是 compaction summary（如果发生了压缩）
    const hasNotification = events.some(
      (e) => e.type === "notification",
    );
    // 可能会压缩也可能不会，取决于 token 估算是否足够触发
    // 至少 context.messages 的 token 总量不应该超过 limit
  });

  it("handles steering messages", async () => {
    let steeringCalled = 0;

    const context: AgentContext = {
      model: testModel,
      systemPrompt: "Be helpful.",
      tools: [],
      messages: [],
    };

    const steeringMsg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "[Steering] Focus on performance" }],
      timestamp: Date.now(),
    };

    const config: AgentLoopConfig = {
      model: testModel,
      streamLLM: mockStreamLLM("OK I'll focus on performance."),
      convertToLlm: defaultConvertToLlm,
      getSteeringMessages: async () => {
        steeringCalled++;
        if (steeringCalled === 1) return [steeringMsg];
        return [];
      },
      getFollowUpMessages: defaultGetFollowUpMessages,
    };

    const userMsg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Help me" }],
      timestamp: Date.now(),
    };

    const newMessages = await runAgentLoop([userMsg], context, config, collectEmit);

    // 检查 steering message 是否包含在 newMessages 中
    const steeringIncluded = newMessages.some(
      (m) => m.role === "user" && (m.content[0] as any).text === "[Steering] Focus on performance",
    );
    assert(steeringIncluded, "steering message should be in new messages");
  });

  it("handles tool execution messages", async () => {
    // 这个测试验证 tool call 后的结果处理
    // 创建一个模拟 LLM，先返回 tool call，再返回文本
    let callCount = 0;

    const toolLLM: StreamLLM = async function* () {
      callCount++;
      if (callCount === 1) {
        // 第一次：返回一个 tool call
        yield {
          type: "tool_call",
          toolCall: {
            id: "tc-1",
            name: "test_tool",
            arguments: '{"input": "hello"}',
          },
        };
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc-1",
                name: "test_tool",
                arguments: '{"input": "hello"}',
              },
            ],
            stopReason: "tool_use",
            timestamp: Date.now(),
          } as AssistantMessage,
        };
      } else {
        // 第二次：工具结果后的回复
        yield { type: "text_delta", delta: "Done with tool" };
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done with tool" }],
            stopReason: "stop",
            timestamp: Date.now(),
          } as AssistantMessage,
        };
      }
    };

    const testTool: AgentTool = {
      name: "test_tool",
      label: "Test Tool",
      description: "A test tool",
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
      execute: async () => ({
        content: [{ type: "text", text: "Tool executed successfully" }],
      }),
    };

    const context: AgentContext = {
      model: testModel,
      systemPrompt: "You have test_tool.",
      tools: [testTool],
      messages: [],
    };

    const config: AgentLoopConfig = {
      model: testModel,
      streamLLM: toolLLM,
      convertToLlm: defaultConvertToLlm,
      getSteeringMessages: defaultGetSteeringMessages,
      getFollowUpMessages: defaultGetFollowUpMessages,
    };

    const userMsg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Use the tool" }],
      timestamp: Date.now(),
    };

    const newMessages = await runAgentLoop([userMsg], context, config, collectEmit);

    // 新消息应该包含：user + assistant(toolCall) + toolResult + assistant(final)
    const toolResults = newMessages.filter(
      (m) => m.role === "toolResult" || (m.role as string) === "toolResult",
    );
    assert(toolResults.length > 0, "should contain tool result messages");

    const assistantsWithToolCall = newMessages.filter(
      (m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"),
    );
    assert(assistantsWithToolCall.length > 0, "should contain assistant message with tool call");
  });
});
