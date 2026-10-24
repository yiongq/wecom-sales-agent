// 08 R7、验收 3.1：元/分边界与证明包 CSV 草稿、上架、列表、导航（本地 PGlite）。
import './selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalogMoneyValues, yuanToFen } from './shared/catalog-money.js';
import { formatYuan } from './shared/format.js';
import { checkItem } from './shared/pack.js';
import { CatalogCsvError, prepareCatalogCsv } from './shared/catalog-csv.js';

if (process.argv[2] !== 'worker') {
  const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
    env: { ...process.env, PACK_FIXTURES: '1', LLM_MOCK: '1', CONFIG_SOURCE: 'file' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
} else {
  assert.deepEqual([0, 5, 133000, 133050, -5, -133050].map(formatYuan), [
    '0元',
    '0.05元',
    '1,330元',
    '1,330.50元',
    '-0.05元',
    '-1,330.50元',
  ]);
  for (const n of [NaN, Infinity, -Infinity, 3.65]) assert.equal(formatYuan(n), '—');
  assert.deepEqual([0, 0.05, 3.65, 1330.5, 0.1 + 0.2, -3.65, 1.005 - 0.005].map(yuanToFen), [0, 5, 365, 133050, 30, -365, 100]);
  for (const n of [3.655, 0.001, -1.001, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => yuanToFen(n));
  // 舍入误差容差的两侧都测；没有随金额规模放宽容差。
  assert.equal(yuanToFen(3.65 + 0.5e-9), 365);
  assert.throws(() => yuanToFen(3.65 + 2e-9));
  const fields = [
    { path: 'pricing.base', decimals: 0 as const },
    { path: 'tiers[].unitPrice', decimals: 2 as const },
    { path: 'tiers[].extras[].unitPrice', decimals: 2 as const },
  ];
  const payload = {
    pricing: { base: 12 },
    tiers: [
      { unitPrice: 3.65, extras: [{ unitPrice: 0.05 }] },
      { unitPrice: 4, extras: [] },
    ],
  };
  assert.deepEqual(catalogMoneyValues(payload, fields), [12, 3.65, 4, 0.05]);
  assert.deepEqual(catalogMoneyValues(payload, fields).map(yuanToFen), [1200, 365, 400, 5]);
  assert.deepEqual(catalogMoneyValues({ tiers: [] }, fields), []);
  assert.deepEqual(catalogMoneyValues(Object.create(payload) as typeof payload, fields), []);
  assert.throws(() => catalogMoneyValues({ tiers: {} }, fields));
  assert.throws(() => catalogMoneyValues({ tiers: [{ unitPrice: '3.65' }] }, fields));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-money-'));
  process.env.VAR_DIR = dir;
  const { hostRuntime, withoutTenantScope } = await import('./tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const { openTestDb, installSeededConfig } = await withoutTenantScope(() => import('./db/testing.js'));
  const { createFixtureTenant } = await import('./tenancy/fixture-testing.js');
  const { packById, runtimeById } = await import('./packs/registry.js');
  const { packSources } = await import('./core/engine/sources.js');
  const { closeConfig, __configTest } = await import('./config/source.js');
  const { createUser } = await import('./auth/accounts.js');
  const { consoleApi } = await import('./console-api/app.js');
  const t = await openTestDb();
  try {
    await installSeededConfig(t);
    const travel = rt.config.loaded!;
    await t.pg.exec('RESET ROLE');
    const tenant = await createFixtureTenant(t.db);
    const pack = packById(tenant.packId)!;
    const widget = pack.entities[0]!;
    const schema = runtimeById(pack.id, packSources())!.catalog.widget!.schema;
    const sample = { id: 'w-test', title: '合成方盒', unitPrice: 3.65, unit: '件', tags: ['合成'] };
    assert.deepEqual(checkItem(widget, sample).required, []);
    assert.deepEqual(checkItem(widget, { ...sample, unitPrice: 0.1 + 0.2 }).required, []);
    assert.ok(schema.safeParse({ ...sample, unitPrice: 0.1 + 0.2 }).success);
    const csv = (price: string, id = 'w-test') => `id,title,unitPrice,unit,tags\n${id},合成方盒,${price},件,合成`;
    for (const price of [3.655, 0, -1, 1e-10, 3.6500000001]) {
      assert.ok(checkItem(widget, { ...sample, unitPrice: price }).required.some((issue) => issue.path === 'unitPrice'));
      assert.equal(schema.safeParse({ ...sample, unitPrice: price }).success, false);
      assert.throws(() => prepareCatalogCsv('widget', csv(String(price)), {}, schema, pack.id), CatalogCsvError);
    }
    rt.config.loaded = {
      ...travel,
      tenantId: tenant.id,
      tenantName: tenant.name,
      pack,
      deps: { ...travel.deps, tenantSlug: tenant.slug },
      ords: { ...travel.ords, widget: new Map() },
    };
    await t.pg.exec('SET ROLE agent_platform');
    assert.equal(
      (
        await createUser(t.db, {
          tenantSlug: tenant.slug,
          email: 'money@example.com',
          name: '合成管理员',
          role: 'owner',
          password: async () => 'catalog-money-selftest',
        })
      ).code,
      0,
    );
    await t.pg.exec('SET ROLE agent_app');
    let cookie = '';
    let csrf = '';
    const request = (method: string, url: string, body?: unknown) =>
      consoleApi.request(`/api/console${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.42', cookie, 'x-csrf': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const login = await request('POST', '/auth/login', { email: 'money@example.com', password: 'catalog-money-selftest' });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    csrf = ((await login.json()) as { csrf: string }).csrf;
    const navResponse = await request('GET', '/pack');
    assert.equal(navResponse.status, 200);
    const nav = (await navResponse.json()) as typeof pack;
    assert.ok(nav.nav.entities.includes('widget'));
    assert.equal(nav.entities[0]!.fields.find((f) => f.key === 'unitPrice')!.decimals, 2);
    const imported = await request('POST', '/catalog/widget/import-csv', {
      csv: csv('3.65', 'w-a') + '\nw-b,合成方盒乙,12,件,合成\nw-c,合成方盒丙,1330.50,盒,合成',
    });
    assert.equal(imported.status, 200);
    type Item = { code: string; status: string; rev: number; payload: { unitPrice: number } };
    const drafts = ((await imported.json()) as { items: Item[] }).items;
    assert.equal(drafts.length, 3);
    assert.ok(drafts.every((item) => item.status === 'draft' && item.rev === 1));
    assert.equal(drafts[0]!.payload.unitPrice, 3.65);
    for (const price of ['3.655', '0', '-1']) {
      const bad = await request('POST', '/catalog/widget/import-csv', { csv: csv(price, 'w-bad') });
      assert.equal(bad.status, 422);
      assert.equal(((await bad.json()) as { error: string }).error, 'invalid_csv');
    }
    for (const item of drafts)
      assert.equal((await request('POST', `/catalog/widget/${item.code}/activate`, { rev: item.rev })).status, 200);
    const listed = await request('GET', '/catalog/widget');
    assert.equal(listed.status, 200);
    const active = ((await listed.json()) as { items: Item[] }).items;
    assert.equal(active.length, 3);
    assert.ok(active.every((item) => item.status === 'active'));
    assert.deepEqual(
      active.map((item) => item.payload.unitPrice),
      [3.65, 12, 1330.5],
    );
    assert.equal(formatYuan(yuanToFen(active[0]!.payload.unitPrice)), '3.65元');
    console.log('CATALOG MONEY PASS：换算/格式/数组路径边界；PGlite widget 导航、3 行 CSV 草稿、非法金额拒绝、上架列表保留 3.65 元值');
  } finally {
    await closeConfig();
    __configTest.reset();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
