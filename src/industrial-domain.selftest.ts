import './selftest-env.js';
import assert from 'node:assert/strict';
import {
  industrialReplyGuard,
  industrialFollowupGuard,
  INVENTORY_FALLBACK,
  NOTE_FALLBACK,
  PAYMENT_FALLBACK,
  PROMISE_FALLBACK,
} from './packs/industrial/guards.js';
import { defaultIndustrialPolicy, industrialPolicy } from './packs/industrial/policy.js';
import { policyView } from './config/sop.js';
import { fixedReplies } from './packs/industrial/fixed-replies.js';
import type { ReplyGuardContext } from './core/pack-api.js';
import { performance } from 'node:perf_hooks';
import { checkItem, checkPack, type PackSources, type Session } from './core/pack-api.js';
import { csvLabelsOf, prepareCatalogCsv, entityCsvShape, checkCsvRows, parseCatalogCsv, resolveCsvHeader } from './shared/catalog-csv.js';
import { PartSchema, partCatalog, priceLine, type Part } from './packs/industrial/catalog.js';
import { industrial, partEntity } from './packs/industrial/console-pack.js';
import { normalizePartNo } from './packs/industrial/normalize.js';
import { createMatcher, matchInMemory } from './packs/industrial/match.js';
import { StateSchema, writeState, draftParts } from './packs/industrial/state.js';
import { createIndustrialTools, projectRejections } from './packs/industrial/tools.js';
import { GUARD_DEMOS } from '../site/guard-demos.js';

const part: Part = {
  id: 'bearing-a',
  partNo: '6205-2RS',
  name: '深沟球轴承',
  brand: '合成品牌',
  category: '轴承',
  specs: ['内径 25 mm'],
  unit: '件',
  unitPrice: 10,
  moq: 2,
  tier2Qty: 10,
  tier2Price: 8,
  tier3Qty: 20,
  tier3Price: 6,
  tier4Qty: 40,
  tier4Price: 4,
  stock: 30,
  leadDays: 7,
  aliases: ['6205RS'],
  substitutes: [],
};
assert.deepEqual(checkPack(industrial), []);
assert.equal(PartSchema.safeParse(part).success, true);
assert.deepEqual(checkItem(partEntity, part).required, []);
for (const patch of [
  { tier2Qty: 2 },
  { tier3Qty: 10 },
  { tier3Price: 9 },
  { tier2Price: undefined },
  { tier3Qty: undefined, tier3Price: undefined },
  { unitPrice: 1.001 },
]) {
  const payload = { ...part, ...patch };
  assert.equal(PartSchema.safeParse(payload).success, false);
  assert.ok(checkItem(partEntity, payload).required.length > 0);
}
const csv =
  '零件编号,型号,品名,品牌,类别,规格,单位,基础单价,起订量,现货数量,交期天数\nb-a,6205-2RS,深沟球轴承,合成品牌,轴承,内径25mm、外径52mm,件,3.65,2,30,7';
