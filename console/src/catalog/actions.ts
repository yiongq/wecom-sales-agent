// 产品库一条的几个动作（spec「产品库详情与编辑」的上架、复制为新草稿、「预览」页签、新建；设计系统 §5.14、F 页；
// plan 第 10.3 步）的纯逻辑。不依赖 React，只看行业包的配置和字段类型：
// - 页签：匿名默认「预览」，其余默认「编辑」；地址上只写不是默认的那一个；
// - 上架确认：第一句（activateLine 里的 {字段 key} 按类型写成值）、按锁定组分行的「字段 值」、没做的建议一句；
// - 复制为新草稿：新编号的检查、换掉编号的 payload；
// - 新建：编号字段没写帮助、示例时按实体补上（spec「新建」：帮助里写格式）。
import { CATALOG_CODE } from '../../../src/shared/catalog.js';
import { money, parseMonthRange, quantity } from '../../../src/shared/format.js';
import { type CheckIssue, CODE_RULE, type EntityType, type FieldDef, filled, valueAt } from '../../../src/shared/pack.js';
import { arrayValued, CODECS, moneyUnit, nounOf, type Payload, pruneHidden, visible, writeValue } from '../fields/model.js';
import type { ItemSearch } from './params.js';
import { issueText, locksOnActive } from './detail.js';

// ---------------- 页签 ----------------

export type ItemTab = 'edit' | 'preview';

/** 匿名默认看「预览」（spec 状态表「匿名」），能登录的人默认「编辑」（没有编辑权限的是全只读的编辑页签） */
export const defaultTab = (anon: boolean): ItemTab => (anon ? 'preview' : 'edit');

/** 地址上的页签；没写就是默认的那一个 */
export const tabOf = (search: ItemSearch, anon: boolean): ItemTab => search.tab ?? defaultTab(anon);

/** 换到这个页签时地址上写什么：默认的那一个不写，分享出去的链接短 */
export const tabSearch = (tab: ItemTab, anon: boolean): ItemSearch => (tab === defaultTab(anon) ? {} : { tab });

// ---------------- 值写成一段字 ----------------

/** 引用的值换成名称（store 为 code 时存的是编号）；找不到就原样写 */
export type RefName = (f: FieldDef, value: string) => string;

const asNames = (f: FieldDef, v: unknown, refName: RefName): string[] => {
  const c = CODECS.reference.read(v, f);
  const list = typeof c === 'string' ? [c] : c ? [...c] : [];
  return list.filter((x) => x !== '').map((x) => refName(f, x));
};

/**
 * 一个字段的值写成一段字（上架确认里的「字段 值」）：金额带单位（「13,800元/人」「268元/㎡」），带单位的整数（「5天」），
 * 多选与标签用「、」连，有序子项写条数（「7条」），引用写名称，是否写 trueLabel / falseLabel，月份区间写原文、
 * 月份的时候后面括号写 monthMeaning（「4月-10月（这些月份出发报价上浮10%，「全年」不加价）」），「全年」写 yearRoundLabel。
 * 没填时 null
 */
export function valueText(f: FieldDef, v: unknown, row: Payload, refName: RefName): string | null {
  if (!filled(v)) return null;
  switch (f.type) {
    case 'text':
    case 'longText':
      return typeof v === 'string' ? v : String(v);
    case 'money':
      return typeof v === 'number' ? money(v, moneyUnit(f, row)) : String(v);
    case 'intUnit':
      return typeof v === 'number' ? quantity(v, f.unit ?? '') : String(v);
    case 'monthRange': {
      const s = String(v);
      const range = parseMonthRange(s);
      if (range?.kind === 'yearRound') return f.yearRoundLabel ?? s;
      return range && f.monthMeaning ? `${s}（${f.monthMeaning}）` : s;
    }
    case 'enum': {
      // 按字符串存的多选（餐食）照原文写：存的就是这串字
      if (f.storeAs) return typeof v === 'string' ? v : null;
      const c = CODECS.enum.read(v, f);
      return typeof c === 'string' ? c : (c ?? []).join('、') || null;
    }
    case 'tags':
      return Array.isArray(v) ? v.join('、') : String(v);
    case 'boolean':
      return v === true ? (f.trueLabel ?? '是') : v === false ? (f.falseLabel ?? '否') : null;
    case 'subItems':
      return Array.isArray(v) ? `${v.length}${nounOf(f)}` : null;
    case 'reference':
      return asNames(f, v, refName).join('、') || null;
    case 'status':
      return null;
  }
}

