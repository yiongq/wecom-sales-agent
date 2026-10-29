// 12 R1 / R4：只读字节；不信任声明 MIME，不访问网络或存储。
import { crc32 } from 'node:zlib';
import type { AttachmentClass } from '../shared/channel-types.js';
export type { AttachmentClass } from '../shared/channel-types.js';

export const ATTACHMENT_CLASSES = Object.freeze(['image', 'sheet', 'legacy_sheet', 'locked_sheet', 'drawing', 'video', 'other'] as const);

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const SHEET_MAX_BYTES = 2 * 1024 * 1024;
/** 企微单个文件的上限：第 0 步实测，更大的文件不以文件消息到达 */
export const ATTACHMENT_HARD_MAX_BYTES = 20 * 1024 * 1024;

export interface AttachmentClassification {
  cls: AttachmentClass;
  mime: string;
}
export interface AttachmentSniff {
  kind: 'image' | 'zip' | 'cfb' | 'drawing' | 'text' | 'unknown';
  maxBytes: number;
  tooLarge: boolean;
}

function buffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function starts(bytes: Buffer, hex: string): boolean {
  const signature = Buffer.from(hex, 'hex');
  return bytes.subarray(0, signature.length).equals(signature);
}
function imageMime(bytes: Buffer): string | null {
  if (starts(bytes, 'ffd8ff')) return 'image/jpeg';
  if (starts(bytes, '89504e470d0a1a0a')) return 'image/png';
  return null;
}
function drawingMime(bytes: Buffer): string | null {
  const text = bytes.subarray(0, 65536).toString('latin1');
  if (text.startsWith('%PDF')) return 'application/pdf';
  if (text.startsWith('AC10')) return 'image/vnd.dwg';
  if (text.startsWith('ISO-10303-21')) return 'model/step';
  if (/^\s*0\r?\n[ \t]*SECTION(?:\r?\n|$)/.test(text)) return 'image/vnd.dxf';
  if (text.split(/\r?\n/, 1)[0]?.[72] === 'S') return 'model/iges';
  return null;
}

/** 严格解码；U+FFFD 不得通过切换编码被掩盖。供 CSV 判类与读取共用。 */
export function decodeAttachmentText(bytes: Uint8Array, partial = false): string | null {
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      const value = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: partial });
      return value.includes('\uFFFD') ? null : value;
    } catch {
      /* 尝试下一种允许的编码 */
    }
  }
  return null;
}

/**
 * 前缀最多看 64 KiB。图纸与 CFB 不论大小都要读完判类（图纸转顾问、加密文件判 locked_sheet），
 * 上限取企微单文件上限；ZIP、文本与未知超过表格限额时，类别只能是 other，不必读完。
 */
export function sniffAttachment(prefix: Uint8Array, totalSize: number | null): AttachmentSniff {
  const b = buffer(prefix).subarray(0, 65536);
  let kind: AttachmentSniff['kind'] = 'unknown';
  if (imageMime(b)) kind = 'image';
  else if (starts(b, '504b0304') || starts(b, '504b0506')) kind = 'zip';
  else if (starts(b, 'd0cf11e0a1b11ae1')) kind = 'cfb';
  else if (drawingMime(b)) kind = 'drawing';
  else {
    const text = decodeAttachmentText(b, totalSize === null || totalSize > b.length);
    // oxlint-disable-next-line no-control-regex -- 二进制控制字节不是文本前缀
    if (text !== null && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) kind = 'text';
  }
  const maxBytes = kind === 'image' ? IMAGE_MAX_BYTES : kind === 'drawing' || kind === 'cfb' ? ATTACHMENT_HARD_MAX_BYTES : SHEET_MAX_BYTES;
  return { kind, maxBytes, tooLarge: prefix.length > maxBytes || (totalSize !== null && totalSize > maxBytes) };
}

