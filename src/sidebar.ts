// 侧栏模块：笔记列表 / 外部文件列表 / 搜索 / 分页 / 多选 / 行内重命名 / 宽度与折叠。
// 渲染改为信号驱动：notes/openFiles/current/query/searchResults/listPage/missingPaths
// 等信号变化时经微任务合并触发一次 renderList（同一 tick 内多次状态更新只渲染一次）；
// 多选（selectedIds）只走轻量的 updateSelectionUI，不整表重建。

import { invoke } from "@tauri-apps/api/core";
import {
  current,
  listPage,
  listPageSize,
  missingPaths,
  notes,
  openFiles,
  query,
  rangeAnchorId,
  searchResults,
  selectedIds,
  sidebarHidden,
  sidebarWidth,
} from "./state";
import { coalesceByMicrotask } from "./signal";
import {
  fmtTime,
  pathKey,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./utils";
import { t } from "./i18n";
import type { NoteMeta, Source } from "./types";

/* ---------- DOM 元素获取 ---------- */
const sidebarEl = document.querySelector<HTMLElement>("#sidebar")!;
const resizerEl = document.querySelector<HTMLDivElement>("#sidebar-resizer")!;
const sidebarCollapseBtn = document.querySelector<HTMLButtonElement>("#sidebar-collapse")!;
const sidebarExpandBtn = document.querySelector<HTMLButtonElement>("#sidebar-expand")!;
const noteListEl = document.querySelector<HTMLUListElement>("#note-list")!;
const emptyHintEl = document.querySelector<HTMLDivElement>("#empty-hint")!;
const searchInputEl = document.querySelector<HTMLInputElement>("#search-input")!;
const paginationControls = document.querySelector<HTMLDivElement>("#pagination-controls")!;
const pagePrevBtn = document.querySelector<HTMLButtonElement>("#page-prev")!;
const pageNextBtn = document.querySelector<HTMLButtonElement>("#page-next")!;
const pageInfo = document.querySelector<HTMLSpanElement>("#page-info")!;
const pageSizeSelect = document.querySelector<HTMLSelectElement>("#page-size")!;
const batchBar = document.querySelector<HTMLDivElement>("#batch-bar")!;
const batchInfoEl = document.querySelector<HTMLSpanElement>("#batch-info")!;
const batchDeleteBtn = document.querySelector<HTMLButtonElement>("#batch-delete-btn")!;
const batchImportBtn = document.querySelector<HTMLButtonElement>("#batch-import-btn")!;
const batchExportBtn = document.querySelector<HTMLButtonElement>("#batch-export-btn")!;
const batchCancelBtn = document.querySelector<HTMLButtonElement>("#batch-cancel-btn")!;

let onSelectSourceCallback: ((src: Source) => Promise<unknown>) | null = null;
let onStatusCallback: ((msg: string) => void) | null = null;
let onContextMenuCallback: ((e: MouseEvent) => void) | null = null;
let onRenameSuccessCallback: ((id: string, updated: NoteMeta) => void) | null = null;
let onBatchDeleteCallback: ((ids: string[]) => Promise<void>) | null = null;
let onBatchImportCallback: ((ids: string[]) => Promise<void>) | null = null;
let onBatchExportCallback: ((ids: string[]) => Promise<void>) | null = null;
let searchGeneration = 0;

/* ---------- 侧栏宽度 / 折叠 ---------- */

export function applySidebarWidth(width: number) {
  const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  sidebarWidth.set(clamped);
}

export function setSidebarHidden(hidden: boolean) {
  sidebarHidden.set(hidden);
}

export function setResponsiveSidebarHidden(hidden: boolean) {
  document.body.classList.toggle("sidebar-auto-hidden", hidden);
}

export function initSidebarResizer() {
  applySidebarWidth(sidebarWidth.get());

  resizerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizerEl.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");

    const onMove = (ev: PointerEvent) => applySidebarWidth(ev.clientX);
    const onUp = () => {
      document.body.classList.remove("resizing");
      resizerEl.removeEventListener("pointermove", onMove);
      resizerEl.removeEventListener("pointerup", onUp);
      resizerEl.removeEventListener("pointercancel", onUp);
      localStorage.setItem("annal:sidebar-width", String(sidebarWidth.get()));
    };
    resizerEl.addEventListener("pointermove", onMove);
    resizerEl.addEventListener("pointerup", onUp);
    resizerEl.addEventListener("pointercancel", onUp);
  });

  resizerEl.addEventListener("dblclick", () => {
    applySidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    localStorage.setItem("annal:sidebar-width", String(SIDEBAR_DEFAULT_WIDTH));
  });
}

