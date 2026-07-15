/**
 * Agent Loop - LLM 调用和工具执行的核心循环
 *
 * 参考 pi-mono 的 runLoop 设计：
 * - 外层循环：follow-up 消息
 * - 内层循环：LLM 响应 + 工具调用 + steering 消息
 *
 * 参考 openwiki 的 streamEvents 模式，通过 emit 回调推送事件。
 */

import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
  AgentToolResult,
  ContentBlock,
  TextContent,
  ToolCallContent,
  ToolResultContent,
} from "./types.js";
import { streamOpenAI } from "./providers/openai.js";

export type EventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 启动 agent loop，处理用户输入消息。
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit);
  return newMessages;
}

/**
 * 从当前上下文继续（不添加新消息），用于重试。
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  const lastMsg = context.messages[context.messages.length - 1];
  if (lastMsg.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await runLoop({ ...context }, newMessages, config, signal, emit);
  return newMessages;
}

/**
 * 主循环逻辑。
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: EventSink,
): Promise<void> {
  let currentContext = initialContext;
  let firstTurn = true;
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // 注入 pending 消息
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // 流式获取 assistant 响应
      const message = await streamAssistantResponse(currentContext, config, signal, emit);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // 检查工具调用
      const toolCalls = message.content.filter(
        (c): c is ToolCallContent => c.type === "toolCall",
      );

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        const executedBatch = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit,
        );
        toolResults.push(...executedBatch.messages);
        hasMoreToolCalls = !executedBatch.terminate;

        for (const result of toolResults) {
          await emit({ type: "message_start", message: result });
          await emit({ type: "message_end", message: result });
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      if (signal?.aborted) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) ?? [];
    }

    // 检查 follow-up 消息
    const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 流式获取 LLM 响应。
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: EventSink,
): Promise<AssistantMessage> {
  // 应用上下文变换
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // 转换为 LLM 消息
  const llmMessages = await config.convertToLlm(messages);

  // 构建工具描述
  const toolDescriptors = (context.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // 解析 API key
  const apiKey = config.getApiKey
    ? await config.getApiKey(config.model.provider)
    : config.model.apiKey;

  // 调用 LLM
  const stream = config.streamLLM
    ? config.streamLLM(
        config.model,
        llmMessages,
        context.systemPrompt,
        toolDescriptors,
        { signal, apiKey },
      )
    : streamOpenAI(
        config.model,
        llmMessages,
        context.systemPrompt,
        toolDescriptors,
        { signal, apiKey },
      );

  const contentBlocks: ContentBlock[] = [];
  let textBuffer = "";
  let stopReason: AssistantMessage["stopReason"] = "stop";
  let errorMessage: string | undefined;
  let usage = { input: 0, output: 0, totalTokens: 0 };

  // 创建 partial message 并发送 message_start
  const partialMessage: AssistantMessage = {
    role: "assistant",
    content: [],
    model: config.model.id,
    provider: config.model.provider,
    stopReason: undefined,
    timestamp: Date.now(),
  };

  await emit({ type: "message_start", message: { ...partialMessage } });

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        textBuffer += event.delta;
        partialMessage.content = [{ type: "text", text: textBuffer }];
        await emit({
          type: "message_update",
          message: { ...partialMessage },
          delta: event.delta ?? "",
        });
        break;

      case "reasoning_delta":
        // thinking/reasoning 内容：累积但不参与最终消息 content
        partialMessage.reasoning = (partialMessage.reasoning ?? "") + event.delta;
        await emit({
          type: "message_update",
          message: { ...partialMessage },
          delta: "",
        });
        break;

      case "tool_call":
        if (event.toolCall) {
          // 先保存当前文本块
          if (textBuffer) {
            contentBlocks.push({ type: "text", text: textBuffer });
            textBuffer = "";
          }
          contentBlocks.push({
            type: "toolCall",
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          });
          partialMessage.content = [...contentBlocks];
          await emit({ type: "message_update", message: { ...partialMessage }, delta: "" });
        }
        break;

      case "done":
        if (event.usage) {
          usage = event.usage;
        }
        break;

      case "error":
        stopReason = "error";
        errorMessage = event.error;
        break;
    }
  }

  // 最终化消息
  if (textBuffer) {
    contentBlocks.push({ type: "text", text: textBuffer });
  }

  // 如果有 tool_call 事件但没有 error，设置 stopReason
  if (contentBlocks.some((c) => c.type === "toolCall") && stopReason !== "error") {
    stopReason = "tool_use";
  }

  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
    model: config.model.id,
    provider: config.model.provider,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
    usage,
  };

  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

// ============================================================================
// 工具执行
// ============================================================================

interface ExecutedToolBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: EventSink,
): Promise<ExecutedToolBatch> {
  const toolCalls = assistantMessage.content.filter(
    (c): c is ToolCallContent => c.type === "toolCall",
  );

  // 检查是否有 sequential 工具
  const hasSequential = toolCalls.some((tc) => {
    const tool = currentContext.tools?.find((t) => t.name === tc.name);
    return tool?.executionMode === "sequential";
  });

  if (config.toolExecution === "sequential" || hasSequential) {
    return executeSequential(currentContext, toolCalls, config, signal, emit);
  }
  return executeParallel(currentContext, toolCalls, config, signal, emit);
}

async function executeSequential(
  context: AgentContext,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: EventSink,
): Promise<ExecutedToolBatch> {
  const messages: ToolResultMessage[] = [];
  let terminate = false;

  for (const toolCall of toolCalls) {
    const result = await executeSingleToolCall(context, toolCall, config, signal, emit);
    messages.push(result.message);
    if (result.terminate) { terminate = true; break; }
    if (signal?.aborted) break;
  }

  return { messages, terminate };
}

async function executeParallel(
  context: AgentContext,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: EventSink,
): Promise<ExecutedToolBatch> {
  const results = await Promise.all(
    toolCalls.map((tc) => executeSingleToolCall(context, tc, config, signal, emit)),
  );

  const messages: ToolResultMessage[] = results.map((r) => r.message);
  const terminate = results.some((r) => r.terminate);

  return { messages, terminate };
}

async function executeSingleToolCall(
  context: AgentContext,
  toolCall: ToolCallContent,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: EventSink,
): Promise<{ message: ToolResultMessage; terminate: boolean }> {
  await emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });

  const tool = context.tools?.find((t) => t.name === toolCall.name);

  if (!tool) {
    const errorMsg: ToolResultContent = {
      type: "toolResult",
      toolCallId: toolCall.id,
      content: [{ type: "text", text: `Tool not found: ${toolCall.name}` }],
      isError: true,
    };
    await emit({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: errorMsg,
      isError: true,
    });
    return {
      message: { role: "toolResult", content: [errorMsg], timestamp: Date.now() },
      terminate: false,
    };
  }

  // beforeToolCall 钩子
  if (config.beforeToolCall) {
    const beforeResult = await config.beforeToolCall(
      { toolCall, args: toolCall.arguments, context },
      signal,
    );
    if (beforeResult?.block) {
      const errorMsg: ToolResultContent = {
        type: "toolResult",
        toolCallId: toolCall.id,
        content: [{ type: "text", text: beforeResult.reason ?? "Tool execution blocked" }],
        isError: true,
      };
      await emit({
        type: "tool_execution_end",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: errorMsg,
        isError: true,
      });
      return {
        message: { role: "toolResult", content: [errorMsg], timestamp: Date.now() },
        terminate: false,
      };
    }
  }

  // 执行工具
  let result: AgentToolResult;
  let isError = false;

  try {
    result = await tool.execute(toolCall.id, toolCall.arguments, signal, (partial) => {
      emit({
        type: "tool_execution_update",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        partialResult: partial,
      });
    });
  } catch (error) {
    isError = true;
    result = {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }

  // afterToolCall 钩子
  if (config.afterToolCall) {
    const afterResult = await config.afterToolCall(
      { toolCall, args: toolCall.arguments, result, isError, context },
      signal,
    );
    if (afterResult) {
      result = {
        ...result,
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
        terminate: afterResult.terminate ?? result.terminate,
      };
      isError = afterResult.isError ?? isError;
    }
  }

  const toolResultContent: ToolResultContent = {
    type: "toolResult",
    toolCallId: toolCall.id,
    content: result.content,
    isError,
  };

  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: toolResultContent,
    isError,
  });

  return {
    message: { role: "toolResult", content: [toolResultContent], timestamp: Date.now() },
    terminate: result.terminate === true,
  };
}
