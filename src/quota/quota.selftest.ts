// 企微发送账本、回执、去重与「【顾问】」的自测（docs/architecture/02-conversations-workbench/spec.md「企微：发送账本、回执与去重」、
// R7、R18、不变量 18、28 的适配器部分、33、34、验收 18；plan 第 12 步）。历史里的「【顾问】」与出口去前缀在 handoff.selftest.ts。
// 本文件带上 QUOTA_CHILD 再起几次自己（单进程 node --import tsx，超时 SIGKILL，不留孤儿），每个子进程驱动真正的企微适配器：
//   file：文件存储。窗口与剩余条数（从 sentAt 起算）、超时与网络异常记 unknown 并计数、重试沿用同一行同一 msgid（先超时再成功是一行、
//         计 1 条）、取 token 失败不记、卡片也记一行、回执三种说明与 send.failed 事件、回执不进在途表也不回客户、旧 /reply 连发 5 次之后
//         第 6 次被拒（写明「这一轮已经发满 5 条」）与窗口已过被拒、人工回复客户侧加「【顾问】」（企微与网页模拟器）、去重情况 1、3、4、5
//         （新拉到的与重放各一遍）、接手代次变了不发、文件存储的扫描器遇到「只超时」按已发处理；
//   db：PGlite 上的 db 会话存储。账本行随会话落库（message_seq 对得上，发成功才写进会话的引导提示也对得上）、没有会话的欢迎语单独一个
//         短事务、回执单独一个短事务（与还没写进库的行）、去重情况 2（重置之后只在 7 天集合里）、跟进的额度（剩 1 条、窗口剩不到 2 小时
//         不调模型也不重排，剩 2 条照发）、跟进经真企微适配器「只超时」记 abandoned、账不退、之后不再发；
//   crash → restart（落盘的 PGlite 与 var/）：客户这句已入库、回复还没生成时进程被 SIGKILL，重启后恰好回复一次；回复已送出的那条
//         重放不补发（账本行由预载读回）；第一次尝试超时（已送达）、重试挂住时被杀，重启后不重发（超时那一刻已记 unknown）；
//         重启之后才收到的回执改得到库（预载的行），cursor 回退再收到一次不重复加说明；
//   stop → stopped（文件存储，同一个 var/）：停机的 normal 段截止之后才生成好的回复不开始发，留在在途表，重启后恰好补发一次；
//   rpg（PG_TEST_URL 设了才跑）：真实 Postgres 上没有会话的欢迎语短事务、回执短事务。
// 用法：npx tsx src/quota/quota.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { ChatMessage, Session } from '../types.js';

const CHILD = process.env.QUOTA_CHILD ?? '';
const SELF = fileURLToPath(import.meta.url);
const H = 3_600_000;
/** crash → restart 两个子进程共用的两个客户 */
const KILL_A = 'wmQkA';
const KILL_B = 'wmQkB';
const KILL_C = 'wmQkC';
/** stop → stopped 两个子进程共用的客户 */
const STOP_U = 'wmQstop';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const json = (v: unknown): string => JSON.stringify(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
// 父进程
// ======================================================================================

async function parentMain(): Promise<never> {
  const varParent = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(varParent, { recursive: true });
  const ROOT = fs.mkdtempSync(path.join(varParent, 'wecom-quota-selftest-'));
  process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

  // 纯函数：「【顾问】」的加与去
  {
    const { ADVISOR_PREFIX, stripAdvisorPrefix, withAdvisorPrefix } = await import('../shared/conversation.js');
    check('「【顾问】」：正文前加一次', withAdvisorPrefix('明天给您回电话') === '【顾问】明天给您回电话');
    check('「【顾问】」：已经以它开头的不叠两遍', withAdvisorPrefix('【顾问】明天给您回电话') === '【顾问】明天给您回电话');
    check(
      '「【顾问】」：去掉开头的（连着几个、带冒号与空白），中间的不动',
      stripAdvisorPrefix(' 【顾问】：【顾问】 您好，【顾问】说过') === '您好，【顾问】说过' && stripAdvisorPrefix('您好') === '您好',
    );
    check('「【顾问】」：常量', ADVISOR_PREFIX === '【顾问】');
  }

  // 子进程预加载等价套件的钟，从当天本地 12:00 起走：跟进的夜间时段不受在几点跑的影响（真实 PG 子进程用真钟，它不碰跟进）
  const NOON = new Date().setHours(12, 0, 0, 0);
  const CLOCK_MODULE = fileURLToPath(new URL('../store/parity-clock.ts', import.meta.url));
  const runChild = (
    mode: string,
    env: Record<string, string> = {},
    clockMs: number | null = NOON,
  ): { status: number | null; signal: NodeJS.Signals | null; out: string; result: { pass: number; fails: string[] } | null } => {
    const resultFile = path.join(ROOT, `${mode}-${Date.now()}.json`);
    const args = ['--import', 'tsx', ...(clockMs === null ? [] : ['--import', CLOCK_MODULE]), SELF];
    const r = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        QUOTA_CHILD: mode,
        QUOTA_RESULT: resultFile,
        CONFIG_SOURCE: 'file',
        ...(clockMs === null ? {} : { PARITY_CLOCK_MS: String(clockMs) }),
        ...env,
      },
      timeout: 240_000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    let result: { pass: number; fails: string[] } | null = null;
    try {
      result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { pass: number; fails: string[] };
    } catch {
      result = null;
    }
    return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, result };
  };
  const merge = (label: string, r: ReturnType<typeof runChild>): void => {
    if (!r.result) {
      fails.push(`${label}：子进程没留下结果（status=${r.status} signal=${r.signal}）${r.out.slice(-2000)}`);
      return;
    }
    pass += r.result.pass;
    for (const f of r.result.fails) fails.push(`${label}：${f}`);
    if (r.result.fails.length) fails.push(`${label} 的日志：${r.out.slice(-2500)}`);
  };

  {
    const r = runChild('file', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'file-')) });
    merge('文件存储', r);
    check('文件存储子进程正常结束', r.status === 0, `status=${r.status} signal=${r.signal} ${r.out.slice(-1500)}`);
  }
  {
    const r = runChild('db', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'db-')) });
    merge('db 存储', r);
    check('db 存储子进程正常结束', r.status === 0, `status=${r.status} signal=${r.signal} ${r.out.slice(-1500)}`);
  }
  {
    const env = { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'disk-')), QUOTA_DATA_DIR: fs.mkdtempSync(path.join(ROOT, 'pgdata-')) };
    // 两个进程的钟错开两分钟：库里留下的时刻不会比下一个进程的「现在」晚
    const c = runChild('crash', env, NOON);
    merge('进程被杀', c);
    check('进程被杀：生成回复途中被 SIGKILL', c.signal === 'SIGKILL', `status=${c.status} ${c.out.slice(-1200)}`);
    const r = runChild('restart', env, NOON + 120_000);
    merge('进程被杀 → 重启', r);
    check('进程被杀 → 重启：正常结束', r.status === 0, `status=${r.status} ${r.out.slice(-1500)}`);
  }
  {
    const env = { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'stop-')) };
    const a = runChild('stop', env, NOON);
    merge('停机截止', a);
    check('停机截止：子进程正常结束', a.status === 0, `status=${a.status} signal=${a.signal} ${a.out.slice(-1500)}`);
    const b = runChild('stopped', env, NOON + 120_000);
    merge('停机截止 → 重启', b);
    check('停机截止 → 重启：正常结束', b.status === 0, `status=${b.status} ${b.out.slice(-1500)}`);
  }
  let realPgRan = false;
  if (process.env.PG_TEST_URL) {
    realPgRan = true;
    const r = runChild('rpg', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'rpg-')) }, null);
    merge('真实 PG', r);
    check('真实 PG 子进程正常结束', r.status === 0, `status=${r.status} ${r.out.slice(-1500)}`);
  }

  if (fails.length) {
    console.error(`QUOTA SELFTEST FAIL：${fails.length} 项（通过 ${pass} 项）`);
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log(
    `QUOTA SELFTEST PASS: ${pass} 项断言全通（窗口与剩余条数从 sentAt 起算 / unknown 计数 / 重试同一 msgid 一行 / 取 token 失败不记 / 卡片一行 / ` +
      `回执三种说明与 send.failed / 人工回复发满 5 条与窗口已过被拒 / 客户侧「【顾问】」 / 去重五种情况 / 接手代次 / 跟进的额度与结果不明 / ` +
      `账本随落库、没有会话的欢迎语与回执的短事务 / 已入库未回复被杀后恰好回复一次、已送出不补发 / 审查之后：重启后的回执改库、` +
      `超时即记 unknown、停机截止后不开始发、回执改库重试、多段的 seq、重置口令去重、人工回复的卡片与前缀、窗口按最后一次尝试与 min 起点、并发只放一条` +
      `${realPgRan ? ' / 真实 PG：欢迎语与回执的短事务' : '；真实 PG 部分未跑'}）`,
  );
  process.exit(0);
}

// ======================================================================================
// 子进程：假模型、假企微服务端、要用的模块
// ======================================================================================

interface FakeMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text?: { content: string };
  event?: { event_type: string; welcome_code?: string; external_userid?: string; fail_msgid?: string; fail_type?: number };
}
/** 假企微收到的一次 send_msg */
interface SendReq {
  to: string;
  msgid: string;
  type: string;
  content: string;
  /** 链接卡片的标题 */
  title: string;
}
/**
 * 这一次 send_msg 怎么回：ok 送达；timeout 送达之后超时（客户收到了，我们不知道）；lost 没送达就超时；hang 永不返回；
 * expired 回 42001（token 过期，强刷 token 时 tokenFails 决定成不成）；{ errcode } 接口明确报错
 */
type Outcome = 'ok' | 'timeout' | 'lost' | 'hang' | 'expired' | { errcode: number };

