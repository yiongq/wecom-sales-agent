import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createCurrentMatcher, createMatcher, matchInMemory, type PartMatch } from '../../src/packs/industrial/match.js';
import { PartSchema, type Part } from '../../src/packs/industrial/catalog.js';
import { normalizePartNo } from '../../src/packs/industrial/normalize.js';
import type { PackSources } from '../../src/core/pack-api.js';
import { fakeEmbed, fakeCosine } from './fake-embed.js';
import { validateQueryCardinality, type Query } from './gen-queries.js';

export interface Observation {
  query: Query;
  result: PartMatch;
  ms: number;
  modelFallback: boolean;
}
export function metrics(rows: readonly Observation[]) {
  const labeled = rows.filter((row) => row.query.relevant.length > 0);
  // broad 仅参与 precision；无相关条目的查询不计截断 recall/MRR。
  const ranked = labeled.filter((row) => row.query.type !== 'broad');
  const hits = ({ query, result }: Observation) => result.parts.slice(0, 5).filter((part) => query.relevant.includes(part.id)).length;
  const fallback = rows.filter((row) => row.modelFallback);
  const wrong = fallback.filter(({ query, result }) =>
    result.parts.some((part) => !part.specs.some((spec) => normalizePartNo(spec).includes(normalizePartNo(query.text)))),
  );
  const times = rows.map((row) => row.ms).toSorted((a, b) => a - b);
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)] ?? 0;
  const counts = rows.map((row) => row.query.relevant.length).toSorted((a, b) => a - b);
  const middle = Math.floor(counts.length / 2);
  return {
    count: rows.length,
    labeled: labeled.length,
    rankedQueries: ranked.length,
    truncatedRecall5: ranked.length
      ? ranked.reduce((sum, row) => sum + hits(row) / Math.min(5, row.query.relevant.length), 0) / ranked.length
      : null,
    precision5: rows.length
      ? rows.reduce((sum, row) => sum + (row.result.parts.length ? hits(row) / row.result.parts.length : 0), 0) / rows.length
      : null,
    mrr5: ranked.length
      ? ranked.reduce((sum, { query, result }) => {
          const index = result.parts.slice(0, 5).findIndex((p) => query.relevant.includes(p.id));
          return sum + (index < 0 ? 0 : 1 / (index + 1));
        }, 0) / ranked.length
      : null,
    relevantCountMedian: counts.length ? (counts.length % 2 ? counts[middle]! : (counts[middle - 1]! + counts[middle]!) / 2) : null,
    relevantCountMax: counts.at(-1) ?? null,
    emptyRate: rows.length ? rows.filter((row) => !row.result.parts.length).length / rows.length : 0,
    wrongModelRate: fallback.length ? wrong.length / fallback.length : 0,
    modelFallbackQueries: fallback.length,
    wrongModelQueries: wrong.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}
