# 笔记本 (Annal)

极简桌面笔记应用，基于 **Tauri 2 + Vite + 原生 TypeScript + Rust**。

## 功能

- 新建 / 编辑 / 删除笔记，输入自动保存（防抖 500ms），标题自动取正文第一行；
  **文件名与笔记名称保持一致**（标题变化时磁盘文件自动同步改名，非法字符自动清理、重名自动加序号）
- 右键笔记 / 外部文件可「打开文件所在位置」，在系统文件管理器中定位该文件
- 工具栏随窗口宽度自动换行排布，窄窗口下按钮依然完整可见（视图切换保持靠右）
- **打开外部 Markdown 文件**：
  - 点击侧边栏 📂 或 `Ctrl+O` 通过文件对话框打开（支持多选）
  - 直接把 `.md` / `.markdown` 文件拖进窗口即可打开
  - 安装后注册文件关联：在资源管理器里双击 `.md` / `.markdown` 文件直接用本应用打开
  - 外部文件在侧边栏"外部文件"分组独立显示，编辑后自动保存回原路径；
    右上角按钮为"关闭"（不会删除磁盘上的文件）
  - **另存为笔记**：外部文件可一键复制到所选新位置并纳入笔记索引
    （编辑器右上角「存为笔记」按钮，或右键菜单「另存为笔记」），
    原文件保持不动；新笔记从此支持版本提交 / 历史管理 / 重命名同步
  - 应用已在运行时再次打开文件，会自动转到已运行的窗口（single-instance）
- **Markdown 原生支持**：编辑 / 分屏 / 预览三种视图（marked + DOMPurify + highlight.js）
  - GitHub 风格语法：标题、粗斜体、列表、任务列表、表格、引用、代码块（带语法高亮）、删除线、链接、图片等
  - 预览中的外链点击后自动用系统浏览器打开
- 工具栏一键插入 Markdown 语法（标题 / 粗体 / 斜体 / 删除线 / 引用 / 代码 / 列表 / 任务 / 链接 / 表格 / 分割线）
- 明暗主题切换（记忆选择）
- 侧边栏按标题搜索笔记与外部文件
- 状态栏字数统计；分屏视图滚动位置同步
- 关闭窗口时自动冲刷未保存内容（防抖期间不丢字）
- 快捷键：
  - `Ctrl+N` 新建 ｜ `Ctrl+O` 打开 Markdown 文件 ｜ `Ctrl+S` 立即保存
  - `Ctrl+B` 粗体 ｜ `Ctrl+I` 斜体 ｜ `Ctrl+K` 插入链接
  - `Ctrl+E` 编辑 ｜ `Ctrl+Shift+E` 分屏 ｜ `Ctrl+Shift+P` 预览
  - `Esc` 关闭删除确认框

## 数据存储

每篇笔记一个 Markdown 文件（新建时由你选择保存位置与文件名），元信息统一索引：

```
<应用数据目录>/
└── index.json          # 笔记元信息（id、标题、创建/更新时间、文件路径）
```

笔记正文保存在各自独立的 `.md` 文件中，位置由新建时选择。

**文件名与笔记名称保持一致**：标题（正文第一行或手动重命名）变化时，磁盘文件
自动同步改名；标题中的非法字符（如 `:` `/` `*`）会被清理成空格，与已有文件
重名时自动追加序号（如 `标题 (1).md`），绝不覆盖已有文件。

应用数据目录由 Tauri 管理（Windows 为 `%APPDATA%\com.annal.desktop`，
macOS 为 `~/Library/Application Support/com.annal.desktop`，Linux 为
`~/.local/share/com.annal.desktop`）。

## 开发

前置要求：[Node.js](https://nodejs.org) ≥ 18、[Rust](https://rustup.rs) 稳定版、
Windows 需 [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带）。

```bash
npm install
npm run tauri dev      # 启动开发模式（热更新）
```

## 构建安装包

```bash
npm run tauri build
# Windows 下生成 NSIS 安装向导（.exe）：
#   src-tauri/target/release/bundle/nsis/annal_<ver>_x64-setup.exe
```

打包过程：`npm run build`（前端）→ cargo release 编译（Rust）→ tauri-bundler
打安装包。首次打包会自动下载 NSIS 工具。

其他说明：

- 需要 MSI 安装包时，把 `tauri.conf.json` 里 `bundle.targets` 改为
  `["nsis", "msi"]`（MSI 需要 WiX 工具）。
- 安装包目前未签名，Windows SmartScreen 会提示"未知发布者"，点"仍要运行"即可；
  正式分发可申请代码签名证书（如 DigiCert / 沃通）。
- 版本号改 `tauri.conf.json` 的 `version` 字段。
- 文件关联（双击打开 .md）在安装时由 NSIS 写入注册表；
  使用 `npm run tauri dev` 或直接运行 `target/release/annal.exe 文件.md` 也可验证打开效果。

## 项目结构

```
├── index.html            # 页面骨架（侧边栏 / 工具栏 / 编辑器 / 预览 / 状态栏）
├── src/
│   ├── main.ts           # 前端逻辑（列表/编辑器/自动保存/视图模式/工具栏动作）
│   ├── markdown.ts       # Markdown 渲染（marked + DOMPurify + 代码高亮）
│   └── styles.css        # 样式（明暗双主题 / Markdown 排版）
└── src-tauri/
    ├── src/
    │   ├── lib.rs        # Rust 后端：笔记 CRUD + 外链打开命令
    │   └── main.rs
    ├── tauri.conf.json   # 应用配置
    └── capabilities/     # 权限声明
```

## 后续规划（思路）

- 全文搜索
- 标签 / 文件夹
- 多窗口 / 侧边栏折叠
