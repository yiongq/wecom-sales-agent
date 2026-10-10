// R2、R3、R16：生产与文件组合根的包绑定、假包隔离及真实核心对话。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.argv[2] !== 'worker') {
  for (const enabled of ['0', '1']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
      env: { ...process.env, PACK_FIXTURES: enabled, CONFIG_SOURCE: 'file', SESSION_STORE: 'file', LLM_MOCK: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  }
  console.log('包运行时自测通过：注册开关、阶段配对、假包工具/画像/护栏、旅游恢复与装载校验');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-runtime-'));
  process.env.VAR_DIR = dir;
  try {
    // 先证明配置源单独装载不加载存储，也能绑定旧版旅游（CLI 的装载顺序）。
    const config = await import('./source.js');
    await config.initConfig(null);
    assert.equal(config.currentPack().runtime.id, 'travel');
    assert.equal(config.currentPack().brand, null);
    const { packById, runtimeById } = await import('../packs/registry.js');
    const { bindPack } = await import('../core/pack-api.js');
    const { handleMessage, guardOutbound } = await import('../core/engine/index.js');
    const { packSources } = await import('../core/engine/sources.js');
    const { getSession, flushStoreNow } = await import('../store.js');
    const { onTurnEnd } = await import('../trace/recorder.js');
    const { onToolCall } = await import('../core/engine/index.js');
    const { checkPack } = await import('../shared/pack.js');
    assert.equal(packById('renovation'), null); // 原后台假包仍不登记。
    assert.equal(runtimeById('toString', packSources()), null);
    if (process.env.PACK_FIXTURES === '1') {
      const pack = packById('__fixture')!;
      assert.ok(pack);
      assert.deepEqual(checkPack(pack), []);
      const runtime = runtimeById(pack.id, packSources())!;
      assert.deepEqual(
        runtime.stages.map((s) => s.id),
        pack.stages.map((s) => s.key),
      );
      bindPack(runtime, null);
      const tools: string[] = [];
      const offTool = onToolCall((name) => tools.push(name));
      const turns: Parameters<Parameters<typeof onTurnEnd>[0]>[0][] = [];
      const offTrace = onTurnEnd((turn) => {
        turns.push(turn);
      });
      const reply = await handleMessage('fixture-conv', '请核验需求', 'web');
      assert.equal(reply.stage, 'objection');
      assert.equal(reply.text, '已核验：需求已经核验');
      assert.deepEqual(tools, ['fixture_inspect']);
      assert.deepEqual(getSession('fixture-conv')?.profile.notes, ['已核验']);
      assert.ok(turns[0]?.turn.guardVerdicts?.some((v) => v.id === 'fixture_guard' && v.action === 'replace'));
      assert.ok(turns[0]?.turn.guards.some((e) => e.guard === 'fixture_guard'));
      assert.equal(await guardOutbound(getSession('fixture-conv')!, '正常跟进', { kind: 'followup' }), '正常跟进');
      offTool();
      offTrace();
      const prior = config.currentPack();
      assert.throws(
        () =>
          bindPack(
            { ...runtime, replySteps: [...runtime.replySteps, { id: 'bad', after: ['missing'], run: () => ({ action: 'pass' }) }] },
            null,
          ),
        /bad.*missing/,
      );
      assert.equal(config.currentPack(), prior); // 校验失败不覆盖现有绑定。
      await config.initConfig(null);
      assert.equal(config.currentPack().runtime.id, 'travel');
    } else {
      assert.equal(packById('__fixture'), null);
      assert.equal(runtimeById('__fixture', packSources()), null);
    }
    const reply = await handleMessage('travel-conv', '你好', 'web');
    assert.equal(reply.stage, 'discovery');
    assert.ok(reply.text.includes('旅行'));
    flushStoreNow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
