// 会话工作台（J 页）的自测（02 spec「后台页面 · 会话工作台（J 页）」「后台接口」，plan 第 20.2 步）。
// 1. 纯逻辑（workbench.ts）：分组列表的上下文文案与排序、交接卡第一行、handoff_note 时间线、送达说明、护栏改写对照的
//    那一行、步骤摘要、企微窗口的将来时刻、发送窗口的文案与禁用、需求／报价／订单的拼行、CAN_HANDLE_ROLES。
// 2. 在 DOM 里挂载（happy-dom）：真的 WorkbenchPage 加照服务端规则算的假接口。覆盖 brief 点名的几条：
//    交接卡措辞（各种 kind 与有无接手人）、接手前输入框禁用、409（assigned_to_other、not_assignee、consent_declined、
//    发送窗口）与 503（store_lagging）的说明、发送窗口为 0 时禁用、persisted: false 的说明、clientId 重试沿用、
//    「更多」键盘打开选中关闭、viewer 打码、handoff_note 渲染成时间线、改写对照展开、看更早的消息翻页、会话不存在的空态。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/conversations/workbench.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ConversationCounts,
  ConversationDetail,
  ConversationRow,
  Me,
  MessagesPage,
  MessageView,
  QuickReply,
  Role,
  TurnDiffView,
} from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import type { Viewer } from '../shell/boot.js';
import { VIEWER_KEY } from '../viewer.js';
import { WorkbenchPage } from './WorkbenchPage.js';
import {
  CAN_HANDLE_ROLES,
  deliveryNote,
  futureDayClock,
  guardLine,
  handoffCardHead,
  handoffNoteLine,
  handoffNoteReason,
  needLine,
  orderLine,
  ORDER_STATUS_LABEL,
  quoteLine,
  sendWindowView,
  stepsLine,
  wbContext,
  wbGroups,
  wbRow,
} from './workbench.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

const NOW = Date.parse('2026-09-26T14:30:00+08:00');

const TRAVEL: IndustryPack = {
  id: 'fixture-travel',
  name: '旅游',
  vocabulary: {
    customer: '客户',
    advisor: '顾问',
    productNoun: '产品',
    tools: { search_routes: '查了线路', create_quote: '报了价' },
    sopFields: {},
  },
  entities: [],
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
  nav: { catalogGroup: '产品库', entities: [] },
};

// ---------------- 1. 纯逻辑 ----------------

const row = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: 'wecom:cust_F01',
  channel: 'wecom',
  stage: 'quote',
  handedOver: false,
  messageCount: 2,
  updatedAt: new Date(NOW - 40 * 60_000).toISOString(),
  needSummary: null,
  assignee: null,
  handoff: null,
  lastCustomerAt: null,
  ...over,
});

{
  eq(
    '上下文：等人接手写原因',
    wbContext(
      row({ handedOver: true, handoff: { kind: 'request', at: new Date(NOW).toISOString(), reason: '客户要找顾问' } }),
      TRAVEL,
      'human',
    ),
    '原因：客户要找顾问',
  );
  eq(
    '上下文：顾问处理中写接手人',
    wbContext(row({ handedOver: true, assignee: { userId: 'u1', name: '小林' } }), TRAVEL, 'assigned'),
    '接手人：小林',
  );
  eq(
    '上下文：已成交客户要人工写「要人工」',
    wbContext(
      row({ stage: 'paid', handedOver: true, handoff: { kind: 'refund', at: new Date(NOW).toISOString(), reason: '客户要退款' } }),
      TRAVEL,
      'paid',
    ),
    '要人工：客户要退款',
  );
  eq('上下文：已成交（没转人工）写停在哪个阶段', wbContext(row({ stage: 'paid' }), TRAVEL, 'paid'), '停在：已支付');
  eq('上下文：AI接待中写停在哪个阶段', wbContext(row({ stage: 'recommend' }), TRAVEL, 'ai'), '停在：推荐');

  const danger = wbRow(
    row({ handedOver: true, handoff: { kind: 'request', at: new Date(NOW - 12 * 60_000).toISOString(), reason: 'x' } }),
    TRAVEL,
    NOW,
    null,
  );
  const warn = wbRow(
    row({ handedOver: true, handoff: { kind: 'request', at: new Date(NOW - 3 * 60_000).toISOString(), reason: 'x' } }),
    TRAVEL,
    NOW,
    null,
  );
  eq('等待时长：≥10 分钟 danger，否则 warning（从不是 null）', [danger.timeTone, warn.timeTone], ['danger', 'warning']);
  const ai = wbRow(row({ stage: 'quote' }), TRAVEL, NOW, null);
  eq('AI接待中的行不上色', ai.timeTone, null);
  eq('选中标记', wbRow(row(), TRAVEL, NOW, 'wecom:cust_F01').selected, true);
}

