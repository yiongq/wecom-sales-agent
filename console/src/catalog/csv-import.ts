// 产品库 CSV 导入弹窗（spec「CSV 导入（H 页）」，设计系统 H 页，plan 第 12 步）的纯逻辑。不依赖 React，只看行业包的配置和字段类型：
// - 第 1 步：模板（带 BOM，只有一行表头，写字段的中文标签，只含能平铺的字段）与填写规则，例子取已有的一条；
// - 第 2、3 步：解码之后的预检。空文件与只有表头；整份的问题（表头、引号）；三条上限（有一行单独也超了时写是哪一行）；
//   逐行合格与否（共用的 checkCsvRows，逐行过上架前检查 checkItem，与服务端的 schema 同判，不变量 15）；编号是否已经有了（对照已载入的列表）。
//   问题写成「每晚起价：要写整数，写的是「2,6OO」」，标出是哪一格；
// - 第 4 步：只导入合格的行（过滤以后重新写成 CSV，同样过三条上限）；服务端 422 的逐行问题放回原来的那一行；
//   下载不合格的行（带原因、每格加引号、危险字符开头的格子加制表符，防公式注入）。
import {
  CSV_MAX_BODY_BYTES,
  CSV_MAX_CHARS,
  CSV_MAX_ROWS,
  CSV_REASON_HEADER,
  type CsvIssue,
  checkCsvRows,
  csvLongRows,
  csvParts,
  type EntityCsvShape,
  entityCsvShape,
  guardCell,
  parseCatalogCsv,
  resolveCsvHeader,
  toCsv,
  unguardCell,
} from '../../../src/shared/catalog-csv.js';
import { digits, money, quantity } from '../../../src/shared/format.js';
import { CODE_RULE, checkItem, type EntityType, type FieldDef, type IndustryPack } from '../../../src/shared/pack.js';
import type { CsvEncoding } from '../csvFile.js';
import { moneyUnit, nounOf, type Payload } from '../fields/model.js';
import { STATUS_LABEL } from '../parts/Status.js';
import { fieldOfPath, itemTitle, subPathOf } from './detail.js';
import { headerLabel, type ListRow, textWidth } from './list.js';
import { readable } from './save.js';

const BOM = String.fromCharCode(0xfeff);

/** 弹窗的五步（设计系统 H 页的步骤条） */
export const STEPS = ['下载模板', '选文件', '校验结果', '导入', '完成'] as const;

// ---------------- 第 1 步：模板与填写规则 ----------------

/** 模板：带 BOM（Excel 双击打开中文不乱码），只有一行表头，写字段的中文标签 */
export const templateCsv = (entity: EntityType): string => BOM + toCsv([entityCsvShape(entity).columns.map((c) => guardCell(c.label))]);

export const templateName = (entity: EntityType): string => `${entity.label}导入模板.csv`;

export interface CsvRule {
  key: string;
  /** 表头写什么 */
  label: string;
  optional: boolean;
  /** 怎么填 */
  how: string;
  /** 例子；没有时 null */
  example: string | null;
}

/** 数组的条数要求：「，至少1条」 */
function minText(f: FieldDef): string {
  if (f.min === undefined) return '';
  return f.type === 'subItems' ? `，至少${f.min}${nounOf(f)}` : `，至少${f.min}个`;
}

/** 一列怎么填（按字段类型）：数组用「、」分隔，布尔写「是」或「否」 */
function howToFill(pack: IndustryPack, f: FieldDef): string {
  const several = '可以写几个，用「、」分隔';
  switch (f.type) {
    case 'text':
    case 'longText':
      return f.key === '$code' ? CODE_RULE : '文字';
    case 'monthRange':
      return `写出月份，如「6-9月」「11月-次年4月」，或写「${f.yearRoundLabel ?? '全年'}」`;
    case 'money':
      return '整数（元），不写逗号';
    case 'intUnit':
      return f.unit ? `整数（${f.unit}）` : '整数';
    case 'boolean':
      return f.trueLabel && f.falseLabel ? `写「是」（${f.trueLabel}）或「否」（${f.falseLabel}）` : '写「是」或「否」';
    case 'enum': {
      const opts = (f.options ?? []).join('、');
      if (!f.multiple) return `${opts}，写其中一个`;
      return f.storeAs ? `${opts}，可以写几个，用「${f.storeAs.join}」连起来` : `${opts}，${several}${minText(f)}`;
    }
    case 'tags':
      return `${several}${minText(f)}`;
    case 'reference': {
      const target = pack.entities.find((e) => e.kind === f.to)?.label ?? '';
      const what = `写${target}的${f.store === 'code' ? '编号' : '名称'}`;
      return f.multiple ? `${what}，${several}${minText(f)}` : what;
    }
    case 'subItems':
      return `可以写几${nounOf(f)}，用「、」分隔${minText(f)}`;
    case 'status':
      return '';
  }
}

