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
  MetricsView,
  OrderSummary,
  OrderView,
  SopOverview,
  Status,
  ViolationCode,
} from '../../../src/shared/console-api.js';
import { auditRuns, describeAudit, type AuditLookups, type AuditPart } from '../../../src/shared/audit-text.js';
import type { PaymentMode } from '../../../src/shared/conversation-types.js';
import { absoluteTime, clockTime, dateText, dayKey, dayTime, digits, money, percent, relativeTime } from '../../../src/shared/format.js';
import { terminalStages } from '../../../src/shared/conversation.js';
import { checkItem, type CheckIssue, type EntityType, type IndustryPack, valueAt } from '../../../src/shared/pack.js';
import { sectionBody, SopStructureError } from '../../../src/shared/sop-sections.js';
import { actorName, SOP_CHECKS } from '../../../src/shared/ui-labels.js';
import { conversationLabel } from '../shell/model.js';

// ---------------- 共用 ----------------

/**
 * 上下文或明细里的一段；各段之间用 Sep 隔开。tone 为 danger 的那段用 danger 字，前面加 circle-alert（设计系统 §5.11）；
 * A2 的等待时长另有 warning 字与钟表图标（设计系统「02 后端到位后 · A2」：「都带钟表图标」，icon 覆盖默认的 circle-alert）
 */
export interface Segment {
  text: string;
  tone?: 'danger' | 'warning';
  icon?: 'clock';
}

const byTime = (a: { updatedAt: string }, b: { updatedAt: string }): number => Date.parse(a.updatedAt) - Date.parse(b.updatedAt);

/** 更新时间（设计系统 §10.0 修正 9：分不出新建还是更新，一律写「更新于」）：今天写时刻，昨天「昨天13:40」，更早写日期加时刻 */
export function updatedWhen(at: string, now: number): string {
  const today = dayKey(now);
  if (dayKey(at) === today) return clockTime(at);
  if (dayKey(at) === dayKey(new Date(now).setHours(0, 0, 0, 0) - 1)) return `昨天${clockTime(at)}`;
  return absoluteTime(at, now);
}

/** 「小林更新于13:40」；命令名换成「系统导入」「命令行」（actorName）；没有更新人时只写「更新于13:40」 */
export const updatedBy = (name: string | null, at: string, now: number): string => `${actorName(name) ?? ''}更新于${updatedWhen(at, now)}`;

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
  | { kind: 'sop' }
  /** 会话列表的等人接手页签（「还有N个等人接手的会话」） */
  | { kind: 'conversations'; state: 'human' }
  /** 待上架：1 条草稿时是这一条的详情（/catalog/$kind/$code），多条时是这个实体列表的草稿页签 */
  | { kind: 'catalog'; entity: string; code?: string }
  /** A2「等人接手」「已成交客户要人工」：次要小按钮「接手」，成功后打开 J 页（02 spec「后台页面 · 总览 A2」） */
  | { kind: 'takeover'; id: string }
  /** A2「待付款」：幽灵「打开会话」，不接手，只是打开 J 页 */
  | { kind: 'open'; id: string };

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
  /** 这一行算几项：「还有N个等人接手的会话」算 N 项，不写时算 1 项（「6条酒店草稿」也是 1 项） */
  count?: number;
}

/** 区块头的「N项」 */
export const todoCount = (rows: readonly TodoRow[]): number => rows.reduce((n, r) => n + (r.count ?? 1), 0);

/**
 * 等人接手的会话里最后动静最早的一页没列全时，没列出的写成一行「还有N个等人接手的会话」，链到会话列表，不悄悄漏掉。
 * A2 只会在等人接手的总数超过一页（oldestWaitingQuery 的 WAITING_PAGE）时用到；按惯例排在这一组的最后
 */
function moreWaitingTodo(hidden: number, listed: number): TodoRow {
  return {
    key: 'conv:more',
    icon: { page: 'conversations' },
    type: { status: 'human' },
    title: `还有${hidden}个等人接手的会话`,
    context: [{ text: `这里只列最后动静最早的${listed}个` }],
    action: '查看全部',
    target: { kind: 'conversations', state: 'human' },
    count: hidden,
  };
}

