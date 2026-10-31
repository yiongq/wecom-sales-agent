// 14 R6：真实企微适配器、入出站账本与 limits；仅企微传输和附件识别用合成替身。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KfMessage } from './wecom-state.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-limits-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  PACK_FIXTURES: '1',
  LLM_MOCK: '1',
  SOP_PATH: 'data/packs/__fixture/sop.md',
  SERVER_SELFTEST: '1',
  CUSTOMER_RATE_PER_MIN: '',
  CUSTOMER_RATE_PER_HOUR: '',
  FOLLOWUP_ENABLED: '1',
  FOLLOWUP_QUIET_START: '0',
  FOLLOWUP_QUIET_END: '0',
});
const tenancy = await import('../tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
const rt = tenancy.createTenantRuntime({ id: 'limits-adapter', slug: 'limits-adapter' });
enterTenantScopeForTest(rt);
const testing = await import('../db/testing.js');
const store = await import('../store.js');
const config = await import('../config/source.js');
const limits = await import('../tenancy/limits.js');
const { LIMIT_SUSPENDED_REPLY, LIMIT_QUOTA_REPLY } = await import('../tenancy/limit-replies.js');
const { bindPack } = await import('../core/pack-api.js');
const { createFixtureRuntime } = await import('../packs/__fixture/runtime.js');
const { withFixtureIntake } = await import('../packs/__fixture/intake.js');
const { sealSecrets } = await import('../channels/secrets.js');
const channels = await import('../channels/registry.js');
const wecom = await import('./wecom.js');
const { __ledgerTest } = await import('../quota/ledger.js');
const { openDb } = await import('../db/client.js');
const { importConfig } = await import('../config/transfer.js');
const { __jobsTest, runJobsOnce } = await import('../jobs/runner.js');
const fx = process.env.PG_TEST_URL ? await testing.createRealPgFixture(process.env.PG_TEST_URL, { slug: rt.slug }) : null;
const app = fx ? await openDb(fx.urls.app) : null;
const t = app ? null : await testing.openTestDb();
const db = app?.db ?? t!.db;
if (t) await testing.installSeededConfig(t, { slug: rt.slug });
else {
  const deps = testing.testConfigDeps({ db }, { tenantSlug: rt.slug });
  const result = await importConfig({
    db,
    tenantSlug: rt.slug,
    dataDir: 'data',
    imageSop: deps.imageSop,
    lock: async () => testing.fakeLock(),
  });
  assert.equal(result.code, 0, result.message);
  await config.initConfig(deps);
}
const tenantId = rt.id;
await store.initSessionStore({ db, tenantId, tenantSlug: rt.slug, varDir: dir });
const query = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  fx
    ? fx.query<T>(sql, params)
    : t!.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<T>(sql, params)).rows;
      });
