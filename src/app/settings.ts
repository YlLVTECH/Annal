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
import { applyTheme, getSystemTheme } from "./theme";

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
  autosaveEnabled = localStorage.getItem("notebook:autosave") !== "0";
  autosaveDelayMs = Number(localStorage.getItem("notebook:autosave-delay")) || 500;

  const themeMode = localStorage.getItem("notebook:theme-mode") || "system";
  let resolvedTheme: "light" | "dark" = "light";
  if (themeMode === "dark") resolvedTheme = "dark";
  else if (themeMode === "system") resolvedTheme = getSystemTheme();
  applyTheme(resolvedTheme);

  setViewMode(parseViewMode(localStorage.getItem("notebook:view")));

  const fontSize = localStorage.getItem("notebook:font-size") || "15.5";
  document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);

  // 界面字体：serif（默认）/ sans，通过 data 属性切换 --font-ui 变量
  document.documentElement.dataset.fontFamily =
    localStorage.getItem("notebook:font-family") || "serif";

  contentDensity.set(readContentDensity());
  document.documentElement.dataset.contentDensity = contentDensity.get();

  const width = Number(localStorage.getItem("notebook:sidebar-width")) || 260;
  sidebarWidth.set(Math.min(Math.max(width, 210), 460));

  setLineNumbersEnabled(localStorage.getItem("notebook:line-numbers") !== "0");
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
    localStorage.setItem("notebook:settings-category", category);
  });

  settingsEls.theme.addEventListener("change", () => {
    localStorage.setItem("notebook:theme-mode", settingsEls.theme.value);
    applySettings();
  });
  settingsEls.view.addEventListener("change", () => setViewMode(settingsEls.view.value));
  settingsEls.contentDensity.addEventListener("change", () => {
    localStorage.setItem("notebook:content-density", settingsEls.contentDensity.value);
    applySettings();
    bus.emit("preview:invalidate", undefined);
  });
  settingsEls.fontSize.addEventListener("change", () => {
    localStorage.setItem("notebook:font-size", settingsEls.fontSize.value);
    applySettings();
    bus.emit("preview:invalidate", undefined);
  });
  settingsEls.fontFamily.addEventListener("change", () => {
    localStorage.setItem("notebook:font-family", settingsEls.fontFamily.value);
    applySettings();
  });
  settingsEls.autosave.addEventListener("change", () => {
    localStorage.setItem("notebook:autosave", settingsEls.autosave.checked ? "1" : "0");
    applySettings();
  });
  settingsEls.autosaveDelay.addEventListener("change", () => {
    localStorage.setItem("notebook:autosave-delay", settingsEls.autosaveDelay.value);
    applySettings();
  });
  settingsEls.sidebarWidth.addEventListener("change", () => {
    localStorage.setItem("notebook:sidebar-width", settingsEls.sidebarWidth.value);
    applySettings();
  });
  settingsEls.lineNumbers.addEventListener("change", () => {
    localStorage.setItem("notebook:line-numbers", settingsEls.lineNumbers.checked ? "1" : "0");
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