/** 等人接手达到这么久用 danger 字，否则 warning，都带钟表图标（02 spec「后台页面 · 总览 A2」，与 J 页列表同一条规则） */
export const WAIT_DANGER_MS = 10 * 60_000;

/** 等待时长写成「12分钟」「2小时」「3天」，给「等了…」「下单…未付」这类前缀用；不到 1 分钟写「不到1分钟」 */
export function waitDurationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到1分钟';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

/** 等待时长这一段：danger/warning 字，前置钟表图标（设计系统 A2：「都带钟表图标」） */
const waitSegment = (waitMs: number): Segment => ({
  text: `等了${waitDurationText(waitMs)}`,
  tone: waitMs >= WAIT_DANGER_MS ? 'danger' : 'warning',
  icon: 'clock',
});

/** 合并排序用的一行：TodoRow（渲染要的）加排序键（紧急、金额、沉默时长），排序键不进 TodoRow——渲染不需要知道这些 */
interface AttentionEntry {
  row: TodoRow;
  emergency: boolean;
  amount: number | null;
  silenceMs: number;
}

/**
 * 「需要你处理」等人接手 + 已成交客户要人工 + 待付款的合并排序（02 spec「后台页面 · 总览 A2」字面：
 * 「没人接手的在前，金额高的在前（待付款订单或最近报价的总价），沉默久的在前」，紧急情况一律最前）：
 * 1. 紧急（`handoff.kind==='emergency'`）一律最前；
 * 2. 没人接手的在前：三组行在这个列表里都是「没人接手」的提醒——等人接手、已成交客户要人工定义上没有接手人；
 *    待付款提醒的是钱没收到，不是这个会话有没有被接手，这里不为了判它再给 `OrderView` 加一个「会话有没有接手人」的字段
 *    （coordinator 的范围只要求加金额），所以这一条在三组之间不产生区分，真正分高低的是第 3、4 条；
 * 3. 金额高的在前：等人接手/已成交客户要人工用 `ConversationRow.amount`（这个会话待付款订单的总价，没有就用最近报价的
 *    总价，都没有为 null），待付款用 `OrderView.totalPrice`；没有金额的排在有金额的后面；
 * 4. 沉默久的在前：等人接手/已成交客户要人工按 `handoff.at` 算的等待时长，待付款按下单时间，都是「多久以前」倒序（越久越前）。
 */
const byAttention = (a: AttentionEntry, b: AttentionEntry): number => {
  const ea = a.emergency ? 0 : 1;
  const eb = b.emergency ? 0 : 1;
  if (ea !== eb) return ea - eb;
  const amtA = a.amount ?? Number.NEGATIVE_INFINITY;
  const amtB = b.amount ?? Number.NEGATIVE_INFINITY;
  if (amtA !== amtB) return amtB - amtA;
  if (a.silenceMs !== b.silenceMs) return b.silenceMs - a.silenceMs;
  return a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0;
};

/** 等人接手 / 已成交客户要人工一行：原因、等待时长（danger/warning，钟表图标）、次要小按钮「接手」 */
function handoffEntry(row: ConversationRow, paid: boolean, pack: IndustryPack, now: number): AttentionEntry {
  const at = row.handoff?.at ?? row.updatedAt;
  const silenceMs = now - Date.parse(at);
  return {
    row: {
      key: `conv:${row.id}`,
      icon: { page: 'conversations' },
      type: paid ? { text: '已成交客户要人工' } : { status: 'human' },
      title: row.needSummary ? [...conversationLabel(row, pack), row.needSummary] : conversationLabel(row, pack),
      context: [{ text: `原因：${row.handoff?.reason ?? '—'}` }, waitSegment(silenceMs)],
      action: '接手',
      target: { kind: 'takeover', id: row.id },
    },
    emergency: row.handoff?.kind === 'emergency',
    amount: row.amount,
    silenceMs,
  };
}

