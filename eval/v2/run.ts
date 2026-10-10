import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCases, type CaseV2 } from './schema.js';

export interface CaseResult {
  id: string;
  pass: boolean;
  checks: number;
  guardSkipped: number;
  failures: string[];
  turns?: unknown[];
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

export async function runV2(cases: CaseV2[]): Promise<boolean> {
  const tagIndex = process.argv.indexOf('--tags');
  const selected = tagIndex > 0 ? cases.filter((c) => c.tags.includes(process.argv[tagIndex + 1])) : cases;
  const skipped = selected.filter((c) => c.realOnly).length;
  const results: CaseResult[] = [];
  for (const c of selected.filter((c) => !c.realOnly)) {
    const result = await runCaseV2(c);
    results.push(result);
    console.log(`  ${result.pass ? '✓' : '✗'} v2 [${c.id}]`);
    for (const failure of result.failures) console.log(`    ${failure}`);
  }
  console.log(
    `v2 回归评测：${results.filter((r) => r.pass).length}/${results.length} 用例通过 · 跳过 ${skipped} 条 realOnly · ` +
      `${results.reduce((n, r) => n + r.checks, 0)} 项断言 · guardVerdicts 跳过 ${results.reduce((n, r) => n + r.guardSkipped, 0)} 项（待第 16 步）`,
  );
  const jsonIndex = process.argv.indexOf('--json');
  if (jsonIndex > 0) fs.writeFileSync(`${process.argv[jsonIndex + 1]}.v2.json`, JSON.stringify(results, null, 2));
  return results.every((r) => r.pass);
}
