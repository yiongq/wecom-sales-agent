// 08 第 18 步（R11 的闸）：发布闸按包。假模型 + PGlite，没有任何真实模型调用。
//   一、旅游不变：目标集哈希、缓存键、闸导出的各文件与开工时（基点 96f1159）逐字节相同，写成常量钉在这里。
//      这些值依赖 eval/sim/goals/quality、data/（sop.md、routes.json、hotels.json）与渲染出的提示词：改了它们是有意的变更，
//      照失败信息里的新值重新钉住，并在 PR 里说明；若是这一步以外的改动带来的，先查是不是改坏了旅游。
//   二、gateEnvironment()：不设 __gateTest.childEnv 时放行名单与值同开工时；设了只多出自测给的变量，父进程环境不被修改。
//   三、证明包租户（DB 模式、模板模式）：目标取 PackRuntime.evalGoalsDir（eval/sim/goals/__fixture 的 2 个）；闸导出的 draft、published 两边都有
//      pack.json 与 catalog/widget.json、没有 routes.json / hotels.json；缓存键里的产品库哈希是包声明的各 kind 的数组按声明顺序哈希（一个公式管所有包，旅游声明 route、hotel）；
//      假模型把两个目标两边都跑过；不给 childEnv 时子进程认不出证明包（PACK_FIXTURES 不在放行名单里），闸以 child_exit 结束。
// 证明包只在 PACK_FIXTURES=1 时登记，所以放在子进程里跑。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 开工时（基点 96f1159）算出的旅游值。重新钉住时的算法见各处注释 */
const TRAVEL_PIN = {
  /** regression 目标的条数与 sha256(JSON.stringify([{ id, text }, …]))，即 gateTargets().hash */
  goalCount: 20,
  goalsHash: '47493523bcc78159654d79b863a74f258654598ac10c9ef4300bbbba66a4a271',
  /** 导入 data/ 之后 sha256(JSON.stringify([routes, hotels])) */
  catalogHash: '8bb4cd17dcdf89663228fdc0cd5c38d671130bb24200d7b15112cbae3fa679e5',
  /** 已发布 SOP 与「tone 节末尾加一行措辞标记甲」的草稿，在 APP_REVISION=gate-selftest、模型 glm-5.2 下的缓存键 */
  baselineKey: '2df5fbcdcd6169b9df9b2e7dbfb473d756a523135835f9ad1d3b11a70a2aac5a', // gitleaks:allow
  draftKey: 'c6ed3ac904ebc0799c16882045ee0622e8189f07b59518c1095c605d37d2e6a5', // gitleaks:allow
  /** 闸给子进程写的导出目录里各文件的 sha256；两边的产品库与政策相同，只有 sop.md 不同 */
  common: {
    'hotels.json': 'cd13af1d7d88d70e2e852f8bd45ef0966b5fd688ad8e90c189d2c1fd34680e9a',
    'policy.json': 'a1dd1c22e1722a0e2db12f2b1e20b0b4fb4c0c84eaad153b1b64584d20f46ef2',
    'routes.json': '76994353e80a276648bcafcf63edb67313a0936610e7ddcb6709ff78dde5ceaf',
  },
  publishedSop: '1f850038290b202f66573695faee972bd0b03a3da9ec3e62e665ff5fa6b81ba3',
  draftSop: '03d3f711317c9226f77650face596dd003db85dfc3bb9928aacda7d45a9366e4',
} as const;

