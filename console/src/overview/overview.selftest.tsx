// 总览的自测（console UX spec「逐页设计 · 总览（A 页）」、验收 10，设计系统 §5.10、§5.11、§6.7、§10.0、§10.2 A 页，plan 第 4 步）。
// 数据照设计系统 §10.0 的场景（时刻 2026-09-26 周六 14:30，Asia/Shanghai）。行业包是本文件里手写的夹具：console 里只有
// 渲染器自测能 import 注册表和假包（scripts/check-boundaries.ts），这里另写一份旅游式的包和一份家装式的包，证明页面只认包里的配置。
// 1. 纯逻辑（model.ts）：「需要你处理」的顺序是 A01、F01、话术草稿、线路草稿、6条酒店草稿，各行的对象与上下文；话术问题的说法
//    不带工具、字段、短语的原文；上架前检查的必须项与建议项；系统状态的三种 Alert；四个业务数和明细；阶段条（不含终态、
//    分支缩进、按最大值缩放、包外的阶段合成「其他」、各行之和等于 AI 接待中）；最近变更先合并再取 5 句、同一天只写一次日期；
//    审计记录取够了没有；
// 2. 在 DOM 里挂载（happy-dom，与渲染器自测共用 selftest-dom.ts）：真的 OverviewPage 加假的后台接口。所有者看到全部五块；
//    某个接口 500 时只有用它的那一块写「没取到」（验收 10：/audit 500 只有「最近变更」出错）；坐席没有「最近变更」和草稿类待办，
//    也不发这些请求；demo 匿名只有「在售」一格、只取产品库列表；审计按页往前取，一次导入不被截断；等人接手多于接口的
//    默认一页（20）乃至一整页（100）时，等得最久的照样列在最前、计数按总数；换一个行业包，
//    实体、阶段、叫法都跟着换，请求的是那个包的 kind；阶段条和业务数链到带 state、stage 的会话列表（验收 10）；
//    每次挂载的总览从首帧（各块的骨架）、载完到卸载前，文字、标签页标题和读屏属性里都没有验收 6 禁用的五个词。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/overview/overview.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import './selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import fs from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AuditEntryView,
  CatalogItem,
  ContractViolation,
  ConversationCounts,
  ConversationRow,
  DraftCheck,
  Me,
  MetricsView,
  OrderSummary,
  OrderView,
  Role,
  SopOverview,
  Status,
} from '../../../src/shared/console-api.js';
import { auditRuns } from '../../../src/shared/audit-text.js';
import { relativeTime } from '../../../src/shared/format.js';
import type { EntityType, FieldDef, FieldType, IndustryPack } from '../../../src/shared/pack.js';
import type { Viewer } from '../shell/boot.js';
import { catalogListQuery, conversationCountsQuery, waitingConversationsQuery } from '../queries.js';
import { VIEWER_KEY } from '../viewer.js';
import {
  attentionTodos,
  catalogCounts,
  catalogTodos,
  enoughAudit,
  inSaleKpi,
  issueText,
  memberKpis,
  metricsKpis,
  monthlyRevenueKpi,
  sopProblemText,
  sopTodo,
  stageRows,
  systemView,
  timeline,
  todoCount,
  todoOrder,
  updatedWhen,
  waitDurationText,
} from './model.js';
import { OverviewPage, TODO_WAIT_MS } from './OverviewPage.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

check('时区钉成了上海', new Date(Date.UTC(2026, 8, 25, 16)).getDate() === 26);

// ---------------- 夹具：设计系统 §10.0 的场景 ----------------

const NOW = Date.parse('2026-09-26T14:30:00+08:00');
const MIN = 60_000;
const at = (s: string): string => new Date(Date.parse(`${s}+08:00`)).toISOString();

const f = (key: string, type: FieldType, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  type,
  label,
  group: 'basic',
  ...extra,
});
const entity = (kind: string, label: string, icon: string, titleKey: string, fields: FieldDef[]): EntityType => ({
  kind,
  label,
  icon,
  codeLabel: `${label}编号`,
  codeExample: 'x-1',
  titleKey,
  subtitleKeys: [],
  groups: [{ key: 'basic', label: '基本信息' }],
  lockGroups: {},
  fields,
  list: { columns: [], filters: [], search: [], defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '',
});

/** 旅游式的包：必须项是编号、名称、天数、住宿档次、行程亮点、逐日行程（每天的标题与住宿）加「条数与天数一致」，共 7 项；体力强度是建议项 */
const ROUTE = entity('route', '线路', 'route', 'title', [
  f('$code', 'text', '线路编号'),
  f('title', 'text', '线路名称'),
  f('days', 'intUnit', '天数', { unit: '天', min: 1 }),
  f('intensity.level', 'enum', '体力强度', { options: ['轻松', '适中', '较累'], required: false, recommend: true }),
  f('hotelLevel', 'text', '住宿档次'),
  f('highlights', 'tags', '行程亮点'),
  f('itinerary', 'subItems', '逐日行程', {
    countFrom: 'days',
    itemNoun: '天',
    item: [f('title', 'text', '当天标题', { group: '' }), f('hotel', 'text', '当晚住宿', { group: '' })],
  }),
]);
const HOTEL = entity('hotel', '酒店', 'bed-double', 'name', [f('$code', 'text', '酒店编号'), f('name', 'text', '酒店名称')]);
const TRAVEL: IndustryPack = {
  id: 'fixture-travel',
  name: '旅游',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: { search_routes: '查线路' }, sopFields: {} },
  // 与 nav.entities 的顺序故意不同：页面按 nav 排
  entities: [HOTEL, ROUTE],
  stages: [
    { key: 'greeting', label: '开场' },
    { key: 'discovery', label: '问需' },
    { key: 'recommend', label: '推荐' },
    { key: 'quote', label: '报价' },
    { key: 'objection', label: '异议', branchOf: 'quote' },
    { key: 'closing', label: '促成' },
    { key: 'paid', label: '已支付', terminal: true },
  ],
  sopSections: [
    { key: 'preamble', heading: null, locked: false },
    { key: 'stages', heading: '各阶段目标', locked: true, lockReason: '由代码核对' },
    { key: 'tone', heading: '话术原则', locked: false },
    { key: 'objections', heading: '异议处理', locked: false },
    { key: 'wechat-style', heading: '微信语气规范', locked: false },
  ],
  nav: { catalogGroup: '产品库', entities: ['route', 'hotel'] },
};

const conv = (
  short: string,
  stage: string,
  handedOver: boolean,
  messageCount: number,
  updatedAt: string,
  handoff: ConversationRow['handoff'] = null,
  needSummary: string | null = null,
  amount: number | null = null,
): ConversationRow => ({
  id: `wecom:cust_${short}`,
  channel: 'wecom',
  stage,
  handedOver,
  messageCount,
  updatedAt,
  amount,
  needSummary,
  assignee: null,
  handoff,
  lastCustomerAt: null,
});
/** 接口的 ?state=human 按最后动静倒序：F01（8分钟前）在 A01（26分钟前）前面。handoff.at 是转人工时刻（A2 的等待时长按它算） */
/** F01、A01 都没有报价（amount null），这组夹具专管「没有金额时按沉默时长排」与别处大量复用它的下标断言不受金额排序影响 */
const WAITING = [
  conv('F01', 'handoff', true, 2, new Date(NOW - 8 * MIN).toISOString(), {
    kind: 'complaint',
    at: new Date(NOW - 8 * MIN).toISOString(),
    reason: '客户投诉价格太贵',
  }),
  conv(
    'A01',
    'handoff',
    true,
    7,
    new Date(NOW - 26 * MIN).toISOString(),
    { kind: 'request', at: new Date(NOW - 26 * MIN).toISOString(), reason: '客户要找顾问' },
    '贵州带爸妈4人',
  ),
];
/** 「已成交客户要人工」：终态、handedOver、没有接手人（paidNeedsHuman） */
const PAID_NEEDS_HUMAN = conv('P01', 'paid', true, 4, new Date(NOW - 40 * MIN).toISOString(), {
  kind: 'complaint',
  at: new Date(NOW - 40 * MIN).toISOString(),
  reason: '已付款客户要退款',
});
const A02 = conv('A02', 'paid', false, 5, at('2026-09-24T17:20:00'));

/** 待付款订单夹具（02 spec「后台页面 · 总览 A2」、「收款流程」） */
const order = (
  id: string,
  totalPrice: number,
  createdAt: string,
  confirmed: boolean,
  conversation: { id: string; channel: string; needSummary: string | null } | null,
): OrderView => ({
  id,
  routeTitle: '巴厘岛经典5日',
  travelers: 2,
  departDate: '2026-11-08',
  totalPrice,
  status: 'pending_payment',
  createdAt,
  paidAt: null,
  confirmed: confirmed ? { at: createdAt, by: '小林' } : null,
  handoffBeforePaid: null,
  conversation,
});
const PENDING_B01 = order('o-b01', 85_600, new Date(NOW - 2 * 60 * MIN).toISOString(), false, {
  id: 'wecom:cust_B01',
  channel: 'wecom',
  needSummary: '巴厘岛2人',
});
const PENDING_HIGH = order('o-high', 120_000, new Date(NOW - 30 * MIN).toISOString(), true, {
  id: 'wecom:cust_H01',
  channel: 'wecom',
  needSummary: null,
});
const COUNTS: ConversationCounts = {
  total: 13,
  byState: { ai: 10, human: 2, assigned: 0, paid: 1 },
  aiByStage: { discovery: 4, recommend: 3, quote: 2, closing: 1 },
  updatedToday: 6,
};

const item = (
  kind: string,
  code: string,
  payload: object,
  status: 'draft' | 'active',
  updatedAt: string,
  by: string | null = null,
): CatalogItem => ({ kind, code, ord: 0, status, rev: 1, payload, updatedByName: by, updatedAt }) as unknown as CatalogItem;
const GUIZHOU = {
  id: 'r-guizhou-5d',
  title: '贵州 小七孔·西江千户苗寨 5 日',
  days: 5,
  hotelLevel: '舒适型',
  highlights: ['非遗手作'],
  itinerary: [1, 2, 3, 4, 5].map((d) => ({ title: `第${d}天`, hotel: '凯里' })),
};
const ROUTES: CatalogItem[] = [
  ...Array.from({ length: 19 }, (_, i) =>
    item('route', `r-${i}`, { id: `r-${i}`, title: `线路${i}` }, 'active', at('2026-09-24T10:02:00')),
  ),
  item(
    'route',
    'r-sichuan-lux',
    { id: 'r-sichuan-lux', title: '四川 稻城亚丁·色达秘境 8 日' },
    'active',
    at('2026-09-26T10:12:00'),
    '小林',
  ),
  item('route', 'r-guizhou-5d', GUIZHOU, 'draft', at('2026-09-26T13:40:00'), '小林'),
];
const HOTEL_DRAFTS = ['青城山六善酒店', '成都锦江宾馆', '大研安缦', '丽江金茂', '西双版纳安纳塔拉', '腾冲石头纪'];
const HOTELS: CatalogItem[] = [
  ...Array.from({ length: 23 }, (_, i) => item('hotel', `h-${i}`, { id: `h-${i}`, name: `酒店${i}` }, 'active', at('2026-09-24T10:02:00'))),
  // 同一次 CSV 导入，更新时间相同：按编号排，前 3 个是青城山、锦江、大研
  ...HOTEL_DRAFTS.map((name, i) =>
    item('hotel', `h-new-${'abcdef'[i]}`, { id: `h-new-${i}`, name }, 'draft', at('2026-09-26T11:20:00'), '小林'),
  ),
];

const body = (heading: string | null, n: number, fill = 'x'): string =>
  heading === null ? fill.repeat(n) : `## ${heading}\n\n${fill.repeat(n)}`;
