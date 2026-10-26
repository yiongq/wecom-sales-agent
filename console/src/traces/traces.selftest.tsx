// AI 记录页的自测（07 spec R24、验收 12，后台 UX spec 不变量 7、9、22）。
// 1. 纯逻辑（traces-search.ts、model.ts）：地址参数的取舍；地址里的筛选按真实的表再筛一遍、换算成接口的查询串（since 在取数那一刻往前推）；
//    筛选变了地址怎么写；空状态的去向；一行写什么（步骤 id 不上页面）；各个取值表（结果、护栏、转人工原因）与服务端的取值一一对应。
// 2. 在 DOM 里挂载（happy-dom）：真的 TracesPage 加照服务端规则算的假接口。加载（骨架）、列表、按地址还原筛选并按它请求、
//    点时间段改地址、翻页（游标原样传回）、空（带清空筛选）、文件存储 503、出错重试、翻页出错只在底部说明、
//    坐席与匿名不发请求；点一行开抽屉，里面是现有的「AI为什么这么回」：客户原话、护栏、转人工原因；「存为回归用例」下载草稿，出错就地说明。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/traces/traces.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TRACE_OUTCOMES, type Me, type Role, type TracePage, type TraceRow, type TurnTraceView } from '../../../src/shared/console-api.js';
import { HANDOFF_NOTICE_TEXT } from '../../../src/shared/conversation.js';
import { isHandoffKind } from '../../../src/shared/conversation-types.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { GUARD_STEP_LABEL, guardLabel } from '../../../src/shared/ui-labels.js';
import type { Viewer } from '../shell/boot.js';
import { tracesSearch } from '../traces-search.js';
import { VIEWER_KEY } from '../viewer.js';
import {
  emptyLink,
  filtersOf,
  GUARD_OPTIONS,
  guardsText,
  HANDOFF_OPTIONS,
  OUTCOME_OPTIONS,
  queryOf,
  rangeOf,
  rowAria,
  rowView,
  tookText,
  TRACE_PAGE,
  withFilter,
} from './model.js';
import { TracesPage } from './TracesPage.js';

/** antd 的按钮在两个汉字之间自动插一个空格（「重 试」），比文字时去掉 */
const squash = (t: string): string => t.replace(/\s+/g, '');

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

const NOW = Date.parse('2026-09-26T14:30:00+08:00');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const TRAVEL: IndustryPack = {
  id: 'travel',
  name: '旅游',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: {}, sopFields: {} },
  entities: [],
  stages: [
    { key: 'greeting', label: '开场' },
    { key: 'quote', label: '报价' },
    { key: 'paid', label: '已支付', terminal: true },
  ],
  sopSections: [{ key: 'preamble', heading: null, locked: false }],
  nav: { catalogGroup: '产品库', entities: [] },
};

// ---------------- 1. 纯逻辑 ----------------

eq(
  '地址参数：合规的留下，range=7d 是默认不留',
  tracesSearch({ range: '30d', outcome: 'handoff', guard: 'takeover_check:pre', handoff: 'complaint', over: 1 }),
  { range: '30d', outcome: 'handoff', guard: 'takeover_check:pre', handoff: 'complaint', over: 1 },
);
eq(
  '地址参数：range=7d 与不认识的写法丢掉',
  [tracesSearch({ range: '7d' }).range, tracesSearch({ range: 'forever' }).range],
  [undefined, undefined],
);
eq(
  '地址参数：写法不对的丢掉（大写、带空格、数字开头、过长、over 不是 1）',
  tracesSearch({ outcome: 'Handoff', guard: 'a b', handoff: '1x', over: 0 }),
  { range: undefined, outcome: undefined, guard: undefined, handoff: undefined, over: undefined },
);
eq('地址参数：over 写字符串 1 也认（地址里读出来可能是字符串）', tracesSearch({ over: '1' }).over, 1);
eq('地址参数：键总是写出来', Object.keys(tracesSearch({})).sort(), ['guard', 'handoff', 'outcome', 'over', 'range']);

eq('筛选：默认是近 7 天、没有别的筛选', filtersOf({}), { range: '7d', over: false });
eq('筛选：认得的取值留下', filtersOf({ range: '1d', outcome: 'handoff', guard: 'price', handoff: 'refund', over: 1 }), {
  range: '1d',
  outcome: 'handoff',
  guard: 'price',
  handoff: 'refund',
  over: true,
});
eq(
  '筛选：写法对但不认识的结果、护栏、转人工原因当没写（不发给接口，免得 400）',
  filtersOf({ outcome: 'bogus', guard: 'bogus_step', handoff: 'bogus' }),
  { range: '7d', over: false },
);
eq('筛选：toString 这类原型上的名字也不认', filtersOf({ guard: 'toString', outcome: 'constructor' }), { range: '7d', over: false });
eq('时间段：不写是 7d', [rangeOf({}), rangeOf({ range: 'all' })], ['7d', 'all']);

