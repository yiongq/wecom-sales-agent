// 08 R14：只在 PACK_FIXTURES=1 时注册的证明包，保留 04 R16 的工具、阶段与护栏。
import {
  deepFreeze,
  createLineOrder,
  orderDisplay,
  yuanToFen,
  moneyProvenanceStep,
  linkWhitelistStep,
  moneyProvenanceFollowupStep,
  UNSTORABLE_TEXT,
  type CatalogItem,
  type IndustryPack,
  type PackRuntime,
  type PackSources,
  type SalesStage,
  type Session,
  type SopSectionDef,
} from '../../core/pack-api.js';
import { z } from 'zod';

const sopSections = [
  { key: 'preamble', heading: null, locked: false },
  { key: 'fixture_role', heading: '核验员职责', locked: true },
  { key: 'widget_intake', heading: '方盒需求采集', locked: false },
  { key: 'fixture_verify', heading: '方盒核验流程', locked: true },
  { key: 'widget_reply', heading: '核验答复建议', locked: false },
  { key: 'fixture_limits', heading: '核验能力边界', locked: true },
] as const satisfies readonly SopSectionDef[];

export const fixture: IndustryPack = deepFreeze({
  id: '__fixture',
  name: '方盒核验证明包',
  entities: [
    {
      kind: 'widget',
      label: '方盒',
      icon: 'box',
      codeLabel: '方盒编号',
      codeExample: 'w-sample',
      titleKey: 'title',
      subtitleKeys: ['$code', 'unit'],
      groups: [{ key: 'basic', label: '方盒信息' }],
      lockGroups: {},
      fields: [
        { key: '$code', type: 'text', label: '方盒编号', group: 'basic' },
        { key: 'title', type: 'text', label: '方盒名称', group: 'basic' },
        { key: 'unitPrice', type: 'money', decimals: 2, unitFrom: 'unit', label: '单价', group: 'basic', reprices: true },
        { key: 'unit', type: 'enum', options: ['件', '盒'], label: '单位', group: 'basic', reprices: true },
        { key: 'moq', type: 'intUnit', min: 1, label: '起订量', unit: '件', group: 'basic', required: false, reprices: true },
        {
          key: 'tiers',
          type: 'subItems',
          label: '阶梯价',
          group: 'basic',
          required: false,
          reprices: true,
          item: [
            { key: 'minQty', type: 'intUnit', min: 1, label: '起始数量', group: '' },
            { key: 'unitPrice', type: 'money', decimals: 2, label: '单价', group: '' },
          ],
        },
        { key: 'tags', type: 'tags', label: '标签', group: 'basic' },
        { key: '$status', type: 'status', label: '状态', group: 'basic' },
      ],
      list: {
        columns: ['title', 'unitPrice', 'unit', 'tags', '$status', '$updated'],
        filters: ['unit', 'tags'],
        search: ['title', 'tags', '$code'],
        defaultSort: '-$updated',
      },
      csvImport: true,
      activateLine: '上架后，核验员可查询这件方盒的资料',
    },
  ],
  vocabulary: {
    customer: '客户',
    advisor: '核验员',
    productNoun: '方盒',
    tools: { fixture_inspect: '核验需求', fixture_order: '建立方盒订单' },
    sopFields: { title: '方盒名称', unitPrice: '单价', unit: '单位', tags: '标签', inspected: '核验结果' },
  },
  sopSections: sopSections.map((s) => ({ ...s, ...(s.locked ? { lockReason: '核验流程由证明包统一维护' } : {}) })),
  nav: { catalogGroup: '产品', entities: ['widget'] },
  stages: [
    { key: 'greeting', label: '开始' },
    { key: 'objection', label: '核验完成' },
    { key: 'paid', label: '已付款', terminal: true },
  ],
});

