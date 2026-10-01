// 产品库 CSV 导入的纯逻辑（01 spec「后台 API 与页面 · 产品库」：只建 draft，只收平铺字段，数组用「、」分隔；
// 后台 UX spec「CSV 导入（H 页）」：表头也认字段的中文标签，导入时去掉本系统下载文件时加的防公式前缀）。
// 前后端共用，只依赖 zod 与 src/shared：
// - 服务端的 prepareCatalogCsv 按共用 schema 推出能用的列（schemaCsvShape），整份全部合格才返回待建的 payload；
// - console 的导入弹窗按行业包的字段配置推出同样的列（entityCsvShape），逐行给出合格与否（checkCsvRows），
//   在前端预检、只导入合格的行、下载不合格的行。
// 两边共用解析（parseCatalogCsv）、表头（resolveCsvHeader）、逐格转换（convertCsvRow）与文件内编号重复这几步。
// 中文标签的表由调用方从行业包传入（src/shared 不 import src/packs）
import { z } from 'zod';
import { CATALOG_SCHEMAS, type CatalogKind } from './catalog.js';
import { parseCsv } from './csv.js';
import type { EntityType, FieldDef } from './pack.js';

/** CSV 不合格：按行列出问题；row 是数据行号（表头之后从 1 起），0 表示表头或整份文件 */
export class CatalogCsvError extends Error {
  constructor(readonly rows: { row: number; issues: CsvIssue[] }[]) {
    super(`CSV 有 ${rows.length} 处不合格，一条也没建`);
  }
}

/**
 * 一处问题：path 是 payload 的键（编号是 id），有序子项再接下标；表头的问题写表头原文；空串是整行或整份。
 * label 只有 console 的逐行检查给（上架前检查的中文路径，如「酒店亮点 · 第1条」），服务端的不带
 */
export interface CsvIssue {
  path: string;
  message: string;
  label?: string;
}

// ---------------- 上限（与服务端一致：前端据此预检，超了不发请求；有一行单独也超了时说是哪一行） ----------------

/** 一次最多导入的数据行 */
export const CSV_MAX_ROWS = 200;
/** csv 的字符数上限：src/shared/console-api.ts 的 ImportCsvBody */
export const CSV_MAX_CHARS = 60_000;
/** 请求体的字节数上限：src/server.ts 的 MAX_BODY_BYTES 默认值，按 UTF-8 算 */
export const CSV_MAX_BODY_BYTES = 64 * 1024;

/** 下载的不合格行带着原因写在这一列；再导入时这一列不算字段，整列忽略（字段标签恰好也叫这个时按字段算） */
export const CSV_REASON_HEADER = '不合格原因';

// ---------------- 列 ----------------

type FlatType = 'string' | 'integer' | 'boolean' | 'strings';
/** 中文标签 → payload 的键 */
export type CsvLabels = Readonly<Record<string, string>>;

export interface CsvShape {
  /** payload 的键序：建出来的 payload 按它排键，与 data/ 里的文件一致 */
  order: string[];
  flat: Map<string, FlatType>;
  required: Set<string>;
  /** 必填却不是平铺字段（线路的 itinerary）：有这种字段的 kind 没法用 CSV 建 */
  nestedRequired: string[];
}

const schemaShapes = new Map<CatalogKind, CsvShape>();

/** 服务端的列：由共用 schema 推出来 */
function schemaCsvShape(kind: CatalogKind): CsvShape {
  let shape = schemaShapes.get(kind);
  if (shape) return shape;
  const js = z.toJSONSchema(CATALOG_SCHEMAS[kind], { io: 'input' }) as {
    properties: Record<string, { type?: string; items?: { type?: string } }>;
    required?: string[];
  };
  const flat = new Map<string, FlatType>();
  for (const [k, p] of Object.entries(js.properties)) {
    if (p.type === 'string') flat.set(k, 'string');
    else if (p.type === 'integer' || p.type === 'number') flat.set(k, 'integer');
    else if (p.type === 'boolean') flat.set(k, 'boolean');
    else if (p.type === 'array' && p.items?.type === 'string') flat.set(k, 'strings');
  }
  const required = new Set(js.required ?? []);
  shape = { order: Object.keys(js.properties), flat, required, nestedRequired: [...required].filter((k) => !flat.has(k)) };
  schemaShapes.set(kind, shape);
  return shape;
}

/** 这个 kind 的 CSV 能用哪些列；必填字段里有嵌套结构时 importable 为 false */
export function catalogCsvColumns(kind: CatalogKind): { importable: boolean; columns: string[]; nestedRequired: string[] } {
  const shape = schemaCsvShape(kind);
  return {
    importable: !shape.nestedRequired.length,
    columns: shape.order.filter((k) => shape.flat.has(k)),
    nestedRequired: shape.nestedRequired,
  };
}

