import type { PackSources } from '../../core/pack-api.js';
import { PartSchema, type Part } from './catalog.js';
import { normalizePartNo } from './normalize.js';

export type PartMatch = { match: 'exact' | 'ambiguous' | 'none'; parts: Part[] };
const result = (parts: Part[], exact: boolean): PartMatch => ({
  match: parts.length === 0 ? 'none' : exact && parts.length === 1 ? 'exact' : 'ambiguous',
  parts: parts
    .toSorted((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || (a.partNo < b.partNo ? -1 : a.partNo > b.partNo ? 1 : 0))
    .slice(0, 5),
});
/** 已装载快照上的路径，不查库；语义候选不能当作精确型号。 */
export function matchInMemory(query: string, parts: readonly Part[]): PartMatch {
  const normalized = normalizePartNo(query);
  if (!normalized) return result([], false);
  const direct = parts.filter((part) => normalizePartNo(part.partNo) === normalized);
  if (direct.length) return result(direct, true);
  const aliases = parts.filter((part) => part.aliases?.some((alias) => normalizePartNo(alias) === normalized));
  if (aliases.length) return result(aliases, true);
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
export function createMatcher(sources: Pick<PackSources, 'currentCatalog' | 'indexReady' | 'semanticRecall'>) {
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
