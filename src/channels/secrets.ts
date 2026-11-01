import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

export interface KeyRing {
  current: { id: string; key: Buffer };
  all: ReadonlyMap<string, Buffer>;
}

const CENSOR = '[已遮盖]';

/** 值只经 reveal() 取出；对象枚举、JSON 与 inspect 都读不到私有字段。 */
export class Redacted<T> {
  #v: T;

  constructor(value: T) {
    this.#v = value;
  }

  reveal(): T {
    return this.#v;
  }

  toJSON(): string {
    return CENSOR;
  }

  toString(): string {
    return CENSOR;
  }

  [Symbol.toPrimitive](): string {
    return CENSOR;
  }

  [inspect.custom](): string {
    return CENSOR;
  }
}

export interface WecomSecrets {
  appSecret: string;
  callbackToken: string;
  callbackAesKey: string;
}

export class ChannelKeyError extends Error {
  constructor(item: number, reason: string) {
    super(`渠道密钥第 ${item} 项：${reason}`);
    this.name = 'ChannelKeyError';
  }
}

type SecretFailure = '密钥不存在' | '密文长度不足' | '认证失败' | 'JSON 无效' | '凭据字段无效';

/** 不保留底层异常（JSON.parse 等可能把明文片段放进 message）。 */
export class ChannelSecretError extends Error {
  readonly keyId: string;

  constructor(keyId: string, reason: SecretFailure) {
    super(`渠道凭据 ${keyId}：${reason}`);
    this.name = 'ChannelSecretError';
    this.keyId = keyId;
  }
}

/** 密钥环所在的环境变量名：只在本文件写出（scripts/check-boundaries.ts 守），别处的提示语经它引用、读值一律经 keyRingFromEnv */
export const CHANNEL_KEY_ENV = 'CHANNEL_SECRETS_KEY';

/** 空值表示未配置；标准 base64 可省略末尾填充，但不接受空白、非法字符或非规范填充位。 */
export function keyRingFromEnv(env: Readonly<Record<string, string | undefined>>): KeyRing | null {
  const value = env.CHANNEL_SECRETS_KEY;
  if (value === undefined || value === '') return null;
  const all = new Map<string, Buffer>();
  let current: KeyRing['current'] | undefined;
  for (const [index, entry] of value.split(',').entries()) {
    const item = index + 1;
    const colon = entry.indexOf(':');
    if (colon < 0) throw new ChannelKeyError(item, '缺少冒号');
    const id = entry.slice(0, colon);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new ChannelKeyError(item, 'id 无效');
    if (all.has(id)) throw new ChannelKeyError(item, 'id 重复');
    const encoded = entry.slice(colon + 1);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(encoded)) {
      throw new ChannelKeyError(item, 'base64 无效');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      throw new ChannelKeyError(item, 'base64 无效');
    }
    if (key.length !== 32) throw new ChannelKeyError(item, '密钥必须为 32 字节');
    all.set(id, key);
    current ??= { id, key };
  }
  return { current: current!, all };
}

/** 共用密文布局：12 字节 nonce + JSON 密文 + 16 字节 tag；前缀隔离凭据域。 */
export function sealJson<T>(ring: KeyRing, prefix: string, aad: { tenantId: string; id: string }, value: T): { ct: Buffer; keyId: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.current.key, nonce);
  cipher.setAAD(Buffer.from(`${prefix}:${aad.tenantId}:${aad.id}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ct: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]), keyId: ring.current.id };
}

/** 校验器同时挑出允许的字段；错误沿用渠道凭据的固定错误类型，不携带底层异常或明文。 */
export function openJson<T>(
  ring: KeyRing,
  prefix: string,
  aad: { tenantId: string; id: string },
  ct: Buffer,
  keyId: string,
  validate: (value: unknown) => T | null,
): Redacted<T> {
  const key = ring.all.get(keyId);
  if (!key) throw new ChannelSecretError(keyId, '密钥不存在');
  if (ct.length < 28) throw new ChannelSecretError(keyId, '密文长度不足');
  let plaintext: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, ct.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${prefix}:${aad.tenantId}:${aad.id}`, 'utf8'));
    decipher.setAuthTag(ct.subarray(-16));
    plaintext = Buffer.concat([decipher.update(ct.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch {
    throw new ChannelSecretError(keyId, '认证失败');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new ChannelSecretError(keyId, 'JSON 无效');
  }
  let value: T | null;
  try {
    value = validate(parsed);
  } catch {
    throw new ChannelSecretError(keyId, '凭据字段无效');
  }
  if (value === null) throw new ChannelSecretError(keyId, '凭据字段无效');
  return new Redacted(value);
}

function wecomFields(parsed: unknown): WecomSecrets | null {
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('appSecret' in parsed) ||
    typeof parsed.appSecret !== 'string' ||
    !('callbackToken' in parsed) ||
    typeof parsed.callbackToken !== 'string' ||
    !('callbackAesKey' in parsed) ||
    typeof parsed.callbackAesKey !== 'string'
  )
    return null;
  return { appSecret: parsed.appSecret, callbackToken: parsed.callbackToken, callbackAesKey: parsed.callbackAesKey };
}

export function sealSecrets(ring: KeyRing, aad: { tenantId: string; accountId: string }, s: WecomSecrets): { ct: Buffer; keyId: string } {
  return sealJson(
    ring,
    'channel_accounts:v1',
    { tenantId: aad.tenantId, id: aad.accountId },
    {
      appSecret: s.appSecret,
      callbackToken: s.callbackToken,
      callbackAesKey: s.callbackAesKey,
    },
  );
}

export function openSecrets(
  ring: KeyRing,
  aad: { tenantId: string; accountId: string },
  ct: Buffer,
  keyId: string,
): Redacted<WecomSecrets> {
  return openJson(ring, 'channel_accounts:v1', { tenantId: aad.tenantId, id: aad.accountId }, ct, keyId, wecomFields);
}
