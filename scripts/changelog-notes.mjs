// 从 CHANGELOG.md 提取指定版本的条目，作为 GitHub Release 的说明正文。
// 用法：node scripts/changelog-notes.mjs <version|vX.Y.Z> [输出文件]
//   不传输出文件时写到标准输出；CHANGELOG 里没有该版本时用兜底文案，退出码仍为 0（不阻断发布）。
import { readFileSync, writeFileSync } from "node:fs";

const rawVersion = process.argv[2] ?? "";
const version = rawVersion.replace(/^v/, "");
const outFile = process.argv[3];

if (!version) {
  console.error("用法：node scripts/changelog-notes.mjs <version|vX.Y.Z> [输出文件]");
  process.exit(2);
}

const lines = readFileSync("CHANGELOG.md", "utf-8").split(/\r?\n/);
// 版本号里的 . 等在正则里是元字符，转义后再拼进标题匹配
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingPattern = new RegExp(`^## \\[${escaped}\\]`);

let body = "";
const start = lines.findIndex((line) => headingPattern.test(line));
if (start >= 0) {
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^## \[/.test(line));
  body = (next >= 0 ? rest.slice(0, next) : rest).join("\n").trim();
}

if (!body) {
  body = `本版本（v${version}）未在 CHANGELOG.md 中找到条目。`;
}

const footer = [
  `> 安装包：\`Annal_${version}_x64-setup.exe\`（Windows 10/11 x64，NSIS，未签名）。`,
  "> 由 GitHub Actions 在 windows-latest 上自动构建，版本号取自 `package.json`。",
].join("\n");

const notes = `${body}\n\n${footer}\n`;
if (outFile) {
  writeFileSync(outFile, notes);
  console.log(`✓ Release 说明已写入 ${outFile}`);
} else {
  process.stdout.write(notes);
}
