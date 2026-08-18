// Markdown 块级模型：把整篇文档切成顶层块，支持"只重渲染受影响块"的增量更新。
// 渲染管线与旧版一致：marked（解析）+ DOMPurify（消毒）+ highlight.js（代码高亮，
// 但只在块真正进入视口时才执行——离屏代码块不高亮）。
// 本地图片通过 Tauri 的 asset 协议（convertFileSrc）加载。

import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked, type RendererObject, type Token, type Tokens } from "marked";

export interface MdBlock {
  /** 稳定 id：增量更新时尽量复用，虚拟预览用它跟踪 DOM 挂载 */
  id: number;
  /** 顶层块类型（marked token.type） */
  type: string;
  /** 0 起始的源行号（含） */
  startLine: number;
  /** 0 起始的源行号（含） */
  endLine: number;
  /** 该块在源文本中的精确切片 */
  raw: string;
  /** 内容指纹：内容变化时 key 变，跨全量重解析时据此复用旧块 */
  key: string;
  /** 内容版本：内容每次变化 +1，虚拟预览据此判断"哪些块变了" */
  version: number;
  /** 消毒后的渲染结果（代码块高亮后也写回这里） */
  html: string;
  /** 代码块是否已完成高亮（离屏时保持 false） */
  hlDone: boolean;
  /** 是否代码块（需要在挂载时触发高亮） */
  isCode: boolean;
  /** 是否含图片（挂载时预留高度，图片加载后重测） */
  hasImage: boolean;
  /** 当前高度（px；未挂载测量过则为估算值） */
  height: number;
  /** 预览内容坐标空间内的顶边位置（px，由虚拟预览维护） */
  top: number;
  /** 是否单块可安全增量重渲染的类型 */
  simple: boolean;
  /** 增量路径的临时 token 缓存（内容变化时失效） */
  _token?: Token;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** 远端图片（http/https/data/asset），直接引用，不做本地转换 */
function isRemoteSrc(src: string): boolean {
  return /^(?:https?:|data:|asset:)/i.test(src);
}

/** 图片 src 解析：相对路径基于笔记所在目录，并转换为 asset 协议 URL */
function resolveImgSrc(src: string, baseDir: string): string {
  if (isRemoteSrc(src)) return src;
  let p = src.replace(/\\/g, "/");
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p) && baseDir) {
    p = `${baseDir.replace(/\\/g, "/")}/${p}`;
  }
  // 清理 . 和 .. 段，避免 asset 协议读取路径带冗余目录
  const absolute = p.startsWith("/");
  const segments = p.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return convertFileSrc((absolute ? "/" : "") + out.join("/"));
}

/** 本次渲染的笔记所在目录（解析相对路径图片用；渲染是同步调用，渲染前设置即可） */
let renderBaseDir = "";

/** 设置当前笔记所在目录（打开/切换笔记时调用） */
export function setRenderBaseDir(dir: string) {
  renderBaseDir = dir;
}

/* ---------- 按 src 缓存的图片宽高比 ----------
 * 图片加载完成后记录宽高比，再次渲染同一张图时用 aspect-ratio 预留高度，
 * 避免图片反复加载导致的文档位移。 */
const imgAspectCache = new Map<string, number>();

export function getImgAspect(src: string): number | undefined {
  return imgAspectCache.get(src);
}

/** 记录图片宽高比（虚拟预览在 img load 事件里调用） */
export function setImgAspect(src: string, width: number, height: number) {
  imgAspectCache.set(src, height > 0 ? width / height : 0);
}

const renderer: RendererObject = {
  // 代码块：先转义输出（不立即高亮），挂载进视口后由 highlightBlock 升级为高亮版
  code({ text, lang }: Tokens.Code): string {
    const language = (lang ?? "").split(/\s+/)[0];
    const body = escapeHtml(text);
    const cls = language ? ` class="hljs language-${escapeAttr(language)}"` : ' class="hljs"';
    return `<pre><code${cls}>${body}</code></pre>`;
  },

  // 链接：新窗口语义，前端拦截后 Ctrl+点击 调用系统浏览器打开
  link({ href, title, tokens }: Tokens.Link): string {
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" class="ext-link"${titleAttr}>${text}</a>`;
  },

  // 图片：本地文件转为 asset 协议 URL；lazy/async 让离屏图片不参与
  // 打开与重渲染时的同步解码，滚动到图片附近也不阻塞主线程。
  // 已知宽高比的图片用 aspect-ratio 预留高度，减少加载后的位移。
  image({ href, title, text }: Tokens.Image): string {
    const src = resolveImgSrc(href, renderBaseDir);
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    const ratio = imgAspectCache.get(src);
    const styleAttr = ratio ? ` style="aspect-ratio:${ratio.toFixed(4)}"` : "";
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}" loading="lazy" decoding="async"${styleAttr}${titleAttr}>`;
  },
};

