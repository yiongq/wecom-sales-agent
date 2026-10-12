// 分片完整性与失败行为的夹具自测；采用 check-console-src.selftest.ts 的普通 tsx 脚本形式。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocate, buildUnits, checkCoverage, DEPENDENCIES, runUnits, shardCount, type TestScripts, type Unit } from './ci-shard.js';
import { selectStrictSuites, STRICT_SUITES } from './test-tenancy-strict.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
function rejects(name: string, fn: () => unknown, message: string): void {
  try {
    fn();
    check(name, false, '没有拒绝');
  } catch (error) {
    check(name, error instanceof Error && error.message.includes(message), String(error));
  }
}
const scripts: TestScripts = {
  test: [
    'pnpm -s test:locked',
    'CONFIG_SOURCE=file LLM_MOCK=1 tsx fixture.ts',
    ...DEPENDENCIES[0]!,
    'TENANCY_STRICT=1 tsx scripts/test-tenancy-strict.ts',
  ].join(' && '),
  'test:locked': 'CONFIG_SOURCE=file PARITY_CLOCK_MS=1 tsx --import ./clock.ts locked.ts',
};
const units = buildUnits(scripts, {});
check('锁定命令的环境、预载前缀原样保留', units[0]?.commands[0] === scripts['test:locked']);
check('正常命令的环境前缀原样保留', units[1]?.commands[0] === 'CONFIG_SOURCE=file LLM_MOCK=1 tsx fixture.ts');
check('没有参数仍选择全部原严格列表', selectStrictSuites([]) === STRICT_SUITES);
check('严格子集只选择指定项', JSON.stringify(selectStrictSuites(['--suite', STRICT_SUITES[12]!])) === JSON.stringify([STRICT_SUITES[12]]));
check('可重复 --suite 选择多项', selectStrictSuites(['--suite', STRICT_SUITES[0]!, '--suite', STRICT_SUITES[1]!]).length === 2);
rejects('空严格子集被拒绝', () => selectStrictSuites(['--suite', '']), '为空');
rejects('缺少严格子集参数被拒绝', () => selectStrictSuites(['--suite']), '为空');
rejects('未知严格子集被拒绝', () => selectStrictSuites(['--suite', 'unknown.ts']), '未知');
rejects('重复严格子集被拒绝', () => selectStrictSuites(['--suite', STRICT_SUITES[0]!, '--suite', STRICT_SUITES[0]!]), '重复');
rejects('未知严格参数被拒绝', () => selectStrictSuites(['--all']), '用法');
for (const count of [1, 2, 3, 4, 7, units.length + 1]) {
  const shards = allocate(units, count);
  checkCoverage(scripts, shards, count);
  check(`${count} 片的覆盖、片数与确定性`, shards.length === count && JSON.stringify(shards) === JSON.stringify(allocate(units, count)));
  check(`${count} 片保留依赖单元`, shards.flat().filter((unit) => unit.commands.length === 2).length === 1);
}
const shards = allocate(units, 4);
const clone = (): Unit[][] => structuredClone(shards);
const missing = clone();
missing[0]!.shift();
rejects('漏一条被拒绝', () => checkCoverage(scripts, missing, 4), '遗漏');
const extra = clone();
extra[0]!.push({ id: 'extra', commands: ['tsx extra.ts'], seconds: 10 });
rejects('多一条被拒绝', () => checkCoverage(scripts, extra, 4), '多余');
const duplicate = clone();
duplicate[0]!.push(structuredClone(shards[0]![0]!));
rejects('重一条被拒绝', () => checkCoverage(scripts, duplicate, 4), '重复');
const splitDependency = clone();
const owner = splitDependency.find((shard) => shard.some((unit) => unit.commands.length === 2))!;
const at = owner.findIndex((unit) => unit.commands.length === 2);
const dependency = owner.splice(at, 1)[0]!;
for (const [index, command] of dependency.commands.entries())
  splitDependency[index]!.push({ id: command, commands: [command], seconds: 10 });
rejects('依赖拆到不同片被拒绝（原子命令仍全部覆盖）', () => checkCoverage(scripts, splitDependency, 4), '依赖被拆开');
const reordered = clone();
reordered
  .flat()
  .find((unit) => unit.commands.length === 2)!
  .commands.reverse();
rejects('依赖内部顺序被改变时拒绝', () => checkCoverage(scripts, reordered, 4), '依赖被拆开');
const missingStrict = clone();
const strictOwner = missingStrict.find((shard) => shard.some((unit) => unit.strictSuite))!;
strictOwner.splice(
  strictOwner.findIndex((unit) => unit.strictSuite),
  1,
);
rejects('漏严格套件被拒绝', () => checkCoverage(scripts, missingStrict, 4), '遗漏');
rejects('传错 N 被拒绝', () => checkCoverage(scripts, shards, 3), '数量');
rejects(
  '原链缺依赖被拒绝',
  () => buildUnits({ ...scripts, test: scripts.test.replace(' && tsx scripts/check-console-dist.ts', '') }, {}),
  '依赖规则',
);
rejects(
  '原链依赖不相邻被拒绝',
  () =>
    buildUnits(
      {
        ...scripts,
        test: scripts.test.replace(' && tsx scripts/check-console-dist.ts', ' && tsx middle.ts && tsx scripts/check-console-dist.ts'),
      },
      {},
    ),
  '依赖规则',
);
rejects(
  '原链缺严格入口被拒绝',
  () => buildUnits({ ...scripts, test: scripts.test.replace(' && TENANCY_STRICT=1 tsx scripts/test-tenancy-strict.ts', '') }, {}),
  '严格重跑',
);
for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '4junk', '9007199254740992'])
  rejects(`非法片数 ${value} 被拒绝`, () => shardCount(value), '无效');
