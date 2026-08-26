// 虚拟化预览：Markdown 块只渲染视口附近的一小部分，离屏块不建 DOM、不高亮代码。
// - 布局：每个块绝对定位在撑层（spacer）内，top 由累计高度维护；
//   块高度在挂载后用 offsetHeight 实测，未挂载区域用估算值。
// - 增量：模型只变更受影响的块（见 markdownModel.ts），这里只重建挂载中的变更块。
// - 图片：加载完成前预留占位高度，加载后记录宽高比并重测所在块，
//   布局只从该块向下累计，不影响上方内容（无累积漂移）。

import {
  getBlocks,
  getDocumentLineCount,
  highlightBlock,
  isModelEmpty,
  renderBlockHtml,
  setImgAspect,
  type MdBlock,
} from "./markdownModel";
import { t } from "./i18n";

/** 视口外上下各多渲染的缓冲像素（提前渲染，滚动更稳） */
const PREVIEW_BUFFER = 1600;

export interface PreviewApi {
  /** 滚动容器元素（#preview） */
  element: HTMLElement;
  /** 内容是否为可见模式（编辑模式隐藏时不渲染） */
  setVisible(visible: boolean): void;
  /** 模型内容/结构变化后刷新；changedIds 为内容变化的块（挂载中的会被重建） */
  refresh(changedIds?: Set<number>): void;
  /** 切换文档时重置：卸载全部块并回到顶部（新文档的块 id 从 1 重排，旧挂载表不可复用） */
  reset(): void;
  /** 布局可能失效（字号/密度/宽度变化）时强制重排 */
  markLayoutDirty(): void;
  /** 行号（浮点，含块内进度）→ 预览内容坐标 y */
  mapLineToY(lineFloat: number): number;
  /** 大纲跳转：闪烁高亮包含该行的块（等待下一轮渲染后挂载完成再执行） */
  flashAtLine(lineFloat: number): void;
  /** 预览内容坐标 y → 行号（浮点） */
  mapYToLine(y: number): number;
  /** 当前总内容高度 */
  totalHeight(): number;
}

