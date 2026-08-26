// 基准 Facade：对「编辑管线 + 视图」的稳定操作接口。
// 重构前后的接线（wiring-before / wiring-after）都实现同一接口，
// 保证场景 runner 跑的是完全相同的用户可见操作。

import type { EditorView } from "@codemirror/view";

export interface BenchDoc {
  title: string;
  path: string;
  content: string;
}

export interface BenchFacade {
  readonly arch: string;
  /** 初始化编辑器/虚拟预览/大纲/滚动同步（不含数据加载） */
  init(): Promise<void>;
  editorView(): EditorView;
  previewScrollEl(): HTMLElement;
  editorScrollEl(): HTMLElement;
  setViewMode(mode: "edit" | "split" | "preview"): void;
  /** 打开/切换文档（等价于主应用 selectSource -> openInEditor 路径） */
  openDoc(doc: BenchDoc): Promise<void>;
  closeDoc(): void;
  /** 侧栏列表：填充笔记数据并渲染一次 */
  setupList(notes: unknown[]): void;
  /** 模拟一次自动保存后的笔记元信息更新（updateListAfterSave 路径） */
  listUpdateAfterSave(meta: unknown): void;
}

/* ---------- 计时工具 ---------- */

export function raf(): Promise<void> {
  return Promise.resolve();
}

/** 等待若干“逻辑帧”：在基准里只让微任务队列清空；真实渲染的延迟另由 wait 计时。 */
export async function settle(frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++) await Promise.resolve();
}

export interface TimingStats {
  n: number;
  unit: string;
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export interface BenchResults {
  arch: string;
  meta: {
    time: string;
    ua: string;
    viewport: string;
    dpr: number;
    docMedium: string;
    docLarge: string;
  };
  scenarios: Record<string, TimingStats>;
}

export function stats(list: number[], unit = "ms"): TimingStats {
  const sorted = [...list].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * (n - 1)))];
  return {
    n,
    unit,
    mean: round3(mean),
    median: round3(at(0.5)),
    p95: round3(at(0.95)),
    min: round3(sorted[0]),
    max: round3(sorted[n - 1]),
  };
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 在同一次 tick 内多次更新（测信号合并）后等待渲染落地 */
export async function settleList(frames = 3): Promise<void> {
  await settle(frames);
}
