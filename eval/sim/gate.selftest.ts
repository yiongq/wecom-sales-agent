// 07 第 12 步：发布闸的评测侧。全部用 eval/sim/fake.ts 的假模型，不发真实请求。
// A 段：判定逻辑（桩依赖，不起引擎）。B 段：gate.ts 在本进程里端到端（假模型、临时导出目录、临时报告）。
// C 段：子进程里跑 gate.ts / run.ts——--config-dir 读到目录里的配置、没给时读 data/、品牌目标、预算停止、退出码、被信号终止。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import { shanhaiBrand } from '../../src/packs/travel/brand-fixture.js';
import { defaultTravelPolicy } from '../../src/packs/travel/policy.js';
import { selectByTag, type SimGoal } from './goals.js';
import type { Snapshot, SimTurn } from './judge.js';
import { fakeEnv, fakePrices, fakeService } from './fake.js';
import { GATE_DEFAULT_GOALS, GATE_DEFAULT_RERUN, GATE_EXIT, parseGateArgs, runGate } from './gate.js';
import { parseArgs } from './run.js';
import {
  GATE_FAILURE_MAX,
  Meter,
  runGateGoal,
  simulate,
  simulateGate,
  usageByModel,
  type GateGoalResult,
  type SimDeps,
  type Tokens,
} from './runner.js';
import { CONFIG_DIR_REQUIRED, resolveConfigDir } from './runtime.js';

let assertions = 0;
function check(name: string, ok: boolean): void {
  assert.ok(ok, name);
  assertions++;
}
async function rejects(name: string, promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, pattern, name);
  assertions++;
}
function throws(name: string, fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern, name);
  assertions++;
}

// ---------- 夹具 ----------
const initial: Snapshot = { orders: [], handedOver: false, handoff: null, stage: 'greeting' };
function turn(reply: string, customer: string): SimTurn {
  const trace: FinishedTurn = {
    turn: {
      turnId: 'test',
      conversationId: 'sim-test',
      startedAt: 1,
      sopVersion: null,
      prefixHash: '',
      catalogVersions: {},
      calls: [],
      llm: [],
      guards: [],
      guardVerdicts: null,
      draft: reply,
    },
    outcome: 'replied',
    finalText: reply,
    stageBefore: 'greeting',
    stageAfter: 'greeting',
    durationMs: 0,
    signals: null,
    input: customer,
  };
  return { reply, customer: { say: customer, done: false }, silent: false, trace, state: structuredClone(initial) };
}
/** 一轮、固定话术的目标：回复里有「通过」才算过 */
const goal = (id: string, extra: Partial<SimGoal> = {}): SimGoal => ({
  id,
  persona: '仅咨询',
  allowedTools: ['search_routes'],
  predicates: [{ kind: 'reply_matches', pattern: '通过', scope: 'any' }],
  forbidden: [],
  maxTurns: 1,
  customerScript: ['你好'],
  tags: ['regression'],
  ...extra,
});
const zero: Tokens = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
/** 桩：销售按队列回话，每次回话向 meter 记 cost 元；客户模型回 customerRaw */
function stub(meter: Meter, replies: string[], cost = 0, extra: Partial<SimDeps> = {}): SimDeps {
  return {
    customerModel: 'stub',
    price: () => 0,
    customer: async () => ({ raw: '{"say":"你好","done":true}', tokens: zero }),
    start: () => ({ id: 'stub', initial }),
    sales: async (_id, customer) => {
      meter.add({ side: 'sales', model: 'stub-sales', ...zero, promptTokens: 10, completionTokens: 5, cny: cost });
      return turn(replies.shift() ?? '没有脚本', customer.say);
    },
    end: async () => {},
    ...extra,
  };
}
const names = (rs: GateGoalResult[]): string => rs.map((r) => `${r.id}:${r.result}`).join(',');

