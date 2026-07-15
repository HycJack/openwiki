/**
 * Agent 类 - 状态管理和事件流
 *
 * 参考 pi-mono 的 Agent 类设计：
 * - 拥有消息历史和状态
 * - 发射生命周期事件
 * - 执行工具
 * - 支持 steering 和 follow-up 消息队列
 *
 * 参考 openwiki 的 runOpenWikiAgent 模式，提供简单的 prompt/continue 接口。
 */

import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { convertToLlm } from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  ImageContent,
  Message,
  ModelConfig,
  StreamLLM,
  TextContent,
  ThinkingLevel,
} from "./types.js";

const EMPTY_USAGE = { input: 0, output: 0, totalTokens: 0 };

const DEFAULT_MODEL: ModelConfig = {
  id: "gpt-4o",
  name: "gpt-4o",
  provider: "openai",
};

interface PendingMessageQueue {
  messages: AgentMessage[];
  mode: "all" | "one-at-a-time";
}

function createQueue(mode: "all" | "one-at-a-time" = "one-at-a-time"): PendingMessageQueue {
  return { messages: [], mode };
}

function drainQueue(queue: PendingMessageQueue): AgentMessage[] {
  if (queue.mode === "all") {
    const drained = queue.messages.slice();
    queue.messages = [];
    return drained;
  }
  const first = queue.messages[0];
  if (!first) return [];
  queue.messages = queue.messages.slice(1);
  return [first];
}

export interface AgentOptions {
  initialState?: {
    systemPrompt?: string;
    model?: ModelConfig;
    thinkingLevel?: ThinkingLevel;
    tools?: AgentTool[];
    messages?: AgentMessage[];
  };
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  streamLLM?: StreamLLM;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  toolExecution?: "sequential" | "parallel";
  beforeToolCall?: AgentLoopConfig["beforeToolCall"];
  afterToolCall?: AgentLoopConfig["afterToolCall"];
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  /** Session 持久化回调：每条消息结束时保存 */
  onMessageEnd?: (message: AgentMessage) => Promise<void>;
  /** Session 持久化回调：session 重置 */
  onSessionReset?: () => Promise<void>;
}

export class Agent {
  private _systemPrompt: string;
  private _model: ModelConfig;
  private _thinkingLevel: ThinkingLevel;
  private _tools: AgentTool[];
  private _messages: AgentMessage[];
  private _isStreaming = false;
  private _streamingMessage: AgentMessage | undefined;
  private _pendingToolCalls = new Set<string>();
  private _errorMessage: string | undefined;

  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

  private activeRun?: {
    promise: Promise<void>;
    resolve: () => void;
    abortController: AbortController;
  };

  public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  public streamLLM?: StreamLLM;
  public transformContext?: AgentLoopConfig["transformContext"];
  public getApiKey?: AgentLoopConfig["getApiKey"];
  public toolExecution: "sequential" | "parallel";
  public beforeToolCall?: AgentLoopConfig["beforeToolCall"];
  public afterToolCall?: AgentLoopConfig["afterToolCall"];
  public onMessageEnd?: (message: AgentMessage) => Promise<void>;
  public onSessionReset?: () => Promise<void>;

  constructor(options: AgentOptions = {}) {
    const state = options.initialState ?? {};
    this._systemPrompt = state.systemPrompt ?? "You are a helpful coding assistant.";
    this._model = state.model ?? DEFAULT_MODEL;
    this._thinkingLevel = state.thinkingLevel ?? "off";
    this._tools = state.tools?.slice() ?? [];
    this._messages = state.messages?.slice() ?? [];
    this.convertToLlm = options.convertToLlm ?? convertToLlm;
    this.streamLLM = options.streamLLM;
    this.transformContext = options.transformContext;
    this.getApiKey = options.getApiKey;
    this.toolExecution = options.toolExecution ?? "parallel";
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.onMessageEnd = options.onMessageEnd;
    this.onSessionReset = options.onSessionReset;
    this.steeringQueue = createQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = createQueue(options.followUpMode ?? "one-at-a-time");
  }

  get state(): AgentState {
    return {
      systemPrompt: this._systemPrompt,
      model: this._model,
      thinkingLevel: this._thinkingLevel,
      tools: this._tools,
      messages: this._messages,
      isStreaming: this._isStreaming,
      streamingMessage: this._streamingMessage,
      pendingToolCalls: this._pendingToolCalls,
      errorMessage: this._errorMessage,
    };
  }

  set systemPrompt(value: string) { this._systemPrompt = value; }
  set model(value: ModelConfig) { this._model = value; }
  set thinkingLevel(value: ThinkingLevel) { this._thinkingLevel = value; }
  set tools(value: AgentTool[]) { this._tools = value.slice(); }