/** 一个值写进 CSV 的样子：数组用「、」连，布尔写是或否 */
function csvText(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('、') || null;
  return null;
}

/**
 * 填写规则：每列的表头、是否选填、怎么填和例子。例子照着已有的一条（sample）写，这样整列读下来就是一行能导入的数据；
 * 编号写行业包给的示例编号（已有的那条的编号再导入会撞上）；sample 没有这个字段时取 placeholder「例：」后面的
 */
export function csvRules(pack: IndustryPack, entity: EntityType, sample?: Payload): CsvRule[] {
  return entityCsvShape(entity).columns.map(({ key, label, field: f }) => {
    const fromSample = key === 'id' || !sample ? null : csvText(sample[key]);
    const fromPlaceholder = f.placeholder?.replace(/^例：/, '') || null;
    return {
      key,
      label,
      optional: f.required === false || f.showWhen !== undefined,
      how: howToFill(pack, f),
      example: key === 'id' ? entity.codeExample : (fromSample ?? fromPlaceholder),
    };
  });
}

// ---------------- 第 2、3 步：预检 ----------------

export interface CsvSource {
  /** 文件名；粘贴的是 null */
  name: string | null;
  /** 按哪种编码读的；粘贴的是 null */
  encoding: CsvEncoding | null;
  text: string;
}

export interface RowIssue {
  /** 标出哪一格：这一列的 payload 键（编号是 id）；null 是整行的问题（列数不对） */
  col: string | null;
  /** 原因一列里的一句：「每晚起价：要写整数，写的是「2,6OO」」 */
  text: string;
  /** 数值格写错时原样的格子：格子里和原因里，形似数字的字母（O、l…）加波浪线（设计系统 H 页） */
  raw?: string;
}

export interface RowResult {
  /** 数据行号，从 1 起 */
  row: number;
  /** 这一行原样的格子 */
  cells: string[];
  payload: Payload;
  /** 空数组就是合格 */
  issues: RowIssue[];
}

export interface CsvTable {
  /** 表头原样 */
  header: string[];
  /** 每一列的 payload 键；null 是「不合格原因」列（导入时忽略） */
  keys: (string | null)[];
  rows: RowResult[];
}

export type CsvCheck =
  /** 空文件，或只有表头：停在第 2 步 */
  | { kind: 'empty' }
  /** 整份的问题（表头、引号）：第 3 步只放说明，没有表格。rows 是数据行数，解析不出来时 null */
  | { kind: 'whole'; rows: number | null; lines: string[] }
  /** 超过三条上限中的一条：要分成 parts 份 */
  | { kind: 'big'; rows: number; parts: number }
  /** 有的行连同表头单独一份也超上限（long 是这些行的行号）：分成几份也导入不了 */
  | { kind: 'long'; rows: number; long: number[] }
  | { kind: 'rows'; table: CsvTable };

/** 列的中文名：字段标签；编号写编号的标签 */
function columnLabel(entity: EntityType, shape: EntityCsvShape, key: string): string | undefined {
  return shape.columns.find((c) => c.key === key)?.label ?? (key === 'id' ? entity.codeLabel : undefined);
}

/** 整份的问题写成一句：表头的问题以「列名」开头（「「nope」没有这个字段」「「酒店编号」这一列不能少」） */
function wholeLines(entity: EntityType, shape: EntityCsvShape, e: unknown): string[] {
  const issues = (e as { rows?: { issues: CsvIssue[] }[] }).rows?.flatMap((r) => r.issues);
  if (!issues) throw e;
  return issues.map((i) => (i.path === '' ? i.message : `「${columnLabel(entity, shape, i.path) ?? i.path}」${i.message}`));
}

