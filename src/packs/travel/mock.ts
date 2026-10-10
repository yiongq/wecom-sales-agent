import { todayIso, type ChatOptions, type MockPolicy } from '../../core/pack-api.js';

// ---------- Mock 脚本 ----------

// SPEC 模块 1 规定的 14 个目的地，用于从自由文本里识别意向
// 国内核心目的地在前——公司主营国内高端定制，客户提得最多的就是这几个
const DESTINATIONS = [
  '四川',
  '成都',
  '稻城',
  '九寨沟',
  '西藏',
  '拉萨',
  '林芝',
  '云南',
  '香格里拉',
  '丽江',
  '大理',
  '贵州',
  '西安',
  '北京',
  '新疆',
  '喀什',
  '喀纳斯',
  '三亚',
  '马尔代夫',
  '瑞士',
  '日本',
  '新西兰',
  '北欧',
  '极光',
  '迪拜',
  '巴厘岛',
  '意大利',
  '肯尼亚',
  '南极',
  '摩洛哥',
  '法国',
];

const CN_NUM: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function findDestination(texts: string[]): string | undefined {
  for (const t of texts.toReversed()) {
    const hit = DESTINATIONS.find((d) => t.includes(d));
    if (hit) return hit;
  }
  return undefined;
}

function findTravelers(texts: string[]): number {
  for (const t of texts.toReversed()) {
    const m = t.match(/([0-9]+|[一两二三四五六七八九十])\s*(?:个|位|大人)?(?:人|口|大)/);
    if (m) {
      const n = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : CN_NUM[m[1]];
      if (n && n > 0) return n;
    }
  }
  return 2;
}

function findBudget(texts: string[]): string | undefined {
  for (const t of texts.toReversed()) {
    const m = t.match(/(?:每人)?\s*[0-9.]+\s*万/);
    if (m) return m[0].trim();
  }
  return undefined;
}

/** 「M月D号」取今天起最近的那一天：今年的已经过了就算明年（与 create_order 的「不许过去日期」对齐）。
 *  不合法的日期（2月30号）照样拼出来，交给工具校验、走 mock 的「再确认日期」分支 */
