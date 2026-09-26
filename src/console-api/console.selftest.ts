// 鉴权与后台接口自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」）。库用 PGlite。
// 现在是第 10 步的函数部分（验收 15）：口令哈希、登录与会话、过期、限流、口令升级、平台命令行的账号操作，
// 以及 prod 下后台 SSE 要求会话。后台接口的 HTTP 部分在第 11 步往这里加。
// 用法：npx tsx src/console-api/console.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先设临时 VAR_DIR 再动态 import：server 会连带加载 store.ts，它在加载时就读 VAR_DIR
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-console-selftest-'));
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微

const { openTestDb, installSeededConfig } = await import('../db/testing.js');
const { hashPassword, verifyPassword, fakeHash, __passwordTest } = await import('../auth/password.js');
const session = await import('../auth/session.js');
const accounts = await import('../auth/accounts.js');
const { __profileTest } = await import('../profile.js');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
const errName = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
};

const t = await openTestDb();
await installSeededConfig(t);
/** 平台命令行以 agent_platform 身份连库；做完回到运行时的 agent_app */
async function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
  await t.pg.exec('SET ROLE agent_platform');
  try {
    return await fn();
  } finally {
    await t.pg.exec('SET ROLE agent_app');
  }
}
async function asSuper<T>(fn: () => Promise<T>): Promise<T> {
  await t.pg.exec('RESET ROLE');
  try {
    return await fn();
  } finally {
    await t.pg.exec('SET ROLE agent_app');
  }
}
const pw = (s: string) => async (): Promise<string> => s;
const OWNER = { email: 'Owner@Example.com', password: 'owner-password-1' };
const VIEWER = { email: 'viewer@example.com', password: 'viewer-password-1' };
const base = { ip: '203.0.113.7', userAgent: 'selftest', now: Date.parse('2026-09-26T00:00:00Z') };
const hour = 3_600_000;

// ---------------- 口令 ----------------
{
  const h = await hashPassword('correct horse battery');
  check('口令：格式是 scrypt$17$8$1$<盐>$<哈希>', /^scrypt\$17\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(h), h);
  check(
    '口令：对的口令通过、不需要升级',
    JSON.stringify(await verifyPassword('correct horse battery', h)) === '{"ok":true,"needsRehash":false}',
  );
  check('口令：错的口令不通过', !(await verifyPassword('wrong horse battery', h)).ok);
  check('口令：同一口令两次哈希不同（加盐）', (await hashPassword('correct horse battery')) !== h);
  const old = await hashPassword('old params', { logN: 14 });
  check(
    '口令：旧参数的哈希照样能校验，并标出要升级',
    JSON.stringify(await verifyPassword('old params', old)) === '{"ok":true,"needsRehash":true}',
  );
  check('口令：假哈希与真哈希同一套参数', (await fakeHash()).startsWith('scrypt$17$8$1$') && (await fakeHash()) === (await fakeHash()));
  check('口令：格式不对的哈希一律不通过', !(await verifyPassword('x', 'md5$abc')).ok);
  // 同一时刻最多跑 2 个 scrypt：并发 5 个，采样到的在跑数不超过 2
  let peak = 0;
  const sample = setInterval(() => (peak = Math.max(peak, __passwordTest.running())), 2);
  await Promise.all(Array.from({ length: 5 }, (_, i) => verifyPassword(`p${i}`, h)));
  clearInterval(sample);
  check('口令：并发校验时同一时刻最多跑 2 个', peak > 0 && peak <= 2, String(peak));
}

// ---------------- 平台命令行：账号与成员 ----------------
{
  const created = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: OWNER.email, name: '老板', role: 'owner', password: pw(OWNER.password) }),
  );
  check('账号：user-create 建账号并加为 owner', created.code === 0, created.message);
  const again = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: 'owner@example.com', name: 'x', role: 'owner', password: pw('never-read-1') }),
  );
  check('账号：同一邮箱（大小写不同）同一角色再建 → 已一致', again.code === 0, again.message);
  const other = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: OWNER.email, name: 'x', role: 'viewer', password: pw('never-read-1') }),
  );
  check('账号：已是别的角色 → 退出码 2，没改', other.code === 2, other.message);
  const short = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: 'short@example.com', name: 'x', role: 'agent', password: pw('short') }),
  );
  check('账号：口令太短拒绝', short.code === 1);
  const viewer = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: VIEWER.email, name: '看客', role: 'viewer', password: pw(VIEWER.password) }),
  );
  check('账号：再建一个 viewer', viewer.code === 0);
  const rows = await asSuper(async () => (await t.pg.query<{ h: string }>('select password_hash as h from users')).rows.map((r) => r.h));
  check('账号：库里只有哈希，没有口令明文', rows.every((h) => h.startsWith('scrypt$')) && !JSON.stringify(rows).includes(OWNER.password));
  const audits = await asSuper(
    async () => (await t.pg.query<{ diff: unknown }>(`select diff from audit_log where action = 'platform.user_create'`)).rows,
  );
  check('账号：审计两行、diff 里没有口令', audits.length === 2 && !JSON.stringify(audits).includes('password'), JSON.stringify(audits));
}