export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
export async function runEvaluation(
  options: { matcher: 'current' | 'hybrid'; embed: 'fake' | 'real'; parts: Part[]; queries: Query[] },
  realProvider?: EmbeddingProvider,
) {
  validateQueryCardinality(options.queries);
  if (options.embed === 'real' && !realProvider) throw new Error('real 仅预留 EmbeddingProvider 接口；本任务不调用真实接口');
  const provider =
    options.embed === 'fake' ? { embed: async (texts: readonly string[]) => texts.map((text) => fakeEmbed(text)) } : realProvider!;
  // embedding 全部在计时外生成；匹配器内仍执行真实的候选余弦计算。
  // 先让调用者解析 JSON 的临时对象离开同步栈，避免把它们的回收抵扣成向量节省。
  await Promise.resolve();
  globalThis.gc?.();
  const vectorMemoryBefore = process.memoryUsage().heapUsed;
  const vectors = await provider.embed(
    options.parts.map((p) => [p.partNo, p.name, p.category, ...p.specs, ...(p.aliases ?? [])].join(' ')),
  );
  if (vectors.length !== options.parts.length) throw new Error('embedding 条数不符');
  const vectorById = new Map(options.parts.map((p, i) => [p.id, vectors[i]!]));
  globalThis.gc?.();
  const vectorIndexHeapDeltaBytes = process.memoryUsage().heapUsed - vectorMemoryBefore;
  const queryVectors = await provider.embed(options.queries.map((q) => q.text));
  if (queryVectors.length !== options.queries.length) throw new Error('embedding 条数不符');
  const vectorByQuery = new Map(options.queries.map((q, i) => [q.text, queryVectors[i]!]));
  const catalog = {
    tenantId: 'retrieval-eval',
    generation: 1,
    items: { part: options.parts },
    routes: [],
    hotels: [],
    versions: {},
  } as unknown as ReturnType<PackSources['currentCatalog']>;
  let embeddingCalls = 0;
  const sources = {
    currentCatalog: () => catalog,
    indexReady: () => true,
    semanticRecall: async (text: string, topK = 8) => {
      embeddingCalls++;
      return [...vectorById]
        .map(([id, vec]) => ({ id, score: fakeCosine(vectorByQuery.get(text)!, vec) }))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    semanticScores: async (text: string, ids: readonly string[]) => {
      embeddingCalls++;
      return new Map(
        ids.flatMap((id) => {
          const vec = vectorById.get(id);
          return vec ? [[id, fakeCosine(vectorByQuery.get(text)!, vec)] as const] : [];
        }),
      );
    },
  };
  globalThis.gc?.();
  const memoryBefore = process.memoryUsage().heapUsed;
  const matcher = options.matcher === 'current' ? createCurrentMatcher(sources) : createMatcher(sources);
  // 首次预热只用精确查询，构建关键词/属性索引；不包含在检索延迟里。
  if (options.parts[0]) await matcher(options.parts[0].partNo);
  globalThis.gc?.();
  const snapshotIndexHeapDeltaBytes = process.memoryUsage().heapUsed - memoryBefore;
  const indexHeapDeltaBytes = vectorIndexHeapDeltaBytes + snapshotIndexHeapDeltaBytes;
  const rows: Observation[] = [];
  for (const query of options.queries) {
    const scoped = options.parts.filter((part) => !query.category || query.category === part.category);
    const normalized = normalizePartNo(query.text);
    const modelFallback = /^[A-Z0-9×]+$/.test(normalized) && /\d/.test(normalized) && matchInMemory(query.text, scoped).match === 'none';
    const calls = embeddingCalls;
    const start = performance.now();
    const result = await matcher(query.text, query.category);
    rows.push({ query, result, ms: performance.now() - start, modelFallback });
    if (embeddingCalls - calls > 1) throw new Error(`每查询多于一次 embedding：${query.id}`);
  }
  return {
    metricVersion: 'truncated-recall-v2',
    matcher: options.matcher,
    embed: options.embed,
    catalogSize: options.parts.length,
    handwritten: options.queries.filter((q) => q.source === 'handwritten').length,
    dimensions: vectors[0]?.length ?? 0,
    vectorBytes: vectors.reduce((sum, v) => sum + v.length * 8, 0),
    indexHeapDeltaBytes,
    vectorIndexHeapDeltaBytes,
    snapshotIndexHeapDeltaBytes,
    gcAvailable: typeof globalThis.gc === 'function',
    runtime: `${process.version} ${process.platform}/${process.arch}`,
    memoryMethod:
      'GC heap deltas: catalog vectors + id map, plus matcher snapshot indexes; excludes input catalog and query vectors; without --expose-gc includes allocation noise',
    embeddingCalls,
    overall: metrics(rows),
    byType: Object.fromEntries(
      [...new Set(options.queries.map((q) => q.type))].map((type) => [type, metrics(rows.filter((row) => row.query.type === type))]),
    ),
  };
}
export function markdown(report: Awaited<ReturnType<typeof runEvaluation>>): string {
  const percent = (n: number | null) => (n === null ? 'N/A' : `${(100 * n).toFixed(2)}%`);
  const rows = Object.entries({ ...report.byType, overall: report.overall });
  return [
    `# 检索评测（${report.matcher} / ${report.embed}）`,
    '',
    `产品 ${report.catalogSize} 条，手写查询 ${report.handwritten} 条；假嵌入数字不能外推真实语义质量。`,
    '',
    '截断 recall@5 = 前5条相关数 / min(5, 相关条目数)；precision@5 = 前5条相关数 / 返回条数（返回0条记0）；逐查询计算后宏平均。broad 只计 precision，不计截断 recall/MRR；无相关条目不计截断 recall/MRR，但计 precision（0）和空结果率。误给型号率仅以走回退的纯型号查询为分母。延迟不含 embedding 和预热建索引。',
    '',
    '| 类型 | n | 相关数中位数 | 相关数最大值 | 截断 recall@5 | precision@5 | MRR@5 | 空结果率 | 误给型号率 | p50 ms | p95 ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(
      ([type, m]) =>
        `| ${type} | ${m.count} | ${m.relevantCountMedian} | ${m.relevantCountMax} | ${percent(m.truncatedRecall5)} | ${percent(m.precision5)} | ${percent(m.mrr5)} | ${percent(m.emptyRate)} | ${percent(m.wrongModelRate)} | ${m.p50Ms.toFixed(3)} | ${m.p95Ms.toFixed(3)} |`,
    ),
    '',
    `完整索引堆增量 ${report.indexHeapDeltaBytes} bytes（向量 ${report.vectorIndexHeapDeltaBytes}，快照派生索引 ${report.snapshotIndexHeapDeltaBytes}）；向量有效载荷 ${report.vectorBytes} bytes（${report.dimensions} 维 number[]，不含对象开销）。`,
    `内存口径：${report.memoryMethod}。`,
    '',
  ].join('\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(['--matcher', '--embed', '--catalog', '--queries', '--out']);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]!) || !args[i + 1] || values.has(args[i]!)) throw new Error('无效或重复 CLI 参数');
    values.set(args[i]!, args[i + 1]!);
  }
  const matcher = values.get('--matcher') ?? 'hybrid';
  const embed = values.get('--embed') ?? 'fake';
  if (matcher !== 'current' && matcher !== 'hybrid') throw new Error('--matcher 必须是 current|hybrid');
  if (embed !== 'fake' && embed !== 'real') throw new Error('--embed 必须是 fake|real');
  if (embed === 'real') throw new Error('real 仅预留 EmbeddingProvider 接口；需协调者另行装配并授权');
  const parts = (JSON.parse(fs.readFileSync(values.get('--catalog') ?? 'var/retrieval/catalog.json', 'utf8')) as unknown[]).map((part) =>
    PartSchema.parse(part),
  );
  const queries = JSON.parse(fs.readFileSync(values.get('--queries') ?? 'var/retrieval/queries.json', 'utf8')) as Query[];
  const report = await runEvaluation({ matcher, embed, parts, queries });
  const out = values.get('--out') ?? `var/retrieval/${matcher}.json`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(out.replace(/\.json$/, '') + '.md', markdown(report));
  console.log(markdown(report));
}