const SOP_SPEC = TRAVEL.sopSections.map(({ key, heading, locked }) => ({ key, heading, locked }));
const PUBLISHED = [
  { key: 'preamble', text: body(null, 232) },
  { key: 'stages', text: body('各阶段目标', 3117) },
  { key: 'tone', text: body('话术原则', 910) },
  { key: 'objections', text: body('异议处理', 531) },
  { key: 'wechat-style', text: body('微信语气规范', 577) },
];
const DRAFT = PUBLISHED.map((s) =>
  s.key === 'tone'
    ? { key: s.key, text: body('话术原则', 954, 'y') }
    : s.key === 'objections'
      ? { key: s.key, text: body('异议处理', 540, 'y') }
      : s,
);
const SOP = {
  published: { id: 'v2', versionNo: 2, status: 'published', sections: PUBLISHED },
  draft: { id: 'd1', versionNo: null, status: 'draft', rev: 4, basedOn: 'v2', sections: DRAFT, stale: false },
  spec: SOP_SPEC,
  budget: { chars: 2303, limit: 2658 },
} as unknown as SopOverview;
const violation = (code: ContractViolation['code'], sectionKey: string | null): ContractViolation => ({
  code,
  sectionKey,
  detail: 'search_route 不是现有的工具名',
});
const CHECK: DraftCheck = {
  promptHash: 'p',
  prefixHash: 'x',
  chars: 2303,
  limit: 2658,
  violations: [violation('unknown_tool', 'tone')],
  rebase: { needed: false, conflicts: [] },
};

const STATUS: Status = {
  channels: [],
  mode: 'db',
  tenantSlug: 'yuntu',
  sop: {
    versionId: 'v2',
    versionNo: 2,
    publishedAt: at('2026-09-25T18:30:00'),
    promptHash: 'a',
    toolsHash: 'b',
    prefixHash: 'c',
    sopHash: 'd',
  },
  lock: 'held',
  sopStale: false,
  catalogStale: false,
  index: { indexGeneration: 3, snapshotGeneration: 3, stale: false, lastError: null },
  drift: {
    editedSections: ['tone'],
    catalog: { route: { changed: [], onlyDb: [], onlyImage: [] }, hotel: { changed: [], onlyDb: [], onlyImage: [] } },
  },
  // 02 第 13 步给 Status 加的两项（只为类型补上，断言没动）
  conversations: 0,
  poisoned: [],
};

let auditId = 30;
const audit = (
  when: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  diff: unknown,
  actor: Pick<AuditEntryView, 'actorKind' | 'actorName'> = { actorKind: 'user', actorName: '小林' },
): AuditEntryView => ({ id: (auditId -= 1), at: at(when), ...actor, action, targetType, targetId, diff });
const CLI = { actorKind: 'platform', actorName: null } as const;
/** 设计系统 §10.0 的审计（新的在前）；6 条 CSV 导入的酒店草稿相隔几秒 */
const AUDIT: AuditEntryView[] = [
  audit('2026-09-26T13:40:00', 'catalog.create', 'route', 'r-guizhou-5d', { title: [null, GUIZHOU.title] }),
  ...HOTEL_DRAFTS.map((name, i) =>
    audit(`2026-09-26T11:20:0${5 - i}`, 'catalog.create', 'hotel', `h-new-${'abcdef'[i]}`, { name: [null, name] }),
  ),
  audit('2026-09-26T10:12:00', 'catalog.update', 'route', 'r-sichuan-lux', {
    hotelLevel: ['豪华', '顶级野奢'],
    highlights: [['a'], ['a', 'b']],
  }),
  audit(
    '2026-09-25T18:30:00',
    'sop.publish',
    'sop',
    'v2',
    { versionNo: 2, changedKeys: ['objections'] },
    { actorKind: 'user', actorName: '老板' },
  ),
  audit('2026-09-24T10:05:00', 'platform.user_create', 'user', 'u2', { email: 'xiaolin@yuntu.test', role: 'admin', created: true }, CLI),
  audit('2026-09-24T10:03:00', 'platform.user_create', 'user', 'u1', { email: 'boss@yuntu.test', role: 'owner', created: true }, CLI),
  audit('2026-09-24T10:02:00', 'config.import', null, null, {}, CLI),
  audit('2026-09-24T10:01:00', 'platform.tenant_create', null, null, {}, CLI),
];

// ---------------- 1. 纯逻辑 ----------------

eq(
  '等待时长写法：分钟、小时、天',
  [waitDurationText(30_000), waitDurationText(8 * MIN), waitDurationText(65 * MIN), waitDurationText(26 * 60 * MIN)],
  ['不到1分钟', '8分钟', '1小时', '1天'],
);

// 「需要你处理」的等人接手 + 已成交客户要人工 + 待付款，一起按 spec 字面排序（02 spec「总览 A2」）：
// 紧急一律最前；其余没人接手的在前（这三组行都算「没人接手」，不区分）、金额高的在前（没有金额排最后）、沉默久的在前。
// 这组断言用自己的一套夹具（Z 开头），不动 WAITING/EMERGENCY/PAID_NEEDS_HUMAN/PENDING_*（后面大量 DOM 挂载测试复用
// 那几个夹具，金额从 null 改成有值会牵连一大片跟排序无关的断言，没必要）
{
  const zEmergency = conv('ZEG', 'handoff', true, 1, new Date(NOW - 12 * MIN).toISOString(), {
    kind: 'emergency',
    at: new Date(NOW - 12 * MIN).toISOString(),
    reason: '客户要把6天压缩到4天，现成线路没有',
  });
  const zPaidNeedsHuman = conv(
    'ZP1',
    'paid',
    true,
    1,
    new Date(NOW - 40 * MIN).toISOString(),
    { kind: 'complaint', at: new Date(NOW - 40 * MIN).toISOString(), reason: '已付款客户要退款' },
    null,
    150_000,
  );
  const zWaitingHasAmount = conv(
    'ZF1',
    'handoff',
    true,
    1,
    new Date(NOW - 8 * MIN).toISOString(),
    { kind: 'complaint', at: new Date(NOW - 8 * MIN).toISOString(), reason: '客户投诉价格太贵' },
    null,
    60_000,
  );
  const zWaitingNoAmount = conv(
    'ZA1',
    'handoff',
    true,
    1,
    new Date(NOW - 26 * MIN).toISOString(),
    { kind: 'request', at: new Date(NOW - 26 * MIN).toISOString(), reason: '客户要找顾问' },
    '贵州带爸妈4人',
  );
  const zOrderEarlierTie = order('z-b01', 85_600, new Date(NOW - 2 * 60 * MIN).toISOString(), false, {
    id: 'wecom:cust_ZB1',
    channel: 'wecom',
    needSummary: '巴厘岛2人',
  });
  const zOrderLaterTie = order('z-h01', 85_600, new Date(NOW - 30 * MIN).toISOString(), true, {
    id: 'wecom:cust_ZH1',
    channel: 'wecom',
    needSummary: null,
  });
  const zOrderNoConv = order('z-gone', 50_000, new Date(NOW - 10 * MIN).toISOString(), false, null);
  const attention = attentionTodos(
    [zEmergency, zWaitingHasAmount, zWaitingNoAmount],
    [zPaidNeedsHuman],
    [zOrderEarlierTie, zOrderLaterTie, zOrderNoConv],
    'advisor',
    TRAVEL,
    NOW,
  );
  eq(
    '顺序：紧急最前 → 金额高在前（150,000 > 85,600=85,600 > 60,000 > null）→ 金额相同按沉默久的在前（z-b01 120分钟 > z-h01 30分钟）',
    attention.map((r) => r.key),
    ['conv:wecom:cust_ZEG', 'conv:wecom:cust_ZP1', 'order:z-b01', 'order:z-h01', 'conv:wecom:cust_ZF1', 'conv:wecom:cust_ZA1'],
  );
  eq(
    '类型：等人接手用状态胶囊，已成交客户要人工与待付款写死文字（Status 组件没有这两个状态值）',
    attention.map((r) => r.type),
    [{ status: 'human' }, { text: '已成交客户要人工' }, { text: '待付款' }, { text: '待付款' }, { status: 'human' }, { status: 'human' }],
  );
  eq(
    '标题：needSummary 有就加第三段（ZA1、z-b01 带，其余没有）',
    attention.map((r) => r.title),
    [
      ['企微客户', 'ZEG'],
      ['企微客户', 'ZP1'],
      ['企微客户', 'ZB1', '巴厘岛2人'],
      ['企微客户', 'ZH1'],
      ['企微客户', 'ZF1'],
      ['企微客户', 'ZA1', '贵州带爸妈4人'],
    ],
  );
  eq(
    '上下文：等人接手/已成交客户要人工写原因与等待时长（10分钟以上 danger、否则 warning，都带钟表图标）；待付款写金额与下单多久未付，advisor 未确认写「等你确认价格」',
    attention.map((r) => r.context),
    [
      [{ text: '原因：客户要把6天压缩到4天，现成线路没有' }, { text: '等了12分钟', tone: 'danger', icon: 'clock' }],
      [{ text: '原因：已付款客户要退款' }, { text: '等了40分钟', tone: 'danger', icon: 'clock' }],
      [{ text: '85,600元' }, { text: '等你确认价格' }],
      [{ text: '85,600元' }, { text: '下单30分钟未付' }],
      [{ text: '原因：客户投诉价格太贵' }, { text: '等了8分钟', tone: 'warning', icon: 'clock' }],
      [{ text: '原因：客户要找顾问' }, { text: '等了26分钟', tone: 'danger', icon: 'clock' }],
    ],
  );
  eq(
    '操作：等人接手/已成交客户要人工是次要按钮「接手」（target 是 takeover），待付款是幽灵「打开会话」（target 是 open）',
    attention.map((r) => [r.action, r.target]),
    [
      ['接手', { kind: 'takeover', id: 'wecom:cust_ZEG' }],
      ['接手', { kind: 'takeover', id: 'wecom:cust_ZP1' }],
      ['打开会话', { kind: 'open', id: 'wecom:cust_ZB1' }],
      ['打开会话', { kind: 'open', id: 'wecom:cust_ZH1' }],
      ['接手', { kind: 'takeover', id: 'wecom:cust_ZF1' }],
      ['接手', { kind: 'takeover', id: 'wecom:cust_ZA1' }],
    ],
  );
  eq(
    '待付款：会话已被清除（conversation 为 null）的订单不列',
    attention.some((r) => r.key === 'order:z-gone'),
    false,
  );
  eq('需要你处理计数：6 行各算 1 项', todoCount(attention), 6);
}
eq(
  'online 模式下不写「等你确认价格」，哪怕没确认：待付款那一段按真的下单时长（spec 字面例句：下单2小时未付）',
  attentionTodos([], [], [PENDING_B01], 'online', TRAVEL, NOW)[0]?.context[1],
  { text: '下单2小时未付' },
);
{
  // 那一页只列了等得最久的 2 个（WAITING，都没有金额），另有 5 个：写成一行链到会话列表，算 5 项，不参与排序、固定排在最后
  const more = attentionTodos(WAITING, [], [], 'advisor', TRAVEL, NOW, 7);
  eq(
    '等人接手没列全：末尾一行「还有N个」，链到等人接手页签',
    more.slice(-1).map((r) => [r.title, r.context, r.action, r.target, r.count]),
    [['还有5个等人接手的会话', [{ text: '这里只列最后动静最早的2个' }], '查看全部', { kind: 'conversations', state: 'human' }, 5]],
  );
  eq('等人接手没列全：计数算上没列的', todoCount(more), 7);
}

