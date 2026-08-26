type TranslateParams = Record<string, string | number>;

const DEFAULT_LOCALE = "zh-CN";

/** 默认回退消息：i18n 加载失败时至少保证核心文案可见 */
const DEFAULT_MESSAGES: Record<string, string> = {
  "editor.placeholder": "开始输入…",
  "editor.count.chars": "{count} 字符",
  "editor.count.words": "{count} 词",
  "editor.count.minutes": "约 {count} 分钟",
  "editor.command.h1": "标题 1",
  "editor.command.h2": "标题 2",
  "editor.command.h3": "标题 3",
  "editor.command.bold": "粗体",
  "editor.command.italic": "斜体",
  "editor.command.strike": "删除线",
  "editor.command.quote": "引用",
  "editor.command.code": "行内代码",
  "editor.command.ul": "无序列表",
  "editor.command.ol": "有序列表",
  "editor.command.task": "任务",
  "editor.linkPlaceholder": "链接文本",
  "editor.codePlaceholder": "代码",
  "editor.imageFallback": "图片",
  "editor.insertImage": "插入图片",
  "editor.images": "图片",
  "editor.missing.deleted": "文件已删除",
  "editor.missing.note": "笔记不存在",
  "status.saving": "保存中…",
  "status.saved": "已保存",
  "status.error.save": "保存失败",
  "status.renameSuccess": "已重命名：{title}",
  "status.versionRestored": "版本已恢复",
  "status.versionRestoredOther": "「{title}」已恢复",
  "status.externalRename": "外部重命名：{title}",
  "paste.imageFail": "图片粘贴失败：{count} 张",
  "paste.imageInserted": "已插入 {inserted} 张，{failed} 张失败",
  "find.placeholder": "查找…",
  "find.replacePlaceholder": "替换为…",
  "history.title.default": "未命名笔记",
  "history.titleAtVersion": "{title}",
  "history.versionLabel": "版本 {seq}",
  "history.latest": "最新",
  "history.latestBadge": "最新",
  "history.compare": "对比",
  "history.exitCompare": "退出对比",
  "history.compareMeta": "{from} → v{seq} · {time}",
  "history.versionsCount": "{count} 个版本",
  "history.diffEmpty": "无差异",
  "history.compareFail": "对比失败：{error}",
  "history.loading": "加载中…",
  "history.empty": "暂无历史版本",
  "history.readFail": "读取失败：{error}",
  "confirm.okDefault": "确定",
  "commit.confirmText": "提交「{title}」的当前版本？",
  "commit.success": "已提交 v{seq}{message}",
  "commit.unchanged": "内容未变更，无需提交",
  "commit.fail": "提交失败：{error}",
  "contextMenu.closeFile": "关闭文件",
  "contextMenu.newNote": "新建笔记",
  "contextMenu.pin": "置顶",
  "contextMenu.undo": "撤销",
  "contextMenu.redo": "重做",
  "contextMenu.cut": "剪切",
  "contextMenu.copy": "复制",
  "contextMenu.paste": "粘贴",
  "contextMenu.selectAll": "全选",
  "sidebar.deleted": "已删除",
  "sidebar.page.info": "{current} / {total}",
  "sidebar.page.prev": "上一页",
  "sidebar.page.next": "下一页",
  "sidebar.page.size": "每页显示数量",
  "sidebar.page.size5": "5 条/页",
  "sidebar.page.size10": "10 条/页",
  "sidebar.page.size20": "20 条/页",
  "sidebar.page.size50": "50 条/页",
  "sidebar.search.placeholder": "搜索笔记…",
  "sidebar.tab.files": "笔记",
  "sidebar.tab.outline": "大纲",
  "sidebar.searching": "搜索中…",
  "sidebar.noMatch": "无匹配结果",
  "sidebar.empty.title": "暂无笔记",
  "sidebar.empty.sub": "点击「新建笔记」或打开 Markdown 文件开始使用",
  "sidebar.empty.subWithOpen": "或打开现有 Markdown 文件",
  "sidebar.renameFail": "重命名失败：{error}",
  "sidebar.group.externalFiles": "外部文件",
  "sidebar.batch.info": "已选 {count} 项",
  "sidebar.batch.delete": "删除",
  "sidebar.batch.import": "导入为笔记",
  "sidebar.batch.export": "导出",
  "sidebar.batch.cancel": "取消",
  "sidebar.resizer.title": "拖拽调整侧栏宽度，双击恢复默认",
  "settings.about": "关于",
  "settings.fontFamily": "界面字体",
  "settings.fontFamily.desc": "应用界面与查找面板的文字字体风格",
  "settings.font.serif": "衬线",
  "settings.font.sans": "无衬线",
  "titlebar.openFile": "打开 Markdown 文件",
  "titlebar.collapseSidebar": "收起侧栏",
  "titlebar.toggleTheme": "切换明暗主题",
  "app.title": "笔记本",
  "outline.empty": "暂无标题",
  "outline.toggle": "显示 / 隐藏大纲",
};

let currentLocale = (localStorage.getItem("notebook:locale") as string | null) ?? DEFAULT_LOCALE;
let currentMessages: Record<string, string> = { ...DEFAULT_MESSAGES };

async function loadMessages(locale: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`/i18n/${locale}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load ${locale}`);
    const data = (await res.json()) as Record<string, string>;
    return data;
  } catch (err) {
    console.error(`[i18n] Failed to load locale "${locale}", falling back to defaults:`, err);
    return {};
  }
}

export async function initI18n() {
  currentMessages = await loadMessages(currentLocale);
  document.documentElement.lang = currentLocale;
}

export function getLocale(): string {
  return currentLocale;
}

export function t(key: string, params?: TranslateParams): string {
  let text = currentMessages[key] ?? DEFAULT_MESSAGES[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}

export async function setLocale(locale: string) {
  if (locale === currentLocale) return;
  currentLocale = locale;
  localStorage.setItem("notebook:locale", locale);
  currentMessages = await loadMessages(locale);
  document.documentElement.lang = locale;
}

export function getAvailableLocales(): Array<{ value: string; label: string }> {
  return [
    { value: "zh-CN", label: "简体中文" },
    { value: "en-US", label: "English" },
  ];
}

export function applyI18nToDocument() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n") || "";
    const argsAttr = el.getAttribute("data-i18n-args");
    const args: TranslateParams = argsAttr ? (JSON.parse(argsAttr) as TranslateParams) : {};
    el.textContent = t(key, args);
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title") || "";
    el.title = t(key);
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder") || "";
    el.setAttribute("placeholder", t(key));
  });
}

