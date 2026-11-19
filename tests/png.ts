// Tiny PNG screenshots for the fake gallery: a mock app frame (header,
// sidebar on desktop, content blocks) in light or dark, drawn row by row.
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// seed varies the content a little, so different scenes look different.
export function screenshotPng(width: number, height: number, opts: { dark: boolean; phone: boolean; seed: number }) {
  const c = opts.dark
    ? { bg: hex("#16151b"), side: hex("#121117"), bar: hex("#1d1c23"), line: hex("#2e2c35"), block: hex("#29272f"), accent: hex("#959bff") }
    : { bg: hex("#fcfbf8"), side: hex("#f3f1eb"), bar: hex("#ffffff"), line: hex("#e4e0d6"), block: hex("#ebe8e0"), accent: hex("#3b3fd8") };
  const sidebar = opts.phone ? 0 : Math.round(width * 0.17);
  const header = opts.phone ? 56 : 52;
  const pad = opts.phone ? 16 : 32;
  const blocks: { x: number; y: number; w: number; h: number; color: RGB }[] = [];
  let y = header + pad;
  let i = 0;
  while (y < height - pad) {
    const h = i === 0 ? 28 : 14 + ((opts.seed * 7 + i * 13) % 4) * 20;
    const w = Math.round((width - sidebar - pad * 2) * (i === 0 ? 0.45 : 0.55 + (((opts.seed + i) * 17) % 40) / 100));
    blocks.push({ x: sidebar + pad, y, w, h, color: i === 0 ? c.accent : c.block });
    y += h + 16;
    i++;
  }
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) {
    const o = row * (width * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < width; x++) {
      let px = c.bg;
      if (row < header) px = row === header - 1 ? c.line : c.bar;
      else if (x < sidebar) px = x === sidebar - 1 ? c.line : c.side;
      for (const b of blocks) if (x >= b.x && x < b.x + b.w && row >= b.y && row < b.y + b.h) px = b.color;
      raw[o + 1 + x * 3] = px[0];
      raw[o + 2 + x * 3] = px[1];
      raw[o + 3 + x * 3] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
