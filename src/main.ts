import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  initDialogs,
  openConfirm,
  requestCommit,
  showContextMenu,
} from "./dialogs";
import {
  applyTableTextToEditor,
  closeEditor,
  getEditorElement,
  getPreviewElement,
  initEditor,
  runCommand,
  setStatus,
  setViewMode,
  showEditor,
  updateMissingBadge,
} from "./editor";
import { initHistory, openHistory } from "./history";
import { initShortcuts } from "./shortcuts";
import {
  initSidebar,
  renderList,
  setSidebarHidden,
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
  state,
} from "./state";
import { closeTablePopover, initTablePopover, toggleTablePopover } from "./table";
import type { Note, NoteMeta, OpenFile, Source, ViewMode } from "./types";

/* ---------- DOM 元素 ---------- */
const openFileBtn = document.querySelector<HTMLButtonElement>("#open-file-btn")!;
const newNoteBtn = document.querySelector<HTMLButtonElement>("#new-note-btn")!;
const deleteNoteBtn = document.querySelector<HTMLButtonElement>("#delete-note-btn")!;
const saveAsNoteBtn = document.querySelector<HTMLButtonElement>("#save-as-note-btn")!;
const commitNoteBtn = document.querySelector<HTMLButtonElement>("#commit-note-btn")!;
const themeToggleBtn = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
const themeIconEl = themeToggleBtn.querySelector<HTMLSpanElement>(".titlebar-icon")!;
const editorPaneEl = document.querySelector<HTMLElement>("#editor-pane")!;
const winMinBtn = document.querySelector<HTMLButtonElement>("#win-min")!;
const winMaxBtn = document.querySelector<HTMLButtonElement>("#win-max")!;
const winCloseBtn = document.querySelector<HTMLButtonElement>("#win-close")!;
const viewButtons = document.querySelectorAll<HTMLButtonElement>(".view-btn");
const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool-btn");

let saveTimer: number | undefined;

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
}

/* ---------- 滚动同步（分屏） ---------- */
function syncScroll(src: HTMLElement, dst: HTMLElement) {
  const max = src.scrollHeight - src.clientHeight;
  if (max <= 0) return;
  const ratio = src.scrollTop / max;
  state.syncing = true;
  dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
  requestAnimationFrame(() => {
    state.syncing = false;
  });
}

/* ---------- 侧栏与数据刷新 ---------- */
async function refreshList() {
  state.notes = await invoke<NoteMeta[]>("list_notes");
  renderList();
}

/* ---------- 外部文件/笔记删除状态轮询 ---------- */
async function pollFileStates() {
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
    const states = await invoke<boolean[]>("files_exist", { paths });
    const next = new Set(paths.filter((_, i) => !states[i]).map(pathKey));
    const same =
      next.size === state.missingPaths.size && [...next].every((p) => state.missingPaths.has(p));
    if (!same) {
      state.missingPaths = next;
      renderList();
      updateMissingUI(updateMissingBadge);
    }
  } catch {
    // 轮询失败静默
  }
}

/* ---------- 保存与自动保存 ---------- */
async function save() {
  if (!state.dirty || !state.current) return;
  const editorEl = getEditorElement();
  const content = editorEl.value;

  if (state.current.kind === "note") {
    const id = state.current.id;
    const oldPath = state.notes.find((n) => n.id === id)?.path ?? "";
    const meta = await invoke<NoteMeta>("update_note", { id, content });
    state.dirty = editorEl.value !== content;
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
      setStatus(
        renamed
          ? `已保存 ${fmtTime(meta.updatedAt)}（文件已同步重命名为 ${baseName(meta.path)}）`
          : `已保存 ${fmtTime(meta.updatedAt)}`,
      );
    }
  } else {
    const path = state.current.path;
    const updatedAt = await invoke<number>("save_md_file", { path, content });
    state.dirty = editorEl.value !== content;
    state.missingPaths.delete(pathKey(path));
    updateMissingUI(updateMissingBadge);
    const f = state.openFiles.find((f) => f.path === path);
    if (f) f.content = content;
    if (!state.dirty && state.current.kind === "file" && state.current.path === path) {
      setStatus(`已保存 ${fmtTime(updatedAt)}`);
    }
  }
}

async function flushSave() {
  if (state.dirty && state.current) {
    await save();
  }
}

