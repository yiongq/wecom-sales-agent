// 03 第 3 步：密钥环、凭据的认证加密、打印遮盖与日志字段脱敏；纯本机自测，不读部署密钥。
// 03 第 6 步：账号装载、企微状态与启动（文件末尾一节；PGlite，有 PG_TEST_URL 时另在真实 Postgres 上跑库的部分）。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { createCipheriv, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';
import { __logTest } from '../log.js';
import { ChannelKeyError, ChannelSecretError, Redacted, keyRingFromEnv, openSecrets, sealSecrets } from './secrets.js';
import type { KeyRing, WecomSecrets } from './secrets.js';

let pass = 0;
function check(name: string, fn: () => void): void {
  fn();
  pass++;
  console.log(`  ✔ ${name}`);
}

// 名称拼接：环境变量的完整名称只允许出现在凭据模块。
const envName = ['CHANNEL', 'SECRETS', 'KEY'].join('_');
const oldKey = Buffer.alloc(32, 7);
const newKey = Buffer.alloc(32, 8);
const thirdKey = Buffer.alloc(32, 9);
const base64 = oldKey.toString('base64');
const ringFrom = (value: string): KeyRing => keyRingFromEnv({ [envName]: value })!;
const oldRing = ringFrom(`old:${base64}`);
const newRing = ringFrom(`new:${newKey.toString('base64')}`);
const rotated = ringFrom(`new:${newKey.toString('base64')},old:${base64},third:${thirdKey.toString('base64')}`);

check('密钥环：未设、空串返回 null', () => {
  assert.equal(keyRingFromEnv({}), null);
  assert.equal(keyRingFromEnv({ [envName]: undefined }), null);
  assert.equal(keyRingFromEnv({ [envName]: '' }), null);
});
check('密钥环：一把、三把，顺序决定 current，all 保留全部', () => {
  assert.equal(oldRing.current.id, 'old');
  assert.deepEqual(oldRing.current.key, oldKey);
  assert.equal(oldRing.all.size, 1);
  assert.deepEqual([...rotated.all.keys()], ['new', 'old', 'third']);
  assert.equal(rotated.current.id, 'new');
  assert.deepEqual(rotated.current.key, newKey);
  assert.deepEqual(rotated.all.get('old'), oldKey);
  assert.deepEqual(rotated.all.get('third'), thirdKey);
});
check('密钥环：id 边界与可省略的 base64 填充', () => {
  const id = 'A_-' + 'z'.repeat(29);
  assert.equal(ringFrom(`${id}:${base64.replace(/=+$/, '')}`).current.id, id);
});

const keyErrors: ChannelKeyError[] = [];
for (const [name, value, item, reason] of [
  ['缺冒号', base64, 1, '缺少冒号'],
  ['空 id', `:${base64}`, 1, 'id 无效'],
  ['非法 id', `bad id:${base64}`, 1, 'id 无效'],
  ['过长 id', `${'a'.repeat(33)}:${base64}`, 1, 'id 无效'],
  ['密钥为空', 'old:', 1, '32 字节'],
  ['31 字节', `old:${Buffer.alloc(31, 7).toString('base64')}`, 1, '32 字节'],
  ['33 字节', `old:${Buffer.alloc(33, 7).toString('base64')}`, 1, '32 字节'],
  ['base64 非法字符', `old:${base64.slice(0, -1)}!`, 1, 'base64 无效'],
  ['base64 空白', `old:${base64}\n`, 1, 'base64 无效'],
  ['base64 多余填充', `old:${base64}=`, 1, 'base64 无效'],
  ['base64 不规范填充位', `old:${base64.slice(0, -2)}d=`, 1, 'base64 无效'],
  ['base64 长度无效', 'old:A', 1, 'base64 无效'],
  ['多冒号', `old::${base64}`, 1, 'base64 无效'],
  ['重复 id', `old:${base64},old:${newKey.toString('base64')}`, 2, 'id 重复'],
  ['第二项缺冒号', `old:${base64},${base64}`, 2, '缺少冒号'],
  ['末尾空项', `old:${base64},`, 2, '缺少冒号'],
] as const) {
  check(`密钥环拒绝：${name}，错误不含密钥片段`, () => {
    assert.throws(
      () => ringFrom(value),
      (error: unknown) => {
        assert.ok(error instanceof ChannelKeyError);
        assert.equal(error.name, 'ChannelKeyError');
        assert.ok(error.message.includes(`第 ${item} 项`));
        assert.ok(error.message.includes(reason));
        for (const key of [oldKey, newKey, thirdKey]) {
          assert.ok(!error.message.includes(key.toString('base64').slice(0, 8)));
        }
        keyErrors.push(error);
        return true;
      },
    );
  });
}

const aad = { tenantId: 'tenant-a', accountId: 'account-a' };
const secrets: WecomSecrets = {
  appSecret: 'selftest-app-value',
  callbackToken: 'selftest-callback-value',
  callbackAesKey: 'selftest-aes-value',
};
const sealed = sealSecrets(oldRing, aad, secrets);
const ciphertexts = [sealed.ct];
check('认证加密：三项 JSON 一次往返，12 字节 nonce 与 16 字节 tag', () => {
  assert.equal(sealed.keyId, 'old');
  assert.equal(sealed.ct.length, 12 + Buffer.byteLength(JSON.stringify(secrets)) + 16);
  const opened = openSecrets(oldRing, aad, sealed.ct, sealed.keyId);
  assert.ok(opened instanceof Redacted);
  assert.deepEqual(opened.reveal(), secrets);
  assert.notDeepEqual(sealSecrets(oldRing, aad, secrets).ct.subarray(0, 12), sealed.ct.subarray(0, 12));
});

const secretErrors: ChannelSecretError[] = [];
function rejects(name: string, ring: KeyRing, binding: typeof aad, ct: Buffer, keyId: string, reason: string): void {
  ciphertexts.push(ct);
  check(name, () => {
    assert.throws(
      () => openSecrets(ring, binding, ct, keyId),
      (error: unknown) => {
        assert.ok(error instanceof ChannelSecretError);
        assert.equal(error.name, 'ChannelSecretError');
        assert.equal(error.keyId, keyId);
        assert.equal(error.message, `渠道凭据 ${keyId}：${reason}`);
        assert.ok(!('cause' in error));
        secretErrors.push(error);
        return true;
      },
    );
  });
}
for (const [part, index] of [
  ['nonce', 0],
  ['密文', 12],
  ['tag', sealed.ct.length - 1],
] as const) {
  const changed = Buffer.from(sealed.ct);
  changed[index] ^= 1;
  rejects(`认证拒绝：篡改 ${part} 一个字节`, oldRing, aad, changed, 'old', '认证失败');
}
rejects('AAD 拒绝：换账号', oldRing, { ...aad, accountId: 'account-b' }, sealed.ct, 'old', '认证失败');
rejects('AAD 拒绝：换租户', oldRing, { ...aad, tenantId: 'tenant-b' }, sealed.ct, 'old', '认证失败');
rejects('密钥拒绝：未知 key id', oldRing, aad, sealed.ct, 'missing', '密钥不存在');
const wrongRing = ringFrom(`old:${newKey.toString('base64')}`);
rejects('密钥拒绝：同 id 换密钥', wrongRing, aad, sealed.ct, 'old', '认证失败');
for (const length of [0, 11, 12, 27]) {
  rejects(`格式拒绝：密文长度 ${length}`, oldRing, aad, sealed.ct.subarray(0, length), 'old', '密文长度不足');
}

