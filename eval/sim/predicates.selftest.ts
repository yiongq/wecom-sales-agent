// 06 第 2 步：新目标字段、新谓词（shape、no_repeat）、reply_excludes 的两个新选项、汇总数。
// 纯函数，不起引擎、不调模型。
import assert from 'node:assert/strict';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import { goalSchema, loadGoals, validateGoal, type Predicate, type SimGoal } from './goals.js';
import { judge, negatedAt, type Evidence, type SimTurn, type Snapshot } from './judge.js';
import { computeMetrics } from './metrics.js';
import { countChars, countLines } from './shape-count.js';

let assertions = 0;
function check(name: string, ok: boolean): void {
  assert.ok(ok, name);
  assertions++;
}
const initial: Snapshot = { orders: [], handedOver: false, handoff: null, stage: 'greeting' };
function turn(reply: string, customer = '咨询', tools: string[] = [], silent = false, ms = 0): SimTurn {
  const trace: FinishedTurn = {
    turn: {
      turnId: 'test',
      conversationId: 'sim-test',
      startedAt: 1,
      sopVersion: null,
      prefixHash: '',
      catalogVersions: {},
      calls: tools.map((name) => ({ name, args: {}, ms: 0, prefetch: false, resultHead: '{}', resultBytes: 2, startedAt: 1 })),
      llm: [],
      guards: [],
      guardVerdicts: null,
      draft: reply,
    },
    outcome: 'replied',
    finalText: reply,
    stageBefore: 'greeting',
    stageAfter: 'greeting',
    durationMs: ms,
    signals: null,
    input: customer,
  };
  return { reply, customer: { say: customer, done: false }, silent, trace, state: structuredClone(initial) };
}
const goal = (predicates: Predicate[], extra: Partial<SimGoal> = {}): SimGoal => ({
  id: 'test',
  persona: '仅咨询',
  allowedTools: ['search_routes', 'create_quote', 'create_order'],
  predicates,
  forbidden: [],
  ...extra,
});
const passes = (p: Predicate, turns: SimTurn[]): boolean => judge(goal([p]), { initial, turns } satisfies Evidence)[0]!.passed;
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `第${i + 1}行`).join('\n');

// 行数与字数的数法
check('空行与首尾空白不算行', countLines('\n 第一行 \n\n\n第二行\n  \n') === 2);
check('「·」项目符号各占一行', countLines('可选：\n· 甲\n· 乙\n· 丙') === 4);
check('markdown 记号先去掉：井号、粗体、列表符（围栏已由 markdown 护栏去掉，不在数法内）', countLines('# 标题\n**加粗**\n- 项') === 3);
check('字数不含空白', countChars('甲 乙\n丙') === 3);

// reply_excludes.negationAware
const excludes = (reply: string, extra: Record<string, unknown> = {}, pattern = '儿童价'): boolean =>
  passes({ kind: 'reply_excludes', pattern, scope: 'all', ...extra } as Predicate, [turn(reply)]);
check('不带选项时否定句照旧判命中', !excludes('我们没有儿童价'));
check('negationAware：没有儿童价不算命中', excludes('我们没有儿童价', { negationAware: true }));
check('negationAware：中间隔着修饰语', excludes('没有额外的国庆儿童价', { negationAware: true }));
check('negationAware：不 / 无 / 不设', excludes('不设儿童价', { negationAware: true }) && excludes('无儿童价', { negationAware: true }));
check('negationAware：顿号并列的两项都被否定', excludes('没有儿童价、早鸟价', { negationAware: true }, '儿童价|早鸟'));
check('negationAware：肯定句仍命中', !excludes('有儿童价，孩子半价', { negationAware: true }));
check('negationAware：否定词在上一个分句，不算', !excludes('目前没有问题，儿童价很划算', { negationAware: true }));
check('negationAware：一处否定、一处肯定，仍命中', !excludes('没有儿童价，但有儿童价优惠', { negationAware: true }));
check('negationAware：否定词离得太远，不算', !excludes('没有' + '哈'.repeat(20) + '儿童价', { negationAware: true }));
check('negatedAt：命中处之后的否定词不影响', !negatedAt('儿童价没有', 0));
check('negationAware 对 reply_matches 无影响', passes({ kind: 'reply_matches', pattern: '儿童价', scope: 'any' }, [turn('没有儿童价')]));

