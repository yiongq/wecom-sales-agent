import '../../src/selftest-env.js';
import { hostRuntime, withTenantScope } from '../../src/tenancy/runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPackCase, packOf, validateCase, type CaseV2 } from './schema.js';
import type { CaseResult } from './run.js';
import { installResets, loadResetModules, resetCaseState, setCaseClock } from './isolation.js';
import { startFakeModel } from './fake-model.js';
import { normalize, resolveValues, resolvePattern } from './values.js';
import type { FinishedTurn } from '../../src/trace/recorder.js';
import type { AnyOrder } from '../../src/core/order-view.js';
import { installBrand, brandCase } from './brand.js';
import { observeTurn, type TurnObservation } from './snapshot.js';
import { readPackFile } from '../../src/config/pack-file.js';

export interface WorkerDb {
  close(): Promise<void>;
  reset(): Promise<void>;
}
/** 第二个参数是用例的包（缺省 travel）：PGlite 配置按包装配租户与配置源 */
type PrepareDb = (varDir: string, pack: string) => Promise<WorkerDb>;
interface PoolRuntime {
  db?: WorkerDb;
  used?: boolean;
}

/** 通用单的 orders.last.lines：条数相同，每条只比对期望里写出的键（title、unit、version 等没写就不比） */
function linesMatch(actual: unknown, expected: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return expected.every((want: Record<string, unknown>, i) =>
    Object.entries(want).every(([key, value]) => isDeepStrictEqual((actual[i] as Record<string, unknown> | undefined)?.[key], value)),
  );
}

function executeCase(c: CaseV2, varDir: string, prepareDb: PrepareDb, runtime?: PoolRuntime): Promise<CaseResult> {
  return withTenantScope(hostRuntime(), () => executeCaseInScope(c, varDir, prepareDb, runtime));
}

