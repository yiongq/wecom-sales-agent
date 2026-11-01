// 手册小节的解析（17 spec R9）：用真实的公共手册逐节解析，页面只认标题、段落、代码三种块。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/ops/runbook.selftest.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RUNBOOKS } from '../../../src/shared/alert-policy.js';
import { runbookBlocks } from './runbook.js';

const doc = fs.readFileSync(new URL('../../../docs/ops/observability.md', import.meta.url), 'utf8');
for (const book of Object.values(RUNBOOKS)) {
  const at = doc.indexOf(`## ${book.code} ${book.key} · `);
  assert.ok(at >= 0, book.key);
  const next = doc.indexOf('\n## ', at + 1);
  const blocks = runbookBlocks(doc.slice(at, next < 0 ? undefined : next));
  assert.deepEqual(
    blocks.filter((b) => b.kind === 'heading').map((b) => b.text),
    ['症状', '只读检查命令', '下一步', '恢复证据', '什么情况下停止自动重试'],
    book.key,
  );
  assert.ok(
    blocks.some((b) => b.kind === 'code'),
    `${book.key} 有检查命令`,
  );
  assert.ok(
    blocks.every((b) => !b.text.startsWith('```') && !b.text.startsWith('#')),
    `${book.key} 不漏标记`,
  );
}
assert.deepEqual(runbookBlocks('## 标题\n\n### 甲\n\n第一行\n第二行\n\n```bash\na  b\n```\n'), [
  { kind: 'heading', text: '甲' },
  { kind: 'text', text: '第一行第二行' },
  { kind: 'code', text: 'a  b' },
]);
console.log(`runbook: ${Object.keys(RUNBOOKS).length} 节手册解析通过`);