const imported = prepareCatalogCsv('part', csv, csvLabelsOf(partEntity), PartSchema, 'industrial');
assert.equal(imported[0]!.unitPrice, 3.65);
assert.deepEqual(imported[0]!.specs, ['内径25mm', '外径52mm']);
const csvShape = entityCsvShape(partEntity);
const [header, ...body] = parseCatalogCsv(csv);
const columns = resolveCsvHeader(csvShape, header!, csvLabelsOf(partEntity));
assert.equal(checkCsvRows(csvShape, columns, body, (payload) => checkItem(partEntity, payload).required)[0]!.issues.length, 0);
for (const input of ['6205 2rs', '型号６２０５－２ｒｓ', '型6205_2rs', '6205/2rs']) assert.equal(normalizePartNo(input), '62052RS');
for (const input of ['M8x30', 'M8X30', 'M8*30', 'M8✕30', 'M8×30']) assert.equal(normalizePartNo(input), 'M8×30');
const parts = [
  part,
  { ...part, id: 'b', partNo: '6205-ZZ', stock: 0, aliases: [] },
  { ...part, id: 'c', partNo: '6205-OPEN', aliases: [] },
];
assert.equal(matchInMemory('6205 2rs', parts).match, 'exact');
assert.equal(matchInMemory('6205RS', parts).parts[0]!.id, part.id);
assert.deepEqual(
  matchInMemory('6205', parts).parts.map((value) => value.partNo),
  ['6205-2RS', '6205-OPEN', '6205-ZZ'],
);
assert.equal(matchInMemory('620', parts).match, 'none');
assert.equal(matchInMemory('zzzz', parts).match, 'none');
const many = Array.from({ length: 7 }, (_, i) => ({ ...part, id: `b${i}`, partNo: `6205-${i}`, aliases: [] }));
assert.equal(matchInMemory('6205', many).parts.length, 5);
// R3 终验：整串优先，去两端汉字只重试型号 / 别名全等，不扩大同系列范围。
const bolt = { ...part, id: 'bolt', partNo: 'M8×30', aliases: ['BOLT8'] };
const namedParts = [...parts, bolt];
for (const [input, id] of [
  ['M8×30 螺栓', bolt.id],
  ['螺栓 M8×30', bolt.id],
  ['6205-2RS轴承', part.id],
  ['型号6205-2RS的轴承', part.id],
  ['轴承6205RS', part.id],
  ['6205RS轴承', part.id],
  ['螺栓 BOLT8', bolt.id],
]) {
  const found = matchInMemory(input!, namedParts);
  assert.equal(found.match, 'exact', input);
  assert.equal(found.parts[0]!.id, id, input);
}
for (const input of ['M9×30 螺栓', '轴承6205', '轴承', '25 内径的深沟球轴承', '6205轴承2RS'])
  assert.equal(matchInMemory(input, namedParts).match, 'none', input);
const whole = { ...part, id: 'whole', partNo: '合成型号', aliases: ['M8×30螺栓'] };
assert.equal(matchInMemory('M8×30 螺栓', [...namedParts, whole]).parts[0]!.id, whole.id, '整串别名优先于去品名后的型号');
const aliasConflict = { ...part, id: 'alias-conflict', partNo: 'OTHER', aliases: ['M8×30'] };
assert.equal(matchInMemory('M8×30 螺栓', [...namedParts, aliasConflict]).parts[0]!.id, bolt.id, '去品名后型号优先于别名');
const recalledQueries: string[] = [];
const matcher = createMatcher({
  currentCatalog: () => ({ ...snapshot, items: { part: namedParts } }),
  indexReady: () => true,
  semanticRecall: async (query) => {
    recalledQueries.push(query);
    return [{ id: part.id }] as Awaited<ReturnType<PackSources['semanticRecall']>>;
  },
});
const snapshot: ReturnType<PackSources['currentCatalog']> = {
  tenantId: 'synthetic',
  generation: 0,
  items: { part: parts },
  routes: [],
  hotels: [],
  versions: Object.fromEntries(parts.map((p) => [`part:${p.id}`, 1])),
};
assert.equal((await matcher('M8×30 螺栓')).match, 'exact');
assert.deepEqual(recalledQueries, [], '精确匹配不调知识库');
for (const query of ['25 内径的深沟球轴承', 'M9×30 螺栓', '轴承6205']) {
  const found = await matcher(query);
  assert.equal(found.match, 'ambiguous', '原有语义候选仍不能变为精确匹配');
  assert.equal(recalledQueries.at(-1), query, '知识库收到整串原文');
}
assert.equal((await matcher('M9×30')).match, 'none', '不存在的纯型号仍不得换成邻近型号');
assert.deepEqual(partCatalog.crossItemCheck!(part, snapshot), []);
for (const [payload, field] of [
  [{ ...part, id: 'other', partNo: '6205 2rs' }, 'partNo'],
  [{ ...part, id: 'other', partNo: '6300', aliases: ['6205RS'] }, 'aliases'],
  [{ ...part, substitutes: ['missing'] }, 'substitutes'],
] as const)
  assert.ok(partCatalog.crossItemCheck!(payload, snapshot).some((issue) => issue.path === field));
