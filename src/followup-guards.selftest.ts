// 04 R9 / 验收 8：搬家前 guardOutbound 的 23 组逐步文本与事件夹具，不随实现重写。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixtures from './packs/travel/followup-steps.fixtures.json' with { type: 'json' };
import type { Session, OrderStatus } from './types.js';
import type { FinishedTurn } from './trace/recorder.js';
import { travelFollowupSteps, type FollowupGuardContext } from './packs/travel/followup-steps.js';
import { createTravelReplyHelpers } from './packs/travel/reply-helpers.js';
import { createTravelTurnHooks } from './packs/travel/turn.js';
import { travelPriceThresholds } from './packs/travel/thresholds.js';
import { dejargonVocab } from './packs/travel/dejargon-vocab.js';
import { dejargon } from './core/guards/dejargon.js';
import { stripMarkdown, trimDangling } from './core/guards/text.js';
import { loadGuardPipeline } from './core/guards/execute.js';
import { stripAdvisorPrefix } from './shared/conversation.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-guards-'));
process.env.VAR_DIR = dir;
process.env.CONFIG_SOURCE = 'file';
process.env.NOTIFY_WEBHOOK_URL = '';
const store = await import('./store.js');
const tools = await import('./tools.js');
const priceGuard = await import('./price-guard.js');
const priceRules = await import('./price-rules.js');
const { guardOutbound, onToolCall } = await import('./engine.js');
const { withTurnScope, startTurn, endTurn, onTurnEnd, noteGuard } = await import('./trace/recorder.js');
const turnHooks = createTravelTurnHooks({
  ...tools,
  getOrder: store.getOrder,
  paymentMode: () => 'online',
  spokenMoney: priceGuard.spokenMoney,
  liftsBudget: priceRules.liftsBudget,
});
const steps = travelFollowupSteps({
  helpers: createTravelReplyHelpers({
    ...tools,
    getOrder: store.getOrder,
    paymentMode: () => 'online',
    turnHooks,
    priceGuard,
    extractProfile: (session) => session.profile,
    isTerminalStage: () => false,
    isConfigNotReadyError: () => false,
  }),
  turnHooks,
  priceGuard,
  priceRules,
  dejargon: (text, sid) => dejargon(text, sid, dejargonVocab),
  stripMarkdown,
  trimDangling,
  stripAdvisorPrefix,
});
const expectedIds = [
  'pre_clean',
  'link_whitelist',
  'markdown',
  'repair_links',
  'dejargon',
  'custom_promise',
  'handoff_claims',
  'unbacked_claims',
  'price',
  'stranded',
  'final_clean',
];
assert.deepEqual(
  steps.map((step) => step.id),
  expectedIds,
  '跟进保留开工顺序的独立 11 步',
);
let attemptedEffects = 0;
const forbidden = (): never => {
  attemptedEffects++;
  throw new Error('跟进不可执行副作用');
};
const seenChanges = new Set<string>();
const turns: FinishedTurn[] = [];
let toolCalls = 0;
const offTool = onToolCall(() => {
  toolCalls++;
});
const offTurn = onTurnEnd((turn) => turns.push(turn));
try {
  for (const fixture of fixtures) {
    const session = structuredClone(fixture.session) as Session;
    let text = fixture.input;
    if (fixture.orderStatus) {
      const order = store.createOrder({
        sessionId: session.id,
        routeId: 'r-yunnan',
        routeTitle: '云南',
        travelers: 2,
        departDate: '2026-12-10',
        totalPrice: 25600,
      });
      order.status = fixture.orderStatus as OrderStatus;
      session.orderIds.push(order.id);
      text = text.replace('{{order}}', order.id);
    }
    const normalize = (s: string) => session.orderIds.reduce((value, id) => value.replaceAll(id, '{{order}}'), s);
    const before = structuredClone(session);
    const ordersBefore = structuredClone(store.listOrders());
    const snapshots: string[] = [];
    const ctx: FollowupGuardContext = {
      session,
      text,
      turn: { flags: {} },
      toolSources: [],
      orderSources: [],
      brand: null,
      thresholds: travelPriceThresholds,
      createOrder: forbidden,
      enterHandoff: forbidden,
      callTool: forbidden,
      recordGuard: noteGuard,
    };
    const pipeline = loadGuardPipeline(steps);
    await withTurnScope(async () => {
      startTurn(session.id);
      const result = await pipeline.run(ctx, {
        onVerdict(verdict) {
          snapshots.push(normalize(ctx.text));
          if (verdict.action !== 'pass') seenChanges.add(verdict.id);
        },
      });
      assert.equal(result.aborted, false);
      assert.deepEqual(
        result.verdicts.map((v) => v.id),
        expectedIds,
      );
      assert.deepEqual(snapshots, fixture.steps, `${fixture.id}：11 步逐步等于搬家前文本`);
      assert.equal(normalize(result.text), fixture.text);
      endTurn('replied', result.text, session.stage, session.stage);
    });
    assert.deepEqual(
      turns.at(-1)!.turn.guards.map((event) => ({ guard: event.guard, action: event.action })),
      fixture.events,
      `${fixture.id}：兼容旧 guard_events，含两段 handoff_claims`,
    );
    assert.equal(turns.at(-1)!.turn.guardVerdicts, null, '执行器不把内部裁决写入跟进 trace');
    await withTurnScope(async () => {
      startTurn(session.id);
      const actual = await guardOutbound(session, text, { kind: 'followup' });
      assert.equal(normalize(actual), fixture.text, `${fixture.id}：门面出口等于搬家前`);
      endTurn('replied', actual, session.stage, session.stage);
    });
    assert.equal(turns.at(-1)!.turn.guardVerdicts, null, '门面在活跃轮次内也不写 guard_verdicts');
    assert.deepEqual(
      turns.at(-1)!.turn.guards.map((event) => ({ guard: event.guard, action: event.action })),
      fixture.events,
    );
    assert.equal(normalize(await guardOutbound(session, text, { kind: 'followup' })), fixture.text, '正常轮次外跟进出口相同');
    assert.deepEqual(session, before, `${fixture.id}：不转人工、不记待办、不改会话`);
    assert.deepEqual(store.listOrders(), ordersBefore, `${fixture.id}：不建单、不改订单`);
    if (fixture.id === 'combined') {
      assert.equal(fixture.text, '您更喜欢哪条线路？', '组合承诺只删命中句，保留其余文字');
      assert.deepEqual(
        fixture.events.map((e) => e.guard),
        ['repair_links', 'custom_promise', 'handoff_claims', 'handoff_claims'],
      );
    }
  }
  assert.deepEqual([...seenChanges].sort(), [...expectedIds].sort(), '夹具让 11 步全部命中改写，包含残句与半句');
  assert.equal(attemptedEffects, 0, '跟进步骤不调用任何工具、建单或转人工能力');
  assert.equal(toolCalls, 0, '门面跟进不补链接、不调工具');
  console.log(
    `FOLLOWUP GUARDS SELFTEST PASS: ${fixtures.length} 组旧实现差分 · 11 步全命中 · 双 handoff 事件 · 只删句/零副作用/无 guard_verdicts`,
  );
} finally {
  offTool();
  offTurn();
  await store.runShutdownHooks(5000);
  fs.rmSync(dir, { recursive: true, force: true });
}