async function executeCaseInScope(c: CaseV2, varDir: string, prepareDb: PrepareDb, runtime?: PoolRuntime): Promise<CaseResult> {
  process.env.VAR_DIR = varDir;
  if (runtime) {
    setCaseClock(c.fixtures?.now);
    if (runtime.used) await resetCaseState(varDir);
  } else if (c.fixtures?.now) {
    process.env.PARITY_CLOCK_MS = String(Date.parse(c.fixtures.now));
    await import('../../src/store/parity-clock.js');
  }
  const calls = new Map<string, unknown>();
  let orders = (): AnyOrder[] => [];
  const values = { calls, orders: () => orders() };
  const fake = await startFakeModel(c.id, values);
  const failures: string[] = [];
  let checks = 0;
  const guardSkipped = 0;
  const turns: unknown[] = [];
  const observations: TurnObservation[] = [];
  let restoreBrand = () => {};
  let off = () => {};
  let offTool = () => {};
  let db: WorkerDb | undefined;
  let loadedStore: typeof import('../../src/store.js') | undefined;
  try {
    const sopPath = process.env.SOP_PATH || path.resolve('data/sop.md');
    // 08 R11：配置目录里有 pack.json 就是非旅游包的目录，只有 sop.md（品牌、catalog/ 同目录），没有 routes.json / hotels.json
    const packFile = readPackFile(path.dirname(sopPath));
    const packDir = packFile !== null && packFile.id !== 'travel';
    // 08 R11：写了 pack 的用例必须跑在那个包的配置目录上（由 runner 按 pack 设 SOP_PATH 与 PACK_FIXTURES）；没写 pack 的用例照旧不校验
    if (isPackCase(c) && (packFile?.id ?? 'travel') !== c.pack)
      throw new Error(`pack: 用例要的是「${c.pack}」，配置目录装载的是「${packFile?.id ?? 'travel'}」`);
    Object.assign(process.env, {
      LLM_MOCK: '0',
      LLM_PROVIDER: '',
      LLM_BASE_URL: fake.url,
      LLM_API_KEY: 'v2-local',
      LLM_MODEL: 'v2-local',
      LLM_MODEL_CHEAP: '',
      LLM_HEDGE_MODEL: '',
      LLM_MAX_RETRY: '0',
      LLM_TIMEOUT_MS: '5000',
      LLM_ROUND_TIMEOUT_MS: '10000',
      EMBED_BASE_URL: fake.url,
      EMBED_API_KEY: 'v2-local',
      CONFIG_SOURCE: 'file',
      WECOM_CORP_ID: '',
      WECOM_APP_SECRET: '',
      WECOM_KF_OPEN_KFID: '',
      SOP_PATH: sopPath,
      ...(packDir
        ? {}
        : {
            ROUTES_PATH: process.env.ROUTES_PATH || path.resolve('data/routes.json'),
            HOTELS_PATH: process.env.HOTELS_PATH || path.resolve('data/hotels.json'),
          }),
      PUBLIC_BASE_URL: '',
    });
    if (!isPackCase(c) && c.brand) c = brandCase(c, c.brand);
    const store = await import('../../src/store.js');
    loadedStore = store;
    if (process.env.CONFIG_TEST_DB === 'pglite') {
      db = runtime?.db ?? (await prepareDb(varDir, packOf(c)));
      if (runtime) runtime.db = db;
    }
    restoreBrand = installBrand(isPackCase(c) ? undefined : c.brand, varDir);
    const { handleMessage, onToolCall } = await import('../../src/engine.js');
    if (runtime && !runtime.used) await loadResetModules();
    const { onTurnEnd } = await import('../../src/trace/recorder.js');
    const { buildIndex } = await import('../../src/retrieval.js');
    const { createQuote } = await import('../../src/tools.js');
    const sid = `eval:v2-${c.id}`;
    const session = store.getOrCreateSession(sid, 'simulator');
    Object.assign(session, c.fixtures?.session, { id: sid, channel: 'simulator' });
    // 夹具订单共用同一个 createdAt：listOrders 按 createdAt 倒序，跨毫秒创建时「最后一张」会随机变，快照不稳
    const fixtureCreatedAt = Date.now();
    if (isPackCase(c)) {
      // 08 R11：通用单只给条目和数量，经包的 priceLine 建（createLineOrder 的入参里没有金额）；状态建好后再改成夹具要的
      const { createLineOrder } = await import('../../src/core/order-view.js');
      for (const fixture of c.fixtures?.orders ?? []) {
        const result = await createLineOrder(session, fixture.lines, { approval: false });
        if ('rejected' in result) throw new Error(`夹具订单被包拒绝：${JSON.stringify(result.rejected)}`);
        const order = result.order;
        order.status = fixture.status;
        order.createdAt = fixtureCreatedAt;
        if (order.status === 'paid') order.paidAt = Date.now();
        store.saveOrder(order);
      }
    } else {
      for (const fixture of c.fixtures?.orders ?? []) {
        const q = createQuote(fixture);
        const order = store.createOrder({
          sessionId: sid,
          routeId: fixture.routeId,
          routeTitle: q.routeTitle,
          travelers: fixture.travelers,
          departDate: fixture.departDate,
          totalPrice: q.total,
        });
        order.status = fixture.status;
        order.createdAt = fixtureCreatedAt;
        if (['paid', 'refund_pending', 'refunded'].includes(order.status)) order.paidAt = Date.now();
        store.saveOrder(order);
        session.orderIds.push(order.id);
      }
    }
    store.saveSession(session);
    orders = () => (isPackCase(c) ? store.listAnyOrders() : store.listOrders()).filter((o) => o.sessionId === sid);
    offTool = onToolCall((name, _args, sessionId) => {
      if (sessionId === sid) calls.delete(name);
    });
    const observation: { finished?: FinishedTurn } = {};
    const observedTurn = (): FinishedTurn | undefined => observation.finished;
    off = onTurnEnd((t) => {
      if (t.turn.conversationId !== sid) return;
      observation.finished = t;
      for (const call of new Map(t.turn.calls.map((call) => [call.name, call])).values()) {
        // 保留 wire 中的完整结果；其它调用只接受未截断的 JSON，不能沿用旧结果。
        if (call.resultBytes <= 4096) {
          try {
            calls.set(call.name, JSON.parse(call.resultHead));
          } catch {
            calls.delete(call.name);
          }
        }
      }
    });
    await buildIndex();
    for (let i = 0; i < c.turns.length; i++) {
      const t = c.turns[i];
      fake.begin(i + 1, t.script, t.vision);
      observation.finished = undefined;
      let reply: Awaited<ReturnType<typeof handleMessage>>;
      if (t.attach) {
        // 12 R13：附件轮走与渠道同一个入口（prepareAttachment），再由引擎收下；客户消息只有占位，没有文字
        const { prepareFixture } = await import('../sim/attachment-fixtures.js');
        const prepared = await prepareFixture(t.attach.file, `v2-${c.id}-${i + 1}`, t.attach.name);
        // 没写 vision 的图片轮：LLM_MOCK=1 只覆盖这一轮，视觉走包给的缺省 mock（本轮不会调主对话，用不到别的）
        const mock = prepared.cls === 'image' && t.vision === undefined;
        process.env.LLM_MOCK = mock ? '1' : '0';
        try {
          reply = await handleMessage(sid, prepared.text, 'simulator', prepared.opts);
        } finally {
          process.env.LLM_MOCK = '0';
        }
      } else reply = await handleMessage(sid, t.say!, 'simulator');
      const finished = observedTurn();
      fake.finish();
      if (!finished) throw new Error(`第${i + 1}轮缺少 onTurnEnd 观测`);
      observations.push(observeTurn(reply, session.handedOver, orders(), finished));
      const expect = resolveValues(t.expect, values) as typeof t.expect;
      for (const key of ['replyMatches', 'replyExcludes', 'contextMatches', 'contextExcludes'] as const) {
        expect[key] = t.expect[key]?.map((pattern) => resolvePattern(pattern, values));
      }
      const check = (ok: boolean, path: string, actual: unknown) => {
        checks++;
        if (!ok) failures.push(`[${c.id}] 第${i + 1}轮 expect.${path}: 实际 ${JSON.stringify(actual)}`);
      };
      for (const pattern of expect.replyMatches ?? [])
        check(new RegExp(normalize(pattern), 'm').test(normalize(reply.text)), `replyMatches /${pattern}/`, reply.text);
      for (const pattern of expect.replyExcludes ?? [])
        check(!new RegExp(normalize(pattern), 'm').test(normalize(reply.text)), `replyExcludes /${pattern}/`, reply.text);
      // 本轮没有模型请求（确定性回复）时 contextNote 为空串：Matches 不命中，Excludes 通过
      for (const pattern of expect.contextMatches ?? [])
        check(
          new RegExp(normalize(pattern), 'm').test(normalize(fake.contextNote() ?? '')),
          `contextMatches /${pattern}/`,
          fake.contextNote(),
        );
      for (const pattern of expect.contextExcludes ?? [])
        check(
          !new RegExp(normalize(pattern), 'm').test(normalize(fake.contextNote() ?? '')),
          `contextExcludes /${pattern}/`,
          fake.contextNote(),
        );
      if (expect.stage !== undefined) check(reply.stage === expect.stage, 'stage', reply.stage);
      if (expect.tools !== undefined)
        check(
          isDeepStrictEqual(
            finished?.turn.calls.map((call) => call.name),
            expect.tools,
          ),
          'tools',
          finished?.turn.calls.map((call) => call.name),
        );
      if (expect.silent !== undefined) check(Boolean(reply.silent) === expect.silent, 'silent', reply.silent);
      if (expect.handoff !== undefined) check(session.handedOver === expect.handoff, 'handoff', session.handedOver);
      if (expect.orders) {
        check(orders().length === expect.orders.count, 'orders.count', orders().length);
        for (const [key, value] of Object.entries(expect.orders.last ?? {})) {
          const actual = (orders().at(-1) as unknown as Record<string, unknown> | undefined)?.[key];
          check(
            isPackCase(c) && key === 'lines' ? linesMatch(actual, value) : isDeepStrictEqual(actual, value),
            `orders.last.${key}`,
            actual,
          );
        }
      }
      if (expect.guardVerdicts !== undefined) {
        const verdicts = finished?.turn.guardVerdicts;
        check(
          finished !== undefined && verdicts !== undefined && isDeepStrictEqual(verdicts ?? [], expect.guardVerdicts),
          'guardVerdicts',
          verdicts,
        );
      }
      turns.push({ reply, orders: structuredClone(orders()), trace: finished });
    }
  } catch (e) {
    failures.push(`[${c.id}] ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // expect/脚本占位报错也可能已产生业务写入，失败路径同样先排空队列。
    if (loadedStore) {
      try {
        const { undrained } = await loadedStore.drainStore(5000);
        if (undrained.length) failures.push(`[${c.id}] 临时状态写队列未排空`);
        else loadedStore.flushStoreNow();
      } catch (e) {
        failures.push(`[${c.id}] ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    restoreBrand();
    off();
    offTool();
    await fake.close();
    if (!runtime) await db?.close();
  }
  failures.push(...fake.errors);
  return { id: c.id, pass: failures.length === 0, checks, guardSkipped, failures, turns, observations };
}

export async function runWorker(prepareDb: PrepareDb): Promise<never> {
  const c = validateCase(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  const result = await executeCase(c, process.argv[3], prepareDb);
  fs.writeFileSync(process.argv[4], JSON.stringify(result));
  process.exit(result.pass ? 0 : 1);
}

export async function runPoolWorker(prepareDb: PrepareDb): Promise<void> {
  installResets();
  const varDir = process.argv[2];
  process.env.VAR_DIR = varDir;
  const runtime: PoolRuntime = {};
  // IPC 回包前必须完成清理；清理失败就退出，让父进程换一名干净 worker。
  let chain = Promise.resolve();
  process.on('message', (input: unknown) => {
    chain = chain
      .then(async () => {
        const c = validateCase(input);
        const result = await executeCase(c, varDir, prepareDb, runtime);
        runtime.used = true;
        await resetCaseState(varDir);
        await runtime.db?.reset();
        process.send!(result);
      })
      .catch(() => process.exit(1));
  });
  process.once('disconnect', () => {
    void chain.finally(async () => {
      await runtime.db?.close();
      process.exit(0);
    });
  });
}