/** 内部结构读取器的错误只在模块间传递；对外入口都转换成结果。 */
export class AttachmentFormatError extends Error {
  constructor(readonly reason: 'corrupt' | 'too_large' = 'corrupt') {
    super(reason);
  }
}
export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}
function requireFormat(ok: boolean): asserts ok {
  if (!ok) throw new AttachmentFormatError();
}
function checkExtra(extra: Buffer): void {
  let at = 0;
  while (at < extra.length) {
    requireFormat(at + 4 <= extra.length);
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    requireFormat(id !== 1 && at + 4 + size <= extra.length); // ZIP64 不支持
    at += 4 + size;
  }
}

/** 中央目录，不解压。校验本地头、范围、重复条目与 ZIP64；不落盘。 */
export function readZipDirectory(bytes: Uint8Array, maxEntries = 65534): ZipEntry[] {
  const b = buffer(bytes);
  let end = b.length - 22;
  for (; end >= Math.max(0, b.length - 65557); end--) {
    if (b.readUInt32LE(end) === 0x06054b50 && end + 22 + b.readUInt16LE(end + 20) === b.length) break;
  }
  requireFormat(end >= Math.max(0, b.length - 65557) && b.readUInt32LE(end) === 0x06054b50);
  requireFormat(b.readUInt16LE(end + 4) === 0 && b.readUInt16LE(end + 6) === 0);
  const count = b.readUInt16LE(end + 10);
  const length = b.readUInt32LE(end + 12);
  const start = b.readUInt32LE(end + 16);
  requireFormat(count !== 0xffff && length !== 0xffffffff && start !== 0xffffffff);
  requireFormat(b.readUInt16LE(end + 8) === count && start + length === end);
  if (count > maxEntries) throw new AttachmentFormatError('too_large');
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: [number, number][] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    requireFormat(at + 46 <= end && b.readUInt32LE(at) === 0x02014b50);
    const nameLength = b.readUInt16LE(at + 28);
    const extraLength = b.readUInt16LE(at + 30);
    const next = at + 46 + nameLength + extraLength + b.readUInt16LE(at + 32);
    requireFormat(next <= end && b.readUInt16LE(at + 34) === 0);
    const nameBytes = b.subarray(at + 46, at + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    requireFormat(name.length > 0 && !name.includes('\0') && !names.has(name));
    names.add(name);
    checkExtra(b.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    const entry: ZipEntry = {
      name,
      flags: b.readUInt16LE(at + 8),
      method: b.readUInt16LE(at + 10),
      crc: b.readUInt32LE(at + 16),
      compressedSize: b.readUInt32LE(at + 20),
      size: b.readUInt32LE(at + 24),
      offset: b.readUInt32LE(at + 42),
    };
    requireFormat(entry.compressedSize !== 0xffffffff && entry.size !== 0xffffffff && entry.offset !== 0xffffffff);
    const local = entry.offset;
    requireFormat(local + 30 <= start && b.readUInt32LE(local) === 0x04034b50);
    const localNameLength = b.readUInt16LE(local + 26);
    const localExtraLength = b.readUInt16LE(local + 28);
    const data = local + 30 + localNameLength + localExtraLength;
    requireFormat(data + entry.compressedSize <= start);
    requireFormat(b.readUInt32LE(local + 18) !== 0xffffffff && b.readUInt32LE(local + 22) !== 0xffffffff);
    requireFormat(b.readUInt16LE(local + 6) === entry.flags && b.readUInt16LE(local + 8) === entry.method);
    requireFormat(b.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes));
    checkExtra(b.subarray(local + 30 + localNameLength, data));
    let recordEnd = data + entry.compressedSize;
    if (entry.flags & 8) {
      requireFormat(recordEnd + 12 <= start);
      const descriptor = recordEnd + (b.readUInt32LE(recordEnd) === 0x08074b50 ? 4 : 0);
      requireFormat(descriptor + 12 <= start);
      requireFormat(
        b.readUInt32LE(descriptor) === entry.crc &&
          b.readUInt32LE(descriptor + 4) === entry.compressedSize &&
          b.readUInt32LE(descriptor + 8) === entry.size,
      );
      recordEnd = descriptor + 12;
    } else {
      requireFormat(
        b.readUInt32LE(local + 14) === entry.crc &&
          b.readUInt32LE(local + 18) === entry.compressedSize &&
          b.readUInt32LE(local + 22) === entry.size,
      );
    }
    ranges.push([local, recordEnd]);
    entries.push({ ...entry, offset: data });
    at = next;
  }
  requireFormat(at === end);
  ranges.sort((a, c) => a[0] - c[0]);
  for (let i = 1; i < ranges.length; i++) requireFormat(ranges[i]![0] >= ranges[i - 1]![1]);
  return entries;
}

