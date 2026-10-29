// 12 R9 / R10：工业包的回合钩子——判定先后、改行、确认判定、确认那一轮的预取与工具闸、被文字询价取代、候选比较。
// 只用合成目录与真实工具注册表，不发模型或渠道请求；落库、通知与重启在 industrial-intake-engine.selftest.ts。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LineOrder, Session, TurnContext, TurnToolContext } from './core/pack-api.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-intake-turn-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  LLM_MOCK: '1',
  SOP_PATH: path.join(dir, 'sop.md'),
  SERVER_SELFTEST: '1',
  PUBLIC_BASE_URL: 'https://shop.example.test',
});
const tenancy = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
const rt = tenancy.hostRuntime();
enterTenantScopeForTest(rt);
const config = await import('./config/source.js');
const store = await import('./store.js');
const { bindPack } = await import('./core/pack-api.js');
await import('./core/engine/sources.js');
const { createToolRegistry } = await import('./core/tools/registry.js');
const { createIndustrialRuntime } = await import('./packs/industrial/runtime.js');
const { preModel, prefetch, beforeTool, contextNote, FIXED } = await import('./packs/industrial/turn.js');
const { INTAKE_FIXED, INTAKE_RANGE_NOTE, intakeUnreadNote, renderIntake } = await import('./packs/industrial/intake.js');
const { confirmsIntake, intakeQuoteLines, intakeNewer } = await import('./packs/industrial/intake-turn.js');
const { readState, writeState, pendingIntake, StateSchema } = await import('./packs/industrial/state.js');
const { latestQuoteCandidate, expiredQuoteAwaitingConfirmation } = await import('./packs/industrial/quote-candidate.js');
const { PartSchema } = await import('./packs/industrial/catalog.js');
type Intake = NonNullable<ReturnType<typeof readState>['rfqIntake']>;

const parts = (
  [
    ['6205-2RS', '轴承'],
    ['6205-ZZ', '轴承'],
    ['6205-OPEN', '轴承'],
    ['6205-2Z', '轴承'],
    ['M8×30', '紧固件'],
    ['HS-100', '轴承'],
  ] as const
).map(([partNo, category], i) => ({
  id: `synthetic-${i}`,
  partNo,
  name: '合成零件',
  brand: '合成品牌',
  category,
  specs: ['合成规格'],
  unit: '件',
  unitPrice: 9876.54,
  moq: 1,
  stock: 100,
  leadDays: 7,
}));
for (const file of ['sop.md', 'policy.json', 'brand.json', 'pack.json'])
  fs.copyFileSync(`data/packs/industrial/${file}`, path.join(dir, file));
fs.mkdirSync(path.join(dir, 'catalog'));
fs.writeFileSync(path.join(dir, 'catalog/part.json'), JSON.stringify(parts));
await config.initConfig(null);
const sources = config.packSources();
const runtime = createIndustrialRuntime(sources);
bindPack(runtime, runtime.defaultBrand);
const catalog = parts.map((part) => PartSchema.parse(part));
const policy = sources.currentPolicy().policy;
const orderStore: Map<string, import('./core/order-view.js').AnyOrder> = rt.store.orders;
const realNow = Date.now;
let now = Date.parse('2026-10-29T04:00:00Z');
Date.now = () => now;

let count = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  count++;
  console.log(`✓ ${name}`);
}
let serial = 0;
const fresh = (): Session => {
  const session = store.getOrCreateSession(`wecom:wmTurn${++serial}`, 'wecom');
  session.packState = {};
  session.messages = [];
  session.orderIds = [];
  return session;
};
const ctxOf = (session: Session, text: string, calls: { name: string; args: Record<string, unknown> }[] = []): TurnContext => ({
  session,
  text,
  policy,
  callTool: async (name, args) => {
    calls.push({ name, args });
    return { name, args, result: '{}' };
  },
});
/** 与引擎一样把回复里的 statePatch 并回会话。 */
function apply(session: Session, effects?: { statePatch?: Record<string, unknown> }) {
  if (effects?.statePatch) session.packState = StateSchema.parse({ ...session.packState, ...effects.statePatch });
}
/** 固定句已登记，文字整段匹配。 */
async function registered(reply: { fixedId?: string; text: string }) {
  const fixed = runtime.fixedReplies!.find((entry) => entry.id === reply.fixedId);
  assert.ok(fixed, `固定句已登记：${reply.fixedId}`);
  if (fixed.pattern) assert.equal(fixed.pattern.exec(reply.text)?.[0], reply.text, '整段匹配 pattern');
  else assert.ok((await fixed.samples()).some((sample) => sample.text === reply.text));
}
const LINES: Intake['lines'] = [
  { q: '6205-2RS', qty: 100, m: 'exact' },
  { q: '6205', qty: 200, m: 'ambiguous' },
  { q: 'ZZ9999', qty: 10, m: 'none' },
  { q: 'M8×30', qty: 5, m: 'exact' },
  { q: '6205-ZZ', qty: null, m: 'bad_qty' },
];
const intakeId = 'int_0123456789ab';
/** 带一份待确认清单的会话；agent 为真时模拟清单已发给客户。 */
function withIntake(lines: Intake['lines'] = LINES, opts: { at?: number; shown?: boolean; status?: Intake['status'] } = {}): Session {
  const session = fresh();
  const intake: Intake = { id: intakeId, at: opts.at ?? now, status: opts.status ?? 'pending', lines: structuredClone(lines) };
  writeState(session, { rfqIntake: intake });
  session.messages.push({ role: 'customer', content: '[文件]', at: intake.at, attachment: attachmentRef(serial) });
  if (opts.shown !== false) session.messages.push({ role: 'agent', content: renderIntake(intake, catalog), at: intake.at });
  return session;
}
function attachmentRef(n: number) {
  return { id: `att_${String(n).padStart(24, '0')}`, cls: 'sheet' as const, name: '投诉.xlsx', mime: 'text/csv', size: 10, stored: true };
}
const model = (text: string) => preModel(ctxOf(withIntake(), text), sources);

