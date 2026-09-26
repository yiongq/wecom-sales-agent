// 产品库 CSV 导入的纯逻辑（01 spec「后台 API 与页面 · 产品库」：只建 draft，只收平铺字段，数组用「、」分隔）。
// 前后端共用：服务端据此把 CSV 转成待建的 payload，console 据此决定给不给导入入口、给出模板表头。只依赖 zod 与 src/shared
import { z } from 'zod';
import { CATALOG_SCHEMAS, type CatalogKind } from './catalog.js';
import { parseCsv } from './csv.js';

/** CSV 不合格：按行列出问题；row 是数据行号（表头之后从 1 起），0 表示表头或整份文件 */
export class CatalogCsvError extends Error {
  constructor(readonly rows: { row: number; issues: { path: string; message: string }[] }[]) {
    super(`CSV 有 ${rows.length} 处不合格，一条也没建`);
  }
}

type FlatType = 'string' | 'integer' | 'boolean' | 'strings';
interface CsvShape {
  /** schema 的字段顺序：建出来的 payload 按它排键，与 data/ 里的文件一致 */
  order: string[];
  flat: Map<string, FlatType>;
  required: Set<string>;
  /** 必填却不是平铺字段（线路的 itinerary）：有这种字段的 kind 没法用 CSV 建 */
  nestedRequired: string[];
}
const MAX_CSV_ROWS = 200;
const csvShapes = new Map<CatalogKind, CsvShape>();

function csvShape(kind: CatalogKind): CsvShape {
  let shape = csvShapes.get(kind);
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
  csvShapes.set(kind, shape);
  return shape;
}

/** 这个 kind 的 CSV 能用哪些列；必填字段里有嵌套结构时 importable 为 false（界面据此不给导入入口） */
export function catalogCsvColumns(kind: CatalogKind): { importable: boolean; columns: string[]; nestedRequired: string[] } {
  const shape = csvShape(kind);
  return {
    importable: !shape.nestedRequired.length,
    columns: shape.order.filter((k) => shape.flat.has(k)),
    nestedRequired: shape.nestedRequired,
  };
}

/** 一行 → payload：空格子就是这个键不存在（必填的数组给 []）；数值只认整数写法；布尔认 是/否、true/false；数组按「、」切 */
function rowToPayload(
  shape: CsvShape,
  header: string[],
  cells: string[],
): { payload: Record<string, unknown>; issues: { path: string; message: string }[] } {
  const issues: { path: string; message: string }[] = [];
  const values: Record<string, unknown> = {};
  if (cells.length !== header.length) issues.push({ path: '', message: `有 ${cells.length} 列，表头有 ${header.length} 列` });
  header.forEach((h, i) => {
    const type = shape.flat.get(h)!;
    const cell = (cells[i] ?? '').trim();
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

/**
 * 整份 CSV → 待建的 payload：先解析，再逐行转换、过 schema、查文件内重复的 id。任何一处不合格就抛 CatalogCsvError，
 * 列出全部问题。表头是字段名；payload 的键序按 schema 的字段顺序。库里是否已有同一个 code 由调用方在事务里查
 */
export function prepareCatalogCsv(kind: CatalogKind, csv: string): Record<string, unknown>[] {
  const shape = csvShape(kind);
  const whole = (message: string): CatalogCsvError => new CatalogCsvError([{ row: 0, issues: [{ path: '', message }] }]);
  if (shape.nestedRequired.length) {
    throw whole(`必填字段 ${shape.nestedRequired.join('、')} 不是平铺字段，CSV 只收平铺字段，这一类请在表单里新建`);
  }
  // 按 UTF-8 解码失败的字节会变成替换字符 U+FFFD（Excel 默认存的 GBK 就是这样）：照收会建出一批改不掉 code 的乱码草稿
  if (csv.includes(String.fromCharCode(0xfffd)))
    throw whole('文件里有无法识别的字符，多半不是 UTF-8 编码：在 Excel 里另存为「CSV UTF-8」再导入');
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (e) {
    throw whole(e instanceof Error ? e.message : String(e));
  }
  const [rawHeader, ...body] = table;
  if (!rawHeader || !body.length) throw whole('至少要有表头和一行数据');
  if (body.length > MAX_CSV_ROWS) throw whole(`一次最多导入 ${MAX_CSV_ROWS} 行，这份有 ${body.length} 行`);
  const header = rawHeader.map((h) => h.trim());
  const headerIssues: { path: string; message: string }[] = [];
  header.forEach((h, i) => {
    if (header.indexOf(h) !== i) headerIssues.push({ path: h, message: '表头重复' });
    else if (!shape.flat.has(h)) {
      headerIssues.push({ path: h, message: shape.order.includes(h) ? '不是平铺字段，CSV 里不收' : '没有这个字段' });
    }
  });
  if (!header.includes('id')) headerIssues.push({ path: 'id', message: '表头里要有 id' });
  if (headerIssues.length) throw new CatalogCsvError([{ row: 0, issues: headerIssues }]);

  const bad: { row: number; issues: { path: string; message: string }[] }[] = [];
  const seen = new Map<string, number>();
  const payloads = body.map((cells, i) => {
    const row = i + 1;
    const { payload, issues } = rowToPayload(shape, header, cells);
    if (!issues.length) {
      const r = CATALOG_SCHEMAS[kind].safeParse(payload);
      if (!r.success) issues.push(...r.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })));
    }
    const code = String(payload.id ?? '');
    if (code && seen.has(code)) issues.push({ path: 'id', message: `与第 ${seen.get(code)} 行的 id 重复` });
    else if (code) seen.set(code, row);
    if (issues.length) bad.push({ row, issues });
    return payload;
  });
  if (bad.length) throw new CatalogCsvError(bad);
  return payloads;
}
