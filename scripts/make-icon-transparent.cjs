// 把烧进像素的棋盘格"假透明"背景抠成真 alpha 透明。
// 用法: node scripts/make-icon-transparent.cjs <输入.png> <输出.png>
// 思路: 背景棋盘格(浅灰/近白)与图标页面内部填充颜色几乎相同,
// 不能全局换色;利用图标外圈深色描边是闭合区域,从图像四边向内
// 泛洪填充,遇到非背景像素(描边)即停,内部不会被触及。
const fs = require('fs');
const zlib = require('zlib');

// ---------- PNG 解码(支持 8bit RGB/RGBA,非隔行) ----------
function decodePNG(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8, w, h, bitDepth, colorType, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8bit 位深,实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  if (colorType !== 2 && colorType !== 6) throw new Error('仅支持 RGB/RGBA,实际颜色类型 ' + colorType);
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const lines = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = lines[i * ch];
    rgba[i * 4 + 1] = lines[i * ch + 1];
    rgba[i * 4 + 2] = lines[i * ch + 2];
    rgba[i * 4 + 3] = ch === 4 ? lines[i * ch + 3] : 255;
  }
  return { w, h, rgba };
}

// ---------- PNG 编码(RGBA,filter 0) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(path, w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path, png);
}

// ---------- 抠图 ----------
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法: node scripts/make-icon-transparent.cjs <输入.png> <输出.png>');
  process.exit(1);
}
const { w, h, rgba } = decodePNG(input);

// 背景判定:棋盘格两色(实测 ~[231-240] 与 ~[249-254])加压缩噪声,
// 取"足够亮且接近无彩色"作为阈值
const BG_MIN = 226, BG_MAX_DIFF = 15;
const isBg = (i) => {
  const o = i * 4;
  const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
  const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
  return mn >= BG_MIN && mx - mn <= BG_MAX_DIFF;
};

// 从四边泛洪填充(BFS)
const total = w * h;
const transparent = new Uint8Array(total);
const queue = new Int32Array(total);
let head = 0, tail = 0;
const push = (i) => {
  if (!transparent[i] && isBg(i)) { transparent[i] = 1; queue[tail++] = i; }
};
for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
while (head < tail) {
  const i = queue[head++];
  const x = i % w, y = (i / w) | 0;
  if (x > 0) push(i - 1);
  if (x < w - 1) push(i + 1);
  if (y > 0) push(i - w);
  if (y < h - 1) push(i + w);
}

// 描边反走样:与透明区相邻的像素是"描边色 × 背景色"的混合,
// 按亮度反解出覆盖率和前景色,避免留下亮色光晕
const BG_LUM = 240, FG_LUM = 60;
let feathered = 0;
const snapshot = Buffer.from(rgba); // 邻域判断用原值
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (transparent[i]) { rgba[i * 4 + 3] = 0; continue; }
    const nbTrans =
      (x > 0 && transparent[i - 1]) || (x < w - 1 && transparent[i + 1]) ||
      (y > 0 && transparent[i - w]) || (y < h - 1 && transparent[i + w]);
    if (!nbTrans) continue;
    const o = i * 4;
    const lum = 0.299 * snapshot[o] + 0.587 * snapshot[o + 1] + 0.114 * snapshot[o + 2];
    let a = (BG_LUM - lum) / (BG_LUM - FG_LUM);
    a = Math.max(0, Math.min(1, a));
    if (a <= 0.02) { rgba[o + 3] = 0; feathered++; continue; }
    if (a < 0.98) {
      for (let c = 0; c < 3; c++) {
        rgba[o + c] = Math.max(0, Math.min(255, Math.round((snapshot[o + c] - (1 - a) * BG_LUM) / a)));
      }
      rgba[o + 3] = Math.round(a * 255);
      feathered++;
    }
  }
}

let cleared = 0;
for (let i = 0; i < total; i++) if (transparent[i]) cleared++;
console.log(`背景清除 ${cleared} 像素 (${(cleared / total * 100).toFixed(1)}%),描边羽化 ${feathered} 像素`);

encodePNG(output, w, h, rgba);
console.log(`已写出 ${output} (${w}x${h} RGBA)`);
