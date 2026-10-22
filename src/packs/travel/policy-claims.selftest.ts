// 07 R22 政策陈述护栏（policy_claims）的纯函数部分：三条规则各一正一反（含否定句）、与默认 policy 相等的各种写法一字不改、
// 链接句不动、租户的 policy 档位被认、线路事实的出处、被换上去的文字都登记过。引擎一侧的接线（客户最终收到什么、后台记了几条备注、
// 有没有转人工）在 src/policy-claims.selftest.ts。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Route } from '../../core/pack-api.js';
import { INSURANCE_REPLY, FEES_REPLY } from './claim-words.js';
import { policyClaimsTest, policyReplacementTexts, rewritePolicyClaims, routesInScope } from './policy-claims.js';
import { clauses, defaultTravelPolicy, segments } from './policy.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const routes = JSON.parse(fs.readFileSync(path.join(root, 'data', 'routes.json'), 'utf8')) as Route[];
const route = (id: string): Route => routes.find((r) => r.id === id)!;
const guizhou = route('r-guizhou'); // 含里没有保险
const xian = route('r-xian'); // 含里有「全程旅行意外保险」
const swiss = route('r-swiss'); // 含里没有机票，不含「往返瑞士的国际及境内衔接机票」

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const policy = defaultTravelPolicy;
function run(
  text: string,
  opts: { input?: string; scope?: Route[]; policy?: unknown; hasHole?: (s: string) => boolean; focus?: string } = {},
) {
  const scope = opts.scope ?? [];
  return rewritePolicyClaims(
    text,
    { policy: opts.policy ?? policy, inputText: opts.input ?? '', scope },
    { hasHole: opts.hasHole },
    opts.focus,
  );
}
/** 原样不动 */
function same(name: string, text: string, opts: Parameters<typeof run>[1] = {}): void {
  const out = run(text, opts);
  check(`${name}：一个字不改`, out.text === text && out.edits.length === 0, JSON.stringify(out.text));
}
function becomes(name: string, text: string, want: string, rule: string, opts: Parameters<typeof run>[1] = {}): void {
  const out = run(text, opts);
  check(
    `${name}`,
    out.text === want && out.edits.every((e) => e.rule === rule),
    `${JSON.stringify(out.text)} / ${out.edits.map((e) => e.rule)}`,
  );
}

const T1 = '出发前30天及以上取消，退全款（退改条款第1条）';
const T2 = '出发前15–29天取消，退订单金额的80%（退改条款第2条）';
const T3 = '出发前7–14天取消，退订单金额的50%（退改条款第3条）';
const T4 = '出发前0–6天取消，不能自助退，由顾问为您处理（退改条款第4条）';

