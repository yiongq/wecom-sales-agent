// 外部通知的自测（docs/architecture/02-conversations-workbench/spec.md「通知」、R13、不变量 10 的例外、32、验收 15 的外部通道部分；
// plan 第 14 步）。父进程跑纯函数（标题、正文、链接、排程），再带上 NOTIFY_CHILD 起一次自己（单进程 node --import tsx，超时 SIGKILL）：
//   main：PGlite 上装 DB 配置与 db 会话存储，进程内一个假的企微群机器人（记下每条消息、按短码让它失败或变慢）与一个假模型。
//         started 立即发、内容里没有客户原话、external_userid 与会话原 id；已成交客户与紧急情况在标题上标出来；unclaimed 有人接手时
//         不发、没人接手时发；交还之后再转人工，旧的那组到点不串；窗口剩不到 4 小时（发、窗口后移顺延、顾问回过了顺延、关了 done）；
//         待确认的订单；发送失败抛出、按 max_attempts 重试到 failed（HTTP 500、errcode、超时、连不上）；没配 URL 只 warn 不算失败；
//         分道认领（早上 9 点积压 20 条跟进、每条生成话术 2 秒，同时到点的通知几秒内发出）；库写不进去（PGlite 上让借连接失败）时
//         的 unsaved 通知：emergency 立即、其余失败持续够久之后、期间提交了就不发、同一次只发一次、提交成功后不补发（内存记录与
//         payload 的 unsavedSent 各兜一种）、发不出去就忘掉、提交之后照常提醒、会话停写（poisoned）也发；日志与 last_error 里没有
//         webhook 地址。
// 子进程预加载 src/store/parity-clock.ts，钟从当天本地 12:00 起走（跟进的夜间时段不碍事）。
// 用法：npx tsx src/notify/notify.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { Session } from '../types.js';

const CHILD = process.env.NOTIFY_CHILD ?? '';
const SELF = fileURLToPath(import.meta.url);
const CLOCK_MODULE = fileURLToPath(new URL('../store/parity-clock.ts', import.meta.url));
/** webhook 地址里的 key：等同密钥，日志、last_error、消息里都不能出现 */
const SECRET = 'NOTIFYSECRETKEY0042';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const json = (v: unknown): string => JSON.stringify(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(10);
  }
  return cond();
}

interface ChildResult {
  pass: number;
  fails: string[];
}

if (CHILD) await childMain();
else await parentMain();

// ======================================================================================
// 父进程：纯函数
// ======================================================================================

