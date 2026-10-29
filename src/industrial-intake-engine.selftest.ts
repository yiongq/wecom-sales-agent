// 12 R9 / R10：真实引擎、真实保存段与任务表，PGlite 与一次性 PG 共用断言——识别清单从附件到改行、确认、通知与重启。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Db } from './db/client.js';
import type { HandoffNotice } from './notify/notifier.js';
import type { AttachmentRef, ChatOptions } from './core/pack-api.js';

const mode = process.argv[2];
if (!mode) {
  for (const child of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, child], {
      env: process.env,
      encoding: 'utf8',
      timeout: 180_000,
    });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    assert.equal(run.status, 0);
  }
  if (!process.env.PG_TEST_URL) console.log('未设 PG_TEST_URL：真实 PG 待补跑');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-intake-engine-'));
  Object.assign(process.env, {
    VAR_DIR: dir,
    CONFIG_SOURCE: 'file',
    LLM_MOCK: '1',
    SERVER_SELFTEST: '1',
    SOP_PATH: path.join(dir, 'sop.md'),
    PUBLIC_BASE_URL: 'https://shop.example.test',
  });
  for (const file of ['sop.md', 'policy.json', 'brand.json', 'pack.json'])
    fs.copyFileSync(`data/packs/industrial/${file}`, path.join(dir, file));
  fs.mkdirSync(path.join(dir, 'catalog'));
  fs.writeFileSync(
    path.join(dir, 'catalog/part.json'),
    JSON.stringify(
      (
        [
          ['6205-2RS', '轴承'],
          ['6205-ZZ', '轴承'],
          ['6205-OPEN', '轴承'],
          ['M8×30', '紧固件'],
        ] as const
      ).map(([partNo, category], i) => ({
        id: `synthetic-${i}`,
        partNo,
        name: '合成零件',
        brand: '合成品牌',
        category,
        specs: ['合成规格'],
        unit: '件',
        unitPrice: 12.5,
        moq: 1,
        stock: 100,
        leadDays: 7,
      })),
    ),
  );
  const { hostRuntime, withoutTenantScope } = await import('./tenancy/runtime.js');
  const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
  const rt = hostRuntime();
  enterTenantScopeForTest(rt);
  const testing = await withoutTenantScope(() => import('./db/testing.js'));
  const { openDb } = await import('./db/client.js');
  const store = await import('./store.js');
  const config = await import('./config/source.js');
  const { bindPack } = await import('./core/pack-api.js');
  await import('./core/engine/sources.js');
  const { createIndustrialRuntime } = await import('./packs/industrial/runtime.js');
  const { readState } = await import('./packs/industrial/state.js');
  const { INTAKE_FIXED } = await import('./packs/industrial/intake.js');
  const { handleMessage } = await import('./core/engine/index.js');
  const { claimDueJobs, setJobStatus } = await import('./db/repo/jobs.js');
  const { runHandoffNotifyJob } = await import('./notify/handoff.js');
  const { __notifierTest, noticeText } = await import('./notify/notifier.js');
  let db: Db;
  let tenantId: string;
  let query: <T>(sql: string, args?: unknown[]) => Promise<T[]>;
  let close: () => Promise<void>;
  const slug = 'industrial-intake';
  if (mode === 'pg') {
    const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!, { slug });
    const app = await openDb(fx.urls.app);
    db = app.db;
    tenantId = fx.tenantId;
    query = fx.query;
    close = async () => {
      await app.close();
      await fx.drop();
    };
  } else {
    const t = await testing.openTestDb();
    await t.migrate();
    const fx = await testing.installPgSessionStore(t, { slug, varDir: dir });
    db = fx.deps.db;
    tenantId = fx.deps.tenantId;
    query = async <T>(sql: string, args: unknown[] = []) =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<T>(sql, args)).rows;
      });
    close = () => t.close();
  }
  const deps = { db, tenantId, tenantSlug: slug, varDir: dir };
  // 文件配置 + PG 会话存储的组合只出现在自测里：文字改行这类确定性回复没有 SOP 前缀哈希，
  // trace 行会被表约束拒绝并丢弃（线上是 db 配置，前缀哈希来自已发布的 SOP）。这一条日志与本套断言无关。
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (!String(args[0]).includes('turn_traces_prefix_hash_check')) warn(...args);
  };
  const notices: HandoffNotice[] = [];
  __notifierTest.use({
    async send(notice) {
      notices.push(notice);
    },
  });
  try {
    await store.initSessionStore(deps);
    await config.initConfig(null);
    const runtime = createIndustrialRuntime(config.packSources());
    const seen: ChatOptions[] = [];
    let script: (opts: ChatOptions) => Promise<string> = async () => '好的，已按清单处理。';
    runtime.mock = {
      async chat(opts) {
        seen.push(opts);
        return script(opts);
      },
    };
    bindPack(runtime, runtime.defaultBrand);
    let serial = 0;
    const sheet = (rows: string[]) => Buffer.from(['型号,数量', ...rows].join('\n'));
    /** 客户发来一份表格：先排进会话的附件行，再交给引擎（字节走 attachmentBytes）。 */
    async function send(sid: string, bytes: Buffer, moreQueued = false) {
      serial++;
      const ref: AttachmentRef = {
        id: `att_${serial.toString(16).padStart(24, '0')}`,
        cls: 'sheet',
        name: '投诉.csv',
        mime: 'text/csv',
        size: bytes.length,
        stored: true,
      };
      const s = store.getOrCreateSession(sid, 'wecom');
      store.queueAttachment(s.id, {
        ...ref,
        channel: 'wecom',
        sourceKey: `msg-${serial}`,
        sha256: 'synthetic',
        bytes,
        intakeId: null,
        result: null,
        createdAt: Date.now(),
      });
      store.saveSession(s);
      await store.flushSession(s.id);
      return handleMessage(sid, '', 'wecom', { attachment: ref, attachmentBytes: bytes, moreQueued });
    }
    const say = async (sid: string, text: string) => {
      const reply = await handleMessage(sid, text, 'wecom');
      await store.flushSession(sid);
      return reply;
    };
    const jobCount = async (intakeId: string) =>
      (await query<{ n: number }>('select count(*)::int as n from jobs where dedupe_key=$1', [`intake_unmatched:${intakeId}`]))[0]!.n;
    const runJobs = async () => {
      const jobs = await store.withJobsTx((tx) => claimDueJobs(tx, new Date(Date.now() + 1000), 20, ['handoff_notify']));
      for (const job of jobs) {
        const result = await runHandoffNotifyJob(job, Date.now());
        assert.equal(result.status, 'done');
        await store.withJobsTx((tx) => setJobStatus(tx, job.id, 'done'));
      }
    };
    const state = (sid: string) => readState(store.getSession(sid)!);
    const orders = (sid: string) => store.getSession(sid)!.orderIds.length;

    // —— 场景 A：表格 → 清单 → 改行 → 删行 → 确认 → 重启 ——
    const A = 'wecom:wmie-a';
    let modelCalls = seen.length;
    const listed = await send(A, sheet(['6205-2RS,100', '6205,200', 'ZZ9999,10', 'M8*30,5', '6205-ZZ,']));
    await store.flushSession(A);
    assert.match(listed.text, /^从您发来的询价单里认出 5 行，请核对：\n1\. 6205-2RS，100件，已匹配\n2\. 6205，200件，待确认：库里有 /);
    assert.match(listed.text, /\n5\. 6205-ZZ，数量没认出，待确认：数量没认出，请补数量\n/);
    assert.equal(seen.length, modelCalls, '附件那一轮不调模型');
    assert.equal(store.getSession(A)!.messages[0]!.content, '[文件]', '文件名不进正文');
    assert.equal(state(A).rfqIntake!.status, 'pending');
    assert.equal(state(A).rfqDraft, undefined, '确认之前不试算');
    const intakeId = state(A).rfqIntake!.id;
    assert.equal((await store.readAttachment(store.getSession(A)!.messages[0]!.attachment!.id))?.intakeId, intakeId);

    // 改行：三种说法、删行；都是确定性回复，不调模型。
    let edit = await say(A, '第2行 6205-ZZ');
    assert.match(edit.text, /\n2\. 6205-ZZ，200件，已匹配\n/);
    edit = await say(A, '第5行 40件');
    assert.match(edit.text, /\n5\. 6205-ZZ，40件，已匹配\n/);
    edit = await say(A, '第9行 6205-ZZ');
    assert.ok(edit.text.startsWith('没有这一行，请按下面清单里的行号修改\n从您发来的询价单里认出 5 行'));
    edit = await say(A, '删第5行');
    assert.match(edit.text, /^从您发来的询价单里认出 4 行/);
    assert.equal(seen.length, modelCalls, '改行不调模型');
    assert.deepEqual(
      state(A).rfqIntake!.lines.map((line) => `${line.q}/${line.qty}/${line.m}`),
      ['6205-2RS/100/exact', '6205-ZZ/200/exact', 'ZZ9999/10/none', 'M8×30/5/exact'],
    );

    // 还没确认：模型想试算清单里的行、起草报价单，都被工具闸拒绝，会话里没有试算也没有订单。
    const results: string[] = [];
    script = async (opts) => {
      results.push(await opts.executeTool('quote_items', { items: [{ query: '6205-2RS', qty: 100 }] }));
      results.push(await opts.executeTool('create_quote_sheet', { items: [{ code: 'synthetic-0', qty: 100 }] }));
      results.push(await opts.executeTool('find_parts', { query: '6205-OPEN' }));
      return '清单还没确认，请回复确认或指出要改的行。';
    };
    modelCalls = seen.length;
    await say(A, '6205-OPEN 有货吗');
    assert.equal(seen.length, modelCalls + 1);
    assert.match(seen.at(-1)!.contextNote ?? '', /识别清单还没确认，只能请客户确认或改行/);
    assert.deepEqual(
      results.slice(0, 2).map((r) => (JSON.parse(r) as { error: string }).error),
      ['识别清单还没确认：请客户回复确认或指出要改的行', '识别清单还没确认：请客户回复确认或指出要改的行'],
    );
    assert.equal((JSON.parse(results[2]!) as { error?: string }).error, undefined, '查询不受限');
    assert.equal(state(A).rfqDraft, undefined);
    assert.equal(orders(A), 0);

    // 确认那一轮：预取一次 quote_items（入参恰好是已匹配的行），模型据结果报价；其余行通知顾问。
    results.length = 0;
    script = async (opts) => {
      results.push(await opts.executeTool('create_quote_sheet', { items: [{ code: 'synthetic-0', qty: 100 }] }));
      results.push(await opts.executeTool('find_parts', { query: 'ZZ9999' }));
      results.push(await opts.executeTool('quote_items', { items: [{ query: '6205-2RS', qty: 100 }] }));
      return '已按已匹配的三行试算，第3行由顾问核对。';
    };
    modelCalls = seen.length;
    const confirmed = await say(A, '确认');
    assert.equal(seen.length, modelCalls + 1);
    const turn = seen.at(-1)!;
    assert.deepEqual(
      turn.prefetch!.map((call) => ({ name: call.name, args: call.args })),
      [
        {
          name: 'quote_items',
          args: {
            items: [
              { query: '6205-2RS', qty: 100 },
              { query: '6205-ZZ', qty: 200 },
              { query: 'M8×30', qty: 5 },
            ],
          },
        },
      ],
    );
    assert.match(turn.prefetch![0]!.result, /"total":3812.5/);
    assert.match(turn.contextNote ?? '', /清单第3行不报价，已通知顾问核对/);
    assert.doesNotMatch(turn.contextNote ?? '', /还没确认/);
    for (const r of results.slice(0, 3)) assert.match((JSON.parse(r) as { error?: string }).error ?? '', /客户刚确认了识别清单/);
    assert.equal(orders(A), 0, '确认的是清单，不是正式报价单');
    assert.match(confirmed.text, /第3行由顾问核对/);
    assert.equal(state(A).rfqIntake!.status, 'confirmed');
    assert.deepEqual(
      state(A).rfqDraft!.lines.map((line) => ('code' in line ? line.code : line.match)),
      ['synthetic-0', 'synthetic-1', 'synthetic-3'],
    );
    assert.equal(await jobCount(intakeId), 1);
    // 回复、状态、通知任务同一次提交。
    const [same] = await query<{ same: boolean; status: string }>(
      "select c.xmin=m.xmin and c.xmin=j.xmin as same, c.state->'packState'->'rfqIntake'->>'status' as status from conversations c join messages m on m.tenant_id=c.tenant_id and m.conversation_id=c.id join jobs j on j.tenant_id=c.tenant_id and j.payload->>'sessionId'=c.id where c.id=$1 and m.role='agent' and j.dedupe_key=$2 order by m.seq desc limit 1",
      [A, `intake_unmatched:${intakeId}`],
    );
    assert.equal(same?.same, true);
    assert.equal(same?.status, 'confirmed');
    await runJobs();
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind, 'intake_unmatched');
    assert.deepEqual(notices[0]?.lines, [3]);
    assert.match(noticeText(notices[0]!), /1 行库里没找到/);
    assert.ok(!noticeText(notices[0]!).includes('投诉'), '通知不含文件名');
    console.log(`${mode}: ENGINE PASS 表格→清单→改行→删行→确认：一次预取、工具闸、通知与回复同事务`);

    // 重启之后再说「确认」：不重算、不重发通知。
    await store.drainStore(5000);
    rt.store.pgBackend!.close();
    rt.store.pgBackend = null;
    rt.store.sessions.clear();
    rt.store.orders.clear();
    await store.initSessionStore(deps);
    assert.equal(state(A).rfqIntake!.status, 'confirmed');
    const draftAt = state(A).rfqDraft!.at;
    script = async () => '好的。';
    modelCalls = seen.length;
    await say(A, '确认');
    assert.equal(seen.length, modelCalls + 1);
    assert.equal(seen.at(-1)!.prefetch?.length ?? 0, 0, '不再预取');
    assert.equal(state(A).rfqDraft!.at, draftAt, '不重算');
    assert.equal(await jobCount(intakeId), 1);
    await runJobs();
    assert.equal(notices.length, 1, '不重发通知');
    console.log(`${mode}: ENGINE PASS 重启后再确认不重算、不重发通知`);

    // —— 场景 B：没有一行可算，只通知 ——
    const B = 'wecom:wmie-b';
    await send(B, sheet(['ZZ9999,10', '6205,5']));
    await store.flushSession(B);
    const idB = state(B).rfqIntake!.id;
    script = async () => '这两行库里没有精确匹配，顾问会核对。';
    modelCalls = seen.length;
    await say(B, '按这个报');
    assert.equal(seen.length, modelCalls + 1);
    assert.equal(seen.at(-1)!.prefetch?.length ?? 0, 0, '没有可算的行：不预取');
    assert.match(seen.at(-1)!.contextNote ?? '', /没有可试算的行：说明顾问会核对，不要报价/);
    assert.equal(state(B).rfqIntake!.status, 'confirmed');
    assert.equal(state(B).rfqDraft, undefined);
    assert.equal(await jobCount(idB), 1);
    await runJobs();
    assert.deepEqual(notices.at(-1)?.lines, [1, 2]);

    // —— 场景 C：客户自己打了新询价，清单被取代，不通知、不能再确认 ——
    const C = 'wecom:wmie-c';
    await send(C, sheet(['6205-2RS,100', 'ZZ9999,10']));
    await store.flushSession(C);
    const idC = state(C).rfqIntake!.id;
    modelCalls = seen.length;
    script = async () => '已按您这句试算。';
    await say(C, '6205-ZZ 30个');
    assert.equal(seen.length, modelCalls + 1);
    assert.deepEqual(
      seen.at(-1)!.prefetch!.map((call) => call.args),
      [{ items: [{ query: '6205-ZZ', qty: 30 }] }],
    );
    assert.equal(state(C).rfqIntake!.status, 'superseded');
    assert.equal(await jobCount(idC), 0);
    modelCalls = seen.length;
    await say(C, '确认');
    assert.equal(seen.at(-1)!.prefetch?.length ?? 0, 0);
    assert.equal(await jobCount(idC), 0);

    // —— 场景 D：连发——中间一份只入库，最后一份统一回复整份合并清单 ——
    const D = 'wecom:wmie-d';
    const quiet = await send(D, sheet(['6205-2RS,1']), true);
    assert.equal(quiet.silent, true);
    assert.equal(store.getSession(D)!.messages.filter((m) => m.role === 'agent').length, 0);
    const merged = await send(D, sheet(['M8*30,2']));
    assert.match(merged.text, /^从您发来的询价单里认出 2 行，请核对：\n1\. 6205-2RS，1件，已匹配\n2\. M8×30，2件，已匹配\n/);
    assert.equal(store.getSession(D)!.messages.filter((m) => m.role === 'agent').length, 1);

    // —— 场景 E：超限提示（企微把超过 20 MB 的文件变成一条文字）、泛化确认 ——
    const E = 'wecom:wmie-e';
    modelCalls = seen.length;
    const big = await say(E, '询价单.pdf');
    assert.equal(big.text, INTAKE_FIXED.oversized);
    assert.equal(seen.length, modelCalls, '不调模型');
    assert.equal(store.getSession(E)!.handedOver, false, '不转顾问');
    await send(E, sheet(['6205-2RS,3']));
    script = async () => '好的。';
    await say(E, '对的');
    assert.equal(seen.at(-1)!.prefetch!.length, 1, '上一条 AI 消息就是清单：泛化肯定算确认');
    assert.equal(state(E).rfqIntake!.status, 'confirmed');
    assert.equal(await jobCount(state(E).rfqIntake!.id), 0, '全部已匹配：不通知');
    const F = 'wecom:wmie-f';
    await send(F, sheet(['6205-2RS,3']));
    await say(F, '6205-2RS 有货吗');
    modelCalls = seen.length;
    await say(F, '可以');
    assert.equal(seen.at(-1)!.prefetch?.length ?? 0, 0, '隔了一轮模型回复：泛化肯定不算确认');
    assert.equal(state(F).rfqIntake!.status, 'pending');
    console.log(`${mode}: ENGINE PASS 只通知、被取代、连发合并、超限提示、泛化确认`);
  } finally {
    console.warn = warn;
    __notifierTest.use(null);
    await store.drainStore(5000);
    rt.store.pgBackend?.close();
    rt.store.pgBackend = null;
    await config.closeConfig();
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
