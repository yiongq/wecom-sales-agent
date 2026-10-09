// 审计日志（K 页）的纯逻辑（spec「逐页设计 · 审计日志（K 页）」，设计系统 §5.4、§5.13、§6.5、§6.8、§10.2 K 页）：
// 地址里的筛选换算成 AuditQuery.actions、按页取数、按天分组的时间线（连续同类记录合成一句）、详情抽屉里写什么。
// 不依赖 React，audit.selftest.tsx 直接 import。
// 界面不认行业：句子由 describeAudit 生成，实体名、字段名、话术节名、产品库那一类的名字都取自行业包；
// 动作编码、对象类型与编号、JSON 原文只进技术详情（不变量 7）。
import {
  auditActor,
  auditItemName,
  auditMergeable,
  auditRuns,
  describeAudit,
  type AuditLookups,
  type AuditPart,
} from '../../../src/shared/audit-text.js';
import type { AuditEntryView, AuditPage } from '../../../src/shared/console-api.js';
import {
  absoluteTime,
  clockTime,
  dayHeading,
  dayKey,
  digits,
  fullTime,
  money,
  monthRangeText,
  parseMonthRange,
  quantity,
} from '../../../src/shared/format.js';
import type { EntityType, FieldDef, IndustryPack } from '../../../src/shared/pack.js';
import { auditActionsParam, auditGroups, type AuditGroup } from '../../../src/shared/ui-labels.js';
import type { AuditSearch } from '../audit-search.js';
import { STATUS_LABEL } from '../parts/Status.js';

// ---------------- 筛选 ----------------

export type GroupKey = AuditGroup | 'all';

/** 分段控件的选项：全部 / 销售话术 / {产品库} / 账号与登录 / 平台与配置（产品库那一类的名字取行业包） */
export const groupOptions = (pack: IndustryPack): ReadonlyArray<{ key: GroupKey; label: string }> => auditGroups(pack);

export const activeGroup = (search: AuditSearch): GroupKey => search.cat ?? 'all';
export const showLogin = (search: AuditSearch): boolean => search.login === 1;

/** 类别与「显示登录记录」换算成 AuditQuery.actions，服务端过滤（翻页不出空页）；全部且显示登录记录时不带 */
export const actionsOf = (search: AuditSearch): string | undefined => auditActionsParam(activeGroup(search), showLogin(search));

/** 换类别：开关留着 */
export const groupSearch = (key: GroupKey, search: AuditSearch): AuditSearch => ({
  ...(key === 'all' ? {} : { cat: key }),
  ...(showLogin(search) ? { login: 1 as const } : {}),
});

/** 开关「显示登录记录」：类别留着 */
export const loginSearch = (on: boolean, search: AuditSearch): AuditSearch => ({
  ...(search.cat ? { cat: search.cat } : {}),
  ...(on ? { login: 1 as const } : {}),
});

// ---------------- 按页取 ----------------

/** 每次请求多少条（接口上限 100） */
export const AUDIT_PAGE = 50;
/** 一页末尾的同类记录还没合完时，最多再往后取几次（一次 CSV 导入至多 200 行，4 次取得完） */
export const MAX_EXTRA_FETCHES = 10;

/**
 * 翻到哪了：before 是下一次请求的游标（undefined 表示从最新的开始，null 表示服务端没有更早的了）；
 * carry 是已经取回来、还没显示的记录（为了看清页尾那一句合没合完多取的）
 */
export interface AuditCursor {
  before: number | null | undefined;
  carry: readonly AuditEntryView[];
}
export const FIRST_CURSOR: AuditCursor = { before: undefined, carry: [] };

/** 「加载更早的记录」一次加上的记录；next 为 null 表示到底了 */
export interface AuditChunk {
  items: AuditEntryView[];
  next: AuditCursor | null;
}

/** 两条相邻记录合不合成一句：与 auditRuns 同一条规则 */
const sameRun = (a: AuditEntryView, b: AuditEntryView): boolean => auditRuns([a, b]).length === 1;

