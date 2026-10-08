// 默认 demo 种子的转人工记录：运行真实生成脚本，并经生产文件后端读回，防止后台原因与交接卡缺失。
import '../src/selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileBackend } from '../src/store/file-backend.js';
import { ORDERS_JSON, SESSIONS_JSON } from '../src/store/project.js';
import type { HandoffKind, Order, Session } from '../src/types.js';

const kinds: Record<HandoffKind, true> = {
  request: true,
  complaint: true,
  refund: true,
  emergency: true,
  failure: true,
  sentiment: true,
  model: true,
  promise: true,
  claimed: true,
  consent: true,
  agent: true,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-demo-selftest-'));
try {
  // 脚本原有的两个输出重定向到本次临时目录，避免覆盖手工生成的种子或与其他进程争用。
  const run = spawnSync(
    'python3',
    [
      '-c',
      `import builtins, os, runpy, sys
from unittest.mock import patch
script, output_dir = sys.argv[1:]
original_open = builtins.open
def isolated_open(file, mode="r", *args, **kwargs):
    name = os.path.basename(file)
    if mode == "w" and name in ("seed_sessions.json", "seed_orders.json"):
        file = os.path.join(output_dir, name)
    return original_open(file, mode, *args, **kwargs)
sys.argv = [script, "--now", "2026-10-09T14:30+08:00"]
with patch("builtins.open", side_effect=isolated_open):
    runpy.run_path(script, run_name="__main__")
`,
      path.join(import.meta.dirname, 'seed-demo.py'),
      dir,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const generated = JSON.parse(fs.readFileSync(path.join(dir, 'seed_sessions.json'), 'utf8')) as Session[];
  const handoffs = generated.filter((s) => s.handedOver || s.stage === 'handoff');
  assert.ok(handoffs.length > 0, '默认场景必须含转人工会话');
  for (const s of handoffs) {
    const h = s.handoff;
    assert.ok(h, `${s.id} 缺少转人工记录`);
    assert.ok(Object.hasOwn(kinds, h.kind), `${s.id} 转人工类型非法`);
    assert.ok(Number.isSafeInteger(h.at) && h.at >= s.createdAt && h.at <= s.updatedAt, `${s.id} 转人工时间非法`);
    assert.ok(typeof h.reason === 'string' && h.reason.trim() && [...h.reason].length <= 120, `${s.id} 原因非法`);
    assert.ok(
      Object.keys(h).every((key) => ['kind', 'at', 'reason', 'quote', 'departNote'].includes(key)),
      `${s.id} 记录含未知字段`,
    );
    if (h.kind !== 'agent') {
      const customer = s.messages.findLast((m) => m.role === 'customer');
      assert.ok(customer, `${s.id} 缺少触发转人工的客户消息`);
      assert.equal(h.quote, customer.content, `${s.id} 原话必须来自客户消息`);
      assert.ok(h.quote && [...h.quote].length <= 200 && h.at >= customer.at, `${s.id} 原话或触发时间非法`);
    }
    if (h.departNote !== undefined) assert.equal(typeof h.departNote, 'string');
  }
  const complaint = generated.find((s) => s.id === 'wecom:cust_F01');
  assert.ok(complaint);
  assert.deepEqual(complaint.handoff, {
    kind: 'complaint',
    at: complaint.messages.at(-1)!.at,
    reason: '客户投诉价格太贵',
    quote: '这个太贵了，我要投诉',
  });

  fs.renameSync(path.join(dir, 'seed_sessions.json'), path.join(dir, SESSIONS_JSON));
  fs.renameSync(path.join(dir, 'seed_orders.json'), path.join(dir, ORDERS_JSON));
  const sessions = new Map<string, Session>();
  createFileBackend({
    varDir: dir,
    sessions,
    orders: new Map<string, Order>(),
    owns: () => true,
    ownsOrder: () => true,
    isReal: () => false,
    afterPersist: () => {},
  }).load();
  for (const s of handoffs) assert.deepEqual(sessions.get(s.id)?.handoff, s.handoff, `${s.id} 文件后端必须完整读回记录`);
  console.log('SELFTEST PASS: 默认场景每个转人工种子都有合法记录，文件后端完整读回');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
