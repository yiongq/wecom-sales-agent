// 08 第 16 步：接口下发的通用订单、画像与报价卡；旅游沿用原文，金额全程按分展示。
import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationDetail, LineOrderView, TurnTraceView } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { VIEWER_KEY } from '../viewer.js';
import { cjk } from '../typography.js';
import { OrderRow, ProfileCard, QuoteCard } from './WorkbenchPage.js';
import { needLine, quoteLine } from './workbench.js';
import { attentionTodos } from '../overview/model.js';
import { TraceTab } from './TraceDetail.js';

const now = Date.parse('2026-10-24T04:00:00Z');
const display: LineOrderView['display'] = {
  title: '合成方盒甲等2项',
  summary: '2项 · 共250件',
  totalFen: 133000,
  totalText: '1,330元',
  lines: [
    { title: '合成方盒甲', qtyText: '200件', unitPriceText: '3.65元/件', amountText: '730元', attrs: { 交期: '7天', 备注: '<img src=x>' } },
    { title: '合成方盒乙', qtyText: '50件', unitPriceText: '12元/件', amountText: '600元' },
  ],
};
const order: LineOrderView = {
  id: 'ord_cards',
  status: 'pending_payment',
  display,
  totalFen: 133000,
  totalText: '1,330元',
  createdAt: new Date(now).toISOString(),
  paidAt: null,
  confirmed: null,
  handoffBeforePaid: null,
  conversation: { id: 'wecom:wmCards', channel: 'wecom', needSummary: '合成需求' },
};
const props = {
  canConfirm: true,
  canMarkPaid: false,
  onConfirm() {},
  onMarkPaid() {},
  onCancel() {},
  confirmError: null,
  markPaidError: null,
  cancelError: null,
};
function text(markup: string): string {
  const node = new win.DOMParser().parseFromString(markup, 'text/html').body;
  return node.textContent ?? '';
}
const lineHtml = renderToStaticMarkup(<OrderRow o={order} {...props} />);
const lineText = text(lineHtml);
for (const value of ['合成方盒甲', '200件', '3.65元/件', '730元', '合成方盒乙', '50件', '12元/件', '600元', '合计1,330元'])
  assert.ok(lineText.includes(value), value);
assert.equal((lineHtml.match(/<li>/g) ?? []).length, 2);
assert.ok(lineText.includes('交期：7天'));
assert.ok(lineText.includes('备注：<img src=x>'));
assert.ok(lineHtml.includes('&lt;img src=x&gt;'));
assert.ok(!lineHtml.includes('<img '));
assert.doesNotMatch(lineText, /出行|出发|线路|¥|NaN|undefined/);
const escaped = { ...order, display: { ...display, lines: [{ ...display.lines[0]!, title: '<img src=x onerror=alert(1)>' }] } };
assert.ok(renderToStaticMarkup(<OrderRow o={escaped} {...props} />).includes('&lt;img'));

const need: ConversationDetail['need'] = { destination: '合成目的地', segment: null, travelers: '2人', dates: null, budget: null };
const quote: NonNullable<ConversationDetail['quote']> = {
  routeId: 'r-test',
  routeTitle: '合成旅游',
  travelers: 2,
  perPerson: 1000,
  total: 2000,
  departDate: null,
};
assert.equal(
  renderToStaticMarkup(<ProfileCard cd={{ need }} now={now} />),
  renderToStaticMarkup(
    <div className="wb-card">
      <h3 className="wb-card-title">需求</h3>
      <p>{cjk(needLine(need, now))}</p>
    </div>,
  ),
);
assert.equal(
  renderToStaticMarkup(<QuoteCard cd={{ quote }} />),
  renderToStaticMarkup(
    <div className="wb-card">
      <h3 className="wb-card-title">最近报价</h3>
      <p>{cjk(quoteLine(quote))}</p>
    </div>,
  ),
);
const legacy = {
  id: 'ord_legacy',
  routeTitle: '合成旅游',
  travelers: 2,
  departDate: '',
  totalPrice: 2000,
  status: 'paid' as const,
  createdAt: new Date(now).toISOString(),
  paidAt: null,
  confirmed: null,
  handoffBeforePaid: null,
  conversation: null,
};
const legacyHtml = renderToStaticMarkup(<OrderRow o={legacy} {...props} canConfirm={false} />);
assert.equal(text(legacyHtml), '合成旅游·2位共2,000元已付款');
assert.ok(!legacyHtml.includes('wb-order-display'));