// 手工造已认证的载荷：覆盖不能只靠损坏 tag 测出的 JSON/字段边界，并独立核对 AAD 格式。
function encryptPayload(plaintext: string): Buffer {
  const nonce = Buffer.alloc(12, 1);
  const cipher = createCipheriv('aes-256-gcm', oldKey, nonce);
  cipher.setAAD(Buffer.from(`channel_accounts:v1:${aad.tenantId}:${aad.accountId}`));
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
rejects('格式拒绝：已认证但 JSON 无效', oldRing, aad, encryptPayload(secrets.appSecret), 'old', 'JSON 无效');
for (const [index, payload] of [
  null,
  [],
  'text',
  42,
  {},
  { ...secrets, appSecret: null },
  { ...secrets, callbackToken: 7 },
  { ...secrets, callbackAesKey: [] },
].entries()) {
  rejects(`格式拒绝：凭据字段无效（第 ${index + 1} 种）`, oldRing, aad, encryptPayload(JSON.stringify(payload)), 'old', '凭据字段无效');
}
for (const field of Object.keys(secrets)) {
  const payload: Record<string, string> = { ...secrets };
  delete payload[field];
  rejects(`格式拒绝：缺少 ${field}`, oldRing, aad, encryptPayload(JSON.stringify(payload)), 'old', '凭据字段无效');
}
check('独立载荷：AAD 格式正确、空字符串字段仍合法', () => {
  const empty = { appSecret: '', callbackToken: '', callbackAesKey: '' };
  assert.deepEqual(openSecrets(oldRing, aad, encryptPayload(JSON.stringify(empty)), 'old').reveal(), empty);
});
check('轮换：新钥在前仍能解旧密文，rekey 后只留新钥能解', () => {
  assert.deepEqual(openSecrets(rotated, aad, sealed.ct, 'old').reveal(), secrets);
  const rekeyed = sealSecrets(rotated, aad, openSecrets(rotated, aad, sealed.ct, 'old').reveal());
  assert.equal(rekeyed.keyId, 'new');
  assert.deepEqual(openSecrets(newRing, aad, rekeyed.ct, rekeyed.keyId).reveal(), secrets);
});
rejects('轮换：只留新钥解不开旧密文', newRing, aad, sealed.ct, 'old', '密钥不存在');

check('Redacted：JSON、inspect（对象与深层）、模板、String 与 console.log 都遮盖，reveal 保留原值', () => {
  for (const value of [secrets.appSecret, secrets, Buffer.from(secrets.appSecret)]) {
    const r = new Redacted(value);
    assert.equal(r.reveal(), value);
    assert.equal(JSON.stringify(r), '"[已遮盖]"');
    assert.equal(JSON.stringify({ a: r }), '{"a":"[已遮盖]"}');
    assert.equal(inspect(r), '[已遮盖]');
    assert.equal(inspect({ a: r }), '{ a: [已遮盖] }');
    const deep = { a: { b: { c: { d: { e: r } } } } };
    for (const options of [{ depth: null }, { depth: null, showHidden: true }, { customInspect: false, showHidden: true }]) {
      const out = inspect(deep, options);
      assert.ok(!out.includes(secrets.appSecret));
      if (options.customInspect !== false) assert.ok(out.includes('[已遮盖]'));
    }
    assert.equal(`${r}`, '[已遮盖]');
    assert.equal(String(r), '[已遮盖]');
    assert.equal(r.toString(), '[已遮盖]');
    assert.equal(r[Symbol.toPrimitive](), '[已遮盖]');
    assert.deepEqual(Object.keys(r), []);
    let output = '';
    new Console(
      new Writable({
        write(chunk, _encoding, done) {
          output += String(chunk);
          done();
        },
      }),
    ).log(r);
    assert.equal(output, '[已遮盖]\n');
  }
});
check('异常打印：inspect / JSON 不含明文、密文 base64/hex/Buffer JSON 或密钥', () => {
  const forbidden = [
    ...Object.values(secrets),
    ...[oldKey, newKey, thirdKey].flatMap((k) => [k.toString('base64'), k.toString('hex'), k.toString('base64').slice(0, 8)]),
    ...ciphertexts.filter((ct) => ct.length >= 28).flatMap((ct) => [ct.toString('base64'), ct.toString('hex'), JSON.stringify(ct)]),
  ];
  for (const error of [...keyErrors, ...secretErrors]) {
    for (const output of [inspect(error, { depth: null, showHidden: true }), JSON.stringify(error)]) {
      for (const value of forbidden) assert.ok(!output.includes(value));
    }
  }
});

const fields = ['appSecret', 'callbackToken', 'callbackAesKey', 'secrets', 'secretsCt', 'secrets_ct'];
for (const field of fields) {
  check(`日志脱敏：${field} 的 pino 路径、JSON 输出与任意深度兜底`, () => {
    for (const prefix of ['', '*.', '*.*.']) assert.ok(__logTest.REDACT_PATHS.includes(prefix + field));
    for (const value of ['selftest-log-value', secrets, sealed.ct]) {
      const obj = { [field]: value, a: { [field]: value, b: { [field]: value } }, keep: 'visible' };
      let line = '';
      __logTest
        .createJsonLogger({
          write(chunk: string) {
            line += chunk;
          },
        })
        .info(obj, 'channels');
      const parsed = JSON.parse(line);
      assert.equal(parsed[field], '[已遮盖]');
      assert.equal(parsed.a[field], '[已遮盖]');
      assert.equal(parsed.a.b[field], '[已遮盖]');
      assert.equal(parsed.keep, 'visible');
    }
    const deep = { a: { b: { c: { d: [{ [field.toUpperCase()]: 'selftest-log-"value\\' }] } } }, keep: 'visible-deep' };
    const output = __logTest.scrubLine(JSON.stringify(deep));
    assert.ok(!output.includes('selftest-log-'));
    assert.equal(JSON.parse(output).a.b.c.d[0][field.toUpperCase()], '[已遮盖]');
    assert.equal(JSON.parse(output).keep, 'visible-deep');
  });
}

// ================ 03 第 6 步：账号装载、企微状态与启动 ================
// 三种企微状态（与文件存储）各走哪条路；六个拒绝原因各一例，拒绝之后没有半装载（账号表与注册表为空、var/ 里没多也没少文件、
// 账号行与 cursor 没动、env 的老路没退场）；channel_decrypt 的 detail 只有账号 key、key id 与失败类别；全部停用时照常起、哨兵留着，
// 启用之后再起被 channel_restore_pending 拦住；欢迎语不合格按没设处理并告警；web_channel 关着时网页账号带 inactiveReason；
// accountForSession 的前缀最长匹配与默认账号；/healthz 的 channels 形状；boot 的顺序与拒绝分支。库的部分在 PGlite 上跑，
// 有 PG_TEST_URL 时在真实 Postgres 上再跑一遍（以 agent_app 身份、受 RLS 约束）。整段拦 stdout、stderr，最后扫凭据明文、
// 密文（base64、hex、Buffer 的 JSON）与企微标识。
const varRoot = fs.mkdtempSync(path.join(process.env.VAR_DIR ?? os.tmpdir(), 'wecom-channels-selftest-'));
process.env.VAR_DIR = varRoot;
process.on('exit', () => fs.rmSync(varRoot, { recursive: true, force: true }));
// 引擎连带读开发机的 .env：CONFIG_SOURCE、告警地址、企微凭据写在那里也不能影响这组（空串挡得住，见 selftest-env.ts）
process.env.CONFIG_SOURCE = 'file';
process.env.ALERT_WEBHOOK_URL = '';
const ENV_WECOM = {
  WECOM_CORP_ID: 'corp6envtest',
  WECOM_APP_SECRET: 'selftest6-env-app-value',
  WECOM_KF_OPEN_KFID: 'kfid6envtest',
  WECOM_CALLBACK_TOKEN: 'selftest6-env-token-value',
  WECOM_CALLBACK_AES_KEY: 'selftest6-env-aes-value',
  WECOM_POLL_INTERVAL_MS: '60000',
};
const setWecomEnv = (on: boolean): void => {
  for (const [k, v] of Object.entries(ENV_WECOM)) process.env[k] = on ? v : '';
};
setWecomEnv(false);

let captured = '';
for (const stream of [process.stdout, process.stderr]) {
  const orig = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    return orig(chunk, ...rest);
  }) as typeof stream.write;
}

const {
  initChannels,
  startChannels,
  channelsHealth,
  channelsMode,
  loadedChannels,
  channelStartupWarnings,
  wecomState,
  channelKeyRing,
  ChannelStartupError,
  __channelsTest,
} = await import('./registry.js');
const { accountByKey, accountForSession, checkWelcomeText, loadedAccounts, ENV_ACCOUNT_ID, WEB_CHANNEL_OFF_REASON } =
  await import('./accounts.js');
const { CHANNELS_IN_DB_MARKER, RESTORE_SENTINEL, WECOM_STATE_FILE, readChannelsMarker } = await import('./markers.js');
const { createRealPgFixture, openTestDb } = await import('../db/testing.js');
const { openDb } = await import('../db/client.js');
const wecomMod = await import('../adapters/wecom.js');
const { __profileTest } = await import('../profile.js');
const { boot } = await import('../boot.js');
type Db = import('../db/client.js').Db;
type ChannelDeps = import('./registry.js').ChannelDeps;
type StartupError = InstanceType<typeof ChannelStartupError>;

async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  pass++;
  console.log(`  ✔ ${name}`);
}

const CORP = 'corp6test';
const SECRETS6: WecomSecrets = {
  appSecret: 'selftest6-app-value',
  callbackToken: 'selftest6-callback-value',
  callbackAesKey: 'selftest6-aes-value',
};
const cts6: Buffer[] = [];
const kfids = new Set<string>([ENV_WECOM.WECOM_KF_OPEN_KFID]);
const forbidden6 = (): string[] => [
  ...Object.values(SECRETS6),
  ENV_WECOM.WECOM_APP_SECRET,
  ENV_WECOM.WECOM_CALLBACK_TOKEN,
  ENV_WECOM.WECOM_CALLBACK_AES_KEY,
  CORP,
  ENV_WECOM.WECOM_CORP_ID,
  ...kfids,
  ...cts6.flatMap((ct) => [ct.toString('base64'), ct.toString('hex'), JSON.stringify(ct), ct.subarray(12, 28).toString('base64')]),
];
const noSecretIn = (text: string, where: string): void => {
  for (const v of forbidden6()) assert.ok(!text.includes(v), `${where} 里出现了凭据、密文或企微标识`);
};

interface Harness {
  label: string;
  pglite: boolean;
  db: Db;
  /** 以超级用户执行一条 SQL（建租户、造行、改行） */
  su<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R[]>;
}
interface Tenant {
  id: string;
  slug: string;
}

let tenantSeq = 0;
async function newTenant(h: Harness): Promise<Tenant> {
  const slug = `ch6-${++tenantSeq}`;
  const [row] = await h.su<{ id: string }>(`insert into tenants (slug, name, pack_id) values ($1, $1, 'travel') returning id`, [slug]);
  return { id: row!.id, slug };
}

