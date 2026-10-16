// 06 R10：行数与字数的数法、shape_check 的裁剪顺序、受保护句、不裁剪的情形、耗时。用一份假策略，旅游包的策略见 shape-words.selftest.ts。
import assert from 'node:assert/strict';
import { amountsOf, replyCharCount, replyLineCount, shapeCheckStep, trimToShape } from './shape.js';
import type { ReplyGuardContext, ReplyShape, ShapePolicy } from '../pack-api.js';

// 行数：数非空行
assert.equal(replyLineCount(''), 0);
assert.equal(replyLineCount('   \n\t\n'), 0);
assert.equal(replyLineCount('一句话'), 1);
assert.equal(replyLineCount('第一行\n第二行\n第三行'), 3);
assert.equal(replyLineCount('第一行\n\n\n第二行\r\n第三行\n'), 3);
// 「·」开头的每一项各算一行
assert.equal(replyLineCount('为您找到两条：\n· 云南丽江 6 日\n· 贵州荔波 6 日\n您看哪条合适？'), 4);
// 先去 markdown：列表标记变成「· 」，加粗和标题记号不占行也不占字
assert.equal(replyLineCount('## 推荐\n- 云南\n- 贵州\n**价格**写在同一句里'), 4);
assert.equal(replyLineCount('**加粗**'), 1);

// 字数：去 markdown，不计空白，按码点计
assert.equal(replyCharCount(''), 0);
assert.equal(replyCharCount('你好 呀\n再见'), 5);
assert.equal(replyCharCount('**你好**'), 2);
assert.equal(replyCharCount('- 云南'), 3); // 「· 云南」：· 与两个字
assert.equal(replyCharCount('😊好'), 2);

assert.deepEqual(amountsOf('每人 ¥28,800 起，共 57,600 元，约 5.7 万'), ['28800', '57600', '5.7万']);

// ---------- 假策略 ----------
const policy: ShapePolicy = {
  richMaxLines: 6,
  plainMaxLines: 3,
  maxChars: 300,
  richTools: ['search_routes'],
  asksPrice: (t) => /多少钱|报价/.test(t),
  isClosingTurn: (t) => /先这样/.test(t),
  isRouteTitleLine: (l) => /《[^》]+》/.test(l),
  isClosingLine: (s) => /有问题随时在微信上问我/.test(s),
  proposalSent: () => false,
  droppable: (s, info) => {
    if (!info.closingTurn && /祝|期待|随时/.test(s)) return 'bless';
    if (!info.askedPrice && info.amounts.length && info.amounts.every((a) => info.priorAmounts.has(a))) return 'old_quote';
    return null;
  },
};
const base = { policy, inputText: '你好', priorReplies: [] as string[], priorAmounts: new Set<string>(), proposalSent: false };
const trim = (text: string, over: Partial<typeof base> & { lineCap?: number } = {}) => trimToShape({ ...base, text, lineCap: 3, ...over });

// 没超限：一个字节不变（含末尾空白）
const short = '好的～\n有问题随时跟我说  \n';
assert.deepEqual(trim(short), { text: short, trimmed: 0 });

