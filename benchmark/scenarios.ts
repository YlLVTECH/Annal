// 场景 runner：与实现无关的基准操作序列（当前架构口径：即时渲染 + 块模型 + 信号侧栏）。
// 每个场景先预热（触发懒加载、初次布局、JIT）再计时，逐次操作取中位数。
// 计时口径：
// - 打字：逐键 dispatch 计时 —— 覆盖每键同步热路径（Lezer 增量解析 + 即时渲染装饰 + 块模型 + 保存簿记）；
// - 打字+DOM（type_medium_dom）：逐键 dispatch 后强制 CM measure —— 追加每帧的 DOM 同步成本；
// - 光标：逐次选区 dispatch 计时 —— 覆盖 selectionSet 触发的即时渲染装饰重建；
// - 滚动：设置 scrollTop 后强制 CM measure —— 覆盖 viewportChanged 触发的装饰重建与 DOM 同步；
// - 即时渲染开关（annal:live-render）作为对照（_nolive），量化装饰层的增量成本。
// rAF 被暂停的环境（后台/自动化）里 CM 的 measure 阶段不会自动发生，所有场景都用
// facade.forceMeasure 显式驱动视口建立与更新，保证结果与运行环境无关。

import type { EditorView } from "@codemirror/view";
import { EditorView as CMView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { BenchFacade, BenchResults, TimingStats } from "./facade";
import { forceMeasure, frames, settle, stats } from "./facade";
import { findParagraphLine, genDoc, genNotes, genPlainDoc } from "./docs";
import type { FakeNote } from "./docs";
import { applyEdit } from "../src/markdownModel";

const docA = { title: "基准 A", path: "C:\\bench\\bench-a.md", content: genDoc(1001, 150) };
const docB = { title: "基准 B", path: "C:\\bench\\bench-b.md", content: genDoc(1002, 150) };
const docLarge = { title: "基准大文档", path: "C:\\bench\\bench-large.md", content: genDoc(2001, 800) };
// 单一巨型段落（无空行）：块模型每键整块重解析的最坏情形
const docPlain = { title: "基准长段落", path: "C:\\bench\\bench-plain.md", content: genPlainDoc(3001, 1200) };
const TYPING_CHARS = "基准输入性能测试文本xyzw01";
const TYPING_KEYS = 60;
const WARMUP_KEYS = 10;

/** 文档中 frac 比例处一个普通文本行的中点位（打字/光标位置） */
function plainPos(content: string, v: EditorView, frac: number): number {
  const lineNo = findParagraphLine(content, frac);
  const line = v.state.doc.line(lineNo + 1);
  return line.from + Math.floor(line.length / 2);
}

/** 连续单键输入：逐键 dispatch，逐键计时（先预热 JIT 再取样） */
function runTyping(v: EditorView, pos: number, keys: number): number[] {
  const times: number[] = [];
  let p = pos;
  const step = (i: number) => {
    const ch = TYPING_CHARS[i % TYPING_CHARS.length];
    v.dispatch({ changes: { from: p, insert: ch }, selection: { anchor: p + ch.length } });
    p += ch.length;
  };
  for (let i = 0; i < WARMUP_KEYS; i++) step(i);
  for (let i = 0; i < keys; i++) {
    const t0 = performance.now();
    step(i);
    times.push(performance.now() - t0);
  }
  return times;
}

/** 逐键输入 + 每键强制 measure（真实环境里每帧都会发生的 DOM 同步，也计入每键成本） */
function runTypingWithMeasure(v: EditorView, pos: number, keys: number): number[] {
  const times: number[] = [];
  let p = pos;
  const step = (i: number) => {
    const ch = TYPING_CHARS[i % TYPING_CHARS.length];
    v.dispatch({ changes: { from: p, insert: ch }, selection: { anchor: p + ch.length } });
    forceMeasure(v);
    p += ch.length;
  };
  for (let i = 0; i < WARMUP_KEYS; i++) step(i);
  for (let i = 0; i < keys; i++) {
    const t0 = performance.now();
    step(i);
    times.push(performance.now() - t0);
  }
  return times;
}

/** 逐次移动光标（右移一格）：selectionSet 触发的即时渲染重建路径 */
function runCursorMoves(v: EditorView, pos: number, steps: number): number[] {
  const times: number[] = [];
  let p = pos;
  for (let i = 0; i < WARMUP_KEYS; i++) {
    v.dispatch({ selection: { anchor: p } });
    p++;
  }
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    v.dispatch({ selection: { anchor: p } });
    times.push(performance.now() - t0);
    p++;
  }
  return times;
}

