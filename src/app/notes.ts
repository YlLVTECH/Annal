// 笔记/外部文件操作协调器：选择、新建、打开、关闭、删除、另存为、批量导入导出。
// 状态改写统一走信号；侧栏/编辑器标题/缺失徽标由订阅者自动刷新。

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openConfirm } from "../dialogs";
import { closeTablePopover } from "../table";
import { setStatus } from "../editor";
import { closeActiveEditor, openInEditor } from "../pipeline";
import { clearSelection } from "../sidebar";
import { current, missingPaths, notes, openFiles } from "../state";
import { baseName, dirOfPath, MD_EXT_RE, pathKey } from "../utils";
import { t } from "../i18n";
import type { Note, NoteMeta, OpenFile, Source } from "../types";
import { flushSave, getEditRevision, resetInputPace } from "./save";

export async function refreshNotes(): Promise<void> {
  notes.set(await invoke<NoteMeta[]>("list_notes"));
}

let selectGeneration = 0;

export async function selectSource(src: Source): Promise<boolean> {
  // 每次点击（包括点击当前项取消待加载选择）都先使旧请求失效。
  const generation = ++selectGeneration;
  closeTablePopover();
  const cur = current.get();
  const same =
    cur !== null &&
    ((src.kind === "note" && cur.kind === "note" && src.id === cur.id) ||
      (src.kind === "file" && cur.kind === "file" && src.path === cur.path));
  if (same) return true;
  if (!(await flushSave()) || generation !== selectGeneration) return false;
  resetInputPace();
  const revisionAfterFlush = getEditRevision();

  if (src.kind === "note") {
    const note = await invoke<Note>("get_note", { id: src.id });
    if (generation !== selectGeneration) return false;
    // 加载期间用户仍可编辑旧文档：先把这些新输入冲刷，再提交切换。
    if (getEditRevision() !== revisionAfterFlush && !(await flushSave())) return false;
    if (generation !== selectGeneration) return false;
    current.set(src);
    openInEditor(note.title, note.content, note.path);
    return true;
  } else {
    const file = openFiles.get().find((f) => f.path === src.path);
    if (!file || generation !== selectGeneration) return false;
    if (getEditRevision() !== revisionAfterFlush && !(await flushSave())) return false;
    if (generation !== selectGeneration) return false;
    current.set(src);
    openInEditor(file.name, file.content, file.path);
    return true;
  }
}

