import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brandCase } from './brand.js';
import { validateCases, type CaseV2 } from './schema.js';
import { compareCaseSnapshot, createSnapshot, readBaseline, serializeSnapshot, type TurnObservation } from './snapshot.js';

export interface CaseResult {
  id: string;
  pass: boolean;
  checks: number;
  guardSkipped: number;
  failures: string[];
  turns?: unknown[];
  observations?: TurnObservation[];
}

export function loadCases(target: string, optional = false): CaseV2[] {
  if (optional && !fs.existsSync(target)) return [];
  const files = fs.statSync(target).isDirectory()
    ? fs
        .readdirSync(target)
        .filter((f) => f.endsWith('.json'))
        .toSorted()
        .map((f) => path.join(target, f))
    : [target];
  const entries = files.flatMap((f) => {
    const data: unknown = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(data) ? data : [data];
  });
  return validateCases(entries);
}

/** 每条 case 一个进程：模块级 store、时钟、DB 和环境变量都不跨 case。父进程兜底超时和删状态。 */
export async function runCaseV2(c: CaseV2, timeoutMs = 30_000): Promise<CaseResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-eval-v2-'));
  try {
    const input = path.join(dir, 'case.json');
    const output = path.join(dir, 'result.json');
    fs.writeFileSync(input, JSON.stringify(c));
    const worker = fileURLToPath(new URL('../run.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', worker, '--v2-worker', input, dir, output], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, VAR_DIR: dir },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    if (timedOut) throw new Error(`超时（${timeoutMs}ms），假服务进程已终止`);
    if (!fs.existsSync(output)) throw new Error(`假服务进程异常结束（${code}）`);
    const result = JSON.parse(fs.readFileSync(output, 'utf8')) as CaseResult;
    if (code !== 0 && result.pass) throw new Error(`假服务进程异常结束（${code}）`);
    return result;
  } catch (e) {
    return { id: c.id, pass: false, checks: 0, guardSkipped: 0, failures: [`[${c.id}] ${e instanceof Error ? e.message : String(e)}`] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 未设覆盖时留一个逻辑核给父进程，最多八名 worker。 */
export function workerCount(): number {
  const raw = process.env.EVAL_V2_WORKERS;
  if (raw === undefined) return Math.max(1, Math.min(os.availableParallelism() - 1, 8));
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('EVAL_V2_WORKERS 必须是正整数');
  return count;
}

const failed = (c: CaseV2, reason: string): CaseResult => ({
  id: c.id,
  pass: false,
  checks: 0,
  guardSkipped: 0,
  failures: [`[${c.id}] ${reason}`],
});

/** 一条执行通道：同一子进程内不并发，超时/异常后删目录并在下一条补位。 */
export class V2Worker {
  private child?: ChildProcess;
  private dir?: string;
  private exited?: Promise<void>;

  async run(c: CaseV2, timeoutMs = 30_000): Promise<CaseResult> {
    if (!this.child) {
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-eval-v2-'));
      const entry = fileURLToPath(new URL('../run.ts', import.meta.url));
      this.child = spawn(process.execPath, ['--import', 'tsx', entry, '--v2-pool-worker', this.dir], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, VAR_DIR: this.dir },
      });
      this.exited = new Promise((resolve) => {
        this.child!.once('exit', () => resolve());
        this.child!.once('error', () => {
          if (!this.child?.pid) resolve();
        });
      });
    }
    const child = this.child;
    let broken = false;
    const result = await new Promise<CaseResult>((resolve) => {
      const finish = (r: CaseResult) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onClose);
        resolve(r);
      };
      const onMessage = (r: CaseResult) => finish(r);
      const onError = () => {
        broken = true;
        child.kill('SIGKILL');
        finish(failed(c, '假服务进程异常结束（启动或 IPC 失败）'));
      };
      const onClose = (code: number | null) => {
        broken = true;
        finish(failed(c, `假服务进程异常结束（${code}）`));
      };
      const timer = setTimeout(() => {
        broken = true;
        child.kill('SIGKILL');
        finish(failed(c, `超时（${timeoutMs}ms），假服务进程已终止`));
      }, timeoutMs);
      child.once('message', onMessage);
      child.once('error', onError);
      child.once('exit', onClose);
      if (child.exitCode !== null || child.signalCode !== null) onClose(child.exitCode);
      else
        child.send(c, (e) => {
          if (e) onError();
        });
    });
    if (broken) await this.close();
    return result;
  }

  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    // 正常收尾允许 worker 关闭 DB；兜底保证不会残留进程/假服务。
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    if (child.connected) child.disconnect();
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
      this.child = undefined;
      this.dir = undefined;
      this.exited = undefined;
    }
  }
}

