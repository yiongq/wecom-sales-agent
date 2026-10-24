// 08 R2 第 4 步：通用快照、包隔离、沙箱容量、匿名读取与 trace 版本。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-snapshot-'));
  process.env.VAR_DIR = dir;
  const { hostRuntime, withoutTenantScope, createTenantRuntime, withTenantScope } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const { openTestDb, installSeededConfig } = await withoutTenantScope(() => import('../db/testing.js'));
  const { createFixtureTenant } = await import('../tenancy/fixture-testing.js');
  const { packById, runtimeById, validatePackCatalog } = await import('../packs/registry.js');
  const { bindPack } = await import('../core/pack-api.js');
  const { withTenant } = await import('../db/client.js');
  const {
    initConfig,
    closeConfig,
    __configTest,
    currentCatalog,
    packSources,
    applyCatalogRow,
    reloadFromDb,
    pinCatalogForTurn,
    assertCatalogStartup,
    ConfigStartupError,
    configDrift,
  } = await import('./source.js');
  const { prepareCatalogCsv, catalogCsvColumns, toCsv } = await import('../shared/catalog-csv.js');
  const { createCatalogItem, activateCatalogItem, updateCatalogItem, importCatalogCsv } = await import('./catalog.js');
  const { readPublishedSop, insertPublishedSop } = await import('../db/repo/sop.js');
  const { readCatalogOfKind, countCatalogItems } = await import('../db/repo/catalog.js');
  const { consoleApi } = await import('../console-api/app.js');
  const { withTurnScope, startTurn, traceToolCall, noteToolResult, endTurn, onTurnEnd } = await import('../trace/recorder.js');
  const { SandboxLimitError } = await import('../tenancy/sandbox/limits.js');
  const t = await openTestDb();
  try {
    const deps = await installSeededConfig(t);
    const travel = rt.config.loaded!;
    const ctx = { tenantId: travel.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    // 开工数据原始 JSON 字节顺序是持久化契约，不经 zod 重排。
    for (const [alias, kind, file] of [
      ['routes', 'route', 'routes.json'],
      ['hotels', 'hotel', 'hotels.json'],
    ] as const) {
      assert.equal(JSON.stringify(currentCatalog()[alias]), JSON.stringify(JSON.parse(fs.readFileSync(`data/${file}`, 'utf8'))));
      assert.equal(currentCatalog()[alias], currentCatalog().items[kind]);
    }
    const beforeTravel = JSON.stringify([currentCatalog().routes, currentCatalog().hotels]);
    const travelRuntime = runtimeById('travel', packSources())!;
    const fixtureRuntime = runtimeById('__fixture', packSources())!;
    const fixturePack = packById('__fixture')!;
    const widget = fixtureRuntime.catalog.widget!;
    // 同名 hotel 只登记在测试副本，与第 2 步的测试构造一致。
    validatePackCatalog(
      { ...fixturePack, entities: [...fixturePack.entities, { ...fixturePack.entities[0]!, kind: 'hotel' }] },
      { catalog: { ...fixtureRuntime.catalog, hotel: { ...widget, retrieval: false } } },
    );
    const hotelSchema = travelRuntime.catalog.hotel!.schema;
    const fixtureCsv = 'id,title,unitPrice,unit,tags\nw-csv,合成方盒,12,件,合成';
    const travelHotel = currentCatalog().hotels[0]!;
    const hotelColumns = catalogCsvColumns('hotel').columns;
    const travelCsv = toCsv([
      hotelColumns,
      hotelColumns.map((key) => {
        const value = (travelHotel as unknown as Record<string, unknown>)[key];
        return Array.isArray(value) ? value.join('、') : String(value ?? '');
      }),
    ]);
    const parseFixture = () => prepareCatalogCsv('hotel', fixtureCsv, {}, widget.schema, '__fixture');
    const parseTravel = () => prepareCatalogCsv('hotel', travelCsv, {}, hotelSchema, 'travel');
    assert.equal(parseFixture()[0]!.title, '合成方盒');
    assert.equal(parseTravel()[0]!.name, travelHotel.name);
    assert.equal(parseFixture()[0]!.unitPrice, 12);
    assert.equal(parseTravel()[0]!.nightlyFrom, travelHotel.nightlyFrom);
    assert.ok(catalogCsvColumns('hotel', widget.schema, '__fixture').columns.includes('unitPrice'));
    assert.ok(!catalogCsvColumns('hotel').columns.includes('unitPrice'));
    assert.throws(() => prepareCatalogCsv('hotel', travelCsv, {}, widget.schema, '__fixture'));
    assert.throws(() => prepareCatalogCsv('hotel', fixtureCsv, {}, hotelSchema, 'travel'));
    console.log('CATALOG SNAPSHOT PASS：旅游导入字节、数组同一引用、同进程 hotel CSV 双向隔离');

    const pub = await withTenant(t.db, ctx, readPublishedSop);
    assert.ok(pub);
    // 启动旅游无线路仍保留旧原因和完整文案；仅在一次性测试库中临时隐藏行。
    await closeConfig();
    __configTest.reset();
    await t.pg.exec('RESET ROLE');
    await t.pg.exec('ALTER TABLE catalog_items DISABLE TRIGGER USER');
    await t.pg.query("UPDATE catalog_items SET status = 'draft' WHERE tenant_id = $1 AND kind = 'route'", [ctx.tenantId]);
    await t.pg.exec('ALTER TABLE catalog_items ENABLE TRIGGER USER');
    await t.pg.exec('SET ROLE agent_app');
    await assert.rejects(
      initConfig(deps),
      (e: unknown) => e instanceof ConfigStartupError && e.reason === 'no_active_routes' && e.detail === '租户「demo」没有 active 的线路',
    );
    await t.pg.exec('RESET ROLE');
    await t.pg.query("UPDATE catalog_items SET status = 'active' WHERE tenant_id = $1 AND kind = 'route'", [ctx.tenantId]);
    const tenant = await createFixtureTenant(t.db);
    await t.pg.exec('SET ROLE agent_app');
    const fixtureCtx = { ...ctx, tenantId: tenant.id };
    await withTenant(t.db, fixtureCtx, (tx) =>
      insertPublishedSop(tx, {
        tenantId: tenant.id,
        versionNo: 1,
        source: 'import',
        packId: tenant.packId,
        sections: pub.sections,
        basedOn: null,
        renderedPrompt: pub.renderedPrompt!,
        promptHash: pub.promptHash!,
        toolsHash: pub.toolsHash!,
        prefixHash: pub.prefixHash!,
        sopHash: pub.sopHash!,
        policy: pub.policy,
        renderInputs: pub.renderInputs!,
        changeNote: null,
        createdBy: null,
        createdByName: null,
      }),
    );
    // 产品链路独立于第 12 步 SOP 发布：使用已装载配置外壳，绑定真实证明包。
    rt.config.loaded = {
      ...travel,
      tenantId: tenant.id,
      tenantName: tenant.name,
      pack: fixturePack,
      deps: { ...deps, tenantSlug: tenant.slug },
      catalog: { tenantId: tenant.id, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
      ords: {},
      history: new Map(),
    };
    rt.config.dbInstalled = true;
    bindPack(fixtureRuntime, fixtureRuntime.defaultBrand!);
    const payload = (id: string) => ({ id, title: '合成方盒', unitPrice: 12, unit: '件', tags: ['合成'] });
    const created = await createCatalogItem(fixtureCtx, 'widget', payload('w-first'));
    assert.equal(currentCatalog().items.widget, undefined);
    await activateCatalogItem(fixtureCtx, 'widget', created.code, { rev: created.rev });
    const first = currentCatalog();
    assert.deepEqual(first.items.widget, [payload('w-first')]);
    assert.deepEqual(first.hotels, []);
    assert.equal(first.versions['widget:w-first'], 1);
    assert.ok(Object.isFrozen(first.items) && Object.isFrozen(first.items.widget));
    assert.ok(Object.isFrozen((first.items.widget![0] as { tags: string[] }).tags));
    await pinCatalogForTurn(async () => {
      await updateCatalogItem(fixtureCtx, 'widget', 'w-first', { rev: 2, set: { unitPrice: 15 } });
      assert.equal(currentCatalog(), first);
    });
    assert.equal(currentCatalog().versions['widget:w-first'], 2);
    assert.equal((currentCatalog().items.widget![0] as { unitPrice: number }).unitPrice, 15);
    applyCatalogRow({ kind: 'widget', code: 'w-before', ord: -1, status: 'active', version: 1, payload: payload('w-before') });
    assert.deepEqual(
      currentCatalog().items.widget!.map((p) => (p as { id: string }).id),
      ['w-before', 'w-first'],
    );
    // reload 按所有 kind 比较：删除仅存在于内存的 widget，即使 route/hotel/版本键不变也要更新。
    const versionsBefore = { ...currentCatalog().versions };
    rt.config.loaded!.catalog = { ...currentCatalog(), versions: { 'widget:w-first': 2 } };
    const generation = currentCatalog().generation;
    await reloadFromDb();
    assert.equal(currentCatalog().generation, generation + 1);
    assert.equal(currentCatalog().items.widget!.length, 1);
    assert.equal(currentCatalog().versions['widget:w-first'], versionsBefore['widget:w-first']);
    assert.deepEqual(configDrift().catalog.route.onlyDb, []);
    for (const url of ['/catalog/widget', '/catalog/widget/w-first']) {
      const res = await consoleApi.request(`/api/console${url}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items?: { code: string; payload: object }[]; code?: string };
      assert.equal(body.items?.[0]?.code ?? body.code, 'w-first');
    }
    assert.equal((await consoleApi.request('/api/console/catalog/widget/missing')).status, 404);
    const versionsSeen: Record<string, number>[] = [];
    const unsubscribe = onTurnEnd(({ turn }) => versionsSeen.push({ ...turn.catalogVersions }));
    try {
      for (const [args, result] of [
        [{}, { rows: [{ id: 'w-first' }] }],
        [{ widgetId: 'w-first' }, { ok: true }],
        [{ widgetId: 'w-first' }, { error: 'missing' }],
      ] as const) {
        await withTurnScope(async () => {
          startTurn('snapshot-trace');
          traceToolCall('fixture_inspect', args, 'snapshot-trace');
          noteToolResult(args, JSON.stringify(result));
          endTurn('replied', '已核验', 'greeting', 'greeting');
        });
      }
    } finally {
      unsubscribe();
    }
    assert.deepEqual(versionsSeen, [{ 'widget:w-first': 2 }, { 'widget:w-first': 2 }, {}]);
    console.log('CATALOG SNAPSHOT PASS：widget 新建/上架/改价、递归冻结、ord、轮内固定、reload、匿名列表/详情、trace 版本');

    const sandbox = createTenantRuntime({ id: tenant.id, slug: tenant.slug, kind: 'sandbox' });
    sandbox.config.loaded = rt.config.loaded;
    sandbox.config.dbInstalled = true;
    process.env.SANDBOX_WRITE_LIMITS = JSON.stringify({ catalogItems: 2 });
    try {
      await withTenantScope(sandbox, async () => {
        bindPack(fixtureRuntime, fixtureRuntime.defaultBrand!);
        await createCatalogItem(fixtureCtx, 'widget', payload('w-draft'));
        const limited = (e: unknown) => e instanceof SandboxLimitError && e.reason === 'sandbox_write_capacity_limited';
        await assert.rejects(createCatalogItem(fixtureCtx, 'widget', payload('w-over')), limited);
        await assert.rejects(importCatalogCsv(fixtureCtx, 'widget', fixtureCsv), limited);
        assert.equal(await withTenant(t.db, fixtureCtx, countCatalogItems), 2);
      });
    } finally {
      delete process.env.SANDBOX_WRITE_LIMITS;
    }
    assert.equal((await withTenant(t.db, fixtureCtx, (tx) => readCatalogOfKind(tx, 'widget'))).length, 2);
    assert.equal(JSON.stringify([travel.catalog.routes, travel.catalog.hotels]), beforeTravel);
    console.log('CATALOG SNAPSHOT PASS：active + draft widget 计入沙箱上限，新建和 CSV 均沿用容量错误码');
    const activeSnapshot = currentCatalog();
    assert.equal(activeSnapshot.items.widget!.length, 1);
    assert.doesNotThrow(() => assertCatalogStartup(fixtureRuntime, activeSnapshot, tenant.slug));
    assert.throws(
      () => assertCatalogStartup(fixtureRuntime, { ...activeSnapshot, items: { ...activeSnapshot.items, widget: [] } }, tenant.slug),
      (e: unknown) =>
        e instanceof ConfigStartupError &&
        e.reason === 'catalog_startup' &&
        e.detail === '没有 active 的 widget' &&
        e.message === 'catalog_startup：没有 active 的 widget',
    );
    assert.doesNotThrow(() => assertCatalogStartup(travelRuntime, travel.catalog, 'demo'));
    const noRoutes: [] = [];
    assert.throws(
      () =>
        assertCatalogStartup(
          travelRuntime,
          { ...travel.catalog, items: { ...travel.catalog.items, route: noRoutes }, routes: noRoutes },
          'demo',
        ),
      (e: unknown) =>
        e instanceof ConfigStartupError &&
        e.reason === 'no_active_routes' &&
        e.detail === '租户「demo」没有 active 的线路' &&
        e.message === 'no_active_routes：租户「demo」没有 active 的线路',
    );
    console.log('CATALOG SNAPSHOT PASS：启动判定纯函数，旅游/证明包各自的拒绝原因、完整文案与 active 放行');
    console.log('CATALOG SNAPSHOT SKIP：证明包 DB 端到端启动，第 12 步接上 SOP 按包之后补');
    // 旅游闸缓存仍只取旧的两组数组。
    assert.match(
      fs.readFileSync('src/config/gate.ts', 'utf8'),
      /JSON\.stringify\(\[snapshot\.catalog\.routes, snapshot\.catalog\.hotels\]\)/,
    );
  } finally {
    await closeConfig();
    __configTest.reset();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