/** CFB FAT / DIFAT 遍历受文件实际扇区数约束；只看目录里的 stream 名称。 */
function cfbStreams(b: Buffer): Set<string> {
  requireFormat(b.length >= 512 && b.readUInt16LE(28) === 0xfffe);
  const version = b.readUInt16LE(26);
  const shift = b.readUInt16LE(30);
  requireFormat((version === 3 && shift === 9) || (version === 4 && shift === 12));
  const size = 2 ** shift;
  requireFormat(b.length % size === 0);
  const sectors = b.length / size - 1;
  const sector = (id: number): Buffer => {
    requireFormat(id < sectors);
    return b.subarray((id + 1) * size, (id + 2) * size);
  };
  const fats: number[] = [];
  for (let at = 76; at < 512; at += 4) {
    const id = b.readUInt32LE(at);
    if (id !== 0xffffffff) fats.push(id);
  }
  let dif = b.readUInt32LE(68);
  const difCount = b.readUInt32LE(72);
  requireFormat(difCount <= sectors);
  const seen = new Set<number>();
  for (let i = 0; i < difCount; i++) {
    requireFormat(!seen.has(dif));
    seen.add(dif);
    const data = sector(dif);
    for (let at = 0; at < size - 4; at += 4) {
      const id = data.readUInt32LE(at);
      if (id !== 0xffffffff) fats.push(id);
    }
    dif = data.readUInt32LE(size - 4);
  }
  requireFormat(difCount === 0 || dif === 0xfffffffe);
  requireFormat(fats.length === b.readUInt32LE(44) && fats.length <= sectors && new Set(fats).size === fats.length);
  const fat = fats.map(sector);
  const next = (id: number): number => {
    const page = fat[Math.floor(id / (size / 4))];
    requireFormat(!!page);
    return page.readUInt32LE((id % (size / 4)) * 4);
  };
  const streams = new Set<string>();
  let dir = b.readUInt32LE(48);
  const dirs = new Set<number>();
  while (dir !== 0xfffffffe) {
    requireFormat(!dirs.has(dir) && !seen.has(dir) && !fats.includes(dir));
    dirs.add(dir);
    const data = sector(dir);
    for (let at = 0; at < size; at += 128) {
      const type = data[at + 66];
      if (!type) continue;
      const length = data.readUInt16LE(at + 64);
      requireFormat(length >= 2 && length <= 64 && length % 2 === 0 && data.readUInt16LE(at + length - 2) === 0);
      if (type === 2) streams.add(data.subarray(at, at + length - 2).toString('utf16le'));
    }
    dir = next(dir);
  }
  return streams;
}

