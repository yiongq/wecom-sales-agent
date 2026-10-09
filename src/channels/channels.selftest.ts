// 03 第 3 步：密钥环、凭据的认证加密、打印遮盖与日志字段脱敏；纯本机自测，不读部署密钥。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { createCipheriv } from 'node:crypto';
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

console.log(`CHANNELS SELFTEST PASS: ${pass} 项断言全通（密钥环 / AES-256-GCM 与 AAD / 轮换 / Redacted / 异常不泄露 / 日志字段脱敏）`);
