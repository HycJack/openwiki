/**
 * Agent Loop - LLM 调用和工具执行的核心循环
 *
 * 参考 pi-mono 的 runLoop 和 openwiki/tui-coding-agent 的 agent-loop.ts 设计：
 * - 外层循环：follow-up 消息
 * - 内层循环：LLM 响应 + 工具调用 + steering 消息
 * - 通过 emit 回调推送事件
 */

import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AssistantMessage,
  ToolResultMessage,
  AgentToolResult,
  ContentBlock,
  TextContent,
  TokenUsage,
  ToolCallContent,
  ToolResultContent,
} from "./types.js";
import { streamOpenAI } from "./providers/openai.js";
import {
  estimateContextUsage,
  shouldCompact,
  DEFAULT_RESERVE_TOKENS,
} from "./token-estimate.js";
import {
  findCutPoint,
  buildCompactedMessages,
  buildCompactionPrompt,
  createCompactionEntry,
  type CompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
} from "./compaction.js";

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

  // 同步 currentContext.messages 的最终状态（可能被压缩）回 context.messages
  // 这样调用方（agent.ts）能感知到 loop 内的压缩结果
  context.messages.length = 0;
  context.messages.push(...currentContext.messages);

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
  await runLoop(
    { ...context, messages: [...context.messages] },
    newMessages, config, signal, emit,
  );
  return newMessages;
}

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

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const message = await streamAssistantResponse(currentContext, config, signal, emit);
      // AI 回复必须加入 currentContext.messages，否则 turn_end/agent_end 时
      // agent.state.messages 不含 AI 回复，TUI 会丢失 AI 输出
      currentContext.messages.push(message);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        return;
      }

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
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) ?? [];
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: EventSink,
): Promise<AssistantMessage> {
  // Emit context event for plugins to inspect (pi-mono style)
  const usage = estimateContextUsage(context.messages, context.systemPrompt, context.model.contextWindow);
  await emit({ type: "context", usage });

  // Auto-compaction when context exceeds threshold (pi-mono style)
  const reserveTokens = config.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  if (shouldCompact(usage, reserveTokens)) {
    const cutPoint = findCutPoint(context.messages, config.keepRecentTokens ?? DEFAULT_COMPACTION_CONFIG.keepRecentTokens);
    if (cutPoint) {
      const compacted = buildCompactedMessages(context.messages, cutPoint, "[Auto-compaction triggered]");
      context.messages.length = 0;
      context.messages.push(...compacted);
      await emit({ type: "notification", message: `Auto-compacted: kept ${compacted.length} messages (${cutPoint.truncatedCount} compressed)`, level: "info" });
    }
  }

  if (config.transformContext) {
    const transformed = await config.transformContext(context.messages, signal);
    if (transformed !== context.messages) {
      context.messages.length = 0;
      context.messages.push(...transformed);
    }
  }
  const messages = context.messages;

  const llmMessages = await config.convertToLlm(messages);

  const toolDescriptors = (context.tools ?? []).map((t: { name: string; description: string; parameters: unknown }) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const apiKey = config.getApiKey
    ? await config.getApiKey(config.model.provider)
    : config.model.apiKey;

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
  let tokenUsage: TokenUsage = { input: 0, output: 0, totalTokens: 0 };

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
        // 更新 partialMessage.content：保留已有 blocks（如 toolCall），替换/追加 text block
        // 每次创建新对象，避免 mutate 被外部缓存的 block 引用
        {
          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (lastBlock && lastBlock.type === "text") {
            contentBlocks[contentBlocks.length - 1] = { type: "text", text: textBuffer };
          } else {
            contentBlocks.push({ type: "text", text: textBuffer });
          }
          partialMessage.content = [...contentBlocks];
        }
        await emit({
          type: "message_update",
          message: { ...partialMessage },
          delta: event.delta ?? "",
        });
        break;

      case "reasoning_delta":
        partialMessage.reasoning = (partialMessage.reasoning ?? "") + event.delta;
        await emit({
          type: "message_update",
          message: { ...partialMessage },
          delta: "",
        });
        break;

      case "tool_call":
        if (event.toolCall) {
          // 若有未提交的 textBuffer，先固化为 text block
          if (textBuffer) {
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === "text") {
              contentBlocks[contentBlocks.length - 1] = { type: "text", text: textBuffer };
            } else {
              contentBlocks.push({ type: "text", text: textBuffer });
            }
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
          tokenUsage = event.usage;
        }
        // 使用 provider 返回的 finish_reason
        if (event.finishReason === "length") {
          stopReason = "length";
        } else if (event.finishReason === "tool_calls") {
          stopReason = "tool_use";
        }
        break;

      case "error":
        stopReason = "error";
        errorMessage = event.error;
        break;
    }
  }

  if (textBuffer) {
    // 若最后一个 block 已是 text（text_delta 时已同步），不重复 push
    const lastBlock = contentBlocks[contentBlocks.length - 1];
    if (!lastBlock || lastBlock.type !== "text") {
      contentBlocks.push({ type: "text", text: textBuffer });
    }
  }

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
    usage: tokenUsage,
  };

  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

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

  const hasSequential = toolCalls.some((tc: ToolCallContent) => {
    const tool = currentContext.tools?.find((t: AgentTool) => t.name === tc.name);
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

  return {
    messages: results.map((r) => r.message),
    terminate: results.some((r) => r.terminate),
  };
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

  const tool = context.tools?.find((t: AgentTool) => t.name === toolCall.name);

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

  let result: AgentToolResult;
  let isError = false;

  try {
    result = await tool.execute(toolCall.id, toolCall.arguments, signal, (partial: unknown) => {
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
