// 05 第 25 步：假企微、实例收件提交顺序、冷启动、限频、回调与宿主回归。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { openDb, type Db } from '../../db/client.js';
import { openTestDb, createRealPgFixture, testConfigDeps, fakeLock } from '../../db/testing.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig } from '../../config/source.js';
import { shanhaiBrand } from '../../packs/travel/brand-fixture.js';
import { drainStore } from '../../store.js';
import { dropShutdownHooks } from '../../shutdown.js';
import { readSandboxWecomState, commitSandboxWecomCursor } from '../../db/repo/sandbox-wecom.js';
import { __alertTest } from '../../ops/alert.js';
import { computeSignature } from '../../wecom-crypto.js';
import { __test, __wecomTest, isWecomEnabled } from '../../adapters/wecom.js';
import type { KfMessage } from '../../adapters/wecom-state.js';
import { ENV_ACCOUNT_ID } from '../../channels/accounts.js';
import {
  configureTenancy,
  hostRuntime,
  withTenantScope,
  scopedRuntime,
  withoutTenantScope,
  createTenantRuntime,
  runtimeOf,
  unregisterRuntime,
} from '../runtime.js';
import { dropTenantState } from '../state.js';
import { SandboxProcess, sandboxApp } from './process.js';
import { SandboxWecom, createSandboxWecom } from './wecom.js';
import { SandboxWechatBinding } from './binding.js';
import { sandboxWechatIndex } from './outbound.js';
import { provisionSandbox } from './provision.js';

const env = {
  SANDBOX_HOST: 'sandbox.example.invalid',
  SANDBOX_WECOM_CORP_ID: 'fake-corp',
  SANDBOX_WECOM_SECRET: 'fake-secret', // gitleaks:allow
  SANDBOX_WECOM_TOKEN: 'fake-callback-token', // gitleaks:allow
  SANDBOX_WECOM_AES_KEY: Buffer.alloc(32, 7).toString('base64').slice(0, -1),
  SANDBOX_WECOM_OPEN_KFID: 'fake-kfid',
};
const originalWarn = console.warn;
const warnings: string[] = [];
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
};
const originalFetch = globalThis.fetch;
let forbiddenRequests = 0;
globalThis.fetch = async () => {
  forbiddenRequests++;
  throw new Error('禁止真实网络请求');
};
let now = Date.parse('2026-10-12T04:00:00Z');
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
function encrypt(text: string, corp = env.SANDBOX_WECOM_CORP_ID): string {
  const body = Buffer.from(text);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  const raw = Buffer.concat([Buffer.alloc(16, 9), size, body, Buffer.from(corp)]);
  const padding = 32 - (raw.length % 32);
  const key = Buffer.from(`${env.SANDBOX_WECOM_AES_KEY}=`, 'base64');
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}
function signed(encrypted: string): string {
  const timestamp = '1234',
    nonce = 'fake-nonce';
  return new URLSearchParams({
    timestamp,
    nonce,
    msg_signature: computeSignature(env.SANDBOX_WECOM_TOKEN, timestamp, nonce, encrypted),
  }).toString();
}
function message(id: string, user = 'wmUnbound', seconds = now / 1000): KfMessage {
  return {
    msgid: id,
    external_userid: user,
    open_kfid: env.SANDBOX_WECOM_OPEN_KFID,
    send_time: seconds,
    origin: 3,
    msgtype: 'text',
    text: { content: '假客户文字' },
  };
}

