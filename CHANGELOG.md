# 更新日志

本项目的所有显著变更都会记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.0] - 2026-09-08

### 新增

- 表格即时渲染：光标离开表格时整块替换为渲染后的 HTML 表格（复用 marked + DOMPurify，单元格内行内语法一并呈现），光标触及即回退源码继续编辑
- 编辑器语法切换为 GFM（表格 / 删除线 / 任务列表等节点可被即时渲染识别）
- 版本号单一来源：以 `package.json` 为准，`npm version <bump>` 自动同步 `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` 并打标签；设置页版本号改为构建期注入（`__APP_VERSION__`），全仓库不再硬编码

### 性能

- 块模型快速路径：段落块免每键整块 re-lex，1200 行巨型段落下 `applyEdit` 中位数 3.6 ms → 0.6 ms（-83%）
- 即时渲染装饰拆分为静态组 / 选区组：光标移动中位数约 0.9 ms → 0.4~0.5 ms（约 -50%）
- 保存链路不再全量轮询文件状态：路径集合未变（纯内容保存）即跳过 `sync_fs_state`
- 基准 harness 重建（`benchmark/wiring.ts`、`scenarios.ts`、`bench.html`），新增 `_nolive` 对照与 `calib_cpu` 校准口径

### 文档

- README 重构为 GitHub 风格（徽章、下载引导、版本发布流程），新增本更新日志
- AGENTS.md 同步版本管理与表格即时渲染的装饰链路说明

## [0.3.0] - 2026-09-04

### 新增

- 即时渲染：在编辑器内直接呈现 Markdown 版式（Lezer 语法树驱动的视口级装饰），光标触及的节点回退显示源码
- 开源协议：GPL-3.0-or-later（LICENSE 全文 + 各清单 SPDX 标注）

### 移除

- 虚拟预览与「编辑 / 分屏 / 预览」视图模式切换

## [0.2.0] - 2026-09-03

### 首个公开打标版本

- Tauri 2 桌面应用：笔记增删改查、自适应防抖自动保存（300ms–4s）、外部 Markdown 文件就地编辑
- git 式版本历史：显式提交生成快照、内容寻址去重存储、行级差异对比、任意版本一键恢复
- 全文搜索（大小写不敏感、带缓存）、批量删除 / 导出、查找替换、大纲导航、表格插入
- 界面自定义：明暗主题 + 跟随系统、浅色配色方案、字号 / 字体 / 内容密度 / 行号
- 快捷键完全可自定义（冲突检测、一键重置）、中英双语界面（zh-CN / en-US）
- Windows NSIS 安装包：安装 / 卸载自动刷新 Shell 图标缓存；GitHub Actions 按 `v*` 标签自动构建并发布 Release
- 项目定名 Annal（productName / 应用标识 / crate / 存储前缀全量迁移）

[Unreleased]: https://github.com/YlLVTECH/Annal/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/YlLVTECH/Annal/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/YlLVTECH/Annal/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/YlLVTECH/Annal/releases/tag/v0.2.0
