// 当前架构接线：直接复用生产模块（pipeline / outline / sidebar / editor）。
// 场景 runner 只通过 BenchFacade 操作，不感知模块内部结构。

import type { EditorView } from "@codemirror/view";
import { getEditorView, setLiveRenderEnabled } from "../src/editor";
import { initOutline, refreshOutline } from "../src/outline";
import { closeActiveEditor, initPipeline, openInEditor } from "../src/pipeline";
import { initSidebar } from "../src/sidebar";
import { current, dirty, notes } from "../src/state";
import type { NoteMeta } from "../src/types";
import type { BenchDoc, BenchFacade } from "./facade";
import type { FakeNote } from "./docs";

export const benchFacade: BenchFacade = {
  arch: "live-render",

  init() {
    // 与 bootstrap.ts 相同的装配顺序：编辑管线 -> 大纲 -> 侧栏
    initPipeline(refreshOutline);
    initOutline({ getEditorView, flashHeading: () => {} });
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

  setLiveRender(on: boolean) {
    setLiveRenderEnabled(on);
  },

  openDoc(doc: BenchDoc) {
    // 基准场景的文档切换不测侧栏（侧栏有独立 listUpdate 场景）；避免信号订阅触发的
    // 异步列表重建干扰打开耗时。生产 selectSource 仍会设置 current/openFiles。
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
  },

  /** 保存结果只写信号；侧栏订阅 notes 后在微任务内合并重渲染 */
  listUpdateAfterSave(meta: FakeNote) {
    const next = [...notes.get()];
    const i = next.findIndex((n) => n.id === meta.id);
    if (i >= 0) next[i] = meta as NoteMeta;
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    notes.set(next);
  },
};
