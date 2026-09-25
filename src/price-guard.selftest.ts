// 价格出口护栏自测。这道护栏两侧都要钉住，而且两边的代价都很贵：
//   · 漏拦 → 模型编的价直接发给客户，成交后要么公司认亏要么当场翻脸
//   · 误杀 → 真实报价被换成「我需要重新核对一下」，客户永远拿不到价格，还会反复循环
// 用法：npx tsx src/price-guard.selftest.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据写临时目录，别碰真实 var/（store 在模块加载时就取 VAR_DIR，故动态 import）
process.env.VAR_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-priceguard-'));

const { findUnbackedPrices, __priceGuardTest } = await import('./price-guard.js');
const { createQuote, executeTool } = await import('./tools.js');
const { loadRoutes } = await import('./tools.js');
import type { Session } from './types.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const blank = (over: Partial<Session> = {}): Session =>
  ({
    id: 'sim-priceguard', channel: 'simulator', stage: 'quote', profile: {}, messages: [],
    orderIds: [], handedOver: false, createdAt: 0, updatedAt: 0, ...over,
  }) as Session;

const routes = loadRoutes();
const cheapest = [...routes].sort((a, b) => a.priceFrom - b.priceFrom)[0];
const pricey = [...routes].sort((a, b) => b.priceFrom - a.priceFrom)[0];
const blocked = (text: string, s = blank(), said = ''): boolean => findUnbackedPrices(text, s, said).length > 0;
/** 本轮一次 search_routes（引擎预取或模型自己调）：结果只带 id，护栏只看这个 */
const searchCall = (destination: string, ...ids: string[]) => ({
  name: 'search_routes', args: { destination }, result: JSON.stringify(ids.map((id) => ({ id }))),
});
/** 本会话已经查到过这几条线（产品库的精确价只按本会话出现过的线路放行，见 price-guard routesInPlay） */
const shown = (...ids: string[]): Session => blank({
  lastShownRoutes: ids.map((id) => routes.find((r) => r.id === id)!).map(({ id, title, priceFrom }) => ({ id, title, priceFrom })),
});

// ---------------- 拦得住：编造的价格 ----------------
// 「万」形态曾经完全不在护栏视野里：同一个编造的价写成「38000元」被拦、写成「3.8 万」放行，
// 而 SOP 恰恰教模型用「人均 X 万」说价位档，等于护栏对最常见的说法失明。
{
  check('编造人均（元）被拦', blocked('这条线人均 33333元'));
  check('编造人均（¥）被拦', blocked('人均 ¥33,333'));
  check('编造人均（万）被拦', blocked('这条线人均 3.8 万左右'));
  check('编造总价（万，带人数）被拦', blocked('两位一共 7.6 万'));
  // 客户自己喊的价 ≠ 可以承诺的成交价
  const s = blank({ messages: [{ role: 'customer', content: '别家同样线路只要 6800元', at: 0 }] });
  check('拿客户开的价当成交价被拦', blocked('好的，就按 6800元 给您锁定，这就帮您下单', s));
  check('同一个数字在非成交语境放行', !blocked('您说的 6800元 我记下了，不过配置不太一样', s));
}

// ---------------- 放得过：真实报价与合法档位话术 ----------------
{
  const s = blank();
  await executeTool('create_quote', { routeId: cheapest.id, travelers: 2 }, s);
  const q = createQuote({ routeId: cheapest.id, travelers: 2 });
  check('工具算的人均+总价放行', !blocked(`每人 ¥${q.perPerson.toLocaleString('zh-CN')}，2 位总价 ¥${q.total.toLocaleString('zh-CN')}`, s));
  check('同一总价写成万也放行', !blocked(`两位一共 ${(q.total / 10000).toFixed(2)} 万`, s));

  const q4 = createQuote({ routeId: cheapest.id, travelers: 4 });
  check('4 人 95 折总价放行', !blocked(`4 位总价 ¥${q4.total.toLocaleString('zh-CN')}`, shown(cheapest.id)));

  // 20 人以上团：白名单此前只枚举到 20 人，真实工具报价会被自己的护栏判成编造，
  // 且模型重算还是同一个数字 → 客户永远拿不到总价（死循环）
  const s25 = blank();
  await executeTool('create_quote', { routeId: cheapest.id, travelers: 25 }, s25);
  const q25 = createQuote({ routeId: cheapest.id, travelers: 25 });
  check('lastQuote 带上了金额（否则护栏里的分支是死代码）', typeof s25.lastQuote?.total === 'number');
  check('25 人团真实总价放行', !blocked(`25 位总价 ¥${q25.total.toLocaleString('zh-CN')}`, s25));

  // SOP 允许的档位说法：「万」只有一位有效数字，容差要能覆盖到真实起价
  const wan = Math.round(pricey.priceFrom / 10000);
  check(`档位话术「人均 ${wan} 万左右」放行`, !blocked(`这条线人均 ${wan} 万左右这个档`));
  // 一位小数的「万」（±500）已经是某条线的价，不是档位：线路查到过才放行（见下面「本会话出现过的线路」）
  check('起价（一位小数）放行', !blocked(`人均 ${(cheapest.priceFrom / 10000).toFixed(1)} 万起`, shown(cheapest.id)));

  // 酒店每晚价也是产品库价：此前不在白名单里，照 search_hotels 结果报的价整条被换成兜底话术
  const { loadHotels } = await import('./tools.js');
  const hotel = loadHotels()[0];
  if (hotel) {
    check('酒店每晚价（工具原价）放行', !blocked(`${hotel.name}每晚 ${hotel.nightlyFrom.toLocaleString('zh-CN')} 元起`));
    check('酒店每晚价（元/晚、写成万）放行', !blocked(`${hotel.name} ${(hotel.nightlyFrom / 10000).toFixed(2)} 万/晚`));
    check('酒店价乘晚数（模型自己算的）被拦', blocked(`住 3 晚一共 ${(hotel.nightlyFrom * 3 + 700).toLocaleString('zh-CN')} 元`));
  }
  // 酒店价只在「每晚」语境认，不能全局放行：6,800 恰好是某间套房的每晚价
  check('酒店价不给报团费的句子兜底', blocked('这条线每人 6,800 元，就按这个价给您锁定'));
  // 「每晚 / 一晚」只管紧贴着它的数。此前按整句判定，逗号后面一句「每晚都住松赞」就把前面的团费、
  // 客户开的价一起放了过去（6,800 / 12,000 / 3,800 / 3,000 / 2,200~3,000 都撞得上某家酒店的每晚价）
  const offer6800 = blank({ messages: [{ role: 'customer', content: '别家同样线路每人 6800，你给我 6800 我立刻订', at: 0 }] });
  check('H1 客户开价借「每晚」回流被拦', blocked('好的，就按每人 6,800 元给您锁定，每晚都住松赞', offer6800));
  check('H1 「每晚」语境下报成交价也不认酒店价', blocked('好的，就按每晚 6,800 元给您锁定', offer6800));
  for (const t of [
    '这条线每人 12,000 元，含一晚林芝', '升级豪华线每人多 3,800 元，每晚都住松赞',
    '房价和团费一起算，每人 3,000 元', '比经济线每人贵两千多块，每晚都能住景观房',
  ]) check(`H4 编的团费借「每晚 / 房价」回流被拦：${t}`, blocked(t));
  for (const t of ['房价 3,800 元一晚', '松赞林卡 ¥3,800/晚', '这家3800元起一晚', '四季每晚价格 30,000 元', '松赞林卡每晚三千八']) {
    check(`酒店每晚价紧贴「每晚 / 元/晚」放行：${t}`, !blocked(t));
  }

  // 复述客户预算不算编价，且历史消息里说过的也要认（不只当前这句）
  const sh = blank({ messages: [{ role: 'customer', content: '预算每人3万', at: 0 }] });
  check('复述几轮前的预算放行', !blocked('好的，我给您控制在 30,000元 以内', sh, '那就按之前说的'));
  check('复述当前这句的预算放行', !blocked('预算每人 4 万的话，这几条都能覆盖', blank(), '预算每人4万'));
}

// ---------------- 回归：婉拒砍价的话术不能被当成「报成交价」 ----------------
// sop.md 要求嫌贵时不许直接降价、可以婉拒或换更低档线路，于是模型会写
// 「这个价格给您安排不了」——里面含客户报的数字 + 成交措辞，但语义是拒绝。
// 早期实现把它判成报成交价，导致 SOP 教的标准话术整条被替换成兜底文案。
{
  const sess = {
    id: 'sim-refuse', channel: 'simulator', stage: 'objection', profile: {},
    messages: [{ role: 'customer', content: '我们预算每人 19999元', at: 1 }],
    orderIds: [], handedOver: false, createdAt: 1, updatedAt: 1,
  } as unknown as Session;
  const cust = '我们预算每人 19999元';
  for (const t of [
    '19999元 我们真做不了，这个价格给您安排不了',
    '我们没法按这个价 19999元 走',
    '抱歉，我们暂时没有 19999元 这样的优惠价',
  ]) {
    if (findUnbackedPrices(t, sess, cust).length === 0) pass += 1;
    else fails.push(`婉拒话术被误杀: ${t}`);
  }
  // 真正顺着客户开价答应的，仍然要拦
  const yes = '好的，就按 19999元 给您锁定名额，我这就帮您下单';
  if (findUnbackedPrices(yes, sess, cust).length > 0) pass += 1;
  else fails.push(`顺着客户开价答应未被拦: ${yes}`);
}

// ---------------- 超预算差额与中文数字预算 ----------------
// search_routes 超预算时要模型「照实讲超了多少」，差额由工具算好并记进会话；
// 此前护栏不认差额，模型转述「比您的预算多 6,800 元」整条推荐被换成兜底话术。
// 客户说「每人两万」、模型复述「每人 20,000 元」同理——客户基本都用中文数字说预算。
{
  const s = blank();
  await executeTool('search_routes', { destination: '西藏', maxBudgetPerPerson: 20000 }, s);
  check('search_routes 记下工具算好的差额', s.budgetGaps?.includes(6800) === true, JSON.stringify(s.budgetGaps));
  check('转述工具算好的差额放行', !blocked('每人 26,800 元，比您的预算多 6,800 元', s));
  check('差额写成万也放行', !blocked('比您的预算多 0.68 万左右', s));
  check('工具没算过的差额被拦', blocked('比您的预算多 7,200 元', s));
  check('拿差额当成交价被拦', blocked('好的，就按 6,800 元给您锁定名额', s));

  const said: [string, number][] = [
    ['每人两万左右', 20000], ['预算三万五', 35000], ['一万五以内', 15000], ['每人八千', 8000],
    ['两万五千吧', 25000], ['十五万总预算', 150000], ['3万5', 35000], ['8千', 8000],
  ];
  for (const [text, n] of said) {
    check(`客户说「${text}」，复述 ${n} 放行`, !blocked(`您说的 ${n.toLocaleString('zh-CN')} 元我记下了`, blank(), text));
  }
  check('几轮前用中文数字说的预算也认', !blocked('给您控制在每人 20,000 元以内',
    blank({ messages: [{ role: 'customer', content: '每人两万吧', at: 0 }] }), '好的'));
  const { parseCnAmounts } = __priceGuardTest;
  check('「海拔三千米」不是金额', parseCnAmounts('海拔三千米').length === 0);
  check('「三五天」不是金额', parseCnAmounts('玩三五天').length === 0);
  // 客户侧此前把「一万九千八」读成 19000、「两千八」读成 2000：客户报的精确预算，模型复述回去反被当成编价
  check('客户说「一万九千八」读作 19800', parseCnAmounts('预算一万九千八').includes(19800), JSON.stringify(parseCnAmounts('预算一万九千八')));
  check('客户说「两千八」读作 2800', parseCnAmounts('差价两千八能接受').includes(2800), JSON.stringify(parseCnAmounts('差价两千八能接受')));
  // 盘古空格写法：此前「3 万 5」只读到 30,000，模型复述 35,000 被当成编价
  check('客户说「3 万 5」读作 35000', parseCnAmounts('预算 3 万 5').includes(35000), JSON.stringify(parseCnAmounts('预算 3 万 5')));

  // 客户说区间：两个端点都要认。此前客户侧整段不认，回复侧却读得出上端点，模型复述客户的预算反被拦
  check('客户说「五六千」，复述「五千到六千」放行',
    !blocked('每人五千到六千的预算，目前最便宜的西安线是每人 12,800 元', blank({ messages: [{ role: 'customer', content: '预算每人五六千', at: 0 }] })));
  check('客户说「八九千」，复述「八到九千」放行',
    !blocked('预算八到九千的话，可以看看西安线，每人 12,800 元', blank({ messages: [{ role: 'customer', content: '预算八九千', at: 0 }] })));
  check('客户说「8000-9000元」，复述两个端点放行',
    !blocked('8,000 元到 9,000 元的预算我记下了', blank(), '预算8000-9000元'));
  const { parseRangeEndpoints } = __priceGuardTest;
  check('「两三万」展开成两个端点', JSON.stringify(parseRangeEndpoints('预算两三万')) === '[20000,30000]', JSON.stringify(parseRangeEndpoints('预算两三万')));
  check('「一两万字」「2026-10-15」不是金额区间', parseRangeEndpoints('攻略有一两万字，2026-10-15 出发').length === 0,
    JSON.stringify(parseRangeEndpoints('攻略有一两万字，2026-10-15 出发')));
}