// ---------- A 段：判定 ----------
{
  const meter = new Meter(100);
  let r = await runGateGoal(goal('g'), 2, meter, stub(meter, ['通过了']));
  check('第 1 遍过是 pass，不重跑', r.result.result === 'pass' && r.result.attempts.length === 1 && r.result.attempts[0]!.pass);
  check('过的一遍没有 failures', r.result.attempts[0]!.failures.length === 0 && r.result.attempts[0]!.turns === 1);

  const replies = ['不对', '还是不对', '通过了'];
  r = await runGateGoal(goal('g'), 2, meter, stub(meter, replies));
  check(
    '重跑里有一遍过是 flaky，过了就不再重跑',
    r.result.result === 'flaky' && r.result.attempts.map((a) => a.pass).join() === 'false,false,true' && replies.length === 0,
  );
  const extra = ['不对', '通过了', '多余'];
  r = await runGateGoal(goal('g'), 2, meter, stub(meter, extra));
  check('第 2 遍过也是 flaky，剩下的一遍不跑', r.result.result === 'flaky' && r.result.attempts.length === 2 && extra.length === 1);

  r = await runGateGoal(goal('g'), 2, meter, stub(meter, ['不对', '不对', '不对', '通过了']));
  check(
    '1 + rerun 遍都不过是 fail',
    r.result.result === 'fail' && r.result.attempts.length === 3 && r.result.attempts.every((a) => !a.pass && a.failures.length > 0),
  );
  check('失败原因点名检查项', r.result.attempts[0]!.failures[0]!.startsWith('predicate[0]:reply_matches'));
  r = await runGateGoal(goal('g'), 0, meter, stub(meter, ['不对', '通过了']));
  check('rerun=0 只跑一遍', r.result.result === 'fail' && r.result.attempts.length === 1);
  r = await runGateGoal(goal('g', { tags: undefined }), 0, meter, stub(meter, ['通过了']));
  check('没有 tags 的目标记空数组', r.result.tags.length === 0);

  // 失败原因截断
  const long = goal('g', { predicates: [{ kind: 'reply_matches', pattern: `通过${'。'.repeat(500)}`, scope: 'any' }] });
  r = await runGateGoal(long, 0, meter, stub(meter, ['不对']));
  check('过长的失败原因被截断', r.result.attempts[0]!.failures[0]!.length === GATE_FAILURE_MAX);

  // 客户模型不按协议出话（06 R2 不计入分母）：不算销售侧失败。pass 仍为 false、failures 照实留 customer_protocol，
  // 没有一遍真正通过、又至少有一遍只是协议失败的目标记 flaky，不拦发布；fail 只给每一遍都是真正失败的目标
  const protocolGoal = goal('g', { customerScript: undefined, maxTurns: 2 });
  const badJson = async () => ({ raw: '坏 JSON', tokens: zero });
  r = await runGateGoal(protocolGoal, 1, meter, stub(meter, [], 0, { customer: badJson }));
  check(
    '只因 customer_protocol 没过的目标是 flaky',
    r.result.result === 'flaky' &&
      r.result.attempts.length === 2 &&
      r.result.attempts.every((a) => !a.pass && a.failures.join() === 'customer_protocol'),
  );
  r = await runGateGoal(protocolGoal, 0, meter, stub(meter, [], 0, { customer: badJson }));
  check('rerun=0 一遍协议失败也是 flaky', r.result.result === 'flaky' && r.result.attempts.length === 1);
  // 协议失败 + 重跑协议失败 + 重跑谓词失败：前 8 次客户调用（两遍，每遍整遍重跑一次、每次试两回）坏，之后正常
  let customerCalls = 0;
  const flakyCustomer = async () => ({ raw: ++customerCalls <= 8 ? '坏 JSON' : '{"say":"你好","done":true}', tokens: zero });
  r = await runGateGoal(protocolGoal, 2, meter, stub(meter, ['不对'], 0, { customer: flakyCustomer }));
  check(
    '协议失败 + 重跑协议失败 + 重跑谓词失败 → flaky',
    r.result.result === 'flaky' &&
      r.result.attempts.map((a) => a.pass).join() === 'false,false,false' &&
      r.result.attempts.map((a) => (a.failures[0]!.startsWith('predicate') ? 'predicate' : a.failures[0])).join() ===
        'customer_protocol,customer_protocol,predicate',
  );
  // 谓词失败、协议失败、谓词失败：中间那遍只是协议失败，同样 flaky（客户调用第 2–5 次是第 2 遍的两轮试探，坏）
  let mixedCalls = 0;
  const mixed = async () => ({ raw: ++mixedCalls >= 2 && mixedCalls <= 5 ? '坏 JSON' : '{"say":"你好","done":true}', tokens: zero });
  r = await runGateGoal(protocolGoal, 2, meter, stub(meter, ['不对', '不对'], 0, { customer: mixed }));
  check(
    '谓词失败 + 协议失败 + 谓词失败 → flaky',
    r.result.result === 'flaky' && r.result.attempts.map((a) => a.failures[0]!.startsWith('predicate')).join() === 'true,false,true',
  );
  // 协议失败后重跑通过：flaky
  let goodAfter = 0;
  const thenGood = async () => ({ raw: ++goodAfter <= 4 ? '坏 JSON' : '{"say":"你好","done":true}', tokens: zero });
  r = await runGateGoal(protocolGoal, 2, meter, stub(meter, ['通过了'], 0, { customer: thenGood }));
  check('协议失败后重跑通过是 flaky', r.result.result === 'flaky' && r.result.attempts.map((a) => a.pass).join() === 'false,true');
  // 预算优先：协议失败的一遍之后被预算截断，仍是 skipped_budget
  const budget = new Meter(1);
  let budgetCalls = 0;
  const costly = async () => {
    if (++budgetCalls > 4) budget.add({ side: 'customer', model: 'stub', ...zero, cny: 2 });
    return { raw: '坏 JSON', tokens: zero };
  };
  r = await runGateGoal(protocolGoal, 2, budget, stub(budget, [], 0, { customer: costly }));
  check(
    '协议失败后被预算截断仍是 skipped_budget',
    r.result.result === 'skipped_budget' && r.result.attempts.map((a) => a.failures.join()).join() === 'customer_protocol,budget_stop',
  );

  // 每一遍的费用（千分之一元）
  const paid = new Meter(100);
  r = await runGateGoal(goal('g'), 2, paid, stub(paid, ['不对', '通过了'], 0.0123));
  check('每一遍记费用（千分之一元，取整）', r.result.attempts.map((a) => a.costMilli).join() === '12,12');
}

// 预算：到点停，剩下的目标是 skipped_budget，逐个记一行
{
  const meter = new Meter(1);
  const progress: string[] = [];
  const report = await simulateGate(
    [goal('a'), goal('b'), goal('c')],
    2,
    meter,
    stub(meter, ['通过了', '不对', '通过了', '通过了'], 0.6),
    (r, p) => void progress.push(`${r.id}:${r.result}:${p.done}/${p.total}:${p.spentMilli}`),
  );
  check(
    '预算用完：已过的算 pass，被截断的与没跑到的都是 skipped_budget',
    names(report.results) === 'a:pass,b:skipped_budget,c:skipped_budget',
  );
  check(
    '被截断的一遍留下证据与费用',
    report.results[1]!.attempts.length === 1 &&
      !report.results[1]!.attempts[0]!.pass &&
      report.results[1]!.attempts[0]!.failures.join() === 'budget_stop' &&
      report.results[1]!.attempts[0]!.costMilli === 600,
  );
  check('没跑到的目标没有 attempts', report.results[2]!.attempts.length === 0);
  check('budgetStopped 为真', report.budgetStopped);
  check('逐目标回调带进度与累计花费', progress.join() === 'a:pass:1/3:600,b:skipped_budget:2/3:1200,c:skipped_budget:3/3:1200');
  check('预算后的目标不再向销售发请求', report.runs.length === 2);

  // 先失败一遍，重跑时被预算截断：没有结论，不能算 fail
  const second = new Meter(1);
  const cut = await simulateGate([goal('a')], 2, second, stub(second, ['不对', '不对'], 0.6));
  check(
    '失败后重跑被预算截断是 skipped_budget',
    cut.results[0]!.result === 'skipped_budget' &&
      cut.results[0]!.attempts.length === 2 &&
      cut.results[0]!.attempts.map((a) => a.failures[0]!.startsWith('predicate') || a.failures[0] === 'budget_stop').every(Boolean),
  );
  // 预算没到：没有 budgetStopped
  const roomy = new Meter(100);
  const done = await simulateGate([goal('a')], 2, roomy, stub(roomy, ['通过了'], 0.6));
  check('预算没到不标 budgetStopped', !done.budgetStopped && done.results[0]!.result === 'pass');
}

