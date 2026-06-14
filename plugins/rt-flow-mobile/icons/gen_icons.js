"use strict";
// 零依赖图标生成: 画一个深底 + 绿色「流」环 (rt-flow 主色) 的 PNG。
// 运行: node icons/gen_icons.js  → 产出 icon48.png / icon128.png
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function png(size, filename) {
  const w = size, h = size;
  const buf = Buffer.alloc(w * h * 4);
  const cx = w / 2, cy = h / 2;
  const rOuter = size * 0.40, rInner = size * 0.26;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 深底
      let r = 30, g = 30, b = 30, a = 255;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= rOuter && d >= rInner) {
        // 绿环 #2ea44f → 渐变到亮绿
        const t = (d - rInner) / (rOuter - rInner);
        r = Math.round(46 + t * 20);
        g = Math.round(164 + t * 40);
        b = Math.round(79 + t * 20);
      } else if (d < rInner) {
        // 内心点
        r = 63; g = 185; b = 80;
        if (d > rInner * 0.45) { r = 30; g = 30; b = 30; }
      }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  // 组装 PNG (RGBA, 8-bit)
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    buf.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  fs.writeFileSync(path.join(__dirname, filename), out);
  console.log("wrote", filename, out.length, "bytes");
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

png(48, "icon48.png");
png(128, "icon128.png");
