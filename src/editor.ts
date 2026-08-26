// 编辑器模块：基于 CodeMirror 6，替换原 textarea 实现。
// - 视口渲染：50,000 行文档也只创建视口附近的行节点，原生滚动，无需全量 DOM。
// - 撤销/重做、IME 组合输入、Tab 缩进、列表续行（Enter）均由 CM 内置处理。
// - 输入一处内容只触发该处受影响 Markdown 块的重渲染：
//   编辑事务经注入回调同步交给 pipeline，由其驱动块模型与预览；
//   本模块不持有模型/预览的引用（单向数据流的起点）。

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { closeTablePopover } from "./table";
import { showContextMenu } from "./dialogs";
import { bus } from "./events";
import type { CtxItem, Source } from "./types";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSet,
  type Extension,
} from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo as cmRedo,
  undo as cmUndo,
} from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { insertNewlineContinueMarkup, markdown } from "@codemirror/lang-markdown";
import { closeFindPanel, findReplaceExtension } from "./findReplace";
import { setScrollSyncSuspended, scheduleResync as scheduleSplitResync } from "./documentPosition";
import {
  current,
  currentPathOf,
  dirty,
  missingPaths,
  notes,
  splitRatio,
  viewMode,
} from "./state";
import { pathKey } from "./utils";
import { IMAGE_EXT_RE, SPLIT_RATIO_DEFAULT, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from "./utils";
import { parseViewMode } from "./types";
import { t } from "./i18n";
import type { ViewMode } from "./types";

/* ---------- DOM 元素 ---------- */
const editorHeaderEl = document.querySelector<HTMLDivElement>("#editor-header")!;
const editorTitleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
const missingBadgeEl = document.querySelector<HTMLSpanElement>("#editor-missing")!;
const savedStatusEl = document.querySelector<HTMLSpanElement>("#saved-status")!;
const editorEmptyEl = document.querySelector<HTMLDivElement>("#editor-empty")!;
const toolbarEl = document.querySelector<HTMLDivElement>("#toolbar")!;
const editorBodyEl = document.querySelector<HTMLDivElement>("#editor-body")!;
const editorMainEl = document.querySelector<HTMLDivElement>("#editor-main")!;
const editorWrapEl = document.querySelector<HTMLDivElement>("#editor-wrap")!;
const splitResizerEl = document.querySelector<HTMLDivElement>("#split-resizer")!;
const mountEl = document.querySelector<HTMLDivElement>("#editor")!;
const statusbarEl = document.querySelector<HTMLDivElement>("#statusbar")!;
const wordCountEl = document.querySelector<HTMLSpanElement>("#word-count")!;
const commitNoteBtn = document.querySelector<HTMLButtonElement>("#commit-note-btn")!;
const saveAsNoteBtn = document.querySelector<HTMLButtonElement>("#save-as-note-btn")!;
const deleteNoteBtn = document.querySelector<HTMLButtonElement>("#delete-note-btn")!;
const viewButtons = document.querySelectorAll<HTMLButtonElement>(".view-btn");
const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool-btn");

export interface EditorHotPathDeps {
  /** 单次编辑事务：pipeline 同步处理模型、预览与自动保存簿记。 */
  onDocEdited: (change: {
    start: number;
    end: number;
    endNew: number;
    newlineChange: boolean;
  }) => void;
}

let hotPathDeps: EditorHotPathDeps | null = null;

/* ---------- 编辑器头部（随 current 信号联动） ---------- */

/** 根据当前编辑对象类型切换头部按钮（提交/存为笔记/删除-关闭文件） */
function syncHeaderButtons(src: Source | null): void {
  if (src?.kind === "note") {
    commitNoteBtn.hidden = false;
    saveAsNoteBtn.hidden = true;
    deleteNoteBtn.textContent = t("editor.header.delete");
    deleteNoteBtn.title = t("editor.header.delete");
    deleteNoteBtn.classList.remove("close-mode");
  } else if (src?.kind === "file") {
    commitNoteBtn.hidden = true;
    saveAsNoteBtn.hidden = false;
    deleteNoteBtn.textContent = t("editor.header.closeFile");
    deleteNoteBtn.title = t("editor.header.closeFile");
    deleteNoteBtn.classList.add("close-mode");
  } else {
    commitNoteBtn.hidden = true;
    saveAsNoteBtn.hidden = true;
  }
}

/** 笔记元信息变化（保存/改名/外部同步）时刷新编辑器标题 */
function syncEditorTitleFromMeta(): void {
  const src = current.get();
  if (src?.kind !== "note") return;
  const meta = notes.get().find((n) => n.id === src.id);
  if (!meta) return;
  editorTitleEl.textContent = meta.title;
  editorTitleEl.title = meta.path;
}

/** 当前编辑对象对应的文件是否已被外部删除 -> 头部缺失徽标 */
function syncMissingBadge(): void {
  const src = current.get();
  if (!src) {
    updateMissingBadge(false, false);
    return;
  }
  const gone = missingPaths.get().has(pathKey(currentPathOf(src)));
  updateMissingBadge(gone, src.kind === "file");
}

/* ---------- CodeMirror 视图与状态 ---------- */
let view: EditorView | null = null;
const readOnlyCompartment = new Compartment();
const lineNumbersCompartment = new Compartment();

/* ---------- 大纲跳转：目标标题行短暂高亮 ---------- */
const setHeadingFlash = StateEffect.define<number | null>();

const headingFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setHeadingFlash)) continue;
      if (e.value === null) {
        next = Decoration.none;
      } else {
        const no = Math.min(Math.max(e.value, 1), tr.state.doc.lines);
        const line = tr.state.doc.line(no);
        next = Decoration.set(Decoration.line({ class: "cm-outline-flash" }).range(line.from));
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

let headingFlashTimer: number | undefined;

/** 大纲点击跳转后闪烁高亮标题行，约 1.3s 后自动清除 */
export function flashHeadingAtLine(lineNo: number): void {
  if (!view || editorBodyEl.hidden) return;
  view.dispatch({ effects: setHeadingFlash.of(lineNo) });
  window.clearTimeout(headingFlashTimer);
  headingFlashTimer = window.setTimeout(() => {
    headingFlashTimer = undefined;
    view?.dispatch({ effects: setHeadingFlash.of(null) });
  }, 1300);
}

/** 加载/切换文档时置位：该次变更不触发自动保存与预览增量更新 */
let loadingDoc = false;

/** placeholder 的可替换外壳：init 时可能 i18n 还没就绪，因此后续可热更新 */
const placeholderCompartment = new Compartment();

function getExtensions(): Extension[] {
  return [
    lineNumbersCompartment.of(lineNumbers()),
    highlightActiveLine(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    bracketMatching(),
    indentUnit.of("  "),
    markdown(),
    placeholderCompartment.of(placeholder(t("editor.placeholder") || "开始输入…")),
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
    }),
    keymap.of(defaultKeymap),
    keymap.of(historyKeymap),
    keymap.of([indentWithTab]),
    keymap.of([{ key: "Enter", run: insertNewlineContinueMarkup }]),
    findReplaceExtension(),
    headingFlashField,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (loadingDoc) return;
      emitDocChanged(update.changes, update.startState, update.state);
      scheduleCount();
    }),
    EditorView.domEventHandlers({ paste: handlePaste, contextmenu: handleEditorContextMenu }),
  ];
}

