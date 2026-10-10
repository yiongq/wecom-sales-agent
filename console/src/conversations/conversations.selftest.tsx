// 会话列表的自测（02 spec「后台页面 · 会话列表（I 页）」、验收 6、10、20，不变量 17、18、45，设计系统 §10.0、§10.2 I 页，
// plan 第 13、19 步）。数据照设计系统 §10.0 的 13 个会话（时刻 2026-09-26 周六 14:30，Asia/Shanghai，handoff 全是 null——
// 这是 02 之前的老场景，验收 6 要求照旧能跑通）。行业包是本文件里手写的夹具（旅游式、家装式各一份）：
// console 里只有渲染器自测能 import 注册表和假包（scripts/check-boundaries.ts）。
// 1. 纯逻辑（model.ts、conversations-search.ts）：地址参数的取舍（不合规的丢掉、键总是写出来）；页签的顺序、名字与计数，
//    「顾问处理中」只在有这种会话或地址选了它时出现；换页签、点阶段条、清除阶段、翻页之后的地址；列表接口的查询
//    （order=waiting_first、每页 20 条、offset 按页码）；每一行写什么（渠道加叫法、短码、状态、needSummary、等人接手的
//    阶段列写原因／没有原因写「—」、最后动静列是等待时长（≥10 分钟 danger）或相对时间、工作台链接是 J 页路径）；
// 2. 在 DOM 里挂载（happy-dom）：真的 ConversationsPage 加照服务端规则算的假接口。页签与阶段条的数取同一次 counts（只请求
//    一次），另取等人接手首页给页头主按钮；页签是按钮、键盘移焦点，阶段条和表格只在一块面板里（换页签、点阶段不重挂，
//    焦点与表格视图留着，清掉筛选后焦点回到那一行）；表格的顺序、每格的字、两处「打开工作台」在当前标签打开 J 页
//    （不新开标签）；点一行（不在链接上）同样在当前标签打开；页头主按钮选中第一个等人接手的会话；点页签、阶段条、
//    筛选条改地址并按新地址请求；翻页与越界页码；空、页签无结果、阶段无结果；列表或计数 500 只坏用它的那一块；坐席；
//    匿名不发请求；换一个行业包，阶段名、客户叫法跟着换；两个查询按外壳的节奏轮询（counts 走事件流，这里没挂事件流
//    就不轮询，真的退回/停轮询规则见 shell/shell.selftest.ts 的 live 部分）；行有 needSummary 与 handoff 原因时画出来的样子。
// 3. public/admin.html 的 #s=<id> 深链（验收 20，01 时代留下的旧入口，`admin.html` 本身的改动是第 23 步）：页面脚本在
//    happy-dom 里原样跑，假的后台接口。没登录、列表里没有这个会话时弹登录框，登录后选中它、hash 还在；演示会话免登录
//    直接选中；换选中项时 hash 跟着走，回到首页时清掉；hashchange 也跟着选；写坏的 hash 不报错；已登录而列表里没有时
//    不弹登录框。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/conversations/conversations.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import fs from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConversationCounts, ConversationRow, Me, Role } from '../../../src/shared/console-api.js';
import { conversationState } from '../../../src/shared/conversation.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { conversationsSearch } from '../conversations-search.js';
import type { Viewer } from '../shell/boot.js';
import { workbenchPath } from '../shell/model.js';
import { VIEWER_KEY } from '../viewer.js';
import { ConversationsPage } from './ConversationsPage.js';
import {
  activeTab,
  clearStage,
  listQuery,
  PAGE_SIZE,
  pageCount,
  pageSearch,
  rowAria,
  rowView,
  stageLabel,
  stageSearch,
  tabs,
  tabSearch,
} from './model.js';

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
const at = (s: string): string => new Date(Date.parse(`${s}+08:00`)).toISOString();

const entity = (kind: string, label: string, icon: string): EntityType => ({
  kind,
  label,
  icon,
  codeLabel: `${label}编号`,
  codeExample: 'x-1',
  titleKey: 'title',
  subtitleKeys: [],
  groups: [{ key: 'basic', label: '基本信息' }],
  lockGroups: {},
  fields: [{ key: '$code', type: 'text', label: `${label}编号`, group: 'basic' }],
  list: { columns: [], filters: [], search: [], defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '',
});
const TRAVEL: IndustryPack = {
  id: 'fixture-travel',
  name: '旅游',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: {}, sopFields: {} },
  entities: [entity('route', '线路', 'route')],
  stages: [
    { key: 'greeting', label: '开场' },
    { key: 'discovery', label: '问需' },
    { key: 'recommend', label: '推荐' },
    { key: 'quote', label: '报价' },
    { key: 'objection', label: '异议', branchOf: 'quote' },
    { key: 'closing', label: '促成' },
    { key: 'paid', label: '已支付', terminal: true },
  ],
  sopSections: [{ key: 'preamble', heading: null, locked: false }],
  nav: { catalogGroup: '产品库', entities: ['route'] },
};
/** 另一份行业包：阶段、客户的叫法都不同，页面照样画（界面不认行业）。终态同家装假包是「已付定金」，key 不是 paid */
const HOME: IndustryPack = {
  ...TRAVEL,
  id: 'fixture-home',
  vocabulary: { ...TRAVEL.vocabulary, customer: '业主' },
  entities: [entity('package', '装修套餐', 'package')],
  stages: [
    { key: 'consult', label: '咨询' },
    { key: 'measure', label: '量房' },
    { key: 'sign', label: '签约' },
    { key: 'deposit', label: '已付定金', terminal: true },
  ],
  nav: { catalogGroup: '套餐', entities: ['package'] },
};

const conv = (short: string, stage: string, handedOver: boolean, messageCount: number, updatedAt: string): ConversationRow => ({
  id: `wecom:cust_${short}`,
  channel: 'wecom',
  stage,
  handedOver,
  messageCount,
  updatedAt: at(updatedAt),
  needSummary: null,
  assignee: null,
  handoff: null,
  lastCustomerAt: null,
  amount: null,
});
/** seed-demo.py --scenario console-ux --now 2026-09-26T14:30+08:00 的 13 个会话（顺序打乱，由假接口排） */
const SCENE: ConversationRow[] = [
  conv('A01', 'handoff', true, 7, '2026-09-26T14:04:00'),
  conv('A02', 'paid', false, 5, '2026-09-24T17:20:00'),
  conv('B01', 'closing', false, 4, '2026-09-26T13:30:00'),
  conv('C01', 'quote', false, 4, '2026-09-26T12:30:00'),
  conv('C02', 'quote', false, 4, '2026-09-26T11:30:00'),
  conv('D01', 'recommend', false, 2, '2026-09-26T09:30:00'),
  conv('D02', 'recommend', false, 2, '2026-09-25T21:40:00'),
  conv('D03', 'recommend', false, 2, '2026-09-25T16:05:00'),
  conv('E01', 'discovery', false, 2, '2026-09-24T19:25:00'),
  conv('E02', 'discovery', false, 2, '2026-09-24T16:50:00'),
  conv('E03', 'discovery', false, 2, '2026-09-24T14:35:00'),
  conv('E04', 'discovery', false, 2, '2026-09-24T12:10:00'),
  conv('F01', 'handoff', true, 2, '2026-09-26T14:22:00'),
];

// ---------------- 1. 纯逻辑 ----------------

