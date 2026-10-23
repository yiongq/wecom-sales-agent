import assert from 'node:assert/strict';
import type { Order, RefundTextContext } from '../../core/pack-api.js';
import { quoteRefund } from '../../core/pack-api.js';
import { fixtureOrder, MODE_CTX } from './fixed-replies.js';
import { defaultTravelPolicy } from './policy.js';
import { refundQuoteText, refundChooseText, refundTexts, refundNoticeText } from './refund-words.js';

const order = fixtureOrder({ id: 'ord_a1b2c3', status: 'paid', departDate: '2099-12-10', paidAt: 1 });
const q = quoteRefund(order, defaultTravelPolicy.refund, 'published', '2099-10-16');
assert.ok(!('ineligible' in q));
for (const mode of MODE_CTX) {
  const ctx: RefundTextContext = { policy: defaultTravelPolicy, channel: mode.channel, brand: mode.brand };
  const quote = refundQuoteText(order, q, ctx);
  assert.equal(
    quote,
    `《${order.routeTitle}》2 位、12 月 10 日出发（订单尾号 a1b2c3）：离出发 55 天，按退改条款第1条可退全款 ¥33,600。确认退款请回复「确认退款」。`,
  );
  const texts = refundTexts(q, ctx);
  assert.equal(texts.done, '已为您办好退款 ¥33,600（退改条款第1条）。这是演示环境的模拟退款，不产生真实打款。');
  assert.ok(texts.submitted.includes('金额超过 ¥30,000 要顾问审核'));
  const auto = refundTexts({ ...q, amount: 500 }, ctx);
  assert.ok(auto.submitted.includes('按原付款方式退回'));
  const refundOrder: Order = {
    ...order,
    refund: {
      id: 'rf_000000000001',
      requestedAt: 1,
      daysBefore: q.daysBefore,
      tierId: q.tier.id,
      percent: q.tier.percent,
      amount: q.amount,
      policyHash: q.policyHash,
      approval: 'approved' as const,
      settlement: 'mock' as const,
    },
  };
  assert.equal(refundNoticeText(refundOrder, 'settled', ctx), texts.done);
  const notice = refundNoticeText({ ...refundOrder, refund: { ...refundOrder.refund!, settlement: 'advisor' } }, 'settled', ctx);
  assert.equal(notice, '顾问已确认按原付款方式退回 ¥33,600（退改条款第1条），请留意到账情况。');
  const rejected = refundNoticeText(refundOrder, 'rejected', ctx);
  const samples = [quote, ...Object.values(texts), auto.submitted, rejected, notice];
  assert.ok(samples.every((s) => !/\*\*|^#{1,6}\s/m.test(s) && !s.includes('云途')));
  if (mode.mode === 'template') assert.ok(samples.every((s) => !/微信|这个页面/.test(s)));
  else if (mode.mode === 'web') assert.ok(texts.submitted.includes('在这个页面里回复您') && rejected.includes('在这个页面里跟您说明'));
  else assert.ok(texts.submitted.includes('在微信上联系您') && rejected === '退款申请没有通过，顾问会在微信上跟您说明。');
  const custom = structuredClone(defaultTravelPolicy);
  custom.refund.approvalThresholdYuan = 40000;
  custom.refund.tiers = [...custom.refund.tiers].reverse();
  const changed = refundTexts(q, { ...ctx, policy: custom });
  assert.ok(!changed.submitted.includes('要顾问审核') && changed.done.includes('退改条款第1条'));
  custom.refund.approvalThresholdYuan = 12345;
  assert.ok(refundTexts(q, { ...ctx, policy: custom }).submitted.includes('¥12,345'));
}
const choose = refundChooseText([order, { ...order, id: 'ord_d4e5f6', routeTitle: '合成第二条线路', departDate: '2099-12-20' }]);
assert.ok(choose.includes('a1b2c3') && choose.includes('d4e5f6') && choose.includes('2099-12-20') && choose.includes('请回复'));
console.log('REFUND WORDS SELFTEST PASS: 报价、选单、五句回复、两类通知、三种联系方式与动态政策');