/** 提交的写法里留下的格子：「不合格原因」列不提交 */
const sendable = (keys: readonly (string | null)[], cells: readonly string[]): string[] => cells.filter((_, i) => keys[i] !== null);

/**
 * 预检整份 CSV：文本来自文件（已按 UTF-8 或 GBK 解码）或粘贴。existing 是已载入的列表（查编号是否已经有了）；
 * 还没取到时不查，由服务端兜底（422 按行放回来）
 */
export function checkCsv(entity: EntityType, text: string, existing?: readonly ListRow[]): CsvCheck {
  const shape = entityCsvShape(entity);
  let table: string[][];
  try {
    table = parseCatalogCsv(text);
  } catch (e) {
    return { kind: 'whole', rows: null, lines: wholeLines(entity, shape, e) };
  }
  const [header, ...body] = table;
  if (!header || !body.length) return { kind: 'empty' };
  let keys: (string | null)[];
  try {
    keys = resolveCsvHeader(shape, header, shape.labels);
  } catch (e) {
    return { kind: 'whole', rows: body.length, lines: wholeLines(entity, shape, e) };
  }
  const sendHead = sendable(keys, header);
  const sendBody = body.map((c) => sendable(keys, c));
  const long = csvLongRows(sendHead, sendBody);
  if (long.length) return { kind: 'long', rows: body.length, long };
  const parts = csvParts(sendHead, sendBody);
  if (parts > 1) return { kind: 'big', rows: body.length, parts };

  const byCode = new Map((existing ?? []).map((r) => [r.code, r]));
  const checked = checkCsvRows(shape, keys, body, (payload) =>
    checkItem(entity, payload).required.map((i) => ({ path: i.path === '$code' ? 'id' : i.path, message: i.message, label: i.label })),
  );
  const rows = checked.map(({ row, cells, payload, issues }): RowResult => {
    const out = issues.map((i): RowIssue => {
      if (i.path === '') return { col: null, text: i.message };
      const col = i.path.split('.')[0]!;
      const text = `${i.label ?? columnLabel(entity, shape, col) ?? i.path}：${i.message}`;
      // 转换时报的数值格（检查项带 label，转换的不带）：原样的格子标出形似数字的字母
      const raw =
        i.label === undefined && shape.flat.get(col) === 'integer' ? unguardCell(cells[keys.indexOf(col)] ?? '').trim() : undefined;
      return raw === undefined ? { col, text } : { col, text, raw };
    });
    const code = typeof payload.id === 'string' ? payload.id : '';
    const taken = byCode.get(code);
    if (taken) {
      const status = taken.status ? `，${STATUS_LABEL[taken.status === 'active' ? 'active' : 'draft']}` : '';
      out.push({
        col: 'id',
        text: `${columnLabel(entity, shape, 'id')}：这个编号已经有了（${itemTitle(entity, taken.payload, code)}${status}）`,
      });
    }
    return { row, cells, payload, issues: out };
  });
  return { kind: 'rows', table: { header, keys, rows } };
}

export const goodRows = (t: CsvTable): RowResult[] => t.rows.filter((r) => !r.issues.length);
export const badRows = (t: CsvTable): RowResult[] => t.rows.filter((r) => r.issues.length > 0);

/** 汇总的 Alert：有不合格的行时 warning */
export function csvSummary(t: CsvTable): { tone: 'info' | 'warning'; title: string; note: string } {
  const good = goodRows(t).length;
  const bad = t.rows.length - good;
  const drafts = '导入的都是草稿，逐条检查后再上架';
  if (!bad) return { tone: 'info', title: `${good}行都可以导入`, note: drafts };
  const marked = '要改的格子已标出，原因写在最后一列';
  if (!good) return { tone: 'warning', title: `${bad}行都要改`, note: `${marked}。改好后换一个文件再导入` };
  return { tone: 'warning', title: `${good}行可以导入，${bad}行要改`, note: `${marked}。${drafts}` };
}

/** 主按钮：全部合格「导入N条草稿」，有不合格「只导入合格的N行」（不放禁用的「全部导入」） */
export const importLabel = (t: CsvTable): string =>
  badRows(t).length ? `只导入合格的${goodRows(t).length}行` : `导入${goodRows(t).length}条草稿`;

