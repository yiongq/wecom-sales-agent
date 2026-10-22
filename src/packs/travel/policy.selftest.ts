import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Route, TravelToolSources } from '../../core/pack-api.js';
import { createTravelCatalog } from './tools/catalog.js';
import { FEES_REPLY, INSURANCE_REPLY, VISA_REPLY } from './claim-words.js';
import { travel } from './console-pack.js';
import { travelDateThresholds, travelPriceThresholds } from './thresholds.js';
import {
  canonical,
  sopPolicyMirror,
  clauses,
  defaultTravelPolicy,
  peakPercent,
  segments,
  travelPolicy,
  travelPolicySchema,
  upgrade,
  type TravelPolicy,
} from './policy.js';

const p = defaultTravelPolicy;
const sop = fs.readFileSync(new URL('../../../data/sop.md', import.meta.url), 'utf8');
const lines = sop.split('\n');
const expectedPrice =
  '1. 出发月份落在线路的最佳季（bestSeason）内，每人价上浮 10%；不在最佳季就是标准价，不上浮。\n' +
  '2. 4 人及以上，每人价打 95 折。\n' +
  '（「10月为最佳出行季，价格上浮 10%」「4月不在最佳季，不上浮」）';
assert.equal(segments['sop:price-rules'](p), expectedPrice);
const [rule1, rule2, example] = expectedPrice.split('\n');
assert.ok(lines.includes(rule1));
assert.ok(lines.includes(rule2));
assert.ok(lines.some((line) => line.includes(example)));
assert.equal(
  segments['sop:far-future'](p),
  '出发日期超过 12 个月的只能给参考：create_quote 返回 farFuture 时没有确定价，按结果里的 priceFrom 说「参考价」，讲明到时价格可能有变，不下单（不调 create_order），具体由顾问到时确认。',
);
assert.ok(lines.includes(segments['sop:far-future'](p)));
assert.equal(segments['note:peak'](p).replace('{month}', '10'), '10月为最佳出行季，价格上浮 10%');
assert.equal(segments['note:group'](p), '4 人及以上享 95 折');
const unused = (): never => {
  throw new Error('报价 note 不应调用外部能力');
};
const sources: TravelToolSources = {
  configMode: () => 'file',
  currentCatalog: unused,
  catalogVersionKey: unused,
  catalogItemAt: unused,
  indexReady: unused,
  semanticRecall: unused,
  budgetVerdict: unused,
  createOrder: unused,
  getOrder: unused,
  queueJobs: unused,
  saveSession: unused,
  supersedeOrder: unused,
  todayIso: unused,
  paymentMode: unused,
  orderUnconfirmedNotifyOps: unused,
  enterHandoff: unused,
  modelHandoffReason: '测试',
};
const { quoteFor } = createTravelCatalog(sources);
const routes = JSON.parse(fs.readFileSync(new URL('../../../data/routes.json', import.meta.url), 'utf8')) as Route[];
const fixture = { ...routes[0], priceFrom: 10001, bestSeason: '10月' };
assert.equal(quoteFor(fixture, { travelers: 1, departDate: '2027-10-10' }).note, '10月为最佳出行季，价格上浮 10%');
assert.equal(quoteFor(fixture, { travelers: 4 }).note, '4 人及以上享 95 折');
assert.equal(quoteFor(fixture, { travelers: 4, departDate: '2027-10-10' }).perPerson, Math.round(Math.round(10001 * 1.1) * 0.95));
assert.equal(segments['help:price'](p), '填淡季、4人以下的价；旺季上浮10%、4人及以上95折由系统算');
assert.equal(segments['help:season'](p), '这些月份出发报价上浮10%，「全年」不加价');
const fields = travel.entities.find((entity) => entity.kind === 'route')!.fields;
assert.equal(fields.find((field) => field.key === 'priceFrom')!.help, segments['help:price'](p));
assert.equal(fields.find((field) => field.key === 'bestSeason')!.monthMeaning, segments['help:season'](p));
assert.equal(sopPolicyMirror(sop, p), sop);
assert.match(
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-sop-policy.ts'], { encoding: 'utf8', timeout: 30000 }),
  /检查通过/,
);
console.log('✔ 六个生成段逐字节一致；报价 note、后台帮助与 SOP 检查模式通过');

function assertAdminPeak(html: string, policy: TravelPolicy): void {
  const matches = [...html.matchAll(/上浮\s*(\d+(?:\.\d+)?)%/g)];
  assert.ok(matches.length > 0, 'admin.html 缺少上浮比例');
  for (const match of matches) assert.equal(Number(match[1]), peakPercent(policy), 'admin.html 上浮比例与 policy 不一致');
}
const admin = fs.readFileSync(new URL('../../../public/admin.html', import.meta.url), 'utf8');
assertAdminPeak(admin, p);
const changed = structuredClone(p);
changed.pricing.peakMultiplier = 1.15;
for (const key of ['sop:price-rules', 'note:peak', 'help:price', 'help:season'] as const)
  assert.ok(segments[key](changed).includes('15%'), key);