// ---------------- 回复里的中文数字金额 ----------------
// 此前回复侧只认阿拉伯数字：「人均三万八」「两位总共七万六千」「两千多块」整句绕过护栏，
// 「3万8」只读到「3万」（±5000 的档位容差，28,800 / 32,800 都能「对上」）。
// 模型换一种写法就能把编的价发给客户，等于没有护栏。
{
  const { parseWanAmounts } = __priceGuardTest;
  const vals = (t: string) => parseWanAmounts(t).map((w) => w.value);
  for (const [text, n] of [
    ['这条线人均三万八', 38000], ['每人两万五', 25000], ['两位总共七万六千', 76000], ['人均3万8', 38000],
    ['三万八千元', 38000], ['每人一万九千八', 19800], ['价格四万二千八百', 42800], ['起价三点八万', 38000],
    ['两万五一位', 25000], ['人均两万一位', 20000],
  ] as [string, number][]) {
    check(`回复「${text}」读作 ${n}`, vals(text).includes(n), JSON.stringify(vals(text)));
  }
  const twoK = parseWanAmounts('每人贵两千多块');
  check('「两千多块」读作 2000~3000 的区间', twoK.length === 1 && twoK[0].value - twoK[0].tol === 2000 && twoK[0].value + twoK[0].tol === 3000,
    JSON.stringify(twoK));

  // 编的价：换成中文数字照样拦
  check('编造人均（中文数字）被拦', blocked('这条线人均三万八'));
  check('编造人均（3万8）被拦', blocked('这条线人均3万8左右'));
  check('编造人均（三万八千元）被拦', blocked('这条线三万八千元一位'));
  check('编造人均（精确到百）被拦', blocked('每人两万四千五'));
  check('编造人均（万后接千百）被拦', blocked('单人三万三千三'));
  check('编造总价（中文数字，带人数）被拦', blocked('两位总共七万六千'));
  check('编造差价（两千多块）被拦', blocked('比丽江那条每人贵两千多块'));
  // 句末语气词、数字前紧贴「人均」、没有提示词的千位尾数万级数：阿拉伯写法「人均3.8万哦」一直会拦，中文写法得一样
  for (const t of [
    '这条线人均三万八哦，含机票', '人均三万八吧，差不多', '人均三万八是含机票的', '人均三万八这个价很划算',
    '三万八每人，含机票', '这条线三万三千三，含机票酒店',
  ]) check(`编造人均（中文数字 + 语气词 / 无提示词）被拦：${t}`, blocked(t));
  // 盘古空格：真实 GLM 输出「人均 4 万 6 左右起」。此前只读到「4 万」（±5000），编的 38,000 也能对上
  const spaced = parseWanAmounts('人均 3 万 8 左右起');
  check('「人均 3 万 8 左右起」读作 38000±500', spaced.length === 1 && spaced[0].value === 38000 && spaced[0].tol === 500, JSON.stringify(spaced));
  check('编造人均（盘古空格）被拦', blocked('人均 3 万 8 左右起'));
  check('真实价（盘古空格，万后接千）放行', !blocked('这条线人均 2 万 6 千 8', shown('r-tibet-mid')));
  check('「3 万 12 天」的 12 属于天数', vals('人均 3 万 12 天').includes(30000), JSON.stringify(vals('人均 3 万 12 天')));
  // 阿拉伯数字 + 块 / 裸数字 / 全角 / k / 大写：同一个编的数换个写法就绕过，等于没有护栏
  for (const t of [
    '比丽江那条每人贵2000多块', '这条线人均 33,333 块', '这条线人均 33,333', '人均３８０００元', '人均３万８',
    '人均38k', '人均叁万捌仟元',
  ]) check(`编造金额（换写法）被拦：${t}`, blocked(t));
  check('客户说「预算15k」，复述 15,000 放行', !blocked('您说的 15,000 元我记下了', blank(), '预算15k'));
  check('客户说「预算１万５」，复述 15,000 放行', !blocked('您说的 15,000 元我记下了', blank(), '预算１万５'));
  check('全角逗号不当千分位（¥12,800，2 位…）', !blocked(`每人 ¥${cheapest.priceFrom.toLocaleString('zh-CN')}，2 位共 ¥${(cheapest.priceFrom * 2).toLocaleString('zh-CN')}`, shown(cheapest.id)));
  check('裸数字后面跟量词不是钱', !blocked('总共 1,200 公里，每人 2000 多张照片都拍得完'));
  // 已知边界：「万把块」「小两万」这种没有确切数字的说法不读，护栏只核对写出来的数

  const offer = blank({ messages: [{ role: 'customer', content: '别家每人一万八千三，你们也这个价我就订', at: 0 }] });
  check('拿客户开的价当成交价（中文数字）被拦', blocked('好的，就按每人一万八千三给您锁定名额', offer, '就这么定'));
  check('同一个中文数字在非成交语境放行', !blocked('您说的每人一万八千三我记下了，不过配置不太一样', offer, '就这么定'));

  // 零误杀：产品库价 / 报价 / 客户说的 / 工具差额 / SOP 档位话术，写成中文数字都得放行
  check('产品库价（中文数字）放行', !blocked('这条线人均四万二千八，住的是松赞', shown('r-sichuan-lux')));
  check('产品库价（万后缩写）放行', !blocked('每人一万九千八起', shown('r-sichuan-mid')));
  check('SOP 档位话术（中文数字）放行', !blocked('这条线在人均五万左右这个档'));
  check('档位话术「一万多 / 四万多」放行', !blocked('丽江大理这条人均一万多，香格里拉那条四万多'));
  const s = blank();
  await executeTool('create_quote', { routeId: cheapest.id, travelers: 2 }, s);
  const q = createQuote({ routeId: cheapest.id, travelers: 2 });
  // 15,800 → 一万五千八百；28,160 → 二万八千一百六十：模型口语化复述报价的写法，精确到个位
  const cn = (n: number): string => {
    const d = '零一二三四五六七八九';
    const [k, h, t, o] = String(n % 10000).padStart(4, '0').split('').map(Number);
    let out = `${d[Math.floor(n / 10000)]}万`;
    if (k) out += d[k] + '千'; else if (h || t || o) out += '零';
    if (h) out += d[h] + '百'; else if (k && (t || o)) out += '零';
    if (t) out += d[t] + '十'; else if (h && o) out += '零';
    if (o) out += d[o];
    return out;
  };
  check(`工具报价写成中文数字放行（${cn(q.perPerson)} / ${cn(q.total)}）`,
    !blocked(`每人${cn(q.perPerson)}，两位一共${cn(q.total)}`, s));
  check('客户说过的中文数字预算，模型用中文复述放行',
    !blocked('每人两万五的预算，这两条都能覆盖', blank(), '预算每人两万五'));
  const sg = blank();
  await executeTool('search_routes', { destination: '西藏', maxBudgetPerPerson: 20000 }, sg);
  check('工具算好的差额写成中文数字放行', !blocked('每人两万六千八，比您的预算多六千八', sg));

  // 不是钱的数字：天数、人数、海拔、步数、里程、字数、地名，哪怕同一句里有价格词也不能当钱
  for (const t of [
    '三天两晚，两个人刚好', '看五千米雪山', '海拔三千多米，老人要慢慢适应', '每天一万步也不累',
    '全程两千公里自驾', '十几个景点', '攻略有一两万字', '价格不变，还能看江孜十万佛塔',
    '人均两万八千八，含江孜十万佛塔', '海拔从三千六缓降到三千，节奏舒缓', '登四千五观景台',
    '看四千五百年冰川', '预算内也能看到五千米雪山', '预算一两万的话可以看看贵州', '千万别错过日照金山',
    '万一下雨也有备选', '住万豪', '人均两三万的线都有', '价格十几万的也有',
    // 金额词是「贵州 / 免费」的一个字，或和数字之间隔着「海拔」：说的是高度不是钱
    '贵州梵净山海拔两千五，爬起来不累', '贵州这条线海拔一千五左右，老人也合适', '免费参观海拔三千七的布达拉宫',
    '这条线费用含海拔四千二的纳木错一日游', '每人两万就能看到海拔五千二的珠峰大本营', '不用加钱就能住海拔三千六的松赞',
    '预算有限又怕高反的话可以选海拔三千以下的云南线', '人均两万住海拔三千以上的酒店', '性价比很高，还能登四千二观景台',
  ]) {
    // 这组只钉「不是钱的数不当成钱」：线路全算查到过，里面真实的团费（两万八千八）不因会话范围被拦
    const all = shown(...routes.map((r) => r.id));
    check(`「${t}」不当成编价`, !blocked(t, all), JSON.stringify(findUnbackedPrices(t, all, '')));
  }
}