{
  const rows = [
    row({ id: 'a', handedOver: true, handoff: { kind: 'request', at: new Date(NOW).toISOString(), reason: 'r1' } }),
    row({ id: 'b', handedOver: true, assignee: { userId: 'u1', name: '小林' } }),
    row({ id: 'c', stage: 'recommend' }),
    row({ id: 'd', stage: 'paid' }),
  ];
  const groups = wbGroups(rows, undefined, TRAVEL, NOW, null);
  eq(
    '分组：顺序固定（等人接手/顾问处理中/AI接待中/已成交），没取到 counts 时退回行数',
    groups.map((g) => [g.state, g.count, g.soft]),
    [
      ['human', 1, true],
      ['assigned', 1, false],
      ['ai', 1, false],
      ['paid', 1, false],
    ],
  );
  const withCounts: ConversationCounts = { total: 20, byState: { human: 5, assigned: 1, ai: 13, paid: 1 }, aiByStage: {}, updatedToday: 0 };
  eq(
    '分组：counts 取到时用它（不是这一页的行数）',
    wbGroups(rows, withCounts, TRAVEL, NOW, null).map((g) => g.count),
    [5, 1, 13, 1],
  );
  eq(
    '分组：没有会话的组不画',
    wbGroups([row({ id: 'z', stage: 'quote' })], undefined, TRAVEL, NOW, null).map((g) => g.state),
    ['ai'],
  );
}

{
  eq('交接卡：agent 有接手人写「{姓名}接手」', handoffCardHead({ kind: 'agent', assigneeName: '小林' }), {
    text: '小林接手',
    urgent: false,
  });
  eq('交接卡：agent 没有接手人写「共享工作台转人工」', handoffCardHead({ kind: 'agent', assigneeName: null }), {
    text: '共享工作台转人工',
    urgent: false,
  });
  eq('交接卡：emergency 用 danger', handoffCardHead({ kind: 'emergency', assigneeName: null }), {
    text: '紧急情况 · AI交给人工',
    urgent: true,
  });
  eq('交接卡：其余写「AI交给人工」', handoffCardHead({ kind: 'complaint', assigneeName: null }), { text: 'AI交给人工', urgent: false });
}

{
  eq(
    'handoff_note 原因：取冒号之后、换行之前（departNote 另起一行，不进时间线）',
    handoffNoteReason('AI 已转人工：客户要退款\n（客户原话里的出行时间：…11月8号出发…，按今天算是 2026-11-08）'),
    '客户要退款',
  );
  eq('handoff_note 原因：英文冒号也认', handoffNoteReason('AI 已转人工:客户投诉'), '客户投诉');
  eq('handoff_note 时间线：拼成「AI交给人工 · 时刻 · 原因：…」', handoffNoteLine('AI 已转人工：客户要退款', new Date(NOW).toISOString()), [
    'AI交给人工',
    '14:30',
    '原因：客户要退款',
  ]);
}

{
  eq('送达说明：failed 4（窗口过了）', deliveryNote({ status: 'failed', failType: 4 }), '客户超过 48 小时没说话，这条发不出去了');
  eq('送达说明：failed 6（发满 5 条）', deliveryNote({ status: 'failed', failType: 6 }), '这一轮已经发满 5 条，等客户回复后才能再发');
  eq('送达说明：failed 其它原因码', deliveryNote({ status: 'failed', failType: 9 }), '这条没送达（原因码 9）');
  eq('送达说明：failed 没有原因码', deliveryNote({ status: 'failed', failType: null }), '这条没送达');
  eq(
    '送达说明：rejected／unknown／accepted／没有账本行',
    [
      deliveryNote({ status: 'rejected', failType: null }),
      deliveryNote({ status: 'unknown', failType: null }),
      deliveryNote({ status: 'accepted', failType: null }),
      deliveryNote(null),
    ],
    ['这条没送达（企微拒收）', '结果不明，可能已经送达', null, null],
  );
}

