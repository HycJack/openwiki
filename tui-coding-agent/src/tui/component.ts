/**
 * Chat TUI — 参考 pi-coding-agent 的 TUI 布局
 *
 * 布局：
 * ```
 * ┌──────────────────────────────────────────────────────┐
 * │  ● Ready                      gpt-4o  Ctrl+C         │  ← TitleBar
 * ├──────────────────────────────────────────────────────┤
 * │                                                      │
 * │  ┊  User  ──────────────── 12:00:00                  │  ← User msg
 * │  ┊  帮我写一个 react hook                             │
 * │                                                      │
 * │  ┊  AI  ────────────────── 12:00:01                  │  ← AI msg
 * │  ┊  我来写一个 useDebounce hook。                      │
 * │  ┊  ```typescript                                   │
 * │  ┊  export function useDebounce<T>(...) { ... }     │
 * │  ┊  ```                                             │
 * │  ┊  ⚡ bash - ls -la                                 │  ← tool call
 * │                                                      │
 * │  ✓ total 12                                         │  ← tool result
 * │                                                      │
 * ├──────────────────────────────────────────────────────┤
 * │  ❯ /workspace/project                                │  ← Footer
 * └──────────────────────────────────────────────────────┘
 * ```
 *
 * 角色左侧竖线配色：
 *   User:       蓝 ┊   │  横幅: ── User ──
 *   AI:         绿 ┊   │  横幅: ── AI ──
 *   Tool Call:  黄 ⚡   │
 *   Tool Result:灰 ✓   │
 */