// ---------------- 产品库的价只按本会话出现过的线路放行 ----------------
// 实测（uf/verify c2 第 2 遍）：客户说「想去南极」，模型一个工具都没调，编了一条「南极深度体验线的替代方向……
// 人均起价 68800 起」。68800 是西藏松赞线的价，此前整库的价都在白名单里，而且「人均起价 68800 起」没有单位、
// 「起价」隔在人均和数字中间，护栏压根没把它当成钱——编造的线路配真实价格原样发给了客户。
{
  const tibetLux = routes.find((r) => r.id === 'r-tibet-lux')!;
  check('（前提）68800 是西藏松赞线的价', tibetLux.priceFrom === 68800);
  const antarctic = blank({ stage: 'recommend', messages: [{ role: 'customer', content: '想去南极', at: 0 }] });
  const FAKE =
    '南极这个方向咱们这边没有现成线路，跟您说声抱歉。\n\n不过如果您是想要那种极致纯净、人少景美的体验，我们有一条南极概念的替代线路可以参考下：\n\n' +
    '· 南极深度体验线的替代方向，走的是极地风光同款的冰川、雪原路线，人均起价 68800 起\n\n您大概几位出行、什么时候想去？我帮您看看具体安排～';
  check('P1 编造样本（本会话从没出现过松赞线）被拦', JSON.stringify(findUnbackedPrices(FAKE, antarctic, '想去南极')) === '[68800]',
    JSON.stringify(findUnbackedPrices(FAKE, antarctic, '想去南极')));
  // 有了引擎预取，「想去南极」这一轮召回的就有松赞线（实测前三是极光、松赞、珠峰）——只按「出现过」核，
  // 这句原样编造照样能过。说南极的那个分句里没点名任何线路，价就没有出处
  const antarcticRecall = [searchCall('南极', 'r-aurora', 'r-tibet-lux', 'r-tibet-mid')];
  check('P1 本轮预取召回了松赞线，同一句编造照样被拦', JSON.stringify(findUnbackedPrices(FAKE, antarctic, '想去南极', antarcticRecall)) === '[68800]',
    JSON.stringify(findUnbackedPrices(FAKE, antarctic, '想去南极', antarcticRecall)));
  check('P1 上一轮展示过松赞线，同一句编造照样被拦', blocked(FAKE, { ...antarctic, lastShownRoutes: shown('r-tibet-lux').lastShownRoutes }, '想去南极'));
  const namedLux = '南极暂时没有现成线路，最接近的是西藏松赞全线，人均起价 68800 起';
  check('P1 回复在同一句点名「松赞」线、本轮召回里有它：放行', findUnbackedPrices(namedLux, antarctic, '想去南极', antarcticRecall).length === 0);
  check('P1 回复在同一句点名「松赞」线、本会话却从没出现过：被拦（跟南极同一分句的点名不算出处）', blocked(namedLux, antarctic, '想去南极'));
  check('P1 实测的正常替代推荐（线路名和价写在一起）放行', findUnbackedPrices(
    '南极暂时没有现成线路，最接近的是北欧芬兰极光玻璃屋 8 日，人均 46,800 起', antarctic, '想去南极', antarcticRecall).length === 0);
  check('P1 「松赞那条」放行', !blocked('松赞那条线人均 ¥68,800 起', antarctic));
  // 「人均起价 X 起」「起价 X」这种不带单位的写法本身也要读成钱
  check('P2 「人均起价 68888 起」读成钱并被拦', blocked('这条线人均起价 68888 起'));
  check('P2 「起价 68888」被拦', blocked('起价 68888，含机酒'));
  check('P2 「每人团费 68888」被拦', blocked('每人团费 68888'));

  // 本会话出现过的几种来源：本轮工具结果、最近查到的线路、最近报价、订单、对话里点过名
  const s0 = blank();
  check('P3 精确的产品库价、线路没出现过：被拦', blocked('这条线人均 ¥68,800', s0));
  check('P3 本轮 search_routes 的结果里有它：放行', findUnbackedPrices('这条线人均 ¥68,800', s0, '', [
    { name: 'search_routes', args: { destination: '南极' }, result: JSON.stringify([{ id: 'r-aurora' }, { id: 'r-tibet-lux' }]) },
  ]).length === 0);
  check('P3 本轮 get_route_detail 查过它：放行', findUnbackedPrices('这条线人均 ¥68,800', s0, '', [
    { name: 'get_route_detail', args: { routeId: 'r-tibet-lux' }, result: JSON.stringify(tibetLux) },
  ]).length === 0);
  check('P3 本轮 search_routes 查到的是别的线：照样拦', findUnbackedPrices('这条线人均 ¥68,800', s0, '', [
    { name: 'search_routes', args: { destination: '南极' }, result: JSON.stringify([{ id: 'r-aurora' }]) },
  ]).length > 0);
  check('P3 最近报价是这条线（不带金额）：放行', !blocked('这条线人均 ¥68,800',
    blank({ lastQuote: { routeId: 'r-tibet-lux', routeTitle: tibetLux.title, travelers: 2 } })));
  check('P3 前几轮点过名：放行', !blocked('那条人均 ¥68,800 起', blank({
    messages: [{ role: 'agent', content: '西藏这边推荐拉萨林芝纳木错·松赞全线 9 日', at: 0 }, { role: 'customer', content: '那条多少钱', at: 1 }],
  })));
  // 只对应一条线的目的地算点名（西安只有兵马俑那条），对应好几条的不算（西藏有两条）
  check('P3 「西安线」点名：放行', !blocked('西安那条每人 12,800 元', s0));
  check('P3 「西藏线」不算点名：被拦', blocked('西藏线人均 68,800 元', s0));
  // 景观词不是点名：编出来的「南极冰川极光线」里全是它们
  check('P3 冰川 / 极光 / 雪山不算点名：被拦', blocked('南极冰川极光雪山深度线，人均 46,800 起', s0));
  const { routeNames, namedRoutes } = __priceGuardTest;
  const names = routeNames(routes);
  check('P3 「冰川」「极光」「雪山」「深度」点不到任何线', namedRoutes('冰川 极光 雪山 深度 秘境 古城', names).length === 0,
    JSON.stringify(namedRoutes('冰川 极光 雪山 深度 秘境 古城', names)));
  check('P3 「松赞」点到两条松赞线', JSON.stringify(namedRoutes('松赞', names).sort()) === '["r-tibet-lux","r-yunnan-lux"]',
    JSON.stringify(namedRoutes('松赞', names)));
  // 档位话术（只到「万」位，±5000）仍按整库：SOP 教的「人均 5 万左右这个档」说的是价位段，不是哪条线的价；
  // 精确到千位的「6.9 万」就是某条线的价，线路没出现过就拦
  check('P4 档位话术「人均 7 万左右」仍按整库放行', !blocked('这条线在人均 7 万左右这个档', s0));
  check('P4 档位话术「四万多」仍按整库放行', !blocked('另一条人均四万多', s0));
  check('P4 「人均 6.9 万」是精确价：线路没出现过被拦', blocked('这条线人均 6.9 万', s0));

  // 零误杀：会话范围收窄后，此前靠「整库里恰好有个接近的数」过关的正常话术不能被连带拦下（语料回放里的两条）
  // 「就按这条走」选的是线路、不是报成交价，客户说过的预算照样算数
  const xj = blank({
    lastShownRoutes: shown('r-xinjiang').lastShownRoutes,
    messages: [{ role: 'customer', content: '新疆玩一周左右，每人一万一以内', at: 0 }],
  });
  check('P5 「就按这条走」不算成交语境，复述客户预算放行',
    !blocked('新疆伊犁·独库公路越野摄影 9 日，起价每人 19800 元，比您说的 1 万 1 超了不少。\n一是预算能往上提一点就按这条走；二是我帮您找更实惠的。', xj, '新疆玩一周左右，每人一万一以内'));
  // 语料原文（cmp/full s05）：两个选项用分号隔开，「就按这条走」跟后面的「1 万 5」在同一句里。
  // 「就按这条走」只在它所在的分句（分号也断开）带金额时才算成交语境，这句不算
  const s05 = blank({
    lastShownRoutes: shown('r-xinjiang').lastShownRoutes, budgetGaps: [4800],
    messages: [{ role: 'customer', content: '新疆玩一周左右，每人一万五以内', at: 0 }],
  });
  const S05 = '新疆一周左右，这个预算我这边有一条很对路的线，但先跟您说清楚价格情况：\n\n新疆伊犁·独库公路越野摄影 9 日\n' +
    '· 起价每人 19800 元，比您说的 1 万 5 超了约 32%（每人多 4800）\n· 全程陆巡车队+专业摄影领队，独库公路全线穿越\n\n' +
    '两个方向您看哪个更合适：一是预算能往上提一点就按这条走；二是我帮您找天数更短、酒店档位更实惠的版本，把价格拉回 1 万 5 以内。您倾向哪个？';
  check('P5 语料原句「就按这条走；……拉回 1 万 5 以内」放行', !blocked(S05, s05, '新疆玩一周左右，每人一万五以内'),
    JSON.stringify(findUnbackedPrices(S05, s05, '新疆玩一周左右，每人一万五以内')));
  // 同一分句里「就按这条走」接着报客户开的价，就是顺着客户砍价成交（HEAD 拦，上一版放行了）
  const yn = (said: string) => blank({ lastShownRoutes: shown('r-yunnan-mid').lastShownRoutes, messages: [{ role: 'customer', content: said, at: 0 }] });
  check('P5 「就按这条走，每人 6,800 元」拿客户开的价成交：被拦',
    JSON.stringify(findUnbackedPrices('好的，就按这条走，每人 6,800 元', yn('别家6800，你给我6800我立刻订'), '别家6800，你给我6800我立刻订')) === '[6800]');
  check('P5 「就按这个方案，每人 6,800 元」同样被拦',
    blocked('行，就按这个方案，每人 6,800 元，我把链接发您', yn('6800 我就订'), '6800 我就订'));
  const sOffer = blank({ messages: [{ role: 'customer', content: '别家同样线路只要 6800元', at: 0 }] });
  check('P5 「就按这个来」仍是成交语境：拿客户开的价被拦', blocked('好的，就按这个来，每人 6,800 元', sOffer));
  // 客户说的数不带单位（「11111 卖不卖」）、模型按千位截断复述（「一万一」）：都是客户说的
  const tb = blank({ lastShownRoutes: shown('r-tibet-mid', 'r-tibet-lux').lastShownRoutes, messages: [{ role: 'customer', content: '便宜点，11111 卖不卖', at: 0 }] });
  check('P5 客户不带单位的数，模型截断复述放行', !blocked('这个价真做不了。两位如果预算定在一万一，我帮您看看贵州方向。', tb, '便宜点，11111 卖不卖'));
  const tb2 = blank({ lastShownRoutes: tb.lastShownRoutes, messages: [{ role: 'customer', content: '便宜点，19999 卖不卖', at: 0 }] });
  check('P5 客户 19999，模型口语复述「一万九」放行（按千位截断）', !blocked('两位如果预算定在一万九，我帮您看看贵州方向。', tb2, '便宜点，19999 卖不卖'));
  // 截断 / 四舍五入只给口语的「万」：阿拉伯数字写出来的精确金额得跟客户的数一模一样
  const xa = blank({ lastShownRoutes: shown('r-xian').lastShownRoutes, messages: [{ role: 'customer', content: '携程上 12999', at: 0 }] });
  check('P5 客户说 12999，模型报「每人 13,000 元左右」：被拦',
    JSON.stringify(findUnbackedPrices('我们这条每人 13,000 元左右', xa, '携程上 12999')) === '[13000]',
    JSON.stringify(findUnbackedPrices('我们这条每人 13,000 元左右', xa, '携程上 12999')));
}

