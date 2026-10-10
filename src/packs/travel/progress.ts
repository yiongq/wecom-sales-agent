// 04 第 12 步：旅游的客群、画像与阶段推导；核心保留接管与终态并发保护。
import {
  isAside,
  spokenDepartDate,
  type CustomerProfile,
  type ProfileExtractionSources,
  type SalesStage,
  type SalesSegment,
  type Session,
  type StageTurnOutcome,
  type PackRuntime,
} from '../../core/pack-api.js';
import { travelDatePolicy } from './dates.js';
export { runtimeStages as stages } from './stages.js';

// 阶段排序，用于「只前进不倒退」地推导销售阶段（handoff/paid 另行处理）
const STAGE_RANK: Record<SalesStage, number> = {
  greeting: 0,
  discovery: 1,
  recommend: 2,
  quote: 3,
  objection: 4,
  closing: 5,
  paid: 6,
  handoff: 7,
};

// 异议是唯一「不调工具」的销售阶段——客户嫌贵、要比价、说再想想，模型只是回话，
// 没有对应的工具调用。而阶段全靠 deriveStage 从工具反推，导致 objection **永远推不出来**：
// 后台漏斗的异议档恒为 0、followup 里 objection 的 240 分钟阈值是死代码、
// 成交概率里的 objection 分档也用不上。只能从客户原话认。
const OBJECTION_INTENT =
  /太贵|好贵|贵了|超预算|预算不够|便宜点|优惠|折扣|降点|再想想|考虑一下|和(?:家里|家人|老公|老婆|爸妈)(?:商量|说)|对比一下|比比看|别家|其他家|再看看|不着急|先不定/;

/** 这轮调了哪些工具 → 该处于哪个阶段（取最靠后的），与当前阶段取较大值不回退 */
export function advanceStage(session: Session, turn: StageTurnOutcome): SalesStage {
  const current = session.stage;
  const calls = turn.calls;
  let derived: SalesStage = current === 'greeting' ? 'discovery' : current; // 客户已开口，至少进问需
  // 终态（旅游包是 paid）不做吸收态：已成交客户再发起新咨询（本轮有销售工具调用）视为新旅程，从问需重推。
  // 只查了详情不算：付完款问「第三天住哪」「几点的飞机」是在问自己这趟，引擎还会替他预取详情（planDetailPrefetch）
  if (turn.terminal && calls.some((c) => c.name !== 'get_route_detail')) derived = 'discovery';
  const bump = (s: SalesStage) => {
    if (STAGE_RANK[s] > STAGE_RANK[derived]) derived = s;
  };
  for (const c of calls) {
    if (c.name === 'create_order') bump('closing');
    // generate_proposal 内部已调 createQuote 并写入 lastQuote，客户实际已看到真实报价；
    // 不计入阶段会让后台漏斗把「已拿到完整方案书」的高意向客户仍算作 recommend
    else if (c.name === 'create_quote' || c.name === 'generate_proposal') bump('quote');
    else if (c.name === 'search_routes' || c.name === 'get_route_detail' || c.name === 'search_hotels') bump('recommend');
  }
  // 原顺序：按工具推进后才判异议；核心随后保护生成期间新写入的终态。
  return turn.customerText && isObjection({ ...session, stage: derived }, turn.customerText) ? 'objection' : derived;
}

/** 客户这句话是不是在提异议。两侧都要卡：
 *  - 下界：开场就说「先不着急」是随口一句，不是价格异议，所以要求已到 recommend；
 *  - 上界：**已经下过单的客户不能被打回异议**。付完款的人随口一句「下次有优惠吗」
 *    会把阶段从 paid 拽回 objection，而 followup.ts:53 正是靠 `stage === 'paid'`
 *    跳过老客户——结果就是给刚付完几万块的客户发「您上次的顾虑我又琢磨了下」。
 *    后台漏斗也会看到这人从促成档凭空消失但订单还在。 */
