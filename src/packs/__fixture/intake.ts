// 12 R5：只在附件自测中显式装配，不改变现有证明场景。
import type { PackRuntime } from '../../core/pack-api.js';

export function withFixtureIntake(base: PackRuntime, receive?: NonNullable<PackRuntime['intake']>['receive']): PackRuntime {
  return {
    ...base,
    intake: {
      classes: ['image', 'sheet'],
      receive:
        receive ??
        (async (ctx, kit) => {
          const result = await kit.sheet();
          kit.saveResult(result, 'int_123456789abc');
          ctx.session.packState = { ...ctx.session.packState, inspections: 1 };
          return ctx.moreQueued ? null : { text: '附件已核验。', fixedId: 'fixture.intake', statePatch: { inspections: 2 } };
        }),
    },
    fixedReplies: [
      ...(base.fixedReplies ?? []),
      {
        id: 'fixture.intake',
        source: 'src/packs/__fixture/intake.ts',
        kind: 'plain',
        producedBy: { outside: '附件确定性回复' },
        pattern: /^附件已核验。$/,
        samples: () => [{ mode: 'template', text: '附件已核验。' }],
      },
    ],
  };
}
