import { handleDialogEscape, isAnyDialogOpen } from "./dialogs";
import { canEditCurrent, isComposing, runCommand, setViewMode } from "./editor";
import { closeHistory, isHistoryCompareOn, isHistoryOpen, toggleCompare } from "./history";
import { setSidebarHidden } from "./sidebar";
import { sidebarHidden } from "./state";
import { closeTablePopover, isTablePopoverOpen } from "./table";

/* ---------- 可自定义快捷键：命令注册表 ---------- */

export type CommandId =
  | "newNote"
  | "openFile"
  | "save"
  | "find"
  | "toggleSidebar"
  | "viewEdit"
  | "viewSplit"
  | "viewPreview"
  | "bold"
  | "italic"
  | "link";

/** 命令展示顺序（设置页与注册表共用） */
export const COMMAND_IDS: CommandId[] = [
  "newNote",
  "openFile",
  "save",
  "find",
  "toggleSidebar",
  "viewEdit",
  "viewSplit",
  "viewPreview",
  "bold",
  "italic",
  "link",
];

/** 仅在编辑器获得焦点时生效的命令（设置页显示作用域标记） */
export const EDITOR_ONLY_COMMANDS: ReadonlySet<CommandId> = new Set(["bold", "italic", "link"]);

/** 单个按键绑定：key 为规范化按键名（字母小写、空格记作 "space"） */
export interface Binding {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** 每个命令最多绑定的按键数量 */
export const MAX_BINDINGS_PER_COMMAND = 3;

const STORAGE_KEY = "notebook:shortcuts";

const b = (key: string, ctrl = false, shift = false, alt = false, meta = false): Binding => ({
  key,
  ctrl,
  shift,
  alt,
  meta,
});

/** 出厂默认绑定（与历史硬编码行为一致） */
export const DEFAULT_BINDINGS: Readonly<Record<CommandId, readonly Binding[]>> = {
  newNote: [b("n", true)],
  openFile: [b("o", true)],
  save: [b("s", true)],
  find: [b("f", true)],
  toggleSidebar: [b("\\", true)],
  viewEdit: [b("e", true)],
  viewSplit: [b("e", true, true)],
  viewPreview: [b("p", true, true)],
  bold: [b("b", true)],
  italic: [b("i", true)],
  link: [b("k", true)],
};

/* ---------- 绑定的规范化 / 校验 / 匹配 ---------- */

/** 纯修饰键 / 锁定键：单独按下不构成快捷键（录制时等待后续按键） */
export const MODIFIER_KEYS = new Set([
  "control",
  "shift",
  "alt",
  "meta",
  "capslock",
  "numlock",
  "scrolllock",
  "contextmenu",
]);

/** 从键盘事件提取规范化绑定 */
export function bindingFromEvent(e: KeyboardEvent): Binding {
  return {
    key: normalizeKey(e.key),
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

function normalizeKey(key: string): string {
  if (key === " ") return "space";
  if (key.length === 1) return key.toLowerCase();
  return key;
}

function hasModifier(x: Binding): boolean {
  return x.ctrl || x.alt || x.meta;
}

/** 可作为全局快捷键的组合：至少含 Ctrl/Alt/Meta，或为功能键（避免裸字母/空格劫持打字） */
export function isValidBinding(x: Binding): boolean {
  if (!x.key || x.key === "Escape" || MODIFIER_KEYS.has(x.key.toLowerCase())) return false;
  if (hasModifier(x)) return true;
  return /^f([1-9]|1[0-2])$/i.test(x.key);
}

function sameBinding(a: Binding, x: Binding): boolean {
  return (
    a.key === x.key && a.ctrl === x.ctrl && a.shift === x.shift && a.alt === x.alt && a.meta === x.meta
  );
}

/* ---------- 运行时绑定表（localStorage 持久化） ---------- */

const isMac = /mac|iphone|ipad/i.test(navigator.platform);
const bindings = new Map<CommandId, Binding[]>(cloneDefaults());

function cloneDefaults(): [CommandId, Binding[]][] {
  return COMMAND_IDS.map((id) => [id, [...DEFAULT_BINDINGS[id].map((x) => ({ ...x }))]]);
}

function isValidStoredBinding(x: unknown): x is Binding {
  if (typeof x !== "object" || x === null) return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    typeof v.ctrl === "boolean" &&
    typeof v.shift === "boolean" &&
    typeof v.alt === "boolean" &&
    typeof v.meta === "boolean"
  );
}

function loadBindings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const id of COMMAND_IDS) {
      const list = parsed[id];
      if (!Array.isArray(list)) continue;
      bindings.set(
        id,
        list
          .filter(isValidStoredBinding)
          .filter(isValidBinding)
          .map((x) => ({ ...x })),
      );
    }
  } catch {
    // 存储损坏时静默回退默认值
  }
}