/** 库里一个企微账号：id 先在这边生成（AAD 要用），凭据用 oldRing 加密 */
async function addWecom(
  h: Harness,
  tenantId: string,
  key: string,
  o: { prefix?: string; status?: string; cursor?: string | null; settings?: Record<string, unknown> } = {},
): Promise<string> {
  const id = randomUUID();
  const kf = `kfid6${key.replaceAll('-', '')}`;
  kfids.add(kf);
  const { ct, keyId } = sealSecrets(oldRing, { tenantId, accountId: id }, SECRETS6);
  cts6.push(ct);
  await h.su(
    `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id, cursor, settings)
     values ($1, $2, $3, 'wecom_kf', $3, $4, $5, $6, $7, decode($8, 'hex'), $9, $10, $11::json)`,
    [
      tenantId,
      id,
      key,
      o.status ?? 'active',
      o.prefix ?? 'wecom:',
      CORP,
      kf,
      ct.toString('hex'),
      keyId,
      o.cursor ?? null,
      JSON.stringify(o.settings ?? {}),
    ],
  );
  return id;
}

async function addWeb(
  h: Harness,
  tenantId: string,
  key: string,
  settings: Record<string, unknown> = { title: '网页咨询' },
): Promise<string> {
  const id = randomUUID();
  await h.su(`insert into channel_accounts (tenant_id, id, key, kind, name, settings) values ($1, $2, $3, 'web', $3, $4::json)`, [
    tenantId,
    id,
    key,
    JSON.stringify(settings),
  ]);
  return id;
}

const freshVar = (): string => fs.mkdtempSync(path.join(varRoot, 'v-'));
const writeSentinel = (dir: string): void =>
  fs.writeFileSync(path.join(dir, RESTORE_SENTINEL), '{"backupAt":"2026-10-09T00:00:00.000Z"}\n');
/** var/ 里每个文件的内容（子目录记成 dir）：拒绝之后应与之前全等——标记没写、哨兵没删、wecom-cursor.json 没动 */
const snapshotDir = (dir: string): Record<string, string> =>
  Object.fromEntries(
    fs.readdirSync(dir).map((f) => {
      const p = path.join(dir, f);
      return [f, fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : 'dir'];
    }),
  );
const accountRows = (h: Harness, tenantId: string): Promise<unknown[]> =>
  h.su(
    `select key, status, cursor, cursor_at, encode(secrets_ct, 'hex') as ct, secrets_key_id, settings::text as settings, updated_at
       from channel_accounts where tenant_id = $1 order by key`,
    [tenantId],
  );

async function tryInit(deps: ChannelDeps | null): Promise<{ err: StartupError | null; out: string }> {
  __channelsTest.reset();
  const from = captured.length;
  let err: StartupError | null = null;
  try {
    await initChannels(deps);
  } catch (e) {
    if (!(e instanceof ChannelStartupError)) throw e;
    err = e;
  }
  return { err, out: captured.slice(from) };
}

/** 拒绝之后：账号表、注册表为空，企微状态没装上，env 的老路没退场，var/ 与账号行都没动 */
async function expectReject(reason: string, deps: ChannelDeps | null, rows?: { h: Harness; tenantId: string }): Promise<StartupError> {
  const dir = deps?.varDir ?? varRoot;
  const filesBefore = snapshotDir(dir);
  const rowsBefore = rows ? JSON.stringify(await accountRows(rows.h, rows.tenantId)) : '';
  const r = await tryInit(deps);
  assert.ok(r.err, `应以 ${reason} 拒绝`);
  assert.equal(r.err.reason, reason, r.err.detail);
  assert.equal(loadedAccounts().length, 0, '账号表应为空');
  assert.equal(loadedChannels().size, 0, '注册表应为空');
  assert.equal(wecomState(), null);
  assert.equal(channelsMode(), 'env');
  assert.deepEqual(channelsHealth(), { mode: 'env', accounts: 0, failing: 0, stuck: 0 });
  assert.equal(wecomMod.isWecomEnabled(), Boolean(process.env.WECOM_CORP_ID), 'env 的老路照旧（没退场）');
  assert.deepEqual(snapshotDir(dir), filesBefore, 'var/ 里的文件没动（标记没写、哨兵没删、cursor 文件没改）');
  if (rows) assert.equal(JSON.stringify(await accountRows(rows.h, rows.tenantId)), rowsBefore, '账号行没动（cursor 不变）');
  assert.ok(!/\[channels\] 企微状态/.test(r.out), '拒绝时不打装载成功的日志');
  noSecretIn(r.err.detail, 'detail');
  return r.err;
}

// ---------------- 纯函数：欢迎语检查、密钥环 ----------------

check('欢迎语检查（R19）：现在的两段欢迎语常量都合格（不设时 demo 逐字节不变）', () => {
  assert.equal(checkWelcomeText(wecomMod.__test.WELCOME_TEXT), null);
  assert.equal(checkWelcomeText(wecomMod.__test.WELCOME_BACK_TEXT), null);
  assert.equal(checkWelcomeText('您好，我是云途的 AI 旅行顾问。需要真人服务时回复「人工」。'), null);
});
check('欢迎语检查（R19）：第一句没有「AI」、没有转人工的说法、只有「人工智能」、不是文字、为空都不合格', () => {
  for (const [text, why] of [
    ['您好，欢迎光临云途。我是 AI 旅行顾问，回复「人工」转真人顾问', '第一句没有「AI」'],
    ['Hi! 我是 AI 旅行顾问，回复「人工」转真人', '第一句到半角叹号为止'],
    ['您好，我是 AI 旅行顾问，有问题尽管问', '没有转人工的说法'],
    ['您好，我是 AI 旅行顾问，背后是人工智能', '只有「人工智能」不算'],
    ['', '空串'],
    ['   \n ', '只有空白'],
    [42, '不是文字'],
    [null, 'null'],
  ] as const) {
    const reason = checkWelcomeText(text);
    assert.ok(reason !== null, why);
    assert.ok(typeof text !== 'string' || !text.trim() || !reason.includes(text), `${why}：原因里不带原文`);
  }
});
check('拒绝 channel_key_invalid：密钥环格式不对，detail 只说第几项哪里不对，不带值；没设为 null', () => {
  const short = Buffer.alloc(31, 7).toString('base64');
  assert.throws(
    () => channelKeyRing({ [envName]: `old:${base64},k2:${short}` }),
    (e: unknown) =>
      e instanceof ChannelStartupError &&
      e.reason === 'channel_key_invalid' &&
      e.detail.includes('第 2 项') &&
      !e.detail.includes(short.slice(0, 8)) &&
      !e.detail.includes(base64.slice(0, 8)),
  );
  assert.equal(channelKeyRing({}), null);
  assert.equal(channelKeyRing({ [envName]: `old:${base64}` })?.current.id, 'old');
});

// ---------------- 文件存储（deps 为 null，var/ 是 store 的 VAR_DIR） ----------------

await acheck('文件存储：WECOM_* 没配齐时不起企微；配齐时拼 env 账号（id、key 固定，前缀 wecom:）；恢复哨兵记一行并删掉', async () => {
  setWecomEnv(false);
  let r = await tryInit(null);
  assert.equal(r.err, null);
  assert.equal(wecomState(), 'file');
  assert.deepEqual(channelsHealth(), { mode: 'env', accounts: 0, failing: 0, stuck: 0 });
  assert.match(r.out, /\[channels\] 文件存储：WECOM_\* 没配齐，不起企微/);
  setWecomEnv(true);
  writeSentinel(varRoot);
  r = await tryInit(null);
  assert.equal(r.err, null);
  const a = accountForSession('wecom:wm6file');
  assert.equal(a?.id, ENV_ACCOUNT_ID);
  assert.equal(a?.key, 'env');
  assert.equal(a?.source, 'env');
  assert.equal(a?.tenantId, '');
  assert.equal(a?.wecom?.idPrefix, 'wecom:');
  assert.equal(a?.wecom?.settings.pollIntervalMs, 60000);
  assert.equal(accountByKey('env', 'wecom_kf')?.id, ENV_ACCOUNT_ID);
  assert.equal(accountByKey('env', 'web'), undefined);
  assert.equal(accountForSession('sim-abc'), undefined);
  assert.deepEqual(channelsHealth(), { mode: 'env', accounts: 1, failing: 0, stuck: 0 });
  assert.ok(wecomMod.isWecomEnabled());
  assert.ok(!fs.existsSync(path.join(varRoot, RESTORE_SENTINEL)), '哨兵删了');
  assert.ok(!fs.existsSync(path.join(varRoot, CHANNELS_IN_DB_MARKER)), '文件存储不写标记');
  assert.match(r.out, /\[channels\] 文件存储：企微走 env 账号/);
  assert.match(r.out, /有恢复哨兵 restored-from-backup\.json：企微状态在文件存储下，渠道状态在文件里、恢复照 02，已删掉/);
});
await acheck('拒绝 channel_state_in_db（文件存储下 var/ 有 channels-in-db.json）：不留半装载', async () => {
  fs.writeFileSync(path.join(varRoot, CHANNELS_IN_DB_MARKER), '{"tenant":"demo","account":"kf-main","at":"2026-10-09T00:00:00.000Z"}\n');
  const e = await expectReject('channel_state_in_db', null);
  assert.match(e.detail, /channel-export/);
  fs.rmSync(path.join(varRoot, CHANNELS_IN_DB_MARKER));
});

// ---------------- db 存储：PGlite 与真实 PG 各跑一遍 ----------------

