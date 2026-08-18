import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  closeSettings,
  initDialogs,
  openConfirm,
  openSettings,
  requestCommit,
  showContextMenu,
  switchSettingsCategory,
  syncSettingsUI,
} from "./dialogs";
import {
  applyTableTextToEditor,
  canEditCurrent,
  closeEditor,
  editorHasFocus,
  getEditorText,
  getEditorView,
  getSelectedText,
  initEditor,
  resetSaveStatus,
  runCommand,
  setSaveStatus,
  setStatus,
  setLineNumbersEnabled,
  setViewMode,
  showEditor,
  updateMissingBadge,
} from "./editor";
import { initHistory, openHistory } from "./history";
import { initShortcuts } from "./shortcuts";
import { initScrollSync, scheduleResync } from "./documentPosition";
import { initVirtualPreview, type PreviewApi } from "./virtualPreview";
import {
  applyEdit,
  loadModel,
  resetModel,
  setRenderBaseDir,
} from "./markdownModel";
import {
  clearSelection,
  initSidebar,
  renderList,
  setResponsiveSidebarHidden,
  startRename,
  updateListAfterSave,
  updateMissingUI,
} from "./sidebar";
import {
  baseName,
  dirOfPath,
  fmtTime,
  MD_EXT_RE,
  pathKey,
  readContentDensity,
  state,
} from "./state";
import { closeTablePopover, initTablePopover, toggleTablePopover } from "./table";
import { parseViewMode } from "./types";
import type { FsSyncResult, Note, NoteMeta, OpenFile, Source } from "./types";
import { applyI18nToDocument, initI18n, setLocale, t } from "./i18n";

/* ---------- DOM 元素 ---------- */
const openFileBtn = document.querySelector<HTMLButtonElement>("#open-file-btn")!;
const newNoteBtn = document.querySelector<HTMLButtonElement>("#new-note-btn")!;
const deleteNoteBtn = document.querySelector<HTMLButtonElement>("#delete-note-btn")!;
const saveAsNoteBtn = document.querySelector<HTMLButtonElement>("#save-as-note-btn")!;
const commitNoteBtn = document.querySelector<HTMLButtonElement>("#commit-note-btn")!;
const themeToggleBtn = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
const themeIconEl = themeToggleBtn.querySelector<HTMLSpanElement>(".titlebar-icon")!;
const settingsToggleBtn = document.querySelector<HTMLButtonElement>("#settings-toggle")!;
const editorPaneEl = document.querySelector<HTMLElement>("#editor-pane")!;
const winMinBtn = document.querySelector<HTMLButtonElement>("#win-min")!;
const winMaxBtn = document.querySelector<HTMLButtonElement>("#win-max")!;
const winCloseBtn = document.querySelector<HTMLButtonElement>("#win-close")!;
const viewButtons = document.querySelectorAll<HTMLButtonElement>(".view-btn");
const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool-btn");

let saveTimer: number | undefined;

/** 虚拟预览实例（在初始化阶段创建，供模块级函数在删除/关闭流程中刷新） */
let previewApi: PreviewApi | null = null;

/** 打开/切换编辑对象：先加载 Markdown 块模型，再让编辑器显示内容 */
function openInEditor(title: string, content: string, path: string) {
  setRenderBaseDir(dirOfPath(path));
  loadModel(content);
  showEditor(title, content, path);
  previewApi?.refresh();
}

/** 关闭当前编辑对象：清空模型与预览 */
function closeActiveEditor() {
  closeEditor();
  resetModel();
  previewApi?.refresh();
}

