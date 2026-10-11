// 05 第 14 步：发布快照、原子开通、失败回收、串行上限与真实 PG 重启装载。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { createRealPgFixture, openTestDb, fakeLock, testConfigDeps } from '../../db/testing.js';
import { holdTenantLocks, openDb, type Db, type TenantLock } from '../../db/client.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig, currentCatalog, currentSop } from '../../config/source.js';
import { readSandboxTemplate } from '../../db/repo/sandbox.js';
import { listSessions, getOrder } from '../../store.js';
import { currentPrivacyNotice } from '../../privacy/privacy.js';
import { dropShutdownHooks } from '../../shutdown.js';
import {
  configureTenancy,
  createTenantRuntime,
  runtimeOf,
  tenantRuntimes,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
} from '../runtime.js';
import { dropTenantState, tenantKeys } from '../state.js';
import { SandboxProcess } from './process.js';
import { provisionSandbox, SandboxProvisionError, type ProvisionOptions } from './provision.js';
import { loadSandboxRuntime } from './load.js';
import { runTenantBrand } from '../../cli/tenant-brand.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';

type Query = <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<R[]>;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
async function releaseRuntimes(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    rt.state = 'closed';
    tenantStoreIfLoaded(rt)?.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropTenantState(rt.id);
    dropShutdownHooks(rt);
    unregisterRuntime(rt.id);
    check(() => assert.ok(Object.values(tenantKeys(rt.id)).every((n) => n === 0)));
  }
}

