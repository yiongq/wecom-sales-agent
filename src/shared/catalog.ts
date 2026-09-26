// 产品库条目的 schema 与编辑规则（01 spec「产品库 · 编辑规则」）。前后端共用：本目录只能 import zod 与 src/shared/**。
// schema 只做校验，写库的永远是请求原文按原键序合并出来的对象，不是 zod 的输出（zod 会按 schema 的顺序重排键，
// 而工具把条目原样 JSON.stringify 给模型，键序就是字节）。
import { z } from 'zod';
import { SALES_SEGMENTS, type Hotel, type Route } from './catalog-types.js';
import { storableText, UNSTORABLE_TEXT } from './console-api.js';
import { peakMonths } from './season.js';

export type CatalogKind = 'route' | 'hotel';

/** 与库里 catalog_items.code 的 CHECK 相同：条目的 id 就是 code */
const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 条目里其余的字符串都是它或枚举：NUL 与孤立代理项在这里拦下（库里的 json 存不下），后台新建、补丁、CSV 导入都是 422 点名字段 */
const text = z.string().min(1, '不能为空').refine(storableText, UNSTORABLE_TEXT);
const texts = z.array(text);
const int = z.number().int();

const ItineraryDay = z.strictObject({ day: int.positive(), title: text, detail: text, hotel: text, meals: text });

/**
 * 所有已知键都声明（含 overseas），顶层和嵌套对象一律 strict，未知键报错。不用 coerce：'1000' 不是 1000。
 * 可选的字符串与数组不接受空值，空的可选字段就是键不存在。bestSeason 必须能解析出至少一个月份，或者含「全年」。
 * itinerary 至少一项、条数等于 days，天号从 1 起连续（方案书与行程书按它排）。
 * overseas 必填：缺它时引擎退回看 tags 里有没有「国内」（src/tools.ts 的 foreign），表单上没勾的框看着像「否」、存下来却是缺，
 * 国内线路漏了「国内」标签就被当成境外推荐；它上架后锁定，错了只能停机用 catalog-fix 改。文件模式不过 schema，Route 类型里仍是可选
 */
export const RouteSchema: z.ZodType<Route> = z
  .strictObject({
    id: z.string().regex(CODE, 'id 只能是小写字母、数字和连字符，以字母或数字开头，最长 64 位'),
    title: text,
    destination: text,
    days: int.positive(),
    priceFrom: int.positive(),
    hotelLevel: text,
    bestSeason: text.refine(
      (s) => s.includes('全年') || peakMonths(s).size > 0,
      '最佳季要写出月份（如「6-9月」「11月-次年4月」）或「全年」',
    ),
    highlights: texts.min(1),
    tags: texts,
    segments: z.array(z.enum(SALES_SEGMENTS as [Route['segments'][number], ...Route['segments']])).min(1),
    aliases: texts.min(1).optional(),
    maxAltitude: int.nonnegative().optional(),
    intensity: z.strictObject({ level: z.enum(['轻松', '适中', '较累']), hardest: text }).optional(),
    itinerary: z.array(ItineraryDay).min(1),
    inclusions: texts.min(1).optional(),
    exclusions: texts.min(1).optional(),
    overseas: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (r.itinerary.length !== r.days) {
      ctx.addIssue({ code: 'custom', path: ['itinerary'], message: `逐日行程有 ${r.itinerary.length} 天，要和 days（${r.days}）相同` });
    }
    r.itinerary.forEach((d, i) => {
      if (d.day !== i + 1) ctx.addIssue({ code: 'custom', path: ['itinerary', i, 'day'], message: `第 ${i + 1} 项的 day 应为 ${i + 1}` });
    });
  });

export const HotelSchema: z.ZodType<Hotel> = z.strictObject({
  id: z.string().regex(CODE, 'id 只能是小写字母、数字和连字符，以字母或数字开头，最长 64 位'),
  name: text,
  destination: text,
  stars: text,
  nightlyFrom: int.positive(),
  roomType: text,
  highlights: texts.min(1),
  tags: texts,
});

