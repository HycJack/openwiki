/**
 * TUI 主题与颜色常量
 *
 * 集中管理所有 ANSI 颜色、Markdown 主题和布局常量，
 * 方便整体调整外观。
 */

import type { MarkdownTheme } from "@earendil-works/pi-tui";

// ============================================================================
// ANSI 颜色
// ============================================================================

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",

  // Bright colors
  brightBlue: "\x1b[94m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",

  // Background
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgGray: "\x1b[100m",
  bgDark: "\x1b[48;5;235m",

  // 角色颜色
  userFg: "\x1b[38;5;75m",    // 亮蓝色
  userBg: "\x1b[44m",
  aiFg: "\x1b[38;5;83m",      // 亮绿色
  aiBg: "\x1b[42m",
  toolFg: "\x1b[38;5;221m",   // 暖黄色
  toolBg: "\x1b[43m",
  resultFg: "\x1b[90m",       // 灰色
  titleBg: "\x1b[100m",

  // 分隔线
  sep: "\x1b[90m",
} as const;

// ============================================================================
// Markdown 主题
// ============================================================================

export const defaultMDTheme: MarkdownTheme = {
  heading: (text) => `\x1b[1;38;5;231m${text}\x1b[0m`,
  link: (text) => `\x1b[38;5;39m${text}\x1b[0m`,
  linkUrl: (text) => `\x1b[38;5;39;4m${text}\x1b[0m`,
  code: (text) => `\x1b[48;5;236;38;5;203m${text}\x1b[0m`,
  codeBlock: (text) => `\x1b[48;5;235m${text}\x1b[0m`,
  codeBlockBorder: (text) => `\x1b[90m${text}\x1b[0m`,
  quote: (text) => `\x1b[90m${text}\x1b[0m`,
  quoteBorder: (text) => `\x1b[90m│\x1b[0m`,
  hr: () => `\x1b[90m──────────────────────────────────────\x1b[0m`,
  listBullet: (text) => `\x1b[38;5;221m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  italic: (text) => `\x1b[3m${text}\x1b[0m`,
  strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
  underline: (text) => `\x1b[4m${text}\x1b[0m`,
};

// ============================================================================
// 布局常量
// ============================================================================

/** 角色竖线左侧缩进宽度（包括竖线和空格） */
export const INDENT_WIDTH = 4;

/** Tool Result 预览最大长度 */
export const TOOL_RESULT_PREVIEW_LENGTH = 120;

/** 消息折叠阈值行数 */
export const FOLD_THRESHOLD = 8;

/** 消息列表最大行数 */
export const MAX_MESSAGE_LINES = 1000;

/** 摘要内容缩进级别 */
export const INDENT_LEVEL = 2;

/** 时间戳格式化 */
export function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${C.dim}${hh}:${mm}:${ss}${C.reset}`;
}
