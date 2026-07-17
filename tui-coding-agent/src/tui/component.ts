/**
 * Chat TUI — 参考 pi-coding-agent 的 TUI 布局
 *
 * 布局：
 * ```
 * ╭──────────────────────────────────────────────────────╮  ← TitleBar（边框）
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
 * ╰─ ❯ /workspace/project ─────────────────────────────  ← Footer（工作目录）
 * > input cursor                                          ← Input
 * ● Ready  gpt-4o                                         ← StatusBar（状态+模型）
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
  truncateToWidth,
  type Component,
  type MarkdownTheme,
  type OverlayHandle,
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
// TitleBar — 顶部边框装饰
// ============================================================================

export type StatusType = "idle" | "streaming" | "error";

export class TitleBar implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    // 顶部边框：╭──────...──╮
    const prefix = `${C.dim}╭${C.reset}`;
    const suffix = `${C.dim}╮${C.reset}`;
    const prefixLen = visibleWidth(prefix);
    const suffixLen = visibleWidth(suffix);
    const sepWidth = Math.max(0, width - prefixLen - suffixLen);
    const sep = `${C.dim}${"─".repeat(sepWidth)}${C.reset}`;
    return [truncateToWidth(`${prefix}${sep}${suffix}`, width)];
  }
}

// ============================================================================
// StatusBar — 输入框下方的状态栏（状态点 + 状态文本 + 模型名）
// ============================================================================

export class StatusBar implements Component {
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
    const right = this.modelLabel ? `${C.dim}${this.modelLabel}${C.reset}` : "";

    const leftLen = visibleWidth(left);
    const rightLen = visibleWidth(right);
    const gap = rightLen > 0 ? 2 : 0;
    const contentWidth = leftLen + gap + rightLen;
    const padding = width > contentWidth ? " ".repeat(width - contentWidth) : "";

    const line = `${left}${padding}${right ? "  " + right : ""}`;
    return [truncateToWidth(line, width)];
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
      const hintWidth = visibleWidth(this.commandHint);
      const hint = hintWidth >= width
        ? truncateToWidth(this.commandHint, width)
        : this.commandHint + " ".repeat(width - hintWidth);
      return [hint];
    }
    if (!this.text) {
      const base = `${C.dim}╰─ ❯ ${C.reset}`;
      const baseLen = visibleWidth(base);
      const sep = `${C.dim}─${C.reset}`.repeat(Math.max(0, width - baseLen));
      return [truncateToWidth(base + sep, width)];
    }
    const line = `${C.dim}╰─ ❯ ${this.text}${C.reset}`;
    const lineLen = visibleWidth(line);
    if (lineLen > width) return [truncateToWidth(line, width)];
    const sep = `${C.dim}─${C.reset}`.repeat(Math.max(0, width - lineLen));
    return [truncateToWidth(line + sep, width)];
  }
}

// ============================================================================
// CommandPalette — 命令选择弹出层
// ============================================================================

export interface CommandPaletteItem {
  name: string;
  description?: string;
}

/**
 * 命令选择列表，适配 TUI Component 接口。
 * 可作为 overlay 使用，支持 ↑↓ 导航、Enter 选择、Esc 取消。
 *
 * 支持临时覆盖 onSelect/onCancel：在显示 overlay 前设置 override，
 * handleInput 完成后自动清除（一次性的），避免污染后续复用。
 */
export class CommandPalette implements Component {
  private allItems: CommandPaletteItem[] = [];
  private filtered: { value: string; label: string; description?: string }[] = [];
  private selectedIndex = 0;
  private _filterText = "";

  /** 选中回调（永久） */
  onSelect?: (name: string) => void;
  /** 取消回调（永久） */
  onCancel?: () => void;

  /** 临时覆盖 onSelect（一次性的，触发后自动清除） */
  onSelectOverride?: ((name: string) => void) | null;
  /** 临时覆盖 onCancel（一次性的，触发后自动清除） */
  onCancelOverride?: (() => void) | null;

  /** 请求重绘（由 TUI 绑定） */
  requestRender: (() => void) | null = null;

  setCommands(cmds: CommandPaletteItem[]): void {
    this.allItems = cmds;
    this.applyFilter();
  }

