/* ---------- 分屏滚动同步（锚点模式） ----------
 * 比例同步（scrollTop / scrollHeight）在源码与渲染结果高度不一致时必然错位：
 * 一个 `# 标题` 渲染后远高于一行源码，长段落折行后又远矮于源码行数。
 * 这里改为锚点同步：渲染时每个顶层块带 data-line 源行号（见 markdown.ts），
 * 编辑区一侧用离屏镜像测量每个源行折行后的真实 y 偏移，同步时把
 * "视口顶端的源行号 + 块内进度" 在两侧互相映射，任意窗口比例下都能对齐。
 * 渲染退化（无 data-line）或超长文档时回退到比例同步。
 */
import { state } from "./state";

let editorEl: HTMLTextAreaElement | null = null;
let previewEl: HTMLDivElement | null = null;

/* 镜像测量缓存（编辑区） */
let mirrorEl: HTMLDivElement | null = null;
let lineTops: number[] = [];
let lineHeightPx = 20;
let editorCacheKey = "";
let editorDirty = true;

/* 块位置缓存（预览区） */
interface PreviewBlock {
  el: HTMLElement;
  line: number;
  top: number;
  height: number;
}
let blocks: PreviewBlock[] = [];
let hasLineInfo = false;
let previewDirty = true;
let blocksCacheKey = "";

type SyncSide = "editor" | "preview";
let activeSide: SyncSide = "editor";
let syncSuspended = false;
let resyncRaf = 0;

/* 程序化滚动锁定：防止 A->B 同步触发的 scroll 事件再回传 B->A 造成抖动 */
let lockUntil = 0;
const LOCK_MS = 80;

/* 超过该行数不做镜像测量（DOM 开销过大），回退比例同步 */
const MIRROR_MAX_LINES = 20000;

/* 连续输入时的镜像重建节流：每次编辑都全量重建镜像在长文档下开销大，
 * 打字间隙内先复用上一次的测量（偏差仅限本次编辑的影响，停止输入后自动收敛），
 * 由延后定时器强制重建并重新同步；宽度/字号等结构变化仍立即重建。 */
const MIRROR_REBUILD_MIN_MS = 300;
let mirrorRebuildTimer = 0;
let lastMirrorRebuildAt = 0;
let mirrorStructuralKey = "";

function scheduleMirrorRebuild() {
  if (mirrorRebuildTimer) return;
  mirrorRebuildTimer = window.setTimeout(() => {
    mirrorRebuildTimer = 0;
    editorDirty = true;
    scheduleResyncSplit();
  }, MIRROR_REBUILD_MIN_MS);
}

export function markEditorDirty() {
  editorDirty = true;
}

export function markPreviewDirty() {
  previewDirty = true;
}

export function markLayoutDirty() {
  editorDirty = true;
  previewDirty = true;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 二分：返回最后一个 top <= y 的下标（都不满足返回 0） */
function lastLe(arr: number[], y: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= y) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/* ---------- 编辑区：用离屏镜像测量每个源行折行后的 y 偏移 ---------- */
function ensureEditorLines(): boolean {
  const ed = editorEl!;
  const lines = ed.value.split("\n");
  if (lines.length > MIRROR_MAX_LINES) return false;

  const cs = getComputedStyle(ed);
  const structural = `${ed.clientWidth}|${cs.fontSize}|${cs.lineHeight}`;
  const key = `${structural}|${ed.value.length}`;
  if (!editorDirty && key === editorCacheKey && mirrorEl) return true;
  if (
    mirrorEl &&
    editorDirty &&
    structural === mirrorStructuralKey &&
    performance.now() - lastMirrorRebuildAt < MIRROR_REBUILD_MIN_MS
  ) {
    // 打字中：先复用旧测量，稍后强制重建（见 scheduleMirrorRebuild）
    scheduleMirrorRebuild();
    return true;
  }
  editorDirty = false;
  editorCacheKey = key;
  mirrorStructuralKey = structural;
  lastMirrorRebuildAt = performance.now();

  if (!mirrorEl) {
    mirrorEl = document.createElement("div");
    mirrorEl.style.position = "absolute";
    mirrorEl.style.top = "0";
    mirrorEl.style.left = "-99999px";
    mirrorEl.style.visibility = "hidden";
    mirrorEl.style.pointerEvents = "none";
    document.body.appendChild(mirrorEl);
  }
  // 与 textarea 逐项同步影响折行的样式；宽度取 clientWidth（已扣除滚动条）
  const s = mirrorEl.style;
  s.width = `${ed.clientWidth}px`;
  s.boxSizing = "border-box";
  s.paddingTop = cs.paddingTop;
  s.paddingRight = cs.paddingRight;
  s.paddingBottom = cs.paddingBottom;
  s.paddingLeft = cs.paddingLeft;
  s.fontFamily = cs.fontFamily;
  s.fontSize = cs.fontSize;
  s.fontWeight = cs.fontWeight;
  s.fontStyle = cs.fontStyle;
  s.letterSpacing = cs.letterSpacing;
  s.lineHeight = cs.lineHeight;
  s.tabSize = cs.tabSize;
  s.whiteSpace = "pre-wrap";
  s.overflowWrap = "break-word";
  lineHeightPx = parseFloat(cs.lineHeight) || lineHeightPx;

  mirrorEl.textContent = "";
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const d = document.createElement("div");
    d.style.minHeight = cs.lineHeight; // 空行也占一行高
    d.textContent = line;
    frag.appendChild(d);
  }
  mirrorEl.appendChild(frag);
  const kids = mirrorEl.children;
  lineTops = new Array<number>(kids.length);
  for (let i = 0; i < kids.length; i++) lineTops[i] = (kids[i] as HTMLElement).offsetTop;
  return true;
}

