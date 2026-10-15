// 06 第 9 步（R10）：旅游包的上限、线路名行、可删句，配真实 hooks 常量。裁剪本身见 core/guards/shape.selftest.ts 与 eval/cases-v2/q06-shape.json。
import assert from 'node:assert/strict';
import { createTravelShapePolicy, TRAVEL_SHAPE_LIMITS } from './shape-words.js';
import type { Session } from '../../core/pack-api.js';

const { createTravelTurnHooks } = await import('./turn.js');
type Sources = Parameters<typeof createTravelTurnHooks>[0];
const hooks = createTravelTurnHooks({ loadRoutes: () => [], getOrder: () => undefined, mentionsPlace: () => false } as unknown as Sources);
const policy = createTravelShapePolicy({
  PRICE_ASK: hooks.PRICE_ASK,
  ORDER_DEFERRED: hooks.ORDER_DEFERRED,
  QUOTE_ONLY: hooks.QUOTE_ONLY,
  ORDER_QUESTION: hooks.ORDER_QUESTION,
  PRICE_OK: hooks.PRICE_OK,
});

// 阈值（owner 2026-10-15 定）
assert.deepEqual(TRAVEL_SHAPE_LIMITS, { richMaxLines: 6, plainMaxLines: 3, generatedListMaxLines: 8, maxChars: 300 });
assert.deepEqual([policy.richMaxLines, policy.plainMaxLines, policy.maxChars], [6, 3, 300]);
assert.ok(policy.richTools.includes('search_routes') && policy.richTools.includes('create_order'));
assert.ok(!policy.richTools.includes('handoff_to_human'));

// 线路名行
for (const l of [
  '《云南 丽江大理·洱海古城 6 日》',
  '· 云南 丽江大理 6 日',
  '云南 丽江大理·洱海古城 6 日游',
  '· 云南 丽江大理 6 日（含接送）',
]) {
  assert.ok(policy.isRouteTitleLine(l), l);
}
for (const l of ['祝您旅途愉快～', '含全程住宿，另有接送服务。']) assert.ok(!policy.isRouteTitleLine(l), l);

// 方案书：已发过（reminders.proposalSent）才算
assert.equal(policy.proposalSent({} as Session), false);
assert.equal(policy.proposalSent({ reminders: { proposalSent: 3 } } as Session), true);

// 可删句
const info = { closingTurn: false, proposalSent: false, askedPrice: false, amounts: [] as string[], priorAmounts: new Set<string>() };
assert.ok(policy.droppable('祝您旅途愉快～', info));
assert.ok(policy.droppable('期待您的消息～', info));
assert.ok(policy.droppable('有问题随时问我～', info));
assert.equal(policy.droppable('祝您旅途愉快～', { ...info, closingTurn: true }), null, '收尾轮不删祝福');
assert.equal(policy.droppable('方案书里有逐日行程。', info), null);
assert.ok(policy.droppable('方案书里有逐日行程。', { ...info, proposalSent: true }), '已发过方案书之后的方案书说明可删');
const old = { ...info, amounts: ['16800'], priorAmounts: new Set(['16800']) };
assert.ok(policy.droppable('之前报的每人 ¥16,800 起。', old));
assert.equal(policy.droppable('之前报的每人 ¥16,800 起。', { ...old, askedPrice: true }), null, '客户问价时旧报价不算复述');
assert.equal(policy.droppable('每人 ¥19,800 起。', { ...old, amounts: ['19800'] }), null);

// 收尾轮判定与 R12 同一份
assert.ok(policy.isClosingTurn('我回去商量商量'));
assert.ok(!policy.isClosingTurn('先不用发方案了，我再想想'));
assert.ok(policy.isClosingLine('有问题随时在微信上问我～'));
assert.ok(policy.asksPrice('这个多少钱'));

console.log('shape-words 自测通过：阈值、线路名行、可删句、收尾轮');
