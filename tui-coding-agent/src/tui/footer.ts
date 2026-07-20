/**
 * Footer — 底部信息栏
 *
 * 显示当前工作目录：
 *   ╰─ ❯ /workspace/project ────────────────
 *
 * 或命令提示：
 *   ❯ search
 */

import { visibleWidth, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { C } from "./theme.js";

export class Footer implements Component {
  text = "";
  commandHint = "";

  invalidate(): void {}

  render(width: number): string[] {
    // 命令提示模式
    if (this.commandHint) {
      const hintStr = `${C.cyan}${this.commandHint}${C.reset}`;
      const hintWidth = visibleWidth(hintStr);
      if (hintWidth >= width) {
        return [truncateToWidth(hintStr, width)];
      }
      return [hintStr + " ".repeat(width - hintWidth)];
    }

    // 有工作目录
    if (this.text) {
      const prefix = `${C.dim}╰─ ❯ ${C.reset}`;
      const dirText = `${C.cyan}${this.text}${C.reset}`;
      const line = prefix + dirText;
      const lineLen = visibleWidth(line);
      if (lineLen > width) {
        return [truncateToWidth(line, width)];
      }
      const sep = `${C.dim}─${C.reset}`.repeat(Math.max(0, width - lineLen));
      return [truncateToWidth(line + sep, width)];
    }

    // 空状态
    const base = `${C.dim}╰─ ❯ ${C.reset}`;
    const baseLen = visibleWidth(base);
    const sep = `${C.dim}─${C.reset}`.repeat(Math.max(0, width - baseLen));
    return [truncateToWidth(base + sep, width)];
  }
}
