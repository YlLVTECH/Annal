import { handleDialogEscape } from "./dialogs";
import { canEditCurrent, isComposing, redo, runCommand, setViewMode, undo } from "./editor";
import { closeHistory, isHistoryCompareOn, isHistoryOpen, toggleCompare } from "./history";
import { setSidebarHidden } from "./sidebar";
import { state } from "./state";
import { closeTablePopover, isTablePopoverOpen } from "./table";

export interface ShortcutHandlers {
  onNewNote: () => void;
  onOpenFile: () => void;
  onFlushSave: () => Promise<void>;
  getEditorElement: () => HTMLTextAreaElement;
}

export function initShortcuts(handlers: ShortcutHandlers) {
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (mod && k === "n") {
      e.preventDefault();
      handlers.onNewNote();
      return;
    }
    if (mod && k === "o") {
      e.preventDefault();
      handlers.onOpenFile();
      return;
    }
    if (mod && k === "s") {
      e.preventDefault();
      void handlers.onFlushSave();
      return;
    }
    if (mod && e.key === "\\") {
      e.preventDefault();
      setSidebarHidden(!state.sidebarHidden);
      return;
    }

    if (e.key === "Escape") {
      // 分层退出：表格弹层 → 确认/提交/右键弹层 → 历史对比/历史弹层
      if (isTablePopoverOpen()) {
        closeTablePopover();
        return;
      }
      if (handleDialogEscape()) {
        return;
      }
      if (isHistoryOpen()) {
        if (isHistoryCompareOn()) {
          void toggleCompare();
          return;
        }
        closeHistory();
        return;
      }
    }

    if (mod && e.shiftKey && k === "p") {
      if (isComposing()) return;
      e.preventDefault();
      setViewMode("preview");
      return;
    }
    if (mod && e.shiftKey && k === "e") {
      if (isComposing()) return;
      e.preventDefault();
      setViewMode("split");
      return;
    }
    if (mod && !e.shiftKey && k === "e") {
      if (isComposing()) return;
      e.preventDefault();
      setViewMode("edit");
      return;
    }

    const editorEl = handlers.getEditorElement();
    if (document.activeElement !== editorEl || !canEditCurrent()) return;

    if (mod && !isComposing() && k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (mod && !isComposing() && (k === "y" || (k === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (mod && k === "b") {
      if (isComposing()) return;
      e.preventDefault();
      runCommand("bold");
    } else if (mod && k === "i") {
      if (isComposing()) return;
      e.preventDefault();
      runCommand("italic");
    } else if (mod && k === "k") {
      if (isComposing()) return;
      e.preventDefault();
      runCommand("link");
    }
  });
}
