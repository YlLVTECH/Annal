// 快捷键设置页：渲染各命令的按键绑定，支持录制修改/新增/删除绑定与恢复默认。
// 录制通过捕获阶段拦截 keydown 实现，避免按下的组合键同时触发命令本身。

import { openConfirm } from "./dialogs";
import { bus } from "./events";
import { t } from "./i18n";
import {
  COMMAND_IDS,
  DEFAULT_BINDINGS,
  EDITOR_ONLY_COMMANDS,
  MAX_BINDINGS_PER_COMMAND,
  MODIFIER_KEYS,
  bindingFromEvent,
  findBindingConflict,
  formatBindingParts,
  getBindings,
  isValidBinding,
  resetAllBindings,
  setBindings,
} from "./shortcuts";
import type { Binding, CommandId } from "./shortcuts";

interface Recording {
  command: CommandId;
  /** 被替换的绑定下标；-1 表示新增绑定 */
  index: number;
}

let listEl: HTMLElement | null = null;
let recording: Recording | null = null;
let rowError: { command: CommandId; message: string } | null = null;
let errorTimer: number | undefined;

export function initShortcutSettings() {
  listEl = document.querySelector<HTMLElement>("#shortcut-list");
  document
    .querySelector<HTMLButtonElement>("#shortcuts-reset-all")
    ?.addEventListener("click", confirmResetAll);

  listEl?.addEventListener("click", onListClick);
  // 录制期间点击录制行以外任意位置 = 取消录制
  window.addEventListener("mousedown", (e) => {
    if (!recording || !listEl) return;
    const target = e.target as HTMLElement;
    if (!listEl.contains(target)) {
      cancelRecording();
      return;
    }
    const row = target.closest<HTMLElement>(".shortcut-row");
    if (!row || row.dataset.command !== recording.command) cancelRecording();
  });
  window.addEventListener("keydown", onRecordKeydown, true);
  window.addEventListener("blur", () => cancelRecording());

  bus.on("app:locale", () => {
    renderList();
    refreshShortcutHints();
  });
  renderList();
  refreshShortcutHints();
}

/* ---------- 渲染 ---------- */

function renderList() {
  if (!listEl) return;
  listEl.textContent = "";
  for (const id of COMMAND_IDS) listEl.appendChild(renderRow(id));
}