async function childMain(mode: string): Promise<never> {
  const save = (): void => fs.writeFileSync(process.env.QUOTA_RESULT!, JSON.stringify({ pass, fails }));
  const logBuf: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) {
    console[k] = (...args: unknown[]) => {
      logBuf.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : json(a))).join(' '));
      if (logBuf.length > 400) logBuf.splice(0, logBuf.length - 400);
    };
  }
  const flushLogs = (): void => {
    Object.assign(console, orig);
    if (fails.length) for (const l of logBuf.slice(-80)) console.error(`  ${l}`);
  };
  try {
    const h = await harness();
    if (mode === 'file') await fileSuite(h);
    else if (mode === 'db') await dbSuite(h);
    else if (mode === 'crash') await crashSuite(h, () => (flushLogs(), save()));
    else if (mode === 'restart') await restartSuite(h);
    else if (mode === 'stop') await stopSuite(h);
    else if (mode === 'stopped') await stoppedSuite(h);
    else if (mode === 'rpg') await realPgSuite(h);
    else fails.push(`不认识的子进程 ${mode}`);
  } catch (e) {
    fails.push(`子进程抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  flushLogs();
  save();
  process.exit(0);
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness() {
  // ---- 假模型：按脚本回话，hang 的那一步不回包，直到 releaseHung() ----
  const script: { content?: string; hang?: boolean }[] = [];
  const hung: http.ServerResponse[] = [];
  let chatCalls = 0;
  const answer = (r: http.ServerResponse, content: string): void => {
    r.setHeader('content-type', 'application/json');
    r.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  };
  const model = http.createServer((req, r) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.endsWith('/embeddings')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] };
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 1 } }));
        return;
      }
      chatCalls += 1;
      const step = script.shift();
      if (step?.hang) {
        hung.push(r);
        return;
      }
      answer(r, step?.content ?? '好的～您几位出行、大概什么时候走？');
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  model.unref();
  const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  const releaseHung = async (content = '好的～您几位出行？'): Promise<void> => {
    if (!(await waitFor(() => hung.length > 0, 10_000))) fails.push('假模型 10 秒内没收到要卡住的那个请求');
    for (const r of hung.splice(0)) answer(r, content);
  };
  Object.assign(process.env, {
    LLM_MOCK: '0',
    LLM_PROVIDER: '',
    LLM_BASE_URL: modelUrl,
    LLM_API_KEY: 'selftest-fake-key',
    LLM_MODEL: 'selftest-fake',
    LLM_MODEL_CHEAP: '',
    EMBED_BASE_URL: modelUrl,
    EMBED_API_KEY: 'selftest-fake-key',
    LLM_HEDGE_MODEL: '',
    LLM_MAX_RETRY: '0',
    LLM_TIMEOUT_MS: '600000',
    DEMO_PRUNE_HOURS: '0',
    SERVER_SELFTEST: '1',
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'selftest-pass',
    WECOM_CORP_ID: 'selftest-corp',
    WECOM_APP_SECRET: 'selftest-secret',
    WECOM_KF_OPEN_KFID: 'selftest-kf',
    PUBLIC_BASE_URL: '',
    FOLLOWUP_ENABLED: '',
  });

  // ---- 假企微服务端：sync_msg 按 cursor 返回日志里之后的消息；send_msg 按计划回包，送达按 msgid 去重（假设企微对同一 msgid 去重） ----
  const serverLog: FakeMsg[] = [];
  const requests: SendReq[] = [];
  const delivered = new Map<string, SendReq>();
  const plan = new Map<string, Outcome[]>();
  const fake = { tokenFails: false, thumbOk: false, sendDelayMs: 0 };
  const realFetch = globalThis.fetch;
  const res = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  const timeoutError = (): Error => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'qyapi.weixin.qq.com') return realFetch(input, init);
    const ep = url.pathname.replace(/^\/cgi-bin\//, '');
    if (ep === 'gettoken')
      return fake.tokenFails
        ? res({ errcode: 40013, errmsg: 'selftest: token' })
        : res({ errcode: 0, access_token: 'tok', expires_in: 7200 });
    if (ep === 'media/upload') return fake.thumbOk ? res({ errcode: 0, media_id: 'thumb-1' }) : res({ errcode: 40004, errmsg: 'selftest' });
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, any>;
    if (ep === 'kf/sync_msg') {
      const from = Number(String(body.cursor ?? '').split(':')[1] ?? 0) || 0;
      const list = serverLog.slice(from);
      return res({ errcode: 0, next_cursor: `0:${from + list.length}`, has_more: 0, msg_list: list });
    }
    if (ep === 'kf/send_msg') {
      const req: SendReq = {
        to: String(body.touser),
        msgid: String(body.msgid ?? ''),
        type: String(body.msgtype),
        content: String(body.text?.content ?? body.link?.url ?? ''),
        title: String(body.link?.title ?? ''),
      };
      requests.push(req);
      if (fake.sendDelayMs) await sleep(fake.sendDelayMs);
      const o = plan.get(req.to)?.shift() ?? 'ok';
      if (o === 'expired') return res({ errcode: 42001, errmsg: 'selftest: access_token expired' });
      if (typeof o === 'object') return res({ errcode: o.errcode, errmsg: 'selftest' });
      if (o === 'hang') return new Promise<Response>(() => {});
      if (o === 'lost') throw timeoutError();
      if (!delivered.has(req.msgid)) delivered.set(req.msgid, req);
      if (o === 'timeout') throw timeoutError();
      return res({ errcode: 0, msgid: req.msgid });
    }
    if (ep === 'kf/send_msg_on_event') return res({ errcode: 0 });
    if (ep === 'kf/customer/batchget') return res({ errcode: 0, customer_list: [] });
    return res({ errcode: 40001, errmsg: `selftest: 未模拟的接口 ${ep}` });
  }) as typeof fetch;

  const store = await import('../store.js');
  const wecom = await import('../adapters/wecom.js');
  const ledger = await import('./ledger.js');
  const { __takeoverTest } = await import('../handoff/takeover.js');
  const { onTurnEnd } = await import('../trace/recorder.js');

  let seq = 0;
  const customerMsg = (uid: string, content: string, opts: { msgid?: string; ageMs?: number; msgtype?: string } = {}): FakeMsg => {
    seq += 1;
    const msgtype = opts.msgtype ?? 'text';
    return {
      msgid: opts.msgid ?? `q${process.pid}-${seq}`,
      open_kfid: 'selftest-kf',
      external_userid: uid,
      send_time: Math.floor((Date.now() - (opts.ageMs ?? 0)) / 1000),
      origin: 3,
      msgtype,
      ...(msgtype === 'text' ? { text: { content } } : {}),
    };
  };
  const failEvent = (failMsgid: string, failType: number): FakeMsg => {
    seq += 1;
    return {
      msgid: `evt${process.pid}-${seq}`,
      open_kfid: 'selftest-kf',
      external_userid: 'u-any',
      send_time: Math.floor(Date.now() / 1000),
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'msg_send_fail', fail_msgid: failMsgid, fail_type: failType },
    };
  };
  const enterEvent = (uid: string): FakeMsg => {
    seq += 1;
    return {
      msgid: `enter${process.pid}-${seq}`,
      open_kfid: 'selftest-kf',
      external_userid: uid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'enter_session', external_userid: uid },
    };
  };
  const inspect = wecom.__test.inspectForTest;
  const idle = (): Promise<boolean> => waitFor(() => !inspect().busy, 15_000);
  /** 拉一次（回调触发），等处理链都跑完 */
  const sync = async (): Promise<void> => {
    await wecom.syncFromCallback(`tok-${Date.now()}`);
    await idle();
  };
  /** 模拟进程重启：退出前的落盘照常做完，适配器内存清空，盘上的状态文件保留（账本与会话在别的模块里，照旧） */
  const restart = (): Promise<void> => wecom.__test.resetForTest();
  interface DiskState {
    cursor?: string;
    handled?: [string, number][];
    pending?: { msg: FakeMsg; tries: number }[];
  }
  const readState = (): DiskState => JSON.parse(fs.readFileSync(wecom.__test.STATE_FILE, 'utf8')) as DiskState;
  const writeState = (st: DiskState): void => fs.writeFileSync(wecom.__test.STATE_FILE, json(st));
  /** 盘上的在途表里放一条：进程死在处理它的半路，cursor 已越过它，只能靠启动重放（调用前先 restart） */
  const pendOnDisk = (m: FakeMsg): void => {
    const st = readState();
    writeState({ cursor: st.cursor, handled: [...(st.handled ?? []), [m.msgid, Date.now()]], pending: [{ msg: m, tries: 0 }] });
  };
  /** 这条消息重新被拉到（cursor 退回到它之前、去重集合里没有它：恢复了更早的 var/ 备份），走的是新消息的路（调用前先 restart） */
  const rewindTo = (m: FakeMsg): void => {
    const st = readState();
    const i = serverLog.indexOf(m);
    writeState({ cursor: `0:${i}`, handled: (st.handled ?? []).filter(([id]) => id !== m.msgid), pending: [] });
  };
  const reqTo = (uid: string): SendReq[] => requests.filter((r) => r.to === uid);
  const deliveredTo = (uid: string): SendReq[] => [...delivered.values()].filter((r) => r.to === uid);
  const rowsOf = (sid: string) => ledger.__ledgerTest.rows(sid);
  const msgsOf = (sid: string): ChatMessage[] => store.getSession(sid)?.messages ?? [];
  return {
    script,
    hung,
    calls: () => chatCalls,
    releaseHung,
    serverLog,
    requests,
    delivered,
    plan,
    fake,
    store,
    wecom,
    ledger,
    __takeoverTest,
    onTurnEnd,
    customerMsg,
    failEvent,
    enterEvent,
    inspect,
    idle,
    sync,
    restart,
    readState,
    writeState,
    pendOnDisk,
    rewindTo,
    reqTo,
    deliveredTo,
    rowsOf,
    msgsOf,
  };
}

/** 直接建一个企微会话：客户在 sentAgo 之前发过一句（带 msgid 与 sentAt），可再跟一条 AI 回复 */
function seedSession(
  h: Harness,
  sid: string,
  opts: { sentAgo?: number; msgid?: string; reply?: string } = {},
): { s: Session; said: ChatMessage; reply?: ChatMessage } {
  const s = h.store.getOrCreateSession(sid, 'wecom');
  const said: ChatMessage = {
    role: 'customer',
    content: '这条线多少钱',
    at: Date.now(),
    msgid: opts.msgid ?? `seed-${sid}`,
    sentAt: Date.now() - (opts.sentAgo ?? 60_000),
  };
  s.messages.push(said);
  let reply: ChatMessage | undefined;
  if (opts.reply !== undefined) {
    reply = { role: 'agent', content: opts.reply, at: Date.now() };
    s.messages.push(reply);
  }
  h.store.saveSession(s);
  return { s, said, reply };
}

// ======================================================================================
// file：文件存储
// ======================================================================================

async function fileSuite(h: Harness): Promise<void> {
  const { store, wecom, ledger } = h;
  const { app } = await import('../server.js');
  const { subscribe } = await import('../adapters/simulator.js');
  const events: { type: string; id: string; failType?: number | null }[] = [];
  store.onCommitted((ev) => events.push(ev as { type: string; id: string; failType?: number | null }));
  await h.sync(); // 第一次拉取：建出状态文件（冷启动，没有消息）

  const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:selftest-pass').toString('base64') };
  let ip = 0;
  const legacyReply = async (sid: string, text: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    ip += 1;
    const raw = JSON.stringify({ text });
    const r = await app.request(`/api/sessions/${encodeURIComponent(sid)}/reply`, {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(raw)),
        'x-forwarded-for': `198.51.100.${ip}`,
        ...ADMIN,
      },
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const push = (sid: string, text: string, opts?: Parameters<typeof wecom.wecomAdapter.push>[2]) =>
    wecom.wecomAdapter.push(sid, text, opts);

  // ---------------- 窗口与剩余条数：从客户消息的 sentAt（企微 send_time）起算，不从处理时刻 ----------------
  {
    const sid = 'wecom:wmQwin';
    const { said } = seedSession(h, sid, { sentAgo: 47 * H });
    const now = Date.now();
    const w = ledger.sendWindow(sid, now);
    check(
      '窗口：lastCustomerAt 是客户这句的 sentAt（比处理时刻早），closesAt 是它加 48 小时，还没发过是 5 条',
      w.lastCustomerAt === said.sentAt && w.closesAt === said.sentAt! + 48 * H && w.used === 0 && w.remaining === 5,
      json(w),
    );
    check('窗口剩不到 2 小时：跟进不放行（条数够也不行）', !ledger.followupWindowAllows(sid, now));
    check('窗口剩不到 2 小时：人工回复照常放行（剩 1 条以上、窗口没过就行）', ledger.humanReplyVerdict(sid, now).ok);
    const closed = 'wecom:wmQwin-closed';
    seedSession(h, closed, { sentAgo: 49 * H });
    const wc = ledger.sendWindow(closed, Date.now());
    const v = ledger.humanReplyVerdict(closed, Date.now());
    check('窗口已过：剩 0 条', wc.remaining === 0 && wc.closesAt! < Date.now(), json(wc));
    check(
      '窗口已过：人工回复被拒，原因 window_closed，写明「客户超过 48 小时没说话」',
      !v.ok && v.reason === 'window_closed' && v.message === '客户超过 48 小时没说话，这条发不出去了',
      json(v),
    );
    const none = h.store.getOrCreateSession('wecom:wmQwin-none', 'wecom');
    h.store.saveSession(none);
    check('没有客户消息的会话：窗口没开，剩 0 条', ledger.sendWindow(none.id, Date.now()).remaining === 0);
    const open = 'wecom:wmQwin-open';
    seedSession(h, open, { sentAgo: 60_000 });
    check('刚说过话、还没发过：跟进放行', ledger.followupWindowAllows(open, Date.now()));

    // 本机钟比企微慢 5 秒：客户这句的 sentAt（企微的钟）比本机收到它的时刻还晚。窗口起点取 min(sentAt, at)，与账本行同一个钟，
    // 之后的发送照样计数（审查 window[2]）
    const skew = 'wecom:wmQskew';
    const sk = h.store.getOrCreateSession(skew, 'wecom');
    const at = Date.now();
    sk.messages.push({ role: 'customer', content: '在吗', at, msgid: 'q-skew-1', sentAt: at + 5000 });
    h.store.saveSession(sk);
    await push(skew, '付款已确认');
    const ws = ledger.sendWindow(skew, Date.now());
    check(
      '钟差（本机比企微慢 5 秒）：窗口起点是本机收到这句的时刻，之后的发送照样计数（已用 1 条）',
      ws.lastCustomerAt === at && ws.closesAt === at + 48 * H && ws.used === 1,
      json(ws),
    );
  }

  // ---------------- 剩 1 条时并发两条人工回复：检查与预占在同一段同步代码里，只放一条，另一条 409 写明原因（审查 window[3]） ----------------
  // 带站内链接的回复要先等缩略图上传（缓存还是冷的）：检查与第一个分段记账之间隔着几次 await，另一条请求正好插进来
  {
    process.env.PUBLIC_BASE_URL = 'https://travel.example.com';
    h.fake.thumbOk = true;
    const uid = 'wmQrace';
    const sid = `wecom:${uid}`;
    seedSession(h, sid);
    for (let i = 0; i < 4; i++) ledger.recordSend(sid, 'human', null).settle('accepted');
    const n0 = h.msgsOf(sid).length;
    const rs = await Promise.all([
      legacyReply(sid, '方案书：/proposal/r-guizhou/2'),
      legacyReply(sid, '贵州这条线的方案书：/proposal/r-guizhou/2'),
    ]);
    process.env.PUBLIC_BASE_URL = '';
    h.fake.thumbOk = false;
    const refused = rs.filter((r) => r.status === 409);
    check(
      '并发两条人工回复、剩 1 条：一条 200、一条 409（quota_exhausted，写明「这一轮已经发满 5 条」）',
      json(rs.map((r) => r.status).toSorted()) === json([200, 409]) &&
        refused[0]?.body.reason === 'quota_exhausted' &&
        String(refused[0]?.body.error).includes('这一轮已经发满 5 条'),
      json(rs),
    );
    check(
      '并发两条人工回复、剩 1 条：只发出一条（一张卡片），会话只多一条，已用 5 条、没有留下预占的行',
      h.reqTo(uid).length === 1 &&
        h.msgsOf(sid).length === n0 + 1 &&
        ledger.sendWindow(sid, Date.now()).used === 5 &&
        h.rowsOf(sid).every((r) => !r.held && r.status === 'accepted'),
      json({ reqs: h.reqTo(uid), rows: h.rowsOf(sid).map((r) => [r.kind, r.status, r.held]) }),
    );
  }

  // ---------------- 一个分段：先超时再成功是一行、同一个 msgid、计 1 条；只超时记 unknown、计入额度 ----------------
  {
    const sid = 'wecom:wmQretry';
    seedSession(h, sid);
    h.plan.set('wmQretry', ['timeout', 'ok']);
    const ok = await push(sid, '付款已确认');
    const reqs = h.reqTo('wmQretry');
    const rows = h.rowsOf(sid);
    check('先超时再成功：push 返回 true', ok);
    check(
      '先超时再成功：两次请求带同一个 msgid（32 个十六进制字符），账本一行 accepted、kind 是 notice（不带 opts）',
      reqs.length === 2 &&
        reqs[0]!.msgid === reqs[1]!.msgid &&
        /^[0-9a-f]{32}$/.test(reqs[0]!.msgid) &&
        Buffer.byteLength(reqs[0]!.msgid) <= 32 &&
        rows.length === 1 &&
        rows[0]!.msgid === reqs[0]!.msgid &&
        rows[0]!.status === 'accepted' &&
        rows[0]!.kind === 'notice',
      json({ reqs, rows }),
    );
    check(
      '先超时再成功：客户只收到一次，已用 1 条',
      h.deliveredTo('wmQretry').length === 1 && ledger.sendWindow(sid, Date.now()).used === 1,
    );

    const sid2 = 'wecom:wmQtimeout';
    seedSession(h, sid2);
    h.plan.set('wmQtimeout', ['lost', 'lost', 'lost']);
    const msg: ChatMessage = { role: 'agent', content: '跟进一下', at: Date.now(), author: 'followup' };
    const ok2 = await push(sid2, '跟进一下', { kind: 'followup', message: msg });
    const rows2 = h.rowsOf(sid2);
    const reqs2 = h.reqTo('wmQtimeout');
    check('只超时：push 返回 false', !ok2);
    check(
      '只超时：三次请求同一个 msgid，账本一行 unknown',
      reqs2.length === 3 && new Set(reqs2.map((r) => r.msgid)).size === 1 && rows2.length === 1 && rows2[0]!.status === 'unknown',
      json({ reqs2, rows2 }),
    );
    check(
      '只超时：计入额度（已用 1 条、剩 4 条）',
      ledger.sendWindow(sid2, Date.now()).used === 1 && ledger.sendWindow(sid2, Date.now()).remaining === 4,
    );
    check('只超时：mayHaveDelivered 为真（调用方按已发处理）', ledger.mayHaveDelivered(sid2, msg));

    const sid3 = 'wecom:wmQrejected';
    seedSession(h, sid3);
    h.plan.set('wmQrejected', [{ errcode: 95001 }]);
    const msg3: ChatMessage = { role: 'agent', content: '跟进一下', at: Date.now(), author: 'followup' };
    const ok3 = await push(sid3, '跟进一下', { kind: 'followup', message: msg3 });
    const rows3 = h.rowsOf(sid3);
    check(
      '接口明确报错：一行 rejected 带 errcode、不重试，不计入额度，mayHaveDelivered 为假',
      !ok3 &&
        h.reqTo('wmQrejected').length === 1 &&
        rows3.length === 1 &&
        rows3[0]!.status === 'rejected' &&
        rows3[0]!.errcode === 95001 &&
        ledger.sendWindow(sid3, Date.now()).used === 0 &&
        !ledger.mayHaveDelivered(sid3, msg3),
      json(rows3),
    );

    // 还在发的那一段（结果没出来）：可能已经送达，算进已用条数（只会少发）
    const sidP = 'wecom:wmQpending';
    seedSession(h, sidP);
    h.plan.set('wmQpending', ['hang']);
    void push(sidP, '付款已确认');
    await waitFor(() => h.reqTo('wmQpending').length === 1);
    const wp = ledger.sendWindow(sidP, Date.now());
    check(
      '还在发、结果没出来的那一段：一行 pending，算进已用条数',
      wp.used === 1 && wp.remaining === 4 && h.rowsOf(sidP)[0]?.status === 'pending',
      json({ wp, rows: h.rowsOf(sidP) }),
    );

    // 第一次没送达就超时，退避期间客户又说了一句，重试才送达：按最后一次尝试的时刻计数，这一行算进新窗口（只会多算，审查 window[1]）
    const sidL = 'wecom:wmQlate';
    const { s: sl } = seedSession(h, sidL);
    h.plan.set('wmQlate', ['lost', 'ok']);
    const pl = push(sidL, '付款已确认');
    await waitFor(() => h.reqTo('wmQlate').length === 1);
    await sleep(50);
    const t = Date.now();
    sl.messages.push({ role: 'customer', content: '在吗', at: t, msgid: 'q-late-2', sentAt: t });
    h.store.saveSession(sl);
    await pl;
    const wl = ledger.sendWindow(sidL, Date.now());
    const rl = h.rowsOf(sidL);
    check(
      '重试晚于客户的新消息送达：一行 accepted，最后一次尝试的时刻在新消息之后，算进新窗口（已用 1 条）',
      wl.lastCustomerAt === t && wl.used === 1 && rl.length === 1 && rl[0]!.status === 'accepted' && rl[0]!.lastAttemptAt >= t,
      json({ wl, rl: rl.map((r) => ({ ...r, message: null })), t }),
    );

    // 取 access_token 失败：send_msg 被企微以 42001 拒掉，强刷 token 又失败，这一段根本没发出去，不记
    const sid4 = 'wecom:wmQtoken';
    seedSession(h, sid4);
    h.fake.tokenFails = true;
    h.plan.set('wmQtoken', ['expired', 'expired', 'expired']);
    const ok4 = await push(sid4, '付款已确认');
    h.fake.tokenFails = false;
    check(
      '取 token 失败：push 返回 false，账本里没有这一段，不计入额度',
      !ok4 && h.rowsOf(sid4).length === 0 && ledger.sendWindow(sid4, Date.now()).used === 0,
      json(h.rowsOf(sid4)),
    );
  }

  // ---------------- 卡片也是一次 send_msg：正文与卡片各一行，各带自己的 msgid，对应同一条回复 ----------------
  {
    process.env.PUBLIC_BASE_URL = 'https://travel.example.com';
    h.fake.thumbOk = true;
    const sid = 'wecom:wmQcard';
    const { s } = seedSession(h, sid);
    const reply: ChatMessage = { role: 'agent', content: '方案书在这儿：/proposal/r-guizhou/2 人均 15,800', at: Date.now() };
    s.messages.push(reply);
    h.store.saveSession(s);
    const ok = await push(sid, reply.content, { kind: 'ai', message: reply });
    process.env.PUBLIC_BASE_URL = '';
    h.fake.thumbOk = false;
    const reqs = h.reqTo('wmQcard');
    const rows = h.rowsOf(sid);
    check(
      '卡片：正文一次、卡片一次，账本两行（ai、card），msgid 各不相同、与请求一一对上，都对应这条回复',
      ok &&
        reqs.length === 2 &&
        reqs.map((r) => r.type).join(',') === 'text,link' &&
        rows.length === 2 &&
        rows.map((r) => r.kind).join(',') === 'ai,card' &&
        rows.every((r, i) => r.msgid === reqs[i]!.msgid && r.status === 'accepted' && r.message === reply) &&
        new Set(reqs.map((r) => r.msgid)).size === 2,
      json({ reqs, rows: rows.map((r) => ({ ...r, message: !!r.message })) }),
    );
    check('卡片：已用 2 条', ledger.sendWindow(sid, Date.now()).used === 2);
  }

  // ---------------- 人工回复带站内链接：「【顾问】」加在拆完卡片之后，只加在客户读到的正文上（审查 spec[1]） ----------------
  // 只有链接（或「方案书：链接」这种标签加链接）的：不单独发一条「【顾问】」，前缀加在卡片标题上；账本行数与 AI 同形的回复相同
  {
    process.env.PUBLIC_BASE_URL = 'https://travel.example.com';
    h.fake.thumbOk = true;
    const shapes: [string, string][] = [
      ['只有链接', '/proposal/r-guizhou/2'],
      ['标签加链接', '方案书：/proposal/r-guizhou/2'],
      ['正文加链接', '方案书在这儿：/proposal/r-guizhou/2 人均 15,800'],
    ];
    for (const [i, [label, text]] of shapes.entries()) {
      const got: Record<string, { reqs: SendReq[]; rows: number }> = {};
      for (const kind of ['ai', 'human'] as const) {
        const uid = `wmQhl-${kind}-${i}`;
        const sid = `wecom:${uid}`;
        const { s } = seedSession(h, sid);
        const m: ChatMessage = { role: 'agent', content: text, at: Date.now() };
        s.messages.push(m);
        h.store.saveSession(s);
        await push(sid, text, { kind, message: m });
        got[kind] = { reqs: h.reqTo(uid), rows: h.rowsOf(sid).length };
      }
      const ai = got.ai!;
      const human = got.human!;
      const sameShape =
        json(human.reqs.map((r) => r.type)) === json(ai.reqs.map((r) => r.type)) && human.rows === ai.rows && human.rows === ai.reqs.length;
      if (i < 2) {
        check(
          `人工回复${label}：客户只收到一张卡片、没有单独的「【顾问】」，卡片标题带「【顾问】」；账本行数与 AI 同形回复相同（1 行）`,
          sameShape &&
            json(human.reqs.map((r) => r.type)) === json(['link']) &&
            human.reqs[0]!.title.startsWith('【顾问】') &&
            !ai.reqs[0]!.title.includes('【顾问】'),
          json(got),
        );
      } else {
        check(
          `人工回复${label}：正文前加「【顾问】」、卡片标题不加；与 AI 同形回复一样是正文加卡片两行`,
          sameShape &&
            json(human.reqs.map((r) => r.type)) === json(['text', 'link']) &&
            human.reqs[0]!.content === `【顾问】${ai.reqs[0]!.content}` &&
            !human.reqs[1]!.title.includes('【顾问】'),
          json(got),
        );
      }
    }
    process.env.PUBLIC_BASE_URL = '';
    h.fake.thumbOk = false;
  }

  // ---------------- 旧 /reply：客户一句话之后连发 5 次，第 6 次被拒并写明「这一轮已经发满 5 条」；客户侧带「【顾问】」 ----------------
  {
    const sid = 'wecom:wmQfive';
    seedSession(h, sid);
    const codes: number[] = [];
    for (let i = 1; i <= 5; i++) codes.push((await legacyReply(sid, `顾问回复${i}`)).status);
    const got = h.deliveredTo('wmQfive').map((r) => r.content);
    const stored = h
      .msgsOf(sid)
      .filter((m) => m.role === 'agent')
      .map((m) => m.content);
    check(
      '连发 5 次人工回复：都是 200',
      codes.every((c) => c === 200),
      json(codes),
    );
    check(
      '人工回复：客户侧正文前加「【顾问】」，会话里存的是原文',
      json(got) === json([1, 2, 3, 4, 5].map((i) => `【顾问】顾问回复${i}`)) &&
        json(stored) === json([1, 2, 3, 4, 5].map((i) => `顾问回复${i}`)),
      json({ got, stored }),
    );
    check(
      '人工回复：账本 5 行 human，各对应会话里的那一条',
      json(h.rowsOf(sid).map((r) => [r.kind, r.status, r.message?.content])) ===
        json([1, 2, 3, 4, 5].map((i) => ['human', 'accepted', `顾问回复${i}`])),
    );
    const before = h.msgsOf(sid).length;
    const sixth = await legacyReply(sid, '顾问回复6');
    check(
      '第 6 次人工回复被拒：409，写明「这一轮已经发满 5 条」，原因 quota_exhausted',
      sixth.status === 409 &&
        sixth.body.ok === false &&
        String(sixth.body.error).includes('这一轮已经发满 5 条') &&
        sixth.body.reason === 'quota_exhausted',
      json(sixth),
    );
    check('第 6 次被拒：会话不变、没有发出去', h.msgsOf(sid).length === before && h.reqTo('wmQfive').length === 5);
    check(
      '发满 5 条：剩 0 条，跟进也不放行',
      ledger.sendWindow(sid, Date.now()).remaining === 0 && !ledger.followupWindowAllows(sid, Date.now()),
    );

    const closed = 'wecom:wmQfive-closed';
    seedSession(h, closed, { sentAgo: 49 * H });
    const n0 = h.msgsOf(closed).length;
    const r = await legacyReply(closed, '还在吗');
    check(
      '窗口已过：旧 /reply 被拒（409，写明「客户超过 48 小时没说话」），会话不变、没发',
      r.status === 409 &&
        String(r.body.error).includes('客户超过 48 小时没说话') &&
        h.msgsOf(closed).length === n0 &&
        h.reqTo('wmQfive-closed').length === 0,
      json(r),
    );

    // 网页模拟器：没有账本、不受窗口管，人工回复同样在客户侧加「【顾问】」
    const sim = `sim-${'5'.repeat(24)}`;
    const ss = h.store.getOrCreateSession(sim, 'simulator');
    ss.messages.push({ role: 'customer', content: '在吗', at: Date.now() });
    h.store.saveSession(ss);
    const pushed: string[] = [];
    const off = subscribe(sim, (t) => pushed.push(t));
    const sr = await legacyReply(sim, '我是顾问小林');
    off();
    check(
      '网页模拟器：人工回复推送的正文前加「【顾问】」，会话里存原文，不进账本',
      sr.status === 200 &&
        json(pushed) === json(['【顾问】我是顾问小林']) &&
        h.msgsOf(sim).at(-1)?.content === '我是顾问小林' &&
        h.rowsOf(sim).length === 0,
      json({ sr, pushed }),
    );
    // 不是人工回复的推送（付款确认）不加
    await push('wecom:wmQfive-closed', '已收到您的支付');
    check('付款确认（notice）不加「【顾问】」', h.reqTo('wmQfive-closed').at(-1)?.content === '已收到您的支付');
  }

  // ---------------- 回执：msg_send_fail 按 fail_msgid 记 failed，三种说明，send.failed 事件；幂等；不进在途表、不回客户 ----------------
  {
    const cases: [string, number, string][] = [
      ['wmQfail4', 4, '客户超过 48 小时没说话，这条发不出去了'],
      ['wmQfail6', 6, '这一轮已经发满 5 条，等客户回复后才能再发'],
      ['wmQfail10', 10, '这条没送达（原因码 10）'],
    ];
    for (const [uid, failType, text] of cases) {
      const sid = `wecom:${uid}`;
      const { s } = seedSession(h, sid);
      const reply: ChatMessage = { role: 'agent', content: '这条线每人 19,800 元起', at: Date.now() };
      s.messages.push(reply);
      h.store.saveSession(s);
      await push(sid, reply.content, { kind: 'ai', message: reply });
      const [row] = h.rowsOf(sid);
      const usedBefore = ledger.sendWindow(sid, Date.now()).used;
      const sentBefore = h.reqTo(uid).length;
      const ev = h.failEvent(row!.msgid, failType);
      h.serverLog.push(ev);
      await h.sync();
      const after = h.rowsOf(sid)[0]!;
      check(
        `回执 ${failType}：账本那一行记 failed 与 fail_type，不再算已用条数`,
        after.status === 'failed' && after.failType === failType && ledger.sendWindow(sid, Date.now()).used === usedBefore - 1,
        json(after),
      );
      check(
        `回执 ${failType}：会话追加 system「${text}」`,
        h.msgsOf(sid).at(-1)?.role === 'system' && h.msgsOf(sid).at(-1)?.content === text,
      );
      check(
        `回执 ${failType}：落盘之后发 send.failed 事件`,
        await waitFor(() => events.some((e) => e.type === 'send.failed' && e.id === sid && e.failType === failType)),
        json(events.filter((e) => e.id === sid)),
      );
      check(
        `回执 ${failType}：不进在途表、不给客户发东西（不是客户消息）`,
        !h.inspect().inflight.includes(ev.msgid) && h.reqTo(uid).length === sentBefore && h.inspect().handled.includes(ev.msgid),
      );
      // 同一个 fail_msgid 再来一条回执（新的事件 msgid）：已经是 failed，不再加说明
      const n = h.msgsOf(sid).length;
      h.serverLog.push(h.failEvent(row!.msgid, failType));
      await h.sync();
      check(`回执 ${failType}：同一条重复的回执不再加说明`, h.msgsOf(sid).length === n);
    }
    // 不认识的 msgid（不是我们发的）：什么都不做
    const n = events.length;
    h.serverLog.push(h.failEvent('f'.repeat(32), 4));
    await h.sync();
    check('不认识的 fail_msgid：什么都不做', events.length === n);
  }

  // ---------------- 去重情况 1：会话里、7 天集合里都没有这条 msgid → 照常处理 ----------------
  {
    const m = h.customerMsg('wmQc1', '想去云南看看');
    h.serverLog.push(m);
    const c0 = h.calls();
    await h.sync();
    const sid = 'wecom:wmQc1';
    const reply = h.msgsOf(sid).filter((x) => x.role === 'agent');
    const rows = h.rowsOf(sid);
    check(
      '情况 1：照常处理，调一次模型、回一次，AI 回复在账本里一行 ai accepted、对应这条回复',
      h.calls() === c0 + 1 &&
        h.reqTo('wmQc1').length === 1 &&
        reply.length === 1 &&
        rows.length === 1 &&
        rows[0]!.kind === 'ai' &&
        rows[0]!.status === 'accepted' &&
        rows[0]!.message === reply[0] &&
        rows[0]!.msgid === h.reqTo('wmQc1')[0]!.msgid,
      json({ calls: h.calls() - c0, rows: rows.length }),
    );
  }

  // ---------------- 去重情况 3：窗口里有这条、后面没有 AI 回复、没转人工 → alreadyRecorded 重跑，回一次（重放与新拉到各一遍） ----------------
  for (const via of ['重放', '重新拉到'] as const) {
    const uid = via === '重放' ? 'wmQc3' : 'wmQc3b';
    const sid = `wecom:${uid}`;
    const m = h.customerMsg(uid, '有新疆的线路吗');
    seedSession(h, sid, { msgid: m.msgid });
    h.serverLog.push(m);
    await h.restart();
    if (via === '重放') h.pendOnDisk(m);
    else h.rewindTo(m);
    const c0 = h.calls();
    await h.sync();
    const msgs = h.msgsOf(sid);
    check(
      `情况 3（${via}）：这句不再记一遍，调一次模型，生成一条回复、只发一次`,
      msgs.filter((x) => x.role === 'customer').length === 1 &&
        msgs.filter((x) => x.role === 'agent').length === 1 &&
        h.calls() === c0 + 1 &&
        h.reqTo(uid).length === 1,
      json({ msgs: msgs.map((x) => [x.role, x.msgid]), calls: h.calls() - c0, sent: h.reqTo(uid).length }),
    );
  }

  // ---------------- 去重情况 4：后面有 AI 回复、账本里没有它 accepted / unknown 的行 → 原样重发，不再跑模型（重放与新拉到各一遍） ----------------
  for (const via of ['重放', '重新拉到'] as const) {
    const uid = via === '重放' ? 'wmQc4' : 'wmQc4b';
    const sid = `wecom:${uid}`;
    const m = h.customerMsg(uid, '贵州几月去合适');
    const OLD = '贵州 4–10 月都合适，您几位出行？';
    const { reply } = seedSession(h, sid, { msgid: m.msgid, reply: OLD });
    h.serverLog.push(m);
    await h.restart();
    if (via === '重放') h.pendOnDisk(m);
    else h.rewindTo(m);
    const c0 = h.calls();
    await h.sync();
    check(
      `情况 4（${via}）：原样重发那条回复，不调模型、会话里不多一条`,
      h.calls() === c0 &&
        json(h.deliveredTo(uid).map((r) => r.content)) === json([OLD]) &&
        h.msgsOf(sid).filter((x) => x.role === 'agent').length === 1,
      json({ calls: h.calls() - c0, sent: h.reqTo(uid) }),
    );
    check(`情况 4（${via}）：重发的分段记在那条回复名下（accepted）`, ledger.replyDelivered(sid, reply!));
  }

  // ---------------- 去重情况 5：回复已送出（accepted 或 unknown）、会话已转人工、之后客户又说过话 → 跳过 ----------------
  {
    const variants: [string, string][] = [
      ['wmQc5a', '回复已送出（accepted）'],
      ['wmQc5b', '回复结果不明（unknown）'],
      ['wmQc5c', '会话已转人工、还没回复'],
      ['wmQc5d', '之后客户又说过话'],
      // 第 13 步：上一个进程里顾问接手了，适配器因为接手代次没发那条 AI 回复；重启之后不当成「没送出」补发
      ['wmQc5e', '回复没送出、但顾问已接手'],
    ];
    for (const [uid, label] of variants) {
      const sid = `wecom:${uid}`;
      const m = h.customerMsg(uid, '西藏几月去合适');
      if (uid === 'wmQc5e') {
        const { s } = seedSession(h, sid, { msgid: m.msgid, reply: '西藏 5–10 月最合适～' });
        s.handedOver = true;
        s.assignee = { userId: '0b7c5e1a-1d2e-4f30-8a41-0000000000a1', name: '小林', at: Date.now() };
        s.messages.push({ role: 'system', content: '本轮未发送（顾问已接手）', at: Date.now() });
        h.store.saveSession(s);
      } else if (uid === 'wmQc5a' || uid === 'wmQc5b') {
        const { reply } = seedSession(h, sid, { msgid: m.msgid, reply: '西藏 5–10 月最合适～' });
        if (uid === 'wmQc5b') h.plan.set(uid, ['lost', 'lost', 'lost']);
        await push(sid, reply!.content, { kind: 'ai', message: reply! });
      } else if (uid === 'wmQc5c') {
        const { s } = seedSession(h, sid, { msgid: m.msgid });
        s.handedOver = true;
        h.store.saveSession(s);
      } else {
        const { s } = seedSession(h, sid, { msgid: m.msgid });
        s.messages.push({ role: 'customer', content: '还有别的吗', at: Date.now(), msgid: `${m.msgid}-next` });
        h.store.saveSession(s);
      }
      h.serverLog.push(m);
      const sent0 = h.reqTo(uid).length;
      const n0 = h.msgsOf(sid).length;
      for (const via of ['重放', '重新拉到'] as const) {
        await h.restart();
        if (via === '重放') h.pendOnDisk(m);
        else h.rewindTo(m);
        const c0 = h.calls();
        await h.sync();
        check(
          `情况 5（${label}，${via}）：跳过，不调模型、不发、会话不变`,
          h.calls() === c0 && h.reqTo(uid).length === sent0 && h.msgsOf(sid).length === n0,
          json({ calls: h.calls() - c0, sent: h.reqTo(uid).length - sent0, msgs: h.msgsOf(sid).length - n0 }),
        );
      }
    }
  }

  // ---------------- 接手代次：这一轮开始之后变了，AI 回复不发，记一条说明（不变量 28 的适配器部分；第 13 步之前代次是桩） ----------------
  {
    const uid = 'wmQtake';
    const sid = `wecom:${uid}`;
    h.script.push({ hang: true });
    h.serverLog.push(h.customerMsg(uid, '想去西安'));
    const done = h.sync();
    await waitFor(() => h.hung.length > 0, 10_000);
    h.__takeoverTest.bump(sid);
    await h.releaseHung('西安这条线很经典～您几位出行？');
    await done;
    check(
      '接手代次变了：AI 回复不发，会话最后一条是「本轮未发送（顾问已接手）」',
      h.reqTo(uid).length === 0 && h.msgsOf(sid).at(-1)?.role === 'system' && h.msgsOf(sid).at(-1)?.content === '本轮未发送（顾问已接手）',
      json({ sent: h.reqTo(uid), last: h.msgsOf(sid).at(-1) }),
    );
    // 代次之后不再变：下一句照常回复
    h.serverLog.push(h.customerMsg(uid, '两个人'));
    await h.sync();
    check('接手代次不再变：下一句照常回复', h.reqTo(uid).length === 1);
  }
  // 第 13 步起引擎在写进回复之前已经比过一次（上面那组由引擎兜住）。代次在引擎写完回复之后、适配器 sendRich 之前才变：
  // 适配器那一次比较兜住，回复已在会话里，不发，后面记一条说明
  {
    const uid = 'wmQtake2';
    const sid = `wecom:${uid}`;
    const off = h.onTurnEnd((f) => {
      if (f.turn.conversationId === sid) queueMicrotask(() => h.__takeoverTest.bump(sid));
    });
    h.script.push({ content: '西安这条线很经典～您几位出行？' });
    h.serverLog.push(h.customerMsg(uid, '想去西安'));
    await h.sync();
    off();
    const msgs = h.msgsOf(sid);
    check(
      '接手代次在引擎写完回复之后才变：适配器在 sendRich 之前再比一次，不发，记「本轮未发送（顾问已接手）」',
      h.reqTo(uid).length === 0 &&
        msgs.some((x) => x.role === 'agent' && x.content.includes('西安这条线')) &&
        msgs.at(-1)?.role === 'system' &&
        msgs.at(-1)?.content === '本轮未发送（顾问已接手）',
      json({ sent: h.reqTo(uid), last: msgs.slice(-2) }),
    );
  }

  // ---------------- 文件存储的扫描器：跟进的分段只超时 → 客户只收到一次、账不退、之后不再发这一阶段 ----------------
  {
    const followup = await import('../followup.js');
    const uid = 'wmQscan';
    const sid = `wecom:${uid}`;
    const s = h.store.getOrCreateSession(sid, 'wecom') as Session & {
      followup?: { count?: number; stages?: string[]; pendingAt?: number; failures?: number };
    };
    const at = Date.now() - 3 * H;
    s.stage = 'quote';
    s.messages.push(
      { role: 'customer', content: '这条线多少钱', at: at - 60_000, msgid: 'q-scan-1', sentAt: at - 60_000 },
      { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at },
    );
    s.updatedAt = at;
    h.store.saveSession(s, false);
    h.plan.set(uid, ['timeout', 'timeout', 'timeout']);
    h.script.push({ content: '出行日期定下来了吗？' });
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    process.env.FOLLOWUP_ENABLED = '1';
    const scanPush = (id: string, text: string, opts?: Parameters<typeof wecom.wecomAdapter.push>[2]) =>
      wecom.wecomAdapter.push(id, text, opts);
    const sent1 = await followup.runFollowUpScan(scanPush, noon);
    const meta = { ...s.followup };
    const rows = h.rowsOf(sid);
    check(
      '扫描器、只超时：客户只收到一次（三次请求同一个 msgid），账本一行 followup unknown',
      sent1 === 0 &&
        h.deliveredTo(uid).length === 1 &&
        h.reqTo(uid).length === 3 &&
        rows.length === 1 &&
        rows[0]!.kind === 'followup' &&
        rows[0]!.status === 'unknown',
      json({ sent1, reqs: h.reqTo(uid), rows }),
    );
    check(
      '扫描器、只超时：按已发处理——账不退（count 1、stages 有 quote）、pendingAt 留着、不算失败',
      meta.count === 1 && json(meta.stages) === json(['quote']) && !!meta.pendingAt && !meta.failures,
      json(meta),
    );
    const c0 = h.calls();
    const sent2 = await followup.runFollowUpScan(scanPush, noon);
    process.env.FOLLOWUP_ENABLED = '';
    check('扫描器、只超时：下一轮不再发这一阶段、不再调模型', sent2 === 0 && h.reqTo(uid).length === 3 && h.calls() === c0);
  }
}

// ======================================================================================
// db：PGlite 上的 db 会话存储
// ======================================================================================

async function pgSetup(h: Harness, opts: { dataDir?: string } = {}) {
  const { openTestDb, installPgSessionStore } = await import('../db/testing.js');
  const t = await openTestDb(opts.dataDir ? { dataDir: opts.dataDir } : {});
  const fx = await installPgSessionStore(t, { varDir: process.env.VAR_DIR! });
  await h.store.initSessionStore(fx.deps);
  /** 以超级用户查：一个事务里临时换回会话用户 */
  const su = <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  interface SendRow {
    conversation_id: string;
    channel_msgid: string;
    message_seq: number | null;
    kind: string;
    status: string;
    errcode: number | null;
    fail_type: number | null;
  }
  const sendsOf = (sid: string): Promise<SendRow[]> =>
    su<SendRow>(
      'select conversation_id, channel_msgid, message_seq, kind, status, errcode, fail_type from outbound_sends where conversation_id = $1 order by sent_at, channel_msgid',
      [sid],
    );
  const seqOfMessage = async (sid: string, where: string, params: unknown[]): Promise<number | null> =>
    (
      await su<{ seq: number }>(`select seq from messages where conversation_id = $1 and ${where} order by seq desc limit 1`, [
        sid,
        ...params,
      ])
    )[0]?.seq ?? null;
  /**
   * 内存里的会话落库。发成功才写进会话的消息（引导提示、跟进）与没写进会话的，账本行要等下一个宏任务才排进写队列（等调用方写进会话、
   * 分到 seq），所以先让一个宏任务过去
   */
  const flush = async (sid: string): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await h.store.flushSession(sid, { timeoutMs: 5000 });
  };
  return { t, fx, su, sendsOf, seqOfMessage, flush };
}

async function dbSuite(h: Harness): Promise<void> {
  const { store, ledger, wecom } = h;
  const { fx, su, sendsOf, seqOfMessage, flush } = await pgSetup(h);
  const events: { type: string; id: string; failType?: number | null }[] = [];
  store.onCommitted((ev) => events.push(ev as { type: string; id: string; failType?: number | null }));
  await h.sync();

  // ---- AI 回复的账本行随会话落库：kind ai、accepted、message_seq 是那条回复的 seq、msgid 与请求一致 ----
  const aiSid = 'wecom:wmQd1';
  {
    h.serverLog.push(h.customerMsg('wmQd1', '想去云南看看'));
    await h.sync();
    await flush(aiSid);
    const rows = await sendsOf(aiSid);
    const seq = await seqOfMessage(aiSid, `role = 'agent'`, []);
    check(
      'db：AI 回复的账本行随会话落库，message_seq 对上那条回复，msgid 与请求一致',
      rows.length === 1 &&
        rows[0]!.kind === 'ai' &&
        rows[0]!.status === 'accepted' &&
        rows[0]!.message_seq === seq &&
        seq !== null &&
        rows[0]!.channel_msgid === h.reqTo('wmQd1')[0]?.msgid,
      json({ rows, seq }),
    );
  }

  // ---- 发成功才写进会话的引导提示：账本行等它写进会话、分到 seq 再写 ----
  {
    const sid = 'wecom:wmQd2';
    h.serverLog.push(h.customerMsg('wmQd2', '', { msgtype: 'image' }));
    await h.sync();
    await sleep(20);
    await flush(sid);
    const rows = await sendsOf(sid);
    const seq = await seqOfMessage(sid, `role = 'agent'`, []);
    check(
      'db：图片的引导提示（发成功才写进会话）的账本行 message_seq 对上提示那条',
      rows.length === 1 && rows[0]!.kind === 'ai' && seq !== null && rows[0]!.message_seq === seq,
      json({ rows, seq }),
    );
  }

  // ---- 老客户进入、还没有会话：补发的欢迎语单独一个短事务，不建会话 ----
  {
    const sid = 'wecom:wmQd3';
    h.serverLog.push(h.enterEvent('wmQd3'));
    await h.sync();
    const ok = await waitFor(async () => (await sendsOf(sid)).length === 1);
    const rows = await sendsOf(sid);
    const conv = await su('select id from conversations where id = $1', [sid]);
    check(
      'db：没有会话的欢迎语：一行 welcome、message_seq 为空，单独写进库；不建会话',
      ok &&
        rows[0]!.kind === 'welcome' &&
        rows[0]!.message_seq === null &&
        rows[0]!.status === 'accepted' &&
        !conv.length &&
        !store.getSession(sid),
      json({ rows, conv }),
    );
  }

  // ---- 回执：库里那一行单独一个短事务改成 failed；会话的说明随落库提交，send.failed 在提交之后 ----
  {
    const [row] = await sendsOf(aiSid);
    h.serverLog.push(h.failEvent(row!.channel_msgid, 6));
    await h.sync();
    const ok = await waitFor(async () => (await sendsOf(aiSid))[0]?.status === 'failed');
    await flush(aiSid);
    const after = (await sendsOf(aiSid))[0];
    const note = await su<{ content: string }>(
      `select content from messages where conversation_id = $1 and role = 'system' order by seq desc limit 1`,
      [aiSid],
    );
    check('db：回执把库里那一行改成 failed、fail_type 6', ok && after?.fail_type === 6, json(after));
    check('db：回执的说明随会话落库', note[0]?.content === '这一轮已经发满 5 条，等客户回复后才能再发', json(note));
    check(
      'db：send.failed 在提交之后发',
      events.some((e) => e.type === 'send.failed' && e.id === aiSid && e.failType === 6),
    );
  }

  // ---- 回执比账本行先到（那一行还在写队列里没落库）：落库的就是 failed；之后的短事务不重复加说明 ----
  {
    const sid = 'wecom:wmQd5';
    const { s } = seedSession(h, sid);
    await flush(sid);
    let release = (): void => {};
    fx.faults.gate = new Promise<void>((r) => (release = r));
    const m: ChatMessage = { role: 'agent', content: '已收到您的支付', at: Date.now() };
    s.messages.push(m);
    store.saveSession(s);
    await wecom.wecomAdapter.push(sid, m.content, { kind: 'notice', message: m });
    const [row] = h.rowsOf(sid);
    h.serverLog.push(h.failEvent(row!.msgid, 4));
    await h.sync();
    release();
    fx.faults.gate = null;
    await flush(sid);
    const ok = await waitFor(async () => (await sendsOf(sid))[0]?.status === 'failed');
    await sleep(100);
    const rows = await sendsOf(sid);
    const notes = h.msgsOf(sid).filter((x) => x.role === 'system');
    check(
      'db：回执比账本行先到：落库的就是 failed、fail_type 4，说明只有一条',
      ok && rows.length === 1 && rows[0]!.fail_type === 4 && notes.length === 1,
      json({ rows, notes }),
    );
  }

  // ---- 同上，而落库卡过 5 秒（回执那边等落库超时、按 msgid 改库时那一行还没写进去，改了个空）：排着的那一行本身已经记成 failed ----
  {
    const sid = 'wecom:wmQd5b';
    const { s } = seedSession(h, sid);
    await flush(sid);
    let release = (): void => {};
    fx.faults.gate = new Promise<void>((r) => (release = r));
    const m: ChatMessage = { role: 'agent', content: '已收到您的支付', at: Date.now() };
    s.messages.push(m);
    store.saveSession(s);
    await wecom.wecomAdapter.push(sid, m.content, { kind: 'notice', message: m });
    const [row] = h.rowsOf(sid);
    h.serverLog.push(h.failEvent(row!.msgid, 4));
    await h.sync();
    await sleep(5_300); // 回执那边的 flushSession 超时，改库的短事务排在卡住的落库后面
    release();
    fx.faults.gate = null;
    const ok = await waitFor(async () => (await sendsOf(sid)).length === 1);
    await flush(sid);
    const rows = await sendsOf(sid);
    check(
      'db：落库卡过 5 秒、改库的短事务先跑了个空：写进库的那一行照样是 failed、fail_type 4',
      ok && rows[0]?.status === 'failed' && rows[0]?.fail_type === 4,
      json(rows),
    );
  }

  // ---- 去重情况 2：只在 7 天集合里（重置之后窗口不再有它）→ 跳过 ----
  {
    const uid = 'wmQd6';
    const sid = `wecom:${uid}`;
    const a = h.customerMsg(uid, '想去云南看看');
    h.serverLog.push(a);
    await h.sync();
    h.serverLog.push(h.customerMsg(uid, '重置'));
    await h.sync();
    await flush(sid);
    const inWindow = h.msgsOf(sid).some((x) => x.msgid === a.msgid);
    const inSet = store.recentMsgids(sid).has(a.msgid);
    const sent0 = h.reqTo(uid).length;
    const n0 = h.msgsOf(sid).length;
    await h.restart();
    h.rewindTo(a);
    const c0 = h.calls();
    await h.sync();
    check('情况 2（前提）：重置之后这条不在窗口里、在 7 天集合里', !inWindow && inSet);
    check(
      '情况 2：只在 7 天集合里的重新拉到，跳过：不调模型、不发、会话不变',
      h.calls() === c0 && h.reqTo(uid).length === sent0 && h.msgsOf(sid).length === n0,
      json({ calls: h.calls() - c0, sent: h.reqTo(uid).length - sent0 }),
    );
  }

  // ---- 回执改库的短事务没写成：进本进程的待补，隔一拍再试一次（审查 once[3]） ----
  {
    // 内存里有这一行：说明照常加，库里那一行由重试改成 failed
    const sid = 'wecom:wmQr1';
    const { s } = seedSession(h, sid);
    const m: ChatMessage = { role: 'agent', content: '已收到您的支付', at: Date.now() };
    s.messages.push(m);
    store.saveSession(s);
    await wecom.wecomAdapter.push(sid, m.content, { kind: 'notice', message: m });
    await flush(sid);
    const [row] = h.rowsOf(sid);
    // 先让说明那次落库借到连接，回执的短事务借连接时失败
    fx.faults.skipAcquires = 1;
    fx.faults.acquire = new Error('selftest: 库连不上');
    h.serverLog.push(h.failEvent(row!.msgid, 6));
    await h.sync();
    await sleep(300); // 第一次改库失败（连接借不到），排进待补
    const failedFirst = fx.faults.skipAcquires === 0 && (await sendsOf(sid).catch(() => []))[0]?.status !== 'failed';
    fx.faults.acquire = null;
    fx.faults.skipAcquires = 0;
    const fixed = await waitFor(async () => (await sendsOf(sid))[0]?.status === 'failed', 5000);
    await flush(sid);
    check(
      '回执改库第一次失败（内存里有这一行）：隔一拍重试改成 failed、fail_type 6，说明只有一条',
      failedFirst && fixed && (await sendsOf(sid))[0]?.fail_type === 6 && h.msgsOf(sid).filter((x) => x.role === 'system').length === 1,
      json({ rows: await sendsOf(sid), msgs: h.msgsOf(sid).map((x) => x.role) }),
    );

    // 内存里没有这一行（预载窗口之外、库里才有）：重试改中了，照样给会话加说明
    const sid2 = 'wecom:wmQr2';
    seedSession(h, sid2);
    await flush(sid2);
    const outside = 'e'.repeat(32);
    await su(
      `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status) select tenant_id, id, $2, 'ai', now() - interval '3 days', 'accepted' from conversations where id = $1`,
      [sid2, outside],
    );
    fx.faults.acquire = new Error('selftest: 库连不上');
    h.serverLog.push(h.failEvent(outside, 4));
    await h.sync();
    await sleep(300);
    fx.faults.acquire = null;
    const hit = await waitFor(() => h.msgsOf(sid2).at(-1)?.content === '客户超过 48 小时没说话，这条发不出去了', 5000);
    const [o] = await su<{ status: string; fail_type: number | null }>(
      'select status, fail_type from outbound_sends where channel_msgid = $1',
      [outside],
    );
    check(
      '回执改库第一次失败（内存里没有这一行）：重试改中了，库里 failed、fail_type 4，会话照样加说明',
      hit && o?.status === 'failed' && o.fail_type === 4,
      json({ o, last: h.msgsOf(sid2).at(-1) }),
    );
  }

  // ---- 分三段的跟进（送达之后才写进会话）：三行的 message_seq 都等于这条消息的 seq（审查 once[4]） ----
  {
    const uid = 'wmQd8';
    const sid = `wecom:${uid}`;
    seedSession(h, sid);
    await flush(sid);
    const para = '这条线第一天抵达贵阳，入住市区酒店，晚上可以去青云市集逛逛小吃。'.repeat(15);
    const text = [para, para, para].join('\n\n');
    const msg: ChatMessage = { role: 'agent', content: text, at: Date.now(), author: 'followup' };
    h.fake.sendDelayMs = 5;
    const ok = await wecom.wecomAdapter.push(sid, text, { kind: 'followup', message: msg });
    h.fake.sendDelayMs = 0;
    const s = store.getSession(sid)!;
    s.messages.push(msg); // 调用方在推送返回之后的同一段同步代码里写进会话（同跟进的执行体）
    store.saveSession(s, false);
    await flush(sid);
    const seq = store.seqOf(msg);
    const rows = await sendsOf(sid);
    check(
      '分三段的跟进：三行账本的 message_seq 都等于这条消息的 seq',
      ok && h.reqTo(uid).length === 3 && rows.length === 3 && seq !== undefined && rows.every((r) => r.message_seq === seq),
      json({ seq, rows: rows.map((r) => [r.kind, r.status, r.message_seq]) }),
    );
  }

  // ---- 「重置」口令按 msgid 去重：重放与重新拉到都不再重置一遍（审查 once[5]；demo 的重置照常生效） ----
  {
    const uid = 'wmQd7';
    const sid = `wecom:${uid}`;
    h.serverLog.push(h.customerMsg(uid, '想去云南看看'));
    await h.sync();
    const reset = h.customerMsg(uid, '重置');
    h.serverLog.push(reset);
    await h.sync();
    const afterReset = h.msgsOf(sid).map((x) => x.content);
    h.serverLog.push(h.customerMsg(uid, '两个人'));
    await h.sync();
    await flush(sid);
    check(
      '重置（前提）：照常生效，窗口里只剩重置回复；口令的 msgid 进了 7 天集合',
      afterReset.length === 1 && afterReset[0]!.includes('重新开始') && store.recentMsgids(sid).has(reset.msgid),
      json(afterReset),
    );
    const n0 = h.msgsOf(sid).length;
    const sent0 = h.reqTo(uid).length;
    for (const via of ['重放', '重新拉到'] as const) {
      await h.restart();
      if (via === '重放') h.pendOnDisk(reset);
      else h.rewindTo(reset);
      const c0 = h.calls();
      await h.sync();
      check(
        `重置口令（${via}）：跳过，不再重置一遍、不再回「重新开始」，之后的对话还在`,
        h.calls() === c0 && h.reqTo(uid).length === sent0 && h.msgsOf(sid).length === n0,
        json({ calls: h.calls() - c0, sent: h.reqTo(uid).slice(sent0), msgs: h.msgsOf(sid).map((x) => x.content.slice(0, 12)) }),
      );
    }
  }

  // ---- 跟进：额度用发送账本（剩 1 条、窗口剩不到 2 小时都不调模型、不重排；剩 2 条照发）；经真企微适配器只超时按已发处理 ----
  {
    const runner = await import('../jobs/runner.js');
    process.env.FOLLOWUP_ENABLED = '1';
    runner.__jobsTest.start((id, text, opts) => wecom.wecomAdapter.push(id, text, opts));
    await runner.runJobsOnce(); // 启动归位与清理的排程先做掉
    const jobsFor = (sid: string) =>
      su<{ status: string; last_error: string | null }>(
        `select status, last_error from jobs where kind = 'followup' and payload->>'sessionId' = $1 order by created_at`,
        [sid],
      );
    /** 沉默了 3 小时的报价会话：客户 sentAgo 之前问过（带 sentAt），AI 答了；落库时排上跟进 */
    const silent = async (uid: string, sentAgo = 3 * H + 60_000, replyAgo = 3 * H): Promise<string> => {
      const sid = `wecom:${uid}`;
      const s = store.getOrCreateSession(sid, 'wecom');
      s.stage = 'quote';
      s.messages.push(
        { role: 'customer', content: '这条线多少钱', at: Date.now() - sentAgo, msgid: `q-${uid}`, sentAt: Date.now() - sentAgo },
        { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at: Date.now() - replyAgo },
      );
      s.updatedAt = Date.now() - replyAgo;
      store.saveSession(s, false);
      await flush(sid);
      return sid;
    };
    const used = (sid: string, n: number): void => {
      for (let i = 0; i < n; i++) ledger.recordSend(sid, 'human', null).settle('accepted');
    };

    // 剩 1 条：生成之前就判，不调模型；记 cancelled（quota），拨钟几拍也不再排
    const q1 = await silent('wmQq1');
    used(q1, 4);
    const c0 = h.calls();
    const t0 = Date.now();
    for (let k = 0; k < 4; k++) await runner.runJobsOnce(t0 + k * 5000);
    await runner.runJobsOnce(t0 + 24 * H);
    const j1 = await jobsFor(q1);
    check(
      '跟进、剩 1 条：不调模型、不发；只有一条 cancelled（quota），之后不再排',
      h.calls() === c0 &&
        h.reqTo('wmQq1').length === 0 &&
        j1.length === 1 &&
        j1[0]!.status === 'cancelled' &&
        j1[0]!.last_error === 'quota',
      json({ calls: h.calls() - c0, j1 }),
    );

    // 窗口剩不到 2 小时（客户 46.5 小时前说的话）：同样不调模型
    const q3 = await silent('wmQq3', 46.5 * H, 46.4 * H);
    const c1 = h.calls();
    await runner.runJobsOnce();
    const j3 = await jobsFor(q3);
    check(
      '跟进、窗口剩不到 2 小时：不调模型、不发，cancelled（quota）',
      h.calls() === c1 && h.reqTo('wmQq3').length === 0 && j3.length === 1 && j3[0]!.last_error === 'quota',
      json(j3),
    );

    // 剩 2 条、窗口剩 45 小时：照发
    const q2 = await silent('wmQq2');
    used(q2, 3);
    h.script.push({ content: '出行日期定下来了吗？' });
    await runner.runJobsOnce();
    await flush(q2);
    const j2 = await jobsFor(q2);
    const rows2 = await sendsOf(q2);
    const seq2 = await seqOfMessage(q2, `author = 'followup'`, []);
    check(
      '跟进、剩 2 条：照发，done；账本行 kind followup、对上写进会话的那条',
      h.reqTo('wmQq2').length === 1 &&
        j2[0]?.status === 'done' &&
        rows2.some((r) => r.kind === 'followup' && r.status === 'accepted' && r.message_seq === seq2 && seq2 !== null),
      json({ j2, rows2, seq2 }),
    );

    // 经真企微适配器、分段只超时：客户只收到一次，账不退（count 1），任务 abandoned（push_unknown），之后不再发这一阶段
    const fu = await silent('wmQfu');
    h.plan.set('wmQfu', ['timeout', 'timeout', 'timeout']);
    h.script.push({ content: '出行日期定下来了吗？' });
    await runner.runJobsOnce();
    // 结果不明的跟进没写进会话：账本行等不到 seq，过了上限才以 message_seq 为 NULL 落库
    await waitFor(async () => (await flush(fu), (await sendsOf(fu)).length === 1), 8000);
    const jf = await jobsFor(fu);
    const meta = (store.getSession(fu) as Session & { followup?: { count?: number; stages?: string[]; failures?: number } }).followup;
    const rowsF = await sendsOf(fu);
    check(
      '跟进、只超时：客户只收到一次（三次请求同一个 msgid），账本一行 followup unknown',
      h.deliveredTo('wmQfu').length === 1 &&
        h.reqTo('wmQfu').length === 3 &&
        rowsF.length === 1 &&
        rowsF[0]!.kind === 'followup' &&
        rowsF[0]!.status === 'unknown',
      json({ reqs: h.reqTo('wmQfu'), rowsF }),
    );
    check(
      '跟进、只超时：按已发处理——任务 abandoned（push_unknown），账不退（count 1）、不算失败',
      jf.length === 1 && jf[0]!.status === 'abandoned' && jf[0]!.last_error === 'push_unknown' && meta?.count === 1 && !meta.failures,
      json({ jf, meta }),
    );
    const c2 = h.calls();
    for (let d = 1; d <= 2; d++) await runner.runJobsOnce(Date.now() + d * 24 * H);
    await flush(fu);
    check(
      '跟进、只超时：之后拨钟两天不再发这一阶段、不再调模型、没有新任务',
      h.reqTo('wmQfu').length === 3 && h.calls() === c2 && (await jobsFor(fu)).length === 1,
    );
    runner.__jobsTest.stop();
    process.env.FOLLOWUP_ENABLED = '';
  }
}

// ======================================================================================
// crash → restart：落盘的 PGlite 与 var/
// ======================================================================================

async function crashSuite(h: Harness, saveNow: () => void): Promise<void> {
  const { su, flush } = await pgSetup(h, { dataDir: process.env.QUOTA_DATA_DIR! });
  await h.sync();
  // B：回复已送出、账本行已落库
  const b = h.customerMsg(KILL_B, '西藏几月去合适', { msgid: 'qk-b-1' });
  h.serverLog.push(b);
  await h.sync();
  await flush(`wecom:${KILL_B}`);
  const bRow = await waitFor(
    async () =>
      (await su(`select 1 from outbound_sends where conversation_id = $1 and status = 'accepted'`, [`wecom:${KILL_B}`])).length === 1,
  );
  check('（前提）B 的回复已送出、账本行已落库', bRow && h.reqTo(KILL_B).length === 1);
  // C：回复的第一次尝试超时（其实已送达），退避之后的重试挂住（审查 once[1]）：超时那一刻这一行就记 unknown、随落库进库
  h.plan.set(KILL_C, ['timeout', 'hang']);
  const c = h.customerMsg(KILL_C, '新疆几月去合适', { msgid: 'qk-c-1' });
  h.serverLog.push(c);
  void h.wecom.syncFromCallback('tok-c');
  const cReady = await waitFor(
    async () =>
      h.reqTo(KILL_C).length === 2 &&
      (await su(`select 1 from outbound_sends where conversation_id = $1 and status = 'unknown'`, [`wecom:${KILL_C}`])).length === 1,
    10_000,
  );
  check('（前提）C 的第一次尝试超时、已送达，重试挂住；账本行已按 unknown 落库', cReady && h.deliveredTo(KILL_C).length === 1);
  // A：客户这句已入库、模型卡住（回复还没生成）
  h.script.push({ hang: true });
  const a = h.customerMsg(KILL_A, '想去云南看看', { msgid: 'qk-a-1' });
  h.serverLog.push(a);
  void h.wecom.syncFromCallback('tok-kill');
  const ready = await waitFor(
    async () =>
      h.hung.length > 0 &&
      (await su(`select 1 from messages where conversation_id = $1 and msgid = $2`, [`wecom:${KILL_A}`, a.msgid])).length === 1,
    10_000,
  );
  check('（前提）A 这句已入库、模型在生成中', ready);
  // 盘上的在途表：A 在（推进 cursor 时就落盘了）；B 补进去，像是进程死在 B 发完、还没把「处理完」落盘的那一刻
  const st = h.readState();
  h.writeState({ ...st, pending: [...(st.pending ?? []), { msg: b, tries: 0 }] });
  const pend = h.readState().pending?.map((p) => p.msg.msgid);
  check('（前提）盘上的在途表里是 C、A 与 B', json(pend) === json([c.msgid, a.msgid, b.msgid]), json(pend));
  saveNow();
  process.kill(process.pid, 'SIGKILL');
  await sleep(10_000);
}

async function restartSuite(h: Harness): Promise<void> {
  const { su, flush, sendsOf } = await pgSetup(h, { dataDir: process.env.QUOTA_DATA_DIR! });
  const A = `wecom:${KILL_A}`;
  const B = `wecom:${KILL_B}`;
  const C = `wecom:${KILL_C}`;
  check(
    '（前提）重启之后预载出 B 的账本行：已用 1 条',
    h.ledger.sendWindow(B, Date.now()).used === 1,
    json(h.ledger.sendWindow(B, Date.now())),
  );
  const c0 = h.calls();
  await h.sync(); // 启动重放
  await flush(A);
  const msgs = await su<{ role: string; msgid: string | null }>(
    `select role, msgid from messages where conversation_id = $1 order by seq`,
    [A],
  );
  check(
    '已入库未回复被杀：重启后恰好回复一次（这句不再记一遍、调一次模型、发一次）',
    h.reqTo(KILL_A).length === 1 &&
      h.calls() === c0 + 1 &&
      json(msgs.map((m) => m.role)) === json(['customer', 'agent']) &&
      msgs[0]!.msgid === 'qk-a-1',
    json({ sent: h.reqTo(KILL_A), calls: h.calls() - c0, msgs }),
  );
  check('回复已送出的那条重放：不补发', h.reqTo(KILL_B).length === 0);
  const cRows = await sendsOf(C);
  check(
    '第一次超时（已送达）、重试挂住时被杀：重启后不重发（预载读回 unknown 的那一行），库里仍是一行 unknown',
    h.reqTo(KILL_C).length === 0 && cRows.length === 1 && cRows[0]!.status === 'unknown' && cRows[0]!.kind === 'ai',
    json({ sent: h.reqTo(KILL_C), cRows }),
  );
  check('重放之后在途表清空', await waitFor(() => !(h.readState().pending ?? []).length));
  // 再重新拉到一次 A（恢复了更早的 var/ 备份）：回复已送出，跳过
  const a = h.customerMsg(KILL_A, '想去云南看看', { msgid: 'qk-a-1' });
  h.serverLog.push(a);
  await h.restart();
  h.rewindTo(a);
  const c1 = h.calls();
  await h.sync();
  check('已回复过的消息重新拉到：不再回复', h.reqTo(KILL_A).length === 1 && h.calls() === c1);

  // 重启之后才收到 B 那条回复的 msg_send_fail（停机期间到达、新进程拉到）：预载来的行也改得到库（审查 spec[0]、once[0]、window[0]）
  const [bRow] = await sendsOf(B);
  const NOTE4 = '客户超过 48 小时没说话，这条发不出去了';
  const notes = async (): Promise<number> =>
    (await su(`select 1 from messages where conversation_id = $1 and role = 'system' and content = $2`, [B, NOTE4])).length;
  const ev = h.failEvent(bRow!.channel_msgid, 4);
  h.serverLog.push(ev);
  await h.sync();
  const marked = await waitFor(async () => (await sendsOf(B))[0]?.status === 'failed');
  await flush(B);
  const after = (await sendsOf(B))[0];
  check(
    '重启之后的回执：库里那一行（预载来的）改成 failed、fail_type 4，会话的说明只有一条',
    marked && after?.fail_type === 4 && (await notes()) === 1,
    json({ after, notes: await notes() }),
  );
  // cursor 回退（恢复了更早的 var/），同一条回执再收到一次：已经是 failed，不再加说明
  await h.restart();
  h.rewindTo(ev);
  await h.sync();
  await sleep(200);
  await flush(B);
  check(
    'cursor 回退、同一条回执再收到一次：不重复加说明，库里仍是 failed、fail_type 4',
    (await notes()) === 1 && (await sendsOf(B))[0]?.status === 'failed' && (await sendsOf(B))[0]?.fail_type === 4,
  );
}

// ======================================================================================
// stop → stopped：停机的 normal 段截止之后才生成好的回复（文件存储，同一个 var/）
// ======================================================================================

/**
 * 模型在 normal 段截止之后才回包：适配器不开始 send_msg（账本行已无处可写，退出时还没回包的话重启后会再发一遍），这条留在在途表里
 * （审查 once[2]）。假企微对这个客户的 send_msg 一律挂住：万一发了，就像退出时响应还没回的那一次
 */
async function stopSuite(h: Harness): Promise<void> {
  const sid = `wecom:${STOP_U}`;
  await h.sync(); // 冷启动，建出状态文件
  h.plan.set(STOP_U, ['hang', 'hang', 'hang']);
  h.script.push({ hang: true });
  const m = h.customerMsg(STOP_U, '想去西藏看看', { msgid: 'qs-1' });
  h.serverLog.push(m);
  void h.wecom.syncFromCallback('tok-stop');
  check('（前提）模型在生成中', await waitFor(() => h.hung.length > 0, 10_000));
  const t0 = Date.now();
  const stopped = h.store.runShutdownHooks(2000); // normal 段到第 1.5 秒
  await sleep(1700);
  await h.releaseHung('西藏 5–10 月最合适～您几位出行？');
  const ok = await stopped;
  const replied = await waitFor(() => (h.store.getSession(sid)?.messages ?? []).some((x) => x.role === 'agent'), 5000);
  await sleep(300);
  check('（前提）normal 段超时、回复在截止之后才生成好、写进了会话', !ok && replied && Date.now() - t0 >= 1500);
  check('normal 段截止之后：不开始 send_msg', h.reqTo(STOP_U).length === 0, json(h.reqTo(STOP_U)));
  check(
    'normal 段截止之后：这条留在盘上的在途表里（重启后重放）',
    await waitFor(() => (h.readState().pending ?? []).some((p) => p.msg.msgid === m.msgid), 3000),
    json(h.readState().pending),
  );
}

async function stoppedSuite(h: Harness): Promise<void> {
  const sid = `wecom:${STOP_U}`;
  const c0 = h.calls();
  await h.sync(); // 启动重放
  check(
    '停机截止 → 重启：按情况 4 原样补发一次，不再调模型',
    h.reqTo(STOP_U).length === 1 &&
      h.deliveredTo(STOP_U)[0]?.content === '西藏 5–10 月最合适～您几位出行？' &&
      h.calls() === c0 &&
      (h.store.getSession(sid)?.messages ?? []).filter((x) => x.role === 'agent').length === 1,
    json({ sent: h.reqTo(STOP_U), calls: h.calls() - c0 }),
  );
  check('停机截止 → 重启：补发之后在途表清空', await waitFor(() => !(h.readState().pending ?? []).length));
}

// ======================================================================================
// rpg：真实 Postgres
// ======================================================================================

async function realPgSuite(h: Harness): Promise<void> {
  const { createRealPgFixture } = await import('../db/testing.js');
  const { openDb } = await import('../db/client.js');
  const fx = await createRealPgFixture(process.env.PG_TEST_URL!);
  const app = await openDb(fx.urls.app);
  try {
    await h.store.initSessionStore({ db: app.db, tenantId: fx.tenantId, tenantSlug: 'demo', varDir: process.env.VAR_DIR! });
    await h.sync();
    const sid = 'wecom:wmQrpg';
    h.serverLog.push(h.enterEvent('wmQrpg'));
    await h.sync();
    const rowsOf = () =>
      fx.query<{ kind: string; status: string; message_seq: number | null; fail_type: number | null; channel_msgid: string }>(
        'select kind, status, message_seq, fail_type, channel_msgid from outbound_sends where conversation_id = $1',
        [sid],
      );
    const ok = await waitFor(async () => (await rowsOf()).length === 1);
    const rows = await rowsOf();
    const conv = await fx.query('select id from conversations where id = $1', [sid]);
    check(
      '真实 PG：没有会话的欢迎语单独一个短事务写进库（welcome、message_seq 为空），不建会话',
      ok && rows[0]!.kind === 'welcome' && rows[0]!.message_seq === null && rows[0]!.status === 'accepted' && !conv.length,
      json({ rows, conv }),
    );
    h.serverLog.push(h.failEvent(rows[0]!.channel_msgid, 4));
    await h.sync();
    const failed = await waitFor(async () => (await rowsOf())[0]?.status === 'failed');
    check(
      '真实 PG：回执单独一个短事务把那一行改成 failed、fail_type 4（没有会话，不加说明）',
      failed && (await rowsOf())[0]!.fail_type === 4,
    );
  } finally {
    await app.close().catch(() => {});
    await fx.drop();
  }
}