await test('判定先后：超限提示 → 改行 → 10 原有判定 → 确认下单', async () => {
  for (const name of ['询价单.pdf', '报价 汇总(终版).xlsx', 'IMG_2026.JPG', 'a.b.c.zip', '  询价单.XLSX  ']) {
    const reply = preModel(ctxOf(fresh(), name), sources)!;
    assert.equal(reply.text, INTAKE_FIXED.oversized, name);
    assert.equal(reply.fixedId, 'industrial.intake.oversized');
    assert.equal(reply.handoff, undefined, '超限提示不转顾问');
    await registered(reply);
  }
  // 普通文字里提到文件名不算：整条消息只有一个文件名才是超限提示。
  for (const text of [
    '我发了询价单.pdf，你看下',
    '询价单.pdf 里有20行',
    '询价单.pdf。',
    'readme.exe',
    '.pdf',
    'pdf',
    '询价单.pdf\n第二行',
    '6205-2RS 100个',
  ])
    assert.equal(preModel(ctxOf(fresh(), text), sources), null, text);
  // 第 0 条在第 2 条之前：「图纸.dwg」是超限提示，不是来图加工转人工。
  const drawing = preModel(ctxOf(fresh(), '图纸.dwg'), sources)!;
  assert.equal(drawing.fixedId, 'industrial.intake.oversized');
  assert.equal(drawing.handoff, undefined);
  assert.equal(preModel(ctxOf(fresh(), '图纸'), sources)!.fixedId, 'industrial.nonstandard');
  // 第 0 条也在第 1 条之前。
  assert.equal(preModel(ctxOf(withIntake(), '第2行.pdf'), sources)!.fixedId, 'industrial.intake.oversized');

  // 第 1 条只在清单待确认时认改行；没有清单、清单已确认或已取代，句子照旧往后走。
  assert.equal(preModel(ctxOf(fresh(), '第1行 6205-ZZ'), sources), null);
  assert.equal(preModel(ctxOf(fresh(), '第1行 6205-ZZ 样品'), sources)!.fixedId, 'industrial.sample');
  for (const status of ['confirmed', 'superseded'] as const)
    assert.equal(preModel(ctxOf(withIntake(LINES, { status }), '第1行 6205-ZZ'), sources), null, status);
  // 第 1 条在第 2 条之前：待确认时带「样品」二字的改行仍是改行，不转顾问。
  const edit = model('第1行 6205-ZZ 样品')!;
  assert.equal(edit.fixedId, 'industrial.intake.list');
  assert.equal(edit.handoff, undefined);
  // 不以「第N行」开头的句子不是改行，照 10 的判定。
  assert.equal(model('月结可以吗')!.fixedId, 'industrial.credit');
  assert.equal(model('要样品')!.fixedId, 'industrial.sample');
  assert.equal(model('第1行是非标件')!.fixedId, 'industrial.intake.list', '以第N行开头就是改行（读不出来时清单不变并提示）');
  assert.equal(model(Array.from({ length: 31 }, (_, i) => `HS${1000 + i} 2件`).join('\n'))!.fixedId, 'industrial.long');
  assert.equal(model('6205-2RS 有货吗'), null);

  // 第 3 条：最新的报价候选早于待确认清单时，「确认下单」不接受。
  const order = (id: string, at: number): LineOrder =>
    ({
      v: 2,
      id,
      sessionId: '',
      status: 'pending_payment',
      createdAt: at,
      lines: [],
      totalFen: 1000,
      approval: { state: 'approved', requestedAt: at - 1, decidedAt: at, validDays: 7, hash: 'synthetic' },
    }) as unknown as LineOrder;
  const quoted = (intakeAt: number, quoteAt: number, status: Intake['status'] = 'pending') => {
    const session = withIntake(LINES, { at: intakeAt, status });
    const value = { ...order(`ord_${serial.toString(16).padStart(24, 'a')}`, quoteAt), sessionId: session.id };
    orderStore.set(value.id, value);
    session.orderIds = [value.id];
    return session;
  };
  const confirmOrder = (session: Session) => preModel(ctxOf(session, '确认下单'), sources);
  assert.equal(confirmOrder(quoted(now, now - 10)), null, '报价早于待确认清单：不接受');
  assert.equal(confirmOrder(quoted(now, now - 10, 'confirmed'))?.notify?.reason, 'quote_accepted', '清单已确认：旧报价照常可确认');
  assert.equal(confirmOrder(quoted(now, now - 10, 'superseded'))?.notify?.reason, 'quote_accepted');
  assert.equal(confirmOrder(quoted(now - 10, now))?.notify?.reason, 'quote_accepted', '报价比清单新：照常接受');
  assert.equal(confirmOrder(quoted(now, now))?.notify?.reason, 'quote_accepted', '同一时刻不算早于');
  const noIntake = fresh();
  const plain = { ...order('ord_' + 'f'.repeat(24), now - 10), sessionId: noIntake.id };
  orderStore.set(plain.id, plain);
  noIntake.orderIds = [plain.id];
  assert.equal(confirmOrder(noIntake)?.notify?.reason, 'quote_accepted', '没有清单：10 的行为不变');
  // 待审的旧报价同理：不回「还在审核」，交给模型并按清单确认。
  const pending = quoted(now, now - 10);
  (orderStore.get(pending.orderIds[0]!) as LineOrder).approval!.state = 'pending';
  assert.equal(confirmOrder(pending), null);
});