const profileCard = {
  title: '合成客户',
  rows: [
    { label: '颜色', value: '蓝色' },
    { label: '尺寸', value: '大号' },
  ],
};
const profileHtml = renderToStaticMarkup(<ProfileCard cd={{ need, profileCard }} now={now} />);
assert.equal(text(profileHtml), '客户信息合成客户颜色蓝色尺寸大号');
assert.equal((profileHtml.match(/<dt>/g) ?? []).length, 2);
assert.ok(!text(profileHtml).includes(need.destination!));
for (const amountFen of [133050, 0, null]) {
  const html = renderToStaticMarkup(
    <QuoteCard cd={{ quote, quoteCard: { title: '合成报价', amountFen, lines: ['交期待核对', '数量已记录'] } }} />,
  );
  const actual = text(html);
  assert.equal(actual, '最近报价合成报价' + (amountFen === null ? '' : amountFen === 0 ? '0元' : '1,330.50元') + '交期待核对数量已记录');
  assert.equal(actual.includes('1,330.50元'), amountFen === 133050);
  assert.equal(actual.includes('合成报价0元交期'), amountFen === 0);
  assert.doesNotMatch(actual, /合成旅游|NaN|undefined|¥/);
}
const pack: IndustryPack = {
  id: '__fixture',
  name: '合成包',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '方盒', tools: {}, sopFields: {} },
  stages: [],
  entities: [],
  sopSections: [],
  nav: { catalogGroup: '产品', entities: [] },
};
const todos = attentionTodos([], [], [order], 'online', pack, now);
assert.ok(todos[0]!.context?.some((segment) => segment.text === '1,330元'));
assert.equal(todos[0]!.key, `order:${order.id}`);
assert.deepEqual(
  attentionTodos([], [], [{ ...order, id: 'ord_small', totalFen: 1, totalText: '0.01元' }, order], 'online', pack, now).map(
    (todo) => todo.key,
  ),
  [`order:${order.id}`, 'order:ord_small'],
);
for (const mode of ['online', 'advisor'] as const) {
  const pending = { ...order, approval: { state: 'pending' as const }, quoteState: 'pending' as const };
  const quoteTodos = attentionTodos([], [], [pending], mode, pack, now);
  assert.equal(quoteTodos.length, 1);
  assert.ok(quoteTodos[0]!.context?.some((segment) => segment.text === '报价单等你审核'));
  assert.ok(!JSON.stringify(quoteTodos).includes('等你确认价格'));
  for (const state of ['expired', 'invalid', 'superseded', 'paid'] as const)
    assert.equal(attentionTodos([], [], [{ ...pending, quoteState: state }], mode, pack, now).length, 0);
}
console.log('QUOTE OVERVIEW PASS：两种付款模式待审计数1、审批文案、过期/无效/取代/已付不计待付款');
console.log('PACK CARDS PASS：通用订单两行、画像卡、报价卡（有金额/零/null）、A2；旅游正文与原 JSX 一致，动态文字转义');

// 真挂载 trace，验证非旅游入口隐藏、旅游入口保留；不以函数返回值替代按钮可见性。
const trace: TurnTraceView = {
  turnId: 't-cards',
  startedAt: new Date(now).toISOString(),
  durationMs: 1,
  outcome: 'replied',
  sopVersion: 1,
  prefixHash: 'a'.repeat(64),
  catalogVersions: {},
  stageBefore: null,
  stageAfter: null,
  draft: '',
  finalText: '',
  calls: [],
  llm: [],
  signals: null,
  guardVerdicts: null,
  replyShape: null,
  handoffKind: null,
  customerText: null,
};
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify(trace), { status: 200, headers: { 'content-type': 'application/json' } });
try {
  for (const id of ['__fixture', 'travel']) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    qc.setQueryData(VIEWER_KEY, { kind: 'anon', pack: { ...pack, id } });
    qc.setQueryData(['conversations', 'turnTrace', 'wecom:wmCards', trace.turnId], trace);
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(createElement(QueryClientProvider, { client: qc }, <TraceTab id="wecom:wmCards" turnId={trace.turnId} />)),
      );
      assert.equal(node.textContent?.includes('存为回归用例'), id === 'travel');
    } finally {
      await act(async () => root.unmount());
      node.remove();
      qc.clear();
    }
  }
} finally {
  globalThis.fetch = realFetch;
}
console.log('PACK CARDS PASS：非旅游包隐藏下载入口，旅游仍显示');
await win.happyDOM.close();