// ---------------- 复核补的几处：出现过的线路怎么认 ----------------
{
  const agent = (content: string) => ({ role: 'agent' as const, content, at: 0 });
  const customer = (content: string) => ({ role: 'customer' as const, content, at: 0 });
  // lastShownRoutes 封顶 5 条、每次查最多 3 条，对比两三个目的地之后早先的线路就被挤掉；名字检测也认不全缩写
  const evicted = shown('r-sichuan-mid', 'r-sichuan-lux', 'r-yunnan-mid', 'r-yunnan-lux', 'r-tibet-mid').lastShownRoutes;
  check('P6 被挤出 lastShown、之前回复写过价（缩写「西藏 9 日奢华线」）：放行', !blocked('西藏 9 日那条人均 68,800 元',
    blank({ lastShownRoutes: evicted, messages: [agent('西藏两条：\n· 西藏 9 日奢华线，人均 68,800 起\n· 西藏 7 日经典线，人均 26,800 起')] })));
  check('P6 被挤出、之前写成「大理丽江」（名字倒过来）：放行', !blocked('大理丽江那条人均 16,800', blank({
    lastShownRoutes: shown('r-sichuan-mid', 'r-sichuan-lux', 'r-tibet-mid', 'r-tibet-lux', 'r-xian').lastShownRoutes,
    messages: [agent('云南推荐大理丽江 6 日，人均 16,800 起')],
  })));
  check('P6 顾问接管时手写的介绍（没照标题写）、交还后 AI 复述：放行', !blocked('顾问说的那条南北疆纵贯线人均 52,800',
    blank({ messages: [agent('您好我是顾问小王，给您推荐南北疆纵贯 10 日：喀什、帕米尔、禾木、喀纳斯，人均 52,800')] })));
  check('P6 seenRouteIds 里有、lastShown 里已经没有：放行', !blocked('日本那条人均 32,800 元',
    blank({ lastShownRoutes: shown('r-bali', 'r-maldives-mid', 'r-maldives-lite', 'r-sanya', 'r-aurora').lastShownRoutes, seenRouteIds: ['r-japan'] })));
  // 真走工具：先查日本，再查三个地方把它挤出 lastShownRoutes，seenRouteIds 仍记着
  const s = blank({ stage: 'recommend' });
  for (const d of ['日本', '马尔代夫', '巴厘岛', '三亚', '北欧极光']) await executeTool('search_routes', { destination: d }, s);
  check('P6 （前提）日本线已被挤出 lastShownRoutes', !(s.lastShownRoutes ?? []).some((r) => r.id === 'r-japan'), JSON.stringify(s.lastShownRoutes?.map((r) => r.id)));
  check('P6 search_routes 查到过的线路记进 seenRouteIds', (s.seenRouteIds ?? []).includes('r-japan'), JSON.stringify(s.seenRouteIds));
  check('P6 挤出之后复述日本那条的价：放行', !blocked('日本那条人均 32,800 元', s));
  await executeTool('get_route_detail', { routeId: 'r-xian' }, s);
  check('P6 get_route_detail 查过的线路也记进 seenRouteIds', (s.seenRouteIds ?? []).includes('r-xian'));

  // 点名只认真在说那条线的：客户说成出发地的不算，回复里跟库外目的地同一分句作比的不算
  check('P6 客户「我在北京，想去南极」→「南极入门线人均 28,800 起」：被拦',
    blocked('南极入门线人均 28,800 起', blank({ messages: [customer('我在北京，想去南极')] }), '我在北京，想去南极'));
  check('P6 客户说北京是出发地，回复不提南极只报北京线的价：被拦（出发地不算点名）',
    blocked('这条入门线人均 28,800 起', blank({ messages: [customer('我在北京。想去南极')] }), '我在北京。想去南极'));
  check('P6 客户说想去北京：北京线算点名，放行',
    !blocked('这条人均 28,800 起', blank({ messages: [customer('想去北京看看')] }), '想去北京看看'));
  check('P6 「对标松赞品质的南极线，人均 68,800 起」：被拦',
    blocked('我们可以做一条对标松赞品质的南极线，人均 68,800 起', blank({ messages: [customer('想去南极')] }), '想去南极'));
  check('P6 同一回复里先拿松赞作比、下一句报价：被拦（作比的那句不算点名）',
    blocked('南极线可以对标松赞品质。人均 68,800 起', blank({ messages: [customer('想去南极')] }), '想去南极'));
  check('P6 「埃及金字塔线跟西安兵马俑一样……人均 12,800 起」：被拦',
    blocked('埃及金字塔线跟西安兵马俑一样是历史人文，人均 12,800 起', blank({ messages: [customer('想去埃及')] }), '想去埃及'));
  // 库外地名表里没有的地方：本轮 search_routes 落空（destinationMiss）的目的地同样认得出
  const machu = { name: 'search_routes', args: { destination: '马丘比丘' },
    result: JSON.stringify([{ id: 'r-aurora', destinationMiss: '我们暂时没有「马丘比丘」的现成线路' }]) };
  check('P6 本轮落空的目的地（表外）编线路配召回线路的价：被拦',
    findUnbackedPrices('马丘比丘深度线人均 46,800 起', blank(), '想去马丘比丘', [machu]).length > 0);
  check('P6 本轮落空的目的地，照实推荐召回的线路：放行',
    findUnbackedPrices('马丘比丘暂时没有现成线路。\n最接近的是北欧芬兰极光玻璃屋 8 日，人均 46,800 起', blank(), '想去马丘比丘', [machu]).length === 0);
}

// ---------------- 场景测试（2026-09-25）实测误拦：两次真实报价之差、「5.28 万三档」 ----------------
// 384 轮里护栏拦下的 5 次全是误拦，一次真编的价都没拦到：
//   B11 元旦 3 位 52,140 → 暑假 47,400，「比元旦出发省了 4740 元」「一家三口能省将近 4700 元」
//   C05 7 月 43,560 → 10 月 39,600，「比 7 月旺季省下 3960 元」；A03「人均 2.88 万到 5.28 万三档」读成 55,800
{
  const sanya = blank({ stage: 'quote' });
  await executeTool('create_quote', { routeId: 'r-sanya', travelers: 3, departDate: '2027-01-01' }, sanya);
  await executeTool('create_quote', { routeId: 'r-sanya', travelers: 3, departDate: '2027-07-01' }, sanya);
  check('Q1 报价历史记下两次报价', sanya.quoteHistory?.map((q) => q.total).join() === '52140,47400', JSON.stringify(sanya.quoteHistory));
  check('Q1 B11 两次报价之差（总价）放行', !blocked('每人 15800 元，总价 47400 元。\n\n比元旦出发省了 4740 元。', sanya));
  check('Q1 B11 差额的约数「将近 4700」放行', !blocked('比元旦出发一家三口能省将近 4700 元。', sanya));
  check('Q1 每人差额放行', !blocked('每人比元旦出发省 1,580 元', sanya));
  check('Q1 差额写成中文「四千七」放行', !blocked('比元旦出发能省四千七左右', sanya));
  check('Q1 编的差额照样拦', blocked('比元旦出发省了 5,200 元', sanya));
  check('Q1 差额只放行差额本身，编的团费照样拦', blocked('这条每人 14,800 元', sanya));
  const xj = blank({ stage: 'quote' });
  await executeTool('create_quote', { routeId: 'r-xinjiang', travelers: 2, departDate: '2027-07-12' }, xj);
  await executeTool('create_quote', { routeId: 'r-xinjiang', travelers: 2, departDate: '2027-10-08' }, xj);
  check('Q1 C05 改期后「比 7 月旺季省下 3960 元」放行', !blocked('· 每人 19800 元，两人共 39600 元\n· 比 7 月旺季省下 3960 元', xj));
  // 下过单再改期：订单金额也算真实报价
  const ordered = blank({ stage: 'closing' });
  await executeTool('create_quote', { routeId: 'r-xinjiang', travelers: 2, departDate: '2027-07-12' }, ordered);
  await executeTool('create_order', { routeId: 'r-xinjiang', travelers: 2, departDate: '2027-07-12' }, ordered);
  ordered.quoteHistory = undefined; // 只剩订单这一处出处
  await executeTool('create_quote', { routeId: 'r-xinjiang', travelers: 2, departDate: '2027-10-08' }, ordered);
  check('Q1 订单金额与新报价之差放行', !blocked('比之前那单便宜 3,960 元', ordered));
  // 同一条线自己的「上浮 / 95 折」：「旺季每人多 1,580」「4 位享 95 折每人省 869」这类不必两次报价
  const four = blank({ stage: 'quote' });
  await executeTool('create_quote', { routeId: 'r-sanya', travelers: 4, departDate: '2026-10-03' }, four);
  check('Q1 旺季上浮的差额（4 位总价多 6,004、每人多 1,501）放行', !blocked('10 月旺季比平时 4 位一共多 6,004 元，每人多 1,501 元', four));

  const { parseWanAmounts } = __priceGuardTest;
  const tiers = parseWanAmounts('人均 2.88 万到 5.28 万三档').map((w) => w.value);
  check('Q2 「5.28 万三档」的三是档数：读作 52,800', JSON.stringify(tiers) === '[28800,52800]', JSON.stringify(tiers));
  for (const [t, n] of [['人均 5 万两条', 50000], ['人均 3.58 万一种', 35800], ['人均 2.28 万三款', 22800]] as [string, number][]) {
    const got = parseWanAmounts(t).map((w) => w.value);
    check(`Q2 「${t}」的尾数属于量词：读作 ${n}`, JSON.stringify(got) === `[${n}]`, JSON.stringify(got));
  }
  const A03 = '马尔代夫：一岛一酒店，私密性天花板。现在做的是 11 月到次年 4 月的旺季线路，人均 2.88 万到 5.28 万三档。\n巴厘岛：体验更丰富，人均 2.28 万起。';
  check('Q2 A03 原句放行', !blocked(A03, shown('r-maldives-lite', 'r-maldives', 'r-bali')), JSON.stringify(findUnbackedPrices(A03, shown('r-maldives-lite', 'r-maldives', 'r-bali'), '')));
}

// ---------------- 命中后只删那一句（dropSentences）/ 错价发没发出去过（saidBefore） ----------------
{
  const { dropSentences, findUnbackedPriceHits, saidBefore } = await import('./price-guard.js');
  const drop = (text: string, re: RegExp, replace?: string): string => {
    const m = re.exec(text);
    return m ? dropSentences(text, [{ at: m.index, end: m.index + m[0].length, replace }]).text : text;
  };
  check('D1 只删那一句，同一行后面的句子留着',
    drop('每人 15,800 元，3 人总价 47,400 元。\n\n比 11 月出发省了 5,200 元。这是起价，最终按行程微调。', /5,200/) ===
      '每人 15,800 元，3 人总价 47,400 元。\n\n这是起价，最终按行程微调。');
  check('D1 删分点那一行，不留空分点、不留多余空行',
    drop('按 10 月 8 日出发重新算好了：\n\n· 每人 19800 元\n· 比 7 月旺季省下 3960 元\n· 为起价\n\n您看行吗？', /3960/) ===
      '按 10 月 8 日出发重新算好了：\n\n· 每人 19800 元\n· 为起价\n\n您看行吗？');
  const fake = '南极没有现成线路。我们有一条南极概念的替代线路：\n\n· 南极深度体验线，人均起价 68800 起\n\n您几位出行？';
  check('D2 引出语底下的分点删光了，引出语一并删', drop(fake, /68800/) === '南极没有现成线路。\n\n您几位出行？', JSON.stringify(drop(fake, /68800/)));
  check('D2 引出语底下还有别的分点，引出语留着',
    drop('报价如下：\n· 每人 15800 元\n· 比元旦省 5,200 元\n您看呢？', /5,200/) === '报价如下：\n· 每人 15800 元\n您看呢？');
  check('D3 删的是行尾那句：下一行不接上来', drop('每人 15,800 元。比 11 月省 5,200 元\n这是起价', /5,200/) === '每人 15,800 元。\n这是起价');
  check('D3 句末波浪号断句，区间里的波浪号不断', drop('好的～这条人均 2~3 万，比元旦省 5,200 元～您看呢', /5,200/) === '好的～您看呢',
    JSON.stringify(drop('好的～这条人均 2~3 万，比元旦省 5,200 元～您看呢', /5,200/)));
  check('D4 换成一句话时保留分点符',
    drop('保障有两层：\n· 资金有第三方监管\n· 签电子合同', /第三方监管/, '付款只走官方支付链接。') === '保障有两层：\n· 付款只走官方支付链接。\n· 签电子合同');
  // 位置：normalizeMoneyText 逐字替换，护栏报的位置就是原文位置（全角数字、大写数字也一样）
  const t = '这条人均３８０００元，另一条每人 ¥33,333';
  const hits = findUnbackedPriceHits(t, blank(), '');
  check('D5 命中位置对得上原文', hits.length === 2 && t.slice(hits[0].at, hits[0].end).startsWith('３８０００') && t.slice(hits[1].at, hits[1].end).includes('33,333'),
    JSON.stringify(hits));
  const s = blank({ messages: [{ role: 'agent', content: '这条每人 13,800 元。', at: 0 }] });
  check('D6 之前真发出去过的错价认得出', saidBefore(s, [13800]));
  check('D6 没发出去过的不算', !saidBefore(s, [5200]) && !saidBefore(blank(), [13800]));
}

