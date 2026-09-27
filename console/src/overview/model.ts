// 总览的纯逻辑（spec「逐页设计 · 总览（A 页）」，设计系统 §5.10、§5.11、§6.7、§10.2 A 页）：把接口的数据排成
// 「需要你处理」的待办行、系统状态、四个业务数、「客户停在哪一步」的阶段条和「最近变更」的时间线。不依赖 React，
// overview.selftest.tsx 直接 import。
// 界面不认行业：实体名、图标、阶段名和顺序、话术节名、客户与产品的叫法都取自 /pack 下发的行业包；
// 会话状态只经 conversationState 判定（不变量 17），数字都来自同一次 counts 响应（不变量 18）。
// 首页面向老板：不写工具原名、字段原名，原名只在话术编辑器里出现
import type {
  AuditEntryView,
  CatalogItem,
  ContractViolation,
  ConversationCounts,
  ConversationRow,
  DraftCheck,
  SopOverview,
  Status,
  ViolationCode,
} from '../../../src/shared/console-api.js';
import { auditRuns, describeAudit, type AuditLookups, type AuditPart } from '../../../src/shared/audit-text.js';
import { absoluteTime, clockTime, dateText, dayKey, dayTime, relativeTime } from '../../../src/shared/format.js';
import { checkItem, type CheckIssue, type EntityType, type IndustryPack, valueAt } from '../../../src/shared/pack.js';
import { sectionBody, SopStructureError } from '../../../src/shared/sop-sections.js';
import { SOP_CHECKS } from '../../../src/shared/ui-labels.js';
import { conversationLabel } from '../shell/model.js';

// ---------------- 共用 ----------------

/** 上下文或明细里的一段；各段之间用 Sep 隔开。tone 为 danger 的那段用 danger 字，前面加 circle-alert（设计系统 §5.11） */
export interface Segment {
  text: string;
  tone?: 'danger';
}

/** 会话的渠道：待办行的上下文写它；认不出的渠道不写（不把原码显示出来） */
const CHANNEL_LABEL: Readonly<Record<string, string>> = { wecom: '企业微信', simulator: '网页' };
export const channelLabel = (channel: string): string | null => (Object.hasOwn(CHANNEL_LABEL, channel) ? CHANNEL_LABEL[channel]! : null);

const byTime = (a: { updatedAt: string }, b: { updatedAt: string }): number => Date.parse(a.updatedAt) - Date.parse(b.updatedAt);

/** 更新时间（设计系统 §10.0 修正 9：分不出新建还是更新，一律写「更新于」）：今天写时刻，昨天「昨天13:40」，更早写日期加时刻 */
export function updatedWhen(at: string, now: number): string {
  const today = dayKey(now);
  if (dayKey(at) === today) return clockTime(at);
  if (dayKey(at) === dayKey(new Date(now).setHours(0, 0, 0, 0) - 1)) return `昨天${clockTime(at)}`;
  return absoluteTime(at, now);
}

/** 「小林更新于13:40」；没有更新人时只写「更新于13:40」 */
export const updatedBy = (name: string | null, at: string, now: number): string => `${name ?? ''}更新于${updatedWhen(at, now)}`;

/**
 * 上架前检查的一条问题写成一句（接在「必须项12/13：」「建议1条没做：」后面）：字段名接 message，有序子项取中文路径的后两段，
 * 「逐日行程 · 第3天 · 当晚住宿」「没填」→「第3天当晚住宿没填」
 */
export function issueText(issue: CheckIssue): string {
  const parts = issue.label.split(' · ');
  return `${parts.slice(-2).join('')}${issue.message}`;
}

/** 条目的名称：行业包 titleKey 的值，没有时用编号 */
export function itemTitle(entity: EntityType, item: Pick<CatalogItem, 'code' | 'payload'>): string {
  const v = valueAt(item.payload as unknown as Record<string, unknown>, entity.titleKey);
  return typeof v === 'string' && v.trim() ? v : item.code;
}

// ---------------- 需要你处理 ----------------

