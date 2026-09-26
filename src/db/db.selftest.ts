// 数据库自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」）。
// 两部分：
// - PGlite：迁移连跑两遍、约束（含哈希 CHECK）、三个触发器、两个部分唯一索引、复合外键（验收 7 的约束与触发器部分），
//   外加 withTenant 与五个认证函数的冒烟——plpgsql 的运行期错误只有真跑一次才暴露。
// - 真实 Postgres，有 PG_TEST_URL 才跑（CI=true 而没有它时失败）：roles.sql、各角色对各表的权限逐格、RLS 行为、会话级泄漏、
//   临时表遮蔽、租户锁（验收 12 与验收 7 的权限部分）。PGlite 以超级用户连接，RLS 与授权的结论只从这部分得出（spec R13）。
// 用法：npx tsx src/db/db.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
    if (err.code === '23514' && /^(sop_versions|catalog_items): /.test(err.message)) return 'trigger';
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

type Query = <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
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
  check(`${label}迁移：七张表`, names === 'audit_log,auth_sessions,catalog_items,memberships,sop_versions,tenants,users', names);
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
  const fns = await run<{ proname: string; secdef: boolean; acl: string; config: string }>(
    `select proname, prosecdef as secdef, coalesce(proacl::text, '') as acl, coalesce(proconfig::text, '') as config from pg_proc
      where pronamespace = 'public'::regnamespace order by 1`,
  );
  const auth = fns.filter((f) => f.proname.startsWith('auth_'));
  check(`${label}认证函数：五个`, auth.length === 5, auth.map((f) => f.proname).join(','));
  for (const f of fns) {
    // aclitem 里「=X/」开头（被授权者为空）就是 PUBLIC
    const publicExec = /[{,]=X\//.test(f.acl);
    if (f.proname.startsWith('auth_')) {
      check(`${label}认证函数：${f.proname} 是 SECURITY DEFINER`, f.secdef);
      check(`${label}认证函数：${f.proname} 只授权给 agent_app，PUBLIC 不能执行`, f.acl.includes('agent_app=X/') && !publicExec, f.acl);
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

await t.close();

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
    const fnPriv = await sq<{ fn: string; app: boolean; platform: boolean }>(
      `select p.oid::regprocedure::text as fn, has_function_privilege('agent_app', p.oid, 'EXECUTE') as app,
              has_function_privilege('agent_platform', p.oid, 'EXECUTE') as platform
         from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
    );
    for (const f of fnPriv) {
      const isAuth = f.fn.startsWith('auth_');
      check(
        `真实 PG：${f.fn} 的 EXECUTE：agent_app ${isAuth ? '有' : '没有'}，agent_platform 没有`,
        f.app === isAuth && f.platform === false,
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
    const cli = (script: string, argv: string[], env: Record<string, string>): { code: number | null; out: string } => {
      // 只给这个命令行该拿的那一个连接串，别的 app / owner / platform 串都不带过去
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DATABASE_|^PG_TEST_URL$/.test(k)));
      const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli', script), ...argv], {
        cwd: repo,
        env: { ...base, ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const create = cli('tenant-create.ts', ['--slug', 'demo', '--name', 'Demo', '--pack', 'travel'], { DATABASE_PLATFORM_URL: PLATFORM });
    check('真实 PG：tenant-create 以 platform 身份建租户，退出码 0', create.code === 0, create.out.slice(0, 200));
    check(
      '真实 PG：同样的参数再跑一次仍是 0',
      cli('tenant-create.ts', ['--slug', 'demo', '--name', 'Demo', '--pack', 'travel'], { DATABASE_PLATFORM_URL: PLATFORM }).code === 0,
    );
    check(
      '真实 PG：同名租户字段不同 → 退出码 2',
      cli('tenant-create.ts', ['--slug', 'demo', '--name', '别的名字', '--pack', 'travel'], { DATABASE_PLATFORM_URL: PLATFORM }).code === 2,
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
  `DB SELFTEST PASS: ${pass} 项断言全通（PGlite：迁移两遍 / 表属主与 RLS 开关 / 认证函数授权 / 约束与哈希 CHECK / json 键序 / 版本与条目触发器 / 部分唯一索引 / 复合外键 / withTenant / 认证函数冒烟${realPgRan ? '；真实 PG：roles.sql / 迁移身份 / 权限逐格 / RLS 行为 / 租户隔离 / 会话级泄漏 / 临时表遮蔽 / 租户锁 / 命令行子进程 / node-postgres 下两种模式逐字节等价' : '；真实 PG 部分未跑'}）`,
);