// 「本月成交额」「运行数字」KPI 格（都不是链接）
const SUMMARY: OrderSummary = { month: '2026-09', paidTotal: 207_440, paidCount: 2, pendingTotal: 85_600, pendingCount: 1 };
eq('本月成交额：数字不带单位（标签已经写了「元」），明细写另有待付', monthlyRevenueKpi(SUMMARY), {
  key: 'monthlyRevenue',
  label: '本月成交额（元）',
  value: '207,440',
  caption: ['本月已付款订单的总额'],
  breakdown: ['另有待付85,600元'],
});
eq('本月成交额：没有待付款时不写明细', monthlyRevenueKpi({ ...SUMMARY, pendingCount: 0 }).breakdown, null);
const METRICS: MetricsView = {
  days: 7,
  turns: 120,
  replyP90Ms: 2345,
  handoffRate: 0.12,
  aiErrorRate: 0.03,
  costTodayYuan: 18.62,
  costRangeYuan: 96.4,
};
eq(
  '运行数字：回复用时按秒取整、比例写成百分数、费用两位小数',
  metricsKpis(METRICS).map((k) => [k.label, k.value]),
  [
    ['回复用时（秒）', '2'],
    ['转人工率', '12%'],
    ['AI出错率', '3%'],
    ['今天的AI费用（元）', '18.62'],
  ],
);
eq(
  '运行数字：口径写近N天',
  metricsKpis(METRICS).map((k) => k.caption),
  [['近7天，90%的回复在这之内'], ['近7天有转人工的会话占比'], ['近7天出错的轮次占比'], ['今天的模型调用花费']],
);
eq('运行数字：费用的明细写近N天共多少元', metricsKpis(METRICS)[3]?.breakdown, ['近7天共96.40元']);
eq(
  '运行数字：没有数据写「—」',
  metricsKpis({ ...METRICS, replyP90Ms: null, handoffRate: null, aiErrorRate: null }).map((k) => k.value),
  ['—', '—', '—', '18.62'],
);

const sop = sopTodo(SOP, CHECK, TRAVEL);
eq('话术草稿：改了哪几节、各差多少字', sop?.title, '改了2节：话术原则（+44字）、异议处理（+9字）');
eq('话术草稿：问题用 danger，后跟发布前检查', sop?.context, [
  { text: '1个问题：话术原则里有个工具名写错了', tone: 'danger' },
  { text: '发布前检查6/7通过' },
]);
eq('话术草稿：检查没取到时只写第一行', sopTodo(SOP, undefined, TRAVEL)?.context, []);
eq('没有草稿就没有这一行', sopTodo({ ...SOP, draft: null }, CHECK, TRAVEL), null);
eq(
  '字数减少写「-」，字数不变不写括号',
  sopTodo(
    {
      ...SOP,
      draft: {
        ...SOP.draft!,
        sections: PUBLISHED.map((s) =>
          s.key === 'tone'
            ? { key: s.key, text: body('话术原则', 900) }
            : s.key === 'preamble'
              ? { key: s.key, text: body(null, 232, 'z') }
              : s,
        ),
      },
    },
    CHECK,
    TRAVEL,
  )?.title,
  '改了2节：前言、话术原则（-10字）',
);
eq('草稿和线上一样', sopTodo({ ...SOP, draft: { ...SOP.draft!, sections: PUBLISHED } }, CHECK, TRAVEL)?.title, '草稿和线上一样');
eq(
  '话术草稿：两个问题写「等」，检查通过项按问题的种类数算',
  sopTodo(SOP, { ...CHECK, violations: [violation('phrase_forbidden', 'tone'), violation('phrase_forbidden', 'objections')] }, TRAVEL)
    ?.context,
  [{ text: '2个问题：话术原则里有不能出现的话等', tone: 'danger' }, { text: '发布前检查6/7通过' }],
);
{
  const codes = [
    'structure',
    'locked_changed',
    'phrase_missing',
    'phrase_forbidden',
    'unknown_tool',
    'unknown_field',
    'over_budget',
  ] as const;
  const texts = codes.flatMap((c) => [sopProblemText(violation(c, 'tone'), TRAVEL), sopProblemText(violation(c, null), TRAVEL)]);
  check(
    '话术问题的说法不带工具、字段、短语的原文，也没有英文',
    texts.every((t) => !/[A-Za-z]/.test(t) && t.length > 0),
    texts.join(' / '),
  );
  eq('话术问题：节名取自行业包，前言写「前言」', sopProblemText(violation('unknown_field', 'preamble'), TRAVEL), '前言里有个字段名写错了');
  eq('话术问题：固定规则节点名', sopProblemText(violation('locked_changed', 'stages'), TRAVEL), '固定规则节「各阶段目标」被改了');
}

const lists = [
  { entity: ROUTE, items: ROUTES },
  { entity: HOTEL, items: HOTELS },
];
const catalog = catalogTodos(lists, NOW);
eq(
  '待上架：按最近一条的更新时间倒序，1 条写条目名、多条合成一行',
  catalog.map((r) => r.title),
  ['线路草稿「贵州 小七孔·西江千户苗寨 5 日」', '6条酒店草稿'],
);
eq('待上架：线路草稿的上下文（必须项与建议项由 checkItem 算）', catalog[0]?.context, [
  { text: '小林更新于13:40' },
  { text: '必须项7/7已过' },
  { text: '建议1条没做：体力强度没填（不拦上架）' },
]);
eq('待上架：多条草稿列出前 3 个名称', catalog[1]?.context, [
  { text: '小林更新于11:20' },
  { text: '青城山六善酒店、成都锦江宾馆、大研安缦等6条' },
]);
eq(
  '待上架：图标、动作与去向取自行业包的实体',
  catalog.map((r) => [r.icon, r.type, r.action, r.target]),
  [
    [{ entity: 'route' }, { text: '待上架' }, '去上架', { kind: 'catalog', entity: 'route', code: 'r-guizhou-5d' }],
    [{ entity: 'bed-double' }, { text: '待上架' }, '逐条检查', { kind: 'catalog', entity: 'hotel' }],
  ],
);
{
  const broken = { ...GUIZHOU, itinerary: GUIZHOU.itinerary.map((d, i) => (i === 2 ? { title: d.title } : d)) };
  const one = catalogTodos([{ entity: ROUTE, items: [item('route', 'r-x', broken, 'draft', at('2026-09-26T13:40:00'), '小林')] }], NOW);
  eq('待上架：必须项没过写 danger，有序子项写到第几天', one[0]?.context[1], { text: '必须项6/7：第3天当晚住宿没填', tone: 'danger' });
  const two = catalogTodos(
    [{ entity: ROUTE, items: [item('route', 'r-x', { ...broken, days: 6 }, 'draft', at('2026-09-26T13:40:00'))] }],
    NOW,
  );
  eq('待上架：几处没过写「等」；没有更新人只写「更新于」', two[0]?.context.slice(0, 2), [
    { text: '更新于13:40' },
    { text: '必须项5/7：第3天当晚住宿没填等', tone: 'danger' },
  ]);
  // 命令行写的更新人存的是命令名，照设计系统 §11 写成「系统导入」「命令行」
  eq(
    '待上架：更新人是 import-config 写「系统导入」，catalog-fix 写「命令行」',
    ['import-config', 'catalog-fix'].map(
      (by) =>
        catalogTodos([{ entity: ROUTE, items: [item('route', 'r-x', GUIZHOU, 'draft', at('2026-09-26T13:40:00'), by)] }], NOW)[0]
          ?.context[0],
    ),
    [{ text: '系统导入更新于13:40' }, { text: '命令行更新于13:40' }],
  );
  eq('待上架：三条以内不写「等」', catalogTodos([{ entity: HOTEL, items: HOTELS.slice(-2) }], NOW)[0]?.context[1], {
    text: '西双版纳安纳塔拉、腾冲石头纪',
  });
  eq('没有草稿的实体不出现', catalogTodos([{ entity: HOTEL, items: HOTELS.slice(0, 23) }], NOW), []);
  eq(
    '上架前检查的问题：取中文路径的后两段',
    issueText({ path: 'itinerary.2.hotel', label: '逐日行程 · 第3天 · 当晚住宿', message: '没填' }),
    '第3天当晚住宿没填',
  );
  eq(
    '更新时间：昨天与更早',
    [updatedWhen(at('2026-09-25T21:40:00'), NOW), updatedWhen(at('2026-09-24T10:05:00'), NOW)],
    ['昨天21:40', '9月24日 10:05'],
  );
}
// WAITING（F01、A01）都没有报价（amount null）；PENDING_HIGH（120,000）> PENDING_B01（85,600）> 两个等人接手（null，
// 并列时按沉默久的在前：A01 26分钟 > F01 8分钟）
const plain = attentionTodos(WAITING, [], [PENDING_B01, PENDING_HIGH], 'advisor', TRAVEL, NOW);
eq(
  '需要你处理的顺序（验收 16）：按金额（HIGH 120,000 > B01 85,600 > 两个等人接手 null，null 按沉默久的在前）、话术草稿、线路草稿、6条酒店草稿',
  todoOrder(plain, sop, catalog).map((r) => r.key),
  ['order:o-high', 'order:o-b01', 'conv:wecom:cust_A01', 'conv:wecom:cust_F01', 'sop', 'catalog:route:r-guizhou-5d', 'catalog:hotel'],
);
eq(
  '「还有N个等人接手」排进没有金额的那一段末尾（沉默时长排在最后，因为它不比任何具体会话更急），话术草稿前面',
  todoOrder(attentionTodos(WAITING, [], [PENDING_B01, PENDING_HIGH], 'advisor', TRAVEL, NOW, 3), sop, []).map((r) => r.key),
  ['order:o-high', 'order:o-b01', 'conv:wecom:cust_A01', 'conv:wecom:cust_F01', 'conv:more', 'sop'],
);

// 系统状态
eq('系统状态：一切正常', systemView(STATUS, TRAVEL), { ok: true, lead: '一切正常', rest: ['线上话术v2', '产品库改动已生效'] });
{
  const bad = systemView(
    { ...STATUS, lock: 'lost', sopStale: true, catalogStale: true, index: { ...STATUS.index, lastError: 'ECONNRESET' } },
    TRAVEL,
  );
  eq('系统状态：锁断开是 danger，其余是 warning；lastError 只进技术详情', bad, {
    ok: false,
    alerts: [
      { tone: 'danger', text: '暂时无法保存修改：和数据库的锁连接断开了，系统在自动重连。线上话术和产品不受影响。' },
      { tone: 'warning', text: '话术和产品库的最新修改还没载入运行中的系统，正在自动重试。' },
      { tone: 'warning', text: '线路搜索索引在更新，新上架的线路可能暂时搜不到。', tech: [['index.lastError', 'ECONNRESET']] },
    ],
  });
  eq('系统状态：索引在更新、没有报错时照样提醒，不带技术详情', systemView({ ...STATUS, index: { ...STATUS.index, stale: true } }, TRAVEL), {
    ok: false,
    alerts: [{ tone: 'warning', text: '线路搜索索引在更新，新上架的线路可能暂时搜不到。' }],
  });
  eq('系统状态：只有产品库没载入', systemView({ ...STATUS, catalogStale: true }, TRAVEL), {
    ok: false,
    alerts: [{ tone: 'warning', text: '产品库的最新修改还没载入运行中的系统，正在自动重试。' }],
  });
  eq(
    '系统状态：drift 不在总览里',
    systemView({ ...STATUS, drift: { ...STATUS.drift, editedSections: ['tone', 'objections'] } }, TRAVEL).ok,
    true,
  );
}

