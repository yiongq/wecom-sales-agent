// 鉴权与后台接口自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」）。库用 PGlite。
// 前半是函数层（验收 15）：口令哈希、登录与会话、过期、限流、口令升级、平台命令行的账号操作，以及 prod 下后台 SSE 要求会话。
// 后半走 server.ts 的 app.request（子应用挂在真实位置上）：验收 5、6、9、15、16 的 HTTP 部分。
// 用法：npx tsx src/console-api/console.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { ConversationCounts, ConversationDetail, ConversationRow, OrderView, SopSectionText } from '../shared/console-api.js';
import type { ChatMessage, Session } from '../types.js';

// 先设临时 VAR_DIR 再动态 import：server 会连带加载 store.ts，它在加载时就读 VAR_DIR
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-console-selftest-'));
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微

// 02 第 13 步：db 存储才有的后台接口在子进程里测（store 是进程级单例，本进程跑的是文件存储），见末尾的 dbStoreChild
if (process.env.CONSOLE_SELFTEST_CHILD === 'db') await dbStoreChild();

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
// 租户名与 slug 不同，/me 的 tenantName 才测得出取的是 tenants.name（后台 UX spec 验收 15 第 1 条）；
// installSeededConfig 见到已有的 demo 租户就不再建
const TENANT_NAME = '云途定制旅行';
await t.pg.query(`insert into tenants (slug, name, pack_id) values ('demo', $1, 'travel')`, [TENANT_NAME]);
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
const { canonicalBody } = await import('../shared/sop-sections.js');

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
  // 像浏览器一样带 Accept-Encoding：不变量 26 要看接口在这时也不压缩
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? '203.0.113.80', 'accept-encoding': 'gzip, deflate, br' };
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
// 01「安全头」2026-09-27 修订：CSP 在原列各段之外另加 font-src 'self'；除带内容哈希的 /console/assets/* 外都带 no-store
const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; font-src 'self'";
const secured = (h: Headers): boolean =>
  h.get('content-security-policy') === CSP && h.get('cache-control') === 'no-store' && h.get('x-content-type-options') === 'nosniff';
/** 带内容哈希的 /console/assets/*：CSP 与 nosniff 同上，缓存一年、immutable（后台 UX spec「性能 · 缓存」） */
const securedAsset = (h: Headers): boolean =>
  h.get('content-security-policy') === CSP &&
  h.get('cache-control') === 'public, max-age=31536000, immutable' &&
  h.get('x-content-type-options') === 'nosniff';
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
  // console UX spec「登录」：界面只说「密码」，技术详情里的 detail 同步改（plan 第 15 步）
  check('HTTP 登录：失败的 detail 写「密码」，不写「口令」', wrong.body.detail === '邮箱或密码不对', wrong.text);
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
  check(
    'HTTP 登录：排队超时的 detail 写「密码」，不写「口令」',
    busy.length === 2 && busy.every((r) => r.body.detail === '密码校验排队超时，请稍后再试'),
    busy.map((r) => r.text).join(' | '),
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
  // 02 第 8 步开放了 priceFrom、bestSeason、inclusions、exclusions（spec「测试与 CI」允许改的断言）：它们不在这里了，
  // 改成后面「开放的计价与条款字段」断言能改且产生新版本；识别字段照旧 422
  const lockedChanges: Record<string, unknown> = {
    title: `${p.title}改`,
    destination: `${p.destination}改`,
    days: p.days + 1,
    segments: p.segments.includes('商务') ? p.segments.filter((x: string) => x !== '商务') : [...p.segments, '商务'],
    aliases: [...(p.aliases ?? []), '改名'],
    maxAltitude: (p.maxAltitude ?? 0) + 1,
    overseas: !p.overseas,
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
  check('产品库 HTTP：一次改多个锁定字段 → 422 逐个点名', all.status === 422 && all.body.fields?.length === 8, all.text.slice(0, 200));
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
  // 02「报价快照」：改了 active 条目的内容就是版本 2；不带 v 的链接按版本 1（改之前发出的那份），带 ?v=2 才是新内容
  const after = await proposal();
  const afterV2 = (await (await app.request(`/api/proposal/${code}?travelers=2&departDate=${departDate}&v=2`)).json()) as Body;
  check(
    '产品库 HTTP：改了 highlights，公开的方案书接口不带 v 仍是改之前的、?v=2 拿到新 highlights，quote 都不变',
    JSON.stringify(after.route.highlights) === JSON.stringify(p.highlights) &&
      JSON.stringify(afterV2.route.highlights) === JSON.stringify(hl) &&
      JSON.stringify(after.quote) === quoteBefore &&
      JSON.stringify(afterV2.quote) === quoteBefore,
  );

  // 开放的计价与条款字段（02 第 8 步，spec「测试与 CI」允许改的断言：原为逐个 422）：逐个能改、各写一个新的条目版本，
  // 改之前发出的方案书（不带 v）报价不变
  {
    let rev = (await get()).rev as number;
    const results: string[] = [];
    for (const [field, value] of Object.entries({
      priceFrom: p.priceFrom + 1000,
      bestSeason: '1月',
      inclusions: [...(p.inclusions ?? []), '改'],
      exclusions: [...(p.exclusions ?? []), '改'],
    })) {
      const v = cfg.currentCatalog().versions[`route:${code}`]!;
      const r = await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev, set: { [field]: value } } });
      if (r.status !== 200 || cfg.currentCatalog().versions[`route:${code}`] !== v + 1)
        results.push(`${field}:${r.status}:${r.text.slice(0, 80)}`);
      rev = r.body.rev as number;
    }
    check('产品库 HTTP：active 线路逐个改开放的计价与条款字段 → 200，各写一个新版本', results.length === 0, results.join(' | '));
    check('产品库 HTTP：改价之后，不带 v 的方案书报价不变', JSON.stringify((await proposal()).quote) === quoteBefore);
    const hotel = cfg.currentCatalog().hotels[0]!;
    const h = (await call('GET', `/catalog/hotel/${hotel.id}`, O)).body;
    const hp = await call('PATCH', `/catalog/hotel/${hotel.id}`, {
      ...O,
      json: { rev: h.rev, set: { nightlyFrom: hotel.nightlyFrom + 100 } },
    });
    const hn = await call('PATCH', `/catalog/hotel/${hotel.id}`, { ...O, json: { rev: hp.body.rev, set: { name: `${hotel.name}改` } } });
    check(
      '产品库 HTTP：active 酒店改 nightlyFrom → 200（02 开放），改 name 仍 422',
      hp.status === 200 && hn.status === 422 && JSON.stringify(hn.body.fields) === '["name"]',
      `${hp.text.slice(0, 120)} / ${hn.text.slice(0, 120)}`,
    );
  }

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
  // 后台 UX spec 验收 15 第 10 条：天数与逐日行程不符时，报错写「天数」，不写 payload 的键名 days
  check(
    '产品库 HTTP：天数与逐日行程不符 → 422 的报错里是「天数」，不是「days」',
    inv[1]!.status === 422 &&
      (inv[1]!.body.issues as { message: string }[]).some((i) => i.message.includes('要和天数（')) &&
      !inv[1]!.text.includes('days'),
    inv[1]!.text.slice(0, 200),
  );
  // 同一条的另外两处：编号不合规、天号不对，报错写「编号」「天号」，不写 payload 的键名 id、day
  const badCode = keep(await call('POST', '/catalog/route', { ...O, json: { payload: { ...structuredClone(p), id: 'R_Bad' } } }));
  const badDays = (cur4.payload.itinerary as Body[]).map((d, i) => (i === 1 ? { ...d, day: 5 } : d));
  const badDay = keep(await call('PATCH', `/catalog/route/${code}`, { ...O, json: { rev: cur4.rev, set: { itinerary: badDays } } }));
  const messages = (r: Res) => ((r.body.issues ?? []) as { message: string }[]).map((i) => i.message);
  check(
    '产品库 HTTP：编号不合规、天号不对 → 422 的报错里是「编号」「天号」，不是 id、day',
    badCode.status === 422 &&
      messages(badCode).some((m) => m.startsWith('编号只能')) &&
      messages(badCode).every((m) => !/\bid\b/.test(m)) &&
      badDay.status === 422 &&
      JSON.stringify(messages(badDay)) === JSON.stringify(['第2天的天号应为2']),
    `${badCode.text.slice(0, 200)} | ${badDay.text.slice(0, 200)}`,
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
  // console 表单删掉可选数组的最后一项、清空 intensity 的各项：rjsf 留下 [] 和全是 undefined 的对象。
  // 要当成没填才过得了共用 schema，差异里进 unset，服务端照收；必填的数组（tags）为空时照旧留着
  {
    const { z } = await import('zod');
    const { RouteSchema } = await import('../shared/catalog.js');
    const { formPayload, diffPayload } = await import('../../console/src/catalogForm.js');
    const required = z.toJSONSchema(RouteSchema, { io: 'input' }).required ?? [];
    const cur = await get('r-http-race');
    const raw = { ...structuredClone(cur.payload), aliases: [], inclusions: [], intensity: { level: undefined, hardest: undefined } };
    const next = formPayload(raw, required);
    const { set, unset } = diffPayload(cur.payload, next);
    check(
      '产品库表单：删空的可选数组、清空的可选对象当成没填，过得了 schema，差异里只有 unset',
      RouteSchema.safeParse(next).success && JSON.stringify(set) === '{}' && unset.toSorted().join() === 'aliases,inclusions,intensity',
      JSON.stringify({ set, unset }),
    );
    check('产品库表单：必填的空数组（tags）照旧留着', JSON.stringify(formPayload({ tags: [], aliases: [] }, required)) === '{"tags":[]}');
    const r = await call('PATCH', '/catalog/route/r-http-race', { ...O, json: { rev: cur.rev, set, unset } });
    check(
      '产品库表单：这样的补丁 → 200，三个键都没了',
      r.status === 200 && ['aliases', 'inclusions', 'intensity'].every((k) => !(k in r.body.payload)),
      r.text.slice(0, 200),
    );
  }
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
  // 02 第 8 步：原为「上架之后 priceFrom 锁定」，priceFrom 开放之后换成识别字段 title；priceFrom 改成能改、产生新版本
  const lockedNow = await call('PATCH', '/catalog/route/r-http-new', {
    ...O,
    json: { rev: act.body.rev, set: { title: '上架之后改名' } },
  });
  check(
    '上架 HTTP：上架之后 title 锁定',
    lockedNow.status === 422 && lockedNow.body.error === 'locked_field' && JSON.stringify(lockedNow.body.fields) === '["title"]',
  );
  const v1Http = cfg.currentCatalog().versions['route:r-http-new'];
  const pricedNow = await call('PATCH', '/catalog/route/r-http-new', { ...O, json: { rev: act.body.rev, set: { priceFrom: 1 } } });
  check(
    '上架 HTTP：上架之后 priceFrom 能改（02 开放），写下一个条目版本',
    pricedNow.status === 200 && v1Http === 1 && cfg.currentCatalog().versions['route:r-http-new'] === 2,
    pricedNow.text.slice(0, 200),
  );
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
  // 02 加了 needSummary、assignee、handoff、lastCustomerAt 四个键；02 第 21 步再加 amount（A2「需要你处理」排序用）
  check(
    '会话列表：每条只有 id、channel、stage、handedOver、messageCount、updatedAt、needSummary、assignee、handoff、lastCustomerAt、amount',
    JSON.stringify(Object.keys(c)) ===
      '["id","channel","stage","handedOver","messageCount","updatedAt","needSummary","assignee","handoff","lastCustomerAt","amount"]' &&
      c.handedOver === true &&
      c.stage === 'handoff' &&
      c.messageCount === 3 &&
      c.updatedAt === new Date(T + 5000).toISOString() &&
      c.amount === null,
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

  // 02 的四个新键的取值（02 spec「后台接口」ConversationRow）：接手人只投影 userId 与 name，转人工记录只投影 kind、ISO 的 at 与 reason，
  // lastCustomerAt 取客户最后一条消息的 sentAt（后面的 agent 消息不算）；有接手人的会话是第四态 assigned
  const D = 'wecom:conv-d';
  seed(D, 'wecom', T + 7000, (sess) => {
    sess.handedOver = true;
    sess.stage = 'handoff';
    sess.handoff = {
      kind: 'complaint',
      at: T + 1000,
      reason: '客户投诉',
      quote: '会话列表不该出现的原话',
      departNote: '会话列表不该出现的备注',
    };
    sess.assignee = { userId: 'u-conv-d', name: '小林', at: T + 2000 };
    sess.messages.push(
      { role: 'customer', content: '在吗', at: T + 1500, sentAt: T + 1200, msgid: 'msg-conv-d' },
      { role: 'agent', content: '在的', at: T + 2500, author: 'human', authorId: 'u-conv-d', authorName: '小林' },
    );
  });
  const assigned = await call('GET', '/conversations?state=assigned', O);
  const d = (assigned.body.items as Body[] | undefined)?.[0];
  check(
    '会话列表：assignee 恰为 {userId, name}，handoff 恰为 {kind, at（ISO）, reason}，lastCustomerAt 是客户那条的 sentAt',
    JSON.stringify(d?.assignee) === JSON.stringify({ userId: 'u-conv-d', name: '小林' }) &&
      JSON.stringify(d?.handoff) === JSON.stringify({ kind: 'complaint', at: new Date(T + 1000).toISOString(), reason: '客户投诉' }) &&
      d?.lastCustomerAt === new Date(T + 1200).toISOString(),
    JSON.stringify(d),
  );
  const dCounts = (await call('GET', '/conversations/counts', O)).body as { total: number; byState: Record<string, number> };
  check(
    '会话列表：有接手人的会话 byState.assigned 为 1、四项之和等于 total，?state=assigned 只返回它',
    dCounts.byState.assigned === 1 &&
      Object.values(dCounts.byState).reduce((a, b) => a + b, 0) === dCounts.total &&
      assigned.status === 200 &&
      assigned.body.total === 1 &&
      (assigned.body.items as Body[]).map((x) => x.id).join() === D,
    `${JSON.stringify(dCounts)} ${assigned.text.slice(0, 200)}`,
  );
  check(
    '会话列表：转人工记录的原话与出行时间备注不进列表',
    !assigned.text.includes('不该出现的原话') && !assigned.text.includes('不该出现的备注'),
  );

  // 02 第 21 步：amount（A2「需要你处理」排序用）——没有待付款订单时取最近报价总价，有订单时取订单总价；
  // 对所有角色给真值（排序要一致），A2 要不要把它画成文字是前端的事，不是这里打码
  const E = 'wecom:conv-e';
  seed(E, 'wecom', T + 8000, (sess) => {
    sess.lastQuote = { routeId: 'r-1', routeTitle: '测试线路', travelers: 2, total: 12_000 };
  });
  const eRow = ((await call('GET', '/conversations?limit=1', O)).body.items as Body[])[0];
  check('会话列表：amount 没有待付款订单时取最近报价总价', eRow?.id === E && eRow?.amount === 12_000, JSON.stringify(eRow));
  const eOrder = store.createOrder({
    sessionId: E,
    routeId: 'r-1',
    routeTitle: '测试线路',
    travelers: 2,
    departDate: '2030-03-01',
    totalPrice: 30_000,
  });
  const eSess = store.getSession(E)!;
  eSess.orderIds.push(eOrder.id);
  store.saveSession(eSess, false);
  const eRow2 = ((await call('GET', '/conversations?limit=1', O)).body.items as Body[])[0];
  check('会话列表：有待付款订单时 amount 取订单总价，不取最近报价总价', eRow2?.id === E && eRow2?.amount === 30_000, JSON.stringify(eRow2));
  const eRowAsAgent = ((await call('GET', '/conversations?limit=1', { as: agent })).body.items as Body[])[0];
  check(
    '会话列表：amount 对所有角色一致（坐席也收到真值，排序对齐；A2 不显示它是前端的事，不是接口按角色打码）',
    eRowAsAgent?.id === E && eRowAsAgent?.amount === 30_000,
    JSON.stringify(eRowAsAgent),
  );

  // 下一段按 ai / human / paid 三态逐条核对：把接手人摘掉，它回到等人接手
  const dSess = store.getSession(D)!;
  delete dSess.assignee;
  store.saveSession(dSess, false);
}

// 后台 UX spec 验收 15 第 5、6 条：会话的 state / stage / order 过滤与排序，/conversations/counts 与列表同源。
// 判定按 spec 的规则在这里逐条写出来，不调 conversationState：paid 是停在行业包终态的会话（旅游包只有 paid 一个终态）；
// human 是转人工且没成交；其余是 ai。块末尾把租户的包换成家装假包（终态 deposit），同样逐条核对，换回以后各数不变
{
  const store = await import('../store.js');
  const { conversationState, shortIdOf } = await import('../shared/conversation.js');
  type Row = Body & { id: string; stage: string; handedOver: boolean; updatedAt: string };
  const RULE: Record<string, (r: { stage: string; handedOver: boolean }) => boolean> = {
    ai: (r) => !r.handedOver && r.stage !== 'paid',
    human: (r) => r.handedOver && r.stage !== 'paid',
    paid: (r) => r.stage === 'paid',
  };
  const T2 = Date.parse('2030-02-01T00:00:00Z');
  const seed = (id: string, stage: string, handedOver: boolean, at: number) => {
    const sess = store.getOrCreateSession(id, 'wecom');
    sess.stage = stage as typeof sess.stage;
    sess.handedOver = handedOver;
    sess.updatedAt = at;
    store.saveSession(sess, false);
  };
  // 等人接手的 H01 最后动静最早：01 的顺序里排在最后，waiting_first 要把它提到最前；它的 stage 是 quote，按 stage 单独过滤时要算进去
  seed('wecom:cust_H01', 'quote', true, T2 - 86_400_000);
  seed('wecom:cust_H02', 'handoff', true, T2 + 500);
  seed('wecom:cust_P01', 'paid', false, T2 + 1000);
  seed('wecom:cust_P02', 'paid', true, T2 + 1100); // 付款以后又转过人工：算已成交，不算等人接手
  seed('wecom:cust_Q01', 'quote', false, T2 + 2000);
  seed('wecom:cust_Q02', 'quote', false, T2 + 2000);
  seed('wecom:cust_R01', 'recommend', false, T2 + 3000);
  seed('wecom:cust_O01', 'objection', false, T2 + 4000);
  seed('sim-convvisitor000000000000000002', 'quote', true, T2 + 5000);

  /** 按 limit=3 逐页翻完，返回 total 与全部行 */
  const pageAll = async (qs: string): Promise<{ total: number; rows: Row[]; statuses: number[] }> => {
    const rows: Row[] = [];
    const statuses: number[] = [];
    let total = -1;
    for (let offset = 0; total < 0 || offset < total; offset += 3) {
      const r = await call('GET', `/conversations?limit=3&offset=${offset}${qs}`, O);
      statuses.push(r.status);
      if (r.status !== 200) break;
      total = r.body.total as number;
      rows.push(...(r.body.items as Row[]));
      if (!(r.body.items as Row[]).length) break;
    }
    return { total, rows, statuses };
  };
  const all = await pageAll('');
  const per = Object.fromEntries(await Promise.all(['ai', 'human', 'paid'].map(async (s) => [s, await pageAll(`&state=${s}`)] as const)));
  check(
    '会话 state：三个取值的 total 之和等于不带 state 时的 total，三组的行拼起来正好是全部会话',
    per.ai.total + per.human.total + per.paid.total === all.total &&
      [per.ai, per.human, per.paid].every((p) => p.rows.length === p.total) &&
      [...per.ai.rows, ...per.human.rows, ...per.paid.rows]
        .map((r) => r.id)
        .toSorted()
        .join() ===
        all.rows
          .map((r) => r.id)
          .toSorted()
          .join(),
    `${per.ai.total}+${per.human.total}+${per.paid.total} / ${all.total}`,
  );
  const wrong = Object.entries(per).flatMap(([s, p]) => p.rows.filter((r) => !RULE[s]!(r)).map((r) => `${s}:${r.id}`));
  check('会话 state：每一页的行都满足对应状态的条件', wrong.length === 0 && per.human.total >= 3 && per.paid.total >= 2, wrong.join(','));
  check(
    '会话 state：付款以后又转人工的算已成交；等人接手的包括 stage 不是 handoff 的',
    per.paid.rows.some((r) => r.id === 'wecom:cust_P02') &&
      !per.human.rows.some((r) => r.id === 'wecom:cust_P02') &&
      per.human.rows.some((r) => r.id === 'wecom:cust_H01'),
  );
  const leakedKeys = all.rows.filter((r) => ['profile', 'nickname', 'messages'].some((k) => k in r) || Object.keys(r).length !== 11);
  check(
    '会话列表：ConversationRow 的键里没有 profile、nickname、messages，只有 11 个投影字段（02 加了 4 个、第 21 步再加 amount）',
    all.rows.length > 0 && leakedKeys.length === 0,
    leakedKeys.map((r) => Object.keys(r).join('|')).join(' '),
  );

  // order=waiting_first：独立按 spec 排一遍（等人接手的在前，组内和其余都按 (updatedAt desc, id)）
  const listed = store.listSessions().filter((s) => !s.id.startsWith('sim-'));
  const recent = (a: (typeof listed)[number], b: (typeof listed)[number]) =>
    b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const humans = listed.filter((s) => RULE.human!(s)).toSorted(recent);
  const expectedOrder = [...humans, ...listed.filter((s) => !RULE.human!(s)).toSorted(recent)].map((s) => s.id);
  const wf = await call('GET', '/conversations?order=waiting_first', O);
  const wfIds = (wf.body.items as Row[]).map((r) => r.id);
  check(
    'order=waiting_first：第一页先列完全部等人接手的会话，组内与其余都按最后动静倒序',
    wf.status === 200 &&
      wf.body.total === listed.length &&
      humans.length >= 3 &&
      wfIds.slice(0, humans.length).join() === humans.map((s) => s.id).join() &&
      wfIds.join() === expectedOrder.slice(0, 20).join(),
    wfIds.join(),
  );
  const wfPaged = await pageAll('&order=waiting_first');
  const plainTop = (await call('GET', `/conversations?limit=${humans.length}`, O)).body.items as Row[];
  check(
    'order=waiting_first：服务端排好再分页，逐页翻完与整体顺序一致；不带 order 时仍是 01 的顺序',
    wfPaged.rows.map((r) => r.id).join() === expectedOrder.join() &&
      !plainTop.some((r) => r.id === 'wecom:cust_H01') &&
      all.rows.map((r) => r.id).join() ===
        listed
          .toSorted(recent)
          .map((s) => s.id)
          .join(),
  );
  check(
    'order=waiting_first 与 state 一起用：只在过滤后的结果里排',
    (await pageAll('&state=ai&order=waiting_first')).rows.map((r) => r.id).join() === per.ai.rows.map((r) => r.id).join(),
  );

  // stage 独立按 row.stage 过滤
  const quoteAll = await pageAll('&stage=quote');
  const quoteAi = await pageAll('&state=ai&stage=quote');
  check(
    '会话 stage：独立按 stage 过滤（含 stage 是 quote 的等人接手会话），与 state=ai 一起用时两个条件都满足',
    quoteAll.total === listed.filter((s) => s.stage === 'quote').length &&
      quoteAll.rows.every((r) => r.stage === 'quote') &&
      quoteAll.rows.some((r) => r.id === 'wecom:cust_H01') &&
      quoteAi.total === quoteAll.total - quoteAll.rows.filter((r) => !RULE.ai!(r)).length &&
      quoteAi.rows.every((r) => r.stage === 'quote' && RULE.ai!(r)) &&
      quoteAi.total >= 2,
    `${quoteAll.total} / ${quoteAi.total}`,
  );
  const bad = await Promise.all(
    ['state=handoff', 'state=AI', 'stage=Quote', 'stage=quote-1', `stage=${'a'.repeat(33)}`, 'order=latest'].map(
      async (q) => (await call('GET', `/conversations?${q}`, O)).status,
    ),
  );
  check(
    '会话列表：state、stage、order 的取值不合规 → 400',
    bad.every((s) => s === 400),
    bad.join(','),
  );

  // 验收 15 第 6 条：counts
  const counts = keep(await call('GET', '/conversations/counts', O));
  const cb = counts.body as { total: number; byState: Record<string, number>; aiByStage: Record<string, number>; updatedToday: number };
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  check(
    'counts：byState 四项之和等于 total，aiByStage 之和等于 byState.ai（不变量 18；02 加了 assigned）',
    counts.status === 200 &&
      JSON.stringify(Object.keys(cb.byState).toSorted()) === '["ai","assigned","human","paid"]' &&
      sum(cb.byState) === cb.total &&
      sum(cb.aiByStage) === cb.byState.ai,
    counts.text,
  );
  const stageTotals = await Promise.all(
    Object.keys(cb.aiByStage).map(async (st) => [st, (await call('GET', `/conversations?state=ai&stage=${st}&limit=1`, O)).body.total]),
  );
  check(
    'counts：total 与各 state 等于列表的 total，aiByStage 每一项等于 state=ai&stage=… 的 total，不计 sim- 会话',
    cb.total === all.total &&
      cb.byState.ai === per.ai.total &&
      cb.byState.human === per.human.total &&
      cb.byState.paid === per.paid.total &&
      cb.aiByStage.quote === quoteAi.total &&
      stageTotals.length >= 3 &&
      stageTotals.every(([st, n]) => cb.aiByStage[st as string] === n),
    `${counts.text} ${JSON.stringify(stageTotals)}`,
  );
  // updatedToday：按服务器时区的今天 0 点算，0 点前 1 毫秒的不算、0 点整的算。
  // 钉一个不是 UTC 的时区再测：CI 跑在 UTC 下，本地 0 点和 UTC 0 点是同一刻，写成 UTC 0 点也测不出来；测完还原
  const savedTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const midnight = new Date().setHours(0, 0, 0, 0);
    const today = async () => ((await call('GET', '/conversations/counts', O)).body as typeof cb).updatedToday;
    const t0 = await today();
    seed('wecom:cust_Y01', 'greeting', false, midnight - 1);
    const t1 = await today();
    seed('wecom:cust_Z01', 'greeting', false, midnight);
    const t2 = await today();
    check(
      'counts：updatedToday 从服务器时区（钉成 Asia/Shanghai）的今天 0 点算起，不是 UTC 0 点',
      midnight !== new Date(midnight).setUTCHours(0, 0, 0, 0) && t1 === t0 && t2 === t0 + 1,
      `${t0} ${t1} ${t2}`,
    );
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
  const AGENT2 = { email: 'agent2@example.com', password: 'agent2-password-1' };
  await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: AGENT2.email, name: '坐席丁', role: 'agent', password: pw(AGENT2.password) }),
  );
  const agent = await httpLogin(AGENT2.email, AGENT2.password, '203.0.113.96');
  const anonCounts = keep(await call('GET', '/conversations/counts', { ip: '198.51.100.201' }));
  check(
    'counts：权限与会话列表相同，非编辑角色（agent）能看，匿名 401',
    (await call('GET', '/conversations/counts', { as: agent })).status === 200 && anonCounts.status === 401,
  );
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  try {
    check('counts：prod 匿名 401', (await call('GET', '/conversations/counts', { ip: '198.51.100.201' })).status === 401);
  } finally {
    __profileTest.reset();
  }

  // 已成交按租户行业包的终态判定（不变量 17）：家装假包的终态是「已付定金」deposit；旅游包的 paid 在它那里是包外的阶段
  const { renovation } = await import('../shared/pack-fixtures/renovation.js');
  const { packById } = await import('../packs/registry.js');
  const travelPack = packById('travel')!;
  const RENO: typeof RULE = {
    ai: (r) => !r.handedOver && r.stage !== 'deposit',
    human: (r) => r.handedOver && r.stage !== 'deposit',
    paid: (r) => r.stage === 'deposit',
  };
  seed('wecom:cust_V01', 'deposit', false, T2 + 6000);
  seed('wecom:cust_V02', 'deposit', true, T2 + 6100); // 付了定金以后又转人工：家装包里算已成交
  seed('wecom:cust_V03', 'measure', true, T2 + 6200);
  const countsNow = async () => {
    const r = await call('GET', '/conversations/counts', O);
    return { status: r.status, text: r.text, body: r.body as typeof cb };
  };
  const idsOf = (p: { rows: Row[] }) => p.rows.map((r) => r.id);
  const tCounts = await countsNow();
  const tPer = Object.fromEntries(await Promise.all(['ai', 'human', 'paid'].map(async (s) => [s, await pageAll(`&state=${s}`)] as const)));
  check(
    '旅游包：deposit 不是它的阶段，停在那里的会话照旧算 AI 接待中或等人接手，已成交只有 paid',
    idsOf(tPer.ai!).includes('wecom:cust_V01') &&
      idsOf(tPer.human!).includes('wecom:cust_V02') &&
      tPer.paid!.rows.every((r) => r.stage === 'paid') &&
      tCounts.body.aiByStage.deposit === 1 &&
      tCounts.body.byState.paid === tPer.paid!.total,
    tCounts.text,
  );
  const prevPack = cfg.__configTest.swapPack(renovation);
  try {
    // 02 第 3 步：引擎与旧接口判「阶段是不是终态」在 DB 配置模式下取租户的行业包，不是注册表里的旅游包
    const { isTerminalStage, terminalStageKey } = await import('../handoff/record.js');
    check(
      '终态判定：DB 配置模式下按租户的行业包（家装包的 deposit 是终态，旅游包的 paid 不是）',
      isTerminalStage('deposit') && !isTerminalStage('paid') && String(terminalStageKey()) === 'deposit',
      `${isTerminalStage('deposit')} ${isTerminalStage('paid')} ${terminalStageKey()}`,
    );
    const rCounts = await countsNow();
    const rAll = await pageAll('');
    const rPer = Object.fromEntries(
      await Promise.all(['ai', 'human', 'paid'].map(async (s) => [s, await pageAll(`&state=${s}`)] as const)),
    );
    const rWrong = Object.entries(rPer).flatMap(([s, p]) => p.rows.filter((r) => !RENO[s]!(r)).map((r) => `${s}:${r.id}`));
    check(
      '家装包：state=paid 是停在「已付定金」的会话（含转过人工的），paid 阶段的会话算 AI 接待中或等人接手',
      rWrong.length === 0 &&
        idsOf(rPer.paid!).toSorted().join() === 'wecom:cust_V01,wecom:cust_V02' &&
        idsOf(rPer.ai!).includes('wecom:cust_P01') &&
        idsOf(rPer.human!).includes('wecom:cust_P02') &&
        idsOf(rPer.human!).includes('wecom:cust_V03') &&
        rPer.ai!.total + rPer.human!.total + rPer.paid!.total === rAll.total,
      rWrong.join(','),
    );
    check(
      '家装包：counts 与列表同源，byState 按终态分，aiByStage 里没有终态、有包外的 paid',
      rCounts.status === 200 &&
        rCounts.body.byState.paid === 2 &&
        rCounts.body.byState.ai === rPer.ai!.total &&
        rCounts.body.byState.human === rPer.human!.total &&
        rCounts.body.total === rAll.total &&
        sum(rCounts.body.aiByStage) === rCounts.body.byState.ai &&
        !('deposit' in rCounts.body.aiByStage) &&
        rCounts.body.aiByStage.paid === 1,
      rCounts.text,
    );
    const rListed = store.listSessions().filter((x) => !x.id.startsWith('sim-'));
    const rHumans = rListed.filter((x) => RENO.human!(x)).toSorted(recent);
    const rWf = await pageAll('&order=waiting_first');
    check(
      '家装包：waiting_first 先列完按终态判的等人接手（转人工后付了定金的不在其中）',
      idsOf(rWf).slice(0, rHumans.length).join() === rHumans.map((x) => x.id).join() &&
        !rHumans.some((x) => x.id === 'wecom:cust_V02') &&
        rHumans.some((x) => x.id === 'wecom:cust_P02'),
      idsOf(rWf).join(),
    );
  } finally {
    cfg.__configTest.swapPack(prevPack);
  }
  check('换回旅游包：counts 与换之前逐字节相同', (await countsNow()).text === tCounts.text, tCounts.text);

  // 全站唯一的判定与短码
  check(
    'conversationState：旅游包的终态 paid 优先，其次转人工，其余 AI 接待中',
    conversationState({ stage: 'paid', handedOver: true }, travelPack) === 'paid' &&
      conversationState({ stage: 'handoff', handedOver: true }, travelPack) === 'human' &&
      conversationState({ stage: 'quote', handedOver: true }, travelPack) === 'human' &&
      conversationState({ stage: 'handoff', handedOver: false }, travelPack) === 'ai' &&
      conversationState({ stage: 'closing', handedOver: false }, travelPack) === 'ai',
  );
  check(
    'conversationState：家装包只认终态 deposit；paid 不是它的终态；没有终态的包里没有已成交',
    conversationState({ stage: 'deposit', handedOver: true }, renovation) === 'paid' &&
      conversationState({ stage: 'deposit', handedOver: false }, renovation) === 'paid' &&
      conversationState({ stage: 'paid', handedOver: false }, renovation) === 'ai' &&
      conversationState({ stage: 'paid', handedOver: true }, renovation) === 'human' &&
      conversationState({ stage: 'sign', handedOver: false }, renovation) === 'ai' &&
      conversationState({ stage: 'paid', handedOver: false }, { stages: travelPack.stages.map(({ terminal: _t, ...st }) => st) }) === 'ai',
  );
  const vm = await import('node:vm');
  const adminSrc = /const shortIdOf = (s => .+);\n/.exec(fs.readFileSync(new URL('../../public/admin.html', import.meta.url), 'utf8'))?.[1];
  const adminShortId = adminSrc ? (vm.runInNewContext(`(${adminSrc})`) as (s: { id: string }) => string) : null;
  const ids = [
    'wecom:cust_A01',
    'wecom:cust_F01',
    'wecom:wmAbCdEf12',
    'wecom:o-x_y.z9',
    'sim-ab12cd34',
    'cust_7f3a',
    'wecom:custA1',
    'custom42',
    '',
    'wecom:',
    '企微',
  ];
  const differ = ids.filter((id) => !adminShortId || shortIdOf(id) !== adminShortId({ id }));
  check(
    'shortIdOf：与 public/admin.html 的短码规则逐个相同（wecom:cust_A01 → A01）',
    !!adminShortId && differ.length === 0 && shortIdOf('wecom:cust_A01') === 'A01' && shortIdOf('wecom:o-x_y.z9') === 'XYZ9',
    differ.join(','),
  );
}

