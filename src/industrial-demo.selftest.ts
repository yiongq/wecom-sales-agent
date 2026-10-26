// 10 R16：演示数据离线验收，全部合成；不创建线上租户。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PartSchema, priceLine, partCatalog, type Part } from './packs/industrial/catalog.js';
import { industrial, partEntity } from './packs/industrial/console-pack.js';
import { createIndustrialRuntime } from './packs/industrial/runtime.js';
import { defaultIndustrialPolicy } from './packs/industrial/policy.js';
import { matchInMemory } from './packs/industrial/match.js';
import { prepareCatalogCsv, csvLabelsOf } from './shared/catalog-csv.js';
import { checkItem, type LineOrder, type TurnToolContext } from './core/pack-api.js';

const parts = JSON.parse(fs.readFileSync('data/packs/industrial/catalog/part.json', 'utf8')).map((p: unknown) =>
  PartSchema.parse(p),
) as Part[];
const csv = fs.readFileSync('data/packs/industrial/catalog/part.csv', 'utf8');
const imported = prepareCatalogCsv('part', csv, csvLabelsOf(partEntity), PartSchema, 'industrial');
const canonical = (rows: readonly unknown[]) =>
  rows
    .map((p) => PartSchema.parse(p))
    .map((p) => ({ ...p, aliases: p.aliases ?? [], substitutes: p.substitutes ?? [], certs: p.certs ?? [] }))
    .toSorted((a, b) => String(a.id).localeCompare(String(b.id)));
assert.equal(parts.length, 40);
assert.deepEqual(canonical(imported), canonical(parts));
assert.deepEqual(
  Object.fromEntries(['轴承', '紧固件', '气动元件', '低压电器'].map((c) => [c, parts.filter((p) => p.category === c).length])),
  { 轴承: 10, 紧固件: 10, 气动元件: 10, 低压电器: 10 },
);
assert.ok(parts.every((p) => p.brand === '衡石工业品' && p.certs?.includes('合成演示数据')));
assert.ok(parts.some((p) => p.substitutes?.length) && parts.some((p) => !p.substitutes?.length));
assert.ok(parts.some((p) => p.stock === 0) && parts.some((p) => p.stock > 0));
for (const p of parts) {
  assert.deepEqual(checkItem(partEntity, p).required, []);
  assert.equal(matchInMemory(p.partNo, parts).parts[0]!.id, p.id);
  for (const alias of p.aliases ?? []) assert.equal(matchInMemory(alias, parts).parts[0]!.id, p.id);
}
const samples: number[] = [];
for (let n = 0; n < 1000; n++) {
  const start = performance.now();
  for (let i = 0; i < 30; i++) {
    const p = parts[i]!;
    const found = matchInMemory(i % 3 === 0 ? p.partNo : i % 3 === 1 ? p.aliases![0]! : '6205', parts);
    for (const item of found.parts) priceLine(item, Math.max(item.moq, 20));
  }
  samples.push(performance.now() - start);
}
const p95 = samples.toSorted((a, b) => a - b)[949]!;
assert.ok(p95 < 50, `p95=${p95}`);
console.log(
  `INDUSTRIAL DEMO MEMORY PASS: 40条/30行/1000批 p95=${p95.toFixed(3)}ms，${process.version} ${process.platform}/${process.arch}`,
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-demo-'));
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
const { withTenant } = await import('./db/client.js');
const { readCatalogVersions } = await import('./db/repo/catalog-versions.js');
const { createToolRegistry } = await import('./core/tools/registry.js');
const { approveQuote } = await import('./payment/orders.js');
const { setReplyTransport } = await import('./handoff/takeover.js');
const db = await testing.openTestDb();
try {
  await testing.installSeededConfig(db);
  const original = rt.config.loaded!;
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  await db.pg.exec('RESET ROLE');
  const runtime = createIndustrialRuntime(config.packSources());
  const tenant = await insertTenant(db.db, {
    slug: 'industrial-demo-test',
    name: '合成演示验收',
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
  const fx = await testing.installPgSessionStore(db, { slug: tenant.slug, varDir: dir });
  await store.initSessionStore(fx.deps);
  const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  const drafts = await catalog.importCatalogCsv(ctx, 'part', csv, csvLabelsOf(partEntity));
  assert.equal(drafts.length, 40);
  assert.ok(drafts.every((p) => p.status === 'draft'));
  assert.equal(config.currentCatalog().items.part, undefined);
  // CSV 按依赖顺序排列：先上架替代目标，再上架引用它的产品，不绕开跨条目校验。
  for (const p of parts) {
    const draft = drafts.find((d) => d.code === p.id)!;
    const active = await catalog.activateCatalogItem(ctx, 'part', p.id, { rev: draft.rev });
    assert.equal(active.status, 'active');
  }
  const rows = await catalog.listCatalog(ctx, 'part');
  assert.equal(rows.length, 40);
  assert.ok(rows.every((p) => p.status === 'active'));
  assert.deepEqual(canonical(rows.map((r) => r.payload)), canonical(parts));
  for (const p of parts) {
    assert.deepEqual(partCatalog.crossItemCheck!(p, config.currentCatalog()), []);
    assert.deepEqual((await catalog.getCatalogItem(ctx, 'part', p.id))!.payload, rows.find((r) => r.code === p.id)!.payload);
  }
  for (const field of partEntity.fields.filter((f) => f.type === 'money')) assert.equal(field.decimals, 2);

  const s = store.getOrCreateSession('wecom:wmDemoRfq', 'wecom');
  const tools = createToolRegistry(runtime.tools);
  const tc: TurnToolContext = { session: s, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false };
  const quote = async () => JSON.parse(await tools.execute('quote_items', { items: [{ query: '6205 2rs', qty: 2 }] }, tc));
  assert.equal((await quote()).total, 20);
  const built = await createLineOrder(s, [{ kind: 'part', code: 'bearing-02', qty: 2 }], { approval: true });
  assert.ok('order' in built);
  assert.equal(built.order.approval?.state, 'pending');
  setReplyTransport(async () => true);
  await approveQuote(built.order.id, { userId: null, name: '合成主管', role: 'supervisor' });
  const approved = store.getAnyOrder(built.order.id) as LineOrder;
  assert.equal(approved.approval?.state, 'approved');
  const frozen = structuredClone(approved);
  const before = rows.find((r) => r.code === 'bearing-02')!;
  await catalog.updateCatalogItem(ctx, 'part', before.code, { rev: before.rev, set: { unitPrice: 10.25 } });
  const versions = await withTenant(db.db, ctx, readCatalogVersions);
  assert.equal(versions.filter((v) => v.code === before.code).length, 2);
  assert.equal((config.catalogItemAt('part', before.code, 1) as Part).unitPrice, 10);
  assert.equal((config.catalogItemAt('part', before.code, 2) as Part).unitPrice, 10.25);
  assert.equal((await quote()).total, 20.5);
  assert.deepEqual(store.getAnyOrder(approved.id), frozen, '改价不改变已批准订单任何字段');
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  console.log('INDUSTRIAL DEMO PASS: JSON/CSV语义相同、四类各10条、40草稿→上架→列表/详情、全量匹配、改价新版本20→20.5元、已批准20元不变');
} finally {
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  rt.store.pgBackend?.close();
  rt.store.pgBackend = null;
  await config.closeConfig();
  config.__configTest.reset();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
