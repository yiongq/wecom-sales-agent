// 03 第 8 步：出站「先落库、后发送」的发送账本与落库（docs/architecture/03-channels-v2/spec.md「出站：投递状态」、R4、R6、R21，
// 不变量 4、6、7，验收 7 的 A、B 与 17 的账本部分）。适配器的整条发送顺序（接手、停机截止、各类出站在哪一次落库）在
// src/adapters/wecom-03.selftest.ts；02 的老路（env 账号）由 quota.selftest.ts 守，断言不改。
// 本文件带上 OUTBOUND_CHILD 再起自己（单进程 node --import tsx，超时 SIGKILL，不留孤儿）：
//   pglite：PGlite 上的 db 会话存储与两个库里的企微账号。迁移表的每条路径（plan、mark、settle、cancel、unmark、receipt 与表外的写入）
//           内存与库里一致；markSending 的四种结果（db_unavailable 放弃之后那个事务不会再把行标成 sending）；commitOutbound 超时；
//           R6 的两种补写（pending 已提交的结果直接从 pending 迁；结果行先到直接插成结果，晚到的 pending 插入什么都不改；回执先到）；
//           R21：pending 与业务改动同一个事务、结果写在存档点（结果写不进去只丢结果，会话照常提交）、cancelled 在主事务；
//           planOutbound 的同步校验（不过就什么都不排）、预占由第一段接过、工作台的投递状态（内存与库里两条路同一张映射表）、
//           窗口计数把 pending、sending 算进已用、「没落库就发」的计数与告警。
//   rpg（PG_TEST_URL 设了才跑）：同一套在真实 Postgres 上以 agent_app 跑一遍（挡住写库用 openGatedDb）。
// 用法：npx tsx src/quota/outbound.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage, Session } from '../types.js';

const CHILD = process.env.OUTBOUND_CHILD ?? '';
const SELF = fileURLToPath(import.meta.url);

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const json = (v: unknown): string => JSON.stringify(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(10);
  }
  return cond();
}

if (CHILD) await childMain(CHILD);
else await parentMain();

// ======================================================================================
// 父进程：纯函数部分，再起子进程
// ======================================================================================

async function parentMain(): Promise<never> {
  const varParent = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(varParent, { recursive: true });
  const ROOT = fs.mkdtempSync(path.join(varParent, 'outbound-selftest-'));
  process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

  // 工作台的映射表（spec「出站：投递状态」）：内存账本与库里的行共用这一个函数
  {
    const { deliveryOfSegments } = await import('../shared/conversation-types.js');
    const d = (...st: string[]) => deliveryOfSegments(st.map((status) => ({ status, failType: status === 'failed' ? 4 : null })));
    check('映射：没有分段为 null', d() === null);
    check('映射：全部 accepted → accepted（工作台不显示）', d('accepted', 'accepted')?.status === 'accepted');
    check(
      '映射：有 pending 或 sending → 发送中（哪怕别的段已有结果）',
      d('accepted', 'pending')?.status === 'sending' &&
        d('sending')?.status === 'sending' &&
        d('rejected', 'pending')?.status === 'sending',
    );
    check('映射：有 unknown → 可能没送达', d('accepted', 'unknown')?.status === 'unknown');
    check(
      '映射：有 rejected 或 failed → 没送达（failed 带原因码，压过 unknown）',
      d('accepted', 'rejected', 'unknown')?.status === 'rejected' &&
        json(d('unknown', 'failed')) === json({ status: 'failed', failType: 4 }),
    );
    check('映射：全是 cancelled → 未发送', d('cancelled', 'cancelled')?.status === 'cancelled');
    check('映射：一部分发出、其余取消 → 也标未发送（不变量 6：没送达的段要有状态）', d('accepted', 'cancelled')?.status === 'cancelled');
  }

  const runChild = (mode: string, env: Record<string, string>) => {
    const resultFile = path.join(ROOT, `${mode}-${Date.now()}.json`);
    const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
      cwd: process.cwd(),
      env: { ...process.env, OUTBOUND_CHILD: mode, OUTBOUND_RESULT: resultFile, CONFIG_SOURCE: 'file', ...env },
      timeout: 240_000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    let result: { pass: number; fails: string[] } | null = null;
    try {
      result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { pass: number; fails: string[] };
    } catch {
      result = null;
    }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    check(`${mode}：子进程正常结束`, r.status === 0, `status=${r.status} signal=${r.signal} ${out.slice(-2000)}`);
    if (!result) {
      fails.push(`${mode}：子进程没留下结果 ${out.slice(-3000)}`);
      return;
    }
    pass += result.pass;
    for (const f of result.fails) fails.push(`${mode}：${f}`);
    if (result.fails.length) fails.push(`${mode} 的日志：${out.slice(-4000)}`);
  };

  runChild('pglite', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'pglite-')) });
  let realPg = false;
  if (process.env.PG_TEST_URL) {
    realPg = true;
    runChild('rpg', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'rpg-')) });
  } else if (process.env.CI === 'true') {
    fails.push('CI 下必须设 PG_TEST_URL：出站的迁移表与 R21 的事务边界要以 agent_app 在真实 Postgres 上跑一遍');
  }

  if (fails.length) {
    console.error(`OUTBOUND SELFTEST FAIL：${fails.length} 项（通过 ${pass} 项）`);
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log(
    `OUTBOUND SELFTEST PASS: ${pass} 项断言全通（迁移表每条路径内存与库一致 / markSending 四种结果 / commitOutbound 超时 / ` +
      `R6 两种补写与回执先到 / R21：pending 与业务同一事务、结果在存档点、cancelled 在主事务 / 同步校验 / 预占由第一段接过 / ` +
      `工作台映射与窗口计数 / 没落库就发的计数与告警${realPg ? ' / 真实 PG' : '；真实 PG 部分未跑'}）`,
  );
  process.exit(0);
}

