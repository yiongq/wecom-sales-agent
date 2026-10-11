// 必须在产品模块之前预载；NODE_OPTIONS 让套件创建的子进程也登记被吞掉的缺作用域。
import fs from 'node:fs';
import { __tenantTest, onTenantScopeMissing } from '../src/tenancy/runtime.js';

const report = process.env.TENANCY_STRICT_REPORT;
if (!report) throw new Error('tenancy-strict preload 缺少报告路径');
const suite = process.env.TENANCY_STRICT_SUITE;
const write = (event: object): void => {
  fs.appendFileSync(report, `${JSON.stringify({ suite, pid: process.pid, ...event })}\n`);
};
write({ kind: 'loaded' });
let unexpected = 0;
onTenantScopeMissing(() => {
  const reason = __tenantTest.missingExpectation.getStore();
  // wecom-03 故意移除 owner 的那次拒绝：必须有局部标记，不允许按整份套件放行。
  const expected = suite === 'src/adapters/wecom-03.selftest.ts' && reason === 'wecom-03-owner-missing';
  if (!expected) unexpected++;
  write({ kind: 'missing', expected, reason });
});
process.on('exit', () => {
  if (unexpected) process.exitCode = 1;
});
