// 总览趋势的自测（17 spec R10、验收 11）。
// 1. 纯逻辑（trends.ts）：缺失不画成零、线在缺失处断开、请求 30 天只能查 7 天时写明、单位与刻度。
// 2. 在 DOM 里挂载（happy-dom）：真的 TrendsBlock 加假接口：切 7/30 天、加载、空、取新数据失败留旧图、403 清旧数据、
//    文件存储只写说明、坐席不发请求、方向键逐日、数据表与图同一份数。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/overview/trends.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import './selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { DailyOpsPoint, MetricsTrendsView } from '../../../src/shared/console-api.js';
import {
  columnPath,
  coverageText,
  dayTicks,
  latestIndex,
  niceMax,
  plotOf,
  rangeText,
  reasonNotes,
  TREND_METRICS,
  trendsEmpty,
} from './trends.js';
import { TrendsBlock } from './TrendsBlock.js';

const point = (day: string, over: Partial<DailyOpsPoint> = {}): DailyOpsPoint => ({
  day,
  coverage: 'complete',
  receptions: 4,
  turns: 9,
  replySamples: 8,
  replyP90Ms: 3200,
  handoffRate: 0.25,
  aiErrorRate: 0.1,
  costMilli: 1240,
  paidOrders: 1,
  ...over,
});
const blank = (day: string): DailyOpsPoint =>
  point(day, {
    coverage: 'unavailable',
    receptions: null,
    turns: null,
    replySamples: null,
    replyP90Ms: null,
    handoffRate: null,
    aiErrorRate: null,
    costMilli: null,
    paidOrders: null,
  });
const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const view = (over: Partial<MetricsTrendsView> = {}): MetricsTrendsView => ({
  requestedDays: 7,
  days: 7,
  timezone: 'Asia/Shanghai',
  fromDay: days[0]!,
  toDay: days[6]!,
  computedAt: '2026-11-01T02:30:00.000Z',
  partialReasons: ['today'],
  points: [
    point(days[0]!),
    point(days[1]!, {
      receptions: 0,
      turns: 0,
      replySamples: 0,
      replyP90Ms: null,
      handoffRate: null,
      aiErrorRate: null,
      costMilli: 0,
      paidOrders: 0,
    }),
    blank(days[2]!),
    point(days[3]!),
    blank(days[4]!),
    point(days[5]!),
    point(days[6]!, { coverage: 'partial', receptions: 2 }),
  ],
  ...over,
});
const metric = (key: string) => TREND_METRICS.find((m) => m.key === key)!;

// ---------------- 纯逻辑 ----------------
{
  const v = view();
  const p90 = plotOf(v.points, metric('replyP90Ms'), 320);
  assert.equal(p90.points[2]!.y, null, '缺失日没有高度，不是零');
  assert.equal(p90.points[1]!.y, null, '分母为零的日子同样没有线');
  assert.deepEqual(
    p90.lines.map((s) => s.dashed),
    [true],
    '线只连相邻两天都有数的，通向今天的一段是虚线',
  );
  assert.deepEqual(p90.lone, [0, 3], '前后都断开的日子画成孤点，不连到更早的日子');
  const columns = plotOf(v.points, metric('receptions'), 320);
  assert.equal(columns.points[1]!.y, columns.baseline, '完整日的 0 落在基线上');
  assert.equal(columns.points[2]!.y, null);
  assert.ok(columns.points.at(-1)!.partial);
  assert.equal(rangeText({ requestedDays: 30, days: 7 }), '请求30天，可查询最近7天');
  assert.equal(rangeText({ requestedDays: 30, days: 30 }), '近30天');
  assert.equal(niceMax(0), 1, '全空的图不塌');
  assert.equal(niceMax(13), 20);
  assert.equal(niceMax(0.13, true), 0.2);
  assert.equal(niceMax(0.9, true), 1, '比率封顶 100%');
  assert.equal(latestIndex([blank(days[0]!), point(days[1]!), blank(days[2]!)], 'receptions'), 1);
  assert.equal(latestIndex([blank(days[0]!)], 'receptions'), null);
  assert.equal(coverageText(point(days[6]!), days[6]!), '今天未结束');
  assert.equal(coverageText(point(days[5]!, { coverage: 'partial' }), days[6]!), '数据可能不全');
  assert.equal(coverageText(blank(days[5]!), days[6]!), '无数据');
  assert.deepEqual(reasonNotes(['today']), [], '今天未结束写在卡片上，不重复');
  assert.ok(reasonNotes(['unknown_history'])[0]!.includes('不按零算'));
  assert.equal(trendsEmpty(view({ points: [point(days[0]!, { receptions: 0 }), blank(days[1]!)] })), true);
  assert.equal(trendsEmpty(view()), false);
  assert.deepEqual(dayTicks(7), [0, 3, 6]);
  assert.deepEqual(dayTicks(1), [0]);
  assert.equal(metric('costMilli').format(243), '0.24元', '费用是厘，界面写元，小数不能丢');
  assert.equal(metric('replyP90Ms').format(3888), '3.9秒');
  assert.equal(metric('handoffRate').format(0), '0%');
  assert.ok(columnPath(10, 80, 12, 80).includes('V80'), '高度为零时路径仍合法');
  console.log('PASS 纯逻辑：缺失、断线、窗口文案、单位与刻度');
}

