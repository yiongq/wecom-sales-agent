// 14 第 2–4 步：真实引擎 → limits → 存储 → 转人工通知；PGlite 与真实 PG 共用。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-gates-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  SERVER_SELFTEST: '1',
  LLM_MOCK: '1',
  CUSTOMER_RATE_PER_MIN: '',
  CUSTOMER_RATE_PER_HOUR: '',
  ALERT_WEBHOOK_URL: '',
  LLM_PROVIDER: '',
  LLM_API_KEY: 'synthetic',
  LLM_BASE_URL: 'https://erp.example.test/v1',
  EMBED_API_KEY: '',
  EMBED_BASE_URL: 'https://erp.example.test/v1',
  FOLLOWUP_ENABLED: '1',
  FOLLOWUP_QUIET_START: '0',
  FOLLOWUP_QUIET_END: '0',
});
const r = await import('./runtime.js');
const limits = await import('./limits.js');
const daily = await import('../trace/usage-daily.js');
const store = await import('../store.js');
const testing = await import('../db/testing.js');
const { openDb } = await import('../db/client.js');
const config = await import('../config/source.js');
const { importConfig } = await import('../config/transfer.js');
const { handleMessage, EMERGENCY_REPLY } = await import('../core/engine/index.js');
const { initPrivacy } = await import('../privacy/privacy.js');
const { CONSENT_WITHDRAWN_REPLY } = await import('../handoff/consent.js');
const { observeRequests, completeText } = await import('../core/llm/client.js');
const { customerRate } = await import('./customer-rate.js');
const { followupJobs } = await import('../jobs/followup.js');
const { runJobsOnce, __jobsTest } = await import('../jobs/runner.js');
const { runHandoffNotifyJob } = await import('../notify/handoff.js');
const { __notifierTest } = await import('../notify/notifier.js');
const { runShutdownHooks } = await import('../shutdown.js');
const { tenantKeys, dropTenantState } = await import('./state.js');
const { LIMIT_QUOTA_REPLY, LIMIT_SUSPENDED_REPLY, LIMIT_RATE_REPLY } = await import('./limit-replies.js');
type Runtime = import('./runtime.js').TenantRuntime;
type Db = import('../db/client.js').Db;
type Job = import('../jobs/runner.js').JobRow;
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const scope = r.withTenantScope;
const realFetch = globalThis.fetch;
const realNow = Date.now;

