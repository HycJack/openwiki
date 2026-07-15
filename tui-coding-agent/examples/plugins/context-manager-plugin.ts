/**
 * 上下文管理插件
 *
 * 功能：
 *   /ctx              查看当前上下文概览（进度条、token 估算）
 *   /ctx limit        查看/设置 token 上限（默认 128k）
 *   /ctx threshold    查看/设置警告阈值
 *   /ctx summary      显示消息概览
 *   /ctx compact      触发上下文压缩（用 LLM 生成摘要替换历史）
 *   /ctx compact:auto 切换自动压缩模式
 *   /ctx clear        清除消息计数
 *   /ctx help         帮助
 *
 * 自动检查：
 *   在 context 事件中（每次 LLM 调用前）检查上下文是否超限。
 *   如果启用了自动压缩，在超限时自动触发 compact。
 *
 * Compaction 机制（参考 pi-mono 设计）：
 *   当上下文超过阈值时，将较早的消息压缩成 LLM 生成的结构化摘要，
 *   用一条 compaction summary 消息替换历史，保留最近的 N 条消息。
 *
 * Token 估算规则：
 *   - ASCII 字符：0.25 token/字符
 *   - 中文：1.5 token/字符
 *   - 每条消息 ~4 token 开销
 *   - 整个上下文 + 系统提示词
 */

import type { PluginAPI, PluginCommandContext, PluginContext } from "../../src/plugin/types.js";

// ============================================================================
// Token 估算
// ============================================================================

function charTokens(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code <= 127) return 0.25;
  if (code >= 0x4e00 && code <= 0x9fff) return 1.5;
  if (code >= 0x3040 && code <= 0x30ff) return 0.6;
  if (code >= 0xac00 && code <= 0xd7af) return 0.6;
  return 0.5;
}

function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += charTokens(ch);
  }
  return Math.ceil(tokens);
}

// ============================================================================
// 类型
// ============================================================================

interface ContextConfig {
  maxTokens: number;
  warningThreshold: number; // 0-100
  autoCompact: boolean; // 超限时自动压缩
  /** 压缩时保留的最近消息数 */
  keepRecentCount: number;
}

interface MessageRecord {
  role: string;
  content: string;
  reasoning?: string;
}

// ============================================================================
// 默认值
// ============================================================================

const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_WARNING_THRESHOLD = 85;
const DEFAULT_KEEP_RECENT = 10;

// ============================================================================
// 插件入口
// ============================================================================

