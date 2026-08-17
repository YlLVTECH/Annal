import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { renderMarkdown } from "./markdown";
import { currentPathOfSource, IMAGE_EXT_RE, state } from "./state";
import type { EditSnapshot, ViewMode } from "./types";

/* ---------- DOM 元素获取 ---------- */
const editorHeaderEl = document.querySelector<HTMLDivElement>("#editor-header")!;
const editorTitleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
const missingBadgeEl = document.querySelector<HTMLSpanElement>("#editor-missing")!;
const savedStatusEl = document.querySelector<HTMLSpanElement>("#saved-status")!;
const editorEmptyEl = document.querySelector<HTMLDivElement>("#editor-empty")!;
const toolbarEl = document.querySelector<HTMLDivElement>("#toolbar")!;
const editorBodyEl = document.querySelector<HTMLDivElement>("#editor-body")!;
const editorEl = document.querySelector<HTMLTextAreaElement>("#editor")!;
const previewEl = document.querySelector<HTMLDivElement>("#preview")!;
const statusbarEl = document.querySelector<HTMLDivElement>("#statusbar")!;
const wordCountEl = document.querySelector<HTMLSpanElement>("#word-count")!;
const commitNoteBtn = document.querySelector<HTMLButtonElement>("#commit-note-btn")!;
const saveAsNoteBtn = document.querySelector<HTMLButtonElement>("#save-as-note-btn")!;
const viewButtons = document.querySelectorAll<HTMLButtonElement>(".view-btn");

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

export function setStatus(text: string) {
  savedStatusEl.textContent = text;
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
  const snap = undoStack.pop();
  if (!snap) return;
  undoChars = Math.max(0, undoChars - snap.value.length);
  redoChars = pushHistory(redoStack, snapshotOf(), redoChars);
  applySnapshot(snap);
}

export function redo() {
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
  const parts = [`${chars} 字`];
  if (words > 0) parts.push(`${words} 词`);
  wordCountEl.textContent = parts.join(" · ");
}

function scheduleCount() {
  window.clearTimeout(countTimer);
  countTimer = window.setTimeout(updateCount, 250);
}

export function renderPreview() {
  const text = editorEl.value;
  const baseDir = currentPathOfSource();
  if (text === lastPreviewText && baseDir === lastPreviewBaseDir) return;
  lastPreviewText = text;
  lastPreviewBaseDir = baseDir;
  let ratio = -1;
  if (state.viewMode === "split") {
    const max = previewEl.scrollHeight - previewEl.clientHeight;
    if (max > 0) ratio = previewEl.scrollTop / max;
  }
  previewEl.innerHTML = text.trim()
    ? renderMarkdown(text, baseDir)
    : '<div class="preview-empty">暂无内容，预览将显示在这里</div>';
  if (ratio > 0) {
    previewEl.scrollTop = ratio * (previewEl.scrollHeight - previewEl.clientHeight);
  }
}

export function schedulePreview() {
  if (state.viewMode === "edit") return;
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(renderPreview, 120);
}

export function afterEdit() {
  if (onEditChangeCallback) {
    onEditChangeCallback();
  }
  schedulePreview();
  scheduleCount();
}

export function setViewMode(mode: ViewMode) {
  state.viewMode = mode;
  editorBodyEl.className = `mode-${mode}`;
  for (const b of viewButtons) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
  localStorage.setItem("notebook:view", mode);
  if (mode !== "edit") renderPreview();
  if (mode !== "preview") editorEl.focus();
}

export function showEditor(title: string, content: string, pathHint = "") {
  editorEl.value = content;
  resetHistory();
  editorBodyEl.hidden = false;
  editorHeaderEl.hidden = false;
  toolbarEl.hidden = false;
  statusbarEl.hidden = false;
  editorEmptyEl.hidden = true;
  editorTitleEl.textContent = title;
  editorTitleEl.title = pathHint || title;
  renderPreview();
  updateCount();
  if (state.viewMode !== "preview") editorEl.focus();
}

export function closeEditor() {
  state.current = null;
  state.dirty = false;
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
}

export function updateMissingBadge(gone: boolean, isFile: boolean) {
  missingBadgeEl.hidden = !gone;
  if (gone) {
    setStatus(
      isFile
        ? "文件已被外部删除，继续输入会自动重新创建"
        : "笔记文件已被外部删除，继续输入会自动重新创建",
    );
  }
}

/* ---------- 选区包裹与插入动作 ---------- */

export function wrapSelection(before: string, after: string, placeholder: string) {
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
  if (!state.current) return;
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
  if (!picked) return;
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
  if (!state.current || editorEl.hidden) return;
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

export function initEditor(onEditChange: () => void) {
  onEditChangeCallback = onEditChange;

  editorEl.addEventListener("beforeinput", (e) => {
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
    if (!composing && pendingSnapshot) {
      pushUndo(pendingSnapshot);
      pendingSnapshot = null;
    }
    afterEdit();
  });

  editorEl.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      handleTabKey(e);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !composing) {
      if (handleEnterKey(e)) return;
    }
  });

  editorEl.addEventListener("paste", handlePasteUrl);
}
