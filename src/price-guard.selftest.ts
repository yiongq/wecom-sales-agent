// 价格出口护栏自测。这道护栏两侧都要钉住，而且两边的代价都很贵：
//   · 漏拦 → 模型编的价直接发给客户，成交后要么公司认亏要么当场翻脸
//   · 误杀 → 真实报价被换成「我需要重新核对一下」，客户永远拿不到价格，还会反复循环
// 用法：npx tsx src/price-guard.selftest.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据写临时目录，别碰真实 var/（store 在模块加载时就取 VAR_DIR，故动态 import）
process.env.VAR_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-priceguard-'));

const { findUnbackedPrices } = await import('./price-guard.js');
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
  check('4 人 95 折总价放行', !blocked(`4 位总价 ¥${q4.total.toLocaleString('zh-CN')}`));

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
  check('起价档位（一位小数）放行', !blocked(`人均 ${(cheapest.priceFrom / 10000).toFixed(1)} 万起`));

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

if (fails.length) {
  console.error(`PRICE-GUARD SELFTEST FAIL: ${fails.length} 项未通过`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PRICE-GUARD SELFTEST PASS: ${pass} 项断言全通（编价拦截 / 真实报价零误杀 / 档位话术零误杀）`);