// ---------------- DOM ----------------
const { document } = win;

interface Route {
  status: number;
  body: unknown;
}
function fakeFetch(handler: (url: URL) => Route) {
  const calls: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'https://console.invalid');
    calls.push(url.pathname + url.search);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
}
async function mount(editor = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TrendsBlock, { editor }))));
  await flush();
  return { host, qc, unmount: () => act(async () => root.unmount()) };
}

{
  const calls = fakeFetch(() => ({ status: 200, body: view() }));
  const m = await mount(false);
  assert.equal(calls.length, 0, '坐席不发请求');
  assert.equal(m.host.textContent, '');
  await m.unmount();
}
{
  const calls = fakeFetch((url) =>
    url.searchParams.get('days') === '30'
      ? { status: 200, body: view({ requestedDays: 30, partialReasons: ['retention', 'today'] }) }
      : { status: 200, body: view() },
  );
  const m = await mount();
  const text = () => m.host.textContent ?? '';
  assert.ok(text().includes('客户接待趋势，排除种子'));
  assert.ok(text().includes('近7天'));
  assert.ok(text().includes('费用是租户全部模型费用（含测试）'));
  assert.ok(text().includes('不是微信端到端送达耗时'));
  assert.equal(m.host.querySelectorAll('.ov-trend').length, 6);
  assert.equal(m.host.querySelectorAll('.ov-chart-missing').length > 0, true, '缺失日有底色带');
  assert.equal(m.host.querySelector('table'), null, '数据表默认收起');

  const chart = m.host.querySelector('.ov-chart') as unknown as HTMLElement;
  assert.equal(chart.getAttribute('tabindex'), '0');
  const fire = (e: unknown) => act(async () => void chart.dispatchEvent(e as Event));
  await fire(new win.FocusEvent('focusin', { bubbles: true }));
  await fire(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  const first = m.host.querySelector('.ov-trend-caption')?.textContent ?? '';
  assert.ok(first.startsWith('10-31'), `方向键逐日：${first}`);
  await fire(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.ok((m.host.querySelector('.ov-trend-caption')?.textContent ?? '').startsWith('10-26'));
  await fire(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  const toggle = [...m.host.querySelectorAll('button')].find((b) => b.textContent === '查看数据') as unknown as HTMLElement;
  await act(async () => toggle.click());
  const rows = [...m.host.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 7);
  assert.ok(rows[0]!.textContent!.includes('今天未结束'), '最新的日子在上面');
  const missing = rows[2]!.textContent!;
  assert.ok(missing.includes('无数据') && missing.includes('—') && !missing.includes('0个'), `缺失不写成 0：${missing}`);
  assert.ok(rows[5]!.textContent!.includes('0个'), '完整无流量的日子写 0');

  const thirty = [...m.host.querySelectorAll('.ant-segmented-item-input')].at(-1) as unknown as HTMLElement;
  await act(async () => thirty.click());
  await flush();
  assert.ok(calls.some((c) => c.endsWith('days=30')));
  assert.ok(text().includes('请求30天，可查询最近7天'));
  assert.ok(text().includes('只显示保留期内的数据'));
  await m.unmount();
  console.log('PASS 7/30 切换、方向键、数据表、保留期截短');
}
{
  fakeFetch(() => ({ status: 200, body: view({ points: [point(days[0]!, { receptions: 0 }), blank(days[1]!)] }) }));
  const m = await mount();
  assert.ok(m.host.textContent!.includes('这段时间没有可统计的接待'));
  assert.equal(m.host.querySelectorAll('.ov-trend').length, 0);
  await m.unmount();
}
{
  fakeFetch(() => ({ status: 503, body: { error: 'store_file_mode' } }));
  const m = await mount();
  assert.ok(m.host.textContent!.includes('趋势只在会话存入数据库时可用'));
  assert.equal(m.host.querySelectorAll('svg.ov-chart, .ov-chart').length, 0, '文件存储不画假图');
  await m.unmount();
}
{
  let fail = false;
  fakeFetch(() => (fail ? { status: 500, body: { error: 'internal' } } : { status: 200, body: view() }));
  const m = await mount();
  fail = true;
  await act(async () => void (await m.qc.refetchQueries()));
  await flush();
  assert.ok(m.host.textContent!.includes('没取到新数据'), '取新数据失败时写明');
  assert.equal(m.host.querySelectorAll('.ov-trend').length, 6, '旧图留着');
  fail = false;
  await act(async () => [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('重试'))?.click());
  await flush();
  assert.ok(!m.host.textContent!.includes('没取到新数据'), '局部重试后恢复');

  fakeFetch(() => ({ status: 403, body: { error: 'forbidden' } }));
  await act(async () => void (await m.qc.refetchQueries()));
  await flush();
  assert.equal(m.host.textContent, '', '403 不留旧数据');
  assert.equal(m.qc.getQueryCache().findAll({ queryKey: ['metrics-trends'] }).length, 0);
  await m.unmount();
  console.log('PASS 空、文件存储、失败留旧图与重试、403 清缓存');
}
console.log('TRENDS UI PASS');
process.exit(0);
