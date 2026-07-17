/**
 * Chat TUI — 基于 pi-tui 的可复用聊天组件库
 *
 * 参考 pi-coding-agent 设计，提供：
 * - TitleBar      顶部边框装饰
 * - MessageList   消息流（角色竖线 + 横幅）
 * - Footer        底部信息栏（当前工作目录）
 * - InputBar      输入框（提交/取消回调）
 * - StatusBar     输入框下方状态栏（状态圆点 + 模型名）
 * - createChatTUI 一键创建入口
 */

export { MessageList, TitleBar, Footer, InputBar, StatusBar, createChatTUI, defaultMDTheme } from "./component.js";
export type {
  StatusType,
  InputBarOptions,
  ChatTUI,
  CreateChatTUIOptions,
} from "./component.js";
