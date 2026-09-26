// 鉴权与后台接口自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」）。库用 PGlite。
// 前半是函数层（验收 15）：口令哈希、登录与会话、过期、限流、口令升级、平台命令行的账号操作，以及 prod 下后台 SSE 要求会话。
// 后半走 server.ts 的 app.request（子应用挂在真实位置上）：验收 5、6、9、15、16 的 HTTP 部分。
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

const { openTestDb, installSeededConfig, fakeLock, testConfigDeps } = await import('../db/testing.js');
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
  // 假哈希不在请求路径上现算：口令队列排满时照样立刻拿得到，也不会把一次排队超时缓存下来（那样之后未知邮箱一律 429、
  // 已有邮箱 401，成了探测邮箱的办法）。用一份全新的模块实例：它的假哈希还没取过，队列也是它自己的，占满两个槽
  const fresh = (await import(new URL('../auth/password.js?fresh', import.meta.url).href)) as typeof import('../auth/password.js');
  const held = [await fresh.__passwordTest.occupy(), await fresh.__passwordTest.occupy()];
  const during = await errName(Promise.resolve().then(() => fresh.fakeHash()));
  for (const giveBack of held) giveBack();
  const after = await errName(Promise.resolve().then(() => fresh.fakeHash()));
  check(
    '口令：队列排满时照样拿得到假哈希，之后也拿得到（排队超时不会被缓存下来）',
    during === 'ok' && after === 'ok',
    `${during} / ${after}`,
  );
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
  // 口令至少 10 个字符（plan 第 10 步取定）：user-create 与 user-password 都卡在 9 与 10 之间
  const MIN = 'min@example.com';
  const nine = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: MIN, name: '最短', role: 'agent', password: pw('123456789') }),
  );
  const ten = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: MIN, name: '最短', role: 'agent', password: pw('1234567890') }),
  );
  check('账号：user-create 口令 9 个字符拒绝、10 个字符接受', nine.code === 1 && ten.code === 0, `${nine.message} / ${ten.message}`);
  const setNine = await asPlatform(() => accounts.setPassword(t.db, { tenantSlug: 'demo', email: MIN, password: pw('abcdefghi') }));
  const setTen = await asPlatform(() => accounts.setPassword(t.db, { tenantSlug: 'demo', email: MIN, password: pw('abcdefghij') }));
  check(
    '账号：user-password 口令 9 个字符拒绝、10 个字符接受',
    setNine.code === 1 && setTen.code === 0,
    `${setNine.message} / ${setTen.message}`,
  );
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
  for (let i = 0; i < 70; i++) if (session.claimSessionLookup('198.51.100.77', base.now)) invalidAllowed++;
  check('限流：同一 IP 带无效 cookie 每分钟最多查 60 次库', invalidAllowed === 60, String(invalidAllowed));
  for (let i = 0; i < 70; i++) session.claimSessionLookup('198.51.100.78', base.now)?.();
  check('限流：会话有效的查库把名额退回去，不算进无效 cookie', session.claimSessionLookup('198.51.100.78', base.now) !== null);

  // 并发：失败计数在校验之前同步占好，同一时刻在途的一批不会都看到旧计数
  session.__authTest.reset();
  const burst = await Promise.all(
    Array.from({ length: 10 }, () =>
      errName(session.login({ ...base, ip: '198.51.100.3', email: OWNER.email, password: 'wrong-password' })),
    ),
  );
  check(
    '限流：同一「邮箱 + IP」并发 10 次错误口令，只有 5 次去校验，其余 429',
    burst.filter((x) => x === 'ok').length === 5 && burst.filter((x) => x === 'LoginRateLimitedError').length === 5,
    burst.join(','),
  );
  session.__authTest.reset();
  session.__authTest.setSlowDelay(1_000);
  for (let i = 0; i < 9; i++) await session.login({ ...base, ip: `198.51.100.${60 + i}`, email: OWNER.email, password: 'wrong-password' });
  const took = await Promise.all(
    [70, 71, 72].map(async (n) => {
      const t0 = Date.now();
      await session.login({ ...base, ip: `198.51.100.${n}`, email: OWNER.email, password: 'wrong-password' });
      return Date.now() - t0;
    }),
  );
  check('限流：同一邮箱已失败 9 次时并发 3 次，第 11、12 次照样先延迟', took.filter((ms) => ms >= 1_000).length === 2, took.join(','));

  // 登录失败只打日志、不进审计：每次一行，带原因、来源与邮箱的哈希，不带口令，也不带邮箱原文
  session.__authTest.reset();
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]): void => void logged.push(a.map(String).join(' '));
  try {
    for (let i = 0; i < 6; i++)
      await errName(session.login({ ...base, ip: '198.51.100.4', email: OWNER.email, password: 'wrong-password-9' }));
  } finally {
    console.warn = warn;
  }
  const tag = createHash('sha256').update(OWNER.email.toLowerCase()).digest('hex').slice(0, 12);
  check(
    '登录失败：5 次口令不对、1 次被锁各打一行日志，带来源与邮箱的哈希，不带口令和邮箱原文',
    logged.length === 6 &&
      logged.every((l) => l.startsWith('[auth] 登录失败') && l.includes('198.51.100.4') && l.includes(tag)) &&
      logged.slice(0, 5).every((l) => l.includes('口令不对')) &&
      logged[5]!.includes('锁') &&
      !logged.join('').includes('wrong-password-9') &&
      !logged.join('').toLowerCase().includes(OWNER.email.toLowerCase()),
    logged.join(' | '),
  );
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
  // 改口令与登录并发：登录读完旧哈希、还在跑 scrypt 时 user-password 改了口令并吊销会话，这次登录不能在吊销之后再建出会话
  {
    const repo = await import('../db/repo/auth.js');
    const RACE = { email: 'race@example.com', password: 'race-password-1' };
    await asPlatform(() =>
      accounts.createUser(t.db, { tenantSlug: 'demo', email: RACE.email, name: '赛跑', role: 'viewer', password: pw(RACE.password) }),
    );
    const newHash = await hashPassword('race-password-2');
    const pending = session.login({ ...base, ip: '198.51.100.150', ...RACE });
    for (let i = 0; i < 2_000 && __passwordTest.running() === 0; i++) await new Promise((r) => setTimeout(r, 1));
    // 这时登录已读完哈希、正在跑 scrypt。按 user-password 的顺序：先改哈希，再删会话
    const revoked = await asPlatform(async () => {
      const u = (await repo.findUserByEmail(t.db, RACE.email))!;
      await repo.setUserPassword(t.db, u.id, newHash);
      return repo.deleteSessionsOfUser(t.db, u.id);
    });
    const raced = await pending;
    const left = await asSuper(
      async () =>
        (await t.pg.query(`select 1 from auth_sessions s join users u on u.id = s.user_id where lower(u.email) = $1`, [RACE.email])).rows
          .length,
    );
    check('改口令与登录并发：scrypt 期间口令被改、会话被吊销，这次登录失败，不留会话', raced === null && left === 0, `${revoked} ${left}`);
  }
  // 口令升级与登录并发：登录还在跑 scrypt 时，另一次成功的登录把同一个口令升级成当前参数，这次登录不能因为哈希变了就回 401
  {
    const repo = await import('../db/repo/auth.js');
    const { configRuntime } = await import('../config/source.js');
    const REH = { email: 'rehash-race@example.com', password: 'rehash-password-1' };
    await asPlatform(() =>
      accounts.createUser(t.db, { tenantSlug: 'demo', email: REH.email, name: '升级', role: 'viewer', password: pw(REH.password) }),
    );
    const oldHash = await hashPassword(REH.password, { logN: 14 });
    const newHash = await hashPassword(REH.password);
    await asSuper(() => t.pg.query('update users set password_hash = $1 where lower(email) = $2', [oldHash, REH.email]));
    const { tenantId } = configRuntime();
    const userId = (await repo.authLoginLookup(t.db, tenantId, REH.email))!.userId;
    session.__authTest.reset();
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]): void => void logged.push(a.map(String).join(' '));
    let rehashed = false;
    let won: Awaited<ReturnType<typeof session.login>> = null;
    try {
      const pending = session.login({ ...base, ip: '198.51.100.151', ...REH });
      for (let i = 0; i < 2_000 && __passwordTest.running() === 0; i++) await new Promise((r) => setTimeout(r, 1));
      // 这时登录已读完旧哈希、正在跑 scrypt：照并发那次成功登录的做法，按比较交换把旧哈希换成同一口令的新参数哈希
      rehashed = await repo.authPasswordRehash(t.db, tenantId, userId, oldHash, newHash);
      won = await pending;
    } finally {
      console.warn = warn;
    }
    const after = await asSuper(
      async () => (await t.pg.query<{ h: string }>('select password_hash as h from users where lower(email) = $1', [REH.email])).rows[0]!.h,
    );
    check(
      '口令升级与登录并发：scrypt 期间哈希被升级成同一口令，这次登录照样成功，会话有效，不打失败日志',
      rehashed &&
        won !== null &&
        (await session.resolveSession(won.token, base.now + 60_000)) !== null &&
        after === newHash &&
        logged.length === 0,
      `${rehashed} ${won !== null} ${after === newHash} ${logged.join(' | ')}`,
    );
  }
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
  // 同一个人在另一个租户里的会话（04 同库多租户时才会有）：member-remove 只吊销本租户的
  const otherTenant = await asSuper(async () => {
    const id = (
      await t.pg.query<{ id: string }>(`insert into tenants (slug, name, pack_id) values ('other-tenant', '别家', 'travel') returning id`)
    ).rows[0]!.id;
    await t.pg.query(
      `insert into auth_sessions (token_hash, tenant_id, user_id, created_at, last_seen_at, expires_at)
       select decode($1, 'hex'), $2, id, now(), now(), now() + interval '7 days' from users where lower(email) = $3`,
      ['07'.repeat(32), id, OWNER.email.toLowerCase()],
    );
    return id;
  });
  const removed = await asPlatform(() => accounts.removeMember(t.db, { tenantSlug: 'demo', email: OWNER.email }));
  check(
    '成员：member-remove 删成员关系并吊销本租户的会话',
    removed.code === 0 && (await session.resolveSession(o.token, base.now + 60_000)) === null,
  );
  const otherLeft = await asSuper(async () => {
    const n = (await t.pg.query(`select 1 from auth_sessions where tenant_id = $1`, [otherTenant])).rows.length;
    await t.pg.query(`delete from auth_sessions where tenant_id = $1`, [otherTenant]);
    await t.pg.query(`delete from tenants where id = $1`, [otherTenant]);
    return n;
  });
  check('成员：member-remove 不动这个人在别的租户里的会话', otherLeft === 1, String(otherLeft));
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

// ---------------- 后台接口（HTTP）：验收 5、6、9、15、16 的 HTTP 部分 ----------------
const { app } = await import('../server.js');
const { __consoleTest } = await import('./app.js');
const { queryCount } = await import('../db/client.js');
const cfg = await import('../config/source.js');
const { observeRequests } = await import('../llm.js');
const { numEnv } = await import('../env.js');
const { sectionBody, TRAVEL_SOP_SECTIONS } = await import('../sop/sections.js');

