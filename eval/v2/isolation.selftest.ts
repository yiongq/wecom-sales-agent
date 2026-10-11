import '../../src/selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installResets, loadResetModules, resetCaseState } from './isolation.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-isolation-'));
Object.assign(process.env, { VAR_DIR: dir, CONFIG_SOURCE: 'file', LLM_MOCK: '1' });
installResets();
try {
  await loadResetModules();
  const { recordUsage } = await import('../../src/usage.js');
  const { __usageDailyTest } = await import('../../src/trace/usage-daily.js');
  const { hostRuntime, withTenantScope } = await import('../../src/tenancy/runtime.js');
  const { tenantKeys } = await import('../../src/tenancy/state.js');
  const store = await import('../../src/store.js');
  const takeover = await import('../../src/handoff/takeover.js');
  const ledger = await import('../../src/quota/ledger.js');
  const { __privacyTest } = await import('../../src/privacy/privacy.js');
  const { onTurnEnd } = await import('../../src/trace/recorder.js');
  const rt = hostRuntime();
  // 评测加载路径也须登记第 7 步的状态，含未走到的洞察、隐私与运行数字分支。
  const expected = [
    'takeover.gens',
    'takeover.recent',
    'ledger.bySession',
    'ledger.byMsgid',
    'ledger.holds',
    'ledger.awaitingSeq',
    'ledger.timers',
    'insight.insightCache',
    'insight.sugCache',
    'insight.sugInflight',
    'insight.draftCache',
    'insight.draftInflight',
    'privacy.current',
    'privacy.pollTimer',
    'metrics.retention',
    'metrics.views',
    'alert.states',
    'alert.wecomAccounts',
    'alert.inboxAlerted',
    'alert.poisonedSeen',
    'alert.storeSamples',
    'engine.sessionChain',
    'retrieval.index',
    'retrieval.building',
    'retrieval.stale',
    'retrieval.indexGeneration',
    'retrieval.lastError',
    'retrieval.retryAttempt',
    'retrieval.retryTimer',
    'trace.endObservers',
  ];
  for (const name of expected) assert.notEqual(tenantKeys(rt.id)[name], undefined, `评测未加载登记项：${name}`);
  for (let scenario = 0; scenario < 2; scenario++) {
    withTenantScope(rt, () => {
      recordUsage('fixture-model', 10, 2);
      const s = store.getOrCreateSession('eval:reset-state', 'simulator');
      s.handedOver = true;
      takeover.takeover(s.id, takeover.sharedActor());
      ledger.holdSend(s.id, 'human', { role: 'agent', content: '待发', at: Date.now() });
      __privacyTest.set({ version: 1, body: '测试隐私说明' });
      onTurnEnd(() => {}, { owner: rt, conversationId: s.id });
    });
    for (const name of ['takeover.gens', 'ledger.holds', 'privacy.current', 'trace.endObservers'])
      assert.equal(tenantKeys(rt.id)[name], 1, name);
    assert.equal(
      __usageDailyTest.pending().reduce((n, row) => n + row.calls, 0),
      1,
    );
    await resetCaseState(dir);
    assert.deepEqual(__usageDailyTest.pending(), [], '场景结束必须清空 usage_daily 累加器');
    for (const name of expected) assert.equal(tenantKeys(rt.id)[name], 0, `场景结束未清空：${name}`);
  }
  console.log('PASS 评测隔离：第 7 步 30 个登记项重置，连续两个场景 calls、接管、账本、隐私与观察器均从零开始');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