marked.use({
  gfm: true, // GitHub 风格：表格、任务列表、删除线等
  breaks: true, // 单个换行渲染为 <br>，适合随手记
  renderer,
});

/* ---------- DOMPurify 配置（与整篇渲染版本一致） ---------- */
const SANITIZE_OPTS = {
  ADD_ATTR: ["target", "loading", "decoding"],
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_OPTS);
}

/** 把单个 token 渲染成消毒后的 HTML；链接定义通过列表级属性传给 marked 解析器 */
function renderSingle(token: Token, links: Record<string, Token>): string {
  const list = Object.assign([token] as Token[], { links }) as unknown as Parameters<
    typeof marked.parser
  >[0];
  return marked.parser(list) as string;
}

/* ---------- 块解析 ---------- */

/** 单块可安全增量重渲染的类型 */
const SIMPLE_KINDS = new Set(["paragraph", "heading", "hr", "code", "table", "html"]);

/** 结构化行：出现即可能导致块边界/块类型变化（空行会切断段落，也算） */
const STRUCTURAL_LINE_RE =
  /^\s*(?:$|#{1,6}\s|`{3,}|~{3,}|>\s?|[-*+]\s|\d+[.)]\s|[-*+]\s+\[[ xX]\]\s|[-*_]\s*(?:[-*_]\s*){1,}|=+\s*$|-+\s*$|\[[^\]]+\]:\s|<\w|\|)/;

function isStructuralLine(line: string): boolean {
  return STRUCTURAL_LINE_RE.test(line);
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** 简短内容指纹（FNV-1a 32 位），用于跨重解析时复用块对象 */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function makeBlock(token: Token, src: string, startOffset: number, startLine: number): MdBlock {
  const raw = token.raw ?? "";
  const nl = countNewlines(raw);
  const endLine = startLine + nl - (raw.endsWith("\n") ? 1 : 0);
  const absEnd = Math.min(startOffset + raw.length, src.length);
  const slice = src.slice(startOffset, absEnd);
  return {
    id: nextBlockId++,
    type: token.type,
    startLine,
    endLine,
    raw: slice !== raw ? raw : slice,
    key: hashText(slice !== raw ? raw : slice),
    version: 1,
    html: "",
    hlDone: false,
    isCode: token.type === "code",
    hasImage: /!\[[^\]]*\]\([^)]*\)/.test(raw),
    height: 0,
    top: 0,
    simple: SIMPLE_KINDS.has(token.type),
  };
}

/** 顶层 token 列表 → 块数组（token.raw 拼接必须与源文本完全一致） */
function buildBlocks(tokens: Token[], src: string): MdBlock[] | null {
  const out: MdBlock[] = [];
  let offset = 0;
  let line = 0;
  for (const token of tokens) {
    if (token.type === "space" || token.type === "def") {
      if (token.raw) {
        offset += token.raw.length;
        line += countNewlines(token.raw);
      }
      continue;
    }
    const raw = token.raw ?? "";
    if (src.slice(offset, Math.min(offset + raw.length, src.length)) !== raw) return null;
    out.push(makeBlock(token, src, offset, line));
    offset += raw.length;
    line += countNewlines(raw);
  }
  if (offset !== src.length) return null;
  return out;
}

/** 异常兜底：整篇内容退化为单个段落块（保持可读性） */
function fallbackBlocks(src: string): MdBlock[] {
  const lines = Math.max(1, countNewlines(src) + 1);
  return [
    {
      id: nextBlockId++,
      type: "paragraph",
      startLine: 0,
      endLine: lines - 1,
      raw: src,
      key: hashText(src),
      version: 1,
      html: sanitize(`<p>${escapeHtml(src)}</p>`),
      hlDone: true,
      isCode: false,
      hasImage: false,
      height: lines * 27,
      top: 0,
      simple: true,
    },
  ];
}

let nextBlockId = 1;
let blocks: MdBlock[] = [];
let documentLineCount = 1;
/** 最近一次全量解析得到的文档级链接定义（增量重解析单个块时注入 lexer） */
let docLinks: Record<string, Token> = {};

/** 全量重解析（打开笔记 / 结构变化 / 兜底路径） */
function fullParse(text: string) {
  documentLineCount = countNewlines(text) + 1;
  let tokens: Token[] = [];
  try {
    tokens = marked.lexer(text) as Token[];
  } catch {
    tokens = [];
  }
  docLinks = (tokens as { links?: Record<string, Token> }).links ?? {};
  const built = buildBlocks(tokens, text);
  blocks = built ? built : fallbackBlocks(text);
  assignEstimatedHeights(blocks);
}

