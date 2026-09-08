# 热路径性能基准（即时渲染时代）

测试环境：Windows 10 x64，ZCode 内置 WebView（Chromium 146 / Electron 41），1440×900，DPR 1。
原始数据：当前代码终态见 [`results-opt123.json`](./results-opt123.json)；重建 harness 后首轮基线存档见 [`results-baseline.json`](./results-baseline.json)。

## 运行方式

1. `npm run dev`（Vite 固定 1420 端口）；
2. 浏览器打开 `http://localhost:1420/benchmark/bench.html`；
3. 页面自动跑完全部场景，标题变为 `BENCH_DONE`（失败为 `BENCH_FAILED`，错误显示在 `#bench-error`）；
4. 结果在 `window.__benchResults`，同时渲染在 `#bench-results` 面板，自动化环境直接读该对象。

## 场景与计时口径

Harness 复用生产模块（`pipeline` / `outline` / `sidebar` / `editor`），由 `wiring.ts` 装配、`scenarios.ts` 驱动；
文档由 `docs.ts` 以固定种子生成（跨轮逐字节一致）。

| 场景 | 口径 |
|---|---|
| `calib_cpu` | 固定工作量整数循环，反映当轮 CPU 状态；跨轮比较先看它是否可比 |
| `micro_lezer_*` | 仅 `markdown()` 语言的最小编辑器，逐键 dispatch + 强制补全语法树，隔离「CM 事务 + Lezer 增量解析」 |
| `openDoc_*` | 打开文档（模型全量解析 + 编辑器重建 + 首屏装饰 + 首轮 measure） |
| `type_*` | 逐键 dispatch 计时：每键同步热路径（Lezer 解析 + 即时渲染装饰 + 块模型 + 保存簿记） |
| `type_medium_dom` | 逐键 dispatch + 每键强制 measure（计入每帧 DOM 同步） |
| `*_breakdown` | 同文档内「整键」vs「纯 `applyEdit`（块模型）」分解 |
| `cursor_large` | 逐格移动光标（selectionSet 触发的装饰重建） |
| `scroll_large` | 滚动一步（1/20 文档高度）+ 强制 measure（viewportChanged 重建 + DOM 同步） |
| `paste_large` | 单次插入 200 块多行内容（换行变化 → 块级 splice/整篇重解析） |
| `list_update_20` | 侧栏 20 次连续保存更新（信号微任务合并 → 单次列表重建） |

关键口径说明：

- **rAF 不可用环境**：自动化/后台 WebView 会把 rAF 节流到 0，而 CM 的 measure 阶段（视口计算、
  `viewportChanged`、DOM 同步）只挂 rAF。Harness 的 `frame()` 带定时器兜底，并以 `forceMeasure()`
  （`requestMeasure` + `readMeasured`）显式驱动视口建立，保证结果与运行环境无关。
- **`_nolive` 对照**：场景内通过 `setLiveRenderEnabled` 关闭即时渲染再测一遍，同轮差值
  （live − nolive）即装饰层成本，可抵消机器状态波动。
- **环境噪声**：本机后台负载会让整轮数字同比例波动（实测同场景跨轮可差 2~3 倍）。
  因此**结论只采信两类对照**：同一轮内的 `_nolive`/`_breakdown` 差值，以及回退单个优化后的
  回退对照（calib 校准一致）。跨轮绝对值仅作参考。

## 三项优化的实测结果

### 1. 块模型快速路径去掉每键整块 re-lex（`markdownModel.ts`）

背景：即时渲染用 CodeMirror 的 Lezer 语法树后，块模型的 HTML 已无热路径消费者（仅剩大纲读
`type`/`raw`/`startLine`）。旧快速路径每键对整个段落块跑 `marked` 重解析做类型校验，大段落下
每键都是 O(块大小)。由于任何会改变块类型的编辑必然产生结构化行或换行（已被既有的
`isStructuralLine` 检查拦截），段落块的 re-lex 校验是纯冗余。

改动：段落块走免 re-lex 快速路径（只刷新 `raw`/`key`/`version`）；其余 simple 类型
（heading/hr/code/table/html）块短，保留 re-lex 校验。

回退对照（同轮环境，calib 5.5 vs 5.4）：

| 场景（1200 行单一巨型段落，42KB） | 旧路径 | 免 re-lex | 变化 |
|---|---:|---:|---:|
| `applyEdit` 单独耗时（中位数） | 3.6 ms | 0.6 ms | **-83%** |
| 整键耗时（中位数） | 17.9 ms | 14.6 ms | -19% |