  /** 设置 filter 文本 */
  setFilter(text: string): void {
    this._filterText = text;
    this.applyFilter();
    if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    }
  }

  private applyFilter(): void {
    const ft = this._filterText;
    this.filtered = this.allItems
      .filter((c) => !ft || c.name.includes(ft) || (c.description?.includes(ft)))
      .map((c) => ({ value: c.name, label: c.name, description: c.description }));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maxH = Math.min(this.filtered.length, 10);
    if (maxH === 0) {
      return [` ${C.dim}No matching commands${C.reset}`];
    }

    const lines: string[] = [];
    const start = Math.max(0, this.selectedIndex - 4);
    const end = Math.min(this.filtered.length, start + 10);
    const visible = this.filtered.slice(start, end);

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const isSelected = start + i === this.selectedIndex;
      const prefix = isSelected ? `${C.cyan}▸${C.reset} ` : "  ";
      const label = isSelected ? `${C.cyan}${item.label}${C.reset}` : item.label;
      const desc = item.description ? ` ${C.gray}${item.description}${C.reset}` : "";
      const line = prefix + label + desc;
      lines.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line);
    }

    // 滚动提示
    if (this.filtered.length > end) {
      lines.push(` ${C.dim}↓ ${this.filtered.length - end} more${C.reset}`);
    }

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (this.selectedIndex < this.filtered.length - 1) {
        this.selectedIndex++;
        this.requestRender?.();
      }
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.requestRender?.();
      }
      return;
    }
    if (matchesKey(data, "enter")) {
      const sel = this.filtered[this.selectedIndex];
      if (sel) {
        const cb = this.onSelectOverride ?? this.onSelect;
        this.onSelectOverride = null;
        cb?.(sel.value);
      }
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      const cb = this.onCancelOverride ?? this.onCancel;
      this.onCancelOverride = null;
      cb?.();
      return;
    }
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
      const foldedLine = `${C.dim}... (${folded} lines folded)${C.reset}`;
      const kept = lines.slice(lines.length - this.maxLines + 1);
      // 截断所有行到终端宽度，防止 Markdown 代码块等长行超宽
      return [truncateToWidth(foldedLine, width), ...kept.map((l) => truncateToWidth(l, width))];
    }

    // 截断所有行到终端宽度，防止 Markdown 代码块等长行超宽
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
      // 按可见宽度截断 preview，预留前缀 "┊  ✓ " 的空间
      const preview = visibleWidth(firstLine) > this.toolResultPreviewLength
        ? truncateToWidth(firstLine, this.toolResultPreviewLength)
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
  statusBar: StatusBar;
  commandPalette: CommandPalette;
  updateMessages: (messages: AgentMessage[]) => void;
  appendStreamingDelta: (delta: string) => void;
  setStatus: (text: string, type?: StatusType) => void;
  setModelLabel: (label: string) => void;
  /** 显示命令选择弹出层 */
  showCommandPalette: (commands: CommandPaletteItem[], options?: { onSelect?: (name: string) => void; onCancel?: () => void }) => void;
  /** 隐藏命令选择弹出层 */
  hideCommandPalette: () => void;
  /** 设置命令选择弹出层的 filter 文本 */
  setCommandFilter: (text: string) => void;
  stop: () => void;
}

export interface CreateChatTUIOptions {
  modelLabel?: string;
  cwd?: string;
  /** 内置命令列表（用于命令选择弹出层） */
  commands?: CommandPaletteItem[];
  onCtrlC?: (chat: ChatTUI) => boolean | void;
}

/**
 * createChatTUI — 按 pi-coding-agent 风格创建 TUI
 *
 * 布局（从上到下）：
 *   TitleBar      — 顶部边框 ╭──╮
 *   MessageList   — 角色竖线消息流
 *   Footer        — ❯ 当前工作目录
 *   Input         — 底部输入行
 *   StatusBar     — ● Ready [gpt-4o]
 */
