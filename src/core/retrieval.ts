import { TenantLocal } from '../tenancy/local-state.js';
import { registerTenantState } from '../tenancy/state.js';
import { currentRuntime, tenantCallback, withoutTenantScope, TenantScopeMissing, type TenantRuntime } from '../tenancy/runtime.js';
// 线路语义召回。原先 目录搜索 是 String.includes 子串匹配，客户说
// 「不用倒时差、带娃能玩水」这类没有目的地关键词的需求直接搜不到东西——
// 而真实客户十有八九就是这么说话的。
//
// 这里用 embedding 把线路描述向量化后放内存做余弦相似度。几百条数据用不着向量数据库，
// 内存暴力检索 20 条 × 2048 维一次不到 1ms；上千条再考虑 hnswlib / pgvector。
// 索引在启动时异步构建，构建期间与构建失败时自动退回关键词匹配，不阻塞服务。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { llmCfg } from './llm/client.js';
import { recordUsage } from '../usage.js';
import { gatedFetch } from '../llm-gate.js';
import type { CatalogItem } from './pack-api.js';

export const RETRIEVAL_TIMEOUT_MS = 20_000;
import { configMode, currentCatalog, onCatalogChanged, currentPack } from '../config/source.js';

const VAR_DIR = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');
const cacheFile = () => path.join(VAR_DIR, currentPack().runtime.retrievalCacheFile);
const EMBED_MODEL = process.env.EMBED_MODEL || 'embedding-3';

interface Indexed {
  id: string;
  vec: readonly number[];
}
const indexes = new TenantLocal(
  () => ({
    index: null as readonly Indexed[] | null,
    building: null as Promise<void> | null,
    stale: false,
    indexGeneration: null as number | null,
    lastError: null as string | null,
    retryAttempt: 0,
    retryTimer: null as NodeJS.Timeout | null,
  }),
  (s) => {
    if (s.retryTimer) clearTimeout(s.retryTimer);
    s.retryTimer = null;
    s.index = null;
  },
);
const state = () => indexes.get();
// 内容相同才共用；只缓存成功的只读内容，不共享租户引用、代次或正在发的收费请求。
const shared = new Map<string, { items: readonly Indexed[]; owners: Set<TenantRuntime> }>();
function cacheShared(key: string, items: readonly Indexed[]): void {
  const owners = shared.get(key)?.owners ?? new Set<TenantRuntime>();
  owners.add(currentRuntime());
  shared.set(key, { items, owners });
}
registerTenantState({
  name: 'retrieval.shared',
  keyCount: (id) => [...shared.values()].filter((entry) => [...entry.owners].some((owner) => owner.id === id)).length,
  drop: (id) => {
    for (const [key, entry] of shared) {
      for (const owner of entry.owners) if (owner.id === id) entry.owners.delete(owner);
      if (!entry.owners.size) shared.delete(key);
    }
  },
  reset: () => shared.clear(),
});
const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000];
let retryBackoff = RETRY_BACKOFF_MS;

/**
 * embedding 的端点与 key。单独读 EMBED_BASE_URL / EMBED_API_KEY，不配时回落到**智谱**配置，
 * 而不是跟着主对话供应商走：EMBED_MODEL 默认的 embedding-3 是智谱的模型名，DeepSeek 也没有
 * /embeddings 接口。以前切到 LLM_PROVIDER=deepseek 后请求发到 api.deepseek.com/v1/embeddings，
 * 索引建不起来，没说目的地的需求全部退成「按价格升序的最便宜 3 条」，只留一行 warn。
 * 主供应商本来就是智谱（或旧写法三件套，默认也指向智谱）时沿用主配置，行为与以前一致。
 */
