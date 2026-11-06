/**
 * 18 R5 检索评测的真实嵌入。端点与 key 的解析（embedCfg）、境内端点清单、默认模型都和生产同一套，
 * 只是不走租户运行时与预算闸：按 64 条分批发、遇 429/5xx 重试、费用封顶，并按「模型 + 文本」哈希缓存到 var/，
 * 现状与混合两组匹配器共用同一份向量，第二组不再花钱。缓存用 Float64 存，读回的向量与接口返回的数值一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { embedCfg } from '../../src/core/retrieval.js';
import { embedEndpointAllowed, embedEndpointHost } from '../../src/core/llm/endpoints.js';
import { costOf } from '../../src/usage.js';
import type { EmbeddingProvider } from './run.js';

/** 嵌入只需要这些变量；env 文件里的数据库口令、渠道密钥一律不读进进程 */
const ENV_KEYS = /^(?:EMBED_[A-Z0-9_]+|ZHIPU_[A-Z0-9_]+|LLM_PROVIDER|LLM_BASE_URL|LLM_API_KEY)$/;
export const EMBED_BATCH = 64;

/** 从 env 文件读入嵌入要用的变量，已有的环境变量不覆盖。返回读入的变量名（不含值） */
export function loadEmbedEnv(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
    if (!ENV_KEYS.test(key) || key in env) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded.toSorted();
}

const textKey = (model: string, text: string) => createHash('sha256').update(model).update('\u0000').update(text).digest('hex');

function readCache(dir: string, model: string): Map<string, Float64Array> {
  const cache = new Map<string, Float64Array>();
  const indexFile = path.join(dir, 'index.json');
  if (!fs.existsSync(indexFile)) return cache;
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { model: string; dimensions: number; keys: string[] };
  if (index.model !== model) throw new Error(`缓存模型 ${index.model} 与本次 ${model} 不一致，换一个 --cache-dir`);
  const raw = fs.readFileSync(path.join(dir, 'vectors.f64'));
  const all = new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8);
  if (all.length !== index.keys.length * index.dimensions) throw new Error('缓存向量长度与索引不符');
  index.keys.forEach((key, i) => cache.set(key, all.slice(i * index.dimensions, (i + 1) * index.dimensions)));
  return cache;
}

function writeCache(dir: string, model: string, cache: ReadonlyMap<string, Float64Array>): void {
  const keys = [...cache.keys()];
  const dimensions = cache.get(keys[0]!)?.length ?? 0;
  const all = new Float64Array(keys.length * dimensions);
  keys.forEach((key, i) => all.set(cache.get(key)!, i * dimensions));
  fs.mkdirSync(dir, { recursive: true });
  // 先写临时文件再 rename：跑到一半被杀，留下的是上一份完整缓存
  for (const [name, body] of [
    ['vectors.f64', Buffer.from(all.buffer)],
    ['index.json', JSON.stringify({ model, dimensions, keys })],
  ] as const) {
    const tmp = path.join(dir, `${name}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path.join(dir, name));
  }
}

export interface RealEmbedUsage {
  model: string;
  host: string;
  requests: number;
  promptTokens: number;
  yuan: number;
  embeddedTexts: number;
  cachedTexts: number;
}

export function createRealProvider(options: {
  cacheDir: string;
  maxYuan: number;
  model?: string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}): EmbeddingProvider & { usage(): RealEmbedUsage } {
  const model = options.model ?? (process.env.EMBED_MODEL || 'embedding-3');
  const { baseUrl, apiKey } = embedCfg();
  // 和生产同一份清单：清单外的主机一律不发（07 R15）
  if (!embedEndpointAllowed(baseUrl)) throw new Error(`嵌入端点主机 ${embedEndpointHost(baseUrl)} 不在境内清单里，不发请求`);
  if (!apiKey) throw new Error('没有嵌入用的 key（EMBED_API_KEY / ZHIPU_API_KEY / LLM_API_KEY）');
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = readCache(options.cacheDir, model);
  const usage = { requests: 0, promptTokens: 0, embeddedTexts: 0, cachedTexts: 0 };
  const spent = () => costOf(model, usage.promptTokens, 0);

  async function request(input: readonly string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      usage.requests++;
      const res = await fetchImpl(baseUrl + '/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: { index?: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } };
        usage.promptTokens += body.usage?.prompt_tokens ?? 0;
        const data = body.data ?? [];
        if (data.length !== input.length) throw new Error(`嵌入条数不符：发 ${input.length} 条，收 ${data.length} 条`);
        const ordered = data.every((row) => typeof row.index === 'number') ? data.toSorted((a, b) => a.index! - b.index!) : data;
        return ordered.map((row) => row.embedding);
      }
      // 错误正文只留前 200 字：里面没有 key，但不想把整段响应写进日志
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      if (!(res.status === 429 || res.status >= 500) || attempt >= 4) throw new Error(`嵌入请求失败 ${res.status}：${detail}`);
      await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 2000) * 2 ** attempt));
    }
  }

  return {
    async embed(texts) {
      const keys = texts.map((text) => textKey(model, text));
      const todo = new Map<string, string>();
      keys.forEach((key, i) => {
        if (!cache.has(key)) todo.set(key, texts[i]!);
      });
      usage.cachedTexts += keys.filter((key) => !todo.has(key)).length;
      // 先按「一个字至少一个 token」粗估，超出封顶就一条都不发
      const estimate = costOf(
        model,
        [...todo.values()].reduce((sum, text) => sum + text.length, 0),
        0,
      );
      if (spent() + estimate > options.maxYuan)
        throw new Error(`预估费用 ¥${(spent() + estimate).toFixed(4)} 超过封顶 ¥${options.maxYuan}，不发请求`);
      const pending = [...todo];
      try {
        for (let i = 0; i < pending.length; i += EMBED_BATCH) {
          const batch = pending.slice(i, i + EMBED_BATCH);
          const vectors = await request(batch.map(([, text]) => text));
          batch.forEach(([key], j) => cache.set(key, Float64Array.from(vectors[j]!)));
          usage.embeddedTexts += batch.length;
          if (spent() > options.maxYuan) throw new Error(`实际费用 ¥${spent().toFixed(4)} 超过封顶 ¥${options.maxYuan}，停止`);
        }
      } finally {
        // 半路失败也把已付费的向量存下来，重跑不重复花钱
        if (todo.size && cache.size) writeCache(options.cacheDir, model, cache);
      }
      const dims = new Set(keys.map((key) => cache.get(key)!.length));
      if (dims.size > 1) throw new Error(`向量维度不一致：${[...dims].join('/')}`);
      return keys.map((key) => Array.from(cache.get(key)!));
    },
    usage: () => ({ model, host: embedEndpointHost(baseUrl), ...usage, yuan: spent() }),
  };
}
