// 口令哈希（docs/architecture/01-pg-config-console/spec.md「鉴权 · 口令」）。
// 'scrypt$<logN>$<r>$<p>$<salt>$<hash>'（base64url）：参数随哈希存，换参数不需要迁移，旧哈希照样能校验，
// 登录成功时按当前参数重新哈希（needsRehash）。当前参数 N = 2^17、r = 8、p = 1，16 字节盐、64 字节输出，
// 取 OWASP Password Storage Cheat Sheet 的 scrypt 下限（开放问题 4：目标服务器上单次超过 500 ms 就换等价组合）。
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const CURRENT = { logN: 17, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// N = 2^17、r = 8 要 128 MiB，Node 默认上限 32 MiB，不显式放宽会直接报错
const MAXMEM = 256 * 1024 * 1024;
// 同一时刻最多跑 2 个 scrypt，槽满时排队最多等 2 秒：libuv 线程池默认只有 4 条，全被占满会拖慢文件读写和 DNS
const MAX_CONCURRENT = 2;
const QUEUE_WAIT_MS = 2_000;

/** 排队超时 → 429 */
export class PasswordBusyError extends Error {
  constructor() {
    super('口令校验排队超时，请稍后再试');
  }
}

let running = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const go = (): void => {
      clearTimeout(timer);
      running++;
      resolve();
    };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
      reject(new PasswordBusyError());
    }, QUEUE_WAIT_MS);
    waiting.push(go);
  });
}

function release(): void {
  running--;
  waiting.shift()?.();
}

async function derive(plain: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  await acquire();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const opts: ScryptOptions = { N: 2 ** logN, r, p, maxmem: MAXMEM };
      scrypt(plain, salt, KEY_BYTES, opts, (err, key) => (err ? reject(err) : resolve(key)));
    });
  } finally {
    release();
  }
}

export async function hashPassword(plain: string, opts: { logN?: number; p?: number } = {}): Promise<string> {
  const logN = opts.logN ?? CURRENT.logN;
  const p = opts.p ?? CURRENT.p;
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt, logN, CURRENT.r, p);
  return `scrypt$${logN}$${CURRENT.r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** 参数从 stored 里取；比较用 timingSafeEqual。needsRehash：stored 的参数不是当前参数 */
export async function verifyPassword(plain: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  const m = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return { ok: false, needsRehash: false };
  const [logN, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const expected = Buffer.from(m[5]!, 'base64url');
  const key = await derive(plain, Buffer.from(m[4]!, 'base64url'), logN, r, p);
  const ok = key.length === expected.length && timingSafeEqual(key, expected);
  return { ok, needsRehash: logN !== CURRENT.logN || r !== CURRENT.r || p !== CURRENT.p };
}

/**
 * 邮箱不存在时拿来校验的假哈希，参数与真账号相同：未知邮箱与错误口令都跑一次同样代价的 scrypt，响应时间探测不出邮箱是否存在。
 * 盐和哈希都是进程启动时取的随机字节，不真去算：在请求路径上现算的话，第一个未知邮箱要跑两次 scrypt；
 * 算的时候碰上排队超时，失败还会被缓存下来，之后未知邮箱一律 429、已有邮箱照常 401，反倒成了探测邮箱的办法
 */
const FAKE_HASH = `scrypt$${CURRENT.logN}$${CURRENT.r}$${CURRENT.p}$${randomBytes(SALT_BYTES).toString('base64url')}$${randomBytes(KEY_BYTES).toString('base64url')}`;
export function fakeHash(): string {
  return FAKE_HASH;
}

/** 仅供自测：当前参数与并发状态；occupy 占住一个 scrypt 槽（不跑 scrypt），返回的函数把槽还回去，用来确定地排满队列 */
export const __passwordTest = {
  current: (): Readonly<typeof CURRENT> => CURRENT,
  running: (): number => running,
  async occupy(): Promise<() => void> {
    await acquire();
    let held = true;
    return () => {
      if (held) release();
      held = false;
    };
  },
};
