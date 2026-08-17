import { parseViewMode } from "./types";
import type { ContentDensity, NoteMeta, OpenFile, Source } from "./types";

export const MD_EXT_RE = /\.(md|markdown|txt)$/i;
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 210;
export const SIDEBAR_MAX_WIDTH = 460;

export const SPLIT_RATIO_DEFAULT = 0.5;
export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;

export const LIST_PAGE_SIZE = 10;

export function readContentDensity(): ContentDensity {
  const saved = localStorage.getItem("notebook:content-density");
  return saved === "sparse" || saved === "compact" ? saved : "standard";
}

/** 全局状态管理单例 */
export const state = {
  notes: [] as NoteMeta[],
  openFiles: [] as OpenFile[],
  current: null as Source | null,
  dirty: false,
  query: "",
  viewMode: parseViewMode(localStorage.getItem("notebook:view")),
  contentDensity: readContentDensity(),
  focusMode: localStorage.getItem("notebook:focus") === "1",
  sidebarWidth: Number(localStorage.getItem("notebook:sidebar-width")) || SIDEBAR_DEFAULT_WIDTH,
  sidebarHidden: localStorage.getItem("notebook:sidebar") === "hidden",
  splitRatio: Number(localStorage.getItem("notebook:split-ratio")) || SPLIT_RATIO_DEFAULT,
  /** 已被外部删除的路径（统一小写比较，Windows 路径不区分大小写） */
  missingPaths: new Set<string>(),
  closing: false,
  listPage: 1,
  listPageSize:
    Number(localStorage.getItem("notebook:list-page-size")) || LIST_PAGE_SIZE,
  /** 多选状态：列表项唯一标识（note id 或文件路径） */
  selectedIds: [] as string[],
  /** 范围选择（Shift+点击）的锚点标识 */
  rangeAnchorId: null as string | null,
};

/* ---------- 通用格式化与路径辅助函数 ---------- */

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 字节数 → 可读大小 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 相对时间描述；超过 7 天返回空串 */
export function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return "";
}

/** 统一路径比较键（小写） */
export function pathKey(p: string): string {
  return p.toLowerCase();
}

/** 取路径中的文件名部分 */
export function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

/** 路径所在目录（用于解析相对路径）；路径为空返回空串 */
export function dirOfPath(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

/** 当前编辑对象在磁盘上的路径 */
export function currentPathOf(src: Source | null): string {
  if (!src) return "";
  return src.kind === "note"
    ? state.notes.find((n) => n.id === src.id)?.path ?? ""
    : src.path;
}

/** 当前编辑对象所在目录（用于解析相对路径的图片） */
export function currentPathOfSource(): string {
  return dirOfPath(currentPathOf(state.current));
}