// ---------------- 规则 1：退改天数与比例 ----------------
// 正例：天数与比例对不上 → 那一档的条款原句加出处（验收 7：「出发前 7 天也能全额退」换成第3条原句）
becomes('规则 1 正例：出发前 7 天也能全额退 → 第3条原句', '出发前 7 天也能全额退。', `${T3}。`, 'refund');
becomes('规则 1 正例：20 天退全款 → 第2条', '您好～出发前 20 天取消的话，可以退全款哦。', `您好～${T2}。`, 'refund');
becomes('规则 1 正例：3 天取消不退款 → 第4条', '出发前3天取消不退款。', `${T4}。`, 'refund');
becomes('规则 1 正例：中文数字，二十天退五成 → 第2条', '出发前二十天取消，退五成。', `${T2}。`, 'refund');
becomes('规则 1 补出处：中文数字，二十天退八成是对的', '出发前二十天取消，退八成。', '出发前二十天取消，退八成（退改条款第2条）。', 'cite');
becomes('规则 1 正例：扣除 20% 折成退 80%，但天数对应 50%', '出发前10天取消，会扣除 20%。', `${T3}。`, 'refund');
becomes('规则 1 正例：引的出处和天数对不上', '出发前 10 天，适用退改条款第1条', T3, 'refund');
becomes('规则 1 正例：没说天数、比例不是任何一档 → 列全部档位', '取消可以退 90%。', `${[T1, T2, T3, T4].join('；')}。`, 'refund');
// 每一档的边界
for (const [days, want] of [
  [30, T1],
  [55, T1],
  [29, T2],
  [15, T2],
  [14, T3],
  [7, T3],
  [6, T4],
  [0, T4],
] as const) {
  const wrong = want === T1 ? '退一半' : '退全款';
  becomes(`规则 1 边界：出发前 ${days} 天 → ${want.slice(-6)}`, `出发前${days}天取消，${wrong}。`, `${want}。`, 'refund');
}
// 不变量 18：任何「天数 × 比例」的说法过一遍之后都和档位一致，再过一遍不再变（不会越补越多）
{
  const table = policyClaimsTest().refundTable(policy);
  let bad = 0;
  let checked = 0;
  for (let days = 0; days <= 60; days++) {
    const tier = table.find((t) => days >= t.minDays && (t.maxDays === null || days <= t.maxDays))!;
    for (const pct of [100, 90, 80, 70, 50, 30, 0]) {
      const once = run(`出发前${days}天取消，退${pct}%。`);
      const twice = run(once.text);
      const right = tier.percent === pct;
      checked++;
      // 对得上的：只补出处；对不上的：整句换成这一档的条款原句。两种结果都带这一档的出处，再过一遍不变
      const expected = right ? `出发前${days}天取消，退${pct}%（${tier.title}）。` : `${tier.text}（${tier.title}）。`;
      if (once.text !== expected || twice.text !== once.text || twice.edits.length !== 0) bad++;
    }
  }
  check('不变量 18：0–60 天 × 7 种比例，换 / 补之后与档位一致、再过一遍不变', bad === 0 && checked === 61 * 7, `${bad} 处不一致`);
}
// 对得上没写出处 → 句末补出处（patch）
becomes('规则 1 补出处：第3条', '出发前7天取消，退订单金额的50%。', `出发前7天取消，退订单金额的50%（退改条款第3条）。`, 'cite');
becomes('规则 1 补出处：区间写法', '出发前15–29天取消，退80%', '出发前15–29天取消，退80%（退改条款第2条）', 'cite');
becomes(
  '规则 1 补出处：天数在前、比例在下一小句',
  '出发前30天及以上取消，可以全额退。',
  '出发前30天及以上取消，可以全额退（退改条款第1条）。',
  'cite',
);
becomes(
  '规则 1 补出处：分点各补各的',
  '· 出发前30天以上：全额退\n· 15–29天：退80%\n· 7–14天：退50%\n',
  '· 出发前30天以上：全额退（退改条款第1条）\n· 15–29天：退80%（退改条款第2条）\n· 7–14天：退50%（退改条款第3条）\n',
  'cite',
);
becomes(
  '规则 1 补出处：说了不能全额、只能退 50%',
  '出发前 7 天不能全额退，只能退 50%。',
  '出发前 7 天不能全额退，只能退 50%（退改条款第3条）。',
  'cite',
);
const full = `${T1}。${T2}。`;
same('规则 1：写对了又写了出处', full);
same('规则 1：写对了又写了出处（适用某条）', '您这张单离出发55天，适用退改条款第1条，可以退全款。');
// 否定句反例：说的是做不到的事，不判（K16 另有：没有数字的句子不动）
same('规则 1 否定：不能全额退', '出发前 7 天不能全额退。');
same('规则 1 否定：退不了全额', '出发前7天取消，退不了全额。');
same('规则 1 反例（K16）：退改条款都写明，没有数字', '出团前签正式电子旅游合同，行程、酒店、金额、退改条款都写明');
same('规则 1 反例：天数与比例分别是区间的另一头（N 天内）', '出发前3天内取消不退款。');
same('规则 1 反例：不退不换，没有天数', '不退不换，请谨慎下单。');
same('规则 1 反例：在问不在断言', '您是想问出发前 7 天取消能全额退吗？');
becomes('规则 1：问句前面的小句是断言，照换', '出发前 7 天也能全额退，您看可以吗？', `${T3}，您看可以吗？`, 'refund');
same('规则 1 反例：退款多久到账不是出发前的天数', '按条款退 80%，3到5天内到账。');
same('规则 1 反例：工作日到账', '退款会在 3-5 个工作日内原路退回。');
same('规则 1 反例：不是退改语境', '10月出发的话价格上浮 10%，4 位享 95 折，行程 7 天 6 晚。');
same('规则 1 反例：保险赔付不归退改档位', '取消险最高赔付 90%。');
becomes(
  '规则 1：同一句里说了保险，不影响查退改的小句',
  '含全程旅行意外保险，出发前 7 天也能全额退。',
  `含全程旅行意外保险，${T3}。`,
  'refund',
);
same('规则 1 反例：只有天数没有比例', '出发前15天及以上可以改期一次，由顾问为您办理');
// 链接句不动（06 R13）
same('规则 1：含支付链接的句子不动', '出发前 7 天也能全额退，请点击付款：/pay/ord_abc123');
same('规则 1：紧挨着链接行的那一句不动', '出发前 7 天也能全额退，付款链接在下面：\n/pay/ord_abc123\n');
same('规则 1：含方案书链接的句子不动', '出发前 7 天也能全额退，方案书在 /proposal/r-xian/2');
const HOLE = String.fromCharCode(2); // 链接空位记号
same('规则 1：含链接空位的句子不动', `出发前 7 天也能全额退${HOLE}`, { hasHole: (s) => s.includes(HOLE) });
// 没有 policy：不动
check(
  '没有 policy 就没有可核对的东西',
  rewritePolicyClaims('出发前 7 天也能全额退。', { policy: undefined, inputText: '', scope: [] }).text === '出发前 7 天也能全额退。',
);
// 租户改了档位：按本轮快照的数和编号
{
  const tenant = {
    ...policy,
    refund: {
      ...policy.refund,
      tiers: [
        { id: 'd20', minDays: 20, maxDays: null, percent: 100 },
        { id: 'd10', minDays: 10, maxDays: 19, percent: 60 },
      ],
    },
  };
  const t1 = '出发前20天及以上取消，退全款（退改条款第1条）';
  const t2 = '出发前10–19天取消，退订单金额的60%（退改条款第2条）';
  const t3 = '出发前0–9天取消，不能自助退，由顾问为您处理（退改条款第3条）';
  becomes(
    '租户 policy：25 天退全款对得上，补第1条',
    '出发前25天取消，可以退全款。',
    '出发前25天取消，可以退全款（退改条款第1条）。',
    'cite',
    { policy: tenant },
  );
  becomes('租户 policy：15 天退 80% 在这份档位里是错的', '出发前15天取消，退80%。', `${t2}。`, 'refund', { policy: tenant });
  becomes('租户 policy：5 天 → 第3条', '出发前5天取消，退50%。', `${t3}。`, 'refund', { policy: tenant });
  becomes('租户 policy：默认的 30 天档在这份档位里是第1条', '出发前30天取消，退60%。', `${t1}。`, 'refund', { policy: tenant });
}

