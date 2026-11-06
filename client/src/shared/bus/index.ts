/**
 * 模块间事件总线（D01 §12.2 规则 1：features 禁止横向 import，跨模块只走 bus 或 app 组合层）。
 * 类型安全：各 feature 在自己的 events.ts 中通过 declare module 扩充 BusEvents（声明合并）。
 */

export interface BusEvents {
  // 基础事件在此登记；业务事件由 features/*/**/events.ts 扩充
}

type Handler<T> = (payload: T) => void;

const handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

/** 广播事件（类型安全：事件名与载荷必须与 BusEvents 登记一致） */
export function emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
  handlers.get(event)?.forEach((h) => (h as Handler<BusEvents[K]>)(payload));
}

/** 订阅事件，返回取消订阅函数 */
export function on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const erased = handler as Handler<never>;
  set.add(erased);
  return () => set.delete(erased);
}
