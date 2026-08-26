// 分屏滚动同步（逻辑位置同步）
// 编辑区与预览区都按"源行号 + 块内进度"互相映射，取代旧的镜像测量方案：
// - 编辑区：CodeMirror 的 lineBlockAtHeight / lineBlockAt 直接给出任意视口位置对应的
//   逻辑行与行块几何，滚动处理函数里没有全文 split、没有 getComputedStyle、没有全量 offsetTop。
// - 预览区：虚拟预览维护 块→height/top 布局数组，映射是二元查找（O(log n)）。
// 两侧的内容坐标都满足 viewportTop = scrollTop（padding 在校准中抵消），
// 因此同步就是一次跳跃式写入，滚动期间逐帧执行也不会拖慢主线程。

import type { EditorView } from "@codemirror/view";
import { viewMode } from "./state";
import type { PreviewApi } from "./virtualPreview";

export interface SyncDeps {
  getEditorView: () => EditorView;
  getPreview: () => PreviewApi;
}

let editorView: EditorView | null = null;
let previewApi: PreviewApi | null = null;

type SyncSide = "editor" | "preview";
let activeSide: SyncSide = "editor";
let syncSuspended = false;
let raf = 0;

/* 程序化写入锁：防止 A->B 同步触发的 scroll 事件再回传 B->A 造成抖动 */
let lockEl: HTMLElement | null = null;
let lockUntil = 0;
const LOCK_MS = 60;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function isLocked(el: HTMLElement | null): boolean {
  return el !== null && el === lockEl && performance.now() < lockUntil;
}

function writeScroll(el: HTMLElement, top: number) {
  const max = el.scrollHeight - el.clientHeight;
  const target = clamp(top, 0, Math.max(0, max));
  if (Math.abs(el.scrollTop - target) < 0.5) return;
  lockEl = el;
  lockUntil = performance.now() + LOCK_MS;
  el.scrollTop = target;
}

/* ---------- 编辑区几何 → 源行号（浮点） ---------- */
function editorTopToLineFloat(): number {
  const v = editorView!;
  if (v.state.doc.lines === 0) return 0;
  // 视口顶端对应的文档高度 = scrollTop（内容坐标与滚动偏移一致）
  const docY = v.scrollDOM.scrollTop + 1;
  const block = v.lineBlockAtHeight(docY);
  const lineNo = v.state.doc.lineAt(block.from).number; // 1 起始
  const frac = block.height > 0 ? clamp((docY - block.top) / block.height, 0, 1) : 0;
  return lineNo - 1 + frac;
}

/** 源行号（浮点）→ 编辑区滚动位置（把该行的行块顶端对齐视口顶部） */
function scrollEditorToLine(lineFloat: number) {
  const v = editorView!;
  const doc = v.state.doc;
  let lineNo = Math.floor(lineFloat) + 1;
  const frac = clamp(lineFloat - (lineNo - 1), 0, 1);
  lineNo = clamp(lineNo, 1, doc.lines);
  const line = doc.line(lineNo);
  const block = v.lineBlockAt(line.from);
  writeScroll(v.scrollDOM, block.top + frac * block.height);
}

/* ---------- 预览区几何 ↔ 源行号 ---------- */
function previewTopToLineFloat(): number {
  const p = previewApi!;
  return p.mapYToLine(p.element.scrollTop);
}

function scrollPreviewToLine(lineFloat: number) {
  const p = previewApi!;
  writeScroll(p.element, p.mapLineToY(lineFloat));
}

/* ---------- 双向同步 ---------- */
function syncEditorToPreview() {
  if (!editorView || !previewApi || viewMode.get() !== "split" || syncSuspended) return;
  const v = editorView;
  if (v.state.doc.length === 0) return;
  const lineFloat = editorTopToLineFloat();
  scrollPreviewToLine(lineFloat);
}

function syncPreviewToEditor() {
  if (!editorView || !previewApi || viewMode.get() !== "split" || syncSuspended) return;
  const lineFloat = previewTopToLineFloat();
  scrollEditorToLine(lineFloat);
}

export function initScrollSync(deps: SyncDeps) {
  editorView = deps.getEditorView();
  previewApi = deps.getPreview();

  const run = () => {
    if (activeSide === "preview") syncPreviewToEditor();
    else syncEditorToPreview();
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      run();
    });
  };

  const ed = editorView.scrollDOM;
  const pv = previewApi.element;

  ed.addEventListener("scroll", () => {
    if (viewMode.get() !== "split" || syncSuspended || isLocked(ed)) return;
    activeSide = "editor";
    schedule();
  });
  pv.addEventListener("scroll", () => {
    if (viewMode.get() !== "split" || syncSuspended || isLocked(pv)) return;
    activeSide = "preview";
    schedule();
  });
  ed.addEventListener("pointerdown", () => {
    activeSide = "editor";
  });
  pv.addEventListener("pointerdown", () => {
    activeSide = "preview";
  });
}

/** 编辑器发生输入时，后续布局校正必须以编辑区为同步源 */
export function notifyEditorActivity() {
  activeSide = "editor";
}

/** 拆分屏状态重新同步（视图切换、布局变化后调用） */
export function scheduleResync() {
  if (!editorView || !previewApi || viewMode.get() !== "split" || syncSuspended) return;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (activeSide === "preview") syncPreviewToEditor();
    else syncEditorToPreview();
  });
}

/** 预览布局刷新（块重渲染/重测高度）后需要重新对齐时调用 */
export function notifyPreviewLayoutChanged() {
  if (viewMode.get() !== "split" || syncSuspended) return;
  scheduleResync();
}

/** 跳转到指定源行（大纲面板点击）：预览模式滚预览区；编辑/分屏滚编辑器并放置光标，
 *  分屏时两侧一起滚动（编辑区滚动事件带锁，不会自行触发预览联动） */
export function scrollToLine(lineFloat: number) {
  if (!editorView || !previewApi) return;
  const v = editorView;
  if (viewMode.get() === "preview") {
    scrollPreviewToLine(lineFloat);
    return;
  }
  const lineNo = clamp(Math.floor(lineFloat) + 1, 1, v.state.doc.lines);
  scrollEditorToLine(lineFloat);
  if (viewMode.get() === "split") scrollPreviewToLine(lineFloat);
  const line = v.state.doc.line(lineNo);
  v.dispatch({ selection: { anchor: line.from }, scrollIntoView: false });
  if (!v.hasFocus) v.focus();
}

export function setScrollSyncSuspended(suspended: boolean) {
  syncSuspended = suspended;
  if (!suspended) scheduleResync();
}