// 版本号单一来源是 package.json，本脚本把它同步到 Tauri 侧清单。
// 用法：node scripts/sync-version.mjs [--check]
//   默认     将三处清单改写为 package.json 的版本
//   --check  只校验是否一致，不一致则退出码 1（npm preversion 钩子使用）
import { readFileSync, writeFileSync } from "node:fs";

const checkOnly = process.argv.includes("--check");
const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

const targets = [
  {
    file: "src-tauri/tauri.conf.json",
    pattern: /(^[\s\S]*?"version"\s*:\s*)"([^"]*)"/,
  },
  {
    // 只匹配 [package] 段内的 version，避免误伤依赖版本
    file: "src-tauri/Cargo.toml",
    pattern: /(\[package\][^[]*?^version\s*=\s*)"[^"]*"/m,
  },
  {
    file: "src-tauri/Cargo.lock",
    pattern: /(name = "annal"\r?\nversion\s*=\s*)"[^"]*"/,
  },
];

let mismatched = 0;
for (const { file, pattern } of targets) {
  const text = readFileSync(file, "utf-8");
  const match = pattern.exec(text);
  if (!match) {
    console.error(`✗ ${file}: 未找到版本字段（请检查 pattern）`);
    mismatched++;
    continue;
  }
  const current = match[2] ?? /"([^"]*)"\s*$/.exec(match[0])[1];
  if (current === version) {
    console.log(`✓ ${file} 已是 ${version}`);
    continue;
  }
  if (checkOnly) {
    console.error(`✗ ${file}: ${current} != package.json 的 ${version}，请先运行 node scripts/sync-version.mjs`);
    mismatched++;
    continue;
  }
  writeFileSync(file, text.replace(pattern, (whole, prefix) => prefix + `"${version}"`));
  console.log(`✓ ${file}: ${current} → ${version}`);
}

if (mismatched > 0) process.exit(1);
