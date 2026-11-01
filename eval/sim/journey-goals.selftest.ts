// 16 第 6 步：目标契约、固定切分、台词隔离、公开边界与空回复基线。
import '../../src/selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadGoals, type SimGoal } from './goals.js';
import { JOURNEY_COUNTS, JOURNEY_DIR, splitJourney, type JourneyId } from './journey-split.js';
import { journeyBaselines } from './journey-baseline.js';
import { readTruth } from './attachment-fixtures.js';

const dev = await loadGoals(`${JOURNEY_DIR}/dev`);
const holdout = await loadGoals(`${JOURNEY_DIR}/holdout`);
const goals = [...dev, ...holdout];
assert.equal(dev.length, 16);
assert.equal(holdout.length, 24);
assert.equal(new Set(goals.map((g) => g.id)).size, 40);
const ids = JSON.parse(await fs.readFile(`${JOURNEY_DIR}/ids.json`, 'utf8')) as JourneyId[];
const splits = splitJourney(ids);
assert.deepEqual(ids.map((v) => `${v.id}/${v.family}`).sort(), goals.map((g) => `${g.id}/${g.journey!.family}`).sort());
const spec = await fs.readFile('docs/architecture/16-industrial-sim/spec.md', 'utf8');
const r1 = spec.slice(spec.indexOf('### R1'), spec.indexOf('### R2'));
const specCounts = Object.fromEntries(
  [...r1.matchAll(/\|\s*([^|\n]+?)\s*\|[^|\n]+\|\s*(\d+)\s*\+\s*(\d+)\s*\|/gu)].map((m) => [m[1]!.trim(), [+m[2]!, +m[3]!]]),
);
assert.deepEqual(JOURNEY_COUNTS, specCounts);
for (const [family, [devCount, holdoutCount]] of Object.entries(specCounts)) {
  assert.equal(dev.filter((g) => g.journey!.family === family).length, devCount);
  assert.equal(holdout.filter((g) => g.journey!.family === family).length, holdoutCount);
  // 独立复算哈希排序，防切分实现和文件同时偏离规则。
  const group = ids
    .filter((v) => v.family === family)
    .sort((a, b) => {
      const hash = (id: string): string => createHash('sha256').update(`${id}journey-holdout`).digest('hex');
      return hash(a.id).localeCompare(hash(b.id));
    });
  assert.deepEqual(
    group
      .slice(0, holdoutCount)
      .map((v) => v.id)
      .sort(),
    holdout
      .filter((g) => g.journey!.family === family)
      .map((g) => g.id)
      .sort(),
  );
}
for (const split of ['dev', 'holdout']) {
  const files = (await fs.readdir(`${JOURNEY_DIR}/${split}`)).sort();
  assert.deepEqual(
    files,
    goals
      .filter((g) => g.journey!.split === split)
      .map((g) => `${g.id}.json`)
      .sort(),
  );
}
for (const g of goals) {
  assert.equal(g.pack, 'industrial');
  assert.equal(g.maxTurns ?? 12, 12);
  assert.equal(g.journey!.split, splits.get(g.id));
  assert.equal(g.tags?.includes('regression') ?? false, false);
  assert.equal(g.initial, undefined, `${g.id}: 全流程不种订单`);
  assert.ok(
    g.journey!.baselineScript.length + (g.customerScript?.filter((t) => typeof t === 'object').length ?? 0) <= (g.maxTurns ?? 12),
    `${g.id}: 基线必须说完全部台词`,
  );
  for (const f of g.journey!.facts) {
    const asked = new RegExp(f.asked, 'iu');
    for (const vague of ['数量', '几', '数量已记录', '有几个档位', '金额多少', '交期多少天'])
      assert.equal(asked.test(vague), false, `${g.id}: asked 误认 ${vague}`);
  }
}
const pilots = goals.filter((g) => g.tags?.includes('pilot'));
assert.equal(pilots.length, 8);
assert.ok(pilots.every((g) => g.journey!.split === 'dev'));
for (const family of ['标准成交', '写法不规范', '砍价施压', '必须转人工', '附件询价', '注入越权', '顾问驳回'])
  assert.ok(
    pilots.some((g) => g.journey!.family === family),
    `pilot 缺 ${family}`,
  );
