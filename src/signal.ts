// 极简信号实现（无框架依赖）：
// - get/set/update 读写值；subscribe 订阅变更（返回取消函数）。
// - set 用 Object.is 判等：值不变不通知（重复置 true 只通知一次）。
// - 订阅者同步执行，适合驱动 DOM 更新；列表类重渲染由消费方自行合并（见 sidebar 的微任务合并）。

export type Unsubscribe = () => void;
export type Subscriber<T> = (value: T, prev: T) => void;

export interface Signal<T> {
  get(): T;
  set(value: T): void;
  update(fn: (value: T) => T): void;
  subscribe(fn: Subscriber<T>): Unsubscribe;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<Subscriber<T>>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      const prev = value;
      value = next;
      for (const fn of subscribers) fn(next, prev);
    },
    update(fn) {
      const next = fn(value);
      if (Object.is(next, value)) return;
      const prev = value;
      value = next;
      for (const fn2 of subscribers) fn2(next, prev);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

/** 把一批信号订阅指向同一个处理函数（返回统一取消函数） */
export function subscribeAll(
  subs: Array<() => Unsubscribe>,
): Unsubscribe {
  const unsubs = subs.map((s) => s());
  return () => unsubs.forEach((u) => u());
}

/** 微任务级合并：同一轮 tick 内任意信号变化只触发一次重渲染 */
export function coalesceByMicrotask(run: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => {
      scheduled = false;
      run();
    });
  };
}
