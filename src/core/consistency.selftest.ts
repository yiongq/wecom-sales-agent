// 06 R21 的通用部分：失败信息点名规则与双方、白名单与待裁决只认「规则 + 位置」、三种检查函数。不认识任何行业。
// 用法：npx tsx src/core/consistency.selftest.ts
import assert from 'node:assert/strict';
import {
  formatConflict,
  hedgeConflicts,
  lineCapConflicts,
  originProblems,
  passThroughConflicts,
  resolveConflicts,
  type ConsistencyConflict,
} from './consistency.js';

let passed = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  passed++;
};

const hedge = /按最终行程.{0,8}微调|可能微调/;
const definite = /总价/;

// hedgeConflicts：同段有确定价说法就点名那一处；没有就点名给定的模板；没命中不报
{
  const same = hedgeConflicts({
    rule: 'r1',
    texts: [{ id: 'tpl.a', where: 'w:a', text: '总价 ¥100，按最终行程微调' }],
    hedge,
    definite,
    counterpart: 'tpl.quote',
  });
  ok(
    same.length === 1 && same[0]!.a === 'tpl.a' && same[0]!.b.includes('总价') && same[0]!.match === '按最终行程微调',
    '同段：点名自己里面的确定价说法',
  );
  const other = hedgeConflicts({
    rule: 'r1',
    texts: [{ id: 'tpl.b', where: 'w:b', text: '可能微调' }],
    hedge,
    definite,
    counterpart: 'tpl.quote',
  });
  ok(other.length === 1 && other[0]!.b === 'tpl.quote', '同段没有确定价：点名代码里的确定价模板');
  ok(
    hedgeConflicts({ rule: 'r1', texts: [{ id: 'c', where: 'w:c', text: '次日节奏微调' }], hedge, definite, counterpart: 'x' }).length ===
      0,
    '没命中不报',
  );
  // 带全局标志的正则也不会因 lastIndex 漏报
  const g = hedgeConflicts({
    rule: 'r1',
    texts: [1, 2].map((i) => ({ id: `t${i}`, where: `w${i}`, text: '可能微调' })),
    hedge: /可能微调/g,
    definite,
    counterpart: 'x',
  });
  ok(g.length === 2, '全局标志的正则：每段都查');
}

// formatConflict：规则 id 和双方都在
{
  const c: ConsistencyConflict = {
    rule: 'quote-final',
    a: 'sop:stages/quote',
    b: 'fixed:quote.line.exact-date',
    detail: '出现了「可能微调」',
    where: 'sop:stages/quote',
  };
  const text = formatConflict(c);
  ok(
    text.includes('[quote-final]') && text.includes('sop:stages/quote') && text.includes('fixed:quote.line.exact-date'),
    '失败信息点名规则 id 和双方',
  );
}

// resolveConflicts：豁免只认规则加位置；没命中的豁免和待裁决要报出来（过期要删）
{
  const hit = (rule: string, where: string): ConsistencyConflict => ({ rule, a: 'a', b: 'b', detail: 'd', where });
  const res = resolveConflicts(
    [hit('r1', 'w1'), hit('r1', 'w2'), hit('r2', 'w1'), hit('r1', 'w3')],
    [
      { rule: 'r1', where: 'w1', note: 'n' },
      { rule: 'r1', where: 'gone', note: 'n' },
    ],
    [
      { rule: 'r1', where: 'w2', note: 'n' },
      { rule: 'r9', where: 'gone', note: 'n' },
    ],
  );
  ok(res.exempted.length === 1 && res.exempted[0]!.where === 'w1' && res.exempted[0]!.rule === 'r1', '豁免：规则和位置都对上才放过');
  ok(res.pending.length === 1 && res.pending[0]!.where === 'w2', '待裁决：单独一栏');
  ok(res.failing.map((c) => `${c.rule}@${c.where}`).join(',') === 'r2@w1,r1@w3', '其余都失败：同位置的另一条规则、别的位置不被放过');
  ok(res.unusedExemptions.length === 1 && res.unusedPending.length === 1, '没命中的豁免和待裁决被报出来');
}