/**
 * 待付款一行：金额、下单多久未付（advisor 模式下还没确认价格的写「等你确认价格」），幽灵「打开会话」。
 * 订单所属会话已被清除（conversation 为 null，第 16 步之后才会出现）的跳过——没有会话 id 就打不开，按「spec 写得不够、
 * 自己定」的原则，这种极少见的边界情况直接不列，比列一行打不开的链接更贴原文的「打开会话」语义，调用方先过滤掉
 */
function paymentEntry(
  o: OrderView & { conversation: NonNullable<OrderView['conversation']> },
  paymentMode: PaymentMode,
  pack: IndustryPack,
  now: number,
): AttentionEntry {
  const unconfirmed = paymentMode === 'advisor' && o.confirmed === null;
  const conv = o.conversation;
  const label = conversationLabel(conv, pack);
  return {
    row: {
      key: `order:${o.id}`,
      icon: { page: 'conversations' },
      type: { text: '待付款' },
      title: conv.needSummary ? [...label, conv.needSummary] : label,
      context: [
        { text: money(o.totalPrice) },
        { text: unconfirmed ? '等你确认价格' : `下单${waitDurationText(now - Date.parse(o.createdAt))}未付` },
      ],
      action: '打开会话',
      target: { kind: 'open', id: conv.id },
    },
    emergency: false,
    amount: o.totalPrice,
    silenceMs: now - Date.parse(o.createdAt),
  };
}

/**
 * 「需要你处理」的等人接手 + 已成交客户要人工 + 待付款，一起按 `byAttention` 排好（见其注释的 spec 字面四条）。
 * waiting 是等人接手里最后动静最早的一页（oldestWaitingQuery），waitingTotal 是等人接手的总数：没列出的在最后补一行
 * 「还有N个」（同原 A 页的 waitingTodos），这一行不参与排序，固定排在最后；paidNeedsHuman、pendingOrders 都很少，不分页
 */
