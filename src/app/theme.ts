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
  localStorage.setItem("notebook:theme", next);
  localStorage.setItem("notebook:theme-mode", next);
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