// ---------------- 规则词 / 预算判断 / 服务承诺（price-rules.ts） ----------------
// 场景测试里模型编的：儿童价、平日价、「比国庆便宜」（10 月全月同价）、报了每人 31,680 还说「在您 3 万预算内」、名额紧张、
// 支持开专票、资金第三方监管、对公账户、帮订机票、电话联系。对不上就删那一句（服务承诺换成「由顾问确认」）
{
  const { dropUnbackedClaims, budgetCap, budgetVerdict } = await import('./price-rules.js');
  const claims = (text: string, s = blank(), calls: { name: string; args: Record<string, unknown>; result?: string }[] = []) =>
    dropUnbackedClaims(text, s, calls);
  const cut = (text: string, s?: Session) => claims(text, s).dropped.length > 0;
  const said = (content: string) => ({ role: 'customer' as const, content, at: 0 });
  const quoted = async (routeId: string, travelers: number, departDate: string, msgs: string[] = []): Promise<Session> => {
    const s = blank({ messages: msgs.map(said) });
    await executeTool('create_quote', { routeId, travelers, departDate }, s);
    return s;
  };

  // R1 没有的价格规则
  for (const t of [
    '小朋友如果按儿童价算还能更划算一些。', '12月中前是平日价，圣诞节到元旦是旺季价。', '孩子几岁按几岁收费我也会帮您核清楚。',
    '如果不到占床年龄我可以帮您看下儿童价。', '现在下单有早鸟优惠。', '孩子的费用会低一些。',
  ]) check(`R1 没有的价格规则被删：${t}`, cut(t));
  for (const t of ['孩子和大人同价，我们没有单独的儿童价，按一位出行算。', '我们不区分平日价和节假日价，只看出发月份。', '儿童价是没有的，孩子也按一位算。']) {
    check(`R1 如实说「没有」不删：${t}`, !cut(t));
  }
  // R2 编造稀缺
  for (const t of ['国庆名额紧张，建议尽快付款锁定哦～', '国庆档期酒店和机票都紧俏。', '7 月档期很抢手。', '国庆档期比较紧，建议尽快完成支付。', '仅剩 2 个名额了。']) {
    check(`R2 编造稀缺被删：${t}`, cut(t));
  }
  for (const t of ['名额以付款为准，付款后顾问会发您行程确认书。', '预算有点紧张的话可以看看贵州。', '行程比较紧凑，第三天要早起。', '颐和安缦的独家资源比较稀缺。']) {
    check(`R2 不是稀缺话术不删：${t}`, !cut(t));
  }
  // R3 比价按季节规则核：三亚最佳季 10 月-次年 3 月
  const s11 = await quoted('r-sanya', 2, '2027-04-05');
  check('R3 「比 11 月还便宜些」（4 月不上浮、11 月上浮）不删', !cut('比 11 月还便宜些，4 月天气也好。', s11));
  check('R3 「五一是标准价，比国庆划算」不删', !cut('五一是标准价，比国庆划算。', s11));
  check('R3 「比元旦出发省了 4740 元」不删', !cut('比元旦出发省了 4740 元。', s11));
  const s10 = await quoted('r-sanya', 2, '2026-10-20');
  check('R3 同在最佳季「比国庆便宜」被删', cut('十一之后人少一大截，价格也比国庆便宜。', s10));
  check('R3 同在最佳季「比十一假期实惠」被删', cut('10 月中下旬出发，价格也比十一假期实惠不少。', s10));
  check('R3 讲规则本身「淡季出发比旺季便宜」不删', !cut('淡季出发比旺季便宜。'));
  check('R3 没报过价、线路也不止一条：「比国庆便宜」没法核，删', cut('价格也比国庆便宜。', shown('r-sanya', 'r-guizhou')));
  check('R3 「十一月」不是国庆', !cut('比十一月便宜一些。', await quoted('r-sanya', 2, '2027-05-01')));
  // R4 拿节日给价格找理由
  for (const t of ['价格便宜是因为 4 月 5 日避开了一些节日出行高峰。', '4 月已经过了春节旺季，酒店和地接价格都回落了。', '这个点走刚好避开十一高峰，性价比比国庆期间高不少。']) {
    check(`R4 节日当定价理由被删：${t}`, cut(t, s11));
  }
  for (const t of ['正好错开国庆高峰，我马上给您出准确报价。', '避开国庆人潮，行程更从容。', '错开旺季还便宜了些。']) {
    check(`R4 说的是人少 / 季节规则，不删：${t}`, !cut(t, s11));
  }
  check('R4 出发月恰好在最佳季的「国庆档期价格上浮 10%」不删', !cut('· 国庆档期价格上浮 10%', await quoted('r-tibet-mid', 2, '2026-10-03')));
  check('R4 出发月不在最佳季的「五一出发会贵一些」被删', cut('五一出发会贵一些。', await quoted('r-sanya', 2, '2027-05-01')));
  // R5 预算判断
  const b15 = await quoted('r-maldives-lite', 2, '2026-12-05', ['hi 想找个honeymoon的trip，budget大概per person 3w']);
  const cap15 = budgetCap(b15);
  check('R5 （前提）读出客户每人 3 万的预算', cap15?.amount === 30000 && cap15.per === 'person' && !cap15.floor, JSON.stringify(cap15));
  check('R5 每人 31,680 还说「在您 3 万预算内」：删', cut('这个价格在您 3 万预算内。', b15));
  const c14 = await quoted('r-sichuan-mid', 3, '2026-10-15', ['算了 爸妈难得出去一趟 每人3万以内都行 住好点']);
  check('R5 每人 21,780、预算每人 3 万：不删', !cut('成都九寨这条正好在您预算内。', c14));
  check('R5 同一句里的价在预算内：不删', !cut('· 顶级奢华住宿，人均 28800 起，在您预算内', c14));
  check('R5 同一句里的价超了预算：删', cut('· 顶级奢华住宿，人均 42800 起，在您预算内', c14));
  check('R5 客户没说过预算：删', cut('刚好在您预算内。', await quoted('r-guizhou', 2, '2026-10-08')));
  check('R5 条件句「如果想控制在预算内」不删', !cut('如果想控制在预算内，我帮您看看贵州。', b15));
  check('R5 推测「更容易落在预算里」不删', !cut('换一条便宜些的，两位总价更容易落在预算里。', b15));
  const a04 = await quoted('r-bali', 2, '2026-10-30', ['我们刚领证 想去马尔代夫度蜜月 两个人预算一共3万左右']);
  check('R5 总预算 3 万、两位总价 50,160：「在您预算内」删', cut('两位共 50,160 元，在您预算内。', a04));
  check('R5 下过单、lastQuote 清掉了：按订单人数折算总价', !cut('2 人总价 58960 元（人均 29480，仍在您 3 万预算内）。', await (async () => {
    const s = await quoted('r-tibet-mid', 2, '2026-10-02', ['预算每人3万，报个价']);
    await executeTool('create_order', { routeId: 'r-tibet-mid', travelers: 2, departDate: '2026-10-02' }, s);
    return s;
  })()));
  // create_quote 结果带 withinBudget 与差额，差额记进 budgetGaps
  const v = budgetVerdict(b15, { perPerson: 31680, total: 63360, travelers: 2 });
  check('R5 budgetVerdict：超预算带每人差额', v?.fields.withinBudget === false && v.fields.overBudgetPerPerson === 1680 && v.gap === 1680, JSON.stringify(v));
  check('R5 create_quote 把差额记进 budgetGaps', b15.budgetGaps?.includes(1680) === true, JSON.stringify(b15.budgetGaps));
  check('R5 总预算按总价比', budgetVerdict(a04, { perPerson: 25080, total: 50160, travelers: 2 })?.fields.overBudgetTotal === 20160);
  const unclear = blank({ messages: [said('两个人预算3万')] });
  check('R5 没说每人还是总共：不判在不在预算内', budgetVerdict(unclear, { perPerson: 15800, total: 31600, travelers: 2 })?.fields.withinBudget === undefined);
  check('R5 说的是下限：不判', budgetVerdict(blank({ messages: [said('预算至少每人3万')] }), { perPerson: 45800, total: 91600, travelers: 2 }) === undefined);
  // R6 做不到的服务：换成「由顾问确认」
  const svc = (t: string) => claims(t).text;
  check('R6 专票', svc('可以的，我们支持开公司抬头的增值税专用发票。其他还有想了解的吗？') === '发票（含专票）怎么开，由顾问跟您确认。其他还有想了解的吗？',
    svc('可以的，我们支持开公司抬头的增值税专用发票。其他还有想了解的吗？'));
  check('R6 资金监管 / 对公账户 / 先看材料再付款', !/第三方监管|对公|没问题再付款/.test(svc(
    '· 下单走我们官方支付链接，资金有第三方监管\n· 付款是对公账户\n· 您下单后我们可以先把这些材料发您确认，没问题再付款。')));
  check('R6 机票代订、含机票报价', !/帮您询价|含机票的完整报价/.test(svc('机票我可以帮您询价一起订。\n需要我把含机票的完整报价算一份吗？')));
  check('R6 档期余位', svc('10月30日出发档期没问题。') === '具体档期和余位由顾问跟您确认。');
  check('R6 电话联系 → 微信', svc('好的，已经为您转接资深顾问啦，他会尽快电话联系您～') === '好的，已经为您转接资深顾问啦，他会尽快在微信上联系您～');
  check('R6 给您打电话 → 微信', svc('顾问稍后给您打电话。') === '顾问稍后在微信上联系您。');
  for (const t of [
    '下单后签电子合同，付款只走我们发给您的官方支付链接。', '发票的事由顾问跟您确认。', '机票和签证我可以让顾问帮您对接办理。',
    '这条费用不含国际机票和签证。', '合同发票齐全，您放心。', '不用对公转账，走官方支付链接就行。', '还有名额吗？这个要顾问确认。',
  ]) check(`R6 可以说的事实 / 已经交给顾问的，不动：${t}`, svc(t) === t, svc(t));
}

// ---------------- 复核（2026-09-25）：差额只在比价的小句里认 / 如实的话不误删 / 删分点带走续行 / 预算断言只删小句 ----------------
{
  const { dropUnbackedClaims } = await import('./price-rules.js');
  const { dropSentences } = await import('./price-guard.js');
  const said = (content: string) => ({ role: 'customer' as const, content, at: 0 });
  const kept = (t: string, s = blank()) => dropUnbackedClaims(t, s).text === t;
  // X1 一次报价自己跟「不上浮」比出来的差（1,680 / 3,360）和它的整百整千约数，不能给编的加价、单房差、定金放行
  const one = blank({ stage: 'quote' });
  await executeTool('create_quote', { routeId: 'r-yunnan-mid', travelers: 2, departDate: '2026-11-10' }, one);
  for (const t of ['每人再加 2,000 元就能升级到洱海边的海景房。', '加 3000 元可以升级成双床海景套房。', '单房差 3,400 元。', '总价 3,000 元的定金。']) {
    check(`X1 编的加价被拦：${t}`, blocked(t, one), JSON.stringify(findUnbackedPrices(t, one, '')));
  }
  check('X1 旺季上浮的差额照样放行', !blocked('11 月是最佳季，每人多 1,680 元。', one));
  const sanya2 = blank({ stage: 'quote' });
  await executeTool('create_quote', { routeId: 'r-sanya', travelers: 3, departDate: '2027-01-01' }, sanya2);
  await executeTool('create_quote', { routeId: 'r-sanya', travelers: 3, departDate: '2027-07-01' }, sanya2);
  for (const t of ['总价再加 5,000 元就能升级到海景套房。', '签证加机票每人大概 4,700 元。']) check(`X1 两次报价之差的约数不给别的费用放行：${t}`, blocked(t, sanya2));
  check('X1 两次报价之差的约数在比价里照样放行', !blocked('比元旦出发一家三口能省将近 4700 元。', sanya2));
  check('X1 「小朋友每人少 1,680 元」按编的儿童价删', !kept('小朋友每人少 1,680 元。', one));
  check('X1 「孩子不占床每人可以减 2,000 元」按编的规则删', !kept('孩子不占床每人可以减 2,000 元。', one));

  // X2 「不含机票的价格」是照 exclusions 如实说，不是答应代订
  for (const t of ['以上是不含机票的价格，往返机票需要您自理。', '这个报价是不含机票的价格。']) check(`X2 不动：${t}`, kept(t), dropUnbackedClaims(t, blank()).text);
  check('X2 「含机票的完整报价」照样换掉', !kept('需要我把含机票的完整报价算一份吗？'));

  // X3 如实的话不误删：房间面积、乐园门票、请假天数、人少景美、先看方案书、和大人同价、条件句推进下单
  const mv = blank({ lastQuote: { routeId: 'r-maldives', routeTitle: 'x', travelers: 2, perPerson: 52800, total: 105600 } });
  for (const t of ['水屋房间面积有限，一家四口建议订两间。', '3 岁以下小朋友免费入园，以乐园规定为准。', '因为您只有 5 天假期，推荐这条 5 日的线路，价格也合适。',
    '11 月中旬出发正好错开国庆高峰，人少景美，性价比很高。', '您可以先看方案书确认行程，满意后再付款。', '儿童价格跟大人一样，都按一位出行算。',
    '小朋友价格和大人一样，按一位算。', '档期没问题的话，我这边就给您下单。']) check(`X3 不动：${t}`, kept(t, mv), dropUnbackedClaims(t, mv).text);
  for (const t of ['小朋友按儿童价更划算。', '国庆档期很抢手。', '小朋友免费，团费只算大人。', '档期没问题。']) check(`X3 照删：${t}`, !kept(t, mv));

  // X4 预算断言和报价写在同一句：只删断言那个小句
  const b = blank({ messages: [said('预算每人2万8 想去西藏')] });
  await executeTool('create_quote', { routeId: 'r-tibet-mid', travelers: 2, departDate: '2026-10-05' }, b);
  const x4 = dropUnbackedClaims('10 月 5 日出发每人 29,480 元，2 位总价 58,960 元，基本在您预算内。要不要我先给您出一份方案书？', b, [{ name: 'create_quote', args: {} }]).text;
  check('X4 只删「基本在您预算内」', x4 === '10 月 5 日出发每人 29,480 元，2 位总价 58,960 元。要不要我先给您出一份方案书？', x4);
  const x4b = dropUnbackedClaims('4 月 5 日出发每人 15,800 元，价格便宜是因为避开了节日高峰。', await (async () => {
    const s = blank(); await executeTool('create_quote', { routeId: 'r-sanya', travelers: 2, departDate: '2027-04-05' }, s); return s;
  })()).text;
  check('X4 编的理由和报价同句：只删理由那个小句', x4b === '4 月 5 日出发每人 15,800 元。', x4b);

  // X5 删分点行时，它底下缩进的续行一起删；删掉的句子后面以「所以」开头的，去掉连接词
  const list = '给您挑了两条：\n· 云南 丽江大理·洱海古城 6 日（人均 16,800 起）\n  洱海边骑行、古城漫步\n· 贵州 荔波小七孔 6 日（人均 13,800 起）\n  苗寨长桌宴、非遗蜡染体验\n您更喜欢哪种？';
  const at = list.indexOf('13,800');
  const x5 = dropSentences(list, [{ at, end: at + 6 }]).text;
  check('X5 续行跟着分点一起删', x5 === '给您挑了两条：\n· 云南 丽江大理·洱海古城 6 日（人均 16,800 起）\n  洱海边骑行、古城漫步\n您更喜欢哪种？', x5);
  const x5b = dropSentences('国庆出发比 11 月贵一些。所以如果预算有限，可以考虑 11 月。', [{ at: 0, end: 3 }]).text;
  check('X5 「所以」接不上前文就去掉', x5b === '如果预算有限，可以考虑 11 月。', x5b);
}

