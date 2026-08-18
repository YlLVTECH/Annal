import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { renderMarkdown } from "./markdown";
import { closeTablePopover } from "./table";
import {
  markEditorDirty,
  markPreviewDirty,
  scheduleResyncSplit,
  setScrollSyncSuspended,
  syncPreviewToEditor,
} from "./scrollSync";
import {
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  currentPathOfSource,
  IMAGE_EXT_RE,
  state,
} from "./state";
import { parseViewMode } from "./types";
import type { EditSnapshot, ViewMode } from "./types";

/* ---------- DOM 元素获取 ---------- */
const editorHeaderEl = document.querySelector<HTMLDivElement>("#editor-header")!;
const editorTitleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
const missingBadgeEl = document.querySelector<HTMLSpanElement>("#editor-missing")!;
const savedStatusEl = document.querySelector<HTMLSpanElement>("#saved-status")!;
const editorEmptyEl = document.querySelector<HTMLDivElement>("#editor-empty")!;
const toolbarEl = document.querySelector<HTMLDivElement>("#toolbar")!;
const editorBodyEl = document.querySelector<HTMLDivElement>("#editor-body")!;
const editorWrapEl = document.querySelector<HTMLDivElement>("#editor-wrap")!;
const splitResizerEl = document.querySelector<HTMLDivElement>("#split-resizer")!;
const editorEl = document.querySelector<HTMLTextAreaElement>("#editor")!;
const previewEl = document.querySelector<HTMLDivElement>("#preview")!;
const statusbarEl = document.querySelector<HTMLDivElement>("#statusbar")!;
const wordCountEl = document.querySelector<HTMLSpanElement>("#word-count")!;
const commitNoteBtn = document.querySelector<HTMLButtonElement>("#commit-note-btn")!;
const saveAsNoteBtn = document.querySelector<HTMLButtonElement>("#save-as-note-btn")!;
const viewButtons = document.querySelectorAll<HTMLButtonElement>(".view-btn");
const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool-btn");

/* ---------- 撤销 / 重做状态 ---------- */
const MAX_UNDO = 200;
const MAX_UNDO_CHARS = 4 * 1024 * 1024;

let undoStack: EditSnapshot[] = [];
let redoStack: EditSnapshot[] = [];
let undoChars = 0;
let redoChars = 0;
let pendingSnapshot: EditSnapshot | null = null;
let composing = false;
let compositionSnapshot: EditSnapshot | null = null;

/* ---------- 预览防抖与去重 ---------- */
let previewTimer: number | undefined;
let countTimer: number | undefined;
let lastPreviewText = "";
let lastPreviewBaseDir = "";

let onEditChangeCallback: (() => void) | null = null;

export function getEditorElement(): HTMLTextAreaElement {
  return editorEl;
}

export function getPreviewElement(): HTMLDivElement {
  return previewEl;
}

export function isComposing(): boolean {
  return composing;
}

export function canEditCurrent(): boolean {
  return Boolean(state.current) && state.viewMode !== "preview" && !editorBodyEl.hidden;
}

function sameSource(a: typeof state.current, b: typeof state.current): boolean {
  if (!a || !b) return false;
  if (a.kind === "note" && b.kind === "note") return a.id === b.id;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  return false;
}

