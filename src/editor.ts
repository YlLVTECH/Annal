// 编辑器模块：基于 CodeMirror 6，替换原 textarea 实现。
// - 视口渲染：50,000 行文档也只创建视口附近的行节点，原生滚动，无需全量 DOM。
// - 撤销/重做、IME 组合输入、Tab 缩进、列表续行（Enter）均由 CM 内置处理。
// - 输入一处内容只触发该处受影响 Markdown 块的重渲染（经 onDocChange 通知模型）。

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { closeTablePopover } from "./table";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { Compartment, EditorState, Transaction, type ChangeSet, type Extension } from "@codemirror/state";
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
import { setScrollSyncSuspended, scheduleResync as scheduleSplitResync } from "./documentPosition";
import {
  IMAGE_EXT_RE,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  state,
} from "./state";
import { parseViewMode } from "./types";
import { t } from "./i18n";
import type { ViewMode } from "./types";

/* ---------- 依赖注入（由 main.ts 提供） ---------- */
export interface EditorDeps {
  /** 内容编辑后的回调（自动保存入口） */
  onEditChange: () => void;
  /** 文档变更回调：range 为 0 起始的源行闭区间；hasNewlineChange 表示本次编辑
   *  插入或删除了换行（影响块边界，模型据此决定是否走全量重解析） */
  onDocChange: (
    range: { start: number; end: number; hasNewlineChange: boolean },
    text: string,
  ) => void;
  /** 预览可见性控制（编辑模式隐藏） */
  setPreviewVisible: (visible: boolean) => void;
  /** 预览内容/布局刷新入口 */
  refreshPreview: () => void;
  /** 预览布局可能失效时重排 */
  markPreviewLayoutDirty: () => void;
  /** 预览容器元素（链接点击代理挂在这里） */
  previewElement: HTMLElement;
}

let deps: EditorDeps | null = null;

/* ---------- DOM 元素 ---------- */
const editorHeaderEl = document.querySelector<HTMLDivElement>("#editor-header")!;
const editorTitleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
const missingBadgeEl = document.querySelector<HTMLSpanElement>("#editor-missing")!;
const savedStatusEl = document.querySelector<HTMLSpanElement>("#saved-status")!;
const editorEmptyEl = document.querySelector<HTMLDivElement>("#editor-empty")!;
const toolbarEl = document.querySelector<HTMLDivElement>("#toolbar")!;
const editorBodyEl = document.querySelector<HTMLDivElement>("#editor-body")!;
const editorWrapEl = document.querySelector<HTMLDivElement>("#editor-wrap")!;
const splitResizerEl = document.querySelector<HTMLDivElement>("#split-resizer")!;
const mountEl = document.querySelector<HTMLDivElement>("#editor")!;
const statusbarEl = document.querySelector<HTMLDivElement>("#statusbar")!;
const wordCountEl = document.querySelector<HTMLSpanElement>("#word-count")!;
const commitNoteBtn = document.querySelector<HTMLButtonElement>("#commit-note-btn")!;
const saveAsNoteBtn = document.querySelector<HTMLButtonElement>("#save-as-note-btn")!;
const viewButtons = document.querySelectorAll<HTMLButtonElement>(".view-btn");
const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool-btn");

/* ---------- CodeMirror 视图与状态 ---------- */
let view: EditorView | null = null;
const readOnlyCompartment = new Compartment();
const lineNumbersCompartment = new Compartment();

/** 加载/切换文档时置位：该次变更不触发自动保存与预览增量更新 */
let loadingDoc = false;

const extensions: Extension[] = [
  lineNumbersCompartment.of(lineNumbers()),
  highlightActiveLine(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorView.lineWrapping,
  bracketMatching(),
  indentUnit.of("  "),
  markdown(),
  placeholder(t("editor.placeholder")),
  readOnlyCompartment.of(EditorState.readOnly.of(false)),
  EditorView.contentAttributes.of({
    spellcheck: "false",
    autocapitalize: "off",
    autocomplete: "off",
  }),
  // 键位优先级：后声明的 keymap 优先。Enter 续行绑定放最后（最高优先），
  // 其次 Shift+Tab/Tab 缩进；默认键位与历史键位在前。
  keymap.of(defaultKeymap),
  keymap.of(historyKeymap),
  keymap.of([indentWithTab]),
  keymap.of([{ key: "Enter", run: insertNewlineContinueMarkup }]),
  EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (loadingDoc) return;
    onDocChanged(update.changes, update.startState, update.state);
    deps?.onEditChange();
    scheduleCount();
  }),
  EditorView.domEventHandlers({ paste: handlePaste }),
];

function onDocChanged(
  changes: ChangeSet,
  startState: EditorState,
  newState: EditorState,
) {
  let minLine = Number.POSITIVE_INFINITY;
  let maxLine = -1;
  let hasNewlineChange = false;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const oldSeg = startState.sliceDoc(fromA, toA);
    const newSeg = newState.sliceDoc(fromB, toB);
    if (oldSeg.includes("\n") || newSeg.includes("\n")) hasNewlineChange = true;
    const a = startState.doc.lineAt(Math.min(fromA, startState.doc.length)).number - 1;
    const b = newState.doc.lineAt(Math.min(Math.max(toB, 1), newState.doc.length)).number - 1;
    if (a < minLine) minLine = a;
    if (b > maxLine) maxLine = b;
  });
  if (minLine === Number.POSITIVE_INFINITY) {
    minLine = 0;
    maxLine = newState.doc.lines - 1;
  } else {
    // 前后各多带一行：结构变化（如输入 ``` 开围栏）会影响相邻块的归属
    minLine = Math.max(0, minLine - 1);
    maxLine = Math.min(newState.doc.lines - 1, maxLine + 1);
  }
  deps?.onDocChange(
    { start: minLine, end: maxLine, hasNewlineChange },
    newState.doc.toString(),
  );
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
  return Boolean(state.current) && state.viewMode !== "preview" && !editorBodyEl.hidden;
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