rejects('负耗时被拒绝', () => buildUnits(scripts, { 'fixture.ts': -1 }), '无效耗时');
const weighted = buildUnits(scripts, { 'fixture.ts': 33 });
check(
  '显式耗时优先、未知耗时为 10 秒、依赖耗时相加',
  weighted[1]?.seconds === 33 && weighted[0]?.seconds === 10 && weighted[2]?.seconds === 20,
);
const greedy = allocate(
  [8, 7, 6, 5, 4].map((seconds, i) => ({ id: String(i), commands: [String(i)], seconds })),
  2,
);
check(
  '最长优先放进最轻片，同负载选较小片号',
  JSON.stringify(greedy.map((shard) => shard.map((unit) => unit.seconds))) === '[[8,5,4],[7,6]]',
);

// 真正执行 CLI 的临时仓库夹具：环境前缀、失败停止、错误定位与日志不依赖 shell 的假实现。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-shard-selftest-'));
try {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  const cli = path.join(import.meta.dirname, 'ci-shard.ts');
  const loader = import.meta.resolve('tsx');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', loader, cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  const valid = run('--check', '4');
  check(
    'CLI --check 在临时完整链上通过并打印四片',
    valid.status === 0 && valid.stdout.includes('CHECK PASS') && valid.stdout.includes('4/4:'),
    valid.stderr,
  );
  const invalid = run('5', '4');
  check('CLI 非法片号非零退出', invalid.status === 1 && invalid.stderr.includes('超出'), invalid.stderr);
  const empty = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'test-tenancy-strict.ts'), '--suite', ''], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  check('严格 CLI 空子集非零退出', empty.status === 1 && empty.stderr.includes('为空'), empty.stderr);
  // 使用相对 node 文件，由同一个真实执行器交给 shell。
  fs.writeFileSync(
    path.join(dir, 'prefix.cjs'),
    "require('node:fs').writeFileSync('prefix.txt', process.env.CONFIG_SOURCE + ':' + process.env.LLM_MOCK);",
  );
  fs.writeFileSync(path.join(dir, 'fail.cjs'), 'process.exit(7);');
  fs.writeFileSync(path.join(dir, 'later.cjs'), "require('node:fs').writeFileSync('later.txt', 'unexpected');");
  const command = 'CONFIG_SOURCE=file LLM_MOCK=1 node prefix.cjs';
  const executable = { ...scripts, test: scripts.test.replace('CONFIG_SOURCE=file LLM_MOCK=1 tsx fixture.ts', command) };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: executable }));
  const weights = JSON.parse(fs.readFileSync(new URL('./ci-weights.json', import.meta.url), 'utf8')) as Record<string, number>;
  const executableUnits = buildUnits(executable, weights);
  const isolated = allocate(executableUnits, executableUnits.length);
  const selected = isolated.findIndex((shard) => shard.some((unit) => unit.id === command)) + 1;
  const executed = run(String(selected), String(executableUnits.length));
  check(
    'CLI 执行指定分片且打印开始、结束与耗时',
    executed.status === 0 && executed.stdout.includes(`START ${command}`) && executed.stdout.includes('exit=0'),
    executed.stderr,
  );
  check('shell 收到原环境前缀', fs.readFileSync(path.join(dir, 'prefix.txt'), 'utf8') === 'file:1');
  let failure = '';
  try {
    await runUnits([{ id: 'failure', commands: ['node fail.cjs', 'node later.cjs'], seconds: 10 }], { cwd: dir });
  } catch (error) {
    failure = String(error);
  }
  check(
    '非零退出点名原命令与退出码，并且不跑后续命令',
    failure.includes('node fail.cjs') && failure.includes('7') && !fs.existsSync(path.join(dir, 'later.txt')),
    failure,
  );
  fs.writeFileSync(path.join(dir, 'hang.cjs'), 'setInterval(() => {}, 1000);');
  let timeout = '';
  try {
    await runUnits([{ id: 'hang', commands: ['node hang.cjs'], seconds: 10 }], { cwd: dir, timeoutMs: 100 });
  } catch (error) {
    timeout = String(error);
  }
  check('超时结束进程并点名原命令', timeout.includes('timeout') && timeout.includes('node hang.cjs'), timeout);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`ci-shard: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const failure of fails) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`ci-shard: ${pass} 条断言全部通过`);
