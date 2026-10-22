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
  assert.equal(generated.length, 13, '宿主默认种子仍为13段');
  const hostOrders = JSON.parse(fs.readFileSync(path.join(dir, 'seed_orders.json'), 'utf8')) as Order[];
  assert.equal(hostOrders.length, 3, '宿主默认订单仍为3个');
  const fixtureRun = spawnSync(
    'python3',
    [path.join(import.meta.dirname, 'seed-demo.py'), '--fixture', '--now', '2026-10-09T14:30+08:00'],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.ifError(fixtureRun.error);
  assert.equal(fixtureRun.status, 0, fixtureRun.stderr);
  const sandbox = JSON.parse(fixtureRun.stdout) as { sessions: Session[]; orders: Order[] };
  const ids = new Set(['wecom:cust_A01', 'wecom:cust_B01', 'wecom:cust_C01', 'wecom:cust_E01', 'wecom:cust_F01']);
  const subset = generated.filter((s) => ids.has(s.id)).map((s) => ({ ...structuredClone(s), updatedAt: s.messages.at(-1)!.at }));
  // 保留05已有的夹具修正：默认宿主B01还引用旧线路，沙箱必须引用当前目录。
  const routes = JSON.parse(fs.readFileSync('data/routes.json', 'utf8')) as { id: string; title: string; priceFrom: number }[];
  const bali = routes.find((r) => r.id === 'r-bali')!;
  const baliOrder = hostOrders.find((o) => o.sessionId === 'wecom:cust_B01')!;
  baliOrder.routeId = bali.id;
  baliOrder.routeTitle = bali.title;
  baliOrder.totalPrice = bali.priceFrom * baliOrder.travelers;
  const baliSession = subset.find((s) => s.id === baliOrder.sessionId)!;
  baliSession.messages[1]!.content = `${bali.title}了解一下？私人泳池俯瞰雨林～`;
  baliSession.messages[3]!.content = `已为您生成订单，${bali.title}，${baliOrder.travelers} 人共 ${baliOrder.totalPrice.toLocaleString('en-US')} 元，请点链接支付～`;
  const latest = Math.max(...subset.flatMap((s) => s.messages.map((m) => m.at)));
  function relative(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(relative);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          ['at', 'createdAt', 'updatedAt', 'paidAt'].includes(key) && typeof item === 'number' ? item - latest : relative(item),
        ]),
      );
    return value;
  }
  // 07 R21：沙箱夹具在这 5 段之外多一个沙箱专有的 G01（退款待审批），宿主的默认种子不含它
  const sandboxOnly = new Set(['wecom:cust_G01']);
  assert.ok(!generated.some((s) => sandboxOnly.has(s.id)) && !hostOrders.some((o) => sandboxOnly.has(o.sessionId)), '宿主默认种子不含 G01');
  assert.deepEqual(
    sandbox.sessions.filter((s) => !sandboxOnly.has(s.id)),
    relative(subset),
    '沙箱是宿主默认种子的5段子集，正文与画像不改',
  );
  assert.deepEqual(
    sandbox.orders.filter((o) => !sandboxOnly.has(o.sessionId)),
    relative(hostOrders.filter((o) => ids.has(o.sessionId))),
    '仅保留这5段对应的2个订单，字段不改',
  );
  assert.deepEqual(
    sandbox.sessions.map((s) => s.id),
    [...subset.map((s) => s.id), ...sandboxOnly],
    'G01 排在 5 段之后',
  );
  assert.equal(sandbox.orders.length, 3, '沙箱夹具共 3 个订单（5 段的 2 个加 G01）');
  assert.deepEqual(sandbox, JSON.parse(fs.readFileSync('data/sandbox-seeds.json', 'utf8')), '已提交的沙箱夹具与生成器一致');
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
