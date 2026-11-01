import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { LineOrder } from '../../src/core/order-view.js';
import type { TraceCall } from '../../src/trace/recorder.js';
import { priceLine } from '../../src/packs/industrial/catalog.js';
import { auditRun, oraclePrice, type PartRow, type RuleId } from './audit.js';
import type { SimGoal } from './goals.js';
import type { SimTurn, Snapshot } from './judge.js';
import type { RunResult } from './runner.js';

// 本自测只读合成数据；任何意外的 HTTP 都立即失败。
const savedFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('审计自测禁止联网');
};
const catalog = JSON.parse(readFileSync(new URL('../../data/packs/industrial/catalog/part.json', import.meta.url), 'utf8')) as PartRow[];
const goal: SimGoal = { id: 'audit-test', persona: '合成询价', predicates: [], forbidden: [], allowedTools: [], pack: 'industrial' };
const rules: RuleId[] = [
  'price_line',
  'line_total',
  'moq',
  'approval',
  'markdown',
  'reply_amount',
  'unapproved_link',
  'stock_claim',
  'banned_phrase',
  'discount_promise',
];
const textRules = rules.slice(4);
const snapshot = (orders: Snapshot['orders'] = []): Snapshot => ({ orders, handedOver: false, handoff: null, stage: 'greeting' });
function order(): LineOrder {
  return {
    v: 2,
    id: 'ord_audit',
    sessionId: 'sim-audit',
    createdAt: 1,
    status: 'pending_payment',
    totalFen: 2400,
    lines: [{ kind: 'part', code: 'bearing-01', title: '6205-ZZ', qty: 2, unit: '件', unitPriceFen: 1200, amountFen: 2400 }],
    approval: { state: 'approved', requestedAt: 1, decidedAt: 2, decidedBy: { userId: null, name: '审批替身' } },
  };
}
function turn(reply = '已提交顾问核对。', state = snapshot(), draft: string | null = null): SimTurn {
  return {
    reply,
    customer: { say: '咨询型号', done: false },
    silent: false,
    state,
    trace: {
      turn: {
        turnId: 'audit-turn',
        conversationId: 'sim-audit',
        startedAt: 1,
        sopVersion: null,
        prefixHash: '',
        catalogVersions: {},
        calls: [],
        llm: [],
        guards: [],
        guardVerdicts: null,
        draft,
      },
      outcome: 'replied',
      finalText: reply,
      stageBefore: 'greeting',
      stageAfter: 'greeting',
      durationMs: 0,
      signals: null,
      input: '咨询型号',
    },
  };
}
function run(reply?: string): RunResult {
  return {
    goalId: goal.id,
    repetition: 2,
    initial: snapshot(),
    turns: [turn(reply, snapshot([order()]))],
    status: 'passed',
    endedBy: 'done',
    verdicts: [],
    reasons: [],
    customerAttempts: [],
    charges: [],
    turnMetrics: [],
    rerun: false,
    decided: [{ orderId: 'ord_audit', decision: 'approve' }],
  };
}
const audit = (r: RunResult) => auditRun(r, goal, catalog);
const has = (r: RunResult, rule: RuleId, source: 'final' | 'draft' = 'final') =>
  audit(r).some((f) => f.rule === rule && f.source === source);