{
  const q = queryOf(filtersOf({}), NOW);
  eq('查询串：默认带 limit 与近 7 天的 since', q, { limit: String(TRACE_PAGE), since: new Date(NOW - 7 * DAY).toISOString() });
  eq(
    '查询串：全部筛选，all 不带 since，before 原样',
    queryOf(filtersOf({ range: 'all', outcome: 'handoff', guard: 'price', handoff: 'complaint', over: 1 }), NOW, 'CURSOR'),
    { limit: String(TRACE_PAGE), outcome: 'handoff', guard: 'price', handoffKind: 'complaint', overLimit: '1', before: 'CURSOR' },
  );
  eq(
    '查询串：近 24 小时与近 30 天',
    [queryOf(filtersOf({ range: '1d' }), NOW).since, queryOf(filtersOf({ range: '30d' }), NOW).since],
    [new Date(NOW - DAY).toISOString(), new Date(NOW - 30 * DAY).toISOString()],
  );
  check('查询串：每页条数不超过接口上限 100', TRACE_PAGE >= 1 && TRACE_PAGE <= 100);
}
eq('改地址：设一个筛选', withFilter({}, { outcome: 'handoff' }), { outcome: 'handoff' });
eq(
  '改地址：清掉一个筛选（undefined、空串都删）',
  withFilter({ outcome: 'handoff', guard: 'price' }, { outcome: undefined, guard: '' }),
  {},
);
eq('改地址：时间段选回默认就不写', withFilter({ range: '30d', over: 1 }, { range: '7d' }), { over: 1 });
eq('改地址：关掉超长筛选', withFilter({ over: 1, outcome: 'error' }, { over: undefined }), { outcome: 'error' });
eq('空状态的去向：有筛选 → 清空筛选（回默认）', emptyLink(filtersOf({ outcome: 'error' })), { label: '清空筛选', search: {} });
eq('空状态的去向：只改了时间段（近 24 小时）→ 清空筛选', emptyLink(filtersOf({ range: '1d' }))?.label, '清空筛选');
eq('空状态的去向：默认的近 7 天里没有 → 看全部时间', emptyLink(filtersOf({})), { label: '看全部时间', search: { range: 'all' } });
eq('空状态的去向：已经是全部时间且没有别的筛选 → 没有可清的', emptyLink(filtersOf({ range: 'all' })), null);
eq('空状态的去向：全部时间但有别的筛选 → 清空筛选', emptyLink(filtersOf({ range: 'all', over: 1 }))?.label, '清空筛选');

eq(
  '耗时：不到 1 秒写毫秒，其余写秒',
  [tookText(0), tookText(999), tookText(1000), tookText(1530), tookText(12_340)],
  ['0毫秒', '999毫秒', '1.0秒', '1.5秒', '12.3秒'],
);
eq(
  '护栏一格：没有写「—」；两个以内全写；更多的写「等N项」；同名的合并；认不得的写「其他护栏」',
  [
    guardsText([]).short,
    guardsText(['price', 'claim_words']).short,
    guardsText(['price', 'claim_words', 'identity']).short,
    guardsText(['repair_links:mark', 'repair_links:mark']).short,
    guardsText(['future_step']).short,
  ],
  ['—', '价格核对、越权说法', '价格核对、越权说法等3项', '链接补全', '其他护栏'],
);
eq('护栏一格：悬停写全部', guardsText(['price', 'claim_words', 'identity']).full, '价格核对、越权说法、身份说明');
eq('护栏名：只认自有属性', [guardLabel('toString'), guardLabel('__proto__'), guardLabel('price')], ['其他护栏', '其他护栏', '价格核对']);

