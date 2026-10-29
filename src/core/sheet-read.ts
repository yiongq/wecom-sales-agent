// 12 R6：有界的 CSV / XLSX 读取器。不执行公式，不转换数字与日期序列号。
import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { parseCsv } from '../shared/csv.js';
import {
  AttachmentFormatError,
  SHEET_MAX_BYTES,
  attachmentCrc32,
  classifyAttachment,
  decodeAttachmentText,
  readZipDirectory,
} from './attachments.js';

export type SheetRead =
  | { ok: true; sheets: { name: string; rows: string[][] }[] }
  | { ok: false; reason: 'encoding' | 'corrupt' | 'too_large' };

function check(ok: boolean): asserts ok {
  if (!ok) throw new AttachmentFormatError();
}
function limit(ok: boolean): asserts ok {
  if (!ok) throw new AttachmentFormatError('too_large');
}
function truncate(value: string): string {
  // 按 Unicode 码点截断，不能留下半个代理对；只遍历需要的前缀。
  let out = '';
  let count = 0;
  for (const ch of value) {
    if (count++ === 200) break;
    out += ch;
  }
  return out;
}

interface XmlNode {
  tag: string;
  attrs: Map<string, string>;
  children: XmlNode[];
  text: string;
}
function xmlChar(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 13 ||
    (code >= 32 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}
function entities(text: string): string {
  return text.replace(/&([^;]*);|&/g, (match, name: string | undefined) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    check(!!name && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name));
    const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    check(xmlChar(code));
    return String.fromCodePoint(code);
  });
}
function local(tag: string): string {
  return tag.slice(tag.lastIndexOf(':') + 1);
}