// 按标签选目标
{
  const goals = [goal('a'), goal('b', { tags: undefined }), goal('c', { tags: ['other'] }), goal('d', { tags: ['other', 'regression'] })];
  check(
    '--tag 只留 tags 含它的目标',
    selectByTag(goals, 'regression')
      .map((g) => g.id)
      .join() === 'a,d',
  );
  check(
    '--tag 可以选别的标签',
    selectByTag(goals, 'other')
      .map((g) => g.id)
      .join() === 'c,d',
  );
  throws('没有目标带这个标签就报错，不空跑', () => selectByTag(goals, 'nobody'), /没有目标带标签 nobody/);
  const meter = new Meter(100);
  const report = await simulateGate(selectByTag(goals, 'regression'), 1, meter, stub(meter, ['通过了', '通过了']));
  check('只跑选出来的目标', report.results.map((r) => r.id).join() === 'a,d');
}

// 品牌目标：没给 --config-dir 拒绝，给了放行
{
  const meter = new Meter(100);
  const branded = goal('b', { brand: 'shanhai' });
  await rejects('没给 --config-dir：simulate 拒绝非 legacy 品牌', simulate([branded], 1, meter, stub(meter, ['通过了'])), /legacy fixture/);
  await rejects(
    '没给 --config-dir：simulateGate 拒绝非 legacy 品牌',
    simulateGate([branded], 1, meter, stub(meter, ['通过了'])),
    /legacy fixture/,
  );
  const report = await simulateGate([branded], 1, meter, stub(meter, ['通过了'], 0, { configDir: 'cfg' }));
  check('给了 --config-dir：品牌目标照常跑', report.results[0]!.result === 'pass');
  const sim = await simulate([branded], 1, meter, stub(meter, ['通过了'], 0, { configDir: 'cfg' }));
  check('给了 --config-dir：simulate 也放行', sim.summary[0]!.passed === 1);
  const legacy = await simulate([goal('l', { brand: 'legacy' })], 1, meter, stub(meter, ['通过了']));
  check('legacy 品牌照旧可以跑', legacy.summary[0]!.passed === 1);
}

// 用量按模型汇总
{
  const charges = [
    { side: 'sales' as const, model: 'm2', promptTokens: 10, completionTokens: 2, cachedTokens: 4, reasoningTokens: 1, cny: 0.001 },
    { side: 'customer' as const, model: 'm1', promptTokens: 5, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, cny: 0.0004 },
    { side: 'sales' as const, model: 'm2', promptTokens: 20, completionTokens: 3, cachedTokens: 0, reasoningTokens: 2, cny: 0.0021 },
  ];
  check(
    'usageByModel 按模型汇总，费用千分之一元取整',
    JSON.stringify(usageByModel(charges)) ===
      JSON.stringify([
        { model: 'm1', calls: 1, promptTokens: 5, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, costMilli: 0 },
        { model: 'm2', calls: 2, promptTokens: 30, completionTokens: 5, cachedTokens: 4, reasoningTokens: 3, costMilli: 3 },
      ]),
  );
}

// 参数
{
  throws('rerun 不能是负数', () => parseArgs(['--budget', '1', '--rerun', '-1']), /rerun/);
  throws('rerun 不能是小数', () => parseArgs(['--budget', '1', '--rerun', '1.5']), /rerun/);
  throws('rerun 与 k>1 互斥', () => parseArgs(['--budget', '1', '--rerun', '2', '--k', '3']), /--rerun 只能与 --k 1/);
  const a = parseArgs(['--budget', '1', '--rerun', '2', '--tag', 'regression', '--config-dir', 'x']);
  check(
    'run.ts：给了 rerun，k 恒为 1，tag 与 config-dir 透传',
    a.k === 1 && a.rerun === 2 && a.tag === 'regression' && a.configDir === 'x',
  );
  check('run.ts：不给 rerun 时 k 与旧行为相同', parseArgs(['--budget', '1']).k === 5 && parseArgs(['--budget', '1']).rerun === undefined);
  check('run.ts：--rerun 0 合法', parseArgs(['--budget', '1', '--rerun', '0']).rerun === 0);
  throws('run.ts：重复的键仍然拒绝', () => parseArgs(['--budget', '1', '--tag', 'a', '--tag', 'b']), /参数错误/);

  const full = ['--config-dir', 'cfg', '--tag', 'regression', '--budget', '2', '--report', 'r.jsonl'];
  const g = parseGateArgs(full);
  check(
    'gate：缺省 rerun=2、目标目录是回归集',
    g.rerun === GATE_DEFAULT_RERUN && GATE_DEFAULT_RERUN === 2 && g.goals === GATE_DEFAULT_GOALS && g.goals === 'eval/sim/goals/quality',
  );
  check('gate：选项齐全', parseGateArgs([...full, '--rerun', '0', '--model', 'm', '--prices', 'p', '--goals', 'x']).rerun === 0);
  for (const key of ['--config-dir', '--tag', '--budget', '--report'])
    throws(
      `gate：缺 ${key} 报参数错`,
      () => {
        const rest = [...full];
        const at = rest.indexOf(key);
        rest.splice(at, 2);
        return parseGateArgs(rest);
      },
      /必须/,
    );
  throws('gate：未知参数', () => parseGateArgs([...full, '--k', '5']), /参数错误: --k/);
  throws('gate：预算要是正数', () => parseGateArgs(['--config-dir', 'c', '--tag', 't', '--report', 'r', '--budget', '0']), /--budget/);
}

