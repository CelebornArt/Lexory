import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, combined, crcBuf]);
}

function insideRoundedRect(x, y, rx, ry, rw, rh, rad) {
  if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) return false;
  const cx = x < rx + rad ? rx + rad : x > rx + rw - rad ? rx + rw - rad : x;
  const cy = y < ry + rad ? ry + rad : y > ry + rh - rad ? ry + rh - rad : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function renderIconPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const scale = size / 512;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter none
    const sy = (y + 0.5) / scale;

    for (let x = 0; x < size; x++) {
      const sx = (x + 0.5) / scale;
      let r = 0, g = 0, b = 0, a = 0;

      if (insideRoundedRect(sx, sy, 0, 0, 512, 512, 112)) {
        r = 24; g = 24; b = 27; a = 255;

        if (insideRoundedRect(sx, sy, 88, 196, 336, 120, 28)) {
          r = 255; g = 255; b = 255; a = 255;

          if (insideRoundedRect(sx, sy, 128, 242, 176, 28, 14)) {
            r = 24; g = 24; b = 27; a = 255;
          }

          const dx = sx - 372;
          const dy = sy - 256;
          if (dx * dx + dy * dy <= 24 * 24) {
            r = 22; g = 163; b = 74; a = 255;
          }
        }
      }

      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconsDir = path.join(ROOT_DIR, 'www', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), renderIconPng(192));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), renderIconPng(512));

console.log('Generated PNG icons: 192, 512');
