// 04 第 19 步：平台命令、字段名审计、事务回滚；真实 PG 另验证权限与并发。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { runTenantBrand } from '../cli/tenant-brand.js';
import { runTenantCreate } from '../cli/tenant-create.js';
import { BRAND_FIELDS, BrandProfileSchema, type BrandProfile } from '../core/pack-api.js';
import { auditAction } from '../shared/ui-labels.js';
import { openDb, type Db } from './client.js';
import { readBrand } from './repo/tenants.js';
import { createRealPgFixture, installSeededConfig, openTestDb } from './testing.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-brand-selftest-'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const brand: BrandProfile = {
  brandName: '山海旅行',
  advisorTitle: '旅行顾问',
  aiTitle: 'AI 旅行顾问',
  scopeNoun: '旅行',
  identityLine: '我是山海旅行的 AI 旅行顾问',
};
const file = path.join(root, 'brand.json');
fs.writeFileSync(file, JSON.stringify(brand));
const changed = { ...brand, brandName: '远山旅行' };
const changedFile = path.join(root, 'changed.json');
fs.writeFileSync(changedFile, JSON.stringify(changed));
let pass = 0;
function equal(actual: unknown, expected: unknown, message: string): void {
  assert.deepEqual(actual, expected, message);
  pass++;
}

interface Suite {
  db: Db;
  query<R>(text: string, params?: unknown[]): Promise<R[]>;
}