/** 字段在 CSV 里怎么写；null 是不能平铺（多个子字段的有序子项、状态） */
function flatTypeOf(f: FieldDef): FlatType | null {
  switch (f.type) {
    case 'text':
    case 'longText':
    case 'monthRange':
      return 'string';
    case 'money':
    case 'intUnit':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'tags':
      return 'strings';
    case 'enum':
      return f.multiple && !f.storeAs ? 'strings' : 'string';
    case 'reference':
      return f.multiple ? 'strings' : 'string';
    case 'subItems': {
      // 只有一个 key 为空的子字段：每项就是一个值（酒店亮点这类 string[]），一格里用「、」分隔
      const only = f.item?.length === 1 && f.item[0]!.key === '' ? f.item[0]! : null;
      return only && flatTypeOf(only) === 'string' ? 'strings' : null;
    }
    case 'status':
      return null;
  }
}

/** 按行业包的一个实体推出的列：每列的键、中文标签和字段配置，按字段的顺序 */
export interface EntityCsvShape extends CsvShape {
  columns: { key: string; label: string; field: FieldDef }[];
  /** 中文标签 → 键：表头的别名，也是服务端要的标签表 */
  labels: CsvLabels;
}

/**
 * 由行业包的字段配置推出 CSV 的列（console 用；与 schema 推出的相同，旅游包的酒店由自测核对）。编号（$code）存在 id；
 * 带点的键（嵌套对象里的字段）和不能平铺的类型不成列。showWhen 管着的字段按选填算（显示出来才必填，交给上架前检查）
 */
export function entityCsvShape(entity: EntityType): EntityCsvShape {
  const order: string[] = [];
  const flat = new Map<string, FlatType>();
  const required = new Set<string>();
  const nested = new Set<string>();
  const columns: EntityCsvShape['columns'] = [];
  const labels: Record<string, string> = {};
  // 编号是条目的 id：字段配置里没写 $code 的实体也有这一列，标签取 codeLabel
  const code: FieldDef = { key: '$code', type: 'text', label: entity.codeLabel, group: '' };
  const fields = entity.fields.some((f) => f.key === '$code') ? entity.fields : [code, ...entity.fields];
  for (const f of fields) {
    if (f.type === 'status') continue;
    const key = f.key === '$code' ? 'id' : f.key;
    const top = key.split('.')[0]!;
    if (!order.includes(top)) order.push(top);
    const must = f.required !== false && !f.showWhen;
    const type = key === top ? flatTypeOf(f) : null;
    if (type === null) {
      if (must) nested.add(top);
      continue;
    }
    flat.set(key, type);
    if (must) required.add(key);
    columns.push({ key, label: f.label, field: f });
    if (!Object.hasOwn(labels, f.label)) labels[f.label] = key;
  }
  return { order, flat, required, nestedRequired: [...nested], columns, labels };
}

/** 服务端要的标签表：这个实体能平铺的字段，中文标签 → 键 */
export const csvLabelsOf = (entity: EntityType): CsvLabels => entityCsvShape(entity).labels;

// ---------------- 防公式注入（OWASP「CSV Injection」） ----------------

/** 开头是这些字符的格子，Excel 会当成公式：= + - @、制表符、回车、换行，以及全角的 ＝ ＋ － ＠ */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;

/** 下载给人改的 CSV：危险字符开头的格子，在引号内的开头加一个制表符 */
export const guardCell = (s: string): string => (FORMULA_START.test(s) ? `\t${s}` : s);

/**
 * 导入时去掉 guardCell 加的那个制表符：只去「制表符 + 危险字符」这一种开头的一个制表符，其余不动。
 * Excel 另存以后这个前缀可能还在，不去掉它就进了数据（OWASP 的提醒）
 */
export const unguardCell = (s: string): string => (s.startsWith('\t') && FORMULA_START.test(s.slice(1)) ? s.slice(1) : s);

// ---------------- 解析、表头、逐格转换 ----------------

const whole = (message: string): CatalogCsvError => new CatalogCsvError([{ row: 0, issues: [{ path: '', message }] }]);

