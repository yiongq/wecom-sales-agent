// R8–R14：合成小夹具；主回复、词表、确定性分支、发布契约及离线脚本。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIndustrialRuntime } from './packs/industrial/runtime.js';
import { handoffVocab } from './packs/industrial/handoff-vocab.js';
import { handoffVocab as travelVocab } from './packs/travel/handoff-vocab.js';
import { defaultIndustrialPolicy } from './packs/industrial/policy.js';
import { industrialReplyGuard, trimRfq, TRIM_FALLBACK } from './packs/industrial/guards.js';
import { preModel, contextNote, inquiryLines, prefetch, FIXED } from './packs/industrial/turn.js';
import { latestQuoteCandidate } from './packs/industrial/quote-candidate.js';
import { NEXT } from './packs/industrial/reply-blocks.js';
import { writeState } from './packs/industrial/state.js';
import type { ReplyGuardContext, TurnContext, LineOrder, MoneyEntry } from './core/pack-api.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-replies-'));
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
const { packPipelines } = await import('./core/engine/pipelines.js');
const sources = config.packSources();
const runtime = createIndustrialRuntime(sources);
const parts = Array.from({ length: 15 }, (_, i) => ({
  id: `part-${i}`,
  partNo: `HS${1000 + i}`,
  name: '合成轴承',
  brand: '合成品牌',
  category: '轴承',
  specs: ['内径25mm', '定位面ZZQ300'],
  unit: '件',
  unitPrice: i === 1 ? 20 : 10,
  ...(i === 0 ? { aliases: ['HS-A'], tier2Qty: 10, tier2Price: 8 } : {}),
  moq: 1,
  stock: 100,
  leadDays: 7,
  substitutes: i === 0 ? ['HS1001'] : [],
}));
for (const file of ['sop.md', 'policy.json', 'brand.json', 'pack.json'])
  fs.copyFileSync(`data/packs/industrial/${file}`, path.join(dir, file));