const NL = String.fromCharCode(10);
const ADMIN = { email: 'admin@example.com', password: 'admin-password-1', name: '后台管理员甲' };
const READER = { email: 'reader@example.com', password: 'reader-password-1', name: '只读乙' };
type Body = Record<string, any>;
interface Res {
  status: number;
  body: Body;
  text: string;
  headers: Headers;
}
interface Who {
  token: string;
  csrf: string;
}

/** 走 server.ts 的 app（子应用挂在真实位置上）；x-forwarded-for 当客户端地址（app.request 没有对端） */
async function call(
  method: string,
  url: string,
  o: { as?: Who; noCsrf?: boolean; json?: unknown; headers?: Record<string, string>; ip?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? '203.0.113.80' };
  if (o.as) {
    headers.cookie = `${session.SESSION_COOKIE}=${o.as.token}`;
    if (!o.noCsrf) headers['x-csrf'] = o.as.csrf;
  }
  let body: string | undefined;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  Object.assign(headers, o.headers);
  const res = await app.request(`/api/console${url}`, { method, headers, body });
  const text = await res.text();
  let parsed: Body = {};
  try {
    parsed = JSON.parse(text) as Body;
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
async function httpLogin(email: string, password: string, ip = '203.0.113.81'): Promise<Res & Who> {
  const r = await call('POST', '/auth/login', { json: { email, password }, ip });
  const token = /^__Host-sid=([A-Za-z0-9_-]{43});/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return { ...r, token, csrf: typeof r.body.csrf === 'string' ? r.body.csrf : '' };
}
const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'";
const secured = (h: Headers): boolean =>
  h.get('content-security-policy') === CSP && h.get('cache-control') === 'no-store' && h.get('x-content-type-options') === 'nosniff';
/** 各种状态码的响应，最后统一查安全头 */
const seen: Res[] = [];
const keep = <T extends Res>(r: T): T => {
  seen.push(r);
  return r;
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const bodyOf = (sections: readonly { key: string; text: string }[], key: string): string =>
  sectionBody(
    sections.find((s) => s.key === key)!,
    TRAVEL_SOP_SECTIONS.find((s) => s.key === key)!,
  );

session.__authTest.reset();
__consoleTest.reset();
for (const [u, role] of [
  [ADMIN, 'admin'],
  [READER, 'viewer'],
] as const) {
  const r = await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: u.email, name: u.name, role, password: pw(u.password) }),
  );
  check(`HTTP 准备：建一个 ${role}`, r.code === 0, r.message);
}