// 企微事件消息顶层没有 open_kfid、external_userid，2026-10-12 线上 sync_msg 实测。
function eventMessage(id: string, user: string, event: NonNullable<KfMessage['event']>): KfMessage {
  return {
    msgid: id,
    send_time: now / 1000,
    origin: 4,
    msgtype: 'event',
    event: { open_kfid: env.SANDBOX_WECOM_OPEN_KFID, external_userid: user, ...event },
  } as KfMessage; // 保留宿主共用类型的顶层必填字段；假事件按真实 wire 布局构造。
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

class VirtualClock {
  private events = new Set<{ at: number; fn: () => void }>();
  after(ms: number, fn: () => void): () => void {
    const event = { at: now + ms, fn };
    this.events.add(event);
    return () => {
      this.events.delete(event);
    };
  }
  schedule = (fn: () => void, ms: number): (() => void) => {
    check(() => assert.equal(ms, 60_000, '重试定时器间隔为 60 秒'));
    let cancel = () => {};
    const run = () => {
      fn();
      cancel = this.after(ms, run);
    };
    cancel = this.after(ms, run);
    return () => cancel();
  };
  wait(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = this.after(ms, () => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
      const abort = () => {
        cancel();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async advance(ms: number): Promise<void> {
    await flushMicrotasks();
    const until = now + ms;
    for (;;) {
      const next = [...this.events].filter((e) => e.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.events.delete(next);
      now = next.at;
      next.fn();
      await flushMicrotasks();
    }
    now = until;
    await flushMicrotasks();
  }
  pending(): number {
    return this.events.size;
  }
}

class FakeWecom {
  sendRuntime: ReturnType<typeof scopedRuntime>;
  calls: { path: string; body: Record<string, unknown>; at: number }[] = [];
  aborted: string[] = [];
  active = 0;
  pause: ((path: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<void>) | null = null;
  pages: { next_cursor?: string; has_more: number; msg_list: KfMessage[] }[] = [];
  tokenFails = false;
  contactFails = false;
  syncFails = false;
  sendFails = false;
  expireOnce = false;
  beforeSync: (() => Promise<void>) | null = null;
  onSend: (() => Promise<void>) | null = null;
  private serial = 0;
  request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.split('/cgi-bin/')[1]!;
    check(() => assert.equal(scopedRuntime(), path.startsWith('kf/send_msg') ? this.sendRuntime : undefined, '企微 I/O 使用预期作用域'));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.calls.push({ path, body, at: now });
    assert.ok(init?.signal, '假企微必须收到 AbortSignal');
    const signal = init.signal;
    signal.throwIfAborted();
    this.active++;
    let abort!: () => void;
    const canceled = new Promise<never>((_, reject) => {
      abort = () => {
        this.aborted.push(path);
        reject(signal.reason);
      };
    });
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await Promise.race([this.respond(path, body, signal), canceled]);
    } finally {
      signal.removeEventListener('abort', abort);
      this.active--;
    }
  };
  private async respond(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    await this.pause?.(path, body, signal);
    if (path === 'gettoken') return Response.json(this.tokenFails ? { errcode: 48007 } : { access_token: 'fake-access', expires_in: 7200 });
    if (path === 'kf/add_contact_way') {
      check(() => assert.deepEqual(body, { open_kfid: env.SANDBOX_WECOM_OPEN_KFID, scene: 'try' }));
      return Response.json(this.contactFails ? { errcode: 48007 } : { url: 'https://contact.example.invalid/fake-only' });
    }
    if (path === 'kf/sync_msg') {
      await this.beforeSync?.();
      if (this.syncFails) return Response.json({ errcode: 48007 });
      return Response.json(this.pages.shift() ?? { next_cursor: `cursor-${++this.serial}`, has_more: 0, msg_list: [] });
    }
    if (path === 'kf/send_msg' || path === 'kf/send_msg_on_event') {
      await this.onSend?.();
      if (this.expireOnce) {
        this.expireOnce = false;
        return Response.json({ errcode: 42001 });
      }
      return Response.json({ errcode: this.sendFails ? 45009 : 0 });
    }
    throw new Error('禁止未预期接口（含模型、昵称与头像）');
  }
  sends() {
    return this.calls.filter((c) => c.path.startsWith('kf/send_msg'));
  }
}

// app 比运行时先创建；回调必须在启动后动态出现，且不经过 cookie 解析。
function verify(name: string, fn: () => void): void {
  try {
    check(fn);
  } catch (error) {
    throw new Error(`REVIEW FAIL: ${name}`, { cause: error });
  }
  console.log(`REVIEW PASS: ${name}`);
}

async function reviewSuite(): Promise<void> {
  // 慢客户的请求和欢迎请求并发；虚拟时间推进两段 11 秒。
  const clock = new VirtualClock();
  const fake = new FakeWecom();
  const started = now;
  fake.pause = (path, _, signal) => (path === 'kf/send_msg' ? clock.wait(11_000, signal) : Promise.resolve());
  const welcome = eventMessage('urgent', 'wmUrgent', { event_type: 'enter_session', welcome_code: 'fake-urgent' });
  fake.pages.push(
    { next_cursor: 'slow-page', has_more: 1, msg_list: [message('slow-one', 'wmSlowOne'), message('slow-two', 'wmSlowTwo'), welcome] },
    { next_cursor: 'next-slow-page', has_more: 0, msg_list: [] },
  );
  const instance = new SandboxWecom(env, {
    request: fake.request,
    now: () => now,
    schedule: clock.schedule,
    read: async () => ({ cursor: null, fullSince: null }),
    commit: async () => {},
  });
  let startReturned = false;
  const start = instance.start().then(() => {
    startReturned = true;
  });
  try {
    await flushMicrotasks();
    verify('启动不等待首轮发送', () => assert.equal(startReturned, true));
    verify('欢迎请求不等待其他客户慢发送', () => {
      const event = fake.sends().find((c) => c.path === 'kf/send_msg_on_event');
      assert.ok(event);
      assert.ok(event.at - started < 20_000);
      assert.equal(fake.active, 2, '两条慢发送仍在途');
    });
    verify('后续拉取不等待慢发送', () => assert.equal(fake.calls.filter((c) => c.path === 'kf/sync_msg').length, 2));
    await clock.advance(22_000);
    await instance.drain();
  } finally {
    await clock.advance(22_000);
    await start;
    await instance.close();
  }

  // 失败立即撤掉该微信的限频记录；静默 10 分钟不再形成故障死锁。
  const retryClock = new VirtualClock();
  const retryFake = new FakeWecom();
  retryFake.sendFails = true;
  retryFake.pages.push({ next_cursor: 'fail-once', has_more: 0, msg_list: [message('fail-once', 'wmRetry')] });
  const notifications: boolean[] = [];
  const retry = new SandboxWecom(env, {
    request: retryFake.request,
    now: () => now,
    schedule: retryClock.schedule,
    read: async () => ({ cursor: null, fullSince: null }),
    commit: async () => {},
    notify: (failing) => {
      notifications.push(failing);
    },
  });
  try {
    await retry.start();
    await retry.drain();
    assert.equal(retry.health().failing, true);
    await retryClock.advance(10 * 60_000);
    await retry.drain();
    verify('单次发送失败静默10分钟自动恢复且不告警', () => {
      assert.equal(retry.health().failing, false);
      assert.deepEqual(notifications, []);
      assert.ok(retry.contactLink());
    });
    retryFake.pages.push({ next_cursor: 'fail-again', has_more: 0, msg_list: [message('fail-again', 'wmRetry')] });
    await retry.sync();
    await retry.drain();
    retryFake.sendFails = false;
    const before = retryFake.sends().length;
    retryFake.pages.push({ next_cursor: 'reply-again', has_more: 0, msg_list: [message('reply-again', 'wmRetry')] });
    await retry.sync();
    await retry.drain();
    verify('发送失败撤销个人限频', () => assert.equal(retryFake.sends().length, before + 1));
    retryFake.pages.push({ has_more: 0, msg_list: [] });
    await retry.sync();
    await retry.drain();
    verify('空页缺游标保留原位且不失败', () => assert.equal(retry.health().failing, false));
    await retry.sync();
    await retry.drain();
    verify('空页后沿原游标继续拉取', () =>
      assert.equal(retryFake.calls.filter((c) => c.path === 'kf/sync_msg').at(-1)!.body.cursor, 'reply-again'),
    );
  } finally {
    await retry.close();
  }

  const timerClock = new VirtualClock();
  const timerFake = new FakeWecom();
  timerFake.contactFails = true;
  const timer = new SandboxWecom(env, {
    request: timerFake.request,
    now: () => now,
    schedule: timerClock.schedule,
    read: async () => ({ cursor: null, fullSince: null }),
    commit: async () => {},
  });
  try {
    await timer.start();
    await timer.drain();
    verify('取不到客服链接进入故障', () => {
      assert.equal(timer.health().failing, true);
      assert.equal(timer.contactLink(), null);
    });
    await timerClock.advance(59_999);
    assert.equal(timerFake.calls.filter((c) => c.path === 'kf/add_contact_way').length, 1);
    timerFake.contactFails = false;
    await timerClock.advance(1);
    await timer.drain();
    verify('60秒定时重试取到链接即恢复', () => {
      assert.equal(timerFake.calls.filter((c) => c.path === 'kf/add_contact_way').length, 2);
      assert.equal(timer.health().failing, false);
      assert.ok(timer.contactLink());
    });
  } finally {
    await timer.close();
  }
  verify('关闭后撤销重试定时器', () => assert.equal(timerClock.pending(), 0));

  // 三类在途请求均尊重 init.signal；删除生产 abort 时断言立即变红，而非等真实超时。
  for (const endpoint of ['gettoken', 'kf/sync_msg', 'kf/send_msg']) {
    const abortClock = new VirtualClock();
    const abortFake = new FakeWecom();
    abortFake.pause = (path, _, signal) => (path === endpoint ? abortClock.wait(11_000, signal) : Promise.resolve());
    abortFake.pages.push({ next_cursor: 'abort-page', has_more: 0, msg_list: [message('abort-message', 'wmAbort')] });
    const aborting = new SandboxWecom(env, {
      request: abortFake.request,
      now: () => now,
      schedule: abortClock.schedule,
      read: async () => ({ cursor: null, fullSince: null }),
      commit: async () => {},
    });
    let returned = false;
    const startup = aborting.start().then(() => {
      returned = true;
    });
    let closing: Promise<void> | undefined;
    try {
      await flushMicrotasks();
      verify(`启动不等待首轮请求 ${endpoint}`, () => assert.equal(returned, true));
      assert.ok(abortFake.calls.some((c) => c.path === endpoint));
      closing = aborting.close();
      await flushMicrotasks();
      verify(`停机立即abort在途 ${endpoint}`, () => {
        assert.deepEqual(abortFake.aborted, [endpoint]);
        assert.equal(abortFake.active, 0);
      });
      await closing;
    } finally {
      await abortClock.advance(22_000);
      await startup;
      await (closing ?? aborting.close());
    }
  }
}

async function stoppedObservationSuite(): Promise<void> {
  const clock = new VirtualClock();
  const fake = new FakeWecom();
  fake.tokenFails = true;
  const notices: boolean[] = [];
  const instance = new SandboxWecom(env, {
    request: fake.request,
    now: () => now,
    schedule: clock.schedule,
    read: async () => ({ cursor: null, fullSince: null }),
    commit: async () => {},
    notify: (failing) => {
      notices.push(failing);
    },
  });
  try {
    await instance.start();
    await instance.drain();
    await clock.advance(9 * 60_000);
    await instance.drain();
    await instance.close();
    const requests = fake.calls.length;
    await clock.advance(60_000);
    instance.health();
    instance.contactLink();
    verify('停机后观测不触发迟到告警或请求', () => {
      assert.deepEqual(notices, []);
      assert.equal(fake.calls.length, requests);
    });
  } finally {
    await instance.close();
  }
}

async function diagnosticSuite(): Promise<void> {
  const clock = new VirtualClock();
  const fake = new FakeWecom();
  fake.tokenFails = true;
  const start = warnings.length;
  const instance = new SandboxWecom(env, {
    request: fake.request,
    now: () => now,
    schedule: clock.schedule,
    read: async () => ({ cursor: null, fullSince: null }),
    commit: async () => {},
  });
  try {
    await instance.start();
    await instance.drain();
    for (let i = 0; i < 3; i++) {
      await instance.tick();
      await instance.drain();
    }
    const query = `/wecom/callback?msg_signature=wrong&timestamp=1234&nonce=fake-nonce&echostr=${encodeURIComponent(encrypt('fake-secret-payload'))}`;
    for (let i = 0; i < 3; i++) await instance.routes.request(query);
    verify('同一种错误按分钟去重', () => {
      assert.equal(warnings.slice(start).filter((line) => line.includes('interface=gettoken ')).length, 1);
      assert.equal(warnings.slice(start).filter((line) => line.includes('errcode=signature_invalid ')).length, 1);
    });
    await clock.advance(60_000);
    await instance.drain();
    await instance.routes.request(query);
    verify('一分钟后日志包含累计错误数', () => {
      const rows = warnings.slice(start).filter((line) => line.includes('interface=gettoken '));
      assert.equal(rows.length, 2);
      assert.match(rows[1]!, /count=4$/);
      const signatures = warnings.slice(start).filter((line) => line.includes('errcode=signature_invalid '));
      assert.equal(signatures.length, 2);
      assert.match(signatures[1]!, /count=3$/);
    });
    fake.tokenFails = false;
    fake.contactFails = true;
    await instance.tick();
    await instance.drain();
    fake.contactFails = false;
    fake.syncFails = true;
    await instance.tick();
    await instance.drain();
    fake.syncFails = false;
    fake.sendFails = true;
    const event = eventMessage('diagnostic-event', 'wmLogEvent', { event_type: 'enter_session', welcome_code: 'fake-log-welcome' });
    fake.pages.push({ next_cursor: 'diagnostic-send', has_more: 0, msg_list: [message('diagnostic-text', 'wmLogText'), event] });
    await instance.sync();
    await instance.drain();
    verify('各接口errcode都有日志', () => {
      for (const endpoint of ['gettoken', 'kf/add_contact_way', 'kf/sync_msg', 'kf/send_msg', 'kf/send_msg_on_event'])
        assert.ok(
          warnings.slice(start).some((line) => line.includes(`interface=${endpoint} `) && /errcode=\d+ /.test(line)),
          endpoint,
        );
    });
  } finally {
    await instance.close();
  }
}

async function callbackSuite(): Promise<void> {
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  const fake = new FakeWecom();
  fake.tokenFails = true;
  const alerts: boolean[] = [];
  const instance = new SandboxWecom(env, {
    request: fake.request,
    now: () => now,
    read: async () => ({ cursor: null, fullSince: null }),
    commit: async () => {},
    notify: (failing) => {
      if (alerts.at(-1) !== failing) alerts.push(failing);
    },
  });
  let live: SandboxWecom | null = null;
  const app = sandboxApp(
    {
      wecomRoutes: () => live?.routes ?? null,
      health: async () => ({
        ...(await new SandboxProcess({}).health()),
        ok: true,
        wecom: live?.health() ?? { configured: false, full: false, bound: 0, lastSyncOkAt: null, failing: false },
      }),
      resolve: () => {
        throw new Error('回调不得读 cookie 或租户库');
      },
      provision: () => {
        throw new Error('回调不得建租户');
      },
      end: () => {
        throw new Error('回调不得删租户');
      },
    },
    env.SANDBOX_HOST,
  );
  const request = (url: string, init?: RequestInit) => app.request(url, { ...init, headers: { host: env.SANDBOX_HOST, ...init?.headers } });
  const echo = encrypt('fake-echo-明文');
  const get = `/wecom/callback?${signed(echo)}&echostr=${encodeURIComponent(echo)}`;
  try {
    check(() => assert.equal(createSandboxWecom({}, {} as Db, '1'), null));
    check(() =>
      assert.throws(() => createSandboxWecom({ ...env, SANDBOX_WECOM_TOKEN: undefined }, {} as Db, '1'), /sandbox_wecom_partial/),
    );
    check(() => assert.equal(fake.calls.length, 0));
    check(() => assert.equal(instance.health().configured, true));
    assert.equal((await request(get)).status, 404);
    checks++;
    assert.equal((await request('/wecom/callback', { method: 'POST' })).status, 404);
    checks++;
    live = instance;
    await instance.start();
    await instance.drain();
    check(() => assert.equal(instance.health().failing, true));
    check(() => assert.equal(instance.contactLink(), null));
    check(() => assert.deepEqual(alerts, []));
    const response = await request(get);
    check(() => assert.equal(response.status, 200));
    check(() => assert.equal(fake.calls.length, 1, 'GET 校验不得取 token'));
    assert.equal(await response.text(), 'fake-echo-明文');
    checks++;
    assert.equal((await request(get.replace(/msg_signature=[^&]+/, 'msg_signature=wrong'))).status, 404);
    checks++;
    const wrongCorp = encrypt('wrong-receiver', 'fake-other-corp');
    assert.equal((await request(`/wecom/callback?${signed(wrongCorp)}&echostr=${encodeURIComponent(wrongCorp)}`)).status, 404);
    checks++;
    assert.equal((await request('/wecom/callback/key')).status, 404);
    checks++;
    assert.equal((await request('/wecom/callback', { method: 'POST', body: `<xml><Encrypt>${echo}</Encrypt></xml>` })).status, 403);
    checks++;
    const postBody = encrypt(`<xml><Token>fake-sync-token</Token><OpenKfId>${env.SANDBOX_WECOM_OPEN_KFID}</OpenKfId></xml>`);
    assert.equal(
      (
        await request(`/wecom/callback?${signed(postBody)}`, {
          method: 'POST',
          body: `<xml><Encrypt><![CDATA[${postBody}]]></Encrypt></xml>`,
        })
      ).status,
      200,
    );
    checks++;
    await instance.sync();
    await instance.drain();
    for (let minute = 0; minute < 9; minute++) {
      now += 60_000;
      await instance.tick();
      await instance.drain();
    }
    check(() => assert.deepEqual(alerts, []));
    now += 60_000;
    await instance.tick();
    await instance.drain();
    check(() => assert.deepEqual(alerts, [true]));
    const health = await (await request('/healthz')).json();
    check(() => assert.equal(health.ok, true, '体验客服故障不影响进程 ok'));
    check(() => assert.equal(health.wecom.failing, true));
    fake.tokenFails = false;
    fake.contactFails = true;
    await instance.tick();
    await instance.drain();
    check(() => assert.equal(instance.contactLink(), null));
    fake.contactFails = false;
    await instance.tick();
    await instance.drain();
    check(() => assert.equal(instance.health().failing, false));
    check(() => assert.ok(instance.contactLink()));
    check(() => assert.equal(alerts.at(-1), false));
    check(() => assert.deepEqual(Object.keys(instance.health()).sort(), ['bound', 'configured', 'failing', 'full', 'lastSyncOkAt']));
    check(() => assert.ok(!JSON.stringify(instance.health()).includes('contact.example')));
    const from = fake.calls.length;
    await request(`/wecom/callback?${signed(postBody)}`, { method: 'POST', body: `<xml><Encrypt>${postBody}</Encrypt></xml>` });
    await instance.sync();
    await instance.drain();
    check(() => assert.ok(fake.calls.slice(from).some((c) => c.path === 'kf/sync_msg' && c.body.token === 'fake-sync-token')));
    const otherKfid = encrypt('<xml><Token>fake-other-token</Token><OpenKfId>fake-other-kfid</OpenKfId></xml>');
    assert.equal(
      (await request(`/wecom/callback?${signed(otherKfid)}`, { method: 'POST', body: `<xml><Encrypt>${otherKfid}</Encrypt></xml>` }))
        .status,
      403,
    );
    checks++;
    fake.sendFails = true;
    fake.pages.push({ next_cursor: 'send-failed', has_more: 0, msg_list: [message('send-fail', 'wmSendFail')] });
    await instance.sync();
    await instance.drain();
    check(() => assert.equal(instance.health().failing, true, '发送失败也进入实例故障观测'));
    fake.sendFails = false;
    fake.pages.push({ next_cursor: 'send-recovered', has_more: 0, msg_list: [message('send-ok', 'wmSendOk')] });
    await instance.sync();
    await instance.drain();
    check(() => assert.equal(instance.health().failing, false));

    instance.stop();
    const callCount = fake.calls.length;
    await instance.tick();
    await instance.drain();
    await instance.sync();
    await instance.drain();
    check(() => assert.equal(fake.calls.length, callCount));
    assert.equal((await request(get)).status, 404);
    checks++;
  } finally {
    await instance.close();
  }
}

async function eventAccountSuite(
  db: Db,
  q: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>,
): Promise<void> {
  const [template] = await q<{ id: string }>(
    "insert into tenants(slug,name,pack_id,brand) values('event-template','事件模板','travel',$1::json) returning id",
    [JSON.stringify(shanhaiBrand)],
  );
  const host = createTenantRuntime({ id: template!.id, slug: 'event-template', isHost: true });
  const deps = testConfigDeps({ db }, { tenantSlug: host.slug, usePackRuntime: true });
  const imported = await withTenantScope(host, () =>
    importConfig({ db, tenantSlug: host.slug, dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  assert.equal(imported.code, 0, imported.message);
  await q("insert into privacy_notices(tenant_id,version,body) values($1,1,'假隐私说明')", [host.id]);
  const [epoch] = await q<{ epoch: string }>('select epoch::text from sandbox_process_epoch where id=1');
  const created = await provisionSandbox({
    deps,
    templateSlug: host.slug,
    host: env.SANDBOX_HOST,
    epoch: epoch!.epoch,
    acquireTenant: async () => fakeLock(),
    ip: null,
    userAgent: null,
  });
  const rt = runtimeOf(created.tenantId)!;
  const binding = new SandboxWechatBinding(db, epoch!.epoch);
  const fake = new FakeWecom();
  fake.sendRuntime = rt;
  const instance = new SandboxWecom(env, {
    request: fake.request,
    binding,
    now: () => Date.now(),
    read: () => readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID),
    commit: (cursor) => commitSandboxWecomCursor(db, epoch!.epoch, env.SANDBOX_WECOM_OPEN_KFID, cursor),
  });
  try {
    await instance.start();
    await instance.drain();
    const { code } = await binding.issue(
      rt,
      () => instance.contactLink(),
      () => false,
    );
    const entered = eventMessage('nested-entry', 'wmNested', {
      event_type: 'enter_session',
      scene: 'try',
      scene_param: code.replace('-', ''),
      welcome_code: 'fake-nested-welcome',
    });
    entered.send_time = Date.now() / 1000;
    assert.ok(!Object.hasOwn(entered, 'open_kfid') && !Object.hasOwn(entered, 'external_userid'));
    const foreign = eventMessage('foreign-entry', 'wmForeign', {
      ...entered.event,
      open_kfid: 'fake-other-kf',
      external_userid: 'wmForeign',
      welcome_code: 'fake-foreign-welcome',
    });
    foreign.send_time = entered.send_time;
    fake.pages.push({ next_cursor: 'foreign-event-page', has_more: 0, msg_list: [foreign] });
    await instance.sync();
    await instance.drain();
    verify('event.open_kfid 为其他账号的 enter_session 被跳过且无发送', () => {
      assert.equal(fake.sends().length, 0);
      assert.equal(sandboxWechatIndex.forUser('wmForeign'), undefined);
      assert.equal(sandboxWechatIndex.boundUser(rt), undefined);
    });
    fake.pages.push({ next_cursor: 'nested-event-page', has_more: 0, msg_list: [entered] });
    await instance.sync();
    await instance.drain();
    const rows = await q<{ external_userid: string }>('select external_userid from sandbox_wechat where tenant_id=$1', [rt.id]);
    verify('仅 event.open_kfid 的 enter_session 绑定有效码并经 send_msg_on_event 欢迎', () => {
      assert.equal(rows[0]!.external_userid, 'wmNested');
      assert.equal(sandboxWechatIndex.forUser('wmNested'), rt);
      assert.equal(fake.sends().length, 1);
      assert.equal(fake.sends()[0]!.path, 'kf/send_msg_on_event');
      assert.equal(fake.sends()[0]!.body.code, 'fake-nested-welcome');
      assert.match((fake.sends()[0]!.body.text as { content: string }).content, /AI/);
    });
  } finally {
    await instance.close();
    await withTenantScope(rt, () => drainStore(5000));
    rt.state = 'closed';
    rt.store.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropShutdownHooks(rt);
    dropTenantState(rt.id);
    unregisterRuntime(rt.id);
    sandboxWechatIndex.reset();
  }
}

async function runtimeSuite(db: Db, q: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>): Promise<void> {
  const tables = await q<{ name: string }>(
    "select table_name as name from information_schema.columns where table_schema='public' and column_name='tenant_id' order by table_name",
  );
  const snapshot = async () => {
    const counts = [];
    for (const t of tables) counts.push((await q(`select count(*)::int as n from "${t.name}"`))[0]);
    return counts;
  };
  const before = await snapshot();
  const [epoch] = await q<{ epoch: string }>('select epoch::text from sandbox_process_epoch where id=1');
  const fake = new FakeWecom();
  const committed: string[] = [];
  fake.onSend = async () => {
    const state = await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID);
    check(() => assert.equal(state.cursor, committed.at(-1), '每次发送前游标已经提交'));
  };
  let commitFails = false;
  const instance = new SandboxWecom(env, {
    request: fake.request,
    now: () => now,
    read: () => readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID),
    commit: async (cursor) => {
      if (commitFails) throw new Error('fake-commit-failure');
      await commitSandboxWecomCursor(db, epoch!.epoch, env.SANDBOX_WECOM_OPEN_KFID, cursor);
      committed.push(cursor);
    },
  });
  try {
    fake.pages.push({
      next_cursor: 'cold-page',
      has_more: 0,
      msg_list: [message('old', 'wmOld', now / 1000 - 601), message('recent'), message('recent2'), message('recent3')],
    });
    await instance.start();
    await instance.drain();
    check(() => assert.equal(committed[0], 'cold-page'));
    check(() => assert.equal(fake.sends().length, 1));
    check(() => assert.equal(fake.sends()[0]!.body.touser, 'wmUnbound'));
    check(() =>
      assert.deepEqual(fake.sends()[0]!.body.text, {
        content: `这是体验客服，去 https://${env.SANDBOX_HOST}/try 开一个体验，扫页面上的码就能连上`,
      }),
    );
    check(() => assert.equal(instance.health().lastSyncOkAt, new Date(now).toISOString()));
    const state = await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID);
    check(() => assert.equal(state.cursor, 'cold-page'));
    commitFails = true;
    fake.pages.push({ next_cursor: 'failed-page', has_more: 0, msg_list: [message('lost', 'wmLost')] });
    await instance.sync('fake-callback-token');
    await instance.drain();
    check(() => assert.equal(fake.sends().length, 1, 'cursor 提交失败不派发'));
    check(() => assert.equal(instance.health().failing, true));
    check(() => assert.equal(committed.at(-1), 'cold-page'));
    commitFails = false;
    fake.pages.push(
      { next_cursor: 'page-one', has_more: 1, msg_list: [message('a', 'wmPageOne')] },
      { next_cursor: 'page-two', has_more: 0, msg_list: [message('b', 'wmPageTwo')] },
    );
    await instance.sync('fake-next-token');
    await instance.drain();
    check(() => assert.deepEqual(committed.slice(-2), ['page-one', 'page-two']));
    const pulls = fake.calls.filter((c) => c.path === 'kf/sync_msg');
    check(() => assert.equal(pulls.at(-1)!.body.cursor, 'page-one'));
    check(() => assert.equal(pulls.at(-1)!.body.token, 'fake-next-token'));
    check(() => assert.equal(instance.health().failing, false));
    // 一个微信 10 分钟，整进程滑动一小时 200 条。
    now += 10 * 60_000;
    fake.pages.push({
      next_cursor: 'rate-page',
      has_more: 0,
      msg_list: [message('again'), ...Array.from({ length: 201 }, (_, i) => message(`rate-${i}`, `wmRate${i}`))],
    });
    await instance.sync();
    await instance.drain();
    check(() => assert.equal(fake.sends().length, 200));
    now += 60 * 60_000;
    const entered = eventMessage('entry', 'wmEnter', { event_type: 'enter_session', welcome_code: 'fake-welcome' });
    const receipt = eventMessage('receipt', 'wmReceipt', { event_type: 'msg_send_fail' });
    fake.pages.push({ next_cursor: 'event-page', has_more: 0, msg_list: [entered, receipt] });
    fake.expireOnce = true;
    await instance.sync();
    await instance.drain();
    check(() =>
      assert.deepEqual(fake.sends().at(-1)!.body, {
        code: 'fake-welcome',
        msgtype: 'text',
        text: { content: `这是体验客服，去 https://${env.SANDBOX_HOST}/try 开一个体验，扫页面上的码就能连上` },
      }),
    );
    check(() => assert.equal(fake.calls.filter((c) => c.path === 'gettoken').length, 2));
    check(() => assert.ok(fake.calls.every((c) => c.path !== 'kf/customer/batchget')));
    assert.deepEqual(await snapshot(), before);
    checks++;
    await assert.rejects(() => commitSandboxWecomCursor(db, String(BigInt(epoch!.epoch) + 1n), env.SANDBOX_WECOM_OPEN_KFID, 'stale'));
    checks++;
    assert.equal((await readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID)).cursor, 'event-page');
    checks++;
  } finally {
    await instance.close();
  }
  // 已提交但处理期间停机的页面不重放；重启从持久化 cursor 继续，旧 cursor 不应用冷启动截止。
  const restartedFake = new FakeWecom();
  restartedFake.pages.push({
    next_cursor: 'restart-page',
    has_more: 0,
    msg_list: [message('restart-old', 'wmRestart', now / 1000 - 10000)],
  });
  const restarted = new SandboxWecom(env, {
    request: restartedFake.request,
    now: () => now,
    read: () => readSandboxWecomState(db, env.SANDBOX_WECOM_OPEN_KFID),
    commit: (cursor) => commitSandboxWecomCursor(db, epoch!.epoch, env.SANDBOX_WECOM_OPEN_KFID, cursor),
  });
  try {
    await restarted.start();
    await restarted.drain();
    check(() => assert.equal(restartedFake.calls.find((c) => c.path === 'kf/sync_msg')!.body.cursor, 'event-page'));
    check(() => assert.equal(restartedFake.sends().length, 1));
  } finally {
    await restarted.close();
  }
}

async function serialSuite(): Promise<void> {
  const fake = new FakeWecom();
  const notifications: boolean[] = [];
  const instance = new SandboxWecom(env, {
    request: fake.request,
    notify: (failing) => {
      notifications.push(failing);
    },
    now: () => now,
    read: async () => ({ cursor: 'saved', fullSince: null }),
    commit: async () => {},
  });
  try {
    await instance.start();
    await instance.drain();
    fake.syncFails = true;
    for (let minute = 0; minute < 10; minute++) {
      await instance.sync();
      await instance.drain();
      now += 60_000;
    }
    fake.syncFails = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0,
      max = 0;
    fake.beforeSync = async () => {
      active++;
      max = Math.max(max, active);
      entered();
      await gate;
      active--;
    };
    const first = instance.sync('first-token');
    await waiting;
    const second = instance.sync('second-token');
    const polling = instance.tick();
    check(() => assert.ok(notifications.includes(true), '连续失败的告警不能等待在途拉取结束'));
    release();
    await Promise.all([first, second, polling]);
    check(() => assert.equal(max, 1));
    check(() => assert.ok(fake.calls.some((c) => c.body.token === 'second-token')));
  } finally {
    await instance.close();
  }
}

async function stopSuite(): Promise<void> {
  const fake = new FakeWecom();
  let release!: () => void;
  let committing!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    committing = resolve;
  });
  let cursor = 'saved';
  const instance = new SandboxWecom(env, {
    request: fake.request,
    now: () => now,
    read: async () => ({ cursor, fullSince: null }),
    commit: async (next) => {
      committing();
      await gate;
      cursor = next;
    },
  });
  fake.pages.push({ next_cursor: 'claimed-before-stop', has_more: 0, msg_list: [message('dropped', 'wmStopped')] });
  const start = instance.start();
  await entered;
  instance.stop();
  release();
  await start;
  await instance.close();
  check(() => assert.equal(cursor, 'claimed-before-stop'));
  check(() => assert.equal(fake.sends().length, 0, '提交中停止后不派发，已认领页面不补发'));
  check(() => assert.equal(instance.contactLink(), null));
}