async function parentMain(): Promise<never> {
  const { handoffNoticeTitle, HANDOFF_NOTICE_TEXT, channelCustomerLabel } = await import('../shared/conversation.js');
  const { noticeText, workbenchLink, UNSAVED_MARK } = await import('./notifier.js');
  const { handoffNotifyOps, orderUnconfirmedNotifyOps, HANDOFF_UNCLAIMED_MS, WINDOW_NOTICE_MS } = await import('../jobs/notify.js');

  const base = { label: '企微客户', shortId: '7F3A', paidCustomer: false };
  check('标题：普通转人工「企微客户 · 7F3A 等人接手」', handoffNoticeTitle({ ...base, kind: 'complaint' }) === '企微客户 · 7F3A 等人接手');
  check('标题：紧急情况「紧急 · 企微客户 · 7F3A」', handoffNoticeTitle({ ...base, kind: 'emergency' }) === '紧急 · 企微客户 · 7F3A');
  check(
    '标题：已成交客户「已成交客户要人工 · 企微客户 · 7F3A」',
    handoffNoticeTitle({ ...base, kind: 'refund', paidCustomer: true }) === '已成交客户要人工 · 企微客户 · 7F3A',
  );
  check(
    '标题：两样都是时紧急在前',
    handoffNoticeTitle({ ...base, kind: 'emergency', paidCustomer: true }) === '紧急 · 已成交客户要人工 · 企微客户 · 7F3A',
  );
  check('标题：待确认的订单', handoffNoticeTitle({ ...base, kind: 'order_unconfirmed' }) === '企微客户 · 7F3A 等你确认价格');
  check(
    '会话标签：渠道短名加客户的叫法',
    channelCustomerLabel('wecom', '客户') === '企微客户' && channelCustomerLabel('simulator', '学员') === '网页学员',
  );
  const forbidden = ['待人工', '已转人工', '待接管', '需要介入'];
  const texts = Object.values(HANDOFF_NOTICE_TEXT);
  check(
    '类型的中文：每一类都有，不用禁用的状态词',
    texts.length === 14 && texts.every((t) => t && !forbidden.some((w) => t.includes(w))),
    json(HANDOFF_NOTICE_TEXT),
  );

  process.env.PUBLIC_BASE_URL = 'https://console.example.test/';
  const link = workbenchLink();
  check(
    '工作台链接：PUBLIC_BASE_URL + /console/conversations?state=human，不带会话 id',
    link === 'https://console.example.test/console/conversations?state=human',
    link,
  );
  const at = new Date(2026, 9, 3, 14, 5).getTime();
  const text = noticeText({ ...base, kind: 'complaint', at, link, unsaved: false }, at);
  check(
    '正文：标题、类型的中文、时间、链接四行',
    text === `企微客户 · 7F3A 等人接手\n客户要投诉\n转人工时间：10月3日 14:05\n打开工作台：${link}`,
    text,
  );
  const unsavedText = noticeText({ ...base, kind: 'emergency', at, link, unsaved: true }, at);
  check(
    '正文：unsaved 的标出「记录暂未保存」',
    unsavedText.startsWith('紧急 · 企微客户 · 7F3A\n客户遇到紧急情况\n') && unsavedText.includes(`\n${UNSAVED_MARK}：`),
    unsavedText,
  );
  check(
    '正文：窗口与订单的时间写明是什么时间',
    noticeText({ ...base, kind: 'window_closing', at, link, unsaved: false }, at).includes('窗口关闭时间：10月3日 14:05') &&
      noticeText({ ...base, kind: 'order_unconfirmed', at, link, unsaved: false }, at).includes('下单时间：10月3日 14:05'),
  );

  // 排程（第 10 步的两个之外，第 14 步加窗口那一个与 payload 的 kind、handoffCount）
  const T = 1_000_000;
  const ops = handoffNotifyOps('wecom:wmX', T, {
    escalated: false,
    kind: 'complaint',
    handoffCount: 2,
    windowClosesAt: T + 48 * 3_600_000,
  });
  const runAts = ops.map((o) => (o.op === 'enqueue' ? o.runAt : -1));
  const keys = ops.map((o) => (o.op === 'enqueue' ? o.dedupeKey : ''));
  check(
    '排程：立即、10 分钟、窗口关闭前 4 小时三个，键里带转人工时刻，payload 带类型与进入次数',
    json(runAts) === json([T, T + HANDOFF_UNCLAIMED_MS, T + 48 * 3_600_000 - WINDOW_NOTICE_MS]) &&
      json(keys) ===
        json([
          `handoff_notify:wecom:wmX:${T}:started`,
          `handoff_notify:wecom:wmX:${T}:unclaimed`,
          `handoff_notify:wecom:wmX:${T}:window`,
        ]) &&
      ops.every(
        (o) => o.op === 'enqueue' && json(o.payload).includes('"kind":"complaint"') && json(o.payload).includes('"handoffCount":2'),
      ),
    json(ops),
  );
  const late = handoffNotifyOps('wecom:wmX', T, { escalated: false, windowClosesAt: T + 3_600_000 });
  const closed = handoffNotifyOps('wecom:wmX', T, { escalated: false, windowClosesAt: T - 1 });
  const up = handoffNotifyOps('wecom:wmX', T, { escalated: true, kind: 'emergency', windowClosesAt: T + 48 * 3_600_000 });
  check(
    '排程：窗口已经不到 4 小时就现在排；窗口已关不排；升级只排立即的那一个',
    late.length === 3 &&
      late[2]!.op === 'enqueue' &&
      late[2]!.runAt === T &&
      closed.length === 2 &&
      up.length === 1 &&
      up[0]!.op === 'enqueue' &&
      up[0]!.dedupeKey.endsWith(':started'),
    json({ late, closed, up }),
  );
  const order = orderUnconfirmedNotifyOps('wecom:wmX', 'ord_abc', T);
  check(
    '排程：待确认的订单一个，payload 带 sessionId 与订单号',
    order.length === 1 &&
      order[0]!.op === 'enqueue' &&
      order[0]!.kind === 'handoff_notify' &&
      order[0]!.runAt === T &&
      json(order[0]!.payload) === json({ sessionId: 'wecom:wmX', reason: 'order_unconfirmed', orderId: 'ord_abc' }),
    json(order),
  );

  // ---- 子进程 ----
  const varParent = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(varParent, { recursive: true });
  const ROOT = fs.mkdtempSync(path.join(varParent, 'wecom-notify-selftest-'));
  process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
  const resultFile = path.join(ROOT, 'main.json');
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', CLOCK_MODULE, SELF], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NOTIFY_CHILD: 'main',
      NOTIFY_RESULT: resultFile,
      CONFIG_SOURCE: 'file',
      PARITY_CLOCK_MS: String(new Date().setHours(12, 0, 0, 0)),
      VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'main-')),
    },
    timeout: 240_000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let result: ChildResult | null = null;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as ChildResult;
  } catch {
    result = null;
  }
  if (!result) fails.push(`main：子进程没留下结果（status=${r.status} signal=${r.signal}）${out.slice(-2000)}`);
  else {
    pass += result.pass;
    for (const f of result.fails) fails.push(`main：${f}`);
  }
  check('main 子进程正常结束', r.status === 0, `status=${r.status} signal=${r.signal} ${out.slice(-1500)}`);

  if (fails.length) {
    console.error(`NOTIFY SELFTEST FAIL：${fails.length} 项（通过 ${pass} 项）`);
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log(
    `NOTIFY SELFTEST PASS: ${pass} 项断言全通（标题与正文 / 排程 / 立即发且内容不含原话与客户标识 / 已成交与紧急 / 有人接手不发 / ` +
      '交还后再转人工不串 / 窗口剩不到 4 小时（额度用完也照发、只发一次） / 待确认的订单 / 失败按 max_attempts 重试到 failed / 没配 URL 只 warn / 分道认领 / ' +
      'unsaved：紧急立即、其余等够、期间提交不发、只发一次、提交后不补发、发不出去照常提醒、停写也发 / 日志里没有地址）',
  );
  process.exit(0);
}

// ======================================================================================
// 子进程
// ======================================================================================

/** 假的企微群机器人收到的一条（含失败的那几次） */
interface Hit {
  at: number;
  content: string;
  ok: boolean;
}

