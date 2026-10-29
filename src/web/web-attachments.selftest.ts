// 12 R3：真实路由 → 证明包 intake → 会话/附件事务；仅合成样本、离线模型。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { ChannelAccount } from '../channels/accounts.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-attachments-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  PACK_FIXTURES: '1',
  LLM_MOCK: '1',
  SERVER_SELFTEST: '1',
  SOP_PATH: 'data/packs/__fixture/sop.md',
  WEB_RATE_PER_MIN: '20',
  WEB_UPLOAD_PER_MIN: '5',
});
const { hostRuntime } = await import('../tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
enterTenantScopeForTest(hostRuntime());
const store = await import('../store.js');
const config = await import('../config/source.js');
await config.initConfig(null);
const { bindPack } = await import('../core/pack-api.js');
const { createFixtureRuntime } = await import('../packs/__fixture/runtime.js');
const { withFixtureIntake } = await import('../packs/__fixture/intake.js');
const testing = await import('../db/testing.js');
let db: Db;
let tenantId: string;
let query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let closeDb: () => Promise<void>;
if (process.env.PG_TEST_URL) {
  const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL, { slug: 'web-attachment' });
  const appDb = await testing.openGatedDb(fx.urls.app);
  db = appDb.db;
  tenantId = fx.tenantId;
  query = fx.query;
  closeDb = async () => {
    await appDb.close();
    await fx.drop();
  };
} else {
  const t = await testing.openTestDb();
  const fx = await testing.installPgSessionStore(t, { slug: 'web-attachment', varDir: dir });
  db = fx.deps.db;
  tenantId = fx.deps.tenantId;
  query = <T>(sql: string, params: unknown[] = []) =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<T>(sql, params)).rows;
    });
  closeDb = () => t.close();
}
await store.initSessionStore({ db, tenantId, tenantSlug: 'web-attachment', varDir: dir });
const { installAccounts } = await import('../channels/accounts.js');
const { __profileTest } = await import('../profile.js');
const { app } = await import('../server.js');
const { webAdapter, webConversationId } = await import('../adapters/web.js');
const { WEB_UPLOAD_MAX_BYTES } = await import('./upload.js');
const accounts: ChannelAccount[] = [];
async function account(dailyTurns = 1000): Promise<ChannelAccount> {
  const a: ChannelAccount = {
    id: randomUUID(),
    tenantId,
    key: `web-${accounts.length}`,
    name: '附件自测',
    kind: 'web',
    status: 'active',
    source: 'db',
    inactiveReason: null,
    wecom: null,
    web: { title: '附件自测', dailyNewConversations: 100, dailyTurns },
  };
  await query('insert into channel_accounts (id,tenant_id,key,kind,name,status,settings) values ($1,$2,$3,$4,$5,$6,$7)', [
    a.id,
    tenantId,
    a.key,
    a.kind,
    a.name,
    a.status,
    JSON.stringify(a.web),
  ]);
  accounts.push(a);
  installAccounts(accounts);
  return a;
}
const primary = await account();
const base = createFixtureRuntime(config.packSources());
let received = 0;
let blocked: Promise<void> | undefined;
let started: (() => void) | undefined;
let invalidReply = false;
let handoffReply = false;
const runtime = withFixtureIntake(base, async (ctx, kit) => {
  received++;
  started?.();
  if (blocked) await blocked;
  let result: unknown;
  if (ctx.attachment.cls === 'sheet') {
    result = await kit.sheet();
    assert.deepEqual(result, {
      ok: true,
      sheets: [
        {
          name: 'CSV',
          rows: [
            ['型号', '数量'],
            ['A1', '2'],
          ],
        },
      ],
    });
  } else {
    result = await kit.vision({
      prompt: '读取合成型号',
      schema: z.object({ code: z.string() }).default({ code: 'A1' }),
      maxOutputTokens: 20,
    });
    assert.deepEqual(result, { code: 'A1' });
  }
  kit.saveResult(result, 'int_123456789abc');
  return {
    text: invalidReply ? '未登记的文字' : '附件已核验。',
    fixedId: 'fixture.intake',
    ...(handoffReply ? { handoff: { reason: '附件已核验。' } } : {}),
  };
});
bindPack(runtime, runtime.defaultBrand);
const jpeg = Buffer.from('ffd8ffe10008457869664750ffda000273ffd9', 'hex');
const csv = Buffer.from('型号,数量\nA1,2');
let serial = 0;
const nextIp = () => `198.51.100.${++serial}`;
const endpoint = (a = primary) => `/api/web/${a.key}/attachments`;
function form(bytes: Uint8Array = csv, name = '投诉.csv', cid = randomUUID()): FormData {
  const data = new FormData();
  data.append('file', new Blob([Buffer.from(bytes)], { type: 'application/octet-stream' }), name);
  data.append('cid', cid);
  return data;
}
async function upload(data = form(), options: { cookie?: string; ip?: string; account?: ChannelAccount } = {}) {
  return app.request(endpoint(options.account), {
    method: 'POST',
    headers: { 'x-web-chat': '1', 'x-forwarded-for': options.ip ?? nextIp(), ...(options.cookie ? { cookie: options.cookie } : {}) },
    body: data,
  });
}
async function json(res: Response, status = 200) {
  assert.equal(res.status, status);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  return res.json() as Promise<{ reply: { text: string; parts: unknown[] } | null }>;
}
function own(res: Response, a = primary) {
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const s = store.getSession(webConversationId(a.id, cookie.split('=')[1]!))!;
  return { cookie, s };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('自测禁止网络请求');
};
try {
  const firstCid = randomUUID();
  const first = await upload(form(csv, '投诉.csv', firstCid));
  const reply = await json(first);
  assert.equal(reply.reply?.text, '附件已核验。');
  const visitor = own(first);
  await store.flushSession(visitor.s.id);
  const rows = await store.listAttachmentMetadata(visitor.s.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cls, 'sheet');
  assert.equal(rows[0]!.channel, 'web');
  assert.equal(rows[0]!.name, '投诉.csv');
  assert.equal(rows[0]!.intakeId, 'int_123456789abc');
  assert.equal(visitor.s.handedOver, false, '文件名不触发投诉');
  assert.equal(visitor.s.messages[0]!.content, '[文件]');
  assert.equal(visitor.s.messages[0]!.attachment?.id, rows[0]!.id);
  const image = await upload(form(Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(80_000), jpeg.subarray(-2)]), '伪装.csv'), {
    cookie: visitor.cookie,
  });
  assert.equal((await json(image)).reply?.text, '附件已核验。');
  await store.flushSession(visitor.s.id);
  const images = await store.listAttachmentMetadata(visitor.s.id);
  assert.equal(images[1]!.cls, 'image', '按魔数识别，不信 MIME/文件名');
  const storedImage = await store.readAttachment(images[1]!.id, true);
  assert.ok(storedImage && 'bytes' in storedImage && storedImage.bytes);
  assert.ok(!Buffer.from(storedImage.bytes).includes(Buffer.from('ExifGP')));
  assert.equal(visitor.s.messages[2]!.content, '[图片]');
  assert.equal(visitor.s.messages.filter((m) => m.role === 'agent').length, 2, '没有等待句');
  console.log('PASS web attachments: 图片/表格完整链路、64 KB 豁免、内容判类、去元数据、保存结果、无文件名正文/等待句');

  const before = received;
  assert.deepEqual(await json(await upload(form(jpeg, '不同.jpg', firstCid), { cookie: visitor.cookie })), reply);
  await store.flushSession(visitor.s.id);
  assert.equal(received, before);
  assert.equal((await store.listAttachmentMetadata(visitor.s.id)).length, 2);
  assert.equal(visitor.s.messages.filter((m) => m.msgid === firstCid).length, 1);
  const history = await app.request(`/api/web/${primary.key}/history`, { headers: { cookie: visitor.cookie } });
  const historyBody = (await history.json()) as { messages: { role: string; text: string }[] };
  assert.deepEqual(
    historyBody.messages.filter((m) => m.role === 'customer').map((m) => m.text),
    ['[文件]', '[图片]'],
  );
  assert.ok(!JSON.stringify(historyBody).includes('投诉'));
  console.log('PASS web attachments: cid 重试同回复、附件只存一份、历史只有占位');

  const second = await upload(form(csv, '另一份.csv', firstCid));
  await json(second);
  const otherVisitor = own(second);
  assert.notEqual(otherVisitor.cookie, visitor.cookie);
  await store.flushSession(otherVisitor.s.id);
  const otherRows = await store.listAttachmentMetadata(otherVisitor.s.id);
  assert.equal(otherRows.length, 1);
  assert.equal(rows[0]!.sourceKey, `${visitor.s.id}:${firstCid}`);
  assert.equal(otherRows[0]!.sourceKey, `${otherVisitor.s.id}:${firstCid}`);
  assert.notEqual(otherRows[0]!.id, rows[0]!.id);
  assert.equal(otherVisitor.s.messages[0]!.attachment?.id, otherRows[0]!.id);
  for (const row of [rows[0]!, otherRows[0]!]) {
    const saved = await store.readAttachment(row.id, true);
    assert.ok(saved && 'bytes' in saved && saved.bytes);
    assert.equal(saved.conversationId, row.conversationId);
    assert.deepEqual(Buffer.from(saved.bytes), csv);
  }
  await json(await upload(form(jpeg, '重试.jpg', firstCid), { cookie: otherVisitor.cookie }));
  assert.equal((await store.listAttachmentMetadata(otherVisitor.s.id)).length, 1);
  console.log('PASS web attachments: 不同 cookie 复用 cid 各有可读附件，同会话重试不重复');

  const events = await app.request(`/api/web/${primary.key}/events`, { headers: { cookie: visitor.cookie, 'x-forwarded-for': nextIp() } });
  const reader = events.body!.getReader();
  await reader.read();
  await webAdapter.push(visitor.s.id, '顾问收到附件', { kind: 'human' });
  const pushed = new TextDecoder().decode((await reader.read()).value);
  assert.match(pushed, /event: push/);
  assert.match(pushed, /顾问收到附件/);
  await reader.cancel();
  console.log('PASS web attachments: 同步回复与原 SSE 顾问投递共存');

  await json(await app.request(endpoint(), { method: 'POST', body: form() }), 403);
  for (const modify of [
    (data: FormData) => data.append('extra', 'bad'),
    (data: FormData) => data.delete('file'),
    (data: FormData) => data.append('file', new Blob(['x']), 'extra.csv'),
    (data: FormData) => data.append('cid', randomUUID()),
    (data: FormData) => data.delete('cid'),
    (data: FormData) => data.set('cid', 'short'),
    (data: FormData) => data.set('file', 'not a file'),
  ]) {
    const data = form();
    modify(data);
    await json(await upload(data), 400);
  }
  console.log('PASS web attachments: 缺 x-web-chat、额外/重复字段、缺 file/cid 与非法值');

  for (const declared of [String(WEB_UPLOAD_MAX_BYTES + 1), '1', undefined]) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(Buffer.alloc(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request(`http://localhost${endpoint()}`, {
      method: 'POST',
      headers: {
        'x-web-chat': '1',
        'x-forwarded-for': nextIp(),
        'content-type': 'multipart/form-data; boundary=test',
        ...(declared ? { 'content-length': declared } : {}),
      },
      body,
      duplex: 'half',
    } as RequestInit);
    await json(await app.request(req), 413);
    assert.equal(cancelled, true);
    assert.equal(pulls, declared === String(WEB_UPLOAD_MAX_BYTES + 1) ? 0 : 9, '超限立即截断，不读完整流');
  }
  console.log('PASS web attachments: Content-Length 早拒绝、谎报与无长度实际字节 413/取消流');

  const limitIp = nextIp();
  for (let i = 0; i < 5; i++) await json(await upload(form(), { ip: limitIp, cookie: visitor.cookie }));
  await json(await upload(form(), { ip: limitIp, cookie: visitor.cookie }), 429);
  const sharedIp = nextIp();
  for (let i = 0; i < 20; i++) {
    const res = await app.request(`/api/web/${primary.key}/messages`, {
      method: 'POST',
      headers: {
        'x-web-chat': '1',
        'x-forwarded-for': sharedIp,
        'content-type': 'application/json',
        'content-length': '2',
      },
      body: '{}',
    });
    assert.equal(res.status, 400);
  }
  await json(await upload(form(), { ip: sharedIp, cookie: visitor.cookie }), 429);
  console.log('PASS web attachments: 每分钟 5 附件及与文字共享消息限流');

  let release!: () => void;
  blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const inFlight = upload(form(), { cookie: visitor.cookie });
  await begun;
  try {
    await json(await upload(form(), { cookie: visitor.cookie }), 409);
    const text = JSON.stringify({ text: 'hello', cid: randomUUID() });
    await json(
      await app.request(`/api/web/${primary.key}/messages`, {
        method: 'POST',
        headers: {
          'x-web-chat': '1',
          'x-forwarded-for': nextIp(),
          cookie: visitor.cookie,
          'content-type': 'application/json',
          'content-length': String(text.length),
        },
        body: text,
      }),
      409,
    );
  } finally {
    release();
    blocked = undefined;
    started = undefined;
  }
  await json(await inFlight);
  console.log('PASS web attachments: 附件与文字共用会话处理中 409');

  invalidReply = true;
  const crashCid = randomUUID();
  await json(await upload(form(csv, '原件.csv', crashCid), { cookie: visitor.cookie }), 503);
  await store.flushSession(visitor.s.id);
  invalidReply = false;
  const countBeforeRetry = (await store.listAttachmentMetadata(visitor.s.id)).length;
  assert.equal((await json(await upload(form(jpeg, '替换.jpg', crashCid), { cookie: visitor.cookie }))).reply?.text, '附件已核验。');
  await store.flushSession(visitor.s.id);
  assert.equal((await store.listAttachmentMetadata(visitor.s.id)).length, countBeforeRetry);
  assert.equal(visitor.s.messages.filter((m) => m.msgid === crashCid).length, 1);
  console.log('PASS web attachments: 503 后 cid 重试只读原件，不重复保存、不替换文件');

  process.env.ATTACHMENT_DAILY_PER_TENANT = '0';
  const limitedCid = randomUUID();
  const limitReply = await json(await upload(form(csv, '限制.csv', limitedCid), { cookie: visitor.cookie }));
  assert.equal(limitReply.reply?.text, '请把型号和数量打字发来');
  assert.deepEqual(await json(await upload(form(csv, '限制.csv', limitedCid), { cookie: visitor.cookie })), limitReply);
  delete process.env.ATTACHMENT_DAILY_PER_TENANT;
  console.log('PASS web attachments: 当日份数上限固定句及幂等');

  const budget = await account(1);
  const sheet = await upload(form(), { account: budget });
  await json(sheet);
  const b = own(sheet, budget);
  await json(await upload(form(), { account: budget, cookie: b.cookie }));
  assert.equal((await json(await upload(form(jpeg, '图.jpg'), { account: budget, cookie: b.cookie }))).reply?.text, '附件已核验。');
  assert.equal(
    (await json(await upload(form(), { account: budget, cookie: b.cookie }))).reply?.text,
    '现在咨询的人有点多，顾问会在这里回复您',
  );
  await store.flushSession(b.s.id);
  assert.equal((await store.listAttachmentMetadata(b.s.id)).length, 4, '预算转人工也保留原件');
  console.log('PASS web attachments: 表格退还 dailyTurns、视觉保留预占、预算转人工保存附件');

  // 12 R3：这一轮刚转人工（如图纸的固定句），那句照常回给客户；之后的轮次才回 null。
  handoffReply = true;
  const referred = await upload();
  assert.equal((await json(referred)).reply?.text, '附件已核验。', '转人工那一轮的固定句照常回给网页客户');
  const r = own(referred);
  assert.equal(r.s.handedOver, true);
  handoffReply = false;
  assert.equal((await json(await upload(form(), { cookie: r.cookie }))).reply, null, '已转人工之后的轮次回 null');
  console.log('PASS web attachments: 转人工那一轮回固定句、之后回 null');

  visitor.s.handedOver = true;
  const callsBeforeHuman = received;
  assert.equal((await json(await upload(form(), { cookie: visitor.cookie }))).reply, null);
  await store.flushSession(visitor.s.id);
  assert.equal(received, callsBeforeHuman);
  assert.ok(visitor.s.messages.at(-1)?.attachment?.stored);
  console.log('PASS web attachments: 已转人工只存附件、不识别、不回复');

  for (const flags of [{ DEPLOY_PROFILE: 'prod' }, { DEPLOY_PROFILE: 'demo', FLAG_WEB_CHANNEL: 'off' }]) {
    __profileTest.use(flags);
    const res = await upload();
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  __profileTest.reset();
  assert.equal((await app.request('/api/web/missing/attachments', { method: 'POST', body: form() })).status, 404);
  console.log('PASS web attachments: prod/开关/账号 404');
} finally {
  assert.deepEqual((await store.drainStore(20_000)).undrained, []);
  installAccounts([]);
  __profileTest.reset();
  globalThis.fetch = originalFetch;
  await config.closeConfig();
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`PASS web attachments: ${process.env.PG_TEST_URL ? '真实 PG' : 'PGlite'}`);