/* ---------- 列表渲染与行内重命名 ---------- */

function addGroupHeader(frag: DocumentFragment, i18nKey: string) {
  const li = document.createElement("li");
  li.className = "list-group-header";
  const span = document.createElement("span");
  span.textContent = t(i18nKey);
  li.appendChild(span);
  frag.appendChild(li);
}

/** 刷新列表项的“已删除”状态与时间列（renderList 重建后统一调用一次） */
function updateMissingUI() {
  for (const li of noteListEl.querySelectorAll<HTMLLIElement>(".note-item")) {
    const id = li.dataset.noteId;
    const fp = li.dataset.filePath;
    const p = id ? notes.get().find((n) => n.id === id)?.path : fp;
    const gone = !!p && missingPaths.get().has(pathKey(p));
    li.classList.toggle("missing", gone);
    const time = li.querySelector<HTMLDivElement>(".note-time");
    if (!time) continue;
    if (gone) {
      time.textContent = t("sidebar.deleted");
      time.title = t("editor.missing.deleted");
    } else if (fp) {
      time.textContent = fp;
      time.title = fp;
    } else {
      const n = id ? notes.get().find((n) => n.id === id) : undefined;
      time.textContent = n ? fmtTime(n.updatedAt) : "";
      time.title = "";
    }
  }
}

/* ---------- 多选逻辑 ---------- */

export function getItemKey(li: HTMLLIElement): string {
  if (li.dataset.noteId) return li.dataset.noteId;
  if (li.dataset.filePath) return li.dataset.filePath;
  return "";
}

export function isItemSelected(key: string): boolean {
  return selectedIds.get().includes(key);
}

export function toggleSelect(key: string) {
  const cur = selectedIds.get();
  const idx = cur.indexOf(key);
  selectedIds.set(idx >= 0 ? cur.filter((k) => k !== key) : [...cur, key]);
  // Ctrl/⌘ 点击同时更新范围锚点，便于随后 Shift+点击做范围选择
  rangeAnchorId.set(key);
}

export function selectRange(currentKey: string) {
  const visibleKeys: string[] = [];
  for (const li of noteListEl.querySelectorAll<HTMLLIElement>(".note-item")) {
    const k = getItemKey(li);
    if (k) visibleKeys.push(k);
  }
  const anchor = rangeAnchorId.get();
  if (!anchor || !visibleKeys.includes(anchor)) {
    rangeAnchorId.set(currentKey);
    selectedIds.set([currentKey]);
    return;
  }
  const start = visibleKeys.indexOf(anchor);
  const end = visibleKeys.indexOf(currentKey);
  if (start < 0 || end < 0) {
    rangeAnchorId.set(currentKey);
    selectedIds.set([currentKey]);
    return;
  }
  const [lo, hi] = start < end ? [start, end] : [end, start];
  selectedIds.set(visibleKeys.slice(lo, hi + 1));
}

export function clearSelection() {
  selectedIds.set([]);
  rangeAnchorId.set(null);
}

/** 轻量选择态更新：只切 class 与批量操作条，不重建列表 */
export function updateSelectionUI() {
  const ids = selectedIds.get();
  const count = ids.length;
  batchInfoEl.textContent = t("sidebar.batch.info", { count: String(count) });
  batchBar.hidden = count === 0;
  const hasNote = ids.some((id) => notes.get().some((n) => n.id === id));
  batchImportBtn.disabled = hasNote;
  for (const li of noteListEl.querySelectorAll<HTMLLIElement>(".note-item")) {
    const key = getItemKey(li);
    li.classList.toggle("selected", key ? isItemSelected(key) : false);
  }
}