export function embedCfg(): { baseUrl: string; apiKey: string } {
  const p = (process.env.LLM_PROVIDER ?? '').toLowerCase();
  const fallback =
    p === 'zhipu' || !p
      ? llmCfg()
      : // 非智谱供应商时只认 ZHIPU_API_KEY：此时 LLM_API_KEY 多半是那家供应商的 key，发给智谱只会 401
        { baseUrl: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4', apiKey: process.env.ZHIPU_API_KEY || '' };
  return {
    baseUrl: (process.env.EMBED_BASE_URL || fallback.baseUrl).replace(/\/+$/, ''),
    apiKey: process.env.EMBED_API_KEY || fallback.apiKey,
  };
}

async function embed(texts: string[]): Promise<number[][] | null> {
  const rt = currentRuntime();
  const work = readEmbedding(texts);
  return rt.kind === 'sandbox' ? rt.inflight.track(work) : work;
}
async function readEmbedding(texts: string[]): Promise<number[][] | null> {
  const { baseUrl, apiKey } = embedCfg();
  if (!apiKey || process.env.LLM_MOCK === '1') return null;
  try {
    const { res, settleUsage } = await gatedFetch(
      baseUrl + '/embeddings',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      },
      () => AbortSignal.any([currentRuntime().cancel, AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS)]),
    );
    if (!res.ok) {
      console.error(`[retrieval] embedding 请求失败 ${res.status}，本次退回关键词匹配`);
      return null;
    }
    const d = (await res.json().catch((e) => {
      settleUsage(null);
      throw e;
    })) as {
      data?: { embedding: number[] }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    settleUsage(d);
    if (currentRuntime().state !== 'serving') throw new Error('tenant_closing');
    recordUsage(EMBED_MODEL, d.usage?.prompt_tokens ?? 0, d.usage?.completion_tokens ?? 0, undefined, 0, 0, 'embedding');
    return d.data?.map((x) => x.embedding) ?? null;
  } catch (e) {
    if (e instanceof TenantScopeMissing) throw e;
    if (currentRuntime().state !== 'serving') throw e;
    console.error('[retrieval] embedding 调用异常，本次退回关键词匹配:', e instanceof Error ? e.message : e);
    return null;
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 线路库内容指纹：内容变了就重建索引，避免改了产品还用旧向量。
 *  取内容哈希而不是字符数——「蜜月」改成「亲子」长度不变，按长度算指纹认不出来，
 *  会一直复用改前的向量，日志还只显示「命中缓存」，没人察觉索引已经陈旧。 */
function fingerprint(routes: CatalogItem[]): string {
  const body = routes.map((r) => r.code + '\u0000' + currentPack().runtime.retrievalText(r)).join('\u0001');
  return routes.length + ':' + createHash('sha1').update(body).digest('hex');
}

const snapshotGeneration = (): number => (configMode() === 'db' ? currentCatalog().generation : 0);

/** 缓存先写临时文件再 rename：写到一半进程被杀，留下的是旧缓存而不是半个 JSON */
function writeCache(fp: string, items: readonly Indexed[]): void {
  try {
    if (!currentRuntime().isHost || process.env.APP_ROLE === 'sandbox') return;
    fs.mkdirSync(VAR_DIR, { recursive: true });
    const tmp = `${cacheFile()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ fp, model: EMBED_MODEL, items }));
    fs.renameSync(tmp, cacheFile());
  } catch {
    /* 缓存写不进去只是下次要重算，不影响可用 */
  }
}

/** 按给定的线路建一次索引：先看磁盘缓存（键是整库内容指纹），再调 embedding。失败返回 null */
async function buildOnce(routes: CatalogItem[]): Promise<readonly Indexed[] | null> {
  const fp = fingerprint(routes);
  const key = `${EMBED_MODEL}:${fp}`;
  const rt = currentRuntime();
  const local = state();
  const cached = shared.get(key);
  cached?.owners.add(currentRuntime());
  const reusable = cached?.items;
  if (reusable) return reusable;
  if (rt.isHost && process.env.APP_ROLE !== 'sandbox') {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as { fp: string; model: string; items: readonly Indexed[] };
      if (cached.fp === fp && cached.model === EMBED_MODEL && cached.items?.length === routes.length) {
        console.log(`[retrieval] 语义索引命中缓存：${cached.items.length} 条线路`);
        const items = freezeIndex(cached.items);
        cacheShared(key, items);
        return items;
      }
    } catch {
      /* 无缓存或已失效，往下重建 */
    }
  }
  const vecs = await embed(routes.map((item) => currentPack().runtime.retrievalText(item)));
  if (!indexes.owns(rt, local) || !vecs || vecs.length !== routes.length) return null;
  const items = freezeIndex(routes.map((r, i) => ({ id: r.code, vec: vecs[i] })));
  cacheShared(key, items);
  if (shared.size > 64) shared.delete(shared.keys().next().value!);
  writeCache(fp, items);
  console.log(`[retrieval] 语义索引已构建：${items.length} 条线路 · ${EMBED_MODEL}`);
  return items;
}

function freezeIndex(items: readonly Indexed[]): readonly Indexed[] {
  return Object.freeze(items.map((item) => Object.freeze({ id: item.id, vec: Object.freeze([...item.vec]) })));
}

/** DB 模式下构建失败：保留过期标记，按 30 秒、2 分钟、10 分钟退避重试，之后每 10 分钟一次 */
function scheduleRetry(): void {
  if (state().retryTimer || configMode() !== 'db') return;
  const wait = retryBackoff[Math.min(state().retryAttempt, retryBackoff.length - 1)]!;
  state().retryAttempt++;
  const rt = currentRuntime();
  const local = state();
  local.retryTimer = withoutTenantScope(() =>
    setTimeout(
      tenantCallback(rt, () => {
        if (!indexes.owns(rt, local)) return;
        local.retryTimer = null;
        void buildIndex();
      }),
      wait,
    ),
  );
  state().retryTimer!.unref();
}

async function buildLoop(): Promise<void> {
  const rt = currentRuntime();
  const local = state();
  try {
    // 构建开始时记下快照的代际；结束时代际已经变了（期间又上架了条目），丢弃这次结果，按新快照再建
    for (;;) {
      const gen = snapshotGeneration();
      const items = await buildOnce(currentPack().runtime.retrievalItems());
      if (!indexes.owns(rt, local)) return;
      if (gen !== snapshotGeneration()) continue;
      if (!items) {
        state().lastError = 'embedding 请求失败';
        if (configMode() === 'db') state().stale = true;
        console.warn('[retrieval] 语义索引构建失败，目录搜索 退回关键词匹配');
        scheduleRetry();
        return;
      }
      state().index = items;
      state().indexGeneration = gen;
      state().stale = false;
      state().lastError = null;
      state().retryAttempt = 0;
      return;
    }
  } catch (e) {
    // 绝不能往外抛：调用方是启动流程里的 `void buildIndex()`，抛出去就是一个未捕获 rejection，Node 直接退出。
    // routes.json 手改坏一个逗号（高概率事故）会让容器进入无限重启，而本意是「退回关键词匹配继续服务」。
    if (e instanceof TenantScopeMissing) throw e;
    if (!indexes.owns(rt, local)) return;
    state().lastError = e instanceof Error ? e.message : String(e);
    console.error('[retrieval] ⚠️ 语义索引构建失败，目录搜索 退回关键词匹配:', state().lastError);
    scheduleRetry();
  }
}

/** 构建/加载索引。幂等，可重复调用；失败不抛错，只是让语义召回不可用。过期后再调用会全量重建 */
export function buildIndex(): Promise<void> {
  if (state().building) return state().building!;
  if (state().index && !state().stale) return Promise.resolve();
  // mock 不调任何外部接口，语义召回本来就不可用。以前照常走构建流程，然后打一行
  // 「语义索引构建失败」，看日志的人会以为 embedding 坏了
  if (process.env.LLM_MOCK === '1') {
    console.log('[retrieval] mock 模式跳过语义索引，目录搜索 走关键词匹配');
    return Promise.resolve();
  }
  if (!embedCfg().apiKey) {
    console.warn('[retrieval] ⚠️ 未配置 embedding 的 key（EMBED_API_KEY，或智谱的 ZHIPU_API_KEY），语义召回不可用，目录搜索 走关键词匹配');
    return Promise.resolve();
  }
  const rt = currentRuntime();
  const local = state();
  if (rt.state !== 'serving') return Promise.resolve();
  local.building = rt.inflight.track(
    buildLoop().finally(() => {
      if (indexes.owns(rt, local)) local.building = null;
    }),
  );
  return local.building;
}

/** 标记当前索引对应的产品库已过期，并安排一次重建。旧索引继续服务，直到新索引就绪。文件模式下什么都不做 */
export function invalidateIndex(): void {
  if (configMode() !== 'db') return;
  state().stale = true;
  if (state().retryTimer) clearTimeout(state().retryTimer!);
  state().retryTimer = null;
  state().retryAttempt = 0;
  void buildIndex();
}

export interface IndexHealth {
  /** 当前索引对应的快照代际；还没建成时为 null */
  indexGeneration: number | null;
  snapshotGeneration: number;
  /** 索引对应的不是当前快照（等待重建或重建失败） */
  stale: boolean;
  lastError: string | null;
}

/** 供 /status */
export function indexHealth(): IndexHealth {
  return {
    indexGeneration: state().indexGeneration,
    snapshotGeneration: snapshotGeneration(),
    stale: state().stale,
    lastError: state().lastError,
  };
}

// 产品库快照变了（后台上架、改了条目）：失效并重建。依赖方向只能是运行时模块 import 配置层，反过来由回调注册
withoutTenantScope(() => onCatalogChanged(() => invalidateIndex()));

/** 仅供自测：清空索引与状态，退避调短 */
export const __retrievalTest = {
  reset(): void {
    indexes.registration(() => 0).drop(currentRuntime().id);
    shared.clear();
    retryBackoff = RETRY_BACKOFF_MS;
  },
  setBackoff(ms: number[]): void {
    retryBackoff = ms;
  },
  indexIds: (): string[] => (state().index ?? []).map((i) => i.id),
};

export function indexReady(): boolean {
  return !!state().index?.length;
}

/**
 * 语义召回：返回按相似度降序的 routeId。
 * 索引未就绪或本次 embedding 失败时返回 null，调用方退回关键词匹配。
 */
export async function semanticRecall(query: string, topK = 8): Promise<{ id: string; score: number }[] | null> {
  const rt = currentRuntime();
  const local = state();
  const index = local.index;
  if (!index?.length || !query.trim() || rt.state !== 'serving') return null;
  const q = await rt.inflight.track(embed([query]));
  if (rt.state !== 'serving') throw new Error('tenant_closing');
  if (!indexes.owns(rt, local) || !q?.[0]) return null;
  return index
    .map((it) => ({ id: it.id, score: cosine(q[0], it.vec) }))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, topK);
}

registerTenantState({ name: 'retrieval.index', ...indexes.registration((s) => Number(s.index !== null)) });

registerTenantState({ name: 'retrieval.building', ...indexes.registration((s) => Number(s.building !== null)) });

registerTenantState({ name: 'retrieval.stale', ...indexes.registration((s) => Number(Boolean(s.stale))) });

registerTenantState({ name: 'retrieval.indexGeneration', ...indexes.registration((s) => Number(s.indexGeneration !== null)) });

registerTenantState({ name: 'retrieval.lastError', ...indexes.registration((s) => Number(s.lastError !== null)) });

registerTenantState({ name: 'retrieval.retryAttempt', ...indexes.registration((s) => Number(Boolean(s.retryAttempt))) });

registerTenantState({ name: 'retrieval.retryTimer', ...indexes.registration((s) => Number(s.retryTimer !== null)) });