/**
 * 取一页（「加载更早的记录」一次）：凑够 size 条，页尾那一句合并的记录还没完时接着往后取，直到那一句完整，
 * 不把一次 CSV 导入截成「新建了4条酒店草稿」这种与事实不符的句子（第 4 步的总览同理）。多取回来的放进 carry，下一页先用它，
 * 不重取。get(before) 发一次 GET /audit；before 为 undefined 时从最新的取
 */
export async function loadAuditChunk(
  get: (before: number | undefined) => Promise<AuditPage>,
  cursor: AuditCursor,
  size = AUDIT_PAGE,
): Promise<AuditChunk> {
  const buf = [...cursor.carry];
  // 游标放在对象里：取数的小函数改它，循环条件读它
  const pos = { before: cursor.before };
  const more = async (): Promise<void> => {
    const page = await get(pos.before ?? undefined);
    buf.push(...page.items);
    // 空页却给了游标（接口不会这样）也算到底，免得一直取下去
    pos.before = page.items.length ? page.nextBefore : null;
  };
  while (buf.length < size && pos.before !== null) await more();
  let cut = Math.min(size, buf.length);
  for (let extra = 0; ; extra += 1) {
    while (cut > 0 && cut < buf.length && sameRun(buf[cut - 1]!, buf[cut]!)) cut += 1;
    // 那一句在已取到的记录里结束了、服务端到底了、页尾这条合不了，或者已经往后取够了次数：就停在这里
    const open = cut === buf.length && cut > 0 && pos.before !== null && auditMergeable(buf[cut - 1]!.action);
    if (!open || extra >= MAX_EXTRA_FETCHES) break;
    await more();
  }
  const rest = buf.slice(cut);
  return { items: buf.slice(0, cut), next: rest.length || pos.before !== null ? { before: pos.before, carry: rest } : null };
}

// ---------------- 时间线 ----------------

/** 句子下一行：改动摘要，或者编号（「线路编号 r-guizhou-5d」，编号用等宽字） */
export interface LineSummary {
  text: string;
  code?: string;
}

export interface TimelineLine {
  /** 这一句第一条（最新的）记录的 id */
  key: number;
  entries: AuditEntryView[];
  actor: { name: string; human: boolean };
  /** 操作者之后的句子（对象用 500） */
  parts: AuditPart[];
  summary: LineSummary | null;
  /** 右边的时刻「13:40」，悬停写绝对时间 */
  time: string;
  timeTitle: string;
  at: string;
  /** 合了几条；大于 1 时末尾是「展开N条」 */
  count: number;
}

export interface DayGroup {
  key: string;
  /** 「今天」「9月26日 周六」各段，之间用 Sep */
  heading: string[];
  lines: TimelineLine[];
}

const entityOf = (pack: IndustryPack, kind: string | null): EntityType | null =>
  (kind !== null && pack.entities.find((e) => e.kind === kind)) || null;

/** 合并的那一句列出前几条的名字 */
const MERGED_NAMES = 3;

function summaryOf(run: readonly AuditEntryView[], pack: IndustryPack, lookups: AuditLookups, text: string | null): LineSummary | null {
  const first = run[0]!;
  if (run.length > 1) {
    const names = run.slice(0, MERGED_NAMES).map((e) => auditItemName(e, pack, lookups));
    return { text: run.length > MERGED_NAMES ? `${names.join('、')}等${run.length}条` : names.join('、') };
  }
  if (text) return { text };
  // 产品库的新建、上架没有改动摘要：写编号（K 页第一条「线路编号 r-guizhou-5d」）
  const entity = first.action.startsWith('catalog.') ? entityOf(pack, first.targetType) : null;
  return entity && first.targetId ? { text: entity.codeLabel, code: first.targetId } : null;
}

