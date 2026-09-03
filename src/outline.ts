// 大纲面板：从块模型提取标题，渲染为可点击的目录树。
// - 标题数据直接取自 markdownModel 的顶层块（type === "heading"），行号随增量编辑自动维护，
//   无需单独解析源码；ATX 与 setext 两种写法的标题都能识别。
// - 点击条目跳转到对应源行：编辑/分屏模式滚编辑器并放置光标，预览模式滚预览区。
// - 随编辑器/预览滚动高亮当前所在章节。
// - 刷新由管线事件驱动（model:changed / doc:loaded / doc:closed），打字时 200ms 防抖合并。

import type { EditorView } from "@codemirror/view";
import { bus } from "./events";
import { scrollToLine } from "./documentPosition";
import { getBlocks, type MdBlock } from "./markdownModel";
import { current, viewMode } from "./state";
import type { PreviewApi } from "./virtualPreview";

interface OutlineEntry {
  /** 标题级别 1-6 */
  level: number;
  /** 去掉行内 Markdown 标记后的可读文本 */
  text: string;
  /** 0 起始的源行号 */
  line: number;
  /** 相对上一级标题的嵌套深度（用于缩进） */
  depth: number;
}

export interface OutlineDeps {
  getEditorView: () => EditorView;
  getPreview: () => PreviewApi;
  /** 点击跳转后闪烁高亮编辑器中的目标标题行 */
  flashHeading: (lineNo: number) => void;
}

const outlinePanelEl = document.querySelector<HTMLElement>("#outline-pane")!;
const outlineListEl = document.querySelector<HTMLUListElement>("#outline-list")!;
const outlineEmptyEl = document.querySelector<HTMLElement>("#outline-empty")!;

const OUTLINE_KEY = "annal:outline";
/** 大纲面板刷新防抖：打字时合并多次文档变更，避免每键全量重建目录树 */
const OUTLINE_REFRESH_DELAY_MS = 200;

let deps: OutlineDeps | null = null;
let entries: OutlineEntry[] = [];
let activeEl: HTMLLIElement | null = null;
let refreshTimer: number | undefined;
/** 上次渲染的条目签名（无变化时复用 DOM） */
let lastSignature = "";
let lastHadItems = false;

/** 默认收起：仅在用户显式开启（存了 "1"）时显示 */
function isOutlineEnabled(): boolean {
  return localStorage.getItem(OUTLINE_KEY) === "1";
}

/** 标题块 → 级别与纯文本（ATX：`## 标题`；setext：`标题` + `===`/`---`） */
function headingInfo(b: MdBlock): { level: number; text: string } | null {
  const raw = b.raw.replace(/\r\n/g, "\n");
  const atx = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
  if (atx) return { level: atx[1].length, text: plainText(atx[2]) };
  const lines = raw.split("\n");
  if (lines.length >= 2) {
    const marker = lines[1].trim();
    if (/^=+\s*$/.test(marker)) return { level: 1, text: plainText(lines[0]) };
    if (/^-+\s*$/.test(marker)) return { level: 2, text: plainText(lines[0]) };
  }
  return null;
}