async function dbScenarios(h: Harness): Promise<void> {
  const L = (s: string): string => `${h.label}：${s}`;
  const deps = (t: Tenant, varDir: string, keyRing: KeyRing | null = oldRing): ChannelDeps => ({
    db: h.db,
    tenantId: t.id,
    tenantSlug: t.slug,
    varDir,
    keyRing,
  });

  await acheck(L('未导入：照 02 走 env 账号；库里的网页账号照常装上；恢复哨兵记一行并删掉；不写标记'), async () => {
    setWecomEnv(true);
    const t = await newTenant(h);
    const webId = await addWeb(h, t.id, 'web6');
    const dir = freshVar();
    writeSentinel(dir);
    const r = await tryInit(deps(t, dir, null));
    assert.equal(r.err, null, r.err?.detail);
    assert.equal(wecomState(), 'not_imported');
    assert.equal(channelsMode(), 'env');
    const env = accountForSession('wecom:wm6notimp');
    assert.equal(env?.id, ENV_ACCOUNT_ID);
    assert.equal(env?.source, 'env');
    assert.equal(env?.tenantId, t.id);
    assert.equal(accountByKey('web6', 'web')?.id, webId);
    assert.equal(accountForSession(`web:${'a'.repeat(32)}`, { channelAccountId: webId })?.key, 'web6');
    assert.deepEqual(channelsHealth(), { mode: 'env', accounts: 2, failing: 0, stuck: 0 });
    assert.ok(wecomMod.isWecomEnabled(), 'env 的老路照旧');
    assert.ok(!fs.existsSync(path.join(dir, RESTORE_SENTINEL)), '哨兵删了');
    assert.ok(!fs.existsSync(path.join(dir, CHANNELS_IN_DB_MARKER)), '不写标记');
    assert.match(r.out, /\[channels\] 企微状态：未导入（库里没有企微账号），照 02 走 env 账号与 var\/wecom-cursor\.json\n/);
    assert.match(r.out, /有恢复哨兵 restored-from-backup\.json：企微状态未导入，渠道状态在文件里、恢复照 02，已删掉/);
  });

  await acheck(L('已导出：照 02 走 env 账号（库里那一行不装）；WECOM_* 没配齐时不起企微'), async () => {
    setWecomEnv(false);
    const t = await newTenant(h);
    await addWecom(h, t.id, 'kf-main', { status: 'exported' });
    const r = await tryInit(deps(t, freshVar()));
    assert.equal(r.err, null, r.err?.detail);
    assert.equal(wecomState(), 'exported');
    assert.equal(channelsMode(), 'env');
    assert.equal(loadedAccounts().length, 0);
    assert.equal(accountForSession('wecom:wm6exp'), undefined);
    assert.match(
      r.out,
      /企微状态：已导出（默认账号 kf-main 是 exported），照 02 走 env 账号与 var\/wecom-cursor\.json；WECOM_\* 没配齐，不起企微/,
    );
  });

  await acheck(
    L('在库里：只用库里的账号、env 的 WECOM_* 忽略（日志只点名）、补写标记、读出没结束的入站与没结果的出站、前缀最长匹配'),
    async () => {
      setWecomEnv(true);
      const t = await newTenant(h);
      const main = await addWecom(h, t.id, 'kf-main', { cursor: 'c6-main' });
      const two = await addWecom(h, t.id, 'kf-two', { prefix: 'wecom:kf-two:' });
      const off = await addWecom(h, t.id, 'kf-off', { prefix: 'wecom:kf-off:', status: 'disabled' });
      const web = await addWeb(h, t.id, 'web6');
      await h.su(
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, payload) values
           ($1, $2, 'in6-open', 'message', 'wecom:wm6main', 'received', '{"text":"x"}'::json),
           ($1, $2, 'in6-done', 'message', 'wecom:wm6main', 'done', null),
           ($1, $3, 'in6-two', 'message', 'wecom:kf-two:wm6two', 'recorded', '{"text":"y"}'::json)`,
        [t.id, main, two],
      );
      await h.su(
        `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status, account_id, segment, payload) values
           ($1, 'wecom:wm6main', 'o6-legacy', 'notice', now(), 'pending', null, 0, '{"text":"a"}'::json),
           ($1, 'wecom:wm6main', 'o6-main', 'ai', now(), 'sending', $2, 1, '{"text":"b"}'::json),
           ($1, 'wecom:kf-two:wm6two', 'o6-two', 'ai', now(), 'pending', $3, 0, '{"text":"c"}'::json),
           ($1, 'wecom:wm6main', 'o6-done', 'ai', now(), 'accepted', $2, 0, null)`,
        [t.id, main, two],
      );
      const dir = freshVar();
      const r = await tryInit(deps(t, dir));
      assert.equal(r.err, null, r.err?.detail);
      assert.equal(wecomState(), 'in_db');
      assert.equal(channelsMode(), 'db');
      assert.ok(!wecomMod.isWecomEnabled(), 'env 的 WECOM_* 配齐也不再读');
      const m = readChannelsMarker(dir);
      assert.equal(m?.tenant, t.slug);
      assert.equal(m?.account, 'kf-main');
      assert.ok(!Number.isNaN(Date.parse(m!.at)));
      assert.match(
        r.out,
        /忽略 env 里的 WECOM_APP_SECRET、WECOM_CALLBACK_AES_KEY、WECOM_CALLBACK_TOKEN、WECOM_CORP_ID、WECOM_KF_OPEN_KFID、WECOM_POLL_INTERVAL_MS（不读取）/,
      );
      assert.match(r.out, /\[channels\] 企微状态：在库里（企微账号 3 个，启用 2 个），只用库里的账号/);
      assert.match(r.out, /补写了 channels-in-db\.json/);
      assert.equal(accountForSession('wecom:wm6main')?.id, main);
      assert.equal(accountForSession('wecom:kf-two:wm6two')?.id, two);
      assert.equal(accountForSession('wecom:kf-off:wm6off')?.id, off, '停用账号的会话不落到默认账号上');
      assert.equal(accountForSession('wecom:kf-off:wm6off')?.status, 'disabled');
      assert.equal(accountForSession(`web:${'b'.repeat(32)}`, { channelAccountId: web })?.id, web);
      assert.equal(accountForSession(`web:${'b'.repeat(32)}`), undefined);
      assert.equal(accountByKey('kf-two', 'wecom_kf')?.id, two);
      assert.equal(accountByKey('kf-off', 'wecom_kf'), undefined, '停用的不返回');
      assert.equal(accountByKey('web6', 'wecom_kf'), undefined, '种类对不上不返回');
      assert.equal(accountByKey('kf-main', 'web'), undefined);
      assert.equal(accountByKey('env', 'wecom_kf'), undefined, '在库里时没有 env 账号');
      const ch = loadedChannels();
      assert.deepEqual([...ch.keys()].toSorted(), [main, two, web].toSorted());
      assert.deepEqual(ch.get(main)!.secrets!.reveal(), SECRETS6);
      assert.equal(String(ch.get(main)!.secrets), '[已遮盖]');
      assert.equal(ch.get(main)!.cursor, 'c6-main');
      assert.equal(ch.get(two)!.cursor, null);
      assert.deepEqual(
        ch.get(main)!.openInbox.map((x) => x.msgid),
        ['in6-open'],
      );
      assert.deepEqual(
        ch.get(two)!.openInbox.map((x) => x.msgid),
        ['in6-two'],
      );
      assert.deepEqual(
        ch
          .get(main)!
          .openOutbound.map((x) => x.channelMsgid)
          .toSorted(),
        ['o6-legacy', 'o6-main'],
      );
      assert.deepEqual(
        ch.get(two)!.openOutbound.map((x) => x.channelMsgid),
        ['o6-two'],
      );
      assert.equal(ch.get(web)!.secrets, null);
      assert.deepEqual(channelsHealth(), { mode: 'db', accounts: 3, failing: 0, stuck: 0 });
      startChannels(); // 两个企微账号都有没结束的入站与出站行：起运行时、先做启动恢复（这里没装会话存储，读不到入站、不拉取），不抛、不写 var/wecom-cursor.json
      assert.ok(!fs.existsSync(wecomMod.__test.STATE_FILE));
      if (h.pglite) await healthzAndCallback();
    },
  );

  await acheck(L('拒绝 channel_key_missing：有启用的企微账号而没有密钥环；不留半装载'), async () => {
    setWecomEnv(true);
    const t = await newTenant(h);
    await addWecom(h, t.id, 'kf-main', { cursor: 'c6-keep' });
    const e = await expectReject('channel_key_missing', deps(t, freshVar(), null), { h, tenantId: t.id });
    assert.match(e.detail, /kf-main/);
  });

  await acheck(
    L('拒绝 channel_decrypt（密文换到别的行、改一个字节、同 id 换密钥、key id 不在环里）：detail 只有账号 key、key id 与失败类别'),
    async () => {
      setWecomEnv(false);
      const swapped = await newTenant(h);
      const a = await addWecom(h, swapped.id, 'kf-main', { cursor: 'c6-keep' });
      const b = await addWecom(h, swapped.id, 'kf-two', { prefix: 'wecom:kf-two:' });
      await h.su(
        `update channel_accounts set secrets_ct = (select secrets_ct from channel_accounts where tenant_id = $1 and id = $2)
        where tenant_id = $1 and id = $3`,
        [swapped.id, a, b],
      );
      let e = await expectReject('channel_decrypt', deps(swapped, freshVar()), { h, tenantId: swapped.id });
      assert.match(e.detail, /^账号 kf-two 的凭据解不开（渠道凭据 old：认证失败）/);

      const flipped = await newTenant(h);
      const c = await addWecom(h, flipped.id, 'kf-main', { cursor: 'c6-keep' });
      await h.su(
        `update channel_accounts set secrets_ct = set_byte(secrets_ct, 20, get_byte(secrets_ct, 20) # 1) where tenant_id = $1 and id = $2`,
        [flipped.id, c],
      );
      e = await expectReject('channel_decrypt', deps(flipped, freshVar()), { h, tenantId: flipped.id });
      assert.match(e.detail, /^账号 kf-main 的凭据解不开（渠道凭据 old：认证失败）/);

      const t = await newTenant(h);
      await addWecom(h, t.id, 'kf-main', { cursor: 'c6-keep' });
      e = await expectReject('channel_decrypt', deps(t, freshVar(), wrongRing), { h, tenantId: t.id });
      assert.match(e.detail, /^账号 kf-main 的凭据解不开（渠道凭据 old：认证失败）/);
      e = await expectReject('channel_decrypt', deps(t, freshVar(), newRing), { h, tenantId: t.id });
      assert.match(e.detail, /^账号 kf-main 的凭据解不开（渠道凭据 old：密钥不存在）/);
    },
  );

  await acheck(L('拒绝 channel_restore_pending：有恢复哨兵而有启用的企微账号；哨兵留着、不留半装载'), async () => {
    const t = await newTenant(h);
    await addWecom(h, t.id, 'kf-main', { cursor: 'c6-keep' });
    const dir = freshVar();
    writeSentinel(dir);
    const e = await expectReject('channel_restore_pending', deps(t, dir), { h, tenantId: t.id });
    assert.match(e.detail, /restore-cutoff/);
  });

  await acheck(L('拒绝 channel_state_in_file：在库里而 var/ 有没导入的 wecom-cursor.json、没有标记；文件不动'), async () => {
    const t = await newTenant(h);
    await addWecom(h, t.id, 'kf-main', { cursor: 'c6-keep' });
    const dir = freshVar();
    fs.writeFileSync(path.join(dir, WECOM_STATE_FILE), '{"cursor":"file-c6","handled":[],"pending":[]}');
    const e = await expectReject('channel_state_in_file', deps(t, dir), { h, tenantId: t.id });
    assert.match(e.detail, /channel-import/);
  });

  await acheck(L('拒绝 channel_state_in_db：已导出而标记还在（导出没做完）；未导入而有标记（标记与库对不上）'), async () => {
    const exported = await newTenant(h);
    await addWecom(h, exported.id, 'kf-main', { status: 'exported', cursor: 'c6-keep' });
    let dir = freshVar();
    fs.writeFileSync(path.join(dir, CHANNELS_IN_DB_MARKER), '{"tenant":"x","account":"kf-main","at":"2026-10-09T00:00:00.000Z"}\n');
    let e = await expectReject('channel_state_in_db', deps(exported, dir), { h, tenantId: exported.id });
    assert.match(e.detail, /导出没做完/);
    const none = await newTenant(h);
    dir = freshVar();
    fs.writeFileSync(path.join(dir, CHANNELS_IN_DB_MARKER), '{"tenant":"x","account":"kf-main","at":"2026-10-09T00:00:00.000Z"}\n');
    e = await expectReject('channel_state_in_db', deps(none, dir), { h, tenantId: none.id });
    assert.match(e.detail, /标记与库对不上/);
  });

  await acheck(
    L('全部停用、有恢复哨兵：照常起、不起企微、哨兵留着、日志一行；之后启用一个账号再起被 channel_restore_pending 拦住'),
    async () => {
      setWecomEnv(true);
      const t = await newTenant(h);
      const a = await addWecom(h, t.id, 'kf-main', { status: 'disabled' });
      const dir = freshVar();
      writeSentinel(dir);
      const r = await tryInit(deps(t, dir, null));
      assert.equal(r.err, null, r.err?.detail);
      assert.equal(wecomState(), 'in_db');
      assert.deepEqual(channelsHealth(), { mode: 'db', accounts: 0, failing: 0, stuck: 0 });
      assert.equal(loadedChannels().size, 0);
      assert.ok(!wecomMod.isWecomEnabled(), '不起企微，也不走 env 的老路');
      assert.ok(fs.existsSync(path.join(dir, RESTORE_SENTINEL)), '哨兵留着');
      assert.equal(r.out.match(/有恢复哨兵 restored-from-backup\.json、企微账号全部停用：照常起、不起企微，哨兵留着/g)?.length, 1);
      await h.su(`update channel_accounts set status = 'active' where tenant_id = $1 and id = $2`, [t.id, a]);
      await expectReject('channel_restore_pending', deps(t, dir), { h, tenantId: t.id });
      assert.ok(fs.existsSync(path.join(dir, RESTORE_SENTINEL)), '停用不清掉恢复风险：哨兵还在');
    },
  );

  await acheck(L('欢迎语不合格按没设处理并告警，合格的照用；web_channel 关着时网页账号带 inactiveReason、不启用、告警一条'), async () => {
    setWecomEnv(false);
    const t = await newTenant(h);
    const good = '您好，我是云途的 AI 旅行顾问。需要真人服务时回复「人工」。';
    const main = await addWecom(h, t.id, 'kf-main', {
      settings: { welcomeText: '您好，欢迎光临云途旅行', welcomeBackText: good, pollIntervalMs: 45000 },
    });
    const web = await addWeb(h, t.id, 'web6', { title: '云途网页咨询', welcomeText: '我是 AI 旅行顾问，有问题尽管问', dailyTurns: 99 });
    __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_WEB_CHANNEL: 'off' });
    let r: Awaited<ReturnType<typeof tryInit>>;
    try {
      r = await tryInit(deps(t, freshVar()));
    } finally {
      __profileTest.reset();
    }
    assert.equal(r.err, null, r.err?.detail);
    const a = loadedAccounts().find((x) => x.id === main)!;
    assert.equal(a.wecom!.settings.welcomeText, undefined, '不合格按没设处理');
    assert.equal(a.wecom!.settings.welcomeBackText, good, '合格的照用');
    assert.equal(a.wecom!.settings.pollIntervalMs, 45000);
    assert.equal(a.inactiveReason, null, '欢迎语不合格不影响账号启用');
    const w = loadedAccounts().find((x) => x.id === web)!;
    assert.equal(w.web!.welcomeText, undefined);
    assert.equal(w.web!.title, '云途网页咨询');
    assert.equal(w.web!.dailyTurns, 99);
    assert.equal(w.web!.dailyNewConversations, 500);
    assert.equal(w.inactiveReason, WEB_CHANNEL_OFF_REASON);
    assert.equal(accountByKey('web6', 'web'), undefined);
    assert.ok(!loadedChannels().has(web));
    assert.deepEqual(channelsHealth(), { mode: 'db', accounts: 1, failing: 0, stuck: 0 });
    const warnings = channelStartupWarnings();
    assert.equal(warnings.length, 3, warnings.join('｜'));
    assert.ok(warnings.some((x) => /^账号 kf-main 的 welcomeText 不合格（第一句没有写明「AI」），按没设处理$/.test(x)));
    assert.ok(warnings.some((x) => /^账号 web6 的 welcomeText 不合格（正文没有转人工的说法），按没设处理$/.test(x)));
    assert.ok(warnings.some((x) => x === `网页账号 web6 没有启用：${WEB_CHANNEL_OFF_REASON}`));
    for (const x of warnings) assert.ok(!x.includes('欢迎光临') && !x.includes('尽管问'), '告警里不带欢迎语原文');
    assert.match(r.out, /\[channels\] ⚠️ 账号 kf-main 的 welcomeText 不合格/);
    if (h.pglite) {
      // 告警（channel 键）：startAlerts 把装载时的几条合成一条；没配地址时只记一行 warn
      const { startAlerts, __alertTest } = await import('../ops/alert.js');
      const from = captured.length;
      startAlerts();
      __alertTest.stopTimer();
      assert.match(
        captured.slice(from),
        /\[alert\] 没配 ALERT_WEBHOOK_URL，这条告警只记在日志里：\[[^\]]+\] 渠道账号启动检查：.*web6.*kf-main/,
      );
    }
  });
}