/** 编辑事务 -> pipeline 注入回调：同步驱动块模型、预览与保存簿记。 */
function emitDocChanged(
  changes: ChangeSet,
  startState: EditorState,
  newState: EditorState,
) {
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  let endNew = -1;
  let hasNewlineChange = false;
  const oldLen = startState.doc.length;
  const newLen = newState.doc.length;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const oldSeg = startState.sliceDoc(fromA, toA);
    const newSeg = newState.sliceDoc(fromB, toB);
    if (oldSeg.includes("\n") || newSeg.includes("\n")) hasNewlineChange = true;
    adjustCountStats(startState, newState, fromA, toA, fromB, toB);
    const a = startState.doc.lineAt(Math.min(fromA, oldLen)).number - 1;
    const ao = startState.doc.lineAt(Math.min(Math.max(toA, 1), oldLen)).number - 1;
    const bn = newState.doc.lineAt(Math.min(Math.max(toB, 1), newLen)).number - 1;
    if (a < start) start = a;
    if (ao > end) end = ao;
    if (bn > endNew) endNew = bn;
  });
  if (start === Number.POSITIVE_INFINITY) {
    start = 0;
    end = newState.doc.lines - 1;
    endNew = end;
  } else {
    // 前后各多带一行：结构变化（如输入 ``` 开围栏）会影响相邻块的归属
    start = Math.max(0, start - 1);
    end = Math.min(startState.doc.lines - 1, end + 1);
    endNew = Math.min(newState.doc.lines - 1, endNew + 1);
  }
  hotPathDeps?.onDocEdited({ start, end, endNew, newlineChange: hasNewlineChange });
}