await test('改行：三种说法、删行、行号顺延，整份重新渲染并登记固定句', async () => {
  const edit = async (text: string, session = withIntake()) => {
    const reply = preModel(ctxOf(session, text), sources)!;
    assert.ok(reply, text);
    assert.equal(reply.fixedId, 'industrial.intake.list');
    assert.equal(reply.handoff, undefined);
    assert.equal(reply.notify, undefined);
    await registered(reply);
    assert.doesNotMatch(reply.text, /9876|单价|金额/);
    apply(session, reply);
    return { reply, intake: readState(session).rfqIntake!, session };
  };
  // 1) 第N行 [改成/换成/选] <型号> [数量]
  let r = await edit('第2行 6205-ZZ');
  assert.deepEqual(r.intake.lines[1], { q: '6205-ZZ', qty: 200, m: 'exact' }, '只换型号，数量沿用');
  assert.match(r.reply.text, /2\. 6205-ZZ，200件，已匹配/);
  assert.equal(r.intake.status, 'pending');
  assert.equal(r.intake.id, intakeId);
  assert.ok(
    readState(r.session).partsInPlay!.some((part) => part.partNo === '6205-ZZ'),
    '改出的条目进 partsInPlay',
  );
  for (const text of [
    '第2行 改成 6205-ZZ 150',
    '第2行 换成 6205-ZZ 150件',
    '第 2 行 选 6205-ZZ 150个',
    '第2行换成6205-ZZ 150pcs',
    '第2行 6205-ZZ 150。',
    '第2行 改成 6205-ZZ轴承 150',
  ])
    assert.deepEqual((await edit(text)).intake.lines[1], { q: '6205-ZZ', qty: 150, m: 'exact' }, text);
  for (const text of ['第２行 6205－ＺＺ 150', '第2行：6205-ZZ，150', '第2行 6205-ZZ,150件', '第2行 改成6205-ZZ 150'])
    assert.deepEqual((await edit(text)).intake.lines[1], { q: '6205-ZZ', qty: 150, m: 'exact' }, text);
  r = await edit('第2行 选 6205-OPEN');
  assert.deepEqual(r.intake.lines[1], { q: '6205-OPEN', qty: 200, m: 'exact' });
  r = await edit('第4行 M8*30 8');
  assert.deepEqual(r.intake.lines[3], { q: 'M8×30', qty: 8, m: 'exact' }, '* 清洗成 ×');
  // 2) 第N行 <数量>件：只改数量，型号沿用并重新匹配
  r = await edit('第1行 50件');
  assert.deepEqual(r.intake.lines[0], { q: '6205-2RS', qty: 50, m: 'exact' });
  r = await edit('第5行 20件');
  assert.deepEqual(r.intake.lines[4], { q: '6205-ZZ', qty: 20, m: 'exact' }, '补上数量后由 bad_qty 变已匹配');
  r = await edit('第2行 数量改成30');
  assert.deepEqual(r.intake.lines[1], { q: '6205', qty: 30, m: 'ambiguous' }, '待确认的行改数量仍待确认');
  r = await edit('第2行 6205');
  assert.deepEqual(r.intake.lines[1], { q: '6205', qty: 200, m: 'ambiguous' }, '单独一个数字是型号');
  // 3) 删第N行：删掉，后面的行号顺延
  r = await edit('删第3行');
  assert.deepEqual(
    r.intake.lines.map((line) => line.q),
    ['6205-2RS', '6205', 'M8×30', '6205-ZZ'],
  );
  assert.match(r.reply.text, /^从您发来的询价单里认出 4 行/);
  assert.match(r.reply.text, /\n3\. M8×30，5件，已匹配\n/);
  assert.doesNotMatch(r.reply.text, /ZZ9999/);
  for (const text of ['删第3行。', '删 第3行', '删第3行吧', '删除第3行', '删掉第3行', '删第３行'])
    assert.equal((await edit(text)).intake.lines.length, 4, text);
  // N 超出：清单与状态都不变，加一句提示。
  for (const text of ['第9行 6205-ZZ', '第0行 6205-ZZ', '第6行 20件', '删第9行', '删第6行', '第999999行 6205-ZZ']) {
    const session = withIntake();
    const before = structuredClone(session.packState);
    const reply = preModel(ctxOf(session, text), sources)!;
    assert.equal(reply.statePatch, undefined, text);
    assert.deepEqual(session.packState, before);
    assert.ok(reply.text.startsWith(`${INTAKE_RANGE_NOTE}\n从您发来的询价单里认出 5 行`), text);
    await registered(reply);
  }
  // 改完仍不合格：照常渲染，原因标在该行上。
  r = await edit('第1行 ZZ0000');
  assert.deepEqual(r.intake.lines[0], { q: 'ZZ0000', qty: 100, m: 'none' });
  assert.match(r.reply.text, /1\. ZZ0000，100件，库里没找到，顾问会核对/);
  for (const text of ['第1行 0件', '第1行 1.5件', '第1行 6205-2RS 1000001', '第1行 -3件']) {
    r = await edit(text);
    assert.equal(r.intake.lines[0]!.m, 'bad_qty', text);
    assert.equal(r.intake.lines[0]!.qty, null);
    assert.match(r.reply.text, /1\. 6205-2RS，数量没认出，待确认：数量没认出，请补数量/);
  }
  r = await edit('第1行 6205-2RS 100', withIntake([{ q: '6205-2RS', qty: null, m: 'bad_qty' }]));
  assert.deepEqual(r.intake.lines[0], { q: '6205-2RS', qty: 100, m: 'exact' });
  // 读不出来：这一行没改，提示该怎么回。
  for (const text of ['第3行', '第3行的价格是多少', '第3行 改成', '第3行 //', '删第3行 并且改一下']) {
    const session = withIntake();
    const reply = preModel(ctxOf(session, text), sources)!;
    assert.equal(reply.statePatch, undefined, text);
    assert.ok(reply.text.startsWith(`${intakeUnreadNote(3)}\n从您发来的询价单里认出 5 行`), text);
    await registered(reply);
  }
  // 删光：清单作废，回固定句，不留空清单待确认。
  const single = withIntake([{ q: '6205-2RS', qty: 100, m: 'exact' }]);
  const cleared = preModel(ctxOf(single, '删第1行'), sources)!;
  assert.equal(cleared.text, INTAKE_FIXED.cleared);
  assert.equal(cleared.fixedId, 'industrial.intake.cleared');
  await registered(cleared);
  apply(single, cleared);
  assert.equal(pendingIntake(single), undefined);
  assert.equal(readState(single).rfqIntake!.status, 'superseded');
  assert.equal(confirmsIntake(single, '确认'), false);
  // 长清单：30 行里改第 30 行，删第 1 行后 29 行。
  const long = Array.from({ length: 30 }, (_, i) => ({ q: '6205-2RS', qty: i + 1, m: 'exact' as const }));
  r = await edit('第30行 6205-ZZ 7', withIntake(long));
  assert.deepEqual(r.intake.lines[29], { q: '6205-ZZ', qty: 7, m: 'exact' });
  assert.equal((await edit('删第1行', withIntake(long))).intake.lines.length, 29);
});