for (const [qty, fen] of [
  [2, 1000],
  [9, 1000],
  [10, 800],
  [19, 800],
  [20, 600],
  [39, 600],
  [40, 400],
  [1000000, 400],
]) {
  const priced = priceLine(part, qty!);
  assert.ok(!('reject' in priced));
  assert.equal(priced.unitPriceFen, fen);
}
assert.deepEqual(priceLine(part, 1), { reject: 'below_moq', detail: { moq: 2 } });
for (const [stock, expected] of [
  [100, '现货'],
  [3, '现货 3 件，其余约 7 天'],
  [0, '约 7 天'],
] as const)
  assert.equal(priceLine({ ...part, stock }, 10).attrs?.['交期'], expected);
for (const qty of [0, 1.5, 1000001, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => priceLine(part, qty));
let saves = 0;
const sources = {
  currentCatalog: () => snapshot,
  catalogVersionKey: (kind: string, code: string) => `${kind}:${code}`,
  catalogItemAt: () => null,
  configMode: () => 'file',
  indexReady: () => false,
  semanticRecall: async () => null,
  saveSession: () => {
    saves++;
  },
} as unknown as PackSources;
const session = { packState: {}, messages: [], orderIds: [] } as unknown as Session;
const ctx = { session, hints: {}, text: '', args: {}, notes: {}, handoffDeclined: false };
const tools = createIndustrialTools(sources);
assert.deepEqual(
  tools.map((tool) => [tool.sideEffects, tool.cacheable, tool.blocksRetry]),
  [
    [['session'], false, false],
    [['session'], false, false],
    [['session', 'order', 'notify'], false, true],
    [['session', 'handoff', 'notify'], false, true],
  ],
);
assert.equal(tools.filter((tool) => tool.sideEffects.length === 0).length, 0);
const find = JSON.parse(await tools[0]!.execute({ query: '6205RS' }, ctx));
assert.equal(find.match, 'exact');
assert.deepEqual(
  tools[0]!.amounts!(JSON.stringify(find), {}).map((entry) => entry.fen),
  [1000, 800, 600, 400],
);
const result = JSON.parse(await tools[1]!.execute({ items: Array.from({ length: 30 }, () => ({ query: '6205 2rs', qty: 10 })) }, ctx));
assert.equal(result.lines.length, 30);
assert.equal(result.total, 2400);
assert.equal(result.unmatched, 0);
assert.ok(result.lines.every((line: { unitPrice: number; amount: number }) => line.unitPrice === 8 && line.amount === 80));
assert.equal(tools[1]!.amounts!(JSON.stringify(result), {}).at(-1)!.fen, 240000);
const draft = structuredClone(session.packState);
assert.deepEqual(JSON.parse(await tools[1]!.execute({ items: Array.from({ length: 31 }, () => ({ query: '6205 2rs', qty: 10 })) }, ctx)), {
  error: 'too_many_lines',
  limit: 30,
});
assert.deepEqual(session.packState, draft);
const mixed = JSON.parse(
  await tools[1]!.execute(
    {
      items: [
        { query: '6205RS', qty: 1 },
        { query: '6205', qty: 10 },
        { query: 'unknown', qty: 1 },
        { query: '6205RS', qty: 1000001 },
      ],
    },
    ctx,
  ),
);
assert.deepEqual(
  mixed.lines.map((line: { note: string }) => line.note),
  ['below_moq', 'ambiguous', 'none', 'over_max'],
);
assert.equal(mixed.total, undefined);
assert.ok(mixed.lines.every((line: object) => !('unitPrice' in line) && !('amount' in line)));
assert.equal(saves, 3);
const rejected = ['empty_lines', 'kind_unknown', 'item_inactive', 'invalid_qty', 'below_moq'].map((reason, i) => ({
  code: i ? `p${i}` : '',
  reason,
  detail: { moq: 2, secret: 'internal' },
}));
assert.deepEqual(
  projectRejections(rejected),
  rejected.map(({ code, reason }) => ({ code, reason, ...(reason === 'below_moq' ? { moq: 2 } : {}) })),
);
for (const bad of [
  { code: 'x', reason: 'unknown' },
  { code: 'x', reason: 'below_moq' },
  { code: 'x', reason: 'below_moq', detail: { moq: 0 } },
])
  assert.throws(() => projectRejections([bad]));
const maxDraft = {
  at: Number.MAX_SAFE_INTEGER,
  lines: Array.from({ length: 30 }, () => ({
    code: 'a'.repeat(64),
    version: Number.MAX_SAFE_INTEGER,
    qty: Number.MAX_SAFE_INTEGER,
    match: 'exact' as const,
  })),
};
writeState(session, {
  rfqDraft: maxDraft,
  lastQuoteId: `ord_${'a'.repeat(24)}`,
  confirmedQuoteAt: Number.MAX_SAFE_INTEGER,
  partsInPlay: [],
});
const mandatory = structuredClone(session.packState);
assert.ok(Buffer.byteLength(JSON.stringify(mandatory)) <= 6144);
writeState(
  session,
  {},
  Array.from({ length: 101 }, (_, i) => ({ partNo: `合成${i}\\"\n`, specs: ['规格'.repeat(60)] })),
);
assert.ok(Buffer.byteLength(JSON.stringify(session.packState)) <= 10240);
assert.ok(StateSchema.parse(session.packState).partsInPlay!.length <= 100);
writeState(session, {}, [{ partNo: '超长'.repeat(10000), specs: ['\\"\n'.repeat(10000)] }]);
assert.deepEqual(session.packState, mandatory);
writeState(session, { rfqDraft: { at: 1, lines: [{ code: part.id, version: 1, qty: 2, match: 'exact' }] } });
assert.equal(draftParts(session, sources)[0]!.partNo, part.partNo);
assert.deepEqual(draftParts(session, { ...sources, configMode: () => 'db' }), []);
for (const line of [
  { match: 'exact', qty: 1 },
  { match: 'none', code: 'a', qty: 1 },
  { match: 'exact', code: 'a', version: 0, qty: 1 },
  { match: 'none', qty: 0 },
])
  assert.equal(StateSchema.safeParse({ rfqDraft: { at: 1, lines: [line] } }).success, false);
const forty = Array.from({ length: 40 }, (_, i) => ({
  ...part,
  id: `item-${i}`,
  partNo: `6205-${String(i).padStart(2, '0')}`,
  aliases: [`alias${i}`],
}));
const samples: number[] = [];
for (let n = 0; n < 1000; n++) {
  const start = performance.now();
  for (let i = 0; i < 30; i++) {
    const found = matchInMemory(i % 3 === 0 ? forty[i]!.partNo : i % 3 === 1 ? `alias${i}` : '6205', forty);
    for (const item of found.parts) priceLine(item, 10);
  }
  samples.push(performance.now() - start);
}
const p95 = samples.toSorted((a, b) => a - b)[949]!;
assert.ok(p95 <= 50, `p95=${p95}`);
console.log(`INDUSTRIAL MEMORY PASS: 40条 / 30行 / 1000批 p95=${p95.toFixed(3)}ms; ${process.version} ${process.platform}/${process.arch}`);
console.log(
  `INDUSTRIAL DOMAIN PASS: 产品规则、CSV、匹配、档位、四工具声明与金额、拒绝映射、容量与历史读取；必留摘要 ${Buffer.byteLength(JSON.stringify(mandatory))} 字节`,
);

// 16 第 5 步：承诺护栏的对客契约，主回复替换、跟进只删。
const promiseSession = { packState: {}, messages: [], orderIds: [] } as unknown as Session;
let promisePolicy = structuredClone(defaultIndustrialPolicy);
const promiseSources = { ...sources, currentPolicy: () => ({ policy: promisePolicy }) } as unknown as PackSources;
async function guardPromise(text: string, followup: boolean): Promise<string> {
  const events: string[] = [];
  const context = {
    session: promiseSession,
    text,
    inputText: '',
    policy: promisePolicy,
    toolSources: [],
    recordGuard: (id: string) => events.push(id),
  } as unknown as ReplyGuardContext;
  const result = await (followup ? industrialFollowupGuard(promiseSources) : industrialReplyGuard(promiseSources)).run(context);
  const output = result?.action === 'pass' ? text : result && 'text' in result ? result.text : '';
  assert.deepEqual(events, output === text ? [] : ['industrial_claims'], text);
  return output;
}
const unsafePromises = [
  // 折扣：汉字 / 数字 / 小数与每个承诺入口。
  '给您打九折。',
  '这批打9折。',
  '可以打8.5折。',
  '享受九折优惠。',
  '给您折扣。',
  '这单让利。',
  '给您抹零。',
  '可以再优惠。',
  '这单再减10元。',
  '可以便宜10元。',
  '还能再便宜10元。',
  '优惠20元。',
  '这单免运费。',
  '给您包邮。',
  '运费全免。',
  '运费我们出。',
  '不收运费。',
  '满100元包邮。',
  '赠送配件。',
  '附赠配件。',
  '送您配件。',
  '这么做就送您配件。',
  '送一个配件。',
  '搭赠配件。',
  '返点。',
  '返利。',
  '返现。',
  '按阶梯价再减10元。',
  '量大的话可以打九折。',
  '如果今天下单可以包邮。',
  '若是现在下单就送您配件。',
];
const safePromises = [
  '不能打折。',
  '9折这样的额外折扣我这边给不了。',
  '我这边无法自行调整或承诺额外折扣。',
  '没法再打九折。',
  '不会赠送配件。',
  '不打九折。',
  '不打9折。',
  '没有额外折扣。',
  '不包邮。',
  '能打折吗',
  '能打折吗？',
  '能不能免运费？',
  '是否赠送配件？',
  '赠送配件以顾问确认为准。',
  '打九折以顾问确认为准。',
  '免运费需要顾问确认。',
  '赠送配件请顾问确认。',
  '如果包邮的话请确认。',
  '不赠送配件。',
  '不返现。',
  '无额外优惠。',
  '不提供折扣。',
  '不再优惠。',
  '买到100件走阶梯价，单价8元。',
  '数量达到档位即可按档价执行。',
  '数量档位由工具核算。',
  '这批走阶梯优惠价。',
  '这档价格比基础价低。',
  PROMISE_FALLBACK,
];
for (const followup of [false, true]) {
  for (const text of unsafePromises) assert.equal(await guardPromise(text, followup), followup ? '' : PROMISE_FALLBACK, text);
  for (const prefix of ['价格按档位执行', '不能打折'])
    assert.equal(await guardPromise(`${prefix}但送您配件。`, followup), `${prefix}${followup ? '' : PROMISE_FALLBACK}`);
  for (const text of safePromises) assert.equal(await guardPromise(text, followup), text, text);
  assert.equal(await guardPromise('打九折，免运费。送您配件。返现。', followup), followup ? '' : PROMISE_FALLBACK);
  assert.equal(
    await guardPromise('请确认数量。打九折。需要正式报价单吗？', followup),
    `请确认数量。${followup ? '' : PROMISE_FALLBACK}需要正式报价单吗？`,
  );
  // feeFen=0 本身不能授权模型承诺免运费。
  assert.equal(await guardPromise('满额免运费。', followup), followup ? '' : PROMISE_FALLBACK);
  promisePolicy.shipping = { freeOverFen: 10000, feeFen: 1000 };
  for (const text of ['满额包邮。', '满100元免运费。', '满100.00元包邮。', '满 100 元包邮。', '达到包邮门槛后免运费。'])
    assert.equal(await guardPromise(text, followup), text, text);
  for (const text of ['满50元包邮。', '未满100元也包邮。', '这单免运费。', '满100元包邮并送您配件。', '满100元包邮并打九折。'])
    assert.equal(await guardPromise(text, followup), followup ? '' : PROMISE_FALLBACK, text);
  promisePolicy = structuredClone(defaultIndustrialPolicy);
}
const promiseFixed = fixedReplies.find((reply) => reply.id === 'industrial.promise')!;
assert.ok(promiseFixed);
assert.deepEqual(promiseFixed.producedBy, { pipeline: 'reply', step: 'industrial_claims' });
for (const sample of await promiseFixed.samples()) assert.equal(sample.text, PROMISE_FALLBACK);
console.log(
  `INDUSTRIAL PROMISE PASS: ${unsafePromises.length}条违规、${safePromises.length}条放行，主回复/跟进、整条去重、政策门槛与固定句登记通过`,
);

// 16 报告复核：对的库存交期和有效期不被换掉，运费和付款说法按政策纠正，括号不被切坏。
const quoted = (partNo: string, delivery: string) => ({
  name: 'quote_items',
  args: {},
  result: JSON.stringify({ lines: [{ partNo, delivery }] }),
});
const found = (partNo: string, stock: string, leadDays: number) => ({
  name: 'find_parts',
  args: {},
  result: JSON.stringify({ parts: [{ partNo, stock, leadDays }] }),
});
async function guardClaim(text: string, toolSources: object[] = [], followup = false, inputText = ''): Promise<string> {
  const context = {
    session: promiseSession,
    text,
    inputText,
    policy: promisePolicy,
    toolSources,
    recordGuard: () => undefined,
  } as unknown as ReplyGuardContext;
  const result = await (followup ? industrialFollowupGuard(promiseSources) : industrialReplyGuard(promiseSources)).run(context);
  return result?.action === 'pass' ? text : result && 'text' in result ? result.text : '';
}
const partial = [quoted('6207-2RS', '现货 18 件，其余约 9 天')];
const spot = [found('M10×45', '现货', 8), quoted('M10×45', '现货')];
const fallback = `${INVENTORY_FALLBACK}。`;
for (const text of [
  '32件试算结果：\n现货情况：现货只有18件，不够32件全现货，其余约14件到货周期约9天。',
  '如果库存拆批不方便，也可以改成18件现货。',
  '现货18件，其余约9天。',
  '当前现货只有18件，其余14件约9天到货。',
])
  assert.equal(await guardClaim(text, partial), text, text);
for (const text of ['查到了，有现货：', '18件试算：单价1.35元，现货。', '现货，交期约8天。', '报价含税，款到发货，有效期7天。'])
  assert.equal(await guardClaim(text, spot), text, text);
for (const text of ['报价7天内有效。', '报价有效期至7天内。', '已批准且在有效期内（7天）。', '有效期：7天。', '报价单有效期为7天。'])
  assert.equal(await guardClaim(text), text, text);
// 放宽只放行有依据的说法：数字不对、依据缺失、客户问的是别的型号，都还是回退。
for (const [text, tools, input] of [
  ['有效期30天。', [], ''],
  ['现货20件。', partial, ''],
  ['全部现货。', partial, ''],
  ['交期约5天。', spot, ''],
  ['9天到货。', partial, ''],
  ['约5天到货。', partial, ''],
  ['其余约9天。', spot, ''],
  ['有现货。', [], ''],
  ['有现货。', spot, 'XR-9420-Q 有吗'],
] as const)
  assert.equal(await guardClaim(text, [...tools], false, input), fallback, text);
// 多个型号时，没点名型号的说法要对每个型号都成立。
assert.equal(await guardClaim('都有现货。', [...spot, ...partial]), fallback);
assert.equal(await guardClaim('都有现货。', [...spot, found('6205-2RS', '现货', 7)]), '都有现货。');

// 括号：整组说法不成立时只去括号，括号外的金额和正文留下，不留半边括号。
assert.equal(
  await guardClaim('确认这6行无误，或指出需要修改的行（例如「第3行改成 XR-9420-Q，3件」），我马上试算。'),
  '确认这6行无误，或指出需要修改的行，我马上试算。',
);
assert.equal(await guardClaim('试算结果（含税13%，现货）：'), `试算结果：${fallback}`);
assert.equal(await guardClaim('合计265.86元（含税13%，免运费），现货。'), `合计265.86元，${PROMISE_FALLBACK}${fallback}`);
assert.equal(await guardClaim('合计100元（现货）。', [], true), '合计100元。');

// 免责句：模型自己说过就不再补；同一条回复只补一次。
assert.equal(await guardClaim('有现货。交期约9天。库存与交期以顾问确认为准。'), '库存与交期以顾问确认为准。');
assert.equal(await guardClaim('有现货。交期约9天。需要报价单吗？'), `${fallback}需要报价单吗？`);

// 运费：政策固定 0 元时就地改回事实；有运费或门槛时「另计」是对的，不动。
for (const [text, expected] of [
  ['合计420.48元（含13%税，未含运费）。', '合计420.48元（含13%税，运费0元）。'],
  ['含税，不含运费。', '含税，运费0元。'],
  ['运费另计。', '运费0元。'],
  ['含税，运费另计为0元。', '含税，运费0元。'],
  ['运费按政策另计以实际结算为准。', '运费0元。'],
  ['运费另以顾问确认为准。', '运费0元。'],
])
  assert.equal(await guardClaim(text!), expected, text);
assert.equal(await guardClaim('合计420.48元（含税，不含运费）。', [], true), '合计420.48元。');
assert.equal(await guardClaim('运费另计。', [], true), '');
promisePolicy.shipping = { freeOverFen: 10000, feeFen: 1000 };
for (const followup of [false, true]) assert.equal(await guardClaim('运费另计。', [], followup), '运费另计。');
promisePolicy = structuredClone(defaultIndustrialPolicy);

// 付款：款进公司账户，不能让客户理解成付给顾问，也不能说报价单上有账户。
for (const text of [
  '请按报价单上的对公账户完成转账（款到发货）。',
  '款项付给我们的顾问账户。',
  '款项支付给顾问后安排发货。',
  '款项请付给顾问指定账户。',
  '请对公转账至顾问提供的账户。',
  '对公转账到顾问提供的收款账户即可。',
  '对公转账给销售顾问。',
  '对公转账支付622.08元到顾问提供的账户。',
  '直接转给顾问收款即可。',
  // 官网收款演示句，和转到、打到、汇到这组说法。
  '货款打给顾问就行。',
  '货款转到顾问的个人账户。',
  '把钱打给顾问就行。',
  '货款打到顾问账户。',
  '款项汇到顾问的账户。',
  '尾款转入顾问的银行卡。',
  '货款请直接汇给顾问。',
  '定金交给顾问就行。',
  '把款打给顾问。',
  '付款给顾问即可。',
  '打款到顾问账户。',
  '汇款至顾问提供的账户。',
  '请付622.08元给顾问。',
  '钱打到顾问提供的个人账户。',
  '货款打到顾问的个人微信。',
  '钱直接转顾问账户就好。',
  '货款打给顾问不用走公司账户。',
  '货款不用走对公直接打给顾问。',
  '如果着急可以把货款打给顾问。',
  // 顾问个人账户和个人收款，没有动词也不行。
  '用顾问个人账户收款。',
  '这是顾问的私人账户。',
  '收款人是顾问。',
  '货款转到个人账户。',
  '打到个人银行卡就行。',
  '钱转到私户。',
  '可以走对私转账。',
  '扫顾问的个人收款码付款。',
  // 模型自己报的账号：产品里没有账号，报出来的都是编的。
  '收款账户是 6222 0000。',
  '收款账户：工商银行 6222 0000 1234 5678。',
  '账号：622200001234。',
  '银行卡号 6222-0000-1234-5678。',
  '对公账户 1100 2233 4455。',
  '请汇款至 6222000012345678。',
  '货款转到 6222 0000。',
  '6222 0000 是我们的收款账户。',
  '支付宝 13800001234。',
]) {
  assert.equal(await guardClaim(text), PAYMENT_FALLBACK, text);
  assert.equal(await guardClaim(text, [], true), '', text);
}
for (const text of [
  '款到发货，对公转账。',
  '请对公转账至顾问提供的公司账户。',
  '款项支付给顾问吗？',
  '顾问会与您对接收款账户。',
  '款项由顾问收取确认后安排发货。',
  '转账到账后顾问会确认。',
  '需要我把您转给顾问收款吗？',
  '已转给顾问跟进。',
  PAYMENT_FALLBACK,
  '收款账户以顾问提供的公司账户为准',
  '由顾问线下收款。',
  '请和顾问确认收款方式。',
  // 公司账户不受牵连。
  '货款打到顾问提供的公司账户。',
  '款项汇到顾问提供的对公账户。',
  '货款转到公司账户。',
  '货款打到公司账户后顾问会安排发货。',
  '款项付给公司后顾问安排发货。',
  '收款账户为顾问提供的公司账户。',
  // 反问和否定。
  '货款要转到顾问的个人账户吗？',
  '难道要把钱打给顾问吗？',
  '收款账户是 6222 0000 吗？',
  '请不要把钱打给顾问个人账户。',
  '不要转到个人账户。',
  '货款不能转到顾问的个人账户。',
  '别把钱打给顾问。',
  '请勿向个人账户付款。',
  '款项不是付给顾问。',
  '顾问不会让您把钱打到个人账户。',
  '我们不收个人账户转账。',
  '货款不经任何个人账户。',
  '打到个人账户不安全。',
  '如有人要求转到个人账户请先核实。',
  '收款账户不是 6222 0000。',
  '6222 0000 不是我们的账户。',
  // 转接、打电话、发凭证，说的不是付钱。
  '有问题可以打给顾问。',
  '我帮您转到顾问那边。',
  '付款问题我转给顾问。',
  '付款的事转给顾问跟进。',
  '货款我帮您转给顾问核对。',
  '付款凭证发给顾问。',
  '付款后把水单发给顾问。',
  '付款后可以打给顾问确认。',
  '多少钱可以打给顾问问问。',
  '这里我汇报给顾问。',
  '付款到账后顾问确认发货。',
  '您可以加顾问个人微信。',
  // 金额、单号、型号里的数字不是账号。
  '合计125000元请转到顾问提供的公司账户。',
  '对公账户转账125000元。',
  '公司账户收到 125,000.00 元后发货。',
  '¥125000转到公司账户。',
  '报价单号 20261102001234。',
])
  assert.equal(await guardClaim(text), text, text);
// 商家在付款条款里发布的账号是事实；只放行这一个，模型换个号还是回退。
promisePolicy.paymentTerms = '款到发货，对公账户 1100 2233 4455';
assert.equal(await guardClaim('对公账户 1100 2233 4455。'), '对公账户 1100 2233 4455。');
assert.equal(await guardClaim('对公账户 1100 2233 4466。'), PAYMENT_FALLBACK);
promisePolicy = structuredClone(defaultIndustrialPolicy);
assert.equal(await guardClaim('款到发货，款项支付给顾问，款项付给我们的顾问账户。'), `款到发货，${PAYMENT_FALLBACK}`);
const paymentFixed = fixedReplies.find((reply) => reply.id === 'industrial.payment')!;
assert.deepEqual(paymentFixed.producedBy, { pipeline: 'reply', step: 'industrial_claims' });
for (const sample of await paymentFixed.samples()) assert.equal(sample.text, PAYMENT_FALLBACK);
// 官网写的是「护栏的真实输出」：演示句必须和真实护栏一致，改护栏时这里会先红。
const policyBeforeDemos = promisePolicy;
promisePolicy = structuredClone(defaultIndustrialPolicy);
for (const demo of GUARD_DEMOS) assert.equal(await guardClaim(demo.draft), demo.sent, demo.draft);
promisePolicy = policyBeforeDemos;
// 备注：系统没有这个动作，说记下了顾问也看不到。
for (const text of ['我已同步备注：32件等齐一起发货，', '备注已注明：32件整单一起发出。', '已在报价单上备注等齐发货。']) {
  assert.equal(await guardClaim(text), NOTE_FALLBACK, text);
  assert.equal(await guardClaim(text, [], true), '', text);
}
for (const text of ['需要备注的请告诉顾问。', '开票时请备注税号。', '已转给顾问跟进。']) assert.equal(await guardClaim(text), text, text);
assert.equal(await guardClaim('报价单已提交，顾问审核中。还有别的型号吗？', [], true), '还有别的型号吗？');
// 后台政策卡：工业包没有退改条款，要看到费用说明，退款两项是空而不是默认值。
const policyCard = policyView(defaultIndustrialPolicy, industrialPolicy)!;
assert.deepEqual(
  policyCard.clauses.map((clause) => clause.text),
  ['报价含税，税率13%', '运费0.00元', '库存与交期以顾问确认为准'],
);
assert.equal(policyCard.approvalThresholdYuan, null);
assert.equal(policyCard.selfService, null);
console.log('INDUSTRIAL CLAIMS PASS: 库存交期有效期放行与回退、括号、免责句去重、运费与付款说法，主回复和跟进都通过');