import {
  TUI,
  Input,
  Markdown,
  ProcessTerminal,
  matchesKey,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { AgentMessage, TextContent, ContentBlock } from "../types.js";

// ============================================================================
// Markdown 主题
// ============================================================================

export const defaultMDTheme: MarkdownTheme = {
  heading: (text) => `\x1b[1;37m${text}\x1b[0m`,
  link: (text) => `\x1b[38;5;39m${text}\x1b[0m`,
  linkUrl: (text) => `\x1b[38;5;39;4m${text}\x1b[0m`,
  code: (text) => `\x1b[48;5;236;38;5;203m${text}\x1b[0m`,
  codeBlock: (text) => `\x1b[48;5;236m${text}\x1b[0m`,
  codeBlockBorder: (text) => `\x1b[90m${text}\x1b[0m`,
  quote: (text) => `\x1b[90m${text}\x1b[0m`,
  quoteBorder: (text) => `\x1b[90m│\x1b[0m`,
  hr: () => `\x1b[90m──────────────────────────────────────\x1b[0m`,
  listBullet: (text) => `\x1b[33m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  italic: (text) => `\x1b[3m${text}\x1b[0m`,
  strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
  underline: (text) => `\x1b[4m${text}\x1b[0m`,
};

// ============================================================================
// ANSI 颜色常量
// ============================================================================

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",

  // 角色颜色
  userFg: "\x1b[34m",           // 蓝色
  userBg: "\x1b[44m",           // 蓝底
  aiFg: "\x1b[32m",             // 绿色
  aiBg: "\x1b[42m",             // 绿底
  toolFg: "\x1b[33m",           // 黄色
  toolBg: "\x1b[43m",           // 黄底
  resultFg: "\x1b[90m",         // 灰色
  titleBg: "\x1b[100m",         // 标题栏灰底

  // 分隔线
  sep: "\x1b[90m",
} as const;

// ============================================================================
// TitleBar — 参考 pi-coding-agent 的顶部栏
// ============================================================================

export type StatusType = "idle" | "streaming" | "error";

export class TitleBar implements Component {
  statusText = "Ready";
  statusType: StatusType = "idle";
  modelLabel = "";

  invalidate(): void {}

  setStatus(text: string, type: StatusType = "idle"): void {
    this.statusText = text;
    this.statusType = type;
  }

  render(width: number): string[] {
    const dot =
      this.statusType === "streaming" ? `${C.yellow}●${C.reset}` :
      this.statusType === "error" ? `${C.red}●${C.reset}` :
      `${C.green}●${C.reset}`;

    const left = `${dot} ${this.statusText}`;

    const rightParts: string[] = [];
    if (this.modelLabel) rightParts.push(`${C.dim}${this.modelLabel}${C.reset}`);
    const right = rightParts.join("  ");

    // 用 ╭─ ╮ 装饰顶部
    const prefix = `${C.dim}╭─${C.reset} `;
    const prefixLen = visibleWidth(prefix);
    const leftLen = visibleWidth(left);
    const rightLen = visibleWidth(right);

    const innerWidth = width - prefixLen;
    const contentWidth = leftLen + (rightLen > 0 ? 2 + rightLen : 0);
    const padding = innerWidth > contentWidth ? " ".repeat(innerWidth - contentWidth) : "";

    const line = `${prefix}${left}${padding}${right ? "  " + right : ""}`;
    return [line];
  }
}

// ============================================================================
// Footer — 显示底部信息（当前工作目录）
// ============================================================================

export class Footer implements Component {
  text = "";
  commandHint = "";

  invalidate(): void {}

  render(width: number): string[] {
    if (this.commandHint) {
      const hint = this.commandHint + " ".repeat(Math.max(0, width - visibleWidth(this.commandHint)));
      return [hint];
    }
    if (!this.text) {
      const base = `${C.dim}╰─ ❯ ${C.reset}`;
      const baseLen = visibleWidth(base);
      const sep = `${C.dim}─${C.reset}`.repeat(Math.max(0, width - baseLen));
      return [base + sep];
    }
    const line = `${C.dim}╰─ ❯ ${this.text}${C.reset}`;
    const lineLen = visibleWidth(line);
    if (lineLen > width) return [line.slice(0, width - 3) + "..."];
    const sep = `${C.dim}─${C.reset}`.repeat(Math.max(0, width - lineLen));
    return [line + sep];
  }
}

// ============================================================================
// 消息渲染
// ============================================================================

function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** 角色横幅：`┊  ── 角色 ──  时间` */
function roleBanner(label: string, color: string, timestamp?: number): string {
  const timeStr = formatTimestamp(timestamp);
  const padded = `  ${label}  `;
  return `${color}┊${C.reset}${color}${C.bold}${padded}${C.reset}${C.dim}${C.sep}──${C.reset}${C.dim}  ${timeStr}${C.reset}`;
}

/** 左侧竖线缩进 */
function indent(color: string, lines: string[]): string[] {
  return lines.map((l) => `${color}┊${C.reset}  ${l}`);
}

/** 空行（含竖线） */
function emptyLine(color: string): string {
  return `${color}┊${C.reset}`;
}

export class MessageList implements Component {
  private _messages: AgentMessage[] = [];
  private maxLines: number;
  private toolResultPreviewLength: number;
  private mdTheme: MarkdownTheme;
  private mdCache = new WeakMap<object, Markdown>();

  /** 消息折叠阈值行数（0 = 不折叠） */
  foldThreshold = 8;
  /** 全局展开模式（true = 所有消息展开） */
  expandAll = false;

  /** 正在流式构建中的 assistant message */
  streamingMessage: { text: string } | null = null;

  constructor(opts: { maxLines?: number; toolResultPreviewLength?: number; mdTheme?: MarkdownTheme } = {}) {
    this.maxLines = opts.maxLines ?? 1000;
    this.toolResultPreviewLength = opts.toolResultPreviewLength ?? 120;
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
      lines.push(""); // 消息间空行分隔
    }

    // 流式中的 AI 消息
    if (this.streamingMessage && this.streamingMessage.text) {
      this.renderStreamingAI(width, lines);
      lines.push("");
    }

    // 行数限制 — 从末尾保留 maxLines 行
    if (lines.length > this.maxLines) {
      const folded = lines.length - this.maxLines;
      return [
        `${C.dim}... (${folded} lines folded)${C.reset}`,
        ...lines.slice(lines.length - this.maxLines + 1),
      ];
    }

    return lines;
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
      const rendered = md.render(width - 4); // -4 for "┊  "
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
        const rendered = md.render(width - 4);
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
      mdLines.push(`${C.yellow}${C.bold}⚡ ${tc.name}${C.reset} ${C.dim}${argsPreview}${C.reset}`);
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
      const rendered = md.render(width - 4);
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
      const preview = firstLine.length > this.toolResultPreviewLength
        ? firstLine.slice(0, this.toolResultPreviewLength) + "..."
        : firstLine;

      out.push(`${C.green}┊${C.reset}  ${C.green}${C.bold}✓${C.reset} ${C.dim}${preview}${C.reset}`);
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

// ============================================================================
// InputBar
// ============================================================================

export interface InputBarOptions {
  placeholder?: string;
}

export class InputBar {
  readonly input: Input;

  onSubmit?: (text: string) => void;
  onCancel?: () => void;

  constructor(opts: InputBarOptions = {}) {
    this.input = new Input();
    this.input.onSubmit = (text: string) => this.onSubmit?.(text);
    this.input.onEscape = () => this.onCancel?.();
  }

  getValue(): string {
    return this.input.getValue();
  }

  clear(): void {
    this.input.setValue("");
  }
}

// ============================================================================
// ChatTUI — 一键创建 pi-coding-agent 风格 TUI
// ============================================================================

export interface ChatTUI {
  tui: TUI;
  messageList: MessageList;
  titleBar: TitleBar;
  footer: Footer;
  inputBar: InputBar;
  updateMessages: (messages: AgentMessage[]) => void;
  appendStreamingDelta: (delta: string) => void;
  setStatus: (text: string, type?: StatusType) => void;
  stop: () => void;
}

export interface CreateChatTUIOptions {
  modelLabel?: string;
  cwd?: string;
  onCtrlC?: (chat: ChatTUI) => boolean | void;
}

/**
 * createChatTUI — 按 pi-coding-agent 风格创建 TUI
 *
 * 布局（从上到下）：
 *   TitleBar      — ● Ready [gpt-4o]
 *   MessageList   — 角色竖线消息流
 *   Footer        — ❯ 当前工作目录
 *   Input         — 底部输入行
 */
export function createChatTUI(opts: CreateChatTUIOptions = {}): ChatTUI {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const messageList = new MessageList();
  const titleBar = new TitleBar();
  const footer = new Footer();
  const inputBar = new InputBar();

  // 输入历史（方向键导航）
  const inputHistory: string[] = [];
  let historyIndex = -1;
  let historySavedValue = "";

  // 包装 input.onSubmit 记录 history
  const origOnSubmit = inputBar.input.onSubmit;
  inputBar.input.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== trimmed)) {
      inputHistory.push(trimmed);
    }
    historyIndex = -1;
    historySavedValue = "";
    origOnSubmit?.(text);
  };

  function historyPrev(): void {
    if (inputHistory.length === 0) return;
    if (historyIndex < 0) {
      // 第一次按下，保存当前输入
      historySavedValue = inputBar.input.getValue();
      historyIndex = inputHistory.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    } else {
      return; // 已经在最旧记录
    }
    inputBar.input.setValue(inputHistory[historyIndex]!);
    tui.requestRender();
  }

  function historyNext(): void {
    if (historyIndex < 0) return;
    if (historyIndex < inputHistory.length - 1) {
      historyIndex++;
      inputBar.input.setValue(inputHistory[historyIndex]!);
    } else {
      // 到达最新记录，恢复保存的值
      historyIndex = -1;
      inputBar.input.setValue(historySavedValue);
    }
    tui.requestRender();
  }

  if (opts.modelLabel) {
    titleBar.modelLabel = opts.modelLabel;
  }
  if (opts.cwd) {
    footer.text = opts.cwd;
  }

  // Layout: TitleBar → MessageList → Footer → Input
  tui.addChild(titleBar);
  tui.addChild(messageList);
  tui.addChild(footer);
  tui.addChild(inputBar.input);

  // Ctrl+C + 指令提示
  tui.addInputListener((data: string) => {
    if (matchesKey(data, "ctrl+c")) {
      const handled = opts.onCtrlC?.(chat);
      if (!handled) {
        tui.stop();
        process.exit(0);
      }
      return undefined;
    }

    // Ctrl+O 切换折叠/展开所有 AI 消息
    if (matchesKey(data, "ctrl+o")) {
      messageList.expandAll = !messageList.expandAll;
      titleBar.modelLabel = messageList.expandAll
        ? `${opts.modelLabel ?? ""} ${C.green}[Exp]${C.reset}`
        : opts.modelLabel ?? "";
      tui.requestRender();
      return undefined;
    }

    // Ctrl+P / Ctrl+N 输入历史导航
    if (matchesKey(data, "ctrl+p")) {
      historyPrev();
      return undefined;
    }
    if (matchesKey(data, "ctrl+n")) {
      historyNext();
      return undefined;
    }

    // 输入 / 开头时显示命令提示
    // 延迟检查，让 Input 组件先处理字符
    setTimeout(() => {
      const inputText = inputBar.input.getValue();
      if (inputText.startsWith("/")) {
        const cmds = [
          "/exit", "/help", "/clear", "/model",
          "/tokens", "/ctx", "/compact",
          "/sessions", "/session",
          "/tree", "/fork",
        ];
        const matched = cmds.filter((c) => c.startsWith(inputText));
        if (matched.length > 0) {
          footer.commandHint = `${C.yellow}${matched.join("  ")}${C.reset}`;
        } else {
          footer.commandHint = `${C.dim}Unknown command. Type /help${C.reset}`;
        }
        tui.requestRender();
      } else {
        if (footer.commandHint) {
          footer.commandHint = "";
          tui.requestRender();
        }
      }
    }, 0);
    return undefined;
  });

  tui.setFocus(inputBar.input);

  const chat: ChatTUI = {
    tui,
    messageList,
    titleBar,
    footer,
    inputBar,
    updateMessages(messages: AgentMessage[]) {
      messageList.messages = messages;
      messageList.streamingMessage = null;
      tui.requestRender();
    },
    appendStreamingDelta(delta: string) {
      if (!messageList.streamingMessage) {
        messageList.streamingMessage = { text: "" };
      }
      messageList.streamingMessage.text += delta;
      tui.requestRender();
    },
    setStatus(text: string, type: StatusType = "idle") {
      titleBar.setStatus(text, type);
      tui.requestRender();
    },
    stop() {
      tui.stop();
    },
  };

  return chat;
}