/** 清理已不存在条目（被删笔记 / 已关闭文件）的选中项，并复位失效的锚点 */
function pruneSelection() {
  const valid = new Set<string>();
  for (const n of notes.get()) valid.add(n.id);
  for (const f of openFiles.get()) valid.add(f.path);
  const next = selectedIds.get().filter((k) => valid.has(k));
  const nextAnchor = rangeAnchorId.get();
  const anchorValid = nextAnchor !== null && valid.has(nextAnchor);
  if (next.length !== selectedIds.get().length || (nextAnchor !== null && !anchorValid)) {
    selectedIds.set(next);
    rangeAnchorId.set(anchorValid ? nextAnchor : null);
  }
}

export function renderPaginationControls(totalNotes: number) {
  const pageSize = listPageSize.get();
  const totalPages = Math.max(1, Math.ceil(totalNotes / pageSize));
  let currentPage = listPage.get();
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  if (currentPage !== listPage.get()) listPage.set(currentPage);

  paginationControls.hidden = totalPages <= 1;
  pageInfo.textContent = t("sidebar.page.info", { current: String(currentPage), total: String(totalPages) });
  pagePrevBtn.disabled = currentPage <= 1;
  pageNextBtn.disabled = currentPage >= totalPages;

  if (String(pageSize) !== pageSizeSelect.value) {
    pageSizeSelect.value = String(pageSize);
  }
}

export function renderList() {
  const scrollTop = noteListEl.scrollTop;
  noteListEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  const activeSource = current.get();

  const curQuery = query.get();
  const backendResults = searchResults.get();
  const displayNotes = backendResults ?? notes.get();
  const isSearching = curQuery.length > 0 && backendResults === null;
  // 后端结果包含标题与正文匹配；只有等待后端时才用标题做即时本地过滤。
  const filtered = backendResults !== null
    ? backendResults
    : curQuery
      ? displayNotes.filter((n) => n.title.toLowerCase().includes(curQuery))
      : displayNotes;
  const filesShown = curQuery
    ? openFiles.get().filter((f) => f.name.toLowerCase().includes(curQuery))
    : openFiles.get();

  emptyHintEl.hidden = filtered.length > 0 || filesShown.length > 0;
  const [hintMain, hintSub] = emptyHintEl.querySelectorAll("p");
  if (isSearching) {
    hintMain.textContent = t("sidebar.searching");
    hintSub.textContent = "";
  } else {
    hintMain.textContent = notes.get().length > 0 ? t("sidebar.noMatch") : t("sidebar.empty.title");
    hintSub.textContent =
      notes.get().length > 0
        ? ""
        : openFiles.get().length > 0
          ? t("sidebar.empty.sub")
          : t("sidebar.empty.subWithOpen");
  }

  if (filesShown.length > 0) {
    addGroupHeader(frag, "sidebar.group.externalFiles");
    for (const f of filesShown) {
      const li = document.createElement("li");
      li.className =
        "note-item" +
        (activeSource?.kind === "file" && activeSource.path === f.path ? " active" : "");
      li.dataset.filePath = f.path;

      const title = document.createElement("div");
      title.className = "note-title";
      title.textContent = f.name;
      title.title = f.path;

      const path = document.createElement("div");
      path.className = "note-time";
      path.textContent = f.path;
      path.title = f.path;

      li.append(title, path);
      frag.appendChild(li);
    }
  }

  if (filtered.length > 0) {
    const start = (listPage.get() - 1) * listPageSize.get();
    const pageNotes = filtered.slice(start, start + listPageSize.get());
    for (const n of pageNotes) {
      const li = document.createElement("li");
      li.className =
        "note-item" +
        (activeSource?.kind === "note" && n.id === activeSource.id ? " active" : "");
      li.dataset.noteId = n.id;

      const title = document.createElement("div");
      title.className = "note-title";
      if (n.pinned) {
        const pin = document.createElement("span");
        pin.className = "pin-icon";
        pin.textContent = "📌";
        pin.title = t("contextMenu.pin");
        title.appendChild(pin);
        title.appendChild(document.createTextNode(" "));
      }
      title.appendChild(document.createTextNode(n.title));

      const time = document.createElement("div");
      time.className = "note-time";
      time.textContent = fmtTime(n.updatedAt);

      li.append(title, time);
      frag.appendChild(li);
    }
  }
  noteListEl.appendChild(frag);
  noteListEl.scrollTop = scrollTop;
  pruneSelection();
  updateSelectionUI();
  updateMissingUI();
  renderPaginationControls(filtered.length);
}