// ---------------- 第二轮验证（2026-09-25）：季节判断 / 预算判断的更多说法 / 做不到的加减 / 高反担保 / 按句删后残句 ----------------
{
  const { dropUnbackedClaims } = await import('./price-rules.js');
  const guard = await import('./price-guard.js') as Record<string, unknown>;
  const said = (content: string) => ({ role: 'customer' as const, content, at: 0 });
  const quotedS = async (routeId: string, travelers: number, departDate: string, msgs: string[] = []): Promise<Session> => {
    const s = blank({ messages: msgs.map(said) });
    await executeTool('create_quote', { routeId, travelers, departDate }, s);
    return s;
  };
  const cutIn = (t: string, s: Session, calls: { name: string; args: Record<string, unknown>; result?: string }[] = [], travelers?: number) =>
    dropUnbackedClaims(t, s, calls, travelers ? { travelers } : undefined).dropped.length > 0;

  // Z1 季节判断按线路 bestSeason 核（A09：丽江大理最佳季 3-5 月、9-11 月；B01：九寨 4-11 月；A04：巴厘岛 4-10 月）
  const yn = await quotedS('r-yunnan-mid', 4, '2026-10-24');
  check('Z1 「挪到 11 月底或 12 月初就按标准价」（11 月在最佳季）删', cutIn('如果把行程挪到 11 月底或 12 月初，就按标准价走。', yn));
  check('Z1 「换到11月错峰」接在最佳季那句后面：删', cutIn('10月是这条线的最佳出行季，价格上浮了10%。换到11月或明年初错峰，我按日期给您实报一个价，对比着看。', yn));
  check('Z1 「11 月是淡季」删', cutIn('11 月是淡季，价格会低一些。', yn));
  check('Z1 「12 月出发不在最佳季，不上浮」对得上：不删', !cutIn('12 月出发不在最佳季，不上浮。', yn));
  check('Z1 「10 月是最佳出行季，上浮 10%」对得上：不删', !cutIn('10 月是这条线的最佳出行季，价格上浮 10%。', yn));
  check('Z1 「12 月是最佳季、上浮」对不上：删', cutIn('12 月也是这条线的最佳季，价格上浮 10%。', yn));
  check('Z1 「10月下旬错峰出行」说的是躲国庆人潮：不删', !cutIn('10月下旬错峰出行，正合适。报价给您：', yn));
  const jz = await quotedS('r-sichuan-mid', 2, '2026-10-18');
  check('Z1 B01「换到11月中以后错开」（九寨最佳季到 11 月）删',
    cutIn('10月18号在最佳季内，如果您能换到11月中以后错开，我可以按那个日期重新实报一版价格。', jz));
  const bali = await quotedS('r-bali', 2, '2026-11-15');
  check('Z1 巴厘岛「11月不在最佳季，按标准价，不上浮」对得上：不删', !cutIn('11月不在最佳季，按标准价，不上浮。', bali));
  check('Z1 句里点了线路就按那条核：「云南 11 月是淡季」删', cutIn('云南 11 月是淡季，人少价低。', blank()));
  check('Z1 「马代 5 月不在最佳季，按标准价」对得上：不删', !cutIn('马代 5 月不在最佳季，按标准价。', blank()));

  // Z2 预算判断的其他说法（A04：两位一共 3 万，巴厘岛每人 22,800；B14：「刚好卡在您预算内」）
  const a04 = blank({ messages: [said('我们刚领证 想去马尔代夫度蜜月 两个人预算一共3万左右')] });
  const baliSearch = [{ name: 'search_routes', args: { destination: '巴厘岛' }, result: JSON.stringify([{ id: 'r-bali' }]) }];
  check('Z2 人数只在客户那句预算里：「两位的话在 3 万预算内完全可行」删',
    cutIn('我们有一条巴厘岛乌布雨林蜜月 6 日，人均 22800 起，两位的话在 3 万预算内完全可行：', a04, baliSearch));
  check('Z2 「预算按这条算很宽裕」删', cutIn('巴厘岛乌布雨林蜜月 6 日，每人 22800 起。两位的预算按这条算很宽裕，还能升房型或加天数。', a04, baliSearch, 2));
  check('Z2 「这个预算玩这条绰绰有余」删', cutIn('人均 22800 起，这个预算玩这条绰绰有余。', a04, baliSearch, 2));
  check('Z2 「刚好卡在您预算内」删', cutIn('人均 22800 起，刚好卡在您预算内。', a04, baliSearch, 2));
  const rich = blank({ messages: [said('预算每人3万 两个人')] });
  check('Z2 真在预算内的「预算很宽裕」不删', !cutIn('人均 22800 起，两位的预算按这条算很宽裕。', rich, baliSearch, 2));
  check('Z2 「预算不太够」不是在说够：不删', !cutIn('人均 22800 起，按您的预算不太够，差得不少。', a04, baliSearch, 2));

  // Z3 做不到的加减：线路天数和住宿是固定的
  check('Z3 「还能升房型或加天数」删', cutIn('这条性价比很高，还能升房型或加天数。', blank()));
  check('Z3 「可以帮您缩短天数」删', cutIn('嫌贵的话可以帮您缩短天数。', blank()));
  check('Z3 如实说做不到：不删', !cutIn('天数和酒店都是固定的，没法加天数，也换不了房型。', blank()));

  // Z4 高反担保要有海拔数据撑着（B03：客户怕高反要换云南，丽江大理那条冰川大索道 4500 米）
  const tibet = shown('r-tibet-lux', 'r-tibet-mid');
  check('Z4 「云南线路大多在 2000 多米，基本不用担心高反」删', cutIn('云南确实更安心——线路大多在 2000 多米，基本不用担心高反，蜜月也合适。', tibet));
  check('Z4 「不会有高原反应」删', cutIn('放心，这条不会有高原反应。', shown('r-yunnan-mid')));
  check('Z4 三亚全程海拔 50 米「不用担心高反」有数据撑着：不删', !cutIn('三亚全程海拔不到 50 米，不用担心高反。', shown('r-sanya')));

  // Z6 验证轮真实回复里说对了的季节、海拔不能误删（按当时的会话状态回放出来的几处）；「——」后面的空头承诺只删那半句
  const gz = await quotedS('r-guizhou', 2, '2026-10-01');
  check('Z6 「换到非最佳季的日期（比如 11 月去，价格会低不少）」贵州 4-10 月：不删',
    !cutIn('如果这个价不合适，您两个选择：一是看看我们现成更便宜的线路，二是换到非最佳季的日期（比如 11 月去，价格会低不少）。', gz));
  const sy = await quotedS('r-sanya', 3, '2027-04-05');
  check('Z6 「价格便宜是因为 11 月是最佳出行季…4 月不在最佳季」三亚：不删',
    !cutIn('价格便宜是因为 11 月是这条线的最佳出行季，每人上浮 10%；4 月不在最佳季，按标准价走，所以每人省了 1,580 元。', sy));
  check('Z6 「我实报了11月15日（非最佳季）给您对比」巴厘岛：不删', !cutIn('我实报了11月15日（非最佳季）给您对比：', bali));
  const bali10 = await quotedS('r-bali', 2, '2026-10-30');
  check('Z6 「出了 10 月（比如 11 月出发）就不在最佳季」：10 月是分界，不删',
    !cutIn('如果日期上灵活的话，出了 10 月（比如 11 月出发）就不在最佳季，按标准价走，会低不少。', bali10));
  check('Z6 同一行前面点了马尔代夫：「11月-次年4月是最佳季」按马代核，不删',
    !cutIn('马尔代夫：纯粹的海岛度假，私密性最强。11月-次年4月是最佳季，现在出发（9-10月）反而避开高峰。', bali10));
  check('Z6 上一行是贵州：「全程最高约 1200 米，没有高原段」不删',
    !cutIn('稻城亚丁这条最高要到约 4700 米。\n· 贵州荔波小七孔·西江千户苗寨 6 日\n· 全程最高约 1200 米，没有高原段', shown('r-sichuan-lux', 'r-guizhou')));
  check('Z6 「帮您找找海拔友好的方向」是提议不是担保：不删', !cutIn('我可以再帮您找找海拔友好又能看雪山的方向。', shown('r-sichuan-lux')));
  const dash = dropUnbackedClaims('· 巴厘岛 乌布雨林蜜月 6 日，每人 22800 起——预算还能升级房型或多住一晚', bali10).text;
  check('Z6 「每人 22800 起——还能升级房型」只删破折号后面那半句', dash === '· 巴厘岛 乌布雨林蜜月 6 日，每人 22800 起', dash);

  // Z5 按句删完剩下残句：还指着删掉的那条线、宣称报价却没有一个数、只剩一句问话
  const stranded = guard.strandedAfterDrop as ((before: string, after: string) => boolean) | undefined;
  const sd = (b: string, a: string) => typeof stranded === 'function' && stranded(b, a);
  check('Z5 （前提）price-guard 导出 strandedAfterDrop', typeof stranded === 'function');
  check('Z5 线路名和价删了、剩「这条的亮点」：残句',
    sd('先说个实际情况：我们马代的线路起步是中央格兰德一价全包 5 日，人均 28,800 起，两位的话总价 5.7 万左右。\n\n这条的亮点：\n· 一价全包\n· 出别墅就能下水',
      '这条的亮点：\n· 一价全包\n· 出别墅就能下水'));
  check('Z5 「按 4 人重新报价」却一个价都没有：残句',
    sd('按 4 人重新报价：\n西安 兵马俑 5 日\n· 每人 13384 元\n· 合计 53536 元\n报价为起价。', '按 4 人重新报价：\n西安 兵马俑 5 日\n报价为起价。'));
  check('Z5 推荐删光了、只剩问句：残句',
    sd('云南很合适：\n· 松赞 8 日（人均 38800 起）\n· 版纳 5 日（人均 18800 起）\n想看雪山古城，还是想躺酒店泡泳池？', '想看雪山古城，还是想躺酒店泡泳池？'));
  check('Z5 删掉一句编的差额、报价还在：不算残句',
    !sd('这条每人 15,800 元，两位 31,600 元。比 11 月省 3,000 元。', '这条每人 15,800 元，两位 31,600 元。'));
  check('Z5 本来就没价、只是删了一句规则词：不算残句',
    !sd('这条的亮点是海景房。国庆名额紧张。您几位出行？', '这条的亮点是海景房。您几位出行？'));
}