// 后台 UX spec 验收 15 第 1、7 条：/me 带 tenantName；/pack 下发当前租户的行业包
{
  const { packById, PACK_IDS } = await import('../packs/registry.js');
  const me = keep(await call('GET', '/me', O));
  check(
    '/me：带 tenantName，取启动时装载的 tenants.name',
    me.status === 200 && me.body.tenantName === TENANT_NAME && me.body.tenantSlug === 'demo',
    me.text,
  );
  const travel = packById('travel');
  // 前面的用例停用了 READER，它的会话已经失效：另建一个只读成员，确认成员身份下也拿得到（不是被当成匿名放行的）
  const VIEWER2 = { email: 'viewer2@example.com', password: 'viewer2-password-1' };
  await asPlatform(() =>
    accounts.createUser(t.db, { tenantSlug: 'demo', email: VIEWER2.email, name: '只读戊', role: 'viewer', password: pw(VIEWER2.password) }),
  );
  const viewer = await httpLogin(VIEWER2.email, VIEWER2.password, '203.0.113.97');
  const packs = [
    keep(await call('GET', '/pack', O)),
    await call('GET', '/pack', { as: viewer }),
    await call('GET', '/pack', { ip: '198.51.100.202' }),
  ];
  check(
    '/pack：所有者、只读成员与 demo 匿名都返回旅游包（与注册表里的逐字段相同）',
    !!travel &&
      viewer.body.role === 'viewer' &&
      (await call('GET', '/me', { as: viewer })).status === 200 &&
      packs.every((r) => r.status === 200 && JSON.stringify(r.body) === JSON.stringify(travel)) &&
      packs[0]!.body.id === 'travel',
    packs.map((r) => `${r.status} ${r.text.slice(0, 60)}`).join(' | '),
  );
  const tenantId = cfg.configRuntime().tenantId;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const leaked = [TENANT_NAME, tenantId, '"demo"', '老板', ADMIN.name, READER.name].filter((k) => packs.some((r) => r.text.includes(k)));
  check(
    '/pack：响应里没有租户名、slug、租户 id 和成员姓名（不变量 27）',
    leaked.length === 0 && !packs.some((r) => UUID.test(r.text)),
    leaked.join(','),
  );
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  try {
    const anon = keep(await call('GET', '/pack', { ip: '198.51.100.202' }));
    check('/pack：prod 匿名 401，成员照常 200', anon.status === 401 && (await call('GET', '/pack', O)).status === 200, anon.text);
  } finally {
    __profileTest.reset();
  }
  check(
    '注册表：只有 travel；查不到的包名和原型上的名字都返回 null',
    PACK_IDS.join() === 'travel' && packById('renovation') === null && packById('toString') === null && packById('__proto__') === null,
  );

  // 包不在注册表里时拒绝启动：用一份全新的配置源模块实例装载，不动本进程已装好的这份
  await asSuper(() => t.pg.query(`insert into tenants (slug, name, pack_id) values ('nopack', '没有包的租户', 'renovation')`));
  const fresh = (await import(new URL('../config/source.js?pack-unknown', import.meta.url).href)) as typeof import('../config/source.js');
  let reason = 'ok';
  try {
    await fresh.initConfig(testConfigDeps(t, { tenantSlug: 'nopack' }));
  } catch (e) {
    reason = e instanceof Error && 'reason' in e ? String(e.reason) : String(e);
  }
  check('启动：租户的行业包不在注册表里 → 以 pack_unknown 拒绝启动', reason === 'pack_unknown', reason);

  // tenant-create 的 --pack 读注册表：包名检查在连库之前，不设连接串也跑得到
  const { spawnSync } = await import('node:child_process');
  const cli = (pack: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/tenant-create.ts', '--slug', 'x', '--name', 'x', '--pack', pack], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DATABASE_PLATFORM_URL: '' },
    });
  const unknownPack = cli('renovation');
  const knownPack = cli('travel');
  check(
    'tenant-create：--pack 只收注册表里的包（报错列出 travel）；travel 过了包名检查，走到缺连接串',
    unknownPack.status === 1 &&
      unknownPack.stderr.includes('--pack 只能是 travel') &&
      knownPack.status === 1 &&
      knownPack.stderr.includes('缺少环境变量 DATABASE_PLATFORM_URL'),
    `${unknownPack.status} ${unknownPack.stderr.slice(0, 80)} | ${knownPack.status} ${knownPack.stderr.slice(0, 80)}`,
  );
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
  // console 读选中的文件：按 UTF-8 严格解码。GBK 的文件（中文 Windows 上 Excel 默认另存的 CSV）不能被静默换成替换符再建成乱码草稿
  const { decodeCsvFile } = await import('../../console/src/csvFile.js');
  const sanya = `id,name${NL}h-1,三亚海景酒店${NL}`;
  check('CSV 文件：UTF-8（带 BOM）照常解出，BOM 去掉', decodeCsvFile(Buffer.from(`${BOM}${sanya}`, 'utf8')) === sanya);
  const gbk = Uint8Array.from([...Buffer.from(`id,name${NL}h-1,`), 0xc8, 0xfd, 0xd1, 0xc7, 0x0a]); // 「三亚」的 GBK 编码
  check(
    'CSV 文件：不是 UTF-8（GBK）→ CsvEncodingError，不换成替换符照收',
    (await errName(Promise.resolve().then(() => decodeCsvFile(gbk)))) === 'CsvEncodingError',
  );

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
      (r) => JSON.stringify(r.body.rows) === JSON.stringify([{ row: 2, issues: [{ path: 'id', message: '这个编号已经有了' }] }]),
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

