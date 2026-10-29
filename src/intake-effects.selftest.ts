// 12 R5 / R10：真实保存段、通知队列和重载，PGlite 与一次性 PG 共用断言。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Db } from './db/client.js';
import type { HandoffNotice } from './notify/notifier.js';

const mode = process.argv[2];
if (!mode) {
  for (const child of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, child], {
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    assert.equal(run.status, 0);
  }
  if (!process.env.PG_TEST_URL) console.log('未设 PG_TEST_URL：真实 PG 待补跑');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-effects-'));
  Object.assign(process.env, {
    VAR_DIR: dir,
    PACK_FIXTURES: '1',
    CONFIG_SOURCE: 'file',
    LLM_MOCK: '1',
    SERVER_SELFTEST: '1',
    SOP_PATH: 'data/packs/__fixture/sop.md',
  });
  const { hostRuntime, withoutTenantScope } = await import('./tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const testing = await withoutTenantScope(() => import('./db/testing.js'));
  const { openDb } = await import('./db/client.js');
  const store = await import('./store.js');
  const config = await import('./config/source.js');
  const { createFixtureRuntime } = await import('./packs/__fixture/runtime.js');
  const { withFixtureIntake } = await import('./packs/__fixture/intake.js');
  const { bindPack } = await import('./core/pack-api.js');
  const { handleMessage } = await import('./core/engine/index.js');
  const { intakeUnmatchedNotifyOps } = await import('./jobs/notify.js');
  const { claimDueJobs, setJobStatus } = await import('./db/repo/jobs.js');
  const { runHandoffNotifyJob } = await import('./notify/handoff.js');
  const { __notifierTest, noticeText } = await import('./notify/notifier.js');
  let db: Db;
  let tenantId: string;
  let query: <T>(sql: string, args?: unknown[]) => Promise<T[]>;
  let close: () => Promise<void>;
  const slug = 'intake-effects';
  if (mode === 'pg') {
    const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!, { slug });
    const app = await openDb(fx.urls.app);
    db = app.db;
    tenantId = fx.tenantId;
    query = fx.query;
    close = async () => {
      await app.close();
      await fx.drop();
    };
  } else {
    const t = await testing.openTestDb();
    await t.migrate();
    const fx = await testing.installPgSessionStore(t, { slug, varDir: dir });
    db = fx.deps.db;
    tenantId = fx.deps.tenantId;
    query = async <T>(sql: string, args: unknown[] = []) =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<T>(sql, args)).rows;
      });
    close = () => t.close();
  }
  const deps = { db, tenantId, tenantSlug: slug, varDir: dir };
  const notices: HandoffNotice[] = [];
  __notifierTest.use({
    async send(notice) {
      notices.push(notice);
    },
  });
  try {
    await store.initSessionStore(deps);
    await config.initConfig(null);
    const runtime = createFixtureRuntime(config.packSources());
    let prefetches = 0;
    runtime.mock = {
      async chat() {
        return '已核验';
      },
    };
    runtime.prefetch = async ({ session }) => {
      if (session.packState?.quoteAccepted) return null;
      prefetches++;
      return {
        calls: [],
        timings: [],
        effects: {
          statePatch: { quoteAccepted: true },
          notify: { reason: 'intake_unmatched', intakeId: 'int_123456789abc', lines: [2, 3] },
        },
      };
    };
    bindPack(runtime, runtime.defaultBrand);
    for (const [id, lines] of [
      ['bad-id', [1]],
      ['int_123456789abc', []],
      ['int_123456789abc', [0]],
      ['int_123456789abc', [31]],
      ['int_123456789abc', [1, 1]],
    ] as const)
      assert.throws(() => intakeUnmatchedNotifyOps('wecom:wmintake', id, [...lines], Date.now()), /通知参数不合法/);

    const sid = 'wecom:wmintake';
    const snapshots: { accepted: boolean; replies: number }[] = [];
    const unwatch = store.onSessionSaved((s) => {
      if (s.id === sid)
        snapshots.push({ accepted: s.packState?.quoteAccepted === true, replies: s.messages.filter((m) => m.role === 'agent').length });
    });
    await handleMessage(sid, '确认', 'wecom');
    unwatch();
    await store.flushSession(sid);
    assert.deepEqual(snapshots, [
      { accepted: false, replies: 0 },
      { accepted: true, replies: 1 },
    ]);
    const [atomic] = await query<{ same: boolean; state: { packState: { quoteAccepted: boolean } } }>(
      "select c.xmin=m.xmin and c.xmin=j.xmin as same,c.state from conversations c join messages m on m.tenant_id=c.tenant_id and m.conversation_id=c.id join jobs j on j.tenant_id=c.tenant_id and j.payload->>'sessionId'=c.id where c.id=$1 and m.seq=2 and j.dedupe_key='intake_unmatched:int_123456789abc'",
      [sid],
    );
    assert.equal(atomic?.same, true);
    assert.equal(atomic?.state.packState.quoteAccepted, true);
    const runJobs = async () => {
      const jobs = await store.withJobsTx((tx) => claimDueJobs(tx, new Date(Date.now() + 1000), 20, ['handoff_notify']));
      for (const job of jobs) {
        const result = await runHandoffNotifyJob(job, Date.now());
        assert.equal(result.status, 'done');
        await store.withJobsTx((tx) => setJobStatus(tx, job.id, 'done'));
      }
    };
    // 相同清单重复排队，任务表只保留一个在途任务。
    store.queueJobs(sid, intakeUnmatchedNotifyOps(sid, 'int_123456789abc', [2, 3], Date.now()));
    store.saveSession(store.getSession(sid)!);
    await store.flushSession(sid);
    await runJobs();
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind, 'intake_unmatched');
    assert.deepEqual(notices[0]?.lines, [2, 3]);
    assert.match(noticeText(notices[0]!), /2 行库里没找到/);
    assert.match(noticeText(notices[0]!), /行号：2、3/);
    assert.ok(!noticeText(notices[0]!).includes('确认\n'));
    assert.equal(store.getSession(sid)?.handedOver, false);
    console.log(`${mode}: EFFECTS PASS 同步保存段与回复/状态/通知同事务；在途 intakeId 去重、固定文案`);

    await store.drainStore(5000);
    rt.store.pgBackend!.close();
    rt.store.pgBackend = null;
    rt.store.sessions.clear();
    rt.store.orders.clear();
    await store.initSessionStore(deps);
    assert.equal(store.getSession(sid)?.packState?.quoteAccepted, true);
    await handleMessage(sid, '确认', 'wecom');
    await store.flushSession(sid);
    await runJobs();
    assert.equal(prefetches, 1);
    assert.equal(notices.length, 1);
    console.log(`${mode}: EFFECTS PASS 后端重载后确认不重算、不重放通知`);

    const a = { id: 'att_123456789abcdef012345678', cls: 'sheet' as const, mime: 'text/csv', name: '投诉.csv', size: 3, stored: true };
    const s = store.getOrCreateSession('wecom:wmatt', 'wecom');
    store.queueAttachment(s.id, {
      ...a,
      channel: 'wecom',
      sourceKey: 'msg-att',
      sha256: 'synthetic',
      bytes: Buffer.from('A,2'),
      intakeId: null,
      result: null,
      createdAt: Date.now(),
    });
    store.saveSession(s);
    await store.flushSession(s.id);
    bindPack(withFixtureIntake(runtime), runtime.defaultBrand);
    await handleMessage(s.id, '', 'wecom', { attachment: a });
    await store.flushSession(s.id);
    assert.deepEqual((await store.readAttachment(a.id))?.result, { ok: true, sheets: [{ name: 'CSV', rows: [['A', '2']] }] });
    const [row] = await query<{ extra: { attachment: unknown }; content: string }>(
      'select extra,content from messages where conversation_id=$1 and seq=1',
      [s.id],
    );
    assert.deepEqual(row?.extra.attachment, a);
    assert.equal(row?.content, '[文件]');
    await store.drainStore(5000);
    rt.store.pgBackend!.close();
    rt.store.pgBackend = null;
    rt.store.sessions.clear();
    rt.store.orders.clear();
    await store.initSessionStore(deps);
    assert.deepEqual(store.getSession(s.id)?.messages[0]?.attachment, a);
    console.log(`${mode}: INTAKE PG PASS 原件读取、识别结果保存、messages.extra 与重载往返`);
    bindPack(
      withFixtureIntake(runtime, async () => ({
        text: '附件已核验。',
        fixedId: 'fixture.intake',
        notify: { reason: 'intake_unmatched', intakeId: 'int_abcdef123456', lines: [1] },
      })),
      runtime.defaultBrand,
    );
    await handleMessage(s.id, '', 'wecom', { attachment: a });
    await store.flushSession(s.id);
    await runJobs();
    assert.equal(notices.length, 2);
    assert.deepEqual(notices[1]?.lines, [1]);
    assert.ok(!noticeText(notices[1]!).includes(a.name));
    console.log(`${mode}: INTAKE NOTIFY PASS 确定性回复的联合通知、不泄露文件名`);
    const { __llmTest } = await import('./core/llm/client.js');
    bindPack(
      {
        ...runtime,
        mock: {
          async chat() {
            throw __llmTest.httpError(400, '{"code":1301}');
          },
        },
        prefetch: async () => ({
          calls: [],
          timings: [],
          effects: {
            statePatch: { quoteAccepted: true },
            notify: { reason: 'intake_unmatched', intakeId: 'int_111111111111', lines: [1] },
          },
        }),
      },
      runtime.defaultBrand,
    );
    const filtered = 'wecom:wmfiltered';
    const fallback = await handleMessage(filtered, '确认', 'wecom');
    await store.flushSession(filtered);
    assert.ok(fallback.text);
    assert.equal(store.getSession(filtered)?.packState?.quoteAccepted, true);
    const [fallbackCommit] = await query<{ same: boolean }>(
      "select c.xmin=m.xmin and c.xmin=j.xmin as same from conversations c join messages m on m.tenant_id=c.tenant_id and m.conversation_id=c.id join jobs j on j.tenant_id=c.tenant_id and j.payload->>'sessionId'=c.id where c.id=$1 and m.seq=2",
      [filtered],
    );
    assert.equal(fallbackCommit?.same, true);
    console.log(`${mode}: EFFECTS PASS 内容审核兜底与预取效果同次提交`);
  } finally {
    __notifierTest.use(null);
    await store.drainStore(5000);
    rt.store.pgBackend?.close();
    rt.store.pgBackend = null;
    await config.closeConfig();
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
