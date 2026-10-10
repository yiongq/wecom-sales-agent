// 阶段同源、工具画像的信任边界与昵称/头像隔离契约。
import assert from 'node:assert/strict';
import { profileForPrompt, type PackRuntime, type Route, type Session, type TurnToolCall } from '../../core/pack-api.js';
import { travel } from './console-pack.js';
import { advanceStage, createTravelProfileExtractor, stages } from './progress.js';

const stageHooks: Pick<PackRuntime, 'advanceStage' | 'stages'> = { advanceStage, stages };
assert.deepEqual(
  stageHooks.stages,
  travel.stages.map(({ key, terminal }) => ({ id: key, ...(terminal ? { terminal } : {}) })),
);
assert.equal(
  stageHooks.stages.some((s) => s.id === 'handoff'),
  false,
);
assert.deepEqual(
  stageHooks.stages.filter((s) => s.terminal).map((s) => s.id),
  ['paid'],
);

const session: Session = {
  id: 'simulator:progress',
  channel: 'web',
  stage: 'discovery',
  profile: { nickname: '测试昵称', avatar: 'https://avatar.invalid/fixture', notes: ['偏好安静'] },
  messages: [],
  orderIds: [],
  handedOver: false,
  createdAt: 0,
  updatedAt: 0,
};
const other: Session = { ...session, id: 'simulator:other', profile: { segment: '家庭' } };
const calls = new Map<Session, TurnToolCall[]>();
const monthOnly = new WeakSet<object>();
const runtime = createTravelProfileExtractor({
  loadRoutes: () => [{ id: 'fixture', destination: '测试地' } as Route],
  toolCalls: (current) => calls.get(current) ?? [],
  isMonthOnly: (args) => monthOnly.has(args),
  todayIso: () => '2026-10-10',
  liftsBudget: (text) => text === '预算不是问题',
  budgetLifted: /预算不是问题/,
});

calls.set(session, [
  { name: 'search_routes', args: { destination: '测试地', segment: '蜜月', maxBudgetPerPerson: 50000 } },
  { name: 'create_quote', args: { routeId: 'fixture', travelers: 3, departDate: '2099-12-12' } },
]);
const extracted = runtime.extractProfile('带爸妈去，每人一万到两万', session);
assert.deepEqual(extracted, {
  ...session.profile,
  destinationInterest: '测试地',
  travelers: '3人',
  dates: '2099-12-12',
  segment: '银发',
  budget: '每人一万到两万',
});
assert.deepEqual(
  { ...session.profile },
  { nickname: '测试昵称', avatar: 'https://avatar.invalid/fixture', notes: ['偏好安静'] },
  '抽取只返回增量，不改会话',
);
assert.deepEqual(runtime.extractProfile('', other), { segment: '家庭' }, '本轮工具按会话读取，不串画像');
const prompt = profileForPrompt(extracted);
assert.equal('nickname' in prompt, false);
assert.equal('avatar' in prompt, false);
assert.deepEqual(prompt.notes, ['偏好安静']);

calls.set(session, [{ name: 'search_routes', args: { segment: '蜜月', maxBudgetPerPerson: 50000 } }]);
assert.equal(runtime.extractProfile('您好', session).segment, undefined, '非银发客群不采信模型参数');
assert.equal(runtime.extractProfile('您好', session).budget, undefined, '预算不采信模型参数');
calls.set(session, [{ name: 'search_routes', args: { segment: '银发' } }]);
assert.equal(runtime.extractProfile('您好', session).segment, '银发', '保留银发工具参数的安全例外');

session.profile.budget = '每人两万';
calls.set(session, []);
assert.equal(runtime.extractProfile('机票每人两千左右', session).budget, '每人两万');
assert.equal(runtime.extractProfile('至少每人三万', session).budget, '至少每人三万');
assert.equal(runtime.extractProfile('预算不是问题', session).budget, '预算不是问题');
const args = { travelers: 2, departDate: '2099-12-12' };
monthOnly.add(args);
calls.set(session, [{ name: 'generate_proposal', args }]);
assert.equal(runtime.extractProfile('', session).dates, undefined, '仅月份补价不沉淀为出发日期');
assert.equal(runtime.extractProfile('明年5月1日出发', session).dates, '2027-05-01', '原话的日期优先');
assert.equal(runtime.extractProfile('国庆期间人多吗', session).dates, undefined, '节日旁问不沉淀出发日期');
calls.set(session, [{ name: 'create_quote', args: { departDate: '2000-01-01' } }]);
assert.equal(runtime.extractProfile('', session).dates, undefined, '被拒的过去工具日期不进入画像');

assert.equal(advanceStage({ ...session, stage: 'paid' }, { calls: [{ name: 'get_route_detail', args: {} }], terminal: true }), 'paid');
assert.equal(advanceStage({ ...session, stage: 'paid' }, { calls: [{ name: 'search_routes', args: {} }], terminal: true }), 'recommend');
assert.equal(advanceStage(session, { calls: [{ name: 'generate_proposal', args: {} }], terminal: false }), 'quote');
assert.equal(advanceStage({ ...session, stage: 'closing' }, { calls: [{ name: 'search_routes', args: {} }], terminal: false }), 'closing');
assert.equal(
  advanceStage(session, { calls: [{ name: 'create_quote', args: {} }], terminal: false, customerText: '太贵了' }),
  'objection',
  '先按工具推进，再按本轮原话判异议',
);
assert.equal(
  advanceStage({ ...session, stage: 'quote', orderIds: ['fixture-order'] }, { calls: [], terminal: false, customerText: '太贵了' }),
  'quote',
  '已建单客户不回落到异议',
);
console.log('PASS travel progress: 阶段同源、画像工具信任边界、日期与隐私契约');