// ---------------- 规则 2：定价与预订月数 ----------------
const PEAK = segments['note:peak'](policy);
const GROUP = segments['note:group'](policy);
const FAR = segments['note:far-future'](policy);
becomes(
  '规则 2 正例：上浮 15%',
  '10月是最佳出行季上浮 15%，4 人及以上享 95 折。',
  `${PEAK.replace('{month}', '10')}，4 人及以上享 95 折。`,
  'pricing',
);
becomes('规则 2 正例：上浮 15%，没说月份', '旺季价格会上浮 15% 左右。', `${PEAK.replace('{month}月为', '')}。`, 'pricing');
becomes('规则 2 正例：9 折', '4 人及以上每人还能打 9 折。', `${GROUP}。`, 'pricing');
becomes('规则 2 正例：5 人以上', '5 人以上，每人打 95 折。', `${GROUP}。`, 'pricing');
becomes('规则 2 正例：八五折', '人多的话可以打八五折哦。', `${GROUP}。`, 'pricing');
becomes('规则 2 正例：超过 6 个月', '出发日期超过 6 个月的只能给参考价。', `${FAR}。`, 'booking');
becomes('规则 2 正例：最多提前 6 个月预订', '我们最多提前 6 个月预订。', `${FAR}。`, 'booking');
becomes('规则 2 正例：超过半年', '出发日期超过半年的订单只能给参考价。', `${FAR}。`, 'booking');
// 与默认 policy 相等的各种写法一个字不改（K19）
for (const t of [
  '10月是最佳出行季，价格上浮 10%',
  '10月是最佳出行季上浮 10%，4 人及以上享 95 折。',
  '最佳出行季上浮了10%。',
  '价格上浮10 %。',
  '上浮 10.0%。',
  '旺季上浮百分之十。',
  '10月正是这条线的最佳出行季，价格上浮了10%',
  '4 人 95 折',
  '4 位享 95 折',
  '4人及以上享95折。',
  '4 人及以上每人还能打 95 折。',
  '好嘞，4 位一起走更热闹～按 4 人重新报价（4 人及以上每人还能打 95 折）：',
  '4人及以上可以打九五折。',
  '满4人9.5折。',
  '超过 12 个月的只能给参考价。',
  '超过一年的订单只能给参考价。',
  '最多提前 12 个月预订。',
  '按 4 位、10 月 3 日出发给您报好了：\n每人 16,511 元\n4 位总价 66,044 元\n10 月是最佳出行季上浮 10%，4 人及以上享 95 折。',
]) {
  same(`规则 2 相等写法（K19）：${t.slice(0, 18).replace(/\n/g, ' ')}`, t);
}
// 否定句反例
same('规则 2 反例：在问不在断言', '上浮 15% 您能接受吗？');
same('规则 2 否定：不会上浮 20%', '旺季也不会上浮 20%。');
same('规则 2 否定：没有 9 折这回事', '没有 9 折这回事，我们只有 4 人及以上的团队优惠。');
same('规则 2 否定：不是 5 人以上才有优惠', '不是 5 人以上才有优惠。');
same('规则 2 反例：不是优惠语境里的人数', '10 人及以上可以包团出行。');
same('规则 2 反例：折叠、折扣这类别的词', '折扣规则请看方案书，行程有点曲折。');
same('规则 2 反例：预订语境之外的月数', '这家酒店装修超过 6 个月了。');
same('规则 2：链接句不动', '4 人及以上每人打 9 折，点此完成支付 /pay/ord_abc123');
// 租户 policy 的另一组数
{
  const tenant = { ...policy, pricing: { peakMultiplier: 1.15, groupMinimum: 5, groupDiscount: 0.9 }, booking: { maxDepartMonths: 6 } };
  same('租户 policy：上浮 15%、5 人 9 折、6 个月都对得上', '上浮 15%，5 人及以上享 9 折，超过 6 个月的只能给参考价。', { policy: tenant });
  becomes(
    '租户 policy：默认的 10% 在这份里是错的',
    '价格上浮 10%。',
    `${segments['note:peak'](tenant).replace('{month}月为', '')}。`,
    'pricing',
    { policy: tenant },
  );
}

