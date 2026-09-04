// 确定性测试文档生成器：用固定种子的伪随机数生成中文 Markdown 文档，
// 保证「优化前」「优化后」两轮基准跑的是逐字节相同的文档与操作序列。

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "笔记 灵感 会议 项目 任务 时间 记录 思考 总结 计划 文档 代码 调试 优化 架构 模块 数据 界面 交互 体验 性能 内存 磁盘 网络 窗口 编辑 预览 搜索 历史 版本 提交 恢复 删除 置顶 导入 导出 布局 滚动 光标 撤销 重做 粘贴 复制 剪切 全选 替换 查找".split(
    " ",
  );

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

function sentence(rnd: () => number, minWords = 8, maxWords = 22): string {
  const n = minWords + Math.floor(rnd() * (maxWords - minWords));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(pick(rnd, WORDS));
  return parts.join("") + "。";
}

function paragraph(rnd: () => number, minSent = 2, maxSent = 5): string {
  const n = minSent + Math.floor(rnd() * (maxSent - minSent));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(sentence(rnd));
  return parts.join("");
}

const CODE_SAMPLES = [
  [
    "function fib(n) {",
    "  if (n <= 1) return n;",
    "  return fib(n - 1) + fib(n - 2);",
    "}",
    "console.log(fib(10));",
  ],
  [
    "import { invoke } from \"@tauri-apps/api/core\";",
    "",
    "export async function loadIndex(): Promise<NoteMeta[]> {",
    "  return invoke<NoteMeta[]>(\"list_notes\");",
    "}",
  ],
  [
    "SELECT id, title, updated_at",
    "FROM notes",
    "WHERE pinned = 1",
    "ORDER BY updated_at DESC",
    "LIMIT 20;",
  ],
  [
    "{",
    "  \"id\": \"note-42\",",
    "  \"title\": \"架构重构笔记\",",
    "  \"pinned\": true,",
    "  \"updatedAt\": 1756089600000",
    "}",
  ],
  [
    "set -eux",
    "cargo build --release",
    "cp target/release/annal.exe dist/",
    "echo done",
  ],
];

function codeBlock(rnd: () => number): string[] {
  const lang = pick(rnd, ["ts", "js", "sql", "json", "bash"]);
  const body = pick(rnd, CODE_SAMPLES);
  return ["```" + lang, ...body, "```"];
}

function table(rnd: () => number): string[] {
  const cols = 3 + Math.floor(rnd() * 2);
  const rows = 3 + Math.floor(rnd() * 4);
  const head = Array.from({ length: cols }, (_, i) => `列${i + 1}`).join(" | ");
  const sep = Array.from({ length: cols }, () => "---").join(" | ");
  const lines = [`| ${head} |`, `| ${sep} |`];
  for (let r = 0; r < rows; r++) {
    const cells = Array.from({ length: cols }, () => pick(rnd, WORDS)).join(" | ");
    lines.push(`| ${cells} |`);
  }
  return lines;
}

function list(rnd: () => number, ordered = false, task = false): string[] {
  const n = 3 + Math.floor(rnd() * 5);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const marker = ordered ? `${i + 1}. ` : "- ";
    const check = task ? (rnd() < 0.5 ? "[ ] " : "[x] ") : "";
    lines.push(marker + check + sentence(rnd, 4, 12));
  }
  return lines;
}

/** 生成一篇混合块类型的中文 Markdown 文档 */
export function genDoc(seed: number, blocks: number): string {
  const rnd = mulberry32(seed);
  const out: string[] = ["# 基准测试文档 " + seed, ""];
  for (let i = 0; i < blocks; i++) {
    const roll = rnd();
    if (roll < 0.14) {
      const level = 2 + Math.floor(rnd() * 3);
      out.push("#".repeat(level) + " " + sentence(rnd, 3, 8).replace(/。$/, ""));
    } else if (roll < 0.5) {
      out.push(paragraph(rnd));
    } else if (roll < 0.62) {
      out.push(...list(rnd));
    } else if (roll < 0.7) {
      out.push(...list(rnd, false, true));
    } else if (roll < 0.82) {
      out.push(...codeBlock(rnd));
    } else if (roll < 0.9) {
      out.push(...table(rnd));
    } else if (roll < 0.96) {
      out.push("> " + sentence(rnd, 5, 14));
    } else {
      out.push("---");
    }
    out.push("");
  }
  return out.join("\n");
}

/** 找到文档中靠近 frac 比例处的一段普通文本行（0 起始行号），用作打字位置 */
export function findParagraphLine(content: string, frac: number): number {
  const lines = content.split("\n");
  const start = Math.floor(lines.length * frac);
  const isPlain = (l: string) =>
    l.length > 8 && !/^\s*(?:$|#|`|>|-|\*|\+|\d|[\|]|---)/.test(l);
  for (let i = start; i < lines.length - 1; i++) {
    if (isPlain(lines[i])) return i;
  }
  for (let i = start; i > 0; i--) {
    if (isPlain(lines[i])) return i;
  }
  return 0;
}

/** 侧栏基准用的假笔记元信息 */
export interface FakeNote {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  path: string;
  pinned?: boolean;
}

export function genNotes(n: number): FakeNote[] {
  const rnd = mulberry32(999);
  const now = Date.now();
  const notes: FakeNote[] = [];
  for (let i = 0; i < n; i++) {
    notes.push({
      id: `note-${i}`,
      title: `${pick(rnd, WORDS)}${pick(rnd, WORDS)}的${pick(rnd, WORDS)} ${i}`,
      createdAt: now - i * 3600_000,
      updatedAt: now - i * 600_000,
      path: `C:\\notes\\note-${i}.md`,
      pinned: i < 3,
    });
  }
  return notes;
}
