// Generates the application and tray icons without third-party image tooling.
// The mark is a small original "orbital" glyph: a tilted ring, a satellite dot
// and a soft core on a neutral dark rounded background.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Encode RGBA8 pixel data as a PNG buffer. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function blend(target, index, r, g, b, a) {
  if (a <= 0) return;
  const dstA = target[index + 3] / 255;
  const srcA = clamp01(a);
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  target[index] = Math.round((r * srcA + target[index] * dstA * (1 - srcA)) / outA);
  target[index + 1] = Math.round((g * srcA + target[index + 1] * dstA * (1 - srcA)) / outA);
  target[index + 2] = Math.round((b * srcA + target[index + 2] * dstA * (1 - srcA)) / outA);
  target[index + 3] = Math.round(outA * 255);
}

/**
 * Render the orbital mark.
 * `withBackground` draws the rounded dark plate used by the app icon; the tray
 * variant stays transparent so Windows can place it on any taskbar theme.
 */
function render(size, withBackground) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size / 2;
  const tilt = (-28 * Math.PI) / 180;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const ringRx = 0.74 * radius;
  const ringRy = 0.30 * radius;
  // Stroke width in normalized ellipse units keeps the ring crisp at every size.
  const ringHalfWidth = 0.035;
  const dotRadius = Math.max(1.2, 0.115 * radius);
  const dotAngle = -0.62;
  const dotX = radius + Math.cos(dotAngle) * ringRx * cos - Math.sin(dotAngle) * ringRy * sin;
  const dotY = radius + Math.cos(dotAngle) * ringRx * sin + Math.sin(dotAngle) * ringRy * cos;
  const coreRadius = 0.155 * radius;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const px = x + 0.5 - radius;
      const py = y + 0.5 - radius;

      if (withBackground) {
        const half = size / 2;
        const corner = 0.22 * size;
        const dx = Math.max(Math.abs(px) - (half - corner), 0);
        const dy = Math.max(Math.abs(py) - (half - corner), 0);
        const dist = Math.hypot(dx, dy);
        const plate = 1 - smoothstep(corner - 2, corner, dist);
        const shade = 1 - clamp01(Math.hypot(px, py) / (radius * 1.9));
        blend(rgba, index, 13 + 9 * shade, 17 + 12 * shade, 23 + 16 * shade, plate);
      }

      // Rotated ellipse ring distance.
      const rx = px * cos + py * sin;
      const ry = -px * sin + py * cos;
      const norm = Math.hypot(rx / ringRx, ry / ringRy);
      // Annulus: fade in towards the radius, out past it.
      const ringAlpha =
        smoothstep(1 - ringHalfWidth, 1, norm) * (1 - smoothstep(1, 1 + ringHalfWidth, norm));
      const ringFade = 0.3 + 0.7 * clamp01((rx / ringRx + 1) / 2);
      blend(rgba, index, 158, 190, 255, ringAlpha * ringFade * 0.85);

      const core = 1 - smoothstep(coreRadius * 0.55, coreRadius, Math.hypot(px, py));
      blend(rgba, index, 226, 238, 255, core * 0.95);

      const glow = Math.exp(-Math.pow(Math.hypot(px - (dotX - radius), py - (dotY - radius)) / (dotRadius * 1.6), 2));
      blend(rgba, index, 120, 170, 255, glow * 0.22);

      const dot = 1 - smoothstep(dotRadius * 0.75, dotRadius, Math.hypot(px - (dotX - radius), py - (dotY - radius)));
      blend(rgba, index, 245, 250, 255, dot);
    }
  }
  return rgba;
}

function writePng(file, size, withBackground) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng(size, size, render(size, withBackground)));
  return file;
}

const written = [
  writePng(join(root, 'build', 'icon.png'), 256, true),
  writePng(join(root, 'build', 'icon-512.png'), 512, true),
  writePng(join(root, 'dist', 'assets', 'tray.png'), 32, false),
  writePng(join(root, 'dist', 'assets', 'tray@2x.png'), 64, false),
  writePng(join(root, 'dist', 'assets', 'app-icon.png'), 256, true),
];

for (const file of written) console.log(`icon: ${file}`);
