/**
 * InputBar — 输入框组件
 *
 * 包装 pi-tui 的 Input，提供 onSubmit/onCancel 回调。
 */

import { Input } from "@earendil-works/pi-tui";

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
