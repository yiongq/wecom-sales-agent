// 数据库自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」，02 spec「数据库」「测试与 CI」同步扩充）。
// 两部分：
// - PGlite：迁移连跑两遍、约束（含哈希 CHECK）、三个触发器、两个部分唯一索引、复合外键（验收 7 的约束与触发器部分），
//   外加 withTenant 与五个认证函数的冒烟——plpgsql 的运行期错误只有真跑一次才暴露。
//   02：条目版本的按租户回填（分两段跑迁移）、十二张新表的 CHECK、jobs 的 open 唯一、复合外键与 SET NULL (session_id)、
//   两个触发器、每个仓储函数的冒烟、withTenant 的 longRunning 与 inTenantTx、清除与删除函数的行为。
// - 真实 Postgres，有 PG_TEST_URL 才跑（CI=true 而没有它时失败）：roles.sql、各角色对各表的权限逐格、RLS 行为、会话级泄漏、
//   临时表遮蔽、租户锁（验收 12 与验收 7 的权限部分）。PGlite 以超级用户连接，RLS 与授权的结论只从这部分得出（spec R13）。
//   02：新表逐格权限、没有 DELETE / TRUNCATE、消息只追加、跨租户读写不到、清除与删除函数的授权与行为（02 验收 5，不变量 5、6、11、42）。
// - 03（渠道层 v2，03 spec「数据库」「测试与 CI」）：PGlite 上迁移从 02 升上来、两张新表与 outbound_sends 新列的 CHECK、ord 递增、
//   出站与入站迁移表的每一格（允许的改了、表外的没改）、仓储冒烟；两边都跑：两个触发器、purge_channel_inbox、清除与删除连带入站行；
//   真实 PG：新表逐格授权与列级授权、没有 DELETE / TRUNCATE、租户隔离（03 验收 19，不变量 7、8、21、30）。
// 用法：npx tsx src/db/db.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-db-selftest-'));
// 真实 PG 部分会加载引擎，引擎连带读开发机的 .env：CONFIG_SOURCE=db 写在那里也不能影响这组
process.env.CONFIG_SOURCE = 'file';

const { sql, asc, eq } = await import('drizzle-orm');
const { openTestDb } = await import('./testing.js');
const { withTenant, currentTenantCtx, lockTenantConfig, queryCount, rowsOf } = await import('./client.js');
const { catalogItems } = await import('./schema.js');
type Tx = import('./client.js').Tx;
type SQL = import('drizzle-orm').SQL;
type TenantCtx = import('./client.js').TenantCtx;
type ConversationValues = import('./repo/conversations.js').ConversationValues;
type MessageValues = import('./repo/messages.js').MessageValues;
type OrderRow = import('./repo/orders.js').OrderRow;
type UsageDelta = import('./repo/usage.js').UsageDelta;

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

interface PgErr {
  code: string;
  constraint?: string;
  message: string;
}
/** 数据库错误：PGlite 直接挂在错误上，经 drizzle 的包在 cause 里 */
function pgErr(e: unknown): PgErr | undefined {
  for (let x: unknown = e; x && typeof x === 'object'; x = (x as { cause?: unknown }).cause) {
    if (typeof (x as { code?: unknown }).code === 'string') return x as PgErr;
  }
  return undefined;
}
const notDb = (e: unknown): string => `非数据库错误：${e instanceof Error ? e.message : String(e)}`;
/** 'ok'，或数据库错误码；不是数据库错误时带上消息，断言失败时看得出是什么 */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return pgErr(e)?.code ?? notDb(e);
  }
}
/**
 * 被谁拒的：'ok'、约束名、'trigger'（本仓库的触发器，消息以「表名:」开头），或其他错误码。
 * 只比错误码分不出是哪一条拦下的：一条约束拆掉了，别的约束碰巧也拦得住，断言照样绿
 */
async function why(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const err = pgErr(e);
    if (!err) return notDb(e);
    if (err.constraint) return err.constraint;
    if (err.code === '23514' && /^(sop_versions|catalog_items|conversations|orders|channel_accounts|channel_inbox): /.test(err.message)) {
      return 'trigger';
    }
    return `${err.code} ${err.message}`;
  }
}
const CHECK = '23514';
const UNIQUE = '23505';
const DENIED = '42501';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const t = await openTestDb();
/** 以超级用户直接发 SQL（绕过 RLS），造数据与读回用 */
const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
  (await t.pg.query<R>(text, params)).rows;
const ctxOf = (tenantId: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } });
/** 以 agent_app 身份在租户事务里执行，走生产用的 withTenant */
async function asApp<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await t.pg.exec('SET ROLE agent_app');
  try {
    return await withTenant(t.db, ctxOf(tenantId), fn);
  } finally {
    await t.pg.exec('RESET ROLE');
  }
}
/** 以 agent_platform 身份在租户事务里执行（隐私说明只有平台能发布） */
async function asPlatform<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await t.pg.exec('SET ROLE agent_platform');
  try {
    return await withTenant(t.db, ctxOf(tenantId), fn);
  } finally {
    await t.pg.exec('RESET ROLE');
  }
}

type Query = <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
/** 02 的十二张新表（spec「数据库」与各节的 DDL） */
const NEW_TABLES = [
  'conversations',
  'messages',
  'orders',
  'turn_traces',
  'guard_events',
  'usage_daily',
  'jobs',
  'quick_replies',
  'outbound_sends',
  'catalog_item_versions',
  'privacy_notices',
  'consents',
];
/** 03 的两张新表（03 spec「数据库」） */
const CHANNEL_TABLES = ['channel_accounts', 'channel_inbox'];
/** channel_accounts 上 agent_app 只有这几列的 UPDATE（03 spec 的授权表；kind、key、id_prefix、corp_id、open_kfid 改不了） */
const CHANNEL_ACCOUNT_UPDATABLE = [
  'name',
  'status',
  'secrets_ct',
  'secrets_key_id',
  'cursor',
  'cursor_at',
  'record_only_until',
  'settings',
  'updated_at',
];
/** 02 的清除与删除函数（03 加 purge_channel_inbox）各自只授权给谁 */
const PURGE_FNS: Record<string, 'agent_app' | 'agent_platform'> = {
  erase_conversation: 'agent_platform',
  purge_channel_inbox: 'agent_app',
  purge_conversation: 'agent_app',
  purge_expired_traces: 'agent_app',
  purge_finished_jobs: 'agent_app',
};
const TENANT_POLICY = /^\(tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid\)$/;
/**
 * 按系统目录核对迁移的结果，PGlite 与真实 PG 各跑一遍。带 tenant_id 的表是从目录里找出来的，不是写死的清单：
 * 以后新加一张带 tenant_id 却没开 RLS 的表，这里就变红（验收 12 最后一条）
 */
async function schemaChecks(run: Query, label: string): Promise<void> {
  const tables = await run<{ relname: string; owner: string; rls: boolean; force: boolean }>(
    `select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  );
  const names = tables.map((r) => r.relname).join(',');
  check(
    `${label}迁移：01 的七张表加 02 的十二张、03 的两张`,
    names ===
      [
        'audit_log',
        'auth_sessions',
        'catalog_item_versions',
        'catalog_items',
        'channel_accounts',
        'channel_inbox',
        'consents',
        'conversations',
        'guard_events',
        'jobs',
        'memberships',
        'messages',
        'orders',
        'outbound_sends',
        'privacy_notices',
        'quick_replies',
        'sop_versions',
        'tenants',
        'turn_traces',
        'usage_daily',
        'users',
      ].join(','),
    names,
  );
  check(
    `${label}迁移：表的属主都是 agent_owner`,
    tables.every((r) => r.owner === 'agent_owner'),
    tables.map((r) => `${r.relname}=${r.owner}`).join(' '),
  );
  const withTenantCol = await run<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  );
  const policies = await run<{
    relname: string;
    polname: string;
    cmd: string;
    permissive: boolean;
    roles: string;
    qual: string;
    wcheck: string;
  }>(
    `select c.relname, p.polname, p.polcmd::text as cmd, p.polpermissive as permissive, p.polroles::text as roles,
            pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as wcheck
       from pg_policy p join pg_class c on c.oid = p.polrelid order by 1, 2`,
  );
  const found = withTenantCol.map((r) => r.relname);
  check(
    `${label}RLS：目录里找到了已知的五张带 tenant_id 的表`,
    ['audit_log', 'auth_sessions', 'catalog_items', 'memberships', 'sop_versions'].every((x) => found.includes(x)),
    found.join(','),
  );
  check(
    `${label}RLS：02 的十二张新表都带 tenant_id`,
    NEW_TABLES.every((x) => found.includes(x)),
    found.join(','),
  );
  check(
    `${label}RLS：03 的两张新表都带 tenant_id`,
    CHANNEL_TABLES.every((x) => found.includes(x)),
    found.join(','),
  );
  for (const rel of found) {
    const flags = tables.find((x) => x.relname === rel);
    const mine = policies.filter((x) => x.relname === rel);
    if (rel === 'auth_sessions') {
      check(`${label}RLS：auth_sessions 在豁免清单里，不开 RLS`, flags?.rls === false && mine.length === 0);
      continue;
    }
    check(`${label}RLS：${rel} 开了 ENABLE 与 FORCE`, flags?.rls === true && flags.force === true, JSON.stringify(flags));
    // 只有一条策略，对所有命令、所有角色生效，USING 与 WITH CHECK 都是租户模板：同名而内容是 USING (true) 的策略也会被抓出来
    const pol = mine[0];
    check(
      `${label}RLS：${rel} 只有 tenant_isolation 一条策略，套的是租户模板`,
      mine.length === 1 &&
        pol?.polname === 'tenant_isolation' &&
        pol.cmd === '*' &&
        pol.permissive &&
        pol.roles === '{0}' &&
        TENANT_POLICY.test(pol.qual) &&
        pol.wcheck === pol.qual,
      JSON.stringify(mine),
    );
  }
  // 列级授权：真实 PG 的逐格表用 has_table_privilege，只看表级，多出来的列级 GRANT 它看不见。public 下带列级授权的
  // 只能是 tenants 的三个保留期列与品牌列（只给 agent_platform 的 UPDATE，02 spec 授权表），与 channel_accounts 的九列（只给 agent_app 的
  // UPDATE，03 spec 授权表），以及 guard_verdicts（agent_app 的 SELECT、INSERT，04 R8）。按 JS 顺序比。
  const colAcl = await run<{ acl: string }>(
    `select c.relname || '.' || a.attname || ' ' || coalesce(r.rolname, 'PUBLIC') || ' ' || x.privilege_type as acl
       from pg_attribute a join pg_class c on c.oid = a.attrelid
       cross join lateral aclexplode(a.attacl) x
       left join pg_roles r on r.oid = x.grantee
      where c.relnamespace = 'public'::regnamespace and a.attacl is not null
      order by 1`,
  );
  check(
    `${label}授权：列级授权仅为 tenants 保留期/品牌 UPDATE、channel_accounts 九列 UPDATE 与 guard_verdicts SELECT/INSERT`,
    colAcl
      .map((r) => r.acl)
      .toSorted()
      .join(',') ===
      [
        ...['brand', 'retention_customer_days', 'retention_lead_days', 'retention_trace_days'].map(
          (c) => `tenants.${c} agent_platform UPDATE`,
        ),
        ...CHANNEL_ACCOUNT_UPDATABLE.map((c) => `channel_accounts.${c} agent_app UPDATE`),
        'turn_traces.guard_verdicts agent_app INSERT',
        'turn_traces.guard_verdicts agent_app SELECT',
      ]
        .toSorted()
        .join(','),
    colAcl.map((r) => r.acl).join(','),
  );
  // 03 的两个触发器：各一个、BEFORE UPDATE、逐行（tgtype = ROW 1 | BEFORE 2 | UPDATE 16）
  const triggers = await run<{ rel: string; name: string; type: number }>(
    `select c.relname as rel, t.tgname as name, t.tgtype::int as type from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = any($1::text[]) order by 1, 2`,
    [CHANNEL_TABLES],
  );
  check(
    `${label}触发器：channel_accounts、channel_inbox 各一个 BEFORE UPDATE 的逐行触发器`,
    JSON.stringify(triggers) ===
      JSON.stringify([
        { rel: 'channel_accounts', name: 'channel_accounts_guard', type: 19 },
        { rel: 'channel_inbox', name: 'channel_inbox_guard', type: 19 },
      ]),
    JSON.stringify(triggers),
  );
  const fns = await run<{ proname: string; secdef: boolean; acl: string; config: string }>(
    `select proname, prosecdef as secdef, coalesce(proacl::text, '') as acl, coalesce(proconfig::text, '') as config from pg_proc
      where pronamespace = 'public'::regnamespace order by 1`,
  );
  const auth = fns.filter((f) => f.proname.startsWith('auth_'));
  check(`${label}认证函数：五个`, auth.length === 5, auth.map((f) => f.proname).join(','));
  const purge = fns.filter((f) => Object.hasOwn(PURGE_FNS, f.proname)).map((f) => f.proname);
  check(
    `${label}清除与删除函数：五个（02 的四个加 03 的 purge_channel_inbox）`,
    purge.toSorted().join(',') === Object.keys(PURGE_FNS).toSorted().join(','),
    purge.join(','),
  );
  for (const f of fns) {
    // aclitem 里「=X/」开头（被授权者为空）就是 PUBLIC
    const publicExec = /[{,]=X\//.test(f.acl);
    const grantee = Object.hasOwn(PURGE_FNS, f.proname) ? PURGE_FNS[f.proname] : undefined;
    if (f.proname.startsWith('auth_')) {
      check(`${label}认证函数：${f.proname} 是 SECURITY DEFINER`, f.secdef);
      check(`${label}认证函数：${f.proname} 只授权给 agent_app，PUBLIC 不能执行`, f.acl.includes('agent_app=X/') && !publicExec, f.acl);
    } else if (grantee) {
      const other = grantee === 'agent_app' ? 'agent_platform' : 'agent_app';
      check(`${label}清除与删除函数：${f.proname} 是 SECURITY DEFINER`, f.secdef);
      check(
        `${label}清除与删除函数：${f.proname} 只授权给 ${grantee}，${other} 与 PUBLIC 不能执行`,
        f.acl.includes(`${grantee}=X/`) && !f.acl.includes(`${other}=`) && !publicExec,
        f.acl,
      );
    } else {
      check(
        `${label}函数：${f.proname} 不是 SECURITY DEFINER，谁都没被授权执行`,
        !f.secdef && !publicExec && !/agent_(app|platform)=/.test(f.acl),
        f.acl,
      );
    }
    check(
      `${label}函数：${f.proname} 钉死了 search_path，pg_temp 在最后`,
      f.config.includes('search_path=pg_catalog, public, pg_temp'),
      f.config,
    );
  }
}

type DbRole = 'agent_app' | 'agent_platform';
interface PurgeEnv {
  /** 超级用户（绕过 RLS）：造数据、读回 */
  su: Query;
  /** 以 role 在一个事务里执行一条语句；tenant 不为 null 时先在事务内设好租户（与 withTenant 相同） */
  as: <R = Record<string, unknown>>(role: DbRole, tenant: string | null, text: string, params?: unknown[]) => Promise<R[]>;
}

/**
 * 清除与删除函数的行为（02 验收 5 的清除部分，不变量 6、42），PGlite 与真实 PG 各跑一遍。
 * 两个租户的保留期都设成线索 10 天、客户 30 天、trace 7 天（三个各不相同，函数取错了列也查得出；下限是 7 天）。
 * 时间按毫秒造（与应用写入的一样），预期值与库里的 updated_at 逐毫秒相等
 */
async function purgeChecks(env: PurgeEnv, label: string): Promise<void> {
  const { su, as } = env;
  const L = label;
  const BAD_PARAM = '22023';
  const tenant = async (slug: string): Promise<string> =>
    (
      await su<{ id: string }>(
        `insert into tenants (slug, name, pack_id, retention_lead_days, retention_customer_days, retention_trace_days)
         values ($1, $1, 'travel', 10, 30, 7) returning id`,
        [slug],
      )
    )[0]!.id;
  const P = await tenant('purge-a');
  const Q = await tenant('purge-b');
  // 03：入站行（channel_inbox）按 conversation_id 随会话一起清除、删除（不变量 30）；每个租户一个默认企微账号
  const account = async (tenantId: string): Promise<string> =>
    (
      await su<{ id: string }>(
        `insert into channel_accounts (tenant_id, key, kind, name, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
         values ($1, 'kf-main', 'wecom_kf', '主账号', 'wecom:', 'corp-p', 'kf-p', decode(repeat('07', 44), 'hex'), 'k1') returning id`,
        [tenantId],
      )
    )[0]!.id;
  const accountOf = { [P]: await account(P), [Q]: await account(Q) };
  /** 一行入站：没结束的带原文（payload 里有 external_userid），结束的 payload 为空 */
  const inboxRow = (tenantId: string, convId: string, msgid: string, kind = 'message', state = 'received'): Promise<unknown> =>
    su(
      `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, payload)
       values ($1, $2, $3, $4, $5, $6, $7::json)`,
      [
        tenantId,
        accountOf[tenantId],
        msgid,
        kind,
        convId,
        state,
        state === 'received' ? JSON.stringify({ msgid, external_userid: convId.replace(/^wecom:/, '') }) : null,
      ],
    );
  const DAY = 86_400_000;
  const t0 = Date.now();
  const ago = (days: number): string => new Date(t0 - days * DAY).toISOString();
  const nowIso = (shiftMs = 0): string => new Date(Date.now() + shiftMs).toISOString();
  const n = async (text: string, params: unknown[]): Promise<number> => Number((await su<{ n: number }>(text, params))[0]?.n);

  /** 一个会话：last_seq = 消息条数，最后动静在 days 天前；返回 updated_at（毫秒精度的 ISO 串） */
  const conv = async (tenantId: string, id: string, days: number, msgs = 2): Promise<string> => {
    const at = ago(days);
    await su(
      `insert into conversations (tenant_id, id, channel, stage, handed_over, state, last_seq, window_start_seq, created_at, updated_at)
       values ($1, $2, 'wecom', 'discovery', false, $3::json, $4, 1, $5::timestamptz, $5::timestamptz)`,
      [tenantId, id, JSON.stringify({ id, stage: 'discovery' }), msgs, at],
    );
    for (let s = 1; s <= msgs; s++) {
      await su(
        `insert into messages (tenant_id, conversation_id, seq, role, content, at) values ($1, $2, $3, 'customer', $4, $5::timestamptz)`,
        [tenantId, id, s, `第${s}句`, at],
      );
    }
    return at;
  };
  /** 一条 trace 带一个护栏事件；返回 trace id */
  const trace = async (tenantId: string, convId: string, days: number): Promise<string> => {
    const id = randomUUID();
    await su(
      `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
       values ($1, $2, $3, $4::timestamptz, 10, 'replied', repeat('a', 64), '{}', '[]', '[]')`,
      [tenantId, id, convId, ago(days)],
    );
    await su(
      `insert into guard_events (tenant_id, turn_id, ord, guard, action, removed, added) values ($1, $2, 0, 'price', 'replace', '["x"]', '["y"]')`,
      [tenantId, id],
    );
    return id;
  };
  const order = (tenantId: string, id: string, convId: string, paid: boolean): Promise<unknown> =>
    su(
      `insert into orders (tenant_id, id, session_id, route_id, status, total_price, created_at, paid_at, data)
       values ($1, $2, $3, 'r-guizhou', $4, 100, $5::timestamptz, $6::timestamptz, $7::json)`,
      [
        tenantId,
        id,
        convId,
        paid ? 'paid' : 'pending_payment',
        ago(40),
        paid ? ago(39) : null,
        JSON.stringify({ id, sessionId: convId, routeId: 'r-guizhou', totalPrice: 100 }),
      ],
    );
  const send = (tenantId: string, convId: string, msgid: string, days: number): Promise<unknown> =>
    su(
      `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status) values ($1, $2, $3, 'ai', $4::timestamptz, 'accepted')`,
      [tenantId, convId, msgid, ago(days)],
    );
  const consent = (tenantId: string, convId: string): Promise<unknown> =>
    su(
      `insert into consents (tenant_id, conversation_id, category, decision, notice_version, at) values ($1, $2, 'health', 'asked', 1, now())`,
      [tenantId, convId],
    );
  /** 与会话有关的任务：照约定 payload 带 sessionId，dedupe_key 照 spec 带会话 id（followup:<会话>:<阶段>） */
  const sessionJob = (tenantId: string, convId: string, kind: string, status: string): Promise<unknown> =>
    su(
      `insert into jobs (tenant_id, kind, dedupe_key, run_at, status, max_attempts, payload, finished_at)
       values ($1, $2, $3, now(), $4, 3, $5::json, $6::timestamptz)`,
      [
        tenantId,
        kind,
        `${kind}:${convId}:${status}`,
        status,
        JSON.stringify({ sessionId: convId, stage: 'discovery' }),
        ['pending', 'running', 'sending'].includes(status) ? null : ago(1),
      ],
    );
  const jobsOf = (tenantId: string, id: string): Promise<number> =>
    n(`select count(*)::int as n from jobs where tenant_id = $1 and payload->>'sessionId' = $2`, [tenantId, id]);
  const exists = (tenantId: string, id: string): Promise<number> =>
    n('select count(*)::int as n from conversations where tenant_id = $1 and id = $2', [tenantId, id]);
  const inboxOf = (tenantId: string, id: string): Promise<number> =>
    n('select count(*)::int as n from channel_inbox where tenant_id = $1 and conversation_id = $2', [tenantId, id]);
  /** 会话名下还剩的：[会话行, 消息, trace, 这些 trace 的护栏事件, 同意记录, 发送账本] */
  const owned = async (tenantId: string, id: string, traceIds: string[]): Promise<number[]> => [
    await exists(tenantId, id),
    await n('select count(*)::int as n from messages where tenant_id = $1 and conversation_id = $2', [tenantId, id]),
    await n('select count(*)::int as n from turn_traces where tenant_id = $1 and conversation_id = $2', [tenantId, id]),
    await n('select count(*)::int as n from guard_events where tenant_id = $1 and turn_id = any($2::uuid[])', [tenantId, traceIds]),
    await n('select count(*)::int as n from consents where tenant_id = $1 and conversation_id = $2', [tenantId, id]),
    await n('select count(*)::int as n from outbound_sends where tenant_id = $1 and conversation_id = $2', [tenantId, id]),
  ];
  const purgeAs = (
    role: DbRole,
    txTenant: string | null,
    id: string,
    pNow: string | null,
    lastSeq: number,
    updatedAt: string,
  ): Promise<boolean | undefined> =>
    as<{ ok: boolean }>(role, txTenant, 'select purge_conversation($1, $2, $3::timestamptz, $4, $5::timestamptz) as ok', [
      P,
      id,
      pNow,
      lastSeq,
      updatedAt,
    ]).then((r) => r[0]?.ok);
  const purge = (id: string, lastSeq: number, updatedAt: string, pNow = nowIso()): Promise<boolean | undefined> =>
    purgeAs('agent_app', P, id, pNow, lastSeq, updatedAt);

  // ---- 造数据 ----
  // 线索、11 天前：到期。名下有消息、trace（带护栏事件）、同意记录、发送账本、一张没付的订单
  const leadOld = await conv(P, 'lead-old', 11);
  const leadOldTrace = await trace(P, 'lead-old', 11);
  await consent(P, 'lead-old');
  await send(P, 'lead-old', 'm-lead-old', 11);
  await order(P, 'ord_lead_old', 'lead-old', false);
  await sessionJob(P, 'lead-old', 'followup', 'pending');
  await sessionJob(P, 'lead-old', 'handoff_notify', 'done');
  // 03：没结束的客户消息、结束了的回执与进入会话事件，任何状态都随会话删
  await inboxRow(P, 'lead-old', 'in-lead-old-1');
  await inboxRow(P, 'lead-old', 'in-lead-old-2', 'send_fail', 'done');
  await inboxRow(P, 'lead-old', 'in-lead-old-3', 'enter_session', 'done');
  // 别的租户里同一个 id 的会话，同样到期：清 P 的不能碰到它
  await conv(Q, 'lead-old', 11);
  const qTrace = await trace(Q, 'lead-old', 11);
  await send(Q, 'lead-old', 'm-q-lead-old', 11);
  await sessionJob(Q, 'lead-old', 'followup', 'pending');
  await inboxRow(Q, 'lead-old', 'in-q-lead-old');
  // 线索、9 天前：没到期（过了 trace 的 7 天，混用了列就会被清掉）。它有 11 天前、8 天前（过了 trace 的 7 天、没过线索的 10 天）、1 天前的三条 trace，一条 11 天前的发送账本
  const leadNew = await conv(P, 'lead-new', 9);
  const leadNewOldTrace = await trace(P, 'lead-new', 11);
  const leadNewMidTrace = await trace(P, 'lead-new', 8);
  const leadNewTrace = await trace(P, 'lead-new', 1);
  await send(P, 'lead-new', 'm-lead-new', 11);
  await sessionJob(P, 'lead-new', 'followup', 'pending');
  await inboxRow(P, 'lead-new', 'in-lead-new', 'message', 'done');
  // 客户（写过 paid_at）：11 天前按客户保留期没到期；31 天前到期
  const cust11 = await conv(P, 'cust-11', 11);
  await order(P, 'ord_cust_11', 'cust-11', true);
  const cust31 = await conv(P, 'cust-31', 31);
  await order(P, 'ord_cust_31', 'cust-31', true);
  await send(P, 'cust-31', 'm-cust-31', 31);
  await sessionJob(P, 'cust-31', 'followup', 'cancelled');

  // ---- 调用方的租户与 p_now ----
  check(`${L}清除：不在 withTenant 里调用报错`, (await outcome(purgeAs('agent_app', null, 'lead-old', nowIso(), 2, leadOld))) === DENIED);
  check(`${L}清除：事务设的是别的租户时报错`, (await outcome(purgeAs('agent_app', Q, 'lead-old', nowIso(), 2, leadOld))) === DENIED);
  check(`${L}清除：p_now 在 10 分钟之后报错`, (await outcome(purge('lead-new', 2, leadNew, nowIso(10 * 60_000)))) === BAD_PARAM);
  check(`${L}清除：p_now 在 10 分钟之前报错`, (await outcome(purge('lead-new', 2, leadNew, nowIso(-10 * 60_000)))) === BAD_PARAM);
  // 5 分钟这条线：差 6 分钟报错，差 4 分钟照常（没到期，返回 false）
  for (const min of [6, -6]) {
    const r = await outcome(purge('lead-new', 2, leadNew, nowIso(min * 60_000)));
    check(`${L}清除：p_now 差 ${min} 分钟报错`, r === BAD_PARAM, r);
  }
  for (const min of [4, -4]) {
    const r = await purge('lead-new', 2, leadNew, nowIso(min * 60_000)).catch((e: unknown) => pgErr(e)?.code ?? notDb(e));
    check(`${L}清除：p_now 差 ${min} 分钟照常调用`, r === false, String(r));
  }
  check(`${L}清除：p_now 为空报错`, (await outcome(purgeAs('agent_app', P, 'lead-new', null, 2, leadNew))) === BAD_PARAM);
  check(`${L}清除：被拒之后两个会话都还在`, (await exists(P, 'lead-old')) === 1 && (await exists(P, 'lead-new')) === 1);

  // ---- 没到期 ----
  check(`${L}清除：9 天前的线索没到期，返回 false`, (await purge('lead-new', 2, leadNew)) === false);
  check(`${L}清除：11 天前、写过 paid_at 的客户按 30 天算没到期，返回 false`, (await purge('cust-11', 2, cust11)) === false);
  check(
    `${L}清除：没到期的会话与名下的消息原样在`,
    JSON.stringify((await owned(P, 'lead-new', [leadNewOldTrace, leadNewMidTrace, leadNewTrace])).slice(0, 4)) === '[1,2,3,3]' &&
      JSON.stringify((await owned(P, 'cust-11', [])).slice(0, 2)) === '[1,2]',
  );

  // ---- 预期值不符：清理时会话又有了动静 ----
  check(`${L}清除：库里的 last_seq 与预期不符，返回 false`, (await purge('lead-old', 1, leadOld)) === false);
  check(`${L}清除：库里的 updated_at 与预期不符，返回 false`, (await purge('lead-old', 2, ago(12))) === false);
  check(
    `${L}清除：预期值不符时什么都没删`,
    JSON.stringify(await owned(P, 'lead-old', [leadOldTrace])) === '[1,2,1,1,1,1]',
    JSON.stringify(await owned(P, 'lead-old', [leadOldTrace])),
  );
  check(`${L}清除：预期值不符时入站行也都在`, (await inboxOf(P, 'lead-old')) === 3, String(await inboxOf(P, 'lead-old')));

  // ---- 到期 ----
  check(`${L}清除：11 天前的线索到期，返回 true`, (await purge('lead-old', 2, leadOld)) === true);
  check(
    `${L}清除：会话行、消息、trace、护栏事件、同意记录、发送账本都没了`,
    JSON.stringify(await owned(P, 'lead-old', [leadOldTrace])) === '[0,0,0,0,0,0]',
    JSON.stringify(await owned(P, 'lead-old', [leadOldTrace])),
  );
  const [leadOrder] = await su<{ tenant_id: string; session_id: string | null; data: string }>(
    `select tenant_id, session_id, data::text as data from orders where tenant_id = $1 and id = 'ord_lead_old'`,
    [P],
  );
  const leadData = JSON.parse(leadOrder?.data ?? '{}') as Record<string, unknown>;
  check(
    `${L}清除：订单还在，session_id 置空、tenant_id 不变，data 去掉了 sessionId、别的字段都在`,
    leadOrder?.tenant_id === P &&
      leadOrder.session_id === null &&
      !('sessionId' in leadData) &&
      leadData.id === 'ord_lead_old' &&
      leadData.routeId === 'r-guizhou' &&
      leadData.totalPrice === 100,
    JSON.stringify(leadOrder),
  );
  check(
    `${L}清除：别的租户里同 id 的会话、trace、发送账本原样在`,
    JSON.stringify(await owned(Q, 'lead-old', [qTrace])) === '[1,2,1,1,0,1]',
    JSON.stringify(await owned(Q, 'lead-old', [qTrace])),
  );
  check(
    `${L}清除（03）：到期会话的入站行（任何状态）都删了，别的租户同 id 的、没到期会话的都在`,
    (await inboxOf(P, 'lead-old')) === 0 && (await inboxOf(Q, 'lead-old')) === 1 && (await inboxOf(P, 'lead-new')) === 1,
    JSON.stringify([await inboxOf(P, 'lead-old'), await inboxOf(Q, 'lead-old'), await inboxOf(P, 'lead-new')]),
  );
  check(
    `${L}清除：payload.sessionId 是它的任务都删了（pending 与已结束的），别的租户同 id 的、别的会话的都在`,
    (await jobsOf(P, 'lead-old')) === 0 && (await jobsOf(Q, 'lead-old')) === 1 && (await jobsOf(P, 'lead-new')) === 1,
  );
  check(`${L}清除：已经清掉的会话再清一次返回 false`, (await purge('lead-old', 2, leadOld)) === false);
  check(`${L}清除：31 天前的客户到期，返回 true`, (await purge('cust-31', 2, cust31)) === true);
  const [custOrder] = await su<{ session_id: string | null; status: string; paid: boolean; data: string }>(
    `select session_id, status, paid_at is not null as paid, data::text as data from orders where tenant_id = $1 and id = 'ord_cust_31'`,
    [P],
  );
  check(
    `${L}清除：客户的已付订单不受影响，只是 session_id 置空、data 去掉 sessionId`,
    custOrder?.session_id === null && custOrder.status === 'paid' && custOrder.paid && !custOrder.data.includes('sessionId'),
    JSON.stringify(custOrder),
  );
  check(`${L}清除：客户会话的任务（已取消的跟进）也删了`, (await jobsOf(P, 'cust-31')) === 0);

  // ---- 往回改「最后动静」、把已付订单改成取消：都绕不过保留期 ----
  const bumped = await conv(P, 'bumped', 1);
  await su(`update conversations set updated_at = '2000-01-01T00:00:00Z' where tenant_id = $1 and id = 'bumped'`, [P]);
  const [bumpedRow] = await su<{ u: Date }>(`select updated_at as u from conversations where tenant_id = $1 and id = 'bumped'`, [P]);
  check(`${L}触发器：把 updated_at 改成 2000 年被挡回原值`, bumpedRow?.u.toISOString() === bumped, bumpedRow?.u.toISOString());
  check(
    `${L}清除：updated_at 往回改之后仍返回 false，会话还在`,
    (await purge('bumped', 2, bumped)) === false &&
      (await purge('bumped', 2, '2000-01-01T00:00:00.000Z')) === false &&
      (await exists(P, 'bumped')) === 1,
  );
  const cancelled = await conv(P, 'cancelled', 11);
  await order(P, 'ord_cancelled', 'cancelled', true);
  const toCancel = await outcome(as('agent_app', P, `update orders set status = 'cancelled' where id = 'ord_cancelled'`));
  check(`${L}订单：agent_app 能把已付订单改成取消，paid_at 不动`, toCancel === 'ok', toCancel);
  check(
    `${L}清除：已付订单改成取消之后仍按客户算，返回 false`,
    (await purge('cancelled', 2, cancelled)) === false && (await exists(P, 'cancelled')) === 1,
  );
  const clearPaid = await why(as('agent_app', P, `update orders set paid_at = null where id = 'ord_cancelled'`));
  check(`${L}触发器：agent_app 清空 paid_at 报错`, clearPaid === 'trigger', clearPaid);
  const movePaid = await why(as('agent_app', P, `update orders set paid_at = paid_at - interval '1 day' where id = 'ord_cancelled'`));
  check(`${L}触发器：agent_app 改 paid_at 报错`, movePaid === 'trigger', movePaid);
  // 把已付订单从会话上摘下来（置空、改挂到别的会话），会话就成了线索：agent_app 做不到（R20）
  const moved = await conv(P, 'moved', 11);
  await order(P, 'ord_moved', 'moved', true);
  const toNull = await why(as('agent_app', P, `update orders set session_id = null where id = 'ord_moved'`));
  check(`${L}触发器：agent_app 把已付订单的 session_id 置空报错`, toNull === 'trigger', toNull);
  const toOther = await why(as('agent_app', P, `update orders set session_id = 'lead-new' where id = 'ord_moved'`));
  check(`${L}触发器：agent_app 把已付订单改挂到别的会话报错`, toOther === 'trigger', toOther);
  // 与 upsertOrders 同一种写法：除主键外都以这次为准，session_id 写回同一个值
  const upsertMoved = (sessionId: string, status: string): Promise<unknown> =>
    as(
      'agent_app',
      P,
      `insert into orders (tenant_id, id, session_id, route_id, status, total_price, created_at, paid_at, data)
       values ($1, 'ord_moved', $2, 'r-guizhou', $3, 100, $4::timestamptz, $5::timestamptz, $6::json)
       on conflict (tenant_id, id) do update set session_id = excluded.session_id, route_id = excluded.route_id,
         status = excluded.status, total_price = excluded.total_price, created_at = excluded.created_at,
         paid_at = excluded.paid_at, data = excluded.data`,
      [P, sessionId, status, ago(40), ago(39), JSON.stringify({ id: 'ord_moved', sessionId, routeId: 'r-guizhou', totalPrice: 100 })],
    );
  const sameUpsert = await why(upsertMoved('moved', 'cancelled'));
  check(`${L}触发器：agent_app 按 id upsert、session_id 写回同一个值可以`, sameUpsert === 'ok', sameUpsert);
  const otherUpsert = await why(upsertMoved('lead-new', 'paid'));
  check(`${L}触发器：agent_app 经 upsert 改挂到别的会话同样报错`, otherUpsert === 'trigger', otherUpsert);
  const [movedOrder] = await su<{ session_id: string | null; status: string }>(
    `select session_id, status from orders where tenant_id = $1 and id = 'ord_moved'`,
    [P],
  );
  check(
    `${L}清除：摘已付订单被拒之后，订单仍挂在原会话上，11 天前的客户仍返回 false`,
    movedOrder?.session_id === 'moved' &&
      movedOrder.status === 'cancelled' &&
      (await purge('moved', 2, moved)) === false &&
      (await exists(P, 'moved')) === 1,
    JSON.stringify(movedOrder),
  );
  // 外键的 SET NULL 动作以表的属主执行：直接删会话时已付订单照常置空
  await conv(P, 'fk-del', 1);
  await order(P, 'ord_fk_del', 'fk-del', true);
  const fkDel = await outcome(su(`delete from conversations where tenant_id = $1 and id = 'fk-del'`, [P]));
  const [fkOrder] = await su<{ session_id: string | null; paid: boolean }>(
    `select session_id, paid_at is not null as paid from orders where tenant_id = $1 and id = 'ord_fk_del'`,
    [P],
  );
  check(
    `${L}外键：直接删会话时，已付订单的 session_id 照常置空`,
    fkDel === 'ok' && fkOrder?.session_id === null && fkOrder.paid,
    `${fkDel} ${JSON.stringify(fkOrder)}`,
  );

  // ---- trace 与没有会话的发送账本：按 trace 保留期 ----
  await send(P, 'ghost-old', 'm-ghost-old', 11);
  await send(P, 'ghost-mid', 'm-ghost-mid', 8);
  await send(P, 'ghost-new', 'm-ghost-new', 4);
  const traces = (pNow: string | null, txTenant: string | null = P): Promise<{ n: number }[]> =>
    as<{ n: number }>('agent_app', txTenant, 'select purge_expired_traces($1, $2::timestamptz) as n', [P, pNow]);
  check(`${L}清除 trace：p_now 在 10 分钟之后报错`, (await outcome(traces(nowIso(10 * 60_000)))) === BAD_PARAM);
  for (const [what, pNow] of [
    ['差 6 分钟（未来）', nowIso(6 * 60_000)],
    ['差 6 分钟（过去）', nowIso(-6 * 60_000)],
    ['为空', null],
  ] as const) {
    const r = await outcome(traces(pNow));
    check(`${L}清除 trace：p_now ${what}报错`, r === BAD_PARAM, r);
  }
  check(`${L}清除 trace：不在 withTenant 里调用报错`, (await outcome(traces(nowIso(), null))) === DENIED);
  const tr = await traces(nowIso());
  check(`${L}清除 trace：返回删除条数（11 天、8 天前的两条 trace，两条没有会话的过期发送账本）`, tr[0]?.n === 4, JSON.stringify(tr));
  check(
    `${L}清除 trace：过期的 trace 连同护栏事件没了，没过期的 trace 与会话都在`,
    JSON.stringify(await owned(P, 'lead-new', [leadNewOldTrace, leadNewMidTrace])) === '[1,2,1,0,0,1]' &&
      (await n('select count(*)::int as n from turn_traces where tenant_id = $1 and id = $2', [P, leadNewTrace])) === 1,
    JSON.stringify(await owned(P, 'lead-new', [leadNewOldTrace, leadNewMidTrace])),
  );
  const ledger = await su<{ m: string }>('select channel_msgid as m from outbound_sends where tenant_id = $1 order by 1', [P]);
  check(
    `${L}清除 trace：没有会话的发送账本只删过期的，有会话的不动`,
    ledger.map((r) => r.m).join(',') === 'm-ghost-new,m-lead-new',
    ledger.map((r) => r.m).join(','),
  );
  check(
    `${L}清除 trace：别的租户的过期 trace 不动`,
    (await n('select count(*)::int as n from turn_traces where tenant_id = $1', [Q])) === 1,
  );

  // ---- 结束了 30 天的任务 ----
  const job = (tenantId: string, key: string, status: string, finishedDays: number | null): Promise<unknown> =>
    su(
      `insert into jobs (tenant_id, kind, dedupe_key, run_at, status, max_attempts, payload, finished_at)
       values ($1, 'followup', $2, now(), $3, 3, '{}', $4::timestamptz)`,
      [tenantId, key, status, finishedDays === null ? null : ago(finishedDays)],
    );
  for (const s of ['done', 'failed', 'cancelled', 'abandoned']) await job(P, `old-${s}`, s, 31);
  await job(P, 'recent-done', 'done', 29);
  await job(P, 'still-open', 'pending', null);
  await job(Q, 'q-old-done', 'done', 31);
  const jobsAs = (pNow: string | null, txTenant: string | null = P): Promise<{ n: number }[]> =>
    as<{ n: number }>('agent_app', txTenant, 'select purge_finished_jobs($1, $2::timestamptz) as n', [P, pNow]);
  check(`${L}清除任务：p_now 在 10 分钟之后报错`, (await outcome(jobsAs(nowIso(10 * 60_000)))) === BAD_PARAM);
  for (const [what, pNow] of [
    ['差 6 分钟（未来）', nowIso(6 * 60_000)],
    ['差 6 分钟（过去）', nowIso(-6 * 60_000)],
    ['为空', null],
  ] as const) {
    const r = await outcome(jobsAs(pNow));
    check(`${L}清除任务：p_now ${what}报错`, r === BAD_PARAM, r);
  }
  check(`${L}清除任务：不在 withTenant 里调用报错`, (await outcome(jobsAs(nowIso(), null))) === DENIED);
  const pj = await jobsAs(nowIso());
  const leftJobs = await su<{ k: string }>(
    `select dedupe_key as k from jobs where tenant_id = any($1::uuid[]) and payload->>'sessionId' is null order by 1`,
    [[P, Q]],
  );
  check(`${L}清除任务：删掉结束超过 30 天的四种，返回条数`, pj[0]?.n === 4, JSON.stringify(pj));
  check(
    `${L}清除任务：没满 30 天的、没结束的、别的租户的都还在`,
    leftJobs.map((r) => r.k).join(',') === 'q-old-done,recent-done,still-open',
    leftJobs.map((r) => r.k).join(','),
  );
  check(`${L}清除任务：与会话有关、没结束的任务不动`, (await jobsOf(P, 'lead-new')) === 1 && (await jobsOf(Q, 'lead-old')) === 1);

  // ---- 行权删除：只有平台身份能调，不看保留期 ----
  // 企微会话：id 是 wecom:<external_userid>；跟进与转人工通知的 dedupe_key、payload 里都带着它
  const EXT = 'wmEraseQ7f3a9';
  const ERASE = `wecom:${EXT}`;
  const eraseUpdated = await conv(P, ERASE, 0.01, 3);
  const eraseTrace = await trace(P, ERASE, 0.01);
  await consent(P, ERASE);
  await send(P, ERASE, 'm-erase-me', 0.01);
  await order(P, 'ord_erase', ERASE, true);
  await sessionJob(P, ERASE, 'followup', 'pending');
  await sessionJob(P, ERASE, 'handoff_notify', 'running');
  await sessionJob(P, ERASE, 'handoff_notify', 'done');
  // 03：一条还没处理完的客户消息（原文里有 external_userid）、一条处理完的发送失败回执（03 验收 19 的「含 send_fail 行」）
  await inboxRow(P, ERASE, 'in-erase-1');
  await inboxRow(P, ERASE, 'in-erase-2', 'send_fail', 'done');
  /** 全库每张 public 表逐行转成文本找 external_userid，返回找到它的表 */
  const tablesWith = async (needle: string): Promise<{ tables: string[]; hits: string[] }> => {
    const tables = (
      await su<{ t: string }>(
        `select relname as t from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by 1`,
      )
    ).map((r) => r.t);
    const hits: string[] = [];
    for (const tb of tables) {
      const [h] = await su<{ n: number }>(`select count(*)::int as n from public."${tb}" t where t::text like $1`, [`%${needle}%`]);
      if (h?.n) hits.push(tb);
    }
    return { tables, hits };
  };
  const beforeErase = await tablesWith(EXT);
  check(
    `${L}删除之前：全库扫描找得到它（会话、消息、trace、同意记录、发送账本、订单、任务、入站行）`,
    beforeErase.hits.toSorted().join(',') === 'channel_inbox,consents,conversations,jobs,messages,orders,outbound_sends,turn_traces',
    beforeErase.hits.join(','),
  );
  const eraseAs = (role: DbRole, txTenant: string | null, reason: string): Promise<unknown> =>
    as<{ r: unknown }>(role, txTenant, 'select erase_conversation($1, $2, $3) as r', [P, ERASE, reason]).then((r) => r[0]?.r);
  check(`${L}删除：agent_app 调 erase_conversation 报 permission denied`, (await outcome(eraseAs('agent_app', P, '客户要求'))) === DENIED);
  check(
    `${L}删除：agent_platform 调 purge_conversation 报 permission denied`,
    (await outcome(purgeAs('agent_platform', P, ERASE, nowIso(), 3, eraseUpdated))) === DENIED,
  );
  check(
    `${L}删除：agent_platform 调另两个清除函数也报 permission denied`,
    (await outcome(as('agent_platform', P, 'select purge_expired_traces($1, now())', [P]))) === DENIED &&
      (await outcome(as('agent_platform', P, 'select purge_finished_jobs($1, now())', [P]))) === DENIED,
  );
  check(`${L}删除：不在 withTenant 里调用报错`, (await outcome(eraseAs('agent_platform', null, '客户要求'))) === DENIED);
  check(`${L}删除：事务设的是别的租户时报错`, (await outcome(eraseAs('agent_platform', Q, '客户要求'))) === DENIED);
  check(`${L}删除：没写原因报错`, (await outcome(eraseAs('agent_platform', P, '  '))) === BAD_PARAM);
  check(`${L}删除：上面几次被拒之后会话还在`, (await exists(P, ERASE)) === 1 && (await jobsOf(P, ERASE)) === 3);
  const counts = await eraseAs('agent_platform', P, '客户要求删除');
  const wantCounts = {
    conversations: 1,
    messages: 3,
    traces: 1,
    guardEvents: 1,
    consents: 1,
    outboundSends: 1,
    orders: 1,
    jobs: 3,
    inbox: 2,
  };
  check(
    `${L}删除：保留期内的会话也删，返回各类条数（03 加 inbox）`,
    JSON.stringify(counts) === JSON.stringify(wantCounts),
    JSON.stringify(counts),
  );
  check(
    `${L}删除：会话行、消息、trace、护栏事件、同意记录、发送账本、任务（pending、running、done）都没了`,
    JSON.stringify(await owned(P, ERASE, [eraseTrace])) === '[0,0,0,0,0,0]' && (await jobsOf(P, ERASE)) === 0,
  );
  check(`${L}删除（03）：入站行（含 send_fail）都没了`, (await inboxOf(P, ERASE)) === 0, String(await inboxOf(P, ERASE)));
  // 验收 27：库里搜不到它的 external_userid
  const afterErase = await tablesWith(EXT);
  check(
    `${L}验收 27：删除之后全库搜不到它的 external_userid（orders、audit_log、outbound_sends、consents、turn_traces、jobs、channel_inbox 都在扫描之列）`,
    ['orders', 'audit_log', 'outbound_sends', 'consents', 'turn_traces', 'jobs', 'channel_inbox'].every((tb) =>
      afterErase.tables.includes(tb),
    ) && afterErase.hits.length === 0,
    afterErase.hits.join(','),
  );
  const [eraseOrder] = await su<{ session_id: string | null; paid: boolean; data: string }>(
    `select session_id, paid_at is not null as paid, data::text as data from orders where tenant_id = $1 and id = 'ord_erase'`,
    [P],
  );
  check(
    `${L}删除：订单还在、session_id 为空、data 里没有 sessionId`,
    eraseOrder?.session_id === null && eraseOrder.paid && !eraseOrder.data.includes('sessionId'),
    JSON.stringify(eraseOrder),
  );
  const audits = await su<{ actor_kind: string; actor_name: string | null; target_id: string | null; diff: Record<string, unknown> }>(
    `select actor_kind, actor_name, target_id, diff from audit_log where tenant_id = $1 and action = 'platform.erase'`,
    [P],
  );
  const diff = audits[0]?.diff ?? {};
  check(
    `${L}删除：写一行 platform.erase 审计，diff 只有各类条数与原因`,
    audits.length === 1 &&
      audits[0]?.actor_kind === 'platform' &&
      audits[0].target_id === null &&
      Object.keys(diff).toSorted().join(',') === [...Object.keys(wantCounts), 'reason'].toSorted().join(',') &&
      diff.reason === '客户要求删除' &&
      diff.messages === 3 &&
      diff.jobs === 3,
    JSON.stringify(audits),
  );
  // 不变量 42：清除或删除之后，本租户的订单、审计、发送账本、同意记录、trace 里都搜不到它的 id（会话 id 里就是 external_userid）；
  // 任务按验收 27 一并删（payload 带 sessionId 的约定）；03 的表清单加 channel_inbox（03 不变量 30）
  for (const id of ['lead-old', 'cust-31', ERASE]) {
    const hits = await su<{ t: string; n: number }>(
      ['orders', 'audit_log', 'outbound_sends', 'consents', 'turn_traces', 'messages', 'conversations', 'jobs', 'channel_inbox']
        .map((tb) => `select '${tb}' as t, count(*)::int as n from ${tb} x where x.tenant_id = $1 and strpos(x::text, $2) > 0`)
        .join(' union all '),
      [P, id],
    );
    check(
      `${L}不变量 42：${id} 被清除或删除之后，本租户的各表里都搜不到它`,
      hits.length === 9 && hits.every((h) => h.n === 0),
      JSON.stringify(hits.filter((h) => h.n)),
    );
  }
}

/**
 * 03 的两个触发器与 purge_channel_inbox（03 验收 19 的库部分，不变量 8、21），PGlite 与真实 PG 各跑一遍。
 * 触发器以超级用户与 agent_app 各试一遍（触发器对属主、超级用户同样生效）；清理函数的时间按毫秒造，p_now 只能取库的「现在」，
 * 所以到期的行直接写过去的 updated_at、received_at（插入不经触发器）
 */
async function channelChecks(env: PurgeEnv, label: string): Promise<void> {
  const { su, as } = env;
  const L = label;
  const BAD_PARAM = '22023';
  const DAY = 86_400_000;
  const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
  const nowIso = (shiftMs = 0): string => new Date(Date.now() + shiftMs).toISOString();
  const tenant = async (slug: string): Promise<string> =>
    (await su<{ id: string }>(`insert into tenants (slug, name, pack_id) values ($1, $1, 'travel') returning id`, [slug]))[0]!.id;
  const G = await tenant('chan-g');
  const H = await tenant('chan-h');
  const account = async (tenantId: string, key: string, prefix: string): Promise<string> =>
    (
      await su<{ id: string }>(
        `insert into channel_accounts (tenant_id, key, kind, name, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
         values ($1, $2, 'wecom_kf', $2, $3, 'corp-g', $4, decode(repeat('07', 44), 'hex'), 'k1') returning id`,
        [tenantId, key, prefix, `kf-${key}`],
      )
    )[0]!.id;
  const GA = await account(G, 'kf-main', 'wecom:');
  const HA = await account(H, 'kf-main', 'wecom:');

  // ---- channel_accounts：身份五列建好不改，updated_at 由库写 ----
  const acctRow = async (): Promise<Record<string, unknown>> =>
    (
      await su<Record<string, unknown>>(
        `select key, kind, id_prefix, corp_id, open_kfid, name, updated_at from channel_accounts where tenant_id = $1 and id = $2`,
        [G, GA],
      )
    )[0]!;
  const before = await acctRow();
  for (const [col, value] of [
    ['key', 'kf-other'],
    ['kind', 'web'],
    ['id_prefix', 'wecom:kf-main:'],
    ['corp_id', 'corp-x'],
    ['open_kfid', 'kf-x'],
  ] as const) {
    const r = await why(su(`update channel_accounts set ${col} = $3 where tenant_id = $1 and id = $2`, [G, GA, value]));
    check(`${L}触发器（03）：改 channel_accounts.${col} 被拒`, r === 'trigger', r);
  }
  const nulled = await why(su(`update channel_accounts set open_kfid = null where tenant_id = $1 and id = $2`, [G, GA]));
  check(`${L}触发器（03）：把 open_kfid 清空同样被拒`, nulled === 'trigger', nulled);
  const same = await outcome(su(`update channel_accounts set key = key, open_kfid = open_kfid where tenant_id = $1 and id = $2`, [G, GA]));
  check(`${L}触发器（03）：写回同一个值不算改`, same === 'ok', same);
  const rename = await outcome(
    su(`update channel_accounts set name = '新名字', updated_at = '2000-01-01T00:00:00Z' where tenant_id = $1 and id = $2`, [G, GA]),
  );
  const after = await acctRow();
  check(
    `${L}触发器（03）：改名照常，身份五列不变，updated_at 被库写成现在（往回写的值不算）`,
    rename === 'ok' &&
      after.name === '新名字' &&
      ['key', 'kind', 'id_prefix', 'corp_id', 'open_kfid'].every((c) => after[c] === before[c]) &&
      (after.updated_at as Date).getTime() > Date.now() - 60_000,
    `${rename} ${JSON.stringify(after)}`,
  );
  const appRename = await outcome(
    as('agent_app', G, `update channel_accounts set status = 'disabled', cursor = 'c-1' where id = $1`, [GA]),
  );
  check(`${L}触发器（03）：agent_app 停用账号、推进 cursor 照常`, appRename === 'ok', appRename);

  // ---- channel_inbox：终态不回退、payload 不复活、updated_at 改不回去 ----
  const inbox = async (
    msgid: string,
    state: string,
    over: { reason?: string; updated?: string; received?: string; tenantId?: string } = {},
  ) =>
    (
      await su<{ id: string }>(
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, reason, payload, received_at, updated_at)
         values ($1, $2, $3, 'message', 'wecom:wmChan1', $4, $5, $6::json, coalesce($7::timestamptz, now()), coalesce($8::timestamptz, now()))
         returning id`,
        [
          over.tenantId ?? G,
          over.tenantId === H ? HA : GA,
          msgid,
          state,
          over.reason ?? (state === 'abandoned' ? 'poison' : null),
          ['done', 'abandoned'].includes(state) ? null : JSON.stringify({ msgid, text: '原文' }),
          over.received ?? null,
          over.updated ?? null,
        ],
      )
    )[0]!.id;
  const row = async (id: string): Promise<{ state: string; reason: string | null; payload: unknown; attempts: number; updated_at: Date }> =>
    (
      await su<{ state: string; reason: string | null; payload: unknown; attempts: number; updated_at: Date }>(
        `select state, reason, payload, attempts, updated_at from channel_inbox where id = $1`,
        [id],
      )
    )[0]!;
  const done = await inbox('trg-done', 'done');
  const abandoned = await inbox('trg-abandoned', 'abandoned');
  for (const [what, id, text] of [
    ['done 改回 received', done, `update channel_inbox set state = 'received' where id = $1`],
    ['done 写回 payload', done, `update channel_inbox set payload = '{"text":"原文"}' where id = $1`],
    ['done 只加计次', done, `update channel_inbox set attempts = attempts + 1 where id = $1`],
    ['abandoned 改成 done', abandoned, `update channel_inbox set state = 'done', reason = null where id = $1`],
    ['abandoned 往回改 updated_at', abandoned, `update channel_inbox set updated_at = '2000-01-01T00:00:00Z' where id = $1`],
  ] as const) {
    const r = await why(su(text, [id]));
    check(`${L}触发器（03）：${what}被拒`, r === 'trigger', r);
    const viaApp = await why(as('agent_app', G, text, [id]));
    check(`${L}触发器（03）：agent_app ${what}同样被拒`, viaApp === 'trigger', viaApp);
  }
  check(
    `${L}触发器（03）：被拒之后终态行原样（state、payload 为空）`,
    (await row(done)).state === 'done' && (await row(done)).payload === null && (await row(abandoned)).state === 'abandoned',
  );
  const open = await inbox('trg-open', 'received');
  const backdate = await outcome(as('agent_app', G, `update channel_inbox set updated_at = '2000-01-01T00:00:00Z' where id = $1`, [open]));
  const openRow = await row(open);
  check(
    `${L}触发器（03）：没结束的行 agent_app 往回改 updated_at 不报错、被库写成现在`,
    backdate === 'ok' && openRow.updated_at.getTime() > Date.now() - 60_000,
    `${backdate} ${openRow.updated_at.toISOString()}`,
  );
  const toDone = await outcome(as('agent_app', G, `update channel_inbox set state = 'done', payload = null where id = $1`, [open]));
  check(`${L}触发器（03）：没结束的行可以结束`, toDone === 'ok' && (await row(open)).state === 'done', toDone);

  // ---- purge_channel_inbox（03 R2、验收 19）----
  const ids = {
    doneOld: await inbox('pg-done-8d', 'done', { updated: ago(8), received: ago(9) }),
    abandonedOld: await inbox('pg-abandoned-8d', 'abandoned', { updated: ago(8), received: ago(9) }),
    doneRecent: await inbox('pg-done-6d', 'done', { updated: ago(6), received: ago(8) }),
    receivedOld: await inbox('pg-received-8d', 'received', { received: ago(8) }),
    recordedOld: await inbox('pg-recorded-8d', 'recorded', { received: ago(8) }),
    repliedOld: await inbox('pg-replied-8d', 'replied', { received: ago(8) }),
    receivedRecent: await inbox('pg-received-6d', 'received', { received: ago(6) }),
    otherTenant: await inbox('pg-h-done-8d', 'done', { updated: ago(8), received: ago(9), tenantId: H }),
  };
  const purgeAs = (role: DbRole, txTenant: string | null, pNow: string | null): Promise<{ n: number }[]> =>
    as<{ n: number }>(role, txTenant, 'select purge_channel_inbox($1, $2::timestamptz) as n', [G, pNow]);
  check(`${L}清除入站（03）：不在 withTenant 里调用报错`, (await outcome(purgeAs('agent_app', null, nowIso()))) === DENIED);
  check(`${L}清除入站（03）：事务设的是别的租户时报错`, (await outcome(purgeAs('agent_app', H, nowIso()))) === DENIED);
  for (const [what, pNow] of [
    ['差 6 分钟（未来）', nowIso(6 * 60_000)],
    ['差 6 分钟（过去）', nowIso(-6 * 60_000)],
    ['为空', null],
  ] as const) {
    const r = await outcome(purgeAs('agent_app', G, pNow));
    check(`${L}清除入站（03）：p_now ${what}报错`, r === BAD_PARAM, r);
  }
  check(`${L}清除入站（03）：agent_platform 调用报 permission denied`, (await outcome(purgeAs('agent_platform', G, nowIso()))) === DENIED);
  const left = async (): Promise<string> =>
    (
      await su<{ m: string; s: string; p: boolean }>(
        `select msgid as m, state as s, payload is null as p from channel_inbox where account_id = any($1::uuid[]) and msgid like 'pg-%'`,
        [[GA, HA]],
      )
    )
      .map((r) => `${r.m}:${r.s}${r.p ? '' : '+payload'}`)
      .toSorted()
      .join(',');
  check(
    `${L}清除入站（03）：被拒的几次什么都没动`,
    (await left()) ===
      'pg-abandoned-8d:abandoned,pg-done-6d:done,pg-done-8d:done,pg-h-done-8d:done,pg-received-6d:received+payload,pg-received-8d:received+payload,pg-recorded-8d:recorded+payload,pg-replied-8d:replied+payload',
    await left(),
  );
  const purged = await purgeAs('agent_app', G, nowIso());
  check(`${L}清除入站（03）：返回两类条数之和（删 2 条、记 abandoned 3 条）`, purged[0]?.n === 5, JSON.stringify(purged));
  check(
    `${L}清除入站（03）：结束超过 7 天的删了；6 天前结束的、6 天前收到没结束的、别的租户的都在；收到超过 7 天还没结束的记 abandoned、原文清空`,
    (await left()) ===
      'pg-done-6d:done,pg-h-done-8d:done,pg-received-6d:received+payload,pg-received-8d:abandoned,pg-recorded-8d:abandoned,pg-replied-8d:abandoned',
    await left(),
  );
  const tooOld = await row(ids.receivedOld);
  check(
    `${L}清除入站（03）：超期记 abandoned 的原因是 too_old，updated_at 是现在（再留 7 天）`,
    tooOld.reason === 'too_old' && tooOld.updated_at.getTime() > Date.now() - 60_000,
    JSON.stringify(tooOld),
  );
  const again = await purgeAs('agent_app', G, nowIso());
  check(`${L}清除入站（03）：马上再跑一次什么都不动、返回 0`, again[0]?.n === 0, JSON.stringify(again));
}

// ---------------- 迁移 ----------------
{
  const journal = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  const applied = async (): Promise<number> =>
    Number((await q<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations'))[0]?.n);
  check('迁移：openTestDb 之后 journal 里每一条都已应用', (await applied()) === journal.entries.length, String(await applied()));
  check('迁移：再跑一遍不报错', (await outcome(t.migrate())) === 'ok');
  check('迁移：再跑一遍什么都不做', (await applied()) === journal.entries.length, String(await applied()));

  await schemaChecks(q, '');
}

// ---------------- 02：条目版本的按租户回填 ----------------
// 先只跑到 01 的两个迁移、造 01 时期的产品库，再跑全部：FORCE 之下属主也只看得到设了租户的行，回填要按租户逐个做
{
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const { MIGRATIONS_DIR } = await import('./migrate.js');
  const pg2 = new PGlite();
  const dbName = (await pg2.query<{ d: string }>('select current_database() as d')).rows[0]!.d;
  await pg2.exec(`
    CREATE ROLE agent_owner    LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
    CREATE ROLE agent_app      LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    CREATE ROLE agent_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    ALTER DATABASE "${dbName}" OWNER TO agent_owner;
  `);
  const full = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const staged = fs.mkdtempSync(path.join(process.env.VAR_DIR!, 'migrations-01-'));
  fs.mkdirSync(path.join(staged, 'meta'));
  const upto01 = { ...full, entries: full.entries.filter((e) => e.tag === '0000_init' || e.tag === '0001_rls_auth') };
  fs.writeFileSync(path.join(staged, 'meta', '_journal.json'), JSON.stringify(upto01));
  for (const e of upto01.entries) fs.copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(staged, `${e.tag}.sql`));
  const d2 = drizzle(pg2);
  const migrateAsOwner = async (folder: string): Promise<void> => {
    await pg2.exec('SET ROLE agent_owner');
    try {
      await migrate(d2, { migrationsFolder: folder });
    } finally {
      await pg2.exec('RESET ROLE');
    }
  };
  await migrateAsOwner(staged);
  const q2 = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    (await pg2.query<R>(text, params)).rows;
  const [{ id: X }] = await q2<{ id: string }>(`insert into tenants (slug, name, pack_id) values ('old-x', 'X', 'travel') returning id`);
  const [{ id: Y }] = await q2<{ id: string }>(`insert into tenants (slug, name, pack_id) values ('old-y', 'Y', 'travel') returning id`);
  // 键序与空白都不是规范形式：回填必须原样拷 json 的文本
  const payloadText = '{"id":"r-x1", "zeta":1,"alpha":{"yy":2,"bb":[3,{"z":1,"a":2}]}}';
  const item = (
    tenantId: string,
    kind: string,
    code: string,
    ord: number,
    status: string,
    payload = `{"id":"${code}"}`,
  ): Promise<unknown> =>
    q2(`insert into catalog_items (tenant_id, kind, code, ord, status, payload) values ($1, $2, $3, $4, $5, $6::json)`, [
      tenantId,
      kind,
      code,
      ord,
      status,
      payload,
    ]);
  await item(X, 'route', 'r-x1', 0, 'active', payloadText);
  await item(X, 'route', 'r-x2', 1, 'draft');
  await item(X, 'hotel', 'h-x1', 0, 'active');
  await item(Y, 'route', 'r-y1', 0, 'active');
  check(
    '回填：01 时期的库上跑到 0001 为止',
    (await q2('select 1 from pg_class where relname = $1', ['catalog_item_versions'])).length === 0,
  );
  check('回填：在 01 的库上跑完全部迁移不报错', (await outcome(migrateAsOwner(MIGRATIONS_DIR))) === 'ok');
  const versions = await q2<{ slug: string; kind: string; code: string; version: number; source: string; payload: string; same: boolean }>(
    `select t.slug, v.kind, v.code, v.version, v.source, v.payload::text as payload, v.payload::text = i.payload::text as same
       from catalog_item_versions v join tenants t on t.id = v.tenant_id
       join catalog_items i on i.tenant_id = v.tenant_id and i.kind = v.kind and i.code = v.code
      order by t.slug, v.kind, v.code`,
  );
  check(
    '回填：每个租户的每个 active 条目各写一行版本 1（source=backfill），草稿不写',
    versions.map((v) => `${v.slug}/${v.kind}/${v.code}@${v.version}:${v.source}`).join(',') ===
      'old-x/hotel/h-x1@1:backfill,old-x/route/r-x1@1:backfill,old-y/route/r-y1@1:backfill',
    JSON.stringify(versions),
  );
  check(
    '回填：版本的 payload 与条目的 json 文本逐字节相同',
    versions.every((v) => v.same) && versions.some((v) => v.payload === payloadText),
    JSON.stringify(versions.map((v) => v.payload)),
  );
  const itemVersions = await q2<{ v: number }>('select distinct version as v from catalog_items');
  check('回填：已有条目的 catalog_items.version 都是 1', JSON.stringify(itemVersions) === '[{"v":1}]', JSON.stringify(itemVersions));
  const [kept] = await q2<{ lead: number; customer: number; trace: number }>(
    `select retention_lead_days as lead, retention_customer_days as customer, retention_trace_days as trace from tenants where id = $1`,
    [X],
  );
  check(
    '迁移：已有租户的三个保留期列取默认值 180、730、90',
    kept?.lead === 180 && kept.customer === 730 && kept.trace === 90,
    JSON.stringify(kept),
  );
  const [n] = await q2<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations');
  check('回填：分两段跑完，journal 里每一条各应用一次', n?.n === full.entries.length, String(n?.n));
  await pg2.close();
}

// ---------------- 03：从 02 的库升上来 ----------------
// 先跑到 02 的最后一个迁移、按 02 的写法造会话与四种结果的发送账本，再跑全部：换 status 的 CHECK、新加的 CHECK 与外键都要让
// 旧行原样通过（迁移 lint 标注里写的「旧镜像写的值都在新集合里」「新列为空或取默认值」），新列取空或缺省值；
// 改写之后的清除函数照常删 02 的会话
{
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const { MIGRATIONS_DIR } = await import('./migrate.js');
  const pg3 = new PGlite();
  const dbName = (await pg3.query<{ d: string }>('select current_database() as d')).rows[0]!.d;
  await pg3.exec(`
    CREATE ROLE agent_owner    LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
    CREATE ROLE agent_app      LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    CREATE ROLE agent_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    ALTER DATABASE "${dbName}" OWNER TO agent_owner;
  `);
  const full = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const staged = fs.mkdtempSync(path.join(process.env.VAR_DIR!, 'migrations-02-'));
  fs.mkdirSync(path.join(staged, 'meta'));
  const upto02 = { ...full, entries: full.entries.filter((e) => e.idx <= 3) };
  check('03 升级：02 的最后一个迁移是 0003_conversations_rls', upto02.entries.at(-1)?.tag === '0003_conversations_rls');
  fs.writeFileSync(path.join(staged, 'meta', '_journal.json'), JSON.stringify(upto02));
  for (const e of upto02.entries) fs.copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(staged, `${e.tag}.sql`));
  const d3 = drizzle(pg3);
  const migrateAsOwner = async (folder: string): Promise<void> => {
    await pg3.exec('SET ROLE agent_owner');
    try {
      await migrate(d3, { migrationsFolder: folder });
    } finally {
      await pg3.exec('RESET ROLE');
    }
  };
  await migrateAsOwner(staged);
  const q3 = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    (await pg3.query<R>(text, params)).rows;
  const [{ id: Z }] = await q3<{ id: string }>(
    `insert into tenants (slug, name, pack_id, retention_lead_days) values ('old-z', 'Z', 'travel', 10) returning id`,
  );
  const old = new Date(Date.now() - 11 * 86_400_000).toISOString();
  await q3(
    `insert into conversations (tenant_id, id, channel, stage, handed_over, state, last_seq, created_at, updated_at)
     values ($1, 'wecom:wmUp1', 'wecom', 'greeting', false, '{"id":"wecom:wmUp1"}', 0, $2::timestamptz, $2::timestamptz)`,
    [Z, old],
  );
  for (const [msgid, status] of [
    ['up-acc', 'accepted'],
    ['up-rej', 'rejected'],
    ['up-unk', 'unknown'],
    ['up-fai', 'failed'],
  ]) {
    await q3(
      `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status) values ($1, 'wecom:wmUp1', $2, 'ai', $3::timestamptz, $4)`,
      [Z, msgid, old, status],
    );
  }
  const upgraded = await outcome(migrateAsOwner(MIGRATIONS_DIR));
  check('03 升级：02 的库上带着四种状态的发送账本跑 03 的迁移，不报错', upgraded === 'ok', upgraded);
  const rows = await q3<{ m: string; status: string; a: string | null; i: string | null; seg: number; att: number; p: unknown }>(
    `select channel_msgid as m, status, account_id as a, inbox_id as i, segment as seg, attempts as att, payload as p
       from outbound_sends where tenant_id = $1 order by 1`,
    [Z],
  );
  check(
    '03 升级：旧的账本行原样（状态不变），新列为空或缺省值',
    JSON.stringify(rows.map((r) => [r.m, r.status, r.a, r.i, r.seg, r.att, r.p])) ===
      JSON.stringify([
        ['up-acc', 'accepted', null, null, 0, 0, null],
        ['up-fai', 'failed', null, null, 0, 0, null],
        ['up-rej', 'rejected', null, null, 0, 0, null],
        ['up-unk', 'unknown', null, null, 0, 0, null],
      ]),
    JSON.stringify(rows),
  );
  const [conv] = await q3<{ a: string | null }>(`select channel_account_id as a from conversations where tenant_id = $1`, [Z]);
  check('03 升级：已有会话的 channel_account_id 为空（默认账号）', conv !== undefined && conv.a === null, JSON.stringify(conv));
  // 改写之后的 purge_conversation：签名不变，旧镜像那样调用照常删 02 的会话与它的账本
  await pg3.exec('SET ROLE agent_app');
  let purgedOld: boolean | undefined;
  try {
    purgedOld = await pg3.transaction(async (tx) => {
      await tx.query(`select set_config('app.tenant_id', $1, true)`, [Z]);
      return (await tx.query<{ ok: boolean }>(`select purge_conversation($1, 'wecom:wmUp1', now(), 0, $2::timestamptz) as ok`, [Z, old]))
        .rows[0]?.ok;
    });
  } finally {
    await pg3.exec('RESET ROLE');
  }
  const [leftUp] = await q3<{ n: number }>(`select count(*)::int as n from outbound_sends where tenant_id = $1`, [Z]);
  check(
    '03 升级：改写之后的 purge_conversation 以 02 的签名调用照常清除',
    purgedOld === true && leftUp?.n === 0,
    JSON.stringify({ purgedOld, leftUp }),
  );
  await pg3.close();
}

// ---------------- 造数据 ----------------
const [{ id: A }] = await q<{ id: string }>(`insert into tenants (slug, name, pack_id) values ('tenant-a', 'A', 'travel') returning id`);
const [{ id: B }] = await q<{ id: string }>(`insert into tenants (slug, name, pack_id) values ('tenant-b', 'B', 'travel') returning id`);
const [{ id: U }] = await q<{ id: string }>(
  `insert into users (email, display_name, password_hash) values ('Ops@Example.com', '运营', 'scrypt$old') returning id`,
);
await q(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'admin')`, [A, U]);

/** 一个自洽的已发布版本：三个哈希按 CHECK 的算法对得上 */
function released(text: string) {
  const rendered = `【SOP】${text}\n【硬性要求】`;
  const promptHash = sha(rendered);
  const toolsHash = sha('[]');
  return {
    rendered,
    promptHash,
    toolsHash,
    prefixHash: sha(toolsHash + promptHash),
    sopHash: sha(text),
    renderInputs: JSON.stringify({ hardRulesHash: sha('h'), imageSopHash: sha('i'), sectionTableHash: sha('s'), toolsHash }),
  };
}
const SECTIONS = JSON.stringify([{ key: 'preamble', text: '# SOP\n\n' }]);
type PublishedOver = Partial<{
  status: string;
  source: string;
  versionNo: number | null;
  promptHash: string;
  prefixHash: string;
  toolsHash: string;
  sopHash: string;
}>;
function insertPublished(tenantId: string, versionNo: number | null, over: PublishedOver = {}, text = `v${versionNo}`): Promise<unknown> {
  const r = released(text);
  // 改 prompt_hash 或 tools_hash 时 prefix_hash 跟着它们算，保证被拒的只可能是改的那一项
  const promptHash = over.promptHash ?? r.promptHash;
  const toolsHash = over.toolsHash ?? r.toolsHash;
  const prefixHash = over.prefixHash ?? sha(toolsHash + promptHash);
  return q(
    `insert into sop_versions (tenant_id, version_no, status, source, pack_id, sections, rendered_prompt, prompt_hash, tools_hash,
                               prefix_hash, sop_hash, render_inputs, published_at)
     values ($1, $2, $3, $4, 'travel', $5, $6, $7, $8, $9, $10, $11, now())`,
    [
      tenantId,
      over.versionNo === undefined ? versionNo : over.versionNo,
      over.status ?? 'published',
      over.source ?? 'import',
      SECTIONS,
      r.rendered,
      promptHash,
      toolsHash,
      prefixHash,
      over.sopHash ?? r.sopHash,
      r.renderInputs,
    ],
  );
}
const versionId = async (tenantId: string, versionNo: number): Promise<string> =>
  (await q<{ id: string }>('select id from sop_versions where tenant_id = $1 and version_no = $2', [tenantId, versionNo]))[0]!.id;
const snapshot = async (id: string): Promise<string> =>
  JSON.stringify((await q<{ j: unknown }>('select to_jsonb(s) as j from sop_versions s where id = $1', [id]))[0]?.j);

// ---------------- 约束 ----------------
check(
  `约束：tenants.slug 不收大写`,
  (await outcome(q(`insert into tenants (slug, name, pack_id) values ('Tenant-C', 'C', 'travel')`))) === CHECK,
);
check(
  `约束：tenants.slug 至少两个字符`,
  (await outcome(q(`insert into tenants (slug, name, pack_id) values ('c', 'C', 'travel')`))) === CHECK,
);
check(
  `约束：tenants.status 只有三种`,
  (await outcome(q(`insert into tenants (slug, name, pack_id, status) values ('tenant-c', 'C', 'travel', 'paused')`))) === CHECK,
);
check(
  `约束：users 的邮箱按 lower() 唯一`,
  (await outcome(q(`insert into users (email, display_name, password_hash) values ('ops@EXAMPLE.com', 'x', 'y')`))) === UNIQUE,
);
check(
  `约束：memberships.role 只有五种`,
  (await outcome(q(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'root')`, [B, U]))) === CHECK,
);
check(
  `约束：auth_sessions.token_hash 必须 32 字节`,
  (await outcome(
    q(
      `insert into auth_sessions (token_hash, tenant_id, user_id, created_at, last_seen_at, expires_at) values ($1, $2, $3, now(), now(), now())`,
      [randomBytes(31), A, U],
    ),
  )) === CHECK,
);
check(
  `约束：audit_log.actor_kind 只有三种`,
  (await outcome(q(`insert into audit_log (tenant_id, actor_kind, action) values ($1, 'bot', 'x')`, [A]))) === CHECK,
);

{
  const cases: [string, Promise<unknown>, string][] = [
    ['prompt_hash 与 rendered_prompt 不符', insertPublished(A, 1, { promptHash: sha('别的') }), 'sop_versions_prompt_hash_matches'],
    ['prefix_hash 与 tools_hash‖prompt_hash 不符', insertPublished(A, 1, { prefixHash: sha('别的') }), 'sop_versions_prefix_hash_matches'],
    ['tools_hash 不是小写十六进制', insertPublished(A, 1, { toolsHash: sha('[]').toUpperCase() }), 'sop_versions_tools_hash_check'],
    ['sop_hash 不是十六进制', insertPublished(A, 1, { sopHash: 'z'.repeat(64) }), 'sop_versions_sop_hash_check'],
    ['已发布版本没有版本号', insertPublished(A, 1, { versionNo: null }), 'sop_versions_version_no_iff_released'],
    ['版本号不大于 0', insertPublished(A, 0), 'sop_versions_version_no_check'],
  ];
  for (const [what, p, constraint] of cases) {
    const got = await why(p);
    check(`约束：${what} 被 ${constraint} 拒`, got === constraint, got);
  }
}
{
  const r = released('x');
  const partial = await outcome(
    q(
      `insert into sop_versions (tenant_id, version_no, status, source, pack_id, sections, rendered_prompt, prompt_hash, tools_hash, prefix_hash, sop_hash)
       values ($1, 1, 'published', 'import', 'travel', $2, $3, $4, $5, $6, $7)`,
      [A, SECTIONS, r.rendered, r.promptHash, r.toolsHash, r.prefixHash, r.sopHash],
    ),
  );
  check('约束：渲染结果与四个哈希、render_inputs 要么全有要么全无', partial === CHECK, partial);
  // 渲染结果六项齐全、自洽，只错在状态上：只有 prompt_iff_released 拦得住
  const draftWithPrompt = await why(
    q(
      `insert into sop_versions (tenant_id, status, source, pack_id, sections, rendered_prompt, prompt_hash, tools_hash, prefix_hash, sop_hash, render_inputs)
       values ($1, 'draft', 'console', 'travel', $2, $3, $4, $5, $6, $7, $8)`,
      [A, SECTIONS, r.rendered, r.promptHash, r.toolsHash, r.prefixHash, r.sopHash, r.renderInputs],
    ),
  );
  check('约束：草稿没有渲染结果', draftWithPrompt === 'sop_versions_prompt_iff_released', draftWithPrompt);
  const publishedBare = await why(
    q(
      `insert into sop_versions (tenant_id, version_no, status, source, pack_id, sections) values ($1, 1, 'published', 'import', 'travel', $2)`,
      [A, SECTIONS],
    ),
  );
  check('约束：已发布版本必须有渲染结果', publishedBare === 'sop_versions_prompt_iff_released', publishedBare);
}

// 产品库条目：payload 是对象、id 等于 code
const insertItem = (tenantId: string, kind: string, code: string, ord: number, payload: unknown): Promise<unknown> =>
  q(`insert into catalog_items (tenant_id, kind, code, ord, payload) values ($1, $2, $3, $4, $5::json)`, [
    tenantId,
    kind,
    code,
    ord,
    JSON.stringify(payload),
  ]);
check('约束：payload.id 必须等于 code', (await why(insertItem(A, 'route', 'r-a', 0, { id: 'r-b' }))) === 'catalog_items_payload_check');
check('约束：payload 没有 id 被拒', (await why(insertItem(A, 'route', 'r-a', 0, { title: 'x' }))) === 'catalog_items_payload_check');
check('约束：payload 必须是对象', (await why(insertItem(A, 'route', 'r-a', 0, ['r-a']))) === 'catalog_items_payload_check');
check('约束：code 不收大写', (await why(insertItem(A, 'route', 'R-A', 0, { id: 'R-A' }))) === 'catalog_items_code_check');
check('约束：kind 只有 route 与 hotel', (await why(insertItem(A, 'visa', 'v-a', 0, { id: 'v-a' }))) === 'catalog_items_kind_check');
check(
  '约束：status 只有 draft 与 active',
  (await why(
    q(
      `insert into catalog_items (tenant_id, kind, code, ord, payload, status) values ($1, 'route', 'r-s', 7, '{"id":"r-s"}', 'archived')`,
      [A],
    ),
  )) === 'catalog_items_status_check',
);
check('约束：合法条目能插入', (await outcome(insertItem(A, 'route', 'r-a', 0, { id: 'r-a' }))) === 'ok');
check(
  '约束：同租户同 kind 的 code 唯一',
  (await why(insertItem(A, 'route', 'r-a', 1, { id: 'r-a' }))) === 'catalog_items_tenant_kind_code_uq',
);
check(
  '约束：同租户同 kind 的 ord 唯一',
  (await why(insertItem(A, 'route', 'r-b', 0, { id: 'r-b' }))) === 'catalog_items_tenant_kind_ord_uq',
);
check('约束：code 与 ord 在别的 kind 下可以重复', (await outcome(insertItem(A, 'hotel', 'r-a', 0, { id: 'r-a' }))) === 'ok');
check('约束：code 与 ord 在别的租户下可以重复', (await outcome(insertItem(B, 'route', 'r-a', 0, { id: 'r-a' }))) === 'ok');

// json 列原样保存输入文本：经 drizzle 写入、读回，键序与嵌套键序都不变（spec「产品库 · 存储」）
{
  const payload = { id: 'r-order', title: '键序', zeta: 1, alpha: { yy: 2, bb: [3, { z: 1, a: 2 }] }, overseas: false };
  await asApp(A, (tx) => tx.insert(catalogItems).values({ tenantId: A, kind: 'route', code: 'r-order', ord: 9, payload }));
  const [row] = await asApp(A, (tx) =>
    tx.select().from(catalogItems).where(eq(catalogItems.code, 'r-order')).orderBy(asc(catalogItems.ord)),
  );
  check(
    'json：经 drizzle 读回的 payload 键序与写入时逐字节相同',
    JSON.stringify(row?.payload) === JSON.stringify(payload),
    JSON.stringify(row?.payload),
  );
}

// ---------------- sop_versions 的两个触发器（验收 7） ----------------
check('触发器：导入的已发布版本能插入', (await outcome(insertPublished(A, 1))) === 'ok');
const v1 = await versionId(A, 1);
{
  const before = await snapshot(v1);
  const attempts: [string, SQL][] = [
    ['UPDATE sections', sql`update sop_versions set sections = '[]'::jsonb where id = ${v1}`],
    ['UPDATE rendered_prompt', sql`update sop_versions set rendered_prompt = 'x', prompt_hash = ${sha('x')} where id = ${v1}`],
    ['UPDATE version_no', sql`update sop_versions set version_no = 7 where id = ${v1}`],
    ['published → draft', sql`update sop_versions set status = 'draft', version_no = null where id = ${v1}`],
    ['published → discarded', sql`update sop_versions set status = 'discarded' where id = ${v1}`],
  ];
  for (const [what, stmt] of attempts) {
    const got = await why(asApp(A, (tx) => tx.execute(stmt)));
    check(`触发器：agent_app 对已发布版本 ${what} 报错`, got === 'trigger', got);
  }
  check('触发器：上面这些都没改动那一行', (await snapshot(v1)) === before);
  const del = await outcome(asApp(A, (tx) => tx.execute(sql`delete from sop_versions where id = ${v1}`)));
  check('权限：agent_app 删除版本报 permission denied', del === DENIED, del);
}
check('触发器：直接插入 archived 被拒', (await why(insertPublished(A, 5, { status: 'archived' }))) === 'trigger');
check('触发器：source=console 的已发布版本被拒', (await why(insertPublished(A, 5, { source: 'console' }))) === 'trigger');
{
  const draft = (tenantId: string, source: string, extra = ''): Promise<unknown> =>
    q(
      `insert into sop_versions (tenant_id, status, source, pack_id, sections${extra ? ', version_no' : ''})
       values ($1, 'draft', $2, 'travel', $3${extra ? `, ${extra}` : ''})`,
      [tenantId, source, SECTIONS],
    );
  check('触发器：source=import 的草稿被拒', (await why(draft(A, 'import'))) === 'trigger');
  check('触发器：带版本号的草稿被拒', (await why(draft(A, 'console', '3'))) === 'trigger');
  check(
    '触发器：直接插入 discarded 被拒',
    (await why(
      q(`insert into sop_versions (tenant_id, status, source, pack_id, sections) values ($1, 'discarded', 'console', 'travel', $2)`, [
        A,
        SECTIONS,
      ]),
    )) === 'trigger',
  );

  // 后台草稿：agent_app 在自己的租户里新建、修改
  const created = await outcome(
    asApp(A, (tx) =>
      tx.execute(sql`insert into sop_versions (tenant_id, status, source, pack_id, sections, based_on)
                     values (${A}, 'draft', 'console', 'travel', ${SECTIONS}::jsonb, ${v1})`),
    ),
  );
  check('触发器：agent_app 能新建后台草稿', created === 'ok', created);
  const [{ id: d1 }] = await q<{ id: string }>(`select id from sop_versions where tenant_id = $1 and status = 'draft'`, [A]);
  const rev = async (): Promise<number> => (await q<{ rev: number }>('select rev from sop_versions where id = $1', [d1]))[0]!.rev;
  await asApp(A, (tx) => tx.execute(sql`update sop_versions set change_note = '改一句' where id = ${d1}`));
  check('触发器：改草稿 rev 加 1', (await rev()) === 2, String(await rev()));
  await asApp(A, (tx) => tx.execute(sql`update sop_versions set rev = 100 where id = ${d1}`));
  check('触发器：rev 由触发器定，客户端写的值不算', (await rev()) === 3, String(await rev()));
  for (const [col, val] of [
    ['tenant_id', `'${B}'`],
    ['source', `'import'`],
    ['pack_id', `'other'`],
    ['created_at', `now() - interval '1 day'`],
    ['created_by_name', `'别人'`],
    ['created_by', `'${U}'`],
    ['id', 'gen_random_uuid()'],
  ]) {
    const got = await why(q(`update sop_versions set ${col} = ${val} where id = $1`, [d1]));
    check(`触发器：草稿的 ${col} 不可改`, got === 'trigger', got);
  }

  // 部分唯一索引：同一租户只能有一份已发布、一份草稿
  check('唯一：同租户第二个已发布版本被拒', (await why(insertPublished(A, 2))) === 'sop_one_published');
  check('唯一：同租户第二份草稿被拒', (await why(draft(A, 'console'))) === 'sop_one_draft');
  check(
    '唯一：别的租户各有一份已发布和草稿不受影响',
    (await outcome(insertPublished(B, 1))) === 'ok' && (await outcome(draft(B, 'console'))) === 'ok',
  );
  // 状态迁移本身合法（published → archived），但顺带改了别的列：只有「除 status 外不可改」那一条拦得住
  {
    const vB1 = await versionId(B, 1);
    const before = await snapshot(vB1);
    const sneaky = await why(
      asApp(B, (tx) => tx.execute(sql`update sop_versions set status = 'archived', change_note = '顺手改' where id = ${vB1}`)),
    );
    check('触发器：归档时顺带改别的列被拒', sneaky === 'trigger', sneaky);
    check('触发器：被拒之后那一行没变', (await snapshot(vB1)) === before);
  }

  // 复合外键：based_on 不能指向别的租户的版本
  const [{ id: dB }] = await q<{ id: string }>(`select id from sop_versions where tenant_id = $1 and status = 'draft'`, [B]);
  check(
    '外键：based_on 指向别的租户的版本被拒',
    (await why(q('update sop_versions set based_on = $1 where id = $2', [v1, dB]))) === 'sop_versions_based_on_fk',
  );
  check(
    '外键：based_on 指向同租户的版本可以',
    (await outcome(q('update sop_versions set based_on = $1 where id = $2', [await versionId(B, 1), dB]))) === 'ok',
  );

  // 发布：先把当前版本归档，再把草稿翻成 published 并分配版本号
  const r = released('v2');
  const publish = await outcome(
    asApp(A, async (tx) => {
      await lockTenantConfig(tx);
      await tx.execute(sql`update sop_versions set status = 'archived' where id = ${v1}`);
      await tx.execute(sql`update sop_versions set status = 'published', version_no = 2, rendered_prompt = ${r.rendered},
                             prompt_hash = ${r.promptHash}, tools_hash = ${r.toolsHash}, prefix_hash = ${r.prefixHash},
                             sop_hash = ${r.sopHash}, render_inputs = ${r.renderInputs}::jsonb, published_at = now()
                           where id = ${d1}`);
    }),
  );
  check('触发器：published → archived、draft → published 能在一个事务里完成', publish === 'ok', publish);
  const archivedBack = await why(q(`update sop_versions set status = 'published' where id = $1`, [v1]));
  check('触发器：archived 不能回到 published', archivedBack === 'trigger', archivedBack);
  check(
    '触发器：archived 除 status 外不可改',
    (await why(q(`update sop_versions set change_note = 'x' where id = $1`, [v1]))) === 'trigger',
  );
  check('触发器：已发布版本号不可改', (await why(q(`update sop_versions set version_no = 3 where id = $1`, [d1]))) === 'trigger');

  // 草稿存在期间先后直接写入 rollback 与 rerender 版本（验收 7 最后一条的数据库那一半；版本号的分配在第 7 步）
  await draft(A, 'console');
  const [{ id: d2 }] = await q<{ id: string }>(`select id from sop_versions where tenant_id = $1 and status = 'draft'`, [A]);
  const archive = (id: string): Promise<unknown> => q(`update sop_versions set status = 'archived' where id = $1`, [id]);
  await archive(d1);
  check('触发器：草稿在时能直接写入 rollback 版本', (await why(insertPublished(A, 3, { source: 'rollback' }))) === 'ok');
  await archive(await versionId(A, 3));
  check('触发器：草稿在时能直接写入 rerender 版本', (await why(insertPublished(A, 4, { source: 'rerender' }))) === 'ok');
  await archive(await versionId(A, 4));
  check(
    '唯一：版本号在租户内不重复',
    (await why(insertPublished(A, 3, { source: 'rollback' }, 'v3 again'))) === 'sop_versions_tenant_id_version_no_uq',
  );

  // 丢弃：draft → discarded 可以，之后不能再改回来
  check('触发器：draft → discarded 可以', (await outcome(q(`update sop_versions set status = 'discarded' where id = $1`, [d2]))) === 'ok');
  check('触发器：discarded 不能回到 draft', (await why(q(`update sop_versions set status = 'draft' where id = $1`, [d2]))) === 'trigger');
  check(
    '触发器：丢弃的草稿不能直接发布',
    (await why(q(`update sop_versions set status = 'published', version_no = 9 where id = $1`, [d2]))) === 'trigger',
  );
  check('触发器：丢弃之后能再建新草稿', (await why(draft(A, 'console'))) === 'ok');
}

// ---------------- catalog_items 的触发器 ----------------
{
  const [{ id: item }] = await q<{ id: string }>(`select id from catalog_items where tenant_id = $1 and kind = 'route' and code = 'r-a'`, [
    A,
  ]);
  const row = async () =>
    (
      await q<{ rev: number; updated_at: Date; status: string }>('select rev, updated_at, status from catalog_items where id = $1', [item])
    )[0]!;
  const before = await row();
  await asApp(A, (tx) =>
    tx.execute(sql`update catalog_items set payload = ${JSON.stringify({ id: 'r-a', title: '改过' })}::json where id = ${item}`),
  );
  const after = await row();
  check('触发器：改条目 rev 加 1', after.rev === before.rev + 1, `${before.rev} → ${after.rev}`);
  check('触发器：改条目刷新 updated_at', after.updated_at.getTime() > before.updated_at.getTime());
  await q(`update catalog_items set updated_at = '2000-01-01' where id = $1`, [item]);
  check('触发器：updated_at 由触发器定', (await row()).updated_at.getUTCFullYear() > 2000);
  const revBefore = (await row()).rev;
  await q(`update catalog_items set rev = 100 where id = $1`, [item]);
  check('触发器：条目的 rev 由触发器定，客户端写的值不算', (await row()).rev === revBefore + 1, String((await row()).rev));
  const immutable: [string, SQL][] = [
    // code 与 payload.id 一起改：payload 的 CHECK 拦不住，只剩触发器
    ['code', sql`update catalog_items set code = 'r-z', payload = '{"id":"r-z"}'::json where id = ${item}`],
    ['ord', sql`update catalog_items set ord = 5 where id = ${item}`],
    ['kind', sql`update catalog_items set kind = 'hotel' where id = ${item}`],
    ['tenant_id', sql`update catalog_items set tenant_id = ${B} where id = ${item}`],
    ['id', sql`update catalog_items set id = gen_random_uuid() where id = ${item}`],
  ];
  for (const [col, stmt] of immutable) {
    const got = await why(asApp(A, (tx) => tx.execute(stmt)));
    check(`触发器：条目的 ${col} 不可改`, got === 'trigger', got);
  }
  check('触发器：draft → active 可以', (await outcome(q(`update catalog_items set status = 'active' where id = $1`, [item]))) === 'ok');
  check('触发器：active 不能回到 draft', (await why(q(`update catalog_items set status = 'draft' where id = $1`, [item]))) === 'trigger');
  const del = await outcome(asApp(A, (tx) => tx.execute(sql`delete from catalog_items where id = ${item}`)));
  check('权限：agent_app 删除条目报 permission denied', del === DENIED, del);
}

// ---------------- 连接串脱敏 ----------------
{
  const { redactUrl } = await import('./client.js');
  const pg = (await import('pg')).default;
  /** node-postgres 自己从连接串里解析出的口令：脱敏之后的串里不能再有它 */
  const passwordOf = (url: string): string => (new pg.Client({ connectionString: url }) as unknown as { password: string }).password;
  const cases: [string, string, string][] = [
    ['普通口令', 'postgres://agent_app:hush-hush@db:5432/agent', 'postgres://agent_app:***@db:5432/agent'],
    [
      '口令里有没转义的 @（node-postgres 按最后一个 @ 切开，照样连得上）',
      'postgresql://agent_app:s3cr@tPart@db:5432/agent',
      'postgresql://agent_app:***@db:5432/agent',
    ],
    [
      '口令放在查询参数里',
      'postgres://agent_app@db:5432/agent?password=hush-hush&application_name=app',
      'postgres://agent_app@db:5432/agent?password=***&application_name=app',
    ],
    [
      '主机后面的查询参数里也有 @（只抹口令，主机、库名、参数照旧）',
      'postgres://agent_app:hush-hush@db:5432/agent?application_name=ops@team',
      'postgres://agent_app:***@db:5432/agent?application_name=ops@team',
    ],
  ];
  for (const [what, url, want] of cases) {
    const got = redactUrl(url);
    const pw = passwordOf(url);
    check(`脱敏：${what}，口令一个字都不剩`, got === want && pw.length > 0 && !got.includes(pw), `${got} / ${pw}`);
  }
  check('脱敏：没有口令的连接串原样返回', redactUrl('postgres://agent_app@db:5432/agent') === 'postgres://agent_app@db:5432/agent');
  const noPw = 'postgres://agent_app@db:5432/agent?application_name=ops@team';
  check('脱敏：没有口令、查询参数里有 @ 的连接串原样返回，不凭空拼出口令', redactUrl(noPw) === noPw, redactUrl(noPw));
  // node-postgres 不认的口令（URL 规则下成了端口，或整串解析不了）也是运维写进去的口令：宁可多抹
  const odd = ['postgres://agent_app:2024#x@db:5432/agent', 'postgres://agent_app:a/b@db:5432/agent'].map(redactUrl);
  check(
    '脱敏：口令里有裸的 # 或 /（URL 规则切不对）时一直抹到最后一个 @',
    odd.every((x) => x === 'postgres://agent_app:***@db:5432/agent'),
    odd.join(' '),
  );
}

// ---------------- withTenant ----------------
{
  const tenantInTx = async (tx: Tx): Promise<string | null> =>
    rowsOf<{ v: string | null }>(await tx.execute(sql`select current_setting('app.tenant_id', true) as v`))[0]?.v ?? null;
  check(
    'withTenant：外面调 currentTenantCtx 抛错',
    (await outcome(Promise.resolve().then(() => currentTenantCtx()))).startsWith('非数据库错误'),
  );
  const inside = await withTenant(t.db, ctxOf(A), async (tx) => ({ guc: await tenantInTx(tx), ctx: currentTenantCtx().tenantId }));
  check('withTenant：事务里设好了租户', inside.guc === A && inside.ctx === A, JSON.stringify(inside));
  const after = (await q<{ v: string | null }>(`select current_setting('app.tenant_id', true) as v`))[0]?.v;
  check('withTenant：提交后会话级没有租户', !after, String(after));
  const nested = await outcome(withTenant(t.db, ctxOf(A), () => withTenant(t.db, ctxOf(A), async () => 1)));
  check('withTenant：嵌套抛错', nested.includes('不能嵌套'), nested);
  const seen = await asApp(A, (tx) => tx.execute(sql`select tenant_id from catalog_items where kind = 'route'`));
  check(
    'withTenant：agent_app 只看得到本租户的条目',
    rowsOf<{ tenant_id: string }>(seen).every((r) => r.tenant_id === A) && rowsOf(seen).length > 0,
  );
  const ro = await outcome(
    withTenant(
      t.db,
      ctxOf(A),
      (tx) => tx.execute(sql`insert into audit_log (tenant_id, actor_kind, action) values (${A}, 'system', 'x')`),
      { readOnly: true },
    ),
  );
  check('withTenant：readOnly 事务里写入被拒', ro === '25006', ro);
  const n0 = queryCount();
  await withTenant(t.db, ctxOf(A), async (tx) => {
    await lockTenantConfig(tx);
  });
  check('queryCount：经 drizzle 的查询都计数', queryCount() > n0, `${n0} → ${queryCount()}`);
  check('lockTenantConfig：在 withTenant 外调用抛错', (await outcome(lockTenantConfig(t.db as unknown as Tx))).startsWith('非数据库错误'));

  // 有人在事务外做了会话级 SET：下一次 withTenant 发现后抛错，并把这条连接当脏连接处理
  await t.pg.exec(`SET app.tenant_id = '${B}'`);
  const leaked = await outcome(withTenant(t.db, ctxOf(A), async () => 1));
  check('withTenant：会话级 SET 过租户，下一次 withTenant 抛错', leaked.includes('会话级'), leaked);
  check('withTenant：脏连接处理之后照常可用', (await outcome(withTenant(t.db, ctxOf(A), async () => 1))) === 'ok');
}

// ---------------- 认证函数冒烟（逐格的权限与遮蔽测试在真实 PG 部分） ----------------
{
  type Row = Record<string, unknown>;
  const call = <R extends Row>(tenantId: string, stmt: SQL): Promise<R[]> =>
    asApp(tenantId, async (tx) => rowsOf<R>(await tx.execute(stmt)));
  const token = randomBytes(32);
  const at = (min: number): string => new Date(Date.parse('2026-09-26T00:00:00Z') + min * 60_000).toISOString();

  const found = await call<{ o_user_id: string; o_role: string; o_password_hash: string }>(
    A,
    sql`select * from auth_login_lookup(${A}, ${'ops@EXAMPLE.com'})`,
  );
  check('认证：按 lower(email) 找到本租户的成员', found.length === 1 && found[0]?.o_user_id === U && found[0]?.o_role === 'admin');
  check('认证：别的租户查不到这个人', (await call(B, sql`select * from auth_login_lookup(${B}, ${'ops@example.com'})`)).length === 0);

  await call(A, sql`select auth_session_create(${A}, ${token}, ${U}, ${at(0)}::timestamptz, ${'10.0.0.1'}::inet, ${'ua'})`);
  const lastSeen = async (): Promise<string | undefined> =>
    (await q<{ t: Date }>('select last_seen_at as t from auth_sessions where token_hash = $1', [token]))[0]?.t.toISOString();
  const touch = (tenantId: string, min: number) =>
    call<{ o_user_id: string }>(tenantId, sql`select * from auth_session_touch(${tenantId}, ${token}, ${at(min)}::timestamptz)`);
  check('认证：会话有效', (await touch(A, 0.5))[0]?.o_user_id === U);
  check('认证：一分钟内不写 last_seen_at', (await lastSeen()) === at(0));
  await touch(A, 2);
  check('认证：超过一分钟才写 last_seen_at', (await lastSeen()) === at(2), await lastSeen());
  // U 也是 B 的成员：拿 A 的会话去 B 查，只可能因为「会话属于别的租户」而返回空
  await q(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'viewer')`, [B, U]);
  check('认证：别的租户拿这个 token 只得到空', (await touch(B, 3)).length === 0);
  check('认证：别的租户拿过之后会话还在、没被刷新', (await lastSeen()) === at(2));
  await q('delete from memberships where tenant_id = $1 and user_id = $2', [B, U]);

  await q('update users set disabled_at = now() where id = $1', [U]);
  check('认证：账号停用后登录查不到', (await call(A, sql`select * from auth_login_lookup(${A}, ${'ops@example.com'})`)).length === 0);
  check('认证：账号停用后会话只返回空、不删行', (await touch(A, 4)).length === 0 && (await lastSeen()) !== undefined);
  await q('update users set disabled_at = null where id = $1', [U]);
  await q(`update tenants set status = 'suspended' where id = $1`, [A]);
  check('认证：租户停用后登录查不到', (await call(A, sql`select * from auth_login_lookup(${A}, ${'ops@example.com'})`)).length === 0);
  check('认证：租户停用后会话只返回空', (await touch(A, 5)).length === 0);
  await q(`update tenants set status = 'active' where id = $1`, [A]);
  check('认证：空闲超过 12 小时删行并返回空', (await touch(A, 2 + 12 * 60 + 1)).length === 0 && (await lastSeen()) === undefined);

  const rehash = (oldHash: string) =>
    call<{ ok: boolean }>(A, sql`select auth_password_rehash(${A}, ${U}, ${oldHash}, ${'scrypt$new'}) as ok`).then((r) => r[0]?.ok);
  check('认证：旧哈希对得上才升级', (await rehash('scrypt$old')) === true);
  check('认证：旧哈希已被换掉时不覆盖', (await rehash('scrypt$old')) === false);
  const token2 = randomBytes(32);
  await call(A, sql`select auth_session_create(${A}, ${token2}, ${U}, ${at(0)}::timestamptz, ${null}, ${null})`);
  await call(A, sql`select auth_session_delete(${token2})`);
  check('认证：登出删掉会话', (await q('select 1 from auth_sessions where token_hash = $1', [token2])).length === 0);

  // 绝对期限是 168 小时，不随调用方时区的夏令时变化（America/New_York 在 2026-03-08 拨快一小时）
  await t.pg.exec(`SET TimeZone = 'America/New_York'`);
  try {
    const token4 = randomBytes(32);
    await call(A, sql`select auth_session_create(${A}, ${token4}, ${U}, ${'2026-03-05T12:00:00Z'}::timestamptz, ${null}, ${null})`);
    const [life] = await q<{ h: string }>(
      'select extract(epoch from expires_at - created_at) / 3600 as h from auth_sessions where token_hash = $1',
      [token4],
    );
    check('认证：会话绝对期限是 168 小时，跨夏令时也一样', Number(life?.h) === 168, String(life?.h));
  } finally {
    await t.pg.exec('RESET TimeZone');
  }

  // 事务里已设为 B 时，用 A 调认证函数报错；同租户调用之后 app.tenant_id 恢复原值
  const cross = await outcome(call(B, sql`select * from auth_login_lookup(${A}, ${'ops@example.com'})`));
  check('认证：事务已设为别的租户时调用报错', cross === DENIED, cross);
  const restored = await asApp(A, async (tx) => {
    await tx.execute(sql`select * from auth_login_lookup(${A}, ${'ops@example.com'})`);
    return rowsOf<{ v: string }>(await tx.execute(sql`select current_setting('app.tenant_id', true) as v`))[0]?.v;
  });
  check('认证：调用之后 app.tenant_id 仍是调用前的租户', restored === A, restored);
  // 调用前没设租户的事务（登录请求就是这样）：函数内部设成 p_tenant，返回前必须清回去，
  // 否则同一事务后面的查询就带着这个租户在跑
  const token3 = randomBytes(32);
  const unsetAfter: [string, string, unknown[]][] = [
    ['auth_login_lookup', 'select * from auth_login_lookup($1, $2)', [A, 'ops@example.com']],
    ['auth_session_create', 'select auth_session_create($1, $2, $3, now(), null, null)', [A, token3, U]],
    ['auth_session_touch', 'select * from auth_session_touch($1, $2, now())', [A, token3]],
    ['auth_password_rehash', 'select auth_password_rehash($1, $2, $3, $4)', [A, U, 'scrypt$new', 'scrypt$newer']],
  ];
  for (const [fn, text, params] of unsetAfter) {
    await t.pg.exec('SET ROLE agent_app');
    try {
      const v = await t.pg.transaction(async (tx) => {
        await tx.query(text, params);
        return (await tx.query<{ v: string | null }>(`select current_setting('app.tenant_id', true) as v`)).rows[0]?.v;
      });
      check(`认证：${fn} 在没设租户的事务里调用，之后仍没有租户`, !v, String(v));
    } finally {
      await t.pg.exec('RESET ROLE');
    }
  }
}

// ================ 02：会话入库的表（约束、触发器、仓储函数、清除函数） ================
const iso = (ms: number): string => new Date(ms).toISOString();
const insConv = (
  tenantId: string,
  id: string,
  over: { state?: unknown; lastSeq?: number; windowStartSeq?: number; updatedAt?: string } = {},
): Promise<unknown> =>
  q(
    `insert into conversations (tenant_id, id, channel, stage, handed_over, state, last_seq, window_start_seq, created_at, updated_at)
     values ($1, $2, 'wecom', 'greeting', false, $3::json, $4, $5, now(), $6::timestamptz)`,
    [
      tenantId,
      id,
      JSON.stringify(over.state === undefined ? { id } : over.state),
      over.lastSeq ?? 0,
      over.windowStartSeq ?? 1,
      over.updatedAt ?? iso(Date.now()),
    ],
  );
const insMsg = (
  tenantId: string,
  convId: string,
  seq: number,
  role: string,
  over: { author?: string; authorUserId?: string; authorName?: string } = {},
): Promise<unknown> =>
  q(
    `insert into messages (tenant_id, conversation_id, seq, role, author, author_user_id, author_name, content, at)
     values ($1, $2, $3, $4, $5, $6, $7, 'x', now())`,
    [tenantId, convId, seq, role, over.author ?? null, over.authorUserId ?? null, over.authorName ?? null],
  );
const insOrder = (
  tenantId: string,
  id: string,
  over: { sessionId?: string; status?: string; totalPrice?: number; voidReason?: string; data?: unknown } = {},
): Promise<unknown> =>
  q(
    `insert into orders (tenant_id, id, session_id, route_id, status, total_price, created_at, void_reason, data)
     values ($1, $2, $3, 'r-a', $4, $5, now(), $6, $7::json)`,
    [
      tenantId,
      id,
      over.sessionId ?? null,
      over.status ?? 'pending_payment',
      over.totalPrice ?? 100,
      over.voidReason ?? null,
      JSON.stringify(over.data ?? { id }),
    ],
  );
const insTrace = (tenantId: string, id: string, convId: string, over: { outcome?: string; prefixHash?: string } = {}): Promise<unknown> =>
  q(
    `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
     values ($1, $2, $3, now(), 1, $4, $5, '{}', '[]', '[]')`,
    [tenantId, id, convId, over.outcome ?? 'replied', over.prefixHash ?? sha('p')],
  );
const insGuard = (tenantId: string, turnId: string, ord: number, guard: string, action: string): Promise<unknown> =>
  q(`insert into guard_events (tenant_id, turn_id, ord, guard, action, removed, added) values ($1, $2, $3, $4, $5, '[]', '[]')`, [
    tenantId,
    turnId,
    ord,
    guard,
    action,
  ]);
const insJob = (tenantId: string, key: string, over: { kind?: string; status?: string; maxAttempts?: number } = {}): Promise<unknown> =>
  q(`insert into jobs (tenant_id, kind, dedupe_key, run_at, status, max_attempts, payload) values ($1, $2, $3, now(), $4, $5, '{}')`, [
    tenantId,
    over.kind ?? 'followup',
    key,
    over.status ?? 'pending',
    over.maxAttempts ?? 3,
  ]);
const insConsent = (tenantId: string, convId: string, category: string, decision: string): Promise<unknown> =>
  q(`insert into consents (tenant_id, conversation_id, category, decision, notice_version, at) values ($1, $2, $3, $4, 1, now())`, [
    tenantId,
    convId,
    category,
    decision,
  ]);
const insSend = (tenantId: string, msgid: string, over: { kind?: string; status?: string } = {}): Promise<unknown> =>
  q(`insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status) values ($1, 'c-a', $2, $3, now(), $4)`, [
    tenantId,
    msgid,
    over.kind ?? 'ai',
    over.status ?? 'accepted',
  ]);
const insVersion = (tenantId: string, code: string, version: number, source = 'console'): Promise<unknown> =>
  q(`insert into catalog_item_versions (tenant_id, kind, code, version, payload, source) values ($1, 'route', $2, $3, $4::json, $5)`, [
    tenantId,
    code,
    version,
    JSON.stringify({ id: code }),
    source,
  ]);
/** 被谁拒的逐条比：[说明, 语句, 期望的约束名或 'trigger' / 'ok'] */
async function expectWhy(cases: [string, () => Promise<unknown>, string][]): Promise<void> {
  for (const [what, run, want] of cases) {
    const got = await why(run());
    check(`02 约束：${what}${want === 'ok' ? ' 能插入' : ` 被 ${want} 拒`}`, got === want, got);
  }
}

// ---------------- 02：CHECK、复合外键与唯一 ----------------
await insConv(A, 'c-a'); // 只在 A 里
const T1 = randomUUID();
await insTrace(A, T1, 'c-a');
await expectWhy([
  ['会话 id 以 sim- 开头（demo 类）', () => insConv(A, 'sim-abc'), 'conversations_id_check'],
  ['会话 id 以 wecom:cust_ 开头（种子）', () => insConv(A, 'wecom:cust_001'), 'conversations_id_check'],
  ['会话 id 为空', () => insConv(A, ''), 'conversations_id_check'],
  ['会话 id 超过 200 个字符', () => insConv(A, 'x'.repeat(201)), 'conversations_id_check'],
  ['state.id 与 id 不一致', () => insConv(A, 'c-1', { state: { id: 'c-2' } }), 'conversations_state_check'],
  ['state 没有 id', () => insConv(A, 'c-1', { state: { stage: 'greeting' } }), 'conversations_state_check'],
  ['state 不是对象', () => insConv(A, 'c-1', { state: ['c-1'] }), 'conversations_state_check'],
  // last_seq < 0 时窗口起点必然也越界；CHECK 按约束名的字母序检查，先报 last_seq
  ['last_seq 小于 0', () => insConv(A, 'c-1', { lastSeq: -1, windowStartSeq: 0 }), 'conversations_last_seq_check'],
  ['窗口起点为 0', () => insConv(A, 'c-1', { windowStartSeq: 0 }), 'conversations_window_start_seq_check'],
  ['窗口起点超过 last_seq + 1', () => insConv(A, 'c-1', { lastSeq: 1, windowStartSeq: 3 }), 'conversations_window_start_seq_check'],
  ['wecom: 开头的真实会话，窗口为空（起点 = last_seq + 1）', () => insConv(A, 'wecom:wm-real', { lastSeq: 2, windowStartSeq: 3 }), 'ok'],
  ['同租户同 id 的会话', () => insConv(A, 'c-a'), 'conversations_tenant_id_id_pk'],
  ['同 id 的会话在别的租户', () => insConv(B, 'c-b-only'), 'ok'],
  ['消息 seq 为 0', () => insMsg(A, 'c-a', 0, 'customer'), 'messages_seq_check'],
  ['消息 role 只有三种', () => insMsg(A, 'c-a', 1, 'bot'), 'messages_role_check'],
  ['客户消息带 author', () => insMsg(A, 'c-a', 1, 'customer', { author: 'ai' }), 'messages_author_role_check'],
  ['author 只有三种', () => insMsg(A, 'c-a', 1, 'agent', { author: 'robot' }), 'messages_author_check'],
  ['AI 回复带操作者姓名', () => insMsg(A, 'c-a', 1, 'agent', { author: 'ai', authorName: '小林' }), 'messages_author_human_check'],
  ['消息的会话不存在', () => insMsg(A, 'c-none', 1, 'customer'), 'messages_conversation_fk'],
  ['消息的会话在别的租户', () => insMsg(B, 'c-a', 1, 'customer'), 'messages_conversation_fk'],
  ['人工回复带操作者', () => insMsg(A, 'c-a', 1, 'agent', { author: 'human', authorUserId: U, authorName: '小林' }), 'ok'],
  ['同一会话的 seq 重复', () => insMsg(A, 'c-a', 1, 'customer'), 'messages_tenant_id_conversation_id_seq_pk'],
  ['订单号带空格', () => insOrder(A, 'ord 1'), 'orders_id_check'],
  ['订单号超过 64 个字符', () => insOrder(A, 'o'.repeat(65)), 'orders_id_check'],
  ['订单状态只有四种', () => insOrder(A, 'ord_s', { status: 'refunded' }), 'orders_status_check'],
  ['订单金额小于 0', () => insOrder(A, 'ord_p', { totalPrice: -1 }), 'orders_total_price_check'],
  ['作废原因只有两种', () => insOrder(A, 'ord_v', { voidReason: 'oops' }), 'orders_void_reason_check'],
  ['订单 data.id 与 id 不一致', () => insOrder(A, 'ord_d', { data: { id: 'ord_x' } }), 'orders_data_check'],
  ['订单 data 不是对象', () => insOrder(A, 'ord_d', { data: ['ord_d'] }), 'orders_data_check'],
  ['订单 data 没有 id', () => insOrder(A, 'ord_n', { data: { routeId: 'r-a' } }), 'orders_data_check'],
  ['订单的会话不存在', () => insOrder(A, 'ord_f', { sessionId: 'c-none' }), 'orders_session_fk'],
  ['订单的会话在别的租户', () => insOrder(B, 'ord_f', { sessionId: 'c-a' }), 'orders_session_fk'],
  ['旧数据的订单号（不是 ord_ 开头）、没有会话', () => insOrder(A, 'A1B2-c3_d4'), 'ok'],
  ['trace 的 outcome 只有七种', () => insTrace(A, randomUUID(), 'c-a', { outcome: 'ok' }), 'turn_traces_outcome_check'],
  [
    'trace 的前缀哈希不是小写十六进制',
    () => insTrace(A, randomUUID(), 'c-a', { prefixHash: 'A'.repeat(64) }),
    'turn_traces_prefix_hash_check',
  ],
  ['trace 的会话不存在', () => insTrace(A, randomUUID(), 'c-none'), 'turn_traces_conversation_fk'],
  ['护栏名只能是小写字母与下划线', () => insGuard(A, T1, 0, 'Price', 'replace'), 'guard_events_guard_check'],
  ['护栏名至少两个字符', () => insGuard(A, T1, 0, 'p', 'replace'), 'guard_events_guard_check'],
  ['护栏动作只有六种', () => insGuard(A, T1, 0, 'price', 'delete'), 'guard_events_action_check'],
  ['护栏事件的 trace 不存在', () => insGuard(A, randomUUID(), 0, 'price', 'replace'), 'guard_events_turn_fk'],
  ['护栏事件的 trace 在别的租户', () => insGuard(B, T1, 0, 'price', 'replace'), 'guard_events_turn_fk'],
  ['合法的护栏事件', () => insGuard(A, T1, 0, 'link_whitelist', 'drop_sentence'), 'ok'],
  [
    '用量的用途只有六种',
    () => q(`insert into usage_daily (tenant_id, day, model, purpose) values ($1, current_date, 'm', 'chitchat')`, [A]),
    'usage_daily_purpose_check',
  ],
  ['任务种类只有三种', () => insJob(A, 'k', { kind: 'email' }), 'jobs_kind_check'],
  ['任务状态只有七种', () => insJob(A, 'k', { status: 'paused' }), 'jobs_status_check'],
  ['max_attempts 至少 1', () => insJob(A, 'k', { maxAttempts: 0 }), 'jobs_max_attempts_check'],
  ['max_attempts 至多 10', () => insJob(A, 'k', { maxAttempts: 11 }), 'jobs_max_attempts_check'],
  [
    '快捷回复标题为空',
    () => q(`insert into quick_replies (tenant_id, ord, title, body) values ($1, 0, '', 'b')`, [A]),
    'quick_replies_title_check',
  ],
  [
    '快捷回复标题 21 个字',
    () => q(`insert into quick_replies (tenant_id, ord, title, body) values ($1, 0, $2, 'b')`, [A, '标'.repeat(21)]),
    'quick_replies_title_check',
  ],
  [
    '快捷回复正文 501 个字',
    () => q(`insert into quick_replies (tenant_id, ord, title, body) values ($1, 0, 't', $2)`, [A, '字'.repeat(501)]),
    'quick_replies_body_check',
  ],
  [
    '快捷回复标题 20 个字、正文 500 个字（按字数，不按字节）',
    () => q(`insert into quick_replies (tenant_id, ord, title, body) values ($1, 0, $2, $3)`, [A, '标'.repeat(20), '字'.repeat(500)]),
    'ok',
  ],
  ['发送账本的 msgid 超过 32 字节（11 个汉字是 33 字节）', () => insSend(A, '汉'.repeat(11)), 'outbound_sends_channel_msgid_check'],
  ['发送账本的种类只有七种', () => insSend(A, 'm-k', { kind: 'sms' }), 'outbound_sends_kind_check'],
  ['发送账本的状态只有那几种（02 四种，03 起七种）', () => insSend(A, 'm-s', { status: 'sent' }), 'outbound_sends_status_check'],
  ['32 字节的 msgid', () => insSend(A, 'x'.repeat(32)), 'ok'],
  ['同租户 msgid 重复', () => insSend(A, 'x'.repeat(32)), 'outbound_sends_tenant_id_channel_msgid_uq'],
  ['别的租户同一个 msgid，会话不存在也行（不建外键）', () => insSend(B, 'x'.repeat(32)), 'ok'],
  ['条目版本从 1 起', () => insVersion(A, 'r-a', 0), 'catalog_item_versions_version_check'],
  ['条目版本的来源只有四种', () => insVersion(A, 'r-a', 1, 'import'), 'catalog_item_versions_source_check'],
  ['条目版本的条目不存在', () => insVersion(A, 'r-none', 1), 'catalog_item_versions_item_fk'],
  ['条目版本的条目在别的租户', () => insVersion(B, 'r-order', 1), 'catalog_item_versions_item_fk'],
  ['合法的条目版本', () => insVersion(A, 'r-a', 1), 'ok'],
  ['同一条目的版本号重复', () => insVersion(A, 'r-a', 1), 'catalog_item_versions_tenant_id_kind_code_version_pk'],
  [
    '隐私说明版本从 1 起',
    () => q(`insert into privacy_notices (tenant_id, version, body) values ($1, 0, 'x')`, [A]),
    'privacy_notices_version_check',
  ],
  ['同意的类别只有两种', () => insConsent(A, 'c-a', 'religion', 'asked'), 'consents_category_check'],
  ['同意的结果只有四种', () => insConsent(A, 'c-a', 'health', 'maybe'), 'consents_decision_check'],
  ['同意记录的会话不存在', () => insConsent(A, 'c-none', 'health', 'asked'), 'consents_conversation_fk'],
]);
{
  for (const col of ['retention_lead_days', 'retention_customer_days', 'retention_trace_days']) {
    for (const v of [6, 3651]) {
      const got = await why(q(`insert into tenants (slug, name, pack_id, ${col}) values ('t-retention', 'x', 'travel', $1)`, [v]));
      check(`02 约束：tenants.${col} = ${v} 被拒（7 到 3650 天）`, got === `tenants_${col}_check`, got);
    }
  }
  const [r] = await q<{ lead: number; customer: number; trace: number }>(
    `select retention_lead_days as lead, retention_customer_days as customer, retention_trace_days as trace from tenants where id = $1`,
    [A],
  );
  check('02 约束：保留期默认是线索 180、客户 730、trace 90 天', r?.lead === 180 && r.customer === 730 && r.trace === 90, JSON.stringify(r));
  const [v] = await q<{ v: number }>(`select version as v from catalog_items where tenant_id = $1 and kind = 'route' and code = 'r-a'`, [
    A,
  ]);
  check('02 约束：catalog_items.version 默认是 1', v?.v === 1);
}

// jobs：同一 dedupe_key 至多一个没结束的任务
{
  const key = 'followup:c-a:discovery';
  const setStatus = (status: string): Promise<unknown> =>
    q(`update jobs set status = $3 where tenant_id = $1 and dedupe_key = $2 and status in ('pending', 'running', 'sending')`, [
      A,
      key,
      status,
    ]);
  check('02 唯一：第一个 pending 能插入', (await outcome(insJob(A, key))) === 'ok');
  check('02 唯一：已有 pending 时再插 pending 被 jobs_open_uq 拒', (await why(insJob(A, key))) === 'jobs_open_uq');
  check('02 唯一：已有 pending 时插 running 也被拒', (await why(insJob(A, key, { status: 'running' }))) === 'jobs_open_uq');
  await setStatus('sending');
  check('02 唯一：sending 也算没结束', (await why(insJob(A, key))) === 'jobs_open_uq');
  await setStatus('done');
  check('02 唯一：结束之后同一 key 能再排', (await outcome(insJob(A, key))) === 'ok');
  check(
    '02 唯一：结束了的任务同一 key 可以有多条',
    (await outcome(insJob(A, key, { status: 'cancelled' }))) === 'ok' && (await outcome(insJob(A, key, { status: 'abandoned' }))) === 'ok',
  );
  check('02 唯一：别的租户同一 key 不受影响', (await outcome(insJob(B, key))) === 'ok');
}

// 复合外键：删会话时级联删名下的行；订单只把 session_id 置空，tenant_id 不动
{
  await insConv(A, 'c-del');
  await insMsg(A, 'c-del', 1, 'customer');
  const turn = randomUUID();
  await insTrace(A, turn, 'c-del');
  await insGuard(A, turn, 0, 'price', 'replace');
  await insConsent(A, 'c-del', 'health', 'asked');
  await insOrder(A, 'ord_del', { sessionId: 'c-del', data: { id: 'ord_del', sessionId: 'c-del' } });
  await q(`delete from conversations where tenant_id = $1 and id = 'c-del'`, [A]);
  const [o] = await q<{ tenant_id: string; session_id: string | null }>(
    `select tenant_id, session_id from orders where tenant_id = $1 and id = 'ord_del'`,
    [A],
  );
  check('02 外键：删会话时订单的 session_id 置空，tenant_id 不被置空', o?.tenant_id === A && o.session_id === null, JSON.stringify(o));
  const [left] = await q<{ m: number; t: number; g: number; c: number }>(
    `select (select count(*)::int from messages where tenant_id = $1 and conversation_id = 'c-del') as m,
            (select count(*)::int from turn_traces where tenant_id = $1 and conversation_id = 'c-del') as t,
            (select count(*)::int from guard_events where tenant_id = $1 and turn_id = $2) as g,
            (select count(*)::int from consents where tenant_id = $1 and conversation_id = 'c-del') as c`,
    [A, turn],
  );
  check(
    '02 外键：删会话级联删掉消息、trace、护栏事件、同意记录',
    JSON.stringify(left) === '{"m":0,"t":0,"g":0,"c":0}',
    JSON.stringify(left),
  );
}

// ---------------- 02：两个触发器 ----------------
{
  const future = iso(Date.now() + 10 * 60_000);
  check('02 触发器：插入时 updated_at 晚于 now() + 5 分钟被拒', (await why(insConv(A, 'c-future', { updatedAt: future }))) === 'trigger');
  // 5 分钟这条线：晚 6 分钟被拒，晚 4 分钟可以（客户端与库的时钟差在这之内）
  const in6 = await why(insConv(A, 'c-plus6', { updatedAt: iso(Date.now() + 6 * 60_000) }));
  check('02 触发器：updated_at 晚 6 分钟被拒', in6 === 'trigger', in6);
  const in4 = await why(insConv(A, 'c-plus4', { updatedAt: iso(Date.now() + 4 * 60_000) }));
  check('02 触发器：updated_at 晚 4 分钟可以', in4 === 'ok', in4);
  check(
    '02 触发器：导入写入过去的 updated_at 不受影响',
    (await outcome(insConv(A, 'c-trg', { updatedAt: '2001-01-01T00:00:00.000Z' }))) === 'ok',
  );
  const upd = async (): Promise<string | undefined> =>
    (await q<{ u: Date }>(`select updated_at as u from conversations where tenant_id = $1 and id = 'c-trg'`, [A]))[0]?.u.toISOString();
  check(
    '02 触发器：updated_at 往回改不报错、被挡回原值',
    (await outcome(q(`update conversations set updated_at = '2000-01-01' where tenant_id = $1 and id = 'c-trg'`, [A]))) === 'ok' &&
      (await upd()) === '2001-01-01T00:00:00.000Z',
    await upd(),
  );
  const later = iso(Date.now() - 60_000);
  await q(`update conversations set updated_at = $2::timestamptz where tenant_id = $1 and id = 'c-trg'`, [A, later]);
  check('02 触发器：updated_at 往前走照常', (await upd()) === later, await upd());
  check(
    '02 触发器：更新时 updated_at 晚于 now() + 5 分钟被拒',
    (await why(q(`update conversations set updated_at = $2::timestamptz where tenant_id = $1 and id = 'c-trg'`, [A, future]))) ===
      'trigger',
  );
  await q(`update conversations set stage = 'discovery' where tenant_id = $1 and id = 'c-trg'`, [A]);
  check('02 触发器：只改别的列时 updated_at 不变', (await upd()) === later);
  const viaApp = await outcome(asApp(A, (tx) => tx.execute(sql`update conversations set updated_at = '2000-01-01' where id = 'c-trg'`)));
  check('02 触发器：agent_app 往回改同样被挡回', viaApp === 'ok' && (await upd()) === later, viaApp);

  await insOrder(A, 'ord_paid');
  const paidAt = async (): Promise<string | null | undefined> =>
    (await q<{ p: Date | null }>(`select paid_at as p from orders where tenant_id = $1 and id = 'ord_paid'`, [A]))[0]?.p?.toISOString() ??
    null;
  const setPaid = (v: string | null): Promise<unknown> =>
    q(`update orders set paid_at = $2::timestamptz where tenant_id = $1 and id = 'ord_paid'`, [A, v]);
  check('02 触发器：paid_at 从空写入一次可以', (await outcome(setPaid('2026-09-01T00:00:00Z'))) === 'ok');
  check('02 触发器：写回同一个 paid_at 不算改', (await outcome(setPaid('2026-09-01T00:00:00Z'))) === 'ok');
  check('02 触发器：改 paid_at 被拒', (await why(setPaid('2026-09-02T00:00:00Z'))) === 'trigger');
  check('02 触发器：清空 paid_at 被拒', (await why(setPaid(null))) === 'trigger');
  check(
    '02 触发器：agent_app 清空 paid_at 同样被拒',
    (await why(asApp(A, (tx) => tx.execute(sql`update orders set paid_at = null where id = 'ord_paid'`)))) === 'trigger',
  );
  check(
    '02 触发器：已付订单改别的列（取消、作废）可以，paid_at 不变',
    (await outcome(
      q(`update orders set status = 'cancelled', voided_at = now(), void_reason = 'reset' where tenant_id = $1 and id = 'ord_paid'`, [A]),
    )) === 'ok' && (await paidAt()) === '2026-09-01T00:00:00.000Z',
  );
}

// ---------------- 02：withTenant 的 longRunning 与 inTenantTx ----------------
{
  const { inTenantTx } = await import('./client.js');
  const timeouts = async (tx: Tx): Promise<{ st: string; it: string }> =>
    rowsOf<{ st: string; it: string }>(
      await tx.execute(
        sql`select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as it`,
      ),
    )[0]!;
  const plain = await withTenant(t.db, ctxOf(A), timeouts);
  const long = await withTenant(t.db, ctxOf(A), timeouts, { longRunning: true });
  const longRo = await withTenant(t.db, ctxOf(A), timeouts, { longRunning: true, isolation: 'repeatable read', readOnly: true });
  const after = await withTenant(t.db, ctxOf(A), timeouts);
  check(
    'withTenant：longRunning 在事务里把语句超时放到 60 秒、事务空闲超时放到 120 秒',
    long.st === '1min' && long.it === '2min',
    JSON.stringify(long),
  );
  check('withTenant：longRunning 能与 repeatable read、readOnly 一起用', longRo.st === '1min' && longRo.it === '2min');
  check(
    'withTenant：longRunning 只管那一个事务，之后回到原值',
    JSON.stringify(after) === JSON.stringify(plain) && plain.st !== '1min',
    JSON.stringify({ plain, after }),
  );
  const outside = inTenantTx();
  const inside = await withTenant(t.db, ctxOf(A), async () => inTenantTx());
  check('inTenantTx：withTenant 外是 false，回调里是 true，结束之后又是 false', !outside && inside && !inTenantTx());
}

// ---------------- 02：仓储函数冒烟（agent_app 经 withTenant，与生产相同） ----------------
{
  const repoConv = await import('./repo/conversations.js');
  const repoMsg = await import('./repo/messages.js');
  const repoOrders = await import('./repo/orders.js');
  const repoVersions = await import('./repo/catalog-versions.js');
  const repoTraces = await import('./repo/traces.js');
  const repoUsage = await import('./repo/usage.js');
  const repoJobs = await import('./repo/jobs.js');
  const repoOutbound = await import('./repo/outbound.js');
  const repoQr = await import('./repo/quick-replies.js');
  const repoConsents = await import('./repo/consents.js');
  const repoPrivacy = await import('./repo/privacy.js');
  const repoMetrics = await import('./repo/metrics.js');
  const { writeAudit, writeAuditAs } = await import('./repo/audit.js');
  const [{ id: R }] = await q<{ id: string }>(`insert into tenants (slug, name, pack_id) values ('repo-a', 'R', 'travel') returning id`);
  const T0 = Date.parse('2026-09-30T08:00:00.123Z');
  const values = (id: string, over: Partial<ConversationValues> = {}): ConversationValues => ({
    id,
    channel: 'wecom',
    stage: 'greeting',
    handedOver: false,
    handoffKind: null,
    handoffAt: null,
    firstHandoffAt: null,
    assigneeUserId: null,
    assigneeName: null,
    lastCustomerAt: null,
    state: { id, stage: 'greeting', zeta: 1, alpha: { yy: 2, bb: 1 } },
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...over,
  });
  const msg = (seq: number): MessageValues => ({
    seq,
    role: seq === 2 ? 'agent' : 'customer',
    author: seq === 2 ? 'human' : null,
    authorUserId: seq === 2 ? U : null,
    authorName: seq === 2 ? '小林' : null,
    content: `第${seq}句`,
    at: new Date(T0 + seq),
    sentAt: seq === 1 ? new Date(T0 - 5000) : null,
    msgid: seq === 1 ? 'msg-1' : null,
    turnId: seq === 2 ? randomUUID() : null,
    extra: seq === 3 ? { zeta: 1, alpha: 2 } : null,
  });

  // 会话行：锁行 → 插入 → 插消息 → 更新
  const flushId = randomUUID();
  const importFlush = randomUUID();
  const r1 = await asApp(R, async (tx) => {
    const before = await repoConv.lockConversation(tx, 'wecom:wm-1');
    const ref = (await repoConv.insertConversation(tx, values('wecom:wm-1')))?.ref ?? '';
    const locked = await repoConv.lockConversation(tx, 'wecom:wm-1');
    await repoMsg.insertMessages(tx, 'wecom:wm-1', [msg(1), msg(2), msg(3)]);
    const updated = await repoConv.updateConversation(
      tx,
      values('wecom:wm-1', {
        stage: 'discovery',
        handedOver: true,
        handoffKind: 'request',
        handoffAt: new Date(T0 + 1000),
        firstHandoffAt: new Date(T0 + 1000),
        assigneeUserId: U,
        assigneeName: '小林',
        lastCustomerAt: new Date(T0 + 500),
        createdAt: new Date(0),
        updatedAt: new Date(T0 + 2000),
      }),
      { lastSeq: 3, windowStartSeq: 2, flushId },
    );
    const missing = await repoConv.updateConversation(tx, values('wecom:none'), { lastSeq: 0, windowStartSeq: 1, flushId: null });
    return { before, ref, locked, updated, missing };
  });
  check(
    '仓储：会话行插入前锁不到，插入后 last_seq = 0、窗口起点 1、没有 flush_id',
    r1.before === null && JSON.stringify(r1.locked) === JSON.stringify({ lastSeq: 0, windowStartSeq: 1, flushId: null }),
    JSON.stringify(r1),
  );
  check('仓储：insertConversation 返回库里生成的 ref', /^[0-9a-f-]{36}$/.test(r1.ref), r1.ref);
  // 主键冲突时返回 null、不报错、不改那一行（新会话第一次落库 COMMIT 断线之后的重试靠它，02 第 5 步）
  const dup = await asApp(R, async (tx) => ({
    again: await repoConv.insertConversation(tx, values('wecom:wm-1', { stage: 'quote' })),
    row: await repoConv.lockConversation(tx, 'wecom:wm-1'),
    stage: (await repoConv.readConversationsAfter(tx, null, 10)).find((c) => c.id === 'wecom:wm-1')?.stage,
  }));
  check(
    '仓储：insertConversation 撞上已有的行返回 null，不报错、不改那一行',
    dup.again === null && dup.row?.lastSeq === 3 && dup.row.flushId === flushId && dup.stage === 'discovery',
    JSON.stringify(dup),
  );
  check('仓储：updateConversation 改到了这一行，不存在的会话改不到', r1.updated && !r1.missing);
  await asApp(R, async (tx) => {
    await repoConv.insertConversation(tx, values('wecom:wm-2'));
    await repoConv.insertConversation(tx, values('wecom:wm-3'), { lastSeq: 1, windowStartSeq: 1, flushId: importFlush });
    await repoMsg.insertMessages(tx, 'wecom:wm-3', [msg(1)]);
  });
  const page1 = await asApp(R, (tx) => repoConv.readConversationsAfter(tx, null, 2));
  const page2 = await asApp(R, (tx) => repoConv.readConversationsAfter(tx, page1.at(-1)?.id ?? null, 2));
  check(
    '仓储：会话按 id 分批读，批与批之间不重不漏',
    [...page1, ...page2].map((c) => c.id).join(',') === 'wecom:wm-1,wecom:wm-2,wecom:wm-3' && page1.length === 2,
  );
  check(
    '仓储：insertConversation 带 seqs 时（导入）一次写好 last_seq、窗口起点与 flush_id，不带时是 0、1、空',
    page2[0]?.lastSeq === 1 &&
      page2[0].windowStartSeq === 1 &&
      page2[0].flushId === importFlush &&
      page1[1]?.lastSeq === 0 &&
      page1[1].windowStartSeq === 1 &&
      page1[1].flushId === null,
    JSON.stringify([page1[1], page2[0]].map((c) => [c?.lastSeq, c?.windowStartSeq, c?.flushId])),
  );
  const row = page1[0];
  check(
    '仓储：会话行的投影列、seq 簿记、flush_id、updated_at 都写进去了',
    row?.stage === 'discovery' &&
      row.handedOver &&
      row.handoffKind === 'request' &&
      row.handoffAt?.getTime() === T0 + 1000 &&
      row.firstHandoffAt?.getTime() === T0 + 1000 &&
      row.assigneeUserId === U &&
      row.assigneeName === '小林' &&
      row.lastCustomerAt?.getTime() === T0 + 500 &&
      row.lastSeq === 3 &&
      row.windowStartSeq === 2 &&
      row.flushId === flushId &&
      row.updatedAt.getTime() === T0 + 2000 &&
      row.ref === r1.ref,
    JSON.stringify(row),
  );
  check('仓储：updateConversation 不动 created_at', row?.createdAt.getTime() === T0);
  check(
    '仓储：state 读回键序与写入时逐字节相同',
    JSON.stringify(row?.state) === JSON.stringify(values('wecom:wm-1').state),
    JSON.stringify(row?.state),
  );

  // 消息：按窗口读
  const win = await asApp(R, (tx) => repoMsg.readWindowMessages(tx, ['wecom:wm-1', 'wecom:wm-3', 'wecom:none']));
  check(
    '仓储：按 seq >= window_start_seq 读，按会话、seq 排序',
    win.map((m) => `${m.conversationId}#${m.seq}`).join(',') === 'wecom:wm-1#2,wecom:wm-1#3,wecom:wm-3#1',
    win.map((m) => `${m.conversationId}#${m.seq}`).join(','),
  );
  const [w2, w3, w1] = win;
  check(
    '仓储：消息各列往返（人工回复的操作者、at 的毫秒、turn_id）',
    w2?.role === 'agent' &&
      w2.author === 'human' &&
      w2.authorUserId === U &&
      w2.authorName === '小林' &&
      w2.at.getTime() === T0 + 2 &&
      typeof w2.turnId === 'string' &&
      w2.extra === null &&
      w2.content === '第2句',
    JSON.stringify(w2),
  );
  check('仓储：消息的 extra 读回键序不变', JSON.stringify(w3?.extra) === '{"zeta":1,"alpha":2}', JSON.stringify(w3?.extra));
  check(
    '仓储：消息的 sentAt、msgid 往返',
    w1?.sentAt?.getTime() === T0 - 5000 && w1.msgid === 'msg-1' && w1.author === null,
    JSON.stringify(w1),
  );
  check('仓储：空的会话列表返回空', (await asApp(R, (tx) => repoMsg.readWindowMessages(tx, []))).length === 0);
  // 一次超过一条 INSERT 的行数上限：分几条插，seq 连续
  await asApp(R, (tx) =>
    repoMsg.insertMessages(
      tx,
      'wecom:wm-2',
      Array.from({ length: 1001 }, (_, i) => ({ ...msg(1), seq: i + 1, msgid: null, sentAt: null })),
    ),
  );
  const [bulk] = await q<{ n: number; mx: number }>(
    `select count(*)::int as n, max(seq) as mx from messages where tenant_id = $1 and conversation_id = 'wecom:wm-2'`,
    [R],
  );
  check('仓储：1001 条消息分批插入，一条不少', bulk?.n === 1001 && bulk.mx === 1001, JSON.stringify(bulk));

  // 订单：按 id upsert，读未作废的
  const ord = (id: string, over: Partial<OrderRow> = {}): OrderRow => ({
    id,
    sessionId: 'wecom:wm-1',
    routeId: 'r-guizhou',
    status: 'pending_payment',
    totalPrice: 5200,
    createdAt: new Date(T0),
    paidAt: null,
    confirmedAt: null,
    voidedAt: null,
    voidReason: null,
    data: { id, sessionId: 'wecom:wm-1', zeta: 1, alpha: 2 },
    ...over,
  });
  await asApp(R, (tx) =>
    repoOrders.upsertOrders(tx, [
      ord('ord_a'),
      ord('ord_b', { voidedAt: new Date(T0 + 1), voidReason: 'reset' }),
      ord('ord_c', { sessionId: 'wecom:wm-3', data: { id: 'ord_c' } }),
      ord('ord_d', { sessionId: 'wecom:wm-2' }),
    ]),
  );
  const paidA = ord('ord_a', { status: 'paid', paidAt: new Date(T0 + 9), data: { id: 'ord_a', sessionId: 'wecom:wm-1', status: 'paid' } });
  const upsertPaid = await why(asApp(R, (tx) => repoOrders.upsertOrders(tx, [paidA])));
  check('仓储：upsertOrders 写入 paid_at，session_id 写回同一个值', upsertPaid === 'ok', upsertPaid);
  const paidAgain = await why(asApp(R, (tx) => repoOrders.upsertOrders(tx, [paidA])));
  check('仓储：已付订单原样再 upsert 一次（落库每次都写）不被触发器拦', paidAgain === 'ok', paidAgain);
  for (const [what, sessionId] of [
    ['改挂到别的会话', 'wecom:wm-3'],
    ['session_id 置空', null],
  ] as const) {
    const moved = await why(asApp(R, (tx) => repoOrders.upsertOrders(tx, [{ ...paidA, sessionId }])));
    check(`仓储：upsertOrders 把订单${what}被触发器拒`, moved === 'trigger', moved);
  }
  const live = await asApp(R, (tx) => repoOrders.readLiveOrders(tx, ['wecom:wm-1', 'wecom:wm-3']));
  check('仓储：只读这批会话里未作废的订单', live.map((o) => o.id).join(',') === 'ord_a,ord_c', live.map((o) => o.id).join(','));
  check(
    '仓储：按 id upsert 以后一次为准，data 键序不变',
    live[0]?.status === 'paid' &&
      live[0].paidAt?.getTime() === T0 + 9 &&
      live[0].totalPrice === 5200 &&
      JSON.stringify(live[0].data) === '{"id":"ord_a","sessionId":"wecom:wm-1","status":"paid"}',
    JSON.stringify(live[0]),
  );
  check('仓储：空的会话列表读不到订单', (await asApp(R, (tx) => repoOrders.readLiveOrders(tx, []))).length === 0);

  // 条目版本：写入与全量读
  await q(
    `insert into catalog_items (tenant_id, kind, code, ord, payload, status) values ($1, 'route', 'r-v', 0, '{"id":"r-v"}', 'active')`,
    [R],
  );
  const vPayload = { id: 'r-v', zeta: 1, alpha: { yy: 2, bb: 1 } };
  await asApp(R, async (tx) => {
    await repoVersions.insertCatalogVersion(tx, {
      kind: 'route',
      code: 'r-v',
      version: 2,
      payload: vPayload,
      source: 'console',
      createdByName: '运营',
    });
    await repoVersions.insertCatalogVersion(tx, {
      kind: 'route',
      code: 'r-v',
      version: 1,
      payload: { id: 'r-v' },
      source: 'activate',
      createdByName: null,
    });
  });
  const vers = await asApp(R, (tx) => repoVersions.readCatalogVersions(tx));
  check(
    '仓储：条目版本全量读，按版本排序',
    vers.map((v) => `${v.kind}:${v.code}@${v.version}:${v.source}:${v.createdByName}`).join(',') ===
      'route:r-v@1:activate:null,route:r-v@2:console:运营',
    JSON.stringify(vers),
  );
  check('仓储：条目版本的 payload 键序不变', JSON.stringify(vers[1]?.payload) === JSON.stringify(vPayload));

  // trace 与护栏事件
  const turnId = randomUUID();
  await asApp(R, async (tx) => {
    await repoTraces.insertTurnTraces(tx, [
      {
        id: turnId,
        conversationId: 'wecom:wm-1',
        startedAt: new Date('2025-01-01T00:00:00Z'),
        durationMs: 1234,
        outcome: 'replied',
        sopVersion: 3,
        prefixHash: sha('p'),
        catalogVersions: { 'route:r-v': 2 },
        stageBefore: 'greeting',
        stageAfter: 'discovery',
        draft: '原稿',
        finalText: '终稿',
        calls: [{ name: 'search_routes' }],
        llm: [{ model: 'm', error: null }],
        signals: undefined,
      },
    ]);
    await repoTraces.insertGuardEvents(tx, [
      { turnId, ord: 0, guard: 'price', action: 'drop_sentence', removed: ['一句'], added: [] },
      { turnId, ord: 1, guard: 'link_whitelist', action: 'replace', removed: ['a'], added: ['b'] },
    ]);
  });
  const [tr] = await q<{ d: number; cv: string; s: unknown; g: number }>(
    `select duration_ms as d, catalog_versions::text as cv, signals as s,
            (select count(*)::int from guard_events g where g.tenant_id = t.tenant_id and g.turn_id = t.id) as g
       from turn_traces t where tenant_id = $1 and id = $2`,
    [R, turnId],
  );
  check(
    '仓储：trace 与两条护栏事件写进去了，没有 signals 时是 NULL',
    tr?.d === 1234 && tr.cv === '{"route:r-v":2}' && tr.s === null && tr.g === 2,
    JSON.stringify(tr),
  );

  // 用量：累加
  const delta = (over: Partial<UsageDelta> = {}): UsageDelta => ({
    day: '2025-01-01',
    model: 'glm',
    purpose: 'chat',
    calls: 1,
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: 50,
    reasoningTokens: 0,
    costMilliCny: 7,
    ...over,
  });
  await asApp(R, (tx) => repoUsage.addUsage(tx, [delta(), delta(), delta({ purpose: 'embedding' })]));
  await asApp(R, (tx) => repoUsage.addUsage(tx, [delta({ calls: 2, costMilliCny: 10 })]));
  const usage = await q<{ purpose: string; calls: number; p: number; c: number }>(
    `select purpose, calls, prompt_tokens::int as p, cost_milli_cny::int as c from usage_daily where tenant_id = $1 order by purpose`,
    [R],
  );
  check(
    '仓储：用量按（天、模型、用途）累加，同一批里重复的键先合并',
    JSON.stringify(usage) === '[{"purpose":"chat","calls":4,"p":300,"c":24},{"purpose":"embedding","calls":1,"p":100,"c":7}]',
    JSON.stringify(usage),
  );

  // 任务：入队、认领、改状态、取消
  const now = Date.now();
  const key = 'followup:wecom:wm-1:discovery';
  const jobIds = await asApp(R, async (tx) => ({
    a: await repoJobs.enqueueJob(tx, {
      kind: 'followup',
      dedupeKey: key,
      runAt: new Date(now - 120_000),
      payload: { stage: 'discovery' },
      maxAttempts: 1,
    }),
    again: await repoJobs.enqueueJob(tx, { kind: 'followup', dedupeKey: key, runAt: new Date(now - 60_000), payload: {}, maxAttempts: 1 }),
    b: await repoJobs.enqueueJob(tx, {
      kind: 'handoff_notify',
      dedupeKey: 'notify:1',
      runAt: new Date(now - 60_000),
      payload: {},
      maxAttempts: 3,
    }),
    c: await repoJobs.enqueueJob(tx, {
      kind: 'handoff_notify',
      dedupeKey: 'notify:2',
      runAt: new Date(now - 30_000),
      payload: {},
      maxAttempts: 3,
    }),
    later: await repoJobs.enqueueJob(tx, {
      kind: 'retention_purge',
      dedupeKey: 'retention_purge:2030-01-01',
      runAt: new Date(now + 3_600_000),
      payload: {},
      maxAttempts: 3,
    }),
  }));
  check(
    '仓储：入队返回 id；同一 dedupe_key 还没结束时再入队什么都不做、返回 null',
    jobIds.a !== null && jobIds.again === null && jobIds.b !== null && jobIds.c !== null && jobIds.later !== null,
    JSON.stringify(jobIds),
  );
  const claimed = await asApp(R, (tx) => repoJobs.claimDueJobs(tx, new Date(now), 2));
  check(
    '仓储：认领到点的 pending，按 run_at 先后、limit 条，改成 running、记 claimed_at',
    claimed.map((j) => j.id).join(',') === [jobIds.a, jobIds.b].join(',') &&
      claimed.every((j) => j.status === 'running' && j.claimedAt?.getTime() === now) &&
      claimed[0]?.kind === 'followup' &&
      claimed[0].dedupeKey === key &&
      claimed[0].maxAttempts === 1 &&
      JSON.stringify(claimed[0].payload) === '{"stage":"discovery"}',
    JSON.stringify(claimed),
  );
  const claimed2 = await asApp(R, (tx) => repoJobs.claimDueJobs(tx, new Date(now), 10));
  check(
    '仓储：认领过的不再认领，没到点的不认领',
    claimed2.map((j) => j.id).join(',') === String(jobIds.c),
    JSON.stringify(claimed2.map((j) => j.dedupeKey)),
  );
  const s1 = await asApp(R, (tx) => repoJobs.setJobStatus(tx, jobIds.a!, 'sending', { from: ['running'] }));
  const s2 = await asApp(R, (tx) => repoJobs.setJobStatus(tx, jobIds.a!, 'done', { from: ['pending', 'running'] }));
  const s3 = await asApp(R, (tx) => repoJobs.setJobStatus(tx, jobIds.a!, 'done'));
  const s4 = await asApp(R, (tx) =>
    repoJobs.setJobStatus(tx, jobIds.b!, 'pending', {
      from: ['running'],
      attemptsDelta: 1,
      lastError: 'timeout',
      runAt: new Date(now + 1000),
    }),
  );
  check('仓储：改状态时 from 限定当前状态', s1 && !s2 && s3 && s4, JSON.stringify([s1, s2, s3, s4]));
  const jobRows = await q<{ id: string; status: string; attempts: number; e: string | null; fin: boolean; run: Date }>(
    `select id, status, attempts, last_error as e, finished_at is not null as fin, run_at as run from jobs where tenant_id = $1 and id = any($2::uuid[])`,
    [R, [jobIds.a, jobIds.b]],
  );
  const ja = jobRows.find((j) => j.id === jobIds.a);
  const jb = jobRows.find((j) => j.id === jobIds.b);
  check(
    '仓储：改成结束的状态记 finished_at；回到 pending 不记，attempts 加 1、记 last_error、改 run_at',
    ja?.status === 'done' &&
      ja.fin &&
      jb?.status === 'pending' &&
      !jb.fin &&
      jb.attempts === 1 &&
      jb.e === 'timeout' &&
      jb.run.getTime() === now + 1000,
    JSON.stringify(jobRows),
  );
  const again = await asApp(R, (tx) =>
    repoJobs.enqueueJob(tx, { kind: 'followup', dedupeKey: key, runAt: new Date(now), payload: {}, maxAttempts: 1 }),
  );
  check('仓储：任务结束之后同一 dedupe_key 能再入队', again !== null && again !== jobIds.a);
  const cancelled = await asApp(R, (tx) => repoJobs.cancelPendingJobs(tx, key));
  const [cj] = await q<{ status: string; fin: boolean }>(
    `select status, finished_at is not null as fin from jobs where tenant_id = $1 and id = $2`,
    [R, again],
  );
  check('仓储：取消还没开始的任务，记 finished_at', cancelled === 1 && cj?.status === 'cancelled' && cj.fin, JSON.stringify(cj));
  check('仓储：没有 pending 的 key 取消 0 条', (await asApp(R, (tx) => repoJobs.cancelPendingJobs(tx, 'notify:2'))) === 0);

  // 发送账本：写入与按 msgid 改状态
  await asApp(R, (tx) =>
    repoOutbound.insertOutboundSends(tx, [
      {
        conversationId: 'wecom:wm-1',
        channelMsgid: 'out-1',
        messageSeq: 2,
        kind: 'human',
        sentAt: new Date(T0),
        status: 'accepted',
        errcode: null,
        failType: null,
      },
      {
        conversationId: 'wecom:wm-new',
        channelMsgid: 'out-2',
        messageSeq: null,
        kind: 'welcome',
        sentAt: new Date(T0),
        status: 'unknown',
        errcode: 45009,
        failType: null,
      },
    ]),
  );
  const f1 = await asApp(R, (tx) => repoOutbound.setOutboundStatus(tx, 'out-1', 'failed', { failType: 4 }));
  const f2 = await asApp(R, (tx) => repoOutbound.setOutboundStatus(tx, 'out-2', 'accepted'));
  const f3 = await asApp(R, (tx) => repoOutbound.setOutboundStatus(tx, 'out-none', 'failed'));
  const sends = await q<{ m: string; status: string; errcode: number | null; fail_type: number | null; seq: number | null }>(
    `select channel_msgid as m, status, errcode, fail_type, message_seq as seq from outbound_sends where tenant_id = $1 order by 1`,
    [R],
  );
  check(
    '仓储：发送账本写入，按 msgid 改状态；没给的 errcode、fail_type 不动；找不到的 msgid 返回 false',
    f1 &&
      f2 &&
      !f3 &&
      JSON.stringify(sends) ===
        '[{"m":"out-1","status":"failed","errcode":null,"fail_type":4,"seq":2},{"m":"out-2","status":"accepted","errcode":45009,"fail_type":null,"seq":null}]',
    JSON.stringify(sends),
  );
  // 预载（第 12 步）：只读各会话最后一条客户消息（last_customer_at）之后的发送；没有客户消息、没有会话行的不读
  const ins = (conversationId: string, channelMsgid: string, at: number) => ({
    conversationId,
    channelMsgid,
    messageSeq: null,
    kind: 'ai' as const,
    sentAt: new Date(at),
    status: 'accepted' as const,
    errcode: null,
    failType: null,
  });
  await asApp(R, (tx) =>
    repoOutbound.insertOutboundSends(tx, [
      ins('wecom:wm-1', 'out-3', T0 + 600),
      ins('wecom:wm-2', 'out-4', T0 + 600),
      ins('wecom:wm-1', 'out-5', T0 + 500),
    ]),
  );
  const pre = await asApp(R, (tx) => repoOutbound.readOutboundAfterLastCustomer(tx, ['wecom:wm-1', 'wecom:wm-2', 'wecom:wm-new']));
  check(
    '仓储：预载只读最后一条客户消息之后的发送（同一时刻的算），没有客户消息的会话与没有会话行的不读',
    JSON.stringify(pre.map((r) => [r.conversationId, r.channelMsgid, r.sentAt.getTime()])) ===
      JSON.stringify([
        ['wecom:wm-1', 'out-5', T0 + 500],
        ['wecom:wm-1', 'out-3', T0 + 600],
      ]),
    JSON.stringify(pre),
  );
  // 回执（第 12 步）：还不是 failed 的那一行记 failed 与 fail_type，返回会话 id；已是 failed、找不到的返回 null；没有会话行的也改
  const m1 = await asApp(R, (tx) => repoOutbound.markOutboundFailed(tx, 'out-3', 6));
  const m2 = await asApp(R, (tx) => repoOutbound.markOutboundFailed(tx, 'out-3', 4));
  const m3 = await asApp(R, (tx) => repoOutbound.markOutboundFailed(tx, 'out-none', 4));
  const m4 = await asApp(R, (tx) => repoOutbound.markOutboundFailed(tx, 'out-2', 10));
  const [o3] = await q<{ status: string; fail_type: number | null }>(
    `select status, fail_type from outbound_sends where tenant_id = $1 and channel_msgid = 'out-3'`,
    [R],
  );
  check(
    '仓储：markOutboundFailed 改还不是 failed 的那一行、返回会话 id；重复的回执与找不到的返回 null、不改 fail_type',
    m1 === 'wecom:wm-1' && m2 === null && m3 === null && m4 === 'wecom:wm-new' && o3?.status === 'failed' && o3.fail_type === 6,
    JSON.stringify({ m1, m2, m3, m4, o3 }),
  );
  // 同一 msgid 再写一次（第 12 步审查之后：超时那一刻先记 unknown，之后升 accepted 或收到回执）：upsert 成一行，只认三种变化
  const up = (
    channelMsgid: string,
    status: 'accepted' | 'unknown' | 'failed' | 'rejected',
    at: number,
    more: Partial<{ errcode: number; failType: number }> = {},
  ) => ({
    ...ins('wecom:wm-1', channelMsgid, at),
    status,
    errcode: more.errcode ?? null,
    failType: more.failType ?? null,
  });
  await asApp(R, (tx) => repoOutbound.insertOutboundSends(tx, [up('out-6', 'unknown', T0 + 700), up('out-7', 'accepted', T0 + 700)]));
  await asApp(R, (tx) =>
    repoOutbound.insertOutboundSends(tx, [
      up('out-6', 'accepted', T0 + 800), // unknown 升 accepted，sent_at 往后挪
      up('out-7', 'unknown', T0 + 900), // accepted 不降回 unknown
      up('out-3', 'unknown', T0 + 900), // 已是 failed 的不动
      up('out-8', 'unknown', T0 + 700, { errcode: 45009 }), // 同一批里同一 msgid 两行：只留后一行
      up('out-8', 'failed', T0 + 750, { failType: 4 }),
    ]),
  );
  const ups = await q<{ m: string; status: string; at: number; errcode: number | null; fail_type: number | null }>(
    `select channel_msgid as m, status, (extract(epoch from sent_at) * 1000)::float8 as at, errcode, fail_type from outbound_sends where tenant_id = $1 and channel_msgid in ('out-3', 'out-6', 'out-7', 'out-8') order by 1`,
    [R],
  );
  check(
    '仓储：同一 msgid 再写是 upsert（仍一行）：unknown 升 accepted、sent_at 往后挪；accepted 不降回 unknown；已 failed 的不动；同一批两行只留后一行',
    JSON.stringify(ups.map((r) => [r.m, r.status, Number(r.at) - T0, r.errcode, r.fail_type])) ===
      JSON.stringify([
        ['out-3', 'failed', 600, null, 6],
        ['out-6', 'accepted', 800, null, null],
        ['out-7', 'accepted', 700, null, null],
        ['out-8', 'failed', 750, null, 4],
      ]),
    JSON.stringify(ups),
  );
  // 预载的下界：last_customer_at（企微 send_time）与那条客户消息本机收到的时刻（messages.at）里较早的一个
  await asApp(R, (tx) => repoOutbound.insertOutboundSends(tx, [ins('wecom:wm-1', 'out-9', T0 + 100)]));
  const pre2 = await asApp(R, (tx) => repoOutbound.readOutboundAfterLastCustomer(tx, ['wecom:wm-1']));
  check(
    '仓储：预载从 min(last_customer_at, 最后一条客户消息的 at) 读起（本机钟比企微慢时也读得全）',
    pre2.some((r) => r.channelMsgid === 'out-9') && !pre2.some((r) => r.channelMsgid === 'out-1'),
    JSON.stringify(pre2.map((r) => [r.channelMsgid, r.sentAt.getTime() - T0])),
  );

  // 快捷回复：增改、归档、上下移
  const titles = async (): Promise<string> => (await asApp(R, (tx) => repoQr.listQuickReplies(tx))).map((x) => x.title).join(',');
  const move = (id: string, dir: 'up' | 'down'): Promise<boolean> => asApp(R, (tx) => repoQr.moveQuickReply(tx, id, dir, '小林'));
  const qa = await asApp(R, (tx) => repoQr.createQuickReply(tx, { title: '问候', body: '您好', byName: '小林' }));
  const qb = await asApp(R, (tx) => repoQr.createQuickReply(tx, { title: '报价', body: '价格是', byName: '小林' }));
  const qc = await asApp(R, (tx) => repoQr.createQuickReply(tx, { title: '收尾', body: '再见', byName: '小林' }));
  check('仓储：快捷回复新建排在最后', (await titles()) === '问候,报价,收尾' && qa.ord === 0 && qc.ord === 2 && qa.updatedByName === '小林');
  check('仓储：快捷回复上移与上一条交换', (await move(qc.id, 'up')) && (await titles()) === '问候,收尾,报价', await titles());
  check(
    '仓储：已在最前不能上移、已在最后不能下移',
    !(await move(qa.id, 'up')) && !(await move(qb.id, 'down')) && (await titles()) === '问候,收尾,报价',
  );
  // 并发新建可能留下相同的 ord：下移照样换得动，ord 重排成 0..n-1
  await q(`update quick_replies set ord = 5 where tenant_id = $1`, [R]);
  const tied = await asApp(R, (tx) => repoQr.listQuickReplies(tx));
  const movedDown = await move(tied[0]!.id, 'down');
  const afterTie = await asApp(R, (tx) => repoQr.listQuickReplies(tx));
  check(
    '仓储：ord 相同时下移照样生效，ord 重排成 0、1、2',
    movedDown &&
      afterTie.map((x) => x.id).join(',') === [tied[1]!.id, tied[0]!.id, tied[2]!.id].join(',') &&
      afterTie.map((x) => x.ord).join(',') === '0,1,2',
    JSON.stringify(afterTie.map((x) => [x.title, x.ord])),
  );
  const edited = await asApp(R, (tx) => repoQr.updateQuickReply(tx, qb.id, { title: '报价说明', body: '价格含门票', byName: '老王' }));
  check(
    '仓储：改快捷回复的标题与正文，记改的人',
    edited?.title === '报价说明' && edited.body === '价格含门票' && edited.updatedByName === '老王',
  );
  const archived = await asApp(R, (tx) => repoQr.archiveQuickReply(tx, qa.id, '小林'));
  check(
    '仓储：归档之后不再列出；再归档、再改、再移动都不生效',
    archived &&
      !(await asApp(R, (tx) => repoQr.archiveQuickReply(tx, qa.id, '小林'))) &&
      (await asApp(R, (tx) => repoQr.updateQuickReply(tx, qa.id, { title: 'x', body: 'y', byName: null }))) === null &&
      !(await move(qa.id, 'down')) &&
      !(await titles()).includes('问候'),
    await titles(),
  );

  // 同意记录：追加
  await asApp(R, (tx) =>
    repoConsents.appendConsents(tx, [
      { conversationId: 'wecom:wm-1', category: 'health', decision: 'asked', noticeVersion: 1, evidence: '我妈有高血压', at: new Date(T0) },
      {
        conversationId: 'wecom:wm-1',
        category: 'health',
        decision: 'granted',
        noticeVersion: 1,
        evidence: 'menu-yes',
        at: new Date(T0 + 1),
      },
    ]),
  );
  const consentRows = await q<{ d: string }>(`select decision as d from consents where tenant_id = $1 order by at`, [R]);
  check('仓储：同意记录追加两条', consentRows.map((c) => c.d).join(',') === 'asked,granted');

  // 隐私说明：平台发布，应用读最新
  const p1 = await asPlatform(R, (tx) => repoPrivacy.publishPrivacyNotice(tx, { body: '第一版', publishedByName: 'privacy-publish' }));
  const p2 = await asPlatform(R, (tx) => repoPrivacy.publishPrivacyNotice(tx, { body: '第二版', publishedByName: 'privacy-publish' }));
  const latest = await asApp(R, (tx) => repoPrivacy.readLatestPrivacyNotice(tx));
  check(
    '仓储：隐私说明版本号从 1 递增，应用读到最新一版',
    p1.version === 1 &&
      p2.version === 2 &&
      latest?.version === 2 &&
      latest.body === '第二版' &&
      latest.publishedByName === 'privacy-publish',
    JSON.stringify(latest),
  );
  check('仓储：没发布过隐私说明的租户读到 null', (await asApp(B, (tx) => repoPrivacy.readLatestPrivacyNotice(tx))) === null);

  // 运行数字：窗口内 12 轮——wm-1 十轮 replied（100…1000 毫秒）、wm-2 一轮 handoff 且有一次模型调用出错、wm-3 一轮 error；
  // 窗口外另有一轮（上面那条 2025 年的 trace）
  const hourAgo = iso(Date.now() - 3_600_000);
  const seedTrace = (conv: string, outcome: string, ms: number, llm: unknown[]): Promise<unknown> =>
    q(
      `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
       values ($1, $2, $3, $4::timestamptz, $5, $6, $7, '{}', '[]', $8::json)`,
      [R, randomUUID(), conv, hourAgo, ms, outcome, sha('p'), JSON.stringify(llm)],
    );
  for (let i = 1; i <= 10; i++) await seedTrace('wecom:wm-1', 'replied', i * 100, [{ model: 'm', error: null }]);
  await seedTrace('wecom:wm-2', 'handoff', 50, [
    { model: 'm', error: 'timeout' },
    { model: 'm', error: null },
  ]);
  await seedTrace('wecom:wm-3', 'error', 5, []);
  for (const [day, cost] of [
    ['2030-01-10', 1500],
    ['2030-01-09', 500],
    ['2029-12-31', 9999],
  ] as const) {
    await q(`insert into usage_daily (tenant_id, day, model, purpose, cost_milli_cny) values ($1, $2, 'glm', 'chat', $3)`, [R, day, cost]);
  }
  const range = { since: new Date(Date.now() - 7 * 86_400_000), sinceDay: '2030-01-04', today: '2030-01-10' };
  const metrics = await asApp(R, (tx) => repoMetrics.readMetrics(tx, range));
  const near = (x: number | null, want: number): boolean => x !== null && Math.abs(x - want) < 1e-9;
  check(
    '仓储：运行数字的四条 SQL（轮次、回复用时 90 分位、转人工率、AI 出错率、今天与窗口内的费用）',
    metrics.turns === 12 &&
      near(metrics.replyP90Ms, 910) &&
      near(metrics.handoffRate, 1 / 3) &&
      near(metrics.aiErrorRate, 2 / 12) &&
      metrics.costTodayMilliCny === 1500 &&
      metrics.costRangeMilliCny === 2000,
    JSON.stringify(metrics),
  );
  const empty = await asApp(B, (tx) => repoMetrics.readMetrics(tx, range));
  check(
    '仓储：没有数据时轮次与费用为 0，三个比率为 null',
    JSON.stringify(empty) ===
      '{"turns":0,"replyP90Ms":null,"handoffRate":null,"aiErrorRate":null,"costTodayMilliCny":0,"costRangeMilliCny":0}',
    JSON.stringify(empty),
  );

  // 审计：writeAuditAs 用给定的操作者，writeAudit 照旧取上下文的
  await asApp(R, async (tx) => {
    await writeAuditAs(
      tx,
      { kind: 'user', userId: U, name: '小林', ip: '10.0.0.9' },
      { action: 'test.as', targetType: 'conversation', targetId: r1.ref },
    );
    await writeAudit(tx, { action: 'test.ctx' });
  });
  const auditRows = await q<{
    action: string;
    kind: string;
    uid: string | null;
    name: string | null;
    ip: string | null;
    tgt: string | null;
  }>(
    `select action, actor_kind as kind, actor_user_id as uid, actor_name as name, host(ip) as ip, target_id as tgt
       from audit_log where tenant_id = $1 and action like 'test.%' order by id`,
    [R],
  );
  check(
    'writeAuditAs：审计行记给定的操作者与 IP，租户取事务的；writeAudit 照旧取上下文的操作者',
    JSON.stringify(auditRows) ===
      JSON.stringify([
        { action: 'test.as', kind: 'user', uid: U, name: '小林', ip: '10.0.0.9', tgt: r1.ref },
        { action: 'test.ctx', kind: 'system', uid: null, name: null, ip: null, tgt: null },
      ]),
    JSON.stringify(auditRows),
  );
}

// ================ 03：渠道表（约束、ord、迁移表每一格、仓储冒烟；授权以真实 PG 为准） ================
{
  const repoAcct = await import('./repo/channel-accounts.js');
  const repoInbox = await import('./repo/channel-inbox.js');
  const repoOutbound = await import('./repo/outbound.js');
  const { OUTBOUND_TRANSITIONS, INBOX_TRANSITIONS } = await import('../channels/transitions.js');
  const { INBOX_STATES, OUTBOUND_STATUSES } = await import('../shared/channel-types.js');
  type OutboundStatus = import('../shared/channel-types.js').OutboundStatus;
  type InboxState = import('../shared/channel-types.js').InboxState;
  type OutboundWriter = import('../channels/transitions.js').OutboundWriter;
  /** 被谁拒的逐条比（同 02 的 expectWhy，标签换成 03） */
  const expectWhy03 = async (cases: [string, () => Promise<unknown>, string][]): Promise<void> => {
    for (const [what, run, want] of cases) {
      const got = await why(run());
      check(`03 约束：${what}${want === 'ok' ? ' 能插入' : ` 被 ${want} 拒`}`, got === want, got);
    }
  };
  interface AcctOver {
    kind?: string;
    name?: string;
    status?: string;
    idPrefix?: string | null;
    corpId?: string | null;
    openKfid?: string | null;
    secrets?: boolean;
    keyId?: string | null;
    cursor?: string | null;
    until?: string | null;
    settings?: string;
  }
  /** 一个账号（超级用户直接插）：缺省是合法的企微账号，前缀 wecom: */
  const insAcct = (tenantId: string, key: string, o: AcctOver = {}): Promise<{ id: string }[]> =>
    q<{ id: string }>(
      `insert into channel_accounts (tenant_id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id, cursor, record_only_until, settings)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9::boolean then decode(repeat('07', 44), 'hex') end, $10, $11, $12::timestamptz, $13::json)
       returning id`,
      [
        tenantId,
        key,
        o.kind ?? 'wecom_kf',
        o.name ?? '客服',
        o.status ?? 'active',
        'idPrefix' in o ? o.idPrefix : 'wecom:',
        'corpId' in o ? o.corpId : 'corp-a',
        'openKfid' in o ? o.openKfid : `kf-${key}`,
        o.secrets ?? true,
        'keyId' in o ? o.keyId : 'k1',
        o.cursor ?? null,
        o.until ?? null,
        o.settings ?? '{}',
      ],
    );
  const webAcct = (tenantId: string, key: string, o: AcctOver = {}): Promise<{ id: string }[]> =>
    insAcct(tenantId, key, { kind: 'web', idPrefix: null, corpId: null, openKfid: null, secrets: false, keyId: null, ...o });

  // ---- channel_accounts 的 CHECK 与唯一 ----
  await expectWhy03([
    ['key 以数字开头', () => insAcct(A, '1kf'), 'channel_accounts_key_check'],
    ['key 有大写', () => insAcct(A, 'Kf-a'), 'channel_accounts_key_check'],
    ['key 只有一个字符', () => insAcct(A, 'k'), 'channel_accounts_key_check'],
    ['key 32 个字符', () => insAcct(A, `k${'a'.repeat(31)}`), 'channel_accounts_key_check'],
    ['kind 只有两种', () => insAcct(A, 'kf-x', { kind: 'sms' }), 'channel_accounts_kind_check'],
    ['name 为空', () => insAcct(A, 'kf-x', { name: '' }), 'channel_accounts_name_check'],
    ['name 41 个字', () => insAcct(A, 'kf-x', { name: '名'.repeat(41) }), 'channel_accounts_name_check'],
    ['status 只有三种', () => insAcct(A, 'kf-x', { status: 'paused' }), 'channel_accounts_status_check'],
    ['settings 不是对象', () => insAcct(A, 'kf-x', { settings: '[]' }), 'channel_accounts_settings_check'],
    // spec 的 DDL 原样写成 id_prefix IN (…) 时，NULL 会让整个 CHECK 得 NULL、被放行
    ['企微账号没有前缀', () => insAcct(A, 'kf-x', { idPrefix: null }), 'channel_accounts_wecom_check'],
    ['企微账号的前缀不是 wecom: 或 wecom:<key>:', () => insAcct(A, 'kf-x', { idPrefix: 'wecom:kf-y:' }), 'channel_accounts_wecom_check'],
    ['企微账号没有 corp_id', () => insAcct(A, 'kf-x', { corpId: null }), 'channel_accounts_wecom_check'],
    ['企微账号没有 open_kfid', () => insAcct(A, 'kf-x', { openKfid: null }), 'channel_accounts_wecom_check'],
    ['企微账号没有凭据密文', () => insAcct(A, 'kf-x', { secrets: false }), 'channel_accounts_wecom_check'],
    ['企微账号没有 secrets_key_id', () => insAcct(A, 'kf-x', { keyId: null }), 'channel_accounts_wecom_check'],
    ['网页账号带前缀', () => webAcct(A, 'web-x', { idPrefix: 'wecom:' }), 'channel_accounts_web_check'],
    ['网页账号带 corp_id', () => webAcct(A, 'web-x', { corpId: 'corp-a' }), 'channel_accounts_web_check'],
    ['网页账号带 open_kfid', () => webAcct(A, 'web-x', { openKfid: 'kf-w' }), 'channel_accounts_web_check'],
    ['网页账号带凭据密文', () => webAcct(A, 'web-x', { secrets: true }), 'channel_accounts_web_check'],
    ['网页账号带 cursor', () => webAcct(A, 'web-x', { cursor: 'c-1' }), 'channel_accounts_web_check'],
    ['网页账号带恢复截止点', () => webAcct(A, 'web-x', { until: iso(Date.now()) }), 'channel_accounts_web_check'],
    ['租户的第一个企微账号，前缀 wecom:', () => insAcct(A, 'kf-main'), 'ok'],
    ['第二个企微账号，前缀 wecom:<key>:', () => insAcct(A, 'kf-two', { idPrefix: 'wecom:kf-two:' }), 'ok'],
    [
      '同租户 key 重复',
      () => insAcct(A, 'kf-main', { idPrefix: 'wecom:kf-main:', openKfid: 'kf-other' }),
      'channel_accounts_tenant_id_key_uq',
    ],
    ['同租户前缀重复', () => insAcct(A, 'kf-three'), 'channel_accounts_tenant_id_id_prefix_uq'],
    [
      '同租户 open_kfid 重复',
      () => insAcct(A, 'kf-four', { idPrefix: 'wecom:kf-four:', openKfid: 'kf-kf-main' }),
      'channel_accounts_tenant_id_open_kfid_uq',
    ],
    ['网页账号（前缀为空）', () => webAcct(A, 'web-a'), 'ok'],
    ['第二个网页账号（前缀同为空，不算重复）', () => webAcct(A, 'web-b'), 'ok'],
    ['别的租户同一个 key、同一个前缀', () => insAcct(B, 'kf-main'), 'ok'],
    ['租户不存在', () => insAcct(randomUUID(), 'kf-z'), 'channel_accounts_tenant_id_tenants_id_fk'],
  ]);
  const acctId = async (tenantId: string, key: string): Promise<string> =>
    (await q<{ id: string }>(`select id from channel_accounts where tenant_id = $1 and key = $2`, [tenantId, key]))[0]!.id;
  const AK = await acctId(A, 'kf-main');
  const AK2 = await acctId(A, 'kf-two');
  const BK = await acctId(B, 'kf-main');
  const [defaults] = await q<{ status: string; settings: string; created: boolean }>(
    `select status, settings::text as settings, created_at is not null and updated_at is not null as created from channel_accounts where id = $1`,
    [AK],
  );
  check(
    '03 约束：账号缺省 active、settings 缺省 {}',
    defaults?.status === 'active' && defaults.settings === '{}' && defaults.created,
    JSON.stringify(defaults),
  );

  // ---- channel_inbox 的 CHECK、外键与唯一 ----
  const insInbox = (
    tenantId: string,
    accountId: string,
    msgid: string,
    o: { kind?: string; conv?: string | null; state?: string; reason?: string | null; payload?: string | null } = {},
  ): Promise<unknown> =>
    q(
      `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, reason, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8::json)`,
      [
        tenantId,
        accountId,
        msgid,
        o.kind ?? 'message',
        'conv' in o ? o.conv : 'wecom:wmIn1',
        o.state ?? 'received',
        o.reason ?? null,
        o.payload ?? null,
      ],
    );
  await expectWhy03([
    ['入站 msgid 为空', () => insInbox(A, AK, ''), 'channel_inbox_msgid_check'],
    ['入站 msgid 129 字节（43 个汉字）', () => insInbox(A, AK, '汉'.repeat(43)), 'channel_inbox_msgid_check'],
    ['入站 msgid 128 字节', () => insInbox(A, AK, 'x'.repeat(128)), 'ok'],
    ['入站种类只有五种', () => insInbox(A, AK, 'm-kind', { kind: 'image' }), 'channel_inbox_kind_check'],
    ['入站状态只有五种', () => insInbox(A, AK, 'm-state', { state: 'pending' }), 'channel_inbox_state_check'],
    ['abandoned 的原因只有五种', () => insInbox(A, AK, 'm-r', { state: 'abandoned', reason: 'oops' }), 'channel_inbox_reason_check'],
    ['abandoned 没写原因', () => insInbox(A, AK, 'm-r', { state: 'abandoned' }), 'channel_inbox_reason_iff_abandoned'],
    ['没结束的行带原因', () => insInbox(A, AK, 'm-r', { reason: 'poison' }), 'channel_inbox_reason_iff_abandoned'],
    ['done 带原文', () => insInbox(A, AK, 'm-p', { state: 'done', payload: '{"text":"x"}' }), 'channel_inbox_payload_check'],
    [
      'abandoned 带原文',
      () => insInbox(A, AK, 'm-p', { state: 'abandoned', reason: 'too_old', payload: '{"text":"x"}' }),
      'channel_inbox_payload_check',
    ],
    ['客户消息没有会话 id', () => insInbox(A, AK, 'm-c', { conv: null }), 'channel_inbox_conversation_check'],
    ['回执没有会话 id', () => insInbox(A, AK, 'm-c', { kind: 'send_fail', conv: null }), 'channel_inbox_conversation_check'],
    ['导入的 legacy 行只有 msgid', () => insInbox(A, AK, 'm-legacy', { kind: 'legacy', conv: null, state: 'done' }), 'ok'],
    ['账号不存在', () => insInbox(A, randomUUID(), 'm-fk'), 'channel_inbox_account_fk'],
    ['账号在别的租户', () => insInbox(A, BK, 'm-fk'), 'channel_inbox_account_fk'],
    ['同一账号同一 msgid', () => insInbox(A, AK, 'm-legacy'), 'channel_inbox_tenant_id_account_id_msgid_uq'],
    ['同一 msgid 在另一个账号', () => insInbox(A, AK2, 'm-legacy'), 'ok'],
  ]);

  // ---- outbound_sends 的新列与新状态、conversations.channel_account_id ----
  const insSend03 = (tenantId: string, msgid: string, o: { status?: string; payload?: string | null; accountId?: string | null } = {}) =>
    q(
      `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status, payload, account_id)
       values ($1, 'wecom:wmOut1', $2, 'ai', now(), $3, $4::json, $5)`,
      [tenantId, msgid, o.status ?? 'pending', o.payload ?? null, o.accountId ?? null],
    );
  const TEXT = '{"msgtype":"text","text":{"content":"您好"}}';
  await expectWhy03([
    ['pending 带要发的内容', () => insSend03(A, 'o3-pending', { payload: TEXT, accountId: AK }), 'ok'],
    ['sending 带要发的内容', () => insSend03(A, 'o3-sending', { status: 'sending', payload: TEXT, accountId: AK }), 'ok'],
    ['cancelled、内容为空', () => insSend03(A, 'o3-cancelled', { status: 'cancelled', accountId: AK }), 'ok'],
    ['accepted 带内容', () => insSend03(A, 'o3-acc', { status: 'accepted', payload: TEXT }), 'outbound_sends_payload_check'],
    ['cancelled 带内容', () => insSend03(A, 'o3-can', { status: 'cancelled', payload: TEXT }), 'outbound_sends_payload_check'],
    ['状态 sent 不在七种里', () => insSend03(A, 'o3-sent', { status: 'sent' }), 'outbound_sends_status_check'],
    ['出站的账号不存在', () => insSend03(A, 'o3-fk', { accountId: randomUUID() }), 'outbound_sends_account_fk'],
    ['出站的账号在别的租户', () => insSend03(A, 'o3-fk', { accountId: BK }), 'outbound_sends_account_fk'],
    [
      '会话的 channel_account_id 不存在',
      () =>
        q(
          `insert into conversations (tenant_id, id, channel, stage, handed_over, state, created_at, updated_at, channel_account_id)
           values ($1, 'wecom:kf-two:wmCa1', 'wecom', 'greeting', false, '{"id":"wecom:kf-two:wmCa1"}', now(), now(), $2)`,
          [A, randomUUID()],
        ),
      'conversations_channel_account_fk',
    ],
    [
      '会话挂在本租户的第二个企微账号上',
      () =>
        q(
          `insert into conversations (tenant_id, id, channel, stage, handed_over, state, created_at, updated_at, channel_account_id)
           values ($1, 'wecom:kf-two:wmCa1', 'wecom', 'greeting', false, '{"id":"wecom:kf-two:wmCa1"}', now(), now(), $2)`,
          [A, AK2],
        ),
      'ok',
    ],
  ]);
  // 02 约束那一段用 02 的写法（不带新列）插过一行 32 个 x 的 msgid
  const [legacyAny] = await q<{ account_id: string | null; inbox_id: string | null; segment: number; attempts: number; payload: unknown }>(
    `select account_id, inbox_id, segment, attempts, payload from outbound_sends where tenant_id = $1 and channel_msgid = repeat('x', 32)`,
    [A],
  );
  check(
    '03 约束：02 写法插入的出站行，新列是空或缺省值（account_id、inbox_id、payload 为空，segment、attempts 为 0）',
    legacyAny?.account_id === null &&
      legacyAny.inbox_id === null &&
      legacyAny.segment === 0 &&
      legacyAny.attempts === 0 &&
      legacyAny.payload === null,
    JSON.stringify(legacyAny),
  );

  // ---- 迁移表本身与 spec 的表格逐格一致（spec「出站：投递状态」、R3）----
  // 出站：'from>to' → 谁写；from 为空表示库里还没有这一行
  const OUT_SPEC: Record<string, string> = {
    '>pending': 'plan',
    '>accepted': 'settle',
    '>rejected': 'settle',
    '>unknown': 'settle',
    '>failed': 'receipt',
    'pending>sending': 'mark',
    'pending>accepted': 'settle',
    'pending>rejected': 'settle',
    'pending>unknown': 'settle',
    'pending>cancelled': 'cancel,recover',
    'pending>failed': 'receipt',
    'sending>accepted': 'settle',
    'sending>rejected': 'settle',
    'sending>unknown': 'recover,settle',
    'sending>cancelled': 'cancel',
    'sending>pending': 'unmark',
    'sending>failed': 'receipt',
    'unknown>accepted': 'settle',
    'unknown>unknown': 'settle',
    'unknown>failed': 'receipt',
    'accepted>failed': 'receipt',
  };
  const outTable = Object.fromEntries(OUTBOUND_TRANSITIONS.map((t) => [`${t.from ?? ''}>${t.to}`, [...t.by].toSorted().join(',')]));
  check(
    '03 迁移表：出站的表与 spec 的表格逐格一致（rejected、failed、cancelled 没有出边）',
    JSON.stringify(Object.entries(outTable).toSorted()) === JSON.stringify(Object.entries(OUT_SPEC).toSorted()) &&
      OUTBOUND_TRANSITIONS.length === Object.keys(OUT_SPEC).length,
    JSON.stringify(outTable),
  );
  const IN_SPEC = [
    '>received',
    '>done',
    '>abandoned',
    'received>recorded',
    'received>done',
    'received>abandoned',
    'recorded>replied',
    'recorded>done',
    'recorded>abandoned',
    'replied>done',
    'replied>abandoned',
  ];
  check(
    '03 迁移表：入站的表与 R3 一致（只往前走，done、abandoned 没有出边）',
    JSON.stringify(INBOX_TRANSITIONS.map((t) => `${t.from ?? ''}>${t.to}`).toSorted()) === JSON.stringify(IN_SPEC.toSorted()),
    JSON.stringify(INBOX_TRANSITIONS),
  );

  // ---- 出站：短事务（transitionOutbound）的每一格：7 种已有状态 × 7 种目标 × 7 个写入方 ----
  const WRITERS: OutboundWriter[] = ['plan', 'mark', 'settle', 'cancel', 'unmark', 'recover', 'receipt'];
  const code = (s: string): string => s.slice(0, 3);
  const keeps = (s: string): boolean => s === 'pending' || s === 'sending';
  const T3 = Date.parse('2026-10-09T08:00:00.000Z');
  const seedOut = async (rows: { msgid: string; status: string }[]): Promise<void> => {
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      await q(
        `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status, errcode, attempts, payload, account_id)
         select $1, 'wecom:wmTr', m, 'ai', $2::timestamptz, s, 1, 1, case when s in ('pending', 'sending') then $3::json end, $4
           from unnest($5::text[], $6::text[]) as u(m, s)`,
        [A, iso(T3), TEXT, AK, part.map((r) => r.msgid), part.map((r) => r.status)],
      );
    }
  };
  interface OutState {
    m: string;
    status: string;
    errcode: number | null;
    attempts: number;
    payload: unknown;
    at: number;
  }
  const readOut = async (prefix: string): Promise<Map<string, OutState>> =>
    new Map(
      (
        await q<OutState>(
          `select channel_msgid as m, status, errcode, attempts, payload, (extract(epoch from sent_at) * 1000)::float8 as at
             from outbound_sends where tenant_id = $1 and channel_msgid like $2`,
          [A, `${prefix}%`],
        )
      ).map((r) => [r.m, r]),
    );
  const cells: { msgid: string; from: OutboundStatus; to: OutboundStatus; by: OutboundWriter }[] = [];
  for (const from of OUTBOUND_STATUSES)
    for (const to of OUTBOUND_STATUSES) for (const by of WRITERS) cells.push({ msgid: `t:${code(from)}:${code(to)}:${by}`, from, to, by });
  await seedOut(cells.map((c) => ({ msgid: c.msgid, status: c.from })));
  const changed = new Map<string, boolean>();
  for (const c of cells) {
    const r = await asApp(A, (tx) => repoOutbound.transitionOutbound(tx, c.msgid, c.to, c.by, { errcode: 9 }));
    changed.set(c.msgid, r !== null);
  }
  const outAfter = await readOut('t:');
  const wrongCells: string[] = [];
  for (const c of cells) {
    const allowed = (OUT_SPEC[`${c.from}>${c.to}`] ?? '').split(',').includes(c.by);
    const row = outAfter.get(c.msgid);
    const ok = allowed
      ? changed.get(c.msgid) === true &&
        row?.status === c.to &&
        row.errcode === 9 &&
        (keeps(c.to) ? row.payload !== null : row.payload === null)
      : changed.get(c.msgid) === false &&
        row?.status === c.from &&
        row.errcode === 1 &&
        (keeps(c.from) ? row.payload !== null : row.payload === null);
    if (!ok) wrongCells.push(`${c.from}>${c.to} by ${c.by}${allowed ? '（应改）' : '（不应改）'}: ${JSON.stringify(row)}`);
  }
  check(
    `03 迁移表：出站短事务 ${cells.length} 格（7 × 7 × 7 写入方），表里的改了（结果与取消同一条语句把 payload 置空），表外的一个字节没动`,
    wrongCells.length === 0 && outAfter.size === cells.length,
    wrongCells.slice(0, 5).join(' | '),
  );
  const noRow = await asApp(A, (tx) => repoOutbound.transitionOutbound(tx, 'o3-none', 'accepted', 'settle'));
  check('03 迁移表：短事务对库里没有的行什么都不插，返回 null', noRow === null && (await readOut('o3-none')).size === 0);

  // ---- 出站：会话落库的 upsert（insertOutboundSends）的每一格：没有这一行 + 7 种已有状态 × 7 种目标 ----
  const FLUSH: OutboundWriter[] = ['plan', 'settle', 'cancel', 'receipt'];
  const upCells: { msgid: string; from: OutboundStatus | null; to: OutboundStatus }[] = [];
  for (const from of [null, ...OUTBOUND_STATUSES])
    for (const to of OUTBOUND_STATUSES) upCells.push({ msgid: `u:${from ? code(from) : 'new'}:${code(to)}`, from, to });
  await seedOut(upCells.filter((c) => c.from !== null).map((c) => ({ msgid: c.msgid, status: c.from! })));
  for (const c of upCells) {
    await asApp(A, (tx) =>
      repoOutbound.insertOutboundSends(tx, [
        {
          conversationId: 'wecom:wmTr',
          channelMsgid: c.msgid,
          messageSeq: null,
          kind: 'ai',
          sentAt: new Date(T3 + 1000),
          status: c.to,
          errcode: 9,
          failType: null,
          accountId: AK,
          attempts: 3,
          payload: { msgtype: 'text', text: { content: '新的' } },
        },
      ]),
    );
  }
  const upAfter = await readOut('u:');
  const wrongUp: string[] = [];
  for (const c of upCells) {
    const allowed = (OUT_SPEC[`${c.from ?? ''}>${c.to}`] ?? '').split(',').some((w) => FLUSH.includes(w as OutboundWriter));
    const row = upAfter.get(c.msgid);
    let ok: boolean;
    if (c.from === null) {
      ok = allowed
        ? row?.status === c.to &&
          row.errcode === 9 &&
          row.attempts === 3 &&
          (c.to === 'pending' ? row.payload !== null : row.payload === null)
        : row === undefined;
    } else {
      ok = allowed
        ? row?.status === c.to && row.errcode === 9 && row.attempts === 3 && row.at === T3 + 1000 && row.payload === null
        : row?.status === c.from &&
          row.errcode === 1 &&
          row.attempts === 1 &&
          row.at === T3 &&
          (keeps(c.from) ? row.payload !== null : row.payload === null);
    }
    if (!ok) wrongUp.push(`${c.from ?? '（没有）'}>${c.to}${allowed ? '（应改）' : '（不应改）'}: ${JSON.stringify(row)}`);
  }
  check(
    `03 迁移表：会话落库的 upsert ${upCells.length} 格（没有这一行与 7 种已有状态 × 7 种目标）按 plan/settle/cancel/receipt 的格子写：pending 遇到已有的行不改，sending 只有 markSending 写，终态不回退，cancelled 与 sending 不凭空插入`,
    wrongUp.length === 0,
    wrongUp.slice(0, 5).join(' | '),
  );
  // 验收 17 的两个例子单列
  const exA = upAfter.get('u:fai:acc');
  const exB = upAfter.get('u:can:pen');
  check(
    '03 验收 17：对 failed 写 accepted、对 cancelled 写 pending 都不改库',
    exA?.status === 'failed' && exB?.status === 'cancelled' && exB.payload === null,
    JSON.stringify({ exA, exB }),
  );

  // ---- 同一批里同一 msgid 的几次写：按先后逐轮判 ----
  const w = (msgid: string, status: OutboundStatus, at: number, payload: unknown = null) => ({
    conversationId: 'wecom:wmTr',
    channelMsgid: msgid,
    messageSeq: null,
    kind: 'ai' as const,
    sentAt: new Date(at),
    status,
    errcode: null,
    failType: null,
    accountId: AK,
    payload,
  });
  await asApp(A, (tx) =>
    repoOutbound.insertOutboundSends(tx, [
      w('b:pend-cancel', 'pending', T3, { msgtype: 'text' }),
      w('b:pend-cancel', 'cancelled', T3 + 10),
      w('b:acc-late-pend', 'accepted', T3),
      w('b:acc-late-pend', 'pending', T3 + 10, { msgtype: 'text' }),
      w('b:pend-sending', 'pending', T3, { msgtype: 'text' }),
      w('b:pend-sending', 'sending', T3 + 10),
    ]),
  );
  const batch = await readOut('b:');
  check(
    '03 落库：同一批里先 pending 后 cancelled（R6 下 pending 还没落库就被接手）落成 cancelled、内容为空',
    batch.get('b:pend-cancel')?.status === 'cancelled' && batch.get('b:pend-cancel')?.payload === null,
    JSON.stringify(batch.get('b:pend-cancel')),
  );
  check(
    '03 落库：结果先到、晚到的 pending 什么都不改（R6）',
    batch.get('b:acc-late-pend')?.status === 'accepted' && batch.get('b:acc-late-pend')?.payload === null,
    JSON.stringify(batch.get('b:acc-late-pend')),
  );
  check(
    '03 落库：会话落库写不出 sending（只有 markSending 写），留在 pending、内容还在',
    batch.get('b:pend-sending')?.status === 'pending' && batch.get('b:pend-sending')?.payload !== null,
    JSON.stringify(batch.get('b:pend-sending')),
  );

  // ---- markSending 的库里那一步、启动时读没结果的行 ----
  await asApp(A, (tx) =>
    repoOutbound.insertOutboundSends(tx, [
      { ...w('ms:1', 'pending', T3, { msgtype: 'text', text: { content: '第一段' } }), inboxId: randomUUID(), segment: 0 },
      { ...w('ms:2', 'pending', T3, { msgtype: 'text', text: { content: '第二段' } }), segment: 1 },
      { ...w('ms:3', 'accepted', T3), accountId: AK2 },
    ]),
  );
  const m1 = await asApp(A, (tx) => repoOutbound.markOutboundSending(tx, 'ms:1'));
  const m1Again = await asApp(A, (tx) => repoOutbound.markOutboundSending(tx, 'ms:1'));
  const m3 = await asApp(A, (tx) => repoOutbound.markOutboundSending(tx, 'ms:3'));
  const mNone = await asApp(A, (tx) => repoOutbound.markOutboundSending(tx, 'ms:none'));
  const ms = await readOut('ms:');
  check(
    '03 仓储：markOutboundSending 把 pending 标成 sending（内容留着）；已是 sending、已有结果的返回 not_pending；库里没有的返回 absent',
    m1 === 'marked' &&
      m1Again === 'not_pending' &&
      m3 === 'not_pending' &&
      mNone === 'absent' &&
      ms.get('ms:1')?.status === 'sending' &&
      ms.get('ms:1')?.payload !== null,
    JSON.stringify({ m1, m1Again, m3, mNone, ms: ms.get('ms:1') }),
  );
  const open = await asApp(A, (tx) => repoOutbound.readOpenOutbound(tx, AK));
  const mine = open.filter((r) => r.channelMsgid.startsWith('ms:'));
  check(
    '03 仓储：readOpenOutbound 读出这个账号 pending、sending 的行，带 payload、segment、inbox_id',
    JSON.stringify(mine.map((r) => [r.channelMsgid, r.status, r.segment, r.inboxId !== null, r.payload !== null])) ===
      JSON.stringify([
        ['ms:1', 'sending', 0, true, true],
        ['ms:2', 'pending', 1, false, true],
      ]) && open.every((r) => r.status === 'pending' || r.status === 'sending'),
    JSON.stringify(mine),
  );
  const legacyOpen = await asApp(A, (tx) => repoOutbound.readOpenOutbound(tx, null));
  check(
    '03 仓储：readOpenOutbound(null) 只读 account_id 为空的行',
    legacyOpen.every((r) => r.accountId === null),
    JSON.stringify(legacyOpen),
  );
  // 回执（02 第 12 步的 markOutboundFailed）按迁移表：rejected、cancelled 是终态，不再记 failed
  await asApp(A, (tx) =>
    repoOutbound.insertOutboundSends(tx, [
      { ...w('rc:rej', 'rejected', T3), errcode: 95001 },
      w('rc:pend', 'pending', T3, { msgtype: 'text' }),
    ]),
  );
  const rcRej = await asApp(A, (tx) => repoOutbound.markOutboundFailed(tx, 'rc:rej', 4));
  const rcPend = await asApp(A, (tx) => repoOutbound.markOutboundFailed(tx, 'rc:pend', 4));
  const rc = await readOut('rc:');
  check(
    '03 仓储：回执按迁移表——pending 记 failed、清内容、返回会话 id；rejected 是终态，返回 null、不改',
    rcPend === 'wecom:wmTr' &&
      rc.get('rc:pend')?.status === 'failed' &&
      rc.get('rc:pend')?.payload === null &&
      rcRej === null &&
      rc.get('rc:rej')?.status === 'rejected',
    JSON.stringify({ rcRej, rcPend, rc: [...rc.values()] }),
  );

  // ---- 入站：插入、ord 递增、去重 ----
  const T = Date.parse('2026-10-09T09:00:00.000Z');
  const msg = (
    msgid: string,
    conv: string,
    state: InboxState = 'received',
    extra: Partial<import('./repo/channel-inbox.js').NewInboxRow> = {},
  ) => ({
    msgid,
    kind: 'message' as const,
    conversationId: conv,
    sentAt: new Date(T),
    state,
    payload: { msgid, text: { content: '原文' } },
    ...extra,
  });
  const page1 = await asApp(A, (tx) =>
    repoInbox.insertInboxRows(tx, AK, [
      msg('p1-a', 'wecom:wmOrd1'),
      msg('p1-b', 'wecom:wmOrd2'),
      msg('p1-c', 'wecom:wmOrd1', 'done', { kind: 'enter_session' }),
      msg('p1-d', 'wecom:wmOrd2', 'abandoned', { reason: 'cold_start' }),
      msg('p1-e', 'wecom:wmOrd2', 'recorded'),
    ]),
  );
  check(
    '03 入站：一页按给定顺序插入、ord 逐行递增；done、abandoned 插入时不留原文；初始状态 recorded 不在迁移表里、不插',
    JSON.stringify(page1.map((r) => [r.msgid, r.state, r.payload === null, r.reason, r.attempts])) ===
      JSON.stringify([
        ['p1-a', 'received', false, null, 0],
        ['p1-b', 'received', false, null, 0],
        ['p1-c', 'done', true, null, 0],
        ['p1-d', 'abandoned', true, 'cold_start', 0],
      ]) && page1.every((r, i) => i === 0 || r.ord > page1[i - 1]!.ord),
    JSON.stringify(page1.map((r) => [r.msgid, r.ord, r.state])),
  );
  const page2 = await asApp(A, (tx) =>
    repoInbox.insertInboxRows(tx, AK, [
      msg('p1-b', 'wecom:wmOrd2'),
      msg('p2-a', 'wecom:wmOrd1'),
      msg('p2-a', 'wecom:wmOrd1'),
      msg('p2-b', 'wecom:wmOrd3'),
    ]),
  );
  const maxOrd1 = Math.max(...page1.map((r) => r.ord));
  check(
    '03 入站：下一页里已有的 msgid（含同一页里重复的）冲突即跳过，只返回真正新插入的，ord 接着往上走',
    JSON.stringify(page2.map((r) => r.msgid)) === JSON.stringify(['p2-a', 'p2-b']) &&
      page2.every((r) => r.ord > maxOrd1) &&
      page2[1]!.ord > page2[0]!.ord,
    JSON.stringify(page2.map((r) => [r.msgid, r.ord])),
  );
  const other = await asApp(A, (tx) => repoInbox.insertInboxRows(tx, AK2, [msg('p1-a', 'wecom:kf-two:wmOrd1')]));
  check('03 入站：同一 msgid 在另一个账号上是另一行', other.length === 1 && other[0]!.accountId === AK2);
  const mismatch = await outcome(asApp(A, (tx) => repoInbox.insertInboxRows(tx, AK, [msg('p3-a', 'wecom:wmOrd1', 'abandoned')])));
  check('03 入站：abandoned 没带原因在发 SQL 之前就报错', mismatch.startsWith('非数据库错误'), mismatch);
  // 约束那一段在同一个账号上留了一行 128 字节 msgid 的 received，它也没结束、ord 最小
  const openIn = await asApp(A, (tx) => repoInbox.readOpenInbox(tx, AK));
  check(
    '03 入站：readOpenInbox 按 ord 读出这个账号没结束的行',
    JSON.stringify(openIn.map((r) => (r.msgid.length > 8 ? 'x128' : r.msgid))) ===
      JSON.stringify(['x128', 'p1-a', 'p1-b', 'p2-a', 'p2-b']) && openIn.every((r, i) => i === 0 || r.ord > openIn[i - 1]!.ord),
    JSON.stringify(openIn.map((r) => [r.msgid, r.ord, r.state])),
  );
  const idOf = (msgid: string): string => [...page1, ...page2].find((r) => r.msgid === msgid)!.id;
  const b1 = await asApp(A, (tx) => repoInbox.bumpInboxAttempts(tx, idOf('p1-a')));
  const b2 = await asApp(A, (tx) => repoInbox.bumpInboxAttempts(tx, idOf('p1-a')));
  const bDone = await asApp(A, (tx) => repoInbox.bumpInboxAttempts(tx, idOf('p1-c')));
  const [p1b] = await q<{ attempts: number }>(`select attempts from channel_inbox where id = $1`, [idOf('p1-b')]);
  check(
    '03 入站：出队计次只加这一行（1、2），排在后面的行不动；已结束的行不计、返回 null',
    b1 === 1 && b2 === 2 && bDone === null && p1b?.attempts === 0,
    JSON.stringify({ b1, b2, bDone, p1b }),
  );

  // ---- 入站：状态变化的每一格（5 × 5） ----
  const inCells: { msgid: string; from: InboxState; to: InboxState }[] = [];
  for (const from of INBOX_STATES) for (const to of INBOX_STATES) inCells.push({ msgid: `s:${from}:${to}`, from, to });
  for (const c of inCells) {
    const fin = c.from === 'done' || c.from === 'abandoned';
    await q(
      `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, reason, payload, updated_at)
       values ($1, $2, $3, 'message', 'wecom:wmSt', $4, $5, $6::json, '2026-10-01T00:00:00Z')`,
      [A, AK, c.msgid, c.from, c.from === 'abandoned' ? 'poison' : null, fin ? null : '{"text":"原文"}'],
    );
  }
  const ids = new Map(
    (await q<{ id: string; m: string }>(`select id, msgid as m from channel_inbox where msgid like 's:%'`)).map((r) => [r.m, r.id]),
  );
  const inChanged = new Map<string, boolean>();
  for (const c of inCells) {
    const r = await asApp(A, (tx) =>
      repoInbox.setInboxState(tx, ids.get(c.msgid)!, {
        state: c.to,
        ...(c.to === 'abandoned' ? { reason: 'too_old' as const } : {}),
        messageSeq: 7,
      }),
    );
    inChanged.set(c.msgid, r);
  }
  const inAfter = new Map(
    (
      await q<{ m: string; state: string; reason: string | null; payload: unknown; seq: number | null; old: boolean }>(
        `select msgid as m, state, reason, payload, message_seq as seq, updated_at = '2026-10-01T00:00:00Z' as old
           from channel_inbox where msgid like 's:%'`,
      )
    ).map((r) => [r.m, r]),
  );
  const wrongIn: string[] = [];
  for (const c of inCells) {
    const allowed = IN_SPEC.includes(`${c.from}>${c.to}`);
    const row = inAfter.get(c.msgid);
    const fin = (s: string): boolean => s === 'done' || s === 'abandoned';
    const ok = allowed
      ? inChanged.get(c.msgid) === true &&
        row?.state === c.to &&
        row.seq === 7 &&
        !row.old &&
        row.reason === (c.to === 'abandoned' ? 'too_old' : null) &&
        (fin(c.to) ? row.payload === null : row.payload !== null)
      : inChanged.get(c.msgid) === false &&
        row?.state === c.from &&
        row.seq === null &&
        row.old &&
        row.reason === (c.from === 'abandoned' ? 'poison' : null);
    if (!ok) wrongIn.push(`${c.from}>${c.to}${allowed ? '（应改）' : '（不应改）'}: ${JSON.stringify(row)}`);
  }
  check(
    '03 迁移表：入站状态变化 25 格，表里的改了（记 seq、结束时清原文、updated_at 由库写），表外的（回退、终态之后、原地不动）一个字节没动',
    wrongIn.length === 0,
    wrongIn.slice(0, 5).join(' | '),
  );
  const gone = await asApp(A, (tx) => repoInbox.setInboxState(tx, randomUUID(), { state: 'done' }));
  check('03 入站：状态变化命中 0 行（行已被清除）当无操作、返回 false', gone === false);

  // ---- 渠道账号的仓储 ----
  const created = await asApp(A, (tx) =>
    repoAcct.insertChannelAccount(tx, { key: 'web-demo', kind: 'web', name: '演示网页', settings: { title: '咨询' } }),
  );
  const listed = await asApp(A, (tx) => repoAcct.listChannelAccounts(tx));
  const touched = await asApp(A, (tx) =>
    repoAcct.updateChannelAccount(tx, AK, { cursor: 'cur-2', cursorAt: new Date(T), status: 'disabled' }),
  );
  const noop = await asApp(A, (tx) => repoAcct.updateChannelAccount(tx, AK, {}));
  const [ak] = await q<{ cursor: string; status: string; at: Date }>(
    `select cursor, status, cursor_at as at from channel_accounts where id = $1`,
    [AK],
  );
  check(
    '03 仓储：建账号（缺省 active）、按建立先后列出本租户的账号、改可改的列；空的改动不发 SQL',
    created.status === 'active' &&
      created.kind === 'web' &&
      JSON.stringify(created.settings) === '{"title":"咨询"}' &&
      listed.every((x) => x.key !== 'kf-main' || x.id === AK) &&
      listed.some((x) => x.id === created.id) &&
      !listed.some((x) => x.id === BK) &&
      touched &&
      !noop &&
      ak?.cursor === 'cur-2' &&
      ak.status === 'disabled' &&
      ak.at.getTime() === T,
    JSON.stringify({ created, listed: listed.map((x) => x.key), ak }),
  );
}

// ---------------- 02：清除与删除函数（PGlite 上先跑一遍行为；授权以真实 PG 为准） ----------------
await purgeChecks(
  {
    su: q,
    as: async <R = Record<string, unknown>>(role: DbRole, tenant: string | null, text: string, params: unknown[] = []): Promise<R[]> => {
      await t.pg.exec(`SET ROLE ${role}`);
      try {
        return await t.pg.transaction(async (tx) => {
          if (tenant) await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
          return (await tx.query<R>(text, params)).rows;
        });
      } finally {
        await t.pg.exec('RESET ROLE');
      }
    },
  },
  '',
);
await channelChecks(
  {
    su: q,
    as: async <R = Record<string, unknown>>(role: DbRole, tenant: string | null, text: string, params: unknown[] = []): Promise<R[]> => {
      await t.pg.exec(`SET ROLE ${role}`);
      try {
        return await t.pg.transaction(async (tx) => {
          if (tenant) await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
          return (await tx.query<R>(text, params)).rows;
        });
      } finally {
        await t.pg.exec('RESET ROLE');
      }
    },
  },
  '',
);

await t.close();

// ---------------- 部署脚本（deploy.sh、deploy/compose.yml、deploy/backup.sh） ----------------
// 不连服务器：deploy.sh 只跑到碰服务器之前（ssh、rsync、pnpm 换成一调用就记下并失败的假命令）；第 3 步在服务器上跑的
// 检查脚本在本机对临时目录跑；backup.sh 用假的 docker、age、rclone
{
  const repoRoot = path.join(import.meta.dirname, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-deploy-selftest-'));
  const bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'calls.log');
  fs.mkdirSync(bin);
  const fake = (name: string, lines: string[]): void =>
    fs.writeFileSync(path.join(bin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
  // 一调用就记下并失败；FAKE_SSH_LOCAL 时 ssh 把远端命令交给本机的 bash（stdin 照传），FAKE_PNPM_OK 时 pnpm 一律成功
  fake('ssh', ['echo "ssh $*" >> "$FAKE_LOG"', 'if [ -n "${FAKE_SSH_LOCAL:-}" ]; then shift; exec bash -c "$*"; fi', 'exit 97']);
  fake('rsync', ['echo "rsync $*" >> "$FAKE_LOG"', 'exit 97']);
  fake('pnpm', ['echo "pnpm $*" >> "$FAKE_LOG"', 'if [ -n "${FAKE_PNPM_OK:-}" ]; then exit 0; fi', 'exit 97']);
  fake('docker', [
    // 模拟 compose exec 转发 stdin；run / inspect 也主动读，守住 bash -s 后续脚本的边界。
    'case "$1" in exec|compose|run|inspect|image) cat >/dev/null ;; esac',
    // 03 的新增探测单独记账，02 原有断言继续只数它负责的探测；新断言同时检查 docker03 的调用。
    // 只认 rollback-guard.sh 自己的两条渠道查询：backup.sh 的探测里也有 channel_accounts（'public.' || t 的写法），不能被截走
    'case "$*" in *pack-api.ts*|*"from tenants t"*) echo "docker04 $PWD|$*" >> "$FAKE_LOG" ;; *registry.ts*|*public.channel_accounts*|*"from channel_accounts where"*) echo "docker03 $PWD|$*" >> "$FAKE_LOG" ;; *) echo "docker $PWD|$*" >> "$FAKE_LOG" ;; esac',
    'case "$*" in',
    '  *"from tenants t"*) echo f ;;',
    '  *pack-api.ts*) exit 1 ;;',
    '  *sha256:running*registry.ts*) exit "${FAKE_RUNNING_REGISTRY:-1}" ;;',
    '  *registry.ts*) exit "${FAKE_REGISTRY:-1}" ;;',
    // rollback-guard.sh 看镜像里有没有 pg-backend.ts：FAKE_PG_BACKEND 是 test 的退出码（0 有、1 没有、其余当 docker 出错）；
    // 正在跑的容器的镜像（docker inspect 回 sha256:running，FAKE_RUNNING 没设时 inspect 失败）用 FAKE_RUNNING
    '  *sha256:running*pg-backend.ts*) exit "${FAKE_RUNNING:-0}" ;;',
    '  *pg-backend.ts*) exit "${FAKE_PG_BACKEND:-0}" ;;',
    '  *"inspect --format {{.Image}}"*) if [ -n "${FAKE_RUNNING:-}${FAKE_RUNNING_REGISTRY:-}" ]; then echo sha256:running; else exit 1; fi ;;',
    // 渠道问库：none 是 03 之前的库；query-down / malformed 验证第二次查询失败或结果异常也走保守处理。
    '  *to_regclass*public.channel_accounts*) case "${FAKE_CHANNEL_DB:-none}" in down) exit 1 ;; none) echo f ;; *) echo t ;; esac ;;',
    '  *"from channel_accounts where"*) case "${FAKE_CHANNEL_DB}" in query-down) exit 1 ;; malformed) echo unexpected ;; *) echo "${FAKE_CHANNEL_DB}" ;; esac ;;',
    // rollback-guard.sh 直接问库有没有条目版本大于 1：FAKE_CATALOG_DB 是 t / f / none（表不存在）/ down（缺省，exec 失败）
    '  *to_regclass*catalog_item_versions*) case "${FAKE_CATALOG_DB:-down}" in down) exit 1 ;; none) echo f ;; *) echo t ;; esac ;;',
    '  *"from catalog_item_versions where version > 1"*) echo "${FAKE_CATALOG_DB}" ;;',
    // 自动回滚被拒时打印目标镜像的 APP_REVISION
    '  *"image inspect"*) printf "PATH=/usr/local/bin\\nAPP_REVISION=%s\\n" "${FAKE_REVISION:-old-v1}" ;;',
    '  *pg_dumpall*) echo "-- globals" ;;',
    '  *pg_dump*) echo "dump" ;;',
    // 目录里有哪些表的数据段：缺省是 01 的四张加 02 的会话三张、03 的渠道两张，FAKE_TOC 换掉它
    '  *"pg_restore --list"*) cat >/dev/null; for t in ${FAKE_TOC:-memberships sop_versions catalog_items audit_log conversations messages orders channel_accounts channel_inbox}; do echo "1; 0 0 TABLE DATA public $t agent_owner"; done ;;',
    // 两张配置表的行数，以及库里已有的会话三张表、渠道两张表；FAKE_PSQL 换掉它（库停在 01 时第三段为空）
    '  *psql*) echo "${FAKE_PSQL:-2|43|conversations messages orders channel_accounts channel_inbox}" ;;',
    '  *) exit 97 ;;',
    'esac',
  ]);
  // rollback-guard.sh 问正在运行的实例 /healthz 的 config.catalogVersioned（02 第 8 步）：缺省是 false；
  // FAKE_HEALTHZ 换掉回的内容，FAKE_CURL_FAIL 时像连不上那样以 7 退出
  fake('curl', [
    'echo "curl $*" >> "$FAKE_LOG"',
    'if [ -n "${FAKE_CURL_FAIL:-}" ]; then exit 7; fi',
    `d='{"ok":true,"config":{"mode":"db","catalogVersioned":false}}'`,
    'printf "%s" "${FAKE_HEALTHZ:-$d}"',
  ]);
  // 假的 age：-o 的下一个是输出，最后一个参数是输入，原样拷过去
  fake('age', ['out=""', 'while [ $# -gt 1 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done', 'cp "$1" "$out"']);
  fake('rclone', ['echo "rclone $*" >> "$FAKE_LOG"']);
  // 开发机上可能导出了 SERVER 之类的部署变量：一律去掉，再把假命令放在 PATH 最前面
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && !/^(SERVER|REMOTE_DIR|HOST_PORT|NAME|APP_IMAGE|COMPOSE_PROJECT|AGENT_DB|BACKUP_.*)$/.test(e[0]),
    ),
  );
  env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  env.FAKE_LOG = log;
  const run = (cmd: string, args: string[], cwd: string, input?: string): { code: number | null; out: string } => {
    const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const calls = (): string => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const deploySrc = fs.readFileSync(path.join(repoRoot, 'deploy.sh'), 'utf8');

  // deploy.sh 不收没有 compose 与迁移的 tag（01 之前的版本）：否则第 4 步的 rsync --delete 先删掉服务器上的 deploy/，第 6 步才失败
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  fs.copyFileSync(path.join(repoRoot, 'deploy.sh'), path.join(repo, 'deploy.sh'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'Dockerfile'), '');
  const git = (...args: string[]): void => {
    const gitArgs = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
    run('git', [...gitArgs, '-c', `core.hooksPath=${path.join(tmp, 'no-hooks')}`, ...args], repo);
  };
  const commitAndTag = (tag: string, files: string[]): void => {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), '');
    }
    git('add', '-A');
    git('commit', '-qm', tag);
    git('tag', tag);
  };
  git('init', '-q');
  commitAndTag('old-v1', []);
  commitAndTag('half-v1', ['deploy/compose.yml']);
  commitAndTag('new-v1', ['src/db/migrate.ts']);
  for (const [tag, missing] of [
    ['old-v1', 'deploy/compose.yml'],
    ['half-v1', 'src/db/migrate.ts'],
  ]) {
    const r = run('bash', ['deploy.sh', tag], repo);
    check(
      `deploy.sh：${tag} 里没有 ${missing}，碰服务器之前就拒绝`,
      r.code === 1 && r.out.includes(`里没有 ${missing}`) && !r.out.includes('未设置 SERVER') && calls() === '',
      r.out.slice(-300),
    );
  }
  const newTag = run('bash', ['deploy.sh', 'new-v1'], repo);
  check(
    'deploy.sh：带 compose 与迁移的 tag 过了这道检查（接着因为没设 SERVER 停下）',
    newTag.code !== 0 && newTag.out.includes('未设置 SERVER') && calls() === '',
    newTag.out.slice(-300),
  );

  // 第 3 步的服务器检查（ssh 把这段脚本交给服务器上的 bash -s）：.env.db 缺口令或设了 POSTGRES_DB，
  // db 首次初始化就会留下一个没有角色的库，之后 entrypoint 不再跑 roles.sh
  const checkScript = /<<'CHECK'; then\n([\s\S]*?)\nCHECK\n/.exec(deploySrc)?.[1] ?? '';
  check('deploy.sh：找得到第 3 步的服务器检查脚本', checkScript.includes('.env.db'));
  const srv = path.join(tmp, 'srv');
  fs.mkdirSync(srv);
  fs.writeFileSync(path.join(srv, '.env.migrate'), 'DATABASE_OWNER_URL=postgres://agent_owner:o@db:5432/agent\n');
  const goodDb = ['POSTGRES_PASSWORD=su', 'AGENT_OWNER_PASSWORD=o', 'AGENT_APP_PASSWORD=a', 'AGENT_PLATFORM_PASSWORD=p'];
  const serverCheck = (dbLines: string[], profile = 'DEPLOY_PROFILE=demo'): { code: number | null; out: string } => {
    fs.writeFileSync(path.join(srv, '.env'), `${profile}\n`);
    fs.writeFileSync(path.join(srv, '.env.db'), `${dbLines.join('\n')}\n`);
    return run('bash', ['-s', '--', srv, '0'], srv, checkScript);
  };
  const good = serverCheck(goodDb);
  check('第 3 步：.env.db 四个口令都有、没有 POSTGRES_DB 时通过', good.code === 0, good.out);
  for (const [i, line] of goodDb.entries()) {
    const key = line.slice(0, line.indexOf('='));
    const missing = serverCheck(goodDb.filter((_, j) => j !== i));
    check(`第 3 步：.env.db 没写 ${key} 时拒绝并点名`, missing.code === 1 && missing.out.includes(key), missing.out);
    const empty = serverCheck(goodDb.map((l, j) => (j === i ? `${key}=` : l)));
    check(`第 3 步：.env.db 的 ${key} 为空时拒绝`, empty.code === 1 && empty.out.includes(key), empty.out);
  }
  const envDbCases: [string, string[], number][] = [
    ['同名以最后一行为准：最后一行是空的也拒绝', [...goodDb, 'AGENT_APP_PASSWORD='], 1],
    ['只是前缀相同的键不算', [...goodDb.filter((l) => !l.startsWith('AGENT_APP_PASSWORD=')), 'AGENT_APP_PASSWORD_OLD=a'], 1],
    ['行首空白按 docker 的读法去掉', goodDb.map((l) => `  ${l}`), 0],
    ['设了 POSTGRES_DB 拒绝', [...goodDb, 'POSTGRES_DB=agent'], 1],
    ['POSTGRES_DB 写成空的不算设了（entrypoint 同样当它没设）', [...goodDb, 'POSTGRES_DB='], 0],
  ];
  for (const [name, lines, code] of envDbCases) {
    const r = serverCheck(lines);
    check(`第 3 步：${name}`, r.code === code, r.out);
  }
  const quoted = serverCheck(goodDb, 'DEPLOY_PROFILE="demo"');
  check('第 3 步：DEPLOY_PROFILE 带引号照旧拒绝', quoted.code === 1 && quoted.out.includes('DEPLOY_PROFILE'), quoted.out);

  // CHECK 也从 stdin 读：模拟以后 awk / grep 读取继承的 stdin，尾部哨兵必须仍由 bash 执行。
  fake('awk', ['cat >/dev/null', 'exec /usr/bin/awk "$@"']);
  fake('grep', ['cat >/dev/null', 'exec /usr/bin/grep "$@"']);
  try {
    fs.writeFileSync(path.join(srv, '.env.db'), `${goodDb.join('\n')}\n`);
    fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\n');
    const stdinCheck = `${checkScript}\nprintf '%s\\n' CHECK_STDIN_COMPLETE\n`;
    const allowed = run('bash', ['-s', '--', srv, '1'], srv, stdinCheck);
    check(
      'CHECK stdin：awk / grep 会读 stdin，合格旁路配置仍执行完全部检查与尾部哨兵 → 0',
      allowed.code === 0 && allowed.out.includes('CHECK_STDIN_COMPLETE'),
      `${allowed.code} ${allowed.out}`,
    );
    fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\nWECOM_CORP_ID=test\n');
    const refused = run('bash', ['-s', '--', srv, '1'], srv, stdinCheck);
    check(
      'CHECK stdin：awk / grep 会读 stdin，旁路配置有企微凭据仍拒绝 → 1，不执行尾部哨兵',
      refused.code === 1 && refused.out.includes('会和线上实例抢同一个客服账号') && !refused.out.includes('CHECK_STDIN_COMPLETE'),
      `${refused.code} ${refused.out}`,
    );
  } finally {
    fs.rmSync(path.join(bin, 'awk'));
    fs.rmSync(path.join(bin, 'grep'));
  }

  // compose：env 文件都按 format: raw 读（与 docker --env-file 同一个解析器：$ 不展开、引号和 # 原样），
  // 与第 3 步的检查、第 5 步的试读是同一种读法；应用镜像缺省取 <容器名>:current，手工命令不用带 APP_IMAGE
  const composeSrc = fs.readFileSync(path.join(repoRoot, 'deploy', 'compose.yml'), 'utf8');
  const envBlocks = [...composeSrc.matchAll(/^( +)env_file:(.*)\n((?:\1 +\S.*\n)*)/gm)];
  check(
    'compose：四个服务的 env 文件都是长写法且每一项都 format: raw',
    envBlocks.length === 4 &&
      envBlocks.every(
        (m) =>
          m[2].trim() === '' &&
          m[3].includes('- path: ') &&
          (m[3].match(/- path: /g) ?? []).length === (m[3].match(/^ +format: raw$/gm) ?? []).length,
      ),
    envBlocks.map((m) => m[0]).join(' / '),
  );
  const appImages = composeSrc.match(/^ +image: .*APP_IMAGE.*$/gm) ?? [];
  const defaultImage = ['image: $', '{APP_IMAGE:-$', '{APP_CONTAINER:-wecom-sales-agent}:current}'].join('');
  check(
    'compose：三个用应用镜像的服务缺省都取 <容器名>:current，不再要求 APP_IMAGE',
    appImages.length === 3 && appImages.every((l) => l.trim() === defaultImage),
    appImages.join(' / '),
  );
  // :current 要一直是 app 容器在用的镜像：部署成功是新镜像，自动回滚后是 :prev（:latest 那时是没起来的坏镜像）
  check(
    'deploy.sh：换上新镜像之后把它打成 :current',
    /\) up -d app\n(?: *#.*\n)* *docker tag \$\{NAME\}:latest \$\{NAME\}:current\n/.test(deploySrc),
  );
  check(
    'deploy.sh：回滚到 :prev 之后 :current 也改指 :prev',
    /\) up -d --no-deps app\n *docker tag \$\{NAME\}:prev \$\{NAME\}:current"/.test(deploySrc),
  );

  // backup.sh：cron 跑装在部署目录之外的那一份、部署目录作为参数，不读 compose 文件（回到 01 之前的版本后 deploy/ 没了）；
  // 本地与异地路径都带项目名，旁路实例同一天跑也盖不掉线上的备份
  const installed = /install -m 755 \$\{REMOTE_DIR\}\/deploy\/backup\.sh (\/\S+)\/\$\{NAME\}\/backup\.sh/.exec(deploySrc)?.[1];
  const cronLine = /^# +15 3 \* \* \* +bash (\S+) \/opt\/wecom-sales-agent /m.exec(
    fs.readFileSync(path.join(repoRoot, 'deploy', 'backup.sh'), 'utf8'),
  )?.[1];
  check(
    'deploy.sh 每次部署把 backup.sh 装到部署目录之外，正是 cron 那一行跑的路径',
    installed !== undefined && cronLine === `${installed}/wecom-sales-agent/backup.sh`,
    `${installed} / ${cronLine}`,
  );
  const lib = path.join(tmp, 'lib');
  fs.mkdirSync(lib);
  fs.copyFileSync(path.join(repoRoot, 'deploy', 'backup.sh'), path.join(lib, 'backup.sh'));
  const bk = path.join(tmp, 'bk');
  const day = run('date', ['+%F'], tmp).out.trim();
  const deployDir = (name: string, backupEnv: string[], sessions: string): string => {
    const d = path.join(tmp, name);
    fs.mkdirSync(path.join(d, 'var'), { recursive: true });
    fs.writeFileSync(path.join(d, '.env'), 'DEPLOY_PROFILE=demo\n');
    fs.writeFileSync(path.join(d, '.env.backup'), ['BACKUP_AGE_RECIPIENTS=age1test', `BACKUP_DIR=${bk}`, ...backupEnv, ''].join('\n'));
    fs.writeFileSync(path.join(d, 'var', 'sessions.json'), sessions);
    return d;
  };
  const backup = (dir: string): { code: number | null; out: string } => run('bash', [path.join(lib, 'backup.sh'), dir], tmp);
  const notDeploy = backup(tmp);
  check('backup.sh：参数不是部署目录（没有 .env）时拒绝', notDeploy.code === 1 && notDeploy.out.includes('不是部署目录'), notDeploy.out);
  const noProject = backup(deployDir('noproject', [], 'x'));
  check(
    'backup.sh：不是线上部署目录又没写 COMPOSE_PROJECT 时拒绝，什么都不导出',
    noProject.code === 1 && noProject.out.includes('COMPOSE_PROJECT') && !fs.existsSync(bk) && calls() === '',
    noProject.out,
  );
  const live = backup(deployDir('live', ['COMPOSE_PROJECT=live1'], 'live-sessions'));
  const liveDay = path.join(bk, 'live1', day);
  check('backup.sh：部署目录里没有 deploy/ 也照常备份', live.code === 0, live.out);
  check(
    'backup.sh：会话三张表有数据段就过，不看行数、不告警',
    live.code === 0 && !/conversations|messages|orders/.test(live.out),
    live.out,
  );
  check('backup.sh（03）：渠道两张表也有数据段时一行告警都没有', live.code === 0 && !live.out.includes('库里还没有'), live.out);
  check(
    'backup.sh：三份密文写在 <BACKUP_DIR>/<项目名>/<日期>，项目目录 0700',
    ['agent.dump.age', 'globals.sql.age', 'var.tar.gz.age'].every((f) => fs.existsSync(path.join(liveDay, f))) &&
      (fs.statSync(path.join(bk, 'live1')).mode & 0o777) === 0o700,
    fs.existsSync(bk) ? fs.readdirSync(bk).join(',') : '没有备份目录',
  );
  const dockerCalls = calls()
    .split('\n')
    .filter((l) => l.startsWith('docker '));
  check(
    'backup.sh：按项目名找 db，不带 compose 文件，在 / 下执行（不让 compose 解析部署目录里应用的 .env）',
    dockerCalls.length === 4 && dockerCalls.every((l) => l.startsWith('docker /|compose -p live1 exec -T db ') && !l.includes(' -f ')),
    dockerCalls.join(' / '),
  );
  const liveVar = fs.existsSync(path.join(liveDay, 'var.tar.gz.age')) ? fs.readFileSync(path.join(liveDay, 'var.tar.gz.age')) : undefined;
  fs.rmSync(log, { force: true });
  const side = backup(deployDir('side', ['COMPOSE_PROJECT=side1', 'BACKUP_OFFSITE=remote:bk'], 'side-sessions'));
  check(
    'backup.sh：旁路实例写进它自己的项目目录',
    side.code === 0 && fs.existsSync(path.join(bk, 'side1', day, 'var.tar.gz.age')),
    side.out,
  );
  check(
    'backup.sh：旁路实例同一天的备份不盖掉线上的',
    liveVar !== undefined && fs.readFileSync(path.join(liveDay, 'var.tar.gz.age')).equals(liveVar),
  );
  // 02：conversations、messages、orders 任何一张没有数据段，备份不可用；03 的 channel_accounts、channel_inbox 同样
  for (const missing of ['conversations', 'messages', 'orders', 'channel_accounts', 'channel_inbox']) {
    env.FAKE_TOC = [
      'memberships',
      'sop_versions',
      'catalog_items',
      'audit_log',
      'conversations',
      'messages',
      'orders',
      'channel_accounts',
      'channel_inbox',
    ]
      .filter((x) => x !== missing)
      .join(' ');
    const project = `notoc-${missing}`;
    const r = backup(deployDir(project, [`COMPOSE_PROJECT=${project}`], 'x'));
    check(
      `backup.sh：导出里没有 ${missing} 的 TABLE DATA 时非零退出并点名，不写密文`,
      r.code === 1 && r.out.includes(`没有 ${missing} 的 TABLE DATA`) && !fs.existsSync(path.join(bk, project, day, 'agent.dump.age')),
      r.out,
    );
  }
  // 库停在 01（deploy.sh 装了新版本脚本，构建或迁移失败）：会话三张表不存在，告警一行、备份照做；
  // 只建了其中一部分时，已有的照样要有数据段
  env.FAKE_TOC = 'memberships sop_versions catalog_items audit_log';
  env.FAKE_PSQL = '2|43|';
  const behind = backup(deployDir('behind', ['COMPOSE_PROJECT=behind'], 'behind-sessions'));
  check(
    'backup.sh：库里还没有会话三张表时告警一行、照常备份（不因为迁移没跑成每晚整份不出）',
    behind.code === 0 &&
      behind.out.split('\n').filter((l) => l.includes('库里还没有 conversations messages orders')).length === 1 &&
      ['agent.dump.age', 'globals.sql.age', 'var.tar.gz.age'].every((f) => fs.existsSync(path.join(bk, 'behind', day, f))),
    behind.out,
  );
  env.FAKE_PSQL = '2|43|conversations';
  const partial = backup(deployDir('partial', ['COMPOSE_PROJECT=partial'], 'x'));
  check(
    'backup.sh：库里有 conversations 而导出里没有它的数据段，照样非零退出',
    partial.code === 1 &&
      partial.out.includes('没有 conversations 的 TABLE DATA') &&
      !fs.existsSync(path.join(bk, 'partial', day, 'agent.dump.age')),
    partial.out,
  );
  // 03：库停在 02（03 的迁移没跑成）：渠道两张表不存在，告警一行、照常备份，会话三张表照样要有数据段
  env.FAKE_TOC = 'memberships sop_versions catalog_items audit_log conversations messages orders';
  env.FAKE_PSQL = '2|43|conversations messages orders';
  const at02 = backup(deployDir('at02', ['COMPOSE_PROJECT=at02'], 'x'));
  check(
    'backup.sh（03）：库里还没有渠道两张表时告警一行、照常备份',
    at02.code === 0 &&
      at02.out.split('\n').filter((l) => l.includes('库里还没有 channel_accounts channel_inbox')).length === 1 &&
      fs.existsSync(path.join(bk, 'at02', day, 'agent.dump.age')),
    at02.out,
  );
  env.FAKE_PSQL = '2|43|conversations messages orders channel_accounts';
  const chanPartial = backup(deployDir('chan-partial', ['COMPOSE_PROJECT=chan-partial'], 'x'));
  check(
    'backup.sh（03）：库里有 channel_accounts 而导出里没有它的数据段，非零退出、不写密文',
    chanPartial.code === 1 &&
      chanPartial.out.includes('没有 channel_accounts 的 TABLE DATA') &&
      !fs.existsSync(path.join(bk, 'chan-partial', day, 'agent.dump.age')),
    chanPartial.out,
  );
  env.FAKE_PSQL = '2|43|conversations';
  env.FAKE_TOC = 'memberships sop_versions catalog_items audit_log conversations';
  const partialOk = backup(deployDir('partial-ok', ['COMPOSE_PROJECT=partial-ok'], 'x'));
  check(
    'backup.sh：只查库里已有的那几张，缺的两张只告警',
    partialOk.code === 0 &&
      partialOk.out.includes('库里还没有 messages orders') &&
      fs.existsSync(path.join(bk, 'partial-ok', day, 'agent.dump.age')),
    partialOk.out,
  );
  delete env.FAKE_TOC;
  delete env.FAKE_PSQL;
  const rclone = calls()
    .split('\n')
    .filter((l) => l.startsWith('rclone '));
  check(
    'backup.sh：异地路径也带项目名，只清理本项目的旧备份',
    rclone.includes(`rclone copy ${path.join(bk, 'side1', day)} remote:bk/side1/${day}`) &&
      rclone.includes('rclone delete --min-age 30d remote:bk/side1') &&
      rclone.includes('rclone rmdirs --leave-root remote:bk/side1'),
    rclone.join(' / '),
  );

  // 回滚前检查（02 spec「回滚到 02 之前的镜像」，plan 第 6 步）：目标是 02 之前的镜像（没有 src/store/pg-backend.ts）而
  // var/ 里有标记文件时拒绝，打印先回到文件存储的步骤；两个都是 02 之后的镜像时照常回滚。判断在 deploy/rollback-guard.sh 里，
  // deploy.sh 经 ssh 交给服务器上的 bash -s；这里在本机对临时目录跑，docker 是假的
  const guardSrc = fs.readFileSync(path.join(repoRoot, 'deploy', 'rollback-guard.sh'), 'utf8');
  const gsrv = path.join(tmp, 'guard-srv');
  fs.mkdirSync(path.join(gsrv, 'var'), { recursive: true });
  const markerFile = path.join(gsrv, 'var', 'sessions-in-db.json');
  const setMarker = (on: boolean): void => {
    if (on) fs.writeFileSync(markerFile, '{"tenant":"acme-2","at":"2026-10-02T00:00:00.000Z","sessions":3}\n');
    else fs.rmSync(markerFile, { force: true });
  };
  /** 服务器 .env：缺省没有（与只有标记文件的情形分开测） */
  const setEnvFile = (text: string | null): void => {
    if (text === null) fs.rmSync(path.join(gsrv, '.env'), { force: true });
    else fs.writeFileSync(path.join(gsrv, '.env'), text);
  };
  /**
   * health：正在运行的实例 /healthz 回的内容；null 是连不上；缺省是 catalogVersioned 为 false 的那份。
   * db：直接问库的结果（t / f / none / down，缺省 down）；running：正在跑的容器的镜像里 test pg-backend.ts 的退出码（缺省 inspect 失败）；
   * envDb：服务器 .env.db
   */
  const guard = (
    target: string,
    marker: boolean,
    pgBackend?: number,
    envText: string | null = null,
    health?: string | null,
    o: {
      db?: string;
      running?: number;
      envDb?: string;
      channels?: string;
      channelMarker?: boolean;
      registry?: number;
      runningRegistry?: number;
    } = {},
  ) => {
    fs.rmSync(log, { force: true });
    setMarker(marker);
    const cm = path.join(gsrv, 'var', 'channels-in-db.json');
    if (o.channelMarker) fs.writeFileSync(cm, '{"tenant":"acme-2"}\n');
    else fs.rmSync(cm, { force: true });
    setEnvFile(envText);
    if (pgBackend === undefined) delete env.FAKE_PG_BACKEND;
    else env.FAKE_PG_BACKEND = String(pgBackend);
    if (health === null) env.FAKE_CURL_FAIL = '1';
    else if (health !== undefined) env.FAKE_HEALTHZ = health;
    if (o.db !== undefined) env.FAKE_CATALOG_DB = o.db;
    if (o.running !== undefined) env.FAKE_RUNNING = String(o.running);
    if (o.channels !== undefined) env.FAKE_CHANNEL_DB = o.channels;
    if (o.registry !== undefined) env.FAKE_REGISTRY = String(o.registry);
    if (o.runningRegistry !== undefined) env.FAKE_RUNNING_REGISTRY = String(o.runningRegistry);
    if (o.envDb !== undefined) fs.writeFileSync(path.join(gsrv, '.env.db'), o.envDb);
    const r = run('bash', ['-s', '--', gsrv, target, 'side1', '3999'], tmp, guardSrc);
    for (const k of [
      'FAKE_PG_BACKEND',
      'FAKE_CURL_FAIL',
      'FAKE_HEALTHZ',
      'FAKE_CATALOG_DB',
      'FAKE_RUNNING',
      'FAKE_CHANNEL_DB',
      'FAKE_REGISTRY',
      'FAKE_RUNNING_REGISTRY',
    ])
      delete env[k];
    fs.rmSync(path.join(gsrv, '.env.db'), { force: true });
    fs.rmSync(cm, { force: true });
    setEnvFile(null);
    return {
      ...r,
      docker: calls()
        .split('\n')
        .filter((l) => l.startsWith('docker ')),
      channelDocker: calls()
        .split('\n')
        .filter((l) => l.startsWith('docker03 ')),
      curl: calls()
        .split('\n')
        .filter((l) => l.startsWith('curl ')),
    };
  };
  const dcOf = (project: string, port: string): string =>
    `APP_CONTAINER=${project} HOST_PORT=${port} docker compose -p ${project} -f deploy/compose.yml`;
  /** 拒绝时打印的步骤。pre-02（部署旧 tag）：stop → export → 去掉 SESSION_STORE=db 再起、按端口确认 → 部署旧 tag */
  const refusedWithSteps = (out: string, o: { slug?: string; project?: string; port?: string; why?: string } = {}): boolean => {
    const dc = dcOf(o.project ?? 'side1', o.port ?? '3999');
    return (
      out.includes('拒绝回滚') &&
      out.includes(o.why ?? 'sessions-in-db.json') &&
      out.includes(`1. ${dc} stop app`) &&
      out.includes(`${dc} run --rm -v /root/sessions-keep-<日期>:/keep app`) &&
      out.includes(`src/cli/export-sessions.ts --tenant ${o.slug ?? 'acme-2'} --keep /keep --var /app/var`) &&
      out.includes(
        `去掉 SESSION_STORE=db，${dc} up -d app，curl -fsS http://127.0.0.1:${o.port ?? '3999'}/healthz 确认 store.mode = file`,
      ) &&
      out.includes('4. 再部署旧 tag') &&
      out.indexOf('export-sessions') < out.indexOf('去掉 SESSION_STORE=db') &&
      out.indexOf('去掉 SESSION_STORE=db') < out.indexOf('4. 再部署旧 tag')
    );
  };
  /**
   * 自动回滚被拒（目标是镜像）：:current 已是没过健康检查的新镜像，导出用它；去掉 SESSION_STORE=db 之后直接起目标镜像、
   * 重打 :current，按端口确认 revision 是目标镜像的 APP_REVISION；不再说「部署旧 tag」
   */
  const refusedAutoSteps = (out: string, target: string, o: { slug?: string; rev?: string; why?: string } = {}): boolean => {
    const dc = dcOf('side1', '3999');
    return (
      out.includes('拒绝回滚') &&
      out.includes(o.why ?? 'sessions-in-db.json') &&
      out.includes('side1:current 已是这次没过健康检查的新镜像') &&
      out.includes(`1. ${dc} stop app`) &&
      out.includes(`src/cli/export-sessions.ts --tenant ${o.slug ?? 'acme-2'} --keep /keep --var /app/var`) &&
      out.includes('用的是 side1:current，也就是这次的新镜像里的 export-sessions') &&
      out.includes(`APP_IMAGE=${target} ${dc} up -d --no-deps app && docker tag ${target} side1:current`) &&
      out.includes(`curl -fsS http://127.0.0.1:3999/healthz 确认 revision 是 ${o.rev ?? 'old-v1'}`) &&
      !out.includes('再部署旧 tag') &&
      out.indexOf('export-sessions') < out.indexOf('去掉 SESSION_STORE=db') &&
      out.indexOf('去掉 SESSION_STORE=db') < out.indexOf('up -d --no-deps app')
    );
  };
  const g1 = guard('side1:prev', false);
  check(
    '回滚前检查：没有标记文件、.env 也不是 db 存储时照常回滚，不看镜像',
    g1.code === 0 && g1.docker.length === 0,
    `${g1.code} ${g1.out} ${g1.docker.join()}`,
  );
  const g2 = guard('side1:prev', true, 0);
  check(
    '回滚前检查：有标记文件、目标镜像里有 pg-backend.ts（两个都是 02 之后的）时照常回滚',
    g2.code === 0 &&
      g2.docker.length === 1 &&
      g2.docker[0]!.includes('run --rm --entrypoint /bin/sh side1:prev -c test -e /app/src/store/pg-backend.ts'),
    `${g2.code} ${g2.out} ${g2.docker.join()}`,
  );
  const g3 = guard('side1:prev', true, 1);
  check(
    '回滚前检查：有标记文件、目标镜像里没有 pg-backend.ts（02 之前的，自动回滚）时拒绝（3），打印带 HOST_PORT 的自动回滚步骤：' +
      '用 :current 导出 → 去掉 SESSION_STORE=db → 直接起目标镜像、重打 :current → 按端口确认目标镜像的 APP_REVISION；租户取自标记文件',
    g3.code === 3 &&
      refusedAutoSteps(g3.out, 'side1:prev') &&
      g3.docker.some((l) => l.includes('image inspect') && l.includes('side1:prev')),
    `${g3.code} ${g3.out}`,
  );
  const g4 = guard('side1:prev', true, 125);
  check(
    '回滚前检查：docker 出错、看不出目标镜像时按 02 之前处理，拒绝',
    g4.code === 3 && g4.out.includes('docker 出错') && refusedAutoSteps(g4.out, 'side1:prev'),
    `${g4.code} ${g4.out}`,
  );
  const g5 = guard('pre-02', true);
  check(
    '回滚前检查：调用方已判定是 02 之前的（pre-02）、有标记文件时拒绝，不再看镜像；打印的命令带 HOST_PORT、租户取自标记文件',
    g5.code === 3 && g5.docker.length === 0 && refusedWithSteps(g5.out) && g5.out.includes('HOST_PORT=3999'),
    g5.out,
  );
  const g6 = guard('pre-02', false);
  check('回滚前检查：pre-02 而没有标记文件时照常', g6.code === 0, g6.out);
  // 没有标记文件而 .env 是 db 存储（没经过 import-sessions 直接以 db 存储起、补写标记之前的实例）：同样拒绝；租户取自 .env
  const dbEnv = 'DEPLOY_PROFILE=demo\n  SESSION_STORE=db\r\nDEFAULT_TENANT_SLUG=acme-3\n';
  const g7 = guard('pre-02', false, undefined, dbEnv);
  check(
    '回滚前检查：没有标记文件而 .env 里是 SESSION_STORE=db 时拒绝（pre-02），租户取自 .env 的 DEFAULT_TENANT_SLUG',
    g7.code === 3 && refusedWithSteps(g7.out, { slug: 'acme-3', why: '.env 里是 SESSION_STORE=db' }),
    g7.out,
  );
  const g8 = guard('side1:prev', false, 1, dbEnv);
  check(
    '回滚前检查：没有标记文件而 .env 里是 SESSION_STORE=db，自动回滚到 02 之前的镜像同样拒绝',
    g8.code === 3 && refusedAutoSteps(g8.out, 'side1:prev', { slug: 'acme-3', why: '.env 里是 SESSION_STORE=db' }),
    g8.out,
  );
  const g9 = guard('pre-02', false, undefined, 'SESSION_STORE=db\nSESSION_STORE=file\n');
  check('回滚前检查：.env 里同名以最后一行为准，不是 db 存储时照常', g9.code === 0, g9.out);

  // 条目版本（02 第 8 步）：正在运行的实例 /healthz 的 config.catalogVersioned 为 true 时，回滚到 02 之前的镜像同样拒绝（4）。
  // /healthz 取不到、或里面没有这个字段时直接问库；库也问不到时，正在跑的容器本身是 02 之前的镜像就不算，否则按有风险处理。
  // 有这一条时不打印回到文件存储的步骤（去不掉它），写明只能回到 02 之后的镜像
  const versioned = '{"ok":true,"config":{"mode":"db","catalogVersioned":true},"store":{"mode":"file"}}';
  const catalogRefused = (out: string, why: string): boolean =>
    out.includes('拒绝回滚') && out.includes(why) && out.includes('要回滚只能回到 02 之后的镜像') && !out.includes('export-sessions');
  const psqlCalls = (g: { docker: string[] }): string[] => g.docker.filter((l) => l.includes('exec -T db psql'));
  check(
    '回滚前检查：问的是本机宿主端口上的 /healthz；/healthz 说了 false 就不问库',
    g1.curl.length === 1 && g1.curl[0]!.includes('http://127.0.0.1:3999/healthz') && psqlCalls(g1).length === 0,
    g1.curl.join(' | '),
  );
  const g10 = guard('pre-02', false, undefined, null, versioned);
  check(
    '回滚前检查：catalogVersioned 为 true、部署 02 之前的 tag → 拒绝（4），点名这一条，不打印导出步骤，不问库',
    g10.code === 4 && catalogRefused(g10.out, 'config.catalogVersioned 为 true') && psqlCalls(g10).length === 0,
    g10.out,
  );
  const g11 = guard('side1:prev', false, 1, null, versioned);
  check(
    '回滚前检查：catalogVersioned 为 true、自动回滚到 02 之前的镜像 → 拒绝（4）',
    g11.code === 4 && catalogRefused(g11.out, 'config.catalogVersioned 为 true') && g11.docker.length >= 1,
    g11.out,
  );
  const g12 = guard('side1:prev', false, 0, null, versioned);
  check('回滚前检查：catalogVersioned 为 true、目标是 02 之后的镜像 → 照常回滚', g12.code === 0, g12.out);
  // 首次上 02 失败后的自动回滚：新容器没过健康检查（/healthz 连不上），:prev 是 01；迁移的回填只写了版本 1 → 问库得 f，照常回滚
  const g13 = guard('side1:prev', false, 1, null, null, { db: 'f' });
  check(
    '回滚前检查：/healthz 连不上、目标是 02 之前的镜像（首次上 02 失败的自动回滚）→ 问库，没有版本大于 1 的条目，照常回滚；' +
      '问的是这个项目的 db 服务、按 .env.db 的库名（缺省 agent），在 / 下执行',
    g13.code === 0 &&
      psqlCalls(g13).length === 2 &&
      psqlCalls(g13).every((l) => l.startsWith('docker /|compose -p side1 exec -T db psql -U postgres -d agent -Atc')) &&
      psqlCalls(g13)[1]!.includes('select exists(select 1 from catalog_item_versions where version > 1)'),
    `${g13.code} ${g13.out} ${g13.docker.join(' / ')}`,
  );
  const g13b = guard('pre-02', false, undefined, null, null, { db: 'none', envDb: 'POSTGRES_PASSWORD=x\nAGENT_DB=agent_side\n' });
  check(
    '回滚前检查：/healthz 连不上、库里还没有 catalog_item_versions（02 之前的库）→ 没有这条风险；库名取 .env.db 的 AGENT_DB，表不在就不再查',
    g13b.code === 0 && psqlCalls(g13b).length === 1 && psqlCalls(g13b)[0]!.includes('-d agent_side '),
    `${g13b.code} ${g13b.out} ${g13b.docker.join(' / ')}`,
  );
  const g13c = guard('pre-02', false, undefined, null, null, { db: 't' });
  check(
    '回滚前检查：/healthz 连不上、库里有版本大于 1 的条目 → 拒绝（4），点名库里查到的',
    g13c.code === 4 && catalogRefused(g13c.out, '库里的 catalog_item_versions 有版本大于 1 的条目'),
    g13c.out,
  );
  const g13d = guard('side1:prev', false, 1, null, null, { running: 0 });
  check(
    '回滚前检查：/healthz 与库都问不到、正在跑的是 02 之后的镜像 → 按有风险处理，拒绝（4），提示先确认 db 在跑',
    g13d.code === 4 &&
      catalogRefused(g13d.out, '也问不到库，看不出有没有条目版本大于 1') &&
      g13d.out.includes('docker compose -p side1 ps db') &&
      g13d.docker.some((l) => l.includes('inspect --format {{.Image}} side1')),
    g13d.out,
  );
  const g13e = guard('pre-02', false, undefined, null, null, {});
  check(
    '回滚前检查：/healthz 与库都问不到、也看不出正在跑的镜像 → 拒绝（4）',
    g13e.code === 4 && catalogRefused(g13e.out, '也问不到库'),
    g13e.out,
  );
  const g13f = guard('side1:prev', false, 1, null, null, { running: 1 });
  check(
    '回滚前检查：/healthz 与库都问不到、正在跑的容器本身就是 02 之前的镜像 → 这一条不算风险，照常回滚',
    g13f.code === 0,
    `${g13f.code} ${g13f.out}`,
  );
  // 线上跑着 01（02 还没发版），从 dev 部署一个 01 的 tag：01 的 /healthz 没有这个字段，库是 01 的
  const g14 = guard('pre-02', false, undefined, null, '{"ok":true,"config":{"mode":"db"}}', { db: 'none' });
  check('回滚前检查：/healthz 里没有 catalogVersioned（跑着的是 01）、库里没有这张表 → 照常', g14.code === 0, `${g14.code} ${g14.out}`);
  const g14b = guard('pre-02', false, undefined, null, '{"ok":true,"config":{"mode":"db"}}', { db: 'f' });
  check('回滚前检查：/healthz 里没有 catalogVersioned、库里没有版本大于 1 的条目 → 照常', g14b.code === 0, `${g14b.code} ${g14b.out}`);
  const g14c = guard('pre-02', false, undefined, null, '{"ok":true,"config":{"mode":"db"}}', { db: 't' });
  check(
    '回滚前检查：/healthz 里没有 catalogVersioned、库里有版本大于 1 的条目 → 拒绝（4）',
    g14c.code === 4 && catalogRefused(g14c.out, '库里的'),
    g14c.out,
  );
  const g15 = guard('pre-02', true, undefined, null, versioned);
  check(
    '回滚前检查：有标记文件又 catalogVersioned 为 true → 拒绝（4），两条都点名，不打印回到文件存储的步骤（做完了也照样拒绝）',
    g15.code === 4 &&
      g15.out.includes('sessions-in-db.json') &&
      catalogRefused(g15.out, 'config.catalogVersioned 为 true') &&
      !g15.out.includes('再部署旧 tag'),
    g15.out,
  );
  const g16 = guard('pre-02', true, undefined, null, null, { db: 'f' });
  check(
    '回滚前检查：有标记文件、/healthz 连不上而库里没有版本大于 1 的条目 → 只有会话这一条，拒绝（3）并打印回到文件存储的步骤',
    g16.code === 3 && refusedWithSteps(g16.out) && !g16.out.includes('要回滚只能回到 02 之后的镜像'),
    g16.out,
  );

  // 03 R19：目标不认识渠道状态时，先导出渠道；只有默认企微 exported 可放行。既检查假 docker 的
  // 退出码与 stderr，也用 PGlite 执行脚本原文里的谓词，防止 NULL 前缀的网页账号被 SQL 三值逻辑漏掉。
  const channelSteps = (out: string, slug = 'acme-2'): boolean => {
    const dc = dcOf('side1', '3999');
    return (
      out.includes('拒绝回滚') &&
      out.includes(`1. ${dc} stop app`) &&
      out.includes(`${dc} run --rm -v /root/channels-keep-<日期>:/keep app`) &&
      out.includes(`src/cli/channel-export.ts --tenant ${slug} --var /app/var --keep /keep`) &&
      out.includes('当前 side1:current 镜像里的 channel-export') &&
      out.includes('var/channels-in-db.json 没了') &&
      out.includes('默认企微账号（kind = wecom_kf、id_prefix = wecom:）是 exported') &&
      out.includes('.env 里的 WECOM_* 还在') &&
      out.includes('只能回到 03 之后的镜像') &&
      out.indexOf('stop app') < out.indexOf('src/cli/channel-export.ts') &&
      out.indexOf('src/cli/channel-export.ts') < out.indexOf('var/channels-in-db.json 没了')
    );
  };
  const c1 = guard('pre-03', false, undefined, null, undefined, { channelMarker: true, channels: 'down' });
  check(
    '渠道回滚：标记在 → 5，不问库；先用当前镜像导出、确认默认账号 exported、用当前镜像起来顶住（mode = env），再部署旧 tag',
    c1.code === 5 &&
      channelSteps(c1.out) &&
      c1.out.includes(`4. 先用当前镜像把应用起来顶住`) &&
      c1.out.includes(`${dcOf('side1', '3999')} up -d app，curl -fsS http://127.0.0.1:3999/healthz 确认 channels.mode = env`) &&
      c1.out.includes('5. 再部署旧 tag') &&
      c1.out.indexOf('.env 里的 WECOM_* 还在') < c1.out.indexOf('4. 先用当前镜像') &&
      c1.out.indexOf('channels.mode = env') < c1.out.indexOf('5. 再部署旧 tag') &&
      c1.channelDocker.length === 0,
    `${c1.code} ${c1.out}`,
  );
  const channelSql = guardSrc.match(/select exists\(select 1 from channel_accounts where [^"\n]+\)/)?.[0];
  check('渠道回滚：查询脚本检查所有账号，没有 tenant 或 active 过滤', !!channelSql && !channelSql.includes('tenant_id'), channelSql);
  const { PGlite } = await import('@electric-sql/pglite');
  const channelPg = new PGlite();
  const accountCases: { name: string; rows: [string, string | null, string][]; risk: boolean }[] = [
    { name: '无账号', rows: [], risk: false },
    { name: '只有默认企微 exported', rows: [['wecom_kf', 'wecom:', 'exported']], risk: false },
    { name: '默认企微 active', rows: [['wecom_kf', 'wecom:', 'active']], risk: true },
    { name: '默认企微 disabled', rows: [['wecom_kf', 'wecom:', 'disabled']], risk: true },
    { name: '第二个企微 disabled', rows: [['wecom_kf', 'wecom:other:', 'disabled']], risk: true },
    { name: '第二个企微 exported', rows: [['wecom_kf', 'wecom:other:', 'exported']], risk: true },
    { name: '网页 active、NULL 前缀', rows: [['web', null, 'active']], risk: true },
    { name: '网页 disabled、NULL 前缀', rows: [['web', null, 'disabled']], risk: true },
    { name: '网页 exported、NULL 前缀', rows: [['web', null, 'exported']], risk: true },
    {
      name: '默认 exported 与网页 disabled 混合',
      rows: [
        ['wecom_kf', 'wecom:', 'exported'],
        ['web', null, 'disabled'],
      ],
      risk: true,
    },
  ];
  try {
    for (const c of accountCases) {
      const values = c.rows.length
        ? 'values ' + c.rows.map((_, i) => `($${i * 3 + 1}::text,$${i * 3 + 2}::text,$${i * 3 + 3}::text)`).join(',')
        : 'select null::text, null::text, null::text where false';
      const queried = channelSql
        ? (
            await channelPg.query<{ exists: boolean }>(
              `with channel_accounts(kind,id_prefix,status) as (${values}) ${channelSql}`,
              c.rows.flat(),
            )
          ).rows[0]!.exists
        : undefined;
      const c2 = guard('pre-03', false, undefined, 'DEFAULT_TENANT_SLUG=acme-3\n', undefined, {
        channels: queried ? 't' : 'f',
        envDb: 'AGENT_DB=agent_side\n',
      });
      check(
        `渠道回滚：${c.name} → ${c.risk ? 5 : 0}（真实 SQL 谓词与假 psql 一致）`,
        queried === c.risk &&
          c2.code === (c.risk ? 5 : 0) &&
          (c.risk ? channelSteps(c2.out, 'acme-3') && c2.out.includes('库里的 channel_accounts') : !c2.out.includes('拒绝回滚')) &&
          c2.channelDocker.length === 2 &&
          c2.channelDocker.every((l) => l.startsWith('docker03 /|compose -p side1 exec -T db psql -U postgres -d agent_side -Atc')) &&
          c2.channelDocker[1]!.endsWith(channelSql ?? 'missing'),
        `${queried} ${c2.code} ${c2.out} ${c2.channelDocker.join(' / ')}`,
      );
    }
  } finally {
    await channelPg.close();
  }
  const c3 = guard('pre-03', false, undefined, null, undefined, { channels: 'none' });
  check('渠道回滚：channel_accounts 表不在 → 0，只问 to_regclass', c3.code === 0 && c3.channelDocker.length === 1, c3.out);
  for (const channels of ['down', 'query-down', 'malformed']) {
    const c4 = guard('pre-03', false, undefined, 'DEFAULT_TENANT_SLUG=acme-3\n', undefined, { channels, runningRegistry: 0 });
    check(
      `渠道回滚：库 ${channels}、正在跑的是 03 之后 → 5，提示确认 db，仍打印导出步骤`,
      c4.code === 5 && channelSteps(c4.out, 'acme-3') && c4.out.includes('问不到库') && c4.out.includes('docker compose -p side1 ps db'),
      `${c4.code} ${c4.out}`,
    );
    const c5 = guard('pre-03', false, undefined, null, undefined, { channels, runningRegistry: 1 });
    check(`渠道回滚：库 ${channels}、正在跑的是 03 之前 → 0`, c5.code === 0, `${c5.code} ${c5.out}`);
  }
  for (const runningRegistry of [undefined, 125]) {
    const c6 = guard('pre-03', false, undefined, null, undefined, { channels: 'down', runningRegistry });
    check(
      `渠道回滚：库问不到、正在跑的镜像无法确认（${runningRegistry ?? 'inspect 失败'}）→ 5`,
      c6.code === 5 && c6.out.includes('按有风险处理'),
      c6.out,
    );
  }
  const c7 = guard('side1:prev', true, 0, null, versioned, { channelMarker: true, registry: 0, channels: 'down' });
  check(
    '渠道回滚：目标是 03 之后，即使三个风险都有也放行，不问渠道库',
    c7.code === 0 && c7.channelDocker.length === 1 && c7.channelDocker[0]!.includes('test -e /app/src/channels/registry.ts'),
    `${c7.code} ${c7.out}`,
  );
  for (const registry of [1, 125]) {
    const c8 = guard('side1:prev', false, 0, null, undefined, { channelMarker: true, registry });
    check(
      `渠道回滚：目标没有 registry 或 docker 出错（${registry}）→ 5，直接起目标并重打 current、检查宿主端口 revision`,
      c8.code === 5 &&
        channelSteps(c8.out) &&
        c8.out.includes('side1:current 已是这次没过健康检查的新镜像') &&
        c8.out.includes(`APP_IMAGE=side1:prev ${dcOf('side1', '3999')} up -d --no-deps app && docker tag side1:prev side1:current`) &&
        c8.out.includes('curl -fsS http://127.0.0.1:3999/healthz 确认 revision 是 old-v1') &&
        !c8.out.includes('再部署旧 tag') &&
        (registry !== 125 || c8.out.includes('docker 出错')),
      `${c8.code} ${c8.out}`,
    );
  }
  const c9 = guard('pre-02', true, undefined, null, versioned, { channelMarker: true });
  check(
    '渠道回滚：条目版本、会话与渠道同时在 → 4，只打印只能回到 02 之后，不打印任何导出步骤',
    c9.code === 4 &&
      catalogRefused(c9.out, 'config.catalogVersioned 为 true') &&
      c9.out.includes('channels-in-db.json') &&
      !c9.out.includes('channel-export'),
    `${c9.code} ${c9.out}`,
  );
  const c10 = guard('pre-03', true, undefined, null, versioned, { channelMarker: true });
  check(
    '渠道回滚：目标是 02 之后、03 之前，条目版本与会话风险不适用 → 5',
    c10.code === 5 && channelSteps(c10.out) && !c10.out.includes('export-sessions'),
    c10.out,
  );
  for (const target of ['pre-02', 'side1:prev']) {
    const c11 = guard(target, true, 1, null, undefined, { channelMarker: true });
    check(
      `渠道回滚：${target} 是 02 之前、会话与渠道都在库里 → 5，渠道导出之后接原来的会话导出步骤`,
      c11.code === 5 &&
        channelSteps(c11.out) &&
        (target === 'pre-02' ? refusedWithSteps(c11.out) : refusedAutoSteps(c11.out, target)) &&
        c11.out.indexOf('src/cli/channel-export.ts') < c11.out.indexOf('src/cli/export-sessions.ts'),
      `${c11.code} ${c11.out}`,
    );
  }
  const c12 = guard('pre-02', true, undefined, null, undefined, { channels: 'f' });
  check(
    '渠道回滚：只有会话风险仍是 3、原回退步骤不变',
    c12.code === 3 && refusedWithSteps(c12.out) && !c12.out.includes('channel-export'),
    c12.out,
  );

  // 与 ssh bash -s -- <参数> < rollback-guard.sh 相同的 stdin 入口；假 docker 会把继承的输入读到 EOF。
  const stdinActive = guard('pre-03', false, undefined, null, undefined, { channels: 't' });
  check(
    '回滚 stdin：bash -s、无渠道标记、默认企微 active → 5，两次渠道查询都执行，打印导出步骤',
    stdinActive.code === 5 && stdinActive.channelDocker.length === 2 && channelSteps(stdinActive.out, '<slug>'),
    `${stdinActive.code} ${stdinActive.out}`,
  );
  const stdinVersioned = guard('pre-02', false, undefined, null, null, { db: 't' });
  check(
    '回滚 stdin：bash -s、healthz 连不上、条目版本大于 1 → 4，两次条目查询都执行',
    stdinVersioned.code === 4 && psqlCalls(stdinVersioned).length === 2 && catalogRefused(stdinVersioned.out, '库里的'),
    `${stdinVersioned.code} ${stdinVersioned.out}`,
  );
  const stdinAllowed = guard('pre-02', false, undefined, null, null, { db: 'f', channels: 'f' });
  check(
    '回滚 stdin：bash -s、无标记、无高版本、只有默认企微 exported → 0，四次查询都执行完',
    stdinAllowed.code === 0 && psqlCalls(stdinAllowed).length === 2 && stdinAllowed.channelDocker.length === 2,
    `${stdinAllowed.code} ${stdinAllowed.out} ${stdinAllowed.docker.join(' / ')} ${stdinAllowed.channelDocker.join(' / ')}`,
  );

  // deploy.sh 的两处接线。部署旧 tag：在碰服务器之前（rsync 之前）检查；ssh 换成在本机执行远端命令，门禁一律成功，
  // 「服务器」是临时目录（旁路实例的三个值），rsync 一调用就记下并失败
  fs.mkdirSync(path.join(repo, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'deploy', 'rollback-guard.sh'), guardSrc);
  commitAndTag('v02', ['src/store/pg-backend.ts']);
  const dsrv = path.join(tmp, 'deploy-srv');
  fs.mkdirSync(path.join(dsrv, 'var'), { recursive: true });
  fs.writeFileSync(path.join(dsrv, '.env'), 'DEPLOY_PROFILE=demo\n');
  fs.writeFileSync(path.join(dsrv, '.env.db'), `${goodDb.join('\n')}\n`);
  fs.writeFileSync(path.join(dsrv, '.env.migrate'), 'DATABASE_OWNER_URL=postgres://agent_owner:o@db:5432/agent\n');
  const deployTo = (tag: string, marker: boolean): { code: number | null; out: string; log: string } => {
    fs.rmSync(log, { force: true });
    const m = path.join(dsrv, 'var', 'sessions-in-db.json');
    if (marker) fs.writeFileSync(m, '{}\n');
    else fs.rmSync(m, { force: true });
    Object.assign(env, { SERVER: 'fake@srv', REMOTE_DIR: dsrv, NAME: 'side1', HOST_PORT: '3999', FAKE_SSH_LOCAL: '1', FAKE_PNPM_OK: '1' });
    const r = run('bash', ['deploy.sh', tag], repo);
    for (const k of ['SERVER', 'REMOTE_DIR', 'NAME', 'HOST_PORT', 'FAKE_SSH_LOCAL', 'FAKE_PNPM_OK']) delete env[k];
    return { ...r, log: calls() };
  };
  const d1 = deployTo('new-v1', true);
  check(
    'deploy.sh：部署 02 之前的 tag 而服务器 var/ 里有标记文件，rsync 之前拒绝（1）并打印回退步骤',
    d1.code === 1 &&
      refusedWithSteps(d1.out, { slug: '<slug>' }) &&
      d1.out.includes('new-v1 是 02 之前的版本') &&
      !d1.log.includes('rsync '),
    `${d1.code} ${d1.out.slice(-600)}`,
  );
  const d2 = deployTo('new-v1', false);
  check(
    'deploy.sh：部署 02 之前的 tag、服务器没有标记文件时照常往下走（到 rsync）',
    d2.code !== 0 && !d2.out.includes('拒绝回滚') && d2.log.includes('rsync '),
    `${d2.code} ${d2.out.slice(-400)}`,
  );
  env.FAKE_HEALTHZ = '{"ok":true,"config":{"mode":"db","catalogVersioned":true}}';
  const d4 = deployTo('new-v1', false);
  delete env.FAKE_HEALTHZ;
  check(
    'deploy.sh：部署 02 之前的 tag 而改过上架条目的内容 → rsync 之前拒绝（1），提示只能部署 02 之后的 tag，不说先回到文件存储',
    d4.code === 1 &&
      d4.out.includes('new-v1 是 02 之前的版本') &&
      d4.out.includes('只能部署 02 之后的 tag') &&
      !d4.out.includes('先回到文件存储') &&
      !d4.log.includes('rsync '),
    `${d4.code} ${d4.out.slice(-600)}`,
  );
  check(
    'deploy.sh：只有会话在库里时（3）才说先回到文件存储',
    d1.out.includes('会话在库里：按上面的步骤先回到文件存储，再部署它') && !d1.out.includes('只能部署 02 之后的 tag'),
    d1.out.slice(-300),
  );
  const d3 = deployTo('v02', true);
  check(
    'deploy.sh：部署 02 之后的 tag 不做这道检查，有标记文件也照常往下走',
    d3.code !== 0 && !d3.out.includes('拒绝回滚') && d3.log.includes('rsync ') && !d3.log.includes('bash -s -- ' + dsrv + ' pre-02'),
    `${d3.code} ${d3.out.slice(-400)}`,
  );
  commitAndTag('v04', ['src/channels/registry.ts', 'src/core/pack-api.ts']);
  const deployChannel = (tag: string, channelMarker: boolean, channels = 'none') => {
    const cm = path.join(dsrv, 'var', 'channels-in-db.json');
    if (channelMarker) fs.writeFileSync(cm, '{}\n');
    env.FAKE_CHANNEL_DB = channels;
    try {
      return deployTo(tag, false);
    } finally {
      fs.rmSync(cm, { force: true });
      delete env.FAKE_CHANNEL_DB;
    }
  };
  for (const [tag, target] of [
    ['v02', 'pre-03'],
    ['new-v1', 'pre-02'],
  ] as const) {
    const d5 = deployChannel(tag, true);
    check(
      `deploy.sh：${tag} 按 tag 文件树选择 ${target}，渠道标记在 → rsync 前拒绝，打印 5 的部署提示`,
      d5.code === 1 &&
        channelSteps(d5.out, '<slug>') &&
        d5.out.includes('渠道状态在库里：按上面的步骤先 channel-export，再部署它') &&
        d5.log.includes(`bash -s -- ${dsrv} ${target} side1 3999`) &&
        !d5.log.includes('rsync '),
      `${d5.code} ${d5.out}`,
    );
  }
  const d6 = deployChannel('v02', false, 't');
  check(
    'deploy.sh：02 tag 没有渠道标记而库里仍有渠道风险，也在 rsync 前拒绝',
    d6.code === 1 && d6.out.includes('channel-export') && !d6.log.includes('rsync '),
    d6.out,
  );
  const d7 = deployChannel('v02', false, 'f');
  check(
    'deploy.sh：channel-export 后默认账号 exported，02 tag 检查放行并走到 rsync',
    d7.log.includes(`bash -s -- ${dsrv} pre-03`) && d7.log.includes('rsync ') && !d7.out.includes('拒绝回滚'),
    d7.out,
  );
  const d8 = deployChannel('v04', true, 'down');
  check(
    'deploy.sh：04 tag 有 pack-api.ts，不调用旧镜像检查，渠道标记与库故障不拦下部署',
    d8.log.includes('rsync ') && !d8.log.includes(`bash -s -- ${dsrv} pre-`) && !d8.out.includes('拒绝回滚'),
    d8.out,
  );
  // 自动回滚：:prev 在服务器上之后、起 :prev 之前过同一道检查，过不了就停下（不起 :prev）
  const rb = deploySrc.indexOf('[rollback] 回滚到上一个镜像');
  const gp = deploySrc.indexOf('guard_rollback "${NAME}:prev" || {');
  const up = deploySrc.indexOf('up -d --no-deps app');
  check(
    'deploy.sh：健康检查失败后的自动回滚先过回滚前检查，拒绝时以 1 退出、不起 :prev',
    rb > 0 &&
      rb < gp &&
      gp < up &&
      /guard_rollback "\$\{NAME\}:prev" \|\| \{\n {2}case \$\? in\n(?: {4}[3456*]\) echo "[^\n]*" >&2 ;;\n){5} {2}esac\n {2}exit 1\n\}\n/.test(
        deploySrc,
      ),
  );
  check(
    'deploy.sh：自动回滚的 5 分支专用提示指出渠道状态在库里，并要求先 channel-export 再起目标镜像',
    /^ {4}5\) echo "[^\n]*是 03 之前的镜像而渠道状态在库里[^\n]*没有自动回滚[^\n]*服务当前不可用[^\n]*先 channel-export，再起它[^\n]*" >&2 ;;$/m.test(
      deploySrc.slice(gp, up),
    ),
  );
  check(
    'deploy.sh：两处用的是同一个 guard_rollback，经 ssh 把本地的 rollback-guard.sh 交给服务器上的 bash -s（带上项目名与宿主端口）',
    /guard_rollback\(\) \{ ssh "\$\{SERVER\}" bash -s -- "\$REMOTE_DIR" "\$1" "\$NAME" "\$HOST_PORT" <deploy\/rollback-guard\.sh; \}/.test(
      deploySrc,
    ) && (deploySrc.match(/guard_rollback /g) ?? []).length === 2,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------- 真实 Postgres（spec R13：RLS、授权、租户锁的结论只从这里得出） ----------------
// PG_TEST_URL 是一个专用测试集群的超级用户连接串（CI 的服务容器，或本机的一次性容器）：本组建一个临时库，
// 按 roles.sql 建角色——角色是集群级的，已存在就改口令——跑完删库。不要指向开发或线上用的集群
const PG_TEST_URL = process.env.PG_TEST_URL;
let realPgRan = false;
if (PG_TEST_URL) {
  await realPostgres(PG_TEST_URL);
  realPgRan = true;
} else if (process.env.CI === 'true') {
  fails.push('CI 下必须设 PG_TEST_URL：RLS、授权与租户锁只在真实 Postgres 上测（spec R13），不能静默跳过');
} else {
  console.log('DB SELFTEST：没有 PG_TEST_URL，跳过真实 Postgres 部分（RLS、授权、租户锁）');
}

async function realPostgres(superUrl: string): Promise<void> {
  const { default: pg } = await import('pg');
  const { openDb, holdTenantLock } = await import('./client.js');
  const { runMigrations } = await import('./migrate.js');
  const lit = (v: string): string => `'${v.replaceAll("'", "''")}'`;
  const ident = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const cleanup: (() => Promise<unknown>)[] = [];
  const login = async (url: string): Promise<InstanceType<typeof pg.Client>> => {
    const c = new pg.Client({ connectionString: url });
    c.on('error', () => {});
    await c.connect();
    cleanup.push(() => c.end());
    return c;
  };
  const rowsIn =
    (c: InstanceType<typeof pg.Client>): Query =>
    async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
      (await c.query(text, params)).rows as R[];

  const su = new pg.Client({ connectionString: superUrl });
  su.on('error', () => {});
  await su.connect();
  const [me] = (await su.query<{ su: boolean }>('select rolsuper as su from pg_roles where rolname = current_user')).rows;
  if (!me?.su) {
    fails.push('PG_TEST_URL 必须是超级用户：要建库、建角色');
    await su.end();
    return;
  }
  const dbName = `agent_selftest_${randomBytes(4).toString('hex')}`;
  const pw = { owner: randomBytes(12).toString('hex'), app: randomBytes(12).toString('hex'), platform: randomBytes(12).toString('hex') };
  const urlAs = (user: string, password: string): string => {
    const u = new URL(superUrl);
    u.username = user;
    u.password = password;
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const superInDb = (() => {
    const u = new URL(superUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  })();
  const OWNER = urlAs('agent_owner', pw.owner);
  const APP = urlAs('agent_app', pw.app);
  const PLATFORM = urlAs('agent_platform', pw.platform);

  try {
    // roles.sql：做 roles.sh 同样的替换（已存在的角色 CREATE → ALTER），逐行执行（CREATE DATABASE 不能进多语句的隐式事务）
    const ROLES = ['agent_owner', 'agent_app', 'agent_platform'];
    const existing = new Set(
      (await su.query<{ r: string }>('select rolname as r from pg_roles where rolname = any($1)', [ROLES])).rows.map((x) => x.r),
    );
    const statements = fs
      .readFileSync(path.join(import.meta.dirname, '..', '..', 'deploy', 'db-init', 'roles.sql'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('--'))
      .map((l) => {
        const m = /^CREATE ROLE (\w+) /.exec(l);
        const line = m && existing.has(m[1]!) ? l.replace('CREATE ROLE', 'ALTER ROLE') : l;
        return line
          .replaceAll(":'owner_password'", lit(pw.owner))
          .replaceAll(":'app_password'", lit(pw.app))
          .replaceAll(":'platform_password'", lit(pw.platform))
          .replaceAll(':"db_name"', ident(dbName));
      });
    check('真实 PG：roles.sql 的变量都替换掉了', statements.length > 0 && statements.every((l) => !/:['"]/.test(l)));
    for (const stmt of statements) await su.query(stmt);
    const suDb = await login(superInDb);
    const sq = rowsIn(suDb);

    // ---- 迁移 ----
    const guard = await outcome(runMigrations(superInDb));
    check('真实 PG：迁移拒绝以 agent_owner 以外的身份执行', guard.includes('agent_owner'), guard);
    check('真实 PG：以 agent_owner 跑迁移', (await outcome(runMigrations(OWNER))) === 'ok');
    check('真实 PG：迁移再跑一遍不报错', (await outcome(runMigrations(OWNER))) === 'ok');
    const journal = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    const [applied] = await sq<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations');
    check('真实 PG：journal 里每一条都只应用了一次', Number(applied?.n) === journal.entries.length, applied?.n);
    await schemaChecks(sq, '真实 PG ');

    // ---- 库级权限与角色设置（roles.sql） ----
    const [dbp] = await sq<Record<string, boolean>>(
      `select has_database_privilege('public', $1, 'CONNECT') as pub_connect, has_database_privilege('public', $1, 'TEMPORARY') as pub_temp,
              has_database_privilege('agent_app', $1, 'TEMPORARY') as app_temp, has_database_privilege('agent_app', $1, 'CONNECT') as app_connect,
              (select pg_get_userbyid(datdba) from pg_database where datname = $1) = 'agent_owner' as owner_ok,
              (select pg_encoding_to_char(encoding) from pg_database where datname = $1) = 'UTF8' as utf8`,
      [dbName],
    );
    check('真实 PG：库的属主是 agent_owner、编码 UTF8', dbp?.owner_ok === true && dbp.utf8 === true, JSON.stringify(dbp));
    check(
      '真实 PG：PUBLIC 没有 CONNECT 与 TEMPORARY，agent_app 能连、不能建临时表',
      dbp?.pub_connect === false && dbp.pub_temp === false && dbp.app_connect === true && dbp.app_temp === false,
      JSON.stringify(dbp),
    );
    const attrs = await sq<{ rolname: string; ok: boolean }>(
      `select rolname, (not rolsuper and not rolbypassrls and not rolcreaterole and rolcanlogin and not rolcreatedb) as ok
         from pg_roles where rolname = any($1) order by 1`,
      [ROLES],
    );
    check(
      '真实 PG：三个角色都能登录，不是超级用户，没有 BYPASSRLS、CREATEROLE、CREATEDB',
      attrs.length === 3 && attrs.every((r) => r.ok),
      JSON.stringify(attrs),
    );
    const app = await login(APP);
    const platform = await login(PLATFORM);
    const owner = await login(OWNER);
    const [timeouts] = (
      await app.query<{ st: string; it: string }>(
        `select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as it`,
      )
    ).rows;
    check(
      '真实 PG：agent_app 登录后带着 5 秒语句超时与 10 秒事务空闲超时',
      timeouts?.st === '5s' && timeouts.it === '10s',
      JSON.stringify(timeouts),
    );

    // ---- 各角色对各表的期望（spec 表格），逐格 ----
    const EXPECT: Record<string, { agent_app: string; agent_platform: string }> = {
      tenants: { agent_app: 'SELECT', agent_platform: 'SELECT,INSERT' },
      users: { agent_app: '', agent_platform: 'SELECT,INSERT,UPDATE' },
      auth_sessions: { agent_app: '', agent_platform: 'SELECT,DELETE' },
      memberships: { agent_app: '', agent_platform: 'SELECT,INSERT,UPDATE,DELETE' },
      sop_versions: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      catalog_items: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      audit_log: { agent_app: 'SELECT,INSERT', agent_platform: 'SELECT,INSERT' },
      // 02 spec「数据库」的授权表：没有任何角色对新表有 DELETE 或 TRUNCATE
      conversations: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      orders: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      messages: { agent_app: 'SELECT,INSERT', agent_platform: '' },
      turn_traces: { agent_app: 'SELECT,INSERT', agent_platform: '' },
      guard_events: { agent_app: 'SELECT,INSERT', agent_platform: '' },
      consents: { agent_app: 'SELECT,INSERT', agent_platform: '' },
      catalog_item_versions: { agent_app: 'SELECT,INSERT', agent_platform: '' },
      usage_daily: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      jobs: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      outbound_sends: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      quick_replies: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
      privacy_notices: { agent_app: 'SELECT', agent_platform: 'SELECT,INSERT' },
      // 03 spec「数据库」的授权表：channel_accounts 的 UPDATE 是列级的（下面单独核），表级只有 SELECT、INSERT
      channel_accounts: { agent_app: 'SELECT,INSERT', agent_platform: '' },
      channel_inbox: { agent_app: 'SELECT,INSERT,UPDATE', agent_platform: '' },
    };
    const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    for (const [table, byRole] of Object.entries(EXPECT)) {
      for (const role of ['agent_app', 'agent_platform'] as const) {
        const got = (
          await sq<{ p: string }>('select p from unnest($3::text[]) as p where has_table_privilege($1, $2, p)', [
            role,
            `public.${table}`,
            PRIVS,
          ])
        )
          .map((r) => r.p)
          .join(',');
        check(`真实 PG：${role} 对 ${table} 的表权限正好是「${byRole[role] || '无'}」`, got === byRole[role], got || '无');
      }
    }
    check(
      '真实 PG：权限期望表覆盖了 02 的十二张新表',
      NEW_TABLES.every((x) => x in EXPECT),
    );
    check(
      '真实 PG：权限期望表覆盖了 03 的两张新表',
      CHANNEL_TABLES.every((x) => x in EXPECT),
    );
    // 不变量 5（03 不变量 21）：两个角色对任何新表都没有 DELETE、TRUNCATE（上面逐格已含，这里单列，改了期望表也拦得住）
    for (const table of [...NEW_TABLES, ...CHANNEL_TABLES]) {
      const [dt] = await sq<{ d: boolean; t: boolean }>(
        `select bool_or(has_table_privilege(r, $1, 'DELETE')) as d, bool_or(has_table_privilege(r, $1, 'TRUNCATE')) as t
           from unnest(array['agent_app', 'agent_platform']) as r`,
        [`public.${table}`],
      );
      check(
        `真实 PG：agent_app 与 agent_platform 对 ${table} 都没有 DELETE、TRUNCATE`,
        dt?.d === false && dt.t === false,
        JSON.stringify(dt),
      );
    }
    const [verdictPriv] = await sq<{ app_read: boolean; app_insert: boolean; app_update: boolean; platform: boolean }>(
      `select has_column_privilege('agent_app', 'public.turn_traces', 'guard_verdicts', 'SELECT') as app_read,
              has_column_privilege('agent_app', 'public.turn_traces', 'guard_verdicts', 'INSERT') as app_insert,
              has_column_privilege('agent_app', 'public.turn_traces', 'guard_verdicts', 'UPDATE') as app_update,
              has_column_privilege('agent_platform', 'public.turn_traces', 'guard_verdicts', 'SELECT,INSERT,UPDATE,REFERENCES') as platform`,
    );
    check(
      '真实 PG：guard_verdicts 只允许 agent_app SELECT、INSERT，不能 UPDATE，agent_platform 无列权限',
      verdictPriv?.app_read === true &&
        verdictPriv.app_insert === true &&
        verdictPriv.app_update === false &&
        verdictPriv.platform === false,
      JSON.stringify(verdictPriv),
    );
    // tenants 的三个保留期列：agent_platform 列级 UPDATE，agent_app 一列都不能改
    const UPDATABLE = ['retention_lead_days', 'retention_customer_days', 'retention_trace_days', 'brand'];
    const colPriv = await sq<{ col: string; platform: boolean; app: boolean }>(
      `select a.attname as col, has_column_privilege('agent_platform', 'public.tenants', a.attname, 'UPDATE') as platform,
              has_column_privilege('agent_app', 'public.tenants', a.attname, 'UPDATE') as app
         from pg_attribute a where a.attrelid = 'public.tenants'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    );
    check(
      '真实 PG：agent_platform 只能 UPDATE tenants 的三个保留期列与品牌列，agent_app 一列都不能',
      colPriv
        .filter((c) => c.platform)
        .map((c) => c.col)
        .join(',') === UPDATABLE.join(',') && colPriv.every((c) => !c.app),
      JSON.stringify(colPriv.filter((c) => c.platform || c.app)),
    );
    // 03：channel_accounts 上 agent_app 只能 UPDATE 九列（身份五列、tenant_id、id、created_at 改不了），agent_platform 一列都没有
    const chanColPriv = await sq<{ col: string; app_update: boolean; app_select: boolean; app_insert: boolean; platform: boolean }>(
      `select a.attname as col,
              has_column_privilege('agent_app', 'public.channel_accounts', a.attname, 'UPDATE') as app_update,
              has_column_privilege('agent_app', 'public.channel_accounts', a.attname, 'SELECT') as app_select,
              has_column_privilege('agent_app', 'public.channel_accounts', a.attname, 'INSERT') as app_insert,
              has_column_privilege('agent_platform', 'public.channel_accounts', a.attname, 'SELECT,INSERT,UPDATE,REFERENCES') as platform
         from pg_attribute a where a.attrelid = 'public.channel_accounts'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    );
    check(
      '真实 PG：agent_app 对 channel_accounts 只能 UPDATE name、status、凭据密文与 key id、cursor 两列、恢复截止点、settings、updated_at',
      chanColPriv
        .filter((c) => c.app_update)
        .map((c) => c.col)
        .toSorted()
        .join(',') === CHANNEL_ACCOUNT_UPDATABLE.toSorted().join(','),
      JSON.stringify(chanColPriv.filter((c) => c.app_update).map((c) => c.col)),
    );
    check(
      '真实 PG：agent_app 能读、能插 channel_accounts 的每一列，agent_platform 一列都碰不到',
      chanColPriv.length === 17 && chanColPriv.every((c) => c.app_select && c.app_insert && !c.platform),
      JSON.stringify(chanColPriv.filter((c) => !c.app_select || !c.app_insert || c.platform)),
    );
    const fnPriv = await sq<{ fn: string; app: boolean; platform: boolean }>(
      `select p.oid::regprocedure::text as fn, has_function_privilege('agent_app', p.oid, 'EXECUTE') as app,
              has_function_privilege('agent_platform', p.oid, 'EXECUTE') as platform
         from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
    );
    for (const f of fnPriv) {
      const name = f.fn.slice(0, f.fn.indexOf('('));
      const grantee = Object.hasOwn(PURGE_FNS, name) ? PURGE_FNS[name] : name.startsWith('auth_') ? 'agent_app' : null;
      const app = grantee === 'agent_app';
      const plat = grantee === 'agent_platform';
      check(
        `真实 PG：${f.fn} 的 EXECUTE：agent_app ${app ? '有' : '没有'}，agent_platform ${plat ? '有' : '没有'}`,
        f.app === app && f.platform === plat,
        JSON.stringify(f),
      );
    }
    const [mig] = await sq<Record<string, boolean>>(
      `select has_table_privilege('agent_app', 'drizzle.__drizzle_migrations', 'SELECT') as app_select,
              has_table_privilege('agent_app', 'drizzle.__drizzle_migrations', 'INSERT') as app_insert,
              has_table_privilege('agent_platform', 'drizzle.__drizzle_migrations', 'SELECT') as platform_select`,
    );
    check(
      '真实 PG：agent_app 只能读迁移记录，agent_platform 读不到',
      mig?.app_select === true && mig.app_insert === false && mig.platform_select === false,
      JSON.stringify(mig),
    );

    // ---- 造数据（超级用户，绕过 RLS） ----
    const [{ id: A }] = await sq<{ id: string }>(
      `insert into tenants (slug, name, pack_id) values ('tenant-a', 'A', 'travel') returning id`,
    );
    const [{ id: B }] = await sq<{ id: string }>(
      `insert into tenants (slug, name, pack_id) values ('tenant-b', 'B', 'travel') returning id`,
    );
    const [{ id: C }] = await sq<{ id: string }>(
      `insert into tenants (slug, name, pack_id) values ('tenant-c', 'C', 'travel') returning id`,
    );
    const [{ id: U }] = await sq<{ id: string }>(
      `insert into users (email, display_name, password_hash) values ('Ops@Example.com', '运营', 'scrypt$real') returning id`,
    );
    const [{ id: U2 }] = await sq<{ id: string }>(
      `insert into users (email, display_name, password_hash) values ('two@example.com', '二号', 'scrypt$two') returning id`,
    );
    await sq(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'admin'), ($3, $4, 'viewer')`, [A, U, B, U2]);
    for (const [tenant, code] of [
      [A, 'r-a'],
      [B, 'r-b'],
    ]) {
      const r = released(`${code}`);
      await sq(
        `insert into sop_versions (tenant_id, version_no, status, source, pack_id, sections, rendered_prompt, prompt_hash, tools_hash, prefix_hash, sop_hash, render_inputs, published_at)
         values ($1, 1, 'published', 'import', 'travel', $2, $3, $4, $5, $6, $7, $8, now())`,
        [tenant, SECTIONS, r.rendered, r.promptHash, r.toolsHash, r.prefixHash, r.sopHash, r.renderInputs],
      );
      await sq(`insert into catalog_items (tenant_id, kind, code, ord, payload, status) values ($1, 'route', $2, 0, $3, 'active')`, [
        tenant,
        code,
        JSON.stringify({ id: code }),
      ]);
      await sq(`insert into audit_log (tenant_id, actor_kind, action) values ($1, 'system', 'seed')`, [tenant]);
    }

    // ---- 行为：有权限的格子没设租户时读到 0 行、写入被 RLS 拒；无权限的格子报 permission denied ----
    const denial = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        const err = pgErr(e);
        if (err?.code !== DENIED) return err ? `${err.code} ${err.message}` : notDb(e);
        return /row-level security/.test(err.message) ? 'rls' : /permission denied/.test(err.message) ? 'denied' : err.message;
      }
    };
    const INSERTS: Record<string, [string, unknown[]]> = {
      memberships: [`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'viewer')`, [A, U2]],
      sop_versions: [
        `insert into sop_versions (tenant_id, status, source, pack_id, sections) values ($1, 'draft', 'console', 'travel', '[]')`,
        [C],
      ],
      catalog_items: [
        `insert into catalog_items (tenant_id, kind, code, ord, payload) values ($1, 'route', 'r-new', 9, '{"id":"r-new"}')`,
        [A],
      ],
      audit_log: [`insert into audit_log (tenant_id, actor_kind, action) values ($1, 'system', 'x')`, [A]],
      conversations: [
        `insert into conversations (tenant_id, id, channel, stage, handed_over, state, created_at, updated_at)
         values ($1, 'c-rls', 'wecom', 'greeting', false, '{"id":"c-rls"}', now(), now())`,
        [A],
      ],
      messages: [
        `insert into messages (tenant_id, conversation_id, seq, role, content, at) values ($1, 'c-rls', 1, 'customer', 'x', now())`,
        [A],
      ],
      orders: [
        `insert into orders (tenant_id, id, route_id, status, total_price, created_at, data)
         values ($1, 'ord_rls', 'r-a', 'pending_payment', 1, now(), '{"id":"ord_rls"}')`,
        [A],
      ],
      turn_traces: [
        `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
         values ($1, gen_random_uuid(), 'c-rls', now(), 1, 'replied', repeat('a', 64), '{}', '[]', '[]')`,
        [A],
      ],
      guard_events: [
        `insert into guard_events (tenant_id, turn_id, ord, guard, action, removed, added) values ($1, gen_random_uuid(), 0, 'price', 'replace', '[]', '[]')`,
        [A],
      ],
      usage_daily: [`insert into usage_daily (tenant_id, day, model, purpose) values ($1, current_date, 'm', 'chat')`, [A]],
      jobs: [
        `insert into jobs (tenant_id, kind, dedupe_key, run_at, max_attempts, payload) values ($1, 'followup', 'k-rls', now(), 1, '{}')`,
        [A],
      ],
      quick_replies: [`insert into quick_replies (tenant_id, ord, title, body) values ($1, 0, 't', 'b')`, [A]],
      outbound_sends: [
        `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status) values ($1, 'c-rls', 'm-rls', 'ai', now(), 'accepted')`,
        [A],
      ],
      catalog_item_versions: [
        `insert into catalog_item_versions (tenant_id, kind, code, version, payload, source) values ($1, 'route', 'r-a', 9, '{"id":"r-a"}', 'console')`,
        [A],
      ],
      privacy_notices: [`insert into privacy_notices (tenant_id, version, body) values ($1, 1, 'x')`, [A]],
      consents: [
        `insert into consents (tenant_id, conversation_id, category, decision, notice_version, at) values ($1, 'c-rls', 'health', 'asked', 1, now())`,
        [A],
      ],
      channel_accounts: [`insert into channel_accounts (tenant_id, key, kind, name) values ($1, 'web-rls', 'web', '网页')`, [A]],
      channel_inbox: [
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state) values ($1, gen_random_uuid(), 'm-rls', 'message', 'wecom:wmRls', 'received')`,
        [A],
      ],
    };
    const clients = { agent_app: app, agent_platform: platform, agent_owner: owner };
    for (const table of Object.keys(INSERTS)) {
      for (const role of ['agent_app', 'agent_platform', 'agent_owner'] as const) {
        const c = clients[role];
        const allowed = role === 'agent_owner' ? 'SELECT,INSERT' : EXPECT[table]![role];
        const has = (p: string): boolean => allowed.split(',').includes(p);
        const sel = await denial(
          c.query(`select count(*)::int as n from ${table}`).then((r) => {
            if (r.rows[0].n !== 0) throw new Error(`读到 ${r.rows[0].n} 行`);
          }),
        );
        check(
          `真实 PG：${role} 没设租户时 SELECT ${table}：${has('SELECT') ? '0 行' : 'permission denied'}`,
          sel === (has('SELECT') ? 'ok' : 'denied'),
          sel,
        );
        const [text, params] = INSERTS[table]!;
        const ins = await denial(c.query(text, params));
        check(
          `真实 PG：${role} 没设租户时 INSERT ${table}：${has('INSERT') ? '被 RLS 拒' : 'permission denied'}`,
          ins === (has('INSERT') ? 'rls' : 'denied'),
          ins,
        );
      }
    }
    check('真实 PG：agent_app 直接 SELECT users 报 permission denied', (await denial(app.query('select 1 from users'))) === 'denied');
    check('真实 PG：agent_app 删除版本报 permission denied（验收 7）', (await denial(app.query('delete from sop_versions'))) === 'denied');
    check('真实 PG：agent_platform 能读 users、tenants', (await denial(platform.query('select 1 from users, tenants'))) === 'ok');

    // ---- 租户隔离（经 openDb + withTenant，node-postgres） ----
    const appDb = await openDb(APP);
    cleanup.push(() => appDb.close());
    const ctx = (tenantId: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } });
    const inA = await withTenant(appDb.db, ctx(A), async (tx) => {
      const seen = rowsOf<{ tenant_id: string }>(
        await tx.execute(
          sql`select tenant_id from catalog_items union all select tenant_id from sop_versions union all select tenant_id from audit_log`,
        ),
      );
      const upd = (await tx.execute(sql`update catalog_items set payload = payload where tenant_id = ${B}`)) as unknown as {
        rowCount: number;
      };
      return { seen, updated: upd.rowCount };
    });
    check(
      '真实 PG：租户 A 的事务里看不到 B 的行',
      inA.seen.length > 0 && inA.seen.every((r) => r.tenant_id === A),
      JSON.stringify(inA.seen),
    );
    check('真实 PG：租户 A 的事务里 UPDATE B 的行影响 0 行', inA.updated === 0, String(inA.updated));
    const crossInsert = await denial(
      withTenant(appDb.db, ctx(A), (tx) =>
        tx.execute(sql`insert into audit_log (tenant_id, actor_kind, action) values (${B}, 'system', 'x')`),
      ),
    );
    check('真实 PG：租户 A 的事务里写 B 的行被 RLS 拒', crossInsert === 'rls', crossInsert);

    // 一个事务设过租户并提交，同一连接上的下一个事务不设租户，读到 0 行
    await app.query('begin');
    await app.query(`select set_config('app.tenant_id', $1, true)`, [A]);
    const [withT] = (await app.query<{ n: number }>('select count(*)::int as n from catalog_items')).rows;
    await app.query('commit');
    const [afterT] = (
      await app.query<{ n: number; v: string | null }>(
        `select count(*)::int as n, current_setting('app.tenant_id', true) as v from catalog_items`,
      )
    ).rows;
    check(
      '真实 PG：事务级租户在提交后失效，下一个事务读到 0 行',
      withT?.n === 1 && afterT?.n === 0 && !afterT.v,
      JSON.stringify({ withT, afterT }),
    );

    // 会话级 SET 泄漏：连接池只有一条连接，归还后下一次 withTenant 借到它，抛错并销毁；之后换一条干净连接
    const one = await openDb(APP, { max: 1 });
    cleanup.push(() => one.close());
    const pidOf = (): Promise<number> =>
      withTenant(one.db, ctx(A), async (tx) => rowsOf<{ p: number }>(await tx.execute(sql`select pg_backend_pid() as p`))[0]!.p);
    const pid1 = await pidOf();
    await one.db.execute(sql`select set_config('app.tenant_id', ${A}, false)`);
    const leaked = await outcome(withTenant(one.db, ctx(A), async () => 1));
    check('真实 PG：会话级 SET 过租户的连接，下一次 withTenant 抛错', leaked.includes('会话级'), leaked);
    const pid2 = await pidOf();
    check('真实 PG：那条连接被销毁，之后借到的是新连接', pid2 !== pid1, `${pid1} → ${pid2}`);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      gone = (await sq('select 1 from pg_stat_activity where pid = $1', [pid1])).length === 0;
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    check('真实 PG：被销毁的那条连接在服务端也断开了', gone);

    // json 列经 node-postgres 读回，键序与嵌套键序都不变（验收 2 的逐条比较在第 6 步）
    const payload = { id: 'r-order', title: '键序', zeta: 1, alpha: { yy: 2, bb: [3, { z: 1, a: 2 }] }, overseas: false };
    await withTenant(appDb.db, ctx(A), (tx) =>
      tx.insert(catalogItems).values({ tenantId: A, kind: 'route', code: 'r-order', ord: 5, payload }),
    );
    const [back] = await withTenant(appDb.db, ctx(A), (tx) => tx.select().from(catalogItems).where(eq(catalogItems.code, 'r-order')));
    check(
      '真实 PG：json 经 node-postgres 读回键序不变',
      JSON.stringify(back?.payload) === JSON.stringify(payload),
      JSON.stringify(back?.payload),
    );
    const guarded = await why(
      withTenant(appDb.db, ctx(A), (tx) => tx.execute(sql`update sop_versions set sections = '[]'::jsonb where tenant_id = ${A}`)),
    );
    check('真实 PG：agent_app 改已发布版本被触发器拒（验收 7）', guarded === 'trigger', guarded);

    // ---- 02：消息只追加、新表的租户隔离、longRunning、清除与删除函数 ----
    /** 以 role 在一个事务里执行一条语句；tenant 不为 null 时先在事务内设好租户（与 withTenant 相同） */
    const asRole = async <R = Record<string, unknown>>(
      role: DbRole,
      tenant: string | null,
      text: string,
      params: unknown[] = [],
    ): Promise<R[]> => {
      const c = role === 'agent_app' ? app : platform;
      await c.query('begin');
      try {
        if (tenant) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
        const r = await c.query(text, params);
        await c.query('commit');
        return r.rows as R[];
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      }
    };
    // 两个租户各一套 02 的行（超级用户造，绕过 RLS）
    for (const [tenant, code] of [
      [A, 'r-a'],
      [B, 'r-b'],
    ]) {
      const turn = randomUUID();
      await sq(
        `insert into conversations (tenant_id, id, channel, stage, handed_over, state, last_seq, created_at, updated_at)
         values ($1, 'c-iso', 'wecom', 'greeting', false, '{"id":"c-iso"}', 1, now(), now())`,
        [tenant],
      );
      await sq(
        `insert into messages (tenant_id, conversation_id, seq, role, content, at) values ($1, 'c-iso', 1, 'customer', '在吗', now())`,
        [tenant],
      );
      await sq(
        `insert into orders (tenant_id, id, session_id, route_id, status, total_price, created_at, data)
         values ($1, 'ord_iso', 'c-iso', $2, 'pending_payment', 1, now(), '{"id":"ord_iso"}')`,
        [tenant, code],
      );
      await sq(
        `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
         values ($1, $2, 'c-iso', now(), 1, 'replied', repeat('a', 64), '{}', '[]', '[]')`,
        [tenant, turn],
      );
      await sq(
        `insert into guard_events (tenant_id, turn_id, ord, guard, action, removed, added) values ($1, $2, 0, 'price', 'replace', '[]', '[]')`,
        [tenant, turn],
      );
      await sq(`insert into usage_daily (tenant_id, day, model, purpose, calls) values ($1, current_date, 'm', 'chat', 1)`, [tenant]);
      await sq(
        `insert into jobs (tenant_id, kind, dedupe_key, run_at, max_attempts, payload) values ($1, 'followup', 'k-iso', now(), 1, '{}')`,
        [tenant],
      );
      await sq(`insert into quick_replies (tenant_id, ord, title, body) values ($1, 0, '问候', '您好')`, [tenant]);
      await sq(
        `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status) values ($1, 'c-iso', 'm-iso', 'ai', now(), 'accepted')`,
        [tenant],
      );
      await sq(
        `insert into catalog_item_versions (tenant_id, kind, code, version, payload, source) values ($1, 'route', $2, 1, $3, 'backfill')`,
        [tenant, code, JSON.stringify({ id: code })],
      );
      await sq(`insert into privacy_notices (tenant_id, version, body) values ($1, 1, '隐私说明')`, [tenant]);
      await sq(
        `insert into consents (tenant_id, conversation_id, category, decision, notice_version, at) values ($1, 'c-iso', 'health', 'asked', 1, now())`,
        [tenant],
      );
    }
    const seenNew = await asRole<{ t: string; tenant_id: string }>(
      'agent_app',
      A,
      NEW_TABLES.map((tb) => `select '${tb}' as t, tenant_id from ${tb}`).join(' union all '),
    );
    check(
      '真实 PG：租户 A 的事务里，十二张新表都只看得到 A 的行',
      new Set(seenNew.map((r) => r.t)).size === NEW_TABLES.length && seenNew.every((r) => r.tenant_id === A),
      JSON.stringify(seenNew.filter((r) => r.tenant_id !== A)),
    );
    for (const tb of ['conversations', 'orders', 'jobs', 'quick_replies', 'outbound_sends', 'usage_daily']) {
      const [u] = await asRole<{ n: number }>(
        'agent_app',
        A,
        `with u as (update ${tb} set tenant_id = tenant_id where tenant_id = $1 returning 1) select count(*)::int as n from u`,
        [B],
      );
      check(`真实 PG：租户 A 的事务里 UPDATE B 的 ${tb} 影响 0 行`, u?.n === 0, JSON.stringify(u));
    }
    const crossMsg = await denial(
      asRole(
        'agent_app',
        A,
        `insert into messages (tenant_id, conversation_id, seq, role, content, at) values ($1, 'c-iso', 2, 'customer', 'x', now())`,
        [B],
      ),
    );
    check('真实 PG：租户 A 的事务里写 B 的消息被 RLS 拒', crossMsg === 'rls', crossMsg);
    const crossNotice = await denial(
      asRole('agent_platform', A, `insert into privacy_notices (tenant_id, version, body) values ($1, 2, 'x')`, [B]),
    );
    check('真实 PG：agent_platform 在 A 的事务里发布 B 的隐私说明被 RLS 拒', crossNotice === 'rls', crossNotice);
    const platformNotices = await asRole<{ tenant_id: string }>('agent_platform', A, 'select tenant_id from privacy_notices');
    check(
      '真实 PG：agent_platform 读隐私说明同样只看得到本租户的',
      platformNotices.length === 1 && platformNotices[0]?.tenant_id === A,
      JSON.stringify(platformNotices),
    );
    // 消息只追加（验收 5、不变量 5）：设了租户也一样，报的是 permission denied 而不是 0 行
    for (const [what, text] of [
      ['UPDATE', `update messages set content = '改过'`],
      ['DELETE', 'delete from messages'],
      ['TRUNCATE', 'truncate messages'],
    ]) {
      const viaApp = await denial(asRole('agent_app', A, text));
      check(`真实 PG：agent_app 在本租户的事务里对 messages ${what} 报 permission denied`, viaApp === 'denied', viaApp);
      const viaPlatform = await denial(asRole('agent_platform', A, text));
      check(`真实 PG：agent_platform 对 messages ${what} 同样报 permission denied`, viaPlatform === 'denied', viaPlatform);
    }
    const viaDrizzle = await denial(
      withTenant(appDb.db, ctx(A), (tx) => tx.execute(sql`delete from messages where conversation_id = 'c-iso'`)),
    );
    check('真实 PG：经 withTenant（node-postgres）删消息同样报 permission denied', viaDrizzle === 'denied', viaDrizzle);
    const [msgLeft] = await sq<{ n: number; c: string }>(
      `select count(*)::int as n, min(content) as c from messages where conversation_id = 'c-iso'`,
    );
    check('真实 PG：上面这些之后两个租户的消息原样在', msgLeft?.n === 2 && msgLeft.c === '在吗', JSON.stringify(msgLeft));
    // 保留期列：平台能改、改别的列被拒；应用改不了
    check(
      '真实 PG：agent_platform 能改租户的保留期',
      (await denial(platform.query('update tenants set retention_lead_days = 30 where id = $1', [C]))) === 'ok',
    );
    check(
      '真实 PG：agent_platform 改 tenants 的别的列报 permission denied',
      (await denial(platform.query(`update tenants set name = '改名' where id = $1`, [C]))) === 'denied',
    );
    check(
      '真实 PG：agent_app 改保留期报 permission denied',
      (await denial(app.query('update tenants set retention_lead_days = 30 where id = $1', [C]))) === 'denied',
    );
    // ---- 03：渠道两张表的租户隔离、没有 DELETE / TRUNCATE、身份列改不了（03 验收 19，不变量 21） ----
    const chanAcct: Record<string, string> = {};
    for (const tenant of [A, B]) {
      const [{ id }] = await sq<{ id: string }>(
        `insert into channel_accounts (tenant_id, key, kind, name, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
         values ($1, 'kf-iso', 'wecom_kf', '客服', 'wecom:', 'corp-iso', 'kf-iso', decode(repeat('07', 44), 'hex'), 'k1') returning id`,
        [tenant],
      );
      chanAcct[tenant] = id;
      await sq(
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, payload)
         values ($1, $2, 'm-iso', 'message', 'wecom:wmIso', 'received', '{"text":"原文"}')`,
        [tenant, id],
      );
    }
    const seenChan = await asRole<{ t: string; tenant_id: string }>(
      'agent_app',
      A,
      CHANNEL_TABLES.map((tb) => `select '${tb}' as t, tenant_id from ${tb}`).join(' union all '),
    );
    check(
      '真实 PG：租户 A 的事务里，03 的两张新表都只看得到 A 的行',
      new Set(seenChan.map((r) => r.t)).size === CHANNEL_TABLES.length && seenChan.every((r) => r.tenant_id === A),
      JSON.stringify(seenChan.filter((r) => r.tenant_id !== A)),
    );
    for (const [tb, set] of [
      ['channel_accounts', `name = name`],
      ['channel_inbox', `attempts = attempts`],
    ] as const) {
      const [u] = await asRole<{ n: number }>(
        'agent_app',
        A,
        `with u as (update ${tb} set ${set} where tenant_id = $1 returning 1) select count(*)::int as n from u`,
        [B],
      );
      check(`真实 PG：租户 A 的事务里 UPDATE B 的 ${tb} 影响 0 行`, u?.n === 0, JSON.stringify(u));
    }
    const crossInbox = await denial(
      asRole(
        'agent_app',
        A,
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state) values ($1, $2, 'm-cross', 'message', 'wecom:wmIso', 'received')`,
        [B, chanAcct[B]],
      ),
    );
    check('真实 PG：租户 A 的事务里写 B 的入站行被 RLS 拒', crossInbox === 'rls', crossInbox);
    for (const tb of CHANNEL_TABLES) {
      for (const [what, text] of [
        ['DELETE', `delete from ${tb}`],
        ['TRUNCATE', `truncate ${tb}`],
      ]) {
        const viaApp = await denial(asRole('agent_app', A, text));
        check(`真实 PG：agent_app 在本租户的事务里对 ${tb} ${what} 报 permission denied（03 验收 19）`, viaApp === 'denied', viaApp);
        const viaPlatform = await denial(asRole('agent_platform', A, text));
        check(`真实 PG：agent_platform 对 ${tb} ${what} 同样报 permission denied`, viaPlatform === 'denied', viaPlatform);
      }
    }
    for (const col of ['key', 'kind', 'id_prefix', 'corp_id', 'open_kfid', 'tenant_id', 'id', 'created_at']) {
      const r = await denial(asRole('agent_app', A, `update channel_accounts set ${col} = ${col} where id = $1`, [chanAcct[A]]));
      check(`真实 PG：agent_app 改 channel_accounts.${col}（哪怕写回原值）报 permission denied`, r === 'denied', r);
    }
    const allowedCols = await denial(
      asRole(
        'agent_app',
        A,
        `update channel_accounts set name = '改名', status = 'disabled', cursor = 'c-9', cursor_at = now(), record_only_until = now(),
           settings = '{"pollIntervalMs":60000}', secrets_ct = secrets_ct, secrets_key_id = 'k2', updated_at = now() where id = $1`,
        [chanAcct[A]],
      ),
    );
    check('真实 PG：agent_app 改列级授权里的九列照常', allowedCols === 'ok', allowedCols);
    const [chanLeft] = await sq<{ a: number; i: number }>(
      `select (select count(*)::int from channel_accounts where key = 'kf-iso') as a, (select count(*)::int from channel_inbox where msgid = 'm-iso') as i`,
    );
    check('真实 PG：上面这些之后两个租户的账号与入站行原样在', chanLeft?.a === 2 && chanLeft.i === 2, JSON.stringify(chanLeft));
    // longRunning：只放宽那一个事务，连接归还池子之后回到 agent_app 的 5 秒与 10 秒
    {
      const pool1 = await openDb(APP, { max: 1 });
      cleanup.push(() => pool1.close());
      const timeouts = async (tx: Tx): Promise<{ st: string; it: string; pid: number }> =>
        rowsOf<{ st: string; it: string; pid: number }>(
          await tx.execute(
            sql`select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as it,
                       pg_backend_pid() as pid`,
          ),
        )[0]!;
      const long = await withTenant(pool1.db, ctx(A), timeouts, { longRunning: true, isolation: 'repeatable read', readOnly: true });
      const after = await withTenant(pool1.db, ctx(A), timeouts);
      check(
        '真实 PG：longRunning 的事务里是 60 秒与 120 秒，同一条连接的下一个事务回到 5 秒与 10 秒',
        long.st === '1min' && long.it === '2min' && after.st === '5s' && after.it === '10s' && after.pid === long.pid,
        JSON.stringify({ long, after }),
      );
    }
    await purgeChecks({ su: sq, as: asRole }, '真实 PG ');
    await channelChecks({ su: sq, as: asRole }, '真实 PG ');

    // ---- 两条连接并发：清除与落库抢同一个会话行；两个认领抢同一批任务 ----
    {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const [{ id: K }] = await sq<{ id: string }>(
        `insert into tenants (slug, name, pack_id, retention_lead_days) values ('tenant-race', 'K', 'travel', 10) returning id`,
      );
      // (a) 线索、11 天前：到期。连接 1 像落库那样锁住会话行；连接 2 拿旧的预期值清除，要等这把锁
      const old = new Date(Date.now() - 11 * 86_400_000).toISOString();
      await sq(
        `insert into conversations (tenant_id, id, channel, stage, handed_over, state, last_seq, window_start_seq, created_at, updated_at)
         values ($1, 'race', 'wecom', 'discovery', false, '{"id":"race"}', 1, 1, $2::timestamptz, $2::timestamptz)`,
        [K, old],
      );
      await sq(
        `insert into messages (tenant_id, conversation_id, seq, role, content, at) values ($1, 'race', 1, 'customer', '第1句', $2::timestamptz)`,
        [K, old],
      );
      const writer = await login(APP);
      const purger = await login(APP);
      for (const c of [writer, purger]) {
        await c.query('begin');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [K]);
      }
      await writer.query(`select 1 from conversations where id = 'race' for update`);
      const [{ pid }] = (await purger.query<{ pid: number }>('select pg_backend_pid() as pid')).rows;
      const purged = purger.query<{ ok: boolean }>(`select purge_conversation($1, 'race', now(), 1, $2::timestamptz) as ok`, [K, old]).then(
        (r) => r.rows[0]?.ok,
        (e: unknown) => pgErr(e)?.code ?? notDb(e),
      );
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await sq(`select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid])).length === 1;
        if (!waiting) await sleep(20);
      }
      await writer.query(
        `insert into messages (tenant_id, conversation_id, seq, role, content, at) values ($1, 'race', 2, 'customer', '第2句', now())`,
        [K],
      );
      await writer.query(`update conversations set last_seq = 2, updated_at = now() where id = 'race'`);
      await writer.query('commit');
      const got = await purged;
      await purger.query('commit').catch(() => {});
      const [left] = await sq<{ c: number; m: number }>(
        `select (select count(*)::int from conversations where tenant_id = $1 and id = 'race') as c,
                (select count(*)::int from messages where tenant_id = $1 and conversation_id = 'race') as m`,
        [K],
      );
      check('真实 PG 并发：清除等在落库锁住的会话行上', waiting);
      check('真实 PG 并发：落库推进 last_seq 与 updated_at 提交之后，拿旧预期值的清除返回 false', got === false, String(got));
      check('真实 PG 并发：会话与刚落库的消息都在', left?.c === 1 && left.m === 2, JSON.stringify(left));

      // (b) 十二个到期任务；第一个认领拿到 5 个、不提交，第二个认领不等它，拿另外 5 个
      const { claimDueJobs } = await import('./repo/jobs.js');
      for (let i = 0; i < 12; i++) {
        await sq(
          `insert into jobs (tenant_id, kind, dedupe_key, run_at, max_attempts, payload) values ($1, 'followup', $2, now() - make_interval(secs => $3), 1, '{}')`,
          [K, `race:${i}`, 100 - i],
        );
      }
      const at = new Date();
      let release = (): void => {};
      const gate = new Promise<void>((r) => (release = r));
      let firstReady = (_ids: string[]): void => {};
      const ready = new Promise<string[]>((r) => (firstReady = r));
      const first = withTenant(appDb.db, ctx(K), async (tx) => {
        const ids = (await claimDueJobs(tx, at, 5)).map((j) => j.id);
        firstReady(ids);
        await gate;
        return ids;
      }).catch((e: unknown) => {
        firstReady([]);
        return `error ${pgErr(e)?.code ?? notDb(e)}`;
      });
      const ids1 = await ready;
      const second = withTenant(appDb.db, ctx(K), async (tx) => (await claimDueJobs(tx, at, 5)).map((j) => j.id)).catch(
        (e: unknown) => `error ${pgErr(e)?.code ?? notDb(e)}`,
      );
      let timer: NodeJS.Timeout | undefined;
      const early = await Promise.race([second, new Promise<'blocked'>((r) => (timer = setTimeout(() => r('blocked'), 3000)))]);
      clearTimeout(timer);
      release();
      const firstIds = await first;
      const ids2 = await second;
      check('真实 PG 并发：第一个认领还没提交时，第二个认领不等它的行锁', Array.isArray(early), String(early));
      check(
        '真实 PG 并发：两个认领各拿 5 个，id 不相交',
        Array.isArray(firstIds) && Array.isArray(ids2) && ids1.length === 5 && ids2.length === 5 && ids2.every((id) => !ids1.includes(id)),
        JSON.stringify({ ids1, ids2 }),
      );
    }

    // ---- 认证函数 ----
    const lookup = async (c: InstanceType<typeof pg.Client>, tenant: string): Promise<{ o_user_id: string; o_password_hash: string }[]> =>
      (await c.query('select * from auth_login_lookup($1, $2)', [tenant, 'ops@example.com'])).rows;
    const found = await lookup(app, A);
    check('真实 PG：经认证函数能登录', found.length === 1 && found[0]?.o_user_id === U && found[0].o_password_hash === 'scrypt$real');
    await app.query('begin');
    await app.query(`select set_config('app.tenant_id', $1, true)`, [B]);
    const cross = await denial(lookup(app, A));
    await app.query('rollback');
    check('真实 PG：事务已设为 B 时用 A 调认证函数报错', cross.startsWith('auth: '), cross);
    await app.query('begin');
    await app.query(`select set_config('app.tenant_id', $1, true)`, [A]);
    await lookup(app, A);
    const [kept] = (await app.query<{ v: string }>(`select current_setting('app.tenant_id', true) as v`)).rows;
    await app.query('commit');
    await app.query('begin');
    await lookup(app, A);
    const [unset] = (await app.query<{ v: string | null }>(`select current_setting('app.tenant_id', true) as v`)).rows;
    await app.query('commit');
    check('真实 PG：调用认证函数之后租户设置恢复为调用前的值', kept?.v === A && !unset?.v, JSON.stringify({ kept, unset }));

    // 同名临时表遮蔽：agent_app 本来就建不了临时表；临时放开 TEMP 权限，建出同名的 users 等表，认证函数照样读 public 的
    const noTemp = await denial(app.query('create temp table users (id uuid)'));
    check('真实 PG：agent_app 没有 TEMP 权限，建不了临时表', noTemp === 'denied', noTemp);
    await sq(`grant temporary on database ${ident(dbName)} to agent_app`);
    try {
      const app2 = await login(APP);
      const [fake] = (await app2.query<{ id: string }>('select gen_random_uuid() as id')).rows;
      await app2.query(`create temp table users (id uuid, email text, display_name text, password_hash text, disabled_at timestamptz)`);
      await app2.query(`create temp table memberships (tenant_id uuid, user_id uuid, role text)`);
      await app2.query(`create temp table tenants (id uuid, status text)`);
      await app2.query(`insert into users values ($1, 'ops@example.com', '冒名', 'scrypt$fake', null)`, [fake!.id]);
      await app2.query(`insert into memberships values ($1, $2, 'owner')`, [A, fake!.id]);
      await app2.query(`insert into tenants values ($1, 'active')`, [A]);
      const shadowed = (await app2.query<{ n: number }>(`select count(*)::int as n from users where password_hash = 'scrypt$fake'`)).rows[0]
        ?.n;
      const viaFn = await lookup(app2, A);
      check(
        '真实 PG：同名临时表遮蔽不了认证函数',
        shadowed === 1 && viaFn.length === 1 && viaFn[0]?.o_user_id === U && viaFn[0].o_password_hash === 'scrypt$real',
        JSON.stringify({ shadowed, viaFn }),
      );
    } finally {
      await sq(`revoke temporary on database ${ident(dbName)} from agent_app`);
    }

    // ---- 租户锁 ----
    const lockBackend = async (): Promise<void> => {
      await su.query(
        `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = $1)`,
        [dbName],
      );
    };
    const waitFor = async (cond: () => boolean): Promise<boolean> => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30));
      return cond();
    };
    const L1 = await holdTenantLock(APP, A, { keepAliveMs: 1000 });
    check('真实 PG：拿到租户锁', L1 !== null);
    if (L1) {
      cleanup.push(() => L1.release());
      check('真实 PG：第二个进程拿不到同一租户的锁（lock_held）', (await holdTenantLock(APP, A)) === null);
      const other = await holdTenantLock(APP, B);
      check('真实 PG：别的租户的锁互不影响', other !== null);
      await other?.release();
      check('真实 PG：锁连接健康时 reacquire 直接是 ok', (await L1.reacquire()) === 'ok');
      let lost = 0;
      L1.onLost(() => lost++);
      await lockBackend();
      check('真实 PG：锁连接被 pg_terminate_backend 后回调 onLost 一次', (await waitFor(() => lost === 1)) && lost === 1, String(lost));
      // 断开之后才订阅的（initConfig 在装载途中）：订阅时当场补一次，不会一直以为持着锁
      let late = 0;
      L1.onLost(() => late++);
      check('真实 PG：锁已断开之后才订阅 onLost，订阅时立即回调一次', late === 1, String(late));
      const [r1, r2] = await Promise.all([L1.reacquire(), L1.reacquire()]);
      check('真实 PG：断连后重取成功，并发的两次拿到同一个结果', r1 === 'ok' && r2 === 'ok', `${r1} ${r2}`);
      check('真实 PG：重取之后别人仍拿不到', (await holdTenantLock(APP, A)) === null);
      await lockBackend();
      await waitFor(() => lost === 2);
      const thief = await holdTenantLock(APP, A);
      check('真实 PG：断连期间别的进程拿走了锁', thief !== null);
      check('真实 PG：此时重取得到 held_by_other', (await L1.reacquire()) === 'held_by_other');
      await thief?.release();
      check('真实 PG：那个进程放锁之后可以重取回来', (await L1.reacquire()) === 'ok');
      await L1.release();
      const after = await holdTenantLock(APP, A);
      check('真实 PG：release 之后别人能拿到', after !== null);
      await after?.release();
    }

    // ---- 命令行子进程（验收 3）与 node-postgres 下的逐字节等价（验收 2 的前两项） ----
    const repo = path.join(import.meta.dirname, '..', '..');
    const cli = (script: string, argv: string[], env: Record<string, string>, input?: string): { code: number | null; out: string } => {
      // 只给这个命令行该拿的那一个连接串，别的 app / owner / platform 串都不带过去
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DATABASE_|^PG_TEST_URL$/.test(k)));
      const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli', script), ...argv], {
        cwd: repo,
        env: { ...base, ...env },
        encoding: 'utf8',
        timeout: 60_000,
        input,
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const create = cli('tenant-create.ts', ['--slug', 'demo', '--name', 'Demo', '--pack', 'travel'], {
      DATABASE_PLATFORM_URL: PLATFORM,
      DEPLOY_PROFILE: 'demo',
    });
    check('真实 PG：tenant-create 以 platform 身份建租户，退出码 0', create.code === 0, create.out.slice(0, 200));
    check(
      '真实 PG：同样的参数再跑一次仍是 0',
      cli('tenant-create.ts', ['--slug', 'demo', '--name', 'Demo', '--pack', 'travel'], {
        DATABASE_PLATFORM_URL: PLATFORM,
        DEPLOY_PROFILE: 'demo',
      }).code === 0,
    );
    check(
      '真实 PG：同名租户字段不同 → 退出码 2',
      cli('tenant-create.ts', ['--slug', 'demo', '--name', '别的名字', '--pack', 'travel'], {
        DATABASE_PLATFORM_URL: PLATFORM,
        DEPLOY_PROFILE: 'demo',
      }).code === 2,
    );
    const secret = 'cli-password-from-stdin';
    const made = cli(
      'user-create.ts',
      ['--tenant', 'demo', '--email', 'ops@demo.test', '--name', '运营', '--role', 'admin', '--password-stdin'],
      { DATABASE_PLATFORM_URL: PLATFORM },
      `${secret}\n`,
    );
    check(
      '真实 PG：user-create 从 stdin 读口令建账号，退出码 0，输出里没有口令',
      made.code === 0 && !made.out.includes(secret),
      made.out.slice(0, 200),
    );
    // 子进程会继承控制终端：在终端里跑测试时 /dev/tty 打得开，口令会写到终端上。只在没有终端时（CI）验「拒绝执行」
    let hasTty = true;
    try {
      fs.closeSync(fs.openSync('/dev/tty', 'w'));
    } catch {
      hasTty = false;
    }
    if (!hasTty) {
      const noTty = cli('user-password.ts', ['--tenant', 'demo', '--email', 'ops@demo.test'], { DATABASE_PLATFORM_URL: PLATFORM });
      check(
        '真实 PG：既没有 --password-stdin 也没有终端时拒绝执行',
        noTty.code === 1 && noTty.out.includes('--password-stdin'),
        noTty.out.slice(0, 200),
      );
    }
    check(
      '真实 PG：user-disable 以 platform 身份执行，退出码 0',
      cli('user-disable.ts', ['--tenant', 'demo', '--email', 'ops@demo.test'], { DATABASE_PLATFORM_URL: PLATFORM }).code === 0,
    );
    const dry = cli('import-config.ts', ['--tenant', 'demo', '--dry-run'], { DATABASE_URL: APP });
    check(
      '真实 PG：import-config --dry-run 跑通、打印哈希、不写库',
      dry.code === 0 && /promptHash=[0-9a-f]{64}/.test(dry.out),
      dry.out.slice(0, 200),
    );
    const [demoRows] = await sq<{ n: number }>(
      `select count(*)::int as n from sop_versions s join tenants t on t.id = s.tenant_id where t.slug = 'demo'`,
    );
    check('真实 PG：dry-run 之后库里没有版本行', demoRows?.n === 0);
    const imported = cli('import-config.ts', ['--tenant', 'demo'], { DATABASE_URL: APP });
    check('真实 PG：import-config 以 app 身份导入，退出码 0', imported.code === 0, imported.out.slice(0, 200));
    check('真实 PG：同一份 data/ 再导入一次，退出码 0', cli('import-config.ts', ['--tenant', 'demo'], { DATABASE_URL: APP }).code === 0);
    const out = fs.mkdtempSync(path.join(process.env.VAR_DIR!, 'export-'));
    const exported = cli('export-config.ts', ['--tenant', 'demo', '--out', out], { DATABASE_URL: APP });
    check('真实 PG：export-config 退出码 0', exported.code === 0, exported.out.slice(0, 200));
    const data = path.join(repo, 'data');
    check(
      '真实 PG：导出的 sop.md 与 data/sop.md 逐字节相同',
      fs.readFileSync(path.join(out, 'sop.md'), 'utf8') === fs.readFileSync(path.join(data, 'sop.md'), 'utf8'),
    );
    for (const f of ['routes.json', 'hotels.json']) {
      const a = (JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) as unknown[]).map((x) => JSON.stringify(x));
      const b = (JSON.parse(fs.readFileSync(path.join(data, f), 'utf8')) as unknown[]).map((x) => JSON.stringify(x));
      check(
        `真实 PG：导出的 ${f} 顺序相同、每条字节相同（经 node-postgres 的 json 列）`,
        a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]),
      );
    }

    // 文件模式取一遍，再以 node-postgres 装成配置源取一遍：前缀与产品库逐字节相同
    const { promptPrefix } = await import('../engine.js');
    const { loadRoutes, loadHotels } = await import('../tools.js');
    const cfg = await import('../config/source.js');
    const { testConfigDeps } = await import('./testing.js');
    const fileView = JSON.stringify([promptPrefix(), loadRoutes(), loadHotels()]);
    const pgDb = await openDb(APP);
    cleanup.push(() => pgDb.close());
    await cfg.initConfig({
      ...testConfigDeps({ db: pgDb.db }),
      tenantSlug: 'demo',
      lock: (tenantId) => holdTenantLock(APP, tenantId),
    });
    cleanup.push(async () => {
      await cfg.closeConfig();
      cfg.__configTest.reset();
    });
    check('真实 PG：经 node-postgres 装成配置源', cfg.configMode() === 'db' && cfg.currentSop().versionNo === 1);
    check('真实 PG：两种模式的前缀、线路、酒店逐字节相同', JSON.stringify([promptPrefix(), loadRoutes(), loadHotels()]) === fileView);
    const held = cli('import-config.ts', ['--tenant', 'demo'], { DATABASE_URL: APP });
    check('真实 PG：应用持着租户锁时 import-config 退出码 3', held.code === 3, held.out.slice(0, 200));
    const fixArgs = [
      '--tenant',
      'demo',
      '--kind',
      'route',
      '--code',
      'r-tibet-lux',
      '--set',
      '{"priceFrom": 99999}',
      '--reason',
      '测试调价',
    ];
    const fixHeld = cli('catalog-fix.ts', fixArgs, { DATABASE_URL: APP });
    check('真实 PG：应用运行时 catalog-fix 拿不到锁，退出码 3', fixHeld.code === 3, fixHeld.out.slice(0, 200));
    await cfg.closeConfig();
    cfg.__configTest.reset();
    const fixOk = cli('catalog-fix.ts', fixArgs, { DATABASE_URL: APP });
    check('真实 PG：停应用之后 catalog-fix 改 priceFrom，退出码 0', fixOk.code === 0, fixOk.out.slice(0, 200));
    await cfg.initConfig({ ...testConfigDeps({ db: pgDb.db }), tenantSlug: 'demo', lock: (tenantId) => holdTenantLock(APP, tenantId) });
    check('真实 PG：重启后快照是修正后的值', cfg.currentCatalog().routes.find((r) => r.id === 'r-tibet-lux')?.priceFrom === 99999);
    const [fixAudit] = await sq<{ reason: string }>(`select diff->>'reason' as reason from audit_log where action = 'catalog.locked_fix'`);
    check('真实 PG：写了一行带 reason 的 catalog.locked_fix 审计', fixAudit?.reason === '测试调价');
    // 02 第 8 步：import-config（agent_app）给每条写了版本 1，catalog-fix 写了版本 2；版本行与条目的 json 文本逐字节相同
    const tibet = await sq<{ version: number; source: string; same: boolean }>(
      `select v.version, v.source, v.payload::text = i.payload::text as same from catalog_item_versions v
         join catalog_items i using (tenant_id, kind, code) where v.code = 'r-tibet-lux' order by v.version`,
    );
    check(
      '真实 PG：import-config 写版本 1、catalog-fix 写版本 2（agent_app 有 INSERT），最新一版与条目逐字节相同',
      tibet.map((r) => `${r.version}:${r.source}`).join() === '1:activate,2:fix' &&
        tibet[1]!.same &&
        cfg.currentCatalog().versions['route:r-tibet-lux'] === 2 &&
        cfg.catalogVersioned(),
      JSON.stringify(tibet),
    );
  } finally {
    for (const f of cleanup.reverse()) await f().catch(() => {});
    await su
      .query(`drop database if exists ${ident(dbName)} with (force)`)
      .catch((e: Error) => fails.push(`真实 PG：删不掉临时库 ${dbName}：${e.message}`));
    await su.end();
  }
}

if (fails.length) {
  console.error(`DB SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `DB SELFTEST PASS: ${pass} 项断言全通（PGlite：迁移两遍 / 表属主与 RLS 开关 / 认证函数授权 / 约束与哈希 CHECK / json 键序 / 版本与条目触发器 / 部分唯一索引 / 复合外键 / withTenant / 认证函数冒烟 / 02 条目版本回填、新表约束与触发器、仓储冒烟、清除与删除函数 / 03 从 02 升级、渠道表约束、ord、出站与入站迁移表每一格、仓储冒烟、两个触发器、purge_channel_inbox、清除与删除连带入站行${realPgRan ? '；真实 PG：roles.sql / 迁移身份 / 权限逐格 / RLS 行为 / 租户隔离 / 会话级泄漏 / 临时表遮蔽 / 租户锁 / 命令行子进程 / node-postgres 下两种模式逐字节等价 / 02 新表权限与隔离、消息只追加、清除与删除函数 / 03 新表权限逐格与列级授权、隔离、没有 DELETE、两个触发器、purge_channel_inbox' : '；真实 PG 部分未跑'}）`,
);
