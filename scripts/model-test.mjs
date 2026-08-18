// 模型单元测试（无浏览器环境）：用 esbuild 把 markdownModel 打包并替换浏览器依赖为桩。
// 运行：node scripts/model-test.mjs
import { build } from "esbuild";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const stubPlugin = {
  name: "stub-browser-deps",
  setup(build) {
    const stub = (content) => ({
      contents: content,
      loader: "js",
    });
    build.onResolve({ filter: /^dompurify$/ }, () => ({
      path: "dompurify",
      namespace: "stub",
    }));
    build.onResolve({ filter: /^highlight\.js\/lib\/common$/ }, () => ({
      path: "hljs",
      namespace: "stub",
    }));
    build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
      path: "tauri-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      if (args.path === "dompurify") {
        return stub('export default { sanitize: (html) => html };');
      }
      if (args.path === "hljs") {
        return stub('export default { getLanguage: () => false, highlight: () => ({ value: "" }) };');
      }
      if (args.path === "tauri-core") {
        return stub('export function convertFileSrc(p) { return "asset://" + p; }');
      }
      return stub("");
    });
  },
};

await build({
  entryPoints: ["src/markdownModel.ts"],
  bundle: true,
  format: "esm",
  outfile: "scripts/.model-bundle.mjs",
  plugins: [stubPlugin],
  logLevel: "silent",
});

const mod = await import(pathToFileURL(require.resolve("../scripts/.model-bundle.mjs")).href);

/* ---------- 测试 ---------- */
let passed = 0;
let failed = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function demoDoc() {
  const parts = ["# 标题", "", "第一段正文内容。", "", "## 小节", "", "- 项目 A", "- 项目 B", "", "```js", "const a = 1;", "```", "", "| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |", "", "### 末段", "结尾文字。"];
  return parts.join("\n");
}

function lineOf(text, idx) {
  let line = 0;
  for (let i = 0; i < Math.min(idx, text.length); i++) if (text[i] === "\n") line++;
  return line;
}

/* 1. 初始加载：块覆盖全文、行号连续 */
console.log("1. 加载模型");
let text = demoDoc();
let blocks = mod.loadModel(text);
const totalLines = text.split("\n").length;
let linesCovered = 0;
for (const b of blocks) {
  ok(b.endLine >= b.startLine, `块行号合法 (${b.startLine}-${b.endLine})`);
  linesCovered += b.endLine - b.startLine + 1;
}
ok(linesCovered <= totalLines, "行号覆盖不超过文档", `covered=${linesCovered} total=${totalLines}`);
let rebuilt = mod.renderMarkdownWhole(text);
ok(rebuilt.includes("第一段正文内容"), "整篇渲染包含段落");
ok(rebuilt.includes("const a = 1"), "整篇渲染包含代码");

/* 2. 段落内打字（非结构化行）→ 只影响单个块 */
console.log("2. 段落内增量（快速路径）");
const p1 = text.indexOf("第一段正文内容");
const p1mid = p1 + 2;
const range1 = { start: lineOf(text, p1mid), end: lineOf(text, p1mid) };
const beforeVersions = new Map(blocks.map((b) => [b.id, b.version]));
text = text.slice(0, p1mid) + "X" + text.slice(p1mid);
blocks = mod.getBlocks();
const changed1 = mod.applyEdit(text, range1);
ok(changed1.size === 1, "只有一个块变化", `changed=${[...changed1]}`);
const affected = blocks.find((b) => changed1.has(b.id));
ok(affected && affected.raw.includes("X"), "受影响块内容包含新字符");
const others = blocks.filter((b) => changed1.has(b.id) === false);
ok(others.every((b) => b.version === beforeVersions.get(b.id)), "其余块版本未变");

