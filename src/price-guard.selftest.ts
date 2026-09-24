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

if (fails.length) {
  console.error(`PRICE-GUARD SELFTEST FAIL: ${fails.length} 项未通过`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PRICE-GUARD SELFTEST PASS: ${pass} 项断言全通（编价拦截 / 真实报价零误杀 / 档位话术零误杀 / 差额与中文预算 / 回复里的中文数字金额 / 酒店每晚价 / 产品库价按本会话出现过的线路核）`);