function syncEditingState() {
  const readOnly = state.viewMode === "preview";
  editorEl.readOnly = readOnly;
  for (const button of toolButtons) button.disabled = readOnly || !state.current;
  if (readOnly) {
    pendingSnapshot = null;
    compositionSnapshot = null;
    composing = false;
    closeTablePopover();
    editorEl.blur();
  }
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export function setSaveStatus(status: SaveStatus, text = "") {
  const suffix = status === "saving" ? "保存中…" : status === "saved" ? "已保存" : status === "error" ? "保存失败" : "";
  savedStatusEl.textContent = text || suffix;
  savedStatusEl.dataset.status = status;
}

export function setStatus(text: string) {
  savedStatusEl.textContent = text;
  if (text) savedStatusEl.dataset.status = "idle";
}

export function snapshotOf(): EditSnapshot {
  return {
    value: editorEl.value,
    start: editorEl.selectionStart ?? 0,
    end: editorEl.selectionEnd ?? 0,
  };
}

function pushHistory(stack: EditSnapshot[], snap: EditSnapshot, chars: number): number {
  stack.push(snap);
  chars += snap.value.length;
  while (stack.length > MAX_UNDO || chars > MAX_UNDO_CHARS) {
    chars -= stack.shift()!.value.length;
  }
  return chars;
}

export function pushUndo(snap: EditSnapshot) {
  if (snap.value === editorEl.value) return;
  redoStack.length = 0;
  redoChars = 0;
  undoChars = pushHistory(undoStack, snap, undoChars);
}

export function applySnapshot(snap: EditSnapshot) {
  editorEl.value = snap.value;
  const len = snap.value.length;
  editorEl.setSelectionRange(Math.min(snap.start, len), Math.min(snap.end, len));
  editorEl.focus();
  afterEdit();
}

export function undo() {
  if (!canEditCurrent()) return;
  const snap = undoStack.pop();
  if (!snap) return;
  undoChars = Math.max(0, undoChars - snap.value.length);
  redoChars = pushHistory(redoStack, snapshotOf(), redoChars);
  applySnapshot(snap);
}

export function redo() {
  if (!canEditCurrent()) return;
  const snap = redoStack.pop();
  if (!snap) return;
  redoChars = Math.max(0, redoChars - snap.value.length);
  undoChars = pushHistory(undoStack, snapshotOf(), undoChars);
  applySnapshot(snap);
}

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  undoChars = 0;
  redoChars = 0;
  pendingSnapshot = null;
  compositionSnapshot = null;
}

export function updateCount() {
  const text = editorEl.value;
  const chars = text.replace(/\s/g, "").length;
  const words = (text.match(/[A-Za-z0-9_]+/g) ?? []).length;
  const minutes = text.trim().length === 0 ? 0 : Math.max(1, Math.ceil(chars / 400));
  const parts = [`${chars} 字`];
  if (words > 0) parts.push(`${words} 词`);
  if (minutes > 0) parts.push(`约 ${minutes} 分钟阅读`);
  wordCountEl.textContent = parts.join(" · ");
}

function scheduleCount() {
  window.clearTimeout(countTimer);
  countTimer = window.setTimeout(updateCount, 250);
}

export function resetSaveStatus() {
  setSaveStatus("idle");
}

export function renderPreview() {
  const text = editorEl.value;
  const baseDir = currentPathOfSource();
  if (text === lastPreviewText && baseDir === lastPreviewBaseDir && previewEl.innerHTML !== "") {
    return;
  }
  lastPreviewText = text;
  lastPreviewBaseDir = baseDir;
  previewEl.innerHTML = text.trim()
    ? renderMarkdown(text, baseDir)
    : '<div class="preview-empty">暂无内容，预览将显示在这里</div>';
  markPreviewDirty();
  // 分屏下重新渲染后按编辑区当前位置重新锚定，而不是维持旧的比例（会导致漂移）
  if (state.viewMode === "split") syncPreviewToEditor();
}

export function schedulePreview() {
  if (state.viewMode === "edit") return;
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(renderPreview, 120);
}

export function afterEdit() {
  markEditorDirty();
  if (onEditChangeCallback) {
    onEditChangeCallback();
  }
  schedulePreview();
  scheduleCount();
}

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
  if (mode !== "edit") renderPreview();
  if (mode === "split") scheduleResyncSplit();
  if (mode !== "preview") editorEl.focus();
}

export function getViewMode(): ViewMode {
  return state.viewMode;
}

