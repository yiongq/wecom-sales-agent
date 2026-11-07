// 18 R2、R6 附表与前后对比：手写合成数据，不调用引擎、模型或外部服务。
import assert from 'node:assert/strict';
import type { JourneyReport, LedgerLine } from './report-types.js';
import type { RunResult } from './runner.js';
import { bodyOf, buildAppendix18, journalCounts, renderCompare18, renderTriage, tallyTriage, type TriageTally } from './report-18.js';
import { DETECTORS } from './triage.js';

let passed = 0;
function test(name: string, body: () => void): void {
  body();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

type Turn = {
  reply: string;
  silent?: boolean;
  guards?: { guard: string; action: string }[];
  blocks?: { rendered: { name: string }[]; bareItemAmounts: number };
};
function run(runId: string, turns: Turn[]): RunResult {
  return {
    runId,
    goalId: 'g',
    repetition: 1,
    turns: turns.map((t) => ({
      reply: t.reply,
      silent: !!t.silent,
      trace: { turn: { guards: t.guards ?? [], ...(t.blocks ? { blocks: t.blocks } : {}) } },
    })),
  } as unknown as RunResult;
}
const line = (runId: string, event: LedgerLine['event'], kind: LedgerLine['kind'] = 'main'): LedgerLine =>
  ({ runId, event, kind }) as LedgerLine;
const summary = (runId: string, scenes: JourneyReport['scenes']) =>
  ({
    meta: { runId },
    success: { rate: 0.9, conservative: 0.88, byRuns: { low: 0.8, high: 0.95 } },
    latency: { p90: 4800 },
    cost: { salesPerRun: 0.0142 },
    scenes,
  }) as unknown as Pick<JourneyReport, 'meta' | 'success' | 'latency' | 'cost' | 'scenes'>;

const BLOCK = [
  '试算：',
  'HS1000 × 3：单价10.00元，小计30.00元；现货，以顾问确认为准；满10件9.00元',
  'M8×30 × 60：试算单价0.85元，小计51.00元',
  '另有 1 行需确认：HS2000（未找到）',
  '另外 2 行已算好，需要的话我出一份正式报价单',
  '合计81.00元',
  '试算合计81.00元',
  '试算档位价：',
  'HS1000 试算档位：1–9件10.00元；10件起9.00元；起订量1件',
  '您接受的这份报价合计81.00元',
];

test('有块时剔除块内各行，正文行保留', () => {
  const body = ['先说明一下。', ...BLOCK, '另外单价10元的那行要等 3 天。'].join('\n');
  assert.equal(bodyOf(body, true), '先说明一下。\n另外单价10元的那行要等 3 天。');
});
test('没有块时正文原样不动', () => {
  const text = BLOCK.join('\n');
  assert.equal(bodyOf(text, false), text);
});
test('暂时报不了价的单行也算块内', () => {
  assert.equal(bodyOf('暂时报不了价：HS9（起订量10件）\n请确认数量。', true), '请确认数量。');
});

test('journal 计数：跳过静默轮，按块区分模型写的和客户看到的金额', () => {
  const counts = journalCounts([
    run('r', [
      { reply: '单价10元，小计30元。', guards: [{ guard: 'money_provenance', action: 'drop_sentence' }] },
      {
        reply: ['好的。', ...BLOCK.slice(0, 2), '合计30.00元'].join('\n'),
        blocks: { rendered: [{ name: '试算明细' }], bareItemAmounts: 2 },
      },
      { reply: '合计99元', silent: true },
      { reply: '运费0元。', guards: [{ guard: 'money_provenance', action: 'replace' }] },
    ]),
  ]);
  assert.deepEqual(counts, { turns: 3, moneyDropTurns: 1, modelItemAmounts: 4, bodyItemAmounts: 2 });
});

const ledger = [
  line('m1', 'start'),
  line('m1', 'end'),
  line('m2', 'start'),
  line('s1', 'start', 'customer_swap'),
  line('s1', 'end', 'customer_swap'),
  line('m3', 'start'),
  line('m3', 'end'),
];
const summaries = [
  { runId: 'm1', turns: 100, status: 'recorded' },
  { runId: 'm3', turns: 200, status: 'recorded' },
  { runId: 's1', turns: 50, status: 'recorded' },
];
const candidates = [
  { id: 'a', detector: 'price_withheld' as const, runId: 'm1' },
  { id: 'b', detector: 'price_withheld' as const, runId: 'm1' },
  { id: 'c', detector: 'dangling' as const, runId: 'm3' },
  { id: 's', detector: 'dangling' as const, runId: 's1' },
];
const verdicts = [
  { id: 'a', verdict: 'confirmed' as const },
  { id: 'b', verdict: 'false_positive' as const },
  { id: 'c', verdict: 'confirmed' as const },
];

test('按账本开跑顺序编号，中止的列出不计，换客户模型不进附表', () => {
  const tally = tallyTriage({ ledger, summaries, candidates, verdicts });
  assert.deepEqual(
    tally.runs.map((r) => [r.attempt, r.runId, r.turns]),
    [
      [1, 'm1', 100],
      [3, 'm3', 200],
    ],
  );
  assert.deepEqual(tally.aborted, [{ attempt: 2, runId: 'm2' }]);
  assert.deepEqual(tally.runs[0]!.detectors.price_withheld, { suspects: 2, confirmed: 1 });
  assert.deepEqual(tally.runs[1]!.detectors.dangling, { suspects: 1, confirmed: 1 });
  assert.equal(Object.keys(tally.runs[0]!.detectors).length, DETECTORS.length);
});
test('疑似没有裁定、裁定重复、裁定对不上疑似都拒绝', () => {
  assert.throws(() => tallyTriage({ ledger, summaries, candidates, verdicts: verdicts.slice(1) }), /疑似没有裁定：a/);
  assert.throws(() => tallyTriage({ ledger, summaries, candidates, verdicts: [...verdicts, verdicts[0]!] }), /裁定重复：a/);
  assert.throws(
    () => tallyTriage({ ledger, summaries, candidates, verdicts: [...verdicts, { id: 'x', verdict: 'confirmed' }] }),
    /没有对应的疑似：x/,
  );
});

test('前后对比与附表的渲染', () => {
  const tally: TriageTally = tallyTriage({ ledger, summaries, candidates, verdicts });
  const scene = (family: string, passed: number, total: number, excluded = 0) => ({
    id: family,
    family,
    passed,
    total,
    excluded,
    voided: false,
  });
  const appendix = buildAppendix18({
    tally,
    before: { summary: summary('m1', [scene('砍价施压', 9, 10, 1)]), runs: [run('m1', [{ reply: '单价10元' }])] },
    after: { summary: summary('m3', [scene('砍价施压', 9, 10), scene('附件询价', 5, 5)]), runs: [run('m3', [{ reply: '好的' }])] },
  });
  assert.equal(appendix.before.modelItemAmounts, 1);
  assert.equal(appendix.after.bodyItemAmounts, 0);
  assert.equal(appendix.before.confirmedPer100, 1);
  assert.equal(appendix.after.confirmedPer100, 0.5);
  assert.deepEqual(appendix.families, [
    { family: '砍价施压', before: { passed: 9, total: 9 }, after: { passed: 9, total: 10 } },
    { family: '附件询价', before: { passed: 0, total: 0 }, after: { passed: 5, total: 5 } },
  ]);
  const compare = renderCompare18(appendix);
  assert.match(compare, /\| 金额护栏删句轮数 \| 0 \/ 1 \| 0 \/ 1 \|/);
  assert.match(compare, /\| 砍价施压 \| 9\/9 \| 9\/10 \|/);
  const triage = renderTriage(appendix);
  assert.match(triage, /\| 合计 \| 2 \/ 1 \| 1 \/ 1 \|/);
  assert.match(triage, /\| 误报率 \| 50\.0% \| 0\.0% \|/);
  assert.match(triage, /第 2 次（m2）开跑后中止/);
  assert.throws(
    () => buildAppendix18({ tally, before: { summary: summary('zz', []), runs: [] }, after: { summary: summary('m3', []), runs: [] } }),
    /附表缺少运行 zz/,
  );
});

console.log(`report-18 自测 ${passed} 组全部通过`);
