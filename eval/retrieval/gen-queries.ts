import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Part } from '../../src/packs/industrial/catalog.js';
import { normalizePartNo } from '../../src/packs/industrial/normalize.js';

export type QueryType = 'exact' | 'alias' | 'prefix' | 'attributes' | 'descriptive' | 'colloquial' | 'absent' | 'broad';
export interface Selector {
  ids?: string[];
  category?: string;
  name?: string;
  specs?: string[];
  prefix?: string;
  absent?: boolean;
}
export interface Query {
  id: string;
  type: QueryType;
  text: string;
  category?: string;
  relevant: string[];
  source: 'generated' | 'handwritten';
}
export interface Handwritten {
  id: string;
  type: QueryType;
  text: string;
  category?: string;
  where: Selector;
}
/** 真值只读生成器字段，不依赖被测分词、属性解析或匹配器。 */
export function selectRelevant(parts: readonly Part[], where: Selector): string[] {
  if (where.absent) return [];
  return parts
    .filter(
      (part) =>
        (!where.ids || where.ids.includes(part.id)) &&
        (!where.category || part.category === where.category) &&
        (!where.name || part.name === where.name) &&
        (!where.specs || where.specs.every((spec) => part.specs.includes(spec))) &&
        (!where.prefix || normalizePartNo(part.partNo).startsWith(normalizePartNo(where.prefix))),
    )
    .map((part) => part.id);
}
/** 两端都校验：评测不能悄悄接受旧口径或错误标注的查询文件。 */
export function validateQueryCardinality(queries: readonly Query[]): void {
  for (const query of queries) {
    const count = query.relevant.length;
    if (new Set(query.relevant).size !== count) throw new Error(`相关集合有重复 id：${query.id}`);
    if (['attributes', 'descriptive', 'colloquial'].includes(query.type) && (count < 1 || count > 5))
      throw new Error(`定向查询相关条目必须为 1–5：${query.id}`);
    if (query.type !== 'broad' && count > 5) throw new Error(`相关条目超过 5 的查询必须标 broad：${query.id}`);
    if (query.type === 'broad' && count <= 5) throw new Error(`broad 相关条目必须超过 5：${query.id}`);
    if (query.type === 'absent' && count !== 0) throw new Error(`absent 的相关集合必须为空：${query.id}`);
  }
}
export function generateQueries(parts: readonly Part[], handwritten: readonly Handwritten[], samples = 80): Query[] {
  const queries: Query[] = [];
  const add = (type: QueryType, text: string, where: Selector, category?: string) => {
    const relevant = selectRelevant(parts, where);
    const focused = ['attributes', 'descriptive', 'colloquial'].includes(type);
    if ((focused && !relevant.length) || (type === 'broad' && relevant.length <= 5)) return;
    queries.push({
      id: `generated-${queries.length}`,
      source: 'generated',
      type: relevant.length > 5 ? 'broad' : type,
      text,
      ...(category ? { category } : {}),
      relevant,
    });
  };
  for (let i = 0; i < Math.min(samples, parts.length); i++) {
    const part = parts[Math.floor((i * parts.length) / Math.min(samples, parts.length))]!;
    const prefix = part.partNo.split('-')[0]!;
    const numerical = part.specs.filter((spec) => /\d/.test(spec) && !spec.startsWith('系列'));
    add('exact', i % 2 ? part.partNo.toLowerCase().replace('-', ' ') : `型号 ${part.partNo}`, { ids: [part.id] });
    add('alias', part.aliases![0]!, { ids: [part.id] });
    add('prefix', prefix, { prefix });
    add('attributes', `${prefix}系列 ${part.name} ${numerical.join(' ')}`, { name: part.name, prefix, specs: numerical }, part.category);
    add('descriptive', `想找${prefix}系列、${part.specs[2]!.replace('用途', '')}用的${part.name}，${part.specs[1]}`, {
      name: part.name,
      prefix,
      specs: [part.specs[1]!, part.specs[2]!],
    });
    const broadWhere =
      i % 3 === 0 ? { name: part.name } : i % 3 === 1 ? { name: part.name, specs: [part.specs[2]!] } : { category: part.category };
    const broadText =
      i % 3 === 0 ? `想找${part.name}` : i % 3 === 1 ? `${part.specs[2]!.replace('用途', '')}用的${part.name}` : `有没有${part.category}`;
    add('broad', broadText, broadWhere);
    add(
      'colloquial',
      `麻烦找个${prefix}系列的${part.name.replace('轴承', '轴成').replace('螺栓', '罗栓').replace('电磁', '电兹')}，${numerical[0] ?? ''}的有没`,
      { name: part.name, prefix, specs: numerical.slice(0, 1) },
      i % 2 ? part.category : undefined,
    );
    add('absent', i % 2 ? `ZZZ${900000 + i}QQ` : `量子传送器${i}号`, { absent: true });
  }
  for (const item of handwritten) {
    const relevant = selectRelevant(parts, item.where);
    if (!relevant.length && !item.where.absent) throw new Error(`手写真值为空：${item.id}`);
    queries.push({
      id: item.id,
      type: item.type,
      text: item.text,
      ...(item.category ? { category: item.category } : {}),
      relevant,
      source: 'handwritten',
    });
  }
  validateQueryCardinality(queries);
  if (new Set(queries.map((q) => q.id)).size !== queries.length) throw new Error('重复 query id');
  return queries;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = process.argv[2] ?? 'var/retrieval/catalog.json';
  const out = process.argv[3] ?? 'var/retrieval/queries.json';
  const parts = JSON.parse(fs.readFileSync(catalog, 'utf8')) as Part[];
  const handwritten = JSON.parse(fs.readFileSync(new URL('./queries.handwritten.json', import.meta.url), 'utf8')) as Handwritten[];
  const queries = generateQueries(parts, handwritten);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(queries, null, 2) + '\n');
  console.log(`QUERIES: ${queries.length} (${handwritten.length} handwritten) -> ${out}`);
}
