import assert from 'node:assert/strict';
import { quoteRefund } from './refund.js';
import type { Order } from '../types.js';
import type { RefundTerms } from './pack-api.js';

const terms: RefundTerms = {
  selfService: true,
  approvalThresholdYuan: 30000,
  tiers: [
    { id: 'near', minDays: 7, maxDays: 14, percent: 50 },
    { id: 'far', minDays: 30, maxDays: null, percent: 100 },
    { id: 'middle', minDays: 15, maxDays: 29, percent: 80 },
  ],
};
const order: Order = {
  id: 'ord_refund',
  sessionId: 'sim-refund',
  routeId: 'r-test',
  routeTitle: '合成线路',
  travelers: 1,
  departDate: '2026-12-31',
  totalPrice: 101,
  status: 'paid',
  paidAt: 1,
  createdAt: 0,
};
for (const [days, percent] of [
  [30, 100],
  [29, 80],
  [15, 80],
  [14, 50],
  [7, 50],
  [6, null],
  [0, null],
  [-1, null],
] as const) {
  const today = new Date(Date.parse('2026-12-31T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
  const before = JSON.stringify({ order, terms });
  const result = quoteRefund(order, terms, 'published-hash', today);
  if (percent === null) assert.deepEqual(result, { ineligible: days < 0 ? 'departed' : 'no_tier' });
  else {
    assert.ok(!('ineligible' in result));
    assert.equal(result.daysBefore, days);
    assert.equal(result.amount, Math.floor((101 * percent) / 100));
    assert.equal(result.tier.percent, percent);
    assert.equal(result.policyHash, 'published-hash');
  }
  assert.equal(JSON.stringify({ order, terms }), before, '报价不修改订单或条款');
}
for (const status of ['pending_payment', 'cancelled', 'superseded', 'refund_pending', 'refunded'] as const) {
  assert.deepEqual(quoteRefund({ ...order, status }, terms, 'hash', '2026-11-01'), { ineligible: 'not_paid' });
}
assert.deepEqual(
  quoteRefund(
    {
      ...order,
      refund: {
        id: 'rf_000000000001',
        requestedAt: 1,
        daysBefore: 40,
        tierId: 'd30',
        percent: 100,
        amount: 101,
        policyHash: 'old',
        approval: 'rejected',
        settlement: 'mock',
      },
    },
    terms,
    'new',
    '2026-11-01',
  ),
  { ineligible: 'rejected_before' },
);
const dst = quoteRefund({ ...order, departDate: '2026-03-30' }, terms, 'hash', '2026-02-28');
assert.ok(!('ineligible' in dst) && dst.daysBefore === 30, '按日历算，不受夏令时影响');
console.log('REFUND QUOTE SELFTEST PASS: 档位边界、取整、四种拒绝、纯函数与日期');