// 取值表与服务端一一对应
eq(
  '结果的取值表：与服务端的取值一一对应，每个都有中文',
  OUTCOME_OPTIONS.map((o) => o.value),
  [...TRACE_OUTCOMES],
);
check('结果的中文互不相同', new Set(OUTCOME_OPTIONS.map((o) => o.label)).size === TRACE_OUTCOMES.length);
// 取值表由提醒用的那张中文表（HANDOFF_NOTICE_TEXT）去掉「只在提醒里有」的类型得到：以后转人工的类型多一种（它要给中文，否则那张表编译不过），
// 筛选里自动多一项；这里核对的是「全是转人工的类型、没有重复、不含提醒专用的、每个都有中文」，不写死有几种
const NOTICE_ONLY = ['order_unconfirmed', 'window_closing', 'still_waiting', 'quote_pending', 'quote_accepted'];
check(
  '转人工原因的取值表：都是转人工的类型、不重复、不含提醒专用类型、每个都有中文，也不漏（提醒表里去掉提醒专用类型就是它）',
  HANDOFF_OPTIONS.every((o) => isHandoffKind(o.value) && o.label.length > 0 && !NOTICE_ONLY.includes(o.value)) &&
    new Set(HANDOFF_OPTIONS.map((o) => o.value)).size === HANDOFF_OPTIONS.length &&
    JSON.stringify(HANDOFF_OPTIONS.map((o) => o.value)) ===
      JSON.stringify(Object.keys(HANDOFF_NOTICE_TEXT).filter((k) => !NOTICE_ONLY.includes(k))) &&
    ['request', 'complaint', 'refund', 'emergency', 'agent'].every((k) => HANDOFF_OPTIONS.some((o) => o.value === k)),
  JSON.stringify(HANDOFF_OPTIONS.map((o) => o.value)),
);
check(
  '护栏的取值表：就是 GUARD_STEP_LABEL，名字不为空',
  GUARD_OPTIONS.length === Object.keys(GUARD_STEP_LABEL).length && GUARD_OPTIONS.every((o) => o.label.length > 0),
);

const ROW: TraceRow = {
  turnId: 'tn-1',
  conversationId: 'wecom:cust_F01',
  channel: 'wecom',
  startedAt: ago(5 * MIN),
  durationMs: 800,
  outcome: 'handoff',
  guards: ['claim_words', 'identity', 'future_step'],
  handoffKind: 'complaint',
  overLimit: true,
};
{
  const v = rowView(ROW, TRAVEL, NOW);
  eq(
    '一行：会话标签、相对时间与悬停的绝对时间、结果、护栏、转人工原因、超长、耗时',
    [v.label, v.when, v.whenFull, v.outcome, v.guards, v.handoff, v.overLimit, v.took],
    [['企微客户', 'F01'], '5分钟前', '9月26日 14:25', '转人工', '越权说法、身份说明等3项', HANDOFF_NOTICE_TEXT.complaint, true, '800毫秒'],
  );
  eq('一行：读屏念的', rowAria(v), '企微客户 F01，5分钟前，转人工');
  const plain = rowView({ ...ROW, channel: 'simulator', guards: [], handoffKind: null, overLimit: false, outcome: 'replied' }, TRAVEL, NOW);
  eq(
    '一行：没有护栏、没有转人工、不超长',
    [plain.label, plain.guards, plain.handoff, plain.overLimit],
    [['演示客户', 'F01'], '—', null, false],
  );
  const visible = [v.label.join(' '), v.when, v.whenFull, v.outcome, v.guards, v.guardsFull, v.handoff ?? '', v.took].join(' ');
  check(
    '不变量 7：一行的可见文字里没有步骤 id 和机器码',
    !/[a-z]+_[a-z_]+|handoff|replied|complaint|claim_words|identity/.test(visible),
    visible,
  );
}

// ---------------- 2. 在 DOM 里挂载 ----------------
const realNow = Date.now;
Date.now = () => NOW;

const R = (n: number, over: Partial<TraceRow> = {}): TraceRow => ({
  turnId: `tn-${n}`,
  conversationId: `wecom:cust_F0${n}`,
  channel: 'wecom',
  startedAt: ago(n * 30 * MIN),
  durationMs: 1000 + n * 10,
  outcome: 'replied',
  guards: [],
  handoffKind: null,
  overLimit: false,
  ...over,
});
const DATA: TraceRow[] = [
  R(1, { outcome: 'handoff', guards: ['claim_words', 'identity'], handoffKind: 'complaint', overLimit: true, durationMs: 800 }),
  R(2, { guards: ['price'], durationMs: 1530 }),
  R(3, { outcome: 'silent', channel: 'simulator', startedAt: ago(26 * HOUR) }),
  R(4, { outcome: 'error', guards: ['takeover_check:pre'], startedAt: ago(3 * DAY) }),
  R(5, { startedAt: ago(10 * DAY) }),
];

const DETAIL: Record<string, TurnTraceView> = {
  'tn-1': {
    turnId: 'tn-1',
    startedAt: ago(5 * MIN),
    durationMs: 800,
    outcome: 'handoff',
    sopVersion: 3,
    prefixHash: 'a'.repeat(64),
    catalogVersions: {},
    stageBefore: 'quote',
    stageAfter: 'quote',
    draft: '模型原稿',
    finalText: '很抱歉，已为您转接顾问。',
    calls: [],
    llm: [],
    signals: null,
    guardVerdicts: [
      { id: 'pre_clean', action: 'pass' },
      { id: 'claim_words', action: 'replace' },
      { id: 'identity', action: 'append' },
    ],
    replyShape: { class: 'plain', lines: 5, chars: 120, limit: 3, trimmed: 1, overLimit: true, rewrite: 'off', rewriteMs: null },
    handoffKind: 'complaint',
    customerText: '你们太慢了，我要投诉',
  },
  'tn-3': {
    turnId: 'tn-3',
    startedAt: ago(26 * HOUR),
    durationMs: 50,
    outcome: 'silent',
    sopVersion: null,
    prefixHash: 'b'.repeat(64),
    catalogVersions: {},
    stageBefore: null,
    stageAfter: null,
    draft: null,
    finalText: null,
    calls: [],
    llm: [],
    signals: null,
    guardVerdicts: null,
    replyShape: null,
    handoffKind: null,
    customerText: null,
  },
};