// ---------- 临时目录与导出目录夹具 ----------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-gate-test-'));
const children = new Set<ReturnType<typeof spawn>>();
// 断言失败时也不留临时目录与子进程
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});
const privateTmp = path.join(root, 'tmp');
fs.mkdirSync(privateTmp);
const write = (file: string, text: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
/** 导出目录：data/ 的 sop.md、routes.json、hotels.json，可选 policy.json、brand.json */
interface Item {
  [key: string]: unknown;
}
function exportDir(
  name: string,
  over: {
    sop?: (text: string) => string;
    routes?: (items: Item[]) => Item[];
    hotels?: (items: Item[]) => Item[];
    policy?: object;
    brand?: object;
  } = {},
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const sop = fs.readFileSync('data/sop.md', 'utf8');
  fs.writeFileSync(path.join(dir, 'sop.md'), over.sop ? over.sop(sop) : sop);
  for (const [file, change] of [
    ['routes.json', over.routes],
    ['hotels.json', over.hotels],
  ] as const) {
    if (!change) fs.copyFileSync(path.join('data', file), path.join(dir, file));
    else
      fs.writeFileSync(
        path.join(dir, file),
        `${JSON.stringify(change(JSON.parse(fs.readFileSync(path.join('data', file), 'utf8')) as Item[]), null, 2)}\n`,
      );
  }
  if (over.policy) fs.writeFileSync(path.join(dir, 'policy.json'), `${JSON.stringify(over.policy, null, 2)}\n`);
  if (over.brand) fs.writeFileSync(path.join(dir, 'brand.json'), `${JSON.stringify(over.brand, null, 2)}\n`);
  return dir;
}
function goalsDir(name: string, specs: Record<string, object>): string {
  const dir = path.join(root, name);
  for (const [file, spec] of Object.entries(specs)) write(path.join(dir, file), JSON.stringify(spec));
  return dir;
}
const prices = write(path.join(root, 'prices.json'), JSON.stringify(fakePrices));
/** 线上闸的目标：一轮、固定话术；reply_matches 决定过不过 */
const fixed = (id: string, say: string, match: string, extra: object = {}): object => ({
  id,
  persona: '仅咨询',
  maxTurns: 1,
  allowedTools: ['search_routes'],
  predicates: [{ kind: 'reply_matches', pattern: match, scope: 'any' }],
  forbidden: [],
  customerScript: [say],
  tags: ['regression'],
  ...extra,
});
const GOOD = '您好，请问您想去哪里旅行？';
const BAD = '您好，欢迎咨询。';
interface Line {
  type: string;
  [key: string]: unknown;
}
const readReport = (file: string): Line[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
const envSnapshot = (): string => JSON.stringify(Object.entries(process.env).toSorted(([a], [b]) => a.localeCompare(b)));
/** {'--键': 值} → 命令行数组 */
const cli = (options: Record<string, string>): string[] => Object.entries(options).flat();

// ---------- B 段：gate.ts 在本进程里端到端 ----------
const customer = await fakeService();
const sales = await fakeService();
fakeEnv(sales.url, customer.url);
let inprocessHashes: { promptHash: string; policyHash: string };
{
  const unmodified = exportDir('cfg-unmodified');
  const goals = goalsDir('goals-b', {
    '01-pass.json': fixed('b-pass', '你好', '想去哪里'),
    '02-flaky.json': fixed('b-flaky', '你好', '想去哪里'),
    '03-fail.json': fixed('b-fail', '你好', '想去哪里'),
    '04-untagged.json': fixed('b-untagged', '你好', '想去哪里', { tags: undefined }),
  });
  const report = path.join(root, 'b', 'report.jsonl');
  // 每次回包 5 万输入 + 5 千输出 token，按假单价约 ¥0.06，取整后每遍 60（千分之一元）
  const step = (content: string) => ({ content, prompt: 50_000, completion: 5000 });
  sales.script.push(
    step(GOOD), // b-pass 第 1 遍
    step(BAD), // b-flaky 第 1 遍：不过
    step(GOOD), // b-flaky 重跑：过
    step(BAD),
    step(BAD),
    step(BAD), // b-fail 三遍都不过
  );
  // 父进程的时区先不是 gate 要用的那个，才看得出「用完恢复」
  process.env.TZ = 'UTC';
  const before = envSnapshot();
  const code = await runGate(
    cli({
      '--config-dir': unmodified,
      '--tag': 'regression',
      '--rerun': '2',
      '--budget': '50',
      '--report': report,
      '--goals': goals,
      '--model': 'sim-fake-customer',
      '--prices': prices,
    }),
  );
  check('B：退出码 0（跑完，目标有失败也是 0）', code === GATE_EXIT.done);
  check('B：process.env 被恢复', envSnapshot() === before);
  check('B：假模型脚本恰好用完', sales.script.length === 0 && customer.script.length === 0 && sales.requests.length === 6);
  const lines = readReport(report);
  check('B：报告 = start + 每个目标一行 + summary', lines.map((l) => l.type).join() === 'start,goal,goal,goal,summary');
  const [start, ...goalLines] = lines.slice(0, 4) as [Line, ...Line[]];
  check(
    'B：start 行',
    JSON.stringify(Object.keys(start)) === JSON.stringify(['type', 'total', 'goalIds', 'tag', 'rerun', 'budgetMilli']) &&
      start.total === 3 &&
      JSON.stringify(start.goalIds) === JSON.stringify(['b-pass', 'b-flaky', 'b-fail']) &&
      start.tag === 'regression' &&
      start.rerun === 2 &&
      start.budgetMilli === 50_000,
  );
  check('B：不带标签的目标没有跑', !lines.some((l) => JSON.stringify(l).includes('b-untagged')));
  check(
    'B：goal 行是 GateGoalResult 加进度',
    goalLines.every(
      (l, i) =>
        JSON.stringify(Object.keys(l)) === JSON.stringify(['type', 'id', 'tags', 'attempts', 'result', 'done', 'total', 'spentMilli']) &&
        l.done === i + 1 &&
        l.total === 3 &&
        typeof l.spentMilli === 'number' &&
        JSON.stringify(l.tags) === JSON.stringify(['regression']),
    ),
  );
  check('B：结果 pass / flaky / fail', goalLines.map((l) => l.result).join() === 'pass,flaky,fail');
  const attempts = goalLines.map((l) => l.attempts as { pass: boolean; failures: string[]; turns: number; costMilli: number }[]);
  check(
    'B：attempts 的形状与遍数',
    attempts.map((a) => a.length).join() === '1,2,3' &&
      attempts
        .flat()
        .every((a) => JSON.stringify(Object.keys(a)) === JSON.stringify(['pass', 'failures', 'turns', 'costMilli']) && a.turns === 1) &&
      attempts[1]!.map((a) => a.pass).join() === 'false,true' &&
      attempts[1]![0]!.failures.length > 0 &&
      attempts[0]![0]!.failures.length === 0,
  );
  check(
    'B：每遍的费用 = 60（千分之一元）',
    attempts.flat().every((a) => a.costMilli === 60),
  );
  const spent = goalLines.map((l) => l.spentMilli as number);
  check('B：spentMilli 单调不减', spent[0]! <= spent[1]! && spent[1]! <= spent[2]!);
  const summary = lines.at(-1)!;
  check(
    'B：summary 的字段',
    JSON.stringify(Object.keys(summary)) ===
      JSON.stringify(['type', 'budgetStopped', 'costMilli', 'budgetMilli', 'rerun', 'tag', 'counts', 'results', 'usage', 'metadata']) &&
      summary.budgetStopped === false &&
      summary.budgetMilli === 50_000 &&
      JSON.stringify(summary.counts) === JSON.stringify({ pass: 1, flaky: 1, fail: 1, skipped_budget: 0 }),
  );
  const results = summary.results as GateGoalResult[];
  check(
    'B：summary.results 与逐行记录一致',
    JSON.stringify(results) ===
      JSON.stringify(goalLines.map(({ type: _type, done: _done, total: _total, spentMilli: _spent, ...rest }) => rest)),
  );
  check('B：总花费 = 6 遍之和', summary.costMilli === 360);
  const usage = summary.usage as { model: string; calls: number; costMilli: number }[];
  check(
    'B：usage 按模型，销售调用数 = 6',
    usage.some((u) => u.model === 'sim-fake-sales' && u.calls === 6) && usage.every((u) => u.costMilli >= 0),
  );
  const meta = summary.metadata as Record<string, unknown>;
  check(
    'B：metadata 带配置来源与哈希',
    meta.config === 'config-dir' &&
      meta.configDir === 'cfg-unmodified' &&
      meta.brand === 'legacy' &&
      /^[0-9a-f]{64}$/.test(String(meta.promptHash)) &&
      /^[0-9a-f]{64}$/.test(String(meta.policyHash)) &&
      meta.salesModel === 'sim-fake-sales' &&
      meta.customerModel === 'sim-fake-customer',
  );
  check('B：metadata 不带本机路径', !JSON.stringify(meta).includes(root));
  inprocessHashes = { promptHash: String(meta.promptHash), policyHash: String(meta.policyHash) };
}

// 参数错与出错：不起引擎、不写报告或只留 error 行，返回对应退出码，且不动环境变量
const log = console.error;
console.error = () => {}; // gate 把错误原因打在 stderr，这几段是故意触发的
{
  const before = envSnapshot();
  const unmodified = path.join(root, 'cfg-unmodified');
  const goals = path.join(root, 'goals-b');
  const base = ['--budget', '1', '--report', path.join(root, 'args', 'r.jsonl')];
  const code = (args: string[]): Promise<number> => runGate(args);
  check('没有 --config-dir：2', (await code(['--tag', 'regression', ...base])) === GATE_EXIT.usage);
  check(
    'config-dir 不存在：2',
    (await code(['--config-dir', path.join(root, 'nope'), '--tag', 'regression', ...base])) === GATE_EXIT.usage,
  );
  const missing = path.join(root, 'cfg-missing');
  fs.mkdirSync(missing);
  fs.copyFileSync(path.join(unmodified, 'sop.md'), path.join(missing, 'sop.md'));
  check('config-dir 缺 routes.json：2', (await code(['--config-dir', missing, '--tag', 'regression', ...base])) === GATE_EXIT.usage);
  check(
    '没有目标带这个标签：2',
    (await code(['--config-dir', unmodified, '--tag', 'nobody', '--goals', goals, ...base])) === GATE_EXIT.usage,
  );
  check(
    '--prices 不合格：2',
    (await code(['--config-dir', unmodified, '--tag', 'regression', '--prices', path.join(unmodified, 'routes.json'), ...base])) ===
      GATE_EXIT.usage,
  );
  check(
    '目标目录读不了：1',
    (await code(['--config-dir', unmodified, '--tag', 'regression', '--goals', path.join(root, 'nope'), ...base])) === GATE_EXIT.error,
  );
  check('参数错不写报告', !fs.existsSync(path.join(root, 'args', 'r.jsonl')));
  check('参数错与出错之后 process.env 不变', envSnapshot() === before);
  await rejects('resolveConfigDir 拒绝文件', resolveConfigDir(path.join(unmodified, 'sop.md')), /不是目录/);
  await rejects('resolveConfigDir 点名缺的文件', resolveConfigDir(missing), /缺 routes\.json/);
  check('resolveConfigDir 返回绝对路径', path.isAbsolute(await resolveConfigDir(unmodified)));
  check('必需的三个文件', CONFIG_DIR_REQUIRED.join() === 'sop.md,routes.json,hotels.json');
}

// 引擎起不来（policy.json 不合格）：出错 1，报告里有 error 行，process.env 不变
{
  const bad = exportDir('cfg-bad-policy', { policy: { version: 1, nonsense: true } });
  const goals = goalsDir('goals-bad', { '01.json': fixed('bad-1', '你好', '想去哪里') });
  const report = path.join(root, 'bad', 'r.jsonl');
  const before = envSnapshot();
  const code = await runGate(
    cli({
      '--config-dir': bad,
      '--tag': 'regression',
      '--budget': '1',
      '--report': report,
      '--goals': goals,
      '--model': 'sim-fake-customer',
      '--prices': prices,
    }),
  );
  const lines = readReport(report);
  check('policy.json 不合格：退出码 1，一个目标都没跑', code === GATE_EXIT.error && sales.requests.length === 6);
  check(
    'policy.json 不合格：报告是 start + error',
    lines.map((l) => l.type).join() === 'start,error' && String(lines[1]!.message).startsWith('配置不合格'),
  );
  check('policy.json 不合格：process.env 不变', envSnapshot() === before);
}

console.error = log;

// ---------- C 段：子进程 ----------
/** tsx 自己也会往 TMPDIR 放缓存与 IPC，只看评测的临时目录 */
const leftovers = (dir: string): boolean => fs.readdirSync(dir).some((n) => n.startsWith('wecom-sim-'));
interface Child {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
function childEnv(salesUrl: string, customerUrl: string, tmp = privateTmp): NodeJS.ProcessEnv {
  const saved = { ...process.env };
  fakeEnv(salesUrl, customerUrl);
  const env = { ...process.env, TMPDIR: tmp };
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  return env;
}
function runChild(
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onStart?: (kill: (s: NodeJS.Signals) => void) => void,
): Promise<Child> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(proc);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d));
    proc.stderr.on('data', (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`子进程超时: ${entry}\n${stdout.slice(-800)}\n${stderr.slice(-800)}`));
    }, 150_000);
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(proc);
      resolve({ code, signal, stdout, stderr });
    });
    onStart?.((s) => proc.kill(s));
  });
}
const gateArgs = (cfg: string, goals: string, report: string, extra: Record<string, string> = {}): string[] =>
  cli({
    '--config-dir': cfg,
    '--tag': 'regression',
    '--goals': goals,
    '--report': report,
    '--model': 'sim-fake-customer',
    '--prices': prices,
    ...extra,
  });
