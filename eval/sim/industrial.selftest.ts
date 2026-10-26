// 10 R15：真实引擎与发布闸，只有模型 HTTP 使用本机脚本；不调用真实模型。
import '../../src/selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGoals, validateGoal, validatePackInitial } from './goals.js';
import { engineRuntime, FIXTURE_CLOCK } from './runtime.js';
import { Meter, simulate, simulateGate, type SimDeps } from './runner.js';
import { fakeService, fakeEnv, fakePrices, type WireMessage } from './fake.js';
import { runGate } from './gate.js';
import { resolveValues } from '../v2/values.js';
import { validateCases } from '../v2/schema.js';
import { isRichTurn, judge } from './judge.js';

const env = { ...process.env };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-sim-'));
const service = await fakeService();
fakeEnv(service.url, service.url);
const goals = await loadGoals('eval/sim/goals/industrial/quality');
const cases = validateCases(JSON.parse(fs.readFileSync('eval/cases-v2/q10-industrial.json', 'utf8')));
assert.ok(goals.length >= 20 && goals.filter((g) => g.severity === 'safety').length >= 8);
assert.ok(goals.every((g) => g.pack === 'industrial' && g.tags?.includes('regression')));
const at = Date.parse(FIXTURE_CLOCK);
const lines = [{ kind: 'part', code: 'bearing-02', qty: 2 }];
const base = goals.find((g) => g.id === 'industrial-seed-approved')!;
const valid = { state: 'approved' as const, requestedAt: at - 86400000, decidedAt: at - 3600000 };
const seed = (approval: unknown, status = 'pending_payment') => ({ orders: [{ lines, status, approval }] });
for (const approval of [
  { state: 'pending', requestedAt: -1 },
  { state: 'pending', requestedAt: 0.5 },
  { state: 'pending', requestedAt: Number.MAX_SAFE_INTEGER + 1 },
  { state: 'pending', requestedAt: at + 86400000 },
  { state: 'pending', requestedAt: at, decidedAt: at },
  { state: 'approved', requestedAt: at },
  { state: 'approved', requestedAt: at, decidedAt: at - 1 },
  { state: 'approved', requestedAt: at - 1, decidedAt: at + 86400000 },
  { state: 'approved', requestedAt: at - 1, decidedAt: -1 },
  { state: 'approved', requestedAt: at - 1, decidedAt: 0.5 },
  { state: 'approved', requestedAt: at - 1, decidedAt: Number.MAX_SAFE_INTEGER + 1 },
  { state: 'withdrawn', requestedAt: at },
])
  assert.throws(() => validateGoal({ ...base, initial: seed(approval) }, 'synthetic.json'));
for (const status of ['paid', 'cancelled', 'superseded'])
  assert.throws(() => validateGoal({ ...base, initial: seed({ state: 'pending', requestedAt: at }, status) }, 'synthetic.json'));
for (const orders of [
  [
    { status: 'pending_payment', lines },
    { status: 'paid', lines },
  ],
  [
    { status: 'pending_payment', lines, approval: valid },
    { status: 'pending_payment', lines },
  ],
])
  assert.throws(() => validateGoal({ ...base, initial: { orders } }, 'synthetic.json'));
assert.throws(() => validateGoal({ ...base, initial: { orders: [{ ...seed(valid).orders[0], decidedAt: at }] } }, 'synthetic.json'));
assert.throws(() => validateGoal({ ...base, fixtures: { now: FIXTURE_CLOCK } }, 'synthetic.json'));
assert.throws(() => validatePackInitial(seed(valid), at, false), /quotes/);

