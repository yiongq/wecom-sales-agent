// 08 R10 第 12 步：SOP 子系统按包。
//   一、配置层不再 import 具体行业包；旅游的导入导出代码输入、契约违规、哈希输入与改动前逐项相同。
//   二、证明包租户（PGlite、DB 模式、模板模式）：首次发布、在 console 改一个可编辑节再发布、契约检查用证明包的规则、
//      启动重渲染不乱写版本、回滚、导出、沙箱模板复制；把品牌清掉之后以 brand_required 拒绝启动。
//   三、验收 3 第 5 条的端到端部分：没有 active 的 widget 以 catalog_startup 拒绝，上架一条后照常启动。
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
    timeout: 240_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-per-pack-'));
  process.env.VAR_DIR = dir;
  const { hostRuntime, withoutTenantScope } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const { openTestDb, installSeededConfig, testConfigDeps } = await withoutTenantScope(() => import('../db/testing.js'));
  const { createFixtureTenant } = await import('../tenancy/fixture-testing.js');
  const { runtimeById } = await import('../packs/registry.js');
  const source = await import('./source.js');
  const { initConfig, closeConfig, __configTest, ConfigStartupError, currentSop, currentCatalog, configRuntime, configDrift, packSources } =
    source;
  const { withTenant } = await import('../db/client.js');
  const { readPublishedSop, insertPublishedSop } = await import('../db/repo/sop.js');
  const { insertActiveItems, readActiveCatalog } = await import('../db/repo/catalog.js');
  const { insertCatalogVersion } = await import('../db/repo/catalog-versions.js');
  const { createUser } = await import('../auth/accounts.js');
  const { consoleApi } = await import('../console-api/app.js');
  const { editableChars, joinSop, mergeWithImage, sectionBody, splitSop, withBody, TRAVEL_SOP_SECTIONS } =
    await import('../sop/sections.js');
  const { checkSopContract, SOP_CONTRACT, SOP_KNOWN_FIELDS } = await import('../sop/contract.js');
  const { contractInputs, readImageSop, tenantImage, tenantRenderer } = await import('./brand.js');
  const { imageCode, exportConfig, writeTemplateConfig } = await import('./transfer.js');
  const sopApi = await import('./sop.js');
  const { promptHashes, publishedBrand, renderInputsFor, sha256 } = await import('./hashes.js');
  const { policyViolations } = await import('../packs/travel/policy-lint.js');
  const { defaultTravelPolicy } = await import('../packs/travel/policy.js');
  const { shanhaiBrand } = await import('../packs/travel/brand-fixture.js');
  const { toolDefs } = await import('../tool-defs.js');
  const { renderSystemPrompt } = await import('../prompt/system.js');
  const { sopConsistencyOf } = await import('../packs/registry.js');

  let checks = 0;
  const check = (fn: () => void): void => {
    fn();
    checks++;
  };
  const travelRuntime = runtimeById('travel', packSources())!;
  const fixtureRuntime = runtimeById('__fixture', packSources())!;
  const fixtureSpec = fixtureRuntime.sopSections;
  const travelMd = fs.readFileSync('data/sop.md', 'utf8');
  const fixtureMd = fs.readFileSync('data/packs/__fixture/sop.md', 'utf8');

  // ---------------- 一、配置层不再 import 具体行业包 ----------------
  const configDir = import.meta.dirname;
  for (const file of fs.readdirSync(configDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.selftest.ts'))) {
    const text = fs.readFileSync(path.join(configDir, file), 'utf8');
    check(() => assert.doesNotMatch(text, /from '\.\.\/packs\/(travel|__fixture)\//, `${file} 不能 import 具体行业包`));
  }
  check(() => assert.doesNotMatch(fs.readFileSync(path.join(configDir, 'source.ts'), 'utf8'), /policy-lint/));

  // ---------------- 二、旅游不变：导入导出的代码输入与契约违规 ----------------
  {
    // imageCode 从包的运行时派生，字节与改动前取模块常量时相同
    const code = imageCode(travelRuntime);
    check(() => assert.equal(code.toolsJson, JSON.stringify(toolDefs)));
    check(() =>
      assert.deepEqual(
        code.toolNames,
        toolDefs.map((t) => t.function.name),
      ),
    );
    check(() => assert.deepEqual(code.knownFields, SOP_KNOWN_FIELDS));
    for (const sop of [travelMd, '']) check(() => assert.equal(code.render(sop), renderSystemPrompt(sop)));

    // policy lint 经 PackPolicy.lint，旅游的实现就是 policyViolations
    const lint = travelRuntime.policy!.lint!;
    const sections = splitSop(travelMd, travelRuntime.sopSections);
    const badPolicy = { ...structuredClone(defaultTravelPolicy), refund: {} };
    check(() => assert.deepEqual(lint(defaultTravelPolicy, sections), policyViolations(defaultTravelPolicy, sections)));
    check(() => assert.deepEqual(lint(badPolicy), policyViolations(badPolicy)));
    check(() => assert.equal(lint(badPolicy)[0]?.code, 'policy_invalid'));
    check(() => assert.equal(fixtureRuntime.policy, undefined));

    const legacy = contractInputs(travelRuntime, null, defaultTravelPolicy);
    check(() => assert.equal(legacy.spec, travelRuntime.sopSections));
    check(() => assert.deepEqual(legacy.rules, SOP_CONTRACT));
    check(() => assert.equal(typeof legacy.consistency, 'function'));
    check(() => assert.equal(legacy.policy?.lint, lint));
    // 旧品牌名收进旅游包的模板模式规则，旧版模式没有
    const branded = contractInputs(travelRuntime, shanhaiBrand, defaultTravelPolicy);
    check(() =>
      assert.deepEqual(
        branded.rules.filter((r) => r.id.startsWith('brand-fixed:')).map((r) => [r.id, r.kind, r.kind === 'exclude' ? r.text : '']),
        [['brand-fixed:legacy-brand', 'exclude', '云途']],
      ),
    );
    check(() => assert.equal(branded.rules.length, SOP_CONTRACT.length + 1));

    // 模板模式的违规：与改动前逐条相同（旧品牌名只在代码所有的固定内容里禁，渠道名照旧）
    const image = tenantImage(travelRuntime, travelMd, shanhaiBrand);
    const render = tenantRenderer(travelRuntime, shanhaiBrand);
    const toolNames = travelRuntime.tools.map((t) => t.def.function.name);
    const base = {
      sections: image,
      imageSections: image,
      rendered: render(joinSop(image)),
      toolNames,
      knownFields: travelRuntime.knownFields.names,
      baselineEditableChars: null,
      ...branded,
      hardRequirements: render(''),
    };
    const brief = (vs: ReturnType<typeof checkSopContract>): string[] => vs.map((v) => `${v.code}@${v.sectionKey}:${v.match ?? ''}`);
    check(() => assert.deepEqual(checkSopContract(base), []));
    const lockedKey = travelRuntime.sopSections.find((s) => s.locked)!.key;
    const polluted = image.map((s) => (s.key === lockedKey ? { ...s, text: `${s.text}云途 微信 WeCom 企微\n\n` } : s));
    check(() =>
      assert.deepEqual(brief(checkSopContract({ ...base, sections: polluted, rendered: render(joinSop(polluted)) })), [
        `locked_changed@${lockedKey}:`,
        `phrase_forbidden@${lockedKey}:云途`,
        `phrase_forbidden@${lockedKey}:微信`,
        `phrase_forbidden@${lockedKey}:WeCom`,
        `phrase_forbidden@${lockedKey}:企微`,
      ]),
    );
    check(() =>
      assert.deepEqual(brief(checkSopContract({ ...base, hardRequirements: `${render('')}云途` })), [
        'phrase_forbidden@hard-requirements:云途',
      ]),
    );
    const toneSpec = travelRuntime.sopSections.find((s) => s.key === 'tone')!;
    const editedBrand = image.map((s) => (s.key === 'tone' ? withBody(toneSpec, `${sectionBody(s, toneSpec)}云途微信`, false) : s));
    check(() => assert.deepEqual(checkSopContract({ ...base, sections: editedBrand, rendered: render(joinSop(editedBrand)) }), []));
    // 显式配成旧品牌仍是模板模式：档案自己的品牌名不算违规
    const oldBrand = { ...shanhaiBrand, brandName: '云途定制旅行', identityLine: '我是云途定制旅行的 AI 旅行顾问' };
    const oldImage = tenantImage(travelRuntime, travelMd, oldBrand);
    const oldRender = tenantRenderer(travelRuntime, oldBrand);
    check(() =>
      assert.deepEqual(
        checkSopContract({
          ...base,
          sections: oldImage,
          imageSections: oldImage,
          rendered: oldRender(joinSop(oldImage)),
          ...contractInputs(travelRuntime, oldBrand, defaultTravelPolicy),
          hardRequirements: oldRender(''),
        }),
        [],
      ),
    );
    // 旧版模式没有品牌专属检查：锁定节里的这些词只报与镜像不一致
    const legacyImage = splitSop(travelMd, travelRuntime.sopSections);
    const legacyPolluted = legacyImage.map((s) => (s.key === lockedKey ? { ...s, text: `${s.text}云途 微信\n\n` } : s));
    check(() =>
      assert.deepEqual(
        brief(
          checkSopContract({
            sections: legacyPolluted,
            imageSections: legacyImage,
            rendered: renderSystemPrompt(joinSop(legacyPolluted)),
            toolNames,
            knownFields: travelRuntime.knownFields.names,
            baselineEditableChars: null,
            ...legacy,
          }),
        ),
        [`locked_changed@${lockedKey}:`],
      ),
    );
    // 一致性检查按包取：旅游有，证明包没登记所以没有
    check(() => assert.equal(sopConsistencyOf(travelRuntime), legacy.consistency));
    check(() => assert.equal(sopConsistencyOf(fixtureRuntime), null));
    // 登记了 sop 范围的规则但不是旅游：没有对应的检查实现，也不拿旅游的去比
    check(() => assert.equal(sopConsistencyOf({ id: '__other', consistencyRules: travelRuntime.consistencyRules }), null));
    // 节表必传；哈希的节表参数取包
    const inputsOf = (spec: typeof TRAVEL_SOP_SECTIONS) => renderInputsFor(render, '', '[]', spec, null);
    check(() => assert.equal(inputsOf(travelRuntime.sopSections).sectionTableHash, sha256(JSON.stringify(TRAVEL_SOP_SECTIONS))));
    check(() => assert.notEqual(inputsOf(fixtureSpec).sectionTableHash, inputsOf(travelRuntime.sopSections).sectionTableHash));
  }

  // 旅游用提前读好的 deps.imageSop；非旅游包永远读自己的参考配置，不用旅游的文本
  check(() => assert.equal(source.imageSopOf({ imageSop: travelMd }, '__fixture'), fixtureMd));
  check(() => assert.equal(source.imageSopOf({ imageSop: travelMd }, 'travel'), travelMd));
  check(() => assert.equal(readImageSop('__fixture'), fixtureMd));
  check(() => assert.throws(() => readImageSop('../travel'), /不合法/));

  /** 在没有 data/ 的空目录里跑 fn（镜像文件按进程的当前目录找），跑完回到原目录 */
  const inEmptyDir = async <T>(fn: () => Promise<T>): Promise<T> => {
    const origin = process.cwd();
    process.chdir(fs.mkdtempSync(path.join(dir, 'empty-cwd-')));
    try {
      return await fn();
    } finally {
      process.chdir(origin);
    }
  };
  // 旅游的启动顺序不变：生产路径在连库之前读并校验 data/sop.md。镜像缺失与连不上库同时发生时，报 image_sop_invalid 而不是 db_unreachable
  {
    const env = { DATABASE_URL: 'postgres://app@127.0.0.1:1/none', DEFAULT_TENANT_SLUG: 'demo', DEPLOY_PROFILE: 'demo' };
    await inEmptyDir(async () => {
      await assert.rejects(
        source.productionConfigDeps(env, () => {}),
        (e: unknown) => {
          assert.ok(e instanceof ConfigStartupError, String(e));
          assert.equal(e.reason, 'image_sop_invalid');
          assert.match(e.detail, /data\/sop\.md/);
          return true;
        },
      );
      checks++;
    });
    // 对照：镜像在，同一个连不上的地址不再是 image_sop_invalid（连库是后面的事）
    const outcome = await source
      .productionConfigDeps(env, () => {})
      .then(
        async (deps) => {
          await deps.closeDb?.().catch(() => {});
          assert.equal(deps.imageSop, travelMd);
          return 'ok';
        },
        (e: unknown) => (e instanceof ConfigStartupError ? e.reason : String(e)),
      );
    check(() => assert.notEqual(outcome, 'image_sop_invalid'));
  }

  // ---------------- 三、DB 模式 ----------------
  const t = await openTestDb();
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
    log(...args);
  };
  try {
    // 旅游无品牌（旧版模式）照常启动，不受 brand_required 影响；节表哈希是旅游的
    await installSeededConfig(t);
    const demo = currentSop();
    check(() => assert.equal(demo.brand, null));
    const demoCtx = { tenantId: demo.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const demoRow = await withTenant(t.db, demoCtx, readPublishedSop);
    check(() => assert.equal(demoRow!.renderInputs!.sectionTableHash, sha256(JSON.stringify(TRAVEL_SOP_SECTIONS))));
    check(() => assert.equal(demoRow!.promptHash, sha256(renderSystemPrompt(travelMd))));
    await closeConfig();
    __configTest.reset();

    // 证明包租户：品牌（待生效）在 tenants 行，v1 与一条 widget 由下面造
    await t.pg.exec('RESET ROLE');
    const tenant = await createFixtureTenant(t.db);
    const brand = fixtureRuntime.defaultBrand;
    const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    await t.pg.exec('SET ROLE agent_app');

    // 首次发布（v1，source='import'）：与 importConfig 的 SOP 部分同一组构件；第 18 步起 importConfig 也能按包导入产品文件（transfer-per-pack.selftest.ts 覆盖），这里只测 SOP 子系统，仍手工发布
    const firstPublish = async (tenantId: string): Promise<void> => {
      const image = tenantImage(fixtureRuntime, fixtureMd, brand);
      const render = tenantRenderer(fixtureRuntime, brand);
      const merged = mergeWithImage(image, image, fixtureSpec);
      const sop = joinSop(merged);
      const rendered = render(sop);
      const toolsJson = JSON.stringify(fixtureRuntime.tools.map((x) => x.def));
      const violations = checkSopContract({
        sections: merged,
        imageSections: image,
        rendered,
        toolNames: fixtureRuntime.tools.map((x) => x.def.function.name),
        knownFields: fixtureRuntime.knownFields.names,
        baselineEditableChars: editableChars(merged, fixtureSpec),
        ...contractInputs(fixtureRuntime, brand, null),
        hardRequirements: render(''),
      });
      assert.deepEqual(violations, []);
      await withTenant(t.db, { ...ctx, tenantId }, (tx) =>
        insertPublishedSop(tx, {
          tenantId,
          versionNo: 1,
          source: 'import',
          packId: '__fixture',
          sections: merged,
          basedOn: null,
          renderedPrompt: rendered,
          ...promptHashes(rendered, toolsJson, sop),
          policy: null,
          renderInputs: renderInputsFor(render, joinSop(image), toolsJson, fixtureSpec, brand, sha256('null')),
          changeNote: '首次导入',
          createdBy: null,
          createdByName: 'sop-per-pack-selftest',
        }),
      );
    };
    await firstPublish(tenant.id);
    checks++;

    const deps = testConfigDeps(t, { tenantSlug: tenant.slug, usePackRuntime: true, imageDataDir: undefined });
    /** 启动被 ConfigStartupError 拒绝，返回它的 detail；拒绝后没有半装载状态 */
    const failsWith = async (reason: string): Promise<string> => {
      let detail = '';
      await assert.rejects(initConfig(deps), (e: unknown) => {
        assert.ok(e instanceof ConfigStartupError, String(e));
        assert.equal(e.reason, reason);
        detail = e.detail;
        return true;
      });
      assert.equal(rt.config.loaded, null);
      return detail;
    };

    // 非旅游包的镜像（data/packs/<id>/sop.md）缺失：解析出租户的包之后 image_sop_invalid，点名这个包，没有半装载状态
    await inEmptyDir(async () => {
      assert.match(await failsWith('image_sop_invalid'), /__fixture/);
      checks++;
    });

    // 验收 3 第 5 条端到端：没有 active 的 widget → catalog_startup（旅游的 no_active_routes 另有自测）
    assert.equal(await failsWith('catalog_startup'), '没有 active 的 widget');
    checks++;

    // 上架一条之后照常启动
    const widget = { id: 'w-first', title: '合成方盒', unitPrice: 12, unit: '件', tags: ['合成'] };
    await withTenant(t.db, ctx, async (tx) => {
      await insertActiveItems(tx, tenant.id, 'widget', [widget], { userId: null, name: 'sop-per-pack-selftest' });
      await insertCatalogVersion(tx, {
        kind: 'widget',
        code: widget.id,
        version: 1,
        payload: widget,
        source: 'activate',
        createdByName: 'sop-per-pack-selftest',
      });
    });
    await initConfig(deps);
    check(() => assert.deepEqual(currentCatalog().items.widget, [widget]));
    check(() => assert.equal(currentSop().versionNo, 1));
    check(() => assert.deepEqual(currentSop().brand, brand));
    // 镜像读自证明包的参考配置（不是旅游的 data/sop.md），节表是证明包的
    check(() => assert.equal(configRuntime().legacyImageSop, fixtureMd));
    check(() => assert.deepEqual(configRuntime().imageSections, tenantImage(fixtureRuntime, fixtureMd, brand)));
    check(() =>
      assert.deepEqual(
        currentSop().sections.map((s) => s.key),
        fixtureSpec.map((s) => s.key),
      ),
    );
    // 差异按证明包的节表和参考配置目录算：没有旅游的 routes.json，也不把旅游的线路报成「只在镜像里」
    check(() => assert.deepEqual(configDrift().editedSections, []));
    check(() => assert.deepEqual(configDrift().catalog.route, { changed: [], onlyDb: [], onlyImage: [] }));

    // console：登录、概览按证明包的节表下发、改一个可编辑节、检查、发布
    await t.pg.exec('SET ROLE agent_platform');
    assert.equal(
      (
        await createUser(t.db, {
          tenantSlug: tenant.slug,
          email: 'sop-per-pack@example.com',
          name: '合成管理员',
          role: 'owner',
          password: async () => 'sop-per-pack-selftest-password',
        })
      ).code,
      0,
    );
    await t.pg.exec('SET ROLE agent_app');
    const request = async (method: string, url: string, json?: unknown, auth?: { cookie: string; csrf: string }) => {
      const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.52' };
      if (auth) {
        headers.cookie = auth.cookie;
        headers['x-csrf'] = auth.csrf;
      }
      if (json !== undefined) headers['content-type'] = 'application/json';
      return consoleApi.request(`/api/console${url}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    };
    const logged = await request('POST', '/auth/login', { email: 'sop-per-pack@example.com', password: 'sop-per-pack-selftest-password' });
    assert.equal(logged.status, 200);
    const auth = { cookie: logged.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await logged.json()) as { csrf: string }).csrf };
    type Overview = { published: { id: string; versionNo: number; sections: { key: string; text: string }[] }; spec: typeof fixtureSpec };
    type Draft = { rev: number };
    type Violation = { code: string; sectionKey: string | null; detail: string; match?: string };
    const overview = async (): Promise<Overview> => (await (await request('GET', '/sop', undefined, auth)).json()) as Overview;
    const first = await overview();
    check(() => assert.deepEqual(first.spec, fixtureSpec));
    check(() => assert.ok(!first.spec.some((s) => s.key === 'tone')));
    const save = async (basedOn: string, edits: { key: string; body: string }[]) =>
      request('PUT', '/sop/draft', { basedOn, rev: null, edits }, auth);
    const bodyOf = (sections: { key: string; text: string }[], key: string): string =>
      sectionBody(
        sections.find((s) => s.key === key)!,
        fixtureSpec.find((s) => s.key === key)!,
      );

    // 点名锁定节或旅游的节名：422，不会按旅游节表放行
    for (const key of ['fixture_role', 'tone']) {
      const rejected = await save(first.published.id, [{ key, body: '改一下' }]);
      check(() => assert.equal(rejected.status, 422, key));
    }
    const edited = '先询问方盒名称、数量与单位；客户没有说明的先问清楚，不自行补全。';
    const saved = await save(first.published.id, [{ key: 'widget_intake', body: edited }]);
    assert.equal(saved.status, 200);
    const draft = (await saved.json()) as Draft;
    const checked = await request('POST', '/sop/draft/check', undefined, auth);
    check(() => assert.equal(checked.status, 200));
    const checkedBody = (await checked.json()) as { violations: Violation[] };
    check(() => assert.deepEqual(checkedBody.violations, []));
    const published = await request('POST', '/sop/draft/publish', { rev: draft.rev, changeNote: '自测改一个可编辑节' }, auth);
    check(() => assert.equal(published.status, 200));
    const second = await overview();
    check(() => assert.equal(second.published.versionNo, 2));
    check(() => assert.equal(bodyOf(second.published.sections, 'widget_intake'), `${edited}\n\n`));
    for (const key of ['fixture_role', 'fixture_verify', 'fixture_limits'])
      check(() =>
        assert.equal(
          second.published.sections.find((s) => s.key === key)!.text,
          first.published.sections.find((s) => s.key === key)!.text,
          `${key} 锁定节不变`,
        ),
      );
    // 渲染结果、哈希与节表哈希：证明包的节表，不是旅游的
    const row2 = await withTenant(t.db, ctx, readPublishedSop);
    check(() => assert.equal(row2!.renderInputs!.sectionTableHash, sha256(JSON.stringify(fixtureSpec))));
    check(() => assert.notEqual(row2!.renderInputs!.sectionTableHash, sha256(JSON.stringify(TRAVEL_SOP_SECTIONS))));
    check(() => assert.equal(row2!.promptHash, sha256(row2!.renderedPrompt!)));
    check(() => assert.ok(row2!.renderedPrompt!.includes(edited)));
    check(() => assert.deepEqual(configDrift().editedSections, ['widget_intake']));

    // 契约检查用证明包的规则：违反 fixture_no_unverified 被拒，点名证明包的出处
    const violating = await save(second.published.id, [{ key: 'widget_reply', body: '先说明核验结果。未经核验也保证可用。' }]);
    assert.equal(violating.status, 200);
    const violatingDraft = (await violating.json()) as Draft;
    const expected = [
      {
        code: 'phrase_forbidden',
        sectionKey: 'widget_reply',
        detail: '不能出现「未经核验也保证可用」（证明包：不得把未核验的需求说成已确认）',
        match: '未经核验也保证可用',
      },
    ];
    const violatingCheck = (await (await request('POST', '/sop/draft/check', undefined, auth)).json()) as { violations: Violation[] };
    check(() => assert.deepEqual(violatingCheck.violations, expected));
    const refused = await request('POST', '/sop/draft/publish', { rev: violatingDraft.rev, changeNote: '应被拒' }, auth);
    check(() => assert.equal(refused.status, 422));
    const refusedBody = (await refused.json()) as { error: string; violations: Violation[] };
    check(() => assert.equal(refusedBody.error, 'contract'));
    check(() => assert.deepEqual(refusedBody.violations, expected));
    // 兜底：已装载的发布版本没有品牌快照（装载时已拒绝，实际不会发生）时，检查、发布都在写入之前以 brand_required 失败
    {
      const loaded = rt.config.loaded!;
      const kept = loaded.sop;
      loaded.sop = { ...kept, brand: null };
      try {
        const brandRequired = (e: unknown): boolean => e instanceof ConfigStartupError && e.reason === 'brand_required';
        await assert.rejects(sopApi.checkSopDraft(ctx), brandRequired);
        await assert.rejects(sopApi.publishSopDraft(ctx, { rev: violatingDraft.rev, changeNote: '应被拒' }), brandRequired);
        checks += 2;
      } finally {
        loaded.sop = kept;
      }
      assert.equal(currentSop().versionNo, 2);
    }
    assert.equal((await request('POST', '/sop/draft/discard', { rev: violatingDraft.rev }, auth)).status, 200);

    // 旅游的规则不套用到证明包：旅游的禁用短语不报，也不要求旅游的必含短语；工具名按证明包的工具查
    for (const [body, want] of [
      ['先说明核验结果。明显超出我们现有线路的范围也照常核验。调用 fixture_inspect。', []],
      ['先说明核验结果，再调用 search_route。', [{ code: 'unknown_tool', sectionKey: 'widget_reply', match: 'search_route' }]],
    ] as const) {
      const d = await save(second.published.id, [{ key: 'widget_reply', body }]);
      assert.equal(d.status, 200);
      const r = await request('POST', '/sop/draft/check', undefined, auth);
      const got = ((await r.json()) as { violations: Violation[] }).violations.map((v) => ({
        code: v.code,
        sectionKey: v.sectionKey,
        match: v.match,
      }));
      check(() => assert.deepEqual(got, want as unknown as typeof got));
      assert.equal((await request('POST', '/sop/draft/discard', { rev: ((await d.json()) as Draft).rev }, auth)).status, 200);
    }

    // 重启：库与镜像的差异按证明包的节表点名；没有多余的重渲染版本
    await closeConfig();
    __configTest.reset();
    logs.length = 0;
    await initConfig(deps);
    check(() => assert.equal(currentSop().versionNo, 2));
    check(() =>
      assert.ok(
        logs.some((l) => l.includes('可编辑节与镜像 data/sop.md 不同（以库为准）：方盒需求采集')),
        logs.join('\n'),
      ),
    );

    // 回滚到 v1：同一个契约检查，哈希与 v1 相同
    const versions = (await (await request('GET', '/sop/versions', undefined, auth)).json()) as {
      items: { id: string; versionNo: number }[];
    };
    const v1 = versions.items.find((v) => v.versionNo === 1)!;
    const rolled = await request('POST', `/sop/versions/${v1.id}/rollback`, { changeNote: '自测回滚' }, auth);
    check(() => assert.equal(rolled.status, 200));
    const rolledBody = (await rolled.json()) as { sameHashAsTarget: boolean };
    check(() => assert.equal(rolledBody.sameHashAsTarget, true));
    check(() => assert.equal(currentSop().versionNo, 3));

    // 导出：工具、已知字段、渲染从证明包派生，本地重渲染的 promptHash 与库里相同（旅游的工具会让它对不上）
    const out = path.join(dir, 'export');
    const exported = await exportConfig({ db: t.db, tenantSlug: tenant.slug, outDir: out, imageSop: (packId) => readImageSop(packId) });
    check(() => assert.equal(exported.code, 0, exported.message));
    check(() => assert.equal(exported.hashes?.promptHash, currentSop().promptHash));
    check(() => assert.equal(fs.readFileSync(path.join(out, 'sop.md'), 'utf8'), joinSop(currentSop().sections)));
    check(() => assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'brand.json'), 'utf8')), brand));

    // 沙箱模板复制：镜像按模板租户的包取，复制出的租户与模板的 promptHash 相同，并能启动
    await closeConfig();
    __configTest.reset();
    const pub = (await withTenant(t.db, ctx, readPublishedSop))!;
    const items = await withTenant(t.db, ctx, readActiveCatalog);
    await t.pg.exec('RESET ROLE');
    const copy = await createFixtureTenant(t.db, { slug: 'fixture-copy' });
    await t.pg.exec('SET ROLE agent_app');
    const copyCtx = { ...ctx, tenantId: copy.id };
    const hashes = await withTenant(t.db, copyCtx, (tx) =>
      writeTemplateConfig(tx, pub, items, source.imageSopOf({ imageSop: travelMd }, pub.packId)),
    );
    check(() => assert.equal(hashes.promptHash, pub.promptHash));
    check(() => assert.deepEqual(publishedBrand(pub.renderInputs).brand, brand));
    await initConfig({ ...deps, tenantSlug: copy.slug });
    check(() => assert.equal(currentSop().promptHash, pub.promptHash));
    check(() => assert.equal(currentSop().versionNo, 1));
    await closeConfig();
    __configTest.reset();

    // 沙箱模板的已发布版本没有品牌快照（旧版模式渲染）：非旅游包不复制，在开通事务提交之前以 brand_required 失败，库里没有新版本也没有条目
    {
      await t.pg.exec('RESET ROLE');
      const legacySource = await createFixtureTenant(t.db, { slug: 'fixture-legacy' });
      const sandbox = await createFixtureTenant(t.db, { slug: 'fixture-sbx' });
      await t.pg.exec('SET ROLE agent_app');
      const legacyCode = imageCode(fixtureRuntime);
      const legacySections = splitSop(fixtureMd, fixtureSpec);
      const legacySop = joinSop(legacySections);
      const legacyRendered = legacyCode.render(legacySop);
      await withTenant(t.db, { ...ctx, tenantId: legacySource.id }, (tx) =>
        insertPublishedSop(tx, {
          tenantId: legacySource.id,
          versionNo: 1,
          source: 'import',
          packId: '__fixture',
          sections: legacySections,
          basedOn: null,
          renderedPrompt: legacyRendered,
          ...promptHashes(legacyRendered, legacyCode.toolsJson, legacySop),
          policy: null,
          renderInputs: renderInputsFor(legacyCode.render, fixtureMd, legacyCode.toolsJson, fixtureSpec, null, sha256('null')),
          changeNote: null,
          createdBy: null,
          createdByName: 'sop-per-pack-selftest',
        }),
      );
      const legacyPub = (await withTenant(t.db, { ...ctx, tenantId: legacySource.id }, readPublishedSop))!;
      check(() => assert.equal(publishedBrand(legacyPub.renderInputs).brand, null));
      const sandboxCtx = { ...ctx, tenantId: sandbox.id };
      await assert.rejects(
        withTenant(t.db, sandboxCtx, (tx) => writeTemplateConfig(tx, legacyPub, [], fixtureMd)),
        (e: unknown) => {
          assert.ok(e instanceof ConfigStartupError, String(e));
          assert.equal(e.reason, 'brand_required');
          assert.match(e.detail, /沙箱模板/);
          return true;
        },
      );
      await t.pg.exec('RESET ROLE');
      const count = async (table: 'sop_versions' | 'catalog_items') =>
        (await t.pg.query<{ n: number }>(`select count(*)::int as n from ${table} where tenant_id = $1`, [sandbox.id])).rows[0]!.n;
      assert.equal(await count('sop_versions'), 0);
      assert.equal(await count('catalog_items'), 0);
      await t.pg.exec('SET ROLE agent_app');
      checks += 2;
    }

    // 验收 8：把品牌清掉之后重启以 brand_required 拒绝（非旅游包只支持模板模式），库没动。
    // owner 2026-10-24 定（plan Open 1）：缺品牌的拒绝原因是 brand_required。
    const versionsBefore = async () =>
      (await t.pg.query<{ n: number }>('select count(*)::int as n from sop_versions where tenant_id = $1', [tenant.id])).rows[0]!.n;
    await t.pg.exec('RESET ROLE');
    const before = await versionsBefore();
    await t.pg.query('update tenants set brand = null where id = $1', [tenant.id]);
    await t.pg.exec('SET ROLE agent_app');
    assert.match(await failsWith('brand_required'), /只支持模板模式/);
    await t.pg.exec('RESET ROLE');
    check(() => assert.equal(rt.config.loaded, null));
    assert.equal(await versionsBefore(), before);
    // 恢复品牌之后照常启动，已发布版本原样用上（没有重渲染）
    await t.pg.query('update tenants set brand = $2 where id = $1', [tenant.id, JSON.stringify(brand)]);
    await t.pg.exec('SET ROLE agent_app');
    await initConfig(deps);
    const latest = (await withTenant(t.db, ctx, readPublishedSop))!;
    check(() => assert.equal(currentSop().versionNo, 3));
    check(() => assert.equal(currentSop().promptHash, latest.promptHash));
    await closeConfig();
    __configTest.reset();
    console.log = log;
    console.log(
      `SOP PER PACK SELFTEST：${checks} 项通过（配置层不 import 具体包 / 旅游导入导出输入与契约违规不变 / 证明包 DB 模式首次发布、console 改节再发布、契约用包的规则、回滚、导出、模板复制 / catalog_startup 端到端 / brand_required）`,
    );
  } finally {
    console.log = log;
    await t.close();
  }
}