  set steeringMode(mode: "all" | "one-at-a-time") { this.steeringQueue.mode = mode; }
  set followUpMode(mode: "all" | "one-at-a-time") { this.followUpQueue.mode = mode; }

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(message: AgentMessage): void { this.steeringQueue.messages.push(message); }
  followUp(message: AgentMessage): void { this.followUpQueue.messages.push(message); }
  clearSteeringQueue(): void { this.steeringQueue.messages = []; }
  clearFollowUpQueue(): void { this.followUpQueue.messages = []; }
  clearAllQueues(): void { this.clearSteeringQueue(); this.clearFollowUpQueue(); }

  /** 加载消息（替换当前消息列表） */
  loadMessages(messages: AgentMessage[]): void {
    this._messages = messages.slice();
    this._errorMessage = undefined;
    this._streamingMessage = undefined;
  }

  abort(): void { this.activeRun?.abortController.abort(); }
  waitForIdle(): Promise<void> { return this.activeRun?.promise ?? Promise.resolve(); }

  /** 向 TUI 发送通知消息（通过 listeners 广播 notification 事件）。 */
  notifyUI(message: string, level: "info" | "warning" | "error" = "info"): void {
    const event: AgentEvent = { type: "notification", message, level };
    for (const listener of this.listeners) {
      const result = listener(event, new AbortController().signal);
      if (result && typeof result === "object" && "catch" in result) {
        (result as Promise<void>).catch(() => {});
      }
    }
  }

  reset(): void {
    this._messages = [];
    this._isStreaming = false;
    this._streamingMessage = undefined;
    this._pendingToolCalls = new Set();
    this._errorMessage = undefined;
    this.clearAllQueues();
    this.onSessionReset?.().catch(() => {});
  }

  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Use steer() or followUp() to queue messages.");
    }
    const messages = this.normalizePromptInput(input, images);
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
      );
    });
  }

  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }
    const lastMessage = this._messages[this._messages.length - 1];
    if (!lastMessage) throw new Error("No messages to continue from");
    if (lastMessage.role === "assistant") {
      const queued = drainQueue(this.steeringQueue);
      if (queued.length > 0) {
        await this.runWithLifecycle(async (signal) => {
          await runAgentLoop(
            queued,
            this.createContextSnapshot(),
            this.createLoopConfig(),
            (event) => this.processEvents(event),
            signal,
          );
        });
        return;
      }
      const followUps = drainQueue(this.followUpQueue);
      if (followUps.length > 0) {
        await this.runWithLifecycle(async (signal) => {
          await runAgentLoop(
            followUps,
            this.createContextSnapshot(),
            this.createLoopConfig(),
            (event) => this.processEvents(event),
            signal,
          );
        });
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
      );
    });
  }

  private normalizePromptInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== "string") return [input];
    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) content.push(...images);
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private createContextSnapshot(): AgentContext {
    return {
      systemPrompt: this._systemPrompt,
      messages: this._messages.slice(),
      tools: this._tools.slice(),
    };
  }

  private createLoopConfig(): AgentLoopConfig {
    return {
      model: this._model,
      streamLLM: this.streamLLM,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      getSteeringMessages: async () => drainQueue(this.steeringQueue),
      getFollowUpMessages: async () => drainQueue(this.followUpQueue),
    };
  }

  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) throw new Error("Agent is already processing.");

    const abortController = new AbortController();
    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this._isStreaming = true;
    this._streamingMessage = undefined;
    this._errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: this._model.id,
      provider: this._model.provider,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
      usage: EMPTY_USAGE,
    };
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this._isStreaming = false;
    this._streamingMessage = undefined;
    this._pendingToolCalls = new Set();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        this._streamingMessage = event.message;
        break;
      case "message_update":
        this._streamingMessage = event.message;
        break;
      case "message_end":
        this._streamingMessage = undefined;
        this._messages.push(event.message);
        this.onMessageEnd?.(event.message).catch(() => {});
        break;
      case "tool_execution_start": {
        const next = new Set(this._pendingToolCalls);
        next.add(event.toolCallId);
        this._pendingToolCalls = next;
        break;
      }
      case "tool_execution_end": {
        const next = new Set(this._pendingToolCalls);
        next.delete(event.toolCallId);
        this._pendingToolCalls = next;
        break;
      }
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this._errorMessage = event.message.errorMessage;
        }
        break;
      case "agent_end":
        this._streamingMessage = undefined;
        break;
    }

    const signal = this.activeRun?.abortController.signal;
    if (!signal) throw new Error("Agent listener invoked outside active run");
    for (const listener of this.listeners) {
      try {
        await listener(event, signal);
      } catch (err) {
        console.error(`[Agent] listener error:`, err);
      }
    }
  }
}