async function suite(s: Suite): Promise<void> {
  const deps = { connect: async () => ({ db: s.db, close: async () => {} }) };
  const oldLog = console.log;
  const oldError = console.error;
  const output: string[] = [];
  console.log = console.error = (...values: unknown[]) => {
    output.push(values.join(' '));
  };
  try {
    // 对已发布配置作整体比较，保证平台命令不写 SOP 版本、render_inputs 或 promptHash。
    const published = await s.query('select * from sop_versions order by id');
    const [tenant] = await s.query<{ id: string }>("select id from tenants where slug = 'demo'");
    equal(await readBrand(s.db, tenant!.id), null, '旧租户保持旧版模式');
    const audits = () =>
      s.query<{ action: string; diff: unknown; actor_kind: string; actor_name: string; target_id: string }>(
        "select action, diff, actor_kind, actor_name, target_id from audit_log where action like 'tenant.brand_%' order by id",
      );
    const set = (brandFile = file) => runTenantBrand(['set', '--tenant', 'demo', '--brand-file', brandFile], deps);
    const clear = () => runTenantBrand(['clear', '--tenant', 'demo'], deps);
    equal(await set(), 0, 'set 成功');
    equal(await readBrand(s.db, tenant!.id), brand, 'set 保存完整档案');
    equal(
      await audits(),
      [
        {
          action: 'tenant.brand_set',
          diff: { fields: [...BRAND_FIELDS] },
          actor_kind: 'platform',
          actor_name: 'tenant-brand',
          target_id: tenant!.id,
        },
      ],
      'set 恰好一条字段名审计',
    );
    equal(await set(changedFile), 0, '修改品牌成功');
    equal((await audits()).at(-1)?.diff, { fields: ['brandName'] }, '只记真正改变的字段');
    equal(await set(changedFile), 0, '相同品牌重复 set 成功');
    equal((await audits()).at(-1)?.diff, { fields: [] }, '相同品牌不伪造字段变更');
    equal(await clear(), 0, 'clear 成功');
    equal(await readBrand(s.db, tenant!.id), null, 'clear 回到旧版模式');
    equal((await audits()).at(-1)?.action, 'tenant.brand_clear', 'clear 审计动作');
    equal((await audits()).at(-1)?.diff, { fields: [...BRAND_FIELDS] }, 'clear 只记被清除的字段名');
    equal(await clear(), 0, '重复 clear 成功');
    equal((await audits()).at(-1)?.diff, { fields: [] }, '重复 clear 无字段变化');
    const beforeRefusals = await audits();
    for (const argv of [
      [],
      ['unknown'],
      ['set', '--tenant', 'demo'],
      ['set', '--brand-file', file],
      ['clear', '--tenant', 'demo', '--brand-file', file],
      ['set', '--tenant', 'missing', '--brand-file', file],
      ['set', '--tenant', 'demo', '--brand-file', path.join(root, 'absent')],
    ]) {
      equal(await runTenantBrand(argv, deps), 1, '错误命令拒绝');
    }
    for (const input of [
      '{not-json',
      null,
      [],
      { ...brand, identityLine: ' ' },
      { ...brand, aiTitle: 9 },
      { brandName: '缺字段' },
      { ...brand, secret: 'do-not-log-me' },
    ]) {
      const bad = path.join(root, 'bad.json');
      fs.writeFileSync(bad, typeof input === 'string' ? input : JSON.stringify(input));
      equal(await runTenantBrand(['set', '--tenant', 'demo', '--brand-file', bad], deps), 1, '坏品牌档案拒绝');
    }
    equal(await audits(), beforeRefusals, '所有拒绝均不写品牌审计');
    equal(await readBrand(s.db, tenant!.id), null, '拒绝不改待生效品牌');

    const createArgs = ['--slug', 'branded', '--name', '示例租户', '--pack', 'travel'];
    const creationAudits = () =>
      s.query<{ diff: unknown }>("select diff from audit_log where action = 'platform.tenant_create' and diff->>'slug' = 'branded'");
    // 审计插入失败时，更新与首次创建都必须回滚，不能留下无审计的租户或品牌。
    await s.query(`create function brand_test_audit_failure() returns trigger language plpgsql as $$
      begin if NEW.action in ('tenant.brand_set', 'platform.tenant_create') then raise exception 'audit unavailable'; end if; return NEW; end $$`);
    await s.query(
      'create trigger brand_test_audit_failure before insert on audit_log for each row execute function brand_test_audit_failure()',
    );
    try {
      equal(await set(), 1, '审计失败命令退出 1');
      equal(await readBrand(s.db, tenant!.id), null, '审计失败品牌回滚');
      equal(await audits(), beforeRefusals, '审计失败无残留审计');
      process.env.DEPLOY_PROFILE = 'prod';
      equal(await runTenantCreate([...createArgs, '--brand-file', file], deps), 1, '创建审计失败退出 1');
      equal(await s.query("select id, brand from tenants where slug = 'branded'"), [], '创建审计失败租户和品牌整体回滚');
      equal(await creationAudits(), [], '创建失败无残留审计');
    } finally {
      await s.query('drop trigger brand_test_audit_failure on audit_log');
      await s.query('drop function brand_test_audit_failure()');
    }

    process.env.DEPLOY_PROFILE = 'prod';
    equal(await runTenantCreate(createArgs, deps), 1, 'prod 缺品牌退出 1');
    equal(await runTenantCreate([...createArgs, '--brand-file', file], deps), 0, '审计恢复后重试创建成功');
    equal(await runTenantCreate([...createArgs, '--brand-file', file], deps), 0, '同字段含品牌重复创建退出 0');
    equal(await runTenantCreate([...createArgs, '--brand-file', changedFile], deps), 2, '不同品牌重复创建退出 2');
    const [created] = await s.query<{ id: string }>("select id from tenants where slug = 'branded'");
    equal(await readBrand(s.db, created!.id), brand, '重复创建不覆盖已有品牌');
    equal(
      await creationAudits(),
      [{ diff: { slug: 'branded', name: '示例租户', packId: 'travel', brandFields: [...BRAND_FIELDS] } }],
      '重试后租户、品牌与唯一创建审计一起落库，幂等与冲突比较不追加审计',
    );
    for (const profile of [undefined, 'prod', 'demo', '']) {
      if (profile === undefined) delete process.env.DEPLOY_PROFILE;
      else process.env.DEPLOY_PROFILE = profile;
      const label = profile === undefined ? 'unset' : profile || 'empty';
      const legacySlug = `legacy-${label}`;
      const args = ['--slug', legacySlug, '--name', '示例', '--pack', 'travel'];
      equal(await runTenantCreate(args, deps), profile === 'demo' ? 0 : 1, `${label} 缺品牌只有显式 demo 放行`);
      equal(
        await s.query('select brand from tenants where slug = $1', [legacySlug]),
        profile === 'demo' ? [{ brand: null }] : [],
        `${label} 缺品牌拒绝不落库，显式 demo 为旧版模式`,
      );
      const slug = `brand-${label}`;
      equal(
        await runTenantCreate(['--slug', slug, '--name', '示例', '--pack', 'travel', '--brand-file', file], deps),
        0,
        `${label} 带品牌放行`,
      );
      equal(await s.query('select brand from tenants where slug = $1', [slug]), [{ brand }], `${label} 带品牌完整保存`);
      equal(
        (await s.query("select id from audit_log where action = 'platform.tenant_create' and diff->>'slug' = $1", [slug])).length,
        1,
        `${label} 带品牌恰好一条创建审计`,
      );
    }
    equal(await s.query('select * from sop_versions order by id'), published, '平台命令不改变已发布配置');
    equal(
      output.some((line) => line.includes(brand.brandName) || line.includes(changed.brandName) || line.includes('do-not-log-me')),
      false,
      '日志不含品牌原文或未知字段值',
    );
  } finally {
    process.env.DEPLOY_PROFILE = 'demo';
    console.log = oldLog;
    console.error = oldError;
  }
}