export function isObjection(session: Session, text: string): boolean {
  if (!OBJECTION_INTENT.test(text)) return false;
  if (session.orderIds.length) return false; // 已建单，不再回落
  const r = STAGE_RANK[session.stage];
  return r >= STAGE_RANK.recommend && r < STAGE_RANK.closing;
}

export function isPastRecommendationStage(stage: SalesStage): boolean {
  return STAGE_RANK[stage] > STAGE_RANK.recommend;
}

// 客群识别。高端定制旅行普遍按家庭/亲子/蜜月/商务/银发五类讲产品，这是选线的硬约束
// 而不是锦上添花——给带爸妈的客户推 4000 米的稻城亚丁不是「不够贴合」，是健康风险。
//
// 不指望模型每轮都记得把 segment 传给 search_routes：客户往往在闲聊里带出来
//（「想带我爸妈去转转」），模型下一轮就忘了。所以从原话确定性提取并沉淀到画像。
// 顺序即优先级：更具体的先判，「带孩子和爸妈一起」按亲子+银发里更受限的银发算。
// 这也是 search_routes 的 segment 的依据（见 groundToolArgs）：模型传的客群要在这里对得上客户原话才用
// （银发除外，见那里），所以同义说法要认全（「我妈」「过寿」「俩娃」「老两口」）；
// 「孩子妈妈」「孩子他爸」说的是配偶，不是长辈；「你们公司」「贵公司」问的是我们，不是商务出行
const SEGMENT_RULES: [SalesSegment, RegExp][] = [
  [
    '银发',
    /爸妈|父母|老人|长辈|家里老的|岳父|岳母|公婆|爷爷|奶奶|外公|外婆|姥姥|姥爷|老爸|老妈|我爸|我妈|(?<!孩子[他她]?|[娃宝他她])(?:妈妈|爸爸)|母亲|父亲|婆婆|公公|丈母娘|老丈人|老两口|老伴|过寿|祝寿|大寿|退休|老年|上了年纪|六十|七十|[八九]十多?岁|(?<!\d)[6-9]\d\s*岁/,
  ],
  ['亲子', /带娃|[俩两几个]娃|孩子|小孩|宝宝|儿子|女儿|亲子|小朋友|幼儿|读小学|读初中|几岁/],
  ['蜜月', /蜜月|新婚|结婚|求婚|纪念日|二人世界|两个人的旅行|领证/],
  ['商务', /商务|团建|(?<!你们|您们|贵|咱们|你家)公司|员工|奖励旅游|客户接待|接待客户|考察|年会/],
  ['家庭', /一家人|全家|家庭出行|我们一家|拖家带口|三代/],
];

// 说的是不同行的人：「我和老婆去西藏，爸妈在家带娃」此前被认成银发（接着是亲子），预取的结果里
// 给长辈配了低海拔替代线、提示模型问「长辈多大年纪、身体怎么样」——可爸妈根本不去。
// 这类小句不参与客群识别。只认说得很明白的「在家 / 不去 / 帮忙带娃」，
// 「我爸妈不去高原」这种带着要求的照样算（「不去」必须在小句末尾）
const NOT_TRAVELLING = /在家|留在家|看家|帮(?:忙|我们|我)?(?:带|看)(?:娃|孩子|小孩)|不(?:跟|和)(?:我们|着)|不一起去|(?<![要想])不去了?$/;
/** 客户原话里说同行者的部分（按小句去掉说不同行的人）。微信里常用空格断句，空格也算 */
export function travellingText(text: string): string {
  return text
    .split(/[，,。；;！!？?\n\s]+/)
    .filter((c) => !NOT_TRAVELLING.test(c))
    .join('，');
}

export function detectSegment(text: string): SalesSegment | undefined {
  const t = travellingText(text);
  for (const [seg, re] of SEGMENT_RULES) if (re.test(t)) return seg;
  return undefined;
}

export function segmentsSaid(said: string[]): Set<SalesSegment> {
  return new Set(SEGMENT_RULES.filter(([, re]) => said.some((t) => re.test(travellingText(t)))).map(([seg]) => seg));
}