export function updateEditorPlaceholder() {
  if (!view) return;
  view.dispatch({
    effects: placeholderCompartment.reconfigure(placeholder(t("editor.placeholder") || "开始输入…")),
  });
}

/* ---------- 预览与保存状态 ---------- */
export type SaveStatus = "idle" | "saving" | "saved" | "error";

export function setSaveStatus(status: SaveStatus, text = "") {
  const suffix = status === "saving" ? t("status.saving") : status === "saved" ? t("status.saved") : status === "error" ? t("status.error.save") : "";
  savedStatusEl.textContent = text || suffix;
  savedStatusEl.dataset.status = status;
}

export function setStatus(text: string) {
  savedStatusEl.textContent = text;
  if (text) savedStatusEl.dataset.status = "idle";
}

export function resetSaveStatus() {
  setSaveStatus("idle");
}

/* ---------- 文本与选区访问 ---------- */
export function getEditorView(): EditorView {
  if (!view) throw new Error("editor not initialized");
  return view;
}

export function getEditorText(): string {
  return view ? view.state.doc.toString() : "";
}

export function getSelectedText(): string {
  if (!view) return "";
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

export function editorHasFocus(): boolean {
  return view ? view.hasFocus : false;
}

export function canEditCurrent(): boolean {
  return current.get() !== null && viewMode.get() !== "preview" && !editorBodyEl.hidden;
}

export function isComposing(): boolean {
  return view ? view.composing : false;
}

/* ---------- 撤销 / 重做（CM 内置历史，按事务分组） ---------- */
export function undo() {
  if (!view || !canEditCurrent()) return;
  cmUndo(view);
}

export function redo() {
  if (!view || !canEditCurrent()) return;
  cmRedo(view);
}

/* ---------- 字数统计（增量维护） ----------
 * 字符/词数随每个事务就地增减对应区间，250ms 防抖只做一次 DOM 文本渲染，
 * 不再每次全文 toString + 两个全文正则扫描。词数按词边界外扩后做区间内替换，
 * 避免跨界的单词被漏计/重复计。 */
let countTimer: number | undefined;
let statChars = 0;
let statWords = 0;
const WORD_MATCH_RE = /[A-Za-z0-9_]+/g;

function countWordsIn(s: string): number {
  return (s.match(WORD_MATCH_RE) ?? []).length;
}

function expandToWordBounds(doc: EditorState["doc"], pos: number, dir: -1 | 1): number {
  if (dir < 0) {
    while (pos > 0 && /[A-Za-z0-9_]/.test(doc.sliceString(pos - 1, pos))) pos--;
  } else {
    while (pos < doc.length && /[A-Za-z0-9_]/.test(doc.sliceString(pos, pos + 1))) pos++;
  }
  return pos;
}

function adjustCountStats(
  startState: EditorState,
  newState: EditorState,
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
) {
  const removed = startState.sliceDoc(fromA, toA);
  const inserted = newState.sliceDoc(fromB, toB);
  statChars += inserted.replace(/\s/g, "").length - removed.replace(/\s/g, "").length;
  const a0 = expandToWordBounds(startState.doc, fromA, -1);
  const a1 = expandToWordBounds(startState.doc, toA, 1);
  const b0 = expandToWordBounds(newState.doc, fromB, -1);
  const b1 = expandToWordBounds(newState.doc, toB, 1);
  statWords += countWordsIn(newState.sliceDoc(b0, b1)) - countWordsIn(startState.sliceDoc(a0, a1));
}

function setCountStatsFromText(text: string) {
  statChars = text.replace(/\s/g, "").length;
  statWords = countWordsIn(text);
}

export function updateCount() {
  const minutes = statChars === 0 ? 0 : Math.max(1, Math.ceil(statChars / 400));
  const parts = [t("editor.count.chars", { count: statChars })];
  if (statWords > 0) parts.push(t("editor.count.words", { count: statWords }));
  if (minutes > 0) parts.push(t("editor.count.minutes", { count: minutes }));
  wordCountEl.textContent = parts.join(" · ");
}

function scheduleCount() {
  window.clearTimeout(countTimer);
  countTimer = window.setTimeout(updateCount, 250);
}

/* ---------- 视图模式 ---------- */
export function setViewMode(value: unknown) {
  const mode = parseViewMode(value);
  viewMode.set(mode);
  editorBodyEl.className = `mode-${mode}`;
  for (const b of viewButtons) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
  localStorage.setItem("notebook:view", mode);
  if (mode === "split") applySplitRatio(splitRatio.get());
  else editorWrapEl.style.removeProperty("flex-basis");
  syncEditingState();
  if (view) {
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(mode === "preview")),
    });
  }
  // 预览可见性/刷新/分屏重同步由 pipeline 订阅 view:mode 统一处理
  bus.emit("view:mode", { mode });
  if (mode !== "preview" && view && !view.hasFocus) view.focus();
}

