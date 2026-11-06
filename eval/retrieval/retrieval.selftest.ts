import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateCatalog } from './gen-catalog.js';
import { generateQueries, validateQueryCardinality, type Handwritten, type Query } from './gen-queries.js';
import { fakeEmbed, fakeCosine } from './fake-embed.js';
import { metrics, runEvaluation, markdown } from './run.js';
const parts = generateCatalog(80);
assert.deepEqual(parts, generateCatalog(80));
assert.notDeepEqual(parts, generateCatalog(80, 123));
assert.equal(new Set(parts.map((p) => p.category)).size, 4);
assert.equal(new Set(parts.map((p) => p.name)).size, 8);
const hand = JSON.parse(fs.readFileSync(new URL('./queries.handwritten.json', import.meta.url), 'utf8')) as Handwritten[];
assert.ok(hand.length >= 60);
const full = generateQueries(generateCatalog(), hand);
assert.equal(new Set(full.map((q) => q.type)).size, 8);
assert.equal(full.filter((q) => q.source === 'handwritten').length, hand.length);
for (const type of ['attributes', 'descriptive', 'colloquial']) {
  const selected = full.filter((q) => q.type === type);
  assert.ok(selected.length >= 60, `${type} 保留原有量级`);
  assert.ok(selected.every((q) => q.relevant.length >= 1 && q.relevant.length <= 5));
  assert.ok(selected.some((q) => q.source === 'handwritten'));
}
assert.ok(full.filter((q) => q.type === 'broad').every((q) => q.relevant.length > 5));
// 小规模离线跑数；宽泛手写条件的基数按 5000 条库定义，已在 full 上核验。
const queries = generateQueries(
  parts,
  hand.filter((q) => q.type !== 'broad'),
  16,
);
assert.equal(new Set(queries.map((q) => q.type)).size, 8);
assert.deepEqual(full, generateQueries(generateCatalog(), hand));
assert.deepEqual(fakeEmbed('内径25mm'), fakeEmbed('内径25mm'));
assert.ok(Math.abs(fakeCosine(fakeEmbed('轴承'), fakeEmbed('轴承')) - 1) < 1e-12);
assert.equal(fakeCosine(fakeEmbed(''), fakeEmbed('')), 0);
assert.throws(() => fakeEmbed('a', 0));
const query: Query = { id: 'metric', source: 'generated', type: 'attributes', text: 'a', relevant: [parts[0]!.id, parts[1]!.id] };
const m = metrics([
  { query, result: { match: 'ambiguous', parts: [parts[2]!, parts[1]!] }, ms: 2, modelFallback: false },
  { query: { ...query, id: 'empty', relevant: [] }, result: { match: 'none', parts: [] }, ms: 8, modelFallback: false },
]);
assert.equal(m.truncatedRecall5, 0.5);
assert.equal(m.precision5, 0.25, '逐查询宏平均：1/2 和空返回0的平均');
assert.equal(m.mrr5, 0.5);
assert.equal(m.relevantCountMedian, 1);
assert.equal(m.relevantCountMax, 2);
assert.equal(m.emptyRate, 0.5);
assert.equal(m.p50Ms, 2);
assert.equal(m.p95Ms, 8);
const noResults = metrics([{ query, result: { match: 'none', parts: [] }, ms: 1, modelFallback: false }]);
assert.equal(noResults.truncatedRecall5, 0);
assert.equal(noResults.precision5, 0);
assert.equal(noResults.mrr5, 0);
// 算术独立校验 min(5,N)；实际查询文件会把 >5 的集合强制归入 broad。
const twenty = { ...query, type: 'prefix' as const, relevant: parts.slice(0, 20).map((p) => p.id) };
const five = { match: 'ambiguous' as const, parts: parts.slice(0, 5) };
assert.equal(metrics([{ query: twenty, result: five, ms: 1, modelFallback: false }]).truncatedRecall5, 1);
const broad = { ...twenty, type: 'broad' as const };
const wide = metrics([{ query: broad, result: five, ms: 1, modelFallback: false }]);
assert.equal(wide.truncatedRecall5, null);
assert.equal(wide.mrr5, null);
assert.equal(wide.precision5, 1);
assert.equal(wide.relevantCountMedian, 20);
assert.equal(wide.relevantCountMax, 20);
const mixed = metrics([
  { query, result: { match: 'ambiguous', parts: [parts[2]!, parts[1]!] }, ms: 2, modelFallback: false },
  { query: broad, result: five, ms: 1, modelFallback: false },
]);
assert.equal(mixed.truncatedRecall5, 0.5, 'broad 不混进截断 recall/MRR 汇总');
assert.equal(mixed.mrr5, 0.5);
assert.equal(mixed.precision5, 0.75);
assert.ok(!Object.hasOwn(mixed, 'recall5'), '报告不再暴露旧 recall 字段');
assert.throws(() => validateQueryCardinality([twenty]), /必须标 broad/);
assert.throws(() => validateQueryCardinality([{ ...query, relevant: [] }]), /1–5/);
assert.throws(() => validateQueryCardinality([{ ...query, type: 'broad' }]), /超过 5/);
await assert.rejects(runEvaluation({ matcher: 'hybrid', embed: 'fake', parts, queries: [twenty] }), /必须标 broad/);
const wrong = metrics([
  { query: { ...query, text: 'ZZZ999' }, result: { match: 'ambiguous', parts: [parts[0]!] }, ms: 1, modelFallback: true },
]);
assert.equal(wrong.wrongModelRate, 1);
assert.equal(metrics([]).truncatedRecall5, null);
assert.equal(metrics([]).precision5, null);
await assert.rejects(runEvaluation({ matcher: 'hybrid', embed: 'real', parts, queries }), /仅预留/);
for (const matcher of ['current', 'hybrid'] as const) {
  const report = await runEvaluation({ matcher, embed: 'fake', parts, queries });
  assert.equal(report.overall.wrongModelRate, 0);
  assert.equal(report.byType.exact!.truncatedRecall5, 1);
  assert.equal(report.byType.alias!.truncatedRecall5, 1);
  assert.match(markdown(report), /recall@5/);
}
console.log(
  'RETRIEVAL EVAL PASS: 种子/Schema/四类八子类/唯一编号、64手写真值、定向1–5/broad分流、截断recall/precision/MRR手算、基数统计、两种真实匹配器/real接口拒绝',
);
