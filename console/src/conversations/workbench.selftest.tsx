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
import fs from 'node:fs';
import { win } from '../fields/selftest-dom.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { hasMarkdown, QUICK_REPLY_MARKDOWN_MSG } from '../../../src/shared/console-api.js';
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
  amount: null,
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
  /** 下一个快捷回复的 id 序号（POST /quick-replies 用），默认从 1 开始 */
  qrSeq?: number;
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
  if (p === '/quick-replies' && method === 'POST') {
    const b = JSON.parse(bodyText) as { title: string; body: string };
    if (hasMarkdown(b.body)) return json(400, { error: 'bad_request', issues: [{ path: 'body', message: QUICK_REPLY_MARKDOWN_MSG }] });
    const list = server.quickReplies ?? [];
    const seq = server.qrSeq ?? 1;
    server.qrSeq = seq + 1;
    const row: QuickReply = { id: `qr${seq}`, ord: list.length, title: b.title, body: b.body };
    server.quickReplies = [...list, row];
    return json(200, row);
  }
  const qrMatch = /^\/quick-replies\/([^/]+)(\/.*)?$/.exec(p);
  if (qrMatch && method === 'PATCH') {
    const list = server.quickReplies ?? [];
    const cur = list.find((r) => r.id === qrMatch[1]);
    if (!cur) return json(404, { error: 'not_found' });
    const patch = JSON.parse(bodyText) as { title?: string; body?: string };
    if (patch.body !== undefined && hasMarkdown(patch.body))
      return json(400, { error: 'bad_request', issues: [{ path: 'body', message: QUICK_REPLY_MARKDOWN_MSG }] });
    const next = { ...cur, ...patch };
    server.quickReplies = list.map((r) => (r.id === cur.id ? next : r));
    return json(200, next);
  }
  if (qrMatch?.[2] === '/archive' && method === 'POST') {
    const list = server.quickReplies ?? [];
    if (!list.some((r) => r.id === qrMatch[1])) return json(404, { error: 'not_found' });
    server.quickReplies = list.filter((r) => r.id !== qrMatch[1]);
    return json(200, { ok: true });
  }
  if (qrMatch?.[2] === '/move' && method === 'POST') {
    const list = [...(server.quickReplies ?? [])];
    const i = list.findIndex((r) => r.id === qrMatch[1]);
    if (i < 0) return json(404, { error: 'not_found' });
    const { direction } = JSON.parse(bodyText) as { direction: 'up' | 'down' };
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return json(200, { ok: true, moved: false });
    [list[i], list[j]] = [list[j]!, list[i]!];
    server.quickReplies = list.map((r, idx) => ({ ...r, ord: idx }));
    return json(200, { ok: true, moved: true });
  }
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

