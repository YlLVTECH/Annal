/** 笔记元信息（与后端 NoteMeta 结构对应） */
export interface NoteMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 笔记文件在磁盘上的完整路径 */
  path: string;
  /** 最近保存正文的 SHA-256 摘要（前 16 位十六进制），用于外部改名/移动后的内容匹配 */
  contentHash?: string;
  /** 是否置顶 */
  pinned?: boolean;
}

/** 笔记完整实体（含正文） */
export interface Note extends NoteMeta {
  content: string;
}

/** 笔记历史版本元信息（对应后端一个快照文件） */
export interface NoteVersion {
  seq: number;
  ts: number;
  size: number;
  hash: string;
  /** 提交说明（可空） */
  message: string;
  /** 该版本所属笔记名（改名入版本控制后可查到改名发生在哪个版本；旧版本为空） */
  title?: string;
}

/** 已打开的外部 Markdown 文件 */
export interface OpenFile {
  path: string;
  name: string;
  content: string;
}

/** 轮询命令 sync_fs_state 的返回：外部改名同步结果 + 各路径存在性 */
export interface FsSyncResult {
  changed: NoteMeta[];
  exists: boolean[];
}

export type ContentDensity = "standard" | "sparse" | "compact";

/** 当前编辑对象：内部笔记 或 外部文件 */
export type Source = { kind: "note"; id: string } | { kind: "file"; path: string };

/** 编辑器历史快照（用于自定义撤销/重做栈） */
export interface EditSnapshot {
  value: string;
  start: number;
  end: number;
}

/** 对齐方式 */
export type Align = "left" | "center" | "right";

/** 右键菜单项配置 */
export interface CtxItem {
  label?: string;
  danger?: boolean;
  action?: () => void;
  separator?: boolean;
  shortcut?: string;
}
