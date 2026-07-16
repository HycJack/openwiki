/**
 * EventBus — lightweight typed event emitter (pi-mono inspired)
 *
 * 用于跨组件通信，插件和核心系统之间的事件交换。
 * 参考 pi-mono createEventBus 设计。
 */

import type { EventBus as IEventBus, EventBusHandler } from "./types.js";

export function createEventBus(): IEventBus {
  const handlers = new Map<string, Set<EventBusHandler>>();

  return {
    on<T>(event: string, handler: EventBusHandler<T>): () => void {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as EventBusHandler);
      return () => {
        set?.delete(handler as EventBusHandler);
        if (set?.size === 0) handlers.delete(event);
      };
    },

    off<T>(event: string, handler: EventBusHandler<T>): void {
      const set = handlers.get(event);
      set?.delete(handler as EventBusHandler);
      if (set?.size === 0) handlers.delete(event);
    },

    emit<T>(event: string, data: T): void {
      const set = handlers.get(event);
      if (!set) return;
      for (const handler of set) {
        try {
          const result = handler(data);
          if (result && typeof result === "object" && "catch" in result) {
            (result as Promise<void>).catch(() => {});
          }
        } catch {
          // ignore handler errors
        }
      }
    },

    clear(): void {
      handlers.clear();
    },
  };
}
