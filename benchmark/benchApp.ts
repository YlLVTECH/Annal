// 基准专用 Facade（运行重构后的架构）：不再静态加载已被替换的旧 state 单例接线。
// 「优化前」数据已固化在 results-before.json；after 模式使用 wiring-after。
import { initI18n } from "../src/i18n";
import { runAll } from "./scenarios";
import type { BenchResults } from "./facade";

declare global {
  interface Window {
    __benchResults?: BenchResults;
  }
}

function setStatus(text: string) {
  const el = document.querySelector("#bench-status");
  if (el) el.textContent = text;
}

export async function runBenchApp(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const arch = params.get("arch") ?? "after";
  if (arch !== "after") {
    throw new Error("重构后代码不再提供旧 state 单例；优化前数据请读取 benchmark/results-before.json");
  }

  let rafCount = 0;
  const tick = () => {
    rafCount++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const statusEl = document.querySelector<HTMLElement>("#bench-status");
  if (statusEl) {
    statusEl.style.cssText =
      "position:fixed;right:8px;top:8px;z-index:99999;background:#ffd;color:#111;font:11px/1.4 monospace;padding:4px 6px;border:1px solid #996;max-width:40vw;";
  }
  setStatus("加载 i18n…");
  await initI18n();

  const { afterFacade } = await import("./wiring-after");
  const results = await runAll(afterFacade, (name, idx, total) => {
    setStatus(`[after] ${idx}/${total} ${name} · raf/s≈${rafCount}`);
    rafCount = 0;
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