function nearestFuture(month: number, day: number, today: string): string {
  const y = Number(today.slice(0, 4));
  const iso = (yy: number): string => `${yy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return iso(y) >= today ? iso(y) : iso(y + 1);
}

/**
 * mock 脚本从客户原话里取出发日期。所有推算都基于「今天」：以前写死 2026 年、默认
 * 2026-10-01，过了那天 engine.selftest 的下单就会被「过去日期」拒掉——定时炸弹。
 * today 参数只为自测能模拟任意日期。
 */
export function findDepartDate(texts: string[], today = todayIso()): string {
  for (const t of texts.toReversed()) {
    const iso = t.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    // 客户带了年份就照原样用——「2020年1月1号」是在测过去日期护栏，不能替他挪到明年
    const ymd = t.match(/(\d{4})\s*年\s*([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*[号日]/);
    if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
    // 「X月Y号」优先取客户明说的日；只说「X月」才用 15 号兜底（mock 要保证流程能走完）
    const md = t.match(/([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*[号日]/);
    if (md) return nearestFuture(Number(md[1]), Number(md[2]), today);
    const m = t.match(/([0-9]{1,2})\s*月/);
    if (m) return nearestFuture(Number(m[1]), 15, today);
  }
  // 未提日期时的确定性默认值：一个月后，永远落在可预订范围内
  const d = new Date(`${today}T00:00:00`);
  d.setDate(d.getDate() + 30);
  return todayIso(d);
}

interface RouteSummary {
  id: string;
  title: string;
  days: number;
  priceFrom: number;
  hotelLevel: string;
  highlights: string[];
}

/** 找线路：优先按意向目的地，搜不到就取全量第一条，保证脚本永远能走下去 */
async function pickRoutes(opts: ChatOptions, destination?: string): Promise<RouteSummary[]> {
  if (destination) {
    const hit = JSON.parse(await opts.executeTool('search_routes', { destination })) as RouteSummary[];
    if (hit.length) return hit;
  }
  return JSON.parse(await opts.executeTool('search_routes', {})) as RouteSummary[];
}

function state(stage: string, profile: Record<string, unknown> = {}): string {
  return `\n<state>${JSON.stringify({ stage, profile })}</state>`;
}

const yuan = (n: number): string => '¥' + n.toLocaleString('zh-CN');

export async function mockChat(opts: ChatOptions): Promise<string> {
  const userTexts = opts.messages.filter((m) => m.role === 'user').map((m) => m.content);
  const last = userTexts[userTexts.length - 1] ?? '';
  const destination = findDestination(userTexts);

  // 关键词优先级：转人工 > 下单 > 报价 > 推荐 > 问需
  if (/人工|真人客服|投诉|退款/.test(last)) {
    await opts.executeTool('handoff_to_human', { reason: '客户主动要求人工/投诉退款' });
    return '好的，我马上为您转接专属人工顾问，请稍候，顾问会第一时间联系您～' + state('handoff');
  }

  if (/就订|就定|下单|购买|买了|订了|就这个|就它|确定|成交|付款/.test(last)) {
    const routes = await pickRoutes(opts, destination);
    if (!routes.length) return '目前我们还没有匹配的现成线路，我帮您登记需求，稍后顾问联系您～' + state('discovery');
    const travelers = findTravelers(userTexts);
    const departDate = findDepartDate(userTexts);
    // 工具可能返回 {error:...}（如客户给了 2026-99-99 这类假日期）——不检查就取 total 会直接 TypeError
    const order = JSON.parse(await opts.executeTool('create_order', { routeId: routes[0].id, travelers, departDate })) as {
      orderId?: string;
      payUrl?: string;
      total?: number;
      error?: string;
    };
    if (order.error || !order.orderId || typeof order.total !== 'number') {
      return (
        '好嘞～不过出发日期我还想跟您确认一下：方便告诉我具体哪天出发吗（比如「10月1号」）？确认后我马上为您锁定名额～' + state('quote')
      );
    }
    return (
      `收到！已为您锁定《${routes[0].title}》的名额 🎉\n` +
      `${travelers} 位出行，${departDate} 出发，总价 ${yuan(order.total)}。\n` +
      `请点击链接完成支付：${order.payUrl}\n支付后我会第一时间为您确认行程～` +
      state('closing', { dates: departDate })
    );
  }

  if (/预算|多少钱|报价|费用|价格|([0-9一两二三四五六七八九十]\s*(?:个|位)?人)/.test(last)) {
    const routes = await pickRoutes(opts, destination);
    if (!routes.length) return '稍等，我先帮您查下合适的线路哈～' + state('discovery');
    const travelers = findTravelers(userTexts);
    const quote = JSON.parse(await opts.executeTool('create_quote', { routeId: routes[0].id, travelers })) as {
      routeTitle?: string;
      perPerson?: number;
      travelers?: number;
      total?: number;
      note?: string;
      error?: string;
    };
    if (quote.error || typeof quote.total !== 'number' || typeof quote.perPerson !== 'number') {
      return '咱们几位出行呢？告诉我人数（比如「2 个人」），我马上给您出准确报价～' + state('discovery');
    }
    const profile: Record<string, unknown> = { travelers: `${travelers}人` };
    const budget = findBudget(userTexts);
    if (budget) profile['budget'] = budget;
    if (destination) profile['destinationInterest'] = destination;
    return (
      `好嘞，给您报个准价 💰\n《${quote.routeTitle}》每人 ${yuan(quote.perPerson)}，` +
      `${quote.travelers} 位总价 ${yuan(quote.total)}（${quote.note}）。\n` +
      `含全程住宿、行程内体验和专属管家服务。觉得合适的话，回复「就订这个」我直接帮您下单～` +
      state('quote', profile)
    );
  }

  if (destination && last.includes(destination)) {
    const routes = await pickRoutes(opts, destination);
    if (!routes.length)
      return (
        `${destination}方向的线路我帮您定制安排，先问下几位出行、大概什么时间呢？` +
        state('discovery', { destinationInterest: destination })
      );
    const lines = routes
      .slice(0, 2)
      .map((r) => `《${r.title}》${r.days} 天，${r.hotelLevel}，每人 ${yuan(r.priceFrom)} 起，亮点：${r.highlights.slice(0, 2).join('、')}`)
      .join('\n');
    return (
      `${destination}选得好呀 ✨ 给您挑了这些：\n${lines}\n` +
      `方便告诉我几位出行、预算大概多少吗？我好给您出个准确报价～` +
      state('recommend', { destinationInterest: destination })
    );
  }

  return (
    '您好呀～我是云途定制旅行的旅行顾问 😊 咱们做高端定制游，先了解下您的想法：' +
    '这次想去哪个方向玩，大概几位出行呢？' +
    state('discovery')
  );
}

export const travelMock: MockPolicy = { chat: mockChat };