// ---------------- 规则 3：保险、费用含不含 ----------------
const askIns = '这条线含保险吗';
becomes('规则 3 正例：线路「含」里没有保险，模型说「含的」', '含的～', INSURANCE_REPLY, 'unbacked', { input: askIns, scope: [guizhou] });
becomes('规则 3 正例：说了含高原保险', '可以的，这条线含高原专属保险。', INSURANCE_REPLY, 'unbacked', { input: askIns, scope: [guizhou] });
becomes('规则 3 正例：「含的」加解释只换一次', '含的，高原专属保险已经包含在费用里了。', INSURANCE_REPLY, 'unbacked', {
  input: askIns,
  scope: [guizhou],
});
becomes('规则 3 正例：前面应一声也一起去掉', '嗯，含的，保险都包含在内。', INSURANCE_REPLY, 'unbacked', {
  input: askIns,
  scope: [guizhou],
});
becomes('规则 3 正例：保险在前、含在后', '保险我们是含的哦', INSURANCE_REPLY, 'unbacked', { input: askIns, scope: [guizhou] });
becomes(
  '规则 3 正例：句子里别的话留着，只换那一小句',
  '这条线很受欢迎，含全程旅行意外保险，您几位出行？',
  `这条线很受欢迎。${INSURANCE_REPLY}您几位出行？`,
  'unbacked',
  { input: askIns, scope: [guizhou] },
);
becomes('规则 3 正例：没有任何线路在场，说含也无出处', '含的～', INSURANCE_REPLY, 'unbacked', { input: askIns, scope: [] });
becomes('规则 3 正例：说含机票，线路的「含」里没有机票', '含机票，不用另付。', FEES_REPLY, 'unbacked', {
  input: '含机票吗，要另付吗',
  scope: [swiss],
});
becomes('规则 3 正例：「不用另付」「没有隐形消费」', '放心，没有任何隐形消费。', FEES_REPLY, 'unbacked', {
  input: '有没有隐形消费',
  scope: [guizhou],
});
becomes('规则 3 正例：同一句话回复里只出现一次', '含机票。\n机票也含。', `${FEES_REPLY}\n`, 'unbacked', {
  input: '机票含不含',
  scope: [swiss],
});
// 否定说法一律不按这条换（K14：「不含国际机票」原样留）
same('规则 3 否定（K14）：不含国际机票', '这条费用不含国际机票和签证。', { input: '瑞士那条费用含机票吗', scope: [swiss] });
same('规则 3 否定：没有列保险', '费用里没有列保险，具体由顾问确认。', { input: askIns, scope: [guizhou] });
same('规则 3 否定：建议另买', '这条线不含保险，建议您另外买一份旅游意外险。', { input: askIns, scope: [guizhou] });
same('规则 3 反例：问句不是断言', '需要我把含机票的完整报价算一份吗？', { input: '瑞士那条费用含机票吗', scope: [swiss] });
same('规则 3 反例：本来就是口径句', INSURANCE_REPLY, { input: askIns, scope: [guizhou] });
same('规则 3 反例：线路的「含」里有机票', '含疆内四段经济舱机票。', { input: '含机票吗', scope: [route('r-xinjiang-lux')] }); // 补出处另测
// 客户这句不是政策问法：一个字不动（K20）
same('规则 3 反例（K20）：不是政策问法', '含的～', { input: '想看看贵州', scope: [guizhou] });
same('规则 3 反例（K20）：不是政策问法，说含保险', '这条线含高原专属保险。', { input: '再发下支付链接', scope: [guizhou] });
// 主题要对上：问保险，不拿机票的话去换
same('规则 3：问的是保险，回复说含机票不归这条', '含机票。', { input: askIns, scope: [guizhou] });
// 新口径与备注的措辞（K17、K21）
check(
  'K17：换上去的口径句不含「转接」「稍候」',
  ![INSURANCE_REPLY, FEES_REPLY, GROUP, FAR, ...policyReplacementTexts(policy).map((t) => t.text)].some((t) => /转接|稍候/.test(t)),
);
check('K21：口径句沿用「由顾问跟您确认」', INSURANCE_REPLY.includes('由顾问跟您确认') && FEES_REPLY.includes('由顾问跟您确认'));
// 线路事实的出处：被「含」支持的肯定说法，句末补「（《线路名》费用说明）」
becomes(
  '线路出处：含保险且线路的「含」里确实有',
  '这条线含全程旅行意外保险，放心。',
  `这条线含全程旅行意外保险，放心（《${xian.title}》费用说明）。`,
  'cite',
  { input: askIns, scope: [xian] },
);
becomes('线路出处：光杆的「含的」也补', '含的～', `含的（《${xian.title}》费用说明）～`, 'cite', { input: askIns, scope: [xian] });
becomes(
  '线路出处：回复点名了线路，补点名的那条',
  `《${xian.title}》含全程旅行意外保险。`,
  `《${xian.title}》含全程旅行意外保险（《${xian.title}》费用说明）。`,
  'cite',
  { input: askIns, scope: [guizhou, xian] },
);
same('线路出处：已经写了出处不重复补', `这条线含全程旅行意外保险（《${xian.title}》费用说明）。`, { input: askIns, scope: [xian] });
same('线路出处：两条线都支持又没点名，拿不准不补', '都含保险。', { input: askIns, scope: [route('r-tibet-lux'), xian] });
same('线路出处：不是政策问法不补', '这条线含全程旅行意外保险，放心。', { input: '想去西安', scope: [xian] });
becomes('线路出处：多条线只有最近报价那条支持', '含保险的。', `含保险的（《${xian.title}》费用说明）。`, 'cite', {
  input: askIns,
  scope: [xian, guizhou],
  focus: xian.id,
});