export default function contextManagerPlugin(api: PluginAPI): void {
  const config: ContextConfig = {
    maxTokens: DEFAULT_MAX_TOKENS,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
    autoCompact: false,
    keepRecentCount: DEFAULT_KEEP_RECENT,
  };

  // 插件内部消息记录
  let messageRecords: MessageRecord[] = [];
  // 上次警告的时间戳，避免频繁 notify
  let lastWarnTs = 0;

  // ========================================================================
  // 辅助
  // ========================================================================

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return n.toString();
  }

  function createUsageBar(percent: number): string {
    const barLen = 20;
    const filled = Math.round((percent / 100) * barLen);
    return "█".repeat(Math.min(filled, barLen)) + "░".repeat(Math.max(0, barLen - filled));
  }

  /** 检查是否需要压缩 */
  function shouldCompact(usage: { percent: number }): boolean {
    return config.autoCompact && usage.percent >= 100;
  }

  // ========================================================================
  // Compaction 实现
  // ========================================================================

  /**
   * 执行上下文压缩（修改 messageRecords 和调用 ctx.compact）。
   *
   * 策略（参考 pi-mono 的 findCutPoint）：
   * 1. 保留最近的 keepRecentCount 条消息
   * 2. 把更早的消息压缩成一条摘要
   * 3. 用单条 compaction summary 替换被压缩的历史
   */
  function doCompact(ctx: PluginContext): boolean {
    if (messageRecords.length <= config.keepRecentCount + 1) return false;

    const keepCount = config.keepRecentCount;
    const toSummarize = messageRecords.slice(0, -keepCount);
    const kept = messageRecords.slice(-keepCount);

    // 构建待压缩内容的文本表示
    const summaryParts: string[] = [];
    for (const rec of toSummarize) {
      if (rec.content) {
        summaryParts.push(`[${rec.role}]: ${rec.content.slice(0, 500)}`);
      }
    }
    const summaryText = summaryParts.join("\n---\n");

    // 创建一个压缩摘要消息
    const compactedContent =
      `[Context compressed ${toSummarize.length} messages]\n` +
      `Previous conversation summary:\n${summaryText.slice(0, 3000)}`;

    // 替换 messageRecords：用一条 compaction 记录 + 保留的最近消息
    messageRecords = [
      {
        role: "system",
        content: compactedContent,
      },
      ...kept,
    ];

    // 调用框架的 compact
    ctx.compact({ customInstructions: compactedContent });
    return true;
  }

  // ========================================================================
  // context 事件：在 LLM 调用前检查/压缩上下文
  // ========================================================================

  api.on("context", (_event: unknown, ctx: PluginContext) => {
    const usage = ctx.getContextUsage();
    if (!usage) return;

    // 检查是否超限
    if (usage.percent >= config.warningThreshold) {
      const now = Date.now();
      if (now - lastWarnTs > 60_000) {
        // 每分钟最多一次警告
        lastWarnTs = now;

        if (usage.percent >= 100) {
          api.notify(
            `[CTX] Context at ${usage.percent.toFixed(0)}% ` +
              `(~${formatTokens(usage.tokens)} / ${formatTokens(usage.limit)}). ` +
              (config.autoCompact ? "Auto-compacting..." : "Use /ctx compact or /clear."),
            "error",
          );

          // 自动压缩
          if (config.autoCompact) {
            doCompact(ctx);
          }
        } else {
          api.notify(
            `[CTX] Context at ${usage.percent.toFixed(0)}% ` +
              `(~${formatTokens(usage.tokens)} / ${formatTokens(usage.limit)}).`,
            "warning",
          );
        }
      }
    }

    return { messages: undefined }; // 不修改消息列表——让框架的 getContextUsage 做只读检查
  });

  // ========================================================================
  // 消息事件：记录消息内容
  // ========================================================================

  api.on("message_end", (event: unknown) => {
    const evt = event as { message?: { role?: string; content?: Array<{ type: string; text?: string }>; reasoning?: string } };
    const msg = evt?.message;
    if (!msg || !msg.role) return;

    let content = "";
    if (msg.content) {
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          content += block.text;
        }
      }
    }
    messageRecords.push({
      role: msg.role,
      content,
      reasoning: msg.reasoning,
    });
  });

  // ========================================================================
  // 命令：/ctx
  // ========================================================================

  api.registerCommand("ctx", async (cmdCtx: PluginCommandContext, args: string) => {
    const parts = args.trim().split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();

    // /ctx limit [n]
    if (subCmd === "limit") {
      const value = parseInt(parts[1], 10);
      if (!isNaN(value) && value > 0) {
        config.maxTokens = value;
        cmdCtx.sendMessage(`Context token limit set to ${formatTokens(config.maxTokens)}`);
      } else {
        cmdCtx.sendMessage(
          `Current limit: ${formatTokens(config.maxTokens)}\n` +
          `Usage: /ctx limit <number>`,
        );
      }
      return;
    }

    // /ctx threshold [n]
    if (subCmd === "threshold") {
      const value = parseInt(parts[1], 10);
      if (!isNaN(value) && value >= 5 && value <= 100) {
        config.warningThreshold = value;
        cmdCtx.notify(`Warning threshold set to ${config.warningThreshold}%`);
      } else {
        cmdCtx.notify(
          `Current threshold: ${config.warningThreshold}%\n` +
          `Usage: /ctx threshold <5-100>`,
        );
      }
      return;
    }

    // /ctx compact
    if (subCmd === "compact") {
      const usage = cmdCtx.getContextUsage();
      if (!usage) {
        cmdCtx.notify("No context usage data available.");
        return;
      }
      const didCompress = doCompact(cmdCtx);
      cmdCtx.notify(didCompress ? "Context compacted." : "Nothing to compact (messages under limit).");
      return;
    }

    // /ctx compact:auto
    if (subCmd === "compact:auto") {
      config.autoCompact = !config.autoCompact;
      cmdCtx.notify(`Auto-compact ${config.autoCompact ? "enabled" : "disabled"}.`);
      return;
    }

    // /ctx summary
    if (subCmd === "summary") {
      const byRole: Record<string, number> = {};
      let totalLen = 0;
      for (const msg of messageRecords) {
        byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
        totalLen += msg.content.length + (msg.reasoning?.length ?? 0);
      }
      const roleLines = Object.entries(byRole)
        .map(([role, count]) => `  ${role}: ${count}`)
        .join("\n");
      cmdCtx.notify(
        `Session Summary:\n` +
        `  Total messages: ${messageRecords.length}\n` +
        `  Total chars:    ${totalLen.toLocaleString()}\n` +
        roleLines,
      );
      return;
    }

    // /ctx clear
    if (subCmd === "clear") {
      messageRecords = [];
      lastWarnTs = 0;
      cmdCtx.notify("Context manager records cleared.");
      return;
    }

    // /ctx help
    if (subCmd === "help") {
      cmdCtx.notify(
        `Context Manager:\n` +
        `  /ctx                       Show context overview\n` +
        `  /ctx limit [n]             View/set token limit\n` +
        `  /ctx threshold [n]         View/set warn threshold %\n` +
        `  /ctx compact               Trigger compaction now\n` +
        `  /ctx compact:auto          Toggle auto-compact\n` +
        `  /ctx summary               Message summary by role\n` +
        `  /ctx clear                 Clear records\n` +
        `  /ctx help                  This help`,
      );
      return;
    }

    // 默认：显示上下文概览
    const usage = cmdCtx.getContextUsage();
    if (!usage) {
      cmdCtx.notify("No context usage data available.");
      return;
    }

    const bar = createUsageBar(usage.percent);
    let statusText = "OK";
    if (usage.percent >= 100) {
      statusText = "OVER LIMIT";
    } else if (usage.percent >= config.warningThreshold) {
      statusText = "WARNING";
    }

    let autoStatus = "";
    if (config.autoCompact) {
      autoStatus = "  [Auto-compact ON]";
    }

    const messageCount = cmdCtx.getMessageCount();
    cmdCtx.notify(
      `Context Overview:\n` +
      `  Messages: ${messageCount}\n` +
      `\n` +
      `  ~${formatTokens(usage.tokens)} / ${formatTokens(usage.limit)}\n` +
      `  [${bar}] ${usage.percent.toFixed(1)}%\n` +
      `  Status: ${statusText}` +
      autoStatus,
    );
  });
}
