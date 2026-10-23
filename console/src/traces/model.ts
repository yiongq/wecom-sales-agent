// AI 记录页的纯逻辑（07 spec R24）：地址里的筛选换算成 GET /traces 的参数、筛选项、每一行写什么、空状态的去向。
// 不依赖 React，traces.selftest.tsx 直接 import。
// 地址里的取值（结果、护栏、转人工原因）按真实的表再筛一遍：认不得的当没写，不发给接口（接口对不认识的取值回 400）。
// 界面不认行业：会话标签的客户叫法取自行业包；结果、护栏、转人工原因的中文在 src/shared（ui-labels.ts、conversation.ts），步骤 id 不上页面（不变量 7）。
import { TRACE_OUTCOMES, type TraceOutcome, type TracePage, type TraceRow } from '../../../src/shared/console-api.js';
import { HANDOFF_NOTICE_TEXT } from '../../../src/shared/conversation.js';
import { isHandoffKind, type HandoffKind } from '../../../src/shared/conversation-types.js';
import { absoluteTime, relativeTime } from '../../../src/shared/format.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { GUARD_STEP_LABEL, guardLabel, TURN_OUTCOME_LABEL } from '../../../src/shared/ui-labels.js';
import type { TracesSearch } from '../traces-search.js';
import { conversationLabel } from '../shell/model.js';

/** 每次取多少条（接口上限 100）；「加载更早的记录」再取一页 */
export const TRACE_PAGE = 50;

// ---------------- 时间段 ----------------

export type TraceRange = NonNullable<TracesSearch['range']> | '7d';

/** 时间段按钮：key 7d 是默认（地址里不写），all 不设下限 */
export const RANGES: readonly { key: TraceRange; label: string; ms: number | null }[] = [
  { key: '1d', label: '近24小时', ms: 24 * 3_600_000 },
  { key: '7d', label: '近7天', ms: 7 * 24 * 3_600_000 },
  { key: '30d', label: '近30天', ms: 30 * 24 * 3_600_000 },
  { key: 'all', label: '全部', ms: null },
];

export const rangeOf = (search: TracesSearch): TraceRange => search.range ?? '7d';

// ---------------- 筛选 ----------------

/** 地址里的筛选，按真实的表筛过一遍 */
export interface TraceFilters {
  range: TraceRange;
  outcome?: TraceOutcome;
  guard?: string;
  handoff?: HandoffKind;
  over: boolean;
}

const OUTCOME_SET: ReadonlySet<string> = new Set(TRACE_OUTCOMES);

export function filtersOf(search: TracesSearch): TraceFilters {
  return {
    range: rangeOf(search),
    ...(search.outcome !== undefined && OUTCOME_SET.has(search.outcome) ? { outcome: search.outcome as TraceOutcome } : {}),
    ...(search.guard !== undefined && Object.hasOwn(GUARD_STEP_LABEL, search.guard) ? { guard: search.guard } : {}),
    ...(search.handoff !== undefined && isHandoffKind(search.handoff) ? { handoff: search.handoff } : {}),
    over: search.over === 1,
  };
}

/** 除时间段以外有没有筛选 */
export const hasRowFilters = (f: TraceFilters): boolean =>
  f.outcome !== undefined || f.guard !== undefined || f.handoff !== undefined || f.over;

/**
 * 接口的查询串（值都是字符串）。since 在取数的那一刻按「现在」往前推，不是页面打开的那一刻：翻页时的下限最多晚几秒，只会少看到边缘上的几行，
 * 不会重复或错位（游标 before 管住上界）
 */
export interface TracesQueryParams {
  limit: string;
  since?: string;
  outcome?: TraceOutcome;
  guard?: string;
  handoffKind?: HandoffKind;
  overLimit?: '1';
  before?: string;
}
export function queryOf(f: TraceFilters, now: number, before?: string): TracesQueryParams {
  const ms = RANGES.find((r) => r.key === f.range)?.ms ?? null;
  return {
    limit: String(TRACE_PAGE),
    ...(ms === null ? {} : { since: new Date(now - ms).toISOString() }),
    ...(f.outcome === undefined ? {} : { outcome: f.outcome }),
    ...(f.guard === undefined ? {} : { guard: f.guard }),
    ...(f.handoff === undefined ? {} : { handoffKind: f.handoff }),
    ...(f.over ? { overLimit: '1' as const } : {}),
    ...(before === undefined ? {} : { before }),
  };
}