// 验收 15：登录、cookie、/me
{
  const r = keep(await httpLogin(OWNER.email, OWNER.password));
  const sc = r.headers.get('set-cookie') ?? '';
  check(
    'HTTP 登录：200，Set-Cookie 是 __Host-sid=…; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800，没有 Domain',
    r.status === 200 && r.token.length === 43 && sc === `__Host-sid=${r.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    sc,
  );
  check(
    'HTTP 登录：响应体带 csrf（从 token 派生）与角色，不带 token',
    r.body.csrf === session.csrfFor(r.token) && r.body.role === 'owner' && r.body.tenantSlug === 'demo' && !r.text.includes(r.token),
  );
  const stored = await asSuper(async () =>
    (await t.pg.query<{ h: string }>(`select encode(token_hash, 'hex') as h from auth_sessions`)).rows.map((x) => x.h),
  );
  check('HTTP 登录：库里的 token_hash 是 cookie 值的 sha256', stored.includes(sha(r.token)));
  const me = keep(await call('GET', '/me', { as: r }));
  check(
    '/me：带 cookie → 200，本人与 csrf',
    me.status === 200 && me.body.displayName === '老板' && me.body.role === 'owner' && me.body.csrf === r.csrf,
  );
  check('/me：不带 cookie → 401', keep(await call('GET', '/me')).status === 401);
  check('/me：cookie 是乱写的 → 401', (await call('GET', '/me', { as: { token: 'A'.repeat(43), csrf: '' } })).status === 401);
  const plain = keep(
    await call('POST', '/auth/login', {
      json: { email: OWNER.email, password: OWNER.password },
      headers: { 'content-type': 'text/plain' },
    }),
  );
  check(
    'HTTP 登录：content-type 不是 application/json → 415，不发 cookie',
    plain.status === 415 && plain.headers.get('set-cookie') === null,
  );
  const cross = await call('POST', '/auth/login', {
    json: { email: OWNER.email, password: OWNER.password },
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  check('HTTP 登录：Sec-Fetch-Site: cross-site → 403', cross.status === 403 && cross.headers.get('set-cookie') === null);
  const missing = keep(await call('POST', '/auth/login', { json: { email: OWNER.email } }));
  check(
    'HTTP 登录：请求体缺字段 → 400 并点名',
    missing.status === 400 && missing.body.error === 'bad_request' && JSON.stringify(missing.body.issues).includes('password'),
    missing.text,
  );
  const broken = await app.request('/api/console/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '1' },
    body: '{',
  });
  check('HTTP 登录：JSON 写坏了 → 400', broken.status === 400 && ((await broken.json()) as Body).error === 'bad_request');
  // 库存不下的字符（NUL、孤立代理项）在请求校验这一层拦下，不带进库里报错成 500
  const nulEmail = keep(
    await call('POST', '/auth/login', { json: { email: `a${String.fromCharCode(0)}@example.com`, password: 'whatever-1' } }),
  );
  const loneEmail = await call('POST', '/auth/login', {
    json: { email: `a${String.fromCharCode(0xd800)}@example.com`, password: 'whatever-1' },
  });
  check(
    'HTTP 登录：邮箱里有 NUL 或孤立代理项 → 400 bad_request',
    [nulEmail, loneEmail].every((r) => r.status === 400 && r.body.error === 'bad_request'),
    `${nulEmail.text} / ${loneEmail.text}`,
  );
}

// 验收 15：假时钟下的空闲与绝对过期
{
  session.__authTest.reset();
  const T0 = Date.parse('2026-10-01T00:00:00Z');
  const at = (ms: number): void => __consoleTest.setClock(() => ms);
  at(T0);
  const a = await httpLogin(OWNER.email, OWNER.password);
  at(T0 + 12 * hour);
  const idleOk = (await call('GET', '/me', { as: a })).status;
  at(T0 + 24 * hour + 1000);
  const idleGone = (await call('GET', '/me', { as: a })).status;
  check(
    'HTTP 过期：空闲 12 小时整仍 200，最后一次请求之后 12 小时零 1 秒 → 401',
    idleOk === 200 && idleGone === 401,
    `${idleOk},${idleGone}`,
  );
  at(T0);
  const b = await httpLogin(OWNER.email, OWNER.password);
  const alive: number[] = [];
  for (let h = 11; h < 168; h += 11) {
    at(T0 + h * hour);
    alive.push((await call('GET', '/me', { as: b })).status);
  }
  at(T0 + 168 * hour + 1000);
  const hardGone = (await call('GET', '/me', { as: b })).status;
  check(
    'HTTP 过期：每 11 小时有请求一直 200，登录之后 7 天零 1 秒 → 401',
    alive.every((s) => s === 200) && hardGone === 401,
    `${alive.join(',')} → ${hardGone}`,
  );
  const left = await asSuper(
    async () =>
      (
        await t.pg.query(`select 1 from auth_sessions where token_hash in (decode($1, 'hex'), decode($2, 'hex'))`, [
          sha(a.token),
          sha(b.token),
        ])
      ).rows.length,
  );
  check('HTTP 过期：失效的两行都被删掉', left === 0, String(left));
  __consoleTest.reset();
}

// 验收 15：限流与防探测
{
  session.__authTest.reset();
  const perIp: number[] = [];
  for (let i = 0; i < 11; i++) {
    perIp.push(
      (await call('POST', '/auth/login', { json: { email: `nobody${i}@example.com`, password: 'x' }, ip: '198.51.100.31' })).status,
    );
  }
  check('HTTP 限流：同一 IP 一分钟内第 11 次登录 → 429', perIp.slice(0, 10).every((s) => s === 401) && perIp[10] === 429, perIp.join(','));

  const failSix = async (email: string): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = keep(await call('POST', '/auth/login', { json: { email, password: 'wrong-password' }, ip: '198.51.100.32' }));
      out.push(`${r.status} ${r.text}`);
    }
    return out;
  };
  session.__authTest.reset();
  const real = await failSix(OWNER.email);
  check(
    'HTTP 限流：同一「邮箱 + IP」15 分钟内第 6 次失败 → 429',
    real.slice(0, 5).every((x) => x.startsWith('401 ')) && real[5]!.startsWith('429 '),
    real.join(' | '),
  );
  check(
    'HTTP 限流：这时 owner 从另一个 IP 用正确口令仍能登录',
    (await httpLogin(OWNER.email, OWNER.password, '198.51.100.33')).status === 200,
  );
  session.__authTest.reset();
  const ghost = await failSix('ghost@example.com');
  check(
    'HTTP 限流：不存在的邮箱连续失败，每一次的状态码与响应体都和存在的邮箱相同',
    JSON.stringify(ghost) === JSON.stringify(real),
    ghost.join(' | '),
  );
  session.__authTest.reset();
  const unknown = await call('POST', '/auth/login', { json: { email: 'ghost@example.com', password: OWNER.password } });
  const wrong = await call('POST', '/auth/login', { json: { email: OWNER.email, password: 'not-the-password' } });
  check(
    'HTTP 登录：未知邮箱与错误口令的状态码和响应体相同',
    unknown.status === 401 && wrong.status === 401 && unknown.text === wrong.text,
    `${unknown.text} / ${wrong.text}`,
  );
  // 口令队列排满（两个槽都占住）：未知邮箱与已有邮箱都在排满 2 秒后 429 busy，状态码与响应体相同，各打一行日志
  session.__authTest.reset();
  const held = [await __passwordTest.occupy(), await __passwordTest.occupy()];
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]): void => void logged.push(a.map(String).join(' '));
  let busy: Res[] = [];
  try {
    busy = await Promise.all([
      call('POST', '/auth/login', { json: { email: 'ghost@example.com', password: 'wrong-password' }, ip: '198.51.100.34' }),
      call('POST', '/auth/login', { json: { email: OWNER.email, password: 'wrong-password' }, ip: '198.51.100.35' }),
    ]);
  } finally {
    console.warn = warn;
    for (const giveBack of held) giveBack();
  }
  check(
    'HTTP 登录：口令队列排满时未知邮箱与已有邮箱都是 429 busy，响应体相同',
    busy.length === 2 && busy.every((r) => keep(r).status === 429 && r.body.error === 'busy') && busy[0]!.text === busy[1]!.text,
    busy.map((r) => `${r.status} ${r.text}`).join(' | '),
  );
  check('登录失败：排队超时也打日志', logged.filter((l) => l.includes('排队超时')).length === 2, logged.join(' | '));
}

// 带无效 cookie 的请求先按 IP 限流再查库：同一 IP 前 60 次查库，第 61 次不查库直接当匿名
{
  session.__authTest.reset();
  const bogus = { token: 'C'.repeat(43), csrf: '' };
  const perCall: number[] = [];
  for (let i = 0; i < 61; i++) {
    const q = queryCount();
    const r = await call('GET', '/me', { as: bogus, ip: '198.51.100.140' });
    perCall.push(r.status === 401 ? queryCount() - q : -1);
  }
  check(
    'HTTP 无效 cookie：同一 IP 前 60 次各查一次库，第 61 次不查库，都是 401',
    perCall.slice(0, 60).every((n) => n > 0) && perCall[60] === 0,
    perCall.join(','),
  );
  // 并发一批：名额在查库之前同步占好，在途的一批不会都看到旧计数
  session.__authTest.reset();
  const q0 = queryCount();
  const burst = await Promise.all(
    Array.from({ length: 70 }, (_, i) =>
      call('GET', '/me', { as: { token: `${'D'.repeat(40)}${String(i).padStart(3, '0')}`, csrf: '' }, ip: '198.51.100.141' }),
    ),
  );
  const lookups = (queryCount() - q0) / perCall[0]!;
  check(
    'HTTP 无效 cookie：同一 IP 并发 70 个，只查 60 次库，都是 401',
    lookups === 60 && burst.every((r) => r.status === 401),
    `${lookups} ${burst.map((r) => r.status).join(',')}`,
  );
}

session.__authTest.reset();
const owner = await httpLogin(OWNER.email, OWNER.password);
const admin = await httpLogin(ADMIN.email, ADMIN.password);
const reader = await httpLogin(READER.email, READER.password);
const O = { as: owner };
check(
  'HTTP 准备：owner、admin、viewer 都登录上了',
  owner.status === 200 && admin.body.role === 'admin' && reader.body.role === 'viewer',
  `${owner.status} ${admin.text} ${reader.text}`,
);

// 验收 15：CSRF
{
  const noCsrf = keep(await call('POST', '/sop/draft/check', { as: owner, noCsrf: true }));
  const wrongCsrf = await call('POST', '/sop/draft/check', { as: { token: owner.token, csrf: session.csrfFor('B'.repeat(43)) } });
  const othersCsrf = await call('POST', '/sop/draft/check', { as: { token: owner.token, csrf: admin.csrf } });
  const cross = keep(await call('POST', '/sop/draft/check', { ...O, headers: { 'sec-fetch-site': 'cross-site' } }));
  const sameSite = await call('POST', '/sop/draft/check', { ...O, headers: { 'sec-fetch-site': 'same-site' } });
  const ok = await call('POST', '/sop/draft/check', { ...O, headers: { 'sec-fetch-site': 'same-origin' } });
  check('CSRF：写请求缺 x-csrf → 403', noCsrf.status === 403 && noCsrf.body.error === 'csrf');
  check('CSRF：x-csrf 不对、拿别人的 → 403', wrongCsrf.status === 403 && othersCsrf.status === 403 && othersCsrf.body.error === 'csrf');
  check('CSRF：带 Sec-Fetch-Site: cross-site → 403（csrf 对也不行）', cross.status === 403 && cross.body.error === 'cross_site');
  check('CSRF：same-site（兄弟子域）也算跨站 → 403', sameSite.status === 403);
  check(
    'CSRF：同源、x-csrf 对 → 过了这一关（还没有草稿 → 404）',
    ok.status === 404 && ok.body.error === 'not_found',
    `${ok.status} ${ok.text}`,
  );
}

// 验收 15：权限矩阵、登出、停用
{
  const cur = (await call('GET', '/sop', { as: reader })).body;
  check('权限：viewer 能读 SOP（完整的，不是投影）', typeof cur.published?.id === 'string' && Array.isArray(cur.spec));
  check(
    '权限：viewer 能读产品库、状态、版本历史',
    (await call('GET', '/catalog/route', { as: reader })).status === 200 &&
      (await call('GET', '/status', { as: reader })).body.tenantSlug === 'demo' &&
      (await call('GET', '/sop/versions', { as: reader })).status === 200,
  );
  const code = cfg.currentCatalog().routes[0]!.id;
  const denied = [
    await call('POST', '/sop/draft/publish', { as: reader, json: { rev: 1, changeNote: '想发布' } }),
    await call('PUT', '/sop/draft', { as: reader, json: { basedOn: cur.published.id, rev: null, edits: [{ key: 'tone', body: 'x' }] } }),
    await call('POST', '/sop/draft/check', { as: reader }),
    await call('POST', '/sop/draft/discard', { as: reader, json: { rev: 1 } }),
    await call('POST', `/sop/versions/${cur.published.id}/rollback`, { as: reader, json: { changeNote: 'x' } }),
    await call('POST', '/catalog/route', { as: reader, json: { payload: {} } }),
    await call('PATCH', `/catalog/route/${code}`, { as: reader, json: { rev: 1, set: {} } }),
    await call('POST', `/catalog/route/${code}/activate`, { as: reader, json: { rev: 1 } }),
    await call('GET', '/audit', { as: reader }),
  ];
  keep(denied[0]!);
  check(
    '权限：viewer 发布、保存、检查、丢弃、回滚、上新、编辑、上架、看审计 → 一律 403',
    denied.every((r) => r.status === 403 && r.body.error === 'forbidden'),
    denied.map((r) => r.status).join(','),
  );
  check('权限：admin 能看审计', (await call('GET', '/audit', { as: admin })).status === 200);
  check('权限：接口上没有删除和下架（DELETE → 404）', keep(await call('DELETE', `/catalog/route/${code}`, O)).status === 404);

  const lo = await httpLogin(ADMIN.email, ADMIN.password, '203.0.113.82');
  const out = await call('POST', '/auth/logout', { as: lo });
  check(
    '登出：200，cookie 清掉（Max-Age=0）',
    out.status === 200 && out.headers.get('set-cookie') === '__Host-sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    out.headers.get('set-cookie') ?? '',
  );
  check(
    '登出：之后这个 token → 401，别的会话不受影响',
    (await call('GET', '/me', { as: lo })).status === 401 && (await call('GET', '/me', { as: admin })).status === 200,
  );
  check('登出：没有会话 → 401', (await call('POST', '/auth/logout')).status === 401);

  const disabled = await asPlatform(() => accounts.disable(t.db, { tenantSlug: 'demo', email: READER.email }));
  check(
    '停用：user-disable 之后该用户已有的会话立即 401',
    disabled.code === 0 && (await call('GET', '/me', { as: reader })).status === 401,
  );
}

// 验收 5：发布生效、回滚、审计
{
  const auditCount = async (action: string): Promise<number> =>
    ((await call('GET', `/audit?limit=100&action=${action}`, O)).body.items as unknown[]).length;
  const v1 = (await call('GET', '/sop', O)).body.published as Body;
  const publishesBefore = await auditCount('sop.publish');
  const saved = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: v1.id, rev: null, edits: [{ key: 'tone', body: `${bodyOf(v1.sections, 'tone')}${NL}后台这一句是 HTTP 加的。` }] },
  });
  check(
    'SOP HTTP：保存草稿 → 200，是 draft、基于当前版本',
    saved.status === 200 && saved.body.status === 'draft' && saved.body.basedOn === v1.id,
    saved.text.slice(0, 200),
  );
  const overview = (await call('GET', '/sop', O)).body;
  check(
    'SOP HTTP：概览里有草稿、没过期、预算在限内',
    overview.draft?.id === saved.body.id && overview.draft.stale === false && overview.budget.chars <= overview.budget.limit,
  );
  const checked = await call('POST', '/sop/draft/check', O);
  check(
    'SOP HTTP：检查 → 200，没有 violation',
    checked.status === 200 && checked.body.violations?.length === 0 && checked.body.rebase?.needed === false,
  );
  const noNote = keep(await call('POST', '/sop/draft/publish', { ...O, json: { rev: saved.body.rev, changeNote: '  ' } }));
  check('SOP HTTP：变更说明为空 → 422', noNote.status === 422 && noNote.body.error === 'invalid_sop');
  const nulNote = await call('POST', '/sop/draft/publish', {
    ...O,
    json: { rev: saved.body.rev, changeNote: `发布${String.fromCharCode(0)}` },
  });
  const nulBack = await call('POST', `/sop/versions/${v1.id}/rollback`, { ...O, json: { changeNote: `回滚${String.fromCharCode(0)}` } });
  check(
    'SOP HTTP：变更说明里有 NUL → 发布、回滚都是 400 bad_request，已发布版本不变',
    nulNote.status === 400 && nulBack.status === 400 && nulNote.body.error === 'bad_request' && cfg.currentSop().versionNo === v1.versionNo,
    `${nulNote.text} / ${nulBack.text}`,
  );
  const staleRev = keep(await call('POST', '/sop/draft/publish', { ...O, json: { rev: saved.body.rev + 5, changeNote: '发布' } }));
  check('SOP HTTP：rev 对不上 → 409', staleRev.status === 409 && staleRev.body.error === 'rev_conflict');
  const pub = await call('POST', '/sop/draft/publish', { as: admin, json: { rev: saved.body.rev, changeNote: '后台加一句' } });
  const health = (await (await app.request('/healthz')).json()) as Body;
  check(
    'SOP HTTP：发布 → 200，版本号变大；缓存与 /healthz 的 sopVersion 跟着换，进程没重启',
    pub.status === 200 &&
      pub.body.versionNo > v1.versionNo &&
      cfg.currentSop().versionNo === pub.body.versionNo &&
      health.config.sopVersion === pub.body.versionNo &&
      pub.body.publishedByName === ADMIN.name,
    pub.text.slice(0, 200),
  );
  // 后台发布的版本先建草稿后发布，两个时间不同：缓存里的 publishedAt（匿名投影用）必须是发布时间
  check(
    'SOP HTTP：缓存里的 publishedAt 是发布时间，不是建草稿的时间',
    typeof pub.body.publishedAt === 'string' &&
      pub.body.publishedAt !== pub.body.createdAt &&
      cfg.currentSop().publishedAt === pub.body.publishedAt,
    `${pub.body.createdAt} / ${pub.body.publishedAt} / ${cfg.currentSop().publishedAt}`,
  );
  const systems: string[] = [];
  observeRequests((r) => void systems.push(r.system));
  const chatBody = JSON.stringify({ text: '想去三亚玩几天' });
  const chat = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(chatBody)) },
    body: chatBody,
  });
  observeRequests(null);
  check(
    'SOP HTTP：下一轮 chat() 收到的 system 等于新版本的 rendered_prompt',
    chat.status === 200 &&
      systems.length > 0 &&
      systems.every((s) => s === cfg.currentSop().renderedPrompt) &&
      systems[0]!.includes('后台这一句是 HTTP 加的。'),
    String(systems.length),
  );
  check('SOP HTTP：发布写一行审计', (await auditCount('sop.publish')) === publishesBefore + 1);
  const auditIp = await asSuper(
    async () =>
      (
        await t.pg.query<{ ip: string; name: string }>(
          `select host(ip) as ip, actor_name as name from audit_log where action = 'sop.publish' order by id desc limit 1`,
        )
      ).rows[0],
  );
  check('SOP HTTP：审计记下操作者与客户端地址', auditIp?.ip === '203.0.113.80' && auditIp.name === ADMIN.name, JSON.stringify(auditIp));

  const history = await call('GET', '/sop/versions?limit=10', O);
  const items = history.body.items as Body[];
  check(
    'SOP HTTP：版本历史按版本号倒序，只有 published / archived',
    history.status === 200 &&
      items[0]!.id === pub.body.id &&
      items.every((v, i) => (v.status === 'published' || v.status === 'archived') && (i === 0 || items[i - 1]!.versionNo > v.versionNo)),
  );
  check('SOP HTTP：limit 不是数字 → 400', keep(await call('GET', '/sop/versions?limit=abc', O)).status === 400);
  const overInt4 = await call('GET', '/sop/versions?before=2147483648', O);
  check(
    'SOP HTTP：before 超出 int4（版本号的列类型）→ 400，不带进库里报错；int4 上限本身照常 200',
    overInt4.status === 400 && (await call('GET', '/sop/versions?before=2147483647', O)).status === 200,
    overInt4.text,
  );
  check(
    'SOP HTTP：单个版本 → 200；id 格式不对 → 404',
    (await call('GET', `/sop/versions/${v1.id}`, O)).body.versionNo === v1.versionNo &&
      keep(await call('GET', '/sop/versions/not-a-uuid', O)).status === 404,
  );

  const rollbacksBefore = await auditCount('sop.rollback');
  const rb = await call('POST', `/sop/versions/${v1.id}/rollback`, { ...O, json: { changeNote: '回到导入版本' } });
  check(
    '回滚 HTTP：→ 200，新的版本号，prompt_hash 等于 v1 的，sameHashAsTarget 为 true',
    rb.status === 200 &&
      rb.body.versionNo > pub.body.versionNo &&
      rb.body.promptHash === v1.promptHash &&
      rb.body.sameHashAsTarget === true &&
      rb.body.source === 'rollback' &&
      cfg.currentSop().versionNo === rb.body.versionNo,
    rb.text.slice(0, 200),
  );
  check('回滚 HTTP：写一行审计', (await auditCount('sop.rollback')) === rollbacksBefore + 1);
  const blankNote = keep(await call('POST', `/sop/versions/${pub.body.id}/rollback`, { ...O, json: { changeNote: '   ' } }));
  check(
    '回滚 HTTP：变更说明为空 → 422，不写新版本',
    blankNote.status === 422 && blankNote.body.error === 'invalid_sop' && cfg.currentSop().versionNo === rb.body.versionNo,
    blankNote.text.slice(0, 200),
  );
  // 页面还停在回滚之前：以已归档的版本为 basedOn 新建草稿 → 409，不建草稿
  const staleBase = keep(
    await call('PUT', '/sop/draft', { ...O, json: { basedOn: pub.body.id, rev: null, edits: [{ key: 'tone', body: '停在旧版本上。' }] } }),
  );
  const strayDraft = (await call('GET', '/sop', O)).body.draft as Body | null;
  check(
    'SOP HTTP：新建草稿时 basedOn 已不是当前发布版本 → 409 rev_conflict，不建草稿',
    staleBase.status === 409 && staleBase.body.error === 'rev_conflict' && strayDraft === null,
    staleBase.text.slice(0, 200),
  );
  if (strayDraft) await call('POST', '/sop/draft/discard', { ...O, json: { rev: strayDraft.rev } });
  const draft = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: rb.body.id, rev: null, edits: [{ key: 'tone', body: '临时草稿。' }] },
  });
  check(
    '回滚 HTTP：回滚到 draft → 404',
    draft.status === 200 &&
      (await call('POST', `/sop/versions/${draft.body.id}/rollback`, { ...O, json: { changeNote: '回滚' } })).status === 404,
  );
  const discardsBefore = await auditCount('sop.discard');
  const discarded = await call('POST', '/sop/draft/discard', { ...O, json: { rev: draft.body.rev } });
  check(
    '丢弃 HTTP：→ 200，写一行审计',
    discarded.status === 200 && discarded.body.ok === true && (await auditCount('sop.discard')) === discardsBefore + 1,
  );
  const toDiscarded = keep(await call('POST', `/sop/versions/${draft.body.id}/rollback`, { ...O, json: { changeNote: '回滚' } }));
  check('回滚 HTTP：回滚到 discarded → 404', toDiscarded.status === 404 && toDiscarded.body.error === 'not_found');
  check(
    '回滚 HTTP：id 格式不对 → 404',
    (await call('POST', '/sop/versions/nope/rollback', { ...O, json: { changeNote: '回滚' } })).status === 404,
  );

  const page1 = await call('GET', '/audit?limit=2', O);
  const page2 = await call('GET', `/audit?limit=2&before=${page1.body.nextBefore}`, O);
  check(
    '审计 HTTP：按 id 倒序分页，before 接着翻',
    page1.body.items?.length === 2 &&
      page1.body.nextBefore === page1.body.items[1].id &&
      page2.body.items?.length === 2 &&
      page2.body.items?.every((x: Body) => x.id < page1.body.nextBefore),
  );
  // 按 action 过滤：日志里有别的动作，过滤后只剩这一种
  const allActions = new Set(((await call('GET', '/audit?limit=100', O)).body.items as Body[]).map((x) => x.action));
  const onlyRollbacks = (await call('GET', '/audit?limit=100&action=sop.rollback', O)).body.items as Body[];
  check(
    '审计 HTTP：按 action 过滤，只返回这一种动作',
    allActions.size > 1 && onlyRollbacks.length > 0 && onlyRollbacks.every((x) => x.action === 'sop.rollback'),
    [...allActions].join(','),
  );
  check('审计 HTTP：action 里有 NUL → 400', (await call('GET', '/audit?action=sop%00discard', O)).status === 400);
  const lastPage = await call('GET', '/audit?limit=100&action=sop.discard', O);
  check('审计 HTTP：最后一页 nextBefore 为 null', lastPage.body.items?.length > 0 && lastPage.body.nextBefore === null);
  // 恰好剩 limit 行时也没有下一页（多取的那一行不存在）
  const total = (lastPage.body.items as Body[]).length;
  const exact = await call('GET', `/audit?limit=${total}&action=sop.discard`, O);
  check(
    '审计 HTTP：恰好剩 limit 行时 nextBefore 也为 null',
    exact.body.items?.length === total && exact.body.nextBefore === null,
    exact.text.slice(0, 120),
  );
}

// 验收 10 的 HTTP 部分：rebase 冲突、并发首次保存
{
  const base = (await call('GET', '/sop', O)).body.published as Body;
  const a = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: base.id, rev: null, edits: [{ key: 'tone', body: `${bodyOf(base.sections, 'tone')}${NL}甲改的。` }] },
  });
  const va = await call('POST', '/sop/draft/publish', { ...O, json: { rev: a.body.rev, changeNote: '甲' } });
  const d = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: va.body.id, rev: null, edits: [{ key: 'tone', body: `${bodyOf(va.body.sections, 'tone')}${NL}乙又改的。` }] },
  });
  const other = await call('POST', `/sop/versions/${base.id}/rollback`, { as: admin, json: { changeNote: '别人回滚了' } });
  const clash = keep(await call('POST', '/sop/draft/publish', { ...O, json: { rev: d.body.rev, changeNote: '乙' } }));
  const tone = cfg.currentSop().sections.find((s) => s.key === 'tone')!.text;
  check(
    'rebase HTTP：草稿期间别人改了同一节 → 409，点名这一节并带当前正文',
    va.status === 200 &&
      other.status === 200 &&
      clash.status === 409 &&
      clash.body.error === 'sop_conflict' &&
      JSON.stringify(clash.body.keys) === '["tone"]' &&
      (clash.body.current ?? []).some((s: Body) => s.key === 'tone' && s.text === tone),
    clash.text.slice(0, 200),
  );
  await call('POST', '/sop/draft/discard', { ...O, json: { rev: d.body.rev } });
  const cur = cfg.currentSop();
  const both = await Promise.all(
    ['甲', '乙'].map((x) =>
      call('PUT', '/sop/draft', { ...O, json: { basedOn: cur.versionId, rev: null, edits: [{ key: 'tone', body: `${x}的版本。` }] } }),
    ),
  );
  check(
    '并发 HTTP：两个首次保存草稿一个 200、一个 409，没有 500',
    both
      .map((r) => r.status)
      .toSorted()
      .join(',') === '200,409',
    both.map((r) => r.text).join(' | '),
  );
  const left = (await call('GET', '/sop', O)).body.draft as Body;
  const wrongRev = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: cur.versionId, rev: left.rev + 1, edits: [{ key: 'tone', body: '再改。' }] },
  });
  check('SOP HTTP：已有草稿时 rev 对不上 → 409', wrongRev.status === 409 && wrongRev.body.error === 'rev_conflict');
  await call('POST', '/sop/draft/discard', { ...O, json: { rev: left.rev } });
  // 丢弃带旧 rev：存过一次之后拿存之前的 rev 丢弃 → 409，草稿还在
  const s1 = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: cur.versionId, rev: null, edits: [{ key: 'tone', body: '第一次存。' }] },
  });
  const s2 = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: cur.versionId, rev: s1.body.rev, edits: [{ key: 'tone', body: '第二次存。' }] },
  });
  const staleDiscard = keep(await call('POST', '/sop/draft/discard', { ...O, json: { rev: s1.body.rev } }));
  check(
    '丢弃 HTTP：带旧 rev → 409 rev_conflict，草稿还在',
    s2.status === 200 &&
      staleDiscard.status === 409 &&
      staleDiscard.body.error === 'rev_conflict' &&
      (await call('GET', '/sop', O)).body.draft?.rev === s2.body.rev,
    staleDiscard.text.slice(0, 200),
  );
  await call('POST', '/sop/draft/discard', { ...O, json: { rev: s2.body.rev } });
}

// 验收 6：契约闸
{
  const bad: [string, string, string][] = [
    ['tone', '明显超出我们现有线路的范围，就转人工。', 'phrase_forbidden'],
    ['objections', '嫌贵就调 search_route 再看看。', 'unknown_tool'],
    ['objections', '先调 create_refund 退一部分。', 'unknown_tool'],
    ['objections', '看结果里的 destinationMissing。', 'unknown_field'],
    ['wechat-style', `正文${NL}## 新节${NL}多出来的一节`, 'structure'],
    ['tone', '多'.repeat(5000), 'over_budget'],
  ];
  for (const [key, extra, code] of bad) {
    const cur = cfg.currentSop();
    const d = await call('PUT', '/sop/draft', {
      ...O,
      json: { basedOn: cur.versionId, rev: null, edits: [{ key, body: `${bodyOf(cur.sections, key)}${NL}${extra}` }] },
    });
    const ch = await call('POST', '/sop/draft/check', O);
    const pb = keep(await call('POST', '/sop/draft/publish', { ...O, json: { rev: d.body.rev, changeNote: '想发布' } }));
    const after = (await call('GET', '/sop', O)).body.published as Body;
    check(
      `闸 HTTP：${code}（${extra.slice(0, 12)}）→ 检查 200 带 violation，发布 422，已发布版本与缓存不变`,
      d.status === 200 &&
        ch.status === 200 &&
        ch.body.violations?.some((v: Body) => v.code === code) &&
        pb.status === 422 &&
        pb.body.error === 'contract' &&
        pb.body.violations?.some((v: Body) => v.code === code) &&
        cfg.currentSop().versionId === cur.versionId &&
        after.id === cur.versionId,
      `${d.status} ${ch.status} ${pb.status} ${pb.text.slice(0, 120)}`,
    );
    await call('POST', '/sop/draft/discard', { ...O, json: { rev: d.body.rev } });
  }
  const cur = cfg.currentSop();
  const save = (key: string, body: string) =>
    call('PUT', '/sop/draft', { ...O, json: { basedOn: cur.versionId, rev: null, edits: [{ key, body }] } });
  const locked = keep(await save('stages', '改锁定节。'));
  check(
    '闸 HTTP：保存草稿点名锁定节 → 422 locked_section',
    locked.status === 422 && locked.body.error === 'locked_section' && JSON.stringify(locked.body.keys) === '["stages"]',
    locked.text,
  );
  check('闸 HTTP：点名不存在的节 → 422', (await save('nope', 'x')).body.error === 'invalid_sop');
  const lone = await save('tone', `孤立代理项${String.fromCharCode(0xd800)}`);
  check('闸 HTTP：正文编码不合格（孤立代理项）→ 422', lone.status === 422 && lone.body.error === 'invalid_sop', lone.text);
  check('闸 HTTP：被拒的保存没留下草稿', (await call('GET', '/sop', O)).body.draft === null);
}

