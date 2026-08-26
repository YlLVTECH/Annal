// 场景 runner：定义与架构无关的基准操作序列。
// 每个场景先预热（触发懒加载：highlight.js、初次布局等）再计时，取多次迭代的中位数/均值。

import type { EditorView } from "@codemirror/view";
import type { BenchFacade, BenchResults, TimingStats } from "./facade";
import { raf, settle, stats } from "./facade";
import { findParagraphLine, genDoc, genNotes, type FakeNote } from "./docs";

const docA = { title: "基准 A", path: "C:\\bench\\bench-a.md", content: genDoc(1001, 150) };
const docB = { title: "基准 B", path: "C:\\bench\\bench-b.md", content: genDoc(1002, 150) };
const docLarge = { title: "基准大文档", path: "C:\\bench\\bench-large.md", content: genDoc(2001, 800) };
const TYPING_CHARS = "基准输入性能测试文本xyzw01";

function paragraphLineNo(v: EditorView, content: string, frac: number): number {
  return findParagraphLine(content, frac);
}

/** 把编辑区滚动到目标行附近（分屏下滚动同步会带着预览一起到位） */
async function scrollToLine(f: BenchFacade, v: EditorView, lineNo: number) {
  const line = v.state.doc.line(lineNo + 1);
  v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  await settle(4);
}

async function openAndScroll(
  f: BenchFacade,
  doc: typeof docA,
  frac: number,
): Promise<{ v: EditorView; lineNo: number; pos: number }> {
  await f.openDoc(doc);
  await settle(4);
  const v = f.editorView();
  const lineNo = paragraphLineNo(v, doc.content, frac);
  await scrollToLine(f, v, lineNo);
  const line = v.state.doc.line(lineNo + 1);
  return { v, lineNo, pos: line.from + Math.floor(line.length / 2) };
}

export type ProgressFn = (name: string, index: number, total: number) => void;

const SCENARIO_TOTAL = 13;

