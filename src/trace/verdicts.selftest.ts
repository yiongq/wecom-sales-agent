// 04 R8：真实 PG 上验证迁移、应用列权限与整轮裁决落库。只接受一次性测试集群。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealPgFixture, testConfigDeps } from '../db/testing.js';
import { openDb } from '../db/client.js';
import { importConfig } from '../config/transfer.js';
import { closeConfig, initConfig } from '../config/source.js';
import { __takeoverTest } from '../handoff/takeover.js';
import type { FinishedTurn } from './recorder.js';

if (!process.env.PG_TEST_URL) {
  if (process.env.CI === 'true') throw new Error('CI 下必须设 PG_TEST_URL：guard_verdicts 须在真实 PG 验证');
  console.log('GUARD VERDICTS SELFTEST：没有 PG_TEST_URL，跳过真实 PG 迁移、授权与每轮一份裁决');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-verdicts-'));
  process.env.VAR_DIR = dir;
  process.env.LLM_MOCK = '1';
  process.env.NOTIFY_WEBHOOK_URL = '';
  const fx = await createRealPgFixture(process.env.PG_TEST_URL);
  const app = await openDb(fx.urls.app);
  const { onTurnEnd } = await import('./recorder.js');
  const store = await import('../store.js');
  const { handleMessage, onToolCall } = await import('../engine.js');
  const turns: FinishedTurn[] = [];
  const off = onTurnEnd((turn) => turns.push(turn));
  const sid = 'wecom:wmVerdicts';
  try {
    const deps = testConfigDeps({ db: app.db });
    const imported = await importConfig({ db: app.db, tenantSlug: 'demo', dataDir: 'data', imageSop: deps.imageSop, lock: deps.lock });
    assert.equal(imported.code, 0);
    await initConfig(deps);
    await store.initSessionStore({ db: app.db, tenantId: fx.tenantId, tenantSlug: 'demo', varDir: dir });
    const [permissions] = await fx.query<{ app_read: boolean; app_insert: boolean; app_update: boolean; platform: boolean }>(
      `select has_column_privilege('agent_app', 'turn_traces', 'guard_verdicts', 'SELECT') as app_read,
              has_column_privilege('agent_app', 'turn_traces', 'guard_verdicts', 'INSERT') as app_insert,
              has_column_privilege('agent_app', 'turn_traces', 'guard_verdicts', 'UPDATE') as app_update,
              has_column_privilege('agent_platform', 'turn_traces', 'guard_verdicts', 'SELECT,INSERT,UPDATE,REFERENCES') as platform`,
    );
    assert.deepEqual(permissions, { app_read: true, app_insert: true, app_update: false, platform: false });
    await handleMessage(sid, '你好', 'wecom');
    assert.equal(turns.at(-1)!.turn.guardVerdicts?.length, 28);
    assert.ok(turns.at(-1)!.turn.guardVerdicts!.some((v) => v.action === 'pass'));
    await handleMessage(sid, '重置', 'wecom');
    assert.equal(turns.at(-1)!.turn.guardVerdicts, null);
    let intercepted = false;
    const offTool = onToolCall((_name, _args, id) => {
      if (id === sid && !intercepted) {
        intercepted = true;
        __takeoverTest.bump(id);
      }
    });
    try {
      const reply = await handleMessage(sid, '云南有什么线路？', 'wecom');
      assert.equal(intercepted, true);
      assert.equal(reply.silent, true);
      assert.deepEqual(turns.at(-1)!.turn.guardVerdicts?.at(-1), { id: 'takeover_check:pre', action: 'abort' });
    } finally {
      offTool();
    }
    await store.flushSession(sid);
    // 重复 flush 不能重复写同一轮的裁决或 trace。
    await store.flushSession(sid);
    const rows = await fx.query<{ id: string; guard_verdicts: unknown }>(
      'select id, guard_verdicts from turn_traces where tenant_id = $1 and conversation_id = $2',
      [fx.tenantId, sid],
    );
    assert.equal(rows.length, turns.length);
    for (const f of turns) {
      const matching = rows.filter((r) => r.id === f.turn.turnId);
      assert.equal(matching.length, 1);
      assert.deepEqual(matching[0]!.guard_verdicts, f.turn.guardVerdicts);
    }
    console.log('GUARD VERDICTS SELFTEST PASS：真实 PG 迁移、只读/追加授权、正常/前置返回/接管中止每轮一份裁决、重复 flush 不重写');
  } finally {
    off();
    await store.runShutdownHooks(5000);
    await closeConfig();
    await app.close();
    await fx.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
