// 08 R2 第 3 步：kind 的库格式、包归属、七条写路径与 HTTP 400 / 422。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-kind-'));
  process.env.VAR_DIR = dir;
  const { hostRuntime, withoutTenantScope } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const { openTestDb, installSeededConfig, createRealPgFixture } = await withoutTenantScope(() => import('../db/testing.js'));
  const { createFixtureTenant } = await import('../tenancy/fixture-testing.js');
  const { packById } = await import('../packs/registry.js');
  const { closeConfig, __configTest } = await import('./source.js');
  const { withTenant } = await import('../db/client.js');
  const catalog = await import('./catalog.js');
  const { importConfig, writeTemplateConfig } = await import('./transfer.js');
  const { readPublishedSop } = await import('../db/repo/sop.js');
  const { readActiveCatalog, readCatalogOfKind } = await import('../db/repo/catalog.js');
  const { readCatalogVersions } = await import('../db/repo/catalog-versions.js');
  const { createUser } = await import('../auth/accounts.js');
  const { consoleApi } = await import('../console-api/app.js');
  const t = await openTestDb();
  try {
    await installSeededConfig(t);
    const travel = rt.config.loaded!;
    const travelCtx = { tenantId: travel.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const [pub, active] = await withTenant(
      t.db,
      travelCtx,
      async (tx) => [await readPublishedSop(tx), await readActiveCatalog(tx)] as const,
    );
    assert.ok(pub);
    // 迁移只放宽：原旅游 active 行仍完整；格式合法的任意 kind 可通过库约束。
    assert.ok(active.some((row) => row.kind === 'route'));
    assert.ok(active.some((row) => row.kind === 'hotel'));
    await t.migrate();
    assert.deepEqual(await withTenant(t.db, travelCtx, readActiveCatalog), active);
    await t.pg.exec('RESET ROLE');
    const tenant = await createFixtureTenant(t.db);
    const ctx = { ...travelCtx, tenantId: tenant.id };
    const insert = `INSERT INTO catalog_items (tenant_id, kind, code, ord, payload) VALUES ($1, $2, $3, $4, $5::json)`;
    const badKind = (e: unknown): boolean =>
      (e as { code?: string; constraint?: string }).code === '23514' &&
      (e as { constraint?: string }).constraint === 'catalog_items_kind_check';
    for (const kind of ['Bad-Kind', 'x', 'a'.repeat(33)]) {
      await assert.rejects(t.pg.query(insert, [tenant.id, kind, 'bad', 0, '{"id":"bad"}']), badKind);
    }
    await t.pg.query(insert, [tenant.id, 'other_kind', 'format-ok', 0, '{"id":"format-ok"}']);
    await t.pg.query('DELETE FROM catalog_items WHERE tenant_id = $1', [tenant.id]);

    // 第 4、12 步才接非旅游快照与 SOP 启动；这里复用已验证的配置外壳，只替换租户与包。
    // ords.widget 给现有 applyCatalogRow 的过渡实现使用；本步只断言持久化，不断言快照。
    rt.config.loaded = {
      ...travel,
      tenantId: tenant.id,
      tenantName: tenant.name,
      pack: packById(tenant.packId)!,
      deps: { ...travel.deps, tenantSlug: tenant.slug },
      ords: { ...travel.ords, widget: new Map() },
    };
    await t.pg.exec('SET ROLE agent_app');
    const payload = { id: 'w-one', title: '合成方盒', unitPrice: 12, unit: '件', tags: ['合成'] };
    const unknown = catalog.CatalogKindUnknownError;
    assert.throws(() => catalog.assertKind(tenant.packId, 'constructor'), unknown);
    assert.throws(() => catalog.assertKind('missing', 'widget'), unknown);
    // 清单 4.1、4.3、4.4、4.5：未知 kind 必须先于 payload、rev、CSV 校验拒绝。
    await assert.rejects(catalog.createCatalogItem(ctx, 'route', null), unknown);
    await assert.rejects(catalog.updateCatalogItem(ctx, 'route', 'missing', { rev: 1, set: {} }), unknown);
    await assert.rejects(catalog.activateCatalogItem(ctx, 'route', 'missing', { rev: 1 }), unknown);
    await assert.rejects(catalog.importCatalogCsv(ctx, 'route', ''), unknown);
    await assert.rejects(catalog.listCatalog(ctx, 'route'), unknown);
    await assert.rejects(catalog.getCatalogItem(ctx, 'route', 'missing'), unknown);
    // 清单 4.6：没有绑定证明包运行时，也必须从租户行拿 pack_id。
    await assert.rejects(
      catalog.fixLockedFields({ db: t.db, tenantSlug: tenant.slug, kind: 'route', code: 'missing', set: {}, reason: '合成修正' }),
      unknown,
    );
    // 清单 4.7：导入按包（08 R11，第 18 步）：旅游目录（没有 pack.json）导入证明包租户，须在取锁、读条目、写入之前拒绝，报错点名两边的包。
    const result = await importConfig({
      db: t.db,
      tenantSlug: tenant.slug,
      dataDir: dir,
      imageSop: '',
      lock: async () => {
        throw new Error('不应取锁');
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.message, /「travel」.*「__fixture」/);
    // 清单 4.8：不能把不属于模板包的条目静默过滤掉。
    await assert.rejects(
      withTenant(t.db, ctx, (tx) => writeTemplateConfig(tx, { ...pub, packId: tenant.packId }, [active[0]!], '')),
      unknown,
    );
    assert.deepEqual(await withTenant(t.db, ctx, readActiveCatalog), []);

    await t.pg.exec('SET ROLE agent_platform');
    assert.equal(
      (
        await createUser(t.db, {
          tenantSlug: tenant.slug,
          email: 'catalog@example.com',
          name: '合成管理员',
          role: 'owner',
          password: async () => 'catalog-selftest-password',
        })
      ).code,
      0,
    );
    await t.pg.exec('SET ROLE agent_app');
    const request = async (method: string, url: string, json?: unknown, auth?: { cookie: string; csrf: string }) => {
      const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.41' };
      if (auth) {
        headers.cookie = auth.cookie;
        headers['x-csrf'] = auth.csrf;
      }
      if (json !== undefined) headers['content-type'] = 'application/json';
      return consoleApi.request(`/api/console${url}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    };
    const logged = await request('POST', '/auth/login', { email: 'catalog@example.com', password: 'catalog-selftest-password' });
    assert.equal(logged.status, 200);
    const auth = { cookie: logged.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await logged.json()) as { csrf: string }).csrf };
    for (const who of [undefined, auth]) {
      for (const url of ['/catalog/route', '/catalog/route/anything']) {
        const res = await request('GET', url, undefined, who);
        assert.equal(res.status, 422);
        assert.equal(((await res.json()) as { error: string }).error, 'kind_unknown');
      }
      for (const url of ['/catalog/Bad-Kind', '/catalog/Bad-Kind/anything']) {
        assert.equal((await request('GET', url, undefined, who)).status, 400);
      }
    }
    for (const [method, url, body] of [
      ['POST', '/catalog/route', { payload }],
      ['PATCH', '/catalog/route/w-one', { rev: 1, set: {} }],
      ['POST', '/catalog/route/w-one/activate', { rev: 1 }],
      ['POST', '/catalog/route/import-csv', { csv: 'id\nx' }],
    ] as const) {
      const res = await request(method, url, body, auth);
      assert.equal(res.status, 422, url);
      assert.equal(((await res.json()) as { error: string }).error, 'kind_unknown');
      assert.equal((await request(method, url.replace('route', 'Bad-Kind'), body, auth)).status, 400);
    }
    const create = await request('POST', '/catalog/widget', { payload }, auth);
    assert.equal(create.status, 200);
    assert.equal(((await create.json()) as { status: string }).status, 'draft');
    // widget schema：旅游没有的 unit 必须合法，不会退回 HotelSchema。
    const invalid = await request('POST', '/catalog/widget', { payload: { ...payload, id: 'w-bad', unit: '吨' } }, auth);
    assert.equal(invalid.status, 422);
    const invalidBody = (await invalid.json()) as { error: string; issues: { path: string }[] };
    assert.equal(invalidBody.error, 'invalid_item');
    assert.ok(invalidBody.issues.some((issue) => issue.path === 'unit'));
    assert.equal((await request('PATCH', '/catalog/widget/w-one', { rev: 1, set: { title: '更新方盒' } }, auth)).status, 200);
    assert.equal((await request('POST', '/catalog/widget/w-one/activate', { rev: 2 }, auth)).status, 200);
    // 证明包 active 只锁 id；title 不应套用旅游 route 的锁定表。
    assert.equal(
      (await request('PATCH', '/catalog/widget/w-one', { rev: 3, set: { title: '上架后改标题', unitPrice: 15, unit: '盒' } }, auth)).status,
      200,
    );
    const locked = await request('PATCH', '/catalog/widget/w-one', { rev: 4, set: { id: 'w-changed' } }, auth);
    assert.equal(locked.status, 422);
    assert.deepEqual(await locked.json().then((body: { error: string; fields: string[] }) => [body.error, body.fields]), [
      'locked_field',
      ['id'],
    ]);
    const csv = await request(
      'POST',
      '/catalog/widget/import-csv',
      { csv: 'id,title,unitPrice,unit,tags\nw-csv,导入方盒,20,件,合成' },
      auth,
    );
    assert.equal(csv.status, 200);
    const csvBody = (await csv.json()) as { items: { kind: string; status: string; payload: object }[] };
    assert.equal(csvBody.items.length, 1);
    assert.equal(csvBody.items[0]!.kind, 'widget');
    assert.equal(csvBody.items[0]!.status, 'draft');
    const wrongCsv = await request(
      'POST',
      '/catalog/widget/import-csv',
      { csv: 'id,title,unitPrice,unit,tags\nw-bad,不合格,20,吨,合成' },
      auth,
    );
    assert.equal(wrongCsv.status, 422);
    assert.equal(((await wrongCsv.json()) as { error: string }).error, 'invalid_csv');
    const rows = await withTenant(t.db, ctx, (tx) => readCatalogOfKind(tx, 'widget'));
    assert.deepEqual(
      rows.map((row) => [row.code, row.status, row.rev]),
      [
        ['w-one', 'active', 4],
        ['w-csv', 'draft', 1],
      ],
    );
    const versions = await withTenant(t.db, ctx, readCatalogVersions);
    assert.deepEqual(
      versions.map((row) => [row.code, row.version, row.payload.unitPrice]),
      [
        ['w-one', 1, 12],
        ['w-one', 2, 15],
      ],
    );
    const fixed = await catalog.fixLockedFields({
      db: t.db,
      tenantSlug: tenant.slug,
      kind: 'widget',
      code: 'w-one',
      set: { title: '修正方盒' },
      reason: '合成修正',
    });
    assert.equal(fixed.rev, 5);
    console.log(
      'CATALOG KIND PASS：PGlite 格式 CHECK、七条写路径拒绝、匿名/成员读取 422、格式 400、widget 新建/补丁/上架/CSV/schema/锁定/计价版本/catalog-fix',
    );

    if (process.env.PG_TEST_URL) {
      const pg = await createRealPgFixture(process.env.PG_TEST_URL);
      try {
        await assert.rejects(pg.query(insert, [pg.tenantId, 'Bad-Kind', 'bad', 0, '{"id":"bad"}']), badKind);
        await pg.query(insert, [pg.tenantId, 'widget', 'w-pg', 0, JSON.stringify({ ...payload, id: 'w-pg' })]);
        console.log('CATALOG KIND PASS：真实 PG 格式 CHECK');
      } finally {
        await pg.drop();
      }
    } else console.log('CATALOG KIND SKIP：未设置 PG_TEST_URL，真实 PG 格式 CHECK 未运行');
  } finally {
    await closeConfig();
    __configTest.reset();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
