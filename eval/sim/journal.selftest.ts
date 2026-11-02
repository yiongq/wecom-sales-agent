// 16 R5、R6：中断恢复、账本与冻结检查。只用本机假模型和一次性 git 仓库。
import '../../src/selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeEnv, fakePrices, fakeService, say } from './fake.js';
import { validateGoal, type SimGoal } from './goals.js';
import { Meter, simulate, type RunResult, type SimDeps, type Charge } from './runner.js';
import { engineRuntime, FIXTURE_CLOCK } from './runtime.js';
import { gitText, treeHashes, writeFreeze } from './freeze.js';
import {
  appendLedger,
  appendRun,
  checkResume,
  holdoutPreflight,
  ledgerEnd,
  ledgerFile,
  ledgerStart,
  openJournal,
  readJournal,
  readLedger,
  resumeState,
  runKey,
} from './journal.js';
import type { RunMeta } from './report-types.js';
import { parseArgs } from './run.js';

const RealDate = Date;
const env = { ...process.env };
await fs.mkdir('var', { recursive: true });
const root = await fs.mkdtemp(path.join('var', 'journal-selftest-'));
const service = await fakeService();
fakeEnv(service.url, service.url);
let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`✔ ${name}`);
}
async function rejects(name: string, p: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(p, pattern, name);
  checks++;
  console.log(`✔ ${name}`);
}
const charge: Charge = {
  side: 'sales',
  model: 'fake',
  promptTokens: 1,
  completionTokens: 1,
  cachedTokens: 0,
  reasoningTokens: 0,
  cny: 0.001,
};
const empty = { orders: [], handedOver: false, handoff: null, stage: 'greeting' as const };
const result = (repetition = 1): RunResult => ({
  goalId: 'journal-test',
  repetition,
  initial: empty,
  finalState: empty,
  turns: [],
  status: 'passed',
  endedBy: 'done',
  verdicts: [],
  reasons: [],
  customerAttempts: [],
  charges: [charge],
  turnMetrics: [],
  rerun: false,
});
const meta: RunMeta = {
  runId: 'run-test',
  head: 'head',
  freezeCommit: null,
  trees: { evalSim: 'a', fixtures: 'b', packData: 'c', src: 'd' },
  kind: 'dev',
  startedAt: new RealDate().toISOString(),
  salesModel: 'sim-fake-sales',
  customerModel: 'sim-fake-customer',
  hedgeModel: null,
  hedgeMs: null,
  k: 3,
  budget: 1,
  promptHash: 'prompt',
  policyHash: 'policy',
  pricesCheckedAt: '2026-11-01',
};
function goal(split: 'dev' | 'holdout' = 'dev'): SimGoal {
  return validateGoal(
    {
      id: 'journal-test',
      pack: 'industrial',
      persona: '合成客户，只打招呼。',
      maxTurns: 1,
      customerScript: ['你好'],
      journey: { family: 'test', split, expect: { end: 'no_quote', evidence: { reply: '您好' } }, facts: [], baselineScript: ['你好'] },
    },
    'synthetic.json',
  );
}
const processes = new Set<ChildProcess>();
function child(args: string[]) {
  const proc = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./run.ts', import.meta.url)), ...args], {
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://127.0.0.1:1/sim',
      DATABASE_OWNER_URL: 'postgresql://127.0.0.1:1/sim',
      CONFIG_SOURCE: 'db',
      TMPDIR: path.resolve(root, 'tmp'),
      // 部署门禁在 git archive 解出的目录里跑，没有 .git，用下面造的一次性仓库。
      GIT_DIR: path.join(root, 'git', '.git'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.add(proc);
  let output = '';
  proc.stdout!.on('data', (b) => {
    output += String(b);
  });
  proc.stderr!.on('data', (b) => {
    output += String(b);
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('child_timeout'));
    }, 45_000);
    proc.once('error', (e) => {
      clearTimeout(timer);
      processes.delete(proc);
      reject(e);
    });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      processes.delete(proc);
      resolve({ code, signal, output });
    });
  });
  return { proc, done };
}
async function until(fn: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = RealDate.now() + 30_000;
  while (!(await fn())) {
    if (RealDate.now() > deadline) throw new Error('observation_timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
try {
  await fs.mkdir(path.join(root, 'tmp'));
  const journalPath = path.join(root, 'unit.jsonl');
  const opened = await openJournal(journalPath, meta);
  await appendRun(journalPath, result());
  await fs.appendFile(journalPath, '{"type":"run","坏');
  const bytes = await fs.readFile(journalPath);
  const parsed = readJournal(bytes);
  check('半行丢弃；UTF-8 按字节恢复', () => {
    assert.equal(parsed.runs.length, 1);
    assert.ok(parsed.length < bytes.length);
  });
  const resumed = await openJournal(journalPath, { ...meta, runId: 'new', startedAt: 'new-time' });
  check('续写先截半行，沿用 runId / startedAt', () => {
    assert.equal(resumed.meta.runId, opened.meta.runId);
    assert.equal(resumed.meta.startedAt, meta.startedAt);
  });
  await appendRun(journalPath, { ...result(2), status: 'budget_stop' });
  const state = resumeState(readJournal(await fs.readFile(journalPath)));
  check('budget_stop 要重跑，但它的费用保留', () => {
    assert.deepEqual([...state.completed], [runKey('journal-test', 1)]);
    assert.equal(state.charges.length, 2);
  });
  const replaced = { ...result(), status: 'customer_protocol' as const, wasReplaced: true as const };
  const replacement = { ...result(), replaced, charges: [charge, charge] };
  check('外层 charges 已含 replaced，不重复累计', () => assert.equal(resumeState({ meta, runs: [replacement] }).charges.length, 2));
  for (const key of [
    'head',
    'trees',
    'kind',
    'salesModel',
    'hedgeModel',
    'hedgeMs',
    'customerModel',
    'k',
    'budget',
    'promptHash',
    'policyHash',
  ] as const)
    check(`续跑拒绝修改 ${key}`, () =>
      assert.throws(
        () => checkResume(meta, { ...meta, [key]: key === 'trees' ? { ...meta.trees, src: 'changed' } : 'changed' } as RunMeta),
        new RegExp(`journal_mismatch:${key}`),
      ),
    );
  const beforeMismatch = await fs.readFile(journalPath);
  await rejects('不符的续跑不改已有 journal', openJournal(journalPath, { ...meta, budget: 2 }), /journal_mismatch:budget/);
  assert.deepEqual(await fs.readFile(journalPath), beforeMismatch);
  const loadedMeter = new Meter(0.001, [charge]);
  check('恢复费用能触发预算 abort', () => {
    assert.equal(loadedMeter.stopped, true);
    assert.equal(loadedMeter.signal.aborted, true);
  });
  const starts: number[] = [];
  const deps: SimDeps = {
    customerModel: 'fake',
    price: () => 0,
    start: () => {
      starts.push(1);
      return { id: 'sim-test', initial: empty };
    },
    customer: async () => {
      throw new Error('customer_http');
    },
    sales: async () => {
      throw new Error('unused');
    },
    end: async () => {},
  };
  let callbacks = 0;
  const report = await simulate([goal()], 3, new Meter(1), deps, {
    runId: 'resume-id',
    resume: state,
    onRun: async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(starts.length, ++callbacks);
      assert.equal(r.runId, 'resume-id');
    },
  });
  check('simulate 跳过完成遍；串行等待 onRun；旧费用计入', () => {
    assert.equal(starts.length, 2);
    assert.equal(callbacks, 2);
    assert.equal(report.runs.length, 3);
    assert.equal(report.cost.total, 0.002);
  });
  let budgetStarts = 0;
  await simulate(
    [goal()],
    3,
    new Meter(0.001),
    {
      ...deps,
      start: () => {
        budgetStarts++;
        return { id: 'sim-test', initial: empty };
      },
    },
    { resume: state },
  );
  check('恢复费用已达上限，不开始新的一遍', () => assert.equal(budgetStarts, 0));
  check('没有 --budget / prepare 非 yes / journal 与 rerun 都拒绝', () => {
    assert.throws(() => parseArgs(['--journal', 'x']), /--budget/);
    assert.throws(() => parseArgs(['--budget', '1', '--prepare', 'no']), /--prepare/);
    assert.throws(() => parseArgs(['--budget', '1', '--journal', 'x', '--rerun', '0']), /--rerun/);
  });

  // 一次性仓库，只在这里造冻结树与提交；不改当前仓库的索引和历史。
  const repo = path.join(root, 'git');
  await fs.mkdir(repo);
  await gitText(['init', '-q'], repo);
  for (const dir of ['eval/sim', 'eval/fixtures/attachments', 'data/packs/industrial', 'src']) {
    await fs.mkdir(path.join(repo, dir), { recursive: true });
    await fs.writeFile(path.join(repo, dir, 'fixture.txt'), dir);
  }
  await gitText(['add', '.'], repo);
  await gitText(['-c', 'user.name=Sim Test', '-c', 'user.email=sim@example.test', 'commit', '-qm', 'test(sim): fixture'], repo);
  const freeze = await writeFreeze('freeze.json', repo);
  check('treeHashes 取四棵真实 git 树；freeze 带提交和换行', () => {
    assert.equal(Object.keys(freeze.trees).length, 4);
    assert.ok(Object.values(freeze.trees).every((hash) => /^[a-f0-9]{40}$/u.test(hash)));
  });
  assert.deepEqual(freeze.trees, await treeHashes('HEAD', repo));
  assert.ok((await fs.readFile(path.join(repo, 'freeze.json'), 'utf8')).endsWith('\n'));
  await rejects('freeze 拒绝脏工作区', writeFreeze('other.json', repo), /freeze_dirty_worktree/);
  const holdout = goal('holdout');
  const start = ledgerStart({ ...meta, kind: 'main', trees: freeze.trees, k: 5 }, new RealDate().toISOString());
  const valid = {
    opts: { kind: 'main' as const, ledger: 'ledger.jsonl', configDir: 'data/packs/industrial', k: 5, budget: 1, model: meta.customerModel },
    goals: [holdout],
    ledger: [start],
    committedLedger: [start],
    freeze,
    status: '',
    trees: freeze.trees,
    start,
  };
  check('holdout 按字段判：合法输入通过，无路径依赖', () => holdoutPreflight(valid));
  const fixtureLedger = path.join(repo, 'ledger.jsonl');
  await appendLedger(fixtureLedger, start);
  await gitText(['add', '.'], repo);
  await gitText(['-c', 'user.name=Sim Test', '-c', 'user.email=sim@example.test', 'commit', '-qm', 'test(sim): prepared ledger'], repo);
  const committedLedger = readLedger((await gitText(['show', 'HEAD:ledger.jsonl'], repo)) + '\n');
  const fixtureTrees = await treeHashes('HEAD', repo);
  check('真实提交开跑行：HEAD 改变、冻结树不变仍通过', () => {
    holdoutPreflight({ ...valid, committedLedger, trees: fixtureTrees });
  });
  const uncommittedStart = { ...start, runId: 'not-committed' };
  await appendLedger(fixtureLedger, uncommittedStart);
  const fixtureStatus = await gitText(['status', '--porcelain'], repo);
  check('git show 读不到的新增开跑行被拒绝', () => {
    assert.throws(
      () =>
        holdoutPreflight({ ...valid, ledger: [start, uncommittedStart], start: uncommittedStart, committedLedger, status: fixtureStatus }),
      /start_uncommitted/,
    );
  });
  const bad: [string, Parameters<typeof holdoutPreflight>[0], RegExp][] = [
    ['混合 dev', { ...valid, goals: [holdout, goal()] }, /mixed_split/],
    ['缺 kind', { ...valid, opts: { ...valid.opts, kind: undefined } }, /kind_required/],
    ['pilot', { ...valid, opts: { ...valid.opts, kind: 'pilot' } }, /kind_required/],
    ['dev', { ...valid, opts: { ...valid.opts, kind: 'dev' } }, /kind_required/],
    ['缺 ledger', { ...valid, opts: { ...valid.opts, ledger: undefined } }, /ledger_required/],
    ['工作区脏', { ...valid, status: ' M src/changed.ts' }, /dirty_worktree/],
    ['重命名树文件到账本', { ...valid, status: 'R  src/file.ts -> ledger.jsonl' }, /dirty_worktree/],
    ['树变化', { ...valid, trees: { ...freeze.trees, src: 'other' } }, /tree_mismatch/],
    ['缺 freeze', { ...valid, freeze: null }, /tree_mismatch/],
    ['缺 start', { ...valid, start: undefined }, /start_required/],
    ['工作账本缺 start', { ...valid, ledger: [] }, /start_required/],
    ['start 没提交', { ...valid, committedLedger: [] }, /start_uncommitted/],
    ['start 内容改动未提交', { ...valid, committedLedger: [{ ...start, at: 'other' }] }, /start_uncommitted/],
    ['配置目录不符', { ...valid, opts: { ...valid.opts, configDir: 'data' } }, /config_dir/],
    ['k 不符', { ...valid, opts: { ...valid.opts, k: 1 } }, /holdout_k/],
    ['tag', { ...valid, opts: { ...valid.opts, tag: 'pilot' } }, /holdout_filter/],
    ['rerun', { ...valid, opts: { ...valid.opts, rerun: 0 } }, /holdout_filter/],
    ['预算不符', { ...valid, opts: { ...valid.opts, budget: 2 } }, /start_mismatch/],
    ['客户模型不符', { ...valid, opts: { ...valid.opts, model: 'other' } }, /start_mismatch/],
    ['客户模型没显式给', { ...valid, opts: { ...valid.opts, model: undefined } }, /start_mismatch/],
  ];
  for (const [name, input, pattern] of bad) check(`holdout 拒绝 ${name}`, () => assert.throws(() => holdoutPreflight(input), pattern));
  check('允许账本单独变脏；prepare 免提交检查', () => {
    holdoutPreflight({ ...valid, status: ' M ledger.jsonl' });
    holdoutPreflight({ ...valid, phase: 'prepare', committedLedger: [] });
    holdoutPreflight({ ...valid, goals: [goal()], opts: { ...valid.opts, kind: 'pilot' }, status: ' M anything' });
  });
  const end = ledgerEnd(
    start,
    Array.from({ length: 5 }, () => result()),
    [charge],
    new RealDate().toISOString(),
  );
  const swapStart = { ...start, runId: 'swap', kind: 'customer_swap' as const, customerModel: 'other' };
  const swap = {
    ...valid,
    opts: { ...valid.opts, kind: 'customer_swap' as const, model: 'other' },
    ledger: [start, swapStart],
    start: swapStart,
    committedLedger: [swapStart],
  };
  check('swap 没有完整 main 拒绝；同模型拒绝', () => {
    assert.throws(() => holdoutPreflight(swap), /swap_requires_main/);
    assert.throws(
      () => holdoutPreflight({ ...swap, ledger: [start, { ...end, trees: { ...end.trees, src: 'other' } }, swapStart] }),
      /swap_requires_main/,
    );
    assert.throws(
      () =>
        holdoutPreflight({
          ...swap,
          opts: { ...swap.opts, model: start.customerModel },
          start: { ...swapStart, customerModel: start.customerModel },
          committedLedger: [{ ...swapStart, customerModel: start.customerModel }],
          ledger: [start, end, { ...swapStart, customerModel: start.customerModel }],
        }),
      /swap_requires_main/,
    );
  });
  check('swap 同树完整 main 且换客户模型通过；main 重跑需 reason', () => {
    holdoutPreflight({ ...swap, ledger: [start, end, swapStart] });
    assert.throws(() => holdoutPreflight({ ...valid, ledger: [start, end] }), /reason_required/);
    assert.throws(
      () => holdoutPreflight({ ...valid, ledger: [start, end], opts: { ...valid.opts, reason: '合成测试重跑' } }),
      /reason_unrecorded/,
    );
    const withReason = { ...start, runId: 'rerun', reason: '合成测试重跑' };
    holdoutPreflight({
      ...valid,
      ledger: [start, end, withReason],
      start: withReason,
      committedLedger: [withReason],
      opts: { ...valid.opts, reason: '合成测试重跑' },
    });
  });
  const ledgerPath = path.join(root, 'unit-ledger.jsonl');
  await appendLedger(ledgerPath, start);
  const beforeEnd = await fs.readFile(ledgerPath);
  await appendLedger(ledgerPath, end);
  check('账本只追加、结束计数与费用正确', () => {
    assert.equal(end.passed, 5);
    assert.equal(end.failed, 0);
    assert.equal(end.excluded, 0);
    assert.equal(end.spentMilli, 1);
  });
  assert.deepEqual((await fs.readFile(ledgerPath)).subarray(0, beforeEnd.length), beforeEnd);
  assert.equal((await ledgerFile(ledgerPath)).length, 2);

  // 客户重试与隔离直接走真实 runtime，退避注入 0；禁止请求的地址不启动服务。
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/sim';
  process.env.DATABASE_PLATFORM_URL = 'postgresql://127.0.0.1:1/sim';
  process.env.TMPDIR = path.resolve(root, 'tmp');
  const runtimeMeter = new Meter(1);
  const runtime = await engineRuntime(runtimeMeter, 'sim-fake-customer', fakePrices, {
    configDir: 'data/packs/industrial',
    strictNet: true,
    retryDelay: async () => {},
  });
  try {
    check('strictNet 装载前移除数据库变量，强制 file', () => {
      assert.equal(process.env.DATABASE_URL, undefined);
      assert.equal(process.env.DATABASE_PLATFORM_URL, undefined);
      assert.equal(process.env.CONFIG_SOURCE, 'file');
      assert.equal(runtime.metadata.pricesCheckedAt, '2026-11-01');
      assert.equal(runtime.metadata.hedgeModel, null);
    });
    await rejects(
      '非模型 origin 直接拒绝且不泄漏地址',
      fetch('http://127.0.0.1:1/private?token=not-a-secret'),
      /^Error: sim_egress_forbidden$/u,
    );
    for (const step of [{ status: 429 }, { status: 500 }, { errorCode: 1302 }, { errorCode: 1305 }, { status: 400, errorCode: 1302 }]) {
      const before = service.requests.length;
      service.script.push(step, step, step, say('您好', true));
      const response = await runtime.deps.customer('合成客户', [], false);
      check(`客户 ${JSON.stringify(step)} 三次退避重试后成功`, () => {
        assert.equal(service.requests.length - before, 4);
        assert.equal(JSON.parse(response.raw).say, '您好');
        assert.equal(Object.hasOwn(service.requests.at(-1)!, 'temperature'), false);
      });
    }
    service.script.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    const noScript = goal();
    delete noScript.customerScript;
    const failed = await simulate([noScript], 1, runtimeMeter, runtime.deps);
    check('客户重试耗尽判 customer_http，不伪装成协议错误', () => {
      assert.equal(failed.runs[0]!.status, 'customer_http');
      assert.equal(failed.runs[0]!.customerHttp, '500');
    });
    const beforeDrop = service.requests.length;
    service.script.push({ destroy: true }, { destroy: true }, { destroy: true }, say('您好', true));
    const dropped = await runtime.deps.customer('合成客户', [], false);
    check('客户接口断连也退避重试', () => {
      assert.equal(service.requests.length - beforeDrop, 4);
      assert.equal(JSON.parse(dropped.raw).say, '您好');
    });
    service.script.push({ destroy: true }, { destroy: true }, { destroy: true }, { destroy: true });
    await rejects('断连重试耗尽判 customer_http，不算到销售头上', runtime.deps.customer('合成客户', [], false), /customer_http/);
    service.script.push({ status: 400 });
    const before400 = service.requests.length;
    await rejects('其他 4xx 不重试', runtime.deps.customer('合成客户', [], false), /customer_http/);
    assert.equal(service.requests.length - before400, 1);
  } finally {
    await runtime.close();
  }
  check('runtime 关闭恢复调用者数据库环境', () => assert.equal(process.env.DATABASE_URL, 'postgresql://127.0.0.1:1/sim'));

  const goalsFile = path.join(root, 'goals.json');
  const pricesFile = path.join(root, 'prices.json');
  await fs.writeFile(goalsFile, JSON.stringify(goal()));
  await fs.writeFile(pricesFile, JSON.stringify(fakePrices));
  const cliJournal = path.join(root, 'cli.jsonl');
  const cliLedger = path.join(root, 'cli-ledger.jsonl');
  const cliReport = path.join(root, 'report.json');
  const args = [
    '--goals',
    goalsFile,
    '--k',
    '3',
    '--budget',
    '1',
    '--model',
    'sim-fake-customer',
    '--config-dir',
    'data/packs/industrial',
    '--prices',
    pricesFile,
    '--journal',
    cliJournal,
    '--ledger',
    cliLedger,
    '--report',
    cliReport,
    '--kind',
    'dev',
  ];
  const beforePrepare = service.requests.length;
  const prepared = await child([...args, '--prepare', 'yes']).done;
  check('prepare 不装载引擎 / 不请求模型，只写真实时间开跑行', () => {
    assert.equal(prepared.code, 0, prepared.output);
    assert.equal(service.requests.length, beforePrepare);
    assert.match(prepared.output, /提交并推送/);
  });
  assert.equal(await fs.stat(cliJournal).catch(() => null), null);
  assert.deepEqual(
    (await fs.readdir(path.join(root, 'tmp'))).filter((name) => name.startsWith('wecom-sim-')),
    [],
  );
  const preparedLines = await ledgerFile(cliLedger);
  assert.equal(preparedLines.length, 1);
  assert.equal(preparedLines[0]!.event, 'start');
  assert.equal(preparedLines[0]!.at.slice(0, 10), new RealDate().toISOString().slice(0, 10));
  assert.notEqual(preparedLines[0]!.at.slice(0, 10), FIXTURE_CLOCK.slice(0, 10));
  service.script.push({ content: '您好' }, { content: '您好', delayMs: 30_000 });
  const interrupted = child(args);
  await until(
    async () =>
      service.requests.length >= beforePrepare + 2 &&
      (await fs
        .readFile(cliJournal)
        .then((b) => readJournal(b).runs.length >= 1)
        .catch(() => false)),
  );
  interrupted.proc.kill('SIGTERM');
  const killed = await interrupted.done;
  await until(() => service.inFlight === 0);
  const killedJournal = readJournal(await fs.readFile(cliJournal));
  check('验收 8 真进程中断后已完成遍保留；被杀仅 start', () => {
    assert.notEqual(killed.code, 0);
    assert.equal(killedJournal.runs.length, 1);
    assert.equal(killedJournal.runs[0]!.repetition, 1);
    assert.equal(killedJournal.meta.runId, preparedLines[0]!.runId);
  });
  assert.equal((await ledgerFile(cliLedger)).length, 1);
  await fs.appendFile(cliJournal, '{"type":"run","半');
  const beforeResume = service.requests.length;
  service.script.push({ content: '您好' }, { content: '您好' });
  const continued = await child(args).done;
  const finishedJournal = readJournal(await fs.readFile(cliJournal));
  const finishedReport = JSON.parse(await fs.readFile(cliReport, 'utf8'));
  check('验收 8 相同配置只续剩余两遍，费用恢复，不并发', () => {
    assert.equal(continued.code, 0, continued.output);
    assert.equal(service.requests.length - beforeResume, 2);
    assert.deepEqual(
      finishedJournal.runs.map((r) => r.repetition),
      [1, 2, 3],
    );
    assert.equal(finishedReport.runs.length, 3);
    assert.equal(finishedReport.charges.length, 3);
    assert.equal(
      finishedReport.cost.total,
      finishedJournal.runs.flatMap((r) => r.charges).reduce((s, c) => s + c.cny, 0),
    );
    assert.equal(service.maxInFlight, 1);
    assert.equal(finishedJournal.meta.startedAt, killedJournal.meta.startedAt);
  });
  const completedLedger = await ledgerFile(cliLedger);
  check('验收 9 正常完成追加 end，真实时间不受 fixtureClock 影响', () => {
    assert.equal(completedLedger.length, 2);
    assert.equal(completedLedger[1]!.event, 'end');
    assert.equal(completedLedger[1]!.passed, 3);
    assert.equal(completedLedger[1]!.at.slice(0, 10), new RealDate().toISOString().slice(0, 10));
  });
  const mismatched = await child(args.map((x, i) => (args[i - 1] === '--budget' ? '2' : x))).done;
  check('CLI 与 journal 首行不符就拒绝，无新请求', () => {
    assert.equal(mismatched.code, 1);
    assert.match(mismatched.output, /journal_mismatch:budget/);
    assert.equal(service.requests.length - beforeResume, 2);
  });

  const budgetArgs = args.map((x, i) =>
    args[i - 1] === '--budget'
      ? '0.0001'
      : x
          .replace(/cli\.jsonl$/u, 'budget.jsonl')
          .replace(/cli-ledger\.jsonl$/u, 'budget-ledger.jsonl')
          .replace(/report\.json$/u, 'budget-report.json'),
  );
  service.script.push({ content: '您好' });
  const budgetRun = await child(budgetArgs).done;
  const budgetJournal = readJournal(await fs.readFile(path.join(root, 'budget.jsonl')));
  check('验收 9 到预算截断一遍，不再开始下一遍', () => {
    assert.equal(budgetRun.code, 1);
    assert.equal(budgetJournal.runs.length, 1);
    assert.equal(budgetJournal.runs[0]!.status, 'budget_stop');
  });
  const afterBudget = service.requests.length;
  await child(budgetArgs).done;
  assert.equal(service.requests.length, afterBudget);
  assert.equal((await ledgerFile(path.join(root, 'budget-ledger.jsonl'))).length, 2);

  // 真实 auditRun 跟着 replaced 进同一行，费用由外层汇总。
  const rerunGoal = goal();
  delete rerunGoal.customerScript;
  await fs.writeFile(goalsFile, JSON.stringify(rerunGoal));
  const rerunArgs = args.map((x, i) =>
    args[i - 1] === '--k'
      ? '1'
      : x
          .replace(/cli\.jsonl$/u, 'rerun.jsonl')
          .replace(/cli-ledger\.jsonl$/u, 'rerun-ledger.jsonl')
          .replace(/report\.json$/u, 'rerun-report.json'),
  );
  service.script.push(say('你好'), { content: '# 您好' }, { content: 'bad' }, { content: 'bad' }, say('', true));
  // 第一遍允许第二轮客户协议错误；第二遍客户直接离开，终态不通过。
  rerunGoal.maxTurns = 2;
  await fs.writeFile(goalsFile, JSON.stringify(rerunGoal));
  const rerunResult = await child(rerunArgs).done;
  const rerunJournal = readJournal(await fs.readFile(path.join(root, 'rerun.jsonl')));
  check('验收 8 被替换的一遍保留并经过真实审计', () => {
    const r = rerunJournal.runs[0]!;
    assert.equal(rerunResult.code, 1, rerunResult.output);
    assert.ok(r.replaced?.wasReplaced);
    assert.ok(r.replaced.findings?.some((f) => f.source === 'draft' && f.rule === 'markdown' && f.id.startsWith(r.runId!)));
    assert.ok(r.charges.length > r.replaced.charges.length);
  });
  console.log(`JOURNAL SELFTEST PASS: ${checks} 项（中断续跑 / 账本 / 冻结 / 留出集预检 / 隔离 / 客户重试）`);
} finally {
  await Promise.all(
    [...processes].map(
      (proc) =>
        new Promise<void>((resolve) => {
          proc.once('exit', () => resolve());
          proc.kill('SIGKILL');
        }),
    ),
  );
  await service.close();
  await fs.rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}
