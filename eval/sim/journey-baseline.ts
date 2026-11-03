// 16 R3：两个不出力的销售模型走真实引擎；只比较，不改场景标记。
import '../../src/selftest-env.js';
import { pathToFileURL } from 'node:url';
import { fakeEnv, fakePrices, fakeService, say } from './fake.js';
import { loadGoals, type SimGoal } from './goals.js';
import { JOURNEY_DIR } from './journey-split.js';
import { Meter, simulate, type RunResult } from './runner.js';
import { engineRuntime } from './runtime.js';

export async function journeyBaselines(goals: SimGoal[]): Promise<{ mode: string; passed: string[]; runs: RunResult[] }[]> {
  if (goals.some((g) => !g.journey)) throw new Error('基线只接受 journey 目标');
  const env = { ...process.env };
  const sales = await fakeService();
  const customer = await fakeService();
  try {
    fakeEnv(sales.url, customer.url);
    process.env.LLM_VISION_MODEL = 'sim-fake-sales';
    const meter = new Meter(100);
    const runtime = await engineRuntime(meter, 'sim-fake-customer', fakePrices, { configDir: 'data/packs/industrial' });
    // 禁止意外外联，包括环境里遗留的模型地址；假服务与 embedding 都在这两个本机地址。
    const runtimeFetch = globalThis.fetch;
    const allowed = new Set([new URL(sales.url).origin, new URL(customer.url).origin]);
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!allowed.has(url.origin)) throw new Error('baseline_external_request');
      return runtimeFetch(input, init);
    };
    try {
      const results = [];
      for (const [mode, content] of [
        ['empty', ''],
        ['platitude', '收到，我再看看。'],
      ]) {
        const runs: RunResult[] = [];
        for (const goal of goals) {
          sales.script.length = 0;
          customer.script.length = 0;
          sales.script.push(...Array.from({ length: 256 }, () => ({ content })));
          const script = goal.journey!.baselineScript;
          customer.script.push(...script.map((line, i) => say(line, i === script.length - 1)));
          // 附件仍走真实接收入口；其余客户台词全部由 baselineScript 提供。
          const baseline = {
            ...goal,
            customerScript: goal.customerScript?.filter((t) => typeof t === 'object'),
          };
          const report = await simulate([baseline], 1, meter, runtime.deps);
          const run = report.runs[0];
          if (!run || run.status === 'budget_stop' || run.status.startsWith('customer_') || run.endedBy === 'runner_error')
            throw new Error(`${mode}/${goal.id}: 基线执行失败 ${run?.status}/${run?.bucket}`);
          if (run.endedBy !== 'handoff' && customer.script.length) throw new Error(`${mode}/${goal.id}: 基线台词未全部发送`);
          runs.push(run);
        }
        results.push({
          mode: mode!,
          passed: runs
            .filter((r) => r.status === 'passed')
            .map((r) => r.goalId)
            .toSorted(),
          runs,
        });
      }
      return results;
    } finally {
      globalThis.fetch = runtimeFetch;
      await runtime.close();
    }
  } finally {
    await sales.close();
    await customer.close();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const goals = [...(await loadGoals(`${JOURNEY_DIR}/dev`)), ...(await loadGoals(`${JOURNEY_DIR}/holdout`))];
  for (const { mode, passed } of await journeyBaselines(goals)) console.log(`${mode}: ${JSON.stringify(passed)}`);
}