async function suite(
  db: Db,
  q: Query,
  acquire: (id: string) => Promise<TenantLock | null>,
  real: boolean,
  restart?: () => Promise<void>,
  setPending?: () => Promise<void>,
): Promise<void> {
  process.env.SESSION_STORE = 'db';
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [host] = await q<{ id: string }>("select id from tenants where slug='template'");
  const hostId = host!.id;
  const inputRuntime = createTenantRuntime({ id: hostId, slug: 'template' });
  const deps = testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  await q('update tenants set brand=$2::json where id=$1', [hostId, JSON.stringify(shanhaiBrand)]);
  const imported = await withTenantScope(inputRuntime, () =>
    importConfig({
      db,
      tenantSlug: 'template',
      dataDir: 'data',
      imageSop: deps.imageSop,
      lock: async () => fakeLock(),
    }),
  );
  check(() => assert.equal(imported.code, 0, imported.message));
  // 模板 active 的 ord 有空洞，历史版本与草稿不得混进副本。
  await q(
    "insert into catalog_items(tenant_id,kind,code,ord,status,payload) select tenant_id,kind,'extra-route',123,'active',jsonb_set(payload::jsonb,'{id}',to_jsonb('extra-route'::text))::json from catalog_items where tenant_id=$1 and kind='route' limit 1",
    [hostId],
  );
  await q(
    "insert into catalog_items(tenant_id,kind,code,ord,status,payload) select tenant_id,kind,'draft-only',999,'draft',jsonb_set(payload::jsonb,'{id}',to_jsonb('draft-only'::text))::json from catalog_items where tenant_id=$1 and kind='route' limit 1",
    [hostId],
  );
  await q(
    "insert into quick_replies(tenant_id,ord,title,body,updated_by_name) values($1,7,'快捷一','模板正文','宿主成员'),($1,19,'快捷二','第二条','宿主成员')",
    [hostId],
  );
  await q("insert into quick_replies(tenant_id,ord,title,body,archived_at) values($1,8,'已归档','不复制',now())", [hostId]);
  // 只复制当前隐私说明正文；沙箱从版本 1 开始，不复制宿主历史与发布人。
  await q(
    "insert into privacy_notices(tenant_id,version,body,published_by_name,published_at) values($1,1,'旧隐私说明','宿主成员','2026-01-01'),($1,2,'宿主当前隐私说明\n第二行','宿主成员','2026-01-02')",
    [hostId],
  );
  // 待生效品牌与已发布品牌不同；开通只能取发布快照。
  if (setPending) await setPending();
  else await q('update tenants set brand=$2::json where id=$1', [hostId, JSON.stringify({ ...shanhaiBrand, brandName: '待生效品牌' })]);
  const template = await readSandboxTemplate(db, 'template');
  check(() => assert.deepEqual(template.pub.renderInputs?.brand, shanhaiBrand));
  const snapshot = async () => {
    const tables = await q<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id' order by table_name",
    );
    const out: Record<string, unknown> = {};
    for (const { table_name: table } of tables) {
      assert.match(table, /^[a-z_]+$/);
      out[table] = await q(`select to_jsonb(r) as r from "${table}" r where tenant_id=$1 order by to_jsonb(r)::text`, [hostId]);
    }
    out.tenant = await q('select to_jsonb(t) as t from tenants t where id=$1', [hostId]);
    return out;
  };
  const before = await snapshot();
  const base: ProvisionOptions = {
    deps,
    templateSlug: 'template',
    host: 'sandbox.example.invalid',
    epoch: '0',
    acquireTenant: acquire,
    ip: null,
    userAgent: 'selftest',
  };
  const limited = (error: unknown) => error instanceof SandboxProvisionError && error.reason === 'sandbox_limited' && error.status === 429;
  const unavailable = (error: unknown) => error instanceof SandboxProvisionError && error.status === 503;
  const [privilege] = await q<{ allowed: boolean }>("select has_table_privilege('agent_app','privacy_notices','INSERT') as allowed");
  check(() => assert.equal(privilege!.allowed, false));
  check(() => assert.equal(template.privacy?.version, 2));
  const durations: number[] = [];
  const open = async () => {
    const start = performance.now();
    const result = await provisionSandbox(base);
    durations.push(performance.now() - start);
    return result;
  };
  const first = await open();
  check(() => assert.match(first.slug, /^sbx-[a-z2-7]{20}$/));
  check(() => assert.match(first.token, /^[A-Za-z0-9_-]{43}$/));
  check(() => assert.equal(first.user.role, 'owner'));
  const rt = runtimeOf(first.tenantId)!;
  const verify = () =>
    withTenantScope(rt, () => {
      const sessions = listSessions();
      check(() => assert.equal(sessions.length, 13));
      check(() => assert.ok(sessions.every((s) => /^sbx-[a-f0-9]{32}$/.test(s.id) && s.channel === 'simulator')));
      const fixture = JSON.parse(fs.readFileSync('data/sandbox-seeds.json', 'utf8')) as { orders: { id: string }[] };
      for (const { id } of fixture.orders) check(() => assert.ok(getOrder(id) && sessions.some((s) => s.id === getOrder(id)!.sessionId)));
      check(() =>
        assert.equal(
          Math.max(...sessions.flatMap((s) => s.messages.map((m) => m.at))),
          first.expiresAt.getTime() - 24 * 60 * 60_000 - 5 * 60_000,
        ),
      );
      for (const key of ['promptHash', 'toolsHash', 'prefixHash', 'sopHash'] as const)
        check(() => assert.equal(currentSop()[key], template.pub[key]));
      check(() => assert.deepEqual(currentSop().brand, shanhaiBrand));
      check(() => assert.equal(currentCatalog().routes.length + currentCatalog().hotels.length, template.items.length));
      check(() => assert.deepEqual(currentPrivacyNotice(), { version: 1, body: template.privacy!.body }));
    });
  verify();
  const [auth] = await q<{ token_hash: Buffer; user_id: string; ok: boolean }>(
    'select s.token_hash,s.user_id,s.expires_at=t.expires_at as ok from auth_sessions s join tenants t on t.id=s.tenant_id where tenant_id=$1',
    [first.tenantId],
  );
  check(() => assert.deepEqual(Buffer.from(auth!.token_hash), createHash('sha256').update(first.token).digest()));
  check(() => assert.equal(auth!.user_id, first.userId));
  check(() => assert.ok(auth!.ok));
  const config = await q<{ ord: number; version: number; updated_by_name: string | null }>(
    'select ord,version,updated_by_name from catalog_items where tenant_id=$1 order by kind,ord',
    [first.tenantId],
  );
  check(() =>
    assert.deepEqual(
      config.map((r) => r.ord),
      template.items.map((r) => r.ord),
    ),
  );
  check(() => assert.ok(config.every((r) => r.version === 1 && r.updated_by_name === null)));
  const replies = await q('select ord,title,body,updated_by_name from quick_replies where tenant_id=$1 order by ord', [first.tenantId]);
  check(() =>
    assert.deepEqual(
      replies,
      template.replies.map(({ ord, title, body }) => ({ ord, title, body, updated_by_name: null })),
    ),
  );
  const [sop] = await q<{ ok: boolean }>(
    'select version_no=1 and based_on is null and created_by is null and created_by_name is null and change_note is null as ok from sop_versions where tenant_id=$1',
    [first.tenantId],
  );
  check(() => assert.ok(sop!.ok));
  const privacy = await q<{ version: number; body: string; published_by_name: string | null; fresh: boolean }>(
    'select version,body,published_by_name,published_at=t.created_at as fresh from privacy_notices p join tenants t on t.id=p.tenant_id where p.tenant_id=$1',
    [first.tenantId],
  );
  check(() => assert.deepEqual(privacy, [{ version: 1, body: template.privacy!.body, published_by_name: null, fresh: true }]));
  const [link] = await q<{ link_token: string }>('select link_token from sandbox_wechat where tenant_id=$1', [first.tenantId]);
  check(() => assert.match(link!.link_token, /^[A-Za-z0-9_-]{43}$/));
  for (const table of ['channel_accounts', 'jobs', 'turn_traces', 'usage_daily', 'consents']) {
    const [r] = await q<{ n: number }>(`select count(*)::int as n from ${table} where tenant_id=$1`, [first.tenantId]);
    check(() => assert.equal(r!.n, 0, table));
  }
  const [audit] = await q<{ action: string }>('select action from audit_log where tenant_id=$1', [first.tenantId]);
  check(() => assert.equal(audit!.action, 'sandbox.create'));
  const poolBefore = await q('select * from sandbox_pool_daily');
  await assert.rejects(() => provisionSandbox({ ...base, epoch: '-1' }), unavailable);
  checks++;
  const poolAfter = await q('select * from sandbox_pool_daily');
  check(() => assert.deepEqual(poolAfter, poolBefore));
  // 取不到新租户锁：已提交的数据标到期，运行时不得发布。
  await assert.rejects(() => provisionSandbox({ ...base, acquireTenant: async () => null }), unavailable);
  const [expired] = await q<{ n: number }>("select count(*)::int as n from tenants where kind='sandbox' and expires_at<=now()");
  check(() => assert.equal(expired!.n, 1));
  check(() => assert.equal(tenantRuntimes().filter((r) => r.kind === 'sandbox').length, 1));
  const ids = listSessionIds(rt);
  // 回滚后互斥链仍可开通；成功开满 20 个，包括并发的最后两个请求。
  for (let i = 0; i < 18; i++) await open();
  const last = await Promise.allSettled([open(), open()]);
  check(() => assert.equal(last.filter((r) => r.status === 'fulfilled').length, 1));
  check(() => assert.ok(last.some((r) => r.status === 'rejected' && limited(r.reason))));
  check(() => assert.equal(durations.length, 20));
  const p95 = durations.toSorted((a, b) => a - b)[18]!;
  check(() => assert.ok(p95 <= 3000, `p95=${p95.toFixed(1)}ms`));
  const second = tenantRuntimes().find((r) => r.kind === 'sandbox' && r.id !== first.tenantId)!;
  check(() => assert.ok(listSessionIds(second).every((id) => !ids.includes(id))));
  const after = await snapshot();
  check(() => assert.deepEqual(after, before));
  if (restart) {
    await releaseRuntimes();
    await restart();
    check(() => assert.equal(tenantRuntimes().length, 20));
    const restored = runtimeOf(first.tenantId)!;
    check(() => assert.deepEqual(listSessionIds(restored), ids));
    for (const loaded of tenantRuntimes()) withTenantScope(loaded, () => check(() => assert.equal(listSessions().length, 13)));
  } else {
    await releaseRuntimes();
    const loaded = await loadSandboxRuntime(deps, { id: first.tenantId, slug: first.slug, expiresAt: first.expiresAt }, base.host, acquire);
    check(() => assert.ok(loaded));
    check(() => assert.deepEqual(listSessionIds(loaded!), ids));
  }
  console.log(`SELFTEST ${real ? '真实 PG' : 'PGlite'}: 20 次开通 p95=${p95.toFixed(1)}ms，宿主行与四个哈希不变`);
}
function listSessionIds(rt: import('../runtime.js').TenantRuntime): string[] {
  return withTenantScope(rt, () =>
    listSessions()
      .map((s) => s.id)
      .toSorted(),
  );
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-provision-'));
try {
  const t = await openTestDb();
  try {
    await t.pg.query("insert into tenants(slug,name,pack_id) values('template','模板','travel')");
    const q: Query = async (text, values = []) => {
      await t.pg.exec('RESET ROLE');
      try {
        return (await t.pg.query(text, values)).rows as never;
      } finally {
        await t.pg.exec('SET ROLE agent_app');
      }
    };
    await t.pg.exec('SET ROLE agent_app');
    await suite(t.db, q, async () => fakeLock(), false);
  } finally {
    await releaseRuntimes();
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const f = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'template' });
    let app: Awaited<ReturnType<typeof openDb>> | null = null;
    let locks: Awaited<ReturnType<typeof holdTenantLocks>> = null;
    const restarted = new SandboxProcess(
      {
        APP_ROLE: 'sandbox',
        DEPLOY_PROFILE: 'demo',
        CONFIG_SOURCE: 'db',
        SESSION_STORE: 'db',
        SANDBOX_HOST: 'sandbox.example.invalid',
        SANDBOX_TEMPLATE_SLUG: 'template',
        DATABASE_URL: f.urls.app,
      },
      () => {
        throw new Error('unexpected fail-stop');
      },
    );
    try {
      app = await openDb(f.urls.app);
      // 同一连接持有实例锁与宿主模板锁，证明复制期间不尝试取得宿主租户锁。
      locks = await holdTenantLocks(f.urls.app, ['sandbox-process', f.tenantId]);
      assert.ok(locks);
      await suite(
        app.db,
        f.query,
        (id) => locks!.acquireTenant(id),
        true,
        async () => {
          await locks!.release();
          locks = null;
          await app!.close();
          app = null;
          // 全新 Node 进程只有数据库可读，不能靠父进程的 identity map 恢复种子。
          const child = spawnSync(
            process.execPath,
            [
              '--import',
              'tsx',
              '--input-type=module',
              '--eval',
              `
            const { SandboxProcess } = await import('./src/tenancy/sandbox/process.ts');
            const { tenantRuntimes, withTenantScope } = await import('./src/tenancy/runtime.ts');
            const { listSessions } = await import('./src/store.ts');
            const service = new SandboxProcess(process.env);
            await service.start();
            const restored = tenantRuntimes().map(rt => withTenantScope(rt, () => ({
              id: rt.id, sessions: listSessions().map(s => s.id).sort(),
            })));
            await service.close();
            console.log('RESTORED:' + JSON.stringify(restored));
          `,
            ],
            {
              env: {
                PATH: process.env.PATH,
                APP_ROLE: 'sandbox',
                DEPLOY_PROFILE: 'demo',
                CONFIG_SOURCE: 'db',
                SESSION_STORE: 'db',
                SANDBOX_HOST: 'sandbox.example.invalid',
                SANDBOX_TEMPLATE_SLUG: 'template',
                DATABASE_URL: f.urls.app,
                LLM_MOCK: '1',
              },
              encoding: 'utf8',
              timeout: 30_000,
              killSignal: 'SIGKILL',
            },
          );
          check(() => assert.equal(child.status, 0, child.stderr));
          const restored = JSON.parse(
            child.stdout
              .split('\n')
              .find((line) => line.startsWith('RESTORED:'))!
              .slice(9),
          ) as {
            id: string;
            sessions: string[];
          }[];
          check(() => assert.equal(restored.length, 20));
          check(() => assert.ok(restored.every((row) => row.sessions.length === 13)));
          await restarted.start();
        },
        async () => {
          const file = path.join(temp, 'pending-brand.json');
          fs.writeFileSync(file, JSON.stringify({ ...shanhaiBrand, brandName: '待生效品牌' }));
          const code = await runTenantBrand(['set', '--tenant', 'template', '--brand-file', file], {
            connect: () => openDb(f.urls.platform),
          });
          check(() => assert.equal(code, 0));
        },
      );
    } finally {
      await restarted.close();
      await releaseRuntimes();
      await locks?.release();
      await app?.close();
      await f.drop();
    }
  } else console.log('SKIP: 真实 PG 与进程重启验收需要 PG_TEST_URL');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`SELFTEST PASS: 沙箱开通 ${checks} 项`);