await test('确认判定：明确说法清单待确认就算；泛化肯定要上一条 AI 消息就是这份清单；否定与问号不算', () => {
  const explicit = ['确认', '确认无误', '按这个报', '就这些', '确认。', '确认！', '确认~', ' 确认 ', '就这些.', '确认无误！'];
  const general = ['对的', '是的', '没问题', '可以', '对的。', '可以！'];
  const negated = [
    '不确认',
    '确认吗',
    '确认吗？',
    '确认？',
    '先别确认',
    '确认一下',
    '确认下单',
    '我确认',
    '确认 6205-2RS 100个',
    '不可以',
    '没问题吗',
    '可以吗？',
    '不对',
    '不是的',
    '没问题，但是第2行不对',
    '好的',
  ];
  const shown = withIntake();
  for (const text of explicit) assert.equal(confirmsIntake(withIntake(LINES, { shown: false }), text), true, text);
  for (const text of [...general, ...negated, ...explicit.map((t) => `不${t}`)]) {
    if (!explicit.includes(text)) assert.equal(confirmsIntake(withIntake(LINES, { shown: false }), text), false, `没有清单消息：${text}`);
  }
  for (const text of general) assert.equal(confirmsIntake(shown, text), true, `上一条是这份清单：${text}`);
  for (const text of negated) assert.equal(confirmsIntake(shown, text), false, text);
  // 上一条 AI 消息不是清单：隔了一轮模型回复。
  const chat = withIntake();
  chat.messages.push(
    { role: 'customer', content: '6205-2RS 有货吗', at: now },
    { role: 'agent', content: '有现货，100 件起订。', at: now },
  );
  for (const text of general) assert.equal(confirmsIntake(chat, text), false, text);
  assert.equal(confirmsIntake(chat, '确认'), true, '明确说法不受影响');
  // 清单之后来了新附件，还没回复：客户看到的不是现在这份。
  const waiting = withIntake();
  waiting.messages.push({ role: 'customer', content: '[图片]', at: now, attachment: attachmentRef(99) });
  assert.equal(confirmsIntake(waiting, '对的'), false);
  // 清单行数变了（合并或改行后）而最后一条 AI 消息还是旧清单：不算。
  const stale = withIntake();
  writeState(stale, { rfqIntake: { ...readState(stale).rfqIntake!, lines: LINES.slice(0, 3) } });
  assert.equal(confirmsIntake(stale, '可以'), false);
  // 改行之后发出的新清单是上一条 AI 消息：算。
  const edited = withIntake();
  const reply = preModel(ctxOf(edited, '第2行 6205-ZZ'), sources)!;
  apply(edited, reply);
  edited.messages.push({ role: 'customer', content: '第2行 6205-ZZ', at: now }, { role: 'agent', content: reply.text, at: now });
  assert.equal(confirmsIntake(edited, '没问题'), true);
  // 改行没生效时带提示的清单同样是清单。
  const noted = withIntake();
  const note = preModel(ctxOf(noted, '第9行 6205-ZZ'), sources)!;
  noted.messages.push({ role: 'agent', content: note.text, at: now });
  assert.equal(confirmsIntake(noted, '可以'), true);
  // 状态不是待确认：一概不算。
  for (const status of ['confirmed', 'superseded'] as const)
    for (const text of [...explicit, ...general])
      assert.equal(confirmsIntake(withIntake(LINES, { status }), text), false, `${status} ${text}`);
  assert.equal(confirmsIntake(fresh(), '确认'), false);
  // 清单在 AI 消息之后才建（时间倒挂）：不算。
  const late = withIntake(LINES, { at: now + 1000 });
  late.messages[late.messages.length - 1]!.at = now;
  assert.equal(confirmsIntake(late, '可以'), false);
});