export function classifyAttachment(bytes: Uint8Array, filename: string | null = null, msgtype?: string): AttachmentClassification {
  const other: AttachmentClassification = { cls: 'other', mime: 'application/octet-stream' };
  if (msgtype === 'video') return { cls: 'video', mime: 'application/octet-stream' };
  const b = buffer(bytes);
  const mime = imageMime(b);
  if (mime) return b.length <= IMAGE_MAX_BYTES ? { cls: 'image', mime } : other;
  try {
    if (starts(b, '504b0304') || starts(b, '504b0506')) {
      // 与 sniffAttachment 一致：超过表格限额的 ZIP 下载时已中断，一律 other
      if (b.length > SHEET_MAX_BYTES) return other;
      const entries = readZipDirectory(b);
      if (entries.some((e) => e.name === 'xl/vbaProject.bin')) return { cls: 'locked_sheet', mime: 'application/octet-stream' };
      if (entries.some((e) => e.name === 'xl/workbook.xml'))
        return { cls: 'sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      return other;
    }
    if (starts(b, 'd0cf11e0a1b11ae1')) {
      const streams = cfbStreams(b);
      if (streams.has('EncryptedPackage')) return { cls: 'locked_sheet', mime: 'application/octet-stream' };
      if (streams.has('Workbook') || streams.has('Book')) return { cls: 'legacy_sheet', mime: 'application/vnd.ms-excel' };
      return other;
    }
  } catch {
    return other;
  }
  const drawing = drawingMime(b);
  if (drawing) return { cls: 'drawing', mime: drawing };
  if (filename && /\.csv$/i.test(filename) && b.length <= SHEET_MAX_BYTES && decodeAttachmentText(b) !== null)
    return { cls: 'sheet', mime: 'text/csv' };
  return other;
}

/** PNG 与 ZIP 的 IEEE CRC-32 */
export function attachmentCrc32(bytes: Uint8Array): number {
  return crc32(bytes);
}

export type StrippedImage = { ok: true; bytes: Uint8Array } | { ok: false };
export function stripImageMetadata(bytes: Uint8Array): StrippedImage {
  const b = buffer(bytes);
  try {
    const parts: Buffer[] = [];
    if (imageMime(b) === 'image/png') {
      parts.push(b.subarray(0, 8));
      let at = 8;
      let dataSeen = false;
      while (at < b.length) {
        requireFormat(at + 12 <= b.length);
        const length = b.readUInt32BE(at);
        const end = at + 12 + length;
        requireFormat(end <= b.length);
        const type = b.toString('latin1', at + 4, at + 8);
        requireFormat(/^[A-Za-z]{4}$/.test(type));
        requireFormat(attachmentCrc32(b.subarray(at + 4, end - 4)) === b.readUInt32BE(end - 4));
        if (at === 8) requireFormat(type === 'IHDR' && length === 13 && b.readUInt32BE(at + 8) > 0 && b.readUInt32BE(at + 12) > 0);
        else requireFormat(type !== 'IHDR');
        if (type === 'IDAT') dataSeen = true;
        if (!['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(type)) parts.push(b.subarray(at, end));
        if (type === 'IEND') {
          requireFormat(length === 0 && end === b.length && dataSeen);
          return { ok: true, bytes: Buffer.concat(parts) };
        }
        at = end;
      }
      return { ok: false };
    }
    requireFormat(imageMime(b) === 'image/jpeg');
    parts.push(b.subarray(0, 2));
    let at = 2;
    let scanSeen = false;
    while (at < b.length) {
      const start = at;
      requireFormat(b[at++] === 0xff);
      while (b[at] === 0xff) at++;
      const marker = b[at++];
      requireFormat(marker !== undefined && marker !== 0 && marker !== 0xd8);
      if (marker === 0xd9) {
        requireFormat(scanSeen && at === b.length);
        parts.push(b.subarray(start, at));
        return { ok: true, bytes: Buffer.concat(parts) };
      }
      requireFormat(marker < 0xd0 || marker > 0xd7);
      if (marker === 1) {
        parts.push(b.subarray(start, at));
        continue;
      }
      requireFormat(at + 2 <= b.length);
      const length = b.readUInt16BE(at);
      requireFormat(length >= 2 && at + length <= b.length);
      at += length;
      if (marker !== 0xe1) parts.push(b.subarray(start, at));
      if (marker === 0xda) {
        scanSeen = true;
        const scan = at;
        while (at < b.length) {
          if (b[at] !== 0xff) {
            at++;
            continue;
          }
          let after = at + 1;
          while (b[after] === 0xff) after++;
          const code = b[after];
          if (code === 0 || (code !== undefined && code >= 0xd0 && code <= 0xd7)) {
            at = after + 1;
            continue;
          }
          break;
        }
        parts.push(b.subarray(scan, at));
      }
    }
  } catch {
    /* 结构不可信，不让原图绕过去元数据 */
  }
  return { ok: false };
}
