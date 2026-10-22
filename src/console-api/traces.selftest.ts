// AI 记录与「存为回归用例」的自测（docs/architecture/07-knowledge-aftersales/spec.md R24、不变量 21、验收 12）。
// 第一段是仓储函数（listTraces、readTurnCustomerMessage、readTurnExportSource）：PGlite 与真实 PG（给了 PG_TEST_URL）各跑一遍同一份断言，
//   覆盖 outcome、护栏、转人工原因、超长、时间段筛选，游标翻页不重不漏（含同一毫秒内不同微秒、同一时刻不同 id 的行），跨租户读不到（FORCE RLS）。
// 第二段是接口（PGlite 上的 db 会话存储，走 server.ts 的 app.request）：GET /traces、trace 详情补的四项、goal-draft 下载（原样交给 eval/sim/goals.ts
//   的校验必失败并点名 _draft 与 predicates；号码已打码；不落盘；审计 trace.export）、五种角色与匿名的权限、三种页面状态依赖的接口行为。
// 时间全部钉在固定的过去时刻，不依赖真实此刻与跑的时刻。
// 用法：npx tsx src/console-api/traces.selftest.ts（真实 PG：PG_TEST_URL=postgres://… 另跑一遍第一段）
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tx } from '../db/client.js';
import type { TraceListFilter, TraceListRow } from '../db/repo/traces.js';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-traces-selftest-'));
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const { openTestDb, installSeededConfig, installPgSessionStore, createRealPgFixture } = await withoutTenantScope(
  () => import('../db/testing.js'),
);
const { openDb, withTenant } = await withoutTenantScope(() => import('../db/client.js'));
const repo = await withoutTenantScope(() => import('../db/repo/traces.js'));

// ---------------- 第一段：仓储函数（PGlite 与真实 PG 各一遍） ----------------

/** 一条 trace 的夹具：started 是 UTC 微秒时刻的文本，决定排序 */
interface Fx {
  n: number;
  conv: string;
  started: string;
  outcome: string;
  verdicts: { id: string; action: string }[] | null | 'garbage';
  overLimit: boolean | null;
}
const tid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TRACES: Fx[] = [
  {
    n: 1,
    conv: 'A1',
    started: '2026-09-20 10:00:00.123456+00',
    outcome: 'replied',
    verdicts: [
      { id: 'pre_clean', action: 'pass' },
      { id: 'price', action: 'drop_sentence' },
      { id: 'shape_check', action: 'pass' },
    ],
    overLimit: false,
  },
  {
    n: 2,
    conv: 'A1',
    started: '2026-09-20 10:00:00.123789+00',
    outcome: 'handoff',
    verdicts: [
      { id: 'claim_words', action: 'replace' },
      { id: 'price', action: 'pass' },
    ],
    overLimit: true,
  },
  { n: 3, conv: 'A2', started: '2026-09-20 10:00:00.123789+00', outcome: 'replied', verdicts: null, overLimit: null },
  { n: 4, conv: 'A2', started: '2026-09-21 09:00:00+00', outcome: 'silent', verdicts: [], overLimit: null },
  {
    n: 5,
    conv: 'A1',
    started: '2026-09-21 12:00:00+00',
    outcome: 'handoff',
    verdicts: [{ id: 'identity', action: 'append' }],
    overLimit: true,
  },
  {
    n: 6,
    conv: 'A3',
    started: '2026-09-22 08:00:00+00',
    outcome: 'error',
    verdicts: [{ id: 'takeover_check:pre', action: 'abort' }],
    overLimit: false,
  },
  {
    n: 7,
    conv: 'A2',
    started: '2026-09-22 09:00:00+00',
    outcome: 'replied',
    verdicts: [
      { id: 'price', action: 'patch' },
      { id: 'custom_promise-a', action: 'pass' },
    ],
    overLimit: false,
  },
  { n: 8, conv: 'A1', started: '2026-09-19 10:00:00.5+00', outcome: 'deterministic', verdicts: 'garbage', overLimit: true },
  {
    n: 9,
    conv: 'A2',
    started: '2026-09-18 23:59:59.999999+00',
    outcome: 'replied',
    verdicts: [{ id: 'price', action: 'drop_sentence' }],
    overLimit: null,
  },
];
/** 微秒数（BigInt），用来算期望的顺序 */
const micros = (started: string): bigint => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\+00$/.exec(started)!;
  const ms = BigInt(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return ms * 1000n + BigInt((m[7] ?? '').padEnd(6, '0'));
};
const byTime = (a: Fx, b: Fx): number =>
  micros(b.started) > micros(a.started) ? 1 : micros(b.started) < micros(a.started) ? -1 : b.n - a.n;
const ORDER = TRACES.toSorted(byTime).map((x) => x.n);
/** 会话 A1 的 handoffLog：第 2 轮转人工（客户要投诉）、第 5 轮先要人工再升级成紧急；顾问接手那条没有 turnId */
const A1_LOG = [
  { kind: 'complaint', at: 1, turnId: tid(2) },
  { kind: 'request', at: 2, turnId: tid(5) },
  { kind: 'emergency', at: 3, turnId: tid(5) },
  { kind: 'agent', at: 4 },
];

