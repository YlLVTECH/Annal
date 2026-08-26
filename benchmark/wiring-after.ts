// 「优化后」接线：直接复用生产管线与信号化侧栏。
// 与 wiring-before 实现同一 Facade，场景 runner 不感知架构差异。

import type { EditorView } from "@codemirror/view";
import { getEditorView, setViewMode } from "../src/editor";
import { initOutline } from "../src/outline";
import { initScrollSync } from "../src/documentPosition";
import { closeActiveEditor, getPreview, initPipeline, openInEditor } from "../src/pipeline";
import { initSidebar } from "../src/sidebar";
import { current, dirty, listPage, notes } from "../src/state";
import type { NoteMeta } from "../src/types";
import type { BenchDoc, BenchFacade } from "./facade";
import type { FakeNote } from "./docs";

export const afterFacade: BenchFacade = {
  arch: "after",

  async init() {
    initPipeline(() => {});
    initScrollSync({ getEditorView, getPreview });
    initOutline({ getEditorView, getPreview });


    initSidebar({
      onSelect: async () => {},
      onStatus: () => {},
      onContextMenu: () => {},
      onRenameSuccess: () => {},
      onBatchDelete: async () => {},
      onBatchImport: async () => {},
      onBatchExport: async () => {},
    });
  },

  editorView(): EditorView {
    return getEditorView();
  },

  previewScrollEl(): HTMLElement {
    return getPreview().element;
  },

  editorScrollEl(): HTMLElement {
    return getEditorView().scrollDOM;
  },

  setViewMode(mode) {
    setViewMode(mode);
  },

  async openDoc(doc: BenchDoc) {
    // 基准场景的文档切换不测侧栏（侧栏有独立 listUpdate 场景）；避免每轮信号订阅触发
    // 异步列表重建干扰模型/预览打开耗时。生产 selectSource 仍会设置 current/openFiles。
    current.set({ kind: "file", path: doc.path });
    openInEditor(doc.title, doc.content, doc.path);
  },

  closeDoc() {
    current.set(null);
    dirty.set(false);
    closeActiveEditor();
  },

  setupList(fakeNotes: FakeNote[]) {
    notes.set(fakeNotes as NoteMeta[]);
    listPage.set(1);
  },

  /** 保存结果只写信号；侧栏订阅 notes 后在微任务内合并重渲染 */
  listUpdateAfterSave(meta: FakeNote) {
    const next = [...notes.get()];
    const i = next.findIndex((n) => n.id === meta.id);
    if (i >= 0) next[i] = meta;
    next.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
    notes.set(next);
  },
};