console.log('✔ loadGoals: dev=16 holdout=24；12 族匹配 R1、id/目录/哈希切分一致；pilot=8');

// 客户已回答首次数量，销售却没推进时，不能因尚未发生的改量把销售失败剔成 drift。
for (const [id, first, final] of [
  ['j-tier-01', '19件', '20件'],
  ['j-tier-02', '49件', '50件'],
  ['j-tier-03', '6件', '10件'],
  ['j-tier-04', '1件', '2件'],
  ['j-tier-05', '99件', '100件'],
  ['j-change-01', '10件', '18件'],
  ['j-change-03', '20件', '26件'],
]) {
  const fact = new RegExp(goals.find((g) => g.id === id)!.journey!.facts[0]!.fact, 'iu');
  assert.ok(fact.test(first!), `${id}: 漏掉首次如实回答`);
  assert.ok(fact.test(final!), `${id}: 漏掉最终数量`);
}
console.log('✔ 改量场景的 facts 同时识别首次与最终数量，不掩盖销售未推进的失败');
const k02Asked = new RegExp(goals.find((g) => g.id === 'j-standard-03')!.journey!.facts[0]!.asked, 'iu');
assert.equal(k02Asked.test('HS-K02-24已记录，HS-K05-24要多少件？'), false);
assert.equal(k02Asked.test('HS-K02-24已记录 HS-K05-24要多少件？'), false);
assert.equal(k02Asked.test('HS-K02-24需要多少件？'), true);
assert.equal(k02Asked.test('各行的数量分别是多少？'), true);
console.log('✔ 多行 asked 不把另一型号的数量提问算到本行');
for (const text of ['24', '二十四', '6208-2RS：24', '6208-2RS 24个', '数量为２４'])
  assert.ok(new RegExp(goals.find((g) => g.id === 'j-standard-01')!.journey!.facts[0]!.fact, 'iu').test(text), text);
const k02Fact = new RegExp(goals.find((g) => g.id === 'j-standard-03')!.journey!.facts[0]!.fact, 'iu');
for (const text of ['HS-K02-24：12', '12件 HS-K02-24', 'HS-K02-24 十二只']) assert.ok(k02Fact.test(text), text);
assert.equal(k02Fact.test('HS-K02-24已记录，HS-K05-24 12件'), false);
console.log('✔ facts 兼容独立数字、中文数字、型号冒号数量和数量在型号前的常见写法');

const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
const quoted = (text: string): string[] => [...text.matchAll(/[「“"『‘']([^」”"』’']+)[」”"』’']/gu)].map((m) => m[1]!);
const scriptText = (g: SimGoal): string[] => (g.customerScript ?? []).flatMap((t) => (typeof t === 'string' ? [t] : t.say ? [t.say] : []));
const phrases = (text: string): string[] => [text, ...text.split(/[。！？!?\n；;]/u)].map(normalize).filter(Boolean);
const regressions = await loadGoals('eval/sim/goals/industrial/quality');
assert.equal(regressions.length, 31);
const old = new Set(regressions.flatMap((g) => [...scriptText(g), ...quoted(g.persona)].flatMap(phrases)));
for (const g of holdout)
  for (const phrase of [...scriptText(g), ...quoted(g.persona)].flatMap(phrases))
    assert.equal(old.has(phrase), false, `${g.id}: 复用了回归台词 ${phrase}`);
assert.equal(normalize(' ＡＢ－１２， 三件。'), normalize('ab-12 三件'));
console.log('✔ 留出集 customerScript 与 persona 引号台词未复用 31 个回归目标原句（NFKC/大小写/空白/标点归一）');

const privateShape = /(?:ww|wx)[a-z0-9]{16}|(?:wm|wo|wk|kf)[a-z0-9_-]{14,}|(?:^|\D)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/iu;
for (const g of goals) assert.doesNotMatch(JSON.stringify(g), privateShape, `${g.id}: 疑似真实标识或手机号`);
assert.ok(privateShape.test(['1', '39', '1234', '5678'].join('')));
assert.ok(privateShape.test('wm' + 'a'.repeat(14)));
console.log('✔ 40 个目标无真实企微标识形态、无手机号形态');

