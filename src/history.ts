import { invoke } from "@tauri-apps/api/core";
import { openConfirm } from "./dialogs";
import { renderMarkdownWhole } from "./markdownModel";
import { dirOfPath, fmtRelative, fmtSize, fmtTime } from "./utils";
import { current, notes } from "./state";
import { t } from "./i18n";
import type { NoteMeta, NoteVersion } from "./types";

/* ---------- DOM 元素获取 ---------- */
const historyOverlayEl = document.querySelector<HTMLDivElement>("#history-overlay")!;
const historyTitleEl = document.querySelector<HTMLParagraphElement>("#history-title")!;
const historySubEl = document.querySelector<HTMLParagraphElement>("#history-sub")!;
const historyCloseBtn = document.querySelector<HTMLButtonElement>("#history-close")!;
const historyListEl = document.querySelector<HTMLUListElement>("#history-list")!;
const historyViewMetaEl = document.querySelector<HTMLDivElement>("#history-view-meta")!;
const historyViewContentEl = document.querySelector<HTMLDivElement>("#history-view-content")!;
const historyRestoreBtn = document.querySelector<HTMLButtonElement>("#history-restore-btn")!;
const historyCompareBtn = document.querySelector<HTMLButtonElement>("#history-compare-btn")!;
const historyCompareBarEl = document.querySelector<HTMLDivElement>("#history-compare-bar")!;
const historyCompareSrcSel = document.querySelector<HTMLSelectElement>("#history-compare-src")!;

/* ---------- 内部状态 ---------- */
let historyNoteId: string | null = null;
let historyVersions: NoteVersion[] = [];
let historySelectedSeq = 0;
let historyCompareOn = false;
let historyCompareSrc = 0;

let onRestoredCallback: ((restored: NoteMeta, isCurrent: boolean) => void) | null = null;
let onStatusCallback: ((msg: string) => void) | null = null;

function compareSourceLabel(seq: number): string {
  return seq === 0 ? t("history.latest") : t("history.versionLabel", { seq });
}

/** 逐行差异渲染进预览区（+ 为选中版本新增，− 为仅存在于对比源） */
async function renderVersionDiffInto(source: string, target: string) {
  const { diffLines } = await import("diff");
  const parts = diffLines(source, target);
  if (parts.length === 1 && !parts[0].added && !parts[0].removed) {
    historyViewContentEl.innerHTML =
      `<div class="history-empty">${t("history.diffEmpty")}</div>`;
    return;
  }
  const view = document.createElement("div");
  view.className = "diff-view";
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const row = document.createElement("div");
      row.className =
        "diff-line" + (part.added ? " diff-add" : part.removed ? " diff-del" : "");
      const mark = document.createElement("span");
      mark.className = "diff-mark";
      mark.textContent = part.added ? "+" : part.removed ? "−" : "";
      row.append(mark, document.createTextNode(line === "" ? " " : line));
      view.appendChild(row);
    }
  }
  historyViewContentEl.innerHTML = "";
  historyViewContentEl.appendChild(view);
}

async function renderVersionDiff(id: string, seq: number, selected: string) {
  const srcSeq = historyCompareSrc === 0 ? historyVersions[0]?.seq ?? 0 : historyCompareSrc;
  if (!srcSeq) return;
  historyViewContentEl.innerHTML = `<div class="history-empty">${t("history.loading")}</div>`;
  try {
    const source = await invoke<string>("get_note_version", { id, seq: srcSeq });
    if (historyNoteId !== id || historySelectedSeq !== seq || !historyCompareOn) return;
    const srcLabel = compareSourceLabel(historyCompareSrc);
    const v = historyVersions.find((x) => x.seq === seq);
    historyViewMetaEl.textContent = t("history.compareMeta", { from: srcLabel, seq: String(seq), time: v ? fmtTime(v.ts) : "" });
    await renderVersionDiffInto(source, selected);
  } catch (err) {
    if (historyNoteId !== id || historySelectedSeq !== seq || !historyCompareOn) return;
    historyViewContentEl.innerHTML = `<div class="history-empty">${t("history.compareFail", { error: String(err) })}</div>`;
  }
}