// 业务数
const kpis = memberKpis({
  counts: COUNTS,
  waiting: WAITING,
  latestPaid: A02,
  catalog: catalogCounts(lists),
  pack: TRAVEL,
  editor: true,
  now: NOW,
});
eq(
  '业务数：四格的名称与数字（同一次 counts）',
  kpis.map((k) => [k.label, k.value]),
  [
    ['会话', 13],
    ['等人接手', 2],
    ['已成交', 1],
    ['在售产品', 43],
  ],
);
eq(
  '业务数：口径',
  kpis.map((k) => k.caption),
  [
    ['企业微信里的客户会话，不含网页试聊'],
    ['AI交给人工、还没成交的会话'],
    ['阶段到了「已支付」的会话'],
    ['线路20', '酒店23，销售助手只推荐这些'],
  ],
);
eq(
  '业务数：明细（设计系统 A 页）',
  kpis.map((k) => k.breakdown),
  [['今天有新动静的6个'], ['最后动静：26分钟前、8分钟前'], ['企微客户', 'A02', '9月24日'], ['另有草稿7条：线路1', '酒店6']],
);
eq(
  '业务数：去向',
  kpis.map((k) => k.target),
  [
    { kind: 'conversations' },
    { kind: 'conversations', state: 'human' },
    { kind: 'conversations', state: 'paid' },
    { kind: 'catalog', entity: 'route' },
  ],
);
{
  const four = [
    ...WAITING,
    conv('B09', 'quote', true, 1, new Date(NOW - 90 * MIN).toISOString()),
    conv('B08', 'quote', true, 1, new Date(NOW - 3 * MIN).toISOString()),
  ];
  const k = memberKpis({
    counts: { ...COUNTS, byState: { ai: 6, human: 6, assigned: 0, paid: 0 } },
    waiting: four,
    latestPaid: null,
    catalog: catalogCounts([{ entity: ROUTE, items: [] }]),
    pack: TRAVEL,
    editor: true,
    now: NOW,
  });
  eq(
    '业务数：等人接手的数取 counts（不是那一页的条数）；最后动静最多写 3 个，多的写「等N个」；没有成交',
    [k[1]?.value, k[1]?.breakdown, k[2]?.breakdown],
    [6, ['最后动静：1小时前、26分钟前、8分钟前等6个'], ['还没有成交的会话']],
  );
  eq(
    '在售数为 0：编辑者的明细是「新建线路」',
    [k[3]?.value, k[3]?.breakdown, k[3]?.create],
    [0, null, { entity: 'route', label: '新建线路' }],
  );
  const agent = inSaleKpi(catalogCounts([{ entity: ROUTE, items: [] }]), TRAVEL, { anon: false, editor: false });
  eq('在售数为 0：非编辑者没有新建链接', [agent.breakdown, agent.create], [['没有草稿'], undefined]);
  const noWaiting = memberKpis({
    counts: COUNTS,
    waiting: [],
    latestPaid: A02,
    catalog: catalogCounts(lists),
    pack: TRAVEL,
    editor: false,
    now: NOW,
  });
  eq('等人接手为空', noWaiting[1]?.breakdown, ['现在没有等人接手的会话']);
  const anon = inSaleKpi(
    catalogCounts([{ entity: ROUTE, items: ROUTES.filter((r) => r.status === 'active').map(({ status: _s, ...r }) => r) }]),
    TRAVEL,
    { anon: true, editor: false },
  );
  eq(
    '匿名的在售格：没有状态的条目都算在售，不画明细',
    [anon.value, anon.breakdown, anon.caption],
    [20, null, ['线路20，销售助手只推荐这些']],
  );
  // 已成交的数字是 conversationState 判成已成交的会话，即停在行业包终态的会话：口径写终态的阶段名，key 是不是 paid 都一样
  const paidCaption = (pack: IndustryPack) =>
    memberKpis({ counts: COUNTS, waiting: [], latestPaid: null, catalog: [], pack, editor: false, now: NOW })[2]?.caption;
  const live = TRAVEL.stages.filter((s) => !s.terminal);
  const deposit: IndustryPack = { ...TRAVEL, stages: [...live, { key: 'deposit', label: '已付定金', terminal: true }] };
  eq('已成交的口径：终态的 key 不是 paid 也写它的阶段名', paidCaption(deposit), ['阶段到了「已付定金」的会话']);
  const two: IndustryPack = {
    ...TRAVEL,
    stages: [...live, { key: 'deposit', label: '已付定金', terminal: true }, { key: 'paid', label: '已付全款', terminal: true }],
  };
  eq('已成交的口径：两个终态按包里的顺序都写', paidCaption(two), ['阶段到了「已付定金、已付全款」的会话']);
  eq('已成交的口径：包里没有终态时，不写阶段名', paidCaption({ ...TRAVEL, stages: live }), ['已成交的会话']);
}

// 客户停在哪一步
{
  const rows = stageRows(TRAVEL, COUNTS.aiByStage);
  eq(
    '阶段条：阶段名和顺序来自行业包，不含终态',
    rows.map((r) => [r.label, r.count, r.branch]),
    [
      ['开场', 0, false],
      ['问需', 4, false],
      ['推荐', 3, false],
      ['报价', 2, false],
      ['异议', 0, true],
      ['促成', 1, false],
    ],
  );
  eq(
    '阶段条：按最大值缩放（4 → 整条）',
    rows.map((r) => r.ratio),
    [0, 1, 0.75, 0.5, 0, 0.25],
  );
  eq(
    '阶段条：各行之和等于 AI 接待中',
    rows.reduce((n, r) => n + r.count, 0),
    COUNTS.byState.ai,
  );
  const shuffled: IndustryPack = { ...TRAVEL, stages: [TRAVEL.stages[4]!, ...TRAVEL.stages.filter((s) => s.key !== 'objection')] };
  eq(
    '阶段条：分支阶段排在它的主阶段后面（包里写在前面也一样）',
    stageRows(shuffled, COUNTS.aiByStage).map((r) => r.key),
    ['greeting', 'discovery', 'recommend', 'quote', 'objection', 'closing'],
  );
  const other = stageRows(TRAVEL, { ...COUNTS.aiByStage, handoff: 1, legacy: 2 });
  eq('阶段条：包里没有的阶段合成「其他」，不能点', other.at(-1), { key: null, label: '其他', count: 3, branch: false, ratio: 0.75 });
  eq(
    '阶段条：没有会话时不画条',
    stageRows(TRAVEL, {}).map((r) => r.ratio),
    [0, 0, 0, 0, 0, 0],
  );
  eq('阶段条：原型上的名字不算阶段', stageRows(TRAVEL, JSON.parse('{"toString": 5}')).at(-1)?.label, '其他');
  // 停在终态的会话由 conversationState 算作已成交，不是 AI 接待中：计数里即使带着终态，也不合进「其他」
  eq(
    '阶段条：终态不画，也不合进「其他」',
    stageRows(TRAVEL, { ...COUNTS.aiByStage, paid: 2, legacy: 1 })
      .slice(-2)
      .map((r) => [r.label, r.count]),
    [
      ['促成', 1],
      ['其他', 1],
    ],
  );
}

// 最近变更
{
  const itemName = (kind: string, code: string): string | undefined =>
    kind === 'route' && code === 'r-sichuan-lux' ? '四川 稻城亚丁·色达秘境 8 日' : undefined;
  const rows = timeline(AUDIT, TRAVEL, { itemName }, NOW);
  const text = (r: (typeof rows)[number]): string => `${r.actor.name} ${r.parts.map((p) => p.text).join('')}${r.tail ?? ''}`;
  eq('最近变更：先合并再取 5 句（设计系统 A 页）', rows.map(text), [
    '小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
    '小林 新建了6条酒店草稿',
    '小林 修改了线路「四川 稻城亚丁·色达秘境 8 日」的住宿档次、行程亮点',
    '老板 发布了话术v2，改了1节（异议处理）',
    '命令行 为xiaolin@yuntu.test建了账号（角色：管理员）',
  ]);
  eq(
    '最近变更：同一天只在第一条写日期',
    rows.map((r) => r.time),
    ['今天 13:40', '11:20', '10:12', '9月25日 18:30', '9月24日 10:05'],
  );
  eq(
    '最近变更：命令行不画头像；对象用 500',
    [rows[4]?.actor.human, rows[0]?.parts.filter((p) => p.strong).map((p) => p.text)],
    [false, ['贵州 小七孔·西江千户苗寨 5 日']],
  );
  eq('审计取够了：一次导入还没取完', enoughAudit(AUDIT.slice(0, 4), 26), false);
  eq('审计取够了：合出来多于 5 句', enoughAudit(AUDIT, 1), true);
  // 正好 5 句、第 5 句是被页边截断的一次导入：还要往前取，不然会写成「新建了3条酒店草稿」
  const cut = [AUDIT[0]!, AUDIT[7]!, AUDIT[8]!, AUDIT[9]!, ...AUDIT.slice(1, 4)];
  eq('审计取够了：正好 5 句还不算（第 5 句可能没取完）', [auditRuns(cut).length, enoughAudit(cut, 99)], [5, false]);
  eq('审计取够了：没有更早的记录', enoughAudit(AUDIT.slice(0, 2), null), true);
}

// ---------------- 2. 在 DOM 里挂载 ----------------
// 页面的「现在」取 Date.now()：钉在场景时刻（走查用 Playwright 的 page.clock.setFixedTime 做同样的事）
Date.now = () => NOW;

/** 另一份行业包：实体、阶段、叫法都不同，页面照样画（界面不认行业） */
const PKG = entity('package', '装修套餐', 'package', 'title', [f('$code', 'text', '套餐编号'), f('title', 'text', '套餐名称')]);
const MATERIAL = entity('material', '主材', 'layers', 'name', [f('$code', 'text', '主材编号'), f('name', 'text', '主材名称')]);
const HOME: IndustryPack = {
  ...TRAVEL,
  id: 'fixture-home',
  vocabulary: { ...TRAVEL.vocabulary, customer: '业主', productNoun: '方案' },
  entities: [PKG, MATERIAL],
  stages: [
    { key: 'consult', label: '咨询' },
    { key: 'measure', label: '量房' },
    { key: 'design', label: '方案' },
    { key: 'deposit', label: '已付定金', terminal: true },
  ],
  nav: { catalogGroup: '套餐与主材', entities: ['package', 'material'] },
};

interface Server {
  pack: IndustryPack;
  lists: Record<string, object[]>;
  /** 这些路径回 500 */
  fail?: RegExp;
  /** 这些请求先扣住，releaseHeld() 才回（测首次加载的先后） */
  hold?: RegExp;
  /** 审计每页最多给几条（不看请求的 limit），用来测按页往前取 */
  auditPage?: number;
  /** 等人接手的会话（默认 WAITING）与计数（默认 COUNTS） */
  waiting?: ConversationRow[];
  counts?: ConversationCounts;
  /** ?state=paid 回的最近一个已成交（默认 A02） */
  latestPaid?: ConversationRow;
  /** 每次请求等人接手的会话之前调用：用来模拟两次请求之间有人转人工 */
  onWaiting?: () => void;
  /** 「已成交客户要人工」（?group=paid_needs_human），默认空 */
  paidNeedsHuman?: ConversationRow[];
  /** 待付款订单（?status=pending_payment），默认空 */
  pendingOrders?: OrderView[];
  /** /orders 的 paymentMode（A2「等你确认价格」），默认 advisor */
  paymentMode?: 'online' | 'advisor';
  /** /orders/summary，默认 207,440 已付、85,600 待付（02 场景数） */
  ordersSummary?: OrderSummary;
  /** /metrics：undefined 时回 503 store_file_mode（文件存储），'fail' 回 500，否则回这个 MetricsView */
  metrics?: MetricsView | 'fail';
  /** 接手接口：:id 不在这个集合里就回 409 assigned_to_other（默认谁都能接手） */
  takeoverTaken?: Set<string>;
}
let server: Server = { pack: TRAVEL, lists: {} };
let requests: string[] = [];
const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

const DEFAULT_SUMMARY: OrderSummary = { month: '2026-09', paidTotal: 207_440, paidCount: 2, pendingTotal: 85_600, pendingCount: 1 };