export const CATALOG_SCHEMAS: Readonly<Record<CatalogKind, z.ZodType<Route> | z.ZodType<Hotel>>> = Object.freeze({
  route: RouteSchema,
  hotel: HotelSchema,
});

/** 任何状态下都不可改 */
export const ALWAYS_LOCKED = ['id'] as const;
/** active 条目不可改的字段（理由见 spec「各字段为什么锁」）。'tags:国内' 指 tags 里「国内」这一项的有无 */
export const LOCKED_WHEN_ACTIVE = {
  route: [
    'id',
    'title',
    'destination',
    'days',
    'priceFrom',
    'bestSeason',
    'segments',
    'aliases',
    'maxAltitude',
    'overseas',
    'tags:国内',
    'inclusions',
    'exclusions',
  ],
  hotel: ['id', 'name', 'destination', 'nightlyFrom'],
} as const;

/** 值相等：对象不看键序，数组看顺序。console 的表单据它判断哪些顶层字段改过 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

/** prev → next 改动了哪些锁定字段（按锁定表的顺序点名）；draft 条目只锁 id */
export function lockedFieldChanges(kind: CatalogKind, status: 'draft' | 'active', prev: object, next: object): string[] {
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const fields: readonly string[] = status === 'active' ? LOCKED_WHEN_ACTIVE[kind] : ALWAYS_LOCKED;
  return fields.filter((f) => {
    const [field, member] = f.split(':') as [string, string | undefined];
    if (member === undefined) return !sameValue(p[field], n[field]);
    const has = (v: unknown): boolean => Array.isArray(v) && v.includes(member);
    return has(p[field]) !== has(n[field]);
  });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** 按「定义」而不是「赋值」写键：请求里的 __proto__ 只是个普通键（随后被 strict schema 拒掉），不会改掉结果对象的原型 */
const put = (o: Record<string, unknown>, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
};

/**
 * 递归合并键序：对象按 prev 的键序，prev 里原有的键保持原位，next 新增的键按 next 的顺序追加在后面，
 * next 删掉的键去掉；数组按下标对齐元素，再逐项递归。值一律取 next 的
 */
export function mergeKeyOrder<T>(prev: T, next: T): T {
  if (Array.isArray(prev) && Array.isArray(next)) {
    return next.map((v: unknown, i) => (i < prev.length ? mergeKeyOrder(prev[i], v) : v)) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(prev)) if (Object.hasOwn(next, k)) put(out, k, mergeKeyOrder(prev[k], next[k]));
    for (const k of Object.keys(next)) if (!Object.hasOwn(prev, k)) put(out, k, next[k]);
    return out as T;
  }
  return next;
}

/** 字段级补丁：set 里点名的顶层字段整体替换，unset 里的字段删除，没点名的一律不动 */
export interface CatalogPatchBody {
  set: Record<string, unknown>;
  unset?: readonly string[];
}

/**
 * 把补丁应用到旧 payload 上，再按旧键序合并：写库的就是这个对象（值取请求原文，不取 zod 的输出）。
 * 同一个字段既 set 又 unset 说不清想要哪个，直接抛。锁定字段与 schema 由调用方随后检查
 */
export function applyCatalogPatch(prev: object, patch: CatalogPatchBody): Record<string, unknown> {
  const unset = patch.unset ?? [];
  const both = unset.filter((k) => Object.hasOwn(patch.set, k));
  if (both.length) throw new Error(`字段既 set 又 unset：${both.join('、')}`);
  // 展开写的是自有属性（CreateDataProperty），JSON.parse 出来的 __proto__ 键在这里也只是个普通键
  const next: Record<string, unknown> = { ...(prev as Record<string, unknown>), ...patch.set };
  for (const k of unset) delete next[k];
  return mergeKeyOrder(prev as Record<string, unknown>, next);
}
