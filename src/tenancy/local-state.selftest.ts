import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-state-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  TENANCY_STRICT: '1',
  LLM_MOCK: '0',
  LLM_BASE_URL: 'http://model.example',
  LLM_API_KEY: 'local-model',
  LLM_MODEL: 'local-model',
  LLM_MODEL_CHEAP: 'local-model',
  LLM_MAX_RETRY: '0',
  LLM_HEDGE_MODEL: '',
  EMBED_BASE_URL: 'http://model.example',
  EMBED_API_KEY: 'local-model',
  ALERT_WEBHOOK_URL: '',
});
const r = await import('./runtime.js');
const states = await import('./state.js');
const store = await import('../store.js');
const config = await import('../config/source.js');
const takeover = await import('../handoff/takeover.js');
const quota = await import('../quota/ledger.js');
const insight = await import('../core/insight.js');
const retrieval = await import('../core/retrieval.js');
const privacy = await import('../privacy/privacy.js');
const metrics = await import('../ops/metrics.js');
const alerts = await import('../ops/alert.js');
const trace = await import('../trace/recorder.js');
const { bindPack } = await import('../core/pack-api.js');
const { handleMessage } = await import('../engine.js');
const { openTestDb, installSeededConfig, installPgSessionStore } = await import('../db/testing.js');
const db = await openTestDb();
const a = r.createTenantRuntime({ id: 'a', slug: 'state-a', publicBase: 'https://a.example' });
const b = r.createTenantRuntime({ id: 'b', slug: 'state-b', publicBase: 'https://b.example' });
r.registerRuntime(a);
r.registerRuntime(b);
r.configureTenancy({ role: 'host', standardCount: 2 });
const inside = <T>(rt: import('./runtime.js').TenantRuntime, fn: () => T): T => r.withTenantScope(rt, fn);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await wait(5);
  assert.ok(fn(), '等待状态超时');
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
let block: ReturnType<typeof deferred> | null = null;
let failEmbed = false;
let embeds = 0;
const calls: { owner: string; system: string; user: string }[] = [];
const fetchBefore = globalThis.fetch;
const warnBefore = console.warn;
const warning: string[] = [];
console.warn = (...args) => {
  warning.push(args.join(' '));
};
globalThis.fetch = async (_url, init) => {
  const owner = r.currentRuntime().slug;
  const body = JSON.parse(String(init?.body)) as { input?: string[]; messages?: { content: string }[] };
  if (body.input) {
    embeds++;
    if (block) await block.promise;
    if (failEmbed) return new Response('{}', { status: 500 });
    return Response.json({ data: body.input.map((_, i) => ({ embedding: [i + 1, 1] })), usage: { prompt_tokens: 1 } });
  }
  const system = body.messages?.[0]?.content ?? '';
  const user = body.messages?.at(-1)?.content ?? '';
  calls.push({ owner, system, user });
  if (block) await block.promise;
  return Response.json({
    choices: [{ message: { role: 'assistant', content: `${owner} 一条。\n${owner} 二条。` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
};
let checked = 0;
const seen = new Set<string>();
function count(rt: import('./runtime.js').TenantRuntime, name: string, expected?: number): number {
  const n = states.tenantKeys(rt.id)[name];
  assert.notEqual(n, undefined, `缺登记 ${name}`);
  if (expected !== undefined) assert.equal(n, expected, name);
  else assert.ok(n > 0, name);
  seen.add(name);
  checked++;
  return n;
}
try {
  for (const rt of [a, b])
    await inside(rt, async () => {
      await installSeededConfig(db, { slug: rt.slug });
      const fixture = await installPgSessionStore(db, { slug: rt.slug, varDir: path.join(dir, rt.slug) });
      await store.initSessionStore(fixture.deps);
    });
  const pack = inside(a, config.currentPack).runtime;
  for (const rt of [a, b])
    inside(rt, () =>
      bindPack({ ...pack, insightPrompts: { ...pack.insightPrompts, insights: rt.slug, suggestion: rt.slug, draft: rt.slug } }, null),
    );
  for (const read of [
    takeover.takeoverGen.bind(null, 'wecom:wmState'),
    () => quota.sendWindow('wecom:wmState', Date.now()),
    privacy.currentPrivacyNotice,
    retrieval.indexHealth,
  ])
    assert.throws(read, r.TenantScopeMissing);
  assert.throws(() => alerts.alert('store', '缺作用域'), r.TenantScopeMissing);
  const sa = inside(a, () => store.getOrCreateSession('wecom:wmState', 'simulator'));
  const sb = inside(b, () => store.getOrCreateSession('wecom:wmState', 'simulator'));
  inside(a, () => takeover.__takeoverTest.bump('wecom:wmState'));
  assert.equal(
    inside(b, () => takeover.takeoverGen('wecom:wmState')),
    0,
  );
  count(a, 'takeover.gens', 1);
  takeover.setReplyTransport(async () => true);
  await inside(a, () => takeover.reply('wecom:wmState', takeover.sharedActor(), '甲的回复', 'same-client'));
  await inside(b, () => takeover.reply('wecom:wmState', takeover.sharedActor(), '乙的回复', 'same-client'));
  count(a, 'takeover.recent', 1);
  count(b, 'takeover.recent', 1);
  assert.equal(sa.messages.filter((m) => m.author === 'human').length, 1);
  assert.equal(sb.messages.filter((m) => m.author === 'human').length, 1);
  for (const rt of [a, b])
    inside(rt, () => {
      const s = rt === a ? sa : sb;
      s.channel = 'wecom';
      s.messages.push({ role: 'customer', content: rt.slug, at: Date.now() });
      const m = { role: 'agent' as const, content: '待发', at: Date.now() };
      quota.holdSend('wecom:wmState', 'human', m);
      count(rt, 'ledger.holds', 1);
    });
  const handle = inside(a, () => quota.recordSend('wecom:wmState', 'ai', null));
  // 传输回调在乙作用域执行仍只能记甲的账本。
  inside(b, () => handle.settle('accepted'));
  assert.equal(
    inside(b, () => quota.__ledgerTest.rows().length),
    1,
  );
  assert.equal(
    inside(a, () => quota.__ledgerTest.rows().length),
    2,
  );
  count(a, 'ledger.bySession', 1);
  count(a, 'ledger.byMsgid', 2);
  // DB 写路径需要等待消息分配 seq；只测试等待注册，不启动真实写后端。
  inside(a, () => {
    const send = quota.recordSend('wecom:wmState', 'ai', { role: 'agent', content: '等 seq', at: Date.now() });
    send.settle('accepted');
    count(a, 'ledger.awaitingSeq', 1);
    count(a, 'ledger.timers', 1);
  });
  // 同 id、同消息数的建议与草稿不去重到别的租户；每租户自己的请求才共用。
  block = deferred();
  const before = calls.length;
  const pa = inside(a, () => insight.getSuggestion(sa));
  const pa2 = inside(a, () => insight.getSuggestion(sa));
  const pb = inside(b, () => insight.getSuggestion(sb));
  const da = inside(a, () => insight.getDraftReply(sa));
  await until(() => calls.length >= before + 3);
  count(a, 'insight.sugInflight', 1);
  count(a, 'insight.draftInflight', 1);
  block.release();
  block = null;
  const [va, va2, vb] = await Promise.all([pa, pa2, pb, da]);
  assert.equal(va, va2);
  assert.notEqual(va, vb);
  count(a, 'insight.sugCache', 1);
  count(a, 'insight.draftCache', 1);
  await inside(a, insight.getInsights);
  count(a, 'insight.insightCache', 1);
  // 目录相同共用成功的只读内容；当前引用、代次、失败与重试仍属各租户。
  await inside(a, retrieval.buildIndex);
  const afterA = embeds;
  await inside(b, retrieval.buildIndex);
  assert.equal(embeds, afterA);
  count(a, 'retrieval.index', 1);
  count(a, 'retrieval.indexGeneration', 1);
  inside(b, () => bindPack({ ...pack, retrievalText: (item) => `乙独有 ${pack.retrievalText(item)}` }, null));
  failEmbed = true;
  block = deferred();
  inside(b, retrieval.invalidateIndex);
  count(b, 'retrieval.building', 1);
  count(b, 'retrieval.stale', 1);
  block.release();
  block = null;
  await inside(b, retrieval.buildIndex);
  count(b, 'retrieval.lastError', 1);
  count(b, 'retrieval.retryAttempt', 1);
  count(b, 'retrieval.retryTimer', 1);
  assert.equal(inside(a, retrieval.indexHealth).stale, false);
  failEmbed = false;
  // 隐私轮询各自读取同 id 的版本，沙箱不轮询。
  await db.pg.exec('RESET ROLE');
  await db.pg.query('insert into privacy_notices (tenant_id, version, body) values ($1,1,$2),($3,1,$4)', [a.id, '甲隐私', b.id, '乙隐私']);
  await db.pg.exec('SET ROLE agent_app');
  for (const rt of [a, b])
    await inside(rt, async () => {
      await privacy.initPrivacy();
      privacy.startPrivacyPoll(15);
    });
  count(a, 'privacy.current', 1);
  count(a, 'privacy.pollTimer', 1);
  assert.equal(inside(a, privacy.privacyLink), 'https://a.example/privacy');
  assert.equal(inside(b, privacy.currentPrivacyNotice)?.body, '乙隐私');
  const sandbox = r.createTenantRuntime({ id: 'sbx', slug: 'sbx', kind: 'sandbox' });
  inside(sandbox, () => privacy.startPrivacyPoll());
  assert.equal(inside(sandbox, privacy.__privacyTest.polling), false);
  const items = inside(a, () => pack.retrievalItems());
  inside(sandbox, () =>
    bindPack(
      {
        ...pack,
        retrievalItems: () => items,
        retrievalText: (item) => `沙箱独有 ${pack.retrievalText(item)}`,
        retrievalCacheFile: 'sandbox-only.json',
      },
      null,
    ),
  );
  await inside(sandbox, retrieval.buildIndex);
  assert.equal(fs.existsSync(path.join(dir, 'sandbox-only.json')), false);
  states.dropTenantState(sandbox.id);
  // 运行数字在各自配置作用域查询，不再拒绝第二个已装载租户。
  for (const rt of [a, b])
    await inside(rt, () =>
      metrics.readMetricsView({ tenantId: rt.id, actor: { kind: 'system', userId: null, name: null, ip: null } }, 7, Date.now()),
    );
  count(a, 'metrics.retention', 1);
  count(a, 'metrics.views', 1);
  // 告警同账号同原因分别去重，实例告警不寄存在甲。
  alerts.__alertTest.setClock(() => Date.now());
  for (const rt of [a, b]) inside(rt, () => alerts.alert('channel', '同账号失败', { scope: 'same-key' }));
  assert.equal(warning.filter((s) => s.includes('同账号失败')).length, 2);
  alerts.startAlerts();
  alerts.__alertTest.stopTimer();
  for (const rt of [a, b]) inside(rt, () => quota.recordSend('wecom:wmState', 'ai', null).settle('rejected', 1));
  count(a, 'alert.wecomAccounts', 1);
  const { noteInboxAbandoned } = await import('../channels/inbox.js');
  for (const rt of [a, b]) inside(rt, () => noteInboxAbandoned({ account: 'same-key', reason: 'poison' }));
  count(a, 'alert.inboxAlerted', 1);
  count(a, 'alert.storeSamples');
  inside(a, () => store.__storeTest.emitIncident({ kind: 'conflict', detail: '会话 test' }));
  alerts.__alertTest.setProbe({ health: () => ({ ...store.storeHealth(), poisoned: ['same-code'] }), counters: () => null });
  alerts.__alertTest.tick();
  alerts.__alertTest.setProbe(null);
  count(a, 'alert.poisonedSeen', 1);
  count(a, 'alert.states');
  // 请求订阅只接收本租户同会话的 turn，并可按租户注销。
  const turns: string[] = [];
  inside(a, () => trace.onTurnEnd(() => turns.push('a'), { conversationId: sa.id }));
  inside(a, () => trace.onTurnEnd(() => turns.push('other'), { conversationId: 'other' }));
  inside(b, () => trace.onTurnEnd(() => turns.push('b')));
  count(a, 'trace.endObservers', 2);
  await inside(a, () =>
    trace.withTurnScope(async () => {
      trace.startTurn(sa.id);
      trace.endTurn('silent', '', sa.stage, sa.stage);
    }),
  );
  assert.deepEqual(turns, ['a']);
  // 引擎按（租户、会话）串行，乙无需等甲；甲同会话的链上有两轮。
  for (const rt of [a, b]) inside(rt, privacy.__privacyTest.reset);
  const chainStart = calls.length;
  sa.handedOver = false;
  sb.handedOver = false;
  block = deferred();
  const first = inside(a, () => handleMessage('wecom:wmChain', 'simulator', '你好'));
  const second = inside(a, () => handleMessage('wecom:wmChain', 'simulator', '你好'));
  const other = inside(b, () => handleMessage('wecom:wmChain', 'simulator', '你好'));
  await until(() => calls.slice(chainStart).some((c) => c.owner === a.slug) && calls.slice(chainStart).some((c) => c.owner === b.slug));
  count(a, 'engine.sessionChain', 1);
  count(b, 'engine.sessionChain', 1);
  block.release();
  block = null;
  await Promise.all([first, second, other]);
  // 删除期间的旧结果不能恢复缓存；另一租户全部登记计数保持原样。
  sa.messages.push({ role: 'customer', content: '晚到', at: Date.now() });
  block = deferred();
  const late = inside(a, () => insight.getDraftReply(sa));
  await until(() => calls.at(-1)?.user.includes('晚到') === true);
  const bKeys = states.tenantKeys(b.id);
  a.state = 'closing';
  states.dropTenantState(a.id);
  block.release();
  block = null;
  assert.equal(await late, '');
  assert.deepEqual(states.tenantKeys(b.id), bKeys);
  for (const name of seen) assert.equal(states.tenantKeys(a.id)[name], 0, `drop ${name}`);
  handle.settle('accepted');
  assert.equal(states.tenantKeys(a.id)['ledger.byMsgid'], 0);
  for (const rt of [a, b]) await inside(rt, () => store.drainStore(1000));
  states.resetTenantState();
  for (const name of seen) assert.equal(states.tenantKeys(b.id)[name], 0, `reset ${name}`);
  console.log(`PASS 第 7 步租户状态：${checked} 个计数断言，隔离、drop、reset 与迟到结果`);
} finally {
  block?.release();
  globalThis.fetch = fetchBefore;
  console.warn = warnBefore;
  alerts.__alertTest.stopTimer();
  await alerts.__alertTest.settle();
  for (const rt of r.tenantRuntimes()) {
    await rt.store.pgBackend?.close();
    states.dropTenantState(rt.id);
    r.unregisterRuntime(rt.id);
  }
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
