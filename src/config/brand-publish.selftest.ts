// 第 22 步：四条写路径、六种前言切换、待生效隔离和契约范围。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTestDb, testConfigDeps, fakeLock, createRealPgFixture } from '../db/testing.js';
import { withTenant, openDb } from '../db/client.js';
import { readPublishedSop } from '../db/repo/sop.js';
import { updateBrand } from '../db/repo/tenants.js';
import { importConfig } from './transfer.js';
import * as config from './source.js';
import * as sop from './sop.js';
import { tenantImage, tenantRenderer, preambleWarning } from './brand.js';
import { shanhaiBrand } from '../packs/travel/brand-fixture.js';
import { joinSop, sectionBody, withBody } from '../sop/sections.js';
import { checkSopContract } from '../sop/contract.js';
import { sha256 } from './hashes.js';
import type { BrandProfile } from '../core/pack-api.js';

const md = fs.readFileSync('data/sop.md', 'utf8');
const runtime = config.currentPack().runtime;
const other = { ...shanhaiBrand, brandName: '远山旅行', identityLine: '我是远山旅行的 AI 旅行顾问' };
const t = await openTestDb();
const logs: string[] = [];
const warn = console.warn;
console.warn = (...args) => {
  logs.push(args.join(' '));
  warn(...args);
};
let checks = 0;
function check(fn: () => void) {
  fn();
  checks++;
}