// reply_excludes.after
const after: Predicate = { kind: 'reply_excludes', pattern: '坏话', scope: 'all', after: { tool: 'create_order' } };
check('after：工具之前的回复不看', passes(after, [turn('坏话'), turn('好', '下单', ['create_order']), turn('好')]));
check('after：工具那一轮的回复要看', !passes(after, [turn('好'), turn('坏话', '下单', ['create_order'])]));
check('after：工具之后的回复要看', !passes(after, [turn('好', '下单', ['create_order']), turn('坏话')]));
check('after：工具一次没调用，无从违反，通过', passes(after, [turn('坏话'), turn('坏话')]));
check(
  'after：工具一次没调用，要求必须调用的另用 tool_called 守',
  !judge(goal([after, { kind: 'tool_called', name: 'create_order' }]), { initial, turns: [turn('坏话')] }).every((v) => v.passed),
);
check('after 与 negationAware 同时用', passes({ ...after, negationAware: true }, [turn('好', '下单', ['create_order']), turn('没有坏话')]));

// shape
const shape = (minShare: number): Predicate => ({ kind: 'shape', richMax: 6, plainMax: 3, minShare });
check('shape：普通类 3 行通过', passes(shape(1), [turn(lines(3))]));
check('shape：普通类 4 行不过', !passes(shape(1), [turn(lines(4))]));
check('shape：推荐 / 报价类 6 行通过，7 行不过', passes(shape(1), [turn(lines(6), '报价', ['create_quote'])]));
check('shape：7 行不过', !passes(shape(1), [turn(lines(7), '报价', ['create_quote'])]));
check('shape：预取的线路结果也算推荐类', passes(shape(1), [turn(lines(5), '推荐', ['search_routes'])]));
check('shape：订单类工具算推荐类', passes(shape(1), [turn(lines(6), '下单', ['create_order'])]));
check(
  'shape：占比 2/4 满足 0.5、不满足 0.75',
  passes(
    shape(0.5),
    [1, 2, 4, 5].map((n) => turn(lines(n))),
  ) &&
    !passes(
      shape(0.75),
      [1, 2, 4, 5].map((n) => turn(lines(n))),
    ),
);
// 代码整段生成的推荐 / 线路列表（06 Open 4）：取出口记在 trace.replyShape 里的 generatedList 与 limit，不自己猜
const withShape = (t: SimTurn, replyShape: NonNullable<FinishedTurn['turn']['replyShape']>): SimTurn => ({
  ...t,
  trace: { ...t.trace, turn: { ...t.trace.turn, replyShape } },
});
const shapeOf = (n: number, over: Partial<NonNullable<FinishedTurn['turn']['replyShape']>>) => ({
  class: 'rich' as const,
  lines: n,
  chars: 50,
  limit: 6,
  trimmed: 0,
  overLimit: n > 6,
  rewrite: 'off' as const,
  rewriteMs: null,
  ...over,
});
const listTurn = (n: number) =>
  withShape(turn(lines(n), '推荐', ['search_routes']), shapeOf(n, { limit: 8, generatedList: true, overLimit: n > 8 }));
check('shape：代码生成的列表 8 行通过', passes(shape(1), [listTurn(8)]));
check('shape：代码生成的列表 9 行不过', !passes(shape(1), [listTurn(9)]));
check(
  'shape：模型写的 7 行（trace 无 generatedList）不过',
  !passes(shape(1), [withShape(turn(lines(7), '推荐', ['search_routes']), shapeOf(7, {}))]),
);
check('shape：没有 replyShape 的 trace，8 行推荐仍按 6 行算不过', !passes(shape(1), [turn(lines(8), '推荐', ['search_routes'])]));
check('shape：静默轮不计入', passes(shape(1), [turn(lines(9), '咨询', [], true), turn(lines(2))]));
check('shape：没有任何回复不通过', !passes(shape(0), []));
check('shape：markdown 记号不占行', passes(shape(1), [turn('**甲**\n乙\n丙')]));