/** 独立解析一段文本：预置文档级链接定义，使 [文本][id] 引用能按全文定义解析 */
function lexSnippet(raw: string, links: Record<string, Token>): Token[] {
  try {
    const lexer = new marked.Lexer(undefined as never);
    (lexer.tokens as unknown as { links: Record<string, Token> }).links = { ...links };
    return lexer.lex(raw) as Token[];
  } catch {
    return marked.lexer(raw) as Token[];
  }
}

/** 未测量块的高度估算：挂载后会被真实测量值替换 */
export function estimateHeight(b: MdBlock): number {
  const lines = Math.max(1, b.endLine - b.startLine + 1);
  switch (b.type) {
    case "code":
      return Math.max(30, lines * 21 + 30);
    case "heading":
      return b.raw.startsWith("# ") || b.raw.startsWith("## ") ? 46 : 38;
    case "hr":
      return 26;
    case "table":
      return Math.max(40, lines * 30);
    case "blockquote":
      return lines * 27;
    case "list":
      return lines * 26;
    default:
      return lines * 27;
  }
}

function assignEstimatedHeights(list: MdBlock[]) {
  for (const b of list) b.height = estimateHeight(b);
}

/** 用完整文本整体重载模型（打开/切换笔记时调用），返回块列表 */
export function loadModel(text: string): MdBlock[] {
  nextBlockId = 1;
  fullParse(text);
  return blocks;
}

/* ---------- 增量更新 ---------- */

/**
 * 处理文档编辑：尽量只重建受影响的块，其余块仅平移行号。
 * - range 为 0 起始的源行闭区间（由 CodeMirror 的事务变更换算得到）。
 * - opts.newlineChange 表示本次编辑插入了或删除了换行：换行变化会改变顶层块的
 *   边界与归属（回车拆分段落、删除换行合并、空行分隔等），此时不信任快速路径，
 *   一律全量重解析。
 * - 命中单块快速路径时只重渲染那个块；否则全量重解析，但内容未变的块按 key
 *   复用原对象（保留 id / 版本 / 缓存 / 测量高度），虚拟预览因此不会重建它们的 DOM。
 * 返回内容版本有变化的块 id 集合（这些块需要重新渲染）。
 */
export function applyEdit(
  text: string,
  range: { start: number; end: number },
  opts?: { newlineChange?: boolean },
): Set<number> {
  documentLineCount = countNewlines(text) + 1;
  const changed = new Set<number>();
  if (blocks.length === 0) {
    fullParse(text);
    for (const b of blocks) changed.add(b.id);
    return changed;
  }

  // 定位与编辑范围相交的块：快速路径要求整段变更落在同一个块内
  let lo = 0;
  let hi = blocks.length - 1;
  let first = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].endLine >= range.start) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (first < 0) {
    // 变更发生在最后一个块之后（在文档末尾追加）——可能有新块，全量重解析
    fullParse(text);
    for (const b of blocks) changed.add(b.id);
    return changed;
  }
  let lastAffected = first;
  while (lastAffected + 1 < blocks.length && blocks[lastAffected + 1].startLine <= range.end) {
    lastAffected++;
  }

  // 快速路径：单块 & 未触及结构化行 & 类型可安全增量 & 单块重解析结果一致
  // 前提是本次编辑没有插入/删除换行（由编辑器根据字符差异判断传入）
  if (first === lastAffected && opts?.newlineChange !== true) {
    const b = blocks[first];
    let structural = false;
    for (let ln = range.start; ln <= range.end; ln++) {
      const lineText = getLine(text, ln);
      if (isStructuralLine(lineText)) {
        structural = true;
        break;
      }
    }
    if (b.simple && !structural) {
      // 按旧行号切出该块的新内容；同行为准，去掉行尾换行以便与 marked 的 raw 对齐
      let slice = text.slice(offsetOfLine(text, b.startLine), offsetOfLine(text, b.endLine + 1));
      if (slice.endsWith("\n")) slice = slice.slice(0, -1);
      let single: Token | null = null;
      try {
        const res = lexSnippet(slice, docLinks);
        for (const t of res) {
          if (t.type === "space" || t.type === "def") continue;
          single = t;
          break;
        }
      } catch {
        single = null;
      }
      if (single && single.type === b.type && (single.raw ?? slice) === slice) {
        updateSingleBlock(b, slice);
        b._token = single;
        changed.add(b.id);
        return changed;
      }
    }
  }

  // 全量重解析：内容未变的块按 key 复用对象
  const previous = new Map<string, MdBlock>();
  for (const b of blocks) previous.set(b.key, b);
  const oldOrder = blocks;
  fullParse(text);
  const newById = new Map<number, MdBlock>();
  for (const b of blocks) {
    const old = previous.get(b.key);
    if (old) {
      b.id = old.id;
      b.version = old.version;
      b.html = old.html;
      b.hlDone = old.hlDone;
      b.height = old.height;
      b._token = old._token && old.key === b.key ? old._token : undefined;
    } else {
      changed.add(b.id);
    }
    newById.set(b.id, b);
  }
  // 旧块在本次重解析中消失：这些块的内容已被删除或合并，需要通知渲染层卸载
  for (const ob of oldOrder) {
    if (!newById.has(ob.id)) changed.add(ob.id);
  }
  return changed;
}