const registry = createToolRegistry(runtime.tools, { beforeTool: runtime.beforeTool });
const toolCtx = (session: Session, text: string): TurnToolContext => ({
  session,
  hints: {},
  text,
  args: {},
  notes: {},
  handoffDeclined: false,
});
/** 与引擎一样：预取经注册表（带 beforeTool）执行。 */
function realPrefetch(session: Session, text: string) {
  const calls: { name: string; args: Record<string, unknown>; result: string }[] = [];
  return {
    calls,
    run: () =>
      prefetch(
        {
          ...ctxOf(session, text),
          callTool: async (name, args) => {
            const result = await registry.execute(name, args, toolCtx(session, text));
            calls.push({ name, args, result });
            return { name, args, result };
          },
        },
        sources,
      ),
  };
}

await test('确认那一轮：已匹配的行按 q 一次试算并整份替换 rfqDraft，其余行通知顾问，清单标 confirmed', async () => {
  const session = withIntake();
  writeState(session, { rfqDraft: { at: now - 5000, lines: [{ match: 'exact', code: 'synthetic-5', version: 1, qty: 9 }] } });
  const { calls, run } = realPrefetch(session, '确认');
  const result = (await run())!;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'quote_items');
  assert.deepEqual(calls[0]!.args, {
    items: [
      { query: '6205-2RS', qty: 100 },
      { query: 'M8×30', qty: 5 },
    ],
  });
  const quote = JSON.parse(calls[0]!.result) as { lines: { code: string; amount: number }[]; total: number; unmatched: number };
  assert.equal(quote.unmatched, 0);
  assert.equal(quote.lines.length, 2);
  assert.equal(Math.round(quote.total * 100), 987654 * 105, '合计来自产品库单价，不含客户文件里的任何价格');
  assert.deepEqual(
    readState(session).rfqDraft!.lines.map((line) => ('code' in line ? line.code : line.match)),
    ['synthetic-0', 'synthetic-4'],
    '整份替换，不受第 21 步整份重说的限制',
  );
  assert.deepEqual(result.effects!.notify, { reason: 'intake_unmatched', intakeId, lines: [2, 3, 5] });
  assert.equal((result.effects!.statePatch as { rfqIntake: Intake }).rfqIntake.status, 'confirmed');
  assert.equal(pendingIntake(session)!.status, 'pending', '预取本身不改清单；标记随回复同一次保存');
  apply(session, result.effects);
  assert.equal(pendingIntake(session), undefined);
  // 模型据结果报价：试算结果之外，contextNote 说明哪几行不报价（在状态标 confirmed 之前计算）。
  const before = withIntake();
  const notes = runtime.contextNote(ctxOf(before, '确认')).join('\n');
  assert.match(notes, /客户刚确认了识别清单：已匹配的行已按清单试算/);
  assert.match(notes, /清单第2、3、5行不报价，已通知顾问核对/);
  assert.doesNotMatch(notes, /还没确认/);
  assert.doesNotMatch(notes, /询价摘要/);
  // 其余行永不进试算。
  assert.equal(JSON.stringify(readState(session).rfqDraft).includes('ZZ9999'), false);
  // 再说「确认」：不算确认，不再试算也不再通知。
  const again = realPrefetch(session, '确认');
  assert.equal(await again.run(), null);
  assert.equal(again.calls.length, 0);
  assert.doesNotMatch(runtime.contextNote(ctxOf(session, '确认')).join('\n'), /不报价|还没确认/);
});

await test('确认那一轮：没有可算的行只通知；全部已匹配不通知；试算时不再精确的行算未匹配', async () => {
  const none = withIntake([
    { q: 'ZZ9999', qty: 10, m: 'none' },
    { q: '6205', qty: 5, m: 'ambiguous' },
  ]);
  const { calls, run } = realPrefetch(none, '就这些');
  const result = (await run())!;
  assert.deepEqual(result.calls, []);
  assert.equal(calls.length, 0, '没有可算的行：不预取');
  assert.deepEqual(result.effects!.notify, { reason: 'intake_unmatched', intakeId, lines: [1, 2] });
  assert.equal((result.effects!.statePatch as { rfqIntake: Intake }).rfqIntake.status, 'confirmed');
  assert.equal(readState(none).rfqDraft, undefined);
  const notes = runtime.contextNote(ctxOf(withIntake([{ q: 'ZZ9999', qty: 10, m: 'none' }]), '确认')).join('\n');
  assert.match(notes, /没有可试算的行：说明顾问会核对，不要报价/);
  const all = withIntake([
    { q: '6205-2RS', qty: 1, m: 'exact' },
    { q: '6205-ZZ', qty: 2, m: 'exact' },
  ]);
  const full = (await realPrefetch(all, '按这个报').run())!;
  assert.equal(full.calls.length, 1);
  assert.equal(full.effects!.notify, undefined, '没有未匹配的行就不通知');
  assert.equal((full.effects!.statePatch as { rfqIntake: Intake }).rfqIntake.status, 'confirmed');
  // 目录在清单发出之后变了：exact 的行此刻不再精确，不报价，通知顾问。
  const drift = intakeQuoteLines(
    { id: intakeId, at: now, status: 'pending', lines: [{ q: 'GONE-1', qty: 1, m: 'exact' }, ...LINES.slice(0, 1)] },
    catalog,
  );
  assert.deepEqual(drift, { items: [{ query: '6205-2RS', qty: 100 }], unmatched: [1] });
  // 泛化肯定在清单是上一条 AI 消息时同样走确认那一轮。
  const general = withIntake([{ q: '6205-2RS', qty: 3, m: 'exact' }]);
  assert.equal((await realPrefetch(general, '对的').run())!.calls.length, 1);
  const chat = withIntake([{ q: '6205-2RS', qty: 3, m: 'exact' }], { shown: false });
  assert.equal(await realPrefetch(chat, '对的').run(), null, '上一条不是清单：不算确认');
});