/* ---------- 预览区：收集带 data-line 的顶层块位置 ---------- */
function ensureBlocks() {
  const pv = previewEl!;
  const cs = getComputedStyle(pv);
  const key = [
    pv.clientWidth,
    pv.clientHeight,
    cs.fontSize,
    cs.lineHeight,
    cs.paddingTop,
    cs.paddingRight,
    cs.paddingBottom,
    cs.paddingLeft,
  ].join("|");
  if (!previewDirty && key === blocksCacheKey) return;
  previewDirty = false;
  blocksCacheKey = key;
  blocks = [];
  for (const el of Array.from(pv.children)) {
    const line = (el as HTMLElement).dataset.line;
    if (line === undefined) continue;
    blocks.push({
      el: el as HTMLElement,
      line: Number(line) || 0,
      top: (el as HTMLElement).offsetTop,
      height: (el as HTMLElement).offsetHeight,
    });
  }
  hasLineInfo = blocks.length > 0;
}

/** 找到源行 lineFloat 所在的块下标（最后一个 line <= lineFloat 的块） */
function blockOfLine(lineFloat: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].line <= lineFloat) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/* ---------- 比例同步（回退路径，行为同旧实现但加了互斥锁） ---------- */
function ratioSync(src: HTMLElement, dst: HTMLElement) {
  const max = src.scrollHeight - src.clientHeight;
  if (max <= 0) return;
  const ratio = src.scrollTop / max;
  const dstMax = dst.scrollHeight - dst.clientHeight;
  lockUntil = performance.now() + LOCK_MS;
  dst.scrollTop = ratio * dstMax;
}

/* ---------- 编辑区 -> 预览区 ---------- */
export function syncPreviewToEditor() {
  if (!editorEl || !previewEl || state.viewMode !== "split") return;
  const ed = editorEl;
  const pv = previewEl;
  if (ed.value.trim() === "") return;

  if (!ensureEditorLines()) {
    ratioSync(ed, pv);
    return;
  }
  ensureBlocks();
  if (!hasLineInfo) {
    ratioSync(ed, pv);
    return;
  }

  const padTopE = parseFloat(getComputedStyle(ed).paddingTop) || 0;
  const padTopP = parseFloat(getComputedStyle(pv).paddingTop) || 0;
  const y = ed.scrollTop + padTopE;

  // 视口顶端落在第几行（含行内进度）
  const li = lastLe(lineTops, y);
  const liTop = lineTops[li];
  const liNext = li + 1 < lineTops.length ? lineTops[li + 1] : liTop + lineHeightPx;
  const fracInLine = liNext > liTop ? clamp((y - liTop) / (liNext - liTop), 0, 1) : 0;
  const lineFloat = li + fracInLine;

  // 映射到预览块：块内按源行跨度插值，滚动平滑且块间不跳变
  let target: number;
  if (lineFloat < blocks[0].line) {
    target = blocks[0].top - padTopP;
  } else {
    const bi = blockOfLine(lineFloat);
    const b = blocks[bi];
    const nb = blocks[bi + 1];
    const bNext = nb ? nb.top : b.top + b.height;
    const lineSpan = nb ? nb.line - b.line : Math.max(1, Math.round(b.height / lineHeightPx));
    const f = clamp((lineFloat - b.line) / lineSpan, 0, 1);
    target = b.top + f * (bNext - b.top) - padTopP;
  }
  lockUntil = performance.now() + LOCK_MS;
  pv.scrollTop = clamp(target, 0, pv.scrollHeight - pv.clientHeight);
}

