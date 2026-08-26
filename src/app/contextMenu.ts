// 上下文菜单协调器：只做菜单项组装与动作分发，业务操作在 notes.ts。

import { requestCommit, showContextMenu } from "../dialogs";
import { openHistory } from "../history";
import { setStatus } from "../editor";
import { startRename } from "../sidebar";
import { notes } from "../state";
import { t } from "../i18n";
import { flushSave } from "./save";
import {
  closeFile,
  newNote,
  requestDelete,
  revealInFolder,
  saveFileAsNote,
  selectSource,
  togglePin,
} from "./notes";

export function onListContextMenu(e: MouseEvent) {
  e.preventDefault();
  const li = (e.target as HTMLElement).closest<HTMLLIElement>(".note-item");

  if (li?.dataset.noteId) {
    const id = li.dataset.noteId;
    const meta = notes.get().find((n) => n.id === id);
    const path = meta?.path ?? "";
    void selectSource({ kind: "note", id });
    showContextMenu(e.clientX, e.clientY, [
      { label: t("contextMenu.rename"), action: () => startRename(id) },
      { label: t("contextMenu.commit"), action: () => void requestCommit(id, flushSave, setStatus) },
      { label: t("contextMenu.history"), action: () => void openHistory(id, flushSave) },
      { label: t("contextMenu.reveal"), action: () => void revealInFolder(path) },
      {
        label: meta?.pinned ? t("contextMenu.unpin") : t("contextMenu.pin"),
        action: () => void togglePin(id),
      },
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
    showContextMenu(e.clientX, e.clientY, [
      { label: t("contextMenu.newNote"), action: () => void newNote() },
    ]);
  }
}
