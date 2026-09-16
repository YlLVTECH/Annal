// 即时渲染（Live Preview）扩展：基于 Lezer Markdown 语法树，在编辑器内直接渲染样式。
// 行为对标 Typora / Obsidian 实时预览：
// - 标题、引用、列表、围栏代码块、表格（源码形态）等以行级装饰直接呈现版式；
// - 行内语法（**粗体**、*斜体*、~~删除线~~、`代码`、[链接](url)）在光标离开时
//   隐藏源码符号、渲染内容样式；光标（选区）触及该节点时回退为源码显示；
// - ![图片](path) 光标离开时渲染为内联图片（复用预览的 asset 协议解析）；
// - 表格光标离开时整块替换为渲染后的 HTML 表格（TableWidget），触及回退源码；
// - 分隔线光标离开时渲染为水平线。
//
// 性能与热路径约束：
// - 只为可见视口构建装饰，滚动/输入/移动光标时按视口重算，不引入 O(全文) 工作；
// - 语法树由编辑器已启用的 markdown() 语言增量维护（打字时 Lezer 只重解析受影响块）；
// - 装饰拆成三部分（见下），只重算受本次更新影响的那部分；
// - 隐藏符号的 replace 装饰同时注册为 atomicRanges，方向键会自然跳过不可见符号。
//
// 装饰的划分依据是"是否依赖选区"以及"是否为块级装饰"：
// - 静态组（LiveRenderStatic）：行类（标题/引用/代码块/表格）与永远可见的源码符号
//   淡化标记（列表符号、引用前缀、围栏标记等）——只在文档/视口/语法树变化时重建；
// - 选区组（LiveRenderSel）：光标触及即回退源码的隐藏符号、图片与水平线 widget——
//   光标移动（selectionSet）时只重建这一组，静态组保持不动；
// - 表格块装饰（LiveRenderTables + tableDecoField）：块级替换装饰**不允许由插件提供**
//   （@codemirror/view 的 TileUpdate.emit 对动态装饰源抛
//   "Block decorations may not be specified via plugins"，只有 state field /
//   静态 facet 值才允许），因此插件只负责算视口内的表格区间，经 effect 写回
//   state field，由字段通过 EditorView.decorations.from 提供给视图。

import { syntaxTree } from "@codemirror/language";
import {
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import { getRenderBaseDir, renderSnippetHtml, resolveImgSrc } from "./markdownModel";

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

/** 表格 widget：光标离开表格时把整块源码替换为渲染后的 HTML 表格。
 *  渲染复用预览管线（marked + DOMPurify），单元格内的行内语法一并呈现；
 *  点击 widget 会映射到表格边界、选区触及后回退源码进入编辑。 */
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly baseDir: string,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source && other.baseDir === this.baseDir;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-rendered markdown-body";
    wrap.innerHTML = renderSnippetHtml(this.source, this.baseDir);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/* ---------- 表格块装饰：state field 承载 + 插件算视口 ---------- */

/** 表格节点 → 行对齐的替换区间（块装饰必须整行覆盖，否则渲染错乱） */
function tableBlockRange(doc: Text, node: SyntaxNodeRef): Span | null {
  const from = doc.lineAt(node.from).from;
  const endLine = doc.lineAt(node.to);
  // node.to 正好落在下一行行首时，区间应收在上一行行尾
  const to = endLine.from === node.to && node.to > from ? doc.lineAt(node.to - 1).to : endLine.to;
  return to > from ? { from, to } : null;
}

/** 装饰区间是否严格覆盖整行（映射后的旧装饰可能因跨行编辑而错位） */
function isLineAligned(doc: Text, from: number, to: number): boolean {
  return doc.lineAt(from).from === from && doc.lineAt(to).to === to;
}

/** 插件算出的表格装饰写回字段用的事务效果 */
const setTableDecos = StateEffect.define<DecorationSet>();

/** 表格块装饰字段：块装饰只能由 state field（静态装饰源）提供，见文件头说明。
 *  文档变更时先把旧装饰映射到新位置，再等插件按视口重算覆盖。 */
const tableDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    if (tr.docChanged) {
      decos = decos
        .map(tr.changes)
        .update({ filter: (from, to) => isLineAligned(tr.state.doc, from, to) });
    }
    for (const effect of tr.effects) {
      if (effect.is(setTableDecos)) decos = effect.value;
    }
    return decos;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 两份表格装饰是否等价：避免每次光标移动/滚动都派发无意义的事务 */
function sameTableDecos(a: DecorationSet, b: DecorationSet): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  const ai = a.iter();
  const bi = b.iter();
  for (;;) {
    const av = ai.value;
    const bv = bi.value;
    if (!av || !bv) return !av && !bv;
    if (ai.from !== bi.from || ai.to !== bi.to) return false;
    const wa = av.spec.widget as WidgetType | undefined;
    const wb = bv.spec.widget as WidgetType | undefined;
    if (!wa || !wb) {
      if (wa !== wb) return false;
    } else if (!wa.eq(wb)) {
      return false;
    }
    ai.next();
    bi.next();
  }
}

