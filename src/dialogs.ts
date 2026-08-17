import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import type { CtxItem, NoteVersion } from "./types";

/* ---------- DOM 元素获取 ---------- */
const contextMenuEl = document.querySelector<HTMLDivElement>("#context-menu")!;
const confirmOverlayEl = document.querySelector<HTMLDivElement>("#confirm-overlay")!;
const confirmTitleEl = document.querySelector<HTMLParagraphElement>("#confirm-title")!;
const confirmTextEl = document.querySelector<HTMLParagraphElement>("#confirm-text")!;
const confirmOkBtn = document.querySelector<HTMLButtonElement>("#confirm-ok")!;
const confirmCancelBtn = document.querySelector<HTMLButtonElement>("#confirm-cancel")!;

const commitOverlayEl = document.querySelector<HTMLDivElement>("#commit-overlay")!;
const commitTextEl = document.querySelector<HTMLParagraphElement>("#commit-text")!;
const commitInputEl = document.querySelector<HTMLInputElement>("#commit-input")!;
const commitOkBtn = document.querySelector<HTMLButtonElement>("#commit-ok")!;
const commitCancelBtn = document.querySelector<HTMLButtonElement>("#commit-cancel")!;

/* ---------- 确认弹层 ---------- */
let confirmAction: (() => void | Promise<void>) | null = null;

export function openConfirm(opts: {
  title: string;
  text: string;
  okLabel?: string;
  danger?: boolean;
  action: () => void | Promise<void>;
}) {
  confirmTitleEl.textContent = opts.title;
  confirmTextEl.textContent = opts.text;
  confirmOkBtn.textContent = opts.okLabel ?? "确定";
  confirmOkBtn.classList.toggle("btn-danger", opts.danger !== false);
  confirmOkBtn.classList.toggle("btn-primary", opts.danger === false);
  confirmAction = opts.action;
  confirmOverlayEl.hidden = false;
}

export function closeConfirm() {
  confirmOverlayEl.hidden = true;
  confirmAction = null;
}

export async function runConfirmAction() {
  const action = confirmAction;
  closeConfirm();
  if (!action) return;
  await action();
}

/* ---------- 提交版本弹层 ---------- */
let commitNoteId: string | null = null;
let onCommitSuccess: ((msg: string) => void) | null = null;

export async function requestCommit(
  id?: string,
  flushSaveFn?: () => Promise<void>,
  statusCallback?: (msg: string) => void,
) {
  const noteId = id ?? (state.current?.kind === "note" ? state.current.id : null);
  if (!noteId) return;
  if (flushSaveFn) {
    try {
      await flushSaveFn();
    } catch {
      // 保持异常不阻断
    }
  }
  if (statusCallback) {
    onCommitSuccess = statusCallback;
  }
  commitNoteId = noteId;
  const meta = state.notes.find((n) => n.id === noteId);
  commitTextEl.textContent = `将把「${meta?.title ?? "笔记"}」的当前内容记录为一个新版本`;
  commitInputEl.value = "";
  commitOverlayEl.hidden = false;
  commitInputEl.focus();
}

export async function doCommit() {
  const id = commitNoteId;
  if (!id) return;
  commitOverlayEl.hidden = true;
  commitNoteId = null;
  const message = commitInputEl.value.trim();
  try {
    const v = await invoke<NoteVersion | null>("commit_note", { id, message });
    if (onCommitSuccess) {
      if (v) {
        onCommitSuccess(`已提交版本 #${v.seq}${v.message ? `：${v.message}` : ""}`);
      } else {
        onCommitSuccess("内容与最新版本相同，没有生成新版本");
      }
    }
  } catch (err) {
    if (onCommitSuccess) onCommitSuccess(`提交失败: ${err}`);
  }
}

export function closeCommit() {
  commitOverlayEl.hidden = true;
  commitNoteId = null;
}

/* ---------- 右键菜单 ---------- */
export function hideContextMenu() {
  contextMenuEl.hidden = true;
}

export function showContextMenu(x: number, y: number, items: CtxItem[]) {
  contextMenuEl.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "ctx-item" + (item.danger ? " danger" : "");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      hideContextMenu();
      item.action();
    });
    contextMenuEl.appendChild(btn);
  }
  contextMenuEl.hidden = false;
  const w = contextMenuEl.offsetWidth;
  const h = contextMenuEl.offsetHeight;
  contextMenuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 8))}px`;
  contextMenuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 8))}px`;
}

export function isAnyDialogOpen(): boolean {
  return !confirmOverlayEl.hidden || !commitOverlayEl.hidden || !contextMenuEl.hidden;
}

export function handleDialogEscape(): boolean {
  if (!confirmOverlayEl.hidden) {
    closeConfirm();
    return true;
  }
  if (!commitOverlayEl.hidden) {
    closeCommit();
    return true;
  }
  if (!contextMenuEl.hidden) {
    hideContextMenu();
    return true;
  }
  return false;
}

export function initDialogs() {
  confirmOkBtn.addEventListener("click", () => void runConfirmAction());
  confirmCancelBtn.addEventListener("click", closeConfirm);
  confirmOverlayEl.addEventListener("click", (e) => {
    if (e.target === confirmOverlayEl) closeConfirm();
  });

  commitOkBtn.addEventListener("click", () => void doCommit());
  commitCancelBtn.addEventListener("click", closeCommit);
  commitOverlayEl.addEventListener("click", (e) => {
    if (e.target === commitOverlayEl) closeCommit();
  });
  commitInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void doCommit();
    }
  });

  window.addEventListener(
    "mousedown",
    (e) => {
      if (!contextMenuEl.hidden && !contextMenuEl.contains(e.target as Node)) {
        hideContextMenu();
      }
    },
    true,
  );
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", hideContextMenu);
  window.addEventListener("scroll", hideContextMenu, true);
}