/**
 * /healthz 的 channels 形状；企微状态在库里时 /wecom/callback 不读 env 的回调凭据，只认前缀是 wecom: 的库里账号：
 * 签名对不上 GET 404、POST 回 success（不拉）
 */
async function healthzAndCallback(): Promise<void> {
  process.env.SERVER_SELFTEST = '1';
  const { app } = await import('../server.js');
  const res = await app.request('/healthz');
  const body = (await res.json()) as { ok: boolean; channels: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.channels).toSorted(), ['accounts', 'failing', 'mode', 'stuck']);
  assert.deepEqual(body.channels, { mode: 'db', accounts: 3, failing: 0, stuck: 0 });
  assert.equal(body.ok, true);
  const text = JSON.stringify(body);
  for (const s of ['kf-main', 'kf-two', 'web6']) assert.ok(!text.includes(s), `/healthz 里不带账号 key（${s}）`);
  noSecretIn(text, '/healthz');
  const get = await app.request('/wecom/callback?msg_signature=a&timestamp=1&nonce=2&echostr=x');
  assert.equal(get.status, 404);
  const xml = '<xml><Encrypt>x</Encrypt></xml>';
  const post = await app.request('/wecom/callback?msg_signature=a&timestamp=1&nonce=2', {
    method: 'POST',
    headers: { 'content-length': String(Buffer.byteLength(xml)) },
    body: xml,
  });
  assert.equal(await post.text(), 'success');
}

{
  const t = await openTestDb();
  await t.pg.exec('SET ROLE agent_app');
  try {
    await dbScenarios({
      label: 'PGlite',
      pglite: true,
      db: t.db,
      su: async <R>(text: string, params: unknown[] = []) => {
        await t.pg.exec('RESET ROLE');
        try {
          return (await t.pg.query<R>(text, params)).rows;
        } finally {
          await t.pg.exec('SET ROLE agent_app');
        }
      },
    });
  } finally {
    await t.close();
  }
}

