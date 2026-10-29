import { z } from 'zod';
import type { PackSources, Session } from '../../core/pack-api.js';
import { MAX_QTY, PartSchema, type Part } from './catalog.js';

const safe = z.number().int().nonnegative();
const positive = safe.min(1);
const code = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const draftLine = z.discriminatedUnion('match', [
  z.strictObject({ match: z.literal('exact'), code, version: positive, qty: positive }),
  z.strictObject({ match: z.literal('ambiguous'), qty: positive }),
  z.strictObject({ match: z.literal('none'), qty: positive }),
]);
export const RfqDraftSchema = z.strictObject({ at: safe, lines: z.array(draftLine).max(30) });
export type RfqDraft = z.infer<typeof RfqDraftSchema>;
export const RfqIntakeSchema = z.strictObject({
  id: z.string().regex(/^int_[0-9a-f]{12}$/),
  at: safe,
  status: z.enum(['pending', 'confirmed', 'superseded']),
  lines: z
    .array(
      z.strictObject({
        q: z
          .string()
          .min(1)
          .max(32)
          .regex(/^[A-Za-z0-9 ×_/-]+$/)
          .refine((q) => !q.includes('//')),
        qty: positive.max(MAX_QTY).nullable(),
        m: z.enum(['exact', 'ambiguous', 'none', 'bad_qty']),
      }),
    )
    .max(30),
});
export type RfqIntake = z.infer<typeof RfqIntakeSchema>;
const CacheItem = z.strictObject({ partNo: z.string(), specs: z.array(z.string()) });
const MandatorySchema = z.strictObject({
  rfqDraft: RfqDraftSchema.optional(),
  rfqIntake: RfqIntakeSchema.optional(),
  lastQuoteId: z
    .string()
    .regex(/^ord_[0-9a-f]{24}$/)
    .optional(),
  confirmedQuoteAt: safe.optional(),
});
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const StateSchema = MandatorySchema.extend({ partsInPlay: z.array(CacheItem).max(100).optional() }).superRefine((state, ctx) => {
  const { partsInPlay: _cache, ...mandatory } = state;
  if (bytes(mandatory) > 8192 || bytes(state) > 10240) ctx.addIssue({ code: 'custom', message: '询价状态超出容量' });
});
export type IndustrialState = z.infer<typeof StateSchema>;
export const resetKeys = ['rfqDraft', 'rfqIntake', 'partsInPlay', 'lastQuoteId', 'confirmedQuoteAt'] as const;

/** 必留摘要先校验，缓存按插入顺序整项淘汰；失败不修改 session。 */
export function writeState(session: Session, patch: Partial<IndustrialState>, shown: readonly Pick<Part, 'partNo' | 'specs'>[] = []): void {
  const { partsInPlay: previous, ...mandatory } = { ...session.packState, ...patch };
  const required = MandatorySchema.parse(mandatory);
  if (bytes(required) > 8192) throw new Error('询价摘要超出容量');
  const cache = (previous === undefined ? [] : z.array(CacheItem).parse(previous)).slice();
  for (const { partNo, specs } of shown) {
    const old = cache.findIndex((item) => item.partNo === partNo);
    if (old >= 0) cache.splice(old, 1);
    cache.push({ partNo, specs: [...specs] });
  }
  const candidate = { ...required, ...(previous !== undefined || shown.length ? { partsInPlay: cache } : {}) };
  while (cache.length > 100 || bytes(candidate) > 10240) cache.shift();
  session.packState = StateSchema.parse(candidate);
}
export function readState(session: Session): IndustrialState {
  return StateSchema.parse(session.packState ?? {});
}
/** 历史读取失败时不编造型号；文件模式仅允许版本 1 的当前条目。 */
export function draftParts(session: Session, sources: Pick<PackSources, 'catalogItemAt' | 'configMode' | 'currentCatalog'>): Part[] {
  return (readState(session).rfqDraft?.lines ?? []).flatMap((line) => {
    if (line.match !== 'exact') return [];
    const raw =
      sources.catalogItemAt('part', line.code, line.version) ??
      (sources.configMode() === 'file' && line.version === 1
        ? sources.currentCatalog().items.part?.find((item) => (item as Record<string, unknown>).id === line.code)
        : undefined);
    const parsed = PartSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}
