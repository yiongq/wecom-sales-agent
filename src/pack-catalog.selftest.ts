// 08 R2、R7、R9、R14：包的产品声明、装载拒绝与旅游引用不变。
import './selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CatalogKindSpec, FieldDef, IndustryPack } from './core/pack-api.js';

if (process.argv[2] !== 'worker') {
  for (const enabled of [false, true]) {
    const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_SOURCE: 'file' };
    delete env.PACK_FIXTURES;
    if (enabled) env.PACK_FIXTURES = '1';
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    process.stdout.write(child.stdout);
  }
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-catalog-'));
  process.env.VAR_DIR = dir;
  try {
    const { PACK_IDS, packById, runtimeById, validatePackCatalog } = await import('./packs/registry.js');
    const { packSources } = await import('./core/engine/sources.js');
    const { CATALOG_SCHEMAS, LOCKED_WHEN_ACTIVE, REPRICE_FIELDS } = await import('./shared/catalog.js');
    const { fixture, createFixtureRuntime } = await import('./packs/__fixture/runtime.js');
    const { checkItem } = await import('./shared/pack.js');
    const travel = runtimeById('travel', packSources())!;
    assert.ok(travel);
    for (const kind of ['route', 'hotel'] as const) {
      const spec = travel.catalog[kind]!;
      assert.equal(spec.schema, CATALOG_SCHEMAS[kind]);
      assert.equal(spec.lockedWhenActive, LOCKED_WHEN_ACTIVE[kind]);
      assert.equal(spec.repriceFields, REPRICE_FIELDS[kind]);
      assert.equal(spec.titleKey, packById('travel')!.entities.find((entity) => entity.kind === kind)!.titleKey);
    }
    assert.deepEqual(travel.catalog.route!.moneyFields, [{ path: 'priceFrom', decimals: 0 }]);
    assert.deepEqual(travel.catalog.hotel!.moneyFields, [{ path: 'nightlyFrom', decimals: 0 }]);
    assert.equal(travel.catalog.route!.retrieval, true);
    assert.equal(travel.catalog.hotel!.retrieval, false);

    const runtime = createFixtureRuntime();
    assert.doesNotThrow(() => validatePackCatalog(fixture, runtime));
    const widget = runtime.catalog.widget!;
    const sample = { id: 'w-sample', title: '合成方盒', unitPrice: 12, unit: '件', tags: ['合成'] };
    assert.ok(widget.schema.safeParse(sample).success);
    for (const payload of [
      { ...sample, extra: true },
      { ...sample, unitPrice: 3.655 },
      { ...sample, unitPrice: 0 },
      { ...sample, unit: '台' },
      { ...sample, tags: [''] },
      { ...sample, title: '' },
    ]) {
      assert.equal(widget.schema.safeParse(payload).success, false);
      assert.ok(checkItem(fixture.entities[0]!, payload).required.length > 0 || Object.hasOwn(payload, 'extra'));
    }
    assert.deepEqual(widget.moneyFields, [{ path: 'unitPrice', decimals: 2 }]);
    assert.ok(widget.schema.safeParse({ ...sample, unitPrice: 3.65 }).success);

    const reject = (catalog: Record<string, CatalogKindSpec>, kind: string, reason: string): void => {
      assert.throws(
        () => validatePackCatalog(fixture, { catalog }),
        (error: unknown) =>
          error instanceof Error && error.message.includes(fixture.id) && error.message.includes(kind) && error.message.includes(reason),
      );
    };
    reject({}, 'widget', 'entities');
    reject({ widget, hotel: { ...widget, retrieval: false } }, 'hotel', 'entities');
    reject({ widget: { ...widget, moneyFields: [] } }, 'widget', 'moneyFields');
    reject({ widget: { ...widget, moneyFields: [{ path: 'wrongPrice', decimals: 0 }] } }, 'widget', 'moneyFields');
    reject({ widget: { ...widget, moneyFields: [{ path: 'unitPrice', decimals: 0 }] } }, 'widget', 'moneyFields');
    reject({ widget: { ...widget, moneyFields: [...widget.moneyFields, ...widget.moneyFields] } }, 'widget', 'moneyFields');

    // 同名 hotel 只存在于自测副本；生产的证明包仍仅登记 widget。第 4 步可沿用此构造测 CSV 隔离。
    const hotelEntity = { ...fixture.entities[0]!, kind: 'hotel' };
    const testPack: IndustryPack = { ...fixture, entities: [...fixture.entities, hotelEntity] };
    const hotel = { ...widget, retrieval: false };
    const testRuntime = { ...runtime, catalog: { widget, hotel } };
    assert.doesNotThrow(() => validatePackCatalog(testPack, testRuntime));
    assert.notEqual(hotel.schema, CATALOG_SCHEMAS.hotel);
    assert.ok(hotel.schema.safeParse(sample).success);
    assert.equal(CATALOG_SCHEMAS.hotel.safeParse(sample).success, false);
    assert.throws(
      () => validatePackCatalog(testPack, { catalog: { widget, hotel: { ...hotel, retrieval: true } } }),
      (error: unknown) => error instanceof Error && /__fixture.*widget.*hotel.*retrieval/.test(error.message),
    );
    assert.doesNotThrow(() => validatePackCatalog(testPack, { catalog: { widget: { ...widget, retrieval: false }, hotel } }));

    // money 路径含对象、嵌套数组；顺序不影响逐项匹配，数组的 [] 不能丢。
    const money: FieldDef = { key: 'unitPrice', type: 'money', label: '单价', group: '' };
    const nestedEntity = {
      ...fixture.entities[0]!,
      fields: [
        money,
        { ...money, key: 'pricing.base' },
        {
          key: 'tiers',
          type: 'subItems' as const,
          label: '阶梯',
          group: '',
          item: [money, { key: 'extras', type: 'subItems' as const, label: '附加', group: '', item: [money] }],
        },
      ],
    };
    const nestedPack = { ...fixture, entities: [nestedEntity] };
    const moneyFields = ['tiers[].extras[].unitPrice', 'tiers[].unitPrice', 'pricing.base', 'unitPrice'].map((path) => ({
      path,
      decimals: 0 as const,
    }));
    assert.doesNotThrow(() => validatePackCatalog(nestedPack, { catalog: { widget: { ...widget, moneyFields } } }));
    assert.throws(
      () =>
        validatePackCatalog(nestedPack, {
          catalog: { widget: { ...widget, moneyFields: moneyFields.map((f) => ({ ...f, path: f.path.replaceAll('[]', '') })) } },
        }),
      /__fixture.*widget.*moneyFields/,
    );

    const registered = runtimeById(fixture.id, packSources());
    if (process.env.PACK_FIXTURES === '1') {
      assert.ok(PACK_IDS.includes(fixture.id));
      assert.deepEqual(Object.keys(registered!.catalog), ['widget']);
      assert.deepEqual(
        packById(fixture.id)!.entities.map((entity) => entity.kind),
        ['widget'],
      );
    } else {
      assert.ok(!PACK_IDS.includes(fixture.id));
      assert.equal(packById(fixture.id), null);
      assert.equal(registered, null);
    }
    assert.deepEqual(Object.keys(runtime.catalog), ['widget']);
    console.log(
      `PACK CATALOG PASS：PACK_FIXTURES=${process.env.PACK_FIXTURES ?? '未设'}；旅游引用、widget strict schema、三项拒绝、嵌套 money 路径、测试专用 hotel`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
