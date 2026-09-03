# Annal（笔记本）

> [English](README.en.md) | 简体中文

极简桌面笔记应用，基于 **Tauri 2 + Vite + 原生 TypeScript + Rust**。
一个 Markdown 文件即一篇笔记，文件保存在你自己选择的位置；内建 git 式版本历史，每次显式提交都是一份可追溯、可恢复的记录。

## 功能

**编辑与写作**

- 编辑 / 分屏 / 预览三种视图（CodeMirror 6 编辑器 + marked + DOMPurify + 按需加载的代码高亮）
- 输入自适应防抖自动保存（300ms–4s），关闭窗口自动冲刷未落盘内容，不丢一字
- 标题（正文第一行）即文件名，改名自动同步磁盘文件；非法字符自动清理、重名自动加序号，绝不覆盖
- 大纲导航、分屏滚动位置同步、状态栏字数统计
- 粘贴 / 拖入图片自动保存为附件并插入引用

**版本历史（git 式）**

- 显式「提交」生成版本快照，内容按内容寻址去重存储（相同内容只存一份），任意历史版本可一键恢复
- 历史面板支持版本对比（行级 diff）

**文件与搜索**

- 打开外部 Markdown 文件：文件对话框（Ctrl+O）、拖拽、双击文件关联均可
- 外部文件就地编辑保存、不纳入笔记索引；「另存为笔记」一键纳入管理
- 侧边栏全文搜索（大小写不敏感，带缓存）
- 「在文件夹中显示」快速定位文件

**外观与自定义**

- 明暗主题 + 跟随系统；浅色主题下可切换配色方案（经典 / 樱花粉 / 雾蓝…）
- 字号、字体（衬线 / 无衬线）、内容密度、行号等界面设置
- 快捷键完全可自定义（冲突检测、一键重置）
- 中英双语界面

## 安装

Windows 安装包（NSIS，`annal_<ver>_x64-setup.exe`）通过 `npm run tauri build` 生成，见下文「构建安装包」。

## 开发

前置要求：Node.js ≥ 18、Rust 稳定版、Windows 需 WebView2（Win11 自带）。

```bash
npm install
npm run tauri dev      # 开发模式（热更新，Vite 固定 1420 端口）
```

类型检查与测试：

```bash
npx tsc --noEmit       # 前端唯一门禁
cargo test             # Rust 后端单元测试（src-tauri/）
```

## 构建安装包

```bash
npm run tauri build
# Windows 下生成 NSIS 安装向导：
#   src-tauri/target/release/bundle/nsis/annal_<ver>_x64-setup.exe
```

打包流程：`npm run build`（前端）→ cargo release 编译（Rust）→ tauri-bundler 打安装包。
安装包目前未签名，Windows SmartScreen 会提示「未知发布者」，选择「仍要运行」即可。

## 数据与存储

- 每篇笔记一个独立的 `.md` 文件，保存位置由你选择
- 元信息（id、标题、时间、路径）统一索引在 `index.json`，正文永远在明处
- 版本历史存于 `versions/`（指针记录 + 内容寻址的 `blobs/`，大块自动压缩）
- 图片附件存于 `attachments/`

应用数据目录由系统管理（Windows：`%APPDATA%\com.annal.desktop`，
macOS：`~/Library/Application Support/com.annal.desktop`，
Linux：`~/.local/share/com.annal.desktop`）。

## 项目结构

```
├── index.html            # 页面骨架（标题栏 / 侧边栏 / 编辑器 / 预览 / 覆盖层）
├── src/                  # 前端（无框架，信号驱动）
│   ├── editor.ts         # CodeMirror 6 编辑器
│   ├── markdownModel.ts  # 块级模型 + Markdown 渲染（增量解析）
│   ├── virtualPreview.ts # 虚拟化预览
│   ├── sidebar.ts        # 侧边栏（笔记 / 外部文件 / 搜索 / 多选）
│   ├── outline.ts        # 大纲
│   ├── i18n.ts           # 国际化（zh-CN / en-US）
│   └── app/              # 组合根与应用协调器（保存 / 同步 / 设置 / 窗口）
└── src-tauri/
    ├── src/lib.rs        # Rust 后端：笔记 CRUD + 版本历史 + 搜索 + 文件同步
    ├── tauri.conf.json   # 应用配置
    └── windows/          # NSIS 安装钩子
```

## 后续规划

- 标签 / 文件夹
- 多窗口
- 移动端同步
