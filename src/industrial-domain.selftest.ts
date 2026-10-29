import './selftest-env.js';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { checkItem, checkPack, type PackSources, type Session } from './core/pack-api.js';
import { csvLabelsOf, prepareCatalogCsv, entityCsvShape, checkCsvRows, parseCatalogCsv, resolveCsvHeader } from './shared/catalog-csv.js';
import { PartSchema, partCatalog, priceLine, type Part } from './packs/industrial/catalog.js';
import { industrial, partEntity } from './packs/industrial/console-pack.js';
import { normalizePartNo } from './packs/industrial/normalize.js';
import { createMatcher, matchInMemory } from './packs/industrial/match.js';
import { StateSchema, writeState, draftParts } from './packs/industrial/state.js';
import { createIndustrialTools, projectRejections } from './packs/industrial/tools.js';

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
