import assert from 'node:assert/strict';
import { buildKeywordIndex, bm25, rrf, tokenize } from './retrieval-hybrid.js';
const normalize = (text: string) => text.toUpperCase().replace(/[\s_/-]/g, '');
assert.deepEqual(tokenize('密封轴承 M8-30 DC24V', normalize), ['密封', '封轴', '轴承', 'M830', 'DC24V']);
assert.deepEqual(tokenize('Ｍ８＿３０', normalize), ['M830']);
const index = buildKeywordIndex(
  [
    { id: 'a', text: '密封轴承 内径25mm' },
    { id: 'b', text: '轴承 轴承 内径30mm' },
    { id: 'c', text: '气缸' },
  ],
  normalize,
);
assert.equal(bm25(index, ['密封', '轴承'], new Set(['a', 'b']))[0]?.id, 'a');
assert.deepEqual(bm25(index, ['密封'], new Set(['b'])), []);
assert.deepEqual(bm25(index, ['密封'], new Set()), []);
assert.deepEqual(bm25(index, ['不存在'], new Set(['a', 'b'])), []);
// 独立手算：只剩一个候选时，df=1、dl=avgdl，tf=1，得 ln(1+0.5/1.5)。
assert.ok(Math.abs(bm25(index, ['密封'], new Set(['a']))[0]!.score - Math.log(4 / 3)) < 1e-12);
const rank = rrf(
  [
    [
      { id: 'a', score: 100 },
      { id: 'b', score: 0.1 },
    ],
    [
      { id: 'b', score: 1 },
      { id: 'c', score: 0 },
    ],
  ],
  (a, b) => a.localeCompare(b),
);
assert.equal(rank[0]!.id, 'b');
assert.equal(rank[0]!.score, 1 / 62 + 1 / 61);
assert.deepEqual(
  rrf(
    [
      [
        { id: 'a', score: 9 },
        { id: 'a', score: 8 },
        { id: 'b', score: 7 },
      ],
    ],
    () => 0,
  ).map((x) => x.score),
  [1 / 61, 1 / 62],
);
assert.deepEqual(
  rrf([[{ id: 'a', score: 9 }], [{ id: 'b', score: 9 }]], (a, b) => b.localeCompare(a)).map((x) => x.id),
  ['b', 'a'],
);
console.log('RETRIEVAL HYBRID PASS: 分词、候选BM25/手算、空结果、RRF k=60、去重与同分');
