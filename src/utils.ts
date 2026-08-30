// 纯工具函数与常量：格式化、路径处理、正则、布局常量。
// 从原 state.ts 拆出（state.ts 现在只承载信号化状态），与任何状态模块无依赖。

import { t } from "./i18n";
import type { ContentDensity } from "./types";

export const MD_EXT_RE = /\.(md|markdown|txt)$/i;
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 210;
export const SIDEBAR_MAX_WIDTH = 460;

export const SPLIT_RATIO_DEFAULT = 0.5;
export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;

export const LIST_PAGE_SIZE = 10;

/** 是否运行在 macOS。依据 index.html 头部内联脚本写入的 data-platform（先于样式渲染，
 *  CSS 据此隐藏自绘窗口按钮、为红绿灯留白），缺失时兜底用 navigator.platform 探测。 */
export const IS_MAC =
  document.documentElement.dataset.platform === "mac" ||
  /mac|iphone|ipad/i.test(navigator.platform);

export function readContentDensity(): ContentDensity {
  const saved = localStorage.getItem("notebook:content-density");
  return saved === "sparse" || saved === "compact" ? saved : "standard";
}

/* ---------- 通用格式化与路径辅助函数 ---------- */

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 字节数 -> 可读大小 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 相对时间描述；超过 7 天返回空串 */
export function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("time.justNow");
  if (diff < 3_600_000) return t("time.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("time.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("time.daysAgo", { count: Math.floor(diff / 86_400_000) });
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
