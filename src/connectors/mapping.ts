// 11 R5：只计算映射，不读配置、不写库；包声明、条目和连接器由调用方传入。
import type { PackRuntime } from '../core/pack-api.js';
import type { ErpItemLink } from '../db/repo/erp.js';
import { ErpError, type ErpConnector } from './types.js';

export type MappingDeclaration = NonNullable<PackRuntime['erp']>;
export interface MappingItem {
  kind: string;
  code: string;
  status: string;
  payload: Readonly<Record<string, unknown>>;
}
export interface MappingInput {
  declaration: MappingDeclaration;
  items: readonly MappingItem[];
  connectorId: string;
  connector: ErpConnector;
  uom: Readonly<Record<string, number>>;
  existing: readonly ErpItemLink[];
  now?: () => number;
}
export interface MappingResult {
  mapped: string[];
  unmapped: string[];
  conflict: string[];
  unitMismatch: string[];
  links: ErpItemLink[];
  remove: string[];
}
function eligible(input: MappingInput): MappingItem[] {
  return input.items.filter((item) => item.kind === input.declaration.kind && ['active', 'draft'].includes(item.status));
}
function unitId(input: MappingInput, item: MappingItem): number | undefined {
  const unit = input.declaration.unit(item.payload);
  return Object.hasOwn(input.uom, unit) ? input.uom[unit] : undefined;
}

export async function autoMapProducts(
  input: MappingInput,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<MappingResult> {
  const remote = new Map<string, { id: number; code: string; uomId: number }[]>();
  for (let offset = 0; ; offset += 500) {
    if (offset) await sleep(1000);
    const page = await input.connector.products({ offset, limit: 500 });
    for (const product of page) {
      const key = input.declaration.remoteKey(product.code);
      const group = remote.get(key) ?? [];
      group.push(product);
      remote.set(key, group);
    }
    if (page.length < 500) break;
  }
  const result: MappingResult = { mapped: [], unmapped: [], conflict: [], unitMismatch: [], links: [], remove: [] };
  for (const item of eligible(input)) {
    // 运维指定的链接不被自动映射替换或删除。
    if (input.existing.some((link) => link.kind === item.kind && link.code === item.code && link.source === 'manual')) {
      result.mapped.push(item.code);
      continue;
    }
    const key = input.declaration.key(item.payload);
    const candidates = key === null ? [] : (remote.get(key) ?? []);
    result.remove.push(item.code);
    if (!candidates.length) result.unmapped.push(item.code);
    else if (candidates.length > 1) result.conflict.push(item.code);
    else if (candidates[0].uomId !== unitId(input, item)) result.unitMismatch.push(item.code);
    else {
      const product = candidates[0];
      result.mapped.push(item.code);
      result.links.push({
        connectorId: input.connectorId,
        kind: item.kind,
        code: item.code,
        remoteId: product.id,
        remoteCode: product.code,
        remoteUomId: product.uomId,
        source: 'auto',
        checkedAt: new Date((input.now ?? Date.now)()),
      });
    }
  }
  return result;
}

export async function manualMapProduct(input: MappingInput, code: string, remoteId: number): Promise<ErpItemLink> {
  const item = eligible(input).find((item) => item.code === code);
  if (!item || !Number.isSafeInteger(remoteId) || remoteId <= 0) throw new ErpError('invalid');
  const product = (await input.connector.stock([remoteId], (input.now ?? Date.now)() + 15_000)).get(remoteId);
  if (!product || !product.active) throw new ErpError('not_found');
  if (product.uomId !== unitId(input, item)) throw new ErpError('invalid');
  return {
    connectorId: input.connectorId,
    kind: item.kind,
    code,
    remoteId,
    remoteCode: '',
    remoteUomId: product.uomId,
    source: 'manual',
    checkedAt: new Date((input.now ?? Date.now)()),
  };
}

export function mappingToUnset(existing: readonly ErpItemLink[], kind: string, code: string): ErpItemLink {
  const link = existing.find((link) => link.kind === kind && link.code === code);
  if (!link) throw new ErpError('not_found');
  return link;
}
