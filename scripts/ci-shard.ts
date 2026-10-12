// CI 从本机完整链导出分片；不维护第二份测试清单。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRICT_SUITES } from './test-tenancy-strict.js';

export type TestScripts = { test: string; 'test:locked': string };
export type Unit = { id: string; commands: string[]; seconds: number; strictSuite?: string };
export type Weights = Record<string, number>;
const LOCKED = 'pnpm -s test:locked';
const STRICT = 'TENANCY_STRICT=1 tsx scripts/test-tenancy-strict.ts';
// 唯一跨命令产物依赖：vite.config.ts 写 dist 与 build-meta，check-console-dist.ts 读这两处。
export const DEPENDENCIES: readonly (readonly string[])[] = [['pnpm --filter console build', 'tsx scripts/check-console-dist.ts']];

function split(chain: string): string[] {
  const commands = chain.split(' && ');
  if (commands.some((command) => !command.trim())) throw new Error('完整链含空命令');
  return commands;
}

function expandLocked(scripts: TestScripts): string[] {
  const commands = split(scripts.test);
  if (commands.filter((command) => command === LOCKED).length !== 1) throw new Error('完整链必须恰含一个 test:locked');
  return commands.flatMap((command) => (command === LOCKED ? split(scripts['test:locked']) : [command]));
}

function strictCommand(suite: string): string {
  return `${STRICT} --suite ${suite}`;
}

function weight(command: string, weights: Weights): number {
  // 当前链里的 tsx 目标均是最后一个 token；包含原有环境变量与 tsconfig / preload 前缀。
  return weights[command.split(' ').at(-1)!] ?? weights[command] ?? 10;
}

export function buildUnits(scripts: TestScripts, weights: Weights): Unit[] {
  for (const [name, seconds] of Object.entries(weights)) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`无效耗时：${name}`);
  }
  const commands = expandLocked(scripts);
  if (commands.filter((command) => command === STRICT).length !== 1) throw new Error('完整链必须恰含一个严格重跑入口');
  for (const dependency of DEPENDENCIES) {
    const start = commands.indexOf(dependency[0]!);
    if (start < 0 || dependency.some((command, index) => commands[start + index] !== command))
      throw new Error(`依赖规则缺失或顺序改变：${dependency.join(' → ')}`);
    if (dependency.some((command) => commands.filter((candidate) => candidate === command).length !== 1))
      throw new Error(`依赖命令重复：${dependency.join(' → ')}`);
  }
  const units: Unit[] = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    if (command === STRICT) {
      for (const suite of STRICT_SUITES) {
        units.push({
          id: `strict:${suite}`,
          commands: [strictCommand(suite)],
          seconds: weights[`strict:${suite}`] ?? weights[suite] ?? 10,
          strictSuite: suite,
        });
      }
    } else {
      const dependency = DEPENDENCIES.find((rule) => rule[0] === command);
      const group = dependency ? [...dependency] : [command];
      units.push({ id: group.join(' && '), commands: group, seconds: group.reduce((sum, item) => sum + weight(item, weights), 0) });
      index += group.length - 1;
    }
  }
  if (new Set(units.map((unit) => unit.id)).size !== units.length) throw new Error('完整链含重复单元');
  return units;
}

export function shardCount(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`无效片数或片号：${value}`);
  return Number(value);
}

export function allocate(units: readonly Unit[], count: number): Unit[][] {
  shardCount(String(count));
  const shards: Unit[][] = Array.from({ length: count }, () => []);
  const totals = Array<number>(count).fill(0);
  const ordered = units.map((unit, index) => ({ unit, index })).toSorted((a, b) => b.unit.seconds - a.unit.seconds || a.index - b.index);
  for (const { unit } of ordered) {
    let lightest = 0;
    for (let i = 1; i < count; i++) if (totals[i]! < totals[lightest]!) lightest = i;
    shards[lightest]!.push(unit);
    totals[lightest]! += unit.seconds;
  }
  // 分配按耗时，执行按原链顺序；依赖单元的内部顺序同样保留。
  const order = new Map(units.map((unit, index) => [unit.id, index]));
  for (const shard of shards) shard.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return shards;
}