/* ---------- 字数统计 ---------- */
let countTimer: number | undefined;

export function updateCount() {
  const text = getEditorText();
  const chars = text.replace(/\s/g, "").length;
  const words = (text.match(/[A-Za-z0-9_]+/g) ?? []).length;
  const minutes = text.trim().length === 0 ? 0 : Math.max(1, Math.ceil(chars / 400));
  const parts = [t("editor.count.chars", { count: chars })];
  if (words > 0) parts.push(t("editor.count.words", { count: words }));
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
  state.viewMode = mode;
  editorBodyEl.className = `mode-${mode}`;
  for (const b of viewButtons) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
  localStorage.setItem("notebook:view", mode);
  if (mode === "split") applySplitRatio(state.splitRatio);
  else editorWrapEl.style.removeProperty("flex-basis");
  syncEditingState();
  if (view) {
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(mode === "preview")),
    });
  }
  deps?.setPreviewVisible(mode !== "edit");
  if (mode !== "edit") deps?.refreshPreview();
  if (mode === "split") scheduleSplitResync();
  if (mode !== "preview" && view && !view.hasFocus) view.focus();
}

export function getViewMode(): ViewMode {
  return state.viewMode;
}

export function setLineNumbersEnabled(enabled: boolean) {
  if (!view) return;
  view.dispatch({
    effects: lineNumbersCompartment.reconfigure(enabled ? lineNumbers() : []),
  });
}

function syncEditingState() {
  const readOnly = state.viewMode === "preview";
  for (const button of toolButtons) button.disabled = readOnly || !state.current;
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
    v.setState(EditorState.create({ doc: content, extensions }));
  } finally {
    loadingDoc = false;
  }
  setLineNumbersEnabled(localStorage.getItem("notebook:line-numbers") !== "0");
  v.scrollDOM.scrollTop = 0;
  editorBodyEl.hidden = false;
  editorHeaderEl.hidden = false;
  toolbarEl.hidden = false;
  statusbarEl.hidden = false;
  editorEmptyEl.hidden = true;
  syncEditingState();
  editorTitleEl.textContent = title;
  editorTitleEl.title = pathHint || title;
  deps?.setPreviewVisible(state.viewMode !== "edit");
  deps?.refreshPreview();
  updateCount();
  setSaveStatus("idle", "");
  if (state.viewMode !== "preview") v.focus();
}

export function closeEditor() {
  state.current = null;
  state.dirty = false;
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
  deps?.setPreviewVisible(false);
  deps?.refreshPreview();
  editorBodyEl.hidden = true;
  editorHeaderEl.hidden = true;
  toolbarEl.hidden = true;
  statusbarEl.hidden = true;
  editorEmptyEl.hidden = false;
  wordCountEl.textContent = "";
  setSaveStatus("idle", "");
}

export function updateMissingBadge(gone: boolean, isFile: boolean) {
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
  const source = state.current;
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
  if (!picked || !canEditCurrent() || !sameSource(source, state.current)) return;
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

/* ---------- 生命周期 ---------- */

export function initEditor(editorDeps: EditorDeps) {
  deps = editorDeps;

  initSplitResizer();

  view = new EditorView({
    parent: mountEl,
    state: EditorState.create({ doc: "", extensions }),
  });

  // 预览区链接点击：按住 Ctrl 时才调用系统浏览器打开，否则保持默认行为
  const root = editorDeps.previewElement;
  root.addEventListener("click", async (e) => {
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

function sameSource(a: typeof state.current, b: typeof state.current): boolean {
  if (!a || !b) return false;
  if (a.kind === "note" && b.kind === "note") return a.id === b.id;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  return false;
}

/* ---------- 分屏分割条拖拽 ---------- */

const SPLIT_GAP_PX = 5;
let splitLayoutRaf = 0;

function applySplitRatio(ratio: number) {
  state.splitRatio = Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
  scheduleSplitLayout();
}

function updateSplitLayout() {
  splitLayoutRaf = 0;
  if (state.viewMode !== "split") return;
  const vertical = window.matchMedia("(max-width: 720px)").matches;
  const size = vertical ? editorBodyEl.clientHeight : editorBodyEl.clientWidth;
  const usable = Math.max(0, size - SPLIT_GAP_PX);
  editorWrapEl.style.flexBasis = `${Math.round(usable * state.splitRatio)}px`;
}

function scheduleSplitLayout() {
  if (splitLayoutRaf) return;
  splitLayoutRaf = requestAnimationFrame(updateSplitLayout);
}

export function initSplitResizer() {
  applySplitRatio(state.splitRatio);
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
    const startRatio = state.splitRatio;

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
      localStorage.setItem("notebook:split-ratio", String(state.splitRatio));
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