// 编辑管线组合根：把「编辑器 -> 块模型 -> 虚拟预览」装配成同步单向数据流。
//
//   editor(CodeMirror) -> markdownModel.applyEdit -> virtualPreview.refresh / outline / save
//
// 每键热路径使用显式依赖注入和同步函数调用，不经过通用事件总线；低频的打开、关闭、
// 视图模式和布局失效仍使用 events.ts 解耦生命周期消费者。

import { bus } from "./events";
import { closeEditor, getEditorView, initEditor, showEditor } from "./editor";
import { notifyDocumentEdited } from "./app/save";
import { notifyEditorActivity, scheduleResync } from "./documentPosition";
import { applyEdit, loadModel, resetModel, setRenderBaseDir } from "./markdownModel";
import { initVirtualPreview, type PreviewApi } from "./virtualPreview";
import { viewMode } from "./state";
import { dirOfPath } from "./utils";

let preview: PreviewApi | null = null;

/** 虚拟预览实例（滚动同步/大纲等模块经注入获取，避免反向依赖管线） */
export function getPreview(): PreviewApi {
  if (!preview) throw new Error("pipeline 尚未初始化");
  return preview;
}

export function initPipeline(onModelChanged: () => void): void {
  const previewEl = document.querySelector<HTMLElement>("#preview")!;
  preview = initVirtualPreview(previewEl, () => scheduleResync());
  initEditor(previewEl, {
    onDocEdited: (e) => {
      // 每键热路径保持同步直连：Editor -> Model -> Preview/Outline/Save。
      // 不经过通用事件总线，避免订阅查找与二次广播的固定开销。
      notifyEditorActivity();
      const changedIds = applyEdit(
        getEditorView().state.doc,
        { start: e.start, end: e.end, endNew: e.endNew },
        { newlineChange: e.newlineChange },
      );
      preview?.refresh(changedIds);
      onModelChanged();
      notifyDocumentEdited();
    },
  });

  // 打开/切换文档：模型已重载且块 id 从 1 重排，预览必须整体卸载旧块后重建
  bus.on("doc:loaded", () => {
    preview?.reset();
    preview?.setVisible(viewMode.get() !== "edit");
  });

  // 关闭文档：清空预览并卸载
  bus.on("doc:closed", () => {
    preview?.setVisible(false);
    preview?.refresh();
  });

  // 视图模式切换：预览可见性 + 内容刷新 + 分屏重同步
  bus.on("view:mode", ({ mode }) => {
    preview?.setVisible(mode !== "edit");
    if (mode !== "edit") preview?.refresh();
    scheduleResync();
  });

  // 布局失效（字号/密度/容器尺寸变化）：强制重排 + 重同步
  bus.on("preview:invalidate", () => {
    preview?.markLayoutDirty();
    scheduleResync();
  });
}

/** 打开/切换编辑对象：先重载 Markdown 块模型，再让编辑器显示内容（事件见 doc:loaded） */
export function openInEditor(title: string, content: string, path: string): void {
  setRenderBaseDir(dirOfPath(path));
  loadModel(content);
  showEditor(title, content, path);
  bus.emit("doc:loaded", { title, path });
}

/** 关闭当前编辑对象：清空编辑器视图与模型（事件见 doc:closed） */
export function closeActiveEditor(): void {
  closeEditor();
  resetModel();
  bus.emit("doc:closed", undefined);
}