const system = (svc: { requests: { messages: { role: string; content?: string | null }[] }[] }): string[] =>
  svc.requests.map((r) => r.messages.find((m) => m.role === 'system')?.content ?? '');
const allText = (svc: { requests: { messages: { content?: string | null }[] }[] }): string =>
  svc.requests.map((r) => r.messages.map((m) => m.content ?? '').join('\n')).join('\n');
const MARK = '评测标记：配置目录里的 sop.md 已生效 ZQ7';
const CHANGE_MARK = '评测标记：改期规则来自配置目录 ZQ9';
const ROUTE_MARK = '配置目录里的云南线路 ZQ8';
const HOTEL_MARK = '配置目录里的酒店 ZQ8';
// C1：--config-dir 读到目录里的 sop.md 与 policy.json；报告逐目标追加；标签过滤
{
  const cfg = exportDir('cfg-modified', {
    sop: (text) => `${text.trimEnd()}\n\n${MARK}\n`,
    routes: (items) => items.map((r) => (r.id === 'r-yunnan-mid' ? { ...r, title: ROUTE_MARK } : r)),
    hotels: (items) => items.map((h, i) => (i === 0 ? { ...h, name: HOTEL_MARK } : h)),
    policy: {
      ...defaultTravelPolicy,
      refund: {
        ...defaultTravelPolicy.refund,
        approvalThresholdYuan: 12345,
        // d30 → 45 天，d15 的上沿跟着挪，档位仍然连续
        tiers: [
          { id: 'd30', minDays: 45, maxDays: null, percent: 100 },
          { id: 'd15', minDays: 15, maxDays: 44, percent: 80 },
          { id: 'd7', minDays: 7, maxDays: 14, percent: 50 },
        ],
      },
      change: CHANGE_MARK,
    },
  });
  const goals = goalsDir('goals-c1', {
    '01-pass.json': fixed('c1-pass', '你好', '想去哪里'),
    '02-flaky.json': fixed('c1-flaky', '你好', '想去哪里'),
    '03-policy.json': fixed('c1-policy', '如果临时去不了，退改规则是什么？', '条款', {
      predicates: [{ kind: 'reply_matches', pattern: '条款', scope: 'any' }],
    }),
    '04-routes.json': fixed('c1-routes', '我们想去云南，有什么线路？三亚的酒店也看看', '\\S', {
      allowedTools: ['search_routes', 'search_hotels'],
    }),
    '05-untagged.json': fixed('c1-untagged', '你好', '想去哪里', { tags: undefined }),
    '06-other.json': fixed('c1-other', '你好', '想去哪里', { tags: ['other'] }),
  });
  const c = await fakeService();
  const s = await fakeService();
  const report = path.join(root, 'c1', 'report.jsonl');
  const seenWhileRunning: number[] = [];
  s.script.push(
    { content: GOOD },
    // 第二个目标开始时，第一个目标的那一行必须已经落在报告里（逐目标追加，不是跑完才写）
    {
      content: () => {
        seenWhileRunning.push(readReport(report).filter((l) => l.type === 'goal').length);
        return BAD;
      },
    },
    { content: GOOD },
    { content: '关于退改，请看条款，我们都按条款说。' },
    {
      tools: [
        { name: 'search_routes', args: { destination: '云南' } },
        { name: 'search_hotels', args: { destination: '三亚' } },
      ],
    },
    { content: '为您找到了这几条，请看。' },
  );
  // 不连数据库：给一个连不上的 DATABASE_URL，跑照样通过
  const env = { ...childEnv(s.url, c.url), DATABASE_URL: 'postgres://127.0.0.1:1/none' };
  const r = await runChild('eval/sim/gate.ts', gateArgs(cfg, goals, report, { '--rerun': '2', '--budget': '50' }), env);
  check('C1：退出码 0（DATABASE_URL 连不上也不受影响）', r.code === 0 && r.signal === null);
  check('C1：stdout 里没有人读的表（只写报告文件）', !r.stdout.includes('c1-pass'));
  const lines = readReport(report);
  check(
    'C1：只跑带 regression 标的 4 个目标',
    lines.map((l) => l.type).join() === 'start,goal,goal,goal,goal,summary' && s.requests.length === 6,
  );
  check('C1：报告是逐目标追加的', seenWhileRunning.join() === '1');
  check(
    'C1：结果',
    lines
      .slice(1, 5)
      .map((l) => `${l.id}:${l.result}`)
      .join() === 'c1-pass:pass,c1-flaky:flaky,c1-policy:pass,c1-routes:pass',
  );
  check('C1：系统提示带目录里的标记', system(s).length === 6 && system(s).every((t) => t.includes(MARK)));
  check(
    'C1：线路与酒店来自目录里的 routes.json、hotels.json',
    JSON.stringify(s.requests.at(-1)!.messages).includes(ROUTE_MARK) && JSON.stringify(s.requests.at(-1)!.messages).includes(HOTEL_MARK),
  );
  check('C1：data/ 里原来的线路名没有出现', !JSON.stringify(s.requests.at(-1)!.messages).includes('丽江大理·洱海古城'));
  check(
    'C1：政策问法的上下文是目录里的 policy.json（阈值与文字）',
    allText(s).includes('出发前45天及以上取消') && allText(s).includes(CHANGE_MARK),
  );
  check('C1：默认政策的阈值没有出现', !allText(s).includes('出发前30天及以上取消'));
  const meta = lines.at(-1)!.metadata as Record<string, unknown>;
  check(
    'C1：哈希与未改动的导出目录不同',
    meta.promptHash !== inprocessHashes.promptHash && meta.policyHash !== inprocessHashes.policyHash && meta.configDir === 'cfg-modified',
  );
  await Promise.all([c.close(), s.close()]);
}