// 验收 9：产品库锁定字段与补丁（以及验收 10 的并发新建）
{
  const code = cfg.currentCatalog().routes[0]!.id;
  const get = async (c = code): Promise<Body> => (await call('GET', `/catalog/route/${c}`, O)).body;
  const item = await get();
  const p = item.payload as Body;
  check('产品库 HTTP：读单条 → active，带 rev 与 payload', item.status === 'active' && item.code === code && p.id === code);
  const snapBefore = JSON.stringify(cfg.currentCatalog().routes);
  const departDate = `${new Date().getFullYear() + 1}-05-10`;
  const proposal = async (): Promise<Body> =>
    (await (await app.request(`/api/proposal/${code}?travelers=2&departDate=${departDate}`)).json()) as Body;
  const quoteBefore = JSON.stringify((await proposal()).quote);
  const lockedChanges: Record<string, unknown> = {
    title: `${p.title}改`,
    destination: `${p.destination}改`,
    days: p.days + 1,
    priceFrom: p.priceFrom + 1,
    bestSeason: `${p.bestSeason}改`,
    segments: p.segments.includes('商务') ? p.segments.filter((x: string) => x !== '商务') : [...p.segments, '商务'],
    aliases: [...(p.aliases ?? []), '改名'],
    maxAltitude: (p.maxAltitude ?? 0) + 1,
    overseas: !p.overseas,
    inclusions: [...(p.inclusions ?? []), '改'],
    exclusions: [...(p.exclusions ?? []), '改'],
  };
  const results: string[] = [];
  for (const [field, value] of Object.entries(lockedChanges)) {
    const r = await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: item.rev, set: { [field]: value } } });
    if (!(r.status === 422 && r.body.error === 'locked_field' && JSON.stringify(r.body.fields) === JSON.stringify([field])))
      results.push(`${field}:${r.status}:${r.text.slice(0, 80)}`);
  }
  check('产品库 HTTP：active 线路逐个改锁定字段 → 422 并点名该字段', results.length === 0, results.join(' | '));
  const tags = p.tags.includes('国内') ? p.tags.filter((x: string) => x !== '国内') : [...p.tags, '国内'];
  const tagged = keep(await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: item.rev, set: { tags } } }));
  check(
    '产品库 HTTP：增删 tags 里的「国内」→ 422',
    tagged.status === 422 && JSON.stringify(tagged.body.fields) === '["tags:国内"]',
    tagged.text,
  );
  const all = await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: item.rev, set: { ...lockedChanges, tags } } });
  check('产品库 HTTP：一次改多个锁定字段 → 422 逐个点名', all.status === 422 && all.body.fields?.length === 12, all.text.slice(0, 200));
  check(
    '产品库 HTTP：被拒之后库和快照都不变',
    JSON.stringify(cfg.currentCatalog().routes) === snapBefore && (await get()).rev === item.rev,
  );

  const hl = [...p.highlights, 'HTTP 加的亮点'];
  const up = await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: item.rev, set: { highlights: hl } } });
  const mine = cfg.currentCatalog().routes.find((r) => r.id === code)!;
  const others = (routes: readonly { id: string }[]): string =>
    routes
      .filter((r) => r.id !== code)
      .map((r) => JSON.stringify(r))
      .join(NL);
  check('产品库 HTTP：改 highlights → 200，rev 加 1', up.status === 200 && up.body.rev === item.rev + 1, up.text.slice(0, 200));
  check(
    '产品库 HTTP：其他条目逐字节不变，这一条除 highlights 外也不变',
    others(cfg.currentCatalog().routes) === others(JSON.parse(snapBefore) as { id: string }[]) &&
      JSON.stringify({ ...mine, highlights: p.highlights }) === JSON.stringify(p),
  );
  const after = await proposal();
  check(
    '产品库 HTTP：公开的方案书接口拿到新 highlights，quote 不变',
    JSON.stringify(after.route.highlights) === JSON.stringify(hl) && JSON.stringify(after.quote) === quoteBefore,
  );

  // 表单把 itinerary 整个提交回来，键序还被打乱：只改了 itinerary[0].detail
  const cur2 = await get();
  const it = structuredClone(cur2.payload.itinerary) as Body[];
  it[0] = Object.fromEntries(Object.entries(it[0]!).toReversed());
  it[0].detail = `${it[0].detail}（HTTP 改）`;
  const up2 = await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: cur2.rev, set: { itinerary: it } } });
  const restored = structuredClone(cfg.currentCatalog().routes.find((r) => r.id === code)!) as Body;
  const changedDetail: string = restored.itinerary[0].detail;
  restored.itinerary[0].detail = cur2.payload.itinerary[0].detail;
  check(
    '产品库 HTTP：只改 itinerary[0].detail → 200，除这个字段外逐字节不变，各层键序保持',
    up2.status === 200 && changedDetail.endsWith('（HTTP 改）') && JSON.stringify(restored) === JSON.stringify(cur2.payload),
    up2.text.slice(0, 200),
  );
  check('产品库 HTTP：改完 itinerary，quote 仍不变', JSON.stringify((await proposal()).quote) === quoteBefore);

  const cur3 = await get();
  const same = await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: cur3.rev, set: structuredClone(cur3.payload) } });
  const lastUpdate = (await call('GET', '/audit?limit=1&action=catalog.update', O)).body.items[0] as Body;
  check(
    '产品库 HTTP：GET 回来的 payload 原样提交 → 200，审计 diff 为空，JSON 不变',
    same.status === 200 && JSON.stringify(same.body.payload) === JSON.stringify(cur3.payload) && JSON.stringify(lastUpdate.diff) === '{}',
    JSON.stringify(lastUpdate),
  );

  const cur4 = await get();
  const invalid = [{ itinerary: [] }, { itinerary: cur4.payload.itinerary.slice(1) }, { nope: 1 }, { highlights: 'not-an-array' }];
  const inv: Res[] = [];
  for (const set of invalid) inv.push(keep(await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: cur4.rev, set } })));
  check(
    '产品库 HTTP：itinerary 为空、条数不等于 days、带未知键、类型不对 → 422 并列出问题',
    inv.every((r) => r.status === 422 && r.body.error === 'invalid_item' && r.body.issues?.length > 0),
    inv.map((r) => `${r.status}:${r.text.slice(0, 60)}`).join(' | '),
  );
  const both = await call('PATCH', `/catalog/route/${code}`, {
    ...O,
    json: { rev: cur4.rev, set: { highlights: hl }, unset: ['highlights'] },
  });
  check('产品库 HTTP：同一字段既 set 又 unset → 422', both.status === 422);
  const stale = keep(await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: cur4.rev - 1, set: { highlights: hl } } }));
  check('产品库 HTTP：rev 过期 → 409', stale.status === 409 && stale.body.error === 'rev_conflict');
  check('产品库 HTTP：请求体缺 rev → 400', (await call('PATCH', `/catalog/route/${code}`, { ...O, json: { set: {} } })).status === 400);

  const fresh = { ...structuredClone(p), id: 'r-http-new', title: `${p.title}（新）` };
  const maxOrd = Math.max(...((await call('GET', '/catalog/route', O)).body.items as Body[]).map((x) => x.ord));
  const created = await call('POST', '/catalog/route', { ...O, json: { payload: fresh } });
  check(
    '产品库 HTTP：新建 → 200，是 draft，ord 排在最后，不进快照',
    created.status === 200 &&
      created.body.status === 'draft' &&
      created.body.ord === maxOrd + 1 &&
      !cfg.currentCatalog().routes.some((r) => r.id === 'r-http-new'),
    created.text.slice(0, 200),
  );
  const dup = keep(await call('POST', '/catalog/route', { ...O, json: { payload: fresh } }));
  check('产品库 HTTP：同一个 code 再建 → 409 catalog_code_taken', dup.status === 409 && dup.body.error === 'catalog_code_taken');
  const race = await Promise.all(
    [1, 2].map(() => call('POST', '/catalog/route', { ...O, json: { payload: { ...fresh, id: 'r-http-race' } } })),
  );
  check(
    '并发 HTTP：两个同 code 的新建一个 200、一个 409 catalog_code_taken，没有 500',
    race
      .map((r) => r.status)
      .toSorted()
      .join(',') === '200,409' && race.some((r) => r.body.error === 'catalog_code_taken'),
    race.map((r) => r.text.slice(0, 60)).join(' | '),
  );
  const idChange = keep(
    await call('PATCH', '/catalog/route/r-http-new', { ...O, json: { rev: created.body.rev, set: { id: 'r-http-other' } } }),
  );
  check(
    '产品库 HTTP：draft 改 id → 422 点名 id',
    idChange.status === 422 && JSON.stringify(idChange.body.fields) === '["id"]',
    idChange.text,
  );
  const draftEdit = await call('PATCH', '/catalog/route/r-http-new', {
    ...O,
    json: { rev: created.body.rev, set: { priceFrom: p.priceFrom + 100, title: `${p.title}（新二）` } },
  });
  check(
    '产品库 HTTP：draft 的 priceFrom、title 都能改',
    draftEdit.status === 200 && draftEdit.body.payload.priceFrom === p.priceFrom + 100,
    draftEdit.text.slice(0, 200),
  );
  const strPrice = await call('PATCH', '/catalog/route/r-http-new', { ...O, json: { rev: draftEdit.body.rev, set: { priceFrom: '100' } } });
  check('产品库 HTTP：数值字段传字符串 → 422', strPrice.status === 422 && strPrice.body.error === 'invalid_item');
  // 库里的 json 存不下 NUL 与孤立代理项：schema 先拦下，422 点名字段，不带进库里报错成 500
  const NUL = String.fromCharCode(0);
  const badText = [
    await call('POST', '/catalog/route', { ...O, json: { payload: { ...fresh, id: 'r-http-nul', title: `标题${NUL}` } } }),
    await call('POST', '/catalog/route', {
      ...O,
      json: { payload: { ...fresh, id: 'r-http-lone', highlights: [`亮点${String.fromCharCode(0xd800)}`] } },
    }),
    await call('PATCH', '/catalog/route/r-http-new', { ...O, json: { rev: draftEdit.body.rev, set: { title: `标题${NUL}` } } }),
  ];
  check(
    '产品库 HTTP：文本字段里有 NUL 或孤立代理项 → 新建与补丁都是 422 invalid_item 并点名字段',
    badText.every((r) => r.status === 422 && r.body.error === 'invalid_item') &&
      JSON.stringify(badText.map((r) => (r.body.issues as Body[] | undefined)?.map((i) => i.path))) ===
        '[["title"],["highlights.0"],["title"]]',
    badText.map((r) => r.text.slice(0, 160)).join(' | '),
  );
  check('产品库 HTTP：路径里的 code 有 NUL → 400', (await call('GET', '/catalog/route/r-http%00new', O)).status === 400);
  const staleAct = await call('POST', '/catalog/route/r-http-new/activate', { ...O, json: { rev: created.body.rev } });
  check('上架 HTTP：rev 过期 → 409', staleAct.status === 409);
  const act = await call('POST', '/catalog/route/r-http-new/activate', { ...O, json: { rev: draftEdit.body.rev } });
  check(
    '上架 HTTP：→ 200 active，进了快照',
    act.status === 200 && act.body.status === 'active' && cfg.currentCatalog().routes.some((r) => r.id === 'r-http-new'),
    act.text.slice(0, 200),
  );
  const lockedNow = await call('PATCH', '/catalog/route/r-http-new', { ...O, json: { rev: act.body.rev, set: { priceFrom: 1 } } });
  check('上架 HTTP：上架之后 priceFrom 锁定', lockedNow.status === 422 && lockedNow.body.error === 'locked_field');
  check(
    '产品库 HTTP：不存在的条目 → 404；kind 不对 → 400',
    (await call('GET', '/catalog/route/nope', O)).status === 404 &&
      (await call('PATCH', '/catalog/route/nope', { ...O, json: { rev: 1, set: {} } })).status === 404 &&
      keep(await call('GET', '/catalog/ship', O)).status === 400,
  );
  const list = (await call('GET', '/catalog/route', O)).body.items as Body[];
  check(
    '产品库 HTTP：成员看到的列表按 ord、含 draft，带更新人',
    list.some((x) => x.code === 'r-http-race' && x.status === 'draft') &&
      list.every((x, i) => i === 0 || list[i - 1]!.ord < x.ord) &&
      list.find((x) => x.code === 'r-http-new')?.updatedByName === '老板',
  );
  const st = await call('GET', '/status', O);
  check(
    '/status：登录后有租户、当前版本与哈希、锁、索引状态，以及与镜像的差异',
    st.status === 200 &&
      st.body.tenantSlug === 'demo' &&
      st.body.sop.versionNo === cfg.currentSop().versionNo &&
      st.body.sop.promptHash === cfg.currentSop().promptHash &&
      st.body.lock === 'held' &&
      typeof st.body.index.snapshotGeneration === 'number' &&
      st.body.drift.catalog.route.changed.includes(code) &&
      st.body.drift.catalog.route.onlyDb.includes('r-http-new') &&
      Array.isArray(st.body.drift.editedSections),
    st.text.slice(0, 300),
  );
}

