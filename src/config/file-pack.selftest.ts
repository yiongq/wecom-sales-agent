// 08 第 13 步（R11 的装载部分）：文件模式按配置目录的 pack.json 装载任意包的产品库。
//   一、没有 pack.json（data/、写 travel 的、带无关 catalog/ 的目录）= 旅游，与以前相同：不读 catalog/、不写盘、currentCatalog() 照抛 ConfigNotReady，
//      data/ 里永远不放 pack.json（锁定套件的配置目录就是 data/，批 D 的 D3）。
//   二、用 data/packs/__fixture/ 当配置目录（PACK_FIXTURES=1）：currentCatalog().items.widget 有数据、routes / hotels 是空数组、版本恒为 1、
//      条目过包的 schema 且至少一条带阶梯价；评测那种不走 initConfig 的路径（还没绑包）按 pack.json 惰性装载；OTel 包名是 __fixture；启动预检不报错，旅游的预检照旧。
//   三、拒绝：widget.json 清空 / 缺文件 / 条目不合格 / 重复 / 不是数组 → catalog_startup；pack.json 指向没有的包或写坏 → pack_unknown；非旅游包没有 brand.json → brand_required；
//      没登记（不设 PACK_FIXTURES）的证明包 → pack_unknown。
//   四、模拟评测：--config-dir 的静态检查按包（非旅游包逐 kind 严检 catalog/<kind>.json，缺了点名），engineRuntime 对非旅游包只设 SOP_PATH
//      （不设 ROUTES_PATH / HOTELS_PATH），从 pack.json 认包。
//   五、同一进程换配置目录（交叉评审的四条回归）：证明包 → 旅游 → 证明包的 engineRuntime 不串包绑定与产品库快照；engineRuntime 开始前就装载并校验
//      非旅游产品库（widget.json 为 [] 时直接以 catalog_startup 失败）；直接换 SOP_PATH 后 currentCatalog() 跟着目录走；重置后按当前目录惰性恢复；
//      config.fileCatalog 的状态计数按快照是否存在算。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2] ?? 'parent';
const fixtureDir = path.resolve('data/packs/__fixture');