/**
 * 上架确认的第一句（设计系统 F 页）：activateLine 里的 {字段 key} 换成值，占位两侧手打的空格去掉（中西文间距由 text-autospace 补，
 * 不变量 9），句末补句号。单位固定的金额只写斜线前面的（「每人 {priceFrom} 起」→「每人13,800元起」，「每人」已经在句子里了，
 * 与列表表头同一个规矩）；单位取另一个字段的金额照写全（「按268元/㎡计价」）
 */
export function activateSentence(entity: EntityType, payload: Payload, refName: RefName): string {
  const line = entity.activateLine.replace(/\s*\{([^}]*)\}\s*/g, (_, key: string) => {
    const f = entity.fields.find((x) => x.key === key);
    const v = f ? valueAt(payload, key) : undefined;
    if (!f) return '';
    if (f.type === 'money' && f.unit && typeof v === 'number') return money(v, f.unit.split('/')[0]);
    return valueText(f, v, payload, refName) ?? '—';
  });
  return /[。！？.!?]$/.test(line) ? line : `${line}。`;
}

/** 锁定清单里的一段「字段 值」；label 为 null 时只写值（是否字段写「境内」就够了）；empty 是没填 */
export interface LockPair {
  key: string;
  label: string | null;
  value: string;
  /** 编号用等宽字 */
  mono?: boolean;
  empty?: boolean;
}

/** 锁定清单的一行：锁定组的 Tag，和这一组上架后锁定的各个字段；没有锁定组的锁定字段（如假包主材的编号）归到最后一行「其他」 */
export interface LockLine {
  key: string;
  tag: string;
  pairs: LockPair[];
}

/** 只锁几个成员的标签：写的是这几个成员有没有（「标签「国内」」「标签没有「国内」」），其余的上架后照样能改 */
function memberPair(f: FieldDef & { lockedWhenActive: { members: string[] } }, v: unknown): LockPair {
  const have = Array.isArray(v) ? f.lockedWhenActive.members.filter((m) => v.includes(m)) : [];
  const lack = f.lockedWhenActive.members.filter((m) => !have.includes(m));
  const parts = [
    ...(have.length ? [have.map((m) => `「${m}」`).join('')] : []),
    ...(lack.length ? [`没有${lack.map((m) => `「${m}」`).join('')}`] : []),
  ];
  return { key: f.key, label: f.label, value: parts.join('，') };
}

/**
 * 上架后锁定的内容，按锁定组分行（spec「上架」，设计系统 F 页）：行按 lockGroups 的顺序，行里按字段的顺序；
 * showWhen 没显示出来的字段不在里面（它们会被删掉）。没填的写「没填」：上架以后也补不上了
 */
export function lockLines(entity: EntityType, payload: Payload, refName: RefName): LockLine[] {
  const shown = pruneHidden(payload, entity.fields);
  const pairOf = (f: FieldDef): LockPair => {
    const v = valueAt(shown, f.key);
    if (typeof f.lockedWhenActive === 'object') return memberPair(f as FieldDef & { lockedWhenActive: { members: string[] } }, v);
    const text = valueText(f, v, shown, refName);
    const bare = f.type === 'boolean' && f.trueLabel !== undefined && f.falseLabel !== undefined && text !== null;
    return {
      key: f.key,
      label: bare ? null : f.label,
      value: text ?? '没填',
      ...(f.key === '$code' ? { mono: true } : {}),
      ...(text === null ? { empty: true } : {}),
    };
  };
  const locked = entity.fields.filter((f) => locksOnActive(f) && visible(f, shown));
  const lines: LockLine[] = Object.entries(entity.lockGroups).flatMap(([key, g]) => {
    const fs = locked.filter((f) => f.lockGroup === key);
    return fs.length ? [{ key, tag: g.tag, pairs: fs.map(pairOf) }] : [];
  });
  const loose = locked.filter((f) => f.lockGroup === undefined || !Object.hasOwn(entity.lockGroups, f.lockGroup));
  return loose.length ? [...lines, { key: '', tag: '其他', pairs: loose.map(pairOf) }] : lines;
}

