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
//   npx tsx eval/ab-models.ts --models glm-5.3-flashx --hedge glm-5.2 --hedge-ms 4000   # 测「主模型 + 对冲」组合
import '../src/env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 与 eval/run.ts 同一套隔离：store.ts 在模块加载时就取 VAR_DIR，所以必须先赋值再动态 import。
// 不隔离的话，跑一次横评就往真实 var/ 里灌几十个假会话，后台会话列表和 GMV 全被污染。
process.env.VAR_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-ab-'));

const argv = process.argv.slice(2);
const arg = (name: string): string | null => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? null : null);

// 横评默认测的是**单个模型本身**，必须关掉对冲。.env 里开了 LLM_HEDGE_MODEL 的话：被测模型的慢请求被
// 对冲模型接走，P50 和尾延迟都被压低；那几轮回复是对冲模型写的，命中却记在被测模型头上；花费记进
// 对冲模型名下，成本栏就偏低；被测模型恰好是对冲模型时对冲又不生效，
// 各行的测量条件都不一样——选型结论被悄悄带偏。env.ts 只补缺失的变量，这里置空就挡得住 .env
//
// 只有显式传 --hedge 才开：那时测的是「主模型 + 对冲」这套线上组合本身，不再是单个模型。
// 为此下面的统计都按组合口径算——成本含对冲模型那份，每轮记下加发/胜出次数，输出里单列。
const HEDGE = arg('--hedge');
const HEDGE_MS = arg('--hedge-ms');
if (HEDGE?.startsWith('--') || (HEDGE_MS !== null && (!HEDGE || !Number.isFinite(Number(HEDGE_MS)) || Number(HEDGE_MS) < 0))) {
  // 单给 --hedge-ms 不开对冲；--hedge 漏了模型名会把下一个参数当模型；数字填错 llm.ts 会静默回退默认 6000。
  // 都是「以为测了 A，其实测的 B」
  console.error('\n✗ --hedge-ms 须与 --hedge 同时给，且是非负毫秒数，例如 --hedge glm-5.2 --hedge-ms 4000\n');
  process.exit(1);
}
process.env.LLM_HEDGE_MODEL = HEDGE ?? '';
if (HEDGE_MS !== null) process.env.LLM_HEDGE_MS = HEDGE_MS;

const { handleMessage, onToolCall } = await import('../src/engine.js');
const { buildIndex } = await import('../src/retrieval.js');
const { usageToday, costOf } = await import('../src/usage.js');
const { loadRoutes, toolDefs } = await import('../src/tools.js');
const { llmStats } = await import('../src/llm.js');

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

interface Trial {
  model: string; query: string; hit: boolean; rescued: boolean; calledTool: boolean; prefetched: boolean; ms: number; reply: string;
  /** 这一轮里对冲加发了几次、对冲模型赢了几次（一轮可能有多次 API 往返，每次都可能对冲） */
  hedgeFired: number; hedgeWon: number;
}

// 引擎预取（engine.ts planPrefetch）会在调模型之前替它查一次库，观测钩子带 meta.prefetch 标记。
// 这类调用必须剔掉：否则每轮都记成「模型调了工具」，这一列就成了引擎的成绩。
// 开了预取以后，端到端命中主要反映「模型会不会用好已经查到的线路」，不再是「会不会想到去查」；
// 模型在预取之后还自己再查一遍，只是白多一次往返。
const toolCalls: { name: string; prefetch: boolean }[] = [];
onToolCall((name, _args, _sid, meta) => { toolCalls.push({ name, prefetch: !!meta?.prefetch }); });