export function checkCoverage(scripts: TestScripts, shards: readonly (readonly Unit[])[], count: number): void {
  if (shards.length !== count) throw new Error('分片数量不符');
  // 从原链独立展开原子命令，避免只拿分配器自己的单元清单自证覆盖。
  const expected = expandLocked(scripts).flatMap((command) => (command === STRICT ? STRICT_SUITES.map(strictCommand) : [command]));
  const actual = shards.flatMap((shard) => shard.flatMap((unit) => unit.commands));
  const remaining = new Map<string, number>();
  for (const command of expected) remaining.set(command, (remaining.get(command) ?? 0) + 1);
  for (const command of actual) {
    const left = remaining.get(command) ?? 0;
    if (left === 0) throw new Error(`多余或重复命令：${command}`);
    remaining.set(command, left - 1);
  }
  for (const [command, left] of remaining) if (left) throw new Error(`遗漏命令：${command}`);
  const canonical = buildUnits(scripts, {});
  const byId = new Map(canonical.map((unit) => [unit.id, unit]));
  const seen = new Set<string>();
  for (const unit of shards.flat()) {
    const original = byId.get(unit.id);
    if (!original || JSON.stringify(unit.commands) !== JSON.stringify(original.commands) || unit.strictSuite !== original.strictSuite)
      throw new Error(`依赖被拆开或单元被改变：${unit.id}`);
    if (seen.has(unit.id)) throw new Error(`重复单元：${unit.id}`);
    seen.add(unit.id);
  }
  if (seen.size !== canonical.length) throw new Error('遗漏单元');
  const strict = shards.flat().filter((unit) => unit.strictSuite);
  if (strict.length !== STRICT_SUITES.length || new Set(strict.map((unit) => unit.strictSuite)).size !== STRICT_SUITES.length)
    throw new Error('严格套数不符');
}

export function printShards(shards: readonly (readonly Unit[])[]): void {
  for (const [index, shard] of shards.entries()) {
    const total = shard.reduce((sum, unit) => sum + unit.seconds, 0);
    console.log(`[ci-shard] ${index + 1}/${shards.length}: ${shard.length} units, estimate=${total}s (${(total / 60).toFixed(2)}min)`);
    for (const unit of shard) console.log(`  ${unit.seconds}s ${unit.id}`);
  }
}

export async function runUnits(units: readonly Unit[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<void> {
  for (const unit of units) {
    for (const command of unit.commands) {
      console.log(`[ci-shard] START ${command}`);
      const start = performance.now();
      const child = spawn(command, { shell: true, stdio: 'inherit', cwd: options.cwd, detached: true });
      let interrupted = '';
      const stop = (reason: string) => {
        interrupted = reason;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      };
      const onTerm = () => stop('SIGTERM');
      const onInt = () => stop('SIGINT');
      process.once('SIGTERM', onTerm);
      process.once('SIGINT', onInt);
      const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 900_000);
      let code: number | null = null;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
      } finally {
        clearTimeout(timer);
        process.removeListener('SIGTERM', onTerm);
        process.removeListener('SIGINT', onInt);
        console.log(`[ci-shard] END ${((performance.now() - start) / 1000).toFixed(2)}s exit=${code} ${interrupted} ${command}`);
      }
      if (code !== 0 || interrupted) throw new Error(`命令失败：${command}（退出码 ${code}${interrupted ? `，${interrupted}` : ''}）`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('用法：tsx scripts/ci-shard.ts <i> <n> | --check <n>（片号从 1 开始）');
  const count = shardCount(args[1]!);
  const index = args[0] === '--check' ? null : shardCount(args[0]!);
  if (index !== null && index > count) throw new Error('片号超出片数');
  const scripts = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: TestScripts }).scripts;
  const weights = JSON.parse(fs.readFileSync(new URL('./ci-weights.json', import.meta.url), 'utf8')) as Weights;
  const shards = allocate(buildUnits(scripts, weights), count);
  checkCoverage(scripts, shards, count);
  if (index === null) {
    printShards(shards);
    console.log(`[ci-shard] CHECK PASS: ${shards.flat().length} units, ${STRICT_SUITES.length} strict suites`);
  } else {
    console.log(`[ci-shard] RUN ${index}/${count}`);
    await runUnits(shards[index - 1]!);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