// ---------------- 登录与会话 ----------------
session.__authTest.reset();
const loggedIn = await session.login({ ...base, ...OWNER });
{
  check(
    '登录：成功，拿到 43 位 token 与 owner 身份',
    !!loggedIn && /^[A-Za-z0-9_-]{43}$/.test(loggedIn.token) && loggedIn.user.role === 'owner' && loggedIn.user.displayName === '老板',
  );
  const token = loggedIn!.token;
  const stored = await asSuper(async () =>
    (await t.pg.query<{ h: string }>(`select encode(token_hash, 'hex') as h from auth_sessions`)).rows.map((r) => r.h),
  );
  check('登录：库里的 token_hash 就是 cookie 值的 sha256', stored.includes(createHash('sha256').update(token).digest('hex')));
  const everything = await asSuper(async () => {
    const tables = ['tenants', 'users', 'memberships', 'auth_sessions', 'audit_log', 'sop_versions', 'catalog_items'];
    const dumps = await Promise.all(tables.map(async (x) => JSON.stringify((await t.pg.query(`select * from ${x}`)).rows)));
    return dumps.join('\n');
  });
  check('登录：全库搜不到 cookie 明文', !everything.includes(token));
  check(
    '登录：csrf 从 token 派生，同一个 token 恒定、不同 token 不同',
    loggedIn!.user.csrf === session.csrfFor(token) && session.csrfFor(token) !== session.csrfFor(`${token.slice(1)}A`),
  );
  const me = await session.resolveSession(token, base.now + 30 * 60_000);
  check('会话：半小时后仍有效', me?.userId === loggedIn!.user.userId && me.role === 'owner');
  const audit = await asSuper(async () => (await t.pg.query(`select 1 from audit_log where action = 'auth.login'`)).rows.length);
  check('登录：写一行 auth.login 审计', audit === 1);
  check('会话：格式不对的 token 直接 null，不查库', (await session.resolveSession('not-a-token', base.now)) === null);
}

// 过期：最后一次请求之后 12 小时零 1 秒；登录之后 7 天零 1 秒（即使每小时都有请求）。失效的行被删掉
{
  session.__authTest.reset();
  const a = (await session.login({ ...base, ...OWNER }))!;
  const touchedAt = base.now + hour;
  await session.resolveSession(a.token, touchedAt);
  check('过期：空闲 12 小时整仍有效', (await session.resolveSession(a.token, touchedAt + 12 * hour)) !== null);
  const lastSeen = touchedAt + 12 * hour;
  check('过期：最后一次请求之后 12 小时零 1 秒 → null', (await session.resolveSession(a.token, lastSeen + 12 * hour + 1000)) === null);
  const gone = await asSuper(
    async () =>
      (
        await t.pg.query(`select 1 from auth_sessions where token_hash = decode($1, 'hex')`, [
          createHash('sha256').update(a.token).digest('hex'),
        ])
      ).rows.length,
  );
  check('过期：空闲过期的行被删掉', gone === 0);

  session.__authTest.reset();
  const b = (await session.login({ ...base, ...OWNER }))!;
  let alive = true;
  for (let h = 1; h <= 7 * 24; h++) alive = alive && (await session.resolveSession(b.token, base.now + h * hour)) !== null;
  check('过期：7 天内每小时都有请求，一直有效', alive);
  check('过期：登录之后 7 天零 1 秒 → null（绝对期限）', (await session.resolveSession(b.token, base.now + 7 * 24 * hour + 1000)) === null);
  const gone2 = await asSuper(
    async () =>
      (
        await t.pg.query(`select 1 from auth_sessions where token_hash = decode($1, 'hex')`, [
          createHash('sha256').update(b.token).digest('hex'),
        ])
      ).rows.length,
  );
  check('过期：绝对期限过了的行也被删掉', gone2 === 0);
}