function respond(method: string, url: URL): Response {
  const p = url.pathname.replace(/^\/api\/console/, '');
  const q = url.searchParams;
  if (server.fail?.test(`${method} ${p}`)) return json(500, { error: 'internal', detail: '故意的' });
  if (method === 'GET' && p === '/conversations/counts') return json(200, server.counts ?? COUNTS);
  if (method === 'GET' && p === '/conversations' && q.get('group') === 'paid_needs_human')
    return json(200, { items: server.paidNeedsHuman ?? [], total: (server.paidNeedsHuman ?? []).length });
  if (method === 'GET' && p === '/conversations' && q.get('state') === 'human') {
    // 照接口：按 (updatedAt 倒序, id) 排，再 offset 分页；不给 limit 时一页 20 个
    server.onWaiting?.();
    const all = [...(server.waiting ?? WAITING)].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const limit = q.has('limit') ? Number(q.get('limit')) : 20;
    const offset = q.has('offset') ? Number(q.get('offset')) : 0;
    return json(200, { items: all.slice(offset, offset + limit), total: all.length });
  }
  if (method === 'GET' && p === '/conversations' && q.get('state') === 'paid')
    return json(200, { items: [server.latestPaid ?? A02], total: 1 });
  if (method === 'GET' && p === '/conversations') return json(200, { items: [], total: 0 });
  if (method === 'POST' && /^\/conversations\/[^/]+\/takeover$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[2]!);
    if (server.takeoverTaken?.has(id)) return json(409, { error: 'assigned_to_other', assigneeName: '小林' });
    return json(200, { ok: true });
  }
  if (method === 'GET' && p === '/orders') {
    const status = q.get('status');
    const all = (server.pendingOrders ?? []).filter((o) => !status || o.status === status);
    return json(200, { items: all, total: all.length, paymentMode: server.paymentMode ?? 'advisor' });
  }
  if (method === 'GET' && p === '/orders/summary') return json(200, server.ordersSummary ?? DEFAULT_SUMMARY);
  if (method === 'GET' && p === '/metrics') {
    if (server.metrics === undefined) return json(503, { error: 'store_file_mode', detail: '文件存储下没有运行数字' });
    if (server.metrics === 'fail') return json(500, { error: 'internal', detail: '故意的' });
    return json(200, server.metrics);
  }
  if (method === 'GET' && p === '/sop') return json(200, SOP);
  if (method === 'POST' && p === '/sop/draft/check') return json(200, CHECK);
  if (method === 'GET' && p === '/status') return json(200, STATUS);
  if (method === 'GET' && p.startsWith('/catalog/')) {
    const kind = p.slice('/catalog/'.length);
    return Object.hasOwn(server.lists, kind) ? json(200, { items: server.lists[kind] }) : json(400, { error: 'bad_request' });
  }
  if (method === 'GET' && p === '/audit') {
    const before = q.has('before') ? Number(q.get('before')) : Infinity;
    const size = server.auditPage ?? Number(q.get('limit'));
    const allowed = new Set((q.get('actions') ?? '').split(','));
    const rows = AUDIT.filter((e) => e.id < before && allowed.has(e.action));
    const items = rows.slice(0, size);
    return json(200, { items, nextBefore: rows.length > size ? items.at(-1)!.id : null });
  }
  return json(404, { error: 'not_found' });
}