const account = randomUUID();
const key = Buffer.alloc(32, 9);
const ring = { current: { id: 'fixture', key }, all: new Map([['fixture', key]]) };
const sealed = sealSecrets(
  ring,
  { tenantId, accountId: account },
  {
    appSecret: 'fixture-app',
    callbackToken: 'fixture-callback',
    callbackAesKey: 'fixture-aes',
  },
);
await query(
  `insert into channel_accounts (tenant_id,id,key,name,kind,status,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id,cursor)
  values ($1,$2,'main','停用测试','wecom_kf','active','wecom:','fixture-corp','limits-kf',decode($3,'hex'),$4,'started')`,
  [tenantId, account, sealed.ct.toString('hex'), sealed.keyId],
);
const originalFetch = globalThis.fetch;
const sent: { touser?: string; code?: string; msgid?: string; text: { content: string } }[] = [];
let incoming: KfMessage[] = [];
let serial = 0;
let receives = 0;
let mediaGate: Promise<void> | null = null;
let mediaEntered = false;
let mediaFailure = false;
let followupRetry = false;
let eventRetry = false;
let tokenGate: Promise<void> | null = null;
let tokenEntered = false;
let tokenExpiresIn = 7200;
let sendGate: Promise<void> | null = null;
let sendEntered = false;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 15_000;
  while (!predicate() && Date.now() < end) await sleep(10);
  assert.ok(predicate(), '异步处理必须到达指定边界');
};
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/gettoken')) {
    tokenEntered = true;
    await tokenGate;
    return Response.json({ access_token: 'fixture-token', expires_in: tokenExpiresIn });
  }
  if (url.includes('/media/get')) {
    mediaEntered = true;
    await mediaGate;
    if (mediaFailure) return Response.json({ errcode: 40007 });
    return new Response(Buffer.from('ffd8ffe10008457869664750ffda000273ffd9', 'hex'), { headers: { 'content-type': 'image/jpeg' } });
  }
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (url.includes('/kf/sync_msg')) {
    const page = incoming;
    incoming = [];
    return Response.json({ next_cursor: `c-${++serial}`, has_more: 0, msg_list: page });
  }
  if (url.includes('/kf/send_msg_on_event') || url.includes('/kf/send_msg?')) {
    sent.push(body);
    if (followupRetry && body.touser) {
      followupRetry = false;
      return Response.json({ errcode: 40014 });
    }
    if (eventRetry && body.code) {
      eventRetry = false;
      return Response.json({ errcode: 40014 });
    }
    sendEntered = true;
    await sendGate;
    return Response.json({ errcode: 0, msgid: body.msgid });
  }
  if (url.includes('/kf/customer/batchget')) return Response.json({ customer_list: [] });
  throw new Error('未预期的网络请求');
};
const runtime = withFixtureIntake(createFixtureRuntime(config.packSources()), async (ctx, kit) => {
  receives++;
  kit.saveResult({ checked: true }, 'int_123456789abc');
  return ctx.moreQueued ? null : { text: '附件已核验。', fixedId: 'fixture.intake' };
});
bindPack(runtime, runtime.defaultBrand);
const idle = async () => {
  await waitFor(() => wecom.__wecomTest.idle());
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
};
const initChannels = async () => {
  await channels.initChannels({ db, tenantId, tenantSlug: rt.slug, varDir: dir, keyRing: ring });
  channels.startChannels();
};
const status = async (suspended: boolean) => {
  await query('update tenants set status=$2 where id=$1', [tenantId, suspended ? 'suspended' : 'active']);
  await limits.initializeTenantLimits();
  assert.equal(limits.limitVerdict(), suspended ? 'suspended' : 'ok');
};
const msg = (uid: string, type: string): KfMessage => ({
  msgid: `lim-${++serial}`,
  open_kfid: 'limits-kf',
  external_userid: uid,
  send_time: Math.floor(Date.now() / 1000),
  origin: 3,
  msgtype: type,
  ...(type === 'text' ? { text: { content: '你好' } } : {}),
  ...(type === 'image' ? { image: { media_id: 'fixture-image' } } : {}),
});
const event = (uid: string, code?: string): KfMessage => ({
  ...msg(uid, 'event'),
  event: { event_type: 'enter_session', external_userid: uid, ...(code ? { welcome_code: code } : {}) },
});
const pull = async (messages: KfMessage[]) => {
  incoming = messages;
  await wecom.syncAccountFromCallback(account, 'fixture-sync');
};
const send = async (messages: KfMessage[]) => {
  await pull(messages);
  await idle();
};
const sentTo = (uid: string) => sent.filter((m) => m.touser === uid).map((m) => m.text.content);
const stateOf = async (m: KfMessage) =>
  (await query<{ state: string }>('select state from channel_inbox where msgid=$1', [m.msgid]))[0]?.state;
