// 15 验收 2/6：真实角色、CLI 子进程、行权/故障恢复；仅一次性 PG，无生产配置。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRealPgFixture } from '../db/testing.js';
import { holdTenantLock, openDb, withTenant } from '../db/client.js';
import { importConfig } from '../config/transfer.js';
import { readImageSop } from '../config/brand.js';
import { createUser } from '../auth/accounts.js';
import { authLoginLookup, authSessionCreate, authSessionTouch } from '../db/repo/auth.js';
import { insertTenant, updateRetention } from '../db/repo/tenants.js';
import { trialBaseline, trialConversations, trialOrderIds, readTrialBatches, assertTrialResetComplete } from '../db/repo/trial-reset.js';
import { readPurgeCandidates, purgeConversation } from '../db/repo/retention.js';
import { writeSeedSessions } from './session-transfer.js';
import { resetTrial, type TrialApproval } from '../tenancy/trial/reset.js';
import type { Session } from '../types.js';
import { createHash } from 'node:crypto';
import { runtimeById } from '../packs/registry.js';
import { packSources } from '../config/source.js';

if (!process.env.PG_TEST_URL) {
  if (process.env.CI === 'true') throw new Error('trial-reset requires PG_TEST_URL');
  console.log('TRIAL RESET: PG_TEST_URL not set, real CLI validation not run');
} else {
  fs.mkdirSync('var', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('var/wsa15-trial-'));
  const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'trial-host' });
  const app = await openDb(fx.urls.app),
    platform = await openDb(fx.urls.platform);
  const id = randomUUID();
  const formalId = randomUUID();
  const ctx = { tenantId: id, actor: { kind: 'system' as const, userId: null, name: 'trial-selftest', ip: null } };
  const read = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(app.db, ctx, fn);
  const email = 'shared@trial.example.test';
  const approvalPath = path.join(dir, 'approval.json');
  const dataDir = path.join(dir, 'shared-var');
  fs.mkdirSync(dataDir);
  let hostSlug = 'trial-host';
  let approval: TrialApproval;
  let foreignBefore = '';
  const foreign = async () =>
    JSON.stringify(await fx.query('select tenant_id,id,state from conversations where tenant_id<>$1 order by tenant_id,id', [id]));
  async function review() {
    approval = {
      allowlist: [{ tenantId: id, slug: 'trial-industry', packId: 'industrial', kind: 'standard', isHost: false }],
      sharedEmail: email,
      reviewedConversationRefs: (await read(trialConversations)).map((r) => r.ref),
      reviewedOrderIds: await read(trialOrderIds),
      baselineHash: (await read(trialBaseline)).hash,
    };
    fs.writeFileSync(approvalPath, JSON.stringify(approval));
  }
  async function cli(batch?: string, interrupt?: (kill: () => void) => Promise<void>): Promise<{ code: number | null; output: string }> {
    const p = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli/trial-reset.ts',
        '--tenant',
        'trial-industry',
        '--approval',
        approvalPath,
        '--var',
        dataDir,
        '--password-stdin',
        ...(batch ? ['--batch', batch] : []),
      ],
      {
        env: { ...process.env, DATABASE_URL: fx.urls.app, DATABASE_PLATFORM_URL: fx.urls.platform, DEFAULT_TENANT_SLUG: hostSlug },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    p.stdout.on('data', (b) => (output += b));
    p.stderr.on('data', (b) => (output += b));
    p.stdin.end('synthetic-reset-password\n');
    const timer = setTimeout(() => p.kill('SIGKILL'), 25_000);
    const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      p.once('error', reject);
      p.once('close', (code) => resolve({ code, output }));
    });
    try {
      if (interrupt)
        await interrupt(() => {
          p.kill('SIGKILL');
        });
      return await done;
    } finally {
      clearTimeout(timer);
      if (p.exitCode === null && p.signalCode === null) {
        p.kill('SIGKILL');
        await done;
      }
    }
  }
  async function snapshot() {
    return JSON.stringify(
      await fx.query(
        'select (select count(*) from audit_log) as audit,(select count(*) from conversations) as conversations,(select count(*) from messages) as messages,(select count(*) from auth_sessions) as sessions',
      ),
    );
  }
  async function rejectUnchanged(name: string, change: () => Promise<void> | void, restore: () => Promise<void> | void) {
    await change();
    const before = await snapshot();
    const r = await cli();
    assert.equal(r.code, 1, `${name}: ${r.output}`);
    assert.equal(await snapshot(), before, name);
    await restore();
    console.log(`PASS 15 验收 6：${name} 零修改`);
  }
  try {
    await insertTenant(platform.db, {
      id,
      slug: 'trial-industry',
      name: '合成共享试用',
      packId: 'industrial',
      locale: 'zh-CN',
      region: 'CN',
      brand: runtimeById('industrial', packSources())!.defaultBrand,
    });
    const imported = await importConfig({
      db: app.db,
      tenantSlug: 'trial-industry',
      dataDir: path.resolve('data/packs/industrial'),
      imageSop: readImageSop,
      lock: (tenantId) => holdTenantLock(fx.urls.app, tenantId),
    });
    assert.equal(imported.code, 0, imported.message);
    await updateRetention(platform.db, id, { leadDays: 7, customerDays: 7, traceDays: 7 });
    assert.equal(
      (
        await createUser(platform.db, {
          tenantSlug: 'trial-industry',
          email,
          name: '共享顾问',
          role: 'agent',
          password: async () => 'synthetic-original-password',
        })
      ).code,
      0,
    );
    const user = await authLoginLookup(app.db, id, email);
    assert.equal(user?.role, 'agent');
    const tokenHash = createHash('sha256').update('synthetic-old-cookie').digest();
    await authSessionCreate(app.db, { tenantId: id, tokenHash, userId: user!.userId, now: new Date(), ip: null, userAgent: 'synthetic' });
    const old: Session = {
      id: 'wecom:wmTrial',
      channel: 'wecom',
      stage: 'discovery',
      profile: {},
      messages: [{ role: 'customer', content: '合成的真实试用消息', at: Date.now() - 8 * 86400000 }],
      orderIds: [],
      handedOver: false,
      createdAt: Date.now() - 8 * 86400000,
      updatedAt: Date.now() - 8 * 86400000,
    };
    await insertTenant(platform.db, {
      id: formalId,
      slug: 'formal-company',
      name: '合成正式公司',
      packId: 'industrial',
      locale: 'zh-CN',
      region: 'CN',
    });
    await withTenant(app.db, { ...ctx, tenantId: formalId }, (tx) =>
      writeSeedSessions(
        tx,
        [{ ...old, id: 'wecom:wmFormal', messages: [{ role: 'customer', content: '合成正式租户的保留消息', at: old.createdAt }] }],
        [],
      ),
    );
    foreignBefore = await foreign();
    await read((tx) => writeSeedSessions(tx, [old], []));
    await review();
    const original = structuredClone(approval!);
    await rejectUnchanged(
      '实际宿主目标',
      () => {
        hostSlug = 'trial-industry';
      },
      () => {
        hostSlug = 'trial-host';
      },
    );
    await rejectUnchanged(
      '空白名单',
      () => fs.writeFileSync(approvalPath, JSON.stringify({ ...original, allowlist: [] })),
      () => fs.writeFileSync(approvalPath, JSON.stringify(original)),
    );
    await rejectUnchanged(
      '数据库实际包不匹配',
      async () => {
        await fx.query("update tenants set pack_id='travel' where id=$1", [id]);
      },
      async () => {
        await fx.query("update tenants set pack_id='industrial' where id=$1", [id]);
      },
    );
    await rejectUnchanged(
      '数据库实际沙箱目标',
      async () => {
        await fx.query("update tenants set kind='sandbox',expires_at=now()+interval '1 hour',template_tenant_id=$2 where id=$1", [
          id,
          fx.tenantId,
        ]);
      },
      async () => {
        await fx.query("update tenants set kind='standard',expires_at=null,template_tenant_id=null where id=$1", [id]);
      },
    );
    await rejectUnchanged(
      '共享账号有其他租户成员关系',
      async () => {
        await fx.query("insert into memberships(tenant_id,user_id,role) values($1,$2,'agent')", [fx.tenantId, user!.userId]);
      },
      async () => {
        await fx.query('delete from memberships where tenant_id=$1 and user_id=$2', [fx.tenantId, user!.userId]);
      },
    );
    await rejectUnchanged(
      '错 UUID',
      () => {
        approval.allowlist[0]!.tenantId = randomUUID();
        fs.writeFileSync(approvalPath, JSON.stringify(approval));
      },
      () => {
        approval = structuredClone(original);
        fs.writeFileSync(approvalPath, JSON.stringify(approval));
      },
    );
    await rejectUnchanged(
      '错 slug',
      () => {
        approval.allowlist[0]!.slug = 'not-trial';
        fs.writeFileSync(approvalPath, JSON.stringify(approval));
      },
      () => fs.writeFileSync(approvalPath, JSON.stringify(original)),
    );
    await rejectUnchanged(
      '错 pack',
      () => fs.writeFileSync(approvalPath, JSON.stringify({ ...original, allowlist: [{ ...original.allowlist[0], packId: 'travel' }] })),
      () => fs.writeFileSync(approvalPath, JSON.stringify(original)),
    );
    await rejectUnchanged(
      '宿主目标',
      () => fs.writeFileSync(approvalPath, JSON.stringify({ ...original, allowlist: [{ ...original.allowlist[0], isHost: true }] })),
      () => fs.writeFileSync(approvalPath, JSON.stringify(original)),
    );
    await rejectUnchanged(
      '未签收的正式数据混入',
      () => fs.writeFileSync(approvalPath, JSON.stringify({ ...original, reviewedConversationRefs: [] })),
      () => fs.writeFileSync(approvalPath, JSON.stringify(original)),
    );
    for (const file of ['store-spill-synthetic.json', 'restored-from-backup.json'])
      await rejectUnchanged(
        file,
        () => fs.writeFileSync(path.join(dataDir, file), '{}'),
        () => fs.unlinkSync(path.join(dataDir, file)),
      );
    const lock = await holdTenantLock(fx.urls.app, id);
    assert.ok(lock);
    try {
      const before = await snapshot();
      assert.equal((await cli()).code, 1);
      assert.equal(await snapshot(), before);
    } finally {
      await lock.release();
    }
    console.log('PASS 15 验收 6：真实 CLI 独占锁竞争零修改');
    // 每个阶段都在真实 PG 中注入失败；子进程确实走到 SQL，恢复沿用同批 id。
    let batch: string | undefined;
    for (const phase of ['revoked', 'erased', 'seeded', 'verified', 'complete']) {
      await fx.query(
        `create or replace function trial_test_fail() returns trigger language plpgsql as $$ begin if NEW.action='trial_reset.checkpoint' and NEW.diff->>'phase'='${phase}' then raise exception 'synthetic_stage_failure'; end if; return NEW; end $$`,
      );
      await fx.query('create trigger trial_test_failure before insert on audit_log for each row execute function trial_test_fail()');
      const failed = await cli(batch);
      assert.equal(failed.code, 1, failed.output);
      const batches = await read(readTrialBatches);
      assert.equal(batches.size, 1);
      batch = [...batches.keys()][0]!;
      await assert.rejects(read(assertTrialResetComplete), /trial_reset_incomplete/);
      assert.equal(
        (await read(trialConversations)).some((r) => r.id.startsWith('trialseed-')),
        ['verified', 'complete'].includes(phase),
      );
      await fx.query('drop trigger trial_test_failure on audit_log');
      console.log(`PASS 15 验收 6：${phase} 故障关闭、批次固定、可恢复`);
    }
    const completed = await cli(batch);
    assert.equal(completed.code, 0, completed.output);
    await read(assertTrialResetComplete);
    assert.equal(await authSessionTouch(app.db, id, tokenHash, new Date()), null, '旧 cookie 失效');
    const rows = await read(trialConversations);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.state.seed === true && r.state.channel === 'simulator' && !r.state.channelAccountId));
    assert.ok(rows.every((r) => Number.isInteger(r.state.seedBaselineSeq) && Number(r.state.seedBaselineSeq) > 0));
    assert.ok(!rows.some((r) => r.id === old.id));
    const checkpoint = (await read(readTrialBatches)).get(batch!)!.checkpoint;
    const auditText = JSON.stringify(await fx.query("select diff from audit_log where action='trial_reset.checkpoint'"));
    assert.ok(!auditText.includes(old.id) && !auditText.includes('synthetic-reset-password') && !auditText.includes('合成的真实试用消息'));
    const firstIds = rows.map((r) => r.id);
    const firstOrderIds = await read(trialOrderIds);
    assert.equal(firstOrderIds.length, 2);
    // 完成批次重跑也核验真实行，不重新改密、不新造 ID。
    const before = await snapshot();
    assert.equal((await cli(batch)).code, 0);
    assert.equal(await snapshot(), before);
    // 超期真实消息会清，种子即使超过 7 天仍保留；独立 trace 规则不变。
    await read((tx) => writeSeedSessions(tx, [{ ...old, id: 'wecom:wmExpire' }], []));
    // 仅在一次性测试库事务内构造已过期夹具；恢复时间触发器后才运行候选与真实清理。
    // purge 的 p_now 仍为当前时间，保留其 5 分钟偏差守卫。
    await fx.query('begin');
    try {
      await fx.query('alter table conversations disable trigger conversations_guard_updated_at');
      await fx.query(
        "update conversations set updated_at=date_trunc('milliseconds',now())-interval '8 days' where tenant_id=$1 and state->>'seed'='true'",
        [id],
      );
      await fx.query('alter table conversations enable trigger conversations_guard_updated_at');
      await fx.query('commit');
    } catch (error) {
      await fx.query('rollback');
      throw error;
    }
    const retentionNow = new Date();
    const candidates = await read((tx) => readPurgeCandidates(tx, new Date(retentionNow.getTime() - 7 * 86400000), null, 100));
    assert.deepEqual(
      candidates.map((r) => r.id),
      ['wecom:wmExpire'],
    );
    const c = candidates[0]!;
    assert.equal(await read((tx) => purgeConversation(tx, c.id, retentionNow, c.lastSeq, c.updatedAt)), true);
    assert.equal((await read(trialConversations)).length, 5);
    // 新一批同时清种子与真实消息，老订单去关联留存，新链接不可复用。
    await read((tx) => writeSeedSessions(tx, [{ ...old, id: 'wecom:wmReset' }], []));
    await review();
    const second = await cli();
    assert.equal(second.code, 0, second.output);
    assert.ok((await read(trialConversations)).every((r) => !firstIds.includes(r.id)));
    assert.equal((await read(trialOrderIds)).length, 4);
    const oldOrders = await fx.query<{ session_id: string | null; data: Record<string, unknown> }>(
      'select session_id,data from orders where tenant_id=$1 and id=any($2)',
      [id, firstOrderIds],
    );
    assert.ok(oldOrders.every((r) => r.session_id === null && !r.data.sessionId));
    assert.equal(checkpoint.seedIds.length, 5);
    assert.deepEqual(await fx.query('select count(*)::int n from conversations where tenant_id=$1', [fx.tenantId]), [{ n: 0 }]);
    assert.deepEqual(
      await fx.query('select retention_lead_days,retention_customer_days,retention_trace_days from tenants where id=$1', [fx.tenantId]),
      [{ retention_lead_days: 180, retention_customer_days: 730, retention_trace_days: 90 }],
    );
    console.log('PASS 15 验收 6：7 天真实消息清理、种子豁免、两类手动重建、旧 cookie/链接失效、订单留存、宿主保留期不变');
    // 在阶段已提交、下一阶段事务正阻塞时 SIGKILL 真实 CLI，覆盖真正进程崩溃，不仅是返回错误。
    await review();
    let crashBatch: string | undefined;
    for (const [committed, next] of [
      ['planned', 'revoked'],
      ['revoked', 'erased'],
      ['erased', 'seeded'],
      ['seeded', 'verified'],
      ['verified', 'complete'],
    ]) {
      await fx.query(
        `create or replace function trial_test_pause() returns trigger language plpgsql as $$ begin if NEW.action='trial_reset.checkpoint' and NEW.diff->>'phase'='${next}' then perform pg_sleep(30); end if; return NEW; end $$`,
      );
      await fx.query('create trigger trial_test_paused before insert on audit_log for each row execute function trial_test_pause()');
      const result = await cli(crashBatch, async (kill) => {
        const deadline = Date.now() + 18_000;
        let sleeping = false;
        while (Date.now() < deadline) {
          const rows = await fx.query<{ pid: number }>(
            "select pid from pg_stat_activity where datname=current_database() and wait_event='PgSleep'",
          );
          if (rows.length) {
            sleeping = true;
            kill();
            await fx.query(
              "select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and wait_event='PgSleep'",
            );
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(sleeping, `CLI reached ${next}`);
      });
      assert.equal(result.code, null);
      const latest = [...(await read(readTrialBatches)).values()].at(-1)!;
      crashBatch = latest.checkpoint.batch;
      assert.equal(latest.checkpoint.phase, committed);
      await assert.rejects(read(assertTrialResetComplete), /trial_reset_incomplete/);
      await fx.query('drop trigger trial_test_paused on audit_log');
      console.log(`PASS 15 验收 6：${committed} 提交后 SIGKILL，重跑同批恢复`);
    }
    assert.equal((await cli(crashBatch)).code, 0);
    // 失锁在读完口令之后、写改密之前触发：平台事务不得开始，批次保持 planned。
    await review();
    let lose: (() => void) | undefined;
    await assert.rejects(
      resetTrial({
        app: app.db,
        platform: platform.db,
        tenantSlug: 'trial-industry',
        hostSlug: 'trial-host',
        varDir: dataDir,
        approval: approval!,
        lock: async () => {
          const held = await holdTenantLock(fx.urls.app, id);
          assert.ok(held);
          return {
            ...held,
            onLost: (cb) => {
              lose = cb;
              held.onLost(cb);
            },
          };
        },
        password: async () => {
          lose!();
          return 'synthetic-locklost-password';
        },
      }),
      /trial_lock_lost/,
    );
    assert.equal([...(await read(readTrialBatches)).values()].at(-1)!.checkpoint.phase, 'planned');
    console.log('PASS 15 验收 6：失锁停止，未完成批次阻止开放');
    assert.equal(await foreign(), foreignBefore, '旅游及另一正式租户的会话/消息状态原样保留');
    console.log('PASS 15 验收 6：第三个正式租户与旅游隔离，重置/崩溃不改其他公司的数据');
    // 留下的 pending 在 finally 随一次性库删除，不会连接其他环境。
  } finally {
    await app.close();
    await platform.close();
    await fx.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