await test('beforeTool：确认那一轮、清单待确认的其他轮次、没有清单', async () => {
  const run = async (session: Session, text: string, name: string, args: Record<string, unknown>) =>
    JSON.parse(await registry.execute(name, args, toolCtx(session, text))) as { error?: string; lines?: unknown[] };
  const confirmed = [
    { query: '6205-2RS', qty: 100 },
    { query: 'M8×30', qty: 5 },
  ];
  // 1) 确认那一轮：只放行入参恰好等于确认那几行的 quote_items。
  const s1 = withIntake();
  assert.equal((await run(s1, '确认', 'quote_items', { items: confirmed })).error, undefined);
  for (const items of [
    [confirmed[0]],
    [confirmed[1], confirmed[0]],
    [...confirmed, { query: 'HS-100', qty: 1 }],
    [{ query: '6205-2RS', qty: 101 }, confirmed[1]],
    [{ query: '6205-ZZ', qty: 100 }, confirmed[1]],
  ])
    assert.match((await run(s1, '确认', 'quote_items', { items })).error!, /客户刚确认了识别清单/);
  assert.match((await run(s1, '确认', 'quote_items', { items: confirmed, extra: 1 })).error!, /客户刚确认了识别清单/);
  assert.match((await run(s1, '确认', 'create_quote_sheet', { items: [{ code: 'synthetic-0', qty: 100 }] })).error!, /不起草正式报价单/);
  assert.match((await run(s1, '确认', 'find_parts', { query: 'HS-100' })).error!, /客户刚确认了识别清单/);
  assert.equal(s1.orderIds.length, 0);
  // 没有可算的行：任何 quote_items 都不放行。
  const s2 = withIntake([{ q: 'ZZ9999', qty: 10, m: 'none' }]);
  assert.match((await run(s2, '确认', 'quote_items', { items: [{ query: '6205-2RS', qty: 1 }] })).error!, /客户刚确认了识别清单/);
  // 2) 清单待确认的其他轮次：quote_items 只放行客户本句写出的精确型号（和数量）；create_quote_sheet 一律拒绝。
  const s3 = withIntake();
  const pendingText = '识别清单还没确认：请客户回复确认或指出要改的行';
  assert.equal((await run(s3, '6205-2RS 100个多少钱', 'quote_items', { items: [{ query: '6205-2RS', qty: 100 }] })).error, undefined);
  assert.equal(
    (
      await run(s3, '6205-2RS 100个 M8×30 7个', 'quote_items', {
        items: [
          { query: 'M8x30', qty: 7 },
          { query: '6205-2RS', qty: 100 },
        ],
      })
    ).error,
    undefined,
    '写法不同但是同一型号',
  );
  for (const [text, items] of [
    ['6205-2RS 100个多少钱', [{ query: 'M8×30', qty: 5 }]],
    [
      '6205-2RS 100个多少钱',
      [
        { query: '6205-2RS', qty: 100 },
        { query: 'M8×30', qty: 5 },
      ],
    ],
    ['6205-2RS 多少钱', [{ query: '6205-2RS', qty: 100 }]],
    ['6205-2RS 100个多少钱', [{ query: '6205-2RS', qty: 200 }]],
    ['这几个多少钱', [{ query: '6205-2RS', qty: 100 }]],
    ['6205 多少钱', [{ query: '6205', qty: 200 }]],
    ['确认下单', [{ query: '6205-2RS', qty: 100 }]],
    ['6205-2RS 100个多少钱', 'x'],
  ] as const)
    assert.equal((await run(s3, text, 'quote_items', { items })).error, pendingText, `${text} ${JSON.stringify(items)}`);
  assert.equal((await run(s3, '出正式报价单', 'create_quote_sheet', { items: [{ code: 'synthetic-0', qty: 100 }] })).error, pendingText);
  assert.equal((await run(s3, '6205-2RS 100个', 'create_quote_sheet', { items: [{ code: 'synthetic-0', qty: 100 }] })).error, pendingText);
  assert.equal((await run(s3, '6205-2RS 现货吗', 'find_parts', { query: '6205-2RS' })).error, undefined, '查询不受清单限制');
  assert.equal(s3.orderIds.length, 0);
  // 模块导出的 beforeTool 与工具内部的复核共用同一套规则。
  const direct = (session: Session, text: string, name: string, args: unknown) =>
    beforeTool(name, args, toolCtx(session, text), sources) as { args?: unknown; reject?: string };
  assert.equal(direct(s3, '出正式报价单', 'create_quote_sheet', { items: [] }).reject, pendingText);
  // 3) 没有清单、或清单已确认 / 已取代：10 原有行为一个字不变。
  for (const session of [fresh(), withIntake(LINES, { status: 'confirmed' }), withIntake(LINES, { status: 'superseded' })]) {
    assert.deepEqual(direct(session, '出正式报价单', 'create_quote_sheet', { items: [] }), { args: { items: [] } });
    assert.deepEqual(direct(session, '这几个多少钱', 'quote_items', { items: [{ query: 'M8×30', qty: 5 }] }), {
      args: { items: [{ query: 'M8×30', qty: 5 }] },
    });
    assert.deepEqual(direct(session, '确认', 'find_parts', { query: 'HS-100' }), { args: { query: 'HS-100' } });
  }
  // 多候选的老规则仍在：6205 未决时不能替客户选型号。
  assert.match(direct(fresh(), '6205 100个', 'create_quote_sheet', { items: [] }).reject!, /多个候选/);
});

