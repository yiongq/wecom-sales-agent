// 12 第 5 步：假企微 + 真入站/引擎/存储/出站链；PG_TEST_URL 可切到一次性真实 PG。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { KfMessage } from './wecom-state.js';
import type { Db } from '../db/client.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-attachments-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  PACK_FIXTURES: '1',
  LLM_MOCK: '1',
  SOP_PATH: 'data/packs/__fixture/sop.md',
  SERVER_SELFTEST: '1',
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
const { prepareAttachment, earlyAttachment } = await import('../core/attachment-intake.js');
const { stripImageMetadata } = await import('../core/attachments.js');
const { __alertTest } = await import('../ops/alert.js');
const testing = await import('../db/testing.js');
const channels = await import('../channels/registry.js');
const { sealSecrets } = await import('../channels/secrets.js');
const wecom = await import('./wecom.js');
const { __ledgerTest } = await import('../quota/ledger.js');
let db: Db;
let tenantId: string;
let query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let closeDb: () => Promise<void>;
if (process.env.PG_TEST_URL) {
  const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL, { slug: 'attachment-in' });
  const app = await testing.openGatedDb(fx.urls.app);
  db = app.db;
  tenantId = fx.tenantId;
  query = fx.query;
  closeDb = async () => {
    await app.close();
    await fx.drop();
  };
} else {
  const t = await testing.openTestDb();
  const fx = await testing.installPgSessionStore(t, { slug: 'attachment-in', varDir: dir });
  db = fx.deps.db;
  tenantId = fx.deps.tenantId;
  query = <T>(sql: string, params: unknown[] = []) =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<T>(sql, params)).rows;
    });
  closeDb = () => t.close();
}
await store.initSessionStore({ db, tenantId, tenantSlug: 'attachment-in', varDir: dir });
const account = randomUUID();
const key = Buffer.alloc(32, 7);
const ring = { current: { id: 'fixture', key }, all: new Map([['fixture', key]]) };
const sealed = sealSecrets(
  ring,
  { tenantId, accountId: account },
  { appSecret: 'fixture-app', callbackToken: 'fixture-callback', callbackAesKey: 'fixture-aes' },
);
await query(
  `insert into channel_accounts (tenant_id,id,key,name,kind,status,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id,cursor) values ($1,$2,'attach','附件测试','wecom_kf','active','wecom:','attach-corp','attach-kf',decode($3,'hex'),$4,'started')`,
  [tenantId, account, sealed.ct.toString('hex'), sealed.keyId],
);
await query(`create table attachment_txlog (tbl text, k text, tx bigint)`);
await query(
  `create function attachment_test_log() returns trigger language plpgsql security definer set search_path=public as $$ begin if TG_TABLE_NAME='conversations' then insert into attachment_txlog values (TG_TABLE_NAME, NEW.id, txid_current()); else insert into attachment_txlog values (TG_TABLE_NAME, NEW.conversation_id, txid_current()); end if; return NEW; end $$`,
);
for (const table of ['conversations', 'messages', 'attachments'])
  await query(`create trigger attachment_test_log after insert on ${table} for each row execute function attachment_test_log()`);