async function processSuite(url: string): Promise<void> {
  const fake = new FakeWecom();
  fake.tokenFails = true;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fake.request;
  const process = new SandboxProcess(
    {
      ...env,
      APP_ROLE: 'sandbox',
      DEPLOY_PROFILE: 'demo',
      CONFIG_SOURCE: 'db',
      SESSION_STORE: 'db',
      SANDBOX_TEMPLATE_SLUG: 'demo',
      DATABASE_URL: url,
    },
    () => {
      throw new Error('假企微失败不得退出进程');
    },
  );
  const app = sandboxApp(process, env.SANDBOX_HOST);
  try {
    await process.start();
    await flushMicrotasks();
    const health = await process.health();
    check(() => assert.equal(health.ok, true, '真实 PG 下凭据未生效仍然正常启动'));
    check(() => assert.equal(health.wecom.configured, true));
    check(() => assert.equal(health.wecom.failing, true));
    const echo = encrypt('boot-echo');
    const response = await app.request(`/wecom/callback?${signed(echo)}&echostr=${encodeURIComponent(echo)}`, {
      headers: { host: env.SANDBOX_HOST },
    });
    check(() => assert.equal(response.status, 200));
    assert.equal(await response.text(), 'boot-echo');
    checks++;
  } finally {
    await process.close();
    globalThis.fetch = savedFetch;
  }
}

