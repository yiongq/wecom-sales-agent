// 读 woff2 里 cmap 映射到的码位，给 scripts/check-fonts.ts 用：不装 fonttools、只用 Node 自带的 brotli。
// 依据 W3C WOFF 2.0 §4–§5：表目录之后是一整段 brotli 流，各表按目录顺序首尾相接、不补齐；
// cmap 在 woff2 里从不做变换，解开后按目录算出偏移就能照 OpenType 原格式读。
import zlib from 'node:zlib';

/** 表目录里 flags 低 6 位的已知表号：10 是 glyf、11 是 loca，63 表示后面跟 4 字节的表名 */
const CMAP = 0;
const GLYF = 10;
const LOCA = 11;
const ARBITRARY_TAG = 63;

function readBase128(buf: Buffer, pos: { at: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[pos.at++];
    if (i === 0 && b === 0x80) throw new Error('woff2：UIntBase128 有前导零');
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) return value;
  }
  throw new Error('woff2：UIntBase128 超过 5 字节');
}

/** cmap 表里 Unicode 子表（平台 0，或平台 3 的编码 1、10）format 4 与 format 12 映射到非零字形的码位 */
function cmapCodepoints(d: Buffer, base: number): Set<number> {
  const out = new Set<number>();
  const n = d.readUInt16BE(base + 2);
  for (let i = 0; i < n; i++) {
    const rec = base + 4 + i * 8;
    const platform = d.readUInt16BE(rec);
    const encoding = d.readUInt16BE(rec + 2);
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const t = base + d.readUInt32BE(rec + 4);
    const format = d.readUInt16BE(t);
    if (format === 4) {
      const segX2 = d.readUInt16BE(t + 6);
      const ends = t + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const offsets = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = d.readUInt16BE(ends + s);
        const start = d.readUInt16BE(starts + s);
        const delta = d.readInt16BE(deltas + s);
        const ro = d.readUInt16BE(offsets + s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            g = d.readUInt16BE(offsets + s + ro + 2 * (c - start));
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = d.readUInt32BE(t + 12);
      for (let k = 0; k < groups; k++) {
        const g = t + 16 + k * 12;
        const first = d.readUInt32BE(g);
        const last = d.readUInt32BE(g + 4);
        const glyph = d.readUInt32BE(g + 8);
        for (let c = first; c <= last; c++) if (glyph + (c - first)) out.add(c);
      }
    }
  }
  return out;
}

export function woff2Codepoints(buf: Buffer): Set<number> {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('不是 woff2 文件');
  if (buf.toString('latin1', 4, 8) === 'ttcf') throw new Error('woff2：不支持字体集合');
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  const pos = { at: 48 };
  let offset = 0;
  let cmap: { offset: number } | undefined;
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos.at++];
    const known = flags & 0x3f;
    if (known === ARBITRARY_TAG) pos.at += 4;
    const version = flags >> 6;
    const origLength = readBase128(buf, pos);
    // glyf、loca 的变换号 0 表示做了变换，其余表是非 0 表示做了变换；做了变换才有 transformLength
    const transformed = known === GLYF || known === LOCA ? version === 0 : version !== 0;
    const length = transformed ? readBase128(buf, pos) : origLength;
    if (known === CMAP) cmap = { offset };
    offset += length;
  }
  if (!cmap) throw new Error('woff2：没有 cmap 表');
  const data = zlib.brotliDecompressSync(buf.subarray(pos.at, pos.at + compressedSize));
  if (data.length !== offset) throw new Error(`woff2：解压后 ${data.length} B，与表目录合计 ${offset} B 不符`);
  return cmapCodepoints(data, cmap.offset);
}