/** 同一微任务批次内的多次状态变更合并为一次列表重建 */
const scheduleListRender = coalesceByMicrotask(renderList);

export function startRename(id: string) {
  const li = noteListEl.querySelector<HTMLLIElement>(
    `li[data-note-id="${CSS.escape(id)}"]`,
  );
  const titleEl = li?.querySelector<HTMLDivElement>(".note-title");
  const meta = notes.get().find((n) => n.id === id);
  if (!li || !titleEl || !meta) return;

  li.classList.add("renaming");
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = meta.title;
  input.maxLength = 60;
  input.spellcheck = false;

  let done = false;
  let cancelled = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (!commit || !value || value === meta.title) {
      renderList();
      return;
    }
    void (async () => {
      try {
        const updated = await invoke<NoteMeta>("rename_note", { id, title: value });
        const oldPath = meta.path;
        const next = notes.get();
        const i = next.findIndex((n) => n.id === id);
        if (i >= 0) {
          const list = [...next];
          list[i] = updated;
          notes.set(list);
        }
        if (oldPath) {
          const gone = new Set(missingPaths.get());
          if (gone.delete(pathKey(oldPath))) missingPaths.set(gone);
        }
        if (onRenameSuccessCallback) onRenameSuccessCallback(id, updated);
      } catch (err) {
        if (onStatusCallback) onStatusCallback(t("sidebar.renameFail", { error: String(err) }));
        renderList();
      }
    })();
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      cancelled = true;
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(!cancelled));
  input.addEventListener("click", (e) => e.stopPropagation());

  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