/** 最小 XML 词法 / 栈解析，拒绝 DTD、实体声明、坏嵌套、未知实体；不解析外部资源。 */
function xml(bytes: Uint8Array): XmlNode {
  const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  check(!/<!DOCTYPE|<!ENTITY/i.test(s));
  for (const ch of s) check(xmlChar(ch.codePointAt(0)!));
  const document: XmlNode = { tag: '', attrs: new Map(), children: [], text: '' };
  const stack = [document];
  let at = 0;
  while (at < s.length) {
    const parent = stack[stack.length - 1]!;
    if (s[at] !== '<') {
      const next = s.indexOf('<', at);
      const end = next < 0 ? s.length : next;
      const raw = s.slice(at, end);
      check(!raw.includes(']]>'));
      parent.text += entities(raw);
      at = end;
      continue;
    }
    if (s.startsWith('<!--', at)) {
      const end = s.indexOf('-->', at + 4);
      check(end >= 0 && !s.slice(at + 4, end).includes('--'));
      at = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', at)) {
      const end = s.indexOf(']]>', at + 9);
      check(end >= 0 && stack.length > 1);
      parent.text += s.slice(at + 9, end);
      at = end + 3;
      continue;
    }
    if (s.startsWith('<?', at)) {
      const end = s.indexOf('?>', at + 2);
      check(end >= 0);
      at = end + 2;
      continue;
    }
    if (s.startsWith('</', at)) {
      const close = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(s.slice(at));
      check(!!close && stack.length > 1 && close[1] === parent.tag);
      stack.pop();
      at += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z_][\w.:-]*)/.exec(s.slice(at));
    check(!!open);
    const node: XmlNode = { tag: open[1]!, attrs: new Map(), children: [], text: '' };
    at += open[0].length;
    while (true) {
      const space = /^\s*/.exec(s.slice(at))![0];
      at += space.length;
      if (s.startsWith('/>', at) || s[at] === '>') break;
      check(space.length > 0);
      const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(s.slice(at));
      check(!!attr && !node.attrs.has(attr[1]!));
      node.attrs.set(attr[1]!, entities(attr[2] ?? attr[3]!));
      at += attr[0].length;
    }
    parent.children.push(node);
    if (s.startsWith('/>', at)) at += 2;
    else {
      at++;
      stack.push(node);
    }
  }
  check(stack.length === 1 && document.children.length === 1 && document.text.trim() === '');
  return document.children[0]!;
}
function children(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((n) => local(n.tag) === tag);
}
function one(node: XmlNode, tag: string): XmlNode | undefined {
  const matches = children(node, tag);
  check(matches.length <= 1);
  return matches[0];
}
function richText(node: XmlNode): string {
  // 只取 t / r/t，排除 rPh（拼音标注），保持 XML 中的富文本运行顺序。
  let value = '';
  for (const child of node.children) {
    if (local(child.tag) === 't') value += child.text;
    if (local(child.tag) === 'r') value += one(child, 't')?.text ?? '';
  }
  return truncate(value);
}
function coordinate(ref: string): [number, number] {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  check(!!match);
  let column = 0;
  for (const ch of match[1]!) column = column * 26 + ch.charCodeAt(0) - 64;
  const row = Number(match[2]);
  check(column <= 16384 && row <= 1048576);
  return [row, column];
}
function cellValue(cell: XmlNode, shared: string[]): string {
  const type = cell.attrs.get('t');
  const value = one(cell, 'v');
  if (one(cell, 'f') && !value) return '';
  if (type === 'inlineStr') {
    const inline = one(cell, 'is');
    return inline ? richText(inline) : '';
  }
  if (!value || value.text === '') return '';
  if (type === 's') {
    check(/^\d+$/.test(value.text));
    const index = Number(value.text);
    check(index < shared.length);
    return shared[index]!;
  }
  if (type === 'b') {
    check(value.text === '0' || value.text === '1');
    return value.text === '1' ? 'TRUE' : 'FALSE';
  }
  check(type === undefined || ['n', 'str', 'e', 'd'].includes(type));
  return truncate(value.text);
}
function worksheet(root: XmlNode, shared: string[]): string[][] {
  check(local(root.tag) === 'worksheet');
  const rows: string[][] = [];
  let lastRow = 0;
  let lastColumn = 0;
  const put = (row: number, column: number, value: string): void => {
    if (value === '') return;
    limit(row <= 200 && column <= 50);
    const target = rows[row - 1] ?? (rows[row - 1] = []);
    target[column - 1] = value;
    lastRow = Math.max(lastRow, row);
    lastColumn = Math.max(lastColumn, column);
  };
  const data = one(root, 'sheetData');
  check(!!data);
  let previousRow = 0;
  for (const row of children(data, 'row')) {
    const rowText = row.attrs.get('r');
    check(rowText === undefined || /^[1-9][0-9]*$/.test(rowText));
    const rowIndex = rowText === undefined ? previousRow + 1 : Number(rowText);
    check(rowIndex > previousRow && rowIndex <= 1048576);
    previousRow = rowIndex;
    let previousColumn = 0;
    for (const cell of children(row, 'c')) {
      const ref = cell.attrs.get('r');
      const [r, c] = ref ? coordinate(ref) : [rowIndex, previousColumn + 1];
      check(r === rowIndex && c > previousColumn && c <= 16384);
      previousColumn = c;
      put(r, c, cellValue(cell, shared));
    }
  }
  const merges = one(root, 'mergeCells');
  if (merges) {
    const ranges: [number, number, number, number][] = [];
    for (const merge of children(merges, 'mergeCell')) {
      const refs = (merge.attrs.get('ref') ?? '').split(':');
      check(refs.length === 2);
      const [r1, c1] = coordinate(refs[0]!);
      const [r2, c2] = coordinate(refs[1]!);
      check(r2 >= r1 && c2 >= c1);
      const value = rows[r1 - 1]?.[c1 - 1] ?? '';
      if (!value) continue; // 空的格式 / 合并区域不计入最后一个非空行列
      limit(r2 <= 200 && c2 <= 50);
      check(!ranges.some(([a, b, c, d]) => r1 <= c && r2 >= a && c1 <= d && c2 >= b));
      ranges.push([r1, c1, r2, c2]);
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) put(r, c, value);
    }
  }
  return Array.from({ length: lastRow }, (_, r) => Array.from({ length: lastColumn }, (_, c) => rows[r]?.[c] ?? ''));
}