function renderRow(command: CommandId): HTMLElement {
  const row = document.createElement("div");
  row.className = "shortcut-row";
  row.dataset.command = command;
  if (recording?.command === command) row.classList.add("recording");

  const main = document.createElement("div");
  main.className = "shortcut-row-main";
  const label = document.createElement("span");
  label.className = "shortcut-label";
  label.textContent = t(`shortcuts.${command}`);
  main.appendChild(label);
  if (EDITOR_ONLY_COMMANDS.has(command)) {
    const scope = document.createElement("span");
    scope.className = "shortcut-scope";
    scope.textContent = t("shortcuts.scope.editor");
    main.appendChild(scope);
  }
  row.appendChild(main);

  const chips = document.createElement("div");
  chips.className = "shortcut-chips";
  if (recording?.command === command) {
    const rec = document.createElement("span");
    rec.className = "shortcut-recording";
    rec.textContent = t("settings.shortcuts.recording");
    const hint = document.createElement("span");
    hint.className = "shortcut-recording-hint";
    hint.textContent = t("settings.shortcuts.recordingHint");
    chips.appendChild(rec);
    chips.appendChild(hint);
  } else {
    const list = getBindings(command);
    if (list.length === 0) {
      const unset = document.createElement("span");
      unset.className = "shortcut-unset";
      unset.textContent = t("settings.shortcuts.unset");
      chips.appendChild(unset);
    }
    list.forEach((binding, index) => {
      chips.appendChild(renderChip(binding, index));
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "shortcut-add";
    add.textContent = t("settings.shortcuts.add");
    if (list.length >= MAX_BINDINGS_PER_COMMAND) {
      add.disabled = true;
      add.title = t("settings.shortcuts.max", { count: MAX_BINDINGS_PER_COMMAND });
    }
    chips.appendChild(add);
    if (differsFromDefault(command)) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "shortcut-reset";
      reset.title = t("settings.shortcuts.reset");
      reset.textContent = "↺";
      chips.appendChild(reset);
    }
  }
  row.appendChild(chips);

  if (rowError?.command === command) {
    const err = document.createElement("p");
    err.className = "shortcut-error";
    err.textContent = rowError.message;
    row.appendChild(err);
  }
  return row;
}

function renderChip(binding: Binding, index: number): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "shortcut-chip";
  chip.dataset.index = String(index);
  chip.title = t("shortcuts.edit");
  for (const part of formatBindingParts(binding)) {
    const kbd = document.createElement("kbd");
    kbd.textContent = part;
    chip.appendChild(kbd);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "chip-remove";
  remove.title = t("shortcuts.remove");
  remove.textContent = "×";
  chip.appendChild(remove);
  return chip;
}

function bindingSignature(x: Binding): string {
  return [x.key, x.ctrl ? 1 : 0, x.alt ? 1 : 0, x.shift ? 1 : 0, x.meta ? 1 : 0].join("|");
}

function differsFromDefault(command: CommandId): boolean {
  const current = getBindings(command).map(bindingSignature).join(";");
  const defaults = DEFAULT_BINDINGS[command].map(bindingSignature).join(";");
  return current !== defaults;
}

/* ---------- 交互 ---------- */

function onListClick(e: MouseEvent) {
  if (!listEl) return;
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>(".shortcut-row");
  if (!row) return;
  const command = row.dataset.command as CommandId;

  const removeBtn = target.closest<HTMLButtonElement>(".chip-remove");
  if (removeBtn) {
    const index = Number(removeBtn.closest<HTMLElement>(".shortcut-chip")?.dataset.index ?? -1);
    const list = [...getBindings(command)];
    if (index >= 0 && index < list.length) {
      list.splice(index, 1);
      setBindings(command, list);
      rowError = null;
      renderList();
      refreshShortcutHints();
    }
    return;
  }

  if (recording) return;

  if (target.closest<HTMLButtonElement>(".shortcut-reset")) {
    setBindings(
      command,
      DEFAULT_BINDINGS[command].map((x) => ({ ...x })),
    );
    rowError = null;
    renderList();
    refreshShortcutHints();
    return;
  }

  if (target.closest<HTMLButtonElement>(".shortcut-add")) {
    startRecording(command, -1);
    return;
  }

  const chip = target.closest<HTMLElement>(".shortcut-chip");
  if (chip) startRecording(command, Number(chip.dataset.index ?? -1));
}

function startRecording(command: CommandId, index: number) {
  if (index === -1 && getBindings(command).length >= MAX_BINDINGS_PER_COMMAND) {
    showError(command, t("settings.shortcuts.max", { count: MAX_BINDINGS_PER_COMMAND }));
    return;
  }
  recording = { command, index };
  rowError = null;
  renderList();
}

function cancelRecording() {
  if (!recording) return;
  recording = null;
  renderList();
}

/** 捕获阶段拦截录制中的按键，阻止其触发命令本身或其他默认行为 */
function onRecordKeydown(e: KeyboardEvent) {
  const rec = recording;
  if (!rec) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;

  const binding = bindingFromEvent(e);
  if (binding.key === "Escape") {
    cancelRecording();
    return;
  }
  if (MODIFIER_KEYS.has(binding.key.toLowerCase())) return; // 等待非修饰键

  // Backspace（可加 Shift）：替换模式下删除该绑定，新增模式下取消录制
  if (binding.key === "Backspace" && !binding.ctrl && !binding.alt && !binding.meta) {
    recording = null;
    if (rec.index >= 0) {
      const list = [...getBindings(rec.command)];
      if (rec.index < list.length) {
        list.splice(rec.index, 1);
        setBindings(rec.command, list);
        refreshShortcutHints();
      }
    }
    renderList();
    return;
  }

  recording = null;
  if (!isValidBinding(binding)) {
    showError(rec.command, t("settings.shortcuts.invalid"));
    renderList();
    return;
  }
  const exclude = rec.index >= 0 ? { command: rec.command, index: rec.index } : undefined;
  const conflict = findBindingConflict(binding, exclude);
  if (conflict) {
    showError(
      rec.command,
      conflict.command === rec.command
        ? t("settings.shortcuts.sameCommand")
        : t("settings.shortcuts.conflict", { name: t(`shortcuts.${conflict.command}`) }),
    );
    renderList();
    return;
  }

  const list = [...getBindings(rec.command)];
  if (rec.index >= 0 && rec.index < list.length) list[rec.index] = binding;
  else list.push(binding);
  setBindings(rec.command, list);
  renderList();
  refreshShortcutHints();
}

function showError(command: CommandId, message: string) {
  rowError = { command, message };
  window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => {
    rowError = null;
    renderList();
  }, 4000);
  renderList();
}

function confirmResetAll() {
  openConfirm({
    title: t("confirm.title.resetShortcuts"),
    text: t("confirm.text.resetShortcuts"),
    danger: false,
    action: () => {
      resetAllBindings();
      recording = null;
      rowError = null;
      renderList();
      refreshShortcutHints();
    },
  });
}

/* ---------- 工具栏提示同步 ---------- */

// 带"标签 (快捷键)"提示的按钮：绑定或语言变化后同步更新 tooltip。
// 标题栏打开/新建按钮与工具栏排版按钮的快捷键提示都由这里统一生成。
const HINT_TARGETS: Array<{ selector: string; command: CommandId; labelKey: string }> = [
  { selector: "#open-file-btn", command: "openFile", labelKey: "titlebar.openFile" },
  { selector: "#new-note-btn", command: "newNote", labelKey: "titlebar.newNote" },
  { selector: '.tool-btn[data-cmd="bold"]', command: "bold", labelKey: "toolbar.bold" },
  { selector: '.tool-btn[data-cmd="italic"]', command: "italic", labelKey: "toolbar.italic" },
  { selector: '.tool-btn[data-cmd="link"]', command: "link", labelKey: "toolbar.link" },
  { selector: '#view-toggle .view-btn[data-mode="edit"]', command: "viewEdit", labelKey: "toolbar.view.edit" },
  { selector: '#view-toggle .view-btn[data-mode="split"]', command: "viewSplit", labelKey: "toolbar.view.split" },
  {
    selector: '#view-toggle .view-btn[data-mode="preview"]',
    command: "viewPreview",
    labelKey: "toolbar.view.preview",
  },
];

function refreshShortcutHints() {
  for (const target of HINT_TARGETS) {
    const el = document.querySelector<HTMLElement>(target.selector);
    if (!el) continue;
    const binding = getBindings(target.command)[0];
    const label = t(target.labelKey);
    el.title = binding ? `${label} (${formatBindingParts(binding).join("+")})` : label;
  }
}