async function childMain(): Promise<never> {
  const save = (): void => fs.writeFileSync(process.env.NOTIFY_RESULT!, JSON.stringify({ pass, fails } satisfies ChildResult));
  // 日志全记下来（照常打印）：最后断言里面没有 webhook 地址
  const logs: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      logs.push(format(...args));
      orig(...args);
    };
  }

  // ---- 假的企微群机器人：按短码失败（500 / errcode）或变慢 ----
  const hits: Hit[] = [];
  const failHttp = new Set<string>();
  const failErrcode = new Set<string>();
  const slow = new Map<string, number>();
  const hook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let content = '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { msgtype?: string; text?: { content?: string } };
        content = body.msgtype === 'text' ? (body.text?.content ?? '') : `!msgtype=${String(body.msgtype)}`;
      } catch {
        content = '!bad-json';
      }
      const code = [...failHttp, ...failErrcode, ...slow.keys()].find((c) => content.includes(c));
      const reply = (): void => {
        const http500 = code !== undefined && failHttp.has(code);
        const errcode = code !== undefined && failErrcode.has(code);
        hits.push({ at: Date.now(), content, ok: !http500 && !errcode });
        res.statusCode = http500 ? 500 : 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(errcode ? { errcode: 93000, errmsg: 'invalid webhook url' } : { errcode: 0, errmsg: 'ok' }));
      };
      const delay = code !== undefined ? slow.get(code) : undefined;
      if (delay) setTimeout(reply, delay);
      else reply();
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hook.unref();
  const hookPort = (hook.address() as AddressInfo).port;
  const HOOK_URL = `http://127.0.0.1:${hookPort}/cgi-bin/webhook/send?key=${SECRET}`;
  /** 某个短码收到的、发成功了的消息 */
  const okFor = (code: string): Hit[] => hits.filter((h) => h.ok && h.content.includes(code));
  const allFor = (code: string): Hit[] => hits.filter((h) => h.content.includes(code));

  // ---- 假模型：回一句；delayMs 设了就每次晚这么久才回（分道认领用） ----
  const llm = { delayMs: 0, calls: 0 };
  const fake = http.createServer((req, r) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/embeddings')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] };
        r.end(JSON.stringify({ data: (body.input ?? []).map((_, i) => ({ embedding: [1, i % 3, 2] })), usage: { prompt_tokens: 5 } }));
        return;
      }
      llm.calls += 1;
      const send = (): void => {
        if (r.writableEnded || r.destroyed) return;
        r.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '好的，九寨沟这条线很适合一家人，您几号出发？' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        );
      };
      if (llm.delayMs) setTimeout(send, llm.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fake.unref();
  const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    LLM_MOCK: '0',
    LLM_PROVIDER: '',
    LLM_BASE_URL: fakeUrl,
    LLM_API_KEY: 'selftest-fake-key',
    LLM_MODEL: 'glm-5.3-flashx',
    LLM_MODEL_CHEAP: '',
    EMBED_BASE_URL: fakeUrl,
    EMBED_API_KEY: 'selftest-fake-key',
    LLM_HEDGE_MODEL: '',
    LLM_MAX_RETRY: '0',
    LLM_TIMEOUT_MS: '600000',
    FOLLOWUP_ENABLED: '0',
    DEMO_PRUNE_HOURS: '0',
    PUBLIC_BASE_URL: 'https://console.example.test',
    NOTIFY_WEBHOOK_URL: HOOK_URL,
  });

  try {
    await childSuite({ hits, okFor, allFor, failHttp, failErrcode, slow, llm, logs, HOOK_URL });
  } catch (e) {
    fails.push(`子进程抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  save();
  process.exit(0);
}

interface Rig {
  hits: Hit[];
  okFor(code: string): Hit[];
  allFor(code: string): Hit[];
  failHttp: Set<string>;
  failErrcode: Set<string>;
  slow: Map<string, number>;
  llm: { delayMs: number; calls: number };
  logs: string[];
  HOOK_URL: string;
}

async function childSuite(rig: Rig): Promise<void> {
  const { hits, okFor, allFor, failHttp, failErrcode, slow, llm, logs } = rig;
  const store = await import('../store.js');
  const { openTestDb, installSeededConfig, installPgSessionStore, fakeLock, fakeDbError } = await import('../db/testing.js');
  const t = await openTestDb();
  const lock = fakeLock();
  await installSeededConfig(t, { deps: { lock: async () => lock } });
  const fx = await installPgSessionStore(t, { varDir: process.env.VAR_DIR! });
  await store.initSessionStore(fx.deps);
  const runner = await import('../jobs/runner.js');
  const { handleMessage } = await import('../engine.js');
  const { enterHandoff, HANDOFF_REASON } = await import('../handoff/record.js');
  const { orderUnconfirmedNotifyOps, HANDOFF_UNCLAIMED_MS, WINDOW_NOTICE_MS } = await import('../jobs/notify.js');
  const { sendWindow, recordSend } = await import('../quota/ledger.js');
  const { __handoffNotifyTest } = await import('./handoff.js');
  const { __notifierTest } = await import('./notifier.js');
  const { deliverHandoffUnsaved } = await import('../store/events.js');
  const pushes: string[] = [];
  runner.__jobsTest.start(async (id) => {
    pushes.push(id);
    return true;
  });

  const H = 3_600_000;
  /** 以超级用户查：一个事务里临时换回会话用户 */
  const su = <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  interface JobView {
    key: string;
    status: string;
    attempts: number;
    runAt: number;
    lastError: string | null;
    payload: Record<string, unknown>;
  }
  const jobsFor = async (sid: string, kind = 'handoff_notify'): Promise<JobView[]> =>
    (
      await su<{
        dedupe_key: string;
        status: string;
        attempts: number;
        run_at: Date | string;
        last_error: string | null;
        payload: unknown;
      }>(
        `select dedupe_key, status, attempts, run_at, last_error, payload from jobs where payload->>'sessionId' = $1 and kind = $2 order by created_at, dedupe_key`,
        [sid, kind],
      )
    ).map((r) => ({
      key: r.dedupe_key,
      status: r.status,
      attempts: r.attempts,
      runAt: new Date(r.run_at).getTime(),
      lastError: r.last_error,
      payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
    }));
  const job = async (sid: string, reason: string): Promise<JobView | undefined> =>
    (await jobsFor(sid)).find((j) => j.payload.reason === reason);
  const flush = (sid: string) => store.flushSession(sid, { timeoutMs: 5000 });
  /** 一组场景开始之前：别的会话还排着的任务全取消，拨钟认领时碰不到它们 */
  const retireAll = () => su(`update jobs set status = 'cancelled', finished_at = now() where status = 'pending'`);
  const id = (code: string): string => `wecom:wmNtf${code}`;
  /** 用到过的会话：最后核对消息里没有它们的原 id、external_userid 与客户原话 */
  const used: string[] = [];
  const ask = async (code: string, text: string) => {
    if (!used.includes(id(code))) used.push(id(code));
    const r = await handleMessage(id(code), text, 'wecom');
    await flush(id(code));
    return r;
  };
  /** 直接造一个企微会话：客户 ago 之前说过一句、AI 答了 */
  const seeded = (code: string, ago: number): Session => {
    const s = store.getOrCreateSession(id(code), 'wecom');
    used.push(s.id);
    const at = Date.now() - ago;
    s.messages.push(
      { role: 'customer', content: '想问问那条线路的安排', at, sentAt: at },
      { role: 'agent', content: '好的，您说', at: at + 1000 },
    );
    s.updatedAt = at + 1000;
    store.saveSession(s, false);
    return s;
  };
  const handOver = async (s: Session, at = Date.now()) => {
    enterHandoff(s, { kind: 'agent', at, reason: HANDOFF_REASON.agent });
    store.saveSession(s);
    await flush(s.id);
  };
  const LINK = 'https://console.example.test/console/conversations?state=human';

  // ---- started 立即发：类型、短码、时间、链接；没有客户原话、external_userid 与会话原 id（不变量 32） ----
  {
    await retireAll();
    await ask('NA01', '我们一家五口想去九寨沟，我手机号13800138000，老人72岁');
    const r = await ask('NA01', '我要投诉');
    const s = store.getSession(id('NA01'))!;
    const t0 = Date.now();
    await runner.runJobsOnce();
    const got = okFor('NA01');
    const j = await job(id('NA01'), 'started');
    check(
      'started：转人工提交后认领一批就发出（5 秒之内）',
      r.handoff === true &&
        s.handoff?.kind === 'complaint' &&
        got.length === 1 &&
        got[0]!.at - t0 < 5000 &&
        j?.status === 'done' &&
        j.lastError === null,
      json({ hits: got, j }),
    );
    const lines = got[0]?.content.split('\n') ?? [];
    check(
      'started：标题、类型的中文、转人工时间、工作台链接（不带会话 id）',
      lines.length === 4 &&
        lines[0] === '企微客户 · NA01 等人接手' &&
        lines[1] === '客户要投诉' &&
        /^转人工时间：\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/.test(lines[2]!) &&
        lines[3] === `打开工作台：${LINK}`,
      json(lines),
    );
  }

  // ---- 已成交客户要人工、紧急情况：标题上标出来（与浏览器通知的写法一致） ----
  {
    await retireAll();
    const P = store.getOrCreateSession(id('NP01'), 'wecom');
    used.push(P.id);
    P.messages.push({ role: 'customer', content: '付好款了', at: Date.now() - 60_000 });
    P.stage = 'paid';
    store.saveSession(P);
    await ask('NP01', '我要退款');
    await ask('NE01', '孩子走丢了');
    await runner.runJobsOnce();
    const paid = okFor('NP01');
    const emergency = okFor('NE01');
    check(
      '已成交客户要人工：阶段仍是已成交，标题「已成交客户要人工 · 企微客户 · NP01」',
      store.getSession(id('NP01'))!.stage === 'paid' &&
        paid.length === 1 &&
        paid[0]!.content.startsWith('已成交客户要人工 · 企微客户 · NP01\n'),
      json(paid),
    );
    check(
      '紧急情况：标题「紧急 · 企微客户 · NE01」，正文是类型的中文',
      emergency.length === 1 && emergency[0]!.content.startsWith('紧急 · 企微客户 · NE01\n客户遇到紧急情况\n'),
      json(emergency),
    );
  }

  // ---- unclaimed：10 分钟后有人接手的不发（done），没人接手的发「还没人接手」 ----
  {
    await retireAll();
    await ask('NB01', '麻烦帮我找一下人工客服');
    await ask('NC01', '麻烦帮我找一下人工客服');
    await runner.runJobsOnce();
    const B = store.getSession(id('NB01'))!;
    B.assignee = { userId: null, name: '共享工作台', at: Date.now() };
    store.saveSession(B);
    await flush(B.id);
    const at = Math.max(B.handoff!.at, store.getSession(id('NC01'))!.handoff!.at);
    await runner.runJobsOnce(at + HANDOFF_UNCLAIMED_MS + 1000);
    const jb = await job(B.id, 'unclaimed');
    const jc = await job(id('NC01'), 'unclaimed');
    check(
      'unclaimed：有人接手了就不发，记 done（assigned）',
      okFor('NB01').length === 1 && jb?.status === 'done' && jb.lastError === 'assigned',
      json({ hits: okFor('NB01'), jb }),
    );
    const c = okFor('NC01');
    check(
      'unclaimed：10 分钟仍没人接手再发一条「还没人接手」',
      c.length === 2 &&
        c[1]!.content.startsWith('企微客户 · NC01 等人接手\n转人工 10 分钟了，还没人接手\n') &&
        jc?.status === 'done' &&
        jc.lastError === null,
      json({ c, jc }),
    );
  }

  // ---- 交还之后再转人工：两次各有一组任务，旧的那组到点认得出不是这一次（不串） ----
  {
    await retireAll();
    await ask('ND01', '麻烦帮我找一下人工客服');
    const s = store.getSession(id('ND01'))!;
    const at1 = s.handoff!.at;
    await runner.runJobsOnce();
    // 交还（第 13 步的 release 之前，按 spec 清三样、恢复阶段）
    s.handedOver = false;
    delete s.handoff;
    s.assignee = null;
    s.stage = s.stageBeforeHandoff ?? 'discovery';
    store.saveSession(s);
    await flush(s.id);
    await sleep(5);
    await ask('ND01', '还是帮我找一下人工客服吧');
    const at2 = s.handoff!.at;
    // 旧写法的任务（第 14 步之前排的，payload 没有 handoffCount）：按 handoffAt 认
    await su(
      `insert into jobs (tenant_id, kind, dedupe_key, run_at, max_attempts, payload) values ($1, 'handoff_notify', $2, $3::timestamptz, 4, $4::json)`,
      [
        fx.deps.tenantId,
        `legacy:${s.id}`,
        new Date(at1 + HANDOFF_UNCLAIMED_MS).toISOString(),
        json({ sessionId: s.id, reason: 'unclaimed', handoffAt: at1 }),
      ],
    );
    await runner.runJobsOnce(at2 + HANDOFF_UNCLAIMED_MS + 1000);
    const all = await jobsFor(s.id);
    const old = all.find((j) => j.key === `handoff_notify:${s.id}:${at1}:unclaimed`);
    const fresh = all.find((j) => j.key === `handoff_notify:${s.id}:${at2}:unclaimed`);
    const legacy = all.find((j) => j.key === `legacy:${s.id}`);
    const waiting = okFor('ND01').filter((h) => h.content.includes('还没人接手'));
    check(
      '交还之后再转人工：两次的立即通知各发一条，新的 payload 是第 2 次进入',
      at2 > at1 && s.handoffCount === 2 && okFor('ND01').filter((h) => h.content.includes('客户要找顾问')).length === 2,
      json(okFor('ND01')),
    );
    check(
      '交还之后再转人工：旧的 10 分钟到点不发（not_in_handoff），新的照发，只有一条「还没人接手」',
      old?.status === 'done' &&
        old.lastError === 'not_in_handoff' &&
        fresh?.status === 'done' &&
        fresh.lastError === null &&
        waiting.length === 1,
      json({ old, fresh, waiting }),
    );
    check(
      '交还之后再转人工：没有 handoffCount 的旧任务按 handoffAt 认，同样不发',
      legacy?.status === 'done' && legacy.lastError === 'not_in_handoff',
      json(legacy),
    );
  }

  // ---- 企微窗口剩不到 4 小时：仍在转人工中、没人回才发；窗口后移就顺延；顾问回过了顺延到窗口关闭；关了 done ----
  {
    await retireAll();
    const W1 = seeded('NW01', 45 * H);
    await handOver(W1);
    const closes1 = sendWindow(W1.id, Date.now()).closesAt!;
    const j1 = await job(W1.id, 'window');
    check('窗口：转人工时就排好，剩不到 4 小时的现在就到点', j1?.status === 'pending' && j1.runAt === W1.handoff!.at, json(j1));
    await runner.runJobsOnce();
    const w1 = okFor('NW01').filter((h) => h.content.includes('窗口剩不到 4 小时'));
    check(
      '窗口：剩不到 4 小时、仍在转人工中、没人回 → 发一条，时间是窗口关闭的时刻',
      w1.length === 1 &&
        w1[0]!.content.startsWith('企微客户 · NW01 等人接手\n企微 48 小时窗口剩不到 4 小时，过了就发不出去\n窗口关闭时间：') &&
        (await job(W1.id, 'window'))?.status === 'done' &&
        closes1 - Date.now() < WINDOW_NOTICE_MS,
      json(w1),
    );

    const W2 = seeded('NW02', 45 * H);
    await handOver(W2);
    W2.messages.push({ role: 'customer', content: '在吗', at: Date.now() });
    store.saveSession(W2);
    await flush(W2.id);
    const now2 = Date.now();
    await runner.runJobsOnce(now2);
    const j2 = await job(W2.id, 'window');
    const closes2 = sendWindow(W2.id, now2).closesAt!;
    check(
      '窗口：客户又说了话、窗口后移 → 不发，改回 pending 顺延到新的关闭前 4 小时，不算一次尝试',
      j2?.status === 'pending' &&
        j2.runAt === closes2 - WINDOW_NOTICE_MS &&
        j2.attempts === 0 &&
        j2.lastError === 'window_moved' &&
        !okFor('NW02').some((h) => h.content.includes('窗口')),
      json(j2),
    );

    const W3 = seeded('NW03', 45 * H);
    await handOver(W3);
    W3.messages.push({
      role: 'agent',
      content: '您好，我是顾问小林',
      at: Date.now(),
      author: 'human',
      authorId: null,
      authorName: '共享工作台',
    });
    store.saveSession(W3);
    await flush(W3.id);
    const now3 = Date.now();
    await runner.runJobsOnce(now3);
    const j3 = await job(W3.id, 'window');
    const closes3 = sendWindow(W3.id, now3).closesAt!;
    check(
      '窗口：客户最后一句之后顾问回过了 → 不发，顺延到窗口关闭的时刻再看',
      j3?.status === 'pending' &&
        j3.runAt === closes3 &&
        j3.lastError === 'advisor_replied' &&
        !okFor('NW03').some((h) => h.content.includes('窗口')),
      json(j3),
    );
    await runner.runJobsOnce(closes3 + 1000);
    const j3b = await job(W3.id, 'window');
    check(
      '窗口：到窗口关闭的时刻还没新消息 → done（window_closed），不发',
      j3b?.status === 'done' && j3b.lastError === 'window_closed',
      json(j3b),
    );

    // 审查之后改的第 1 条：这一轮的发送额度（5 条）用完了也照发，正文多一句，不顺延；只发这一次
    const W4 = seeded('NW04', 45 * H);
    await handOver(W4);
    for (let i = 0; i < 5; i++) recordSend(W4.id, 'notice', null).settle('accepted');
    check('窗口：（前提）这一轮额度已用完', sendWindow(W4.id, Date.now()).remaining === 0);
    const now4 = Date.now();
    await runner.runJobsOnce(now4);
    const closes4 = sendWindow(W4.id, now4).closesAt!;
    const w4 = okFor('NW04').filter((h) => h.content.includes('窗口剩不到 4 小时'));
    check(
      '窗口：额度用完也照发，正文多一句「发送额度已用完」，不顺延',
      w4.length === 1 &&
        w4[0]!.content.includes('这个窗口的发送额度已用完，没法再主动发消息') &&
        (await job(W4.id, 'window'))?.status === 'done',
      json(w4),
    );
    await runner.runJobsOnce(closes4 + 1000);
    check(
      '窗口：额度用完那条只发一次，不会在之后的拍里重发',
      okFor('NW04').filter((h) => h.content.includes('窗口剩不到 4 小时')).length === 1,
      json(okFor('NW04')),
    );
  }

  // ---- 待确认的订单（advisor 模式，第 15 步接上排程）：订单仍是待付款、没确认过才发 ----
  {
    await retireAll();
    const O = seeded('NO01', H);
    const mk = () =>
      store.createOrder({
        sessionId: O.id,
        routeId: 'jiuzhai-5d',
        routeTitle: '九寨沟5日',
        travelers: 2,
        departDate: '2026-11-01',
        totalPrice: 9800,
      });
    const o1 = mk();
    const o2 = mk();
    o2.confirmedAt = Date.now();
    O.orderIds.push(o1.id, o2.id);
    store.queueJobs(O.id, [
      ...orderUnconfirmedNotifyOps(O.id, o1.id, o1.createdAt),
      ...orderUnconfirmedNotifyOps(O.id, o2.id, o2.createdAt),
    ]);
    store.saveSession(O);
    await flush(O.id);
    await runner.runJobsOnce();
    const got = okFor('NO01');
    const js = await jobsFor(O.id);
    check(
      '待确认的订单：发一条「企微客户 · NO01 等你确认价格」，确认过的那张不发（order_settled）',
      got.length === 1 &&
        got[0]!.content.startsWith('企微客户 · NO01 等你确认价格\n有订单等你确认价格\n下单时间：') &&
        !got[0]!.content.includes(o1.id) &&
        js.filter((j) => j.status === 'done').length === 2 &&
        js.some((j) => j.lastError === 'order_settled'),
      json({ got, js }),
    );
  }

  // ---- 发送失败：抛出，认领者按 max_attempts 4 重试（1、5、15 分钟），用完记 failed；last_error 是错误码 ----
  {
    await retireAll();
    failHttp.add('NF01');
    await ask('NF01', '麻烦帮我找一下人工客服');
    let j = await job(id('NF01'), 'started');
    const seen: { attempts: number; status: string; lastError: string | null; gap: number }[] = [];
    let now = Date.now();
    for (let i = 0; i < 4 && j; i++) {
      await runner.runJobsOnce(now);
      const next = await job(id('NF01'), 'started');
      if (!next) break;
      seen.push({
        attempts: next.attempts,
        status: next.status,
        lastError: next.lastError,
        gap: next.status === 'pending' ? next.runAt - now : 0,
      });
      j = next;
      now = Math.max(now, next.runAt) + 1000;
    }
    const gaps = seen.slice(0, 3).map((x) => Math.round(x.gap / 60_000));
    check(
      '失败重试：HTTP 500 抛出，attempts 逐次加 1、按 1、5、15 分钟退避，第 4 次失败记 failed（http_500）',
      seen.length === 4 &&
        json(seen.map((x) => x.attempts)) === json([1, 2, 3, 4]) &&
        json(gaps) === json([1, 5, 15]) &&
        seen[3]!.status === 'failed' &&
        seen.every((x) => x.lastError === 'http_500') &&
        allFor('NF01').filter((h) => h.content.includes('客户要找顾问')).length === 4 &&
        !okFor('NF01').length,
      json(seen),
    );
    failHttp.delete('NF01');

    await retireAll();
    failErrcode.add('NF02');
    await ask('NF02', '麻烦帮我找一下人工客服');
    await runner.runJobsOnce();
    const e2 = await job(id('NF02'), 'started');
    check(
      '失败重试：HTTP 200 但 errcode 不是 0 也算失败（errcode_93000）',
      e2?.status === 'pending' && e2.attempts === 1 && e2.lastError === 'errcode_93000',
      json(e2),
    );
    failErrcode.delete('NF02');

    await retireAll();
    slow.set('NF03', 1500);
    __notifierTest.setTimeoutMs(300);
    await ask('NF03', '麻烦帮我找一下人工客服');
    const t0 = Date.now();
    await runner.runJobsOnce();
    const e3 = await job(id('NF03'), 'started');
    check(
      '失败重试：超时算失败（timeout），不等满对方',
      e3?.status === 'pending' && e3.lastError === 'timeout' && Date.now() - t0 < 1400,
      json({ e3, ms: Date.now() - t0 }),
    );
    __notifierTest.setTimeoutMs(5000);
    slow.delete('NF03');

    await retireAll();
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    process.env.NOTIFY_WEBHOOK_URL = `http://127.0.0.1:${deadPort}/cgi-bin/webhook/send?key=${SECRET}`;
    await ask('NF04', '麻烦帮我找一下人工客服');
    await runner.runJobsOnce();
    const e4 = await job(id('NF04'), 'started');
    check(
      '失败重试：连不上算失败，last_error 是错误码（ECONNREFUSED）',
      e4?.status === 'pending' && e4.lastError === 'ECONNREFUSED',
      json(e4),
    );
    process.env.NOTIFY_WEBHOOK_URL = rig.HOOK_URL;
  }

  // ---- 没配 NOTIFY_WEBHOOK_URL：只写一行 warn，不算失败（done） ----
  {
    await retireAll();
    delete process.env.NOTIFY_WEBHOOK_URL;
    await ask('NG01', '麻烦帮我找一下人工客服');
    const before = logs.length;
    await runner.runJobsOnce();
    const warned = logs.slice(before).filter((l) => l.includes('NOTIFY_WEBHOOK_URL'));
    const j = await job(id('NG01'), 'started');
    check(
      '没配 URL：一行 warn（带标题），任务 done、不算失败，群里什么都没收到',
      warned.length === 1 &&
        warned[0]!.includes('企微客户 · NG01 等人接手') &&
        j?.status === 'done' &&
        j.attempts === 0 &&
        j.lastError === null &&
        !allFor('NG01').length,
      json({ warned, j }),
    );
    process.env.NOTIFY_WEBHOOK_URL = rig.HOOK_URL;
  }

  // ---- 分道认领：早上 9 点积压 20 条跟进（每条生成话术 2 秒），同时到点的转人工通知几秒内发出 ----
  {
    await retireAll();
    process.env.FOLLOWUP_ENABLED = '1';
    const backlog: string[] = [];
    for (let i = 0; i < 20; i++) {
      const s = store.getOrCreateSession(`wecom:wmNtfLane${String(i).padStart(2, '0')}`, 'wecom');
      const at = Date.now() - 3 * H;
      s.stage = 'quote';
      s.messages.push(
        { role: 'customer', content: '这条线多少钱', at: at - 60_000 },
        { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at },
      );
      s.createdAt = at - 60_000;
      s.updatedAt = at;
      store.saveSession(s, false);
      backlog.push(s.id);
    }
    for (const sid of backlog) await flush(sid);
    const due = (await Promise.all(backlog.map((sid) => jobsFor(sid, 'followup')))).flat();
    llm.delayMs = 2000;
    await ask('NL01', '麻烦帮我找一下人工客服');
    const started = await job(id('NL01'), 'started');
    const t0 = Date.now();
    const tick = runner.runJobsOnce();
    const sent = await waitFor(() => okFor('NL01').length === 1, 3000);
    const ms = Date.now() - t0;
    const busy = runner.__jobsTest.mine().filter((m) => m.kind === 'followup').length;
    check(
      '分道认领：20 条更早到点的跟进在生成话术，转人工通知 3 秒内发出',
      due.length === 20 && due.every((j) => j.status === 'pending' && started && j.runAt < started.runAt) && sent && busy > 0,
      json({ due: due.length, ms, busy }),
    );
    await runner.__jobsTest.stop();
    await tick;
    runner.__jobsTest.reset();
    llm.delayMs = 0;
    process.env.FOLLOWUP_ENABLED = '0';
    await retireAll();
  }

  // ---- 库写不进去：emergency 立即发一条 unsaved（记录暂未保存），PG 恢复后不再重发 ----
  {
    await retireAll();
    fx.faults.acquire = fakeDbError('08006');
    const sid = id('NU01');
    used.push(sid);
    const t0 = Date.now();
    await handleMessage(sid, '我在山上头很疼喘不上气', 'wecom');
    const fast = await waitFor(() => okFor('NU01').length === 1, 3000);
    const ms = Date.now() - t0;
    const s = store.getSession(sid)!;
    fx.faults.acquire = null;
    await flush(sid);
    const got = okFor('NU01');
    check(
      'unsaved：落库失败时紧急情况立即发一条「紧急 · 企微客户 · NU01」，标「记录暂未保存」',
      fast &&
        ms < 2000 &&
        s.handoff?.kind === 'emergency' &&
        got[0]!.content.startsWith('紧急 · 企微客户 · NU01\n客户遇到紧急情况\n') &&
        got[0]!.content.includes('\n记录暂未保存：'),
      json({ got, ms }),
    );
    const started = await job(sid, 'started');
    check(
      'unsaved：提交之后立即的那个通知的 payload 带 unsavedSent（停机写进 spill 也带着）',
      started?.payload.unsavedSent === true && started.status === 'pending',
      json(started),
    );
    // 模拟重启：内存里的记录没了，只靠 payload 认出来
    __handoffNotifyTest.reset();
    await runner.runJobsOnce();
    const after = await job(sid, 'started');
    check(
      'unsaved：PG 恢复、提交之后不再补发（重启之后也认得，done unsaved_sent）',
      okFor('NU01').length === 1 && after?.status === 'done' && after.lastError === 'unsaved_sent',
      json({ after, hits: okFor('NU01') }),
    );
  }
  {
    // 内存记录兜住另一种：提交里的 payload 没赶上标（在途那次尝试先写进去了）
    await retireAll();
    fx.faults.acquire = fakeDbError('08006');
    const sid = id('NU02');
    used.push(sid);
    await handleMessage(sid, '孩子走丢了', 'wecom');
    await waitFor(() => okFor('NU02').length === 1, 3000);
    fx.faults.acquire = null;
    await flush(sid);
    await su(`update jobs set payload = (payload::jsonb - 'unsavedSent')::json where dedupe_key like $1`, [
      `handoff_notify:${sid}:%:started`,
    ]);
    const stripped = await job(sid, 'started');
    await runner.runJobsOnce();
    const after = await job(sid, 'started');
    check(
      'unsaved：payload 没标上时由内存记录认出，同样不补发',
      stripped?.payload.unsavedSent === undefined &&
        okFor('NU02').length === 1 &&
        after?.status === 'done' &&
        after.lastError === 'unsaved_sent',
      json({ after, hits: okFor('NU02') }),
    );
  }

  // ---- 非紧急：失败持续够久才发（自测把 30 秒缩成 600 毫秒）；期间提交了就不发，照常由任务提醒 ----
  {
    await retireAll();
    __handoffNotifyTest.setTiming({ delayMs: 600 });
    fx.faults.acquire = fakeDbError('08006');
    const sid = id('NU03');
    used.push(sid);
    await handleMessage(sid, '麻烦帮我找一下人工客服', 'wecom');
    const at = store.getSession(sid)!.handoff!.at;
    await sleep(250);
    const early = okFor('NU03').length;
    const stateEarly = __handoffNotifyTest.unsavedState(sid, at);
    const late = await waitFor(() => okFor('NU03').length === 1, 3000);
    fx.faults.acquire = null;
    await flush(sid);
    const got = okFor('NU03');
    check(
      'unsaved：非紧急的不立即发，失败持续够久之后发一条「企微客户 · NU03 等人接手」，标「记录暂未保存」',
      early === 0 &&
        stateEarly === 'waiting' &&
        late &&
        got[0]!.content.startsWith('企微客户 · NU03 等人接手\n客户要找顾问\n') &&
        got[0]!.content.includes('记录暂未保存'),
      json({ early, stateEarly, got }),
    );
    await runner.runJobsOnce();
    const after = await job(sid, 'started');
    check(
      'unsaved：非紧急的发过之后，提交成功也不补发',
      okFor('NU03').length === 1 && after?.status === 'done' && after.lastError === 'unsaved_sent',
      json(after),
    );

    await retireAll();
    __handoffNotifyTest.setTiming({ delayMs: 3000 });
    fx.faults.acquire = fakeDbError('08006');
    const sid4 = id('NU04');
    used.push(sid4);
    await handleMessage(sid4, '麻烦帮我找一下人工客服', 'wecom');
    const at4 = store.getSession(sid4)!.handoff!.at;
    await sleep(100);
    const waiting = __handoffNotifyTest.unsavedState(sid4, at4);
    fx.faults.acquire = null;
    await flush(sid4);
    const cleared = __handoffNotifyTest.unsavedState(sid4, at4);
    await runner.runJobsOnce();
    const got4 = okFor('NU04');
    check(
      'unsaved：等的期间提交了就不发 unsaved，照常由任务发一条（没有「记录暂未保存」）',
      waiting === 'waiting' && cleared === null && got4.length === 1 && !got4[0]!.content.includes('记录暂未保存'),
      json({ waiting, cleared, got4 }),
    );
    __handoffNotifyTest.setTiming({ delayMs: 30_000 });
  }

  // ---- 同一次转人工只发一次：每次落库失败都会再报一遍 ----
  {
    await retireAll();
    const X = seeded('NU05', H);
    await handOver(X);
    const ev = {
      type: 'handoff.started' as const,
      id: X.id,
      kind: 'emergency' as const,
      at: X.handoff!.at + 1,
      escalated: true,
      paidCustomer: false,
    };
    deliverHandoffUnsaved([ev, ev]);
    deliverHandoffUnsaved([ev]);
    await sleep(300);
    deliverHandoffUnsaved([ev]);
    await sleep(100);
    check(
      'unsaved：同一次转人工报了几遍也只发一条',
      okFor('NU05').filter((h) => h.content.includes('记录暂未保存')).length === 1,
      json(okFor('NU05')),
    );
  }

  // ---- unsaved 发不出去：内存里退避重试，最后也没发出去就忘掉它，提交之后由任务照常提醒 ----
  {
    await retireAll();
    __handoffNotifyTest.setTiming({ retryMs: [50, 50, 50] });
    failHttp.add('NU06');
    fx.faults.acquire = fakeDbError('08006');
    const sid = id('NU06');
    used.push(sid);
    await handleMessage(sid, '孩子走丢了', 'wecom');
    const at = store.getSession(sid)!.handoff!.at;
    const tried = await waitFor(() => allFor('NU06').length === 4 && __handoffNotifyTest.unsavedState(sid, at) === null, 3000);
    failHttp.delete('NU06');
    fx.faults.acquire = null;
    await flush(sid);
    await runner.runJobsOnce();
    const got = okFor('NU06');
    check(
      'unsaved：发送失败退避重试 3 次仍不成就忘掉，提交之后由任务照常发一条（不带「记录暂未保存」）',
      tried && got.length === 1 && !got[0]!.content.includes('记录暂未保存') && got[0]!.content.startsWith('紧急 · 企微客户 · NU06\n'),
      json({ tried, all: allFor('NU06').length, got }),
    );
    __handoffNotifyTest.setTiming({ retryMs: [5_000, 30_000, 120_000] });
  }

  // ---- 会话停写（数据类错误，poisoned）：之后的转人工提交不了，紧急情况同样立即发 unsaved ----
  {
    await retireAll();
    const sid = `wecom:wmNtf${'x'.repeat(200)}NP05`;
    used.push(sid);
    await handleMessage(sid, '我们被困在山上了', 'wecom');
    const got = await waitFor(() => okFor('NP05').length === 1, 3000);
    const hit = okFor('NP05')[0];
    check(
      'unsaved：会话停写（id 超长，23514）时紧急情况立即发一条「记录暂未保存」',
      got &&
        store.storeHealth().poisoned.includes('NP05') &&
        !!hit &&
        hit.content.startsWith('紧急 · 企微客户 · NP05\n') &&
        hit.content.includes('记录暂未保存'),
      json({ hit, health: store.storeHealth() }),
    );
  }

  // ---- 不变量 32 与脱敏：所有消息里没有客户原话、external_userid、会话原 id；日志与 last_error 里没有 webhook 地址 ----
  {
    const sessions = used.map((sid) => store.getSession(sid)).filter((s): s is Session => !!s);
    const quotes = sessions.flatMap((s) => s.messages.filter((m) => m.role === 'customer').map((m) => m.content));
    const leaks: string[] = [];
    for (const h of hits) {
      for (const s of sessions) {
        if (h.content.includes(s.id)) leaks.push(`会话 id ${s.id.slice(0, 20)}`);
        if (h.content.includes(s.id.replace(/^wecom:/, ''))) leaks.push(`external_userid ${s.id.slice(6, 26)}`);
      }
      for (const q of quotes) if (q.length >= 3 && h.content.includes(q)) leaks.push(`原话「${q}」`);
      if (h.content.includes('13800138000') || h.content.includes('wecom:')) leaks.push('手机号或 wecom: 前缀');
    }
    check(
      '不变量 32：转人工通知群收到的消息里没有客户原话、external_userid 与会话原 id',
      hits.length >= 20 && quotes.length >= 15 && !leaks.length,
      json([...new Set(leaks)]),
    );
    const port = new URL(rig.HOOK_URL).port;
    const logLeaks = logs.filter((l) => l.includes(SECRET) || l.includes(`127.0.0.1:${port}`) || l.includes('cgi-bin/webhook'));
    check('脱敏：日志里没有 webhook 地址（含失败、超时、连不上）', logs.length > 0 && !logLeaks.length, json(logLeaks.slice(0, 3)));
    const errs = await su<{ last_error: string }>(`select distinct last_error from jobs where last_error is not null`);
    check(
      '脱敏：任务的 last_error 只有错误码，没有地址',
      errs.length > 0 && errs.every((r) => !r.last_error.includes(SECRET) && !r.last_error.includes('://')),
      json(errs),
    );
  }
}
