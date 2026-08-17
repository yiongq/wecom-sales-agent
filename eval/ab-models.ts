// 模型横评：只测一条指标——**客户说了目的地，AI 有没有立刻摆出真实线路**。
//
// 为什么单独拎出这一条：SOP 里它被标注为「最重要的一条」，也是唯一一条把
// glm-5.2 和 glm-4.5-air 拉开差距的指标（12/12 vs 4/12）。护栏、不编价这些
// 两边都全过，因为那是代码在挡、与模型强弱无关；能不能主动摆线路才是模型的活。
//
// 这个脚本存在的直接原因：README 的模型表里 glm-4.6 / glm-4.7 写着「未做 A/B，
// 仅测过延迟」——而它们单价是 5.2 的一半、延迟也只有一半。中间整档是空的，
// 当初只在两端各测了一次就定了型。这里把这一格补上。
//
// 用法：
//   npx tsx eval/ab-models.ts --dry                        # 只看计划和预估花费，不发请求
//   npx tsx eval/ab-models.ts                              # 跑默认四档
//   npx tsx eval/ab-models.ts --models glm-4.6,glm-4.7 --runs 6
//   npx tsx eval/ab-models.ts --json ab.json               # 结果落文件
import '../src/env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 与 eval/run.ts 同一套隔离：store.ts 在模块加载时就取 VAR_DIR，所以必须先赋值再动态 import。
// 不隔离的话，跑一次横评就往真实 var/ 里灌几十个假会话，后台会话列表和 GMV 全被污染。
process.env.VAR_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-ab-'));

const { handleMessage, onToolCall } = await import('../src/engine.js');
const { buildIndex } = await import('../src/retrieval.js');
const { usageToday, costOf } = await import('../src/usage.js');
const { loadRoutes, toolDefs } = await import('../src/tools.js');

const argv = process.argv.slice(2);
const arg = (name: string): string | null => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? null : null);

// 默认四档 = README 表里已有 A/B 的两端 + 从未做过 A/B 的中间档。
// 保留两端是因为横评必须自带基准：只跑中间档，拿到 10/12 也不知道该不该换。
const MODELS = (arg('--models') ?? 'glm-5.2,glm-4.7,glm-4.6,glm-4.5-air').split(',').map((s) => s.trim()).filter(Boolean);
// 12 次/目的地，沿用 README 里那次 A/B 的口径，否则两次结论没法直接比
const RUNS = Number(arg('--runs') ?? 12);
// 默认串行。并发会把延迟数据打乱（请求在网关排队的时间也算进单轮延迟里），
// 而延迟正是当初选错模型的理由，这次必须测准。只关心命中率时再开并发。
const CONCURRENCY = Math.max(1, Number(arg('--concurrency') ?? 1));
const jsonOut = arg('--json');
const dry = argv.includes('--dry');

// 用真实的主力目的地，且四个都要有对应线路——问一个库里没有的地方，
// 模型答不出线路是正确行为，测出来的就不是模型差距了
const QUERIES = ['想去四川', '想去云南', '想去新疆', '想去西藏'];

/**
 * 「摆出真实线路」的判据：回复里出现了产品库中该目的地某条线路的专有名词。
 *
 * 不能只看「调没调 search_routes」——实测存在工具调了、线路也查到了，但回复被模型
 * 的知识层覆盖成一段地理百科的情况（engine.ts 的百科护栏就是为它加的）。
 * 客户看到的是回复，不是工具调用记录，所以判据必须落在回复文本上。
 */
// SOP 正文。判据词必须从这里排除掉——见 markersOf 里的说明。
const SOP = fs.readFileSync(process.env.SOP_PATH ?? path.join(process.cwd(), 'data', 'sop.md'), 'utf8');

function markersOf(dest: string): string[] {
  const out = new Set<string>();
  for (const r of loadRoutes()) {
    if (r.destination !== dest) continue;
    out.add(r.title);
    // 「四川 稻城亚丁·色达秘境 8 日」→ 去掉目的地与「N 日…」尾巴 → 按 · 切成专有名词
    const core = r.title.replace(r.destination, '').replace(/\s*\d+\s*[日天].*$/, '').trim();
    for (const seg of core.split(/[·\s]+/)) if (seg.length >= 2) out.add(seg);
  }
  // 排除 SOP 里出现过的词——这条是第一版漏掉的，直接把结论带偏了。
  // sop.md 的话术示例里写着「稻城亚丁」，于是模型不查库、只回一句
  // 「四川好地方！九寨沟、稻城亚丁…您这次几位出行？」也被判成「摆出了线路」，
  // 而这恰恰是本指标要抓的空手反问。glm-5.2 因此虚高了 8 个点（36/48 记成 44/48）。
  //
  // 判据词只能是「不查产品库就说不出来」的信息。SOP 会改，所以这里每次运行时算，
  // 不写死排除名单。
  return [...out].filter((m) => !SOP.includes(m));
}