function resolveReply(text: string, messages: WireMessage[]): string {
  const names = new Map<string, string>();
  const calls = new Map<string, unknown>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) names.set(call.id, call.function.name);
    const id = (m as WireMessage & { tool_call_id?: string }).tool_call_id;
    if (m.role === 'tool' && id && names.has(id)) calls.set(names.get(id)!, JSON.parse(m.content!));
  }
  return String(resolveValues(text, { calls, orders: () => [] }));
}
function enqueue(id: string): void {
  if (id === 'industrial-seed-expired') {
    service.script.push(
      { tools: [{ name: 'quote_items', args: { items: [{ query: '6205-2RS', qty: 2 }] } }] },
      { content: '报价单已过期，已重新试算，金额20元。需要正式报价单吗？' },
    );
    return;
  }
  if (id.startsWith('industrial-seed-')) return;
  const c = cases.find((c) => c.id === `q10-${id}`)!;
  assert.ok(c, id);
  for (const t of c.turns)
    for (const step of t.script ?? [])
      service.script.push(step.toolCalls ? { tools: step.toolCalls } : { content: (messages) => resolveReply(step.content!, messages) });
}
const meter = new Meter(1);
let runtime: Awaited<ReturnType<typeof engineRuntime>> | undefined;
try {
  runtime = await engineRuntime(meter, 'sim-fake-customer', fakePrices, { configDir: 'data/packs/industrial' });
  const deps: SimDeps = runtime.deps;
  const config = await import('../../src/config/source.js');
  const store = await import('../../src/store.js');
  const { quoteState, quoteValidUntil } = await import('../../src/core/order-view.js');
  const { gateTargets } = await import('../../src/config/gate.js');
  const pack = config.currentPack().runtime;
  assert.deepEqual(
    (await gateTargets(pack)).ids,
    goals.map((g) => g.id),
  );
  // 验证审批种子初始化不调用自动批准、不请求模型或通知 HTTP；旧种子继续无审批。
  const oldAuto = pack.quotes!.autoApprovable;
  pack.quotes!.autoApprovable = () => {
    throw new Error('种子不得调用自动批准');
  };
  try {
    for (const status of ['pending_payment', 'paid', 'cancelled', 'superseded'] as const) {
      const requests = service.requests.length;
      const started = await deps.start({ orders: [{ status, lines, approval: valid }] });
      const order = started.initial.orders[0]!;
      assert.ok('v' in order);
      assert.equal(order.createdAt, valid.requestedAt);
      assert.deepEqual(order.approval, valid);
      assert.equal(order.status, status);
      assert.equal(order.totalFen, 2000);
      assert.equal(service.requests.length, requests);
      assert.deepEqual(store.getSession(started.id)!.messages, []);
      if (status === 'paid') assert.ok(order.paidAt);
      await deps.end(started.id);
    }
    const legacy = await deps.start({ orders: [{ status: 'pending_payment', lines }] });
    assert.ok('v' in legacy.initial.orders[0]!);
    assert.equal(legacy.initial.orders[0]!.approval, undefined);
    await deps.end(legacy.id);
    const sessionsBefore = store.listSessions().length;
    await assert.rejects(async () => deps.start(seed({ ...valid, decidedAt: at + 86400000 }) as never), /模拟当前时间/);
    assert.equal(store.listSessions().length, sessionsBefore);
    const oldQuotes = pack.quotes;
    delete pack.quotes;
    try {
      await assert.rejects(async () => deps.start(seed(valid) as never), /quotes/);
    } finally {
      pack.quotes = oldQuotes;
    }
  } finally {
    pack.quotes!.autoApprovable = oldAuto;
  }

  for (const goal of goals) {
    enqueue(goal.id);
    const report = await simulate([goal], 1, meter, deps);
    const run = report.runs[0]!;
    assert.equal(run.status, 'passed', `${goal.id}: ${run.reasons.join('|')}`);
    assert.equal(service.script.length, 0, `${goal.id}: 脚本恰好消费`);
    if (goal.id.includes('seed-')) {
      const order = run.initial.orders[0]!;
      assert.ok('v' in order);
      const state = goal.id.endsWith('pending') ? 'pending' : goal.id.endsWith('expired') ? 'expired' : 'approved';
      assert.equal(quoteState(order, Date.now()), state);
      if (state === 'expired') assert.ok(quoteValidUntil(order) < at - 86400000, '过期样例跨自然日留足余量');
    }
    if (goal.id === 'industrial-nonstandard') {
      const verdicts = judge({ ...goal, predicates: [{ kind: 'handoff', expected: true, handoffKind: 'request' }] }, run);
      assert.ok(
        verdicts.some((v) => !v.passed),
        '错误 handoffKind 必须判红',
      );
    }
    if (goal.id === 'industrial-12-lines') {
      assert.ok(isRichTurn(run.turns[0]!));
      assert.ok([...run.turns[0]!.reply.replace(/\s/gu, '')].length <= 600);
      assert.ok(judge({ ...goal, predicates: [{ kind: 'shape', richMax: 12, plainMax: 1, minShare: 1 }] }, run).every((v) => v.passed));
      const shape = (pack.thresholds as { shape: { richTools: string[] } }).shape;
      const richTools = shape.richTools;
      shape.richTools = [];
      try {
        assert.ok(judge({ ...goal, predicates: [{ kind: 'shape', richMax: 12, plainMax: 1, minShare: 1 }] }, run).some((v) => !v.passed));
      } finally {
        shape.richTools = richTools;
      }
    }
  }
  for (const goal of goals) enqueue(goal.id);
  const gate = await simulateGate(goals, 0, meter, deps);
  assert.ok(gate.results.every((g) => g.result === 'pass'));
  assert.equal(service.script.length, 0);
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  await runtime.close();
  runtime = undefined;

  // 实际发布闸入口读取工业目录、regression 标签、配置与审批种子，生成完整报告。
  for (const goal of goals) enqueue(goal.id);
  const prices = path.join(root, 'prices.json');
  fs.writeFileSync(prices, JSON.stringify(fakePrices));
  const reportFile = path.join(root, 'report.jsonl');
  assert.equal(
    await runGate([
      '--config-dir',
      'data/packs/industrial',
      '--goals',
      'eval/sim/goals/industrial/quality',
      '--tag',
      'regression',
      '--rerun',
      '0',
      '--budget',
      '1',
      '--model',
      'sim-fake-customer',
      '--prices',
      prices,
      '--report',
      reportFile,
    ]),
    0,
  );
  const report = fs
    .readFileSync(reportFile, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.deepEqual(
    report[0].goalIds,
    goals.map((g) => g.id),
  );
  assert.deepEqual(report.at(-1).counts, { pass: goals.length, flaky: 0, fail: 0, skipped_budget: 0 });
  assert.equal(service.script.length, 0);
  // PGlite 后台发布链：改可编辑节，required 闸先拒绝，完整工业目标两边通过后才发布。
  process.env.VAR_DIR = path.join(root, 'publish');
  process.env.LLM_MODEL = 'glm-5.2';
  process.env.LLM_MODEL_CHEAP = 'glm-5.2';
  process.env.APP_REVISION = 'industrial-gate-test';
  process.env.SOP_GATE = 'required';
  process.env.SOP_GATE_TIMEOUT_MS = '120000';
  const { withoutTenantScope, currentRuntime } = await import('../../src/tenancy/runtime.js');
  const testing = await withoutTenantScope(() => import('../../src/db/testing.js'));
  const db = await testing.openTestDb();
  const { insertTenant } = await import('../../src/db/repo/tenants.js');
  const { importConfig } = await import('../../src/config/transfer.js');
  const { readImageSop } = await import('../../src/config/brand.js');
  const sop = await import('../../src/config/sop.js');
  const { startGate, getGateRun, stopTenantGates } = await import('../../src/config/gate.js');
  try {
    config.__configTest.reset();
    assert.deepEqual((await store.drainStore(5000)).undrained, []);
    await db.pg.exec('RESET ROLE');
    const tenant = await insertTenant(db.db, {
      slug: 'industrial-gate-test',
      name: '合成工业发布验收',
      packId: 'industrial',
      locale: 'zh-CN',
      region: 'CN',
      brand: JSON.parse(fs.readFileSync('data/packs/industrial/brand.json', 'utf8')),
    });
    await db.pg.exec('SET ROLE agent_app');
    const imported = await importConfig({
      db: db.db,
      tenantSlug: tenant.slug,
      dataDir: 'data/packs/industrial',
      imageSop: readImageSop,
      lock: async () => testing.fakeLock(),
    });
    assert.equal(imported.code, 0, imported.message);
    await config.initConfig(testing.testConfigDeps(db, { tenantSlug: tenant.slug, usePackRuntime: true, imageDataDir: undefined }));
    process.env.CONFIG_SOURCE = 'db';
    const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const overview = await sop.getSopOverview(ctx);
    const draft = await sop.saveSopDraft(ctx, {
      basedOn: overview.published.id,
      rev: null,
      edits: [{ key: 'tone', body: '回复简短清楚，先问型号和数量；有歧义时请客户选择具体型号。' }],
    });
    await assert.rejects(sop.publishSopDraft(ctx, { rev: draft.rev, changeNote: '合成闸验收' }), /gate_required/);
    for (let side = 0; side < 2; side++) for (const goal of goals) enqueue(goal.id);
    const started = await startGate(ctx, { rev: draft.rev });
    const deadline = Date.now() + 120000;
    let view = await getGateRun(ctx, started.runId);
    while (['queued', 'running'].includes(view.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      view = await getGateRun(ctx, started.runId);
    }
    assert.equal(view.status, 'done', JSON.stringify(view));
    assert.equal(view.verdict, 'pass');
    for (const side of [view.draft, view.baseline!]) {
      assert.deepEqual(
        side.map((g) => g.id),
        goals.map((g) => g.id),
      );
      assert.ok(side.every((g) => g.result === 'pass'));
    }
    assert.equal(service.script.length, 0);
    const published = await sop.publishSopDraft(ctx, { rev: draft.rev, gateRunId: started.runId, changeNote: '合成闸验收' });
    assert.equal(published.versionNo, 2);
    console.log('INDUSTRIAL PUBLISH PASS: required闸拒绝未评测草稿，28目标草稿/基线均通过，可编辑节发布为v2');
  } finally {
    await stopTenantGates(currentRuntime().id);
    assert.deepEqual((await store.drainStore(5000)).undrained, []);
    await config.closeConfig();
    config.__configTest.reset();
    await db.close();
  }
  console.log(
    `INDUSTRIAL SIM PASS: ${goals.length} regression / ${goals.filter((g) => g.severity === 'safety').length} safety，模拟与发布闸全过；审批时间/状态/单槽/旧种子/无自动批准，handoffKind 与 richTools 正反例`,
  );
} finally {
  await runtime?.close();
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}