export type TodoTarget =
  /** 新标签打开工作台（admin.html） */
  | { kind: 'workbench'; href: string }
  | { kind: 'sop' }
  /** 这个实体的列表；详情路由在第 10 步，在那之前「去上架」也打开列表 */
  | { kind: 'catalog'; entity: string; code?: string };

export interface TodoRow {
  key: string;
  /** 图标：会话、话术，或行业包给实体配的图标名 */
  icon: { page: 'conversations' | 'sop' } | { entity: string };
  /** 类型：「等人接手」画状态胶囊，其余是 13/500 text-3 的文字 */
  type: { status: 'human' } | { text: string };
  /** 第一行（对象）；数组时各段用 Sep 隔开 */
  title: string | readonly string[];
  context: Segment[];
  action: string;
  target: TodoTarget;
}

/**
 * 等人接手的会话：最后动静早的在前（设计系统 §10.0 修正 1：A01 26分钟前排在 F01 8分钟前前面）。
 * 上下文只写接口里有的：渠道、消息条数、「最后动静26分钟前」；今天没有转人工时间，不写「等了多久」
 */
export function waitingTodos(
  rows: readonly ConversationRow[],
  pack: IndustryPack,
  now: number,
  workbench: (id: string) => string,
): TodoRow[] {
  return [...rows]
    .sort((a, b) => byTime(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => {
      const channel = channelLabel(row.channel);
      return {
        key: `conv:${row.id}`,
        icon: { page: 'conversations' },
        type: { status: 'human' },
        title: conversationLabel(row, pack),
        context: [
          ...(channel ? [{ text: channel }] : []),
          { text: `${row.messageCount}条消息` },
          { text: `最后动静${relativeTime(row.updatedAt, now)}` },
        ],
        action: '打开工作台',
        target: { kind: 'workbench', href: workbench(row.id) },
      };
    });
}

/** 话术节的中文名：行业包 sopSections 的 heading，前言写「前言」；包里没有这一节时用接口节表的标题 */
function sectionName(pack: IndustryPack, sop: Pick<SopOverview, 'spec'> | null, key: string): string {
  const s = pack.sopSections.find((x) => x.key === key) ?? sop?.spec.find((x) => x.key === key);
  return s ? (s.heading ?? '前言') : '前言';
}

/** 这一节正文的字数（与额度条同一口径）；草稿里标题被改坏时取整段的长度，不抛 */
function bodyLength(text: string, spec: SopOverview['spec'][number]): number {
  try {
    return sectionBody({ key: spec.key, text }, spec).length;
  } catch (e) {
    if (e instanceof SopStructureError) return text.length;
    throw e;
  }
}

/** 草稿比线上改了哪些可编辑节、各差多少字 */
export function sopChanges(sop: SopOverview): Array<{ key: string; delta: number }> {
  const draft = sop.draft;
  if (!draft) return [];
  const textOf = (sections: SopOverview['published']['sections'], key: string): string | undefined =>
    sections.find((s) => s.key === key)?.text;
  return sop.spec
    .filter((s) => !s.locked)
    .flatMap((s) => {
      const was = textOf(sop.published.sections, s.key) ?? '';
      const now = textOf(draft.sections, s.key) ?? '';
      return was === now ? [] : [{ key: s.key, delta: bodyLength(now, s) - bodyLength(was, s) }];
    });
}

/** 字数差：「+44」「-10」。减号用 ASCII 的「-」：U+2212 不在 Geist 的子集里（设计系统 §2.6），用它会去下长尾分片 */
const signed = (d: number): string => (d > 0 ? `+${d}` : `-${-d}`);

/**
 * 话术检查的一条问题写成老板看得懂的一句，不写工具、字段、短语的原文（原文只在话术编辑器里）：
 * 「话术原则里有个工具名写错了」
 */
export function sopProblemText(v: ContractViolation, pack: IndustryPack, sop: Pick<SopOverview, 'spec'> | null = null): string {
  const sec = v.sectionKey === null ? null : sectionName(pack, sop, v.sectionKey);
  const where = sec === null ? '话术里' : `${sec}里`;
  const text: Record<ViolationCode, string> = {
    structure: sec === null ? '话术的分节被改了' : `${sec}的标题或位置被改了`,
    locked_changed: sec === null ? '固定规则节被改了' : `固定规则节「${sec}」被改了`,
    phrase_missing: `${where}少了一句必备的话`,
    phrase_forbidden: `${where}有不能出现的话`,
    unknown_tool: `${where}有个工具名写错了`,
    unknown_field: `${where}有个字段名写错了`,
    over_budget: '字数超出了额度',
  };
  return Object.hasOwn(text, v.code) ? text[v.code] : `${where}有个问题`;
}

/**
 * 话术草稿这一行：「改了2节：话术原则（+44字）、异议处理（+9字）」；上下文是检查的问题（danger）和「发布前检查6/7通过」。
 * 不写保存时间：接口里没有草稿的最后保存时间（设计系统 §10.0 修正 8，spec 开放问题 6）。check 没取到时只写第一行
 */
export function sopTodo(sop: SopOverview, check: DraftCheck | undefined, pack: IndustryPack): TodoRow | null {
  if (!sop.draft) return null;
  const changes = sopChanges(sop);
  const names = changes.map((c) => `${sectionName(pack, sop, c.key)}${c.delta === 0 ? '' : `（${signed(c.delta)}字）`}`);
  const context: Segment[] = [];
  if (check) {
    const vs = check.violations;
    if (vs.length)
      context.push({ text: `${vs.length}个问题：${sopProblemText(vs[0]!, pack, sop)}${vs.length > 1 ? '等' : ''}`, tone: 'danger' });
    const passed = SOP_CHECKS.filter(([code]) => !vs.some((v) => v.code === code)).length;
    context.push({ text: `发布前检查${passed}/${SOP_CHECKS.length}通过` });
  }
  return {
    key: 'sop',
    icon: { page: 'sop' },
    type: { text: '话术草稿' },
    title: changes.length ? `改了${changes.length}节：${names.join('、')}` : '草稿和线上一样',
    context,
    action: '继续编辑',
    target: { kind: 'sop' },
  };
}

/** 一个实体的列表：成员拿到的带状态、更新人和时间 */
export interface EntityList {
  entity: EntityType;
  items: readonly CatalogItem[];
}

/** 最多列几个草稿的名称（设计系统 A 页第 5 行） */
const NAMES_SHOWN = 3;

/**
 * 待上架：每个实体的草稿一行，按最近一条的更新时间倒序。1 条时写条目名，上下文是更新人、必须项与建议项（checkItem 算）；
 * 多条时合成一行「6条酒店草稿」，上下文列出前 3 个名称
 */
export function catalogTodos(lists: readonly EntityList[], now: number): TodoRow[] {
  const rows: Array<TodoRow & { at: number }> = [];
  for (const { entity, items } of lists) {
    const drafts = items.filter((i) => i.status === 'draft').sort((a, b) => byTime(b, a) || (a.code < b.code ? -1 : 1));
    const latest = drafts[0];
    if (!latest) continue;
    const who: Segment = { text: updatedBy(latest.updatedByName, latest.updatedAt, now) };
    const base = { icon: { entity: entity.icon }, type: { text: '待上架' }, at: Date.parse(latest.updatedAt) };
    if (drafts.length === 1) {
      const c = checkItem(entity, latest.payload as unknown as Record<string, unknown>);
      const need: Segment =
        c.required.length === 0
          ? { text: `必须项${c.requiredPassed}/${c.requiredTotal}已过` }
          : {
              text: `必须项${c.requiredPassed}/${c.requiredTotal}：${issueText(c.required[0]!)}${c.required.length > 1 ? '等' : ''}`,
              tone: 'danger',
            };
      const rec = c.recommended;
      rows.push({
        ...base,
        key: `catalog:${entity.kind}:${latest.code}`,
        title: `${entity.label}草稿「${itemTitle(entity, latest)}」`,
        context: [
          who,
          need,
          ...(rec.length ? [{ text: `建议${rec.length}条没做：${issueText(rec[0]!)}${rec.length > 1 ? '等' : ''}（不拦上架）` }] : []),
        ],
        action: '去上架',
        target: { kind: 'catalog', entity: entity.kind, code: latest.code },
      });
    } else {
      const names = drafts.slice(0, NAMES_SHOWN).map((d) => itemTitle(entity, d));
      rows.push({
        ...base,
        key: `catalog:${entity.kind}`,
        title: `${drafts.length}条${entity.label}草稿`,
        context: [who, { text: `${names.join('、')}${drafts.length > NAMES_SHOWN ? `等${drafts.length}条` : ''}` }],
        action: '逐条检查',
        target: { kind: 'catalog', entity: entity.kind },
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at).map(({ at: _at, ...row }) => row);
}

/** 「需要你处理」的顺序：等人接手的在前（最后动静早的在前），接着是话术草稿，然后是待上架（按更新时间倒序） */
export const todoOrder = (waiting: readonly TodoRow[], sop: TodoRow | null, catalog: readonly TodoRow[]): TodoRow[] => [
  ...waiting,
  ...(sop ? [sop] : []),
  ...catalog,
];

// ---------------- 系统状态 ----------------

export interface SystemAlert {
  tone: 'danger' | 'warning';
  text: string;
  /** 技术详情里的原文 */
  tech?: Array<[string, string]>;
}

export type SystemView = { ok: true; lead: string; rest: string[] } | { ok: false; alerts: SystemAlert[] };

/**
 * 系统状态一行人话（spec「总览 · 系统状态」）：一切正常时「一切正常 · 线上话术v2 · 产品库改动已生效」；出问题时换成 Alert。
 * 产品库的叫法与实体名取自行业包；与代码仓库初始数据的差异（drift）只放在「系统」页，这里不看
 */
export function systemView(s: Status, pack: IndustryPack): SystemView {
  const group = pack.nav.catalogGroup;
  const alerts: SystemAlert[] = [];
  if (s.lock === 'lost') {
    alerts.push({
      tone: 'danger',
      text: `暂时无法保存修改：和数据库的锁连接断开了，系统在自动重连。线上话术和${pack.vocabulary.productNoun}不受影响。`,
    });
  }
  if (s.sopStale || s.catalogStale) {
    const what = s.sopStale && s.catalogStale ? `话术和${group}` : s.sopStale ? '话术' : group;
    alerts.push({ tone: 'warning', text: `${what}的最新修改还没载入运行中的系统，正在自动重试。` });
  }
  if (s.index.stale || s.index.lastError) {
    // 搜索索引建在导航里的第一个实体上（旅游包是线路）；包里没有实体时用「产品」的叫法
    const first = pack.nav.entities.map((k) => pack.entities.find((e) => e.kind === k)).find((e) => e !== undefined);
    const noun = first?.label ?? pack.vocabulary.productNoun;
    alerts.push({
      tone: 'warning',
      text: `${noun}搜索索引在更新，新上架的${noun}可能暂时搜不到。`,
      ...(s.index.lastError ? { tech: [['index.lastError', s.index.lastError]] } : {}),
    });
  }
  if (alerts.length) return { ok: false, alerts };
  return { ok: true, lead: '一切正常', rest: [`线上话术v${s.sop.versionNo}`, `${group}改动已生效`] };
}

// ---------------- 业务数 ----------------

export type KpiTarget =
  | { kind: 'conversations'; state?: 'human' | 'paid' }
  /** 实体的列表（第一个实体）；在售数为 0 时明细是「新建{实体名}」 */
  | { kind: 'catalog'; entity: string };

export interface Kpi {
  key: 'conversations' | 'waiting' | 'paid' | 'inSale';
  label: string;
  value: number;
  /** 口径：一句话；数组时各段用 Sep 隔开 */
  caption: readonly string[];
  /** 明细行：这个数背后的真实构成；null 时不画明细（匿名的在售格） */
  breakdown: readonly string[] | null;
  /** 在售数为 0 时，编辑者的明细是一个「新建{实体名}」链接 */
  create?: { entity: string; label: string };
  target: KpiTarget;
}

/** 在售格要的数：各实体已上架与草稿的条数 */
export function catalogCounts(lists: readonly { entity: EntityType; items: readonly { code: string; status?: 'draft' | 'active' }[] }[]) {
  // 匿名投影里没有状态：匿名只拿得到已上架的条目
  return lists.map(({ entity, items }) => ({
    entity,
    active: items.filter((i) => i.status !== 'draft').length,
    drafts: items.filter((i) => i.status === 'draft').length,
  }));
}

export function inSaleKpi(counts: ReturnType<typeof catalogCounts>, pack: IndustryPack, who: { anon: boolean; editor: boolean }): Kpi {
  const value = counts.reduce((n, c) => n + c.active, 0);
  const drafts = counts.reduce((n, c) => n + c.drafts, 0);
  const first = counts[0]?.entity;
  const parts = counts.map((c) => `${c.entity.label}${c.active}`);
  const caption = parts.length ? [...parts.slice(0, -1), `${parts.at(-1)}，销售助手只推荐这些`] : ['销售助手只推荐这些'];
  // 「另有草稿7条：线路1 · 酒店6」，只列有草稿的实体
  const withDrafts = counts.filter((c) => c.drafts > 0);
  const draftLine = withDrafts.map((c, i) => `${i === 0 ? `另有草稿${drafts}条：` : ''}${c.entity.label}${c.drafts}`);
  // 在售数为 0：明细给「新建{实体名}」链接，只给编辑者（spec「总览 · 状态」）
  const create = value === 0 && who.editor && first ? { entity: first.kind, label: `新建${first.label}` } : undefined;
  return {
    key: 'inSale',
    label: `在售${pack.vocabulary.productNoun}`,
    value,
    caption,
    breakdown: who.anon || create ? null : drafts ? draftLine : ['没有草稿'],
    ...(create ? { create } : {}),
    target: { kind: 'catalog', entity: first?.kind ?? '' },
  };
}

/** 「等人接手」格的明细最多写几个时间 */
const TIMES_SHOWN = 3;

/**
 * 成员的四格（设计系统 §10.2 A 页③）：会话、等人接手、已成交三格的数字都取同一次 counts；明细只写接口里现成的数
 * （会话的 updatedAt、状态和短码，产品库各状态的计数），「最后动静」不说成「等了多久」
 */
export function memberKpis(input: {
  counts: ConversationCounts;
  waiting: readonly ConversationRow[];
  latestPaid: ConversationRow | null;
  catalog: ReturnType<typeof catalogCounts>;
  pack: IndustryPack;
  editor: boolean;
  now: number;
}): Kpi[] {
  const { counts, pack, now } = input;
  const oldestFirst = [...input.waiting].sort(byTime);
  const times = oldestFirst.slice(0, TIMES_SHOWN).map((r) => relativeTime(r.updatedAt, now));
  const more = counts.byState.human > times.length && times.length ? `等${counts.byState.human}个` : '';
  const terminal = pack.stages.filter((s) => s.terminal).map((s) => s.label);
  const paid = input.latestPaid;
  return [
    {
      key: 'conversations',
      label: '会话',
      value: counts.total,
      caption: ['企业微信里的客户会话，不含网页试聊'],
      breakdown: [`今天有新动静的${counts.updatedToday}个`],
      target: { kind: 'conversations' },
    },
    {
      key: 'waiting',
      label: '等人接手',
      value: counts.byState.human,
      caption: ['AI已转人工、还没成交的会话'],
      breakdown: [times.length ? `最后动静：${times.join('、')}${more}` : '现在没有等人接手的会话'],
      target: { kind: 'conversations', state: 'human' },
    },
    {
      key: 'paid',
      label: '已成交',
      value: counts.byState.paid,
      caption: [terminal.length ? `阶段到了「${terminal.join('、')}」的会话` : '已成交的会话'],
      breakdown: paid ? [...conversationLabel(paid, pack), dateText(paid.updatedAt, now)] : ['还没有成交的会话'],
      target: { kind: 'conversations', state: 'paid' },
    },
    inSaleKpi(input.catalog, pack, { anon: false, editor: input.editor }),
  ];
}

// ---------------- 客户停在哪一步 ----------------

export interface StageRow {
  /** 行业包的阶段 key；null 是包里没有的阶段合在一起的「其他」，不能点 */
  key: string | null;
  label: string;
  count: number;
  /** 分支阶段（如异议）缩进 8 */
  branch: boolean;
  /** 条长：占最大值的比例，0–1 */
  ratio: number;
}

/**
 * AI 接待中的会话按当前阶段计数（counts 的 aiByStage），阶段名和顺序来自行业包，不含终态；分支阶段排在它的主阶段后面。
 * 包里没有的阶段（换过包、老数据）合成一行「其他」，各行之和仍等于 AI 接待中的数（验收 6 的「阶段条合计 10」）
 */
export function stageRows(pack: IndustryPack, aiByStage: Readonly<Record<string, number>>): StageRow[] {
  const live = pack.stages.filter((s) => !s.terminal);
  const mains = live.filter((s) => !s.branchOf || !live.some((m) => m.key === s.branchOf && !m.branchOf));
  const ordered = mains.flatMap((m) => [m, ...live.filter((s) => s.branchOf === m.key && s !== m && !mains.includes(s))]);
  const countOf = (k: string): number => (Object.hasOwn(aiByStage, k) ? (aiByStage[k] ?? 0) : 0);
  const rows = ordered.map((s) => ({ key: s.key as string | null, label: s.label, count: countOf(s.key), branch: !mains.includes(s) }));
  const known = new Set(ordered.map((s) => s.key));
  const other = Object.entries(aiByStage).reduce((n, [k, v]) => (known.has(k) ? n : n + v), 0);
  if (other > 0) rows.push({ key: null, label: '其他', count: other, branch: false });
  const max = Math.max(0, ...rows.map((r) => r.count));
  return rows.map((r) => ({ ...r, ratio: max ? r.count / max : 0 }));
}

// ---------------- 最近变更 ----------------

/** 「最近变更」写几句（spec：5 句人话） */
export const RECENT_RUNS = 5;

export interface TimelineRow {
  key: number;
  /** 这一句（合并时是最新那条）的时刻，ISO 串 */
  at: string;
  /** 同一天只在第一条写日期（「今天 13:40」「9月25日 18:30」），之后只写时刻 */
  time: string;
  /** 悬停显示的完整时间 */
  fullTime: string;
  actor: { name: string; human: boolean };
  parts: AuditPart[];
  tail: string | null;
}

/**
 * 最近几句变更：连续的同类记录先合成一句（「新建了6条酒店草稿」），再取前 5 句。
 * entries 要多取一些（见 recentAuditQuery），不然一次 CSV 导入被截在中间，合出来的条数就不对
 */
export function timeline(entries: readonly AuditEntryView[], pack: IndustryPack, lookups: AuditLookups, now: number): TimelineRow[] {
  let day = '';
  return auditRuns(entries)
    .slice(0, RECENT_RUNS)
    .map((run) => {
      const first = run[0]!;
      const d = describeAudit(run.length > 1 ? run : first, pack, lookups);
      const k = dayKey(first.at);
      const time = k === day ? clockTime(first.at) : dayTime(first.at, now);
      day = k;
      return { key: first.id, at: first.at, time, fullTime: absoluteTime(first.at, now), actor: d.actor, parts: d.parts, tail: d.tail };
    });
}

/** 取够了没有：合出来的句子多于 5 句，第 5 句一定是完整的；没有更早的记录了也算取够 */
export const enoughAudit = (entries: readonly AuditEntryView[], nextBefore: number | null): boolean =>
  nextBefore === null || auditRuns(entries).length > RECENT_RUNS;
