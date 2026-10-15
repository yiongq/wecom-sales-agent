// 06 第 8 步（R12）：结尾句三种渲染、同类结尾识别、收尾轮判定（用真的 hooks 常量）。
import assert from 'node:assert/strict';
import { closingLine, HAS_CLOSING, isClosingTurn } from './closing-words.js';
import type { ContactMode } from './contact-words.js';

const modes: Record<string, ContactMode> = {
  legacyWecom: { channel: 'wecom', templateMode: false },
  legacyWeb: { channel: 'web', templateMode: false },
  templateWecom: { channel: 'wecom', templateMode: true },
  templateWeb: { channel: 'web', templateMode: true },
};
assert.equal(closingLine(modes.legacyWecom), '有问题随时在微信上问我～');
assert.equal(closingLine(modes.legacyWeb), '有问题随时在这个页面里问我～');
assert.equal(closingLine(modes.templateWecom), '有问题随时问我～');
assert.equal(closingLine(modes.templateWeb), '有问题随时在这个页面里问我～');
for (const mode of Object.values(modes)) {
  const line = closingLine(mode);
  // plan 第 0.2 步：不得含锁定断言禁用的说法；不点名品牌、不带 markdown
  assert.ok(!/随时告诉我|马上帮您查|随时找我|云途/.test(line), line);
  assert.ok(!/[*#`]/.test(line), line);
  // 自己的结尾句算「同类结尾」：幂等
  assert.ok(HAS_CLOSING.test(line), line);
}
assert.ok(!/微信|页面/.test(closingLine(modes.templateWecom)));

for (const yes of ['好的，有问题随时问我～', '您先商量，需要的话随时联系我', '不着急，慢慢看', '欢迎再来问我', '有任何问题再问我']) {
  assert.ok(HAS_CLOSING.test(yes), yes);
}
for (const no of ['好的，您先和家人商量，报价我这边给您留着。', '这条线路起价 16800 元。', '丽江大理这条 6 天 5 晚。']) {
  assert.ok(!HAS_CLOSING.test(no), no);
}

const { createTravelTurnHooks } = await import('./turn.js');
type Sources = Parameters<typeof createTravelTurnHooks>[0];
const hooks = createTravelTurnHooks({ loadRoutes: () => [], getOrder: () => undefined, mentionsPlace: () => false } as unknown as Sources);
const closing = (text: string) =>
  isClosingTurn(text, {
    ORDER_DEFERRED: hooks.ORDER_DEFERRED,
    QUOTE_ONLY: hooks.QUOTE_ONLY,
    ORDER_QUESTION: hooks.ORDER_QUESTION,
    PRICE_OK: hooks.PRICE_OK,
  });
// 算收尾
for (const t of ['我回去商量商量', '我再想想', '谢谢，先这样', '先这样吧', '谢谢您', '回头再说', '我考虑考虑']) assert.ok(closing(t), t);
// 不算：d8c 带报价、p2 带发方案（QUOTE_ONLY 先排除）、问句、「不考虑」、PRICE_OK 去掉后只剩订单意图、普通话
for (const t of [
  '先去云南，明年再考虑日本，报个价吧',
  '先不用发方案了，我再想想',
  '你们有没有更便宜的？我再考虑考虑',
  '就看云南这条，别的不考虑',
  '不用再看看了，就订这个',
  '丽江大理两个人',
  '好的',
]) {
  assert.ok(!closing(t), t);
}
// 排除顺序：QUOTE_ONLY 先于推迟词
assert.ok(hooks.QUOTE_ONLY.test('先不用发方案了，我再想想') && hooks.ORDER_DEFERRED.test('先不用发方案了，我再想想'));

console.log('closing-words 自测通过：三种渲染、同类结尾识别、收尾轮判定');