// 验收 16：匿名访问（demo）
{
  const cur = cfg.currentSop();
  const marker = '匿名不该看到的草稿标记';
  const d = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: cur.versionId, rev: null, edits: [{ key: 'tone', body: `${bodyOf(cur.sections, 'tone')}${NL}${marker}` }] },
  });
  check('匿名准备：留一份草稿', d.status === 200);
  const code = cfg.currentCatalog().routes[0]!.id;
  const q0 = queryCount();
  const aSop = keep(await call('GET', '/sop'));
  const aCat = await call('GET', '/catalog/route');
  const aHotel = await call('GET', '/catalog/hotel');
  const aItem = await call('GET', `/catalog/route/${code}`);
  const aDraft = await call('GET', '/catalog/route/r-http-race');
  const aStatus = await call('GET', '/status');
  const q1 = queryCount();
  check(
    '匿名 demo：GET /sop、/catalog/route、/catalog/hotel、单条 → 200',
    [aSop, aCat, aHotel, aItem].every((r) => r.status === 200),
  );
  check('匿名 demo：这些请求不查库（queryCount 不变）', q1 === q0, `${q0} → ${q1}`);
  const texts = [aSop, aCat, aHotel, aItem, aStatus].map((r) => r.text).join(NL);
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const leaked = ['ByName', 'changeNote', 'userId', '"rev"', '"status"', ADMIN.name, marker, 'r-http-race'].filter((k) =>
    texts.includes(k),
  );
  check('匿名 demo：响应里没有 uuid、姓名、changeNote、草稿', !UUID.test(texts) && leaked.length === 0, leaked.join(','));
  check(
    '匿名 demo：SOP 只有已发布版本的 sections、versionNo、publishedAt、promptHash 前 12 位',
    JSON.stringify(Object.keys(aSop.body)) === '["published"]' &&
      JSON.stringify(Object.keys(aSop.body.published).toSorted()) === '["promptHash","publishedAt","sections","versionNo"]' &&
      aSop.body.published.promptHash === cur.promptHash.slice(0, 12) &&
      aSop.body.published.versionNo === cur.versionNo &&
      JSON.stringify(aSop.body.published.sections) === JSON.stringify(cur.sections),
  );
  check(
    '匿名 demo：产品库只有 active 条目的 kind、code、payload',
    (aCat.body.items as Body[]).every((i) => JSON.stringify(Object.keys(i)) === '["kind","code","payload"]') &&
      (aCat.body.items as Body[]).map((i) => i.code).join() ===
        cfg
          .currentCatalog()
          .routes.map((r) => r.id)
          .join() &&
      aDraft.status === 404,
  );
  check('匿名 demo：/status 只有 mode', aStatus.status === 200 && JSON.stringify(aStatus.body) === '{"mode":"db"}', aStatus.text);
  const denied = [
    await call('GET', '/audit'),
    await call('GET', '/conversations'),
    await call('GET', '/sop/versions'),
    await call('GET', `/sop/versions/${cur.versionId}`),
    await call('GET', '/me'),
  ];
  check(
    '匿名 demo：/audit、/conversations、版本历史、/me → 401',
    denied.every((r) => r.status === 401),
    denied.map((r) => r.status).join(','),
  );
  const unknown = keep(await call('GET', '/nope'));
  check(
    '匿名 demo：未知的 /api/console 路径 → 404 JSON，不是 index.html',
    unknown.status === 404 &&
      unknown.body.error === 'not_found' &&
      (unknown.headers.get('content-type') ?? '').includes('application/json'),
    `${unknown.status} ${unknown.text.slice(0, 80)}`,
  );
  const writes = [
    await call('PUT', '/sop/draft', { json: { basedOn: cur.versionId, rev: null, edits: [{ key: 'tone', body: 'x' }] } }),
    await call('POST', '/sop/draft/check'),
    await call('POST', '/sop/draft/publish', { json: { rev: d.body.rev, changeNote: 'x' } }),
    await call('POST', '/sop/draft/discard', { json: { rev: d.body.rev } }),
    await call('POST', `/sop/versions/${cur.versionId}/rollback`, { json: { changeNote: 'x' } }),
    await call('POST', '/catalog/route', { json: { payload: {} } }),
    await call('PATCH', `/catalog/route/${code}`, { json: { rev: 1, set: {} } }),
    await call('POST', `/catalog/route/${code}/activate`, { json: { rev: 1 } }),
    await call('POST', '/auth/logout'),
  ];
  check(
    '匿名 demo：任何写请求 → 401',
    writes.every((r) => r.status === 401),
    writes.map((r) => r.status).join(','),
  );
  const limit = Math.max(1, numEnv('LOOKUP_RATE_PER_MIN', 60));
  const burst: Res[] = [];
  for (let i = 0; i <= limit; i++) burst.push(await call('GET', '/status', { ip: '198.51.100.123' }));
  keep(burst[limit]!);
  check(
    `匿名 demo：匿名读挂了查询限流，同一 IP 一分钟内第 ${limit + 1} 次 → 429`,
    burst.slice(0, limit).every((r) => r.status === 200) && burst[limit]!.status === 429,
    burst.map((r) => r.status).join(','),
  );
  check('匿名 demo：成员读不挂查询限流', (await call('GET', '/status', { ...O, ip: '198.51.100.123' })).status === 200);
  await call('POST', '/sop/draft/discard', { ...O, json: { rev: d.body.rev } });
}