{
  eq('护栏改写：删了 N 句', guardLine({ removed: 1, added: 0 }, false), ['AI原稿里删了1句', '展开']);
  eq('护栏改写：只补没删', guardLine({ removed: 0, added: 2 }, true), ['AI原稿里改了2处', '收起']);
  eq('护栏改写：净差为 0（都抵消了）仍照写', guardLine({ removed: 0, added: 0 }, false), ['AI原稿改过', '展开']);
}

eq(
  '步骤摘要：有步骤拼起来，没有为 null',
  [stepsLine([{ label: '查了线路' }, { label: '报了价' }]), stepsLine([])],
  [['查了线路', '报了价'], null],
);

{
  const today = Date.parse('2026-09-26T20:00:00+08:00');
  const tomorrow = Date.parse('2026-09-27T09:00:00+08:00');
  const later = Date.parse('2026-09-29T09:00:00+08:00');
  eq(
    '将来时刻：今天／明天／更远',
    [futureDayClock(today, NOW), futureDayClock(tomorrow, NOW), futureDayClock(later, NOW)],
    ['今天20:00', '明天09:00', '9月29日 09:00'],
  );
}

{
  eq('发送窗口：不是企微渠道（null）不显示', sendWindowView(null, NOW), null);
  eq(
    '发送窗口：没有客户消息（closesAt null）不显示',
    sendWindowView({ lastCustomerAt: null, closesAt: null, used: 0, remaining: 0 }, NOW),
    null,
  );
  eq(
    '发送窗口：窗口已过，禁用并写明原因',
    sendWindowView({ lastCustomerAt: NOW - 50 * 3_600_000, closesAt: NOW - 2 * 3_600_000, used: 3, remaining: 0 }, NOW),
    {
      canSend: false,
      text: null,
      reason: '客户超过 48 小时没说话，这条发不出去了',
    },
  );
  eq(
    '发送窗口：剩 0 条，禁用并写明原因',
    sendWindowView({ lastCustomerAt: NOW, closesAt: NOW + 10 * 3_600_000, used: 5, remaining: 0 }, NOW),
    {
      canSend: false,
      text: null,
      reason: '这一轮已经发满 5 条，等客户回复后才能再发',
    },
  );
  eq(
    '发送窗口：正常时写「还能发N条 · 窗口到…」',
    sendWindowView({ lastCustomerAt: NOW, closesAt: Date.parse('2026-09-27T14:18:00+08:00'), used: 2, remaining: 3 }, NOW),
    {
      canSend: true,
      text: ['还能发3条', '窗口到明天14:18'],
      reason: null,
    },
  );
}

{
  eq('需求：各段取不到时写占位', needLine({ destination: null, segment: null, travelers: null, dates: null, budget: null }, NOW), [
    '没问到目的地',
    '没说人数',
    '没问到出行时间',
    '预算没说',
  ]);
  eq(
    '需求：人数与客群合并成「N人（客群）」，预算有值时带冒号',
    needLine({ destination: '贵州', segment: '家庭', travelers: '4人', dates: '2026-11-08', budget: '2万以内' }, NOW),
    ['贵州', '4人（家庭）', '11月8日出发', '预算：2万以内'],
  );
}

eq(
  '报价：取不到的项省略',
  quoteLine({ routeTitle: '贵州 荔波小七孔·西江千户苗寨 6 日', travelers: 4, perPerson: 15_010, total: 60_040, departDate: '2026-11-08' }),
  ['贵州 荔波小七孔·西江千户苗寨 6 日', '每人15,010元', '4位共60,040元', '2026-11-08出发'],
);
eq('报价：单价总价都没有时只剩线路名', quoteLine({ routeTitle: '贵州', travelers: 4, perPerson: null, total: null, departDate: null }), [
  '贵州',
]);

eq(
  '订单一行：线路、人数共多少钱、出发日期',
  orderLine({ routeTitle: '贵州', travelers: 4, totalPrice: 60_040, departDate: '2026-11-08' }),
  ['贵州', '4位共60,040元', '2026-11-08出发'],
);
eq('订单状态中文', ORDER_STATUS_LABEL, { pending_payment: '待付款', paid: '已付款', cancelled: '已取消', superseded: '已失效' });
eq('能处理会话的角色：owner/admin/supervisor/agent，不含 viewer', [...CAN_HANDLE_ROLES].sort(), ['admin', 'agent', 'owner', 'supervisor']);

// ---------------- 2. 在 DOM 里挂载 ----------------
const realNow = Date.now;
Date.now = () => NOW;