// ---------------- 第三轮复核（2026-09-25）：季节小句不借前面的月份 / 千分位不断小句 / 放开预算 / 条件句的「预算够」/ 残句只看线路名 ----------------
{
  const { dropUnbackedClaims, budgetCap } = await import('./price-rules.js');
  const { strandedAfterDrop } = await import('./price-guard.js');
  const said = (content: string) => ({ role: 'customer' as const, content, at: 0 });
  const quotedS = async (routeId: string, travelers: number, departDate: string, msgs: string[] = []): Promise<Session> => {
    const s = blank({ messages: msgs.map(said) });
    await executeTool('create_quote', { routeId, travelers, departDate }, s);
    return s;
  };
  const out = (t: string, s: Session, calls: { name: string; args: Record<string, unknown>; result?: string }[] = [], travelers?: number) =>
    dropUnbackedClaims(t, s, calls, travelers ? { travelers } : undefined).text;

  // Q1 丽江大理 10 月 24 日报了价（最佳季 3-5、9-11 月）。「换到淡季 / 避开旺季 / 换个不在最佳季的日子」说的是别的日子，
  // 不拿前面那个 10 月去核——此前整句删，客户问「为什么这么贵」没了答案；G4 删完剩「10 月…每人 16,800 元」，成了一个错价
  const yn = await quotedS('r-yunnan-mid', 2, '2026-10-24');
  for (const t of [
    '10 月是这条线的最佳出行季，价格上浮 10%，换到淡季价格会低一些。',
    '您 10 月 24 日出发正赶上最佳季，价格上浮 10%，如果能避开旺季，价格就能回到标准价。',
    '两位合计 36,960 元。10 月是最佳季所以上浮了 10%，想省点的话可以避开最佳季出发，每人 16,800 元。',
    '10 月在最佳季，每人 18,480 元；换个不在最佳季的日子就是标准价 16,800 元。',
    '10 月 24 日出发正赶上最佳季，每人 18,480 元，两位 36,960 元，要是能避开旺季，就回到标准价 16,800 元。',
  ]) check(`Q1 说的是换到别的日子，不借前面的 10 月：不删 ${t}`, out(t, yn) === t, out(t, yn));
  // 换过去的那个日子自己说了月份的照核：11 月也在最佳季
  check('Q1 「改到 11 月出发，就是标准价」照删', out('如果改到 11 月出发，就是标准价 16,800 元。', yn) === '', out('如果改到 11 月出发，就是标准价 16,800 元。', yn));
  check('Q1 「改到 12 月出发，就不在最佳季」照留（12 月不在最佳季）',
    out('要是改到 12 月出发，就不在最佳季，按标准价 16,800 元。', yn) === '要是改到 12 月出发，就不在最佳季，按标准价 16,800 元。');

  // Q2 小句按逗号切时，「16,800」里的逗号不是分隔：此前删一个以千分位价收尾的小句只删到「16」，客户收到「每人 18,480 元,800 元」
  for (const t of [
    '10 月在最佳季，每人 18,480 元；换到 11 月就是标准价 16,800 元。',
    '10 月 24 日出发每人 18,480 元，两位 36,960 元，改到 11 月就回到标准价 16,800 元。',
  ]) {
    const o = out(t, yn);
    check(`Q2 删小句不把千分位的价切成两半：${t}`, !/元,\d{3}/.test(o) && !/价\s*16(?![,\d])/.test(o), o);
  }

  // Q3 客户说了「预算不是问题 / 不设上限」：以这句为准，之前说的数不再是上限
  check('Q3 「预算不是问题」之后不再拿「一共3万」比',
    budgetCap(blank({ messages: [said('我们两个人 预算一共3万 想去巴厘岛'), said('算了 预算不是问题 想住好一点的 马尔代夫有啥')] })) === undefined);
  check('Q3 「钱不是问题 预算不设上限」', budgetCap(blank({ messages: [said('两个人预算一共4万 想去云南'), said('钱不是问题 预算不设上限 看看最好的')] })) === undefined);
  check('Q3 放开之后又说了数：按新说的',
    budgetCap(blank({ messages: [said('预算不设上限'), said('算了还是每人2万以内吧')] }))?.amount === 20000);
  check('Q3 同一句里放开又给了数（「预算不是问题 每人5万以内都行」）：按这个数',
    budgetCap(blank({ messages: [said('预算不是问题 每人5万以内都行')] }))?.amount === 50000);

  // Q4 「预算够 / 充足 / 宽裕的话」是条件，「预算还差一点才够」是如实说不够：都不是在断言在预算内
  const bali = [{ name: 'search_routes', args: { destination: '巴厘岛' }, result: JSON.stringify([{ id: 'r-bali' }]) }];
  const five = blank({ messages: [said('两个人 预算一共5万 想去巴厘岛')] });
  for (const [t, s] of [
    ['预算够的话更推荐马代那条。', five],
    ['预算充足的话，更推荐马代这条，每人 35,800 元起。', five],
    ['预算宽裕的话，推荐松赞线。', blank({ messages: [said('两个人一共3万')] })],
    ['巴厘岛每人 22,800 元起，两位 45,600 元，预算还差一点才够。', blank({ messages: [said('两个人 预算一共4万')] })],
  ] as [string, Session][]) check(`Q4 不是在说在预算内：不删 ${t}`, out(t, s, bali, 2) === t, out(t, s, bali, 2));
  check('Q4 真在断言的「预算很宽裕」照删（两位一共 3 万、巴厘岛两位 45,600）',
    out('人均 22,800 起，两位的预算按这条算很宽裕。', blank({ messages: [said('两个人预算一共3万左右')] }), bali, 2) === '人均 22,800 起。');

  // Q5 残句：「这条 / 它」只在删掉的那部分点过线路名、剩下的一条都没点时才算没了指代
  check('Q5 只删了价、原文本来就用「这条线」指着前文：不算残句',
    !strandedAfterDrop('这条线住的是古城精品客栈，每人 16,800 元起。行程节奏很松，适合带爸妈。您几位出行？', '这条线住的是古城精品客栈。行程节奏很松，适合带爸妈。您几位出行？'));
  check('Q5 线路名还在（「推荐北欧极光 8 日。它的玻璃屋…」）：不算残句',
    !strandedAfterDrop('推荐北欧极光 8 日，人均 46,800 元起。它的玻璃屋可以躺着看极光。', '推荐北欧极光 8 日。它的玻璃屋可以躺着看极光。'));
  check('Q5 线路名跟着价一起删了、只剩「这条线路」：仍是残句',
    strandedAfterDrop('丽江大理 6 日每人 16,800 元起，这条线路住古城客栈，节奏慢。', '这条线路住古城客栈，节奏慢。'));
}

// ---------------- 第四轮定点修复（2026-09-25）：季节护栏误删说对的话 / 资金托管往顾问引不换、不重复 / 「按这个数找线路」不是成交 ----------------
{
  const { dropUnbackedClaims } = await import('./price-rules.js');
  const said = (content: string) => ({ role: 'customer' as const, content, at: 0 });
  const quotedS = async (routeId: string, travelers: number, departDate: string, msgs: string[] = []): Promise<Session> => {
    const s = blank({ messages: msgs.map(said) });
    await executeTool('create_quote', { routeId, travelers, departDate }, s);
    return s;
  };
  const dropped = (t: string, s: Session) => dropUnbackedClaims(t, s).dropped;

  // S1 验证轮里说对了、却被季节护栏删掉的 4 句原文（整条回复原样回放）：一个字都不删
  const kept: [string, string, Session][] = [
    // A04 第 2 遍第 4 轮，巴厘岛 4-10 月：「不用上浮」此前被当成在说 11 月上浮，删完只剩「只有两个变量能动：」加 1 个分点
    ['A04 巴厘岛「4–10 月是最佳出行季…改到 11 月出发就按标准价，不用上浮」',
      '确实不便宜，我理解您想压一压。\n\n不过跟您说实话，价格我们只有两个变量能动：\n· 这条线 4–10 月是最佳出行季，价格上浮 10%；如果你们俩愿意改到 11 月出发，就按标准价走，不用上浮\n· 线路的天数和酒店是固定的，没有降配版\n\n11 月初去巴厘岛也是不错的季节。您看要不改到 11 月？给我个具体日期，我按那天给您实报一个准确价，能省多少一目了然。',
      await quotedS('r-bali', 2, '2026-10-30')],
    // A18 第 2 遍第 2 轮，贵州 4-10 月：「错开 10 月这个旺季」的 10 月是要躲的那个月
    ['A18 贵州「可以错开 10 月这个旺季出发，我按具体日期实报」',
      '贵州这条先按 2 位、国庆出发给您报好了：\n\n贵州 荔波小七孔·西江千户苗寨 6 日\n· 每人 17380 元，2 位合计 34760 元\n· 10 月是这条线的最佳出行季，价格上浮 10%\n· 比您说的每人一万二超了 5380 元，这个是起价、按最终行程微调\n\n超的这部分主要是五星精选住宿和非遗手作这些独家体验。如果超得多，可以错开 10 月这个旺季出发，我按具体日期实报看看能降多少——您看哪天方便？',
      await quotedS('r-guizhou', 2, '2026-10-01', ['预算不多 人均一万二以内 国庆想出去玩 有推荐吗'])],
    // B09 第 2 遍第 3 轮：「不在贵州这条线的最佳季」中间夹着线路名
    ['B09 「2 月不在贵州这条线的最佳季，所以按标准价，不上浮」',
      '贵州 荔波小七孔·西江千户苗寨 6 日，2 位出行：\n\n每人 15,800 元 × 2 位 = 总价 31,600 元\n\n刚查了下，2 月不在贵州这条线的最佳季，所以按标准价，不上浮。价格和三亚那条一样，就是多一天行程。\n\n您看看更想走哪条？定了我把详细行程发您过目。',
      await quotedS('r-guizhou', 2, '2027-02-01')],
    // C13 第 1 遍第 2 轮，芬兰极光 11-3 月：「元旦后错峰」躲的是节日人潮
    ['C13 极光「价格和 12 月 28 日出发一样，跨年改成了元旦后错峰」',
      '推到 1 月 2 日出发没问题，帮您按新日期算好了：\n\n北欧芬兰极光玻璃屋 8 日 · 2027 年 1 月 2 日出发\n· 每人：51,480 元\n· 2 位总价：102,960 元\n（1 月为最佳出行季，价格上浮 10%；起价，按最终行程微调）\n\n价格和 12 月 28 日出发一样，跨年改成了元旦后错峰，行程不变。确定的话我就帮您下单～',
      await quotedS('r-aurora', 2, '2027-01-02')],
  ];
  for (const [name, t, s] of kept) check(`S1 说对了的季节不删：${name}`, dropped(t, s).length === 0, JSON.stringify(dropped(t, s)));
  // 归属说不准：这句没点名，最近报价是丽江大理（12 月不在最佳季），回复前面推的是三亚（12 月在）——对得上三亚，不删
  const yn = await quotedS('r-yunnan-mid', 2, '2026-10-24');
  check('S1 回复里还有别的线在场、这句没点名：对得上其中一条就不删',
    dropped('再给您推一条：三亚亲子奢华度假 5 日，人均 15,800 起。\n\n亚特兰蒂斯海景房，孩子玩水方便。\n\n12 月是最佳季，价格上浮 10%。', yn).length === 0);
  // 上一轮必须删的照删
  check('S1 A09「换到不在最佳季的月份（比如11月底、12月）」照删（11 月在丽江大理最佳季，12 月在梅里线最佳季，跟在场的两条都对不上）',
    dropped('确实不便宜，跟您说下实情：\n\n· 这条是我们云南最实惠的一条了（另一条梅里雪山环线是顶奢档，4.58万起）\n· 10月正是这条线的最佳出行季，价格上浮了10%，4人95折已经是折扣上限\n\n' +
      '两个方向您挑：换到不在最佳季的月份（比如11月底、12月），我按具体日期实报看能省多少；或者我为您转接资深顾问，看看有没有申请空间。您想先看哪个？',
    await quotedS('r-yunnan-mid', 4, '2026-10-24')).length === 1);
  check('S1 「错开12月，11月底按标准价」照删（11 月在丽江大理最佳季）', dropped('可以错开12月，11月底按标准价走。', yn).length === 1);
  check('S1 「11 月是淡季」照删', dropped('11 月是淡季，价格会低一些。', yn).length === 1);
  check('S1 「12 月也是这条线的最佳季，上浮」照删', dropped('12 月也是这条线的最佳季，价格上浮 10%。', yn).length === 1);
  check('S1 「11 月不用上浮」照删（11 月在最佳季）', dropped('改到 11 月出发就不用上浮了。', yn).length === 1);

  // S2 资金托管：往顾问那儿引的不换；别处已经说了「只走官方支付链接」的只删不补（B04 两遍、guard-13）
  const plain = blank({ stage: 'recommend' });
  const b04 = '理解您的顾虑，这个钱的安全问题确实得先问清楚。\n\n照实跟您说能确认的部分：\n\n· 付款只走我们官方发给您的支付链接，就是您下单后我发给您的那条，别的任何转账要求都不用理\n· 下单后会签电子合同，行程、费用、责任都落在合同里\n\n' +
    '至于资金托管这类制度细节，我不替公司打包票，由顾问跟您确认、给您看相关材料。\n\n您可以先不出钱，我先把这条线的详细行程发您看看，觉得靠谱再谈付款，要吗？';
  const b04out = dropUnbackedClaims(b04, plain).text;
  check('S2 B04「资金托管…由顾问跟您确认」原样保留', b04out === b04, b04out);
  check('S2 guard-13「资金监管这块我确认不了，由顾问跟您确认」不换', dropUnbackedClaims('资金监管这块我确认不了，由顾问跟您确认。', plain).text === '资金监管这块我确认不了，由顾问跟您确认。');
  check('S2 「以合同约定为准」不换', dropUnbackedClaims('资金托管的具体安排以合同约定为准。', plain).text === '资金托管的具体安排以合同约定为准。');
  const dup = dropUnbackedClaims('· 付款只走我们官方发给您的支付链接\n· 资金有第三方监管，放心', plain).text;
  check('S2 前面已说「只走官方支付链接」：编的第三方监管只删不补，不重复', dup === '· 付款只走我们官方发给您的支付链接', dup);
  check('S2 光带个「顾问」仍在担保：「资金有第三方监管，顾问会联系您」照换',
    dropUnbackedClaims('资金有第三方监管，顾问会联系您。', plain).text === '付款只走我们发给您的官方支付链接。');
  check('S2 编的付款流程「下单后顾问核对了再付款」照换',
    dropUnbackedClaims('下单后顾问核对了再付款。', plain).text === '付款只走我们发给您的官方支付链接。');

  // S3 「按这个数帮您找匹配的线路」说的是预算，不是成交语境：工具给的超预算差额 20,160 照发（A04 第 2 遍第 3 轮）
  const a04 = await quotedS('r-bali', 2, '2026-10-30', ['我们刚领证 想去马尔代夫度蜜月 两个人预算一共3万左右']);
  check('S3 （前提）create_quote 记下总价差额 20160', a04.budgetGaps?.includes(20160) === true, JSON.stringify(a04.budgetGaps));
  const a04text = '巴厘岛乌布雨林蜜月 6 日 · 10 月 30 日出发 · 2 位\n\n每人 25,080 元\n总价 50,160 元\n（10 月是这条线的最佳出行季，价格上浮了 10%；这是起价，按最终行程微调）\n\n跟您俩 3 万的预算比，总共超出 20,160 元。\n\n' +
    '如果这个总价不太好接受，您俩也可以考虑换个月份错开最佳季出发，我可以按那个日期重新实报，价格可能会低一些。或者告诉我每人预算能放宽到多少，我按这个数帮您找匹配的线路。您怎么看？';
  check('S3 A04「我按这个数帮您找匹配的线路」：差额 20,160 不拦', !blocked(a04text, a04, '巴厘岛可以 10月30号出发 两个人报个价'),
    JSON.stringify(findUnbackedPrices(a04text, a04, '巴厘岛可以 10月30号出发 两个人报个价')));
  const closing = __priceGuardTest.hasClosingPrice as (s: string) => boolean;
  for (const t of ['我按这个数帮您找匹配的线路。', '您说个数，我按这个数给您推荐。', '我按这个预算帮您筛一下。']) check(`S3 「${t}」不是成交语境`, !closing(t));
  for (const t of ['好的，就按这个数给您锁定。', '您预算 6800，行，就按这个数来。', '好的，就按这个数帮您下单看看']) check(`S3 「${t}」仍是成交语境`, closing(t));
}