// 后台 UX spec 验收 15 第 9 条：酒店 CSV 用中文表头导入，结果与英文表头相同（标签表取自租户的行业包）；
// 带「制表符 + =」前缀的格子（导入弹窗下载不合格行时加的防公式前缀），导入后前缀被去掉。
// 另走一遍验收 19 的「改好后重新导入」：下载的文件每格加引号、带 BOM 和「不合格原因」列，原样交上去，这一列不进数据
{
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const BOM = String.fromCharCode(0xfeff);
  const cells = (id: string): string[] => [
    id,
    '中文表头酒店',
    '三亚',
    `${TAB}=五星`,
    '1880',
    `${TAB}@海景房`,
    '私人沙滩、无边泳池',
    '海岛',
  ];
  const en = ['id,name,destination,stars,nightlyFrom,roomType,highlights,tags', cells('h-head-en').join(',')].join(NL);
  const zh = ['酒店编号,酒店名称,目的地,星级档次,每晚起价,主推房型,酒店亮点,标签', cells('h-head-zh').join(',')].join(NL);
  const a = await call('POST', '/catalog/hotel/import-csv', { ...O, json: { csv: en } });
  const b = await call('POST', '/catalog/hotel/import-csv', { ...O, json: { csv: zh } });
  const payloadOf = (r: Res): Body | undefined => (r.body.items as Body[] | undefined)?.[0]?.payload as Body | undefined;
  const sameButId = (x: Body | undefined, y: Body | undefined): boolean =>
    !!x && !!y && JSON.stringify({ ...x, id: '' }) === JSON.stringify({ ...y, id: '' });
  check(
    '验收 15 第 9 条：中文表头导入 → 200，payload 与英文表头的相同（键序也相同），只差编号',
    a.status === 200 && b.status === 200 && sameButId(payloadOf(a), payloadOf(b)) && payloadOf(b)?.id === 'h-head-zh',
    `${a.text.slice(0, 200)} | ${b.text.slice(0, 200)}`,
  );
  check(
    '验收 15 第 9 条：「制表符 + =」「制表符 + @」开头的格子，导入后前缀去掉',
    payloadOf(b)?.stars === '=五星' && payloadOf(b)?.roomType === '@海景房',
    JSON.stringify(payloadOf(b)),
  );
  const q = (s: string): string => `"${s.replaceAll('"', '""')}"`;
  const fixed = [
    ['酒店编号', '酒店名称', '目的地', '星级档次', '每晚起价', '主推房型', '酒店亮点', '标签', '不合格原因'].map(q).join(','),
    [...cells('h-head-fixed'), '每晚起价：要写整数，写的是「2,6OO」'].map(q).join(','),
  ].join(String.fromCharCode(13, 10));
  const c = await call('POST', '/catalog/hotel/import-csv', { ...O, json: { csv: `${BOM}${fixed}` } });
  check(
    '验收 19：下载的不合格行文件改好后原样重新导入 → 200，「不合格原因」列不进数据，防公式前缀不进数据',
    c.status === 200 && sameButId(payloadOf(c), payloadOf(a)) && !JSON.stringify(payloadOf(c)).includes('不合格'),
    c.text.slice(0, 300),
  );
  const mixed = await call('POST', '/catalog/hotel/import-csv', {
    ...O,
    json: { csv: ['id,酒店编号,name,destination,stars,nightlyFrom,roomType,highlights,tags', `h-x,${cells('h-x').join(',')}`].join(NL) },
  });
  check(
    '中文标签与字段名指向同一个字段 → 422 第 0 行「表头重复」，点名后出现的那一列',
    mixed.status === 422 &&
      JSON.stringify(mixed.body.rows) === JSON.stringify([{ row: 0, issues: [{ path: '酒店编号', message: '表头重复' }] }]),
    mixed.text,
  );
}

// 后台 UX spec 验收 15 第 8 条：AuditQuery.actions 只返回列表里的动作，在库里过滤，所以翻页不出空页；
// 同时给 action 与 actions 返回 400
{
  interface Row {
    id: number;
    action: string;
  }
  /** 按 limit 一页页翻完，记下每页的条数；翻页出错时停下，记在 failed 里（由下面的断言点名，不抛） */
  const walk = async (
    query: string,
    limit: number,
  ): Promise<{ rows: Row[]; sizes: number[]; lastNull: boolean; failed: string | null }> => {
    const rows: Row[] = [];
    const sizes: number[] = [];
    let before: number | null = null;
    for (let i = 0; i < 500; i += 1) {
      const r = keep(await call('GET', `/audit?limit=${limit}${query}${before === null ? '' : `&before=${before}`}`, O));
      if (r.status !== 200) return { rows, sizes, lastNull: false, failed: `第 ${i + 1} 页 ${r.status} ${r.text.slice(0, 80)}` };
      const items = r.body.items as Row[];
      rows.push(...items);
      sizes.push(items.length);
      before = r.body.nextBefore as number | null;
      if (before === null) return { rows, sizes, lastNull: true, failed: null };
    }
    return { rows, sizes, lastNull: false, failed: '翻了 500 页还没翻完' };
  };
  const everything = (await walk('', 100)).rows;
  // 挑两种在日志里稀疏、彼此隔得开的动作：在客户端按页过滤的话，limit=2 的某些页会是空的，测得出「在库里过滤」
  const WANTED = ['sop.discard', 'catalog.activate'];
  const expected = everything.filter((r) => WANTED.includes(r.action));
  let gap = 0;
  let widest = 0;
  for (const r of everything) {
    gap = WANTED.includes(r.action) ? 0 : gap + 1;
    widest = Math.max(widest, gap);
  }
  const filtered = await walk(`&actions=${WANTED.join(',')}`, 2);
  const ids = filtered.rows.map((r) => r.id);
  check(
    'AuditQuery.actions：逐页翻完，只有列表里的动作，与全部记录里挑出来的逐条相同（id 倒序、不重复）',
    expected.length >= 4 &&
      filtered.failed === null &&
      new Set(expected.map((r) => r.action)).size === WANTED.length &&
      widest >= 2 &&
      filtered.lastNull &&
      JSON.stringify(ids) === JSON.stringify(expected.map((r) => r.id)) &&
      ids.every((id, i) => i === 0 || id < ids[i - 1]!),
    `期望 ${expected.length} 条，最宽间隔 ${widest}；${filtered.failed ?? ''} 拿到 ${JSON.stringify(filtered.rows.map((r) => [r.id, r.action]))}`,
  );
  check(
    'AuditQuery.actions：翻页不出空页，除最后一页外每页都是满的',
    filtered.sizes.length === Math.ceil(expected.length / 2) &&
      filtered.sizes.every((n, i) => (i < filtered.sizes.length - 1 ? n === 2 : n >= 1 && n <= 2)),
    filtered.sizes.join(','),
  );
  const single = await call('GET', '/audit?limit=100&actions=sop.rollback', O);
  const byAction = await call('GET', '/audit?limit=100&action=sop.rollback', O);
  check(
    'AuditQuery.actions：只给一个动作时与 action 的结果相同；列表里有日志里没有的动作不影响其余的',
    single.status === 200 &&
      single.body.items.length > 0 &&
      single.text === byAction.text &&
      (await call('GET', '/audit?limit=100&actions=sop.rollback,nope.never', O)).text === byAction.text,
  );
  const bad = [
    ['同时给 action 与 actions', '/audit?action=sop.publish&actions=sop.publish'],
    ['大写', '/audit?actions=SOP.publish'],
    ['空的一项', '/audit?actions=sop.publish,'],
    ['空串', '/audit?actions='],
    ['33 个', `/audit?actions=${Array.from({ length: 33 }, (_, i) => `a.b${'_'.repeat(i)}`).join(',')}`],
    ['一项超过 64 个字符', `/audit?actions=${'a'.repeat(65)}`],
  ] as const;
  const wrong: string[] = [];
  for (const [name, url] of bad) {
    const r = keep(await call('GET', url, O));
    if (!(r.status === 400 && r.body.error === 'bad_request')) wrong.push(`${name}: ${r.status} ${r.text.slice(0, 80)}`);
  }
  check('AuditQuery.actions：同时给 action 与 actions、格式不对、超过 32 个 → 400 bad_request', wrong.length === 0, wrong.join(' | '));
  const most = await call('GET', `/audit?limit=1&actions=${Array.from({ length: 32 }, (_, i) => `a.b${'_'.repeat(i)}`).join(',')}`, O);
  check('AuditQuery.actions：32 个正好收下（200、没有记录）', most.status === 200 && most.body.items.length === 0, most.text);

  // AUDIT_ACTIONS 就是系统写审计的全部动作：src/ 下 writeAudit、queueAudit 写的 action 字面量与它逐个相同，新加一种动作要同时给它中文
  const { AUDIT_ACTIONS, auditActionsParam } = await import('../shared/ui-labels.js');
  const srcRoot = fileURLToPath(new URL('..', import.meta.url));
  const written = new Set<string>();
  const scan = (dir: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) scan(p);
      else if (d.name.endsWith('.ts') && !d.name.endsWith('.selftest.ts')) {
        const text = fs.readFileSync(p, 'utf8');
        // 02 第 13 步起会话类审计经 store 的 queueAudit（随会话落库，或单独一个短事务）
        if (!text.includes('writeAudit(') && !text.includes('queueAudit(')) continue;
        for (const m of text.matchAll(/\baction:\s*'([a-z_]+\.[a-z_]+)'/g)) written.add(m[1]!);
      }
    }
  };
  scan(srcRoot);
  const known = Object.keys(AUDIT_ACTIONS);
  check(
    'AUDIT_ACTIONS 与 src/ 里 writeAudit 写的动作逐个相同（不多不少）',
    written.size >= 17 && [...written].toSorted().join() === known.toSorted().join(),
    `写的有、表里没有：${[...written].filter((a) => !known.includes(a)).join(',')}；表里有、没人写：${known.filter((a) => !written.has(a)).join(',')}`,
  );
  // 审计页「全部」不显示登录记录时的请求，与全部记录里去掉登录、退出的逐条相同
  const noLogin = await walk(`&actions=${auditActionsParam('all', false)}`, 100);
  check(
    'AuditQuery.actions：「全部」不显示登录记录 = 去掉登录与退出的全部记录',
    noLogin.failed === null &&
      JSON.stringify(noLogin.rows.map((r) => r.id)) ===
        JSON.stringify(everything.filter((r) => r.action !== 'auth.login' && r.action !== 'auth.logout').map((r) => r.id)) &&
      everything.some((r) => r.action === 'auth.login'),
  );

  // 这一整轮自测写进库的真实审计记录，用真实的旅游包写成句子：每种动作都认识；对象和版本号「v3」以外没有英文（动作编码、
  // 字段原名、命令名）；产品库改动的每个字段、发布改的每一节都叫得出中文名（不出现「另N项」「另N节」）
  const { describeAudit } = await import('../shared/audit-text.js');
  const { packById } = await import('../packs/registry.js');
  const travel = packById('travel')!;
  const real = everything as unknown as import('../shared/console-api.js').AuditEntryView[];
  const odd: string[] = [];
  for (const e of real) {
    const t = describeAudit(e, travel);
    const rest = [...t.parts.filter((p) => !p.strong).map((p) => p.text), t.tail ?? '', t.summary ?? ''].join('');
    if (
      t.group === null ||
      /[A-Za-z_]/.test(rest.replace(/v\d+/g, '')) ||
      /另\d+[项节]/.test(t.text) ||
      known.some((a) => t.text.includes(a))
    )
      odd.push(`${e.action} → ${t.text} / ${t.summary}`);
  }
  const kinds = new Set(real.map((e) => e.action));
  check(
    'describeAudit：真实审计记录（旅游包）每条都写成中文句子，字段和节都叫得出名字',
    odd.length === 0 &&
      ['catalog.update', 'catalog.create', 'sop.publish', 'auth.login', 'platform.user_create'].every((a) => kinds.has(a)),
    `${[...kinds].join(',')} | ${odd.slice(0, 4).join(' | ')}`,
  );
  // 时间线（02 第 8 步）：后台改、上架在同一事务里接着记的 catalog.version 都并进了那次写入，不单独成句
  const { auditRuns } = await import('../shared/audit-text.js');
  const loose = auditRuns(real)
    .flat()
    .filter((e) => e.action === 'catalog.version');
  check(
    '审计时间线：真实记录里每个 catalog.version 都并进了它那次写入（这一轮没有启动补写）',
    real.filter((e) => e.action === 'catalog.version').length >= 2 && loose.length === 0,
    loose
      .slice(0, 4)
      .map((e) => `${e.id} ${e.targetId} ${JSON.stringify(e.diff)}`)
      .join(' | '),
  );
}

// 后台 UX spec 验收 15 第 2 条：检查的违规带 match，前端拿它在正文里查找、生成说明。四类带：禁用短语是命中的文本
// （正则规则是匹配到的那一段，不是正则本身），必需说法是那句原文，工具与字段是名字；其余几类没有这个键
{
  const v0 = cfg.currentSop();
  const tone = bodyOf(v0.sections, 'tone');
  /** 存一份只改一节的草稿，检查一次、试着发布一次，再丢掉草稿 */
  const tryDraft = async (key: string, body: string): Promise<{ checked: Body[]; published: Res }> => {
    const d = await call('PUT', '/sop/draft', {
      ...O,
      json: { basedOn: cfg.currentSop().versionId, rev: null, edits: [{ key, body }] },
    });
    const ch = await call('POST', '/sop/draft/check', O);
    const published = await call('POST', '/sop/draft/publish', { ...O, json: { rev: d.body.rev, changeNote: '想发布' } });
    await call('POST', '/sop/draft/discard', { ...O, json: { rev: d.body.rev } });
    const ok = d.status === 200 && ch.status === 200 && Array.isArray(ch.body.violations);
    return { checked: ok ? (ch.body.violations as Body[]) : [], published };
  };
  const shown = (vs: readonly Body[]): string =>
    vs.map((v) => `${v.code}@${v.sectionKey ?? '-'}=${'match' in v ? v.match : '（无）'}`).join(' ');

  const bad = await tryDraft(
    'tone',
    [tone, '明显超出我们现有线路的范围，就转人工。', '嫌贵就缩短天数重新报价。', '先调 search_route，再看 destinationMissing。'].join(NL),
  );
  check(
    '违规的 match：话术原则里写进禁用短语 → phrase_forbidden 带命中的文本（纯文本规则是短语本身，正则规则是匹配到的那段）',
    shown(bad.checked.filter((v) => v.code === 'phrase_forbidden')) ===
      'phrase_forbidden@tone=明显超出我们现有线路的范围 phrase_forbidden@tone=缩短天数重新报价',
    shown(bad.checked),
  );
  check(
    '违规的 match：点名不存在的工具与字段 → 带标识符本身；发布 422 的 violations 与检查的相同',
    shown(bad.checked.filter((v) => v.code !== 'phrase_forbidden')) ===
      'unknown_tool@tone=search_route unknown_field@tone=destinationMissing' &&
      bad.published.status === 422 &&
      shown(bad.published.body.violations ?? []) === shown(bad.checked),
    `${shown(bad.checked)} | ${bad.published.text.slice(0, 200)}`,
  );
  const others = [
    ...(await tryDraft('wechat-style', `${bodyOf(v0.sections, 'wechat-style')}${NL}## 新节${NL}多出来的一节`)).checked,
    ...(await tryDraft('tone', `${tone}${NL}${'多'.repeat(5000)}`)).checked,
  ];
  check(
    '违规的 match：structure、over_budget 不带这个键',
    [...new Set(others.map((v) => v.code))].join() === 'structure,over_budget' && others.every((v) => !('match' in v)),
    shown(others),
  );

  // 必需说法今天都在固定规则节里，后台删不到。换一份镜像，把「定价只有两条规则」从定价规则节挪走：先发布一版话术原则里
  // 也写着这句的（这时两处都有），再用挪过的镜像重新装载配置源（启动重渲染），这句就只剩话术原则里的一处
  const REQUIRED = '定价只有两条规则';
  const d1 = await call('PUT', '/sop/draft', {
    ...O,
    json: { basedOn: v0.versionId, rev: null, edits: [{ key: 'tone', body: `${tone}${NL}报价前记住：${REQUIRED}。` }] },
  });
  const p1 = await call('POST', '/sop/draft/publish', { ...O, json: { rev: d1.body.rev, changeNote: '话术原则里也写上定价规则' } });
  cfg.__configTest.reset();
  await cfg.initConfig(testConfigDeps(t, { imageSop: testConfigDeps(t).imageSop.replace(REQUIRED, '定价规则') }));
  const once = cfg.currentSop().renderedPrompt.split(REQUIRED).length === 2;
  const missing = await tryDraft('tone', tone);
  check(
    '违规的 match：删掉一句必需说法 → phrase_missing 带那句原文；发布 422 的 violations 同样带',
    p1.status === 200 &&
      once &&
      shown(missing.checked) === `phrase_missing@-=${REQUIRED}` &&
      missing.published.status === 422 &&
      shown(missing.published.body.violations ?? []) === shown(missing.checked),
    `${p1.status} ${once} ${shown(missing.checked)} | ${missing.published.text.slice(0, 200)}`,
  );

  // 复原：换回原镜像重新装载，再回滚到这一块开始时的版本
  cfg.__configTest.reset();
  await cfg.initConfig(testConfigDeps(t));
  const back = await call('POST', `/sop/versions/${v0.versionId}/rollback`, { ...O, json: { changeNote: '复原话术原则' } });
  check(
    '违规的 match：复原后线上的话术原则与这一块开始前相同，没有草稿',
    back.status === 200 && bodyOf(cfg.currentSop().sections, 'tone') === tone && (await call('GET', '/sop', O)).body.draft === null,
    back.text.slice(0, 200),
  );
}