// C2：run.ts 没给 --config-dir 读 data/（哈希与未改动的导出目录相同）；--tag、--rerun 在 run.ts 里同样生效
{
  const goals = goalsDir('goals-c2', {
    '01-flaky.json': fixed('c2-flaky', '你好', '想去哪里'),
    '02-fail.json': fixed('c2-fail', '你好', '想去哪里'),
    '03-untagged.json': fixed('c2-untagged', '你好', '想去哪里', { tags: undefined }),
  });
  const c = await fakeService();
  const s = await fakeService();
  const report = path.join(root, 'c2', 'report.json');
  s.script.push({ content: BAD }, { content: GOOD }, { content: BAD }, { content: BAD });
  const r = await runChild(
    'eval/sim/run.ts',
    [
      '--goals',
      goals,
      '--tag',
      'regression',
      '--rerun',
      '1',
      '--budget',
      '50',
      '--report',
      report,
      '--model',
      'sim-fake-customer',
      '--prices',
      prices,
    ],
    childEnv(s.url, c.url),
  );
  check('C2：run.ts 有 fail 的目标退出码 1', r.code === 1);
  const out = JSON.parse(fs.readFileSync(report, 'utf8')) as {
    results: GateGoalResult[];
    metadata: Record<string, unknown>;
    rerun: number;
  };
  check(
    'C2：run.ts 的闸判定：flaky 与 fail，不带标签的没跑',
    out.rerun === 1 && names(out.results) === 'c2-flaky:flaky,c2-fail:fail' && s.requests.length === 4,
  );
  check(
    'C2：没给 --config-dir 读的是 data/（哈希与未改动的导出目录一致）',
    out.metadata.config === 'file' &&
      out.metadata.configDir === null &&
      out.metadata.promptHash === inprocessHashes.promptHash &&
      out.metadata.policyHash === inprocessHashes.policyHash,
  );
  check(
    'C2：系统提示就是 data/sop.md 的全文',
    system(s).every((t) => t.includes(fs.readFileSync('data/sop.md', 'utf8').slice(0, 200).trim().split('\n')[0]!)),
  );
  check('C2：run.ts 打印人读的表', r.stdout.includes('c2-flaky | 不稳') && r.stdout.includes('c2-fail | 失败'));
  await Promise.all([c.close(), s.close()]);
}

