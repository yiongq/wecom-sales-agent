// 07 R13：DB 模式下线路向量以库为准（kb_chunks / kb_vectors），不再用 var/route-vectors.json。
// 一次同步 = 读库 → 按（source, ref, body_hash）对照产品库 → 只给缺向量的块发嵌入请求 → 一个事务写回 → 交出内存索引。
// 相似度仍在 retrieval.ts 里进程内算，这里不碰；整个过程在后台，不在处理一轮对话的路径上（02 不变量 9、07 不变量 14）。
// 无模块级状态：租户的索引、重试与失败记录都在 retrieval.ts 的 TenantLocal 里。
import { createHash } from 'node:crypto';
import { withTenant, type Db, type TenantCtx } from '../db/client.js';
import { KB_DIMENSIONS, readKbSnapshot, writeKbSync, type KbWrite } from '../db/repo/kb.js';

export interface KbEntry {
  /** 线路 id（kb_chunks.ref） */
  ref: string;
  /** retrievalText(item)：嵌入的正文 */
  body: string;
}
export interface KbIndexItem {
  id: string;
  vec: readonly number[];
}
export type KbSyncResult =
  /** 这个库里没有 kb_vectors（PGlite，或没装 vector 扩展）：调用方退回进程内建索引，不持久 */
  | { kind: 'unavailable' }
  /** 嵌入请求没成（或回包不对）；库里什么都没动 */
  | { kind: 'failed' }
  /** 租户已关闭或状态被换掉：丢弃这次结果 */
  | { kind: 'stopped' }
  | {
      kind: 'ready';
      /** 按产品库的顺序，只含有向量的线路 */
      items: KbIndexItem[];
      /** 这次发了嵌入请求的块数（0 = 全部来自库或来自 known） */
      embedded: number;
      /** 这次的新向量写进了库；维数不是 2048 时为 false（只在内存里用） */
      persisted: boolean;
    };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const systemCtx = (tenantId: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } });
const usable = (v: unknown): v is readonly number[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export async function syncKb(o: {
  db: Db;
  tenantId: string;
  model: string;
  entries: readonly KbEntry[];
  /**
   * 这个进程里已经算好的、与 entries 正文逐条相同的向量（线路 id → 向量）：同一份目录的另一个租户（沙箱）刚建过索引时用。
   * 缺向量的块先用它补，不再发嵌入请求；补上的照样写进这个租户自己的行
   */
  known?: ReadonlyMap<string, readonly number[]>;
  /** 只在真有缺的块时才调；回 null 表示请求没成 */
  embed(texts: string[]): Promise<number[][] | null>;
  /** 嵌入返回之后、写库之前再问一次：租户关了或状态被换掉就别写 */
  alive(): boolean;
}): Promise<KbSyncResult> {
  const ctx = systemCtx(o.tenantId);
  // 块与向量在同一个只读快照里读，和 05 R9 的沙箱复制同一个口径
  const snapshot = await withTenant(o.db, ctx, readKbSnapshot, { isolation: 'repeatable read', readOnly: true });
  if (snapshot.vectors === null) return { kind: 'unavailable' };

  const chunkByRef = new Map(snapshot.chunks.filter((c) => c.source === 'route').map((c) => [c.ref, c]));
  const vectorByChunk = new Map(snapshot.vectors.filter((v) => v.model === o.model).map((v) => [v.chunkId, v]));
  const wanted = new Set(o.entries.map((e) => e.ref));

  const have = new Map<string, readonly number[]>();
  const need: { entry: KbEntry; bodyHash: string }[] = [];
  for (const entry of o.entries) {
    const bodyHash = sha256(entry.body);
    const chunk = chunkByRef.get(entry.ref);
    const vector = chunk && chunk.bodyHash === bodyHash ? vectorByChunk.get(chunk.id) : undefined;
    if (vector && vector.bodyHash === bodyHash && usable(vector.embedding)) have.set(entry.ref, vector.embedding);
    else need.push({ entry, bodyHash });
  }
  const extra = [...chunkByRef.keys()].filter((ref) => !wanted.has(ref));

  const fresh = new Map<string, readonly number[]>();
  const missing: typeof need = [];
  for (const n of need) {
    const known = o.known?.get(n.entry.ref);
    if (usable(known)) fresh.set(n.entry.ref, known);
    else missing.push(n);
  }
  if (missing.length) {
    const vecs = await o.embed(missing.map((n) => n.entry.body));
    if (!vecs || vecs.length !== missing.length || !vecs.every(usable)) return { kind: 'failed' };
    missing.forEach((n, i) => fresh.set(n.entry.ref, vecs[i]!));
  }
  if (!o.alive()) return { kind: 'stopped' };

  // 维数不是列宽（halfvec(2048)）的向量写不进去：整批只留内存，和今天文件丢失时一样，不让一个配置问题挡住语义召回
  const persistable = [...fresh.values()].every((v) => v.length === KB_DIMENSIONS);
  if (!persistable)
    console.warn(`[retrieval] 嵌入向量的维数不是 ${KB_DIMENSIONS}（模型 ${o.model}），这次的向量只放内存、不写库；重启后会重新嵌入`);
  else if (need.length || extra.length) {
    const writes: KbWrite[] = need.map((n) => ({
      source: 'route',
      ref: n.entry.ref,
      body: n.entry.body,
      bodyHash: n.bodyHash,
      vector: [...fresh.get(n.entry.ref)!],
    }));
    await withTenant(o.db, ctx, (tx) => writeKbSync(tx, { model: o.model, keep: [...wanted], writes }));
  }

  const items = o.entries.flatMap((e) => {
    const vec = have.get(e.ref) ?? fresh.get(e.ref);
    return vec ? [{ id: e.ref, vec }] : [];
  });
  return { kind: 'ready', items, embedded: missing.length, persisted: persistable };
}
