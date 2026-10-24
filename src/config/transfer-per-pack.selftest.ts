// 08 第 18 步（R11 的导出导入与评测目录）：export-config、import-config、模拟评测的 --config-dir 按包。PGlite，没有任何真实模型调用。
//   一、export-config：旅游输出与开工时（基点 96f1159）逐字节相同；先导出旅游到一个目录，再向同一目录导出证明包，routes.json、hotels.json 被删，
//      有 pack.json 与 catalog/widget.json；反过来再导出旅游，pack.json 与 catalog/ 被删，各文件与第一次逐字节相同；目录里别的文件不碰。
//   二、import-config：证明包目录导入证明包租户成功（条目、版本 1、审计）、再导入一致、改了就 2；导入旅游租户被拒（点名两边的包，不取锁）；
//      坏数据的拒绝原因同文件模式装载；导出的目录能原样导入另一个证明包租户。
//   三、--config-dir：证明包目录缺 catalog/widget.json 被拒并点名（resolveConfigDir 与 gate.ts 的退出码 2）；旅游目录照旧。
// 证明包只在 PACK_FIXTURES=1 时登记，所以放在子进程里跑。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 开工时（基点 96f1159）导入 data/ 再导出得到的旅游文件的 sha256。data/ 或渲染变了要重新钉住（做法见 gate-per-pack.selftest.ts 头部） */
const TRAVEL_EXPORT = {
  'hotels.json': 'cd13af1d7d88d70e2e852f8bd45ef0966b5fd688ad8e90c189d2c1fd34680e9a',
  'policy.json': 'a1dd1c22e1722a0e2db12f2b1e20b0b4fb4c0c84eaad153b1b64584d20f46ef2',
  'routes.json': '76994353e80a276648bcafcf63edb67313a0936610e7ddcb6709ff78dde5ceaf',
  'sop.md': '1f850038290b202f66573695faee972bd0b03a3da9ec3e62e665ff5fa6b81ba3',
} as const;

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
  const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-per-pack-'));
  process.env.VAR_DIR = path.join(root, 'state');
  const { hostRuntime, withoutTenantScope } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  enterTenantScopeForTest(hostRuntime());
  const { openTestDb, fakeLock } = await withoutTenantScope(() => import('../db/testing.js'));
  const { withTenant } = await import('../db/client.js');
  const { readActiveCatalog } = await import('../db/repo/catalog.js');
  const { readCatalogVersions } = await import('../db/repo/catalog-versions.js');
  const { createFixtureTenant } = await import('../tenancy/fixture-testing.js');
  const { importConfig, exportConfig, defaultDataDir } = await import('./transfer.js');
  const { readImageSop } = await import('./brand.js');
  const { resolveConfigDir, CONFIG_DIR_REQUIRED, PACK_DIR_REQUIRED } = await import('../../eval/sim/runtime.js');
  const config = await import('./source.js');

  let checks = 0;
  const check = (name: string, ok: unknown): void => {
    assert.ok(ok, name);
    checks++;
  };
  const eq = (name: string, actual: unknown, expected: unknown): void => {
    assert.deepEqual(actual, expected, name);
    checks++;
  };
  const fixtureDir = path.resolve('data/packs/__fixture');
  const reference = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'catalog/widget.json'), 'utf8')) as { id: string }[];
  const md = fs.readFileSync('data/sop.md', 'utf8');
  const copyFixture = (name: string): string => {
    const dir = path.join(root, name);
    fs.cpSync(fixtureDir, dir, { recursive: true });
    return dir;
  };
  const tree = (dir: string): string[] =>
    (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
      .filter((e) => e.isFile())
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
      .toSorted();
  const hashOf = (dir: string, files: readonly string[]): Record<string, string> =>
    Object.fromEntries(files.map((f) => [f, sha(fs.readFileSync(path.join(dir, f)))]));

  const lite = await openTestDb();
  try {
    // 建租户是平台的事，以超级用户做；之后的读写都是 agent_app
    await lite.pg.query("insert into tenants(slug,name,pack_id) values ('xfer-travel','按包导出','travel')");
    const fixtureTenants: Record<string, Awaited<ReturnType<typeof createFixtureTenant>>> = {};
    for (const slug of ['xfer-fixture', 'xfer-fixture-2', 'xfer-fixture-bad', 'xfer-fixture-dry', 'xfer-fixture-default'])
      fixtureTenants[slug] = await createFixtureTenant(lite.db, { slug });
    await lite.pg.exec('SET ROLE agent_app');
    const sys = { kind: 'system' as const, userId: null, name: null, ip: null };
    const imageOf = (packId: string): string => readImageSop(packId);
    const noLock = async (): Promise<never> => {
      throw new Error('不应取锁');
    };
    const importFixture = (slug: string, dataDir: string, over: Partial<Parameters<typeof importConfig>[0]> = {}) =>
      importConfig({ db: lite.db, tenantSlug: slug, dataDir, imageSop: imageOf, lock: async () => fakeLock(), ...over });

    // ---------------- 一、export-config ----------------
    const travelImport = await importConfig({
      db: lite.db,
      tenantSlug: 'xfer-travel',
      dataDir: 'data',
      imageSop: md,
      lock: async () => fakeLock(),
    });
    assert.equal(travelImport.code, 0, travelImport.message);
    check('旅游导入的文字不变', travelImport.message === '已导入 SOP v1、20 条线路、23 家酒店');
    const importedFixture = await importFixture('xfer-fixture', fixtureDir);
    assert.equal(importedFixture.code, 0, importedFixture.message);

    const out = path.join(root, 'out');
    const exportTo = (slug: string, dir = out) => exportConfig({ db: lite.db, tenantSlug: slug, outDir: dir, imageSop: imageOf });
    const travelOnly = ['hotels.json', 'policy.json', 'routes.json', 'sop.md'];

    const first = await exportTo('xfer-travel');
    assert.equal(first.code, 0, first.message);
    check('旅游导出的文字不变', first.message === `已导出 SOP v1、20 条线路、23 家酒店到 ${out}`);
    eq('旅游导出：只有这四个文件', tree(out), travelOnly);
    eq('旅游导出：逐字节同开工时', hashOf(out, travelOnly), TRAVEL_EXPORT);
    fs.writeFileSync(path.join(out, 'notes.txt'), '目录里别的文件不碰');

    // 向旧的旅游导出目录再导出证明包：routes.json、hotels.json 被删
    fs.mkdirSync(path.join(out, 'catalog'));
    fs.writeFileSync(path.join(out, 'catalog', 'stale.json'), '[]');
    const toFixture = await exportTo('xfer-fixture');
    assert.equal(toFixture.code, 0, toFixture.message);
    eq('证明包导出的文件（旧的 routes / hotels / catalog/stale 都没了，notes.txt 还在）', tree(out), [
      'brand.json',
      'catalog/widget.json',
      'notes.txt',
      'pack.json',
      'policy.json',
      'sop.md',
    ]);
    eq('pack.json', JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8')), { id: '__fixture' });
    eq(
      'catalog/widget.json 就是库里 active 的 widget',
      JSON.parse(fs.readFileSync(path.join(out, 'catalog/widget.json'), 'utf8')),
      reference,
    );
    check(
      'catalog/widget.json 的写法同其他导出（两空格缩进、末尾换行）',
      fs.readFileSync(path.join(out, 'catalog/widget.json'), 'utf8') === `${JSON.stringify(reference, null, 2)}\n`,
    );
    check('证明包导出的文字', toFixture.message === `已导出 SOP v1、widget ${reference.length} 条到 ${out}`);
    check('notes.txt 没动', fs.readFileSync(path.join(out, 'notes.txt'), 'utf8') === '目录里别的文件不碰');

    // 反过来：再导出旅游，pack.json 与 catalog/ 被删，各文件与第一次逐字节相同（brand.json 本来就随品牌有无增删）
    fs.writeFileSync(path.join(out, 'catalog', 'again.json'), '[]');
    const back = await exportTo('xfer-travel');
    assert.equal(back.code, 0, back.message);
    eq('再导出旅游：回到四个文件加 notes.txt', tree(out), [...travelOnly, 'notes.txt'].toSorted());
    eq('再导出旅游：各文件与第一次逐字节相同', hashOf(out, travelOnly), TRAVEL_EXPORT);
    check(
      '再导出旅游：没有 pack.json 与 catalog/',
      !fs.existsSync(path.join(out, 'pack.json')) && !fs.existsSync(path.join(out, 'catalog')),
    );

    // 同一个目录连续导出证明包两次（目录已有 pack.json 与 catalog/）：幂等
    await exportTo('xfer-fixture');
    const snapshot = hashOf(out, tree(out));
    await exportTo('xfer-fixture');
    eq('证明包导出两次相同', hashOf(out, tree(out)), snapshot);

    // 导出失败不删东西：租户不存在 / 没有已发布 SOP 都在写盘之前返回
    const before = tree(out);
    assert.equal((await exportTo('nobody')).code, 1);
    eq('失败的导出不动目录', tree(out), before);
    checks++;

    // ---------------- 二、import-config ----------------
    const fixtureCtx = { tenantId: fixtureTenants['xfer-fixture']!.id, actor: sys };
    {
      const rows = await withTenant(lite.db, fixtureCtx, readActiveCatalog);
      eq(
        '证明包导入：active 条目就是 catalog/widget.json，ord 是数组下标',
        rows.map((r) => [r.kind, r.code, r.ord]),
        reference.map((w, i) => ['widget', w.id, i]),
      );
      const versions = await withTenant(lite.db, fixtureCtx, readCatalogVersions);
      eq(
        '证明包导入：每条写版本 1',
        versions.map((v) => `${v.kind}|${v.code}|${v.version}|${v.source}`).toSorted(),
        reference.map((w) => `widget|${w.id}|1|activate`).toSorted(),
      );
      check(
        '证明包导入的文字',
        importedFixture.message === `已导入 SOP v1、widget ${reference.length} 条` && importedFixture.versionNo === 1,
      );
      await lite.pg.exec('RESET ROLE');
      const audit = (
        await lite.pg.query<{ diff: { sections: number; items: Record<string, number> } }>(
          "select diff from audit_log where tenant_id=$1 and action='config.import'",
          [fixtureCtx.tenantId],
        )
      ).rows;
      await lite.pg.exec('SET ROLE agent_app');
      check('证明包导入的审计：条数按 kind 记', audit.length === 1 && audit[0]!.diff.sections > 0);
      eq('证明包导入的审计：items', audit[0]!.diff.items, { widget: reference.length });
    }
    const again = await importFixture('xfer-fixture', fixtureDir);
    check('再导入一致：没有写入', again.code === 0 && again.message === '库里已是这份内容，没有写入');
    const changed = copyFixture('changed');
    fs.writeFileSync(
      path.join(changed, 'catalog/widget.json'),
      JSON.stringify(
        reference.map((w, i) => (i === 0 ? { ...w, title: '改了名' } : w)),
        null,
        2,
      ),
    );
    const diff = await importFixture('xfer-fixture', changed);
    check('条目不同：2，库没动', diff.code === 2 && /产品库的 active 条目不同/.test(diff.message));
    const stillRows = await withTenant(lite.db, fixtureCtx, readActiveCatalog);
    check(
      '库没动',
      stillRows.every((r, i) => (r.payload as { title?: string }).title === (reference[i] as { title?: string }).title),
    );

    // 导出的目录原样导入另一个证明包租户
    const roundtrip = path.join(root, 'roundtrip');
    await exportTo('xfer-fixture', roundtrip);
    const second = await importFixture('xfer-fixture-2', roundtrip);
    check(
      `导出的目录能导入另一个证明包租户：${second.message}`,
      second.code === 0 && second.hashes?.promptHash === importedFixture.hashes?.promptHash,
    );
    const secondRows = await withTenant(lite.db, { tenantId: fixtureTenants['xfer-fixture-2']!.id, actor: sys }, readActiveCatalog);
    eq(
      '导入的条目与导出前一致',
      secondRows.map((r) => r.payload),
      reference,
    );

    // dry-run：只报会写什么，库里什么都没有
    const dry = await importFixture('xfer-fixture-dry', fixtureDir, { dryRun: true });
    check('dry-run 的文字', dry.code === 0 && dry.message === `dry-run：会写入 SOP v1、widget ${reference.length} 条`);
    eq(
      'dry-run 没写条目',
      await withTenant(lite.db, { tenantId: fixtureTenants['xfer-fixture-dry']!.id, actor: sys }, readActiveCatalog),
      [],
    );

    // 没传 --data（命令行缺省，清单 7.23）：解析出租户的包之后按包取目录——旅游 ./data，其他包 ./data/packs/<包>/
    eq('缺省目录：旅游', defaultDataDir('travel'), path.join(process.cwd(), 'data'));
    eq('缺省目录：证明包', defaultDataDir('__fixture'), fixtureDir);
    eq('缺省目录可指定根', defaultDataDir('__fixture', '/srv/app'), path.join('/srv/app', 'data', 'packs', '__fixture'));
    assert.throws(() => defaultDataDir('../x'), /不合法/);
    checks++;
    const byDefault = await importFixture('xfer-fixture-default', fixtureDir, { dataDir: (packId) => defaultDataDir(packId) });
    check(
      `证明包租户不传 --data 导入成功：${byDefault.message}`,
      byDefault.code === 0 &&
        byDefault.message === importedFixture.message &&
        byDefault.hashes?.promptHash === importedFixture.hashes?.promptHash,
    );
    eq(
      '不传 --data 导入的条目就是参考配置的 catalog/widget.json',
      (await withTenant(lite.db, { tenantId: fixtureTenants['xfer-fixture-default']!.id, actor: sys }, readActiveCatalog)).map(
        (r) => r.payload,
      ),
      reference,
    );
    const travelByDefault = await importConfig({
      db: lite.db,
      tenantSlug: 'xfer-travel',
      dataDir: (packId) => defaultDataDir(packId),
      imageSop: md,
      lock: async () => fakeLock(),
    });
    check('旅游租户不传 --data 照旧读 ./data', travelByDefault.code === 0 && travelByDefault.message === '库里已是这份内容，没有写入');

    // 包与租户不符：点名两边的包，不取锁、不读条目
    const wrongForTravel = await importConfig({
      db: lite.db,
      tenantSlug: 'xfer-travel',
      dataDir: fixtureDir,
      imageSop: md,
      lock: noLock,
    });
    check(
      `旅游租户导入证明包目录被拒：${wrongForTravel.message}`,
      wrongForTravel.code === 1 &&
        /「__fixture」/.test(wrongForTravel.message) &&
        /「travel」/.test(wrongForTravel.message) &&
        /pack\.json 写的/.test(wrongForTravel.message),
    );
    const wrongForFixture = await importFixture('xfer-fixture-bad', 'data', { lock: noLock });
    check(
      `证明包租户导入旅游目录被拒：${wrongForFixture.message}`,
      wrongForFixture.code === 1 &&
        /「travel」/.test(wrongForFixture.message) &&
        /「__fixture」/.test(wrongForFixture.message) &&
        /没有 pack\.json/.test(wrongForFixture.message),
    );
    const other = copyFixture('other-pack');
    fs.writeFileSync(path.join(other, 'pack.json'), '{ "id": "elsewhere" }');
    const wrongOther = await importFixture('xfer-fixture-bad', other, { lock: noLock });
    check('目录是别的包', wrongOther.code === 1 && /「elsewhere」/.test(wrongOther.message) && /「__fixture」/.test(wrongOther.message));
    fs.writeFileSync(path.join(other, 'pack.json'), '{ "id": "__fixture", "extra": 1 }');
    const brokenPackFile = await importFixture('xfer-fixture-bad', other, { lock: noLock });
    check('pack.json 写坏', brokenPackFile.code === 1 && /pack\.json 不合格/.test(brokenPackFile.message));
    // 旅游租户导入旅游目录（有 pack.json 写 travel 也算）照旧
    const travelDir = path.join(root, 'travel-dir');
    fs.cpSync('data', travelDir, { recursive: true });
    fs.writeFileSync(path.join(travelDir, 'pack.json'), '{ "id": "travel" }');
    const travelAgain = await importConfig({
      db: lite.db,
      tenantSlug: 'xfer-travel',
      dataDir: travelDir,
      imageSop: md,
      lock: async () => fakeLock(),
    });
    check('pack.json 写 travel 的旅游目录照旧', travelAgain.code === 0 && travelAgain.message === '库里已是这份内容，没有写入');

    // 坏数据：拒绝原因同文件模式装载（source.ts 的 readCatalogFile），统一包在「文件不合格：」里
    const widgetFile = (dir: string): string => path.join(dir, 'catalog/widget.json');
    const bad = async (label: string, content: string | null, re: RegExp): Promise<void> => {
      const dir = copyFixture('bad');
      if (content === null) fs.rmSync(widgetFile(dir));
      else fs.writeFileSync(widgetFile(dir), content);
      const r = await importFixture('xfer-fixture-bad', dir);
      check(`${label}：${r.message}`, r.code === 1 && re.test(r.message) && r.message.startsWith('文件不合格：'));
      fs.rmSync(dir, { recursive: true });
    };
    await bad('缺文件', null, /catalog\/widget\.json 读不出来/);
    await bad('不是 JSON', '{', /catalog\/widget\.json 读不出来/);
    await bad('不是数组', '{}', /catalog\/widget\.json 必须是数组/);
    await bad(
      '单价三位小数',
      JSON.stringify([{ id: 'w-bad', title: '合成方盒', unitPrice: 3.655, unit: '件', tags: [] }]),
      /catalog\/widget\.json 第 1 条不合格/,
    );
    await bad(
      '没有 id',
      JSON.stringify([{ title: '合成方盒', unitPrice: 3, unit: '件', tags: [] }]),
      /catalog\/widget\.json 第 1 条不合格/,
    );
    await bad('id 重复', JSON.stringify([reference[0], reference[0]]), /catalog\/widget\.json 里 id「w-basic」重复/);
    eq(
      '坏数据一条都没写',
      await withTenant(lite.db, { tenantId: fixtureTenants['xfer-fixture-bad']!.id, actor: sys }, readActiveCatalog),
      [],
    );

    // ---------------- 三、--config-dir ----------------
    eq('旅游必需的文件不变', [...CONFIG_DIR_REQUIRED], ['sop.md', 'routes.json', 'hotels.json']);
    eq('其他包必需的文件（产品库另按包声明的 kind 逐个查）', [...PACK_DIR_REQUIRED], ['sop.md', 'pack.json']);
    const rejects = async (label: string, dir: string, re: RegExp): Promise<void> => {
      await assert.rejects(resolveConfigDir(dir), re, label);
      checks++;
    };
    const full = copyFixture('cfg-full');
    check('证明包目录齐全', (await resolveConfigDir(full)) === full);
    fs.rmSync(widgetFile(full));
    fs.writeFileSync(path.join(full, 'catalog/other.json'), '[]');
    await rejects('catalog/ 里有别的文件也不行：缺 catalog/widget.json 被拒并点名', full, /缺 catalog\/widget\.json/);
    fs.rmSync(path.join(full, 'catalog'), { recursive: true });
    await rejects('没有 catalog/ 目录', full, /缺 catalog\//);
    const ghost = copyFixture('cfg-ghost');
    fs.writeFileSync(path.join(ghost, 'pack.json'), '{ "id": "ghost" }');
    await rejects('pack.json 指向没登记的包', ghost, /「ghost」.*不在注册表里/);
    // 旅游目录照旧：缺 routes.json 点名；多余的 catalog/ 不管
    const cfgTravel = path.join(root, 'cfg-travel');
    fs.mkdirSync(path.join(cfgTravel, 'catalog'), { recursive: true });
    fs.copyFileSync('data/sop.md', path.join(cfgTravel, 'sop.md'));
    await rejects('旅游目录缺 routes.json', cfgTravel, /缺 routes\.json/);
    fs.copyFileSync('data/routes.json', path.join(cfgTravel, 'routes.json'));
    await rejects('旅游目录缺 hotels.json', cfgTravel, /缺 hotels\.json/);
    fs.copyFileSync('data/hotels.json', path.join(cfgTravel, 'hotels.json'));
    check('旅游目录齐全（多余的 catalog/ 不管）', (await resolveConfigDir(cfgTravel)) === cfgTravel);

    // 命令行：缺 catalog/widget.json 的证明包目录以退出码 2 拒绝，报错点名；没登记证明包的环境（生产）同样拒绝
    const gateCli = (dir: string, extraEnv: NodeJS.ProcessEnv) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'eval/sim/gate.ts',
          '--config-dir',
          dir,
          '--tag',
          'regression',
          '--budget',
          '1',
          '--report',
          path.join(root, 'report.jsonl'),
        ],
        { env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 },
      );
    const noWidget = copyFixture('cli-no-widget');
    fs.rmSync(widgetFile(noWidget));
    const cli = gateCli(noWidget, { PACK_FIXTURES: '1' });
    check(
      `gate.ts：缺 catalog/widget.json 以 2 退出并点名：${cli.stderr.trim()}`,
      cli.status === 2 && /缺 catalog\/widget\.json/.test(cli.stderr),
    );
    const unregistered = gateCli(copyFixture('cli-unregistered'), { PACK_FIXTURES: '' });
    check(
      `gate.ts：没登记的包以 2 退出：${unregistered.stderr.trim()}`,
      unregistered.status === 2 && /不在注册表里/.test(unregistered.stderr),
    );
    check('被拒的命令行没有写报告', !fs.existsSync(path.join(root, 'report.jsonl')));

    console.log(`TRANSFER PER PACK SELFTEST PASS: ${checks} 项断言`);
  } finally {
    config.__configTest.reset();
    await lite.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
