import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { LineOrder, TurnToolContext } from './core/pack-api.js';
import { industrial } from './packs/industrial/console-pack.js';
import { defaultIndustrialPolicy } from './packs/industrial/policy.js';
import { createIndustrialRuntime } from './packs/industrial/runtime.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-catalog-'));
Object.assign(process.env, { VAR_DIR: dir, CONFIG_SOURCE: 'file', LLM_MOCK: '1', SERVER_SELFTEST: '1' });
const { hostRuntime, withoutTenantScope, identifyRuntime } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
const rt = hostRuntime();
enterTenantScopeForTest(rt);
const testing = await withoutTenantScope(() => import('./db/testing.js'));
const config = await import('./config/source.js');
const catalog = await import('./config/catalog.js');
const store = await import('./store.js');
await import('./core/engine/sources.js');
const { bindPack, createLineOrder } = await import('./core/pack-api.js');
const { insertTenant } = await import('./db/repo/tenants.js');
const { withTenant, openDb } = await import('./db/client.js');
const { readCatalogVersions } = await import('./db/repo/catalog-versions.js');
const { createToolRegistry } = await import('./core/tools/registry.js');
const { csvLabelsOf } = await import('./shared/catalog-csv.js');
const t = await testing.openTestDb();
const payload = (id: string, partNo: string) => ({
  id,
  partNo,
  name: '合成轴承',
  brand: '合成品牌',
  category: '轴承',
  specs: ['内径25mm'],
  unit: '件',
  unitPrice: 3.65,
  moq: 2,
  stock: 100,
  leadDays: 7,
});
try {
  await testing.installSeededConfig(t);
  const original = rt.config.loaded!;
  await t.pg.exec('RESET ROLE');
  const runtime = createIndustrialRuntime(config.packSources());
  const tenant = await insertTenant(t.db, {
    slug: 'industrial-test',
    name: '合成工业租户',
    packId: 'industrial',
    locale: 'zh-CN',
    region: 'CN',
    brand: runtime.defaultBrand,
  });
  identifyRuntime(rt, {
    id: tenant.id,
    slug: tenant.slug,
    kind: rt.kind,
    isHost: rt.isHost,
    publicBase: rt.publicBase,
    expiresAt: rt.expiresAt,
  });
  rt.config.loaded = {
    ...original,
    tenantId: tenant.id,
    pack: industrial,
    sop: { ...original.sop, policy: defaultIndustrialPolicy },
    deps: { ...original.deps, tenantSlug: tenant.slug },
    catalog: { tenantId: tenant.id, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
    ords: {},
    history: new Map(),
  };
  bindPack(runtime, runtime.defaultBrand);
  const fx = await testing.installPgSessionStore(t, { slug: tenant.slug, varDir: dir });
  await store.initSessionStore(fx.deps);
  const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  const csv =
    '零件编号,型号,品名,品牌,类别,规格,单位,基础单价,起订量,现货数量,交期天数\npart-a,6205-2RS,合成轴承,合成品牌,轴承,内径25mm,件,3.65,2,100,7';
  const [a] = await catalog.importCatalogCsv(ctx, 'part', csv, csvLabelsOf(industrial.entities[0]!));
  assert.equal(a!.status, 'draft');
  assert.equal(config.currentCatalog().items.part, undefined);
  const duplicate = await catalog.createCatalogItem(ctx, 'part', { ...payload('duplicate', '6205 2rs'), substitutes: ['not-yet'] });
  const saved = await catalog.updateCatalogItem(ctx, 'part', duplicate.code, { rev: duplicate.rev, set: { aliases: ['future'] } });
  assert.equal(saved.status, 'draft', '草稿的重复型号与不存在的替代型号允许保存');
  const active = await catalog.activateCatalogItem(ctx, 'part', a!.code, { rev: a!.rev });
  const invalid = (field: string) => (error: unknown) =>
    error instanceof catalog.CatalogValidationError && error.issues.some((issue) => issue.path === field);
  await assert.rejects(catalog.activateCatalogItem(ctx, 'part', duplicate.code, { rev: saved.rev }), invalid('partNo'));
  const broken = await catalog.createCatalogItem(ctx, 'part', { ...payload('broken', '6300'), substitutes: ['missing'] });
  await assert.rejects(catalog.activateCatalogItem(ctx, 'part', broken.code, { rev: broken.rev }), invalid('substitutes'));
  const b = await catalog.createCatalogItem(ctx, 'part', { ...payload('part-b', '6301'), substitutes: ['6205 2rs'] });
  const activeB = await catalog.activateCatalogItem(ctx, 'part', b.code, { rev: b.rev });
  await assert.rejects(
    catalog.updateCatalogItem(ctx, 'part', b.code, { rev: activeB.rev, set: { aliases: ['6205 2rs'] } }),
    invalid('aliases'),
  );
  await assert.rejects(
    catalog.updateCatalogItem(ctx, 'part', b.code, { rev: activeB.rev, set: { substitutes: ['missing'] } }),
    invalid('substitutes'),
  );
  await assert.rejects(
    catalog.updateCatalogItem(ctx, 'part', b.code, { rev: activeB.rev, set: { tier2Qty: 2, tier2Price: 3 } }),
    invalid('tier2Qty'),
  );
  for (const field of ['partNo', 'category', 'unit'])
    await assert.rejects(
      catalog.updateCatalogItem(ctx, 'part', b.code, { rev: activeB.rev, set: { [field]: 'changed' } }),
      catalog.CatalogLockedFieldError,
    );
  const s = store.getOrCreateSession('wecom:wmIndCat', 'wecom');
  const toolCtx: TurnToolContext = { session: s, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false };
  const tools = createToolRegistry(runtime.tools);
  const first = JSON.parse(await tools.execute('create_quote_sheet', { items: [{ code: a!.code, qty: 10, amount: 0 }] }, toolCtx));
  assert.deepEqual(first, { state: 'pending' });
  assert.equal(s.orderIds.length, 1);
  const order = store.getAnyOrder(s.orderIds[0]!) as LineOrder;
  assert.equal(order.totalFen, 3650);
  assert.equal(order.approval!.state, 'pending');
  const ids = [...s.orderIds];
  assert.deepEqual(JSON.parse(await tools.execute('create_quote_sheet', { items: [{ code: a!.code, qty: 10 }] }, toolCtx)), {
    state: 'pending',
  });
  assert.deepEqual(s.orderIds, ids);
  const countJobs = async () => (await t.pg.query<{ n: number }>('select count(*)::int as n from jobs')).rows[0]!.n;
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  const jobsBefore = await countJobs();
  assert.deepEqual(JSON.parse(await tools.execute('create_quote_sheet', { items: [] }, toolCtx)), {
    rejected: [{ code: '', reason: 'empty_lines' }],
  });
  assert.deepEqual(
    JSON.parse(
      await tools.execute(
        'create_quote_sheet',
        {
          items: [
            { code: 'missing', qty: 1 },
            { code: a!.code, qty: 0 },
            { code: a!.code, qty: 1 },
          ],
        },
        toolCtx,
      ),
    ),
    {
      rejected: [
        { code: 'missing', reason: 'item_inactive' },
        { code: a!.code, reason: 'invalid_qty' },
        { code: a!.code, reason: 'below_moq', moq: 2 },
      ],
    },
  );
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  assert.equal(await countJobs(), jobsBefore);
  assert.deepEqual(s.orderIds, ids);
  const originalPriceLine = runtime.priceLine;
  try {
    for (const fail of [
      () => ({ reject: 'future_reason', detail: { internal: 'private' } }),
      () => ({ reject: 'below_moq', detail: {} }),
      () => {
        throw new Error('合成配置异常');
      },
    ]) {
      runtime.priceLine = fail;
      await assert.rejects(tools.execute('create_quote_sheet', { items: [{ code: a!.code, qty: 10 }] }, toolCtx));
      assert.deepEqual(s.orderIds, ids);
      assert.deepEqual((await store.drainStore(5000)).undrained, []);
      assert.equal(await countJobs(), jobsBefore);
    }
  } finally {
    runtime.priceLine = originalPriceLine;
  }
  const lastQuoteId = s.packState!.lastQuoteId;
  assert.deepEqual(JSON.parse(await tools.execute('create_quote_sheet', { items: [{ code: a!.code, qty: 1.5 }] }, toolCtx)), {
    rejected: [{ code: a!.code, reason: 'invalid_qty' }],
  });
  assert.equal(s.packState!.lastQuoteId, lastQuoteId);
  const changed = await catalog.updateCatalogItem(ctx, 'part', a!.code, { rev: active.rev, set: { unitPrice: 4.25 } });
  assert.equal((changed.payload as unknown as { unitPrice: number }).unitPrice, 4.25);
  const versions = await withTenant(t.db, ctx, readCatalogVersions);
  assert.equal(versions.filter((version) => version.code === a!.code).length, 2);
  assert.equal((config.catalogItemAt('part', a!.code, 1) as { unitPrice: number }).unitPrice, 3.65);
  assert.equal((config.catalogItemAt('part', a!.code, 2) as { unitPrice: number }).unitPrice, 4.25);
  assert.equal(order.totalFen, 3650);
  const next = await createLineOrder(s, [{ kind: 'part', code: a!.code, qty: 10 }], { approval: true });
  assert.ok('order' in next);
  assert.equal(next.order.totalFen, 4250);
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  const bulk = store.getOrCreateSession('wecom:wmIndBulk', 'wecom');
  const bulkCtx = { ...toolCtx, session: bulk };
  const bulkItems = Array.from({ length: 30 }, () => ({ code: a!.code, qty: 2 }));
  assert.deepEqual(JSON.parse(await tools.execute('create_quote_sheet', { items: bulkItems }, bulkCtx)), { state: 'pending' });
  const bulkOrder = store.getAnyOrder(bulk.orderIds[0]!) as LineOrder;
  assert.equal(bulkOrder.lines.length, 30);
  assert.equal(bulkOrder.totalFen, 25500);
  await assert.rejects(tools.execute('create_quote_sheet', { items: [...bulkItems, bulkItems[0]!] }, bulkCtx));
  assert.equal(bulk.orderIds.length, 1);
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  await t.pg.exec('RESET ROLE');
  await assert.rejects(t.pg.query("update catalog_items set status='draft' where tenant_id=$1 and code=$2", [tenant.id, a!.code]));
  console.log('INDUSTRIAL CATALOG PASS: CSV草稿、上架/编辑active跨条目422、锁定与禁下架、版本和冻结金额、待审保密/复用、拒绝不建单/通知');
  // 真正的工具 → 知识库 → embedding 路径；只替换 HTTP 边界，无外部连接。
  const retrieval = await import('./core/retrieval.js');
  const originalFetch = globalThis.fetch;
  let requests = 0;
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:1';
  process.env.EMBED_API_KEY = 'synthetic';
  process.env.LLM_MOCK = '';
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:1\/embeddings$/);
    requests++;
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(
      JSON.stringify({
        data: input.map((text) => ({ embedding: text.includes('6205') || text.includes('25 内径') ? [1, 0] : [0, 1] })),
        usage: { prompt_tokens: input.length },
      }),
      { status: 200 },
    );
  };
  try {
    retrieval.__retrievalTest.reset();
    await retrieval.buildIndex();
    assert.equal(retrieval.indexReady(), true);
    const samples: number[] = [];
    const startRequests = requests;
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const result = JSON.parse(await tools.execute('find_parts', { query: '25 内径的深沟球轴承' }, toolCtx));
      samples.push(performance.now() - start);
      assert.equal(result.match, 'ambiguous', '语义命中不能冒充精确型号');
      assert.ok(result.parts.some((part: { code: string }) => part.code === a!.code));
    }
    assert.equal(requests - startRequests, 20, '每次完整工具调用都包括查询 embedding');
    for (const query of ['9999-ZZ', '620']) {
      assert.deepEqual(JSON.parse(await tools.execute('find_parts', { query }, toolCtx)), { match: 'none', parts: [] });
    }
    assert.equal(JSON.parse(await tools.execute('find_parts', { query: '25mm' }, toolCtx)).match, 'ambiguous');
    console.log(
      `INDUSTRIAL SEMANTIC PASS: 工具+真实检索/embedding处理+HTTP桩，n=20 p95=${samples.toSorted((a, b) => a - b)[18]!.toFixed(3)}ms，${process.version} ${process.platform}/${process.arch} PGlite，无网络`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.LLM_MOCK = '1';
    retrieval.__retrievalTest.reset();
  }
  const handoff = store.getOrCreateSession('wecom:wmIndHuman', 'wecom');
  const beforeHandoffJobs = await countJobs();
  assert.equal(
    JSON.parse(await tools.execute('handoff_to_human', { reason: '合成询价需要顾问' }, { ...toolCtx, session: handoff })).ok,
    true,
  );
  assert.equal(handoff.handoff?.kind, 'model');
  assert.equal(handoff.handoff?.reason, '合成询价需要顾问');
  assert.ok(handoff.messages.some((message) => message.role === 'system' && message.content.includes('合成询价需要顾问')));
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  assert.ok((await countJobs()) > beforeHandoffJobs);
  if (process.env.PG_TEST_URL) {
    const real = await testing.createRealPgFixture(process.env.PG_TEST_URL);
    const pg = await openDb(real.urls.app);
    try {
      rt.config.loaded!.tenantId = real.tenantId;
      rt.config.loaded!.deps = { ...rt.config.loaded!.deps, db: pg.db };
      const realCtx = { ...ctx, tenantId: real.tenantId };
      const one = await catalog.createCatalogItem(realCtx, 'part', payload('race-a', '6205-2RS'));
      const two = await catalog.createCatalogItem(realCtx, 'part', payload('race-b', '6205 2rs'));
      const outcomes = await Promise.allSettled([
        catalog.activateCatalogItem(realCtx, 'part', one.code, { rev: one.rev }),
        catalog.activateCatalogItem(realCtx, 'part', two.code, { rev: two.rev }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      assert.ok(invalid('partNo')(rejected.reason));
      console.log('INDUSTRIAL REAL PG PASS: 配置锁串行化并发型号冲突，恰一张上架');
    } finally {
      await pg.close();
      await real.drop();
    }
  } else console.log('INDUSTRIAL REAL PG SKIP: 未设置 PG_TEST_URL，交CI一次性pgvector:pg17');
} finally {
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  rt.store.pgBackend?.close();
  rt.store.pgBackend = null;
  await config.closeConfig();
  config.__configTest.reset();
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
