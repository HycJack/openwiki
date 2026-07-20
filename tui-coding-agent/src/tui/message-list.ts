/**
 * MessageList — 消息流组件
 *
 * 渲染用户/AI/Tool Result 消息流，支持：
 * - 角色竖线 + 横幅标识
 * - Markdown 渲染
 * - AI 消息折叠（Ctrl+O 展开/折叠）
 * - 流式消息增量
 * - 行数限制
 */

import { Markdown, visibleWidth, truncateToWidth, type Component, MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentMessage, TextContent } from "../types.js";
import { C, defaultMDTheme, formatTimestamp, INDENT_WIDTH, FOLD_THRESHOLD, MAX_MESSAGE_LINES, TOOL_RESULT_PREVIEW_LENGTH } from "./theme.js";

// ============================================================================
// 消息渲染工具函数
// ============================================================================

/** 角色横幅：`┊  ── 角色 ──  时间` */
function roleBanner(label: string, color: string, timestamp?: number): string {
  const padded = `  ${label}  `;
  const timeStr = formatTimestamp(timestamp);
  return `${color}┊${C.reset}${color}${C.bold}${padded}${C.reset}${C.sep}──${C.reset}  ${timeStr}`;
}

/** 左侧竖线缩进 */
function indent(color: string, lines: string[]): string[] {
  return lines.map((l) => `${color}┊${C.reset}  ${l}`);
}

// ============================================================================
// MessageList
// ============================================================================

export class MessageList implements Component {
  private _messages: AgentMessage[] = [];
  private maxLines: number;
  private toolResultPreviewLength: number;
  private mdTheme: MarkdownTheme;
  private mdCache = new WeakMap<object, Markdown>();

  /** 消息折叠阈值行数（0 = 不折叠） */
  foldThreshold = FOLD_THRESHOLD;
  /** 全局展开模式（true = 所有消息展开） */
  expandAll = false;

  /** 正在流式构建中的 assistant message */
  streamingMessage: { text: string } | null = null;

  constructor(opts: {
    maxLines?: number;
    toolResultPreviewLength?: number;
    mdTheme?: MarkdownTheme;
  } = {}) {
    this.maxLines = opts.maxLines ?? MAX_MESSAGE_LINES;
    this.toolResultPreviewLength = opts.toolResultPreviewLength ?? TOOL_RESULT_PREVIEW_LENGTH;
    this.mdTheme = opts.mdTheme ?? defaultMDTheme;
  }

  invalidate(): void {}

  get messages(): AgentMessage[] {
    return this._messages;
  }

  set messages(msgs: AgentMessage[]) {
    this._messages = msgs;
    this.streamingMessage = null;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    for (const msg of this._messages) {
      this.renderOne(msg, width, lines);
      lines.push(""); // 消息间空行
    }

    // 流式中的 AI 消息
    if (this.streamingMessage?.text) {
      this.renderStreamingAI(width, lines);
      lines.push("");
    }

    // 行数限制 — 从末尾保留 maxLines 行
    if (lines.length > this.maxLines) {
      const folded = lines.length - this.maxLines;
      const foldedLine = `${C.dim}... (${folded} lines folded)${C.reset}`;
      const kept = lines.slice(lines.length - this.maxLines + 1);
      return [truncateToWidth(foldedLine, width), ...kept.map((l) => truncateToWidth(l, width))];
    }

    // 截断所有行到终端宽度，防止超长行
    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderOne(msg: AgentMessage, width: number, out: string[]): void {
    switch (msg.role) {
      case "user":
        this.renderUser(msg, width, out);
        break;
      case "assistant":
        this.renderAssistant(msg, width, out);
        break;
      case "toolResult":
        this.renderToolResult(msg, width, out);
        break;
    }
  }

  // ── User ──

  private renderUser(msg: AgentMessage, width: number, out: string[]): void {
    out.push(roleBanner("User", C.userFg, msg.timestamp));
    for (const block of msg.content) {
      if (block.type !== "text" || !block.text) continue;
      const md = this.getMD(block, block.text);
      const rendered = md.render(width - INDENT_WIDTH);
      out.push(...indent(C.userFg, rendered));
    }
  }

  // ── Assistant ──

  private renderAssistant(msg: AgentMessage, width: number, out: string[]): void {
    out.push(roleBanner("AI", C.aiFg, msg.timestamp));

    // 收集所有文本行
    const mdLines: string[] = [];

    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        const md = this.getMD(block, block.text);
        const rendered = md.render(width - INDENT_WIDTH);
        mdLines.push(...rendered);
      }
    }

    // Tool calls
    for (const block of msg.content) {
      if (block.type !== "toolCall") continue;
      const tc = block as any;
      const argsPreview = typeof tc.arguments === "string"
        ? tc.arguments.slice(0, 60)
        : JSON.stringify(tc.arguments).slice(0, 60);
      mdLines.push(
        `${C.toolFg}${C.bold}⚡ ${tc.name}${C.reset} ${C.dim}${argsPreview}${C.reset}`,
      );
    }

    // 折叠逻辑
    const threshold = this.foldThreshold > 0 && !this.expandAll ? this.foldThreshold : Infinity;
    if (mdLines.length > threshold) {
      const preview = mdLines.slice(0, threshold);
      out.push(...indent(C.aiFg, preview));
      const foldInfo = `${C.dim}... (${mdLines.length - threshold} lines folded)${C.reset}`;
      out.push(`${C.aiFg}┊${C.reset}  ${C.yellow}[Ctrl+O expand]${C.reset} ${foldInfo}`);
    } else {
      out.push(...indent(C.aiFg, mdLines));
    }
  }

  // ── Streaming AI ──

  private renderStreamingAI(width: number, out: string[]): void {
    out.push(roleBanner("AI", C.aiFg, Date.now()));

    if (this.streamingMessage!.text) {
      const md = this.getMD(this.streamingMessage!, this.streamingMessage!.text);
      const rendered = md.render(width - INDENT_WIDTH);
      out.push(...indent(C.aiFg, rendered));
    }
  }

  // ── Tool Result ──

  private renderToolResult(msg: AgentMessage, width: number, out: string[]): void {
    for (const block of msg.content) {
      if (block.type !== "toolResult") continue;
      const textBlock = block.content.find((s): s is TextContent => s.type === "text");
      if (!textBlock) continue;

      const firstLine = textBlock.text.split("\n")[0] ?? "";
      const preview = visibleWidth(firstLine) > this.toolResultPreviewLength
        ? truncateToWidth(firstLine, this.toolResultPreviewLength)
        : firstLine;

      const check = `${C.green}${C.bold}✓${C.reset}`;
      const content = `${C.dim}${preview}${C.reset}`;
      out.push(`${C.green}┊${C.reset}  ${check} ${content}`);
    }
  }

  private getMD(key: object, text: string): Markdown {
    const cached = this.mdCache.get(key);
    if (cached) return cached;
    const md = new Markdown(text, 0, 0, this.mdTheme);
    this.mdCache.set(key, md);
    return md;
  }
}