// ======================================================================================
// 子进程
// ======================================================================================

async function childMain(mode: string): Promise<never> {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) {
    console[k] = (...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : json(a))).join(' '));
      if (logs.length > 3000) logs.splice(0, logs.length - 3000);
    };
  }
  try {
    await suite(mode, logs);
  } catch (e) {
    fails.push(`子进程抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  Object.assign(console, orig);
  if (fails.length) for (const l of logs.slice(-150)) console.error(`  ${l}`);
  fs.writeFileSync(process.env.OUTBOUND_RESULT!, JSON.stringify({ pass, fails }));
  process.exit(0);
}

async function suite(mode: string, logs: string[]): Promise<void> {
  const varDir = process.env.VAR_DIR!;
  Object.assign(process.env, { LLM_MOCK: '1', PUBLIC_BASE_URL: '', ALERT_WEBHOOK_URL: '', FOLLOWUP_ENABLED: '' });
  const store = await import('../store.js');
  const testing = await import('../db/testing.js');
  const { withTenant } = await import('../db/client.js');
  let db: import('../db/client.js').Db;
  let tenantId: string;
  let su: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
  let faults: { gate: Promise<void> | null; acquire: Error | null };
  let close: () => Promise<void>;
  if (mode === 'rpg') {
    const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!, { slug: 'out08' });
    const gated = await testing.openGatedDb(fx.urls.app);
    db = gated.db;
    faults = gated.faults;
    tenantId = fx.tenantId;
    su = fx.query;
    // 预载、装载、落库都经挡得住的那个池（以 agent_app 身份）
    await store.initSessionStore({ db, tenantId, tenantSlug: 'out08', varDir });
    close = async () => {
      await gated.close();
      await fx.drop();
    };
  } else {
    const t = await testing.openTestDb();
    const fx = await testing.installPgSessionStore(t, { varDir, slug: 'demo' });
    db = t.db;
    tenantId = fx.deps.tenantId;
    faults = fx.faults;
    su = <R>(text: string, params: unknown[] = []): Promise<R[]> =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<R>(text, params)).rows;
      });
    await store.initSessionStore(fx.deps);
    db = fx.deps.db;
    close = () => t.close();
  }

  // ---- 两个库里的企微账号（不起运行时：这里只测账本与落库） ----
  const { sealSecrets } = await import('../channels/secrets.js');
  const keyBytes = Buffer.alloc(32, 8);
  const keyRing = { current: { id: 'k08', key: keyBytes }, all: new Map([['k08', keyBytes]]) };
  const defs = [
    { key: 'a1', prefix: 'wecom:', kf: 'kf08a1' },
    { key: 'a2', prefix: 'wecom:a2:', kf: 'kf08a2' },
  ];
  for (const a of defs) {
    const id = randomUUID();
    const { ct, keyId } = sealSecrets(
      keyRing,
      { tenantId, accountId: id },
      {
        appSecret: `s08-${a.key}-app`,
        callbackToken: `s08-${a.key}-cb`,
        callbackAesKey: Buffer.alloc(32, 6).toString('base64').slice(0, 43),
      },
    );
    await su(
      `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
       values ($1, $2, $3, 'wecom_kf', $3, 'active', $4, 'corp08', $5, decode($6, 'hex'), $7)`,
      [tenantId, id, a.key, a.prefix, a.kf, ct.toString('hex'), keyId],
    );
  }
  const reg = await import('../channels/registry.js');
  await reg.initChannels({ db, tenantId, tenantSlug: mode === 'rpg' ? 'out08' : 'demo', varDir, keyRing });
  const { loadedAccounts } = await import('../channels/accounts.js');
  const A1 = loadedAccounts().find((a) => a.key === 'a1')!;
  const A2 = loadedAccounts().find((a) => a.key === 'a2')!;
  const ledger = await import('./ledger.js');
  const { OutboundPlanError } = ledger;
  ledger.__ledgerTest.setWaits({ commitMs: 400, markMs: 400 });
  type Payload = import('./ledger.js').OutboundPayload;
  type Intent = import('./ledger.js').OutboundIntent;
  const T = (content: string): Payload => ({ msgtype: 'text', text: { content } });

  let n = 0;
  /** 一个默认账号（wecom:）的会话，带一句客户的话（窗口从它算起） */
  const newSession = (prefix = 'wecom:'): { sid: string; s: Session } => {
    n += 1;
    const sid = `${prefix}wm08o${n}`;
    const s = store.getOrCreateSession(sid, 'wecom');
    s.messages.push({ role: 'customer', content: '你好', at: Date.now(), msgid: `m08-${n}`, sentAt: Date.now() });
    store.saveSession(s);
    return { sid, s };
  };
  /** 一条 AI 回复写进会话（saveSession 同步分到 seq） */
  const reply = (s: Session, text: string): ChatMessage => {
    const m: ChatMessage = { role: 'agent', content: text, at: Date.now() };
    s.messages.push(m);
    store.saveSession(s);
    return m;
  };
  const target = (sid: string) => ({ sessionId: sid, hasSession: store.getSession(sid) !== undefined });
  interface DbRow {
    status: string;
    nopay: boolean;
    kind: string;
    account_id: string | null;
    segment: number;
    attempts: number;
    message_seq: number | null;
    conversation_id: string;
    xmin: string;
  }
  const dbRow = async (msgid: string): Promise<DbRow | null> =>
    (
      await su<DbRow>(
        `select status, payload is null as nopay, kind, account_id::text as account_id, segment, attempts, message_seq, conversation_id,
                xmin::text as xmin
         from outbound_sends where channel_msgid = $1`,
        [msgid],
      )
    )[0] ?? null;
  const mem = (msgid: string) => ledger.__ledgerTest.rows().find((r) => r.msgid === msgid) ?? null;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await sleep(15);
      await store.drainStore(5000);
    }
  };
  /** 内存与库里这一段的状态都是 want（库里的行要等落库：结果写在下一次落库或短事务里） */
  const agree = async (label: string, msgid: string, want: string): Promise<void> => {
    await settle();
    await waitFor(async () => (await dbRow(msgid))?.status === want, 3000);
    const d = await dbRow(msgid);
    const m = mem(msgid);
    check(`${label}：内存与库里都是 ${want}`, m?.status === want && d?.status === want, json({ mem: m?.status, db: d?.status }));
    if (d && want !== 'pending' && want !== 'sending') check(`${label}：迁出 pending、sending 之后 payload 为空（不变量 7）`, d.nopay);
  };
  const seqOf = store.seqOf;

  // ======== 正常的一组：pending 与回复同一个事务、每段 sending 之后才算发、结果在下一次落库 ========
  {
    const { sid, s } = newSession();
    const m = reply(s, '第一段\n第二段');
    // 与 saveSession 同一段同步代码里排：pending 进的是这条回复的那一次落库
    const intents = ledger.planOutbound(A1, target(sid), 'ai', m, null, [T('第一段'), T('第二段')]);
    check(
      'plan：两段、段号 0 与 1、msgid 是 32 位十六进制',
      intents.length === 2 && intents.every((i, k) => i.segment === k && /^[0-9a-f]{32}$/.test(i.msgid)),
    );
    check(
      'plan：内存里是 pending、计入已用条数',
      intents.every((i) => mem(i.msgid)?.status === 'pending') && ledger.sendWindow(sid, Date.now()).used === 2,
    );
    check('commitOutbound：等到提交', (await ledger.commitOutbound(intents)) === 'committed');
    const r0 = await dbRow(intents[0]!.msgid);
    const msgX = (
      await su<{ xmin: string }>('select xmin::text as xmin from messages where conversation_id = $1 and seq = $2', [sid, seqOf(m)])
    )[0];
    check(
      'R21：pending 写进主事务，与这条回复同一个事务提交（xmin 相同）',
      !!r0 && !!msgX && r0.xmin === msgX.xmin && r0.status === 'pending' && !r0.nopay,
      json({ r0, msgX }),
    );
    check(
      '出站行：kind 记组的种类、account_id 是账号 uuid、message_seq 对上这条回复、attempts 0',
      r0?.kind === 'ai' && r0.account_id === A1.id && r0.message_seq === seqOf(m) && r0.attempts === 0,
      json(r0),
    );
    for (const i of intents) {
      check(`markSending 第 ${i.segment} 段：marked`, (await ledger.markSending(i)) === 'marked');
      const d = await dbRow(i.msgid);
      check(
        `markSending 第 ${i.segment} 段：库里发请求之前已是 sending（不变量 4）`,
        d?.status === 'sending' && !d.nopay && mem(i.msgid)?.status === 'sending',
      );
      ledger.noteAttempt(i);
      ledger.settleIntent(i, 'accepted', { attempts: 1 });
    }
    for (const i of intents) await agree(`结果第 ${i.segment} 段`, i.msgid, 'accepted');
    const d1 = await dbRow(intents[1]!.msgid);
    check('结果：attempts 1、message_seq 不变', d1?.attempts === 1 && d1.message_seq === seqOf(m), json(d1));
    check('工作台：正常发出 → accepted（不显示）', ledger.deliveryOf(sid, m)?.status === 'accepted');
  }

  // ======== 迁移表的每条路径：内存与库里一致 ========
  /** 新开一组一段，提交好；mark 为真时再标 sending */
  const one = async (mark: boolean, prefix = 'wecom:'): Promise<{ sid: string; s: Session; m: ChatMessage; i: Intent }> => {
    const { sid, s } = newSession(prefix);
    const m = reply(s, '一段');
    const [i] = ledger.planOutbound(prefix === 'wecom:' ? A1 : A2, target(sid), 'ai', m, null, [T('一段')]);
    await ledger.commitOutbound([i!]);
    if (mark) await ledger.markSending(i!);
    return { sid, s, m, i: i! };
  };
  {
    const a = await one(true);
    ledger.settleIntent(a.i, 'rejected', { errcode: 40001, attempts: 1 });
    await agree('sending → rejected', a.i.msgid, 'rejected');
    const b = await one(true);
    ledger.noteUnknown(b.i);
    await agree('sending → unknown（超时那一刻先记）', b.i.msgid, 'unknown');
    ledger.settleIntent(b.i, 'accepted', { attempts: 2 });
    await agree('unknown → accepted（同一进程里的重试）', b.i.msgid, 'accepted');
    const c = await one(true);
    ledger.noteUnknown(c.i);
    ledger.settleIntent(c.i, 'unknown', { attempts: 3 });
    await agree('unknown → unknown', c.i.msgid, 'unknown');
    check('unknown → unknown：attempts 往大里改', (await dbRow(c.i.msgid))?.attempts === 3);
    const d = await one(false);
    ledger.settleIntent(d.i, 'accepted', { attempts: 1 });
    await agree('pending → accepted（R6：markSending 没写成就发了）', d.i.msgid, 'accepted');
    const e = await one(false);
    ledger.cancelIntents([e.i], 'taken_over');
    await agree('pending → cancelled', e.i.msgid, 'cancelled');
    const f = await one(true);
    ledger.cancelIntents([f.i], 'taken_over');
    await agree('sending → cancelled（标了 sending、还没发请求就被接手）', f.i.msgid, 'cancelled');
    const g = await one(true);
    check('sending → pending（截止之后迁回）：短事务写成', await ledger.unmarkSending(g.i));
    await agree('sending → pending', g.i.msgid, 'pending');
    check('迁回 pending：payload 还在（重启后照它补发）', (await dbRow(g.i.msgid))?.nopay === false);
    for (const [label, mark, pre] of [
      ['pending → failed（回执）', false, null],
      ['sending → failed（回执）', true, null],
      ['accepted → failed（回执）', true, 'accepted'],
      ['unknown → failed（回执）', true, 'unknown'],
    ] as const) {
      const r = await one(mark);
      if (pre) ledger.settleIntent(r.i, pre, { attempts: 1 });
      await settle();
      ledger.onSendFail(r.i.msgid, 4);
      await agree(label, r.i.msgid, 'failed');
      check(
        `${label}：会话多一条说明`,
        r.s.messages.some((x) => x.role === 'system' && x.content.includes('48 小时')),
      );
    }
    // 表外的写入：什么都不改
    const h = await one(true);
    ledger.onSendFail(h.i.msgid, 6);
    await settle();
    ledger.settleIntent(h.i, 'accepted', { attempts: 1 });
    await agree('表外：对 failed 写 accepted 不改（failed 之后任何写入都不改它）', h.i.msgid, 'failed');
    ledger.cancelIntents([h.i], 'taken_over');
    await agree('表外：对 failed 取消不改', h.i.msgid, 'failed');
    const k = await one(false);
    ledger.cancelIntents([k.i], 'taken_over');
    await settle();
    ledger.settleIntent(k.i, 'accepted', { attempts: 1 });
    await agree('表外：对 cancelled 写 accepted 不改', k.i.msgid, 'cancelled');
    check('markSending：对 cancelled → not_pending', (await ledger.markSending(k.i)) === 'not_pending');
    await agree('表外：对 cancelled 标 sending 不改', k.i.msgid, 'cancelled');
    const { insertOutboundSends } = await import('../db/repo/outbound.js');
    const ctx = { tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    // 对 cancelled 写 pending（晚到的 pending 插入）：库里不改（验收 17）
    await withTenant(db, ctx, (tx) =>
      insertOutboundSends(tx, [
        {
          conversationId: k.sid,
          channelMsgid: k.i.msgid,
          messageSeq: null,
          kind: 'ai',
          sentAt: new Date(),
          status: 'pending',
          errcode: null,
          failType: null,
          accountId: A1.id,
          payload: T('x'),
        },
      ]),
    );
    check('表外：对 cancelled 写 pending 不改库', (await dbRow(k.i.msgid))?.status === 'cancelled');
    const l = await one(true);
    ledger.settleIntent(l.i, 'accepted', { attempts: 1 });
    await settle();
    ledger.cancelIntents([l.i], 'taken_over');
    await agree('表外：对 accepted 取消不改', l.i.msgid, 'accepted');
    check('unmarkSending：对 accepted 不改', (await ledger.unmarkSending(l.i)) === false || mem(l.i.msgid)?.status === 'accepted');
    await agree('表外：对 accepted 迁回 pending 不改', l.i.msgid, 'accepted');
  }

  // ======== markSending 的四种结果；db_unavailable 放弃之后那个事务不会再把行标成 sending ========
  {
    const a = await one(false);
    check('markSending：marked', (await ledger.markSending(a.i)) === 'marked');
    const b = await one(false);
    ledger.cancelIntents([b.i], 'taken_over');
    await settle();
    check('markSending：行在、已不是 pending → not_pending', (await ledger.markSending(b.i)) === 'not_pending');
    const c = await one(false);
    await su('delete from outbound_sends where channel_msgid = $1', [c.i.msgid]); // 只有超级用户删得了：模拟被清除
    check('markSending：库里没有这一行 → absent', (await ledger.markSending(c.i)) === 'absent');
    const d = await one(false);
    let open!: () => void;
    faults.gate = new Promise<void>((r) => (open = r));
    const t0 = Date.now();
    const r = await ledger.markSending(d.i);
    check('markSending：库挡住、等满上限 → db_unavailable', r === 'db_unavailable' && Date.now() - t0 >= 350, `${r} ${Date.now() - t0}ms`);
    faults.gate = null;
    open();
    await sleep(100);
    await settle();
    check(
      'db_unavailable 之后放开：那个放弃了的事务回滚，库里仍是 pending（不会在调用方照 R6 处理之后再标成 sending）',
      (await dbRow(d.i.msgid))?.status === 'pending' && mem(d.i.msgid)?.status === 'pending',
      json(await dbRow(d.i.msgid)),
    );
    if (mode === 'rpg') {
      // 真实 PG：挂在行锁上（UPDATE 已经发出去、等别的事务放锁），等满上限放弃；放锁之后那个 UPDATE 执行完也要回滚
      const f = await one(false);
      await su('begin');
      await su('select 1 from outbound_sends where channel_msgid = $1 for update', [f.i.msgid]);
      const rf = await ledger.markSending(f.i);
      await su('rollback');
      await sleep(300);
      await settle();
      check(
        'db_unavailable（挂在行锁上）之后放锁：UPDATE 执行完也回滚，库里仍是 pending',
        rf === 'db_unavailable' && (await dbRow(f.i.msgid))?.status === 'pending',
        json({ rf, row: await dbRow(f.i.msgid) }),
      );
    }
    const e = await one(false);
    faults.acquire = Object.assign(new Error('selftest: 连不上'), { code: '08006' });
    check('markSending：连不上库 → db_unavailable', (await ledger.markSending(e.i)) === 'db_unavailable');
    faults.acquire = null;
  }

  // ======== R6 的 A：pending 已提交、markSending 库不可用照发；放开之后结果直接从 pending 迁 ========
  {
    const a = await one(false);
    let open!: () => void;
    faults.gate = new Promise<void>((r) => (open = r));
    const unsafe: number[] = [];
    const off = ledger.onUnsafeSend((k) => void unsafe.push(k));
    const before = ledger.unsafeSendsIn10m();
    check('A：markSending 判 db_unavailable', (await ledger.markSending(a.i)) === 'db_unavailable');
    ledger.noteUnsafeSend(); // 适配器决定照发的那一刻
    ledger.noteAttempt(a.i);
    ledger.settleIntent(a.i, 'accepted', { attempts: 1 });
    check('A：没落库就发计一次、订阅者收到 10 分钟内的次数', ledger.unsafeSendsIn10m() === before + 1 && unsafe.at(-1) === before + 1);
    off();
    check('A：挡着的时候库里还是 pending', (await dbRow(a.i.msgid))?.status === 'pending');
    faults.gate = null;
    open();
    await agree('A：放开之后 pending 直接迁到 accepted', a.i.msgid, 'accepted');
  }

  // ======== R6 的 B：pending 等不到提交 → timeout → markSending 返回 absent 照发；放开之后同一次落库先插 pending、再迁 accepted ========
  {
    const { sid, s } = newSession();
    const m = reply(s, 'B 的回复');
    await settle();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // planOutbound 排完 pending 的那一刻挡住写库：这一次落库借不到连接
    ledger.__ledgerTest.setPlanHook(() => {
      faults.gate = gate;
    });
    const t0 = Date.now();
    const [i] = ledger.planOutbound(A1, target(sid), 'ai', m, null, [T('B 的回复')]);
    ledger.__ledgerTest.setPlanHook(null);
    const c = await ledger.commitOutbound([i!]);
    check('B：commitOutbound 等满上限 → timeout', c === 'timeout' && Date.now() - t0 >= 350, `${c} ${Date.now() - t0}ms`);
    // 库恢复了（之后的借连接放行），挡着的那一次落库还没进去：markSending 看不到这一行
    faults.gate = null;
    check('B：markSending → absent（这一组提交超时过，照发）', (await ledger.markSending(i!)) === 'absent');
    ledger.noteAttempt(i!);
    ledger.settleIntent(i!, 'accepted', { attempts: 1 });
    check('B：结果出来时库里还没有这一行', (await dbRow(i!.msgid)) === null);
    open();
    await agree('B：放开之后先插 pending、存档点里再迁 accepted', i!.msgid, 'accepted');
    check('B：kind、account_id、message_seq 都在', (await dbRow(i!.msgid))?.message_seq === seqOf(m));
  }

  // ======== R6 的 B 另一种：结果行先到、直接插成 accepted，之后晚到的 pending 插入什么都不改（没有会话的短事务） ========
  {
    const sid = 'wecom:wm08late';
    let open!: () => void;
    faults.gate = new Promise<void>((r) => (open = r));
    const gate = faults.gate;
    const [i] = ledger.planOutbound(A1, { sessionId: sid, hasSession: false }, 'welcome', null, null, [T('欢迎回来')]);
    // pending 的短事务挡在借连接上；之后的借连接放行
    faults.gate = null;
    ledger.settleIntent(i!, 'accepted', { attempts: 1 });
    check('结果先到：直接插成 accepted', await waitFor(async () => (await dbRow(i!.msgid))?.status === 'accepted', 3000));
    open();
    await gate;
    await sleep(150);
    await agree('结果先到：晚到的 pending 插入什么都不改', i!.msgid, 'accepted');
    check('结果先到：没有会话的行 conversation_id 照旧是将要用的会话 id、kind welcome', (await dbRow(i!.msgid))?.conversation_id === sid);
  }

  // ======== 回执先于这一行落库：内存里排着的那一行先改成 failed，落库时直接插成 failed ========
  {
    const sid = 'wecom:wm08rcpt';
    let open!: () => void;
    faults.gate = new Promise<void>((r) => (open = r));
    const [i] = ledger.planOutbound(A1, { sessionId: sid, hasSession: false }, 'welcome', null, null, [T('欢迎回来')]);
    faults.gate = null;
    ledger.onSendFail(i!.msgid, 6);
    await sleep(100);
    open();
    await agree('回执先到：插成 failed', i!.msgid, 'failed');
    ledger.settleIntent(i!, 'accepted', { attempts: 1 });
    await agree('回执先到：之后的结果写入不改它', i!.msgid, 'failed');
  }

  // ======== 回执先于消息追加：跟进的 pending 落库时 message_seq 为空，回执先把库里那一行记 failed，消息追加之后 seq 照样补上 ========
  {
    const { deliveryOfSegments } = await import('../shared/conversation-types.js');
    const { readOutboundForSeqs } = await import('../db/repo/outbound.js');
    const ctx = { tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const { sid, s } = newSession();
    await settle();
    // 跟进：送达之后才写进会话，所以这条消息这时还没有 seq
    const fu: ChatMessage = { role: 'agent', content: '跟进一下', at: Date.now(), author: 'followup' };
    const [a, b] = ledger.planOutbound(A1, target(sid), 'followup', fu, null, [T('跟进第一段'), T('跟进第二段')]);
    await ledger.commitOutbound([a!, b!]);
    check('回执先到：pending 落库时 message_seq 为空', (await dbRow(a!.msgid))?.message_seq === null);
    await ledger.markSending(a!);
    await ledger.markSending(b!);
    ledger.settleIntent(a!, 'accepted', { attempts: 1 }); // 第一段有了结果（等消息分到 seq 再写）
    ledger.onSendFail(a!.msgid, 4); // 第一段的失败回执先到（审查的场景）
    ledger.onSendFail(b!.msgid, 6); // 第二段的回执更早：结果还没出来就到了
    ledger.settleIntent(b!, 'accepted', { attempts: 1 }); // 之后的结果不改 failed
    await waitFor(async () => (await dbRow(a!.msgid))?.status === 'failed' && (await dbRow(b!.msgid))?.status === 'failed', 3000);
    check(
      '回执先到：库里两段先记 failed、message_seq 还是空的',
      (await dbRow(a!.msgid))?.message_seq === null && (await dbRow(b!.msgid))?.message_seq === null,
    );
    fu.at = Date.now();
    s.messages.push(fu); // 跟进推送返回之后才追加进会话
    store.saveSession(s, false);
    await sleep(50);
    await settle();
    const ra = await dbRow(a!.msgid);
    const rb = await dbRow(b!.msgid);
    check(
      '回执先于消息追加：两段都停在 failed，message_seq 补上了（补 seq 不是状态变化，failed 也补）',
      ra?.status === 'failed' &&
        rb?.status === 'failed' &&
        ra.message_seq === seqOf(fu) &&
        rb.message_seq === seqOf(fu) &&
        seqOf(fu) !== undefined,
      json({ ra, rb, seq: seqOf(fu) }),
    );
    const rows = await withTenant(db, ctx, (tx) => readOutboundForSeqs(tx, sid, [seqOf(fu)!]));
    check(
      '回执先于消息追加：工作台按 seq 读库查得到这条跟进的失败（带原因码）',
      json(deliveryOfSegments(rows)) === json({ status: 'failed', failType: 4 }),
      json(rows.map((r) => [r.status, r.failType])),
    );
    // 只许 NULL → 值：已有的 seq 不改，状态与结果也不动（迁移表没有放宽）
    const { insertOutboundSends } = await import('../db/repo/outbound.js');
    await withTenant(db, ctx, (tx) =>
      insertOutboundSends(tx, [
        {
          conversationId: sid,
          channelMsgid: a!.msgid,
          messageSeq: 9999,
          kind: 'followup',
          sentAt: new Date(),
          status: 'accepted',
          errcode: 1,
          failType: null,
          accountId: A1.id,
          attempts: 9,
        },
      ]),
    );
    const ra2 = await dbRow(a!.msgid);
    check(
      '补 seq 不放宽迁移表：对 failed 写 accepted 带别的 seq——状态、attempts、seq 都不变',
      ra2?.status === 'failed' && ra2.message_seq === seqOf(fu) && ra2.attempts === ra?.attempts,
      json(ra2),
    );
  }

  // ======== R21：结果写在存档点（写不进去只丢结果，会话照常提交、不 poisoned）；pending、cancelled 写在主事务 ========
  {
    const pg = () => store.__storeTest.pgStats()!;
    const a = await one(true);
    const dropped0 = pg().telemetryDropped;
    const note: ChatMessage = { role: 'agent', content: '同一次落库里的另一条', at: Date.now() };
    a.s.messages.push(note);
    store.saveSession(a.s);
    // attempts 超出 smallint：这一行结果写不进去（数据类错误）
    ledger.settleIntent(a.i, 'accepted', { attempts: 40_000 });
    await settle();
    const inDb = await su<{ n: number }>('select count(*)::int as n from messages where conversation_id = $1 and seq = $2', [
      a.sid,
      seqOf(note),
    ]);
    check(
      'R21：结果写不进去只丢结果——会话照常提交、没有 poisoned、遥测丢弃计数加 1，库里那一段还是 sending',
      inDb[0]?.n === 1 &&
        !store.storeHealth().poisoned.length &&
        pg().telemetryDropped === dropped0 + 1 &&
        (await dbRow(a.i.msgid))?.status === 'sending',
      json({ inDb, poisoned: store.storeHealth().poisoned, dropped: pg().telemetryDropped - dropped0, row: await dbRow(a.i.msgid) }),
    );
    // 同一次落库里：一行写不进去的结果（存档点回滚）、一组新的 pending、一行 cancelled —— 后两种在主事务，照样提交
    const b = await one(false);
    const { sid, s } = newSession();
    const m = reply(s, '主事务里的 pending');
    const c = await one(true);
    ledger.settleIntent(c.i, 'accepted', { attempts: 40_000 });
    const [p] = ledger.planOutbound(A1, target(sid), 'ai', m, null, [T('主事务里的 pending')]);
    ledger.cancelIntents([b.i], 'taken_over');
    await settle();
    check('R21：存档点回滚时，同一次落库的 pending 照样在库里', (await dbRow(p!.msgid))?.status === 'pending');
    check('R21：同一次落库的 cancelled 照样在库里', (await dbRow(b.i.msgid))?.status === 'cancelled');
  }

  // ======== planOutbound 的同步校验：不过就抛 OutboundPlanError，什么都不排 ========
  {
    const { sid, s } = newSession();
    const m = reply(s, 'x');
    const rejected: string[] = [];
    const off = ledger.onPlanRejected((r) => void rejected.push(r));
    const rowsBefore = ledger.__ledgerTest.rows(sid).length;
    const queued0 = store.__storeTest.pgQueuedChannel(sid);
    const bad: [string, () => unknown][] = [
      ['kind 是 card', () => ledger.planOutbound(A1, target(sid), 'card', m, null, [T('x')])],
      ['会话不属于这个账号', () => ledger.planOutbound(A2, target(sid), 'ai', m, null, [T('x')])],
      ['一段超过 16 KB', () => ledger.planOutbound(A1, target(sid), 'ai', m, null, [T('长'.repeat(6000))])],
      ['文本没过 cleanText（带 NUL）', () => ledger.planOutbound(A1, target(sid), 'ai', m, null, [T(`a${String.fromCharCode(0)}b`)])],
      ['空文本', () => ledger.planOutbound(A1, target(sid), 'ai', m, null, [T('')])],
      ['inboxId 不是 uuid', () => ledger.planOutbound(A1, target(sid), 'ai', m, 'not-a-uuid', [T('x')])],
      ['不认识的 msgtype', () => ledger.planOutbound(A1, target(sid), 'ai', m, null, [{ msgtype: 'image' } as unknown as Payload])],
    ];
    for (const [label, fn] of bad) {
      let threw = false;
      try {
        fn();
      } catch (e) {
        threw = e instanceof OutboundPlanError;
      }
      check(`校验：${label} → OutboundPlanError`, threw);
    }
    off();
    check(
      '校验没过：内存账本与写队列里什么都没排，告警订阅者收到原因',
      ledger.__ledgerTest.rows(sid).length === rowsBefore &&
        store.__storeTest.pgQueuedChannel(sid) === queued0 &&
        rejected.length === bad.length,
      json({ rows: ledger.__ledgerTest.rows(sid).length, rowsBefore, rejected }),
    );
  }

  // ======== 预占（holdSend）由第一段接过来（同一 msgid） ========
  {
    const { sid } = newSession();
    const msg: ChatMessage = { role: 'agent', content: '顾问的回复', at: Date.now(), author: 'human' };
    const release = ledger.holdSend(sid, 'human', msg);
    const held = ledger.__ledgerTest.rows(sid).find((r) => r.held)!;
    const intents = ledger.planOutbound(A1, target(sid), 'human', msg, null, [T('【顾问】顾问的回复'), T('第二段')]);
    release();
    check(
      '预占：第一段沿用预占那一行的 msgid，第二段新开；没有留下预占行',
      intents[0]?.msgid === held.msgid && intents[1]?.msgid !== held.msgid && !ledger.__ledgerTest.rows(sid).some((r) => r.held),
    );
    await ledger.commitOutbound(intents);
    check(
      '预占接过之后：库里两行都是 human、pending',
      (await dbRow(intents[0]!.msgid))?.kind === 'human' && (await dbRow(intents[1]!.msgid))?.status === 'pending',
    );
  }

  // ======== 工作台（内存与库里两条路同一张映射表）与窗口计数 ========
  {
    const { deliveryOfSegments } = await import('../shared/conversation-types.js');
    const { readOutboundForSeqs } = await import('../db/repo/outbound.js');
    const ctx = { tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const { sid, s } = newSession();
    const msgs: Record<string, ChatMessage> = {};
    const groups: Record<string, Intent[]> = {};
    for (const k of ['ok', 'sending', 'unknown', 'failed', 'cancelled']) {
      msgs[k] = reply(s, k);
      groups[k] = ledger.planOutbound(A1, target(sid), 'ai', msgs[k]!, null, [T(`${k}-1`), T(`${k}-2`)]);
      await ledger.commitOutbound(groups[k]!);
    }
    const g = groups;
    for (const i of g.ok!) {
      await ledger.markSending(i);
      ledger.settleIntent(i, 'accepted', { attempts: 1 });
    }
    await ledger.markSending(g.sending![0]!);
    ledger.settleIntent(g.sending![0]!, 'accepted', { attempts: 1 });
    await ledger.markSending(g.sending![1]!); // 回包挂着
    for (const i of g.unknown!) await ledger.markSending(i);
    ledger.settleIntent(g.unknown![0]!, 'accepted', { attempts: 1 });
    ledger.settleIntent(g.unknown![1]!, 'unknown', { attempts: 1 });
    for (const i of g.failed!) {
      await ledger.markSending(i);
      ledger.settleIntent(i, 'accepted', { attempts: 1 });
    }
    ledger.onSendFail(g.failed![1]!.msgid, 4);
    ledger.cancelIntents(g.cancelled!, 'taken_over');
    const want: Record<string, string> = {
      ok: 'accepted',
      sending: 'sending',
      unknown: 'unknown',
      failed: 'failed',
      cancelled: 'cancelled',
    };
    for (const [k, w] of Object.entries(want)) {
      check(`工作台（内存）：${k} 的那条 → ${w}`, ledger.deliveryOf(sid, msgs[k]!)?.status === w, json(ledger.deliveryOf(sid, msgs[k]!)));
    }
    check('工作台：failed 带原因码', ledger.deliveryOf(sid, msgs.failed!)?.failType === 4);
    await settle();
    await sleep(200);
    await settle();
    const rows = await withTenant(db, ctx, (tx) =>
      readOutboundForSeqs(
        tx,
        sid,
        Object.values(msgs).map((x) => seqOf(x)!),
      ),
    );
    for (const [k, w] of Object.entries(want)) {
      const got = deliveryOfSegments(rows.filter((r) => r.messageSeq === seqOf(msgs[k]!)));
      check(
        `工作台（库里的行，「看更早的消息」那条路）：${k} 的那条 → ${w}`,
        got?.status === w,
        json({ got, rows: rows.filter((r) => r.messageSeq === seqOf(msgs[k]!)).map((r) => r.status) }),
      );
    }
    check(
      '读接口放宽：库里账号的行带 account_id、状态是 03 的七种之一',
      rows.every((r) => r.accountId === A1.id) && rows.some((r) => r.status === 'cancelled'),
    );
    // 窗口：accepted 5 段、sending 1 段、unknown 1 段算已用；failed、cancelled 不算
    const w = ledger.sendWindow(sid, Date.now());
    check(
      '窗口：pending、sending 算进已用（accepted 5 + sending 1 + unknown 1 = 7 → 剩 0），failed、cancelled 不算',
      w.used === 7 && w.remaining === 0,
      json(w),
    );
    const { sid: sid2, s: s2 } = newSession();
    const m2 = reply(s2, 'p');
    ledger.planOutbound(A1, target(sid2), 'ai', m2, null, [T('p1'), T('p2')]);
    check('窗口：刚排进去的 pending 也算已用', ledger.sendWindow(sid2, Date.now()).used === 2);
  }

  // ======== 没落库就发：告警（channel）10 分钟内至多一条 ========
  {
    const alertMod = await import('../ops/alert.js');
    alertMod.__alertTest.reset();
    alertMod.__alertTest.stopTimer();
    alertMod.startAlerts();
    alertMod.__alertTest.stopTimer();
    const from = logs.length;
    ledger.noteUnsafeSend();
    ledger.noteUnsafeSend();
    const lines = logs.slice(from).filter((l) => l.includes('[alert]') && l.includes('没落库'));
    check(
      '告警：有「没落库就发」就推一条 channel 告警，10 分钟内不重复推',
      lines.length === 1 && /最近 10 分钟有 \d+ 段/.test(lines[0]!),
      json(lines),
    );
  }

  ledger.__ledgerTest.setWaits(null);
  await settle();
  reg.__channelsTest.reset();
  await close();
}