// 验收 16：匿名访问（prod）
{
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  try {
    const code = cfg.currentCatalog().routes[0]!.id;
    const anon = [
      await call('GET', '/sop'),
      await call('GET', '/catalog/route'),
      await call('GET', `/catalog/route/${code}`),
      await call('GET', '/status'),
      await call('GET', '/me'),
      await call('GET', '/audit'),
      await call('GET', '/sop/versions'),
      await call('GET', '/conversations'),
      await call('GET', '/nope'),
      await call('GET', '/auth/login'),
      await call('POST', '/sop/draft/check'),
    ];
    check(
      '匿名 prod：/auth/login 以外的任何 /api/console/* → 401',
      anon.every((r) => r.status === 401),
      anon.map((r) => r.status).join(','),
    );
    const li = await httpLogin(OWNER.email, OWNER.password, '203.0.113.90');
    check(
      'prod：登录照常，登录之后读到完整的 SOP',
      li.status === 200 && typeof (await call('GET', '/sop', { as: li })).body.published?.id === 'string',
    );
  } finally {
    __profileTest.reset();
  }
}

// 会话只读列表（第 13 步）：成员都能看；按 (updatedAt desc, id) 排序、offset 分页；只投影几个字段；不列 sim- 会话
{
  const store = await import('../store.js');
  const T = Date.parse('2030-01-01T00:00:00Z');
  const seed = (id: string, channel: string, at: number, extra: (s: ReturnType<typeof store.getOrCreateSession>) => void = () => {}) => {
    const sess = store.getOrCreateSession(id, channel);
    extra(sess);
    sess.updatedAt = at;
    store.saveSession(sess, false);
  };
  seed('wecom:conv-b', 'wecom', T + 3000);
  seed('wecom:conv-a', 'wecom', T + 3000);
  seed('wecom:conv-c', 'wecom', T + 5000, (sess) => {
    sess.handedOver = true;
    sess.stage = 'handoff';
    sess.profile = { destinationInterest: '会话列表不该出现的画像' };
    for (const content of ['会话列表不该出现的正文', '第二条', '第三条']) sess.messages.push({ role: 'customer', content, at: T });
  });
  seed('sim-convvisitor000000000000000001', 'simulator', T + 9000);

  const top = await call('GET', '/conversations?limit=3', O);
  check(
    '会话列表：按 updatedAt 倒序，同一时刻按 id 升序，不列 sim- 会话',
    top.status === 200 && (top.body.items as Body[]).map((x) => x.id).join() === 'wecom:conv-c,wecom:conv-a,wecom:conv-b',
    top.text.slice(0, 200),
  );
  const c = (top.body.items as Body[])[0]!;
  check(
    '会话列表：每条只有 id、channel、stage、handedOver、messageCount、updatedAt',
    JSON.stringify(Object.keys(c)) === '["id","channel","stage","handedOver","messageCount","updatedAt"]' &&
      c.handedOver === true &&
      c.stage === 'handoff' &&
      c.messageCount === 3 &&
      c.updatedAt === new Date(T + 5000).toISOString(),
    JSON.stringify(c),
  );
  check('会话列表：不带消息正文和客户画像', !top.text.includes('不该出现的正文') && !top.text.includes('不该出现的画像'));
  const nonSim = store.listSessions().filter((x) => !x.id.startsWith('sim-'));
  check('会话列表：total 是不含 sim- 的会话数', top.body.total === nonSim.length && nonSim.length < store.listSessions().length);
  const pages: string[] = [];
  for (let offset = 0; offset < nonSim.length; offset += 2) {
    pages.push(...((await call('GET', `/conversations?limit=2&offset=${offset}`, O)).body.items as Body[]).map((x) => String(x.id)));
  }
  const expected = nonSim.toSorted((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((x) => x.id);
  check('会话列表：逐页翻完与全量排序一致，没有重复与遗漏', pages.join() === expected.join(), `${pages.length}/${expected.length}`);
  check(
    '会话列表：offset 越界给空页，limit 超过 100、为 0、offset 为负都是 400',
    ((await call('GET', `/conversations?offset=${nonSim.length + 5}`, O)).body.items as unknown[]).length === 0 &&
      (await call('GET', '/conversations?limit=101', O)).status === 400 &&
      (await call('GET', '/conversations?limit=0', O)).status === 400 &&
      (await call('GET', '/conversations?offset=-1', O)).status === 400,
  );
  const AGENT = { email: 'agent@example.com', password: 'agent-password-1' };
  await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: AGENT.email, name: '坐席丙', role: 'agent', password: pw(AGENT.password) }),
  );
  const agent = await httpLogin(AGENT.email, AGENT.password, '203.0.113.95');
  check(
    '会话列表：非编辑角色（agent）也能看，审计仍是 403',
    (await call('GET', '/conversations', { as: agent })).status === 200 && (await call('GET', '/audit', { as: agent })).status === 403,
  );
  check('会话列表：匿名 → 401', (await call('GET', '/conversations')).status === 401);
}