interface Server {
  rows: TraceRow[];
  /** 每页条数（缺省取请求的 limit）：造出多页 */
  pageSize?: number;
  /** /traces 回这个状态：503 是文件存储 */
  traces?: { status: number; body: unknown };
  /** 第二页起回 500 */
  failFrom?: boolean;
  /** 设了就让 /traces 的响应先等它：看加载中的骨架 */
  hold?: Promise<void>;
  /** goal-draft 的响应 */
  draft?: { status: number; body: string };
}
let server: Server = { rows: DATA };
let requests: string[] = [];
const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

/** 照服务端：筛选、倒序（数据已按时间倒序）、before 是游标（这里就是下标）、多一条才给 next */
async function respond(method: string, url: URL): Promise<Response> {
  const p = url.pathname.replace(/^\/api\/console/, '');
  const q = url.searchParams;
  if (method === 'GET' && p === '/traces') {
    if (server.hold) await server.hold;
    if (server.traces) return json(server.traces.status, server.traces.body);
    if (server.failFrom && q.get('before')) return json(500, { error: 'internal', detail: '故意的' });
    const since = q.get('since');
    const rows = server.rows.filter(
      (r) =>
        (since === null || r.startedAt >= since) &&
        (!q.get('outcome') || r.outcome === q.get('outcome')) &&
        (!q.get('guard') || r.guards.includes(q.get('guard')!)) &&
        (!q.get('handoffKind') || r.handoffKind === q.get('handoffKind')) &&
        (q.get('overLimit') !== '1' || r.overLimit),
    );
    const from = q.get('before') === null ? 0 : Number(q.get('before'));
    const limit = server.pageSize ?? Number(q.get('limit') ?? 50);
    const items = rows.slice(from, from + limit);
    const page: TracePage = { items, next: from + limit < rows.length ? String(from + limit) : null };
    return json(200, page);
  }
  const m = /^\/conversations\/([^/]+)\/turns\/([^/]+)(\/goal-draft)?$/.exec(p);
  if (method === 'GET' && m && !m[3]) {
    const d = DETAIL[decodeURIComponent(m[2]!)];
    return d ? json(200, d) : json(404, { error: 'not_found', detail: '这一轮没有记录' });
  }
  if (method === 'GET' && m && m[3]) {
    const d = server.draft ?? { status: 200, body: '{"id":"draft-tn-1","predicates":[],"_draft":{}}\n' };
    return new Response(d.body, {
      status: d.status,
      headers:
        d.status === 200
          ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="goal-draft-tn-1.json"' }
          : { 'Content-Type': 'application/json' },
    });
  }
  return json(404, { error: 'not_found' });
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url.pathname}${url.search}`);
  return respond(method, url);
}) as typeof fetch;
const listRequests = (): string[] => requests.filter((r) => r.startsWith('GET /api/console/traces'));
const paramsOf = (r: string): URLSearchParams => new URL(r.slice(4), 'http://localhost').searchParams;

// 下载：saveText 用 Blob 加 <a download>；这里接住 Blob，不真的触发浏览器下载
const downloads: { name: string; text: Promise<string> }[] = [];
const urlApi = URL as unknown as { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
let lastBlob: Blob | null = null;
urlApi.createObjectURL = (b: Blob) => {
  lastBlob = b;
  return 'blob:selftest';
};
urlApi.revokeObjectURL = () => {};
const anchorProto = win.HTMLAnchorElement.prototype as unknown as { click: () => void };
const realAnchorClick = anchorProto.click;
// 带 download 的链接是 saveText 在点：接住它，不触发浏览器下载；别的链接照常点（路由的 Link 靠它）
anchorProto.click = function click(this: HTMLAnchorElement) {
  if (this.download) {
    if (lastBlob) downloads.push({ name: this.download, text: lastBlob.text() });
    return;
  }
  realAnchorClick.call(this);
};

const me = (role: Role): Me => ({
  userId: 'u1',
  displayName: '老板',
  role,
  csrf: 'c1',
  tenantSlug: 'yuntu',
  tenantName: '云途定制旅行',
  sandbox: null,
});
const member = (role: Role): Viewer => ({ kind: 'member', me: me(role), pack: TRAVEL });

async function settle(qc: QueryClient): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0 && qc.isMutating() === 0) break;
  }
}

async function mount(viewer: Viewer, search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(VIEWER_KEY, viewer);
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/traces', validateSearch: tracesSearch, component: TracesPage }),
      createRoute({ getParentRoute: () => root, path: '/conversations/$id', component: () => null }),
    ]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: [`/console/traces${search}`] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  await act(async () =>
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never }))),
  );
  await settle(qc);
  const $ = (sel: string, from: ParentNode = document): HTMLElement[] => [...from.querySelectorAll<HTMLElement>(sel)];
  const text = (e: Element | undefined | null): string => (e?.textContent ?? '').trim();
  return {
    qc,
    router,
    box,
    $,
    text,
    texts: (sel: string): string[] => $(sel).map(text),
    /** 表里每一行每一格的字 */
    table: (): string[][] => $('.tr-table tbody tr.ant-table-row', box).map((tr) => $('td', tr).map(text)),
    url: (): string => router.state.location.href,
    settle: () => settle(qc),
    async click(el: Element | undefined | null) {
      if (!el) throw new Error('要点的元素不在页面上');
      await act(async () => void (el as HTMLElement).click());
      await settle(qc);
    },
    async unmount() {
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
      for (const n of Array.from(document.body.children)) if (n !== box) n.remove();
    },
  };
}

// 2.1 所有者：请求、页头、表格
{
  server = { rows: DATA };
  requests = [];
  const m = await mount(member('owner'));
  const reqs = listRequests();
  eq(
    '请求：一次，每页 50 条，带近 7 天的 since，没有别的筛选',
    [reqs.length, paramsOf(reqs[0]!).get('limit'), paramsOf(reqs[0]!).get('since'), [...paramsOf(reqs[0]!).keys()].sort()],
    [1, '50', new Date(NOW - 7 * DAY).toISOString(), ['limit', 'since']],
  );
  eq('页头：标题', m.text(m.box.querySelector('h1')), 'AI记录');
  eq('表头', m.texts('.tr-table thead th'), ['时间', '会话', '结果', '触发的护栏', '转人工原因', '回复', '耗时']);
  eq('表格：近 7 天里的 4 行（第 5 行是 10 天前，服务端按 since 滤掉），一行七格', m.table(), [
    ['30分钟前', '企微客户·F01', '转人工', '越权说法、身份说明', HANDOFF_NOTICE_TEXT.complaint, '超长', '800毫秒'],
    ['1小时前', '企微客户·F02', 'AI回复', '价格核对', '—', '—', '1.5秒'],
    ['昨天12:30', '演示客户·F03', '没有回复', '—', '—', '—', '1.0秒'],
    ['9月23日', '企微客户·F04', '出错', '接手检查（前）', '—', '—', '1.0秒'],
  ]);
  check(
    '表格：时间是真正的按钮，名字是读屏念的一行，悬停是绝对时间',
    m.$('.tr-when', m.box).length === 4 &&
      m.$('.tr-when', m.box)[0]!.getAttribute('aria-label') === '企微客户 F01，30分钟前，转人工' &&
      m.$('.tr-when time', m.box)[0]!.getAttribute('title') === '9月26日 14:00',
  );
  check('会话那一格是去工作台的链接', m.$('.tr-conv', m.box)[0]?.getAttribute('href') === '/console/conversations/wecom%3Acust_F01');
  const visible = m.text(m.box);
  check(
    '不变量 7：页面上没有护栏的步骤 id、结果与转人工原因的机器码',
    !/claim_words|takeover_check|handoff|replied|complaint|identity/.test(visible),
    visible.slice(0, 300),
  );
  eq(
    '到底了：没有「加载更早的记录」，写一句',
    [m.$('.tr-more', m.box).length, m.text(m.box.querySelector('.tr-end'))],
    [0, '没有更早的记录了'],
  );
  check('整页没有红色出错提示', m.$('.ant-alert-error', m.box).length === 0);
  await m.unmount();
}

// 2.2 地址里的筛选：还原并按它请求；点时间段改地址
{
  server = { rows: DATA };
  requests = [];
  const m = await mount(member('admin'), '?outcome=handoff&guard=claim_words&handoff=complaint&over=1&range=all');
  const p = paramsOf(listRequests()[0]!);
  eq('地址里的筛选：原样变成接口的查询串（all 不带 since）', [...p.entries()].sort(), [
    ['guard', 'claim_words'],
    ['handoffKind', 'complaint'],
    ['limit', '50'],
    ['outcome', 'handoff'],
    ['overLimit', '1'],
  ]);
  eq(
    '地址里的筛选：只剩第 1 行',
    m.table().map((r) => r[1]),
    ['企微客户·F01'],
  );
  eq(
    '筛选控件显示选中的值',
    [
      m.text(m.box.querySelector('.ant-segmented-item-selected')),
      m.box.querySelector('.tr-over .ant-switch')?.getAttribute('aria-checked'),
      m.$('.tr-select .ant-select-content', m.box).map((e) => e.getAttribute('title')),
    ],
    ['全部', 'true', ['转人工', '越权说法', HANDOFF_NOTICE_TEXT.complaint]],
  );
  await m.unmount();

  requests = [];
  const m2 = await mount(member('owner'), '?outcome=bogus&guard=nope&range=forever');
  const q2 = paramsOf(listRequests()[0]!);
  eq('认不得的筛选取值：不发给接口（只有 limit 与默认的 since）', [...q2.keys()].sort(), ['limit', 'since']);
  await m2.unmount();

  requests = [];
  const m3 = await mount(member('owner'));
  const items = m3.$('.ant-segmented-item-label', m3.box);
  eq(
    '时间段：四段',
    items.map((e) => m3.text(e)),
    ['近24小时', '近7天', '近30天', '全部'],
  );
  await m3.click(items[2]);
  eq(
    '点「近30天」：地址写 range=30d，按新地址请求（since 往前推 30 天），表里多出 10 天前的一行',
    [m3.url(), paramsOf(listRequests().at(-1)!).get('since'), m3.table().length],
    ['/traces?range=30d', new Date(NOW - 30 * DAY).toISOString(), 5],
  );
  await m3.click(m3.$('.ant-segmented-item-label', m3.box)[1]);
  // 下拉选一个：打开（鼠标按下）、点选项；选完地址和请求都跟着变，表里只剩符合的行
  const pick = async (n: number, label: string): Promise<void> => {
    const content = m3.$('.tr-select', m3.box)[n]!.querySelector('.ant-select-content')!;
    await act(async () => void content.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }) as unknown as Event));
    await m3.settle();
    await m3.click(m3.$('.ant-select-item-option').find((e) => m3.text(e) === label));
  };
  await pick(0, '转人工');
  eq(
    '下拉选结果「转人工」：地址写 outcome=handoff，请求带 outcome，只剩第 1 行',
    [m3.url(), paramsOf(listRequests().at(-1)!).get('outcome'), m3.table().length],
    ['/traces?outcome=handoff', 'handoff', 1],
  );
  await pick(1, '越权说法');
  eq(
    '再选护栏「越权说法」：两个筛选叠加',
    [m3.url(), paramsOf(listRequests().at(-1)!).get('guard')],
    ['/traces?outcome=handoff&guard=claim_words', 'claim_words'],
  );
  await pick(2, HANDOFF_NOTICE_TEXT.complaint);
  eq('再选转人工原因：请求带 handoffKind', [paramsOf(listRequests().at(-1)!).get('handoffKind'), m3.table().length], ['complaint', 1]);
  await m3.click(m3.box.querySelector('.tr-over .ant-switch'));
  eq(
    '开「只看回复超长的」：地址写 over=1，请求带 overLimit=1',
    [m3.url().includes('over=1'), paramsOf(listRequests().at(-1)!).get('overLimit')],
    [true, '1'],
  );
  await m3.click(m3.box.querySelector('.tr-over .ant-switch'));
  eq('关掉：地址里不再有 over', m3.url().includes('over='), false);
  await m3.click(m3.box.querySelector('.tr-select .ant-select-clear'));
  eq('清掉结果筛选：地址里不再有 outcome', m3.url().includes('outcome='), false);
  eq('点回「近7天」：地址里不再写 range', m3.url().includes('range='), false);
  await m3.unmount();
}

// 2.3 加载中的骨架
{
  let release: () => void = () => {};
  server = { rows: DATA, hold: new Promise<void>((r) => (release = r)) };
  requests = [];
  const m = await mount(member('owner'));
  eq(
    '加载中：整块是骨架（带「正在载入」），没有表格也没有空状态',
    [
      m.$('.state-skeleton[role="status"]', m.box).length,
      m.$('.skeleton-row', m.box).length,
      m.$('.tr-table', m.box).length,
      m.$('.state-empty', m.box).length,
    ],
    [1, 8, 0, 0],
  );
  eq('加载中：页头与筛选已经在', [m.text(m.box.querySelector('h1')), m.$('.tr-filters', m.box).length], ['AI记录', 1]);
  release();
  await m.settle();
  eq('加载完：骨架换成表格', [m.$('.state-skeleton', m.box).length, m.table().length], [0, 4]);
  await m.unmount();
}

// 2.4 空、文件存储 503、出错重试
{
  server = { rows: [] };
  requests = [];
  const m = await mount(member('owner'));
  eq(
    '空：「这段时间没有AI记录」，默认的近 7 天里没有时链接是「看全部时间」',
    [m.text(m.box.querySelector('.state-empty-title')), m.text(m.box.querySelector('.state-empty a')), m.$('.tr-table', m.box).length],
    ['这段时间没有AI记录', '看全部时间', 0],
  );
  await m.click(m.box.querySelector('.state-empty a'));
  eq(
    '点「看全部时间」：地址写 range=all，请求不带 since',
    [m.url(), paramsOf(listRequests().at(-1)!).has('since')],
    ['/traces?range=all', false],
  );
  eq('时间段放开之后还是空：没有可清的筛选，就没有链接', m.$('.state-empty a', m.box).length, 0);
  await m.unmount();

  const f = await mount(member('owner'), '?outcome=error');
  eq('空（有筛选）：链接是「清空筛选」', f.text(f.box.querySelector('.state-empty a')), '清空筛选');
  await f.click(f.box.querySelector('.state-empty a'));
  eq('点「清空筛选」：回到默认地址', f.url(), '/traces');
  await f.unmount();

  server = { rows: DATA, traces: { status: 503, body: { error: 'store_file_mode', detail: 'AI 记录只在 SESSION_STORE=db 时有' } } };
  requests = [];
  const file = await mount(member('owner'));
  eq(
    '文件存储下 503 store_file_mode：写「AI记录只在会话入库后才有」，不是红色出错，也没有表格',
    [
      file.text(file.box.querySelector('.state-empty-title')),
      file.$('.ant-alert-error', file.box).length,
      file.$('.tr-table', file.box).length,
    ],
    ['AI记录只在会话入库后才有', 0, 0],
  );
  eq(
    '文件存储下：只请求一次，不重试；没有可筛的东西，筛选行也不画',
    [listRequests().length, file.$('.tr-filters', file.box).length],
    [1, 0],
  );
  await file.unmount();

  server = { rows: DATA, traces: { status: 500, body: { error: 'internal', detail: '故意的' } } };
  requests = [];
  const bad = await mount(member('owner'));
  eq(
    '出错：就地写「没取到」，带重试',
    [bad.text(bad.box.querySelector('.ant-alert-title, .ant-alert-message')), bad.texts('.ant-alert button').map(squash).includes('重试')],
    ['没取到', true],
  );
  server = { rows: DATA };
  await bad.click(bad.$('.ant-alert button', bad.box).find((b) => squash(b.textContent ?? '') === '重试'));
  eq('点重试：取到之后换成表格', [bad.$('.ant-alert-error', bad.box).length, bad.table().length], [0, 4]);
  await bad.unmount();
}

// 2.5 翻页：游标原样传回，翻页出错只在底部说明
{
  server = { rows: DATA, pageSize: 2 };
  requests = [];
  const m = await mount(member('owner'), '?range=all');
  eq('第一页 2 行，有「加载更早的记录」', [m.table().length, m.text(m.box.querySelector('.tr-more'))], [2, '加载更早的记录']);
  await m.click(m.box.querySelector('.tr-more'));
  eq('点「加载更早的记录」：游标原样传回，新一页接在后面', [paramsOf(listRequests().at(-1)!).get('before'), m.table().length], ['2', 4]);
  await m.click(m.box.querySelector('.tr-more'));
  eq(
    '再点：到底，按钮换成一句话',
    [m.table().length, m.$('.tr-more', m.box).length, m.text(m.box.querySelector('.tr-end'))],
    [5, 0, '没有更早的记录了'],
  );
  eq('三页拼起来没有重复', new Set(m.table().map((r) => r[1])).size, 5);
  await m.unmount();

  server = { rows: DATA, pageSize: 2, failFrom: true };
  const e = await mount(member('owner'), '?range=all');
  await e.click(e.box.querySelector('.tr-more'));
  eq(
    '翻页失败：已列出的 2 行保留，底部就地说明并带重试，不整块换成出错',
    [e.table().length, e.$('.tr-list > .ant-alert-error', e.box).length, e.$('.tr-more', e.box).length],
    [2, 1, 1],
  );
  await e.unmount();
}

// 2.6 坐席、主管、只读与匿名：不发请求，写一句说明
{
  server = { rows: DATA };
  for (const role of ['supervisor', 'agent', 'viewer'] as const) {
    requests = [];
    const m = await mount(member(role));
    eq(
      `${role}：一个请求都不发，写「你的角色看不到AI记录」`,
      [requests.length, m.text(m.box.querySelector('.state-empty-title'))],
      [0, '你的角色看不到AI记录'],
    );
    await m.unmount();
  }
  requests = [];
  const anon = await mount({ kind: 'anon', pack: TRAVEL });
  eq(
    '匿名：一个请求都不发，写「登录后才能看AI记录」',
    [requests.length, anon.text(anon.box.querySelector('.state-empty-title'))],
    [0, '登录后才能看AI记录'],
  );
  await anon.unmount();
}

// 2.7 点一行：抽屉里是现有的「AI为什么这么回」
{
  server = { rows: DATA };
  requests = [];
  const m = await mount(member('owner'));
  const drawer = (): HTMLElement | null => document.querySelector<HTMLElement>('.tr-drawer .ant-drawer-content-wrapper');
  check('点之前抽屉没开', drawer() === null || !document.querySelector('.tr-drawer-body'));
  await m.click(m.$('.tr-when', m.box)[0]);
  const body = document.querySelector<HTMLElement>('.tr-drawer-body');
  check('点时间按钮：抽屉打开', body !== null);
  check(
    '请求的是现有的 trace 详情接口（会话 id、轮次 id 作路径参数）',
    requests.some((r) => r === 'GET /api/console/conversations/wecom:cust_F01/turns/tn-1'),
    requests.join(' | '),
  );
  const t = m.text(body);
  check('抽屉：会话标签、客户原话', t.includes('企微客户') && t.includes('客户说') && t.includes('你们太慢了，我要投诉'), t);
  check('抽屉：结果、阶段取行业包的名字', t.includes('结果：转人工') && t.includes('阶段：报价 → 报价'), t);
  check('抽屉：触发的护栏写中文名，不含 pass 的步骤', t.includes('触发的护栏：越权说法、身份说明') && !t.includes('清理模型输出'), t);
  check('抽屉：回复的篇幅与超长', t.includes('回复5行、120字，上限3行，裁掉1句，仍然超长'), t);
  check('抽屉：转人工原因', t.includes(`转人工原因：${HANDOFF_NOTICE_TEXT.complaint}`), t);
  check('抽屉：有「存为回归用例」按钮', m.texts('.tr-drawer-body button').includes('存为回归用例'));
  check('抽屉：步骤 id 只在折叠的技术详情里', !/claim_words|takeover_check/.test(t.replace(/技术详情[\s\S]*$/, '')), t);
  // 点一行的空白处也开（换第二行）
  await m.click(m.$('.tr-when', m.box)[1]);
  check(
    '点另一行：抽屉换成那一行（没有这一轮的详情时就地说明，不是白屏）',
    m.text(document.querySelector('.tr-drawer-body')).includes('企微客户'),
    m.text(document.querySelector('.tr-drawer-body')),
  );

  // 沉默的一轮：没有客户原话、没有护栏
  await m.click(m.$('.tr-when', m.box)[2]);
  const silent = m.text(document.querySelector('.tr-drawer-body'));
  check(
    '沉默的一轮：没有「客户说」，写没有经过护栏检查',
    !silent.includes('客户说') && silent.includes('这一轮没有经过护栏检查') && silent.includes('结果：没有回复'),
    silent,
  );

  // 回到第一行，存为回归用例
  await m.click(m.$('.tr-when', m.box)[0]);
  downloads.length = 0;
  server.draft = undefined;
  const save = m.$('.tr-drawer-body button').find((b) => b.textContent?.includes('存为回归用例'));
  await m.click(save);
  check(
    '点「存为回归用例」：请求 goal-draft 接口',
    requests.some((r) => r === 'GET /api/console/conversations/wecom:cust_F01/turns/tn-1/goal-draft'),
    requests.join(' | '),
  );
  eq(
    '下载：文件名取响应头里的，内容是服务端给的原文',
    [downloads.length, downloads[0]?.name, await downloads[0]?.text],
    [1, 'goal-draft-tn-1.json', '{"id":"draft-tn-1","predicates":[],"_draft":{}}\n'],
  );
  check(
    '下载之后的提示：先改写成合成的话',
    m.text(document.querySelector('.td-hint')).includes('已下载') && m.text(document.querySelector('.td-hint')).includes('合成的话'),
  );

  // 下载出错：就地说明，不弹 toast
  server.draft = { status: 403, body: JSON.stringify({ error: 'forbidden', detail: '只有 owner 和 admin 能做这件事' }) };
  downloads.length = 0;
  await m.click(m.$('.tr-drawer-body button').find((b) => b.textContent?.includes('存为回归用例')));
  check(
    '下载出错：就地说明，没有下载',
    downloads.length === 0 && m.$('.td-error').length === 1 && m.text(m.$('.td-error')[0]).includes('无法执行'),
    m.text(document.querySelector('.td-save')),
  );
  check('下载出错：页面上不露服务端的 detail', !m.text(document.body).includes('owner 和 admin'));
  await m.unmount();
}

Date.now = realNow;
if (fails.length) {
  console.error(`AI 记录自测：${fails.length} 条失败（${pass} 条通过）`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`AI 记录自测：${pass} 条全部通过`);
process.exit(0);