// C3：带 brand.json 的导出目录里，品牌目标能跑
{
  const { currentPack } = await import('../../src/config/source.js');
  const { tenantImage } = await import('../../src/config/brand.js');
  const { joinSop } = await import('../../src/sop/sections.js');
  const imageSop = fs.readFileSync('data/sop.md', 'utf8');
  const cfg = exportDir('cfg-brand', {
    sop: () => joinSop(tenantImage(currentPack().runtime, imageSop, shanhaiBrand)),
    brand: shanhaiBrand,
  });
  const goals = goalsDir('goals-c3', { '01-brand.json': fixed('c3-brand', '你好', '想去哪里', { brand: 'shanhai' }) });
  const c = await fakeService();
  const s = await fakeService();
  const report = path.join(root, 'c3', 'report.jsonl');
  s.script.push({ content: GOOD });
  const r = await runChild('eval/sim/gate.ts', gateArgs(cfg, goals, report, { '--rerun': '0', '--budget': '50' }), childEnv(s.url, c.url));
  const lines = readReport(report);
  check('C3：品牌目标跑通', r.code === 0 && lines.at(-1)!.type === 'summary' && lines[1]!.result === 'pass');
  const meta = lines.at(-1)!.metadata as Record<string, unknown>;
  check('C3：metadata 里是目录里的品牌', meta.brand === shanhaiBrand.brandName && meta.config === 'config-dir');
  check(
    'C3：系统提示按品牌渲染',
    system(s).every((t) => t.includes(shanhaiBrand.brandName) && !t.includes('云途')),
  );
  await Promise.all([c.close(), s.close()]);
}