// 2.2 输入框只在「接手人是我」时可用（审查 major 第 1 条：服务端 can.reply = handles && (!cur || mine)，
// 没人接手时也是 true——这是 reply() 允许隐式接手的真实行为，界面不能直接拿它当「是否已经点过接手会话」。
// 四种服务端真会给出的形状都断言一次：等人接手没人认领、AI 接待中、别人接手、我接手）
{
  const cases: Array<[string, Partial<ConversationRow>, ConversationDetail['can'], boolean]> = [
    [
      '等人接手、没人认领',
      { handedOver: true, assignee: null, handoff: { kind: 'request', at: atIso('2026-09-26T14:00:00'), reason: '客户要找顾问' } },
      { takeover: true, reply: true, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
      false,
    ],
    [
      'AI 接待中',
      { handedOver: false, assignee: null },
      { takeover: true, reply: true, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
      false,
    ],
    [
      '别人接手（小林，不是我）',
      { handedOver: true, assignee: { userId: 'u2', name: '小林' } },
      { takeover: false, reply: false, release: false, reassign: true, confirmOrder: false, markPaid: false, traces: false },
      false,
    ],
    [
      '我接手（userId 与登录成员一致）',
      { handedOver: true, assignee: { userId: 'u1', name: '老板' } },
      { takeover: false, reply: true, release: true, reassign: false, confirmOrder: true, markPaid: true, traces: false },
      true,
    ],
  ];
  for (const [label, rowOver, can, shouldEnable] of cases) {
    server = { cur: detail({ row: row(rowOver), can }), seenClientIds: [], extraMessages: [] };
    const m = await mount(member('owner')); // userId 'u1'，同「我接手」那一条的 assignee.userId
    const box = m.$('textarea')[0] as HTMLTextAreaElement | undefined;
    if (shouldEnable) {
      // 可用时 placeholder 没传，DOM 的 .placeholder 属性（不是 attribute）取不到值时固定是空字符串，不是 undefined
      eq(`输入框可用（${label}）`, [box?.disabled, box?.placeholder], [false, '']);
    } else {
      eq(`输入框禁用、占位提示（${label}）`, [box?.disabled, box?.placeholder], [true, '接管后在此回复，客户在企业微信中看到']);
    }
    await m.unmount();
  }
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
  // 先确认时间线那一行真的画出来了（不是取到空字符串才侥幸不含那两句）
  eq('handoff_note：恰好画出一行时间线', m.$('.wb-timeline').length, 1);
  const line = m.text(m.$('.wb-timeline')[0]);
  eq(
    'handoff_note：渲染成时间线，不显示原文（没有换行、没有「已转人工」原句）',
    [line.includes('AI 已转人工'), line.includes('11月8号')],
    [false, false],
  );
  check('handoff_note：时间线写明时刻与原因', line.includes('14:18') && line.includes('客户要退款'), line);
  // 全文也不该在别处原样出现（比如被当成普通 system 消息画出来）
  check('handoff_note：原文不在页面任何地方出现', !m.box.textContent?.includes('客户原话里的出行时间'));
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
// 接手人是我（userId 'u1'，同 member() 给的登录成员）：canReply 才会是 true，disabled 完全由发送窗口决定，
// 这条断言才真的测到「窗口剩 0 条」这件事，不是被「还没接手」盖过去
{
  server = {
    cur: detail({
      row: row({ handedOver: true, assignee: { userId: 'u1', name: '老板' } }),
      can: { takeover: false, reply: true, release: true, reassign: false, confirmOrder: true, markPaid: false, traces: false },
      sendWindow: { lastCustomerAt: NOW, closesAt: NOW + 3_600_000, used: 5, remaining: 0 },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('owner'));
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

// 2.13 persisted: false 的说明、clientId 重试沿用（接手人是我，canReply 才会是 true）
{
  server = {
    cur: detail({
      row: row({ handedOver: true, assignee: { userId: 'u1', name: '老板' } }),
      can: { takeover: false, reply: true, release: true, reassign: false, confirmOrder: true, markPaid: false, traces: false },
      sendWindow: { lastCustomerAt: NOW, closesAt: NOW + 3_600_000, used: 0, remaining: 5 },
    }),
    seenClientIds: [],
    extraMessages: [],
  };
  const m = await mount(member('owner'));
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

// 2.15 快捷回复管理抽屉（02 spec「快捷回复管理」，plan 第 22 步）：只读角色没有「管理」入口；新建、编辑、上移下移、
// 归档（ConfirmDanger）、正文带 markdown 前端就拦住（不提交）；归档之后插入列表（卡片）里也没有了；
// Esc 关闭、焦点回到「管理」按钮
{
  const typeInput = async (el: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string, qc: QueryClient) => {
    if (!el) throw new Error('输入框不在页面上');
    await act(async () => {
      const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    });
    await settle(qc);
  };
  server = {
    cur: detail({
      can: { takeover: false, reply: false, release: false, reassign: false, confirmOrder: false, markPaid: false, traces: false },
    }),
    quickReplies: [
      { id: 'a', ord: 0, title: '问日期', body: '您大概什么时候出发呢？' },
      { id: 'b', ord: 1, title: '问人数', body: '这次几位出行？' },
    ],
    seenClientIds: [],
    extraMessages: [],
  };
  // 只读角色（canManage=false）：没有「管理」入口，但插入列表（点一条插进输入框）照常
  const viewerM = await mount(member('viewer'));
  check('快捷回复：viewer 没有「管理」按钮', !viewerM.texts('button').some((t) => t === '管理'));
  check('快捷回复：viewer 照样能看到插入列表', viewerM.texts('.wb-quick-btn').sort().join(',') === ['问人数', '问日期'].sort().join(','));
  await viewerM.unmount();

  // antd 的 Button：实心/描边变体里纯两个汉字的文字会被自动插进一个可见空格（isTwoCNChar，「新建」会显示成「新 建」），
  // text/link 变体不会。按钮文字都按去掉全部空白之后比较，不只 trim()（同已有的「发送」按钮那个找法）
  const btnByText = (text: string): HTMLElement | undefined => m.$('button').find((b) => b.textContent?.replace(/\s+/g, '') === text);
  const m = await mount(member('owner'));
  const manageBtn = btnByText('管理')!;
  check('快捷回复：owner 有「管理」按钮', !!manageBtn);
  await m.click(manageBtn);
  const rowByTitle = (title: string): HTMLElement | undefined =>
    m.$('.wb-qr-row').find((li) => m.text(li.querySelector('.wb-qr-row-title')) === title);
  const actionIn = (title: string, label: string): HTMLElement | null | undefined =>
    rowByTitle(title)?.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  check(
    '抽屉：打开后列出两条，标题与正文摘要都对',
    !!rowByTitle('问日期') &&
      m.text(rowByTitle('问日期')!.querySelector('.wb-qr-row-body')) === '您大概什么时候出发呢？' &&
      !!rowByTitle('问人数'),
  );

  // 新建：正文带 markdown 先被前端拦住，不提交（server.quickReplies 不变）；改成正常正文才成功
  await m.click(btnByText('新建'));
  const titleInput = () => m.$('.wb-qr-field input')[0] as HTMLInputElement | undefined;
  const bodyInput = () => m.$('.wb-qr-field textarea')[0] as HTMLTextAreaElement | undefined;
  await typeInput(titleInput(), '问预算', m.qc);
  await typeInput(bodyInput(), '**预算大概多少呢？**', m.qc);
  await m.click(btnByText('保存'));
  check(
    '新建：正文带 markdown 前端就拦住，没有发往服务端（还是两条）',
    (server.quickReplies ?? []).length === 2,
    JSON.stringify(server.quickReplies),
  );
  check(
    '新建：markdown 的说明就地显示',
    m.texts('.wb-qr-help.is-error').some((t) => t === QUICK_REPLY_MARKDOWN_MSG),
  );
  await typeInput(bodyInput(), '大概的预算是多少呢？', m.qc);
  await m.click(btnByText('保存'));
  check(
    '新建：改成没有 markdown 的正文，保存成功、回到列表、排在最后',
    (server.quickReplies ?? []).map((r) => r.title).join(',') === '问日期,问人数,问预算',
    JSON.stringify(server.quickReplies),
  );
  check(
    '新建保存成功之后，焦点落回「新建」按钮，不会掉到 body（第 22 步审查 minor 第 2 条）',
    document.activeElement === btnByText('新建'),
  );

  // 新建点「取消」：什么都不建，焦点同样回到「新建」按钮
  await m.click(btnByText('新建'));
  await typeInput(titleInput(), '半路放弃', m.qc);
  await m.click(btnByText('取消'));
  check(
    '新建点「取消」：没有新建，焦点回到「新建」按钮',
    (server.quickReplies ?? []).length === 3 && document.activeElement === btnByText('新建'),
    JSON.stringify(server.quickReplies),
  );

  // 编辑：改标题，正文不动
  await m.click(actionIn('问人数', '编辑'));
  await typeInput(titleInput(), '问出行人数', m.qc);
  await m.click(btnByText('保存'));
  check(
    '编辑：改了标题，正文不变，列表里原位置替换',
    (server.quickReplies ?? []).map((r) => r.title).join(',') === '问日期,问出行人数,问预算' &&
      (server.quickReplies ?? []).find((r) => r.title === '问出行人数')?.body === '这次几位出行？',
    JSON.stringify(server.quickReplies),
  );
  check('编辑保存成功之后，焦点也落回「新建」按钮', document.activeElement === btnByText('新建'));

  // 上移下移：把「问出行人数」移到最前
  await m.click(actionIn('问出行人数', '上移'));
  check('上移：排到了最前', (server.quickReplies ?? []).map((r) => r.title).join(',') === '问出行人数,问日期,问预算');
  await m.click(actionIn('问出行人数', '下移'));
  check('下移：挪回原位', (server.quickReplies ?? []).map((r) => r.title).join(',') === '问日期,问出行人数,问预算');

  // 归档：先取消（留着，不动），焦点还给触发它的那个归档图标按钮；再确认（归档后不出现在列表、也不出现在插入列表里），
  // 这一行已经被移掉，焦点落到「新建」按钮
  const archiveBtnOf = (title: string): HTMLElement | null | undefined => actionIn(title, '归档');
  await m.click(archiveBtnOf('问出行人数'));
  check(
    '归档确认框：标题点名了这一条',
    m.texts('.ant-modal-title').some((t) => t.includes('问出行人数')),
  );
  await m.click(btnByText('留着'));
  check(
    '归档点「留着」：不动，还是三条，焦点还给那一行的「归档」按钮（第 22 步审查 minor 第 2 条）',
    (server.quickReplies ?? []).length === 3 && document.activeElement === archiveBtnOf('问出行人数'),
  );
  await m.click(archiveBtnOf('问出行人数'));
  await m.click(btnByText('归档'));
  check(
    '归档：确认之后列表里没有了',
    !(server.quickReplies ?? []).some((r) => r.title === '问出行人数'),
    JSON.stringify(server.quickReplies),
  );
  check('归档：插入列表（卡片，抽屉底下）里也没有了', !m.texts('.wb-quick-btn').includes('问出行人数'), m.texts('.wb-quick-btn').join(','));
  check('归档确认之后那一行已经没了，焦点落到「新建」按钮（第 22 步审查 minor 第 2 条）', document.activeElement === btnByText('新建'));

  // Esc 关闭，焦点回到「管理」按钮（同既有的「更多」约定）
  const drawerBody = m.$('.wb-qr-scroll')[0];
  await m.key(drawerBody, 'Escape');
  await new Promise((r) => setTimeout(r, 250));
  check('抽屉：Esc 关闭，焦点回到「管理」按钮', document.activeElement === manageBtn);
  await m.unmount();
}

// 2.16 输入框字数不压在「发送」按钮上（第 24 步走查截图带出的问题）：antd 的 showCount 字数（.ant-input-data-count）
// 用 position: absolute、bottom 取负的一个字高渲染在文本域边框之外；实测（Playwright 量真实页面）14px 字号、
// 22px 行高时是 bottom: -22px，往下占 22px。.wb-replybox-foot 原来只留 8px 的 margin-top，字数的「0」会压在
//「发送」按钮上。happy-dom 不排版，量不出真实像素重叠（getBoundingClientRect 全是 0），这里改读 workbench.css
// 源码核对间距够不够盖住这 22px，不够就说明又改回去了（同 overview.selftest.tsx 2.2b、sop.selftest.tsx 读 CSS 源码核对间距的写法）
{
  const css = fs.readFileSync(new URL('./workbench.css', import.meta.url), 'utf8');
  const rule = (sel: string): string =>
    new RegExp(`(?<!,\\n)^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
  const px = (sel: string, prop: string): number | null => {
    const v = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px;`).exec(rule(sel))?.[1];
    return v === undefined ? null : Number(v);
  };
  const ANTD_COUNT_OVERLAP_PX = 22;
  const marginTop = px('.wb-replybox-foot', 'margin-top');
  check(
    'workbench.css：.wb-replybox-foot 的 margin-top 盖住 antd 字数占的 22px，不会压在「发送」按钮上',
    marginTop !== null && marginTop >= ANTD_COUNT_OVERLAP_PX,
    `margin-top=${marginTop}`,
  );
}

Date.now = realNow;

if (fails.length) {
  console.error(`workbench: ${fails.length} 条断言失败（通过 ${pass} 条）`);
  for (const x of fails) console.error(`  ✗ ${x}`);
  process.exit(1);
}
console.log(`workbench: ${pass} 条断言全部通过`);
process.exit(0);
