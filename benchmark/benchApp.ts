// 基准应用入口：初始化 i18n 后动态加载当前架构接线与场景 runner。
// 结果写入 window.__benchResults 并渲染到页面，供自动化环境读取。

import { initI18n } from "../src/i18n";
import { runAll } from "./scenarios";
import type { BenchResults } from "./facade";

declare global {
  interface Window {
    __benchResults?: BenchResults;
  }
}

export async function runBenchApp(): Promise<void> {
  const statusEl = document.querySelector<HTMLElement>("#bench-status")!;
  statusEl.style.cssText =
    "position:fixed;right:8px;top:8px;z-index:99999;background:#ffd;color:#111;font:11px/1.4 monospace;padding:4px 6px;border:1px solid #996;max-width:40vw;";
  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  setStatus("加载 i18n…");
  await initI18n();

  const { benchFacade } = await import("./wiring");
  const results = await runAll(benchFacade, (name, idx, total) => {
    setStatus(`${idx}/${total} ${name}`);
  });

  window.__benchResults = results;
  const pre = document.createElement("pre");
  pre.id = "bench-results";
  pre.style.cssText =
    "position:fixed;left:8px;bottom:8px;max-width:60vw;max-height:40vh;overflow:auto;z-index:99999;background:#fff;color:#111;font:11px/1.5 monospace;padding:8px;border:1px solid #999;";
  pre.textContent = JSON.stringify(results, null, 2);
  document.body.appendChild(pre);
  document.title = "BENCH_DONE";
}