// 会话里出现过的线路：lastShownRoutes、报价、订单、本轮工具结果、回复点名
{
  const scope = (
    over: Parameters<typeof routesInScope>[0],
    orders: { routeId: string }[] = [],
    calls: Parameters<typeof routesInScope>[2] = [],
    text = '',
  ) =>
    routesInScope(over, orders, calls, text, routes)
      .map((r) => r.id)
      .sort()
      .join(',');
  check('在场线路：lastShownRoutes', scope({ lastShownRoutes: [{ id: 'r-xian', title: 'x', priceFrom: 1 }] }) === 'r-xian');
  check('在场线路：最近一次报价', scope({ lastQuote: { routeId: 'r-guizhou', routeTitle: 'x', travelers: 2 } }) === 'r-guizhou');
  check('在场线路：订单', scope({}, [{ routeId: 'r-swiss' }]) === 'r-swiss');
  check(
    '在场线路：本轮工具结果（参数里的 routeId、结果里的 id）',
    scope(
      {},
      [],
      [
        { name: 'get_route_detail', args: { routeId: 'r-xian' }, result: JSON.stringify({ id: 'r-xian' }) },
        { name: 'search_routes', args: { destination: '贵州' }, result: JSON.stringify([{ id: 'r-guizhou' }, { id: 'r-xx' }]) },
      ],
    ) === 'r-guizhou,r-xian',
  );
  check('在场线路：回复点名的《线路》', scope({}, [], [], `《${swiss.title}》不含机票`) === 'r-swiss');
  check('在场线路：工具结果不是 JSON 不炸', scope({}, [], [{ name: 'x', args: {}, result: '不是 json' }]) === '');
}

