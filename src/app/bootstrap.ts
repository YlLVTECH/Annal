// 应用组合根：按依赖顺序初始化各小协调器与模块。
// main.ts 只保留 DOMContentLoaded -> bootstrapApp，不再承载业务逻辑。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { requestCommit, initDialogs } from "../dialogs";
import {
  applyTableTextToEditor,
  canEditCurrent,
  editorHasFocus,
  flashHeadingAtLine,
  getEditorView,
  getSelectedText,
  runCommand,
  setLineNumbersEnabled,
  setStatus,
  setViewMode,
} from "../editor";
import { initHistory } from "../history";
import { openFindPanel } from "../findReplace";
import { initI18n, applyI18nToDocument, t } from "../i18n";
import { initOutline, refreshOutline } from "../outline";
import { getPreview, initPipeline, openInEditor } from "../pipeline";
import { initScrollSync } from "../documentPosition";
import { initShortcuts } from "../shortcuts";
import { initShortcutSettings } from "../shortcutSettings";
import { initSidebar } from "../sidebar";
import { closeTablePopover, initTablePopover, toggleTablePopover } from "../table";
import { current, deleteMissingPaths, notes } from "../state";
import { pathKey } from "../utils";
import type { Note } from "../types";
import { onListContextMenu } from "./contextMenu";
import { initFileSyncCoordinator } from "./fileSync";
import {
  batchDeleteSelected,
  batchExportSelected,
  batchImportSelected,
  newNote,
  openFileDialog,
  openPaths,
  refreshNotes,
  requestDelete,
  saveFileAsNote,
  selectSource,
} from "./notes";
import { flushSave } from "./save";
import { applySettings, initSettings } from "./settings";
import { initTheme } from "./theme";
import { initWindowCoordinator } from "./window";

export async function bootstrapApp(): Promise<void> {
  // 1. 基础设置与 i18n（Editor 初始化前先把 CSS/主题状态落地）
  await initI18n();
  applyI18nToDocument();
  initTheme();
  initDialogs();

  // 2. 编辑管线（Editor -> Model -> Preview）及其消费者
  initPipeline(refreshOutline);
  setLineNumbersEnabled(localStorage.getItem("notebook:line-numbers") !== "0");
  initScrollSync({ getEditorView, getPreview });
  initOutline({ getEditorView, getPreview, flashHeading: flashHeadingAtLine });

  // 3. 设置、侧栏与工具
  applySettings();
  initSettings();
  initSidebar({
    onSelect: selectSource,
    onStatus: setStatus,
    onContextMenu: onListContextMenu,
    onRenameSuccess: (_id, updated) => {
      setStatus(t("status.renameSuccess", { title: updated.title }));
    },
    onBatchDelete: batchDeleteSelected,
    onBatchImport: batchImportSelected,
    onBatchExport: batchExportSelected,
  });

  initTablePopover(applyTableTextToEditor, () => ({
    hasEditor: canEditCurrent(),
    text: getSelectedText(),
  }));
  initShortcuts({
    onNewNote: newNote,
    onOpenFile: openFileDialog,
    onFlushSave: flushSave,
    editorHasFocus,
    onOpenFind: () => openFindPanel(getEditorView(), "query"),
  });
  initShortcutSettings();

  const viewButtons = document.querySelectorAll<HTMLButtonElement>(".view-btn");
  for (const b of viewButtons) b.addEventListener("click", () => setViewMode(b.dataset.mode));
  const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool-btn");
  for (const b of toolButtons) {
    b.addEventListener("click", () => runCommand(b.dataset.cmd ?? "", toggleTablePopover));
  }

  // 4. 头部动作与窗口生命周期
  document.querySelector<HTMLButtonElement>("#commit-note-btn")!.addEventListener("click", () =>
    void requestCommit(undefined, flushSave, setStatus),
  );
  document.querySelector<HTMLButtonElement>("#save-as-note-btn")!.addEventListener("click", () =>
    void saveFileAsNote(),
  );
  document.querySelector<HTMLButtonElement>("#delete-note-btn")!.addEventListener("click", () => requestDelete());
  document.querySelector<HTMLButtonElement>("#open-file-btn")!.addEventListener("click", openFileDialog);
  document.querySelector<HTMLButtonElement>("#new-note-btn")!.addEventListener("click", newNote);
  initWindowCoordinator();

  // 历史模块延后到首帧之后绑定，缩短启动关键路径
  window.setTimeout(() => {
    initHistory(
      async (restored, isCurrent) => {
        const next = [...notes.get()];
        const i = next.findIndex((n) => n.id === restored.id);
        if (i >= 0) next[i] = restored;
        next.sort((a, b) => b.updatedAt - a.updatedAt);
        notes.set(next);
        deleteMissingPaths([pathKey(restored.path)]);
        if (isCurrent) {
          const opened = await invoke<Note>("get_note", { id: restored.id });
          openInEditor(opened.title, opened.content, opened.path);
          setStatus(t("status.versionRestored"));
        } else {
          setStatus(t("status.versionRestoredOther", { title: restored.title }));
        }
      },
      setStatus,
    );
  }, 0);

  // 5. 拖拽/文件关联与初始数据
  getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") void openPaths(event.payload.paths);
  });

  const pending = await invoke<string[]>("pending_open_files");
  const openedByPending = pending.length > 0 ? await openPaths(pending) : false;
  await listen<string[]>("open-md-files", (e) => void openPaths(e.payload));

  await refreshNotes();
  if (notes.get().length > 0 && !openedByPending) {
    await selectSource({ kind: "note", id: notes.get()[0].id });
  }

  initFileSyncCoordinator();

  // 空白关闭流程的当前状态由 current 信号承载；避免残留表格弹层
  current.subscribe((src) => {
    if (!src) closeTablePopover();
  });
}
