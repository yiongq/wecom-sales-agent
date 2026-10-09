// 03 第 11 步：spill 与 poisoned 会话的渠道行（docs/architecture/03-channels-v2/spec.md「渠道行与会话落库（R21）」、R21、验收 8、
// 不变量 3 的 poisoned 例外）。02 的 spill 与 poisoned 由 store.selftest.ts 守，断言不改。
// 本文件带上 SPILL_CHANNEL_CHILD 再起自己（单进程 node --import tsx，超时 SIGKILL，不留孤儿）：
//   pglite：PGlite 上的 PG 会话后端（openPgBackend 直接开，各组一个租户），「库连接断开」是借连接时抛连接类错误：
//     一、验收 8 场景一：入站行已提交、会话落库失败、正常停机（drain 写不进去 → late → spill）写出带渠道段的 spill（在途快照的进
//         inflight.channel，排着的进 channel；trace、护栏事件、env 账号的账本行不写），恢复之后回放：入站与出站状态对上、客户消息只记一次、
//         渠道段与会话同一个事务（xmin 相同）；
//     二、poisoned 之后库断开：渠道行短事务写不进去、留在内存里每秒再试，停机时进 spill；回放时会话部分仍失败 → 渠道部分单独一个事务写进去、
//         文件改名 .failed；手写的 spill 里会话部分失败时沿用 flush_id 判定（在途那次已提交就不再写它的渠道行）；
//     三、验收 8 场景二（后端这一层）：违反 CHECK 的会话投影让会话 poisoned，之后再排两句的渠道行：经短事务落库、pending 与 replied 同一个
//         短事务、提交之后经 outboundCommitted 报回；库断开一下 1 秒后再试写进去；数据类错误那一批丢掉计数、后面的照写；在途（等着重试）的
//         那次落库还活着时短事务等它，不让后来的 replied 先到被迁移表当成表外丢掉；
//     四、旧版没有渠道段的 spill 照常回放；
//     五、验收 8 场景二（发送账本这一层）：store + 发送账本，poisoned 之后两句的 planOutbound → commitOutbound 等到短事务提交 → markSending
//         marked → 结果，不走「没落库就发」。
//   rpg（PG_TEST_URL 设了才跑）：同一套在真实 Postgres 上以 agent_app 跑，「库连接断开」是真的断开（库的连接上限设 0、已有连接被终止）。
// 不杀进程：poisoned 之后 SIGKILL、重启时由启动恢复的保底用 payload 补记那一种由第 10 步的恢复自测覆盖。
// 用法：npx tsx src/store/spill-channel.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InboxStateWrite } from '../db/repo/channel-inbox.js';
import type { OutboundWriteRow } from '../db/repo/outbound.js';
import type { GuardEventRow } from '../db/repo/traces.js';
import type { ChatMessage, Order, Session } from '../types.js';

const CHILD = process.env.SPILL_CHANNEL_CHILD ?? '';
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
// 父进程：起子进程
// ======================================================================================

