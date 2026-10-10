// 旅游包的 SOP 节表、契约规则与字段出处；旧入口保留同一份转出。
import type { SectionSpec, SopContractRule } from '../../core/pack-api.js';

/** 旅行行业包的节表。顺序就是 data/sop.md 里的顺序；锁定节的「代码依赖」见 spec 的节表 */
export const TRAVEL_SOP_SECTIONS: readonly SectionSpec[] = Object.freeze(
  [
    { key: 'preamble', heading: null, locked: false },
    { key: 'stages', heading: '各阶段目标', locked: true },
    { key: 'orders', heading: '订单：改单、给别人再订、重发链接', locked: true },
    { key: 'tone', heading: '话术原则', locked: false },
    { key: 'quote-discipline', heading: '报价纪律（硬性）', locked: true },
    { key: 'price-rules', heading: '定价规则（只有这两条，硬性）', locked: true },
    { key: 'objections', heading: '异议处理', locked: false },
    { key: 'capabilities', heading: '能力边界（硬性，先看这条）', locked: true },
    { key: 'no-destinations', heading: '我们没有的目的地（如南极、冰岛）', locked: true },
    { key: 'handoff', heading: '转人工条件（满足任一立即调用 handoff_to_human）', locked: true },
    { key: 'wechat-style', heading: '微信语气规范', locked: false },
  ].map((s) => Object.freeze(s)),
);

/**
 * engine.selftest.ts 里对 buildSystemPrompt() 结果的每一条短语断言，原文照抄；from 是那条断言的说明。
 * config.selftest.ts 扫描 engine.selftest.ts 的源码，两边必须一一对应：新增一条断言而没加进这里，测试就红
 */
export const SOP_CONTRACT: readonly SopContractRule[] = Object.freeze([
  { id: 'insist-before-handoff', kind: 'include', text: '明确坚持只要原目的地', from: 'SOP 要写明坚持才转人工' },
  {
    id: 'no-direct-handoff-offcatalog',
    kind: 'exclude',
    text: '明显超出我们现有线路的范围',
    from: 'SOP 不能再让「超出现有线路」直接转人工',
  },
  { id: 'handoff-no-promise', kind: 'include', text: '不要替顾问承诺能去、能安排原目的地', from: 'SOP 转人工段要写明不承诺原目的地' },
  { id: 'no-date-reasoning', kind: 'include', text: '不要把推算过程念给客户', from: 'SOP 报价段要写明不念日期推算过程' },
  {
    id: 'holiday-counts-as-date',
    kind: 'include',
    text: '国庆、五一、春节这类节假日也算日期已给',
    from: 'SOP 要写明三样齐全就报价、节假日也算',
  },
  { id: 'quote-timing', kind: 'include', text: '报价时机', from: 'SOP 要写明三样齐全就报价、节假日也算' },
  { id: 'details-from-itinerary', kind: 'include', text: '行程里没写，我让顾问确认', from: 'SOP 要写明细节只按原文答' },
  { id: 'intensity-note', kind: 'include', text: 'intensityNote', from: 'SOP 要写明细节只按原文答' },
  {
    id: 'no-shrink-requote',
    kind: 'exclude-pattern',
    pattern: /减晚数|换酒店档|缩短天数重新报价/,
    from: 'V9 SOP 不再教「缩短天数 / 换酒店档重新报价」',
  },
  { id: 'two-price-rules', kind: 'include', text: '定价只有两条规则', from: 'V9 SOP 写死定价规则与能力边界' },
  { id: 'no-holiday-price', kind: 'include', text: '没有节假日价', from: 'V9 SOP 写死定价规则与能力边界' },
  { id: 'advisor-on-wechat', kind: 'include', text: '顾问会在微信上联系您', from: 'V9 SOP 写死定价规则与能力边界' },
  { id: 'no-compress-promise', kind: 'exclude', text: '我让顾问帮您看看能不能压缩', from: 'W18 SOP 出方案书那段不再许诺压缩' },
  { id: 'shortest-six-days', kind: 'include', text: '现成的线路最短就是 6 天', from: 'W18 SOP 出方案书那段不再许诺压缩' },
  {
    id: 'season-from-note',
    kind: 'include',
    text: '不凭印象说「X 月是淡季 / 按标准价 / 错开旺季」',
    from: 'Y7 SOP 写明季节只照 note、总预算按总价比、不许诺升房型加天数',
  },
  {
    id: 'no-upgrade-promise',
    kind: 'include',
    text: '还能升房型 / 加天数',
    from: 'Y7 SOP 写明季节只照 note、总预算按总价比、不许诺升房型加天数',
  },
  {
    id: 'budget-by-total',
    kind: 'include',
    text: '按两位的总价跟 3 万比',
    from: 'Y7 SOP 写明季节只照 note、总预算按总价比、不许诺升房型加天数',
  },
] satisfies SopContractRule[]);

/** SOP 可以点名的字段：工具参数和工具结果里真实存在的字段名。每一项都必须出现在 KNOWN_FIELD_SOURCES 里（config.selftest 守着） */
export const SOP_KNOWN_FIELDS: readonly string[] = Object.freeze([
  'altitudeNote',
  'bestSeason',
  'departDate',
  'destinationMiss',
  'intensityNote',
  'maxBudgetPerPerson',
  'maxNightlyPrice',
  'overBudget',
  'payNote',
  'payUrl',
  'priceFrom',
  'routeId',
  'supersededOrderId',
  'withinBudget',
]);

/** 产出工具参数与结果字段的源文件。漂移测试只认这份列表 */
export const KNOWN_FIELD_SOURCES = [
  'src/packs/travel/tools/catalog.ts',
  'src/packs/travel/tools/index.ts',
  'src/packs/travel/price-rules.ts',
] as const;

/** 漂移扫描跟着真实产出源码走；第 9、10 步搬产出实现时同步迁移 sourceFiles。 */
export const knownFields = Object.freeze({ names: SOP_KNOWN_FIELDS, sourceFiles: KNOWN_FIELD_SOURCES });
