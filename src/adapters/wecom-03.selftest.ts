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
// 用法：npx tsx src/adapters/wecom-03.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const runChild = (
    mode: string,
    env: Record<string, string>,
  ): {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    result: { pass: number; fails: string[] } | null;
  } => {
    const resultFile = path.join(ROOT, `${mode}-${Date.now()}.json`);
    const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
      cwd: process.cwd(),
      env: { ...process.env, WECOM03_CHILD: mode, WECOM03_RESULT: resultFile, CONFIG_SOURCE: 'file', ...env },
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
  let realPg = false;
  if (process.env.PG_TEST_URL) {
    realPg = true;
    merge('真实 PG', runChild('rpg', { VAR_DIR: fs.mkdtempSync(path.join(ROOT, 'rpg-')) }));
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
      `channel_account_id 的投影与预载 / 重启接着库里的 cursor / prod JSON 日志里没有 external_userid${realPg ? ' / 真实 PG' : '；真实 PG 部分未跑'}）`,
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
  text?: { content: string };
}
interface SendRec {
  /** access_token 是哪个账号的（null：不认识的 token） */
  tokenAcct: string | null;
  /** open_kfid 是哪个账号的 */
  kfAcct: string | null;
  to: string;
  msgid: string;
  content: string;
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
    else if (mode === 'prod') await prodSuite(h);
    else if (mode === 'rpg') await realPgSuite(h);
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
    syncs: [] as SyncRec[],
    gettokens: [] as { corp: string; acct: string | null; ok: boolean }[],
    /** gettoken 一直失败的账号 */
    failToken: new Set<string>(),
    /** 用这个账号的 token 调接口一律回 42001（逼它重取 token） */
    expired: new Set<string>(),
    n: 0,
  };
  const stateFile = path.join(varDir, 'fake-wecom-logs.json');
  if (m === 'restart' && fs.existsSync(stateFile)) {
    for (const [kf, list] of JSON.parse(fs.readFileSync(stateFile, 'utf8')) as [string, FakeMsg[]][]) fake.logs.set(kf, list);
  }
  const res = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'qyapi.weixin.qq.com') return realFetch(input, init);
    const ep = url.pathname.replace(/^\/cgi-bin\//, '');
    if (ep === 'gettoken') {
      const corp = url.searchParams.get('corpid') ?? '';
      const a = ACCTS.find((x) => x.corp === corp && secretsOf(x).appSecret === url.searchParams.get('corpsecret'));
      const ok = !!a && !fake.failToken.has(a.key);
      fake.gettokens.push({ corp, acct: a?.key ?? null, ok });
      if (!ok) return res({ errcode: 40013, errmsg: 'selftest: invalid corpid' });
      const tok = `t03-${a.key}-${++fake.n}`;
      fake.tokens.set(tok, a.key);
      return res({ errcode: 0, access_token: tok, expires_in: 7200 });
    }
    const tokenAcct = fake.tokens.get(url.searchParams.get('access_token') ?? '') ?? null;
    if (tokenAcct && fake.expired.has(tokenAcct)) return res({ errcode: 42001, errmsg: 'selftest: token expired' });
    if (ep === 'media/upload') return res({ errcode: 40004, errmsg: 'selftest' });
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, any>;
    const kfAcct = ACCTS.find((x) => x.kf === body.open_kfid)?.key ?? null;
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
      });
      return res({ errcode: 0, msgid: body.msgid });
    }
    if (ep === 'kf/send_msg_on_event') return res({ errcode: 0 });
    if (ep === 'kf/customer/batchget') return res({ errcode: 0, customer_list: [] });
    return res({ errcode: 40001, errmsg: `selftest: 未模拟的接口 ${ep}` });
  }) as typeof fetch;
  let seq = 0;
  const tag = m === 'restart' ? 'r' : m === 'prod' ? 'p' : m === 'rpg' ? 'g' : 'm';
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

  // ---- 库、会话存储 ----
  const store = await import('../store.js');
  const { openDb, withTenant } = await import('../db/client.js');
  const testing = await import('../db/testing.js');
  let db: import('../db/client.js').Db;
  let tenantId: string;
  let su: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
  let closeDb: () => Promise<void>;
  if (m === 'rpg') {
    const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!, { slug: 'wecom03' });
    const app = await openDb(fx.urls.app);
    db = app.db;
    tenantId = fx.tenantId;
    su = fx.query;
    await store.initSessionStore({ db, tenantId, tenantSlug: 'wecom03', varDir });
    closeDb = async () => {
      await app.close();
      await fx.drop();
    };
  } else {
    const t = await testing.openTestDb(m === 'prod' ? {} : { dataDir: process.env.WECOM03_DATA_DIR! });
    const fx = await testing.installPgSessionStore(t, { varDir, slug: 'demo' });
    db = t.db;
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
  if (m === 'restart') {
    for (const r of await su<{ id: string; key: string }>('select id, key from channel_accounts where tenant_id = $1', [tenantId])) {
      ids.set(r.key, r.id);
    }
  } else {
    for (const a of ACCTS) {
      if (m === 'prod' && a.key === 'b1') continue;
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

  const reg = await import('../channels/registry.js');
  const wecom = await import('./wecom.js');
  const { computeSignature } = await import('../wecom-crypto.js');
  const tokenErrors: [string, string][] = [];
  wecom.onTokenError((code, account) => void tokenErrors.push([code, account]));
  await reg.initChannels({ db, tenantId, tenantSlug: m === 'rpg' ? 'wecom03' : 'demo', varDir, keyRing });
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
    const sig = computeSignature(secretsOf(o.signFor ?? o.encFor).callbackToken, ts, nonce, enc);
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
    '启动：三个启用的企微账号各起一个运行时，后端是过渡后端（cursor 在 channel_accounts）',
    live.every((k) => h.wecom.__wecomTest.inspect(h.ids.get(k)!)?.backend === 'account_cursor') &&
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
}

// ======================================================================================
// prod：prod profile、LOG_FORMAT=json，非默认账号跑一轮（父进程扫标准输出）
// ======================================================================================

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
