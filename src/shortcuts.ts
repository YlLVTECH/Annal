import { handleDialogEscape } from "./dialogs";
import { canEditCurrent, isComposing, runCommand, setViewMode } from "./editor";
import { closeHistory, isHistoryCompareOn, isHistoryOpen, toggleCompare } from "./history";
import { setSidebarHidden } from "./sidebar";
import { state } from "./state";
import { closeTablePopover, isTablePopoverOpen } from "./table";

export interface ShortcutHandlers {
  onNewNote: () => void;
  onOpenFile: () => void;
  onFlushSave: () => Promise<void>;
  /** CodeMirror 编辑器是否获得焦点（决定 Ctrl+B/I/K 是否作用于编辑器） */
  editorHasFocus: () => boolean;
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

    const editorActive = handlers.editorHasFocus();
    if (!editorActive || !canEditCurrent()) return;

    // 撤销/重做（Ctrl+Z/Y）：交给 CodeMirror 内置历史，全局必须放行；
    // 视图切换键位已在上方处理。这里补充 CM 默认键位未绑定的格式快捷键。
    if (mod && (k === "z" || k === "y")) {
      return;
    }

    if (mod && !isComposing() && k === "b") {
      e.preventDefault();
      runCommand("bold");
    } else if (mod && !isComposing() && k === "i") {
      e.preventDefault();
      runCommand("italic");
    } else if (mod && k === "k") {
      e.preventDefault();
      runCommand("link");
    }
  });
}
