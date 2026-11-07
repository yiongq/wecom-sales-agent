import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateCatalog } from './gen-catalog.js';
import { generateQueries, validateQueryCardinality, type Handwritten, type Query } from './gen-queries.js';
import { fakeEmbed, fakeCosine } from './fake-embed.js';
import { metrics, runEvaluation, markdown, parseCliArgs } from './run.js';
import { createRealProvider, loadEmbedEnv, EMBED_BATCH } from './real-embed.js';
const parts = generateCatalog(80);
assert.deepEqual(parts, generateCatalog(80));
assert.notDeepEqual(parts, generateCatalog(80, 123));
assert.equal(new Set(parts.map((p) => p.category)).size, 4);
assert.equal(new Set(parts.map((p) => p.name)).size, 8);
const hand = JSON.parse(fs.readFileSync(new URL('./queries.handwritten.json', import.meta.url), 'utf8')) as Handwritten[];
assert.ok(hand.length >= 60);
const full = generateQueries(generateCatalog(), hand);
assert.equal(new Set(full.map((q) => q.type)).size, 8);
assert.equal(full.filter((q) => q.source === 'handwritten').length, hand.length);
for (const type of ['attributes', 'descriptive', 'colloquial']) {
  const selected = full.filter((q) => q.type === type);
  assert.ok(selected.length >= 60, `${type} 保留原有量级`);
  assert.ok(selected.every((q) => q.relevant.length >= 1 && q.relevant.length <= 5));
  assert.ok(selected.some((q) => q.source === 'handwritten'));
}
assert.ok(full.filter((q) => q.type === 'broad').every((q) => q.relevant.length > 5));
// 小规模离线跑数；宽泛手写条件的基数按 5000 条库定义，已在 full 上核验。
const queries = generateQueries(
  parts,
  hand.filter((q) => q.type !== 'broad'),
  16,
);
assert.equal(new Set(queries.map((q) => q.type)).size, 8);
assert.deepEqual(full, generateQueries(generateCatalog(), hand));
assert.deepEqual(fakeEmbed('内径25mm'), fakeEmbed('内径25mm'));
assert.ok(Math.abs(fakeCosine(fakeEmbed('轴承'), fakeEmbed('轴承')) - 1) < 1e-12);
assert.equal(fakeCosine(fakeEmbed(''), fakeEmbed('')), 0);
assert.throws(() => fakeEmbed('a', 0));
const query: Query = { id: 'metric', source: 'generated', type: 'attributes', text: 'a', relevant: [parts[0]!.id, parts[1]!.id] };
const m = metrics([
  { query, result: { match: 'ambiguous', parts: [parts[2]!, parts[1]!] }, ms: 2, modelFallback: false },
  { query: { ...query, id: 'empty', relevant: [] }, result: { match: 'none', parts: [] }, ms: 8, modelFallback: false },
]);
assert.equal(m.truncatedRecall5, 0.5);
assert.equal(m.precision5, 0.25, '逐查询宏平均：1/2 和空返回0的平均');
assert.equal(m.mrr5, 0.5);
assert.equal(m.relevantCountMedian, 1);
assert.equal(m.relevantCountMax, 2);
assert.equal(m.emptyRate, 0.5);
assert.equal(m.p50Ms, 2);
assert.equal(m.p95Ms, 8);
const noResults = metrics([{ query, result: { match: 'none', parts: [] }, ms: 1, modelFallback: false }]);
assert.equal(noResults.truncatedRecall5, 0);
assert.equal(noResults.precision5, 0);
assert.equal(noResults.mrr5, 0);
// 算术独立校验 min(5,N)；实际查询文件会把 >5 的集合强制归入 broad。
const twenty = { ...query, type: 'prefix' as const, relevant: parts.slice(0, 20).map((p) => p.id) };
const five = { match: 'ambiguous' as const, parts: parts.slice(0, 5) };
assert.equal(metrics([{ query: twenty, result: five, ms: 1, modelFallback: false }]).truncatedRecall5, 1);
const broad = { ...twenty, type: 'broad' as const };
const wide = metrics([{ query: broad, result: five, ms: 1, modelFallback: false }]);
assert.equal(wide.truncatedRecall5, null);
assert.equal(wide.mrr5, null);
assert.equal(wide.precision5, 1);
assert.equal(wide.relevantCountMedian, 20);
assert.equal(wide.relevantCountMax, 20);
const mixed = metrics([
  { query, result: { match: 'ambiguous', parts: [parts[2]!, parts[1]!] }, ms: 2, modelFallback: false },
  { query: broad, result: five, ms: 1, modelFallback: false },
]);
assert.equal(mixed.truncatedRecall5, 0.5, 'broad 不混进截断 recall/MRR 汇总');
assert.equal(mixed.mrr5, 0.5);
assert.equal(mixed.precision5, 0.75);
assert.ok(!Object.hasOwn(mixed, 'recall5'), '报告不再暴露旧 recall 字段');
assert.throws(() => validateQueryCardinality([twenty]), /必须标 broad/);
assert.throws(() => validateQueryCardinality([{ ...query, relevant: [] }]), /1–5/);
assert.throws(() => validateQueryCardinality([{ ...query, type: 'broad' }]), /超过 5/);
await assert.rejects(runEvaluation({ matcher: 'hybrid', embed: 'fake', parts, queries: [twenty] }), /必须标 broad/);
const wrong = metrics([
  { query: { ...query, text: 'ZZZ999' }, result: { match: 'ambiguous', parts: [parts[0]!] }, ms: 1, modelFallback: true },
]);
assert.equal(wrong.wrongModelRate, 1);
assert.equal(metrics([]).truncatedRecall5, null);
assert.equal(metrics([]).precision5, null);
await assert.rejects(runEvaluation({ matcher: 'hybrid', embed: 'real', parts, queries }), /real 需要传入 EmbeddingProvider/);
function checkSources(report: Awaited<ReturnType<typeof runEvaluation>>) {
  assert.equal(report.bySource.generated.count, queries.filter((q) => q.source === 'generated').length);
  assert.equal(report.bySource.handwritten.count, queries.filter((q) => q.source === 'handwritten').length);
  assert.equal(report.bySource.generated.count + report.bySource.handwritten.count, report.overall.count);
  assert.equal(report.bySource.handwritten.count, report.handwritten);
  const handwritten = queries.filter((q) => q.source === 'handwritten');
  assert.deepEqual(Object.keys(report.handwrittenByType).toSorted(), [...new Set(handwritten.map((q) => q.type))].toSorted());
  for (const [type, m] of Object.entries(report.handwrittenByType)) {
    assert.equal(m.count, handwritten.filter((q) => q.type === type).length);
    assert.match(markdown(report), new RegExp(`\\| ${type} \\| ${m.count} \\|`));
  }
  assert.match(markdown(report), /## 手写查询子集/);
  assert.match(markdown(report), new RegExp(`\\| 合计 \\| ${handwritten.length} \\|`));
}
for (const matcher of ['current', 'hybrid'] as const) {
  const report = await runEvaluation({ matcher, embed: 'fake', parts, queries });
  assert.equal(report.overall.wrongModelRate, 0);
  assert.equal(report.byType.exact!.truncatedRecall5, 1);
  assert.equal(report.byType.alias!.truncatedRecall5, 1);
  assert.match(markdown(report), /recall@5/);
  assert.match(markdown(report), /假嵌入数字不能外推真实语义质量/);
  checkSources(report);
}

for (const option of ['--env-file', '--max-yuan', '--cache-dir']) {
  for (const prefix of [[], ['--embed', 'fake']]) assert.throws(() => parseCliArgs([...prefix, option, '1']), /仅允许用于 --embed real/);
}
const realOptions = parseCliArgs(['--embed', 'real']);
assert.equal(realOptions.maxYuan, 1);
assert.equal(realOptions.cacheDir, 'var/retrieval/embed-cache');
assert.equal(realOptions.envFile, undefined);
assert.equal(parseCliArgs(['--embed', 'real', '--max-yuan', '0']).maxYuan, 0);
const customOptions = parseCliArgs([
  '--embed',
  'real',
  '--matcher',
  'current',
  '--env-file',
  'embed.env',
  '--max-yuan',
  '0.25',
  '--cache-dir',
  'cache',
]);
assert.equal(customOptions.matcher, 'current');
assert.equal(customOptions.envFile, 'embed.env');
assert.equal(customOptions.maxYuan, 0.25);
assert.equal(customOptions.cacheDir, 'cache');
for (const value of ['no', 'NaN', 'Infinity', '-1', ' '])
  assert.throws(() => parseCliArgs(['--embed', 'real', '--max-yuan', value]), /非负有限数/);
for (const args of [['--env-file'], ['--embed', 'real', '--embed', 'fake'], ['--unknown', '1'], ['--env-file', '--embed', 'real']])
  assert.throws(() => parseCliArgs(args), /无效或重复/);

// 所有端点调用均注入假 fetch；只读本测试在临时目录创建的环境文件。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-real-'));
const envKeys = [
  'EMBED_BASE_URL',
  'EMBED_API_KEY',
  'EMBED_MODEL',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'ZHIPU_API_KEY',
  'ZHIPU_BASE_URL',
  'LLM_MOCK',
];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
try {
  const envFile = path.join(tmp, 'embed.env');
  fs.writeFileSync(
    envFile,
    [
      'EMBED_API_KEY=k1',
      'EMBED_MODEL=embedding-3',
      'EMBED_EXTRA=embed',
      'ZHIPU_API_KEY=k2',
      'ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4',
      'ZHIPU_EXTRA=zhipu',
      'LLM_PROVIDER=zhipu',
      'LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4',
      'LLM_API_KEY=k3',
      'DATABASE_URL=postgres://x',
      'WECOM_SECRET=s',
      'LLM_MODEL=ignored',
      'OTHER_EMBED_KEY=ignored',
    ].join('\n'),
  );
  const env: NodeJS.ProcessEnv = { ZHIPU_API_KEY: 'keep', EMBED_EXTRA: '' };
  assert.deepEqual(loadEmbedEnv(envFile, env), [
    'EMBED_API_KEY',
    'EMBED_MODEL',
    'LLM_API_KEY',
    'LLM_BASE_URL',
    'LLM_PROVIDER',
    'ZHIPU_BASE_URL',
    'ZHIPU_EXTRA',
  ]);
  assert.equal(env.ZHIPU_API_KEY, 'keep');
  assert.equal(env.EMBED_EXTRA, '');
  assert.equal(env.LLM_API_KEY, 'k3');
  for (const key of ['DATABASE_URL', 'WECOM_SECRET', 'LLM_MODEL', 'OTHER_EMBED_KEY']) assert.ok(!(key in env));
  assert.deepEqual(loadEmbedEnv(envFile, env), []);

  for (const key of envKeys) delete process.env[key];
  process.env.EMBED_API_KEY = 'test-key';
  let calls = 0;
  let failNext = 1;
  const sent: string[] = [];
  const batches: number[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/embeddings');
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    assert.ok(input.length > 0 && input.length <= EMBED_BATCH);
    if (failNext > 0) {
      failNext--;
      return new Response('busy', { status: 429 });
    }
    batches.push(input.length);
    sent.push(...input);
    const data = input.map((text, index) => ({ index, embedding: fakeEmbed(text, 32) })).reverse();
    return Response.json({ data, usage: { prompt_tokens: input.join('').length } });
  }) as unknown as typeof fetch;
  const cacheDir = path.join(tmp, 'cache');
  const p1 = createRealProvider({ cacheDir, maxYuan: 1, fetchImpl: fakeFetch, retryDelayMs: 1 });
  const texts = Array.from({ length: 130 }, (_, i) => `文本${i % 100}`);
  const v1 = await p1.embed(texts);
  assert.deepEqual(
    v1,
    texts.map((text) => fakeEmbed(text, 32)),
    '带 index 的逆序响应应排回原序，重复文本向量一致',
  );
  assert.equal(EMBED_BATCH, 64);
  assert.deepEqual(batches, [64, 36]);
  assert.equal(new Set(sent).size, 100);
  assert.equal(sent.length, 100, '不同文本各嵌入一次（429 重试除外）');
  assert.equal(p1.usage().embeddedTexts, 100);
  assert.equal(calls, 1 + Math.ceil(100 / EMBED_BATCH));
  assert.equal(p1.usage().requests, calls);
  assert.equal(p1.usage().promptTokens, sent.join('').length);
  assert.equal(p1.usage().yuan, (sent.join('').length * 0.5) / 1_000_000);
  assert.ok(!JSON.stringify(p1.usage()).includes('test-key'));
  const p2 = createRealProvider({ cacheDir, maxYuan: 1, fetchImpl: fakeFetch });
  const before = calls;
  assert.deepEqual(await p2.embed(texts), v1);
  assert.equal(calls, before);
  assert.equal(p2.usage().requests, 0);
  assert.equal(p2.usage().cachedTexts, 130);
  await assert.rejects(
    createRealProvider({ cacheDir: path.join(tmp, 'limit'), maxYuan: 0.000001, fetchImpl: fakeFetch }).embed(['很长'.repeat(50)]),
    /超过封顶/,
  );
  assert.equal(calls, before, '预估超封顶不发请求');
  process.env.EMBED_BASE_URL = 'https://evil.example/v4';
  assert.throws(() => createRealProvider({ cacheDir, maxYuan: 1, fetchImpl: fakeFetch }), /不在境内清单/);
  assert.equal(calls, before, '清单外主机不发请求');
  delete process.env.EMBED_BASE_URL;

  const p3 = createRealProvider({ cacheDir: path.join(tmp, 'evaluation'), maxYuan: 1, fetchImpl: fakeFetch });
  for (const matcher of ['current', 'hybrid'] as const) {
    const requestsBefore = calls;
    const report = await runEvaluation({ matcher, embed: 'real', parts, queries }, p3);
    assert.equal(report.embed, 'real');
    assert.equal(report.dimensions, 32);
    checkSources(report);
    const text = markdown({ ...report, embedUsage: p3.usage() });
    assert.match(text, /真实嵌入（模型 embedding-3），延迟不含查询嵌入的网络往返/);
    assert.ok(!text.includes('假嵌入数字'));
    if (matcher === 'hybrid') assert.equal(calls, requestsBefore, '另一匹配器复用向量');
  }
  assert.ok(p3.usage().cachedTexts > 0);
} finally {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(
  'RETRIEVAL EVAL PASS: 种子/Schema/四类八子类/唯一编号、64手写真值、定向1–5/broad分流、指标手算、来源与手写子集、CLI校验、env过滤、分批/去重/429/排序/缓存/封顶/端点、两种匹配器离线真实嵌入接线',
);
