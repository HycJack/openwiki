/**
 * Agent — 封装 runAgentLoop 的高层会话管理
 *
 * 参考 pi-mono AgentSession 设计：
 * - Agent.agentLoop(input) → 内部的 runAgentLoop() 真正调用 LLM
 * - 完整生命周期事件 (agent_start → turn_start → message_* → turn_end → agent_end)
 * - abort() 中断当前循环
 * - subscribe() 事件监听
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  AgentConfig,
  ModelConfig,
  AgentLoopConfig,
  AssistantMessage,
  StreamLLM,
} from "./types.js";
import { runAgentLoop } from "./agent-loop.js";
import { convertToLlm } from "./llm.js";
import { streamOpenAI } from "./providers/openai.js";
import type { StreamFn } from "./llm.js";
import {
  estimateContextUsage,
  shouldCompact,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
} from "./token-estimate.js";
import {
  findCutPoint,
  buildCompactedMessages,
  buildCompactionPrompt,
  isCompactionSummary,
  type CompactionConfig,
  type CutPoint,
  DEFAULT_COMPACTION_CONFIG,
} from "./compaction.js";

const DEFAULT_MODEL: ModelConfig = { id: "gpt-4o", name: "gpt-4o", provider: "openai" };

export class Agent {
  private _systemPrompt = "You are a helpful coding assistant.";
  private _model = DEFAULT_MODEL;
  private _tools: AgentTool[] = [];
  private _messages: AgentMessage[] = [];
  private _isStreaming = false;
  private _errorMessage: string | undefined;
  private _abortController = new AbortController();
  private _idleResolvers: Array<() => void> = [];
  private _agentEndEmitted = false;

  /** 外部传入的 streamLLM provider，默认用 streamOpenAI */
  private _streamLLM: StreamFn;

  /** Compaction 完成后的回调，用于持久化 CompactionEntry */
  private _onCompaction?: (summary: string, cutPoint: CutPoint, keptMessages: AgentMessage[]) => Promise<void>;

  readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();

  constructor(config?: AgentConfig) {
    if (config?.systemPrompt) this._systemPrompt = config.systemPrompt;
    if (config?.model) this._model = config.model;
    if (config?.tools) this._tools = config.tools.slice();
    if (config?.messages) this._messages = config.messages.slice();
    this._streamLLM = config?.streamLLM ?? (async function* () {} as StreamFn);
    this._onCompaction = config?.onCompaction;
  }

  get state(): AgentState {
    return {
      systemPrompt: this._systemPrompt,
      model: this._model,
      tools: this._tools,
      messages: this._messages,
      isStreaming: this._isStreaming,
      errorMessage: this._errorMessage,
      messageCount: this._messages.length,
    };
  }

  set systemPrompt(value: string) { this._systemPrompt = value; }
  set model(value: ModelConfig) { this._model = value; }
  set tools(value: AgentTool[]) { this._tools = value.slice(); }

  /** 当前 AbortController 的 signal（用于外部 LLM 调用联动中断） */
  get signal(): AbortSignal { return this._abortController.signal; }

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  loadMessages(messages: AgentMessage[]): void {
    this._messages = messages.slice();
  }

  abort(): void {
    this._errorMessage = "Aborted";
    this._abortController.abort("user_cancelled");
  }

  waitForIdle(): Promise<void> {
    if (!this._isStreaming || this._abortController.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      this._idleResolvers.push(resolve);
    });
  }

  reset(): void {
    // 清理旧的 AbortController 避免 listeners 泄漏
    if (!this._abortController.signal.aborted) {
      this._abortController.abort("reset");
    }
    this._messages = [];
    this._isStreaming = false;
    this._errorMessage = undefined;
    this._abortController = new AbortController();
    this._agentEndEmitted = false;
  }

  notifyUI(message: string, level: "info" | "warning" | "error" = "info"): void {
    this.broadcast({ type: "notification", message, level });
  }

  /**
   * 构建 AgentLoopConfig，供 agentLoop 使用。
   * 子类可重写此方法自定义 config。
   */
  /** 获取当前消息列表（请勿直接修改返回的数组） */
  getMessages(): AgentMessage[] {
    return this._messages;
  }

  /** 设置消息列表（用于 session 切换/上下文重建） */
  setMessages(messages: AgentMessage[]): void {
    this._messages = messages.slice();
    // 触发重新渲染
    this.broadcast({
      type: "notification",
      message: `Context updated (${messages.length} messages)`,
      level: "info",
    });
  }

  /**
   * 设置 compaction 持久化回调（由 cli.ts 注入 session-manager）。
   */
  setCompactionCallback(cb: (summary: string, cutPoint: CutPoint, keptMessages: AgentMessage[]) => Promise<void>): void {
    this._onCompaction = cb;
  }

  protected buildLoopConfig(): AgentLoopConfig {
    const userStream = this._streamLLM;
    const streamFn = userStream ?? streamOpenAI;
    return {
      model: this._model,
      convertToLlm,
      streamLLM: streamFn as StreamLLM,
      toolExecution: "parallel",
    };
  }

  /**
   * Main agent loop — 封装 runAgentLoop，真正调用 LLM。
   * 参考 pi-mono AgentSession.prompt()。
   */
  async agentLoop(input: string): Promise<void> {
    if (this._isStreaming) {
      throw new Error("Agent is already streaming");
    }

    this._isStreaming = true;
    this._errorMessage = undefined;
    this._agentEndEmitted = false;  // 重置，允许本次 agentLoop 发出 agent_end
    // 清理旧的 AbortController 避免 listeners 泄漏
    if (!this._abortController.signal.aborted) {
      this._abortController.abort("new_loop");
    }
    this._abortController = new AbortController();

    try {
      // Add user message（由 runAgentLoop 内部 push 到 currentContext.messages，
      // 最终同步回 context.messages 即 this._messages）
      const userMsg: AgentMessage = {
        role: "user",
        content: [{ type: "text" as const, text: input }],
        timestamp: Date.now(),
      };

      // Build loop config
      const loopConfig = this.buildLoopConfig();

      // 构建 context（引用 this._messages，runAgentLoop 会修改它）
      const context = {
        model: this._model,
        systemPrompt: this._systemPrompt,
        tools: this._tools,
        messages: this._messages,
      };

      // 调用 runAgentLoop — 真正的 LLM 驱动循环
      const allMessages = await runAgentLoop(
        [userMsg],
        context,
        loopConfig,
        (event) => this.broadcast(event),
        this._abortController.signal,
      );

      // runAgentLoop 已将最终消息（含可能的 loop 内压缩）同步到 context.messages
      // context.messages 现包含 [原历史(可能被压缩), ...prompts, assistant, toolResults]
      // allMessages 是本轮新增子集（prompts + assistant + toolResults），已含在 context.messages 中
      this._messages = [...context.messages];

      // Agent end
      await this.broadcast({ type: "agent_end", messages: this._messages });

      // 自动压缩：用完 Agent Loop 后检查 context 使用量
      await this.autoCompactIfNeeded();

    } catch (err) {
      if (this._abortController.signal.aborted) {
        this._errorMessage = "Aborted";
        // 中断路径也发 agent_end，确保 UI 恢复 idle 且消息保存
        await this.broadcast({ type: "agent_end", messages: this._messages });
      } else {
        this._errorMessage = err instanceof Error ? err.message : String(err);
        this.notifyUI(this._errorMessage, "error");
        // 异常路径下发 agent_end
        await this.broadcast({ type: "agent_end", messages: this._messages });
      }
    } finally {
      this._isStreaming = false;
      const resolvers = this._idleResolvers;
      this._idleResolvers = [];
      resolvers.forEach((r) => r());
    }
  }

  /**
   * Simple prompt (single turn, no agent events).
   * 非交互模式用，直接调用 runAgentLoop 的简化版本。
   */
  async prompt(input: string): Promise<AssistantMessage | null> {
    if (this._isStreaming) {
      throw new Error("Agent is already streaming");
    }

    this._isStreaming = true;
    this._errorMessage = undefined;

    try {
      const userMsg: AgentMessage = {
        role: "user",
        content: [{ type: "text" as const, text: input }],
        timestamp: Date.now(),
      };

      const loopConfig = this.buildLoopConfig();
      const context = {
        model: this._model,
        systemPrompt: this._systemPrompt,
        tools: this._tools,
        messages: this._messages,
      };

      const messages = await runAgentLoop(
        [userMsg],
        context,
        loopConfig,
        () => {}, // no events in print mode
        this._abortController.signal,
      );

      // runAgentLoop 已将最终消息同步到 context.messages（即 this._messages）
      // messages 是本轮新增子集，已含在 this._messages 中，无需再 push

      // Find the last assistant message
      const lastAssistant = messages
        .filter((m): m is AssistantMessage => m.role === "assistant")
        .pop();

      return lastAssistant ?? null;
    } catch (err) {
      this._errorMessage = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      this._isStreaming = false;
      const resolvers = this._idleResolvers;
      this._idleResolvers = [];
      resolvers.forEach((r) => r());
    }
  }

  // ============================================================================
  // Compaction
  // ============================================================================

  /**
   * 检查 context 使用量，超过阈值时自动触发 LLM 驱动的压缩。
   * 发送压缩 prompt 给 LLM，用返回的摘要替换早期消息。
   *
   * 两种触发场景：
   * 1. token 用量超过阈值（shouldCompact 返回 true）— 正常压缩
   * 2. 消息列表首条已是紧急压缩 summary（loop 内压缩过）— 强制用 LLM 摘要替换
   */
  private async autoCompactIfNeeded(): Promise<void> {
    if (this._messages.length === 0) return;

    const usage = estimateContextUsage(
      this._messages,
      this._systemPrompt,
      this._model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    );

    const reserveTokens = DEFAULT_RESERVE_TOKENS;
    // 即使 shouldCompact 返回 false，如果首条消息是紧急压缩 summary，
    // 说明 loop 内已截断过，需要生成 LLM 摘要并持久化
    const alreadyCompacted = this._messages.length > 0 && isCompactionSummary(this._messages[0]!);

    if (!shouldCompact(usage, reserveTokens) && !alreadyCompacted) return;

    const cutPoint = alreadyCompacted
      ? { firstKeptIndex: 1, truncatedTokens: 0, truncatedCount: 0 }
      : findCutPoint(this._messages, DEFAULT_COMPACTION_CONFIG.keepRecentTokens);
    if (!cutPoint) return;

    this.notifyUI(`Auto-compacting context (${cutPoint.truncatedCount} messages)...`, "info");

    try {
      // 构建压缩 prompt
      const messagesToSummarize = this._messages.slice(0, cutPoint.firstKeptIndex);
      const prompt = buildCompactionPrompt({
        messagesToSummarize,
        keptMessages: this._messages.slice(cutPoint.firstKeptIndex),
        instructions: "Summarize the compressed messages, preserving key decisions, file changes, and action items.",
      });

      // 发一次 LLM 调用获取摘要
      const summary = await this.summarizeWithLLM(prompt);
      if (!summary) return;

      // 构建压缩后的消息列表
      const compacted = buildCompactedMessages(
        this._messages,
        cutPoint,
        summary,
      );

      // 持久化 CompactionEntry（通过回调注入 session-manager）
      if (this._onCompaction) {
        try {
          await this._onCompaction(summary, cutPoint, compacted);
        } catch (err) {
          this.notifyUI(`Compaction persistence failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
        }
      }

      this._messages = compacted;
      this.notifyUI(`Auto-compacted: ${cutPoint.truncatedCount} messages compressed → ${compacted.length} messages kept`, "info");
    } catch (err) {
      this.notifyUI(`Auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  }

  /**
   * 用 LLM 对给定 prompt 生成摘要回复。
   * 使用当前配置的 model + streamLLM。
   */
  private async summarizeWithLLM(prompt: string): Promise<string | null> {
    const loopConfig = this.buildLoopConfig();
    const llmMessages = await convertToLlm([
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      },
    ]);

    const stream = loopConfig.streamLLM
      ? loopConfig.streamLLM(
          this._model,
          llmMessages,
          "",  // 不需要 system prompt
          [],  // 不需要工具
          { signal: this._abortController.signal },
        )
      : streamOpenAI(
          this._model,
          llmMessages,
          "",
          [],
          { signal: this._abortController.signal },
        );

    let textBuffer = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        textBuffer += event.delta;
      }
      if (event.type === "error") {
        return null;
      }
    }

    return textBuffer || null;
  }

  // ============================================================================
  // Private
  // ============================================================================

  private async broadcast(event: AgentEvent): Promise<void> {
    // 防止重复 agent_end
    if (event.type === "agent_end") {
      if (this._agentEndEmitted) return;
      this._agentEndEmitted = true;
    }
    for (const l of this.listeners) {
      try {
        await l(event, this._abortController.signal);
      } catch {
        // ignore listener errors
      }
    }
  }
}
