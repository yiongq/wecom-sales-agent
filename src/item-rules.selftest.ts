import assert from 'node:assert/strict';
import { z } from 'zod';
import { checkItem, withItemRules, type EntityType, type ItemRule } from './shared/pack.js';

const entity = (rule: ItemRule): EntityType => ({
  kind: 'sample',
  label: '样例',
  icon: 'box',
  codeLabel: '编号',
  codeExample: 's',
  titleKey: 'a',
  subtitleKeys: [],
  groups: [{ key: 'base', label: '样例' }],
  lockGroups: {},
  fields: ['a', 'b', 'c'].map((key) => ({ key, label: key, type: 'intUnit', group: 'base', required: false })),
  itemRules: [rule],
  list: { columns: ['a'], filters: [], search: ['a'], defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '上架',
});
const cases: [ItemRule, Record<string, number>[], Record<string, number>[]][] = [
  [
    { kind: 'ascending', keys: ['a', 'b', 'c'] },
    [{}, { a: 1, c: 3 }, { a: 1, b: 2, c: 3 }],
    [
      { a: 2, c: 2 },
      { a: 3, b: 2 },
    ],
  ],
  [
    { kind: 'descending', keys: ['a', 'b', 'c'] },
    [{}, { a: 3, c: 1 }, { a: 3, b: 2, c: 1 }],
    [
      { a: 2, c: 2 },
      { a: 1, b: 2 },
    ],
  ],
  [
    { kind: 'greaterThan', key: 'b', other: 'a' },
    [{}, { a: 1 }, { b: 1 }, { a: 1, b: 2 }],
    [
      { a: 2, b: 2 },
      { a: 2, b: 1 },
    ],
  ],
  [{ kind: 'together', keys: ['a', 'b', 'c'] }, [{}, { a: 0, b: 2, c: 3 }], [{ a: 1 }, { a: 1, c: 3 }]],
  [{ kind: 'contiguous', keys: ['a', 'b', 'c'] }, [{}, { a: 0 }, { a: 0, b: 2 }, { a: 1, b: 2, c: 3 }], [{ b: 1 }, { a: 1, c: 3 }]],
];
let count = 0;
for (const [rule, pass, fail] of cases) {
  const e = entity(rule);
  const schema = withItemRules(
    z.strictObject({
      a: z.number().int().nonnegative().optional(),
      b: z.number().int().nonnegative().optional(),
      c: z.number().int().nonnegative().optional(),
    }),
    e,
  );
  for (const [values, expected] of [
    [pass, true],
    [fail, false],
  ] as const)
    for (const payload of values) {
      const check = checkItem(e, payload);
      const parsed = schema.safeParse(payload);
      assert.equal(parsed.success, expected, JSON.stringify({ rule, payload }));
      assert.equal(check.required.length === 0, expected);
      if (!parsed.success)
        assert.deepEqual(
          parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          check.required.map(({ path, message }) => ({ path, message })),
        );
      count++;
    }
}
console.log(`ITEM RULES PASS: 五种规则 ${count} 个正反例，schema / checkItem 一致`);
