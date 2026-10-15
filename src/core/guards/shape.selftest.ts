// 06 R10：行数与字数的数法（第 1 步只有纯函数与放行的 shape_check 步骤）。
import assert from 'node:assert/strict';
import { replyCharCount, replyLineCount, shapeCheckStep } from './shape.js';
import type { ReplyGuardContext } from '../pack-api.js';

// 行数：数非空行
assert.equal(replyLineCount(''), 0);
assert.equal(replyLineCount('   \n\t\n'), 0);
assert.equal(replyLineCount('一句话'), 1);
assert.equal(replyLineCount('第一行\n第二行\n第三行'), 3);
assert.equal(replyLineCount('第一行\n\n\n第二行\r\n第三行\n'), 3);
// 「·」开头的每一项各算一行
assert.equal(replyLineCount('为您找到两条：\n· 云南丽江 6 日\n· 贵州荔波 6 日\n您看哪条合适？'), 4);
// 先去 markdown：列表标记变成「· 」，加粗和标题记号不占行也不占字
assert.equal(replyLineCount('## 推荐\n- 云南\n- 贵州\n**价格**写在同一句里'), 4);
assert.equal(replyLineCount('**加粗**'), 1);

// 字数：去 markdown，不计空白，按码点计
assert.equal(replyCharCount(''), 0);
assert.equal(replyCharCount('你好 呀\n再见'), 5);
assert.equal(replyCharCount('**你好**'), 2);
assert.equal(replyCharCount('- 云南'), 3); // 「· 云南」：· 与两个字
assert.equal(replyCharCount('😊好'), 2);

// shape_check 本步放行：不改文本、不记事件
const events: string[] = [];
const ctx = { text: '原文\n第二行', recordGuard: () => events.push('x') } as unknown as ReplyGuardContext;
const step = shapeCheckStep();
assert.equal(step.id, 'shape_check');
assert.deepEqual(step.after, ['identity']);
assert.deepEqual(await step.run(ctx), { action: 'pass' });
assert.equal(ctx.text, '原文\n第二行');
assert.deepEqual(events, []);

console.log('shape 自测通过：行数、字数、放行步骤');