export function attentionTodos(
  waiting: readonly ConversationRow[],
  paidNeedsHuman: readonly ConversationRow[],
  pendingOrders: readonly OrderView[],
  paymentMode: PaymentMode,
  pack: IndustryPack,
  now: number,
  waitingTotal = waiting.length,
): TodoRow[] {
  const withConversation = pendingOrders.filter((o): o is OrderView & { conversation: NonNullable<OrderView['conversation']> } =>
    Boolean(o.conversation),
  );
  const entries = [
    ...waiting.map((row) => handoffEntry(row, false, pack, now)),
    ...paidNeedsHuman.map((row) => handoffEntry(row, true, pack, now)),
    ...withConversation.map((o) => paymentEntry(o, paymentMode, pack, now)),
  ];
  entries.sort(byAttention);
  const rows = entries.map((e) => e.row);
  const hidden = waitingTotal - waiting.length;
  return hidden > 0 ? [...rows, moreWaitingTodo(hidden, waiting.length)] : rows;
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

/**
 * 「需要你处理」的顺序（02 spec「后台页面 · 总览 A2」）：`attention`（等人接手 + 已成交客户要人工 + 待付款，
 * `attentionTodos` 已按紧急、金额、沉默时长排好）在前，然后是话术草稿，最后是待上架（按更新时间倒序）
 */
export const todoOrder = (attention: readonly TodoRow[], sop: TodoRow | null, catalog: readonly TodoRow[]): TodoRow[] => [
  ...attention,
  ...(sop ? [sop] : []),
  ...catalog,
];

// ---------------- A2：本月成交额、运行数字（都不是链接，不用 Kpi/KpiTarget 那一套） ----------------

/** 「本月成交额」与运行数字的四个格：都不点了去哪里（spec 没给「点了去」），数字已经格式化成字符串，没有数据时是「—」 */
export interface StaticKpi {
  key: string;
  label: string;
  value: string;
  /** 口径：一句话；数组时各段用 Sep 隔开 */
  caption: readonly string[];
  /** 明细行：没有时不画 */
  breakdown: readonly string[] | null;
}

/**
 * 「本月成交额（元）」KPI 格（02 spec「后台页面 · 总览 A2」）：只给所有者、管理员。口径固定写死（接口按自然月、
 * 未作废的已付订单算好，这里不重算）；待付款为 0 时不写明细（没有「另有待付0元」这种句子）
 */
export function monthlyRevenueKpi(summary: OrderSummary): StaticKpi {
  return {
    key: 'monthlyRevenue',
    label: '本月成交额（元）',
    value: digits(summary.paidTotal),
    caption: ['本月已付款订单的总额'],
    breakdown: summary.pendingCount > 0 ? [`另有待付${money(summary.pendingTotal)}`] : null,
  };
}

/**
 * 运行数字的四个格（02 spec「可观测性与告警 · 运行数字」）：只给所有者、管理员，文件存储下由调用方整块不画（见
 * OverviewPage 对 503 store_file_mode 的处理，这里的纯函数不知道存储模式）。回复用时换算成秒（接口给的是毫秒）；
 * 转人工率、AI出错率是 0–1 的比例；费用的口径与明细 spec 只给了「今天的AI费用」这一项，caption 是这里自己定的最小说法，
 * 字面上没有要求也不冲突，照「自己定、写进实施记录」的原则处理
 */
export function metricsKpis(m: MetricsView): StaticKpi[] {
  const days = `近${m.days}天`;
  return [
    {
      key: 'replyP90',
      label: '回复用时（秒）',
      value: m.replyP90Ms == null ? '—' : digits(Math.round(m.replyP90Ms / 1000)),
      caption: [`${days}，90%的回复在这之内`],
      breakdown: null,
    },
    {
      key: 'handoffRate',
      label: '转人工率',
      value: percent(m.handoffRate ?? Number.NaN),
      caption: [`${days}有转人工的会话占比`],
      breakdown: null,
    },
    {
      key: 'aiErrorRate',
      label: 'AI出错率',
      value: percent(m.aiErrorRate ?? Number.NaN),
      caption: [`${days}出错的轮次占比`],
      breakdown: null,
    },
    {
      key: 'costToday',
      label: '今天的AI费用（元）',
      value: m.costTodayYuan.toFixed(2),
      caption: ['今天的模型调用花费'],
      breakdown: [`${days}共${m.costRangeYuan.toFixed(2)}元`],
    },
  ];
}

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
  /** 实体的列表（第一个实体）；在售数为 0、明细是「新建{实体名}」时整格改链到新建（Kpi.create） */
  | { kind: 'catalog'; entity: string };

export interface Kpi {
  key: 'conversations' | 'waiting' | 'paid' | 'inSale';
  label: string;
  value: number;
  /** 口径：一句话；数组时各段用 Sep 隔开 */
  caption: readonly string[];
  /** 明细行：这个数背后的真实构成；null 时不画明细（匿名的在售格） */
  breakdown: readonly string[] | null;
  /** 在售数为 0 时，编辑者的明细是「新建{实体名}」，整格链到这个实体的新建页（/catalog/new/$kind） */
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
  // 在售数为 0：明细写「新建{实体名}」、整格链到新建，只给编辑者（spec「总览 · 状态」）
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
  // 口径跟着数字的定义走：数字是 conversationState 判成已成交的会话，即停在行业包终态的会话，口径写终态的阶段名
  // （旅游包「已支付」，家装假包「已付定金」）；包里没有终态时没有会话算已成交，写「已成交的会话」
  const paidStages = terminalStages(pack).map((s) => s.label);
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
      caption: ['AI交给人工、还没成交的会话'],
      breakdown: [times.length ? `最后动静：${times.join('、')}${more}` : '现在没有等人接手的会话'],
      target: { kind: 'conversations', state: 'human' },
    },
    {
      key: 'paid',
      label: '已成交',
      value: counts.byState.paid,
      caption: [paidStages.length ? `阶段到了「${paidStages.join('、')}」的会话` : '已成交的会话'],
      breakdown: paid ? [...conversationLabel(paid, pack), dateText(paid.updatedAt, now)] : ['还没有成交的会话'],
      target: { kind: 'conversations', state: 'paid' },
    },
    inSaleKpi(input.catalog, pack, { anon: false, editor: input.editor }),
  ];
}

// ---------------- 客户停在哪一步 ----------------

// 阶段条的行与会话列表（I 页）共用，放在 conversations/stages.ts
export { stageRows, type StageRow } from '../conversations/stages.js';

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
