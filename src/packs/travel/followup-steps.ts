// 04 R9：跟进独立的 11 步；同名护栏只删句，不使用主回复的副作用实现。
import { cleanText, convLabel, type FollowupGuardContext, type GuardStep, type StepVerdict } from '../../core/pack-api.js';
import { CUSTOM_PROMISE } from './itinerary.js';
import type { TravelReplyHelpers } from './reply-helpers.js';
import type { createTravelTurnHooks } from './turn.js';
import type { TravelPriceGuard } from './price-guard.js';
import type { createTravelPriceRules } from './price-rules.js';

export type { FollowupGuardContext } from '../../core/pack-api.js';

export interface TravelFollowupStepSources {
  helpers: Pick<
    TravelReplyHelpers,
    | 'allowedPayLinks'
    | 'whitelistLinks'
    | 'markLinkHoles'
    | 'HOLE'
    | 'SITE_LINK'
    | 'promiseInsertAt'
    | 'dropLinkPromise'
    | 'tidyLinkText'
    | 'HOLE_WITH_SPACE'
    | 'ANY_HOLE'
    | 'keptBesideCustomPromise'
    | 'saysTransfer'
    | 'dropTransferClaims'
    | 'transferSentences'
    | 'DEFER_TO_CONSULTANT'
    | 'promisesContact'
  >;
  turnHooks: Pick<ReturnType<typeof createTravelTurnHooks>, 'neutralizeStandardDays' | 'travelersKnown'>;
  priceGuard: Pick<TravelPriceGuard, 'findUnbackedPriceHits' | 'dropSentences' | 'strandedAfterDrop'>;
  priceRules: Pick<ReturnType<typeof createTravelPriceRules>, 'dropUnbackedClaims'>;
  dejargon(text: string, sessionId: string): string;
  stripMarkdown(text: string): string;
  trimDangling(text: string): string;
  stripAdvisorPrefix(text: string): string;
}

