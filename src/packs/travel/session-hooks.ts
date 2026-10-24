// 08 R4：旅游的会话与画像钩子——今天核心里读旅游会话字段、画像字段的几处逻辑，原样搬进包里，核心改经 PackRuntime 的钩子取。
// 输出与搬走之前逐字节相同：会话标题与需求要素（shared/conversation 的 needSummary / needParts 加出发日与预算的规范化）、
// 工作台报价卡与排序金额（lastQuote）、交还 AI 时反推的阶段、沙箱种子的售后状态。
import {
  cleanText,
  needParts,
  SALES_SEGMENTS,
  type NeedVocabulary,
  type PackRuntime,
  type PackSources,
  type RefundQuote,
} from '../../core/pack-api.js';

/** 出发日期只认规范的 YYYY-MM-DD（引擎记画像时就是这个写法） */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createTravelSessionHooks(sources: Pick<PackSources, 'currentCatalog' | 'isConfigNotReadyError'>) {
  /**
   * 会话标题的词表：目的地取产品库 active 条目的 destination（调用时现读，不缓存）；客群取五个客群值，短标签就是客群值本身。
   * 配置还没装载完（宿主在没有产品库的作用域里列会话）时没有目的地词表，标题不带目的地，不抛错
   */
  const vocabulary = (): NeedVocabulary => {
    let destinations: string[] = [];
    try {
      destinations = [...new Set(sources.currentCatalog().routes.map((r) => r.destination))];
    } catch (error) {
      if (!sources.isConfigNotReadyError(error)) throw error;
    }
    return { destinations, segments: Object.fromEntries(SALES_SEGMENTS.map((k) => [k, k])) };
  };

  const profileView: PackRuntime['profileView'] = (profile) => {
    const parts = needParts(profile, vocabulary());
    const dates = typeof profile.dates === 'string' && ISO_DATE.test(profile.dates) ? profile.dates : null;
    const budgetRaw = typeof profile.budget === 'string' ? cleanText(profile.budget.trim(), 20) : '';
    const budget = budgetRaw || null;
    const rows = [
      { label: '目的地', value: parts.destination },
      { label: '客群', value: parts.segment },
      { label: '人数', value: parts.travelers },
      { label: '出行日期', value: dates },
      { label: '预算', value: budget },
    ].flatMap((r) => (r.value === null ? [] : [{ label: r.label, value: r.value }]));
    return {
      title: `${parts.destination ?? ''}${parts.segment ?? ''}${parts.travelers ?? ''}`,
      rows,
      need: { ...parts, dates, budget },
    };
  };

  const quoteCard: NonNullable<PackRuntime['quoteCard']> = (session) => {
    const q = session.lastQuote;
    if (!q) return null;
    return {
      title: q.routeTitle,
      amountFen: q.total == null ? null : Math.round(q.total * 100),
      lines: [`${q.travelers}人`, ...(q.departDate ? [`${q.departDate}出发`] : [])],
      quote: {
        routeId: q.routeId,
        routeTitle: q.routeTitle,
        travelers: q.travelers,
        perPerson: q.perPerson ?? null,
        total: q.total ?? null,
        departDate: q.departDate ?? null,
      },
    };
  };

  /** 交还 AI 时没有接管前阶段、也没付款：有订单 closing，有报价 quote，否则 discovery */
  const stageOnReturn: NonNullable<PackRuntime['stageOnReturn']> = (session) =>
    session.orderIds.length ? 'closing' : session.lastQuote ? 'quote' : 'discovery';

  /** 种子会话停在「等客户确认退款」时，把种子里的占位报价换成按已发布 policy 现算的退款报价 */
  const seedSession: NonNullable<PackRuntime['seedSession']> = (session, seed) => {
    if (session.afterSale?.step === 'confirm' && seed.refundQuote) {
      session.afterSale = { ...session.afterSale, quote: seed.refundQuote as RefundQuote };
    }
  };

  return { profileView, quoteCard, stageOnReturn, seedSession };
}
