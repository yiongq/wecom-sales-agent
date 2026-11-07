import assert from 'node:assert/strict';
import { buildAttributes, parseAttributes, filterAttributes } from './attributes.js';
import { PartSchema } from './catalog.js';
const part = (id: string, specs: string[], category = '轴承') =>
  PartSchema.parse({
    id,
    partNo: id,
    name: '合成',
    brand: '合成',
    category,
    specs,
    unit: '件',
    unitPrice: 1,
    moq: 1,
    stock: 1,
    leadDays: 1,
  });
const parts = [
  part('a', ['内径25mm', '外径52mm']),
  part('b', ['内径30mm', '外径25mm']),
  part('c', ['螺纹M8', '长度30mm'], '紧固件'),
  part('d', ['线圈DC24V', '防护IP65'], '低压电器'),
];
const vocab = buildAttributes(parts);
assert.deepEqual(parseAttributes('25mm', vocab).values, [], '无标签且多个键可解释时不猜');
assert.deepEqual(parseAttributes('内径 25mm', vocab).values, [{ key: '内径', value: '25MM' }]);
assert.deepEqual(parseAttributes('内径25 的', vocab).values, [{ key: '内径', value: '25MM' }]);
assert.deepEqual(parseAttributes('25 内径的轴承', vocab), { category: '轴承', values: [{ key: '内径', value: '25MM' }] });
assert.deepEqual(parseAttributes('内径 25mm 外径52mm', vocab).values, [
  { key: '内径', value: '25MM' },
  { key: '外径', value: '52MM' },
]);
assert.deepEqual(parseAttributes('内径25mm内径30mm', vocab).values, [], '同键冲突舍弃');
assert.deepEqual(parseAttributes('轴承和紧固件', vocab).category, undefined);
assert.deepEqual(parseAttributes('螺纹M8', vocab).values, [{ key: '螺纹', value: 'M8' }]);
assert.deepEqual(parseAttributes('DC24V IP65', vocab).values, [
  { key: '线圈', value: 'DC24V' },
  { key: '防护', value: 'IP65' },
]);
assert.deepEqual(parseAttributes('防护ＩＰ６５', vocab).values, [{ key: '防护', value: 'IP65' }]);
assert.deepEqual(parseAttributes('125mm M80 IP650 DC240V', vocab).values, [], '数值不允许部分命中');
assert.deepEqual(parseAttributes('内径25 mm', vocab).values, [{ key: '内径', value: '25MM' }]);
assert.deepEqual(parseAttributes('内径25mm 内径999mm', vocab).values, [], '已知与未知的冲突值也不猜');
assert.deepEqual(parseAttributes('内径999mm', vocab).values, [], '库里没有的值不当作可靠条件');
assert.deepEqual(
  filterAttributes(parts, parseAttributes('内径25mm', vocab), vocab).map((p) => p.id),
  ['a'],
);
const next = buildAttributes([part('new', ['内径80mm'])]);
assert.deepEqual(parseAttributes('内径25mm', next).values, [], '快照变化不保留旧词表');
console.log('ATTRIBUTES PASS: 数值/单位/螺纹/电压/防护/类目，歧义与冲突、边界、快照');