/** 筛选变了地址怎么写：时间段默认（7d）不写，空的筛选不写 */
export function withFilter(search: TracesSearch, patch: Partial<Record<keyof TracesSearch, string | number | undefined>>): TracesSearch {
  const next: Record<string, unknown> = { ...search, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '' || next[k] === false) delete next[k];
  if (next.range === '7d') delete next.range;
  return next as TracesSearch;
}

export interface Option {
  value: string;
  label: string;
}
export const OUTCOME_OPTIONS: readonly Option[] = TRACE_OUTCOMES.map((v) => ({ value: v, label: TURN_OUTCOME_LABEL[v] }));
/** 护栏筛选：按名字排，同名的（链接补全的两步）都留着，选哪个就按哪个步骤过滤 */
export const GUARD_OPTIONS: readonly Option[] = Object.entries(GUARD_STEP_LABEL).map(([value, label]) => ({ value, label }));
export const HANDOFF_OPTIONS: readonly Option[] = (Object.keys(HANDOFF_NOTICE_TEXT) as (keyof typeof HANDOFF_NOTICE_TEXT)[])
  .filter((k): k is HandoffKind => isHandoffKind(k))
  .map((value) => ({ value, label: HANDOFF_NOTICE_TEXT[value] }));

// ---------------- 空状态的去向 ----------------

/**
 * 没有记录时的链接（页面状态：空）：有筛选就是「清空筛选」回到默认（近 7 天、没有别的筛选）；什么都没筛、默认的近 7 天里没有时，
 * 「看全部时间」把时间段放开；已经是全部时间且没有别的筛选就没有可清的
 */
export function emptyLink(f: TraceFilters): { label: string; search: TracesSearch } | null {
  if (hasRowFilters(f) || f.range === '1d' || f.range === '30d') return { label: '清空筛选', search: {} };
  if (f.range === '7d') return { label: '看全部时间', search: { range: 'all' } };
  return null;
}

// ---------------- 一行 ----------------

export interface TraceRowView {
  key: string;
  conversationId: string;
  /** 「企微客户」与短码，中间用 Sep 隔开 */
  label: [string, string];
  /** 相对时间；悬停是绝对时间 */
  when: string;
  whenFull: string;
  at: string;
  outcome: string;
  /** 触发的护栏：前两个的中文，更多的写「等N项」；没有为「—」 */
  guards: string;
  guardsFull: string;
  handoff: string | null;
  overLimit: boolean;
  took: string;
}

/** 耗时：不到 1 秒写毫秒，其余写秒（一位小数） */
export const tookText = (ms: number): string => (ms < 1000 ? `${Math.max(0, Math.round(ms))}毫秒` : `${(ms / 1000).toFixed(1)}秒`);

/** 一行里「触发的护栏」那一格：同名的合并，前两个写出来，更多的写「等N项」 */
export function guardsText(ids: readonly string[]): { short: string; full: string } {
  const names = [...new Set(ids.map(guardLabel))];
  if (!names.length) return { short: '—', full: '' };
  const full = names.join('、');
  return { short: names.length > 2 ? `${names.slice(0, 2).join('、')}等${names.length}项` : full, full };
}

export function rowView(r: TraceRow, pack: IndustryPack, now: number): TraceRowView {
  const g = guardsText(r.guards);
  return {
    key: r.turnId,
    conversationId: r.conversationId,
    label: conversationLabel({ id: r.conversationId, channel: r.channel }, pack),
    when: relativeTime(r.startedAt, now),
    whenFull: absoluteTime(r.startedAt, now),
    at: r.startedAt,
    outcome: TURN_OUTCOME_LABEL[r.outcome],
    guards: g.short,
    guardsFull: g.full,
    handoff: r.handoffKind === null ? null : HANDOFF_NOTICE_TEXT[r.handoffKind],
    overLimit: r.overLimit,
    took: tookText(r.durationMs),
  };
}

/** 读屏念的一行：「企微客户 7F3A，8分钟前，转人工」 */
export const rowAria = (v: TraceRowView): string => `${v.label.join(' ')}，${v.when}，${v.outcome}`;

/** 把已取到的几页拼成一张表 */
export const rowsOfPages = (pages: readonly TracePage[] | undefined): TraceRow[] => pages?.flatMap((p) => p.items) ?? [];

/** 文件存储下 /traces 回 503 store_file_mode：页面写一句说明，不是出错 */
export const FILE_STORE_TITLE = 'AI记录只在会话入库后才有';
