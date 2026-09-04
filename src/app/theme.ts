// 主题协调器：明暗主题应用与切换（设置面板里的主题模式解析也走这里）。

const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

const themeToggleBtn = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
const themeIconEl = themeToggleBtn.querySelector<HTMLSpanElement>(".titlebar-icon")!;

export function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  themeIconEl.innerHTML = theme === "dark" ? SUN_SVG : MOON_SVG;
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("annal:theme", next);
  localStorage.setItem("annal:theme-mode", next);
}

// 配色方案：仅作用于浅色主题（styles.css 中 html[data-theme="light"][data-palette="..."] 变量块），
// 深色主题保持默认。新增方案 = styles.css 加一个变量块 + 这里加一个条目 + i18n 补 settings.palette.<id>。
export interface PaletteOption {
  id: string;
  /** 设置面板色板用：按分层顺序取色（外层底 -> 面板底 -> 边框 -> 强调色） */
  swatch: [string, string, string, string];
}

export const PALETTE_OPTIONS: PaletteOption[] = [
  { id: "classic", swatch: ["#f6f6f4", "#ffffff", "#d9d9d5", "#2563eb"] },
  { id: "sakura", swatch: ["#ffe3e1", "#fff5e4", "#ffd1d1", "#ff9494"] },
  { id: "mist", swatch: ["#c8dfdb", "#f2efe7", "#66a3bf", "#3368a0"] },
];

export function applyPalette(id: string) {
  const known = PALETTE_OPTIONS.some((p) => p.id === id);
  document.documentElement.dataset.palette = known ? id : "classic";
}

export function getSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export function initTheme() {
  themeToggleBtn.addEventListener("click", toggleTheme);
}