// 地址参数
{
  eq('地址参数：合规的留下', conversationsSearch({ state: 'human', stage: 'quote', page: '3' }), {
    state: 'human',
    stage: 'quote',
    page: 3,
  });
  eq(
    '地址参数：不合规的丢掉，键照样写出来（不然 TanStack 把原样的参数留在 useSearch 里）',
    Object.entries(conversationsSearch({ state: 'bogus', stage: 'Quote', page: 'x' })),
    [
      ['state', undefined],
      ['stage', undefined],
      ['page', undefined],
    ],
  );
  eq(
    '地址参数：页码只收 2 起的整数（第 1 页不写），不收小数、负数、过大的数',
    [1, 2, '2', 0, -3, 2.5, 1_000_000, 1_000_001, '', null].map((page) => conversationsSearch({ page }).page),
    [undefined, 2, 2, undefined, undefined, undefined, 1_000_000, undefined, undefined, undefined],
  );
  eq('地址参数：原型上的名字不算状态', conversationsSearch({ state: 'toString' }).state, undefined);
}

// 页签
const COUNTS: ConversationCounts = {
  total: 13,
  byState: { ai: 10, human: 2, assigned: 0, paid: 1 },
  aiByStage: { discovery: 4, recommend: 3, quote: 2, closing: 1 },
  updatedToday: 6,
};
{
  eq(
    '页签：全部 / 等人接手 / AI接待中 / 已成交，数都取 counts；只有等人接手用软徽标',
    tabs(COUNTS, 'all').map((t) => [t.key, t.label, t.count, t.soft]),
    [
      ['all', '全部', 13, false],
      ['human', '等人接手', 2, true],
      ['ai', 'AI接待中', 10, false],
      ['paid', '已成交', 1, false],
    ],
  );
  eq(
    '页签：counts 还没回来时只写名字',
    tabs(undefined, 'all').map((t) => t.count),
    [null, null, null, null],
  );
  // 「顾问处理中」页签（02 第 19 步）：没有这种会话、地址也没选它时不出现；有会话（byState.assigned > 0）或
  // 地址选中了它（哪怕 counts 还没回来，或这一刻恰好是 0）都要出现，不做成灰的
  check('页签：没有顾问处理中的会话时不出现', !tabs(COUNTS, 'all').some((t) => t.key === 'assigned'));
  check('页签：counts 还没回来、地址也没选它时不出现', !tabs(undefined, 'all').some((t) => t.key === 'assigned'));
  const withAssigned: ConversationCounts = { ...COUNTS, byState: { ...COUNTS.byState, assigned: 1 } };
  eq(
    '页签：有顾问处理中的会话时出现在等人接手之后、AI接待中之前',
    tabs(withAssigned, 'all').map((t) => t.key),
    ['all', 'human', 'assigned', 'ai', 'paid'],
  );
  check(
    '页签：地址选了它、这一刻是 0 也出现',
    tabs(COUNTS, 'assigned').some((t) => t.key === 'assigned'),
  );
  check(
    '页签：地址选了它、counts 还没回来也出现',
    tabs(undefined, 'assigned').some((t) => t.key === 'assigned'),
  );
  eq('选中的页签：没有 state 是全部', [activeTab({}), activeTab({ state: 'paid', stage: 'quote' })], ['all', 'paid']);
  eq('换页签：只留状态，阶段与页码清掉', [tabSearch('all'), tabSearch('human')], [{}, { state: 'human' }]);
}

// 阶段筛选与翻页
{
  eq('点阶段条：只看这个阶段、AI 接待中', stageSearch('quote', { state: 'human', page: 3 }), { state: 'ai', stage: 'quote' });
  eq('再点已选中的一行：取消阶段筛选、留在原来的页签', stageSearch('quote', { state: 'ai', stage: 'quote', page: 2 }), { state: 'ai' });
  eq('点另一个阶段：换成那个阶段', stageSearch('closing', { state: 'ai', stage: 'quote' }), { state: 'ai', stage: 'closing' });
  eq(
    '清除阶段：留着页签，回到第一页',
    [clearStage({ state: 'ai', stage: 'quote', page: 4 }), clearStage({ stage: 'quote' })],
    [{ state: 'ai' }, {}],
  );
  eq(
    '翻页：筛选照旧，第 1 页不写 page',
    [pageSearch({ state: 'ai', stage: 'quote' }, 3), pageSearch({ state: 'ai', page: 3 }, 1)],
    [{ state: 'ai', stage: 'quote', page: 3 }, { state: 'ai' }],
  );
  eq('共几页', [pageCount(0), pageCount(20), pageCount(21), pageCount(38)], [1, 1, 2, 2]);
  eq(
    '阶段名取自行业包，包里没有的照写原值',
    [stageLabel(TRAVEL, 'quote'), stageLabel(HOME, 'quote'), stageLabel(TRAVEL, 'legacy')],
    ['报价', 'quote', 'legacy'],
  );
}

// 列表接口的查询
{
  eq('查询：等人接手在前（waiting_first），每页 20 条', listQuery({}), { limit: '20', offset: '0', order: 'waiting_first' });
  eq('查询：页码换成 offset，state、stage 交给服务端先过滤再分页', listQuery({ state: 'ai', stage: 'quote', page: 3 }), {
    limit: '20',
    offset: '40',
    order: 'waiting_first',
    state: 'ai',
    stage: 'quote',
  });
  eq('每页 20 条', PAGE_SIZE, 20);
}