export function getViewMode(): ViewMode {
  return viewMode.get();
}

export function setLineNumbersEnabled(enabled: boolean) {
  if (!view) return;
  view.dispatch({
    effects: lineNumbersCompartment.reconfigure(enabled ? lineNumbers() : []),
  });
}

function syncEditingState() {
  const readOnly = viewMode.get() === "preview";
  const hasDoc = current.get() !== null;
  for (const button of toolButtons) {
    if (button.id !== "outline-toggle") button.disabled = readOnly || !hasDoc;
  }
  if (readOnly) {
    closeTablePopover();
    view?.contentDOM.blur();
  }
}

/* ---------- 打开 / 关闭编辑器 ---------- */
export function showEditor(title: string, content: string, pathHint = "") {
  const v = getEditorView();
  loadingDoc = true;
  try {
    v.setState(EditorState.create({ doc: content, extensions: getExtensions() }));
  } finally {
    loadingDoc = false;
  }
  setLineNumbersEnabled(localStorage.getItem("notebook:line-numbers") !== "0");
  v.scrollDOM.scrollTop = 0;
  editorBodyEl.hidden = false;
  editorMainEl.hidden = false;
  editorHeaderEl.hidden = false;
  toolbarEl.hidden = false;
  statusbarEl.hidden = false;
  editorEmptyEl.hidden = true;
  syncEditingState();
  editorTitleEl.textContent = title;
  editorTitleEl.title = pathHint || title;
  setCountStatsFromText(content);
  updateCount();
  setSaveStatus("idle", "");
  if (viewMode.get() !== "preview") v.focus();
}