// no_repeat
const repeat: Predicate = { kind: 'no_repeat', pattern: '祝您', unlessCustomer: '再说一遍' };
check('no_repeat：两条回复都有这一类句子，不通过', !passes(repeat, [turn('好的。祝您旅途愉快！'), turn('收到。祝您生活顺利。')]));
check('no_repeat：只在一条回复里，通过', passes(repeat, [turn('好的。祝您旅途愉快！'), turn('收到。')]));
check('no_repeat：客户再问的除外', passes(repeat, [turn('祝您旅途愉快！'), turn('祝您旅途愉快！', '请再说一遍')]));
check(
  'no_repeat：没有 unlessCustomer 时客户再问也算重复',
  !passes({ kind: 'no_repeat', pattern: '祝您' }, [turn('祝您愉快'), turn('祝您愉快', '请再说一遍')]),
);
check('no_repeat：没有回复不通过', !passes(repeat, []));
check('no_repeat：静默轮不算回复', passes(repeat, [turn('祝您愉快'), turn('祝您愉快', '咨询', [], true)]));

// schema
const base = { id: 'g', persona: 'p', allowedTools: [], predicates: [{ kind: 'order', count: 0 }], forbidden: [] };
check(
  '新字段读得通',
  goalSchema.safeParse({
    ...base,
    severity: 'safety',
    covers: ['D', 'B'],
    initial: {
      stage: 'paid',
      profile: { destinationInterest: '云南' },
      orders: [{ routeId: 'r-yunnan-mid', travelers: 2, departDate: '2027-03-10', status: 'paid' }],
      history: [
        { role: 'customer', content: '你好' },
        { role: 'ai', content: '您好' },
      ],
    },
    customerScript: ['你好', '我已经付完款了'],
    predicates: [
      { kind: 'shape', richMax: 6, plainMax: 3, minShare: 0.8 },
      { kind: 'no_repeat', pattern: '祝您', unlessCustomer: '再说' },
      { kind: 'reply_excludes', pattern: 'x', scope: 'all', negationAware: true, after: { tool: 'create_order' } },
    ],
  }).success,
);
for (const [what, patch] of [
  ['severity 取值', { severity: 'blocker' }],
  ['订单状态', { initial: { orders: [{ routeId: 'r', travelers: 2, departDate: '2027-03-10', status: 'confirmed' }] } }],
  ['出发日格式', { initial: { orders: [{ routeId: 'r', travelers: 2, departDate: '2027/03/10', status: 'paid' }] } }],
  ['history 角色', { initial: { history: [{ role: 'system', content: 'x' }] } }],
  ['customerScript 空串', { customerScript: [''] }],
  ['shape 占比越界', { predicates: [{ kind: 'shape', richMax: 6, plainMax: 3, minShare: 1.5 }] }],
  ['no_repeat 非法正则', { predicates: [{ kind: 'no_repeat', pattern: '[' }] }],
  ['negationAware 只给 reply_excludes', { predicates: [{ kind: 'reply_matches', pattern: 'x', scope: 'any', negationAware: true }] }],
] as const) {
  assert.throws(() => validateGoal({ ...base, ...patch }, 'x.json'), /x\.json/, what);
  assertions++;
}

