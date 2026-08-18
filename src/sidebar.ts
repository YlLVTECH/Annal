import { invoke } from "@tauri-apps/api/core";
import {
  fmtTime,
  pathKey,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  state,
} from "./state";
import type { NoteMeta, Source } from "./types";

/* ---------- DOM 元素获取 ---------- */
const sidebarEl = document.querySelector<HTMLElement>("#sidebar")!;
const resizerEl = document.querySelector<HTMLDivElement>("#sidebar-resizer")!;
const sidebarCollapseBtn = document.querySelector<HTMLButtonElement>("#sidebar-collapse")!;
const sidebarExpandBtn = document.querySelector<HTMLButtonElement>("#sidebar-expand")!;
const noteListEl = document.querySelector<HTMLUListElement>("#note-list")!;
const emptyHintEl = document.querySelector<HTMLDivElement>("#empty-hint")!;
const searchInputEl = document.querySelector<HTMLInputElement>("#search-input")!;
const editorTitleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
const paginationControls = document.querySelector<HTMLDivElement>("#pagination-controls")!;
const pagePrevBtn = document.querySelector<HTMLButtonElement>("#page-prev")!;
const pageNextBtn = document.querySelector<HTMLButtonElement>("#page-next")!;
const pageInfo = document.querySelector<HTMLSpanElement>("#page-info")!;
const pageSizeSelect = document.querySelector<HTMLSelectElement>("#page-size")!;
const batchBar = document.querySelector<HTMLDivElement>("#batch-bar")!;
const batchCount = document.querySelector<HTMLSpanElement>("#batch-count")!;
const batchDeleteBtn = document.querySelector<HTMLButtonElement>("#batch-delete-btn")!;
const batchExportBtn = document.querySelector<HTMLButtonElement>("#batch-export-btn")!;
const batchCancelBtn = document.querySelector<HTMLButtonElement>("#batch-cancel-btn")!;

let onSelectSourceCallback: ((src: Source) => Promise<void>) | null = null;
let onRenameSuccessCallback: ((id: string, updated: NoteMeta) => void) | null = null;
let onStatusCallback: ((msg: string) => void) | null = null;
let onContextMenuCallback: ((e: MouseEvent) => void) | null = null;
let onBatchDeleteCallback: ((ids: string[]) => Promise<void>) | null = null;
let onBatchExportCallback: ((ids: string[]) => Promise<void>) | null = null;

/* ---------- 侧栏宽度 / 折叠 ---------- */

export function applySidebarWidth(width: number) {
  state.sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  sidebarEl.style.width = `${state.sidebarWidth}px`;
}

export function setSidebarHidden(hidden: boolean) {
  state.sidebarHidden = hidden;
  document.body.classList.toggle("sidebar-hidden", hidden);
  if (!hidden) document.body.classList.remove("sidebar-auto-hidden");
  localStorage.setItem("notebook:sidebar", hidden ? "hidden" : "shown");
}

export function setResponsiveSidebarHidden(hidden: boolean) {
  document.body.classList.toggle("sidebar-auto-hidden", hidden);
}

export function initSidebarResizer() {
  applySidebarWidth(state.sidebarWidth);

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
      localStorage.setItem("notebook:sidebar-width", String(state.sidebarWidth));
    };
    resizerEl.addEventListener("pointermove", onMove);
    resizerEl.addEventListener("pointerup", onUp);
    resizerEl.addEventListener("pointercancel", onUp);
  });

  resizerEl.addEventListener("dblclick", () => {
    applySidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    localStorage.setItem("notebook:sidebar-width", String(SIDEBAR_DEFAULT_WIDTH));
  });
}

/* ---------- 列表渲染与行内重命名 ---------- */

function addGroupHeader(frag: DocumentFragment, text: string) {
  const li = document.createElement("li");
  li.className = "list-group-header";
  const span = document.createElement("span");
  span.textContent = text;
  li.appendChild(span);
  frag.appendChild(li);
}