/* ---------- 主题 ---------- */
const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  themeIconEl.innerHTML = theme === "dark" ? SUN_SVG : MOON_SVG;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("notebook:theme", next);
  localStorage.setItem("notebook:theme-mode", next);
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function applySettings() {
  autosaveEnabled = localStorage.getItem("notebook:autosave") !== "0";
  autosaveDelayMs = Number(localStorage.getItem("notebook:autosave-delay")) || 500;

  const themeMode = localStorage.getItem("notebook:theme-mode") || "system";
  let resolvedTheme: "light" | "dark" = "light";
  if (themeMode === "dark") resolvedTheme = "dark";
  else if (themeMode === "system") resolvedTheme = getSystemTheme();
  applyTheme(resolvedTheme);

  const viewMode = parseViewMode(localStorage.getItem("notebook:view"));
  setViewMode(viewMode);

  const fontSize = localStorage.getItem("notebook:font-size") || "15.5";
  document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);

  state.contentDensity = readContentDensity();
  document.documentElement.dataset.contentDensity = state.contentDensity;

  const sidebarWidth = Number(localStorage.getItem("notebook:sidebar-width")) || 260;
  state.sidebarWidth = Math.min(Math.max(sidebarWidth, 210), 460);
  const sidebarEl = document.querySelector<HTMLElement>("#sidebar");
  if (sidebarEl) sidebarEl.style.width = `${state.sidebarWidth}px`;

  setLineNumbersEnabled(localStorage.getItem("notebook:line-numbers") !== "0");
}

/* ---------- 侧栏与数据刷新 ---------- */
async function refreshList() {
  state.notes = await invoke<NoteMeta[]>("list_notes");
  state.listPage = 1;
  renderList();
}

/* ---------- 外部文件/笔记删除状态轮询与改名同步 ---------- */
const renameHints = new Set<string>(); // 本次轮询已提示过改名的笔记 id

async function pollFileStates() {
  // 窗口隐藏/最小化时跳过轮询（恢复可见时会立即补一次）
  if (document.hidden) return;
  const paths = [...state.notes.map((n) => n.path), ...state.openFiles.map((f) => f.path)].filter(
    (p) => p.length > 0,
  );
  if (paths.length === 0) {
    if (state.missingPaths.size > 0) {
      state.missingPaths.clear();
      renderList();
    }
    return;
  }
  try {
    // 单次往返同时完成外部改名/移动同步与文件存在性检查（后端 sync_fs_state）
    const res = await invoke<FsSyncResult>("sync_fs_state", { paths });
    if (res.changed.length > 0) {
      const notesChanged: string[] = [];
      for (const m of res.changed) {
        const i = state.notes.findIndex((n) => n.id === m.id);
        if (i < 0) continue;
        if (state.notes[i].title !== m.title) notesChanged.push(m.id);
        state.missingPaths.delete(pathKey(state.notes[i].path));
        state.missingPaths.delete(pathKey(m.path));
        state.notes[i] = m;
      }
      state.notes.sort((a, b) => b.updatedAt - a.updatedAt);
      renderList();
      // 若正在编辑的笔记被外部改名，刷新标题栏
      const currentNoteId =
        state.current?.kind === "note" ? (state.current as { id: string }).id : null;
      if (currentNoteId) {
        const cur = state.notes.find((n) => n.id === currentNoteId);
        if (cur) {
          const titleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
          titleEl.textContent = cur.title;
          titleEl.title = cur.path;
        }
      }
      for (const id of notesChanged) {
        if (!renameHints.has(id)) {
          renameHints.add(id);
          const n = state.notes.find((x) => x.id === id);
          if (n) setStatus(t("status.externalRename", { title: n.title }));
        }
      }
    }
    const next = new Set(paths.filter((_, i) => !res.exists[i]).map(pathKey));
    const same =
      next.size === state.missingPaths.size && [...next].every((p) => state.missingPaths.has(p));
    if (!same) {
      state.missingPaths = next;
      renderList();
      updateMissingUI(updateMissingBadge);
    }
  } catch {
    // 轮询失败静默，等待下次
  }
}

