// R12 ①–⑥ 与验收 9：实际数据库、运行时、迟到结果和跨连接故障。
import '../../selftest-env.js';
import { realReaperFixture } from '../../db/testing-reaper.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connectSuperQuery, openTestDb, fakeLock, testConfigDeps, type FakeLock } from '../../db/testing.js';
import { holdTenantLocks, withNewSandboxTenant, withTenant, type Db, type TenantLock } from '../../db/client.js';
import { expireBrokenSandbox, systemContext } from '../../db/sandbox-process.js';
import { listSandboxes } from '../../db/sandbox-reaper.js';
import { addUsage } from '../../db/repo/usage.js';
import { importConfig } from '../../config/transfer.js';
import { currentCatalog } from '../../config/source.js';
import { updateCatalogItem } from '../../config/catalog.js';
import { getDraftReply } from '../../core/insight.js';
import { handleMessage } from '../../core/engine/index.js';
import { buildIndex, indexReady } from '../../core/retrieval.js';
import { listSessions, saveSession } from '../../store.js';
import { recordUsage } from '../../usage.js';
import { gatedFetch, gateStatus } from '../../llm-gate.js';
import { startUsageDaily, __usageDailyTest } from '../../trace/usage-daily.js';
import { __alertTest } from '../../ops/alert.js';
import { onShutdown, runShutdownHooks, dropShutdownHooks } from '../../shutdown.js';
import { addListener } from '../../console-api/events.js';
import { subscribe } from '../../adapters/simulator.js';
import { subscribeWeb } from '../../adapters/web.js';
import { onTurnEnd } from '../../trace/recorder.js';
import { runSandbox } from '../../cli/sandbox.js';
import {
  configureTenancy,
  createTenantRuntime,
  runtimeOf,
  tenantRuntimes,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
} from '../runtime.js';
import { dropTenantState, registerTenantState, tenantKeys } from '../state.js';
import { SandboxReaper, settleWithin } from './reaper.js';
import { provisionSandbox } from './provision.js';
import { resolveSandboxSession } from './session.js';
import { sandboxApp, SandboxProcess } from './process.js';

type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
let checks = 0;
function check(value: unknown, message: string): void {
  assert.ok(value, message);
  checks++;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function clean(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    rt.state = 'closed';
    tenantStoreIfLoaded(rt)?.pgBackend?.close();
    await rt.config.loaded?.lock.release();
    dropTenantState(rt.id);
    dropShutdownHooks(rt);
    unregisterRuntime(rt.id);
  }
}
async function zero(q: Query, id: string, slug: string): Promise<void> {
  const tables = await q<{ name: string }>(`select c.relname as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    where n.nspname='public' and c.relkind='r' and a.attname='tenant_id' and not a.attisdropped`);
  for (const { name } of tables) {
    assert.match(name, /^[a-z_]+$/);
    const [r] = await q<{ n: string }>(`select count(*) as n from "${name}" where tenant_id=$1`, [id]);
    check(Number(r!.n) === 0, `超级用户 ${name} 无残留`);
  }
  check((await q('select id from tenants where id=$1', [id])).length === 0, '租户行删除');
  check(!runtimeOf(id), '运行时注册表无残留');
  check((await q('select id from users where email=$1', [`${slug}@sandbox.invalid`])).length === 0, '合成用户删除');
  check(
    Object.values(tenantKeys(id)).every((n) => n === 0),
    '逐登记项清零，含 hooks 与观察器',
  );
}

