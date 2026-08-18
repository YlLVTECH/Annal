// Markdown 渲染模块：marked（解析）+ DOMPurify（消毒）+ highlight.js（代码高亮）。
// 本地图片通过 Tauri 的 asset 协议（convertFileSrc）加载。

import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked, type RendererObject, type Token, type Tokens, type TokensList } from "marked";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** 远端图片（http/https/data），直接引用，不做本地转换 */
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

/** 本次渲染的笔记所在目录（marked.parse 为同步调用，渲染前设置即可） */
let renderBaseDir = "";

/* ---------- 渲染结果缓存（LRU） ----------
 * 相同内容 + 相同基准目录的重复渲染直接复用，跳过 marked 解析、DOMPurify 消毒与
 * 高亮（撤销/恢复、切换笔记、查看历史版本等场景收益明显）。
 * 超长内容不入缓存；总字符数超预算时淘汰最久未使用的条目，控制内存占用。
 */
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX_ENTRIES = 16; // 最多缓存条目数
const RENDER_CACHE_MAX_CHARS = 2 * 1024 * 1024; // 缓存内容总字符数上限
const RENDER_CACHE_SKIP_IF_LONGER = 256 * 1024; // 超过该长度的源内容不缓存
let renderCacheChars = 0;

function cacheGet(key: string): string | undefined {
  const hit = renderCache.get(key);
  if (hit !== undefined) {
    renderCache.delete(key); // 重新插入以维护最近使用顺序
    renderCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: string) {
  renderCache.delete(key);
  renderCache.set(key, value);
  renderCacheChars += key.length + value.length;
  while (
    renderCache.size > RENDER_CACHE_MAX_ENTRIES ||
    renderCacheChars > RENDER_CACHE_MAX_CHARS
  ) {
    const oldest = renderCache.keys().next().value as string;
    renderCacheChars -= oldest.length + (renderCache.get(oldest) ?? "").length;
    renderCache.delete(oldest);
  }
}

const renderer: RendererObject = {
  // 代码块：能识别语言就高亮，否则转义后原样展示
  code({ text, lang }: Tokens.Code): string {
    const language = (lang ?? "").split(/\s+/)[0];
    let body: string;
    if (language && hljs.getLanguage(language)) {
      body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } else {
      body = escapeHtml(text);
    }
    const cls = language ? ` class="hljs language-${escapeAttr(language)}"` : ' class="hljs"';
    return `<pre><code${cls}>${body}</code></pre>`;
  },

  // 链接：新窗口语义，前端拦截后 Ctrl+点击 调用系统浏览器打开
  link({ href, title, tokens }: Tokens.Link): string {
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" class="ext-link"${titleAttr}>${text}</a>`;
  },

  // 图片：本地文件转为 asset 协议 URL 后加载
  image({ href, title, text }: Tokens.Image): string {
    const src = resolveImgSrc(href, renderBaseDir);
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}"${titleAttr}>`;
  },
};

marked.use({
  gfm: true, // GitHub 风格：表格、任务列表、删除线等
  breaks: true, // 单个换行渲染为 <br>，适合随手记
  renderer,
});

/* ---------- 源行号标注 ----------
 * 把源文本按顶层块逐个解析，给每个块的首个标签注入 data-line（0 起始的源行号）。
 * 分屏滚动同步靠它把编辑区的源行映射到预览区对应块；任何解析异常时回退到
 * 整体解析（没有 data-line，同步退化为比例模式）。
 */
function renderWithLineInfo(src: string): string {
  let tokens: TokensList;
  try {
    tokens = marked.lexer(src);
  } catch {
    return marked.parse(src, { async: false }) as string;
  }
  let offset = 0;
  // 行号增量累计：统计每个块自身 raw 里的换行数，避免每个块都从头切分全文（O(n²) -> O(n)）
  let line = 0;
  const parts: string[] = [];
  try {
    for (const token of tokens as Token[]) {
      const raw = token.raw ?? "";
      if (!raw) continue;
      const html = renderBlock(token, tokens);
      if (html) parts.push(injectLine(html, line));
      for (let i = 0; i < raw.length; i++) {
        if (raw.charCodeAt(i) === 10) line++;
      }
      offset += raw.length;
    }
  } catch {
    return marked.parse(src, { async: false }) as string;
  }
  // token.raw 拼接与原文对不上时行号不可信，整体回退
  if (offset !== src.length) return marked.parse(src, { async: false }) as string;
  return parts.join("");
}

function renderBlock(token: Token, tokens: TokensList): string {
  if (token.type === "space" || token.type === "def") return "";
  const single = [token] as TokensList;
  single.links = tokens.links;
  return marked.parser(single) as string;
}

function injectLine(html: string, line: number): string {
  // 只注入到首个标签上；raw HTML 块（如 <!-- 注释 --> 开头）注入失败则跳过
  return html.replace(/^<([a-zA-Z][\w-]*)/, (m) => `${m} data-line="${line}"`);
}

/** 将 Markdown 渲染为经过消毒的 HTML。baseDir 用于解析相对路径的本地图片。 */
export function renderMarkdown(src: string, baseDir = ""): string {
  const key = baseDir + "\u0000" + src;
  const cacheable = src.length <= RENDER_CACHE_SKIP_IF_LONGER;
  const cached = cacheable ? cacheGet(key) : undefined;
  if (cached !== undefined) return cached;
  renderBaseDir = baseDir;
  const html = renderWithLineInfo(src);
  // target 不在 DOMPurify 默认白名单里，需要显式放行（链接点击由 JS 拦截后交给系统浏览器）；
  // asset: 协议用于加载本地图片，需放行到 URL 白名单
  const out = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
  if (cacheable) cacheSet(key, out);
  return out;
}