fs.mkdirSync(path.join(dir, 'catalog'));
fs.writeFileSync(path.join(dir, 'catalog/part.json'), JSON.stringify(parts));
bindPack(runtime, runtime.defaultBrand);
const orderStore: Map<string, import('./core/order-view.js').AnyOrder> = rt.store.orders;
const realNow = Date.now;
let now = Date.parse('2026-10-26T04:00:00Z');
Date.now = () => now;
try {
  const session = store.getOrCreateSession('wecom:wmRfqReply', 'wecom');
  writeState(
    session,
    { rfqDraft: { at: now, lines: parts.map((part) => ({ code: part.id, version: 1, match: 'exact', qty: 2 })) } },
    parts,
  );
  const events: string[] = [];
  let policy = structuredClone(defaultIndustrialPolicy);
  const guarded = async (text: string, inputText = '', toolSources: ReplyGuardContext['toolSources'] = []) => {
    const ctx = {
      session,
      text,
      inputText,
      policy,
      toolSources,
      recordGuard: (id: string) => events.push(id),
    } as unknown as ReplyGuardContext;
    const result = await industrialReplyGuard(sources).run(ctx);
    return result?.action === 'pass' ? text : result && 'text' in result ? result.text : '';
  };
  for (const text of ['HS1000今天发货。', 'HS1000明天发。', 'HS1000保证交期。', 'HS1000，3天到。'])
    assert.match(await guarded(text), /确认为准/);
  assert.equal(await guarded('HS1000有现货。'), 'HS1000有现货。');
  assert.equal(
    await guarded('HS1000现货，7天发。', '', [
      { name: 'find_parts', args: {}, result: JSON.stringify({ parts: [{ partNo: 'HS1000', stock: '现货', leadDays: 7 }] }) },
    ]),
    'HS1000现货，7天发。',
  );
  const previousDraft = session.packState;
  session.packState = { partsInPlay: [{ partNo: 'HS1000', specs: [] }] };
  const partialFact = [
    { name: 'quote_items', args: {}, result: JSON.stringify({ lines: [{ partNo: 'HS1000', delivery: '现货 3 件，其余约 7 天' }] }) },
  ];
  assert.equal(await guarded('HS1000现货3件，其余约7天。', '', partialFact), 'HS1000现货3件，其余约7天。');
  assert.match(await guarded('HS1000全部现货。', '', partialFact), /确认为准/);
  assert.match(await guarded('HS1000现货99件，其余约7天。', '', partialFact), /确认为准/);
  session.packState = previousDraft;
  // 回复出口不允许上下文摘要或 JSON；正常中文括号、标点仍逐字保留。
  const normal = '型号请核对（含税13%），可以开专票。';
  assert.equal(await guarded(normal), normal);
  for (const leak of [
    '询价摘要：{"at":1,"lines":[]}',
    '过期报价行：[{"query":"HS1000","qty":2}]',
    '这里是内部对象 {"code":"part-0","qty":2}，请读取。',
    '[ { "key" : 2 } ]',
    '询价摘要：内容已经隐藏',
    '过期报价行：内容已经隐藏',
  ])
    assert.equal(await guarded(`${normal}\n${leak}\n请核对型号。`), `${normal}\n请核对型号。`, leak);
  assert.equal(await guarded('{"key":2}'), '');

  // 「约需」不能被当成确定交期；单型号、现货数和剩余交期仍分别校验。
  const remainingPart = { ...parts[0]!, id: 'remaining', partNo: '6207-2RS', stock: 18, leadDays: 9 };
  const remainingSources = { ...sources, currentCatalog: () => ({ ...sources.currentCatalog(), items: { part: [remainingPart] } }) };
  const remainingSession = store.getOrCreateSession('wecom:wmRemaining', 'wecom');
  writeState(remainingSession, { rfqDraft: { at: now, lines: [{ match: 'exact', code: remainingPart.id, version: 1, qty: 32 }] } }, [
    remainingPart,
  ]);
  for (const [text, expected] of [
    ['库存现货18件，其余14件约需9天到货，具体以顾问确认为准。', '库存现货18件，其余14件约需9天到货，具体以顾问确认为准。'],
    ['6207-2RS库存现货18件，其余约需9天到货。', '6207-2RS库存现货18件，其余约需9天到货。'],
    ['库存现货18件，其余14件约需5天到货，具体以顾问确认为准。', '库存现货18件，具体以顾问确认为准。'],
    ['库存现货30件，具体以顾问确认为准。', '具体以顾问确认为准。'],
    ['其余14件9天到货，具体以顾问确认为准。', '具体以顾问确认为准。'],
  ]) {
    const result = await industrialReplyGuard(remainingSources).run({
      session: remainingSession,
      text,
      inputText: '6207-2RS 32件',
      policy,
      toolSources: [],
      recordGuard: () => {},
    } as unknown as ReplyGuardContext);
    assert.equal(result?.action === 'pass' ? text : result && 'text' in result ? result.text : '', expected, text);
  }
  console.log('上下文回复 PASS: JSON/内部标签整行删除、中文括号保留、剩余交期正反例');
  for (const text of ['如果HS1000有现货就好了。', 'HS1000有货吗？', 'HS1000没有现货。', 'HS1000不能保证交期。'])
    assert.equal(await guarded(text), text);
  assert.equal(await guarded('HS1000可以替代HS1001。'), 'HS1000可以替代HS1001。');
  assert.match(await guarded('HS1000可以替代HS1002。'), /能否替代请顾问确认/);
  assert.equal(await guarded('如果HS1000能互换呢？'), '如果HS1000能互换呢？');
  policy.taxIncluded = false;
  assert.match(await guarded('报价含税。'), /报价不含税/);
  assert.equal(await guarded('报价不含税。'), '报价不含税。');
  policy.invoice = ['增值税普通发票'];
  assert.match(await guarded('能开专票。'), /增值税普通发票/);
  assert.equal(await guarded('可以开专票吗？'), '可以开专票吗？');
  assert.equal(await guarded('不能开专票。'), '不能开专票。');
  assert.match(await guarded('税率99%。'), /税率13%/);
  assert.match(await guarded('HS1000库存9999件。'), /确认为准/);
  for (const text of ['全网最低。', '保证不涨价。', '还能再便宜。', 'ZZ9999可以供货。']) assert.equal(await guarded(text), '');
  assert.equal(await guarded('ZZ9999需要核对。', '请问ZZ9999'), 'ZZ9999需要核对。');
  for (const spec of ['25mm', '0.8MPa', '380V', 'DC24V', '5.5kW', 'IP65', 'Q235', 'A2-70', '8.8级', 'G1/4', 'R1/2', 'ZZQ300'])
    assert.equal(await guarded(`规格${spec}。`), `规格${spec}。`);
  assert.ok(events.length >= 10);
  const models = parts.map((part) => part.partNo);
  const short = trimRfq(parts.map((part) => `${part.partNo} 2件`).join('\r\n'), models);
  assert.equal(short.split('\n').length, 11);
  assert.match(short, /另外 5 行已算好/);
  assert.equal((short.match(/HS\d+/g) ?? []).length, 10);
  const longLines = parts.map((part) => `${part.partNo} ${'说明'.repeat(45)}。还有一句说明。`).join('\n');
  const long = trimRfq(longLines, models);
  assert.ok([...long.replace(/\s/gu, '')].length <= 600);
  const left = (long.match(/HS\d+/g) ?? []).length;
  assert.match(long, new RegExp(`另外 ${15 - left} 行已算好`));
  const partial = trimRfq(`HS1000 短句。${'长'.repeat(700)}。`, models);
  assert.equal(partial, 'HS1000 短句。');
  for (const text of [
    'https://shop.example.test/' + 'a'.repeat(700),
    Array.from({ length: 13 }, (_, i) => `https://shop.example.test/${i}`).join('\n'),
  ]) {
    assert.equal(trimRfq(text, []), TRIM_FALLBACK);
    assert.equal(trimRfq(text, [], true), '');
  }
  assert.ok([...trimRfq('长'.repeat(800), []).replace(/\s/gu, '')].length <= 600);
  assert.equal(trimRfq(longLines, models, true).includes('另外'), false);
  console.log('工业护栏：库存/交期、替代、税票、价格承诺、型号及12类规格反例、裁剪10+5/二次裁剪/部分保留/保护句终止通过');

  assert.equal(Object.keys(handoffVocab).length, 104);
  const table = fs
    .readFileSync('docs/architecture/10-industrial-rfq-pack/plan.md', 'utf8')
    .split('\n')
    .filter((line) => /^\| `\w+`\s+\| (通用照搬|工业改写|旅游专有置为不匹配)/.test(line));
  assert.equal(table.length, 104);
  for (const line of table) {
    const key = /`(\w+)`/.exec(line)![1] as keyof typeof handoffVocab;
    if (!line.includes('通用照搬')) continue;
    const actual = handoffVocab[key],
      expected = travelVocab[key];
    assert.deepEqual(actual, expected, `${key} 通用语义逐键一致`);
  }
  for (const [key, text] of [
    ['E_ALTITUDE_MARKER', '我们在拉萨，海拔4000米'],
    ['E_ALTITUDE_OVERLAP', '我们在高原一直吐，喘不上气'],
    ['E_PRETRIP', '出发前下周报名这个团'],
    ['SLOW_PACE', '行程节奏这么慢，老人喜欢慢游'],
  ] as const) {
    assert.ok(new RegExp(travelVocab[key].source, travelVocab[key].flags).test(text));
    assert.equal(handoffVocab[key].test(text), false);
  }
  const examples = {
    E_NEAR: '我刚才手割伤了，现在已经不疼了',
    E_PRICE: '你们轴承价格贵到吐血',
    E_POLICY: '我受伤了能退款吗',
    E_HEARSAY: '同事说我手割伤了',
    E_ONGOING: '我现在高烧不退',
    E_VEHICLE_STUCK: '车开不动，走不了',
    E_TRAPPED_AT: '在电梯里',
    E_ELSEWHERE: '那边着火了',
    E_HELP: '我现在喘不上气，怎么办',
    E_ASKING: '6205-2RS要多少件',
    E_ARRANGE: '帮我看看订单能不能改',
    COMPANION_PHRASE: '跟我一起来的同事现在手割伤了',
    PARTY_MENTION: '我们现在喘不上气',
    OTHER_MENTION: '同事现在发高烧了',
    US: '你们客服太差了',
    OWNED_KIND: '报价',
    OTHERS: '别人的报价太离谱了',
    OTHER_AGENCY: '别家公司报价太离谱了',
    INSULT_TARGET_AFTER: '客服',
  };
  for (const [key, text] of Object.entries(examples)) {
    const regex = handoffVocab[key as keyof typeof examples];
    assert.ok(new RegExp(regex.source, regex.flags).test(text), key);
  }
  assert.ok(handoffVocab.EMERGENCY_RULES.every((rule) => ['injury', 'medical'].includes(rule.kind)));
  for (const text of ['我现在手割伤了，一直流血', '我现在喘不上气'])
    assert.ok(handoffVocab.EMERGENCY_RULES.some((rule) => new RegExp(rule.re.source, rule.re.flags).test(text)));
  const { createHandoffTriggers } = await import('./handoff/trigger-rules.js');
  const triggers = createHandoffTriggers(handoffVocab);
  assert.equal(triggers.emergencyOf('我有高反了'), null);
  assert.equal(triggers.emergencyOf('我想改行程'), null);
  assert.ok(triggers.emergencyOf('我现在喘不上气'));
  assert.equal(triggers.emergencyOf('我受伤了能退款吗'), null);
  assert.equal(triggers.negativeLevel('别人的报价太离谱了'), 0);
  assert.ok(triggers.negativeLevel('你们客服太差了') > 0);
  // 公共消费者的签名由现有入口核对，避免只测孤立正则。
  assert.ok(runtime.engineHooks.isComplaint('我要投诉'));
  assert.equal(runtime.engineHooks.isComplaint('我不是来投诉的'), false);
  assert.ok(runtime.engineHooks.isHandoffIntent('人工'));
  // 16 复核：否定说法不转人工；同一条消息里另一小句真要人工仍然转
  for (const text of [
    '不用转人工',
    '不要人工',
    '不需要转人工，你直接报',
    '别转人工',
    '先别转人工客服',
    '不想找真人',
    '无需人工顾问',
    '不接受转人工',
    '不要退款',
  ])
    assert.equal(runtime.engineHooks.isHandoffIntent(text), false, text);
  for (const text of ['转人工', '我要转人工', '要人工', '人工客服', '不用报价了，转人工', '不要机器人，我要人工', '我要退款'])
    assert.equal(runtime.engineHooks.isHandoffIntent(text), true, text);

  console.log('工业词表：104键（80通用、4不匹配、20改写）逐键与正反例通过');

  const context = (text: string): TurnContext => ({
    session,
    text,
    policy,
    callTool: async () => {
      throw new Error('确定性回复不能调用工具');
    },
  });
  for (const [text, key] of [
    ['非标', 'nonstandard'],
    ['来图加工', 'nonstandard'],
    ['月结', 'credit'],
    ['要样品', 'sample'],
    [Array.from({ length: 31 }, (_, i) => `HS${1000 + i} 2件`).join('\n'), 'long'],
  ] as const) {
    const result = preModel(context(text), sources)!;
    assert.equal(result.fixedId, `industrial.${key}`);
    assert.ok(result.handoff);
    assert.ok(runtime.fixedReplies!.find((fixed) => fixed.id === result.fixedId));
  }
  const twenty = Array.from({ length: 20 }, (_, i) => `HS${1000 + i} 2件`).join('\n');
  assert.equal(inquiryLines(twenty).length, 20);
  assert.equal(preModel(context(twenty), sources), null);
  assert.equal(preModel(context(twenty), sources), null);
  const order = (id: string, event: number, createdAt = event): LineOrder =>
    ({
      v: 2,
      id,
      sessionId: session.id,
      status: 'pending_payment',
      createdAt,
      lines: [],
      totalFen: 1000,
      approval: { state: 'approved', requestedAt: event - 1, decidedAt: event, validDays: 7, hash: 'synthetic' },
    }) as unknown as LineOrder;
  const orders = [order('ord_' + 'a'.repeat(24), now - 10), order('ord_' + 'b'.repeat(24), now - 10)];
  for (const value of orders) orderStore.set(value.id, value);
  session.orderIds = orders.map((value) => value.id);
  session.packState = {};
  const confirm = () => preModel(context('确认下单'), sources);
  const confirmedOrder = () => {
    const notify = confirm()?.notify;
    assert.equal(notify?.reason, 'quote_accepted');
    assert.ok(notify?.reason === 'quote_accepted');
    return notify.orderId;
  };
  assert.equal(confirmedOrder(), orders[1]!.id);
  for (const text of ['还没确认下单', '不要确认下单', '可以下单吗？', '是否就按这个', '先别确认报价'])
    assert.equal(preModel(context(text), sources), null);
  session.orderIds.reverse();
  assert.equal(confirmedOrder(), orders[1]!.id);
  orders[0]!.createdAt++;
  assert.equal(confirmedOrder(), orders[0]!.id);
  assert.match(contextNote(context('确认下单')).join(''), /已批准且有效/);
  writeState(session, { rfqDraft: { at: now - 10, lines: [] } });
  assert.equal(confirm(), null);
  assert.match(contextNote(context('确认下单')).join(''), /本次试算/);
  session.packState = {};
  orders[0]!.approval!.state = 'pending';
  orders[0]!.approval!.requestedAt = now;
  assert.equal(confirm()?.text, FIXED.pending);
  orders[0]!.approval!.state = 'approved';
  orders[0]!.approval!.decidedAt = now;
  now += 9 * 86400000;
  assert.equal(confirm(), null);
  assert.match(contextNote(context('确认下单')).join(''), /已过期/);
  for (const mutation of [
    (o: LineOrder) => {
      o.status = 'paid';
    },
    (o: LineOrder) => {
      o.status = 'cancelled';
    },
    (o: LineOrder) => {
      o.approval!.state = 'rejected';
    },
    (o: LineOrder) => {
      o.approval!.state = 'withdrawn';
    },
    (o: LineOrder) => {
      o.status = 'superseded';
    },
    (o: LineOrder) => {
      o.supersededBy = 'ord_' + 'c'.repeat(24);
    },
    (o: LineOrder) => {
      delete o.approval;
    },
  ]) {
    const value = order(orders[0]!.id, now);
    mutation(value);
    orderStore.set(value.id, value);
    session.orderIds = [value.id];
    assert.equal(latestQuoteCandidate(session, now), null);
    assert.equal(confirm(), null);
    assert.deepEqual(contextNote(context('确认下单')), []);
    assert.equal(session.packState?.confirmedQuoteAt, undefined);
  }
  console.log('工业确定性回复：非标/来图/月结/样品/31行、跨消息20+20、确认四分支/终态/同时间乱序排序通过');

  // 发现 4：型号精确时引擎先查或先试算；试算会整份替换 rfqDraft，进行中的询价只在整份重说时才替算。
  const fresh = store.getOrCreateSession('wecom:wmRfqPrefetch', 'wecom');
  const prefetched = async (text: string) => {
    const seen: { name: string; args: Record<string, unknown> }[] = [];
    const ctx: TurnContext = {
      session: fresh,
      text,
      policy,
      callTool: async (name, args) => {
        seen.push({ name, args });
        return { name, args, result: '{}' };
      },
    };
    const result = await prefetch(ctx, sources);
    assert.deepEqual(
      result?.calls.map((call) => call.name) ?? [],
      seen.map((call) => call.name),
    );
    return seen;
  };
  const quoted = (...items: [string, number][]) => [
    { name: 'quote_items', args: { items: items.map(([query, qty]) => ({ query, qty })) } },
  ];
  fresh.packState = {};
  assert.deepEqual(await prefetched('HS1000轴承100个'), quoted(['HS1000', 100]));
  assert.deepEqual(await prefetched('HS1000 100'), quoted(['HS1000', 100]));
  assert.deepEqual(await prefetched('HS1000 x100'), quoted(['HS1000', 100]));
  assert.deepEqual(await prefetched('型号就是HS1000，数量19件，请试算'), quoted(['HS1000', 19]));
  assert.deepEqual(await prefetched('HS1000 数量：100'), quoted(['HS1000', 100]));
  assert.deepEqual(await prefetched('HS1000，另外100个HS1001'), [
    { name: 'find_parts', args: { query: 'HS1000' } },
    { name: 'find_parts', args: { query: 'HS1001' } },
  ]);
  assert.deepEqual(await prefetched('HS1000 2件，HS1001 3件'), quoted(['HS1000', 2], ['HS1001', 3]));
  assert.deepEqual(await prefetched('HS1000 2件，HS1001有货吗'), [
    ...quoted(['HS1000', 2]),
    { name: 'find_parts', args: { query: 'HS1001' } },
  ]);
  for (const text of ['HS1000有现货吗', 'HS1000 不要100个', 'HS1000 2020年买过'])
    assert.deepEqual(await prefetched(text), [{ name: 'find_parts', args: { query: 'HS1000' } }], text);
  assert.deepEqual(await prefetched('HS1000 2件 HS1000 3件'), []);
  assert.deepEqual(await prefetched('HS10 2件'), [{ name: 'find_parts', args: { query: 'HS10' } }]);
  writeState(fresh, {
    rfqDraft: {
      at: now,
      lines: [
        { code: 'part-0', version: 1, match: 'exact', qty: 2 },
        { code: 'part-1', version: 1, match: 'exact', qty: 3 },
      ],
    },
  });
  assert.deepEqual(await prefetched('HS1000 改成5件'), []);
  assert.deepEqual(await prefetched('HS1000 5件，HS1001 6件'), quoted(['HS1000', 5], ['HS1001', 6]));
  assert.deepEqual(await prefetched('改成5件'), [], '多行询价不知道改哪一行');

  // 16 验收：客户只改数量、不重写型号时模型常常自己乘，金额被护栏删掉后客户拿不到价格；单行询价由引擎按新数量替算。
  writeState(fresh, { rfqDraft: { at: now, lines: [{ code: 'part-0', version: 1, match: 'exact', qty: 19 }] } });
  for (const [text, qty] of [
    ['20件。', 20],
    ['6件就够了。', 6],
    ['改成20件重新试算一下，满20件能到下一档。', 20],
    ['数量改成20件吧，你按20件重新试算一下。', 20],
    ['这样吧，凑个整数，按100件重新试算一下，价格能落在100件档位29.4元那档。', 100],
    ['加到５０件试算', 50],
  ] as const)
    assert.deepEqual(await prefetched(text), quoted(['HS1000', qty]), text);
  for (const text of [
    '19件。',
    '改成19件',
    '再加5件',
    '再加5件试算一下',
    '比20件便宜吗',
    '改成20件比19件便宜吧',
    '不要20件',
    '20件不够',
    '每箱按20件算',
    '改成10件和20件分别算一下',
    '改成10件或20件试算',
    '上次买过20件',
    '重新算第3个',
    '重新试算，交期5个工作日',
    '交期5个工作日',
    '按第3个算',
    '这批要得急',
    '改成0件',
    '您好',
  ])
    assert.deepEqual(await prefetched(text), [], text);
  // 已批准的报价单同样只有一行时，改数量也替算；数量没变不动。
  const quote: LineOrder = {
    v: 2,
    id: 'ord_requantify',
    sessionId: fresh.id,
    status: 'pending_payment',
    createdAt: now,
    totalFen: 100,
    lines: [{ kind: 'part', code: 'part-1', title: 'HS1001', qty: 3, unit: '件', unitPriceFen: 50, amountFen: 100 }],
    approval: { state: 'approved', requestedAt: now + 1, decidedAt: now + 1 },
  };
  orderStore.set(quote.id, quote);
  fresh.orderIds.push(quote.id);
  assert.deepEqual(await prefetched('改成8件'), quoted(['HS1001', 8]));
  assert.deepEqual(await prefetched('3件'), []);
  orderStore.delete(quote.id);
  fresh.orderIds.pop();
  // 目录里已经没有这个条目，或清单待确认：工具闸会拒绝，不替算。
  writeState(fresh, { rfqDraft: { at: now, lines: [{ code: 'gone', version: 1, match: 'exact', qty: 19 }] } });
  assert.deepEqual(await prefetched('改成20件'), []);
  writeState(fresh, {
    rfqDraft: { at: now, lines: [{ code: 'part-0', version: 1, match: 'exact', qty: 19 }] },
    rfqIntake: { id: 'int_0123456789ab', at: now, status: 'pending', lines: [{ q: 'HS1000', qty: 2, m: 'exact' }] },
  });
  assert.deepEqual(await prefetched('改成20件'), []);
  // 第 6 次 main 的 j-rejection-01：上一句只报了一个型号，这一句「先按6件来试算」，还没有试算单；模型写了占位符却没调工具。
  fresh.packState = {};
  const said = (...texts: string[]) => {
    fresh.messages = texts.flatMap((content, i) => [
      { role: 'customer' as const, content, at: now + i },
      { role: 'agent' as const, content: '好的。', at: now + i },
    ]);
  };
  said('HS1000 有一批采购要走正式报价。');
  assert.deepEqual(await prefetched('先按6件来试算。后面需要走正式报价流程。'), quoted(['HS1000', 6]), '18 上一句单个型号、这句只给数量');
  assert.deepEqual(await prefetched('6件就够了。'), quoted(['HS1000', 6]));
  fresh.messages.push({ role: 'customer', content: '先按6件来试算。', at: now + 9 });
  assert.deepEqual(await prefetched('先按6件来试算。'), quoted(['HS1000', 6]), '18 本句已记进会话时看再上一句');
  for (const previous of ['HS1000 和 HS1001 都要报价。', 'HS10 有货吗？', 'HS1000 要5件。', '您好'])
    for (const text of ['先按6件来试算。']) {
      said(previous);
      assert.deepEqual(await prefetched(text), [], `18 上一句「${previous}」不替算`);
    }
  said('HS1000 有一批采购要走正式报价。');
  assert.deepEqual(await prefetched('交期多久？'), [], '18 这句没给数量不替算');
  fresh.messages = [];
  console.log(
    '工业预取：品名夹在中间/无单位/×、多行、精确未给数量查、否定与年份不算数量、重复与未决走旧路、进行中询价只整份重算、单行改数量替算通过',
  );

  const { tenantImage, tenantRenderer, contractInputs, readImageSop } = await import('./config/brand.js');
  const { checkSopContract } = await import('./sop/contract.js');
  const { joinSop } = await import('./sop/sections.js');
  const image = tenantImage(runtime, readImageSop('industrial'), runtime.defaultBrand);
  const body = joinSop(image);
  assert.equal(runtime.sopSections.filter((s) => s.locked).length, 5);
  assert.equal(runtime.sopSections.filter((s) => !s.locked).length, 3);
  assert.doesNotMatch(body + runtime.templates.hardRequirements, /旅游|线路|高反|微信|企微|WeCom/);
  const violations = checkSopContract({
    sections: image,
    imageSections: image,
    rendered: tenantRenderer(runtime, runtime.defaultBrand)(body),
    toolNames: runtime.tools.map((tool) => tool.def.function.name),
    knownFields: runtime.knownFields.names,
    baselineEditableChars: null,
    hardRequirements: runtime.templates.hardRequirements,
    ...contractInputs(runtime, runtime.defaultBrand, defaultIndustrialPolicy),
  });
  assert.deepEqual(violations, []);
  assert.ok(runtime.policy!.lint!(policy, [{ key: 'tone', text: '报价含税。有效期90天。' }]).length > 0);
  assert.deepEqual(runtime.policy!.lint!(defaultIndustrialPolicy, image), []);
  const pipes = packPipelines(runtime);
  assert.ok(pipes.reply.steps.findIndex((s) => s.id === 'rfq_trim') > pipes.reply.steps.findIndex((s) => s.id === 'money_provenance'));
  console.log('工业发布配置：8节/3可改5锁定、无旅游/渠道名、契约/政策静态检查、管线顺序通过');

  // 实际工具 → registry 记账 → 工业包的主回复/跟进步骤；不手工补 subject。
  await import('./core/engine/sources.js');
  const { createToolRegistry } = await import('./core/tools/registry.js');
  const registry = createToolRegistry(runtime.tools);
  const moneySession = store.getOrCreateSession('wecom:wmBinding', 'wecom');
  const toolContext = { session: moneySession, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false };
  await registry.execute(
    'quote_items',
    {
      items: [
        { query: 'HS1000', qty: 3 },
        { query: 'HS1001', qty: 3 },
      ],
    },
    toolContext,
  );
  const ledger = structuredClone(moneySession.moneyLedger!);
  assert.deepEqual(ledger, [
    { fen: 1000, label: '试算单价', subject: 'HS1000' },
    { fen: 3000, label: '试算行金额', subject: 'HS1000' },
    { fen: 2000, label: '试算单价', subject: 'HS1001' },
    { fen: 6000, label: '试算行金额', subject: 'HS1001' },
    { fen: 9000, label: '试算合计' },
  ]);
  const approved: LineOrder = {
    v: 2,
    id: 'ord_binding',
    sessionId: moneySession.id,
    status: 'pending_payment',
    createdAt: now,
    totalFen: 9000,
    approval: { state: 'approved', requestedAt: now, decidedAt: now },
    lines: [
      { kind: 'part', code: 'part-0', title: 'HS1000', qty: 3, unit: '件', unitPriceFen: 1000, amountFen: 3000 },
      { kind: 'part', code: 'part-1', title: 'HS1001', qty: 3, unit: '件', unitPriceFen: 2000, amountFen: 6000 },
    ],
  };
  orderStore.set(approved.id, approved);
  for (const mode of ['reply', 'followup'] as const) {
    const step = runtime[mode === 'reply' ? 'replySteps' : 'followupSteps'].find((step) => step.id === 'money_provenance')!;
    const empty = mode === 'reply' ? '金额需要先试算，请告诉我型号和数量。' : '';
    const checkMoney = async (text: string, expected = text, entries: MoneyEntry[] = ledger, ordered = false) => {
      moneySession.moneyLedger = structuredClone(entries);
      moneySession.orderIds = ordered ? [approved.id] : [];
      const result = await step.run({
        session: moneySession,
        text,
        policy: defaultIndustrialPolicy,
        turn: { flags: { guardHit: null } },
        recordGuard: () => {},
      } as unknown as ReplyGuardContext);
      assert.ok(result && result.action !== 'abort');
      assert.equal(result.action === 'pass' ? text : result.text, expected, `${mode}: ${text}`);
    };
    await checkMoney('HS1000单价20元。HS1001单价10元。', empty);
    await checkMoney('HS1000单价10元。HS1001单价20元。');
    await checkMoney('HS1000单价10元，HS1001单价10元。请核对。', '请核对。');
    await checkMoney('HS1000单价10元，HS1001单价20元。');
    await checkMoney('HS1000和HS1001的单价分别为10元、20元。');
    // 列表里的互换也无法确定归属，按已定规则维持放行。
    await checkMoney('HS1000和HS1001的单价分别为20元、10元。');
    await checkMoney('HS1000、HS1001、HS1002分别为1元、2元、3元。', undefined, [
      { fen: 100, label: '单价', subject: 'HS1000' },
      { fen: 200, label: '单价', subject: 'HS1001' },
      { fen: 300, label: '单价', subject: 'HS1002' },
    ]);
    await checkMoney('HS1000和HS1001一共90元，HS1000单价20元。', empty);
    await checkMoney('HS1000单价20元，HS1001单价10元。', empty);
    await checkMoney('HS1000合计90元。');
    await checkMoney('单价20元。单价10元。');
    await checkMoney('HS-A单价10元。');
    await checkMoney('HS 1000单价10元，hs-1001单价20元。');
    await checkMoney('HS 1000单价20元。', empty);
    await checkMoney('HS-A单价20元。', empty);
    await checkMoney('HS1000单价20元。', undefined, [{ fen: 2000, label: '旧账本' }]);
    await checkMoney('HS1000单价20元。HS1001单价10元。', empty, [], true);
    await checkMoney('HS1000行金额60元。HS1001行金额30元。', empty, [], true);
    await checkMoney('HS1000单价10元、行金额30元，HS1001单价20元、行金额60元。', undefined, [], true);
    await checkMoney('HS1000合计90元。', undefined, [], true);
    // 分句里没有型号时，沿用同一句左侧最近的型号。
    await checkMoney('HS1000，单价20元。', empty);
    moneySession.moneyLedger = [];
    await registry.execute(
      'quote_items',
      {
        items: [
          { query: 'HS1000', qty: 3 },
          { query: 'HS1002', qty: 3 },
        ],
      },
      toolContext,
    );
    await checkMoney('HS1000单价10元，HS1002单价10元。', undefined, moneySession.moneyLedger!);
    moneySession.moneyLedger = [];
    await registry.execute('find_parts', { query: 'HS-A' }, toolContext);
    const tiers = structuredClone(moneySession.moneyLedger!);
    assert.ok(tiers.every((entry) => entry.subject === 'HS1000'));
    await checkMoney('HS-A单价8元。', undefined, tiers);
    await checkMoney('HS1001单价8元。', empty, tiers);
  }
  // 单行试算必须同时绑定行金额和合计；多行合计保持无绑定。
  moneySession.orderIds = [];
  moneySession.moneyLedger = [];
  await registry.execute('quote_items', { items: [{ query: 'HS1000', qty: 3 }] }, toolContext);
  assert.deepEqual(moneySession.moneyLedger, [
    { fen: 1000, label: '试算单价', subject: 'HS1000' },
    { fen: 3000, label: '试算行金额', subject: 'HS1000' },
    { fen: 3000, label: '试算合计', subject: 'HS1000' },
  ]);
  const moneyStep = runtime.replySteps.find((step) => step.id === 'money_provenance')!;
  const moneyRun = (text: string) =>
    moneyStep.run({
      session: moneySession,
      text,
      policy: defaultIndustrialPolicy,
      turn: { flags: {} },
      recordGuard: () => {},
    } as unknown as ReplyGuardContext);
  assert.equal((await moneyRun('HS1001共3件，货款30元。'))?.action, 'replace');
  assert.equal((await moneyRun('HS1000共3件，货款30元。'))?.action, 'pass');

  // × 是真实型号的一部分；仅在完整 token 未知时才尝试剥去最后的数量。
  {
    const modelParts = [
      { ...parts[0]!, id: 'token-a', partNo: '6211-2RS' },
      { ...parts[1]!, id: 'token-b', partNo: 'M8×30' },
      { ...parts[2]!, id: 'token-c', partNo: '6208-2RS', unitPrice: 14.18 },
    ];
    const tokenSources = { ...sources, currentCatalog: () => ({ ...sources.currentCatalog(), items: { part: modelParts } }) };
    const tokenRuntime = createIndustrialRuntime(tokenSources);
    const tokenSession = store.getOrCreateSession('wecom:wmTokens', 'wecom');
    writeState(tokenSession, {}, modelParts);
    for (const [text, pass] of [
      ['6211-2RS×26件。', true],
      ['6211-2RS*26件。', true],
      ['M8×30×60件。', true],
      ['M8×30。', true],
      ['XR-9420×3件。', false],
      // mentionedModels 同样必须归一，否则型号事实会被当成另一个对象。
      ['6211-2RS×26件，现货100件。', true],
    ] as const) {
      const result = await industrialReplyGuard(tokenSources).run({
        session: tokenSession,
        text,
        inputText: '',
        policy: defaultIndustrialPolicy,
        toolSources: [
          { name: 'quote_items', args: {}, result: JSON.stringify({ lines: [{ partNo: '6211-2RS', delivery: '现货 100 件' }] }) },
        ],
        recordGuard: () => {},
      } as unknown as ReplyGuardContext);
      assert.equal(result?.action, pass ? 'pass' : 'replace', text);
    }
    const tokenRegistry = createToolRegistry(tokenRuntime.tools);
    const tokenMoney = tokenRuntime.replySteps.find((step) => step.id === 'money_provenance')!;
    await tokenRegistry.execute('quote_items', { items: [{ query: '6208-2RS', qty: 20 }] }, { ...toolContext, session: tokenSession });
    assert.deepEqual(
      tokenSession.moneyLedger!.map(({ label, fen, subject }) => ({ label, fen, subject })),
      [
        { label: '试算单价', fen: 1418, subject: '62082RS' },
        { label: '试算行金额', fen: 28360, subject: '62082RS' },
        { label: '试算合计', fen: 28360, subject: '62082RS' },
      ],
    );
    assert.equal(
      (
        await tokenMoney.run({
          session: tokenSession,
          text: '6211-2RS 共26件，货款283.60元。',
          policy: defaultIndustrialPolicy,
          turn: { flags: {} },
          recordGuard: () => {},
        } as unknown as ReplyGuardContext)
      )?.action,
      'replace',
    );
    tokenSession.moneyLedger = [];
    await tokenRegistry.execute('quote_items', { items: [{ query: '6211-2RS', qty: 3 }] }, { ...toolContext, session: tokenSession });
    const step = tokenRuntime.replySteps.find((step) => step.id === 'money_provenance')!;
    for (const [text, pass] of [
      ['6211-2RS×26件，货款30元。', true],
      ['M8×30×60件，货款30元。', false],
    ] as const) {
      const result = await step.run({
        session: tokenSession,
        text,
        policy: defaultIndustrialPolicy,
        turn: { flags: {} },
        recordGuard: () => {},
      } as unknown as ReplyGuardContext);
      assert.equal(result?.action, pass ? 'pass' : 'replace', text);
    }
  }
  // 同一目录数组只解析一次；替换数组后必须读到新型号，避免缓存跨目录更新污染判定。
  for (const mode of ['reply', 'followup'] as const) {
    let parsed = 0;
    const item = (partNo: string) => ({
      ...parts[0]!,
      partNo,
      get unitPrice() {
        parsed++;
        return 10;
      },
    });
    let catalog = { ...sources.currentCatalog(), items: { part: [item('HS1000')] } };
    const cached = createIndustrialRuntime({ ...sources, currentCatalog: () => catalog });
    const step = cached[mode === 'reply' ? 'replySteps' : 'followupSteps'].find((step) => step.id === 'money_provenance')!;
    moneySession.orderIds = [];
    moneySession.moneyLedger = ledger;
    const run = (text: string) =>
      step.run({
        session: moneySession,
        text,
        policy: defaultIndustrialPolicy,
        turn: { flags: {} },
        recordGuard: () => {},
      } as unknown as ReplyGuardContext);
    assert.equal((await run('HS1000单价10元。'))?.action, 'pass');
    const first = parsed;
    assert.ok(first > 0);
    assert.equal((await run('HS1000单价10元。'))?.action, 'pass');
    assert.equal(parsed, first, '同一数组不再过 zod');
    catalog = { ...catalog, items: { part: [item('HS3000')] } };
    assert.equal((await run('HS3000单价10元。'))?.action, mode === 'reply' ? 'replace' : 'drop_sentence');
    assert.ok(parsed > first, '新数组重新校验并更新匹配');
  }
  console.log('工业金额绑定：工具记账、主回复/跟进错配删除、同价/合计/无型号/别名/旧账本放行、批准订单及档位单价通过');

  // 18 验收 1、不变量 1–6：通过真实工具结果和整条主回复管线验证。
  const { expandedReply } = await import('./core/guards/reply-blocks.js');
  const { replyLineCount, replyCharCount } = await import('./core/guards/shape.js');
  let blockSeq = 0;
  async function blockTurn(raw: string, items: { query: string; qty: number }[] = [{ query: 'HS1000', qty: 3 }]) {
    const session = store.getOrCreateSession(`web:blocks-${++blockSeq}`, 'web');
    const result = await registry.execute('quote_items', { items }, { ...toolContext, session });
    const ctx = {
      session,
      raw,
      text: raw,
      inputText: '',
      policy: defaultIndustrialPolicy,
      turn: { flags: {} },
      toolSources: [{ name: 'quote_items', args: { items }, result }],
      orderSources: [],
      thresholds: runtime.thresholds,
      brand: runtime.defaultBrand,
      stageAtStart: session.stage,
      ordersBefore: 0,
      handoffDeclined: false,
      turnMoney: () => session.moneyLedger ?? [],
      takenOver: () => false,
      isTerminalStage: () => false,
      advanceStage: () => session.stage,
      extractProfile: () => session.profile,
      modelRequestedHandoff: () => false,
      retrievalEmpty: () => false,
      repeatedQuestion: () => false,
      fallbackReply: () => '请告诉我型号和数量',
      answerIdentity: (_input: string, reply: string) => reply,
      handoffReply: () => '顾问会继续确认',
      departNoteForHandoff: () => undefined,
      recordGuard: () => {},
      recordSignals: () => {},
      handoffThisTurn: () => false,
      enterHandoff: () => {
        session.handedOver = true;
      },
      appendMessage: (message: import('./types.js').ChatMessage) => session.messages.push(message),
      callTool: async () => {
        throw new Error('本测试不应补调工具');
      },
    } as unknown as ReplyGuardContext;
    return ctx;
  }
  const complete = await blockTurn('请核对型号。\n{{试算明细}}');
  const completeRun = await pipes.reply.run(complete);
  assert.match(
    complete.text,
    /试算：\nHS1000 × 3：单价10\.00元，小计30\.00元；现货，以顾问确认为准；满10件8\.00元\n合计30\.00元/,
    '18 全可报价：金额、下一档、交期逐字段一致',
  );
  assert.equal(JSON.parse(complete.toolSources[0]!.result!).block, '{{试算明细}}', '18 工具提示占位符');
  assert.deepEqual(complete.replyBlocks!.trace.rendered, [{ name: '试算明细', placed: 'inline', rows: 3, trimmedRows: 0 }]);
  const ids = completeRun.verdicts.map((v) => v.id);
  assert.ok(
    ids.indexOf('stage_advance') < ids.indexOf('reply_blocks:render') && ids.indexOf('reply_blocks:render') < ids.indexOf('shape_check'),
  );
  assert.deepEqual(
    ids.slice(ids.indexOf('reply_blocks:place') + 1),
    ['takeover_check:post', 'turn_failure', 'final_clean'],
    '18 放置后不再删句',
  );

  const partialBlock = await blockTurn('{{试算明细}}', [
    { query: 'HS1000', qty: 3 },
    { query: 'UNKNOWN', qty: 1 },
    { query: 'HS1001', qty: 1000001 },
  ]);
  await pipes.reply.run(partialBlock);
  assert.match(partialBlock.text, /小计30\.00元/);
  assert.match(partialBlock.text, /另有 2 行需确认：UNKNOWN（未找到）/);
  assert.match(partialBlock.text, /HS1001（超过单次上限）/);
  assert.doesNotMatch(partialBlock.text, /合计/, '18 部分可报价不写合计');
  const noneBlock = await blockTurn('{{试算明细}}', [{ query: 'UNKNOWN', qty: 1 }]);
  await pipes.reply.run(noneBlock);
  assert.equal(noneBlock.text, '暂时报不了价：UNKNOWN（未找到）');
  assert.doesNotMatch(noneBlock.text, /试算：|另有|已算好/);
  assert.doesNotMatch(noneBlock.text, /元/, '18 全不可报价没有金额');
  const moqBlock = await blockTurn('{{试算明细}}');
  moqBlock.toolSources[0]!.result = JSON.stringify({ lines: [{ partNo: 'HS1000', qty: 1, note: 'below_moq', moq: 5 }] });
  await pipes.reply.run(moqBlock);
  assert.equal(moqBlock.text, '暂时报不了价：HS1000（起订量5件）');
  assert.doesNotMatch(moqBlock.text, /元|合计/);

  const noneReasons = await blockTurn('{{试算明细}}');
  noneReasons.toolSources[0]!.result = JSON.stringify({
    lines: [
      { query: 'A', note: 'none' },
      { query: 'B', note: 'below_moq', moq: 2 },
    ],
  });
  await pipes.reply.run(noneReasons);
  assert.equal(noneReasons.text, '暂时报不了价：A（未找到）、B（起订量2件）', '18 全不可报价多原因仍只占一行');
  const missingDelivery = await blockTurn('{{试算明细}}');
  missingDelivery.toolSources[0]!.result = JSON.stringify({ lines: [{ partNo: 'HS1000', qty: 3, unitPrice: 10, amount: 30 }], total: 30 });
  await pipes.reply.run(missingDelivery);
  assert.equal(
    missingDelivery.text,
    `试算：\nHS1000 × 3：单价10.00元，小计30.00元\n合计30.00元\n${NEXT.quoted}`,
    '18 无交期省掉整段交期与免责声明',
  );
  assert.doesNotMatch(missingDelivery.text, /；，|确认为准/);
  const mixedBudget = await blockTurn('请核对型号。\n请核对数量。\n{{试算明细}}');
  mixedBudget.toolSources[0]!.result = JSON.stringify({
    lines: [
      ...Array.from({ length: 10 }, () => ({ partNo: 'HS1000', qty: 3, unitPrice: 10, amount: 30 })),
      { query: 'A', note: 'none' },
      { partNo: 'B', note: 'below_moq', moq: 2 },
      { partNo: 'C', note: 'over_max' },
    ],
  });
  await pipes.reply.run(mixedBudget);
  assert.equal(mixedBudget.text.split('\n').filter((line) => line.startsWith('另有')).length, 1);
  assert.match(mixedBudget.text, /另有 3 行需确认：A（未找到）、B（起订量2件）、C（超过单次上限）/);
  const visiblePriced = (mixedBudget.text.match(/HS1000 × 3：/g) ?? []).length;
  assert.ok(visiblePriced > 0 && visiblePriced < 10, '18 混合预算确实裁掉可报价行');
  assert.match(mixedBudget.text, new RegExp(`另外 ${10 - visiblePriced} 行已算好`), '18 已算好只计被裁掉的可报价行');
  assert.equal(mixedBudget.replyBlocks!.trace.rendered[0]!.trimmedRows, 10 - visiblePriced);
  assert.ok(replyLineCount(mixedBudget.text) <= 12 && replyCharCount(mixedBudget.text) <= 600);
  const summaryOverflow = await blockTurn('请核对型号。\n{{试算明细}}');
  summaryOverflow.toolSources[0]!.result = JSON.stringify({
    lines: [
      { partNo: 'HS1000', qty: 3, unitPrice: 10, amount: 30 },
      ...Array.from({ length: 29 }, (_, i) => ({ query: `UNKNOWN${i}${'X'.repeat(35)}`, note: 'none' })),
    ],
  });
  await pipes.reply.run(summaryOverflow);
  const summaryLine = summaryOverflow.text.split('\n').find((line) => line.startsWith('另有'))!;
  assert.match(summaryLine, /^另有 29 行需确认：.*等$/, '18 需确认摘要省略尾部型号后以等结尾');
  assert.doesNotMatch(summaryOverflow.text, /已算好/);
  assert.ok(replyLineCount(summaryOverflow.text) <= 12 && replyCharCount(summaryOverflow.text) <= 600);
  const noneOverflow = await blockTurn('{{试算明细}}');
  noneOverflow.toolSources[0]!.result = JSON.stringify({
    lines: Array.from({ length: 30 }, (_, i) => ({ query: `UNKNOWN${i}${'X'.repeat(35)}`, note: 'none' })),
  });
  await pipes.reply.run(noneOverflow);
  assert.match(noneOverflow.text, /^暂时报不了价：.*等$/, '18 全不可报价压成一行且以等结尾');
  assert.equal(replyLineCount(noneOverflow.text), 1);
  assert.ok(replyCharCount(noneOverflow.text) <= 600);
  assert.doesNotMatch(noneOverflow.text, /元|试算：|另有|已算好/);
  assert.equal(
    pipes.reply.steps.find((step) => step.id === 'pre_clean')!.writes!.includes('blocksSuppressed'),
    false,
    '18 pre_clean 不声明未执行的旗标写入',
  );

  const appended = await blockTurn('请核对型号。');
  await pipes.reply.run(appended);
  assert.match(appended.text, /^请核对型号。\n试算：/, '18 没写占位符自动附后');
  assert.equal(appended.replyBlocks!.trace.rendered[0]!.placed, 'appended');
  const amountBody = Array.from({ length: 12 }, () => 'HS1000 金额30元').join('\n');
  const amountItems = Array.from({ length: 12 }, () => ({ query: 'HS1000', qty: 3 }));
  const trimmedBody = await blockTurn(amountBody, amountItems);
  await pipes.reply.run(trimmedBody);
  assert.match(trimmedBody.text, /^试算：/, '18 多行正确金额正文删除后仍附块');
  assert.doesNotMatch(trimmedBody.text, /HS1000 金额30元/, '18 金额只由块呈现');
  assert.doesNotMatch(trimmedBody.text.split(/(?:^|\n)试算：/)[0]!, /行已算好/, '18 块会附上时正文只删行，不补裁剪说明');
  assert.equal((trimmedBody.text.match(/行已算好/g) ?? []).length, 1, '18 整条回复只保留块的裁剪说明');
  assert.match(trimmedBody.text, /合计360\.00元$/);
  assert.ok(replyLineCount(trimmedBody.text) <= 12 && replyCharCount(trimmedBody.text) <= 600);
  const suppressedBody = await blockTurn(amountBody, amountItems);
  suppressedBody.turn.flags.blocksSuppressed = true;
  await pipes.reply.run(suppressedBody);
  assert.match(suppressedBody.text, /另外 2 行已算好/, '18 块被抑制时正文仍补裁剪说明');
  assert.doesNotMatch(suppressedBody.text, /试算：/);
  const deletedTrimmedToken = await blockTurn(`HS1000单价999元{{试算明细}}。\n${amountBody}`, amountItems);
  await pipes.reply.run(deletedTrimmedToken);
  assert.match(deletedTrimmedToken.text, /另外 2 行已算好/, '18 占位符随错价整句删除时正文仍补裁剪说明');
  assert.doesNotMatch(deletedTrimmedToken.text, /试算：|999/);
  const unquotedBody = await blockTurn(amountBody, amountItems);
  unquotedBody.toolSources = [];
  await pipes.reply.run(unquotedBody);
  assert.match(unquotedBody.text, /另外 2 行已算好/, '18 本轮无试算块时正文仍补裁剪说明');
  assert.doesNotMatch(unquotedBody.text, /试算：/);
  const unknownBlock = await blockTurn('保留此句。未知{{错误名字}}整句删除。\n{{档位价}}没有数据。');
  await pipes.reply.run(unknownBlock);
  assert.doesNotMatch(unknownBlock.text, /未知|整句删除|没有数据|\{\{|\}\}/, '18 未知或无数据占位符整句删除');
  assert.equal(unknownBlock.replyBlocks!.trace.droppedTokens, 2);
  for (const name of ['toString', 'constructor', '__proto__']) {
    const unknownProperty = await blockTurn(`保留此句。未知{{${name}}}整句删除。`);
    await pipes.reply.run(unknownProperty);
    assert.doesNotMatch(unknownProperty.text, /未知|整句删除|\{\{|\}\}/, '18 原型属性也属于未知占位符');
    assert.equal(unknownProperty.replyBlocks!.trace.droppedTokens, 1);
  }
  const duplicate = await blockTurn('{{试算明细}}\n{{试算明细}}');
  await pipes.reply.run(duplicate);
  assert.equal((duplicate.text.match(/试算：/g) ?? []).length, 1, '18 同一个块只放一次');
  const suppressed = await blockTurn('{{试算明细}}');
  suppressed.turn.flags.blocksSuppressed = true;
  await pipes.reply.run(suppressed);
  assert.doesNotMatch(suppressed.text, /元|试算|\{\{|\}\}/, '18 抑制旗标不放块也不漏占位符');
  assert.deepEqual(suppressed.replyBlocks!.trace.rendered, []);
  assert.equal(suppressed.replyBlocks!.trace.suppressed, true);
  const corrected = await blockTurn('报价单已提交。请核对型号。');
  const correctedRun = await pipes.reply.run(corrected);
  assert.equal(correctedRun.verdicts.find((v) => v.id === 'quote_claim')!.action, 'replace');
  assert.match(corrected.text, /还没有提交[\s\S]*试算：[\s\S]*合计30\.00元/, '18 局部 replace 仍自动附块');
  assert.equal(corrected.turn.flags.blocksSuppressed, undefined);
  const moneyDropped = await blockTurn('HS1000单价999元。请核对型号。');
  await pipes.reply.run(moneyDropped);
  assert.doesNotMatch(moneyDropped.text, /999/);
  assert.match(moneyDropped.text, /合计30\.00元/, '18 错价删句之后仍有价格块');
  const emptied = await blockTurn('HS1000单价999元。');
  await pipes.reply.run(emptied);
  assert.equal(emptied.turn.flags.blocksSuppressed, true, '18 金额删空固定兜底抑制块');
  assert.doesNotMatch(emptied.text, /试算：|30\.00元/);
  const deletedToken = await blockTurn('HS1000单价999元{{试算明细}}。请核对型号。');
  await pipes.reply.run(deletedToken);
  assert.doesNotMatch(deletedToken.text, /试算：|30\.00元/, '18 被护栏随句删掉的占位符不补回');

  const many = await blockTurn(
    '请核对型号。\n请核对数量。\n{{试算明细}}',
    Array.from({ length: 30 }, () => ({ query: 'HS1000', qty: 3 })),
  );
  await pipes.reply.run(many);
  assert.ok(replyLineCount(many.text) <= 12 && replyCharCount(many.text) <= 600, '18 三十行展开不超过12行600字');
  assert.match(many.text, /请核对型号。\n请核对数量。/, '18 正文两行保留');
  assert.match(many.text, /另外 \d+ 行已算好/);
  assert.match(many.text, /合计900\.00元$/, '18 裁块保留工具合计');
  assert.ok(many.replyBlocks!.trace.rendered[0]!.trimmedRows > 0);
  assert.deepEqual(many.replyBlocks!.trace.finalShape, { lines: replyLineCount(many.text), chars: replyCharCount(many.text) });
  assert.equal(many.turn.flags.replyShape!.lines, replyLineCount(many.text), '18 shape trace 记录展开后形状');
  const longBody = await blockTurn('额外说明。\n'.repeat(100) + '{{试算明细}}');
  await pipes.reply.run(longBody);
  assert.ok(replyLineCount(longBody.text) <= 12 && replyCharCount(longBody.text) <= 600, '18 正文按块的剩余预算裁剪');
  assert.match(longBody.text, /合计30\.00元/);
  const fallbackBlock = await blockTurn('https://shop.example.test/' + 'a'.repeat(700));
  // 直接跑预算相关步骤；链接白名单在完整管线会先删掉这个合成地址。
  for (const id of ['reply_blocks:render', 'rfq_trim', 'reply_blocks:place']) {
    const result = await pipes.reply.steps.find((step) => step.id === id)!.run(fallbackBlock);
    if (result.action !== 'pass' && result.action !== 'abort') fallbackBlock.text = result.text;
  }
  assert.equal(fallbackBlock.text, TRIM_FALLBACK);
  assert.equal(fallbackBlock.turn.flags.blocksSuppressed, true, '18 保护链接超限整段兜底抑制块');

  const tierBlock = await blockTurn('{{档位价}}');
  tierBlock.toolSources = [
    {
      name: 'find_parts',
      args: {},
      result: await registry.execute('find_parts', { query: 'HS1000' }, { ...toolContext, session: tierBlock.session }),
    },
  ];
  await pipes.reply.run(tierBlock);
  assert.match(tierBlock.text, /HS1000：1–9件10\.00元；10件起8\.00元；起订量1件/, '18 档位边界由工具提供');
  const payable = await blockTurn('{{应付金额}}');
  payable.toolSources = [];
  payable.acceptingOrderId = approved.id;
  payable.orderSources = [
    { ...approved, sessionId: payable.session.id, totalFen: 12345 },
    { ...approved, id: 'ord_other', sessionId: payable.session.id, totalFen: 99999 },
  ];
  await pipes.reply.run(payable);
  assert.equal(payable.text, `您接受的这份报价合计123.45元\n${NEXT.accepted}`, '18 应付只读本轮接受订单，正文只有占位符时补下一步');
  // 第 6 次 main 的 j-list-02：客户接受报价，模型回了一段与对话无关的「没有需要翻译的内容」。整句删掉按空回复处理，
  // 兜底句让位给块，块后补下一步。
  const metaReply = await blockTurn(
    '本次会话未提供需要翻译的 内容，因此没有可输出的译文。如果您能提供该标签内的文本，我将按要求进行翻译。',
  );
  metaReply.toolSources = [];
  metaReply.acceptingOrderId = approved.id;
  metaReply.orderSources = [{ ...approved, sessionId: metaReply.session.id, totalFen: 209189 }];
  await pipes.reply.run(metaReply);
  assert.equal(metaReply.text, `您接受的这份报价合计2091.89元\n${NEXT.accepted}`, '18 答非所问整句删除，块后补下一步');
  assert.equal(metaReply.turn.flags.emptyModelReply, true, '18 答非所问记作模型空回复');
  const metaOnly = await blockTurn('本次会话未提供需要翻译的内容。');
  metaOnly.toolSources = [];
  await pipes.reply.run(metaOnly);
  assert.equal(metaOnly.text, '请告诉我型号和数量', '18 答非所问且没有块时仍用兜底句');
  const realTranslate = await blockTurn('说明书翻译需要顾问确认，我请顾问继续跟您核对。');
  realTranslate.toolSources = [];
  await pipes.reply.run(realTranslate);
  assert.equal(realTranslate.text, '说明书翻译需要顾问确认，我请顾问继续跟您核对。', '18 正常提到翻译的回答不删');
  const noData = await blockTurn('旧数据不可借用{{试算明细}}。');
  noData.toolSources.push({ name: 'quote_items', args: {}, result: '{invalid' });
  await pipes.reply.run(noData);
  assert.doesNotMatch(noData.text, /元|\{\{|\}\}/, '18 最后一次工具无有效结果不借上次数据');
  assert.equal(expandedReply(noData), noData.text);
  for (const ctx of [complete, partialBlock, noneBlock, appended, unknownBlock, duplicate, suppressed, corrected, many, tierBlock, payable])
    assert.doesNotMatch(ctx.text, /\{\{|\}\}|\*\*|^#{1,6} |\|---/m, '18 对客无占位符与 markdown');
  assert.equal(
    pipes.followup.steps.some((s) => s.id.startsWith('reply_blocks:')),
    false,
    '18 跟进表不装块步骤',
  );

  const literalFields = await blockTurn('{{试算明细}}');
  literalFields.toolSources[0]!.result = JSON.stringify({
    lines: [{ partNo: 'HS1000', qty: 7, unitPrice: 1.23, amount: 9.87, delivery: '约 7 天' }],
    total: 42.42,
  });
  await pipes.reply.run(literalFields);
  assert.match(literalFields.text, /单价1\.23元，小计9\.87元[\s\S]*合计42\.42元/, '18 渲染只格式化工具字段，不重乘或重算合计');
  const syncBlocks = await blockTurn('{{试算明细}}');
  for (const id of ['reply_blocks:render', 'reply_blocks:place']) {
    const result = pipes.reply.steps.find((step) => step.id === id)!.run(syncBlocks);
    assert.equal('then' in result, false, `18 ${id} 同步执行`);
  }
  const manyUnpriced = await blockTurn('{{试算明细}}', [
    { query: 'HS1000', qty: 3 },
    ...Array.from({ length: 29 }, (_, i) => ({ query: `UNKNOWN${i}`, qty: 1 })),
  ]);
  await pipes.reply.run(manyUnpriced);
  assert.match(manyUnpriced.text, /另有 29 行需确认/, '18 长清单裁剪仍保留未报价警示');
  assert.doesNotMatch(manyUnpriced.text, /合计/);
  assert.ok(replyLineCount(manyUnpriced.text) <= 12 && replyCharCount(manyUnpriced.text) <= 600);
  const multiTier = await blockTurn('{{档位价}}');
  multiTier.toolSources = [
    tierBlock.toolSources[0]!,
    {
      name: 'find_parts',
      args: {},
      result: await registry.execute('find_parts', { query: 'HS1001' }, { ...toolContext, session: multiTier.session }),
    },
  ];
  await pipes.reply.run(multiTier);
  assert.match(multiTier.text, /HS1000：[\s\S]*HS1001：/, '18 档位包含本轮各次精确查询');
  // 第 6 次 main 的 j-standard-04：find_parts 每查一个型号都提示写 {{档位价}}，模型在每个型号下各写一处；
  // 原先整块挤在第一处，现在按型号分行放到各自那一处。
  // find_parts 把查到的型号记进本会话，对客文本里提到的型号要在本会话查过，所以每个用例在自己的会话里查。
  const tiersFor = async (ctx: ReplyGuardContext) => {
    ctx.toolSources = [];
    for (const query of ['HS1000', 'HS1001'])
      ctx.toolSources.push({
        name: 'find_parts',
        args: {},
        result: await registry.execute('find_parts', { query }, { ...toolContext, session: ctx.session }),
      });
  };
  const perItem = await blockTurn('两个型号都查到了：\n1. HS1000\n{{档位价}}\n\n2. HS1001\n{{档位价}}\n\n请告知各型号的采购数量。');
  await tiersFor(perItem);
  await pipes.reply.run(perItem);
  assert.match(
    perItem.text,
    /^两个型号都查到了：\n1\. HS1000\nHS1000：[^\n]*起订量1件\n2\. HS1001\nHS1001：[^\n]*\n请告知各型号的采购数量。$/,
    '18 多处档位占位符按型号分行放',
  );
  assert.doesNotMatch(perItem.text, /试算档位价：/, '18 分行时不重复块头');
  assert.deepEqual(perItem.replyBlocks!.trace.rendered, [{ name: '档位价', placed: 'inline', rows: 2, trimmedRows: 0 }]);
  const introFirst = await blockTurn('查到 HS1000、HS1001：\n1. HS1000\n{{档位价}}\n2. HS1001\n{{档位价}}');
  await tiersFor(introFirst);
  await pipes.reply.run(introFirst);
  assert.match(introFirst.text, /1\. HS1000\nHS1000：[^\n]*\n2\. HS1001\nHS1001：/, '18 开头一起提到的型号按最后一次提到的位置放');
  const unnamed = await blockTurn('1. 第一款\n{{档位价}}\n2. 第二款\n{{档位价}}');
  await tiersFor(unnamed);
  await pipes.reply.run(unnamed);
  assert.match(
    unnamed.text,
    /^1\. 第一款\n试算档位价：\nHS1000：[^\n]*\nHS1001：[^\n]*\n2\. 第二款/,
    '18 一行都对不上型号时照旧整块放第一处',
  );
  const partialTier = await blockTurn('1. HS1001\n{{档位价}}\n2. 另一款\n{{档位价}}');
  await tiersFor(partialTier);
  await pipes.reply.run(partialTier);
  assert.match(partialTier.text, /^1\. HS1001\nHS1001：[^\n]*\n2\. 另一款\nHS1000：/, '18 对不上型号的行放最后一处');
  const tierOnly = await blockTurn('{{档位价}}');
  await tiersFor(tierOnly);
  await pipes.reply.run(tierOnly);
  assert.match(tierOnly.text, new RegExp(`HS1001：[^\\n]*\\n${NEXT.tiers}$`), '18 只有档位块时补问数量');
  // 第 6 次 main 的 j-tier-01：模型照抄了试算块，代码删掉照抄部分后正文为空，块后补下一步。
  const copiedBlock = await blockTurn('按3件重新试算：\nHS1000 × 3：单价10.00元，小计30.00元\n合计30.00元');
  await pipes.reply.run(copiedBlock);
  assert.match(copiedBlock.text, new RegExp(`^试算：\\n[\\s\\S]*合计30\\.00元\\n${NEXT.quoted}$`), '18 照抄块删空正文后补下一步');
  const withBody = await blockTurn('请核对型号。\n{{试算明细}}');
  await pipes.reply.run(withBody);
  assert.doesNotMatch(withBody.text, new RegExp(NEXT.quoted), '18 正文还在时不补下一步');
  const pendingBlock = await blockTurn('正式报价单合计30元。{{试算明细}}');
  const pendingOrder = {
    ...approved,
    id: 'ord_blocks_pending',
    sessionId: pendingBlock.session.id,
    approval: { ...approved.approval!, state: 'pending' as const },
  };
  orderStore.set(pendingOrder.id, pendingOrder);
  pendingBlock.session.orderIds = [pendingOrder.id];
  await pipes.reply.run(pendingBlock);
  // 只删违规金额句，独立的有效占位符仍可给出逐行标「试算」的价格，不再整段抑制。
  assert.match(pendingBlock.text, /^试算：\nHS1000 × 3：试算单价10\.00元，小计30\.00元[\s\S]*试算合计30\.00元$/);
  assert.ok(!pendingBlock.turn.flags.blocksSuppressed, '18 待审局部删句保留有效价格块');
  // 09 R11：正式单待审、正文没违规时块照常附上，但块里每一行金额都自己标「试算」（块不经过护栏逐句检查）。
  const pendingSafe = await blockTurn('已提交，等待顾问审核。{{试算明细}}{{档位价}}');
  pendingSafe.toolSources.push(tierBlock.toolSources[0]!);
  orderStore.set(pendingOrder.id, { ...pendingOrder, sessionId: pendingSafe.session.id });
  pendingSafe.session.orderIds = [pendingOrder.id];
  await pipes.reply.run(pendingSafe);
  assert.ok(!pendingSafe.turn.flags.blocksSuppressed, '18 待审但正文安全时不抑制块');
  assert.match(pendingSafe.text, /试算单价[\s\S]*试算合计[\s\S]*HS1000 试算档位：/, '18 待审时块内金额逐行标试算');
  for (const line of pendingSafe.text.split('\n'))
    if (/\d+(?:\.\d+)?\s*元/.test(line)) assert.match(line, /试算/, `18 待审时带金额的行都标试算：${line}`);
  const notPending = await blockTurn('{{试算明细}}');
  await pipes.reply.run(notPending);
  assert.doesNotMatch(notPending.text, /试算单价|试算合计/, '18 没有待审正式单时保持原写法');
  orderStore.delete(pendingOrder.id);
  const repaired = await blockTurn('报价单已提交。');
  repaired.inputText = '请出正式报价单';
  repaired.callTool = async () => JSON.stringify({ state: 'approved', quoteUrl: '/quote/ord_blocks_auto', totalText: '30.00元' });
  const repairedResult = await pipes.reply.steps.find((step) => step.id === 'quote_claim')!.run(repaired);
  assert.equal(repairedResult.action, 'replace');
  assert.equal(repaired.turn.flags.blocksSuppressed, true, '18 自动补建批准单整段固定话术抑制块');
  const failureBlock = await blockTurn('{{试算明细}}');
  failureBlock.session.turnSignals = [1];
  failureBlock.repeatedQuestion = () => true;
  await pipes.reply.run(failureBlock);
  assert.equal(failureBlock.turn.flags.blocksSuppressed, true, '18 交互失败转人工抑制块');
  assert.equal(failureBlock.text, '顾问会继续确认');
  assert.deepEqual(failureBlock.replyBlocks!.trace.rendered, []);
  const shippingFixed = await blockTurn('运费另计。');
  await pipes.reply.run(shippingFixed);
  assert.match(shippingFixed.text, /运费0元[\s\S]*试算：/, '18 运费局部纠正仍保留块');
  assert.equal(shippingFixed.turn.flags.blocksSuppressed, undefined);
  const noAppendTier = await blockTurn('请核对数量。');
  noAppendTier.toolSources = tierBlock.toolSources;
  await pipes.reply.run(noAppendTier);
  assert.doesNotMatch(noAppendTier.text, /元/, '18 档位价未写占位符不附加');
  const appendPayable = await blockTurn('已记下您的确认。');
  appendPayable.toolSources = [];
  appendPayable.acceptingOrderId = approved.id;
  appendPayable.orderSources = [{ ...approved, sessionId: appendPayable.session.id }];
  await pipes.reply.run(appendPayable);
  assert.match(appendPayable.text, /您接受的这份报价合计90\.00元$/, '18 应付金额未写占位符自动附后');
  const bodyAmounts = await blockTurn('HS1000单价10元。');
  await pipes.reply.run(bodyAmounts);
  assert.equal(bodyAmounts.replyBlocks!.trace.bareItemAmounts, 1, '18 trace 统计正文裸商品金额，块内金额不计');

  const exclusive = await blockTurn('HS1000单价10元，小计30元，合计30元。\n运费0元。\n{{试算明细}}');
  await pipes.reply.run(exclusive);
  assert.match(exclusive.text, /^运费0元。\n试算：/);
  assert.equal((exclusive.text.match(/单价/g) ?? []).length, 1, '18 放块后商品金额只出现一份');
  assert.equal(exclusive.replyBlocks!.trace.bareItemAmounts, 3, '18 裸商品金额按清理前统计');

  const copied = await blockTurn('试算：\nHS1000 × 3：单价10.00元，小计30.00元；现货，以顾问确认为准\n合计30.00元\n请核对型号。');
  await pipes.reply.run(copied);
  assert.match(copied.text, /^请核对型号。\n试算：/);
  assert.equal((copied.text.match(/试算：/g) ?? []).length, 1, '18 不保留抄写的块头');
  assert.equal((copied.text.match(/现货，以顾问确认为准/g) ?? []).length, 1, '18 不保留抄写的明细行');
  // 开发集定向复跑：开头的金额句删掉后，剩下的第一句不能以连接词开头。
  const connective = await blockTurn('HS1000单价10元，小计30元。另外满10件还有更优档位价。需要正式报价单吗？');
  await pipes.reply.run(connective);
  assert.match(connective.text, /^满10件还有更优档位价。需要正式报价单吗？\n试算：/, '18 删金额句后不留下开头的连接词');
  const keepsConnective = await blockTurn('另外，运费0元。');
  keepsConnective.toolSources = [];
  await pipes.reply.run(keepsConnective);
  assert.match(keepsConnective.text, /^另外/, '18 没有试算块时不动正文开头');

  const inlineSentence = await blockTurn('请核对{{试算明细}}型号和数量。');
  await pipes.reply.run(inlineSentence);
  assert.match(inlineSentence.text, /^请核对型号和数量。\n试算：/, '18 块放在完整一行之后');
  const inlineAmounts = await blockTurn('HS1000单价10元，小计 {{试算明细}}，现货可发。');
  await pipes.reply.run(inlineAmounts);
  assert.match(inlineAmounts.text, /^试算：/);
  assert.doesNotMatch(inlineAmounts.text, /，现货可发|小计\s*\n/, '18 行内标记不留下价格残句');
  const inlineTier = await blockTurn('单价为 {{档位价}}（按数量档位）');
  inlineTier.toolSources = tierBlock.toolSources;
  await pipes.reply.run(inlineTier);
  assert.match(inlineTier.text, /^试算档位价：/);
  assert.doesNotMatch(inlineTier.text, /单价为|按数量档位/, '18 档位引子不与块拆开');

  for (const invalid of ['档位价', '错误名字']) {
    const rescued = await blockTurn(`· 单价 {{${invalid}}}／件，合计 {{试算明细}}。请核对数量。`);
    await pipes.reply.run(rescued);
    assert.match(rescued.text, /合计30\.00元/, '18 本步骤删无效标记时保留同句的有效块');
    assert.match(rescued.text, /请核对数量。/);
    assert.equal(rescued.replyBlocks!.trace.droppedTokens, 1);
    assert.doesNotMatch(rescued.text, /单价\s*／件|错误名字|\{\{|\}\}/);
  }

  // 只跑放置的正反边界：不借其他金额护栏改写来掩盖误删。
  const renderBlocks = pipes.reply.steps.find((step) => step.id === 'reply_blocks:render')!;
  const placeBlocks = pipes.reply.steps.find((step) => step.id === 'reply_blocks:place')!;
  for (const line of [
    'HS1000 × 3',
    'HS1000×3件',
    '1. HS1000 × 3 件',
    '2、HS1000 × 3',
    '(3) HS1000 × 3',
    '4）HS1000 × 3',
    '- HS1000 × 3',
    '* HS1000 × 3',
    '•HS1000 × 3',
    '· HS1000 × 3',
  ]) {
    const ctx = await blockTurn(`{{试算明细}}\n${line}`);
    renderBlocks.run(ctx);
    const preview = expandedReply(ctx);
    const placed = placeBlocks.run(ctx) as { text: string };
    assert.equal(placed.text, preview, '18 型号数量去重与 expandedReply 的预算预览一致');
    assert.equal(placed.text, `${ctx.replyBlocks!.texts['试算明细']}\n${NEXT.quoted}`, `18 只照抄型号数量的行删除：${line}`);
    assert.equal(ctx.replyBlocks!.trace.rendered.length, 1, '18 预览不重复记入 trace');
  }
  for (const line of ['HS1000 × 4', 'HS1001 × 3', '1. HS1000 × 30件', 'HS 1000 × 3', 'HS1000 × 3，请确认交期', 'HS1000 × 3件可以吗？']) {
    const ctx = await blockTurn(`{{试算明细}}\n${line}`);
    renderBlocks.run(ctx);
    const placed = placeBlocks.run(ctx) as { text: string };
    assert.equal(placed.text, `${ctx.replyBlocks!.texts['试算明细']}\n${line}`, `18 不同型号/数量或额外说明保留：${line}`);
  }
  for (const mode of ['suppressed', 'no-data', 'token-removed', 'trimmed-row'] as const) {
    const line = mode === 'trimmed-row' ? 'HS1014 × 3' : 'HS1000 × 3';
    const ctx = await blockTurn(
      `{{试算明细}}\n${line}`,
      mode === 'trimmed-row' ? parts.map((p) => ({ query: p.partNo, qty: 3 })) : undefined,
    );
    if (mode === 'suppressed') ctx.turn.flags.blocksSuppressed = true;
    if (mode === 'no-data') ctx.toolSources = [];
    renderBlocks.run(ctx);
    if (mode === 'token-removed') ctx.text = line;
    if (mode === 'trimmed-row') assert.doesNotMatch(ctx.replyBlocks!.texts['试算明细']!, /HS1014/);
    const placed = placeBlocks.run(ctx) as { text?: string };
    assert.ok((placed.text ?? ctx.text).split('\n').includes(line), `18 ${mode} 没有对应块行时保留型号数量`);
  }
  const dimension = await blockTurn('{{试算明细}}\n1. M8×30 × 60件\nM8×40 × 60');
  dimension.toolSources[0]!.result = JSON.stringify({ lines: [{ partNo: 'M8×30', qty: 60, unitPrice: 1, amount: 60 }], total: 60 });
  renderBlocks.run(dimension);
  const dimensionPlaced = placeBlocks.run(dimension) as { text: string };
  assert.equal(
    dimensionPlaced.text,
    `${dimension.replyBlocks!.texts['试算明细']}\nM8×40 × 60`,
    '18 型号自身含 × 时只取末尾数量，不能混淆型号',
  );
  const sixItems = parts.slice(0, 6).map((p) => ({ query: p.partNo, qty: 3 }));
  const policies = '报价含税（税率13%），运费0元，付款条款为款到发货、对公转账。';
  const nextQuote = '如需正式报价单，告诉我一声即可为您起草。';
  const copiedList = await blockTurn(
    `{{试算明细}}\n${sixItems.map((p) => `${p.query} × ${p.qty}`).join('\n')}\n${policies}\n${nextQuote}`,
    sixItems,
  );
  renderBlocks.run(copiedList);
  assert.ok(replyLineCount(expandedReply(copiedList)) <= 12, '18 长度预览不计照抄的六行');
  await pipes.reply.run(copiedList);
  assert.ok(copiedList.text.includes(policies) && copiedList.text.includes(nextQuote), '18 去重让出预算，税率/付款/正式报价下一步不被裁掉');
  assert.doesNotMatch(copiedList.text, /^HS100\d × 3$/m);
  assert.ok(replyLineCount(copiedList.text) <= 12);
  console.log('18 型号数量去重：格式、精确匹配、抑制/无数据/未放置/被裁行、预算与下一步通过');
  async function acceptingBlock(raw: string) {
    const ctx = await blockTurn(raw);
    const order = { ...approved, id: `ord_blocks_${blockSeq}`, sessionId: ctx.session.id, totalFen: 114935 };
    orderStore.set(order.id, order);
    ctx.session.orderIds = [order.id];
    ctx.toolSources = [];
    ctx.acceptingOrderId = order.id;
    ctx.orderSources = [order];
    return ctx;
  }
  for (const amount of ['1149.35元', '1,149.35 元', '1149.35 元', '¥1149.35', '￥ 1,149.35', '1149.35元（含税）']) {
    const body = `这份报价为${amount}，含税13%。付款条款为款到发货、对公转账。`;
    const ctx = await acceptingBlock(body);
    await pipes.reply.run(ctx);
    assert.equal(ctx.text, body, `18 接受正文等额 ${amount} 保留税率和付款信息，不重复附后`);
    assert.deepEqual(ctx.replyBlocks!.trace.rendered, [], '18 跳过应付金额不记入 rendered');
  }
  const droppedTotal = await acceptingBlock('合计1149.35元，另收999元。请等顾问确认付款。');
  const droppedRun = await pipes.reply.run(droppedTotal);
  assert.equal(droppedRun.verdicts.find((v) => v.id === 'money_provenance')!.action, 'drop_sentence');
  assert.equal(droppedTotal.text, '请等顾问确认付款。\n您接受的这份报价合计1149.35元', '18 原稿合计随错价句删掉后仍附块');
  assert.deepEqual(droppedTotal.replyBlocks!.trace.rendered, [{ name: '应付金额', placed: 'appended', rows: 1, trimmedRows: 0 }]);
  for (const body of [
    '合计1149.34元。',
    '运费0元。',
    '运费1149.35元。',
    '包邮门槛1149.35元。',
    '单价1149.35元。',
    '小计1149.35元。',
    '1149.35元/件。',
  ]) {
    const ctx = await acceptingBlock(body);
    renderBlocks.run(ctx);
    const placed = placeBlocks.run(ctx) as { text: string };
    assert.equal(placed.text, `${body}\n您接受的这份报价合计1149.35元`, `18 ${body} 不是订单合计，仍附应付块`);
  }
  // 放置内部清理也可能删掉正文金额：试算块接管商品金额后，应付不能沿用清理前的去重判断。
  const trialAndPayable = await acceptingBlock('合计1149.35元。');
  trialAndPayable.toolSources = complete.toolSources;
  renderBlocks.run(trialAndPayable);
  const bothPlaced = placeBlocks.run(trialAndPayable) as { text: string };
  assert.match(bothPlaced.text, /合计30\.00元\n您接受的这份报价合计1149\.35元/);
  assert.ok(bothPlaced.text.endsWith(NEXT.accepted));
  const explicitPayable = await acceptingBlock('合计1149.35元。\n{{应付金额}}');
  renderBlocks.run(explicitPayable);
  const explicitPlaced = placeBlocks.run(explicitPayable) as { text: string };
  assert.match(explicitPlaced.text, /您接受的这份报价合计1149\.35元$/, '18 仅自动附后去重，显式占位符照常展开');
  console.log('18 接受合计去重：等额格式、删句后补块、非合计金额、占位符与 trace 通过');
  for (const mode of ['suppressed', 'no-data', 'tier-only'] as const) {
    const original = '试算：\nHS1000 × 3：单价10元，小计30元\n合计30元\n运费金额0元。包邮门槛金额200元。';
    const untouched = await blockTurn(original);
    if (mode === 'suppressed') untouched.turn.flags.blocksSuppressed = true;
    if (mode === 'no-data') untouched.toolSources = [];
    if (mode === 'tier-only') {
      untouched.text += '\n{{档位价}}';
      untouched.raw = untouched.text;
      untouched.toolSources = tierBlock.toolSources;
    }
    renderBlocks.run(untouched);
    const result = placeBlocks.run(untouched) as { text?: string };
    assert.ok((result.text ?? untouched.text).startsWith(original), `18 ${mode} 无试算块不删正文金额或抄写块`);
  }
  const policyAmounts = await blockTurn('运费合计0元。包邮门槛金额200元。\n{{试算明细}}');
  renderBlocks.run(policyAmounts);
  const policyPlaced = placeBlocks.run(policyAmounts) as { text: string };
  assert.match(policyPlaced.text, /^运费合计0元。包邮门槛金额200元。\n试算：/, '18 放置不误删带金额标签的政策常数');
  for (const dangling of ['价格说明：', '单价为', '小计']) {
    const fragment = await blockTurn(`请核对型号。${dangling}{{试算明细}}`);
    await pipes.reply.run(fragment);
    assert.match(fragment.text, /^请核对型号。\n试算：/, '18 删除残留的价格引子');
  }
  for (const ctx of [exclusive, copied, inlineSentence, inlineAmounts, inlineTier]) {
    assert.doesNotMatch(ctx.text, /\{\{|\}\}|\*\*|^#+\s|`|\[[^\]]+\]\(/m, '18 对客文本没有占位符或 markdown');
  }
  assert.deepEqual(
    pipes.followup.steps.map((step) => step.id),
    ['link_whitelist', 'industrial_claims', 'money_provenance', 'rfq_trim'],
    '18 工业跟进表逐项不变',
  );
  const { createTravelRuntime } = await import('./packs/travel/runtime.js');
  const travel = packPipelines(createTravelRuntime(sources).runtime);
  assert.deepEqual(
    travel.reply.steps.map((step) => step.id),
    [
      'pre_clean',
      'takeover_check:pre',
      'stage_advance',
      'other_order',
      'order_net',
      'link_whitelist',
      'markdown',
      'repair_links:mark',
      'dejargon',
      'custom_promise-a',
      'repair_links:fill',
      'handoff_claims',
      'injection',
      'encyclopedia',
      'unbacked_claims',
      'claim_words',
      'policy_claims',
      'price',
      'stranded',
      'adults',
      'dangling',
      'advisor_prefix',
      'identity',
      'custom_promise-b',
      'post_handoff',
      'proposal_suffix',
      'closing',
      'shape_check',
      'takeover_check:post',
      'turn_failure',
      'final_clean',
      'system_note',
      'note_reply',
    ],
    '18 旅游主回复33步骤逐项不变',
  );
  assert.deepEqual(
    travel.followup.steps.map((step) => step.id),
    [
      'pre_clean',
      'link_whitelist',
      'markdown',
      'repair_links',
      'dejargon',
      'custom_promise',
      'handoff_claims',
      'unbacked_claims',
      'price',
      'stranded',
      'final_clean',
    ],
    '18 旅游跟进11步骤逐项不变',
  );
  // 真实引擎与 trace recorder 接线；纯 mock 模式不访问外部服务。
  const { handleMessage } = await import('./core/engine/index.js');
  const { onTurnEnd } = await import('./trace/recorder.js');
  let blockTrace: import('./trace/recorder.js').FinishedTurn | undefined;
  const offTrace = onTurnEnd((turn) => {
    blockTrace = turn;
  });
  try {
    const reply = await handleMessage('web:blocks-trace', 'HS1000 3件', 'web');
    assert.equal(blockTrace!.turn.blocks!.rendered[0]!.name, '试算明细', '18 trace.turn.blocks 接线');
    assert.deepEqual(blockTrace!.turn.blocks!.finalShape, { lines: replyLineCount(reply.text), chars: replyCharCount(reply.text) });
  } finally {
    offTrace();
  }
  console.log('18 价格块：三模板、自动附后、无效/重复/被删占位符、整段抑制/局部保留、30行预算、档位、接受订单与最终形状通过');
} finally {
  Date.now = realNow;
  config.__configTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
