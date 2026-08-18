import type { Align } from "./types";
import { t } from "./i18n";

/* 智能表格插入弹层 */
export const TABLE_GRID_ROWS = 8; // 网格选择器最大行数
export const TABLE_GRID_COLS = 10; // 网格选择器最大列数

const tablePopoverEl = document.querySelector<HTMLDivElement>("#table-popover")!;
const tableBtnEl = document.querySelector<HTMLButtonElement>('.tool-btn[data-cmd="table"]')!;
const tpSmartEl = document.querySelector<HTMLDivElement>("#tp-smart")!;
const tpSmartDescEl = document.querySelector<HTMLDivElement>("#tp-smart-desc")!;
const tpSmartApplyBtn = document.querySelector<HTMLButtonElement>("#tp-smart-apply")!;
const tpGridEl = document.querySelector<HTMLDivElement>("#tp-grid")!;
const tpSizeEl = document.querySelector<HTMLDivElement>("#tp-size")!;
const tpHeaderEl = document.querySelector<HTMLInputElement>("#tp-header")!;
const tpAlignBtns = document.querySelectorAll<HTMLButtonElement>(".tp-align-btn");

let tpCells: HTMLDivElement[] = [];
let tpCursorR = 3; // 当前高亮的行数（1 起）
let tpCursorC = 4; // 当前高亮的列数（1 起）
let tpAlign: Align = "left";
/** 打开弹层时识别到的选区数据（null 表示无可转换内容） */
let tpDetected: { rows: string[][]; aligns: string[] | null; label?: string } | null = null;

let onApplyTableCallback: ((text: string, cellStart: number, cellLen: number) => void) | null = null;
let getEditorSelection: (() => { text: string; hasEditor: boolean }) | null = null;

/** 估算显示宽度（CJK 全角字符按 2 计，用于对齐补空格） */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u3000-\u303f]/.test(
      ch,
    )
      ? 2
      : 1;
  }
  return w;
}

export function padCell(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - dispWidth(s)));
}

/**
 * 把二维单元格数据渲染成对齐规整的 Markdown 表格。
 */
export function buildTableMarkdown(
  rows: string[][],
  aligns: string[],
  defaultAlign: Align,
): { text: string; firstCellStart: number; firstCellLen: number } {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r\n?|\n/g, "<br>");
  const escaped = rows.map((r) => r.map(esc));
  const cols = rows[0].length;

  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 3; // 分隔行最短 3 字符
    for (const row of escaped) w = Math.max(w, dispWidth(row[c] ?? ""));
    widths.push(w);
  }

  const alignOf = (c: number): string => aligns[c] ?? defaultAlign;
  const renderRow = (cells: string[]) =>
    "| " + cells.map((cell, c) => padCell(cell, widths[c])).join(" | ") + " |";

  const sepCells = widths.map((w, c) => {
    const a = alignOf(c);
    if (a === "center") return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
    if (a === "right") return "-".repeat(Math.max(1, w - 1)) + ":";
    return "-".repeat(w);
  });

  const lines: string[] = [renderRow(escaped[0])];
  lines.push("| " + sepCells.join(" | ") + " |");
  for (let r = 1; r < escaped.length; r++) lines.push(renderRow(escaped[r]));

  const text = lines.join("\n");
  const first = escaped[0][0] ?? "";
  const firstLine = lines[0];
  const firstCellStart = first === "" ? firstLine.indexOf("| ") + 2 : firstLine.indexOf(first);
  return { text, firstCellStart, firstCellLen: first.length };
}

/** 引用感知的分隔符切分（处理 "a,b" 与 "" 转义） */
export function parseQuotedLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** 竖线分隔：Markdown 风格行（首尾带 |）去掉外侧空单元格 */
export function splitPipeLine(line: string): string[] {
  const cells = line.split("|").map((s) => s.trim());
  const markdownish = /^\s*\|/.test(line) || /\|\s*$/.test(line);
  if (markdownish) {
    if (cells[0] === "") cells.shift();
    if (cells[cells.length - 1] === "") cells.pop();
  }
  return cells;
}

export const SMART_DELIMS = [
  { key: "tab", ch: "\t", quoted: false },
  { key: "pipe", ch: "|", quoted: false },
  { key: "comma", ch: ",", quoted: true },
  { key: "semicolon", ch: ";", quoted: true },
  { key: "chineseComma", ch: "，", quoted: true },
  { key: "chineseSemicolon", ch: "；", quoted: true },
] as const;

export function getDelimLabel(d: { key: string }): string {
  return t(`table.delim.${d.key}`);
}

export const MD_SEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * 智能识别选区文本
 */