/** 一句（单条或合并的一组）写成时间线的一行 */
export function lineOf(run: readonly AuditEntryView[], pack: IndustryPack, lookups: AuditLookups, now: number): TimelineLine {
  const first = run[0]!;
  const d = describeAudit(run.length > 1 ? run : first, pack, lookups);
  return {
    key: first.id,
    entries: [...run],
    actor: d.actor,
    parts: d.parts,
    summary: summaryOf(run, pack, lookups, d.summary),
    time: clockTime(first.at),
    timeTitle: absoluteTime(first.at, now),
    at: first.at,
    count: run.length,
  };
}

/** 按天分组（本机日历日，组标题「今天 · 9月26日 周六」），组里是合并之后的句子，都是新的在前 */
export function timelineGroups(entries: readonly AuditEntryView[], pack: IndustryPack, lookups: AuditLookups, now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const run of auditRuns(entries)) {
    const line = lineOf(run, pack, lookups, now);
    const key = dayKey(line.at);
    const last = groups.at(-1);
    if (last?.key === key) last.lines.push(line);
    else groups.push({ key, heading: dayHeading(line.at, now), lines: [line] });
  }
  return groups;
}

/** 合并那一句的展开按钮 */
export const expandLabel = (line: TimelineLine, open: boolean): string => (open ? '收起' : `展开${line.count}条`);

// ---------------- 详情抽屉 ----------------

/** 抽屉里「字段 · 原来 · 现在」的一格：纯文字，或者行内差异（删去的划线、新加的加底色） */
export type DiffSeg = { text: string; mark?: 'del' | 'ins' };
export type Cell = { text: string } | { segs: DiffSeg[] };

export interface ChangeRow {
  /** 字段名的各段，之间用 Sep：「住宿档次」「行程亮点第2条」「逐日行程第3天 · 当天安排」 */
  label: string[];
  before: Cell;
  after: Cell;
}

export interface ChangeTable {
  /** 「改了2处」「填了12项」 */
  title: string;
  /** 新建只有「字段 · 内容」两栏，其余是「字段 · 原来 · 现在」 */
  created: boolean;
  rows: ChangeRow[];
  /** 表格下面的说明：行内差异怎么读、有序子项其余几条没改、认不出的字段 */
  notes: string[];
}

export interface Fact {
  label: string;
  text: string;
  /** 跟在文字后面、用 Sep 隔开的等宽编号 */
  code?: string;
}

/**
 * 抽屉的去处：产品库的一条到它的详情（条目删了照样链过去，由详情页写「没有这条{实体名}」）；
 * 话术到这条记录生成的那一版的「查看改动」（话术页地址上的 v，看它相对前一版改了什么），没有版本的（丢弃草稿）v 是 null，到话术页
 */
export type DrawerLink = { to: 'catalog'; kind: string; code: string; label: string } | { to: 'sop'; v: number | null; label: string };

