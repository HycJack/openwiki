/**
 * EventBus — lightweight typed event emitter (pi-mono inspired)
 *
 * 用于跨组件通信，插件和核心系统之间的事件交换。
 * 参考 pi-mono createEventBus 设计。
 */

import type { EventBus as IEventBus, EventBusHandler } from "./types.js";

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof (value as Promise<unknown>).then === "function";
}

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
          if (isPromise(result)) {
            result.catch((err) => {
              console.error(`[EventBus] handler error for event "${event}":`, err instanceof Error ? err.message : String(err));
            });
          }
        } catch (err) {
          console.error(`[EventBus] handler error for event "${event}":`, err instanceof Error ? err.message : String(err));
        }
      }
    },

    clear(): void {
      handlers.clear();
    },
  };
}
