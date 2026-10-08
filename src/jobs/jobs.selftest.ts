// 任务表与跟进的自测（docs/architecture/02-conversations-workbench/spec.md「任务表与跟进」、R17、不变量 38、验收 22；plan 第 10 步）。
// 本文件带上 JOBS_CHILD 再起几次自己（单进程 node --import tsx，超时 SIGKILL，不留孤儿）：
//   main：PGlite 上装 DB 配置与 db 会话存储，跑排程与取消、开关关时不排、到点发出且过出口护栏（编造的金额发不出去）、记账与 sending
//         在推送之前已提交、明确失败退账并按节奏重试到上限、推送结果不明按已发处理、「别发了」之后不再排、夜间顺延（排程时与执行时）、
//         启动时各类 running / sending 的去向、停机 normal 段把还没进 sending 的跟进改回 pending、handoff_notify 与 retention_purge
//         的排程、db 存储下扫描器不动、出口护栏本身；
//         审查之后加的：重试用完只留一条 failed、额度不够不调模型也不再排、租户锁不在手里不认领、结果写失败下一拍补写、跟进话术里的
//         链接与「顾问会联系您」交给护栏删、重置取消待执行的转人工通知；
//   file：文件存储、mock 引擎，「不用了，就订这个」照常建单，沉默到阈值之后扫描器照常发出 closing 跟进；
//   落盘的 PGlite 一串四个进程：sending 之前被 SIGKILL → 重启照常发一次；sending 之后（推送途中）被 SIGKILL → 重启记 abandoned、不重发；
//   rpg（PG_TEST_URL 设了才跑）：真实 Postgres 上另一个认领者拿着 5 个任务不提交，runner 不等它、拿到其余 7 个，两边不相交；
//         另一个认领者把正在生成话术的那一行归位、重新认领之后，原认领者的 sending 改不中、不推送（认领令牌）。
// 子进程预加载 src/store/parity-clock.ts，钟从当天本地 12:00 起走：夜间时段的断言不受在几点跑的影响（rpg 例外：用真钟，关掉夜间时段）。
// 文件存储下的扫描器由锁定的 llm.selftest F1 测；拒绝识别的向量表在这里。
// 用法：npx tsx src/jobs/jobs.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { JobRow } from '../db/repo/jobs.js';
import type { Session } from '../types.js';

const CHILD = process.env.JOBS_CHILD ?? '';
const SELF = fileURLToPath(import.meta.url);
const CLOCK_MODULE = fileURLToPath(new URL('../store/parity-clock.ts', import.meta.url));

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
  data: Record<string, unknown>;
}

if (CHILD) await childMain(CHILD);
else await parentMain();

// ======================================================================================
// 父进程
// ======================================================================================

async function parentMain(): Promise<never> {
  const varParent = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(varParent, { recursive: true });
  const ROOT = fs.mkdtempSync(path.join(varParent, 'wecom-jobs-selftest-'));
  process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
  const NOON = new Date().setHours(12, 0, 0, 0);

  // 纯函数：拒绝识别的向量表（plan「实施记录 · 第 1 步」第 8 类：锁定原话与反例都不算拒绝）
  {
    const { followupOptOutOf } = await import('./optout.js');
    const yes = [
      '不用了',
      '不用了，谢谢',
      '谢谢，不用了',
      '好的不用了',
      '不用了 谢谢',
      '别发了',
      '别再发了',
      '你们别再给我发消息了',
      '不要再给我发消息了',
      '别打扰我了',
      '不用再联系我了',
      '不需要了',
      '都不需要了',
      '已经订别家了',
      '已经在别家订了',
      '我们已经订了别家的了',
      '不考虑了',
      '那就不考虑了',
      '算了，不考虑了',
      // 常见的「别发了」说法：带时间副词或客气的前缀、带 emoji 与微信表情码、叠说、破折号连字符、英文应答、繁体
      '以后别发了',
      '请不要再发了',
      '麻烦别发了',
      '拜托别发了',
      '今后不要再发了',
      '求你别发了',
      '以后别再联系我了',
      '麻烦您以后别再发了',
      '不用了😊',
      '👍不用了👍',
      '别发了[捂脸]',
      '好的不用了[微笑]',
      '不考虑了[OK]',
      '不用了不用了',
      '不用了！！',
      '不用了——谢谢',
      '不用了-谢谢',
      'ok不用了',
      'OK 不用了',
      '不用了thx',
      '不用了 thank you',
      '別發了',
      '不要再發了',
      '不考慮了',
      '已經在別家訂了',
      '謝謝，不用了',
      // 其余小句只是客气话或应答
      '不用了，谢谢您的推荐',
      '不需要了，有需要我再联系你',
      '好吧，不用了',
      '嗯嗯 不用了 谢谢啦',
    ];
    const no = [
      // 第 1 步第 8 类的反例与锁定原话
      '先不用发方案了，我再想想',
      '不用再看看了，就订这个',
      '不用倒时差',
      '算了 就这个吧 订',
      '别的不考虑',
      '先不用了',
      '我们一家人想出去玩，我和老公，两个孩子，还有我婆婆72岁，孩子想看熊猫，婆婆也怕高反',
      '我们俩度蜜月 听说高反挺吓人的 想去云南',
      '算了 听说高反挺吓人的 换云南吧',
      '九寨海拔高吗 我妈怕高反',
      '另外，孩子要带护照吗',
      '海拔三千米会不会高反',
      '支付链接找不到了',
      '先交钱然后人跑了咋整',
      // 疑问、否定、暂时、有宾语
      '不用了吗',
      '不用了？',
      '不需要了吧',
      '我们不用了吧？',
      '不是不需要了，是想晚点再定',
      '暂时不考虑了',
      '先不考虑了',
      '不用发了',
      '方案不用再发了',
      '你们别发错了',
      '不考虑别的了',
      '不需要接送',
      '不用了解了，直接下单',
      // 拒绝小句后面跟着成交、问询、改需求、看别的线路：谢绝的是某个附加项，不是跟进（审查之后改的第 1 条）
      '不用了，就订这个',
      '不用了，直接下单吧',
      '不需要了，就订这条',
      '算了不用了，订吧',
      '不用了，发我付款链接',
      '不考虑了，看看云南吧',
      '不用了，换个日期吧',
      '好的不用了，帮我改成3个人',
      '不用了 我就要这条',
      '嗯不用了 订吧',
      '不用了，再给我看看贵州的',
      '不用了，就这个吧',
      '好的不用了，帮我订吧',
      '不需要了，就三亚那条',
      '不用了，我明天付款',
      '不用了不用了，订吧',
      '不用了😊就订这个',
      '不用了 我再想想',
      '不用了，我先跟家里人商量下',
      '太贵了，不考虑了，有没有便宜点的？',
      '这个价位太高了，不考虑了',
      '那就不考虑了，换个便宜点的吧',
      '不考虑了 有没有国内的',
      '那就不用了，我们换个目的地',
      // 疑问照旧排除（spec「疑问与否定排除」）；只有应答、只有占位的不算
      '可以别发了吗',
      '别再发了好吗？',
      '能不能别再发了？',
      '算了',
      '好的谢谢',
      '[图片]',
    ];
    const missed = yes.filter((t) => !followupOptOutOf(t));
    const wrong = no.filter((t) => followupOptOutOf(t));
    check(
      '拒绝识别：「不用了」「别发了」「不需要了」「已经订别家了」「不考虑了」这类小句都认得出（带前缀、表情、叠说、繁体的也算）',
      !missed.length,
      json(missed),
    );
    check('拒绝识别：锁定原话、反例、疑问、否定、「先」「暂时」、带宾语的，以及拒绝之外还有别的内容的，都不算', !wrong.length, json(wrong));
  }

  const runChild = (
    mode: string,
    env: Record<string, string> = {},
    opts: { clockMs?: number | null; timeoutMs?: number } = {},
  ): { status: number | null; signal: NodeJS.Signals | null; out: string; result: ChildResult | null } => {
    const resultFile = path.join(ROOT, `${mode}-${Date.now()}.json`);
    const clock = opts.clockMs === undefined ? NOON : opts.clockMs;
    const args = ['--import', 'tsx', ...(clock === null ? [] : ['--import', CLOCK_MODULE]), SELF];
    const r = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        JOBS_CHILD: mode,
        JOBS_RESULT: resultFile,
        CONFIG_SOURCE: 'file',
        ...(clock === null ? {} : { PARITY_CLOCK_MS: String(clock) }),
        ...env,
      },
      timeout: opts.timeoutMs ?? 240_000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    let result: ChildResult | null = null;
    try {
      result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as ChildResult;
    } catch {
      result = null;
    }
    return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, result };
  };
  const merge = (label: string, r: ReturnType<typeof runChild>): Record<string, unknown> => {
    if (!r.result) {
      fails.push(`${label}：子进程没留下结果（status=${r.status} signal=${r.signal}）${r.out.slice(-1500)}`);
      return {};
    }
    pass += r.result.pass;
    for (const f of r.result.fails) fails.push(`${label}：${f}`);
    return r.result.data;
  };

  // ---- main ----
  {
    const r = runChild('main', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'main-')) });
    merge('main', r);
    check('main 子进程正常结束', r.status === 0, `status=${r.status} signal=${r.signal} ${r.out.slice(-1500)}`);
  }

  // ---- 文件存储：经 mock 引擎的拒绝识别与扫描器 ----
  {
    const r = runChild('file', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'file-')) });
    merge('文件存储', r);
    check('文件存储子进程正常结束', r.status === 0, `status=${r.status} signal=${r.signal} ${r.out.slice(-1500)}`);
  }

  // ---- 落盘的 PGlite：sending 前后被 SIGKILL，各自重启一次 ----
  {
    const dataDir = fs.mkdtempSync(path.join(ROOT, 'pgdata-'));
    const varDisk = fs.mkdtempSync(path.join(ROOT, 'disk-'));
    const env = { VAR_DIR: varDisk, JOBS_DATA_DIR: dataDir };
    // 每个进程的钟往后错开一分钟：库里留下的时刻不会比下一个进程的「现在」晚
    const c1 = runChild('crash-before', env, { clockMs: NOON });
    merge('sending 之前崩溃', c1);
    check(
      'sending 之前崩溃：进程被 SIGKILL（生成话术途中、任务已是 running）',
      c1.signal === 'SIGKILL',
      `${c1.status} ${c1.out.slice(-800)}`,
    );
    const c2 = runChild('restart-before', env, { clockMs: NOON + 60_000 });
    merge('sending 之前崩溃 → 重启', c2);
    check('sending 之前崩溃 → 重启：正常结束', c2.status === 0, `${c2.status} ${c2.out.slice(-1200)}`);
    const c3 = runChild('crash-after', env, { clockMs: NOON + 120_000 });
    merge('sending 之后崩溃', c3);
    check('sending 之后崩溃：进程在推送途中被 SIGKILL', c3.signal === 'SIGKILL', `${c3.status} ${c3.out.slice(-800)}`);
    const c4 = runChild('restart-after', env, { clockMs: NOON + 180_000 });
    merge('sending 之后崩溃 → 重启', c4);
    check('sending 之后崩溃 → 重启：正常结束', c4.status === 0, `${c4.status} ${c4.out.slice(-1200)}`);
  }

  // ---- 真实 Postgres：两个认领者 ----
  let realPgRan = false;
  if (process.env.PG_TEST_URL) {
    realPgRan = true;
    // 真实 PG 子进程用真钟（库的 now() 不跟着拨），CI 在 UTC 下跑：凌晨跑时跟进会被夜间时段顺延到 9:00、根本不到点。
    // 这里关掉夜间时段（开始与结束同一个钟点），夜间顺延由 main 子进程在钉住的钟上测
    const r = runChild(
      'rpg',
      { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'rpg-')), FOLLOWUP_QUIET_START: '0', FOLLOWUP_QUIET_END: '0' },
      { clockMs: null },
    );
    merge('真实 PG', r);
    check('真实 PG 子进程正常结束', r.status === 0, `status=${r.status} ${r.out.slice(-1500)}`);
  }

  if (fails.length) {
    console.error(`JOBS SELFTEST FAIL：${fails.length} 项（通过 ${pass} 项）`);
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log(
    `JOBS SELFTEST PASS: ${pass} 项断言全通（拒绝识别 / 排程与取消 / 开关关时不排 / 到点发出过护栏 / 记账与 sending 先提交 / 明确失败退账重试 / ` +
      `结果不明按已发 / 别发了之后不再排 / 夜间顺延 / 启动归位 / 停机改回 pending / 转人工通知与清理的排程 / sending 前后崩溃 / ` +
      `重试用完不再排 / 额度不够不调模型 / 锁不在手里不认领 / 结果补写 / 跟进话术的链接与联系承诺 / 重置取消通知 / 紧急情况的通知与升级 / 两个窗口落库 / 文件存储下要成交的话不算拒绝 / ` +
      `记账等提交期间被接手不推送、任务记 abandoned` +
      `${realPgRan ? ' / 真实 PG：两个认领者不重复认领、认领令牌' : '；真实 PG 部分未跑'}）`,
  );
  process.exit(0);
}

