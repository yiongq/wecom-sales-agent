// 06 第 1 步：三种联系方式渲染、到账口径对客句，以及 createTravelTurnHooks 导出的三个常量。
import assert from 'node:assert/strict';
import { advisorCheck, advisorContact, paymentPendingReply, type ContactMode } from './contact-words.js';

const legacyWecom: ContactMode = { channel: 'wecom', templateMode: false };
const legacyWeb: ContactMode = { channel: 'web', templateMode: false };
const templateWecom: ContactMode = { channel: 'wecom', templateMode: true };
const templateWeb: ContactMode = { channel: 'web', templateMode: true };

// 旧版模式企微说微信，网页说页面，模板模式非网页不点名渠道
assert.equal(advisorContact(legacyWecom), '顾问会在微信上联系您');
assert.equal(advisorContact(legacyWeb), '顾问会在这个页面里回复您');
assert.equal(advisorContact(templateWecom), '顾问会联系您');
assert.equal(advisorContact(templateWeb), '顾问会在这个页面里回复您');

assert.equal(paymentPendingReply(legacyWecom), '款项到账后您会收到确认，顾问核实后会在微信上联系您。');
assert.equal(paymentPendingReply(legacyWeb), '款项到账后您会收到确认，顾问核实后会在这个页面里回复您。');
assert.equal(paymentPendingReply(templateWecom), '款项到账后您会收到确认，顾问核实后会联系您。');

for (const mode of [legacyWecom, legacyWeb, templateWecom, templateWeb]) {
  for (const text of [advisorContact(mode), paymentPendingReply(mode)]) {
    assert.ok(!text.includes('云途'), text);
    assert.ok(!/[*#`]/.test(text), text);
  }
  // 到账口径不说已到账 / 订单生效 / 订单已确认
  assert.ok(!/已到账|订单生效|订单已确认|款项已确认/.test(paymentPendingReply(mode)));
}
// 模板模式非网页不点名渠道
for (const text of [advisorContact(templateWecom), paymentPendingReply(templateWecom)]) assert.ok(!/微信|页面/.test(text), text);

// createTravelTurnHooks 导出 R12 / R10 要用的常量
const { createTravelTurnHooks } = await import('./turn.js');
// advisor 收款模式的核对价格句：旧版、网页的写法一字不动，模板模式（非网页）不点名渠道
assert.equal(advisorCheck(legacyWecom, '跟您核对价格并发收款方式'), '顾问会在微信里跟您核对价格并发收款方式');
assert.equal(advisorCheck(legacyWeb, '跟您核对价格并发收款方式'), '顾问会在这个页面里跟您核对价格并发收款方式');
assert.equal(advisorCheck(templateWeb, '核对价格、发收款方式'), '顾问会在这个页面里核对价格、发收款方式');
assert.equal(advisorCheck(templateWecom, '跟您核对价格并发收款方式'), '顾问会联系您核对价格、发收款方式');
assert.equal(advisorCheck(templateWecom, '核对价格、发收款方式'), advisorContact(templateWecom) + '核对价格、发收款方式');

type Sources = Parameters<typeof createTravelTurnHooks>[0];
const hooks = createTravelTurnHooks({
  loadRoutes: () => [],
  getOrder: () => undefined,
  mentionsPlace: () => false,
} as unknown as Sources);
assert.ok(hooks.ORDER_DEFERRED instanceof RegExp);
assert.ok(hooks.QUOTE_ONLY instanceof RegExp);
assert.ok(hooks.ORDER_QUESTION instanceof RegExp);
assert.ok(hooks.PRICE_ASK instanceof RegExp);
assert.ok(hooks.ORDER_DEFERRED.test('我回去商量商量'));
assert.ok(hooks.QUOTE_ONLY.test('先不用发方案了'));
assert.ok(hooks.ORDER_QUESTION.test('可以下单吗'));

console.log('contact-words 自测通过：三种渲染、到账口径、hooks 常量导出');