export function closeEditor() {
  dirty.set(false);
  closeFindPanel(getEditorView());
  syncEditingState();
  commitNoteBtn.hidden = true;
  saveAsNoteBtn.hidden = true;
  loadingDoc = true;
  try {
    const v = getEditorView();
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: "" },
      annotations: Transaction.addToHistory.of(false),
    });
  } finally {
    loadingDoc = false;
  }
  editorBodyEl.hidden = true;
  editorMainEl.hidden = true;
  editorHeaderEl.hidden = true;
  toolbarEl.hidden = true;
  statusbarEl.hidden = true;
  editorEmptyEl.hidden = false;
  statChars = 0;
  statWords = 0;
  wordCountEl.textContent = "";
  setSaveStatus("idle", "");
}

function updateMissingBadge(gone: boolean, isFile: boolean) {
  missingBadgeEl.hidden = !gone;
  if (gone) {
    savedStatusEl.textContent = isFile ? t("editor.missing.deleted") : t("editor.missing.note");
  }
}

/* ---------- 输入辅助（均为单事务，撤销一步到位；事务经 updateListener 生效） ---------- */

export function wrapSelection(before: string, after: string, placeholderText: string) {
  if (!canEditCurrent()) return;
  const v = getEditorView();
  const { from, to } = v.state.selection.main;
  const selected = v.state.sliceDoc(from, to) || placeholderText;
  const text = before + selected + after;
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
    scrollIntoView: true,
  });
  v.focus();
}

export function prefixLines(prefix: string, placeholderText: string) {
  if (!canEditCurrent()) return;
  const v = getEditorView();
  const { from, to } = v.state.selection.main;
  const lineStart = v.state.doc.lineAt(from).from;
  const lineEnd = v.state.doc.lineAt(to).to;
  const block = v.state.sliceDoc(lineStart, lineEnd);

  if (!block.trim()) {
    const insert = prefix + placeholderText;
    v.dispatch({
      changes: { from: lineStart, to: lineEnd, insert },
      selection: { anchor: lineStart + prefix.length, head: lineStart + insert.length },
    });
  } else {
    const out = block
      .split("\n")
      .map((l) => (l.trim() ? prefix + l : l))
      .join("\n");
    v.dispatch({
      changes: { from: lineStart, to: lineEnd, insert: out },
      selection: { anchor: lineStart + prefix.length, head: lineStart + prefix.length },
    });
  }
  v.focus();
}

export function insertBlock(text: string) {
  if (!canEditCurrent()) return;
  const v = getEditorView();
  const { from, to } = v.state.selection.main;
  const before = v.state.sliceDoc(0, from);
  const after = v.state.sliceDoc(to);
  const needBefore = before.length > 0 && !before.endsWith("\n\n");
  const needAfter = after.length > 0 && !after.startsWith("\n\n");
  const ins = (needBefore ? "\n\n" : "") + text + (needAfter ? "\n\n" : "");
  const pos = from + ins.length - (needAfter ? 2 : 0);
  v.dispatch({
    changes: { from, to, insert: ins },
    selection: { anchor: pos, head: pos },
    scrollIntoView: true,
  });
  v.focus();
}

export function insertCodeBlock() {
  if (!canEditCurrent()) return;
  const v = getEditorView();
  const { from, to } = v.state.selection.main;
  const selected = v.state.sliceDoc(from, to).trim() || t("editor.codePlaceholder");
  const before = v.state.sliceDoc(0, from);
  const after = v.state.sliceDoc(to);
  const needBefore = before.length > 0 && !before.endsWith("\n\n");
  const needAfter = after.length > 0 && !after.startsWith("\n\n");
  const ins = (needBefore ? "\n\n" : "") + "```\n" + selected + "\n```" + (needAfter ? "\n\n" : "");
  const bodyStart = from + (needBefore ? 2 : 0) + 4;
  v.dispatch({
    changes: { from, to, insert: ins },
    selection: { anchor: bodyStart, head: bodyStart + selected.length },
    scrollIntoView: true,
  });
  v.focus();
}

