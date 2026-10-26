// 行业包注册表（docs/features/console-ux/spec.md「行业包通用架构 · 放在哪里」）：从 packId（tenants.pack_id）查到界面配置。
// 用它的有三处：启动装载按租户的 pack_id 取包，查不到就拒绝启动；GET /api/console/pack 下发；tenant-create 的 --pack 只收这里有的。
// 加一个行业包：在 src/packs/<包>/console-pack.ts 写配置，登记到下面的 REGISTRY。公开仓库里的包名还要在
// scripts/check-public-boundary.ts 的白名单里（ADR-003 决策 4）。假包 src/shared/pack-fixtures/ 不进注册表（不变量 25）。
import {
  deepFreeze,
  type FieldDef,
  type IndustryPack,
  type QuickReplyDefault,
  type PackRuntime,
  type PackSources,
} from '../core/pack-api.js';
import { createTravelRuntime } from './travel/runtime.js';
import { sopConsistencyViolations } from './travel/consistency-sop.js';
import { fixture, createFixtureProofRuntime } from './__fixture/runtime.js';
import { travel } from './travel/console-pack.js';
import { travelQuickReplyDefaults } from './travel/quick-reply-defaults.js';

/** 只在注册表内部登记一致性检查，不扩大 PackRuntime 契约。 */
interface PackRegistration {
  pack: IndustryPack;
  runtime(sources: PackSources): PackRuntime;
  quickReplies: readonly QuickReplyDefault[];
  sopConsistency?: typeof sopConsistencyViolations;
}

/** 后台定义、运行时工厂、快捷回复与 SOP 检查始终从同一行取得。工厂在取包时才执行。 */
const REGISTRY: Readonly<Record<string, PackRegistration>> = deepFreeze({
  [travel.id]: {
    pack: travel,
    runtime: (sources: PackSources) => legacyTravelRuntime(sources).runtime,
    quickReplies: travelQuickReplyDefaults,
    sopConsistency: sopConsistencyViolations,
  },
  ...(process.env.PACK_FIXTURES === '1' ? { [fixture.id]: { pack: fixture, runtime: createFixtureProofRuntime, quickReplies: [] } } : {}),
});

function registrationOf(id: string): PackRegistration | null {
  return Object.hasOwn(REGISTRY, id) ? REGISTRY[id]! : null;
}

/** 注册的全部包 id，按登记顺序 */
export const PACK_IDS: readonly string[] = Object.freeze(Object.keys(REGISTRY));

/** 查不到返回 null。只认自有属性：'toString' 这类原型上的名字不算包 */
export function packById(id: string): IndustryPack | null {
  return registrationOf(id)?.pack ?? null;
}

/**
 * 行业包的快捷回复默认模板（02 spec「快捷回复管理」、plan 第 22 步）：新租户首次读到空表时按这份写入。
 * 只在服务端用，不随 GET /api/console/pack 下发；没配的包（包括没登记的包 id）返回空数组（spec「行业包没有就为空」）。
 */
export function defaultQuickRepliesOf(packId: string): readonly QuickReplyDefault[] {
  return registrationOf(packId)?.quickReplies ?? [];
}

let legacyTravel: ReturnType<typeof createTravelRuntime> | undefined;
/** 旧门面始终适配旧版旅游，不跟随测试里临时绑定的其他包。 */
export function legacyTravelRuntime(sources: PackSources): ReturnType<typeof createTravelRuntime> {
  return (legacyTravel ??= createTravelRuntime(sources));
}

/**
 * 08 R10：契约检查里话术与代码固定文字的一致性检查（违规码 consistency），按包给。
 * 包登记了含 'sop' 范围的 consistencyRules 才查（06 R21），没登记的包（证明包）不查，不再拿旅游的报价模板规则去比。
 */
export function sopConsistencyOf(runtime: Pick<PackRuntime, 'id' | 'consistencyRules'>): typeof sopConsistencyViolations | null {
  if (!runtime.consistencyRules?.some((rule) => rule.scope.includes('sop'))) return null;
  return registrationOf(runtime.id)?.sopConsistency ?? null;
}

/** 08 R2、R9：纯内存校验，不读配置、不改传入对象；失败点名包与 kind。 */
export function validatePackCatalog(
  pack: IndustryPack,
  runtime: Pick<PackRuntime, 'catalog'> & Partial<Pick<PackRuntime, 'priceLine' | 'stages'>>,
): void {
  if (runtime.priceLine && (!pack.stages.some((stage) => stage.terminal) || !runtime.stages?.some((stage) => stage.terminal))) {
    throw new Error(`行业包 ${pack.id} 声明了 priceLine，但没有终态阶段`);
  }
  const entityKinds = new Set(pack.entities.map((entity) => entity.kind));
  for (const kind of new Set([...entityKinds, ...Object.keys(runtime.catalog)])) {
    if (!entityKinds.has(kind) || !Object.hasOwn(runtime.catalog, kind)) {
      throw new Error(`行业包 ${pack.id} 的 kind ${kind} 在 entities 与 catalog 中不一致`);
    }
  }
  const moneyPaths = (fields: readonly FieldDef[], prefix = ''): { path: string; decimals: 0 | 2 }[] =>
    fields.flatMap((field) => {
      const path = prefix && field.key ? `${prefix}.${field.key}` : prefix + field.key;
      if (field.type === 'money') return [{ path, decimals: field.decimals ?? 0 }];
      return field.type === 'subItems' ? moneyPaths(field.item ?? [], `${path}[]`) : [];
    });
  for (const entity of pack.entities) {
    const declared = runtime.catalog[entity.kind]!.moneyFields;
    const expected = moneyPaths(entity.fields);
    if (
      declared.length !== expected.length ||
      expected.some(({ path, decimals }) => declared.filter((field) => field.path === path && field.decimals === decimals).length !== 1)
    ) {
      throw new Error(`行业包 ${pack.id} 的 kind ${entity.kind} 的 moneyFields 与 money 字段配置不一致`);
    }
  }
  const retrievalKinds = Object.keys(runtime.catalog).filter((kind) => runtime.catalog[kind]!.retrieval);
  if (retrievalKinds.length > 1) {
    throw new Error(`行业包 ${pack.id} 的 kind ${retrievalKinds.join('、')} 有多个 retrieval 为 true`);
  }
}

/** 后台定义与对话运行时按同一 id 配对；未登记的 id 永远不创建运行时。 */
export function runtimeById(id: string, sources: PackSources): PackRuntime | null {
  const registration = registrationOf(id);
  if (!registration) return null;
  const { pack } = registration;
  const runtime = registration.runtime(sources);
  if (
    runtime.id !== pack.id ||
    JSON.stringify(runtime.stages) !==
      JSON.stringify(pack.stages.map(({ key, terminal }) => ({ id: key, ...(terminal === undefined ? {} : { terminal }) })))
  ) {
    throw new Error(`行业包 ${id} 的后台与运行时阶段不一致`);
  }
  validatePackCatalog(pack, runtime);
  return runtime;
}
