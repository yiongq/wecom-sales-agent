// function calling 工具集：定义（JSON Schema）+ 实现。
// routes.json 由数据模块产出，这里只在调用时用 fs 读取（不 import），
// 缺失时抛清晰错误；ROUTES_PATH 仅供测试指向 fixture，默认 data/routes.json。
import fs from 'node:fs';
import path from 'node:path';
import type { Hotel, Route, SalesSegment, SalesStage, Session } from './types.js';
import { indexReady, semanticRecall } from './retrieval.js';
import { createOrder, getOrder, saveSession } from './store.js';
import { todayIso } from './env.js';

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const toolDefs: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_routes',
      description:
        '搜索旅游线路，返回最多 3 条摘要。客户没说具体目的地、只描述了感受或场景时' +
        '（如「不用倒时差、带娃能玩水」「想找个安静的地方过纪念日」），把客户原话放进 query 做语义检索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '客户对需求的自然语言描述，用于语义检索；没有明确目的地时优先用这个' },
          destination: { type: 'string', description: '目的地关键词，如 马尔代夫、瑞士' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 蜜月、亲子、海岛' },
          segment: {
            type: 'string',
            enum: ['家庭', '亲子', '蜜月', '商务', '银发'],
            description:
              '客群。客户透露了同行人构成就一定要带上——带孩子=亲子、带爸妈/长辈=银发、' +
              '蜜月/新婚=蜜月、公司团建或接待客户=商务、多代同行=家庭。' +
              '银发会自动排除高海拔和长途颠簸的线路，亲子会优先有孩子玩点的线路。',
          },
          maxBudgetPerPerson: { type: 'number', description: '每人预算上限（元）' },
          days: { type: 'number', description: '期望行程天数（±2 天内算匹配）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_route_detail',
      description: '按线路 id 获取完整线路信息',
      parameters: {
        type: 'object',
        properties: { routeId: { type: 'string' } },
        required: ['routeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_hotels',
      description: '按目的地/标签/预算搜索精品酒店，返回最多 3 家。客户单独问酒店、或想在某目的地挑酒店时用。',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: '目的地关键词，如 马尔代夫、日本' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 蜜月、亲子、一价全包' },
          maxNightlyPrice: { type: 'number', description: '每晚预算上限（元）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_quote',
      description: '生成正式报价。报价必须来自本工具，不得自行编造价格。',
      parameters: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          travelers: { type: 'number', description: '出行人数' },
          departDate: { type: 'string', description: '出发日期 YYYY-MM-DD，可选' },
        },
        required: ['routeId', 'travelers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_proposal',
      description:
        '生成正式行程方案书（逐日行程 + 住宿 + 含餐 + 费用含/不含 + 报价），返回可发给客户的方案链接。' +
        '客户想看详细安排时调用——**包括他第一句话就要「详细方案/详细行程」的情况**：' +
        '先用 search_routes 拿到 routeId，同一轮接着调本工具，不必等到下一轮；' +
        '会话状态里「最近查到的线路」已列出这条线的 id 时直接用，不必重查。' +
        'travelers 用客户说过的人数（「两个人」=2）；departDate 可选，客户没说就不传，别为了凑参数专门去问。',
      parameters: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          travelers: { type: 'number', description: '出行人数' },
          departDate: { type: 'string', description: '出发日期 YYYY-MM-DD，可选' },
        },
        required: ['routeId', 'travelers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: '客户确认购买后创建订单，返回支付链接',
      parameters: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          travelers: { type: 'number' },
          departDate: { type: 'string', description: '出发日期 YYYY-MM-DD' },
        },
        required: ['routeId', 'travelers', 'departDate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff_to_human',
      description: '转接人工顾问。客户明确要求人工、投诉、退款或连续两轮无法理解时调用。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
    },
  },
];

function routesPath(): string {
  return process.env.ROUTES_PATH ?? path.join(process.cwd(), 'data', 'routes.json');
}

export function loadRoutes(): Route[] {
  const p = routesPath();
  if (!fs.existsSync(p)) {
    throw new Error(`线路数据缺失: ${p} 不存在（应由 data/routes.json 提供，见 SPEC 模块 1）`);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Route[];
  } catch (e) {
    // 手工编辑线路数据改坏 JSON 是高概率事故，报错必须能直接定位到文件
    throw new Error(`线路数据 ${p} 解析失败（JSON 语法错误，请检查最近的手工修改）: ${e instanceof Error ? e.message : e}`);
  }
}

function hotelsPath(): string {
  return process.env.HOTELS_PATH ?? path.join(process.cwd(), 'data', 'hotels.json');
}

export function loadHotels(): Hotel[] {
  const p = hotelsPath();
  if (!fs.existsSync(p)) return []; // 酒店库可选：缺失时 search_hotels 返回空，不影响主流程
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Hotel[];
  } catch (e) {
    throw new Error(`酒店数据 ${p} 解析失败（JSON 语法错误，请检查最近的手工修改）: ${e instanceof Error ? e.message : e}`);
  }
}

export function searchHotels(args: { destination?: string; tags?: string[]; maxNightlyPrice?: number }): Hotel[] {
  let list = loadHotels();
  if (args.destination) {
    const q = args.destination;
    list = list.filter((h) => h.destination.includes(q) || q.includes(h.destination) || h.name.includes(q));
  }
  if (args.tags?.length) {
    list = list.filter((h) => args.tags!.some((t) => h.tags.some((ht) => ht.includes(t))));
  }
  if (args.maxNightlyPrice) {
    list = list.filter((h) => h.nightlyFrom <= args.maxNightlyPrice!);
  }
  return list.sort((a, b) => a.nightlyFrom - b.nightlyFrom).slice(0, 3);
}

/** 线路摘要（给 LLM 的搜索结果，避免整条塞爆上下文） */
function summarize(r: Route) {
  return {
    id: r.id,
    title: r.title,
    destination: r.destination,
    days: r.days,
    priceFrom: r.priceFrom,
    hotelLevel: r.hotelLevel,
    bestSeason: r.bestSeason,
    tags: r.tags,
    segments: r.segments,
    highlights: r.highlights.slice(0, 3),
  };
}

/**
 * 预算滤空后放宽的倍数。1.5 是「值得开口谈」与「离谱」之间的分界：
 * 客户说两万、给他看 26,800（+34%）是一次正常的降档/加预算对话；
 * 给他看 68,800（+244%）只会让人觉得没在听。放宽后仍为空时不再兜底，
 * 直接按价格升序把最便宜的几条交给模型去如实解释。
 */
const BUDGET_RELAX = 1.5;

/**
 * 目的地关键词是否指向这条线。destination / 标题 / 标签 / 别名四处都要看：
 * 只看前两处时，搜「九寨沟」查不到库里唯一的九寨线（标题写的是「九寨黄龙」，
 * 「九寨沟」只在标签里），搜「海南」也查不到三亚——模型按 SOP 把客户原话当目的地
 * 传进来，拿到空结果就会告诉客户「暂时没有」，而库里明明有货。
 */
function matchesDestination(r: Route, q: string): boolean {
  return (
    r.destination.includes(q) || q.includes(r.destination) || r.title.includes(q) ||
    r.tags.some((t) => t.includes(q)) ||
    (r.aliases ?? []).some((a) => a.includes(q) || q.includes(a))
  );
}

export interface SearchRoutesArgs {
  query?: string;
  destination?: string;
  tags?: string[];
  segment?: SalesSegment;
  maxBudgetPerPerson?: number;
  days?: number;
}

/**
 * 召回 + 硬过滤 + 排序。
 * 有 query 且语义索引就绪时走「语义召回 → 硬条件过滤 → 按相似度排序」；
 * 否则退回关键词匹配 + 按价格升序（原行为，保证 embedding 不可用时功能不降级）。
 */
export async function searchRoutes(args: SearchRoutesArgs): Promise<ReturnType<typeof summarize>[]> {
  const all = loadRoutes();
  let list = all;
  let order: Map<string, number> | null = null;

  if (args.query?.trim() && indexReady()) {
    const hits = await semanticRecall(args.query, 8);
    if (hits?.length) {
      order = new Map(hits.map((h, i) => [h.id, i]));
      const byId = new Map(all.map((r) => [r.id, r]));
      list = hits.map((h) => byId.get(h.id)).filter((r): r is Route => !!r);
    }
  }

  let destinationMiss = false;
  if (args.destination) {
    const q = args.destination;
    // 语义召回已按需求排过序，目的地在这里只当过滤条件；召回结果里没有该目的地时
    // 退回全量再按关键词过滤，避免语义召回把明确点名的目的地漏掉
    const hit = list.filter((r) => matchesDestination(r, q));
    const fromAll = hit.length ? hit : all.filter((r) => matchesDestination(r, q));
    if (fromAll.length) list = fromAll;
    // 库里确实没有这个目的地、但语义召回有结果：留着语义结果并标明「不是该目的地」。
    // 此前这里一律变成空列表，连带把语义召回的结果也清掉了，模型两手空空。
    else if (order) destinationMiss = true;
    else list = [];
  }
  if (args.tags?.length) {
    list = list.filter((r) => args.tags!.some((t) => r.tags.some((rt) => rt.includes(t))));
  }
  // 客群处理，分两档——这个区别很重要，第一版没分导致线上评测直接挂了：
  //
  // 「银发」是**安全约束**：4000 米高原对老人是真实健康风险，宁可不推也不能推错，
  //   所以硬过滤。客户点名了高海拔目的地时保留线路但打 segmentMismatch，
  //   让模型如实说明（「这条要上珠峰大本营 5200 米，带爸妈我不敢硬推」）——
  //   不藏产品，但把风险讲在前面。
  //
  // 其余四类是**偏好**：蜜月客户去珠峰线一点问题没有，硬过滤只会把唯一符合预算的
  //   线路删掉，让 AI 报不出价也成不了单（实测就是这么挂的）。所以只做排序加权，
  //   匹配的排前面，不匹配的仍然可选。
  let segmentMismatch = false;
  if (args.segment === '银发') {
    const hit = list.filter((r) => r.segments?.includes('银发'));
    if (hit.length) list = hit;
    else if (args.destination) segmentMismatch = true;
    else list = all.filter((r) => r.segments?.includes('银发'));
  }
  // 非银发客群只作为排序偏好，并入下面的最终排序（单独排会被最终排序冲掉）
  const preferSeg = args.segment && args.segment !== '银发' ? args.segment : null;
  // 预算是**软约束**，不能像银发那样硬过滤。硬过滤在「符合条件的线路全都超预算」时
  // 返回空列表，模型没料可用，实测会退回复述自己上一轮的话——对客户说出「西藏线只有
  // 一条、人均 6 万以上」，而库里明明躺着 26,800 的那条（只超 34%）。
  // 手里有货却告诉客户「没有适合你的」，是销售最坏的失败模式：线索当场就死，
  // 而且客户不会回来核对。所以滤空了就放宽重来，并给结果打上 overBudget 标记，
  // 让模型照实讲超了多少——不藏产品，把差价摆在明面上谈（SOP 里本来就有降档话术）。
  // 天数同样是软约束，道理和预算一样：「云南玩 3 天」此前被 ±2 天硬过滤滤成空列表，模型拿到 []
  // 就说「云南暂时没有合适的线路」，而库里 6 天的丽江大理线明明在。所以 ±2 天内有就用；
  // 没有就退回天数最接近的那几条，打上 daysMiss 让模型照实说「最短的是 6 天」——
  // 行程天数是固定的（sop.md 能力边界），客户坚持要按天数定制才转人工，而不是一句「没有」挡回去。
  //
  // ±2 天的过滤必须排在预算之前。预算的「预算内 / 放宽 / 最便宜兜底」三档得在天数收窄之后的候选集上判定：
  // 此前天数排在后面，「四川 9 天、每人 3 万」先被预算收窄成预算内那条 6 天线，再被天数滤空——
  // 放宽逻辑已经跳过，库里那条 8 天、只超 43% 的线就这么没了，模型又回到「没有合适的线路」。
  // 但 ±2 天内一条都没有时，「只留天数最接近的」要排在预算**之后**：先收窄的话，「新疆 15 天、每人 2 万」
  // 只剩 10 天那条 52,800（超 164%），预算内、只差 1 天的 9 天 19,800 被丢掉——比 BUDGET_RELAX 的上限
  // 还离谱，正是「只会让人觉得没在听」。所以天数兜底只记下候选全集，等预算筛完再挑天数最接近的。
  const want = Number(args.days);
  let daysPool: Route[] | null = null; // 天数兜底时的候选全集，判「最短 / 最长」用
  // 模型偶尔传「5-7」这种字符串，Number 出来是 NaN——此前 NaN 让每条线都「不在 ±2 天内」，返回空列表
  if (args.days && Number.isFinite(want) && list.length) {
    const within = list.filter((r) => Math.abs(r.days - want) <= 2);
    if (within.length) list = within;
    else daysPool = list;
  }
  let overBudget = false;
  if (args.maxBudgetPerPerson) {
    const cap = args.maxBudgetPerPerson;
    const within = list.filter((r) => r.priceFrom <= cap);
    if (within.length) {
      list = within;
    } else {
      overBudget = true;
      const relaxed = list.filter((r) => r.priceFrom <= cap * BUDGET_RELAX);
      // 放宽后仍为空就保留原列表：下面会按价格升序取前 3，
      // 客户至少能看到最接近他预算的几条，而不是一句「没有」。
      if (relaxed.length) list = relaxed;
    }
  }
  if (daysPool) {
    const gap = Math.min(...list.map((r) => Math.abs(r.days - want)));
    list = list.filter((r) => Math.abs(r.days - want) === gap);
  }

  // 超预算时一律按价格升序：语义召回的顺序是「最贴需求」，但客户已经明说了预算，
  // 此刻最该先看到的是「最接近他出得起的价」那几条，而不是最贴描述的那几条。
  const rank = (r: Route): number => (order && !overBudget ? (order.get(r.id) ?? 99) : r.priceFrom);
  const sorted = [...list].sort((a, b) => {
    if (preferSeg) {
      // 匹配客群的排前面，但不排除不匹配的——蜜月客户去珠峰线没问题，
      // 硬删只会把唯一符合预算的线路弄丢
      const d = Number(b.segments?.includes(preferSeg) ?? false) - Number(a.segments?.includes(preferSeg) ?? false);
      if (d) return d;
    }
    return rank(a) - rank(b);
  });
  const out = sorted.slice(0, 3).map(summarize);
  // 下面几段提示是写给模型看的，但模型会原样照抄进回复（盲评里两个模型都频繁说「库里没有…」
  // 「库里还有一条…」），所以措辞只用对客户也说得出口的（「我们现有的线路」「现成线路」），不写「库里」
  if (overBudget && args.maxBudgetPerPerson) {
    const cap = Number(args.maxBudgetPerPerson);
    for (const r of out) {
      // 差额和比例都由工具算好交给模型原样转述，并记进会话（见 executeTool）供价格护栏放行。
      // 让模型自己减——哪怕减对了——护栏也认不出这个数，整条推荐会被换成兜底话术。
      const gap = r.priceFrom - cap;
      const over = Math.round((gap / cap) * 100);
      const row = r as Record<string, unknown>;
      row.gapPerPerson = gap;
      row.overBudget =
        `这条每人 ${r.priceFrom} 元，比客户说的每人 ${cap} 元高约 ${over}%（每人多 ${gap} 元）。` +
        '**不要说「没有合适的线路」**——我们现有的线路就是这些。照实讲超了多少，只用这里给的每人价、百分比和每人差额，' +
        '不要自己另算（乘人数、换算总差价都算编造价格）；再讲这个差价买到了什么，' +
        // 天数已经对不上的（daysMiss）不能再提「换更短的天数」：同一行里 daysMiss 刚说完
        // 「最短就是 6 天、不要答应压缩」，这里再让模型问「要不要换更短的」，两条指令打架
        `问客户是愿意加预算，还是要换${daysPool ? '' : '更短的天数 / '}更低的酒店档次。`;
    }
  }
  if (daysPool) {
    const where = args.destination ? `「${args.destination}」` : '';
    const minDays = Math.min(...daysPool.map((r) => r.days));
    const maxDays = Math.max(...daysPool.map((r) => r.days));
    for (const r of out) {
      // 「最短 / 最长」按候选全集判定、逐行生成：预算筛过之后留下的未必是库里最短 / 最长的那条，
      // 比如「新疆 15 天、每人 2 万」留下的是 9 天那条，而库里最长的是 10 天——说成「最长的是 9 天」就是瞎说
      const edge = r.days === minDays && minDays > want ? '最短的是' : r.days === maxDays && maxDays < want ? '最长的是' : '这条是';
      (r as Record<string, unknown>).daysMiss =
        `客户想玩 ${want} 天，我们${where}的现成线路里没有 ${Math.max(1, want - 2)}~${want + 2} 天的，${edge} ${r.days} 天。` +
        `照实说「${edge} ${r.days} 天」，不要说成 ${want} 天，也不要答应压缩或拉长成 ${want} 天——` +
        '行程天数是固定的；客户坚持要按他的天数定制，就转人工。';
    }
  }
  if (destinationMiss) {
    for (const r of out) {
      (r as Record<string, unknown>).destinationMiss =
        `我们暂时没有「${args.destination}」的现成线路，这条（${r.destination}）是按客户需求语义最接近的。` +
        `照实说明，不要把它说成${args.destination}的线路。`;
    }
  }
  if (segmentMismatch) {
    for (const r of out) {
      (r as Record<string, unknown>).segmentMismatch =
        `这条线不在「${args.segment}」适配范围内（适配：${r.segments.join('/')}）。` +
        '照实告诉客户为什么不太合适，再问他要不要看更合适的目的地，不要装作没这回事。';
    }
  }
  return out;
}

// bestSeason 是自由文本（如「6-9月」「11月-次年4月」「全年」），
// 展开其中的月份区间做旺季判定，保证规则确定可复现
function peakMonths(bestSeason: string): Set<number> {
  const months = new Set<number>();
  // 「全年适游」不等于「全年旺季」。原先展开成 12 个月，结果是这条线任何日期都
  // 上浮 10%，还附一句「X 月为最佳出行季，价格上浮 10%」——等于全年溢价还讲不出理由。
  if (bestSeason.includes('全年')) return months;
  for (const m of bestSeason.matchAll(/(\d{1,2})\s*(?:月)?\s*[-–~至到]\s*(?:次年)?\s*(\d{1,2})\s*月/g)) {
    let from = Number(m[1]);
    const to = Number(m[2]);
    // 跨年区间如 11月-次年4月
    for (let i = 0; i < 12; i++) {
      months.add(from);
      if (from === to) break;
      from = (from % 12) + 1;
    }
  }
  for (const m of bestSeason.matchAll(/(\d{1,2})\s*月/g)) months.add(Number(m[1]));
  return months;
}

export interface Quote {
  routeTitle: string;
  perPerson: number;
  travelers: number;
  total: number;
  note: string;
}

/** 报价规则写死：旺季（出发月命中 bestSeason）每人 +10%；4 人及以上总价 95 折 */
export function createQuote(args: { routeId: string; travelers: number; departDate?: string }): Quote {
  const route = loadRoutes().find((r) => r.id === args.routeId);
  if (!route) throw new Error(`线路不存在: ${args.routeId}`);
  const travelers = Math.max(1, Math.floor(args.travelers));
  let perPerson = route.priceFrom;
  const notes: string[] = [];
  const month = args.departDate ? Number(args.departDate.match(/-(\d{1,2})-/)?.[1] ?? NaN) : NaN;
  if (!Number.isNaN(month) && peakMonths(route.bestSeason).has(month)) {
    perPerson = Math.round(perPerson * 1.1);
    notes.push(`${month}月为最佳出行季，价格上浮 10%`);
  }
  if (travelers >= 4) {
    perPerson = Math.round(perPerson * 0.95);
    notes.push('4 人及以上享 95 折');
  }
  return {
    routeTitle: route.title,
    perPerson,
    travelers,
    total: perPerson * travelers,
    note: notes.length ? notes.join('；') : '当前为标准价',
  };
}

// ---------- 参数硬校验 ----------
// JSON Schema 的 required 只是给模型的提示，不构成运行时保障：模型可能传 "两"、
// 「明天」或畸形 JSON（llm 层解析失败时按空参执行）。这里把关，错了返回 error
// JSON 让模型看到原因后重试，绝不带着 NaN/假日期建单。

function toolError(msg: string): string {
  return JSON.stringify({ error: msg });
}

/** 报价上下文（含金额）。价格护栏靠它认出「这个数字是工具算的，不是模型编的」 */
function rememberQuote(routeId: string, q: Quote, departDate?: string): Session['lastQuote'] {
  return {
    routeId,
    routeTitle: q.routeTitle,
    travelers: q.travelers,
    perPerson: q.perPerson,
    total: q.total,
    departDate,
  };
}

/** 解析出行人数：接受数字或纯数字字符串，其余（"两"、"2位"…）判非法 */
function parseTravelers(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : null;
}

/** 是否为真实存在的 YYYY-MM-DD 日历日期（拒绝「明天」、2月31日这类） */
function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** 出发日期必须落在「今天 ~ 三年内」：模型常把「10月2号」解析成训练年代的过去年份，
 *  另一头也要封顶，否则 2099 年出发也能照常报价出单 */
function pastDateError(s: string): string | null {
  if (s < todayIso()) {
    return `departDate=${s} 是过去的日期（今天是 ${todayIso()}）。客户说的月日请按未来最近的日期理解，改正后重试`;
  }
  const maxDate = `${new Date().getFullYear() + 3}-12-31`;
  if (s > maxDate) {
    return `departDate=${s} 超出可预订范围（最远 ${maxDate}）。请与客户确认真实出行年份`;
  }
  return null;
}

/**
 * 进入转人工。引擎的各条转人工路径（明确诉求安全网、改行程护栏）和 handoff_to_human 工具
 * 都必须走这里：此前只有后台「接管」会记 stageBeforeHandoff，引擎触发的转人工（包括正则
 * 误伤）一律不记，顾问点「交还 AI」时只能反推阶段，recommend 的客户被打回 discovery。
 * 已在转人工中就不覆盖——否则记下的会是 handoff 本身，原阶段永久丢失（与 server.ts 的接管同一规则）。
 */
export function enterHandoff(session: Session, prevStage: SalesStage = session.stage): void {
  if (session.stage !== 'handoff' && prevStage !== 'handoff') session.stageBeforeHandoff = prevStage;
  session.handedOver = true;
  session.stage = 'handoff';
}

/**
 * 记下这次查到的线路，供下一轮会话状态带给模型（见 Session.lastShownRoutes）。
 * 新查到的排前面、与旧的去重，封顶 5 条；查空了不清——客户看过的线路还在对话里。
 */
export function rememberShownRoutes(session: Session, routes: { id: string; title: string; priceFrom: number }[]): void {
  if (!routes.length) return;
  const fresh = routes.map(({ id, title, priceFrom }) => ({ id, title, priceFrom }));
  const older = (session.lastShownRoutes ?? []).filter((r) => !fresh.some((f) => f.id === r.id));
  session.lastShownRoutes = [...fresh, ...older].slice(0, 5);
}

/**
 * 统一工具执行入口：engine/llm 只走这里。
 * 返回 JSON 字符串（作为 tool 消息回填给 LLM）；副作用直接写在传入的 session 上。
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  session: Session,
): Promise<string> {
  switch (name) {
    case 'search_routes': {
      // 客群从画像自动补齐。只把 segment 写进工具描述是不够的——模型常常漏传，
      // 一漏传硬约束就形同虚设：画像明明认出是银发，照样能查到 5200 米的珠峰线。
      // 引擎已用确定性正则把客群沉淀到 profile，这里兜底注入，模型显式传的优先。
      const a = args as SearchRoutesArgs;
      if (!a.segment && session.profile.segment) a.segment = session.profile.segment;
      const found = await searchRoutes(a);
      // 工具替模型算好的超预算差额记进会话：价格护栏据此认出「比您预算多 6,800 元」
      // 是工具给的数。只留最近几次搜索的，旧的差额早已不在对话焦点里
      const gaps = found
        .map((r) => (r as Record<string, unknown>).gapPerPerson)
        .filter((g): g is number => typeof g === 'number' && g > 0);
      if (gaps.length) session.budgetGaps = [...new Set([...(session.budgetGaps ?? []), ...gaps])].slice(-9);
      rememberShownRoutes(session, found);
      return JSON.stringify(found);
    }
    case 'get_route_detail': {
      const route = loadRoutes().find((r) => r.id === args.routeId);
      return JSON.stringify(route ?? { error: `线路不存在: ${String(args.routeId)}` });
    }
    case 'search_hotels':
      return JSON.stringify(searchHotels(args as Parameters<typeof searchHotels>[0]));
    case 'create_quote': {
      if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
      const travelers = parseTravelers(args.travelers);
      if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
      if (args.departDate !== undefined) {
        if (!isValidIsoDate(args.departDate)) return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期');
        const past = pastDateError(args.departDate);
        if (past) return toolError(past);
      }
      const q = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate as string | undefined });
      // 记住报价上下文，供成单安全网兜底下单；金额同时是价格护栏的白名单来源
      session.lastQuote = rememberQuote(args.routeId, q, args.departDate as string | undefined);
      saveSession(session);
      return JSON.stringify(q);
    }
    case 'generate_proposal': {
      if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
      const travelers = parseTravelers(args.travelers);
      if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
      if (args.departDate !== undefined) {
        if (!isValidIsoDate(args.departDate)) return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期');
        const past = pastDateError(args.departDate);
        if (past) return toolError(past);
      }
      const route = loadRoutes().find((r) => r.id === args.routeId);
      if (!route) return toolError(`线路不存在: ${String(args.routeId)}`);
      if (!route.itinerary?.length) return toolError(`线路 ${route.id} 暂无逐日行程数据，无法出方案书`);
      const q = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate as string | undefined });
      session.lastQuote = rememberQuote(args.routeId, q, args.departDate as string | undefined);
      saveSession(session);
      // 无状态链接：参数编进 URL，页面按同一套规则重算，不引入新的持久化与清理负担
      const url = `/proposal/${route.id}/${travelers}` + (args.departDate ? `/${String(args.departDate)}` : '');
      return JSON.stringify({
        proposalUrl: url,
        routeTitle: route.title,
        days: route.days,
        perPerson: q.perPerson,
        total: q.total,
        note: q.note,
        dayCount: route.itinerary.length,
      });
    }
    case 'create_order': {
      if (typeof args.routeId !== 'string' || !args.routeId) return toolError('routeId 必填');
      const travelers = parseTravelers(args.travelers);
      if (travelers === null) return toolError('travelers 必须是 1-50 的整数（阿拉伯数字），请修正后重试');
      if (!isValidIsoDate(args.departDate)) {
        return toolError('departDate 需为真实存在的 YYYY-MM-DD 日期；客户没给具体日期时先问清，不要自行猜测');
      }
      {
        const past = pastDateError(args.departDate);
        if (past) return toolError(past);
      }
      // 幂等防护：同参数的待支付订单已存在时直接复用（企微消息重放、客户复述
      // 「就订」都会再触发一次 create_order，不能每次都真建一单）
      const dup = session.orderIds
        .map((id) => getOrder(id))
        .find(
          (o) =>
            o && o.status === 'pending_payment' && o.routeId === args.routeId &&
            o.travelers === travelers && o.departDate === args.departDate,
        );
      if (dup) {
        return JSON.stringify({ orderId: dup.id, payUrl: '/pay/' + dup.id, total: dup.totalPrice });
      }
      const quote = createQuote({ routeId: args.routeId, travelers, departDate: args.departDate });
      const order = createOrder({
        sessionId: session.id,
        routeId: args.routeId,
        routeTitle: quote.routeTitle,
        travelers: quote.travelers,
        departDate: args.departDate,
        totalPrice: quote.total,
      });
      session.orderIds.push(order.id);
      session.lastQuote = undefined; // 已成单即清除，防安全网对同一报价重复建单
      saveSession(session);
      // payUrl 为相对路径，渠道层负责拼 PUBLIC_BASE_URL
      return JSON.stringify({ orderId: order.id, payUrl: '/pay/' + order.id, total: order.totalPrice });
    }
    case 'handoff_to_human': {
      enterHandoff(session);
      saveSession(session);
      return JSON.stringify({ ok: true, reason: args.reason ?? '' });
    }
    default:
      return JSON.stringify({ error: `未知工具: ${name}` });
  }
}