try {
  await initChannels();
  await idle();
  await status(true);
  const before = sent.length;
  await send([event('wmLimNew', 'fixture-welcome'), event('wmLimBack')]);
  assert.equal(sent.length, before);
  assert.equal(store.getSession('wecom:wmLimNew'), undefined);
  const nontext = ['voice', 'location', 'link'].map((type) => msg('wmLimHint', type));
  await send(nontext);
  for (const m of nontext) assert.equal(await stateOf(m), 'done');
  const hintSession = store.getSession('wecom:wmLimHint')!;
  assert.equal(hintSession.messages.filter((m) => m.role === 'customer').length, nontext.length);
  assert.equal(hintSession.suspendedReplyAt, undefined);
  assert.deepEqual(sentTo('wmLimHint'), []);
  await send([msg('wmLimHint', 'text'), msg('wmLimHint', 'text')]);
  assert.deepEqual(sentTo('wmLimHint'), [LIMIT_SUSPENDED_REPLY]);
  console.log('14 验收 7 适配器：停用时两种欢迎语均不发；非文本照记且直接静默，不占固定句次数');

  // 活跃对照 + welcome_code 首次失败后，强刷 token 期间停用也不能重试欢迎。
  await status(false);
  await send([event('wmLimActive')]);
  assert.equal(sentTo('wmLimActive').length, 1);
  let releaseToken!: () => void;
  tokenGate = new Promise<void>((resolve) => {
    releaseToken = resolve;
  });
  tokenEntered = false;
  eventRetry = true;
  await pull([event('wmLimRace', 'fixture-race')]);
  await waitFor(() => tokenEntered);
  await status(true);
  const attempted = sent.length;
  releaseToken();
  tokenGate = null;
  await idle();
  assert.equal(sent.length, attempted, '停用后不重试 welcome_code 请求');

  // 两张图片让生产批处理在下载前武装等待提示；下载阻塞期间检查计时器。
  for (const armed of [false, true]) {
    await status(!armed);
    const uid = armed ? 'wmLimArmed' : 'wmLimNoArm';
    let releaseMedia!: () => void;
    mediaGate = new Promise<void>((resolve) => {
      releaseMedia = resolve;
    });
    mediaEntered = false;
    await pull([msg(uid, 'image'), msg(uid, 'image')]);
    await waitFor(() => mediaEntered);
    assert.equal(wecom.__wecomTest.inspect(account)!.attachmentWaitTimers, armed ? 1 : 0);
    if (armed) {
      await status(true);
      await sleep(5200);
    }
    assert.deepEqual(sentTo(uid), []);
    releaseMedia();
    mediaGate = null;
    await idle();
    assert.deepEqual(sentTo(uid), [LIMIT_SUSPENDED_REPLY]);
  }
  console.log('14 验收 7 适配器：停用不武装附件等待计时器，已武装到点也不外发；token 等待后的欢迎重试受闸');

  // replied + pending 是停用前已经持久化的回复，只补发，不重新识别/生成/计数。
  await status(false);
  const deferred = msg('wmLimOld', 'image');
  __ledgerTest.setPlanHook((intents) => {
    if (intents.some((i) => i.sessionId === 'wecom:wmLimOld')) wecom.__wecomTest.closeSends(account, Date.now());
  });
  await send([deferred]);
  __ledgerTest.setPlanHook(null);
  assert.equal(await stateOf(deferred), 'replied');
  assert.deepEqual(sentTo('wmLimOld'), []);
  assert.equal(store.getSession('wecom:wmLimOld')!.messages.at(-1)!.content, '附件已核验。');
  await status(true);
  const used = limits.getTenantLimits()!.monthlyUsed;
  const beforeReceive = receives;
  channels.__channelsTest.reset();
  await initChannels();
  await idle();
  assert.deepEqual(sentTo('wmLimOld'), ['附件已核验。']);
  assert.equal(await stateOf(deferred), 'done');
  assert.equal(receives, beforeReceive);
  assert.equal(limits.getTenantLimits()!.monthlyUsed, used);

  // recorded 中已有回复只补发；没有回复则走停用闸门，不调用附件识别。
  for (const savedReply of [true, false]) {
    const uid = savedReply ? 'wmLimRecord' : 'wmLimEmpty';
    const m = msg(uid, 'text');
    const s = store.getOrCreateSession(`wecom:${uid}`, 'wecom');
    s.messages.push({ role: 'customer', content: '你好', at: Date.now(), msgid: m.msgid, sentAt: m.send_time * 1000 });
    if (savedReply) s.messages.push({ role: 'agent', content: '此前已生成的回复。', at: Date.now() });
    store.saveSession(s);
    await store.flushSession(s.id);
    await query(
      `insert into channel_inbox (tenant_id,account_id,msgid,kind,conversation_id,sent_at,state,payload)
      values ($1,$2,$3,'message',$4,now(),'recorded',$5::json)`,
      [tenantId, account, m.msgid, s.id, JSON.stringify(m)],
    );
    const beforeUsed = limits.getTenantLimits()!.monthlyUsed;
    await wecom.__wecomTest.dispatchOpen(account);
    await idle();
    assert.deepEqual(sentTo(uid), [savedReply ? '此前已生成的回复。' : LIMIT_SUSPENDED_REPLY]);
    assert.equal(limits.getTenantLimits()!.monthlyUsed, beforeUsed);
    assert.equal(await stateOf(m), 'done');
  }
  console.log('14 验收 7 适配器：真实启动恢复补发旧 pending/replied；recorded 已有回复复用，无回复执行停用闸门，均不重复计数');

  // HTTP 已发出的在途回复无法撤回，结束后不再生成回复；下一条客户消息只发一次停用固定句。
  await status(false);
  let releaseSend!: () => void;
  sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  sendEntered = false;
  await pull([msg('wmLimFlight', 'image')]);
  await waitFor(() => sendEntered);
  assert.equal(store.getSession('wecom:wmLimFlight')!.messages.at(-1)!.content, '附件已核验。');
  await status(true);
  const inFlightUsed = limits.getTenantLimits()!.monthlyUsed;
  releaseSend();
  sendGate = null;
  await idle();
  assert.equal(limits.getTenantLimits()!.monthlyUsed, inFlightUsed);
  await send([msg('wmLimFlight', 'text'), msg('wmLimFlight', 'text')]);
  assert.deepEqual(sentTo('wmLimFlight'), ['附件已核验。', LIMIT_SUSPENDED_REPLY]);
  console.log('14 验收 7 适配器：停用瞬间已入库且请求已发出的在途回复只完成原请求，下一轮仍至多一次固定句');
  // 非文本和下载失败都经过同一个客户窗口及额度转人工路径。
  await status(true);
  mediaFailure = true;
  const pausedFailure = msg('wmLimFailS', 'image');
  await send([pausedFailure]);
  assert.equal(await stateOf(pausedFailure), 'done');
  assert.deepEqual(sentTo('wmLimFailS'), []);
  assert.equal(store.getSession('wecom:wmLimFailS')!.suspendedReplyAt, undefined);
  await status(false);
  await send([msg('wmLimFailOk', 'image')]);
  assert.equal(sentTo('wmLimFailOk').length, 1, '未停用时保留附件失败原句');
  await query('update tenants set monthly_reply_quota=0 where id=$1', [tenantId]);
  await limits.initializeTenantLimits();
  for (const [uid, type] of [
    ['wmLimQuotaN', 'voice'],
    ['wmLimQuotaF', 'image'],
  ]) {
    const incoming = msg(uid!, type!);
    await send([incoming]);
    await send([msg(uid!, type!)]);
    assert.equal(await stateOf(incoming), 'done');
    assert.deepEqual(sentTo(uid!), [LIMIT_QUOTA_REPLY]);
    assert.equal(store.getSession(`wecom:${uid}`)!.handoff?.reason, '本月 AI 额度已用完');
    assert.equal(
      (
        await query(
          "select * from jobs where tenant_id=$1 and kind='handoff_notify' and payload->>'sessionId'=$2 and payload->>'reason'='started'",
          [tenantId, `wecom:${uid}`],
        )
      ).length,
      1,
    );
  }
  console.log('14 验收 2、7 适配器：非文本/附件失败先记消息；停用静默，额度共用 failure 转人工与固定句/通知且不重复');
  await query('update tenants set monthly_reply_quota=null where id=$1', [tenantId]);
  await limits.initializeTenantLimits();
  process.env.CUSTOMER_RATE_PER_MIN = '1';
  for (const [uid, first, second] of [
    ['wmLimRateNF', 'voice', 'image'],
    ['wmLimRateFN', 'image', 'voice'],
  ]) {
    await send([msg(uid!, first!)]);
    const count = sentTo(uid!).length;
    const limited = msg(uid!, second!);
    await send([limited]);
    assert.equal(sentTo(uid!).length, count, '非文本和附件失败共用 customerRate，超限直接静默');
    assert.equal(await stateOf(limited), 'done');
    assert.equal(store.getSession(`wecom:${uid}`)!.messages.filter((m) => m.role === 'customer').length, 2);
  }
  process.env.CUSTOMER_RATE_PER_MIN = '';
  mediaFailure = false;
  console.log('14 验收 6 适配器：非文本与附件失败双向共用限速，超限静默且消息照记');

  // 真实任务 → prepare/发送账本 → token 等待/刷新：暂停或耗尽后不发，也不重新排任务。
  const followRuntime = { ...runtime, followupTemplates: { ...runtime.followupTemplates, idleMinutes: { objection: 1 } } };
  bindPack(followRuntime, followRuntime.defaultBrand);
  __jobsTest.reset();
  __jobsTest.start((id, text, opts) => wecom.wecomAdapter.push(id, text, opts));
  for (const mode of ['suspended', 'quota'] as const) {
    for (const retry of [false, true]) {
      await query("update tenants set status='active', monthly_reply_quota=null where id=$1", [tenantId]);
      await limits.initializeTenantLimits();
      const uid = `wmFol${mode === 'quota' ? 'Q' : 'S'}${retry ? 'R' : 'T'}`;
      await send([msg(uid, 'image')]); // 客户窗口和 account_id 均由生产入站建立。
      const s = store.getSession(`wecom:${uid}`)!;
      s.stage = 'objection';
      s.updatedAt = Date.now() - 180_000;
      store.saveSession(s, false);
      await store.flushSession(s.id);
      // 重新装载账号使首次发送需要 token；重试场景先取得 token 再强刷。
      channels.__channelsTest.reset();
      await initChannels();
      await idle();
      if (retry) await send([event(`wmWarm${mode === 'quota' ? 'Q' : 'S'}`)]);
      else {
        // 传输替身给过期 token，下一次发送必须走生产 gettoken 等待；不修改运行时缓存。
        tokenExpiresIn = 300;
        eventRetry = true;
        await send([event(`wmCold${mode === 'quota' ? 'Q' : 'S'}`, 'fixture-expired')]);
        tokenExpiresIn = 7200;
      }
      let release!: () => void;
      tokenGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tokenEntered = false;
      followupRetry = retry;
      const before = sentTo(uid).length;
      const task = runJobsOnce();
      await waitFor(() => tokenEntered);
      await query('update tenants set status=$2, monthly_reply_quota=$3 where id=$1', [
        tenantId,
        mode === 'suspended' ? 'suspended' : 'active',
        mode === 'quota' ? 0 : null,
      ]);
      await limits.initializeTenantLimits();
      const attempted = sentTo(uid).length;
      assert.equal(attempted - before, retry ? 1 : 0);
      release();
      tokenGate = null;
      await task;
      await idle();
      assert.equal(sentTo(uid).length, attempted, '限制生效后没有新的实际请求/重试');
      const jobs = await query<{ status: string; last_error: string | null }>(
        "select status,last_error from jobs where tenant_id=$1 and kind='followup' and payload->>'sessionId'=$2",
        [tenantId, s.id],
      );
      assert.deepEqual(jobs, [{ status: 'abandoned', last_error: 'tenant_limit' }], '跳过结束，没有重新排任务');
      assert.equal(
        s.messages.some((m) => m.author === 'followup'),
        false,
      );
      await runJobsOnce();
      assert.equal(sentTo(uid).length, attempted);
      console.log(`14 验收 7 真实跟进：${mode} 在${retry ? '重试刷新' : '首次'} token 等待期间生效，无后续外发、无重排`);
    }
  }
  await __jobsTest.stop();
  console.log('WECOM LIMITS SELFTEST PASS');
} finally {
  __ledgerTest.setPlanHook(null);
  await __jobsTest.stop();
  wecom.stopWecomAccounts();
  channels.__channelsTest.stopStatsRefresh();
  limits.stopTenantLimits();
  await store.drainStore(5000);
  await rt.store.pgBackend?.close();
  await config.closeConfig();
  await app?.close();
  await fx?.drop();
  await t?.close();
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
