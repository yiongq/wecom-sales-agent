// R22：真实事务、假企微，覆盖发布、失败恢复、删除屏障与 epoch 两种先后。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import { openTestDb, testConfigDeps, fakeLock } from './testing.js';
import { openOutboundTestPg } from './sandbox-outbound-testing.js';
import { rowsOf, registerDriver, type Db, type Tx } from './client.js';
import { advanceSandboxEpoch, acquireSandboxProcess } from './sandbox-process.js';
import { readSandboxWecomState, commitSandboxWecomCursor, markSandboxWecomFull, resetSandboxWecomFull } from './repo/sandbox-wecom.js';
import { importConfig } from '../config/transfer.js';
import { closeConfig } from '../config/source.js';
import { shanhaiBrand } from '../packs/travel/brand-fixture.js';
import type { KfMessage } from '../tenancy/sandbox/wecom.js';
import { getSession, drainStore, createOrder, listOrders } from '../store.js';
import {
  createTenantRuntime,
  configureTenancy,
  runtimeOf,
  tenantRuntimes,
  unregisterRuntime,
  withTenantScope,
} from '../tenancy/runtime.js';
import { dropTenantState, tenantKeys } from '../tenancy/state.js';
import { dropShutdownHooks } from '../shutdown.js';
import { sandboxWechatIndex, SandboxSendRefused } from '../tenancy/sandbox/outbound.js';
import { SandboxWechatBinding } from '../tenancy/sandbox/binding.js';
import { SandboxWecom } from '../tenancy/sandbox/wecom.js';
import { SandboxProcess, sandboxApp } from '../tenancy/sandbox/process.js';
import { provisionSandbox } from '../tenancy/sandbox/provision.js';
import { loadSandboxRuntime } from '../tenancy/sandbox/load.js';
import { resolveSandboxSession } from '../tenancy/sandbox/session.js';
import { SandboxReaper } from '../tenancy/sandbox/reaper.js';
import { __sandboxLimitsTest } from '../tenancy/sandbox/limits.js';
import { runSandbox } from '../cli/sandbox.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-bind-'));
process.env.VAR_DIR = temp;
process.env.SERVER_SELFTEST = '1';
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'db';
process.env.SESSION_STORE = 'db';
const { app: routes } = await import('../server.js');
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('禁止真实网络');
};
const env = {
  SANDBOX_HOST: 'fake-host',
  SANDBOX_WECOM_CORP_ID: 'fake-corp',
  SANDBOX_WECOM_SECRET: 'fake-secret', // gitleaks:allow
  SANDBOX_WECOM_TOKEN: 'fake-token', // gitleaks:allow
  SANDBOX_WECOM_AES_KEY: Buffer.alloc(32, 7).toString('base64').slice(0, -1),
  SANDBOX_WECOM_OPEN_KFID: 'fake-kf',
};
type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
async function until(fn: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function namedCheck(name: string, fn: () => void): void {
  check(fn);
  console.log(`ASSERT PASS: ${name}`);
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
/** 保留真实 COMMIT / ROLLBACK，只丢掉调用者收到的结果；不模拟内存里的库。 */
function receiptProbe(db: Db) {
  let next: 'commit' | 'rollback' | undefined;
  let failRead = false;
  let afterEpoch: (() => Promise<void>) | undefined;
  let beforeEpoch: (() => Promise<void>) | undefined;
  const lost = () => Object.assign(new Error('fake_commit_receipt_lost'), { code: 'ECONNRESET' });
  const probe = new Proxy(db, {
    get(target, key) {
      if (key !== 'transaction') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (fn: (tx: Tx) => Promise<unknown>) => {
        if (failRead && !next) throw new Error('fake_binding_read_failed');
        const mode = next;
        next = undefined;
        const hook = afterEpoch;
        afterEpoch = undefined;
        const beforeHook = beforeEpoch;
        beforeEpoch = undefined;
        const result = await db.transaction(async (tx) => {
          const wrapped = new Proxy(tx, {
            get(target, key) {
              if (key !== 'execute') {
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              }
              return async (query: SQL) => {
                const text = (db as unknown as { dialect: { sqlToQuery(q: SQL): { sql: string } } }).dialect.sqlToQuery(query).sql;
                if (beforeHook && text.includes('select epoch') && text.includes('for share')) await beforeHook();
                const result = await target.execute(query);
                if (hook && text.includes('select epoch') && text.includes('for share')) await hook();
                return result;
              };
            },
          });
          const result = await fn(wrapped);
          if (mode === 'rollback') throw lost();
          return result;
        });
        if (mode === 'commit') throw lost();
        return result;
      };
    },
  });
  registerDriver(probe, { acquire: async () => ({ db: probe, release: async () => {} }) });
  return {
    db: probe,
    lose: (mode: 'commit' | 'rollback') => {
      next = mode;
    },
    failReads: (value: boolean) => {
      failRead = value;
    },
    pauseBeforeEpoch: (fn: () => Promise<void>) => {
      beforeEpoch = fn;
    },
    pauseAfterEpoch: (fn: () => Promise<void>) => {
      afterEpoch = fn;
    },
  };
}
async function cleanup() {
  for (const rt of tenantRuntimes()) {
    await withTenantScope(rt, () => drainStore(5000));
    rt.state = 'closed';
    rt.store.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
  }
  sandboxWechatIndex.reset();
}

async function suite(db: Db, q: Query, appUrl?: string) {
  __sandboxLimitsTest.resetProvisioned();
  sandboxWechatIndex.reset();
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const [template] = await q<{ id: string }>(
    "insert into tenants(slug,name,pack_id,brand) values('template','模板','travel',$1::json) returning id",
    [JSON.stringify(shanhaiBrand)],
  );
  const host = createTenantRuntime({ id: template!.id, slug: 'template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  assert.equal(
    (
      await withTenantScope(host, () =>
        importConfig({ db, tenantSlug: host.slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
      )
    ).code,
    0,
  );
  await q("insert into privacy_notices(tenant_id,version,body) values($1,1,'假隐私说明')", [host.id]);
  const create = () =>
    provisionSandbox({
      deps,
      templateSlug: host.slug,
      host: env.SANDBOX_HOST,
      epoch: '0',
      env: { SANDBOX_PER_IP_DAY: '10' },
      acquireTenant: async () => fakeLock(),
      ip: null,
      userAgent: null,
    });
  const a = await create(),
    b = await create();
  let A = runtimeOf(a.tenantId)!,
    B = runtimeOf(b.tenantId)!;
  const binding = new SandboxWechatBinding(db, '0');
  let activeBinding = binding;
  let serviceEpoch = '0';
  let minute!: () => void;
  let pages: KfMessage[][] = [],
    serial = 0,
    fullAlerts = 0,
    rejectSend = false;
  const sends: { path: string; body: { touser?: string; open_kfid?: string; text: { content: string } } }[] = [];
  const request: typeof fetch = async (input, init) => {
    const endpoint = String(input).split('/cgi-bin/')[1]!.split('?')[0]!;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (endpoint === 'gettoken') return Response.json({ access_token: 'fake-access', expires_in: 7200 });
    if (endpoint === 'kf/add_contact_way') return Response.json({ url: 'fake-contact' });
    if (endpoint === 'kf/sync_msg')
      return Response.json({ next_cursor: `fake-cursor-${++serial}`, has_more: 0, msg_list: pages.shift() ?? [] });
    assert.ok(endpoint === 'kf/send_msg' || endpoint === 'kf/send_msg_on_event');
    sends.push({ path: endpoint, body });
    if (rejectSend) {
      rejectSend = false;
      return Response.json({ errcode: 95003 });
    }
    return Response.json({ errcode: 0 });
  };
  let fullWriteHook: ((write: () => Promise<void>) => Promise<void>) | undefined;
  let service!: SandboxWecom;
  const start = async () => {
    service = new SandboxWecom(env, {
      binding: activeBinding,
      request,
      schedule: (fn, ms) => {
        assert.equal(ms, 60_000);
        minute = fn;
        return () => {};
      },
      read: () => readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID),
      commit: (cursor) => commitSandboxWecomCursor(db, serviceEpoch, env.SANDBOX_WECOM_OPEN_KFID, cursor),
      markFull: async () => {
        const hook = fullWriteHook;
        fullWriteHook = undefined;
        const write = () => markSandboxWecomFull(db, '0', env.SANDBOX_WECOM_OPEN_KFID);
        if (hook) await hook(write);
        else await write();
      },
      notifyFull: () => fullAlerts++,
    });
    await service.start();
    await service.drain();
  };
  await start();
  const message = (user: string, text: string): KfMessage => ({
    msgid: `fake-msg-${++serial}`,
    open_kfid: env.SANDBOX_WECOM_OPEN_KFID,
    external_userid: user,
    send_time: Date.now() / 1000,
    origin: 3,
    msgtype: 'text',
    text: { content: text },
  });
  const enter = (user: string, code: string, welcome: string): KfMessage => ({
    ...message(user, ''),
    origin: 4,
    msgtype: 'event',
    event: { event_type: 'enter_session', external_userid: user, scene_param: code.replace('-', ''), welcome_code: welcome },
  });
  const deliver = async (...messages: KfMessage[]) => {
    pages.push(messages);
    await service.sync();
    await service.drain();
  };
  const app = sandboxApp(
    {
      health: async () => ({ ...(await new SandboxProcess({}).health()), wecom: service.health() }),
      resolve: (t) => resolveSandboxSession(db, t),
      provision: async () => {
        throw new Error('不应开通');
      },
      end: async (id) => reaper.end(id),
      wechatCode: (rt) => service.issueCode(rt),
      wecomRoutes: () => service.routes,
    },
    env.SANDBOX_HOST,
    routes,
  );
  const reaper = new SandboxReaper({
    db,
    acquireTenant: async () => fakeLock(),
    idleMs: 99999999,
    barrierMs: 20,
    refreshWecom: () => service.refreshFull(),
  });
  const req = (url: string, token = a.token, method = 'GET', body?: unknown, csrf?: string) =>
    app.request(`https://${env.SANDBOX_HOST}${url}`, {
      method,
      headers: {
        host: env.SANDBOX_HOST,
        cookie: `__Host-sbx=${token}`,
        origin: `https://${env.SANDBOX_HOST}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': String(body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body))),
        ...(csrf ? { 'x-csrf': csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const state = async (token = a.token) => (await (await req('/api/console/me', token)).json()).sandbox.wechat;
  const sign = async (token = a.token) => {
    const res = await req('/api/sandbox/wechat/code', token, 'POST');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const result = await res.json();
    assert.match(result.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    return result;
  };
  try {
    check(() => assert.equal(service.health().bound, 0));
    assert.equal(await state(), 'unbound');
    const code = await sign();
    const [timing] = await q<{ remaining: string | number }>(
      'select extract(epoch from (code_expires_at - now())) * 1000 as remaining from sandbox_wechat where tenant_id=$1',
      [A.id],
    );
    check(() => {
      // 码只认数据库时钟；前端以 expiresAt - 10 分钟推签发时刻，3 分钟且仍 unbound 才提示。
      const remaining = Number(timing!.remaining);
      assert.ok(remaining > 599_000 && remaining <= 600_000);
      assert.ok(remaining - 7 * 60_000 > 0);
    });
    const [stored] = await q<{ code_hash: string }>("select encode(code_hash,'hex') as code_hash from sandbox_wechat where tenant_id=$1", [
      A.id,
    ]);
    check(() => assert.equal(stored!.code_hash, createHash('sha256').update(code.code.replace('-', '')).digest('hex')));
    await deliver(enter('wm1', code.code, 'fake-welcome-1'));
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm1'), A);
      assert.equal(sends.at(-1)!.path, 'kf/send_msg_on_event');
      assert.match(sends.at(-1)!.body.text.content, /AI/);
      assert.ok(sends.at(-1)!.body.text.content.includes('/wx/'));
    });
    assert.equal(await state(), 'bound');
    await deliver(message('wm1', '你好'));
    await withTenantScope(A, () => drainStore(5000));
    check(() => {
      const s = withTenantScope(A, () => getSession('wecom:wm1'))!;
      assert.equal(s.channel, 'wecom');
      assert.ok(s.messages.some((m) => m.role === 'agent'));
      const reply = sends.at(-1)!.body;
      assert.equal(reply.touser, 'wm1');
      assert.equal(reply.open_kfid, env.SANDBOX_WECOM_OPEN_KFID);
    });
    const me = await (await req('/api/console/me')).json();
    const order = withTenantScope(A, () => {
      const sample = listOrders()[0]!;
      return createOrder({
        sessionId: 'wecom:wm1',
        routeId: sample.routeId,
        routeTitle: sample.routeTitle,
        travelers: sample.travelers,
        departDate: sample.departDate,
        totalPrice: sample.totalPrice,
      });
    });
    const beforePaid = sends.length;
    assert.equal((await req(`/api/console/orders/${order.id}/mark-paid`, a.token, 'POST', {}, me.csrf)).status, 200);
    check(() => {
      assert.ok(sends.length > beforePaid);
      assert.equal(sends.at(-1)!.body.touser, 'wm1');
    });
    const beforeHuman = sends.length;
    const began = Date.now();
    assert.equal(
      (await req('/api/console/conversations/wecom:wm1/reply', a.token, 'POST', { text: '顾问回复', clientId: randomUUID() }, me.csrf))
        .status,
      200,
    );
    check(() => {
      assert.ok(Date.now() - began < 1000);
      assert.ok(sends.length > beforeHuman);
      assert.match(sends.at(-1)!.body.text.content, /【顾问】/);
    });
    // 一条客户消息后最多五次 send_msg，工作台第六次拒发。
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await req('/api/console/conversations/wecom:wm1/reply', a.token, 'POST', { text: `回复${i}`, clientId: randomUUID() }, me.csrf))
          .status,
        200,
      );
    const count = sends.length;
    const sixth = await req(
      '/api/console/conversations/wecom:wm1/reply',
      a.token,
      'POST',
      { text: '第六条', clientId: randomUUID() },
      me.csrf,
    );
    check(() => {
      assert.equal(sixth.status, 409);
      assert.equal(sends.length, count);
    });
    await deliver(enter('wm2', code.code, 'fake-used'));
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm2'), undefined);
      assert.equal(sends.at(-1)!.body.text.content, sandboxWechatIndex.fixedTexts(env.SANDBOX_HOST)[0]);
    });
    const refreshed = await sign();
    await deliver(message('wm1', '稍等'));
    await deliver(message('wm2', ` ${refreshed.code.toLowerCase()} `));
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm2'), A);
      assert.equal(sandboxWechatIndex.forUser('wm1'), undefined);
      assert.equal(sends.at(-1)!.body.touser, 'wm2');
      assert.match(sends.at(-1)!.body.text.content, /AI/);
    });
    // 旧会话保留；共同发送汇点仍拒绝旧收件人。
    check(() => assert.ok(withTenantScope(A, () => getSession('wecom:wm1'))));
    const before = sends.length;
    const detachedReply = await req(
      '/api/console/conversations/wecom:wm1/reply',
      a.token,
      'POST',
      { text: '改绑后的历史回复', clientId: randomUUID() },
      me.csrf,
    );
    assert.equal(detachedReply.status, 200);
    assert.equal((await detachedReply.json()).sent, false);
    check(() => {
      assert.equal(sends.length, before);
      assert.ok(withTenantScope(A, () => getSession('wecom:wm1'))!.messages.some((m) => m.content === '这个微信已不再连着这次体验'));
    });
    assert.throws(
      () =>
        withTenantScope(A, () =>
          sandboxWechatIndex.prepare(
            'kf/send_msg',
            { touser: 'wm1', open_kfid: env.SANDBOX_WECOM_OPEN_KFID, msgtype: 'text', text: { content: '旧绑定' } },
            env.SANDBOX_WECOM_OPEN_KFID,
            env.SANDBOX_HOST,
          ),
        ),
      SandboxSendRefused,
    );
    assert.equal(sends.length, before);
    const bcode = await sign(b.token);
    await deliver(enter('wm2', bcode.code, 'fake-welcome-b'));
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm2'), B);
      assert.equal(sandboxWechatIndex.boundUser(A), undefined);
    });
    const clear = await q<{ external_userid: string | null }>('select external_userid from sandbox_wechat where tenant_id=$1', [A.id]);
    assert.equal(clear[0]!.external_userid, null);
    const bad = message('wm3', 'ZZZZ-ZZZZ');
    await deliver(bad, message('wm3', bad.text!.content), message('wm3', bad.text!.content));
    const fixed = sends.filter((s) => s.body.touser === 'wm3');
    check(() => {
      assert.equal(fixed.length, 1);
      assert.equal(
        withTenantScope(A, () => getSession('wecom:wm3')),
        undefined,
      );
    });
    for (let i = 0; i < 7; i++) await binding.bind('wm3', bad.text!.content);
    const valid = await sign();
    check(() => assert.equal(sandboxWechatIndex.forUser('wm3'), undefined));
    assert.equal((await binding.bind('wm3', valid.code)).status, 'invalid');
    // 同码扫码 / 手打并发只成功一个；同微信两码后取锁的赢。
    const outcomes = await Promise.all([binding.bind('wm4', valid.code), binding.bind('wm5', valid.code)]);
    check(() => assert.equal(outcomes.filter((r) => r.status === 'bound').length, 1));
    const ac = await sign(),
      bc = await sign(b.token);
    await Promise.all([binding.bind('wm6', ac.code), binding.bind('wm6', bc.code)]);
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm6'), B);
      assert.equal(sandboxWechatIndex.boundUser(A), undefined);
    });
    // 改绑失败：旧清空未提交则两边恢复；旧已提交则保持清空、目标恢复。
    const setup = await sign();
    await binding.bind('wm7', setup.code);
    const moving = await sign(b.token);
    await q(
      "create function fake_binding_failure() returns trigger language plpgsql as $$ begin if OLD.external_userid = 'wm7' and NEW.external_userid is null then raise exception 'fake-clear-failure'; end if; return NEW; end $$",
    );
    await q('create trigger fake_binding_failure before update on sandbox_wechat for each row execute function fake_binding_failure()');
    await assert.rejects(binding.bind('wm7', moving.code));
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm7'), A);
      assert.equal(sandboxWechatIndex.forUser('wm6'), B);
    });
    await q(
      "create or replace function fake_binding_failure() returns trigger language plpgsql as $$ begin if NEW.external_userid = 'wm7' then raise exception 'fake-bind-failure'; end if; return NEW; end $$",
    );
    await assert.rejects(binding.bind('wm7', moving.code));
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm7'), undefined);
      assert.equal(sandboxWechatIndex.forUser('wm6'), B);
    });
    await q('drop trigger fake_binding_failure on sandbox_wechat');
    await q('drop function fake_binding_failure()');
    // 库内条件更新再次核过期；welcome_code 失败时只能回未归属固定话术。
    const stale = await sign();
    await q("update sandbox_wechat set code_expires_at=now()-interval '1 second' where tenant_id=$1", [A.id]);
    await deliver(enter('wm8', stale.code, 'fake-expired'));
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm8'), undefined);
      assert.equal(sends.at(-1)!.body.text.content, sandboxWechatIndex.fixedTexts(env.SANDBOX_HOST)[1]);
    });
    // 重建三张表：未过期码、绑定、旧链接全部保留，空 GUC 看不到任何行。
    const restartCode = await sign();
    const [link] = await q<{ link_token: string }>('select link_token from sandbox_wechat where tenant_id=$1', [B.id]);
    await service.close();
    assert.equal(await state(), 'off');
    await cleanup();
    A = (await loadSandboxRuntime(deps, { id: a.tenantId, slug: a.slug, expiresAt: a.expiresAt }, env.SANDBOX_HOST, async () =>
      fakeLock(),
    ))!;
    B = (await loadSandboxRuntime(deps, { id: b.tenantId, slug: b.slug, expiresAt: b.expiresAt }, env.SANDBOX_HOST, async () =>
      fakeLock(),
    ))!;
    check(() => {
      assert.equal(sandboxWechatIndex.forUser('wm6'), B);
      assert.equal(sandboxWechatIndex.forToken(link!.link_token), B);
    });
    assert.equal((await binding.bind('wm9', restartCode.code)).status, 'bound');
    await start();
    await deliver({ ...message('wm9', ''), msgtype: 'image' });
    await withTenantScope(A, () => drainStore(5000));
    check(() => {
      const last = withTenantScope(A, () => getSession('wecom:wm9'))!.messages.at(-1)!;
      assert.equal(last.role, 'agent');
      assert.match(last.content, /图片|图我收到了/);
    });
    const interleaved = sends.length;
    await deliver(message('wm9', '你好'), message('wm6', '你好'));
    check(() => {
      assert.ok(sends.slice(interleaved).some((s) => s.body.touser === 'wm9'));
      assert.ok(sends.slice(interleaved).some((s) => s.body.touser === 'wm6'));
      assert.equal(
        withTenantScope(A, () => getSession('wecom:wm6')),
        undefined,
      );
      assert.equal(
        withTenantScope(B, () => getSession('wecom:wm9')),
        undefined,
      );
    });
    // 评审 2、3、9、10：通过收件页和按人串行入口复现，不直接调用 bind。
    const replayCode = await sign();
    const replay = message('wmReplay', replayCode.code);
    const replaySends = sends.length;
    await deliver(replay, { ...replay });
    namedCheck('BINDING_MSGID_CONCURRENT_REPLAY_DROPPED', () => {
      assert.equal(sandboxWechatIndex.forUser('wmReplay'), A);
      assert.equal(sends.length, replaySends + 1);
      assert.equal(
        withTenantScope(A, () => getSession('wecom:wmReplay')),
        undefined,
      );
    });
    const ignoredSends = sends.length;
    for (let i = 0; i < 12; i++) await deliver(enter('wmReplay', i % 2 ? replayCode.code : 'ZZZZ-ZZZZ', `fake-scene-${i}`));
    const afterInvalid = await sign();
    await deliver(enter('wmReplay', afterInvalid.code, 'fake-valid-scene'));
    namedCheck('BOUND_INVALID_SCENE_NO_REPLY_NO_ATTEMPT', () => {
      assert.equal(sends.length, ignoredSends + 1);
      assert.equal(sandboxWechatIndex.forUser('wmReplay'), A);
      assert.equal(
        withTenantScope(A, () => getSession('wecom:wmReplay')),
        undefined,
      );
    });
    await deliver(message('wmReplay', 'ZZZZ-ZZZZ'), message('wmReplay', 'IIII-IIII'));
    namedCheck('TYPED_FAILED_CODE_NEVER_ENTERS_ENGINE', () => {
      assert.equal(
        withTenantScope(A, () => getSession('wecom:wmReplay')),
        undefined,
      );
    });
    const modelEntered = barrier(),
      modelRelease = barrier();
    const packBefore = A.pack;
    A.pack = { ...A.pack, runtime: { ...A.pack.runtime, preModel: undefined, prefetch: undefined } };
    const modelEnv = Object.fromEntries(
      ['LLM_MOCK', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_MODEL_CHEAP', 'LLM_PROVIDER'].map((k) => [k, process.env[k]]),
    );
    const modelFetch = globalThis.fetch;
    Object.assign(process.env, {
      LLM_MOCK: '0',
      LLM_BASE_URL: 'http://fake-model',
      LLM_API_KEY: 'selftest',
      LLM_MODEL: 'glm-5.2',
      LLM_MODEL_CHEAP: 'glm-5.2',
      LLM_PROVIDER: '',
    });
    globalThis.fetch = async () => {
      modelEntered.release();
      await modelRelease.promise;
      return Response.json({ choices: [{ message: { content: '模型迟到的回复' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    };
    try {
      pages.push([message('wmReplay', '请问出发时间怎么安排')]);
      await service.sync();
      await modelEntered.promise;
      const queuedDuringModel = message('wmReplay', '模型期间的第二句');
      pages.push([queuedDuringModel]);
      await service.sync();
      const replacement = await service.issueCode(A);
      pages.push([message('wmNext', replacement.code)]);
      await service.sync();
      await until(() => sandboxWechatIndex.forUser('wmNext') === A);
      modelRelease.release();
      await service.drain();
      namedCheck('LATE_MODEL_AFTER_REBIND_NO_REPLY_WRITE', () => {
        const session = withTenantScope(A, () => getSession('wecom:wmReplay'))!;
        assert.equal(session.messages.filter((m) => m.role === 'agent').length, 0);
        assert.equal(session.messages.filter((m) => m.content === '这个微信已不再连着这次体验').length, 1);
        assert.equal(
          session.messages.some((m) => m.msgid === queuedDuringModel.msgid),
          false,
        );
        assert.equal(
          sends.some((s) => s.body.text.content.includes('模型迟到的回复')),
          false,
        );
      });
      namedCheck('INBOUND_DURING_MODEL_RESOLVES_AFTER_TURN', () => assert.equal(sandboxWechatIndex.forUser('wmNext'), A));
    } finally {
      modelRelease.release();
      globalThis.fetch = modelFetch;
      A.pack = packBefore;
      for (const [key, value] of Object.entries(modelEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await service.drain();
    }
    // 评审 1、4、7：真实库保留 COMMIT/ROLLBACK，只在驱动边界丢回执。
    const recoveryBox = await create(),
      olderBox = await create();
    let R = runtimeOf(recoveryBox.tenantId)!,
      S = runtimeOf(olderBox.tenantId)!;
    const probe = receiptProbe(db);
    const recoveryBinding = new SandboxWechatBinding(probe.db, '0');
    const codeFor = (rt: typeof A) =>
      activeBinding.issue(
        rt,
        () => 'fake-contact',
        () => false,
      );
    await service.close();
    activeBinding = recoveryBinding;
    await start();
    const initialRecovery = await codeFor(R);
    await deliver(message('wmOld', initialRecovery.code));
    const committedCode = await codeFor(R);
    probe.lose('commit');
    await deliver(message('wmCommit', committedCode.code));
    namedCheck('COMMIT_SUCCEEDED_RECEIPT_LOST_READS_DATABASE', () => {
      assert.equal(sandboxWechatIndex.forUser('wmCommit'), R);
      assert.equal(sandboxWechatIndex.forUser('wmOld'), undefined);
      assert.match(sends.at(-1)!.body.text.content, /AI/);
    });
    assert.equal(
      (await q<{ external_userid: string }>('select external_userid from sandbox_wechat where tenant_id=$1', [R.id]))[0]!.external_userid,
      'wmCommit',
    );
    const rollbackCode = await codeFor(R);
    probe.lose('rollback');
    await deliver(message('wmRollback', rollbackCode.code));
    namedCheck('COMMIT_FAILED_RECEIPT_LOST_READS_DATABASE', () => {
      assert.equal(sandboxWechatIndex.forUser('wmCommit'), R);
      assert.equal(sandboxWechatIndex.forUser('wmRollback'), undefined);
    });
    const [quarantinedLink] = await q<{ link_token: string }>('select link_token from sandbox_wechat where tenant_id=$1', [R.id]);
    const recoveringCode = await codeFor(R);
    probe.lose('commit');
    probe.failReads(true);
    await deliver(message('wmRecovery', recoveringCode.code));
    namedCheck('RECOVERY_READ_FAILURE_WITHDRAWS_ALL_THREE_TABLES', () => {
      assert.equal(sandboxWechatIndex.forUser('wmCommit'), undefined);
      assert.equal(sandboxWechatIndex.forUser('wmRecovery'), undefined);
      assert.equal(sandboxWechatIndex.forToken(quarantinedLink!.link_token), undefined);
      assert.equal(sandboxWechatIndex.code(createHash('sha256').update(recoveringCode.code.replace('-', '')).digest('hex')), undefined);
      for (const user of ['wmCommit', 'wmRecovery'])
        assert.throws(
          () =>
            withTenantScope(R, () =>
              sandboxWechatIndex.prepare(
                'kf/send_msg',
                { touser: user, open_kfid: env.SANDBOX_WECOM_OPEN_KFID, msgtype: 'text', text: { content: '失去授权' } },
                env.SANDBOX_WECOM_OPEN_KFID,
                env.SANDBOX_HOST,
              ),
            ),
          SandboxSendRefused,
        );
    });
    const unaffectedSends = sends.length;
    await deliver(message('wm6', '你好'));
    namedCheck('RECOVERY_QUARANTINE_OTHER_USER_UNAFFECTED', () => assert.ok(sends.length > unaffectedSends));
    await service.refreshFull();
    assert.equal(sandboxWechatIndex.forUser('wmRecovery'), undefined);
    probe.failReads(false);
    minute();
    await service.drain();
    namedCheck('RECOVERY_NEXT_MINUTE_RESTORES_REAL_COMMIT', () => {
      assert.equal(sandboxWechatIndex.forUser('wmRecovery'), R);
      assert.equal(sandboxWechatIndex.forUser('wmCommit'), undefined);
      assert.equal(sandboxWechatIndex.forToken(quarantinedLink!.link_token), R);
    });
    const waitCode = await codeFor(R);
    const waitHash = createHash('sha256').update(waitCode.code.replace('-', '')).digest('hex');
    const shortExpiry = Date.now() + 200;
    await q('update sandbox_wechat set code_expires_at=$2 where tenant_id=$1', [R.id, new Date(shortExpiry)]);
    sandboxWechatIndex.publishCode(R, waitHash, shortExpiry);
    const epochSeen = barrier(),
      epochContinue = barrier();
    probe.pauseAfterEpoch(async () => {
      epochSeen.release();
      await epochContinue.promise;
    });
    pages.push([message('wmExpired', waitCode.code)]);
    await service.sync();
    try {
      await epochSeen.promise;
      await new Promise((r) => setTimeout(r, Math.max(0, shortExpiry - Date.now()) + 30));
      epochContinue.release();
      await service.drain();
      namedCheck('CODE_EXPIRES_AFTER_EPOCH_BEFORE_UPDATE', () => {
        assert.equal(sandboxWechatIndex.forUser('wmExpired'), undefined);
        assert.equal(sandboxWechatIndex.forUser('wmRecovery'), R);
      });
    } finally {
      epochContinue.release();
    }
    await q(
      "update sandbox_wechat set bound_at=date_trunc('milliseconds',clock_timestamp())+interval '2 microseconds' where tenant_id=$1",
      [R.id],
    );
    await q(
      "update sandbox_wechat set external_userid='wmRecovery',bound_at=(select bound_at from sandbox_wechat where tenant_id=$2)-interval '1 microsecond' where tenant_id=$1",
      [S.id, R.id],
    );
    for (const rt of [R, S]) {
      await withTenantScope(rt, () => drainStore(5000));
      rt.state = 'closed';
      rt.store.pgBackend?.close();
      await withTenantScope(rt, closeConfig);
      dropShutdownHooks(rt);
      dropTenantState(rt.id);
      unregisterRuntime(rt.id);
    }
    R = (await loadSandboxRuntime(
      deps,
      { id: recoveryBox.tenantId, slug: recoveryBox.slug, expiresAt: recoveryBox.expiresAt },
      env.SANDBOX_HOST,
      async () => fakeLock(),
    ))!;
    S = (await loadSandboxRuntime(
      deps,
      { id: olderBox.tenantId, slug: olderBox.slug, expiresAt: olderBox.expiresAt },
      env.SANDBOX_HOST,
      async () => fakeLock(),
    ))!;
    namedCheck('REBUILD_BOUND_AT_NEWEST_WINS_OLDER_LOADED_LAST', () => {
      assert.equal(sandboxWechatIndex.forUser('wmRecovery'), R);
      assert.equal(sandboxWechatIndex.boundUser(S), undefined);
    });
    await q('update sandbox_wechat set external_userid=null,bound_at=null where tenant_id=$1', [S.id]);
    await service.close();
    activeBinding = binding;
    await start();
    // 95003 当刻置 full、持久化、重复日内不告警；绑定者依然对话。
    rejectSend = true;
    await deliver(message('wm10', '未绑定'));
    check(() => {
      assert.equal(service.health().full, true);
      assert.equal(service.health().failing, false);
      assert.equal(fullAlerts, 1);
    });
    assert.ok((await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID)).fullSince);
    const fullVisitor = await create();
    assert.equal(await state(fullVisitor.token), 'full');
    const full = await req('/api/sandbox/wechat/code', a.token, 'POST');
    check(() => assert.equal(full.status, 409));
    assert.equal((await full.json()).error, 'sandbox_wecom_full');
    const noReply = sends.length;
    await deliver(message('wm11', '未绑定'));
    check(() => assert.equal(sends.length, noReply));
    assert.equal(await state(), 'bound');
    // 95003 不计 send 失败；不借助任何成功发送，下一次分钟重读即可再次签码。
    const beforeResetSends = sends.length;
    await resetSandboxWecomFull(db);
    minute();
    await service.drain();
    await service.issueCode(S);
    namedCheck('FULL_RESET_NEXT_MINUTE_CODE_WITHOUT_SUCCESSFUL_SEND', () => {
      assert.equal(sends.length, beforeResetSends);
      assert.equal(service.health().full, false);
      assert.equal(service.health().failing, false);
      assert.equal(service.contactLink(), 'fake-contact');
    });
    const boundBefore = sends.length;
    await deliver(message('wm6', '你好'));
    check(() => {
      assert.ok(sends.length > boundBefore);
      assert.equal(sends.at(-1)!.body.touser, 'wm6');
      assert.equal(service.health().failing, false);
    });
    rejectSend = true;
    await deliver(message('wmFullAgain', '未绑定'));
    await service.tick();
    await service.drain();
    assert.equal(fullAlerts, 1);
    await service.close();
    await start();
    check(() => {
      assert.equal(service.health().full, true);
      assert.equal(fullAlerts, 1);
    });
    assert.equal(
      await runSandbox(['wecom-reset-full'], {
        connect: async () => ({ db, close: async () => {} }),
        lock: async () => {
          throw new Error('复位不取进程锁');
        },
      }),
      0,
    );
    await reaper.tick();
    await service.drain();
    check(() => assert.equal(service.health().full, false));
    await sign();
    // Codex 四步交错：旧写已入库但未回执 → 复位 → 新 95003 → 旧写结束。
    const oldFullEntered = barrier(),
      oldFullRelease = barrier(),
      newFullEntered = barrier(),
      newFullRelease = barrier();
    fullWriteHook = async (write) => {
      await write();
      oldFullEntered.release();
      await oldFullRelease.promise;
    };
    rejectSend = true;
    pages.push([message('wmFullOld', '未绑定')]);
    await service.sync();
    try {
      await oldFullEntered.promise;
      const revisionBeforeReset = (await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID)).fullRevision;
      await resetSandboxWecomFull(db);
      fullWriteHook = async (write) => {
        newFullEntered.release();
        await newFullRelease.promise;
        await write();
      };
      rejectSend = true;
      pages.push([message('wm6', '你好')]);
      await service.sync();
      await newFullEntered.promise;
      oldFullRelease.release();
      await new Promise((r) => setTimeout(r, 20));
      const reread = service.refreshFull();
      assert.equal((await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID)).fullSince, null);
      await assert.rejects(service.issueCode(A), /sandbox_wecom_full/);
      newFullRelease.release();
      await reread;
      await service.drain();
      const after = await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID);
      namedCheck('FULL_RESET_NEW_95003_OLD_TASK_CANNOT_CLEAR_PENDING', () => {
        assert.equal(service.health().full, true);
        assert.ok(after.fullSince);
        assert.equal(BigInt(after.fullRevision), BigInt(revisionBeforeReset) + 2n);
      });
    } finally {
      oldFullRelease.release();
      newFullRelease.release();
      await service.drain();
    }
    await resetSandboxWecomFull(db);
    await service.refreshFull();
    // 真实 PG：绑定被行锁挂住时 closing 立即生效，屏障等待，汇点从开始就拒发。
    if (appUrl) {
      await withTenantScope(A, () => drainStore(5000));
      await withTenantScope(B, () => drainStore(5000));
      // 签码占住全局锁时，其他人的收件无锁通过；closing 的屏障等签码事务落定。
      const issuanceLocker = new pg.Client({ connectionString: appUrl });
      await issuanceLocker.connect();
      try {
        await issuanceLocker.query('begin');
        await issuanceLocker.query("select set_config('app.tenant_id',$1,true)", [R.id]);
        await issuanceLocker.query('select * from sandbox_wechat for update');
        const issuance = service.issueCode(R);
        const issuanceRejected = assert.rejects(issuance, /sandbox_expired/);
        await until(() => R.inflight.size > 0);
        const freeBefore = sends.length;
        pages.push([message('wm6', '你好')]);
        await service.sync();
        await until(() => sends.slice(freeBefore).some((s) => s.body.touser === 'wm6'));
        namedCheck('BLOCKED_CODE_ISSUE_OTHER_BOUND_USER_RECEIVES', () => assert.ok(R.inflight.size > 0));
        await reaper.end(R.id);
        await reaper.tick();
        namedCheck('BLOCKED_CODE_ISSUE_R12_BARRIER_WAITS', () => {
          assert.equal(R.state, 'closing');
          assert.equal(runtimeOf(R.id), R);
          assert.ok(R.inflight.size > 0);
        });
        await issuanceLocker.query('commit');
        await issuanceRejected;
        await service.drain();
        await reaper.tick();
        assert.equal(runtimeOf(R.id), undefined);
      } finally {
        await issuanceLocker.query('rollback').catch(() => {});
        await issuanceLocker.end();
      }
      // P 的改绑和新入站均走真实按人串行入口，其他人不等全局锁。
      const personLocker = new pg.Client({ connectionString: appUrl });
      await personLocker.connect();
      try {
        const personCode = await binding.issue(
          S,
          () => 'fake-contact',
          () => false,
        );
        await personLocker.query('begin');
        await personLocker.query("select set_config('app.tenant_id',$1,true)", [A.id]);
        await personLocker.query('select * from sandbox_wechat for update');
        const following = message('wmNext', '改绑进行中的这一句');
        const personBefore = sends.length;
        pages.push([message('wmNext', personCode.code), following, message('wm6', '你好')]);
        await service.sync();
        await until(() => A.inflight.size > 0 && sandboxWechatIndex.forUser('wmNext') === undefined);
        const resolving = binding.resolve('wmNext');
        let resolved = false;
        void resolving.then(() => {
          resolved = true;
        });
        await until(() => sends.slice(personBefore).some((s) => s.body.touser === 'wm6'));
        namedCheck('REBINDING_USER_RESOLVE_WAITS_OTHER_USER_CONTINUES', () => assert.equal(resolved, false));
        await personLocker.query('commit');
        await service.drain();
        namedCheck('INBOUND_DURING_BINDING_REACHES_NEW_SESSION', () => {
          assert.equal(sandboxWechatIndex.forUser('wmNext'), S);
          assert.ok(withTenantScope(S, () => getSession('wecom:wmNext'))!.messages.some((m) => m.msgid === following.msgid));
          assert.equal(
            withTenantScope(A, () => getSession('wecom:wmNext'))?.messages.some((m) => m.msgid === following.msgid) ?? false,
            false,
          );
        });
        assert.equal(await resolving, S);
      } finally {
        await personLocker.query('rollback').catch(() => {});
        await personLocker.end();
      }
      // 到期路径：失败事务落定后也不能恢复旧绑定；解析 drop 不等互斥链。
      const c = await create();
      const C = runtimeOf(c.tenantId)!;
      const c1 = await binding.issue(
        C,
        () => 'fake-contact',
        () => false,
      );
      await binding.bind('wm15', c1.code);
      const c2 = await binding.issue(
        C,
        () => 'fake-contact',
        () => false,
      );
      const expiryLock = new pg.Client({ connectionString: appUrl });
      await expiryLock.connect();
      try {
        await q(
          "create function fake_expiry_failure() returns trigger language plpgsql as $$ begin if NEW.external_userid = 'wm16' then raise exception 'fake-expiry-failure'; end if; return NEW; end $$",
        );
        await q('create trigger fake_expiry_failure before update on sandbox_wechat for each row execute function fake_expiry_failure()');
        await expiryLock.query('begin');
        await expiryLock.query("select set_config('app.tenant_id',$1,true)", [C.id]);
        await expiryLock.query('select * from sandbox_wechat for update');
        const pending = binding.bind('wm16', c2.code);
        const failure = assert.rejects(pending);
        await until(() => C.inflight.size > 0 && sandboxWechatIndex.boundUser(C) === undefined);
        await q('update tenants set expires_at=now() where id=$1', [C.id]);
        await reaper.tick();
        check(() => {
          assert.equal(C.state, 'closing');
          assert.equal(runtimeOf(C.id), C);
          assert.ok(C.inflight.size > 0);
        });
        assert.equal((await binding.bind('wm17', c2.code)).status, 'expired');
        await assert.rejects(
          binding.issue(
            C,
            () => 'fake-contact',
            () => false,
          ),
          /sandbox_expired/,
        );
        await expiryLock.query('commit');
        await failure;
        check(() => {
          assert.equal(sandboxWechatIndex.forUser('wm15'), undefined);
          assert.equal(sandboxWechatIndex.forUser('wm16'), undefined);
        });
        await reaper.tick();
        check(() => {
          assert.equal(runtimeOf(C.id), undefined);
          assert.equal(sandboxWechatIndex.keyCount(C.id), 0);
        });
      } finally {
        await expiryLock.query('rollback').catch(() => {});
        await expiryLock.end();
        await q('drop trigger if exists fake_expiry_failure on sandbox_wechat');
        await q('drop function if exists fake_expiry_failure()');
      }
      // 旧沙箱等 epoch 期间 closing，跳过旧行的清空，活着的目标仍然能绑上。
      const d = await create();
      const D = runtimeOf(d.tenantId)!;
      const dcode = await binding.issue(
        D,
        () => 'fake-contact',
        () => false,
      );
      await binding.bind('wm18', dcode.code);
      const moveFromClosing = await sign();
      const epochLock = new pg.Client({ connectionString: appUrl });
      await epochLock.connect();
      try {
        await epochLock.query('begin');
        await epochLock.query('select * from sandbox_process_epoch for update');
        const pending = binding.bind('wm18', moveFromClosing.code);
        await until(async () =>
          (
            await q<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='transactionid' and query ilike '%select epoch%for share%'",
            )
          ).some((r) => r.n > 0),
        );
        await reaper.end(D.id);
        await reaper.tick();
        check(() => {
          assert.equal(D.state, 'closing');
          assert.ok(D.inflight.size > 0);
        });
        await epochLock.query('commit');
        assert.equal((await pending).status, 'bound');
        check(() => assert.equal(sandboxWechatIndex.forUser('wm18'), A));
        await reaper.tick();
        check(() => {
          assert.equal(runtimeOf(D.id), undefined);
          assert.equal(sandboxWechatIndex.forUser('wm18'), A);
        });
      } finally {
        await epochLock.query('rollback').catch(() => {});
        await epochLock.end();
      }
      const locker = new pg.Client({ connectionString: appUrl });
      await locker.connect();
      try {
        const blocked = await sign(b.token);
        await locker.query('begin');
        await locker.query("select set_config('app.tenant_id',$1,true)", [B.id]);
        await locker.query('select * from sandbox_wechat for update');
        const pending = binding.bind('wm12', blocked.code);
        await until(() => B.inflight.size > 0 && sandboxWechatIndex.boundUser(B) === undefined);
        check(() =>
          assert.throws(
            () =>
              withTenantScope(B, () =>
                sandboxWechatIndex.prepare(
                  'kf/send_msg',
                  { touser: 'wm6', open_kfid: env.SANDBOX_WECOM_OPEN_KFID, msgtype: 'text', text: { content: '撤下' } },
                  env.SANDBOX_WECOM_OPEN_KFID,
                  env.SANDBOX_HOST,
                ),
              ),
            SandboxSendRefused,
          ),
        );
        await reaper.end(B.id);
        check(() => assert.equal(B.state, 'closing'));
        await reaper.tick();
        check(() => {
          assert.equal(B.state, 'closing');
          assert.ok(B.inflight.size > 0);
          assert.equal(runtimeOf(B.id), B);
        });
        await assert.rejects(service.issueCode(B), /sandbox_expired/);
        await locker.query('commit');
        await pending;
        check(() => {
          assert.equal(sandboxWechatIndex.forUser('wm12'), undefined);
          assert.equal(sandboxWechatIndex.forUser('wm6'), undefined);
        });
        await reaper.tick();
        check(() => {
          assert.equal(runtimeOf(B.id), undefined);
          assert.ok(Object.values(tenantKeys(B.id)).every((n) => n === 0));
        });
      } finally {
        await locker.query('rollback').catch(() => {});
        await locker.end();
      }
      // 真进程锁断开，通知钩子延后；绑定入口与新进程 epoch 的两种先后。
      const delayedLost = barrier();
      let detectedLost = false,
        deliveredLost = false;
      const processLock = await acquireSandboxProcess(appUrl, () => {
        detectedLost = true;
        void delayedLost.promise.then(() => {
          deliveredLost = true;
          service.stop();
        });
      });
      let successorLock: Awaited<ReturnType<typeof acquireSandboxProcess>> | undefined;
      const terminateProcessLock = async () => {
        const [row] = await q<{ pid: number }>(
          "select pid from pg_stat_activity where datname=current_database() and state='idle' and query like 'select pg_try_advisory_lock%' limit 1",
        );
        assert.ok(row);
        await q('select pg_terminate_backend($1)', [row.pid]);
      };
      const epochCode = await sign();
      const locker2 = new pg.Client({ connectionString: appUrl });
      await locker2.connect();
      try {
        await withTenantScope(A, () => drainStore(5000));
        await locker2.query('begin');
        await locker2.query("select set_config('app.tenant_id',$1,true)", [A.id]);
        await locker2.query('select * from sandbox_wechat for update');
        pages.push([message('wm13', epochCode.code)]);
        await service.sync();
        await until(async () =>
          (
            await q<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='transactionid' and query ilike '%update sandbox_wechat%'",
            )
          ).some((r) => r.n > 0),
        );
        await terminateProcessLock();
        await until(() => detectedLost);
        successorLock = await acquireSandboxProcess(appUrl, () => {});
        let advanced = false;
        const next = advanceSandboxEpoch(db).then((v) => {
          advanced = true;
          return v;
        });
        await new Promise((r) => setTimeout(r, 40));
        namedCheck('DELAYED_ONLOST_OLD_BINDING_SHARE_BLOCKS_NEW_EPOCH', () => {
          assert.equal(advanced, false);
          assert.equal(deliveredLost, false);
          assert.ok(A.inflight.size > 0);
        });
        await locker2.query('commit');
        await service.drain();
        assert.equal(await next, '1');
        assert.equal(sandboxWechatIndex.forUser('wm13'), A);
        delayedLost.release();
        await until(() => deliveredLost);
        const stoppedSends = sends.length;
        pages.push([message('wm13', '丢锁后入站')]);
        await service.sync();
        await service.drain();
        namedCheck('DELAYED_ONLOST_DELIVERED_STOPS_OLD_REQUESTS', () => assert.equal(sends.length, stoppedSends));
        pages = [];
        await service.close();
        await cleanup();
        A = (await loadSandboxRuntime(deps, { id: a.tenantId, slug: a.slug, expiresAt: a.expiresAt }, env.SANDBOX_HOST, async () =>
          fakeLock(),
        ))!;
        namedCheck('NEW_EPOCH_REBUILD_SEES_OLD_COMMITTED_BINDING', () => assert.equal(sandboxWechatIndex.forUser('wm13'), A));
        // 第二种先后：入站事务在 epoch 查询之前挂住，新进程先推进，旧事务回滚。
        const preFence = receiptProbe(db);
        const oldBinding = new SandboxWechatBinding(preFence.db, '1');
        const current = new SandboxWechatBinding(db, '1');
        const newCode = await current.issue(
          A,
          () => 'fake-contact',
          () => false,
        );
        activeBinding = oldBinding;
        serviceEpoch = '1';
        await start();
        const beforeFence = barrier(),
          continueFence = barrier(),
          secondLost = barrier();
        let secondDetected = false,
          secondDelivered = false;
        successorLock.onLost(() => {
          secondDetected = true;
          void secondLost.promise.then(() => {
            secondDelivered = true;
            service.stop();
          });
        });
        preFence.pauseBeforeEpoch(async () => {
          beforeFence.release();
          await continueFence.promise;
        });
        pages.push([message('wm14', newCode.code)]);
        await service.sync();
        try {
          await beforeFence.promise;
          await terminateProcessLock();
          await until(() => secondDetected);
          const newestLock = await acquireSandboxProcess(appUrl, () => {});
          try {
            assert.equal(await advanceSandboxEpoch(db), '2');
            assert.equal(secondDelivered, false);
            continueFence.release();
            await service.drain();
            namedCheck('DELAYED_ONLOST_NEW_EPOCH_FIRST_OLD_BINDING_ROLLS_BACK', () => {
              assert.equal(sandboxWechatIndex.forUser('wm13'), A);
              assert.equal(sandboxWechatIndex.forUser('wm14'), undefined);
            });
            assert.equal(
              (await q<{ external_userid: string }>('select external_userid from sandbox_wechat where tenant_id=$1', [A.id]))[0]!
                .external_userid,
              'wm13',
            );
            secondLost.release();
            await until(() => secondDelivered);
            await service.close();
            await cleanup();
            A = (await loadSandboxRuntime(deps, { id: a.tenantId, slug: a.slug, expiresAt: a.expiresAt }, env.SANDBOX_HOST, async () =>
              fakeLock(),
            ))!;
            namedCheck('NEW_EPOCH_REBUILD_AFTER_OLD_ROLLBACK_MATCHES_DATABASE', () => assert.equal(sandboxWechatIndex.forUser('wm13'), A));
            activeBinding = new SandboxWechatBinding(db, '2');
            serviceEpoch = '2';
            await start();
            await deliver(message('wm14', newCode.code));
            assert.equal(sandboxWechatIndex.forUser('wm14'), A);
          } finally {
            await newestLock.release();
          }
        } finally {
          continueFence.release();
          secondLost.release();
        }
      } finally {
        delayedLost.release();
        await locker2.query('rollback').catch(() => {});
        await locker2.end();
        await successorLock?.release();
        await processLock.release();
      }
    } else {
      // PGlite 同样核签发限额；不在工作树中做变异测试。
      await sandboxWechatIndex.exclusive(async () => {
        for (let i = 0; i < 10; i++) {
          sandboxWechatIndex.canIssue(B, Date.now());
          sandboxWechatIndex.recordIssue(B, Date.now());
        }
      });
      await assert.rejects(service.issueCode(B), /sandbox_wechat_limited/);
      await reaper.end(A.id);
      await reaper.tick();
      check(() => {
        assert.equal(sandboxWechatIndex.forUser('wm9'), undefined);
        assert.equal(sandboxWechatIndex.forUser('wm6'), B);
      });
      await reaper.end(B.id);
      await reaper.tick();
      check(() => assert.equal(sandboxWechatIndex.forUser('wm6'), undefined));
      const fixedBefore = sends.length;
      await deliver(message('wm6', '已删除'));
      check(() => assert.equal(sends.length, fixedBefore + 1));
    }
    console.log(`binding: ${appUrl ? '真实 PG 并发 / fencing' : 'PGlite 全流程'} 通过`);
  } finally {
    await service!.close();
    reaper.stop();
    await reaper.drain();
  }
}
try {
  const lite = await openTestDb();
  try {
    await lite.pg.exec('SET ROLE agent_app');
    const q: Query = (sql, params = []) =>
      lite.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query(sql, params)).rows as never;
      });
    await suite(lite.db, q);
  } finally {
    await cleanup();
    await lite.close();
  }
  if (process.env.PG_TEST_URL) {
    const real = await openOutboundTestPg(process.env.PG_TEST_URL);
    try {
      assert.equal(rowsOf(await real.db.execute(sql`select * from sandbox_wechat`)).length, 0);
      await suite(real.db, real.query, real.appUrl);
    } finally {
      await cleanup();
      await real.close();
    }
  } else console.log('SKIP: 真实 PG 需要 PG_TEST_URL');
  console.log(`SELFTEST PASS: 沙箱绑定 ${checks} 项`);
} finally {
  globalThis.fetch = fetchBefore;
  await cleanup();
  fs.rmSync(temp, { recursive: true, force: true });
}