async function parentMain(): Promise<never> {
  const varParent = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(varParent, { recursive: true });
  const ROOT = fs.mkdtempSync(path.join(varParent, 'spill-channel-selftest-'));
  process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

  const runChild = (mode: string, env: Record<string, string>) => {
    const resultFile = path.join(ROOT, `${mode}-${Date.now()}.json`);
    const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
      cwd: process.cwd(),
      env: { ...process.env, SPILL_CHANNEL_CHILD: mode, SPILL_CHANNEL_RESULT: resultFile, CONFIG_SOURCE: 'file', ...env },
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
    fails.push('CI 下必须设 PG_TEST_URL：spill 回放的事务边界与「库连接断开」要以 agent_app 在真实 Postgres 上跑一遍');
  }

  if (fails.length) {
    console.error(`SPILL-CHANNEL SELFTEST FAIL：${fails.length} 项（通过 ${pass} 项）`);
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log(
    `SPILL-CHANNEL SELFTEST PASS: ${pass} 项断言全通（spill 带渠道段、回放与会话同一事务 / 会话部分失败时渠道部分单独写 / ` +
      `poisoned 之后渠道行走短事务、断开时留在内存再试、停机进 spill / 旧版 spill 照常回放 / 发送账本在 poisoned 会话上照常提交` +
      `${realPg ? ' / 真实 PG' : '；真实 PG 部分未跑'}）`,
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
    await suite(mode);
  } catch (e) {
    fails.push(`子进程抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  Object.assign(console, orig);
  if (fails.length) for (const l of logs.slice(-150)) console.error(`  ${l}`);
  fs.writeFileSync(process.env.SPILL_CHANNEL_RESULT!, JSON.stringify({ pass, fails }));
  process.exit(0);
}

interface SpillDocShape {
  version: number;
  sessions: {
    id: string;
    poisoned: string | null;
    inflight: { channel?: { inbox: InboxStateWrite[]; outbound: (Omit<OutboundWriteRow, 'sentAt'> & { sentAt: unknown })[] } } | null;
    channel?: { inbox: InboxStateWrite[]; outbound: (Omit<OutboundWriteRow, 'sentAt'> & { sentAt: unknown })[] };
  }[];
}

async function suite(mode: string): Promise<void> {
  const varDir = process.env.VAR_DIR!;
  Object.assign(process.env, { LLM_MOCK: '1', PUBLIC_BASE_URL: '', ALERT_WEBHOOK_URL: '', FOLLOWUP_ENABLED: '' });
  const testing = await import('../db/testing.js');
  const { openPgBackend } = await import('./pg-backend.js');
  const { seqOf } = await import('./seq.js');
  const { sessionState, lastCustomerAtOf } = await import('./project.js');
  const { shortIdOf } = await import('../shared/conversation.js');
  type Db = import('../db/client.js').Db;

  let db: Db;
  let mainTenant: string;
  let slug: string;
  let su: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
  /** 落库经的那条「连接」上的故障注入：acquire 设了就让借连接抛它 */
  let faults: { acquire: Error | null };
  /** 库连接断开（PGlite：借连接抛连接类错误；真实 PG：库的连接上限设 0、已有连接全部终止）与恢复 */
  let down: () => Promise<void>;
  let up: () => Promise<void>;
  let close: () => Promise<void>;
  if (mode === 'rpg') {
    slug = 'sp11';
    const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!, { slug });
    const gated = await testing.openGatedDb(fx.urls.app);
    db = gated.db;
    faults = gated.faults;
    mainTenant = fx.tenantId;
    su = fx.query;
    const dbName = decodeURIComponent(new URL(fx.urls.app).pathname.slice(1));
    if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error('临时库名不合预期');
    down = async () => {
      // 当前库不能设 allow_connections false：连接上限设 0（超级用户不受它限制），agent_app 新连接得到 53300，再终止已有的连接
      await su(`alter database "${dbName}" connection limit 0`);
      await su('select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()');
    };
    up = async () => {
      await su(`alter database "${dbName}" connection limit -1`);
    };
    close = async () => {
      await up().catch(() => {});
      await gated.close();
      await fx.drop();
    };
  } else {
    slug = 'demo';
    const t = await testing.openTestDb();
    const fx = await testing.installPgSessionStore(t, { varDir, slug });
    db = fx.deps.db;
    faults = fx.faults;
    mainTenant = fx.deps.tenantId;
    su = <R>(text: string, params: unknown[] = []): Promise<R[]> =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<R>(text, params)).rows;
      });
    down = async () => {
      fx.faults.acquire = testing.fakeDbError('08006');
    };
    up = async () => {
      fx.faults.acquire = null;
    };
    close = () => t.close();
  }

  // ---------------- 夹具 ----------------
  const newTenant = async (s: string): Promise<string> =>
    (await su<{ id: string }>(`insert into tenants (slug, name, pack_id) values ($1, $1, 'travel') returning id`, [s]))[0]!.id;
  /** 一个库里的企微账号（这几组不起运行时，凭据不解密，随便填） */
  const newAccount = async (tenantId: string): Promise<string> => {
    const id = randomUUID();
    await su(
      `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
       values ($1, $2, 'a1', 'wecom_kf', 'a1', 'active', 'wecom:', 'corp11', 'kf11', decode('00', 'hex'), 'k11')`,
      [tenantId, id],
    );
    return id;
  };
  /** 一条已提交的入站（acceptPage 那一步）：received */
  const newInbox = async (tenantId: string, accountId: string, msgid: string, conv: string, text: string): Promise<string> =>
    (
      await su<{ id: string }>(
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, sent_at, state, payload)
         values ($1, $2, $3, 'message', $4, now(), 'received', $5::json) returning id::text as id`,
        [tenantId, accountId, msgid, conv, json({ content: text })],
      )
    )[0]!.id;
  interface InboxDb {
    state: string;
    reason: string | null;
    message_seq: number | null;
    nopay: boolean;
    xmin: string;
  }
  const inboxRow = async (id: string): Promise<InboxDb | null> =>
    (
      await su<InboxDb>(
        'select state, reason, message_seq, payload is null as nopay, xmin::text as xmin from channel_inbox where id = $1',
        [id],
      )
    )[0] ?? null;
  interface OutDb {
    status: string;
    nopay: boolean;
    xmin: string;
    message_seq: number | null;
    inbox_id: string | null;
    segment: number;
  }
  const outRow = async (msgid: string): Promise<OutDb | null> =>
    (
      await su<OutDb>(
        `select status, payload is null as nopay, xmin::text as xmin, message_seq, inbox_id::text as inbox_id, segment
         from outbound_sends where channel_msgid = $1`,
        [msgid],
      )
    )[0] ?? null;
  const convRow = async (id: string): Promise<{ last_seq: number; flush_id: string | null; xmin: string } | null> =>
    (
      await su<{ last_seq: number; flush_id: string | null; xmin: string }>(
        'select last_seq, flush_id::text as flush_id, xmin::text as xmin from conversations where id = $1',
        [id],
      )
    )[0] ?? null;
  const customerCount = async (conv: string, msgid: string): Promise<number> =>
    (
      await su<{ n: number }>(`select count(*)::int as n from messages where conversation_id = $1 and role = 'customer' and msgid = $2`, [
        conv,
        msgid,
      ])
    )[0]!.n;
  const newMsgid = (): string => randomUUID().replaceAll('-', '');
  const T = (content: string) => ({ msgtype: 'text' as const, text: { content } });
  const pending = (
    sid: string,
    msgid: string,
    accountId: string,
    inboxId: string | null,
    seq: number | null,
    segment: number,
    text: string,
  ): OutboundWriteRow => ({
    conversationId: sid,
    channelMsgid: msgid,
    messageSeq: seq,
    kind: 'ai',
    sentAt: new Date(),
    status: 'pending',
    errcode: null,
    failType: null,
    accountId,
    inboxId,
    segment,
    attempts: 0,
    payload: T(text),
  });
  const result = (p: OutboundWriteRow, status: 'accepted' | 'rejected' | 'unknown'): OutboundWriteRow => ({
    ...p,
    status,
    sentAt: new Date(),
    attempts: 1,
    payload: null,
  });
  /** env 账号（02）的一行账本：没有账号 uuid */
  const envRow = (sid: string, msgid: string): OutboundWriteRow => ({
    conversationId: sid,
    channelMsgid: msgid,
    messageSeq: null,
    kind: 'ai',
    sentAt: new Date(),
    status: 'accepted',
    errcode: null,
    failType: null,
  });
  const iw = (
    inboxId: string,
    state: InboxStateWrite['state'],
    messageSeq: number | null = null,
    reason: InboxStateWrite['reason'] = null,
  ): InboxStateWrite => ({ inboxId, state, reason, messageSeq });
  const guardRow = (): GuardEventRow => ({
    turnId: randomUUID(),
    ord: 0,
    guard: 'price',
    action: 'drop_sentence',
    removed: ['编的那句。'],
    added: [],
  });

  const committed: OutboundWriteRow[] = [];
  const open = async (tenantId: string, dir: string) => {
    const deps = {
      db,
      tenantId,
      varDir: dir,
      sessions: new Map<string, Session>(),
      orders: new Map<string, Order>(),
      onConflict() {},
      writable: () => true,
      outboundCommitted: (rows: readonly OutboundWriteRow[]) => void committed.push(...rows),
    };
    const b = await openPgBackend(deps);
    b.install();
    return { b, deps };
  };
  type Backend = Awaited<ReturnType<typeof open>>['b'];
  const newSession = (id: string): Session => ({
    id,
    channel: 'wecom',
    stage: 'greeting',
    profile: {},
    messages: [],
    orderIds: [],
    handedOver: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  /** 追加一条消息并 schedule（同步分到 seq） */
  const say = (b: Backend, s: Session, role: ChatMessage['role'], content: string, msgid?: string): ChatMessage => {
    const m: ChatMessage = { role, content, at: Date.now(), ...(msgid ? { msgid, sentAt: Date.now() } : {}) };
    s.messages.push(m);
    s.updatedAt = Date.now();
    b.schedule(s);
    return m;
  };
  const idle = (b: Backend, sid: string): Promise<boolean> => waitFor(() => !b.hasPendingWrite(sid));
  const spillFiles = (dir: string): string[] => fs.readdirSync(dir).filter((f) => /^store-spill-.+\.json$/.test(f));
  const readSpill = (dir: string): { file: string; raw: string; doc: SpillDocShape } | null => {
    const [name] = spillFiles(dir);
    if (!name) return null;
    const file = path.join(dir, name);
    const raw = fs.readFileSync(file, 'utf8');
    return { file, raw, doc: JSON.parse(raw) as SpillDocShape };
  };
  const mkdir = (name: string): string => fs.mkdtempSync(path.join(varDir, `${name}-`));
  const brief = (rows: { channelMsgid: string; status: string; segment?: number; inboxId?: string | null }[] | undefined): string =>
    (rows ?? []).map((r) => `${r.channelMsgid}:${r.status}:${r.segment ?? 0}:${r.inboxId ?? '-'}`).join(',');

  // ======== 一、验收 8 场景一：入站行已提交、会话落库失败（库连接断开）、正常停机写出 spill、恢复之后回放 ========
  {
    const tA = await newTenant('sp11a');
    const acc = await newAccount(tA);
    const dir = mkdir('a');
    const { b, deps } = await open(tA, dir);
    const sid = 'wecom:wm11sp1';
    const s = newSession(sid);
    deps.sessions.set(sid, s);
    // 第一句正常走完到 sending
    const I0 = await newInbox(tA, acc, 'm11a0', sid, '你好');
    const c0 = say(b, s, 'customer', '你好', 'm11a0');
    b.queueInbox(sid, [iw(I0, 'recorded', seqOf(c0)!)]);
    const r0 = say(b, s, 'agent', '您好，想去哪儿玩？');
    const X0 = newMsgid();
    const p0 = pending(sid, X0, acc, I0, seqOf(r0)!, 0, '您好，想去哪儿玩？');
    b.queueChannel(sid, [p0]);
    b.queueInbox(sid, [iw(I0, 'replied')]);
    await idle(b, sid);
    check(
      '场景一准备：第一句正常落库（replied 与 pending 一起提交）',
      (await inboxRow(I0))?.state === 'replied' && (await outRow(X0))?.status === 'pending',
    );
    check('场景一准备：第一句那一段 markSending 标上 sending', (await b.markOutboundSending(X0, 3000)) === 'marked');
    // 第二句的入站行已提交（acceptPage），之后库连接断开
    const I1 = await newInbox(tA, acc, 'm11a1', sid, '想去云南');
    await down();
    const retries0 = b.stats().retries;
    const ENV = newMsgid();
    b.queueTelemetry(sid, { outbound: [result(p0, 'accepted'), envRow(sid, ENV)], guards: [guardRow()] });
    b.queueInbox(sid, [iw(I0, 'done')]);
    check('库断开：这次落库失败、等着重试（成了在途快照）', await waitFor(() => b.stats().retries > retries0, 3000));
    const c1 = say(b, s, 'customer', '想去云南', 'm11a1');
    b.queueInbox(sid, [iw(I1, 'recorded', seqOf(c1)!)]);
    const r1 = say(b, s, 'agent', '云南很美\n几位出行？');
    const X1a = newMsgid();
    const X1b = newMsgid();
    b.queueChannel(sid, [pending(sid, X1a, acc, I1, seqOf(r1)!, 0, '云南很美'), pending(sid, X1b, acc, I1, seqOf(r1)!, 1, '几位出行？')]);
    b.queueInbox(sid, [iw(I1, 'replied')]);
    // 正常停机：drain 段写不进去 → late 段 → exit 时 spill
    const { undrained } = await b.drain(300);
    b.close();
    const n = b.spillSync();
    const sp = readSpill(dir);
    const se = sp?.doc.sessions.find((x) => x.id === sid);
    check(
      'spill：写出这个会话；外壳 version 仍是 1，条目带渠道段（第 11 步的条目级标记）',
      n === 1 &&
        undrained.includes(sid) &&
        sp?.doc.version === 1 &&
        Array.isArray(se?.channel?.inbox) &&
        Array.isArray(se?.channel?.outbound),
      json({ n, undrained, version: sp?.doc.version }),
    );
    check(
      'spill：失败等着重试的那次落库里的渠道行进 inflight.channel（done 与库里账号的出站结果，sent_at 存毫秒）',
      json(se?.inflight?.channel?.inbox) === json([iw(I0, 'done')]) &&
        brief(se?.inflight?.channel?.outbound) === `${X0}:accepted:0:${I0}` &&
        typeof se?.inflight?.channel?.outbound[0]?.sentAt === 'number',
      json(se?.inflight?.channel),
    );
    check(
      'spill：排着的渠道行进 channel（recorded 带这句的 seq、replied、两段 pending 带 payload）',
      json(se?.channel?.inbox) === json([iw(I1, 'recorded', seqOf(c1)!), iw(I1, 'replied')]) &&
        brief(se?.channel?.outbound) === `${X1a}:pending:0:${I1},${X1b}:pending:1:${I1}` &&
        (se?.channel?.outbound ?? []).every((r) => (r.payload as { text?: { content?: string } } | null)?.text?.content),
      json(se?.channel),
    );
    check(
      'spill：trace、护栏事件与 env 账号的账本行照旧不写',
      !!sp && !sp.raw.includes(ENV) && !sp.raw.includes('drop_sentence') && !/"guards"|"traces"/.test(sp.raw),
    );
    check(
      '库断开期间：库里还是断开之前的样子（第一句 replied、第二句 received、第一句那一段 sending、第二句的段不在）',
      (await inboxRow(I0))?.state === 'replied' &&
        (await inboxRow(I1))?.state === 'received' &&
        (await outRow(X0))?.status === 'sending' &&
        !(await outRow(X1a)),
    );
    await up();
    const r = await open(tA, dir);
    const cv = await convRow(sid);
    const i0 = await inboxRow(I0);
    const i1 = await inboxRow(I1);
    const x0 = await outRow(X0);
    const x1a = await outRow(X1a);
    const x1b = await outRow(X1b);
    check('回放：应用了 1 个会话、spill 文件删掉', r.b.stats().replayed === 1 && !!sp && !fs.existsSync(sp.file), json(r.b.stats()));
    check(
      '回放：入站状态对上（第一句 done、payload 已空；第二句 replied、message_seq 是这句的 seq、payload 还在）',
      i0?.state === 'done' && i0.nopay && i1?.state === 'replied' && i1.message_seq === seqOf(c1) && !i1.nopay,
      json({ i0, i1 }),
    );
    check(
      '回放：出站状态对上（第一句那一段 accepted、payload 已空；第二句两段 pending、带 payload、挂在第二句上）',
      x0?.status === 'accepted' &&
        x0.nopay &&
        x1a?.status === 'pending' &&
        !x1a.nopay &&
        x1a.inbox_id === I1 &&
        x1b?.status === 'pending' &&
        x1b.segment === 1,
      json({ x0, x1a, x1b }),
    );
    check(
      '回放：渠道段与会话部分同一个事务（会话行、两行入站、两段 pending 的 xmin 相同）',
      !!cv && [i0?.xmin, i1?.xmin, x1a?.xmin, x1b?.xmin].every((x) => x === cv.xmin),
      json({ cv: cv?.xmin, i0: i0?.xmin, i1: i1?.xmin, x1a: x1a?.xmin, x1b: x1b?.xmin }),
    );
    check(
      '回放：客户的两句在会话里各只记一次，会话到第二句的回复为止',
      (await customerCount(sid, 'm11a0')) === 1 && (await customerCount(sid, 'm11a1')) === 1 && cv?.last_seq === seqOf(r1),
    );
    check('回放：env 账号的那一行没进库（02 的 spill 不写账本行）', !(await outRow(ENV)));
    r.b.close();
  }

  // ======== 二、poisoned 之后库断开：留在内存、停机进 spill；回放时会话部分失败 → 渠道部分单独一个事务 ========
  {
    const tB = await newTenant('sp11b');
    const acc = await newAccount(tB);
    const dir = mkdir('b');
    const { b, deps } = await open(tB, dir);
    // id 超长（违反 conversations_id_check）：第一次落库就是数据类错误，会话 poisoned
    const L = `wecom:${'p'.repeat(195)}`;
    const s = newSession(L);
    deps.sessions.set(L, s);
    const I2 = await newInbox(tB, acc, 'm11b0', L, '在吗');
    const c2 = say(b, s, 'customer', '在吗', 'm11b0');
    b.queueInbox(L, [iw(I2, 'recorded', seqOf(c2)!)]);
    await waitFor(() => b.isPoisoned(L));
    check(
      'poisoned：失败的那次落库里的 recorded 移进单独短事务写进去（会话行不在库里，message_seq 照记）',
      (await waitFor(async () => (await inboxRow(I2))?.state === 'recorded')) &&
        (await inboxRow(I2))?.message_seq === seqOf(c2) &&
        !(await convRow(L)) &&
        b.stats().inboxDropped === 0,
      json(await inboxRow(I2)),
    );
    await down();
    const r2 = say(b, s, 'agent', '在的，您说');
    const X2 = newMsgid();
    b.queueChannel(L, [pending(L, X2, acc, I2, seqOf(r2)!, 0, '在的，您说')]);
    b.queueInbox(L, [iw(I2, 'replied')]);
    await sleep(1300); // 过了一次 1 秒的再试
    check(
      'poisoned + 库断开：短事务写不进去，留在内存里每秒再试（不丢、不计数）',
      !(await outRow(X2)) &&
        (await inboxRow(I2))?.state === 'recorded' &&
        b.queuedChannel(L) === 1 &&
        b.queuedInbox(L) === 1 &&
        b.stats().channelDropped === 0 &&
        b.stats().inboxDropped === 0,
      json({ ch: b.queuedChannel(L), ib: b.queuedInbox(L), st: b.stats() }),
    );
    await b.drain(200);
    b.close();
    const n = b.spillSync();
    const sp = readSpill(dir);
    const se = sp?.doc.sessions.find((x) => x.id === L);
    check(
      '停机：poisoned 会话写进 spill，poisoned 之后没写进去的渠道行在渠道段里',
      n === 1 &&
        !!se?.poisoned &&
        brief(se?.channel?.outbound) === `${X2}:pending:0:${I2}` &&
        json(se?.channel?.inbox) === json([iw(I2, 'replied')]),
      json(se?.channel),
    );
    await up();
    const r = await open(tB, dir);
    const i2 = await inboxRow(I2);
    const x2 = await outRow(X2);
    check(
      '回放：会话部分仍失败（id 超长）→ 渠道部分单独一个事务写进去，文件照 02 改名 .failed',
      r.b.stats().replayChannelOnly === 1 &&
        r.b.stats().replayFailedFiles === 1 &&
        !!sp &&
        fs.existsSync(`${sp.file}.failed`) &&
        !fs.existsSync(sp.file),
      json(r.b.stats()),
    );
    check(
      '回放：渠道状态对上（replied、pending 带 payload，两行同一个事务），会话行仍不在库里',
      i2?.state === 'replied' && x2?.status === 'pending' && !x2.nopay && i2.xmin === x2.xmin && !(await convRow(L)),
      json({ i2, x2 }),
    );
    r.b.close();
  }

  // ---- 二（续）：手写的 spill，会话部分失败时渠道部分沿用 flush_id 判定 ----
  {
    const tR = await newTenant('sp11r');
    const acc = await newAccount(tR);
    // 先正常落库两个会话（各两条），拿到库里的 flush_id
    const seedDir = mkdir('r-seed');
    const seed = await open(tR, seedDir);
    const R1 = 'wecom:wm11rp1';
    const R2 = 'wecom:wm11rp2';
    const sessions: Record<string, Session> = {};
    for (const id of [R1, R2]) {
      const s = newSession(id);
      seed.deps.sessions.set(id, s);
      say(seed.b, s, 'customer', '一', `${id.slice(-3)}-1`);
      say(seed.b, s, 'agent', '二');
      await idle(seed.b, id);
      sessions[id] = s;
    }
    seed.b.close();
    const f1 = (await convRow(R1))!.flush_id!;
    const f2 = (await convRow(R2))!.flush_id!;
    const Ia = await newInbox(tR, acc, 'm11ra', R1, 'a');
    const Ib = await newInbox(tR, acc, 'm11rb', R1, 'b');
    const Ic = await newInbox(tR, acc, 'm11rc', R2, 'c');
    const Id = await newInbox(tR, acc, 'm11rd', R2, 'd');
    const third: ChatMessage = { role: 'customer', content: '三', at: Date.now() };
    const entryOf = (id: string, flushId: string, over: Record<string, unknown>) => ({
      id,
      committedSeq: 1,
      // 在途那次其实提交了（库里的 flush_id 与 last_seq 是它的）：它的渠道行（把入站记 abandoned）不该再写
      inflight: {
        flushId,
        lastSeq: 2,
        audits: [],
        jobs: [],
        consents: [],
        channel: { inbox: [iw(id === R1 ? Ia : Ic, 'abandoned', null, 'resync')], outbound: [] },
      },
      flushId: randomUUID(),
      lastSeq: 3,
      windowStartSeq: 1,
      messages: [{ seq: 3, message: third }],
      state: sessionState({ ...sessions[id]!, messages: [] }),
      lastCustomerAt: lastCustomerAtOf([third]),
      orders: [],
      audits: [],
      jobs: [],
      consents: [],
      poisoned: null,
      channel: { inbox: [iw(id === R1 ? Ib : Id, 'recorded', 3)], outbound: [] },
      ...over,
    });
    // R1 的会话部分失败：订单金额为负（违反 orders_total_price_check）
    const badOrder = {
      order: {
        id: 'ord_bad11r',
        sessionId: R1,
        routeId: 'r-yunnan-mid',
        routeTitle: '云南',
        travelers: 2,
        departDate: '2026-11-01',
        totalPrice: -1,
        status: 'pending_payment',
        createdAt: Date.now(),
      },
      voided: null,
    };
    const dir = mkdir('r');
    const file = path.join(dir, 'store-spill-2026-01-01T00-00-00-000Z.json');
    fs.writeFileSync(
      file,
      json({ version: 1, tenant: tR, at: Date.now(), sessions: [entryOf(R1, f1, { orders: [badOrder] }), entryOf(R2, f2, {})] }),
    );
    const r = await open(tR, dir);
    const [ia, ib, ic, id] = [await inboxRow(Ia), await inboxRow(Ib), await inboxRow(Ic), await inboxRow(Id)];
    check(
      '手写 spill：会话部分失败的那一条，渠道部分单独写进去、沿用 flush_id 判定（在途那次已提交，它的 abandoned 不再写）',
      ia?.state === 'received' && ib?.state === 'recorded' && ib.message_seq === 3 && (await convRow(R1))?.last_seq === 2,
      json({ ia, ib }),
    );
    check(
      '手写 spill：回放成功的那一条同样沿用 flush_id 判定，渠道段与会话同一个事务',
      ic?.state === 'received' && id?.state === 'recorded' && id.xmin === (await convRow(R2))?.xmin && (await convRow(R2))?.last_seq === 3,
      json({ ic, id }),
    );
    check(
      '手写 spill：有一条失败 → 文件改名 .failed，计数对上',
      fs.existsSync(`${file}.failed`) && r.b.stats().replayed === 1 && r.b.stats().replayChannelOnly === 1,
      json(r.b.stats()),
    );
    r.b.close();
  }

  // ======== 三、验收 8 场景二（后端这一层）：poisoned 之后两句的渠道行经短事务落库 ========
  {
    const tC = await newTenant('sp11c');
    const acc = await newAccount(tC);
    const dir = mkdir('c');
    const { b, deps } = await open(tC, dir);
    const L = `wecom:${'c'.repeat(195)}`;
    const s = newSession(L);
    deps.sessions.set(L, s);
    say(b, s, 'customer', '第一次落库就写坏', 'm11c0');
    check('违反 CHECK 的会话投影（id 超长）→ 会话 poisoned', await waitFor(() => b.isPoisoned(L)));
    const tele0 = b.stats().telemetryDropped;
    for (const k of [1, 2]) {
      const J = await newInbox(tC, acc, `m11c${k}`, L, `第${k}句`);
      const c = say(b, s, 'customer', `第${k}句`, `m11c${k}`);
      b.queueInbox(L, [iw(J, 'recorded', seqOf(c)!)]);
      // 回复要等模型：recorded 的短事务早就提交了，pending 与 replied 来的时候没有在途的短事务可以捎带
      check(
        `poisoned 之后第 ${k} 句：recorded 经短事务落库（会话行不在库里，message_seq 照记）`,
        await waitFor(async () => (await inboxRow(J))?.state === 'recorded' && b.queuedInbox(L) === 0),
      );
      const rep = say(b, s, 'agent', `回第${k}句`);
      const Y = newMsgid();
      const p = pending(L, Y, acc, J, seqOf(rep)!, 0, `回第${k}句`);
      // planOutbound 的写法：pending 与 replied 在同一段同步代码里排
      b.queueChannel(L, [p]);
      b.queueInbox(L, [iw(J, 'replied')]);
      await waitFor(async () => (await outRow(Y))?.status === 'pending' && (await inboxRow(J))?.state === 'replied');
      const y = await outRow(Y);
      const j = await inboxRow(J);
      check(
        `poisoned 之后第 ${k} 句：recorded、replied 与 pending 经短事务落库，pending 与 replied 在同一个短事务（xmin 相同）`,
        y?.status === 'pending' && !y.nopay && j?.state === 'replied' && j.message_seq === seqOf(c) && y.xmin === j.xmin,
        json({ y, j }),
      );
      check(
        `poisoned 之后第 ${k} 句：提交之后经 outboundCommitted 报回同一个行对象（发送账本据此知道 pending 落库了）`,
        committed.includes(p),
      );
      check(`poisoned 之后第 ${k} 句：markSending 照常标上 sending`, (await b.markOutboundSending(Y, 3000)) === 'marked');
      b.queueTelemetry(L, { outbound: [result(p, 'accepted')], guards: [guardRow()] });
      b.queueInbox(L, [iw(J, 'done')]);
      check(
        `poisoned 之后第 ${k} 句：结果与 done 经短事务落库`,
        await waitFor(async () => (await outRow(Y))?.status === 'accepted' && (await inboxRow(J))?.state === 'done'),
        json({ y: await outRow(Y), j: await inboxRow(J) }),
      );
    }
    check(
      'poisoned 之后：渠道行一行没丢（channelDropped、inboxDropped 为 0）、内存里不留；护栏事件照 02 丢弃、每批计一次；会话行仍不在库里',
      b.stats().channelDropped === 0 &&
        b.stats().inboxDropped === 0 &&
        b.queuedChannel(L) === 0 &&
        b.queuedInbox(L) === 0 &&
        b.stats().telemetryDropped - tele0 === 2 &&
        !(await convRow(L)),
      json(b.stats()),
    );
    // 库断开一下：短事务写不进去 → 留在内存、1 秒后再试 → 库恢复之后写进去
    const J3 = await newInbox(tC, acc, 'm11c3', L, '第3句');
    await down();
    b.queueInbox(L, [iw(J3, 'abandoned', null, 'too_old')]);
    await sleep(400);
    check('poisoned + 库断开：短事务没写成，留在内存里', (await inboxRow(J3))?.state === 'received' && b.queuedInbox(L) === 1);
    await up();
    check(
      'poisoned + 库恢复：1 秒后再试、写进去',
      await waitFor(async () => (await inboxRow(J3))?.state === 'abandoned', 4000),
      json(await inboxRow(J3)),
    );
    // 数据类错误（只剩代码缺陷一种来源，这里用不存在的账号撞外键）：这一批丢掉、计数，之后的照写
    const d0 = b.stats().channelDropped;
    const bad = pending(L, newMsgid(), randomUUID(), null, null, 0, '坏的一行');
    b.queueChannel(L, [bad]);
    await waitFor(() => b.stats().channelDropped > d0);
    const Z = newMsgid();
    b.queueChannel(L, [pending(L, Z, acc, null, null, 0, '之后的一行')]);
    await waitFor(async () => (await outRow(Z))?.status === 'pending');
    check(
      'poisoned 之后短事务以数据类错误失败：这一批丢掉、计数，之后的照写',
      b.stats().channelDropped === d0 + 1 && !(await outRow(bad.channelMsgid)) && (await outRow(Z))?.status === 'pending',
      json(b.stats()),
    );
    b.close();
  }

  // ---- 三（续）：在途（等着重试）的那次落库还活着时被标 poisoned（window_corrupt）：短事务等它，后来的 replied 不先到 ----
  {
    const tW = await newTenant('sp11w');
    const acc = await newAccount(tW);
    const { b, deps } = await open(tW, mkdir('w'));
    const W = 'wecom:wm11wc1';
    const s = newSession(W);
    deps.sessions.set(W, s);
    say(b, s, 'customer', '你好', 'm11w0');
    await idle(b, W);
    const Iw = await newInbox(tW, acc, 'm11w1', W, '在吗');
    const retries0 = b.stats().retries;
    faults.acquire = testing.fakeDbError('08006');
    const c = say(b, s, 'customer', '在吗', 'm11w1');
    b.queueInbox(W, [iw(Iw, 'recorded', seqOf(c)!)]);
    await waitFor(() => b.stats().retries > retries0, 3000);
    faults.acquire = null;
    // 整体换成副本：严格模式抛 WindowCorruptError，会话 poisoned，在途的那次（带着 recorded）照常等着重试
    s.messages = s.messages.map((m) => ({ ...m }));
    b.schedule(s);
    check('window_corrupt：在途的那次落库还在时会话被标 poisoned', b.isPoisoned(W));
    b.queueInbox(W, [iw(Iw, 'replied')]);
    await sleep(150);
    check('短事务等在途的那次：它重试之前 replied 不先写（入站行还是 received）', (await inboxRow(Iw))?.state === 'received');
    check(
      '在途的那次重试提交（recorded）之后，短事务接着写 replied：入站行最后是 replied',
      await waitFor(async () => (await inboxRow(Iw))?.state === 'replied', 4000),
      json(await inboxRow(Iw)),
    );
    b.close();
  }

  // ======== 四、旧版没有渠道段的 spill 照常回放 ========
  {
    const tO = await newTenant('sp11o');
    const seed = await open(tO, mkdir('o-seed'));
    const O1 = 'wecom:wm11old1';
    const s = newSession(O1);
    seed.deps.sessions.set(O1, s);
    say(seed.b, s, 'customer', '一', 'm11o1');
    say(seed.b, s, 'agent', '二');
    await idle(seed.b, O1);
    seed.b.close();
    const O2 = 'wecom:wm11old2';
    const m3: ChatMessage = { role: 'customer', content: '三', at: Date.now() };
    const m1: ChatMessage = { role: 'customer', content: '新会话一', at: Date.now() };
    const m2: ChatMessage = { role: 'agent', content: '新会话二', at: Date.now() };
    // 02 写出的条目：没有 channel，inflight 也没有
    const old1 = {
      id: O1,
      committedSeq: 2,
      inflight: null,
      flushId: randomUUID(),
      lastSeq: 3,
      windowStartSeq: 1,
      messages: [{ seq: 3, message: m3 }],
      state: sessionState({ ...s, messages: [] }),
      lastCustomerAt: lastCustomerAtOf([m3]),
      orders: [],
      audits: [],
      jobs: [],
      consents: [],
      poisoned: null,
    };
    const old2 = {
      id: O2,
      committedSeq: 0,
      inflight: { flushId: randomUUID(), lastSeq: 1, audits: [], jobs: [], consents: [] },
      flushId: randomUUID(),
      lastSeq: 2,
      windowStartSeq: 1,
      messages: [
        { seq: 1, message: m1 },
        { seq: 2, message: m2 },
      ],
      state: sessionState({ ...newSession(O2), messages: [] }),
      lastCustomerAt: lastCustomerAtOf([m1]),
      orders: [],
      audits: [],
      jobs: [],
      consents: [],
      poisoned: null,
    };
    const dir = mkdir('o');
    const file = path.join(dir, 'store-spill-2026-01-01T00-00-00-000Z.json');
    fs.writeFileSync(file, json({ version: 1, tenant: tO, at: Date.now(), sessions: [old1, old2] }));
    const r = await open(tO, dir);
    check(
      '旧版 spill（条目与 inflight 都没有渠道段）：两条都照常回放、文件删掉、没有 .failed',
      r.b.stats().replayed === 2 &&
        r.b.stats().replayFailedFiles === 0 &&
        !fs.existsSync(file) &&
        !fs.existsSync(`${file}.failed`) &&
        (await convRow(O1))?.last_seq === 3 &&
        (await convRow(O2))?.last_seq === 2,
      json(r.b.stats()),
    );
    r.b.close();
  }

  // ======== 五、验收 8 场景二（发送账本这一层）：poisoned 之后客户再发两句，回复照常发，入站与出站行经短事务落库 ========
  {
    const store = await import('../store.js');
    await store.initSessionStore({ db, tenantId: mainTenant, tenantSlug: slug, varDir });
    const { sealSecrets } = await import('../channels/secrets.js');
    const keyBytes = Buffer.alloc(32, 9);
    const keyRing = { current: { id: 'k11', key: keyBytes }, all: new Map([['k11', keyBytes]]) };
    const accId = randomUUID();
    const { ct, keyId } = sealSecrets(
      keyRing,
      { tenantId: mainTenant, accountId: accId },
      { appSecret: 's11-app', callbackToken: 's11-cb', callbackAesKey: Buffer.alloc(32, 6).toString('base64').slice(0, 43) },
    );
    await su(
      `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
       values ($1, $2, 'a1', 'wecom_kf', 'a1', 'active', 'wecom:', 'corp11', 'kf11m', decode($3, 'hex'), $4)`,
      [mainTenant, accId, ct.toString('hex'), keyId],
    );
    const reg = await import('../channels/registry.js');
    await reg.initChannels({ db, tenantId: mainTenant, tenantSlug: slug, varDir, keyRing });
    const { loadedAccounts } = await import('../channels/accounts.js');
    const A1 = loadedAccounts().find((a) => a.key === 'a1')!;
    const ledger = await import('../quota/ledger.js');
    const L = `wecom:${'q'.repeat(195)}`;
    const s = store.getOrCreateSession(L, 'wecom');
    s.messages.push({ role: 'customer', content: '你好', at: Date.now(), msgid: 'm11q0', sentAt: Date.now() });
    store.saveSession(s);
    check(
      '发送账本这一层：违反 CHECK 的会话投影让会话 poisoned',
      await waitFor(() => store.storeHealth().poisoned.includes(shortIdOf(L))),
      json(store.storeHealth()),
    );
    const unsafe0 = ledger.unsafeSendsIn10m();
    for (const k of [1, 2]) {
      const J = await newInbox(mainTenant, A1.id, `m11q${k}`, L, `第${k}句`);
      const c: ChatMessage = { role: 'customer', content: `第${k}句`, at: Date.now(), msgid: `m11q${k}`, sentAt: Date.now() };
      s.messages.push(c);
      store.saveSession(s);
      store.queueInboxState(L, { inboxId: J, state: 'recorded', message: c });
      // 回复要等模型：recorded 的短事务早就提交了，pending 与 replied 来的时候没有在途的短事务可以捎带
      check(
        `poisoned 之后第 ${k} 句：recorded 经短事务落库`,
        await waitFor(async () => (await inboxRow(J))?.state === 'recorded' && store.__storeTest.pgQueuedInbox(L) === 0),
      );
      const rep: ChatMessage = { role: 'agent', content: `回第${k}句`, at: Date.now() };
      s.messages.push(rep);
      store.saveSession(s);
      const intents = ledger.planOutbound(A1, { sessionId: L, hasSession: true }, 'ai', rep, J, [T(`回第${k}句`)]);
      const t0 = Date.now();
      const cr = await ledger.commitOutbound(intents);
      const took = Date.now() - t0;
      const y = await outRow(intents[0]!.msgid);
      const j = await inboxRow(J);
      check(
        `poisoned 之后第 ${k} 句：commitOutbound 等到短事务提交（不是 5 秒超时）`,
        cr === 'committed' && took < 2000,
        json({ cr, took }),
      );
      check(
        `poisoned 之后第 ${k} 句：pending 与 replied 同一个短事务，recorded 的 message_seq 是这句的 seq`,
        y?.status === 'pending' && j?.state === 'replied' && y.xmin === j.xmin && j.message_seq === store.seqOf(c),
        json({ y, j }),
      );
      for (const i of intents) {
        check(
          `poisoned 之后第 ${k} 句：markSending marked（pending 在库里，不走「没落库就发」）`,
          (await ledger.markSending(i)) === 'marked',
        );
        ledger.noteAttempt(i);
        ledger.settleIntent(i, 'accepted', { attempts: 1 });
      }
      store.queueInboxState(L, { inboxId: J, state: 'done' });
      check(
        `poisoned 之后第 ${k} 句：结果 accepted 与入站 done 经短事务落库`,
        await waitFor(async () => (await outRow(intents[0]!.msgid))?.status === 'accepted' && (await inboxRow(J))?.state === 'done'),
        json({ y: await outRow(intents[0]!.msgid), j: await inboxRow(J) }),
      );
    }
    check('poisoned 之后：没有一段「没落库就发」（unsafeSendsIn10m 不变）', ledger.unsafeSendsIn10m() === unsafe0);
    check(
      'poisoned 之后：内存照旧服务（两句与回复都在），会话行仍不在库里',
      s.messages.filter((m) => m.role === 'agent').length === 2 && !(await convRow(L)),
    );
  }

  await close();
}