export function insertLink() {
  if (!canEditCurrent()) return;
  const v = getEditorView();
  const { from, to } = v.state.selection.main;
  const selected = v.state.sliceDoc(from, to).trim();
  const isUrl =
    /^https?:\/\/\S+$/.test(selected) || /^(?:\w+\.)+\w+(?::\d+)?(?:\/\S*)?$/.test(selected);
  const text = isUrl ? selected : selected || t("editor.linkPlaceholder");
  const url = isUrl ? (selected.startsWith("http") ? selected : `https://${selected}`) : "https://";
  const ins = `[${text}](${url})`;
  const urlStart = from + ins.indexOf("(") + 1;
  v.dispatch({
    changes: { from, to, insert: ins },
    selection: { anchor: urlStart, head: urlStart + url.length },
    scrollIntoView: true,
  });
  v.focus();
}

export async function insertImage() {
  if (!canEditCurrent()) return;
  const source = current.get();
  const picked = await openDialog({
    multiple: true,
    title: t("editor.insertImage"),
    filters: [
      {
        name: t("editor.images"),
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"],
      },
    ],
  });
  if (!picked || !canEditCurrent() || !sameSource(source, current.get())) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  const blocks = paths
    .filter((p) => IMAGE_EXT_RE.test(p))
    .map((p) => {
      const name = p.split(/[\\/]/).pop() ?? t("editor.imageFallback");
      const alt = name.replace(/\.[^.]+$/, "");
      const href = p.replace(/\\/g, "/");
      return `![${alt}](${href})`;
    });
  if (blocks.length === 0) return;
  insertBlock(blocks.join("\n\n"));
}

export function applyTableTextToEditor(text: string, firstCellStart: number, firstCellLen: number) {
  if (!canEditCurrent()) return;
  const v = getEditorView();
  const { from, to } = v.state.selection.main;
  const before = v.state.sliceDoc(0, from);
  const after = v.state.sliceDoc(to);
  const needBefore = before.length > 0 && !before.endsWith("\n\n");
  const needAfter = after.length > 0 && !after.startsWith("\n\n");
  const ins = (needBefore ? "\n\n" : "") + text + (needAfter ? "\n\n" : "");
  const cellStart = from + (needBefore ? 2 : 0) + firstCellStart;
  v.dispatch({
    changes: { from, to, insert: ins },
    selection: { anchor: cellStart, head: cellStart + firstCellLen },
    scrollIntoView: true,
  });
  v.focus();
}

export function runCommand(cmd: string, onTableToggle?: () => void) {
  if (!canEditCurrent()) return;
  if (cmd === "table") {
    if (onTableToggle) onTableToggle();
    return;
  }
  switch (cmd) {
    case "h1":
      prefixLines("# ", t("editor.command.h1"));
      break;
    case "h2":
      prefixLines("## ", t("editor.command.h2"));
      break;
    case "h3":
      prefixLines("### ", t("editor.command.h3"));
      break;
    case "bold":
      wrapSelection("**", "**", t("editor.command.bold"));
      break;
    case "italic":
      wrapSelection("*", "*", t("editor.command.italic"));
      break;
    case "strike":
      wrapSelection("~~", "~~", t("editor.command.strike"));
      break;
    case "quote":
      prefixLines("> ", t("editor.command.quote"));
      break;
    case "code":
      wrapSelection("`", "`", t("editor.command.code"));
      break;
    case "codeblock":
      insertCodeBlock();
      break;
    case "ul":
      prefixLines("- ", t("editor.command.ul"));
      break;
    case "ol":
      prefixLines("1. ", t("editor.command.ol"));
      break;
    case "task":
      prefixLines("- [ ] ", t("editor.command.task"));
      break;
    case "link":
      insertLink();
      break;
    case "image":
      void insertImage();
      break;
    case "hr":
      insertBlock("---");
      break;
  }
}