interface Harness {
  name: string;
  /** 超级用户执行（造数据） */
  su(text: string, params?: unknown[]): Promise<unknown[]>;
  /** 以应用角色在一个租户的只读事务里执行 */
  app<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

async function repoSuite(h: Harness): Promise<void> {
  const ck = (name: string, cond: boolean, detail = ''): void => check(`${h.name}：${name}`, cond, detail);
  const mkTenant = async (slug: string): Promise<string> =>
    ((await h.su(`insert into tenants (slug, name, pack_id) values ($1, $1, 'travel') returning id`, [slug])) as { id: string }[])[0]!.id;
  const A = await mkTenant('tr-a');
  const B = await mkTenant('tr-b');
  const conv = async (tenant: string, id: string, channel: string, state: Record<string, unknown>): Promise<string> =>
    (
      (await h.su(
        `insert into conversations (tenant_id, id, channel, stage, handed_over, state, created_at, updated_at)
       values ($1, $2, $3, 'discovery', false, $4::json, '2026-09-18 00:00:00+00', '2026-09-22 10:00:00+00') returning ref`,
        [tenant, id, channel, JSON.stringify({ id, ...state })],
      )) as { ref: string }[]
    )[0]!.ref;
  const refs = {
    A1: await conv(A, 'wecom:wmTrA1', 'wecom', { handoffLog: A1_LOG }),
    A2: await conv(A, 'wecom:wmTrA2', 'simulator', {}),
    A3: await conv(A, 'wecom:wmTrA3', 'wecom', { handoffLog: 'oops' }),
    B1: await conv(B, 'wecom:wmTrB1', 'wecom', { handoffLog: [{ kind: 'complaint', at: 1, turnId: tid(101) }] }),
  };
  const convId = (k: string): string => `wecom:wmTr${k}`;
  const insertTrace = async (
    tenant: string,
    n: number,
    c: string,
    started: string,
    outcome: string,
    verdicts: Fx['verdicts'],
    overLimit: boolean | null,
  ): Promise<void> => {
    const shape =
      overLimit === null ? null : { class: 'plain', lines: 2, chars: 40, limit: 3, trimmed: 0, overLimit, rewrite: 'off', rewriteMs: null };
    await h.su(
      `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm, guard_verdicts, reply_shape)
       values ($1, $2, $3, $4::timestamptz, $5, $6, repeat('a', 64), '{}'::json, $7::json, '[]'::json, $8::json, $9::json)`,
      [
        tenant,
        tid(n),
        convId(c),
        started,
        100 + n,
        outcome,
        JSON.stringify([{ name: 'search_routes', prefetch: false }]),
        verdicts === null ? null : verdicts === 'garbage' ? JSON.stringify({ not: 'an array' }) : JSON.stringify(verdicts),
        shape === null ? null : JSON.stringify(shape),
      ],
    );
  };
  for (const x of TRACES) await insertTrace(A, x.n, x.conv, x.started, x.outcome, x.verdicts, x.overLimit);
  await insertTrace(B, 101, 'B1', '2026-09-22 11:00:00+00', 'replied', [{ id: 'price', action: 'drop_sentence' }], true);
  // 消息：A1 里两轮（第 1、2 轮的回复带 turn_id），第 5 轮的回复前是两条连着的客户消息；A2 的第 4 轮是沉默（没有回复消息）
  const msg = async (
    tenant: string,
    c: string,
    seq: number,
    role: string,
    author: string | null,
    content: string,
    turn: number | null,
  ): Promise<void> => {
    await h.su(
      `insert into messages (tenant_id, conversation_id, seq, role, author, content, at, turn_id)
       values ($1, $2, $3, $4, $5, $6, '2026-09-20 09:00:00+00', $7)`,
      [tenant, convId(c), seq, role, author, content, turn === null ? null : tid(turn)],
    );
  };
  await msg(A, 'A1', 1, 'customer', null, '客户第一句 13812345678', null);
  await msg(A, 'A1', 2, 'agent', 'ai', 'AI 回复一', 1);
  await msg(A, 'A1', 3, 'system', null, '系统备注', null);
  await msg(A, 'A1', 4, 'customer', null, '客户第二句', null);
  await msg(A, 'A1', 5, 'agent', 'ai', 'AI 回复二', 2);
  await msg(A, 'A1', 6, 'customer', null, '客户第三句甲', null);
  await msg(A, 'A1', 7, 'customer', null, '客户第三句乙', null);
  await msg(A, 'A1', 8, 'agent', 'ai', 'AI 回复三', 5);
  // 第 8 轮：客户消息之后先有顾问插话和系统备注，AI 才回——客户原话要越过它们，不能取紧挨着回复的那一条
  await msg(A, 'A1', 9, 'customer', null, '客户第四句', null);
  await msg(A, 'A1', 10, 'agent', 'human', '顾问插话', null);
  await msg(A, 'A1', 11, 'system', null, '系统备注二', null);
  await msg(A, 'A1', 12, 'agent', 'ai', 'AI 回复四', 8);
  await msg(A, 'A2', 1, 'customer', null, '沉默的一句', null);
  await msg(B, 'B1', 1, 'customer', null, 'B 租户的客户', null);
  await msg(B, 'B1', 2, 'agent', 'ai', 'B 租户的回复', 101);

  const list = async (tenant: string, f: Partial<TraceListFilter> = {}): Promise<{ rows: TraceListRow[]; next: string | null }> =>
    h.app(tenant, (tx) => repo.listTraces(tx, { limit: 100, ...f }));
  const ids = (rows: TraceListRow[]): number[] => rows.map((r) => Number(r.turnId.slice(-12)));
  const eq = (name: string, got: unknown, want: unknown): void =>
    ck(name, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

  // ---- 全量：倒序，同一毫秒内按微秒、同一时刻按 id 倒序；字段形状 ----
  const all = await list(A);
  eq('全量按开始时间倒序（同毫秒按微秒、同一时刻按 id 倒序），没有下一页', [ids(all.rows), all.next], [ORDER, null]);
  const r1 = all.rows.find((r) => r.turnId === tid(1))!;
  const r3 = all.rows.find((r) => r.turnId === tid(3))!;
  eq(
    '一行的字段：会话 id、渠道、耗时、结果、触发的护栏（跳过 pass）、超长',
    [r1.conversationId, r1.channel, r1.durationMs, r1.outcome, r1.guards, r1.overLimit],
    ['wecom:wmTrA1', 'wecom', 101, 'replied', ['price'], false],
  );
  ck('开始时刻精确到毫秒', r1.startedAt.toISOString() === '2026-09-20T10:00:00.123Z', r1.startedAt.toISOString());
  eq(
    '没进流水线的轮次（verdicts 为 NULL）：护栏为空、没记形状算不超长、模拟器渠道',
    [r3.guards, r3.overLimit, r3.channel, r3.handoffKind],
    [[], false, 'simulator', null],
  );
  eq(
    '护栏列保持执行顺序，并含 abort',
    [all.rows.find((r) => r.turnId === tid(7))!.guards, all.rows.find((r) => r.turnId === tid(6))!.guards],
    [['price'], ['takeover_check:pre']],
  );
  eq('guard_verdicts 不是数组的坏数据当没有护栏', all.rows.find((r) => r.turnId === tid(8))!.guards, []);

  // ---- 筛选：outcome ----
  eq('outcome=handoff', ids((await list(A, { outcome: 'handoff' })).rows), [5, 2]);
  eq('outcome=replied', ids((await list(A, { outcome: 'replied' })).rows), [7, 3, 1, 9]);
  eq('outcome=silent', ids((await list(A, { outcome: 'silent' })).rows), [4]);
  eq('outcome=budget 没有', ids((await list(A, { outcome: 'budget' })).rows), []);

  // ---- 筛选：触发过的护栏（只算 action 不是 pass 的） ----
  eq('guard=price：第 1、7、9 轮触发；第 2 轮的 price 是 pass、不算', ids((await list(A, { guard: 'price' })).rows), [7, 1, 9]);
  eq('guard=claim_words', ids((await list(A, { guard: 'claim_words' })).rows), [2]);
  eq('guard=custom_promise-a：只有 pass，不算触发', ids((await list(A, { guard: 'custom_promise-a' })).rows), []);
  eq('guard=takeover_check:pre（abort 算触发，id 里带冒号）', ids((await list(A, { guard: 'takeover_check:pre' })).rows), [6]);
  eq('guard=shape_check：只有 pass', ids((await list(A, { guard: 'shape_check' })).rows), []);

  // ---- 筛选：转人工原因（按会话 handoffLog 里的 turnId 对上这一轮） ----
  eq('handoffKind=complaint：只有第 2 轮', ids((await list(A, { handoffKind: 'complaint' })).rows), [2]);
  eq('handoffKind=request：第 5 轮（同一轮里先 request 再升级成 emergency）', ids((await list(A, { handoffKind: 'request' })).rows), [5]);
  eq('handoffKind=emergency：第 5 轮', ids((await list(A, { handoffKind: 'emergency' })).rows), [5]);
  eq('handoffKind=agent：没有 turnId 的记录对不上任何一轮', ids((await list(A, { handoffKind: 'agent' })).rows), []);
  eq('handoffKind=refund：没有', ids((await list(A, { handoffKind: 'refund' })).rows), []);
  eq(
    '行上的转人工原因：同一轮有两条取最后一条；记录不是数组的会话为 null',
    [
      all.rows.find((r) => r.turnId === tid(2))!.handoffKind,
      all.rows.find((r) => r.turnId === tid(5))!.handoffKind,
      all.rows.find((r) => r.turnId === tid(6))!.handoffKind,
      all.rows.find((r) => r.turnId === tid(1))!.handoffKind,
    ],
    ['complaint', 'emergency', null, null],
  );

  // ---- 筛选：超长、时间段 ----
  eq('overLimit：reply_shape.overLimit 为真的', ids((await list(A, { overLimit: true })).rows), [5, 2, 8]);
  eq(
    'since 含、until 不含',
    ids((await list(A, { since: '2026-09-20T10:00:00.123789Z', until: '2026-09-22T08:00:00Z' })).rows),
    [5, 4, 3, 2],
  );
  eq('since 在最新一条之后：空', ids((await list(A, { since: '2026-09-22T09:00:00.001Z' })).rows), []);
  eq('带时区的 since（北京时间 16:00 = UTC 08:00，含）', ids((await list(A, { since: '2026-09-22T16:00:00+08:00' })).rows), [7, 6]);
  eq(
    '组合：handoff 且超长且不早于 10-21',
    ids((await list(A, { outcome: 'handoff', overLimit: true, since: '2026-09-21T00:00:00Z' })).rows),
    [5],
  );
  eq(
    '组合：guard=price 且 outcome=replied 且 until',
    ids((await list(A, { guard: 'price', outcome: 'replied', until: '2026-09-22T00:00:00Z' })).rows),
    [1, 9],
  );

  // ---- 游标翻页：不重不漏，各种页大小；最后一页 next 为 null ----
  for (const limit of [1, 2, 3, 4, 9, 10]) {
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(A, { limit, before: cursor });
      seen.push(...ids(page.rows));
      cursor = page.next ?? undefined;
      pages += 1;
      if (pages > 20) break;
    } while (cursor !== undefined);
    ck(`limit=${limit} 翻页走完：与全量完全相同，没有重复、没有遗漏`, JSON.stringify(seen) === JSON.stringify(ORDER), JSON.stringify(seen));
    ck(`limit=${limit} 页数`, pages === Math.ceil(TRACES.length / limit), String(pages));
  }
  const firstPage = await list(A, { limit: 4 });
  ck(
    'next 的形式：开始时刻（UTC 微秒）_轮次 id',
    /^2026-09-\d\dT[\d:]+\.\d{6}Z_[0-9a-f-]{36}$/.test(firstPage.next ?? ''),
    String(firstPage.next),
  );
  eq(
    '翻页从同一时刻的第 3 轮切开：下一页先是同一时刻 id 更小的第 2 轮，再是同毫秒里微秒更小的第 1 轮',
    ids((await list(A, { limit: 2, before: (await list(A, { limit: 5 })).next! })).rows),
    [2, 1],
  );
  eq(
    '翻页时带筛选：guard=price 每页 1 条',
    await (async () => {
      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(A, { guard: 'price', limit: 1, before: cursor });
        seen.push(...ids(page.rows));
        cursor = page.next ?? undefined;
      } while (cursor !== undefined && seen.length < 10);
      return seen;
    })(),
    [7, 1, 9],
  );