export function showEditor(title: string, content: string, pathHint = "") {
  editorEl.value = content;
  resetHistory();
  editorBodyEl.hidden = false;
  editorHeaderEl.hidden = false;
  toolbarEl.hidden = false;
  statusbarEl.hidden = false;
  editorEmptyEl.hidden = true;
  syncEditingState();
  editorTitleEl.textContent = title;
  editorTitleEl.title = pathHint || title;
  editorEl.scrollTop = 0;
  previewEl.scrollTop = 0;
  markEditorDirty();
  renderPreview();
  updateCount();
  setSaveStatus("idle", "");
  if (state.viewMode !== "preview") editorEl.focus();
}

export function closeEditor() {
  state.current = null;
  state.dirty = false;
  syncEditingState();
  commitNoteBtn.hidden = true;
  saveAsNoteBtn.hidden = true;
  editorEl.value = "";
  resetHistory();
  editorEl.hidden = false;
  editorBodyEl.hidden = true;
  editorHeaderEl.hidden = true;
  toolbarEl.hidden = true;
  statusbarEl.hidden = true;
  editorEmptyEl.hidden = false;
  previewEl.innerHTML = "";
  lastPreviewText = "";
  lastPreviewBaseDir = "";
  wordCountEl.textContent = "";
  setSaveStatus("idle", "");
}

export function updateMissingBadge(gone: boolean, isFile: boolean) {
  missingBadgeEl.hidden = !gone;
  if (gone) {
    savedStatusEl.textContent = isFile
      ? "文件已被外部删除，继续输入会自动重新创建"
      : "笔记文件已被外部删除，继续输入会自动重新创建";
  }
}

/* ---------- 选区包裹与插入动作 ---------- */

export function wrapSelection(before: string, after: string, placeholder: string) {
  if (!canEditCurrent()) return;
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e) || placeholder;
  ta.value = value.slice(0, s) + before + sel + after + value.slice(e);
  const ns = s + before.length;
  ta.setSelectionRange(ns, ns + sel.length);
  ta.focus();
  afterEdit();
}

export function prefixLines(prefix: string, placeholder: string) {
  if (!canEditCurrent()) return;
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  let lineEnd = value.indexOf("\n", e);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);

  if (!block.trim()) {
    const insert = prefix + placeholder;
    ta.value = value.slice(0, lineStart) + insert + value.slice(lineEnd);
    ta.setSelectionRange(lineStart + prefix.length, lineStart + insert.length);
  } else {
    const out = block
      .split("\n")
      .map((l) => (l.trim() ? prefix + l : l))
      .join("\n");
    ta.value = value.slice(0, lineStart) + out + value.slice(lineEnd);
    ta.setSelectionRange(lineStart + prefix.length, lineStart + prefix.length);
  }
  ta.focus();
  afterEdit();
}

export function insertBlock(text: string) {
  if (!canEditCurrent()) return;
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const before = value.slice(0, s);
  const after = value.slice(e);
  const needBefore = before.length > 0 && !before.endsWith("\n\n");
  const needAfter = after.length > 0 && !after.startsWith("\n\n");
  const ins = (needBefore ? "\n\n" : "") + text + (needAfter ? "\n\n" : "");
  ta.value = before + ins + after;
  const pos = s + ins.length - (needAfter ? 2 : 0);
  ta.setSelectionRange(pos, pos);
  ta.focus();
  afterEdit();
}

export function insertCodeBlock() {
  if (!canEditCurrent()) return;
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e).trim() || "代码";
  const before = value.slice(0, s);
  const after = value.slice(e);
  const needBefore = before.length > 0 && !before.endsWith("\n\n");
  const needAfter = after.length > 0 && !after.startsWith("\n\n");
  const ins = (needBefore ? "\n\n" : "") + "```\n" + sel + "\n```" + (needAfter ? "\n\n" : "");
  ta.value = before + ins + after;
  const bodyStart = s + (needBefore ? 2 : 0) + 4;
  ta.setSelectionRange(bodyStart, bodyStart + sel.length);
  ta.focus();
  afterEdit();
}