export function detectTableData(
  text: string,
): { rows: string[][]; aligns: string[] | null; label?: string } | null {
  const norm = text.replace(/\r\n?/g, "\n");
  const lines = norm
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;

  // 已是 Markdown 表格：跳过分隔行，保留逐列对齐
  if (lines.some((l) => l.includes("|")) && lines.some((l) => MD_SEP_RE.test(l))) {
    const rows: string[][] = [];
    let aligns: string[] | null = null;
    for (const line of lines) {
      if (MD_SEP_RE.test(line)) {
        aligns = line
          .split("|")
          .filter((s) => s.trim() !== "")
          .map((s) => {
            const t = s.trim();
            if (t.startsWith(":") && t.endsWith(":")) return "center";
            if (t.endsWith(":")) return "right";
            return "left";
          });
        continue;
      }
      const cells = line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim());
      rows.push(cells);
    }
    if (
      rows.length >= 1 &&
      rows[0].length >= 1 &&
      rows.every((r) => r.length === rows[0].length)
    ) {
      return { rows, aligns };
    }
    return null;
  }

  // 普通分隔数据：选一致性得分最高的分隔符
  let best: { rows: string[][]; consistent: number; label: string } | null = null;
  for (const d of SMART_DELIMS) {
    if (!lines.some((l) => l.includes(d.ch))) continue;
    const parsed = lines.map((l) =>
      d.quoted ? parseQuotedLine(l, d.ch) : d.ch === "|" ? splitPipeLine(l) : l.split(d.ch).map((s) => s.trim()),
    );
    const counts = new Map<number, number>();
    for (const row of parsed) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    let modal = 0;
    let modalCount = 0;
    for (const [n, cnt] of counts) {
      if (cnt > modalCount) {
        modal = n;
        modalCount = cnt;
      }
    }
    if (modal < 2 || modalCount < 2) continue;
    const consistent = parsed.filter((r) => r.length === modal).length;
    if (!best || consistent > best.consistent) {
      best = { rows: parsed.filter((r) => r.length === modal), consistent, label: getDelimLabel(d) };
    }
  }
  if (!best) return null;
  return { rows: best.rows, aligns: null, label: best.label };
}

/** 数字 / 金额 / 百分比类内容（用于自动右对齐数字列） */
export function isNumericLike(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return (
    /^[+-]?\d[\d,]*[.]?\d*%?$/.test(t) ||
    /^[¥$€£￥]\s?[+-]?\d[\d,]*(?:[.]\d+)?%?$/.test(t) ||
    /^[+-]?\d[\d,]*(?:[.]\d+)?\s?[%％]$/.test(t)
  );
}

export function closeTablePopover() {
  tablePopoverEl.hidden = true;
}

export function isTablePopoverOpen(): boolean {
  return !tablePopoverEl.hidden;
}

function applyTableText(rows: string[][], aligns: string[] | null) {
  const perCol = aligns ?? [];
  const built = buildTableMarkdown(rows, perCol, tpAlign);
  closeTablePopover();
  if (onApplyTableCallback) {
    onApplyTableCallback(built.text, built.firstCellStart, built.firstCellLen);
  }
}

function insertGridTable() {
  const rows: string[][] = [];
  for (let r = 0; r < tpCursorR; r++) {
    rows.push(
      Array.from({ length: tpCursorC }, (_, c) =>
        r === 0 && tpHeaderEl.checked ? t("table.headerCell", { col: c + 1 }) : t("table.cell"),
      ),
    );
  }
  applyTableText(rows, null);
}

function applySmartTable() {
  if (!tpDetected) return;
  const { rows, aligns } = tpDetected;
  let perCol: string[] | null = aligns;
  if (!perCol) {
    const body = tpHeaderEl.checked ? rows.slice(1) : rows;
    perCol = rows[0].map((_, c) =>
      body.length > 0 && body.every((r) => isNumericLike(r[c] ?? "")) ? "right" : tpAlign,
    );
  }
  applyTableText(rows, perCol);
}

function setTpCursor(r: number, c: number) {
  tpCursorR = Math.max(1, Math.min(TABLE_GRID_ROWS, r));
  tpCursorC = Math.max(1, Math.min(TABLE_GRID_COLS, c));
  for (const cell of tpCells) {
    const cr = Number(cell.dataset.r);
    const cc = Number(cell.dataset.c);
    cell.classList.toggle("hover", cr <= tpCursorR && cc <= tpCursorC);
  }
  tpSizeEl.textContent = t("table.size", { rows: tpCursorR, cols: tpCursorC });
}

function buildTpGrid() {
  tpGridEl.innerHTML = "";
  for (let r = 1; r <= TABLE_GRID_ROWS; r++) {
    for (let c = 1; c <= TABLE_GRID_COLS; c++) {
      const cell = document.createElement("div");
      cell.className = "tp-cell";
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.setAttribute("role", "gridcell");
      tpGridEl.appendChild(cell);
    }
  }
  tpCells = Array.from(tpGridEl.children) as HTMLDivElement[];
  setTpCursor(tpCursorR, tpCursorC);
}