await test('被文字询价取代：客户自己打了带精确型号和数量的新询价，清单随这一轮回复标 superseded', async () => {
  // 新询价：按 10 的路试算，清单标 superseded，不发 intake_unmatched。
  const a = withIntake();
  const quoteA = realPrefetch(a, '6205-ZZ 30个');
  const result = (await quoteA.run())!;
  assert.deepEqual(
    quoteA.calls.map((call) => call.args),
    [{ items: [{ query: '6205-ZZ', qty: 30 }] }],
  );
  assert.equal((result.effects!.statePatch as { rfqIntake: Intake }).rfqIntake.status, 'superseded');
  assert.equal(result.effects!.notify, undefined);
  apply(a, result.effects);
  assert.equal(pendingIntake(a), undefined);
  assert.equal(confirmsIntake(a, '确认'), false, '被取代的清单不能再确认');
  assert.equal(await realPrefetch(a, '确认').run(), null);
  // 进行中的询价没被整份重说：第 21 步不替算，但清单照样被取代（模型可自己试算这句里写的型号）。
  const b = withIntake();
  writeState(b, { rfqDraft: { at: now - 5000, lines: [{ match: 'exact', code: 'synthetic-5', version: 1, qty: 9 }] } });
  const restate = realPrefetch(b, '6205-ZZ 30个');
  const resultB = (await restate.run())!;
  assert.equal(restate.calls.length, 0);
  assert.equal((resultB.effects!.statePatch as { rfqIntake: Intake }).rfqIntake.status, 'superseded');
  // 只问型号（无数量）、只有未决型号：不是新询价，清单不动。
  for (const text of ['6205-ZZ 现货吗', '6205 有货吗', '你们有轴承吗']) {
    const session = withIntake();
    const probe = realPrefetch(session, text);
    const out = await probe.run();
    assert.equal(out?.effects, undefined, text);
    assert.equal(pendingIntake(session)!.status, 'pending');
  }
  // 改行不算新询价：preModel 先接走，不会到预取。
  const c = withIntake();
  const edit = preModel(ctxOf(c, '第2行 6205-ZZ 150件'), sources)!;
  assert.equal(edit.fixedId, 'industrial.intake.list');
  // 清单待确认时，10 的过期报价续算不替模型发起（那会被工具闸拒绝）。
  const expired = withIntake(LINES.slice(0, 1), { at: now - 10 * 86400000 });
  const old = {
    v: 2,
    id: 'ord_' + 'e'.repeat(24),
    sessionId: expired.id,
    status: 'pending_payment',
    createdAt: now - 10 * 86400000,
    lines: [{ code: 'synthetic-0', title: '6205-2RS', qty: 3 }],
    totalFen: 1000,
    approval: { state: 'approved', requestedAt: now - 10 * 86400000 - 1, decidedAt: now - 10 * 86400000, validDays: 7, hash: 'synthetic' },
  } as unknown as LineOrder;
  orderStore.set(old.id, old);
  expired.orderIds = [old.id];
  writeState(expired, { rfqIntake: { ...pendingIntake(expired)!, at: now } });
  assert.equal(latestQuoteCandidate(expired, now)?.kind, 'quote');
  assert.equal(await realPrefetch(expired, '重新算一下').run(), null);
  const plain = fresh();
  const oldPlain = { ...old, id: 'ord_' + '1'.repeat(24), sessionId: plain.id } as LineOrder;
  orderStore.set(oldPlain.id, oldPlain);
  plain.orderIds = [oldPlain.id];
  assert.equal((await realPrefetch(plain, '重新算一下').run())!.calls[0]!.name, 'quote_items', '没有清单：过期续算照旧');
});