// 产品库 CSV 导入（第 15 步）：只建 draft，只收平铺字段，数组用「、」分隔；整份全部合格才建
{
  const { parseCsv } = await import('../shared/csv.js');
  const CRLF = String.fromCharCode(13, 10);
  const BOM = String.fromCharCode(0xfeff);
  check(
    'CSV 解析：引号里的逗号、换行和 "" 转义，CRLF 行尾，开头的 BOM，末尾空行',
    JSON.stringify(parseCsv(`${BOM}a,b${CRLF}"x, y","第一行${NL}第二行"${CRLF}"说""好""",${CRLF}${CRLF}`)) ===
      JSON.stringify([
        ['a', 'b'],
        ['x, y', `第一行${NL}第二行`],
        ['说"好"', ''],
      ]),
  );
  check('CSV 解析：引号没闭合就抛', (await errName(Promise.resolve().then(() => parseCsv('a,"b')))) === 'CsvSyntaxError');

  const hotels = async (): Promise<Body[]> => (await call('GET', '/catalog/hotel', O)).body.items as Body[];
  const before = await hotels();
  const snapBefore = JSON.stringify(cfg.currentCatalog().hotels);
  const csv = [
    'tags,id,name,destination,stars,nightlyFrom,roomType,highlights',
    `,h-csv-one,CSV 酒店一,三亚,五星,1880,海景房,"私人沙滩、无边泳池"`,
    `亲子、海岛,h-csv-two,"CSV 酒店二，带逗号",三亚,五星,2280,套房,早餐含两位`,
  ].join(NL);
  const created = await call('POST', '/catalog/hotel/import-csv', { ...O, json: { csv } });
  const items = (created.body.items ?? []) as Body[];
  check(
    'CSV 导入：两行 → 200，建成两条 draft',
    created.status === 200 && items.length === 2 && items.every((x) => x.status === 'draft'),
    created.text.slice(0, 200),
  );
  check(
    'CSV 导入：payload 的键按 schema 的顺序（不按 CSV 的列序），数组按「、」切开，空的必填数组给 []，引号里的逗号保留',
    JSON.stringify(items[0]?.payload) ===
      JSON.stringify({
        id: 'h-csv-one',
        name: 'CSV 酒店一',
        destination: '三亚',
        stars: '五星',
        nightlyFrom: 1880,
        roomType: '海景房',
        highlights: ['私人沙滩', '无边泳池'],
        tags: [],
      }) &&
      JSON.stringify(items[1]?.payload.tags) === '["亲子","海岛"]' &&
      items[1]?.payload.name === 'CSV 酒店二，带逗号',
    JSON.stringify(items.map((x) => x.payload)),
  );
  const maxBefore = Math.max(...before.map((x) => x.ord));
  check('CSV 导入：ord 按 CSV 的行序接在最大值之后', items[0]?.ord === maxBefore + 1 && items[1]?.ord === maxBefore + 2);
  check('CSV 导入：draft 不进快照', JSON.stringify(cfg.currentCatalog().hotels) === snapBefore);
  const creates = (await call('GET', '/audit?limit=5&action=catalog.create', O)).body.items as Body[];
  check(
    'CSV 导入：每条一行 catalog.create 审计',
    creates
      .slice(0, 2)
      .map((x) => x.targetId)
      .toSorted()
      .join() === 'h-csv-one,h-csv-two',
  );
  const oneDiff = creates.find((x) => x.targetId === 'h-csv-one')?.diff as Body | undefined;
  const onePayload = (items[0]?.payload ?? {}) as Body;
  check(
    'CSV 导入：审计 diff 是每个顶层字段 [null, 新值]',
    !!oneDiff &&
      Object.keys(oneDiff).length === Object.keys(onePayload).length &&
      Object.entries(onePayload).every(([k, v]) => JSON.stringify(oneDiff[k]) === JSON.stringify([null, v])),
    JSON.stringify(oneDiff),
  );

  const reject = async (text: string, kind = 'hotel'): Promise<Res> =>
    keep(await call('POST', `/catalog/${kind}/import-csv`, { ...O, json: { csv: text } }));
  const count = async (): Promise<number> => (await hotels()).length;
  const n0 = await count();
  const head = 'id,name,destination,stars,nightlyFrom,roomType,highlights,tags';
  const cases: [string, string, (r: Res) => boolean][] = [
    [
      '表头里有没有的字段',
      `${head},nope${NL}h-x,名,三亚,五星,100,房,亮点,,1`,
      (r) => r.body.rows?.[0]?.row === 0 && JSON.stringify(r.body.rows).includes('nope'),
    ],
    ['表头里有 __proto__', `${head},__proto__${NL}h-x,名,三亚,五星,100,房,亮点,,x`, (r) => r.body.rows?.[0]?.row === 0],
    [
      '数值写成文字',
      `${head}${NL}h-ok,名,三亚,五星,100,房,亮点,${NL}h-bad,名,三亚,五星,一百,房,亮点,`,
      (r) => r.body.rows?.length === 1 && r.body.rows[0].row === 2,
    ],
    [
      '文件内 id 重复',
      `${head}${NL}h-dup,名,三亚,五星,100,房,亮点,${NL}h-dup,名,三亚,五星,100,房,亮点,`,
      (r) => r.body.rows?.[0]?.row === 2,
    ],
    [
      '库里已有这个 code',
      `${head}${NL}h-new-1,名,三亚,五星,100,房,亮点,${NL}h-csv-one,名,三亚,五星,100,房,亮点,`,
      (r) => r.body.rows?.[0]?.row === 2 && JSON.stringify(r.body.rows).includes('已经有了'),
    ],
    ['过不了 schema（缺必填、id 不合规）', `${head}${NL}H_BAD,名,三亚,五星,100,房,,`, (r) => r.body.rows?.[0]?.row === 1],
    ['只有表头', head, (r) => r.body.rows?.[0]?.row === 0],
  ];
  const failed = [];
  for (const [name, text, ok] of cases) {
    const r = await reject(text);
    if (!(r.status === 422 && r.body.error === 'invalid_csv' && ok(r))) failed.push(`${name}: ${r.status} ${r.text.slice(0, 120)}`);
  }
  check('CSV 导入：七种不合格都是 422 invalid_csv 并按行点名', failed.length === 0, failed.join(' | '));
  check('CSV 导入：不合格时一条也没建（包括同一份里合格的那几行）', (await count()) === n0);
  const nulCell = await reject(`${head}${NL}h-nul,名${String.fromCharCode(0)},三亚,五星,100,房,亮点,`);
  check(
    'CSV 导入：单元格里有 NUL → 422 invalid_csv 点名那一行（不带进库里报错成 500）',
    nulCell.status === 422 && nulCell.body.error === 'invalid_csv' && nulCell.body.rows?.[0]?.row === 1 && (await count()) === n0,
    nulCell.text,
  );
  const route = await reject(`id,title${NL}r-csv,标题`, 'route');
  check(
    'CSV 导入：线路的必填 itinerary 不是平铺字段 → 422，说明原因',
    route.status === 422 && route.body.rows?.[0]?.row === 0 && JSON.stringify(route.body.rows).includes('itinerary'),
    route.text,
  );
  const AGENT = { email: 'agent@example.com', password: 'agent-password-1' };
  const agent = await httpLogin(AGENT.email, AGENT.password, '203.0.113.96');
  check(
    'CSV 导入：非编辑角色 403，匿名 401',
    (await call('POST', '/catalog/hotel/import-csv', { as: agent, json: { csv } })).status === 403 &&
      (await call('POST', '/catalog/hotel/import-csv', { json: { csv } })).status === 401,
  );
}

