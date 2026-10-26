// R1 / R17：公开工业包入口，也是部署镜像识别标记。后续 D / E 批补护栏、词表与发布配置。
import { getAnyOrder, type PackRuntime, type PackSources, type Session, type SalesStage } from '../../core/pack-api.js';
import { industrial } from './console-pack.js';
import { partCatalog, MAX_QTY, PartSchema, priceLine } from './catalog.js';
import { StateSchema, readState, resetKeys } from './state.js';
import { createIndustrialTools } from './tools.js';
import { industrialPolicy } from './policy.js';
import { quoteCapabilities, quoteSiteLinks } from './quotes.js';
import { latestQuoteCandidate } from './quote-candidate.js';

// 词表在 D 批按逐键表落地；骨架阶段不复用另一个行业包的运行时或话术。
function emptyHandoff(): PackRuntime['vocab']['handoff'] {
  const never = /(?!) /g;
  return {
    TRAD: {},
    TRAD_RE: never,
    COND: never,
    HEARSAY: never,
    PAST: never,
    PAST_CUT: never,
    HEARSAY_CUT: never,
    NOW_LEAD: never,
    ASKING_TAIL: never,
    ASKING_WORDS: never,
    NOT_A_QUESTION: never,
    NEG_BEFORE: never,
    E_ALTITUDE_MARKER: never,
    E_ALTITUDE_OVERLAP: never,
    EMERGENCY_RULES: [],
    CARELESS: never,
    E_HYPO: never,
    E_PRETRIP: never,
    E_NEAR: never,
    E_HABIT: never,
    E_PRICE: never,
    E_JOKE: never,
    E_POLICY: never,
    E_HEARSAY: never,
    E_NEG_BEFORE: never,
    E_UNSURE: never,
    E_EXAGGERATE: never,
    E_AFTER_SKIP: never,
    E_ATTACHED: never,
    E_HAPPENED_BEFORE: never,
    E_FEVER: never,
    E_NOW: never,
    E_ONGOING: never,
    E_FALL_HURT: never,
    E_FALL_THING: never,
    E_VEHICLE_STUCK: never,
    E_WOUND: never,
    E_FINE_AFTER: never,
    E_TRAPPED_AT: never,
    E_TRAPPED_ABSTRACT: never,
    E_NOT_STUCK: never,
    E_ELSEWHERE: never,
    E_RESCUE_LEAD: never,
    E_HELP: never,
    E_IDENTITY: never,
    E_GREETING: never,
    E_UNKNOWN: never,
    E_ASKING: never,
    E_EVERY: never,
    E_ARRANGE: never,
    COMPANION_PHRASE: never,
    COMPANION_MARK: '\u0000',
    PARTY_MENTION: never,
    OTHER_MENTION: never,
    NOT_SUBJECT_LEAD: never,
    FAMILY_LEAD: never,
    THIRD_PARTY: never,
    ASK_TAIL: never,
    EMBEDDED: never,
    DEPENDS_LEAD: never,
    ASK_WORDS: never,
    EVERY_AFTER: never,
    EVERY_ANOTA_AFTER: never,
    NOT_ASKING_REST: never,
    US: never,
    OWNED_BY_US: never,
    OWNED_KIND: never,
    SELF: never,
    OTHERS: never,
    OBJECT_LEAD: never,
    OTHER_AGENCY: never,
    JOKE: never,
    DOUBT_WORD: never,
    STRONG_DIRECTED: never,
    INSULT: never,
    STUPID: never,
    INSULT_TARGET_AFTER: never,
    INSULT_OBJECT: never,
    BARE_FILLER: never,
    BARE_INSULT: never,
    BROKEN: never,
    INTENSIFIER: never,
    WEAK: never,
    SLOW_PACE: never,
    WEAK_US_BEFORE: never,
    WEAK_RHETORICAL: never,
    REPEAT_SAID: never,
    PEOPLE: never,
    WEAK_DIRECTED: never,
    POSITIVE_BEFORE: never,
    WORRY_BEFORE: never,
    SEG_ASKING: never,
    COMPLAINT_TAG: never,
    ONLY_US: never,
    HEALTH: never,
    PERSON: never,
    CHILD_AGE_AFTER: never,
    CHILD_AGE_BEFORE: never,
    SCHOOL: never,
    CHILD_RE: never,
    WITHDRAW: [],
    POLITE_ASK: never,
    POLICY_ASK: never,
    NOT_WANTED: never,
  };
}
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
    contextNote: () => [],
    tools: createIndustrialTools(sources),
    money: { minimumAmount: 0.01, precisionTolerance: 0.5, decimals: true },
    defaultBrand: {
      brandName: '衡石工业品（虚构）',
      advisorTitle: '顾问',
      aiTitle: 'AI 询价顾问',
      scopeNoun: '工业品询价',
      identityLine: '我是衡石工业品的 AI 询价顾问',
    },
    // 发布话术与品牌模板在 E 批交付；此骨架不包含可发布的 SOP。
    legacy: {
      offTopicReply: '',
      welcomeText: '',
      welcomeBackText: '',
      webWelcome: '',
      mockOpening: '',
      quickReplies: [],
      hardRequirements: '',
      identityAnswer: '',
      resetReply: '已重新开始',
      resetDisabledReply: '请告诉我新的需求',
      handoffFallback: '顾问会继续确认',
    },
    templates: {
      hardRequirements: '',
      lockedSectionTemplates: {},
      identityAnswer: '{identityLine}',
      offTopicReply: '',
      welcomeText: '',
      welcomeBackText: '',
      webWelcome: '',
      mockOpening: '',
      quickReplies: [],
      preamble: '',
      pages: {},
    },
    sopSections: [],
    contractRules: () => [],
    knownFields: { names: industrial.entities[0]!.fields.map((field) => field.key), sourceFiles: ['src/packs/industrial/catalog.ts'] },
    replySteps: [],
    followupSteps: [],
    engineHooks: {
      isComplaint: () => false,
      isHandoffIntent: () => false,
      safetyNetKind: () => 'request',
      handoffReply: () => '顾问会继续确认',
      departNoteForHandoff: () => undefined,
      fallbackReply: () => '请告诉我型号和数量',
      hintsFor: () => ({}),
      withNotes: (text) => text,
      modelRequestedHandoff: () => false,
      retrievalEmpty: () => false,
      createOrderTool: null,
      resetSession() {},
      paidText: () => '付款已收到',
      quoteRejectedText: () => '这份报价需要顾问再核对一下，顾问会直接联系您',
      quoteWithdrawnText: () => '这份报价单已撤回，顾问会跟您重新确认',
    },
    vocab: { handoff: emptyHandoff(), dejargon: { english: {}, internal: [] } },
    thresholds: {},
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
    followupTemplates: { idleMinutes: {}, byStage: {}, fallback: '', system: '' },
    insightPrompts: {
      draftFallbackStage: 'discovery',
      stuckStages: [],
      insights: '',
      suggestion: '',
      draft: '',
      reach: {},
      funnelNames: [],
      draftFallback: {},
    },
    mock: {
      async chat() {
        return '请告诉我型号和数量';
      },
    },
    quoteCard(session) {
      const draft = readState(session).rfqDraft;
      return draft ? { title: '最近询价', amountFen: null, lines: [`${draft.lines.length} 项`] } : null;
    },
  };
}