// 普通类 5 行寒暄裁到 ≤3：祝福 / 期待 / 随时从后往前删
{
  const r = trim('您好呀～\n想去哪儿玩？\n祝您生活愉快！\n期待您的消息～\n有问题随时问我～');
  assert.equal(r.text, '您好呀～\n想去哪儿玩？\n祝您生活愉快！');
  assert.equal(r.trimmed, 2);
}
// 推荐类 7 行裁到 ≤6，受保护的全部在
{
  const lines = [
    '先给您看两条～',
    '《云南 丽江 6 日》每人 ¥16,800 起',
    '《云南 大理 5 日》每人 ¥12,800 起',
    '行程 10 月 12 日出发',
    '祝您旅途愉快～',
    '期待您的消息～',
    '几位出行？',
  ];
  const r = trim(lines.join('\n'), { lineCap: 6 });
  assert.equal(replyLineCount(r.text), 6);
  for (const keep of [lines[1]!, lines[2]!, lines[3]!, lines[6]!]) assert.ok(r.text.includes(keep), keep);
  assert.ok(!r.text.includes('期待'));
}
// 受保护：日期、链接、订单号、转人工、身份、线路名、最后问句，即使可删规则命中也不删
{
  const text = [
    '祝您 10 月 12 日出发顺利～',
    '期待您点开 /pay/ord_0123456789ab 支付～',
    '订单号 ord_0123456789ab 已建好，期待您的消息',
    '我马上为您转接人工，期待您的消息～',
    '我是 AI 助手，期待为您服务～',
    '《云南 丽江 6 日》，期待您的消息',
    '祝您生活愉快，您几位出行？',
    '祝您生活愉快！',
  ].join('\n');
  const r = trim(text, { lineCap: 3 });
  assert.equal(r.text.split('\n').length, 7);
  assert.ok(!r.text.endsWith('祝您生活愉快！'));
}
// 金额首现句受保护；同金额已在最近 3 条回复里且没问价：算复述，可删；问价则保留
{
  const prior = ['《云南 丽江 6 日》每人 ¥16,800 起，共 33,600 元'];
  const text = '好的～\n之前报的每人 ¥16,800 起，共 33,600 元\n您看还有别的想了解的就说\n再确认下人数？';
  const noAsk = trim(text, { lineCap: 3, priorReplies: prior, priorAmounts: new Set(['16800', '33600']) });
  assert.ok(!noAsk.text.includes('¥16,800'), '复述的旧报价被删');
  const asked = trim(text, { lineCap: 3, priorReplies: prior, priorAmounts: new Set(['16800', '33600']), inputText: '多少钱' });
  assert.ok(asked.text.includes('¥16,800'), '客户问价时金额首现句受保护');
  // 本条回复里的新金额从不被删
  const fresh = trim('好的～\n每人 ¥19,800 起\n祝您愉快\n期待回复\n随时找我', { lineCap: 3, priorAmounts: new Set(['16800']) });
  assert.ok(fresh.text.includes('¥19,800'));
}
// 收尾轮：结尾句受保护，祝福不删（非收尾轮才删）
{
  const text = '好的，您先商量～\n祝您生活愉快！\n有问题随时在微信上问我～\n期待您的消息～';
  const r = trim(text, { lineCap: 3, inputText: '先这样' });
  assert.equal(r.text, text);
}
// ① 与最近回复重复的句子先删；② 多余问句只留最后一个
{
  const prior = ['这条线路含全程住宿和接送。'];
  const r = trim('这条线路含全程住宿和接送。\n您几位出行？\n什么时候出发？\n预算大概多少？', { lineCap: 3, priorReplies: prior });
  assert.ok(!r.text.includes('含全程住宿'), '①重复句先删');
  assert.ok(r.text.endsWith('预算大概多少？'), '最后一个问句保留');
  assert.equal(replyLineCount(r.text), 3);
}
// 不会删光：只剩一个单位时不删
assert.equal(trim('祝您愉快！期待回复！随时联系！\n祝你好\n祝你好呀\n祝好\n祝好呀', { lineCap: 1 }).text.trim() !== '', true);

// 方案书链接的 ?v= 版本后缀不断句
{
  const link = '方案书在这里：/proposal/p_abc123/2?v=2，期待您的消息';
  const r = trim(`${link}\n祝您愉快\n期待回复\n随时找我`, { lineCap: 3 });
  assert.ok(r.text.includes('/proposal/p_abc123/2?v=2'));
}

// 耗时：30 行输入裁剪 <5 毫秒
{
  const many = Array.from({ length: 30 }, (_, i) => (i % 3 ? `祝您第 ${i} 天愉快～` : `这是第 ${i} 条说明，讲线路和住宿。`)).join('\n');
  trim(many, { lineCap: 3 });
  const t0 = performance.now();
  trim(many, { lineCap: 3 });
  assert.ok(performance.now() - t0 < 5, `裁剪耗时 ${performance.now() - t0} ms`);
}

// ---------- 步骤：形状、事件、不裁剪的情形 ----------
function makeCtx(over: {
  text: string;
  inputText?: string;
  tools?: string[];
  fixed?: boolean;
  handoff?: boolean;
  thresholds?: object;
  agent?: string[];
}) {
  const events: string[] = [];
  const flags: Record<string, unknown> = over.fixed ? { fixedReply: true } : {};
  const ctx = {
    text: over.text,
    inputText: over.inputText ?? '你好',
    thresholds: over.thresholds ?? { shape: policy },
    toolSources: (over.tools ?? []).map((name) => ({ name, args: {} })),
    turn: { flags },
    session: { handedOver: false, messages: (over.agent ?? []).map((content) => ({ role: 'agent', content, at: 0 })) },
    handoffThisTurn: () => !!over.handoff,
    recordGuard: (g: string, _b: string, _a: string, action: string) => events.push(`${g}:${action}`),
  } as unknown as ReplyGuardContext;
  return { ctx, events, shape: () => flags.replyShape as ReplyShape | undefined };
}
const step = shapeCheckStep();
assert.equal(step.id, 'shape_check');
assert.deepEqual(step.after, ['identity']);
assert.deepEqual(step.writes, ['replyShape']);

