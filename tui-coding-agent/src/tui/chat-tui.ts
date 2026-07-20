/**
 * ChatTUI — 一键创建 pi-coding-agent 风格 TUI
 *
 * 布局（从上到下）：
 *   TitleBar      — ╭───────────────────────────╮
 *   MessageList   — ┊  User/AI 消息流
 *   Footer        — ╰─ ❯ /workspace
 *   Input         — > cursor
 *   StatusBar     — ● Ready  gpt-4o
 *
 * 功能：
 * - ↑↓ 输入历史导航
 * - Ctrl+O 折叠/展开 AI 消息
 * - / 触发命令选择面板
 * - Esc 取消当前 streaming
 * - Ctrl+C 中止/退出
 */

import {
  TUI,
  Input,
  ProcessTerminal,
  matchesKey,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "../types.js";
import { C } from "./theme.js";
import { TitleBar } from "./title-bar.js";
import { MessageList } from "./message-list.js";
import { Footer } from "./footer.js";
import { InputBar } from "./input-bar.js";
import { StatusBar } from "./status-bar.js";
import { CommandPalette } from "./command-palette.js";
import type { CommandPaletteItem } from "./command-palette.js";
import type { StatusType } from "./types.js";

// ============================================================================
// 接口
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
  showCommandPalette: (commands: CommandPaletteItem[], options?: { onSelect?: (name: string) => void; onCancel?: () => void }) => void;
  hideCommandPalette: () => void;
  setCommandFilter: (text: string) => void;
  stop: () => void;
}

export interface CreateChatTUIOptions {
  modelLabel?: string;
  cwd?: string;
  commands?: CommandPaletteItem[];
  onCtrlC?: (chat: ChatTUI) => boolean | void;
}

// ============================================================================
// createChatTUI
// ============================================================================

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

  // 包装 input.onSubmit 记录历史
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
          offsetY: -1,
          width: "50%",
          maxHeight: 12,
        });
        tui.requestRender();
      } else if (commandOverlay && !inputText.startsWith("/")) {
        commandOverlay.hide();
        commandOverlay = null;
        tui.requestRender();
      } else if (commandOverlay && inputText.startsWith("/")) {
        const filterText = inputText.slice(1);
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
