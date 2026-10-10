// 行业包注册表（docs/features/console-ux/spec.md「行业包通用架构 · 放在哪里」）：从 packId（tenants.pack_id）查到界面配置。
// 用它的有三处：启动装载按租户的 pack_id 取包，查不到就拒绝启动；GET /api/console/pack 下发；tenant-create 的 --pack 只收这里有的。
// 加一个行业包：在 src/packs/<包>/console-pack.ts 写配置，登记到下面的 PACKS。公开仓库里的包名还要在
// scripts/check-public-boundary.ts 的白名单里（ADR-003 决策 4）。假包 src/shared/pack-fixtures/ 不进注册表（不变量 25）。
import { deepFreeze, type IndustryPack, type QuickReplyDefault } from '../core/pack-api.js';
import { travel } from './travel/console-pack.js';
import { travelQuickReplyDefaults } from './travel/quick-reply-defaults.js';

/** 递归冻结：下发和渲染都读同一份，谁也不能原地改 */
const PACKS: Readonly<Record<string, IndustryPack>> = deepFreeze({ travel });

/** 注册的全部包 id，按登记顺序 */
export const PACK_IDS: readonly string[] = Object.freeze(Object.keys(PACKS));

/** 查不到返回 null。只认自有属性：'toString' 这类原型上的名字不算包 */
export function packById(id: string): IndustryPack | null {
  return Object.hasOwn(PACKS, id) ? PACKS[id]! : null;
}

/**
 * 行业包的快捷回复默认模板（02 spec「快捷回复管理」、plan 第 22 步）：新租户首次读到空表时按这份写入。
 * 只在服务端用，不随 GET /api/console/pack 下发；没配的包（包括没登记的包 id）返回空数组（spec「行业包没有就为空」）。
 */
const QUICK_REPLY_DEFAULTS: Readonly<Record<string, readonly QuickReplyDefault[]>> = deepFreeze({
  travel: travelQuickReplyDefaults,
});
export function defaultQuickRepliesOf(packId: string): readonly QuickReplyDefault[] {
  return Object.hasOwn(QUICK_REPLY_DEFAULTS, packId) ? QUICK_REPLY_DEFAULTS[packId]! : [];
}