export interface SidebarActions {
  onSelect: (src: Source) => Promise<unknown>;
  onStatus: (msg: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onRenameSuccess?: (id: string, updated: NoteMeta) => void;
  onBatchDelete?: (ids: string[]) => Promise<void>;
  onBatchImport?: (ids: string[]) => Promise<void>;
  onBatchExport?: (ids: string[]) => Promise<void>;
}

export function initSidebar(actions: SidebarActions) {
  onSelectSourceCallback = actions.onSelect;
  onStatusCallback = actions.onStatus;
  onContextMenuCallback = actions.onContextMenu;
  if (actions.onRenameSuccess) onRenameSuccessCallback = actions.onRenameSuccess;
  if (actions.onBatchDelete) onBatchDeleteCallback = actions.onBatchDelete;
  if (actions.onBatchImport) onBatchImportCallback = actions.onBatchImport;
  if (actions.onBatchExport) onBatchExportCallback = actions.onBatchExport;

  initSidebarResizer();
  sidebarEl.style.width = `${sidebarWidth.get()}px`;
  document.body.classList.toggle("sidebar-hidden", sidebarHidden.get());
  if (!sidebarHidden.get()) document.body.classList.remove("sidebar-auto-hidden");

  // 状态信号 -> 列表渲染（微任务合并）；多选走轻量路径
  notes.subscribe(scheduleListRender);
  openFiles.subscribe(scheduleListRender);
  current.subscribe(scheduleListRender);
  query.subscribe(scheduleListRender);
  searchResults.subscribe(scheduleListRender);
  listPage.subscribe(scheduleListRender);
  listPageSize.subscribe(scheduleListRender);
  missingPaths.subscribe(scheduleListRender);
  selectedIds.subscribe(updateSelectionUI);

  // 宽度/折叠信号 -> DOM 与持久化
  sidebarWidth.subscribe((w) => {
    sidebarEl.style.width = `${w}px`;
  });
  sidebarHidden.subscribe((hidden) => {
    document.body.classList.toggle("sidebar-hidden", hidden);
    if (!hidden) document.body.classList.remove("sidebar-auto-hidden");
    localStorage.setItem("annal:sidebar", hidden ? "hidden" : "shown");
  });

  sidebarCollapseBtn.addEventListener("click", () => setSidebarHidden(!sidebarHidden.get()));
  sidebarExpandBtn.addEventListener("click", () => setSidebarHidden(false));

  searchInputEl.addEventListener("input", () => {
    query.set(searchInputEl.value.trim().toLowerCase());
    listPage.set(1);
    searchResults.set(null);
    // 防抖 300ms 调用后端全文搜索
    window.clearTimeout((searchInputEl as HTMLInputElement & { _timer?: number })._timer);
    const requestQuery = query.get();
    const generation = ++searchGeneration;
    (searchInputEl as HTMLInputElement & { _timer?: number })._timer = window.setTimeout(async () => {
      if (!requestQuery || requestQuery !== query.get()) return;
      try {
        const results = await invoke<NoteMeta[]>("search_notes", { query: requestQuery });
        if (generation === searchGeneration && requestQuery === query.get()) searchResults.set(results);
      } catch {
        if (generation === searchGeneration && requestQuery === query.get()) searchResults.set([]);
      }
    }, 300);
  });

  noteListEl.addEventListener("contextmenu", (e) => {
    if (onContextMenuCallback) onContextMenuCallback(e);
  });

  // 列表点击统一委托：条目选择/多选/打开 + 空白处清除选择（不再逐条挂监听器）
  noteListEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target === noteListEl) {
      clearSelection();
      return;
    }
    const li = target.closest<HTMLLIElement>(".note-item");
    if (!li || li.classList.contains("renaming")) return;
    const key = getItemKey(li);
    if (!key) return;
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(key);
    } else if (e.shiftKey && rangeAnchorId.get()) {
      selectRange(key);
    } else {
      clearSelection();
      if (li.dataset.noteId) {
        if (onSelectSourceCallback) void onSelectSourceCallback({ kind: "note", id: li.dataset.noteId });
      } else if (li.dataset.filePath) {
        if (onSelectSourceCallback) void onSelectSourceCallback({ kind: "file", path: li.dataset.filePath });
      }
    }
  });

  pagePrevBtn.addEventListener("click", () => {
    if (listPage.get() > 1) listPage.set(listPage.get() - 1);
  });

  pageNextBtn.addEventListener("click", () => {
    const curQuery = query.get();
    const backendResults = searchResults.get();
    const filtered = backendResults !== null
      ? backendResults
      : curQuery
        ? notes.get().filter((n) => n.title.toLowerCase().includes(curQuery))
        : notes.get();
    const totalPages = Math.max(1, Math.ceil(filtered.length / listPageSize.get()));
    if (listPage.get() < totalPages) listPage.set(listPage.get() + 1);
  });

  pageSizeSelect.addEventListener("change", () => {
    const next = Number(pageSizeSelect.value);
    if (!Number.isFinite(next) || next <= 0) return;
    localStorage.setItem("annal:list-page-size", String(next));
    listPageSize.set(next);
    listPage.set(1);
  });

  batchDeleteBtn.addEventListener("click", async () => {
    const ids = [...selectedIds.get()];
    if (ids.length === 0) return;
    if (onBatchDeleteCallback) await onBatchDeleteCallback(ids);
  });

  batchImportBtn.addEventListener("click", async () => {
    const ids = [...selectedIds.get()];
    if (ids.length === 0) return;
    if (onBatchImportCallback) await onBatchImportCallback(ids);
  });

  batchExportBtn.addEventListener("click", async () => {
    const ids = [...selectedIds.get()];
    if (ids.length === 0) return;
    if (onBatchExportCallback) await onBatchExportCallback(ids);
  });

  batchCancelBtn.addEventListener("click", () => {
    clearSelection();
  });

  renderList();
}
