// 回归评测回放器：把 eval/cases.json 里的对话在真实引擎上重跑一遍，逐条断言。
//
// 存在的意义：改了 SOP / 提示词 / 护栏之后，怎么知道没把别的地方弄坏？
// 靠人工点几下不算数——尤其这类系统的回归往往是「某个场景的话术悄悄退化了」，
// 不跑评测根本发现不了。
//
// 用法：
//   npx tsx eval/run.ts                 # 真实 LLM（默认，需配 key）
//   LLM_MOCK=1 npx tsx eval/run.ts      # 离线脚本，秒出结果，用于 CI 冒烟
//   npx tsx eval/run.ts --tags 护栏      # 只跑某类
//   npx tsx eval/run.ts --json out.json  # 结果落文件，便于跨版本对比
import '../src/env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 评测数据必须写进临时目录：store.ts 在模块加载时就取 VAR_DIR，静态 import 会先于
// 这行赋值执行——所以引擎相关模块一律动态 import（与 src/engine.selftest.ts 同一套做法）。
// 不隔离的话，跑一次 CI 冒烟就往真实 var/ 里灌 10 个假会话和一张假订单，
// 后台会话列表混进 sim-eval-*，GMV / 成交率也把假单算进去。
process.env.VAR_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-eval-'));

const { handleMessage, onToolCall } = await import('../src/engine.js');
const { getSession } = await import('../src/store.js');
const { buildIndex } = await import('../src/retrieval.js');
const { usageToday } = await import('../src/usage.js');

interface Turn {
  say: string;
  expectStage?: string;
  expectTool?: string;
  expectText?: string;
  denyText?: string;
  expectSilent?: boolean;
  expectStatus?: number;
  expectOrderCount?: number;
}
interface Case { id: string; desc: string; tags: string[]; turns: Turn[]; realOnly?: boolean }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')) as Case[];

const argv = process.argv.slice(2);
const tagFilter = argv.includes('--tags') ? argv[argv.indexOf('--tags') + 1] : null;
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const isMock = process.env.LLM_MOCK === '1';
// mock 是关键词脚本，做不了语义理解与工具选择——这类用例只在真实模型下跑，
// 在 CI 冒烟里跳过而不是让它们假失败（假失败会让人很快不再相信这套评测）
let selected = tagFilter ? cases.filter((c) => c.tags.includes(tagFilter)) : cases;
const skipped = isMock ? selected.filter((c) => c.realOnly).length : 0;
if (isMock) selected = selected.filter((c) => !c.realOnly);

// 工具调用记录：engine 内部不暴露，这里用 console.log 之外的方式拿不到，
// 改为从会话消息与订单变化间接判定，并用 executeTool 的包装捕获（见下）
const toolCalls: string[] = [];
const origLog = console.log;
console.log = () => {}; // 评测期间静音业务日志，只保留报告
const origErr = console.error;
console.error = () => {};

interface Failure { caseId: string; turn: number; say: string; why: string; got: string }
const failures: Failure[] = [];
let checks = 0;
const latencies: number[] = [];

function check(ok: boolean, c: Case, ti: number, t: Turn, why: string, got: string): void {
  checks += 1;
  if (!ok) failures.push({ caseId: c.id, turn: ti + 1, say: t.say, why, got: got.slice(0, 120) });
}

