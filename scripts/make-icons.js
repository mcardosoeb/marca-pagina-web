// Gera os ícones PNG do app (sem dependências): `npm run icons`
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  bg: hex("#8a2f1d"),
  page: hex("#f5efe3"),
  spine: hex("#e2d4bb"),
  line: hex("#cdbb9e"),
  ribbon: hex("#e2b14a"),
  ribbonShade: hex("#c8962f"),
};

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// cor em coordenadas normalizadas (0..1)
function colorAt(x, y) {
  let c = C.bg;
  if (inRoundRect(x, y, 0.22, 0.15, 0.78, 0.85, 0.045)) {
    c = C.page;
    if (x < 0.285) c = C.spine;
    const lines = [0.33, 0.41, 0.49, 0.57, 0.65, 0.73];
    lines.forEach((ly, i) => {
      const xEnd = i === lines.length - 1 ? 0.55 : 0.68;
      if (y >= ly && y <= ly + 0.024 && x >= 0.34 && x <= xEnd) c = C.line;
    });
  }
  // fita marcadora com corte em V
  const rx0 = 0.56, rx1 = 0.67, mid = (rx0 + rx1) / 2, half = (rx1 - rx0) / 2;
  if (x >= rx0 && x <= rx1 && y >= 0.08) {
    const bottom = 0.58 - 0.07 * (1 - Math.abs(x - mid) / half);
    if (y <= bottom) c = x > mid + half * 0.55 ? C.ribbonShade : C.ribbon;
  }
  return c;
}

function render(size) {
  const SS = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0; // filtro "none"
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      const n = SS * SS, o = py * (size * 3 + 1) + 1 + px * 3;
      raw[o] = Math.round(r / n); raw[o + 1] = Math.round(g / n); raw[o + 2] = Math.round(b / n);
    }
  }
  return png(size, size, raw);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // RGB 8 bits
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(out, { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  fs.writeFileSync(path.join(out, name), render(size));
  console.log("gerado", name);
}