export function insertLink() {
  if (!canEditCurrent()) return;
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e).trim();
  const isUrl =
    /^https?:\/\/\S+$/.test(sel) || /^(?:\w+\.)+\w+(?::\d+)?(?:\/\S*)?$/.test(sel);
  const text = isUrl ? sel : sel || "链接文本";
  const url = isUrl ? (sel.startsWith("http") ? sel : `https://${sel}`) : "https://";
  const ins = `[${text}](${url})`;
  ta.value = value.slice(0, s) + ins + value.slice(e);
  const urlStart = s + ins.indexOf("(") + 1;
  ta.setSelectionRange(urlStart, urlStart + url.length);
  ta.focus();
  afterEdit();
}

export async function insertImage() {
  if (!canEditCurrent()) return;
  const source = state.current;
  const picked = await openDialog({
    multiple: true,
    title: "插入图片",
    filters: [
      {
        name: "图片",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"],
      },
    ],
  });
  if (!picked || !canEditCurrent() || !sameSource(source, state.current)) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  const blocks = paths
    .filter((p) => IMAGE_EXT_RE.test(p))
    .map((p) => {
      const name = p.split(/[\\/]/).pop() ?? "图片";
      const alt = name.replace(/\.[^.]+$/, "");
      const href = p.replace(/\\/g, "/");
      return `![${alt}](${href})`;
    });
  if (blocks.length === 0) return;
  insertBlock(blocks.join("\n\n"));
}

export function applyTableTextToEditor(text: string, firstCellStart: number, firstCellLen: number) {
  if (!canEditCurrent()) return;
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const before = value.slice(0, s);
  const after = value.slice(e);
  const needBefore = before.length > 0 && !before.endsWith("\n\n");
  const needAfter = after.length > 0 && !after.startsWith("\n\n");
  const ins = (needBefore ? "\n\n" : "") + text + (needAfter ? "\n\n" : "");
  pushUndo(snapshotOf());
  ta.value = before + ins + after;
  const cellStart = s + (needBefore ? 2 : 0) + firstCellStart;
  ta.setSelectionRange(cellStart, cellStart + firstCellLen);
  ta.focus();
  afterEdit();
}