// 解析器的几个细节
{
  const t = policyClaimsTest();
  check(
    '数字：中文数字',
    t.num('三十') === 30 && t.num('十五') === 15 && t.num('二十九') === 29 && t.num('七') === 7 && t.num('十') === 10,
  );
  check(
    '天数：出发前 N 天 / N 天及以上 / 区间 / N 天内跳过',
    JSON.stringify(t.parseDays('出发前 7 天')) === '{"n":7}' &&
      JSON.stringify(t.parseDays('30天及以上')) === '{"n":30}' &&
      JSON.stringify(t.parseDays('15–29天')) === '{"n":15,"hi":29}' &&
      t.parseDays('7天内') === 'skip' &&
      t.parseDays('7天6晚') === undefined,
  );
  check(
    '比例：百分号、百分之、成、全额、一半、不退、扣除折算',
    t.parsePct('退80%') === 80 &&
      t.parsePct('退百分之五十') === 50 &&
      t.parsePct('退八成') === 80 &&
      t.parsePct('全额退') === 100 &&
      t.parsePct('退一半') === 50 &&
      t.parsePct('不退') === 0 &&
      t.parsePct('扣除20%') === 80 &&
      t.parsePct('不能全额退') === undefined &&
      t.parsePct('付全额') === undefined,
  );
  check(
    '出处：退改条款第N条',
    t.parseCite('（退改条款第2条）') === 2 && t.parseCite('适用退改条款第三条') === 3 && t.parseCite('退改条款都写明') === undefined,
  );
  check(
    '折扣率：95 折、9.5 折、九五折、9 折',
    [95, 9.5].every((n) => Math.abs(t.discountOf([`${n}折`, String(n)] as never)! - 0.95) < 1e-9),
  );
  const table = t.refundTable(policy);
  check(
    '档位表与 clauses() 一一对应，编号从远到近',
    table.map((r) => r.title).join() ===
      clauses(policy)
        .filter((c) => c.topic === 'refund')
        .map((c) => c.title)
        .join() && table.at(-1)!.percent === null,
  );
}

// 每个换上去的文字都登记过（给 fixed-replies 与一致性检查）
{
  const texts = policyReplacementTexts(policy);
  check(
    '登记的替换文字（由条款推出的）：每档条款、列全部、不带月份的上浮',
    texts.map((x) => x.id).join() === 'refund-tier.d30,refund-tier.d15,refund-tier.d7,refund-tier.below-min,refund-all,peak-no-month',
    texts.map((x) => x.id).join(),
  );
  check(
    '登记的替换文字：和步骤用的是同一批函数',
    texts.find((x) => x.id === 'refund-tier.d7')!.text === T3 &&
      texts.find((x) => x.id === 'peak-no-month')!.text === segments['note:peak'](policy).replace('{month}月为', ''),
  );
  check(
    '预订月数的对客句只有一份：policy.ts 的 note:far-future',
    run('出发日期超过 6 个月的只能给参考价。').text === `${FAR}。` && FAR === '目前只受理 12 个月以内出发的订单，更远的日期只能给参考价',
  );
  check(
    '替换文字不带 markdown、不点名渠道',
    [...texts.map((x) => x.text), PEAK, GROUP, FAR].every((t) => !/\*\*|^#|微信|企微/.test(t)),
  );
}

if (failures.length) {
  console.error(`POLICY CLAIMS SELFTEST FAIL: ${failures.length} 项\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
assert.ok(passed > 100);
console.log(
  `POLICY CLAIMS SELFTEST PASS: ${passed} 项断言全通（三条规则各一正一反含否定句 / 默认 policy 相等写法不改 / 链接句不动 / 租户档位 / 线路出处 / 替换文字登记）`,
);
process.exit(0);