/** 有建议没做时的一句（设计系统 F 页）：「有1条建议没做：体力强度没填（不拦上架）」；都做了 null */
export function recommendLine(recommended: readonly CheckIssue[]): string | null {
  if (!recommended.length) return null;
  return `有${recommended.length}条建议没做：${recommended.map(issueText).join('、')}（不拦上架）`;
}

// ---------------- 复制为新草稿 ----------------

/**
 * 复制时填的新编号有什么问题（spec「复制为新草稿」）：没填、格式不对、和原来的一样、列表里已经有了；没问题 null。
 * 列表里的只是提前说一声，服务端照样按 409 catalog_code_taken 拦
 */
export function codeProblem(code: string, from: string, taken: readonly string[]): string | null {
  if (code === '') return '没填';
  // 与共用 schema 的 CATALOG_CODE 同一条规则，说法与上架前检查相同
  if (!CATALOG_CODE.test(code)) return CODE_RULE;
  if (code === from) return '和原来的编号一样，换一个';
  return taken.includes(code) ? '这个编号已经有了，换一个' : null;
}

/** 编号字段（$code）：payload 里是 id；写回走表单同一个函数，键序不变 */
const CODE_FIELD: FieldDef = { key: '$code', type: 'text', label: '', group: '' };

/** 复制出来的 payload：原 payload 换掉编号，其余一个字节不动（spec「复制为新草稿」：用原 payload 调 POST /catalog/:kind） */
export const copyPayload = (payload: Payload, code: string): Payload => writeValue(payload, CODE_FIELD, code);

// ---------------- 新建 ----------------

/** 编号字段没写帮助时的格式说明（spec「新建」：`$code` 可以填，帮助里写格式） */
export const CODE_HELP = '小写字母、数字和连字符，建好后不能改';

/** 编号字段补上帮助和示例（行业包没写的时候）：帮助写格式，示例取实体的 codeExample */
export function withCodeHints(entity: EntityType): EntityType {
  if (!entity.fields.some((f) => f.key === '$code' && (f.help === undefined || f.placeholder === undefined))) return entity;
  return {
    ...entity,
    fields: entity.fields.map((f) =>
      f.key === '$code' ? { ...f, help: f.help ?? CODE_HELP, placeholder: f.placeholder ?? `例：${entity.codeExample}` } : f,
    ),
  };
}

/**
 * 新建时的空表单（spec「新建」）：什么都没填，只有必填的数组字段（标签、多选、有序子项）先放一个空数组。
 * 数组的必填只要求键存在，可以是空的（酒店的标签，spec「校验」），可控件画不出「键在、一项没有」：不先放上，
 * 一个标签都不要的酒店就永远报「没填」（01 的旧抽屉同样先放空数组）。至少几项（min）、条数一致（countFrom）照旧由上架前检查报；
 * showWhen 管着的字段不放，它们随条件出现
 */
export function blankPayload(entity: EntityType): Payload {
  let out: Payload = {};
  // 选填的不用挑出来：writeValue 不给选填字段留空数组（01 的 schema 要求它们出现时不为空）
  for (const f of entity.fields) if (!f.showWhen && arrayValued(f)) out = writeValue(out, f, []);
  return out;
}

/**
 * 新建提交的 payload 按字段的顺序排键（编号在最前）：条目原样 JSON 给模型，键序就是字节，不该随表单里先放的空数组、
 * 填字段的先后变。行业包里没有的键排在最后，原样保留
 */
export function inFieldOrder(entity: EntityType, payload: Payload): Payload {
  const keys = [...new Set(entity.fields.map((f) => (f.key === '$code' ? 'id' : f.key.split('.')[0]!)))];
  const out: Payload = {};
  for (const k of keys) if (Object.hasOwn(payload, k)) out[k] = payload[k];
  for (const [k, v] of Object.entries(payload)) if (!Object.hasOwn(out, k)) out[k] = v;
  return out;
}