/* ---------- 共享遍历工具 ---------- */

type LineCb = (line: { from: number; to: number; text: string }, first: boolean, last: boolean) => void;

/** 遍历节点行区间与可见区交集内的每一行；回调附带是否为节点首/末行 */
function eachLine(
  doc: Text,
  node: SyntaxNodeRef,
  visible: Span,
  cb: LineCb,
): void {
  const start = Math.max(node.from, visible.from);
  const end = Math.min(node.to, visible.to);
  if (start > end) return;
  // lineAt：这里拿到的是文档位置，不能直接喂给 doc.line（它要的是行号）
  const firstNo = doc.lineAt(start).number;
  const lastNo = doc.lineAt(end).number;
  for (let no = firstNo; no <= lastNo; no++) {
    const line = doc.line(no);
    cb(line, line.from <= node.from, line.to >= node.to);
  }
}

/** 语法树是否在本次更新中发生了变化（覆盖懒解析在后台补全的场景） */
function treeChanged(update: ViewUpdate): boolean {
  return syntaxTree(update.startState) !== syntaxTree(update.state);
}

/* ---------- 静态组：行类装饰 + 与选区无关的符号淡化 ---------- */

class LiveRenderStatic {
  decorations: DecorationSet = Decoration.none;

  constructor(readonly view: EditorView) {
    this.build();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || treeChanged(update)) {
      this.build();
    }
  }

  private build() {
    const view = this.view;
    const doc = view.state.doc;
    if (doc.length === 0) {
      this.decorations = Decoration.none;
      return;
    }
    const tree = syntaxTree(view.state);
    const lineClasses = new Map<number, Set<string>>();
    const parts: { from: number; to: number; deco: Decoration }[] = [];

    const addLineClass = (pos: number, cls: string) => {
      let set = lineClasses.get(pos);
      if (!set) {
        set = new Set();
        lineClasses.set(pos, set);
      }
      set.add(cls);
    };

    const visit = (node: SyntaxNodeRef, visible: Span) => {
      const name = node.name;
      if (name.startsWith("ATXHeading")) {
        const level = Number(name.slice(-1));
        addLineClass(doc.lineAt(node.from).from, `cm-md-h${level}`);
        return;
      }
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        const level = name === "SetextHeading1" ? 1 : 2;
        eachLine(doc, node, visible, (line, _first, last) => {
          addLineClass(line.from, `cm-md-h${level}`);
          // 末行的下划线（=== / ---）整行淡化
          if (last && node.to > node.from + (line.to - line.from)) {
            parts.push({ from: line.from, to: line.to, deco: mark("cm-md-mark") });
          }
        });
        return;
      }
      if (name === "Blockquote") {
        eachLine(doc, node, visible, (line) => {
          addLineClass(line.from, "cm-md-quote");
          const m = /^([ \t]*>[ \t]*)+/.exec(line.text);
          if (m) {
            parts.push({ from: line.from, to: line.from + m[0].length, deco: mark("cm-md-mark") });
          }
        });
        return;
      }
      if (name === "FencedCode") {
        eachLine(doc, node, visible, (line, first, last) => {
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
        eachLine(doc, node, visible, (line) => addLineClass(line.from, "cm-md-table-head"));
        return;
      }
      if (name === "TableDelimiter") {
        // 只处理分隔行（| --- |）：父节点为 Table 的才是分隔行，
        // 单元格内的竖线（父为 TableHeader/TableRow）不淡化整行
        if (node.node.parent?.name !== "Table") return;
        eachLine(doc, node, visible, (line) => {
          addLineClass(line.from, "cm-md-table-delim");
          parts.push({ from: line.from, to: line.to, deco: mark("cm-md-mark") });
        });
        return;
      }
      if (name === "TableRow") {
        eachLine(doc, node, visible, (line) => addLineClass(line.from, "cm-md-table-row"));
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

/* ---------- 选区组：光标触及即回退源码的符号 + 内联 widget ---------- */

class LiveRenderSel {
  decorations: DecorationSet = Decoration.none;

  constructor(readonly view: EditorView) {
    this.build();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || treeChanged(update)) {
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
    const parts: { from: number; to: number; deco: Decoration }[] = [];

    const revealed = (from: number, to: number) => touchesSelection(selection, from, to);

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

    const visit = (node: SyntaxNodeRef) => {
      const name = node.name;
      if (name.startsWith("ATXHeading")) {
        const line = doc.lineAt(node.from);
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
    };

    for (const visible of view.visibleRanges) {
      tree.iterate({
        from: visible.from,
        to: visible.to,
        enter: visit,
      });
    }

    if (parts.length === 0) {
      this.decorations = Decoration.none;
      return;
    }
    this.decorations = Decoration.set(
      parts.map((p) => p.deco.range(p.from, p.to)),
      true,
    );
  }
}

/* ---------- 表格块装饰插件：算视口内的表格，经 effect 写回字段 ---------- */

class LiveRenderTables {
  private scheduled = false;
  private destroyed = false;

  constructor(readonly view: EditorView) {
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || treeChanged(update)) {
      this.schedule();
    }
  }

  destroy() {
    this.destroyed = true;
  }

  /** 派发事务要等本次更新结束后再做（update 过程中再 dispatch 会抛错），
   *  用微任务：同一帧内完成，不会出现"先源码后表格"的闪烁。 */
  private schedule() {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.destroyed) return;
      const next = this.build();
      const current = this.view.state.field(tableDecoField, false) ?? Decoration.none;
      if (sameTableDecos(next, current)) return;
      this.view.dispatch({ effects: setTableDecos.of(next) });
    });
  }

  private build(): DecorationSet {
    const view = this.view;
    const doc = view.state.doc;
    if (doc.length === 0) return Decoration.none;
    const selection = view.state.selection;
    const tree = syntaxTree(view.state);
    const ranges: Range<Decoration>[] = [];

    // 只装饰"当前会被渲染"的视口范围：块 widget 一旦进入视口就会被测量，
    // 高度表用的是真实高度；若把装饰放到视口之外，那些 widget 只能用估算高度，
    // 滚动到它们时会跳位。块装饰不会改变自身起始位置，所以按视口增删不会抖动。
    for (const visible of view.visibleRanges) {
      tree.iterate({
        from: visible.from,
        to: visible.to,
        enter: (node) => {
          if (node.name !== "Table") return;
          const span = tableBlockRange(doc, node);
          if (!span) return;
          // 选区触及表格（含边界）时回退源码，单元格内的行内语法交给选区组装饰
          if (touchesSelection(selection, span.from, span.to)) return;
          ranges.push(
            Decoration.replace({
              widget: new TableWidget(doc.sliceString(span.from, span.to), getRenderBaseDir()),
              block: true,
            }).range(span.from, span.to),
          );
        },
      });
    }

    return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
  }
}

/** 即时渲染扩展：静态/选区两组插件装饰 + 表格块装饰字段 + 原子区间
 *  （隐藏符号/图片/水平线与符号淡化标记均不可点击进内部） */
export const liveRenderExtension: Extension = [
  tableDecoField,
  ViewPlugin.fromClass(LiveRenderStatic, {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
      ),
  }),
  ViewPlugin.fromClass(LiveRenderSel, {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
      ),
  }),
  ViewPlugin.fromClass(LiveRenderTables),
  EditorView.atomicRanges.of(
    (view) => view.state.field(tableDecoField, false) ?? Decoration.none,
  ),
];
