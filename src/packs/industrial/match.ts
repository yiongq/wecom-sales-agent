import { buildKeywordIndex, bm25, rrf, tokenize, type PackSources } from '../../core/pack-api.js';
import { buildAttributes, parseAttributes, filterAttributes } from './attributes.js';
import { PartSchema, type Part } from './catalog.js';
import { normalizePartNo } from './normalize.js';

export type PartMatch = { match: 'exact' | 'ambiguous' | 'none'; parts: Part[] };
const result = (parts: Part[], exact: boolean): PartMatch => ({
  match: parts.length === 0 ? 'none' : exact && parts.length === 1 ? 'exact' : 'ambiguous',
  parts: parts
    .toSorted((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || (a.partNo < b.partNo ? -1 : a.partNo > b.partNo ? 1 : 0))
    .slice(0, 5),
});
/** 型号外的每个字都须由该条目的名称、规格或单位解释；不能只取搜索结果第一名。 */
function describedPart(normalized: string, parts: readonly Part[]): Part | null {
  const mentioned = parts.filter((part) =>
    [part.partNo, ...(part.aliases ?? [])].map(normalizePartNo).some((model) => model && normalized.includes(model)),
  );
  if (mentioned.length !== 1) return null;
  const part = mentioned[0]!;
  const words = [
    part.partNo,
    ...(part.aliases ?? []),
    part.name,
    ...part.specs,
    // 「强度8.8级」「内径25mm」允许省略属性名，但不能拆出任意数字碎片。
    ...part.specs.map((spec) => spec.replace(/^\p{Script=Han}+/u, '')),
    part.unit,
    '件',
    '个',
    '只',
    '套',
    '米',
    '千克',
    '盒',
    'pcs',
  ]
    .map(normalizePartNo)
    .filter(Boolean);
  const ends = new Set([0]);
  for (let i = 0; i < normalized.length; i++) {
    if (!ends.has(i)) continue;
    for (const word of words) if (normalized.startsWith(word, i)) ends.add(i + word.length);
  }
  return ends.has(normalized.length) ? part : null;
}
/** 已装载快照上的路径，不查库；语义候选不能当作精确型号。 */
export function matchInMemory(query: string, parts: readonly Part[]): PartMatch {
  const normalized = normalizePartNo(query);
  if (!normalized) return result([], false);
  const direct = parts.filter((part) => normalizePartNo(part.partNo) === normalized);
  if (direct.length) return result(direct, true);
  const aliases = parts.filter((part) => part.aliases?.some((alias) => normalizePartNo(alias) === normalized));
  if (aliases.length) return result(aliases, true);
  const described = describedPart(normalized, parts);
  if (described) return result([described], true);
  // 品名只允许从两端去掉，且只重试全等；系列与语义回退仍用整串。
  const model = normalized.replace(/^\p{Script=Han}+|\p{Script=Han}+$/gu, '');
  if (model && model !== normalized) {
    const directModel = parts.filter((part) => normalizePartNo(part.partNo) === model);
    if (directModel.length) return result(directModel, true);
    const modelAliases = parts.filter((part) => part.aliases?.some((alias) => normalizePartNo(alias) === model));
    if (modelAliases.length) return result(modelAliases, true);
  }
  return result(normalized.length >= 4 ? parts.filter((part) => normalizePartNo(part.partNo).startsWith(normalized)) : [], false);
}
export function createCurrentMatcher(sources: Pick<PackSources, 'currentCatalog' | 'indexReady' | 'semanticRecall'>) {
  return async (query: string, category?: string): Promise<PartMatch> => {
    const parts = (sources.currentCatalog().items.part ?? [])
      .map((item) => PartSchema.parse(item))
      .filter((part) => !category || part.category === category);
    const memory = matchInMemory(query, parts);
    if (memory.match !== 'none' || !sources.indexReady()) return memory;
    const recalled = await sources.semanticRecall(query, 5);
    const ids = new Set((recalled ?? []).map((hit) => hit.id));
    const normalized = normalizePartNo(query);
    // 无命中的纯型号不能被语义最近邻换成另一型号；单位规格须有条目规格的字面支持。
    const modelLike = /^[A-Z0-9×]+$/.test(normalized) && /\d/.test(normalized);
    return result(
      parts.filter((part) => ids.has(part.id) && (!modelLike || part.specs.some((spec) => normalizePartNo(spec).includes(normalized)))),
      false,
    );
  };
}

/** 只弱引用当前目录快照；换代后旧快照及其两个派生索引可一起回收，不强引用租户。 */
const snapshots = new WeakMap<readonly unknown[], ReturnType<typeof buildSnapshot>>();
function buildSnapshot(items: readonly unknown[]) {
  const parts = items.map((item) => PartSchema.parse(item));
  const keyword = buildKeywordIndex(
    parts.map((p) => ({ id: p.id, text: [p.partNo, p.name, p.category, ...p.specs, ...(p.aliases ?? [])].join(' ') })),
    normalizePartNo,
  );
  return { parts, keyword, attributes: buildAttributes(parts) };
}
export function createMatcher(sources: Pick<PackSources, 'currentCatalog' | 'semanticScores'>) {
  return async (query: string, category?: string): Promise<PartMatch> => {
    const items = sources.currentCatalog().items.part;
    if (!items?.length || !normalizePartNo(query)) return result([], false);
    let snapshot = snapshots.get(items);
    if (!snapshot) {
      snapshot = buildSnapshot(items);
      snapshots.set(items, snapshot);
    }
    // 显式类目仍约束前三步；查询中识别出的类目仅作用于回退路径。
    const parts = snapshot.parts.filter((part) => !category || part.category === category);
    const memory = matchInMemory(query, parts);
    if (memory.match !== 'none') return memory;
    const attrs = parseAttributes(query, snapshot.attributes);
    const scoped = parts.filter((part) => !attrs.category || part.category === attrs.category);
    const filtered = filterAttributes(scoped, attrs, snapshot.attributes);
    let candidates = filtered.length ? filtered : scoped;
    const normalized = normalizePartNo(query);
    const modelLike = /^[A-Z0-9×]+$/.test(normalized) && /\d/.test(normalized);
    if (modelLike) candidates = candidates.filter((part) => part.specs.some((spec) => normalizePartNo(spec).includes(normalized)));
    if (!candidates.length) return result([], false);
    const byId = new Map(candidates.map((part) => [part.id, part]));
    const keywords = bm25(snapshot.keyword, tokenize(query, normalizePartNo), new Set(byId.keys()));
    const scores = (await sources.semanticScores?.(query, [...byId.keys()])) ?? null;
    const vectors = [...(scores ?? [])]
      .filter(([id, score]) => byId.has(id) && Number.isFinite(score))
      .map(([id, score]) => ({ id, score }))
      .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const fused = rrf([keywords, vectors], (a, b) => Number(byId.get(b)!.stock > 0) - Number(byId.get(a)!.stock > 0) || a.localeCompare(b));
    const hits = fused.slice(0, 5).map(({ id }) => byId.get(id)!);
    return { match: hits.length ? 'ambiguous' : 'none', parts: hits };
  };
}
