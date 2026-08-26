import { invoke } from "@tauri-apps/api/core";
import { current, notes } from "./state";
import { parseViewMode } from "./types";
import { getAvailableLocales, t } from "./i18n";
import type { CtxItem, NoteVersion } from "./types";

/* ---------- 反馈链接（替换为实际仓库 issues 地址） ---------- */
const FEEDBACK_URL = "https://github.com";

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

const settingsOverlayEl = document.querySelector<HTMLDivElement>("#settings-overlay")!;
const settingThemeEl = document.querySelector<HTMLSelectElement>("#setting-theme")!;
const settingViewEl = document.querySelector<HTMLSelectElement>("#setting-view")!;
const settingContentDensityEl = document.querySelector<HTMLSelectElement>("#setting-content-density")!;
const settingFontSizeEl = document.querySelector<HTMLSelectElement>("#setting-font-size")!;
const settingFontFamilyEl = document.querySelector<HTMLSelectElement>("#setting-font-family")!;
const settingAutosaveEl = document.querySelector<HTMLInputElement>("#setting-autosave")!;
const settingAutosaveDelayEl = document.querySelector<HTMLSelectElement>("#setting-autosave-delay")!;
const settingSidebarWidthEl = document.querySelector<HTMLSelectElement>("#setting-sidebar-width")!;
const settingLineNumbersEl = document.querySelector<HTMLInputElement>("#setting-line-numbers")!;
const settingLanguageEl = document.querySelector<HTMLSelectElement>("#setting-language")!;
const feedbackBtnEl = document.querySelector<HTMLButtonElement>("#feedback-btn")!;
const settingsVersionEl = document.querySelector<HTMLSpanElement>("#settings-version")!;
const settingsSidebarEl = document.querySelector<HTMLElement>("#settings-sidebar")!;
const settingsContentEl = document.querySelector<HTMLElement>(".settings-content")!;
const settingsNavItems = settingsSidebarEl.querySelectorAll<HTMLButtonElement>(".settings-nav-item");
const settingsSections = settingsContentEl.querySelectorAll<HTMLElement>(".settings-section");

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
  confirmOkBtn.textContent = opts.okLabel ?? t("confirm.okDefault");
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
  flushSaveFn?: () => Promise<boolean>,
  statusCallback?: (msg: string) => void,
) {
  const cur = current.get();
  const noteId = id ?? (cur?.kind === "note" ? cur.id : null);
  if (!noteId) return;
  if (flushSaveFn && !(await flushSaveFn())) return;
  if (statusCallback) {
    onCommitSuccess = statusCallback;
  }
  commitNoteId = noteId;
  const meta = notes.get().find((n) => n.id === noteId);
  commitTextEl.textContent = t("commit.confirmText", { title: meta?.title ?? t("history.title.default") });
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
        onCommitSuccess(t("commit.success", { seq: v.seq, message: v.message ? `：${v.message}` : "" }));
      } else {
        onCommitSuccess(t("commit.unchanged"));
      }
    }
  } catch (err) {
    if (onCommitSuccess) onCommitSuccess(t("commit.fail", { error: String(err) }));
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
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-separator";
      contextMenuEl.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "ctx-item" + (item.danger ? " danger" : "");
    if (item.label) btn.textContent = item.label;
    if (item.shortcut) {
      const kbd = document.createElement("kbd");
      kbd.className = "ctx-shortcut";
      kbd.textContent = item.shortcut;
      btn.appendChild(kbd);
    }
    const action = item.action;
    if (action) {
      btn.addEventListener("click", () => {
        hideContextMenu();
        action();
      });
    }
    contextMenuEl.appendChild(btn);
  }
  contextMenuEl.hidden = false;
  const w = contextMenuEl.offsetWidth;
  const h = contextMenuEl.offsetHeight;
  contextMenuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 8))}px`;
  contextMenuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 8))}px`;
}

export function isAnyDialogOpen(): boolean {
  return (
    !confirmOverlayEl.hidden ||
    !commitOverlayEl.hidden ||
    !contextMenuEl.hidden ||
    !settingsOverlayEl.hidden
  );
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
  if (!settingsOverlayEl.hidden) {
    closeSettings();
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

  feedbackBtnEl.addEventListener("click", async () => {
    try {
      await invoke("open_external", { url: FEEDBACK_URL });
    } catch (err) {
      console.error("Failed to open feedback URL:", err);
    }
  });
}

/* ---------- 设置弹层 ---------- */
export function openSettings() {
  syncSettingsUI();
  settingsOverlayEl.hidden = false;
}

export function closeSettings() {
  settingsOverlayEl.hidden = true;
}

export function isSettingsOpen(): boolean {
  return !settingsOverlayEl.hidden;
}

export function getSettingsElements() {
  return {
    overlay: settingsOverlayEl,
    theme: settingThemeEl,
    view: settingViewEl,
    contentDensity: settingContentDensityEl,
    fontSize: settingFontSizeEl,
    fontFamily: settingFontFamilyEl,
    autosave: settingAutosaveEl,
    autosaveDelay: settingAutosaveDelayEl,
    sidebarWidth: settingSidebarWidthEl,
    lineNumbers: settingLineNumbersEl,
    language: settingLanguageEl,
  };
}

export function switchSettingsCategory(category: string) {
  // 若记忆的分类已不存在（如旧版独立的“语言”子项），回退到外观
  const target = [...settingsSections].some((s) => s.dataset.section === category)
    ? category
    : "appearance";
  for (const item of settingsNavItems) {
    const active = item.dataset.category === target;
    item.classList.toggle("active", active);
    item.setAttribute("aria-current", active ? "true" : "false");
  }
  for (const section of settingsSections) {
    section.hidden = section.dataset.section !== target;
  }
}

export function getActiveSettingsCategory(): string {
  const active = settingsSidebarEl.querySelector<HTMLButtonElement>(".settings-nav-item[aria-current='true']");
  return active?.dataset.category ?? "appearance";
}

export function syncSettingsUI() {
  const els = getSettingsElements();
  els.theme.value = localStorage.getItem("notebook:theme-mode") || "system";
  els.view.value = parseViewMode(localStorage.getItem("notebook:view"));
  const savedDensity = localStorage.getItem("notebook:content-density");
  els.contentDensity.value = savedDensity === "sparse" || savedDensity === "compact" ? savedDensity : "standard";
  els.fontSize.value = localStorage.getItem("notebook:font-size") || "15.5";
  els.fontFamily.value = localStorage.getItem("notebook:font-family") || "serif";
  els.autosave.checked = localStorage.getItem("notebook:autosave") !== "0";
  els.autosaveDelay.value = localStorage.getItem("notebook:autosave-delay") || "500";
  els.sidebarWidth.value = localStorage.getItem("notebook:sidebar-width") || "260";
  els.lineNumbers.checked = localStorage.getItem("notebook:line-numbers") !== "0";

  const savedCategory = localStorage.getItem("notebook:settings-category") || "appearance";
  switchSettingsCategory(savedCategory);

  const currentLocale = localStorage.getItem("notebook:locale") || "zh-CN";
  els.language.innerHTML = "";
  for (const locale of getAvailableLocales()) {
    const opt = document.createElement("option");
    opt.value = locale.value;
    opt.textContent = locale.label;
    if (locale.value === currentLocale) opt.selected = true;
    els.language.appendChild(opt);
  }

  // 填充版本号（与 tauri.conf.json / Cargo.toml 保持一致）
  if (settingsVersionEl) {
    settingsVersionEl.textContent = "v0.2.0";
  }

  return els;
}