export function updateMissingUI(updateBadgeFn?: (gone: boolean, isFile: boolean) => void) {
  for (const li of noteListEl.querySelectorAll<HTMLLIElement>(".note-item")) {
    const id = li.dataset.noteId;
    const fp = li.dataset.filePath;
    const p = id ? state.notes.find((n) => n.id === id)?.path : fp;
    const gone = !!p && state.missingPaths.has(pathKey(p));
    li.classList.toggle("missing", gone);
    const time = li.querySelector<HTMLDivElement>(".note-time");
    if (!time) continue;
    if (gone) {
      time.textContent = "已从磁盘删除";
      time.title = "文件已被外部删除，继续输入会自动重新创建";
    } else if (fp) {
      time.textContent = fp;
      time.title = fp;
    } else {
      const n = id ? state.notes.find((n) => n.id === id) : undefined;
      time.textContent = n ? fmtTime(n.updatedAt) : "";
      time.title = "";
    }
  }

  if (updateBadgeFn) {
    if (!state.current) {
      updateBadgeFn(false, false);
      return;
    }
    const currentPath =
      state.current.kind === "note"
        ? state.notes.find((n) => n.id === (state.current as { id: string }).id)?.path ?? ""
        : state.current.path;
    const gone = state.missingPaths.has(pathKey(currentPath));
    updateBadgeFn(gone, state.current.kind === "file");
  }
}

/* ---------- 多选逻辑 ---------- */

export function getItemKey(li: HTMLLIElement): string {
  if (li.dataset.noteId) return li.dataset.noteId;
  if (li.dataset.filePath) return li.dataset.filePath;
  return "";
}

export function isItemSelected(key: string): boolean {
  return state.selectedIds.includes(key);
}

export function toggleSelect(key: string) {
  const idx = state.selectedIds.indexOf(key);
  if (idx >= 0) {
    state.selectedIds.splice(idx, 1);
  } else {
    state.selectedIds.push(key);
  }
  // Ctrl/⌘ 点击同时更新范围锚点，便于随后 Shift+点击做范围选择
  state.rangeAnchorId = key;
  updateSelectionUI();
}

export function selectRange(currentKey: string) {
  const visibleKeys: string[] = [];
  for (const li of noteListEl.querySelectorAll<HTMLLIElement>(".note-item")) {
    const k = getItemKey(li);
    if (k) visibleKeys.push(k);
  }
  if (!state.rangeAnchorId || !visibleKeys.includes(state.rangeAnchorId)) {
    state.rangeAnchorId = currentKey;
    state.selectedIds = [currentKey];
    updateSelectionUI();
    return;
  }
  const start = visibleKeys.indexOf(state.rangeAnchorId);
  const end = visibleKeys.indexOf(currentKey);
  if (start < 0 || end < 0) {
    state.rangeAnchorId = currentKey;
    state.selectedIds = [currentKey];
    updateSelectionUI();
    return;
  }
  const [lo, hi] = start < end ? [start, end] : [end, start];
  const range = visibleKeys.slice(lo, hi + 1);
  state.selectedIds = range;
  updateSelectionUI();
}

export function clearSelection() {
  state.selectedIds = [];
  state.rangeAnchorId = null;
  updateSelectionUI();
}

export function updateSelectionUI() {
  const count = state.selectedIds.length;
  batchCount.textContent = String(count);
  batchBar.hidden = count === 0;
  for (const li of noteListEl.querySelectorAll<HTMLLIElement>(".note-item")) {
    const key = getItemKey(li);
    li.classList.toggle("selected", key ? isItemSelected(key) : false);
  }
}

/** 清理已不存在条目（被删笔记 / 已关闭文件）的选中项，并复位失效的锚点 */
function pruneSelection() {
  const valid = new Set<string>();
  for (const n of state.notes) valid.add(n.id);
  for (const f of state.openFiles) valid.add(f.path);
  state.selectedIds = state.selectedIds.filter((k) => valid.has(k));
  if (state.rangeAnchorId && !valid.has(state.rangeAnchorId)) state.rangeAnchorId = null;
}

