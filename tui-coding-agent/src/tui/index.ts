/**
 * Chat TUI — 基于 pi-tui 的可复用聊天组件库
 *
 * 组件：
 * - TitleBar      顶部边框装饰
 * - MessageList   消息流（角色竖线 + 横幅）
 * - Footer        底部信息栏（当前工作目录）
 * - InputBar      输入框（提交/取消回调）
 * - StatusBar     输入框下方状态栏（状态圆点 + 模型名）
 * - CommandPalette 命令选择弹出层
 * - createChatTUI 一键创建入口
 */

export { TitleBar } from "./title-bar.js";
export { MessageList } from "./message-list.js";
export { Footer } from "./footer.js";
export { InputBar } from "./input-bar.js";
export { StatusBar } from "./status-bar.js";
export { CommandPalette } from "./command-palette.js";
export { createChatTUI } from "./chat-tui.js";
export { defaultMDTheme, C } from "./theme.js";

export type { StatusType } from "./types.js";
export type { InputBarOptions } from "./input-bar.js";
export type { CommandPaletteItem } from "./command-palette.js";
export type { ChatTUI, CreateChatTUIOptions } from "./chat-tui.js";
