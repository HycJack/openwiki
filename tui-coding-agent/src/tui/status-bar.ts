/**
 * StatusBar — 输入框下方的状态栏
 *
 * 显示：
 *   ● Ready  gpt-4o
 *   ● Streaming...
 *   ● Error: ...
 *
 * 左侧状态圆点带颜色，右侧显示模型名。
 */

import { visibleWidth, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { C } from "./theme.js";
import type { StatusType } from "./types.js";

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

    const statusStyle =
      this.statusType === "streaming" ? `${C.yellow}` :
      this.statusType === "error" ? `${C.red}` :
      `${C.green}`;

    const left = `${dot} ${statusStyle}${this.statusText}${C.reset}`;
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
