// 即时渲染（Live Preview）扩展：基于 Lezer Markdown 语法树，在编辑器内直接渲染样式。
// 行为对标 Typora / Obsidian 实时预览：
// - 标题、引用、列表、围栏代码块、表格等以行级装饰直接呈现版式；
// - 行内语法（**粗体**、*斜体*、~~删除线~~、`代码`、[链接](url)）在光标离开时
//   隐藏源码符号、渲染内容样式；光标（选区）触及该节点时回退为源码显示；
// - ![图片](path) 光标离开时渲染为内联图片（复用预览的 asset 协议解析）；
// - 分隔线光标离开时渲染为水平线。
//
// 性能与热路径约束：
// - 只为可见视口构建装饰，滚动/输入/移动光标时按视口重算，不引入 O(全文) 工作；
// - 语法树由编辑器已启用的 markdown() 语言增量维护（打字时 Lezer 只重解析受影响块）；
// - 本模块只读文档与选区，不触碰块模型/预览（与单向数据流互不干扰）；
// - 隐藏符号的 replace 装饰同时注册为 atomicRanges，方向键会自然跳过不可见符号。

import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { getRenderBaseDir, resolveImgSrc } from "./markdownModel";

/* ---------- 装饰工具 ---------- */

/** 隐藏源码符号（零宽 replace；同时被注册为 atomicRanges，光标跳过） */
const hiddenDeco = Decoration.replace({});

const markCache = new Map<string, Decoration>();

/** 按 class 缓存的 mark 装饰（同一 class 全文档共享实例，省内存与比较开销） */
function mark(cls: string): Decoration {
  let deco = markCache.get(cls);
  if (!deco) {
    deco = Decoration.mark({ class: cls });
    markCache.set(cls, deco);
  }
  return deco;
}

interface Part {
  from: number;
  to: number;
  deco: Decoration;
}

interface Span {
  from: number;
  to: number;
}

/** 选区是否触及 [from, to]（含边界：光标停在符号旁即显示源码，符合 Typora 手感） */
function touchesSelection(
  selection: { ranges: readonly { from: number; to: number }[] },
  from: number,
  to: number,
): boolean {
  for (const range of selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

/* ---------- 内联 Widget ---------- */

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image-wrap";
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt;
    img.draggable = false;
    img.loading = "lazy";
    // 图片异步加载完成后高度变化，主动请求重测，避免滚动位置/分屏同步错位
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "cm-md-image-broken";
      fallback.textContent = this.alt || this.src;
      img.replaceWith(fallback);
    });
    wrap.appendChild(img);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-md-hr";
    return el;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/* ---------- 装饰构建 ---------- */

class LiveRenderPlugin {
  decorations: DecorationSet = Decoration.none;

  constructor(readonly view: EditorView) {
    this.build();
  }