// ======================================================================================
// 子进程
// ======================================================================================

/** 假模型：按脚本回话。hang 的那一步不回包，直到 releaseHung() */
interface Step {
  content?: string;
  hang?: boolean;
}

async function childMain(mode: string): Promise<never> {
  const res: ChildResult = { pass: 0, fails: [], data: {} };
  const save = (): void => {
    res.pass = pass;
    res.fails = fails;
    fs.writeFileSync(process.env.JOBS_RESULT!, JSON.stringify(res));
  };
  const script: Step[] = [];
  const hung: http.ServerResponse[] = [];
  /** 假模型收到的对话请求（不算向量） */
  let chatCalls = 0;
  const calls = (): number => chatCalls;
  const reply = (r: http.ServerResponse, content: string): void => {
    r.setHeader('content-type', 'application/json');
    r.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    );
  };
  const fake = http.createServer((req, r) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.endsWith('/embeddings')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] };
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify({ data: (body.input ?? []).map((_, i) => ({ embedding: [1, i % 3, 2] })), usage: { prompt_tokens: 5 } }));
        return;
      }
      chatCalls += 1;
      const step = script.shift();
      if (step?.hang) {
        hung.push(r);
        return;
      }
      reply(r, step?.content ?? '好的～还有什么想了解的随时说。');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fake.unref();
  /**
   * 放行卡住的那一步。先等假模型真的收到那个请求：执行体标成 started 时生成话术的请求可能还没发到（CI 上机器慢时就是这样），
   * 这时放行只放了个空，那个请求随后到达、一直卡到 LLM 超时，子进程被父进程的超时杀掉
   */
  const releaseHung = async (content = '出行日期定下来了吗？'): Promise<void> => {
    if (!(await waitFor(() => hung.length > 0, 10_000))) fails.push('假模型 10 秒内没收到要卡住的那个请求');
    for (const r of hung.splice(0)) reply(r, content);
  };
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
    FOLLOWUP_ENABLED: '1',
    DEMO_PRUNE_HOURS: '0',
  });
  try {
    if (mode === 'main') await childMainSuite(script, releaseHung, calls);
    else if (mode === 'rpg') await childRealPg(script, releaseHung);
    else if (mode === 'file') await childFile();
    else await childDisk(mode, script, res, save);
  } catch (e) {
    fails.push(`子进程抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  save();
  process.exit(0);
}

/** 推送桩：记下每一次推送；按会话给结果（缺省送达） */
interface Push {
  id: string;
  text: string;
  /** 推送那一刻库里的样子（只有设了 probe 的会话才查） */
  durable?: unknown;
}
function makePush() {
  const pushes: Push[] = [];
  const behave = new Map<string, (p: Push) => Promise<boolean>>();
  const push = async (id: string, text: string): Promise<boolean> => {
    const p: Push = { id, text };
    pushes.push(p);
    const b = behave.get(id);
    return b ? b(p) : true;
  };
  return { pushes, behave, push };
}

async function storeSetup(opts: { dataDir?: string; dbConfig: boolean }) {
  const store = await import('../store.js');
  const { openTestDb, installSeededConfig, installPgSessionStore, fakeLock } = await import('../db/testing.js');
  const t = await openTestDb(opts.dataDir ? { dataDir: opts.dataDir } : {});
  const lock = fakeLock();
  if (opts.dbConfig) await installSeededConfig(t, { deps: { lock: async () => lock } });
  const fx = await installPgSessionStore(t, { varDir: process.env.VAR_DIR! });
  await store.initSessionStore(fx.deps);
  /** 以超级用户查：一个事务里临时换回会话用户 */
  const su = <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  interface JobView {
    id: string;
    kind: string;
    key: string;
    status: string;
    attempts: number;
    max: number;
    runAt: number;
    lastError: string | null;
    finished: boolean;
    payload: Record<string, unknown>;
  }
  const jobsOf = async (where: string, params: unknown[] = []): Promise<JobView[]> =>
    (
      await su<{
        id: string;
        kind: string;
        dedupe_key: string;
        status: string;
        attempts: number;
        max_attempts: number;
        run_at: Date | string;
        last_error: string | null;
        finished_at: Date | string | null;
        payload: Record<string, unknown> | string;
      }>(
        `select id, kind, dedupe_key, status, attempts, max_attempts, run_at, last_error, finished_at, payload from jobs where ${where} order by created_at, dedupe_key`,
        params,
      )
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      key: r.dedupe_key,
      status: r.status,
      attempts: r.attempts,
      max: r.max_attempts,
      runAt: new Date(r.run_at).getTime(),
      lastError: r.last_error,
      finished: r.finished_at !== null,
      payload: typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload,
    }));
  const jobsFor = (sid: string, kind = 'followup') => jobsOf(`payload->>'sessionId' = $1 and kind = $2`, [sid, kind]);
  /** 内存里的会话落库（排程与取消随它提交） */
  const flush = (sid: string) => store.flushSession(sid, { timeoutMs: 5000 });
  /** 沉默了 ago 毫秒的会话：客户问过、AI 答了，停在 stage。落库时就排上跟进 */
  const silent = (id: string, stage: Session['stage'], ago: number, at = Date.now() - ago): Session => {
    const s = store.getOrCreateSession(id, 'wecom');
    s.stage = stage;
    s.messages.push(
      { role: 'customer', content: '这条线多少钱', at: at - 60_000 },
      { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at },
    );
    s.createdAt = Math.min(s.createdAt, at - 60_000);
    s.updatedAt = at;
    store.saveSession(s, false);
    return s;
  };
  /** 一个场景结束：它的会话还排着的任务取消掉，后面拨钟的认领碰不到它们 */
  const retire = (...sids: string[]) =>
    su(`update jobs set status = 'cancelled', finished_at = now() where status = 'pending' and payload->>'sessionId' = any($1)`, [sids]);
  return { store, t, fx, lock, su, jobsOf, jobsFor, flush, silent, retire };
}

// ---------------- main：PGlite 上的进程内各组 ----------------

async function childMainSuite(script: Step[], releaseHung: (content?: string) => Promise<void>, calls: () => number): Promise<void> {
  const { store, fx, lock, su, jobsOf, jobsFor, flush, silent, retire } = await storeSetup({ dbConfig: true });
  const runner = await import('./runner.js');
  const followup = await import('../followup.js');
  const { followupRunAt, followupJobs } = await import('./followup.js');
  const { fakeDbError } = await import('../db/testing.js');
  const { configHealth, __configTest } = await import('../config/source.js');
  const { guardOutbound, handleMessage } = await import('../engine.js');
  const { nextPurgeAt, retentionPurgeSpec, runRetentionPurgeJob } = await import('./purge.js');
  const { handoffNotifyOps, HANDOFF_UNCLAIMED_MS, WINDOW_NOTICE_MS } = await import('./notify.js');
  const { sendWindow } = await import('../quota/ledger.js');
  const { push, pushes, behave } = makePush();
  runner.__jobsTest.start(push);
  const H = 3_600_000;
  const pushedTo = (sid: string) => pushes.filter((p) => p.id === sid);

  // ---- 纯函数：夜间顺延、清理的排程时刻、转人工通知的两个任务 ----
  {
    const at = (d: number, h: number, m = 0) => {
      const x = new Date();
      x.setDate(x.getDate() + d);
      x.setHours(h, m, 0, 0);
      return x.getTime();
    };
    check('夜间顺延：23:00 → 次日 9:00', followup.deferQuiet(at(0, 23)) === at(1, 9));
    check('夜间顺延：3:00 → 当天 9:00', followup.deferQuiet(at(0, 3)) === at(0, 9));
    check('夜间顺延：22:00 正好进时段 → 次日 9:00', followup.deferQuiet(at(0, 22)) === at(1, 9));
    check(
      '夜间顺延：21:59、9:00、12:00 原样',
      [at(0, 21, 59), at(0, 9), at(0, 12)].every((t) => followup.deferQuiet(t) === t),
    );
    check('清理：3:30 之前排当天的 3:30，之后排次日的', nextPurgeAt(at(0, 2)) === at(0, 3, 30) && nextPurgeAt(at(0, 12)) === at(1, 3, 30));
    const spec = retentionPurgeSpec(at(0, 12));
    const d = new Date(at(1, 3, 30));
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    check(
      '清理：dedupe_key 是 retention_purge:<日期>，不带 sessionId',
      spec.kind === 'retention_purge' && spec.dedupeKey === `retention_purge:${ymd}` && runner.sessionIdOf(spec.payload) === null,
      json(spec),
    );
    // 清理的执行体（第 16 步）：真的跑一次（这个库里没有候选、没有过期 trace/任务），标 done，并在同一个事务里排下一天的
    // （每小时的补排之外的那一条链）。now 传真实时钟：SQL 函数要求 p_now 与库的时钟相差不超过 5 分钟，job.runAt 仍是「计划」的
    // 那个未来时刻（tomorrow330），enqueueNext 据 max(now, job.runAt) 算，还是会排到后天 3:30
    const tomorrow330 = at(1, 3, 30);
    const purged = await runRetentionPurgeJob({ dedupeKey: spec.dedupeKey, runAt: new Date(tomorrow330) } as JobRow, Date.now());
    const next2 = purged.status === 'done' ? purged.enqueueNext?.[0] : undefined;
    check(
      '清理：到点的执行体真的跑一次、标 done，带上下一天 3:30 的那一个',
      purged.status === 'done' && next2?.runAt === at(2, 3, 30) && next2.dedupeKey === retentionPurgeSpec(tomorrow330 + 1000).dedupeKey,
      json(purged),
    );
    const ops = handoffNotifyOps('wecom:wmX', 1000, { escalated: false });
    const up = handoffNotifyOps('wecom:wmX', 2000, { escalated: true });
    check(
      '转人工通知：立即一个、10 分钟一个，payload 带 sessionId，首次加至多重试 3 次',
      ops.length === 2 &&
        ops.every(
          (o) => o.op === 'enqueue' && o.kind === 'handoff_notify' && runner.sessionIdOf(o.payload) === 'wecom:wmX' && o.maxAttempts === 4,
        ) &&
        ops[0]!.op === 'enqueue' &&
        ops[0]!.runAt === 1000 &&
        ops[1]!.op === 'enqueue' &&
        ops[1]!.runAt === 1000 + HANDOFF_UNCLAIMED_MS &&
        up.length === 1,
      json({ ops, up }),
    );
  }

  // ---- 出口护栏本身（guardOutbound）：模板原样通过；链接、markdown、内部用语、空头承诺、编造金额 ----
  {
    const s = store.getOrCreateSession('wecom:wmJobsGuard', 'wecom');
    const g = (text: string) => guardOutbound(s, text, { kind: 'followup' });
    const templates = Object.values(followup.__followupTest.TEMPLATE);
    const kept = await Promise.all(templates.map((t) => g(t!)));
    check(
      '护栏：四条阶段模板原样通过',
      kept.every((k, i) => k === templates[i]),
      json(kept),
    );
    check('护栏：去 markdown', (await g('**出发日期**定下来了吗？')) === '出发日期定下来了吗？');
    const link = await g('您看看这个 https://evil.example/x\n出发日期定了吗？');
    check('护栏：站外链接抹掉', !/https?:|evil/.test(link) && link === '您看看这个\n出发日期定了吗？', link);
    const pay = await g('支付链接在这：https://evil.example/pay/ord_x\n出发日期定了吗？');
    check(
      '护栏：不是本会话真订单的支付链接抹掉，「支付链接在这」那句一起删',
      !/pay|支付链接/.test(pay) && pay.includes('出发日期定了吗'),
      pay,
    );
    const prop = await g('方案书发您看看：/proposal/r-yunnan-mid/2\n您更想哪天出发？');
    check(
      '护栏：跟进没有本轮的方案书调用，方案书链接与「发您看看」一起删',
      !/proposal|发您看看/.test(prop) && prop.includes('哪天出发'),
      prop,
    );
    check('护栏：内部用语换掉', (await g('库里还有两条线，您更想看哪条？')).startsWith('我们这边'));
    const custom = await g('好的我帮您重排一下行程。您更想哪天出发？');
    check('护栏：改行程的空头承诺删掉', !/重排/.test(custom) && custom.includes('哪天出发'), custom);
    const claim = await g('我这就为您转接资深顾问，请稍候～');
    check('护栏：「为您转接」删掉（跟进不转人工）', !/转接/.test(claim), claim);
    const price = await g('这条线现在每人 13,579 元。这周末天气不错，适合出门走走。');
    check('护栏：编造的金额连同那句删掉', !/13,?579/.test(price) && price.includes('天气不错'), price);
    check('护栏：删完只剩一句问话（残句）也返回空串', (await g('这条线现在每人 13,579 元。您更想哪天出发？')) === '');
    check('护栏：全删光返回空串（调用方换模板）', (await g('这条线现在每人 13,579 元')) === '');
    // 「由顾问确认」「顾问会联系您」：AI 回复里会给顾问记待办，跟进不替顾问揽活，按句删（审查之后改的第 8 条）
    check('护栏：「稍后顾问会联系您」那句删掉，删光返回空串', (await g('稍后顾问会联系您确认细节，您看方便吗？')) === '');
    const defer = await g('这个我请顾问确认一下。您看哪天出发合适？');
    check('护栏：「请顾问确认」那句删掉，其余照发', defer === '您看哪天出发合适？', defer);
    const contact = await g('出发日期定了吗？顾问会在微信上联系您，您几位出行？');
    check('护栏：「顾问会在微信上联系您」那句删掉，其余照发', contact === '出发日期定了吗？', contact);
  }

  // ---- 跟进话术：网址不预先抹掉，交给护栏连同「说了给链接」的那句一起删；联系承诺同样删；删光换阶段模板（第 7、8 条） ----
  {
    const s = store.getOrCreateSession('wecom:wmJobsText', 'wecom');
    s.stage = 'quote';
    const tpl = followup.__followupTest.TEMPLATE.quote!;
    script.push(
      { content: '方案链接：https://evil.example.com/x 您看看哪天出发合适？' },
      { content: '详细方案：https://www.yuntu.com/proposal/r-sichuan/2 出发日期定了吗？' },
      { content: '稍后顾问会联系您确认细节，您看方便吗？' },
    );
    const t1 = await followup.followUpText(s);
    const t2 = await followup.followUpText(s);
    const t3 = await followup.followUpText(s);
    check('跟进话术：站外链接连同「方案链接：」那句删掉（不发半句空冒号），删光换阶段模板', t1 === tpl, t1);
    check('跟进话术：方案书链接（跟进没有本轮的方案书调用）连同那句删掉，换阶段模板', t2 === tpl, t2);
    check('跟进话术：「顾问会联系您」删光换阶段模板', t3 === tpl, t3);
  }

  // ---- 排程与取消：AI 回复落库时排、客户回话即取消（经引擎的真实轮次） ----
  const A = 'wecom:wmJobsA';
  {
    script.push({ content: '云南这边有两条线，您更想看古城还是雪山？' });
    await handleMessage(A, '想去云南看看', 'wecom');
    await flush(A);
    const s = store.getSession(A)!;
    check('前提：这一轮之后停在 recommend', s.stage === 'recommend', s.stage);
    const j1 = await jobsFor(A);
    check(
      '排程：AI 回复落库时排 followup:<会话>:<阶段>，runAt = 最后动静 + 阈值，payload 带 sessionId',
      j1.length === 1 &&
        j1[0]!.status === 'pending' &&
        j1[0]!.key === `followup:${A}:recommend` &&
        j1[0]!.runAt === followupRunAt(s, 360 * 60_000) &&
        j1[0]!.payload.sessionId === A &&
        j1[0]!.max === 3,
      json(j1),
    );
    // 客户回话（不经引擎、也没有 AI 回复，比如企微的图片占位）：只取消
    s.messages.push({ role: 'customer', content: '[图片]', at: Date.now() });
    store.saveSession(s);
    await flush(A);
    const j2 = await jobsFor(A);
    check('取消：客户回话落库时，排着的跟进取消', j2.length === 1 && j2[0]!.status === 'cancelled' && j2[0]!.finished, json(j2));
    // 再来一轮：客户回话取消、AI 回复重新排（按新的最后动静）
    script.push({ content: '古城这条走丽江大理，您几位出行？' });
    await handleMessage(A, '古城吧', 'wecom');
    await flush(A);
    const j3 = await jobsFor(A);
    const pend = j3.filter((j) => j.status === 'pending');
    check(
      '排程：下一次 AI 回复按新的最后动静再排一个，旧的仍是 cancelled',
      j3.length === 2 && pend.length === 1 && pend[0]!.runAt === followupRunAt(store.getSession(A)!, 360 * 60_000),
      json(j3),
    );
    await retire(A);
  }

  // ---- 换了阶段（没有客户回话，比如 AI 接着建了单）：旧阶段的取消、按新阶段排 ----
  {
    const A2 = 'wecom:wmJobsA2';
    const s = silent(A2, 'quote', 30 * 60_000);
    await flush(A2);
    s.stage = 'closing';
    s.messages.push({ role: 'agent', content: '订单给您留着，日期定了跟我说～', at: Date.now() });
    store.saveSession(s);
    await flush(A2);
    const j = await jobsFor(A2);
    check(
      '换阶段：旧阶段的任务取消，按新阶段与新的最后动静排',
      j.length === 2 &&
        j[0]!.key === `followup:${A2}:quote` &&
        j[0]!.status === 'cancelled' &&
        j[1]!.key === `followup:${A2}:closing` &&
        j[1]!.status === 'pending' &&
        j[1]!.runAt === followupRunAt(s, 180 * 60_000),
      json(j),
    );
    await retire(A2);
  }

  // ---- 生成话术期间客户回了话：在活对象上重判，取消、不推送；AI 接着回的那句照常再排 ----
  {
    const N = 'wecom:wmJobsN';
    silent(N, 'quote', 3 * H);
    await flush(N);
    script.push({ hang: true });
    const tick = runner.runJobsOnce();
    await waitFor(() => runner.__jobsTest.mine().some((m) => m.phase === 'started'));
    const s = store.getSession(N)!;
    s.messages.push({ role: 'customer', content: '我再看看', at: Date.now() });
    store.saveSession(s);
    s.messages.push({ role: 'agent', content: '好的，您慢慢看，有想法随时说～', at: Date.now() });
    store.saveSession(s);
    await releaseHung();
    await tick;
    await flush(N);
    const j = await jobsFor(N);
    check(
      '生成期间客户回话：重判之后取消（changed）、不推送；之后按 AI 那句回复再排一个',
      !pushedTo(N).length &&
        j.length === 2 &&
        j[0]!.status === 'cancelled' &&
        j[0]!.lastError === 'changed' &&
        j[1]!.status === 'pending' &&
        j[1]!.runAt === followupRunAt(s, 120 * 60_000),
      json(j),
    );
    await retire(N);
  }

  // ---- FOLLOWUP_ENABLED 不是 1：一个跟进任务都不排；到点时关了的，取消、不发 ----
  {
    const B = 'wecom:wmJobsB';
    process.env.FOLLOWUP_ENABLED = '';
    script.push({ content: '云南这边有两条线，您更想看古城还是雪山？' });
    await handleMessage(B, '想去云南看看', 'wecom');
    silent('wecom:wmJobsB2', 'quote', 3 * H);
    await flush(B);
    await flush('wecom:wmJobsB2');
    check(
      '开关：FOLLOWUP_ENABLED 未设时不排任何跟进任务',
      (await jobsOf(`kind = 'followup' and payload->>'sessionId' in ('wecom:wmJobsB', 'wecom:wmJobsB2')`)).length === 0,
    );
    process.env.FOLLOWUP_ENABLED = '1';
    silent('wecom:wmJobsB3', 'quote', 3 * H);
    await flush('wecom:wmJobsB3');
    process.env.FOLLOWUP_ENABLED = '';
    await runner.runJobsOnce();
    const j = await jobsFor('wecom:wmJobsB3');
    check(
      '开关：排着之后关掉，到点时取消、不发',
      j.length === 1 && j[0]!.status === 'cancelled' && !pushedTo('wecom:wmJobsB3').length,
      json(j),
    );
    process.env.FOLLOWUP_ENABLED = '1';
  }

  // ---- 到点发出：过出口护栏（编造的金额发不出去）；推送那一刻记账与 sending 已提交；送达记 done、写进会话 ----
  {
    const C = 'wecom:wmJobsC';
    silent(C, 'quote', 3 * H);
    await flush(C);
    const job = (await jobsFor(C))[0]!;
    const FAKE = '这条线现在每人 13,579 元，名额不多了。您看什么时候方便定下来？';
    script.push({ content: FAKE });
    behave.set(C, async (p) => {
      const [row] = await su<{ f: Record<string, unknown> | null }>(`select state->'followup' as f from conversations where id = $1`, [C]);
      const [j] = await jobsOf(`id = $1`, [job.id]);
      p.durable = { followup: row?.f ?? null, status: j?.status };
      return true;
    });
    await runner.runJobsOnce();
    await flush(C);
    const sent = pushedTo(C);
    const s = store.getSession(C) as Session & { followup?: Record<string, unknown> };
    const last = s.messages.at(-1);
    check('到点发出：推了一次', sent.length === 1, json(sent));
    check(
      '护栏：模型编的金额不在发出的文本里（验收 22）',
      !!sent[0]?.text && FAKE.includes('13,579') && !/13,?579/.test(sent[0].text),
      sent[0]?.text ?? '',
    );
    const d = sent[0]?.durable as
      | { followup: { count?: number; stages?: string[]; pendingAt?: number } | null; status?: string }
      | undefined;
    check(
      '最多发一次：推送那一刻库里已记账（count、stages、pendingAt）且任务是 sending',
      d?.status === 'sending' && d.followup?.count === 1 && json(d.followup?.stages) === json(['quote']) && !!d.followup?.pendingAt,
      json(d),
    );
    const [after] = await jobsOf(`id = $1`, [job.id]);
    check('送达：任务记 done', after?.status === 'done' && after.finished, json(after));
    check(
      '送达：跟进写进会话（author=followup），pendingAt 清掉、失败计数归零，updatedAt 不动',
      last?.role === 'agent' &&
        last.author === 'followup' &&
        last.content === sent[0]?.text &&
        s.followup?.pendingAt === undefined &&
        s.followup?.failures === 0 &&
        s.updatedAt < Date.now() - 2 * H,
      json({ last, f: s.followup }),
    );
    await runner.runJobsOnce(Date.now() + 2 * H);
    check('同一阶段只跟一次：之后不再推', pushedTo(C).length === 1);
    await retire(C);
  }

  // ---- 审查第 6 条（concurrency[2]）：记账、等提交期间被接手，推送前再比一次代次，不推送、任务记 abandoned ----
  {
    const tk = await import('../handoff/takeover.js');
    const TK2 = 'wecom:wmJobsTakeover';
    silent(TK2, 'quote', 3 * H);
    await flush(TK2);
    const job2 = (await jobsFor(TK2))[0]!;
    script.push({ content: '这条线现在每人 9,999 元，名额不多了，要不要我帮您定下来？' });
    // sendAfterLedger 记账那一刻（saveWith → saveSession）与它 await flushSession 之间没有别的 await：
    // 挂一个 onSessionSaved 钩子，在同一段同步代码里接手，比等 phase 轮询（PGlite 几乎是瞬时的，轮询十有八九扑空）稳
    let tko: ReturnType<typeof tk.takeover> | undefined;
    const off = store.onSessionSaved((s) => {
      if (s.id !== TK2 || tko) return;
      off();
      tko = tk.takeover(TK2, tk.sharedActor());
    });
    await runner.runJobsOnce();
    off();
    await flush(TK2);
    const s2 = store.getSession(TK2) as Session & { followup?: { count?: number; pendingAt?: number } };
    const [after2] = await jobsOf(`id = $1`, [job2.id]);
    check(
      '记账、等提交期间被接手：推送前再比一次代次，这次不推、客户什么都没收到',
      tko?.changed === true && !pushedTo(TK2).length,
      json({ tko, pushed: pushedTo(TK2) }),
    );
    check(
      '记账、等提交期间被接手：任务记 abandoned（不是 done/failed），账已提交的不退（count 仍是 1）',
      after2?.status === 'abandoned' && after2.finished && after2.lastError === 'taken_over' && s2.followup?.count === 1,
      json({ after: after2, followup: s2.followup }),
    );
    await runner.runJobsOnce(Date.now() + 2 * H);
    check('记账、等提交期间被接手：不重排，之后也不会补发', !pushedTo(TK2).length);
    await retire(TK2);
  }

  // ---- 明确失败：退账、failed、失败计数加 1，按扫描器的节奏再排；到 MAX_PUSH_FAILURES 不再排 ----
  {
    const D = 'wecom:wmJobsD';
    silent(D, 'quote', 3 * H);
    await flush(D);
    behave.set(D, async () => false);
    const now0 = Date.now();
    script.push({ content: '出发日期定下来了吗？' });
    await runner.runJobsOnce(now0);
    await flush(D);
    const j1 = await jobsFor(D);
    const s = store.getSession(D) as Session & { followup?: { count?: number; stages?: string[]; failures?: number; pendingAt?: number } };
    check(
      '明确失败：任务 failed、退账、失败计数 1',
      j1.length === 2 &&
        j1[0]!.status === 'failed' &&
        j1[0]!.lastError === 'push_failed' &&
        !s.followup?.count &&
        !s.followup?.stages?.length &&
        s.followup?.failures === 1 &&
        s.followup.pendingAt === undefined,
      json({ j1, f: s.followup }),
    );
    check(
      '明确失败：同一个键再排一个，不早于现在 + 扫描间隔',
      j1[1]!.status === 'pending' && j1[1]!.key === `followup:${D}:quote` && j1[1]!.runAt >= now0 + followup.FOLLOWUP_RETRY_MS,
      json(j1[1]),
    );
    await runner.runJobsOnce(now0 + 60_000);
    check('明确失败：重试没到点不发', pushedTo(D).length === 1);
    script.push({ content: '出发日期定下来了吗？' }, { content: '出发日期定下来了吗？' });
    await runner.runJobsOnce(j1[1]!.runAt);
    await flush(D);
    const j2 = await jobsFor(D);
    await runner.runJobsOnce(j2.at(-1)!.runAt);
    await flush(D);
    const j3 = await jobsFor(D);
    await runner.runJobsOnce(now0 + 2 * H);
    check(
      '明确失败：到 MAX_PUSH_FAILURES（3 次）不再排，一共推 3 次',
      pushedTo(D).length === 3 &&
        j3.length === 3 &&
        j3.every((j) => j.status === 'failed') &&
        (store.getSession(D) as { followup?: { failures?: number } }).followup?.failures === 3,
      json({ n: pushedTo(D).length, j3 }),
    );
    behave.delete(D);
  }

  // ---- 推送抛异常（结果不明）：按已发处理，账不退，记 abandoned，不重试 ----
  {
    const E = 'wecom:wmJobsE';
    silent(E, 'quote', 3 * H);
    await flush(E);
    behave.set(E, async () => {
      throw new Error('ETIMEDOUT');
    });
    script.push({ content: '出发日期定下来了吗？' });
    await runner.runJobsOnce();
    await flush(E);
    const j = await jobsFor(E);
    const f = (store.getSession(E) as { followup?: { count?: number; pendingAt?: number } }).followup;
    await runner.runJobsOnce(Date.now() + 2 * H);
    check(
      '结果不明：任务 abandoned（push_unknown），账不退、pendingAt 留着，不再推',
      j.length === 1 &&
        j[0]!.status === 'abandoned' &&
        j[0]!.lastError === 'push_unknown' &&
        f?.count === 1 &&
        !!f.pendingAt &&
        pushedTo(E).length === 1,
      json({ j, f }),
    );
  }

  // ---- 拒绝识别：客户说「别发了」之后记 followupOptOut、取消排着的、不再排（验收 22） ----
  {
    const F = 'wecom:wmJobsF';
    script.push({ content: '云南这边有两条线，您更想看古城还是雪山？' });
    await handleMessage(F, '想去云南看看', 'wecom');
    await flush(F);
    const before = await jobsFor(F);
    script.push({ content: '好的，不打扰您了，有需要随时找我～' });
    await handleMessage(F, '别发了', 'wecom');
    await flush(F);
    const s = store.getSession(F)!;
    const j = await jobsFor(F);
    check('前提：「别发了」之前排着一个跟进', before.length === 1 && before[0]!.status === 'pending', json(before));
    check(
      '拒绝识别：记 followupOptOut（带原话）',
      s.followupOptOut?.quote === '别发了' && typeof s.followupOptOut.at === 'number',
      json(s.followupOptOut),
    );
    check('拒绝识别：排着的跟进取消，AI 回复之后不再排', j.length === 1 && j[0]!.status === 'cancelled', json(j));
    await runner.runJobsOnce(Date.now() + 2 * H);
    check('拒绝识别：之后不再跟进', !pushedTo(F).length && !followup.shouldFollowUp(s, Date.now() + 30 * 24 * H));
    // 反例：不算拒绝，照常排
    const F2 = 'wecom:wmJobsF2';
    script.push({ content: '好的～云南这两条您先看看，有想法随时说。' });
    await handleMessage(F2, '想去云南看看', 'wecom');
    script.push({ content: '没问题，您慢慢想～' });
    await handleMessage(F2, '先不用发方案了，我再想想', 'wecom');
    await flush(F2);
    const s2 = store.getSession(F2)!;
    check(
      '拒绝识别：「先不用发方案了，我再想想」不算，照常排跟进',
      !s2.followupOptOut && (await jobsFor(F2)).some((x) => x.status === 'pending'),
      json(s2.followupOptOut),
    );
    await retire(F, F2);
  }

  // ---- 夜间顺延：排程时落在夜里顺延到 9:00；执行时正赶上夜里也顺延，不发 ----
  {
    const G = 'wecom:wmJobsG';
    const y21 = new Date();
    y21.setDate(y21.getDate() - 1);
    y21.setHours(21, 0, 0, 0);
    silent(G, 'quote', 0, y21.getTime()); // 昨天 21:00 报价，+2 小时是 23:00
    await flush(G);
    const today9 = new Date().setHours(9, 0, 0, 0);
    const j1 = await jobsFor(G);
    check('夜间顺延：排程落在 23:00 → 顺延到今天 9:00', j1.length === 1 && j1[0]!.runAt === today9, json(j1));
    const tonight = new Date().setHours(23, 30, 0, 0);
    await runner.runJobsOnce(tonight);
    const j2 = await jobsFor(G);
    const tomorrow9 = new Date(today9);
    tomorrow9.setDate(tomorrow9.getDate() + 1);
    check(
      '夜间顺延：执行时是 23:30 → 改回 pending、顺延到次日 9:00，不算一次尝试、不发',
      j2.length === 1 &&
        j2[0]!.status === 'pending' &&
        j2[0]!.runAt === tomorrow9.getTime() &&
        j2[0]!.attempts === 0 &&
        !pushedTo(G).length,
      json(j2),
    );
    await retire(G);
  }

  // ---- 转人工通知：立即一个、10 分钟一个、企微窗口关闭前 4 小时一个，随转人工的落库提交（没配 NOTIFY_WEBHOOK_URL：到点只 warn、标 done） ----
  {
    const J = 'wecom:wmJobsJ';
    await handleMessage(J, '转人工', 'wecom'); // 确定性安全网，不调模型
    await flush(J);
    const s = store.getSession(J)!;
    const at = s.handoff?.at ?? 0;
    const closes = sendWindow(J, at).closesAt ?? 0;
    const n1 = await jobsFor(J, 'handoff_notify');
    check(
      '转人工通知：三个任务随转人工提交，runAt 是转人工时刻、+10 分钟与窗口关闭前 4 小时，payload 带 sessionId',
      s.handedOver &&
        closes > at &&
        n1.length === 3 &&
        n1.every((j) => j.status === 'pending' && j.max === 4 && j.payload.sessionId === J) &&
        json(n1.map((j) => j.runAt).toSorted()) === json([at, at + HANDOFF_UNCLAIMED_MS, closes - WINDOW_NOTICE_MS]),
      json(n1),
    );
    check('转人工：不排跟进', (await jobsFor(J)).length === 0);
    await runner.runJobsOnce();
    const n2 = await jobsFor(J, 'handoff_notify');
    check(
      '转人工通知：立即的那个到点标 done，10 分钟与窗口的还排着',
      n2.filter((j) => j.status === 'done').length === 1 && n2.filter((j) => j.status === 'pending').length === 2,
      json(n2),
    );
    await runner.runJobsOnce(at + HANDOFF_UNCLAIMED_MS + 1000);
    const n3 = await jobsFor(J, 'handoff_notify');
    check(
      '转人工通知：10 分钟的到点也标 done，窗口的还排着',
      n3.filter((j) => j.status === 'done').length === 2 && n3.find((j) => j.key.endsWith(':window'))?.status === 'pending',
      json(n3),
    );
    await retire(J);
  }

  // ---- 紧急情况（plan 第 11 步、验收 17）：未转人工时两个通知随这次转人工提交；已转人工时不回话、记录升级、再排一个立即的 ----
  {
    const E = 'wecom:wmJobsE1';
    const r1 = await handleMessage(E, '孩子走丢了', 'wecom'); // 紧急情况，不调模型
    await flush(E);
    const n1 = await jobsFor(E, 'handoff_notify');
    check(
      '紧急情况（db 存储）：应急话术，立即、10 分钟与窗口三个通知随这次转人工提交',
      r1.handoff === true &&
        store.getSession(E)!.handoff?.kind === 'emergency' &&
        n1.length === 3 &&
        n1.every((j) => j.payload.escalated === false),
      json(n1),
    );
    const U = 'wecom:wmJobsE2';
    await handleMessage(U, '转人工', 'wecom');
    await flush(U);
    const before = await jobsFor(U, 'handoff_notify');
    const r2 = await handleMessage(U, '我们被困在山上了', 'wecom');
    await flush(U);
    const s = store.getSession(U)!;
    const added = (await jobsFor(U, 'handoff_notify')).filter((j) => !before.some((b) => b.id === j.id));
    check(
      '已转人工时说紧急情况（db 存储）：不回话，记录升级为 emergency，再排一个立即的 handoff_notify（escalated）',
      r2.silent === true &&
        r2.text === '' &&
        s.handoff?.kind === 'emergency' &&
        before.length === 3 &&
        added.length === 1 &&
        added[0]!.payload.escalated === true &&
        added[0]!.runAt === s.handoff.at &&
        added[0]!.key.endsWith(':started'),
      json({ before, added }),
    );
    // 两个窗口随会话落库（conversations.state）：一句弱、一轮重复提问
    const W = 'wecom:wmJobsE3';
    script.push({ content: '西藏一般5到10月去～' }, { content: '5到10月都合适～' }, { content: '抱歉～我说得更具体些。' });
    await handleMessage(W, '西藏几月去合适', 'wecom');
    await handleMessage(W, '西藏几月去合适', 'wecom');
    await handleMessage(W, '你们回复太敷衍了', 'wecom');
    await flush(W);
    const [row] = await su<{ t: unknown; n: unknown }>(
      `select state->'turnSignals' as t, state->'negativeHits' as n from conversations where id = $1`,
      [W],
    );
    const asJson = (v: unknown) => (typeof v === 'string' ? v : json(v));
    check(
      '窗口随会话落库：turnSignals、negativeHits 在 conversations.state 里',
      !store.getSession(W)!.handedOver && asJson(row?.t) === '[1,0]' && asJson(row?.n) === '[1]',
      json(row),
    );
    await retire(E, U, W);
  }

  // ---- retention_purge：第一批之前排下一个 3:30；到点标 done、同一个事务排下一天的 ----
  {
    const next = nextPurgeAt(Date.now());
    const p1 = await jobsOf(`kind = 'retention_purge'`);
    check(
      '清理：排着下一个 3:30 的 retention_purge:<日期>',
      p1.length === 1 && p1[0]!.status === 'pending' && p1[0]!.runAt === next && p1[0]!.key === retentionPurgeSpec(Date.now()).dedupeKey,
      json(p1),
    );
    await runner.runJobsOnce(next + 1000);
    const p2 = await jobsOf(`kind = 'retention_purge'`);
    const dayAfter = nextPurgeAt(next + 1000);
    check(
      '清理：到点标 done，下一天的排上（只一个）',
      p2.length === 2 &&
        p2.find((j) => j.runAt === next)?.status === 'done' &&
        p2.filter((j) => j.status === 'pending').length === 1 &&
        p2.find((j) => j.status === 'pending')?.runAt === dayAfter,
      json(p2),
    );
  }

  // ---- 停机 normal 段：生成话术途中 → 改回 pending、不推；已进 sending 的不动，等推送回来 ----
  {
    const I = 'wecom:wmJobsI';
    silent(I, 'quote', 3 * H);
    await flush(I);
    script.push({ hang: true });
    const tick = runner.runJobsOnce();
    const composing = await waitFor(() => runner.__jobsTest.mine().some((m) => m.phase === 'started'));
    // 生成话术（模型可能要几十秒）途中停机：立即放弃这次生成，不占停机宽限期（F1 的口径）
    const t0 = Date.now();
    let stopped0 = false;
    const stop0 = runner.__jobsTest.stop().then(() => (stopped0 = true));
    await Promise.race([stop0, sleep(2000)]);
    check('停机：生成话术途中停机立即结束，不等模型', stopped0 && Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
    await releaseHung();
    await stop0;
    await tick;
    const j = await jobsFor(I);
    check(
      '停机：生成话术途中的跟进改回 pending、不推送',
      composing && j.length === 1 && j[0]!.status === 'pending' && !pushedTo(I).length,
      json(j),
    );
    runner.__jobsTest.reset();

    const I2 = 'wecom:wmJobsI2';
    silent(I2, 'quote', 3 * H);
    await flush(I2);
    let release!: (ok: boolean) => void;
    behave.set(I2, () => new Promise<boolean>((r) => (release = r)));
    script.push({ content: '出发日期定下来了吗？' });
    // I 的任务（已改回 pending）也到点了：同一批认领，先推它
    script.unshift({ content: '出发日期定下来了吗？' });
    const tick2 = runner.runJobsOnce();
    await waitFor(() => pushedTo(I2).length === 1);
    let stopped = false;
    const stopping = runner.__jobsTest.stop().then(() => (stopped = true));
    await sleep(50);
    const mid = await jobsFor(I2);
    check('停机：已进 sending 的跟进不改回 pending，停机等它推完', !stopped && mid[0]?.status === 'sending', json(mid));
    release(true);
    await stopping;
    await tick2;
    await flush(I2);
    check('停机：推送回来之后照常记 done', (await jobsFor(I2))[0]?.status === 'done');
    runner.__jobsTest.reset();
    await retire(I, I2);
  }

  // ---- 启动时各类 running / sending 的去向（「下一次启动」= reset 之后的第一批之前） ----
  {
    const [{ id: tenant }] = await su<{ id: string }>(`select id from tenants where slug = 'demo'`);
    const later = new Date(Date.now() + 48 * H).toISOString();
    const ins = (kind: string, key: string, status: string, attempts: number, max: number, payload: unknown) =>
      su<{ id: string }>(
        `insert into jobs (tenant_id, kind, dedupe_key, run_at, status, attempts, max_attempts, payload, claimed_at)
         values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8::json, now()) returning id`,
        [tenant, kind, key, later, status, attempts, max, JSON.stringify(payload)],
      );
    await ins('followup', 'followup:wecom:wmJobsH1:quote', 'running', 0, 3, { sessionId: 'wecom:wmJobsH1', stage: 'quote' });
    await ins('followup', 'followup:wecom:wmJobsH2:quote', 'sending', 0, 3, { sessionId: 'wecom:wmJobsH2', stage: 'quote' });
    await ins('handoff_notify', 'handoff_notify:wecom:wmJobsH3:1:started', 'running', 0, 4, { sessionId: 'wecom:wmJobsH3' });
    await ins('handoff_notify', 'handoff_notify:wecom:wmJobsH4:1:started', 'running', 3, 4, { sessionId: 'wecom:wmJobsH4' });
    await ins('retention_purge', 'retention_purge:2000-01-01', 'running', 2, 3, { day: '2000-01-01' });
    runner.__jobsTest.reset();
    await runner.runJobsOnce();
    const got = Object.fromEntries(
      (await jobsOf(`dedupe_key like '%wmJobsH%' or dedupe_key = 'retention_purge:2000-01-01'`)).map((j) => [j.key, j]),
    );
    const g = (k: string) => got[k];
    check(
      '启动：running 的跟进改回 pending（attempts 不变）',
      g('followup:wecom:wmJobsH1:quote')?.status === 'pending' && g('followup:wecom:wmJobsH1:quote')?.attempts === 0,
      json(got),
    );
    check(
      '启动：sending 的跟进记 abandoned、不重发',
      g('followup:wecom:wmJobsH2:quote')?.status === 'abandoned' && g('followup:wecom:wmJobsH2:quote')?.lastError === 'restart_in_sending',
    );
    check(
      '启动：其余种类的 running 改回 pending、attempts 加 1',
      g('handoff_notify:wecom:wmJobsH3:1:started')?.status === 'pending' && g('handoff_notify:wecom:wmJobsH3:1:started')?.attempts === 1,
    );
    check(
      '启动：其余种类加 1 之后到 max_attempts 记 failed',
      g('handoff_notify:wecom:wmJobsH4:1:started')?.status === 'failed' &&
        g('handoff_notify:wecom:wmJobsH4:1:started')?.attempts === 4 &&
        g('retention_purge:2000-01-01')?.status === 'failed' &&
        g('retention_purge:2000-01-01')?.attempts === 3,
      json(got),
    );
  }

  // ---- 执行体出错（推送之前）：按 max_attempts 重试，到上限记 failed ----
  {
    const K = 'wecom:wmJobsK';
    silent(K, 'quote', 3 * H);
    await flush(K);
    const s = store.getSession(K)!;
    // 生成话术时抛（推送之前、记账之前）：生成要读画像，让这一读抛；排程与资格判断不读画像。认领这一批里不落这个会话的库
    const profile = s.profile;
    Object.defineProperty(s, 'profile', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    await runner.runJobsOnce();
    Object.defineProperty(s, 'profile', { value: profile, writable: true, enumerable: true, configurable: true });
    const j = await jobsFor(K);
    check(
      '执行出错：改回 pending、attempts 加 1、按退避推后，不推送',
      j.length === 1 &&
        j[0]!.status === 'pending' &&
        j[0]!.attempts === 1 &&
        j[0]!.runAt > Date.now() &&
        j[0]!.lastError === 'Error' &&
        !pushedTo(K).length,
      json(j),
    );
    await retire(K);
  }

  // ---- 执行体出错到 max_attempts：只留一条 failed，不再同键重排，之后拨钟几天也不再调模型（审查之后改的第 3 条） ----
  {
    const K2 = 'wecom:wmJobsK2';
    silent(K2, 'quote', 3 * H);
    await flush(K2);
    // 生成之后（模型已经调过）、记账之前抛：记账之前那次额度判断抛错（生成之前那次放行）。只对这个会话
    let phase = 0;
    let thrown = 0;
    followupJobs.setQuotaForTest((x) => {
      if (x.id !== K2) return true;
      phase ^= 1;
      if (phase === 1) return true;
      thrown += 1;
      throw new Error('boom');
    });
    const t0 = Date.now();
    const m0 = calls();
    await runner.runJobsOnce(t0);
    const a1 = await jobsFor(K2);
    await runner.runJobsOnce(a1[0]!.runAt);
    const a2 = await jobsFor(K2);
    await runner.runJobsOnce(a2[0]!.runAt);
    await flush(K2);
    const a3 = await jobsFor(K2);
    check(
      '重试用完：第三次出错记 failed（attempts 3），只此一条、没有同键新排的 pending',
      thrown === 3 && a3.length === 1 && a3[0]!.status === 'failed' && a3[0]!.attempts === 3 && a3[0]!.lastError === 'Error',
      json({ thrown, a1, a2, a3 }),
    );
    const m1 = calls();
    for (let d = 1; d <= 3; d++) {
      await runner.runJobsOnce(t0 + d * 24 * H);
      await flush(K2);
    }
    const a4 = await jobsFor(K2);
    check(
      '重试用完：之后拨钟三天不再认领、不再调模型（max_attempts 封顶得住）',
      m1 - m0 === 3 && calls() === m1 && thrown === 3 && a4.length === 1 && !pushedTo(K2).length,
      json({ calls: [m0, m1, calls()], thrown, a4 }),
    );
    followupJobs.setQuotaForTest(null);
    await retire(K2);
  }

  // ---- 额度不够：生成之前就判，不调模型；记 cancelled，之后不再排（第 4 条，第 12 步换掉桩之后照样成立） ----
  {
    const Q = 'wecom:wmJobsQ';
    silent(Q, 'quote', 3 * H);
    await flush(Q);
    followupJobs.setQuotaForTest((x) => x.id !== Q);
    const m0 = calls();
    const t0 = Date.now();
    for (let k = 0; k < 6; k++) {
      await runner.runJobsOnce(t0 + k * 5000);
      await flush(Q);
    }
    await runner.runJobsOnce(t0 + 24 * H);
    await flush(Q);
    const j = await jobsFor(Q);
    check(
      '额度不够：拨钟七拍，模型调用 0 次；只有一条 cancelled（quota），没有反复出现的新任务，不推送',
      calls() === m0 && j.length === 1 && j[0]!.status === 'cancelled' && j[0]!.lastError === 'quota' && !pushedTo(Q).length,
      json({ calls: calls() - m0, j }),
    );
    followupJobs.setQuotaForTest(null);
    await retire(Q);
  }

  // ---- 租户锁不在本进程手里（锁连接断开、正在重取）：不认领、不执行；重新取到之后照常（第 5 条） ----
  {
    const P = 'wecom:wmJobsP';
    silent(P, 'quote', 3 * H);
    await flush(P);
    __configTest.setTimings({ reacquireMs: 30 });
    lock.next = 'unreachable';
    lock.lose();
    const lost = configHealth().lock === 'lost';
    const n = await runner.runJobsOnce();
    const j1 = await jobsFor(P);
    check(
      '锁丢失：认领 0 条，到点的跟进仍是 pending、不推送',
      lost && n === 0 && j1.length === 1 && j1[0]!.status === 'pending' && !pushedTo(P).length,
      json({ lost, n, j1 }),
    );
    lock.next = 'ok';
    const back = await waitFor(() => configHealth().lock === 'held', 3000);
    script.push({ content: '出发日期定下来了吗？' });
    await runner.runJobsOnce();
    await flush(P);
    check(
      '锁重新取到：照常认领、发出',
      back && pushedTo(P).length === 1 && (await jobsFor(P))[0]?.status === 'done',
      json({ back, n: pushedTo(P).length }),
    );
    __configTest.setTimings({ reacquireMs: 5000 });
    await retire(P);
  }

  // ---- 认领者写结果的短事务失败：进待补队列，下一拍补上；之后同一会话照常能排新的跟进（第 6 条） ----
  {
    const N2 = 'wecom:wmJobsN2';
    silent(N2, 'quote', 3 * H);
    await flush(N2);
    script.push({ hang: true });
    const tick = runner.runJobsOnce();
    await waitFor(() => runner.__jobsTest.mine().some((m) => m.phase === 'started'));
    const s = store.getSession(N2)!;
    s.messages.push({ role: 'customer', content: '我再看看', at: Date.now() });
    store.saveSession(s);
    s.messages.push({ role: 'agent', content: '好的，您慢慢看，有想法随时说～', at: Date.now() });
    store.saveSession(s);
    await flush(N2);
    // 生成回来之后重判取消（changed）；认领者写这个结果时借连接失败（这段时间里别的借连接一样失败，之后照常重试）
    fx.faults.acquire = fakeDbError('08006');
    await releaseHung();
    await tick;
    fx.faults.acquire = null;
    const j1 = await jobsFor(N2);
    check(
      '结果没写进库：任务还在 running，进了待补队列',
      j1.length === 1 && j1[0]!.status === 'running' && json(runner.__jobsTest.unsettled()) === json([j1[0]!.id]),
      json({ j1, unsettled: runner.__jobsTest.unsettled() }),
    );
    await runner.runJobsOnce();
    await flush(N2);
    const j2 = await jobsFor(N2);
    check(
      '下一拍补写：记 cancelled（changed），同一个键按 AI 那句回复照常排出新的跟进',
      j2.length === 2 &&
        j2[0]!.status === 'cancelled' &&
        j2[0]!.lastError === 'changed' &&
        j2[1]!.status === 'pending' &&
        j2[1]!.key === `followup:${N2}:quote` &&
        j2[1]!.runAt === followupRunAt(store.getSession(N2)!, 120 * 60_000) &&
        !runner.__jobsTest.unsettled().length,
      json(j2),
    );
    await retire(N2);
  }

  // ---- 重置：待执行的 handoff_notify 一并取消（spec「消息只追加」重置那一行；第 9 条） ----
  {
    const R = 'wecom:wmJobsReset';
    await handleMessage(R, '转人工', 'wecom');
    await flush(R);
    const n1 = await jobsFor(R, 'handoff_notify');
    await handleMessage(R, '重置', 'wecom');
    await flush(R);
    const n2 = await jobsFor(R, 'handoff_notify');
    check(
      '重置：转人工之后重置，这个会话的 handoff_notify 都是 cancelled',
      n1.length === 3 &&
        n1.every((j) => j.status === 'pending') &&
        n2.length === 3 &&
        n2.every((j) => j.status === 'cancelled' && j.finished),
      json({ n1, n2 }),
    );
  }

  // ---- db 存储下扫描器不动（跟进只由任务表驱动）；文件存储也认 followupOptOut ----
  {
    const L = 'wecom:wmJobsL';
    silent(L, 'quote', 3 * H);
    await flush(L);
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    let scanned = 0;
    const n = await followup.runFollowUpScan(async () => {
      scanned += 1;
      return true;
    }, noon);
    check('db 存储下扫描器什么都不做', n === 0 && scanned === 0);
    const s = store.getSession(L)!;
    check('前提：这个会话现在该跟进', followup.shouldFollowUp(s, Date.now()));
    const optedOut = { ...s, followupOptOut: { at: Date.now(), quote: '别发了' } } as Session;
    check('两种存储共用的资格判断：有 followupOptOut 就不跟进', !followup.shouldFollowUp(optedOut, Date.now()));
    await retire(L);
  }

  // ---- advisor 模式建单排一次「待确认的订单」提醒；确认价格之后到点不发（02 spec「收款流程」，第 15 步审查带出） ----
  {
    const { executeTool, loadRoutes } = await import('../tools.js');
    const { confirmOrder } = await import('../payment/orders.js');
    const { __profileTest } = await import('../profile.js');
    const route = loadRoutes().find((r) => r.itinerary?.length)!;
    const O = 'wecom:wmJobsOU1';
    const s = store.getOrCreateSession(O, 'wecom');
    const departDate = new Date(Date.now() + 200 * 24 * 3_600_000).toISOString().slice(0, 10);
    __profileTest.use({ DEPLOY_PROFILE: 'demo', FLAG_MOCK_PAY: 'off' });
    try {
      await executeTool('create_order', { routeId: route.id, travelers: 2, departDate }, s);
      await flush(O);
      const orderId = store.getSession(O)!.orderIds[0]!;
      const before = await jobsFor(O, 'handoff_notify');
      check(
        'advisor 建单：排了一条 order_unconfirmed 的 handoff_notify，还没到点就待在 pending',
        before.length === 1 && before[0]!.payload.reason === 'order_unconfirmed' && before[0]!.payload.orderId === orderId,
        json(before),
      );
      confirmOrder(orderId, { userId: null, name: '测试', role: 'owner' });
      await flush(O);
      await runner.runJobsOnce(before[0]!.runAt);
      const after = await jobsFor(O, 'handoff_notify');
      check(
        '确认价格之后到点执行：done、lastError=order_settled（没有真的去发通知）',
        after.length === 1 && after[0]!.status === 'done' && after[0]!.lastError === 'order_settled',
        json(after),
      );
    } finally {
      __profileTest.reset();
    }
    await retire(O);
  }
}

// ---------------- 文件存储：经 mock 引擎的拒绝识别与扫描器 ----------------

async function childFile(): Promise<void> {
  process.env.LLM_MOCK = '1'; // mock 引擎按关键词驱动真实工具：报价、建单
  const store = await import('../store.js');
  const { handleMessage } = await import('../engine.js');
  const followup = await import('../followup.js');
  const ID = 'wecom:wmJobsFileClose';
  const d = new Date(Date.now() + 40 * 24 * 3_600_000);
  await handleMessage(ID, `想去四川，2个大人，${d.getMonth() + 1}月${d.getDate()}号出发，预算每人一万`, 'wecom');
  const q = store.getSession(ID)!;
  check('文件存储：前提是先报了价', store.sessionStoreMode() === 'file' && q.stage === 'quote', q.stage);
  await handleMessage(ID, '不用了，就订这个', 'wecom');
  const s = store.getSession(ID) as Session & { followup?: { stages?: string[] } };
  check(
    '文件存储：「不用了，就订这个」照常建单、进 closing，不记 followupOptOut（审查之后改的第 1 条）',
    s.stage === 'closing' && s.orderIds.length === 1 && !s.followupOptOut,
    json({ stage: s.stage, orders: s.orderIds.length, optOut: s.followupOptOut }),
  );
  s.updatedAt = Date.now() - 3 * 3_600_000 - 60_000; // 沉默到 closing 的阈值（3 小时）之后
  store.saveSession(s, false);
  const pushed: { id: string; text: string }[] = [];
  const n = await followup.runFollowUpScan(async (id, text) => {
    pushed.push({ id, text });
    return true;
  }, new Date());
  check(
    '文件存储：沉默到阈值之后扫描器照常发出 closing 的催付跟进',
    n === 1 && pushed.length === 1 && pushed[0]!.id === ID && json(s.followup?.stages) === json(['closing']),
    json({ n, pushed, f: s.followup }),
  );
}

// ---------------- 落盘的 PGlite：sending 前后崩溃 ----------------

async function childDisk(mode: string, script: Step[], res: ChildResult, save: () => void): Promise<void> {
  const { store, su, jobsFor, flush, silent } = await storeSetup({ dataDir: process.env.JOBS_DATA_DIR!, dbConfig: false });
  const runner = await import('./runner.js');
  const followup = await import('../followup.js');
  const { push, pushes, behave } = makePush();
  runner.__jobsTest.start(push);
  const H = 3_600_000;
  const BEFORE = 'wecom:wmCrashBefore';
  const AFTER = 'wecom:wmCrashAfter';
  const kill = (): never => {
    save();
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  };

  if (mode === 'crash-before') {
    silent(BEFORE, 'quote', 3 * H);
    await flush(BEFORE);
    script.push({ hang: true }); // 生成话术卡住：任务已认领成 running，还没记账
    void runner.runJobsOnce();
    const running = await waitFor(async () => (await jobsFor(BEFORE))[0]?.status === 'running');
    check('sending 之前：任务已是 running、会话还没记账', running && !(store.getSession(BEFORE) as { followup?: unknown }).followup);
    kill();
  }
  if (mode === 'restart-before') {
    script.push({ content: '出发日期定下来了吗？' });
    await runner.runJobsOnce();
    await flush(BEFORE);
    const j = await jobsFor(BEFORE);
    const s = store.getSession(BEFORE) as Session & { followup?: { count?: number } };
    check(
      'sending 之前崩溃 → 重启：running 的跟进改回 pending、照常发一次，记 done',
      pushes.filter((p) => p.id === BEFORE).length === 1 && j.length === 1 && j[0]!.status === 'done' && s.followup?.count === 1,
      json({ j, pushes, f: s.followup }),
    );
    await runner.runJobsOnce(Date.now() + 24 * H);
    check('sending 之前崩溃 → 重启：之后不再发', pushes.filter((p) => p.id === BEFORE).length === 1);
  }
  if (mode === 'crash-after') {
    silent(AFTER, 'quote', 3 * H);
    await flush(AFTER);
    script.push({ content: '出发日期定下来了吗？' });
    behave.set(AFTER, async () => {
      // 推送途中被杀：记账与 sending 已提交（推送之前等过），客户可能已经收到
      const [j] = await jobsFor(AFTER);
      const [row] = await su<{ f: { count?: number; pendingAt?: number } | null }>(
        `select state->'followup' as f from conversations where id = $1`,
        [AFTER],
      );
      check(
        'sending 之后：推送那一刻任务是 sending、库里已记账',
        j?.status === 'sending' && row?.f?.count === 1 && !!row.f.pendingAt,
        json({ j, f: row?.f }),
      );
      res.data.pushedAt = Date.now();
      return kill();
    });
    await runner.runJobsOnce();
    check('sending 之后：推送桩被调到', false, '推送桩没被调到（进程应该在推送途中被杀）');
  }
  if (mode === 'restart-after') {
    await runner.runJobsOnce();
    await runner.runJobsOnce(Date.now() + 24 * H);
    const j = await jobsFor(AFTER);
    const s = store.getSession(AFTER) as Session & { followup?: { count?: number; pendingAt?: number } };
    check(
      'sending 之后崩溃 → 重启：任务记 abandoned、不重发（验收 22、不变量 38）',
      !pushes.length && j.length === 1 && j[0]!.status === 'abandoned' && j[0]!.lastError === 'restart_in_sending',
      json({ j, pushes }),
    );
    check(
      'sending 之后崩溃 → 重启：账还在（count、pendingAt），这个阶段不会再追',
      s.followup?.count === 1 && !!s.followup.pendingAt && !followup.shouldFollowUp(s, Date.now() + 30 * 24 * H),
      json(s.followup),
    );
    check('sending 之前崩溃的那个仍只发过一次（done）', (await jobsFor(BEFORE))[0]?.status === 'done');
  }
}

// ---------------- 真实 Postgres：两个认领者 ----------------

async function childRealPg(script: Step[], releaseHung: (content?: string) => Promise<void>): Promise<void> {
  const { createRealPgFixture } = await import('../db/testing.js');
  const { openDb, withTenant } = await import('../db/client.js');
  const { claimDueJobs } = await import('../db/repo/jobs.js');
  const fx = await createRealPgFixture(process.env.PG_TEST_URL!);
  const app = await openDb(fx.urls.app);
  const other = await openDb(fx.urls.app);
  try {
    const store = await import('../store.js');
    await store.initSessionStore({ db: app.db, tenantId: fx.tenantId, tenantSlug: 'demo', varDir: process.env.VAR_DIR! });
    const runner = await import('./runner.js');
    const { push, pushes } = makePush();
    runner.__jobsTest.start(push);
    await runner.runJobsOnce(); // 启动归位与清理的排程先做掉，之后的 running 都是这两个认领者的
    const ctx = { tenantId: fx.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    for (let i = 0; i < 12; i++) {
      await fx.query(
        `insert into jobs (tenant_id, kind, dedupe_key, run_at, max_attempts, payload) values ($1, 'handoff_notify', $2, $3::timestamptz, 4, '{}')`,
        [fx.tenantId, `race:${i}`, new Date(Date.now() - (100 - i) * 1000).toISOString()],
      );
    }
    // 另一个认领者：拿 5 个，事务不提交
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    let ready = (_ids: string[]): void => {};
    const got = new Promise<string[]>((r) => (ready = r));
    const holder = withTenant(other.db, ctx, async (tx) => {
      const ids = (await claimDueJobs(tx, new Date(), 5)).map((j) => j.id);
      ready(ids);
      await gate;
      return ids;
    });
    const held = await got;
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const n = await Promise.race([runner.runJobsOnce(), new Promise<'blocked'>((r) => (timer = setTimeout(() => r('blocked'), 3000)))]);
    clearTimeout(timer);
    const took = Date.now() - t0;
    release();
    await holder;
    const rows = await fx.query<{ id: string; status: string }>(`select id, status from jobs where dedupe_key like 'race:%'`);
    const done = rows.filter((r) => r.status === 'done').map((r) => r.id);
    const running = rows.filter((r) => r.status === 'running').map((r) => r.id);
    check('真实 PG：另一个认领者拿着 5 个不提交，runner 不等它的行锁', n !== 'blocked' && took < 3000, `${String(n)} ${took}ms`);
    check(
      '真实 PG：runner 拿到其余 7 个并做完，两边不相交，被拿着的 5 个仍是 running',
      n === 7 &&
        done.length === 7 &&
        held.length === 5 &&
        running.length === 5 &&
        held.every((id) => running.includes(id)) &&
        !done.some((id) => held.includes(id)),
      json({ n, done: done.length, running: running.length }),
    );

    // ---- 认领令牌（审查之后改的第 5 条）：租户锁丢失期间起来的第二个进程把正在生成话术的那一行归位、认领成自己的，
    //      原认领者的 running → sending 改不中（claimed_at 已不是它写的），落库照常提交，但不推送 ----
    {
      const R = 'wecom:wmJobsRpgToken';
      const s = store.getOrCreateSession(R, 'wecom') as Session & { followup?: { count?: number } };
      const at = Date.now() - 3 * 3_600_000;
      s.stage = 'quote';
      s.messages.push(
        { role: 'customer', content: '这条线多少钱', at: at - 60_000 },
        { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at },
      );
      s.createdAt = Math.min(s.createdAt, at - 60_000);
      s.updatedAt = at;
      store.saveSession(s, false);
      await store.flushSession(R, { timeoutMs: 5000 });
      script.push({ hang: true });
      const tick = runner.runJobsOnce();
      await waitFor(() => runner.__jobsTest.mine().some((m) => m.phase === 'started'));
      const [mine] = await fx.query<{ id: string }>(`select id from jobs where dedupe_key = $1 and status = 'running'`, [
        `followup:${R}:quote`,
      ]);
      await fx.query(`update jobs set status = 'pending', claimed_at = null where id = $1`, [mine?.id]);
      const theirs = (await withTenant(other.db, ctx, (tx) => claimDueJobs(tx, new Date(Date.now() + 1000), 10))).find(
        (j) => j.id === mine?.id,
      );
      await releaseHung();
      await tick;
      await store.flushSession(R, { timeoutMs: 5000 });
      const [row] = await fx.query<{ status: string; claimed_at: Date | string }>(`select status, claimed_at from jobs where id = $1`, [
        mine?.id,
      ]);
      check(
        '真实 PG：另一个认领者归位、重新认领之后，原认领者不推送；那一行仍是对方认领的 running',
        !!mine &&
          !!theirs?.claimedAt &&
          !pushes.some((p) => p.id === R) &&
          row?.status === 'running' &&
          new Date(row.claimed_at).getTime() === theirs.claimedAt.getTime(),
        json({ mine, theirs: theirs?.claimedAt, row, pushes: pushes.length }),
      );
      check('真实 PG：没推送的那次，已提交的账不退（多记一次是安全的一侧）', s.followup?.count === 1, json(s.followup));
      await fx.query(`update jobs set status = 'cancelled', finished_at = now() where id = $1`, [mine?.id]);
    }
  } finally {
    await other.close().catch(() => {});
    await app.close().catch(() => {});
    await fx.drop();
  }
}
