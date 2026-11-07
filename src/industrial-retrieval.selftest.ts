import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { PackSources } from './core/pack-api.js';
import { PartSchema, type Part } from './packs/industrial/catalog.js';
import { createMatcher, createCurrentMatcher, matchInMemory } from './packs/industrial/match.js';
const demo = (JSON.parse(fs.readFileSync('data/packs/industrial/catalog/part.json', 'utf8')) as unknown[]).map((p) => PartSchema.parse(p));
let reads = 0;
let embeddings = 0;
let parts = demo;
let vector: ReadonlyMap<string, number> | null = null;
const sources = {
  currentCatalog: () => {
    reads++;
    return { items: { part: parts } } as unknown as ReturnType<PackSources['currentCatalog']>;
  },
  indexReady: () => false,
  semanticRecall: async () => {
    throw new Error('工业混合路径不应调用全局召回');
  },
  semanticScores: async (_query: string, ids: readonly string[]) => {
    embeddings++;
    return vector && new Map([...vector].filter(([id]) => ids.includes(id)));
  },
};
const hybrid = createMatcher(sources);
const legacy = createCurrentMatcher(sources);
for (const p of demo) {
  for (const q of [p.partNo, `型号 ${p.partNo}`, `轴承${p.partNo}`, ...(p.aliases ?? [])])
    assert.deepEqual(await hybrid(q), await legacy(q), q);
}
assert.equal(embeddings, 0, '精确/别名/去汉字/前缀不调embedding');
assert.deepEqual(await hybrid('6205'), matchInMemory('6205', demo));
assert.equal((await hybrid('ZZZ999999QQ')).match, 'none');
assert.equal(embeddings, 0, '无规格字面支持的纯型号直接拒绝');
const p = (id: string, partNo: string, name: string, specs: string[], category: string, stock = 1): Part =>
  PartSchema.parse({ id, partNo, name, specs, category, stock, brand: '合成', unit: '件', unitPrice: 1, moq: 1, leadDays: 1 });
parts = [
  p('a', 'AA01', '密封轴承', ['内径25mm', '外径52mm'], '轴承', 0),
  p('b', 'BB01', '密封轴承', ['内径30mm', '外径62mm'], '轴承'),
  p('c', 'CC01', '电磁阀', ['线圈DC24V'], '气动元件'),
];
vector = new Map([
  ['c', 100],
  ['a', 2],
  ['b', 1],
]);
let n = embeddings;
assert.deepEqual(
  (await hybrid('密封轴承 内径25mm')).parts.map((x) => x.id),
  ['a'],
  '类目/属性先过滤再算向量',
);
assert.equal(embeddings - n, 1);
const ranked = await hybrid('密封轴承', '轴承');
assert.equal(ranked.parts[0]!.id, 'a', '融合相关度胜过有货/字母排序');
assert.ok(ranked.parts.every((x) => x.category === '轴承'));
// 过滤成空时仅保留类目；a、b 均有但同一条不满足这两个属性。
assert.ok((await hybrid('轴承 内径25mm 外径62mm')).parts.length > 0);
vector = null;
n = embeddings;
assert.equal((await hybrid('内径25mm')).parts[0]!.id, 'a', '向量不可用时BM25仍服务');
assert.equal(embeddings - n, 1);
assert.equal((await hybrid('25mm')).parts[0]!.id, 'a', '纯型号外形的规格有字面支持时允许');
assert.equal((await hybrid('ZZ999')).match, 'none');
assert.equal((await hybrid('完全陌生词')).match, 'none', '无向量且关键词零分时不猜');
parts = [p('new', 'NEW01', '密封轴承', ['内径80mm'], '轴承')];
assert.equal((await hybrid('内径80mm')).parts[0]!.id, 'new', '快照替换后索引换代');
assert.equal((await hybrid('25mm')).match, 'none', '旧快照规格不可残留');
assert.equal((await hybrid('NEW01')).match, 'exact');
assert.ok(reads > 0, '只经同步快照能力读取，无库、模型依赖');
console.log(
  'INDUSTRIAL RETRIEVAL PASS: 演示精确/别名与原实现一致、候选过滤/空过滤回退、融合排序、BM25降级、纯型号保护、快照换代、每查询至多一次嵌入',
);
