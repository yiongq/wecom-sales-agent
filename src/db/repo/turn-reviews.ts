// 17 R2：可评谓词只在此定义；评分与审计由调用方的同一个 withTenant 事务提交。
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { currentTenantCtx, rowsOf, type Tx } from '../client.js';
import { turnReviews } from '../schema.js';
import { writeAudit } from './audit.js';
import { readConsoleMembers } from './console-settings.js';
import type { ReviewReason, TurnReviewInput, TurnReviewView } from '../../shared/console-api.js';

export class ReviewError extends Error {
  constructor(public readonly code: 'not_found' | 'review_not_applicable' | 'review_conflict' | 'store_unavailable') {
    super(code);
  }
}

/** t 为 turn_traces 别名；EXISTS 让分段消息仍然只算一轮。 */
export function reviewableSql(): SQL {
  return sql`(coalesce(t.final_text, '') <> '' and t.outcome not in ('silent','reset') and exists (
  select 1 from messages m where m.tenant_id=t.tenant_id and m.conversation_id=t.conversation_id
  and m.turn_id=t.id and m.role='agent' and (m.author is null or m.author='ai')))`;
}

export const isTurnId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** 草稿专用白名单：连可评谓词都不执行，完全不访问 trace 正文列。 */
export async function readRegressionReason(tx: Tx, turnId: string): Promise<ReviewReason> {
  if (!isTurnId(turnId)) throw new ReviewError('not_found');
  const [row] = rowsOf<{ rating: string | null; reason: ReviewReason | null }>(
    await tx.execute(sql`select r.rating, r.reason from turn_traces t
      left join turn_reviews r on r.tenant_id=t.tenant_id and r.turn_id=t.id
      where t.id=${turnId}::uuid`),
  );
  if (!row) throw new ReviewError('not_found');
  if (row.rating !== 'bad' || !row.reason) throw new ReviewError('review_not_applicable');
  return row.reason;
}

/** 评分与详情只投影可评布尔值，不返回用于判定的正文。 */
export async function readReviewState(tx: Tx, turnId: string) {
  if (!isTurnId(turnId)) throw new ReviewError('not_found');
  const [turn] = rowsOf<{ conversationId: string; channel: string; reviewable: boolean }>(
    await tx.execute(sql`select t.conversation_id as "conversationId", c.channel, ${reviewableSql()} as reviewable
      from turn_traces t join conversations c on c.tenant_id=t.tenant_id and c.id=t.conversation_id
      where t.id=${turnId}::uuid`),
  );
  if (!turn) throw new ReviewError('not_found');
  const [review] = await tx.select().from(turnReviews).where(eq(turnReviews.turnId, turnId));
  return { ...turn, review: review ?? null };
}

export async function reviewView(
  tx: Tx,
  review: NonNullable<Awaited<ReturnType<typeof readReviewState>>['review']>,
  tokenHash: string,
): Promise<TurnReviewView> {
  const member = (await readConsoleMembers(tx, tokenHash)).find((m) => m.userId === review.reviewerUserId && !m.disabled);
  return {
    rating: review.rating,
    reason: review.reason,
    revision: review.revision,
    updatedAt: review.updatedAt.toISOString(),
    reviewer: member?.displayName ?? '已移除成员',
  };
}

export async function putTurnReview(tx: Tx, turnId: string, body: TurnReviewInput, tokenHash: string): Promise<TurnReviewView> {
  const state = await readReviewState(tx, turnId);
  if (!state.reviewable) throw new ReviewError('review_not_applicable');
  const { tenantId, actor } = currentTenantCtx();
  if (!actor.userId) throw new ReviewError('review_not_applicable');
  const values = { rating: body.rating, reason: body.reason, reviewerUserId: actor.userId };
  const [written] =
    body.expectedRevision === 0
      ? await tx
          .insert(turnReviews)
          .values({ tenantId, turnId, ...values })
          .onConflictDoNothing()
          .returning()
      : await tx
          .update(turnReviews)
          .set({ ...values, revision: sql`${turnReviews.revision} + 1`, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(turnReviews.turnId, turnId), eq(turnReviews.revision, body.expectedRevision)))
          .returning();
  if (!written) {
    const { review } = await readReviewState(tx, turnId);
    if (
      review &&
      review.revision === body.expectedRevision + 1 &&
      review.reviewerUserId === actor.userId &&
      review.rating === body.rating &&
      review.reason === body.reason
    )
      return reviewView(tx, review, tokenHash);
    throw new ReviewError('review_conflict');
  }
  await writeAudit(tx, { action: 'trace.review', diff: { rating: written.rating, reason: written.reason, revision: written.revision } });
  return reviewView(tx, written, tokenHash);
}