/* ---------- 保存与自动保存 ---------- */
async function save() {
  if (!state.dirty || !state.current) return;
  const content = getEditorText();
  setSaveStatus("saving", t("status.saving"));

  try {
    if (state.current.kind === "note") {
      const id = state.current.id;
      const oldPath = state.notes.find((n) => n.id === id)?.path ?? "";
      const meta = await invoke<NoteMeta>("update_note", { id, content });
      state.dirty = getEditorText() !== content;
      state.missingPaths.delete(pathKey(meta.path));
      if (oldPath) state.missingPaths.delete(pathKey(oldPath));
      const i = state.notes.findIndex((n) => n.id === id);
      if (i >= 0) state.notes[i] = meta;
      state.notes.sort((a, b) => b.updatedAt - a.updatedAt);
      updateListAfterSave(meta);

      if (!state.dirty && state.current.kind === "note" && state.current.id === id) {
        const editorTitleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
        editorTitleEl.textContent = meta.title;
        editorTitleEl.title = meta.path;
        const renamed = oldPath !== "" && pathKey(meta.path) !== pathKey(oldPath);
        setSaveStatus(
          "saved",
          renamed
            ? t("status.saved.renamed", { time: fmtTime(meta.updatedAt), name: baseName(meta.path) })
            : t("status.saved", { time: fmtTime(meta.updatedAt) }),
        );
      }
    } else {
      const path = state.current.path;
      const updatedAt = await invoke<number>("save_md_file", { path, content });
      state.dirty = getEditorText() !== content;
      state.missingPaths.delete(pathKey(path));
      updateMissingUI(updateMissingBadge);
      const f = state.openFiles.find((f) => f.path === path);
      if (f) f.content = content;
      if (!state.dirty && state.current.kind === "file" && state.current.path === path) {
        setSaveStatus("saved", t("status.saved", { time: fmtTime(updatedAt) }));
      }
    }
  } catch (e) {
    setSaveStatus("error", t("status.error.save", { error: String(e) }));
    return;
  }
  // 保存期间又有新输入：恢复“输入中…”提示
  if (state.dirty) setStatus(t("status.typing"));
}

async function flushSave() {
  if (state.dirty && state.current) {
    await save();
  } else {
    resetSaveStatus();
  }
}

// 自动保存设置缓存在内存（原先每次按键都同步读 localStorage），applySettings 时刷新
let autosaveEnabled = true;
let autosaveDelayMs = 500;

function getAutosaveDelay(): number {
  return autosaveDelayMs;
}

function isAutosaveEnabled(): boolean {
  return autosaveEnabled;
}

/* ---------- 自适应防抖 ----------
 * 以设置面板的基准延迟为锚点，按最近的输入节奏动态浮动：
 * 连续快速输入（平均间隔 < 200ms）→ 最多拉长到 4 倍，尽量合并为一次保存；
 * 正常打字 → 2 倍；停顿较久（> 2s）→ 缩短到一半，尽快落盘。
 * 上限/下限 300ms ~ 4000ms，避免极端值。 */
const ADAPTIVE_MIN_MS = 300;
const ADAPTIVE_MAX_MS = 4000;
const ADAPTIVE_WINDOW = 5;
const inputTimes: number[] = [];

function adaptiveDelay(base: number): number {
  const now = performance.now();
  inputTimes.push(now);
  if (inputTimes.length > ADAPTIVE_WINDOW) inputTimes.shift();
  if (inputTimes.length < 2) return Math.min(ADAPTIVE_MAX_MS, Math.max(ADAPTIVE_MIN_MS, base));
  const gaps = inputTimes.slice(1).map((t, i) => t - inputTimes[i]);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  let factor = 1;
  if (avg < 200) factor = 4;
  else if (avg < 600) factor = 2;
  else if (avg > 2000) factor = 0.5;
  const delay = Math.round(base * factor);
  return Math.min(ADAPTIVE_MAX_MS, Math.max(ADAPTIVE_MIN_MS, delay));
}

function scheduleSave() {
  state.dirty = true;
  setStatus(t("status.typing"));
  window.clearTimeout(saveTimer);
  if (!isAutosaveEnabled()) return;
  const delay = adaptiveDelay(getAutosaveDelay());
  saveTimer = window.setTimeout(() => {
    void save();
  }, delay);
}