function xlsx(bytes: Uint8Array): SheetRead {
  const entries = readZipDirectory(bytes, 200);
  for (const entry of entries) check((entry.flags & (1 | 64 | 8192)) === 0 && (entry.method === 0 || entry.method === 8));
  check(!entries.some((e) => e.name === 'xl/vbaProject.bin'));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const cache = new Map<string, XmlNode>();
  let total = 0;
  const read = (name: string): XmlNode => {
    const cached = cache.get(name);
    if (cached) return cached;
    const entry = byName.get(name);
    check(!!entry);
    const compressed = bytes.subarray(entry.offset, entry.offset + entry.compressedSize);
    const remaining = Math.min(5 * 1024 * 1024, 10 * 1024 * 1024 - total);
    limit(remaining > 0);
    let unpacked: Uint8Array;
    if (entry.method === 0) {
      limit(compressed.length <= remaining);
      unpacked = compressed;
    } else {
      try {
        unpacked = inflateRawSync(compressed, { maxOutputLength: remaining });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new AttachmentFormatError('too_large');
        throw error;
      }
    }
    total += unpacked.length;
    check(unpacked.length === entry.size && attachmentCrc32(unpacked) === entry.crc);
    const root = xml(unpacked);
    cache.set(name, root);
    return root;
  };
  const workbook = read('xl/workbook.xml');
  check(local(workbook.tag) === 'workbook');
  const rels = read('xl/_rels/workbook.xml.rels');
  check(local(rels.tag) === 'Relationships');
  const links = new Map<string, string>();
  for (const rel of children(rels, 'Relationship')) {
    const id = rel.attrs.get('Id');
    const target = rel.attrs.get('Target');
    check(!!id && !!target && !links.has(id));
    if (!rel.attrs.get('Type')?.endsWith('/worksheet')) continue;
    check(!rel.attrs.has('TargetMode') || rel.attrs.get('TargetMode') === 'Internal');
    // oxlint-disable-next-line no-control-regex -- ZIP 内部关系不能含控制字符或外部地址
    check(!/[\\?#\u0000-\u001F]/.test(target) && !/^[a-z][a-z0-9+.-]*:/i.test(target));
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    check(path.startsWith('xl/') && path.endsWith('.xml'));
    links.set(id, path);
  }
  const sharedRoot = byName.has('xl/sharedStrings.xml') ? read('xl/sharedStrings.xml') : undefined;
  if (sharedRoot) check(local(sharedRoot.tag) === 'sst');
  const shared = sharedRoot ? children(sharedRoot, 'si').map(richText) : [];
  const sheetsNode = one(workbook, 'sheets');
  check(!!sheetsNode);
  const sheets: { name: string; rows: string[][] }[] = [];
  const names = new Set<string>();
  for (const sheet of children(sheetsNode, 'sheet')) {
    const state = sheet.attrs.get('state');
    if (state === 'hidden' || state === 'veryHidden') continue;
    check(state === undefined || state === 'visible');
    const name = sheet.attrs.get('name');
    const relationId = [...sheet.attrs].find(([key]) => local(key) === 'id')?.[1];
    const target = relationId ? links.get(relationId) : undefined;
    check(!!name && !!target && !names.has(name));
    names.add(name);
    sheets.push({ name, rows: worksheet(read(target), shared) });
  }
  return { ok: true, sheets };
}

/** 按字节辨别 XLSX / CSV；文件名只用于 CSV 后缀，不作为返回表名。 */
export function readSheet(bytes: Uint8Array, filename: string | null = null): SheetRead {
  if (bytes.length > SHEET_MAX_BYTES) return { ok: false, reason: 'too_large' };
  try {
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
    if (zip) return xlsx(bytes);
    if (!filename || !/\.csv$/i.test(filename)) return { ok: false, reason: 'corrupt' };
    const text = decodeAttachmentText(bytes);
    if (text === null) return { ok: false, reason: 'encoding' };
    check(classifyAttachment(bytes, filename).mime === 'text/csv');
    const rows = parseCsv(text);
    let width = 0;
    for (const row of rows) {
      let last = row.length;
      while (last && row[last - 1] === '') last--;
      width = Math.max(width, last);
    }
    limit(rows.length <= 200 && width <= 50);
    return {
      ok: true,
      sheets: [{ name: 'CSV', rows: rows.map((row) => Array.from({ length: width }, (_, c) => truncate(row[c] ?? ''))) }],
    };
  } catch (error) {
    return { ok: false, reason: error instanceof AttachmentFormatError ? error.reason : 'corrupt' };
  }
}