if (process.env.PG_TEST_URL) {
  const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'ch6-base' });
  const app = await openDb(fx.urls.app);
  try {
    await dbScenarios({ label: '真实 PG', pglite: false, db: app.db, su: fx.query });
  } finally {
    await app.close();
    await fx.drop();
  }
} else if (process.env.CI === 'true') {
  throw new Error('CI 下必须设 PG_TEST_URL：渠道装载要以 agent_app 身份在真实 Postgres 上跑一遍，不能静默跳过');
} else {
  console.log('CHANNELS SELFTEST：没有 PG_TEST_URL，跳过真实 Postgres 部分');
}

// ---------------- boot：顺序与拒绝分支 ----------------

await acheck(
  'boot：渠道装载在会话存储之后、监听之前；监听之后 startChannels 先于跟进扫描器与任务表；拒绝时打 reason 与 detail、exit(1)、其余不调',
  async () => {
    __channelsTest.reset();
    const run = async (init?: () => Promise<void>, mode: 'file' | 'db' = 'file') => {
      const calls: string[] = [];
      const exits: number[] = [];
      const from = captured.length;
      await boot({
        initConfig: async () => void calls.push('config'),
        initSessionStore: async () => void calls.push('store'),
        initChannels: () => {
          calls.push('channels');
          return init ? init() : Promise.resolve();
        },
        serve: (onListening) => {
          calls.push('serve');
          onListening();
        },
        preflight: () => void calls.push('preflight'),
        buildIndex: async () => void calls.push('buildIndex'),
        storeMode: () => mode,
        startFollowUpScheduler: () => void calls.push('followup'),
        startJobs: () => void calls.push('jobs'),
        startChannels: () => void calls.push('startChannels'),
        exit: (c) => void exits.push(c),
      });
      return { calls: calls.join(','), exits: exits.join(','), out: captured.slice(from) };
    };
    assert.equal((await run()).calls, 'config,store,channels,serve,preflight,buildIndex,startChannels,followup');
    assert.equal((await run(undefined, 'db')).calls, 'config,store,channels,serve,preflight,buildIndex,startChannels,jobs');
    const refused = await run(async () => {
      throw new ChannelStartupError('channel_restore_pending', '哨兵在');
    });
    assert.equal(refused.calls, 'config,store,channels');
    assert.equal(refused.exits, '1');
    assert.match(refused.out, /\[boot\] 渠道装载失败，拒绝启动（channel_restore_pending）：哨兵在/);
    // server.ts 的写法：密钥环在调 initChannels 之前同步解析，格式不对同步抛出，同样被接住
    const short = Buffer.alloc(31, 7).toString('base64');
    const bad = await run(() =>
      initChannels({
        db: {} as Db,
        tenantId: 't',
        tenantSlug: 't',
        varDir: varRoot,
        keyRing: channelKeyRing({ [envName]: `k1:${short}` }),
      }),
    );
    assert.equal(bad.calls, 'config,store,channels');
    assert.equal(bad.exits, '1');
    assert.match(bad.out, /\[boot\] 渠道装载失败，拒绝启动（channel_key_invalid）：.*第 1 项/);
    assert.ok(!bad.out.includes(short.slice(0, 8)));
    assert.equal(loadedAccounts().length, 0);
  },
);

check('凭据不出现在输出：整段 stdout、stderr 里没有凭据明文、密文（base64、hex、Buffer 的 JSON）、env 里的企微凭据与企微标识', () => {
  noSecretIn(captured, '输出');
});

