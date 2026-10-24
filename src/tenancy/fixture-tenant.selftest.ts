// 08 第 1 步：证明包模板、参考配置与 PGlite 租户夹具；核心装载与发布留给后续步骤。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

if (process.argv[2] !== 'worker') {
  for (const enabled of [false, true]) {
    const env = { ...process.env };
    delete env.PACK_FIXTURES;
    if (enabled) env.PACK_FIXTURES = '1';
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    process.stdout.write(child.stdout);
  }
} else {
  const { PACK_IDS, packById, runtimeById } = await import('../packs/registry.js');
  const { packSources } = await import('../core/engine/sources.js');
  const { createFixtureTenant } = await import('./fixture-testing.js');
  if (process.env.PACK_FIXTURES !== '1') {
    assert.ok(!PACK_IDS.includes('__fixture'));
    assert.equal(packById('__fixture'), null);
    assert.equal(runtimeById('__fixture', packSources()), null);
    // 必须在碰库前拒绝，不允许静默造出未登记包的租户。
    await assert.rejects(createFixtureTenant(null!), /PACK_FIXTURES=1/);
    console.log('FIXTURE SKELETON PASS：未设 PACK_FIXTURES，注册表与租户辅助均拒绝证明包');
  } else {
    const { BrandProfileSchema, checkPack, checkItem, renderBrandTemplate } = await import('../core/pack-api.js');
    const { tenantImage, tenantRenderer } = await import('../config/brand.js');
    const { splitSop, joinSop } = await import('../sop/sections.js');
    const { checkSopContract } = await import('../sop/contract.js');
    const { openTestDb } = await import('../db/testing.js');
    const { findTenantBySlug, readBrand } = await import('../db/repo/tenants.js');
    const pack = packById('__fixture')!;
    assert.ok(pack);
    assert.deepEqual(checkPack(pack), []);
    const runtime = runtimeById(pack.id, packSources())!;
    assert.equal(runtime.id, pack.id);
    assert.deepEqual(
      runtime.stages,
      pack.stages.map(({ key }) => ({ id: key })),
    );
    assert.deepEqual(
      runtime.sopSections,
      pack.sopSections.map(({ key, heading, locked }) => ({ key, heading, locked })),
    );
    assert.deepEqual(pack.nav.entities, ['widget']);
    assert.equal(pack.entities.length, 1);
    const widget = pack.entities[0]!;
    assert.equal(widget.kind, 'widget');
    assert.equal(widget.csvImport, true);
    const sample = { id: 'w-sample', title: '合成方盒', unitPrice: 12, unit: '件', tags: ['合成'] };
    assert.deepEqual(checkItem(widget, sample).required, []);
    assert.ok(checkItem(widget, { ...sample, unitPrice: 3.655 }).required.some((i) => i.path === 'unitPrice'));

    const dir = new URL('../../data/packs/__fixture/', import.meta.url);
    const brandBytes = fs.readFileSync(new URL('brand.json', dir), 'utf8');
    const brand = BrandProfileSchema.parse(JSON.parse(brandBytes));
    assert.deepEqual(brand, runtime.defaultBrand);
    assert.equal(brandBytes, `${JSON.stringify(brand, null, 2)}\n`);
    const md = fs.readFileSync(new URL('sop.md', dir), 'utf8');
    const sections = splitSop(md, runtime.sopSections);
    assert.deepEqual(tenantImage(runtime, md, brand), sections);
    assert.equal(joinSop(sections), md);
    const locked = runtime.sopSections.filter((s) => s.locked);
    assert.ok(locked.length >= 2);
    assert.ok(runtime.sopSections.filter((s) => !s.locked).length >= 2);
    assert.deepEqual(Object.keys(runtime.templates.lockedSectionTemplates).sort(), locked.map((s) => s.key).sort());
    for (const spec of locked) {
      const text = renderBrandTemplate(runtime.templates.lockedSectionTemplates[spec.key]!, brand);
      assert.equal(text, sections.find((s) => s.key === spec.key)!.text);
      assert.ok(text.startsWith(`## ${spec.heading}\n\n`));
      assert.doesNotMatch(text, /\{[^{}]+\}/);
    }
    assert.equal(renderBrandTemplate(runtime.templates.preamble, brand), sections[0]!.text);
    for (const key of [
      'hardRequirements',
      'identityAnswer',
      'offTopicReply',
      'welcomeText',
      'welcomeBackText',
      'webWelcome',
      'mockOpening',
    ] as const) {
      const text = renderBrandTemplate(runtime.templates[key], brand);
      assert.ok(text.trim());
      assert.doesNotMatch(text, /\{[^{}]+\}/);
    }
    const render = tenantRenderer(runtime, brand);
    const base = {
      sections,
      imageSections: sections,
      rendered: render(md),
      toolNames: runtime.tools.map((t) => t.def.function.name),
      knownFields: runtime.knownFields.names,
      baselineEditableChars: null,
      spec: runtime.sopSections,
      rules: runtime.contractRules({ brand }),
      brand,
      hardRequirements: render(''),
      // 第 12 步才接 SOP 按包；这里显式传包规则，只验证骨架的可用性。
      policy: null,
      consistency: false,
    };
    assert.deepEqual(checkSopContract(base), []);
    const changed = sections.map((s) => (s.key === 'widget_reply' ? { ...s, text: s.text + '未经核验也保证可用\n\n' } : s));
    assert.deepEqual(
      checkSopContract({ ...base, sections: changed, rendered: render(joinSop(changed)) }).map((v) => [v.code, v.sectionKey, v.match]),
      [['phrase_forbidden', 'widget_reply', '未经核验也保证可用']],
    );

    const t = await openTestDb();
    try {
      const first = await createFixtureTenant(t.db);
      const second = await createFixtureTenant(t.db, { slug: 'fixture-next' });
      assert.notEqual(first.id, second.id);
      await t.pg.exec('SET ROLE agent_app');
      for (const row of [first, second]) {
        assert.equal((await findTenantBySlug(t.db, row.slug))!.packId, '__fixture');
        assert.deepEqual(await readBrand(t.db, row.id), runtime.defaultBrand);
      }
    } finally {
      await t.close();
    }
    console.log(
      `FIXTURE SKELETON PASS：PACK_FIXTURES=1，widget 元值金额字段、阶段/节表配对、${locked.length} 个锁定节、参考配置、契约反例、PGlite 双租户与品牌`,
    );
  }
}
