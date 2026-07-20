/**
 * CommandPalette — 命令选择弹出层
 *
 * 当用户输入 "/" 时弹出，支持 ↑↓ 导航、Enter 选择、Esc 取消。
 * 支持 filter 过滤和临时覆盖回调。
 */

import { matchesKey, visibleWidth, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { C } from "./theme.js";

export interface CommandPaletteItem {
  name: string;
  description?: string;
}

export class CommandPalette implements Component {
  private allItems: CommandPaletteItem[] = [];
  private filtered: { value: string; label: string; description?: string }[] = [];
  private selectedIndex = 0;
  private _filterText = "";

  onSelect?: (name: string) => void;
  onCancel?: () => void;

  /** 临时覆盖（一次性的，触发后自动清除） */
  onSelectOverride?: ((name: string) => void) | null;
  onCancelOverride?: (() => void) | null;

  requestRender: (() => void) | null = null;

  setCommands(cmds: CommandPaletteItem[]): void {
    this.allItems = cmds;
    this.applyFilter();
  }

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

    // 顶部边框
    const lines: string[] = [];
    const title = `${C.dim} Commands ${"─".repeat(Math.max(0, width - 12))}${C.reset}`;
    lines.push(title);

    const start = Math.max(0, this.selectedIndex - 4);
    const end = Math.min(this.filtered.length, start + 10);
    const visible = this.filtered.slice(start, end);

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const isSelected = start + i === this.selectedIndex;
      const prefix = isSelected ? `${C.cyan}▸${C.reset} ` : "  ";
      const label = isSelected ? `${C.cyan}${item.label}${C.reset}` : `${C.white}${item.label}${C.reset}`;
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