export async function selectHistoryVersion(seq: number) {
  if (!historyNoteId) return;
  historySelectedSeq = seq;
  for (const li of historyListEl.querySelectorAll<HTMLLIElement>(".history-item")) {
    li.classList.toggle("active", li.dataset.seq === String(seq));
  }
  const v = historyVersions.find((x) => x.seq === seq);
  const id = historyNoteId;
  historyViewMetaEl.textContent = "";
  historyViewContentEl.innerHTML = `<div class="history-empty">${t("history.loading")}</div>`;
  try {
    const content = await invoke<string>("get_note_version", { id, seq });
    if (historyNoteId !== id || historySelectedSeq !== seq) return;
    const isLatest = seq === historyVersions[0]?.seq;
    historyViewMetaEl.textContent = `${t("history.versionLabel", { seq })}${v ? ` · ${fmtTime(v.ts)} · ${fmtSize(v.size)}` : ""}${v?.title ? ` · ${t("history.titleAtVersion", { title: v.title })}` : ""}${
      v?.message ? ` · “${v.message}”` : ""
    }${isLatest ? ` · ${t("history.latestBadge")}` : ""}`;
    historyRestoreBtn.hidden = isLatest;
    historyCompareBtn.hidden = false;
    if (historyCompareOn) {
      await renderVersionDiff(id, seq, content);
    } else {
      const baseDir = dirOfPath(notes.get().find((n) => n.id === id)?.path ?? "");
      historyViewContentEl.innerHTML = content.trim()
        ? renderMarkdownWhole(content, baseDir)
        : `<div class="history-empty">${t("history.empty")}</div>`;
    }
  } catch (err) {
    if (historyNoteId !== id || historySelectedSeq !== seq) return;
    historyViewMetaEl.textContent = "";
    historyViewContentEl.innerHTML = `<div class="history-empty">${t("history.readFail", { error: String(err) })}</div>`;
    historyRestoreBtn.hidden = true;
    historyCompareBtn.hidden = true;
  }
}

function rebuildCompareSrcOptions() {
  historyCompareSrcSel.innerHTML = "";
  const latest = historyVersions[0];
  if (!latest) return;
  const optLatest = document.createElement("option");
  optLatest.value = "0";
  optLatest.textContent = t("history.latest");
  historyCompareSrcSel.appendChild(optLatest);
  for (const v of historyVersions) {
    const opt = document.createElement("option");
    opt.value = String(v.seq);
    opt.textContent = t("history.versionLabel", { seq: v.seq });
    historyCompareSrcSel.appendChild(opt);
  }
  historyCompareSrcSel.value = "0";
  historyCompareSrc = 0;
}

export async function toggleCompare() {
  if (!historyNoteId) return;
  historyCompareOn = !historyCompareOn;
  historyCompareBarEl.hidden = !historyCompareOn;
  historyCompareBtn.textContent = historyCompareOn ? t("history.exitCompare") : t("history.compare");
  historyCompareBtn.classList.toggle("active", historyCompareOn);
  if (historyCompareOn) rebuildCompareSrcOptions();
  await selectHistoryVersion(historySelectedSeq);
}

function renderHistoryList() {
  historyListEl.innerHTML = "";
  for (const v of historyVersions) {
    const li = document.createElement("li");
    li.className = "history-item" + (v.seq === historySelectedSeq ? " active" : "");
    li.dataset.seq = String(v.seq);

    const top = document.createElement("div");
    top.className = "hi-top";
    const seq = document.createElement("span");
    seq.className = "hi-seq";
    seq.textContent = `#${v.seq}`;
    top.appendChild(seq);
    if (v.seq === historyVersions[0].seq) {
      const badge = document.createElement("span");
      badge.className = "hi-badge";
      badge.textContent = t("history.latestBadge");
      top.appendChild(badge);
    }

    const time = document.createElement("div");
    time.className = "hi-time";
    time.textContent = fmtTime(v.ts);

    const metaLine = document.createElement("div");
    metaLine.className = "hi-meta";
    const rel = fmtRelative(v.ts);
    metaLine.textContent = rel ? `${fmtSize(v.size)} · ${rel}` : fmtSize(v.size);

    li.append(top, time, metaLine);
    // 该版本对应的笔记名（改名入版本控制后可见）
    if (v.title) {
      const name = document.createElement("div");
      name.className = "hi-title";
      name.textContent = t("history.titleAtVersion", { title: v.title });
      name.title = t("history.titleAtVersion");
      li.appendChild(name);
    }
    if (v.message) {
      const msg = document.createElement("div");
      msg.className = "hi-msg";
      msg.textContent = v.message;
      msg.title = v.message;
      li.appendChild(msg);
    }
    li.addEventListener("click", () => void selectHistoryVersion(v.seq));
    historyListEl.appendChild(li);
  }
  historySubEl.textContent = t("history.versionsCount", { count: historyVersions.length });
}

