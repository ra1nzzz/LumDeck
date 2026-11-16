// Generates LumDeck bundle icons (PNG set + Windows .ico) procedurally.
// Design: a rounded "dock" pill with a blue→violet gradient and a white bar.
// Run: node tools/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const lerp = (a, b, t) => a + (b - a) * t;
function mix(c1, c2, t) {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}
const C_TOP = [74, 144, 255];   // #4a90ff
const C_BOT = [124, 92, 255];   // #7c5cff
const WHITE = [255, 255, 255];

function iconPixel(x, y, size) {
  const s = size;
  const px = (x + 0.5) / s;
  const py = (y + 0.5) / s;
  const R = 0.5;
  // rounded-square mask
  const rad = 0.24;
  const cx = Math.min(px, 1 - px), cy = Math.min(py, 1 - py);
  let inside = 1;
  const inCorner = cx < rad && cy < rad;
  if (inCorner) {
    const dx = rad - cx, dy = rad - cy;
    inside = (dx * dx + dy * dy) <= rad * rad ? 1 : 0;
  }
  if (!inside) return [0, 0, 0, 0];
  // gradient background
  const g = mix(C_TOP, C_BOT, py);
  // white dock bar across the lower-middle
  const barTop = 0.56, barH = 0.12, barPad = 0.2;
  if (py >= barTop && py <= barTop + barH && px >= barPad && px <= 1 - barPad) {
    // round the bar ends
    const rr = barH / 2;
    const bcx = Math.min(px - barPad, (1 - barPad) - px);
    const bcy = Math.min(py - barTop, (barTop + barH) - py);
    let bin = 1;
    if (bcx < rr && bcy < rr) {
      const dx = rr - bcx, dy = rr - bcy;
      bin = (dx * dx + dy * dy) <= rr * rr ? 1 : 0;
    }
    if (bin) return [...WHITE, 235];
  }
  // subtle top sheen
  const sheen = py < 0.3 ? (1 - py / 0.3) * 26 : 0;
  return [Math.min(255, g[0] + sheen), Math.min(255, g[1] + sheen), Math.min(255, g[2] + sheen), 255];
}

function encodeICO(entries) {
  // entries: [{size, png}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  const images = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    dir.push(d);
    images.push(e.png);
    offset += e.png.length;
  }
  return Buffer.concat([header, ...dir, ...images]);
}

const sizes = [32, 128, 256];
const pngs = {};
for (const s of sizes) {
  const png = encodePNG(s, iconPixel);
  pngs[s] = png;
  writeFileSync(join(outDir, s === 128 ? "128x128.png" : `${s}x${s}.png`), png);
}
writeFileSync(join(outDir, "128x128@2x.png"), pngs[256]);
writeFileSync(join(outDir, "icon.ico"), encodeICO([
  { size: 16, png: encodePNG(16, iconPixel) },
  { size: 32, png: pngs[32] },
  { size: 48, png: encodePNG(48, iconPixel) },
  { size: 256, png: pngs[256] },
]));
// Square logo used by the store / about (PNG only).
writeFileSync(join(outDir, "icon.png"), pngs[256]);
console.log("icons written to", outDir);