async function suite(db: Db, query: Query, label: string, appUrl?: string): Promise<void> {
  const runtimes: Runtime[] = [];
  let now = new Date(2026, 9, 30, 12).getTime();
  const alerts: { id: string; percent: number }[] = [];
  limits.__limitsTest.configure({ now: () => now, alert: (rt, percent) => alerts.push({ id: rt.id, percent }) });
  const setup = async (slug: string, suspended = false): Promise<Runtime> => {
    await query("insert into tenants(slug,name,pack_id,status) values ($1,$1,'travel',$2)", [slug, suspended ? 'suspended' : 'active']);
    const deps = testing.testConfigDeps({ db }, { tenantSlug: slug });
    // 导入允许停用租户；启动必须继续校验完整的已发布配置。
    const imported = await importConfig({
      db,
      tenantSlug: slug,
      dataDir: 'data',
      imageSop: deps.imageSop,
      lock: async () => testing.fakeLock(),
    });
    assert.equal(imported.code, 0, imported.message);
    const rt = r.createTenantRuntime({ id: slug, slug });
    r.registerRuntime(rt);
    runtimes.push(rt);
    await scope(rt, async () => {
      await config.initConfig(deps);
      await store.initSessionStore({ db, tenantId: rt.id, tenantSlug: slug, varDir: dir });
      daily.__usageDailyTest.rearm(3600_000);
    });
    return rt;
  };
  const value = (rt: Runtime) => scope(rt, () => limits.getTenantLimits()!);
  const poll = (rt: Runtime) => scope(rt, () => limits.initializeTenantLimits(rt));
  const turn = (rt: Runtime, sid: string, text = '你好') => scope(rt, () => handleMessage(sid, text, 'wecom'));
  const session = (rt: Runtime, sid: string) => scope(rt, () => store.getSession(sid)!);
  const edit = async (rt: Runtime, sql: string) => {
    await query(`update tenants set ${sql} where id=$1`, [rt.id]);
    await poll(rt);
  };
  let calls = 0;
  let missing = 0;
  const offMissing = r.onTenantScopeMissing(() => {
    missing++;
  });
  try {
    // 文件模式与沙箱即使配置了限速 env 也不分配新状态。
    process.env.CUSTOMER_RATE_PER_MIN = '1';
    for (const rt of [r.hostRuntime(), r.createTenantRuntime({ id: `sandbox-${label}`, slug: 'sandbox', kind: 'sandbox' })]) {
      scope(rt, () => {
        for (let n = 0; n < 5; n++) assert.equal(customerRate('bypass', 'wecom'), 'ok');
        assert.equal(tenantKeys(rt.id)['customerRate.conversations'], 0);
      });
    }
    process.env.CUSTOMER_RATE_PER_MIN = '';
    const paused = await setup(`gates-${label}-paused`, true);
    const a = await setup(`gates-${label}-a`);
    const b = await setup(`gates-${label}-b`);
    r.configureTenancy({ role: 'host', standardCount: 3, strict: true });
    for (const rt of [a, b, paused])
      scope(rt, () =>
        observeRequests(() => {
          calls++;
        }),
      );
    assert.equal((await turn(paused, 'wecom:paused')).text, LIMIT_SUSPENDED_REPLY);
    assert.equal((await turn(paused, 'wecom:paused')).silent, true);
    await turn(b, 'wecom:boot');
    assert.equal(calls, 1);
    console.log(`14 验收 8 ${label}：停用与正常 standard 同时装载，停用回复固定句、另一租户正常服务`);

    await edit(a, 'monthly_reply_quota=3');
    calls = 0;
    for (let n = 0; n < 3; n++) {
      await turn(a, 'wecom:quota');
      assert.equal(value(a).monthlyUsed, n + 1, '每一轮只计 1');
      scope(a, () => store.saveSession(session(a, 'wecom:quota')));
      assert.equal(value(a).monthlyUsed, n + 1, '重复保存不重复计数');
    }
    assert.equal((await turn(a, 'wecom:quota')).text, LIMIT_QUOTA_REPLY);
    assert.equal(session(a, 'wecom:quota').handoff?.reason, '本月 AI 额度已用完');
    assert.equal(session(a, 'wecom:quota').handoff?.kind, 'failure', '旧镜像认识的 kind');
    assert.equal((await turn(a, 'wecom:quota')).silent, true);
    assert.equal(calls, 3);
    assert.equal(value(a).monthlyUsed, 3);
    assert.equal(session(a, 'wecom:quota').messages.filter((m) => m.role === 'customer').length, 5);
    await scope(a, () => store.flushSession('wecom:quota'));
    const jobs = await query<Job>('select id, payload, run_at as "runAt" from jobs where tenant_id=$1 and kind=\'handoff_notify\'', [a.id]);
    const started = jobs.find((j) => (j.payload as { reason: string }).reason === 'started');
    assert.ok(started);
    let notices = 0;
    __notifierTest.use({
      send: async () => {
        notices++;
      },
    });
    await scope(a, () => runHandoffNotifyJob(started, Date.now()));
    assert.equal(notices, 1, '顾问收到真实任务生成的通知');
    console.log(`14 验收 2 ${label}：3 次模型、5 条客户消息、一次固定句、转人工通知、静默与计数去重`);

    // 同一进程已转人工的会话跨月仍静默，新会话同步归零后恢复。
    now = new Date(2026, 10, 1, 0, 0, 1).getTime();
    assert.equal(value(a).monthlyUsed, 0);
    assert.equal((await turn(a, 'wecom:quota')).silent, true);
    await turn(a, 'wecom:newmonth');
    assert.equal(value(a).monthlyUsed, 1);
    console.log(`14 验收 4 ${label}：跨月同步归零，已转人工不恢复，新会话恢复`);

    await edit(a, 'monthly_reply_quota=10');
    alerts.length = 0;
    for (let n = 0; n < 9; n++) await turn(a, `wecom:alert${n}`);
    await turn(a, 'wecom:alert-over');
    await poll(a);
    assert.deepEqual(
      alerts.map((item) => item.percent),
      [80, 100],
    );
    assert.ok(alerts.every((item) => item.id === a.id));
    console.log(`14 验收 3 ${label}：真实引擎第 8、10 条各告警一次，同月不重复`);

    await edit(a, 'monthly_reply_quota=null, llm_daily_cap_milli=0');
    calls = 0;
    assert.equal(
      scope(a, () => a.budget.reserve('chat', 0)),
      null,
      '日上限 0 全拦，包括零估价',
    );
    let network = 0;
    globalThis.fetch = async () => {
      network++;
      throw new Error('不应发出请求');
    };
    process.env.LLM_MOCK = '0';
    assert.equal((await turn(a, 'wecom:daily')).text, LIMIT_QUOTA_REPLY);
    assert.equal(session(a, 'wecom:daily').handoff?.reason, '今日 AI 用量已到上限');
    assert.equal(network, 0, '预估超限不发模型请求');
    const before = value(a).monthlyUsed;
    for (const purpose of ['followup', 'draft', 'insight', 'suggestion'] as const)
      assert.equal(await scope(a, () => completeText('合成系统', '合成请求', { purpose })), '');
    assert.equal(value(a).monthlyUsed, before, '熔断固定句与后台补全不计回复');
    assert.equal(network, 0);
    process.env.LLM_MOCK = '1';
    globalThis.fetch = realFetch;
    // 同步预占：两个并发尝试不能同时把同一笔预算花掉；重复结算幂等。
    await edit(a, 'llm_daily_cap_milli=10');
    scope(a, () => {
      const reservation = a.budget.reserve('chat', 6)!;
      assert.ok(reservation);
      assert.equal(a.budget.reserve('chat', 5), null);
      reservation.settle(3);
      reservation.settle(9);
      assert.equal(a.budget.status().costMilli, 3);
      assert.ok(a.budget.reserve('chat', 7));
    });
    await edit(a, 'llm_daily_cap_milli=null');
    console.log(`14 验收 5 ${label}：真实 gatedFetch 熔断、零网络请求、转人工、后台失败回退、并发预占`);

    await edit(a, "status='suspended'");
    assert.equal(limits.__limitsTest.timer()?.hasRef(), false);
    calls = 0;
    assert.equal((await turn(a, 'wecom:status')).text, LIMIT_SUSPENDED_REPLY);
    assert.equal((await turn(a, 'wecom:status')).silent, true);
    const statusSession = session(a, 'wecom:status');
    assert.equal(statusSession.handedOver, false);
    // 模拟窗口裁剪仍保留一次性标记；数据库重建也必须接上。
    statusSession.messages = statusSession.messages.slice(-1);
    assert.equal((await turn(a, 'wecom:status')).silent, true);
    await scope(a, () => store.flushSession('wecom:status'));
    assert.ok(
      (
        await query<{ state: { suspendedReplyAt: number } }>('select state from conversations where tenant_id=$1 and id=$2', [
          a.id,
          'wecom:status',
        ])
      )[0]?.state.suspendedReplyAt,
    );
    const job = { payload: { sessionId: 'wecom:status', stage: 'greeting' } } as Job;
    const skipped = await scope(a, () =>
      followupJobs.run(job, Date.now(), {
        markSending() {
          throw new Error('不应进入发送');
        },
      }),
    );
    assert.deepEqual(skipped, { status: 'cancelled', lastError: 'tenant_limit' });
    assert.equal(calls, 0);
    await edit(a, "status='active'");
    await turn(a, 'wecom:status');
    assert.equal(calls, 1);
    assert.equal((await turn(a, 'wecom:quota')).silent, true);
    console.log(`14 验收 7 ${label}：同一运行时轮询停用/恢复、一次固定句、窗口裁剪仍去重、跟进跳过`);

    process.env.CUSTOMER_RATE_PER_MIN = '3';
    const t0 = realNow();
    Date.now = () => t0;
    calls = 0;
    for (let n = 0; n < 5; n++) await turn(a, 'wecom:rate', `您好${n}`);
    assert.equal(calls, 3);
    assert.equal(session(a, 'wecom:rate').messages.filter((m) => m.content === LIMIT_RATE_REPLY).length, 1);
    assert.equal(session(a, 'wecom:rate').messages.filter((m) => m.role === 'customer').length, 5);
    // 下一回合走真实 wire，截获发送给模型的历史。
    let wire = '';
    Date.now = () => t0 + 61_000;
    globalThis.fetch = async (_url, init) => {
      wire = String(init?.body);
      return Response.json({
        choices: [{ message: { content: '您好，请问您有什么出行安排？' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    };
    process.env.LLM_MOCK = '0';
    await turn(a, 'wecom:rate', '继续咨询');
    assert.ok(wire.includes('您好3') && wire.includes('您好4'), '超限的客户消息出现在下一回合模型历史');
    process.env.LLM_MOCK = '1';
    globalThis.fetch = realFetch;
    await turn(a, 'wecom:other');
    assert.equal(calls, 5);
    // 两个窗口、警告冷却、渠道、关闭不建状态与 LRU 上限。
    process.env.CUSTOMER_RATE_PER_HOUR = '2';
    scope(b, () => {
      assert.equal(customerRate('hour', 'web', t0), 'ok');
      assert.equal(customerRate('hour', 'web', t0 + 61_000), 'ok');
      assert.equal(customerRate('hour', 'web', t0 + 122_000), 'warn');
      assert.equal(customerRate('hour', 'web', t0 + 183_000), 'silent');
      assert.equal(customerRate('hour', 'web', t0 + 800_000), 'warn');
      assert.equal(customerRate('hour', 'web', t0 + 4400_000), 'ok');
      assert.equal(customerRate('sim', 'simulator', t0), 'ok');
      for (let n = 0; n <= 100_000; n++) customerRate(`bounded${n}`, 'wecom', t0);
      assert.equal(tenantKeys(b.id)['customerRate.conversations'], 100_000);
      assert.equal(customerRate('hour', 'web', t0), 'ok', '最久未活动会话已淘汰');
    });
    Date.now = realNow;
    process.env.CUSTOMER_RATE_PER_MIN = '';
    process.env.CUSTOMER_RATE_PER_HOUR = '';
    console.log(`14 验收 6 ${label}：5 入站/3 模型/1 提示，下一分钟看见历史，独立会话、小时窗口、冷却与 LRU`);

    // 跟进和确定性回复在统一保存点计数；人工、三句闸门话术不计。
    const countBefore = value(a).monthlyUsed;
    scope(a, () => {
      const s = store.getOrCreateSession('wecom:count', 'wecom');
      for (const author of ['followup', 'human'] as const) s.messages.push({ role: 'agent', content: '合成回复', at: Date.now(), author });
      for (const content of [LIMIT_QUOTA_REPLY, LIMIT_SUSPENDED_REPLY, LIMIT_RATE_REPLY])
        s.messages.push({ role: 'agent', content, at: Date.now() });
      store.saveSession(s);
      store.saveSession(s);
    });
    assert.equal(value(a).monthlyUsed, countBefore + 1);
    const deterministicBefore = value(a).monthlyUsed;
    await turn(a, 'wecom:deterministic', '重置');
    assert.equal(value(a).monthlyUsed, deterministicBefore + 1, '确定性回复也算 1');
    assert.equal(value(b).monthlyUsed, 0, '跨月后其他租户计数仍为零');
    await turn(b, 'wecom:quota');
    assert.equal(value(b).monthlyUsed, 1, '相同会话 id 在另一个租户独立计数');
    assert.equal(session(b, 'wecom:quota').handedOver, false);
    const c = await setup(`gates-${label}-off`);
    await turn(c, 'wecom:off');
    assert.equal(tenantKeys(c.id)['customerRate.conversations'], 0, 'env 未设不分配限速状态');
    await scope(c, async () => {
      let pushed = 0;
      __jobsTest.reset();
      __jobsTest.start(async () => {
        pushed++;
        return true;
      });
      followupJobs.setQuotaForTest(() => true);
      const s = store.getOrCreateSession('wecom:follow-count', 'wecom');
      s.stage = 'quote';
      s.updatedAt = Date.now() - 3 * 3600_000;
      s.messages.push({ role: 'agent', content: '合成回复', at: s.updatedAt });
      store.saveSession(s, false);
      await store.flushSession(s.id);
      const before = value(c).monthlyUsed;
      await runJobsOnce();
      assert.equal(pushed, 1, '真实任务生成、提交 sending 后成功发送跟进');
      assert.equal(value(c).monthlyUsed, before + 1, '成功跟进只计一次');
      assert.equal(s.messages.at(-1)?.author, 'followup');
      store.saveSession(s, false);
      assert.equal(value(c).monthlyUsed, before + 1, '跟进重复保存不重计');
      followupJobs.setQuotaForTest(null);
      await __jobsTest.stop();
    });
    console.log(`14 验收 2 ${label}：真实跟进任务成功落会话后只计一次`);

    const priorityTenant = await setup(`gates-${label}-priority`);
    await query('insert into privacy_notices(tenant_id,version,body) values ($1,1,$2)', [priorityTenant.id, '合成隐私说明']);
    await scope(priorityTenant, () => initPrivacy({ strict: true }));
    scope(priorityTenant, () => observeRequests(() => calls++));
    const priorityErrors: Error[] = [];
    for (const mode of ['suspended', 'quota', 'rate'] as const) {
      await edit(
        priorityTenant,
        `status='${mode === 'suspended' ? 'suspended' : 'active'}', monthly_reply_quota=${mode === 'quota' ? '0' : 'null'}`,
      );
      process.env.CUSTOMER_RATE_PER_MIN = mode === 'rate' ? '1' : '';
      for (const kind of ['emergency', 'consent'] as const) {
        const name = `14 验收 ${mode === 'rate' ? '6' : '7'} ${label}：${mode} 下 ${kind} 优先于用量闸门`;
        try {
          const sid = `wecom:priority-${mode}-${kind}`;
          if (mode === 'rate') await turn(priorityTenant, sid, '你好');
          const s = scope(priorityTenant, () => store.getOrCreateSession(sid, 'wecom'));
          assert.equal(s.handedOver, false, '从 AI 接待开始');
          if (kind === 'consent') {
            scope(priorityTenant, () => {
              s.consent = { health: 'granted' };
              store.saveSession(s, false);
              store.queueConsents(sid, [
                { category: 'health', decision: 'granted', noticeVersion: 1, evidence: '合成同意', at: Date.now() },
              ]);
            });
          }
          assert.equal(scope(priorityTenant, limits.limitVerdict), mode === 'rate' ? 'ok' : mode);
          // 用生产限速器核对该会话已超限；紧急/行权轮不能发出限速固定句。
          if (mode === 'rate')
            assert.equal(
              scope(priorityTenant, () => customerRate(sid, 'wecom')),
              'warn',
            );
          const beforeCalls: number = calls;
          const text = kind === 'emergency' ? '我现在被困在山上，找不到路了' : '撤回同意，删除我的信息';
          const reply = await turn(priorityTenant, sid, text);
          assert.equal(calls, beforeCalls, `${name}：不调模型`);
          assert.equal(reply.text, kind === 'emergency' ? EMERGENCY_REPLY : CONSENT_WITHDRAWN_REPLY, name);
          assert.equal(reply.handoff, true);
          assert.equal(s.handoff?.kind, kind);
          assert.ok(s.messages.some((m) => m.role === 'customer' && m.content === text));
          assert.equal(
            s.messages.some((m) => [LIMIT_QUOTA_REPLY, LIMIT_SUSPENDED_REPLY, LIMIT_RATE_REPLY].includes(m.content)),
            false,
          );
          await scope(priorityTenant, () => store.flushSession(sid));
          const stored = (
            await query<{ state: { handoff: { kind: string } } }>('select state from conversations where tenant_id=$1 and id=$2', [
              priorityTenant.id,
              sid,
            ])
          )[0]!;
          assert.equal(stored.state.handoff.kind, kind);
          if (kind === 'consent') {
            assert.equal(s.consent?.health, 'withdrawn');
            const records = await query<{ decision: string; evidence: string; notice_version: number }>(
              "select decision,evidence,notice_version from consents where tenant_id=$1 and conversation_id=$2 and decision='withdrawn'",
              [priorityTenant.id, sid],
            );
            assert.deepEqual(records, [{ decision: 'withdrawn', evidence: text, notice_version: 1 }]);
          } else {
            const jobs = await query<Job>(
              "select id,payload,run_at as \"runAt\" from jobs where tenant_id=$1 and kind='handoff_notify' and payload->>'sessionId'=$2 and payload->>'reason'='started'",
              [priorityTenant.id, sid],
            );
            assert.equal(jobs.length, 1);
            const notices: string[] = [];
            __notifierTest.use({
              send: async (notice) => {
                notices.push(notice.kind);
              },
            });
            await scope(priorityTenant, () => runHandoffNotifyJob(jobs[0]!, Date.now()));
            assert.deepEqual(notices, ['emergency'], '真实任务执行后通知顾问');
          }
          console.log(name);
        } catch (error) {
          priorityErrors.push(new Error(name, { cause: error }));
        }
      }
    }
    process.env.CUSTOMER_RATE_PER_MIN = '';
    if (priorityErrors.length) throw new AggregateError(priorityErrors, '14 验收：紧急与行权不得被用量闸门吞掉');

    if (appUrl) {
      await query("update tenants set public_host=$2, status='suspended' where id=$1", [a.id, 'a.example.test']);
      await query('update tenants set public_host=$2 where id=$1', [b.id, 'b.example.test']);
      const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, '--startup-worker'], {
        env: { ...process.env, GATES_APP_URL: appUrl, GATES_HOST_SLUG: a.slug },
        encoding: 'utf8',
        timeout: 90_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      process.stdout.write(child.stdout);
    }
    assert.equal(missing, 0);
    console.log(`14 验收 11 ${label}：严格作用域三租户计数/限速隔离，scope_missing=0；跟进计数，关闭不建状态`);
  } finally {
    offMissing();
    Date.now = realNow;
    globalThis.fetch = realFetch;
    Object.assign(process.env, { LLM_MOCK: '1', CUSTOMER_RATE_PER_MIN: '', CUSTOMER_RATE_PER_HOUR: '' });
    __notifierTest.use(null);
    limits.stopTenantLimits();
    for (const rt of runtimes) {
      await scope(rt, daily.flushUsageDaily);
      await rt.store.pgBackend?.close();
      await scope(rt, config.closeConfig);
      dropTenantState(rt.id);
      rt.state = 'closed';
      r.unregisterRuntime(rt.id);
    }
    limits.__limitsTest.reset();
    r.configureTenancy({ role: 'host', standardCount: 1, strict: false });
  }
}

try {
  if (process.argv.includes('--startup-worker')) {
    await config.initConfigFromEnv(
      {
        CONFIG_SOURCE: 'db',
        SESSION_STORE: 'db',
        DATABASE_URL: process.env.GATES_APP_URL,
        DEFAULT_TENANT_SLUG: process.env.GATES_HOST_SLUG,
        DEPLOY_PROFILE: 'demo',
        TENANCY_STRICT: '1',
        PUBLIC_BASE_URL: 'https://a.example.test',
        LLM_MOCK: '1',
      },
      () => {
        throw new Error('启动意外退出');
      },
    );
    const tenants = r.tenantRuntimes();
    assert.equal(tenants.length, 2);
    for (const rt of tenants)
      await scope(rt, async () => {
        await store.initSessionStore({ db: rt.config.loaded!.deps.db, tenantId: rt.id, tenantSlug: rt.slug, varDir: dir });
        if (rt.isHost) {
          assert.ok(store.getSession('wecom:status')?.suspendedReplyAt, '新进程从 PG 预载停用固定句标记');
          assert.equal((await handleMessage('wecom:status', '重启后的消息', 'wecom')).silent, true);
          assert.equal(
            store.getSession('wecom:status')!.messages.some((m) => m.content === LIMIT_SUSPENDED_REPLY),
            false,
          );
          console.log('14 验收 7 pg：新进程重启后从 PG 恢复标记，历史窗口无固定句也不重复发送');
        }
        const reply = await handleMessage('wecom:bootloop', '你好', 'wecom');
        if (rt.isHost) assert.equal(reply.text, LIMIT_SUSPENDED_REPLY);
        else assert.ok(reply.text && reply.text !== LIMIT_SUSPENDED_REPLY);
      });
    console.log('14 验收 8 pg：生产 initConfigFromEnv 逐租户循环在真实 PG 启动成功，两租户服务隔离');
    for (const rt of tenants) {
      await scope(rt, daily.flushUsageDaily);
      await rt.store.pgBackend?.close();
      await scope(rt, config.closeConfig);
    }
  } else {
    const test = await testing.openTestDb();
    try {
      await test.migrate();
      await test.pg.exec('SET ROLE agent_app');
      await suite(
        test.db,
        <T>(sql: string, params?: unknown[]) =>
          test.pg.transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE NONE');
            return (await tx.query<T>(sql, params)).rows;
          }),
        'pglite',
      );
    } finally {
      await test.close();
    }
    if (process.env.PG_TEST_URL) {
      const fixture = await testing.createRealPgFixture(process.env.PG_TEST_URL);
      const app = await openDb(fixture.urls.app);
      try {
        await suite(app.db, fixture.query, 'pg', fixture.urls.app);
      } finally {
        await app.close();
        await fixture.drop();
      }
    } else if (process.env.CI === 'true') throw new Error('CI 必须设 PG_TEST_URL');
    else console.log('14 验收 8：真实 PG 待设 PG_TEST_URL');
    console.log('LIMITS GATES SELFTEST PASS');
  }
} finally {
  await runShutdownHooks();
  fs.rmSync(dir, { recursive: true, force: true });
}
