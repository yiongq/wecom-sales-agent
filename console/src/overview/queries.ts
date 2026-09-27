// 总览自己的几个查询（spec「总览」的数据表）。会话计数、等人接手的首页、各实体列表与外壳共用 queries.ts 里的同一份缓存，
// 这里不重复定义；话术概况的 queryKey 与话术页相同（['sop']），两边共用缓存，话术页保存、发布后作废它，总览跟着变
import { queryOptions } from '@tanstack/react-query';
import type { AuditEntryView, AuditPage } from '../../../src/shared/console-api.js';
import { auditActionsParam } from '../../../src/shared/ui-labels.js';
import { api, unwrap } from '../api.js';
import { enoughAudit } from './model.js';

/** GET /sop：成员拿到的是 SopOverview（带 spec 与 draft），匿名投影另是一种形状 */
export const sopQuery = queryOptions({
  queryKey: ['sop'] as const,
  queryFn: () => unwrap(api.sop.$get()),
});

/** 草稿的检查（只读，不改草稿）：按草稿与 rev 缓存，草稿一变就重新检查 */
export const draftCheckQuery = (draftId: string, rev: number) =>
  queryOptions({
    queryKey: ['sop', 'check', draftId, rev] as const,
    queryFn: () => unwrap(api.sop.draft.check.$post()),
  });

/** GET /status：系统状态一行 */
export const statusQuery = queryOptions({
  queryKey: ['status'] as const,
  queryFn: () => unwrap(api.status.$get()),
});

/** 最近一个已成交的会话：「已成交」格的明细（会话标签和日期） */
export const latestPaidQuery = queryOptions({
  queryKey: ['conversations', 'paid', 'latest'] as const,
  queryFn: () => unwrap(api.conversations.$get({ query: { state: 'paid', limit: '1' } })),
});

/** 每页取多少条审计、最多翻几页（一次 CSV 导入至多 200 行，合成一句也要取得完） */
const AUDIT_PAGE = 50;
const AUDIT_MAX_PAGES = 10;

/**
 * 「最近变更」：不含登录记录（auditActionsParam('all', false)）。连续的同类记录要合成一句（「新建了6条酒店草稿」），
 * 只取 5 条会把一次导入截在中间、合出来的条数不对，所以按页往前取，直到合出来的句子多于 5 句或没有更早的记录
 */
export const recentAuditQuery = queryOptions({
  queryKey: ['audit', 'recent'] as const,
  queryFn: async (): Promise<AuditEntryView[]> => {
    const actions = auditActionsParam('all', false);
    const entries: AuditEntryView[] = [];
    let before: number | null = null;
    for (let i = 0; i < AUDIT_MAX_PAGES; i += 1) {
      const page: AuditPage = await unwrap(
        api.audit.$get({
          query: { limit: String(AUDIT_PAGE), ...(actions ? { actions } : {}), ...(before === null ? {} : { before: String(before) }) },
        }),
      );
      entries.push(...page.items);
      if (enoughAudit(entries, page.nextBefore)) break;
      before = page.nextBefore;
    }
    return entries;
  },
});
