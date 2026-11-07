import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PartSchema, type Part } from '../../src/packs/industrial/catalog.js';
import { normalizePartNo } from '../../src/packs/industrial/normalize.js';

/** 四个现有类目、八种子类型；子类型不扩展产品库枚举。 */
export function generateCatalog(count = 5000, seed = 1805): Part[] {
  if (!Number.isSafeInteger(count) || count < 8) throw new Error('count 至少为 8');
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const types = [
    ['BG', '轴承', '密封深沟球轴承'],
    ['TR', '轴承', '圆锥滚子轴承'],
    ['HB', '紧固件', '内六角螺栓'],
    ['HN', '紧固件', '六角螺母'],
    ['SV', '气动元件', '电磁阀'],
    ['CY', '气动元件', '气缸'],
    ['AC', '低压电器', '交流接触器'],
    ['CB', '低压电器', '小型断路器'],
  ] as const;
  const parts = Array.from({ length: count }, (_, i) => {
    const [prefix, category, name] = types[i % types.length]!;
    const row = Math.floor(i / types.length);
    const diameter = 5 + (row % 25) * 5;
    const variant = row % 5;
    const series = `${prefix}${String(Math.floor(row / 5)).padStart(3, '0')}`;
    const specs = [`子类型${name}`, `材质${row % 2 ? '不锈钢' : '碳钢'}`, `用途${row % 3 ? '通用设备' : '耐油设备'}`, `系列${series}`];
    if (category === '轴承') specs.push(`内径${diameter}mm`, `外径${diameter + 27}mm`);
    if (category === '紧固件') specs.push(`螺纹M${[4, 6, 8, 10, 12][variant]}`, `长度${10 + (row % 20) * 5}mm`);
    if (category === '气动元件') specs.push(`缸径${diameter}mm`, `行程${20 + (row % 20) * 10}mm`, `线圈${row % 2 ? 'DC24V' : 'AC220V'}`);
    if (category === '低压电器')
      specs.push(`线圈${row % 2 ? 'DC24V' : 'AC220V'}`, `额定电流${[6, 10, 16, 25, 32][variant]}A`, `防护IP${row % 2 ? 65 : 54}`);
    return PartSchema.parse({
      id: `part-${String(i).padStart(4, '0')}`,
      partNo: `${series}-${variant + 1}`,
      name,
      brand: '合成工业',
      category,
      specs,
      unit: '件',
      unitPrice: Math.round((1 + random() * 99) * 100) / 100,
      moq: 1,
      stock: random() < 0.2 ? 0 : Math.floor(random() * 500) + 1,
      leadDays: 7,
      aliases: [`${prefix}别称${String(row).padStart(4, '0')}`],
    });
  });
  const names = parts.flatMap((part) => [part.partNo, ...part.aliases!].map(normalizePartNo));
  if (new Set(names).size !== names.length) throw new Error('归一后的型号或别名撞车');
  return parts;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? 'var/retrieval/catalog.json';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(generateCatalog(), null, 2) + '\n');
  console.log(`CATALOG: 5000 parts -> ${out}`);
}