export async function batchDeleteSelected(ids: string[]) {
  // 拆出笔记 id 与外部文件路径（选中集里这两类可能混合）
  const noteIds = ids.filter((id) => notes.get().some((n) => n.id === id));
  const filePaths = ids.filter((id) => openFiles.get().some((f) => f.path === id));
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
        if (!(await flushSave())) return;
        if (noteIds.length > 0) {
          await invoke<number>("delete_selected_notes", { ids: noteIds });
          const cur = current.get();
          if (cur?.kind === "note" && noteIds.includes(cur.id)) {
            current.set(null);
            closeActiveEditor();
          }
        }
        for (const p of filePaths) {
          await closeFile(p, true);
        }
        clearSelection();
        await refreshNotes();
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

export async function batchExportSelected(ids: string[]) {
  const noteIds = ids.filter((id) => notes.get().some((n) => n.id === id));
  const filePaths = ids.filter((id) => openFiles.get().some((f) => f.path === id));
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

export async function batchImportSelected(ids: string[]) {
  const filePaths = ids.filter((id) => openFiles.get().some((f) => f.path === id));
  if (filePaths.length === 0) {
    setStatus(t("status.batch.noImportable"));
    return;
  }
  const noteIds = ids.filter((id) => !filePaths.includes(id));
  if (noteIds.length > 0) {
    setStatus(t("status.batch.noImportable"));
    return;
  }
  try {
    const results: NoteMeta[] = [];
    for (const path of filePaths) {
      const f = openFiles.get().find((f) => f.path === path);
      if (!f) continue;
      const dir = dirOfPath(f.path);
      const stem = baseName(f.path).replace(/\.(md|markdown|txt)$/i, "") || t("dialog.untitledNote");
      const sep = dir.includes("/") ? "/" : "\\";
      const defaultPath = dir ? dir + sep + stem + ".md" : stem + ".md";
      const picked = await saveDialog({
        title: t("dialog.saveAs"),
        defaultPath,
        filters: [{ name: t("dialog.filter.markdown"), extensions: ["md", "markdown"] }],
      });
      if (!picked) continue;
      let dst = picked;
      if (!/\.(md|markdown)$/i.test(dst)) dst += ".md";
      const noteAtPath = notes.get().find((n) => pathKey(n.path) === pathKey(dst));
      if (noteAtPath) {
        setStatus(t("status.saveAsConflict", { title: noteAtPath.title }));
        continue;
      }
      const [exists] = await invoke<boolean[]>("files_exist", { paths: [dst] });
      let overwrite = false;
      if (exists) {
        const ok = confirm(t("confirm.text.overwrite", { path: dst }));
        if (!ok) continue;
        overwrite = true;
      }
      const meta = await invoke<NoteMeta>("save_file_as_note", {
        source: f.path,
        target: dst,
        overwrite,
      });
      results.push(meta);
      await closeFile(f.path);
    }
    await refreshNotes();
    if (results.length > 0) {
      setStatus(t("status.batch.importDone", { count: results.length }));
    }
    clearSelection();
  } catch (err) {
    setStatus(t("status.batch.importFail", { error: String(err) }));
  }
}

/* ---------- 新建 / 打开 / 关闭 / 删除 / 另存为 ---------- */
export async function newNote() {
  if (!(await flushSave())) return;
  const picked = await saveDialog({
    title: t("dialog.newNote"),
    defaultPath: t("dialog.untitledNote") + ".md",
    filters: [{ name: t("dialog.filter.markdown"), extensions: ["md", "markdown"] }],
  });
  if (!picked) return;
  let path = picked;
  if (!/\.(md|markdown)$/i.test(path)) path += ".md";

  const opened = openFiles.get().find((f) => pathKey(f.path) === pathKey(path));
  if (opened) {
    await selectSource({ kind: "file", path: opened.path });
    return;
  }
  try {
    const meta = await invoke<NoteMeta>("create_note", { path });
    await refreshNotes();
    await selectSource({ kind: "note", id: meta.id });
    const chosenStem = path.replace(/\.(md|markdown)$/i, "");
    if (meta.title !== chosenStem) {
      setStatus(t("status.newNoteCreated", { title: meta.title }));
    }
  } catch (err) {
    setStatus(t("status.newNoteFail", { error: String(err) }));
  }
}

export async function openPaths(paths: string[]): Promise<boolean> {
  const targets = paths.filter((p) => MD_EXT_RE.test(p));
  if (targets.length === 0) return false;
  if (!(await flushSave())) return false;

  const toSelect: Source[] = [];
  const fresh: OpenFile[] = [];
  const errors: string[] = [];
  for (const path of targets) {
    const existingFile = openFiles.get().find((f) => pathKey(f.path) === pathKey(path));
    if (existingFile) {
      toSelect.push({ kind: "file", path });
      continue;
    }
    const existingNote = notes.get().find((n) => pathKey(n.path) === pathKey(path));
    if (existingNote) {
      toSelect.push({ kind: "note", id: existingNote.id });
      continue;
    }
    try {
      const f = await invoke<OpenFile>("open_md_file", { path });
      fresh.push(f);
      toSelect.push({ kind: "file", path });
    } catch (e) {
      errors.push(`${path}: ${e}`);
    }
  }
  if (fresh.length > 0) {
    openFiles.set([...openFiles.get(), ...fresh]);
  }
  let selected = false;
  if (toSelect.length > 0) {
    selected = await selectSource(toSelect[0]);
    if (selected && fresh.length > 1) setStatus(t("status.filesOpened", { count: fresh.length }));
  }
  if (errors.length > 0) setStatus(t("status.openFail", { error: errors.join("；") }));
  return selected;
}

export async function openFileDialog() {
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

export async function revealInFolder(path: string) {
  if (!path) return;
  try {
    await invoke("reveal_in_folder", { path });
  } catch (err) {
    setStatus(t("status.revealFail", { error: String(err) }));
  }
}

export async function closeFile(path?: string, skipSave = false): Promise<boolean> {
  const cur = current.get();
  const target = path ?? (cur?.kind === "file" ? cur.path : null);
  if (!target) return true;
  if (!skipSave && !(await flushSave())) return false;
  openFiles.set(openFiles.get().filter((f) => f.path !== target));
  const afterFlush = current.get();
  if (afterFlush?.kind === "file" && afterFlush.path === target) {
    current.set(null);
    closeActiveEditor();
  }
  return true;
}

export async function saveFileAsNote(path?: string) {
  const cur = current.get();
  const target = path ?? (cur?.kind === "file" ? cur.path : null);
  if (!target) return;
  if (!(await flushSave())) return;

  const f = openFiles.get().find((f) => f.path === target);
  if (!f) return;
  if (missingPaths.get().has(pathKey(target))) {
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

  const noteAtPath = notes.get().find((n) => pathKey(n.path) === pathKey(dst));
  if (noteAtPath) {
    setStatus(t("status.saveAsConflict", { title: noteAtPath.title }));
    return;
  }
  const otherOpen = openFiles.get().find(
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
        openFiles.set(openFiles.get().filter((x) => x.path !== otherOpen.path));
        const cur = current.get();
        if (cur?.kind === "file" && cur.path === otherOpen.path) {
          current.set(null);
          closeActiveEditor();
        }
      }
      await refreshNotes();
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

export function requestDelete(id?: string) {
  const cur = current.get();
  const target = id ?? (cur?.kind === "note" ? cur.id : null);
  if (!target) {
    if (cur?.kind === "file") void closeFile();
    return;
  }
  openConfirm({
    title: t("confirm.title.deleteNote"),
    text: t("confirm.text.deleteNote"),
    okLabel: t("confirm.ok.delete"),
    danger: true,
    action: async () => {
      try {
        const cur = current.get();
        if (cur?.kind === "note" && cur.id === target && !(await flushSave())) return;
        await invoke("delete_note", { id: target });
        const afterDelete = current.get();
        if (afterDelete?.kind === "note" && afterDelete.id === target) {
          current.set(null);
          closeActiveEditor();
        }
        await refreshNotes();
      } catch (err) {
        setStatus(t("status.deleteFail", { error: String(err) }));
      }
    },
  });
}

export async function togglePin(id: string) {
  try {
    const updated = await invoke<NoteMeta>("toggle_pin", { id });
    const next = [...notes.get()];
    const i = next.findIndex((n) => n.id === id);
    if (i >= 0) {
      next[i] = updated;
      next.sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        return b.updatedAt - a.updatedAt;
      });
      notes.set(next);
    }
    setStatus(updated.pinned ? t("status.pinSuccess") : t("status.unpinSuccess"));
  } catch (err) {
    setStatus(t("status.pinFail", { error: String(err) }));
  }
}

