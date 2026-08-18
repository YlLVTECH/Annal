import { build } from "esbuild";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const stubPlugin = {
  name: "s", setup(build) {
    const stub = (contents) => ({ contents, loader: "js" });
    build.onResolve({ filter: /^dompurify$/ }, () => ({ path: "d", namespace: "stub" }));
    build.onResolve({ filter: /^highlight\.js\/lib\/common$/ }, () => ({ path: "h", namespace: "stub" }));
    build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "t", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (a) => {
      if (a.path === "d") return stub('export default { sanitize: x=>x };');
      if (a.path === "h") return stub('export default { getLanguage:()=>false, highlight:()=>({value:""}) };');
      if (a.path === "t") return stub('export function convertFileSrc(p){return p;}');
      return stub("");
    });
  },
};
await build({ entryPoints: ["src/markdownModel.ts"], bundle: true, format: "esm", outfile: "scripts/.model-bundle.mjs", plugins: [stubPlugin], logLevel: "silent" });
const mod = await import(pathToFileURL(require.resolve("../scripts/.model-bundle.mjs")).href);

const text = ["# 标题","","第一段","","正文内容。","","## 小节",""].join("\n");
console.log("=== 直接 loadModel(新文本) ===");
mod.loadModel(text);
for (const b of mod.getBlocks()) console.log(" ", b.id, b.startLine+"-"+b.endLine, JSON.stringify(b.raw));

console.log("=== 先 loadModel(旧文本) 再 applyEdit ===");
const old = ["# 标题","","第一段正文内容。","","## 小节",""].join("\n");
mod.loadModel(old);
// 在行2中部插入 \n\n（range 是 0 起始行，行2）
mod.applyEdit(text, { start: 2, end: 2 });
for (const b of mod.getBlocks()) console.log(" ", b.id, b.startLine+"-"+b.endLine, JSON.stringify(b.raw));