export async function runCasesV2(
  cases: CaseV2[],
  options: { workers?: number; isolate?: boolean; timeoutMs?: number; onResult?: (result: CaseResult, index: number) => void } = {},
): Promise<CaseResult[]> {
  const count = options.isolate ? 1 : (options.workers ?? workerCount());
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('workers 必须是正整数');
  const results: CaseResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, cases.length) }, async () => {
      const worker = new V2Worker();
      try {
        while (next < cases.length) {
          const index = next++;
          const c = cases[index];
          const result = options.isolate ? await runCaseV2(c, options.timeoutMs) : await worker.run(c, options.timeoutMs);
          results[index] = result;
          options.onResult?.(result, index);
        }
      } finally {
        await worker.close();
      }
    }),
  );
  return results;
}

export async function runV2(cases: CaseV2[]): Promise<boolean> {
  const started = performance.now();
  const brandIndex = process.argv.indexOf('--brand');
  if (brandIndex > 0) {
    const name = process.argv[brandIndex + 1];
    if (!name || name.startsWith('--')) throw new Error('--brand 需要夹具名');
    cases = cases.map((c) => brandCase(c, name));
  }
  const writeIndex = process.argv.indexOf('--v2-snapshot-write');
  const writeTarget = writeIndex > 0 ? process.argv[writeIndex + 1] : undefined;
  if (writeIndex > 0 && (!writeTarget || writeTarget.startsWith('--'))) {
    console.error('v2: --v2-snapshot-write 需要文件路径');
    return false;
  }
  let baseline: ReturnType<typeof readBaseline>;
  try {
    baseline = writeTarget ? undefined : readBaseline();
  } catch (e) {
    console.error(`v2 快照读取失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const baselineCases = new Map(baseline?.cases.map((c) => [c.id, c]));
  let differences = 0;
  let compared = 0;
  const tagIndex = process.argv.indexOf('--tags');
  const selected = tagIndex > 0 ? cases.filter((c) => c.tags.includes(process.argv[tagIndex + 1])) : cases;
  const skipped = selected.filter((c) => c.realOnly).length;
  const buffered = new Map<number, CaseResult>();
  let printed = 0;
  const results = await runCasesV2(
    selected.filter((c) => !c.realOnly),
    {
      isolate: process.argv.includes('--v2-isolate'),
      onResult(result, index) {
        if (baselineCases.has(result.id)) {
          compared++;
          const diff = compareCaseSnapshot(result, baselineCases.get(result.id));
          differences += diff.length;
          result.failures.push(...diff);
          if (diff.length) result.pass = false;
        }
        buffered.set(index, result);
        while (buffered.has(printed)) {
          const r = buffered.get(printed)!;
          buffered.delete(printed++);
          console.log(`  ${r.pass ? '✓' : '✗'} v2 [${r.id}]`);
          for (const failure of r.failures) console.log(`    ${failure}`);
        }
      },
    },
  );
  // 默认完整回归也检查基线里是否有被删掉的 case；显式文件/标签选择允许只比子集。
  const subset = tagIndex > 0 || process.argv.includes('--cases') || process.argv.includes('--cases-v2');
  if (baseline && !subset) {
    const ids = new Set(selected.map((c) => c.id));
    for (const c of baseline.cases) {
      if (ids.has(c.id)) continue;
      differences++;
      console.log(`  ✗ [${c.id}] 第0轮 snapshot.case: 快照 ${JSON.stringify(c.id)}；当前 缺少 case`);
    }
  }
  console.log(
    `v2 回归评测：${results.filter((r) => r.pass).length}/${results.length} 用例通过 · 跳过 ${skipped} 条 realOnly · ` +
      `${results.reduce((n, r) => n + r.checks, 0)} 项断言`,
  );
  if (baseline) console.log(`v2 快照比对：${compared} 条 case · ${differences} 处差异`);
  let ok = results.every((r) => r.pass) && differences === 0;
  if (writeTarget && ok) {
    try {
      const content = await serializeSnapshot(createSnapshot(results));
      fs.mkdirSync(path.dirname(writeTarget), { recursive: true });
      fs.writeFileSync(writeTarget, content);
      console.log(`v2 快照已写入 ${writeTarget} · ${Buffer.byteLength(content)} 字节`);
    } catch (e) {
      console.error(`v2 快照写入失败：${e instanceof Error ? e.message : String(e)}`);
      ok = false;
    }
  }
  console.log(`v2 总耗时：${((performance.now() - started) / 1000).toFixed(2)}s`);
  const jsonIndex = process.argv.indexOf('--json');
  if (jsonIndex > 0) fs.writeFileSync(`${process.argv[jsonIndex + 1]}.v2.json`, JSON.stringify(results, null, 2));
  return ok;
}
