// 08 第 19 步：注册表的同一行分派与 DB 未绑定时拒绝处理（PGlite），文件模式仍按 pack.json。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.argv[2] !== 'worker') {
  for (const enabled of [false, true]) {
    const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_SOURCE: 'db', SESSION_STORE: 'file', LLM_MOCK: '1', PG_TEST_URL: '' };
    delete env.PACK_FIXTURES;
    if (enabled) env.PACK_FIXTURES = '1';
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
  }
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-binding-'));
  process.env.VAR_DIR = dir;
  const { hostRuntime, withoutTenantScope } = await import('../tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const source = await withoutTenantScope(() => import('./source.js'));
  const { currentPack, packSources, configMode, initConfig, closeConfig, __configTest, ConfigNotReadyError } = source;
  const { PACK_IDS, packById, runtimeById, defaultQuickRepliesOf, sopConsistencyOf } = await import('../packs/registry.js');
  const { boundPack } = await import('../core/pack-api.js');
  const { handleMessage } = await import('../core/engine/index.js');
  const { observeRequests } = await import('../core/llm/client.js');
  const store = await import('../store.js');
  const { openTestDb, installSeededConfig, testConfigDeps, fakeLock } = await import('../db/testing.js');
  const t = await openTestDb();
  let modelCalls = 0;
  observeRequests(() => modelCalls++);
  const unboundError = (e: unknown): boolean => e instanceof ConfigNotReadyError && e.message === 'DB 模式没有绑定行业包';
  try {
    assert.deepEqual(PACK_IDS, process.env.PACK_FIXTURES === '1' ? ['travel', 'industrial', '__fixture'] : ['travel', 'industrial']);
    for (const id of ['unknown', 'toString', 'constructor', '__proto__']) {
      assert.equal(packById(id), null);
      assert.equal(runtimeById(id, packSources()), null);
      assert.deepEqual(defaultQuickRepliesOf(id), []);
      assert.equal(sopConsistencyOf({ id, consistencyRules: [{ id: 'unknown', scope: ['sop'], a: 'a', b: 'b', why: '合成规则' }] }), null);
    }
    const travel = runtimeById('travel', packSources())!;
    assert.ok(defaultQuickRepliesOf('travel').length > 0);
    assert.ok(Object.isFrozen(defaultQuickRepliesOf('travel')));
    assert.ok(sopConsistencyOf(travel));
    assert.equal(sopConsistencyOf({ ...travel, consistencyRules: [] }), null);
    // 旅游工厂复用门面缓存；阶段被误改也必须在下一次取包时拒绝，之后恢复。
    const stages = travel.stages;
    try {
      travel.stages = [];
      assert.throws(() => runtimeById('travel', packSources()), /travel.*后台与运行时阶段不一致/);
    } finally {
      travel.stages = stages;
    }
    assert.equal(runtimeById('travel', packSources()), travel);

    const assertNoTurn = async (id: string): Promise<void> => {
      const before = modelCalls;
      store.flushStoreNow();
      const savedFiles = () => Object.fromEntries(fs.readdirSync(dir).map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));
      const files = savedFiles();
      assert.equal(configMode(), 'db');
      assert.equal(boundPack(), null);
      assert.throws(currentPack, unboundError);
      // 拒绝 Promise，因而没有任何对客回复（包括旅游话术）。
      await assert.rejects(handleMessage(id, '你好，想了解产品', 'web'), unboundError);
      assert.equal(modelCalls, before, '未进入模型入口（mock 与真实请求之前的观察钩子）');
      assert.equal(store.getSession(id), undefined, '未创建内存会话');
      store.flushStoreNow();
      assert.deepEqual(savedFiles(), files, '会话文件字节不变');
      assert.equal(boundPack(), null, '失败后没有偷偷绑旅游');
    };
    await assertNoTurn('unbound-before-init');

    await installSeededConfig(t);
    assert.equal(currentPack().runtime.id, 'travel');
    // 装载过 PGlite 的运行时丢失绑定，也必须在会话创建与模型之前拒绝。
    Reflect.set(rt, 'pack', undefined);
    await assertNoTurn('unbound-loaded');
    await closeConfig();
    __configTest.reset();
    assert.throws(currentPack, unboundError);
    await initConfig(testConfigDeps(t));
    const reply = await handleMessage('bound-travel', '想去云南玩6天，两个人', 'web');
    assert.ok(reply.text.length > 0);
    assert.ok(travel.stages.some((stage) => stage.id === reply.stage));
    assert.ok(store.getSession('bound-travel'));
    assert.ok(modelCalls > 0);
    await closeConfig();
    __configTest.reset();
    assert.equal(boundPack(), null);
    assert.throws(currentPack, unboundError);

    if (process.env.PACK_FIXTURES === '1') {
      const { createFixtureTenant } = await import('../tenancy/fixture-testing.js');
      const { importConfig } = await import('./transfer.js');
      const { readImageSop } = await import('./brand.js');
      await t.pg.exec('RESET ROLE');
      const tenant = await createFixtureTenant(t.db);
      await t.pg.exec('SET ROLE agent_app');
      const imported = await importConfig({
        db: t.db,
        tenantSlug: tenant.slug,
        dataDir: 'data/packs/__fixture',
        imageSop: (id) => readImageSop(id),
        lock: async () => fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      await initConfig(testConfigDeps(t, { tenantSlug: tenant.slug, usePackRuntime: true }));
      assert.equal(currentPack().runtime.id, '__fixture');
      assert.deepEqual(defaultQuickRepliesOf('__fixture'), []);
      assert.equal(sopConsistencyOf(currentPack().runtime), null);
      const before = modelCalls;
      const fixtureReply = await handleMessage('bound-fixture', '请核验需求', 'web');
      assert.equal(fixtureReply.text, '已核验：需求已经核验');
      assert.ok(store.getSession('bound-fixture'));
      assert.ok(modelCalls > before);
      await closeConfig();
      __configTest.reset();
      assert.throws(currentPack, unboundError);
    } else {
      assert.equal(packById('__fixture'), null);
      assert.equal(runtimeById('__fixture', packSources()), null);
    }

    // DB 模式也可能只由 dbInstalled 决定，不能靠 CONFIG_SOURCE 环境变量才拦住。
    process.env.CONFIG_SOURCE = 'file';
    await initConfig(testConfigDeps(t));
    Reflect.set(rt, 'pack', undefined);
    await assertNoTurn('unbound-db-installed');
    await closeConfig();
    __configTest.reset();
    process.env.SOP_PATH = path.resolve('data/sop.md');
    assert.equal(boundPack(), null);
    assert.equal(configMode(), 'file');
    assert.equal(currentPack().runtime.id, 'travel');
    if (process.env.PACK_FIXTURES === '1') {
      __configTest.reset();
      process.env.SOP_PATH = path.resolve('data/packs/__fixture/sop.md');
      assert.equal(boundPack(), null);
      assert.equal(currentPack().runtime.id, '__fixture');
    }
    store.flushStoreNow();
    console.log(
      `REGISTRY BINDING SELFTEST PASS：PACK_FIXTURES=${process.env.PACK_FIXTURES ?? '未设'}；PGlite 未绑定拒绝、模型零调用、会话零写入；显式绑定与文件惰性装载`,
    );
  } finally {
    observeRequests(null);
    await closeConfig();
    __configTest.reset();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