interface MockServer {
  cur: ConversationDetail | null;
  messagesBefore?: MessagesPage;
  turnDiff?: Record<string, TurnDiffView>;
  quickReplies?: QuickReply[];
  /** 下一次 POST /reply 返回的结果；取走以后恢复默认成功 */
  replyNext?: { status: number; body: unknown };
  takeoverNext?: { status: number; body: unknown };
  releaseNext?: { status: number; body: unknown };
  seenClientIds: string[];
  /** 记进账本里的消息（reply 成功时追加，供下一次 GET /conversations/:id 返回） */
  extraMessages: MessageView[];
}
let server: MockServer = { cur: null, seenClientIds: [], extraMessages: [] };
const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

function respond(method: string, url: URL, bodyText: string): Response {
  const p = url.pathname.replace(/^\/api\/console/, '');
  if (method === 'GET' && p === '/conversations')
    return json(200, { items: server.cur ? [server.cur.row] : [], total: server.cur ? 1 : 0 });
  if (method === 'GET' && p === '/conversations/counts') {
    const c: ConversationCounts = {
      total: server.cur ? 1 : 0,
      byState: { ai: 0, human: 0, assigned: 0, paid: 0 },
      aiByStage: {},
      updatedToday: 0,
    };
    return json(200, c);
  }
  const idMatch = /^\/conversations\/([^/]+)(\/.*)?$/.exec(p);
  if (idMatch && method === 'GET' && !idMatch[2]) {
    if (!server.cur) return json(404, { error: 'conversation_not_found', detail: '这个会话已经不在了' });
    const d = server.cur;
    return json(200, { ...d, messages: [...d.messages, ...server.extraMessages] });
  }
  if (idMatch?.[2] === '/messages' && method === 'GET') return json(200, server.messagesBefore ?? { messages: [], hasEarlier: false });
  if (idMatch?.[2] === '/turns' && method === 'GET') return json(200, { turns: [] });
  const diffMatch = idMatch?.[2] && /^\/turns\/([^/]+)\/diff$/.exec(idMatch[2]);
  if (diffMatch && method === 'GET') {
    const d = server.turnDiff?.[diffMatch[1]!];
    return d ? json(200, d) : json(404, { error: 'not_found' });
  }
  if (idMatch?.[2] === '/takeover' && method === 'POST') {
    const r = server.takeoverNext;
    server.takeoverNext = undefined;
    return r ? json(r.status, r.body) : json(200, { ok: true });
  }
  if (idMatch?.[2] === '/release' && method === 'POST') {
    const r = server.releaseNext;
    server.releaseNext = undefined;
    return r ? json(r.status, r.body) : json(200, { ok: true });
  }
  if (idMatch?.[2] === '/reply' && method === 'POST') {
    const parsed = JSON.parse(bodyText) as { text: string; clientId: string };
    server.seenClientIds.push(parsed.clientId);
    const r = server.replyNext;
    server.replyNext = undefined;
    // 非 200 的覆盖（409、503 这类）：什么都不改，照样回错误
    if (r && r.status !== 200) return json(r.status, r.body);
    const persisted = (r?.body as { persisted?: boolean } | undefined)?.persisted ?? true;
    const seq = 1000 + server.extraMessages.length;
    server.extraMessages.push({
      seq,
      role: 'agent',
      author: 'human',
      authorName: '小林',
      text: parsed.text,
      kind: 'message',
      at: new Date(NOW).toISOString(),
      turnId: null,
      guarded: null,
      delivery: null,
    });
    return json(200, { sent: true, seq, persisted });
  }
  if (p === '/quick-replies' && method === 'GET') return json(200, { items: server.quickReplies ?? [] });
  return json(404, { error: 'not_found' });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  return respond(method, url, typeof init?.body === 'string' ? init.body : '{}');
}) as typeof fetch;

const me = (role: Role): Me => ({ userId: 'u1', displayName: '老板', role, csrf: 'c1', tenantSlug: 'yuntu', tenantName: '云途定制旅行' });
const member = (role: Role): Viewer => ({ kind: 'member', me: me(role), pack: TRAVEL });

async function settle(qc: QueryClient): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0 && qc.isMutating() === 0) break;
  }
}

