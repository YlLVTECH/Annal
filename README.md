<div align="center">

<img src="public/icon.png" alt="Annal 图标" width="110" />

# Annal

**极简桌面笔记 · 一个 Markdown 文件就是一篇笔记**

[![Release](https://img.shields.io/github/v/release/YlLVTECH/Annal?style=flat-square)](https://github.com/YlLVTECH/Annal/releases/latest)
[![License](https://img.shields.io/github/license/YlLVTECH/Annal?style=flat-square)](LICENSE)
[![Build & Publish](https://github.com/YlLVTECH/Annal/actions/workflows/release.yml/badge.svg?style=flat-square)](https://github.com/YlLVTECH/Annal/actions/workflows/release.yml)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=24C8DB&style=flat-square)](https://v2.tauri.app)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows11&logoColor=0078D6&style=flat-square)](#-安装)

[English](README.en.md) | 简体中文

基于 **Tauri 2 + Vite + 原生 TypeScript + Rust**。
数据完全本地：每篇笔记是你自己选择位置的一个 `.md` 文件，内建 git 式版本历史，每次显式提交都是一份可追溯、可恢复的记录。

[下载最新版](https://github.com/YlLVTECH/Annal/releases/latest) · [更新日志](CHANGELOG.md) · [报告问题](https://github.com/YlLVTECH/Annal/issues)

</div>

## ✨ 功能特性

**✍️ 写作与编辑**

- **即时渲染**——在编辑器内直接呈现 Markdown 版式，光标落点自动回退源码，写作与排版不打架（CodeMirror 6 + 按需加载的代码高亮）
- 自适应防抖自动保存（300ms–4s），关闭窗口前自动冲刷未落盘内容，不丢一字
- 标题（正文第一行）即文件名：改名自动同步磁盘、非法字符自动清理、重名自动加序号，绝不覆盖
- 大纲导航、字数统计、查找替换、表格插入（8×10 网格 + CSV/TSV/MD 智能识别）
- 粘贴 / 拖入图片自动保存为附件并插入引用

**🕘 版本历史（git 式）**

- 显式「提交」生成版本快照，内容按内容寻址去重存储（相同内容只存一份），大块自动压缩
- 历史面板支持行级 diff 对比，任意历史版本一键恢复

**📁 文件与搜索**

- 打开外部 Markdown 文件：文件对话框（Ctrl+O）、拖拽、双击文件关联均可
- 外部文件就地编辑保存、不纳入笔记索引；「另存为笔记」一键纳管
- 侧边栏全文搜索（大小写不敏感、带缓存）
- 「在文件夹中显示」快速定位文件

**🎨 外观与自定义**

- 明暗主题 + 跟随系统；浅色主题下可切换配色方案（经典 / 樱花粉 / 雾蓝…）
- 字号、字体（衬线 / 无衬线）、内容密度、行号等界面设置
- 快捷键完全可自定义（冲突检测、一键重置）
- 中英双语界面

## 📥 安装

从 [Releases](https://github.com/YlLVTECH/Annal/releases/latest) 下载 `annal_<版本>_x64-setup.exe`（Windows 10/11 x64），双击安装即可。

> 安装包目前未签名，Windows SmartScreen 会提示「未知发布者」——选择「更多信息 → 仍要运行」。

## 🛠 开发

前置要求：Node.js ≥ 18、Rust 稳定版；Windows 需 WebView2（Win11 自带）。

```bash
npm install
npm run tauri dev      # 开发模式（热更新，Vite 固定 1420 端口）
```

类型检查与测试：

```bash
npx tsc --noEmit       # 前端唯一门禁
cargo test             # Rust 后端单元测试（src-tauri/）
```

## 📦 构建安装包

```bash
npm run tauri build
# Windows 下生成 NSIS 安装向导：
#   src-tauri/target/release/bundle/nsis/annal_<ver>_x64-setup.exe
```

打包流程：`npm run build`（前端）→ cargo release 编译（Rust）→ tauri-bundler 打安装包。

## 🏷 版本发布

版本号以 `package.json` 为单一来源，通过 npm 生命周期钩子自动同步到 `src-tauri/tauri.conf.json`、`Cargo.toml`、`Cargo.lock`：

```bash
git pull               # 先保持工作区干净（npm version 要求无未提交改动）
npm version patch      # 或 minor / major：自动同步三处清单并创建 v<版本> 标签
git push --follow-tags # 标签推送后，GitHub Actions 自动构建 NSIS 包并发布 Release
```

设置页展示的版本号在构建期由 Vite `define` 注入（`__APP_VERSION__`），全仓库没有任何硬编码版本号。每次发版的显著变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## 🗂 数据与存储

- 每篇笔记一个独立的 `.md` 文件，保存位置由你选择
- 元信息（id、标题、时间、路径）统一索引在 `index.json`，正文永远在明处
- 版本历史存于 `versions/`（指针记录 + 内容寻址的 `blobs/`，大块自动压缩）
- 图片附件存于 `attachments/`

应用数据目录由系统管理（Windows：`%APPDATA%\com.annal.desktop`，
macOS：`~/Library/Application Support/com.annal.desktop`，
Linux：`~/.local/share/com.annal.desktop`）。

## 🧱 项目结构

```
├── index.html            # 页面骨架（标题栏 / 侧边栏 / 编辑器 / 大纲 / 覆盖层）
├── src/                  # 前端（无框架，信号驱动）
│   ├── editor.ts         # CodeMirror 6 编辑器
│   ├── liveRender.ts     # 即时渲染（Lezer 语法树驱动的视口级装饰）
│   ├── markdownModel.ts  # 块级模型 + Markdown 渲染（增量解析）
│   ├── sidebar.ts        # 侧边栏（笔记 / 外部文件 / 搜索 / 多选）
│   ├── outline.ts        # 大纲
│   ├── history.ts        # 版本历史面板（对比 / 恢复）
│   ├── i18n.ts           # 国际化（zh-CN / en-US）
│   └── app/              # 组合根与应用协调器（保存 / 同步 / 设置 / 窗口）
├── scripts/              # 版本号同步等工具脚本
└── src-tauri/
    ├── src/lib.rs        # Rust 后端：笔记 CRUD + 版本历史 + 搜索 + 文件同步
    ├── tauri.conf.json   # 应用配置
    └── windows/          # NSIS 安装钩子
```

## 🤝 参与贡献

欢迎提交 [Issue](https://github.com/YlLVTECH/Annal/issues) 与 Pull Request。提交前请确保 `npx tsc --noEmit` 通过；界面文案与代码注释使用中文。

## 📄 开源协议

本项目基于 [GNU GPL v3](LICENSE) 发布（SPDX：`GPL-3.0-or-later`）。
你可以自由使用、修改、分发本项目，但任何基于本项目的衍生作品必须同样以 GPL-3.0 协议开源。

Copyright © 2026 yilv

## 🗺 路线图

- [ ] 标签 / 文件夹
- [ ] 多窗口
- [ ] 移动端同步