function persistTableOpts() {
  localStorage.setItem(
    "notebook:table-opts",
    JSON.stringify({ header: tpHeaderEl.checked, align: tpAlign }),
  );
}

function loadTableOpts() {
  try {
    const o = JSON.parse(localStorage.getItem("notebook:table-opts") ?? "null") as
      | { header?: boolean; align?: Align }
      | null;
    if (o && typeof o === "object") {
      if (o.header === false) tpHeaderEl.checked = false;
      if (o.align === "center" || o.align === "right") tpAlign = o.align;
    }
  } catch {
    // 存储损坏则用默认值
  }
  for (const b of tpAlignBtns) b.classList.toggle("active", b.dataset.align === tpAlign);
}

export function openTablePopover() {
  if (!getEditorSelection) return;
  const selInfo = getEditorSelection();
  if (!selInfo.hasEditor) return;

  const sel = selInfo.text;
  tpDetected = sel.trim() ? detectTableData(sel) : null;
  if (tpDetected) {
    const n = tpDetected.rows.length;
    const m = tpDetected.rows[0].length;
    tpSmartEl.hidden = false;
    if (tpDetected.aligns) {
      tpSmartDescEl.textContent = t("table.smartDetectedMd", { rows: n, cols: m });
      tpSmartApplyBtn.textContent = t("table.smartApply");
    } else {
      tpSmartDescEl.textContent = t("table.smartDetectedData", { rows: n, cols: m, label: tpDetected.label ?? "" });
      tpSmartApplyBtn.textContent = t("table.smartApply");
    }
  } else {
    tpSmartEl.hidden = true;
  }

  tablePopoverEl.hidden = false;
  tablePopoverEl.style.visibility = "hidden";
  const rect = tableBtnEl.getBoundingClientRect();
  const w = tablePopoverEl.offsetWidth;
  const h = tablePopoverEl.offsetHeight;
  tablePopoverEl.style.visibility = "";
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
  const top =
    rect.bottom + h + 8 > window.innerHeight
      ? Math.max(8, rect.top - h - 8)
      : rect.bottom + 6;
  tablePopoverEl.style.left = `${left}px`;
  tablePopoverEl.style.top = `${top}px`;
  setTpCursor(tpCursorR, tpCursorC);
  tpGridEl.focus();
}

export function toggleTablePopover() {
  if (tablePopoverEl.hidden) openTablePopover();
  else closeTablePopover();
}

export function initTablePopover(
  applyCallback: (text: string, cellStart: number, cellLen: number) => void,
  getSel: () => { text: string; hasEditor: boolean },
) {
  onApplyTableCallback = applyCallback;
  getEditorSelection = getSel;

  buildTpGrid();
  loadTableOpts();
  tpHeaderEl.addEventListener("change", persistTableOpts);
  for (const b of tpAlignBtns) {
    b.addEventListener("click", () => {
      tpAlign = (b.dataset.align as Align) || "left";
      for (const x of tpAlignBtns) x.classList.toggle("active", x === b);
      persistTableOpts();
    });
  }
  tpSmartApplyBtn.addEventListener("click", applySmartTable);
  tpGridEl.addEventListener("mousemove", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".tp-cell");
    if (cell) setTpCursor(Number(cell.dataset.r), Number(cell.dataset.c));
  });
  tpGridEl.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".tp-cell");
    if (!cell) return;
    setTpCursor(Number(cell.dataset.r), Number(cell.dataset.c));
    insertGridTable();
  });
  tpGridEl.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowUp") {
      e.preventDefault();
      setTpCursor(tpCursorR - 1, tpCursorC);
    } else if (k === "ArrowDown") {
      e.preventDefault();
      setTpCursor(tpCursorR + 1, tpCursorC);
    } else if (k === "ArrowLeft") {
      e.preventDefault();
      setTpCursor(tpCursorR, tpCursorC - 1);
    } else if (k === "ArrowRight") {
      e.preventDefault();
      setTpCursor(tpCursorR, tpCursorC + 1);
    } else if (k === "Enter" || k === " ") {
      e.preventDefault();
      insertGridTable();
    } else if (k === "Escape") {
      closeTablePopover();
    }
  });

  window.addEventListener(
    "mousedown",
    (e) => {
      const onTableBtn = !!(e.target as HTMLElement).closest?.(
        '.tool-btn[data-cmd="table"]',
      );
      if (!tablePopoverEl.hidden && !tablePopoverEl.contains(e.target as Node) && !onTableBtn) {
        closeTablePopover();
      }
    },
    true,
  );
  window.addEventListener("blur", closeTablePopover);
  window.addEventListener("resize", closeTablePopover);
  window.addEventListener("scroll", closeTablePopover, true);
}