/** 客户最近一次说出来的客群，与画像同一口径（extractProfile 也是这句认出来才改） */
export function latestSegment(said: string[]): SalesSegment | undefined {
  for (let i = said.length - 1; i >= 0; i--) {
    const seg = detectSegment(said[i]);
    if (seg) return seg;
  }
  return undefined;
}

// 客户说预算多用中文数字（「每人两万」「三万五」「一万五」），只认阿拉伯数字时画像里记不下来。
// 「千」只在紧跟 每人/人均/预算 时才算，否则「海拔三千米」「五千年历史」都会被当成预算
export const BUDGET_RE =
  /(?:每人|人均)?\s*(?:[0-9.]+|[一二两三四五六七八九十]+)\s*万(?:\s*[一二两三四五六七八九1-9](?![0-9])\s*千?)?|(?:每人|人均|预算)\s*(?:[0-9]|[一二两三四五六七八九])\s*千(?![米克年])/;

export const BUDGET_NOT_CAP_AFTER =
  /^\s*(?:(?:到|至|-|－|~|～|—)\s*(?:[\d.]+|[一二两三四五六七八九十]+)\s*(?:万|千|元|块)?|以上|起|往上|打底|多(?!少)|\+)/;
export const BUDGET_NOT_CAP_BEFORE = /(?:至少|起码|最少|不低于|不少于)\s*$/;

/** 说到钱、但说的不是这趟的预算：机票门票这类单项、别家的价、以前花的；或是在评价某条线的价
 *  （「那个一万八的还是有点贵」）。这种话不能当成客户改了预算——按它改，要么把客户说过的每人两万丢掉，
 *  要么把「机票每人2000左右」当成每人上限、整库线路都标成超预算（差额还进了价格护栏的白名单）。
 *  带「预算」二字的一律算预算；评价价格的话里带了「每人/以内/左右」这类说法也算（「太贵了，每人一万五以内吧」）。
 *  「机票」「别家」要说在钱前面（同一句里）或同一小句里才算：「每人两万，含机票吗」说的还是预算；
 *  以前花的钱只看同一小句（「上次去日本每人花了两万」）——「去年国庆去过云南，这次每人两万」说的就是预算 */
const MONEY_NOT_BUDGET = /机票|车票|门票|签证|保险|小费|别家|别人家|其他家|报价|标价/;
const PAST_SPEND = /上次|上回|去年|前年|花了|花过/;
const PRICE_REMARK = /贵|便宜|划算|值不值|性价比/;
const MONEY_AT = /[\d一二两三四五六七八九十]\s*(?:万|千|元|块)|\d{3,}/g;
export function isBudgetTalk(text: string): boolean {
  if (/预算/.test(text)) return true;
  if (PRICE_REMARK.test(text) && !/每人|人均|以内|以下|之内|不超过|控制在|左右|上下/.test(text)) return false;
  let money = false;
  for (const m of text.matchAll(MONEY_AT)) {
    money = true;
    const at = m.index ?? 0;
    const sentence =
      text
        .slice(0, at)
        .split(/[。！？!?\n]/)
        .pop() ?? '';
    const clauseBefore = sentence.split(/[，,；;]/).pop() ?? '';
    const clauseAfter = text.slice(at).split(/[，。,！？!?；;\n]/)[0];
    if (MONEY_NOT_BUDGET.test(sentence) || MONEY_NOT_BUDGET.test(clauseAfter)) continue;
    if (PAST_SPEND.test(clauseBefore) || PAST_SPEND.test(clauseAfter)) continue;
    return true;
  }
  return !money;
}

