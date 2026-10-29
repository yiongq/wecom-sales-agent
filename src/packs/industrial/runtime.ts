import {
  linkWhitelistStep,
  linkWhitelistFollowupStep,
  moneyProvenanceStep,
  moneyProvenanceFollowupStep,
  type ShapePolicy,
} from '../../core/pack-api.js';
import { createIntake } from './intake.js';
import { handoffVocab } from './handoff-vocab.js';
import { industrialReplyGuard, industrialFollowupGuard, rfqTrimStep, rfqTrimFollowupStep } from './guards.js';
import { IndustrialPolicySchema, quoteNotes } from './policy.js';
import { preModel, contextNote, prefetch, beforeTool } from './turn.js';
import { intakeNewer, intakeNotes } from './intake-turn.js';
import { sopSections, templates, contractRules, hardRequirements } from './sop.js';
import { fixedReplies, consistencyRules } from './fixed-replies.js';
import { followupTemplates, followupGate, insightPrompts, mock } from './auxiliary.js';
import { isComplaint, isHandoffIntent } from './handoff-intent.js';
// R1 / R17：公开工业包的完整运行时入口，也是部署镜像识别标记。
import { getAnyOrder, type PackRuntime, type PackSources, type Session, type SalesStage } from '../../core/pack-api.js';
import { industrial } from './console-pack.js';
import { partCatalog, MAX_QTY, PartSchema, priceLine } from './catalog.js';
import { StateSchema, readState, resetKeys } from './state.js';
import { createIndustrialTools } from './tools.js';
import { industrialPolicy } from './policy.js';
import { quoteCapabilities, quoteSiteLinks } from './quotes.js';
import { latestQuoteCandidate } from './quote-candidate.js';