// ---------------- 03 第 15 步：账号命令行（子进程、app 权限、事务与输出边界） ----------------
{
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { holdTenantLock } = await import('../db/client.js');
  const { AUDIT_ACTIONS } = await import('../shared/ui-labels.js');
  const repo = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-cli-'));
  const cli = path.join(repo, 'src', 'cli', 'channel-account.ts');
  const disk = path.join(temp, 'db');
  const snapshotFile = path.join(temp, 'snapshot.json');
  const bridge = path.join(temp, 'cli.mts');
  const fake15 = {
    corpId: 'fake-corp-cli',
    openKfId: 'fake-kf-main-cli',
    appSecret: 'fake-cli-app-value',
    callbackToken: 'fake-cli-token-value',
    callbackAesKey: 'fake-cli-aes-value',
  };
  const replacement15 = {
    appSecret: 'fake-cli-new-app',
    callbackToken: 'fake-cli-new-token',
    callbackAesKey: 'fake-cli-new-aes',
  };
  const credentialFile = path.join(temp, 'credentials.json');
  const secondFile = path.join(temp, 'second.json');
  const replacementFile = path.join(temp, 'replacement.json');
  const looseFile = path.join(temp, 'loose.json');
  const malformedFile = path.join(temp, 'malformed.json');
  const linkFile = path.join(temp, 'link.json');
  const writeCredential = (file: string, value: unknown, mode = 0o600) => {
    fs.writeFileSync(file, JSON.stringify(value), { mode });
  };
  writeCredential(credentialFile, fake15);
  writeCredential(secondFile, { ...fake15, openKfId: 'fake-kf-second-cli' });
  writeCredential(replacementFile, replacement15);
  writeCredential(looseFile, fake15, 0o644);
  fs.writeFileSync(malformedFile, `{"appSecret":"${fake15.appSecret}", invalid`, { mode: 0o600 });
  fs.symlinkSync(credentialFile, linkFile);
  const rowSql =
    "select tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, encode(secrets_ct, 'hex') as ct, secrets_key_id, settings, updated_at from channel_accounts order by tenant_id, key";
  const auditSql = 'select tenant_id, action, actor_kind, actor_name, target_type, target_id, diff from audit_log order by id';
  type CliRow = {
    tenant_id: string;
    id: string;
    key: string;
    kind: string;
    name: string;
    status: string;
    id_prefix: string | null;
    corp_id: string | null;
    open_kfid: string | null;
    ct: string | null;
    secrets_key_id: string | null;
    settings: Record<string, unknown>;
    updated_at: string;
  };
  type CliAudit = {
    tenant_id: string;
    action: string;
    actor_kind: string;
    actor_name: string;
    target_type: string;
    target_id: string | null;
    diff: { keys: string[]; fields: string[] };
  };
  type CliState = { rows: CliRow[]; audits: CliAudit[] };
  let output15 = '';
  const ciphertexts15: Buffer[] = [];
  const allKeys = `new:${newKey.toString('base64')},old:${oldKey.toString('base64')}`;
  const oldEnv = `old:${oldKey.toString('base64')}`;
  const newEnv = `new:${newKey.toString('base64')}`;
  const safe15 = () => {
    const forbidden = [
      ...Object.values(fake15),
      ...Object.values(replacement15),
      'fake-kf-second-cli',
      'corp_id',
      'open_kfid',
      'access_token',
      oldEnv,
      newEnv,
      ...ciphertexts15.flatMap((ct) => [ct.toString('base64'), ct.toString('hex'), JSON.stringify(ct)]),
    ];
    for (const value of forbidden) assert.ok(!output15.includes(value), '命令行输出含凭据、密文或企微标识');
  };
  // PGlite 只经自测桥接注入；生产入口没有测试 env 开关。每个命令是独立子进程，真正使用 agent_app 列级权限。
  fs.writeFileSync(
    bridge,
    `
import fs from 'node:fs';
const { openTestDb, fakeLock } = await import(process.env.CLI_TEST_DB_MODULE);
const { runChannelAccount } = await import(process.env.CLI_TEST_MODULE);
const t = await openTestDb({ dataDir: process.env.CLI_TEST_DISK });
try {
  if (process.env.CLI_TEST_PREP) {
    const { sql, params } = JSON.parse(process.env.CLI_TEST_PREP);
    await t.pg.query(sql, params);
  }
  await t.pg.exec('SET ROLE agent_app');
  const code = await runChannelAccount(process.argv.slice(2), {
    connect: async () => ({ db: t.db, close: async () => {},
      lock: async () => process.env.CLI_TEST_LOCK === 'held' ? null : fakeLock() }),
  });
  await t.pg.exec('RESET ROLE');
  fs.writeFileSync(process.env.CLI_TEST_SNAPSHOT, JSON.stringify({
    rows: (await t.pg.query(${JSON.stringify(rowSql)})).rows,
    audits: (await t.pg.query(${JSON.stringify(auditSql)})).rows,
  }));
  await t.close();
  process.exit(code);
} catch { await t.close(); process.exit(90); }
`,
  );
  interface CliHarness {
    label: string;
    tenantId: string;
    query(sql: string, params?: unknown[]): Promise<unknown>;
    run(
      args: string[],
      env?: Record<string, string>,
      prep?: { sql: string; params?: unknown[] },
    ): Promise<{ status: number | null; out: string; state: CliState }>;
    close(): Promise<void>;
    blocked(): Promise<() => Promise<void>>;
  }
  const baseEnv = {
    ...process.env,
    DEPLOY_PROFILE: 'demo',
    FLAG_WEB_CHANNEL: '',
    [envName]: oldEnv,
    DATABASE_URL: '',
    DATABASE_PLATFORM_URL: '',
  };
  function collect(r: ReturnType<typeof spawnSync>, state: CliState) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    output15 += out;
    for (const row of state.rows) if (row.ct) ciphertexts15.push(Buffer.from(row.ct, 'hex'));
    return { status: r.status, out, state };
  }
  const suites: (() => Promise<CliHarness>)[] = [
    async () => {
      const t = await openTestDb({ dataDir: disk });
      await t.pg.query(
        `insert into tenants (slug, name, pack_id) values ('cli15', 'cli15', 'travel'), ('cli15-other', 'cli15-other', 'travel')`,
      );
      const tenantId = (await t.pg.query<{ id: string }>(`select id from tenants where slug = 'cli15'`)).rows[0]!.id;
      await t.close();
      return {
        label: 'PGlite 子进程',
        tenantId,
        query: async (sql, params = []) => {
          const db = await openTestDb({ dataDir: disk });
          try {
            return await db.pg.query(sql, params);
          } finally {
            await db.close();
          }
        },
        run: async (args, env = {}, prep) => {
          const r = spawnSync(process.execPath, ['--import', 'tsx', bridge, ...args], {
            cwd: repo,
            encoding: 'utf8',
            timeout: 60000,
            killSignal: 'SIGKILL',
            env: {
              ...baseEnv,
              CLI_TEST_MODULE: pathToFileURL(cli).href,
              CLI_TEST_DB_MODULE: pathToFileURL(path.join(repo, 'src', 'db', 'testing.ts')).href,
              CLI_TEST_DISK: disk,
              CLI_TEST_SNAPSHOT: snapshotFile,
              ...(prep ? { CLI_TEST_PREP: JSON.stringify(prep) } : {}),
              ...env,
            },
          });
          assert.notEqual(r.status, 90, 'PGlite 命令行桥接失败');
          assert.equal(r.signal, null, '命令行子进程超时');
          return collect(r, JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as CliState);
        },
        close: async () => {},
        blocked: async () => async () => {},
      };
    },
  ];
  if (process.env.PG_TEST_URL)
    suites.push(async () => {
      const fx = await createRealPgFixture(process.env.PG_TEST_URL!, { slug: 'cli15' });
      await fx.query(`insert into tenants (slug, name, pack_id) values ('cli15-other', 'cli15-other', 'travel')`);
      return {
        label: '真实 PG 子进程',
        tenantId: fx.tenantId,
        query: fx.query,
        close: fx.drop,
        run: async (args, env = {}, prep) => {
          if (prep) await fx.query(prep.sql, prep.params);
          const r = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
            cwd: repo,
            encoding: 'utf8',
            timeout: 60000,
            killSignal: 'SIGKILL',
            env: { ...baseEnv, DATABASE_URL: fx.urls.app, ...env },
          });
          assert.equal(r.signal, null, '命令行子进程超时');
          return collect(r, { rows: await fx.query<CliRow>(rowSql), audits: await fx.query<CliAudit>(auditSql) });
        },
        blocked: async () => {
          const lock = await holdTenantLock(fx.urls.app, fx.tenantId);
          assert.ok(lock);
          return () => lock.release();
        },
      };
    });
  try {
    for (const suite of suites) {
      const h = await suite();
      try {
        const label = (s: string) => `${h.label}：${s}`;
        let state: CliState = { rows: [], audits: [] };
        const run = async (args: string[], code = 0, env: Record<string, string> = {}, prep?: { sql: string; params?: unknown[] }) => {
          const r = await h.run([...args, '--tenant', 'cli15'], env, prep);
          assert.equal(r.status, code, `退出码应为 ${code}（${args[0]}）`);
          state = r.state;
          return r;
        };
        const denied = async (args: string[], code = 1, env: Record<string, string> = {}) => {
          const before = JSON.stringify(state);
          const r = await run(args, code, env);
          assert.equal(JSON.stringify(state), before, '拒绝时账号与审计应保持不变');
          return r;
        };
        const row = (key: string) => state.rows.find((r) => r.tenant_id === h.tenantId && r.key === key)!;
        const audit = (action: string, key: string, fields?: string[]) => {
          const a = state.audits.at(-1)!;
          assert.equal(a.action, action);
          assert.equal(a.actor_kind, 'platform');
          assert.equal(a.actor_name, 'channel-account');
          assert.equal(a.tenant_id, h.tenantId);
          assert.equal(a.target_id, null);
          assert.deepEqual(Object.keys(a.diff).sort(), ['fields', 'keys']);
          assert.deepEqual(a.diff.keys, [key]);
          if (fields) assert.deepEqual(a.diff.fields, fields);
        };
        await acheck(label('list 空租户与 rekey 无操作：0，无写入'), async () => {
          assert.equal((await run(['list'])).out, '');
          assert.match((await run(['rekey'])).out, /无操作/);
          assert.equal(state.rows.length, 0);
          assert.equal(state.audits.length, 0);
        });
        await acheck(label('用法、误传凭据、缺密钥环、非 0600、文件无效、无终端：1 且不写库'), async () => {
          for (const args of [
            [],
            ['unknown'],
            ['restore-cutoff'],
            ['list', '--appSecret', fake15.appSecret],
            ['add-wecom', '--key', 'INVALID', '--name', '客服'],
            ['add-wecom', '--key', 'main'],
            ['list', '--corp_id', fake15.corpId],
            ['list', '--open_kfid', fake15.openKfId],
          ])
            await denied(args);
          const args = ['add-wecom', '--key', 'main', '--name', '客服'];
          await denied([...args, '--secrets-file', credentialFile], 1, { [envName]: '' });
          await denied([...args, '--secrets-file', credentialFile], 1, { [envName]: fake15.appSecret });
          for (const file of [looseFile, malformedFile, linkFile, path.join(temp, 'missing.json'), temp])
            await denied([...args, '--secrets-file', file]);
          await denied(args); // stdin 不是终端，拒绝不安全的有回显输入
        });
        await acheck(label('拿不到租户锁：全部六种命令以 3 退出且不写库'), async () => {
          const release = await h.blocked();
          try {
            for (const args of [
              ['list'],
              ['rekey'],
              ['add-wecom', '--key', 'main', '--name', '客服', '--secrets-file', credentialFile],
              ['add-web', '--key', 'site', '--title', '咨询'],
              ['set-secrets', '--key', 'main', '--secrets-file', replacementFile],
              ['set', '--key', 'main', '--status', 'disabled'],
            ]) {
              await denied(args, 3, h.label.startsWith('PGlite') ? { CLI_TEST_LOCK: 'held' } : {});
            }
          } finally {
            await release();
          }
        });
        await acheck(label('add-wecom 两个账号：0，AAD 可解，默认与次账号前缀，创建审计'), async () => {
          await run(['add-wecom', '--key', 'main', '--name', '主客服', '--secrets-file', credentialFile]);
          assert.equal(row('main').id_prefix, 'wecom:');
          const r = row('main');
          assert.deepEqual(
            openSecrets(oldRing, { tenantId: h.tenantId, accountId: r.id }, Buffer.from(r.ct!, 'hex'), r.secrets_key_id!).reveal(),
            {
              appSecret: fake15.appSecret,
              callbackToken: fake15.callbackToken,
              callbackAesKey: fake15.callbackAesKey,
            },
          );
          audit('channel.account_create', 'main');
          await run(['add-wecom', '--key', 'second', '--name', '次客服', '--secrets-file', secondFile]);
          assert.equal(row('second').id_prefix, 'wecom:second:');
          audit('channel.account_create', 'second');
          await denied(['add-wecom', '--key', 'main', '--name', '重复', '--secrets-file', credentialFile], 2);
          await denied(['add-wecom', '--key', 'duplicate', '--name', '重复', '--secrets-file', credentialFile], 2);
        });
        await acheck(label('add-web 标题校验、默认设置、list 白名单；prod 创建与启用拒绝 2'), async () => {
          for (const title of ['', '   ', '文'.repeat(41)]) await denied(['add-web', '--key', 'site', '--title', title]);
          await denied(['add-web', '--key', 'site', '--title', '咨询'], 2, { DEPLOY_PROFILE: 'prod' });
          await denied(['add-web', '--key', 'site', '--title', '咨询'], 2, { FLAG_WEB_CHANNEL: 'off' });
          await run(['add-web', '--key', 'site', '--title', '咨询']);
          assert.deepEqual(row('site').settings, { title: '咨询', dailyNewConversations: 500, dailyTurns: 3000 });
          audit('channel.account_create', 'site');
          const list = await run(['list'], 0, { DEPLOY_PROFILE: 'prod' });
          const visible = list.out
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l.replace(/^\[channel-account\] /, '')));
          assert.equal(visible.length, 3);
          for (const v of visible)
            assert.deepEqual(Object.keys(v).sort(), ['inactiveReason', 'key', 'kind', 'name', 'prefix', 'status', '凭据已设置'].sort());
          assert.equal(visible.find((v) => v.key === 'site').inactiveReason, WEB_CHANNEL_OFF_REASON);
          assert.equal(visible.find((v) => v.key === 'main')['凭据已设置'], '是');
          assert.equal(visible.find((v) => v.key === 'site')['凭据已设置'], '否');
          await run(['set', '--key', 'site', '--status', 'disabled']);
          audit('channel.account_update', 'site', ['status']);
          await denied(['set', '--key', 'site', '--status', 'active', '--name', '不能修改'], 2, {
            DEPLOY_PROFILE: 'prod',
          });
          await denied(['set', '--key', 'site', '--status', 'active'], 2, { FLAG_WEB_CHANNEL: 'off' });
        });
        await acheck(label('set 全部设置、有效欢迎语、合并保留设置、审计不含值与无操作 0'), async () => {
          const welcome = '我是 AI 助手。回复人工转真人。';
          await run([
            'set',
            '--key',
            'main',
            '--name',
            '客服改名',
            '--status',
            'disabled',
            '--setting',
            'pollIntervalMs=45000',
            '--setting',
            `welcomeText=${welcome}`,
            '--setting',
            `welcomeBackText=${welcome}`,
          ]);
          assert.equal(row('main').name, '客服改名');
          assert.equal(row('main').status, 'disabled');
          assert.deepEqual(row('main').settings, { pollIntervalMs: 45000, welcomeText: welcome, welcomeBackText: welcome });
          audit('channel.account_update', 'main', ['name', 'status', 'pollIntervalMs', 'welcomeText', 'welcomeBackText']);
          const count = state.audits.length;
          assert.match((await run(['set', '--key', 'main', '--name', '客服改名'])).out, /无操作/);
          assert.match((await run(['set', '--key', 'main'])).out, /无操作/);
          assert.equal(state.audits.length, count);
          await run([
            'set',
            '--key',
            'site',
            '--status',
            'active',
            '--setting',
            'title=网页咨询',
            '--setting',
            'dailyNewConversations=12',
            '--setting',
            'dailyTurns=34',
            '--setting',
            `welcomeText=${welcome}`,
          ]);
          assert.deepEqual(row('site').settings, { title: '网页咨询', dailyNewConversations: 12, dailyTurns: 34, welcomeText: welcome });
          audit('channel.account_update', 'site', ['status', 'title', 'dailyNewConversations', 'dailyTurns', 'welcomeText']);
          await run(['set', '--key', 'site', '--setting', 'dailyTurns=35']);
          assert.equal(row('site').settings.title, '网页咨询');
          assert.equal(row('site').settings.dailyNewConversations, 12);
        });
        await acheck(label('set 无效欢迎语、exported、错误设置与缺账号：1/2，整库及审计不变'), async () => {
          for (const key of ['main', 'site'])
            for (const text of ['', '普通欢迎语。回复人工。', 'AI 助手。欢迎。']) {
              await denied(['set', '--key', key, '--name', '不可写入', '--setting', `welcomeText=${text}`]);
            }
          await denied(['set', '--key', 'main', '--setting', 'welcomeBackText=普通问候。转人工']);
          await denied(['set', '--key', 'main', '--status', 'exported']);
          await denied(['set', '--key', 'main', '--status', 'unknown']);
          for (const setting of [
            'pollIntervalMs=29999',
            'pollIntervalMs=0',
            'pollIntervalMs=1.5',
            'pollIntervalMs=NaN',
            'corpId=blocked',
            'title=blocked',
            '__proto__=blocked',
            'no-equals',
          ]) {
            await denied(['set', '--key', 'main', '--setting', setting]);
          }
          for (const setting of [
            'title= ',
            `title=${'文'.repeat(41)}`,
            'dailyTurns=0',
            'dailyNewConversations=-1',
            'dailyTurns=9007199254740992',
            'welcomeBackText=AI。转人工',
          ])
            await denied(['set', '--key', 'site', '--setting', setting]);
          await denied(['set', '--key', 'main', '--setting', 'pollIntervalMs=30000', '--setting', 'pollIntervalMs=60000']);
          await denied(['set', '--key', 'missing', '--status', 'disabled'], 2);
          await denied(['set-secrets', '--key', 'missing', '--secrets-file', replacementFile], 2);
          await denied(['set-secrets', '--key', 'site', '--secrets-file', replacementFile]);
        });
        await acheck(label('set-secrets：0、可解、不改标识、三项审计；缺钥/错误文件 1'), async () => {
          await denied(['set-secrets', '--key', 'main', '--secrets-file', replacementFile], 1, { [envName]: '' });
          await denied(['set-secrets', '--key', 'main', '--secrets-file', looseFile]);
          await denied(['set-secrets', '--key', 'main', '--secrets-file', credentialFile]);
          await run(['set-secrets', '--key', 'main', '--secrets-file', replacementFile]);
          const r = row('main');
          assert.deepEqual(
            openSecrets(oldRing, { tenantId: h.tenantId, accountId: r.id }, Buffer.from(r.ct!, 'hex'), r.secrets_key_id!).reveal(),
            replacement15,
          );
          assert.equal(r.corp_id, fake15.corpId);
          assert.equal(r.open_kfid, fake15.openKfId);
          audit('channel.secrets_update', 'main', ['appSecret', 'callbackToken', 'callbackAesKey']);
        });
        await acheck(label('rekey：缺密钥 1/旧钥不全 2，坏行阻止全部写入；轮换后去旧钥可解'), async () => {
          await denied(['rekey'], 1, { [envName]: '' });
          await denied(['rekey'], 2, { [envName]: newEnv });
          const second = row('second');
          const oldCt = second.ct!;
          await h.query("update channel_accounts set secrets_ct = decode($1, 'hex') where tenant_id = $2 and id = $3", [
            '01'.repeat(32),
            h.tenantId,
            second.id,
          ]);
          await run(['list']);
          await denied(['rekey'], 2, { [envName]: allKeys });
          await h.query("update channel_accounts set secrets_ct = decode($1, 'hex') where tenant_id = $2 and id = $3", [
            oldCt,
            h.tenantId,
            second.id,
          ]);
          await run(['rekey'], 0, { [envName]: allKeys });
          for (const r of state.rows.filter((r) => r.ct)) {
            assert.equal(r.secrets_key_id, 'new');
            assert.ok(
              openSecrets(newRing, { tenantId: h.tenantId, accountId: r.id }, Buffer.from(r.ct!, 'hex'), r.secrets_key_id!).reveal()
                .appSecret,
            );
          }
          const a = state.audits.at(-1)!;
          assert.equal(a.action, 'channel.rekey');
          assert.equal(a.actor_kind, 'platform');
          assert.equal(a.actor_name, 'channel-account');
          assert.deepEqual(a.diff.keys.sort(), ['main', 'second']);
          assert.deepEqual(a.diff.fields, ['secretsCt', 'secretsKeyId']);
          assert.equal(row('site').ct, null);
        });
        await acheck(label('企微全部 exported 时两个 add 都是 2，提示 resync；不改库'), async () => {
          await h.query("update channel_accounts set status = 'exported' where tenant_id = $1 and kind = 'wecom_kf'", [h.tenantId]);
          await run(['list']);
          for (const args of [
            ['add-wecom', '--key', 'third', '--name', '客服', '--secrets-file', secondFile],
            ['add-web', '--key', 'site2', '--title', '咨询'],
          ]) {
            assert.match((await denied(args, 2)).out, /channel-import --resync/);
          }
        });
        await acheck(label('事务写入异常 1 不泄露参数；读不到其他租户的账号与审计'), async () => {
          // 注入数据库异常，把敏感形态塞进 ERROR，CLI 必须只打印固定安全报错，账号和审计回滚。
          await h.query(
            `create function cli15_audit_fail() returns trigger language plpgsql as $$ begin raise exception '%', '${fake15.appSecret} ${fake15.corpId} ${row('main').ct}'; end $$`,
          );
          await h.query('create trigger cli15_audit_fail before insert on audit_log for each row execute function cli15_audit_fail()');
          try {
            await denied(['set', '--key', 'main', '--name', '应回滚']);
          } finally {
            await h.query('drop trigger cli15_audit_fail on audit_log');
            await h.query('drop function cli15_audit_fail()');
          }
          const r = await h.run(['list', '--tenant', 'cli15-other']);
          assert.equal(r.status, 0);
          assert.equal(r.out, '');
          assert.equal(state.rows.filter((r) => r.tenant_id !== h.tenantId).length, 0);
          assert.equal(state.audits.filter((r) => r.tenant_id !== h.tenantId).length, 0);
          const before = JSON.stringify(state);
          assert.equal((await h.run(['list', '--tenant', 'missing'])).status, 1);
          assert.equal(JSON.stringify(state), before);
        });
        check(label('写操作每次只一行审计，内容只含账号 key 和字段名字，四个动作都有中文标签'), () => {
          assert.equal(state.audits.length, 9);
          const allowed = new Set([
            'key',
            'kind',
            'name',
            'status',
            'idPrefix',
            'corpId',
            'openKfId',
            'appSecret',
            'callbackToken',
            'callbackAesKey',
            'title',
            'dailyNewConversations',
            'dailyTurns',
            'pollIntervalMs',
            'welcomeText',
            'welcomeBackText',
            'secretsCt',
            'secretsKeyId',
          ]);
          for (const a of state.audits) {
            assert.deepEqual(Object.keys(a.diff).sort(), ['fields', 'keys']);
            assert.ok(a.diff.keys.every((k) => ['main', 'second', 'site'].includes(k)));
            assert.ok(a.diff.fields.every((f) => allowed.has(f)));
            assert.equal(a.actor_kind, 'platform');
            assert.equal(a.actor_name, 'channel-account');
          }
          for (const action of ['account_create', 'account_update', 'secrets_update', 'rekey'])
            assert.match(AUDIT_ACTIONS[`channel.${action}`]!.label, /\p{Script=Han}/u);
        });
      } finally {
        await h.close();
      }
    }
    check('CLI stdout/stderr 凭据扫描为零：明文、密文 base64/hex/Buffer JSON、企微标识与 access_token', safe15);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

__channelsTest.reset();
console.log(
  `CHANNELS SELFTEST PASS: ${pass} 项断言全通（密钥环 / AES-256-GCM 与 AAD / 轮换 / Redacted / 异常不泄露 / 日志字段脱敏 / ` +
    `账号装载：文件存储、未导入、已导出、在库里 / 六个拒绝原因与不留半装载 / 恢复哨兵与标记 / 欢迎语检查 / web_channel / ` +
    `accountForSession 与 accountByKey / /healthz 的 channels / boot 顺序${process.env.PG_TEST_URL ? ' / 真实 PG' : ''}）`,
);
process.exit(0);