let held: Array<() => void> = [];
function releaseHeld(): void {
  const h = held;
  held = [];
  h.forEach((f) => f());
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url.pathname}${url.search}`);
  if (server.hold?.test(`${method} ${url.pathname.replace(/^\/api\/console/, '')}`))
    return new Promise<Response>((res) => held.push(() => res(respond(method, url))));
  return respond(method, url);
}) as typeof fetch;

const me = (role: Role): Me => ({ userId: 'u1', displayName: '老板', role, csrf: 'c1', tenantSlug: 'yuntu', tenantName: '云途定制旅行' });

/** 一个元素在总览的哪一块（按区块的类名，都不是就是「需要你处理」） */
const blockOf = (e: HTMLElement): string =>
  e.closest('.ov-recent')
    ? '最近变更'
    : e.closest('.ov-stages-block')
      ? '阶段'
      : e.closest('.ov-metrics-block')
        ? '运行数字'
        : e.closest('.ov-kpi-block')
          ? '业务数'
          : e.closest('.ov-system')
            ? '系统状态'
            : '需要你处理';

// 验收 6：页面上任何地方都不出现这五个词（设计系统 §11 只许用四种状态名）。每次挂载的总览记三份：首帧（请求都还没回来，
// 各块画着骨架）、载完、卸载前。每份是文字、标签页标题（页头写的「总览 · 租户名」），以及 title、aria-label、placeholder
// 这些读屏与悬停读得到的属性；另记下哪些块被扫到时画着骨架。最后（2.8）一起扫。
// 「顾问处理中」仍在这张表里：不是因为它整站不该出现（02 第 19 步起 I 页、铃铛已经会画它），是因为 A2「需要你处理」
// 本步没改（留给第 21 步），今天的数据源（等人接手、已成交客户要人工、待付款）里没有一行会落到 assigned 状态，
// 这一页此刻确实不该出现这个词；真正的四态断言在 console/src/parts/errors.selftest.ts（STATUS_LABEL 四态逐一核对）
const BANNED = ['顾问处理中', '待人工', '已转人工', '待接管', '需要介入'];
const SPOKEN_ATTRS = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt'];
const rendered: string[] = [];
const loadingSeen = new Set<string>();
let mounts = 0;
function seen(box: HTMLElement): void {
  const attrs = [...box.querySelectorAll('*')].flatMap((el) => SPOKEN_ATTRS.map((a) => el.getAttribute(a) ?? ''));
  rendered.push([document.title, box.textContent ?? '', ...attrs].join('\n'));
  for (const s of box.querySelectorAll<HTMLElement>('.state-skeleton')) loadingSeen.add(blockOf(s));
}

/** 等所有在飞的请求都回来（React Query 的 isFetching 回到 0），接手按钮点击之后的刷新、跳转也靠它结清 */
async function settle(qc: QueryClient): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0) break;
  }
}

/** 挂上真的 OverviewPage：路由只有它和几个空页（链接要能算出地址），查询缓存里放好来者；等请求都回来 */
async function mountOverview(viewer: Viewer, prefill: (qc: QueryClient) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(VIEWER_KEY, viewer);
  prefill(qc);
  const root = createRootRoute({ component: Outlet });
  const page = (path: string) => createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: OverviewPage }),
      page('/sop'),
      page('/audit'),
      page('/conversations'),
      page('/catalog/$kind'),
      page('/catalog/$kind/$code'),
      page('/catalog/new/$kind'),
      page('/conversations/$id'),
    ]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: ['/console/'] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  // 上一次挂载写的标签页标题不算这一次的
  document.title = '';
  mounts += 1;
  await act(async () =>
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never }))),
  );
  seen(box);
  await settle(qc);
  seen(box);
  const $ = (sel: string): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(sel)];
  return {
    box,
    $,
    qc,
    router,
    texts: (sel: string): string[] => $(sel).map((e) => (e.textContent ?? '').trim()),
    hrefs: (sel: string): string[] => $(sel).map((e) => e.getAttribute('href') ?? ''),
    /** 当前地址（路由里的，不带 basepath /console） */
    url: (): string => router.state.location.href,
    async click(el: Element | undefined) {
      if (!el) throw new Error('要点的元素不在页面上');
      await act(async () => {
        (el as HTMLElement).click();
      });
      await settle(qc);
    },
    async unmount() {
      seen(box);
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
    },
  };
}

const SCENE = { route: ROUTES, hotel: HOTELS };
const member = (role: Role, pack = TRAVEL): Viewer => ({ kind: 'member', me: me(role), pack });

// 2.1 所有者：七块都在（含 A2 的本月成交额与运行数字），内容与设计系统 A2 一致
{
  server = {
    pack: TRAVEL,
    lists: SCENE,
    paidNeedsHuman: [PAID_NEEDS_HUMAN],
    pendingOrders: [PENDING_B01],
    paymentMode: 'advisor',
    ordersSummary: DEFAULT_SUMMARY,
    metrics: METRICS,
  };
  requests = [];
  const m = await mountOverview(member('owner'));
  eq('所有者：区块顺序', m.texts('h2'), ['需要你处理', '最近变更', '客户停在哪一步']);
  eq('所有者：标签页标题', document.title, '总览 · 云途定制旅行');
  eq('所有者：页头状态句是租户名与日期', m.texts('.page-status'), ['云途定制旅行·9月26日 周六']);
  eq('需要你处理：7项（等人接手2 + 已成交客户要人工1 + 待付款1 + 话术草稿1 + 待上架2）', m.texts('.ov-count')[0], '7项');
  eq(
    '需要你处理：顺序（验收 16）：按金额（待付款 85,600 > 其余没有报价的 null）、没有报价的按沉默久在前（已成交客户要人工40分 > 等人接手26分 > 等人接手8分）、话术草稿、待上架',
    m.texts('.ov-todo-title'),
    [
      '企微客户·B01·巴厘岛2人',
      '企微客户·P01',
      '企微客户·A01·贵州带爸妈4人',
      '企微客户·F01',
      '改了2节：话术原则（+44字）、异议处理（+9字）',
      '线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
      '6条酒店草稿',
    ],
  );
  eq('需要你处理：上下文（原因、等待时长/下单多久未付；advisor 未确认写「等你确认价格」）', m.texts('.ov-todo-context'), [
    '85,600元·等你确认价格',
    '原因：已付款客户要退款·等了40分钟',
    '原因：客户要找顾问·等了26分钟',
    '原因：客户投诉价格太贵·等了8分钟',
    '1个问题：话术原则里有个工具名写错了·发布前检查6/7通过',
    '小林更新于13:40·必须项7/7已过·建议1条没做：体力强度没填（不拦上架）',
    '小林更新于11:20·青城山六善酒店、成都锦江宾馆、大研安缦等6条',
  ]);
  eq(
    '需要你处理：danger 是等了10分钟以上与话术问题，warning 是等了不到10分钟',
    [m.texts('.ov-danger'), m.texts('.ov-warning')],
    [['等了40分钟', '等了26分钟', '1个问题：话术原则里有个工具名写错了'], ['等了8分钟']],
  );
  eq('需要你处理：等待时长都带钟表图标（3 段等待时长 + 1 段话术问题，各带各的图标）', m.$('.ov-danger svg, .ov-warning svg').length, 4);
  eq('需要你处理：等人接手画状态胶囊，已成交客户要人工与待付款写死文字', m.$('.ov-todo .status-human').length, 2);
  eq('需要你处理：类型文字（等人接手是 Status 胶囊的文字，其余是写死的 13/500 text-3）', m.texts('.ov-todo-type'), [
    '待付款',
    '已成交客户要人工',
    '等人接手',
    '等人接手',
    '话术草稿',
    '待上架',
    '待上架',
  ]);
  // 等人接手、已成交客户要人工是真按钮（接手），不是链接；待付款、话术草稿、待上架仍是整行链接
  eq('需要你处理：接手行用真按钮，不是链接', m.$('.ov-todo-static button').length, 3);
  eq('需要你处理：待付款、话术草稿、待上架整行是链接（02 起不再新标签打开 admin.html）', m.hrefs('a.ov-todo'), [
    '/console/conversations/wecom%3Acust_B01',
    '/console/sop',
    '/console/catalog/route/r-guizhou-5d',
    '/console/catalog/hotel?status=draft',
  ]);
  check(
    '需要你处理：整行链接都在当前标签（没有 target=_blank）',
    m.$('a.ov-todo').every((a) => a.getAttribute('target') === null),
  );
  eq('需要你处理：操作（接手行不走这个幽灵小按钮，见下面的真按钮断言）', m.texts('.ov-todo-action'), [
    '打开会话',
    '继续编辑',
    '去上架',
    '逐条检查',
  ]);
  // antd 的 Button 给 2 个汉字的文字自动插入一个空格（视觉用），textContent 里也有，去掉再比
  eq(
    '需要你处理：接手按钮的文字',
    m.$('.ov-todo-static button').map((b) => (b.textContent ?? '').replace(/ /g, '')),
    ['接手', '接手', '接手'],
  );
  eq('本月成交额：数字与明细（宽于 1280 时在「需要你处理」右侧）', m.texts('.ov-todos-kpi .ov-kpi-value'), ['207,440']);
  eq('本月成交额：口径与明细', m.texts('.ov-todos-kpi .ov-kpi-caption, .ov-todos-kpi .ov-kpi-detail'), [
    '本月已付款订单的总额',
    '另有待付85,600元',
  ]);
  check('本月成交额：静态格不是链接（spec 没给「点了去」）', m.$('.ov-todos-kpi a').length === 0);
  eq('运行数字：四格的名称与数字', m.texts('.ov-metrics-block .ov-kpi-label'), [
    '回复用时（秒）',
    '转人工率',
    'AI出错率',
    '今天的AI费用（元）',
  ]);
  eq('运行数字：数字', m.texts('.ov-metrics-block .ov-kpi-value'), ['2', '12%', '3%', '18.62']);
  eq('运行数字：明细（文案不出现模型名）', m.texts('.ov-metrics-block .ov-kpi-detail'), ['近7天共96.40元']);
  check('运行数字：文案不出现模型名', !/gpt|glm|claude|qwen/i.test(m.$('.ov-metrics-block')[0]?.textContent ?? ''));
  eq('系统状态：一切正常', m.texts('.ov-system-line'), ['一切正常·线上话术v2·产品库改动已生效']);
  eq('业务数：数字', m.texts('.ov-kpi-block:not(.ov-metrics-block) .ov-kpi-value'), ['13', '2', '1', '43']);
  eq('业务数：明细', m.texts('.ov-kpi-block:not(.ov-metrics-block) .ov-kpi-detail'), [
    '今天有新动静的6个',
    '最后动静：26分钟前、8分钟前',
    '企微客户·A02·9月24日',
    '另有草稿7条：线路1·酒店6',
  ]);
  eq('业务数：整格链到筛选列表', m.hrefs('a.ov-kpi'), [
    '/console/conversations',
    '/console/conversations?state=human',
    '/console/conversations?state=paid',
    '/console/catalog/route',
  ]);
  eq('客户停在哪一步：计数', m.texts('.ov-stages-block .ov-count'), ['AI接待中的10个']);
  eq(
    '客户停在哪一步：每行链到这一阶段 AI 接待中的会话（验收 10 的「报价」）',
    m.hrefs('a.ov-stage'),
    ['greeting', 'discovery', 'recommend', 'quote', 'objection', 'closing'].map((s) => `/console/conversations?state=ai&stage=${s}`),
  );
  eq(
    '客户停在哪一步：0 的行不画条，异议缩进',
    m.$('.ov-stage').map((e) => [e.querySelector('.ov-stage-bar') !== null, e.classList.contains('is-branch')]),
    [
      [false, false],
      [true, false],
      [true, false],
      [true, false],
      [false, true],
      [true, false],
    ],
  );
  eq('客户停在哪一步：区块头链到 AI 接待中', m.hrefs('.ov-stages-block .ov-head-link'), ['/console/conversations?state=ai']);
  eq('最近变更：时间', m.texts('.ov-tl-time'), ['今天 13:40', '11:20', '10:12', '9月25日 18:30', '9月24日 10:05']);
  eq('最近变更：句子', m.texts('.ov-tl-text'), [
    '小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
    '小林 新建了6条酒店草稿',
    '小林 修改了线路「四川 稻城亚丁·色达秘境 8 日」的住宿档次、行程亮点',
    '老板 发布了话术v2，改了1节（异议处理）',
    '命令行 为xiaolin@yuntu.test建了账号（角色：管理员）',
  ]);
  // 头像写名字的首字（设计系统 §6.8，与侧栏用户行相同）
  eq('最近变更：头像与命令行方块', [m.texts('.ov-timeline .avatar'), m.$('.ov-tl-bot').length], [['小', '小', '小', '老'], 1]);
  eq('最近变更：查看全部', m.hrefs('.ov-all'), ['/console/audit']);
  const auditReq = requests.filter((r) => r.startsWith('GET /api/console/audit'));
  check(
    '最近变更：不含登录记录，一页就取够',
    auditReq.length === 1 && !auditReq[0]!.includes('auth.login') && auditReq[0]!.includes('catalog.create'),
    auditReq.join(' | '),
  );
  eq('草稿检查只发一次', requests.filter((r) => r === 'POST /api/console/sop/draft/check').length, 1);
  check('所有者：没有「没取到」', !m.box.textContent?.includes('没取到'));
  await m.unmount();
}

// 2.2 某个接口出错：只有用它的那一块写「没取到」，其余照常（验收 10）
async function failing(fail: RegExp) {
  server = { pack: TRAVEL, lists: SCENE, fail };
  const m = await mountOverview(member('owner'));
  const errs = m.$('.ant-alert').filter((a) => a.textContent?.includes('没取到'));
  const out = {
    blocks: errs.map(blockOf),
    // 自测没套 ThemeProvider，antd 会在两个汉字的按钮中间插空格
    retry: errs.map((a) => [...a.querySelectorAll('button')].some((b) => (b.textContent ?? '').replace(/\s/g, '') === '重试')),
    todos: m.$('.ov-todo-title').length,
    // 「本月成交额」是「需要你处理」旁边的格（.ov-todos-kpi），不在业务数的 .ov-kpi-block 里，这里只数业务数的 4 格
    kpis: m.$('.ov-kpi-block .ov-kpi-value').length,
    stages: m.$('.ov-stage').length,
    timeline: m.$('.ov-tl-text').length,
    system: m.texts('.ov-system-line').join(''),
    context: m.texts('.ov-todo-context'),
  };
  await m.unmount();
  return out;
}
{
  const a = await failing(/^GET \/audit$/);
  eq('/audit 500：只有「最近变更」写「没取到 · 重试」', [a.blocks, a.retry], [['最近变更'], [true]]);
  eq('/audit 500：其余块正常', [a.todos, a.kpis, a.stages, a.system], [5, 4, 6, '一切正常·线上话术v2·产品库改动已生效']);
  const s = await failing(/^GET \/status$/);
  eq('/status 500：只有系统状态出错', [s.blocks, s.todos, s.kpis, s.timeline], [['系统状态'], 5, 4, 5]);
  const c = await failing(/^GET \/conversations\/counts$/);
  eq(
    'counts 500：业务数与阶段条出错，待办与最近变更照常',
    [c.blocks, c.todos, c.timeline, c.system !== ''],
    [['业务数', '阶段'], 5, 5, true],
  );
  const k = await failing(/^POST \/sop\/draft\/check$/);
  eq(
    '检查 500：待办照列，话术草稿不写检查结果，块里写「没取到」',
    [k.blocks, k.todos, k.context.some((c) => c.includes('发布前检查'))],
    [['需要你处理'], 5, false],
  );
  const h = await failing(/^GET \/catalog\/hotel$/);
  eq('一个实体的列表 500：待办里只少这一行，业务数出错', [h.blocks, h.todos, h.stages], [['需要你处理', '业务数'], 4, 6]);
}

// 2.2b 首次加载的先后（验收 23 的 CLS）：「需要你处理」的行数定下来之前（等人接手、话术、各实体列表），下面各块照常挂上、
// 各自取数，但包在不显示的 .ov-below 里，免得待办一到把它们推下去。行数定了就显示；这时还在等的发布前检查由按真实行数画的
// 骨架占位（检查只往话术那一行里补字）。行数一直定不下来（这里扣住酒店列表）时，过了 TODO_WAIT_MS 也显示
{
  const css = fs.readFileSync(path.join(import.meta.dirname, 'overview.css'), 'utf8');
  check(
    'overview.css：.ov-below 不占盒子，.ov-below.is-waiting 不显示',
    /\.ov-below \{\s*display: contents;\s*\}/.test(css) && /\.ov-below\.is-waiting \{\s*display: none;\s*\}/.test(css),
  );
  // 检查慢时骨架按真实行数画，它也得与真实的行一样高，不然检查一回来，下面的块照样被推。happy-dom 不排版，量不了 CLS
  // （375 宽的 CLS 由走查环境实测，见验收 23 的记录），这里从 overview.css 读出来比：每条骨架（条高加上下外边距）
  // 等于它代替的那一行字的行高（类型、对象、上下文），骨架的对象与上下文之间不另设间距（与真实的行一样是 .ov-todo-main 的 2px）
  // 顶层、只有这一个选择器的规则（不取 @media 里缩进的，也不取「a,\nb {」这种选择器列表）
  const rule = (sel: string): string =>
    new RegExp(`(?<!,\\n)^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
  const px = (sel: string, prop: string): number | null => {
    const v = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px;`).exec(rule(sel))?.[1];
    return v === undefined ? null : Number(v);
  };
  const bar = px('.ov-todo-skeleton .skeleton-bar', 'height');
  const barRow = (sel: string): number | null => {
    const m = px(sel, 'margin-block');
    return bar === null || m === null ? null : bar + 2 * m;
  };
  eq(
    'overview.css：骨架每条占满它代替的那行字的行高（类型、对象、上下文），对象与上下文之间不另设间距',
    [
      barRow('.ov-todo-skeleton > .skeleton-bar'),
      barRow('.ov-todo-skeleton .ov-todo-main > .skeleton-bar:first-child'),
      barRow('.ov-todo-skeleton .ov-todo-main > .skeleton-bar:last-child'),
      /\.ov-todo-skeleton[^{]*\{[^}]*\bgap:/.test(css),
    ],
    [px('.ov-todo-type', 'line-height'), px('.ov-todo-title', 'line-height'), px('.ov-todo-context', 'line-height'), false],
  );
  const tick = () =>
    act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await tick();
  };
  const blocks = (b: Element | undefined) =>
    ['.ov-system', '.ov-kpi-block', '.ov-recent', '.ov-stages-block'].filter((sel) => b?.querySelector(sel)).length;
  const below = (m: { $(sel: string): HTMLElement[] }): string | undefined => m.$('.ov-below')[0]?.className;

  // 扣住一份实体列表：行数定不下来
  server = { pack: TRAVEL, lists: SCENE, hold: /^GET \/catalog\/hotel$/ };
  requests = [];
  // Date.now 钉在场景时刻，量真实耗时用 performance.now()
  const t0 = performance.now();
  const m = await mountOverview(member('owner'));
  const waited = Math.round(performance.now() - t0);
  eq(
    `行数没定：下面四块都挂上了、请求也发了，但还不显示；待办是 3 行的骨架（挂载用了 ${waited}ms，不到 ${TODO_WAIT_MS}ms）`,
    [
      waited < TODO_WAIT_MS,
      m.$('.ov-todo-skeleton').length,
      below(m),
      blocks(m.$('.ov-below')[0]),
      requests.filter((r) => /^GET \/api\/console\/(status|audit)\b/.test(r)).length >= 2,
      m.$('.ov-below .ov-kpi-value').length,
    ],
    [true, 3, 'ov-below is-waiting', 4, true, 0],
  );
  releaseHeld();
  await settle();
  eq(
    '行数定了、全都回来：下面的块显示，待办是真实的 5 行',
    [below(m), m.$('.ov-todo-title').length, m.$('.ov-todo-skeleton').length],
    ['ov-below', 5, 0],
  );
  await m.unmount();

  // 扣住发布前检查：行数已经定了
  server = { pack: TRAVEL, lists: SCENE, hold: /^POST \/sop\/draft\/check$/ };
  const c = await mountOverview(member('owner'));
  eq(
    '只差发布前检查：下面的块已经显示，待办的骨架按真实行数画 5 行',
    [below(c), c.$('.ov-todo-skeleton').length, c.$('.ov-todo-title').length, c.$('.ov-below .ov-kpi-value').length],
    ['ov-below', 5, 0, 4],
  );
  eq(
    '骨架每行是 overview.css 量行高时假定的结构：一条代替类型，.ov-todo-main 里两条代替对象和上下文',
    [c.$('.ov-todo-skeleton > .skeleton-bar').length, c.$('.ov-todo-skeleton > .ov-todo-main > .skeleton-bar').length],
    [5, 10],
  );
  releaseHeld();
  await settle();
  eq('检查回来：5 行骨架换成 5 行待办', [c.$('.ov-todo-title').length, c.$('.ov-todo-skeleton').length], [5, 0]);
  await c.unmount();

  // 行数一直定不下来：过了上限照样显示
  server = { pack: TRAVEL, lists: SCENE, hold: /^GET \/catalog\/hotel$/ };
  const slow = await mountOverview(member('owner'));
  check('行数一直定不下来：先不显示', below(slow) === 'ov-below is-waiting');
  await act(async () => {
    await new Promise((res) => setTimeout(res, TODO_WAIT_MS + 50));
  });
  eq(`过了 ${TODO_WAIT_MS}ms 还没定：下面的块照样显示，待办还是骨架`, [below(slow), slow.$('.ov-todo-skeleton').length], ['ov-below', 3]);
  releaseHeld();
  await settle();
  await slow.unmount();
}

// 2.3 坐席：没有「最近变更」和草稿类待办，也不发这些请求；右栏挪到左栏的位置
{
  server = { pack: TRAVEL, lists: SCENE };
  requests = [];
  const m = await mountOverview(member('agent'));
  eq('坐席：区块', m.texts('h2'), ['需要你处理', '客户停在哪一步']);
  eq('坐席：待办只有等人接手', m.texts('.ov-todo-title'), ['企微客户·A01·贵州带爸妈4人', '企微客户·F01']);
  eq('坐席：2项', m.texts('.ov-count')[0], '2项');
  check('坐席：底部只剩一栏', m.$('.ov-bottom.is-single').length === 1 && m.$('.ov-recent').length === 0);
  eq('坐席：业务数四格都在，没有本月成交额与运行数字（只给所有者、管理员）', m.$('.ov-kpi').length, 4);
  eq('坐席：能处理会话，等人接手行有真按钮「接手」', m.$('.ov-todo-static button').length, 2);
  const sent = requests.filter((r) => /\/sop|\/audit/.test(r));
  eq('坐席：不取话术、检查、审计', sent, []);
  check('坐席：页头有「只读」胶囊', m.$('.readonly-pill').length === 1);
  await m.unmount();
}
{
  // 没有要处理的事：一句说明，不放按钮
  server = {
    pack: TRAVEL,
    lists: { route: ROUTES.filter((r) => r.status === 'active'), hotel: HOTELS.filter((h) => h.status === 'active') },
  };
  const saved = WAITING.splice(0);
  const m = await mountOverview(member('owner'));
  const sop0 = SOP.draft;
  eq('没有要处理的事（有话术草稿时照列）', m.texts('.ov-todo-title'), ['改了2节：话术原则（+44字）、异议处理（+9字）']);
  await m.unmount();
  (SOP as { draft: unknown }).draft = null;
  const e = await mountOverview(member('owner'));
  eq(
    '没有要处理的事：空状态',
    [e.texts('.state-empty-title'), e.$('.state-empty button').length, e.texts('.ov-count')[0]],
    [['没有要处理的事'], 0, '0项'],
  );
  await e.unmount();
  (SOP as { draft: unknown }).draft = sop0;
  WAITING.push(...saved);
}

// 2.3b 在售数为 0（只有草稿）：编辑者的在售格写「新建{实体名}」、整格链到新建；坐席照旧链到列表，不写新建
{
  server = {
    pack: TRAVEL,
    lists: { route: ROUTES.filter((r) => r.status === 'draft'), hotel: HOTELS.filter((h) => h.status === 'draft') },
  };
  const o = await mountOverview(member('owner'));
  eq(
    '在售数为 0：所有者的在售格链到新建第一个实体',
    [o.texts('.ov-kpi-block .ov-kpi-value')[3], o.texts('.ov-kpi-create'), o.hrefs('a.ov-kpi')[3]],
    ['0', ['新建线路'], '/console/catalog/new/route'],
  );
  await o.unmount();
  const a = await mountOverview(member('agent'));
  eq(
    '在售数为 0：坐席的在售格链到列表，没有新建',
    [a.texts('.ov-kpi-block .ov-kpi-value')[3], a.texts('.ov-kpi-create'), a.hrefs('a.ov-kpi')[3]],
    ['0', [], '/console/catalog/route'],
  );
  await a.unmount();
}

// 2.4 demo 匿名：横幅，只有在售一格，只取产品库列表
{
  const anonList = (xs: CatalogItem[]) =>
    xs.filter((x) => x.status === 'active').map((x) => ({ kind: x.kind, code: x.code, payload: x.payload }));
  server = { pack: TRAVEL, lists: { route: anonList(ROUTES), hotel: anonList(HOTELS) } };
  requests = [];
  const m = await mountOverview({ kind: 'anon', pack: TRAVEL });
  eq('匿名：没有待办、阶段、最近变更、系统状态', [m.texts('h2'), m.$('.ov-system').length], [[], 0]);
  eq('匿名：只有在售一格', [m.texts('.ov-kpi-label'), m.texts('.ov-kpi-value'), m.$('.ov-kpi-detail').length], [['在售产品'], ['43'], 0]);
  eq('匿名：只取产品库列表', [...new Set(requests)].sort(), ['GET /api/console/catalog/hotel', 'GET /api/console/catalog/route']);
  check('匿名：演示横幅；页头不写租户名', m.$('.anon-banner').length === 1 && m.texts('.page-status')[0] === '9月26日 周六');
  eq('匿名：标签页标题', document.title, '总览 · 演示');
  await m.unmount();
}

// 2.4b 外壳刚取过的数据（侧栏条目数、计数）总览不重取：匿名访客的查询按 IP 限流。
// 铃铛那一页是最新的 20 个，总览要等得最久的那些，另取一次
{
  server = { pack: TRAVEL, lists: SCENE };
  requests = [];
  const fresh = (qc: QueryClient): void => {
    qc.setQueryData(catalogListQuery('route').queryKey, { items: ROUTES } as never);
    qc.setQueryData(catalogListQuery('hotel').queryKey, { items: HOTELS } as never);
    qc.setQueryData(conversationCountsQuery.queryKey, COUNTS as never);
    qc.setQueryData(waitingConversationsQuery.queryKey, { items: WAITING, total: WAITING.length } as never);
  };
  const m = await mountOverview(member('owner'), fresh);
  eq(
    '外壳刚取过的计数与列表不重取；等人接手只取一次最早的一页',
    requests.filter((r) => /\/catalog\/|\/conversations\/counts|state=human/.test(r)),
    ['GET /api/console/conversations?state=human&limit=100'],
  );
  eq('用的是缓存里的数', [m.texts('.ov-kpi-block .ov-kpi-value'), m.texts('.ov-todo-title').length], [['13', '2', '1', '43'], 5]);
  await m.unmount();
}

// 2.4c 等人接手多于接口的默认一页：接口不给 limit 时只回最新的 20 个，等得最久的会被漏掉
/** n 个更早转人工的会话：W01 在 1.5 小时前，之后每个再早 1 小时，Wn 最早 */
const olderWaiting = (n: number): ConversationRow[] =>
  Array.from({ length: n }, (_, i) =>
    conv(`W${String(i + 1).padStart(3, '0')}`, 'handoff', true, 3, new Date(NOW - 30 * MIN - (i + 1) * 60 * MIN).toISOString()),
  );
const waitingTitles = (titles: string[]): string[] => titles.filter((t) => t.startsWith('企微客户'));
const humanRequests = (): string[] => requests.filter((r) => r.includes('state=human'));
{
  const many = [...WAITING, ...olderWaiting(25)];
  const byState = { ai: 10, human: 27, assigned: 0, paid: 1 };
  server = { pack: TRAVEL, lists: SCENE, waiting: many, counts: { ...COUNTS, total: 38, byState } };
  requests = [];
  const m = await mountOverview(member('owner'));
  const titles = waitingTitles(m.texts('.ov-todo-title'));
  eq('等人接手 27 个：计数按总数（27 个会话、话术草稿、2 行待上架）', m.texts('.ov-count')[0], '30项');
  eq(
    '等人接手 27 个：等得最久的在最前，一个不漏',
    [titles[0], titles.at(-1), titles.length, m.$('.ov-todo').length],
    ['企微客户·W025', '企微客户·F01', 27, 30],
  );
  const oldest = [25, 24, 23].map((i) => relativeTime(many[i + 1]!.updatedAt, NOW));
  eq('等人接手 27 个：「等人接手」格写最早的三个', m.texts('.ov-kpi-block .ov-kpi-detail')[1], `最后动静：${oldest.join('、')}等27个`);
  eq('等人接手 27 个：一页取完，带上 limit', humanRequests(), ['GET /api/console/conversations?state=human&limit=100']);
  await m.unmount();
}
{
  // 多于一整页（100）：取最后一页（等得最久的 100 个），其余写成一行「还有5个」链到会话列表
  const lots = [...WAITING, ...olderWaiting(103)];
  server = {
    pack: TRAVEL,
    lists: SCENE,
    waiting: lots,
    counts: { ...COUNTS, total: 116, byState: { ai: 10, human: 105, assigned: 0, paid: 1 } },
  };
  requests = [];
  const m = await mountOverview(member('owner'));
  const titles = waitingTitles(m.texts('.ov-todo-title'));
  eq('等人接手 105 个：计数按总数', m.texts('.ov-count')[0], '108项');
  eq('等人接手 105 个：列出等得最久的 100 个', [titles[0], titles.at(-1), titles.length], ['企微客户·W103', '企微客户·W004', 100]);
  const more = m.$('a.ov-todo').find((a) => a.textContent?.includes('还有'));
  eq(
    '等人接手 105 个：没列的写成一行，链到等人接手页签',
    [more?.querySelector('.ov-todo-title')?.textContent, more?.getAttribute('href'), more?.getAttribute('target')],
    ['还有5个等人接手的会话', '/console/conversations?state=human', null],
  );
  eq('等人接手 105 个：先取一页拿到总数，再取最后一页', humanRequests(), [
    'GET /api/console/conversations?state=human&limit=100',
    'GET /api/console/conversations?state=human&limit=100&offset=5',
  ]);
  await m.unmount();
}
{
  // 两次请求之间又有人转人工：按新的总数再取一次最后一页，等得最久的不被挤掉
  const lots = [...WAITING, ...olderWaiting(103)];
  let calls = 0;
  const onWaiting = (): void => {
    calls += 1;
    if (calls === 2) lots.push(conv('N01', 'handoff', true, 1, new Date(NOW - MIN).toISOString()));
  };
  server = { pack: TRAVEL, lists: SCENE, waiting: lots, onWaiting };
  requests = [];
  const m = await mountOverview(member('owner'));
  const titles = waitingTitles(m.texts('.ov-todo-title'));
  eq(
    '总数在两次请求之间变了：按新的总数重取',
    [titles[0], titles.length, m.texts('.ov-count')[0], humanRequests().length],
    ['企微客户·W103', 100, '109项', 3],
  );
  await m.unmount();
}

// 2.5 审计按页往前取：每页只给 4 条时，一次导入的 6 条也合成一句
{
  server = { pack: TRAVEL, lists: SCENE, auditPage: 4 };
  requests = [];
  const m = await mountOverview(member('admin'));
  eq('审计分页：句子不被截断', m.texts('.ov-tl-text').slice(0, 3), [
    '小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」',
    '小林 新建了6条酒店草稿',
    '小林 修改了线路「四川 稻城亚丁·色达秘境 8 日」的住宿档次、行程亮点',
  ]);
  const pages = requests.filter((r) => r.startsWith('GET /api/console/audit'));
  check(
    '审计分页：取到合出 6 句为止（3 页）',
    pages.length === 3 && pages[1]!.includes('before=') && !pages[0]!.includes('before='),
    pages.join(' | '),
  );
  await m.unmount();
}

// 2.6 换一个行业包：实体、阶段、叫法都跟着换，请求的是这个包的 kind
{
  const PKG_ITEMS = [
    item('package', 'p-1', { id: 'p-1', title: '暖木 · 两居全包经典版' }, 'draft', at('2026-09-26T09:00:00'), '小林'),
    item('package', 'p-2', { id: 'p-2', title: '现代简约三居' }, 'active', at('2026-09-24T09:00:00')),
  ];
  const MAT_ITEMS = [item('material', 'm-1', { id: 'm-1', name: '实木地板' }, 'active', at('2026-09-24T09:00:00'))];
  // 服务端按家装包的终态判已成交：最近一个已成交停在「已付定金」
  server = {
    pack: HOME,
    lists: { package: PKG_ITEMS, material: MAT_ITEMS },
    latestPaid: conv('H03', 'deposit', false, 9, at('2026-09-25T14:00:00')),
  };
  requests = [];
  const m = await mountOverview(member('owner', HOME));
  eq('别的行业包：待上架', m.texts('.ov-todo-title').slice(3), ['装修套餐草稿「暖木 · 两居全包经典版」']);
  // a.ov-todo 只有真正的链接行：等人接手两行现在是真按钮（div.ov-todo-static），不是链接，所以这里只有 sop、catalog 两个
  eq('别的行业包：待上架链到这个包的实体与编号', m.hrefs('a.ov-todo').slice(1), ['/console/catalog/package/p-1']);
  eq(
    '别的行业包：在售格',
    [m.texts('.ov-kpi-block .ov-kpi-label')[3], m.texts('.ov-kpi-block .ov-kpi-caption')[3], m.texts('.ov-kpi-block .ov-kpi-detail')[3]],
    ['在售方案', '装修套餐1·主材1，销售助手只推荐这些', '另有草稿1条：装修套餐1'],
  );
  // 已成交按行业包的终态判定：家装包的终态「已付定金」就是口径（key 不是 paid）
  eq(
    '别的行业包：已成交格的口径写终态「已付定金」，明细是停在那里的会话',
    [m.texts('.ov-kpi-block .ov-kpi-label')[2], m.texts('.ov-kpi-block .ov-kpi-caption')[2], m.texts('.ov-kpi-block .ov-kpi-detail')[2]],
    ['已成交', '阶段到了「已付定金」的会话', '企微业主·H03·9月25日'],
  );
  eq('别的行业包：阶段条', m.texts('.ov-stage-label'), ['咨询', '量房', '方案', '其他']);
  eq('别的行业包：系统状态的产品库叫法', m.texts('.ov-system-line'), ['一切正常·线上话术v2·套餐与主材改动已生效']);
  eq('别的行业包：请求这个包的实体', [...new Set(requests.filter((r) => r.includes('/catalog/')))].sort(), [
    'GET /api/console/catalog/material',
    'GET /api/console/catalog/package',
  ]);
  check('别的行业包：页面上没有旅游包的实体名', !/线路|酒店/.test(m.box.textContent ?? ''), m.box.textContent ?? '');
  await m.unmount();
}

// 2.7 从阶段条、业务数跳到会话列表之后，地址里的 state、stage 进到接口查询、页签与阶段条的选中：
// 随第 13 步挪到会话列表自己的自测（console/src/conversations/conversations.selftest.tsx）

// 2.9 权限矩阵（02 spec「后台接口」权限表、本步验收 16）：本月成交额、运行数字只给所有者、管理员（canSeeMoney 同一条件）；
// 「接手」按钮只给能处理会话的角色（owner/admin/supervisor/agent，CAN_HANDLE_ROLES），viewer 看得到行但没有按钮
{
  server = {
    pack: TRAVEL,
    lists: SCENE,
    paidNeedsHuman: [],
    pendingOrders: [PENDING_B01],
    paymentMode: 'advisor',
    metrics: METRICS,
  };
  for (const role of ['owner', 'admin'] as const) {
    const m = await mountOverview(member(role));
    check(
      `${role}：看得到本月成交额与运行数字`,
      m.$('.ov-todos-kpi .ov-kpi-value').length === 1 && m.$('.ov-metrics-block').length === 1,
      `${role}: kpi=${m.$('.ov-todos-kpi .ov-kpi-value').length} metrics=${m.$('.ov-metrics-block').length}`,
    );
    eq(`${role}：等人接手行有真按钮「接手」`, m.$('.ov-todo-static button').length, WAITING.length);
    await m.unmount();
  }
  for (const role of ['supervisor', 'agent', 'viewer'] as const) {
    const m = await mountOverview(member(role));
    check(
      `${role}：看不到本月成交额与运行数字`,
      m.$('.ov-todos-kpi').length === 0 && m.$('.ov-metrics-block').length === 0,
      `${role}: kpi=${m.$('.ov-todos-kpi').length} metrics=${m.$('.ov-metrics-block').length}`,
    );
    await m.unmount();
  }
  // supervisor、agent 能处理会话：等人接手行有真按钮；viewer 不能：待办行还在，但没有按钮（403 真发生不了，不用等服务端拒绝）
  const sup = await mountOverview(member('supervisor'));
  eq('supervisor：有接手按钮', sup.$('.ov-todo-static button').length, WAITING.length);
  await sup.unmount();
  const v = await mountOverview(member('viewer'));
  eq(
    'viewer：等人接手行还在、原因与等待时长照写，但没有接手按钮',
    [v.texts('.ov-todo-title').length > 0, v.$('.ov-todo-static button').length],
    [true, 0],
  );
  await v.unmount();
}

// 2.9b 运行数字的三态（02 spec「可观测性与告警」）：文件存储（/metrics 503 store_file_mode）整块不画，不是写「没取到」；
// 别的出错就地重试；骨架在数据回来之前
{
  // 文件存储：server.metrics 不给，mock 的 /metrics 回 503 store_file_mode
  server = { pack: TRAVEL, lists: SCENE };
  const m = await mountOverview(member('owner'));
  check('文件存储：运行数字整块不画（不是「没取到」）', m.$('.ov-metrics-block').length === 0 && !m.box.textContent?.includes('没取到'));
  await m.unmount();

  // 别的出错（500）：就地写「没取到 · 重试」，点重试重新发请求
  server = { pack: TRAVEL, lists: SCENE, metrics: 'fail' };
  requests = [];
  const e = await mountOverview(member('owner'));
  const errBlock = e.$('.ov-metrics-block');
  check(
    '运行数字出错：就地写「没取到」加重试，不影响其余块',
    errBlock.length === 1 && (errBlock[0]?.textContent ?? '').includes('没取到') && !e.box.textContent?.includes('小林处理中'),
  );
  server.metrics = METRICS;
  const retryBtn = [...e.$('.ov-metrics-block button')].find((b) => (b.textContent ?? '').replace(/ /g, '') === '重试');
  await e.click(retryBtn);
  eq('运行数字出错：重试之后显示真实数字', e.texts('.ov-metrics-block .ov-kpi-value'), ['2', '12%', '3%', '18.62']);
  check('运行数字出错：确实重新发了一次 /metrics', requests.filter((r) => r.startsWith('GET /api/console/metrics')).length >= 2);
  await e.unmount();
}

// 2.10 接手：成功后打开 J 页；409（assigned_to_other）就地说明，不丢弹窗、不跳转（brief「范围」）
{
  server = { pack: TRAVEL, lists: SCENE, takeoverTaken: new Set(['wecom:cust_A01']) };
  const m = await mountOverview(member('owner'));
  const buttons = m.$('.ov-todo-static button');
  // 行的顺序是等得最久的在前：A01（26分钟）排在 F01（8分钟）前面
  eq('接手行的顺序：A01 在前', m.texts('.ov-todo-title').slice(0, 2), ['企微客户·A01·贵州带爸妈4人', '企微客户·F01']);
  await m.click(buttons[0]);
  eq(
    '接手 409（别人正在处理）：就地说明，不导航离开',
    [m.texts('.ov-todo-error'), m.url().startsWith('/conversations/')],
    [['小林正在处理这个会话'], false],
  );
  await m.click(buttons[1]);
  eq('接手成功：打开这个会话的 J 页', m.url(), '/conversations/wecom%3Acust_F01');
  await m.unmount();
}
{
  // 接手之后另一行的 409 不该互相污染（接手提到了 TodoBlock 一级，但按 id 分开记错误，不是只有一份全局状态）
  server = { pack: TRAVEL, lists: SCENE, takeoverTaken: new Set() };
  const m = await mountOverview(member('supervisor'));
  const buttons = m.$('.ov-todo-static button');
  await m.click(buttons[0]);
  eq('接手成功（没有人占着）：打开 J 页', m.url(), '/conversations/wecom%3Acust_A01');
  await m.unmount();
}

// 2.10b 审查 major：请求还在飞的时候，这一行被事件流触发的重取刷掉（另一个成员先接手走了），随后到的 409
// 要挪到区块顶部显示，不能跟着卸载的行一起消失（overview.selftest 本来没有 SSE，这里直接调 qc.invalidateQueries
// 模拟 shell/live.ts 的 invalidateConversations 在同一时刻做的事）
{
  server = { pack: TRAVEL, lists: SCENE, hold: /^POST \/conversations\/[^/]+\/takeover$/ };
  const m = await mountOverview(member('owner'));
  const titleOf = (): string[] => m.texts('.ov-todo-title');
  const a01Index = titleOf().findIndex((t) => t.includes('A01'));
  check('A01 这一行在，先点它的接手（请求被扣住，还没回来）', a01Index >= 0);
  await m.click(m.$('.ov-todo-static button')[a01Index]);
  // 这期间事件流让列表重取：A01 被另一个成员接手走了，服务端的等人接手列表里已经没有它，随后那一下会是 409
  server.waiting = WAITING.filter((w) => w.id !== 'wecom:cust_A01');
  server.takeoverTaken = new Set(['wecom:cust_A01']);
  await act(async () => void (await m.qc.invalidateQueries({ queryKey: ['conversations'] })));
  await settle(m.qc);
  check('A01 这一行已经被刷掉（不是还在、只是还没显示）', !titleOf().some((t) => t.includes('A01')));
  releaseHeld();
  await settle(m.qc);
  eq('行已经不在了：409 的就地说明挪到区块顶部，带会话短码，不是静默丢掉', m.texts('.ov-todos-banner-item'), ['A01：小林正在处理这个会话']);
  check('说明带「关掉」按钮', m.$('.ov-todos-banner-close').length === 1);
  await m.click(m.$('.ov-todos-banner-close')[0]);
  eq('点「关掉」之后说明消失', m.texts('.ov-todos-banner-item'), []);
  await m.unmount();
}

// 2.8 验收 6 的禁用词：上面挂过的每一份总览（所有者、管理员、坐席、匿名，各块出错、扣住请求的先后，另一个行业包）
check(
  '禁用词（验收 6）：每次挂载都扫了首帧、载完与卸载前三份',
  mounts > 0 && rendered.length === mounts * 3,
  `挂载 ${mounts} 次，扫了 ${rendered.length} 份`,
);
eq(
  '禁用词（验收 6）：六块画骨架（载入中）时都扫到了（02 新增运行数字）',
  [...loadingSeen].sort(),
  ['需要你处理', '系统状态', '业务数', '运行数字', '最近变更', '阶段'].sort(),
);
for (const w of BANNED) {
  const hit = rendered.find((t) => t.includes(w));
  const at = hit?.indexOf(w) ?? -1;
  check(
    `禁用词（验收 6）：总览里没有「${w}」`,
    !hit,
    hit ? `出现在「${hit.slice(Math.max(0, at - 16), at + w.length + 16).replace(/\s+/g, ' ')}」` : '',
  );
}

if (fails.length) {
  console.error(`overview: ${fails.length} 条断言失败（通过 ${pass} 条）`);
  for (const x of fails) console.error(`  ✗ ${x}`);
  process.exit(1);
}
console.log(`overview: ${pass} 条断言全部通过`);
process.exit(0);
