// 保存协调器：编辑事件 -> 脏标记/自适应防抖 -> Tauri 写盘。
// 状态与列表 UI 通过信号联动；保存队列严格串行，旧写入不会覆盖新内容。

import { invoke } from "@tauri-apps/api/core";
import { getEditorText, resetSaveStatus, setSaveStatus, setStatus } from "../editor";
import { current, deleteMissingPaths, dirty, notes, openFiles } from "../state";
import { baseName, fmtTime, pathKey } from "../utils";
import { t } from "../i18n";
import type { NoteMeta, Source } from "../types";
import { getAutosaveDelay, isAutosaveEnabled } from "./settings";

let saveTimer: number | undefined;
let lastLocalSaveAt = 0;
let editRevision = 0;
let saveTail: Promise<void> = Promise.resolve();

export function getLastLocalSaveAt(): number {
  return lastLocalSaveAt;
}

export function getEditRevision(): number {
  return editRevision;
}

function sameSource(a: Source | null, b: Source | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "note" && b.kind === "note") return a.id === b.id;
  return a.kind === "file" && b.kind === "file" && a.path === b.path;
}

/** 单次写盘：只负责一个已捕获内容快照；所有调用由 saveTail 串行化。 */
async function writeSnapshot(src: Source, content: string, revision: number): Promise<boolean> {
  lastLocalSaveAt = Date.now();
  setSaveStatus("saving", t("status.saving"));
  try {
    if (src.kind === "note") {
      const id = src.id;
      const oldPath = notes.get().find((n) => n.id === id)?.path ?? "";
      const meta = await invoke<NoteMeta>("update_note", { id, content });
      deleteMissingPaths([meta.path, oldPath].filter(Boolean).map(pathKey));
      const next = [...notes.get()];
      const i = next.findIndex((n) => n.id === id);
      if (i >= 0) next[i] = meta;
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      notes.set(next);

      if (sameSource(current.get(), src) && editRevision === revision && getEditorText() === content) {
        dirty.set(false);
        const renamed = oldPath !== "" && pathKey(meta.path) !== pathKey(oldPath);
        setSaveStatus(
          "saved",
          renamed
            ? t("status.saved.renamed", { time: fmtTime(meta.updatedAt), name: baseName(meta.path) })
            : t("status.saved", { time: fmtTime(meta.updatedAt) }),
        );
      }
    } else {
      const updatedAt = await invoke<number>("save_md_file", { path: src.path, content });
      deleteMissingPaths([pathKey(src.path)]);
      openFiles.set(openFiles.get().map((f) => (f.path === src.path ? { ...f, content } : f)));
      if (sameSource(current.get(), src) && editRevision === revision && getEditorText() === content) {
        dirty.set(false);
        setSaveStatus("saved", t("status.saved", { time: fmtTime(updatedAt) }));
      }
    }
    if (dirty.get()) setStatus(t("status.typing"));
    return true;
  } catch (e) {
    setSaveStatus("error", t("status.error.save", { error: String(e) }));
    return false;
  }
}

/** 把当前快照排到串行保存队列末尾；返回该快照是否成功写盘。 */
export function save(): Promise<boolean> {
  const src = current.get();
  if (!dirty.get() || !src) return Promise.resolve(true);
  const content = getEditorText();
  const revision = editRevision;
  let result = false;
  const run = saveTail.then(async () => {
    result = await writeSnapshot(src, content, revision);
  });
  saveTail = run.catch(() => {});
  return run.then(() => result);
}

/** 切换/删除/关闭前的保存闸门：持续排队到当前编辑 revision 已完整落盘。 */
export async function flushSave(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  while (dirty.get() && current.get()) {
    const revision = editRevision;
    if (!(await save())) return false;
    await saveTail;
    if (!dirty.get()) return true;
    if (editRevision === revision) return false;
  }
  resetSaveStatus();
  return true;
}

const ADAPTIVE_MIN_MS = 300;
const ADAPTIVE_MAX_MS = 4000;
const ADAPTIVE_WINDOW = 5;
const inputTimes: number[] = [];

function adaptiveDelay(base: number): number {
  const now = performance.now();
  inputTimes.push(now);
  if (inputTimes.length > ADAPTIVE_WINDOW) inputTimes.shift();
  if (inputTimes.length < 2) return Math.min(ADAPTIVE_MAX_MS, Math.max(ADAPTIVE_MIN_MS, base));
  const gaps = inputTimes.slice(1).map((time, i) => time - inputTimes[i]);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  let factor = 1;
  if (avg < 200) factor = 4;
  else if (avg < 600) factor = 2;
  else if (avg > 2000) factor = 0.5;
  return Math.min(ADAPTIVE_MAX_MS, Math.max(ADAPTIVE_MIN_MS, Math.round(base * factor)));
}

export function notifyDocumentEdited() {
  editRevision++;
  dirty.set(true);
  setStatus(t("status.typing"));
  window.clearTimeout(saveTimer);
  if (!isAutosaveEnabled()) return;
  saveTimer = window.setTimeout(() => void save(), adaptiveDelay(getAutosaveDelay()));
}

export function resetInputPace(): void {
  inputTimes.length = 0;
}