  update(update: ViewUpdate) {
    // 语法树引用变化覆盖"懒解析在后台补全"的场景（文档没变但树更完整了）
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.build();
    }
  }

  private build() {
    const view = this.view;
    const { state } = view;
    const doc = state.doc;
    if (doc.length === 0) {
      this.decorations = Decoration.none;
      return;
    }
    const selection = state.selection;
    const tree = syntaxTree(state);

    const lineClasses = new Map<number, Set<string>>();
    const parts: Part[] = [];

    const addLineClass = (pos: number, cls: string) => {
      let set = lineClasses.get(pos);
      if (!set) {
        set = new Set();
        lineClasses.set(pos, set);
      }
      set.add(cls);
    };

    const revealed = (from: number, to: number) =>
      touchesSelection(selection, from, to);

    /** 遍历节点行区间与可见区交集内的每一行；回调附带是否为节点首/末行 */
    const eachLine = (
      node: SyntaxNodeRef,
      visible: Span,
      cb: (line: { from: number; to: number; text: string }, first: boolean, last: boolean) => void,
    ) => {
      const start = Math.max(node.from, visible.from);
      const end = Math.min(node.to, visible.to);
      if (start > end) return;
      const firstNo = doc.lineAt(start).number;
      const lastNo = doc.lineAt(end).number;
      for (let no = firstNo; no <= lastNo; no++) {
        const line = doc.line(no);
        cb(line, line.from <= node.from, line.to >= node.to);
      }
    };

    /** 行内强调类：隐藏前后定界符 + 内容套样式 */
    const inlineFmt = (
      node: SyntaxNodeRef,
      cls: string,
      openLen: number,
      closeLen: number,
    ) => {
      const { from, to } = node;
      if (openLen <= 0 && closeLen <= 0) {
        parts.push({ from, to, deco: mark(cls) });
        return;
      }
      if (to - from <= openLen + closeLen) {
        parts.push({ from, to, deco: mark(cls) });
        return;
      }
      if (revealed(from, to)) {
        if (openLen > 0) parts.push({ from, to: from + openLen, deco: mark("cm-md-mark") });
        if (closeLen > 0) parts.push({ from: to - closeLen, to, deco: mark("cm-md-mark") });
      } else {
        if (openLen > 0) parts.push({ from, to: from + openLen, deco: hiddenDeco });
        if (closeLen > 0) parts.push({ from: to - closeLen, to, deco: hiddenDeco });
      }
      parts.push({ from: from + openLen, to: to - closeLen, deco: mark(cls) });
    };

    /** 行内链接 [label](dest)：光标离开时隐藏 "[" 与 "](dest)"，只留链接文本 */
    const renderLink = (node: SyntaxNodeRef) => {
      const { from, to } = node;
      const line = doc.lineAt(from);
      if (to > line.to) {
        // 跨行链接不做符号隐藏，退回纯样式
        parts.push({ from, to, deco: mark("cm-md-link") });
        return;
      }
      const text = doc.sliceString(from, to);
      const split = text.indexOf("](");
      if (split > 1 && text.endsWith(")")) {
        if (revealed(from, to)) {
          parts.push({ from, to: from + 1, deco: mark("cm-md-mark") });
          parts.push({ from: from + split, to, deco: mark("cm-md-mark") });
        } else {
          parts.push({ from, to: from + 1, deco: hiddenDeco });
          parts.push({ from: from + split, to, deco: hiddenDeco });
        }
        parts.push({ from: from + 1, to: from + split, deco: mark("cm-md-link") });
        return;
      }
      // 引用式链接 [label][ref] / [label]：仅隐藏方括号
      const close = text.indexOf("]");
      if (close > 0) {
        if (revealed(from, to)) {
          parts.push({ from, to: from + 1, deco: mark("cm-md-mark") });
          parts.push({ from: from + close, to: from + close + 1, deco: mark("cm-md-mark") });
        } else {
          parts.push({ from, to: from + 1, deco: hiddenDeco });
          parts.push({ from: from + close, to: from + close + 1, deco: hiddenDeco });
        }
        parts.push({ from: from + 1, to: from + close, deco: mark("cm-md-link") });
      } else {
        parts.push({ from, to, deco: mark("cm-md-link") });
      }
    };

    /** 图片 ![alt](src)：光标离开时渲染为内联图片 */
    const renderImage = (node: SyntaxNodeRef) => {
      const { from, to } = node;
      const line = doc.lineAt(from);
      if (to > line.to) return; // 跨行图片保持源码
      const text = doc.sliceString(from, to);
      const split = text.indexOf("](");
      if (!text.startsWith("![") || split <= 2 || !text.endsWith(")")) return;
      const alt = text.slice(2, split);
      const src = text.slice(split + 2, text.length - 1);
      if (revealed(from, to)) {
        parts.push({ from, to: from + 2, deco: mark("cm-md-mark") });
        parts.push({ from: from + split, to, deco: mark("cm-md-mark") });
        return;
      }
      if (!src.trim()) return;
      parts.push({
        from,
        to,
        deco: Decoration.replace({
          widget: new ImageWidget(resolveImgSrc(src, getRenderBaseDir()), alt),
        }),
      });
    };

    const visit = (node: SyntaxNodeRef, visible: Span) => {
      const name = node.name;
      if (name.startsWith("ATXHeading")) {
        const level = Number(name.slice(-1));
        const line = doc.lineAt(node.from);
        addLineClass(line.from, `cm-md-h${level}`);
        const text = doc.sliceString(node.from, Math.min(node.to, line.to));
        const open = /^#{1,6}[ \t]*/.exec(text);
        const close = /[ \t]+#{1,6}[ \t]*$/.exec(text);
        const openLen = open ? open[0].length : 0;
        const closeFrom =
          close && close.index > openLen ? node.from + close.index : -1;
        if (revealed(node.from, node.to)) {
          if (openLen > 0) {
            parts.push({ from: node.from, to: node.from + openLen, deco: mark("cm-md-mark") });
          }
          if (closeFrom >= 0) {
            parts.push({ from: closeFrom, to: Math.min(node.to, line.to), deco: mark("cm-md-mark") });
          }
        } else {
          if (openLen > 0) {
            parts.push({ from: node.from, to: node.from + openLen, deco: hiddenDeco });
          }
          if (closeFrom >= 0) {
            parts.push({ from: closeFrom, to: Math.min(node.to, line.to), deco: hiddenDeco });
          }
        }
        return;
      }
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        const level = name === "SetextHeading1" ? 1 : 2;
        eachLine(node, visible, (line, _first, last) => {
          addLineClass(line.from, `cm-md-h${level}`);
          // 末行的下划线（=== / ---）整行淡化
          if (last && node.to > node.from + (line.to - line.from)) {
            parts.push({ from: line.from, to: line.to, deco: mark("cm-md-mark") });
          }
        });
        return;
      }
      if (name === "Blockquote") {
        eachLine(node, visible, (line) => {
          addLineClass(line.from, "cm-md-quote");
          const m = /^([ \t]*>[ \t]*)+/.exec(line.text);
          if (m) {
            parts.push({ from: line.from, to: line.from + m[0].length, deco: mark("cm-md-mark") });
          }
        });
        return;
      }
      if (name === "FencedCode") {
        eachLine(node, visible, (line, first, last) => {
          addLineClass(line.from, "cm-md-codeblock");
          // 首末行加圆角标记类（仅多行块；单行块退回普通行样式）
          if (first && !last) addLineClass(line.from, "cm-md-codeblock-start");
          if (last && !first) addLineClass(line.from, "cm-md-codeblock-end");
          if (first) {
            const m = /^(`{3,}|~{3,})/.exec(line.text);
            if (m) {
              parts.push({ from: line.from, to: line.from + m[0].length, deco: mark("cm-md-mark") });
            }
          }
          if (last && !first) {
            if (/^\s*(`{3,}|~{3,})\s*$/.test(line.text)) {
              parts.push({ from: line.from, to: line.to, deco: mark("cm-md-mark") });
            }
          }
        });
        return;
      }
      if (name === "CodeInfo") {
        parts.push({ from: node.from, to: node.to, deco: mark("cm-md-mark") });
        return;
      }
      if (name === "TableHeader") {
        eachLine(node, visible, (line) => addLineClass(line.from, "cm-md-table-head"));
        return;
      }
      if (name === "TableDelimiter") {
        eachLine(node, visible, (line) => {
          addLineClass(line.from, "cm-md-table-delim");
          parts.push({ from: line.from, to: line.to, deco: mark("cm-md-mark") });
        });
        return;
      }
      if (name === "TableRow") {
        eachLine(node, visible, (line) => addLineClass(line.from, "cm-md-table-row"));
        return;
      }
      if (name === "HorizontalRule") {
        if (revealed(node.from, node.to)) {
          parts.push({ from: node.from, to: node.to, deco: mark("cm-md-mark") });
        } else {
          parts.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new HrWidget() }),
          });
        }
        return;
      }
      if (name === "ListMark") {
        parts.push({ from: node.from, to: node.to, deco: mark("cm-md-mark") });
        return;
      }
      if (name === "TaskMarker") {
        const text = doc.sliceString(node.from, node.to);
        parts.push({
          from: node.from,
          to: node.to,
          deco: mark(/\[[xX]\]/.test(text) ? "cm-md-task-done" : "cm-md-mark"),
        });
        return;
      }
      if (name === "StrongEmphasis") {
        const text = doc.sliceString(node.from, node.to);
        const d = text.slice(0, 2);
        if ((d === "**" || d === "__") && text.slice(-2) === d) {
          inlineFmt(node, "cm-md-strong", 2, 2);
        } else {
          parts.push({ from: node.from, to: node.to, deco: mark("cm-md-strong") });
        }
        return;
      }
      if (name === "Emphasis") {
        const text = doc.sliceString(node.from, node.to);
        const d = text[0];
        if ((d === "*" || d === "_") && text[text.length - 1] === d) {
          inlineFmt(node, "cm-md-em", 1, 1);
        } else {
          parts.push({ from: node.from, to: node.to, deco: mark("cm-md-em") });
        }
        return;
      }
      if (name === "Strikethrough") {
        const text = doc.sliceString(node.from, node.to);
        if (text.startsWith("~~") && text.endsWith("~~")) {
          inlineFmt(node, "cm-md-strike", 2, 2);
        } else {
          parts.push({ from: node.from, to: node.to, deco: mark("cm-md-strike") });
        }
        return;
      }
      if (name === "InlineCode") {
        const text = doc.sliceString(node.from, node.to);
        const open = /^`+/.exec(text)?.[0].length ?? 0;
        const close = /`+$/.exec(text)?.[0].length ?? 0;
        if (open > 0 && open === close) {
          inlineFmt(node, "cm-md-code-inline", open, close);
        } else {
          parts.push({ from: node.from, to: node.to, deco: mark("cm-md-code-inline") });
        }
        return;
      }
      if (name === "Link") {
        renderLink(node);
        return;
      }
      if (name === "Image") {
        renderImage(node);
        return;
      }
      if (name === "URL") {
        // 显式链接/图片内部的 URL 由父节点统一处理；这里只管裸自动链接
        const parent = node.node.parent?.name;
        if (parent !== "Link" && parent !== "Image") {
          parts.push({ from: node.from, to: node.to, deco: mark("cm-md-link") });
        }
        return;
      }
    };

    for (const visible of view.visibleRanges) {
      tree.iterate({
        from: visible.from,
        to: visible.to,
        enter: (node) => visit(node, visible),
      });
    }

    if (lineClasses.size === 0 && parts.length === 0) {
      this.decorations = Decoration.none;
      return;
    }
    const ranges = [];
    for (const [pos, classes] of lineClasses) {
      ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(pos));
    }
    for (const part of parts) {
      ranges.push(part.deco.range(part.from, part.to));
    }
    this.decorations = Decoration.set(ranges, true);
  }
}

/** 即时渲染扩展：装饰 + 原子区间（隐藏符号/图片/水平线不可点击进内部） */
export const liveRenderExtension: Extension = ViewPlugin.fromClass(LiveRenderPlugin, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
    ),
});