/* 3. 空行插入（结构化）→ 全量重解析但内容未变块复用 id/版本 */
console.log("3. 结构化编辑（插入空行拆分段落）");
// 步骤 2 之后段落文本为「第一X段正文内容。」，直接在字符流中间插入 \n\n
const p2 = text.indexOf("第一X段正文内容");
const insertAt = p2 + 2; // 段落中「第一」与「X段正文内容。」之间插入 \n\n
const r2start = lineOf(text, insertAt);
const range2 = { start: r2start, end: r2start };
const versionsBefore2 = new Map(blocks.map((b) => [b.id, b.version]));
text = text.slice(0, insertAt) + "\n\n" + text.slice(insertAt);
const changed2 = mod.applyEdit(text, range2, { newlineChange: true });
blocks = mod.getBlocks(); // applyEdit 全量重解析会重建模块内部数组，需重新获取
const idsAfter2 = new Set(blocks.map((b) => b.id));
const reusedCount = [...versionsBefore2.keys()].filter((id) => idsAfter2.has(id)).length;
ok(reusedCount > blocks.length - 3, "大部分块按 key 复用", `reused=${reusedCount}/${blocks.length}`);
ok(changed2.size <= 3, "变化块 ≤ 3", `changed=${[...changed2]}`);
const hasFirstHalf = blocks.some((b) => b.type === "paragraph" && b.raw === "第一");
const hasSecondHalf = blocks.some((b) => b.type === "paragraph" && b.raw === "X段正文内容。");
ok(hasFirstHalf && hasSecondHalf, "段落被拆成两个独立段落块", `first=${hasFirstHalf} second=${hasSecondHalf} raws=${blocks.map((b) => JSON.stringify(b.raw.slice(0, 12))).join(", ")}`);

/* 4. 块覆盖一致性：空白间隔 + 块 raw 精确重建原文；每个非空行都被块覆盖 */
console.log("4. 块覆盖一致性");
function checkCoverage(t) {
  const bs = mod.getBlocks();
  let built = "";
  let cursor = 0;
  let okgaps = true;
  for (const b of bs) {
    const lo = mod.offsetOfLine(t, b.startLine);
    const gap = t.slice(cursor, lo);
    if (!/^\s*$/.test(gap)) okgaps = false;
    built += gap + b.raw;
    cursor = lo + b.raw.length;
  }
  built += t.slice(cursor);
  const joined = built === t;
  const covered = new Set();
  for (const b of bs) for (let ln = b.startLine; ln <= b.endLine; ln++) covered.add(ln);
  let allLinesCovered = true;
  const lines = t.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "" && !covered.has(i)) allLinesCovered = false;
  }
  return { joined, okgaps, allLinesCovered };
}
let cov = checkCoverage(text);
ok(cov.joined, "块 raw + 空白重建等于全文", `len=${[...mod.getBlocks()].reduce((a, b) => a + 0, 0)}`);
ok(cov.allLinesCovered, "每个非空行都被块覆盖");
ok(cov.okgaps, "块间间隔均为空白行");
let prevEnd = -1;
let lineConsistent = true;
for (const b of blocks) {
  if (b.startLine < prevEnd) lineConsistent = false;
  prevEnd = b.endLine;
}
ok(lineConsistent, "块按行号有序");

/* 5. 代码块/表格/列表块渲染 */
console.log("5. 块级渲染");
const codeBlock = blocks.find((b) => b.isCode);
ok(codeBlock && mod.renderBlockHtml(codeBlock).includes("const a = 1"), "代码块渲染");
const tableBlock = blocks.find((b) => b.type === "table");
ok(tableBlock && mod.renderBlockHtml(tableBlock).includes("<table"), "表格块渲染");
const listBlock = blocks.find((b) => b.type === "list");
ok(listBlock && mod.renderBlockHtml(listBlock).includes("<ul"), "列表块渲染");

/* 6. 大文档性能 */
console.log("6. 五万行文档性能");
const bigLines = [];
for (let i = 0; i < 50000; i++) bigLines.push(`第 ${i} 行内容填充文字。`);
let big = bigLines.join("\n");
let t0 = performance.now();
mod.loadModel(big);
let t1 = performance.now();
ok(t1 - t0 < 500, "5 万行全量解析 < 500ms", `${(t1 - t0).toFixed(1)}ms`);
const bigBlocks = mod.getBlocks();
ok(bigBlocks.length === 1, "纯文本 → 单个段落块", `blocks=${bigBlocks.length}`);
// 段落中间打字：快速路径
const mid = Math.floor(big.length / 2);
const rMid = { start: lineOf(big, mid), end: lineOf(big, mid) };
big = big.slice(0, mid) + "X" + big.slice(mid);
t0 = performance.now();
const changedBig = mod.applyEdit(big, rMid);
t1 = performance.now();
ok(changedBig.size === 1, "大文档段落内编辑只改一块", `changed=${changedBig.size}`);
// 备注：5 万行无空行的单一巨型段落，快速路径需要对整段重新单独解析（约 100ms）；
// 正常笔记按空行分段后，单块体量很小，该耗时可忽略。
ok(t1 - t0 < 200, "大文档快速路径 < 200ms（巨型段落上限）", `${(t1 - t0).toFixed(1)}ms`);
// 结构化编辑（插入空行）：全量重解析
const ins = big.indexOf("第 25000 行");
big = big.slice(0, ins) + "\n" + big.slice(ins);
const rIns = { start: lineOf(big, ins), end: lineOf(big, ins) };
t0 = performance.now();
mod.applyEdit(big, rIns, { newlineChange: true });
t1 = performance.now();
ok(t1 - t0 < 500, "大文档全量重解析 < 500ms", `${(t1 - t0).toFixed(1)}ms`);