// 后台 UX spec 验收 15 第 3、4 条：草稿保存的 rebaseOnto（冲突合并）。完整路径：草稿改话术原则 → 别人回滚到话术原则不同的
// 旧版本 → 发布 409 sop_conflict；带 rebaseOnto 与合并后的话术原则保存 → 200（基线换成线上版本、rev 加 1，上游另改的节并进来，
// 草稿自己改的别的节留着），之后 check 不再要合并，发布成功，线上正文等于合并结果。合并的三种失败：rebaseOnto 不是线上版本 →
// 409 rev_conflict；edits 缺撞上的节 → 409 sop_conflict 点名缺的节；没有草稿时带 rebaseOnto → 422。失败的几次草稿都没动
{
  const v0 = cfg.currentSop();
  const [tone0, obj0, style0] = ['tone', 'objections', 'wechat-style'].map((k) => bodyOf(v0.sections, k));
  // v1：话术原则与微信语气都和 v0 不同；草稿在 v1 上改话术原则与异议处理
  const d0 = await call('PUT', '/sop/draft', {
    ...O,
    json: {
      basedOn: v0.versionId,
      rev: null,
      edits: [
        { key: 'tone', body: `${tone0}${NL}旧版本里多的一句。` },
        { key: 'wechat-style', body: `${style0}${NL}旧版本里的语气。` },
      ],
    },
  });
  const v1 = await call('POST', '/sop/draft/publish', { ...O, json: { rev: d0.body.rev, changeNote: '话术原则与语气各加一句' } });
  const d = await call('PUT', '/sop/draft', {
    ...O,
    json: {
      basedOn: v1.body.id,
      rev: null,
      edits: [
        { key: 'tone', body: `${bodyOf(v1.body.sections, 'tone')}${NL}草稿里加的一句。` },
        { key: 'objections', body: `${obj0}${NL}草稿里改的异议处理。` },
      ],
    },
  });
  // 别人回滚到 v0：上游改了话术原则（与草稿撞上）和微信语气（草稿没碰）
  const rb = await call('POST', `/sop/versions/${v0.versionId}/rollback`, { as: admin, json: { changeNote: '别人回滚了' } });
  const clash = keep(await call('POST', '/sop/draft/publish', { ...O, json: { rev: d.body.rev, changeNote: '想发布' } }));
  check(
    'rebaseOnto：草稿改了话术原则，别人回滚到话术原则不同的旧版本 → 发布 409 sop_conflict，点名话术原则',
    v1.status === 200 &&
      d.status === 200 &&
      rb.status === 200 &&
      clash.status === 409 &&
      clash.body.error === 'sop_conflict' &&
      JSON.stringify(clash.body.keys) === '["tone"]',
    clash.text.slice(0, 200),
  );
  const draftNow = async (): Promise<Body | null> => (await call('GET', '/sop', O)).body.draft as Body | null;
  const merged = `${tone0}${NL}草稿里加的一句。`;
  const put = (json: Body): Promise<Res> => call('PUT', '/sop/draft', { ...O, json });

  const notOnline = keep(
    await put({ basedOn: rb.body.id, rev: d.body.rev, edits: [{ key: 'tone', body: merged }], rebaseOnto: v1.body.id }),
  );
  const after1 = await draftNow();
  check(
    'rebaseOnto 失败：不是当前发布版本（归档了的 v1）→ 409 rev_conflict，草稿没动',
    notOnline.status === 409 && notOnline.body.error === 'rev_conflict' && after1?.rev === d.body.rev && after1?.basedOn === v1.body.id,
    notOnline.text.slice(0, 200),
  );
  const missing = keep(
    await put({
      basedOn: rb.body.id,
      rev: d.body.rev,
      edits: [{ key: 'objections', body: `${obj0}${NL}只改异议处理。` }],
      rebaseOnto: rb.body.id,
    }),
  );
  const after2 = await draftNow();
  check(
    'rebaseOnto 失败：edits 缺撞上的节 → 409 sop_conflict，keys 点名缺的话术原则，current 只带这一节的线上正文；草稿没动',
    missing.status === 409 &&
      missing.body.error === 'sop_conflict' &&
      JSON.stringify(missing.body.keys) === '["tone"]' &&
      JSON.stringify((missing.body.current as SopSectionText[]).map((x) => x.key)) === '["tone"]' &&
      bodyOf(missing.body.current as SopSectionText[], 'tone') === tone0 &&
      after2 !== null &&
      after2.rev === d.body.rev &&
      bodyOf(after2.sections, 'objections') === bodyOf(d.body.sections, 'objections'),
    missing.text.slice(0, 200),
  );

  const ok = await put({ basedOn: rb.body.id, rev: d.body.rev, edits: [{ key: 'tone', body: merged }], rebaseOnto: rb.body.id });
  const ch = await call('POST', '/sop/draft/check', O);
  const overview = await call('GET', '/sop', O);
  check(
    'rebaseOnto：带合并后的话术原则保存 → 200，基线换成线上版本、rev 加 1；上游改的微信语气并进来，草稿改的异议处理留着；' +
      '之后草稿不再过期，check 的 rebase.needed 为 false',
    ok.status === 200 &&
      ok.body.basedOn === rb.body.id &&
      ok.body.rev === d.body.rev + 1 &&
      bodyOf(ok.body.sections, 'tone') === canonicalBody(merged, false) &&
      bodyOf(ok.body.sections, 'wechat-style') === style0 &&
      bodyOf(ok.body.sections, 'objections') === bodyOf(d.body.sections, 'objections') &&
      overview.body.draft?.stale === false &&
      ch.status === 200 &&
      ch.body.rebase?.needed === false &&
      ch.body.rebase?.conflicts?.length === 0,
    `${ok.text.slice(0, 200)} | ${JSON.stringify(ch.body.rebase)}`,
  );
  const pub = await call('POST', '/sop/draft/publish', { ...O, json: { rev: ok.body.rev, changeNote: '合并以后发布' } });
  const live = cfg.currentSop().sections;
  check(
    'rebaseOnto：合并以后发布成功，线上的话术原则等于合并结果，异议处理是草稿的，微信语气是回滚后的',
    pub.status === 200 &&
      pub.body.basedOn === rb.body.id &&
      bodyOf(live, 'tone') === bodyOf(ok.body.sections, 'tone') &&
      bodyOf(live, 'objections') === bodyOf(d.body.sections, 'objections') &&
      bodyOf(live, 'wechat-style') === style0,
    pub.text.slice(0, 200),
  );
  const noDraft = keep(await put({ basedOn: pub.body.id, rev: null, edits: [{ key: 'tone', body: merged }], rebaseOnto: pub.body.id }));
  check(
    'rebaseOnto 失败：没有草稿时带 rebaseOnto → 422 invalid_sop，也没有新建草稿',
    noDraft.status === 422 && noDraft.body.error === 'invalid_sop' && (await draftNow()) === null,
    noDraft.text.slice(0, 200),
  );

  // 复原：回滚到这一块开始时的版本
  const back = await call('POST', `/sop/versions/${v0.versionId}/rollback`, { ...O, json: { changeNote: '复原' } });
  check(
    'rebaseOnto：复原后线上的话术原则与这一块开始前相同',
    back.status === 200 && bodyOf(cfg.currentSop().sections, 'tone') === tone0,
    back.text.slice(0, 200),
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
  check(
    "安全头：页面的 CSP 就是接口那条（含 font-src 'self'）加上这个 nonce 的 style-src，字体只能从本站加载",
    index.headers.get('content-security-policy') === `${CSP}; style-src 'self' 'nonce-${nonce}'`,
    index.headers.get('content-security-policy') ?? '',
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
    '托管：/console/assets/<hash>.js 返回 JS，带安全头与 immutable 长缓存',
    js.status === 200 &&
      js.text === 'console.log("console");' &&
      (js.headers.get('content-type') ?? '').startsWith('text/javascript') &&
      securedAsset(js.headers),
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
  // 不变量 26 与压缩（后台 UX spec「性能」、验收 23）：超过 1 KB 的 JS、CSS，一个 woff2，一个不在 assets/ 下、
  // 超过 1 KB 的 JS（压缩只挂在 assets/ 上）；不到 1 KB 的 JS 用上面那个 app-1a2b.js
  const assetFiles = {
    'assets/index-D71W9cL0.js': Buffer.from(`console.log(${JSON.stringify('后台'.repeat(600))});`),
    'assets/index-B2c3D4e5.css': Buffer.from('.brand{color:#111}\n'.repeat(120)),
    'assets/geist-ui-Ab12Cd34.woff2': Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256)),
  };
  for (const [rel, bytes] of Object.entries(assetFiles)) fs.writeFileSync(path.join(dist, rel), bytes);
  fs.writeFileSync(path.join(dist, 'theme-boot.js'), '/* 首帧主题 */\n'.repeat(120));
  const raw = async (url: string, acceptEncoding?: string) => {
    const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.97' };
    if (acceptEncoding) headers['accept-encoding'] = acceptEncoding;
    const res = await app.request(url, { headers });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const GZ = 'gzip, deflate, br';
  const gz = [
    { r: await raw('/console/assets/index-D71W9cL0.js', GZ), orig: assetFiles['assets/index-D71W9cL0.js'], type: 'text/javascript' },
    { r: await raw('/console/assets/index-B2c3D4e5.css', GZ), orig: assetFiles['assets/index-B2c3D4e5.css'], type: 'text/css' },
    { r: await raw('/console/assets/app-1a2b.js', GZ), orig: Buffer.from('console.log("console");'), type: 'text/javascript' },
  ];
  check(
    '压缩：Accept-Encoding 带 gzip 时，assets 的 JS、CSS（不到 1 KB 的也算）返回 gzip，解压后与原文件相同，带 Vary: Accept-Encoding，缓存头不变',
    gz.every(
      ({ r, orig, type }) =>
        r.status === 200 &&
        r.headers.get('content-encoding') === 'gzip' &&
        gunzipSync(r.bytes).equals(orig) &&
        /(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(r.headers.get('vary') ?? '') &&
        (r.headers.get('content-type') ?? '').startsWith(type) &&
        securedAsset(r.headers),
    ),
    gz.map(({ r }) => `${r.status} ${r.headers.get('content-encoding')} ${r.headers.get('cache-control')}`).join(' | '),
  );
  const plain = [await raw('/console/assets/index-D71W9cL0.js'), await raw('/console/assets/index-D71W9cL0.js', 'br')];
  check(
    '压缩：不收 gzip（没有 Accept-Encoding，或只收 br）时原样返回',
    plain.every((r) => r.status === 200 && !r.headers.has('content-encoding') && r.bytes.equals(assetFiles['assets/index-D71W9cL0.js'])),
    plain.map((r) => r.headers.get('content-encoding')).join(','),
  );
  const font = await raw('/console/assets/geist-ui-Ab12Cd34.woff2', GZ);
  check(
    '压缩：woff2 已经压缩过，不再压；font/woff2，带 immutable 长缓存',
    font.status === 200 &&
      !font.headers.has('content-encoding') &&
      font.bytes.equals(assetFiles['assets/geist-ui-Ab12Cd34.woff2']) &&
      font.headers.get('content-type') === 'font/woff2' &&
      securedAsset(font.headers),
    `${font.headers.get('content-encoding')} ${font.headers.get('content-type')} ${font.headers.get('cache-control')}`,
  );
  const pages = [await raw('/console/', GZ), await raw('/console/index.html', GZ), await raw('/console/sop/versions/3', GZ)];
  check(
    '不变量 26：index.html（/console/、/console/index.html、深链）在 Accept-Encoding 带 gzip 时也不压缩、不带 immutable，仍是 no-store',
    pages.every(
      (r) =>
        r.status === 200 &&
        !r.headers.has('content-encoding') &&
        r.headers.get('cache-control') === 'no-store' &&
        r.bytes.toString('utf8').includes('<div id="root">'),
    ),
    pages.map((r) => `${r.status} ${r.headers.get('content-encoding')} ${r.headers.get('cache-control')}`).join(' | '),
  );
  const boot = await raw('/console/theme-boot.js', GZ);
  check(
    '不变量 26：/console 下 assets/ 以外的文件（theme-boot.js）不带 immutable，仍是 no-store；压缩只挂在 assets/ 上，它也不压',
    boot.status === 200 &&
      (boot.headers.get('content-type') ?? '').startsWith('text/javascript') &&
      secured(boot.headers) &&
      !boot.headers.has('content-encoding'),
    `${boot.status} ${boot.headers.get('cache-control')} ${boot.headers.get('content-encoding')}`,
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

// ---------------- 02 第 13 步：接手状态机与后台接口（02 spec「后台接口」「接手、人工回复与交还」「通知」） ----------------
// 这一段跑在文件存储上（selftest-env 钉住）；db 存储才有的（更早的消息、trace、写库积压）在末尾的子进程里
await workbenchSuite();

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
  // 请求都带着 Accept-Encoding: gzip（见 call()）；其中有超过 4 KB 的响应，没压缩不是因为太小
  const encoded = seen.filter((r) => r.headers.has('content-encoding') || (r.headers.get('cache-control') ?? '').includes('immutable'));
  check(
    '不变量 26：这些 /api/console 响应（请求带 Accept-Encoding: gzip）都没有 Content-Encoding，也不带 immutable',
    encoded.length === 0 && seen.some((r) => r.text.length >= 4096),
    encoded.map((r) => `${r.status} ${r.headers.get('content-encoding')} ${r.headers.get('cache-control')}`).join(','),
  );
}

/**
 * 02 第 13 步的后台接口（文件存储）：权限矩阵逐格（含 403 与 409 的分界）、路由枚举、接手状态机经 HTTP 的各条路、
 * 事件流、计数与排序、viewer 打码、匿名旧接口、订单与快捷回复、/status。db 存储才有的部分在 runDbStoreChild()
 */
async function workbenchSuite(): Promise<void> {
  const store = await import('../store.js');
  const tk = await import('../handoff/takeover.js');
  const { enterHandoff } = await import('../handoff/record.js');
  const { subscribe } = await import('../adapters/simulator.js');
  const { consoleApi } = await import('./app.js');
  const { __eventsTest, eventTiming } = await import('./events.js');
  const { maskNumbers } = await import('./mask.js');
  const { conversationState, shortIdOf } = await import('../shared/conversation.js');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pack = cfg.currentTenant().pack;

  // ---- 成员：主管、两个坐席；所有者、管理员、只读用前面登录好的 ----
  const SUP = { email: 'sup13@example.com', password: 'sup13-password-1', name: '主管丁' };
  const VW = { email: 'vw13@example.com', password: 'vw13-password-1', name: '只读戊' };
  const AG1 = { email: 'ag13a@example.com', password: 'ag13a-password-1', name: '小林' };
  const AG2 = { email: 'ag13b@example.com', password: 'ag13b-password-1', name: '小王' };
  for (const [u, role] of [
    [SUP, 'supervisor'],
    [AG1, 'agent'],
    [AG2, 'agent'],
    [VW, 'viewer'],
  ] as const) {
    const r = await asPlatform(() =>
      accounts.createUser(t.db, { tenantSlug: 'demo', email: u.email, name: u.name, role, password: pw(u.password) }),
    );
    check(`第 13 步准备：建一个 ${role}（${u.name}）`, r.code === 0, r.message);
  }
  const sup = await httpLogin(SUP.email, SUP.password, '203.0.113.131');
  const ag1 = await httpLogin(AG1.email, AG1.password, '203.0.113.132');
  const ag2 = await httpLogin(AG2.email, AG2.password, '203.0.113.133');
  // 前面的用例停用过 READER，只读成员另建一个
  const vw = await httpLogin(VW.email, VW.password, '203.0.113.134');
  const ids = { ag1: String(ag1.body.userId), ag2: String(ag2.body.userId), sup: String(sup.body.userId) };
  const ROLES = { owner, admin, supervisor: sup, agent: ag1, viewer: vw } as const;
  type RoleName = keyof typeof ROLES;
  const enc = encodeURIComponent;

  /** 一个可列的会话（id 不是 sim-）：渠道默认是网页模拟器，推送经 subscribe 收得到；企微渠道的只用来测发送窗口 */
  const mk = (id: string, o: { channel?: string; customer?: string; stage?: Session['stage'] } = {}) => {
    const s = store.getOrCreateSession(id, o.channel ?? 'simulator');
    s.messages.push({ role: 'customer', content: o.customer ?? '你好，想去云南', at: Date.now() });
    if (o.stage) s.stage = o.stage;
    store.saveSession(s);
    return s;
  };
  const toHuman = (id: string, kind: 'request' | 'refund' = 'request') => {
    const s = store.getSession(id)!;
    enterHandoff(s, {
      kind,
      at: Date.now(),
      reason: kind === 'request' ? '客户要找顾问' : '客户要退款或改订单',
      quote: s.messages.at(-1)?.content,
    });
    store.saveSession(s);
    return s;
  };
  const pushes = new Map<string, string[]>();
  const capture = (id: string) => {
    const list: string[] = [];
    pushes.set(id, list);
    subscribe(id, (text) => list.push(text));
    return list;
  };

  // ---- 路由枚举：consoleApi 注册的每个路由都在 01 的清单或本步的矩阵里，矩阵里的每一行都注册了 ----
  const ROUTES_01 = [
    'POST /auth/login',
    'POST /auth/logout',
    'GET /me',
    'GET /pack',
    'GET /status',
    'GET /sop',
    'GET /sop/versions',
    'GET /sop/versions/:id',
    'PUT /sop/draft',
    'POST /sop/draft/check',
    'POST /sop/draft/publish',
    'POST /sop/draft/discard',
    'POST /sop/versions/:id/rollback',
    'GET /catalog/:kind',
    'GET /catalog/:kind/:code',
    'POST /catalog/:kind',
    'PATCH /catalog/:kind/:code',
    'POST /catalog/:kind/import-csv',
    'POST /catalog/:kind/:code/activate',
    'GET /conversations',
    'GET /conversations/counts',
    'GET /audit',
  ];
  /** 02 新接口的权限表（spec「后台接口」权限）：哪些角色过得了权限这一层；匿名一律 401 */
  const ALL: RoleName[] = ['owner', 'admin', 'supervisor', 'agent', 'viewer'];
  const HANDLE: RoleName[] = ['owner', 'admin', 'supervisor', 'agent'];
  const MONEY: RoleName[] = ['owner', 'admin'];
  const REPLIES: RoleName[] = ['owner', 'admin', 'supervisor'];
  const S0 = 'wecom:wb13-matrix';
  mk(S0);
  const MATRIX: { route: string; url: string; json?: unknown; allowed: RoleName[]; sse?: true }[] = [
    { route: 'GET /conversations/:id', url: `/conversations/${enc(S0)}`, allowed: ALL },
    { route: 'GET /conversations/:id/messages', url: `/conversations/${enc(S0)}/messages?beforeSeq=10`, allowed: ALL },
    { route: 'GET /conversations/:id/turns', url: `/conversations/${enc(S0)}/turns`, allowed: ALL },
    {
      route: 'GET /conversations/:id/turns/:turnId/diff',
      url: `/conversations/${enc(S0)}/turns/0b7c5e1a-1d2e-4f30-8a41-000000000001/diff`,
      allowed: ALL,
    },
    {
      route: 'GET /conversations/:id/turns/:turnId',
      url: `/conversations/${enc(S0)}/turns/0b7c5e1a-1d2e-4f30-8a41-000000000001`,
      allowed: MONEY,
    },
    // 写接口拿不存在的会话、订单与不合规的请求体测：过了权限这一层的回 404 / 400，不动任何东西
    { route: 'POST /conversations/:id/takeover', url: '/conversations/wecom%3AwmNOSUCH13/takeover', json: {}, allowed: HANDLE },
    { route: 'POST /conversations/:id/release', url: '/conversations/wecom%3AwmNOSUCH13/release', allowed: HANDLE },
    {
      route: 'POST /conversations/:id/reply',
      url: '/conversations/wecom%3AwmNOSUCH13/reply',
      json: { text: '矩阵', clientId: '0b7c5e1a-1d2e-4f30-8a41-000000000002' },
      allowed: HANDLE,
    },
    { route: 'GET /orders', url: '/orders', allowed: MONEY },
    { route: 'GET /orders', url: '/orders?status=paid', allowed: MONEY },
    { route: 'GET /orders', url: '/orders?status=pending_payment', allowed: ALL },
    { route: 'GET /orders/summary', url: '/orders/summary', allowed: MONEY },
    { route: 'POST /orders/:id/confirm', url: '/orders/ord_nosuch13/confirm', allowed: HANDLE },
    { route: 'POST /orders/:id/mark-paid', url: '/orders/ord_nosuch13/mark-paid', allowed: HANDLE },
    { route: 'POST /orders/:id/cancel', url: '/orders/ord_nosuch13/cancel', json: { reason: '矩阵' }, allowed: HANDLE },
    { route: 'GET /quick-replies', url: '/quick-replies', allowed: ALL },
    { route: 'POST /quick-replies', url: '/quick-replies', json: {}, allowed: REPLIES },
    { route: 'PATCH /quick-replies/:id', url: '/quick-replies/nosuch', json: { title: '矩阵' }, allowed: REPLIES },
    { route: 'POST /quick-replies/:id/archive', url: '/quick-replies/nosuch/archive', allowed: REPLIES },
    { route: 'POST /quick-replies/:id/move', url: '/quick-replies/nosuch/move', json: { direction: 'up' }, allowed: REPLIES },
    { route: 'GET /metrics', url: '/metrics', allowed: MONEY },
    { route: 'GET /events', url: '/events', allowed: ALL, sse: true },
  ];
  const registered = new Set(
    consoleApi.routes
      .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
      .map((r) => `${r.method} ${r.path.replace(/^\/api\/console/, '')}`),
  );
  const known = new Set([...ROUTES_01, ...MATRIX.map((m) => m.route)]);
  check(
    '路由枚举：consoleApi 注册的每个路由都在 01 的清单或第 13 步的权限矩阵里（漏挂权限的新路由在这里现形）',
    [...registered].every((r) => known.has(r)),
    [...registered].filter((r) => !known.has(r)).join(','),
  );
  check(
    '路由枚举：矩阵与 01 清单里的每个路由都注册了',
    [...known].every((r) => registered.has(r)),
    [...known].filter((r) => !registered.has(r)).join(','),
  );
  /** 一个会话、一种角色的请求：SSE 只看状态码，连上就断开 */
  const hit = async (m: (typeof MATRIX)[number], who: Who | null): Promise<Res> => {
    if (!m.sse)
      return call(m.route.split(' ')[0]!, m.url, {
        ...(who ? { as: who } : {}),
        ...(m.json !== undefined ? { json: m.json } : {}),
        ip: '203.0.113.140',
      });
    const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.141' };
    if (who) headers.cookie = `${session.SESSION_COOKIE}=${who.token}`;
    const res = await app.request(`/api/console${m.url}`, { headers });
    await res.body?.cancel();
    return { status: res.status, body: {}, text: '', headers: res.headers };
  };
  const cells: string[] = [];
  for (const m of MATRIX) {
    for (const role of ALL) {
      const r = await hit(m, ROLES[role]);
      const want = m.allowed.includes(role);
      // 过了权限：不是 401、403（落到 404、400、409、503 store_file_mode 都算过了这一层）；没过：403 forbidden
      const ok = want
        ? r.status !== 401 && r.status !== 403 && (r.status < 500 || r.body.error === 'store_file_mode')
        : r.status === 403 && r.body.error === 'forbidden';
      if (!ok) cells.push(`${m.url} ${role} → ${r.status} ${r.text.slice(0, 80)}`);
    }
    const anon = await hit(m, null);
    if (anon.status !== 401) cells.push(`${m.url} 匿名（demo）→ ${anon.status}`);
  }
  check(
    '权限矩阵：第 13 步的每个新接口逐个角色过一遍（过了权限的不是 401/403，没过的是 403 forbidden，匿名 401）',
    cells.length === 0,
    cells.join(' | '),
  );
  __profileTest.use({ DEPLOY_PROFILE: 'prod' });
  try {
    const prodAnon: string[] = [];
    for (const m of MATRIX) {
      const r = await hit(m, null);
      if (r.status !== 401) prodAnon.push(`${m.url} → ${r.status}`);
    }
    check('权限矩阵：prod 匿名一律 401（含 /events）', prodAnon.length === 0, prodAnon.join(','));
  } finally {
    __profileTest.reset();
  }

  // ---- 枚举 server 与 consoleApi 的全部路由：prod 下白名单以外的匿名请求一律 401 或 404（验收 9、不变量 43） ----
  {
    const savedPass = process.env.ADMIN_PASS;
    process.env.ADMIN_PASS = 'route-enum-pass'; // prod 没配 ADMIN_PASS 起不来；配了，管理接口匿名才是 401 而不是 503
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    try {
      // 公开路由（R22 与 00 的白名单）：凭 id 取到的那一条、方案书、支付页、企微回调、健康检查、首页跳转、后台页面与登录
      const PUBLIC = [
        /^GET \/$/,
        /^GET \/healthz$/,
        /^GET \/api\/orders\/:id$/,
        /^GET \/pay\/:orderId$/,
        /^GET \/api\/proposal\/:routeId$/,
        /^GET \/proposal\//,
        /^(GET|POST) \/wecom\/callback$/,
        /^GET \/kf-qr\.png$/,
        /^GET \/console/,
        /^POST \/api\/console\/auth\/login$/,
      ];
      const fill = (p: string): string =>
        p
          .replace(/:rest\{[^}]*\}/, '2')
          .replace(/:kind/, 'route')
          .replace(/:turnId/, '0b7c5e1a-1d2e-4f30-8a41-000000000001')
          .replace(/:id|:sessionId/g, 'wecom%3AwmENUM13')
          .replace(/:[A-Za-z]+/g, 'x13');
      const seenRoutes = new Set<string>();
      const leaks: string[] = [];
      for (const r of app.routes) {
        if (r.method === 'ALL' || r.path.includes('*')) continue;
        const key = `${r.method} ${r.path}`;
        if (seenRoutes.has(key) || PUBLIC.some((re) => re.test(key))) continue;
        seenRoutes.add(key);
        const body = r.method === 'GET' || r.method === 'HEAD' ? undefined : '{}';
        const res = await app.request(fill(r.path), {
          method: r.method,
          headers: { 'x-forwarded-for': '198.51.100.213', ...(body ? { 'content-type': 'application/json', 'content-length': '2' } : {}) },
          body,
        });
        await res.body?.cancel();
        if (res.status !== 401 && res.status !== 404) leaks.push(`${key} → ${res.status}`);
      }
      check(
        '路由枚举：server 与 consoleApi 注册的、白名单以外的路由，prod 下匿名一律 401 或 404',
        leaks.length === 0 && seenRoutes.size >= 50,
        `${seenRoutes.size} 个；${leaks.join(' | ')}`,
      );
    } finally {
      __profileTest.reset();
      if (savedPass === undefined) delete process.env.ADMIN_PASS;
      else process.env.ADMIN_PASS = savedPass;
    }
  }

  // ---- 接手：成为接手人、别人接手中 409、坐席带 force 403、主管改派、代次 ----
  {
    const S1 = 'wecom:wb13-take';
    mk(S1);
    const gen0 = tk.takeoverGen(S1);
    const t1 = keep(await call('POST', `/conversations/${enc(S1)}/takeover`, { as: ag1, json: {} }));
    const s1 = store.getSession(S1)!;
    check(
      '接手：没人接手的 AI 会话 → 200，以 agent 进入转人工、接手人是他（真实成员 id）、状态 assigned、代次加 1',
      t1.status === 200 &&
        s1.handedOver &&
        s1.handoff?.kind === 'agent' &&
        s1.handoff.reason === tk.MEMBER_TAKEOVER_REASON &&
        s1.assignee?.userId === ids.ag1 &&
        s1.assignee.name === AG1.name &&
        conversationState(s1, pack) === 'assigned' &&
        tk.takeoverGen(S1) === gen0 + 1,
      `${t1.text} ${JSON.stringify(s1.assignee)}`,
    );
    const again = await call('POST', `/conversations/${enc(S1)}/takeover`, { as: ag1, json: {} });
    check('接手：已经是自己 → 200，什么都不改（代次不加）', again.status === 200 && tk.takeoverGen(S1) === gen0 + 1);
    const before = JSON.stringify(store.getSession(S1));
    const other = keep(await call('POST', `/conversations/${enc(S1)}/takeover`, { as: ag2, json: {} }));
    check(
      '接手：别人接手中，坐席不带 force → 409 assigned_to_other，带上接手人的名字，会话不变',
      other.status === 409 &&
        other.body.error === 'assigned_to_other' &&
        other.body.assigneeName === AG1.name &&
        JSON.stringify(store.getSession(S1)) === before,
      other.text,
    );
    const forced = keep(await call('POST', `/conversations/${enc(S1)}/takeover`, { as: ag2, json: { force: true } }));
    check(
      '接手：坐席带 force 改派 → 403 forbidden（角色不够），会话不变',
      forced.status === 403 && forced.body.error === 'forbidden' && JSON.stringify(store.getSession(S1)) === before,
      forced.text,
    );
    const viewerTake = await call('POST', `/conversations/${enc(S1)}/takeover`, { as: vw, json: {} });
    check('接手：只读成员 → 403（权限在中间件就拦下）', viewerTake.status === 403 && viewerTake.body.error === 'forbidden');
    const supNoForce = await call('POST', `/conversations/${enc(S1)}/takeover`, { as: sup, json: {} });
    check('接手：主管不带 force 也是 409（改派要明说）', supNoForce.status === 409 && supNoForce.body.error === 'assigned_to_other');
    const reassign = await call('POST', `/conversations/${enc(S1)}/takeover`, { as: sup, json: { force: true } });
    check(
      '改派：主管带 force → 200，接手人换成主管，代次再加 1',
      reassign.status === 200 && store.getSession(S1)!.assignee?.userId === ids.sup && tk.takeoverGen(S1) === gen0 + 2,
      reassign.text,
    );
    // 交还：别人的 → 坐席 409 not_assignee；只读 403；主管交还别人的照样可以
    const notMine = keep(await call('POST', `/conversations/${enc(S1)}/release`, { as: ag1 }));
    check('交还：坐席交还别人接手的 → 409 not_assignee', notMine.status === 409 && notMine.body.error === 'not_assignee', notMine.text);
    check('交还：只读 → 403', (await call('POST', `/conversations/${enc(S1)}/release`, { as: vw })).status === 403);
    // 会话类审计：target 在文件存储下没有 ref（为空），diff 带短码；操作者是真实成员
    await sleep(100);
    const au = await call('GET', '/audit?actions=conversation.takeover,conversation.reassign,conversation.release', O);
    const mine = ((au.body.items ?? []) as Body[]).filter((x) => (x.diff as Body | null)?.shortId === shortIdOf(S1));
    check(
      '审计：接手与改派各一行（会话与订单一类），diff 带短码、改派记原来的接手人，target 不含会话 id',
      mine.length === 2 &&
        mine.some((x) => x.action === 'conversation.takeover' && x.actorName === AG1.name) &&
        mine.some((x) => x.action === 'conversation.reassign' && x.actorName === SUP.name && (x.diff as Body).from === AG1.name) &&
        mine.every((x) => x.targetType === 'conversation' && x.targetId === null),
      JSON.stringify(mine),
    );
  }

  // ---- 并发接手恰一个成功（不变量 22） ----
  {
    const S2 = 'wecom:wb13-race';
    mk(S2);
    toHuman(S2);
    const [a, b] = await Promise.all([
      call('POST', `/conversations/${enc(S2)}/takeover`, { as: ag1, json: {} }),
      call('POST', `/conversations/${enc(S2)}/takeover`, { as: ag2, json: {} }),
    ]);
    const st = [a.status, b.status].toSorted();
    const winner = a.status === 200 ? AG1.name : AG2.name;
    check(
      '并发接手：两个坐席同时接手，恰一个 200、另一个 409 assigned_to_other，接手人是成功的那个',
      st.join() === '200,409' && store.getSession(S2)!.assignee?.name === winner && [a, b].some((r) => r.body.assigneeName === winner),
      `${a.status} ${b.status} ${JSON.stringify(store.getSession(S2)!.assignee)}`,
    );
    // 别人接手中回复：409、客户没收到、会话没变（不变量 23）
    const loser = winner === AG1.name ? ag2 : ag1;
    const got = capture(S2);
    const snap = JSON.stringify(store.getSession(S2));
    const r = keep(
      await call('POST', `/conversations/${enc(S2)}/reply`, {
        as: loser,
        json: { text: '我来回一句', clientId: '0b7c5e1a-1d2e-4f30-8a41-000000000003' },
      }),
    );
    check(
      '人工回复：别人接手中 → 409 assigned_to_other，客户没收到，会话不变',
      r.status === 409 && r.body.error === 'assigned_to_other' && got.length === 0 && JSON.stringify(store.getSession(S2)) === snap,
      r.text,
    );
  }

  // ---- 人工回复即接手、clientId 去重、交还恢复阶段（不变量 17、20、23、25） ----
  {
    const S3 = 'wecom:wb13-reply';
    const s3 = mk(S3, { stage: 'quote' });
    toHuman(S3);
    const got = capture(S3);
    const clientId = '0b7c5e1a-1d2e-4f30-8a41-000000000004';
    const r1 = keep(await call('POST', `/conversations/${enc(S3)}/reply`, { as: ag2, json: { text: '您好，我是顾问小王', clientId } }));
    const human = s3.messages.filter((m) => m.role === 'agent' && m.author === 'human');
    check(
      '人工回复：没人接手时回复 → 200，回复者成为接手人，消息带 author=human、操作者 id 与姓名，客户侧收到「【顾问】…」',
      r1.status === 200 &&
        r1.body.sent === true &&
        r1.body.persisted === true &&
        typeof r1.body.seq === 'number' &&
        store.seqOf(human[0]!) === r1.body.seq &&
        s3.assignee?.userId === ids.ag2 &&
        human.length === 1 &&
        human[0]!.authorId === ids.ag2 &&
        human[0]!.authorName === AG2.name &&
        got.join() === '【顾问】您好，我是顾问小王',
      `${r1.text} ${JSON.stringify(human)} ${JSON.stringify(got)}`,
    );
    const r2 = await call('POST', `/conversations/${enc(S3)}/reply`, { as: ag2, json: { text: '您好，我是顾问小王', clientId } });
    check(
      '人工回复：同一个 clientId 再提交 → 返回第一次的结果，不重发、不多记一条',
      r2.status === 200 && r2.text === r1.text && got.length === 1 && s3.messages.filter((m) => m.author === 'human').length === 1,
      `${r2.text} ${got.length}`,
    );
    const r3 = await call('POST', `/conversations/${enc(S3)}/reply`, {
      as: ag2,
      json: { text: '第二句', clientId: '0b7c5e1a-1d2e-4f30-8a41-000000000005' },
    });
    check('人工回复：换一个 clientId 照常发', r3.status === 200 && got.length === 2 && got[1] === '【顾问】第二句');
    check(
      '人工回复：正文为空、超过 2000 字、clientId 不是 uuid → 400',
      (await call('POST', `/conversations/${enc(S3)}/reply`, { as: ag2, json: { text: '', clientId } })).status === 400 &&
        (await call('POST', `/conversations/${enc(S3)}/reply`, { as: ag2, json: { text: 'x'.repeat(2001), clientId } })).status === 400 &&
        (await call('POST', `/conversations/${enc(S3)}/reply`, { as: ag2, json: { text: 'x', clientId: 'abc' } })).status === 400,
    );
    const rel = keep(await call('POST', `/conversations/${enc(S3)}/release`, { as: ag2 }));
    check(
      '交还：接手人本人 → 200，清 handedOver、handoff、assignee，阶段恢复成转人工前的 quote，记「小王把会话交还 AI」，firstHandoffAt 与 handoffCount 不清',
      rel.status === 200 &&
        !s3.handedOver &&
        s3.handoff === undefined &&
        s3.assignee === undefined &&
        s3.stage === 'quote' &&
        s3.messages.at(-1)?.role === 'system' &&
        s3.messages.at(-1)?.content === `${AG2.name}把会话交还 AI` &&
        s3.handoffCount === 1 &&
        typeof s3.firstHandoffAt === 'number',
      `${rel.text} ${s3.stage} ${s3.messages.at(-1)?.content}`,
    );
    check(
      '交还：没在转人工中再交还 → 200，什么都不改',
      (await call('POST', `/conversations/${enc(S3)}/release`, { as: ag2 })).status === 200 &&
        s3.messages.at(-1)?.content === `${AG2.name}把会话交还 AI`,
    );
  }

  // ---- 没人接手的会话，任何能处理的成员都能交还；不同意处理敏感信息的不能交还（不变量 41） ----
  {
    const S4 = 'wecom:wb13-consent';
    mk(S4);
    const s4 = toHuman(S4);
    s4.consent = { health: 'declined' };
    store.saveSession(s4);
    const d = (await call('GET', `/conversations/${enc(S4)}`, { as: ag1 })).body as ConversationDetail;
    check(
      '详情：客户不同意 → consentDeclined 为 true，can.release 为 false',
      d.consentDeclined === true && d.can.release === false,
      JSON.stringify(d.can),
    );
    const r = keep(await call('POST', `/conversations/${enc(S4)}/release`, { as: ag1 }));
    check(
      '交还：客户不同意处理敏感信息 → 409 consent_declined，会话不变',
      r.status === 409 && r.body.error === 'consent_declined' && s4.handedOver,
      r.text,
    );
    s4.consent = { health: 'granted' };
    store.saveSession(s4);
    const ok = await call('POST', `/conversations/${enc(S4)}/release`, { as: ag1 });
    check('交还：没人接手时坐席也能交还', ok.status === 200 && !s4.handedOver, ok.text);
  }

  // ---- 已成交客户要人工（开放问题 12 选 A 的接口部分） ----
  {
    const S5 = 'wecom:wb13-paid';
    mk(S5, { stage: 'paid' });
    toHuman(S5, 'refund');
    const grp = await call('GET', '/conversations?group=paid_needs_human', { as: ag1 });
    const counts = (await call('GET', '/conversations/counts', O)).body as ConversationCounts;
    check(
      '已成交客户要人工：状态仍是 paid（计数不进 human），?group=paid_needs_human 列出它，行里带转人工原因与时间',
      grp.status === 200 &&
        (grp.body.items as ConversationRow[]).some((x) => x.id === S5 && x.handoff?.kind === 'refund' && x.stage === 'paid') &&
        conversationState(store.getSession(S5)!, pack) === 'paid' &&
        counts.byState.paid >= 1,
      grp.text.slice(0, 300),
    );
    await call('POST', `/conversations/${enc(S5)}/takeover`, { as: ag1, json: {} });
    const after = await call('GET', '/conversations?group=paid_needs_human', { as: ag1 });
    check(
      '已成交客户要人工：有人接手之后从这一组消失，状态仍是 paid',
      !(after.body.items as ConversationRow[]).some((x) => x.id === S5) && conversationState(store.getSession(S5)!, pack) === 'paid',
    );
    check('ConvQuery：group 只认 paid_needs_human', (await call('GET', '/conversations?group=nope', { as: ag1 })).status === 400);
  }

  // ---- 企微发送窗口：剩 0 条或窗口已过 → 409，什么都不改 ----
  {
    const S6 = 'wecom:wb13-window';
    const s6 = store.getOrCreateSession(S6, 'wecom');
    s6.messages.push({ role: 'customer', content: '在吗', at: Date.now() - 50 * 3_600_000, sentAt: Date.now() - 50 * 3_600_000 });
    store.saveSession(s6);
    const snap = JSON.stringify(s6);
    const r = keep(
      await call('POST', `/conversations/${enc(S6)}/reply`, {
        as: ag1,
        json: { text: '还在吗', clientId: '0b7c5e1a-1d2e-4f30-8a41-000000000006' },
      }),
    );
    check(
      '人工回复：企微窗口已过 → 409 send_window_closed，带 closesAt 与 remaining，会话不变（没接手）',
      r.status === 409 &&
        r.body.error === 'send_window_closed' &&
        typeof r.body.closesAt === 'number' &&
        r.body.remaining === 0 &&
        JSON.stringify(s6) === snap,
      r.text,
    );
    const d = (await call('GET', `/conversations/${enc(S6)}`, { as: ag1 })).body as ConversationDetail;
    check(
      '详情：企微渠道带发送窗口（剩 0 条）',
      d.sendWindow?.remaining === 0 && d.sendWindow.closesAt !== null,
      JSON.stringify(d.sendWindow),
    );
  }

  // ---- 404：不存在的、sim- 访客会话 console 不开 ----
  {
    const sim = 'sim-wb13visitor00000000000001';
    store.getOrCreateSession(sim, 'simulator');
    const r1 = keep(await call('GET', `/conversations/${enc(sim)}`, { as: ag1 }));
    const r2 = await call('POST', `/conversations/${enc(sim)}/takeover`, { as: ag1, json: {} });
    const r3 = await call('GET', '/conversations/wecom%3AwmNOSUCH13', { as: ag1 });
    check(
      '404 conversation_not_found：sim- 访客会话（详情与接手都是）、不存在的会话',
      [r1, r2, r3].every((r) => r.status === 404 && r.body.error === 'conversation_not_found') && !store.getSession(sim)!.handedOver,
      [r1, r2, r3].map((r) => r.text).join(' | '),
    );
  }

  // ---- 文件存储：只在 db 存储有的接口 503 store_file_mode（权限先于它），种子会话也一样 ----
  {
    const S = 'wecom:wb13-take';
    const rs = [
      await call('GET', `/conversations/${enc(S)}/messages?beforeSeq=5`, { as: vw }),
      await call('GET', `/conversations/${enc(S)}/turns`, { as: vw }),
      await call('GET', `/conversations/${enc(S)}/turns/0b7c5e1a-1d2e-4f30-8a41-000000000001/diff`, { as: vw }),
      await call('GET', `/conversations/${enc(S)}/turns/0b7c5e1a-1d2e-4f30-8a41-000000000001`, O),
    ];
    keep(rs[0]!);
    check(
      '文件存储：更早的消息、步骤摘要、改写对照、trace 原文 → 503 store_file_mode',
      rs.every((r) => r.status === 503 && r.body.error === 'store_file_mode'),
      rs.map((r) => r.text).join(' | '),
    );
    const viewerTrace = await call('GET', `/conversations/${enc(S)}/turns/0b7c5e1a-1d2e-4f30-8a41-000000000001`, { as: vw });
    check('文件存储：trace 原文对只读成员仍是 403（权限先于存储模式）', viewerTrace.status === 403);
    const d = (await call('GET', `/conversations/${enc(S)}`, O)).body as ConversationDetail;
    check(
      '文件存储：详情里 turnId、guarded 为 null，hasEarlier 为 false，can.traces 为 false',
      d.messages.every((m) => m.turnId === null && m.guarded === null) && d.hasEarlier === false && d.can.traces === false,
    );
  }

  // ---- 计数与 waiting_first（不变量 45） ----
  {
    const list = await call('GET', '/conversations?order=waiting_first&limit=100', O);
    const rows = list.body.items as ConversationRow[];
    const states = rows.map((r) => conversationState(r, pack));
    const firstNonHuman = states.findIndex((x) => x !== 'human');
    const c = (await call('GET', '/conversations/counts', O)).body as ConversationCounts;
    check(
      'order=waiting_first：等人接手的全排在最前，其余照旧按 updatedAt 倒序',
      states.slice(firstNonHuman < 0 ? states.length : firstNonHuman).every((x) => x !== 'human') && states.includes('human'),
      states.join(','),
    );
    check(
      'counts：四项之和等于 total，assigned 数到顾问处理中的会话，aiByStage 之和等于 byState.ai',
      Object.values(c.byState).reduce((a, b) => a + b, 0) === c.total &&
        c.byState.assigned ===
          store.listSessions().filter((s) => !s.id.startsWith('sim-') && conversationState(s, pack) === 'assigned').length &&
        c.byState.assigned >= 2 &&
        Object.values(c.aiByStage).reduce((a, b) => a + b, 0) === c.byState.ai,
      JSON.stringify(c),
    );
  }

  // ---- viewer 打码（不变量 47）、详情的结构 ----
  {
    const S7 = 'wecom:wb13-mask';
    const s7 = mk(S7, { customer: '我手机 13812345678，身份证 11010119900101123X，卡号 6222 0212 3456 7890，2026-10-12 出发两位' });
    toHuman(S7);
    s7.profile = { destinationInterest: '云南', travelers: '2人', dates: '2026-10-12', budget: '每人两万' };
    store.saveSession(s7);
    const asOwner = (await call('GET', `/conversations/${enc(S7)}`, O)).body as ConversationDetail;
    const asViewer = (await call('GET', `/conversations/${enc(S7)}`, { as: vw })).body as ConversationDetail;
    const vt = JSON.stringify(asViewer);
    check(
      'viewer 打码：正文与交接卡的客户原话里手机号、证件号、银行卡号只留后 4 位，日期不动；所有者看到原文',
      !vt.includes('13812345678') &&
        !vt.includes('11010119900101123X') &&
        !vt.includes('6222 0212 3456 7890') &&
        asViewer.messages[0]!.text.includes('*******5678') &&
        asViewer.messages[0]!.text.includes('123X') &&
        asViewer.messages[0]!.text.includes('**** **** **** 7890') &&
        asViewer.messages[0]!.text.includes('2026-10-12') &&
        (asViewer.handoffCard?.quote ?? '').includes('*******5678') &&
        asOwner.messages[0]!.text.includes('13812345678') &&
        (asOwner.handoffCard?.quote ?? '').includes('13812345678'),
      `${asViewer.messages[0]?.text} / ${asViewer.handoffCard?.quote}`,
    );
    check(
      '详情：需求要素只用规范化的取值（目的地取词表、人数取数字、日期取 YYYY-MM-DD），只读成员的 can 全是 false',
      asOwner.need.destination === '云南' &&
        asOwner.need.travelers === '2人' &&
        asOwner.need.dates === '2026-10-12' &&
        asOwner.need.budget === '每人两万' &&
        Object.values(asViewer.can).every((v) => v === false) &&
        asOwner.paymentMode === 'online' &&
        asOwner.sendWindow === null &&
        asOwner.handoffCard?.kind === 'request' &&
        asOwner.messages.every((m, i, a) => i === 0 || m.seq > a[i - 1]!.seq),
      JSON.stringify({ need: asOwner.need, can: asViewer.can }),
    );
    check(
      '打码：价格、人数、订单号、短于 11 位的数字不动；一长串数字加字母也不卡（正则没有指数级回溯）',
      maskNumbers('每人 28800 元，两位共 57,600 元，订单 ord_13812345678abc，电话 400-123-4567') ===
        '每人 28800 元，两位共 57,600 元，订单 ord_13812345678abc，电话 400-123-4567' &&
        (() => {
          const t0 = Date.now();
          maskNumbers(`${'1 '.repeat(5000)}${'1'.repeat(5000)}a`);
          return Date.now() - t0 < 500;
        })(),
    );
    // 审查第 2 条（authz[2]、spec[0]）：护照、通行证等字母开头的证件号，紧挨字母或分隔不规整的手机号
    check(
      '打码：护照号（1–2 字母 + 7–9 位数字）只留后 4 位数字',
      maskNumbers('护照号E12345678') === '护照号E****5678' && maskNumbers('护照 EA1234567') === '护照 EA***4567',
    );
    check('打码：港澳通行证同样按证件号规则打码', maskNumbers('港澳通行证C12345678') === '港澳通行证C****5678');
    check(
      '打码：手机号前面紧挨字母（vx/wx 代指微信）照样打码，后面紧挨字母或数字的不算',
      maskNumbers('wx13812345678') === 'wx*******5678' &&
        maskNumbers('加我vx13812345678') === '加我vx*******5678' &&
        maskNumbers('ord_13812345678abc').includes('13812345678'), // 后面紧挨字母：订单号，不是手机号，不打码
    );
    check(
      '打码：点号或两个空格分隔的手机号也打码，只留后 4 位',
      maskNumbers('138.1234.5678') === '***.****.5678' && maskNumbers('138  1234  5678') === '***  ****  5678',
    );
    check(
      '打码：日期、订单号、金额不能被误打码（配反例）',
      maskNumbers('2026-10-12 出发两位') === '2026-10-12 出发两位' &&
        maskNumbers('订单 ord_e8a7aafbdd9632e75725f076') === '订单 ord_e8a7aafbdd9632e75725f076' &&
        maskNumbers('每人 28800 元，总价 57600 元') === '每人 28800 元，总价 57600 元',
    );
    // handoff_note：以「AI 已转人工」开头的 system 消息在 MessageView 里标出来；顾问消息带姓名
    s7.messages.push({ role: 'system', content: 'AI 已转人工：客户要找顾问', at: Date.now() });
    store.saveSession(s7);
    const d2 = (await call('GET', `/conversations/${enc(S7)}`, O)).body as ConversationDetail;
    check(
      '详情：「AI 已转人工」的 system 消息 kind=handoff_note',
      d2.messages.at(-1)?.kind === 'handoff_note' && d2.messages[0]!.kind === 'message',
    );
  }

  // ---- viewer 打码：row.handoff.reason 也要打码，不止交接卡（审查第 1 条，authz[0]、spec[1] 同一件事） ----
  {
    const S8 = 'wecom:wb13-mask-row';
    const s8 = mk(S8, { customer: '你好' });
    enterHandoff(s8, { kind: 'model', at: Date.now(), reason: '客户要求回电13812345678' });
    store.saveSession(s8);
    const listAsViewer = (await call('GET', '/conversations?limit=100', { as: vw })).body as { items: ConversationRow[] };
    const rowV = listAsViewer.items.find((r) => r.id === S8);
    const detailAsViewer = (await call('GET', `/conversations/${enc(S8)}`, { as: vw })).body as ConversationDetail;
    const detailAsOwner = (await call('GET', `/conversations/${enc(S8)}`, O)).body as ConversationDetail;
    check(
      'viewer 打码：GET /conversations 列表行、详情里的 row.handoff.reason、交接卡的 reason 三处都打码（之前只打了交接卡）',
      !JSON.stringify(listAsViewer).includes('13812345678') &&
        !JSON.stringify(detailAsViewer).includes('13812345678') &&
        rowV?.handoff?.reason === '客户要求回电*******5678' &&
        detailAsViewer.row.handoff?.reason === '客户要求回电*******5678' &&
        detailAsViewer.handoffCard?.reason === '客户要求回电*******5678' &&
        detailAsOwner.row.handoff?.reason === '客户要求回电13812345678',
      JSON.stringify({ rowV: rowV?.handoff, detailRow: detailAsViewer.row.handoff, card: detailAsViewer.handoffCard }),
    );
  }

  // ---- 匿名可读的旧接口：成员接手并交还种子会话之后，响应里没有成员姓名与 user id（不变量 44） ----
  {
    const SEED = 'wecom:cust_W13';
    const seedS = store.getOrCreateSession(SEED, 'simulator');
    seedS.messages.push({ role: 'customer', content: '想去云南', at: Date.now() });
    store.saveSession(seedS);
    await call('POST', `/conversations/${enc(SEED)}/reply`, {
      as: ag1,
      json: { text: '帮您看了云南的线路', clientId: '0b7c5e1a-1d2e-4f30-8a41-000000000007' },
    });
    const mid = await app.request(`/api/sessions/${enc(SEED)}`, { headers: { 'x-forwarded-for': '198.51.100.214' } });
    const midText = await mid.text();
    await call('POST', `/conversations/${enc(SEED)}/release`, { as: ag1 });
    const one = await app.request(`/api/sessions/${enc(SEED)}`, { headers: { 'x-forwarded-for': '198.51.100.215' } });
    const oneText = await one.text();
    const list = await app.request('/api/sessions', { headers: { 'x-forwarded-for': '198.51.100.216' } });
    const listText = await list.text();
    const leak = (txt: string) => [AG1.name, ids.ag1].filter((x) => txt.includes(x));
    check(
      '匿名旧接口：接手中与交还之后，单会话与列表里都没有成员姓名与 user id；交还消息改写成「顾问把会话交还 AI」',
      mid.status === 200 &&
        one.status === 200 &&
        list.status === 200 &&
        leak(midText).length === 0 &&
        leak(oneText).length === 0 &&
        leak(listText).length === 0 &&
        oneText.includes('顾问把会话交还 AI') &&
        midText.includes('"authorName":"顾问"') &&
        midText.includes('"assignee":{"name":"顾问"') &&
        store.getSession(SEED)!.messages.at(-1)?.content === `${AG1.name}把会话交还 AI`,
      `${leak(midText)} ${leak(oneText)} ${leak(listText)} ${oneText.slice(-300)}`,
    );
  }

  // ---- /status：会话数与停写会话的短码（不进 /healthz） ----
  {
    const st = await call('GET', '/status', O);
    check(
      '/status：成员看得到真实会话数与 poisoned 短码（文件存储下为空数组）',
      st.status === 200 &&
        st.body.conversations === store.storeHealth().conversations &&
        st.body.conversations > 0 &&
        JSON.stringify(st.body.poisoned) === '[]',
      st.text.slice(0, 200),
    );
    const anon = await call('GET', '/status', { ip: '198.51.100.217' });
    check('/status：匿名投影里没有会话数', anon.status === 200 && !('conversations' in anon.body));
  }

  // ---- 订单：/orders 的角色限制与从内存算、本月成交额、三个订单动作（不变量 39 的接口部分） ----
  {
    const SO = 'wecom:wb13-order';
    const so = mk(SO);
    const order = (price: number, at = Date.now()) => {
      const o = store.createOrder({
        sessionId: SO,
        routeId: 'r-yunnan-mid',
        routeTitle: '云南 丽江大理',
        travelers: 2,
        departDate: '2026-12-10',
        totalPrice: price,
      });
      o.createdAt = at;
      so.orderIds.push(o.id);
      store.saveSession(so);
      return o;
    };
    const o1 = order(10_000);
    const o2 = order(20_000);
    const o3 = order(30_000);
    toHuman(SO);
    await call('POST', `/conversations/${enc(SO)}/takeover`, { as: ag1, json: {} });
    const asAgent = await call('GET', '/orders', { as: ag1 });
    const pending = await call('GET', '/orders?status=pending_payment', { as: ag1 });
    const all = await call('GET', '/orders?limit=100', O);
    check(
      '/orders：坐席不带 status 403、只看待付款 200；所有者看全部（从 identity map 算，键集合是 OrderView）',
      asAgent.status === 403 &&
        pending.status === 200 &&
        (pending.body.items as OrderView[]).every((x) => x.status === 'pending_payment') &&
        (pending.body.items as OrderView[]).some((x) => x.id === o1.id) &&
        all.status === 200 &&
        all.body.total === store.listOrders().length &&
        JSON.stringify(Object.keys((all.body.items as Body[])[0]!)) ===
          '["id","routeTitle","travelers","departDate","totalPrice","status","createdAt","paidAt","confirmed","handoffBeforePaid","conversation"]',
      `${asAgent.status} ${pending.status} ${all.text.slice(0, 200)}`,
    );
    const notMine = keep(await call('POST', `/orders/${o1.id}/confirm`, { as: ag2 }));
    check(
      '确认价格：不是接手人的坐席 → 409 not_assignee，订单不变',
      notMine.status === 409 && notMine.body.error === 'not_assignee' && o1.confirmedAt === undefined,
      notMine.text,
    );
    check('确认价格：只读 → 403', (await call('POST', `/orders/${o1.id}/confirm`, { as: vw })).status === 403);
    const conf = await call('POST', `/orders/${o1.id}/confirm`, { as: ag1 });
    const conf2 = await call('POST', `/orders/${o1.id}/confirm`, { as: ag1 });
    check(
      '确认价格：接手人本人 → 200，记确认时刻与姓名；重复确认幂等',
      conf.status === 200 &&
        (conf.body.confirmed as Body | null)?.by === AG1.name &&
        conf2.status === 200 &&
        conf2.text === conf.text &&
        o1.confirmedBy?.userId === ids.ag1,
      conf.text,
    );
    const notice = capture(SO);
    const paid = await call('POST', `/orders/${o1.id}/mark-paid`, { as: ag1 });
    check(
      '确认收款（online 模式）：接手人本人 → 200，订单已付、记下操作者与 handoffBeforePaid，提交之后给客户发付款确认',
      paid.status === 200 &&
        o1.status === 'paid' &&
        o1.paidMarkedBy?.userId === ids.ag1 &&
        o1.handoffBeforePaid === true &&
        notice.some((x) => x.startsWith('已收到您的支付')),
      `${paid.text} ${JSON.stringify(notice)}`,
    );
    const paidAgain = await call('POST', `/orders/${o1.id}/mark-paid`, { as: ag1 });
    check(
      '确认收款：已付的再确认 → 200，不再发付款确认',
      paidAgain.status === 200 && notice.filter((x) => x.startsWith('已收到您的支付')).length === 1,
    );
    const cancelPaid = keep(await call('POST', `/orders/${o1.id}/cancel`, { as: ag1, json: { reason: '客户改主意' } }));
    check(
      '取消订单：已付的 → 409 order_state，带订单现在的状态',
      cancelPaid.status === 409 && cancelPaid.body.error === 'order_state' && cancelPaid.body.status === 'paid',
      cancelPaid.text,
    );
    const cancel = await call('POST', `/orders/${o2.id}/cancel`, { as: sup, json: { reason: '客户改主意了' } });
    check(
      '取消订单：主管任何订单都能取消 → 200 cancelled，记原因',
      cancel.status === 200 && o2.status === 'cancelled' && o2.cancelReason === '客户改主意了',
      cancel.text,
    );
    check('取消订单：原因为空 → 400', (await call('POST', `/orders/${o3.id}/cancel`, { as: sup, json: { reason: '' } })).status === 400);
    check('订单动作：不存在的订单 → 404', (await call('POST', '/orders/ord_nosuch13/confirm', { as: sup })).status === 404);
    // advisor 收款方式（mock_pay 关，prod）：没确认价格就确认收款 → 409 order_state（unconfirmed）
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    try {
      const unconfirmed = await call('POST', `/orders/${o3.id}/mark-paid`, { as: ag1 });
      const d = (await call('GET', `/conversations/${enc(SO)}`, { as: ag1 })).body as ConversationDetail;
      check(
        '确认收款（advisor 模式）：没确认价格 → 409 order_state、status=unconfirmed；详情里 paymentMode=advisor',
        unconfirmed.status === 409 &&
          unconfirmed.body.error === 'order_state' &&
          unconfirmed.body.status === 'unconfirmed' &&
          o3.status === 'pending_payment' &&
          d.paymentMode === 'advisor',
        unconfirmed.text,
      );
    } finally {
      __profileTest.reset();
    }
    const summary = await call('GET', '/orders/summary', O);
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const want = store
      .listOrders()
      .filter((o) => o.status === 'paid' && (o.paidAt ?? 0) >= from)
      .reduce((a, o) => a + o.totalPrice, 0);
    const wantPending = store
      .listOrders()
      .filter((o) => o.status === 'pending_payment')
      .reduce((a, o) => a + o.totalPrice, 0);
    check(
      '/orders/summary：本月已付的总额与笔数、现在待付款的总额（从内存算）；坐席 403',
      summary.status === 200 &&
        summary.body.paidTotal === want &&
        summary.body.paidTotal >= 10_000 &&
        summary.body.pendingTotal === wantPending &&
        summary.body.month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` &&
        (await call('GET', '/orders/summary', { as: ag1 })).status === 403,
      summary.text,
    );
    await sleep(100);
    const au = await call('GET', '/audit?actions=order.confirm,order.mark_paid,order.cancel', O);
    const rows = ((au.body.items ?? []) as Body[]).filter((x) => [o1.id, o2.id].includes(String(x.targetId)));
    check(
      '审计：确认价格、确认收款、取消订单各一行（target 是订单号，diff 带短码），重复的确认与收款不再记',
      rows.length === 3 &&
        rows.filter((x) => x.action === 'order.confirm').length === 1 &&
        rows.filter((x) => x.action === 'order.mark_paid').length === 1 &&
        rows.filter((x) => x.action === 'order.cancel').length === 1 &&
        rows.every((x) => x.targetType === 'order' && (x.diff as Body).shortId === shortIdOf(SO)),
      JSON.stringify(rows),
    );
  }

  // ---- 快捷回复：读给所有成员，管理给主管以上；写入与审计同一事务 ----
  {
    const created = await call('POST', '/quick-replies', { as: sup, json: { title: '问日期', body: '您大概什么时候出发呢？' } });
    const second = await call('POST', '/quick-replies', { as: O.as, json: { title: '问人数', body: '这次几位出行？' } });
    check(
      '快捷回复：主管、所有者能建；坐席 403',
      created.status === 200 &&
        second.status === 200 &&
        (await call('POST', '/quick-replies', { as: ag1, json: { title: 'x', body: 'y' } })).status === 403,
    );
    const id = String(created.body.id);
    const list = await call('GET', '/quick-replies', { as: vw });
    check(
      '快捷回复：只读成员也能读，按 ord 排',
      list.status === 200 && JSON.stringify((list.body.items as Body[]).map((x) => x.title)) === '["问日期","问人数"]',
      list.text,
    );
    const patched = await call('PATCH', `/quick-replies/${id}`, { as: sup, json: { body: '您打算哪天出发？' } });
    const moved = await call('POST', `/quick-replies/${id}/move`, { as: sup, json: { direction: 'down' } });
    const list2 = await call('GET', '/quick-replies', { as: ag1 });
    check(
      '快捷回复：改正文（标题不动）、下移',
      patched.status === 200 &&
        patched.body.title === '问日期' &&
        patched.body.body === '您打算哪天出发？' &&
        moved.status === 200 &&
        moved.body.moved === true &&
        JSON.stringify((list2.body.items as Body[]).map((x) => x.title)) === '["问人数","问日期"]',
      `${patched.text} ${list2.text}`,
    );
    const archived = await call('POST', `/quick-replies/${id}/archive`, { as: sup });
    const list3 = await call('GET', '/quick-replies', { as: ag1 });
    check(
      '快捷回复：归档之后不再列出，再归档 404；标题超长 400',
      archived.status === 200 &&
        !(list3.body.items as Body[]).some((x) => x.id === id) &&
        (await call('POST', `/quick-replies/${id}/archive`, { as: sup })).status === 404 &&
        (await call('POST', '/quick-replies', { as: sup, json: { title: 'x'.repeat(21), body: 'y' } })).status === 400,
    );
    const au = await call('GET', '/audit?actions=quick_reply.create,quick_reply.update,quick_reply.move,quick_reply.archive', O);
    check(
      '审计：快捷回复的新建、修改、移动、归档各记一行',
      ['quick_reply.create', 'quick_reply.update', 'quick_reply.move', 'quick_reply.archive'].every((a) =>
        ((au.body.items ?? []) as Body[]).some((x) => x.action === a && x.targetId === id),
      ),
      au.text.slice(0, 300),
    );
  }

  // ---- 事件流（不变量 31）：提交后才推、不带正文、Last-Event-ID 续传与 resync、心跳、登录失效后关闭 ----
  {
    __eventsTest.reset();
    check(
      '事件流：默认每 20 秒心跳、每 50 秒复核登录（留查库余量，保证 spec 的「60 秒内关闭」不被卡到 60 秒加一次查库）、计数去抖 300ms',
      JSON.stringify(eventTiming()) === JSON.stringify({ heartbeatMs: 20_000, recheckMs: 50_000, countsDebounceMs: 300 }) &&
        eventTiming().recheckMs < 60_000,
    );
    __eventsTest.setTiming({ heartbeatMs: 80, recheckMs: 150, countsDebounceMs: 30 });
    interface Ev {
      id?: string;
      event?: string;
      data?: string;
      comment?: string;
    }
    const open = async (who: Who | null, headers: Record<string, string> = {}) => {
      const h: Record<string, string> = { 'x-forwarded-for': '203.0.113.160', ...headers };
      if (who) h.cookie = `${session.SESSION_COOKIE}=${who.token}`;
      const res = await app.request('/api/console/events', { headers: h });
      const reader2 = res.body?.getReader();
      const dec = new TextDecoder();
      let raw = '';
      let done = false;
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
      const pump = async (until: (raw: string) => boolean, ms = 3000): Promise<boolean> => {
        const deadline = Date.now() + ms;
        if (!reader2) return until(raw);
        while (!done && !until(raw)) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          pending ??= reader2.read();
          const r = await Promise.race([pending, sleep(left).then(() => null)]);
          if (r === null) break;
          pending = null;
          if (r.done) done = true;
          else raw += dec.decode(r.value, { stream: true });
        }
        return until(raw);
      };
      const events = (): Ev[] =>
        raw
          .split('\n\n')
          .filter((b) => b.trim())
          .map((b) => {
            const ev: Ev = {};
            for (const line of b.split('\n')) {
              if (line.startsWith(':')) ev.comment = line;
              else if (line.startsWith('id: ')) ev.id = line.slice(4);
              else if (line.startsWith('event: ')) ev.event = line.slice(7);
              else if (line.startsWith('data: ')) ev.data = line.slice(6);
            }
            return ev;
          });
      return { res, pump, events, raw: () => raw, done: () => done, close: () => reader2?.cancel() };
    };
    const anon = await open(null);
    check('事件流：匿名 → 401', anon.res.status === 401);
    const es = await open(ag1);
    check(
      '事件流：成员连上 200，带安全头与 text/event-stream',
      es.res.status === 200 && secured(es.res.headers) && (es.res.headers.get('content-type') ?? '').startsWith('text/event-stream'),
    );
    await es.pump((r) => r.includes('event: counts'));
    const first = es.events()[0];
    check(
      '事件流：没带 Last-Event-ID 时先收一条当前的 counts，id 是「启动标识-序号」',
      first?.event === 'counts' &&
        new RegExp(`^${__eventsTest.boot}-\\d+$`).test(first.id ?? '') &&
        (JSON.parse(first.data ?? '{}') as ConversationCounts).total > 0,
      JSON.stringify(first),
    );
    const SECRET = 'SSE不该出现的原话13800001111';
    const SE = 'wecom:wb13-sse';
    const se = store.getOrCreateSession(SE, 'simulator');
    se.profile = { destinationInterest: 'SSE不该出现的画像' };
    se.messages.push({ role: 'customer', content: SECRET, at: Date.now() });
    store.saveSession(se);
    toHuman(SE);
    const simV = store.getOrCreateSession('sim-wb13sse000000000000000001', 'simulator');
    simV.messages.push({ role: 'customer', content: '访客的话', at: Date.now() });
    store.saveSession(simV);
    await es.pump((r) => r.includes('event: handoff') && r.includes('event: message'), 3000);
    await es.pump(() => false, 400);
    const evs = es.events();
    const handoff = evs.find((e) => e.event === 'handoff');
    check(
      '事件流：转人工提交之后推 handoff（类型、ISO 时间、paidCustomer）、message（seq 与作者）、conversation 与去抖后的 counts',
      !!handoff &&
        (JSON.parse(handoff.data ?? '{}') as Body).kind === 'request' &&
        (JSON.parse(handoff.data ?? '{}') as Body).paidCustomer === false &&
        evs.some(
          (e) =>
            e.event === 'message' &&
            (JSON.parse(e.data ?? '{}') as Body).author === 'customer' &&
            (JSON.parse(e.data ?? '{}') as Body).id === SE,
        ) &&
        evs.some((e) => e.event === 'conversation' && (JSON.parse(e.data ?? '{}') as Body).id === SE) &&
        evs.filter((e) => e.event === 'counts').length >= 2,
      es.raw().slice(-600),
    );
    check(
      '事件流：没有消息正文、客户原话和画像，没有 sim- 访客会话的事件',
      !es.raw().includes(SECRET) &&
        !es.raw().includes('13800001111') &&
        !es.raw().includes('SSE不该出现的画像') &&
        !es.raw().includes('sim-wb13sse') &&
        !es.raw().includes('访客的话'),
      es.raw().slice(-400),
    );
    const ids2 = evs.filter((e) => e.id).map((e) => Number(e.id!.split('-')[1]));
    check(
      '事件流：id 的序号逐条递增',
      ids2.every((n, i) => i === 0 || n > ids2[i - 1]!),
      ids2.join(','),
    );
    await es.pump((r) => r.includes(': ping'), 1000);
    check('事件流：注释心跳', es.raw().includes(': ping'));
    // 续传：带本次启动的 Last-Event-ID 只补它之后的；别的启动的、序号超前的 → resync
    const mark = evs.find((e) => e.event === 'handoff')!.id!;
    const resume = await open(ag1, { 'last-event-id': mark });
    await resume.pump(() => false, 600);
    const re = resume.events();
    const markN = Number(mark.split('-')[1]);
    const afterMark = evs.filter((e) => e.id && Number(e.id.split('-')[1]) > markN && e.event !== 'counts').map((e) => e.id);
    check(
      '事件流：带本次启动的 Last-Event-ID 重连，补发它之后的事件（一条不少），不先发 resync 也不重发它自己与更早的',
      re.length > 0 &&
        re[0]!.event !== 'resync' &&
        re.every((e) => !e.id || Number(e.id.split('-')[1]) > markN) &&
        afterMark.every((id) => re.some((e) => e.id === id)) &&
        afterMark.length > 0,
      resume.raw().slice(0, 300),
    );
    void resume.close();
    const foreign = await open(ag1, { 'last-event-id': 'deadbeef-3' });
    await foreign.pump((r) => r.includes('event: resync'), 1500);
    check('事件流：Last-Event-ID 不是本次启动的 → 先发 resync', foreign.events()[0]?.event === 'resync', foreign.raw().slice(0, 200));
    void foreign.close();
    const ahead = await open(ag1, { 'last-event-id': `${__eventsTest.boot}-999999` });
    await ahead.pump((r) => r.includes('event: resync'), 1500);
    check('事件流：序号超前（不可能的 id）→ resync', ahead.events()[0]?.event === 'resync');
    void ahead.close();
    // 环形缓冲只留最近 500 条：比它还旧的 Last-Event-ID → resync
    const oldMark = `${__eventsTest.boot}-1`;
    for (let i = 0; i < 520; i++) __eventsTest.publish('send_failed', { id: 'wecom:wb13-flood', failType: null });
    const stale = await open(ag1, { 'last-event-id': oldMark });
    await stale.pump((r) => r.includes('event: resync'), 1500);
    check(
      '事件流：比环形缓冲（500 条）还旧的 Last-Event-ID → resync',
      __eventsTest.ringSize() === 500 && stale.events()[0]?.event === 'resync',
    );
    void stale.close();
    // 审查第 2 条（02 第 19 步，minor）：顾问点「接手」触发的 handoff.started 带 assigned:true（已有接手人），
    // 前端据此不弹浏览器通知；toHuman() 那条没人接手，assigned 是 false
    const TK = 'wecom:wb13-tk-assigned';
    store.getOrCreateSession(TK, 'simulator');
    const beforeTk = es.events().length;
    const tkRes = await call('POST', `/conversations/${encodeURIComponent(TK)}/takeover`, { as: ag1, json: {} });
    check('接手：200', tkRes.status === 200, JSON.stringify(tkRes.body));
    // raw 缓冲里早就有过「event: handoff」这几个字（toHuman 那条），只等它不够，要等含这个会话 id 的新内容
    await es.pump((r) => r.includes(TK), 1000);
    const tkHandoff = es
      .events()
      .slice(beforeTk)
      .find((e) => e.event === 'handoff' && (JSON.parse(e.data ?? '{}') as Body).id === TK);
    check(
      '事件流：顾问接手触发的 handoff.started 带 assigned:true；toHuman（没人接手）的那条是 assigned:false',
      !!tkHandoff &&
        (JSON.parse(tkHandoff.data ?? '{}') as Body).assigned === true &&
        (JSON.parse(handoff!.data ?? '{}') as Body).assigned === false,
      `${JSON.stringify(tkHandoff)} / ${JSON.stringify(handoff)}`,
    );
    void es.close();
    // 登录失效（删掉 auth_session）：下一次复核时发 auth 并关闭
    const viewerStream = await open(vw);
    check('事件流：只读成员也能连', viewerStream.res.status === 200);
    void viewerStream.close();
    const ag3 = await httpLogin(AG1.email, AG1.password, '203.0.113.161');
    const doomed = await open(ag3);
    await doomed.pump((r) => r.includes('event: counts'));
    await asSuper(() => t.pg.query('delete from auth_sessions where token_hash = $1', [createHash('sha256').update(ag3.token).digest()]));
    const closed = await doomed.pump(() => false, 1500).then(() => doomed.done());
    check(
      '事件流：删掉这个登录的 auth_session 之后，下一次复核发 auth 并关闭连接',
      closed && doomed.events().some((e) => e.event === 'auth'),
      doomed.raw().slice(-200),
    );
    __eventsTest.reset();
  }

  // ---- db 存储才有的部分：子进程 ----
  runDbStoreChild();
}

/** 起 db 存储的子进程（单进程 node --import tsx，SIGKILL 超时），把它的断言并进本进程 */
function runDbStoreChild(): void {
  const result = path.join(process.env.VAR_DIR!, 'db-child.json');
  const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: { ...process.env, CONSOLE_SELFTEST_CHILD: 'db', CONSOLE_CHILD_RESULT: result },
    timeout: 180_000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  const ok = r.status === 0 && fs.existsSync(result);
  check('db 存储子进程正常结束', ok, `status=${r.status} signal=${r.signal} ${(r.stderr ?? '').slice(-1500)}`);
  if (!fs.existsSync(result)) return;
  const out = JSON.parse(fs.readFileSync(result, 'utf8')) as { checks: [string, boolean, string][]; fatal: string | null };
  check('db 存储子进程没有中途抛错', out.fatal === null, out.fatal ?? '');
  check('db 存储子进程：断言都跑到了', out.checks.length >= 15, String(out.checks.length));
  for (const [name, okc, detail] of out.checks) check(`db 存储：${name}`, okc, detail);
}

/**
 * db 存储（PGlite 上的 PG 会话存储）下的后台接口：J 页的 turnId 与护栏改写句数、步骤摘要、改写对照（只读成员打码）、trace 原文（只给所有者、
 * 管理员）、更早的消息（重置之后窗口以前的）、种子会话返回空、写库积压时写接口 503 store_lagging（等提交超时的已在内存生效，回复在改动
 * 之前就拒绝、什么都没改）、人工回复入库带操作者、会话类审计的 target 是会话行的 ref、/status。结果写进 CONSOLE_CHILD_RESULT
 */
async function dbStoreChild(): Promise<never> {
  const out: { checks: [string, boolean, string][]; fatal: string | null } = { checks: [], fatal: null };
  const ck = (name: string, ok: boolean, detail = ''): void => void out.checks.push([name, ok, ok ? '' : detail.slice(0, 600)]);
  try {
    const { openTestDb, installSeededConfig, installPgSessionStore } = await import('../db/testing.js');
    const accounts = await import('../auth/accounts.js');
    const authSession = await import('../auth/session.js');
    const { randomUUID } = await import('node:crypto');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const t = await openTestDb();
    await t.pg.query(`insert into tenants (slug, name, pack_id) values ('demo', 'demo', 'travel')`);
    await installSeededConfig(t);
    /** 以超级用户读库：角色只在这个事务里换（PGlite 只有一条连接，落库的事务与它排队，不会串了角色） */
    const su = <R>(text: string, params: unknown[] = []): Promise<R[]> =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<R>(text, params)).rows;
      });
    const users = [
      { email: 'own-db13@example.com', name: '老板', role: 'owner' },
      { email: 'ag-db13@example.com', name: '小林', role: 'agent' },
      { email: 'vw-db13@example.com', name: '看客', role: 'viewer' },
    ] as const;
    for (const u of users) {
      await t.pg.exec('SET ROLE agent_platform');
      try {
        await accounts.createUser(t.db, {
          tenantSlug: 'demo',
          email: u.email,
          name: u.name,
          role: u.role,
          password: async () => `${u.role}-db13-password`,
        });
      } finally {
        await t.pg.exec('SET ROLE agent_app');
      }
    }
    const fx = await installPgSessionStore(t, { varDir: process.env.VAR_DIR! });
    const store = await import('../store.js');
    await store.initSessionStore(fx.deps);
    const { app } = await import('../server.js');
    const { subscribe } = await import('../adapters/simulator.js');
    ck('装配：会话存储是 db', store.sessionStoreMode() === 'db');
    interface W {
      token: string;
      csrf: string;
      userId: string;
    }
    let ipN = 0;
    const login = async (email: string, password: string): Promise<W> => {
      ipN += 1;
      const body = JSON.stringify({ email, password });
      const res = await app.request('/api/console/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'x-forwarded-for': `203.0.113.${200 + ipN}`,
        },
        body,
      });
      const me = (await res.json()) as { csrf: string; userId: string };
      const token = new RegExp(`^${authSession.SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
      return { token, csrf: me.csrf, userId: me.userId };
    };
    const req = async (
      method: string,
      url: string,
      who: W,
      json?: unknown,
    ): Promise<{ status: number; body: Record<string, any>; text: string }> => {
      const headers: Record<string, string> = {
        'x-forwarded-for': '203.0.113.250',
        cookie: `${authSession.SESSION_COOKIE}=${who.token}`,
        'x-csrf': who.csrf,
      };
      let body: string | undefined;
      if (json !== undefined) {
        body = JSON.stringify(json);
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const res = await app.request(`/api/console${url}`, { method, headers, body });
      const text = await res.text();
      let parsed: Record<string, any> = {};
      try {
        parsed = JSON.parse(text) as Record<string, any>;
      } catch {
        /* 不是 JSON */
      }
      return { status: res.status, body: parsed, text };
    };
    const own = await login(users[0].email, 'owner-db13-password');
    const ag = await login(users[1].email, 'agent-db13-password');
    const vw = await login(users[2].email, 'viewer-db13-password');
    const enc = encodeURIComponent;

    // ---- trace 类：J 页消息上的 turnId 与改写句数、步骤摘要、改写对照、trace 原文 ----
    const SID = 'wecom:wmDB13trace';
    const s = store.getOrCreateSession(SID, 'simulator');
    s.messages.push({ role: 'customer', content: '西藏多少钱？我电话 13812345678', at: Date.now() });
    const replyMsg: ChatMessage = { role: 'agent', content: '西藏这条每人 12,800 元起。', at: Date.now() };
    s.messages.push(replyMsg);
    const turnId = randomUUID();
    store.linkTurn(replyMsg, turnId);
    store.saveSession(s);
    store.queueTelemetry(SID, {
      traces: [
        {
          id: turnId,
          conversationId: SID,
          startedAt: new Date(),
          durationMs: 1234,
          outcome: 'replied',
          sopVersion: 1,
          prefixHash: 'a'.repeat(64),
          catalogVersions: { 'route:r-tibet': 1 },
          stageBefore: 'greeting',
          stageAfter: 'quote',
          draft: '西藏这条每人 9,999 元，电话 13812345678 我记下了。西藏这条每人 12,800 元起。',
          finalText: replyMsg.content,
          calls: [
            { name: 'search_routes', prefetch: true },
            { name: 'create_quote', prefetch: false },
          ],
          llm: [{ model: 'glm-x', ms: 900 }],
          signals: null,
        },
      ],
      guards: [
        {
          turnId,
          ord: 0,
          guard: 'price',
          action: 'drop_sentence',
          removed: ['西藏这条每人 9,999 元，电话 13812345678 我记下了。'],
          added: [],
        },
      ],
    });
    await store.flushSession(SID);
    const d = await req('GET', `/conversations/${enc(SID)}`, own);
    const msgs = (d.body.messages ?? []) as { turnId: string | null; guarded: unknown; role: string }[];
    ck(
      '详情：AI 回复带 turnId 与相对原稿的改写句数，客户消息没有；hasEarlier 为 false；所有者 can.traces 为 true',
      d.status === 200 &&
        msgs[1]?.turnId === turnId &&
        JSON.stringify(msgs[1]?.guarded) === JSON.stringify({ removed: 1, added: 0 }) &&
        msgs[0]?.turnId === null &&
        d.body.hasEarlier === false &&
        d.body.can.traces === true,
      d.text.slice(0, 400),
    );
    const steps = await req('GET', `/conversations/${enc(SID)}/turns`, vw);
    ck(
      '步骤摘要：每轮的工具名换成行业包的中文名、带是否预取，不含参数与耗时；只读成员能看',
      steps.status === 200 &&
        JSON.stringify(steps.body.turns?.[0]?.steps) ===
          JSON.stringify([
            { name: 'search_routes', label: '查线路', prefetch: true },
            { name: 'create_quote', label: '算报价', prefetch: false },
          ]) &&
        !steps.text.includes('1234') &&
        !steps.text.includes('glm-x'),
      steps.text,
    );
    const diffV = await req('GET', `/conversations/${enc(SID)}/turns/${turnId}/diff`, vw);
    const diffO = await req('GET', `/conversations/${enc(SID)}/turns/${turnId}/diff`, own);
    ck(
      '改写对照：删去的句子（净差）与逐个护栏；只读成员看到的打码，所有者看到原文',
      diffV.status === 200 &&
        diffV.body.removed?.length === 1 &&
        !diffV.text.includes('13812345678') &&
        diffV.text.includes('*******5678') &&
        diffV.body.events?.[0]?.guard === 'price' &&
        diffO.text.includes('13812345678'),
      `${diffV.text} | ${diffO.text}`,
    );
    const trO = await req('GET', `/conversations/${enc(SID)}/turns/${turnId}`, own);
    const trA = await req('GET', `/conversations/${enc(SID)}/turns/${turnId}`, ag);
    ck(
      'trace 原文：所有者拿到原稿、耗时、模型、前缀与条目版本；坐席 403',
      trO.status === 200 &&
        trO.body.draft?.includes('9,999') &&
        trO.body.durationMs === 1234 &&
        trO.body.prefixHash === 'a'.repeat(64) &&
        trO.body.catalogVersions?.['route:r-tibet'] === 1 &&
        trA.status === 403,
      `${trO.text.slice(0, 300)} ${trA.status}`,
    );
    const other = store.getOrCreateSession('wecom:wmDB13other', 'simulator');
    other.messages.push({ role: 'customer', content: '在吗', at: Date.now() });
    store.saveSession(other);
    const cross = await req('GET', `/conversations/${enc('wecom:wmDB13other')}/turns/${turnId}/diff`, own);
    const nosuch = await req('GET', `/conversations/${enc(SID)}/turns/${randomUUID()}`, own);
    const notUuid = await req('GET', `/conversations/${enc(SID)}/turns/not-a-uuid/diff`, own);
    ck(
      'trace 类：别的会话的轮次、不存在的轮次、不是 uuid 的都是 404',
      [cross, nosuch, notUuid].every((r) => r.status === 404),
      [cross, nosuch, notUuid].map((r) => r.status).join(),
    );

    // ---- 更早的消息：重置之后窗口以前的从库里读，按 seq 升序 ----
    const { handleMessage } = await import('../engine.js');
    const SE = 'wecom:wmDB13early';
    for (const text of ['第一句', '第二句', '第三句']) {
      const x = store.getOrCreateSession(SE, 'simulator');
      x.messages.push({ role: 'customer', content: text, at: Date.now() });
      store.saveSession(x);
    }
    await store.flushSession(SE);
    await handleMessage(SE, '重置', 'simulator');
    await store.flushSession(SE);
    const de = await req('GET', `/conversations/${enc(SE)}`, ag);
    const first = (de.body.messages as { seq: number }[])[0]!.seq;
    const page = await req('GET', `/conversations/${enc(SE)}/messages?beforeSeq=${first}`, vw);
    const page2 = await req('GET', `/conversations/${enc(SE)}/messages?beforeSeq=${first}&limit=2`, ag);
    ck(
      '更早的消息：重置之后 hasEarlier 为 true，按 seq 往前取到窗口以前的三句（升序），limit 截掉更早的并报 hasEarlier',
      de.body.hasEarlier === true &&
        JSON.stringify((page.body.messages as { text: string }[]).map((m) => m.text)) === '["第一句","第二句","第三句"]' &&
        page.body.hasEarlier === false &&
        JSON.stringify((page2.body.messages as { text: string }[]).map((m) => m.text)) === '["第二句","第三句"]' &&
        page2.body.hasEarlier === true,
      `${de.text.slice(0, 200)} | ${page.text} | ${page2.text}`,
    );
    ck('更早的消息：beforeSeq 缺失或不是正整数 → 400', (await req('GET', `/conversations/${enc(SE)}/messages`, ag)).status === 400);

    // ---- 种子会话（demo 类不进库）：更早的消息与步骤摘要返回空，改写对照 404，详情照常 ----
    const SEED = 'wecom:cust_D13';
    const seed = store.getOrCreateSession(SEED, 'simulator');
    seed.messages.push({ role: 'customer', content: '种子', at: Date.now() });
    store.saveSession(seed);
    const sm = await req('GET', `/conversations/${enc(SEED)}/messages?beforeSeq=5`, ag);
    const st = await req('GET', `/conversations/${enc(SEED)}/turns`, ag);
    const sd = await req('GET', `/conversations/${enc(SEED)}`, own);
    ck(
      '种子会话：更早的消息与步骤摘要返回空，详情里 turnId 为 null、can.traces 为 false',
      sm.status === 200 &&
        sm.text === '{"messages":[],"hasEarlier":false}' &&
        st.status === 200 &&
        st.text === '{"turns":[]}' &&
        sd.status === 200 &&
        sd.body.can.traces === false,
      `${sm.text} ${st.text}`,
    );

    // ---- 人工回复入库：author=human、操作者是真实成员（外键），seq 与库里一致；会话类审计的 target 是 ref ----
    const SR = 'wecom:wmDB13reply';
    const sr = store.getOrCreateSession(SR, 'simulator');
    sr.messages.push({ role: 'customer', content: '有人吗', at: Date.now() });
    store.saveSession(sr);
    const pushed: string[] = [];
    subscribe(SR, (x) => pushed.push(x));
    const rr = await req('POST', `/conversations/${enc(SR)}/reply`, ag, { text: '在的，我是顾问', clientId: randomUUID() });
    const row = await su<{ author: string; author_user_id: string; author_name: string; seq: number }>(
      `select author, author_user_id, author_name, seq from messages where conversation_id = $1 and author = 'human'`,
      [SR],
    );
    const conv = await su<{ ref: string; assignee_user_id: string | null }>(
      'select ref, assignee_user_id from conversations where id = $1',
      [SR],
    );
    const au = await su<{ action: string; target_id: string; actor_user_id: string; diff: { shortId?: string } }>(
      `select action, target_id, actor_user_id, diff from audit_log where action like 'conversation.%' and target_type = 'conversation'`,
    );
    ck(
      '人工回复（db）：200、persisted，库里那条 author=human、操作者 id 与姓名、seq 等于返回的 seq；接手人写进会话行',
      rr.status === 200 &&
        rr.body.persisted === true &&
        rr.body.sent === true &&
        row.length === 1 &&
        row[0]!.author_user_id === ag.userId &&
        row[0]!.author_name === '小林' &&
        Number(row[0]!.seq) === rr.body.seq &&
        conv[0]?.assignee_user_id === ag.userId &&
        pushed.join() === '【顾问】在的，我是顾问',
      `${rr.text} ${JSON.stringify(row)} ${JSON.stringify(conv)}`,
    );
    ck(
      '会话类审计（db）：随落库写，target_id 是会话行的 ref（不含客户标识），diff 带短码',
      au.some(
        (a) => a.action === 'conversation.takeover' && a.target_id === conv[0]?.ref && a.actor_user_id === ag.userId && !!a.diff.shortId,
      ) && au.every((a) => !String(a.target_id).includes('wmDB13')),
      JSON.stringify(au),
    );
    // 回复即接手时才进入的转人工：当场就有人处理，enterHandoff 排的两个转人工通知在同一次落库里取消，不往群里发「等人接手」
    const notify = await su<{ status: string }>(`select status from jobs where kind = 'handoff_notify' and payload->>'sessionId' = $1`, [
      SR,
    ]);
    ck(
      '接手时才进入的转人工：两个转人工通知（立即、10 分钟没人接手）随同一次落库取消',
      notify.length === 2 && notify.every((j) => j.status === 'cancelled'),
      JSON.stringify(notify),
    );

    // ---- /status：会话数与 poisoned 短码 ----
    const status = await req('GET', '/status', own);
    ck(
      '/status（db）：会话数是真实会话（不含种子），poisoned 为空',
      status.status === 200 &&
        status.body.conversations === store.storeHealth().conversations &&
        status.body.conversations >= 4 &&
        status.body.poisoned?.length === 0,
      status.text.slice(-200),
    );

    // ---- 写库积压：等提交超时 → 503 store_lagging（改动已在内存生效）；积压超过 5 秒时人工回复在改动之前就 503 ----
    const SL = 'wecom:wmDB13lag';
    const sl = store.getOrCreateSession(SL, 'simulator');
    sl.messages.push({ role: 'customer', content: '在吗', at: Date.now() });
    store.saveSession(sl);
    await store.flushSession(SL);
    let open!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open = r));
    const t0 = Date.now();
    const lag = await req('POST', `/conversations/${enc(SL)}/takeover`, ag, {});
    ck(
      '写库积压：接手等提交超过 5 秒 → 503 store_lagging，改动已在内存生效（接手人已是他）',
      lag.status === 503 && lag.body.error === 'store_lagging' && Date.now() - t0 >= 4900 && sl.assignee?.userId === ag.userId,
      `${lag.text} ${Date.now() - t0}ms`,
    );
    await sleep(300); // 积压已经超过 5 秒
    const before = sl.messages.length;
    const pushedL: string[] = [];
    subscribe(SL, (x) => pushedL.push(x));
    const lagReply = await req('POST', `/conversations/${enc(SL)}/reply`, ag, { text: '积压时的回复', clientId: randomUUID() });
    ck(
      '写库积压：积压超过 5 秒时人工回复 → 503 store_lagging，什么都没改、客户没收到',
      lagReply.status === 503 && lagReply.body.error === 'store_lagging' && sl.messages.length === before && pushedL.length === 0,
      lagReply.text,
    );
    fx.faults.gate = null;
    open();
    await store.flushSession(SL, { timeoutMs: 5000 });
    const ok = await req('POST', `/conversations/${enc(SL)}/reply`, ag, { text: '恢复之后的回复', clientId: randomUUID() });
    ck(
      '写库积压：恢复之后照常回复',
      ok.status === 200 && ok.body.persisted === true && pushedL.join() === '【顾问】恢复之后的回复',
      ok.text,
    );

    // ---- 人工回复只在提交之后发（不变量 20、验收 11）：落库暂停时客户收不到，放开、提交之后才收到；推送那一刻库里已有这一条 ----
    let open2!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open2 = r));
    let pushedAt = 0;
    let inDbAtPush: Promise<boolean> | null = null;
    const pushedO: string[] = [];
    subscribe(SL, (x) => {
      pushedO.push(x);
      pushedAt = Date.now();
      // 订阅回调是同步的，这一刻起查库：推送之前已经提交的话查得到
      inDbAtPush ??= su<{ n: number }>(`select count(*)::int as n from messages where conversation_id = $1 and content = '暂停时的回复'`, [
        SL,
      ]).then((r) => (r[0]?.n ?? 0) === 1);
    });
    const pending = req('POST', `/conversations/${enc(SL)}/reply`, ag, { text: '暂停时的回复', clientId: randomUUID() });
    await sleep(1500);
    const beforeOpen = pushedO.length;
    const openedAt = Date.now();
    fx.faults.gate = null;
    open2();
    const ordered = await pending;
    const committedFirst = await (inDbAtPush ?? Promise.resolve(false));
    ck(
      '人工回复：落库暂停时客户收不到，提交之后才发（推送那一刻库里已有这一条），persisted 为 true',
      beforeOpen === 0 &&
        ordered.status === 200 &&
        ordered.body.persisted === true &&
        pushedO.at(-1) === '【顾问】暂停时的回复' &&
        pushedAt >= openedAt &&
        committedFirst,
      `${ordered.text} 放开前 ${beforeOpen} 条，推送时库里 ${String(committedFirst)}`,
    );
    // ---- 等提交超过 5 秒：照发，返回 persisted: false（改动仍在写队列里） ----
    let open3!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open3 = r));
    const slow = await req('POST', `/conversations/${enc(SL)}/reply`, ag, { text: '等不到提交的回复', clientId: randomUUID() });
    ck(
      '人工回复：等提交超过 5 秒也照发，返回 persisted: false',
      slow.status === 200 && slow.body.sent === true && slow.body.persisted === false && pushedO.at(-1) === '【顾问】等不到提交的回复',
      slow.text,
    );
    fx.faults.gate = null;
    open3();
    await store.drainStore(5000);
  } catch (e) {
    out.fatal = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
  }
  fs.writeFileSync(process.env.CONSOLE_CHILD_RESULT!, JSON.stringify(out));
  process.exit(0);
}

await t.close();
if (fails.length) {
  console.error(`CONSOLE SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `CONSOLE SELFTEST PASS: ${pass} 项断言全通（口令哈希与并发上限 / 平台账号命令行 / 登录与会话 / 空闲与绝对过期 / 三路限流与防探测 / 口令升级 / 吊销会话 / prod 下后台 SSE 要求会话 / ` +
    `HTTP：cookie 与 CSRF、权限矩阵、发布回滚与审计、rebase 冲突、冲突合并的 rebaseOnto、契约闸、产品库锁定字段与补丁、匿名投影与 prod 401、锁丢失、文件模式、安全头、会话只读列表、会话状态与计数、/me 的租户名与 /pack、CSV 导入、审计按一组动作过滤、/console 托管、静态资源的缓存与压缩）`,
);
process.exit(0);
