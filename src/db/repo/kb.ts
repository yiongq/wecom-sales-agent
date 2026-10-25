// 知识库块与向量的数据访问（07 spec R11–R13）。相似度不在这里算：装载时读进内存，每轮对话不查库。
// kb_chunks 在所有库里都有；kb_vectors 只在 vector 扩展已装的库里有（迁移 0016 的 DO 块），PGlite 上没有——
// 所以每个会碰向量的函数都先问 kbVectorsInstalled，没有就按「没有向量」处理，绝不去查这张表。
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { kbChunks, kbVectors } from '../schema.js';

/** 列宽写死在迁移里（halfvec(2048)，ADR-001 决策 6）：智谱 embedding-3 的默认维数 */
export const KB_DIMENSIONS = 2048;
export type KbSource = (typeof kbChunks.$inferSelect)['source'];

export interface KbChunkRow {
  id: string;
  source: KbSource;
  ref: string;
  body: string;
  bodyHash: string;
}
export interface KbVectorRow {
  chunkId: string;
  model: string;
  bodyHash: string;
  embedding: number[];
}
export interface KbSnapshot {
  chunks: KbChunkRow[];
  /** null：这个库里没有 kb_vectors（PGlite），不是「一条都没有」 */
  vectors: KbVectorRow[] | null;
}

/** 库里有没有 kb_vectors。to_regclass 对不存在的表返回 NULL，不报错 */
export async function kbVectorsInstalled(tx: Tx): Promise<boolean> {
  const [row] = rowsOf<{ ok: boolean }>(await tx.execute(sql`select to_regclass('public.kb_vectors') is not null as ok`));
  return row?.ok === true;
}

const chunkColumns = {
  id: kbChunks.id,
  source: kbChunks.source,
  ref: kbChunks.ref,
  body: kbChunks.body,
  bodyHash: kbChunks.bodyHash,
};

/** 这个租户的全部块与向量（RLS 已按租户过滤）。同一个事务里读，调用方要快照一致就自己开 repeatable read */
export async function readKbSnapshot(tx: Tx): Promise<KbSnapshot> {
  const chunks = await tx.select(chunkColumns).from(kbChunks).orderBy(kbChunks.source, kbChunks.ref);
  if (!(await kbVectorsInstalled(tx))) return { chunks, vectors: null };
  const vectors = await tx
    .select({ chunkId: kbVectors.chunkId, model: kbVectors.model, bodyHash: kbVectors.bodyHash, embedding: kbVectors.embedding })
    .from(kbVectors);
  return { chunks, vectors };
}

/** 一块要写的内容：正文、哈希和按这份正文算出来的向量（2048 维，调用方已核过维数） */
export interface KbWrite {
  source: KbSource;
  ref: string;
  body: string;
  bodyHash: string;
  vector: number[];
}

/**
 * 一次同步的全部写入，调用方放在同一个事务里：
 * ① 删掉 source 下不在 keep 里的块（产品库里已经没有的条目；kb_vectors 随外键级联）
 * ② 逐块 upsert：身份是（source, ref），正文变了就换 body_hash；块变了它名下旧正文的向量作废，先删掉
 * ③ 写向量：（块, 模型）一行；别的模型的向量是上一代模型留下的，一并清掉
 * kb_vectors 不在时只写块（调用方不会走到这里，守一道）
 */
export async function writeKbSync(
  tx: Tx,
  o: { source: KbSource; model: string; keep: readonly string[]; writes: readonly KbWrite[] },
): Promise<void> {
  const { tenantId } = currentTenantCtx();
  const installed = await kbVectorsInstalled(tx);
  const gone = o.keep.length ? and(eq(kbChunks.source, o.source), notInArray(kbChunks.ref, [...o.keep])) : eq(kbChunks.source, o.source);
  await tx.delete(kbChunks).where(gone);
  for (let i = 0; i < o.writes.length; i += 50) {
    const batch = o.writes.slice(i, i + 50);
    const saved = await tx
      .insert(kbChunks)
      .values(batch.map((w) => ({ tenantId, source: w.source, ref: w.ref, body: w.body, bodyHash: w.bodyHash })))
      .onConflictDoUpdate({
        target: [kbChunks.tenantId, kbChunks.source, kbChunks.ref],
        set: { body: sql`excluded.body`, bodyHash: sql`excluded.body_hash` },
      })
      .returning({ id: kbChunks.id, source: kbChunks.source, ref: kbChunks.ref });
    if (!installed) continue;
    const ids = new Map(saved.map((c) => [JSON.stringify([c.source, c.ref]), c.id]));
    // 正文变了的块，旧向量的 body_hash 对不上；这里统一先删，再写这一批的新向量
    await tx.delete(kbVectors).where(inArray(kbVectors.chunkId, [...ids.values()]));
    const rows = batch.flatMap((w) => {
      const chunkId = ids.get(JSON.stringify([w.source, w.ref]));
      return chunkId ? [{ tenantId, chunkId, model: o.model, bodyHash: w.bodyHash, embedding: w.vector }] : [];
    });
    if (rows.length) await tx.insert(kbVectors).values(rows);
  }
  if (installed) await tx.delete(kbVectors).where(ne(kbVectors.model, o.model));
}

/**
 * 沙箱开通：把宿主的块与向量按原样复制到当前租户（05 R9 的同一个只读快照读出来的）。块 id 沿用——主键是（tenant_id, id），
 * 不会和宿主撞，向量的外键也就不用换 id。当前库没有 kb_vectors 时 snapshot.vectors 是 null，只复制块
 */
export async function copyKbSnapshot(tx: Tx, snapshot: KbSnapshot): Promise<void> {
  if (!snapshot.chunks.length) return;
  const { tenantId } = currentTenantCtx();
  const installed = await kbVectorsInstalled(tx);
  for (let i = 0; i < snapshot.chunks.length; i += 50) {
    await tx.insert(kbChunks).values(snapshot.chunks.slice(i, i + 50).map((c) => ({ ...c, tenantId })));
  }
  if (!installed || !snapshot.vectors?.length) return;
  for (let i = 0; i < snapshot.vectors.length; i += 50) {
    await tx.insert(kbVectors).values(snapshot.vectors.slice(i, i + 50).map((v) => ({ ...v, tenantId })));
  }
}
