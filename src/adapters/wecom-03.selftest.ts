// 03 第 7 步：按账号拆开的企微运行时与回调路由（docs/architecture/03-channels-v2/spec.md R10、R11、R12、R20，不变量 13、18、19、20、22，
// 验收 10、12）。锁定的 wecom.selftest.ts 与 02 的 wecom-02、quota 自测守 env 账号的老路；这里只测企微状态在库里时的多账号。
// 本文件带上 WECOM03_CHILD 再起几次自己（单进程 node --import tsx，超时 SIGKILL，不留孤儿）。每个子进程驱动真正的渠道装载
// （initChannels、startChannels）、企微适配器与 server.ts 的回调路由；假企微服务端是进程内的假 fetch，按 corp + secret 发 token、
// 按 open_kfid 记日志与 cursor，每次请求记下 token 属于哪个账号、open_kfid 属于哪个账号。引擎走离线脚本（LLM_MOCK=1）。
//   main（PGlite，落盘的库）：两个假企业、三个启用的客服账号（第一个企业两个），外加一个停用的企微账号与一个网页账号。
//         同一个 external_userid 在三个账号上交错各发 5 句：三段会话、id 是 wecom: 与 wecom:<key>:，每个分段的 open_kfid 与 token
//         都是会话所属账号的，三个 cursor 各自推进进 channel_accounts，不写 wecom-cursor.json、不读 WECOM_*；channel_account_id 的
//         投影；一个账号 gettoken 一直失败时另两个照常收发、它的 token 告警带账号 key；停用账号的会话推送返回 false、没有运行时；
//         回调：各自的 Token 验签（别的账号签的不拉）、按 OpenKfId 分派（不同企业的不认）、receiveid 为空或不等于 corp_id 不拉、
//         不存在 / 网页 / 停用 / env 的 key GET 404、POST 回 success 记一行；人工回复经 accountForSession 走会话所属的账号。
//   restart（同一个库，新进程）：预载读回 channelAccountId（以 channel_account_id 列为准），cursor 接着库里的往下拉、不冷启动、
//         旧消息不再处理。
//   prod（prod profile、LOG_FORMAT=json）：非默认账号跑一轮（回调、回复、人工回复、停用账号的推送），父进程扫标准输出：
//         没有 external_userid，也没有会话原 id 与它的 %3A 编码形式（不变量 22）。
//   rpg（PG_TEST_URL 设了才跑）：真实 Postgres 上以 agent_app 写 cursor 与 channel_account_id，按预载的读法重建以列为准。
//   out / rout：第 8 步的出站先落库、后发送（见 outboundSuite）。
//   in / rin（03 第 9 步）：入站 channel_inbox 与状态机（见 inboxSuite）：一页的提交与回滚、ord、事务边界（测试触发器记 txid）、
//         状态机每一格、出队计次、poison、too_old、冷启动、恢复截止点只补记、四种入站。rin 在真实 PG 上跑同一套。
// 用法：npx tsx src/adapters/wecom-03.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '../types.js';

const CHILD = process.env.WECOM03_CHILD ?? '';
const SELF = fileURLToPath(import.meta.url);

let pass = 0;
const fails: string[] = [];
/** 子进程的日志缓冲（prod 子进程不收）：有失败再倒出来，也用来数「记了一行」 */
const logBuf: string[] = [];
/** 从 from 起新记的日志行 */
const logsSince = (from: number): string[] => logBuf.slice(from);
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const json = (v: unknown): string => JSON.stringify(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(10);
  }
  return cond();
}

// ---------------- 账号（两家假企业；假 id 不用 ww、wk 开头，external_userid 是 wm 加至多 13 个字符） ----------------

interface AcctDef {
  key: string;
  corp: string;
  kf: string;
  prefix: string;
  status: 'active' | 'disabled';
  seed: number;
}
const ACCTS: AcctDef[] = [
  { key: 'a1', corp: 'corp03a', kf: 'kf03a1', prefix: 'wecom:', status: 'active', seed: 11 },
  { key: 'a2', corp: 'corp03a', kf: 'kf03a2', prefix: 'wecom:a2:', status: 'active', seed: 12 },
  { key: 'b1', corp: 'corp03b', kf: 'kf03b1', prefix: 'wecom:b1:', status: 'active', seed: 13 },
  { key: 'd1', corp: 'corp03a', kf: 'kf03d1', prefix: 'wecom:d1:', status: 'disabled', seed: 14 },
];
const acct = (key: string): AcctDef => ACCTS.find((a) => a.key === key)!;
/** 每个账号自己的一套凭据（回调的 EncodingAESKey 是 43 位 base64，运行时现算，不写成字面量） */
const secretsOf = (a: AcctDef): { appSecret: string; callbackToken: string; callbackAesKey: string } => ({
  appSecret: `s03-${a.key}-app`,
  callbackToken: `s03-${a.key}-cb`,
  callbackAesKey: Buffer.alloc(32, a.seed).toString('base64').slice(0, 43),
});
const UID = 'wm03same';
const ENV_ACCT: AcctDef = { key: 'env', corp: 'corp03env', kf: 'kf03env', prefix: 'wecom:', status: 'active', seed: 9 };
const CUSTOM_WELCOME = '您好，我是 AI 咨询助手。需要人工服务请回复「人工」。';
const CUSTOM_BACK = '欢迎回来，我是 AI 咨询助手。需要人工服务请回复「人工」。';
// 开工提交 5b697c2 的字面量；文件配置没有已发布隐私说明，withPrivacyLink 原样返回。
const BASE_WELCOME =
  '您好呀～欢迎来到云途定制旅行，我是您的 AI 旅行顾问 🌿\n' +
  '想去哪玩直接跟我说，比如「想去西藏，两个人，预算每人3万」，我马上帮您推荐线路、报价，还能在线下单～\n' +
  '川西藏地 / 云南雪山 / 新疆南北疆 / 贵州山水 / 西安北京人文，都能聊！需要真人服务时，回复「人工」即可转真人顾问。';
const BASE_BACK =
  '欢迎回来～我是云途定制旅行的 AI 旅行顾问。\n' +
  '想继续看线路、调整行程，或者换个方向看看，直接说就行～需要真人服务时，回复「人工」即可转真人顾问。';

if (CHILD) await childMain(CHILD);
else await parentMain();

// ======================================================================================
// 父进程
// ======================================================================================

async function parentMain(): Promise<never> {
  const varParent = process.env.VAR_DIR ?? os.tmpdir();
  fs.mkdirSync(varParent, { recursive: true });
  const ROOT = fs.mkdtempSync(path.join(varParent, 'wecom-03-selftest-'));
  process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

  // 出站的 PGlite 子进程预加载等价套件的钟，从当天本地 12:00 起走：跟进的夜间时段（22–9 点，本地时间）不受在几点、在哪个时区跑
  // 的影响（jobs、quota 自测的做法）；真实 PG 子进程用真钟（库的 now() 拨不动），改用 FOLLOWUP_QUIET_START/END=0 关掉夜间时段
  const NOON = new Date().setHours(12, 0, 0, 0);
  const CLOCK_MODULE = fileURLToPath(new URL('../store/parity-clock.ts', import.meta.url));
  const runChild = (
    mode: string,
    env: Record<string, string>,
    clockMs: number | null = null,
  ): {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    result: { pass: number; fails: string[] } | null;
  } => {
    const resultFile = path.join(ROOT, `${mode}-${Date.now()}.json`);
    const args = ['--import', 'tsx', ...(clockMs === null ? [] : ['--import', CLOCK_MODULE]), SELF];
    const r = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WECOM03_CHILD: mode,
        WECOM03_RESULT: resultFile,
        CONFIG_SOURCE: 'file',
        ...(clockMs === null ? {} : { PARITY_CLOCK_MS: String(clockMs) }),
        ...env,
      },
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
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', result };
  };
  const merge = (label: string, r: ReturnType<typeof runChild>): void => {
    check(`${label}：子进程正常结束`, r.status === 0, `status=${r.status} signal=${r.signal} ${(r.stdout + r.stderr).slice(-2000)}`);
    if (!r.result) {
      fails.push(`${label}：子进程没留下结果 ${(r.stdout + r.stderr).slice(-2000)}`);
      return;
    }
    pass += r.result.pass;
    for (const f of r.result.fails) fails.push(`${label}：${f}`);
    if (r.result.fails.length) fails.push(`${label} 的日志：${(r.stdout + r.stderr).slice(-3000)}`);
  };

  {
    const env = { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'main-')), WECOM03_DATA_DIR: fs.mkdtempSync(path.join(ROOT, 'pgdata-')) };
    merge('PGlite 三个账号', runChild('main', env));
    merge('PGlite 重启', runChild('restart', env));
    merge('PGlite 停用与欢迎语重启', runChild('disabled', env));
  }
  {
    const r = runChild('prod', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'prod-')) });
    merge('prod 日志', r);
    const out = r.stdout + r.stderr;
    const lines = r.stdout.split('\n').filter((l) => l.trim());
    const notJson = lines.filter((l) => {
      try {
        const d = JSON.parse(l) as unknown;
        return !d || typeof d !== 'object';
      } catch {
        return true;
      }
    });
    check('prod、LOG_FORMAT=json：标准输出有日志、每行都是 JSON', lines.length > 5 && notJson.length === 0, json(notJson.slice(0, 3)));
    check(
      'prod、LOG_FORMAT=json：标准输出与标准错误里没有 external_userid 与会话原 id（含 %3A 编码）',
      !/wm03prod/i.test(out),
      (() => {
        const i = out.search(/wm03prod/i);
        return i < 0 ? '' : out.slice(Math.max(0, i - 200), i + 80);
      })(),
    );
    check(
      'prod、LOG_FORMAT=json：账号 key 照常出现（日志按账号可查），凭据不出现',
      out.includes('acct=a2') && !out.includes(secretsOf(acct('a2')).appSecret) && !out.includes(secretsOf(acct('a2')).callbackToken),
    );
  }
  merge('未导入 env 回调', runChild('env', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'env-')) }));
  // 03 第 8 步：出站先落库后发送（适配器的整条顺序）
  merge('出站 PGlite', runChild('out', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'out-')) }, NOON));
  // 03 第 9 步：入站 channel_inbox 与状态机（不跑跟进，不依赖钟点与时区，用真钟）
  merge('入站 PGlite', runChild('in', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'in-')) }));
  let realPg = false;
  if (process.env.PG_TEST_URL) {
    realPg = true;
    merge('真实 PG', runChild('rpg', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'rpg-')) }));
    merge(
      '出站 真实 PG',
      runChild('rout', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'rout-')), FOLLOWUP_QUIET_START: '0', FOLLOWUP_QUIET_END: '0' }),
    );
    merge('入站 真实 PG', runChild('rin', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'rin-')) }));
  } else if (process.env.CI === 'true') {
    fails.push('CI 下必须设 PG_TEST_URL：按账号的 cursor 与 channel_account_id 要以 agent_app 身份在真实 Postgres 上写一遍');
  }

  if (fails.length) {
    console.error(`WECOM-03 SELFTEST FAIL：${fails.length} 项（通过 ${pass} 项）`);
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log(
    `WECOM-03 SELFTEST PASS: ${pass} 项断言全通（三个账号交错收发、会话 id 按账号前缀、open_kfid 与 token 按账号、cursor 各自进库 / ` +
      `一个账号取不到 token 或停用不影响别的 / 回调按账号验签、OpenKfId 分派、receiveid 校验、不存在与网页与停用的 key / ` +
      `channel_account_id 的投影与预载 / 重启接着库里的 cursor / prod JSON 日志里没有 external_userid / ` +
      `出站先落库后发送：每段发请求之前已是 sending、各类出站的 pending 在它们那一次落库、接手与停机截止、R6、工作台 / ` +
      `入站：一页与 cursor 同一事务的提交与回滚、ord、recorded 与消息同一事务、replied 与 pending 同一事务、状态机每一格、出队计次、` +
      `poison、too_old、冷启动、恢复截止点只补记、四种入站${realPg ? ' / 真实 PG' : '；真实 PG 部分未跑'}）`,
  );
  process.exit(0);
}

// ======================================================================================
// 子进程
// ======================================================================================

interface FakeMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text?: { content: string; menu_id?: string };
  event?: { event_type: string; external_userid?: string; welcome_code?: string; fail_msgid?: string; fail_type?: number };
}
interface SendRec {
  /** access_token 是哪个账号的（null：不认识的 token） */
  tokenAcct: string | null;
  /** open_kfid 是哪个账号的 */
  kfAcct: string | null;
  to: string;
  msgid: string;
  content: string;
  msgtype?: string;
}
interface SyncRec {
  tokenAcct: string | null;
  kfAcct: string | null;
  cursor: string;
  /** 回调带来的 Token（兜底轮询为空） */
  token: string;
}