export function runCommand(cmd: string, onTableToggle?: () => void) {
  if (!canEditCurrent()) return;
  if (cmd === "table") {
    if (onTableToggle) onTableToggle();
    return;
  }
  pushUndo(snapshotOf());
  switch (cmd) {
    case "h1":
      prefixLines("# ", "标题");
      break;
    case "h2":
      prefixLines("## ", "标题");
      break;
    case "h3":
      prefixLines("### ", "标题");
      break;
    case "bold":
      wrapSelection("**", "**", "粗体");
      break;
    case "italic":
      wrapSelection("*", "*", "斜体");
      break;
    case "strike":
      wrapSelection("~~", "~~", "删除线");
      break;
    case "quote":
      prefixLines("> ", "引用内容");
      break;
    case "code":
      wrapSelection("`", "`", "代码");
      break;
    case "codeblock":
      insertCodeBlock();
      break;
    case "ul":
      prefixLines("- ", "列表项");
      break;
    case "ol":
      prefixLines("1. ", "列表项");
      break;
    case "task":
      prefixLines("- [ ] ", "待办事项");
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

/* ---------- 编辑器键盘增强功能 (Tab缩进/列表续行/URL智能粘贴) ---------- */

function handleTabKey(e: KeyboardEvent) {
  if (!canEditCurrent()) return;
  e.preventDefault();
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: ePos, value } = ta;
  pushUndo(snapshotOf());

  const isShift = e.shiftKey;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  let lineEnd = value.indexOf("\n", ePos);
  if (lineEnd === -1) lineEnd = value.length;

  if (s === ePos && !isShift) {
    // 光标单点按 Tab：插入 2 个空格
    ta.value = value.slice(0, s) + "  " + value.slice(s);
    ta.setSelectionRange(s + 2, s + 2);
  } else {
    // 多行选区或 Shift+Tab 反缩进
    const selectedBlock = value.slice(lineStart, lineEnd);
    const lines = selectedBlock.split("\n");
    let changedLen = 0;
    const modifiedLines = lines.map((line) => {
      if (isShift) {
        if (line.startsWith("  ")) {
          changedLen -= 2;
          return line.slice(2);
        } else if (line.startsWith("\t") || line.startsWith(" ")) {
          changedLen -= 1;
          return line.slice(1);
        }
        return line;
      } else {
        changedLen += 2;
        return "  " + line;
      }
    });

    const newBlock = modifiedLines.join("\n");
    ta.value = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
    ta.setSelectionRange(lineStart, lineEnd + changedLen);
  }
  afterEdit();
}

function handleEnterKey(e: KeyboardEvent): boolean {
  if (!canEditCurrent()) return false;
  const ta = editorEl;
  const { selectionStart: s, value } = ta;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const currentLine = value.slice(lineStart, s);

  // 匹配列表正则：无序 (-/*)、有序 (1.)、任务 (- [ ] / - [x])
  const taskMatch = currentLine.match(/^(\s*)([-*+]\s+\[[ xX]\]\s+)(.*)$/);
  const olMatch = currentLine.match(/^(\s*)(\d+)(\.\s+)(.*)$/);
  const ulMatch = currentLine.match(/^(\s*)([-*+]\s+)(.*)$/);

  if (taskMatch) {
    e.preventDefault();
    pushUndo(snapshotOf());
    const [_, indent, _prefix, rest] = taskMatch;
    if (!rest.trim()) {
      // 空列表项回车：清除该行前缀并退回普通换行
      ta.value = value.slice(0, lineStart) + value.slice(s);
      ta.setSelectionRange(lineStart, lineStart);
    } else {
      const nextPrefix = `\n${indent}- [ ] `;
      ta.value = value.slice(0, s) + nextPrefix + value.slice(s);
      ta.setSelectionRange(s + nextPrefix.length, s + nextPrefix.length);
    }
    afterEdit();
    return true;
  }

  if (olMatch) {
    e.preventDefault();
    pushUndo(snapshotOf());
    const [_, indent, numStr, dot, rest] = olMatch;
    if (!rest.trim()) {
      ta.value = value.slice(0, lineStart) + value.slice(s);
      ta.setSelectionRange(lineStart, lineStart);
    } else {
      const nextNum = parseInt(numStr, 10) + 1;
      const nextPrefix = `\n${indent}${nextNum}${dot}`;
      ta.value = value.slice(0, s) + nextPrefix + value.slice(s);
      ta.setSelectionRange(s + nextPrefix.length, s + nextPrefix.length);
    }
    afterEdit();
    return true;
  }

  if (ulMatch) {
    e.preventDefault();
    pushUndo(snapshotOf());
    const [_, indent, prefix, rest] = ulMatch;
    if (!rest.trim()) {
      ta.value = value.slice(0, lineStart) + value.slice(s);
      ta.setSelectionRange(lineStart, lineStart);
    } else {
      const nextPrefix = `\n${indent}${prefix}`;
      ta.value = value.slice(0, s) + nextPrefix + value.slice(s);
      ta.setSelectionRange(s + nextPrefix.length, s + nextPrefix.length);
    }
    afterEdit();
    return true;
  }

  return false;
}

function handlePasteUrl(e: ClipboardEvent) {
  if (!canEditCurrent()) return;
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: ePos, value } = ta;
  if (s === ePos) return; // 无选中文本正常粘贴

  const pastedText = e.clipboardData?.getData("text")?.trim();
  if (!pastedText) return;

  const isUrl =
    /^https?:\/\/\S+$/i.test(pastedText) ||
    /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(pastedText);

  if (isUrl) {
    e.preventDefault();
    pushUndo(snapshotOf());
    const selected = value.slice(s, ePos);
    const validUrl = pastedText.startsWith("http") ? pastedText : `https://${pastedText}`;
    const mdLink = `[${selected}](${validUrl})`;
    ta.value = value.slice(0, s) + mdLink + value.slice(ePos);
    const newPos = s + mdLink.length;
    ta.setSelectionRange(newPos, newPos);
    afterEdit();
  }
}