// C4：预算停止——到点不再发请求，剩下的目标是 skipped_budget，退出码 3
{
  const goals = goalsDir('goals-c4', {
    '01-a.json': fixed('c4-a', '你好', '想去哪里'),
    '02-b.json': fixed('c4-b', '你好', '想去哪里'),
    '03-c.json': fixed('c4-c', '你好', '想去哪里'),
  });
  const c = await fakeService();
  const s = await fakeService();
  const report = path.join(root, 'c4', 'report.jsonl');
  // 第一次回包就是 2 百万 token，假单价 ¥1/百万 → ¥2，超过 ¥1 的预算
  s.script.push({ content: GOOD, prompt: 2_000_000, completion: 0 }, { content: GOOD }, { content: GOOD });
  const r = await runChild(
    'eval/sim/gate.ts',
    gateArgs(path.join(root, 'cfg-unmodified'), goals, report, { '--rerun': '2', '--budget': '1' }),
    childEnv(s.url, c.url),
  );
  const lines = readReport(report);
  const summary = lines.at(-1)!;
  check('C4：退出码 3，最后一行仍是 summary', r.code === 3 && summary.type === 'summary' && summary.budgetStopped === true);
  check('C4：只发了一次销售请求', s.requests.length === 1);
  check(
    'C4：每个目标一行，没跑完的是 skipped_budget',
    lines.filter((l) => l.type === 'goal').length === 3 &&
      names(summary.results as GateGoalResult[]) === 'c4-a:skipped_budget,c4-b:skipped_budget,c4-c:skipped_budget' &&
      JSON.stringify(summary.counts) === JSON.stringify({ pass: 0, flaky: 0, fail: 0, skipped_budget: 3 }),
  );
  check('C4：花费超过上限一笔（预算边界）并如实记录', (summary.costMilli as number) >= 1000 && summary.budgetMilli === 1000);
  await Promise.all([c.close(), s.close()]);
}

// C5：真实进程的退出码——参数错是 2，不起引擎、不写报告
{
  const report = path.join(root, 'c5', 'r.jsonl');
  const r = await runChild(
    'eval/sim/gate.ts',
    ['--config-dir', path.join(root, 'cfg-unmodified'), '--tag', 'regression', '--report', report],
    process.env,
  );
  check('C5：缺 --budget：进程退出码 2', r.code === 2 && r.stderr.includes('--budget') && !fs.existsSync(report));
}

// C6：被 SIGTERM 终止（闸超时）：退出码 143（引擎模块的信号处理），评测的临时目录清掉
{
  const hang = http.createServer(() => {});
  await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
  const hangUrl = `http://127.0.0.1:${(hang.address() as { port: number }).port}`;
  let reached = false;
  hang.on('request', () => {
    reached = true;
  });
  const c = await fakeService();
  const tmp = path.join(root, 'tmp-c6');
  fs.mkdirSync(tmp);
  const goals = goalsDir('goals-c6', { '01.json': fixed('c6-a', '你好', '想去哪里') });
  const report = path.join(root, 'c6', 'r.jsonl');
  const r = await runChild(
    'eval/sim/gate.ts',
    gateArgs(path.join(root, 'cfg-unmodified'), goals, report, { '--rerun': '0', '--budget': '50' }),
    childEnv(hangUrl, c.url, tmp),
    (kill) => {
      const timer = setInterval(() => {
        // 引擎的请求已经发到卡住的服务、评测的临时目录已经建好：此时终止
        if (reached && leftovers(tmp)) {
          clearInterval(timer);
          kill('SIGTERM');
        }
      }, 100);
    },
  );
  check('C6：SIGTERM 之后退出码 143', r.code === 143);
  check('C6：评测的临时目录被清掉', !leftovers(tmp));
  check(
    'C6：没有 summary（报告停在 start）',
    readReport(report)
      .map((l) => l.type)
      .join() === 'start',
  );
  hang.closeAllConnections();
  await new Promise<void>((resolve) => hang.close(() => resolve()));
  await c.close();
}

// C7：缺省的目标目录就是回归集：带 regression 标的目标全部进闸（06 的 16 个 safety 在内）。销售模型不可用，每个目标照实记为没过，不看结果
{
  const c = await fakeService();
  const s = await fakeService();
  const report = path.join(root, 'c7', 'r.jsonl');
  const r = await runChild(
    'eval/sim/gate.ts',
    cli({
      '--config-dir': path.join(root, 'cfg-unmodified'),
      '--tag': 'regression',
      '--rerun': '0',
      '--budget': '50',
      '--report': report,
      '--model': 'sim-fake-customer',
      '--prices': prices,
    }),
    childEnv(s.url, c.url),
  );
  const { loadGoals } = await import('./goals.js');
  const quality = await loadGoals('eval/sim/goals/quality');
  const tagged = quality.filter((g) => g.tags?.includes('regression'));
  const lines = readReport(report);
  const start = lines[0]!;
  check('C7：缺省目标目录里带标的目标全部进闸', r.code === 0 && start.total === tagged.length && tagged.length >= 18);
  check(
    'C7：06 的 16 个 safety 目标在内',
    quality.filter((g) => g.severity === 'safety').every((g) => (start.goalIds as string[]).includes(g.id)),
  );
  check('C7：每个目标一行，最后是 summary', lines.length === tagged.length + 2 && lines.at(-1)!.type === 'summary');
  await Promise.all([c.close(), s.close()]);
}

check('所有子进程都已退出，共用临时目录里不留 wecom-sim-*', children.size === 0 && !leftovers(privateTmp));
await Promise.all([customer.close(), sales.close()]);
console.log(
  `GATE SELFTEST PASS: ${assertions} 项断言全通（重跑判定 pass/flaky/fail/skipped_budget / --tag / --config-dir / 品牌目标 / 逐目标追加的报告 / 退出码 / 环境恢复）`,
);