async function runCase(c: Case): Promise<boolean> {
  const sid = `sim-eval-${c.id}-${Date.now().toString(36)}`;
  let ok = true;
  const before = failures.length;
  for (let i = 0; i < c.turns.length; i++) {
    const t = c.turns[i];
    toolCalls.length = 0;
    const t0 = Date.now();
    let reply;
    try {
      reply = await handleMessage(sid, t.say, 'simulator');
    } catch (e) {
      check(false, c, i, t, '抛异常', e instanceof Error ? e.message : String(e));
      break;
    }
    latencies.push(Date.now() - t0);
    const text = reply.text ?? '';

    // expectStatus 的语义是「这轮不崩且有话可回」。此前 runner 根本不读这个字段，
    // 声明了它的用例（robust-01-gibberish）实际是零断言空过。
    if (t.expectStatus !== undefined) check(text.trim() !== '', c, i, t, '应有非空回复（不崩不哑）', text);
    if (t.expectStage) check(reply.stage === t.expectStage, c, i, t, `阶段应为 ${t.expectStage}`, String(reply.stage));
    if (t.expectSilent) check(text.trim() === '', c, i, t, '应静默不回复', text);
    if (t.expectText) check(new RegExp(t.expectText).test(text), c, i, t, `回复应匹配 /${t.expectText}/`, text);
    if (t.denyText) check(!new RegExp(t.denyText, 'm').test(text), c, i, t, `回复不应出现 /${t.denyText}/`, text);
    if (t.expectTool) check(toolCalls.includes(t.expectTool), c, i, t, `应调用工具 ${t.expectTool}`, toolCalls.join(',') || '(无)');
    if (t.expectOrderCount !== undefined) {
      const n = getSession(sid)?.orderIds.length ?? 0;
      check(n === t.expectOrderCount, c, i, t, `订单数应为 ${t.expectOrderCount}`, String(n));
    }
  }
  ok = failures.length === before;
  return ok;
}

// 订阅引擎的工具调用观测钩子，用于断言「这一轮该调的工具调了没」
onToolCall((name) => { toolCalls.push(name); });

await buildIndex();
const started = Date.now();
const results: { id: string; desc: string; tags: string[]; pass: boolean }[] = [];
for (const c of selected) {
  const pass = await runCase(c);
  results.push({ id: c.id, desc: c.desc, tags: c.tags, pass });
}

console.log = origLog;
console.error = origErr;

const passed = results.filter((r) => r.pass).length;
const byTag: Record<string, { pass: number; total: number }> = {};
for (const r of results) {
  for (const tag of r.tags) {
    const b = (byTag[tag] ??= { pass: 0, total: 0 });
    b.total += 1;
    if (r.pass) b.pass += 1;
  }
}
const sorted = [...latencies].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
const usage = usageToday();

console.log(`\n${'='.repeat(58)}`);
console.log(`回归评测：${passed}/${results.length} 用例通过${skipped ? `（mock 模式跳过 ${skipped} 条需真实模型的用例）` : ''} · ${checks} 项断言 · 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`响应延迟：P50 ${p50}ms · P95 ${p95}ms · 共 ${latencies.length} 轮`);
console.log(`模型成本：¥${usage.totalCny.toFixed(4)}（${usage.totalCalls} 次调用）`);
// 前缀缓存的验收位。命中率长期为 0 而调用量不小，说明 buildSystemPrompt 的可缓存前缀
// 又被什么东西截断了——这种退化不报错、只多花钱，没有这行数字就永远发现不了。
if (!isMock) {
  console.log(`前缀缓存：命中 ${(usage.cacheHitRate * 100).toFixed(1)}% 输入 token · 省下 ¥${usage.cacheSavedCny.toFixed(4)}`);
}
console.log('='.repeat(58));
for (const [tag, b] of Object.entries(byTag)) {
  console.log(`  ${b.pass === b.total ? '✓' : '✗'} ${tag.padEnd(8)} ${b.pass}/${b.total}`);
}
if (failures.length) {
  console.log(`\n失败明细（${failures.length} 项）:`);
  for (const f of failures) {
    console.log(`  ✗ [${f.caseId}] 第${f.turn}轮「${f.say.slice(0, 22)}」`);
    console.log(`      期望：${f.why}`);
    console.log(`      实际：${f.got.replace(/\n/g, ' ')}`);
  }
}
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    at: new Date().toISOString(), passed, total: results.length, checks,
    latencyP50: p50, latencyP95: p95, cost: usage.totalCny, results, failures,
  }, null, 2));
  console.log(`\n结果已写入 ${jsonOut}`);
}
process.exit(failures.length ? 1 : 0);