export function renderPaginationControls(totalNotes: number) {
  const pageSize = state.listPageSize;
  const totalPages = Math.max(1, Math.ceil(totalNotes / pageSize));
  let currentPage = state.listPage;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  state.listPage = currentPage;

  paginationControls.hidden = totalPages <= 1;
  pageInfo.textContent = `第 ${currentPage}/${totalPages} 页`;
  pagePrevBtn.disabled = currentPage <= 1;
  pageNextBtn.disabled = currentPage >= totalPages;

  if (String(pageSize) !== pageSizeSelect.value) {
    pageSizeSelect.value = String(pageSize);
  }
}

export function updateListAfterSave(meta: NoteMeta) {
  const li = noteListEl.querySelector<HTMLLIElement>(
    `li[data-note-id="${CSS.escape(meta.id)}"]`,
  );
  if (!li) {
    renderList();
    return;
  }
  const titleEl = li.querySelector<HTMLDivElement>(".note-title");
  if (titleEl) titleEl.textContent = meta.title;
  for (const el of noteListEl.children) {
    if (el.classList.contains("list-group-header") && el.textContent === "笔记") {
      if (li.previousElementSibling !== el) noteListEl.insertBefore(li, el.nextSibling);
      break;
    }
  }
  updateMissingUI();
}