async function suite(db: Db, q: Query, acquire: (id: string) => Promise<TenantLock | null>, realUrl?: string): Promise<void> {
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  process.env.SESSION_STORE = 'db';
  process.env.LLM_MOCK = '1';
  const [host] = await q<{ id: string }>("insert into tenants(slug,name,pack_id) values('reaper-template','模板','travel') returning id");
  const hostRt = createTenantRuntime({ id: host!.id, slug: 'reaper-template' });
  const deps = testConfigDeps({ db }, { tenantSlug: hostRt.slug, usePackRuntime: true });
  const imported = await withTenantScope(hostRt, () =>
    importConfig({ db, tenantSlug: hostRt.slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  check(imported.code === 0, '导入真实模板');
  const reaper = new SandboxReaper({ db, acquireTenant: acquire, idleMs: 120 * 60_000, barrierMs: 15 });
  async function box() {
    const b = await provisionSandbox({
      deps,
      templateSlug: hostRt.slug,
      host: 'sandbox.example.invalid',
      epoch: '0',
      ip: null,
      userAgent: null,
      acquireTenant: acquire,
    });
    const rt = runtimeOf(b.tenantId)!;
    reaper.touch(rt);
    const backend = tenantStoreIfLoaded(rt)!.pgBackend!;
    const close = backend.close.bind(backend);
    let closes = 0;
    backend.close = () => {
      closes++;
      close();
    };
    return { ...b, rt, backend, closed: () => closes };
  }
  async function expire(b: Awaited<ReturnType<typeof box>>) {
    await expireBrokenSandbox(db, b.tenantId);
  }

  // ① 同步 closing、HTTP 410、SSE 真关闭、回调异常时不推进。
  const a = await box();
  const survivor = await box();
  let consoleClosed = 0,
    simulatorClosed = 0,
    webClosed = 0,
    shutdownCalls = 0;
  withTenantScope(a.rt, () => {
    addListener(
      () => {},
      () => {
        consoleClosed++;
      },
    );
    subscribe(
      'sbx-test',
      () => {},
      () => {
        simulatorClosed++;
      },
    );
    subscribeWeb(
      'web-test',
      'test-ip',
      () => {},
      () => {
        webClosed++;
      },
    );
    onShutdown(() => {
      shutdownCalls++;
    });
    onTurnEnd(() => {});
  });
  let otherClosed = 0;
  withTenantScope(survivor.rt, () =>
    addListener(
      () => {},
      () => {
        otherClosed++;
      },
    ),
  );
  let failClose = true;
  const off = withTenantScope(a.rt, () =>
    addListener(
      () => {},
      () => {
        if (failClose) throw new Error('close_failed');
      },
    ),
  );
  await expire(a);
  await reaper.tick();
  check(a.rt.state === 'closing' && a.closed() === 0 && runtimeOf(a.rt.id) === a.rt, '① 失败保留后端与运行时');
  check((await resolveSandboxSession(db, a.token)).status === 'expired', '过期未删 cookie 为 expired');
  failClose = false;
  off();
  await reaper.tick();
  check(consoleClosed > 0 && simulatorClosed > 0 && webClosed === 1 && otherClosed === 0, '只关闭所属 SSE，网页订阅随 drop 释放');
  await zero(q, a.rt.id, a.slug);
  check((await resolveSandboxSession(db, a.token)).status === 'invalid', '删除后 cookie 为 invalid');
  await runShutdownHooks(30);
  check(shutdownCalls === 0, '删除后停机不调用旧后端闭包');

  // ② abort 后 promise 未落定仍留在登记；拒绝与提交均可落定。
  const blocked = await box();
  const gate = deferred<void>();
  blocked.rt.inflight.track(gate.promise).catch(() => {});
  await expire(blocked);
  await reaper.tick();
  check(blocked.rt.cancel.aborted && blocked.rt.inflight.size === 1 && blocked.closed() === 0, '② 超时不摘登记、不关后端');
  check(runtimeOf(blocked.rt.id) === blocked.rt, '② 超时不摘运行时');
  gate.reject(new Error('rolled_back'));
  await blocked.rt.inflight.drain();
  await reaper.tick();
  await zero(q, blocked.rt.id, blocked.slug);

  // closing 与取消信号之间的空窗：排队请求拿到名额后也不得发起 fetch。
  const cap = gateStatus().maxInflight;
  if (cap > 0) {
    const holder = await box();
    const queued = await box();
    const filled = deferred<void>();
    const responses: ReturnType<typeof deferred<Response>>[] = [];
    let fetches = 0;
    const beforeFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetches++;
      const response = deferred<Response>();
      responses.push(response);
      if (fetches === cap) filled.resolve();
      return response.promise;
    };
    try {
      const requests = Array.from({ length: cap }, () =>
        withTenantScope(holder.rt, () =>
          gatedFetch('https://model.example.invalid/chat/completions', { body: '{}' }, () => AbortSignal.timeout(10_000)),
        ),
      );
      await filled.promise;
      const waiting = withTenantScope(queued.rt, () =>
        gatedFetch('https://model.example.invalid/chat/completions', { body: '{}' }, () => AbortSignal.timeout(10_000)),
      );
      void waiting.catch(() => {});
      check(gateStatus().waiting === 1, '请求已在实例闸排队');
      await reaper.end(queued.rt.id); // 尚未 tick，因此 cancel 还没有触发。
      check(!queued.rt.cancel.aborted, 'closing 在 cancel 之前当刻生效');
      for (const response of responses) response.resolve(new Response('{}'));
      const completed = await Promise.all(requests);
      await assert.rejects(waiting, /tenant_closing/);
      checks++;
      check(fetches === cap, '关闭中的排队请求没有发出额外 fetch');
      for (const result of completed) {
        withTenantScope(holder.rt, () => result.settleUsage(null));
        await result.res.body?.cancel();
      }
      await reaper.tick();
      await zero(q, queued.rt.id, queued.slug);
      await expire(holder);
      await reaper.tick();
      await zero(q, holder.rt.id, holder.slug);
    } finally {
      globalThis.fetch = beforeFetch;
    }
  }

  // 模型忽略 abort，30 秒后才返回；草稿缓存不能采纳迟到结果。
  const late = await box();
  const response = deferred<Response>();
  const started = deferred<void>();
  const fetchBefore = globalThis.fetch;
  process.env.LLM_MOCK = '0';
  process.env.LLM_API_KEY = 'selftest';
  process.env.LLM_PROVIDER = '';
  globalThis.fetch = async () => {
    started.resolve();
    return response.promise;
  };
  let draft: Promise<string>;
  try {
    draft = withTenantScope(late.rt, () => getDraftReply(listSessions()[0]!));
    await started.promise;
    await expire(late);
    const longReaper = new SandboxReaper({ db, acquireTenant: acquire, idleMs: 120 * 60_000, barrierMs: realUrl ? 30_000 : 15 });
    await longReaper.tick();
    check(late.closed() === 0 && late.rt.inflight.size > 0, '② 模型超过屏障仍不提前删除');
    response.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '迟到的草稿' } }] }), { status: 200 }));
    check((await draft) === '', '迟到草稿不采纳');
    check(tenantKeys(late.rt.id)['insight.draftCache'] === 0, '迟到草稿没有写缓存');
    await longReaper.tick();
    await zero(q, late.rt.id, late.slug);
    longReaper.stop();
  } finally {
    globalThis.fetch = fetchBefore;
    process.env.LLM_MOCK = '1';
  }

  // 主对话与 embedding 同样覆盖完整响应读取；关闭后无兜底回复或索引落地。
  const main = await box();
  const mainResponse = deferred<Response>();
  const mainStarted = deferred<void>();
  process.env.LLM_MOCK = '0';
  globalThis.fetch = async () => {
    mainStarted.resolve();
    return mainResponse.promise;
  };
  try {
    const session = withTenantScope(main.rt, () => listSessions()[0]!);
    const turn = withTenantScope(main.rt, () => handleMessage(session.id, '推荐一个三亚的行程，2个人，预算每人2万', 'simulator'));
    await mainStarted.promise;
    const before = JSON.stringify(session);
    await expire(main);
    await reaper.tick();
    mainResponse.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '迟到主对话' } }] }), { status: 200 }));
    check((await turn).silent && JSON.stringify(session) === before, '迟到主对话无消息、画像或阶段改动');
    await reaper.tick();
    await zero(q, main.rt.id, main.slug);
  } finally {
    globalThis.fetch = fetchBefore;
    process.env.LLM_MOCK = '1';
  }
  const embedding = await box();
  const embedResponse = deferred<Response>();
  const embedStarted = deferred<void>();
  process.env.LLM_MOCK = '0';
  process.env.EMBED_API_KEY = 'selftest';
  let embedSignal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    embedSignal = init?.signal ?? undefined;
    embedStarted.resolve();
    return embedResponse.promise;
  };
  try {
    const building = withTenantScope(embedding.rt, buildIndex);
    void building.catch(() => {});
    await embedStarted.promise;
    await expire(embedding);
    await reaper.tick();
    check(embedding.rt.inflight.size > 0 && embedSignal?.aborted, 'embedding 请求登记直到落定，并收到 cancel');
    embedResponse.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await Promise.allSettled([building]);
    check(!withTenantScope(embedding.rt, indexReady), '迟到 embedding 不发布索引');
    await reaper.tick();
    await zero(q, embedding.rt.id, embedding.slug);
  } finally {
    globalThis.fetch = fetchBefore;
    process.env.LLM_MOCK = '1';
    process.env.EMBED_API_KEY = '';
  }

  // ③ writer 持续失败停在原地；恢复后先刷用量，再关闭，再 purge。
  const usage = await box();
  let writerFails = true;
  const order: string[] = [];
  withTenantScope(usage.rt, () => recordUsage('glm-5.3-flashx', 1000, 100));
  await withTenantScope(usage.rt, () =>
    startUsageDaily(async (deltas) => {
      order.push('usage');
      if (writerFails) throw new Error('write_failed');
      await withTenant(db, systemContext(usage.rt.id), (tx) => addUsage(tx, deltas));
    }),
  );
  const baseClose = usage.backend.close.bind(usage.backend);
  usage.backend.close = () => {
    order.push('close');
    baseClose();
  };
  await expire(usage);
  await reaper.tick();
  check(usage.closed() === 0 && runtimeOf(usage.rt.id) === usage.rt, '③ 失败不关后端、不释放');
  check(
    withTenantScope(usage.rt, () => __usageDailyTest.pending()).some((r) => r.calls > 0),
    '③ 用量保留',
  );
  const [poolBefore] = await q<{ calls: number; cost: number; purged: number }>(
    'select coalesce(sum(calls),0)::int as calls, coalesce(sum(cost_milli),0)::int as cost, coalesce(sum(purged),0)::int as purged from sandbox_pool_daily',
  );
  writerFails = false;
  await reaper.tick();
  check(order.at(-1) === 'close', '③ 落库先于 ④ 关闭');
  const [poolAfter] = await q<{ calls: number; cost: number; purged: number }>(
    'select coalesce(sum(calls),0)::int as calls, coalesce(sum(cost_milli),0)::int as cost, coalesce(sum(purged),0)::int as purged from sandbox_pool_daily',
  );
  check(poolAfter!.calls === poolBefore!.calls + 1, '⑤ 全池合并该次用量一次');
  check(poolAfter!.cost === poolBefore!.cost + 2, '⑤ 全池合并真实模型费用');
  check(poolAfter!.purged === poolBefore!.purged + 1, '⑤ 全池删除数只增加一次');
  await zero(q, usage.rt.id, usage.slug);

  // ④ 关闭失败仍保留锁；重来只关后端，不重复刷用量。
  const closeFault = await box();
  let failBackend = true;
  const goodClose = closeFault.backend.close;
  closeFault.backend.close = () => {
    if (failBackend) throw new Error('close_failed');
    goodClose();
  };
  await expire(closeFault);
  await reaper.tick();
  check(
    runtimeOf(closeFault.rt.id) === closeFault.rt && (await listSandboxes(db)).some((r) => r.id === closeFault.rt.id),
    '④ 失败不 purge',
  );
  failBackend = false;
  await reaper.tick();
  await zero(q, closeFault.rt.id, closeFault.slug);

  // ⑥ drop 失败可重试，已成功的 purge 不再重复记池。
  const dropFault = await box();
  let failDrop = true;
  registerTenantState({
    name: 'selftest.drop',
    keyCount: () => 0,
    reset: () => {},
    drop: (id) => {
      if (id === dropFault.rt.id && failDrop) throw new Error('drop_failed');
    },
  });
  await expire(dropFault);
  await reaper.tick();
  check(runtimeOf(dropFault.rt.id) === dropFault.rt, '⑥ 失败保留待释放运行时');
  failDrop = false;
  // 库行已删：下一拍仍必须处理未完成的 ⑥。
  await reaper.tick();
  await zero(q, dropFault.rt.id, dropFault.slug);

  // ⑤ 连续五次失败的告警；事务回滚后池计数没有重复。
  const failing = await box();
  await expire(failing);
  await q(`create function selftest_purge_failure() returns trigger language plpgsql as $$
    begin raise exception 'selftest_purge_failure'; end $$`);
  await q('create trigger selftest_purge_failure before delete on tenants for each row execute function selftest_purge_failure()');
  const warn = console.warn;
  const alerts: string[] = [];
  __alertTest.reset();
  console.warn = (...args) => {
    alerts.push(args.map(String).join(' '));
  };
  try {
    for (let n = 0; n < 5; n++) await reaper.tick();
  } finally {
    console.warn = warn;
  }
  check(
    alerts.some((s) => s.includes('连续失败')),
    '第五次 purge 失败发实例告警',
  );
  check(
    (await listSandboxes(db)).some((r) => r.id === failing.rt.id),
    '⑤ 失败行仍在',
  );
  await q('drop trigger selftest_purge_failure on tenants');
  await q('drop function selftest_purge_failure()');
  await reaper.tick();
  await zero(q, failing.rt.id, failing.slug);

  // ⑥ 租户锁释放失败也可重试，不重复 purge。
  const releaseFault = await box();
  const heldLock = releaseFault.rt.config.loaded!.lock;
  const releaseLock = heldLock.release.bind(heldLock);
  let failRelease = true;
  heldLock.release = async () => {
    if (failRelease) throw new Error('release_failed');
    await releaseLock();
  };
  await expire(releaseFault);
  await reaper.tick();
  check(!runtimeOf(releaseFault.rt.id), '⑥ 放锁失败前内存已摘');
  failRelease = false;
  await reaper.tick();
  await zero(q, releaseFault.rt.id, releaseFault.slug);

  // 结束体验与 idle，cookie 请求更新活动时间。
  const ended = await box();
  const pendingEnd = reaper.end(ended.rt.id);
  check(ended.rt.state === 'closing', '结束体验在第一个 await 前 closing');
  await pendingEnd;
  check(
    (await q("select id from audit_log where tenant_id=$1 and action='sandbox.end'", [ended.rt.id])).length === 1,
    '结束体验原子写入本租户审计',
  );
  await reaper.tick();
  await zero(q, ended.rt.id, ended.slug);
  const idle = await box();
  reaper.touch(idle.rt, Date.now() - 121 * 60_000);
  reaper.touch(survivor.rt);
  await reaper.tick();
  await zero(q, idle.rt.id, idle.slug);
  check(survivor.rt.state === 'serving', '活动租户不回收');

  if (realUrl) {
    // 被另一连接行锁挡住的真实配置事务，30 秒后仍停 ②。
    const config = await box();
    const blocker = await connectSuperQuery(realUrl);
    const item = withTenantScope(config.rt, () => currentCatalog().routes[0]!);
    await blocker.query('begin');
    await blocker.query('select id from catalog_items where tenant_id=$1 and code=$2 for update', [config.rt.id, item.id]);
    const queued = withTenantScope(config.rt, () => listSessions()[0]!);
    await blocker.query('select id from conversations where tenant_id=$1 and id=$2 for update', [config.rt.id, queued.id]);
    withTenantScope(config.rt, () => {
      queued.messages.push({ role: 'customer', content: '测试在途写队列', at: Date.now() });
      saveSession(queued);
    });
    const acquired = deferred<void>();
    const active = withTenantScope(config.rt, () =>
      withTenant(db, systemContext(config.rt.id), async (tx) => {
        acquired.resolve();
        await tx.query.tenants.findFirst();
      }),
    );
    await acquired.promise;
    await active;
    const pending = withTenantScope(config.rt, () =>
      updateCatalogItem(systemContext(config.rt.id), 'route', item.id, { rev: 1, set: { priceFrom: item.priceFrom + 100 } }),
    );
    void pending.catch(() => {});
    // 超时放宽只是自测连接的 startup option，生产保持原角色约束。
    await expire(config);
    const slow = new SandboxReaper({ db, acquireTenant: acquire, idleMs: 120 * 60_000, barrierMs: 30_000 });
    await slow.tick();
    check(config.closed() === 0 && config.rt.inflight.size > 0, '真实行锁超过 30 秒，不关后端、不 purge');
    check(runtimeOf(config.rt.id) === config.rt, '真实行锁不放租户锁');
    await blocker.query('rollback');
    await blocker.close();
    await pending;
    check(withTenantScope(config.rt, () => currentCatalog().routes[0]!.priceFrom) === item.priceFrom, '配置迟到提交不换缓存');
    await slow.tick();
    await zero(q, config.rt.id, config.slug);
    slow.stop();

    // ⑤ tenants 行锁导致真实 lock_timeout；⑥ 无论成败放锁并 drop。
    const purge = await box();
    await expire(purge);
    const lockConn = await connectSuperQuery(realUrl);
    await lockConn.query('begin');
    await lockConn.query('select id from tenants where id=$1 for update', [purge.rt.id]);
    await reaper.tick();
    check(!runtimeOf(purge.rt.id) && Object.values(tenantKeys(purge.rt.id)).every((n) => n === 0), '⑤ 锁超时后 ⑥ 清内存');
    check(
      (await listSandboxes(db)).some((r) => r.id === purge.rt.id),
      '⑤ 失败整笔回滚',
    );
    const closeCount = purge.closed();
    await lockConn.query('rollback');
    await lockConn.close();
    await reaper.tick();
    check(purge.closed() === closeCount, '⑤ 重试不再刷用量、关后端');
    await zero(q, purge.rt.id, purge.slug);

    // 删除事务中途 SIGKILL：已删附属行仍回滚，重启不装载到期租户而直接删。
    const crash = await box();
    await expire(crash);
    crash.rt.state = 'closed';
    crash.backend.close();
    await crash.rt.config.loaded!.lock.release();
    dropTenantState(crash.rt.id);
    dropShutdownHooks(crash.rt);
    unregisterRuntime(crash.rt.id);
    await q(`create function selftest_purge_sleep() returns trigger language plpgsql as $$
      begin if old.id='${crash.rt.id}'::uuid then perform pg_sleep(60); end if; return old; end $$`);
    await q('create trigger selftest_purge_sleep before delete on tenants for each row execute function selftest_purge_sleep()');
    const url = new URL(realUrl);
    url.searchParams.set('options', '-c role=agent_app');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { openDb } from './src/db/client.ts';
      import { purgeSandbox } from './src/db/sandbox-reaper.ts';
      const c = await openDb(process.env.REAPER_TEST_URL);
      await purgeSandbox(c.db, process.env.REAPER_TEST_ID);
      await c.close();`,
      ],
      { env: { ...process.env, REAPER_TEST_URL: url.toString(), REAPER_TEST_ID: crash.rt.id }, stdio: 'ignore' },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    let pid: number | undefined;
    try {
      const startedAt = Date.now();
      while (!pid && Date.now() - startedAt < 10_000) {
        const [busy] = await q<{ pid: number }>(`select pid from pg_stat_activity where datname=current_database()
          and wait_event='PgSleep' and query like '%sandbox_tenant_purge%'`);
        pid = busy?.pid;
        if (!pid) await settleWithin(new Promise<void>((resolve) => setTimeout(resolve, 20)), 100);
      }
      check(pid, '删除事务已走到删 tenants 前，尚未提交');
      child.kill('SIGKILL');
      await exited;
      await q('select pg_terminate_backend($1)', [pid]);
      const [oldRows] = await q<{ n: string }>('select count(*) as n from conversations where tenant_id=$1', [crash.rt.id]);
      check(Number(oldRows!.n) === 13, 'SIGKILL 后附属删除整笔回滚');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    await q('drop trigger selftest_purge_sleep on tenants');
    await q('drop function selftest_purge_sleep()');
    const restarted = new SandboxReaper({ db, acquireTenant: acquire, idleMs: 120 * 60_000 });
    await restarted.tick();
    await zero(q, crash.rt.id, crash.slug);
    restarted.stop();
    check(!runtimeOf(crash.rt.id), '启动删除不装载到期租户');
  }

  // overdue 与连续失败告警；健康接口真实 ok=false。
  const overdue = await box();
  await q("update tenants set expires_at=now()-interval '2 hours' where id=$1", [overdue.rt.id]);
  check((await reaper.overdue()) === 1, '超过一小时 purgeOverdue');
  const healthProcess = new SandboxProcess({});
  Reflect.set(healthProcess, 'deps', deps);
  Reflect.set(healthProcess, 'reaper', reaper);
  const health = await healthProcess.health();
  check(!health.ok && health.purgeOverdue === 1, 'healthz ok=false');
  await expire(overdue);
  await reaper.tick();
  await zero(q, overdue.rt.id, overdue.slug);

  // CLI list/end 真实数据库；进程锁 / 租户锁失败必须退出 3，不能改到期。
  let connected = 0;
  const cli = {
    connect: async () => {
      connected++;
      return { db, close: async () => {} };
    },
    lock: async () => null,
  };
  check((await runSandbox(['list'], cli)) === 0, 'sandbox list');
  const expires = (await listSandboxes(db)).find((r) => r.id === survivor.rt.id)!.expiresAt;
  const beforeConnected = connected;
  check((await runSandbox(['purge', '--all'], cli)) === 3 && connected === beforeConnected, 'purge 进程锁拒绝在查询前');
  const noTenant = { ...fakeLock(), acquireTenant: async () => null };
  check((await runSandbox(['purge', '--all'], { ...cli, lock: async () => noTenant })) === 3, 'purge 租户锁拒绝');
  check(String((await listSandboxes(db)).find((r) => r.id === survivor.rt.id)!.expiresAt) === String(expires), '锁拒绝未改寿命');
  check((await runSandbox(['end', survivor.slug], cli)) === 0, 'sandbox end slug');
  await reaper.tick();
  await zero(q, survivor.rt.id, survivor.slug);
  const startup = await box();
  await clean(); // 模拟重启：无运行时，未过期行仍在。
  const cliLock = { ...fakeLock(), acquireTenant: acquire };
  check((await runSandbox(['purge', '--all'], { ...cli, lock: async () => cliLock })) === 0, 'sandbox purge --all 到期并直接删');
  await zero(q, startup.rt.id, startup.slug);
  check((await q('select id from tenants where id=$1', [host!.id])).length === 1, 'standard 模板不删除');
  check((await runSandbox(['end', 'reaper-template'], cli)) === 1, 'CLI 不能结束 standard');
  const app = sandboxApp(
    {
      resolve: (token) => resolveSandboxSession(db, token),
      health: async () => health,
      provision: async () => {
        throw new Error('unused');
      },
      end: (id) => reaper.end(id),
    },
    'sandbox.example.invalid',
  );
  const deleted = await app.request('/api/console/me', {
    headers: { host: 'sandbox.example.invalid', cookie: `__Host-sbx=${startup.token}` },
  });
  check(deleted.status === 401, '删除后真实 HTTP 401');
  reaper.stop();
  console.log(`SELFTEST ${realUrl ? '真实 PG' : 'PGlite'} R12 ①–⑥、结束与 idle 通过`);
}

try {
  await clean();
  const t = await openTestDb();
  const locks = new Map<string, FakeLock>();
  const acquire = async (id: string) => {
    const lock = fakeLock();
    locks.set(id, lock);
    return lock;
  };
  const q: Query = async (text, params = []) => {
    await t.pg.exec('reset role');
    try {
      return (await t.pg.query(text, params)).rows as never;
    } finally {
      await t.pg.exec('set role agent_app');
    }
  };
  await t.pg.exec('set role agent_app');
  try {
    await suite(t.db, q, acquire);
  } finally {
    await clean();
    await t.close();
  }
  check(
    [...locks.values()].every((l) => l.released),
    '假锁全部释放',
  );
  if (process.env.PG_TEST_URL) {
    const f = await realReaperFixture(process.env.PG_TEST_URL);
    try {
      await suite(f.app.db, f.query, (id) => f.held.acquireTenant(id), f.superUrl);
      const cli = {
        connect: async () => ({ db: f.app.db, close: async () => {} }),
        lock: () => holdTenantLocks(f.appUrl, ['sandbox-process']),
      };
      check((await runSandbox(['purge', '--all'], cli)) === 3, '真实进程锁冲突退出 3');
      await f.held.release();
      const [template] = await f.query<{ id: string }>("select id from tenants where slug='reaper-template'");
      const created = await withNewSandboxTenant(
        f.app.db,
        { slug: 'sbx-cli-test', templateTenantId: template!.id, brand: null, tokenHash: randomBytes(32), ip: null, userAgent: null },
        async (_tx, row) => row,
      );
      const tenantHeld = await holdTenantLocks(f.appUrl, [created.tenantId]);
      assert.ok(tenantHeld);
      try {
        check((await runSandbox(['purge', '--all'], cli)) === 3, '真实租户锁冲突退出 3');
      } finally {
        await tenantHeld.release();
      }
      check((await runSandbox(['list'], cli)) === 0, '真实 CLI list');
      check((await runSandbox(['end', '--all'], cli)) === 0, '真实 CLI end --all');
      check((await runSandbox(['purge', '--all'], cli)) === 0, '真实 CLI purge --all');
      await zero(f.query, created.tenantId, 'sbx-cli-test');
    } finally {
      await clean();
      await f.close();
    }
  } else console.log('SKIP: 真实 PG 行锁、锁超时、杀进程需要 PG_TEST_URL');
  await __alertTest.settle();
} finally {
  await clean();
}
console.log(`SELFTEST PASS: 沙箱删除 ${checks} 项`);