async function alertSuite(db: Db, epoch: string): Promise<void> {
  const fake = new FakeWecom();
  fake.tokenFails = true;
  const notices: string[] = [];
  const savedFetch = globalThis.fetch;
  const savedClock = Date.now;
  const savedWebhook = process.env.ALERT_WEBHOOK_URL;
  const webhook = 'https://alert.example.invalid/fake-only';
  process.env.ALERT_WEBHOOK_URL = webhook;
  Date.now = () => now;
  __alertTest.reset();
  __alertTest.setClock(() => now);
  globalThis.fetch = async (url, init) => {
    if (String(url) === webhook) {
      notices.push(JSON.parse(String(init?.body)).text.content);
      return Response.json({ errcode: 0 });
    }
    return fake.request(url, init);
  };
  const instance = createSandboxWecom(env, db, epoch)!;
  try {
    await instance.start();
    await instance.drain();
    for (let minute = 0; minute < 10; minute++) {
      now += 60_000;
      await instance.tick();
      await instance.drain();
    }
    await instance.tick();
    await instance.drain();
    await __alertTest.settle();
    await instance.tick();
    await instance.drain();
    await __alertTest.settle();
    check(() => assert.equal(notices.length, 1, 'channel 实例告警按既有规则去重'));
    check(() => assert.match(notices[0]!, /企微账号 sandbox 连续 10 分钟/));
    check(() => assert.ok(!notices[0]!.includes(env.SANDBOX_WECOM_CORP_ID)));
    check(() => assert.match(notices[0]!, /interface=gettoken errcode=48007/));
    for (let minute = 0; minute < 31; minute++) {
      now += 60_000;
      await instance.tick();
      await instance.drain();
    }
    await __alertTest.settle();
    verify('同一连续失败跨30分钟只告警一次', () => assert.equal(notices.length, 1));
    fake.tokenFails = false;
    await instance.tick();
    await instance.drain();
    await __alertTest.settle();
    check(() => assert.equal(notices.length, 2));
    check(() => assert.match(notices[1]!, /已恢复/));
    fake.syncFails = true;
    for (let minute = 0; minute <= 10; minute++) {
      if (minute) now += 60_000;
      await instance.tick();
      await instance.drain();
    }
    await __alertTest.settle();
    verify('恢复后新的连续失败再次告警', () => {
      assert.equal(notices.length, 3);
      assert.match(notices[2]!, /interface=kf\/sync_msg errcode=48007/);
    });
  } finally {
    await instance.close();
    await __alertTest.settle();
    __alertTest.reset();
    __alertTest.setClock(null);
    Date.now = savedClock;
    globalThis.fetch = savedFetch;
    if (savedWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = savedWebhook;
  }
}

// 宿主侧的额外回归：体验客服生命周期不会装进 env/03 运行时，也不动 env cursor / 在途 / 恢复。
async function hostSuite(): Promise<void> {
  configureTenancy({ role: 'host', standardCount: 1 });
  const saved = { ...process.env };
  process.env.WECOM_CORP_ID = 'fake-host-corp';
  process.env.WECOM_APP_SECRET = 'fake-host-secret'; // gitleaks:allow
  process.env.WECOM_KF_OPEN_KFID = 'fake-host-kfid';
  try {
    const before = withTenantScope(hostRuntime(), () => ({ ids: __wecomTest.ids(), env: __test.inspectForTest() }));
    const fake = new FakeWecom();
    const instance = new SandboxWecom(env, {
      request: fake.request,
      now: () => now,
      read: async () => ({ cursor: null, fullSince: null }),
      commit: async () => {},
    });
    try {
      await withTenantScope(hostRuntime(), () => withoutTenantScope(() => instance.start()));
    } finally {
      await instance.close();
    }
    withTenantScope(hostRuntime(), () => {
      check(() => assert.equal(isWecomEnabled(), true));
      check(() => assert.deepEqual(__wecomTest.ids(), before.ids));
      check(() => assert.deepEqual(__test.inspectForTest(), before.env));
      check(() => assert.equal(__wecomTest.routeAccount('wecom:wmHost'), ENV_ACCOUNT_ID));
      check(() => assert.equal(__wecomTest.inspect(ENV_ACCOUNT_ID)?.backend, 'file'));
      check(() => assert.equal(__wecomTest.inspect(ENV_ACCOUNT_ID)?.recovery, 'done'));
    });
  } finally {
    process.env = saved;
  }
}

await reviewSuite();
await diagnosticSuite();
await stoppedObservationSuite();
await callbackSuite();
await serialSuite();
await stopSuite();
const t = await openTestDb();
try {
  await t.pg.exec('SET ROLE agent_app');
  await runtimeSuite(t.db, async <T>(text: string, params: unknown[] = []) => {
    await t.pg.exec('RESET ROLE');
    try {
      return (await t.pg.query<T>(text, params)).rows;
    } finally {
      await t.pg.exec('SET ROLE agent_app');
    }
  });
  await eventAccountSuite(t.db, async <T>(text: string, params: unknown[] = []) => {
    await t.pg.exec('RESET ROLE');
    try {
      return (await t.pg.query<T>(text, params)).rows;
    } finally {
      await t.pg.exec('SET ROLE agent_app');
    }
  });
  await alertSuite(t.db, '0');
} finally {
  await t.close();
}
if (process.env.PG_TEST_URL) {
  const fixture = await createRealPgFixture(process.env.PG_TEST_URL);
  const app = await openDb(fixture.urls.app);
  try {
    await processSuite(fixture.urls.app);
    await runtimeSuite(app.db, fixture.query);
    await eventAccountSuite(app.db, fixture.query);
  } finally {
    await app.close();
    await fixture.drop();
  }
} else console.log('SKIP: 真实 PG 实例 cursor 验收需要 PG_TEST_URL');
await hostSuite();
check(() => assert.equal(forbiddenRequests, 0, '未绑定路径没有模型或真实网络请求'));
verify('日志仅有接口名错误码计数', () => {
  // 只核体验客服自己的诊断行：其他模块在 CI 时序下偶发的 warn 也会被收进来（PR #204 曾因此偶发失败）
  const own = warnings.filter((line) => line.startsWith('[sandbox-wecom]'));
  const events = ['binding_recovery_pending', 'duplicate_binding_older_ignored', 'sandbox_send_refused'];
  const bad = own.filter(
    (line) =>
      !/^\[sandbox-wecom\] interface=[a-z_/]+ errcode=[\w.-]+ count=\d+$/.test(line) &&
      !events.some((e) => line === `[sandbox-wecom] ${e}`),
  );
  assert.ok(own.length);
  assert.deepEqual(bad, []);
  for (const secret of [
    env.SANDBOX_WECOM_CORP_ID,
    env.SANDBOX_WECOM_SECRET,
    env.SANDBOX_WECOM_TOKEN,
    env.SANDBOX_WECOM_AES_KEY,
    env.SANDBOX_WECOM_OPEN_KFID,
    'fake-access',
    'contact.example.invalid',
    'wmRetry',
    '假客户文字',
  ])
    assert.ok(!warnings.join('\n').includes(secret));
});
verify('各接口errcode均有诊断', () => {
  for (const endpoint of ['gettoken', 'kf/add_contact_way', 'kf/sync_msg', 'kf/send_msg', 'callback'])
    assert.ok(
      warnings.some((line) => line.includes(`interface=${endpoint} `)),
      endpoint,
    );
});
console.warn = originalWarn;
globalThis.fetch = originalFetch;
console.log(`SELFTEST PASS: 体验客服运行时与收件 ${checks} 项`);