async function trial(model: string, query: string, i: number): Promise<Trial> {
  const dest = query.replace(/^想去/, '');
  // 每次都开全新会话——测的是「首轮」，复用会话等于让模型带着上一轮的上下文作弊
  const sid = `sim-ab-${model}-${dest}-${i}-${Date.now().toString(36)}`;
  toolCalls.length = 0;
  const h0 = llmStats();
  const t0 = Date.now();
  let reply = '';
  try {
    reply = (await handleMessage(sid, query, 'simulator')).text ?? '';
  } catch (e) {
    reply = `[异常] ${e instanceof Error ? e.message : String(e)}`;
  }
  const ms = Date.now() - t0;
  const h1 = llmStats();
  const markers = markersOf(dest);
  return {
    model, query, ms, reply,
    hedgeFired: h1.hedgeFired - h0.hedgeFired,
    hedgeWon: h1.hedgeWon - h0.hedgeWon,
    hit: markers.some((m) => reply.includes(m)),
    rescued: RESCUED_PREFIX.test(reply),
    calledTool: toolCalls.some((t) => !t.prefetch && (t.name === 'search_routes' || t.name === 'get_route_detail')),
    prefetched: toolCalls.some((t) => t.prefetch),
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
  console.log('\n实际会低于这个数：前缀缓存命中的部分按各模型自己的缓存单价计费（src/usage.ts 的 PRICE）。');
  if (HEDGE) console.log(`开了对冲（${HEDGE}）：上界不含对冲加发的请求，慢请求越多多花越多；被 abort 的那一方供应商照样计费、本地记不到。`);
  console.log('--dry：未发出任何请求。去掉 --dry 开跑。\n');
  process.exit(0);
}
if (process.env.LLM_MOCK === '1') {
  console.error('\n✗ LLM_MOCK=1 下所有模型走的是同一段离线脚本，横评没有意义。请配好 key 后重跑。\n');
  process.exit(1);
}

await buildIndex();

interface Row {
  model: string; hit: number; native: number; rescued: number; tool: number; prefetched: number;
  p50: number; p90: number; over8s: number; max: number; p50Tool: number;
  /** 本行实际生效的对冲模型；没开、或与被测模型同款（llm.ts 不对冲自己）时为 null */
  hedge: string | null; hedgeFired: number; hedgeWon: number; hedgeCny: number;
  /** 发生过对冲的轮数（一轮多次往返可能加发多次，按轮算才能和超 8 秒占比对照） */
  hedgedTurns: number;
  /** 本行输入 token 里命中前缀缓存的占比 */
  cacheHitRate: number;
  cny: number;
}
const rows: Row[] = [];
const allTrials: Trial[] = [];
const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
// 单轮 8 秒是硬线：微信客服里客户等 8 秒以上就以为没人在（选型史见 src/llm.ts DEFAULT_MAIN_MODEL）。
// P50 只说明平时快不快，选型卡的是尾巴，所以超线占比和最坏值必须和 P50 摆在一起
const SLOW_MS = 8000;
for (const model of MODELS) {
  // llmCfg 每次调用都重读 env，所以逐个模型改 env 就能切换。三个变量全设：
  // 设了 LLM_PROVIDER 时读的是 ZHIPU_MODEL / DEEPSEEK_MODEL，只改 LLM_MODEL 会静默不生效，
  // 结果就是四档跑出四个几乎一样的数，而且看不出哪里错了。
  process.env.LLM_MODEL = model;
  process.env.ZHIPU_MODEL = model;
  process.env.DEEPSEEK_MODEL = model;
  const hedge = llmStats().hedgeModel;
  // 成本按**全部模型**取差：开了对冲时，对冲胜出那几次的花费记在对冲模型名下，只取被测模型那份会偏低
  const before = usageToday().byModel;
  const trials = await runAll(model);
  allTrials.push(...trials);
  const after = usageToday().byModel;
  const delta = (k: 'cny' | 'promptTokens' | 'cachedTokens', m?: string): number => Object.keys(after)
    .filter((x) => !m || x === m)
    .reduce((a, x) => a + (after[x][k] ?? 0) - (before[x]?.[k] ?? 0), 0);
  const ms = trials.map((t) => t.ms);
  rows.push({
    model,
    hit: trials.filter((t) => t.hit).length,
    native: trials.filter((t) => t.hit && !t.rescued).length,
    rescued: trials.filter((t) => t.rescued).length,
    tool: trials.filter((t) => t.calledTool).length,
    prefetched: trials.filter((t) => t.prefetched).length,
    p50: pct(ms, 0.5),
    p90: pct(ms, 0.9),
    over8s: ms.filter((x) => x > SLOW_MS).length,
    max: Math.max(0, ...ms),
    // 只统计真调了工具那些轮的延迟。不这么切的话延迟对比是假的：不调工具的轮次
    // 少一次 API 往返，天然快一大截，于是**越偷懒的模型看起来越快**。
    // 实测 glm-5.2 有 14/48 轮没调工具，全部混在一起算 P50 就是 4042ms，
    // 只看真干活的轮次是 4856ms——跟老实调工具的 glm-4.6 差距从 1.7s 缩到 0.9s。
    p50Tool: pct(trials.filter((t) => t.calledTool).map((t) => t.ms), 0.5),
    hedge,
    hedgeFired: trials.reduce((a, t) => a + t.hedgeFired, 0),
    hedgeWon: trials.reduce((a, t) => a + t.hedgeWon, 0),
    hedgedTurns: trials.filter((t) => t.hedgeFired > 0).length,
    hedgeCny: hedge ? delta('cny', hedge) : 0,
    cacheHitRate: delta('promptTokens') ? delta('cachedTokens') / delta('promptTokens') : 0,
    cny: delta('cny'),
  });
}

const n = QUERIES.length * RUNS;
const pctOf = (k: number): string => `${((k / n) * 100).toFixed(1)}%`;
console.log(`\n${'='.repeat(76)}`);
console.log(`说了目的地就摆出真实线路（每档 ${n} 次 = ${QUERIES.length} 个目的地 × ${RUNS} 次）`);
console.log('='.repeat(76));
console.log('模型'.padEnd(16) + '端到端'.padEnd(10) + '模型自己'.padEnd(11) + '护栏兜底'.padEnd(11)
  + '调了工具'.padEnd(11) + '引擎预取'.padEnd(11) + '成本');
for (const r of rows) {
  console.log(
    r.model.padEnd(16)
    + `${r.hit}/${n}`.padEnd(10)
    + `${r.native}/${n}`.padEnd(11)
    + `${r.rescued}`.padEnd(11)
    + `${r.tool}/${n}`.padEnd(11)
    + `${r.prefetched}/${n}`.padEnd(11)
    + `¥${r.cny.toFixed(4)}`,
  );
}
console.log('-'.repeat(76));
console.log(`单轮端到端耗时（客户发出到收到回复，超 ${SLOW_MS / 1000} 秒算超线）`);
console.log('模型'.padEnd(16) + 'P50'.padEnd(9) + 'P90'.padEnd(9) + '超8秒'.padEnd(13) + '最大'.padEnd(9)
  + 'P50(干活轮)'.padEnd(13) + '缓存命中');
for (const r of rows) {
  console.log(
    r.model.padEnd(16)
    + `${r.p50}ms`.padEnd(9)
    + `${r.p90}ms`.padEnd(9)
    + `${r.over8s} (${pctOf(r.over8s)})`.padEnd(14)
    + `${r.max}ms`.padEnd(9)
    + `${r.p50Tool}ms`.padEnd(13)
    + `${(r.cacheHitRate * 100).toFixed(1)}%`,
  );
}
const u = usageToday();
console.log('='.repeat(76));
console.log(`前缀缓存：命中 ${(u.cacheHitRate * 100).toFixed(1)}% 输入 token · 省下 ¥${u.cacheSavedCny.toFixed(4)}`);
console.log('「调了工具」只算模型自己额外发起的；「引擎预取」是代码替它查的，不算模型的成绩。');
if (HEDGE) {
  const h = llmStats();
  console.log(`对冲：${HEDGE}（主模型单次请求超 ${h.hedgeMs}ms 加发）——以下各行的延迟、命中与成本都是「主模型 + 对冲」组合的数`);
  for (const r of rows) {
    console.log(r.hedge
      ? `  ${r.model.padEnd(16)}加发 ${r.hedgeFired} 次（${r.hedgedTurns}/${n} 轮）· 对冲胜出 ${r.hedgeWon} 次 · 记在对冲模型名下 ¥${r.hedgeCny.toFixed(4)}（已含在成本栏）`
      : `  ${r.model.padEnd(16)}与对冲模型同款，本行未对冲`);
  }
  // 输家被 abort 前生成的 token 供应商照样计费，但响应拿不到，usage 里没有这笔——成本栏是下界
  console.log('  被取消的那一方（输家）供应商照样计费、本地记不到，开对冲时成本栏是下界。');
}
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
    hedge: HEDGE, hedgeMs: HEDGE ? llmStats().hedgeMs : null, reasoningEffort: llmStats().reasoningEffort,
    rows, cacheHitRate: u.cacheHitRate, trials: allTrials,
  }, null, 2));
  console.log(`结果已写入 ${jsonOut}\n`);
}