export function renderList() {
  const scrollTop = noteListEl.scrollTop;
  noteListEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  const filtered = state.query
    ? state.notes.filter((n) => n.title.toLowerCase().includes(state.query))
    : state.notes;
  const filesShown = state.query
    ? state.openFiles.filter((f) => f.name.toLowerCase().includes(state.query))
    : state.openFiles;

  emptyHintEl.hidden = filtered.length > 0 || filesShown.length > 0;
  const [hintMain, hintSub] = emptyHintEl.querySelectorAll("p");
  hintMain.textContent = state.notes.length > 0 ? "没有匹配的笔记" : "还没有笔记";
  hintSub.textContent =
    state.notes.length > 0
      ? "换个关键词试试"
      : state.openFiles.length > 0
        ? "点击「＋」新建一篇"
        : "点击「＋」新建，或点「打开文件」载入 Markdown 文件";

  if (filesShown.length > 0) {
    addGroupHeader(frag, "外部文件");
    for (const f of filesShown) {
      const li = document.createElement("li");
      li.className =
        "note-item" +
        (state.current?.kind === "file" && state.current.path === f.path ? " active" : "");
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
      li.addEventListener("click", (e) => {
        if (li.classList.contains("renaming")) return;
        const key = f.path;
        if (e.ctrlKey || e.metaKey) {
          toggleSelect(key);
        } else if (e.shiftKey && state.rangeAnchorId) {
          selectRange(key);
        } else {
          clearSelection();
          if (onSelectSourceCallback) void onSelectSourceCallback({ kind: "file", path: f.path });
        }
      });
      frag.appendChild(li);
    }
  }

  if (filtered.length > 0) {
    addGroupHeader(frag, "笔记");
    const start = (state.listPage - 1) * state.listPageSize;
    const pageNotes = filtered.slice(start, start + state.listPageSize);
    for (const n of pageNotes) {
      const li = document.createElement("li");
      li.className =
        "note-item" +
        (state.current?.kind === "note" && n.id === state.current.id ? " active" : "");
      li.dataset.noteId = n.id;

      const title = document.createElement("div");
      title.className = "note-title";
      title.textContent = n.title;

      const time = document.createElement("div");
      time.className = "note-time";
      time.textContent = fmtTime(n.updatedAt);

      li.append(title, time);
      li.addEventListener("click", (e) => {
        if (li.classList.contains("renaming")) return;
        const key = n.id;
        if (e.ctrlKey || e.metaKey) {
          toggleSelect(key);
        } else if (e.shiftKey && state.rangeAnchorId) {
          selectRange(key);
        } else {
          clearSelection();
          if (onSelectSourceCallback) void onSelectSourceCallback({ kind: "note", id: n.id });
        }
      });
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

export function startRename(id: string) {
  const li = noteListEl.querySelector<HTMLLIElement>(
    `li[data-note-id="${CSS.escape(id)}"]`,
  );
  const titleEl = li?.querySelector<HTMLDivElement>(".note-title");
  const meta = state.notes.find((n) => n.id === id);
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
        const i = state.notes.findIndex((n) => n.id === id);
        if (i >= 0) state.notes[i] = updated;
        if (oldPath) state.missingPaths.delete(pathKey(oldPath));
        renderList();
        if (state.current?.kind === "note" && state.current.id === id) {
          editorTitleEl.textContent = updated.title;
          editorTitleEl.title = updated.path;
        }
        if (onRenameSuccessCallback) onRenameSuccessCallback(id, updated);
      } catch (err) {
        if (onStatusCallback) onStatusCallback(`重命名失败: ${err}`);
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

export function initSidebar(
  onSelect: (src: Source) => Promise<void>,
  onStatus: (msg: string) => void,
  onContextMenu: (e: MouseEvent) => void,
  onRenameSuccess?: (id: string, updated: NoteMeta) => void,
  onBatchDelete?: (ids: string[]) => Promise<void>,
  onBatchExport?: (ids: string[]) => Promise<void>,
) {
  onSelectSourceCallback = onSelect;
  onStatusCallback = onStatus;
  onContextMenuCallback = onContextMenu;
  if (onRenameSuccess) onRenameSuccessCallback = onRenameSuccess;
  if (onBatchDelete) onBatchDeleteCallback = onBatchDelete;
  if (onBatchExport) onBatchExportCallback = onBatchExport;

  initSidebarResizer();
  setSidebarHidden(state.sidebarHidden);

  sidebarCollapseBtn.addEventListener("click", () => setSidebarHidden(!state.sidebarHidden));
  sidebarExpandBtn.addEventListener("click", () => setSidebarHidden(false));

  searchInputEl.addEventListener("input", () => {
    state.query = searchInputEl.value.trim().toLowerCase();
    state.listPage = 1;
    renderList();
  });

  noteListEl.addEventListener("contextmenu", (e) => {
    if (onContextMenuCallback) onContextMenuCallback(e);
  });

  // 点击列表空白处清除选择
  noteListEl.addEventListener("click", (e) => {
    if (e.target === noteListEl) clearSelection();
  });

  pagePrevBtn.addEventListener("click", () => {
    if (state.listPage > 1) {
      state.listPage--;
      renderList();
    }
  });

  pageNextBtn.addEventListener("click", () => {
    const filtered = state.query
      ? state.notes.filter((n) => n.title.toLowerCase().includes(state.query))
      : state.notes;
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.listPageSize));
    if (state.listPage < totalPages) {
      state.listPage++;
      renderList();
    }
  });

  pageSizeSelect.addEventListener("change", () => {
    const next = Number(pageSizeSelect.value);
    if (!Number.isFinite(next) || next <= 0) return;
    state.listPageSize = next;
    localStorage.setItem("notebook:list-page-size", String(next));
    state.listPage = 1;
    renderList();
  });

  batchDeleteBtn.addEventListener("click", async () => {
    const ids = [...state.selectedIds];
    if (ids.length === 0) return;
    if (onBatchDeleteCallback) await onBatchDeleteCallback(ids);
  });

  batchExportBtn.addEventListener("click", async () => {
    const ids = [...state.selectedIds];
    if (ids.length === 0) return;
    if (onBatchExportCallback) await onBatchExportCallback(ids);
  });

  batchCancelBtn.addEventListener("click", () => {
    clearSelection();
  });
}
