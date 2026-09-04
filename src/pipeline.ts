// 编辑管线组合根：把「编辑器 -> 块模型」装配成同步单向数据流。
//
//   editor(CodeMirror) -> markdownModel.applyEdit -> outline / save
//
// 每键热路径使用显式依赖注入和同步函数调用，不经过通用事件总线；低频的打开、
// 关闭等生命周期仍使用 events.ts 解耦消费者。

import { bus } from "./events";
import { closeEditor, getEditorView, initEditor, showEditor } from "./editor";
import { notifyDocumentEdited } from "./app/save";
import { applyEdit, loadModel, resetModel, setRenderBaseDir } from "./markdownModel";
import { dirOfPath } from "./utils";

export function initPipeline(onModelChanged: () => void): void {
  initEditor({
    onDocEdited: (e) => {
      // 每键热路径保持同步直连：Editor -> Model -> Outline/Save。
      // 不经过通用事件总线，避免订阅查找与二次广播的固定开销。
      applyEdit(
        getEditorView().state.doc,
        { start: e.start, end: e.end, endNew: e.endNew },
        { newlineChange: e.newlineChange },
      );
      onModelChanged();
      notifyDocumentEdited();
    },
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
