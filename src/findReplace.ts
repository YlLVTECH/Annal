// 查找 / 替换组件：VSCode 风格浮动面板（悬浮于编辑区右上角，不占用文档流高度）。
// 复用 @codemirror/search 的核心机制（SearchQuery / setSearchQuery / findNext 等），
// 仅通过 createPanel 替换默认的底部英文面板，UI 文案走应用 i18n。

import {
  keymap,
  runScopeHandlers,
  type EditorView,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";
import { t } from "./i18n";

export type FindFocus = "query" | "replace";

/** 当前编辑器对应的查找面板实例（面板销毁时置空，见 destroy） */
let panel: FindReplacePanel | null = null;

/** 编辑器扩展：搜索状态 + VSCode 风格面板 + 默认快捷键（含 Ctrl+H 进入替换） */
export function findReplaceExtension() {
  return [
    search({
      top: true,
      createPanel: (view) => (panel = new FindReplacePanel(view)),
    }),
    keymap.of([
      ...searchKeymap,
      { key: "Mod-h", run: (view) => openFindPanel(view, "replace"), scope: "editor search-panel" },
      { key: "Alt-c", run: toggleFromKeymap("case"), scope: "editor search-panel" },
      { key: "Alt-w", run: toggleFromKeymap("word"), scope: "editor search-panel" },
      { key: "Alt-r", run: toggleFromKeymap("re"), scope: "editor search-panel" },
    ]),
  ];
}

function toggleFromKeymap(opt: "case" | "word" | "re") {
  return () => {
    if (!panel) return false;
    panel.toggleOpt(opt);
    return true;
  };
}

/** 打开查找面板，并按需聚焦「替换为」输入框 */
export function openFindPanel(view: EditorView, focus: FindFocus): boolean {
  openSearchPanel(view);
  const p = panel;
  if (!p) return true;
  if (focus === "replace") {
    p.setReplaceMode(true);
    p.focusReplace();
  } else {
    p.focusQuery();
  }
  return true;
}

/** 关闭查找面板（面板未打开时为空操作） */
export function closeFindPanel(view: EditorView) {
  closeSearchPanel(view);
}

/** 语言切换后刷新面板文案（面板未打开时为空操作） */
export function refreshFindReplaceI18n() {
  panel?.refreshI18n();
}

/* ---------- 匹配区间统计 ---------- */

function computeMatches(state: EditorState, query: SearchQuery) {
  const ranges: Array<{ from: number; to: number }> = [];
  if (!query.valid) return ranges;
  try {
    const cursor = query.getCursor(state.doc);
    let next = cursor.next();
    while (!next.done) {
      ranges.push({ from: next.value.from, to: next.value.to });
      next = cursor.next();
    }
  } catch {
    ranges.length = 0;
  }
  return ranges;
}

/** 当前匹配序号（1 起）：优先取包含光标的匹配，否则取光标之后的下一个（循环） */
function currentMatchIndex(matches: Array<{ from: number; to: number }>, head: number): number {
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.from <= head && head <= m.to) return i + 1;
  }
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].from > head) return i + 1;
  }
  return matches.length ? 1 : 0;
}

/* ---------- 面板实现 ---------- */

const ICONS = {
  chevron:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>',
  prev:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>',
  next:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
};

class FindReplacePanel implements Panel {
  readonly dom: HTMLElement;

  private queryInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private countEl: HTMLSpanElement;
  private toggleReplaceBtn: HTMLButtonElement;
  private caseBtn: HTMLButtonElement;
  private wordBtn: HTMLButtonElement;
  private reBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private replaceBtn: HTMLButtonElement;
  private replaceAllBtn: HTMLButtonElement;

