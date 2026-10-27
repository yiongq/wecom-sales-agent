// 08 第 17 步（R11 的评测部分）：证明包的模拟客户目标在文件模式下用假模型跑完。
//   一、eval/sim/goals/__fixture/ 的两个目标通过校验（pack = __fixture），按包装载。
//   二、模拟评测按 --config-dir 装载证明包：目标一（询价两种方盒后下单，133000 分）、目标二（问单价与运费、不下单）都通过；
//      编造的 3.80 元被金额出处护栏删句、目标变红；下单数量变了，order 谓词按 totalFen 判红。
//   三、initial 的种子订单只给条目和数量，经包的 priceLine 建成通用单（已付单带 paidAt、阶段 paid；种子里的待付单被同样的下单复用）。
//   四、目标的 pack 必须是运行时装载的那个包：旅游目标跑在证明包上被拒。
// 证明包只在 PACK_FIXTURES=1 时登记，所以放在子进程里跑；没有任何真实模型调用。
import '../../src/selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { goalPack, loadGoals, validateGoal, type SimGoal } from './goals.js';
import { Meter, simulate, simulateGate } from './runner.js';
import { engineRuntime } from './runtime.js';
import { fakeEnv, fakePrices, fakeService, say } from './fake.js';

if (process.argv[2] !== 'worker') {
  const child = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'worker'], {
    env: { ...process.env, PACK_FIXTURES: '1', LLM_MOCK: '1', CONFIG_SOURCE: 'file', SERVER_SELFTEST: '1' },
    encoding: 'utf8',
    timeout: 240_000,
  });
  assert.equal(child.error, undefined);
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0);
} else {
  let checks = 0;
  const check = (name: string, ok: boolean): void => {
    assert.ok(ok, name);
    checks++;
  };
  const fixtureDir = path.resolve('data/packs/__fixture');
  const goals = await loadGoals('eval/sim/goals/__fixture');
  check('两个证明包目标', goals.length === 5);
  check(
    '目标都是 __fixture 的',
    goals.every((g) => g.pack === '__fixture' && goalPack(g) === '__fixture'),
  );
  check(
    '目标带 regression 标签（闸只跑带它的）',
    goals.every((g) => g.tags?.includes('regression')),
  );
  const [order, freight] = goals as [SimGoal, SimGoal];
  const lines = [
    { kind: 'widget', code: 'w-a', qty: 200 },
    { kind: 'widget', code: 'w-b', qty: 50 },
  ];

  const customer = await fakeService();
  const sales = await fakeService();
  fakeEnv(sales.url, customer.url);
  const meter = new Meter(1);
  const runtime = await engineRuntime(meter, 'sim-fake-customer', fakePrices, { configDir: fixtureDir });
  try {
    check('运行时装载的是证明包', runtime.deps.pack === '__fixture');
    const execute = async (g: SimGoal) => {
      const report = await simulate([g], 1, meter, runtime.deps);
      check('客户脚本恰好消费', customer.script.length === 0);
      check('销售脚本恰好消费', sales.script.length === 0);
      return report;
    };
    const orderTurns = (orderLines: typeof lines): void => {
      customer.script.push(say('合成方盒甲要200件、合成方盒乙要50件，确认下单'), say('好的，谢谢', true));
      sales.script.push(
        {
          tools: [
            { name: 'fixture_quote', args: { code: 'w-a' } },
            { name: 'fixture_quote', args: { code: 'w-b' } },
          ],
        },
        { content: '合成方盒甲单价3.80元起，合成方盒乙单价12元。' },
        { tools: [{ name: 'fixture_order', args: { lines: orderLines } }] },
        { content: '已为您建好订单，合计1,330元。' },
        { content: '不客气。' },
      );
    };

    // ---- 目标一：询价两种方盒后下单，模型只给条目和数量，133000 分 ----
    orderTurns(lines);
    let report = await execute(order);
    let run = report.runs[0]!;
    check(`目标一通过：${run.reasons.join(' | ')}`, report.summary[0]!.passK && run.status === 'passed');
    check('询价那一轮还没有订单', run.turns[0]!.state.orders.length === 0);
    const built = run.turns[1]!.state.orders[0] as unknown as {
      v: number;
      totalFen: number;
      status: string;
      lines: Record<string, unknown>[];
    };
    check('下单后是一张两行的通用单', run.turns[1]!.state.orders.length === 1 && built.v === 2 && built.lines.length === 2);
    check(
      '133000 分，单价由 priceLine 按阶梯算',
      built.totalFen === 133000 && built.lines[0]!.unitPriceFen === 365 && built.lines[1]!.unitPriceFen === 1200,
    );
    check('订单明细是 73000 + 60000 分', built.lines[0]!.amountFen === 73000 && built.lines[1]!.amountFen === 60000);

    // 下单数量变了：order 谓词按 totalFen 判红（乙 60 件 = 145000 分）
    orderTurns([lines[0]!, { ...lines[1]!, qty: 60 }]);
    report = await execute(order);
    run = report.runs[0]!;
    check(
      '数量变了，totalFen 不是 133000，目标红',
      !report.summary[0]!.passK && run.verdicts.some((v) => v.check === 'predicate[0]:order' && !v.passed),
    );

    // ---- 目标二：问单价与运费、不下单 ----
    customer.script.push(say('好的，我再想想，谢谢', true));
    sales.script.push(
      { tools: [{ name: 'fixture_quote', args: { code: 'w-c' } }] },
      { content: '合成方盒丙单价3.65元，运费10元。' },
      { content: '好的，需要时随时联系。' },
    );
    report = await execute(freight);
    run = report.runs[0]!;
    check(`目标二通过：${run.reasons.join(' | ')}`, report.summary[0]!.passK && run.turns[0]!.state.orders.length === 0);
    check('3.65 元与静态运费 10 元原样放行', /3\.65/.test(run.turns[0]!.reply) && /运费10元/.test(run.turns[0]!.reply));

    // 编造的 3.80 元：金额出处护栏删句，回复里没有 3.65，目标红
    customer.script.push(say('好的，我再想想，谢谢', true));
    sales.script.push(
      { tools: [{ name: 'fixture_quote', args: { code: 'w-c' } }] },
      { content: '合成方盒丙单价3.80元。运费10元。' },
      { content: '好的，需要时随时联系。' },
    );
    report = await execute(freight);
    run = report.runs[0]!;
    check('编造的 3.80 元那一句被删', !run.turns[0]!.reply.includes('3.80') && run.turns[0]!.reply === '运费10元。');
    check(
      'trace 里有 money_provenance 的 drop_sentence',
      run.turns[0]!.trace.turn.guards.some((g) => g.guard === 'money_provenance' && g.action === 'drop_sentence'),
    );
    check('回复里没有查询到的 3.65，目标红', !report.summary[0]!.passK);

    // ---- 种子订单：只给条目和数量，经 priceLine 建成通用单 ----
    const started = await runtime.deps.start({
      profile: { attrs: { color: '红' }, notes: ['老客户'] },
      orders: [
        { status: 'paid', lines: [{ kind: 'widget', code: 'w-c', qty: 10 }] },
        { status: 'pending_payment', lines },
      ],
      history: [{ role: 'customer', content: '我之前问过方盒' }],
    });
    const seeded = started.initial.orders as unknown as { id: string; v: number; status: string; totalFen: number; paidAt?: number }[];
    const paid = seeded.find((o) => o.status === 'paid')!;
    const pending = seeded.find((o) => o.status === 'pending_payment')!;
    check('种子是两张通用单', seeded.length === 2 && seeded.every((o) => o.v === 2));
    check(
      '已付单 10 件 × 3.65 元 = 3650 分，带 paidAt，阶段随之为 paid',
      paid.totalFen === 3650 && paid.paidAt !== undefined && started.initial.stage === 'paid',
    );
    check('待付单 133000 分', pending.totalFen === 133000);
    const store = await import('../../src/store.js');
    check(
      '画像只有 attrs 与 notes',
      JSON.stringify(store.getSession(started.id)!.profile) === JSON.stringify({ attrs: { color: '红' }, notes: ['老客户'] }),
    );
    await runtime.deps.end(started.id);

    // 种子里的待付单被同样的条目和数量再下单复用，订单数不变
    const seededGoal: SimGoal = {
      id: 'fixture-seeded-reuse',
      pack: '__fixture',
      persona: '再下一次同样的单',
      maxTurns: 1,
      customerScript: ['还是原来的数量，再下一单'],
      allowedTools: ['fixture_order'],
      predicates: [
        { kind: 'order', count: 2 },
        { kind: 'tool_called', name: 'fixture_order', min: 1 },
      ],
      forbidden: [],
      initial: {
        orders: [
          { status: 'paid', lines: [{ kind: 'widget', code: 'w-c', qty: 10 }] },
          { status: 'pending_payment', lines },
        ],
      },
    };
    sales.script.push(
      { tools: [{ name: 'fixture_order', args: { lines: lines.toReversed() } }] },
      { content: '已有待付订单，合计1,330元。' },
    );
    report = await execute(seededGoal);
    run = report.runs[0]!;
    const pendingBefore = run.initial.orders.find((o) => o.status === 'pending_payment')!;
    const pendingAfter = run.turns[0]!.state.orders.find((o) => o.status === 'pending_payment')!;
    check('同样的条目再下单复用种子里的待付单', report.summary[0]!.passK && pendingBefore.id === pendingAfter.id);

    // 09：非标确定性转人工、待审报价与自动批准后的确认。
    for (const goal of goals.slice(2)) {
      if (goal.id === 'fixture-quote-pending')
        sales.script.push(
          { tools: [{ name: 'fixture_quote_order', args: { lines: [{ kind: 'widget', code: 'w-c', qty: 100 }] } }] },
          { content: '报价单已提交。\n等顾问审核。' },
        );
      if (goal.id === 'fixture-auto-accepted')
        sales.script.push(
          { tools: [{ name: 'fixture_quote_order', args: { lines: [{ kind: 'widget', code: 'w-c', qty: 2 }] } }] },
          { content: '已生成报价单，请核对。' },
        );
      const proof = await execute(goal);
      check(`09目标通过：${goal.id} ${proof.runs[0]!.reasons.join('|')}`, proof.summary[0]!.passK);
    }

    // ---- 目标的 pack 必须是运行时装载的包 ----
    const travelGoal = validateGoal(
      { id: 'travel-on-fixture', persona: '咨询', allowedTools: [], predicates: [{ kind: 'order', count: 0 }], forbidden: [] },
      'inline.json',
    );
    await assert.rejects(simulate([travelGoal], 1, meter, runtime.deps), /travel-on-fixture: pack: .*travel.*__fixture/);
    await assert.rejects(simulateGate([travelGoal], 0, meter, runtime.deps), /travel-on-fixture: pack/);
    checks += 2;
    check('请求都发给了假服务', sales.requests.length > 0 && customer.requests.length > 0);
    console.log(`SIM FIXTURE SELFTEST PASS：${checks} 项（证明包的两个目标 · 133000 分 · 金额出处删句 · 种子通用单与复用 · 包不符被拒）`);
  } finally {
    await runtime.close();
    await Promise.all([customer.close(), sales.close()]);
  }
}