async function childMain(mode: string): Promise<never> {
  const save = (): void => fs.writeFileSync(process.env.WECOM03_RESULT!, JSON.stringify({ pass, fails }));
  const prod = mode === 'prod';
  // 日志：prod 子进程原样交给 pino（父进程扫标准输出）；其余收进缓冲
  const orig = { log: console.log, warn: console.warn, error: console.error };
  if (!prod) {
    for (const k of ['log', 'warn', 'error'] as const) {
      console[k] = (...args: unknown[]) => {
        logBuf.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : json(a))).join(' '));
        if (logBuf.length > 2000) logBuf.splice(0, logBuf.length - 2000);
      };
    }
  }
  try {
    const h = await harness(mode);
    if (mode === 'main') await mainSuite(h);
    else if (mode === 'restart') await restartSuite(h);
    else if (mode === 'disabled') await disabledSuite(h);
    else if (mode === 'env') await envSuite(h);
    else if (mode === 'prod') await prodSuite(h);
    else if (mode === 'rpg') await realPgSuite(h);
    else if (mode === 'out' || mode === 'rout') await outboundSuite(h);
    else if (mode === 'in' || mode === 'rin') await inboxSuite(h);
    else fails.push(`不认识的子进程 ${mode}`);
    await h.close();
  } catch (e) {
    fails.push(`子进程抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  Object.assign(console, orig);
  if (fails.length && !prod) for (const l of logBuf.slice(-120)) console.error(`  ${l}`);
  save();
  process.exit(0);
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(m: string) {
  const varDir = process.env.VAR_DIR!;
  Object.assign(process.env, {
    LLM_MOCK: '1',
    PUBLIC_BASE_URL: '',
    SERVER_SELFTEST: '1',
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'selftest-pass',
    FOLLOWUP_ENABLED: '',
    ALERT_WEBHOOK_URL: '',
    // 企微状态在库里时这几个一律不读（不变量 13）：配齐了也不该有一个请求带着它们出去
    WECOM_CORP_ID: 'corp03env',
    WECOM_APP_SECRET: 's03-env-app',
    WECOM_KF_OPEN_KFID: 'kf03env',
    WECOM_CALLBACK_TOKEN: 's03-env-cb',
    WECOM_CALLBACK_AES_KEY: Buffer.alloc(32, 9).toString('base64').slice(0, 43),
  });
  if (m === 'prod') {
    process.env.DEPLOY_PROFILE = 'prod';
    process.env.LOG_FORMAT = 'json';
    const { installJsonConsole } = await import('../log.js');
    installJsonConsole();
  }

  // ---- 假企微服务端 ----
  const fake = {
    logs: new Map<string, FakeMsg[]>(),
    tokens: new Map<string, string>(),
    sends: [] as SendRec[],
    events: [] as { tokenAcct: string | null; code: string; content: string }[],
    alerts: [] as string[],
    syncs: [] as SyncRec[],
    gettokens: [] as { corp: string; acct: string | null; ok: boolean }[],
    /** gettoken 一直失败的账号 */
    failToken: new Set<string>(),
    /** 用这个账号的 token 调接口一律回 42001（逼它重取 token） */
    expired: new Set<string>(),
    n: 0,
    /** 缩略图上传成功（默认失败：卡片退回纯文本） */
    mediaOk: false,
    /** send_msg 到了、回包之前（第 8 步：看这时库里这一段是什么状态、挂住回包） */
    beforeSend: null as ((body: Record<string, any>) => Promise<void>) | null,
    /** send_msg 的结果：network 当网络异常抛出；返回对象当回包；null 照常 accepted */
    sendResult: null as ((body: Record<string, any>) => 'network' | Record<string, unknown> | null) | null,
    /** 假模型（只在自测把 LLM_BASE_URL 指到 llm.selftest.invalid 时用到）：请求到了先调它，然后回 400 */
    onLlm: null as (() => void) | null,
  };
  const stateFile = path.join(varDir, 'fake-wecom-logs.json');
  if (['restart', 'disabled'].includes(m) && fs.existsSync(stateFile)) {
    for (const [kf, list] of JSON.parse(fs.readFileSync(stateFile, 'utf8')) as [string, FakeMsg[]][]) fake.logs.set(kf, list);
  }
  const res = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'alert03.selftest.invalid') {
      fake.alerts.push(String(JSON.parse(String(init?.body)).text.content));
      return res({ errcode: 0 });
    }

    if (url.hostname === 'llm.selftest.invalid') {
      fake.onLlm?.();
      return new Response(JSON.stringify({ error: { message: 'selftest: 假模型报错' } }), { status: 400 });
    }
    if (url.hostname !== 'qyapi.weixin.qq.com') return realFetch(input, init);
    const ep = url.pathname.replace(/^\/cgi-bin\//, '');
    if (ep === 'gettoken') {
      const corp = url.searchParams.get('corpid') ?? '';
      const a = [...ACCTS, ENV_ACCT].find(
        (x) => x.corp === corp && (x.key === 'env' ? 's03-env-app' : secretsOf(x).appSecret) === url.searchParams.get('corpsecret'),
      );
      const ok = !!a && !fake.failToken.has(a.key);
      fake.gettokens.push({ corp, acct: a?.key ?? null, ok });
      if (!ok) return res({ errcode: 40013, errmsg: 'selftest: invalid corpid' });
      const tok = `t03-${a.key}-${++fake.n}`;
      fake.tokens.set(tok, a.key);
      return res({ errcode: 0, access_token: tok, expires_in: 7200 });
    }
    const tokenAcct = fake.tokens.get(url.searchParams.get('access_token') ?? '') ?? null;
    if (tokenAcct && fake.expired.has(tokenAcct)) return res({ errcode: 42001, errmsg: 'selftest: token expired' });
    if (ep === 'media/upload') return res(fake.mediaOk ? { errcode: 0, media_id: 'media03' } : { errcode: 40004, errmsg: 'selftest' });
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, any>;
    const kfAcct = [...ACCTS, ENV_ACCT].find((x) => x.kf === body.open_kfid)?.key ?? null;
    if (ep === 'kf/sync_msg') {
      const kf = String(body.open_kfid);
      const cursor = String(body.cursor ?? '');
      fake.syncs.push({ tokenAcct, kfAcct, cursor, token: String(body.token ?? '') });
      const log = fake.logs.get(kf) ?? [];
      const [k, i] = cursor.split(':');
      const from = k === kf ? Number(i) || 0 : 0;
      const list = log.slice(from);
      return res({ errcode: 0, next_cursor: `${kf}:${from + list.length}`, has_more: 0, msg_list: list });
    }
    if (ep === 'kf/send_msg') {
      fake.sends.push({
        tokenAcct,
        kfAcct,
        to: String(body.touser),
        msgid: String(body.msgid ?? ''),
        content: String(body.text?.content ?? body.link?.url ?? body.msgmenu?.head_content ?? ''),
        msgtype: String(body.msgtype ?? ''),
      });
      if (fake.beforeSend) await fake.beforeSend(body);
      const r = fake.sendResult?.(body) ?? null;
      if (r === 'network') throw new TypeError('fetch failed');
      return res(r ?? { errcode: 0, msgid: body.msgid });
    }
    if (ep === 'kf/send_msg_on_event') {
      fake.events.push({ tokenAcct, code: String(body.code), content: String(body.text?.content ?? '') });
      return res({ errcode: 0 });
    }
    if (ep === 'kf/customer/batchget') return res({ errcode: 0, customer_list: [] });
    return res({ errcode: 40001, errmsg: `selftest: 未模拟的接口 ${ep}` });
  }) as typeof fetch;
  let seq = 0;
  const TAGS: Record<string, string> = {
    disabled: 'd',
    env: 'e',
    restart: 'r',
    prod: 'p',
    rpg: 'g',
    out: 'o',
    rout: 'q',
    in: 'i',
    rin: 'j',
  };
  const tag = TAGS[m] ?? 'm';
  /** 客户在这个客服账号上发了一句（进假企微的日志，等拉取） */
  const say = (kf: string, uid: string, content: string): FakeMsg => {
    const msg: FakeMsg = {
      msgid: `m03${tag}-${++seq}`,
      open_kfid: kf,
      external_userid: uid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content },
    };
    const list = fake.logs.get(kf) ?? [];
    list.push(msg);
    fake.logs.set(kf, list);
    return msg;
  };
  /** 进假企微日志的任意一条（事件、菜单点击、回执）；send_time 不给就是现在（秒） */
  const emit = (kf: string, partial: Omit<FakeMsg, 'msgid' | 'open_kfid' | 'send_time'> & { send_time?: number }): FakeMsg => {
    const msg: FakeMsg = { msgid: `m03${tag}-${++seq}`, open_kfid: kf, send_time: Math.floor(Date.now() / 1000), ...partial };
    const list = fake.logs.get(kf) ?? [];
    list.push(msg);
    fake.logs.set(kf, list);
    return msg;
  };

  // ---- 库、会话存储 ----
  const store = await import('../store.js');
  const { withTenant } = await import('../db/client.js');
  const testing = await import('../db/testing.js');
  let db: import('../db/client.js').Db;
  let tenantId: string;
  let su: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
  let closeDb: () => Promise<void>;
  /** 挡住写库（借连接）：gate 设了就先等它，acquire 设了就抛它（第 8 步的验收 5、7、20） */
  let faults: { gate: Promise<void> | null; acquire: Error | null } & Partial<{ releaseOnce: Error | null; skipReleases: number }>;
  const realPg = m === 'rpg' || m === 'rout' || m === 'rin';
  if (realPg) {
    const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!, { slug: 'wecom03' });
    const app = await testing.openGatedDb(fx.urls.app);
    db = app.db;
    faults = app.faults;
    tenantId = fx.tenantId;
    su = fx.query;
    await store.initSessionStore({ db, tenantId, tenantSlug: 'wecom03', varDir });
    closeDb = async () => {
      await app.close();
      await fx.drop();
    };
  } else {
    const t = await testing.openTestDb(['prod', 'out', 'in', 'env'].includes(m) ? {} : { dataDir: process.env.WECOM03_DATA_DIR! });
    const fx = await testing.installPgSessionStore(t, { varDir, slug: 'demo' });
    db = t.db;
    faults = fx.faults;
    tenantId = fx.deps.tenantId;
    su = <R>(text: string, params: unknown[] = []): Promise<R[]> =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<R>(text, params)).rows;
      });
    await store.initSessionStore(fx.deps);
    closeDb = () => t.close();
  }

  // ---- 渠道账号：id 先在这边生成（AAD 要用），凭据用这一把密钥加密 ----
  const { sealSecrets } = await import('../channels/secrets.js');
  const keyBytes = Buffer.alloc(32, 3);
  const keyRing = { current: { id: 'k03', key: keyBytes }, all: new Map([['k03', keyBytes]]) };
  const ids = new Map<string, string>();
  if (m === 'restart' || m === 'disabled') {
    for (const r of await su<{ id: string; key: string }>('select id, key from channel_accounts where tenant_id = $1', [tenantId])) {
      ids.set(r.key, r.id);
    }
  } else {
    for (const a of ACCTS) {
      if (m === 'env' || (m === 'prod' && a.key === 'b1')) continue;
      const id = randomUUID();
      ids.set(a.key, id);
      const { ct, keyId } = sealSecrets(keyRing, { tenantId, accountId: id }, secretsOf(a));
      await su(
        `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
         values ($1, $2, $3, 'wecom_kf', $3, $4, $5, $6, $7, decode($8, 'hex'), $9)`,
        [tenantId, id, a.key, a.status, a.prefix, a.corp, a.kf, ct.toString('hex'), keyId],
      );
    }
    const web = randomUUID();
    ids.set('w1', web);
    await su(`insert into channel_accounts (tenant_id, id, key, kind, name, settings) values ($1, $2, 'w1', 'web', 'w1', $3::json)`, [
      tenantId,
      web,
      JSON.stringify({ title: '网页咨询' }),
    ]);
  }
  if (m === 'in' || m === 'rin') {
    // 第 9 步：b1 启动时已经拉过（库里有 cursor，不是冷启动：过期的消息出队时才判 too_old）；a1、a2 是冷启动
    await su(`update channel_accounts set cursor = 'kf03b1:0' where tenant_id = $1 and key = 'b1'`, [tenantId]);
    for (const sql of inboxTestSql()) await su(sql);
  }

  const reg = await import('../channels/registry.js');
  const wecom = await import('./wecom.js');
  const { computeSignature } = await import('../wecom-crypto.js');
  const tokenErrors: [string, string][] = [];
  wecom.onTokenError((code, account) => void tokenErrors.push([code, account]));
  await reg.initChannels({ db, tenantId, tenantSlug: realPg ? 'wecom03' : 'demo', varDir, keyRing });
  reg.startChannels();
  const { app } = await import('../server.js');

  const idle = (): Promise<boolean> => waitFor(() => wecom.__wecomTest.idle(), 20_000);
  const sentTo = (uid: string, key?: string): SendRec[] => fake.sends.filter((s) => s.to === uid && (!key || s.kfAcct === key));

  // ---- 回调：按账号加密、签名（企微的方案：16 字节随机 | 4 字节长度 | 明文 | receiveid，AES-256-CBC，PKCS7 补到 32 字节） ----
  const encrypt = (a: AcctDef, plain: string, receiveId: string): string => {
    const key = Buffer.from(`${secretsOf(a).callbackAesKey}=`, 'base64');
    const msg = Buffer.from(plain, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(msg.length);
    const body = Buffer.concat([randomBytes(16), len, msg, Buffer.from(receiveId, 'utf8')]);
    const pad = 32 - (body.length % 32);
    const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    c.setAutoPadding(false);
    return Buffer.concat([c.update(Buffer.concat([body, Buffer.alloc(pad, pad)])), c.final()]).toString('base64');
  };
  let cbSeq = 0;
  /** 一次回调：route 是 key（null 为不带 key 的地址）；encFor 决定用谁的 AES 加密，signFor 用谁的 Token 签 */
  const callback = async (
    method: 'GET' | 'POST',
    route: string | null,
    o: { encFor: AcctDef; signFor?: AcctDef; receiveId?: string; openKfId?: string | null; echo?: string },
  ): Promise<{ status: number; text: string; token: string; logs: string[] }> => {
    const token = `cb03${tag}-${++cbSeq}`;
    const receiveId = o.receiveId ?? o.encFor.corp;
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = `n${cbSeq}`;
    const plain =
      method === 'GET'
        ? (o.echo ?? `echo-${cbSeq}`)
        : `<xml><ToUserName><![CDATA[${o.encFor.corp}]]></ToUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
          `<Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[${token}]]></Token>` +
          (o.openKfId === null ? '' : `<OpenKfId><![CDATA[${o.openKfId ?? o.encFor.kf}]]></OpenKfId>`) +
          '</xml>';
    const enc = encrypt(o.encFor, plain, receiveId);
    const sig = computeSignature(
      (o.signFor ?? o.encFor).key === 'env' ? 's03-env-cb' : secretsOf(o.signFor ?? o.encFor).callbackToken,
      ts,
      nonce,
      enc,
    );
    const base = route === null ? '/wecom/callback' : `/wecom/callback/${route}`;
    const from = logBuf.length;
    let r: Response;
    if (method === 'GET') {
      const q = new URLSearchParams({ msg_signature: sig, timestamp: ts, nonce, echostr: enc });
      r = await app.request(`${base}?${q}`);
    } else {
      const q = new URLSearchParams({ msg_signature: sig, timestamp: ts, nonce });
      const xml = `<xml><ToUserName><![CDATA[${o.encFor.corp}]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
      r = await app.request(`${base}?${q}`, {
        method: 'POST',
        headers: { 'content-length': String(Buffer.byteLength(xml)) },
        body: xml,
      });
    }
    return { status: r.status, text: await r.text(), token, logs: logsSince(from) };
  };
  /** 这个回调 Token 拉了哪些账号（sync_msg 的 open_kfid 所属）；等一会儿让异步的拉取落定 */
  const pulledBy = async (token: string): Promise<(string | null)[]> => {
    await sleep(80);
    await idle();
    return fake.syncs.filter((s) => s.token === token).map((s) => s.kfAcct);
  };
  const cursors = async (): Promise<Record<string, string | null>> =>
    Object.fromEntries(
      (await su<{ key: string; cursor: string | null }>('select key, cursor from channel_accounts where tenant_id = $1', [tenantId])).map(
        (r) => [r.key, r.cursor],
      ),
    );
  const projection = async (): Promise<Record<string, string | null>> =>
    Object.fromEntries(
      (
        await su<{ id: string; channel_account_id: string | null }>(
          'select id, channel_account_id from conversations where tenant_id = $1',
          [tenantId],
        )
      ).map((r) => [r.id, r.channel_account_id]),
    );

  return {
    mode: m,
    varDir,
    fake,
    say,
    emit,
    store,
    reg,
    wecom,
    app,
    db,
    tenantId,
    su,
    ids,
    idle,
    sentTo,
    callback,
    pulledBy,
    cursors,
    projection,
    tokenErrors,
    withTenant,
    faults,
    saveFakeLogs: (): void => fs.writeFileSync(stateFile, JSON.stringify([...fake.logs])),
    async close(): Promise<void> {
      await idle();
      await store.drainStore(5000);
      reg.__channelsTest.reset();
      await closeDb();
    },
  };
}

/** 一个账号的回调拉一次（直接调适配器的入口，跳过 HTTP） */
async function pull(h: Harness, key: string): Promise<void> {
  await h.wecom.syncAccountFromCallback(h.ids.get(key)!, `poll-${key}-${Date.now()}`);
  await h.idle();
}

// ======================================================================================
// main：三个账号交错收发、token 失败、停用、回调路由、投影
// ======================================================================================

async function mainSuite(h: Harness): Promise<void> {
  const { getSession } = h.store;
  const live = ['a1', 'a2', 'b1'];
  // 启动：三个启用的企微账号各一个运行时（按账号 uuid），停用的、网页的没有；env 账号不走
  check(
    '启动：三个启用的企微账号各起一个运行时，拉取状态在 channel_inbox（cursor 在 channel_accounts，随入站行一起提交）',
    live.every((k) => h.wecom.__wecomTest.inspect(h.ids.get(k)!)?.backend === 'channel_inbox') &&
      h.wecom.__wecomTest.inspect(h.ids.get('d1')!) === null &&
      h.wecom.__wecomTest.inspect(h.ids.get('w1')!) === null,
    json(h.wecom.__wecomTest.ids()),
  );
  check('企微状态在库里：env 账号的老路不走（isWecomEnabled 为 false）', !h.wecom.isWecomEnabled());
  check(
    '启动日志不再说「库里账号的收发还没接上」',
    !logBuf.some((l) => l.includes('还没接上')),
    json(logBuf.filter((l) => l.includes('还没接上'))),
  );
  await waitFor(() => live.every((k) => h.fake.syncs.some((s) => s.kfAcct === k)));
  await h.idle();
  check(
    '启动各补拉一次：每个账号的 sync_msg 只带自己的 open_kfid 与自己的 token',
    live.every((k) => h.fake.syncs.some((s) => s.kfAcct === k)) && h.fake.syncs.every((s) => s.tokenAcct === s.kfAcct),
    json(h.fake.syncs),
  );

  // ---- 同一个 external_userid 在三个账号上交错各发 5 句 ----
  for (let i = 1; i <= 5; i++) {
    for (const k of live) h.say(acct(k).kf, UID, `你好，第${i}句`);
    for (const k of i % 2 ? live : [...live].reverse()) void h.wecom.syncAccountFromCallback(h.ids.get(k)!, `tok-${k}-${i}`);
    await waitFor(() => live.every((k) => h.sentTo(UID, k).length >= i), 20_000);
    await h.idle();
  }
  const sids = { a1: `wecom:${UID}`, a2: `wecom:a2:${UID}`, b1: `wecom:b1:${UID}` } as Record<string, string>;
  for (const k of live) {
    const s = getSession(sids[k]!);
    const customer = (s?.messages ?? []).filter((m) => m.role === 'customer');
    const agent = (s?.messages ?? []).filter((m) => m.role === 'agent');
    check(
      `交错：账号 ${k} 上是一段自己的会话（id ${k === 'a1' ? 'wecom:' : `wecom:${k}:`}…），5 句客户消息、各有回复`,
      customer.length === 5 && agent.length >= 5,
      json(s?.messages.map((x) => x.role)),
    );
    const sent = h.sentTo(UID, k);
    // 发出去的是去过 markdown、可能切过段的正文
    const norm = (t: string): string => h.wecom.__test.wechatify(t);
    check(
      `交错：发给 ${k} 那段会话的每个分段都带 ${k} 的 open_kfid 与 ${k} 的 access_token，内容就是那段会话里的回复`,
      sent.length >= 5 &&
        sent.every((x) => x.tokenAcct === k) &&
        sent.every((x) => agent.some((a) => norm(a.content).includes(x.content.trim()))),
      json(sent.map((x) => [x.tokenAcct, x.kfAcct])),
    );
  }
  check(
    '交错：没有带着别的账号 token 的请求，也没有不认识的 token',
    h.fake.sends.every((s) => s.tokenAcct === s.kfAcct) && h.fake.syncs.every((s) => s.tokenAcct === s.kfAcct),
  );
  check('交错：同一个 external_userid 只有这三段会话', h.store.listSessions().filter((s) => s.id.endsWith(UID)).length === 3);
  check(
    'channelAccountId：非默认账号的会话写它，默认账号（wecom:）的不写',
    getSession(sids.a1!)?.channelAccountId === undefined &&
      getSession(sids.a2!)?.channelAccountId === h.ids.get('a2') &&
      getSession(sids.b1!)?.channelAccountId === h.ids.get('b1'),
  );
  for (const sid of Object.values(sids)) await h.store.flushSession(sid);
  {
    const p = await h.projection();
    check(
      'conversations.channel_account_id 是投影：a2、b1 的会话是账号 uuid，默认账号的是 NULL',
      p[sids.a1!] === null && p[sids.a2!] === h.ids.get('a2') && p[sids.b1!] === h.ids.get('b1'),
      json(p),
    );
  }
  const c1 = await h.cursors();
  check(
    '三个 cursor 各自推进，写在各自那一行的 channel_accounts.cursor；停用的、网页的没动',
    c1.a1 === 'kf03a1:5' && c1.a2 === 'kf03a2:5' && c1.b1 === 'kf03b1:5' && c1.d1 === null && c1.w1 === null,
    json(c1),
  );
  check(
    '不写 var/wecom-cursor.json（不变量 13）',
    !fs.existsSync(path.join(h.varDir, 'wecom-cursor.json')) && !fs.existsSync(h.wecom.__test.STATE_FILE),
  );
  check(
    '不读 WECOM_*：没有一个请求带着 env 里的 corp 或 open_kfid',
    !h.fake.gettokens.some((g) => g.corp === 'corp03env') && !h.fake.syncs.some((s) => s.kfAcct === null),
  );

  // ---- 人工回复（与跟进、付款确认一样经 push）：按 accountForSession 走会话所属的账号 ----
  {
    const ok = await h.wecom.wecomAdapter.push(sids.a2!, '好的，我这边帮您确认', { kind: 'human' });
    const last = h.fake.sends.at(-1);
    check(
      '人工回复：发往 wecom:a2:… 的经 a2 的 open_kfid 与 token 发出，带「【顾问】」',
      ok && last?.kfAcct === 'a2' && last.tokenAcct === 'a2' && last.to === UID && last.content === '【顾问】好的，我这边帮您确认',
      json(last),
    );
    const ok1 = await h.wecom.wecomAdapter.push(sids.a1!, '付款已确认');
    check(
      '付款确认：发往 wecom:… 的经默认账号 a1 发出',
      ok1 && h.fake.sends.at(-1)?.kfAcct === 'a1' && h.fake.sends.at(-1)?.tokenAcct === 'a1',
    );
  }

  // ---- 一个账号 gettoken 一直失败：另两个照常收发，它的 token 告警带账号 key ----
  {
    h.fake.failToken.add('b1');
    h.fake.expired.add('b1'); // 手里的 token 也过期：逼它去重取
    const uid = 'wm03tok';
    for (const k of live) h.say(acct(k).kf, uid, '你好，在吗');
    const before = (await h.cursors()).b1;
    for (const k of live) void h.wecom.syncAccountFromCallback(h.ids.get(k)!, `tok-fail-${k}`);
    await waitFor(() => h.sentTo(uid, 'a1').length > 0 && h.sentTo(uid, 'a2').length > 0, 20_000);
    await h.idle();
    check('b1 取不到 token：a1、a2 照常收到并回复', h.sentTo(uid, 'a1').length >= 1 && h.sentTo(uid, 'a2').length >= 1);
    check(
      'b1 取不到 token：b1 没回复、没拉到消息、cursor 不动',
      h.sentTo(uid, 'b1').length === 0 && !getSession(`wecom:b1:${uid}`) && (await h.cursors()).b1 === before,
    );
    check(
      'token 告警（进程级订阅）带账号 key：只有 b1、错误码 40013',
      h.tokenErrors.length > 0 && h.tokenErrors.every(([code, k]) => k === 'b1' && code === '40013'),
      json(h.tokenErrors),
    );
    h.fake.failToken.delete('b1');
    h.fake.expired.delete('b1');
    await pull(h, 'b1');
    await waitFor(() => h.sentTo(uid, 'b1').length > 0);
    check('b1 恢复之后补上：那一句收到回复，a1、a2 不受影响', h.sentTo(uid, 'b1').length >= 1 && h.sentTo(uid, 'a1').length === 1);
  }

  // ---- 停用的账号：没有运行时，名下会话的推送返回 false，回调不拉 ----
  {
    const from = logBuf.length;
    const ok = await h.wecom.wecomAdapter.push('wecom:d1:wm03off', '顾问的回复', { kind: 'human' });
    check(
      '停用账号的会话：推送返回 false、记一行（人工回复照 02 记「未能发送」），不落到默认账号上',
      !ok && !h.fake.sends.some((s) => s.to === 'wm03off') && logsSince(from).some((l) => l.includes('acct=d1') && l.includes('已停用')),
      json(logsSince(from)),
    );
    const g = await h.callback('GET', 'd1', { encFor: acct('d1') });
    const p = await h.callback('POST', 'd1', { encFor: acct('d1') });
    check(
      '停用账号的回调：GET 404，POST 回 success、记一行、不拉',
      g.status === 404 && p.text === 'success' && p.logs.length === 1 && (await h.pulledBy(p.token)).length === 0,
      json([g.status, p.logs]),
    );
  }

  // ---- 回调路由 ----
  {
    const a1 = acct('a1');
    const a2 = acct('a2');
    const b1 = acct('b1');
    const g1 = await h.callback('GET', null, { encFor: a1, echo: 'echo-a1' });
    check(
      'GET /wecom/callback：留给前缀是 wecom: 的 a1，用 a1 的 Token 与 AES Key 通过校验',
      g1.status === 200 && g1.text === 'echo-a1',
      `${g1.status} ${g1.text}`,
    );
    const g2 = await h.callback('GET', 'a2', { encFor: a2, echo: 'echo-a2' });
    check('GET /wecom/callback/a2：用 a2 自己的 Token 通过校验', g2.status === 200 && g2.text === 'echo-a2', `${g2.status} ${g2.text}`);
    const g3 = await h.callback('GET', 'a2', { encFor: a2, signFor: a1 });
    check('GET /wecom/callback/a2：用 a1 的 Token 签的不过（404，与不存在分不出来）', g3.status === 404, String(g3.status));
    const g4 = await h.callback('GET', 'a2', { encFor: a2, receiveId: '' });
    const wrongDefaultGet = await h.callback('GET', null, { encFor: a1, signFor: a2 });
    const wrongDefaultPost = await h.callback('POST', null, { encFor: a1, signFor: a2 });
    check(
      '默认回调用 a2 的 Token 签：GET 404，POST success、恰好一行验签失败、不拉取',
      wrongDefaultGet.status === 404 &&
        wrongDefaultPost.text === 'success' &&
        wrongDefaultPost.logs.length === 1 &&
        wrongDefaultPost.logs[0]!.includes('验签失败') &&
        (await h.pulledBy(wrongDefaultPost.token)).length === 0,
      json(wrongDefaultPost.logs),
    );

    check('GET：库里的账号遇到空 receiveid 不过（404）', g4.status === 404, String(g4.status));
    for (const k of ['w1', 'nope', 'env']) {
      const g = await h.callback('GET', k, { encFor: a2 });
      check(
        `GET /wecom/callback/${k}（${k === 'w1' ? '网页账号的 key' : k === 'env' ? 'env 账号的 key' : '不存在'}）：404、记一行`,
        g.status === 404 && g.logs.length === 1,
        `${g.status} ${json(g.logs)}`,
      );
      const p = await h.callback('POST', k, { encFor: a2 });
      check(
        `POST /wecom/callback/${k}：回 success、记一行、不拉`,
        p.text === 'success' && p.logs.length === 1 && (await h.pulledBy(p.token)).length === 0,
        json(p.logs),
      );
    }

    const p1 = await h.callback('POST', 'a2', { encFor: a2, signFor: a1 });
    check(
      'POST /wecom/callback/a2 用 a1 的 Token 签：回 success、记一行验签失败、不拉',
      p1.text === 'success' &&
        (await h.pulledBy(p1.token)).length === 0 &&
        p1.logs.some((l) => l.includes('acct=a2') && l.includes('验签失败')),
      json(p1.logs),
    );
    const p2 = await h.callback('POST', 'a2', { encFor: a2, openKfId: null });
    check('POST /wecom/callback/a2，明文里没有 OpenKfId：按路由的账号 a2 拉', json(await h.pulledBy(p2.token)) === json(['a2']));
    const p3 = await h.callback('POST', null, { encFor: a1, openKfId: a2.kf });
    const by3 = await h.pulledBy(p3.token);
    check(
      'POST /wecom/callback（a1 的地址），明文 OpenKfId 是同一企业的 a2：拉 a2（a2 的 open_kfid 与 token），不拉 a1',
      json(by3) === json(['a2']) && h.fake.syncs.filter((s) => s.token === p3.token).every((s) => s.tokenAcct === 'a2'),
      json(by3),
    );
    const p4 = await h.callback('POST', null, { encFor: a1, openKfId: b1.kf });
    check(
      'POST：OpenKfId 是别的企业的客服账号，不认、只记日志',
      (await h.pulledBy(p4.token)).length === 0 && p4.logs.some((l) => l.includes('OpenKfId 对不上')),
      json(p4.logs),
    );
    const p5 = await h.callback('POST', null, { encFor: a1, openKfId: 'kf03none' });
    check('POST：OpenKfId 不是本租户启用的账号，只记日志', (await h.pulledBy(p5.token)).length === 0);
    const p6 = await h.callback('POST', null, { encFor: a1, openKfId: acct('d1').kf });
    check('POST：OpenKfId 是停用的账号，不拉', (await h.pulledBy(p6.token)).length === 0);
    const p7 = await h.callback('POST', 'a2', { encFor: a2, receiveId: '' });
    const p8 = await h.callback('POST', 'a2', { encFor: a2, receiveId: 'corp03b' });
    check(
      'POST：库里的账号遇到空的、或不等于 corp_id 的 receiveid 不拉',
      (await h.pulledBy(p7.token)).length === 0 &&
        (await h.pulledBy(p8.token)).length === 0 &&
        p7.logs.some((l) => l.includes('receiveid')) &&
        p8.logs.some((l) => l.includes('receiveid')),
    );
    const p9 = await h.callback('POST', 'b1', { encFor: b1 });
    check('POST /wecom/callback/b1：另一家企业的账号用自己的 Token、拉自己', json(await h.pulledBy(p9.token)) === json(['b1']));
    // 回调真的带来一句：a2 上的客户经 a1 的地址按 OpenKfId 分派，收到 a2 的回复
    h.say(a2.kf, 'wm03cb', '你好，想咨询');
    const p10 = await h.callback('POST', null, { encFor: a1, openKfId: a2.kf });
    await waitFor(() => h.sentTo('wm03cb').length > 0);
    check(
      '回调分派之后收发：a2 上的客户收到 a2 的回复，会话是 wecom:a2:…',
      p10.text === 'success' &&
        h.sentTo('wm03cb').every((s) => s.kfAcct === 'a2' && s.tokenAcct === 'a2') &&
        !!getSession('wecom:a2:wm03cb'),
    );
    const all = [g1, g2, g3, g4, p1, p2, p3, p4, p7, p8, p9, p10].flatMap((x) => x.logs).join('\n');
    check(
      '回调日志里没有凭据、corp_id、open_kfid 与明文 Token',
      ACCTS.every(
        (a) =>
          !all.includes(secretsOf(a).callbackToken) &&
          !all.includes(secretsOf(a).callbackAesKey) &&
          !all.includes(a.corp) &&
          !all.includes(a.kf),
      ) && !all.includes(p3.token),
    );
  }

  // ---- 给 restart 子进程留下：假企微的日志，以及 b1 会话的 state 里拿掉 channelAccountId（预载要以列为准） ----
  await h.idle();
  for (const s of h.store.listSessions()) await h.store.flushSession(s.id);
  await h.su(`update conversations set state = (state::jsonb - 'channelAccountId')::json where tenant_id = $1 and id = $2`, [
    h.tenantId,
    sids.b1,
  ]);
  h.saveFakeLogs();
}

// ======================================================================================
// restart：同一个库，新进程
// ======================================================================================

async function restartSuite(h: Harness): Promise<void> {
  const { getSession } = h.store;
  check(
    '预载读回 channelAccountId：a2 的会话有，默认账号的没有',
    getSession(`wecom:a2:${UID}`)?.channelAccountId === h.ids.get('a2') && getSession(`wecom:${UID}`)?.channelAccountId === undefined,
  );
  check(
    '预载以 channel_account_id 列为准：state 里被拿掉的 b1 会话照样读回账号',
    getSession(`wecom:b1:${UID}`)?.channelAccountId === h.ids.get('b1'),
  );
  // 等启动的第一次拉取真的发出去了（load 读完库里的 cursor 才拉），再等它跑完：不能只看 idle——load 还在读库时运行时也是空闲的
  // （CI 机器慢时这条断言曾早于 load 读回 cursor）
  await waitFor(() => h.fake.syncs.some((s) => s.kfAcct === 'a2'), 20_000);
  await h.idle();
  const a2 = h.wecom.__wecomTest.inspect(h.ids.get('a2')!);
  const firstSync = h.fake.syncs.find((s) => s.kfAcct === 'a2');
  check(
    '重启：cursor 从库里接着拉（不是冷启动），旧消息不再处理',
    a2?.coldStart === false && firstSync?.cursor === 'kf03a2:7' && h.fake.sends.length === 0,
    json({ a2, firstSync, sends: h.fake.sends.length }),
  );
  const before = (getSession(`wecom:a2:${UID}`)?.messages ?? []).filter((m) => m.role === 'customer').length;
  h.say(acct('a2').kf, UID, '重启之后再问一句');
  await pull(h, 'a2');
  await waitFor(() => h.sentTo(UID, 'a2').length > 0);
  const after = (getSession(`wecom:a2:${UID}`)?.messages ?? []).filter((m) => m.role === 'customer').length;
  check(
    '重启之后的新消息恰好处理一次（会话多一句、回复一次）',
    after === before + 1 && h.sentTo(UID, 'a2').length === 1,
    `${before}→${after}`,
  );
  check('重启之后的 cursor 接着推进', (await h.cursors()).a2 === 'kf03a2:8', json(await h.cursors()));
  check('重启之后也不写 var/wecom-cursor.json', !fs.existsSync(path.join(h.varDir, 'wecom-cursor.json')));
  check(
    '停用前 b1 已实际收发且仍 active',
    (await h.su<{ status: string }>("select status from channel_accounts where tenant_id=$1 and key='b1'", [h.tenantId]))[0]?.status ===
      'active' &&
      (getSession(`wecom:b1:${UID}`)?.messages.filter((m) => m.role === 'customer').length ?? 0) >= 5 &&
      !!getSession(`wecom:b1:${UID}`)?.messages.some((m) => m.role === 'agent'),
  );
  await h.su("update channel_accounts set status='disabled' where tenant_id=$1 and key='b1'", [h.tenantId]);
  await h.su("update channel_accounts set settings=$2::json where tenant_id=$1 and key='a2'", [
    h.tenantId,
    json({ welcomeText: CUSTOM_WELCOME, welcomeBackText: CUSTOM_BACK }),
  ]);
  h.saveFakeLogs();
}

// ======================================================================================
// prod：prod profile、LOG_FORMAT=json，非默认账号跑一轮（父进程扫标准输出）
// ======================================================================================

async function envSuite(h: Harness): Promise<void> {
  const p = await h.callback('POST', null, { encFor: ENV_ACCT, receiveId: '' });
  check(
    '未导入 env 账号：空 receiveid 的有效回调 success、按 02 放行并拉取',
    h.reg.wecomState() === 'not_imported' &&
      p.text === 'success' &&
      json(await h.pulledBy(p.token)) === json(['env']) &&
      h.fake.syncs.filter((s) => s.token === p.token).every((s) => s.tokenAcct === 'env'),
  );
}

async function disabledSuite(h: Harness): Promise<void> {
  await waitFor(() => h.fake.syncs.some((s) => s.kfAcct === 'a2'));
  await h.idle();
  const g = await h.callback('GET', 'b1', { encFor: acct('b1') });
  const p = await h.callback('POST', 'b1', { encFor: acct('b1') });
  check(
    '运行中的 b1 停用后重启：无运行时，GET 404，POST success、记一行、不拉取',
    !h.wecom.__wecomTest.inspect(h.ids.get('b1')!) &&
      g.status === 404 &&
      p.text === 'success' &&
      p.logs.length === 1 &&
      (await h.pulledBy(p.token)).length === 0 &&
      !h.fake.syncs.some((s) => s.kfAcct === 'b1'),
  );
  for (const key of ['a1', 'a2']) {
    h.say(acct(key).kf, UID, '你好，想继续咨询');
    const cb = await h.callback('POST', key === 'a1' ? null : key, { encFor: acct(key) });
    await waitFor(() => h.sentTo(UID, key).length > 0);
    await h.idle();
    check(
      `b1 停用后重启：${key} 的回调照常拉取并按自己的 token 收发`,
      cb.text === 'success' &&
        json(await h.pulledBy(cb.token)) === json([key]) &&
        h.sentTo(UID, key).length > 0 &&
        h.sentTo(UID, key).every((s) => s.tokenAcct === key),
    );
  }
  for (const [key, welcome, back] of [
    ['a1', BASE_WELCOME, BASE_BACK],
    ['a2', CUSTOM_WELCOME, CUSTOM_BACK],
  ]) {
    const uid = key === 'a1' ? 'wm03base' : 'wm03custom';
    const code = `welcome03-${key}`;
    h.emit(acct(key!).kf, {
      external_userid: uid!,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'enter_session', external_userid: uid!, welcome_code: code },
    });
    await pull(h, key!);
    const events = h.fake.events.filter((e) => e.code === code);
    check(
      `${key === 'a1' ? '未设欢迎语' : '设置合格欢迎语后重启'}：新客户实际收到的事件欢迎语全文逐字节相同`,
      events.length === 1 && events[0]!.tokenAcct === key && events[0]!.content === welcome,
    );
    // 无 welcome_code、还没发言的新客户走 send_msg 的 welcomeText 分支。
    h.emit(acct(key!).kf, {
      external_userid: uid!,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'enter_session', external_userid: uid! },
    });
    await pull(h, key!);
    check(
      `${key === 'a1' ? '未设欢迎语' : '设置合格欢迎语后重启'}：无 code 新客户实际收到 welcomeText 全文`,
      h.sentTo(uid!, key).length === 1 && h.sentTo(uid!, key)[0]!.content === welcome,
    );
    // UID 是重启前已有消息的回访客户，与新客户使用不同 id，避免欢迎语去重窗口。
    const n0 = h.sentTo(UID, key).length;
    h.emit(acct(key!).kf, {
      external_userid: UID,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'enter_session', external_userid: UID },
    });
    await pull(h, key!);
    check(
      `${key === 'a1' ? '未设欢迎语' : '设置合格欢迎语后重启'}：回访客户实际收到 welcomeBackText 全文逐字节相同`,
      h.sentTo(UID, key).length === n0 + 1 && h.sentTo(UID, key).at(-1)?.content === back,
    );
  }
}

async function prodSuite(h: Harness): Promise<void> {
  const uid = 'wm03prod';
  const sid = `wecom:a2:${uid}`;
  h.say(acct('a2').kf, uid, '你好，想去云南');
  const p = await h.callback('POST', 'a2', { encFor: acct('a2') });
  await waitFor(() => h.sentTo(uid).length > 0, 20_000);
  await h.idle();
  check('prod：回调拉到 a2 的消息并回复', p.text === 'success' && h.sentTo(uid, 'a2').length >= 1);
  check('prod：会话是 wecom:a2:…、带 channelAccountId', h.store.getSession(sid)?.channelAccountId === h.ids.get('a2'));
  const ok = await h.wecom.wecomAdapter.push(sid, '我是顾问，帮您看一下', { kind: 'human' });
  check('prod：人工回复经 a2 发出', ok && h.fake.sends.at(-1)?.kfAcct === 'a2');
  const off = await h.wecom.wecomAdapter.push(`wecom:d1:${uid}`, '顾问的回复', { kind: 'human' });
  check('prod：停用账号的会话推送返回 false（会打一行带会话的错误日志）', !off);
  // 请求路径里的会话 id（编码形式）也照样不出现在日志里
  await h.app.request(`/api/console/conversations/${encodeURIComponent(sid)}`);
  await h.app.request(`/api/console/conversations/${encodeURIComponent(sid)}/messages`);
  const alerts = await import('../ops/alert.js');
  process.env.ALERT_WEBHOOK_URL = 'https://alert03.selftest.invalid/hook';
  alerts.startAlerts();
  alerts.__alertTest.stopTimer();
  h.fake.expired.add('a2');
  h.fake.failToken.add('a2');
  await h.wecom.wecomAdapter.push(sid, '触发该账号的 token 告警', { kind: 'human' });
  await alerts.__alertTest.settle();
  const forbidden = [uid, sid, encodeURIComponent(sid)];
  check(
    'prod、LOG_FORMAT=json：同轮非默认账号告警实际到达假 webhook，无 external_userid、原会话 id 与 %3A 编码',
    h.fake.alerts.length > 0 &&
      h.fake.alerts.some((a) => a.includes('a2')) &&
      h.fake.alerts.every((a) => forbidden.every((v) => !a.includes(v))),
  );
  await h.store.flushSession(sid);
}

// ======================================================================================
// rpg：真实 Postgres
// ======================================================================================

async function realPgSuite(h: Harness): Promise<void> {
  const uid = 'wm03pg';
  h.say(acct('a1').kf, uid, '你好');
  h.say(acct('a2').kf, uid, '你好');
  await pull(h, 'a1');
  await pull(h, 'a2');
  await waitFor(() => h.sentTo(uid, 'a1').length > 0 && h.sentTo(uid, 'a2').length > 0);
  await h.idle();
  const s1 = `wecom:${uid}`;
  const s2 = `wecom:a2:${uid}`;
  await h.store.flushSession(s1);
  await h.store.flushSession(s2);
  const p = await h.projection();
  check(
    '真实 PG：channel_account_id 以 agent_app 写进库（a2 是账号 uuid，默认账号 NULL）',
    p[s1] === null && p[s2] === h.ids.get('a2'),
    json(p),
  );
  await waitFor(async () => (await h.cursors()).b1 === 'kf03b1:0');
  const c = await h.cursors();
  check(
    '真实 PG：cursor 以 agent_app 写进各自那一行（列级授权）',
    c.a1 === 'kf03a1:1' && c.a2 === 'kf03a2:1' && c.b1 === 'kf03b1:0',
    json(c),
  );
  await h.su(`update conversations set state = (state::jsonb - 'channelAccountId')::json where tenant_id = $1 and id = $2`, [
    h.tenantId,
    s2,
  ]);
  const { readSessionBatch } = await import('../db/repo/conversations.js');
  const { rebuildSessions } = await import('../store/project.js');
  const rebuilt = await h.withTenant(
    h.db,
    { tenantId: h.tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } },
    async (tx) => {
      const b = await readSessionBatch(tx, null, 100);
      return rebuildSessions(b.rows, b.messages);
    },
  );
  const byId = new Map(rebuilt.map((r) => [r.row.id, r.session]));
  check(
    '真实 PG：按预载的读法重建，channelAccountId 以列为准（state 里拿掉了也读回），默认账号的没有',
    byId.get(s2)?.channelAccountId === h.ids.get('a2') && !!byId.get(s1) && byId.get(s1)?.channelAccountId === undefined,
  );
}

// ======================================================================================
// out / rout：出站先落库、后发送（03 第 8 步；spec「出站：投递状态」，R4、R6、R21，不变量 4、6、7、10，验收 5、7 的 A/B、17、20）
// 假企微在请求到达时查库：那一段是什么状态；靠挡住借连接（faults.gate）与账本的两个自测钩子造时刻。杀进程的部分在第 10 步
// ======================================================================================

async function outboundSuite(h: Harness): Promise<void> {
  const ledger = await import('../quota/ledger.js');
  const tk = await import('../handoff/takeover.js');
  const engine = await import('../engine.js');
  const { __privacyTest } = await import('../privacy/privacy.js');
  const { CONSENT_DECLINED_REPLY } = await import('../handoff/consent.js');
  const { getSession } = h.store;
  const seqOf = h.store.seqOf;
  ledger.__ledgerTest.setWaits({ commitMs: 700, markMs: 700 });
  const idOf = (k: string): string => h.ids.get(k)!;
  const sidOf = (k: string, uid: string): string => acct(k).prefix + uid;
  interface Row {
    msgid: string;
    status: string;
    nopay: boolean;
    kind: string;
    account_id: string | null;
    segment: number;
    attempts: number;
    message_seq: number | null;
    xmin: string;
  }
  const COLS = `channel_msgid as msgid, status, payload is null as nopay, kind, account_id::text as account_id, segment, attempts,
                message_seq, xmin::text as xmin`;
  const rowsOf = (sid: string): Promise<Row[]> =>
    h.su<Row>(`select ${COLS} from outbound_sends where conversation_id = $1 order by sent_at, segment`, [sid]);
  const rowOf = async (msgid: string): Promise<Row | null> =>
    (await h.su<Row>(`select ${COLS} from outbound_sends where channel_msgid = $1`, [msgid]))[0] ?? null;
  const settle = async (): Promise<void> => {
    await h.idle();
    for (let i = 0; i < 3; i++) {
      await sleep(20);
      await h.store.drainStore(5000);
    }
  };
  /** 客户在这个账号上说一句，拉一次，等处理链跑完 */
  const talk = async (k: string, uid: string, text: string): Promise<void> => {
    h.say(acct(k).kf, uid, text);
    await pull(h, k);
  };
  const lastAi = (sid: string): ChatMessage | undefined =>
    getSession(sid)
      ?.messages.filter((m) => m.role === 'agent' && (m.author === undefined || m.author === 'ai'))
      .at(-1);
  /** 请求到达假企微的那一刻，库里这一段是什么状态（不变量 4） */
  const statusAtSend = new Map<string, string | null>();
  h.fake.beforeSend = async (body) => {
    statusAtSend.set(String(body.msgid), (await rowOf(String(body.msgid)))?.status ?? null);
  };
  /** 一个先落库的种类在 markSending 之前，记下它的 pending 行与 sql 给的那一行各自的 xmin（同一个事务提交的话相同） */
  const captureAtMark = (sid: string, kind: string, otherSql: string): { out?: string; other?: string; done: Promise<void> } => {
    const cap: { out?: string; other?: string; done: Promise<void> } = { done: Promise.resolve() };
    let resolve!: () => void;
    cap.done = new Promise((r) => (resolve = r));
    ledger.__ledgerTest.setMarkHook(async (intent) => {
      if (intent.sessionId !== sid || intent.kind !== kind || cap.out !== undefined) return;
      cap.out = (await rowOf(intent.msgid))?.xmin ?? 'none';
      cap.other = (await h.su<{ xmin: string }>(otherSql, [sid, intent.message ? seqOf(intent.message) : null]))[0]?.xmin ?? 'none';
      resolve();
    });
    return cap;
  };

  // ---- 一条 AI 回复：每段请求到达假企微时库里已是 sending；结果 accepted、payload 已空、kind ai、account_id 是账号 uuid ----
  {
    const uid = 'wm08ok';
    const sid = sidOf('a2', uid);
    await talk('a2', uid, '你好，想去云南');
    await settle();
    const sent = h.sentTo(uid, 'a2');
    const rows = await rowsOf(sid);
    const reply = lastAi(sid)!;
    check(
      'AI 回复：每段请求到达假企微时，库里这一段已是 sending（不变量 4）',
      sent.length > 0 && sent.every((x) => statusAtSend.get(x.msgid) === 'sending'),
      json(sent.map((x) => statusAtSend.get(x.msgid))),
    );
    check(
      'AI 回复：出站行与发出的分段一一对应（同一 msgid）、kind ai、accepted、payload 已空、account_id 是 a2 的、attempts 1、message_seq 对上回复、段号从 0 连着',
      rows.length === sent.length &&
        rows.every(
          (r, i) =>
            r.msgid === sent[i]!.msgid &&
            r.kind === 'ai' &&
            r.status === 'accepted' &&
            r.nopay &&
            r.account_id === idOf('a2') &&
            r.attempts === 1 &&
            r.message_seq === seqOf(reply) &&
            r.segment === i,
        ),
      json(rows),
    );
    check('工作台：正常发出的回复 accepted（不显示）', ledger.deliveryOf(sid, reply)?.status === 'accepted');
  }

  // ---- 卡片：正文一段 + 卡片一段（kind 记组的种类）；卡片被拒补「标题 + 链接」（运行时才补的段，段号接在这一组之后） ----
  {
    process.env.PUBLIC_BASE_URL = 'https://demo.example.com';
    h.fake.mediaOk = true;
    const uid = 'wm08card';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    await settle();
    const text = '方案书在这儿 /proposal/r-sichuan-lux/2，您看看';
    const n0 = h.sentTo(uid).length;
    h.fake.sendResult = (b) => (b.msgtype === 'link' && b.touser === uid ? { errcode: 40001, errmsg: 'selftest: 卡片拒收' } : null);
    const ok = await h.wecom.wecomAdapter.push(sid, text, { kind: 'human' });
    h.fake.sendResult = null;
    await settle();
    const sent = h.sentTo(uid).slice(n0);
    const rows = (await rowsOf(sid)).filter((r) => r.kind === 'human');
    check(
      '卡片被拒：正文、卡片、补的「标题 + 链接」三段；都记 human（不是 card）；段号 0、1、2；accepted、rejected、accepted；补的那段发之前也已是 sending',
      ok &&
        sent.map((x) => x.msgtype).join() === 'text,link,text' &&
        sent[0]!.content.startsWith('【顾问】') &&
        sent[2]!.content.includes('https://demo.example.com/proposal/r-sichuan-lux/2') &&
        rows.length === 3 &&
        rows.map((r) => r.segment).join() === '0,1,2' &&
        rows.map((r) => r.status).join() === 'accepted,rejected,accepted' &&
        statusAtSend.get(sent[2]!.msgid) === 'sending',
      json({ ok, sent: sent.map((x) => [x.msgtype, x.content.slice(0, 30)]), rows: rows.map((r) => [r.segment, r.status, r.kind]) }),
    );
    const n1 = h.sentTo(uid).length;
    const ok2 = await h.wecom.wecomAdapter.push(sid, text, { kind: 'human' });
    await settle();
    const rows2 = (await rowsOf(sid)).filter((r) => r.kind === 'human').slice(3);
    check(
      '卡片正常：正文 + 卡片两段都 accepted，卡片段同样记 human',
      ok2 &&
        h
          .sentTo(uid)
          .slice(n1)
          .map((x) => x.msgtype)
          .join() === 'text,link' &&
        rows2.map((r) => r.status).join() === 'accepted,accepted',
      json(rows2),
    );
    process.env.PUBLIC_BASE_URL = '';
    h.fake.mediaOk = false;
  }

  // ---- 人工回复：分段的 pending 与这条人工回复同一次落库 ----
  {
    const uid = 'wm08hum';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    await settle();
    const cap = captureAtMark(sid, 'human', 'select xmin::text as xmin from messages where conversation_id = $1 and seq = $2');
    const r = await tk.reply(sid, tk.sharedActor(), '好的，我来跟进', `c08-${Date.now()}`);
    ledger.__ledgerTest.setMarkHook(null);
    await settle();
    check(
      '人工回复：分段的 pending 与这条人工回复同一个事务提交（xmin 相同），之后才发',
      r.sent && !!cap.out && cap.out !== 'none' && cap.out === cap.other && h.sentTo(uid).at(-1)?.content === '【顾问】好的，我来跟进',
      json({ r, cap }),
    );
    check(
      '人工回复：出站行 kind human、accepted',
      (await rowsOf(sid)).filter((x) => x.kind === 'human').every((x) => x.status === 'accepted'),
    );
  }

  // ---- 付款确认（通知）：pending 与这条确认同一次落库 ----
  {
    const uid = 'wm08pay';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    await settle();
    const o = h.store.createOrder({
      sessionId: sid,
      routeId: 'r-sichuan-lux',
      routeTitle: '川西',
      travelers: 2,
      departDate: '2026-12-01',
      totalPrice: 20000,
    });
    getSession(sid)!.orderIds.push(o.id);
    h.store.saveSession(getSession(sid)!);
    h.store.markOrderPaid(o.id);
    await settle();
    const cap = captureAtMark(sid, 'notice', 'select xmin::text as xmin from messages where conversation_id = $1 and seq = $2');
    const notice = await engine.notifyPaid(o.id);
    const ok = await tk.pushToChannel(sid, notice!.text, { kind: 'notice', message: notice!.message, prepared: notice!.prepared });
    ledger.__ledgerTest.setMarkHook(null);
    await settle();
    check(
      '付款确认：prepare 拿到句柄，pending 与这条确认同一个事务提交（xmin 相同），之后才发',
      ok && notice?.prepared != null && !!cap.out && cap.out !== 'none' && cap.out === cap.other,
      json({ ok, cap }),
    );
    check(
      '付款确认：出站行 kind notice、accepted',
      (await rowsOf(sid)).some((x) => x.kind === 'notice' && x.status === 'accepted'),
    );
  }

  // ---- 同意菜单：pending 加进「问过」那一次落库；不同意之后的确认（通知）加进同意记录那一次落库 ----
  {
    __privacyTest.set({ version: 1, body: 'x' });
    const uid = 'wm08menu';
    const sid = sidOf('a1', uid);
    const cap = captureAtMark(
      sid,
      'menu',
      `select xmin::text as xmin from consents where conversation_id = $1 and decision = 'asked' and $2::int is null order by at desc limit 1`,
    );
    await talk('a1', uid, '我妈有高血压，能去西藏吗');
    ledger.__ledgerTest.setMarkHook(null);
    await settle();
    const menus = h.sentTo(uid).filter((x) => x.msgtype === 'msgmenu');
    const menuRows = (await rowsOf(sid)).filter((x) => x.kind === 'menu');
    check(
      '同意菜单：pending 与「问过」的同意记录同一个事务提交（xmin 相同），菜单发出、出站行 kind menu accepted',
      menus.length === 1 &&
        menuRows.length === 1 &&
        menuRows[0]!.status === 'accepted' &&
        !!cap.out &&
        cap.out !== 'none' &&
        cap.out === cap.other,
      json({ menus: menus.length, menuRows, cap }),
    );
    const cap2 = captureAtMark(
      sid,
      'notice',
      `select xmin::text as xmin from consents where conversation_id = $1 and decision = 'declined' and $2::int is null order by at desc limit 1`,
    );
    h.emit(acct('a1').kf, { external_userid: uid, origin: 3, msgtype: 'text', text: { content: '不同意', menu_id: 'health:declined' } });
    await pull(h, 'a1');
    ledger.__ledgerTest.setMarkHook(null);
    await settle();
    check(
      '不同意之后的确认：pending 与「不同意」的同意记录同一个事务提交（xmin 相同），确认发出、kind notice',
      h.sentTo(uid).at(-1)?.content === CONSENT_DECLINED_REPLY && !!cap2.out && cap2.out !== 'none' && cap2.out === cap2.other,
      json(cap2),
    );
    __privacyTest.reset();
  }

  // ---- 老客户欢迎语：有会话的随会话落库；还没有会话的单独一个短事务（conversation_id 是将要用的会话 id） ----
  {
    const uid = 'wm08wel';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    await settle();
    h.emit(acct('a1').kf, {
      external_userid: uid,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'enter_session', external_userid: uid },
    });
    await pull(h, 'a1');
    await settle();
    const w = (await rowsOf(sid)).filter((x) => x.kind === 'welcome');
    check(
      '欢迎语（有会话）：一行 welcome、accepted、发之前已是 sending',
      w.length === 1 && w[0]!.status === 'accepted' && statusAtSend.get(w[0]!.msgid) === 'sending',
      json(w),
    );
    const uid2 = 'wm08wel2';
    h.emit(acct('a1').kf, {
      external_userid: uid2,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'enter_session', external_userid: uid2 },
    });
    await pull(h, 'a1');
    await settle();
    await waitFor(async () => (await rowsOf(sidOf('a1', uid2)))[0]?.status === 'accepted', 3000);
    const w2 = await rowsOf(sidOf('a1', uid2));
    check(
      '欢迎语（还没有会话）：单独短事务写进库，conversation_id 是将要用的会话 id、welcome、accepted，发之前已是 sending；没有凭空建会话',
      w2.length === 1 &&
        w2[0]!.kind === 'welcome' &&
        w2[0]!.status === 'accepted' &&
        statusAtSend.get(w2[0]!.msgid) === 'sending' &&
        !getSession(sidOf('a1', uid2)),
      json(w2),
    );
  }

  // ---- 跟进：pending 与记账、任务改 sending 同一次落库 ----
  {
    process.env.FOLLOWUP_ENABLED = '1';
    const runner = await import('../jobs/runner.js');
    runner.__jobsTest.start((id, text, opts) => h.wecom.wecomAdapter.push(id, text, opts));
    await runner.runJobsOnce();
    const uid = 'wm08fu';
    const sid = sidOf('a1', uid);
    const H = 3_600_000;
    const s = h.store.getOrCreateSession(sid, 'wecom');
    s.stage = 'quote';
    s.messages.push(
      {
        role: 'customer',
        content: '这条线多少钱',
        at: Date.now() - 3 * H - 60_000,
        msgid: 'q-wm08fu',
        sentAt: Date.now() - 3 * H - 60_000,
      },
      { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at: Date.now() - 3 * H },
    );
    s.updatedAt = Date.now() - 3 * H;
    h.store.saveSession(s, false);
    await h.store.flushSession(sid);
    const cap = captureAtMark(
      sid,
      'followup',
      `select xmin::text as xmin from jobs where kind = 'followup' and payload->>'sessionId' = $1 and $2::int is null order by created_at desc limit 1`,
    );
    await runner.runJobsOnce();
    ledger.__ledgerTest.setMarkHook(null);
    await settle();
    await sleep(2200); // 跟进送达之后才写进会话：结果等它分到 seq 再写（02 的 2 秒上限）
    await settle();
    const fu = (await rowsOf(sid)).filter((x) => x.kind === 'followup');
    const fuMsg = getSession(sid)?.messages.find((m) => m.author === 'followup');
    check(
      '跟进：pending 与记账、任务改 sending 同一个事务提交（xmin 与任务行相同），之后才发；结果 accepted、message_seq 对上写进会话的那条',
      !!cap.out &&
        cap.out !== 'none' &&
        cap.out === cap.other &&
        fu.length >= 1 &&
        fu.every((x) => x.status === 'accepted') &&
        !!fuMsg &&
        fu[0]!.message_seq === seqOf(fuMsg),
      json({ cap, fu, fuSeq: fuMsg ? seqOf(fuMsg) : null }),
    );
    process.env.FOLLOWUP_ENABLED = '';
  }

  // ---- 接手检查按种类（协调者裁决）：prepare 到发送之间有人接手，付款确认与人工回复照发；跟进照旧取消（AI 回复见下面的验收 5） ----
  {
    // 付款确认：notifyPaid 里 prepare，之后、push 之前接手代次变了
    const uid = 'wm08tkn';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    await settle();
    const o = h.store.createOrder({
      sessionId: sid,
      routeId: 'r-sichuan-lux',
      routeTitle: '川西',
      travelers: 2,
      departDate: '2026-12-01',
      totalPrice: 20000,
    });
    getSession(sid)!.orderIds.push(o.id);
    h.store.saveSession(getSession(sid)!);
    h.store.markOrderPaid(o.id);
    await settle();
    const n0 = h.sentTo(uid).length;
    const notice = await engine.notifyPaid(o.id);
    tk.__takeoverTest.bump(sid); // prepare 之后、发送之前有人接手
    const ok = await tk.pushToChannel(sid, notice!.text, { kind: 'notice', message: notice!.message, prepared: notice!.prepared });
    await settle();
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'notice');
    check(
      '接手不拦通知：prepare 之后有人接手，付款确认照发、出站行 accepted、没有 cancelled',
      ok && h.sentTo(uid).length > n0 && rows.length > 0 && rows.every((x) => x.status === 'accepted'),
      json({ ok, rows }),
    );
  }
  {
    // 人工回复：reply 里 prepare，之后、push 之前接手代次又变了（改派）
    const uid = 'wm08tkh';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    await settle();
    const n0 = h.sentTo(uid).length;
    const pending = tk.reply(sid, tk.sharedActor(), '我来跟进这单', `c08tk-${Date.now()}`);
    tk.__takeoverTest.bump(sid);
    const r = await pending;
    await settle();
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'human');
    check(
      '接手不拦人工回复：prepare 之后接手代次变了，人工回复照发、出站行 accepted',
      r.sent &&
        h.sentTo(uid).length === n0 + 1 &&
        h.sentTo(uid).at(-1)?.content === '【顾问】我来跟进这单' &&
        rows.every((x) => x.status === 'accepted'),
      json({ r, rows }),
    );
  }
  {
    // 跟进：执行体自己比过接手之后、markSending 期间有人接手 → 这一组 cancelled、零发送
    process.env.FOLLOWUP_ENABLED = '1';
    const runner = await import('../jobs/runner.js');
    const uid = 'wm08tkf';
    const sid = sidOf('a1', uid);
    const H = 3_600_000;
    const s = h.store.getOrCreateSession(sid, 'wecom');
    s.stage = 'quote';
    s.messages.push(
      {
        role: 'customer',
        content: '这条线多少钱',
        at: Date.now() - 3 * H - 60_000,
        msgid: 'q-wm08tkf',
        sentAt: Date.now() - 3 * H - 60_000,
      },
      { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at: Date.now() - 3 * H },
    );
    s.updatedAt = Date.now() - 3 * H;
    h.store.saveSession(s, false);
    await h.store.flushSession(sid);
    let fired = false;
    ledger.__ledgerTest.setMarkHook((intent) => {
      if (intent.sessionId !== sid || intent.kind !== 'followup' || fired) return;
      fired = true;
      tk.__takeoverTest.bump(sid);
    });
    await runner.runJobsOnce();
    ledger.__ledgerTest.setMarkHook(null);
    await settle();
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'followup');
    check(
      '接手照旧拦跟进：markSending 期间接手代次变了，零发送、这一组 cancelled',
      fired && h.sentTo(uid).length === 0 && rows.length > 0 && rows.every((x) => x.status === 'cancelled'),
      json({ fired, sent: h.sentTo(uid).length, rows }),
    );
    process.env.FOLLOWUP_ENABLED = '';
  }
  {
    // 网页渠道（第 17 步）：没有发送账本，prepare 无操作（null）、release(null) 无操作，push 照常写进历史
    const sid = 'web:0123456789abcdef0123456789abcdef';
    h.store.getOrCreateSession(sid, 'web');
    const prepared = tk.prepareChannel(sid, '付款已确认', { kind: 'notice' });
    tk.releasePrepared(prepared, 'aborted');
    const ok = await tk.pushToChannel(sid, '付款已确认', { kind: 'notice', prepared });
    check(
      '网页渠道：prepare 返回 null、release 无操作、push 照常（没有出站行）',
      prepared === null && ok && (await rowsOf(sid)).length === 0,
      json({ prepared, ok }),
    );
  }

  // ---- 验收 5：markSending 挂住期间顾问接手（marked 与 db_unavailable 两种）：零发送、cancelled、会话多一条「本轮未发送」 ----
  for (const [label, holdMs, uid] of [
    ['marked', 150, 'wm08tka'],
    ['db_unavailable', 1300, 'wm08tkb'],
  ] as const) {
    const sid = sidOf('a1', uid);
    let fired = false;
    ledger.__ledgerTest.setMarkHook((intent) => {
      if (intent.sessionId !== sid || fired) return;
      fired = true;
      let open!: () => void;
      h.faults.gate = new Promise<void>((r) => (open = r));
      tk.takeover(sid, tk.sharedActor()); // 挂住期间顾问在后台接手
      setTimeout(() => {
        h.faults.gate = null;
        open();
      }, holdMs);
    });
    await talk('a1', uid, '你好，想去云南');
    ledger.__ledgerTest.setMarkHook(null);
    await sleep(holdMs);
    await settle();
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'ai');
    const reply = lastAi(sid);
    check(
      `接手竞态（markSending ${label}）：零发送、这一组都 cancelled（payload 已空）、会话多一条「本轮未发送」、工作台「未发送」`,
      fired &&
        h.sentTo(uid).length === 0 &&
        rows.length > 0 &&
        rows.every((x) => x.status === 'cancelled' && x.nopay) &&
        !!getSession(sid)?.messages.some((m) => m.role === 'system' && m.content === tk.TAKEN_OVER_NOTE) &&
        !!reply &&
        ledger.deliveryOf(sid, reply)?.status === 'cancelled',
      json({ fired, sent: h.sentTo(uid).length, rows: rows.map((x) => x.status) }),
    );
  }

  // ---- 验收 20：停机截止 ----
  {
    const uid = 'wm08dl';
    const sid = sidOf('a1', uid);
    h.wecom.__wecomTest.closeSends(idOf('a1'), Date.now());
    await talk('a1', uid, '你好，想去云南');
    await settle();
    h.wecom.__wecomTest.closeSends(idOf('a1'), null);
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'ai');
    check(
      '停机截止之后才回包：不开始 send_msg，分段留在 pending（payload 在，重启后按同一 msgid 补发，第 10 步）',
      h.sentTo(uid).length === 0 && rows.length > 0 && rows.every((x) => x.status === 'pending' && !x.nopay),
      json(rows),
    );
  }
  for (const [label, holdMs, uid] of [
    ['marked', 150, 'wm08dla'],
    ['db_unavailable', 1300, 'wm08dlb'],
  ] as const) {
    const sid = sidOf('a1', uid);
    let fired = false;
    ledger.__ledgerTest.setMarkHook((intent) => {
      if (intent.sessionId !== sid || fired) return;
      fired = true;
      let open!: () => void;
      h.faults.gate = new Promise<void>((r) => (open = r));
      h.wecom.__wecomTest.closeSends(idOf('a1'), Date.now()); // 挂住期间跨过 normal 段截止
      setTimeout(() => {
        h.faults.gate = null;
        open();
      }, holdMs);
    });
    await talk('a1', uid, '你好，想去云南');
    ledger.__ledgerTest.setMarkHook(null);
    await sleep(holdMs);
    await settle();
    h.wecom.__wecomTest.closeSends(idOf('a1'), null);
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'ai');
    check(
      `markSending ${label} 期间跨过停机截止：假企微上没有请求，库里${label === 'marked' ? '迁回' : '仍是'} pending`,
      fired && h.sentTo(uid).length === 0 && rows.length > 0 && rows.every((x) => x.status === 'pending' && !x.nopay),
      json(rows),
    );
  }

  // ---- 验收 7 的 A：pending 已提交、markSending 判 db_unavailable：照发、计数；放开之后结果直接从 pending 迁 ----
  {
    const uid = 'wm08r6a';
    const sid = sidOf('a1', uid);
    let fired = false;
    ledger.__ledgerTest.setMarkHook((intent) => {
      if (intent.sessionId !== sid || fired) return;
      fired = true;
      let open!: () => void;
      h.faults.gate = new Promise<void>((r) => (open = r));
      setTimeout(() => {
        h.faults.gate = null;
        open();
      }, 1300);
    });
    const u0 = ledger.unsafeSendsIn10m();
    await talk('a1', uid, '你好，想去云南');
    ledger.__ledgerTest.setMarkHook(null);
    const sent = h.sentTo(uid);
    check(
      'R6 A：db_unavailable 照发——请求到达时库里还是 pending，「没落库就发」计数',
      sent.length > 0 && statusAtSend.get(sent[0]!.msgid) === 'pending' && ledger.unsafeSendsIn10m() > u0,
      json({ at: sent.map((x) => statusAtSend.get(x.msgid)), u: ledger.unsafeSendsIn10m() - u0 }),
    );
    await sleep(1300);
    await settle();
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'ai');
    check(
      'R6 A：放开之后这一组从 pending 直接迁到 accepted',
      rows.length === sent.length && rows.every((x) => x.status === 'accepted'),
      json(rows),
    );
    const inbound = await h.su<{ state: string }>(
      "select state from channel_inbox where tenant_id=$1 and conversation_id=$2 and kind='message'",
      [h.tenantId, sid],
    );
    check('R6 A：放开之后本次入站行 done', inbound.length === 1 && inbound[0]!.state === 'done', json(inbound));
  }

  // ---- 验收 7 的 B：生成完时已经挡住，commitOutbound 超时；markSending absent 照发；放开之后先插 pending、再迁 accepted ----
  {
    const uid = 'wm08r6b';
    const sid = sidOf('a1', uid);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let planned = false;
    let marked = false;
    ledger.__ledgerTest.setPlanHook((intents) => {
      if (intents[0]?.sessionId !== sid || planned) return;
      planned = true;
      h.faults.gate = gate; // 这一组的 pending 那次落库借不到连接
    });
    ledger.__ledgerTest.setMarkHook((intent) => {
      if (intent.sessionId !== sid || marked) return;
      marked = true;
      h.faults.gate = null; // 库恢复了，挡着的那次落库还没进去
    });
    const u0 = ledger.unsafeSendsIn10m();
    await talk('a1', uid, '你好，想去云南');
    ledger.__ledgerTest.setPlanHook(null);
    ledger.__ledgerTest.setMarkHook(null);
    const sent = h.sentTo(uid);
    check(
      'R6 B：commitOutbound 超时、markSending absent 照发——请求到达时库里还没有这一行，「没落库就发」计数',
      planned && marked && sent.length > 0 && sent.every((x) => statusAtSend.get(x.msgid) === null) && ledger.unsafeSendsIn10m() > u0,
      json({ at: sent.map((x) => statusAtSend.get(x.msgid)) }),
    );
    open();
    await settle();
    const rows = (await rowsOf(sid)).filter((x) => x.kind === 'ai');
    check(
      'R6 B：放开之后先插 pending、再迁 accepted（与发出的分段同一 msgid）',
      rows.length === sent.length && rows.every((x, i) => x.status === 'accepted' && x.msgid === sent[i]!.msgid),
      json(rows),
    );
    const inbound = await h.su<{ state: string }>(
      "select state from channel_inbox where tenant_id=$1 and conversation_id=$2 and kind='message'",
      [h.tenantId, sid],
    );
    check('R6 B：放开之后本次入站行 done', inbound.length === 1 && inbound[0]!.state === 'done', json(inbound));
  }

  // ---- markSending 返回 absent、而这一组的 pending 提交过（行又没了：只会是被清除）：不发、记一行错误 ----
  {
    const uid = 'wm08gone';
    const sid = sidOf('a1', uid);
    let fired = false;
    ledger.__ledgerTest.setMarkHook(async (intent) => {
      if (intent.sessionId !== sid || fired) return;
      fired = true;
      // agent_app 没有 DELETE：以超级用户删掉这一组的行，模拟提交之后被清除
      await h.su('delete from outbound_sends where conversation_id = $1', [sid]);
    });
    const from = logBuf.length;
    const u0 = ledger.unsafeSendsIn10m();
    await talk('a1', uid, '你好，想去云南');
    ledger.__ledgerTest.setMarkHook(null);
    await settle();
    check(
      'absent 而 pending 提交过：不发（不按 R6 照发、不计数）、记一行错误',
      fired &&
        h.sentTo(uid).length === 0 &&
        ledger.unsafeSendsIn10m() === u0 &&
        logsSince(from).some((l) => l.includes('提交过又不在库里')),
      json({ sent: h.sentTo(uid).length, logs: logsSince(from).filter((l) => l.includes('不在库里')) }),
    );
  }

  // ---- 退避期间收到失败回执：这一段已是 failed，重试不再发（不变量 5：failed 永不再发） ----
  {
    const uid = 'wm08rcv';
    let first: string | null = null;
    h.fake.sendResult = (b) => {
      if (b.touser !== uid) return null;
      if (first === null) {
        first = String(b.msgid);
        // 首次请求网络异常（记 unknown、进退避）；退避期间企微发来这一段的 msg_send_fail
        setTimeout(() => {
          h.emit(acct('a2').kf, {
            external_userid: uid,
            origin: 4,
            msgtype: 'event',
            event: { event_type: 'msg_send_fail', fail_msgid: first!, fail_type: 4 },
          });
          void h.wecom.syncAccountFromCallback(idOf('a2'), `poll-rcv-${Date.now()}`);
        }, 100);
        return 'network';
      }
      return null;
    };
    await talk('a2', uid, '你好，想去云南');
    await sleep(1000);
    await settle();
    h.fake.sendResult = null;
    const reqs = first ? h.fake.sends.filter((x) => x.msgid === first).length : -1;
    check(
      '退避期间收到失败回执：同一段只发过一次请求（重试前看到 failed 就停），库里这一段 failed',
      first !== null && reqs === 1 && (await rowOf(first))?.status === 'failed',
      json({ reqs, row: first ? await rowOf(first) : null }),
    );
  }

  // ---- 模型等待期间顾问接手、随后模型报错：兜底道歉拿本轮开始时的代次比，不发、这一组 cancelled ----
  {
    const uid = 'wm08exc';
    const sid = sidOf('a1', uid);
    const saved = Object.fromEntries(
      [
        'LLM_MOCK',
        'LLM_PROVIDER',
        'LLM_BASE_URL',
        'LLM_API_KEY',
        'LLM_MODEL',
        'LLM_MODEL_CHEAP',
        'LLM_HEDGE_MODEL',
        'EMBED_BASE_URL',
        'EMBED_API_KEY',
      ].map((k) => [k, process.env[k]]),
    );
    // 假模型：主机名不可解析（.invalid），请求全被假 fetch 接住，绝不会打到真实模型
    Object.assign(process.env, {
      LLM_MOCK: '0',
      LLM_PROVIDER: '',
      LLM_BASE_URL: 'https://llm.selftest.invalid/v1',
      LLM_API_KEY: 'selftest-fake-key',
      LLM_MODEL: 'selftest-fake',
      LLM_MODEL_CHEAP: 'selftest-fake',
      LLM_HEDGE_MODEL: '',
      EMBED_BASE_URL: 'https://llm.selftest.invalid/v1',
      EMBED_API_KEY: 'selftest-fake-key',
    });
    const { llmCfg } = await import('../llm.js');
    let calls = 0;
    h.fake.onLlm = () => {
      calls += 1;
      // 模型还在生成：顾问在后台接手
      if (calls === 1) tk.takeover(sid, tk.sharedActor());
    };
    const from = logBuf.length;
    if (llmCfg().baseUrl.startsWith('https://llm.selftest.invalid')) await talk('a1', uid, '你好，想去云南');
    h.fake.onLlm = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await settle();
    const rows = await rowsOf(sid);
    check(
      '模型报错前已被接手：走了异常兜底，兜底道歉不发（零请求），这一组 cancelled',
      calls > 0 &&
        logsSince(from).some((l) => l.includes('处理消息失败')) &&
        h.sentTo(uid).length === 0 &&
        rows.length > 0 &&
        rows.every((x) => x.status === 'cancelled' && x.kind === 'ai'),
      json({ calls, sent: h.sentTo(uid).map((x) => x.content), rows: rows.map((x) => x.status) }),
    );
  }

  // ---- 工作台：回包挂住「发送中」、回执 4「没送达」、超时「可能没送达」（「未发送」见接手竞态） ----
  {
    const uid = 'wm08wb';
    const sid = sidOf('a2', uid);
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    let hung = false;
    const prev = h.fake.beforeSend;
    h.fake.beforeSend = async (body) => {
      await prev?.(body);
      if (body.touser === uid && !hung) {
        hung = true;
        await hang;
      }
    };
    h.say(acct('a2').kf, uid, '你好，想去云南');
    void h.wecom.syncAccountFromCallback(idOf('a2'), `poll-wb-${Date.now()}`);
    await waitFor(() => hung, 10_000);
    const reply = lastAi(sid)!;
    check(
      '工作台：假企微挂住回包时显示「发送中」',
      ledger.deliveryOf(sid, reply)?.status === 'sending',
      json(ledger.deliveryOf(sid, reply)),
    );
    release();
    await settle();
    h.fake.beforeSend = prev;
    check('工作台：回包之后 accepted（不显示）', ledger.deliveryOf(sid, reply)?.status === 'accepted');
    const failMsgid = h.sentTo(uid).at(-1)!.msgid;
    h.emit(acct('a2').kf, {
      external_userid: uid,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'msg_send_fail', fail_msgid: failMsgid, fail_type: 4 },
    });
    await pull(h, 'a2');
    await settle();
    await waitFor(async () => (await rowOf(failMsgid))?.status === 'failed', 3000);
    check(
      '工作台：回执 4 之后「没送达」（带原因码），库里那一段 failed',
      json(ledger.deliveryOf(sid, reply)) === json({ status: 'failed', failType: 4 }) && (await rowOf(failMsgid))?.status === 'failed',
    );
    const uid2 = 'wm08unk';
    const sid2 = sidOf('a2', uid2);
    h.fake.sendResult = (b) => (b.touser === uid2 ? 'network' : null);
    await talk('a2', uid2, '你好，想去云南');
    h.fake.sendResult = null;
    await settle();
    const r2 = await rowsOf(sid2);
    check(
      '工作台：超时与网络异常 →「可能没送达」，库里 unknown、同一 msgid 重试了 3 次',
      ledger.deliveryOf(sid2, lastAi(sid2)!)?.status === 'unknown' &&
        r2.length > 0 &&
        r2.every((x) => x.status === 'unknown' && x.attempts === 3),
      json(r2),
    );
  }

  // ---- 同步校验没过：这一组什么都没排、不发，会话加一条说明 ----
  {
    const uid = 'wm08bad';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    await settle();
    const n0 = h.sentTo(uid).length;
    const r0 = (await rowsOf(sid)).length;
    const ok = await h.wecom.wecomAdapter.push(sid, `a${String.fromCharCode(0)}b`, { kind: 'notice' });
    await settle();
    check(
      '校验没过（正文带 NUL）：不发、不落任何出站行，会话加一条说明',
      !ok &&
        h.sentTo(uid).length === n0 &&
        (await rowsOf(sid)).length === r0 &&
        !!getSession(sid)?.messages.some((m) => m.role === 'system' && m.content.includes('没有排进发送')),
    );
  }

  h.fake.beforeSend = null;
  ledger.__ledgerTest.setWaits(null);
}

// ======================================================================================
// in / rin：入站 channel_inbox 与状态机（03 第 9 步；spec「入站：channel_inbox」，R2、R3、R7 的恢复截止、R21，不变量 1、2、3、8、11、12，
// 验收 3、9 不含杀进程的部分）。事务边界靠测试触发器看：wsa09_txlog 记每次写入所在事务的 txid（入站行、消息、出站行、同意记录、cursor），
// wsa09_flags 让插入入站或推进 cursor 在提交之前失败。触发器函数以超级用户 SECURITY DEFINER 建，agent_app 写业务表时顺带记下。
// 杀进程的部分（提交之后立刻 SIGKILL、毒消息把进程带崩三次）在第 10 步；这里「重启之后的派发」用 __wecomTest.dispatchOpen 模拟
// （重新 load、把没结束的行按 ord 派发，即第 10 步对 received 行要做的那一部分）
// ======================================================================================

/** 测试触发器（函数声明：文件开头的顶层 await 先于这里的 const 初始化就要用到） */
function inboxTestSql(): string[] {
  return [
    `create table if not exists wsa09_txlog (n bigserial primary key, tbl text not null, k text, k2 text, seq int, txid bigint not null)`,
    `create table if not exists wsa09_flags (k text primary key)`,
    `create or replace function wsa09_log() returns trigger language plpgsql security definer set search_path = public as $$
   begin
     if TG_TABLE_NAME = 'channel_inbox' then
       insert into wsa09_txlog (tbl, k, k2, seq, txid) values ('inbox', NEW.id::text, NEW.state, NEW.message_seq, txid_current());
     elsif TG_TABLE_NAME = 'messages' then
       insert into wsa09_txlog (tbl, k, k2, seq, txid) values ('message', NEW.msgid, NEW.conversation_id, NEW.seq, txid_current());
     elsif TG_TABLE_NAME = 'outbound_sends' then
       insert into wsa09_txlog (tbl, k, k2, seq, txid)
         values ('outbound', NEW.channel_msgid, NEW.status || ':' || coalesce(NEW.inbox_id::text, ''), NEW.message_seq, txid_current());
     elsif TG_TABLE_NAME = 'consents' then
       insert into wsa09_txlog (tbl, k, k2, seq, txid) values ('consent', NEW.conversation_id, NEW.decision, null, txid_current());
     elsif TG_TABLE_NAME = 'channel_accounts' then
       if NEW.cursor is distinct from OLD.cursor then
         insert into wsa09_txlog (tbl, k, k2, seq, txid) values ('cursor', NEW.key, NEW.cursor, null, txid_current());
       end if;
     end if;
     return null;
   end $$`,
    `create trigger wsa09_log_inbox after insert or update on channel_inbox for each row execute function wsa09_log()`,
    `create trigger wsa09_log_messages after insert on messages for each row execute function wsa09_log()`,
    `create trigger wsa09_log_outbound after insert or update on outbound_sends for each row execute function wsa09_log()`,
    `create trigger wsa09_log_consents after insert on consents for each row execute function wsa09_log()`,
    `create trigger wsa09_log_cursor after update on channel_accounts for each row execute function wsa09_log()`,
    // 条件分开写：plpgsql 不保证 and 短路，channel_inbox 的行上引用 NEW.cursor 会报 42703
    `create or replace function wsa09_fail() returns trigger language plpgsql security definer set search_path = public as $$
     begin
       if TG_TABLE_NAME = 'channel_inbox' then
         if TG_OP = 'INSERT' then
           if exists (select 1 from wsa09_flags where k = 'fail_insert') then
             raise exception 'wsa09: 插入入站失败（自测）';
           end if;
         elsif NEW.attempts is distinct from OLD.attempts then
           if exists (select 1 from wsa09_flags where k = 'fail_attempt:' || NEW.msgid) then
             raise exception 'wsa09: 计次失败（自测）';
           end if;
         end if;
       elsif NEW.cursor is distinct from OLD.cursor then
         if exists (select 1 from wsa09_flags where k = 'fail_cursor') then
           raise exception 'wsa09: 推进 cursor 失败（自测）';
         end if;
       end if;
       return NEW;
     end $$`,
    `create trigger wsa09_fail_inbox before insert on channel_inbox for each row execute function wsa09_fail()`,
    `create trigger wsa09_fail_cursor before update on channel_accounts for each row execute function wsa09_fail()`,
    `create trigger wsa09_fail_attempt before update on channel_inbox for each row execute function wsa09_fail()`,
    // 把一次会话落库拖长（只在真实 PG 上用得到：PGlite 只有一条连接，事务本来就一个接一个）：这个会话的出站 pending 插入之后、
    // 入站 replied 之后各睡 4 秒（每条语句都在 agent_app 的 5 秒语句超时之内，一个事务里各只睡一次），pending 已插入、没提交的
    // 时间就有 8 秒。表分开判：plpgsql 不保证 and 短路
    `create or replace function wsa09_slow() returns trigger language plpgsql security definer set search_path = public as $$
     begin
       if not exists (select 1 from wsa09_flags where k = 'slow:' || NEW.conversation_id) then
         return null;
       end if;
       if TG_TABLE_NAME = 'outbound_sends' then
         if NEW.status = 'pending' and coalesce(current_setting('wsa09.slept_out', true), '') = '' then
           perform set_config('wsa09.slept_out', '1', true);
           perform pg_sleep(4);
         end if;
       elsif NEW.state = 'replied' and coalesce(current_setting('wsa09.slept_in', true), '') = '' then
         perform set_config('wsa09.slept_in', '1', true);
         perform pg_sleep(4);
       end if;
       return null;
     end $$`,
    `create trigger wsa09_slow_outbound after insert on outbound_sends for each row execute function wsa09_slow()`,
    `create trigger wsa09_slow_inbox after update on channel_inbox for each row execute function wsa09_slow()`,
  ];
}

async function inboxSuite(h: Harness): Promise<void> {
  const ledger = await import('../quota/ledger.js');
  const tk = await import('../handoff/takeover.js');
  const { __privacyTest } = await import('../privacy/privacy.js');
  const { CONSENT_DECLINED_REPLY } = await import('../handoff/consent.js');
  const { onInboxAbandoned } = await import('../channels/inbox.js');
  const { startAlerts } = await import('../ops/alert.js');
  startAlerts(); // 告警没配地址时只写一行日志，从日志里看 channel 那一条
  ledger.__ledgerTest.setWaits({ commitMs: 700, markMs: 700 });
  const { getSession } = h.store;
  const seqOf = h.store.seqOf;
  const idOf = (k: string): string => h.ids.get(k)!;
  const sidOf = (k: string, uid: string): string => acct(k).prefix + uid;
  interface InRow {
    id: string;
    ord: string;
    msgid: string;
    kind: string;
    state: string;
    reason: string | null;
    attempts: number;
    message_seq: number | null;
    nopay: boolean;
  }
  const IN_COLS = 'id::text as id, ord::text as ord, msgid, kind, state, reason, attempts, message_seq, payload is null as nopay';
  const inboxOfConv = (sid: string): Promise<InRow[]> =>
    h.su<InRow>(`select ${IN_COLS} from channel_inbox where conversation_id = $1 order by ord`, [sid]);
  const inboxByMsgid = async (msgid: string): Promise<InRow | null> =>
    (await h.su<InRow>(`select ${IN_COLS} from channel_inbox where msgid = $1`, [msgid]))[0] ?? null;
  interface TxRec {
    n: string;
    tbl: string;
    k: string | null;
    k2: string | null;
    seq: number | null;
    txid: string;
  }
  const txlog = (): Promise<TxRec[]> =>
    h.su<TxRec>('select n::text as n, tbl, k, k2, seq, txid::text as txid from wsa09_txlog order by wsa09_txlog.n');
  const flag = async (k: string, on: boolean): Promise<void> => {
    if (on) await h.su('insert into wsa09_flags (k) values ($1) on conflict do nothing', [k]);
    else await h.su('delete from wsa09_flags where k = $1', [k]);
  };
  const outOfInbox = (inboxId: string): Promise<{ msgid: string; status: string }[]> =>
    h.su(`select channel_msgid as msgid, status from outbound_sends where inbox_id = $1 order by segment`, [inboxId]);
  const settle = async (): Promise<void> => {
    await h.idle();
    for (let i = 0; i < 3; i++) {
      await sleep(20);
      await h.store.drainStore(5000);
    }
  };
  const talk = async (k: string, uid: string, text: string): Promise<FakeMsg> => {
    const m = h.say(acct(k).kf, uid, text);
    await pull(h, k);
    await settle();
    return m;
  };
  const customerMsgids = (sid: string): string[] =>
    (getSession(sid)?.messages ?? []).filter((m) => m.role === 'customer').map((m) => m.msgid ?? '');
  /** 直接往库里放一行没结束的入站（模拟上一个进程留下的），payload 是企微原样的文本消息 */
  const putOpen = async (k: string, uid: string, msgid: string, text: string, attempts: number, sentAt = Date.now()): Promise<string> => {
    const payload: FakeMsg = {
      msgid,
      open_kfid: acct(k).kf,
      external_userid: uid,
      send_time: Math.floor(sentAt / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content: text },
    };
    const [r] = await h.su<{ id: string }>(
      `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, sent_at, state, attempts, payload)
       values ($1, $2, $3, 'message', $4, $5, 'received', $6, $7::json) returning id::text as id`,
      [h.tenantId, idOf(k), msgid, sidOf(k, uid), new Date(sentAt), attempts, JSON.stringify(payload)],
    );
    return r!.id;
  };
  const abandoned: { reason: string; account: string; noted?: boolean }[] = [];
  onInboxAbandoned((e) => void abandoned.push(e));
  const alertLines = (from: number): string[] => logsSince(from).filter((l) => l.includes('[alert]') && l.includes('AI 没有处理'));

  await waitFor(() => ['a1', 'a2', 'b1'].every((k) => h.fake.syncs.some((s) => s.kfAcct === k)));
  await settle();
  check(
    '库里的账号：拉取状态在 channel_inbox，没有内存里的 handled 与在途表；a1 是冷启动，b1 接着库里的 cursor',
    ['a1', 'a2', 'b1'].every((k) => {
      const i = h.wecom.__wecomTest.inspect(idOf(k));
      return i?.backend === 'channel_inbox' && i.handled.length === 0 && i.inflight.length === 0;
    }) &&
      h.wecom.__wecomTest.inspect(idOf('a1'))?.coldStart === true &&
      h.wecom.__wecomTest.inspect(idOf('b1'))?.coldStart === false,
    json(['a1', 'b1'].map((k) => h.wecom.__wecomTest.inspect(idOf(k)))),
  );

  // ---- 验收 3：一页的提交与回滚（事务在提交之前失败：插入入站失败、推进 cursor 失败两种）、ord、cursor 与入站同一事务 ----
  const page: FakeMsg[] = [];
  {
    const uid = 'wm09page';
    const sid = sidOf('a2', uid);
    page.push(h.say(acct('a2').kf, uid, '你好'), h.say(acct('a2').kf, uid, '想去云南'), h.say(acct('a2').kf, uid, '两个人'));
    const ids = page.map((m) => m.msgid);
    const c0 = (await h.cursors()).a2;
    for (const f of ['fail_insert', 'fail_cursor']) {
      await flag(f, true);
      const from = logBuf.length;
      await pull(h, 'a2');
      await flag(f, false);
      const [cnt] = await h.su<{ n: number }>('select count(*)::int as n from channel_inbox where msgid = any($1)', [ids]);
      check(
        `一页的事务在提交之前失败（${f === 'fail_insert' ? '插入入站' : '推进 cursor'}）：cursor 不变、channel_inbox 里没有这 3 行、没有派发`,
        (await h.cursors()).a2 === c0 &&
          h.wecom.__wecomTest.inspect(idOf('a2'))?.cursor === c0 &&
          cnt!.n === 0 &&
          h.sentTo(uid).length === 0 &&
          !getSession(sid) &&
          logsSince(from).some((l) => l.includes('这一页入站没写进库')),
        json({ c0, cursor: (await h.cursors()).a2, cnt, sent: h.sentTo(uid).length }),
      );
    }
    await pull(h, 'a2');
    await settle();
    const rows = await inboxOfConv(sid);
    check(
      '下一次拉取拿到同样 3 条、各处理一次：3 行 message、done、attempts 1、payload 已空；会话里这 3 句各记一次',
      rows.length === 3 &&
        rows.every((r) => r.kind === 'message' && r.state === 'done' && r.attempts === 1 && r.nopay && r.reason === null) &&
        json(customerMsgids(sid)) === json(ids),
      json({ rows, said: customerMsgids(sid) }),
    );
    check(
      'ord 按页内顺序递增（同一页的 received_at 相同、send_time 只到秒，排先后靠它）',
      json(rows.map((r) => r.msgid)) === json(ids) && rows.every((r, i) => i === 0 || BigInt(r.ord) > BigInt(rows[i - 1]!.ord)),
      json(rows.map((r) => [r.msgid, r.ord])),
    );
    const outs = await Promise.all(rows.map((r) => outOfInbox(r.id)));
    check(
      '每一句各回复一组（出站行挂着这条入站、都 accepted），假企微上的分段恰好是这几组',
      outs.every((o) => o.length >= 1 && o.every((x) => x.status === 'accepted')) &&
        h.sentTo(uid).length === outs.flat().length &&
        h.sentTo(uid).every((x) => outs.flat().some((o) => o.msgid === x.msgid)),
      json({ outs, sent: h.sentTo(uid).map((x) => x.msgid) }),
    );
    const log = await txlog();
    const ins = rows.map((r) => log.find((x) => x.tbl === 'inbox' && x.k === r.id && x.k2 === 'received'));
    const cur = log.filter((x) => x.tbl === 'cursor' && x.k === 'a2' && x.k2 === `${acct('a2').kf}:3`);
    check(
      '这一页的 3 行入站与 cursor 推进是同一个事务（不变量 1）',
      ins.every((x) => !!x) && cur.length === 1 && ins.every((x) => x!.txid === cur[0]!.txid),
      json({ ins, cur }),
    );
    for (const [i, r] of rows.entries()) {
      const msg = log.find((x) => x.tbl === 'message' && x.k === r.msgid);
      const rec = log.find((x) => x.tbl === 'inbox' && x.k === r.id && x.k2 === 'recorded');
      const rep = log.find((x) => x.tbl === 'inbox' && x.k === r.id && x.k2 === 'replied');
      const pend = log.filter((x) => x.tbl === 'outbound' && x.k2 === `pending:${r.id}`);
      check(
        `第 ${i + 1} 句：recorded 与这条客户消息同一个事务、message_seq 是它的 seq；replied 与回复的 pending 同一个事务（不变量 3）`,
        !!msg &&
          !!rec &&
          rec.txid === msg.txid &&
          rec.seq === msg.seq &&
          r.message_seq === msg.seq &&
          !!rep &&
          pend.length >= 1 &&
          pend.every((p) => p.txid === rep.txid) &&
          BigInt(rec.n) < BigInt(rep.n),
        json({ msg, rec, rep, pend }),
      );
    }
    // 同一个 msgid 又出现在后面一页（企微重推、cursor 重拉）：冲突即跳过，不派发、会话里不记第二遍（不变量 2）
    const n0 = h.sentTo(uid).length;
    h.fake.logs.get(acct('a2').kf)!.push(page[1]!);
    await pull(h, 'a2');
    await settle();
    const [dup] = await h.su<{ n: number }>('select count(*)::int as n from channel_inbox where msgid = $1', [page[1]!.msgid]);
    check(
      '同一个 msgid 再拉到一次：channel_inbox 里仍只有一行、不再处理（会话里不记第二遍、不再回复）',
      dup!.n === 1 && json(customerMsgids(sid)) === json(ids) && h.sentTo(uid).length === n0,
      json({ dup, said: customerMsgids(sid), sent: h.sentTo(uid).length - n0 }),
    );
  }

  // ---- 出队计次：同一客户一页两句，第一句处理途中第二句还排在后面（不计次）；之后各 1 ----
  {
    const uid = 'wm09cnt';
    const sid = sidOf('a1', uid);
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    let hung = false;
    const prev = h.fake.beforeSend;
    h.fake.beforeSend = async (b) => {
      await prev?.(b);
      if (b.touser === uid && !hung) {
        hung = true;
        await hang;
      }
    };
    const m1 = h.say(acct('a1').kf, uid, '你好');
    const m2 = h.say(acct('a1').kf, uid, '想去西藏');
    void h.wecom.syncAccountFromCallback(idOf('a1'), `cnt-${Date.now()}`);
    await waitFor(() => hung, 10_000);
    const r1 = await inboxByMsgid(m1.msgid);
    const r2 = await inboxByMsgid(m2.msgid);
    check(
      '第一句处理途中（回复挂在发送上）：第一句已出队、attempts 1、replied；第二句排在后面从没开始处理：attempts 0、received（不变量 11）',
      hung && r1?.attempts === 1 && r1.state === 'replied' && r2?.attempts === 0 && r2.state === 'received',
      json({ r1, r2 }),
    );
    release();
    await settle();
    h.fake.beforeSend = prev;
    const rows = await inboxOfConv(sid);
    const sent = h.sentTo(uid);
    const out1 = await outOfInbox(r1!.id);
    const out2 = await outOfInbox(r2!.id);
    check(
      '第一句处理完才轮到第二句：两句各 attempts 1、done；回复按顺序发出（第一句那组在前）',
      rows.length === 2 &&
        rows.every((r) => r.attempts === 1 && r.state === 'done') &&
        out1.length >= 1 &&
        out2.length >= 1 &&
        sent.findIndex((x) => x.msgid === out1[0]!.msgid) < sent.findIndex((x) => x.msgid === out2[0]!.msgid) &&
        json(customerMsgids(sid)) === json([m1.msgid, m2.msgid]),
      json({ rows, out1, out2, sent: sent.map((x) => x.msgid) }),
    );
  }
  {
    // 模拟重启之后的派发：上一个进程停在第一句（已计过 1 次）、第二句从没开始（0 次）。按 ord 重新派发：第一句 2、第二句 1，各回复一次
    const uid = 'wm09rst';
    const sid = sidOf('a1', uid);
    const head = await putOpen('a1', uid, 'm09rst-1', '你好，想去云南', 1);
    const tail = await putOpen('a1', uid, 'm09rst-2', '两个人，五天', 0);
    const n = await h.wecom.__wecomTest.dispatchOpen(idOf('a1'));
    await settle();
    const rows = await inboxOfConv(sid);
    const outH = await outOfInbox(head);
    const outT = await outOfInbox(tail);
    check(
      '重新派发没结束的行（第 10 步对 received 行的做法）：按 ord，第一句 attempts 2、第二句 1，都 done、各回复一组，会话里按顺序各记一次',
      n === 2 &&
        json(rows.map((r) => [r.msgid, r.attempts, r.state])) ===
          json([
            ['m09rst-1', 2, 'done'],
            ['m09rst-2', 1, 'done'],
          ]) &&
        outH.length >= 1 &&
        outT.length >= 1 &&
        json(customerMsgids(sid)) === json(['m09rst-1', 'm09rst-2']),
      json({ n, rows, outH, outT, said: customerMsgids(sid) }),
    );
  }

  // ---- 验收 9：毒消息（出队时 attempts 已到 3）：abandoned（poison）、会话加说明、告警；排在它后面的第二句不受连累 ----
  {
    const uid = 'wm09poi';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '你好');
    const n0 = h.sentTo(uid).length;
    const from = logBuf.length;
    const a0 = abandoned.length;
    const poison = await putOpen('a1', uid, 'm09poi-1', '每次都把进程带崩的一句', 3);
    const next = await putOpen('a1', uid, 'm09poi-2', '想去西藏', 0);
    await h.wecom.__wecomTest.dispatchOpen(idOf('a1'));
    await settle();
    const p = await inboxByMsgid('m09poi-1');
    const q = await inboxByMsgid('m09poi-2');
    const note = getSession(sid)?.messages.find((m) => m.role === 'system' && m.content.includes('AI 未能处理'));
    check(
      'poison：出队时 attempts 已是 3 → abandoned（poison）、payload 已空、不再计次；不调模型、不发送、这句不记进会话',
      p?.state === 'abandoned' &&
        p.reason === 'poison' &&
        p.nopay &&
        p.attempts === 3 &&
        (await outOfInbox(poison)).length === 0 &&
        !customerMsgids(sid).includes('m09poi-1'),
      json(p),
    );
    check(
      'poison：会话多一条说明（02 的同一句），与 abandoned 同一次落库',
      note?.content === '⚠️ 客户有一条消息 AI 未能处理（已重放 2 次仍未处理完），请人工回复' &&
        (await (async () => {
          const log = await txlog();
          const ab = log.find((x) => x.tbl === 'inbox' && x.k === poison && x.k2 === 'abandoned');
          const nm = log.find((x) => x.tbl === 'message' && x.k2 === sid && x.seq === seqOf(note));
          return !!ab && !!nm && ab.txid === nm.txid;
        })()),
      json(note),
    );
    check(
      'poison：告警（channel）一条，只有账号 key 与原因',
      abandoned.slice(a0).some((e) => e.reason === 'poison' && e.account === 'a1') &&
        alertLines(from).some((l) => l.includes('企微账号 a1 有 1 条客户消息 AI 没有处理（处理了三次都没走完') && !l.includes(uid)),
      json(alertLines(from)),
    );
    check(
      'poison：排在它后面、同一客户的第二句不受连累：attempts 1、done、回复一组、记进会话',
      q?.state === 'done' &&
        q.attempts === 1 &&
        (await outOfInbox(next)).length >= 1 &&
        h.sentTo(uid).length > n0 &&
        customerMsgids(sid).includes('m09poi-2'),
      json(q),
    );
    // 没建出会话的毒消息：入站行单独一个短事务记 abandoned，不为它建会话
    const lone = await putOpen('a1', 'wm09poi2', 'm09poi-3', '你好', 3);
    await h.wecom.__wecomTest.dispatchOpen(idOf('a1'));
    await settle();
    const l = await inboxByMsgid('m09poi-3');
    check(
      'poison、没有会话：入站行单独记 abandoned（poison），不建会话、不发送',
      l?.state === 'abandoned' && l.reason === 'poison' && !getSession(sidOf('a1', 'wm09poi2')) && (await outOfInbox(lone)).length === 0,
      json(l),
    );
  }

  // ---- 验收 9：sent_at 早于 48 小时（b1 不是冷启动）：出队时 abandoned（too_old），不调模型、不计次；会话加说明、告警 ----
  {
    const uid = 'wm09old';
    const sid = sidOf('b1', uid);
    await talk('b1', uid, '你好');
    const n0 = h.sentTo(uid).length;
    const from = logBuf.length;
    const modelEnv = ['LLM_MOCK', 'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_MODEL_CHEAP', 'LLM_HEDGE_MODEL'];
    const savedModelEnv = Object.fromEntries(modelEnv.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      LLM_MOCK: '0',
      LLM_PROVIDER: '',
      LLM_BASE_URL: 'https://llm.selftest.invalid/v1',
      LLM_API_KEY: 'selftest-fake-key',
      LLM_MODEL: 'selftest-fake',
      LLM_MODEL_CHEAP: 'selftest-fake',
      LLM_HEDGE_MODEL: '',
    });
    let modelCalls = 0;
    h.fake.onLlm = () => {
      modelCalls += 1;
    };
    const old = h.emit(acct('b1').kf, {
      external_userid: uid,
      origin: 3,
      msgtype: 'text',
      text: { content: '两天前的一句' },
      send_time: Math.floor((Date.now() - 49 * 3_600_000) / 1000),
    });
    const fresh = h.emit(acct('b1').kf, {
      external_userid: 'wm09old2',
      origin: 3,
      msgtype: 'text',
      text: { content: '两天前的一句' },
      send_time: Math.floor((Date.now() - 49 * 3_600_000) / 1000),
    });
    await pull(h, 'b1');
    await settle();
    check('too_old：模型调用计数为 0（关闭 mock、假模型请求直接计数）', modelCalls === 0);
    h.fake.onLlm = null;
    for (const [k, v] of Object.entries(savedModelEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const r = await inboxByMsgid(old.msgid);
    const r2 = await inboxByMsgid(fresh.msgid);
    check(
      'too_old：插入时 received，出队时 abandoned（too_old）、attempts 0、payload 已空；不调模型、不发送、这句不记进会话',
      r?.state === 'abandoned' &&
        r.reason === 'too_old' &&
        r.attempts === 0 &&
        r.nopay &&
        h.sentTo(uid).length === n0 &&
        !customerMsgids(sid).includes(old.msgid) &&
        getSession(sid)!.messages.at(-1)?.content === '⚠️ 客户有一条消息 AI 未能处理（已超过 48h 发送窗口），请人工回复',
      json({ r, last: getSession(sid)?.messages.at(-1) }),
    );
    check(
      'too_old：告警一条；没有会话的那一句单独记 abandoned、不建会话',
      alertLines(from).some((l) => l.includes('企微账号 b1') && l.includes('已超过 48 小时')) &&
        r2?.state === 'abandoned' &&
        r2.reason === 'too_old' &&
        !getSession(sidOf('b1', 'wm09old2')),
      json({ alerts: alertLines(from), r2 }),
    );
  }

  // ---- 冷启动（a1 启动时库里没有 cursor）：启动前 10 分钟之前的直接记 abandoned（cold_start），不派发 ----
  {
    const uid = 'wm09cold';
    const m = h.emit(acct('a1').kf, {
      external_userid: uid,
      origin: 3,
      msgtype: 'text',
      text: { content: '一小时前的一句' },
      send_time: Math.floor((Date.now() - 3_600_000) / 1000),
    });
    await pull(h, 'a1');
    await settle();
    const r = await inboxByMsgid(m.msgid);
    check(
      '冷启动：早于截止的插成 abandoned（cold_start）、payload 空、attempts 0；不派发、不建会话、不发送',
      r?.state === 'abandoned' &&
        r.reason === 'cold_start' &&
        r.nopay &&
        r.attempts === 0 &&
        !getSession(sidOf('a1', uid)) &&
        h.sentTo(uid).length === 0,
      json(r),
    );
  }

  // ---- 恢复截止点（R7、不变量 9）：sent_at 不晚于 record_only_until 的只补记、不调模型、不发送；之后的照常 ----
  {
    __privacyTest.set({ version: 1, body: 'x' });
    const uid = 'wm09ro';
    const sid = sidOf('b1', uid);
    const cutoff = Date.now() - 3_600_000;
    await h.su('update channel_accounts set record_only_until = $1 where id = $2', [new Date(cutoff), idOf('b1')]);
    await h.wecom.__wecomTest.dispatchOpen(idOf('b1')); // 重新 load：读到恢复截止点（第 12 步的命令要求应用已停，这里直接重读）
    const before = Math.floor((cutoff - 3_600_000) / 1000);
    const t1 = h.emit(acct('b1').kf, {
      external_userid: uid,
      origin: 3,
      msgtype: 'text',
      text: { content: '备份之后说的一句' },
      send_time: before,
    });
    const t2 = h.emit(acct('b1').kf, { external_userid: uid, origin: 3, msgtype: 'image', send_time: before });
    const t3 = h.emit(acct('b1').kf, {
      external_userid: uid,
      origin: 3,
      msgtype: 'text',
      text: { content: '不同意', menu_id: 'health:declined' },
      send_time: before,
    });
    const t4 = h.say(acct('b1').kf, uid, '现在再问一句');
    await pull(h, 'b1');
    await settle();
    const rows = await Promise.all([t1, t2, t3, t4].map((m) => inboxByMsgid(m.msgid)));
    const s = getSession(sid);
    const notes = (s?.messages ?? []).filter((m) => m.role === 'system' && m.content.startsWith('恢复备份之后补记的客户消息'));
    check(
      `恢复截止点之前的三条（文本、图片、菜单点击）：abandoned（restore_cutoff）、attempts 0、payload 空、没有出站行${h.wecom.__wecomTest.inspect(idOf('b1'))?.recordOnlyUntil === cutoff ? '' : '（恢复截止点没读到）'}`,
      rows.slice(0, 3).every((r) => r?.state === 'abandoned' && r.reason === 'restore_cutoff' && r.attempts === 0 && r.nopay) &&
        (await Promise.all(rows.slice(0, 3).map((r) => outOfInbox(r!.id)))).every((o) => o.length === 0),
      json(rows),
    );
    check(
      '恢复截止点：文本与图片照常写进会话（图片是占位），菜单点击不补记、同意记录不变；会话只加一条说明（spec 原话）',
      !!s &&
        s.messages.some((m) => m.msgid === t1.msgid && m.content === '备份之后说的一句') &&
        s.messages.some((m) => m.msgid === t2.msgid && m.content === '[图片]') &&
        !s.messages.some((m) => m.msgid === t3.msgid) &&
        notes.length === 1 &&
        notes[0]!.content === '恢复备份之后补记的客户消息，AI 没有回复：备份之后的处理记录已丢失，请人工确认是否已回复' &&
        (await h.su(`select 1 from consents where conversation_id = $1 and decision = 'declined'`, [sid])).length === 0,
      json(s?.messages.map((m) => [m.role, m.content.slice(0, 20)])),
    );
    const o4 = await outOfInbox(rows[3]!.id);
    check(
      '恢复截止点之后的那一句照常处理：done、attempts 1、回复一组（假企微上只有这一组）',
      rows[3]?.state === 'done' && rows[3].attempts === 1 && o4.length >= 1 && h.sentTo(uid).length === o4.length,
      json({ r: rows[3], o4, sent: h.sentTo(uid).length }),
    );
    await h.su('update channel_accounts set record_only_until = null where id = $1', [idOf('b1')]);
    await h.wecom.__wecomTest.dispatchOpen(idOf('b1'));
    __privacyTest.reset();
  }

  // ---- 恢复截止点比现在晚几分钟（--until 允许 5 分钟钟差；第 12 步评审）：同一会话两句只补记，说明只加一条、告警只计一个会话 ----
  {
    const uid = 'wm12fut';
    const sid = sidOf('b1', uid);
    const cutoff = Date.now() + 4 * 60_000;
    await h.su('update channel_accounts set record_only_until = $1 where id = $2', [new Date(cutoff), idOf('b1')]);
    await h.wecom.__wecomTest.dispatchOpen(idOf('b1'));
    const a0 = abandoned.length;
    const f1 = h.say(acct('b1').kf, uid, '截止点之前的第一句');
    const f2 = h.say(acct('b1').kf, uid, '截止点之前的第二句');
    await pull(h, 'b1');
    await settle();
    const rows = await Promise.all([f1, f2].map((m) => inboxByMsgid(m.msgid)));
    const notes = (getSession(sid)?.messages ?? []).filter(
      (m) => m.role === 'system' && m.content.startsWith('恢复备份之后补记的客户消息'),
    );
    const ev = abandoned.slice(a0).filter((e) => e.reason === 'restore_cutoff');
    check(
      '恢复截止点比现在晚：两句都只补记（restore_cutoff），说明只加一条（按截止点认，不按写入时间），只有一次事件带 noted',
      rows.every((r) => r?.state === 'abandoned' && r.reason === 'restore_cutoff') &&
        notes.length === 1 &&
        (notes[0] as { restoreCutoff?: number }).restoreCutoff === cutoff &&
        ev.length === 2 &&
        ev.filter((e) => e.noted).length === 1 &&
        h.sentTo(uid).length === 0,
      json({ rows, notes, ev, sent: h.sentTo(uid).length }),
    );
    await h.su('update channel_accounts set record_only_until = null where id = $1', [idOf('b1')]);
    await h.wecom.__wecomTest.dispatchOpen(idOf('b1'));
  }

  // ---- 四种入站：非文本（占位与 recorded 同一次落库，引导提示同样走 planOutbound：先 recorded 再 replied）----
  let hintMsgid = '';
  {
    const uid = 'wm09img';
    const sid = sidOf('a1', uid);
    const m = h.emit(acct('a1').kf, { external_userid: uid, origin: 3, msgtype: 'image' });
    await pull(h, 'a1');
    await settle();
    const r = await inboxByMsgid(m.msgid);
    const ph = getSession(sid)?.messages.find((x) => x.msgid === m.msgid);
    const log = await txlog();
    const rec = log.find((x) => x.tbl === 'inbox' && x.k === r?.id && x.k2 === 'recorded');
    const rep = log.find((x) => x.tbl === 'inbox' && x.k === r?.id && x.k2 === 'replied');
    const msg = log.find((x) => x.tbl === 'message' && x.k === m.msgid);
    const pend = log.filter((x) => x.tbl === 'outbound' && x.k2 === `pending:${r?.id}`);
    const out = await outOfInbox(r!.id);
    hintMsgid = out[0]?.msgid ?? '';
    check(
      '非文本：占位记进会话、入站 done、attempts 1；引导提示发出一组（挂着这条入站）',
      r?.state === 'done' && r.attempts === 1 && ph?.content === '[图片]' && out.length === 1 && h.sentTo(uid).length === 1,
      json({ r, ph, out }),
    );
    check(
      '非文本：占位、recorded（message_seq 是占位的 seq）、引导提示的 pending、replied 都在同一个事务里，先 recorded 再 replied',
      !!rec &&
        !!rep &&
        !!msg &&
        rec.txid === msg.txid &&
        rec.seq === seqOf(ph!) &&
        rep.txid === rec.txid &&
        pend.length === 1 &&
        pend[0]!.txid === rec.txid &&
        BigInt(rec.n) < BigInt(rep.n),
      json({ rec, rep, msg, pend }),
    );
    // 已转人工：只记占位、不回（done）
    const uid2 = 'wm09imgh';
    const sid2 = sidOf('a1', uid2);
    await talk('a1', uid2, '你好');
    tk.takeover(sid2, tk.sharedActor());
    const n0 = h.sentTo(uid2).length;
    const m2 = h.emit(acct('a1').kf, { external_userid: uid2, origin: 3, msgtype: 'voice' });
    await pull(h, 'a1');
    await settle();
    const r2 = await inboxByMsgid(m2.msgid);
    check(
      '非文本、已转人工：占位记进会话、不回（静默）、入站 done',
      r2?.state === 'done' &&
        h.sentTo(uid2).length === n0 &&
        !!getSession(sid2)?.messages.some((x) => x.msgid === m2.msgid && x.content === '[语音]'),
      json(r2),
    );
  }

  // ---- 四种入站：菜单点击（applyConsentDecision 改了会话，同一次落库记 done）；已有结论的点击照 02 忽略、同样 done ----
  {
    __privacyTest.set({ version: 1, body: 'x' });
    const uid = 'wm09menu';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '我妈有高血压，能去西藏吗');
    const n0 = h.sentTo(uid).length;
    const c1 = h.emit(acct('a1').kf, {
      external_userid: uid,
      origin: 3,
      msgtype: 'text',
      text: { content: '不同意', menu_id: 'health:declined' },
    });
    await pull(h, 'a1');
    await settle();
    const r = await inboxByMsgid(c1.msgid);
    const log = await txlog();
    const done = log.find((x) => x.tbl === 'inbox' && x.k === r?.id && x.k2 === 'done');
    const consent = log.find((x) => x.tbl === 'consent' && x.k === sid && x.k2 === 'declined');
    check(
      '菜单点击（不同意）：同意记录与入站 done 同一个事务；确认发出（通知，不挂入站）；点击本身不记进会话',
      r?.kind === 'menu_click' &&
        r.state === 'done' &&
        r.attempts === 1 &&
        !!done &&
        !!consent &&
        done.txid === consent.txid &&
        h.sentTo(uid).at(-1)?.content === CONSENT_DECLINED_REPLY &&
        (await outOfInbox(r.id)).length === 0 &&
        !customerMsgids(sid).includes(c1.msgid),
      json({ r, done, consent, sent: h.sentTo(uid).length - n0 }),
    );
    const n1 = h.sentTo(uid).length;
    const c2 = h.emit(acct('a1').kf, {
      external_userid: uid,
      origin: 3,
      msgtype: 'text',
      text: { content: '不同意', menu_id: 'health:declined' },
    });
    await pull(h, 'a1');
    await settle();
    const r2 = await inboxByMsgid(c2.msgid);
    check(
      '菜单点击（旧菜单再点一次同一个决定，这个类别已有这个结论）：照 02 忽略，入站同样 done，不发、不多记同意记录',
      r2?.state === 'done' &&
        h.sentTo(uid).length === n1 &&
        (await h.su(`select 1 from consents where conversation_id = $1 and decision = 'declined'`, [sid])).length === 1,
      json(r2),
    );
    __privacyTest.reset();
  }

  // ---- 四种入站：发送失败回执（出站 failed 与入站 done 同一个短事务；重复的回执不再加说明）----
  {
    const uid = 'wm09img';
    const sid = sidOf('a1', uid);
    const notes0 = (getSession(sid)?.messages ?? []).filter((m) => m.role === 'system').length;
    const f1 = h.emit(acct('a1').kf, {
      external_userid: uid,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'msg_send_fail', external_userid: uid, fail_msgid: hintMsgid, fail_type: 4 },
    });
    await pull(h, 'a1');
    await settle();
    const r = await inboxByMsgid(f1.msgid);
    const log = await txlog();
    const done = log.find((x) => x.tbl === 'inbox' && x.k === r?.id && x.k2 === 'done');
    const failed = log.find((x) => x.tbl === 'outbound' && x.k === hintMsgid && x.k2?.startsWith('failed:'));
    const [orow] = await h.su<{ status: string }>('select status from outbound_sends where channel_msgid = $1', [hintMsgid]);
    check(
      '回执：入站 send_fail（conversation_id 是会话、payload 只有 fail_msgid 与 fail_type）→ done；出站那一段 failed；两者同一个短事务',
      !!hintMsgid &&
        r?.kind === 'send_fail' &&
        r.state === 'done' &&
        orow?.status === 'failed' &&
        !!done &&
        !!failed &&
        done.txid === failed.txid,
      json({ r, done, failed, orow }),
    );
    const f2 = h.emit(acct('a1').kf, {
      external_userid: uid,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'msg_send_fail', external_userid: uid, fail_msgid: hintMsgid, fail_type: 4 },
    });
    await pull(h, 'a1');
    await settle();
    const r2 = await inboxByMsgid(f2.msgid);
    const notes = (getSession(sid)?.messages ?? []).filter((m) => m.role === 'system').length;
    check(
      '重复的回执（另一个 msgid、同一个 fail_msgid）：入站 done，会话里只多了第一次的那一条说明',
      r2?.state === 'done' && notes === notes0 + 1,
      json({ r2, notes, notes0 }),
    );
  }

  // ---- 四种入站：进入会话事件（acceptPage 里直接记 done，只为去重；欢迎语照 02）----
  {
    const uid = 'wm09ent';
    await talk('a1', uid, '你好');
    const n0 = h.sentTo(uid).length;
    const ev = h.emit(acct('a1').kf, {
      external_userid: uid,
      origin: 4,
      msgtype: 'event',
      event: { event_type: 'enter_session', external_userid: uid },
    });
    await pull(h, 'a1');
    await settle();
    const r = await inboxByMsgid(ev.msgid);
    const log = await txlog();
    check(
      '进入会话：插入时就是 done（attempts 0、payload 空、没经过 received），老客户的欢迎语照 02 发出',
      r?.kind === 'enter_session' &&
        r.state === 'done' &&
        r.attempts === 0 &&
        r.nopay &&
        log
          .filter((x) => x.tbl === 'inbox' && x.k === r.id)
          .map((x) => x.k2)
          .join() === 'done' &&
        h.sentTo(uid).length === n0 + 1,
      json(r),
    );
  }

  // ---- 静默（转人工之后）→ done；生成之后被接手打断（cancelled 也算有结果）→ done ----
  {
    const uid = 'wm09sil';
    const sid = sidOf('a1', uid);
    await talk('a1', uid, '我要人工');
    const n0 = h.sentTo(uid).length;
    const m = await talk('a1', uid, '在吗');
    const r = await inboxByMsgid(m.msgid);
    check(
      '转人工之后的消息：引擎静默，入站 done（记了 recorded，没有出站行），不发',
      r?.state === 'done' &&
        h.sentTo(uid).length === n0 &&
        (await outOfInbox(r.id)).length === 0 &&
        (await txlog()).some((x) => x.tbl === 'inbox' && x.k === r.id && x.k2 === 'recorded') &&
        customerMsgids(sid).includes(m.msgid),
      json(r),
    );
  }
  {
    const uid = 'wm09tk';
    const sid = sidOf('a1', uid);
    let fired = false;
    ledger.__ledgerTest.setMarkHook((intent) => {
      if (intent.sessionId !== sid || fired) return;
      fired = true;
      tk.takeover(sid, tk.sharedActor()); // markSending 期间顾问接手
    });
    const m = await talk('a1', uid, '你好，想去云南');
    ledger.__ledgerTest.setMarkHook(null);
    const r = await inboxByMsgid(m.msgid);
    const out = await outOfInbox(r!.id);
    check(
      '被接手打断：这一组 cancelled、零发送，入站 done（cancelled 也算有结果，那一组不会再发）',
      fired && h.sentTo(uid).length === 0 && out.length > 0 && out.every((x) => x.status === 'cancelled') && r?.state === 'done',
      json({ fired, out, r }),
    );
  }

  // ---- 状态机每一格（经会话落库的主事务与单独短事务两条路；表内的改了、表外的没改，终态行不报错、不让会话 poisoned）----
  {
    const uid = 'wm09sm';
    const sid = sidOf('b1', uid);
    const s = h.store.getOrCreateSession(sid, 'wecom');
    h.store.saveSession(s);
    await h.store.flushSession(sid);
    const FROM = ['received', 'recorded', 'replied', 'done', 'abandoned'] as const;
    const TO = ['recorded', 'replied', 'done', 'abandoned'] as const;
    // spec R3 的状态机，独立写一遍（不从 transitions.ts 取）：received → recorded → replied → done，任一步可到 abandoned；
    // 没有 received → replied 的直通格；同一状态不算迁移；done、abandoned 是终态
    const ALLOWED = new Set([
      'received>recorded',
      'received>done',
      'received>abandoned',
      'recorded>replied',
      'recorded>done',
      'recorded>abandoned',
      'replied>done',
      'replied>abandoned',
    ]);
    let k = 0;
    const put = async (from: string): Promise<string> => {
      k += 1;
      const [r] = await h.su<{ id: string }>(
        `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, state, reason, payload)
         values ($1, $2, $3, 'message', $4, $5, $6, $7::json) returning id::text as id`,
        [
          h.tenantId,
          idOf('b1'),
          `m09sm-${k}`,
          sid,
          from,
          from === 'abandoned' ? 'too_old' : null,
          from === 'done' || from === 'abandoned' ? null : '{}',
        ],
      );
      return r!.id;
    };
    const bad: string[] = [];
    for (const from of FROM) {
      for (const to of TO) {
        const want = ALLOWED.has(`${from}>${to}`) ? to : from;
        const viaQueue = await put(from);
        h.store.queueInboxState(sid, { inboxId: viaQueue, state: to, ...(to === 'abandoned' ? { reason: 'poison' as const } : {}) });
        await h.store.flushSession(sid);
        const [q] = await h.su<{ state: string; reason: string | null }>('select state, reason from channel_inbox where id = $1', [
          viaQueue,
        ]);
        if (q?.state !== want) bad.push(`落库 ${from}→${to}：${q?.state}`);
        if (to === 'done' || to === 'abandoned') {
          const viaNow = await put(from);
          const ok = await h.store.writeInboxStateNow({
            inboxId: viaNow,
            state: to,
            ...(to === 'abandoned' ? { reason: 'poison' as const } : {}),
          });
          const [n] = await h.su<{ state: string }>('select state from channel_inbox where id = $1', [viaNow]);
          if (!ok || n?.state !== want) bad.push(`短事务 ${from}→${to}：${ok} ${n?.state}`);
        }
      }
    }
    check(
      '入站状态机每一格（20 格经会话落库、10 格经短事务）：表内的改了、表外的没改；会话没有因为对终态行的写入 poisoned',
      bad.length === 0 && !h.store.storeHealth().poisoned.length && !h.store.storeLagging(sid),
      json(bad),
    );
    const q0 = h.store.__storeTest.pgQueuedInbox(sid);
    h.store.queueInboxState(sid, { inboxId: 'not-a-uuid', state: 'done' });
    h.store.queueInboxState(sid, { inboxId: randomUUID(), state: 'abandoned' });
    check('同步校验：inboxId 不是 uuid、abandoned 不带原因的不排进落库', h.store.__storeTest.pgQueuedInbox(sid) === q0);
    // 这些行只为测状态机（agent_app 没有 DELETE：以超级用户删掉，免得后面的派发看到）
    await h.su(`delete from channel_inbox where msgid like 'm09sm-%'`);
  }

  // ---- 第 9 步评审：停机时队头的计次没写进库，同一会话排在后面的不出队（不变量 12），整段留给重启恢复 ----
  {
    const uid = 'wm09halt';
    const sid = sidOf('a1', uid);
    await putOpen('a1', uid, 'm09halt-1', '你好，想去云南', 0);
    await putOpen('a1', uid, 'm09halt-2', '两个人，五天', 0);
    await flag('fail_attempt:m09halt-1', true); // 只让队头的计次失败：队尾要是出队，它的计次能写进去
    h.wecom.__wecomTest.setStopping(idOf('a1'), true);
    const from = logBuf.length;
    await h.wecom.__wecomTest.dispatchOpen(idOf('a1'));
    await settle();
    const hd = await inboxByMsgid('m09halt-1');
    const tl = await inboxByMsgid('m09halt-2');
    check(
      '停机中队头的计次没写进库：队头放下，同一会话排在后面的也不出队（都 received、attempts 0），不回复、不记进会话',
      hd?.state === 'received' &&
        hd.attempts === 0 &&
        tl?.state === 'received' &&
        tl.attempts === 0 &&
        h.sentTo(uid).length === 0 &&
        !getSession(sid) &&
        logsSince(from).some((l) => l.includes('同一会话排在后面的都留给下次启动')),
      json({ hd, tl, sent: h.sentTo(uid).length }),
    );
    await flag('fail_attempt:m09halt-1', false);
    h.wecom.__wecomTest.setStopping(idOf('a1'), false);
    await h.wecom.__wecomTest.dispatchOpen(idOf('a1')); // 模拟重启之后按 ord 重新派发
    await settle();
    const rows = await inboxOfConv(sid);
    check(
      '之后重新派发：按 ord 先队头后队尾，各 attempts 1、done，会话里按顺序各记一次',
      json(rows.map((r) => [r.msgid, r.attempts, r.state])) ===
        json([
          ['m09halt-1', 1, 'done'],
          ['m09halt-2', 1, 'done'],
        ]) && json(customerMsgids(sid)) === json(['m09halt-1', 'm09halt-2']),
      json({ rows, said: customerMsgids(sid) }),
    );
  }

  // ---- 第 9 步评审：计次的短事务提交了、回包丢了，重试不会再加一（同一次出队幂等；只有 PGlite 的夹具能造「提交后回包丢失」）----
  if (h.faults.releaseOnce !== undefined) {
    const uid = 'wm09ack';
    const sid = sidOf('a1', uid);
    await settle();
    const id = await putOpen('a1', uid, 'm09ack-1', '你好，想去云南', 0);
    const from = logBuf.length;
    h.faults.skipReleases = 1; // dispatchOpen 的 load 那一次放过，下一次（计次的短事务）提交之后回包丢失
    h.faults.releaseOnce = Object.assign(new Error('selftest: 提交之后回包丢了'), { code: '08006' });
    await h.wecom.__wecomTest.dispatchOpen(idOf('a1'));
    await waitFor(async () => (await inboxByMsgid('m09ack-1'))?.state === 'done', 15_000);
    await settle();
    const r = await inboxByMsgid('m09ack-1');
    check(
      '计次提交了而回包丢了：退避重试读回已加的值、不再加（attempts 1，不会提前攒成 poison），这一句照常处理一次',
      h.faults.releaseOnce === null &&
        logsSince(from).some((l) => l.includes('一行入站计次没写进库')) &&
        r?.attempts === 1 &&
        r.state === 'done' &&
        json(customerMsgids(sid)) === json(['m09ack-1']) &&
        (await outOfInbox(id)).length >= 1,
      json({ r, fault: h.faults.releaseOnce, said: customerMsgids(sid) }),
    );
  }

  // ---- 第 9 步评审：回执到的时候那一段的 pending 还在没提交的落库事务里（只在真实 PG 上造得出：PGlite 的事务一个接一个）----
  if (h.mode === 'rin') {
    const uid = 'wm09rcp';
    const sid = sidOf('a2', uid);
    await talk('a2', uid, '你好');
    await flag(`slow:${sid}`, true);
    let failMsgid: string | null = null;
    const prev = h.fake.beforeSend;
    h.fake.beforeSend = async (b) => {
      await prev?.(b);
      if (b.touser !== uid || failMsgid !== null) return;
      failMsgid = String(b.msgid);
      h.emit(acct('a2').kf, {
        external_userid: uid,
        origin: 4,
        msgtype: 'event',
        event: { event_type: 'msg_send_fail', external_userid: uid, fail_msgid: failMsgid, fail_type: 4 },
      });
      void h.wecom.syncAccountFromCallback(idOf('a2'), `rcp-${Date.now()}`);
      // 回执先处理（内存里这一段先记 failed），这次请求的回包才回来：晚到的结果改不了 failed、也不再补写
      await waitFor(() => ledger.__ledgerTest.rows(sid).some((x) => x.msgid === failMsgid && x.status === 'failed'), 10_000);
    };
    h.say(acct('a2').kf, uid, '想去云南看看');
    await pull(h, 'a2');
    await waitFor(
      async () =>
        (await h.su(`select 1 from channel_inbox where conversation_id = $1 and kind = 'send_fail' and state = 'done'`, [sid])).length ===
        1,
      30_000,
    );
    await settle();
    h.fake.beforeSend = prev;
    await flag(`slow:${sid}`, false);
    const [o] = failMsgid ? await h.su<{ status: string }>('select status from outbound_sends where channel_msgid = $1', [failMsgid]) : [];
    const [rc] = await h.su<{ id: string; state: string }>(
      `select id::text as id, state from channel_inbox where conversation_id = $1 and kind = 'send_fail'`,
      [sid],
    );
    const log = await txlog();
    const done = log.find((x) => x.tbl === 'inbox' && x.k === rc?.id && x.k2 === 'done');
    const failed = log.find((x) => x.tbl === 'outbound' && x.k === failMsgid && x.k2?.startsWith('failed:'));
    check(
      '回执遇上没提交的 pending（R6 照发之后）：回执的短事务等它提交、迁到 failed，与回执的 done 同一个事务；库里最终是 failed，不留 pending',
      !!failMsgid && o?.status === 'failed' && rc?.state === 'done' && !!done && !!failed && done.txid === failed.txid,
      json({ failMsgid, o, rc, done, failed }),
    );
  }

  // ---- 停机截止之后才回包：分段留在 pending，入站停在 replied（还停在 pending 的不算有结果，留给重启恢复）----
  {
    const uid = 'wm09dl';
    h.wecom.__wecomTest.closeSends(idOf('a1'), Date.now());
    const m = await talk('a1', uid, '你好，想去云南');
    h.wecom.__wecomTest.closeSends(idOf('a1'), null);
    const r = await inboxByMsgid(m.msgid);
    const out = await outOfInbox(r!.id);
    check(
      '停机截止之后：不开始 send_msg，分段 pending、入站停在 replied（重启后按出站恢复补发，第 10 步）',
      h.sentTo(uid).length === 0 &&
        out.length > 0 &&
        out.every((x) => x.status === 'pending') &&
        r?.state === 'replied' &&
        r.attempts === 1,
      json({ r, out }),
    );
  }
  check(
    '库里的账号不写 var/wecom-cursor.json（不变量 13）',
    !fs.existsSync(path.join(h.varDir, 'wecom-cursor.json')) && !fs.existsSync(h.wecom.__test.STATE_FILE),
  );
  ledger.__ledgerTest.setWaits(null);
}