/** 解析整份 CSV：解码失败留下的替换字符、没闭合的引号都是整份不合格（第 0 行） */
export function parseCatalogCsv(csv: string): string[][] {
  // 按 UTF-8 解码失败的字节会变成替换字符 U+FFFD（Excel 默认存的 GBK 就是这样）：照收会建出一批改不掉 code 的乱码草稿
  if (csv.includes(String.fromCharCode(0xfffd)))
    throw whole('文件里有无法识别的字符，多半不是 UTF-8 编码：在 Excel 里另存为「CSV UTF-8」再导入');
  try {
    return parseCsv(csv);
  } catch (e) {
    throw whole(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 表头 → 每一列的 payload 键：字段名照旧可用，也认字段的中文标签；「不合格原因」列是 null（忽略）。
 * 没有的字段、不能平铺的字段、重复的列（字段名和中文标签指向同一个字段也算）、缺编号这一列，都在第 0 行列出
 */
export function resolveCsvHeader(shape: CsvShape, rawHeader: readonly string[], labels: CsvLabels = {}): (string | null)[] {
  const header = rawHeader.map((h) => unguardCell(h).trim());
  const alias = (h: string): string | undefined => (Object.hasOwn(labels, h) ? labels[h] : undefined);
  const keys = header.map((h): string | null | undefined => {
    if (shape.flat.has(h)) return h;
    const k = alias(h);
    if (k !== undefined && shape.flat.has(k)) return k;
    return h === CSV_REASON_HEADER ? null : undefined;
  });
  const issues: CsvIssue[] = [];
  header.forEach((h, i) => {
    const k = keys[i];
    if (k === null) return;
    if (k === undefined) {
      const known = shape.order.includes(h) || shape.order.includes(alias(h) ?? '');
      issues.push({ path: h, message: known ? '不是平铺字段，CSV 里不收' : '没有这个字段' });
    } else if (keys.indexOf(k) !== i) issues.push({ path: h, message: '表头重复' });
  });
  if (!keys.includes('id')) issues.push({ path: 'id', message: '这一列不能少' });
  if (issues.length) throw new CatalogCsvError([{ row: 0, issues }]);
  return keys as (string | null)[];
}

/**
 * 一行 → payload：空格子就是这个键不存在（必填的数组给 []）；格子先去掉防公式前缀、再去首尾空白；
 * 数值只认整数写法；布尔认 是/否、true/false；数组按「、」切。payload 的键按 shape.order 排
 */
export function convertCsvRow(
  shape: CsvShape,
  keys: readonly (string | null)[],
  cells: readonly string[],
): { payload: Record<string, unknown>; issues: CsvIssue[] } {
  const issues: CsvIssue[] = [];
  const values: Record<string, unknown> = {};
  if (cells.length !== keys.length) issues.push({ path: '', message: `有 ${cells.length} 列，表头有 ${keys.length} 列` });
  keys.forEach((h, i) => {
    if (h === null) return;
    const type = shape.flat.get(h)!;
    const cell = unguardCell(cells[i] ?? '').trim();
    if (cell === '') {
      if (type === 'strings' && shape.required.has(h)) values[h] = [];
      return;
    }
    if (type === 'string') values[h] = cell;
    else if (type === 'integer') {
      if (/^-?[0-9]+$/.test(cell)) values[h] = Number(cell);
      else issues.push({ path: h, message: `要写整数，写的是「${cell}」` });
    } else if (type === 'boolean') {
      if (['是', 'true', 'TRUE', '1'].includes(cell)) values[h] = true;
      else if (['否', 'false', 'FALSE', '0'].includes(cell)) values[h] = false;
      else issues.push({ path: h, message: `要写「是」或「否」，写的是「${cell}」` });
    } else {
      values[h] = cell
        .split('、')
        .map((x) => x.trim())
        .filter(Boolean);
    }
  });
  const payload = Object.fromEntries(shape.order.filter((k) => Object.hasOwn(values, k)).map((k) => [k, values[k]]));
  return { payload, issues };
}

export interface CsvRowCheck {
  /** 数据行号，从 1 起 */
  row: number;
  /** 这一行原样的格子 */
  cells: string[];
  payload: Record<string, unknown>;
  /** 空数组就是合格 */
  issues: CsvIssue[];
}

/**
 * 逐行检查：转换出问题的行不再校验（缺了那一格，校验只会多报一句「没填」）；转换没问题的交给 validate
 * （服务端过 schema，console 过上架前检查）。文件内编号重复的，后出现的那一行点名前一行
 */
export function checkCsvRows(
  shape: CsvShape,
  keys: readonly (string | null)[],
  body: readonly string[][],
  validate: (payload: Record<string, unknown>) => CsvIssue[],
): CsvRowCheck[] {
  const seen = new Map<string, number>();
  return body.map((cells, i) => {
    const row = i + 1;
    const { payload, issues } = convertCsvRow(shape, keys, cells);
    if (!issues.length) issues.push(...validate(payload));
    const code = String(payload.id ?? '');
    if (code && seen.has(code)) issues.push({ path: 'id', message: `和第${seen.get(code)}行重复` });
    else if (code) seen.set(code, row);
    return { row, cells, payload, issues };
  });
}

/**
 * 整份 CSV → 待建的 payload（服务端）：先解析，再逐行转换、过 schema、查文件内重复的 id。任何一处不合格就抛 CatalogCsvError，
 * 列出全部问题。表头是字段名或 labels 里的中文标签；payload 的键序按 schema 的字段顺序。库里是否已有同一个 code 由调用方在事务里查
 */
export function prepareCatalogCsv(kind: CatalogKind, csv: string, labels: CsvLabels = {}): Record<string, unknown>[] {
  const shape = schemaCsvShape(kind);
  if (shape.nestedRequired.length) {
    throw whole(`必填字段 ${shape.nestedRequired.join('、')} 不是平铺字段，CSV 只收平铺字段，这一类请在表单里新建`);
  }
  const [rawHeader, ...body] = parseCatalogCsv(csv);
  if (!rawHeader || !body.length) throw whole('至少要有表头和一行数据');
  if (body.length > CSV_MAX_ROWS) throw whole(`一次最多导入 ${CSV_MAX_ROWS} 行，这份有 ${body.length} 行`);
  const keys = resolveCsvHeader(shape, rawHeader, labels);
  const schema = CATALOG_SCHEMAS[kind];
  const rows = checkCsvRows(shape, keys, body, (payload) => {
    const r = schema.safeParse(payload);
    return r.success ? [] : r.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message }));
  });
  const bad = rows.filter((r) => r.issues.length).map(({ row, issues }) => ({ row, issues }));
  if (bad.length) throw new CatalogCsvError(bad);
  return rows.map((r) => r.payload);
}