// 每一行写什么（设计系统 §10.0 的会话表）
{
  const f01 = rowView(SCENE[12]!, TRAVEL, NOW);
  eq('行：F01', f01, {
    id: 'wecom:cust_F01',
    label: ['企微客户', 'F01'],
    state: 'human',
    stage: '—',
    messages: 2,
    at: SCENE[12]!.updatedAt,
    when: '8分钟前',
    whenFull: '9月26日 14:22',
    waitDanger: false,
    href: '/conversations/wecom%3Acust_F01',
  });
  const view = (short: string) =>
    rowView(
      SCENE.find((c) => c.id.endsWith(short))!,
      TRAVEL,
      NOW,
    );
  eq(
    '行：状态、阶段、最后动静',
    ['A01', 'B01', 'C01', 'D01', 'D02', 'D03', 'E01', 'A02'].map((s) => {
      const r = view(s);
      return [r.label[1], r.state, r.stage, r.when];
    }),
    [
      ['A01', 'human', '—', '26分钟前'],
      ['B01', 'ai', '促成', '1小时前'],
      ['C01', 'ai', '报价', '2小时前'],
      ['D01', 'ai', '推荐', '5小时前'],
      ['D02', 'ai', '推荐', '昨天21:40'],
      ['D03', 'ai', '推荐', '昨天16:05'],
      ['E01', 'ai', '问需', '9月24日'],
      ['A02', 'paid', '已支付', '9月24日'],
    ],
  );
  // 转人工以后又付了款：状态是已成交，阶段照写（不因为 handedOver 写「—」）
  const paidAfterHandoff = rowView({ ...SCENE[1]!, handedOver: true }, TRAVEL, NOW);
  eq('行：转人工以后成交的，算已成交、阶段照写', [paidAfterHandoff.state, paidAfterHandoff.stage], ['paid', '已支付']);
  // 阶段不是 handoff 的等人接手：阶段也写「—」；阶段停在 handoff 而没转人工（老数据）同样写「—」，页面上不出现「转人工」
  eq('行：等人接手没有原因（旧数据）时写「—」', rowView(conv('X01', 'quote', true, 1, '2026-09-26T14:00:00'), TRAVEL, NOW).stage, '—');
  eq('行：handoff 阶段不写原码', rowView(conv('X02', 'handoff', false, 1, '2026-09-26T14:00:00'), TRAVEL, NOW).stage, '—');
  // 02 第 19 步：等人接手的行有 handoff 记录时，阶段列写原因、最后动静列写等待时长（从 handoff.at 算，不是 updatedAt），
  // 标题加 needSummary；≥10 分钟 danger，否则不是
  {
    const withHandoff = (short: string, waitMin: number, reason: string): ConversationRow => ({
      ...conv(short, 'quote', true, 4, '2026-09-26T13:00:00'),
      needSummary: '贵州带爸妈4人',
      handoff: { kind: 'request', at: new Date(NOW - waitMin * 60_000).toISOString(), reason },
    });
    const danger = rowView(withHandoff('Y01', 12, '客户要找顾问'), TRAVEL, NOW);
    const warn = rowView(withHandoff('Y02', 3, '客户要投诉'), TRAVEL, NOW);
    eq(
      '行：有原因时阶段列写原因，标题带 needSummary',
      [danger.label, danger.stage],
      [['企微客户', 'Y01', '贵州带爸妈4人'], '客户要找顾问'],
    );
    eq('行：等待 ≥10 分钟 danger，否则不是', [danger.waitDanger, warn.waitDanger], [true, false]);
    eq('行：最后动静列是等待时长（从 handoff.at 算，不是 updatedAt）', [danger.when, warn.when], ['12分钟前', '3分钟前']);
  }
  eq(
    '行：超过 30 天写日期，跨年加年份',
    [
      rowView(conv('X03', 'quote', false, 1, '2026-08-17T10:00:00'), TRAVEL, NOW).when,
      rowView(conv('X04', 'quote', false, 1, '2025-12-30T10:00:00'), TRAVEL, NOW).when,
    ],
    ['8月17日', '2025年12月30日'],
  );
  eq('行：家装包的叫法', rowView(conv('H01', 'measure', false, 3, '2026-09-26T13:00:00'), HOME, NOW).label, ['企微业主', 'H01']);
  // 已成交按行业包的终态判定：家装包停在「已付定金」的算已成交（转过人工也一样，阶段照写）；旅游包的 paid 在这里只是包外的阶段
  eq(
    '行：家装包的终态「已付定金」算已成交，paid 不算',
    [
      conv('H03', 'deposit', false, 9, '2026-09-25T14:00:00'),
      conv('H05', 'deposit', true, 9, '2026-09-25T14:00:00'),
      conv('H04', 'paid', false, 9, '2026-09-25T14:00:00'),
      conv('H06', 'paid', true, 9, '2026-09-25T14:00:00'),
    ].map((c) => {
      const r = rowView(c, HOME, NOW);
      return [r.state, r.stage];
    }),
    [
      ['paid', '已付定金'],
      ['paid', '已付定金'],
      ['ai', 'paid'],
      ['human', '—'],
    ],
  );
  eq('行：读屏念的名字', rowAria(f01), '企微客户 F01，等人接手，打开工作台');
  eq(
    '行：模拟器渠道叫「演示」（sim- 会话本来就不列出）',
    rowView({ ...SCENE[0]!, channel: 'simulator' }, TRAVEL, NOW).label[0],
    '演示客户',
  );
}

// ---------------- 2. 在 DOM 里挂载 ----------------
// 页面的「现在」取 Date.now()：钉在场景时刻（走查用 Playwright 的 page.clock.setFixedTime 做同样的事）
const realNow = Date.now;
Date.now = () => NOW;

interface Server {
  conversations: ConversationRow[];
  /** 租户的行业包，服务端按它的终态判已成交；默认旅游包 */
  pack?: IndustryPack;
  /** 这些路径回 500 */
  fail?: RegExp;
}
let server: Server = { conversations: SCENE };
let requests: string[] = [];
const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

