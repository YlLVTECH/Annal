// 基准入口：先通过异步 setup 模块注入 DOM 骨架，再动态加载应用模块。
// 不能静态 import benchApp：ESM 会先求值依赖图，而 editor/sidebar 在模块级查询 DOM。
import "./stub-tauri";
import "../src/styles.css";

async function setupDom(): Promise<void> {
  const res = await fetch("/index.html");
  if (!res.ok) throw new Error(`加载 DOM 骨架失败：HTTP ${res.status}`);
  const parsed = new DOMParser().parseFromString(await res.text(), "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  const status = document.createElement("pre");
  status.id = "bench-status";
  status.textContent = "bench starting…";
  document.body.appendChild(status);
}

(async () => {
  await setupDom();
  const { runBenchApp } = await import("./benchApp");
  await runBenchApp();
})().catch((err) => {
  document.title = "BENCH_FAILED";
  const pre = document.createElement("pre");
  pre.id = "bench-error";
  pre.style.cssText =
    "position:fixed;inset:auto 8px 8px 8px;max-height:60vh;overflow:auto;z-index:99999;background:#fee;color:#300;font:12px/1.5 monospace;padding:8px;";
  pre.textContent = String(err?.stack ?? err);
  document.body.appendChild(pre);
});