const long = '您好呀～\n想去哪儿玩？\n祝您生活愉快！\n期待您的消息～\n有问题随时问我～';
{
  const c = makeCtx({ text: long });
  const verdict = await step.run(c.ctx);
  assert.equal(verdict.action, 'drop_sentence');
  assert.equal(c.ctx.text, '您好呀～\n想去哪儿玩？\n祝您生活愉快！');
  assert.deepEqual(c.events, ['shape_check:drop_sentence']);
  assert.deepEqual(c.shape(), {
    class: 'plain',
    lines: 3,
    chars: c.shape()!.chars,
    limit: 3,
    trimmed: 2,
    overLimit: false,
    rewrite: 'off',
    rewriteMs: null,
  });
}
// 推荐类：本轮调过 search_routes
{
  const c = makeCtx({ text: long, tools: ['search_routes'] });
  assert.deepEqual(await step.run(c.ctx), { action: 'pass' });
  assert.equal(c.ctx.text, long);
  assert.equal(c.shape()!.class, 'rich');
  assert.equal(c.shape()!.limit, 6);
  assert.equal(c.shape()!.overLimit, false);
}
// 整段由代码生成的回复与转人工轮：不删句，只记形状（超限标 overLimit）
for (const o of [{ fixed: true }, { handoff: true }]) {
  const c = makeCtx({ text: long, ...o });
  assert.deepEqual(await step.run(c.ctx), { action: 'pass' }, JSON.stringify(o));
  assert.equal(c.ctx.text, long);
  assert.equal(c.shape()!.trimmed, 0);
  assert.equal(c.shape()!.overLimit, true);
  assert.deepEqual(c.events, []);
}
// 代码整段生成的推荐 / 线路列表（rich 且 fixedReply）有单独的上限 8（06 Open 4）；模型写的回复仍按 rich 6 / plain 3
{
  const withList = { shape: { ...policy, generatedListMaxLines: 8 } };
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `第${i + 1}句。`).join('\n');
  const eight = makeCtx({ text: lines(8), tools: ['search_routes'], fixed: true, thresholds: withList });
  assert.deepEqual(await step.run(eight.ctx), { action: 'pass' });
  assert.equal(eight.ctx.text, lines(8));
  assert.deepEqual(
    { limit: eight.shape()!.limit, over: eight.shape()!.overLimit, list: eight.shape()!.generatedList, trimmed: eight.shape()!.trimmed },
    { limit: 8, over: false, list: true, trimmed: 0 },
    '代码生成的 8 行列表：上限 8，不超限',
  );
  const nine = makeCtx({ text: lines(9), tools: ['search_routes'], fixed: true, thresholds: withList });
  await step.run(nine.ctx);
  assert.deepEqual([nine.shape()!.limit, nine.shape()!.overLimit, nine.ctx.text === lines(9)], [8, true, true], '9 行仍超限，且不裁');
  const model7 = makeCtx({ text: lines(7), tools: ['search_routes'], thresholds: withList });
  await step.run(model7.ctx);
  assert.deepEqual(
    { limit: model7.shape()!.limit, over: model7.shape()!.overLimit, list: model7.shape()!.generatedList },
    { limit: 6, over: true, list: undefined },
    '模型写的 7 行回复：仍按 rich 6，超限',
  );
  const plainFixed = makeCtx({ text: lines(4), fixed: true, thresholds: withList });
  await step.run(plainFixed.ctx);
  assert.deepEqual(
    [plainFixed.shape()!.limit, plainFixed.shape()!.generatedList, plainFixed.shape()!.overLimit],
    [3, undefined, true],
    'plain 类代码生成不沾光',
  );
  const handoffRich = makeCtx({ text: lines(8), tools: ['search_routes'], handoff: true, thresholds: withList });
  await step.run(handoffRich.ctx);
  assert.deepEqual(
    [handoffRich.shape()!.limit, handoffRich.shape()!.generatedList, handoffRich.shape()!.overLimit],
    [6, undefined, true],
    '转人工轮不算',
  );
  // 包没给 generatedListMaxLines：行为不变
  const noList = makeCtx({ text: lines(8), tools: ['search_routes'], fixed: true });
  await step.run(noList.ctx);
  assert.deepEqual([noList.shape()!.limit, noList.shape()!.generatedList, noList.shape()!.overLimit], [6, undefined, true]);
}
// 裁完仍超限：发裁剪稿，overLimit 为真
{
  const c = makeCtx({ text: '第一句。\n第二句。\n第三句。\n第四句。\n祝你好～' });
  await step.run(c.ctx);
  assert.equal(c.shape()!.overLimit, true);
  assert.equal(c.shape()!.trimmed, 1);
}
// 包没给策略：放行，不记形状
{
  const c = makeCtx({ text: long, thresholds: {} });
  assert.deepEqual(await step.run(c.ctx), { action: 'pass' });
  assert.equal(c.shape(), undefined);
}
// 空文本放行
{
  const c = makeCtx({ text: '' });
  assert.deepEqual(await step.run(c.ctx), { action: 'pass' });
}

console.log('shape 自测通过：数法、裁剪顺序、受保护句、不裁剪的情形、耗时、步骤形状');
