/**
 * OpenAI 兼容的 LLM Provider
 *
 * 参考 openwiki/tui-coding-agent 的 ChatOpenAI 用法，使用 fetch 直接调用 OpenAI API。
 * 支持 OpenAI、OpenRouter 及任何 OpenAI 兼容的 endpoint。
 */

import type { ModelConfig, Message, ToolCallContent } from "../types.js";
import type { StreamEvent, StreamOptions } from "../llm.js";
import { buildToolDescriptors } from "../llm.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function toOpenAIMessages(messages: Message[], systemPrompt: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = msg.content.map((c) => {
        if (c.type === "text") return { type: "text", text: c.text };
        if (c.type === "image") return { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } };
        return { type: "text", text: "" };
      });
      result.push({
        role: "user",
        content: content.length === 1 && content[0].type === "text" ? content[0].text! : content,
      });
    } else if (msg.role === "assistant") {
      const textParts = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
      const toolCalls = msg.content
        .filter((c): c is ToolCallContent => c.type === "toolCall")
        .map((tc) => {
          const argsStr = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments);
          return { id: tc.id, type: "function" as const, function: { name: tc.name, arguments: argsStr } };
        });
      const entry: OpenAIMessage = { role: "assistant", content: textParts.join("") };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      result.push(entry);
    } else if (msg.role === "toolResult") {
      for (const c of msg.content) {
        const text = c.content.map((cc) => (cc.type === "text" ? cc.text : "")).join("");
        result.push({ role: "tool", content: text, tool_call_id: c.toolCallId });
      }
    }
  }
  return result;
}

class AbortSignalCombo {
  private _controller: AbortController;
  private _cleanups: Array<() => void> = [];

  constructor(...signals: AbortSignal[]) {
    this._controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        this._controller.abort(signal.reason);
        break;
      }
      const handler = () => this._controller.abort(signal.reason);
      signal.addEventListener("abort", handler, { once: true });
      this._cleanups.push(() => signal.removeEventListener("abort", handler));
    }
  }

  get signal(): AbortSignal {
    return this._controller.signal;
  }

  destroy(): void {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups.length = 0;
  }
}

export async function* streamOpenAI(
  model: ModelConfig,
  messages: Message[],
  systemPrompt: string,
  tools: Array<{ name: string; description: string; parameters: unknown }>,
  options?: StreamOptions,
): AsyncIterable<StreamEvent> {
  const apiKey = options?.apiKey ?? model.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    yield { type: "error", error: "API key not provided" };
    return;
  }

  const baseURL = model.baseURL ?? "https://api.openai.com/v1";
  const body: Record<string, unknown> = {
    model: model.id,
    messages: toOpenAIMessages(messages, systemPrompt),
    stream: true,
  };
  if (tools.length > 0) {
    body.tools = buildToolDescriptors(tools);
  }

  const ABORT_TIMEOUT = 120_000;
  const MAX_RETRIES = 2;
  let lastError: string | undefined;

  // 收集 finish_reason（在流式末尾 chunk 中设置）
  let lastFinishReason: "stop" | "length" | "tool_calls" | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }

    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), ABORT_TIMEOUT);
    const combo = new AbortSignalCombo(
      ...(options?.signal ? [options.signal, timeoutController.signal] : [timeoutController.signal]),
    );
    const combinedSignal = combo.signal;

    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!response.ok || !response.body) {
        // 非成功响应：可安全清理定时器和信号监听
        clearTimeout(timeoutTimer);
        combo.destroy();
        const text = await response.text().catch(() => "");
        lastError = `API error ${response.status}: ${text}`;
        if (response.status < 500 && response.status !== 429) {
          yield { type: "error", error: lastError };
          return;
        }
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
      let totalInput = 0;
      let totalOutput = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const chunk = JSON.parse(data);
              const choice = chunk.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (delta?.content) {
                yield { type: "text_delta", delta: delta.content };
              }

              if ((delta as Record<string, unknown>)?.reasoning_content) {
                yield {
                  type: "reasoning_delta",
                  delta: (delta as Record<string, string>).reasoning_content,
                };
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallBuffers.has(idx)) {
                    toolCallBuffers.set(idx, { id: tc.id ?? "", name: "", args: "" });
                  }
                  const buf = toolCallBuffers.get(idx)!;
                  if (tc.id) buf.id = tc.id;
                  if (tc.function?.name) buf.name = tc.function.name;
                  if (tc.function?.arguments) buf.args += tc.function.arguments;
                }
              }

              if (chunk.usage) {
                totalInput = chunk.usage.prompt_tokens ?? totalInput;
                totalOutput = chunk.usage.completion_tokens ?? totalOutput;
              }

              // 处理 finish_reason
              if (choice.finish_reason) {
                const reason = choice.finish_reason as string;
                if (reason === "stop" || reason === "length" || reason === "tool_calls") {
                  lastFinishReason = reason;
                }
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      for (const [, buf] of toolCallBuffers) {
        let args: Record<string, unknown> = {};
        try {
          args = buf.args ? JSON.parse(buf.args) : {};
        } catch {
          args = { _raw: buf.args };
        }
        yield { type: "tool_call", toolCall: { id: buf.id, name: buf.name, arguments: args } };
      }

      yield {
        type: "done",
        usage: { input: totalInput, output: totalOutput, totalTokens: totalInput + totalOutput },
        finishReason: lastFinishReason,
      };
      // 流式读取完成，清理定时器和信号监听
      clearTimeout(timeoutTimer);
      combo.destroy();
      return;
    } catch (error) {
      // 异常路径：清理定时器和信号监听
      clearTimeout(timeoutTimer);
      combo.destroy();
      const msg = error instanceof Error ? error.message : String(error);
      if (options?.signal?.aborted) {
        yield { type: "error", error: "Request aborted" };
        return;
      }
      lastError = msg;
    }
  }

  yield { type: "error", error: lastError ?? "Request failed after retries" };
}
