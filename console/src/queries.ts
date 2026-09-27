// 几处共用同一份缓存的查询（React Query 的 queryKey 与取数函数写在一处）：
// - 产品库列表：列表页、侧栏的条目数、⌘K 的「各实体」组（spec「外壳 · 搜索触发器」：和列表页共用缓存）；
// - 会话计数与等人接手的首页：侧栏软徽标、铃铛（spec「外壳 · 计数刷新」），总览第 4 步接着用；
// - 最近 100 个会话：⌘K 的「会话」组。
// ⌘K 自己不负责刷新：列表归侧栏和列表页刷新，⌘K 打开时只取还没载入的（paletteListQuery、paletteConversationsQuery）
import { queryOptions } from '@tanstack/react-query';
import type { CatalogKind } from '../../src/shared/catalog.js';
import { api, unwrap } from './api.js';

export const catalogListQuery = (kind: CatalogKind) =>
  queryOptions({
    queryKey: ['catalog', kind] as const,
    queryFn: () => unwrap(api.catalog[':kind'].$get({ param: { kind } })),
  });

/**
 * 产品库的一条（详情页）。键接在列表的键后面：改了这一类的任何一条，按 ['catalog', kind] 让列表失效时它也跟着失效。
 * 匿名得到的是线上快照里的那一条（没有状态、更新人），库里没有的 404
 */
export const catalogItemQuery = (kind: CatalogKind, code: string) =>
  queryOptions({
    queryKey: ['catalog', kind, code] as const,
    queryFn: () => unwrap(api.catalog[':kind'][':code'].$get({ param: { kind, code } })),
  });

export const conversationCountsQuery = queryOptions({
  queryKey: ['conversations', 'counts'] as const,
  queryFn: () => unwrap(api.conversations.counts.$get()),
});

export const waitingConversationsQuery = queryOptions({
  queryKey: ['conversations', 'human'] as const,
  queryFn: () => unwrap(api.conversations.$get({ query: { state: 'human' } })),
});

/** ⌘K 只搜这一页（spec：`GET /conversations?limit=100&order=waiting_first`，按短码匹配） */
export const RECENT_CONVERSATIONS = 100;
export const recentConversationsQuery = queryOptions({
  queryKey: ['conversations', 'recent'] as const,
  queryFn: () => unwrap(api.conversations.$get({ query: { limit: String(RECENT_CONVERSATIONS), order: 'waiting_first' } })),
});

/**
 * ⌘K 里各实体列表的观察者：只在打开时启用，已经有数据就不再取（spec「⌘K 第一次打开时把还没载入的实体取一遍」）。
 * React Query 默认 staleTime 0，启用一次就重取一次；匿名访客的查询按 IP 限流，每开一次 ⌘K 都重取会白白用掉额度
 */
export const paletteListQuery = (kind: CatalogKind, open: boolean) => ({ ...catalogListQuery(kind), enabled: open, staleTime: Infinity });

/** 最近 100 个会话只有 ⌘K 用：只给成员，打开时取；30 秒内（与计数轮询同一个间隔）再打开不重取 */
export const PALETTE_CONVERSATIONS_STALE = 30_000;
export const paletteConversationsQuery = (open: boolean) => ({
  ...recentConversationsQuery,
  enabled: open,
  staleTime: PALETTE_CONVERSATIONS_STALE,
});
