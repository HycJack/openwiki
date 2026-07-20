/**
 * TitleBar — 顶部边框装饰
 *
 * 渲染类似：
 *   ╭──────────────────────────────────────╮
 */

import { visibleWidth, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { C } from "./theme.js";

export class TitleBar implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    const prefix = `${C.dim}╭${C.reset}`;
    const suffix = `${C.dim}╮${C.reset}`;
    const prefixLen = visibleWidth(prefix);
    const suffixLen = visibleWidth(suffix);
    const sepWidth = Math.max(0, width - prefixLen - suffixLen);
    const sep = `${C.dim}${"─".repeat(sepWidth)}${C.reset}`;
    return [truncateToWidth(`${prefix}${sep}${suffix}`, width)];
  }
}