// 引擎百科护栏兜底时会用这句开头重写回复（见 engine.ts 的 deterministicRecommend）。
// 这类命中要单独记：客户确实看到了线路，但那是代码救回来的，不是模型自己做对的。
// 混在一起算会让弱模型看起来和强模型一样好，而真换上去就会在护栏覆盖不到的地方翻车。
const RESCUED_PREFIX = /是我们的主力目的地，给您挑了这些：/;

interface Trial { model: string; query: string; hit: boolean; rescued: boolean; calledTool: boolean; ms: number; reply: string }

const toolCalls: string[] = [];
onToolCall((name) => { toolCalls.push(name); });

async function trial(model: string, query: string, i: number): Promise<Trial> {
  const dest = query.replace(/^想去/, '');
  // 每次都开全新会话——测的是「首轮」，复用会话等于让模型带着上一轮的上下文作弊
  const sid = `sim-ab-${model}-${dest}-${i}-${Date.now().toString(36)}`;
  toolCalls.length = 0;
  const t0 = Date.now();
  let reply = '';
  try {
    reply = (await handleMessage(sid, query, 'simulator')).text ?? '';
  } catch (e) {
    reply = `[异常] ${e instanceof Error ? e.message : String(e)}`;
  }
  const ms = Date.now() - t0;
  const markers = markersOf(dest);
  return {
    model, query, ms, reply,
    hit: markers.some((m) => reply.includes(m)),
    rescued: RESCUED_PREFIX.test(reply),
    calledTool: toolCalls.some((n) => n === 'search_routes' || n === 'get_route_detail'),
  };
}

/** 按 CONCURRENCY 分批跑，批内并发、批间串行 */
async function runAll(model: string): Promise<Trial[]> {
  const jobs: (() => Promise<Trial>)[] = [];
  for (const q of QUERIES) for (let i = 0; i < RUNS; i++) jobs.push(() => trial(model, q, i));
  const out: Trial[] = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(jobs.slice(i, i + CONCURRENCY).map((f) => f()))));
    process.stdout.write(`\r  ${model}: ${out.length}/${jobs.length}   `);
  }
  process.stdout.write('\r' + ' '.repeat(48) + '\r');
  return out;
}

const total = MODELS.length * QUERIES.length * RUNS;
console.log(`\n模型横评：${MODELS.length} 个模型 × ${QUERIES.length} 个目的地 × ${RUNS} 次 = ${total} 次调用`);
console.log(`模型：${MODELS.join(' · ')}`);
console.log(`并发：${CONCURRENCY}${CONCURRENCY > 1 ? '（延迟数据仅供参考，排队时间会算进单轮耗时）' : '（串行，延迟可比）'}`);
if (dry) {
  // 花钱之前先看量级。这是**上界**：按全价算（不计前缀缓存折扣），且假设每轮只有
  // 一次 API 往返。模型多调一轮工具就多一次往返，所以别当账单看，只用来判断
  // 「这次横评是几块钱还是几百块」。
  const sopChars = fs.readFileSync(path.join(process.cwd(), 'data', 'sop.md'), 'utf8').length;
  // 中文约 1.6 字符/token；工具 schema 是中英混排的 JSON，约 2.5 字符/token
  const inTok = Math.round((sopChars + 1100) / 1.6 + JSON.stringify(toolDefs).length / 2.5);
  const per = QUERIES.length * RUNS;
  console.log(`\n单轮输入约 ${inTok} token（SOP + 硬性要求 + 工具定义），按全价粗估上界：`);
  for (const m of MODELS) console.log(`  ${m.padEnd(16)}¥${(costOf(m, inTok, 200) * per).toFixed(2)}`);
  console.log(`  ${'合计'.padEnd(14)}¥${MODELS.reduce((a, m) => a + costOf(m, inTok, 200) * per, 0).toFixed(2)}`);
  console.log('\n实际会低于这个数：前缀缓存命中的部分按 25% 计费。');
  console.log('--dry：未发出任何请求。去掉 --dry 开跑。\n');
  process.exit(0);
}
if (process.env.LLM_MOCK === '1') {
  console.error('\n✗ LLM_MOCK=1 下所有模型走的是同一段离线脚本，横评没有意义。请配好 key 后重跑。\n');
  process.exit(1);
}

