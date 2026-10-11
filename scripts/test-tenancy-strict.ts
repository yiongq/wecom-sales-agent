// 05 R3 / R17：第 1 步列出的 24 份 DB 非锁定自测完整重跑，子进程继续继承严格模式。
import { spawn } from 'node:child_process';

const suites = Object.freeze([
  'src/config/brand.selftest.ts',
  'src/config/brand-publish.selftest.ts',
  'src/config/brand-transfer.selftest.ts',
  'src/store/store.selftest.ts',
  'src/store/spill-channel.selftest.ts',
  'src/store/parity.selftest.ts',
  'src/trace/trace.selftest.ts',
  'src/trace/verdicts.selftest.ts',
  'src/jobs/jobs.selftest.ts',
  'src/notify/notify.selftest.ts',
  'src/ops/ops.selftest.ts',
  'src/channels/channels.selftest.ts',
  'src/adapters/wecom-03.selftest.ts',
  'src/channels/recovery.selftest.ts',
  'src/channels/restore-cutoff.selftest.ts',
  'src/quota/quota.selftest.ts',
  'src/quota/outbound.selftest.ts',
  'src/db/rollback-guard.selftest.ts',
  'src/db/db.selftest.ts',
  'src/db/brand.selftest.ts',
  'src/config/config.selftest.ts',
  'src/console-api/console.selftest.ts',
  'src/web/web.selftest.ts',
  'src/payment/legacy-pay-poisoned.selftest.ts',
  'eval/run.ts',
]);
for (const suite of suites) {
  console.log(`[tenancy-strict] ${suite}`);
  const child = spawn(process.execPath, ['--import', 'tsx', suite], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TENANCY_STRICT: '1',
      ...(suite === 'eval/run.ts' ? { CONFIG_SOURCE: 'file', CONFIG_TEST_DB: 'pglite', LLM_MOCK: '1' } : {}),
    },
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`严格模式重跑失败：${suite}（退出码 ${code}）`);
}
console.log(`TENANCY STRICT PASS: ${suites.length} 个执行目标`);