export function createFixtureRuntime(sources?: Pick<PackSources, 'currentCatalog'>): PackRuntime {
  const widgetText = z
    .string()
    .min(1)
    .refine((text) => !/[\0\p{Cs}]/u.test(text), UNSTORABLE_TEXT);
  const unitPrice = z
    .number()
    .positive()
    .multipleOf(0.01)
    .max(Number.MAX_SAFE_INTEGER / 100);
  const WidgetSchema = z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    title: widgetText,
    unitPrice,
    unit: z.enum(['件', '盒']),
    tags: z.array(widgetText),
    tiers: z.array(z.strictObject({ minQty: z.number().int().positive(), unitPrice })).optional(),
    moq: z.number().int().positive().optional(),
  });
  // 08 R4：状态槽两个键——inspections 计核验次数（重置清掉），tier 记客户的核验档位（重置保留）
  const StateSchema = z.strictObject({
    inspections: z.number().int().min(0).optional(),
    tier: z.string().min(1).max(20).optional(),
  });
  const profileFields = [
    { key: 'color', label: '颜色' },
    { key: 'size', label: '尺寸' },
  ] as const;
  /** 包写状态槽一律先过 schema（核心只存取、不解读） */
  const writeState = (session: Session, patch: z.infer<typeof StateSchema>): void => {
    session.packState = StateSchema.parse({ ...session.packState, ...patch });
  };
  return {
    id: fixture.id,
    siteLinks: [
      {
        linkKind: 'quote',
        pattern: /^\/quote\/ord_[0-9a-f]{24}$/,
        resources: [{ pattern: /^\/api\/quotes\/ord_[0-9a-f]{24}$/, methods: ['GET'] }],
        card: () => ({ title: '报价单', desc: '查看报价明细' }),
        partTitle: () => '报价单',
        // 本批只登记；审批数据尚未接入，默认拒绝外发。
        allowed: () => false,
      },
    ],
    money: { minimumAmount: 0.01, precisionTolerance: 0.5, decimals: true },
    sessionState: { schema: StateSchema, resetKeys: ['inspections'] },
    profileFields,
    // 只发业务字段；attrs 只发声明过的键（核心还会再筛一次）
    profileForPrompt(profile) {
      const attrs = Object.fromEntries(profileFields.flatMap(({ key }) => (profile.attrs?.[key] ? [[key, profile.attrs[key]]] : [])));
      return {
        ...(profile.notes?.length ? { notes: profile.notes } : {}),
        ...(Object.keys(attrs).length ? { attrs } : {}),
      };
    },
    profileView(profile) {
      const rows = profileFields.flatMap(({ key, label }) => (profile.attrs?.[key] ? [{ label, value: profile.attrs[key] }] : []));
      return { title: rows.map((r) => r.value).join(''), rows };
    },
    catalog: {
      widget: {
        schema: WidgetSchema,
        titleKey: 'title',
        lockedWhenActive: ['id'],
        repriceFields: ['unitPrice', 'unit', 'tiers', 'moq'],
        moneyFields: [
          { path: 'unitPrice', decimals: 2 },
          { path: 'tiers[].unitPrice', decimals: 2 },
        ],
        retrieval: true,
      },
    },
    catalogStartupCheck: (snapshot) => (snapshot.items.widget?.length ? null : '没有 active 的 widget'),
    priceLine(item, qty) {
      const widget = WidgetSchema.parse(item);
      if (widget.moq !== undefined && qty < widget.moq) return { reject: 'below_moq', detail: { moq: widget.moq } };
      const eligible = widget.tiers?.filter((tier) => qty >= tier.minQty) ?? [];
      const price = eligible.length ? Math.min(...eligible.map((tier) => tier.unitPrice)) : widget.unitPrice;
      return { unitPriceFen: yuanToFen(price), unit: widget.unit };
    },
    defaultBrand: {
      brandName: '虚构方盒核验社',
      advisorTitle: '方盒核验员',
      aiTitle: 'AI 方盒核验员',
      scopeNoun: '方盒核验',
      identityLine: '我是虚构方盒核验社的 AI 方盒核验员',
    },
    legacy: {
      offTopicReply: '请说明服务需求',
      welcomeText: '欢迎咨询测试服务',
      welcomeBackText: '欢迎回来',
      webWelcome: '欢迎咨询测试服务',
      mockOpening: '请说明服务需求',
      quickReplies: [],
      hardRequirements: '只输出服务正文。',
      identityAnswer: '我是测试服务的 AI 顾问',
      resetReply: '已重新开始',
      resetDisabledReply: '请告诉我新的需求',
      handoffFallback: '顾问会处理',
    },
    templates: {
      hardRequirements:
        '【硬性要求】\n只输出客户可读的纯文本。先核验再答复；不编造单价，不承诺成交或付款安排。你是{brandName}的{aiTitle}。',
      lockedSectionTemplates: {
        fixture_role: '## 核验员职责\n\n你是{brandName}的 {aiTitle}，只负责{scopeNoun}。需要进一步处理时交给{advisorTitle}。\n\n',
        fixture_verify: '## 方盒核验流程\n\n先调用 fixture_inspect 核验需求，再根据核验结果答复；核验失败时说明尚未完成。\n\n',
        fixture_limits: '## 核验能力边界\n\n核验结果不代表库存、交付或成交承诺。资料不足时请客户补充，不替客户决定价格与付款。\n',
      },
      identityAnswer: '{identityLine}',
      offTopicReply: '我是{brandName}的{aiTitle}，可以帮助您核验方盒需求。',
      welcomeText: '欢迎来到{brandName}，我是{aiTitle}。请告诉我方盒需求。',
      welcomeBackText: '欢迎回来，{brandName}的{aiTitle}继续为您核验方盒需求。',
      webWelcome: '您好，我是{brandName}的{aiTitle}。请描述需要核验的方盒。',
      mockOpening: '请告诉我需要核验的方盒名称与单位。',
      quickReplies: [],
      preamble: '# {brandName} · 方盒核验说明\n\n{identityLine}。本说明只使用合成资料，用于验证方盒核验流程。\n\n',
      pages: {},
    },
    sopSections: sopSections.map((s) => ({ ...s })),
    contractRules: () => [
      { id: 'fixture_no_unverified', kind: 'exclude', text: '未经核验也保证可用', from: '证明包：不得把未核验的需求说成已确认' },
    ],
    knownFields: { names: ['inspected'], sourceFiles: ['src/packs/__fixture/runtime.ts'] },
    stages: fixture.stages.map((s) => ({ id: s.key as SalesStage, ...(s.terminal ? { terminal: true } : {}) })),
    tools: [
      {
        def: {
          type: 'function',
          function: {
            name: 'fixture_quote',
            description: '查询方盒单价',
            parameters: {
              type: 'object',
              properties: { code: { type: 'string' } },
              required: ['code'],
              additionalProperties: false,
            },
          },
        },
        sideEffects: [],
        cacheable: true,
        blocksRetry: false,
        async execute(input) {
          const parsed = z.object({ code: z.string() }).safeParse(input);
          if (!parsed.success) return JSON.stringify({ error: '缺少方盒编号' });
          const item = sources
            ?.currentCatalog()
            .items.widget?.map((entry) => WidgetSchema.parse(entry))
            .find((entry) => entry.id === parsed.data.code);
          if (!item) return JSON.stringify({ error: '没有该方盒' });
          const widget = WidgetSchema.parse(item);
          return JSON.stringify({ code: widget.id, unitPrice: widget.unitPrice, unit: widget.unit });
        },
        amounts(result) {
          const quote = JSON.parse(result) as { unitPrice?: number };
          return quote.unitPrice === undefined ? [] : [{ fen: yuanToFen(quote.unitPrice), label: '查询单价' }];
        },
      },
      {
        def: {
          type: 'function',
          function: { name: 'fixture_inspect', description: '核验服务需求', parameters: { type: 'object', properties: {} } },
        },
        sideEffects: ['session'],
        cacheable: true,
        blocksRetry: false,
        async execute(_args, ctx) {
          writeState(ctx.session, { inspections: (Number(ctx.session.packState?.inspections) || 0) + 1, tier: 'basic' });
          return JSON.stringify({ inspected: true });
        },
      },
      {
        def: {
          type: 'function',
          function: {
            name: 'fixture_order',
            description: '按方盒编号和数量建单，价格由产品库确定',
            parameters: {
              type: 'object',
              properties: {
                lines: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    properties: { kind: { type: 'string' }, code: { type: 'string' }, qty: { type: 'integer' } },
                    required: ['kind', 'code', 'qty'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['lines'],
              additionalProperties: false,
            },
          },
        },
        sideEffects: ['session', 'order'],
        cacheable: false,
        blocksRetry: true,
        async execute(input, { session }) {
          // z.object 丢弃额外字段，执行体再显式投影，金额无论在哪一层都不能流入建单。
          const parsed = z
            .object({ lines: z.array(z.object({ kind: z.string(), code: z.string(), qty: z.number() })).min(1) })
            .safeParse(input);
          if (!parsed.success) return JSON.stringify({ error: 'lines 必须包含 kind、code 和数量 qty' });
          const result = await createLineOrder(
            session,
            parsed.data.lines.map(({ kind, code, qty }) => ({ kind, code, qty })),
          );
          if ('rejected' in result) return JSON.stringify(result);
          const display = orderDisplay(result.order);
          return JSON.stringify({
            orderId: result.order.id,
            reused: result.reused,
            lines: result.order.lines,
            totalFen: result.order.totalFen,
            display,
            text: [
              display.title,
              ...display.lines.map((line) => `${line.title} ${line.qtyText} ${line.unitPriceText} ${line.amountText}`),
              `合计${display.totalText}`,
            ].join('\n'),
          });
        },
        amounts(result) {
          const order = JSON.parse(result) as { lines?: { unitPriceFen: number; amountFen: number }[]; totalFen?: number };
          if (!order.lines || order.totalFen === undefined) return [];
          return [
            ...order.lines.flatMap((line) => [
              { fen: line.unitPriceFen, label: '订单单价' },
              { fen: line.amountFen, label: '订单行金额' },
            ]),
            { fen: order.totalFen, label: '订单合计' },
          ];
        },
      },
    ],
    // 客户说「颜色：红」「尺寸：大」就记进 attrs；每轮最多抽到其中一部分，引擎按键合并
    extractProfile(text) {
      const attrs = Object.fromEntries(
        profileFields.flatMap(({ key, label }) => {
          const value = new RegExp(`${label}[:：]\\s*([^\\s，。,.]+)`).exec(text)?.[1];
          return value ? [[key, value]] : [];
        }),
      );
      return { notes: ['已核验'], ...(Object.keys(attrs).length ? { attrs } : {}) };
    },
    advanceStage: (session, turn) => (turn.calls.some((c) => c.name === 'fixture_inspect') ? 'objection' : session.stage),
    contextNote: () => ['按测试服务规则核验需求'],
    replyAnchors: { markdown: 'fixture_guard', 'takeover_check:post': 'link_whitelist' },
    replySteps: [
      { ...linkWhitelistStep(), after: ['money_provenance'] },
      {
        id: 'fixture_guard',
        after: ['stage_advance'],
        run(ctx) {
          const text = ctx.text.replace(/测试禁词/g, '已核验');
          if (text === ctx.text) return { action: 'pass' };
          ctx.recordGuard('fixture_guard', ctx.text, text, 'replace');
          return { action: 'replace', text };
        },
      },
      {
        ...moneyProvenanceStep({ staticAmounts: () => [1000], fallback: '金额尚未核验，请先查询。' }),
        after: ['stage_advance', 'shape_check'],
      },
    ],
    followupSteps: [moneyProvenanceFollowupStep({ staticAmounts: () => [1000] })],
    engineHooks: {
      isComplaint: () => false,
      isHandoffIntent: () => false,
      safetyNetKind: () => 'request',
      handoffReply: () => '顾问会处理',
      departNoteForHandoff: () => undefined,
      fallbackReply: () => '请告诉我需要核验的内容',
      hintsFor: () => ({}),
      withNotes: (text) => text,
      modelRequestedHandoff: () => false,
      retrievalEmpty: () => false,
      createOrderTool: null,
      resetSession() {},
      paidText: () => '付款已收到',
    },
    vocab: {
      // 空词表让确定性检测不匹配行业内容；算法仍从同一包接口读取。
      handoff: emptyHandoffVocab(),
      dejargon: { english: {}, internal: [] },
    },
    thresholds: {},
    retrievalItems: () => {
      if (!sources) return [];
      const snapshot = sources.currentCatalog();
      return (snapshot.items.widget ?? []).map((payload, ord) => {
        // CatalogItem.payload 暂留旅游兼容类型；快照里的真实数据已经过 widget schema 校验。
        const item = payload as CatalogItem['payload'];
        return {
          kind: 'widget',
          code: item.id,
          ord,
          status: 'active',
          rev: snapshot.versions[`widget:${item.id}`] ?? 1,
          payload: item,
          updatedByName: null,
          updatedAt: '',
        };
      });
    },
    retrievalCacheFile: 'fixture-vectors.json',
    evalGoalsDir: 'eval/sim/goals/__fixture',
    retrievalText: (item) => JSON.stringify(item.payload),
    followupTemplates: { idleMinutes: {}, byStage: {}, fallback: '需要帮助随时说', system: '写一句服务跟进' },
    insightPrompts: {
      draftFallbackStage: 'greeting',
      stuckStages: [],
      insights: '分析服务',
      suggestion: '给出建议',
      draft: '起草服务回复',
      reach: {},
      funnelNames: [],
      draftFallback: { greeting: '请说明需求' },
    },
    mock: {
      async chat(opts) {
        await opts.executeTool('fixture_inspect', {});
        return '测试禁词：需求已经核验';
      },
    },
  };
}

function emptyHandoffVocab(): PackRuntime['vocab']['handoff'] {
  // 各词表键是固定契约，正则永不匹配；结构从契约列明，不依赖旅游包。
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
