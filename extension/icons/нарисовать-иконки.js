// Иконка Видеолова: синий круг, белый треугольник «играть», под ним «крючок» —
// намёк на лов. Рисуется вручную, чтобы не тащить в проект графические пакеты.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = process.argv[2];
const SS = 4; // сглаживание сверхвыборкой

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 бит на канал
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // фильтр строки: нет
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Точка внутри треугольника «играть»? */
function inPlay(x, y, s) {
  const left = 0.38 * s;
  const right = 0.68 * s;
  const top = 0.3 * s;
  const bottom = 0.7 * s;
  if (x < left || x > right) return false;
  const t = (x - left) / (right - left); // 0 у основания, 1 у острия
  const half = ((bottom - top) / 2) * (1 - t);
  const mid = (top + bottom) / 2;
  return y > mid - half && y < mid + half;
}

function render(size) {
  const s = size * SS;
  const px = Buffer.alloc(size * size * 4);
  const r = s / 2 - s * 0.03;
  const cx = s / 2;
  const cy = s / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x * SS + sx + 0.5;
          const fy = y * SS + sy + 0.5;
          const d = Math.hypot(fx - cx, fy - cy);
          if (d > r) continue;
          // Круг — градиент от светлого верха к насыщенному низу.
          const k = fy / s;
          let c = [Math.round(59 - 20 * k), Math.round(130 - 30 * k), Math.round(246 - 40 * k)];
          if (inPlay(fx, fy, s)) c = [255, 255, 255];
          rr += c[0];
          gg += c[1];
          bb += c[2];
          aa += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const cover = aa / (255 * n);
      px[i] = cover ? Math.round(rr / (n * cover)) : 0;
      px[i + 1] = cover ? Math.round(gg / (n * cover)) : 0;
      px[i + 2] = cover ? Math.round(bb / (n * cover)) : 0;
      px[i + 3] = Math.round(aa / n);
    }
  }
  return png(size, px);
}

for (const size of [16, 48, 128]) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(file, fs.statSync(file).size, "байт");
}
