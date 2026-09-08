// 基准 Facade：对「编辑管线 + 即时渲染 + 侧栏信号」的稳定操作接口。
// 接线（wiring.ts）直接复用生产模块（pipeline/outline/sidebar），场景 runner 不感知架构差异。
// 旧的预览/视图模式 API（setViewMode/previewScrollEl）已随即时渲染上线移除。

import type { EditorView } from "@codemirror/view";

export interface BenchDoc {
  title: string;
  path: string;
  content: string;
}

export interface BenchFacade {
  readonly arch: string;
  /** 初始化编辑管线/大纲/侧栏（不含数据加载） */
  init(): Promise<void> | void;
  editorView(): EditorView;
  /** 即时渲染开关（与生产设置项 annal:live-render 同一路径），作为装饰层成本的对照 */
  setLiveRender(on: boolean): void;
  /** 打开/切换文档（等价于主应用 selectSource -> openInEditor 路径） */
  openDoc(doc: BenchDoc): void;
  closeDoc(): void;
  /** 侧栏列表：填充笔记数据并渲染一次 */
  setupList(notes: unknown[]): void;
  /** 模拟一次自动保存后的笔记元信息更新（writeSnapshot -> notes.set 路径） */
  listUpdateAfterSave(meta: unknown): void;
}

/* ---------- 计时工具 ---------- */

let rafMode: "raf" | "timer" | null = null;

/** 探测 rAF 是否可用（后台/自动化环境会把 rAF 节流到 0）；不可用则用定时器兜底 */
function detectRafMode(): Promise<"raf" | "timer"> {
  if (rafMode) return Promise.resolve(rafMode);
  return new Promise((resolve) => {
    let got = false;
    requestAnimationFrame(() => {
      got = true;
      rafMode = "raf";
      resolve("raf");
    });
    setTimeout(() => {
      if (!got) {
        rafMode = "timer";
        resolve("timer");
      }
    }, 300);
  });
}

/** 一个"逻辑帧"：rAF 正常时等动画帧；rAF 被暂停或时断时续时退化为定时器。
 *  每帧都带兜底，且检测到慢帧（>250ms）就把模式永久降级为定时器，避免死等。 */
export async function frame(): Promise<void> {
  if (rafMode === "timer") {
    await new Promise((resolve) => setTimeout(resolve, 16));
    return;
  }
  await detectRafMode();
  if (rafMode === "timer") {
    await new Promise((resolve) => setTimeout(resolve, 16));
    return;
  }
  const t0 = performance.now();
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 1000);
  });
  if (performance.now() - t0 > 250) rafMode = "timer";
}

/** 等待若干逻辑帧 */
export async function frames(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

/** 等待若干微任务：信号合并（coalesceByMicrotask）在微任务边界落地 */
export async function settle(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** 强制同步执行 CM 的 measure 阶段（视口计算 + viewportChanged 插件更新 + DOM 同步）。
 *  正常浏览器里它随 rAF 自动发生；rAF 被暂停的环境里必须显式调用，
 *  否则视口永远不会建立、viewportChanged 永远不会触发。 */
export function forceMeasure(v: EditorView): void {
  v.requestMeasure();
  v.readMeasured();
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
    liveRender: boolean;
    docMedium: string;
    docLarge: string;
    docPlain: string;
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
