// 设置协调器：读取 localStorage -> 更新信号/DOM，并绑定设置面板事件。

import {
  closeSettings,
  openSettings,
  switchSettingsCategory,
  syncSettingsUI,
} from "../dialogs";
import { setLineNumbersEnabled, setViewMode } from "../editor";
import { bus } from "../events";
import { refreshFindReplaceI18n } from "../findReplace";
import { applyI18nToDocument, setLocale } from "../i18n";
import { contentDensity, sidebarWidth } from "../state";
import { parseViewMode } from "../types";
import { readContentDensity } from "../utils";
import { applyPalette, applyTheme, getSystemTheme, PALETTE_OPTIONS } from "./theme";

let autosaveEnabled = true;
let autosaveDelayMs = 500;

export function isAutosaveEnabled(): boolean {
  return autosaveEnabled;
}

export function getAutosaveDelay(): number {
  return autosaveDelayMs;
}

/** localStorage 设置 -> 运行时信号 / DOM */
export function applySettings() {
  autosaveEnabled = localStorage.getItem("annal:autosave") !== "0";
  autosaveDelayMs = Number(localStorage.getItem("annal:autosave-delay")) || 500;

  const themeMode = localStorage.getItem("annal:theme-mode") || "system";
  let resolvedTheme: "light" | "dark" = "light";
  if (themeMode === "dark") resolvedTheme = "dark";
  else if (themeMode === "system") resolvedTheme = getSystemTheme();
  applyTheme(resolvedTheme);
  applyPalette(localStorage.getItem("annal:palette") || "classic");

  setViewMode(parseViewMode(localStorage.getItem("annal:view")));

  const fontSize = localStorage.getItem("annal:font-size") || "15.5";
  document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);

  // 界面字体：serif（默认）/ sans，通过 data 属性切换 --font-ui 变量
  document.documentElement.dataset.fontFamily =
    localStorage.getItem("annal:font-family") || "serif";

  contentDensity.set(readContentDensity());
  document.documentElement.dataset.contentDensity = contentDensity.get();

  const width = Number(localStorage.getItem("annal:sidebar-width")) || 260;
  sidebarWidth.set(Math.min(Math.max(width, 210), 460));

  setLineNumbersEnabled(localStorage.getItem("annal:line-numbers") !== "0");
}

/** 构建"配色方案"色板选项（按钮内容含 data-i18n，构建后需跑一次 applyI18nToDocument） */
function buildPaletteOptions(container: HTMLElement | null) {
  if (!container) return;
  const current = localStorage.getItem("annal:palette") || "classic";
  for (const palette of PALETTE_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-option";
    btn.dataset.paletteId = palette.id;
    btn.setAttribute("role", "radio");
    btn.dataset.i18nTitle = `settings.palette.${palette.id}`;
    btn.setAttribute("aria-checked", palette.id === current ? "true" : "false");
    if (palette.id === current) btn.classList.add("active");
    const swatch = document.createElement("span");
    swatch.className = "palette-swatch";
    swatch.setAttribute("aria-hidden", "true");
    const [s1, s2, s3, s4] = palette.swatch;
    swatch.style.cssText = `--sw-1:${s1};--sw-2:${s2};--sw-3:${s3};--sw-4:${s4}`;
    const name = document.createElement("span");
    name.className = "palette-name";
    name.dataset.i18n = `settings.palette.${palette.id}`;
    btn.append(swatch, name);
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      localStorage.setItem("annal:palette", palette.id);
      applyPalette(palette.id);
      for (const other of container.querySelectorAll<HTMLButtonElement>(".palette-option")) {
        const active = other === btn;
        other.classList.toggle("active", active);
        other.setAttribute("aria-checked", active ? "true" : "false");
      }
    });
    container.appendChild(btn);
  }
  applyI18nToDocument();
}

export function initSettings() {
  const settingsToggleBtn = document.querySelector<HTMLButtonElement>("#settings-toggle")!;
  let settingsEls = syncSettingsUI();
  settingsToggleBtn.addEventListener("click", openSettings);
  document.getElementById("settings-close")?.addEventListener("click", closeSettings);
  document.getElementById("settings-overlay")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "settings-overlay") closeSettings();
  });
  document.getElementById("settings-sidebar")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".settings-nav-item");
    if (!btn) return;
    const category = btn.dataset.category;
    if (!category) return;
    switchSettingsCategory(category);
    localStorage.setItem("annal:settings-category", category);
  });

  settingsEls.theme.addEventListener("change", () => {
    localStorage.setItem("annal:theme-mode", settingsEls.theme.value);
    applySettings();
  });
  buildPaletteOptions(document.getElementById("setting-palette"));
  settingsEls.view.addEventListener("change", () => setViewMode(settingsEls.view.value));
  settingsEls.contentDensity.addEventListener("change", () => {
    localStorage.setItem("annal:content-density", settingsEls.contentDensity.value);
    applySettings();
    bus.emit("preview:invalidate", undefined);
  });
  settingsEls.fontSize.addEventListener("change", () => {
    localStorage.setItem("annal:font-size", settingsEls.fontSize.value);
    applySettings();
    bus.emit("preview:invalidate", undefined);
  });
  settingsEls.fontFamily.addEventListener("change", () => {
    localStorage.setItem("annal:font-family", settingsEls.fontFamily.value);
    applySettings();
  });
  settingsEls.autosave.addEventListener("change", () => {
    localStorage.setItem("annal:autosave", settingsEls.autosave.checked ? "1" : "0");
    applySettings();
  });
  settingsEls.autosaveDelay.addEventListener("change", () => {
    localStorage.setItem("annal:autosave-delay", settingsEls.autosaveDelay.value);
    applySettings();
  });
  settingsEls.sidebarWidth.addEventListener("change", () => {
    localStorage.setItem("annal:sidebar-width", settingsEls.sidebarWidth.value);
    applySettings();
  });
  settingsEls.lineNumbers.addEventListener("change", () => {
    localStorage.setItem("annal:line-numbers", settingsEls.lineNumbers.checked ? "1" : "0");
    setLineNumbersEnabled(settingsEls.lineNumbers.checked);
  });
  settingsEls.language.addEventListener("change", async () => {
    await setLocale(settingsEls.language.value);
    applyI18nToDocument();
    refreshFindReplaceI18n();
    bus.emit("app:locale", undefined);
    settingsEls = syncSettingsUI();
    openSettings();
  });
}