export function initVirtualPreview(container: HTMLElement, onLayoutChanged?: () => void): PreviewApi {
  const spacer = document.createElement("div");
  spacer.className = "pv-spacer";
  container.appendChild(spacer);

  const emptyEl = document.createElement("div");
  emptyEl.className = "preview-empty";
  emptyEl.textContent = t("preview.empty");
  container.appendChild(emptyEl);

  /* 挂载块：blockId -> { el, version, height } */
  const mounted = new Map<number, { el: HTMLElement; height: number }>();

  let padTop = 0;
  let lineHeight = 27;
  let visible = false;
  let headLineCount = 0;
  let contentBottom = 0;
  let tailStartLine = 0;
  let tailLineCount = 0;
  let total = 0;
  let renderRaf = 0;
  let layoutDirty = true;
  let measureDirty = false;
  /** 待重建的块 id（内容变更后挂载中的块需要替换 DOM） */
  let rebuildSet = new Set<number>();

  /* ---------- 布局 ---------- */
  function layout() {
    const list = getBlocks();
    headLineCount = list.length > 0 ? list[0].startLine : 0;
    let top = headLineCount * lineHeight;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      b.top = top;
      top += b.height;
      if (i + 1 < list.length) {
        const gapLines = Math.max(0, list[i + 1].startLine - b.endLine - 1);
        top += gapLines * lineHeight;
      }
    }
    contentBottom = top;
    tailStartLine = list.length > 0 ? list[list.length - 1].endLine + 1 : 0;
    tailLineCount = Math.max(0, getDocumentLineCount() - tailStartLine);
    total = contentBottom + tailLineCount * lineHeight;
    spacer.style.height = `${total}px`;
    layoutDirty = false;
  }

  /* ---------- 窗口计算 ---------- */
  function visibleRange(): [number, number] {
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight;
    const contentTop = scrollTop - padTop;
    return [contentTop - PREVIEW_BUFFER, contentTop + viewH + PREVIEW_BUFFER];
  }

  function firstVisibleBlock(list: MdBlock[], start: number): number {
    // 第一个 top + height > start 的块
    let lo = 0;
    let hi = list.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].top + list[mid].height <= start) {
        ans = mid + 1;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return Math.min(ans, Math.max(0, list.length - 1));
  }

  /* ---------- 渲染视口 ---------- */
  function render() {
    renderRaf = 0;
    if (!visible) return;
    if (layoutDirty) layout();

    const empty = isModelEmpty();
    emptyEl.hidden = !empty;
    spacer.style.display = empty && getDocumentLineCount() === 1 ? "none" : "";
    if (empty) {
      unmountAll();
      return;
    }

    const list = getBlocks();
    if (list.length === 0) return;
    const byId = new Map<number, MdBlock>();
    for (const b of list) byId.set(b.id, b);
    const [winStart, winEnd] = visibleRange();
    const first = firstVisibleBlock(list, winStart);
    let last = first;
    while (last + 1 < list.length && list[last + 1].top <= winEnd) last++;

    // 卸载窗口外的块 + 内容已变更的挂载块（先摘除，交给下面的挂载逻辑重建）
    for (const [id, m] of mounted) {
      const b = byId.get(id);
      if (
        !b ||
        b.top + b.height <= winStart ||
        b.top > winEnd ||
        rebuildSet.has(id)
      ) {
        m.el.remove();
        mounted.delete(id);
      }
    }
    rebuildSet.clear();

    // 挂载窗口内的块
    const frag = document.createDocumentFragment();
    const toAppend: HTMLElement[] = [];
    const toMeasure = new Map<number, { el: HTMLElement; b: MdBlock }>();
    for (let i = first; i <= last; i++) {
      const b = list[i];
      if (mounted.has(b.id)) continue;
      const el = mountBlock(b);
      frag.appendChild(el);
      mounted.set(b.id, { el, height: b.height });
      toAppend.push(el);
      toMeasure.set(b.id, { el, b });
    }
    if (toAppend.length > 0) spacer.appendChild(frag);

    // 统一测量新挂载的块（一次布局）
    let relayout = false;
    for (const { el, b } of toMeasure.values()) {
      const h = el.offsetHeight;
      if (h > 0 && Math.abs(h - b.height) > 0.5) {
        b.height = h;
        relayout = true;
      }
    }
    // 已挂载块如果因为字号等变化导致高度变化，也在渲染周期内校正
    if (measureDirty) {
      for (const [id, m] of mounted) {
        const b = byId.get(id);
        if (!b) continue;
        const h = m.el.offsetHeight;
        if (h > 0 && Math.abs(h - b.height) > 0.5) {
          b.height = h;
          relayout = true;
        }
      }
      measureDirty = false;
    }
    if (relayout) {
      layout();
      scheduleRender();
      onLayoutChanged?.();
    }
    syncMountedPositions(byId);
    if (pendingFlashLine !== null) runPendingFlash(pendingFlashLine);
  }

  function mountBlock(b: MdBlock): HTMLElement {
    const el = document.createElement("div");
    el.className = `pv-block pv-${b.type}`;
    el.dataset.blockId = String(b.id);
    // 一次性解析渲染结果：含图片且尚无宽高比的块预留占位高度，避免加载时跳动
    el.innerHTML = renderBlockHtml(b);
    if (
      b.hasImage &&
      Array.from(el.querySelectorAll("img")).some((img) => !img.hasAttribute("style"))
    ) {
      el.classList.add("img-placeholder");
    }
    if (b.isCode && !b.hlDone) {
      // 代码块在进入视口时才执行高亮（离屏代码块不高亮）；highlight.js 首次用到
      // 时才加载。完成后若该 DOM 仍挂载且块未被再次编辑，就地升级为高亮版。
      void highlightBlock(b)
        .catch(() => {})
        .then(() => {
          if (!el.isConnected) return;
          const m = mounted.get(b.id);
          if (m && m.el === el) el.innerHTML = b.html;
        });
    }
    el.style.top = `${b.top}px`;
    return el;
  }

  function syncMountedPositions(byId: Map<number, MdBlock>) {
    for (const [id, m] of mounted) {
      const b = byId.get(id);
      if (!b) continue;
      m.el.style.top = `${b.top}px`;
    }
  }

  function unmountAll() {
    for (const { el } of mounted.values()) el.remove();
    mounted.clear();
  }

  /* ---------- 事件 ---------- */
  function scheduleRender() {
    if (renderRaf || !visible) return;
    renderRaf = requestAnimationFrame(render);
  }

  container.addEventListener("scroll", () => scheduleRender(), { passive: true });

  // 图片加载完成：记录宽高比 → 重测所在块 → 从该块向下重排（一次校正，非累计漂移）
  container.addEventListener(
    "load",
    (e) => {
      const img = e.target as HTMLElement;
      if (!(img instanceof HTMLImageElement)) return;
      const blockEl = img.closest<HTMLElement>(".pv-block");
      if (!blockEl) return;
      const id = Number(blockEl.dataset.blockId);
      const list = getBlocks();
      const b = list.find((x) => x.id === id);
      if (!b) return;
      const src = img.getAttribute("src") ?? "";
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setImgAspect(src, img.naturalWidth, img.naturalHeight);
      }
      img.style.aspectRatio =
        img.naturalHeight > 0
          ? `${(img.naturalWidth / img.naturalHeight).toFixed(4)}`
          : "";
      blockEl.classList.remove("img-placeholder");
      const h = blockEl.offsetHeight;
      if (h > 0 && Math.abs(h - b.height) > 0.5) {
        b.height = h;
        layout();
        scheduleRender();
        onLayoutChanged?.();
      }
    },
    true,
  );

  // 容器尺寸/边距变化：重读 padding 并重排
  let padCacheKey = "";
  function readPadding() {
    const cs = getComputedStyle(container);
    const key = `${cs.paddingTop}|${cs.paddingLeft}|${cs.paddingRight}|${cs.lineHeight}|${container.clientWidth}`;
    if (key === padCacheKey) return;
    padCacheKey = key;
    padTop = parseFloat(cs.paddingTop) || 0;
    lineHeight = parseFloat(cs.lineHeight) || 27;
  }
  readPadding();
  new ResizeObserver(() => {
    readPadding();
    markLayoutDirty();
  }).observe(container);

  /* ---------- 公开接口 ---------- */
  function markLayoutDirty() {
    readPadding();
    layoutDirty = true;
    measureDirty = true;
    layout();
    scheduleRender();
  }

  function refresh(changedIds?: Set<number>) {
    if (changedIds) {
      for (const id of changedIds) rebuildSet.add(id);
    }
    layout();
    scheduleRender();
  }

  /** 文档切换：块 id 从 1 重排，与旧挂载表必然冲突，必须整体卸载后按新文档重建 */
  function reset() {
    unmountAll();
    rebuildSet.clear();
    layoutDirty = true;
    container.scrollTop = 0;
    if (!visible) return;
    layout();
    scheduleRender();
  }

  function setVisible(v: boolean) {
    if (visible === v) return;
    visible = v;
    if (!v) {
      unmountAll();
      return;
    }
    layout();
    // 重新显示时保持当前滚动位置，直接渲染视口
    scheduleRender();
  }

  function mapLineToY(lineFloat: number): number {
    const list = getBlocks();
    const line = Math.min(Math.max(0, lineFloat), getDocumentLineCount());
    if (list.length > 0 && headLineCount > 0 && line < list[0].startLine) {
      return line * lineHeight;
    }
    if (tailLineCount > 0 && line >= tailStartLine) {
      const progress = Math.min(tailLineCount, line - tailStartLine);
      return contentBottom + progress * lineHeight;
    }
    if (list.length === 0) return 0;
    // 最后一个 startLine <= lineFloat 的块
    let lo = 0;
    let hi = list.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].startLine <= line) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const b = list[ans];
    const nextTop = ans + 1 < list.length ? list[ans + 1].top : contentBottom;
    const lineSpan =
      ans + 1 < list.length
        ? Math.max(1, list[ans + 1].startLine - b.startLine)
        : Math.max(1, b.endLine - b.startLine + 1);
    const f = Math.min(1, Math.max(0, (line - b.startLine) / lineSpan));
    return b.top + f * Math.max(0, nextTop - b.top);
  }

  function mapYToLine(y: number): number {
    const list = getBlocks();
    const contentY = Math.min(Math.max(0, y), total);
    const maxLine = Math.max(0, getDocumentLineCount() - 0.000001);
    if (tailLineCount > 0 && contentY >= contentBottom) {
      const line = tailStartLine + (contentY - contentBottom) / lineHeight;
      return Math.min(maxLine, Math.max(tailStartLine, line));
    }
    if (list.length === 0) return 0;
    if (headLineCount > 0 && contentY < list[0].top) {
      return Math.min(maxLine, contentY / lineHeight);
    }
    let lo = 0;
    let hi = list.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].top <= contentY) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const b = list[ans];
    const nextTop = ans + 1 < list.length ? list[ans + 1].top : contentBottom;
    const lineSpan =
      ans + 1 < list.length
        ? Math.max(1, list[ans + 1].startLine - b.startLine)
        : Math.max(1, b.endLine - b.startLine + 1);
    const height = Math.max(0, nextTop - b.top) || estimateSpan(b, lineSpan);
    const f = height > 0 ? Math.min(1, Math.max(0, (contentY - b.top) / height)) : 0;
    return Math.min(maxLine, b.startLine + f * lineSpan);
  }

  function estimateSpan(b: MdBlock, span: number): number {
    return b.height > 0 ? b.height : span * 27;
  }

  function totalHeight(): number {
    return total;
  }

  /* ---------- 大纲跳转：目标块闪烁高亮 ---------- */
  let pendingFlashLine: number | null = null;
  let flashCleanupTimer = 0;

  /** 目标块可能尚未挂载（在视口外）：记下行号，待本轮渲染完成后再高亮 */
  function flashAtLine(lineFloat: number): void {
    if (!visible) return;
    pendingFlashLine = lineFloat;
    scheduleRender();
  }

  function runPendingFlash(lineFloat: number) {
    pendingFlashLine = null;
    const list = getBlocks();
    const line = Math.floor(lineFloat);
    // 最后一个 startLine <= line 的块；行落在块间空行区则不高亮
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].startLine <= line) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0 || line > list[ans].endLine) return;
    const el = mounted.get(list[ans].id)?.el;
    if (!el) return;
    el.classList.remove("pv-flash");
    void el.offsetWidth; // 强制回流以重置动画
    el.classList.add("pv-flash");
    window.clearTimeout(flashCleanupTimer);
    flashCleanupTimer = window.setTimeout(() => {
      flashCleanupTimer = 0;
      el.classList.remove("pv-flash");
    }, 1300);
  }

  return {
    element: container,
    setVisible,
    refresh,
    reset,
    markLayoutDirty,
    mapLineToY,
    flashAtLine,
    mapYToLine,
    totalHeight,
  };
}

export type { MdBlock };