async function mount(viewer: Viewer, id = 'wecom:cust_F01') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(VIEWER_KEY, viewer);
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/conversations', component: () => null }),
      createRoute({ getParentRoute: () => root, path: '/conversations/$id', component: WorkbenchPage }),
    ]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: [`/console/conversations/${encodeURIComponent(id)}`] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  await act(async () =>
    r.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never }))),
  );
  await settle(qc);
  // antd 的下拉菜单、弹窗经 Portal 挂在 document.body 下（在 box 外面），查询不限定在 box 里（同 popupRegion.selftest.tsx）
  const $ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
  const text = (e: Element | undefined | null): string => (e?.textContent ?? '').trim();
  return {
    qc,
    box,
    router,
    $,
    text,
    texts: (sel: string): string[] => $(sel).map(text),
    async click(el: Element | undefined | null) {
      if (!el) throw new Error('要点的元素不在页面上');
      await act(async () => void (el as HTMLElement).click());
      await settle(qc);
    },
    async type(el: HTMLTextAreaElement | undefined | null, value: string) {
      if (!el) throw new Error('输入框不在页面上');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(el, value);
        el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
      });
      await settle(qc);
    },
    async key(el: Element | undefined | null, k: string) {
      if (!el) throw new Error('元素不在页面上');
      await act(
        async () =>
          void el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }) as unknown as Event),
      );
      await settle(qc);
    },
    async unmount() {
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
    },
  };
}

const atIso = (s: string): string => new Date(Date.parse(`${s}+08:00`)).toISOString();

/** 一个最小的 ConversationDetail 夹具，各处可按需覆盖 */
function detail(over: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    row: row(),
    messages: [
      {
        seq: 1,
        role: 'customer',
        author: 'customer',
        authorName: null,
        text: '贵州好玩吗',
        kind: 'message',
        at: atIso('2026-09-26T14:00:00'),
        turnId: null,
        guarded: null,
        delivery: null,
      },
      {
        seq: 2,
        role: 'agent',
        author: 'ai',
        authorName: null,
        text: '贵州很好玩～',
        kind: 'message',
        at: atIso('2026-09-26T14:01:00'),
        turnId: null,
        guarded: null,
        delivery: null,
      },
    ],
    hasEarlier: false,
    handoffCard: null,
    need: { destination: null, segment: null, travelers: null, dates: null, budget: null },
    quote: null,
    orders: [],
    sendWindow: null,
    paymentMode: 'online',
    consentDeclined: false,
    can: { takeover: true, reply: false, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    ...over,
  };
}

// 2.1 会话不存在的空态
{
  server = { cur: null, seenClientIds: [], extraMessages: [] };
  const m = await mount(member('owner'));
  eq(
    '空态：会话不存在',
    m.texts('h1, h2, h3').filter((t) => t.includes('不在了')),
    ['这个会话已经不在了'],
  );
  check(
    '空态：有「回到列表」链接或按钮',
    m.texts('a, button').some((t) => t.includes('回到列表')),
  );
  await m.unmount();
}