// 只读目录 JSON 的独立乘加核对；期望仍是作者写死的数值，不写回目标。
const catalog = JSON.parse(await fs.readFile('data/packs/industrial/catalog/part.json', 'utf8')) as {
  id: string;
  partNo: string;
  moq: number;
  unitPrice: number;
  tier2Qty: number;
  tier2Price: number;
  tier3Qty: number;
  tier3Price: number;
  tier4Qty: number;
  tier4Price: number;
}[];
const amounts = await fs.readFile(`${JOURNEY_DIR}/amounts.md`, 'utf8');
assert.equal(amounts.split('\n').filter((l) => l.startsWith('- `j-')).length, 40);
for (const g of goals) {
  const record = amounts.split('\n').find((l) => l.startsWith(`- \`${g.id}\``));
  assert.ok(record, `${g.id}: 缺手算记录`);
  const expect = g.journey!.expect;
  if (expect.end !== 'quote_accepted') continue;
  let total = 0;
  for (const line of expect.lines) {
    const part = catalog.find((p) => p.id === line.code)!;
    assert.ok(part, `${g.id}/${line.code}: 不在目录`);
    assert.ok(line.qty >= part.moq);
    let price = part.unitPrice;
    for (const [qty, tierPrice] of [
      [part.tier2Qty, part.tier2Price],
      [part.tier3Qty, part.tier3Price],
      [part.tier4Qty, part.tier4Price],
    ])
      if (line.qty >= qty!) price = tierPrice!;
    const unit = Math.round(price * 100);
    total += unit * line.qty;
    assert.ok(record.includes(`${part.partNo} × ${line.qty} 件`));
    assert.ok(record.includes(`单价 ${unit} 分，行金额 ${unit * line.qty} 分`));
  }
  assert.equal(expect.totalFen, total, `${g.id}: 手算合计与目录不符`);
  assert.ok(record.includes(`合计 ${expect.totalFen} 分`));
}
for (const [id, partNo, qty, total] of [
  ['j-bargain-02', 'M10×45', 100, 13500],
  ['j-rejection-01', 'HS-K07-24', 6, 19110],
  ['j-rejection-02', 'M8×40', 24, 3288],
] as const) {
  const record = amounts.split('\n').find((l) => l.startsWith(`- \`${id}\``))!;
  assert.ok(record.includes(`${partNo} × ${qty} 件`));
  assert.ok(record.includes(`合计 ${total} 分`));
}
const truth = readTruth();
for (const g of goals.filter((g) => g.journey!.family === '附件询价')) {
  const attachment = g.customerScript!.find((t) => typeof t === 'object');
  assert.ok(attachment && typeof attachment === 'object');
  const lines = truth[attachment.attach]!.lines!;
  const expected = g.journey!.expect;
  assert.equal(expected.end, 'quote_accepted');
  if (expected.end !== 'quote_accepted') throw new Error('附件终态错误');
  assert.deepEqual(
    expected.lines,
    lines
      .filter((l) => catalog.some((p) => p.partNo === l.partNo))
      .map((l) => ({
        code: catalog.find((p) => p.partNo === l.partNo)!.id,
        qty: l.qty,
      })),
  );
}
console.log('✔ 固定金额逐行独立复算、手算记录齐全；附件目标与 truth.json 库内行一致');

const modelFree = goals
  .filter((g) => g.journey!.modelFree)
  .map((g) => g.id)
  .sort();
for (const { mode, passed, runs } of await journeyBaselines(goals)) {
  assert.equal(runs.length, 40);
  assert.deepEqual(passed, modelFree, `${mode}: 基线通过集合必须恰好等于 modelFree`);
  console.log(`✔ ${mode}: 40/40 已跑；通过集合 ${JSON.stringify(passed)}`);
}
console.log('journey-goals selftest: 全部通过');
