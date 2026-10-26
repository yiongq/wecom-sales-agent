// 第15步发现5：首次 DB 导入与文件装载均验证完整候选快照，失败整批不写。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-import-'));
Object.assign(process.env, { VAR_DIR: path.join(dir, 'state'), CONFIG_SOURCE: 'file', LLM_MOCK: '1', SOP_PATH: path.join(dir, 'sop.md') });
fs.cpSync('data/packs/industrial', dir, { recursive: true });
const file = path.join(dir, 'catalog/part.json');
const original = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
const { hostRuntime, withoutTenantScope } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
enterTenantScopeForTest(hostRuntime());
const config = await import('./config/source.js');
const { openTestDb, fakeLock } = await withoutTenantScope(() => import('./db/testing.js'));
const { insertTenant } = await import('./db/repo/tenants.js');
const { importConfig } = await import('./config/transfer.js');
const { readImageSop } = await import('./config/brand.js');
const { createIndustrialRuntime } = await import('./packs/industrial/runtime.js');
const db = await openTestDb();
const failures: string[] = [];
try {
  for (const [name, rows, field] of [
    [
      'duplicate',
      [
        { ...original[0], id: 'review-a', partNo: 'HS1000', substitutes: [] },
        { ...original[0], id: 'review-b', partNo: 'hs 1000', substitutes: [] },
      ],
      'partNo',
    ],
    ['missing', [{ ...original[0], substitutes: ['MISSING9000'] }], 'substitutes'],
    ['valid', original.toReversed(), ''],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify(rows));
    config.__configTest.reset();
    try {
      if (field) assert.throws(() => config.currentCatalog(), new RegExp(field));
      else assert.equal(config.currentCatalog().items.part?.length, 40);
      console.log(`PASS R5-file-${name}`);
    } catch (error) {
      failures.push(`R5-file-${name}: ${String(error)}`);
      console.log(`FAIL R5-file-${name}`);
    }
    const tenant = await insertTenant(db.db, {
      slug: `review-${name}`,
      name: '合成导入测试',
      packId: 'industrial',
      locale: 'zh-CN',
      region: 'CN',
      brand: createIndustrialRuntime(config.packSources()).defaultBrand,
    });
    await db.pg.exec('SET ROLE agent_app');
    const result = await importConfig({
      db: db.db,
      tenantSlug: tenant.slug,
      dataDir: dir,
      imageSop: readImageSop,
      lock: async () => fakeLock(),
    });
    await db.pg.exec('RESET ROLE');
    try {
      assert.equal(result.code, field ? 1 : 0, result.message);
      if (field) assert.match(result.message, new RegExp(field));
      const counts = await db.pg.query<{ items: number; versions: number; sops: number; audits: number }>(
        `select (select count(*)::int from catalog_items where tenant_id=$1) items,
        (select count(*)::int from catalog_item_versions where tenant_id=$1) versions,
        (select count(*)::int from sop_versions where tenant_id=$1) sops,
        (select count(*)::int from audit_log where tenant_id=$1) audits`,
        [tenant.id],
      );
      if (field) assert.deepEqual(counts.rows[0], { items: 0, versions: 0, sops: 0, audits: 0 });
      else assert.deepEqual(counts.rows[0], { items: 40, versions: 40, sops: 1, audits: 1 });
      console.log(`PASS R5-db-${name}`);
    } catch (error) {
      failures.push(`R5-db-${name}: ${String(error)}`);
      console.log(`FAIL R5-db-${name}`);
    }
  }
  assert.deepEqual(failures, []);
} finally {
  config.__configTest.reset();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
