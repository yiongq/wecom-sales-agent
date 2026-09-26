// 数据库自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」）。
// 现在只有 PGlite 部分：迁移连跑两遍、约束（含哈希 CHECK）、三个触发器、两个部分唯一索引、复合外键（验收 7 的约束与触发器部分），
// 外加 withTenant 与五个认证函数的冒烟——plpgsql 的运行期错误只有真跑一次才暴露。
// RLS 与授权的逐格断言、租户锁、node-postgres 下的字节等价在真实 Postgres 部分（01 第 3 步），PGlite 上的结论不作数（spec R13）。
// 用法：npx tsx src/db/db.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-db-selftest-'));

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

  const tables = await q<{ relname: string; owner: string; rls: boolean; force: boolean }>(
    `select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`,
  );
  const names = tables.map((r) => r.relname).join(',');
  check('迁移：七张表', names === 'audit_log,auth_sessions,catalog_items,memberships,sop_versions,tenants,users', names);
  check(
    '迁移：表的属主都是 agent_owner',
    tables.every((r) => r.owner === 'agent_owner'),
    tables.map((r) => `${r.relname}=${r.owner}`).join(' '),
  );
  // 带 tenant_id 的表除豁免清单外都开 ENABLE 与 FORCE 并有 tenant_isolation 策略（真实 PG 上第 3 步再逐格断言）
  const withTenantCol = await q<{ relname: string; policies: string }>(
    `select c.relname, coalesce(string_agg(p.polname, ',' order by p.polname), '') as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
       left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r' group by c.relname order by 1`,
  );
  for (const r of withTenantCol) {
    const flags = tables.find((x) => x.relname === r.relname);
    if (r.relname === 'auth_sessions') {
      check('RLS：auth_sessions 在豁免清单里，不开 RLS', flags?.rls === false && r.policies === '');
      continue;
    }
    check(`RLS：${r.relname} 开了 ENABLE 与 FORCE`, flags?.rls === true && flags.force === true);
    check(`RLS：${r.relname} 有 tenant_isolation 策略`, r.policies === 'tenant_isolation', r.policies);
  }
  check(
    'RLS：带 tenant_id 的表正好是 4 + auth_sessions',
    withTenantCol.map((r) => r.relname).join(',') === 'audit_log,auth_sessions,catalog_items,memberships,sop_versions',
  );
  const fns = await q<{ proname: string; secdef: boolean; acl: string }>(
    `select proname, prosecdef as secdef, coalesce(proacl::text, '') as acl from pg_proc
      where pronamespace = 'public'::regnamespace and proname like 'auth\\_%' order by 1`,
  );
  check('认证函数：五个', fns.length === 5, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    check(`认证函数：${f.proname} 是 SECURITY DEFINER`, f.secdef);
    // aclitem 里「=X/」开头（被授权者为空）就是 PUBLIC
    check(`认证函数：${f.proname} 只授权给 agent_app，PUBLIC 不能执行`, f.acl.includes('agent_app=X/') && !/[{,]=X\//.test(f.acl), f.acl);
  }
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
if (fails.length) {
  console.error(`DB SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `DB SELFTEST PASS: ${pass} 项断言全通（PGlite：迁移两遍 / 表属主与 RLS 开关 / 认证函数授权 / 约束与哈希 CHECK / json 键序 / 版本与条目触发器 / 部分唯一索引 / 复合外键 / withTenant / 认证函数冒烟）`,
);