function updateSingleBlock(b: MdBlock, newRaw: string) {
  const newLines = countNewlines(newRaw);
  const oldLines = b.endLine - b.startLine;
  b.raw = newRaw;
  b.key = hashText(newRaw);
  b.version++;
  b.html = "";
  b.hlDone = false;
  b.hasImage = /!\[[^\]]*\]\([^)]*\)/.test(newRaw);
  b.endLine = b.startLine + newLines;
  if (newLines !== oldLines || b.height === 0) {
    b.height = estimateHeight(b);
  }
  b._token = undefined;
}

/* ---------- 行工具 ---------- */

function getLine(text: string, lineNo: number): string {
  const start = offsetOfLine(text, lineNo);
  const end = text.indexOf("\n", start);
  return text.slice(start, end < 0 ? text.length : end);
}

/** 行首偏移（0 起始行号；行号越界时返回文本末尾） */
export function offsetOfLine(text: string, lineNo: number): number {
  let line = 0;
  let i = 0;
  while (line < lineNo && i < text.length) {
    if (text.charCodeAt(i) === 10) line++;
    i++;
  }
  return Math.min(i, text.length);
}

/* ---------- 块渲染 ---------- */

/** 渲染并缓存单个块的消毒 HTML（代码块先给转义文本，挂载时再升级高亮） */
export function renderBlockHtml(b: MdBlock): string {
  if (b.html) return b.html;
  try {
    const token = blockToken(b);
    const links = (token as { links?: Record<string, Token> }).links ?? docLinks;
    b.html = renderSingle(token, links);
  } catch {
    b.html = sanitize(`<p>${escapeHtml(b.raw)}</p>`);
  }
  return b.html;
}

/** 块 → token：增量路径的块缓存过 token，否则用块切片临时重解析 */
function blockToken(b: MdBlock): Token {
  if (b._token) return b._token;
  try {
    const res = lexSnippet(b.raw, docLinks);
    for (const t of res) {
      if (t.type === "space" || t.type === "def") continue;
      b._token = t;
      return t;
    }
  } catch {
    // 走兜底
  }
  throw new Error("block parse failed");
}

/** 代码块挂载进视口后调用：执行 highlight.js 高亮并更新缓存的 HTML */
export function highlightBlock(b: MdBlock) {
  if (b.hlDone || !b.isCode) return;
  const token = blockToken(b) as Tokens.Code;
  const language = (token.lang ?? "").split(/\s+/)[0];
  const text = token.text ?? b.raw;
  let body: string;
  if (language && hljs.getLanguage(language)) {
    body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } else {
    body = escapeHtml(text);
  }
  const cls = language ? ` class="hljs language-${escapeAttr(language)}"` : ' class="hljs"';
  b.html = sanitize(`<pre><code${cls}>${body}</code></pre>`);
  b.hlDone = true;
}

/** 整篇渲染（历史版本弹层等一次性场景复用） */
export function renderMarkdownWhole(src: string, baseDir = ""): string {
  const saved = renderBaseDir;
  renderBaseDir = baseDir;
  try {
    let tokens: Token[] = [];
    try {
      tokens = marked.lexer(src) as Token[];
    } catch {
      tokens = [];
    }
    const links = (tokens as { links?: Record<string, Token> }).links ?? {};
    const out: string[] = [];
    let offset = 0;
    for (const token of tokens) {
      if (token.type === "space" || token.type === "def") {
        if (token.raw) offset += token.raw.length;
        continue;
      }
      const raw = token.raw ?? "";
      if (src.slice(offset, Math.min(offset + raw.length, src.length)) !== raw) continue;
      const html = renderSingle(token, links);
      if (html) out.push(html);
      offset += raw.length;
    }
    return out.join("\n");
  } finally {
    renderBaseDir = saved;
  }
}

/* ---------- 供虚拟预览/同步复用的模型访问 ---------- */

/** 当前模型的块列表（顺序即文档顺序） */
export function getBlocks(): MdBlock[] {
  return blocks;
}

/** 当前模型对应的完整文档行数（与 CodeMirror 的行数语义一致） */
export function getDocumentLineCount(): number {
  return documentLineCount;
}

/** 当前文本长度缓存（虚拟预览判断是否为空文档） */
export function isModelEmpty(): boolean {
  return blocks.length === 0;
}

/** 重置模型（关闭编辑器时清理） */
export function resetModel() {
  blocks = [];
  documentLineCount = 1;
  docLinks = {};
}