assert.throws(() => assertAdminPeak(admin, changed), /admin.html 上浮比例与 policy 不一致/);
assert.throws(() => sopPolicyMirror(sop, changed), /sop:price-rules/);
const written = sopPolicyMirror(sop, changed, true);
assert.equal(sopPolicyMirror(written, changed), written);
assert.equal(sopPolicyMirror(written, p, true), sop, '写回仅改变生成片段，其余字节原样保留');
assert.throws(() => sopPolicyMirror(sop.replace(rule1, ''), p, true), /sop:price-rules.*实际 0/);
assert.throws(() => sopPolicyMirror(`${sop}\n${rule1}`, p, true), /sop:price-rules.*实际 2/);
changed.pricing.groupDiscount = 0.9;
assert.equal(segments['note:group'](changed), '4 人及以上享 9 折');
console.log('✔ 1.15 夹具四段同变，admin.html 比对按预期变红；镜像写回保留其他字节');

assert.equal(travelPolicySchema.safeParse({ ...p, extra: 1 }).success, false);
assert.equal(travelPolicySchema.safeParse({ ...p, pricing: { ...p.pricing, extra: 1 } }).success, false);
assert.equal(travelPolicySchema.safeParse({ ...p, version: 2 }).success, false);
assert.equal(
  travelPolicySchema.safeParse({ ...p, refund: { ...p.refund, tiers: [{ ...p.refund.tiers[0], percent: 120 }] } }).success,
  false,
);
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  return value;
}
assert.equal(canonical(travelPolicySchema.parse(reverseKeys(p))), canonical(p));
assert.equal(canonical(reverseKeys(p) as TravelPolicy), canonical(p));
assert.deepEqual(upgrade({}), p);
assert.deepEqual(upgrade({ refund: { selfService: false }, pricing: { peakMultiplier: 1.15 } }), {
  ...p,
  pricing: { ...p.pricing, peakMultiplier: 1.15 },
  refund: { ...p.refund, selfService: false },
});
for (const invalid of [null, [], { extra: 1 }, { version: 2 }, { pricing: null }, { refund: { selfService: 'true' } }])
  assert.throws(() => upgrade(invalid));
assert.equal(travelPriceThresholds.peakMultiplier, 1.1);
assert.equal(travelPriceThresholds.groupDiscount, 0.95);
assert.equal(travelPriceThresholds.groupMinimum, 4);
assert.equal(travelDateThresholds.maxDepartMonths, 12);
assert.equal(travelPolicy.refund(p), p.refund);
assert.deepEqual(travelPolicy.editable, ['refund', 'change']);
const all = clauses(p);
assert.equal(all.length, 8);
assert.deepEqual(
  all.map((clause) => clause.topic),
  ['refund', 'refund', 'refund', 'refund', 'change', 'visa', 'insurance', 'fees'],
);
assert.deepEqual(
  all.slice(0, 4).map((clause) => `${clause.text}（${clause.title}）`),
  [
    '出发前30天及以上取消，退全款（退改条款第1条）',
    '出发前15–29天取消，退订单金额的80%（退改条款第2条）',
    '出发前7–14天取消，退订单金额的50%（退改条款第3条）',
    '出发前0–6天取消，不能自助退，由顾问为您处理（退改条款第4条）',
  ],
);
const fourTiers = clauses({
  ...p,
  refund: {
    ...p.refund,
    tiers: [
      ...p.refund.tiers.slice(0, 2),
      { id: 'd10', minDays: 10, maxDays: 14, percent: 60 },
      { id: 'd3', minDays: 3, maxDays: 9, percent: 30 },
    ],
  },
});
assert.deepEqual(
  fourTiers.filter((clause) => clause.topic === 'refund').map((clause) => [clause.id, clause.title]),
  [
    ['d30', '退改条款第1条'],
    ['d15', '退改条款第2条'],
    ['d10', '退改条款第3条'],
    ['d3', '退改条款第4条'],
    ['below-min', '退改条款第5条'],
  ],
  '档位增减后出处按天数重排，低于最低档的那条排最后',
);
assert.equal(all[4].text, p.change);
assert.equal(all[5].text, VISA_REPLY);
// 07 第 10 步：保险、费用两句口径与签证同一做法，引用 claim-words 的常量；出处不进 policy，随租户改档位也不变
assert.equal(all[6].text, INSURANCE_REPLY);
assert.equal(all[7].text, FEES_REPLY);
assert.deepEqual(
  all.slice(5).map((clause) => clause.title),
  ['签证说明', '保险说明', '费用说明'],
);
for (const clause of all) assert.doesNotMatch(`${clause.text}（${clause.title}）`, /[*#`[\]]/);
assert.equal(p.refund.tiers.length, 3);
assert.equal(p.refund.selfService, true);
assert.equal(p.refund.approvalThresholdYuan, 30000);
assert.deepEqual(
  p.refund.tiers.map((tier) => [tier.minDays, tier.maxDays, tier.percent]),
  [
    [30, null, 100],
    [15, 29, 80],
    [7, 14, 50],
  ],
);
console.log('✔ 严格 schema、稳定 canonical、upgrade、条款出处、阈值通过');