/** 去掉标题里的行内 Markdown 标记（代码、链接、图片、强调），只留可读文本 */
function plainText(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*?)`{1,3}/g, "$1")
    .replace(/~~([^~]*?)~~/g, "$1")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    .replace(/(^|[^*])\*([^*]+?)\*(?=$|[^*])/g, "$1$2")
    .replace(/(^|[^_])_([^_]+?)_(?=$|[^_])/g, "$1$2")
    .trim();
}

/** 收集标题并计算嵌套深度（h2 跟在 h1 后缩进一层，h3 接 h2 再缩进一层） */
function collectEntries(): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const stack: number[] = [];
  for (const b of getBlocks()) {
    if (b.type !== "heading") continue;
    const info = headingInfo(b);
    if (!info || !info.text) continue;
    while (stack.length > 0 && stack[stack.length - 1] >= info.level) stack.pop();
    out.push({ level: info.level, text: info.text, line: b.startLine, depth: stack.length });
    stack.push(info.level);
  }
  return out;
}

/* ---------- 渲染 ---------- */

/** 条目签名：文本/级别/行号任一变化都触发重建，纯打字（标题没变）时复用 DOM */
function entriesSignature(list: OutlineEntry[]): string {
  let sig = "";
  for (const e of list) sig += `${e.level}|${e.depth}|${e.line}|${e.text}\n`;
  return sig;
}

function render() {
  if (!deps) return;
  if (current.get() === null) {
    outlineListEl.innerHTML = "";
    outlineEmptyEl.hidden = false;
    if (activeEl) { activeEl.classList.remove("active"); activeEl = null; }
    return;
  }
  const newEntries = collectEntries();
  const sig = entriesSignature(newEntries);
  if (sig === lastSignature && lastHadItems === (newEntries.length > 0)) {
    entries = newEntries;
    updateActive();
    return;
  }
  entries = newEntries;
  lastSignature = sig;
  lastHadItems = entries.length > 0;

  if (entries.length === 0) {
    outlineListEl.innerHTML = "";
    outlineEmptyEl.hidden = false;
    activeEl = null;
    return;
  }
  outlineEmptyEl.hidden = true;
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "outline-item";
    li.dataset.line = String(e.line);
    li.style.setProperty("--depth", String(e.depth));
    li.title = e.text; // 被省略号截断时悬停显示完整标题
    li.textContent = e.text;
    frag.appendChild(li);
  }
  outlineListEl.innerHTML = "";
  outlineListEl.appendChild(frag);
  activeEl = null;
  updateActive();
}

/* ---------- 跳转与当前章节高亮 ---------- */

function onItemClick(e: Event) {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>(".outline-item");
  if (!li) return;
  const line = Number(li.dataset.line);
  if (!Number.isFinite(line)) return;
  scrollToLine(line);
  // 预览模式闪烁高亮预览块；编辑/分屏只闪烁编辑器标题行
  if (viewMode.get() === "preview") deps?.getPreview().flashAtLine(line);
  else deps?.flashHeading(Math.floor(line) + 1);
  updateActive();
}

/** 视口顶端对应的源行号（浮点，用于定位当前章节） */
function viewportTopLine(): number {
  if (!deps) return -1;
  const v = deps.getEditorView();
  const p = deps.getPreview();
  if (viewMode.get() === "preview") return p.mapYToLine(p.element.scrollTop);
  if (v.state.doc.lines === 0) return -1;
  const docY = v.scrollDOM.scrollTop + 1;
  const block = v.lineBlockAtHeight(docY);
  return v.state.doc.lineAt(block.from).number - 1;
}

function updateActive() {
  if (outlinePanelEl.hidden) return;
  const line = viewportTopLine();
  if (line < 0) return;
  let next: HTMLLIElement | null = null;
  for (const li of Array.from(outlineListEl.children) as HTMLLIElement[]) {
    if (Number(li.dataset.line) <= line) next = li;
    else break;
  }
  if (next === activeEl) return;
  activeEl?.classList.remove("active");
  next?.classList.add("active");
  activeEl = next;
  // 当前章节被截断到视口外时，让它回到大纲可见范围
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

/* ---------- 生命周期 ---------- */

export function initOutline(outlineDeps: OutlineDeps) {
  deps = outlineDeps;
  outlineListEl.addEventListener("click", onItemClick);
  // 大纲面板无自定义右键菜单，屏蔽 WebView 原生菜单
  outlinePanelEl.addEventListener("contextmenu", (e) => e.preventDefault());

  // 管线事件驱动刷新：编辑增量（防抖合并）/ 打开 / 关闭
  bus.on("doc:closed", refreshOutline);

  // Wire sidebar tab switching (笔记 / 大纲)
  const tabBtns = document.querySelectorAll<HTMLElement>(".sidebar-tab");
  const filesPane = document.querySelector<HTMLElement>("#files-pane")!;
  const outlinePane = document.querySelector<HTMLElement>("#outline-pane")!;
  const restoreOutlineTab = () => {
    if (!isOutlineEnabled()) {
      refreshOutline();
      return;
    }
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === "outline"));
    filesPane.hidden = true;
    outlinePane.hidden = false;
    refreshOutline();
  };
  bus.on("doc:loaded", restoreOutlineTab);

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const isOutline = btn.dataset.tab === "outline";
      tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === btn.dataset.tab));
      filesPane.hidden = isOutline;
      outlinePane.hidden = !isOutline;
      localStorage.setItem(OUTLINE_KEY, isOutline ? "1" : "0");
      if (isOutline) render();
      else if (activeEl) { activeEl.classList.remove("active"); activeEl = null; }
    });
  });

  // 当前已有文档（例如测试/热重载）时立即恢复；正常启动由 doc:loaded 恢复。
  if (current.get()) restoreOutlineTab();

  const ed = deps.getEditorView().scrollDOM;
  const pv = deps.getPreview().element;
  ed.addEventListener("scroll", updateActive, { passive: true });
  pv.addEventListener("scroll", updateActive, { passive: true });
  render();
}

/** 打开/编辑/关闭文档后刷新目录树（在模型刷新之后调用）。
 *  无文档时跳过；显示时防抖合并连续变更。 */
export function refreshOutline() {
  if (current.get() === null) return;
  if (refreshTimer !== undefined) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    render();
  }, OUTLINE_REFRESH_DELAY_MS);
}