// 限流
{
  session.__authTest.reset();
  const attempts: string[] = [];
  for (let i = 0; i < 11; i++) {
    attempts.push(await errName(session.login({ ...base, ip: '198.51.100.1', email: `nobody${i}@example.com`, password: 'x' })));
  }
  check(
    '限流：同一 IP 一分钟内第 11 次登录 → 429',
    attempts.slice(0, 10).every((x) => x === 'ok') && attempts[10] === 'LoginRateLimitedError',
    attempts.join(','),
  );
  check(
    '限流：过了一分钟同一 IP 又能登录',
    (await errName(session.login({ ...base, now: base.now + 61_000, ip: '198.51.100.1', email: 'nobody@example.com', password: 'x' }))) ===
      'ok',
  );

  session.__authTest.reset();
  const wrong = async (email: string, n: number): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      try {
        out.push((await session.login({ ...base, ip: '198.51.100.2', email, password: 'wrong-password' })) === null ? '401' : '200');
      } catch (e) {
        out.push(`${(e as Error).constructor.name}:${(e as Error).message}`);
      }
    }
    return out;
  };
  const real = await wrong(OWNER.email, 6);
  check(
    '限流：同一「邮箱 + IP」15 分钟内第 6 次失败 → 429',
    real.slice(0, 5).every((x) => x === '401') && real[5]!.startsWith('LoginRateLimitedError'),
    real.join(','),
  );
  check('限流：这时 owner 从另一个 IP 用正确口令仍能登录', (await session.login({ ...base, ip: '198.51.100.99', ...OWNER })) !== null);
  session.__authTest.reset(); // 同等条件下比：各自从零计数，免得两轮加起来先撞上按 IP 的上限
  const ghost = await wrong('ghost@example.com', 6);
  check('限流：不存在的邮箱第 6 次的结果与存在的邮箱完全相同', JSON.stringify(ghost) === JSON.stringify(real), ghost.join(','));
  session.__authTest.reset();
  const unknown = await session.login({ ...base, email: 'ghost@example.com', password: OWNER.password });
  const badPassword = await session.login({ ...base, email: OWNER.email, password: 'not-the-password' });
  check('登录：未知邮箱与错误口令的结果相同（都是 null）', unknown === null && badPassword === null);
  // 同一邮箱不分 IP 失败满 10 次后，每次先延迟再校验，不锁死
  session.__authTest.reset();
  session.__authTest.setSlowDelay(150);
  for (let i = 0; i < 10; i++) await session.login({ ...base, ip: `198.51.100.${10 + i}`, email: OWNER.email, password: 'wrong-password' });
  const t0 = Date.now();
  const slow = await session.login({ ...base, ip: '198.51.100.50', ...OWNER });
  check('限流：同一邮箱失败满 10 次后先延迟再校验，但不锁死', slow !== null && Date.now() - t0 >= 150, String(Date.now() - t0));
  session.__authTest.reset();
  check(
    '限流：IPv6 按 /64 归桶',
    session.ipBucket('2001:db8:1:2:aaaa::1') === session.ipBucket('2001:db8:1:2:ffff:1:2:3') &&
      session.ipBucket('2001:db8:1:3::1') !== session.ipBucket('2001:db8:1:2::1'),
  );
  check('限流：IPv4 映射地址还原成 IPv4', session.ipBucket('::ffff:203.0.113.7') === '203.0.113.7');
  let invalidAllowed = 0;
  for (let i = 0; i < 70; i++) {
    if (session.allowSessionLookup('198.51.100.77', base.now)) {
      invalidAllowed++;
      session.noteInvalidSession('198.51.100.77', base.now);
    }
  }
  check('限流：同一 IP 带无效 cookie 每分钟最多查 60 次库', invalidAllowed === 60, String(invalidAllowed));
}

// 旧参数的口令哈希：登录成功后换成当前参数
{
  session.__authTest.reset();
  const oldHash = await hashPassword(VIEWER.password, { logN: 14 });
  await asSuper(() => t.pg.query('update users set password_hash = $1 where lower(email) = $2', [oldHash, VIEWER.email]));
  const v = await session.login({ ...base, ...VIEWER });
  const after = await asSuper(
    async () =>
      (await t.pg.query<{ h: string }>('select password_hash as h from users where lower(email) = $1', [VIEWER.email])).rows[0]!.h,
  );
  check(
    '口令升级：旧参数的哈希登录成功后换成当前参数',
    v !== null && after.startsWith('scrypt$17$') && after !== oldHash && (await verifyPassword(VIEWER.password, after)).ok,
  );
}

