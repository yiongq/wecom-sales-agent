import type { TurnToolCall as ToolCall } from '../../core/pack-api.js';

/** 本轮 search_routes 什么也没返回（每次都是空数组）。destinationMiss 的结果带着替代线路，不是空的 */
export function retrievalEmpty(calls: readonly ToolCall[]): boolean {
  const searches = calls.filter((c) => c.name === 'search_routes' && typeof c.result === 'string');
  return (
    searches.length > 0 &&
    searches.every((c) => {
      try {
        const rows: unknown = JSON.parse(c.result!);
        return Array.isArray(rows) && rows.length === 0;
      } catch {
        return false;
      }
    })
  );
}