await buildIndex();

const rows: { model: string; hit: number; native: number; rescued: number; tool: number; p50: number; p50Tool: number; cny: number }[] = [];
const allTrials: Trial[] = [];
for (const model of MODELS) {
  // llmCfg 每次调用都重读 env，所以逐个模型改 env 就能切换。三个变量全设：
  // 设了 LLM_PROVIDER 时读的是 ZHIPU_MODEL / DEEPSEEK_MODEL，只改 LLM_MODEL 会静默不生效，
  // 结果就是四档跑出四个几乎一样的数，而且看不出哪里错了。
  process.env.LLM_MODEL = model;
  process.env.ZHIPU_MODEL = model;
  process.env.DEEPSEEK_MODEL = model;
  const before = usageToday().byModel[model]?.cny ?? 0;
  const trials = await runAll(model);
  allTrials.push(...trials);
  const after = usageToday().byModel[model]?.cny ?? 0;
  const p50 = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.5)] ?? 0;
  rows.push({
    model,
    hit: trials.filter((t) => t.hit).length,
    native: trials.filter((t) => t.hit && !t.rescued).length,
    rescued: trials.filter((t) => t.rescued).length,
    tool: trials.filter((t) => t.calledTool).length,
    p50: p50(trials.map((t) => t.ms)),
    // 只统计真调了工具那些轮的延迟。不这么切的话延迟对比是假的：不调工具的轮次
    // 少一次 API 往返，天然快一大截，于是**越偷懒的模型看起来越快**。
    // 实测 glm-5.2 有 14/48 轮没调工具，全部混在一起算 P50 就是 4042ms，
    // 只看真干活的轮次是 4856ms——跟老实调工具的 glm-4.6 差距从 1.7s 缩到 0.9s。
    p50Tool: p50(trials.filter((t) => t.calledTool).map((t) => t.ms)),
    cny: after - before,
  });
}

const n = QUERIES.length * RUNS;
console.log(`\n${'='.repeat(76)}`);
console.log(`说了目的地就摆出真实线路（每档 ${n} 次 = ${QUERIES.length} 个目的地 × ${RUNS} 次）`);
console.log('='.repeat(76));
console.log('模型'.padEnd(16) + '端到端'.padEnd(10) + '模型自己'.padEnd(11) + '护栏兜底'.padEnd(11)
  + '调了工具'.padEnd(11) + 'P50'.padEnd(9) + 'P50(干活轮)'.padEnd(13) + '成本');
for (const r of rows) {
  console.log(
    r.model.padEnd(16)
    + `${r.hit}/${n}`.padEnd(10)
    + `${r.native}/${n}`.padEnd(11)
    + `${r.rescued}`.padEnd(11)
    + `${r.tool}/${n}`.padEnd(11)
    + `${r.p50}ms`.padEnd(9)
    + `${r.p50Tool}ms`.padEnd(13)
    + `¥${r.cny.toFixed(4)}`,
  );
}
const u = usageToday();
console.log('='.repeat(76));
console.log(`前缀缓存：命中 ${(u.cacheHitRate * 100).toFixed(1)}% 输入 token · 省下 ¥${u.cacheSavedCny.toFixed(4)}`);
console.log('\n「模型自己」才是选型该看的数：端到端里减掉护栏兜底的部分。');
console.log('护栏只在认得出的形态上兜得住，换到它覆盖不到的场景，弱模型会原形毕露。\n');

// 未命中的原话样本：光看数字不知道弱在哪，看两句就明白了（多半是空手反问）
const misses = allTrials.filter((t) => !t.hit);
if (misses.length) {
  console.log(`未摆线路的回复样本（共 ${misses.length} 次，抽 5 条）：`);
  for (const m of misses.slice(0, 5)) {
    console.log(`  [${m.model}]「${m.query}」→ ${m.reply.replace(/\n/g, ' ').slice(0, 60)}`);
  }
  console.log();
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    at: new Date().toISOString(), runs: RUNS, queries: QUERIES, concurrency: CONCURRENCY,
    rows, cacheHitRate: u.cacheHitRate, trials: allTrials,
  }, null, 2));
  console.log(`结果已写入 ${jsonOut}\n`);
}