// passThroughConflicts：变了就报，点名条目和变换；applies 挡掉不适用的；异步变换也行；位置键带变换 id
{
  const items = [
    { id: 'fixed:a', where: 'fixed:a', text: '你好', afterHandoff: false },
    { id: 'fixed:b', where: 'fixed:b', text: '随时找我', afterHandoff: true },
  ];
  const out = await passThroughConflicts({
    rule: 'fixed-vs-guards',
    items,
    transforms: [
      { id: 'guard:x', run: (t) => t.replace('你好', '您好') },
      { id: 'guard:post', run: async (t) => t.replace('随时找我', ''), applies: (i) => i.afterHandoff },
      { id: 'guard:late', run: (t) => t.replace('随时找我', ''), applies: (i) => !i.afterHandoff },
    ],
  });
  ok(out.length === 2, '变了的各报一条，applies 挡掉的不跑');
  ok(
    out[0]!.a === 'fixed:a' &&
      out[0]!.b === 'guard:x' &&
      out[0]!.where === 'fixed:a|guard:x' &&
      formatConflict(out[0]!).includes('[fixed-vs-guards]'),
    '点名条目与变换，位置键带变换 id',
  );
  ok(out[1]!.b === 'guard:post', '异步变换');
}

// 按管线位置过滤：固定文字只穿过产出它的步骤之后的变换；不经出口护栏的一条都不穿；声明错了的被点名
{
  const order = { reply: ['pre_clean', 'markdown', 'stranded', 'final_clean'], followup: ['pre_clean', 'final_clean'] };
  const strip = { id: 'guard:markdown', steps: { reply: 'markdown' }, run: (t: string) => t.replace(/ {2,}/g, ' ') };
  const clean = { id: 'guard:final_clean', steps: { reply: 'final_clean', followup: 'final_clean' }, run: (t: string) => t.trim() };
  const mk = (origin: import('./consistency.js').FixedReplyOrigin) => ({ id: 'f', where: 'f', text: ' a  b ', origin });
  const run = async (origin: import('./consistency.js').FixedReplyOrigin) =>
    (await passThroughConflicts({ rule: 'r', items: [mk(origin)], transforms: [strip, clean], order })).map((c) => c.b).join(',');
  ok((await run({ pipeline: 'reply', step: 'pre_clean' })) === 'guard:markdown,guard:final_clean', '管线开头产出：每道都穿过');
  ok((await run({ pipeline: 'reply', step: 'stranded' })) === 'guard:final_clean', '在 markdown 之后产出：不再穿过 markdown');
  ok((await run({ outside: '支付回调直发' })) === '', '不经出口护栏：一道都不穿');
  ok((await run({ pipeline: 'followup', step: null })) === 'guard:final_clean', '别的管线里没有的步骤不算');
  ok(
    originProblems({ items: [mk({ pipeline: 'reply', step: 'stranded' })], transforms: [strip, clean], order }).length === 0,
    '声明对了没有问题',
  );
  const bad = originProblems({
    items: [mk({ pipeline: 'reply', step: 'nope' }), mk({ pipeline: 'x', step: null }), mk({ outside: ' ' })],
    transforms: [{ id: 'g', steps: { reply: 'missing' }, run: (t) => t }],
    order,
  });
  ok(bad.length === 4, '不存在的步骤、管线，没写原因的 outside，写错步骤 id 的变换，都被点名');
}

// lineCapConflicts：按类别取上限
{
  const out = lineCapConflicts({
    rule: 'fixed-vs-guards',
    items: [
      { id: 'p', where: 'p', text: '一\n二\n三\n四', kind: 'plain' },
      { id: 'r', where: 'r', text: '一\n二\n三\n四', kind: 'rich' },
    ],
    caps: { rich: 6, plain: 3 },
  });
  ok(
    out.length === 1 && out[0]!.a === 'p' && out[0]!.b === 'line-cap:plain=3' && out[0]!.where === 'p|line-cap',
    '普通类 4 行超限、推荐类 4 行不超',
  );
}

console.log(`CORE CONSISTENCY SELFTEST PASS: ${passed} 项`);
