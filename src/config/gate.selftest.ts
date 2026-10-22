// 07 第 13 步：假模型经真实 gate.ts 子进程，PGlite / PG 同一套发布与恢复边界。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openTestDb, createRealPgFixture, testConfigDeps, fakeLock } from '../db/testing.js';
import { openDb, withTenant, isUniqueViolation, type Db, type TenantCtx } from '../db/client.js';
import { insertGate, readGate } from '../db/repo/gate.js';
import { authSessionCreate } from '../db/repo/auth.js';
import { csrfFor, SESSION_COOKIE } from '../auth/session.js';
import {
  hostRuntime,
  currentRuntime,
  withTenantScope,
  createTenantRuntime,
  registerRuntime,
  unregisterRuntime,
  cancelTenantRuntime,
  tenantRuntimes,
} from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';
import { tenantKeys, dropTenantState } from '../tenancy/state.js';
import { fakeService } from '../../eval/sim/fake.js';
import { fixtureClock } from '../../eval/sim/runtime.js';
import { sectionBody, TRAVEL_SOP_SECTIONS } from '../sop/sections.js';
import { importConfig } from './transfer.js';
import * as config from './source.js';
import * as sop from './sop.js';
import { startGate, getGateRun, gateVerdict, gateEnvironment, stopTenantGates, GateSkippedError, __gateTest } from './gate.js';
import { consoleApi, __consoleTest } from '../console-api/app.js';
import type { GateGoalResult, GateRunView, Role } from '../shared/console-api.js';

enterTenantScopeForTest(hostRuntime());
const env = { ...process.env };
const restoreClock = fixtureClock();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-server-test-'));
process.env.VAR_DIR = path.join(root, 'state');
process.env.CONFIG_SOURCE = 'file';
process.env.SOP_GATE = 'off';
process.env.LLM_MOCK = '0';
process.env.LLM_PROVIDER = '';
process.env.LLM_MODEL = 'glm-5.2';
process.env.LLM_MODEL_CHEAP = 'glm-5.2';
process.env.LLM_HEDGE_MODEL = '';
process.env.LLM_MAX_RETRY = '0';
process.env.SOP_GATE_DAILY_RUNS = '100';
process.env.SOP_GATE_TIMEOUT_MS = '60000';
process.env.APP_REVISION = 'gate-selftest';
const goalsDir = path.join(root, 'goals');
fs.mkdirSync(goalsDir);
fs.writeFileSync(
  path.join(goalsDir, '01-regression.json'),
  JSON.stringify({
    id: 'gate-regression',
    persona: '仅咨询',
    maxTurns: 1,
    tags: ['regression'],
    customerScript: ['你好'],
    allowedTools: ['search_routes'],
    forbidden: [],
    predicates: [{ kind: 'reply_matches', pattern: '想去哪里', scope: 'any' }],
  }),
);
__gateTest.goalsDir = goalsDir;
let checks = 0;
function check(name: string, value: unknown): void {
  assert.ok(value, name);
  checks++;
}
const md = fs.readFileSync('data/sop.md', 'utf8');
const baseGoal = (result: GateGoalResult['result'], tags = ['regression']): GateGoalResult => ({ id: 'g', tags, attempts: [], result });
check('只有 regression 退化能拦', gateVerdict([baseGoal('fail', [])], [baseGoal('pass')]).verdict === 'pass');
check('已知失败不拦', gateVerdict([baseGoal('fail')], [baseGoal('fail')]).verdict === 'pass');
check('重跑/协议不稳不拦', gateVerdict([baseGoal('flaky')], [baseGoal('pass')]).verdict === 'pass');
check('相对基线退化拦', gateVerdict([baseGoal('fail')], [baseGoal('pass')]).blocking[0] === 'g');
check(
  '一半没跑完即 error',
  gateVerdict([baseGoal('skipped_budget'), { ...baseGoal('pass'), id: 'h' }], [baseGoal('pass')]).status === 'error',
);

