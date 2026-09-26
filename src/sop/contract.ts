// SOP 契约检查，也就是发布闸 v0（docs/architecture/01-pg-config-console/spec.md「契约检查」）。
// 纯数据加纯函数，不 import 引擎：发布、回滚、启动重渲染、导出都拿它核对一份 SOP 能不能交给模型。
// mock 回归从不读 system prompt，SOP 改成什么样 mock 都照样全过，所以闸只能是这里的静态检查。
import type { ContractViolation, ViolationCode } from '../shared/console-api.js';
import {
  editableChars,
  normalizeBody,
  sectionBody,
  SopEncodingError,
  SopStructureError,
  TRAVEL_SOP_SECTIONS,
  type SectionSpec,
  type SopSection,
} from './sections.js';

export type ContractRule =
  | { id: string; kind: 'include'; text: string; from: string }
  | { id: string; kind: 'exclude'; text: string; from: string }
  | { id: string; kind: 'exclude-pattern'; pattern: RegExp; from: string };

/**
 * engine.selftest.ts 里对 buildSystemPrompt() 结果的每一条短语断言，原文照抄；from 是那条断言的说明。
 * config.selftest.ts 扫描 engine.selftest.ts 的源码，两边必须一一对应：新增一条断言而没加进这里，测试就红
 */
export const SOP_CONTRACT: readonly ContractRule[] = Object.freeze([
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
] satisfies ContractRule[]);

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
  'payUrl',
  'priceFrom',
  'routeId',
  'supersededOrderId',
  'withinBudget',
]);

/** 产出工具参数与结果字段的源文件。漂移测试只认这份列表 */
export const KNOWN_FIELD_SOURCES = ['src/tools.ts', 'src/price-rules.ts'] as const;

/** 可编辑节正文总长的上限：导入版本的 BUDGET_RATIO 倍（开放问题 7） */
export const BUDGET_RATIO = 1.2;

export type { ContractViolation, ViolationCode };

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
// 大写开头的词（酒店品牌名）和纯小写单词（greeting、emoji）都不查
const CAMEL = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g;

export function checkSopContract(input: {
  sections: readonly SopSection[];
  /** 镜像 data/sop.md 切出的节 */
  imageSections: readonly SopSection[];
  /** render(joinSop(sections)) */
  rendered: string;
  /** toolDefs 里的 function.name */
  toolNames: readonly string[];
  knownFields: readonly string[];
  /** 该租户导入版本（source='import'）的 editableChars。null 表示不查预算：启动重渲染和导出都传 null */
  baselineEditableChars: number | null;
  spec?: readonly SectionSpec[];
}): ContractViolation[] {
  const spec = input.spec ?? TRAVEL_SOP_SECTIONS;
  const out: ContractViolation[] = [];
  const add = (code: ViolationCode, sectionKey: string | null, detail: string): void => {
    out.push({ code, sectionKey, detail });
  };

  // 结构：节的顺序与节表一致，每节的标题、空行、正文、规范形都对
  const keys = input.sections.map((s) => s.key).join(',');
  const specKeys = spec.map((s) => s.key).join(',');
  if (keys !== specKeys) add('structure', null, `节的顺序与节表不符：${keys}（应为 ${specKeys}）`);
  let structureOk = keys === specKeys;
  spec.forEach((s, i) => {
    const section = input.sections.find((x) => x.key === s.key);
    if (!section) return;
    try {
      const body = sectionBody(section, s);
      if (!body.trim()) throw new SopStructureError('正文为空');
      if (/^## /m.test(body)) throw new SopStructureError('正文里有以「## 」开头的行，会被当成新的一节');
      if (normalizeBody(body, i === spec.length - 1) !== body) throw new SopStructureError('不是规范形');
    } catch (e) {
      if (!(e instanceof SopStructureError || e instanceof SopEncodingError)) throw e;
      structureOk = false;
      add('structure', s.key, e.message);
    }
  });

  // 锁定节归代码所有：必须与镜像逐字节相同
  for (const s of spec) {
    if (!s.locked) continue;
    const mine = input.sections.find((x) => x.key === s.key);
    const image = input.imageSections.find((x) => x.key === s.key);
    if (mine && image && mine.text !== image.text)
      add('locked_changed', s.key, `锁定节「${s.heading ?? s.key}」与镜像里的 data/sop.md 不一致`);
  }

  // 短语：对整段 rendered 执行，与 selftest 的断言对象相同
  const holder = (hit: (text: string) => boolean): string | null => input.sections.find((x) => hit(x.text))?.key ?? null;
  for (const rule of SOP_CONTRACT) {
    if (rule.kind === 'include') {
      if (!input.rendered.includes(rule.text)) add('phrase_missing', null, `缺少「${rule.text}」（${rule.from}）`);
    } else if (rule.kind === 'exclude') {
      if (input.rendered.includes(rule.text))
        add(
          'phrase_forbidden',
          holder((t) => t.includes(rule.text)),
          `不能出现「${rule.text}」（${rule.from}）`,
        );
    } else {
      const m = rule.pattern.exec(input.rendered);
      if (m)
        add(
          'phrase_forbidden',
          holder((t) => rule.pattern.test(t)),
          `不能出现「${m[0]}」（${rule.from}）`,
        );
    }
  }

  // 标识符：每一节的标题与正文里点名的工具与字段必须真实存在
  const tools = new Set(input.toolNames);
  const fields = new Set(input.knownFields);
  for (const section of input.sections) {
    const seen = new Set<string>();
    for (const [name] of section.text.matchAll(SNAKE)) {
      if (tools.has(name) || seen.has(name)) continue;
      seen.add(name);
      add('unknown_tool', section.key, `「${name}」不是现有的工具名`);
    }
    for (const [name] of section.text.matchAll(CAMEL)) {
      if (fields.has(name) || seen.has(name)) continue;
      seen.add(name);
      add('unknown_field', section.key, `「${name}」不是工具参数或结果里的字段`);
    }
  }

  // 预算只管运营能控制的部分：可编辑节的正文
  if (input.baselineEditableChars !== null && structureOk) {
    const chars = editableChars(input.sections, spec);
    const limit = input.baselineEditableChars * BUDGET_RATIO;
    if (chars > limit) {
      add(
        'over_budget',
        null,
        `可编辑节正文共 ${chars} 字，超过上限 ${Math.floor(limit)}（导入时 ${input.baselineEditableChars} 的 ${BUDGET_RATIO} 倍）`,
      );
    }
  }
  return out;
}