export const downloadLabel = (t: CsvTable): string => `下载不合格的${badRows(t).length}行（带原因）`;

/** 超过上限时的一句，下面再写三条上限 */
export const bigTitle = (parts: number): string => `这份文件太大，请分成${parts}份导入`;
export const LIMITS_NOTE = `一次最多导入${CSV_MAX_ROWS}行，整份不超过${digits(CSV_MAX_CHARS)}个字、${CSV_MAX_BODY_BYTES / 1024}KB`;
/** 有一行单独也超上限：写出是哪几行（最多三个行号），分成几份也导入不了 */
export function longTitle(rows: readonly number[]): string {
  const more = rows.length > 3 ? `等${rows.length}行` : '';
  return `第${rows.slice(0, 3).join('、')}行${more}太长，分成几份也导入不了`;
}
export const longNote = (n: number): string => `${LIMITS_NOTE}。${n > 1 ? '这几行' : '这一行'}连同表头单独一份也超了`;

// ---------------- 第 3 步的表格 ----------------

/** 表格里画的字段列：标题与编号合成首列（两行），数组不画（问题照样写在原因里），其余按字段顺序、只画文件里有的 */
export function tableFields(entity: EntityType, keys: readonly (string | null)[]): FieldDef[] {
  const shape = entityCsvShape(entity);
  return shape.columns
    .filter((c) => c.key !== 'id' && c.key !== entity.titleKey && keys.includes(c.key) && shape.flat.get(c.key) !== 'strings')
    .map((c) => c.field);
}

/** 表头：单位固定的金额把单位写进表头（「每晚起价（元）」），与列表相同 */
export const tableHeader = headerLabel;

/** 一格写什么：转换好的数按列表的写法（「3,400」「10年」），是否写两种文字；转换不了的写原样的字 */
export function cellText(f: FieldDef, row: RowResult, keys: readonly (string | null)[]): string {
  const key = f.key === '$code' ? 'id' : f.key;
  const v = row.payload[key];
  if (typeof v === 'number') {
    if (f.type === 'money') return f.unit ? digits(v) : money(v, moneyUnit(f, row.payload));
    return quantity(v, f.unit ?? '');
  }
  if (typeof v === 'boolean') return v ? (f.trueLabel ?? '是') : (f.falseLabel ?? '否');
  const i = keys.indexOf(key);
  return i < 0 ? '' : unguardCell(row.cells[i] ?? '').trim();
}

/**
 * 表格的列宽（弹窗里的表格，设计系统 §5.5 与 H 页）：行号、结果定宽；名称与编号、各字段按表头与这份文件的内容估宽（有上限）；
 * 原因占剩下的，至少 REASON_MIN，写不下就折行。total 是表格的最小宽度：比弹窗宽时表格自己横向滚动（375 宽时就是这样）
 */
export const ROW_WIDTH = 40;
export const RESULT_WIDTH = 72;
export const REASON_MIN = 170;
/** 单元格左右内边距各 8（估宽本来就宁宽勿窄：汉字按 1em、西文按 0.6em 算） */
const PAD = 16;
export function resultWidths(entity: EntityType, t: CsvTable): { title: number; fields: Record<string, number>; total: number } {
  const titleField = entity.fields.find((f) => f.key === entity.titleKey);
  const code: FieldDef = { key: '$code', type: 'text', label: entity.codeLabel, group: '' };
  const fit = (head: number, texts: string[], max: number): number =>
    Math.min(max, Math.max(head, ...texts.map((x) => textWidth(x, 14))) + PAD);
  const title = Math.max(
    fit(textWidth(`${titleField?.label ?? ''}·编号`, 13), titleField ? t.rows.map((r) => cellText(titleField, r, t.keys)) : [], 240),
    Math.min(240, Math.max(0, ...t.rows.map((r) => textWidth(cellText(code, r, t.keys), 12.5))) + PAD),
  );
  const fields: Record<string, number> = {};
  for (const f of tableFields(entity, t.keys)) {
    fields[f.key] = fit(
      textWidth(tableHeader(f), 13),
      t.rows.map((r) => cellText(f, r, t.keys)),
      200,
    );
  }
  const total = ROW_WIDTH + RESULT_WIDTH + title + Object.values(fields).reduce((a, b) => a + b, 0) + REASON_MIN;
  return { title, fields, total };
}