/* ---------- 切换/选择编辑对象 ---------- */
async function selectSource(src: Source) {
  closeTablePopover();
  const same =
    state.current !== null &&
    ((src.kind === "note" && state.current.kind === "note" && src.id === state.current.id) ||
      (src.kind === "file" && state.current.kind === "file" && src.path === state.current.path));
  if (same) return;
  await flushSave();
  // 切换编辑对象后重置输入节奏统计，避免新笔记被旧窗口的间隔误导
  inputTimes.length = 0;
  state.current = src;

  if (src.kind === "note") {
    const note = await invoke<Note>("get_note", { id: src.id });
    commitNoteBtn.hidden = false;
    saveAsNoteBtn.hidden = true;
    deleteNoteBtn.textContent = t("editor.header.delete");
    deleteNoteBtn.title = t("editor.header.delete");
    deleteNoteBtn.classList.remove("close-mode");
    openInEditor(note.title, note.content, note.path);
  } else {
    const f = state.openFiles.find((f) => f.path === src.path)!;
    commitNoteBtn.hidden = true;
    saveAsNoteBtn.hidden = false;
    deleteNoteBtn.textContent = t("editor.header.closeFile");
    deleteNoteBtn.title = t("editor.header.closeFile");
    deleteNoteBtn.classList.add("close-mode");
    openInEditor(f.name, f.content, f.path);
  }
  renderList();
}

/* ---------- 多选批量操作 ---------- */

async function batchDeleteSelected(ids: string[]) {
  // 拆出笔记 id 与外部文件路径（选中集里这两类可能混合）
  const noteIds = ids.filter((id) => state.notes.some((n) => n.id === id));
  const filePaths = ids.filter((id) => state.openFiles.some((f) => f.path === id));
  const total = noteIds.length + filePaths.length;
  if (total === 0) {
    setStatus(t("status.batch.noDeletable"));
    return;
  }
  const parts: string[] = [];
  if (noteIds.length > 0) parts.push(t("batch.deleteNote", { count: noteIds.length }));
  if (filePaths.length > 0) parts.push(t("batch.closeFile", { count: filePaths.length }));
  const text =
    noteIds.length > 0 && filePaths.length > 0
      ? t("confirm.text.batchMixed")
      : noteIds.length > 0
        ? t("confirm.text.batchNote")
        : t("confirm.text.batchFile");
  openConfirm({
    title: `${parts.join(t("common.and"))}？`,
    text,
    okLabel: noteIds.length > 0 ? t("confirm.ok.delete") : t("confirm.ok.close"),
    danger: noteIds.length > 0,
    action: async () => {
      try {
        if (noteIds.length > 0) {
          await invoke<number>("delete_selected_notes", { ids: noteIds });
if (state.current?.kind === "note" && noteIds.includes(state.current.id)) {
      closeActiveEditor();
    }
        }
        for (const p of filePaths) {
          await closeFile(p);
        }
        clearSelection();
        await refreshList();
        const doneParts: string[] = [];
        if (noteIds.length > 0) doneParts.push(t("status.batch.deleteDone", { count: noteIds.length }));
        if (filePaths.length > 0) doneParts.push(t("status.batch.closeDone", { count: filePaths.length }));
        setStatus(doneParts.join("，"));
      } catch (err) {
        setStatus(t("status.batch.deleteFail", { error: String(err) }));
      }
    },
  });
}