export interface DrawerView {
  actor: { name: string; human: boolean };
  parts: AuditPart[];
  tail: string | null;
  facts: Fact[];
  changes: ChangeTable | null;
  warning: { title: string; text: string } | null;
  link: DrawerLink | null;
  /** 技术详情：动作编码、对象类型与编号；JSON 原文与复制的内容 */
  tech: { rows: [string, string][]; json: unknown; copy: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const strOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const pairOf = (v: unknown): [unknown, unknown] | null => (Array.isArray(v) && v.length === 2 ? [v[0], v[1]] : null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/**
 * 按「a.b」这样的路径取嵌套对象里的值；路径中途不是对象时是 undefined。不用 pack.ts 的 valueAt：它在运行时 import 产品库的
 * schema（zod），审计页的块会因此多下载二十多 KB
 */
export const valueAtPath = (v: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (isRecord(o) && Object.hasOwn(o, k) ? o[k] : undefined), v);
const at = valueAtPath;
const empty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
/** 只有一个 key 为空串的子字段：每项就是一个值（行程亮点这类 string[]） */
const singleItem = (f: FieldDef): boolean => f.item?.length === 1 && f.item[0]!.key === '';
const noun = (f: FieldDef): string => f.itemNoun ?? '项';

/** 金额的单位：写了 unit 就是它；unitFrom 取同一条记录另一个字段的值（diff 里有才知道），不知道时写「元」 */
function unitOf(f: FieldDef, row: Record<string, unknown>): string {
  if (f.unit) return f.unit;
  const u = f.unitFrom === undefined ? undefined : at(row, f.unitFrom);
  return typeof u === 'string' && u ? `元/${u}` : '元';
}

/**
 * 一个值按字段类型写成字：金额「42,800元」、带单位的整数「8天」、数组用「、」连起来；空的写「—」。
 * 月份区间与引用和字段渲染器写得一样（ADR-004：全站同一种字段长得一样）：月份区间「4–10月」，「全年」写包里的 yearRoundLabel；
 * 按编号存的引用写目标条目的名字（lookups，与侧栏、⌘K 共用的产品库缓存），缓存里没有时写编号
 */
export function valueText(f: FieldDef, v: unknown, row: Record<string, unknown> = {}, lookups: AuditLookups = {}): string {
  if (empty(v)) return '—';
  const join = (a: unknown[]): string => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('、');
  switch (f.type) {
    case 'money':
      return typeof v === 'number' ? money(v, unitOf(f, row)) : String(v);
    case 'intUnit':
      return typeof v === 'number' ? quantity(v, f.unit ?? '') : String(v);
    case 'boolean':
      return v === true ? (f.trueLabel ?? '是') : v === false ? (f.falseLabel ?? '否') : String(v);
    case 'subItems':
      if (!Array.isArray(v)) return String(v);
      return singleItem(f) ? join(v) : quantity(v.length, noun(f));
    case 'status':
      return v === 'active' ? STATUS_LABEL.active : v === 'draft' ? STATUS_LABEL.draft : String(v);
    case 'monthRange': {
      // 规则之外的写法、画不出月份的（「13月」）照原文写，不写成「—」丢掉原来的字
      const range = typeof v === 'string' ? parseMonthRange(v) : null;
      const words = range && monthRangeText(range, f.yearRoundLabel);
      return words && words !== '—' ? words : typeof v === 'string' ? v : JSON.stringify(v);
    }
    case 'reference': {
      const name = (x: unknown): string =>
        typeof x !== 'string' ? JSON.stringify(x) : (f.store !== 'label' && f.to && lookups.itemName?.(f.to, x)) || x;
      return Array.isArray(v) ? v.map(name).join('、') : name(v);
    }
    default:
      if (Array.isArray(v)) return join(v);
      if (typeof v === 'number') return digits(v);
      return typeof v === 'string' ? v : JSON.stringify(v);
  }
}

/** 按码位算最长公共子序列的上限（两段文字长度之积）：超过就只比头尾，中间整段算改了 */
const DIFF_CELLS = 250_000;

/**
 * 行内差异（设计系统 §6.5）：按字比，删去的在「原来」里划线，新加的在「现在」里加底色。先去掉相同的头尾，中间按最长公共子序列比；
 * 两处改动之间只隔一个相同的字时，把它并进改动里，读起来是整词换整词
 */
export function charDiff(a: string, b: string): { before: DiffSeg[]; after: DiffSeg[] } {
  const x = Array.from(a);
  const y = Array.from(b);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head += 1;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail += 1;
  const xm = x.slice(head, x.length - tail);
  const ym = y.slice(head, y.length - tail);
  type Op = { k: 'eq' | 'del' | 'ins'; c: string };
  const ops: Op[] = x.slice(0, head).map((c) => ({ k: 'eq', c }));
  if (xm.length * ym.length > DIFF_CELLS) {
    ops.push(...xm.map((c): Op => ({ k: 'del', c })), ...ym.map((c): Op => ({ k: 'ins', c })));
  } else {
    // lcs[i][j]：xm[i..] 与 ym[j..] 的最长公共子序列长度
    const w = ym.length + 1;
    const lcs = new Uint32Array((xm.length + 1) * w);
    for (let i = xm.length - 1; i >= 0; i -= 1) {
      for (let j = ym.length - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = xm[i] === ym[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < xm.length || j < ym.length) {
      if (i < xm.length && j < ym.length && xm[i] === ym[j]) {
        ops.push({ k: 'eq', c: xm[i]! });
        i += 1;
        j += 1;
      } else if (j >= ym.length || (i < xm.length && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
        ops.push({ k: 'del', c: xm[i]! });
        i += 1;
      } else {
        ops.push({ k: 'ins', c: ym[j]! });
        j += 1;
      }
    }
  }
  ops.push(...x.slice(x.length - tail).map((c): Op => ({ k: 'eq', c })));
  // 夹在两处改动之间的单个相同字并进改动（原来与现在两边各算一次）
  for (let n = 1; n < ops.length - 1; n += 1) {
    if (ops[n]!.k !== 'eq' || ops[n - 1]!.k === 'eq' || ops[n + 1]!.k === 'eq') continue;
    const c = ops[n]!.c;
    ops.splice(n, 1, { k: 'del', c }, { k: 'ins', c });
    n += 1;
  }
  const side = (keep: 'del' | 'ins'): DiffSeg[] => {
    const segs: DiffSeg[] = [];
    for (const o of ops) {
      if (o.k !== 'eq' && o.k !== keep) continue;
      const mark = o.k === 'eq' ? undefined : keep;
      const last = segs.at(-1);
      if (last && last.mark === mark) last.text += o.c;
      else segs.push(mark ? { text: o.c, mark } : { text: o.c });
    }
    return segs;
  };
  return { before: side('del'), after: side('ins') };
}

type PairOp =
  | { k: 'same'; i: number; j: number }
  | { k: 'changed'; i: number; j: number }
  | { k: 'removed'; i: number }
  | { k: 'added'; j: number };

/**
 * 有序子项前后两版逐项对上：没变的项按最长公共子序列对齐（中间插了一条，后面的不算改了），两段没变的之间按位置配对算「改了」，
 * 多出来的算新加或删去。ignore 是比较时不看的子字段：自动编号（逐日行程的 day）随增删重排，中间插一天后面每天的编号都变，
 * 看它的话后面每一天都成了「改了」
 */
export function pairItems(a: readonly unknown[], b: readonly unknown[], ignore?: string): PairOp[] {
  const keyOf = (v: unknown): string =>
    JSON.stringify(ignore !== undefined && isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== ignore)) : v);
  const ka = a.map(keyOf);
  const kb = b.map(keyOf);
  const w = kb.length + 1;
  const lcs = new Uint32Array((ka.length + 1) * w);
  for (let i = ka.length - 1; i >= 0; i -= 1) {
    for (let j = kb.length - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = ka[i] === kb[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const ops: PairOp[] = [];
  let i = 0;
  let j = 0;
  let gapA: number[] = [];
  let gapB: number[] = [];
  const flush = (): void => {
    const n = Math.min(gapA.length, gapB.length);
    for (let k = 0; k < n; k += 1) ops.push({ k: 'changed', i: gapA[k]!, j: gapB[k]! });
    for (const x of gapA.slice(n)) ops.push({ k: 'removed', i: x });
    for (const y of gapB.slice(n)) ops.push({ k: 'added', j: y });
    gapA = [];
    gapB = [];
  };
  while (i < ka.length || j < kb.length) {
    if (i < ka.length && j < kb.length && ka[i] === kb[j]) {
      flush();
      ops.push({ k: 'same', i, j });
      i += 1;
      j += 1;
    } else if (j >= kb.length || (i < ka.length && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      gapA.push(i);
      i += 1;
    } else {
      gapB.push(j);
      j += 1;
    }
  }
  flush();
  return ops;
}

/** 字符串两边都有、要行内比的：长文本，和有序子项里的一条 */
const diffCell = (a: string, b: string): { before: Cell; after: Cell } => {
  const d = charDiff(a, b);
  return { before: { segs: d.before }, after: { segs: d.after } };
};

interface RowsOut {
  rows: ChangeRow[];
  /** 有序子项里没变的项数（「其余3条没改」） */
  untouched: { label: string; n: number; noun: string }[];
  unknown: number;
}

/** 一个值的格：长文本两边都有字时行内比 */
function cellPair(
  f: FieldDef,
  was: unknown,
  now: unknown,
  rows: [Record<string, unknown>, Record<string, unknown>],
  inline: boolean,
  lookups: AuditLookups,
) {
  if (inline && typeof was === 'string' && typeof now === 'string' && was && now) return diffCell(was, now);
  return { before: { text: valueText(f, was, rows[0], lookups) }, after: { text: valueText(f, now, rows[1], lookups) } };
}

/** 有序子项的逐项改动 */
function itemRows(f: FieldDef, was: unknown, now: unknown, out: RowsOut, lookups: AuditLookups): void {
  const a = Array.isArray(was) ? was : [];
  const b = Array.isArray(now) ? now : [];
  const label = (n: number): string => `${f.label}第${n + 1}${noun(f)}`;
  const subs = (f.item ?? []).filter((s) => s.key !== '' && s.key !== f.autoIndexKey);
  const single = singleItem(f);
  const item = f.item?.[0];
  /** 整项的一句话：单个子字段就是它的值；多个子字段取第一个有字的文本子字段（当天标题） */
  const whole = (el: unknown): string => {
    if (single && item) return valueText(item, el, {}, lookups);
    const title = subs.find((s) => (s.type === 'text' || s.type === 'longText') && strOf(at(el, s.key)));
    return title ? valueText(title, at(el, title.key)) : '—';
  };
  let kept = 0;
  let touched = false;
  for (const op of pairItems(a, b, single ? undefined : f.autoIndexKey)) {
    if (op.k === 'same') {
      kept += 1;
      continue;
    }
    touched = true;
    if (op.k === 'added') {
      out.rows.push({ label: [label(op.j)], before: { text: '—' }, after: { text: whole(b[op.j]) } });
      continue;
    }
    if (op.k === 'removed') {
      out.rows.push({ label: [label(op.i)], before: { text: whole(a[op.i]) }, after: { text: '—' } });
      continue;
    }
    const x = a[op.i];
    const y = b[op.j];
    if (single && item) {
      const c = cellPair(item, x, y, [{}, {}], item.type === 'text' || item.type === 'longText', lookups);
      out.rows.push({ label: [label(op.j)], ...c });
      continue;
    }
    if (!isRecord(x) || !isRecord(y)) {
      out.rows.push({ label: [label(op.j)], before: { text: whole(x) }, after: { text: whole(y) } });
      continue;
    }
    for (const s of subs) {
      if (same(at(x, s.key), at(y, s.key))) continue;
      out.rows.push({
        label: [label(op.j), s.label],
        ...cellPair(s, at(x, s.key), at(y, s.key), [x, y], s.type === 'longText', lookups),
      });
    }
    const known = new Set([...subs.map((s) => s.key), ...(f.autoIndexKey ? [f.autoIndexKey] : [])]);
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!known.has(k) && !same(x[k], y[k])) out.unknown += 1;
  }
  if (touched && kept) out.untouched.push({ label: f.label, n: kept, noun: noun(f) });
}

/**
 * 产品库 diff（顶层键 → [原来, 现在]）写成改动表，按行业包里字段的顺序：`id` 是编号；嵌套对象（intensity）逐个比包里的子字段；
 * 有序子项逐项比（pairItems）；长文本行内比。包里没有的键不写原名，算进「另N项」，原文在技术详情里
 */
export function changeRows(entity: EntityType | null, diff: Readonly<Record<string, unknown>>, lookups: AuditLookups = {}): RowsOut {
  const out: RowsOut = { rows: [], untouched: [], unknown: 0 };
  const fields = entity?.fields ?? [];
  const pairs = Object.entries(diff).flatMap(([k, v]) => {
    const p = pairOf(v);
    if (!p) out.unknown += 1;
    return p ? [[k, p] as const] : [];
  });
  // 两边的「整条」：金额的单位按 unitFrom 取另一个字段时用
  const sides: [Record<string, unknown>, Record<string, unknown>] = [
    Object.fromEntries(pairs.map(([k, p]) => [k, p[0]])),
    Object.fromEntries(pairs.map(([k, p]) => [k, p[1]])),
  ];
  const placed = new Set<string>();
  for (const f of fields) {
    const top = f.key === '$code' ? 'id' : f.key.split('.')[0]!;
    const hit = pairs.find(([k]) => k === top);
    if (!hit) continue;
    const [, [was, now]] = hit;
    if (f.key === top || f.key === '$code') {
      placed.add(top);
      if (f.type === 'subItems' && (Array.isArray(was) || Array.isArray(now)) && !empty(was)) itemRows(f, was, now, out, lookups);
      else out.rows.push({ label: [f.label], ...cellPair(f, was, now, sides, f.type === 'longText', lookups) });
      continue;
    }
    // 嵌套字段：只写真正变了的子字段；两边都不是对象（形状认不出）时整个算认不出
    if (!(isRecord(was) || was === null) || !(isRecord(now) || now === null)) continue;
    placed.add(top);
    const sub = f.key.slice(top.length + 1);
    if (!same(at(was, sub), at(now, sub)))
      out.rows.push({ label: [f.label], ...cellPair(f, at(was, sub), at(now, sub), sides, f.type === 'longText', lookups) });
  }
  for (const [k] of pairs) if (!placed.has(k)) out.unknown += 1;
  return out;
}

const CATALOG_CHANGES = new Set(['catalog.create', 'catalog.update', 'catalog.locked_fix']);
/** 上架那一行的字段名：系统字段 $status 的叫法（设计系统 §6 的 status 类型） */
const STATUS_LABEL_FIELD = '状态';
const STATUS_FIELD: FieldDef = { key: '$status', type: 'status', label: STATUS_LABEL_FIELD, group: '' };

/** 改动表：产品库的新建、修改、修正；上架是一行「状态」 */
function changeTable(entry: AuditEntryView, entity: EntityType | null, lookups: AuditLookups): ChangeTable | null {
  const diff = isRecord(entry.diff) ? entry.diff : {};
  if (entry.action === 'catalog.activate') {
    const p = pairOf(diff.status);
    if (!p) return null;
    const row = {
      label: [STATUS_LABEL_FIELD],
      before: { text: valueText(STATUS_FIELD, p[0]) },
      after: { text: valueText(STATUS_FIELD, p[1]) },
    };
    return { title: '改了1处', created: false, rows: [row], notes: [] };
  }
  if (!CATALOG_CHANGES.has(entry.action)) return null;
  // 修正（catalog-fix）的 diff 另带 reason：它是原因，不是字段，写在上面的「原因」里
  const fieldsDiff = Object.fromEntries(Object.entries(diff).filter(([k]) => k !== 'reason'));
  const out = changeRows(entity, fieldsDiff, lookups);
  if (entry.action === 'catalog.create') {
    // 新建：只列填了的，「原来」都是空的，只画「字段 · 内容」两栏；有序子项整个写一格（「5天」「a、b、c」）
    const now = Object.fromEntries(Object.entries(fieldsDiff).map(([k, x]) => [k, pairOf(x)?.[1]]));
    const rows: ChangeRow[] = [];
    for (const f of entity?.fields ?? []) {
      const top = f.key === '$code' ? 'id' : f.key.split('.')[0]!;
      const v = f.key === top || f.key === '$code' ? now[top] : at(now[top], f.key.slice(top.length + 1));
      if (!empty(v)) rows.push({ label: [f.label], before: { text: '—' }, after: { text: valueText(f, v, now, lookups) } });
    }
    const notes = out.unknown ? [`另${out.unknown}项见技术详情`] : [];
    return rows.length ? { title: `填了${rows.length}项`, created: true, rows, notes } : null;
  }
  const inline = out.rows.some((r) => 'segs' in r.before || 'segs' in r.after);
  const notes = [
    ...(inline ? ['划线的字是删去的，加底色的字是新加的'] : []),
    ...out.untouched.map((u) => `${u.label}其余${u.n}${u.noun}没改`),
    ...(out.unknown ? [`另${out.unknown}项见技术详情`] : []),
  ];
  const n = out.rows.length + out.unknown;
  return n ? { title: `改了${n}处`, created: false, rows: out.rows, notes } : null;
}

/**
 * 详情抽屉写什么：句子（一行写完，带补充）、时间、操作者、对象；产品库的改动表；回滚结果与目标版本不同的提醒；
 * 去处（产品库那一条，或话术的那一版）；技术详情。操作者的角色审计记录里没有（spec 顶部第 14 步的 Revisions），只写名字
 */
export function drawerView(entry: AuditEntryView, pack: IndustryPack, lookups: AuditLookups): DrawerView {
  const d = describeAudit(entry, pack, lookups);
  const diff = isRecord(entry.diff) ? entry.diff : {};
  const entity = entry.action.startsWith('catalog.') ? entityOf(pack, entry.targetType) : null;
  const actor = auditActor(entry);
  const facts: Fact[] = [
    { label: '时间', text: fullTime(entry.at) },
    { label: '操作者', text: actor.name },
  ];
  // 话术记录生成、成为线上的那一版：发布是 versionNo，回滚与重新生成是 toVersionNo（回滚的目标 targetVersionNo 是旧版，不是它）
  const sopV = entry.action.startsWith('sop.') ? intOf(entry.action === 'sop.publish' ? diff.versionNo : diff.toVersionNo) : null;
  if (entity && entry.targetId) facts.push({ label: '对象', text: entity.label, code: entry.targetId });
  else if (entry.action.startsWith('sop.')) facts.push({ label: '对象', text: sopV === null ? '话术' : `话术v${sopV}` });
  const reason = entry.action === 'catalog.locked_fix' ? strOf(diff.reason) : null;
  if (reason) facts.push({ label: '原因', text: reason });

  let warning: DrawerView['warning'] = null;
  if (entry.action === 'sop.rollback' && diff.sameHashAsTarget === false) {
    const target = intOf(diff.targetVersionNo);
    const v = target === null ? '目标版本' : `v${target}`;
    warning = {
      title: `回滚结果与${v}不完全一样`,
      text: `${v}之后固定要求、固定规则节或工具定义改过：回滚只换回可编辑的节，这几部分用的是回滚时的内容`,
    };
  }

  const link: DrawerLink | null =
    entity && entry.targetId
      ? { to: 'catalog', kind: entity.kind, code: entry.targetId, label: `打开这条${entity.label}` }
      : entry.action.startsWith('sop.')
        ? { to: 'sop', v: sopV, label: '打开销售话术' }
        : null;

  const target = [entry.targetType, entry.targetId].filter((x) => x !== null).join(' · ');
  // JSON 原文按接口的字段顺序
  const json = {
    id: entry.id,
    at: entry.at,
    actorKind: entry.actorKind,
    actorName: entry.actorName,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    diff: entry.diff,
  };
  return {
    actor: d.actor,
    parts: d.parts,
    tail: d.tail,
    facts,
    changes: changeTable(entry, entity, lookups),
    warning,
    link,
    tech: {
      rows: [['动作', entry.action], ...(target ? [['对象', target] as [string, string]] : []), ['记录', `#${entry.id}`]],
      json,
      copy: JSON.stringify(json, null, 2),
    },
  };
}