if (process.argv[2] !== 'worker') {
  const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
    env: { ...process.env, PACK_FIXTURES: '1', CONFIG_SOURCE: 'file' },
    encoding: 'utf8',
    timeout: 480_000,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
} else {
  const env = { ...process.env };
  const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-per-pack-'));
  process.env.VAR_DIR = path.join(root, 'state');
  const { hostRuntime, withoutTenantScope, currentRuntime } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  enterTenantScopeForTest(hostRuntime());
  const { openTestDb, testConfigDeps, fakeLock } = await withoutTenantScope(() => import('../db/testing.js'));
  const { withTenant } = await import('../db/client.js');
  const { readGate } = await import('../db/repo/gate.js');
  const { createFixtureTenant } = await import('../tenancy/fixture-testing.js');
  const { fakeService, say } = await import('../../eval/sim/fake.js');
  const { fixtureClock } = await import('../../eval/sim/runtime.js');
  const { sectionBody, TRAVEL_SOP_SECTIONS } = await import('../sop/sections.js');
  const { importConfig } = await import('./transfer.js');
  const { readImageSop } = await import('./brand.js');
  const { runtimeById } = await import('../packs/registry.js');
  const config = await import('./source.js');
  const sop = await import('./sop.js');
  const { startGate, getGateRun, gateTargets, gateEnvironment, stopTenantGates, __gateTest } = await import('./gate.js');

  const restoreClock = fixtureClock();
  process.env.CONFIG_SOURCE = 'file';
  process.env.SOP_GATE = 'off';
  process.env.LLM_MOCK = '0';
  process.env.LLM_PROVIDER = '';
  process.env.LLM_MODEL = 'glm-5.2';
  process.env.LLM_MODEL_CHEAP = 'glm-5.2';
  process.env.LLM_HEDGE_MODEL = '';
  process.env.LLM_MAX_RETRY = '0';
  process.env.SOP_GATE_DAILY_RUNS = '100';
  process.env.SOP_GATE_TIMEOUT_MS = '120000';
  process.env.APP_REVISION = 'gate-selftest';
  let checks = 0;
  const check = (name: string, ok: unknown): void => {
    assert.ok(ok, name);
    checks++;
  };
  const eq = (name: string, actual: unknown, expected: unknown): void => {
    assert.deepEqual(actual, expected, name);
    checks++;
  };

  /** 目录下全部文件（相对路径，排序）→ 内容；闸跑完会把目录删掉，所以要趁子进程还在跑时读 */
  const readTree = (dir: string): Record<string, string> => {
    const files: Record<string, string> = {};
    const walk = (rel: string): void => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
        const next = path.join(rel, entry.name);
        if (entry.isDirectory()) walk(next);
        else files[next] = fs.readFileSync(path.join(dir, next), 'utf8');
      }
    };
    walk('');
    return files;
  };
  type Sides = { draft: Record<string, string>; published: Record<string, string> };
  /** 等闸结束，期间一旦两边的导出目录都在了就读下来（子进程起来之前两边都已导出） */
  const finishAndCapture = async (ctx: Parameters<typeof getGateRun>[0], runId: string): Promise<{ sides: Sides | null }> => {
    let sides: Sides | null = null;
    const deadline = Date.now() + 120_000;
    while (true) {
      const gateDir = path.join(process.env.VAR_DIR!, 'gate', runId);
      if (!sides && fs.existsSync(path.join(gateDir, 'draft')) && fs.existsSync(path.join(gateDir, 'published'))) {
        try {
          sides = { draft: readTree(path.join(gateDir, 'draft')), published: readTree(path.join(gateDir, 'published')) };
        } catch {
          // 正好被清理：不是这个时刻，下一轮看状态
        }
      }
      const v = await getGateRun(ctx, runId);
      if (!['queued', 'running'].includes(v.status)) break;
      if (Date.now() > deadline) throw new Error('闸自测超时');
      await new Promise((r) => setTimeout(r, 25));
    }
    await stopTenantGates(currentRuntime().id);
    return { sides };
  };
  const hashes = (files: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)]));

  // ---------------- 二、gateEnvironment ----------------
  {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      LLM_PROVIDER: 'deepseek',
      LLM_BASE_URL: 'http://127.0.0.1:1/v1/',
      LLM_API_KEY: 'k-1',
      LLM_MODEL: 'glm-5.2',
      LLM_MODEL_CHEAP: 'glm-5.2-cheap',
      LLM_MAX_INFLIGHT: '8',
      LLM_HEDGE_MODEL: 'h',
      ZHIPU_FOO: 'z',
      EMBED_BASE_URL: 'http://127.0.0.1:2',
      TZ: 'UTC',
      DATABASE_URL: 'postgres://must-not-pass',
      DEEPSEEK_API_KEY: 'dk',
      PACK_FIXTURES: '1',
      PATH: '/bin',
      VAR_DIR: '/v',
    });
    try {
      // 开工时（基点）同一份环境算出的整张表：键集合与值都在这里
      const baseline = {
        LLM_PROVIDER: '',
        LLM_BASE_URL: 'https://api.deepseek.com/v1',
        LLM_API_KEY: 'dk',
        LLM_MODEL: 'glm-5.2',
        LLM_MODEL_CHEAP: 'glm-5.2',
        LLM_MAX_INFLIGHT: '1',
        LLM_HEDGE_MODEL: 'h',
        ZHIPU_FOO: 'z',
        EMBED_BASE_URL: 'http://127.0.0.1:2',
        TZ: 'UTC',
        TMPDIR: '/t',
        TSX_DISABLE_CACHE: '1',
      };
      const before = JSON.stringify(process.env);
      eq('不设 childEnv：与开工时相同（键集合与值）', gateEnvironment('/t'), baseline);
      check('放行名单不放 PACK_FIXTURES、数据库凭据与 DeepSeek 专用变量', !('PACK_FIXTURES' in gateEnvironment('/t')));
      __gateTest.childEnv = { PACK_FIXTURES: '1' };
      eq('设了 childEnv：只多出自测给的变量', gateEnvironment('/t'), { ...baseline, PACK_FIXTURES: '1' });
      check('父进程环境不被修改', JSON.stringify(process.env) === before);
    } finally {
      delete __gateTest.childEnv;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    eq('用完恢复：与开工时相同', gateEnvironment('/t').TSX_DISABLE_CACHE, '1');
  }

  const travelRuntime = runtimeById('travel', config.packSources())!;
  const fixtureRuntime = runtimeById('__fixture', config.packSources())!;
  check(
    '两个包的 evalGoalsDir',
    travelRuntime.evalGoalsDir === 'eval/sim/goals/quality' && fixtureRuntime.evalGoalsDir === 'eval/sim/goals/__fixture',
  );

  // ---------------- 一、旅游不变 ----------------
  const goals = await gateTargets(travelRuntime);
  check('旅游的目标目录是 eval/sim/goals/quality', goals.dir === path.resolve('eval/sim/goals/quality'));
  eq('旅游 regression 目标条数', goals.ids.length, TRAVEL_PIN.goalCount);
  eq('旅游目标集哈希与开工时相同', goals.hash, TRAVEL_PIN.goalsHash);
  {
    // __gateTest.goalsDir 照旧优先于包的目录
    const other = path.join(root, 'other-goals');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'a.json'), JSON.stringify({ id: 'only-one', tags: ['regression'] }));
    __gateTest.goalsDir = other;
    try {
      const picked = await gateTargets(travelRuntime);
      eq('goalsDir 优先', [picked.dir, picked.ids], [other, ['only-one']]);
    } finally {
      delete __gateTest.goalsDir;
    }
  }

  const lite = await openTestDb();
  const service = await fakeService();
  try {
    process.env.LLM_BASE_URL = service.url;
    process.env.LLM_API_KEY = 'fake';
    process.env.EMBED_BASE_URL = service.url;
    process.env.EMBED_API_KEY = 'fake';
    const md = fs.readFileSync('data/sop.md', 'utf8');
    const editTone = async (ctx: Parameters<typeof sop.getSopOverview>[0], marker: string) => {
      const overview = await sop.getSopOverview(ctx);
      const tone = sectionBody(
        overview.published.sections.find((s) => s.key === 'tone')!,
        TRAVEL_SOP_SECTIONS.find((s) => s.key === 'tone')!,
      );
      return sop.saveSopDraft(ctx, { basedOn: overview.published.id, rev: null, edits: [{ key: 'tone', body: `${tone}\n${marker}` }] });
    };
    const actor = { kind: 'user' as const, userId: null, name: '闸按包自测', ip: null, role: 'owner' as const };

    // 旅游租户：导入 data/、装载、起一次用真实 quality 目标集的闸（起了就取消，只看缓存键），再用小目标集跑通一次读闸导出的文件
    await lite.pg.query("insert into tenants(slug,name,pack_id) values ('gate-pack-travel','闸按包','travel')");
    await lite.pg.exec('SET ROLE agent_app');
    config.__configTest.reset();
    const travelDeps = testConfigDeps(lite, { tenantSlug: 'gate-pack-travel' });
    const imported = await importConfig({
      db: lite.db,
      tenantSlug: 'gate-pack-travel',
      dataDir: 'data',
      imageSop: md,
      lock: async () => fakeLock(),
    });
    assert.equal(imported.code, 0, imported.message);
    await config.initConfig(travelDeps);
    process.env.CONFIG_SOURCE = 'db';
    {
      const tenantId = config.currentSop().tenantId;
      const ctx = { tenantId, actor };
      const snapshot = config.currentCatalog();
      eq('旅游产品库哈希与开工时相同', sha(JSON.stringify([snapshot.routes, snapshot.hotels])), TRAVEL_PIN.catalogHash);
      // 缓存键只有一个公式：旅游声明 route、hotel，items.route / items.hotel 与 routes / hotels 序列化相同，所以按声明顺序哈希 items 就是原来的值
      eq('旅游声明顺序是 route、hotel', Object.keys(travelRuntime.catalog), ['route', 'hotel']);
      eq(
        '旅游按声明顺序哈希 items 与原公式相同',
        sha(JSON.stringify(Object.keys(travelRuntime.catalog).map((kind) => snapshot.items[kind] ?? []))),
        TRAVEL_PIN.catalogHash,
      );
      const draft = await editTone(ctx, '措辞标记甲');
      const started = await startGate(ctx, { rev: draft.rev });
      await stopTenantGates(tenantId);
      const row = await withTenant(lite.db, ctx, (tx) => readGate(tx, started.runId));
      eq('旅游缓存键（线上基线）与开工时相同', row!.baselineKey, TRAVEL_PIN.baselineKey);
      eq('旅游缓存键（草稿）与开工时相同', row!.draftKey, TRAVEL_PIN.draftKey);

      // 小目标集 + 假模型：读闸写给子进程的两边导出目录
      const tiny = path.join(root, 'tiny-goals');
      fs.mkdirSync(tiny);
      fs.writeFileSync(
        path.join(tiny, '01-regression.json'),
        JSON.stringify({
          id: 'gate-regression',
          persona: '仅咨询',
          maxTurns: 1,
          tags: ['regression'],
          customerScript: ['你好'],
          allowedTools: ['search_routes'],
          forbidden: [],
          predicates: [{ kind: 'reply_matches', pattern: '想去哪里', scope: 'any' }],
        }),
      );
      __gateTest.goalsDir = tiny;
      process.env.APP_REVISION = 'gate-selftest-tiny';
      service.script.length = 0;
      for (let i = 0; i < 60; i++) service.script.push({ content: '您好，请问您想去哪里旅行？' });
      const second = await startGate(ctx, { rev: draft.rev });
      const { sides } = await finishAndCapture(ctx, second.runId);
      delete __gateTest.goalsDir;
      process.env.APP_REVISION = 'gate-selftest';
      check('读到了两边的导出目录', sides);
      eq('旅游闸导出：draft 只有这五个文件', Object.keys(sides!.draft), ['hotels.json', 'policy.json', 'routes.json', 'sop.md']);
      eq('旅游闸导出：published 同样（没有 pack.json 与 catalog/）', Object.keys(sides!.published), [
        'hotels.json',
        'policy.json',
        'routes.json',
        'sop.md',
      ]);
      eq('旅游闸导出：published 逐字节同开工时', hashes(sides!.published), { ...TRAVEL_PIN.common, 'sop.md': TRAVEL_PIN.publishedSop });
      eq('旅游闸导出：draft 逐字节同开工时', hashes(sides!.draft), { ...TRAVEL_PIN.common, 'sop.md': TRAVEL_PIN.draftSop });
      eq('跑完是 done', (await getGateRun(ctx, second.runId)).status, 'done');
    }
    config.__configTest.reset();

    // ---------------- 三、证明包租户 ----------------
    await lite.pg.exec('RESET ROLE');
    const tenant = await createFixtureTenant(lite.db, { slug: 'gate-pack-fixture' });
    await lite.pg.exec('SET ROLE agent_app');
    const fixtureDeps = testConfigDeps(lite, { tenantSlug: tenant.slug, usePackRuntime: true, imageDataDir: undefined });
    const fixtureImport = await importConfig({
      db: lite.db,
      tenantSlug: tenant.slug,
      dataDir: 'data/packs/__fixture',
      imageSop: (packId) => readImageSop(packId),
      lock: async () => fakeLock(),
    });
    assert.equal(fixtureImport.code, 0, fixtureImport.message);
    await config.initConfig(fixtureDeps);
    process.env.CONFIG_SOURCE = 'db';
    {
      const ctx = { tenantId: tenant.id, actor };
      const wanted = ['fixture-order-two-widgets', 'fixture-quote-freight-no-order'];
      const fixtureGoals = await gateTargets(fixtureRuntime);
      check('证明包的目标目录取 evalGoalsDir', fixtureGoals.dir === path.resolve('eval/sim/goals/__fixture'));
      eq('证明包的目标就是 __fixture 目录里那 2 个', fixtureGoals.ids, wanted);
      check('证明包的目标集不同于旅游', fixtureGoals.hash !== TRAVEL_PIN.goalsHash);

      const overview = await sop.getSopOverview(ctx);
      const draft = await sop.saveSopDraft(ctx, {
        basedOn: overview.published.id,
        rev: null,
        edits: [{ key: 'widget_intake', body: '先询问方盒名称、数量与单位；客户没有说明的先问清楚，不自行补全。' }],
      });

      // 不给 childEnv：子进程拿不到 PACK_FIXTURES，认不出证明包（解析 --config-dir 时点名「不在注册表里」），闸以 child_exit 结束
      process.env.APP_REVISION = 'gate-selftest-nochild';
      const missing = await startGate(ctx, { rev: draft.rev });
      await finishAndCapture(ctx, missing.runId);
      const failed = await getGateRun(ctx, missing.runId);
      check('没有 childEnv：child_exit', failed.status === 'error' && failed.error === 'child_exit');

      // 给 childEnv：假模型把两个目标两边都跑过。每边脚本：目标一（询价两种方盒、下单、致谢）、目标二（问单价与运费）
      __gateTest.childEnv = { PACK_FIXTURES: '1' };
      process.env.APP_REVISION = 'gate-selftest';
      const lines = [
        { kind: 'widget', code: 'w-a', qty: 200 },
        { kind: 'widget', code: 'w-b', qty: 50 },
      ];
      service.script.length = 0;
      for (let side = 0; side < 2; side++)
        service.script.push(
          {
            tools: [
              { name: 'fixture_quote', args: { code: 'w-a' } },
              { name: 'fixture_quote', args: { code: 'w-b' } },
            ],
          },
          { content: '合成方盒甲单价3.80元起，合成方盒乙单价12元。' },
          say('合成方盒甲要200件、合成方盒乙要50件，确认下单'),
          { tools: [{ name: 'fixture_order', args: { lines } }] },
          { content: '已为您建好订单，合计1,330元。' },
          say('好的，谢谢', true),
          { content: '不客气。' },
          { tools: [{ name: 'fixture_quote', args: { code: 'w-c' } }] },
          { content: '合成方盒丙单价3.65元，运费10元。' },
          say('好的，我再想想，谢谢', true),
          { content: '好的，需要时随时联系。' },
        );
      const started = await startGate(ctx, { rev: draft.rev });
      const { sides } = await finishAndCapture(ctx, started.runId);
      const view = await getGateRun(ctx, started.runId);
      check(`证明包的闸跑通：${view.status}/${view.error}`, view.status === 'done' && view.verdict === 'pass');
      eq(
        '草稿一边的目标 id',
        view.draft.map((g) => g.id),
        wanted,
      );
      eq(
        '线上基线一边的目标 id',
        view.baseline?.map((g) => g.id),
        wanted,
      );
      check(
        '两边的目标都过了',
        [...view.draft, ...(view.baseline ?? [])].every((g) => g.result === 'pass'),
      );
      check('脚本恰好用完（没有多余的模型往返）', service.script.length === 0);

      check('读到了证明包的两边导出目录', sides);
      const reference = JSON.parse(fs.readFileSync('data/packs/__fixture/catalog/widget.json', 'utf8')) as unknown;
      for (const [side, files] of Object.entries(sides!)) {
        eq(`证明包闸导出：${side} 的文件`, Object.keys(files), ['brand.json', 'catalog/widget.json', 'pack.json', 'policy.json', 'sop.md']);
        eq(`${side} 的 pack.json`, JSON.parse(files['pack.json']!), { id: '__fixture' });
        eq(`${side} 的 catalog/widget.json 就是库里 active 的 widget`, JSON.parse(files['catalog/widget.json']!), reference);
        check(`${side} 没有 routes.json / hotels.json`, !('routes.json' in files) && !('hotels.json' in files));
      }

      // 缓存键：产品库哈希是声明的各 kind 的数组按声明顺序哈希（证明包只有 widget）；其余部分同旅游
      const row = await withTenant(lite.db, ctx, (tx) => readGate(tx, started.runId));
      const sopNow = config.currentSop();
      const catalogHash = sha(JSON.stringify([config.currentCatalog().items.widget]));
      const key = (prompt: string, policy: string): string =>
        sha(JSON.stringify([prompt, policy, catalogHash, fixtureGoals.hash, 'gate-selftest', 'glm-5.2', 'glm-5.2']));
      eq('证明包缓存键（线上基线）', row!.baselineKey, key(sopNow.promptHash, sopNow.policyHash));
      eq('证明包缓存键（草稿）', row!.draftKey, key(row!.promptHash, row!.policyHash));
      check('缓存键里的产品库哈希不是旅游那一个', catalogHash !== TRAVEL_PIN.catalogHash);
    }
    delete __gateTest.childEnv;
    console.log(`GATE PER PACK SELFTEST PASS: ${checks} 项断言`);
  } finally {
    delete __gateTest.childEnv;
    delete __gateTest.goalsDir;
    await stopTenantGates(currentRuntime().id).catch(() => {});
    await service.close();
    config.__configTest.reset();
    await lite.close();
    restoreClock();
    fs.rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
}