/** 只在旧画像抽取位置接线；工具参数的读取按会话/本轮由核心提供。 */
export function createTravelProfileExtractor(sources: ProfileExtractionSources): Pick<PackRuntime, 'extractProfile'> {
  const { loadRoutes } = sources;
  /** 从工具参数 + 客户原话沉淀画像（增量，只补不清空）。
   *  预算和客群只认客户原话，不从工具参数取（银发除外，见下）：glm-5.3-flashx 实测客户只说了「有点贵」，它调 search_routes
   *  时自己加上每人 2 万、亲子/蜜月，画像就记成「每人2万」「亲子」，后台代拟回复和下一轮提示词都拿它当真 */
  function extractProfile(customerText: string, session: Session): CustomerProfile {
    const base = session.profile;
    const calls = sources.toolCalls(session);
    const out: CustomerProfile = { ...base };
    const routeDest = (routeId: unknown): string | undefined => loadRoutes().find((r) => r.id === routeId)?.destination;
    for (const c of calls) {
      const a = c.args;
      if (c.name === 'search_routes' && typeof a.destination === 'string') out.destinationInterest = a.destination;
      if ((c.name === 'create_quote' || c.name === 'create_order') && a.routeId) {
        const d = routeDest(a.routeId);
        if (d) out.destinationInterest = d;
      }
      if (typeof a.travelers === 'number' && a.travelers > 0) out.travelers = `${a.travelers}人`;
      // 只采信「今天或之后」的日期：工具层已拒绝过去日期，画像不能反过来把它记下来
      // （模型常把「10月2号」写成训练年代的年份，后台画像会展示一个已被拦下的过去日期）
      if (typeof a.departDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.departDate) && !sources.isMonthOnly(a)) {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        if (a.departDate >= today) out.dates = a.departDate;
      }
    }
    // 客群：这句话里认出来才改。只补不覆盖——客户中途说「这次是带爸妈」才该改，没提就留着已识别的。
    // 模型查线路时传的银发例外（groundToolArgs 也不剥它）：客户的说法引擎认不全，记下来后面几轮模型忘传时
    // executeTool 才补得上；记错的代价只是高原线被标出来，漏记就是下一轮给老人推 5200 米
    const spokenSeg = detectSegment(customerText);
    if (spokenSeg) out.segment = spokenSeg;
    else if (calls.some((c) => c.name === 'search_routes' && c.args.segment === '银发')) out.segment = '银发';

    // 预算原样记客户的说法。区间和下限要连着记（「每人一万到两万」「至少每人3万」）：
    // 只记「每人一万」，后台看到的预算就错了，下一轮预取还会把它当成每人上限（见 perPersonBudget）。
    // 客户改口（「算了，每人三万也行」）以最新为准，但只有带着「每人/人均/预算」说的才覆盖旧值——
    // 「去年有三万人去过」里的「三万」不能把记下的预算冲掉；「机票每人两千左右」「一万八的有点贵」说的也不是预算（见 isBudgetTalk）
    const b = BUDGET_RE.exec(customerText);
    // 把预算放开了（「钱不是问题 预算不设上限」）：记下这个说法，旧的「每人2万」不能留着给下一轮预取当上限
    const lifted = sources.liftsBudget(customerText) ? sources.budgetLifted.exec(customerText) : null;
    if (lifted) out.budget = lifted[0];
    else if (
      b &&
      isBudgetTalk(customerText) &&
      (!out.budget || /每人|人均|预算/.test(customerText.slice(Math.max(0, b.index - 4), b.index + b[0].length)))
    ) {
      const before = customerText.slice(0, b.index).match(BUDGET_NOT_CAP_BEFORE)?.[0] ?? '';
      const after = customerText.slice(b.index + b[0].length).match(BUDGET_NOT_CAP_AFTER)?.[0] ?? '';
      out.budget = (before + b[0] + after).trim();
    }
    // 客户原话里的日期优先（模型给的 departDate 年份常错）。顺口问到的节假日（「国庆期间人多吗」）不记，见 isAside
    const said = spokenDepartDate(customerText, sources.todayIso(), travelDatePolicy);
    if (said?.kind === 'date' && said.iso && !isAside(said, customerText)) out.dates = said.iso;
    return out;
  }
  return { extractProfile };
}