// 账号操作吊销会话
{
  session.__authTest.reset();
  const s1 = (await session.login({ ...base, ...VIEWER }))!;
  const role = await asPlatform(() => accounts.setRole(t.db, { tenantSlug: 'demo', email: VIEWER.email, role: 'agent' }));
  check(
    '成员：member-role 改角色，会话里的角色跟着变',
    role.code === 0 && (await session.resolveSession(s1.token, base.now + 60_000))?.role === 'agent',
  );
  const newPw = await asPlatform(() =>
    accounts.setPassword(t.db, { tenantSlug: 'demo', email: VIEWER.email, password: pw('viewer-password-2') }),
  );
  check(
    '账号：user-password 改口令并吊销全部会话',
    newPw.code === 0 && (await session.resolveSession(s1.token, base.now + 120_000)) === null,
  );
  check(
    '账号：新口令能登录、旧口令不能',
    (await session.login({ ...base, email: VIEWER.email, password: 'viewer-password-2' })) !== null &&
      (await session.login({ ...base, ...VIEWER })) === null,
  );
  const s2 = (await session.login({ ...base, email: VIEWER.email, password: 'viewer-password-2' }))!;
  const disabled = await asPlatform(() => accounts.disable(t.db, { tenantSlug: 'demo', email: VIEWER.email }));
  check(
    '账号：user-disable 之后已有的会话立即失效',
    disabled.code === 0 && (await session.resolveSession(s2.token, base.now + 60_000)) === null,
  );
  const leftRows = await asSuper(
    async () =>
      (await t.pg.query(`select 1 from auth_sessions s join users u on u.id = s.user_id where lower(u.email) = $1`, [VIEWER.email])).rows
        .length,
  );
  check('账号：user-disable 把会话行也删了（不只是认证函数不认）', leftRows === 0, String(leftRows));
  check('账号：停用之后登录不了', (await session.login({ ...base, email: VIEWER.email, password: 'viewer-password-2' })) === null);
  const o = (await session.login({ ...base, ip: '198.51.100.200', ...OWNER }))!;
  const removed = await asPlatform(() => accounts.removeMember(t.db, { tenantSlug: 'demo', email: OWNER.email }));
  check(
    '成员：member-remove 删成员关系并吊销本租户的会话',
    removed.code === 0 && (await session.resolveSession(o.token, base.now + 60_000)) === null,
  );
  check('成员：不是成员了就登录不了', (await session.login({ ...base, ip: '198.51.100.201', ...OWNER })) === null);
  check(
    '成员：对不是成员的人操作 → 退出码 1',
    (await asPlatform(() => accounts.setRole(t.db, { tenantSlug: 'demo', email: OWNER.email, role: 'admin' }))).code === 1,
  );
  const readd = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: OWNER.email, name: '老板', role: 'owner', password: pw('never-read-1') }),
  );
  check(
    '成员：已有账号再 user-create 只加回成员关系，不碰口令',
    readd.code === 0 && (await session.login({ ...base, ip: '198.51.100.202', ...OWNER })) !== null,
  );
  const platformAudits = await asSuper(async () =>
    (await t.pg.query<{ action: string }>(`select action from audit_log where action like 'platform.%' order by id`)).rows.map(
      (r) => r.action,
    ),
  );
  check(
    '账号：每个平台操作各有一行审计',
    ['platform.member_role', 'platform.user_password', 'platform.user_disable', 'platform.member_remove'].every((a) =>
      platformAudits.includes(a),
    ),
    platformAudits.join(','),
  );
  const lo = (await session.login({ ...base, ip: '198.51.100.203', ...OWNER }))!;
  await session.logout(lo.token, base.now + 1000);
  const outAudit = await asSuper(async () => (await t.pg.query(`select 1 from audit_log where action = 'auth.logout'`)).rows.length);
  check('登出：删掉会话、写一行 auth.logout 审计', (await session.resolveSession(lo.token, base.now + 2000)) === null && outAudit === 1);
}

// prod 下后台 SSE 要求有效的后台会话（demo 下照旧匿名可连）
{
  session.__authTest.reset();
  const { app } = await import('../server.js');
  const o = (await session.login({ ...base, now: Date.now(), ip: '198.51.100.210', ...OWNER }))!;
  const open = async (cookie?: string): Promise<number> => {
    const res = await app.request('/api/admin/stream', { headers: cookie ? { cookie } : {} });
    await res.body?.cancel();
    return res.status;
  };
  check('SSE：demo 下匿名照旧能连', (await open()) === 200);
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  try {
    check('SSE：prod 下匿名连 → 401', (await open()) === 401);
    check('SSE：prod 下带无效会话 → 401', (await open(`${session.SESSION_COOKIE}=${'A'.repeat(43)}`)) === 401);
    check('SSE：prod 下带有效后台会话能连上', (await open(`${session.SESSION_COOKIE}=${o.token}`)) === 200);
  } finally {
    __profileTest.reset();
  }
}

await t.close();
if (fails.length) {
  console.error(`CONSOLE SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `CONSOLE SELFTEST PASS: ${pass} 项断言全通（口令哈希与并发上限 / 平台账号命令行 / 登录与会话 / 空闲与绝对过期 / 三路限流与防探测 / 口令升级 / 吊销会话 / prod 下后台 SSE 要求会话）`,
);
process.exit(0);
