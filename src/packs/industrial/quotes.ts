import {
  boundPack,
  getAnyOrder,
  quoteLinkAllowed,
  quoteValidUntil,
  orderDisplay,
  type PackRuntime,
  type PackSources,
} from '../../core/pack-api.js';
import { IndustrialPolicySchema, quoteNotes } from './policy.js';
import { PartSchema } from './catalog.js';
import { readState } from './state.js';

export function quoteCapabilities(sources: PackSources): NonNullable<PackRuntime['quotes']> {
  return {
    approval: true,
    validDays: (policy) => IndustrialPolicySchema.parse(policy).quoteValidDays,
    autoApprovable(order, session) {
      const policy = IndustrialPolicySchema.parse(sources.currentPolicy().policy);
      if (policy.autoApproveMaxFen <= 0 || order.totalFen > policy.autoApproveMaxFen) return false;
      const draft = readState(session).rfqDraft;
      const items = sources.currentCatalog().items.part ?? [];
      return order.lines.every((line) => {
        if (line.kind !== 'part' || !draft?.lines.some((entry) => entry.match === 'exact' && entry.code === line.code)) return false;
        const item = PartSchema.safeParse(items.find((value) => (value as Record<string, unknown>).id === line.code));
        if (sources.erp?.active('part')) {
          if (!item.success) return false;
          const value = sources.erp.fresh('part', item.data.id);
          return value !== undefined && value.onHand >= line.qty;
        }
        return item.success && item.data.stock >= line.qty;
      });
    },
    notes: (_order, policy) => quoteNotes(policy),
  };
}
export function quoteSiteLinks(): NonNullable<PackRuntime['siteLinks']> {
  const title = (path: string, session: Parameters<typeof quoteLinkAllowed>[0]) => {
    if (!quoteLinkAllowed(session, path)) return null;
    const order = getAnyOrder(path.slice('/quote/'.length));
    if (!order || !('v' in order)) return null;
    const binding = boundPack();
    const brand = binding?.brand ?? binding?.runtime.defaultBrand;
    return { order, title: `${brand?.brandName ?? '衡石工业品（虚构）'}报价单 · ${order.lines.length} 项` };
  };
  return [
    {
      linkKind: 'quote',
      pattern: /^\/quote\/ord_(?:[0-9a-f]{24}|seed_[0-9a-f]{16}-[0-9a-f]{24})$/,
      resources: [{ pattern: /^\/api\/quotes\/ord_(?:[0-9a-f]{24}|seed_[0-9a-f]{16}-[0-9a-f]{24})$/, methods: ['GET'] }],
      allowed: quoteLinkAllowed,
      partTitle: (path, session) => title(path, session)?.title ?? null,
      card(path, session) {
        const info = title(path, session);
        if (!info) return null;
        const date = new Date(quoteValidUntil(info.order) + 8 * 3600000);
        return {
          title: info.title,
          desc: `合计 ${orderDisplay(info.order).totalText} · 有效期至 ${date.getUTCMonth() + 1}月${date.getUTCDate()}日`,
        };
      },
    },
  ];
}