function persistBindings() {
  try {
    const obj: Record<string, Binding[]> = {};
    for (const [id, list] of bindings) obj[id] = list;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (err) {
    console.error("[shortcuts] 保存自定义快捷键失败:", err);
  }
}

loadBindings();

/** 某命令当前的按键绑定列表 */
export function getBindings(id: CommandId): readonly Binding[] {
  return bindings.get(id) ?? [];
}

/** 覆盖某命令的绑定并持久化 */
export function setBindings(id: CommandId, list: readonly Binding[]) {
  bindings.set(id, list.map((x) => ({ ...x })));
  persistBindings();
}

/** 全部恢复出厂默认并持久化 */
export function resetAllBindings() {
  bindings.clear();
  for (const [id, list] of cloneDefaults()) bindings.set(id, list);
  persistBindings();
}

/** 查找与 target 相同按键的占用者；exclude 指定替换场景下应跳过的位置 */
export function findBindingConflict(
  target: Binding,
  exclude?: { command: CommandId; index: number },
): { command: CommandId; index: number } | null {
  for (const id of COMMAND_IDS) {
    const list = bindings.get(id) ?? [];
    for (let i = 0; i < list.length; i++) {
      if (exclude && id === exclude.command && i === exclude.index) continue;
      if (sameBinding(list[i], target)) return { command: id, index: i };
    }
  }
  return null;
}

/** 按键展示名（Ctrl + Shift + E 形式的分段） */
export function formatBindingParts(x: Binding): string[] {
  const parts: string[] = [];
  if (x.ctrl) parts.push("Ctrl");
  if (x.alt) parts.push("Alt");
  if (x.shift) parts.push("Shift");
  if (x.meta) parts.push(isMac ? "Cmd" : "Win");
  parts.push(formatKey(x.key));
  return parts;
}

const KEY_DISPLAY: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Del",
  insert: "Ins",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
};

function formatKey(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_DISPLAY[lower]) return KEY_DISPLAY[lower];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/* ---------- 全局分发 ---------- */

export interface ShortcutHandlers {
  onNewNote: () => void;
  onOpenFile: () => void;
  onFlushSave: () => Promise<boolean>;
  /** CodeMirror 编辑器是否获得焦点（决定格式化命令是否作用于编辑器） */
  editorHasFocus: () => boolean;
  /** 打开编辑器查找面板（find 命令统一入口） */
  onOpenFind: () => void;
}

function matchCommand(x: Binding): CommandId | null {
  for (const id of COMMAND_IDS) {
    for (const item of bindings.get(id) ?? []) {
      if (sameBinding(item, x)) return id;
    }
  }
  return null;
}

export function initShortcuts(handlers: ShortcutHandlers) {
  window.addEventListener("keydown", (e) => {
    const binding = bindingFromEvent(e);

    // Escape 不可被绑定：始终走分层退出（表格弹层 → 弹层 → 历史）
    if (e.key === "Escape") {
      if (isTablePopoverOpen()) {
        closeTablePopover();
        return;
      }
      if (handleDialogEscape()) {
        return;
      }
      if (isHistoryOpen()) {
        if (isHistoryCompareOn()) {
          void toggleCompare();
          return;
        }
        closeHistory();
        return;
      }
      return;
    }

    // 确认/提交/设置/右键菜单等弹层打开时，快捷键全部让位给弹层交互；
    // find 仍需吞掉按键，避免唤醒 WebView 原生查找
    const cmd = matchCommand(binding);
    if (isAnyDialogOpen()) {
      if (cmd === "find") e.preventDefault();
      return;
    }

    if (cmd && execCommand(cmd, e, handlers)) return;

    // 未绑定的按键（含 Ctrl+Z/Y）不 preventDefault，交给 CodeMirror 与 WebView 默认行为
  });
}

/** 执行命令；返回 false 表示当前上下文未接管（事件按默认行为继续） */
function execCommand(cmd: CommandId, e: KeyboardEvent, handlers: ShortcutHandlers): boolean {
  switch (cmd) {
    case "newNote":
      e.preventDefault();
      handlers.onNewNote();
      return true;
    case "openFile":
      e.preventDefault();
      handlers.onOpenFile();
      return true;
    case "save":
      e.preventDefault();
      void handlers.onFlushSave();
      return true;
    case "find":
      // 统一接管 find：无论焦点在哪都屏蔽 WebView 原生查找，
      // 可用时改为聚焦编辑器并打开 VSCode 风格查找面板。
      e.preventDefault();
      if (!isComposing() && !isHistoryOpen() && canEditCurrent()) {
        handlers.onOpenFind();
      }
      return true;
    case "toggleSidebar":
      e.preventDefault();
      setSidebarHidden(!sidebarHidden.get());
      return true;
    case "viewEdit":
    case "viewSplit":
    case "viewPreview":
      if (isComposing()) return false;
      e.preventDefault();
      setViewMode(cmd === "viewEdit" ? "edit" : cmd === "viewSplit" ? "split" : "preview");
      return true;
    case "bold":
    case "italic":
      if (!handlers.editorHasFocus() || !canEditCurrent()) return false;
      if (isComposing()) return false;
      e.preventDefault();
      runCommand(cmd);
      return true;
    case "link":
      if (!handlers.editorHasFocus() || !canEditCurrent()) return false;
      e.preventDefault();
      runCommand("link");
      return true;
  }
}