const jpeg = Buffer.from('ffd8ffe10008457869664750ffda000273ffd9', 'hex');
const stripped = stripImageMetadata(jpeg);
assert.ok(stripped.ok);
const csv = Buffer.from('型号,数量\nA1,2');
const sent: { touser: string; text: { content: string } }[] = [];
let incoming: KfMessage[] = [];
let serial = 0;
let tokens = 0;
let downloads = 0;
let cancelled = 0;
let pulls = 0;
let retryCode = 0;
let receiveDelay = 0;
let throwReceive = false;
let received = 0;
const seenMore: boolean[] = [];
const originalFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/gettoken')) return Response.json({ access_token: `account-token-${++tokens}`, expires_in: 7200 });
  if (url.pathname.endsWith('/media/get')) {
    downloads++;
    assert.equal(url.searchParams.get('access_token'), `account-token-${tokens}`, '用所属账号的 token');
    if (retryCode) {
      const code = retryCode;
      retryCode = 0;
      return Response.json({ errcode: code });
    }
    const media = url.searchParams.get('media_id');
    if (media === 'fail') throw new Error('不可输出的文件内容与 URL');
    if (media === 'timeout')
      return new Promise<Response>((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
      );
    if (media === 'oversize') {
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(Buffer.concat([jpeg.subarray(0, 3), Buffer.alloc(65533)]));
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-length': String(9 * 1024 * 1024) } },
      );
    }
    const bytes = media === 'csv' || media === 'plain' ? csv : jpeg;
    return new Response(bytes, {
      headers: {
        'content-length': String(bytes.length),
        'content-type': media === 'csv' ? 'application/octet-stream' : 'image/jpeg',
        'content-disposition':
          media === 'plain'
            ? 'attachment; filename="plain.csv"'
            : `attachment; filename="wrong.csv"; filename*=UTF-8''%E6%8A%95%E8%AF%89.csv`,
      },
    });
  }
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (url.pathname.endsWith('/kf/sync_msg')) {
    const page = incoming;
    incoming = [];
    return Response.json({ next_cursor: `c-${++serial}`, has_more: 0, msg_list: page });
  }
  if (url.pathname.endsWith('/kf/send_msg')) {
    sent.push(body);
    return Response.json({ errcode: 0, msgid: body.msgid });
  }
  if (url.pathname.endsWith('/kf/customer/batchget')) return Response.json({ customer_list: [] });
  throw new Error('未预期的网络请求');
};
globalThis.fetch = fakeFetch;
const base = createFixtureRuntime(config.packSources());
const runtime = withFixtureIntake(base, async (ctx, kit) => {
  received++;
  seenMore.push(!!ctx.moreQueued);
  assert.equal('attachmentItem' in ctx, false);
  assert.equal('attachmentBytes' in ctx, false);
  if (receiveDelay) await sleep(receiveDelay);
  if (throwReceive) throw new Error('不可输出的原件内容');
  if (ctx.attachment.cls === 'sheet') assert.equal((await kit.sheet()).ok, true);
  kit.saveResult({ checked: true }, 'int_123456789abc');
  return ctx.moreQueued ? null : { text: '附件已核验。', fixedId: 'fixture.intake' };
});
runtime.intake!.classes = ['image', 'sheet', 'other', 'video', 'drawing'];
bindPack(runtime, runtime.defaultBrand);
const idle = async () => {
  const until = Date.now() + 35_000;
  while (!wecom.__wecomTest.idle() && Date.now() < until) await sleep(10);
  assert.ok(wecom.__wecomTest.idle(), '处理链必须结束');
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
};
function message(uid: string, type = 'image', media = 'jpeg'): KfMessage {
  return {
    msgid: `att-msg-${++serial}`,
    open_kfid: 'attach-kf',
    external_userid: uid,
    send_time: Math.floor(Date.now() / 1000),
    origin: 3,
    msgtype: type,
    [type]: { media_id: media },
  };
}
async function send(uid: string, type = 'image', media = 'jpeg', n = 1) {
  const messages = Array.from({ length: n }, () => message(uid, type, media));
  incoming = messages;
  await wecom.syncAccountFromCallback(account, 'fixture-sync');
  await idle();
  for (const msg of messages)
    assert.equal((await query<{ state: string }>('select state from channel_inbox where msgid=$1', [msg.msgid]))[0]?.state, 'done');
  return messages;
}
const sentTo = (uid: string) => sent.filter((s) => s.touser === uid).map((s) => s.text.content);
const rowOf = async (uid: string) => (await store.listAttachmentMetadata(`wecom:${uid}`))[0]!;
const waitText = '收到图片，正在识别型号和数量，请稍等';
try {
  await channels.initChannels({ db, tenantId, tenantSlug: 'attachment-in', varDir: dir, keyRing: ring });
  channels.startChannels();
  await idle();
  await send('wmAnew');
  const photo = await rowOf('wmAnew');
  assert.equal(photo.name, null);
  assert.equal(photo.sha256, createHash('sha256').update(stripped.bytes).digest('hex'));
  const raw = await store.readAttachment(photo.id, true);
  assert.ok(raw && 'bytes' in raw);
  assert.deepEqual(Buffer.from(raw.bytes!), Buffer.from(stripped.bytes));
  assert.deepEqual(sentTo('wmAnew'), ['附件已核验。']);
  const txs = await query<{ tbl: string; tx: string }>('select tbl,tx::text from attachment_txlog where k=$1', ['wecom:wmAnew']);
  const first = txs.find((x) => x.tbl === 'conversations')!.tx;
  assert.ok(
    ['messages', 'attachments'].every((table) => txs.some((x) => x.tbl === table && x.tx === first)),
    '新会话、客户消息、附件同一次提交',
  );
  console.log('ATTACHMENT PASS: 下载图片、去 EXIF 与 sha256、首图三表同事务、快于 5 秒无等待');
  for (const [uid, media, expected] of [
    ['wmAcsv', 'csv', '投诉.csv'],
    ['wmAplain', 'plain', 'plain.csv'],
  ]) {
    await send(uid!, 'file', media);
    assert.equal((await rowOf(uid!)).name, expected);
    assert.equal(store.getSession(`wecom:${uid}`)!.messages[0]!.content, '[文件]');
    assert.equal(store.getSession(`wecom:${uid}`)!.handedOver, false);
  }
  for (const code of [42001, 40014]) {
    const before = tokens;
    retryCode = code;
    await send(`wmA${code}`);
    assert.equal(tokens, before + 1);
  }
  await send('wmAbig', 'image', 'oversize');
  const big = await rowOf('wmAbig');
  assert.equal(big.cls, 'other');
  assert.equal(big.sha256, null);
  assert.equal(big.stored, false);
  assert.equal(cancelled, 1);
  assert.equal(pulls, 1);
  const beforeVideo = downloads;
  await send('wmAvideo', 'video');
  assert.equal(downloads, beforeVideo);
  assert.equal((await rowOf('wmAvideo')).cls, 'video');
  console.log('ATTACHMENT PASS: 文件名扩展参数优先/普通回退、不进正文、双错误码刷新、超限流中断、视频不下载');
  await send('wmAbatch', 'image', 'jpeg', 3);
  assert.deepEqual(seenMore.slice(-3), [true, true, false]);
  assert.deepEqual(sentTo('wmAbatch'), ['附件已核验。']);
  receiveDelay = 1800;
  const slow = await send('wmAslow', 'image', 'jpeg', 3);
  assert.deepEqual(sentTo('wmAslow'), [waitText, '附件已核验。']);
  const notices = await query<{ kind: string; inbox_id: string | null }>(
    'select kind,inbox_id from outbound_sends where conversation_id=$1 order by sent_at',
    ['wecom:wmAslow'],
  );
  assert.deepEqual(
    notices.map((n) => [n.kind, n.inbox_id === null]),
    [
      ['notice', true],
      ['ai', false],
    ],
  );
  assert.equal(store.getSession('wecom:wmAslow')!.messages.filter((m) => m.content === waitText).length, 0);
  receiveDelay = 5100;
  await send('wmAsheet', 'file', 'csv');
  assert.deepEqual(sentTo('wmAsheet'), ['附件已核验。']);
  receiveDelay = 0;
  console.log('ATTACHMENT PASS: 连发三张只合并回复、按批 5 秒只发一次 notice 且先于清单、仅表格无等待');

  const human = store.getOrCreateSession('wecom:wmAhuman', 'wecom');
  human.handedOver = true;
  store.saveSession(human);
  const beforeHuman = received;
  await send('wmAhuman');
  assert.equal((await rowOf('wmAhuman')).stored, true);
  assert.equal(received, beforeHuman);
  assert.deepEqual(sentTo('wmAhuman'), []);
  await send('wmAfail', 'image', 'fail');
  assert.deepEqual(sentTo('wmAfail'), ['这份附件没读出来，请把型号和数量打字发来']);
  throwReceive = true;
  await send('wmAreadfail');
  assert.deepEqual(sentTo('wmAreadfail'), ['这份附件没读出来，请把型号和数量打字发来']);
  throwReceive = false;
  const timeoutStart = Date.now();
  await send('wmAtimeout', 'image', 'timeout');
  assert.ok(Date.now() - timeoutStart >= 19_500 && Date.now() - timeoutStart < 25_000);
  assert.equal(sentTo('wmAtimeout').at(-1), '这份附件没读出来，请把型号和数量打字发来');
  console.log('ATTACHMENT PASS: 转人工保存原件但不识别/回复、下载与识别失败到 done、下载 20 秒超时');

  // 用未结束行驱动与启动同一入口；received 无会话，recorded 用已经落库的原件恢复。
  const recover = async (msg: KfMessage, state: 'received' | 'recorded') => {
    await query(
      `insert into channel_inbox (tenant_id,account_id,msgid,kind,conversation_id,sent_at,state,payload) values ($1,$2,$3,'message',$4,now(),$5,$6::json)`,
      [tenantId, account, msg.msgid, `wecom:${msg.external_userid}`, state, JSON.stringify(msg)],
    );
    await wecom.__wecomTest.dispatchOpen(account);
    await idle();
    assert.equal((await query<{ state: string }>('select state from channel_inbox where msgid=$1', [msg.msgid]))[0]?.state, 'done');
  };
  receiveDelay = 5100;
  await recover(message('wmArecnew'), 'received');
  assert.deepEqual(sentTo('wmArecnew'), ['附件已核验。']);
  receiveDelay = 0;
  for (const stored of [true, false]) {
    const msg = message(stored ? 'wmArecord' : 'wmAnobytes');
    const session = store.getOrCreateSession(`wecom:${msg.external_userid}`, 'wecom');
    const prepared = await prepareAttachment({ bytes: jpeg, name: null, channel: 'wecom', sourceKey: msg.msgid });
    assert.ok(prepared.ok);
    session.messages.push({
      role: 'customer',
      content: '[图片]',
      at: Date.now(),
      sentAt: msg.send_time * 1000,
      msgid: msg.msgid,
      attachment: prepared.value.attachment,
    });
    store.saveSession(session);
    store.queueAttachment(session.id, { ...prepared.value.attachmentItem, bytes: stored ? prepared.value.attachmentBytes! : null });
    await store.flushSession(session.id);
    const before = downloads;
    receiveDelay = stored ? 5100 : 0;
    await recover(msg, 'recorded');
    receiveDelay = 0;
    assert.equal(downloads, before);
    assert.equal(session.messages.filter((m) => m.msgid === msg.msgid).length, 1);
    assert.deepEqual(sentTo(msg.external_userid), [stored ? '附件已核验。' : '这份附件没读出来，请再发一次或打字']);
  }
  // replied：停机截止把最终清单留在账本 pending，再恢复仅补发。
  let deferred = false;
  __ledgerTest.setPlanHook((intents) => {
    if (intents.some((i) => i.sessionId === 'wecom:wmAreplied')) {
      deferred = true;
      wecom.__wecomTest.closeSends(account, Date.now());
    }
  });
  const replied = message('wmAreplied');
  incoming = [replied];
  await wecom.syncAccountFromCallback(account, 'fixture-sync');
  await idle();
  __ledgerTest.setPlanHook(null);
  assert.equal(deferred, true);
  assert.equal((await query<{ state: string }>('select state from channel_inbox where msgid=$1', [replied.msgid]))[0]?.state, 'replied');
  const beforeResume = received;
  const beforeDownload = downloads;
  wecom.__wecomTest.closeSends(account, null);
  await wecom.__wecomTest.dispatchOpen(account);
  await idle();
  assert.equal(received, beforeResume);
  assert.equal(downloads, beforeDownload);
  assert.deepEqual(sentTo('wmAreplied'), ['附件已核验。']);
  assert.equal((await query<{ state: string }>('select state from channel_inbox where msgid=$1', [replied.msgid]))[0]?.state, 'done');
  assert.ok(slow.length === 3);
  console.log('ATTACHMENT PASS: received 重下且恢复无等待、recorded 只读原件/无原件兜底、replied 仅补发到 done');

  // 真正走一次出站启动恢复：上次停机留下的 pending 等待句不能补发。
  receiveDelay = 5100;
  __ledgerTest.setPlanHook((intents) => {
    if (intents.some((i) => i.sessionId === 'wecom:wmAwaitold' && i.kind === 'notice')) wecom.__wecomTest.closeSends(account, Date.now());
  });
  incoming = [message('wmAwaitold')];
  await wecom.syncAccountFromCallback(account, 'fixture-sync');
  await idle();
  __ledgerTest.setPlanHook(null);
  receiveDelay = 0;
  assert.deepEqual(sentTo('wmAwaitold'), []);
  channels.__channelsTest.reset();
  await channels.initChannels({ db, tenantId, tenantSlug: 'attachment-in', varDir: dir, keyRing: ring });
  channels.startChannels();
  await wecom.syncAccountFromCallback(account, 'fixture-restart');
  await idle();
  assert.deepEqual(sentTo('wmAwaitold'), ['附件已核验。']);
  assert.equal(
    (
      await query<{ status: string }>("select status from outbound_sends where conversation_id=$1 and kind='notice'", ['wecom:wmAwaitold'])
    )[0]?.status,
    'cancelled',
  );
  console.log('ATTACHMENT PASS: 启动取消旧 pending 等待句，只补发最终清单');

  const classes = runtime.intake!.classes;
  runtime.intake!.classes = ['image', 'sheet'];
  const beforeUnsupported = received;
  await send('wmAunsupported', 'video');
  assert.equal(received, beforeUnsupported);
  assert.equal((await store.listAttachmentMetadata('wecom:wmAunsupported')).length, 0);
  assert.deepEqual(sentTo('wmAunsupported'), ['这条消息我这边暂时处理不了，请用文字描述您的需求，我来帮您。']);
  runtime.intake!.classes = classes;

  __alertTest.reset();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  process.env.ATTACHMENT_DAILY_PER_TENANT = String((await store.readAttachmentUsage()).count);
  const beforeLimit = received;
  try {
    await send('wmAlimit');
    await send('wmAlimit2');
  } finally {
    console.warn = warn;
    delete process.env.ATTACHMENT_DAILY_PER_TENANT;
  }
  assert.equal(received, beforeLimit);
  assert.deepEqual(sentTo('wmAlimit'), ['请把型号和数量打字发来']);
  assert.equal((await store.listAttachmentMetadata('wecom:wmAlimit')).length, 0);
  assert.equal(warnings.filter((w) => w.includes('附件达到当日份数上限')).length, 1);
  const malformed = await prepareAttachment({ bytes: Buffer.from('ffd8ff', 'hex'), name: 'x', channel: 'web', sourceKey: 'bad-image' });
  assert.ok(malformed.ok);
  assert.equal(malformed.value.attachment.cls, 'other');
  assert.equal(malformed.value.attachmentItem.bytes, null);
  const cleaned = await prepareAttachment({
    bytes: csv,
    name: `${String.fromCharCode(0, 10, 0x202e)}${'字'.repeat(110)}.csv`,
    channel: 'web',
    sourceKey: 'name-clean',
  });
  assert.ok(cleaned.ok);
  assert.equal(cleaned.value.attachment.name, '字'.repeat(96) + '.csv');
  assert.equal(cleaned.value.attachment.cls, 'sheet');
  assert.equal(earlyAttachment(jpeg, 9 * 1024 * 1024).metadata.sha256, null);
  console.log('ATTACHMENT PASS: 当日份数上限不进引擎/每天一次告警、损坏图片不存原件、文件名清洗与截断');
  console.log(`WECOM ATTACHMENTS SELFTEST PASS (${process.env.PG_TEST_URL ? 'PG' : 'PGlite'})`);
} finally {
  __ledgerTest.setPlanHook(null);
  wecom.stopWecomAccounts();
  channels.__channelsTest.stopStatsRefresh();
  await store.drainStore(5000);
  await hostRuntime().store.pgBackend?.close();
  await config.closeConfig();
  await closeDb();
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
