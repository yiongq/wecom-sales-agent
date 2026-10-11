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
  const rt = hostRuntime();
  for (let scenario = 0; scenario < 2; scenario++) {
    withTenantScope(rt, () => recordUsage('fixture-model', 10, 2));
    assert.equal(
      __usageDailyTest.pending().reduce((n, row) => n + row.calls, 0),
      1,
    );
    await resetCaseState(dir);
    assert.deepEqual(__usageDailyTest.pending(), [], '场景结束必须清空 usage_daily 累加器');
  }
  console.log('PASS 评测隔离：文件模式连续两个场景 calls 均从零开始');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