/* ---------- 粘贴处理（URL 转链接 + 图片落盘插入） ---------- */

function handlePaste(e: ClipboardEvent, v: EditorView): boolean {
  if (!canEditCurrent() || e.clipboardData == null) return false;
  const text = e.clipboardData.getData("text")?.trim();
  const sel = v.state.selection.main;
  if (text && !sel.empty) {
    const isUrl =
      /^https?:\/\/\S+$/i.test(text) || /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(text);
    if (isUrl) {
      e.preventDefault();
      const selected = v.state.sliceDoc(sel.from, sel.to);
      const validUrl = text.startsWith("http") ? text : `https://${text}`;
      const md = `[${selected}](${validUrl})`;
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: md },
        selection: { anchor: sel.from + md.length },
        scrollIntoView: true,
      });
      return true;
    }
  }
  const items = Array.from(e.clipboardData.items ?? []);
  if (items.some((it) => it.type.startsWith("image/"))) {
    e.preventDefault();
    void handlePasteImage(e, v);
    return true;
  }
  return false;
}

async function handlePasteImage(e: ClipboardEvent, v: EditorView) {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imageItems = items.filter((it) => it.type.startsWith("image/"));
  if (imageItems.length === 0) return;
  const inserted: string[] = [];
  let failed = 0;
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;
    const ext = item.type.split("/").slice(-1)[0]?.toLowerCase() ?? "png";
    const safeExt = IMAGE_EXT_RE.test(`.${ext}`) ? ext : "png";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `Pasted-${stamp}.${safeExt}`;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const path = await invoke<string>("save_pasted_image", { fileName, data });
      inserted.push(`![${fileName}](${path.replace(/\\/g, "/")})`);
    } catch {
      failed++;
    }
  }
  if (!canEditCurrent()) {
    if (failed > 0) setStatus(t("paste.imageFail", { count: failed }));
    return;
  }
  if (inserted.length === 0) {
    if (failed > 0) setStatus(t("paste.imageFail", { count: failed }));
    return;
  }
  const text = inserted.join("\n\n");
  const { from, to } = v.state.selection.main;
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  if (failed > 0) setStatus(t("paste.imageInserted", { inserted: inserted.length, failed }));
}

/* ---------- 编辑器右键菜单 ---------- */

function handleEditorContextMenu(e: MouseEvent, view: EditorView): boolean {
  e.preventDefault();
  const items: CtxItem[] = [
    { label: t("contextMenu.undo"), action: () => cmUndo(view), shortcut: "Ctrl+Z" },
    { label: t("contextMenu.redo"), action: () => cmRedo(view), shortcut: "Ctrl+Y" },
    { separator: true },
    { label: t("contextMenu.cut"), action: () => dispatchEditorKey(view, "x"), shortcut: "Ctrl+X" },
    { label: t("contextMenu.copy"), action: () => dispatchEditorKey(view, "c"), shortcut: "Ctrl+C" },
    { label: t("contextMenu.paste"), action: () => dispatchEditorKey(view, "v"), shortcut: "Ctrl+V" },
    { separator: true },
    { label: t("contextMenu.selectAll"), action: () => selectAllInEditor(view), shortcut: "Ctrl+A" },
  ];
  showContextMenu(e.clientX, e.clientY, items);
  return true;
}

function dispatchEditorKey(view: EditorView, key: string) {
  view.focus();
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "x" ? "KeyX" : key === "c" ? "KeyC" : key === "v" ? "KeyV" : "KeyA",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
}

function selectAllInEditor(view: EditorView) {
  view.dispatch({
    selection: { anchor: 0, head: view.state.doc.length },
    scrollIntoView: true,
  });
}

/* ---------- 生命周期 ---------- */