/** 照服务端：state、stage 先过滤，waiting_first 让等人接手的在前，其余 (updatedAt 倒序, id)，再分页 */
function respond(method: string, url: URL): Response {
  const p = url.pathname.replace(/^\/api\/console/, '');
  const q = url.searchParams;
  if (server.fail?.test(`${method} ${p}`)) return json(500, { error: 'internal', detail: '故意的' });
  const all = server.conversations;
  const pack = server.pack ?? TRAVEL;
  if (method === 'GET' && p === '/conversations/counts') {
    const c: ConversationCounts = { total: 0, byState: { ai: 0, human: 0, assigned: 0, paid: 0 }, aiByStage: {}, updatedToday: 0 };
    for (const row of all) {
      const s = conversationState(row, pack);
      c.total += 1;
      c.byState[s] += 1;
      if (s === 'ai') c.aiByStage[row.stage] = (c.aiByStage[row.stage] ?? 0) + 1;
    }
    return json(200, c);
  }
  if (method === 'GET' && p === '/conversations') {
    const st = q.get('state');
    const sg = q.get('stage');
    const waiting = (r: ConversationRow): number => (q.get('order') === 'waiting_first' && conversationState(r, pack) === 'human' ? 1 : 0);
    const rows = all
      .filter((r) => (!st || conversationState(r, pack) === st) && (!sg || r.stage === sg))
      .sort((a, b) => waiting(b) - waiting(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : 1));
    const limit = Number(q.get('limit') ?? 20);
    const offset = Number(q.get('offset') ?? 0);
    return json(200, { items: rows.slice(offset, offset + limit), total: rows.length });
  }
  return json(404, { error: 'not_found' });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url.pathname}${url.search}`);
  return respond(method, url);
}) as typeof fetch;

/** 新标签打开的记录（页面经 window.open 打开工作台） */
let opened: unknown[][] = [];
(win as unknown as { open: (...a: unknown[]) => null }).open = (...a: unknown[]) => {
  opened.push(a);
  return null;
};

const me = (role: Role): Me => ({ userId: 'u1', displayName: '老板', role, csrf: 'c1', tenantSlug: 'yuntu', tenantName: '云途定制旅行' });
const member = (role: Role, pack = TRAVEL): Viewer => ({ kind: 'member', me: me(role), pack });

async function settle(qc: QueryClient): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0) break;
  }
}

/** 挂上真的 ConversationsPage：路由只有它（validateSearch 与 router.tsx 同一个），查询缓存里放好来者；等请求都回来 */
async function mount(viewer: Viewer, search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(VIEWER_KEY, viewer);
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/conversations',
        validateSearch: conversationsSearch,
        component: ConversationsPage,
      }),
      // J 页本身是第 20.2 步；这里只接一个最小的桩，验证点一行、「打开工作台」在当前标签导航到了它（不新开标签）
      createRoute({ getParentRoute: () => root, path: '/conversations/$id', component: () => null }),
    ]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: [`/console/conversations${search}`] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  await act(async () =>
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never }))),
  );
  await settle(qc);
  const $ = (sel: string): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(sel)];
  const text = (e: Element | undefined): string => (e?.textContent ?? '').trim();
  return {
    qc,
    router,
    box,
    $,
    texts: (sel: string): string[] => $(sel).map(text),
    attrs: (sel: string, name: string): (string | null)[] => $(sel).map((e) => e.getAttribute(name)),
    /** 表格的行：每格的字 */
    rows: (): string[][] => $('.cv-table tbody tr.cv-row').map((tr) => [...tr.querySelectorAll('td')].map(text)),
    tabs: (): [string, string | null][] => $('.cv-tabs [role="tab"]').map((t) => [text(t), t.getAttribute('aria-selected')]),
    stages: (): [string, string, string | null][] =>
      $('.cv-stage').map((e) => [
        text(e.querySelector('.cv-stage-label') ?? undefined),
        text(e.querySelector('.cv-stage-count') ?? undefined),
        e.getAttribute('href'),
      ]),
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
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
    },
  };
}
const convRequests = (): string[] => requests.filter((r) => r.startsWith('GET /api/console/conversations'));

// 2.1 所有者、全部：页签与阶段条来自同一次 counts；表格按 waiting_first
{
  server = { conversations: SCENE };
  requests = [];
  const m = await mount(member('owner'));
  eq('请求：counts 只取一次（页签与阶段条同源），另取等人接手的首页（页头主按钮用），列表带 order=waiting_first', convRequests(), [
    'GET /api/console/conversations/counts',
    'GET /api/console/conversations?state=human',
    'GET /api/console/conversations?limit=20&offset=0&order=waiting_first',
  ]);
  eq('标签页标题', document.title, '会话 · 云途定制旅行');
  eq('页头：标题与状态句', [m.texts('h1'), m.texts('.page-status')], [['会话'], ['企业微信里的客户会话·在工作台里接手和回复']]);
  const primary = m.$('.page-actions button')[0];
  eq(
    '页头：主按钮「打开工作台」不是 blocked（有等人接手的会话）',
    [primary?.textContent?.trim(), primary?.classList.contains('primary-blocked')],
    ['打开工作台', false],
  );
  eq('页签：四个，数取 counts，选中「全部」', m.tabs(), [
    ['全部13', 'true'],
    ['等人接手2', 'false'],
    ['AI接待中10', 'false'],
    ['已成交1', 'false'],
  ]);
  eq(
    '页签：等人接手的数是软徽标，读作「2个」',
    [m.texts('.cv-tabs .badge-soft'), m.attrs('.cv-tabs .badge-soft', 'aria-label')],
    [['2'], ['2个']],
  );
  eq('阶段条：区块头', [m.texts('h2'), m.texts('.cv-count')], [['客户停在哪一步'], ['AI接待中的10个会话']]);
  const stages = m.stages();
  eq('阶段条：阶段名和顺序来自行业包，不含终态；每行链到只看这个阶段、AI 接待中', stages, [
    ['开场', '0', '/console/conversations?state=ai&stage=greeting'],
    ['问需', '4', '/console/conversations?state=ai&stage=discovery'],
    ['推荐', '3', '/console/conversations?state=ai&stage=recommend'],
    ['报价', '2', '/console/conversations?state=ai&stage=quote'],
    ['异议', '0', '/console/conversations?state=ai&stage=objection'],
    ['促成', '1', '/console/conversations?state=ai&stage=closing'],
  ]);
  eq(
    '阶段条：各行之和等于「AI接待中」页签的数（验收 6）',
    stages.reduce((n, s) => n + Number(s[1]), 0),
    Number(m.tabs()[2]![0].replace(/\D/g, '')),
  );
  eq(
    '阶段条：数为 0 的行不画条、分支阶段缩进',
    [m.$('.cv-stage-bar').length, m.$('.cv-stage.is-zero').length, m.$('.cv-stage.is-branch').map((e) => e.textContent)],
    [4, 2, ['异议0']],
  );
  eq(
    '表头：会话 状态 阶段 消息 最后动静（按它倒序）、操作列的字只给读屏（看不见，但是表头里的文字，第 16 步）',
    m.$('.cv-table thead th').map((th) => [th.textContent?.trim(), th.getAttribute('aria-sort'), th.querySelector('.cv-sr') !== null]),
    [
      ['会话', null, false],
      ['状态', null, false],
      ['阶段', null, false],
      ['消息', null, false],
      ['最后动静', 'descending', false],
      ['操作', null, true],
    ],
  );
  eq('表格：等人接手的在前，其余按最后动静倒序（设计系统 §10.0 修正 1：F01 在 A01 前）', m.rows(), [
    ['企微客户·F01', '等人接手', '—', '2', '8分钟前', '打开工作台'],
    ['企微客户·A01', '等人接手', '—', '7', '26分钟前', '打开工作台'],
    ['企微客户·B01', 'AI接待中', '促成', '4', '1小时前', '打开工作台'],
    ['企微客户·C01', 'AI接待中', '报价', '4', '2小时前', '打开工作台'],
    ['企微客户·C02', 'AI接待中', '报价', '4', '3小时前', '打开工作台'],
    ['企微客户·D01', 'AI接待中', '推荐', '2', '5小时前', '打开工作台'],
    ['企微客户·D02', 'AI接待中', '推荐', '2', '昨天21:40', '打开工作台'],
    ['企微客户·D03', 'AI接待中', '推荐', '2', '昨天16:05', '打开工作台'],
    ['企微客户·E01', 'AI接待中', '问需', '2', '9月24日', '打开工作台'],
    ['企微客户·A02', '已成交', '已支付', '5', '9月24日', '打开工作台'],
    ['企微客户·E02', 'AI接待中', '问需', '2', '9月24日', '打开工作台'],
    ['企微客户·E03', 'AI接待中', '问需', '2', '9月24日', '打开工作台'],
    ['企微客户·E04', 'AI接待中', '问需', '2', '9月24日', '打开工作台'],
  ]);
  eq(
    '表格：等人接手的状态是胶囊，其余是圆点加文字',
    [m.$('.cv-table .status-human').length, m.$('.cv-table .status-ai').length, m.$('.cv-table .status-paid').length],
    [2, 10, 1],
  );
  eq('表格：最后动静悬停看绝对时间', m.attrs('.cv-when', 'title').slice(0, 2), ['9月26日 14:22', '9月26日 14:04']);
  const firstLinks = m.$('.cv-conv-link');
  eq(
    '表格：首列是真正的链接，在当前标签打开 J 页（02 第 19 步起，不再新标签打开 admin.html）',
    [firstLinks[0]?.getAttribute('href'), firstLinks[0]?.getAttribute('target'), firstLinks[0]?.getAttribute('aria-label')],
    [`/console${workbenchPath('wecom:cust_F01')}`, null, '企微客户 F01，等人接手，打开工作台'],
  );
  const ops = m.$('.cv-open');
  eq(
    '表格：「打开工作台」同一个地址，当前标签',
    [ops.length, ops[1]?.getAttribute('href'), ops[1]?.getAttribute('target'), ops[1]?.getAttribute('aria-label')],
    [13, `/console${workbenchPath('wecom:cust_A01')}`, null, '打开工作台，企微客户 A01'],
  );
  eq('表格：名字写明排序规则（等人接手的在前，最后动静那一列的倒序在其下）', m.attrs('.cv-table table', 'aria-label'), [
    '会话，共13个，等人接手的排在最前',
  ]);
  check('表格：没有分页器（13 条只有一页）', m.$('.ant-pagination').length === 0);
  // 「顾问处理中」「等了」「转人工」在这套老的 13 会话场景（handoff 全是 null）里不会出现，因为这几行没有
  // 原因数据可写；仍在禁用词清单上的四个（02 spec R12 之外的叫法）继续查（见 shell/errors.selftest.ts 的四态断言）
  check(
    '禁用词：没有「待人工」「已转人工」「待接管」「需要介入」',
    !/待人工|已转人工|待接管|需要介入/.test(m.box.textContent ?? ''),
    m.box.textContent ?? '',
  );
  check('没有红色：没有 danger 的 Alert 与状态', m.$('.ant-alert-error, .status-danger').length === 0);

  // 点一行（不在链接上）：在当前标签打开 J 页；点在链接上交给链接自己，不另开一个
  await m.click(m.$('.cv-table tbody tr.cv-row')[1]?.querySelectorAll('td')[2]);
  eq('点一行：在当前标签打开 J 页并选中该会话', m.url(), '/conversations/wecom%3Acust_A01');
  await act(async () => void (await m.router.navigate({ to: '/conversations' })));
  await settle(m.qc);
  const link = m.$('.cv-conv-link')[2]!;
  await m.click(link);
  eq('点首列的链接：同一处导航（不是另开一个标签）', m.url(), '/conversations/wecom%3Acust_B01');
  await act(async () => void (await m.router.navigate({ to: '/conversations' })));
  await settle(m.qc);

  // counts、人接手首页都断线超过 30 秒退回轮询、重连立刻停（shell/live.ts）；列表固定 30 秒、后台不轮询。
  // 这里没有挂 Shell/Frame，事件流从没接上过（live.ts 的模块状态是初始值），所以 counts、human 这两个暂时不轮询
  // （不是「停了」，是「还没确认要退回」）；真的退回/停轮询的规则由 shell/shell.selftest.ts 的 live 部分测
  const opts = (key: string) => {
    const q = m.qc.getQueryCache().findAll({ queryKey: ['conversations', key] })[0];
    const o = q?.observers[0]?.options as { refetchInterval?: unknown; refetchIntervalInBackground?: unknown } | undefined;
    return [o?.refetchInterval, o?.refetchIntervalInBackground];
  };
  eq(
    '轮询：列表固定 30 秒、后台不轮询；counts 走事件流，这次挂载没有事件流就不轮询',
    [opts('counts'), opts('list')],
    [
      [false, false],
      [30_000, false],
    ],
  );

  // 以表格查看：同样的数字
  await m.click(m.$('.cv-head-btn')[0]);
  eq(
    '以表格查看：同样的数字换成小表格',
    m.$('.cv-stage-table tr').map((tr) => [...tr.children].map((c) => c.textContent?.trim())),
    [
      ['阶段', '会话'],
      ['开场', '0'],
      ['问需', '4'],
      ['推荐', '3'],
      ['报价', '2'],
      ['异议', '0'],
      ['促成', '1'],
    ],
  );
  eq('以表格查看：按钮换成「以条形图查看」', m.texts('.cv-head-btn'), ['以条形图查看']);
  await m.click(m.$('.cv-head-btn')[0]);
  eq('以条形图查看：换回条形', [m.$('.cv-stage').length, m.$('.cv-stage-table').length], [6, 0]);

  // 点「报价」一行：地址变成 ?state=ai&stage=quote，按新地址请求
  requests = [];
  await m.click(m.$('.cv-stage').find((e) => e.textContent?.includes('报价')));
  eq('点阶段条：地址', m.url(), '/conversations?state=ai&stage=quote');
  eq('点阶段条：state、stage 进到请求里', convRequests(), [
    'GET /api/console/conversations?limit=20&offset=0&order=waiting_first&state=ai&stage=quote',
  ]);

  // 页头主按钮「打开工作台」：选中第一个等人接手的会话（F01，排序同表格），在当前标签打开 J 页
  await act(async () => void (await m.router.navigate({ to: '/conversations' })));
  await settle(m.qc);
  await m.click(m.$('.page-actions button')[0]);
  eq('页头主按钮：打开 F01 的 J 页', m.url(), '/conversations/wecom%3Acust_F01');
  await m.unmount();
}

// 2.1b 行有 needSummary 与 handoff 原因时画出来什么样（02 第 19 步）
{
  const withHandoff = (short: string, waitMin: number, reason: string): ConversationRow => ({
    ...conv(short, 'quote', true, 4, '2026-09-26T13:00:00'),
    needSummary: '贵州带爸妈4人',
    handoff: { kind: 'request', at: new Date(NOW - waitMin * 60_000).toISOString(), reason },
  });
  server = { conversations: [withHandoff('Y01', 12, '客户要找顾问'), conv('Y02', 'quote', false, 2, '2026-09-26T13:50:00')] };
  const m = await mount(member('owner'));
  eq('行：标题带 needSummary（企微客户 · Y01 · 贵州带爸妈4人）', m.rows()[0]?.[0], '企微客户·Y01·贵州带爸妈4人');
  eq('行：阶段列写原因，不是「—」', m.rows()[0]?.[2], '客户要找顾问');
  eq('行：等待 12 分钟，最后动静列用 danger 字', [m.rows()[0]?.[4], m.$('.cv-when.is-danger').length], ['12分钟前', 1]);
  eq('行：AI接待中的那一行不受影响（阶段照写，最后动静是 updatedAt）', m.rows()[1], [
    '企微客户·Y02',
    'AI接待中',
    '报价',
    '2',
    '40分钟前',
    '打开工作台',
  ]);
  await m.unmount();
  server = { conversations: SCENE };
}

// 2.2 从总览的阶段条跳过来：?state=ai&stage=quote（验收 10）
{
  requests = [];
  const m = await mount(member('owner'), '?state=ai&stage=quote');
  eq('筛选：请求', convRequests(), [
    'GET /api/console/conversations/counts',
    'GET /api/console/conversations?state=human',
    'GET /api/console/conversations?limit=20&offset=0&order=waiting_first&state=ai&stage=quote',
  ]);
  eq(
    '筛选：「AI接待中」页签选中',
    m.tabs().map((t) => t[1]),
    ['false', 'false', 'true', 'false'],
  );
  eq(
    '筛选：只列报价阶段 AI 接待中的会话',
    m.rows().map((r) => r[0]),
    ['企微客户·C01', '企微客户·C02'],
  );
  eq('筛选：表格的名字按筛出来的总数', m.attrs('.cv-table table', 'aria-label'), ['会话，共2个，等人接手的排在最前']);
  eq(
    '筛选：筛选条写明阶段，点了清掉',
    [m.texts('.cv-chip'), m.attrs('.cv-chip', 'href')],
    [['阶段：报价'], ['/console/conversations?state=ai']],
  );
  const selected = m.$('.cv-stage.is-selected');
  eq(
    '筛选：选中的阶段标出来，再点取消',
    selected.map((e) => [e.textContent, e.getAttribute('aria-current'), e.getAttribute('href')]),
    [['报价2', 'true', '/console/conversations?state=ai']],
  );
  // TanStack 默认按子集比 search：取消筛选的链接会被当成「当前页」。筛选链接只在地址完全相同时算当前
  eq('筛选：页面上没有被标成当前页的链接', m.$('[aria-current="page"]').length, 0);
  // 点页签：换状态，阶段筛选清掉
  requests = [];
  await m.click(m.$('.cv-tabs [role="tab"]').find((t) => t.textContent?.startsWith('等人接手')));
  eq('点页签：地址只留状态', m.url(), '/conversations?state=human');
  eq('点页签：请求', convRequests(), ['GET /api/console/conversations?limit=20&offset=0&order=waiting_first&state=human']);
  eq(
    '点页签：只列等人接手的',
    m.rows().map((r) => [r[0], r[1]]),
    [
      ['企微客户·F01', '等人接手'],
      ['企微客户·A01', '等人接手'],
    ],
  );
  check('点页签：筛选条没了', m.$('.cv-chip').length === 0);
  await m.click(m.$('.cv-tabs [role="tab"]').find((t) => t.textContent?.startsWith('全部')));
  eq('点「全部」：地址不带参数', m.url(), '/conversations');
  await m.unmount();
}

// 2.25 页签与唯一的面板：换页签、点阶段条都不卸掉阶段条和表格，焦点与「以表格查看」都留着；清掉阶段筛选后焦点回到那一行阶段
{
  server = { conversations: SCENE };
  const m = await mount(member('owner'));
  const focused = (): Element | null => document.activeElement;
  const press = async (key: string) => {
    await act(async () => {
      focused()?.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle(m.qc);
  };
  const list = m.$('[role="tablist"]');
  eq('页签：一个 tablist，名字写明按什么分', [list.length, list[0]?.getAttribute('aria-label')], [1, '按接待状态筛选']);
  const tabEls = m.$('[role="tab"]');
  eq(
    '页签：是按钮，只有选中的在 Tab 顺序里，都指向同一块面板',
    tabEls.map((t) => [t.tagName, t.getAttribute('tabindex'), t.getAttribute('aria-controls')]),
    [
      ['BUTTON', '0', 'cv-panel'],
      ['BUTTON', '-1', 'cv-panel'],
      ['BUTTON', '-1', 'cv-panel'],
      ['BUTTON', '-1', 'cv-panel'],
    ],
  );
  const panels = m.$('[role="tabpanel"]');
  eq(
    '面板：只有一块，由选中的页签命名，阶段条和表格都在里面',
    [
      panels.length,
      panels[0]?.id,
      document.getElementById(panels[0]?.getAttribute('aria-labelledby') ?? '')?.textContent,
      panels[0]?.querySelectorAll('.cv-stages, .cv-table').length,
    ],
    [1, 'cv-panel', '全部13', 2],
  );

  // 键盘：左右键在页签间移焦点（首尾相接），Home、End 到头尾；只移焦点、不换页签
  tabEls[0]!.focus();
  check('页签：得到焦点后名字里没有别的读屏提示', list[0]?.textContent === '全部13等人接手2AI接待中10已成交1', list[0]?.textContent ?? '');
  const walk: number[] = [];
  const urls = new Set<string>();
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'Home', 'End', 'ArrowRight']) {
    await press(key);
    walk.push(tabEls.indexOf(focused() as HTMLElement));
    urls.add(m.url());
  }
  eq('页签：左右键、Home、End 移焦点，首尾相接', walk, [1, 2, 1, 0, 3, 0, 3, 0]);
  eq(
    '页签：移焦点不换页签（每一步地址都没变）',
    [[...urls], m.tabs().map((t) => t[1])],
    [['/conversations'], ['true', 'false', 'false', 'false']],
  );

  // 以表格查看，再从「全部」点表格里的「报价」：地址与页签换了，阶段区块还是原来那一个、仍是表格，焦点还在那一格
  const section = m.$('.cv-stages')[0];
  await m.click(m.$('.cv-head-btn')[0]);
  const quote = m.$('.cv-stage-cell').find((e) => e.textContent === '报价')!;
  quote.focus();
  await m.click(quote);
  eq(
    '从「全部」点阶段：换到 AI接待中，阶段区块不重挂、仍是表格，焦点留在这一格',
    [
      m.url(),
      m.tabs().map((t) => t[1]),
      m.$('.cv-stages')[0] === section,
      m.$('.cv-stage-table').length,
      focused() === quote,
      quote.getAttribute('aria-current'),
    ],
    ['/conversations?state=ai&stage=quote', ['false', 'false', 'true', 'false'], true, 1, true, 'true'],
  );
  eq(
    '面板：换页签后由新选中的页签命名，它进 Tab 顺序',
    [m.$('[role="tabpanel"]')[0]?.getAttribute('aria-labelledby'), m.$('[role="tab"]').map((t) => t.getAttribute('tabindex'))],
    ['cv-tab-ai', ['-1', '-1', '0', '-1']],
  );

  // 点筛选条清掉阶段：筛选条自己没了，焦点回到刚才筛的那一格
  const chip = m.$('.cv-chip')[0]!;
  chip.focus();
  await m.click(chip);
  eq(
    '清掉筛选条：地址只留页签，焦点回到「报价」那一格',
    [m.url(), m.$('.cv-chip').length, focused()?.getAttribute('data-stage'), focused()?.textContent],
    ['/conversations?state=ai', 0, 'quote', '报价'],
  );

  // 再筛一次，这回点页签清掉阶段：焦点在页签上，不被挪走；表格视图照样留着
  await m.click(m.$('[data-stage="recommend"]')[0]);
  requests = [];
  await m.click(m.$('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true'));
  eq(
    '点已选中的页签（AI接待中）：阶段筛选留着，不换地址、不重取',
    [m.url(), convRequests()],
    ['/conversations?state=ai&stage=recommend', []],
  );
  const human = m.$('[role="tab"]').find((t) => t.textContent?.startsWith('等人接手'))!;
  human.focus();
  await m.click(human);
  eq(
    '点页签清掉阶段：焦点留在页签上，阶段区块不重挂、仍是表格',
    [m.url(), focused() === human, m.$('.cv-stages')[0] === section, m.$('.cv-stage-table').length],
    ['/conversations?state=human', true, true, 1],
  );
  await m.unmount();

  // 「清除筛选」（阶段筛选没有结果）点了也随空状态一起没了：焦点回到那一行阶段
  const empty = await mount(member('owner'), '?state=ai&stage=greeting');
  const clear = empty.$('.state-empty a')[0]!;
  clear.focus();
  await empty.click(clear);
  eq(
    '点「清除筛选」：焦点回到「开场」那一行',
    [empty.url(), focused()?.getAttribute('data-stage'), focused()?.classList.contains('cv-stage')],
    ['/conversations?state=ai', 'greeting', true],
  );
  await empty.unmount();

  // 计数没取到，阶段条里没有那一行：焦点放回选中的页签
  server = { conversations: SCENE, fail: /^GET \/conversations\/counts$/ };
  const noCounts = await mount(member('owner'), '?state=ai&stage=quote');
  const chip2 = noCounts.$('.cv-chip')[0]!;
  chip2.focus();
  await noCounts.click(chip2);
  eq('计数没取到时清掉筛选条：焦点回到选中的页签', [noCounts.url(), focused()?.id], ['/conversations?state=ai', 'cv-tab-ai']);
  await noCounts.unmount();
  server = { conversations: SCENE };
}

// 2.3 多于一页：38 个会话，每页 20 条；翻到第 2 页；地址里的页码超过最后一页时换成最后一页
{
  const extra = Array.from({ length: 25 }, (_, i) => ({
    ...conv(`Z${String(i).padStart(2, '0')}`, 'discovery', false, 1, '2026-09-20T10:00:00'),
    updatedAt: new Date(Date.parse('2026-09-20T10:00:00+08:00') - i * 3_600_000).toISOString(),
  }));
  server = { conversations: [...SCENE, ...extra] };
  requests = [];
  const m = await mount(member('owner'));
  eq('分页：第 1 页 20 条，写「共38条」', [m.rows().length, m.texts('.ant-pagination-total-text')], [20, ['共38条']]);
  requests = [];
  await m.click(m.$('.ant-pagination-item-2')[0]);
  eq('分页：翻到第 2 页，页码写进地址', m.url(), '/conversations?page=2');
  eq('分页：第 2 页的请求', convRequests(), ['GET /api/console/conversations?limit=20&offset=20&order=waiting_first']);
  eq('分页：第 2 页 18 条', m.rows().length, 18);
  await m.unmount();
  requests = [];
  const late = await mount(member('owner'), '?state=ai&page=9');
  eq('分页：页码越界换成最后一页，筛选照旧', late.url(), '/conversations?state=ai&page=2');
  eq('分页：越界后按最后一页请求', convRequests().at(-1), 'GET /api/console/conversations?limit=20&offset=20&order=waiting_first&state=ai');
  await late.unmount();
}

// 2.4 空、页签无结果、阶段无结果
{
  server = { conversations: [] };
  const none = await mount(member('owner'));
  eq(
    '空：替换页签、阶段条和表格',
    [none.texts('.state-empty-title'), none.texts('.state-empty-desc'), none.$('.cv-tabs').length, none.$('.cv-table').length],
    [['客户的会话会出现在这里'], ['客户在企业微信里发来第一句话后就会出现'], 0, 0],
  );
  eq(
    '空：整页的空状态紧跟页名 h1，标题是 h2（不跳级）',
    none.$('.state-empty-title').map((e) => e.tagName),
    ['H2'],
  );
  await none.unmount();
  const homeNone = await mount(member('owner', HOME));
  eq(
    '空：客户的叫法取自行业包',
    [homeNone.texts('.state-empty-title'), homeNone.texts('.state-empty-desc')],
    [['业主的会话会出现在这里'], ['业主在企业微信里发来第一句话后就会出现']],
  );
  await homeNone.unmount();
  server = { conversations: SCENE.filter((c) => conversationState(c, TRAVEL) !== 'paid') };
  const tab = await mount(member('owner'), '?state=paid');
  eq(
    '页签无结果：页签留着，表格换成一句话，不给清除筛选',
    [tab.tabs()[3], tab.texts('.state-empty-title'), tab.$('.state-empty a').length, tab.$('.cv-table').length],
    [['已成交0', 'true'], ['这个分类下没有会话'], 0, 0],
  );
  eq(
    '页签无结果：这句在「客户停在哪一步」h2 之下，是 h3',
    tab.$('.state-empty-title').map((e) => e.tagName),
    ['H3'],
  );
  await tab.unmount();
  const stage = await mount(member('owner'), '?state=ai&stage=greeting');
  eq(
    '阶段无结果：给「清除筛选」链接，去掉阶段',
    [stage.texts('.state-empty-title'), stage.texts('.state-empty a'), stage.attrs('.state-empty a', 'href')],
    [['这个分类下没有会话'], ['清除筛选'], ['/console/conversations?state=ai']],
  );
  await stage.unmount();
}

// 2.5 出错只坏用它的那一块
{
  server = { conversations: SCENE, fail: /^GET \/conversations$/ };
  const list = await mount(member('owner'));
  eq(
    '列表 500：表格处写「没取到」，页签与阶段条照常',
    [list.texts('.cv-list .ant-alert-title'), list.tabs()[0], list.$('.cv-stage').length, list.$('.cv-table').length],
    [['没取到'], ['全部13', 'true'], 6, 0],
  );
  await list.unmount();
  server = { conversations: SCENE, fail: /^GET \/conversations\/counts$/ };
  const counts = await mount(member('owner'));
  eq(
    '计数 500：页签只写名字，阶段条写「没取到」，表格照常',
    [counts.tabs().map((t) => t[0]), counts.texts('.cv-stages .ant-alert-title'), counts.rows().length],
    [['全部', '等人接手', 'AI接待中', '已成交'], ['没取到'], 13],
  );
  check('计数 500：阶段条的区块头不写计数', counts.$('.cv-count').length === 0);
  await counts.unmount();
}

// 2.6 坐席：列表照常，页头挂「只读」，「打开工作台」照样有（接手在工作台里做）
{
  server = { conversations: SCENE };
  const m = await mount(member('agent'));
  eq('坐席：列表与主按钮', [m.rows().length, m.texts('.page-actions button'), m.$('.readonly-pill').length], [13, ['打开工作台'], 1]);
  await m.unmount();
}

// 2.7 匿名：没有入口，直接打开这个地址也不发会话请求
{
  requests = [];
  const m = await mount({ kind: 'anon', pack: TRAVEL });
  eq(
    '匿名：一句说明，没有页签、表格和主按钮，不发请求',
    [m.texts('.state-empty-title'), m.$('.cv-tabs').length, m.$('.page-actions button').length, convRequests()],
    [['登录后才能看会话'], 0, 0, []],
  );
  eq(
    '匿名：空状态的标题是 h2（紧跟页名 h1）',
    m.$('.state-empty-title').map((e) => e.tagName),
    ['H2'],
  );
  await m.unmount();
}

// 2.8 换一个行业包：阶段名、客户的叫法跟着换；已成交按这个包的终态「已付定金」判定
{
  server = {
    pack: HOME,
    conversations: [
      conv('H01', 'measure', false, 3, '2026-09-26T13:00:00'),
      conv('H02', 'consult', true, 2, '2026-09-26T14:00:00'),
      conv('H03', 'deposit', false, 9, '2026-09-25T14:00:00'),
      conv('H05', 'deposit', true, 6, '2026-09-25T12:00:00'),
    ],
  };
  const m = await mount(member('owner', HOME));
  eq(
    '家装包：区块头与状态句用包里的叫法',
    [m.texts('h2'), m.texts('.page-status')],
    [['业主停在哪一步'], ['企业微信里的业主会话·在工作台里接手和回复']],
  );
  eq(
    '家装包：页签的已成交数停在「已付定金」的会话（含转过人工的）',
    m.tabs().map((t) => t[0]),
    ['全部4', '等人接手1', 'AI接待中1', '已成交2'],
  );
  eq(
    '家装包：阶段条按包里的阶段，不含终态，也没有「其他」',
    m.stages().map((s) => s[0] + s[1]),
    ['咨询0', '量房1', '签约0'],
  );
  eq(
    '家装包：表格',
    m.rows().map((r) => r.slice(0, 3)),
    [
      ['企微业主·H02', '等人接手', '—'],
      ['企微业主·H01', 'AI接待中', '量房'],
      ['企微业主·H03', '已成交', '已付定金'],
      ['企微业主·H05', '已成交', '已付定金'],
    ],
  );
  check('家装包：页面上没有旅游包的阶段名', !/报价|推荐|问需|促成/.test(m.box.textContent ?? ''), m.box.textContent ?? '');
  await m.unmount();
  const paid = await mount(member('owner', HOME), '?state=paid');
  eq(
    '家装包：已成交页签列出停在「已付定金」的会话',
    [paid.tabs()[3], paid.rows().map((r) => r.slice(0, 3))],
    [
      ['已成交2', 'true'],
      [
        ['企微业主·H03', '已成交', '已付定金'],
        ['企微业主·H05', '已成交', '已付定金'],
      ],
    ],
  );
  await paid.unmount();
}

Date.now = realNow;

// ---------------- 3. public/admin.html 的 #s=<id> 深链 ----------------
// 页面脚本原样在一个新的 happy-dom 窗口里跑（window.eval）；后台接口是假的：prod 形态没登录时列表 401，演示形态没登录时只给种子会话

const ADMIN_HTML = fs.readFileSync(new URL('../../../public/admin.html', import.meta.url), 'utf8');
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(ADMIN_HTML)?.[1] ?? '';
check('admin.html：取得到页面脚本', SCRIPT.includes('function load()'));
const TOKEN = `Basic ${Buffer.from('admin:pw').toString('base64')}`;

interface AdminWorld {
  win: Window;
  log: string[];
  $: (sel: string) => Element | null;
  selected: () => string | null;
  loginShown: () => boolean;
  hash: () => string;
  settle: () => Promise<void>;
  close: () => Promise<void>;
}

/** 打开 admin.html#…：anonSeed 为真是演示形态（没登录也给 wecom:cust_ 种子会话），否则是 prod 形态（没登录 401） */
async function openAdmin(
  hash: string,
  opts: { anonSeed?: boolean; token?: string; sessions?: string[]; offline?: boolean } = {},
): Promise<AdminWorld> {
  const w = new Window({ url: `http://localhost/admin.html${hash}`, width: 1440, height: 900 });
  const log: string[] = [];
  const ids = opts.sessions ?? ['wecom:cust_A01', 'wecom:cust_B01', 'wecom:real_7F3A'];
  const session = (id: string) => ({
    id,
    channel: 'wecom',
    stage: 'quote',
    profile: { destinationInterest: '贵州' },
    messages: [],
    orderIds: [],
    handedOver: false,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 600_000,
  });
  (w as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization === TOKEN;
    log.push(`${url.pathname} ${auth ? 'auth' : 'anon'}`);
    if (opts.offline) throw new TypeError('Failed to fetch');
    if (url.pathname === '/api/admin/whoami') return auth ? json(200, { user: 'admin' }) : json(401, { error: 'unauthorized' });
    if (url.pathname === '/api/sessions') {
      if (auth) return json(200, ids.map(session));
      return opts.anonSeed
        ? json(200, ids.filter((id) => id.startsWith('wecom:cust_')).map(session))
        : json(401, { error: 'unauthorized' });
    }
    if (url.pathname === '/api/orders') return auth || opts.anonSeed ? json(200, []) : json(401, { error: 'unauthorized' });
    if (url.pathname === '/api/usage') return json(200, { totalCalls: 0, totalCny: 0, avgCnyPerSession: 0, cacheHitRate: 0 });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  if (opts.token) w.sessionStorage.setItem('adminAuth', opts.token.replace(/^Basic /, ''));
  w.document.write(ADMIN_HTML.replace(/<script>[\s\S]*<\/script>/, ''));
  const errors: string[] = [];
  w.addEventListener('error', (e) => errors.push(String((e as unknown as { message?: string }).message)));
  try {
    (w as unknown as { eval: (code: string) => unknown }).eval(SCRIPT);
  } catch (e) {
    // 启动时就抛错（比如写坏的 hash 解码失败）：记下来，由 close() 里那条点名，不让整个自测崩掉
    errors.push(String(e));
  }
  const world: AdminWorld = {
    win: w,
    log,
    $: (sel) => w.document.querySelector(sel) as unknown as Element | null,
    selected: () => w.document.querySelector('.row.on')?.getAttribute('data-id') ?? null,
    loginShown: () => !(w.document.getElementById('loginMask') as unknown as HTMLElement).hidden,
    hash: () => w.location.hash,
    // 不用 waitUntilComplete：页面的 setInterval(load, 30000) 一直挂着，它等不完。假接口的响应都是现成的，等几轮就回来了
    async settle() {
      for (let i = 0; i < 10; i += 1) await new Promise((res) => setTimeout(res, 2));
    },
    async close() {
      check(`admin.html ${hash}：页面脚本没有报错`, errors.length === 0, errors.join(' | '));
      await w.happyDOM.abort();
      await w.close();
    },
  };
  await world.settle();
  return world;
}

