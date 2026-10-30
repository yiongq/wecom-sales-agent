import './selftest-env.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AttachmentRef, IntakeKit, PackRuntime } from './core/pack-api.js';
import type { FinishedTurn } from './trace/recorder.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-engine-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  PACK_FIXTURES: '1',
  CONFIG_SOURCE: 'file',
  LLM_MOCK: '1',
  SERVER_SELFTEST: '1',
  SOP_PATH: 'data/packs/__fixture/sop.md',
});
const { hostRuntime } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
enterTenantScopeForTest(hostRuntime());
const config = await import('./config/source.js');
await config.initConfig(null);
const { bindPack } = await import('./core/pack-api.js');
const { createFixtureRuntime } = await import('./packs/__fixture/runtime.js');
const { withFixtureIntake } = await import('./packs/__fixture/intake.js');
const { handleMessage } = await import('./core/engine/index.js');
const { INTAKE_FAILED, INTAKE_LIMIT } = await import('./core/engine/intake.js');
const store = await import('./store.js');
const { onTurnEnd } = await import('./trace/recorder.js');
const { __alertTest } = await import('./ops/alert.js');
const turns: FinishedTurn[] = [];
const untrace = onTurnEnd((turn) => turns.push(turn));
const base = createFixtureRuntime(config.packSources());
let modelCalls = 0;
base.mock = {
  async chat() {
    modelCalls++;
    return '已核验';
  },
};
base.preModel = () => {
  throw new Error('附件不应进 preModel');
};
const bind = (runtime: PackRuntime) => bindPack(runtime, runtime.defaultBrand);
let serial = 0;
async function attachment(cls: AttachmentRef['cls'] = 'sheet', stored = true) {
  const s = store.getOrCreateSession(`web:intake-${++serial}`, 'web');
  const bytes = Buffer.from('型号,数量\nA1,2');
  const ref: AttachmentRef = {
    id: `att_${randomBytes(12).toString('hex')}`,
    cls,
    name: '投诉.xlsx',
    mime: cls === 'image' ? 'image/png' : 'text/csv',
    size: bytes.length,
    stored,
  };
  store.queueAttachment(s.id, {
    ...ref,
    channel: 'web',
    sourceKey: `cid-${serial}`,
    sha256: 'synthetic',
    bytes: stored ? bytes : null,
    intakeId: null,
    result: null,
    createdAt: Date.now(),
  });
  store.saveSession(s);
  await store.flushSession(s.id);
  return {
    s,
    ref,
    send: (moreQueued: boolean | (() => boolean) = false) => handleMessage(s.id, '投诉.xlsx', 'web', { attachment: ref, moreQueued }),
  };
}
const fixed = { text: '附件已核验。', fixedId: 'fixture.intake' };
try {
  bind(withFixtureIntake(base));
  const ok = await attachment();
  assert.equal((await ok.send()).text, fixed.text);
  await store.flushSession(ok.s.id);
  assert.deepEqual(ok.s.messages[0]?.attachment, ok.ref);
  assert.equal(ok.s.messages[0]?.content, '[文件]');
  assert.equal(ok.s.packState?.inspections, 2);
  assert.equal(ok.s.handedOver, false);
  assert.equal((await store.readAttachment(ok.ref.id))?.intakeId, 'int_123456789abc');
  const queued = await attachment();
  assert.equal((await queued.send(true)).silent, true);
  assert.equal(queued.s.messages.length, 1);
  assert.equal(queued.s.packState?.inspections, 1);
  await store.flushSession(queued.s.id);
  assert.equal((await store.readAttachment(queued.ref.id))?.intakeId, 'int_123456789abc');
  assert.equal(modelCalls, 0);
  console.log('INTAKE PASS: 正常回复、null 保存状态与识别结果、占位无文件名、跳过 preModel/模型');

  let moreQueued = false;
  let reads = 0;
  bind(
    withFixtureIntake(base, async (ctx, kit) => {
      assert.equal(reads, 0, '包读取前不求值');
      assert.equal(ctx.moreQueued, false);
      await kit.sheet();
      moreQueued = true;
      assert.equal(ctx.moreQueued, true, '识别期间入队的附件在读取时可见');
      await Promise.resolve();
      moreQueued = false;
      assert.equal(ctx.moreQueued, false, '每次读取都取当前值');
      moreQueued = true;
      return ctx.moreQueued ? null : fixed;
    }),
  );
  const dynamic = await attachment();
  assert.equal(
    (
      await dynamic.send(() => {
        reads++;
        return moreQueued;
      })
    ).silent,
    true,
  );
  assert.equal(reads, 4);
  assert.equal(dynamic.s.messages.filter((m) => m.role === 'agent').length, 0);
  console.log('INTAKE PASS: moreQueued 函数在包每次读取时求值，跨异步识别保持动态');

  for (const runtime of [
    base,
    withFixtureIntake(base, async () => {
      throw new Error('含文件原文的错误');
    }),
  ]) {
    bind(runtime);
    const bad = await attachment();
    assert.equal((await bad.send()).text, INTAKE_FAILED);
    assert.equal(bad.s.handedOver, false);
    assert.ok(turns.at(-1)?.turn.guards.some((guard) => guard.guard === 'intake_failed'));
    assert.ok(!JSON.stringify(turns.at(-1)).includes('含文件原文'));
  }
  bind(withFixtureIntake(base));
  const unsupported = await attachment('drawing');
  assert.equal((await unsupported.send()).text, INTAKE_FAILED);
  const human = await attachment();
  human.s.handedOver = true;
  assert.equal((await human.send()).silent, true);
  console.log('INTAKE PASS: 未声明/类别不支持/抛错兜底与 trace，人工接手 preflight 静默');

  bind(withFixtureIntake(base, async () => ({ ...fixed, text: '未登记的文字', statePatch: { inspections: 8 } })));
  const invalid = await attachment();
  await assert.rejects(invalid.send(), /固定句未登记/);
  assert.equal(invalid.s.packState, undefined);
  assert.equal(invalid.s.messages.length, 1);
  bind(withFixtureIntake(base, async () => ({ ...fixed, handoff: { reason: '合成附件需要核验' } })));
  const handoff = await attachment();
  assert.equal((await handoff.send()).handoff, true);
  assert.equal(handoff.s.handoff?.kind, 'pack');
  console.log('INTAKE PASS: pattern 校验先于副作用、确定性转人工');

  let lateKit!: IntakeKit;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  bind(
    withFixtureIntake(base, async (ctx, kit) => {
      lateKit = kit;
      entered();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      kit.saveResult({ late: true }, 'int_123456789abc');
      ctx.session.packState = { inspections: 99 };
      return fixed;
    }),
  );
  const slow = await attachment();
  mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = slow.send();
  await started;
  assert.ok(lateKit);
  mock.timers.tick(60_000);
  assert.equal((await waiting).text, INTAKE_FAILED);
  assert.equal(lateKit.signal.aborted, true);
  assert.ok(turns.at(-1)?.turn.guards.some((guard) => guard.guard === 'intake_timeout'));
  resume();
  await Promise.resolve();
  lateKit.saveResult({ late: true }, 'int_123456789abc');
  store.flushStoreNow();
  mock.timers.reset();
  await store.flushSession(slow.s.id);
  assert.equal((await store.readAttachment(slow.ref.id))?.result, null);
  assert.equal(slow.s.packState, undefined);
  assert.equal(slow.s.messages.filter((m) => m.role === 'agent').length, 1);
  console.log('INTAKE PASS: 60 秒中止、迟到 saveResult/状态失效');

  let sheetResult: unknown;
  bind(
    withFixtureIntake(base, async (_ctx, kit) => {
      sheetResult = await kit.sheet();
      return fixed;
    }),
  );
  for (const a of [await attachment('sheet', false), await attachment('image')]) {
    await a.send();
    assert.deepEqual(sheetResult, { ok: false, reason: 'corrupt' });
  }
  const foreign = await attachment();
  await handleMessage('web:intake-foreign', '', 'web', { attachment: foreign.ref });
  assert.deepEqual(sheetResult, { ok: false, reason: 'corrupt' });
  console.log('INTAKE PASS: 跨会话附件引用不能读取原件');
  let seen: unknown;
  const schema = z.object({ part: z.string() });
  bind(
    withFixtureIntake(base, async (_ctx, kit) => {
      seen = await kit.vision({ prompt: '合成读取', schema, maxOutputTokens: 100, mock: { part: 'A1' } });
      return fixed;
    }),
  );
  const image = await attachment('image');
  await image.send();
  assert.deepEqual(seen, { part: 'A1' });
  assert.equal(image.s.messages[0]?.content, '[图片]');
  assert.equal(turns.at(-1)?.turn.llm.filter((c) => c.purpose === 'vision').length, 1);
  bind(
    withFixtureIntake(base, async (_ctx, kit) => {
      seen = await kit.vision({ prompt: '合成读取', schema, maxOutputTokens: 100, mock: { invalid: true } });
      return fixed;
    }),
  );
  await (await attachment('image')).send();
  assert.equal(seen, null);
  console.log('INTAKE PASS: sheet 清理/错误类别、vision mock 成功/失败与 trace');

  for (const cls of ['sheet', 'image'] as const) {
    const raw = Buffer.from(cls === 'sheet' ? '型号,数量\nMEMORY_ONLY_A1,3' : 'synthetic-memory-only-image');
    const ref: AttachmentRef = {
      id: `att_${randomBytes(12).toString('hex')}`,
      cls,
      name: cls === 'sheet' ? 'synthetic.csv' : 'synthetic.png',
      mime: cls === 'sheet' ? 'text/csv' : 'image/png',
      size: raw.length,
      stored: false,
    };
    bind(
      withFixtureIntake(base, async (ctx, kit) => {
        assert.equal('attachmentBytes' in ctx, false);
        if (cls === 'sheet') {
          const result = await kit.sheet();
          if (!result.ok) {
            assert.equal(result.reason, 'corrupt');
            throw new Error('原件不可用');
          }
          assert.deepEqual(result.sheets, [
            {
              name: 'CSV',
              rows: [
                ['型号', '数量'],
                ['MEMORY_ONLY_A1', '3'],
              ],
            },
          ]);
        } else {
          const result = await kit.vision({ prompt: '合成读取', schema, maxOutputTokens: 100, mock: { part: 'A1' } });
          if (result === null) throw new Error('原件不可用');
          assert.deepEqual(result, { part: 'A1' });
        }
        return fixed;
      }),
    );
    const s = store.getOrCreateSession(`web:intake-memory-${cls}`, 'web');
    assert.equal(await store.readAttachment(ref.id, true), null);
    assert.equal((await handleMessage(s.id, '', 'web', { attachment: ref, attachmentBytes: raw })).text, fixed.text);
    await store.flushSession(s.id);
    assert.equal(await store.readAttachment(ref.id, true), null);
    for (const saved of [JSON.stringify(s), JSON.stringify(turns.at(-1)), fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')]) {
      assert.ok(!saved.includes('attachmentBytes'));
      assert.ok(!saved.includes(raw.toString()));
      assert.ok(!saved.includes(JSON.stringify([...raw])));
    }
    assert.equal((await handleMessage(s.id, '', 'web', { attachment: ref })).text, INTAKE_FAILED);
    assert.equal(s.handedOver, false);
    assert.ok(turns.at(-1)?.turn.guards.some((guard) => guard.guard === 'intake_failed'));
  }
  bind(
    withFixtureIntake(base, async (_ctx, kit) => {
      assert.deepEqual(await kit.sheet(), {
        ok: true,
        sheets: [
          {
            name: 'CSV',
            rows: [
              ['型号', '数量'],
              ['MEMORY_FIRST', '4'],
            ],
          },
        ],
      });
      return fixed;
    }),
  );
  const stale = await attachment();
  assert.equal(
    (
      await handleMessage(stale.s.id, '', 'web', {
        attachment: { ...stale.ref, name: 'synthetic.csv' },
        attachmentBytes: Buffer.from('型号,数量\nMEMORY_FIRST,4'),
      })
    ).text,
    fixed.text,
  );
  assert.equal(modelCalls, 0);
  console.log('INTAKE PASS: sheet/vision 无存储只用内存字节、内存优先、不进入上下文/消息/trace/落盘、无原件失败兜底');

  __alertTest.reset();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  process.env.VISION_DAILY_PER_TENANT = '0';
  let now = new Date(2026, 9, 29, 12).getTime();
  __alertTest.setClock(() => now);
  try {
    bind(
      withFixtureIntake(base, async (_ctx, kit) => {
        assert.equal(await kit.vision({ prompt: '合成读取', schema, maxOutputTokens: 100, mock: { part: 'A1' } }), null);
        kit.saveResult({ unwanted: true }, 'int_123456789abc');
        return { ...fixed, handoff: { reason: '不能执行' }, statePatch: { inspections: 99 } };
      }),
    );
    for (let n = 0; n < 2; n++) {
      const limited = await attachment('image');
      assert.equal((await limited.send()).text, INTAKE_LIMIT);
      assert.equal(limited.s.handedOver, false);
      assert.equal(limited.s.packState, undefined);
      await store.flushSession(limited.s.id);
      assert.equal((await store.readAttachment(limited.ref.id))?.result, null);
      now += 3_600_000;
    }
    assert.equal(warnings.filter((line) => line.includes('附件视觉识别达到当日上限')).length, 1);
    now += 86_400_000;
    await (await attachment('image')).send();
    assert.equal(warnings.filter((line) => line.includes('附件视觉识别达到当日上限')).length, 2);
  } finally {
    console.warn = warn;
    __alertTest.setClock(null);
    delete process.env.VISION_DAILY_PER_TENANT;
  }
  console.log('INTAKE PASS: limit 由引擎覆盖回复与副作用、每租户每天一次告警');

  store.flushStoreNow();
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as import('./types.js').Session[];
  assert.deepEqual(disk.find((s) => s.id === ok.s.id)?.messages[0]?.attachment, ok.ref);
  console.log('INTAKE PASS: 文件存储 attachment 原样往返');
} finally {
  mock.timers.reset();
  untrace();
  store.flushStoreNow();
  await config.closeConfig();
  fs.rmSync(dir, { recursive: true, force: true });
}