async function transition(before: BrandProfile | null, after: BrandProfile | null, edited: boolean, n: number, samePrompt = false) {
  config.__configTest.reset();
  const slug = `brand-${n}`;
  await t.pg.exec('RESET ROLE');
  await t.pg.query("insert into tenants (slug, name, pack_id, brand) values ($1, $1, 'travel', $2)", [slug, JSON.stringify(before)]);
  await t.pg.exec('SET ROLE agent_app');
  const deps = testConfigDeps(t, { tenantSlug: slug });
  const imported = await importConfig({ db: t.db, tenantSlug: slug, dataDir: 'data', imageSop: md, lock: async () => fakeLock() });
  assert.equal(imported.code, 0, imported.message);
  await config.initConfig(deps);
  const first = config.currentSop();
  const ctx = { tenantId: first.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  if (edited) {
    const draft = await sop.saveSopDraft(ctx, {
      basedOn: first.versionId,
      rev: null,
      edits: [{ key: 'preamble', body: first.sections.find((s) => s.key === 'preamble')!.text + '运营保留的品牌说明。' }],
    });
    await sop.publishSopDraft(ctx, { rev: draft.rev!, changeNote: '自测前言编辑' });
  }
  const old = config.currentSop();
  await t.pg.exec('RESET ROLE');
  await withTenant(t.db, { ...ctx, actor: { ...ctx.actor, kind: 'platform' } }, (tx) => updateBrand(tx, old.tenantId, after));
  await t.pg.exec('SET ROLE agent_app');
  check(() => assert.equal(config.currentSop(), old));
  check(() => assert.deepEqual(config.currentPack().brand, before));
  const rowBefore = await withTenant(t.db, ctx, (tx) => readPublishedSop(tx));
  check(() => assert.equal(rowBefore!.promptHash, old.promptHash));
  const logAt = logs.length;
  await config.closeConfig();
  config.__configTest.reset();
  await config.initConfig(deps);
  const next = config.currentSop();
  const image = tenantImage(runtime, md, after);
  const expected = edited ? old.sections.find((s) => s.key === 'preamble')!.text : image.find((s) => s.key === 'preamble')!.text;
  check(() => assert.equal(next.sections.find((s) => s.key === 'preamble')!.text, expected));
  check(() => assert.deepEqual(next.brand, after));
  check(() => assert.equal(next.promptHash === old.promptHash, samePrompt));
  check(() => assert.equal(next.versionNo, old.versionNo + 1));
  check(() => assert.equal(preambleWarning(next.sections, image), edited));
  check(() =>
    assert.equal(
      logs.slice(logAt).some((s) => s.includes('前言节里可能还有旧品牌名')),
      edited,
    ),
  );
  const overview = await sop.getSopOverview(ctx);
  check(() => assert.equal(overview.preambleWarning ?? false, edited));
  await t.pg.exec('RESET ROLE');
  const audits = await t.pg.query<{ diff: { causes: string[] } }>(
    "select diff from audit_log where tenant_id=$1 and action='sop.rerender'",
    [next.tenantId],
  );
  check(() => assert.equal(audits.rows.length, 1));
  check(() => assert.ok(audits.rows[0]!.diff.causes.includes('brand')));
  await t.pg.exec('SET ROLE agent_app');
  const row = (await withTenant(t.db, ctx, (tx) => readPublishedSop(tx)))!;
  check(() => assert.equal(row.renderInputs!.imageSopHash, sha256(joinSop(image))));
  check(() => assert.equal(row.renderInputs!.brandHash, next.brandHash));
  await config.closeConfig();
  config.__configTest.reset();
  await config.initConfig(deps);
  check(() => assert.equal(config.currentSop().versionNo, next.versionNo));
  if (!edited && before === shanhaiBrand && after === null) {
    check(() => assert.equal(next.promptHash, 'dd2c10ee4d4205c1938f7ebdd3a4258490828a146a30c9931c33e35872ffdd60'));
  }
  // 待生效配置再次改变；发布与跨品牌回滚继续使用启动捕获的镜像和品牌。
  await t.pg.exec('RESET ROLE');
  await withTenant(t.db, { ...ctx, actor: { ...ctx.actor, kind: 'platform' } }, (tx) => updateBrand(tx, next.tenantId, other));
  await t.pg.exec('SET ROLE agent_app');
  const draft = await sop.saveSopDraft(ctx, { basedOn: next.versionId, rev: null, edits: [] });
  const pub = await sop.publishSopDraft(ctx, { rev: draft.rev!, changeNote: '验证发布快照' });
  check(() => assert.deepEqual(config.currentSop().brand, after));
  check(() => assert.equal(pub.promptHash, next.promptHash));
  await sop.rollbackSop(ctx, { versionId: first.versionId, changeNote: '验证跨品牌回滚' });
  check(() => assert.deepEqual(config.currentSop().brand, after));
  for (const section of runtime.sopSections.filter((s) => s.locked)) {
    check(() =>
      assert.equal(config.currentSop().sections.find((s) => s.key === section.key)!.text, image.find((s) => s.key === section.key)!.text),
    );
  }
  // console 的锁定节保护仍生效。
  await assert.rejects(
    sop.saveSopDraft(ctx, { basedOn: config.currentSop().versionId, rev: null, edits: [{ key: 'handoff', body: '修改固定规则' }] }),
    sop.SopLockedSectionError,
  );
  checks++;
  await config.closeConfig();
}

try {
  let n = 0;
  for (const [before, after] of [
    [null, shanhaiBrand],
    [shanhaiBrand, other],
    [shanhaiBrand, null],
  ] as const)
    for (const edited of [false, true]) await transition(before, after, edited, ++n);
  await transition(shanhaiBrand, { ...shanhaiBrand, aiTitle: 'AI 定制顾问' }, false, ++n, true);
  const image = tenantImage(runtime, md, shanhaiBrand);
  const render = tenantRenderer(runtime, shanhaiBrand);
  const base = {
    sections: image,
    imageSections: image,
    rendered: render(joinSop(image)),
    toolNames: runtime.tools.map((t) => t.def.function.name),
    knownFields: runtime.knownFields.names,
    baselineEditableChars: null,
    rules: runtime.contractRules({ brand: shanhaiBrand }),
    brand: shanhaiBrand,
    hardRequirements: render(''),
  };
  check(() => assert.deepEqual(checkSopContract(base), []));
  check(() =>
    assert.doesNotMatch(
      image
        .filter((s) => runtime.sopSections.find((x) => x.key === s.key)!.locked)
        .map((s) => s.text)
        .join('') + render(''),
      /云途|微信/,
    ),
  );
  for (const [extra, code] of [
    ['明显超出我们现有线路的范围', 'phrase_forbidden'],
    ['search_unknown', 'unknown_tool'],
    ['wrongField', 'unknown_field'],
    ['## 新节', 'structure'],
  ] as const) {
    const changed = image.map((s) => (s.key === 'tone' ? { ...s, text: s.text + extra + '\n\n' } : s));
    check(() =>
      assert.ok(checkSopContract({ ...base, sections: changed, rendered: render(joinSop(changed)) }).some((v) => v.code === code)),
    );
  }
  check(() => assert.ok(checkSopContract({ ...base, baselineEditableChars: 1 }).some((v) => v.code === 'over_budget')));
  const spec = runtime.sopSections.find((s) => s.key === 'tone')!;
  const editableBrand = image.map((s) => (s.key === 'tone' ? withBody(spec, sectionBody(s, spec) + '云途微信', false) : s));
  check(() => assert.deepEqual(checkSopContract({ ...base, sections: editableBrand, rendered: render(joinSop(editableBrand)) }), []));
  check(() =>
    assert.ok(checkSopContract({ ...base, hardRequirements: render('') + '微信' }).some((v) => v.sectionKey === 'hard-requirements')),
  );
  console.log(`BRAND PUBLISH SELFTEST：${checks} 项通过（六种前言切换、四条写路径、契约范围）`);
} finally {
  console.warn = warn;
  await config.closeConfig();
  config.__configTest.reset();
  await t.close();
}

// 真实 PG 仅使用调用者为本次测试提供的一次性集群；缺省跳过。
if (process.env.PG_TEST_URL) {
  const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'brand-pg' });
  const app = await openDb(fx.urls.app);
  const platform = await openDb(fx.urls.platform);
  try {
    const tenantId = fx.tenantId;
    const deps = testConfigDeps({ db: app.db }, { tenantSlug: 'brand-pg' });
    const imported = await importConfig({
      db: app.db,
      tenantSlug: 'brand-pg',
      dataDir: 'data',
      imageSop: md,
      lock: async () => fakeLock(),
    });
    assert.equal(imported.code, 0, imported.message);
    await config.initConfig(deps);
    const initial = config.currentSop();
    const ctx = { tenantId, actor: { kind: 'platform' as const, userId: null, name: '自测', ip: null } };
    await withTenant(platform.db, ctx, (tx) => updateBrand(tx, tenantId, shanhaiBrand));
    assert.equal(config.currentSop(), initial);
    await config.closeConfig();
    config.__configTest.reset();
    await config.initConfig(deps);
    assert.deepEqual(config.currentSop().brand, shanhaiBrand);
    assert.notEqual(config.currentSop().promptHash, initial.promptHash);
    const rows = await fx.query<{ diff: { causes: string[] } }>("select diff from audit_log where tenant_id=$1 and action='sop.rerender'", [
      tenantId,
    ]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.diff.causes.includes('brand'));
    await config.closeConfig();
    config.__configTest.reset();
    await config.initConfig(deps);
    assert.equal(config.currentSop().versionNo, initial.versionNo + 1);
    console.log('BRAND PUBLISH REAL PG：重渲染、单次发布与原因 brand 审计通过');
  } finally {
    await config.closeConfig();
    config.__configTest.reset();
    await app.close();
    await platform.close();
    await fx.drop();
  }
} else console.log('BRAND PUBLISH REAL PG：未设 PG_TEST_URL，跳过');