### 2. 即时渲染装饰拆分静态/选区两组（`liveRender.ts`）

背景：单一 ViewPlugin 在每次文档/视口/选区变化时全量重建装饰。其中行类与符号淡化
（标题/引用/代码块/表格的行样式、列表符号等）不依赖选区，却跟着每次光标移动一起重建。

改动：拆成两个 ViewPlugin——静态组只在文档/视口/语法树变化时重建；选区组（隐藏符号、
图片/水平线 widget）在光标移动时单独重建。两组均注册 `atomicRanges`（与旧行为一致）。

同轮对照（多轮稳定）：

| 场景 | 拆分前 | 拆分后 | 变化 |
|---|---:|---:|---:|
| 光标移动（中位数） | 0.9 ms | 0.4~0.5 ms | **约 -50%** |
| 光标移动 live − nolive 差值 | +0.1 ms | ≤ 0 ms | 选区组重建成本消失 |
| 打字 / 滚动 | — | — | 无回归（文档/视口变化时两组照常重建） |

视觉抽查（截图）确认：标题行类、行内符号隐藏/回退、引用/围栏/表格淡化、水平线 widget 与拆分前渲染一致。

### 3. 纯保存更新不再触发全量文件轮询（`app/fileSync.ts`）

背景：`notes`/`openFiles` 信号订阅直接触发 `sync_fs_state` 全量轮询，而每次自动保存都会
`notes.set`（updatedAt 变化、路径不变）——每次保存都对全部笔记做一次存在性 stat，
笔记数量大时保存链路被无谓放大 O(N)。

改动：信号订阅改为「路径集合签名」过滤——去重、小写、排序后的路径集合不变则跳过轮询；
新建/删除/改名/开关文件（集合变化）照常触发。60s 兜底轮询、`fs-notes-changed` 事件、
visibilitychange 路径不变。

该项为 IPC/文件系统开销，浏览器基准无法覆盖，验证方式：`npx tsc --noEmit` + 代码走查 +
真实 Tauri 环境手测（笔记数多时观察保存期间的文件系统活动）。

## 当前热点分布与剩余瓶颈

终态分解（`results-opt123.json`，calib 5.5）：

| 场景 | 中位数 | 说明 |
|---|---:|---|
| `type_medium`（599 行混合文档逐键） | 6.6 ms | 块模型仅 0.1 ms，其余为编辑器内核 + 装饰 |
| `type_bigpara`（1200 行单一巨型段落逐键） | 14.2 ms | 其中块模型 0.6 ms |
| `micro_lezer_bigpara`（最小编辑器同文档） | 12.8 ms | **剩余大头是 Lezer 增量解析本身** |
| `cursor_large` | 0.4 ms | |
| `scroll_large` | 10.6 ms（nolive 10.0） | |
| `openDoc_large`（3120 行） | 33.4 ms | |
| `paste_large`（200 块） | 33.2 ms | |
| `list_update_20` | 3.1 ms | |

结论：块模型与装饰层已不是每键热路径的瓶颈；单一巨型段落（无空行长文本）的每键成本
主要来自 `@codemirror/lang-markdown` 的 Lezer 增量解析（上游内核行为，最小编辑器复现），
本仓库无低成本解法，接受现状或跟进上游。常规混合文档每键 ~6 ms（本测试机 WebView 口径），
其中打字同步路径不触碰 DOM（DOM 同步在帧边界，`type_medium_dom` 显示追加成本 ≈ 0）。

## 历史存档：架构优化对比（2025-08，已过时）

以下为虚拟预览时代的架构对比结论（`results-before/after.json`），其中视图模式/滚动同步
已随后续重构移除，数据不再代表现状，仅作历史保留：

只保留有收益或不进入每键热路径的架构改动：

- 保留 `state.ts` 信号化和侧栏微任务批处理（侧栏 20 次批量更新 36.1 ms → 0.4 ms，-98.9%）；
- 保留 `main.ts` 拆分及 `src/app/` 小型协调器；
- 保留 `pipeline.ts` 作为编辑管线组合根；
- 保留低频生命周期事件（打开、关闭、视图、设置）；
- **回退退化的每键通用事件总线**，改为显式依赖注入和同步直连：

```text
editor.ts
  -> pipeline.ts
      -> markdownModel.applyEdit
      -> outline.refresh（防抖）
      -> save.notifyDocumentEdited
```

中间方案曾让每键编辑经过两次通用事件广播，测得中等文档打字 +40.0%、大文档打字 +77.7%、
回车拆分 +16.2%，已从生产热路径移除。这条约束仍然有效：**不要把每键工作路由进通用事件总线**。
