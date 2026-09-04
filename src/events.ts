// 类型化事件总线：仅承载低频跨模块生命周期事件（区别于 state.ts 的持续状态）。
// 每键编辑热路径不使用本总线，见 pipeline.ts 的同步直连。

export interface AppEventMap {
  /** 打开/切换文档完成（模型已重载、编辑器已显示） */
  "doc:loaded": { title: string; path: string };
  /** 关闭当前编辑对象完成 */
  "doc:closed": undefined;
  /** 界面语言切换完成（需要刷新文案的模块订阅） */
  "app:locale": undefined;
}

type Handler<K extends keyof AppEventMap> = (payload: AppEventMap[K]) => void;

class EventBus {
  private handlers = new Map<keyof AppEventMap, Set<Handler<never>>>();

  on<K extends keyof AppEventMap>(key: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof AppEventMap>(key: K, payload: AppEventMap[K]): void {
    const set = this.handlers.get(key);
    if (!set) return;
    for (const fn of set) (fn as Handler<K>)(payload);
  }
}

export const bus = new EventBus();