  // ---- 租户隔离：A 看不到 B 的轮次，B 也看不到 A 的；按 id 直接读也读不到（FORCE RLS） ----
  eq('A 的列表里没有 B 的轮次', ids((await list(A)).rows).includes(101), false);
  eq('B 的列表只有自己的一条', [ids((await list(B)).rows), (await list(B)).rows[0]?.conversationId], [[101], 'wecom:wmTrB1']);
  eq(
    'B 的转人工原因只在 B 里对得上：A 租户用 B 的筛选读不到',
    ids((await list(A, { handoffKind: 'complaint' })).rows).includes(101),
    false,
  );
  eq('B 的转人工筛选能读到自己的', ids((await list(B, { handoffKind: 'complaint' })).rows), [101]);
  const crossTrace = await h.app(A, (tx) => repo.readTurnTrace(tx, convId('B1'), tid(101)));
  const crossCustomer = await h.app(A, (tx) => repo.readTurnCustomerMessage(tx, convId('B1'), tid(101)));
  const crossExport = await h.app(A, (tx) => repo.readTurnExportSource(tx, convId('B1'), tid(101), 10));
  ck('A 读 B 的 trace、客户原话、导出材料：都是 null', crossTrace === null && crossCustomer === null && crossExport === null);
  const ownExportB = await h.app(B, (tx) => repo.readTurnExportSource(tx, convId('B1'), tid(101), 10));
  ck('B 读自己的导出材料：有', ownExportB?.customer?.content === 'B 租户的客户' && ownExportB.ref === refs.B1);

  // ---- 详情补的材料：客户原话、导出材料 ----
  const cust = async (c: string, n: number) => h.app(A, (tx) => repo.readTurnCustomerMessage(tx, convId(c), tid(n)));
  eq('客户原话：第 1 轮回复之前的那条', await cust('A1', 1), { seq: 1, content: '客户第一句 13812345678' });
  eq('客户原话：第 2 轮取回复之前最近的客户消息，越过中间的 system', await cust('A1', 2), { seq: 4, content: '客户第二句' });
  eq('客户原话：连着两条客户消息时取最近的一条', await cust('A1', 5), { seq: 7, content: '客户第三句乙' });
  eq('客户原话：紧挨着回复的是顾问插话和系统备注时，越过它们取客户那条', await cust('A1', 8), { seq: 9, content: '客户第四句' });
  eq('客户原话：沉默的一轮没有回复消息，为 null', await cust('A2', 4), null);
  eq(
    '客户原话：别的会话的轮次、不是 uuid 的 id',
    [await cust('A2', 1), await h.app(A, (tx) => repo.readTurnCustomerMessage(tx, convId('A1'), 'not-a-uuid'))],
    [null, null],
  );
  const src = await h.app(A, (tx) => repo.readTurnExportSource(tx, convId('A1'), tid(5), 10));
  ck('导出材料：ref 是会话行的 ref，不含客户标识', src?.ref === refs.A1 && !src.ref.includes('wmTr'));
  eq('导出材料：这一轮之前的消息升序、不含 system', src?.history, [
    { role: 'customer', content: '客户第一句 13812345678' },
    { role: 'agent', content: 'AI 回复一' },
    { role: 'customer', content: '客户第二句' },
    { role: 'agent', content: 'AI 回复二' },
    { role: 'customer', content: '客户第三句甲' },
  ]);
  const limited = await h.app(A, (tx) => repo.readTurnExportSource(tx, convId('A1'), tid(5), 2));
  eq(
    '导出材料：只取最近 N 条',
    limited?.history.map((m) => m.content),
    ['AI 回复二', '客户第三句甲'],
  );
  // 第 5 轮的客户那条是 seq 7；它之前最近的 4 条里有一条 system（seq 3）：system 不占名额，所以取到 seq 2、4、5、6，不是 3 条
  const withSystem = await h.app(A, (tx) => repo.readTurnExportSource(tx, convId('A1'), tid(5), 4));
  eq(
    '导出材料：system 不占名额（取 4 条就是 4 条客户与回复消息）',
    withSystem?.history.map((m) => m.content),
    ['AI 回复一', '客户第二句', 'AI 回复二', '客户第三句甲'],
  );
  ck(
    '导出材料：不存在的轮次与别的会话的轮次是 null',
    (await h.app(A, (tx) => repo.readTurnExportSource(tx, convId('A2'), tid(1), 10))) === null,
  );
  const trace7 = await h.app(A, (tx) => repo.readTurnTrace(tx, convId('A2'), tid(7)));
  eq(
    'readTurnTrace 带 guardVerdicts 与 replyShape',
    [trace7?.guardVerdicts, trace7?.replyShape?.overLimit],
    [
      [
        { id: 'price', action: 'patch' },
        { id: 'custom_promise-a', action: 'pass' },
      ],
      false,
    ],
  );
}