const profileFields = [
  { key: 'company', label: '公司' },
  { key: 'deliveryCity', label: '交货城市' },
  { key: 'invoiceType', label: '开票类型' },
  { key: 'usage', label: '用途' },
];
export function createIndustrialRuntime(sources: PackSources): PackRuntime {
  const orders = (session: Session) =>
    session.orderIds.map(getAnyOrder).filter((order) => order && 'v' in order && order.sessionId === session.id);
  return {
    id: industrial.id,
    intake: createIntake(sources),
    catalog: { part: partCatalog },
    maxQty: MAX_QTY,
    priceLine,
    policy: industrialPolicy,
    quotes: quoteCapabilities(sources),
    siteLinks: quoteSiteLinks(),
    sessionState: { schema: StateSchema, resetKeys },
    profileFields,
    profileForPrompt(profile) {
      const attrs = Object.fromEntries(profileFields.flatMap(({ key }) => (profile.attrs?.[key] ? [[key, profile.attrs[key]]] : [])));
      return { ...(profile.notes?.length ? { notes: profile.notes } : {}), ...(Object.keys(attrs).length ? { attrs } : {}) };
    },
    profileView(profile) {
      const rows = profileFields.flatMap(({ key, label }) => (profile.attrs?.[key] ? [{ label, value: profile.attrs[key] }] : []));
      return { title: rows.map((row) => row.value).join(' · '), rows };
    },
    extractProfile(text) {
      const attrs = Object.fromEntries(
        profileFields.flatMap(({ key, label }) => {
          const value = new RegExp(`${label}[:：]\\s*([^\\n，。；]+)`).exec(text)?.[1]?.trim();
          return value ? [[key, value]] : [];
        }),
      );
      return Object.keys(attrs).length ? { attrs } : {};
    },
    stages: industrial.stages.map(({ key, terminal }) => ({ id: key as SalesStage, ...(terminal ? { terminal } : {}) })),
    advanceStage(session, turn) {
      if (turn.terminal) return session.stage;
      if (orders(session).some((order) => order && 'v' in order && order.status === 'paid')) return 'paid';
      // 本轮最后一次业务动作决定阶段；新试算不被上一份已批准报价拉回促成。
      for (const call of turn.calls.toReversed()) {
        if (!call.result) continue;
        let result: { state?: string; lines?: unknown[]; match?: string; parts?: { substitutes?: string[] }[] };
        try {
          result = JSON.parse(call.result);
        } catch {
          continue;
        }
        if (call.name === 'create_quote_sheet' && result.state === 'approved') return 'closing';
        if (call.name === 'create_quote_sheet' && result.state === 'pending') return 'quote';
        if (call.name === 'quote_items' && Array.isArray(result.lines)) return 'quote';
        if (call.name === 'find_parts' && (result.match === 'ambiguous' || result.parts?.some((part) => part.substitutes?.length)))
          return 'recommend';
      }
      const candidate = latestQuoteCandidate(session, Date.now());
      if (candidate) return candidate.kind === 'quote' && candidate.state === 'approved' ? 'closing' : 'quote';
      return session.stage === 'greeting' ? 'discovery' : session.stage;
    },
    onQuoteDecided: (_session, _order, event) =>
      event === 'approved' ? 'closing' : event === 'rejected' || event === 'withdrawn' ? 'quote' : null,
    preModel: (ctx) => preModel(ctx, sources),
    prefetch: (ctx) => prefetch(ctx, sources),
    beforeTool: (name, args, ctx) => beforeTool(name, args, ctx, sources),
    contextNote(ctx) {
      const state = readState(ctx.session);
      const policy = IndustrialPolicySchema.parse(ctx.policy ?? sources.currentPolicy().policy);
      return [
        ...contextNote(ctx),
        ...intakeNotes(ctx.session, ctx.text, sources),
        ...quoteNotes(policy),
        `付款条款：${policy.paymentTerms}；可开票种：${policy.invoice.join('、')}；报价有效期${policy.quoteValidDays}天`,
        // 12 R9：待确认的清单比试算更新时，只带清单摘要。
        ...(state.rfqDraft && !intakeNewer(ctx.session, Date.now()) ? [`询价摘要：${JSON.stringify(state.rfqDraft)}`] : []),
      ];
    },
    tools: createIndustrialTools(sources),
    money: { minimumAmount: 0.01, precisionTolerance: 0.5, decimals: true },
    defaultBrand: {
      brandName: '衡石工业品（虚构）',
      advisorTitle: '顾问',
      aiTitle: 'AI 询价顾问',
      scopeNoun: '工业品询价',
      identityLine: '我是衡石工业品的 AI 询价顾问',
    },
    legacy: {
      identityAnswer: '我是衡石工业品的 AI 询价顾问',
      offTopicReply: templates.offTopicReply,
      welcomeText: '您好，请告诉我型号和数量。',
      welcomeBackText: templates.welcomeBackText,
      webWelcome: '欢迎来到衡石工业品（虚构），请告诉我型号和数量。',
      mockOpening: templates.mockOpening,
      quickReplies: templates.quickReplies,
      hardRequirements,
      resetReply: '已重新开始',
      resetDisabledReply: '请告诉我新的需求',
      handoffFallback: '顾问会继续确认',
    },
    templates,
    sopSections,
    contractRules,
    fixedReplies,
    consistencyRules,
    knownFields: { names: industrial.entities[0]!.fields.map((field) => field.key), sourceFiles: ['src/packs/industrial/catalog.ts'] },
    replyAnchors: { markdown: 'industrial_claims', 'takeover_check:post': 'rfq_trim' },
    replySteps: [
      industrialReplyGuard(sources),
      { ...linkWhitelistStep(), after: ['shape_check'] },
      {
        ...moneyProvenanceStep({
          staticAmounts: (raw) => Object.values(IndustrialPolicySchema.parse(raw).shipping),
          fallback: '金额需要先试算，请告诉我型号和数量。',
        }),
        after: ['stage_advance', 'link_whitelist'],
      },
      rfqTrimStep(sources),
    ],
    followupSteps: [
      linkWhitelistFollowupStep(),
      industrialFollowupGuard(sources),
      {
        ...moneyProvenanceFollowupStep({ staticAmounts: (raw) => Object.values(IndustrialPolicySchema.parse(raw).shipping) }),
        after: ['industrial_claims'],
      },
      rfqTrimFollowupStep(sources),
    ],
    engineHooks: {
      isComplaint,
      isHandoffIntent,
      safetyNetKind: (_session, text) => (/退款|退钱|退费/.test(text) ? 'refund' : isComplaint(text) ? 'complaint' : 'request'),
      handoffReply: () => '顾问会继续确认',
      departNoteForHandoff: () => undefined,
      fallbackReply: () => '请告诉我型号和数量',
      hintsFor: () => ({}),
      withNotes: (text) => text,
      modelRequestedHandoff: (calls) => calls.some((call) => call.name === 'handoff_to_human'),
      retrievalEmpty: () => false,
      createOrderTool: null,
      resetSession() {},
      paidText: () => '付款已收到',
      quoteRejectedText: () => '这份报价需要顾问再核对一下，顾问会直接联系您',
      quoteWithdrawnText: () => '这份报价单已撤回，顾问会跟您重新确认',
    },
    vocab: { handoff: handoffVocab, dejargon: { english: {}, internal: [] } },
    thresholds: {
      shape: {
        richMaxLines: 12,
        plainMaxLines: 12,
        generatedListMaxLines: 12,
        maxChars: 600,
        richTools: ['find_parts', 'quote_items'],
        asksPrice: (text) => /价|多少钱/.test(text),
        isClosingTurn: (text) => /确认下单|就按这个|可以下单/.test(text),
        // 形状步骤只记录；所有实际删行交给 rfq_trim 统一计数。
        isRouteTitleLine: () => true,
        isClosingLine: () => false,
        proposalSent: () => false,
        droppable: () => null,
      } satisfies ShapePolicy,
    },
    retrievalItems: () => {
      const snapshot = sources.currentCatalog();
      return (snapshot.items.part ?? []).map((payload, ord) => ({
        kind: 'part',
        code: String((payload as Record<string, unknown>).id),
        ord,
        status: 'active' as const,
        rev: snapshot.versions[sources.catalogVersionKey('part', String((payload as Record<string, unknown>).id))] ?? 1,
        payload: payload as ReturnType<PackRuntime['retrievalItems']>[number]['payload'],
        updatedByName: null,
        updatedAt: '',
      }));
    },
    retrievalText: (item) => {
      const part = PartSchema.parse(item.payload);
      return [part.partNo, part.name, part.category, ...part.specs, ...(part.aliases ?? [])].join(' ');
    },
    retrievalCacheFile: 'industrial-vectors.json',
    evalGoalsDir: 'eval/sim/goals/industrial/quality',
    followupTemplates,
    followupGate,
    insightPrompts,
    mock,
    quoteCard(session) {
      const draft = readState(session).rfqDraft;
      return draft ? { title: '最近询价', amountFen: null, lines: [`${draft.lines.length} 项`] } : null;
    },
  };
}
