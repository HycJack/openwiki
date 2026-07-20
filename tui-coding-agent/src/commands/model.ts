/**
 * /model — 切换模型
 *
 * 用法：
 *   /model                  — 显示当前模型及可用列表
 *   /model provider:id      — 切换到指定模型
 */

import type { CommandEntry } from "./registry.js";

export const modelCommand: CommandEntry = {
  name: "model",
  description: "Switch model: /model [provider:id]",
  handler: async (args, ctx) => {
    const modelArg = args[0];

    if (!modelArg) {
      ctx.chat.setStatus(`Current model: ${ctx.model.id}`, "idle");
      const models = ctx.config.models ?? [];
      if (models.length > 0) {
        console.log(`\x1b[90mAvailable models:\x1b[0m`);
        for (const m of models) {
          console.log(`  \x1b[33m${m.provider}:${m.id}\x1b[0m${m.name ? ` \x1b[90m- ${m.name}\x1b[0m` : ""}`);
        }
      } else {
        console.log(`\x1b[90m  No saved models. Use /model <provider>:<id> to switch.\x1b[0m`);
      }
      return;
    }

    const colonIdx = modelArg.indexOf(":");
    const provider = colonIdx >= 0 ? modelArg.slice(0, colonIdx) : ctx.model.provider;
    const modelId = colonIdx >= 0 ? modelArg.slice(colonIdx + 1) : modelArg;

    const savedModel = ctx.config.models?.find(
      (m) => m.id === modelId && m.provider === provider,
    );

    ctx.agent.model = {
      id: modelId,
      name: savedModel?.name ?? modelId,
      provider,
      apiKey: savedModel?.apiKey ?? ctx.model.apiKey,
      baseURL: savedModel?.baseURL ?? ctx.model.baseURL,
    };

    ctx.chat.setModelLabel(modelId);
    ctx.chat.setStatus(`Switched to ${provider}:${modelId}`, "idle");
  },
};