// ---------------- 第五轮复核（2026-09-25）：季节核对只认点了名的具体线路 / 顺着砍价的「就按这个数」照拦 / 资金担保顺带一句顾问照换 ----------------
{
  const { dropUnbackedClaims } = await import('./price-rules.js');
  const said = (content: string) => ({ role: 'customer' as const, content, at: 0 });
  const quotedS = async (routeId: string, travelers: number, departDate: string, msgs: string[] = []): Promise<Session> => {
    const s = blank({ messages: msgs.map(said) });
    await executeTool('create_quote', { routeId, travelers, departDate }, s);
    return s;
  };
  const dropped = (t: string, s: Session, calls: { name: string; args: Record<string, unknown>; result?: string }[] = []) =>
    dropUnbackedClaims(t, s, calls).dropped;
  const search = (destination: string, ...ids: string[]) => ({ name: 'search_routes', args: { destination }, result: JSON.stringify(ids.map((id) => ({ id }))) });

  // R1 九寨线（4-11 月）报了价：「11 月是淡季」必须删。此前回复带着线路全名「四川 …」、本轮预取了四川、召回里带出贵州时，
  //    同目的地的稻城亚丁（5-10 月）、召回的贵州（4-10 月）都算「在场」，对得上它们就放行了（B01）
  const jz = await quotedS('r-sichuan-mid', 2, '2026-10-18');
  const jzHead = '四川 成都熊猫·九寨黄龙 6 日亲子\n10 月 18 日出发，2 位出行\n\n每人 21,780 元，总价 43,560 元\n（10 月是这条线的最佳出行季，价格上浮了 10%）\n\n';
  check('R1 九寨报价回复带全名（含「四川」）：「11 月是淡季」删',
    dropped(jzHead + '想省一点的话，11 月是淡季，改到 11 月出发按标准价走。', jz).length === 1);
  check('R1 本轮预取 search(四川) 召回两条四川线：「11 月是淡季」删',
    dropped('11 月是淡季，按标准价走。', jz, [search('四川', 'r-sichuan-mid', 'r-sichuan-lux')]).length === 1);
  check('R1 本轮语义召回带出贵州：「11 月出发就不在最佳季，按标准价」删',
    dropped('11 月出发就不在最佳季，按标准价走。', jz, [search('九寨沟', 'r-sichuan-mid', 'r-guizhou')]).length === 1);
  check('R1 同一句带全名：「四川 成都熊猫·九寨黄龙：11 月是淡季」删', dropped('四川 成都熊猫·九寨黄龙：11 月是淡季，按标准价走。', jz).length === 1);
  check('R1 只说目的地「四川这边 11 月是淡季」：按最近报价的九寨线核，删', dropped('四川这边 11 月是淡季，按标准价走。', jz).length === 1);
  const yn = await quotedS('r-yunnan-mid', 2, '2026-10-24');
  check('R1 上一句是「云南 丽江大理…」：「12 月也是这条线的最佳季」按丽江大理核，删',
    dropped('云南 丽江大理·洱海古城 6 日，每人 18,480 元。\n\n12 月也是这条线的最佳季，价格上浮 10%。', yn).length === 1);
  // 真点了名的别的线照样算在场（第四轮 S1 的三亚那句）；本轮给别的线报过价也算
  check('R1 回复里点名了三亚（12 月在最佳季）：「12 月是最佳季」不删',
    dropped('再给您推一条：三亚亲子奢华度假 5 日，人均 15,800 起。\n\n12 月是最佳季，价格上浮 10%。', yn).length === 0);
  check('R1 本轮查过梅里线详情（12 月在最佳季）：「12 月是最佳季」不删',
    dropped('12 月是最佳季，价格上浮 10%。', yn, [{ name: 'get_route_detail', args: { routeId: 'r-yunnan-lux' } }]).length === 0);

  // R2 顺着客户砍的价成交：带「就」的「就按这个数」一律算成交，「您看行不行」「给您看看名额」「查一下能不能下单」不是按预算检索；
  //    同一句说着预算、不带「就」的「按这个数给您安排」也不再放过。客户喊的 6,800 照拦
  const haggle = '别家6800一个人 你们预算6800我今天就定';
  const hq = await quotedS('r-yunnan-mid', 2, '2026-10-24', [haggle]);
  for (const t of [
    '行吧，那就按这个数您看行不行：每人 6,800 元。', '可以，就按这个数给您看看名额，每人 6,800 元。',
    '就按这个数帮您查一下能不能下单，每人 6,800 元。', '我按这个数帮您查一下能不能下单，每人 6,800 元。',
    '您预算 6800，行，按这个数给您安排：每人 6,800 元。',
  ]) check(`R2 「${t}」拦下 6,800`, JSON.stringify(findUnbackedPrices(t, hq, haggle)) === '[6800]', JSON.stringify(findUnbackedPrices(t, hq, haggle)));
  const closing = __priceGuardTest.hasClosingPrice as (s: string) => boolean;
  for (const t of ['我按这个预算帮您挑几条合适的线路。', '您说个数，我按这个预算帮您查查有哪些线路。']) check(`R2 「${t}」仍是按预算检索`, !closing(t));

  // R3 编的资金担保顺带一句「找顾问 / 以合同为准 / 顾问会说明」：照换。往顾问引的说法得跟资金那句在同一个小句，或资金说法本身是话题
  const plain = blank({ stage: 'recommend' });
  const REPL = '付款只走我们发给您的官方支付链接。';
  for (const t of [
    '您的款项全程第三方监管，有疑问随时找顾问。', '您的款项会进入第三方监管账户，行程结束才结算给地接，具体以合同为准。',
    '资金由银行第三方托管，顾问会给您详细说明。', '费用第三方托管，下单后跟顾问签电子合同就行。',
  ]) check(`R3 「${t}」换成官方支付链接`, dropUnbackedClaims(t, plain).text === REPL, dropUnbackedClaims(t, plain).text);
  for (const t of [
    '资金监管这块我确认不了，由顾问跟您确认。', '资金托管的具体安排以合同约定为准。',
    '至于资金托管这类制度细节，我不替公司打包票，由顾问跟您确认、给您看相关材料。',
  ]) check(`R3 「${t}」往顾问引：不换`, dropUnbackedClaims(t, plain).text === t, dropUnbackedClaims(t, plain).text);
}

if (fails.length) {
  console.error(`PRICE-GUARD SELFTEST FAIL: ${fails.length} 项未通过`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PRICE-GUARD SELFTEST PASS: ${pass} 项断言全通（编价拦截 / 真实报价零误杀 / 档位话术零误杀 / 差额与中文预算 / 回复里的中文数字金额 / 酒店每晚价 / 产品库价按本会话出现过的线路核 / 报价之差与量词 / 只删那一句 / 规则词·预算·服务承诺 / 复核：差额看上下文·如实不误删·预算只删小句·续行随分点 / 第二轮：季节按 bestSeason 核·预算的其他说法·做不到的加减·高反担保·残句 / 第三轮：换日子的小句不借月份·千分位不断句·放开预算·条件句的预算够·残句看丢了哪条线 / 第四轮：说对的季节不删·资金往顾问引不换不重复·按这个数找线路不是成交 / 第五轮：季节只认点了名的具体线路·顺着砍价的就按这个数照拦·资金担保带句顾问照换）`);