/* ---------- 预览区 -> 编辑区 ---------- */
function syncEditorToPreview() {
  if (!editorEl || !previewEl || state.viewMode !== "split") return;
  const ed = editorEl;
  const pv = previewEl;

  if (!ensureEditorLines()) {
    ratioSync(pv, ed);
    return;
  }
  ensureBlocks();
  if (!hasLineInfo) {
    ratioSync(pv, ed);
    return;
  }

  const padTopE = parseFloat(getComputedStyle(ed).paddingTop) || 0;
  const padTopP = parseFloat(getComputedStyle(pv).paddingTop) || 0;
  const y = pv.scrollTop + padTopP;

  let lineFloat: number;
  if (y < blocks[0].top) {
    lineFloat = blocks[0].line * clamp(y / Math.max(1, blocks[0].top - padTopP), 0, 1);
  } else {
    // 视口顶端落在哪个块（含块内进度）
    let bi = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].top <= y) {
        bi = i;
        break;
      }
    }
    const b = blocks[bi];
    const nb = blocks[bi + 1];
    const bNext = nb ? nb.top : b.top + b.height;
    const f = bNext > b.top ? clamp((y - b.top) / (bNext - b.top), 0, 1) : 0;
    const lineSpan = nb ? nb.line - b.line : Math.max(1, Math.round(b.height / lineHeightPx));
    lineFloat = b.line + f * lineSpan;
  }

  // 映射回源行，让对应行的折行顶部对齐视口 padding 位置
  lineFloat = clamp(lineFloat, 0, lineTops.length - 1);
  const li = Math.floor(lineFloat);
  const frac = lineFloat - li;
  const liTop = lineTops[li];
  const liNext = li + 1 < lineTops.length ? lineTops[li + 1] : liTop + lineHeightPx;
  const target = liTop + frac * (liNext - liTop) - padTopE;
  lockUntil = performance.now() + LOCK_MS;
  ed.scrollTop = clamp(target, 0, ed.scrollHeight - ed.clientHeight);
}

/* ---------- 事件接入 ---------- */
export function initScrollSync(editor: HTMLTextAreaElement, preview: HTMLDivElement) {
  editorEl = editor;
  previewEl = preview;

  let raf = 0;
  const schedule = (fn: () => void) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      fn();
    });
  };

  editor.addEventListener("pointerdown", () => {
    activeSide = "editor";
  });
  preview.addEventListener("pointerdown", () => {
    activeSide = "preview";
  });
  editor.addEventListener("scroll", () => {
    if (state.viewMode !== "split" || syncSuspended || performance.now() < lockUntil) return;
    activeSide = "editor";
    schedule(syncPreviewToEditor);
  });
  preview.addEventListener("scroll", () => {
    if (state.viewMode !== "split" || syncSuspended || performance.now() < lockUntil) return;
    activeSide = "preview";
    schedule(syncEditorToPreview);
  });

  preview.addEventListener(
    "load",
    () => {
      previewDirty = true;
      scheduleResyncSplit();
    },
    true,
  );
}

export function setScrollSyncSuspended(suspended: boolean) {
  syncSuspended = suspended;
}

export function resyncSplit() {
  if (state.viewMode !== "split" || syncSuspended) return;
  markLayoutDirty();
  if (activeSide === "preview") syncEditorToPreview();
  else syncPreviewToEditor();
}

export function scheduleResyncSplit() {
  if (state.viewMode !== "split" || syncSuspended || resyncRaf) return;
  resyncRaf = requestAnimationFrame(() => {
    resyncRaf = 0;
    resyncSplit();
  });
}
