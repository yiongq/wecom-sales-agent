import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DETECTORS, triageRun, triageJournal, type DetectorId, type TriagePart } from './triage.js';
import { readJournal } from './journal.js';
import type { SimTurn, Snapshot } from './judge.js';
import type { RunResult } from './runner.js';
import type { TraceCall } from '../../src/trace/recorder.js';
import type { LineOrder } from '../../src/core/order-view.js';

// 全部片段手写合成，不读 var，不调用模型或产品包。
const catalog: TriagePart[] = [
  { id: 'part-a', partNo: 'TEST-A', unit: '件', unitPrice: 10, moq: 2, tier2Qty: 20, tier2Price: 8, stock: 18, leadDays: 7 },
  { id: 'part-b', partNo: 'TEST-B', unit: '件', unitPrice: 15, moq: 2, stock: 0, leadDays: 9 },
];
const snapshot = (orders: Snapshot['orders'] = []): Snapshot => ({ orders, handedOver: false, handoff: null, stage: 'greeting' });
function call(name: string, args: Record<string, unknown>, output: unknown): TraceCall {
  const resultHead = JSON.stringify(output);
  return { name, args, resultHead, resultBytes: Buffer.byteLength(resultHead), prefetch: false, ms: 0, startedAt: 1 };
}
const quote = (extra: Record<string, unknown> = {}) =>
  call(
    'quote_items',
    { items: [{ query: 'TEST-A', qty: 20 }] },
    {
      lines: [{ match: 'exact', partNo: 'TEST-A', qty: 20, unitPrice: 8, amount: 160, ...extra }],
      total: 160,
    },
  );