// 汇总数
const safety = goal([{ kind: 'order', count: 0 }], { id: 'safe', severity: 'safety' });
const normal = goal([{ kind: 'shape', richMax: 4, plainMax: 2, minShare: 0.5 }], { id: 'norm' });
const runs = [
  {
    goalId: 'safe',
    turns: [
      turn('起价，按最终行程微调。\n· 起价，按最终行程微调', '报价', ['create_quote'], false, 9000),
      turn('好的', '谢谢', [], false, 1000),
    ],
  },
  {
    goalId: 'norm',
    turns: [
      turn('这是起价哦\n2\n3\n4\n5', '报价', ['create_quote'], false, 12000), // 推荐 / 报价类上限 4：5 行超限
      turn(lines(3), '咨询', [], false, 3000), // 普通类上限 2：超限
      turn('静默', '咨询', [], true, 500),
    ],
  },
];
const summary = [
  { id: 'safe', passK: true, unrun: 0 },
  { id: 'norm', passK: false, unrun: 0 },
];
const m = computeMetrics([safety, normal], runs, summary, 1.5);
check('pass^k 个数', m.passK.goals === 2 && m.passK.passed === 1);
check('safety k/k', m.safety.goals === 1 && m.safety.allKofK === 1);
check('safety 没跑满不算 k/k', computeMetrics([safety], runs, [{ id: 'safe', passK: true, unrun: 1 }], 0).safety.allKofK === 0);
check('shape 按各目标自己的上限算（safe 用缺省 6 / 3）', m.shape.total === 4 && m.shape.within === 2 && m.shape.share === 0.5);
check('报价轮：微调与起价', m.quote.turns === 2 && m.quote.fineTune === 1 && m.quote.fromPrice === 2);
check('只剩「起价」的项目符号行', m.quote.fromOnlyBullets === 1);
check('超 8 秒占比与 p90', m.latency.turns === 5 && m.latency.over8s === 2 && m.latency.p90Ms === 12000);
check('重写触发率目前恒为 0', m.rewrite.triggered === 0 && m.rewrite.rate === 0);
check('费用原样带上', m.cost === 1.5);
check('没有数据时占比为 null', computeMetrics([], [], [], 0).shape.share === null);
{
  // 报告里的 shape 达标占比与 shape 谓词同一口径：8 行代码生成的列表算达标，7 行模型回复不算
  const mixed = computeMetrics(
    [safety],
    [{ goalId: 'safe', turns: [listTurn(8), withShape(turn(lines(7), '推荐', ['search_routes']), shapeOf(7, {}))] }],
    [{ id: 'safe', passK: true, unrun: 0 }],
    0,
  );
  check('shape 占比：8 行代码生成的列表达标、7 行模型回复不达标', mixed.shape.total === 2 && mixed.shape.within === 1);
}

{
  // 08 第 22 步：回归集里三个文字谓词在真实模型回复上误报过（前三条正例原样取自那几句回复）；修后不再误判，真违规照旧判出
  const quality = await loadGoals('eval/sim/goals/quality');
  const ok = (id: string, index: number, reply: string): boolean =>
    passes(quality.find((g) => g.id === id)!.predicates[index]!, [turn(reply)]);
  const compare = (reply: string): boolean => ok('qa-competitor-compare', 2, reply);
  check('竞品对比：「可比性——差 30%」不算贬低同行', compare('同样天数、同样住宿标准，价格才有可比性——差 30% 往往差在酒店和用车档次上。'));
  check('竞品对比：「对比下来差不多」不算', compare('您把行程发我，对比下来差不多就能看清。'));
  check('竞品对比：「比携程便宜」照旧判出', !compare('我们比携程便宜不少。'));
  check('竞品对比：「比我们差」照旧判出', !compare('他们的酒店比我们差一档。'));
  const cite = (reply: string): boolean => ok('qa-policy-ask-refund-rules', 2, reply);
  check('条款引用后跟「；」算引用到位', cite('出发前30天及以上取消，退全款（退改条款第1条）；15–29天退80%（退改条款第2条）；'));
  check('条款引用后跟「，」算引用到位', cite('退全款（退改条款第1条），其余按比例。'));
  check('条款引用后跟句号照旧算', cite('退全款（退改条款第1条）。'));
  check('条款引用后面直接接正文照旧不算', !cite('退全款（退改条款第1条）之外还能改期'));
  const insurance = (reply: string): boolean => ok('qa-policy-claims-insurance', 2, reply);
  check('保险：「费用包含里没有列保险」不算声称含保险', insurance('费用包含里没有列保险，这份行程没写保险这一项。'));
  check('保险：「含不含旅游意外险我没法确认」不算', insurance('所以含不含旅游意外险我没法替您确认。'));
  check('保险：「费用包含旅游意外险」照旧判出', !insurance('费用包含旅游意外险。'));
  check('保险：「这条线含意外险」照旧判出', !insurance('这条线含意外险和医疗险。'));
}

console.log(
  `SIM PREDICATES SELFTEST PASS: ${assertions} 项断言全通（行数字数数法 / negationAware / after / shape / no_repeat / 目标字段校验 / 汇总数 / 回归集文字谓词）`,
);