export function initEditor(previewElement: HTMLElement, deps: EditorHotPathDeps) {
  hotPathDeps = deps;
  initSplitResizer();

  view = new EditorView({
    parent: mountEl,
    state: EditorState.create({ doc: "", extensions: getExtensions() }),
  });

  updateEditorPlaceholder();

  // 编辑器头部随状态信号联动：按钮形态、标题、缺失徽标
  current.subscribe((src) => {
    syncHeaderButtons(src);
    syncMissingBadge();
  });
  notes.subscribe(() => {
    syncEditorTitleFromMeta();
    syncMissingBadge();
  });
  missingPaths.subscribe(syncMissingBadge);
  syncHeaderButtons(current.get());
  syncMissingBadge();
  bus.on("app:locale", () => {
    syncHeaderButtons(current.get());
    updateEditorPlaceholder();
  });

  // 预览区链接点击：按住 Ctrl 时才调用系统浏览器打开，否则保持默认行为
  previewElement.addEventListener("click", async (e) => {
    const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || !/^https?:/i.test(href)) return;
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    try {
      await invoke("open_external", { url: href });
    } catch {
      window.open(href, "_blank");
    }
  });
}

function sameSource(a: Source | null, b: Source | null): boolean {
  if (!a || !b) return false;
  if (a.kind === "note" && b.kind === "note") return a.id === b.id;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  return false;
}

/* ---------- 分屏分割条拖拽 ---------- */

const SPLIT_GAP_PX = 5;
let splitLayoutRaf = 0;

function applySplitRatio(ratio: number) {
  splitRatio.set(Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)));
  scheduleSplitLayout();
}

function updateSplitLayout() {
  splitLayoutRaf = 0;
  if (viewMode.get() !== "split") return;
  const vertical = window.matchMedia("(max-width: 720px)").matches;
  const size = vertical ? editorBodyEl.clientHeight : editorBodyEl.clientWidth;
  const usable = Math.max(0, size - SPLIT_GAP_PX);
  editorWrapEl.style.flexBasis = `${Math.round(usable * splitRatio.get())}px`;
}

function scheduleSplitLayout() {
  if (splitLayoutRaf) return;
  splitLayoutRaf = requestAnimationFrame(updateSplitLayout);
}

export function initSplitResizer() {
  applySplitRatio(splitRatio.get());
  new ResizeObserver(() => {
    scheduleSplitLayout();
    scheduleSplitResync();
  }).observe(editorBodyEl);

  splitResizerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitResizerEl.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    setScrollSyncSuspended(true);

    const vertical = window.matchMedia("(max-width: 720px)").matches;
    const startPos = vertical ? e.clientY : e.clientX;
    const startSize = vertical ? editorBodyEl.clientHeight : editorBodyEl.clientWidth;
    const startRatio = splitRatio.get();

    const onMove = (ev: PointerEvent) => {
      const currentPos = vertical ? ev.clientY : ev.clientX;
      const usable = Math.max(1, startSize - SPLIT_GAP_PX);
      applySplitRatio(startRatio + (currentPos - startPos) / usable);
    };

    const onUp = (ev: PointerEvent) => {
      document.body.classList.remove("resizing");
      splitResizerEl.removeEventListener("pointermove", onMove);
      splitResizerEl.removeEventListener("pointerup", onUp);
      splitResizerEl.removeEventListener("pointercancel", onUp);
      if (splitResizerEl.hasPointerCapture(ev.pointerId)) {
        splitResizerEl.releasePointerCapture(ev.pointerId);
      }
      localStorage.setItem("notebook:split-ratio", String(splitRatio.get()));
      setScrollSyncSuspended(false);
      scheduleSplitResync();
    };

    splitResizerEl.addEventListener("pointermove", onMove);
    splitResizerEl.addEventListener("pointerup", onUp);
    splitResizerEl.addEventListener("pointercancel", onUp);
  });

  splitResizerEl.addEventListener("dblclick", () => {
    applySplitRatio(SPLIT_RATIO_DEFAULT);
    localStorage.setItem("notebook:split-ratio", String(SPLIT_RATIO_DEFAULT));
    scheduleSplitResync();
  });
}