  private query: SearchQuery;
  private replaceMode = false;
  private countTimer = 0;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);

    this.dom = document.createElement("div");
    this.dom.className = "fr-widget";
    this.dom.setAttribute("role", "dialog");
    this.dom.addEventListener("keydown", (e) => this.keydown(e));

    const findRow = document.createElement("div");
    findRow.className = "fr-row";

    this.toggleReplaceBtn = this.iconButton(ICONS.chevron, "fr-chevron", () => {
      this.setReplaceMode(!this.replaceMode);
      this.queryInput.focus();
    });

    this.queryInput = document.createElement("input");
    this.queryInput.className = "fr-input";
    this.queryInput.type = "text";
    this.queryInput.setAttribute("main-field", "true");
    this.queryInput.spellcheck = false;
    this.queryInput.autocomplete = "off";
    this.queryInput.addEventListener("input", () => this.commit());

    this.countEl = document.createElement("span");
    this.countEl.className = "fr-count";

    this.caseBtn = this.iconButton("Aa", "fr-toggle", () => this.toggleOpt("case"));
    this.wordBtn = this.iconButton("ab|", "fr-toggle", () => this.toggleOpt("word"));
    this.reBtn = this.iconButton(".*", "fr-toggle", () => this.toggleOpt("re"));

    this.prevBtn = this.iconButton(ICONS.prev, "fr-nav", () => findPrevious(this.view));
    this.nextBtn = this.iconButton(ICONS.next, "fr-nav", () => findNext(this.view));
    this.closeBtn = this.iconButton(ICONS.close, "fr-close", () => closeSearchPanel(this.view));

    findRow.append(
      this.toggleReplaceBtn,
      this.queryInput,
      this.countEl,
      this.caseBtn,
      this.wordBtn,
      this.reBtn,
      this.prevBtn,
      this.nextBtn,
      this.closeBtn,
    );

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "fr-row fr-row-replace";
    this.replaceRow.hidden = true;

    const indent = document.createElement("span");
    indent.className = "fr-replace-indent";

    this.replaceInput = document.createElement("input");
    this.replaceInput.className = "fr-input";
    this.replaceInput.type = "text";
    this.replaceInput.spellcheck = false;
    this.replaceInput.autocomplete = "off";
    this.replaceInput.addEventListener("input", () => this.commit());

    this.replaceBtn = document.createElement("button");
    this.replaceBtn.type = "button";
    this.replaceBtn.className = "fr-btn";
    this.replaceBtn.addEventListener("click", () => replaceNext(this.view));

    this.replaceAllBtn = document.createElement("button");
    this.replaceAllBtn.type = "button";
    this.replaceAllBtn.className = "fr-btn";
    this.replaceAllBtn.addEventListener("click", () => replaceAll(this.view));

    this.replaceRow.append(indent, this.replaceInput, this.replaceBtn, this.replaceAllBtn);

    this.dom.append(findRow, this.replaceRow);

    this.refreshI18n();
    this.setQuery(this.query);
  }

  mount() {
    this.queryInput.focus();
    this.queryInput.select();
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value);
        }
      }
    }
    if (update.docChanged) this.scheduleCount();
    if (update.state.readOnly !== update.startState.readOnly && update.state.readOnly) {
      this.setReplaceMode(false);
    }
  }

  setQuery(query: SearchQuery) {
    this.query = query;
    this.queryInput.value = query.search;
    this.replaceInput.value = query.replace;
    this.caseBtn.classList.toggle("active", query.caseSensitive);
    this.wordBtn.classList.toggle("active", query.wholeWord);
    this.reBtn.classList.toggle("active", query.regexp);
    this.scheduleCount();
  }

  destroy() {
    window.clearTimeout(this.countTimer);
    panel = null;
  }

  get pos() {
    return 80;
  }

  get top() {
    return true;
  }

  /* ---------- 内部操作 ---------- */

  private iconButton(html: string, className: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `fr-icon ${className}`;
    b.innerHTML = html;
    b.addEventListener("click", onClick);
    return b;
  }

  private keydown(e: KeyboardEvent) {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && e.target === this.queryInput) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceInput) {
      e.preventDefault();
      replaceNext(this.view);
    }
  }

  private commit() {
    const query = new SearchQuery({
      search: this.queryInput.value,
      caseSensitive: this.caseBtn.classList.contains("active"),
      wholeWord: this.wordBtn.classList.contains("active"),
      regexp: this.reBtn.classList.contains("active"),
      replace: this.replaceInput.value,
    });
    if (!query.eq(this.query)) {
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  toggleOpt(opt: "case" | "word" | "re") {
    const btn = opt === "case" ? this.caseBtn : opt === "word" ? this.wordBtn : this.reBtn;
    btn.classList.toggle("active");
    this.commit();
    this.queryInput.focus();
  }

  setReplaceMode(show: boolean) {
    const on = show && !this.view.state.readOnly;
    if (on === this.replaceMode) return;
    this.replaceMode = on;
    this.replaceRow.hidden = !on;
    this.dom.classList.toggle("fr-replace-on", on);
    this.toggleReplaceBtn.classList.toggle("fr-open", on);
    this.toggleReplaceBtn.setAttribute("aria-expanded", String(on));
  }

  focusQuery() {
    this.queryInput.focus();
    this.queryInput.select();
  }

  focusReplace() {
    if (!this.replaceMode) this.setReplaceMode(true);
    if (this.replaceMode) {
      this.replaceInput.focus();
      this.replaceInput.select();
    } else {
      this.queryInput.focus();
    }
  }

  refreshI18n() {
    this.dom.setAttribute("aria-label", t("find.title"));
    this.queryInput.placeholder = t("find.placeholder");
    this.replaceInput.placeholder = t("find.replacePlaceholder");
    this.toggleReplaceBtn.title = t("find.toggleReplace");
    this.caseBtn.title = t("find.caseSensitive");
    this.wordBtn.title = t("find.wholeWord");
    this.reBtn.title = t("find.regexp");
    this.prevBtn.title = t("find.prev");
    this.nextBtn.title = t("find.next");
    this.closeBtn.title = t("find.close");
    this.replaceBtn.textContent = t("find.replace");
    this.replaceAllBtn.textContent = t("find.replaceAll");
  }

  private scheduleCount() {
    window.clearTimeout(this.countTimer);
    this.countTimer = window.setTimeout(() => this.updateCount(), 100);
  }

  private updateCount() {
    const state = this.view.state;
    const query = getSearchQuery(state);
    this.queryInput.classList.toggle("fr-input-invalid", query.regexp && !query.valid);
    if (!query.search) {
      this.countEl.textContent = "";
      return;
    }
    const matches = computeMatches(state, query);
    if (matches.length === 0) {
      this.countEl.textContent = "0/0";
      return;
    }
    const idx = currentMatchIndex(matches, state.selection.main.head);
    this.countEl.textContent = `${idx}/${matches.length}`;
  }
}