async function handlePasteImage(e: ClipboardEvent) {
  if (!canEditCurrent()) return;
  const items = Array.from(e.clipboardData?.items ?? []);
  const imageItems = items.filter((it) => it.type.startsWith("image/"));
  if (imageItems.length === 0) return;
  e.preventDefault();
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
      const path = await invoke<string>("save_pasted_image", {
        fileName,
        data,
      });
      inserted.push(`![${fileName}](${path.replace(/\\/g, "/")})`);
    } catch {
      // 单张图片失败不影响其余，但要在状态栏给出可见提示
      failed++;
    }
  }
  if (inserted.length === 0) {
    if (failed > 0) setStatus(`图片粘贴失败：${failed} 张图片未能保存`);
    return;
  }
  const text = inserted.join("\n\n");
  const ta = editorEl;
  const { selectionStart: s, selectionEnd: ePos, value } = ta;
  ta.value = value.slice(0, s) + text + value.slice(ePos);
  ta.setSelectionRange(s + text.length, s + text.length);
  ta.focus();
  afterEdit();
  if (failed > 0) setStatus(`已插入 ${inserted.length} 张图片，${failed} 张保存失败`);
}

export function initEditor(onEditChange: () => void) {
  onEditChangeCallback = onEditChange;

  initSplitResizer();

  editorEl.addEventListener("beforeinput", (e) => {
    if (!canEditCurrent()) {
      e.preventDefault();
      pendingSnapshot = null;
      return;
    }
    if (e.inputType === "historyUndo") {
      e.preventDefault();
      if (!composing) undo();
      return;
    }
    if (e.inputType === "historyRedo") {
      e.preventDefault();
      if (!composing) redo();
      return;
    }
    if (composing) return;
    pendingSnapshot = snapshotOf();
  });

  editorEl.addEventListener("compositionstart", () => {
    if (!canEditCurrent()) return;
    composing = true;
    pendingSnapshot = null;
    compositionSnapshot = snapshotOf();
  });

  editorEl.addEventListener("compositionend", () => {
    composing = false;
    const snap = compositionSnapshot;
    compositionSnapshot = null;
    pendingSnapshot = null;
    if (snap && snap.value !== editorEl.value) pushUndo(snap);
  });

  editorEl.addEventListener("input", () => {
    if (!canEditCurrent()) return;
    if (!composing && pendingSnapshot) {
      pushUndo(pendingSnapshot);
      pendingSnapshot = null;
    }
    afterEdit();
  });

  editorEl.addEventListener("keydown", (e) => {
    if (composing) return;
    if (e.key === "Tab") {
      handleTabKey(e);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !composing) {
      if (handleEnterKey(e)) return;
    }
  });

  editorEl.addEventListener("paste", handlePasteUrl);
  editorEl.addEventListener("paste", handlePasteImage);

  // 预览区链接点击：按住 Ctrl 时才调用系统浏览器打开，否则保持默认行为
  previewEl.addEventListener("click", async (e) => {
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
    scheduleResyncSplit();
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
      scheduleResyncSplit();
    };

    splitResizerEl.addEventListener("pointermove", onMove);
    splitResizerEl.addEventListener("pointerup", onUp);
    splitResizerEl.addEventListener("pointercancel", onUp);
  });

  splitResizerEl.addEventListener("dblclick", () => {
    applySplitRatio(SPLIT_RATIO_DEFAULT);
    localStorage.setItem("notebook:split-ratio", String(SPLIT_RATIO_DEFAULT));
    scheduleResyncSplit();
  });
}