/** 在登录框里输入密码并提交 */
async function login(a: AdminWorld, password: string): Promise<void> {
  (a.$('#lgPass') as unknown as HTMLInputElement).value = password;
  (a.$('#loginForm') as unknown as HTMLFormElement).dispatchEvent(new a.win.Event('submit', { cancelable: true }) as unknown as Event);
  await a.settle();
}

// 3.1 prod 形态、真实客户的会话：没登录时列表里没有，弹登录框；登录后选中它，hash 一直在
{
  const a = await openAdmin('#s=wecom%3Areal_7F3A');
  eq(
    '深链：没登录、列表里没有这个会话时弹登录框，说明要登录',
    [a.loginShown(), a.$('#loginTip')?.textContent, a.selected(), a.hash()],
    [true, '这个会话要登录顾问账号才能看。登录后直接打开它。', null, '#s=wecom%3Areal_7F3A'],
  );
  // 点「返回演示」关掉登录框：之后列表轮询（每 30 秒 load 一次）不再弹，只在启动时核对一次
  (a.$('#lgCancel') as unknown as HTMLElement).click();
  (a.win as unknown as { eval: (code: string) => unknown }).eval('load()');
  await a.settle();
  eq('深链：关掉登录框后，下一次取列表不再弹', [a.loginShown(), a.hash()], [false, '#s=wecom%3Areal_7F3A']);
  (a.$('#modeBtn') as unknown as HTMLElement).click();
  await a.settle();
  check('深链：从顶栏「登录」再打开登录框', a.loginShown());
  await login(a, 'wrong');
  eq(
    '深链：密码不对时登录框还在，hash 还在',
    [a.loginShown(), a.$('#lgErr')?.textContent, a.hash()],
    [true, '用户名或密码错误', '#s=wecom%3Areal_7F3A'],
  );
  await login(a, 'pw');
  eq(
    '深链：登录框走完后选中这个会话，hash 还在',
    [a.loginShown(), a.selected(), a.hash()],
    [false, 'wecom:real_7F3A', '#s=wecom%3Areal_7F3A'],
  );
  check('深链：右侧是这个会话的详情', !!a.$('#main .msgs'), a.$('#main')?.textContent?.slice(0, 120) ?? '');
  eq(
    '深链：登录前按匿名取列表，登录后按新身份重取',
    [a.log.find((l) => l.startsWith('/api/sessions ')), a.log.filter((l) => l.startsWith('/api/sessions ')).at(-1)],
    ['/api/sessions anon', '/api/sessions auth'],
  );
  // 选另一个会话：hash 跟着走；回到首页：hash 清掉
  (a.$('.row[data-id="wecom:cust_B01"]') as unknown as HTMLElement).click();
  await a.settle();
  eq('选另一个会话：hash 跟着选中项', [a.selected(), a.hash()], ['wecom:cust_B01', '#s=wecom%3Acust_B01']);
  (a.$('#home') as unknown as HTMLElement).click();
  await a.settle();
  eq('回到首页：没有选中，hash 清掉', [a.selected(), a.hash()], [null, '']);
  // 地址栏里改 hash：跟着选
  a.win.location.hash = '#s=wecom%3Acust_A01';
  await a.settle();
  eq('hashchange：跟着选', a.selected(), 'wecom:cust_A01');
  await a.close();
}