// PGlite
{
  const t = await openTestDb();
  await t.pg.exec('SET ROLE agent_app');
  const suPg = (text: string, params: unknown[] = []): Promise<unknown[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query(text, params)).rows;
    });
  const ctxOf = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
  await repoSuite({
    name: 'PGlite',
    su: suPg,
    app: (tenantId, fn) => withTenant(t.db, ctxOf(tenantId), fn, { readOnly: true }),
  });
  await t.close();
}
// 真实 PG：一个临时库，应用连接用 agent_app（FORCE RLS 真正起作用）
let realPgRan = false;
if (process.env.PG_TEST_URL) {
  const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'tr-fixture' });
  try {
    const conn = await openDb(fx.urls.app, { max: 1 });
    const ctxOf = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
    await repoSuite({
      name: '真实 PG',
      su: (text, params) => fx.query(text, params),
      app: (tenantId, fn) => withTenant(conn.db, ctxOf(tenantId), fn, { readOnly: true }),
    });
    await conn.close();
    realPgRan = true;
  } finally {
    await fx.drop();
  }
}

// ---------------- 草稿的纯函数：订单回推、阶段、历史、打码 ----------------
{
  const { ordersBeforeTurn, buildGoalDraft, GOAL_DRAFT_NOTE, goalDraftFilename } = await withoutTenantScope(
    () => import('./goal-draft.js'),
  );
  const { handoffKindOfTurn } = await withoutTenantScope(() => import('../shared/conversation-types.js'));
  const startedAt = Date.parse('2026-09-21T10:00:00Z');
  const order = (over: Record<string, unknown>) =>
    ({
      id: 'ord_x',
      sessionId: 's',
      routeId: 'r-1',
      routeTitle: '线路',
      travelers: 2,
      departDate: '2026-12-01',
      totalPrice: 100,
      status: 'pending_payment',
      createdAt: startedAt - 1000,
      ...over,
    }) as import('../types.js').Order;
  const refund = (requestedAt: number) => ({ requestedAt }) as import('../shared/conversation-types.js').RefundRecord;
  const before = (o: import('../types.js').Order) => ordersBeforeTurn([o], startedAt)[0]?.status ?? null;
  check(
    '订单回推：这一轮才建的单、被换掉的旧单、出发日写法不对的单不带',
    ordersBeforeTurn([order({ createdAt: startedAt }), order({ status: 'superseded' }), order({ departDate: '下个月' })], startedAt)
      .length === 0,
  );
  check(
    '订单回推：待付款照旧；这一轮或之后才付的款回推成待付款；之前付的是已付款',
    before(order({})) === 'pending_payment' &&
      before(order({ status: 'paid', paidAt: startedAt + 5 })) === 'pending_payment' &&
      before(order({ status: 'paid', paidAt: startedAt - 5 })) === 'paid',
  );
  check(
    '订单回推：退款申请发生在这一轮或之后的回推成已付款；申请在这一轮之前的保留退款中、已退款；取消的按取消',
    before(order({ status: 'refund_pending', paidAt: startedAt - 50, refund: refund(startedAt + 1) })) === 'paid' &&
      before(order({ status: 'refund_pending', paidAt: startedAt - 50, refund: refund(startedAt - 1) })) === 'refund_pending' &&
      before(order({ status: 'refunded', paidAt: startedAt - 50, refund: refund(startedAt - 10) })) === 'refunded' &&
      before(order({ status: 'refunded', paidAt: startedAt + 50, refund: refund(startedAt + 60) })) === 'pending_payment' &&
      before(order({ status: 'cancelled' })) === 'cancelled',
  );
  const base = {
    turnId: tid(1),
    startedAt: new Date(startedAt),
    durationMs: 10,
    outcome: 'replied',
    sopVersion: 1,
    stageBefore: 'pricing',
    stageAfter: 'quote',
    finalText: null,
    calls: [{ name: 'a' }, { name: 'a' }, 'x', null, { name: '' }, { name: 3 }, { name: 'b' }],
    guardVerdicts: null,
    replyShape: null,
    handoffKind: null,
    customerText: null,
    history: [],
    orders: [],
  } as const;
  const bare = buildGoalDraft(base);
  check(
    '草稿：阶段不在目标的阶段表里就不带；没有历史、订单就没有 initial；工具名去重并跳过坏数据；客户原话为空时 customerScript 为空',
    bare.initial === undefined &&
      JSON.stringify(bare.allowedTools) === '["a","b"]' &&
      JSON.stringify(bare.customerScript) === '[]' &&
      bare._draft.guards.length === 0 &&
      bare._draft.reply === null,
  );
  const long = buildGoalDraft({
    ...base,
    stageBefore: 'closing',
    customerText: '  电话 13800001111  ',
    history: [
      { role: 'agent', content: '  ' },
      { role: 'customer', content: '银行卡 6222020200112233445' },
      { role: 'agent', content: '好的' },
    ],
    guardVerdicts: [
      { id: 'price', action: 'pass' },
      { id: 'claim_words', action: 'replace' },
    ],
    finalText: '联系 13900002222',
  });
  check(
    '草稿：阶段在表里就带；历史跳过空消息、agent 映射成 ai、号码打码；谓词、persona 为空；note 提醒要改写',
    long.initial?.stage === 'closing' &&
      JSON.stringify(long.initial?.history) ===
        JSON.stringify([
          { role: 'customer', content: '银行卡 ***************3445' },
          { role: 'ai', content: '好的' },
        ]) &&
      JSON.stringify(long.customerScript) === '["电话 *******1111"]' &&
      JSON.stringify(long._draft.guards) === '[{"id":"claim_words","action":"replace"}]' &&
      long._draft.reply === '联系 *******2222' &&
      long.predicates.length === 0 &&
      long.persona === '' &&
      long._draft.note === GOAL_DRAFT_NOTE &&
      GOAL_DRAFT_NOTE.includes('_draft') &&
      GOAL_DRAFT_NOTE.includes('predicates'),
    JSON.stringify(long),
  );
  check('文件名只含轮次 id 前 8 位', goalDraftFilename(tid(1)) === 'goal-draft-00000000.json');
  check(
    '转人工原因：取这一轮最后一条；别的轮次、没有 turnId、类型不认识、没有记录都是 null',
    handoffKindOfTurn([{ kind: 'request', turnId: 'x' }, { kind: 'emergency', turnId: 'x' }, { kind: 'agent' }], 'x') === 'emergency' &&
      handoffKindOfTurn([{ kind: 'request', turnId: 'x' }], 'y') === null &&
      handoffKindOfTurn([{ kind: 'agent' }], 'x') === null &&
      handoffKindOfTurn([{ kind: 'bogus', turnId: 'x' }], 'x') === null &&
      handoffKindOfTurn(undefined, 'x') === null,
  );
}