// ---------------- 写 CSV 与上限 ----------------

/** 写成 CSV（RFC 4180）：含逗号、双引号或换行的格子加双引号、引号写两遍；quoteAll 时每格都加。每行以 eol 结尾 */
export function toCsv(rows: readonly (readonly string[])[], opts: { quoteAll?: boolean; eol?: string } = {}): string {
  const eol = opts.eol ?? '\r\n';
  const cell = (s: string): string => (opts.quoteAll || /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  return rows.map((r) => `${r.map(cell).join(',')}${eol}`).join('');
}

const utf8 = new TextEncoder();
/** 一段字放进 JSON 字符串里（转义以后）按 UTF-8 的字节数，不含两头的引号 */
const escapedBytes = (s: string): number => utf8.encode(JSON.stringify(s)).length - 2;
/** 请求体 {"csv":""} 本身的字节数 */
const BODY_FRAME = utf8.encode(JSON.stringify({ csv: '' })).length;

/** 提交给服务端的请求体（{ csv }）按 UTF-8 的字节数 */
export const csvBodyBytes = (csv: string): number => BODY_FRAME + escapedBytes(csv);

/** 一行（表头或数据行，\n 结尾，与提交时的写法一样）占多少字符、多少字节；表头另算上请求体 {"csv":""} 本身 */
function lineCost(cells: readonly string[], frame = 0): { chars: number; bytes: number } {
  const line = toCsv([cells], { eol: '\n' });
  return { chars: line.length, bytes: frame + escapedBytes(line) };
}
const tooBig = (chars: number, bytes: number): boolean => chars > CSV_MAX_CHARS || bytes > CSV_MAX_BODY_BYTES;

/** 连同表头单独一份也超上限的行（数据行号，从 1 起）：分成几份也导入不了 */
export function csvLongRows(header: readonly string[], rows: readonly (readonly string[])[]): number[] {
  const base = lineCost(header, BODY_FRAME);
  return rows.flatMap((r, i) => {
    const c = lineCost(r);
    return tooBig(base.chars + c.chars, base.bytes + c.bytes) ? [i + 1] : [];
  });
}

/**
 * 按三条上限（行数、csv 字符数、请求体字节数）要分成几份：每份都带表头，按行的顺序能放就放（行用 \n 结尾，与提交时的写法一样）。
 * 1 就是一份放得下；有一行连同表头单独一份也放不下时是 Infinity（分成几份也不行，见 csvLongRows）
 */
export function csvParts(header: readonly string[], rows: readonly (readonly string[])[]): number {
  const base = lineCost(header, BODY_FRAME);
  let parts = 1;
  let n = 0;
  let chars = base.chars;
  let bytes = base.bytes;
  for (const r of rows) {
    const c = lineCost(r);
    if (tooBig(base.chars + c.chars, base.bytes + c.bytes)) return Infinity;
    if (n > 0 && (n + 1 > CSV_MAX_ROWS || tooBig(chars + c.chars, bytes + c.bytes))) {
      parts += 1;
      n = 0;
      chars = base.chars;
      bytes = base.bytes;
    }
    n += 1;
    chars += c.chars;
    bytes += c.bytes;
  }
  return parts;
}