export async function runAll(
  f: BenchFacade,
  onProgress?: ProgressFn,
): Promise<BenchResults> {
  const scenarios: Record<string, TimingStats> = {};
  const add = (name: string, list: number[]) => {
    scenarios[name] = stats(list);
  };
  const single = (name: string, v: number) => add(name, [v]);
  let scenarioIndex = 0;
  const begin = (name: string) => {
    scenarioIndex++;
    onProgress?.(name, scenarioIndex, SCENARIO_TOTAL);
  };

  /* 1. 冷启动初始化（编辑器 + 预览 + 大纲 + 滚动同步 + 侧栏） */
  {
    begin("init_cold");
    const t0 = performance.now();
    await f.init();
    single("init_cold", performance.now() - t0);
  }

  /* 2. 打开中等文档（150 块）：模型全量解析 + 首屏渲染 */
  {
    begin("openDoc_medium");
    for (const doc of [docA, docB, docA]) {
      await f.openDoc(doc);
      await settle(2);
    }
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      onProgress?.(`openDoc_medium ${i + 1}/12`, scenarioIndex, SCENARIO_TOTAL);
      const doc = i % 2 === 0 ? docA : docB;
      const t0 = performance.now();
      await f.openDoc(doc);
      await settle(3);
      times.push(performance.now() - t0);
    }
    add("openDoc_medium", times);
  }

  /* 3. 打开大文档（800 块） */
  {
    begin("openDoc_large");
    await f.openDoc(docLarge);
    await settle(4);
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      const doc = i % 2 === 0 ? docLarge : docA;
      const t0 = performance.now();
      await f.openDoc(doc);
      await settle(3);
      times.push(performance.now() - t0);
    }
    add("openDoc_large", times);
  }

  /* 4. 分屏打字热路径（单块快速路径）：每次 dispatch 的同步耗时 */
  {
    begin("typeSync_medium");
    f.setViewMode("split");
    const { v, pos } = await openAndScroll(f, docA, 0.4);
    const times: number[] = [];
    let p = pos;
    for (let i = 0; i < 48; i++) {
      const ch = TYPING_CHARS[i % TYPING_CHARS.length];
      const t0 = performance.now();
      v.dispatch({ changes: { from: p, insert: ch } });
      times.push(performance.now() - t0);
      p += 1;
      if (i % 4 === 3) await raf(); // 让渲染跟上，模拟真实打字节奏
    }
    add("typeSync_medium", times);
  }

  /* 5. 大文档分屏打字（40% 处） */
  {
    begin("typeSync_large");
    const { v, pos } = await openAndScroll(f, docLarge, 0.4);
    const times: number[] = [];
    let p = pos;
    for (let i = 0; i < 48; i++) {
      const ch = TYPING_CHARS[i % TYPING_CHARS.length];
      const t0 = performance.now();
      v.dispatch({ changes: { from: p, insert: ch } });
      times.push(performance.now() - t0);
      p += 1;
      if (i % 4 === 3) await raf();
    }
    add("typeSync_large", times);
  }

  /* 6. 文档末尾连续追加（尾部 splice 路径） */
  {
    begin("typeSync_tail");
    f.setViewMode("split");
    await f.openDoc(docA);
    await settle(4);
    const v = f.editorView();
    v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
    await settle(4);
    const times: number[] = [];
    let p = v.state.doc.length;
    for (let i = 0; i < 48; i++) {
      const ch = TYPING_CHARS[i % TYPING_CHARS.length];
      const t0 = performance.now();
      v.dispatch({ changes: { from: p, insert: ch } });
      times.push(performance.now() - t0);
      p += 1;
      if (i % 4 === 3) await raf();
    }
    add("typeSync_tail", times);
  }

  /* 7. 回车拆分段落（块级 splice 重解析路径） */
  {
    begin("enterSync_medium");
    const { v } = await openAndScroll(f, docA, 0.4);
    const times: number[] = [];
    for (let i = 0; i < 24; i++) {
      const lineNo = paragraphLineNo(v, docA.content, 0.4) + i; // 目标行随文档增长后移
      const ln = Math.min(lineNo, v.state.doc.lines - 2);
      const line = v.state.doc.line(ln + 1);
      const t0 = performance.now();
      v.dispatch({ changes: { from: line.from + 3, insert: "\n" } });
      times.push(performance.now() - t0);
      if (i % 3 === 2) await raf();
    }
    add("enterSync_medium", times);
  }

  /* 8. 单键端到端：dispatch -> 预览 rAF 渲染完成 */
  {
    begin("typePaint_medium");
    const { v, pos } = await openAndScroll(f, docA, 0.4);
    const times: number[] = [];
    let p = pos;
    for (let i = 0; i < 16; i++) {
      const ch = TYPING_CHARS[i % TYPING_CHARS.length];
      const t0 = performance.now();
      v.dispatch({ changes: { from: p, insert: ch } });
      await raf();
      await raf();
      times.push(performance.now() - t0);
      p += 1;
    }
    add("typePaint_medium", times);
  }

  /* 9. 视图模式切换（编辑 <-> 分屏 <-> 预览，含预览可见性/刷新/重同步） */
  {
    begin("viewSwitch_large");
    await f.openDoc(docLarge);
    await settle(4);
    const modes = ["preview", "split", "edit", "split"] as const;
    for (const m of modes) {
      f.setViewMode(m);
      await settle(3);
    }
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const m = modes[i % modes.length];
      const t0 = performance.now();
      f.setViewMode(m);
      await settle(3);
      times.push(performance.now() - t0);
    }
    add("viewSwitch_large", times);
  }

  /* 10. 预览区滚动渲染（虚拟化挂载/卸载，预览模式，大文档） */
  {
    begin("previewScroll_large");
    f.setViewMode("preview");
    await f.openDoc(docLarge);
    await settle(4);
    const el = f.previewScrollEl();
    for (let i = 0; i < 3; i++) {
      el.scrollTop += 600;
      await settle(3);
    }
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      el.scrollTop += 600;
      await raf();
      await raf();
      times.push(performance.now() - t0);
    }
    add("previewScroll_large", times);
  }

  /* 11. 编辑区滚动（CM 视口更新 + 滚动同步 + 预览渲染，分屏大文档） */
  {
    begin("editorScroll_large");
    f.setViewMode("split");
    await f.openDoc(docLarge);
    await settle(4);
    const el = f.editorScrollEl();
    el.scrollTop = 0;
    await settle(4);
    for (let i = 0; i < 3; i++) {
      el.scrollTop += 400;
      await settle(3);
    }
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      el.scrollTop += 400;
      await raf();
      await raf();
      times.push(performance.now() - t0);
    }
    add("editorScroll_large", times);
  }

  /* 12. 侧栏列表：逐条元信息更新（模拟连续自动保存，每条之间有渲染间隔） */
  {
    begin("listUpdate_serial");
    const notes = genNotes(500);
    f.setupList(notes);
    await settle(4);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const meta: FakeNote = {
        ...(notes[(i * 7) % notes.length] as FakeNote),
        updatedAt: Date.now(),
      };
      const t0 = performance.now();
      f.listUpdateAfterSave(meta);
      await settle(2);
      times.push(performance.now() - t0);
    }
    add("listUpdate_serial", times);
  }

  /* 13. 侧栏列表：同一 tick 内 20 条更新（测信号合并 vs 逐条全量渲染） */
  {
    begin("listUpdate_burst");
    const notes = genNotes(500);
    f.setupList(notes);
    await settle(4);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const meta: FakeNote = {
        ...(notes[(i * 11) % notes.length] as FakeNote),
        updatedAt: Date.now(),
      };
      f.listUpdateAfterSave(meta);
    }
    const syncMs = performance.now() - t0;
    await settle(4);
    add("listUpdate_burst_sync", [syncMs]);
    single("listUpdate_burst_total", performance.now() - t0);
  }

  return {
    arch: f.arch,
    meta: {
      time: new Date().toISOString(),
      ua: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
      docMedium: `${docA.content.length} 字符 / ${docA.content.split("\n").length} 行`,
      docLarge: `${docLarge.content.length} 字符 / ${docLarge.content.split("\n").length} 行`,
    },
    scenarios,
  };
}
