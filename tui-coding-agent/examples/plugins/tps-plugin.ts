/**
 * 示例插件：TPS (Tokens Per Second) 统计
 *
 * 参考 pi-mono 的 .pi/extensions/tps.ts 设计：
 * - 监听 agent_start / agent_end 事件
 * - 统计 token 使用和耗时
 * - 通过 notify 通知用户
 */

import type { PluginAPI } from "../../src/plugin/types.js";

interface AssistantMessageLike {
  role: string;
  usage?: { input: number; output: number; totalTokens: number };
}

export default function tpsPlugin(api: PluginAPI): void {
  let agentStartMs: number | null = null;

  api.on("agent_start", () => {
    agentStartMs = Date.now();
  });

  api.on("agent_end", (event) => {
    if (agentStartMs === null) return;

    const elapsedMs = Date.now() - agentStartMs;
    agentStartMs = null;
    if (elapsedMs <= 0) return;

    const messages = (event as { messages?: AssistantMessageLike[] }).messages ?? [];
    let input = 0;
    let output = 0;
    let totalTokens = 0;

    for (const message of messages) {
      if (message.role !== "assistant") continue;
      input += message.usage?.input ?? 0;
      output += message.usage?.output ?? 0;
      totalTokens += message.usage?.totalTokens ?? 0;
    }

    if (output <= 0) return;

    const elapsedSeconds = elapsedMs / 1000;
    const tps = output / elapsedSeconds;
    api.notify(
      `TPS ${tps.toFixed(1)} tok/s | out ${output}, in ${input}, total ${totalTokens}, ${elapsedSeconds.toFixed(1)}s`,
      "info",
    );
  });
}
