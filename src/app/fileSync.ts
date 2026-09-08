// 外部文件状态协调器：目录 watcher 同步 + 外部改名/删除状态刷新。
// notes/openFiles/missingPaths 都通过信号发布结果，侧栏/编辑器自行联动。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setStatus } from "../editor";
import {
  missingPaths,
  notes,
  openFiles,
  replaceMissingPaths,
} from "../state";
import { dirOfPath, pathKey } from "../utils";
import { t } from "../i18n";
import type { FsSyncResult } from "../types";
import { getLastLocalSaveAt } from "./save";

let lastWatchKey = "";
let pollRunning = false;
let pollQueued = false;
const renameHints = new Set<string>();
/** 上次信号触发轮询时的路径集合签名：自动保存只改内容/时间戳，路径集合不变则跳过 */
let lastPathsKey = "";

/** 笔记与打开文件的路径集合签名（去重、小写、排序） */
function currentPathsKey(): string {
  const paths = [...notes.get().map((n) => n.path), ...openFiles.get().map((f) => f.path)].filter(Boolean);
  return [...new Set(paths.map(pathKey))].sort().join("|");
}

/** 信号驱动的轮询入口：路径集合变化才发起全量轮询（新建/删除/改名/开关文件）。
 *  每次自动保存都会 notes.set（updatedAt 变化），不过滤就会对全部笔记做一次
 *  存在性 stat，笔记数量多时保存链路被无谓放大。 */
function pollOnSignalChange(): void {
  const key = currentPathsKey();
  if (key === lastPathsKey) return;
  lastPathsKey = key;
  void pollFileStates();
}

/** 目录集合变化时同步 notify 监听（路径集相同则跳过，不发起 IPC） */
function syncWatchPaths(paths: string[]) {
  const dirs = [...new Set(paths.map((p) => dirOfPath(p)).filter((d) => d.length > 0))].sort();
  const key = dirs.join("|");
  if (key === lastWatchKey) return;
  lastWatchKey = key;
  void invoke("watch_note_dirs", { paths }).catch(() => {});
}

export async function pollFileStates(): Promise<void> {
  if (document.hidden) return;
  if (pollRunning) {
    pollQueued = true;
    return;
  }
  pollRunning = true;
  try {
    do {
      pollQueued = false;
      await runFileStatePoll();
    } while (pollQueued && !document.hidden);
  } finally {
    pollRunning = false;
  }
}

async function runFileStatePoll(): Promise<void> {
  const paths = [...notes.get().map((n) => n.path), ...openFiles.get().map((f) => f.path)].filter(Boolean);
  syncWatchPaths(paths);
  if (paths.length === 0) {
    if (missingPaths.get().size > 0) missingPaths.set(new Set());
    return;
  }
  try {
    const res = await invoke<FsSyncResult>("sync_fs_state", { paths });
    // 路径集合在 IPC 往返期间已变化：丢弃旧响应并排队重查，避免覆盖新状态。
    const livePaths = [...notes.get().map((n) => n.path), ...openFiles.get().map((f) => f.path)].filter(Boolean);
    if (paths.length !== livePaths.length || paths.some((p, i) => pathKey(p) !== pathKey(livePaths[i]))) {
      pollQueued = true;
      return;
    }
    if (res.changed.length > 0) {
      const changedTitles: string[] = [];
      const next = [...notes.get()];
      let metadataChanged = false;
      for (const meta of res.changed) {
        const i = next.findIndex((n) => n.id === meta.id);
        if (i < 0) continue;
        if (next[i].title !== meta.title) changedTitles.push(meta.id);
        if (JSON.stringify(next[i]) !== JSON.stringify(meta)) metadataChanged = true;
        next[i] = meta;
      }
      if (metadataChanged) {
        next.sort((a, b) => b.updatedAt - a.updatedAt);
        notes.set(next);
      }
      for (const id of changedTitles) {
        if (renameHints.has(id)) continue;
        renameHints.add(id);
        const n = next.find((x) => x.id === id);
        if (n) setStatus(t("status.externalRename", { title: n.title }));
      }
    }
    replaceMissingPaths(new Set(paths.filter((_, i) => !res.exists[i]).map(pathKey)));
  } catch {
    // 事件同步/兜底轮询失败静默，等待下次
  }
}
export function initFileSyncCoordinator(): void {
  void pollFileStates();
  void listen("fs-notes-changed", () => {
    // 自身自动保存也会触发监听事件：短时间内跳过，避免自触发往返
    if (Date.now() - getLastLocalSaveAt() > 1500) void pollFileStates();
  });
  window.setInterval(pollFileStates, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pollFileStates();
  });

  // 路径集合变化即同步 watcher 并全量轮询（纯保存更新被签名过滤跳过）
  lastPathsKey = currentPathsKey();
  notes.subscribe(pollOnSignalChange);
  openFiles.subscribe(pollOnSignalChange);
}