function turn(reply = '请稍候。', customer = 'TEST-A 要20件，帮我试算价格。', calls: TraceCall[] = []): SimTurn {
  return {
    customer: { say: customer, done: false },
    reply,
    silent: false,
    state: snapshot(),
    trace: {
      turn: {
        turnId: 'triage-turn',
        conversationId: 'sim-triage',
        startedAt: 1,
        sopVersion: null,
        prefixHash: '',
        catalogVersions: {},
        calls,
        llm: [],
        guards: [],
        guardVerdicts: null,
        draft: null,
      },
      outcome: 'replied',
      finalText: reply,
      stageBefore: 'greeting',
      stageAfter: 'greeting',
      durationMs: 0,
      signals: null,
      input: customer,
    },
  };
}
function run(...turns: SimTurn[]): RunResult {
  return {
    runId: 'triage-run',
    goalId: 'triage-goal',
    repetition: 1,
    initial: snapshot(),
    turns,
    status: 'passed',
    endedBy: 'done',
    verdicts: [],
    reasons: [],
    customerAttempts: [],
    charges: [],
    turnMetrics: [],
    rerun: false,
  };
}
function order(totalFen = 16000, acceptedAt?: number): LineOrder {
  return {
    v: 2,
    id: 'ord_triage',
    sessionId: 'sim-triage',
    createdAt: 1,
    status: 'pending_payment',
    totalFen,
    lines: [{ kind: 'part', code: 'part-a', title: 'TEST-A', qty: 20, unit: '件', unitPriceFen: 800, amountFen: 16000 }],
    approval: { state: 'approved', requestedAt: 1, acceptedAt },
  };
}
const savedFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('检测器自测禁止联网');
};
let checks = 0;
function expect(detector: DetectorId, expected: boolean, r: RunResult, label: string): void {
  assert.equal(
    triageRun(r, catalog).some((c) => c.detector === detector),
    expected,
    label,
  );
  checks++;
}
function removed(text: string, reply = '请稍候。', customer?: string): SimTurn {
  const t = turn(reply, customer, [quote()]);
  t.trace.turn.guards.push({ guard: 'test_guard', action: 'drop_sentence', removed: [text], added: [], at: 1 });
  return t;
}
function accepting(reply: string): SimTurn {
  const t = turn(reply);
  t.state = snapshot([order(16000, 2)]);
  return t;
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-selftest-'));
try {
  expect('price_withheld', true, run(turn('运费0元，满500元包邮。', undefined, [quote()])), '政策金额不算商品价');
  expect('price_withheld', true, run(turn('满160元包邮，运费8元。', undefined, [quote()])), '政策金额即使等于商品价也不算');
  expect('price_withheld', true, run(turn('TEST-B 单价8元。', undefined, [quote()])), '另一个型号的金额不算');
  expect('price_withheld', true, run(turn('请稍候。', 'TEST-A 20件多少钱？', [quote()])), '型号与数量用空格分隔');
  expect('price_withheld', false, run(turn('请稍候。', 'TEST-A20 要20件多少钱？', [quote()])), '不能匹配较长的未知型号');
  expect('price_withheld', false, run(turn('TEST-A 单价8元，小计160元。', undefined, [quote()])), '单价可见');
  expect('price_withheld', false, run(turn('TEST-A\n单价 8，小计 160', undefined, [quote()])), '跨行无单位金额可见');
  expect('price_withheld', false, run(turn('要20件，运费0元。', '帮我看看价格。', [quote()])), '客户没有型号');
  expect('price_withheld', false, run(turn('请给数量。', 'TEST-A 多少钱？', [quote()])), '客户没有数量');
  expect(
    'price_withheld',
    false,
    run(turn('起订2件。', 'TEST-A 要1件。', [quote({ qty: 1, unitPrice: undefined, amount: undefined })])),
    '全部低于起订量',
  );
  expect(
    'price_withheld',
    false,
    run(turn('超过单次上限。', undefined, [quote({ error: 'too_many', unitPrice: undefined, amount: undefined })])),
    '全部不可报价',
  );
  expect('price_withheld', false, run(turn('未找到。', undefined, [quote({ match: 'none' })])), '全部未匹配');
  const handoff = turn('已转交顾问。', undefined, [quote()]);
  handoff.trace.outcome = 'handoff';
  expect('price_withheld', false, run(handoff), '本轮转人工');
  const suppressed = turn('请等候。', undefined, [quote()]);
  Object.assign(suppressed.trace.turn, { flags: { blocksSuppressed: true } });
  expect('price_withheld', false, run(suppressed), '显式 blocksSuppressed');
  const exact = call('find_parts', { query: 'TEST-A' }, { match: 'exact', parts: [{ partNo: 'TEST-A' }] });
  expect('price_withheld', true, run(turn('请稍候。', undefined, [exact])), '问价且本轮精确命中');
  expect('price_withheld', false, run(turn('请稍候。', 'TEST-A 要20件，交期几天？', [exact])), '只查交期未问价');
  expect('price_withheld', false, run(turn('请稍候。', undefined, [])), '无本轮工具不扩大定义');
  const trimCatalog = [
    'TRIM-A',
    'TRIM-B',
    'TRIM-C',
    'TRIM-D',
    'TRIM-E',
    'TRIM-F',
    'TRIM-G',
    'TRIM-H',
    'TRIM-I',
    'TRIM-J',
    'TRIM-K',
    'TRIM-L',
  ].map((partNo) => ({ ...catalog[0]!, id: partNo, partNo }));
  const trimLines = trimCatalog.map((part) => ({ match: 'exact', code: part.id, qty: 20, unitPrice: 8, amount: 160 }));
  const trimCall = call(
    'quote_items',
    { items: trimLines.map((line) => ({ query: line.code, qty: line.qty })) },
    { lines: trimLines, total: 1920 },
  );
  const trimCustomer = trimCatalog.map((part) => `${part.partNo} 要20件`).join('，');
  const firstTen = trimCatalog.slice(0, 10).map((part) => `${part.partNo} 单价8元，小计160元。`);
  for (const note of ['另外 2 行已算好，需要的话我出一份正式报价单', '询价明细较多，需要的话我出一份正式报价单。']) {
    const clean = run(turn([...firstTen, note].join('\n'), trimCustomer, [trimCall]));
    assert.equal(
      triageRun(clean, trimCatalog).some((c) => c.detector === 'price_withheld'),
      false,
      '裁剪说明覆盖第11、12行',
    );
    checks++;
    const missing = run(turn([...firstTen.slice(1), note].join('\n'), trimCustomer, [trimCall]));
    const suspect = triageRun(missing, trimCatalog).find((c) => c.detector === 'price_withheld');
    assert.ok(
      suspect?.evidence.some((e) => e.startsWith('TRIM-A × 20：')),
      '前10行缺价仍报',
    );
    assert.equal(suspect?.evidence.length, 1, '只报前10行缺价，不报被说明覆盖的尾行');
    checks++;
  }
  for (const note of ['', '另外 1 行已算好，需要的话我出一份正式报价单']) {
    const missing = run(turn([...firstTen, note].join('\n'), trimCustomer, [trimCall]));
    assert.ok(
      triageRun(missing, trimCatalog).some((c) => c.detector === 'price_withheld'),
      '无说明或说明数量不足时仍报未覆盖的尾行',
    );
    checks++;
  }
  expect('correct_deleted', true, run(removed('TEST-A 20件，单价8元，合计160元。')), 'oracle 金额正确');
  expect('correct_deleted', false, run(removed('TEST-A 20件，单价8元，合计159元。')), '同句混入错价');
  expect('correct_deleted', false, run(removed('TEST-A 20件，单价10元，合计200元。')), '错用起订档不算正确金额');
  expect(
    'correct_deleted',
    false,
    run(removed('TEST-A 20件，单价8元，合计160元。', 'TEST-A 20件，单价8元，合计160元。')),
    '仍可见不算删除',
  );
  expect('correct_deleted', true, run(removed('TEST-A 现货18件，其余约7天到货。', 'TEST-A 现货18件。')), '库存保留但正确交期丢失');
  expect('correct_deleted', false, run(removed('TEST-A 现货18件，其余约8天到货。')), '交期错误');
  expect('correct_deleted', false, run(removed('TEST-B 有现货，交期9天。')), '无货不能算正确现货');
  expect('correct_deleted', true, run(removed('TEST-A 20件合计160元，运费0元。')), '正确商品金额附政策金额');
  expect('correct_deleted', false, run(removed('- TEST-A 单价8元。', '· TEST-A 单价8元。')), '纯格式清洗不算');
  const noCall = removed('单价8元，小计160元。', '无价格。', '重新试算。');
  noCall.trace.turn.calls = [];
  expect('correct_deleted', true, run(turn('TEST-A', 'TEST-A 要20件。'), noCall), '无本轮工具的正确删除也用历史上下文');
  const changedQty = removed('适用20–99件档位，单价8元/件，合计160元。', '请稍候。', '改成20件，请按20件试算。');
  changedQty.trace.turn.calls = [];
  expect('correct_deleted', true, run(turn('TEST-A', 'TEST-A 要19件。'), changedQty), '重复数量去重后更新跨档上下文');
  expect('ask_after_accept', true, run(accepting('这份报价还需要您明确确认：请回复「接受这份报价」。')), '接受后再要确认');
  expect('ask_after_accept', true, run(accepting('请您再确认一下这份报价。')), '请求在确认对象之前');
  expect('ask_after_accept', false, run(accepting('已接受，顾问会与您确认付款账户。')), '付款细节确认正常');
  expect('ask_after_accept', false, run(turn('请回复接受这份报价。')), '未接受允许确认');
  const already = run(accepting('请回复接受这份报价。'));
  already.initial = snapshot([order(16000, 2)]);
  expect('ask_after_accept', false, already, '只检查本轮新记录的接受');
  expect('amount_not_order', true, run(accepting('货款150元请对公转账。')), '旧单付款金额');
  expect('amount_not_order', false, run(accepting('合计160元，运费0元。')), '合计正确且运费不混入');
  expect('amount_not_order', false, run(accepting('单价8元，小计160元，合计160元。')), '单价不是订单合计');
  expect('amount_not_order', false, run(accepting('8元/件，合计160元。')), '元每件也是单价');
  expect('amount_not_order', false, run(turn('货款150元。')), '非接受轮不比较');
  for (const text of [
    '询价摘要：{"qty":20}',
    '{"lines":[{"qty":20}]}',
    '{"数量":20}',
    '[1,2]',
    '{}',
    '调用 quote_items',
    'acceptedAt=2',
    'partNo:TEST-A',
    'match:exact',
  ])
    expect('internal_leak', true, run(turn(text)), '内部内容泄漏');
  expect('internal_leak', false, run(turn('TEST-A 的单价8元。')), '普通报价无内部内容');
  const replaced = turn('查到多个候选，请选择需要的型号：\nTEST-A\nTEST-B', '我选TEST-A。');
  replaced.trace.turn.guards.push({ guard: 'test_guard', action: 'replace', removed: ['已确认。'], added: [replaced.reply], at: 1 });
  expect('choice_overridden', true, run(replaced), '明确选择被整体候选重写');
  expect('choice_overridden', false, run({ ...replaced, customer: { say: '有哪些候选？', done: false } }), '从未选型号');
  expect('choice_overridden', true, run(turn('TEST-A。', '我要TEST-A。'), turn('按TEST-A采购。', '改成TEST-B。')), '推回旧型号');
  expect(
    'choice_overridden',
    true,
    run(turn('TEST-A。', '我要TEST-A。'), turn('换TEST-B。', '改成TEST-B。'), turn('建议按TEST-A采购。', '请继续。')),
    '后续轮推回旧型号',
  );
  expect('choice_overridden', false, run(turn('TEST-A已作废，换TEST-B。', '改成TEST-B。')), '正常解释换型');
  for (const text of ['试算如下：', '下一步安排', '价格如下\n1.', '不过还需要您确认。', '另外请提供数量。'])
    expect('dangling', true, run(turn(text)), '残句或异常开头');
  expect('dangling', false, run(turn('试算如下：单价8元。')), '完整句不误报');
  expect('duplicate_text', true, run(turn('库存交期以顾问确认为准。\n库存交期以顾问确认为准！')), '兜底句标点不同也去重');
  expect('duplicate_text', false, run(turn('库存交期以顾问确认为准。请告诉我数量。')), '不同兜底句不误报');
  expect('duplicate_text', false, run(turn('TEST-A单价8元。TEST-A单价8元。')), '只查兜底而非所有重复');
  const silent = turn('询价摘要：{}');
  silent.silent = true;
  assert.deepEqual(triageRun(run(silent), catalog), []);
  checks++;
  const candidate = triageRun(run(turn('询价摘要：{}')), catalog)[0]!;
  assert.equal(candidate.id, createHash('sha256').update('triage-runtriage-goal11internal_leak').digest('hex').slice(0, 12));
  assert.equal(candidate.turn, 1);
  assert.deepEqual(candidate, triageRun(run(turn('询价摘要：{}')), catalog)[0]);
  checks++;
  // readJournal 与 CLI 共享同一输入形状；尾部半行丢弃，head-only 明确中止。
  const head = JSON.stringify({ type: 'head', meta: { runId: 'triage-run', startedAt: '2026-01-01T00:00:00Z' } }) + '\n';
  const r = run(turn('询价摘要：{}'), silent);
  r.replaced = run(turn('询价摘要：{}'));
  const bytes = Buffer.from(head + JSON.stringify({ type: 'run', run: r }) + '\n{"type":');
  const journal = readJournal(bytes);
  const report = triageJournal(journal, catalog);
  assert.equal(report.summary.turns, 2);
  assert.equal(report.candidates.length, 1, '固定五元 id 在 replaced/kept 之间合并');
  assert.equal(report.summary.detectors.internal_leak.per100Turns, 50);
  const aborted = triageJournal(readJournal(Buffer.from(head)), catalog);
  assert.equal(aborted.summary.status, 'aborted');
  assert.equal(aborted.summary.turns, 0);
  for (const detector of DETECTORS) assert.deepEqual(aborted.summary.detectors[detector], { suspects: 0, per100Turns: 0 });
  checks++;
  const journalFile = path.join(root, 'journal.jsonl');
  const abortedFile = path.join(root, 'aborted.jsonl');
  const out = path.join(root, 'triage', 'candidates.json');
  await fs.writeFile(journalFile, bytes);
  await fs.writeFile(abortedFile, head);
  const cli = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(import.meta.dirname, 'triage.ts'), '--journal', journalFile, abortedFile, '--out', out],
    { encoding: 'utf8', timeout: 15_000 },
  );
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), report.candidates);
  const summaries = JSON.parse(cli.stdout);
  assert.equal(summaries[1].status, 'aborted');
  assert.equal(summaries[0].detectors.internal_leak.suspects, 1);
  checks++;
  const invalid = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'triage.ts'), '--journal', journalFile], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(invalid.status, 1, 'CLI 缺 out 拒绝写入');
  checks++;
  console.log(`TRIAGE SELFTEST PASS: ${checks} 项（8 检测器 / 排除条件 / 稳定 id / journal / CLI）`);
} finally {
  globalThis.fetch = savedFetch;
  await fs.rm(root, { recursive: true, force: true });
}