async function batchExportSelected(ids: string[]) {
  const noteIds = ids.filter((id) => state.notes.some((n) => n.id === id));
  const filePaths = ids.filter((id) => state.openFiles.some((f) => f.path === id));
  if (noteIds.length === 0 && filePaths.length === 0) {
    setStatus(t("status.batch.noExportable"));
    return;
  }
  try {
    const defaultName = `${t("dialog.exportFilePrefix")}_${new Date().toISOString().slice(0, 10)}.zip`;
    const picked = await saveDialog({
      title: t("dialog.export"),
      defaultPath: defaultName,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!picked) return;
    let zipPath = picked;
    if (!/\.zip$/i.test(zipPath)) zipPath += ".zip";
    const count = await invoke<number>("export_notes", {
      ids: noteIds,
      paths: filePaths,
      zipPath,
    });
    setStatus(t("status.exported", { count, path: zipPath }));
    clearSelection();
  } catch (err) {
    setStatus(t("status.exportFail", { error: String(err) }));
  }
}

/* ---------- 新建 / 打开 / 关闭 / 删除 / 另存为 ---------- */
async function newNote() {
  await flushSave();
  const picked = await saveDialog({
    title: t("dialog.newNote"),
    defaultPath: t("dialog.untitledNote") + ".md",
    filters: [{ name: t("dialog.filter.markdown"), extensions: ["md", "markdown"] }],
  });
  if (!picked) return;
  let path = picked;
  if (!/\.(md|markdown)$/i.test(path)) path += ".md";

  const opened = state.openFiles.find((f) => pathKey(f.path) === pathKey(path));
  if (opened) {
    await selectSource({ kind: "file", path: opened.path });
    return;
  }
  try {
    const meta = await invoke<NoteMeta>("create_note", { path });
    await refreshList();
    await selectSource({ kind: "note", id: meta.id });
    const chosenStem = path.replace(/\.(md|markdown)$/i, "");
    if (meta.title !== chosenStem) {
      setStatus(t("status.newNoteCreated", { title: meta.title }));
    }
  } catch (err) {
    setStatus(t("status.newNoteFail", { error: String(err) }));
  }
}

async function openPaths(paths: string[]): Promise<boolean> {
  const targets = paths.filter((p) => MD_EXT_RE.test(p));
  if (targets.length === 0) return false;
  await flushSave();

  const toSelect: string[] = [];
  const fresh: OpenFile[] = [];
  const errors: string[] = [];
  for (const path of targets) {
    const existing = state.openFiles.find((f) => pathKey(f.path) === pathKey(path));
    if (existing) {
      toSelect.push(path);
      continue;
    }
    try {
      const f = await invoke<OpenFile>("open_md_file", { path });
      fresh.push(f);
      toSelect.push(path);
    } catch (e) {
      errors.push(`${path}: ${e}`);
    }
  }
  if (fresh.length > 0) {
    state.openFiles.push(...fresh);
    renderList();
  }
  if (toSelect.length > 0) {
    await selectSource({ kind: "file", path: toSelect[0] });
    if (fresh.length > 1) setStatus(t("status.filesOpened", { count: fresh.length }));
  }
  if (errors.length > 0) setStatus(t("status.openFail", { error: errors.join("；") }));
  return toSelect.length > 0;
}

async function openFileDialog() {
  const picked = await openDialog({
    multiple: true,
    title: t("dialog.openFile"),
    filters: [
      { name: t("dialog.filter.markdown"), extensions: ["md", "markdown"] },
      { name: t("dialog.filter.text"), extensions: ["txt"] },
      { name: t("dialog.filter.all"), extensions: ["*"] },
    ],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  await openPaths(paths);
}

async function revealInFolder(path: string) {
  if (!path) return;
  try {
    await invoke("reveal_in_folder", { path });
  } catch (err) {
    setStatus(t("status.revealFail", { error: String(err) }));
  }
}

async function closeFile(path?: string) {
  const target = path ?? (state.current?.kind === "file" ? state.current.path : null);
  if (!target) return;
  await flushSave();
  state.openFiles = state.openFiles.filter((f) => f.path !== target);
if (state.current?.kind === "file" && state.current.path === target) {
      closeActiveEditor();
    }
  renderList();
}

async function saveFileAsNote(path?: string) {
  const target = path ?? (state.current?.kind === "file" ? state.current.path : null);
  if (!target) return;
  await flushSave();

  const f = state.openFiles.find((f) => f.path === target);
  if (!f) return;
  if (state.missingPaths.has(pathKey(target))) {
    setStatus(t("status.saveAsSourceMissing"));
    return;
  }

  const dir = dirOfPath(f.path);
  const stem = baseName(f.path).replace(/\.(md|markdown|txt)$/i, "") || t("dialog.untitledNote");
  const sep = dir.includes("/") ? "/" : "\\";
  const defaultPath = dir ? dir + sep + stem + ".md" : stem + ".md";

  const picked = await saveDialog({
    title: t("dialog.saveAs"),
    defaultPath,
    filters: [{ name: t("dialog.filter.markdown"), extensions: ["md", "markdown"] }],
  });
  if (!picked) return;
  let dst = picked;
  if (!/\.(md|markdown)$/i.test(dst)) dst += ".md";

  const noteAtPath = state.notes.find((n) => pathKey(n.path) === pathKey(dst));
  if (noteAtPath) {
    setStatus(t("status.saveAsConflict", { title: noteAtPath.title }));
    return;
  }
  const otherOpen = state.openFiles.find(
    (f) => f.path !== target && pathKey(f.path) === pathKey(dst),
  );

  const doSave = async (overwrite: boolean) => {
    try {
      const meta = await invoke<NoteMeta>("save_file_as_note", {
        source: f.path,
        target: dst,
        overwrite,
      });
      if (otherOpen) {
        state.openFiles = state.openFiles.filter((x) => x.path !== otherOpen.path);
        if (state.current?.kind === "file" && state.current.path === otherOpen.path) {
          closeEditor();
        }
      }
      await refreshList();
      await selectSource({ kind: "note", id: meta.id });
      const renamed = pathKey(meta.path) !== pathKey(dst);
      setStatus(
        renamed
          ? t("status.newNoteSavedAsRenamed", { title: meta.title, name: baseName(meta.path) })
          : t("status.newNoteSavedAs", { title: meta.title }),
      );
    } catch (err) {
      setStatus(t("status.saveAsFail", { error: String(err) }));
    }
  };

  const [exists] = await invoke<boolean[]>("files_exist", { paths: [dst] });
  if (exists) {
    openConfirm({
      title: t("confirm.title.overwrite"),
      text: t("confirm.text.overwrite", { path: dst }),
      okLabel: t("confirm.ok.overwrite"),
      danger: true,
      action: () => doSave(true),
    });
  } else {
    await doSave(false);
  }
}

function requestDelete(id?: string) {
  const target = id ?? (state.current?.kind === "note" ? state.current.id : null);
  if (!target) {
    if (state.current?.kind === "file") void closeFile();
    return;
  }
  openConfirm({
    title: t("confirm.title.deleteNote"),
    text: t("confirm.text.deleteNote"),
    okLabel: t("confirm.ok.delete"),
    danger: true,
    action: async () => {
      try {
        await invoke("delete_note", { id: target });
        if (state.current?.kind === "note" && state.current.id === target) {
          closeActiveEditor();
        }
        await refreshList();
      } catch (err) {
        setStatus(t("status.deleteFail", { error: String(err) }));
      }
    },
  });
}

/* ---------- 右键菜单分发 ---------- */
function onListContextMenu(e: MouseEvent) {
  e.preventDefault();
  const li = (e.target as HTMLElement).closest<HTMLLIElement>(".note-item");

  if (li?.dataset.noteId) {
    const id = li.dataset.noteId;
    const path = state.notes.find((n) => n.id === id)?.path ?? "";
    void selectSource({ kind: "note", id });
    showContextMenu(e.clientX, e.clientY, [
      { label: t("contextMenu.rename"), action: () => startRename(id) },
      {
        label: t("contextMenu.commit"),
        action: () => void requestCommit(id, flushSave, setStatus),
      },
      { label: t("contextMenu.history"), action: () => void openHistory(id, flushSave) },
      { label: t("contextMenu.reveal"), action: () => void revealInFolder(path) },
      { label: t("contextMenu.delete"), danger: true, action: () => requestDelete(id) },
    ]);
  } else if (li?.dataset.filePath) {
    const path = li.dataset.filePath;
    void selectSource({ kind: "file", path });
    showContextMenu(e.clientX, e.clientY, [
      { label: t("contextMenu.saveAsNote"), action: () => void saveFileAsNote(path) },
      { label: t("contextMenu.reveal"), action: () => void revealInFolder(path) },
      { label: t("contextMenu.closeFile"), action: () => void closeFile(path) },
    ]);
  } else {
    showContextMenu(e.clientX, e.clientY, [{ label: t("contextMenu.newNote"), action: () => void newNote() }]);
  }
}

/* ---------- 应用程序启动初始化 ---------- */
window.addEventListener("DOMContentLoaded", async () => {
  // 1. 初始化设置
  applySettings();
  await initI18n();
  applyI18nToDocument();
  themeToggleBtn.addEventListener("click", toggleTheme);

  // 2. 初始化窗口无边框控制
  const win = getCurrentWindow();
  const updateMaxIcon = async () => {
    winMaxBtn.classList.toggle("maximized", await win.isMaximized());
  };
  winMinBtn.addEventListener("click", () => void win.minimize());
  winMaxBtn.addEventListener("click", () => void win.toggleMaximize());
  winCloseBtn.addEventListener("click", () => void win.close());
  void updateMaxIcon();
  win.onResized(updateMaxIcon);

  // 3. 窄屏侧栏抽屉点击自动折叠
  editorPaneEl.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("#sidebar-expand")) return;
    if (window.innerWidth <= 860) setResponsiveSidebarHidden(true);
  });

  // 3.5 窄屏侧栏仅临时收起，不覆盖用户保存的侧栏偏好
  const syncResponsiveSidebar = () => setResponsiveSidebarHidden(window.innerWidth <= 860);
  syncResponsiveSidebar();
  window.addEventListener("resize", syncResponsiveSidebar);

  // 4. 初始化视图切换
  for (const b of viewButtons) {
    b.addEventListener("click", () => setViewMode(b.dataset.mode));
  }

  // 5. 初始化工具栏动作
  for (const b of toolButtons) {
    b.addEventListener("click", () => runCommand(b.dataset.cmd ?? "", toggleTablePopover));
  }

  // 6. 初始化子模块
  initDialogs();
  let settingsEls = syncSettingsUI();
  settingsToggleBtn.addEventListener("click", openSettings);
  document.getElementById("settings-close")?.addEventListener("click", closeSettings);
  document.getElementById("settings-overlay")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "settings-overlay") closeSettings();
  });
  document.getElementById("settings-sidebar")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".settings-nav-item");
    if (!btn) return;
    const category = btn.dataset.category;
    if (!category) return;
    switchSettingsCategory(category);
    localStorage.setItem("notebook:settings-category", category);
  });
  settingsEls.theme.addEventListener("change", () => {
    localStorage.setItem("notebook:theme-mode", settingsEls.theme.value);
    applySettings();
  });
  settingsEls.view.addEventListener("change", () => {
    setViewMode(settingsEls.view.value);
  });
  settingsEls.contentDensity.addEventListener("change", () => {
    localStorage.setItem("notebook:content-density", settingsEls.contentDensity.value);
    applySettings();
    previewApi?.markLayoutDirty();
    scheduleResync();
  });
  settingsEls.fontSize.addEventListener("change", () => {
    localStorage.setItem("notebook:font-size", settingsEls.fontSize.value);
    applySettings();
    previewApi?.markLayoutDirty();
    scheduleResync();
  });
  settingsEls.autosave.addEventListener("change", () => {
    localStorage.setItem("notebook:autosave", settingsEls.autosave.checked ? "1" : "0");
    applySettings();
  });
  settingsEls.autosaveDelay.addEventListener("change", () => {
    localStorage.setItem("notebook:autosave-delay", settingsEls.autosaveDelay.value);
    applySettings();
  });
  settingsEls.sidebarWidth.addEventListener("change", () => {
    localStorage.setItem("notebook:sidebar-width", settingsEls.sidebarWidth.value);
    applySettings();
  });
  settingsEls.lineNumbers.addEventListener("change", () => {
    localStorage.setItem("notebook:line-numbers", settingsEls.lineNumbers.checked ? "1" : "0");
    setLineNumbersEnabled(settingsEls.lineNumbers.checked);
  });
  settingsEls.language.addEventListener("change", async () => {
    await setLocale(settingsEls.language.value);
    applyI18nToDocument();
    const refreshedSettings = syncSettingsUI();
    settingsEls = refreshedSettings;
    openSettings();
  });

  initTablePopover(applyTableTextToEditor, () => {
    return {
      hasEditor: canEditCurrent(),
      text: getSelectedText(),
    };
  });
  initHistory(
    async (restored, isCurrent) => {
      const i = state.notes.findIndex((n) => n.id === restored.id);
      if (i >= 0) state.notes[i] = restored;
      state.notes.sort((a, b) => b.updatedAt - a.updatedAt);
      state.missingPaths.delete(pathKey(restored.path));
      renderList();
      updateMissingUI(updateMissingBadge);
      if (isCurrent) {
        const opened = await invoke<Note>("get_note", { id: restored.id });
        openInEditor(opened.title, opened.content, opened.path);
        setStatus(t("status.versionRestored"));
      } else {
        setStatus(t("status.versionRestoredOther", { title: restored.title }));
      }
    },
    (msg) => setStatus(msg),
  );
  // 预览虚拟化实例：块级渲染，只挂载视口附近的块
  previewApi = initVirtualPreview(document.querySelector<HTMLElement>("#preview")!);

  // 编辑器初始化（CodeMirror 6）：输入变更驱动块模型的增量更新与虚拟预览刷新
  initEditor({
    onEditChange: () => scheduleSave(),
    onDocChange: (range, text) => {
      const changed = applyEdit(
        text,
        { start: range.start, end: range.end },
        { newlineChange: range.hasNewlineChange },
      );
      previewApi?.refresh(changed);
      scheduleResync();
    },
    setPreviewVisible: (visible) => previewApi?.setVisible(visible),
    refreshPreview: () => {
      previewApi?.refresh();
      scheduleResync();
    },
    markPreviewLayoutDirty: () => previewApi?.markLayoutDirty(),
    previewElement: previewApi.element,
  });
  setLineNumbersEnabled(localStorage.getItem("notebook:line-numbers") !== "0");
  initSidebar(
    selectSource,
    setStatus,
    onListContextMenu,
    (id, updated) => {
      // 侧栏行内改名成功后的状态提示
      setStatus(t("status.renameSuccess", { title: updated.title }));
      if (state.current?.kind === "note" && state.current.id === id) {
        const titleEl = document.querySelector<HTMLSpanElement>("#editor-title")!;
        titleEl.textContent = updated.title;
        titleEl.title = updated.path;
      }
    },
    batchDeleteSelected,
    batchExportSelected,
  );
  initShortcuts({ onNewNote: newNote, onOpenFile: openFileDialog, onFlushSave: flushSave, editorHasFocus });

  // 7. 分屏滚动同步：逻辑位置同步（编辑区源行 ↔ 预览区块），见 documentPosition.ts
  initScrollSync({ getEditorView, getPreview: () => previewApi! });

  // 8. 头部按钮绑定
  commitNoteBtn.addEventListener("click", () => void requestCommit(undefined, flushSave, setStatus));
  saveAsNoteBtn.addEventListener("click", () => void saveFileAsNote());
  deleteNoteBtn.addEventListener("click", () => requestDelete());
  openFileBtn.addEventListener("click", openFileDialog);
  newNoteBtn.addEventListener("click", newNote);

  // 9. 拖拽文件打开
  getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      void openPaths(event.payload.paths);
    }
  });

  // 10. 失焦立即冲刷保存
  window.addEventListener("blur", () => void flushSave());

  // 10.5 Esc 清除多选
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selectedIds.length > 0) {
      clearSelection();
    }
  });

  // 11. 关闭窗口前冲刷未保存内容
  await listen("app-close-request", async () => {
    if (state.closing) return;
    state.closing = true;
    try {
      await flushSave();
    } finally {
      await invoke("close_ready").catch(() => {});
    }
  });

  // 11.5 切换前/关闭前主动清理保存状态，避免停留在“保存中/失败”提示
  const cleanupBeforeLeave = async () => {
    if (!state.dirty) resetSaveStatus();
  };
  window.addEventListener("pagehide", cleanupBeforeLeave);
  window.addEventListener("beforeunload", cleanupBeforeLeave);

  // 11.6 粘贴图片：由 editor.ts 统一处理（保存到附件目录并插入 Markdown 链接）

  // 12. 文件关联与单实例支持
  const pending = await invoke<string[]>("pending_open_files");
  const openedByPending = pending.length > 0 ? await openPaths(pending) : false;
  await listen<string[]>("open-md-files", (e) => void openPaths(e.payload));

  // 13. 加载初次数据
  await refreshList();
  if (state.notes.length > 0 && !openedByPending) {
    await selectSource({ kind: "note", id: state.notes[0].id });
  }

  // 14. 周期性轮询外部文件删除状态（窗口隐藏时跳过，恢复可见立即补一次）
  void pollFileStates();
  window.setInterval(pollFileStates, 3000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pollFileStates();
  });
});