await test('候选比较：contextNote 按时间取清单或候选；报价候选、整份重说、过期续算都不看清单', async () => {
  const notes = (session: Session, text = '你好') => runtime.contextNote(ctxOf(session, text)).join('\n');
  const draft = (session: Session, at: number) =>
    writeState(session, { rfqDraft: { at, lines: [{ match: 'exact', code: 'synthetic-0', version: 1, qty: 3 }] } });
  // 清单比试算新：只带清单摘要，不带「本次试算」说明和询价摘要。
  const newer = withIntake();
  draft(newer, now - 1000);
  assert.equal(intakeNewer(newer, now), true);
  let text = notes(newer);
  assert.match(text, /识别清单摘要：/);
  assert.match(text, /识别清单还没确认，只能请客户确认或改行/);
  assert.doesNotMatch(text, /本次试算|询价摘要/);
  assert.deepEqual(contextNote(ctxOf(newer, '你好')), []);
  // 试算比清单新：照旧带候选说明和询价摘要，清单摘要也在。
  const older = withIntake(LINES, { at: now - 1000 });
  draft(older, now);
  assert.equal(intakeNewer(older, now), false);
  text = notes(older);
  assert.match(text, /本次试算/);
  assert.match(text, /询价摘要：/);
  assert.match(text, /识别清单摘要：/);
  // 报价单同理。
  const quote = withIntake();
  const value = {
    v: 2,
    id: 'ord_' + 'd'.repeat(24),
    sessionId: quote.id,
    status: 'pending_payment',
    createdAt: now - 100,
    lines: [],
    totalFen: 1000,
    approval: { state: 'approved', requestedAt: now - 101, decidedAt: now - 100, validDays: 7, hash: 'synthetic' },
  } as unknown as LineOrder;
  orderStore.set(value.id, value);
  quote.orderIds = [value.id];
  assert.doesNotMatch(notes(quote), /已批准且有效/);
  const confirmedList = withIntake(LINES, { at: now - 1000, status: 'confirmed' });
  const ofConfirmed = { ...value, id: 'ord_' + '2'.repeat(24), sessionId: confirmedList.id } as LineOrder;
  orderStore.set(ofConfirmed.id, ofConfirmed);
  confirmedList.orderIds = [ofConfirmed.id];
  assert.match(notes(confirmedList), /已批准且有效/, '清单已确认：不再压过报价候选');
  // 没有清单：与 10 完全一致。
  const plain = fresh();
  const ofPlain = { ...value, id: 'ord_' + '3'.repeat(24), sessionId: plain.id } as LineOrder;
  orderStore.set(ofPlain.id, ofPlain);
  plain.orderIds = [ofPlain.id];
  assert.match(notes(plain), /已批准且有效/);
  assert.doesNotMatch(notes(plain), /识别清单/);
  // latestQuoteCandidate / expiredQuoteAwaitingConfirmation 的结果与有没有清单无关。
  const withList = withIntake();
  const ofList = { ...value, id: 'ord_' + '4'.repeat(24), sessionId: withList.id } as LineOrder;
  orderStore.set(ofList.id, ofList);
  withList.orderIds = [ofList.id];
  const kind = (session: Session) => {
    const candidate = latestQuoteCandidate(session, now);
    return candidate && { kind: candidate.kind, at: candidate.at, state: candidate.kind === 'quote' ? candidate.state : undefined };
  };
  assert.deepEqual(kind(withList), kind(plain));
  assert.equal(kind(withList)?.kind, 'quote');
  const later = now + 9 * 86400000;
  assert.equal(expiredQuoteAwaitingConfirmation(withList, later), expiredQuoteAwaitingConfirmation(plain, later));
  // 10 第 21 步的整份重说判断也不看清单：同样的草稿，有无待确认清单，预取都按草稿判。
  for (const withPending of [false, true]) {
    const session = withPending ? withIntake(LINES, { at: now - 5000 }) : fresh();
    draft(session, now - 1000);
    const probe = realPrefetch(session, '6205-ZZ 30个');
    await probe.run();
    assert.equal(probe.calls.length, 0, `草稿里是别的型号：不替算（清单${withPending ? '有' : '无'}）`);
    const same = withPending ? withIntake(LINES, { at: now - 5000 }) : fresh();
    draft(same, now - 1000);
    const restated = realPrefetch(same, '6205-2RS 30个');
    await restated.run();
    assert.equal(restated.calls.length, 1, `整份重说：替算（清单${withPending ? '有' : '无'}）`);
  }
});

await test('没有附件与清单的工业对话一行不变', async () => {
  const s = fresh();
  assert.deepEqual(
    runtime.contextNote(ctxOf(s, '你好')).filter((line) => /识别清单/.test(line)),
    [],
  );
  assert.equal(preModel(ctxOf(s, '6205-2RS 100个'), sources), null);
  assert.equal(preModel(ctxOf(s, '要非标'), sources)!.fixedId, 'industrial.nonstandard');
  assert.equal(preModel(ctxOf(s, '确认'), sources), null);
  assert.equal(preModel(ctxOf(s, '第1行 6205-ZZ'), sources), null);
  assert.equal(await realPrefetch(s, '确认').run(), null);
  const quote = realPrefetch(s, '6205-2RS 100个');
  const result = (await quote.run())!;
  assert.equal(result.effects, undefined);
  assert.deepEqual(
    quote.calls.map((call) => call.name),
    ['quote_items'],
  );
  assert.equal(confirmsIntake(s, '确认'), false);
  assert.equal(pendingIntake(s), undefined);
  assert.equal(readState(s).rfqIntake, undefined);
  // 10 的 contextNote 无清单时直接输出候选说明。
  assert.match(contextNote(ctxOf(s, '你好')).join(''), /本次试算/);
  assert.equal(FIXED.long, '询价超过30行，我请顾问继续跟您核对。');
});

Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`INDUSTRIAL INTAKE TURN PASS: ${count} assertion blocks`);
