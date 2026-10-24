// Draws stage/assets/screenshot.png: a made-up checkout page with a red error banner (no text, no real content).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const W = 720;
const H = 450;
const px = Buffer.alloc(W * H * 3);
const rect = (x: number, y: number, w: number, h: number, [r, g, b]: [number, number, number]) => {
  for (let j = y; j < Math.min(H, y + h); j++)
    for (let i = x; i < Math.min(W, x + w); i++) {
      const o = (j * W + i) * 3;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
    }
};
rect(0, 0, W, H, [245, 246, 250]);
rect(0, 0, W, 56, [30, 41, 59]);
rect(24, 20, 120, 16, [148, 163, 184]);
rect(24, 84, W - 48, 64, [254, 226, 226]);
rect(24, 84, 6, 64, [220, 38, 38]);
rect(48, 104, 260, 12, [185, 28, 28]);
rect(48, 124, 180, 10, [239, 68, 68]);
for (let k = 0; k < 4; k++) {
  rect(24, 180 + k * 52, 420, 36, [255, 255, 255]);
  rect(36, 192 + k * 52, 160 + k * 30, 12, [203, 213, 225]);
}
rect(472, 180, 224, 192, [255, 255, 255]);
rect(488, 320, 192, 36, [99, 102, 241]);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let j = 0; j < H; j++) px.copy(raw, j * (W * 3 + 1) + 1, j * W * 3, (j + 1) * W * 3);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
const out = join(dirname(fileURLToPath(import.meta.url)), "assets", "screenshot.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