/** 形似数字的字母：O、o 像 0，I、l 像 1 */
const LOOKALIKE = /[OoIl]/;

/** 把一段字拆成形似数字的字母与其余部分：前者加波浪线 */
export function lookalikeParts(s: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  for (const ch of s) {
    const mark = LOOKALIKE.test(ch);
    const last = out.at(-1);
    if (last && last.mark === mark && !mark) last.text += ch;
    else out.push({ text: ch, mark });
  }
  return out;
}

// ---------------- 第 4 步：提交、服务端的逐行问题、下载不合格的行 ----------------

/** 要提交的 CSV：表头和合格的行原样（去掉「不合格原因」列），行用 \n 结尾；rows 是这些行原来的行号，fits 是三条上限都没超 */
export function submission(t: CsvTable): { csv: string; rows: number[]; fits: boolean } {
  const head = sendable(t.keys, t.header);
  const good = goodRows(t).map((r) => sendable(t.keys, r.cells));
  return {
    csv: toCsv([head, ...good], { eol: '\n' }),
    rows: goodRows(t).map((r) => r.row),
    fits: csvParts(head, good) === 1,
  };
}

/** 服务端说明的位置：字段写标签，有序子项的一项写「酒店亮点第1条」；对不上字段时 null */
function serverLabel(entity: EntityType, path: string): { col: string; label: string } | null {
  const f = fieldOfPath(entity, path === 'id' ? '$code' : path);
  if (!f) return null;
  const col = f.key === '$code' ? 'id' : f.key.split('.')[0]!;
  const sub = subPathOf(f, path);
  return { col, label: sub ? `${f.label}第${sub.index + 1}${nounOf(f)}` : f.label };
}

/**
 * 服务端 422 invalid_csv 的逐行问题放回原来的行：服务端的行号是提交的那份 CSV 里的（sent 是它们原来的行号）；
 * 第 0 行（整份）的问题单独给出。说明不是中文的（zod 自带的英文）写「格式不对」
 */
export function withServerIssues(
  entity: EntityType,
  t: CsvTable,
  sent: readonly number[],
  serverRows: readonly { row: number; issues: readonly { path: string; message: string }[] }[],
): { table: CsvTable; whole: string[] } {
  const whole: string[] = [];
  const extra = new Map<number, RowIssue[]>();
  for (const r of serverRows) {
    const lines = r.issues.map((i): RowIssue => {
      const at = serverLabel(entity, i.path);
      return at ? { col: at.col, text: `${at.label}：${readable(i.message)}` } : { col: null, text: readable(i.message) };
    });
    const original = r.row > 0 ? sent[r.row - 1] : undefined;
    if (original === undefined) whole.push(...lines.map((l) => l.text));
    else extra.set(original, [...(extra.get(original) ?? []), ...lines]);
  }
  const rows = t.rows.map((r) => (extra.has(r.row) ? { ...r, issues: [...r.issues, ...extra.get(r.row)!] } : r));
  return { table: { ...t, rows }, whole };
}

/**
 * 下载的不合格行：表头加一列「不合格原因」，几处原因用「；」连；每格都加双引号，危险字符开头的格子在引号内的开头加制表符
 * （先去掉上回下载时加的，不叠加），文件带 BOM。原因总在「不合格原因」那一列：少了格子的行补空格子；
 * 多了格子的行，多出来的放在原因右边（照原样留着，好看出多在哪；再导入时这一行仍是列数不对）
 */
export function failedCsv(t: CsvTable): string {
  const head = [...sendable(t.keys, t.header), CSV_REASON_HEADER];
  const width = head.length - 1;
  const body = badRows(t).map((r) => {
    const cells = sendable(t.keys, r.cells);
    const fields = cells.slice(0, width);
    while (fields.length < width) fields.push('');
    return [...fields, r.issues.map((i) => i.text).join('；'), ...cells.slice(width)];
  });
  return (
    BOM +
    toCsv(
      [head, ...body].map((row) => row.map((c) => guardCell(unguardCell(c)))),
      { quoteAll: true },
    )
  );
}

export function failedName(entity: EntityType, source: CsvSource, n: number): string {
  const base = source.name ? source.name.replace(/\.csv$/i, '') : entity.label;
  return `${base}-不合格的${n}行.csv`;
}
