// 05 R3 / R17：第 1 步列出的 24 份 DB 非锁定自测完整重跑，子进程继续继承严格模式。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenancy-strict-'));
const preload = new URL('./tenancy-strict-preload.ts', import.meta.url).href;
let whitelisted = 0;
try {
  for (const [index, suite] of suites.entries()) {
    console.log(`[tenancy-strict] ${suite}`);
    const report = path.join(reportDir, `${index}.jsonl`);
    const child = spawn(process.execPath, ['--import', 'tsx', suite], {
      stdio: 'inherit',
      env: {
        ...process.env,
        TENANCY_STRICT: '1',
        TENANCY_STRICT_REPORT: report,
        TENANCY_STRICT_SUITE: suite,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=tsx --import=${preload}`.trim(),
        ...(suite === 'eval/run.ts' ? { CONFIG_SOURCE: 'file', CONFIG_TEST_DB: 'pglite', LLM_MOCK: '1' } : {}),
      },
    });
    // 渠道套件含数百个 CLI 子进程，真实 PG 与严格预载均增加启动成本；仍设硬超时。
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    const events = fs.existsSync(report)
      ? fs
          .readFileSync(report, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { kind: string; expected?: boolean })
      : [];
    const loaded = events.filter((event) => event.kind === 'loaded').length;
    const missing = events.filter((event) => event.kind === 'missing');
    const unexpected = missing.filter((event) => !event.expected).length;
    const expected = missing.length - unexpected;
    const expectedCount = suite === 'src/adapters/wecom-03.selftest.ts' ? 1 : 0;
    console.log(`[tenancy-strict] scope_missing=${unexpected} whitelist=${expected} processes=${loaded}`);
    if (code !== 0 || !loaded || unexpected || expected !== expectedCount)
      throw new Error(`严格模式重跑失败：${suite}（退出码 ${code}，非预期缺作用域 ${unexpected}，白名单 ${expected}/${expectedCount}）`);
    whitelisted += expected;
  }
  console.log(
    `TENANCY STRICT PASS: ${suites.length}/${suites.length} 个执行目标；scope_missing=0；whitelist=${whitelisted}（wecom-03 故意移除 owner）`,
  );
} finally {
  fs.rmSync(reportDir, { recursive: true, force: true });
}