// 3.2 演示形态、种子会话：没登录就在列表里，直接选中，不弹登录框
{
  const a = await openAdmin('#s=wecom%3Acust_A01', { anonSeed: true });
  eq('深链：演示会话免登录直接选中', [a.loginShown(), a.selected(), a.hash()], [false, 'wecom:cust_A01', '#s=wecom%3Acust_A01']);
  await a.close();
}

// 3.3 已登录（同一个标签页里登录过），列表里却没有这个会话：不弹登录框，停在首页
{
  const a = await openAdmin('#s=wecom%3Agone', { token: TOKEN });
  eq('深链：已登录而会话不在了，不弹登录框', [a.loginShown(), a.selected()], [false, null]);
  await a.close();
}

// 3.35 启动时列表没取到（断网）：分不清是不是要登录，不弹登录框，hash 留着
{
  const a = await openAdmin('#s=wecom%3Areal_7F3A', { offline: true });
  eq('深链：列表没取到时不弹登录框', [a.loginShown(), a.hash()], [false, '#s=wecom%3Areal_7F3A']);
  await a.close();
}

// 3.4 写坏的 hash、别的 hash：不报错、不选中；写法不规范的 id 按原样认出来，hash 换成规范写法
{
  const bad = await openAdmin('#s=%E0%A4%A', { anonSeed: true });
  eq('深链：写坏的 hash 不选中也不弹登录框', [bad.selected(), bad.loginShown()], [null, false]);
  await bad.close();
  const other = await openAdmin('#top', { anonSeed: true });
  eq('深链：别的 hash 不管', [other.selected(), other.loginShown(), other.hash()], [null, false, '#top']);
  await other.close();
  const raw = await openAdmin('#s=wecom:cust_A01', { anonSeed: true });
  eq('深链：没编码的 id 也认，hash 换成编码后的写法', [raw.selected(), raw.hash()], ['wecom:cust_A01', '#s=wecom%3Acust_A01']);
  await raw.close();
}

if (fails.length) {
  console.error(`conversations: ${fails.length} 条断言失败（通过 ${pass} 条）`);
  for (const x of fails) console.error(`  ✗ ${x}`);
  process.exit(1);
}
console.log(`conversations: ${pass} 条断言全部通过`);
process.exit(0);
