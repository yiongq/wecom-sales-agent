// 10 R16：真实数据库入站 / 出站链，多租户同类非文字消息按包取句；所有网络请求均为替身。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KfMessage } from './wecom-state.js';
import type { ReplyGuardContext } from '../core/pack-api.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-nontext-'));
Object.assign(process.env, { VAR_DIR: dir, CONFIG_SOURCE: 'file', LLM_MOCK: '1', PACK_FIXTURES: '1', TENANCY_STRICT: '1' });
const tenancy = await import('../tenancy/runtime.js');
const state = await import('../tenancy/state.js');
const store = await import('../store.js');
const config = await import('../config/source.js');
const testing = await import('../db/testing.js');
const channels = await import('../channels/registry.js');
const { sealSecrets } = await import('../channels/secrets.js');
const { bindPack } = await import('../core/pack-api.js');
const { runtimeById } = await import('../packs/registry.js');
const { industrialReplyGuard } = await import('../packs/industrial/guards.js');
const { defaultIndustrialPolicy } = await import('../packs/industrial/policy.js');
const wecom = await import('./wecom.js');
const db = await testing.openTestDb();
const tenants = ['travel', 'industrial', '__fixture'].map((pack, i) => ({
  pack,
  rt: tenancy.createTenantRuntime({
    id: `nontext-${i}`,
    slug: `nontext-${i}`,
    isHost: i === 0,
    publicBase: 'https://nontext.example.invalid',
  }),
  account: randomUUID(),
}));
const key = Buffer.alloc(32, 5);
const ring = { current: { id: 'fixture', key }, all: new Map([['fixture', key]]) };
const originalFetch = globalThis.fetch;
const incoming = new Map<string, KfMessage[]>();
const sent: { open_kfid: string; touser: string; text: { content: string } }[] = [];
let cursor = 0;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'fixture-token', expires_in: 7200 });
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (url.includes('/kf/sync_msg')) {
    const messages = incoming.get(body.open_kfid) ?? [];
    incoming.delete(body.open_kfid);
    return Response.json({ errcode: 0, next_cursor: `cursor-${++cursor}`, has_more: 0, msg_list: messages });
  }
  if (url.includes('/kf/send_msg')) {
    sent.push(body);
    return Response.json({ errcode: 0, msgid: body.msgid });
  }
  if (url.includes('/kf/customer/batchget')) return Response.json({ errcode: 0, customer_list: [] });
  throw new Error(`未预期的网络请求：${new URL(url).pathname}`);
};
const query = async (sql: string, params: unknown[] = []) =>
  db.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return tx.query(sql, params);
  });