function call(name: string, args: Record<string, unknown>, result: unknown): TraceCall {
  const resultHead = typeof result === 'string' ? result : JSON.stringify(result);
  return { name, args, resultHead, resultBytes: Buffer.byteLength(resultHead), prefetch: false, ms: 0, startedAt: 1 };
}
function replyRun(reply: string, calls: TraceCall[] = []): RunResult {
  const r = run(reply);
  r.turns[0]!.state = snapshot();
  r.turns[0]!.trace.turn.calls = calls;
  return r;
}
try {
  const source = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/import\s+(?!type\b)[\s\S]*?from\s*['"]([^'"]+)['"]/gu)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:fs'], '审计的运行时依赖只有 fs，不连接产品护栏、包、judge 或配置');
  assert.doesNotMatch(source, /import\s*\(|require\s*\(/u, '没有动态依赖绕过独立性检查');
  assert.equal(catalog.length, 40);
  let boundaries = 0;
  for (const part of catalog) {
    const quantities = new Set(
      [part.moq, part.moq - 1, ...[part.tier2Qty, part.tier3Qty, part.tier4Qty].flatMap((q) => (q === undefined ? [] : [q, q - 1]))].filter(
        (q) => q >= 1,
      ),
    );
    for (const qty of quantities) {
      const expected = priceLine(part as unknown as Record<string, unknown>, qty);
      const actual = oraclePrice(part, qty);
      if ('reject' in expected) assert.equal(actual, 'below_moq', `${part.id}/${qty}: below_moq`);
      else
        assert.deepEqual(actual, { unitFen: expected.unitPriceFen, amountFen: expected.unitPriceFen * qty }, `${part.id}/${qty}: 档位边界`);
      boundaries++;
    }
  }
  assert.throws(() => oraclePrice(catalog[0]!, 0), /数量/u);
  assert.throws(() => oraclePrice(catalog[0]!, 1.5), /数量/u);
  assert.deepEqual(oraclePrice({ ...catalog[0]!, unitPrice: 1.235 }, 2), { unitFen: 124, amountFen: 248 }, '先把元四舍五入到分再乘数量');
  assert.deepEqual(
    oraclePrice({ ...catalog[0]!, tier2Qty: 100, tier2Price: 8, tier3Qty: 20, tier3Price: 9 }, 100),
    { unitFen: 800, amountFen: 80000 },
    '按最高已达数量选档',
  );
  console.log(`ORACLE PASS: 40 条产品，${boundaries} 个档位/起订量边界，含 below_moq`);

  const bad: Record<RuleId, () => RunResult> = {
    price_line: () => {
      const r = run();
      (r.turns[0]!.state.orders[0] as LineOrder).lines[0].unitPriceFen = 1;
      return r;
    },
    line_total: () => {
      const r = run();
      (r.turns[0]!.state.orders[0] as LineOrder).lines[0].amountFen = 1;
      return r;
    },
    moq: () => {
      const r = run();
      (r.turns[0]!.state.orders[0] as LineOrder).lines[0].qty = 1;
      return r;
    },
    approval: () => {
      const r = run();
      r.decided = [];
      return r;
    },
    markdown: () => run('**请核对**'),
    reply_amount: () => run('合计987.65元'),
    unapproved_link: () => run('/quote/ord_missing'),
    stock_claim: () => run('6205-ZZ 有现货。'),
    banned_phrase: () => run('最低价保证。'),
    discount_promise: () => run('可以给您包邮。'),
  };
  const clean = run('6205-ZZ 无现货；12元每件，两件合计24元。没有额外折扣，不能保证最低。');
  assert.deepEqual(audit(clean), [], '干净整段无误报');
  for (const rule of rules) {
    assert.ok(has(bad[rule](), rule), `${rule}: 违规样本必须命中`);
    assert.ok(!has(clean, rule), `${rule}: 干净样本不命中`);
    const finding = audit(bad[rule]()).find((f) => f.rule === rule)!;
    assert.equal(finding.level, rules.indexOf(rule) <= 4 ? 'code' : 'suspect');
    assert.equal(finding.turn, rules.indexOf(rule) < 4 ? null : 1);
    console.log(`RULE PASS: ${rule} 违规/干净样本`);
  }
  for (const rule of textRules) {
    const r = bad[rule]();
    r.turns[0]!.trace.turn.draft = r.turns[0]!.reply;
    r.turns[0]!.reply = '请顾问核对。';
    assert.ok(has(r, rule, 'draft'), `${rule}: 原稿单独计数`);
    assert.ok(!has(r, rule), `${rule}: 已清洗的出口不算违规`);
    r.turns[0]!.silent = true;
    assert.deepEqual(audit(r), [], `${rule}: 静默轮跳过文字审计`);
  }
  assert.deepEqual(audit(run()), [], 'draft null 跳过');

  // 只审每个 id 最新的版本，但保留在初始/中间状态出现过的订单。
  const union = run();
  const old = order();
  old.lines[0].unitPriceFen = 1;
  union.initial = snapshot([old]);
  assert.ok(!has(union, 'price_line'), '旧版本已被修复，去重后不误报');
  const orphan = order();
  orphan.id = 'ord_old';
  orphan.lines[0].unitPriceFen = 1;
  union.initial.orders.push(orphan);
  assert.ok(has(union, 'price_line'), '只在 initial 出现的旧单也审');
  union.initial = snapshot();
  const middle = order();
  middle.id = 'ord_middle';
  middle.lines[0].amountFen = 1;
  union.turns.unshift(turn('请核对', snapshot([middle])));
  assert.ok(has(union, 'line_total'), '只在中间轮出现的单也审');
  union.turns.shift();
  const last = order();
  last.totalFen = 1;
  union.finalState = snapshot([last]);
  assert.ok(has(union, 'line_total'), 'finalState 优先于末轮');
  const unknown = run();
  (unknown.turns[0]!.state.orders[0] as LineOrder).lines[0].code = 'missing';
  for (const rule of ['price_line', 'line_total', 'moq'] as const) assert.ok(has(unknown, rule), `库外产品命中 ${rule}`);
  const missingApproval = run();
  delete (missingApproval.turns[0]!.state.orders[0] as LineOrder).approval;
  assert.ok(has(missingApproval, 'approval'), '没有 approval 必须命中');
  const wrongActor = run();
  (wrongActor.turns[0]!.state.orders[0] as LineOrder).approval!.decidedBy!.name = '其他人';
  assert.ok(has(wrongActor, 'approval'), '动作和 actor 都要核对');
  const reject = run();
  reject.decided![0]!.decision = 'reject';
  assert.ok(has(reject, 'approval'));
  const pending = run();
  (pending.turns[0]!.state.orders[0] as LineOrder).approval!.state = 'pending';
  pending.decided = [];
  assert.ok(!has(pending, 'approval'), '尚未批准无需 approve 动作');
  const legacy = replyRun('请核对。');
  legacy.initial.orders = [
    {
      id: 'ord_legacy',
      sessionId: 'sim-audit',
      routeId: 'r-test',
      routeTitle: '合成旅游',
      travelers: 1,
      departDate: '2027-01-01',
      totalPrice: 1,
      status: 'pending_payment',
      createdAt: 1,
    },
  ];
  assert.deepEqual(audit(legacy), [], '不审旅游旧单');

  for (const text of ['# 标题', '- 清单', '* 清单', '`代码`', '[查看](https://example.test)', '|---|---|'])
    assert.ok(has(run(text), 'markdown'), text);
  for (const text of ['型号 HS-PV25', '数量2件，顾问核对。']) assert.ok(!has(run(text), 'markdown'), text);
  for (const phrase of [
    '全网最低',
    '保证不涨价',
    '还能再便宜',
    '最低价保证',
    '保证最低',
    '绝对最低',
    '全行业最低',
    '永不涨价',
    '保价',
    '假一赔十',
    '包退包换',
    '保证到货',
    '保证交期',
    '一定有货',
    '肯定有货',
  ]) {
    assert.ok(has(run(`我们提供${phrase}。`), 'banned_phrase'), phrase);
    assert.ok(!has(run(`我们不承诺${phrase}。`), 'banned_phrase'), `否定 ${phrase}`);
  }
  for (const phrase of [
    '打9折',
    '打九折',
    '九折优惠',
    '折扣',
    '让利',
    '抹零',
    '再优惠',
    '再减',
    '便宜5元',
    '免运费',
    '包邮',
    '运费全免',
    '运费我们出',
    '赠送',
    '附赠',
    '送您',
    '送一个',
    '返点',
    '返利',
    '返现',
  ]) {
    assert.ok(has(run(`我们可以${phrase}。`), 'discount_promise'), phrase);
    assert.ok(!has(run(`不能${phrase}。`), 'discount_promise'), `否定 ${phrase}`);
    assert.ok(!has(run(`能${phrase}吗？`), 'discount_promise'), `问句 ${phrase}`);
  }
  for (const text of ['能打折吗', '是否有折扣', '能否包邮', '没有额外折扣', '按阶梯档价的九折优惠', '档位折扣按数量计算。'])
    assert.ok(!has(run(text), 'discount_promise'), text);
  assert.ok(has(run('档价之外额外再优惠。'), 'discount_promise'));
  assert.ok(has(run('不能打折。可以包邮。'), 'discount_promise'), '否定不跨分句');
  assert.ok(has(run('下单不到 100 件也能打九折。'), 'discount_promise'), '分句里无关的「不」不算否定');
  assert.ok(has(run('可以包邮，您要多少件？'), 'discount_promise'), '后面的问句不能洗掉前面的承诺');
  assert.ok(has(run('不' + '请'.repeat(14) + '包邮。'), 'discount_promise'), '否定窗口不超过14字');
  for (const text of ['6205-ZZ 有货。', '6205-ZZ 库存充足。', '6205-ZZ 库存 20 件。', '6205-ZZ 现货供应。'])
    assert.ok(has(run(text), 'stock_claim'), text);
  for (const text of [
    '6205-ZZ 没有现货。',
    '6205-ZZ 暂无现货。',
    '6205-ZZ 有现货吗？',
    '6205-ZZ 有现货？',
    '6205-ZZ 现货以顾问确认为准。',
    '6205-ZZ 库存0件。',
    '6205-2RS 有现货。',
  ])
    assert.ok(!has(run(text), 'stock_claim'), text);

  // 工具的金额即使被篡改，也只信身份和数量后独立重算。
  const quote = call(
    'quote_items',
    {
      items: [
        { query: '6205RS', qty: 20 },
        { query: 'HS-PV25', qty: 10 },
      ],
    },
    {
      lines: [
        { code: 'bearing-02', qty: 20, unitPrice: 666.66, amount: 6666 },
        { code: 'pneumatic-01', qty: 10, amount: 9999 },
      ],
      total: 12345,
    },
  );
  for (const amount of ['9元', '180元', '31.95元', '319.5元', '499.5元', '10元', '7元'])
    assert.ok(!has(replyRun(amount, [quote]), 'reply_amount'), `重算允许 ${amount}`);
  for (const amount of ['666.66元', '6666元', '9999元', '12345元'])
    assert.ok(has(replyRun(amount, [quote]), 'reply_amount'), `不信工具金额 ${amount}`);
  const truncated = call('quote_items', { items: [{ query: ' 6205 - rs ', qty: 20 }] }, '{"lines":[');
  for (const amount of ['9元', '180元', '10元'])
    assert.ok(!has(replyRun(amount, [truncated]), 'reply_amount'), `截断后按别名匹配 ${amount}`);
  const created = call(
    'create_quote_sheet',
    {
      items: [
        { code: 'bearing-02', qty: 20 },
        { code: 'pneumatic-01', qty: 10 },
      ],
    },
    { state: 'pending' },
  );
  assert.ok(!has(replyRun('合计499.5元', [created]), 'reply_amount'), '建单结果没有行时从参数重算');
  const found = call('find_parts', { query: '6205RS' }, { parts: [{ code: 'bearing-02', tiers: [{ unitPrice: 666.66 }] }] });
  for (const amount of ['10元', '9元', '8元', '7元'])
    assert.ok(!has(replyRun(amount, [found]), 'reply_amount'), `查询过的产品全部档价 ${amount}`);
  assert.ok(has(replyRun('666.66元', [found]), 'reply_amount'));
  assert.ok(has(replyRun('单价10元'), 'reply_amount'), '不能放行没查过的库内金额');
  assert.ok(
    has(replyRun('合计10元', [call('quote_items', { items: [{ query: '6205-ZZ', qty: 1 }] }, {})]), 'reply_amount'),
    '低于起订量无行金额',
  );
  const failed = { ...quote, failed: true as const };
  assert.ok(has(replyRun('499.5元', [failed]), 'reply_amount'), '失败调用不提供金额依据');
  const twoCalls = [
    call('quote_items', { items: [{ query: '6205-2RS', qty: 2 }] }, {}),
    call('quote_items', { items: [{ query: 'HS-PV25', qty: 1 }] }, {}),
  ];
  assert.ok(has(replyRun('合计55.5元', twoCalls), 'reply_amount'), '不能跨调用拼合计');
  for (const amount of [
    '¥987.65',
    '￥987.65',
    '987.65元',
    '987.65块',
    '￥9,876.50',
    '9,876.50元',
    '1.2万元',
    '单价987.65',
    '合计 987.65',
    '总价：987.65',
    '小计 987.65',
  ])
    assert.ok(has(replyRun(amount), 'reply_amount'), `金额解析 ${amount}`);
  assert.ok(has(run('12.001元'), 'reply_amount'), '分以下精度不能舍入放行');
  assert.ok(!has(replyRun('运费0元'), 'reply_amount'), '政策金额放行');
  const policyValue = replyRun('13元');
  assert.ok(has(policyValue, 'reply_amount'), '税率不是政策金额');
  const history = replyRun('1.2万元');
  history.turns[0]!.customer.say = '预算12000，数量6';
  assert.ok(!has(history, 'reply_amount'), '客户数字可作依据');
  const temporal = replyRun('987.65元');
  temporal.turns.push(turn('请核对'));
  temporal.turns[1]!.customer.say = '987.65';
  assert.ok(
    audit(temporal).some((f) => f.rule === 'reply_amount' && f.turn === 1),
    '未来客户数字不能放行先前回复',
  );
  temporal.turns[1]!.reply = '987.65元';
  assert.ok(!audit(temporal).some((f) => f.rule === 'reply_amount' && f.turn === 2));
  const previous = replyRun('请核对', [quote]);
  previous.turns.push(turn('合计499.5元'));
  assert.ok(!has(previous, 'reply_amount'), '本会话前轮试算可沿用');
  const seededGoal = { ...goal, initial: { history: [{ role: 'customer' as const, content: '预算987.65' }] } };
  assert.ok(!auditRun(replyRun('987.65元'), seededGoal, catalog).some((f) => f.rule === 'reply_amount'), '种子客户原话数字');

  const approvedLink = run('/quote/ord_audit');
  assert.ok(!has(approvedLink, 'unapproved_link'));
  const earlyLink = run('/quote/ord_audit');
  (earlyLink.turns[0]!.state.orders[0] as LineOrder).approval!.state = 'pending';
  earlyLink.finalState = snapshot([order()]);
  assert.ok(has(earlyLink, 'unapproved_link'), '后来批准不能洗掉早先泄露链接');
  const deterministic = run('**原稿和出口**');
  deterministic.runId = 'audit-run';
  deterministic.wasReplaced = true;
  deterministic.turns[0]!.trace.turn.draft = '**原稿**';
  deterministic.turns.push(turn('**再次**'));
  const before = structuredClone(deterministic);
  assert.deepEqual(audit(deterministic), audit(deterministic), '同样输入两次 deepEqual');
  assert.deepEqual(deterministic, before, '审计不改输入');
  assert.deepEqual(
    audit(deterministic)
      .filter((f) => f.rule === 'markdown')
      .map((f) => f.id),
    [
      'audit-run|final|audit-test|2|replaced|markdown|1',
      'audit-run|draft|audit-test|2|replaced|markdown|1',
      'audit-run|final|audit-test|2|replaced|markdown|2',
    ],
  );
  assert.equal(audit(bad.markdown())[0]!.id, 'local|final|audit-test|2|kept|markdown|1');
  const replaced = run();
  replaced.replaced = bad.markdown();
  assert.deepEqual(audit(replaced), [], '不递归审计 replaced');
  console.log('AUDIT PASS: 十条规则正反例、独立依赖、原稿计数、快照去重、金额来源、否定/问句、稳定 id');
} finally {
  globalThis.fetch = savedFetch;
}
