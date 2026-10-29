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
import { writeState } from './packs/industrial/state.js';
import type { ReplyGuardContext, TurnContext, LineOrder } from './core/pack-api.js';
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
  unitPrice: 10,
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
    const result = preModel(context(text))!;
    assert.equal(result.fixedId, `industrial.${key}`);
    assert.ok(result.handoff);
    assert.ok(runtime.fixedReplies!.find((fixed) => fixed.id === result.fixedId));
  }
  const twenty = Array.from({ length: 20 }, (_, i) => `HS${1000 + i} 2件`).join('\n');
  assert.equal(inquiryLines(twenty).length, 20);
  assert.equal(preModel(context(twenty)), null);
  assert.equal(preModel(context(twenty)), null);
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
  const confirm = () => preModel(context('确认下单'));
  const confirmedOrder = () => {
    const notify = confirm()?.notify;
    assert.equal(notify?.reason, 'quote_accepted');
    assert.ok(notify?.reason === 'quote_accepted');
    return notify.orderId;
  };
  assert.equal(confirmedOrder(), orders[1]!.id);
  for (const text of ['还没确认下单', '不要确认下单', '可以下单吗？', '是否就按这个', '先别确认报价'])
    assert.equal(preModel(context(text)), null);
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
  console.log('工业预取：品名夹在中间/无单位/×、多行、精确未给数量查、否定与年份不算数量、重复与未决走旧路、进行中询价只整份重算通过');

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
} finally {
  Date.now = realNow;
  config.__configTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