const idle = async () => {
  const deadline = Date.now() + 10_000;
  while (!tenants.every(({ rt }) => tenancy.withTenantScope(rt, wecom.__wecomTest.idle)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    tenants.every(({ rt }) => tenancy.withTenantScope(rt, wecom.__wecomTest.idle)),
    '入站处理必须在时限内完成',
  );
};
// 改动前的旅游字节，独立于实现与登记，防止两边一起改了而假通过。
const travel: Record<string, string> = {
  image: '图我收到了～不过我这边暂时看不了图片内容，您用文字说一下想去哪、几位出行，我马上给您找线路。',
  voice: '语音我这边暂时听不了，您打几个字给我就行～想去哪儿、几位出行、大概什么时候走？',
  video: '视频收到啦～您用文字说说想要什么样的行程，我这就帮您安排。',
  file: '文件我这边暂时打不开，方便的话把关键需求打字发我：目的地、几位、大概日期。',
  link: '链接收到～您想找类似的行程吗？跟我说下目的地和人数，我帮您对一条。',
  location: '位置收到～您是想从这边出发，还是想去这附近玩？跟我说下大概日期和人数。',
  other: '这条消息我这边暂时处理不了，您用文字说说想去哪儿、几位出行，我马上帮您安排～',
};
const placeholders: Record<string, string> = {
  image: '[图片]',
  voice: '[语音]',
  video: '[视频]',
  file: '[文件]',
  link: '[链接]',
  location: '[位置]',
  unknown: '[其他消息：unknown]',
  text: '[其他消息：text]',
};
try {
  for (const { rt, pack, account } of tenants) {
    tenancy.registerRuntime(rt);
    await tenancy.withTenantScope(rt, async () => {
      await testing.installSeededConfig(db, { slug: rt.slug });
      const fx = await testing.installPgSessionStore(db, { slug: rt.slug, varDir: dir });
      await store.initSessionStore(fx.deps);
      const runtime = runtimeById(pack, config.packSources())!;
      bindPack(runtime, pack === 'travel' ? null : runtime.defaultBrand);
      rt.config.loaded = {
        ...rt.config.loaded!,
        sop: { ...rt.config.loaded!.sop, brand: pack === 'travel' ? null : runtime.defaultBrand },
      };
      const sealed = sealSecrets(
        ring,
        { tenantId: rt.id, accountId: account },
        {
          appSecret: 'fixture-app-value',
          callbackToken: 'fixture-callback-value',
          callbackAesKey: 'fixture-aes-value',
        },
      );
      await query(
        `insert into channel_accounts
        (tenant_id,id,key,name,kind,status,id_prefix,corp_id,open_kfid,secrets_ct,secrets_key_id,settings)
        values ($1,$2,'main','非文字测试','wecom_kf','active','wecom:','fixture-corp',$3,decode($4,'hex'),$5,'{}')`,
        [rt.id, account, rt.slug, sealed.ct.toString('hex'), sealed.keyId],
      );
      await channels.initChannels({ ...fx.deps, keyRing: ring });
      assert.deepEqual((await store.drainStore(5000)).undrained, [], '切换共享连接角色前排空');
    });
  }
  channels.startChannels();
  await idle();
  let seq = 0;
  for (const [type, placeholder] of Object.entries(placeholders)) {
    const uid = `wmNT${seq++}`;
    for (const { rt, pack, account } of tenants) {
      const message: KfMessage = {
        msgid: `nt-${seq}`,
        external_userid: uid,
        open_kfid: rt.slug,
        send_time: Math.floor(Date.now() / 1000),
        origin: 3,
        msgtype: type,
      };
      incoming.set(rt.slug, [message]);
      await wecom.syncAccountFromCallback(account, 'fixture-sync');
      await idle();
      await tenancy.withTenantScope(rt, async () => {
        const session = store.getSession(`wecom:${uid}`)!;
        assert.ok(session, `${pack}/${type} 创建会话`);
        assert.equal(session.messages[0]?.content, placeholder);
        const reply = session.messages.at(-1)!;
        assert.equal(reply.role, 'agent');
        assert.equal(sent.at(-1)?.open_kfid, rt.slug);
        assert.equal(sent.at(-1)?.touser, uid);
        assert.equal(sent.at(-1)?.text.content, reply.content, '发送与占位后的记录一致');
        if (pack === 'travel') assert.equal(reply.content, Object.hasOwn(travel, type) ? travel[type] : travel.other);
        else if (pack === 'industrial') {
          assert.match(reply.content, /型号.*数量.*打字/);
          assert.doesNotMatch(reply.content, /旅行|行程|出行|目的地|线路/);
          const registered =
            config.currentPack().runtime.fixedReplies!.find((r) => r.id === `non-text.${type}`) ??
            config.currentPack().runtime.fixedReplies!.find((r) => r.id === 'non-text.other')!;
          const samples = await registered.samples();
          assert.equal(samples.length, 3);
          assert.ok(samples.every((s) => s.text === reply.content));
          const result = await industrialReplyGuard(config.packSources()).run({
            session,
            text: reply.content,
            inputText: '',
            policy: defaultIndustrialPolicy,
            toolSources: [],
            recordGuard: () => assert.fail('工业提示不应触发改写'),
          } as unknown as ReplyGuardContext);
          assert.equal(result?.action, 'pass');
          assert.ok(reply.content.length <= 600);
          assert.doesNotMatch(reply.content, /\*\*|^#{1,6}\s/m);
        } else assert.equal(reply.content, '这条消息我这边暂时处理不了，请用文字描述您的需求，我来帮您。');
        assert.deepEqual((await store.drainStore(5000)).undrained, []);
      });
      const before = sent.length;
      incoming.set(rt.slug, [message]);
      await wecom.syncAccountFromCallback(account, 'fixture-replay');
      await idle();
      assert.equal(sent.length, before, '重放同一消息不重发');
    }
  }
  for (const { rt, account } of tenants) {
    await tenancy.withTenantScope(rt, async () => {
      const session = store.getSession('wecom:wmNT0')!;
      session.handedOver = true;
      store.saveSession(session);
      assert.deepEqual((await store.drainStore(5000)).undrained, []);
    });
    const before = sent.length;
    incoming.set(rt.slug, [
      {
        msgid: 'nt-handoff',
        external_userid: 'wmNT0',
        open_kfid: rt.slug,
        send_time: Math.floor(Date.now() / 1000),
        origin: 3,
        msgtype: 'image',
      },
    ]);
    await wecom.syncAccountFromCallback(account, 'fixture-handoff');
    await idle();
    assert.equal(sent.length, before, '转人工后只记录占位，不自动回复');
    tenancy.withTenantScope(rt, () => assert.equal(store.getSession('wecom:wmNT0')!.messages.at(-1)!.content, '[图片]'));
  }
  console.log('WECOM NONTEXT SELFTEST PASS: 三租户 × 八类消息、旅游字节、工业护栏、缺省兜底、占位、重放去重、转人工静默');
} finally {
  for (const { rt } of tenants) tenancy.withTenantScope(rt, wecom.stopWecomAccounts);
  channels.__channelsTest.stopStatsRefresh();
  for (const { rt } of tenants) {
    await tenancy.withTenantScope(rt, async () => {
      assert.deepEqual((await store.drainStore(5000)).undrained, []);
      await rt.store.pgBackend?.close();
      await config.closeConfig();
    });
    state.dropTenantState(rt.id);
    tenancy.unregisterRuntime(rt.id);
  }
  await db.close();
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
