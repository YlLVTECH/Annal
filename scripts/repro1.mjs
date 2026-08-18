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

let text = ["# 标题","","第一段正文内容。","","## 小节","","- 项目 A","","```js","const a = 1;","```"].join("\n");
mod.loadModel(text);
console.log("orig blocks:", mod.getBlocks().map(b=>b.startLine+"-"+b.endLine+":"+JSON.stringify(b.raw.slice(0,18))))
const insertAt = text.indexOf("第一段正文内容") + 3;
const r = { start: 2, end: 2 }; // 段落所在行（0起始）为2
text = text.slice(0, insertAt) + "\n\n" + text.slice(insertAt);
mod.applyEdit(text, r);
const bs = mod.getBlocks();
console.log("after blocks:", bs.map(b=>b.startLine+"-"+b.endLine+":"+JSON.stringify(b.raw.slice(0,18))))
const cat = bs.map(b=>b.raw).join("");
console.log("concat==text?", cat === text, cat.length, text.length);
if (cat !== text) {
  let i = 0; while (i < Math.min(cat.length,text.length) && cat[i]===text[i]) i++;
  console.log("diff at", i, "cat=", JSON.stringify(cat.slice(Math.max(0,i-20),i+30)), "text=", JSON.stringify(text.slice(Math.max(0,i-20),i+30)));
}
console.log("lines:", text.split("\n").map((l)=>JSON.stringify(l)));
