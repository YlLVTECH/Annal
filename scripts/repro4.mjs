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

function lineOf(text, idx) {
  let line = 0;
  for (let i = 0; i < Math.min(idx, text.length); i++) if (text[i] === "\n") line++;
  return line;
}

const parts = ["# 标题", "", "第一段正文内容。", "", "## 小节", "", "- 项目 A", "- 项目 B", "", "```js", "const a = 1;", "```", "", "| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |", "", "### 末段", "结尾文字。"];
let text = parts.join("\n");
mod.loadModel(text);
// step2: 打字
const p1 = text.indexOf("第一段正文内容");
const p1mid = p1 + 2;
text = text.slice(0, p1mid) + "X" + text.slice(p1mid);
mod.applyEdit(text, { start: lineOf(text, p1mid), end: lineOf(text, p1mid) });
console.log("step2 blocks:");
for (const b of mod.getBlocks()) console.log("  ", b.id, b.startLine + "-" + b.endLine, JSON.stringify(b.raw.slice(0, 30)));
// step3: 插入 \n\n
const p2 = text.indexOf("第一段正文内容X");
const insertAt = p2 + 3;
text = text.slice(0, insertAt) + "\n\n" + text.slice(insertAt);
mod.applyEdit(text, { start: lineOf(text, insertAt), end: lineOf(text, insertAt) });
console.log("step3 blocks:");
for (const b of mod.getBlocks()) console.log("  ", b.id, b.startLine + "-" + b.endLine, JSON.stringify(b.raw.slice(0, 30)));
const cat = mod.getBlocks().map((b) => b.raw).join("");
console.log("coverage:", cat === text, cat.length, text.length);
// 打印原文各行
console.log("text lines:", text.split("\n").map((l) => JSON.stringify(l)));