export async function openHistory(id: string, flushSaveFn?: () => Promise<boolean>) {
  if (flushSaveFn && !(await flushSaveFn())) return;
  historyNoteId = id;
  historyVersions = [];
  historySelectedSeq = 0;
  const meta = notes.get().find((n) => n.id === id);
  historyTitleEl.textContent = meta?.title ?? t("history.title.default");
  historyTitleEl.title = meta?.path ?? "";
  historySubEl.textContent = "";
  historyListEl.innerHTML = `<li class="history-loading">${t("history.loading")}</li>`;
  historyViewMetaEl.textContent = "";
  historyViewContentEl.innerHTML = "";
  historyRestoreBtn.hidden = true;
  historyCompareBtn.hidden = true;
  historyCompareBtn.textContent = t("history.compare");
  historyCompareBtn.classList.remove("active");
  historyCompareBarEl.hidden = true;
  historyCompareOn = false;
  historyCompareSrc = 0;
  historyOverlayEl.hidden = false;

  try {
    historyVersions = await invoke<NoteVersion[]>("list_note_versions", { id });
    if (historyNoteId !== id) return;
    renderHistoryList();
    if (historyVersions.length > 0) {
      await selectHistoryVersion(historyVersions[0].seq);
    } else {
      historyViewContentEl.innerHTML =
        `<div class="history-empty">${t("history.emptyHistory")}</div>`;
    }
  } catch (err) {
    if (historyNoteId !== id) return;
    historyListEl.innerHTML = "";
    historySubEl.textContent = "";
    historyViewContentEl.innerHTML = "";
    if (onStatusCallback) onStatusCallback(t("history.loadFail", { error: String(err) }));
  }
}

export function closeHistory() {
  historyOverlayEl.hidden = true;
  historyRestoreBtn.hidden = true;
  historyCompareBtn.hidden = true;
  historyCompareBtn.textContent = t("history.compare");
  historyCompareBtn.classList.remove("active");
  historyCompareBarEl.hidden = true;
  historyCompareOn = false;
  historyCompareSrc = 0;
  historyNoteId = null;
  historyVersions = [];
  historySelectedSeq = 0;
}

export function isHistoryOpen(): boolean {
  return !historyOverlayEl.hidden;
}

export function isHistoryCompareOn(): boolean {
  return historyCompareOn;
}

export async function restoreSelectedVersion() {
  const id = historyNoteId;
  const seq = historySelectedSeq;
  if (!id || !seq) return;
  const meta = notes.get().find((n) => n.id === id);
  const version = historyVersions.find((v) => v.seq === seq);
  const nameNote = version?.title
    ? t("history.restoreNameNote", { title: version.title })
    : "";
  openConfirm({
    title: t("history.restoreTitle", { seq }),
    text: t("history.restoreText", { title: meta?.title ?? t("history.title.default"), nameNote }),
    okLabel: t("history.restoreOk"),
    danger: true,
    action: async () => {
      try {
        const restored = await invoke<NoteMeta>("restore_note_version", { id, seq });
        closeHistory();
        const cur = current.get();
        const isCurrent = cur?.kind === "note" && cur.id === id;
        if (onRestoredCallback) {
          onRestoredCallback(restored, isCurrent);
        }
      } catch (err) {
        if (onStatusCallback) onStatusCallback(t("history.restoreFail", { error: String(err) }));
      }
    },
  });
}

function toExternalUrl(href: string): string | null {
  const h = href.trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) {
    try {
      const url = new URL(h);
      return url.host ? url.href : null;
    } catch {
      return null;
    }
  }
  if (/^(?:\w+\.)+\w+(?::\d+)?(?:\/\S*)?$/.test(h)) return `https://${h}`;
  return null;
}

export function initHistory(
  onRestored: (restored: NoteMeta, isCurrent: boolean) => void,
  onStatus: (msg: string) => void,
) {
  onRestoredCallback = onRestored;
  onStatusCallback = onStatus;

  historyCloseBtn.addEventListener("click", closeHistory);
  historyRestoreBtn.addEventListener("click", () => void restoreSelectedVersion());
  historyCompareBtn.addEventListener("click", () => void toggleCompare());
  historyCompareSrcSel.addEventListener("change", () => {
    historyCompareSrc = Number(historyCompareSrcSel.value) || 0;
    void selectHistoryVersion(historySelectedSeq);
  });
  historyOverlayEl.addEventListener("click", (e) => {
    if (e.target === historyOverlayEl) closeHistory();
  });
  historyViewContentEl.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const url = toExternalUrl(a.getAttribute("href") ?? "");
    if (url) {
      invoke("open_external", { url }).catch((err) => onStatus(t("history.openLinkFail", { error: String(err) })));
    }
  });
}