// /console 的托管与 SPA 回退（第 16 步，验收 17 的路由部分）：用临时的构建产物，测试不依赖真的去构建
{
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-console-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  const placeholder = '__CONSOLE_CSP_NONCE__';
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    `<!doctype html><html><head><meta property="csp-nonce" nonce="${placeholder}" /><script type="module" src="/console/assets/app-1a2b.js" nonce="${placeholder}"></script></head><body><div id="root"></div></body></html>`,
  );
  fs.writeFileSync(path.join(dist, 'assets', 'app-1a2b.js'), 'console.log("console");');
  process.env.CONSOLE_DIST = dist;
  const page = async (url: string): Promise<Res> => {
    const res = await app.request(url, { headers: { 'x-forwarded-for': '203.0.113.97' } });
    return { status: res.status, body: {}, text: await res.text(), headers: res.headers };
  };
  const bare = await page('/console');
  check('托管：/console → 301 到 /console/', bare.status === 301 && bare.headers.get('location') === '/console/');
  const index = await page('/console/');
  const nonce = /nonce="([^"]+)"/.exec(index.text)?.[1] ?? '';
  check(
    '托管：/console/ 返回 index.html，占位符全部换成这次的 nonce，CSP 带 style-src 这个 nonce',
    index.status === 200 &&
      nonce.length >= 16 &&
      !index.text.includes(placeholder) &&
      index.text.split(`nonce="${nonce}"`).length === 3 &&
      (index.headers.get('content-security-policy') ?? '').endsWith(`style-src 'self' 'nonce-${nonce}'`) &&
      (index.headers.get('content-security-policy') ?? '').startsWith(
        "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
      ) &&
      index.headers.get('cache-control') === 'no-store' &&
      index.headers.get('x-content-type-options') === 'nosniff',
    `${index.status} ${index.headers.get('content-security-policy')}`,
  );
  const again = await page('/console/');
  check('托管：每次响应的 nonce 都不同', /nonce="([^"]+)"/.exec(again.text)?.[1] !== nonce);
  const direct = await page('/console/index.html');
  check(
    '托管：直接请求 /console/index.html 也是换过 nonce 的页面，不是带占位符的原文件',
    direct.status === 200 && !direct.text.includes(placeholder),
  );
  // 路径解析会落到同一个文件的别的写法：末尾带斜杠，以及（大小写不敏感的文件系统上）大写
  const aliases = [await page('/console/index.html/'), await page('/console/INDEX.HTML')];
  check(
    '托管：/console/index.html/ 与 /console/INDEX.HTML 也是换过 nonce 的页面，不是按文件吐出的原文',
    aliases.every(
      (r) => r.status === 200 && !r.text.includes(placeholder) && (r.headers.get('content-type') ?? '').startsWith('text/html'),
    ),
    aliases.map((r) => `${r.status} ${r.headers.get('content-type')}`).join(' | '),
  );
  const deep = await page('/console/sop/versions/3');
  check('托管：深链 /console/sop/versions/3 也返回 index.html', deep.status === 200 && deep.text.includes('<div id="root">'));
  const js = await page('/console/assets/app-1a2b.js');
  check(
    '托管：/console/assets/<hash>.js 返回 JS，带安全头',
    js.status === 200 &&
      js.text === 'console.log("console");' &&
      (js.headers.get('content-type') ?? '').startsWith('text/javascript') &&
      secured(js.headers),
  );
  const missing = await page('/console/assets/nope-0000.js');
  check(
    '托管：不存在的资源文件 → 404，不回退成 index.html',
    missing.status === 404 && !missing.text.includes('<html') && secured(missing.headers),
  );
  const traversal = [
    await page('/console/%2e%2e/package.json'),
    await page('/console/..%2fpackage.json'),
    await page('/console/assets/..%2f..%2fpackage.json'),
  ];
  check(
    '托管：../ 跑不出构建目录',
    traversal.every((r) => !r.text.includes('"packageManager"')),
    traversal.map((r) => r.status).join(','),
  );
  const { __hostTest } = await import('./host.js');
  fs.writeFileSync(path.join(path.dirname(dist), `${path.basename(dist)}-outside.txt`), 'outside');
  check(
    '托管：读文件那一层也拦住跑出构建目录的路径（路由层之外的兜底）',
    (await __hostTest.readDistFile(`../${path.basename(dist)}-outside.txt`)) === null &&
      (await __hostTest.readDistFile('assets/app-1a2b.js')) !== null,
  );
  fs.rmSync(path.join(path.dirname(dist), `${path.basename(dist)}-outside.txt`));
  const chat = await app.request('/chat.html');
  check('托管：/chat.html 照旧', chat.status === 200 && (await chat.text()).includes('<html'));
  const member404 = await call('GET', '/nope', O);
  check('托管：成员访问未知的 /api/console 路径 → 404 JSON', member404.status === 404 && member404.body.error === 'not_found');
  process.env.CONSOLE_DIST = path.join(dist, 'nope');
  const unbuilt = await page('/console/');
  check('托管：没有构建产物时 /console/ → 404 并说明原因', unbuilt.status === 404 && unbuilt.text.includes('pnpm --filter console build'));
  delete process.env.CONSOLE_DIST;
  fs.rmSync(dist, { recursive: true, force: true });
}

// 命名错误映射：23505（写函数都先转成命名错误，接口上走不到，这里直接看映射）
check(
  '错误映射：23505（经 drizzle 包在 cause 里）→ 409',
  __consoleTest.mapError(new Error('insert failed', { cause: Object.assign(new Error('duplicate key'), { code: '23505' }) }))?.status ===
    409,
);
check('错误映射：不认识的错误 → null（按 500 处理）', __consoleTest.mapError(new Error('boom')) === null);

// 锁丢失：配置写入 503 lock_lost，读照常
{
  cfg.__configTest.reset();
  const lock = fakeLock();
  lock.next = 'unreachable';
  await cfg.initConfig(testConfigDeps(t, { lock: async () => lock }));
  const code = cfg.currentCatalog().routes[0]!.id;
  const item = (await call('GET', `/catalog/route/${code}`, O)).body;
  lock.lose();
  const w1 = keep(
    await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: item.rev, set: { highlights: item.payload.highlights } } }),
  );
  const w2 = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: cfg.currentSop().versionId, rev: null, edits: [{ key: 'tone', body: '锁丢了。' }] },
  });
  check(
    '锁丢失：改产品库、存草稿 → 503 lock_lost',
    w1.status === 503 && w1.body.error === 'lock_lost' && w2.status === 503 && w2.body.error === 'lock_lost',
    `${w1.text} | ${w2.text}`,
  );
  // CSV 导入不经 write() 外壳，自己查锁
  const w3 = keep(
    await call('POST', '/catalog/hotel/import-csv', {
      ...O,
      json: { csv: `id,name,destination,stars,nightlyFrom,roomType,highlights,tags${NL}h-lock-lost,锁丢了,三亚,五星,100,房,亮点,` },
    }),
  );
  check(
    '锁丢失：CSV 导入 → 503 lock_lost，一条也没建',
    w3.status === 503 &&
      w3.body.error === 'lock_lost' &&
      !((await call('GET', '/catalog/hotel', O)).body.items as Body[]).some((x) => x.code === 'h-lock-lost'),
    w3.text.slice(0, 200),
  );
  check(
    '锁丢失：读照常，/status 报 lock=lost',
    (await call('GET', '/sop', O)).status === 200 && (await call('GET', '/status', O)).body.lock === 'lost',
  );
}

// 文件模式：/api/console/* 一律 503 db_disabled
{
  cfg.__configTest.reset();
  const f = [
    keep(await call('GET', '/sop', O)),
    await call('POST', '/auth/login', { json: { email: OWNER.email, password: OWNER.password } }),
    await call('GET', '/nope'),
    await call('GET', '/status'),
  ];
  check(
    '文件模式：/api/console/* 一律 503 db_disabled',
    f.every((r) => r.status === 503 && r.body.error === 'db_disabled'),
    f.map((r) => r.text).join(' | '),
  );
}

// 请求体上限的 413 / 411 在后台子应用之前就回了：/api/console/* 与 /console/* 上照样带安全头，后台接口回 { error }
{
  const big = JSON.stringify({ email: 'x'.repeat(70 * 1024), password: 'x' });
  const post = (url: string, headers: Record<string, string>) => app.request(url, { method: 'POST', headers, body: big });
  const tooLarge = await post('/api/console/auth/login', { 'content-type': 'application/json', 'content-length': String(big.length) });
  // app.request 不会自己带 content-length，不写就是 411
  const noLength = await post('/api/console/auth/login', { 'content-type': 'application/json' });
  const page413 = await post('/console/', { 'content-length': String(big.length) });
  const bodies: Body[] = [];
  for (const r of [tooLarge, noLength]) {
    const text = await r.text();
    try {
      bodies.push(JSON.parse(text) as Body);
    } catch {
      bodies.push({ text });
    }
  }
  check(
    '请求体上限：/api/console 的 413、411 与 /console 的 413 都带安全头，接口回 JSON 错误',
    tooLarge.status === 413 &&
      noLength.status === 411 &&
      page413.status === 413 &&
      [tooLarge, noLength, page413].every((r) => secured(r.headers)) &&
      bodies[0]!.error === 'payload_too_large' &&
      bodies[1]!.error === 'length_required',
    `${tooLarge.status} ${noLength.status} ${page413.status} ${JSON.stringify(bodies)}`,
  );
}

// 验收 16：安全头
{
  const statuses = [...new Set(seen.map((r) => r.status))].toSorted((a, b) => a - b);
  check(
    '安全头：覆盖到 200、400、401、403、404、409、415、422、429、503',
    statuses.join(',') === '200,400,401,403,404,409,415,422,429,503',
    statuses.join(','),
  );
  const bare = seen.filter((r) => !secured(r.headers));
  check('安全头：这些 /api/console 响应都带 CSP、no-store、nosniff', bare.length === 0, bare.map((r) => r.status).join(','));
}

await t.close();
if (fails.length) {
  console.error(`CONSOLE SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `CONSOLE SELFTEST PASS: ${pass} 项断言全通（口令哈希与并发上限 / 平台账号命令行 / 登录与会话 / 空闲与绝对过期 / 三路限流与防探测 / 口令升级 / 吊销会话 / prod 下后台 SSE 要求会话 / ` +
    `HTTP：cookie 与 CSRF、权限矩阵、发布回滚与审计、rebase 冲突、契约闸、产品库锁定字段与补丁、匿名投影与 prod 401、锁丢失、文件模式、安全头、会话只读列表、CSV 导入、/console 托管）`,
);
process.exit(0);