type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
async function suite(db: Db, q: Query, slug: string) {
  process.env.SOP_GATE = 'off';
  process.env.SOP_GATE_DAILY_RUNS = '100';
  process.env.SOP_GATE_TIMEOUT_MS = '60000';
  config.__configTest.reset();
  const service = await fakeService();
  process.env.LLM_BASE_URL = service.url;
  process.env.LLM_API_KEY = 'fake';
  process.env.EMBED_BASE_URL = service.url;
  process.env.EMBED_API_KEY = 'fake';
  const deps = testConfigDeps({ db }, { tenantSlug: slug });
  try {
    const imp = await importConfig({ db, tenantSlug: slug, dataDir: 'data', imageSop: md, lock: async () => fakeLock() });
    check(`${slug} 首次导入不经闸`, imp.code === 0);
    await config.initConfig(deps);
    const tenantId = config.currentSop().tenantId;
    const ctx: TenantCtx = { tenantId, actor: { kind: 'user', userId: null, name: '闸自测', ip: null, role: 'owner' } };
    const creds = new Map<Role, { token: string; csrf: string }>();
    for (const role of ['owner', 'admin', 'viewer'] as const) {
      const [user] = await q<{ id: string }>(`insert into users(email,display_name,password_hash) values ($1,$2,'unused') returning id`, [
        `${role}@${slug}.invalid`,
        role,
      ]);
      await q(`insert into memberships(tenant_id,user_id,role) values ($1,$2,$3)`, [tenantId, user!.id, role]);
      const token = randomBytes(32).toString('base64url');
      const now = new Date('2026-10-10T12:00:00Z');
      await authSessionCreate(db, {
        tenantId,
        userId: user!.id,
        tokenHash: createHash('sha256').update(token).digest(),
        now,
        ip: null,
        userAgent: null,
      });
      creds.set(role, { token, csrf: csrfFor(token) });
      if (role === 'owner') ctx.actor.userId = user!.id;
    }
    __consoleTest.setClock(() => Date.parse('2026-10-10T12:00:00Z'));
    process.env.CONFIG_SOURCE = 'db';
    const request = async (method: string, url: string, body?: unknown, role: Role = 'owner') => {
      const auth = creds.get(role)!;
      return consoleApi.request(`http://localhost/api/console${url}`, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=${auth.token}`,
          'x-csrf': auth.csrf,
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    const view = async (id: string) => {
      const r = await request('GET', `/sop/gate-runs/${id}`);
      assert.equal(r.status, 200, await r.clone().text());
      return (await r.json()) as GateRunView;
    };
    const draft = async (marker: string) => {
      const overview = await sop.getSopOverview(ctx);
      const current = overview.draft ?? overview.published;
      const tone = sectionBody(
        current.sections.find((s) => s.key === 'tone')!,
        TRAVEL_SOP_SECTIONS.find((s) => s.key === 'tone')!,
      );
      return sop.saveSopDraft(ctx, {
        basedOn: overview.published.id,
        rev: overview.draft?.rev ?? null,
        edits: [{ key: 'tone', body: `${tone}\n${marker}` }],
      });
    };
    const fill = (fail = false) => {
      service.script.length = 0;
      for (let i = 0; i < 60; i++) service.script.push({ content: fail ? '您好，欢迎咨询。' : '您好，请问您想去哪里旅行？' });
    };
    const run = async (rev: number) => {
      const r = await request('POST', '/sop/draft/gate', { rev });
      assert.equal(r.status, 202, await r.clone().text());
      const { runId } = (await r.json()) as { runId: string };
      await stopAfterRun(runId);
      return view(runId);
    };
    const stopAfterRun = async (id: string) => {
      const deadline = Date.now() + 65000;
      while (true) {
        const v = await getGateRun(ctx, id);
        if (!['queued', 'running'].includes(v.status)) break;
        if (Date.now() > deadline) throw new Error('闸自测超时');
        await new Promise((r) => setTimeout(r, 50));
      }
      // 等清理与预算结算完成；已经结束时 stop 只等尾部，不影响结果。
      await stopTenantGates(tenantId);
    };
    check(`${slug} 未跑过面板=404`, (await request('GET', '/sop/gate-runs/00000000-0000-0000-0000-000000000000')).status === 404);
    let d = await draft('措辞标记甲');
    check(`${slug} 管理员以外不能跑闸`, (await request('POST', '/sop/draft/gate', { rev: d.rev }, 'viewer')).status === 403);
    check(
      `${slug} 后台改锁定节422`,
      (await request('PUT', '/sop/draft', { basedOn: d.basedOn, rev: d.rev, edits: [{ key: 'price-rules', body: '删除' }] })).status ===
        422,
    );
    // 静态不合格在创建闸行之前拒绝。
    const beforeStatic = (await q<{ n: string }>('select count(*) as n from sop_gate_runs'))[0]!.n;
    d = await sop.saveSopDraft(ctx, { basedOn: d.basedOn!, rev: d.rev, edits: [{ key: 'tone', body: '' }] });
    check(`${slug} 闸静态检查422`, (await request('POST', '/sop/draft/gate', { rev: d.rev })).status === 422);
    check(`${slug} 静态失败不消耗次数`, (await q<{ n: string }>('select count(*) as n from sop_gate_runs'))[0]!.n === beforeStatic);
    await sop.discardSopDraft(ctx, { rev: d.rev });
    d = await draft('措辞标记乙');
    process.env.SOP_GATE = 'required';
    let r = await request('POST', '/sop/draft/publish', { rev: d.rev, changeNote: '缺回归' });
    check(`${slug} required 没有通过记录409`, r.status === 409 && ((await r.json()) as { error: string }).error === 'gate_required');
    fill();
    const started = await startGate(ctx, { rev: d.rev });
    // 子进程尚未完成，两种活动状态的接口形状均可读；队列状态由未启动的活动行另测。
    await new Promise((r) => setTimeout(r, 200));
    const running = await view(started.runId);
    check(`${slug} 运行中面板`, running.status === 'running' && running.finishedAt === null);
    r = await request('POST', '/sop/draft/gate', { rev: d.rev });
    check(`${slug} 同租户活动409`, r.status === 409 && ((await r.json()) as { error: string }).error === 'gate_active');
    await stopAfterRun(started.runId);
    const passed = await view(started.runId);
    check(
      `${slug} 假模型两边通过`,
      passed.status === 'done' &&
        passed.verdict === 'pass' &&
        passed.mock &&
        !passed.baselineReused &&
        passed.draft.length === 1 &&
        passed.baseline?.length === 1,
    );
    check(`${slug} 通过面板无内存进度`, passed.progress === null && !!passed.finishedAt);
    check(
      `${slug} 清理子进程状态与导出，只留报告`,
      fs
        .readdirSync(path.join(process.env.VAR_DIR!, 'gate', passed.id))
        .sort()
        .join(',') === 'draft.jsonl,published.jsonl',
    );
    check(`${slug} VAR_DIR没有旁路写入`, fs.readdirSync(process.env.VAR_DIR!).join(',') === 'gate');
    check(`${slug} 状态登记清掉进度`, tenantKeys(tenantId)['gate.progress'] === 0);
    const usage = (
      await q<{ n: string; cost: string }>(
        "select sum(calls) as n,sum(cost_milli_cny) as cost from usage_daily where tenant_id=$1 and purpose='gate'",
        [tenantId],
      )
    )[0]!;
    check(
      `${slug} gate用量入库`,
      Number(usage.n) > 0 && Number(usage.cost) === passed.costMilli && currentRuntime().budget.status().costMilli >= passed.costMilli,
    );
    await q("update sop_gate_runs set policy_hash='stale' where tenant_id=$1 and id=$2", [tenantId, passed.id]);
    r = await request('POST', '/sop/draft/publish', { rev: d.rev, changeNote: '政策哈希不符', gateRunId: passed.id });
    check(`${slug} 同草稿同rev也要求政策哈希相同`, r.status === 409 && ((await r.json()) as { error: string }).error === 'gate_required');
    await q("update sop_gate_runs set policy_hash=$3,prompt_hash='stale' where tenant_id=$1 and id=$2", [
      tenantId,
      passed.id,
      config.currentPolicy().policyHash,
    ]);
    r = await request('POST', '/sop/draft/publish', { rev: d.rev, changeNote: '渲染哈希不符', gateRunId: passed.id });
    check(`${slug} 发布重新核对渲染哈希`, r.status === 409 && ((await r.json()) as { error: string }).error === 'gate_required');
    const checked = await sop.checkSopDraft(ctx);
    await q('update sop_gate_runs set prompt_hash=$3 where tenant_id=$1 and id=$2', [tenantId, passed.id, checked.promptHash]);
    r = await request('POST', '/sop/draft/publish', { rev: d.rev, changeNote: '措辞通过', gateRunId: passed.id });
    check(`${slug} 有通过记录可以发布`, r.status === 200);
    const original = config.currentSop();
    const originalFirst = imp.hashes!.promptHash;
    d = await draft('语义破坏标记');
    fill(true);
    const failed = await run(d.rev);
    check(`${slug} 发布后草稿结果直接复用为基线`, failed.baselineReused && failed.baseline?.[0]?.result === 'pass');
    check(`${slug} 语义退化点名`, failed.verdict === 'fail' && failed.blocking.join(',') === 'gate-regression');
    r = await request('POST', '/sop/draft/publish', { rev: d.rev, changeNote: '被拦', gateRunId: failed.id });
    const failure = (await r.json()) as { error: string; runId: string };
    check(`${slug} gate_failed409带runId`, r.status === 409 && failure.error === 'gate_failed' && failure.runId === failed.id);
    // 草稿 rev 或 policyHash 不一致，即使指定通过的 runId 也不能沿用。
    r = await request('POST', '/sop/draft/publish', { rev: d.rev, changeNote: '旧闸', gateRunId: passed.id });
    check(`${slug} 草稿不能冒用旧通过记录`, r.status === 409 && ((await r.json()) as { error: string }).error === 'gate_required');
    r = await request(
      'POST',
      '/sop/draft/publish',
      { rev: d.rev, changeNote: '强发', override: { reason: '供应商故障，人工复核' } },
      'admin',
    );
    check(`${slug} 管理员强发403`, r.status === 403 && ((await r.json()) as { error: string }).error === 'override_forbidden');
    r = await request('POST', '/sop/draft/publish', { rev: d.rev, changeNote: '强发', override: { reason: '人工复核通过' } });
    check(`${slug} 所有者原因强发`, r.status === 200);
    const audit = (
      await q<{ diff: { override?: { reason: string } } }>(
        "select diff from audit_log where tenant_id=$1 and action='sop.publish' order by at desc limit 1",
        [tenantId],
      )
    )[0]!;
    check(
      `${slug} 审计与变更说明都有原因`,
      audit.diff.override?.reason === '人工复核通过' &&
        (await sop.getSopVersion(ctx, config.currentSop().versionId)).changeNote?.includes('人工复核通过'),
    );
    const countBefore = (await q<{ n: string }>('select count(*) as n from sop_gate_runs'))[0]!.n;
    const rollback = await sop.rollbackSop(ctx, { versionId: original.versionId, changeNote: '逃生回滚' });
    check(
      `${slug} 回滚双哈希相同`,
      rollback.sameHashAsTarget && rollback.promptHash === original.promptHash && rollback.policyHash === original.policyHash,
    );
    check(`${slug} 回滚不建闸`, (await q<{ n: string }>('select count(*) as n from sop_gate_runs'))[0]!.n === countBefore);
    const rollbackAudit = (
      await q<{ diff: { gate: string } }>(
        "select diff from audit_log where tenant_id=$1 and action='sop.rollback' order by at desc limit 1",
        [tenantId],
      )
    )[0]!;
    check(`${slug} 回滚审计跳闸`, rollbackAudit.diff.gate === 'skipped_rollback' && rollback.promptHash !== originalFirst);
    d = await draft('重跑不稳标记');
    fill();
    service.script[0] = { content: '您好，欢迎咨询。' };
    const flaky = await run(d.rev);
    check(
      `${slug} 首遍失败重跑通过不拦`,
      flaky.verdict === 'pass' && flaky.draft[0]!.result === 'flaky' && flaky.draft[0]!.attempts.length === 2,
    );
    // 线上也失败：代码版本变更使旧基线不可复用，同一次运行的两边均 fail。
    process.env.APP_REVISION = 'gate-selftest-known';
    fill(true);
    const known = await run(d.rev);
    check(
      `${slug} 基线已失败列出不拦`,
      known.verdict === 'pass' && known.baseline?.[0]?.result === 'fail' && known.draft[0]?.result === 'fail' && !known.baselineReused,
    );
    process.env.APP_REVISION = 'gate-selftest-budget';
    process.env.SOP_GATE_BUDGET_CNY = '0.01';
    fill();
    service.script[0] = { content: '您好，请问您想去哪里旅行？', prompt: 100000, completion: 0 };
    const requestsBefore = service.requests.length;
    const budget = await run(d.rev);
    check(`${slug} 超预算 error`, budget.status === 'error' && budget.error === 'budget_stop');
    check(`${slug} 最多超最后一笔，预算停后无新请求`, budget.costMilli <= 10 + 800 && service.requests.length - requestsBefore === 1);
    delete process.env.SOP_GATE_BUDGET_CNY;
    process.env.APP_REVISION = 'gate-selftest-timeout';
    process.env.SOP_GATE_TIMEOUT_MS = '1';
    fill();
    const timeout = await run(d.rev);
    check(`${slug} 超时 error`, timeout.status === 'error' && timeout.error === 'timeout');
    process.env.SOP_GATE_TIMEOUT_MS = '60000';
    process.env.LLM_MODEL = 'unknown-gate-model';
    const exit = await run(d.rev);
    check(`${slug} 子进程异常退出 error`, exit.status === 'error' && exit.error === 'child_exit');
    process.env.LLM_MODEL = 'glm-5.2';
    // 一边跑到一半被取消：报告里已出的目标花费照样记进本行费用、gate 用量与当天预算。第二个目标的请求一直不回，
    // 等第一个目标出了报告再取消。
    process.env.APP_REVISION = 'gate-selftest-partial';
    const slowGoal = path.join(goalsDir, '02-regression-slow.json');
    fs.writeFileSync(
      slowGoal,
      fs.readFileSync(path.join(goalsDir, '01-regression.json'), 'utf8').replace('"gate-regression"', '"gate-regression-slow"'),
    );
    service.script.length = 0;
    service.script.push({ content: '您好，请问您想去哪里旅行？', prompt: 100000, completion: 0 });
    for (let i = 0; i < 10; i++) service.script.push({ content: '您好，请问您想去哪里旅行？', delayMs: 60000 });
    const gateCost = async () =>
      Number(
        (
          await q<{ cost: string | null }>("select sum(cost_milli_cny) as cost from usage_daily where tenant_id=$1 and purpose='gate'", [
            tenantId,
          ])
        )[0]!.cost ?? 0,
      );
    const costBefore = await gateCost();
    const budgetBefore = currentRuntime().budget.status().costMilli;
    r = await request('POST', '/sop/draft/gate', { rev: d.rev });
    assert.equal(r.status, 202, await r.clone().text());
    const partialId = ((await r.json()) as { runId: string }).runId;
    const seenBy = Date.now() + 30000;
    let seen = 0;
    while (!(seen = (await getGateRun(ctx, partialId)).costMilli)) {
      if (Date.now() > seenBy) throw new Error('闸自测：第一个目标没出报告');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stopTenantGates(tenantId);
    const partial = await view(partialId);
    const reported = fs
      .readFileSync(path.join(process.env.VAR_DIR!, 'gate', partialId, 'published.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; spentMilli?: number })
      .filter((line) => line.type === 'goal')
      .at(-1)?.spentMilli;
    check(
      `${slug} 取消时已出报告的花费记进本行`,
      partial.status === 'error' &&
        partial.error === 'cancelled' &&
        partial.costMilli > 0 &&
        partial.costMilli === seen &&
        partial.costMilli === reported,
    );
    check(
      `${slug} 取消时的花费补记进gate用量与当天预算`,
      (await gateCost()) - costBefore === partial.costMilli &&
        currentRuntime().budget.status().costMilli - budgetBefore === partial.costMilli,
    );
    fs.rmSync(slowGoal);
    process.env.SOP_GATE_DAILY_RUNS = '1';
    r = await request('POST', '/sop/draft/gate', { rev: d.rev });
    check(`${slug} 每日次数429`, r.status === 429 && ((await r.json()) as { error: string }).error === 'gate_quota');
    process.env.SOP_GATE_DAILY_RUNS = '100';
    const hashes = { promptHash: original.promptHash, policyHash: original.policyHash, draftKey: 'queued', baselineKey: 'queued' };
    const queued = await withTenant(db, ctx, (tx) =>
      insertGate(tx, { ...hashes, draftId: d.id, draftRev: d.rev, status: 'queued', mock: true }),
    );
    check(`${slug} 排队面板`, (await view(queued.id)).status === 'queued');
    await assert.rejects(
      withTenant(db, ctx, (tx) => insertGate(tx, { ...hashes, draftId: d.id, draftRev: d.rev, status: 'running', mock: true })),
      isUniqueViolation,
    );
    check(`${slug} 部分唯一索引拒绝第二次活动运行`, true);

    // 模拟进程重启：先释放旧运行时配置，再重新装载；本租户活动行变 abandoned。
    config.__configTest.reset();
    await config.initConfig(deps);
    check(`${slug} 重启后放弃面板`, (await view(queued.id)).status === 'abandoned');
    await q("update sop_gate_runs set status='running',finished_at=null where tenant_id=$1 and id=$2", [tenantId, queued.id]);
    config.__configTest.reset();
    await config.initConfig(deps);
    check(`${slug} running重启也 abandoned`, (await view(queued.id)).status === 'abandoned');
    process.env.APP_REVISION = 'gate-selftest';
    fill();
    const afterRestart = await run(d.rev);
    check(`${slug} 重启后可以重新跑`, afterRestart.status === 'done');
    // 沙箱发布只过静态检查；同租户夹具换运行时，不开通也不碰种子模块。
    const sandbox = createTenantRuntime({ id: tenantId, slug, kind: 'sandbox' });
    sandbox.config.loaded = hostRuntime().config.loaded;
    const usageBefore = (await q<{ n: string }>("select count(*) as n from usage_daily where purpose='gate'"))[0]!.n;
    await withTenantScope(sandbox, async () => {
      await assert.rejects(startGate(ctx, { rev: d.rev }), GateSkippedError);
      await sop.publishSopDraft(ctx, { rev: d.rev, changeNote: '沙箱跳闸' });
    });
    check(
      `${slug} 沙箱不产生gate用量`,
      (await q<{ n: string }>("select count(*) as n from usage_daily where purpose='gate'"))[0]!.n === usageBefore,
    );
    const sandboxAudit = (
      await q<{ diff: { gate: string } }>(
        "select diff from audit_log where tenant_id=$1 and action='sop.publish' order by at desc limit 1",
        [tenantId],
      )
    )[0]!;
    check(`${slug} 沙箱跳闸审计`, sandboxAudit.diff.gate === 'skipped_sandbox');
    // RLS：另一个租户事务看不到本租户闸；应用角色没有 DELETE。
    const [other] = await q<{ id: string }>("insert into tenants(slug,name,pack_id) values ($1,'其他','travel') returning id", [
      `${slug}-other`,
    ]);
    const otherRt = createTenantRuntime({ id: other!.id, slug: `${slug}-other` });
    registerRuntime(otherRt);
    await withTenantScope(otherRt, async () =>
      check(
        `${slug} FORCE RLS跨租户不可读`,
        (await withTenant(db, { ...ctx, tenantId: other!.id }, (tx) => readGate(tx, passed.id))) === null,
      ),
    );
    // 单进程只有一个槽：另一个 standard 租户运行时，本租户只能排队。
    await withTenantScope(otherRt, async () => {
      const imported = await importConfig({ db, tenantSlug: otherRt.slug, dataDir: 'data', imageSop: md, lock: async () => fakeLock() });
      assert.equal(imported.code, 0);
      await config.initConfig(testConfigDeps({ db }, { tenantSlug: otherRt.slug }));
    });
    config.__configTest.reset();
    await config.initConfig(deps);
    const concurrentDraft = await draft('单槽验证');
    const otherCtx: TenantCtx = { tenantId: otherRt.id, actor: { kind: 'system', userId: null, name: '单槽自测', ip: null } };
    const otherDraft = await withTenantScope(otherRt, () =>
      sop.saveSopDraft(otherCtx, {
        basedOn: config.currentSop().versionId,
        rev: null,
        edits: [{ key: 'tone', body: '谨慎地回答客户的问题。' }],
      }),
    );
    fill();
    const otherRun = await withTenantScope(otherRt, () => startGate(otherCtx, { rev: otherDraft.rev }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hostRun = await startGate(ctx, { rev: concurrentDraft.rev });
    check(`${slug} 实例单槽让第二租户排队`, (await getGateRun(ctx, hostRun.runId)).status === 'queued');
    // 模拟摘下：取消信号杀掉正在运行的子进程，等待清理后才注销运行时。
    cancelTenantRuntime(otherRt);
    await stopTenantGates(otherRt.id);
    const cancelled = await withTenantScope(otherRt, () => getGateRun(otherCtx, otherRun.runId));
    check(
      `${slug} 摘下运行时杀子进程并清理`,
      cancelled.status === 'error' &&
        cancelled.error === 'cancelled' &&
        !fs.existsSync(path.join(process.env.VAR_DIR!, 'gate', otherRun.runId, 'tmp')) &&
        tenantKeys(otherRt.id)['gate.progress'] === 0,
    );
    await stopAfterRun(hostRun.runId);
    check(`${slug} 取消前租户后单槽继续运行`, (await getGateRun(ctx, hostRun.runId)).status === 'done');
    unregisterRuntime(otherRt.id);
    const [priv] = await q<{ d: boolean; r: boolean; f: boolean }>(
      "select has_table_privilege('agent_app','sop_gate_runs','DELETE') as d,relrowsecurity as r,relforcerowsecurity as f from pg_class where oid='sop_gate_runs'::regclass",
    );
    check(`${slug} FORCE RLS与无DELETE`, priv!.r && priv!.f && !priv!.d);
  } finally {
    await Promise.all(tenantRuntimes().map((rt) => stopTenantGates(rt.id)));
    await service.close();
    config.__configTest.reset();
    process.env.SOP_GATE = 'off';
    process.env.CONFIG_SOURCE = 'file';
  }
}

try {
  const tmp = path.join(process.env.VAR_DIR!, 'gate', 'env-probe', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  process.env.DATABASE_URL = 'must-not-inherit';
  process.env.LLM_MAX_INFLIGHT = '8';
  const before = JSON.stringify(process.env);
  const childEnv = gateEnvironment(tmp);
  check('G2不修改父进程env', JSON.stringify(process.env) === before);
  check(
    '子进程env严格键集合',
    Object.keys(childEnv).every((k) => /^(LLM_|ZHIPU_|EMBED_)/.test(k) || ['TZ', 'TMPDIR', 'TSX_DISABLE_CACHE'].includes(k)) &&
      childEnv.LLM_MAX_INFLIGHT === '1' &&
      !childEnv.DATABASE_URL,
  );
  // 真的起一个子进程读取键和 os.tmpdir，不只断言构造函数的返回值。
  const output = await new Promise<string>((resolve, reject) => {
    const c = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import os from "node:os"; console.log(JSON.stringify({keys:Object.keys(process.env),tmp:os.tmpdir()}))',
      ],
      { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('env probe'))));
    const t = setTimeout(() => c.kill('SIGKILL'), 5000);
    c.on('close', () => clearTimeout(t));
  });
  const observed = JSON.parse(output) as { keys: string[]; tmp: string };
  check('子进程实际TMPDIR在本次目录，实际无数据库凭据', observed.tmp === tmp && !observed.keys.includes('DATABASE_URL'));
  fs.rmSync(path.dirname(tmp), { recursive: true });
  process.env.DATABASE_URL = '';
  process.env.SOP_GATE = 'required';
  process.env.LLM_MOCK = '1';
  await assert.rejects(
    config.initConfigFromEnv({ CONFIG_SOURCE: 'db', LLM_MOCK: '1', SOP_GATE: 'required' }, () => {}),
    (e) => e instanceof config.ConfigStartupError && e.reason === 'gate_unavailable',
  );
  checks++;
  await assert.rejects(
    config.initConfigFromEnv({ CONFIG_SOURCE: 'db', LLM_MOCK: '0', SOP_GATE: 'required' }, () => {}),
    (e) => e instanceof config.ConfigStartupError && e.reason === 'gate_unavailable',
  );
  checks++;
  await config.initConfigFromEnv({ CONFIG_SOURCE: 'file', LLM_MOCK: '1', SOP_GATE: 'required' }, () => {});
  check('G1文件模式不读闸开关', config.configMode() === 'file');
  process.env.SOP_GATE = 'off';
  process.env.LLM_MOCK = '0';
  const lite = await openTestDb();
  try {
    await lite.pg.query("insert into tenants(slug,name,pack_id) values ('gate-lite','闸测试','travel')");
    await lite.pg.exec('SET ROLE agent_app');
    const q: Query = async (text, params = []) => {
      await lite.pg.exec('RESET ROLE');
      try {
        return (await lite.pg.query(text, params)).rows as never;
      } finally {
        await lite.pg.exec('SET ROLE agent_app');
      }
    };
    await suite(lite.db, q, 'gate-lite');
  } finally {
    await lite.close();
  }
  if (process.env.PG_TEST_URL) {
    const real = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'gate-pg' });
    const conn = await openDb(real.urls.app);
    try {
      await suite(conn.db, real.query, 'gate-pg');
    } finally {
      await conn.close();
      await real.drop();
    }
  } else console.log('PG_TEST_URL未设置，跳过真实PG');
  console.log(`GATE SERVER SELFTEST PASS: ${checks} 项断言`);
} finally {
  dropTenantState(currentRuntime().id);
  __consoleTest.reset();
  delete __gateTest.goalsDir;
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  restoreClock();
}
