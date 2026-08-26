// 窗口/应用生命周期协调器：自定义标题栏、响应式侧栏、失焦/离开冲刷、关闭握手。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resetSaveStatus } from "../editor";
import { clearSelection, setResponsiveSidebarHidden } from "../sidebar";
import { closing, dirty, selectedIds } from "../state";
import { flushSave } from "./save";

export function initWindowCoordinator(): void {
  const win = getCurrentWindow();
  const winMinBtn = document.querySelector<HTMLButtonElement>("#win-min")!;
  const winMaxBtn = document.querySelector<HTMLButtonElement>("#win-max")!;
  const winCloseBtn = document.querySelector<HTMLButtonElement>("#win-close")!;
  const editorPaneEl = document.querySelector<HTMLElement>("#editor-pane")!;

  const updateMaxIcon = async () => {
    winMaxBtn.classList.toggle("maximized", await win.isMaximized());
  };
  winMinBtn.addEventListener("click", () => void win.minimize());
  winMaxBtn.addEventListener("click", () => void win.toggleMaximize());
  winCloseBtn.addEventListener("click", () => void win.close());
  void updateMaxIcon();
  void win.onResized(updateMaxIcon);

  editorPaneEl.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("#sidebar-expand")) return;
    if (window.innerWidth <= 860) setResponsiveSidebarHidden(true);
  });
  const syncResponsiveSidebar = () => setResponsiveSidebarHidden(window.innerWidth <= 860);
  syncResponsiveSidebar();
  window.addEventListener("resize", syncResponsiveSidebar);

  window.addEventListener("blur", () => {
    void flushSave();
    void invoke("flush_index").catch(() => {});
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selectedIds.get().length > 0) clearSelection();
  });

  void listen("app-close-request", async () => {
    if (closing.get()) return;
    closing.set(true);
    const saved = await flushSave();
    if (saved) {
      await invoke("close_ready").catch(() => {});
    } else {
      closing.set(false);
    }
  });

  const cleanupBeforeLeave = () => {
    if (!dirty.get()) resetSaveStatus();
    void invoke("flush_index").catch(() => {});
  };
  window.addEventListener("pagehide", cleanupBeforeLeave);
  window.addEventListener("beforeunload", cleanupBeforeLeave);
}