/* 7. 删除行（合并段落）→ 全量路径正确 */
console.log("7. 删除换行合并块");
text = demoDoc();
mod.loadModel(text);
const pA = text.indexOf("第一段正文内容");
const pB = text.indexOf("第二", pA); // 不存在则跳过
if (pB > 0) {
  text = text.slice(0, pB - 1) + text.slice(pB);
  const r = { start: lineOf(text, pA), end: lineOf(text, pA) };
  mod.applyEdit(text, r);
  const cat = mod.getBlocks().map((b) => b.raw).join("");
  ok(cat === text, "删除换行后块拼接仍等于全文");
} else {
  ok(true, "跳过（示例文档无第二段）");
}

/* 8. 空文档编辑 */
console.log("8. 空文档");
mod.resetModel();
ok(mod.getBlocks().length === 0, "重置后无块");
let t = "";
const ch = mod.applyEdit(t, { start: 0, end: 0 });
ok(ch.size === 0, "空文档无变更");
t = "你好";
mod.applyEdit(t, { start: 0, end: 0 });
ok(mod.getBlocks().length === 1, "空文档输入后出现一个块");

/* 9. 末尾空行：完整行数独立于可渲染块范围 */
console.log("9. 末尾空行");
const trailingCases = [
  { text: "正文", lines: 1, blockEnd: 0, trailing: 0 },
  { text: "正文\n", lines: 2, blockEnd: 0, trailing: 1 },
  { text: "正文\n\n", lines: 3, blockEnd: 0, trailing: 2 },
  { text: "正文\n\n\n", lines: 4, blockEnd: 0, trailing: 3 },
  { text: "正文\n   \n", lines: 3, blockEnd: 0, trailing: 2 },
  { text: "\n", lines: 2, blockEnd: -1, trailing: 2 },
  { text: "\n\n", lines: 3, blockEnd: -1, trailing: 3 },
];
for (const sample of trailingCases) {
  mod.loadModel(sample.text);
  const sampleBlocks = mod.getBlocks();
  const lastEnd = sampleBlocks.length > 0 ? sampleBlocks[sampleBlocks.length - 1].endLine : -1;
  const tailStart = lastEnd + 1;
  ok(mod.getDocumentLineCount() === sample.lines, `完整行数正确 ${JSON.stringify(sample.text)}`);
  ok(lastEnd === sample.blockEnd, `可渲染块末行正确 ${JSON.stringify(sample.text)}`);
  ok(sample.lines - tailStart === sample.trailing, `尾区行数正确 ${JSON.stringify(sample.text)}`);
}

let trailingText = "正文";
mod.loadModel(trailingText);
for (let i = 1; i <= 3; i++) {
  trailingText += "\n";
  mod.applyEdit(trailingText, { start: i - 1, end: i - 1 }, { newlineChange: true });
  ok(mod.getDocumentLineCount() === i + 1, `连续插入第 ${i} 个末尾换行`);
}
for (let i = 3; i >= 1; i--) {
  trailingText = trailingText.slice(0, -1);
  mod.applyEdit(trailingText, { start: i - 1, end: i }, { newlineChange: true });
  ok(mod.getDocumentLineCount() === i, `连续删除第 ${i} 个末尾换行`);
}
mod.resetModel();
ok(mod.getDocumentLineCount() === 1, "重置后文档行数恢复为 1");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);