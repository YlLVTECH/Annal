// 信号化的全局应用状态（原可变单例重构而来）：
// - 每个字段是一个 signal：写入即通知订阅者，UI 模块自行订阅刷新，
//   不再由每个改写点手动调用 renderList / 刷新标题等。
// - 集合类（missingPaths）采用「整体替换」语义：写入新 Set 触发通知，
//   避免 deep proxy 的开销与隐藏变更。
// - 高频路径（每键输入）只触碰 dirty（Object.is 判等，重复置 true 不通知）。

import { signal } from "./signal";
import { LIST_PAGE_SIZE, readContentDensity } from "./utils";
import type { NoteMeta, OpenFile, Source } from "./types";

export const notes = signal<NoteMeta[]>([]);
export const openFiles = signal<OpenFile[]>([]);
export const current = signal<Source | null>(null);
export const dirty = signal(false);

export const contentDensity = signal(readContentDensity());
export const sidebarWidth = signal(
  Number(localStorage.getItem("annal:sidebar-width")) || 260,
);
export const sidebarHidden = signal(localStorage.getItem("annal:sidebar") === "hidden");

/** 已被外部删除的路径集合（整体替换；统一小写比较，Windows 路径不区分大小写） */
export const missingPaths = signal<ReadonlySet<string>>(new Set<string>());

export const closing = signal(false);

export const listPage = signal(1);
export const listPageSize = signal(
  Number(localStorage.getItem("annal:list-page-size")) || LIST_PAGE_SIZE,
);

/** 多选状态：列表项唯一标识（note id 或文件路径）；整体替换语义 */
export const selectedIds = signal<string[]>([]);
/** 范围选择（Shift+点击）的锚点标识 */
export const rangeAnchorId = signal<string | null>(null);

/** 全文搜索结果（null 表示未搜索，使用 notes 全量） */
export const searchResults = signal<NoteMeta[] | null>(null);
/** 当前搜索词（已 trim + 小写） */
export const query = signal("");

/* ---------- 派生访问 ---------- */

/** 当前编辑对象在磁盘上的路径 */
export function currentPathOf(src: Source | null): string {
  if (!src) return "";
  return src.kind === "note"
    ? notes.get().find((n) => n.id === src.id)?.path ?? ""
    : src.path;
}

/** 当前编辑对象所在目录（用于解析相对路径的图片） */
export function currentPathOfSource(): string {
  const p = currentPathOf(current.get());
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

/** 从 missingPaths 中移除若干路径（有实际移除才替换集合并通知） */
export function deleteMissingPaths(paths: string[]): void {
  const next = new Set(missingPaths.get());
  let changed = false;
  for (const p of paths) {
    if (next.delete(p.toLowerCase())) changed = true;
  }
  if (changed) missingPaths.set(next);
}

/** 整体替换 missingPaths（pollFileStates 的存在性检查结果） */
export function replaceMissingPaths(next: ReadonlySet<string>): void {
  const prev = missingPaths.get();
  if (next.size === prev.size && [...next].every((p) => prev.has(p))) return;
  missingPaths.set(next);
}