/** 滚动一步：设置 scrollTop 后强制 measure（视口重建 + DOM 同步的完整同步成本） */
function runScroll(v: EditorView, steps: number): number[] {
  const el = v.scrollDOM;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return [];
  const times: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    el.scrollTop = Math.min(max, ((i + 1) / steps) * max);
    forceMeasure(v);
    times.push(performance.now() - t0);
  }
  return times;
}

export type ProgressFn = (name: string, index: number, total: number) => void;

const TOTAL = 20;

export async function runAll(
  f: BenchFacade,
  onProgress?: ProgressFn,
): Promise<BenchResults> {
  const scenarios: Record<string, TimingStats> = {};
  const add = (name: string, list: number[]) => {
    scenarios[name] = stats(list);
  };
  const single = (name: string, value: number) => add(name, [value]);
  let scenarioIndex = 0;
  const begin = (name: string) => {
    scenarioIndex++;
    onProgress?.(name, scenarioIndex, TOTAL);
  };
  const v = () => f.editorView();

  /* 0. CPU 校准：固定工作量的整数循环（反映当前 CPU 频率/负载环境）。
   *    跨轮比较时用它对各场景中位数做归一化，抵消机器状态波动。 */
  {
    begin("calib_cpu");
    const times: number[] = [];
    let sink = 0;
    for (let s = 0; s < 30; s++) {
      const t0 = performance.now();
      let acc = 0;
      for (let i = 0; i < 1000000; i++) {
        acc = (acc + ((i * 2654435761) ^ (acc >>> 7))) | 0;
      }
      sink += acc;
      times.push(performance.now() - t0);
    }
    if (sink === 123456789) console.log(sink); // 防 JIT 消除
    add("calib_cpu", times);
  }

  /* 0b. 最小编辑器微基准：仅 markdown() 语言，逐键 dispatch 后强制补全语法树。
   *     隔离「CM 事务 + Lezer 增量解析」成本，与主编辑器整键成本对照，
   *     用于判断剩余热路径开销落在编辑器内核还是应用扩展。 */
  {
    begin("micro_lezer");
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-9999px;top:0;width:800px;height:600px;";
    document.body.appendChild(host);
    const mkState = (content: string) =>
      EditorState.create({ doc: content, extensions: [markdown()] });
    const microRun = (content: string, keys: number): number[] => {
      const mv = new CMView({ parent: host, state: mkState(content) });
      const times: number[] = [];
      const mid = Math.floor(content.length / 2);
      const step = (i: number) => {
        const pos = mid + i;
        mv.dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
        syntaxTree(mv.state); // 与即时渲染同款：强制同步补全解析
      };
      for (let i = 0; i < WARMUP_KEYS; i++) step(i);
      for (let i = 0; i < keys; i++) {
        const t0 = performance.now();
        step(i);
        times.push(performance.now() - t0);
      }
      mv.destroy();
      return times;
    };
    add("micro_lezer_medium", microRun(docA.content, TYPING_KEYS));
    add("micro_lezer_bigpara", microRun(docPlain.content, TYPING_KEYS));
    host.remove();
  }

  /* 1. 冷启动初始化（编辑器 + 即时渲染 + 大纲 + 侧栏） */
  {
    begin("init_cold");
    const t0 = performance.now();
    f.init();
    single("init_cold", performance.now() - t0);
    await frames(2);
  }

  /* 2. 打开中等文档（150 块）：模型全量解析 + 编辑器重建 + 首屏装饰（含首轮 measure） */
  {
    begin("openDoc_medium");
    for (const doc of [docA, docB, docA]) {
      f.openDoc(doc);
      forceMeasure(v());
      await frames(1);
    }
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const doc = i % 2 === 0 ? docA : docB;
      const t0 = performance.now();
      f.openDoc(doc);
      forceMeasure(v());
      times.push(performance.now() - t0);
      await frames(1);
    }
    add("openDoc_medium", times);
  }

  /* 3. 打开大文档（800 块） */
  {
    begin("openDoc_large");
    f.openDoc(docLarge);
    forceMeasure(v());
    await frames(1); // 首轮含模块级懒加载，不取样
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      f.openDoc(docLarge);
      forceMeasure(v());
      times.push(performance.now() - t0);
      await frames(1);
    }
    add("openDoc_large", times);
  }

  /* 4. 打开长段落文档（1200 行单一巨型段落） */
  {
    begin("openDoc_bigpara");
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      f.openDoc(docPlain);
      forceMeasure(v());
      times.push(performance.now() - t0);
      await frames(1);
    }
    add("openDoc_bigpara", times);
  }

  /* 5. 中等文档普通打字（逐键，仅 dispatch 同步路径） */
  {
    begin("type_medium");
    f.openDoc(docA);
    forceMeasure(v());
    await frames(1);
    const p = plainPos(docA.content, v(), 0.5);
    add("type_medium", runTyping(v(), p, TYPING_KEYS));
  }

  /* 6. 中等文档打字 + 每键 DOM 同步（dispatch + 强制 measure） */
  {
    begin("type_medium_dom");
    f.openDoc(docB);
    forceMeasure(v());
    await frames(1);
    const p = plainPos(docB.content, v(), 0.5);
    add("type_medium_dom", runTypingWithMeasure(v(), p, TYPING_KEYS));
  }

  /* 7. 大文档普通打字（逐键） */
  {
    begin("type_large");
    f.openDoc(docLarge);
    forceMeasure(v());
    await frames(1);
    const p = plainPos(docLarge.content, v(), 0.5);
    add("type_large", runTyping(v(), p, TYPING_KEYS));
  }

  /* 8. 长段落打字：单一巨型段落内的逐键输入（块模型整块重解析的最坏情形） */
  {
    begin("type_bigpara");
    f.openDoc(docPlain);
    forceMeasure(v());
    await frames(1);
    const p = plainPos(docPlain.content, v(), 0.5);
    add("type_bigpara", runTyping(v(), p, TYPING_KEYS));
  }

  /* 9. 长段落打字（即时渲染关闭对照） */
  {
    begin("type_bigpara_nolive");
    f.setLiveRender(false);
    const p = plainPos(docPlain.content, v(), 0.7);
    add("type_bigpara_nolive", runTyping(v(), p, TYPING_KEYS));
    f.setLiveRender(true);
  }

  /* 9b. 长段落成本分解：整键（dispatch） vs 纯 applyEdit（块模型），同一次运行内对照。
   *     applyEdit 直接以视图文档为输入调用（与管线共享同一模块实例）。 */
  {
    begin("bigpara_breakdown");
    f.openDoc(docPlain);
    forceMeasure(v());
    await frames(1);
    const doc = v().state.doc;
    const p = plainPos(docPlain.content, v(), 0.5);
    const keyTimes: number[] = [];
    const modelTimes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const pos = p + i * 2;
      const t0 = performance.now();
      v().dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
      keyTimes.push(performance.now() - t0);
    }
    for (let i = 0; i < 40; i++) {
      const ln = doc.lineAt(p + 80 + i * 2).number;
      const t0 = performance.now();
      applyEdit(doc, { start: ln - 1, end: ln - 1, endNew: ln - 1 }, { newlineChange: false });
      modelTimes.push(performance.now() - t0);
    }
    add("bigpara_key_total", keyTimes);
    add("bigpara_applyedit_only", modelTimes);
  }

  /* 9c. 中等文档成本分解（同 9b，供同环境对照） */
  {
    begin("medium_breakdown");
    f.openDoc(docA);
    forceMeasure(v());
    await frames(1);
    const doc = v().state.doc;
    const p = plainPos(docA.content, v(), 0.5);
    const keyTimes: number[] = [];
    const modelTimes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const pos = p + i * 2;
      const t0 = performance.now();
      v().dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
      keyTimes.push(performance.now() - t0);
    }
    for (let i = 0; i < 40; i++) {
      const ln = doc.lineAt(p + 80 + i * 2).number;
      const t0 = performance.now();
      applyEdit(doc, { start: ln - 1, end: ln - 1, endNew: ln - 1 }, { newlineChange: false });
      modelTimes.push(performance.now() - t0);
    }
    add("medium_key_total", keyTimes);
    add("medium_applyedit_only", modelTimes);
  }

  /* 10. 中等文档打字（即时渲染关闭对照） */
  {
    begin("type_medium_nolive");
    f.setLiveRender(false);
    f.openDoc(docB);
    forceMeasure(v());
    await frames(1);
    const p = plainPos(docB.content, v(), 0.5);
    add("type_medium_nolive", runTyping(v(), p, TYPING_KEYS));
    f.setLiveRender(true);
  }

  /* 11. 大文档逐格移动光标（selectionSet 重建路径） */
  {
    begin("cursor_large");
    f.openDoc(docLarge);
    forceMeasure(v());
    await frames(1);
    const p = plainPos(docLarge.content, v(), 0.5);
    add("cursor_large", runCursorMoves(v(), p, TYPING_KEYS));
  }

  /* 12. 光标移动（即时渲染关闭对照） */
  {
    begin("cursor_large_nolive");
    f.setLiveRender(false);
    const p = plainPos(docLarge.content, v(), 0.5);
    add("cursor_large_nolive", runCursorMoves(v(), p, TYPING_KEYS));
    f.setLiveRender(true);
  }

  /* 13. 大文档滚动（每步 1/20 文档高度 + 强制 measure） */
  {
    begin("scroll_large");
    f.openDoc(docLarge);
    forceMeasure(v());
    v().scrollDOM.scrollTop = 0;
    forceMeasure(v());
    await frames(1);
    add("scroll_large", runScroll(v(), 20));
  }

  /* 14. 滚动（即时渲染关闭对照） */
  {
    begin("scroll_large_nolive");
    f.setLiveRender(false);
    f.openDoc(docLarge);
    forceMeasure(v());
    v().scrollDOM.scrollTop = 0;
    forceMeasure(v());
    await frames(1);
    add("scroll_large_nolive", runScroll(v(), 20));
    f.setLiveRender(true);
  }

  /* 15. 大段粘贴（200 块多行内容单次插入：newline 变化 -> 块级 splice/整篇重解析路径） */
  {
    begin("paste_large");
    const pasteText = genDoc(5001, 200);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      f.openDoc(docLarge);
      forceMeasure(v());
      await frames(1);
      const p = plainPos(docLarge.content, v(), 0.3 + i * 0.08);
      const t0 = performance.now();
      v().dispatch({
        changes: { from: p, to: p, insert: pasteText },
        selection: { anchor: p + pasteText.length },
      });
      times.push(performance.now() - t0);
    }
    add("paste_large", times);
  }

  /* 16. 侧栏 20 次批量保存更新（信号微任务合并 -> 单次列表重建） */
  {
    begin("list_update_20");
    f.setupList(genNotes(20));
    await settle(3);
    const metas = genNotes(20);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      f.listUpdateAfterSave({
        ...metas[i],
        updatedAt: Date.now() + i,
      } as FakeNote);
    }
    await settle(3);
    single("list_update_20", performance.now() - t0);
  }

  return {
    arch: f.arch,
    meta: {
      time: new Date().toISOString(),
      ua: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
      liveRender: localStorage.getItem("annal:live-render") !== "0",
      docMedium: `${docA.content.length}B / ${docA.content.split("\n").length} 行`,
      docLarge: `${docLarge.content.length}B / ${docLarge.content.split("\n").length} 行`,
      docPlain: `${docPlain.content.length}B / ${docPlain.content.split("\n").length} 行`,
    },
    scenarios,
  };
}