try {
  equal(BrandProfileSchema.safeParse(brand).success, true, 'schema 接受完整品牌');
  equal(auditAction('tenant.brand_set')?.group, 'platform', 'set 登记平台审计动作');
  equal(auditAction('tenant.brand_clear')?.group, 'platform', 'clear 登记平台审计动作');
  for (const profile of [undefined, 'prod']) {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PLATFORM_URL: '' };
    if (profile === undefined) delete env.DEPLOY_PROFILE;
    else env.DEPLOY_PROFILE = profile;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/tenant-create.ts', '--slug', 'prod-test', '--name', '示例', '--pack', 'travel'],
      {
        cwd: repo,
        env,
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
      },
    );
    equal(child.status, 1, '真实入口未设置与 prod 缺品牌退出 1');
    equal(child.stderr.includes('必须提供 --brand-file'), true, '缺品牌在连接数据库前拒绝');
    equal(
      child.stderr.includes('demo 实例在 `.env.platform` 里设 `DEPLOY_PROFILE=demo`'),
      true,
      '拒绝提示指明 platform 服务的显式 demo 配置',
    );
  }

  const t = await openTestDb();
  try {
    await installSeededConfig(t);
    await t.pg.exec('SET ROLE agent_platform');
    await suite({
      db: t.db,
      query: async <R>(text: string, params: unknown[] = []) =>
        t.pg.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE NONE');
          return (await tx.query<R>(text, params)).rows;
        }),
    });
    await t.migrate();
    equal(
      await readBrand(t.db, (await t.pg.query<{ id: string }>("select id from tenants where slug = 'branded'")).rows[0]!.id),
      brand,
      '迁移重跑保留品牌',
    );
  } finally {
    await t.close();
  }

  if (process.env.PG_TEST_URL) {
    const fx = await createRealPgFixture(process.env.PG_TEST_URL);
    const platform = await openDb(fx.urls.platform);
    const app = await openDb(fx.urls.app);
    try {
      await suite({ db: platform.db, query: fx.query });
      const permissions = await fx.query<{ col: string; platform: boolean; app: boolean }>(`select attname as col,
        has_column_privilege('agent_platform', 'tenants', attname, 'UPDATE') as platform,
        has_column_privilege('agent_app', 'tenants', attname, 'UPDATE') as app
        from pg_attribute where attrelid = 'tenants'::regclass and attnum > 0 and not attisdropped`);
      equal(
        permissions
          .filter((p) => p.platform)
          .map((p) => p.col)
          .sort(),
        ['brand', 'retention_customer_days', 'retention_lead_days', 'retention_trace_days'],
        '真实 PG 平台只可更新品牌和原保留期列',
      );
      equal(
        permissions.every((p) => !p.app),
        true,
        '真实 PG 应用所有租户列都只读',
      );
      await assert.rejects(platform.db.execute(sql`update tenants set name = 'changed' where id = ${fx.tenantId}`));
      pass++;
      await assert.rejects(app.db.execute(sql`update tenants set brand = null where id = ${fx.tenantId}`));
      pass++;
      equal(await readBrand(app.db, fx.tenantId), null, '真实 PG 应用可读品牌');
      const args = ['set', '--tenant', 'demo', '--brand-file', file];
      const deps = { connect: async () => ({ db: platform.db, close: async () => {} }) };
      const oldLog = console.log;
      console.log = () => {};
      try {
        equal(await Promise.all([runTenantBrand(args, deps), runTenantBrand(args, deps)]), [0, 0], '真实 PG 并发 set 成功');
      } finally {
        console.log = oldLog;
      }
      const last = await fx.query<{ diff: unknown }>(
        "select diff from audit_log where action = 'tenant.brand_set' order by id desc limit 2",
      );
      equal(
        last.map((r) => r.diff),
        [{ fields: [] }, { fields: [...BRAND_FIELDS] }],
        '真实 PG 并发按锁定后的旧值审计',
      );
      const refused = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/tenant-brand.ts', ...args], {
        cwd: repo,
        env: { ...process.env, DATABASE_PLATFORM_URL: fx.urls.app },
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
      });
      equal(refused.status, 1, '真实 PG 应用身份执行平台命令拒绝');
      equal(refused.stderr.includes(brand.brandName), false, '真实 PG 权限错误不泄露品牌');
    } finally {
      await app.close();
      await platform.close();
      await fx.drop();
    }
  } else if (process.env.CI === 'true') {
    throw new Error('CI 下必须设 PG_TEST_URL：品牌列授权与并发须以真实 Postgres 验证');
  } else {
    console.log('BRAND SELFTEST：没有 PG_TEST_URL，跳过真实 PG 授权、并发与应用身份命令拒绝');
  }
  console.log(`BRAND SELFTEST PASS: ${pass} 项断言全通`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