export function createChatTUI(opts: CreateChatTUIOptions = {}): ChatTUI {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const messageList = new MessageList();
  const titleBar = new TitleBar();
  const footer = new Footer();
  const inputBar = new InputBar();
  const statusBar = new StatusBar();

  // 命令选择面板
  const commandPalette = new CommandPalette();
  let commandOverlay: OverlayHandle | null = null;
  const defaultCommands = opts.commands ?? [];

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
      historySavedValue = inputBar.input.getValue();
      historyIndex = inputHistory.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    } else {
      return;
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
      historyIndex = -1;
      inputBar.input.setValue(historySavedValue);
    }
    tui.requestRender();
  }

  // 命令选择回调
  commandPalette.onSelect = (name: string) => {
    if (commandOverlay) {
      commandOverlay.hide();
      commandOverlay = null;
    }
    inputBar.input.setValue("/" + name + " ");
    tui.setFocus(inputBar.input);
    tui.requestRender();
  };
  commandPalette.onCancel = () => {
    if (commandOverlay) {
      commandOverlay.hide();
      commandOverlay = null;
    }
    tui.setFocus(inputBar.input);
    tui.requestRender();
  };

  // 绑定 CommandPalette 的重绘请求
  commandPalette.requestRender = () => tui.requestRender();

  if (opts.modelLabel) {
    statusBar.modelLabel = opts.modelLabel;
  }
  if (opts.cwd) {
    footer.text = opts.cwd;
  }

  // Layout: TitleBar → MessageList → Footer → Input → StatusBar
  tui.addChild(titleBar);
  tui.addChild(messageList);
  tui.addChild(footer);
  tui.addChild(inputBar.input);
  tui.addChild(statusBar);

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
      statusBar.modelLabel = messageList.expandAll
        ? `${opts.modelLabel ?? ""} ${C.green}[Exp]${C.reset}`
        : opts.modelLabel ?? "";
      tui.requestRender();
      return undefined;
    }

    // ↑/↓ 输入历史导航（仅在不显示命令面板时）
    if (!commandOverlay) {
      if (matchesKey(data, "up")) {
        historyPrev();
        return undefined;
      }
      if (matchesKey(data, "down")) {
        historyNext();
        return undefined;
      }
    }

    // 检测用户输入 "/" 时弹出命令选择面板
    setTimeout(() => {
      const inputText = inputBar.input.getValue();
      if (inputText === "/" && defaultCommands.length > 0 && !commandOverlay) {
        commandPalette.setCommands(defaultCommands);
        commandPalette.setFilter("");
        commandOverlay = tui.showOverlay(commandPalette, {
          anchor: "bottom-left",
          offsetX: 0,
          offsetY: -1, // 在输入框上方
          width: "50%",
          maxHeight: 12,
        });
        tui.requestRender();
      } else if (commandOverlay && !inputText.startsWith("/")) {
        // 用户删除了 "/"，关闭面板
        commandOverlay.hide();
        commandOverlay = null;
        tui.requestRender();
      } else if (commandOverlay && inputText.startsWith("/")) {
        // 更新 filter
        const filterText = inputText.slice(1); // 去掉 "/"
        commandPalette.setFilter(filterText);
        tui.requestRender();
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
    statusBar,
    commandPalette,
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
      statusBar.setStatus(text, type);
      tui.requestRender();
    },
    setModelLabel(label: string) {
      statusBar.modelLabel = label;
      tui.requestRender();
    },
    showCommandPalette(commands: CommandPaletteItem[], options?: { onSelect?: (name: string) => void; onCancel?: () => void }) {
      if (commandOverlay) {
        commandOverlay.hide();
        commandOverlay = null;
      }
      commandPalette.setCommands(commands);
      // 设置临时覆盖回调
      if (options?.onSelect) commandPalette.onSelectOverride = options.onSelect;
      if (options?.onCancel) commandPalette.onCancelOverride = options.onCancel;
      commandOverlay = tui.showOverlay(commandPalette, {
        anchor: "bottom-left",
        offsetX: 0,
        offsetY: -1,
        width: "50%",
        maxHeight: 12,
      });
      tui.requestRender();
    },
    hideCommandPalette() {
      if (commandOverlay) {
        commandOverlay.hide();
        commandOverlay = null;
        tui.requestRender();
      }
    },
    setCommandFilter(text: string) {
      commandPalette.setFilter(text);
      tui.requestRender();
    },
    stop() {
      tui.stop();
    },
  };

  return chat;
}