if (mode === 'parent') {
  for (const [label, args, extra] of [
    ['登记了证明包', ['worker'], { PACK_FIXTURES: '1' }],
    ['没登记证明包', ['unregistered'], {}],
    ['模拟评测装载', ['sim'], { PACK_FIXTURES: '1' }],
  ] as const) {
    const env: NodeJS.ProcessEnv = { ...process.env, LLM_MOCK: '1', CONFIG_SOURCE: 'file', SERVER_SELFTEST: '1', ...extra };
    if (!('PACK_FIXTURES' in extra)) delete env.PACK_FIXTURES;
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, ...args], {
      env,
      encoding: 'utf8',
      timeout: 240_000,
    });
    assert.equal(child.error, undefined, label);
    assert.equal(child.status, 0, `${label}\n${child.stdout}${child.stderr}`);
    process.stdout.write(child.stdout);
  }
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-pack-'));
  process.env.VAR_DIR = path.join(tmp, 'var');
  fs.mkdirSync(process.env.VAR_DIR);
  const { hostRuntime, withoutTenantScope } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  enterTenantScopeForTest(hostRuntime());
  const { tenantKeys } = await import('../tenancy/state.js');
  /** config.fileCatalog 的状态计数：有快照 1，没有 0 */
  const fileCatalogKeys = (): number => tenantKeys(hostRuntime().id)['config.fileCatalog']!;
  const { boundPack } = await withoutTenantScope(() => import('../core/pack-api.js'));
  const source = await withoutTenantScope(() => import('./source.js'));
  const { initConfig, currentCatalog, currentPack, configMode, renderFileSop, ConfigStartupError, ConfigNotReadyError, __configTest } =
    source;

  let checks = 0;
  const check = (fn: () => void): void => {
    fn();
    checks++;
  };
  const rejectsWith = async (
    what: string,
    reason: string,
    detail: RegExp,
    run: () => Promise<unknown> = () => initConfig(null),
  ): Promise<void> => {
    await assert.rejects(run(), (e: unknown) => {
      assert.ok(e instanceof ConfigStartupError, `${what}：应是 ConfigStartupError，实际 ${String(e)}`);
      assert.equal(e.reason, reason, `${what}：${e.detail}`);
      assert.match(e.detail, detail, what);
      return true;
    });
    checks++;
  };
  /** 临时配置目录：证明包的参考配置整份拷过来，调用方再改 */
  const copyFixture = (name: string): string => {
    const dir = path.join(tmp, name);
    fs.cpSync(fixtureDir, dir, { recursive: true });
    return dir;
  };
  const useDir = (dir: string): void => {
    process.env.SOP_PATH = path.join(dir, 'sop.md');
    __configTest.reset();
  };
  const widgetFile = (dir: string): string => path.join(dir, 'catalog', 'widget.json');
  /** 参考配置里 widget 的条数：第 17 步起评测 case 往里加了条目，不再写死 3 */
  const fixtureWidgetCount = (): number => (JSON.parse(fs.readFileSync(widgetFile(fixtureDir), 'utf8')) as unknown[]).length;
  const spyConsoleError = async (fn: () => void | Promise<void>): Promise<string[]> => {
    const saved = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      await fn();
    } finally {
      console.error = saved;
    }
    return lines;
  };
  /** 记下 fn 里碰过的文件系统路径：读、查在不在、写 */
  const spyFs = async (fn: () => Promise<void>): Promise<{ read: string[]; exists: string[]; write: string[] }> => {
    const log = { read: [] as string[], exists: [] as string[], write: [] as string[] };
    const saved = {
      readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync,
      existsSync: fs.existsSync,
      writeFileSync: fs.writeFileSync,
      mkdirSync: fs.mkdirSync,
    };
    const note = (list: string[], p: unknown): void => void list.push(String(p));
    Object.assign(fs, {
      readFileSync: (p: never, ...rest: never[]) => (note(log.read, p), (saved.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)),
      readdirSync: (p: never, ...rest: never[]) => (note(log.read, p), (saved.readdirSync as (...a: unknown[]) => unknown)(p, ...rest)),
      existsSync: (p: never) => (note(log.exists, p), saved.existsSync(p)),
      writeFileSync: (p: never, ...rest: never[]) => (
        note(log.write, p),
        (saved.writeFileSync as (...a: unknown[]) => unknown)(p, ...rest)
      ),
      mkdirSync: (p: never, ...rest: never[]) => (note(log.write, p), (saved.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest)),
    });
    try {
      await fn();
    } finally {
      Object.assign(fs, saved);
    }
    return log;
  };

  if (mode === 'unregistered') {
    // 没设 PACK_FIXTURES：注册表里没有证明包，pack.json 指向它就是 pack_unknown
    check(() => assert.equal(process.env.PACK_FIXTURES, undefined));
    process.env.SOP_PATH = path.join(fixtureDir, 'sop.md');
    await rejectsWith('没登记的证明包', 'pack_unknown', /__fixture/);
    await rejectsWith('lazy 路径一样拒绝', 'pack_unknown', /__fixture/, async () => currentCatalog());
    console.log(`FILE PACK SELFTEST（未登记证明包）PASS：${checks} 项`);
  } else if (mode === 'sim') {
    // ---------------- 四、模拟评测：--config-dir 与 engineRuntime（新进程，还没绑包，认包只靠 pack.json） ----------------
    const { resolveConfigDir, engineRuntime, CONFIG_DIR_REQUIRED, PACK_DIR_REQUIRED } = await import('../../eval/sim/runtime.js');
    const { Meter } = await import('../../eval/sim/runner.js');
    const { fakeEnv, fakePrices, fakeService } = await import('../../eval/sim/fake.js');
    const rejects = async (what: string, dir: string, re: RegExp): Promise<void> => {
      await assert.rejects(resolveConfigDir(dir), re, what);
      checks++;
    };

    check(() => assert.deepEqual([...CONFIG_DIR_REQUIRED], ['sop.md', 'routes.json', 'hotels.json']));
    check(() => assert.deepEqual([...PACK_DIR_REQUIRED], ['sop.md', 'pack.json']));
    check(() => assert.equal(path.isAbsolute(fixtureDir), true));
    assert.equal(await resolveConfigDir(fixtureDir), fixtureDir);
    checks++;
    // 旅游目录照旧：缺 routes.json 就点名
    const travelDir = path.join(tmp, 'travel');
    fs.mkdirSync(travelDir);
    fs.copyFileSync('data/sop.md', path.join(travelDir, 'sop.md'));
    await rejects('旅游目录缺 routes.json', travelDir, /缺 routes\.json/);
    fs.writeFileSync(path.join(travelDir, 'pack.json'), '{"id":"travel"}\n');
    await rejects('pack.json 写 travel 仍按旅游要 routes.json', travelDir, /缺 routes\.json/);
    // 非旅游包：不要 routes.json / hotels.json，要 sop.md、pack.json、catalog/
    const packDir = copyFixture('pack-dir');
    assert.equal(await resolveConfigDir(packDir), packDir);
    checks++;
    // 08 第 18 步：包声明的每个 kind 都要有 catalog/<kind>.json，缺哪个点名哪个，不当空数组（装载时的 catalog_startup 判不到这里）
    const noWidget = copyFixture('no-widget-file');
    fs.rmSync(widgetFile(noWidget));
    fs.writeFileSync(path.join(noWidget, 'catalog', 'unrelated.json'), '[]');
    await rejects('非旅游包缺 catalog/widget.json', noWidget, /缺 catalog\/widget\.json/);
    const ghost = copyFixture('ghost-pack');
    fs.writeFileSync(path.join(ghost, 'pack.json'), '{"id":"ghost"}');
    await rejects('pack.json 指向没登记的包', ghost, /「ghost」.*不在注册表里/);
    fs.rmSync(path.join(packDir, 'catalog'), { recursive: true });
    await rejects('非旅游包缺 catalog/', packDir, /缺 catalog\//);
    fs.rmSync(path.join(packDir, 'sop.md'));
    await rejects('非旅游包缺 sop.md', packDir, /缺 sop\.md/);
    fs.writeFileSync(path.join(packDir, 'pack.json'), '{"id":"x","extra":1}');
    await rejects('pack.json 写坏', packDir, /pack\.json 不合格/);

    // engineRuntime：非旅游包只设 SOP_PATH，包与品牌由 pack.json 与同目录认出；不设 ROUTES_PATH / HOTELS_PATH
    delete process.env.ROUTES_PATH;
    delete process.env.HOTELS_PATH;
    const customer = await fakeService();
    const sales = await fakeService();
    try {
      fakeEnv(sales.url, customer.url);
      check(() => assert.equal(boundPack(), null));
      const runtime = await engineRuntime(new Meter(1), 'sim-fake-customer', fakePrices, { configDir: fixtureDir });
      try {
        check(() => assert.equal(process.env.SOP_PATH, path.join(fixtureDir, 'sop.md')));
        check(() => assert.equal(process.env.ROUTES_PATH, undefined));
        check(() => assert.equal(process.env.HOTELS_PATH, undefined));
        check(() => assert.equal(runtime.metadata.brand, '虚构方盒核验社'));
        check(() => assert.equal(runtime.metadata.config, 'config-dir'));
        check(() => assert.equal(boundPack()?.runtime.id, '__fixture'));
        check(() => assert.equal(currentCatalog().items.widget?.length, fixtureWidgetCount()));
      } finally {
        await runtime.close();
      }
      check(() => assert.equal(process.env.SOP_PATH, undefined));
      // 关闭时放回建 runtime 之前的样子：这里是没绑过包、没有快照
      check(() => assert.equal(boundPack(), null));
      check(() => assert.equal(fileCatalogKeys(), 0));

      // 回归 1：同一进程里 证明包 → 旅游 → 证明包。包绑定与产品库快照跟着配置目录走，不串
      const open = async (configDir: string | undefined) =>
        engineRuntime(new Meter(1), 'sim-fake-customer', fakePrices, configDir === undefined ? {} : { configDir });
      const oneWidget = copyFixture('one-widget');
      fs.writeFileSync(widgetFile(oneWidget), JSON.stringify([JSON.parse(fs.readFileSync(widgetFile(fixtureDir), 'utf8'))[1]]));
      for (const [label, configDir, expect] of [
        ['证明包', fixtureDir, { pack: '__fixture', widgets: fixtureWidgetCount(), brand: '虚构方盒核验社' }],
        ['旅游（data/）', undefined, { pack: 'travel', widgets: null, brand: 'legacy' }],
        ['证明包（第二次）', fixtureDir, { pack: '__fixture', widgets: fixtureWidgetCount(), brand: '虚构方盒核验社' }],
        ['证明包的另一个目录（只有一条 widget）', oneWidget, { pack: '__fixture', widgets: 1, brand: '虚构方盒核验社' }],
        ['旅游（data/，第二次）', undefined, { pack: 'travel', widgets: null, brand: 'legacy' }],
      ] as const) {
        const rt = await open(configDir);
        try {
          check(() => assert.equal(currentPack().runtime.id, expect.pack, label));
          check(() => assert.equal(rt.metadata.brand, expect.brand, label));
          if (expect.widgets === null) check(() => assert.throws(() => currentCatalog(), ConfigNotReadyError, label));
          else check(() => assert.equal(currentCatalog().items.widget?.length, expect.widgets, label));
          check(() => assert.equal(process.env.ROUTES_PATH === undefined, expect.widgets !== null, label));
        } finally {
          await rt.close();
        }
        check(() => assert.equal(boundPack(), null, `${label}：关闭后放回没绑`));
        check(() => assert.equal(fileCatalogKeys(), 0, `${label}：关闭后放回没有快照`));
      }

      // 回归 2：非旅游产品库在开始任何目标前就装载并校验。widget.json 为 [] 或条目不合格，engineRuntime 直接以 catalog_startup 失败，
      // 失败也把环境、包绑定与快照放回去，之后好的目录照常能建
      for (const [label, content, re] of [
        ['widget.json 为 []', '[]\n', /catalog_startup.*widget/],
        [
          '单价三位小数',
          JSON.stringify([{ id: 'w-bad', title: '合成方盒', unitPrice: 3.655, unit: '件', tags: [] }]),
          /catalog_startup.*第 1 条不合格/,
        ],
      ] as const) {
        const bad = copyFixture('bad-catalog');
        fs.writeFileSync(widgetFile(bad), content);
        await assert.rejects(open(bad), re, label);
        checks++;
        check(() => assert.equal(process.env.SOP_PATH, undefined, label));
        check(() => assert.equal(boundPack(), null, label));
        check(() => assert.equal(fileCatalogKeys(), 0, label));
        fs.rmSync(bad, { recursive: true });
      }
      const again = await open(fixtureDir);
      try {
        check(() => assert.equal(currentCatalog().items.widget?.length, fixtureWidgetCount()));
      } finally {
        await again.close();
      }
    } finally {
      await customer.close();
      await sales.close();
    }

    // v2 评测的 worker：配置目录有 pack.json 时不再默认 routes.json / hotels.json；没有时照旧默认到 data/。
    // 用 NODE_OPTIONS 的 --import 让 worker 进程退出时把自己的三个环境变量写出来
    const { runCaseV2 } = await import('../../eval/v2/run.js');
    const hook = path.join(tmp, 'env-hook.mjs');
    const out = path.join(tmp, 'worker-env.jsonl');
    fs.writeFileSync(
      hook,
      "import fs from 'node:fs';\nprocess.on('exit', () => fs.appendFileSync(process.env.FILE_PACK_ENV_OUT, JSON.stringify({ sop: process.env.SOP_PATH, routes: process.env.ROUTES_PATH, hotels: process.env.HOTELS_PATH }) + '\\n'));\n",
    );
    process.env.FILE_PACK_ENV_OUT = out;
    process.env.NODE_OPTIONS = `--import ${pathToFileURL(hook).href}`;
    const probe = {
      version: 2,
      id: 'file-pack-probe',
      desc: '配置目录装载探针',
      tags: [],
      fixtures: { now: '2026-10-02T12:00:00+08:00' },
      turns: [{ say: '你好', script: [{ content: '您好，请告诉我需求。' }], expect: {} }],
    } as never;
    const workerEnv = async (sop: string | undefined) => {
      fs.rmSync(out, { force: true });
      if (sop === undefined) delete process.env.SOP_PATH;
      else process.env.SOP_PATH = sop;
      const result = await runCaseV2(probe);
      assert.equal(result.pass, true, result.failures.join('\n'));
      const seen = fs
        .readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, string | undefined>);
      assert.ok(seen.length >= 1);
      return seen.at(-1)!;
    };
    const packEnv = await workerEnv(path.join(fixtureDir, 'sop.md'));
    check(() => assert.deepEqual(packEnv, { sop: path.join(fixtureDir, 'sop.md') }));
    const travelEnv = await workerEnv(undefined);
    check(() =>
      assert.deepEqual(travelEnv, {
        sop: path.resolve('data/sop.md'),
        routes: path.resolve('data/routes.json'),
        hotels: path.resolve('data/hotels.json'),
      }),
    );
    delete process.env.NODE_OPTIONS;
    console.log(`FILE PACK SELFTEST（模拟评测）PASS：${checks} 项`);
  } else {
    // ---------------- 二（先做）：评测不走 initConfig，进程里还没绑包，按 pack.json 惰性装载 ----------------
    check(() => assert.equal(boundPack(), null));
    process.env.SOP_PATH = path.join(fixtureDir, 'sop.md');
    check(() => assert.equal(configMode(), 'file'));
    const lazy = currentCatalog();
    check(() => assert.equal(boundPack()?.runtime.id, '__fixture'));
    check(() => assert.equal(currentPack().brand?.brandName, '虚构方盒核验社'));
    check(() => assert.equal(lazy.items.widget?.length, fixtureWidgetCount()));
    check(() => assert.equal(fileCatalogKeys(), 1));
    // 回归 3：重置后不强制绑旅游。SOP_PATH 还指着证明包，重置之后惰性入口照 pack.json 恢复成 __fixture
    __configTest.reset();
    check(() => assert.equal(boundPack(), null));
    check(() => assert.equal(fileCatalogKeys(), 0, '回归 4：重置后状态计数归 0'));
    check(() => assert.equal(currentPack().runtime.id, '__fixture'));
    check(() => assert.equal(currentCatalog().items.widget?.length, fixtureWidgetCount()));
    check(() => assert.equal(fileCatalogKeys(), 1, '回归 4：装载后状态计数是 1'));
    __configTest.reset();
    check(() => assert.equal(fileCatalogKeys(), 0));

    // ---------------- 一、没有 pack.json = 旅游，与以前相同 ----------------
    // 锁定套件的配置目录就是 data/：这里不能有 pack.json、catalog/，参考配置放 data/packs/<id>/
    check(() => assert.equal(fs.existsSync('data/pack.json'), false));
    check(() => assert.equal(fs.existsSync('data/catalog'), false));
    check(() =>
      assert.deepEqual(
        fs
          .readdirSync('data')
          .filter((f) => /pack|catalog/.test(f))
          .toSorted(),
        ['packs'],
      ),
    );
    check(() => assert.deepEqual(fs.readdirSync('data/packs').toSorted(), ['__fixture']));
    check(() => assert.equal(fs.existsSync('data/packs/__fixture/pack.json'), true));

    const noise = path.join(tmp, 'noise');
    fs.mkdirSync(path.join(noise, 'catalog'), { recursive: true });
    fs.copyFileSync('data/sop.md', path.join(noise, 'sop.md'));
    fs.copyFileSync(widgetFile(fixtureDir), widgetFile(noise));
    const explicitTravel = path.join(tmp, 'explicit-travel');
    fs.mkdirSync(explicitTravel);
    fs.copyFileSync('data/sop.md', path.join(explicitTravel, 'sop.md'));
    fs.writeFileSync(path.join(explicitTravel, 'pack.json'), '{ "id": "travel" }\n');
    fs.mkdirSync(path.join(explicitTravel, 'catalog'));
    fs.copyFileSync(widgetFile(fixtureDir), widgetFile(explicitTravel));

    for (const [label, sopPath] of [
      ['data/（没有 SOP_PATH）', undefined],
      ['data/sop.md（SOP_PATH 指向 data/）', path.resolve('data/sop.md')],
      ['目录里有无关的 catalog/，没有 pack.json', path.join(noise, 'sop.md')],
      ['pack.json 写的就是 travel', path.join(explicitTravel, 'sop.md')],
    ] as const) {
      if (sopPath === undefined) delete process.env.SOP_PATH;
      else process.env.SOP_PATH = sopPath;
      __configTest.reset();
      const log = await spyFs(() => initConfig(null));
      check(() => assert.equal(currentPack().runtime.id, 'travel', label));
      check(() => assert.equal(currentPack().brand, null, label));
      check(() => assert.throws(() => currentCatalog(), ConfigNotReadyError, label));
      // 旅游不读 catalog/、不读 pack.json 的内容（没有这个文件时只看一眼它在不在）、不写盘
      check(() =>
        assert.deepEqual(
          [...log.read, ...log.exists].filter((p) => /[\\/]catalog([\\/]|$)/.test(p)),
          [],
          label,
        ),
      );
      check(() =>
        assert.deepEqual(
          log.read.filter((p) => p.endsWith('pack.json') && !p.startsWith(explicitTravel)),
          [],
          label,
        ),
      );
      check(() => assert.deepEqual(log.write, [], label));
    }
    delete process.env.SOP_PATH;
    __configTest.reset();

    // ---------------- 二：用 data/packs/__fixture/ 当配置目录 ----------------
    process.env.SOP_PATH = path.join(fixtureDir, 'sop.md');
    const loadLog = await spyFs(() => initConfig(null));
    // 对照：非旅游包读的是 pack.json 与 catalog/widget.json（上面旅游那几遍什么都没读到，不是探针失灵）
    check(() => assert.ok(loadLog.read.includes(path.join(fixtureDir, 'pack.json'))));
    check(() => assert.ok(loadLog.read.includes(widgetFile(fixtureDir))));
    const runtime = currentPack().runtime;
    check(() => assert.equal(runtime.id, '__fixture'));
    check(() => assert.equal(configMode(), 'file'));
    check(() => assert.equal(currentPack().brand?.brandName, '虚构方盒核验社'));
    check(() => assert.equal(fileCatalogKeys(), 1));
    const snapshot = currentCatalog();
    const onDisk = JSON.parse(fs.readFileSync(widgetFile(fixtureDir), 'utf8')) as { id: string; tiers?: unknown[] }[];
    check(() => assert.deepEqual(snapshot.items.widget, onDisk));
    check(() => assert.ok(onDisk.length >= 3));
    check(() =>
      assert.ok(
        onDisk.some((w) => w.tiers && w.tiers.length >= 2),
        '至少一条带阶梯价',
      ),
    );
    check(() => assert.deepEqual(snapshot.routes, []));
    check(() => assert.deepEqual(snapshot.hotels, []));
    check(() => assert.deepEqual(Object.keys(snapshot.items), ['widget']));
    check(() => assert.deepEqual(snapshot.versions, Object.fromEntries(onDisk.map((w) => [`widget:${w.id}`, 1]))));
    check(() => assert.equal(snapshot.generation, 0));
    check(() =>
      assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.items.widget) && Object.isFrozen(snapshot.items.widget![0])),
    );
    check(() => assert.throws(() => (snapshot.items.widget as unknown[]).push({}), TypeError));
    check(() => assert.equal(currentCatalog(), snapshot, '进程内读一次'));
    for (const item of onDisk) check(() => assert.equal(runtime.catalog.widget!.schema.safeParse(item).success, true, item.id));
    // 包自己的取数口（检索条目）经 currentCatalog() 读到文件里的 widget
    check(() =>
      assert.deepEqual(
        runtime.retrievalItems().map((i) => i.code),
        onDisk.map((w) => w.id),
      ),
    );
    check(() => assert.deepEqual(runtime.catalogStartupCheck?.(snapshot), null));
    // 模板模式：镜像取 data/packs/__fixture/sop.md，品牌取同目录的 brand.json
    const rendered = renderFileSop(fs.readFileSync(path.join(fixtureDir, 'sop.md'), 'utf8'));
    check(() => assert.match(rendered, /虚构方盒核验社/));
    check(() => assert.doesNotMatch(rendered, /山海|云途/));

    // OTel 的包名与启动预检
    const { agentName } = await withoutTenantScope(() => import('../ops/otel.js'));
    check(() => assert.equal(agentName(), '__fixture'));
    const { startupPreflight } = await withoutTenantScope(() => import('../server.js'));
    const bogus = path.join(tmp, 'no-routes.json');
    process.env.ROUTES_PATH = bogus;
    process.env.HOTELS_PATH = bogus;
    assert.deepEqual(await spyConsoleError(() => startupPreflight()), [], '非旅游包没有 routes.json 也不打「数据文件损坏」');
    checks++;
    delete process.env.ROUTES_PATH;
    delete process.env.HOTELS_PATH;

    // 回归 1（直接换路径）：同一进程里不重置也不重新装载，直接换 SOP_PATH，currentCatalog() 与包绑定跟着配置目录走，不再返回原快照
    const other = copyFixture('other-dir');
    fs.writeFileSync(widgetFile(other), JSON.stringify([onDisk[0]]));
    process.env.SOP_PATH = path.join(other, 'sop.md');
    check(() => assert.equal(currentCatalog().items.widget?.length, 1));
    check(() => assert.notEqual(currentCatalog(), snapshot));
    check(() => assert.equal(currentPack().runtime.id, '__fixture'));
    delete process.env.SOP_PATH;
    check(() => assert.throws(() => currentCatalog(), ConfigNotReadyError, '换回 data/：产品库作废，回到旅游的老样子'));
    check(() => assert.equal(currentPack().runtime.id, 'travel'));
    check(() => assert.equal(fileCatalogKeys(), 0));

    // 旅游：OTel 包名 travel，预检照旧调 loadRoutes()：ROUTES_PATH 指向不存在的文件就打「数据文件损坏」，正常文件不打
    delete process.env.SOP_PATH;
    __configTest.reset();
    await initConfig(null);
    check(() => assert.equal(agentName(), 'travel'));
    assert.deepEqual(await spyConsoleError(() => startupPreflight()), []);
    process.env.ROUTES_PATH = bogus;
    const errors = await spyConsoleError(() => startupPreflight());
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /数据文件损坏.*线路数据缺失/);
    checks += 2;
    delete process.env.ROUTES_PATH;

    // ---------------- 三、拒绝 ----------------
    const fresh = (name: string): string => {
      const dir = copyFixture(name);
      useDir(dir);
      return dir;
    };
    let dir = fresh('empty');
    fs.writeFileSync(widgetFile(dir), '[]\n');
    await rejectsWith('widget.json 清空', 'catalog_startup', /widget/);
    dir = fresh('missing');
    fs.rmSync(path.join(dir, 'catalog'), { recursive: true });
    await rejectsWith('catalog/ 整个没有（缺文件是空数组，包的启动检查拒绝）', 'catalog_startup', /widget/);
    dir = fresh('bad-item');
    fs.writeFileSync(widgetFile(dir), JSON.stringify([{ ...onDisk[0], unitPrice: 3.655 }]));
    await rejectsWith('单价三位小数', 'catalog_startup', /widget\.json 第 1 条不合格.*unitPrice/);
    dir = fresh('extra-key');
    fs.writeFileSync(widgetFile(dir), JSON.stringify([{ ...onDisk[0], price: 1 }]));
    await rejectsWith('多余字段', 'catalog_startup', /第 1 条不合格/);
    dir = fresh('dup');
    fs.writeFileSync(widgetFile(dir), JSON.stringify([onDisk[0], onDisk[1], onDisk[0]]));
    await rejectsWith('id 重复', 'catalog_startup', new RegExp(`${onDisk[0]!.id}.*重复`));
    dir = fresh('not-array');
    fs.writeFileSync(widgetFile(dir), JSON.stringify({ items: onDisk }));
    await rejectsWith('不是数组', 'catalog_startup', /必须是数组/);
    dir = fresh('bad-json');
    fs.writeFileSync(widgetFile(dir), '[{"id": ');
    await rejectsWith('JSON 语法错误', 'catalog_startup', /widget\.json 读不出来/);
    dir = fresh('bad-bytes');
    fs.writeFileSync(widgetFile(dir), Buffer.from([0x5b, 0xff, 0x5d]));
    await rejectsWith('非法 UTF-8', 'catalog_startup', /widget\.json 读不出来/);

    dir = fresh('unknown-pack');
    fs.writeFileSync(path.join(dir, 'pack.json'), '{ "id": "no-such-pack" }\n');
    await rejectsWith('pack.json 指向没有的包', 'pack_unknown', /no-such-pack/);
    for (const [what, text] of [
      ['不是 JSON', 'not json'],
      ['缺 id', '{}'],
      ['id 不是字符串', '{ "id": 1 }'],
      ['多余字段', '{ "id": "__fixture", "catalog": "x" }'],
      ['id 带路径', '{ "id": "../travel" }'],
      ['根不是对象', '[]'],
    ] as const) {
      dir = fresh('bad-pack-file');
      fs.writeFileSync(path.join(dir, 'pack.json'), text);
      await rejectsWith(`pack.json ${what}`, 'pack_unknown', /pack\.json 不合格/);
    }
    dir = fresh('no-brand');
    fs.rmSync(path.join(dir, 'brand.json'));
    await rejectsWith('非旅游包没有 brand.json（只支持模板模式）', 'brand_required', /__fixture/);

    // 拒绝之后卸下配置，回到旅游：与别的自测互不影响
    delete process.env.SOP_PATH;
    __configTest.reset();
    check(() => assert.equal(currentPack().runtime.id, 'travel'));
    check(() => assert.throws(() => currentCatalog(), ConfigNotReadyError));
    console.log(`FILE PACK SELFTEST PASS：${checks} 项`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