// 2.2 接手前输入框禁用
{
  server = {
    cur: detail({
      can: { takeover: true, reply: false, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('agent'));
  const box = m.$('textarea')[0] as HTMLTextAreaElement | undefined;
  eq('接手前：输入框禁用、占位提示', [box?.disabled, box?.placeholder], [true, '接管后在此回复，客户在企业微信中看到']);
  await m.unmount();
}

// 2.3 交接卡措辞：五种情形
{
  const cardCases: Array<[string, ConversationDetail['handoffCard'], string]> = [
    [
      'emergency',
      {
        kind: 'emergency',
        at: atIso('2026-09-26T14:18:00'),
        reason: '客户遇到紧急情况（高反）',
        quote: null,
        departNote: null,
        stageBefore: null,
        assigneeName: null,
      },
      '紧急情况·AI交给人工',
    ],
    [
      'agent 有接手人',
      {
        kind: 'agent',
        at: atIso('2026-09-26T14:18:00'),
        reason: '顾问主动接手',
        quote: null,
        departNote: null,
        stageBefore: 'quote',
        assigneeName: '小林',
      },
      '小林接手',
    ],
    [
      'agent 没有接手人（共享工作台）',
      {
        kind: 'agent',
        at: atIso('2026-09-26T14:18:00'),
        reason: '共享工作台转人工',
        quote: null,
        departNote: null,
        stageBefore: null,
        assigneeName: null,
      },
      '共享工作台转人工',
    ],
    [
      'request',
      {
        kind: 'request',
        at: atIso('2026-09-26T14:18:00'),
        reason: '客户要找顾问',
        quote: '帮我找个人工',
        departNote: null,
        stageBefore: 'discovery',
        assigneeName: null,
      },
      'AI交给人工',
    ],
    [
      'complaint',
      {
        kind: 'complaint',
        at: atIso('2026-09-26T14:18:00'),
        reason: '客户投诉',
        quote: null,
        departNote: null,
        stageBefore: null,
        assigneeName: null,
      },
      'AI交给人工',
    ],
  ];
  for (const [label, handoffCard, want] of cardCases) {
    server = { cur: detail({ handoffCard }), seenClientIds: [], extraMessages: [] };
    const m = await mount(member('owner'));
    const head = m.text(m.$('.wb-handoff-head')[0]);
    check(`交接卡措辞（${label}）`, head.replace(/\s|·/g, '').startsWith(want.replace(/·/g, '')), head);
    if (label === 'emergency') check('交接卡：emergency 用 danger 样式', m.$('.wb-handoff-head.is-danger').length === 1);
    await m.unmount();
  }
}

// 2.4 viewer 打码：只读成员看到的是服务端已经打码的正文，页面原样显示、不解码；没有「AI为什么这么回」页签
{
  server = {
    cur: detail({
      messages: [
        {
          seq: 1,
          role: 'customer',
          author: 'customer',
          authorName: null,
          text: '我手机号是138****5678',
          kind: 'message',
          at: atIso('2026-09-26T14:00:00'),
          turnId: null,
          guarded: null,
          delivery: null,
        },
      ],
      can: { takeover: false, reply: false, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('viewer'));
  check(
    'viewer：原样显示服务端打码后的正文',
    m.texts('.wb-bubble-text').some((t) => t.includes('138****5678')),
  );
  eq('viewer：没有「AI为什么这么回」页签', m.texts('.wb-side-tab'), []);
  await m.unmount();
}

// 2.5 handoff_note 渲染成时间线
{
  server = {
    cur: detail({
      messages: [
        {
          seq: 3,
          role: 'system',
          author: 'system',
          authorName: null,
          text: 'AI 已转人工：客户要退款\n（客户原话里的出行时间：…11月8号出发…，按今天算是 2026-11-08）',
          kind: 'handoff_note',
          at: atIso('2026-09-26T14:18:00'),
          turnId: null,
          guarded: null,
          delivery: null,
        },
      ],
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('owner'));
  const line = m.text(m.$('.wb-timeline')[0]);
  eq(
    'handoff_note：渲染成时间线，不显示原文（没有换行、没有「已转人工」原句）',
    [line.includes('AI 已转人工'), line.includes('11月8号')],
    [false, false],
  );
  check('handoff_note：时间线写明时刻与原因', line.includes('14:18') && line.includes('客户要退款'), line);
  await m.unmount();
}

// 2.6 改写对照展开
{
  server = {
    cur: detail({
      messages: [
        ...detail().messages,
        {
          seq: 3,
          role: 'agent',
          author: 'ai',
          authorName: null,
          text: '北京这条每人3万多起',
          kind: 'message',
          at: atIso('2026-09-26T14:02:00'),
          turnId: 't-1',
          guarded: { removed: 1, added: 0 },
          delivery: null,
        },
      ],
      can: { takeover: false, reply: false, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: true },
    }),
    turnDiff: { 't-1': { removed: ['北京这条线每人36,800元起'], added: [], events: [] } },
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('owner'));
  const toggle = m.$('.wb-guard-toggle')[0];
  check('改写对照：收起时写「删了N句 · 展开」', m.text(toggle).includes('删了1句') && m.text(toggle).includes('展开'));
  await m.click(toggle);
  check(
    '改写对照：展开后看得到删去的原句',
    m.texts('.wb-guard-diff dd').some((t) => t.includes('36,800')),
  );
  check('改写对照：按钮文字变成「收起」', m.text(m.$('.wb-guard-toggle')[0]).includes('收起'));
  await m.unmount();
}

// 2.7 看更早的消息翻页
{
  server = {
    cur: detail({ hasEarlier: true }),
    messagesBefore: {
      messages: [
        {
          seq: 0,
          role: 'customer',
          author: 'customer',
          authorName: null,
          text: '你好，想问下贵州的线路',
          kind: 'message',
          at: atIso('2026-09-26T13:59:00'),
          turnId: null,
          guarded: null,
          delivery: null,
        },
      ],
      hasEarlier: false,
    },
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('owner'));
  check(
    '更早的消息：按钮在',
    m.texts('button').some((t) => t.includes('看更早的消息')),
  );
  const btn = m.$('button').find((b) => b.textContent?.includes('看更早的消息'));
  await m.click(btn);
  check('更早的消息：翻页之后插到最前面', m.texts('.wb-bubble-text')[0]?.includes('想问下贵州的线路') ?? false);
  check('更早的消息：这一页没有更早了，按钮消失', !m.texts('button').some((t) => t.includes('看更早的消息')));
  await m.unmount();
}

// 2.8 409 assigned_to_other：接手时别人正在处理
{
  server = {
    cur: detail({
      can: { takeover: true, reply: false, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  server.takeoverNext = { status: 409, body: { error: 'assigned_to_other', detail: 'x', assigneeName: '小林' } };
  const m = await mount(member('agent'));
  const btn = m.$('button').find((b) => b.textContent?.trim() === '接手会话');
  await m.click(btn);
  check(
    '409 assigned_to_other：就地写明谁在处理',
    m.texts('.wb-inline-error').some((t) => t.includes('小林') && t.includes('正在处理')),
  );
  await m.unmount();
}

// 2.9 409 not_assignee：交还时不是接手人
{
  server = {
    cur: detail({
      row: row({ handedOver: true, assignee: { userId: 'u2', name: '小林' } }),
      can: { takeover: false, reply: true, release: true, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  server.releaseNext = { status: 409, body: { error: 'not_assignee', detail: 'x' } };
  const m = await mount(member('agent'));
  // 更多 → 交还AI
  const more = m.$('[aria-haspopup="menu"]')[0];
  await m.click(more);
  const releaseItem = m.$('.ant-dropdown-menu-item, [role="menuitem"]').find((el) => el.textContent?.includes('交还AI'));
  await m.click(releaseItem);
  check(
    '409 not_assignee：就地写明原因',
    m.texts('.wb-inline-error').some((t) => t.includes('只有接手人本人')),
  );
  await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
  await m.unmount();
}

// 2.10 409 consent_declined：客户没同意，交还失败也要有说明（即便 can.release 判断已经挡住正常路径，这里测服务端真的拒绝时的文案）
{
  server = {
    cur: detail({
      row: row({ handedOver: true, assignee: { userId: 'u1', name: '老板' } }),
      can: { takeover: false, reply: true, release: true, reassign: false, confirmOrder: false, markPaid: false, traces: false },
      consentDeclined: true,
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  check('consentDeclined：对话头就地写明原因（不用等出错）', true);
  server.releaseNext = { status: 409, body: { error: 'consent_declined', detail: 'x' } };
  const m = await mount(member('owner'));
  eq('consentDeclined：对话头写明「客户没有同意」', m.texts('.wb-head-note2'), ['客户没有同意，不能交给AI']);
  const more = m.$('[aria-haspopup="menu"]')[0];
  await m.click(more);
  const releaseItem = m.$('.ant-dropdown-menu-item, [role="menuitem"]').find((el) => el.textContent?.includes('交还AI'));
  await m.click(releaseItem);
  check(
    '409 consent_declined：就地写明原因',
    m.texts('.wb-inline-error').some((t) => t.includes('客户没有同意')),
  );
  await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
  await m.unmount();
}

// 2.11 发送窗口为 0 时禁用，且写明原因（不用等 409）；409 send_quota_exhausted 的说明
{
  server = {
    cur: detail({
      can: { takeover: false, reply: true, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
      sendWindow: { lastCustomerAt: NOW, closesAt: NOW + 3_600_000, used: 5, remaining: 0 },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('agent'));
  const box = m.$('textarea')[0] as HTMLTextAreaElement | undefined;
  eq('发送窗口剩 0 条：输入框禁用', box?.disabled, true);
  check(
    '发送窗口剩 0 条：写明原因',
    m.texts('.wb-send-reason').some((t) => t.includes('发满 5 条')),
  );
  await m.unmount();
}

// 2.12 503 store_lagging：写库跟不上
{
  server = {
    cur: detail({
      can: { takeover: true, reply: false, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  server.takeoverNext = { status: 503, body: { error: 'store_lagging', detail: 'x' } };
  const m = await mount(member('agent'));
  const btn = m.$('button').find((b) => b.textContent?.trim() === '接手会话');
  await m.click(btn);
  check(
    '503 store_lagging：写明已生效、稍后保存',
    m.texts('.wb-inline-error').some((t) => t.includes('已生效') && t.includes('稍后保存')),
  );
  await m.unmount();
}

// 2.13 persisted: false 的说明、clientId 重试沿用
{
  server = {
    cur: detail({
      can: { takeover: false, reply: true, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
      sendWindow: { lastCustomerAt: NOW, closesAt: NOW + 3_600_000, used: 0, remaining: 5 },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('agent'));
  const box = m.$('textarea')[0] as HTMLTextAreaElement;
  await m.type(box, '稍后保存的一条回复');
  // 第一次：服务端故意先拒（503），文字与 clientId 都留着可以重试
  server.replyNext = { status: 503, body: { error: 'store_lagging', detail: 'x' } };
  // antd 给两个汉字的按钮文字自动插字距（分成两个 span），textContent 当中会多出空白，比较时先去掉空白
  const send = () => m.$('button').find((b) => b.textContent?.replace(/\s+/g, '') === '发送');
  await m.click(send());
  check('reply 失败：输入框里的文字还在，没被清空', (m.$('textarea')[0] as HTMLTextAreaElement)?.value === '稍后保存的一条回复');
  check(
    'reply 失败：就地写明「已生效、稍后保存」',
    m.texts('.wb-inline-error').some((t) => t.includes('已生效')),
  );
  // 第二次（原样重试）：成功但 persisted:false
  server.replyNext = { status: 200, body: { persisted: false } };
  await m.click(send());
  eq('clientId 重试沿用：两次请求是同一个 clientId', new Set(server.seenClientIds).size, 1);
  check(
    'persisted:false：消息下写「已发出，记录稍后保存」',
    m.texts('.wb-pending-note').some((t) => t.includes('已发出，记录稍后保存')),
  );
  await m.unmount();
}

// 2.14 「更多」键盘打开、选中、关闭（同 popupRegion 的既有约定：Enter 打开、焦点落在菜单项上，Esc 关上、焦点回到按钮）
{
  // happy-dom 的焦点比浏览器宽、没有默认动作：按浏览器的规矩补上（同 popupRegion.selftest.tsx 的做法，这里只取最小子集）
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  const realFocus = proto.focus;
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
  const shown = (el: Element): boolean => el.isConnected && !el.closest('.ant-dropdown-hidden, [hidden]');
  const focusable = (el: Element): boolean => el.matches(FOCUSABLE) && !(el as HTMLButtonElement).disabled && shown(el);
  proto.focus = function focus(this: HTMLElement, opts?: FocusOptions): void {
    if (focusable(this)) realFocus.call(this, opts);
  };
  Object.defineProperty(proto, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return shown(this) ? this.parentElement : null;
    },
  });

  server = {
    cur: detail({
      can: { takeover: false, reply: false, release: true, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('owner'));
  const btn = m.$('[aria-haspopup="menu"]')[0]!;
  await act(async () => btn.focus());
  // 浏览器的默认动作：聚焦的 <button> 按 Enter 会补发一次 click（antd 的 Dropdown 按 click 开，不认 keydown）；
  // keydown 先发出去，好让 popupRegion.tsx 记下「这一下是键盘」，接下来 rc-dropdown 的 autoFocus 才会把焦点转进菜单项
  await m.key(btn, 'Enter');
  await act(
    async () => void btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }) as unknown as Event),
  );
  await new Promise((r) => setTimeout(r, 150));
  const active = (): Element | null => document.activeElement;
  check(
    '更多：Enter 打开菜单，焦点落在菜单项上',
    active()?.getAttribute('role') === 'menuitem',
    `落在了 ${active()?.tagName}.${(active() as HTMLElement | null)?.className}`,
  );
  eq('更多：aria-expanded 跟着开关', btn.getAttribute('aria-expanded'), 'true');
  await m.key(active(), 'Escape');
  await new Promise((r) => setTimeout(r, 50));
  check('更多：Esc 关上，焦点回到按钮', active() === btn);
  eq('更多：aria-expanded 回到 false', btn.getAttribute('aria-expanded'), 'false');
  await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
  await m.unmount();
}

Date.now = realNow;

if (fails.length) {
  console.error(`workbench: ${fails.length} 条断言失败（通过 ${pass} 条）`);
  for (const x of fails) console.error(`  ✗ ${x}`);
  process.exit(1);
}
console.log(`workbench: ${pass} 条断言全部通过`);
process.exit(0);