// ---------------- 第二段：接口（PGlite 上的 db 会话存储，走 server.ts） ----------------
{
  const t = await openTestDb();
  await installSeededConfig(t); // 建 demo 租户、导入 data/、装成 DB 配置源；之后这条连接是 agent_app
  const accounts = await withoutTenantScope(() => import('../auth/accounts.js'));
  const authSession = await withoutTenantScope(() => import('../auth/session.js'));
  const roles = ['owner', 'admin', 'supervisor', 'agent', 'viewer'] as const;
  type RoleName = (typeof roles)[number];
  for (const role of roles) {
    await t.pg.exec('SET ROLE agent_platform');
    try {
      const r = await accounts.createUser(t.db, {
        tenantSlug: 'demo',
        email: `${role}-traces@example.com`,
        name: `${role}成员`,
        role,
        password: async () => `${role}-traces-password`,
      });
      assert.equal(r.code, 0, r.message);
    } finally {
      await t.pg.exec('SET ROLE agent_app');
    }
  }
  const fx = await installPgSessionStore(t, { varDir: process.env.VAR_DIR! });
  const store = await withoutTenantScope(() => import('../store.js'));
  await store.initSessionStore(fx.deps);
  const { app } = await withoutTenantScope(() => import('../server.js'));
  const { validateGoal, loadGoals } = await import('../../eval/sim/goals.js');
  const { describeAudit } = await import('../shared/audit-text.js');
  const { packById } = await import('../packs/registry.js');
  check('装配：会话存储是 db', store.sessionStoreMode() === 'db');

  interface W {
    token: string;
    csrf: string;
  }
  let ipN = 0;
  const login = async (role: RoleName): Promise<W> => {
    ipN += 1;
    const body = JSON.stringify({ email: `${role}-traces@example.com`, password: `${role}-traces-password` });
    const res = await app.request('/api/console/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-forwarded-for': `203.0.113.${100 + ipN}`,
      },
      body,
    });
    const me = (await res.json()) as { csrf: string };
    const token = new RegExp(`^${authSession.SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    return { token, csrf: me.csrf };
  };
  const who = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await login(r)] as const))) as Record<RoleName, W>;
  interface Res {
    status: number;
    body: Record<string, any>;
    text: string;
    headers: Headers;
  }
  const get = async (url: string, as: W | null, extra: Record<string, string> = {}): Promise<Res> => {
    const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.250', ...extra };
    if (as) headers.cookie = `${authSession.SESSION_COOKIE}=${as.token}`;
    const res = await app.request(`/api/console${url}`, { headers });
    const text = await res.text();
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      /* 不是 JSON */
    }
    return { status: res.status, body, text, headers: res.headers };
  };
  const su = <R>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  const enc = encodeURIComponent;

  // ---- 造数据：会话 S1（企微）三轮：回复、转人工（投诉）、沉默；会话 S2（模拟器）一轮 ----
  const S1 = 'wecom:wmTrHttp1';
  const S2 = 'wecom:wmTrHttp2';
  const T = { t1: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID() };
  const PHONE = '13812345678';
  const IDCARD = '110101199003071234';
  const PASSPORT = 'E12345678';
  const s1 = store.getOrCreateSession(S1, 'wecom');
  s1.messages.push({ role: 'customer', content: `我想去西藏，电话 ${PHONE}，身份证 ${IDCARD}`, at: Date.now() });
  const reply1 = { role: 'agent' as const, content: '西藏这条每人 12,800 元起。', at: Date.now() };
  s1.messages.push(reply1);
  store.linkTurn(reply1, T.t1);
  s1.messages.push({ role: 'system', content: '系统备注一条', at: Date.now() });
  s1.messages.push({ role: 'customer', content: `你们太慢了，我要投诉。护照 ${PASSPORT}`, at: Date.now() });
  const reply2 = { role: 'agent' as const, content: '很抱歉，已为您转接顾问。', at: Date.now() };
  s1.messages.push(reply2);
  store.linkTurn(reply2, T.t2);
  s1.messages.push({ role: 'customer', content: '好的', at: Date.now() });
  s1.handoffLog = [{ kind: 'complaint', at: Date.parse('2026-09-21T10:00:00Z'), turnId: T.t2 }];
  // 一张在第 2 轮之前就付了款的订单、一张第 2 轮之后才建的单：初始状态只带前者
  const orderBefore = store.createOrder({
    sessionId: S1,
    routeId: 'r-tibet',
    routeTitle: '西藏',
    travelers: 2,
    departDate: '2026-12-10',
    totalPrice: 25600,
  });
  orderBefore.createdAt = Date.parse('2026-09-19T00:00:00Z');
  orderBefore.status = 'paid';
  orderBefore.paidAt = Date.parse('2026-09-20T12:00:00Z');
  const orderAfter = store.createOrder({
    sessionId: S1,
    routeId: 'r-yunnan',
    routeTitle: '云南',
    travelers: 3,
    departDate: '2026-12-20',
    totalPrice: 30000,
  });
  orderAfter.createdAt = Date.parse('2026-09-22T00:00:00Z');
  s1.orderIds.push(orderBefore.id, orderAfter.id);
  store.saveSession(s1);
  const s2 = store.getOrCreateSession(S2, 'simulator');
  s2.messages.push({ role: 'customer', content: '在吗', at: Date.now() });
  const reply4 = { role: 'agent' as const, content: '在的，请问想去哪里？', at: Date.now() };
  s2.messages.push(reply4);
  store.linkTurn(reply4, T.t4);
  store.saveSession(s2);
  const trace = (id: string, conv: string, started: string, over: Record<string, unknown>) => ({
    id,
    conversationId: conv,
    startedAt: new Date(started),
    durationMs: 1200,
    outcome: 'replied' as const,
    sopVersion: 3,
    prefixHash: 'b'.repeat(64),
    catalogVersions: {},
    stageBefore: 'greeting',
    stageAfter: 'quote',
    draft: '模型原稿',
    finalText: '最终回复',
    calls: [
      { name: 'search_routes', prefetch: true },
      { name: 'create_quote', prefetch: false },
      { name: 'search_routes', prefetch: false },
    ],
    llm: [],
    signals: null,
    ...over,
  });
  const shape = (overLimit: boolean) => ({
    class: 'plain' as const,
    lines: 5,
    chars: 120,
    limit: 3,
    trimmed: 1,
    overLimit,
    rewrite: 'off' as const,
    rewriteMs: null,
  });
  store.queueTelemetry(S1, {
    traces: [
      trace(T.t1, S1, '2026-09-20T10:00:00Z', {
        finalText: `${reply1.content} 联系 ${PHONE}`,
        guardVerdicts: [
          { id: 'pre_clean', action: 'pass' },
          { id: 'price', action: 'drop_sentence' },
        ],
        replyShape: shape(false),
      }),
      trace(T.t2, S1, '2026-09-21T10:00:00Z', {
        outcome: 'handoff',
        stageBefore: 'quote',
        stageAfter: 'handoff',
        durationMs: 800,
        guardVerdicts: [
          { id: 'claim_words', action: 'replace' },
          { id: 'identity', action: 'append' },
        ],
        replyShape: shape(true),
      }),
      trace(T.t3, S1, '2026-09-21T11:00:00Z', {
        outcome: 'silent',
        stageBefore: 'handoff',
        stageAfter: 'handoff',
        finalText: null,
        calls: [],
        guardVerdicts: null,
        replyShape: null,
      }),
    ],
  });
  store.queueTelemetry(S2, {
    traces: [trace(T.t4, S2, '2026-09-22T09:00:00Z', { guardVerdicts: [{ id: 'shape_check', action: 'pass' }], replyShape: shape(false) })],
  });
  await store.flushSession(S1);
  await store.flushSession(S2);
  const rowIds = (r: Res): string[] => (r.body.items as { turnId: string }[]).map((x) => x.turnId);
  const idx = (id: string): string => (Object.entries(T).find(([, v]) => v === id) ?? ['?'])[0]!;
  const names = (r: Res): string[] => rowIds(r).map(idx);

  // ---- 权限：三个接口，所有者、管理员能过，主管、坐席、只读 403，匿名 401 ----
  {
    const urls = ['/traces', `/conversations/${enc(S1)}/turns/${T.t1}`, `/conversations/${enc(S1)}/turns/${T.t1}/goal-draft`];
    const cells: string[] = [];
    for (const url of urls) {
      for (const role of roles) {
        const r = await get(url, who[role]);
        const want = role === 'owner' || role === 'admin';
        if (want ? r.status !== 200 : !(r.status === 403 && r.body.error === 'forbidden')) cells.push(`${url} ${role} → ${r.status}`);
      }
      const anon = await get(url, null);
      if (anon.status !== 401) cells.push(`${url} 匿名 → ${anon.status}`);
    }
    check(
      '权限：/traces、trace 详情、goal-draft 三个接口，所有者与管理员 200，主管、坐席、只读 403 forbidden，匿名 401',
      cells.length === 0,
      cells.join(' | '),
    );
    const denied = await get('/traces?outcome=bogus', who.agent);
    check('权限先于参数校验：坐席带着不合规的参数也是 403', denied.status === 403, String(denied.status));
  }
  const auditRows = () =>
    su<{ action: string; target_type: string; target_id: string; diff: Record<string, unknown>; actor_user_id: string | null }>(
      `select action, target_type, target_id, diff, actor_user_id from audit_log where action = 'trace.export' order by id`,
    );
  // 上面主管等被拒的请求不留审计；所有者与管理员那两次 200 的 goal-draft 各留一行
  const afterPerm = await auditRows();
  check('审计：被拒的 goal-draft 不写审计，成功的两次（所有者、管理员）各一行', afterPerm.length === 2, String(afterPerm.length));

  // ---- 列表 ----
  const full = await get('/traces', who.owner);
  check(
    '列表：200，按开始时间倒序（第 4、3、2、1 轮），没有下一页',
    full.status === 200 && JSON.stringify(names(full)) === '["t4","t3","t2","t1"]' && full.body.next === null,
    full.text.slice(0, 300),
  );
  const row = (id: string) => (full.body.items as Record<string, any>[]).find((x) => x.turnId === id)!;
  check(
    '列表：一行的字段（会话 id、渠道、开始时刻、耗时、结果、触发的护栏、转人工原因、超长）',
    JSON.stringify(row(T.t2)) ===
      JSON.stringify({
        turnId: T.t2,
        conversationId: S1,
        channel: 'wecom',
        startedAt: '2026-09-21T10:00:00.000Z',
        durationMs: 800,
        outcome: 'handoff',
        guards: ['claim_words', 'identity'],
        handoffKind: 'complaint',
        overLimit: true,
      }),
    JSON.stringify(row(T.t2)),
  );
  check(
    '列表：回复轮没触发护栏（pass 不算）、没转人工；沉默轮护栏为空；模拟器渠道',
    JSON.stringify([
      row(T.t4).guards,
      row(T.t4).handoffKind,
      row(T.t4).channel,
      row(T.t3).guards,
      row(T.t3).overLimit,
      row(T.t1).guards,
    ]) === JSON.stringify([[], null, 'simulator', [], false, ['price']]),
    JSON.stringify([row(T.t4), row(T.t3)]),
  );
  const nameOf = async (q: string): Promise<string[]> => names(await get(`/traces?${q}`, who.admin));
  check(
    '筛选 outcome=handoff / replied / silent',
    JSON.stringify([await nameOf('outcome=handoff'), await nameOf('outcome=replied'), await nameOf('outcome=silent')]) ===
      '[["t2"],["t4","t1"],["t3"]]',
  );
  check(
    '筛选 guard=price / identity / shape_check（只有 pass 不算）',
    JSON.stringify([await nameOf('guard=price'), await nameOf('guard=identity'), await nameOf('guard=shape_check')]) ===
      '[["t1"],["t2"],[]]',
  );
  check(
    '筛选 handoffKind=complaint / request',
    JSON.stringify([await nameOf('handoffKind=complaint'), await nameOf('handoffKind=request')]) === '[["t2"],[]]',
  );
  check('筛选 overLimit=1', JSON.stringify(await nameOf('overLimit=1')) === '["t2"]');
  check(
    '筛选时间段：since 含、until 不含，带时区',
    JSON.stringify([
      await nameOf(`since=${enc('2026-09-21T10:00:00Z')}&until=${enc('2026-09-22T09:00:00Z')}`),
      await nameOf(`since=${enc('2026-09-21T18:00:00+08:00')}`),
      await nameOf(`since=${enc('2027-01-01T00:00:00Z')}`),
    ]) === '[["t3","t2"],["t4","t3","t2"],[]]',
  );
  check(
    '组合筛选：outcome=handoff&overLimit=1&guard=claim_words',
    JSON.stringify(await nameOf('outcome=handoff&overLimit=1&guard=claim_words')) === '["t2"]',
  );
  {
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    for (; pages < 6; pages += 1) {
      const page = await get(`/traces?limit=1${before ? `&before=${enc(before)}` : ''}`, who.owner);
      seen.push(...names(page));
      if (page.body.next === null) break;
      before = page.body.next as string;
    }
    check(
      '游标翻页（limit=1）：4 页走完，顺序与全量相同',
      JSON.stringify(seen) === '["t4","t3","t2","t1"]' && pages === 3,
      `${seen.join()} 页 ${pages}`,
    );
  }
  {
    const bad: string[] = [];
    for (const q of [
      'outcome=bogus',
      'handoffKind=bogus',
      'guard=BAD',
      'guard=',
      'overLimit=0',
      'overLimit=true',
      'before=garbage',
      'limit=0',
      'limit=101',
      'since=yesterday',
      'until=2026-09-21',
      `before=${enc('2026-09-21T10:00:00.123Z_x')}`,
    ]) {
      const r = await get(`/traces?${q}`, who.owner);
      if (!(r.status === 400 && r.body.error === 'bad_request')) bad.push(`${q} → ${r.status}`);
    }
    check('不合规的查询参数 → 400 bad_request', bad.length === 0, bad.join(' | '));
  }

  // ---- 详情补的四项 ----
  {
    const d1 = await get(`/conversations/${enc(S1)}/turns/${T.t1}`, who.owner);
    const d2 = await get(`/conversations/${enc(S1)}/turns/${T.t2.toUpperCase()}`, who.admin);
    const d3 = await get(`/conversations/${enc(S1)}/turns/${T.t3}`, who.owner);
    check(
      '详情：guardVerdicts、replyShape、handoffKind、客户原话；客户原话是这一轮回复之前最近的客户消息，不打码',
      d1.status === 200 &&
        JSON.stringify(d1.body.guardVerdicts) ===
          JSON.stringify([
            { id: 'pre_clean', action: 'pass' },
            { id: 'price', action: 'drop_sentence' },
          ]) &&
        d1.body.replyShape?.overLimit === false &&
        d1.body.handoffKind === null &&
        d1.body.customerText === `我想去西藏，电话 ${PHONE}，身份证 ${IDCARD}` &&
        d1.body.draft === '模型原稿' &&
        d1.body.durationMs === 1200,
      d1.text.slice(0, 400),
    );
    check(
      '详情：转人工的那一轮有 handoffKind（路径里的轮次 id 写大写也对得上）、客户原话是投诉那句',
      d2.status === 200 &&
        d2.body.handoffKind === 'complaint' &&
        d2.body.customerText === `你们太慢了，我要投诉。护照 ${PASSPORT}` &&
        d2.body.replyShape?.overLimit === true,
      d2.text.slice(0, 300),
    );
    check(
      '详情：沉默的一轮没有回复，客户原话、护栏、形状都是 null',
      d3.status === 200 &&
        d3.body.customerText === null &&
        d3.body.guardVerdicts === null &&
        d3.body.replyShape === null &&
        d3.body.handoffKind === null,
      d3.text.slice(0, 300),
    );
    const cross = await get(`/conversations/${enc(S1)}/turns/${T.t4}`, who.owner);
    const nosuch = await get(`/conversations/${enc(S1)}/turns/${randomUUID()}`, who.owner);
    check('详情：别的会话的轮次、不存在的轮次都是 404', cross.status === 404 && nosuch.status === 404, `${cross.status} ${nosuch.status}`);
  }

  // ---- 「存为回归用例」 ----
  const goalsDir = path.join(process.cwd(), 'eval', 'sim', 'goals');
  const listing = (): string =>
    JSON.stringify([fs.readdirSync(goalsDir).toSorted(), fs.readdirSync(path.join(goalsDir, 'quality')).toSorted()]);
  const listingBefore = listing();
  const varFilesBefore = fs
    .readdirSync(process.env.VAR_DIR!)
    .filter((f) => !f.startsWith('goals-'))
    .toSorted()
    .join();
  const dl = await get(`/conversations/${enc(S1)}/turns/${T.t2}/goal-draft`, who.owner);
  check(
    '下载：200、附件、文件名只含轮次 id 前 8 位、JSON、不缓存',
    dl.status === 200 &&
      dl.headers.get('content-disposition') === `attachment; filename="goal-draft-${T.t2.slice(0, 8)}.json"` &&
      (dl.headers.get('content-type') ?? '').startsWith('application/json') &&
      dl.headers.get('cache-control') === 'no-store' &&
      !dl.headers.get('content-disposition')!.includes('wmTr'),
    JSON.stringify([...dl.headers.entries()]),
  );
  const draft = dl.body;
  check(
    '草稿：tags 是 regression、predicates 空、persona 空、id 带轮次前缀',
    JSON.stringify(draft.tags) === '["regression"]' &&
      JSON.stringify(draft.predicates) === '[]' &&
      draft.persona === '' &&
      draft.id === `draft-${T.t2.slice(0, 8)}`,
    dl.text.slice(0, 300),
  );
  check(
    '草稿：customerScript 是这一轮的客户原话（号码已打码）',
    JSON.stringify(draft.customerScript) === JSON.stringify(['你们太慢了，我要投诉。护照 E****5678']),
    JSON.stringify(draft.customerScript),
  );
  check(
    '草稿：initial 取这一轮之前的阶段、订单（只带第 2 轮之前就有的那张、按当时的状态）、之前的消息（不含 system、号码已打码）',
    draft.initial?.stage === 'quote' &&
      JSON.stringify(draft.initial?.orders) ===
        JSON.stringify([{ routeId: 'r-tibet', travelers: 2, departDate: '2026-12-10', status: 'paid' }]) &&
      JSON.stringify(draft.initial?.history) ===
        JSON.stringify([
          { role: 'customer', content: '我想去西藏，电话 *******5678，身份证 **************1234' },
          { role: 'ai', content: '西藏这条每人 12,800 元起。' },
        ]),
    JSON.stringify(draft.initial),
  );
  check(
    '草稿：allowedTools 取这一轮调过的工具（去重）',
    JSON.stringify(draft.allowedTools) === '["search_routes","create_quote"]',
    JSON.stringify(draft.allowedTools),
  );
  check(
    '草稿：_draft 放 trace 摘要（轮次、结果、阶段、转人工原因、触发的护栏、形状、回复）',
    draft._draft?.turnId === T.t2 &&
      draft._draft.outcome === 'handoff' &&
      draft._draft.stageBefore === 'quote' &&
      draft._draft.handoffKind === 'complaint' &&
      JSON.stringify(draft._draft.guards) ===
        JSON.stringify([
          { id: 'claim_words', action: 'replace' },
          { id: 'identity', action: 'append' },
        ]) &&
      draft._draft.replyShape?.overLimit === true &&
      typeof draft._draft.note === 'string' &&
      draft._draft.note.includes('_draft'),
    JSON.stringify(draft._draft),
  );
  check(
    '草稿全文里没有未打码的号码、证件号、护照号，也没有会话 id',
    ![PHONE, IDCARD, PASSPORT, 'wmTrHttp'].some((x) => dl.text.includes(x)),
    dl.text.slice(0, 600),
  );
  const dl1 = await get(`/conversations/${enc(S1)}/turns/${T.t1}/goal-draft`, who.admin);
  check(
    '另一轮的草稿：回复里的手机号也打码（_draft.reply）',
    dl1.status === 200 && dl1.body._draft?.reply?.includes('*******5678') && !dl1.text.includes(PHONE),
    dl1.text.slice(0, 400),
  );
  // 原样交给 eval/sim/goals.ts 的校验必失败，错误点名 _draft 与空谓词
  const message = (fn: () => unknown): string => {
    try {
      fn();
      return '';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const failed = message(() => validateGoal(JSON.parse(dl.text), 'draft.json'));
  check('原样交给 validateGoal：失败，错误点名 _draft 与 predicates', failed.includes('_draft') && failed.includes('predicates'), failed);
  const dir = fs.mkdtempSync(path.join(process.env.VAR_DIR!, 'goals-'));
  fs.writeFileSync(path.join(dir, 'draft.json'), dl.text);
  const loadFailed = await loadGoals(dir).then(
    () => '',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  check(
    '原样放进目标目录交给 loadGoals（pnpm test 读目标的那条路）：失败，错误点名 _draft 与 predicates',
    loadFailed.includes('_draft') && loadFailed.includes('predicates'),
    loadFailed,
  );
  // 草稿的形状与目标 schema 对得上：只改这几处就过校验（改写 customerScript、写 persona 与谓词、删 _draft）
  {
    const { _draft: _dropped, ...rest } = JSON.parse(dl.text) as Record<string, unknown>;
    const finished = {
      ...rest,
      persona: '合成客户，想投诉进度太慢',
      customerScript: ['合成的话：你们回得太慢了'],
      predicates: [{ kind: 'handoff', expected: true }],
    };
    const ok = message(() => validateGoal(finished, 'finished.json'));
    check('只补 persona、谓词、改写客户原话、删 _draft 之后过 validateGoal（形状与目标 schema 对得上，含 initial）', ok === '', ok);
    const onlyDraft = message(() => validateGoal({ ...finished, _draft: {} }, 'x.json'));
    check('只多一个 _draft 也过不了', onlyDraft.includes('_draft'), onlyDraft);
    const onlyPredicates = message(() => validateGoal({ ...finished, predicates: [] }, 'x.json'));
    check('只缺谓词也过不了', onlyPredicates.includes('predicates'), onlyPredicates);
  }
  const varFiles = (): string =>
    fs
      .readdirSync(process.env.VAR_DIR!)
      .filter((f) => !f.startsWith('goals-'))
      .toSorted()
      .join();
  check(
    '不落盘、不进仓库：目标目录的文件不变，VAR_DIR 里也没有多出草稿文件',
    listing() === listingBefore && varFiles() === varFilesBefore,
    listing(),
  );

  // ---- 审计 ----
  const refs = await su<{ id: string; ref: string }>(`select id, ref from conversations where id = $1`, [S1]);
  const audits = await auditRows();
  const mine = audits.filter((a) => a.diff.turnId === T.t2 || a.diff.turnId === T.t1);
  check(
    '审计：每次下载一行 trace.export，target 是会话行的 ref（不含客户标识），diff 带短码与轮次 id',
    audits.length === 4 &&
      audits.every(
        (a) =>
          a.target_type === 'conversation' &&
          a.target_id === refs[0]!.ref &&
          typeof a.diff.shortId === 'string' &&
          !JSON.stringify(a).includes('wmTrHttp') &&
          !JSON.stringify(a).includes(PHONE),
      ) &&
      mine.length === 4,
    JSON.stringify(audits),
  );
  const dlAudit = await get('/audit?actions=trace.export&limit=10', who.owner);
  const entry = (dlAudit.body.items as Record<string, any>[])[0]!;
  check(
    '审计页能读到：/audit 按 trace.export 过滤',
    dlAudit.status === 200 && dlAudit.body.items.length === 4 && entry.action === 'trace.export' && entry.actorName === 'admin成员',
    dlAudit.text.slice(0, 300),
  );
  const sentence = describeAudit(entry as import('../shared/console-api.js').AuditEntryView, packById('travel')!);
  check(
    '审计句子：操作者下载了会话X的回归用例草稿，分在「会话与订单」',
    /^admin成员 下载了会话\w+的回归用例草稿$/.test(sentence.text) && sentence.group === 'conversation',
    sentence.text,
  );
  const before404 = (await auditRows()).length;
  const bad = [
    await get(`/conversations/${enc(S1)}/turns/${T.t4}/goal-draft`, who.owner), // 别的会话的轮次
    await get(`/conversations/${enc(S1)}/turns/${randomUUID()}/goal-draft`, who.owner),
    await get(`/conversations/${enc(S1)}/turns/not-a-uuid/goal-draft`, who.owner),
    await get(`/conversations/${enc('sim-visitor1')}/turns/${T.t1}/goal-draft`, who.owner),
    await get(`/conversations/${enc('wecom:cust_seed1')}/turns/${T.t1}/goal-draft`, who.owner),
  ];
  check(
    '不存在的轮次、别的会话的轮次、不是 uuid、sim- 访客会话、种子会话：404，不写审计、不给文件',
    bad.every((r) => r.status === 404) && (await auditRows()).length === before404,
    bad.map((r) => `${r.status} ${r.body.error}`).join(' | '),
  );
  // 草稿下载一个沉默的轮次：没有客户原话，customerScript 为空，照样给出草稿
  const silent = await get(`/conversations/${enc(S1)}/turns/${T.t3}/goal-draft`, who.owner);
  check(
    '沉默的一轮：草稿的 customerScript 为空数组、没有 initial.history，仍过不了校验，也写一行审计',
    silent.status === 200 &&
      (await auditRows()).length === 5 &&
      JSON.stringify(silent.body.customerScript) === '[]' &&
      silent.body.initial?.history === undefined &&
      message(() => validateGoal(silent.body, 's.json')).includes('_draft'),
    silent.text.slice(0, 300),
  );

  // 会留审计、给文件的 GET：别的网站把已登录的管理员导航过来（Sec-Fetch-Site: cross-site）不给，也不留审计
  {
    const url = `/conversations/${enc(S1)}/turns/${T.t2}/goal-draft`;
    const before = (await auditRows()).length;
    const cross = await get(url, who.owner, { 'sec-fetch-site': 'cross-site' });
    const sameSite = await get(url, who.owner, { 'sec-fetch-site': 'same-site' });
    const afterBlocked = (await auditRows()).length;
    const sameOrigin = await get(url, who.owner, { 'sec-fetch-site': 'same-origin' });
    const typed = await get(url, who.owner, { 'sec-fetch-site': 'none' });
    check(
      '跨站导航（cross-site、same-site）→ 403 cross_site，不留审计；同源和地址栏直接打开（none）照常给',
      cross.status === 403 &&
        cross.body.error === 'cross_site' &&
        sameSite.status === 403 &&
        afterBlocked === before &&
        sameOrigin.status === 200 &&
        typed.status === 200 &&
        (await auditRows()).length === before + 2,
      [cross.status, sameSite.status, sameOrigin.status, typed.status].join(),
    );
  }

  // ---- 页面状态依赖的接口行为：空结果 ----
  const empty = await get(`/traces?since=${enc('2027-06-01T00:00:00Z')}`, who.owner);
  check(
    '空结果：200、items 为空、next 为 null（页面显示「这段时间没有 AI 记录」）',
    empty.status === 200 && empty.text === '{"items":[],"next":null}',
    empty.text,
  );

  await t.close();
}

if (fails.length) {
  console.error(`TRACES SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(`TRACES SELFTEST PASS: ${pass} 项断言全通${realPgRan ? '（含真实 PG）' : '；真实 PG 部分未跑'}`);
process.exit(0);