function scheduleSave() {
  state.dirty = true;
  setStatus("输入中…");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    save().catch((e) => setStatus(`保存失败: ${e}`));
  }, 500);
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
  state.current = src;

  if (src.kind === "note") {
    const note = await invoke<Note>("get_note", { id: src.id });
    commitNoteBtn.hidden = false;
    saveAsNoteBtn.hidden = true;
    deleteNoteBtn.textContent = "删除";
    deleteNoteBtn.title = "删除这篇笔记";
    deleteNoteBtn.classList.remove("close-mode");
    showEditor(note.title, note.content, note.path);
  } else {
    const f = state.openFiles.find((f) => f.path === src.path)!;
    commitNoteBtn.hidden = true;
    saveAsNoteBtn.hidden = false;
    deleteNoteBtn.textContent = "关闭";
    deleteNoteBtn.title = "关闭这个文件（不会删除磁盘上的文件）";
    deleteNoteBtn.classList.add("close-mode");
    showEditor(f.name, f.content, f.path);
  }
  setStatus("");
  renderList();
}

/* ---------- 新建 / 打开 / 关闭 / 删除 / 另存为 ---------- */
async function newNote() {
  try {
    await flushSave();
  } catch {
    // 保持保存失败不阻断
  }
  const picked = await saveDialog({
    title: "新建笔记",
    defaultPath: "无标题笔记.md",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (!picked) return;
  let path = picked;
  if (!/\.(md|markdown)$/i.test(path)) path += ".md";

  const opened = state.openFiles.find((f) => f.path.toLowerCase() === path.toLowerCase());
  if (opened) {
    await selectSource({ kind: "file", path: opened.path });
    return;
  }
  try {
    const meta = await invoke<NoteMeta>("create_note", { path });
    await refreshList();
    await selectSource({ kind: "note", id: meta.id });
  } catch (err) {
    setStatus(`新建笔记失败: ${err}`);
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
    const existing = state.openFiles.find((f) => f.path === path);
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
    if (fresh.length > 1) setStatus(`已打开 ${fresh.length} 个文件`);
  }
  if (errors.length > 0) setStatus(`打开失败: ${errors.join("；")}`);
  return toSelect.length > 0;
}

async function openFileDialog() {
  const picked = await openDialog({
    multiple: true,
    title: "打开 Markdown 文件",
    filters: [
      { name: "Markdown", extensions: ["md", "markdown"] },
      { name: "文本文件", extensions: ["txt"] },
      { name: "所有文件", extensions: ["*"] },
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
    setStatus(`打开文件位置失败: ${err}`);
  }
}

async function closeFile(path?: string) {
  const target = path ?? (state.current?.kind === "file" ? state.current.path : null);
  if (!target) return;
  await flushSave();
  state.openFiles = state.openFiles.filter((f) => f.path !== target);
  if (state.current?.kind === "file" && state.current.path === target) closeEditor();
  renderList();
}

async function saveFileAsNote(path?: string) {
  const target = path ?? (state.current?.kind === "file" ? state.current.path : null);
  if (!target) return;
  await flushSave();

  const f = state.openFiles.find((f) => f.path === target);
  if (!f) return;
  if (state.missingPaths.has(pathKey(target))) {
    setStatus("源文件已被删除，无法另存为笔记");
    return;
  }

  const dir = dirOfPath(f.path);
  const stem = baseName(f.path).replace(/\.(md|markdown|txt)$/i, "") || "无标题笔记";
  const sep = dir.includes("/") ? "/" : "\\";
  const defaultPath = dir ? dir + sep + stem + ".md" : stem + ".md";

  const picked = await saveDialog({
    title: "另存为笔记",
    defaultPath,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (!picked) return;
  let dst = picked;
  if (!/\.(md|markdown)$/i.test(dst)) dst += ".md";

  const noteAtPath = state.notes.find((n) => pathKey(n.path) === pathKey(dst));
  if (noteAtPath) {
    setStatus("该位置已是一篇笔记「" + noteAtPath.title + "」，请选择其他位置");
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
        if (state.current?.kind === "file" && state.current.path === otherOpen.path) closeEditor();
      }
      await refreshList();
      await selectSource({ kind: "note", id: meta.id });
      const renamed = pathKey(meta.path) !== pathKey(dst);
      setStatus(
        renamed
          ? "已另存为笔记「" + meta.title + "」（文件已按标题重命名为 " + baseName(meta.path) + "）"
          : "已另存为笔记「" + meta.title + "」",
      );
    } catch (err) {
      setStatus("另存为笔记失败: " + err);
    }
  };

  const [exists] = await invoke<boolean[]>("files_exist", { paths: [dst] });
  if (exists) {
    openConfirm({
      title: "目标文件已存在",
      text: "该位置已有文件，继续将覆盖它：\n" + dst + "\n\n原外部文件不受影响。",
      okLabel: "覆盖",
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
    title: "删除这篇笔记？",
    text: "删除后将无法恢复，请确认后再操作。",
    okLabel: "删除",
    danger: true,
    action: async () => {
      try {
        await invoke("delete_note", { id: target });
        if (state.current?.kind === "note" && state.current.id === target) closeEditor();
        await refreshList();
      } catch (err) {
        setStatus(`删除失败: ${err}`);
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
      { label: "重命名", action: () => startRename(id) },
      {
        label: "提交新版本",
        action: () => void requestCommit(id, flushSave, setStatus),
      },
      { label: "查看历史版本", action: () => void openHistory(id, flushSave) },
      { label: "打开文件所在位置", action: () => void revealInFolder(path) },
      { label: "删除", danger: true, action: () => requestDelete(id) },
    ]);
  } else if (li?.dataset.filePath) {
    const path = li.dataset.filePath;
    void selectSource({ kind: "file", path });
    showContextMenu(e.clientX, e.clientY, [
      { label: "另存为笔记", action: () => void saveFileAsNote(path) },
      { label: "打开文件所在位置", action: () => void revealInFolder(path) },
      { label: "关闭文件", action: () => void closeFile(path) },
    ]);
  } else {
    showContextMenu(e.clientX, e.clientY, [{ label: "新建笔记", action: () => void newNote() }]);
  }
}

/* ---------- 应用程序启动初始化 ---------- */
window.addEventListener("DOMContentLoaded", async () => {
  // 1. 初始化主题
  applyTheme(localStorage.getItem("notebook:theme") === "dark" ? "dark" : "light");
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
    if (!state.sidebarHidden && window.innerWidth <= 860) setSidebarHidden(true);
  });

  // 4. 初始化视图切换
  for (const b of viewButtons) {
    b.addEventListener("click", () => setViewMode(b.dataset.mode as ViewMode));
  }
  setViewMode(state.viewMode);

  // 5. 初始化工具栏动作
  for (const b of toolButtons) {
    b.addEventListener("click", () => runCommand(b.dataset.cmd ?? "", toggleTablePopover));
  }

  // 6. 初始化子模块
  initDialogs();
  initTablePopover(applyTableTextToEditor, () => {
    const editorEl = getEditorElement();
    return {
      hasEditor: !editorEl.hidden && Boolean(state.current),
      text: editorEl.value.slice(editorEl.selectionStart, editorEl.selectionEnd),
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
        showEditor(opened.title, opened.content, opened.path);
        setStatus("已恢复版本（如需保留请点击「提交」记录为新版本）");
      } else {
        setStatus(`已将「${restored.title}」恢复到指定版本`);
      }
    },
    (msg) => setStatus(msg),
  );
  initEditor(() => {
    scheduleSave();
  });
  initSidebar(selectSource, setStatus, onListContextMenu);
  initShortcuts({
    onNewNote: newNote,
    onOpenFile: openFileDialog,
    onFlushSave: flushSave,
    getEditorElement,
  });

  // 7. 编辑器与预览区联动
  const editorEl = getEditorElement();
  const previewEl = getPreviewElement();
  editorEl.addEventListener("scroll", () => {
    if (state.viewMode === "split" && !state.syncing) syncScroll(editorEl, previewEl);
  });
  previewEl.addEventListener("scroll", () => {
    if (state.viewMode === "split" && !state.syncing) syncScroll(previewEl, editorEl);
  });
  previewEl.addEventListener("dblclick", () => setViewMode("edit"));

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

  // 12. 文件关联与单实例支持
  const pending = await invoke<string[]>("pending_open_files");
  const openedByPending = pending.length > 0 ? await openPaths(pending) : false;
  await listen<string[]>("open-md-files", (e) => void openPaths(e.payload));

  // 13. 加载初次数据
  await refreshList();
  if (state.notes.length > 0 && !openedByPending) {
    await selectSource({ kind: "note", id: state.notes[0].id });
  }

  // 14. 周期性轮询外部文件删除状态
  void pollFileStates();
  window.setInterval(pollFileStates, 3000);
});
