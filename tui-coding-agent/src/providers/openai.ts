/**
 * OpenAI 兼容的 LLM Provider
 *
 * 参考 openwiki 的 ChatOpenAI 用法，使用 fetch 直接调用 OpenAI Responses/Chat API。
 * 支持 OpenAI、OpenRouter 及任何 OpenAI 兼容的 endpoint。
 */

import type { ModelConfig, Message } from "../types.js";
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
      result.push({ role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text! : content });
    } else if (msg.role === "assistant") {
      const textParts = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
      const toolCalls = msg.content
        .filter((c) => c.type === "toolCall")
        .map((c) => {
          const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
          return { id: tc.id, type: "function" as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } };
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

/**
 * 合并两个 AbortSignal，任一触发则整体 abort。
 */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
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

  // 带超时和重试的请求
  const ABORT_TIMEOUT = 120_000; // 2 minutes
  const MAX_RETRIES = 2;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 指数退避
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }

    // 创建带超时的 abort controller
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), ABORT_TIMEOUT);

    // 合并外部 signal 和超时 signal
    const combinedSignal = options?.signal
      ? combineAbortSignals(options.signal, timeoutController.signal)
      : timeoutController.signal;

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

      clearTimeout(timeoutTimer);

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        lastError = `API error ${response.status}: ${text}`;
        if (response.status < 500 && response.status !== 429) {
          // 非服务端错误（4xx），不重试
          yield { type: "error", error: lastError };
          return;
        }
        continue; // 服务端错误（5xx/429），重试
      }

      // 成功获取响应，处理流
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

              // reasoning_content 字段（deepseek-r1, o1 等模型的思考内容）
              if ((delta as Record<string, unknown>)?.reasoning_content) {
                yield { type: "reasoning_delta", delta: (delta as Record<string, string>).reasoning_content };
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
      };
      return; // 成功，退出
    } catch (error) {
      clearTimeout(timeoutTimer);
      const msg = error instanceof Error ? error.message : String(error);
      if (options?.signal?.aborted) {
        yield { type: "error", error: "Request aborted" };
        return;
      }
      lastError = msg;
      // 继续重试循环
    }
  }

  // 所有重试都失败
  yield { type: "error", error: lastError ?? "Request failed after retries" };
}