export function travelFollowupSteps(sources: TravelFollowupStepSources): GuardStep<FollowupGuardContext>[] {
  const { helpers: h, turnHooks, priceGuard, priceRules } = sources;
  // 这里只给执行器返回裁决；旧 guard_events 仍在原位置按文字变化记录。
  const step = (
    id: string,
    after: string,
    run: (ctx: FollowupGuardContext) => void,
    action: 'strip' | 'replace' | 'drop_sentence',
    reads: string[] = [],
    writes: string[] = [],
  ): GuardStep<FollowupGuardContext> => ({
    id,
    after: after ? [after] : [],
    reads,
    writes,
    run(ctx): StepVerdict {
      const before = ctx.text;
      run(ctx);
      return ctx.text === before ? { action: 'pass' } : { action, text: ctx.text };
    },
  });
  return [
    step(
      'pre_clean',
      '',
      (ctx) => {
        ctx.text = cleanText(ctx.text);
      },
      'strip',
    ),
    step(
      'link_whitelist',
      'pre_clean',
      (ctx) => {
        const before = ctx.text;
        ctx.text = h.whitelistLinks(ctx.text, h.allowedPayLinks(ctx.session), () => false);
        ctx.recordGuard('link_whitelist', before, ctx.text, 'strip');
      },
      'strip',
    ),
    step(
      'markdown',
      'link_whitelist',
      (ctx) => {
        const before = ctx.text;
        ctx.text = sources.stripMarkdown(ctx.text);
        ctx.recordGuard('markdown', before, ctx.text, 'strip');
      },
      'strip',
    ),
    step(
      'repair_links',
      'markdown',
      (ctx) => {
        const before = ctx.text;
        ctx.text = h.markLinkHoles(ctx.text);
        for (const kind of ['pay', 'proposal'] as const) {
          if (ctx.text.includes(h.HOLE[kind]) || (!h.SITE_LINK.test(ctx.text) && h.promiseInsertAt(ctx.text, kind) >= 0)) {
            ctx.text = h.dropLinkPromise(ctx.text, kind, h.HOLE[kind]);
          }
        }
        ctx.text = h.tidyLinkText(ctx.text.replace(h.HOLE_WITH_SPACE, ''));
        ctx.recordGuard('repair_links', before, ctx.text, 'drop_sentence');
      },
      'drop_sentence',
    ),
    step(
      'dejargon',
      'repair_links',
      (ctx) => {
        const before = ctx.text;
        ctx.text = sources.dejargon(ctx.text, ctx.session.id);
        ctx.recordGuard('dejargon', before, ctx.text, 'replace');
      },
      'replace',
    ),
    step(
      'custom_promise',
      'dejargon',
      (ctx) => {
        const before = ctx.text;
        ctx.text = turnHooks.neutralizeStandardDays(ctx.text, ctx.session, []);
        if (CUSTOM_PROMISE.test(ctx.text)) ctx.text = h.keptBesideCustomPromise(ctx.text);
        ctx.recordGuard('custom_promise', before, ctx.text, 'drop_sentence');
      },
      'drop_sentence',
    ),
    step(
      'handoff_claims',
      'custom_promise',
      (ctx) => {
        // a 转接、b 顾问确认/联系依次执行；两次改写事件保留，不记待办。
        if (h.saysTransfer(ctx.text, ctx.session)) {
          const before = ctx.text;
          ctx.text = h.dropTransferClaims(ctx.text, ctx.session);
          ctx.recordGuard('handoff_claims', before, ctx.text, 'drop_sentence');
        }
        const deferred = h.transferSentences(ctx.text);
        if (deferred.some((s) => h.DEFER_TO_CONSULTANT.test(s) || h.promisesContact(s, ctx.session))) {
          const before = ctx.text;
          ctx.text = h.tidyLinkText(deferred.filter((s) => !h.DEFER_TO_CONSULTANT.test(s) && !h.promisesContact(s, ctx.session)).join(''));
          ctx.recordGuard('handoff_claims', before, ctx.text, 'drop_sentence');
        }
      },
      'drop_sentence',
    ),
    step(
      'unbacked_claims',
      'handoff_claims',
      (ctx) => {
        ctx.turn.flags.preDropSnapshot = ctx.text;
        const saidAll = ctx.session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
        ctx.turn.flags.saidAll = saidAll;
        const claims = priceRules.dropUnbackedClaims(ctx.text, ctx.session, [], {
          travelers: turnHooks.travelersKnown(ctx.session, saidAll),
        });
        if (claims.text !== ctx.text) {
          ctx.recordGuard('unbacked_claims', ctx.text, claims.text, 'drop_sentence');
          ctx.text = claims.text;
        }
      },
      'drop_sentence',
      [],
      ['preDropSnapshot', 'saidAll'],
    ),
    step(
      'price',
      'unbacked_claims',
      (ctx) => {
        const unbacked = priceGuard.findUnbackedPriceHits(ctx.text, ctx.session, '', []);
        if (unbacked.length) {
          console.error(`[engine] ⚠️ 跟进话术里有无出处的金额，删掉那几句（会话 ${convLabel(ctx.session.id)}）`);
          const before = ctx.text;
          ctx.text = priceGuard.dropSentences(ctx.text, unbacked).text;
          ctx.recordGuard('price', before, ctx.text, 'drop_sentence');
        }
      },
      'drop_sentence',
    ),
    step(
      'stranded',
      'price',
      (ctx) => {
        if (priceGuard.strandedAfterDrop(ctx.turn.flags.preDropSnapshot!, ctx.text)) ctx.text = '';
        ctx.text = sources.trimDangling(ctx.text);
      },
      'strip',
      ['preDropSnapshot'],
    ),
    step(
      'final_clean',
      'stranded',
      (ctx) => {
        ctx.text = sources.stripAdvisorPrefix(cleanText(ctx.text.replace(h.ANY_HOLE, ''))).trim();
      },
      'strip',
    ),
  ];
}
