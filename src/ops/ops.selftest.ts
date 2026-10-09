// 可观测性自测（docs/architecture/02-conversations-workbench/spec.md「可观测性与告警」、R24、不变量 49、验收 34）。
// 第 18 步先建这个套件，管运行数字与 OpenTelemetry；第 17 步往这里加日志与告警的部分（plan 记了这一顺序调整）。
// 运行数字：PGlite 上造 trace 与 usage_daily 行，逐字段核对口径（p90 只算 replied、转人工率按会话、出错率含 llm 里的 error、
// 今天按服务器时区）、窗口按租户的 trace 保留期截断、60 秒缓存、文件存储 503、角色 403；带 PG_TEST_URL 时同一份数据在真实
// Postgres 上（agent_app、RLS）再算一遍。
// OpenTelemetry：子进程里没设端点时一个 @opentelemetry/* 都没加载（加载钩子与 require.cache）、不向外连接；设了端点时进程内的
// 假 OTLP/HTTP 接收端收到的 span 名字、父子关系、起止时刻与属性逐项对，默认没有原文与 external_userid，OTEL_CAPTURE_CONTENT=1
// 时才有；没有 ref 的会话用不会撞的匿名引用；出错的模型调用、执行时抛错的工具与出错的轮次带 error.type；导出端点挂掉时对话照常、
// 只记日志；停机时 flush，端点不通时按 drain 段的截止时刻放弃。另有 check-boundaries 新加的三条规则。
// 日志（第 17 步）：子进程在 prod profile、LOG_FORMAT=json 下跑一组含价格护栏命中与转人工的对话和几个请求，标准输出每行都是
// JSON、带 time / level / msg，请求里的 req 与响应头 x-request-id 相同，轮次里带 tenant / conv（会话的 ref）/ turn，搜不到客户原话、
// 会话原 id 与凭据（兜底与 redact）；进程内另测 logQuote、convLabel、没设 LOG_FORMAT 时什么都不接。
// 告警（第 17 步）：本机假 webhook 上 app 侧五个键的触发、30 分钟去重、恢复、条件变重、限流、超时与失败不抛不阻塞、没配地址只
// warn、内容格式与禁止项；deploy/watch.sh 与 backup.sh 用 PATH 里的假 docker、curl、df、age 以子进程跑。
// 用法：npx tsx src/ops/ops.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

// 03 R22：手写 id，不依赖后续步骤的渠道产生方；带 key 的 id 穷举两处冒号的原文、大小写编码与混合编码。
const channelIds = [
  { id: 'wecom:wmKeyed0001', code: '0001' },
  { id: 'wecom:shop-b:wmKeyed0001', code: 'conv-keyed-ref' },
  { id: 'wecom:shop-c:wmKeyed0001', code: '0001' },
  { id: 'web:0123456789abcdef0123456789abcdef', code: 'conv-web-ref' },
  { id: 'web:abcdef0123456789abcdef0123456789', code: '6789' },
  { id: 'sim-0123456789abcdef01234567', code: '4567' },
];
const channelRefs = new Map(channelIds.filter(({ code }) => code.startsWith('conv-')).map(({ id, code }) => [id, code]));
const channelIdCases = channelIds.flatMap(({ id, code }) => {
  let variants = [id.split(':')[0]!];
  for (const part of id.split(':').slice(1)) {
    variants = variants.flatMap((prefix) => [':', '%3A', '%3a'].map((colon) => `${prefix}${colon}${part}`));
  }
  return variants.map((raw) => ({ id, raw, code }));
});
const channelIdsHidden = (text: string): boolean =>
  channelIdCases.every(({ id, raw }) => !text.includes(raw) && !text.includes(id.slice(id.lastIndexOf(':') + 1)));
const ordinaryWebText = `web: 首页 web:abc web:${'f'.repeat(31)} web:${'f'.repeat(33)}`;

// 服务器时区：上海。下面的「现在」取 UTC 17:30，上海已是第二天 01:30，「今天」按 UTC 算就差一天
process.env.TZ = 'Asia/Shanghai';
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const CHILD = process.env.OPS_SELFTEST_CHILD;
const VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-ops-selftest-'));
process.env.VAR_DIR = VAR_DIR;
process.env.SERVER_SELFTEST = '1';
process.on('exit', () => fs.rmSync(VAR_DIR, { recursive: true, force: true }));
// 本机 .env 里的 OTEL_* 进不来：空串挡得住 env.ts 的补全
for (const k of [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_CAPTURE_CONTENT',
  'WECOM_CORP_ID',
  'WECOM_APP_SECRET',
  'WECOM_KF_OPEN_KFID',
  'LLM_MODEL_CHEAP',
  'EMBED_MODEL',
  'LLM_SLOW_TURN_MS',
  // 第 17 步：本机 .env 里的日志格式、告警地址与企微回调口令同样进不来（不会往真的群里推）
  'LOG_FORMAT',
  'ALERT_WEBHOOK_URL',
  'INSTANCE_LABEL',
  'WECOM_CALLBACK_TOKEN',
  'WECOM_CALLBACK_AES_KEY',
]) {
  if (!CHILD || !k.startsWith('OTEL_')) process.env[k] = '';
}

// ================ 子进程：没设端点时什么都不加载、不连接（不变量 49） ================
if (CHILD === 'no-otel') {
  const { registerHooks, createRequire } = await import('node:module');
  const resolved = new Set<string>();
  // 进程内的同步加载钩子：import 与 require 都经过它（含 tsx 之后的解析），解析到 @opentelemetry/* 就记下是哪个包
  registerHooks({
    resolve(specifier, context, next) {
      const r = next(specifier, context);
      const pkg = /[/\\]@opentelemetry[/+]([a-z-]+)/.exec(r.url)?.[1];
      if (pkg || specifier.startsWith('@opentelemetry/')) resolved.add(pkg ? `@opentelemetry/${pkg}` : specifier);
      return r;
    },
  });
  const net = await import('node:net');
  let connects = 0;
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: import('node:net').Socket, ...a: unknown[]) {
    connects += 1;
    return (origConnect as (...x: unknown[]) => import('node:net').Socket).apply(this, a);
  } as typeof origConnect;
  /** require.cache 里的 @opentelemetry/* 包（去重） */
  const otelInCache = (): string[] => [
    ...new Set(
      Object.keys(createRequire(import.meta.url).cache).flatMap((k) => {
        const pkg = /[/\\]@opentelemetry[/+]([a-z-]+)/.exec(k)?.[1];
        return pkg ? [`@opentelemetry/${pkg}`] : [];
      }),
    ),
  ];

  process.env.LLM_MOCK = '1';
  process.env.CONFIG_SOURCE = 'file';
  // 服务器的整张静态 import 图（含 src/ops/otel.ts、boot.ts）
  await import('../server.js');
  const { boot } = await import('../boot.js');
  const { startOtelExport } = await import('./otel.js');
  let called = false;
  const calls: string[] = [];
  await boot({
    initConfig: async () => void calls.push('config'),
    initSessionStore: async () => void calls.push('store'),
    initChannels: async () => {},
    serve: (onListening) => {
      calls.push('serve');
      onListening();
    },
    preflight: () => {},
    buildIndex: async () => {},
    // 自测只看 startOtel 的位置：两种存储的后台任务都不起
    storeMode: () => 'file',
    startFollowUpScheduler: () => {},
    startJobs: () => {},
    startChannels: () => void calls.push('wecom'),
    exit: (c) => void calls.push(`exit ${c}`),
    startOtel: async () => {
      called = true;
      await startOtelExport();
    },
  });
  const { handleMessage } = await import('../engine.js');
  const r = await handleMessage('sim-ops-no-otel', '你好，想去云南玩', 'simulator');
  const out = {
    calls: calls.join(','),
    called,
    reply: r.text,
    resolved: [...resolved],
    cache: otelInCache(),
    connects,
    // 对照：钩子与连接计数确实看得见（动态加载导出器、连一次接收端）
    control: { resolved: 0, cache: 0, connects: 0 },
  };
  await import('../otel/export.js');
  out.control.resolved = resolved.size;
  out.control.cache = otelInCache().length;
  await fetch(`${process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}/control`).catch(() => undefined);
  out.control.connects = connects - out.connects;
  // 写进管道是异步的：等写完再退出，不然长的一行会被截断
  process.stdout.write(`OPS_CHILD ${JSON.stringify(out)}\n`, () => process.exit(0));
  await new Promise(() => {});
}

// 日志子进程与父进程共用：客户的 external_userid、两句原话（任何一行日志里都不许出现）、模型那句带编价的回复
const LOG_EXT = 'wmJsonLogPriv01';
const LOG_SAID = '想去云南玩七月份，我叫王小明电话一三八一二三四五六七八';
const LOG_SAID2 = '我要转人工，找真人顾问聊聊吧';
const LOG_RAW = '云南这边有丽江大理·洱海古城 6 日，每人 16,800 元起。当地包车一天只要 1,234 元。您几位出行呢？';

// ================ 子进程：prod profile、LOG_FORMAT=json 下的日志（不变量 48、验收 34 的日志部分） ================
if (CHILD === 'json-logs') {
  process.env.LOG_FORMAT = 'json';
  process.env.DEPLOY_PROFILE = 'prod';
  process.env.ADMIN_PASS = 'ops-json-admin';
  process.env.CONFIG_SOURCE = 'file';
  // 假模型：按脚本回话（与父进程的同一个写法）
  const steps: { content?: string; toolCalls?: { name: string; args: Record<string, unknown> }[] }[] = [];
  let n = 0;
  const llm = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/embeddings')) {
        const input = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] }).input ?? [];
        res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: [1, i % 3, 2] })), usage: { prompt_tokens: 3 } }));
        return;
      }
      const step = steps.shift();
      n += 1;
      const message = step?.toolCalls
        ? {
            role: 'assistant',
            content: null,
            tool_calls: step.toolCalls.map((c, i) => ({
              id: `call_${n}_${i}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : { role: 'assistant', content: step?.content ?? '好的～' };
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: step?.toolCalls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 900, completion_tokens: 30 },
        }),
      );
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    LLM_MOCK: '0',
    LLM_PROVIDER: '',
    LLM_BASE_URL: llmUrl,
    LLM_API_KEY: 'selftest-fake-key',
    LLM_MODEL: 'glm-5.3-flashx',
    EMBED_BASE_URL: llmUrl,
    EMBED_API_KEY: 'selftest-fake-key',
    LLM_HEDGE_MODEL: '',
    LLM_MAX_RETRY: '0',
  });
  // 导入 server.ts：profile-boot 在导入期就把 console.* 接到 pino（[profile] 那一行也是 JSON）
  const { app } = await import('../server.js');
  const { log, withLogContext } = await import('../log.js');
  const store = await import('../store.js');
  const recorder = await import('../trace/recorder.js');
  const testing = await import('../db/testing.js');
  const { handleMessage } = await import('../engine.js');
  const t = await testing.openTestDb();
  await testing.installSeededConfig(t);
  const fx = await testing.installPgSessionStore(t, { varDir: VAR_DIR });
  await store.initSessionStore(fx.deps);
  const turns: string[] = [];
  recorder.onTurnEnd((f) => turns.push(f.turn.turnId));
  const sid = `wecom:${LOG_EXT}`;
  steps.push({ toolCalls: [{ name: 'search_routes', args: { destination: '云南' } }] }, { content: LOG_RAW });
  const r1 = await handleMessage(sid, LOG_SAID, 'wecom');
  const r2 = await handleMessage(sid, LOG_SAID2, 'wecom');
  await store.flushSession(sid);
  // 请求：server.ts 的中间件（企微回调没配，记一行 error）与 console 子应用（登录失败，记一行 warn）
  const cb = await app.request('/wecom/callback', { method: 'POST', body: 'x', headers: { 'content-length': '1' } });
  const loginBody = JSON.stringify({ email: 'nobody@ops.example.com', password: 'wrong-password-1' });
  const login = await app.request('/api/console/auth/login', {
    method: 'POST',
    body: loginBody,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(loginBody)),
      'x-forwarded-for': '203.0.113.7',
    },
  });
  // 兜底：形如会话原 id 的串、请求路径里编码过的、带凭据的地址与 Bearer
  console.log('兜底：wecom:wmFallbackRaw01 sim-0123456789abcdef01234567 /api/sessions/wecom%3AwmFallbackRaw02/reply');
  const { setConvRefResolver } = await import('../log.js');
  setConvRefResolver((id) => channelRefs.get(id) ?? store.conversationRef(id));
  try {
    for (const [i, { raw }] of channelIdCases.entries()) {
      console.log(`渠道 id 兜底 ${i}：${raw}`);
      log.info(`渠道 id 字段 ${i}`, { nested: { conversation: raw } });
    }
    console.log(`普通网页文本：${ordinaryWebText}`);
  } finally {
    setConvRefResolver(store.conversationRef);
  }
  console.warn('凭据：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRETKEY99 Authorization: Bearer tok123secret');
  log.info('redact', {
    authorization: 'Bearer AUTHSECRET1',
    cookie: 'sid=COOKIESECRET1',
    nested: { webhookUrl: 'https://h.example/?key=HOOKSECRET1', headers: { 'set-cookie': 'SETCOOKIESECRET1' } },
    keep: 'visible-field',
  });
  withLogContext({ req: 'manual-req-1' }, () => log.warn('手动上下文'));
  const out = {
    cb: cb.headers.get('x-request-id'),
    cbStatus: cb.status,
    login: login.headers.get('x-request-id'),
    loginStatus: login.status,
    ref: store.conversationRef(sid),
    turns,
    handoff: !!r2.handoff || r2.stage === 'handoff',
    priceDropped: !r1.text.includes('1,234') && r1.text.includes('16,800'),
    stepsLeft: steps.length,
  };
  console.log(`OPS_JSON_RESULT ${JSON.stringify(out)}`);
  await t.close().catch(() => undefined);
  process.exit(0);
}

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const json = (v: unknown): string => JSON.stringify(v);
const repoRoot = path.join(import.meta.dirname, '..', '..');
let unhandled = 0;
process.on('unhandledRejection', () => void (unhandled += 1));

// ---------------- 假 OTLP/HTTP 接收端：收 JSON（gzip 也认），down 时直接断开连接 ----------------
interface OtlpValue {
  stringValue?: string;
  intValue?: number | string;
  boolValue?: boolean;
  doubleValue?: number;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes?: { key: string; value: OtlpValue }[];
  status?: { code?: number };
}
interface Got {
  resource: Record<string, unknown>;
  span: OtlpSpan;
  attrs: Record<string, unknown>;
}
// mode：ok 照收；down 直接断开连接；hang 收下请求不回；s503 回 503（导出器会退避重试）
const receiver = { bodies: [] as string[], paths: [] as string[], mode: 'ok' as 'ok' | 'down' | 'hang' | 's503' };
const otlp = http.createServer((req, res) => {
  if (receiver.mode === 'down') {
    req.socket.destroy();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    receiver.paths.push(`${req.method} ${req.url}`);
    if (receiver.mode === 'hang') return;
    if (receiver.mode === 's503') {
      res.statusCode = 503;
      res.end();
      return;
    }
    let buf = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf);
    if (req.url === '/v1/traces') receiver.bodies.push(buf.toString('utf8'));
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
});
await new Promise<void>((r) => otlp.listen(0, '127.0.0.1', r));
const otlpUrl = `http://127.0.0.1:${(otlp.address() as AddressInfo).port}`;
const valueOf = (v: OtlpValue): unknown =>
  v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : (v.boolValue ?? v.doubleValue));
function spansReceived(): Got[] {
  const out: Got[] = [];
  for (const b of receiver.bodies) {
    const doc = JSON.parse(b) as {
      resourceSpans: { resource: { attributes: { key: string; value: OtlpValue }[] }; scopeSpans: { spans: OtlpSpan[] }[] }[];
    };
    for (const rs of doc.resourceSpans) {
      const resource = Object.fromEntries(rs.resource.attributes.map((a) => [a.key, valueOf(a.value)]));
      for (const ss of rs.scopeSpans) {
        for (const span of ss.spans) {
          out.push({ resource, span, attrs: Object.fromEntries((span.attributes ?? []).map((a) => [a.key, valueOf(a.value)])) });
        }
      }
    }
  }
  return out;
}

// ================ check-boundaries：OpenTelemetry 的三条规则 ================
{
  const dir = fs.mkdtempSync(path.join(VAR_DIR, 'boundaries-'));
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('src/a.ts', "import { trace } from '@opentelemetry/api';\nexport const A = trace;\n");
  put('src/b.ts', "import type { Span } from '@opentelemetry/api';\nexport type B = Span;\n");
  put('src/c.ts', "export const C = () => import('@opentelemetry/api');\n");
  put('src/otel/export.ts', "import { trace } from '@opentelemetry/api';\nexport const E = trace;\n");
  put('src/d.ts', "import { E } from './otel/export.js';\nexport const D = E;\n");
  put('src/e.ts', "export const load = () => import('./otel/export.js');\n");
  put('src/f.ts', "import type { E } from './otel/export.js';\nexport type F = typeof E;\n");
  put('src/g.selftest.ts', "import { E } from './otel/export.js';\nexport const G = E;\n");
  put('src/otel/db.ts', "import { withTenant } from '../db/client.js';\nexport const W = withTenant;\n");
  put('src/otel/db-type.ts', "import type { Tx } from '../db/client.js';\nexport type T = Tx;\n");
  put('src/db/client.ts', 'export const withTenant = 1;\nexport type Tx = number;\n');
  // 第 17 步：pino 只在 src/log.ts 里 import
  put('src/log.ts', "import pino from 'pino';\nexport const L = pino;\n");
  put('src/h.ts', "import pino from 'pino';\nexport const H = pino;\n");
  put('src/i.ts', "import type { Logger } from 'pino';\nexport type I = Logger;\n");
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'scripts', 'check-boundaries.ts'), dir], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const hit = (fileLine: string): boolean => run.stderr.includes(`  ${fileLine}  `);
  check(
    '边界 lint：src/otel/ 之外静态或动态 import @opentelemetry/* 都被拦，import type 不拦，src/otel/ 里可以',
    run.status === 1 && hit('src/a.ts:1') && hit('src/c.ts:1') && !hit('src/b.ts:1') && !hit('src/otel/export.ts:1'),
    run.stderr.slice(0, 800),
  );
  check(
    '边界 lint：src/otel/** 在外面只能动态 import（自测也一样）；import type 不拦',
    hit('src/d.ts:1') && hit('src/g.selftest.ts:1') && !hit('src/e.ts:1') && !hit('src/f.ts:1'),
    run.stderr.slice(0, 800),
  );
  check(
    '边界 lint：src/otel/ 不 import src/db/（import type 也不行）',
    hit('src/otel/db.ts:1') && hit('src/otel/db-type.ts:1'),
    run.stderr,
  );
  check(
    '边界 lint：pino 只能在 src/log.ts 里 import（import type 不拦）',
    hit('src/h.ts:1') && !hit('src/log.ts:1') && !hit('src/i.ts:1'),
    run.stderr.slice(0, 800),
  );
}

// ================ OpenTelemetry：没设端点（子进程） ================
{
  receiver.bodies.length = 0;
  receiver.paths.length = 0;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPS_SELFTEST_CHILD: 'no-otel',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    // 别的 OTEL_* 设了也不算：只有 OTEL_EXPORTER_OTLP_ENDPOINT 打开导出
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otlpUrl,
    OTEL_CAPTURE_CONTENT: '1',
    VAR_DIR: varParent,
  };
  // 异步起子进程：子进程要连本进程的接收端（对照），本进程的事件循环不能被 spawnSync 堵住
  const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'ops.selftest.ts')], { cwd: repoRoot, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('OPS_CHILD '));
  const parsed = (() => {
    try {
      return line ? (JSON.parse(line.slice('OPS_CHILD '.length)) as unknown) : null;
    } catch {
      return null;
    }
  })();
  const out = parsed
    ? (parsed as {
        calls: string;
        called: boolean;
        reply: string;
        resolved: string[];
        cache: string[];
        connects: number;
        control: { resolved: number; cache: number; connects: number };
      })
    : null;
  check('没设端点：子进程跑完一轮', run.status === 0 && !!out && out.reply.length > 0, `${run.status} ${run.stderr.slice(-600)}`);
  if (out) {
    check('没设端点：boot() 照常起来、不调 startOtel', out.calls === 'config,store,serve,wecom' && !out.called, json(out));
    check(
      '不变量 49：没设端点时加载钩子没见过任何 @opentelemetry/*，require.cache 里也没有（server.ts 的整张静态 import 图、boot、一轮对话）',
      out.resolved.length === 0 && out.cache.length === 0,
      json({ resolved: out.resolved, cache: out.cache.slice(0, 5) }),
    );
    check('不变量 49：没设端点时一次对外连接都没有（LLM_MOCK）', out.connects === 0, String(out.connects));
    check(
      '对照：动态加载导出器之后钩子与 require.cache 都看得见 @opentelemetry/*，连一次接收端也数得到',
      out.control.resolved > 0 && out.control.cache > 0 && out.control.connects > 0,
      json(out.control),
    );
  }
  check(
    '没设端点：接收端一条 trace 都没收到（只有对照那次 GET）',
    receiver.bodies.length === 0 && receiver.paths.every((p) => p === 'GET /control'),
    json(receiver.paths),
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 异步起子进程（本进程里的假服务要能应答它），超时就杀掉 */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// ================ 日志：prod profile、LOG_FORMAT=json（子进程，不变量 48、验收 34 的日志部分） ================
{
  const run = await spawnAsync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'ops.selftest.ts')], {
    cwd: repoRoot,
    env: { ...process.env, OPS_SELFTEST_CHILD: 'json-logs', VAR_DIR: varParent, LOG_FORMAT: '' },
  });
  const lines = run.stdout.split('\n').filter((l) => l.trim() !== '');
  const docs: Record<string, unknown>[] = [];
  const bad: string[] = [];
  for (const l of lines) {
    try {
      const d = JSON.parse(l) as unknown;
      if (d && typeof d === 'object' && !Array.isArray(d)) docs.push(d as Record<string, unknown>);
      else bad.push(l);
    } catch {
      bad.push(l);
    }
  }
  const msgOf = (d: Record<string, unknown>): string => (typeof d.msg === 'string' ? d.msg : '');
  const resultDoc = docs.find((d) => msgOf(d).startsWith('OPS_JSON_RESULT '));
  const res = resultDoc
    ? (JSON.parse(msgOf(resultDoc).slice('OPS_JSON_RESULT '.length)) as {
        cb: string | null;
        cbStatus: number;
        login: string | null;
        loginStatus: number;
        ref: string | null;
        turns: string[];
        handoff: boolean;
        priceDropped: boolean;
        stepsLeft: number;
      })
    : null;
  check('日志子进程：跑完、交回结果', run.status === 0 && !!res, `${run.status} ${run.stderr.slice(-800)} ${run.stdout.slice(-400)}`);
  check(
    '前提：一组对话里价格护栏删了一句、第二句转了人工，模型脚本恰好用完',
    !!res && res.priceDropped && res.handoff && res.stepsLeft === 0,
    json(res),
  );
  check(
    '不变量 48：LOG_FORMAT=json 时标准输出每一行都能解析成一个 JSON 对象',
    lines.length > 10 && bad.length === 0,
    `${lines.length} 行，解析不了的：${json(bad.slice(0, 3))}`,
  );
  check(
    '每行都带 time（ISO）、level（名字）、msg（字符串），不带 pid 与主机名',
    docs.every(
      (d) =>
        typeof d.time === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(d.time) &&
        ['info', 'warn', 'error'].includes(String(d.level)) &&
        typeof d.msg === 'string' &&
        !('pid' in d) &&
        !('hostname' in d),
    ),
    json(docs.find((d) => typeof d.time !== 'string' || typeof d.msg !== 'string')),
  );
  check(
    '导入期的日志（[profile] 那一行）也是 JSON：profile-boot 在导入期就把 console.* 接过去了',
    docs.some((d) => msgOf(d).startsWith('[profile] prod · ') && d.level === 'info'),
    json(docs.slice(0, 2)),
  );
  const cbLine = docs.find((d) => msgOf(d).startsWith('[wecom] 收到回调但'));
  const loginLine = docs.find((d) => msgOf(d).startsWith('[auth] 登录失败'));
  check(
    '请求里的行带 req，与响应头 x-request-id 相同（server.ts 的中间件）',
    !!res && !!res.cb && /^[0-9a-f]{16}$/.test(res.cb) && cbLine?.req === res.cb && cbLine.level === 'error',
    json({ header: res?.cb, line: cbLine }),
  );
  check(
    'console 子应用挂在 server.ts 下：沿用外层的 req，日志行与响应头相同，两个请求的 req 不同',
    !!res && !!res.login && res.loginStatus === 401 && loginLine?.req === res.login && res.login !== res.cb && loginLine.level === 'warn',
    json({ header: res?.login, line: loginLine }),
  );
  check(
    '请求之外的行不带 req',
    docs.filter((d) => msgOf(d).startsWith('[profile]') || msgOf(d).startsWith('兜底')).every((d) => !('req' in d)),
  );
  const turnLines = docs.filter((d) => 'turn' in d);
  check(
    '轮次里的行带 tenant（slug）、conv（会话的 ref）、turn（这一轮 trace 的 id）',
    !!res &&
      !!res.ref &&
      res.turns.length === 2 &&
      turnLines.length >= 3 &&
      turnLines.every((d) => d.tenant === 'demo' && d.conv === res.ref && res.turns.includes(String(d.turn))),
    json({ ref: res?.ref, turns: res?.turns, lines: turnLines.slice(0, 4) }),
  );
  check(
    '价格护栏删句那一行在它那一轮的上下文里（第一轮）；转人工那一轮（确定性路径）不打日志',
    turnLines.some((d) => msgOf(d).includes('拦截无出处的报价') && d.turn === res?.turns[0]),
    json(turnLines.map((d) => msgOf(d).slice(0, 40))),
  );
  check(
    'conv 不是会话原 id：日志里的会话都是 ref（db 存储的真实会话），行里写会话的地方同样（prod 下 convLabel）',
    docs.every((d) => !('conv' in d) || d.conv === res?.ref) && docs.some((d) => msgOf(d).includes(`（会话 ${res?.ref}`)),
    json(
      docs
        .filter((d) => msgOf(d).includes('会话'))
        .map(msgOf)
        .slice(0, 4),
    ),
  );
  const all = run.stdout + run.stderr;
  check(
    '不变量 48：整个输出里搜不到客户原话、external_userid 与会话原 id（prod profile）',
    !all.includes(LOG_SAID) &&
      !all.includes(LOG_SAID2) &&
      !all.includes('王小明') &&
      !all.includes(LOG_EXT) &&
      !/wecom(?::|%3[Aa])[A-Za-z0-9_-]/.test(all) &&
      !/\bsim-[A-Za-z0-9_-]/.test(all),
    [LOG_SAID, LOG_EXT, 'wecom:', 'sim-'].filter((x) => all.includes(x)).join(' / '),
  );
  const fallback = docs.find((d) => msgOf(d).startsWith('兜底：'));
  check(
    'JSON 输出的兜底：形如会话原 id 的串（含编码过的 wecom%3A）换成短码',
    msgOf(fallback ?? {}) === '兜底：AW01 4567 /api/sessions/AW02/reply',
    msgOf(fallback ?? {}),
  );
  const secrets = ['SECRETKEY99', 'tok123secret', 'AUTHSECRET1', 'COOKIESECRET1', 'HOOKSECRET1', 'SETCOOKIESECRET1'];
  const redacted = docs.find((d) => msgOf(d) === 'redact');
  check(
    'redact：authorization、cookie、set-cookie、webhook 地址一类字段在顶层与下面几层都盖住，别的字段照写',
    !!redacted &&
      redacted.authorization === '[已遮盖]' &&
      redacted.cookie === '[已遮盖]' &&
      json(redacted.nested) === json({ webhookUrl: '[已遮盖]', headers: { 'set-cookie': '[已遮盖]' } }) &&
      redacted.keep === 'visible-field',
    json(redacted),
  );
  check(
    '兜底：msg 里带凭据的查询参数与 Bearer 也盖掉；整个输出里一个密钥都搜不到',
    secrets.every((s) => !all.includes(s)) &&
      docs.some((d) => msgOf(d).includes('send?key=[已遮盖]') && msgOf(d).includes('Bearer [已遮盖]')),
    secrets.filter((s) => all.includes(s)).join(' / '),
  );
  check(
    'withLogContext 手动给的 req 照写',
    docs.some((d) => msgOf(d) === '手动上下文' && d.req === 'manual-req-1' && d.level === 'warn'),
  );
  for (const [i, { raw, code }] of channelIdCases.entries()) {
    const line = docs.find((d) => msgOf(d).startsWith(`渠道 id 兜底 ${i}：`));
    const field = docs.find((d) => msgOf(d) === `渠道 id 字段 ${i}`);
    check(
      `03 R22 JSON 兜底：${raw} 的正文与嵌套字段换成 ${code}`,
      msgOf(line ?? {}) === `渠道 id 兜底 ${i}：${code}` && json(field?.nested) === json({ conversation: code }),
      json({ line, field }),
    );
  }
  check('03 R22 JSON：整份输出没有原 id、external_userid、web hash 与 key:id 残片', channelIdsHidden(all));
  check(
    '03 R22 JSON：普通 web 文本与长度不对的 id 原样保留',
    docs.some((d) => msgOf(d) === `普通网页文本：${ordinaryWebText}`),
  );
}

// ================ 运行数字（PGlite） ================
// 假模型：OpenTelemetry 那一段要走真的模型调用（工具、出错），用量也要有
interface Step {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  status?: number;
}
const script: Step[] = [];
let nCalls = 0;
const fakeLlm = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      const input = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] }).input ?? [];
      res.end(json({ data: input.map((_, i) => ({ embedding: [1, i % 3, 2] })), usage: { prompt_tokens: 3, completion_tokens: 0 } }));
      return;
    }
    const step = script.shift();
    if (step?.status) {
      res.statusCode = step.status;
      res.end(json({ error: { code: String(step.status), message: '假服务模拟的失败' } }));
      return;
    }
    nCalls += 1;
    const message = step?.toolCalls
      ? {
          role: 'assistant',
          content: null,
          tool_calls: step.toolCalls.map((c, i) => ({
            id: `call_${nCalls}_${i}`,
            type: 'function',
            function: { name: c.name, arguments: json(c.args) },
          })),
        }
      : { role: 'assistant', content: step?.content ?? '好的～还有什么想了解的随时说。' };
    res.end(
      json({
        choices: [{ message, finish_reason: step?.toolCalls ? 'tool_calls' : 'stop' }],
        usage: {
          prompt_tokens: 900 + nCalls * 11,
          completion_tokens: 30 + nCalls,
          prompt_tokens_details: { cached_tokens: 200 + nCalls },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
  });
});
await new Promise<void>((r) => fakeLlm.listen(0, '127.0.0.1', r));
const fakeLlmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}`;
process.env.CONFIG_SOURCE = 'file';
process.env.LLM_MOCK = '0';
process.env.LLM_PROVIDER = '';
process.env.LLM_BASE_URL = fakeLlmUrl;
process.env.LLM_API_KEY = 'selftest-fake-key';
process.env.LLM_MODEL = 'glm-5.3-flashx';
process.env.EMBED_BASE_URL = fakeLlmUrl;
process.env.EMBED_API_KEY = 'selftest-fake-key';
process.env.LLM_HEDGE_MODEL = '';
process.env.LLM_MAX_RETRY = '0';

const store = await import('../store.js');
const recorder = await import('../trace/recorder.js');
const { openTestDb, installSeededConfig, installPgSessionStore, fakeLock } = await import('../db/testing.js');
const { withTenant, queryCount } = await import('../db/client.js');
const { readMetrics, readTraceRetentionDays } = await import('../db/repo/metrics.js');
const { shortIdOf } = await import('../shared/conversation.js');
const accounts = await import('../auth/accounts.js');
const { SESSION_COOKIE } = await import('../auth/session.js');
const { consoleApi, __consoleTest } = await import('../console-api/app.js');
const { metricsWindow, __metricsTest } = await import('./metrics.js');
const { boot } = await import('../boot.js');
const { startOtelExport, providerName } = await import('./otel.js');
const { handleMessage } = await import('../engine.js');
const { createRequire } = await import('node:module');
const otelLoaded = (): number =>
  Object.keys(createRequire(import.meta.url).cache).filter((k) => /[/\\]@opentelemetry[/+\\]/.test(k)).length;

const t = await openTestDb();
await t.pg.exec('RESET ROLE');
await t.pg.query(`insert into tenants (slug, name, pack_id) values ('demo', 'demo', 'travel'), ('other', 'other', 'travel')`);
// 锁留着：告警的自测要让它断开、重新取得、被别的进程拿走（第 17 步）
let theLock: ReturnType<typeof fakeLock> | null = null;
await installSeededConfig(t, { deps: { lock: async () => (theLock = fakeLock()) } });
const su = <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
  t.pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE');
    return (await tx.query<R>(text, params)).rows;
  });
const tenantOf = async (slug: string): Promise<string> =>
  (await su<{ id: string }>('select id from tenants where slug = $1', [slug]))[0]!.id;
const DEMO = await tenantOf('demo');
const OTHER = await tenantOf('other');

// 「现在」：最近一个已经过去的 UTC 17:30（上海次日 01:30）
const NOW = (() => {
  const d = new Date();
  d.setUTCHours(17, 30, 0, 0);
  if (d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1);
  return d.getTime();
})();
let clockAt = NOW;
__consoleTest.setClock(() => clockAt);
const shDay = (offsetDays: number): string => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const utcDay = new Date(NOW).toISOString().slice(0, 10);

// 成员：五种角色
const ROLES = ['owner', 'admin', 'supervisor', 'agent', 'viewer'] as const;
await t.pg.exec('SET ROLE agent_platform');
for (const role of ROLES) {
  const r = await accounts.createUser(t.db, {
    tenantSlug: 'demo',
    email: `${role}@ops.example.com`,
    name: role,
    role,
    password: async () => `${role}-password-1`,
  });
  check(`准备：建一个 ${role}`, r.code === 0, r.message);
}
await t.pg.exec('SET ROLE agent_app');
interface Res {
  status: number;
  body: Record<string, unknown>;
}
async function api(method: string, url: string, o: { token?: string; json?: unknown; ip?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? '203.0.113.90' };
  if (o.token) headers.cookie = `${SESSION_COOKIE}=${o.token}`;
  let body: string | undefined;
  if (o.json !== undefined) {
    body = json(o.json);
    headers['content-type'] = 'application/json';
  }
  const res = await consoleApi.request(`/api/console${url}`, { method, headers, body });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, body: parsed };
}
const tokens: Record<string, string> = {};
for (const [i, role] of ROLES.entries()) {
  const res = await consoleApi.request('/api/console/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${100 + i}` },
    body: json({ email: `${role}@ops.example.com`, password: `${role}-password-1` }),
  });
  tokens[role] = /^__Host-sid=([A-Za-z0-9_-]{43});/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  check(`准备：${role} 登录`, res.status === 200 && tokens[role]!.length === 43, String(res.status));
}

// ---------------- 文件存储：503 store_file_mode，权限先于它 ----------------
{
  check('前提：这时还是文件存储、DB 配置模式', store.sessionStoreMode() === 'file');
  const owner = await api('GET', '/metrics?days=7', { token: tokens.owner });
  check(
    '文件存储下 /metrics → 503 store_file_mode',
    owner.status === 503 && owner.body.error === 'store_file_mode',
    `${owner.status} ${json(owner.body)}`,
  );
  const viewer = await api('GET', '/metrics', { token: tokens.viewer });
  check('文件存储下 viewer 照样 403（权限先于存储模式）', viewer.status === 403 && viewer.body.error === 'forbidden', json(viewer));
}

const fx = await installPgSessionStore(t, { varDir: VAR_DIR });
await store.initSessionStore(fx.deps);
check('前提：db 存储装上了', store.sessionStoreMode() === 'db');

/**
 * 造一份运行数字的数据（PGlite 与真实 PG 共用）。窗口（7 天）：上海时区 shDay(-6) 的 0 点起。
 * 窗口内 13 轮：replied 7 轮（1–7 秒，第 7 秒那轮恰在窗口起点）、handoff 3 轮（A 一轮、C 两轮）、error 1 轮、deterministic、silent 各 1 轮；
 * B 的 error 那轮 llm 里没有出错的一项，C 有一轮 replied 的 llm 里第二次调用出错（两种各认一轮）。窗口外两轮（起点前 1 分钟的 handoff、起点前 6 小时、也就是 UTC 那天之内的 replied）。
 * 另一个租户在窗口内还有两轮与一笔大额用量
 */
async function seedMetrics(exec: (text: string, params: unknown[]) => Promise<unknown>, tenant: string, other: string): Promise<void> {
  const since = metricsWindow(NOW, 7).since.getTime();
  const at = (ms: number): string => new Date(ms).toISOString();
  const conv = async (tid: string, id: string): Promise<void> => {
    await exec(
      `insert into conversations (tenant_id, id, channel, stage, handed_over, state, created_at, updated_at)
       values ($1, $2, 'wecom', 'greeting', false, json_build_object('id', $2::text), $3, $3)`,
      [tid, id, at(since - 86_400_000)],
    );
  };
  const turn = async (tid: string, id: string, startedAt: number, ms: number, outcome: string, llm: unknown[] = []): Promise<void> => {
    await exec(
      `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, repeat('a', 64), '{}', '[]', $6::json)`,
      [tid, id, at(startedAt), ms, outcome, json(llm)],
    );
  };
  for (const id of ['wecom:wmMetricA', 'wecom:wmMetricB', 'wecom:wmMetricC', 'wecom:wmMetricD']) await conv(tenant, id);
  await conv(other, 'wecom:wmMetricX');
  const h = 3_600_000;
  const ok = [{ model: 'm', error: null }];
  await turn(tenant, 'wecom:wmMetricA', NOW - 5 * h, 1000, 'replied', ok);
  await turn(tenant, 'wecom:wmMetricA', NOW - 4 * h, 2000, 'replied', ok);
  await turn(tenant, 'wecom:wmMetricA', NOW - 3 * h, 50_000, 'handoff', ok);
  await turn(tenant, 'wecom:wmMetricB', NOW - 50 * h, 3000, 'replied', ok);
  await turn(tenant, 'wecom:wmMetricB', NOW - 49 * h, 4000, 'replied', [{ model: 'm' }]);
  // 出错在模型调用之外（llm 里没有出错的一项）：只有 outcome 认得出它
  await turn(tenant, 'wecom:wmMetricB', NOW - 48 * h, 90_000, 'error', ok);
  await turn(tenant, 'wecom:wmMetricC', NOW - 100 * h, 5000, 'replied', [
    { model: 'm', error: null },
    { model: 'm', error: 'http_5xx' },
  ]);
  await turn(tenant, 'wecom:wmMetricC', NOW - 99 * h, 6000, 'replied', ok);
  await turn(tenant, 'wecom:wmMetricC', NOW - 98 * h, 70_000, 'handoff', ok);
  await turn(tenant, 'wecom:wmMetricC', NOW - 97 * h, 80_000, 'handoff');
  await turn(tenant, 'wecom:wmMetricD', since, 7000, 'replied', ok);
  await turn(tenant, 'wecom:wmMetricD', NOW - 2 * h, 10, 'deterministic');
  await turn(tenant, 'wecom:wmMetricD', NOW - h, 0, 'silent');
  await turn(tenant, 'wecom:wmMetricD', since - 60_000, 100_000, 'handoff', ok);
  await turn(tenant, 'wecom:wmMetricD', since - 6 * h, 200_000, 'replied', [{ model: 'm', error: 'timeout' }]);
  await turn(other, 'wecom:wmMetricX', NOW - h, 999_000, 'replied', ok);
  await turn(other, 'wecom:wmMetricX', NOW - h, 999_000, 'handoff', [{ model: 'm', error: 'timeout' }]);
  const cost = async (tid: string, day: string, purpose: string, milli: number): Promise<void> => {
    await exec(`insert into usage_daily (tenant_id, day, model, purpose, calls, cost_milli_cny) values ($1, $2::date, 'm', $3, 1, $4)`, [
      tid,
      day,
      purpose,
      milli,
    ]);
  };
  await cost(tenant, shDay(0), 'chat', 1234);
  await cost(tenant, shDay(0), 'embedding', 66);
  await cost(tenant, shDay(-1), 'chat', 2000);
  await cost(tenant, shDay(-6), 'chat', 500);
  await cost(tenant, shDay(-7), 'chat', 9000);
  await cost(other, shDay(0), 'chat', 777_777);
}
/** 手算：replied 的七个 1000…7000，percentile_cont(0.9) = 第 5.4 位 = 6000 + 0.4 × 1000 */
const WANT7 = {
  days: 7,
  turns: 13,
  replyP90Ms: 6400,
  handoffRate: 2 / 4,
  aiErrorRate: 2 / 13,
  costTodayYuan: 1.3,
  costRangeYuan: 3.8,
};
const close = (a: unknown, b: number | null): boolean => (b === null ? a === null : typeof a === 'number' && Math.abs(a - b) < 1e-9);
const sameView = (got: Record<string, unknown>, want: Record<string, number | null>): boolean =>
  Object.keys(want).every((k) => close(got[k], want[k]!)) && Object.keys(got).length === Object.keys(want).length;

await seedMetrics((text, params) => su(text, params), DEMO, OTHER);

// ---------------- 窗口与「今天」按服务器时区 ----------------
{
  const w = metricsWindow(NOW, 7);
  check(
    '窗口：近 7 个自然日（含今天）从上海时区 6 天前那天的 0 点起，today 是上海的日期（UTC 那天的次日）',
    w.today === shDay(0) &&
      w.sinceDay === shDay(-6) &&
      w.since.getHours() === 0 &&
      w.since.getMinutes() === 0 &&
      w.today !== utcDay &&
      new Date(NOW).getHours() === 1,
    json({ w, utcDay }),
  );
  check('窗口：days=1 只有今天', metricsWindow(NOW, 1).sinceDay === shDay(0) && metricsWindow(NOW, 1).today === shDay(0));
}

// ---------------- 四个数与手算一致，逐字段 ----------------
__metricsTest.reset();
{
  const r = await api('GET', '/metrics?days=7', { token: tokens.owner });
  check('owner：/metrics?days=7 → 200，各项与手算一致', r.status === 200 && sameView(r.body, WANT7), json(r.body));
  check('replyP90Ms 只算 replied（全算的话是 78000）', r.body.replyP90Ms === 6400, String(r.body.replyP90Ms));
  check('handoffRate 按会话：4 个有轮次的会话里 2 个转过人工（按轮次是 3/13）', close(r.body.handoffRate, 0.5), String(r.body.handoffRate));
  check(
    'aiErrorRate：outcome=error 的一轮加上 llm 里第二次出错的一轮（只看 outcome 或只看 llm 都是 1/13）',
    close(r.body.aiErrorRate, 2 / 13),
    String(r.body.aiErrorRate),
  );
  check('costTodayYuan：上海时区今天的两笔（按 UTC 的「今天」是 2.0）', close(r.body.costTodayYuan, 1.3), String(r.body.costTodayYuan));
  check('costRangeYuan：窗口内四笔，窗口外与别的租户不算', close(r.body.costRangeYuan, 3.8), String(r.body.costRangeYuan));
  const d = await api('GET', '/metrics', { token: tokens.admin });
  check('admin：不带 days 默认 7，结果相同', d.status === 200 && sameView(d.body, WANT7), json(d.body));
  const month = await api('GET', '/metrics?days=30', { token: tokens.owner });
  check(
    'days=30：窗口外那两轮与 7 天前那笔用量进来了',
    month.status === 200 &&
      sameView(month.body, {
        days: 30,
        turns: 15,
        // replied 八个：1000…7000 与窗口外那轮 200000，第 6.3 位
        replyP90Ms: Math.round(7000 + 0.3 * (200_000 - 7000)),
        handoffRate: 3 / 4,
        aiErrorRate: 3 / 15,
        costTodayYuan: 1.3,
        costRangeYuan: 12.8,
      }),
    json(month.body),
  );
  const today = await api('GET', '/metrics?days=1', { token: tokens.owner });
  check(
    'days=1：只有上海时区今天 0 点（UTC 前一天 16:00）之后的轮次（一轮）与今天的用量',
    today.status === 200 && today.body.turns === 1 && close(today.body.costRangeYuan, 1.3) && close(today.body.costTodayYuan, 1.3),
    json(today.body),
  );
}

// ---------------- 60 秒缓存（按租户与 days） ----------------
{
  const q0 = queryCount();
  await api('GET', '/me', { token: tokens.owner });
  const perSession = queryCount() - q0;
  await su(
    `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
     values ($1, gen_random_uuid(), 'wecom:wmMetricA', $2, 100, 'replied', repeat('a', 64), '{}', '[]', '[]')`,
    [DEMO, new Date(NOW - 60_000).toISOString()],
  );
  clockAt = NOW + 59_000;
  const q1 = queryCount();
  const cached = await api('GET', '/metrics?days=7', { token: tokens.owner });
  check(
    '缓存：59 秒内再读是缓存里的那份（新加的一轮不在里面），除了认会话不查库',
    cached.status === 200 && sameView(cached.body, WANT7) && queryCount() - q1 === perSession,
    `${json(cached.body)} 查询 ${queryCount() - q1}，认会话 ${perSession}`,
  );
  const other = await api('GET', '/metrics?days=6', { token: tokens.owner });
  check(
    '缓存按 days 分开：days=6 现算，看得见新加的那一轮',
    other.status === 200 && other.body.days === 6 && (other.body.turns as number) > 0,
  );
  const q2 = queryCount();
  const sixAgain = await api('GET', '/metrics?days=6', { token: tokens.owner });
  check('缓存：days=6 再读一次不查库', sixAgain.status === 200 && queryCount() - q2 === perSession, String(queryCount() - q2));
  clockAt = NOW + 60_000;
  const fresh = await api('GET', '/metrics?days=7', { token: tokens.owner });
  check(
    '缓存：满 60 秒重算，新加的一轮算进去了',
    fresh.status === 200 && fresh.body.turns === 14 && close(fresh.body.aiErrorRate, 2 / 14),
    json(fresh.body),
  );
  clockAt = NOW;
}

// ---------------- 角色与参数 ----------------
{
  for (const role of ['supervisor', 'agent', 'viewer'] as const) {
    const r = await api('GET', '/metrics?days=7', { token: tokens[role] });
    check(`${role}：/metrics → 403 forbidden`, r.status === 403 && r.body.error === 'forbidden' && !('turns' in r.body), json(r));
  }
  const anon = await api('GET', '/metrics?days=7');
  check('匿名（demo profile）：/metrics → 401', anon.status === 401 && anon.body.error === 'unauthorized', json(anon));
  for (const days of ['0', '91', '-1', '7.5', 'abc', '']) {
    const r = await api('GET', `/metrics?days=${days}`, { token: tokens.owner });
    check(`days=${days || '（空）'} → 400 bad_request`, r.status === 400 && r.body.error === 'bad_request', json(r));
  }
  const max = await api('GET', '/metrics?days=90', { token: tokens.admin });
  check('days=90（trace 默认保留期）→ 200', max.status === 200 && max.body.days === 90, json(max.body));
}

// ---------------- 窗口按租户的 trace 保留期截断：trace 与费用同一个窗口，days 返回实际天数 ----------------
{
  await su('update tenants set retention_trace_days = 30 where id = $1', [DEMO]);
  // 保留期之外、请求的 90 天之内：40 天前的一轮（清理还没跑，库里还在）与一笔用量
  const old = new Date(NOW);
  old.setDate(old.getDate() - 40);
  await su(
    `insert into turn_traces (tenant_id, id, conversation_id, started_at, duration_ms, outcome, prefix_hash, catalog_versions, calls, llm)
     values ($1, gen_random_uuid(), 'wecom:wmMetricA', $2, 100, 'replied', repeat('a', 64), '{}', '[]', '[]')`,
    [DEMO, old.toISOString()],
  );
  await su(`insert into usage_daily (tenant_id, day, model, purpose, calls, cost_milli_cny) values ($1, $2::date, 'm', 'chat', 1, 4000)`, [
    DEMO,
    shDay(-40),
  ]);
  __metricsTest.reset();
  const r = await api('GET', '/metrics?days=90', { token: tokens.owner });
  check(
    '保留期 30、请求 90：days=30，轮次与费用都按 30 天算（40 天前的那一轮与那笔 4 元用量不算；按 90 天是 17 轮、16.8 元）',
    r.status === 200 && r.body.days === 30 && r.body.turns === 16 && close(r.body.costRangeYuan, 12.8) && close(r.body.costTodayYuan, 1.3),
    json(r.body),
  );
  const q0 = queryCount();
  await api('GET', '/me', { token: tokens.owner });
  const perSession = queryCount() - q0;
  const q1 = queryCount();
  const sixty = await api('GET', '/metrics?days=60', { token: tokens.owner });
  check(
    '缓存键是实际天数：请求 60 也截到 30，用的是刚才那份（保留期也在缓存里，除了认会话不查库）',
    sixty.status === 200 && json(sixty.body) === json(r.body) && queryCount() - q1 === perSession,
    `${json(sixty.body)} 查询 ${queryCount() - q1}`,
  );
  const week = await api('GET', '/metrics?days=7', { token: tokens.owner });
  check('保留期 30、请求 7：照旧 7 天', week.status === 200 && week.body.days === 7, json(week.body));
  await su('update tenants set retention_trace_days = 90 where id = $1', [DEMO]);
  __metricsTest.reset();
}

// ---------------- 真实 Postgres：agent_app 经 RLS 读同一份数据 ----------------
{
  const PG_TEST_URL = process.env.PG_TEST_URL;
  if (!PG_TEST_URL) {
    if (process.env.CI === 'true') fails.push('CI 下必须设 PG_TEST_URL：运行数字的 SQL 要在真实 Postgres 上跑一遍，不能静默跳过');
    else console.log('OPS SELFTEST：没有 PG_TEST_URL，跳过真实 Postgres 部分（运行数字的 SQL 经 agent_app 与 RLS）');
  } else {
    const { createRealPgFixture } = await import('../db/testing.js');
    const { openDb } = await import('../db/client.js');
    const fxr = await createRealPgFixture(PG_TEST_URL);
    try {
      const [o] = await fxr.query<{ id: string }>(
        `insert into tenants (slug, name, pack_id) values ('other', 'other', 'travel') returning id`,
      );
      await seedMetrics((text, params) => fxr.query(text, params), fxr.tenantId, o!.id);
      const app = await openDb(fxr.urls.app, { max: 1 });
      try {
        const ctx = { tenantId: fxr.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
        const m = await withTenant(app.db, ctx, (tx) => readMetrics(tx, metricsWindow(NOW, 7)), { readOnly: true });
        check(
          '真实 PG：agent_app 读到的四个数与手算一致（别的租户被 RLS 挡住）',
          m.turns === 13 &&
            close(m.replyP90Ms, 6400) &&
            close(m.handoffRate, 0.5) &&
            close(m.aiErrorRate, 2 / 13) &&
            m.costTodayMilliCny === 1300 &&
            m.costRangeMilliCny === 3800,
          json(m),
        );
        const keep = await withTenant(app.db, ctx, (tx) => readTraceRetentionDays(tx, fxr.tenantId), { readOnly: true });
        await fxr.query('update tenants set retention_trace_days = 30 where id = $1', [fxr.tenantId]);
        const keep30 = await withTenant(app.db, ctx, (tx) => readTraceRetentionDays(tx, fxr.tenantId), { readOnly: true });
        check(
          '真实 PG：agent_app 在只读事务里读得到本租户的 trace 保留期（默认 90，改成 30 之后是 30）',
          keep === 90 && keep30 === 30,
          `${keep} ${keep30}`,
        );
        const [e] = await fxr.query<{ id: string }>(
          `insert into tenants (slug, name, pack_id) values ('empty', 'empty', 'travel') returning id`,
        );
        const none = await withTenant(app.db, { ...ctx, tenantId: e!.id }, (tx) => readMetrics(tx, metricsWindow(NOW, 90)), {
          readOnly: true,
        });
        check(
          '真实 PG：没有轮次的租户（别人的行 RLS 看不到）三个比率是 null、费用是 0',
          none.turns === 0 &&
            none.replyP90Ms === null &&
            none.handoffRate === null &&
            none.aiErrorRate === null &&
            none.costRangeMilliCny === 0,
          json(none),
        );
      } finally {
        await app.close();
      }
    } finally {
      await fxr.drop();
    }
  }
}
__consoleTest.reset();

// ================ OpenTelemetry：配了端点（进程内的假接收端） ================
const finished: import('../trace/recorder.js').FinishedTurn[] = [];
recorder.onTurnEnd((f) => finished.push(f));
async function say(
  sid: string,
  text: string,
  steps: Step[],
  channel = 'wecom',
): Promise<{ text: string; turn: (typeof finished)[number] }> {
  script.push(...steps);
  const from = finished.length;
  let reply = '';
  try {
    reply = (await handleMessage(sid, text, channel)).text;
  } catch (e) {
    reply = `抛错：${e instanceof Error ? e.message : String(e)}`;
  }
  await store.flushSession(sid).catch(() => undefined);
  const got = finished.slice(from).filter((f) => f.turn.conversationId === sid);
  check(
    `${sid}「${text}」：这一轮恰好一条，模型脚本恰好用完`,
    got.length === 1 && script.length === 0,
    `${got.length} 条，剩 ${script.length} 步`,
  );
  script.length = 0;
  return { text: reply, turn: got[0]! };
}

// ---------------- gen_ai.provider.name：LLM_PROVIDER，没有就按 LLM_BASE_URL 的主机名 ----------------
{
  const saved = { p: process.env.LLM_PROVIDER, b: process.env.LLM_BASE_URL };
  const cases: [string, string | undefined, string][] = [
    ['', 'https://api.deepseek.com/v1', 'deepseek'],
    ['', 'https://deepseek.com', 'deepseek'],
    ['', 'https://open.bigmodel.cn/api/paas/v4', 'zhipu'],
    ['', undefined, 'zhipu'],
    ['', fakeLlmUrl, 'openai_compatible'],
    ['', 'https://deepseek.com.example.net/v1', 'openai_compatible'],
    ['', '不是地址', 'openai_compatible'],
    ['DeepSeek', fakeLlmUrl, 'deepseek'],
    ['zhipu', 'https://api.deepseek.com/v1', 'zhipu'],
  ];
  const got = cases.map(([p, b]) => {
    process.env.LLM_PROVIDER = p;
    if (b === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = b;
    return providerName();
  });
  process.env.LLM_PROVIDER = saved.p;
  process.env.LLM_BASE_URL = saved.b;
  check(
    'gen_ai.provider.name：LLM_PROVIDER 优先；没写时 deepseek.com 是约定的 deepseek，bigmodel.cn 与没设是 zhipu，其余是自定义的 openai_compatible（没有 _OTHER）',
    got.every((g, i) => g === cases[i]![2]),
    json(got),
  );
}

// ---------------- boot()：只有设了端点才调 startOtel；它失败也照常启动 ----------------
const bootWith = async (endpoint: string, startOtel: () => Promise<void>): Promise<string[]> => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  const calls: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => void calls.push(`error:${a.map(String).join(' ')}`);
  try {
    await boot({
      initConfig: async () => void calls.push('config'),
      initSessionStore: async () => void calls.push('store'),
      initChannels: async () => {},
      serve: (onListening) => {
        calls.push('serve');
        onListening();
      },
      preflight: () => {},
      buildIndex: async () => {},
      // 自测只看 startOtel 的位置：两种存储的后台任务都不起
      storeMode: () => 'file',
      startFollowUpScheduler: () => {},
      startJobs: () => {},
      startChannels: () => void calls.push('wecom'),
      exit: (c) => void calls.push(`exit ${c}`),
      startOtel: async () => {
        calls.push('otel');
        await startOtel();
      },
    });
  } finally {
    console.error = origErr;
  }
  return calls;
};
{
  check('boot：没设端点不调 startOtel', json(await bootWith('', async () => {})) === json(['config', 'store', 'serve', 'wecom']));
  check('boot：端点只有空白也不调', !(await bootWith('   ', async () => {})).includes('otel'));
  const failing = await bootWith(otlpUrl, async () => {
    throw new Error('模拟的加载失败');
  });
  check(
    'boot：设了端点在会话存储之后、监听之前调；它失败只记一行，照常监听、起企微',
    failing[0] === 'config' &&
      failing[1] === 'store' &&
      failing[2] === 'otel' &&
      failing[3]!.startsWith('error:[boot] OpenTelemetry 没起来') &&
      json(failing.slice(4)) === json(['serve', 'wecom']),
    json(failing),
  );
  check('前提：到这里本进程还没加载任何 @opentelemetry/*', otelLoaded() === 0, String(otelLoaded()));
  process.env.APP_REVISION = 'v-ops-selftest';
  process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '1000';
  const ok = await bootWith(otlpUrl, startOtelExport);
  check('boot：设了端点，真的 startOtelExport 起来了', json(ok) === json(['config', 'store', 'otel', 'serve', 'wecom']), json(ok));
  check('设了端点之后才加载 @opentelemetry/*', otelLoaded() > 0);
}
const otel = await import('../otel/export.js');
const flush = async (): Promise<Got[]> => {
  await otel.flushOtel();
  return spansReceived();
};
const ns = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const refOf = async (sid: string): Promise<string | null> =>
  (await su<{ ref: string }>('select ref from conversations where id = $1', [sid]))[0]?.ref ?? null;

/** 这一轮的 span 树：根（app.turn.id）与同一 trace 的其余 span */
function treeOf(all: Got[], turnId: string): { root: Got | null; kids: Got[] } {
  const roots = all.filter((g) => g.attrs['app.turn.id'] === turnId && !g.span.parentSpanId);
  const root = roots.length === 1 ? roots[0]! : null;
  return { root, kids: root ? all.filter((g) => g.span.traceId === root.span.traceId && g !== root) : [] };
}

// ---------------- 一轮：两次模型调用、预取与模型要的工具、价格护栏删一句 ----------------
const EXT = 'wmOtelPrivacyX9'; // external_userid：span 里任何时候不许出现
const SAID = '想去云南玩，大概七月份';
const DROPPED = '当地包车一天只要 1,234 元。';
const RAW = `云南这边有丽江大理·洱海古城 6 日，每人 16,800 元起。${DROPPED}您几位出行呢？`;
{
  const sid = `wecom:${EXT}`;
  receiver.bodies.length = 0;
  const { text, turn: f } = await say(sid, SAID, [
    { toolCalls: [{ name: 'search_routes', args: { destination: '云南', note: '要洱海' } }] },
    { content: RAW },
  ]);
  check('前提：护栏删了一句，回复照发', !text.includes('1,234') && text.includes('16,800'), text);
  const all = await flush();
  const ref = await refOf(sid);
  const { root, kids } = treeOf(all, f.turn.turnId);
  check('一轮一条 trace：恰好一个根 span', !!root, json(all.map((g) => g.span.name)));
  check(
    '前提：这一轮有两次模型调用、至少一次工具调用、一个价格护栏事件',
    f.turn.llm.length === 2 && f.turn.calls.length >= 1 && f.turn.guards.some((g) => g.guard === 'price'),
    json({ llm: f.turn.llm.length, calls: f.turn.calls.map((c) => c.name), guards: f.turn.guards.map((g) => g.guard) }),
  );
  check(
    '会话引用：新会话第一轮就带上库里的 ref（建写队列时生成、插入时写进去），与 store.conversationRef 相同',
    !!ref && store.conversationRef(sid) === ref,
    `${ref} ${store.conversationRef(sid)}`,
  );
  if (root) {
    const r = root.attrs;
    check(
      '根 span：invoke_agent <行业包>，起止是这一轮的开始与结束',
      root.span.name === 'invoke_agent travel' &&
        root.span.kind === 1 &&
        String(root.span.startTimeUnixNano) === ns(f.turn.startedAt) &&
        String(root.span.endTimeUnixNano) === ns(f.turn.startedAt + f.durationMs),
      json(root.span),
    );
    check(
      '根 span 的属性：gen_ai.* 与 app.*、Langfuse 的会话与用户都是 ref、trace 名 turn',
      r['gen_ai.operation.name'] === 'invoke_agent' &&
        r['gen_ai.agent.name'] === 'travel' &&
        r['gen_ai.provider.name'] === 'openai_compatible' &&
        r['gen_ai.conversation.id'] === ref &&
        r['app.turn.outcome'] === 'replied' &&
        r['app.sop.version'] === f.turn.sopVersion &&
        typeof f.turn.sopVersion === 'number' &&
        r['app.prefix.hash'] === f.turn.prefixHash &&
        /^[0-9a-f]{64}$/.test(f.turn.prefixHash) &&
        r['app.tenant'] === 'demo' &&
        r['app.channel'] === 'wecom' &&
        r['langfuse.session.id'] === ref &&
        r['langfuse.user.id'] === ref &&
        r['langfuse.trace.name'] === 'turn' &&
        !('error.type' in r) &&
        root.span.status?.code !== 2,
      json(r),
    );
    check(
      '每个 span 都带 gen_ai.conversation.id（约定里推理与工具 span「有就写」）与 Langfuse 的会话、用户，都是 ref',
      kids.length > 0 &&
        [root, ...kids].every(
          (g) => g.attrs['gen_ai.conversation.id'] === ref && g.attrs['langfuse.session.id'] === ref && g.attrs['langfuse.user.id'] === ref,
        ),
      json(kids.map((k) => [k.span.name, k.attrs['gen_ai.conversation.id']])),
    );
    check(
      'resource：service.name=wecom-sales-agent、service.version=APP_REVISION',
      root.resource['service.name'] === 'wecom-sales-agent' && root.resource['service.version'] === 'v-ops-selftest',
      json(root.resource),
    );
    check(
      '这一轮的 span 恰好是根加上每次模型调用、工具调用与护栏事件各一个，父亲都是根',
      kids.length === f.turn.llm.length + f.turn.calls.length + f.turn.guards.length &&
        kids.every((k) => k.span.parentSpanId === root.span.spanId),
      json(kids.map((k) => [k.span.name, k.span.parentSpanId])),
    );
    const chats = kids.filter((k) => k.attrs['gen_ai.operation.name'] === 'chat');
    check(
      'chat span：逐次对上模型、用量、起止时刻（CLIENT）',
      chats.length === 2 &&
        f.turn.llm.every((c, i) => {
          const s = chats.find((k) => String(k.span.startTimeUnixNano) === ns(c.startedAt));
          return (
            !!s &&
            s.span.name === 'chat glm-5.3-flashx' &&
            s.span.kind === 3 &&
            String(s.span.endTimeUnixNano) === ns(c.startedAt + c.ms) &&
            s.attrs['gen_ai.provider.name'] === 'openai_compatible' &&
            s.attrs['gen_ai.request.model'] === 'glm-5.3-flashx' &&
            s.attrs['gen_ai.response.model'] === c.model &&
            s.attrs['gen_ai.usage.input_tokens'] === c.promptTokens &&
            s.attrs['gen_ai.usage.output_tokens'] === c.completionTokens &&
            s.attrs['app.llm.cached_tokens'] === c.cachedTokens &&
            c.promptTokens > 0 &&
            s.attrs['app.llm.hedged'] === false &&
            !('error.type' in s.attrs) &&
            s.attrs['langfuse.session.id'] === ref &&
            i >= 0
          );
        }) &&
        f.turn.llm[1]!.startedAt >= f.turn.llm[0]!.startedAt + f.turn.llm[0]!.ms,
      json(chats.map((c) => c.attrs)),
    );
    const tools = kids.filter((k) => k.attrs['gen_ai.operation.name'] === 'execute_tool');
    check(
      'execute_tool span：逐个对上工具名、是否预取、起止时刻，默认没有参数',
      tools.length === f.turn.calls.length &&
        f.turn.calls.every((c) =>
          tools.some(
            (s) =>
              s.span.name === `execute_tool ${c.name}` &&
              s.attrs['gen_ai.tool.name'] === c.name &&
              s.attrs['app.tool.prefetch'] === c.prefetch &&
              String(s.span.startTimeUnixNano) === ns(c.startedAt) &&
              String(s.span.endTimeUnixNano) === ns(c.startedAt + c.ms) &&
              !('gen_ai.tool.call.arguments' in s.attrs) &&
              s.attrs['langfuse.user.id'] === ref,
          ),
        ) &&
        f.turn.calls.some((c) => !c.prefetch && c.name === 'search_routes'),
      json(tools.map((s) => [s.span.name, s.attrs])),
    );
    const guards = kids.filter((k) => k.span.name.startsWith('guard '));
    const price = f.turn.guards.find((g) => g.guard === 'price')!;
    check(
      'guard span：guard <名字>、动作与删去 / 补上的句数，起止都是记下事件的那一刻',
      guards.length === f.turn.guards.length &&
        guards.some(
          (s) =>
            s.span.name === 'guard price' &&
            s.attrs['app.guard.action'] === price.action &&
            s.attrs['app.guard.removed'] === price.removed.length &&
            s.attrs['app.guard.added'] === price.added.length &&
            price.removed.length === 1 &&
            String(s.span.startTimeUnixNano) === ns(price.at) &&
            String(s.span.endTimeUnixNano) === ns(price.at),
        ),
      json(guards.map((s) => [s.span.name, s.attrs])),
    );
    check(
      '子 span 都落在根的起止之内',
      kids.every(
        (k) =>
          BigInt(k.span.startTimeUnixNano) >= BigInt(root.span.startTimeUnixNano) &&
          BigInt(k.span.endTimeUnixNano) <= BigInt(root.span.endTimeUnixNano),
      ),
    );
  }
  const raw = receiver.bodies.join('\n');
  check(
    '不变量 49：默认没有原文——客户原话、最终回复、模型原稿、工具参数与结果都不在导出里',
    !raw.includes(SAID) &&
      !raw.includes('七月') &&
      !raw.includes('16,800') &&
      !raw.includes('1,234') &&
      !raw.includes('洱海') &&
      !raw.includes('要洱海') &&
      !raw.includes('gen_ai.input.messages') &&
      !raw.includes('gen_ai.output.messages') &&
      !raw.includes('gen_ai.tool.call.arguments') &&
      !raw.includes('gen_ai.tool.call.result'),
    raw.slice(0, 400),
  );
  check('不变量 49：任何时候没有 external_userid 与会话原 id', !raw.includes(EXT) && !raw.includes('wecom:'), raw.slice(0, 200));
  const row = (
    await su<{ calls: Record<string, unknown>[]; llm: Record<string, unknown>[] }>('select calls, llm from turn_traces where id = $1', [
      f.turn.turnId,
    ])
  )[0];
  check(
    'trace 行的形状不变：开始时刻只在内存，calls 与 llm 里没有 startedAt',
    !!row &&
      row.calls.length === f.turn.calls.length &&
      row.calls.every((c) => !('startedAt' in c)) &&
      row.llm.every((c) => !('startedAt' in c)),
    json(row),
  );
}

// ---------------- OTEL_CAPTURE_CONTENT=1：才有客户原话、最终回复与工具参数 ----------------
{
  process.env.OTEL_CAPTURE_CONTENT = '1';
  const sid = `wecom:${EXT}`;
  const said = '那就云南吧，我们两个人';
  receiver.bodies.length = 0;
  const { text, turn: f } = await say(sid, said, [
    { toolCalls: [{ name: 'search_routes', args: { destination: '云南', note: '两人' } }] },
    { content: '好的～两位的话这条很合适，大概几月出发呢？' },
  ]);
  process.env.OTEL_CAPTURE_CONTENT = '';
  const all = await flush();
  const { root, kids } = treeOf(all, f.turn.turnId);
  const parse = (v: unknown): { role: string; parts: { type: string; content: string }[] }[] => JSON.parse(String(v));
  check(
    'OTEL_CAPTURE_CONTENT=1：根 span 带本轮客户原话与最终回复（约定的 messages 写法）',
    !!root &&
      parse(root.attrs['gen_ai.input.messages'])[0]?.role === 'user' &&
      parse(root.attrs['gen_ai.input.messages'])[0]?.parts[0]?.content === said &&
      parse(root.attrs['gen_ai.output.messages'])[0]?.role === 'assistant' &&
      parse(root.attrs['gen_ai.output.messages'])[0]?.parts[0]?.content === text &&
      text.length > 0,
    json(root?.attrs),
  );
  const tool = kids.find((k) => k.attrs['gen_ai.tool.name'] === 'search_routes' && k.attrs['app.tool.prefetch'] === false);
  const call = f.turn.calls.find((c) => c.name === 'search_routes' && !c.prefetch);
  check(
    'OTEL_CAPTURE_CONTENT=1：execute_tool 带执行时的参数，结果照样不写',
    !!tool &&
      !!call &&
      tool.attrs['gen_ai.tool.call.arguments'] === json(call.args) &&
      json(call.args).includes('两人') &&
      !('gen_ai.tool.call.result' in tool.attrs),
    json(tool?.attrs),
  );
  const raw = receiver.bodies.join('\n');
  check('OTEL_CAPTURE_CONTENT=1 也没有 external_userid 与会话原 id', !raw.includes(EXT) && !raw.includes('wecom:'));
}

// ---------------- 模型出错的一轮：chat 带 error.type、根标出错 ----------------
{
  const sid = 'wecom:wmOtelErr';
  receiver.bodies.length = 0;
  const { turn: f } = await say(sid, '在吗', [{ status: 503 }]);
  const { root, kids } = treeOf(await flush(), f.turn.turnId);
  const chat = kids.find((k) => k.attrs['gen_ai.operation.name'] === 'chat');
  check(
    '出错的轮次：根 outcome=error、状态 ERROR、error.type 取出错的模型调用的类别；chat 带 error.type=http_5xx、状态 ERROR、没有用量与 response.model',
    f.outcome === 'error' &&
      root?.attrs['app.turn.outcome'] === 'error' &&
      root.span.status?.code === 2 &&
      root.attrs['error.type'] === 'http_5xx' &&
      chat?.attrs['error.type'] === 'http_5xx' &&
      chat.span.status?.code === 2 &&
      !('gen_ai.usage.input_tokens' in chat.attrs) &&
      !('gen_ai.response.model' in chat.attrs) &&
      chat.attrs['gen_ai.request.model'] === 'glm-5.3-flashx',
    json({ root: root?.attrs, chat: chat?.attrs, status: root?.span.status }),
  );
  // 出错不在模型调用上（llm 里没有出错的一项）：根的 error.type 是兜底的 _OTHER
  const synthetic = {
    ...f,
    turn: { ...f.turn, turnId: 'otel-selftest-error-no-llm', llm: f.turn.llm.map((c) => ({ ...c, error: null })) },
  };
  receiver.bodies.length = 0;
  otel.exportTurn(synthetic, {
    tenant: 'demo',
    conversationRef: 'otel-selftest-ref',
    channel: 'wecom',
    agent: 'travel',
    provider: 'zhipu',
    requestModel: 'glm-5.3-flashx',
  });
  const s = treeOf(await flush(), synthetic.turn.turnId).root;
  check(
    '出错的轮次、模型调用都没出错：根 error.type=_OTHER、状态 ERROR',
    s?.attrs['error.type'] === '_OTHER' && s.span.status?.code === 2,
    json(s?.attrs),
  );
}

// ---------------- 执行时抛错的工具调用：真实耗时、error.type=_OTHER、状态 ERROR；trace 行形状不变 ----------------
{
  // recorder 直接造一轮：工具挂 40 毫秒后抛错
  const sid = 'sim-ops-tool-fail';
  const args: Record<string, unknown> = { routeId: 'R-NOPE' };
  const from = finished.length;
  await recorder.withTurnScope(async () => {
    recorder.startTurn(sid, '在吗');
    recorder.traceToolCall('create_quote', args, sid);
    await new Promise((r) => setTimeout(r, 40));
    recorder.noteToolError(args);
    recorder.endTurn('replied', '好的', 'greeting', 'greeting');
  });
  const u = finished.slice(from).find((x) => x.turn.conversationId === sid);
  const c = u?.turn.calls[0];
  check(
    'recorder：执行时抛错的工具调用记下真实耗时、执行时的参数与只在内存的失败标记，没有结果',
    // 定时器按单调时钟走，用 Date.now() 量可能少 1 毫秒（CI 上见过 39），留一点余量
    !!c && c.ms >= 35 && c.failed === true && c.resultBytes === 0 && c.resultHead === '' && json(c.args) === json(args),
    json(c),
  );
  // 这一轮已经经 onTurnEnd 交给导出器了（startOtelExport 订阅的），这里只 flush
  const tool = treeOf(await flush(), u?.turn.turnId ?? '-').kids.find((k) => k.attrs['gen_ai.operation.name'] === 'execute_tool');
  check(
    '导出：这次工具调用的 span 用真实耗时（不是 0 毫秒）、error.type=_OTHER、状态 ERROR',
    !!tool &&
      !!c &&
      String(tool.span.startTimeUnixNano) === ns(c.startedAt) &&
      String(tool.span.endTimeUnixNano) === ns(c.startedAt + c.ms) &&
      tool.attrs['error.type'] === '_OTHER' &&
      tool.span.status?.code === 2,
    json(tool),
  );

  // 真引擎：模型要报价的线路不存在，executeTool 抛错（llm.ts 把错误交回模型，这一轮照常回复）
  const real = 'wecom:wmOtelToolFail';
  receiver.bodies.length = 0;
  const { text, turn: f } = await say(real, '这条线两个人多少钱', [
    { toolCalls: [{ name: 'create_quote', args: { routeId: 'R-OTEL-NOPE', travelers: 2 } }] },
    { content: '抱歉，这条线路暂时查不到，我帮您换一条看看～' },
  ]);
  const call = f.turn.calls.find((x) => x.name === 'create_quote');
  const { kids } = treeOf(await flush(), f.turn.turnId);
  const span = kids.find((k) => k.span.name === 'execute_tool create_quote');
  const ok = kids.filter((k) => k.attrs['gen_ai.operation.name'] === 'execute_tool' && k !== span);
  check(
    '真引擎：工具执行时抛错，这一轮照常回复；recorder 记了失败，span 带 error.type=_OTHER、状态 ERROR，起止是记下的时刻',
    f.outcome === 'replied' &&
      text.includes('换一条') &&
      call?.failed === true &&
      !!span &&
      span.attrs['error.type'] === '_OTHER' &&
      span.span.status?.code === 2 &&
      String(span.span.endTimeUnixNano) === ns(call.startedAt + call.ms) &&
      ok.every((k) => !('error.type' in k.attrs) && k.span.status?.code !== 2),
    json({ call, span: span?.attrs, status: span?.span.status }),
  );
  const row = (await su<{ calls: Record<string, unknown>[] }>('select calls from turn_traces where id = $1', [f.turn.turnId]))[0];
  const stored = row?.calls.find((x) => x.name === 'create_quote');
  check(
    'trace 行的形状不变：失败标记只在内存，calls 里没有 failed，耗时是记下的那个、没有结果',
    !!stored && !('failed' in stored) && !('startedAt' in stored) && stored.ms === call?.ms && stored.resultBytes === 0,
    json(row),
  );
}

// ---------------- 没有 ref 的会话（demo 类，文件存储同一条路）：按会话 id 算的匿名引用 ----------------
{
  const a = 'wecom:cust_OtelQz7K';
  const b = 'wecom:cust_OtherQz7K';
  check('前提：这两个会话的短码相同（末 4 位），都没有 ref', shortIdOf(a) === 'QZ7K' && shortIdOf(b) === 'QZ7K');
  receiver.bodies.length = 0;
  const ta = await say(a, '你好', [{ content: '您好呀～这次想去哪儿玩呢？' }]);
  const ta2 = await say(a, '云南', [{ content: '云南很不错～几位出行呢？' }]);
  const tb = await say(b, '你好', [{ content: '您好呀～这次想去哪儿玩呢？' }]);
  const all = await flush();
  const ra = treeOf(all, ta.turn.turn.turnId);
  const idA = String(ra.root?.attrs['langfuse.session.id']);
  const idA2 = treeOf(all, ta2.turn.turn.turnId).root?.attrs['langfuse.session.id'];
  const idB = treeOf(all, tb.turn.turn.turnId).root?.attrs['langfuse.session.id'];
  check(
    '没有 ref：会话、用户与 gen_ai.conversation.id 是同一个 anon-<16 位十六进制>，每个 span 都是它',
    store.conversationRef(a) === null &&
      /^anon-[0-9a-f]{16}$/.test(idA) &&
      !!ra.root &&
      [ra.root, ...ra.kids].every(
        (g) => g.attrs['langfuse.session.id'] === idA && g.attrs['langfuse.user.id'] === idA && g.attrs['gen_ai.conversation.id'] === idA,
      ),
    json(ra.root?.attrs),
  );
  check(
    '匿名引用：末 4 位相同的两个会话不同，同一会话两轮相同',
    idA2 === idA && typeof idB === 'string' && /^anon-[0-9a-f]{16}$/.test(idB) && idB !== idA,
    json({ idA, idA2, idB }),
  );
  const segs = (id: string): string[] => [...Array(id.length - 3).keys()].map((i) => id.toLowerCase().slice(i, i + 4));
  const raw = receiver.bodies.join('\n');
  check(
    '匿名引用里没有会话原 id 的任何一段（每个 4 字符片段都不在里面），导出里也没有短码、前缀与原 id',
    [a, b].every((id) => segs(id).every((seg) => !idA.includes(seg) && !String(idB).includes(seg))) &&
      !/qz7k/i.test(raw) &&
      !raw.includes('cust_') &&
      !raw.includes('wecom:'),
    json({ idA, idB }),
  );
}

// ---------------- 补建 span 时出错：这一轮不导出、只记日志，对话照常，下一轮照常导出 ----------------
{
  const sid = 'wecom:wmOtelBuild';
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  let broken: Awaited<ReturnType<typeof say>>;
  try {
    otel.__otelTest.breakNextBuild();
    broken = await say(sid, '你好', [{ content: '您好呀～这次想去哪儿玩呢？' }]);
  } finally {
    console.warn = origWarn;
  }
  const next = await say(sid, '云南', [{ content: '云南很不错～几位出行呢？' }]);
  const all = await flush();
  check(
    '补建 span 出错：这一轮照常回复、记一行「这一轮没导出」、没有它的 trace；下一轮照常导出',
    broken.turn.outcome === 'replied' &&
      broken.text.includes('想去哪儿') &&
      warns.some((w) => w.startsWith('[otel] 这一轮没导出')) &&
      !treeOf(all, broken.turn.turn.turnId).root &&
      !!treeOf(all, next.turn.turn.turnId).root,
    json(warns),
  );
}

// ---------------- 导出端点挂掉：对话照常，只记日志 ----------------
{
  const sid = `wecom:${EXT}`;
  receiver.mode = 'down';
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  const u0 = unhandled;
  let r: Awaited<ReturnType<typeof say>>;
  try {
    r = await say(sid, '有没有轻松一点的', [{ content: '有的～轻松一点的可以看看丽江大理这条。' }]);
    await otel.flushOtel();
  } finally {
    console.warn = origWarn;
    receiver.mode = 'ok';
  }
  const line = warns.find((w) => w.startsWith('[otel] 导出'));
  check('导出端点挂掉：这一轮照常回复', r.turn.outcome === 'replied' && r.text.includes('丽江大理'), r.text);
  check(
    '导出端点挂掉：只记一行日志（类别与条数），不带端点地址；没有未处理的 rejection',
    !!line && line.includes('失败') && !line.includes('127.0.0.1') && !line.includes(otlpUrl) && unhandled === u0,
    json(warns),
  );
}

// ================ 日志：JSON 兜底的字段级 redact 与连接串/Cookie（scrubLine，审查第 2–4 条） ================
const logMod = await import('../log.js');
{
  const { scrubLine } = logMod.__logTest;
  for (const [depth, obj] of [
    [4, { a: { b: { c: { password: 'DEPTH4LEAK' } } } }],
    [6, { a: { b: { c: { d: { e: { secret: 'DEPTH6LEAK' } } } } } }],
  ] as const) {
    const line = JSON.stringify(obj);
    const out = scrubLine(line);
    check(
      `不变量 32/48：第 ${depth} 层嵌套的敏感字段原样写进 JSON 行时，scrubLine 这道兜底不看深度也能盖住（pino 的 redact 只接 0–2 层）`,
      !out.includes('DEPTH') && JSON.parse(out) !== undefined,
      out,
    );
  }
  check(
    'scrubLine：字段名大小写不同、字段在数组里一样盖住',
    !scrubLine(JSON.stringify({ list: [{ Token: 'ARRLEAK1' }, { ACCESSTOKEN: 'ARRLEAK2' }] })).includes('ARRLEAK'),
  );
  check(
    'scrubLine：没命中的字段原样保留（不误伤）',
    scrubLine(JSON.stringify({ a: { b: { c: { keep: 'visible-deep' } } } })).includes('visible-deep'),
  );
  // Bearer：大小写不分，分隔符允许真实空白或 JSON 转义之后的 \t、\n 两个字符（审查第 3 条）
  check(
    'scrubLine：Bearer 大小写不分（bearer、BEARER 都盖住）',
    !scrubLine('bearer BEARLEAK1').includes('BEARLEAK1') && !scrubLine('BEARER BEARLEAK2').includes('BEARLEAK2'),
  );
  check(
    'scrubLine：JSON 转义之后的 \\t、\\n 分隔同样认得出（不是真实空白，是反斜杠加字母两个字符）',
    !scrubLine('Authorization: Bearer\\tBEARLEAK3').includes('BEARLEAK3') &&
      !scrubLine('Authorization: Bearer\\nBEARLEAK4').includes('BEARLEAK4'),
  );
  // 连接串与自由文本的 Cookie 头（审查第 4 条）
  check(
    'scrubLine：scheme://user:password@host 连接串的密码段盖掉，user 与 host 都留着',
    (() => {
      const out = scrubLine('postgres://agent_app:My$ecretPW1@10.0.0.5:5432/agent');
      return !out.includes('My$ecretPW1') && out.includes('agent_app') && out.includes('10.0.0.5:5432/agent');
    })(),
  );
  check(
    'scrubLine：自由文本里的 Cookie 头（不是 JSON 字段）一样盖住，不误伤正文别的字段',
    (() => {
      const out = scrubLine(JSON.stringify({ msg: 'Cookie: session=COOKIELEAK1; other=1', keep: 'visible-field' }));
      return !out.includes('COOKIELEAK1') && out.includes('visible-field');
    })(),
  );
}

const { __profileTest } = await import('../profile.js');
const { app: serverApp } = await import('../server.js');
{
  check(
    '03 R22 demo：所有新旧 id 与编码组合的请求路径原样保留',
    channelIdCases.every(({ raw }) => logMod.convLabelsIn(`/api/sessions/${raw}/reply`) === `/api/sessions/${raw}/reply`),
  );
  logMod.setConvRefResolver((id) => channelRefs.get(id) ?? store.conversationRef(id));
  __profileTest.use({ DEPLOY_PROFILE: 'prod', ADMIN_PASS: 'x' });
  try {
    for (const { raw, code } of channelIdCases) {
      const out = logMod.convLabelsIn(`/api/sessions/${raw}/reply`);
      check(`03 R22 prod 请求路径：${raw} 换成 ${code}`, out === `/api/sessions/${code}/reply` && channelIdsHidden(out), out);
    }
    check('03 R22 prod 请求路径：普通 web 文本与长度不对的 id 原样保留', logMod.convLabelsIn(ordinaryWebText) === ordinaryWebText);
  } finally {
    __profileTest.reset();
    logMod.setConvRefResolver(store.conversationRef);
  }
}
{
  const before = [console.log, console.info, console.warn, console.error];
  check(
    '没设 LOG_FORMAT：installJsonConsole 什么都不接、返回 false，console.* 还是原来那几个函数（纯文本逐字节不变）',
    logMod.installJsonConsole() === false && [console.log, console.info, console.warn, console.error].every((f, i) => f === before[i]),
  );
  const got: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => void got.push(`log:${a.map(String).join(' ')}`);
  console.warn = (...a: unknown[]) => void got.push(`warn:${a.map(String).join(' ')}`);
  console.error = (...a: unknown[]) => void got.push(`error:${a.map(String).join(' ')}`);
  try {
    logMod.log.info('甲', { authorization: 'Bearer X1', keep: 1 });
    logMod.log.warn('乙');
    logMod.log.error('丙', { nested: { Cookie: 'c' } });
  } finally {
    Object.assign(console, orig);
  }
  check(
    'log.* 没设 LOG_FORMAT：经 console 打纯文本（info→log），附带字段里的凭据照样盖掉',
    json(got) === json(['log:甲 {"authorization":"[已遮盖]","keep":1}', 'warn:乙', 'error:丙 {"nested":{"Cookie":"[已遮盖]"}}']),
    json(got),
  );

  const realSid = `wecom:${EXT}`; // OpenTelemetry 那几轮建的 db 存储真实会话，有 ref
  const ref = store.conversationRef(realSid);
  const sim = 'sim-0123456789abcdef01234567';
  const err = new Error('x');
  let snippet: unknown = null;
  try {
    JSON.parse('[{"id":"wecom:wmLeak77"}, 客户说的话]');
  } catch (e) {
    snippet = e;
  }
  let positioned: unknown = null;
  try {
    JSON.parse('{"a":"客户原话" y}');
  } catch (e) {
    positioned = e;
  }
  check(
    'demo profile（自测）：logQuote、convLabel、convLabelsIn 原样，logError 交回原对象（锁定套件断言的原 id 照旧）',
    logMod.logQuote('你好😀') === '你好😀' &&
      logMod.convLabel(realSid) === realSid &&
      logMod.convLabelsIn(`/api/sessions/${encodeURIComponent(realSid)}`) === `/api/sessions/${encodeURIComponent(realSid)}` &&
      logMod.logError(err) === err,
  );
  __profileTest.use({ DEPLOY_PROFILE: 'prod', ADMIN_PASS: 'x' });
  try {
    check(
      'prod：logQuote 返回「«N字»」，N 按字符数（emoji 算一个）',
      logMod.logQuote('你好😀') === '«3字»' && logMod.logQuote('') === '«0字»',
    );
    check(
      'prod：convLabel 对 db 存储的真实会话是 ref；文件存储与 demo 类会话、不在内存里的是短码',
      !!ref &&
        logMod.convLabel(realSid) === ref &&
        logMod.convLabel(sim) === '4567' &&
        logMod.convLabel('wecom:cust_A01') === 'A01' &&
        logMod.convLabel('wecom:wmNotInMemory99') === 'RY99',
      `${ref} ${logMod.convLabel(realSid)}`,
    );
    check(
      'prod：请求路径里的会话原 id（编码过的 wecom%3A 也算）换成 ref 或短码',
      logMod.convLabelsIn(`/api/sessions/${encodeURIComponent(realSid)}/reply`) === `/api/sessions/${ref}/reply` &&
        logMod.convLabelsIn(`/x/${sim}/y`) === '/x/4567/y',
    );
    check(
      'prod：logError 只留错误名与位置，JSON.parse 消息里带出的原文片段不打',
      logMod.logError(snippet) === 'SyntaxError' &&
        logMod.logError(positioned) === 'SyntaxError（位置 12）' &&
        String(snippet).includes('客户说的话'),
      `${String(logMod.logError(snippet))} / ${String(logMod.logError(positioned))}`,
    );
  } finally {
    __profileTest.reset();
  }

  // pino 的 mixin：外面什么都不带；请求里带 req；包在会话里带 tenant 与 conv；轮次里再带 turn，轮次的标注不漏到外面的请求
  const outLines: string[] = [];
  const jl = logMod.__logTest.createJsonLogger({ write: (s: string) => void outLines.push(s) });
  jl.info('外面');
  logMod.withLogContext({ req: 'req-a' }, () => {
    jl.info('请求里');
    logMod.withConversationLog(realSid, () => jl.info('会话里'));
  });
  const from = finished.length;
  await logMod.withLogContext({ req: 'req-b' }, async () => {
    await recorder.withTurnScope(async () => {
      jl.info('轮次开始之前');
      recorder.startTurn(realSid, '在吗');
      jl.info('轮次里');
      recorder.endTurn('deterministic', '在的', 'greeting', 'greeting');
    });
    jl.info('轮次之后');
  });
  const turnId = finished.slice(from).find((f) => f.turn.conversationId === realSid)?.turn.turnId;
  const by = Object.fromEntries(
    outLines.map((l) => JSON.parse(l) as Record<string, unknown>).map((d) => [String(d.msg), d] as const),
  ) as Record<string, Record<string, unknown>>;
  const fields = (k: string): string => json(Object.keys(by[k] ?? {}).filter((x) => !['level', 'time', 'msg'].includes(x)));
  check(
    'mixin：外面不带；请求里只带 req；会话里带 req、tenant、conv（ref）；轮次里带 req、tenant、conv、turn',
    fields('外面') === '[]' &&
      fields('请求里') === '["req"]' &&
      by['会话里']?.req === 'req-a' &&
      by['会话里']?.tenant === 'demo' &&
      by['会话里']?.conv === ref &&
      !('turn' in (by['会话里'] ?? {})) &&
      by['轮次里']?.req === 'req-b' &&
      by['轮次里']?.tenant === 'demo' &&
      by['轮次里']?.conv === ref &&
      !!turnId &&
      by['轮次里']?.turn === turnId,
    json(by),
  );
  check(
    '轮次开始之前不带 turn；轮次结束、回到请求里之后也不带（轮次另开一层上下文）',
    fields('轮次开始之前') === '["req"]' && fields('轮次之后') === '["req"]',
    `${fields('轮次开始之前')} ${fields('轮次之后')}`,
  );

  // x-request-id：server.ts 与 console 子应用的中间件
  const h1 = await serverApp.request('/healthz');
  const h2 = await serverApp.request('/healthz');
  const idRe = /^[0-9a-f]{16}$/;
  check(
    '/healthz 的响应带 x-request-id（16 个十六进制字符），两个请求不同',
    idRe.test(h1.headers.get('x-request-id') ?? '') && h1.headers.get('x-request-id') !== h2.headers.get('x-request-id'),
    `${h1.headers.get('x-request-id')} ${h2.headers.get('x-request-id')}`,
  );
  const big = await serverApp.request('/api/chat', { method: 'POST', body: 'x', headers: { 'content-length': String(64 << 20) } });
  check('请求体超限的 413 也带 x-request-id（中间件排在最前）', big.status === 413 && idRe.test(big.headers.get('x-request-id') ?? ''));
  const me = await serverApp.request('/api/console/me');
  check(
    'console 子应用挂在 server.ts 下：只有一个 x-request-id（里层沿用外层的，不叠两个）',
    me.status === 401 && idRe.test(me.headers.get('x-request-id') ?? ''),
    String(me.headers.get('x-request-id')),
  );
  const direct = await consoleApi.request('/api/console/me');
  check('console 子应用单独用：自己的中间件同样生成 x-request-id', idRe.test(direct.headers.get('x-request-id') ?? ''));
  let seen: Record<string, string> = {};
  const origErr = console.error;
  console.error = () => {
    seen = logMod.__logTest.contextFields();
  };
  let cb: Response;
  try {
    cb = await serverApp.request('/wecom/callback', { method: 'POST', body: 'x', headers: { 'content-length': '1' } });
  } finally {
    console.error = origErr;
  }
  check(
    '请求里打日志的那一刻，上下文里的 req 就是这个响应的 x-request-id',
    !!seen.req && seen.req === cb.headers.get('x-request-id'),
    `${seen.req} ${cb.headers.get('x-request-id')}`,
  );
}

// ================ 告警：app 侧五个键（本机假 webhook） ================
const alertMod = await import('./alert.js');
const wecom = await import('../adapters/wecom.js');
const ledger = await import('../quota/ledger.js');
const runner = await import('../jobs/runner.js');
const { __configTest, configHealth } = await import('../config/source.js');
const { enqueueJob } = await import('../db/repo/jobs.js');
// 假 webhook：ok 照收；hang 收下不回；s500 回 500；errcode 回企微的错误码；收到的都记下（含失败的那几次）
const hook = { bodies: [] as string[], hits: 0, mode: 'ok' as 'ok' | 'hang' | 's500' | 'errcode', urls: [] as string[] };
const hookSrv = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    hook.hits += 1;
    hook.urls.push(req.url ?? '');
    if (hook.mode === 'hang') return;
    res.setHeader('content-type', 'application/json');
    if (hook.mode === 's500') {
      res.statusCode = 500;
      res.end('{}');
      return;
    }
    if (hook.mode === 'errcode') {
      res.end(json({ errcode: 93000, errmsg: 'invalid webhook url' }));
      return;
    }
    hook.bodies.push(Buffer.concat(chunks).toString('utf8'));
    res.end(json({ errcode: 0, errmsg: 'ok' }));
  });
});
await new Promise<void>((r) => hookSrv.listen(0, '127.0.0.1', r));
const hookBase = `http://127.0.0.1:${(hookSrv.address() as AddressInfo).port}`;
const HOOK_KEY = 'HOOKKEY77';
const hookUrl = `${hookBase}/cgi-bin/webhook/send?key=${HOOK_KEY}`;
/** 收到的告警正文（text 消息的 content） */
const contents = (): string[] =>
  hook.bodies.map((b) => {
    const d = JSON.parse(b) as { msgtype?: string; text?: { content?: string } };
    return d.msgtype === 'text' ? String(d.text?.content) : `不是 text 消息：${b}`;
  });
/** 告警这一段里打的日志：推送失败、没配地址都只记日志，里面不许有地址 */
const alertLogs: string[] = [];
const captureAlertLogs = <T>(fn: () => Promise<T>): Promise<T> => {
  const o = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]): void => void alertLogs.push(a.map(String).join(' '));
  console.warn = grab;
  console.error = grab;
  return fn().finally(() => Object.assign(console, o));
};
let alertNow = Date.UTC(2026, 9, 3, 4, 0, 0);
const A = alertMod.__alertTest;
const defaults = A.timings();
check(
  '告警的推送参数照 spec：5 秒超时、至多重试 2 次、同一键 30 分钟去重',
  defaults.timeoutMs === 5000 && defaults.retries === 2 && defaults.dedupeMs === 30 * 60_000,
  json(defaults),
);
process.env.INSTANCE_LABEL = 'selftest';
process.env.ALERT_WEBHOOK_URL = '';
alertMod.startAlerts();
alertMod.startAlerts(); // 调两次只挂一份订阅
A.stopTimer();
A.setClock(() => alertNow);
A.setTimings({ retryDelaysMs: [20, 20] });
A.reset();
const stampRe = /^\[selftest\] (?:已恢复：)?[^\n]+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ALERT_SAID = '我电话一三九零零零零一一一一，叫李四';

await captureAlertLogs(async () => {
  // ---------------- 没配地址：只写一行 warn，什么都不发 ----------------
  {
    const n0 = alertLogs.length;
    const r = alertMod.alert('jobs', '没配地址的一条');
    await A.settle();
    const lines = alertLogs.slice(n0);
    check(
      '没配 ALERT_WEBHOOK_URL：alert() 不抛、只写一行 warn（带告警正文），webhook 一次都没收到',
      r === undefined &&
        lines.length === 1 &&
        lines[0]!.startsWith('[alert] 没配 ALERT_WEBHOOK_URL') &&
        lines[0]!.includes('没配地址的一条') &&
        hook.hits === 0,
      json(lines),
    );
    A.reset();
  }
  process.env.ALERT_WEBHOOK_URL = hookUrl;

  // ---------------- model_errors：连续 5 次失败、30 分钟去重、持续 30 分钟再发、连续 10 次成功恢复 ----------------
  {
    const ok = (sid: string, i: number) => say(sid, `好的第 ${i} 句`, [{ content: '好的～还有什么想了解的随时说。' }]);
    const bad = (sid: string, i: number) => say(sid, `${ALERT_SAID}，第 ${i} 句`, [{ status: 503 }]);
    const sid = 'wecom:wmAlertModel01';
    for (let i = 1; i <= 4; i++) await bad(sid, i);
    await A.settle();
    check('model_errors：连续 4 次失败不报', hook.bodies.length === 0, json(contents()));
    await bad(sid, 5);
    await A.settle();
    check(
      'model_errors：连续 5 次模型调用失败收到一条（失败类别、实例名、时间）',
      hook.bodies.length === 1 &&
        contents()[0]!.startsWith('[selftest] AI 模型调用连续 5 次失败（http_5xx） · ') &&
        stampRe.test(contents()[0]!),
      json(contents()),
    );
    alertNow += 10 * 60_000;
    for (let i = 6; i <= 10; i++) await bad(sid, i);
    await A.settle();
    check('不变量 50：30 分钟内再 5 次失败，不再收到', hook.bodies.length === 1, json(contents()));
    alertNow += 21 * 60_000;
    await bad(sid, 11);
    await A.settle();
    check(
      '条件持续超过 30 分钟：再失败一次又收到一条（连续 11 次）',
      hook.bodies.length === 2 && contents()[1]!.startsWith('[selftest] AI 模型调用连续 11 次失败'),
      json(contents()),
    );
    for (let i = 1; i <= 9; i++) await ok(sid, i);
    await A.settle();
    check('连续 9 次成功还不算恢复', hook.bodies.length === 2, json(contents()));
    await ok(sid, 10);
    await A.settle();
    check(
      '连续 10 次成功：收到一条「已恢复」',
      hook.bodies.length === 3 && contents()[2]!.startsWith('[selftest] 已恢复：AI 模型调用连续 10 次成功 · '),
      json(contents()),
    );
    for (let i = 12; i <= 16; i++) await bad(sid, i);
    await A.settle();
    check(
      '恢复之后又连续 5 次失败：是新的一次，马上收到',
      hook.bodies.length === 4 && contents()[3]!.startsWith('[selftest] AI 模型调用连续 5 次失败'),
      json(contents()),
    );
    for (let i = 11; i <= 20; i++) await ok(sid, i);
    await A.settle();
    check(
      '再连续 10 次成功：又一条「已恢复」',
      hook.bodies.length === 5 && contents()[4]!.includes('已恢复：AI 模型调用'),
      json(contents()),
    );
  }

  // ---------------- model_errors：最近 50 轮里 AI 出错率超过 20%（没有连续 5 次） ----------------
  {
    A.reset();
    const n0 = hook.bodies.length;
    const turn = (i: number, fail: boolean) =>
      say(`wecom:wmAlertRate${Math.floor(i / 10)}`, `第 ${i} 轮`, fail ? [{ status: 503 }] : [{ content: '好的～' }]);
    for (let i = 0; i < 50; i++) await turn(i, i % 5 === 0); // 10 / 50 = 20%
    await A.settle();
    check('最近 50 轮里出错率正好 20%：不报（要超过 20%）', hook.bodies.length === n0, json(contents().slice(n0)));
    A.reset();
    for (let i = 0; i < 49; i++) await turn(i, i % 4 === 0); // 第 49 轮时 13 / 49
    await A.settle();
    check('不满 50 轮不按出错率报', hook.bodies.length === n0, json(contents().slice(n0)));
    await turn(49, false);
    await A.settle();
    check(
      '满 50 轮、13 轮出错（26%）：收到一条',
      hook.bodies.length === n0 + 1 && contents()[n0]!.startsWith('[selftest] 最近 50 轮里 13 轮 AI 出错（26%） · '),
      json(contents().slice(n0)),
    );
  }

  // ---------------- wecom_send：取不到 access_token 立即、10 分钟内 3 个分段最终失败、10 分钟没有失败恢复 ----------------
  {
    A.reset();
    const n0 = hook.bodies.length;
    const realFetch = globalThis.fetch;
    const wx = { tokenFails: true, sendErr: 40096 as number };
    const wxRes = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'qyapi.weixin.qq.com') return realFetch(input, init);
      const ep = url.pathname.replace(/^\/cgi-bin\//, '');
      if (ep === 'gettoken')
        return wxRes(wx.tokenFails ? { errcode: 40013, errmsg: 'selftest' } : { errcode: 0, access_token: 'tok', expires_in: 7200 });
      if (ep === 'kf/send_msg') return wxRes(wx.sendErr ? { errcode: wx.sendErr, errmsg: 'selftest' } : { errcode: 0 });
      return wxRes({ errcode: 40001, errmsg: `selftest: ${ep}` });
    }) as typeof fetch;
    Object.assign(process.env, { WECOM_CORP_ID: 'selftest-corp', WECOM_APP_SECRET: 'selftest-secret', WECOM_KF_OPEN_KFID: 'selftest-kf' });
    const push = (sid: string) => wecom.wecomAdapter.push(sid, '您好，这是一条测试消息', { kind: 'notice' });
    try {
      await push('wecom:wmAlertSend01');
      await A.settle();
      check(
        'wecom_send：取不到 access_token 立即收到一条（企微错误码，不带地址与密钥）',
        hook.bodies.length === n0 + 1 && contents()[n0]!.startsWith('[selftest] 取不到企微 access_token（40013），收发消息都停了 · '),
        json(contents().slice(n0)),
      );
      wx.tokenFails = false;
      alertNow += 9 * 60_000;
      A.tick();
      await A.settle();
      check('没有失败才 9 分钟：不恢复', hook.bodies.length === n0 + 1);
      alertNow += 60_000;
      A.tick();
      await A.settle();
      check(
        '10 分钟没有失败：收到「已恢复」',
        hook.bodies.length === n0 + 2 && contents()[n0 + 1]!.startsWith('[selftest] 已恢复：企微发送 10 分钟没有失败 · '),
        json(contents().slice(n0)),
      );
      // 三次失败隔得开（0、11、22 分钟）：任何 10 分钟里都不满 3 个
      for (const gap of [0, 11, 11]) {
        alertNow += gap * 60_000;
        await push('wecom:wmAlertSend02');
      }
      wx.sendErr = 0;
      await push('wecom:wmAlertSend02'); // 送达的不算
      wx.sendErr = 40096;
      await A.settle();
      check('3 个分段失败但隔得开（任何 10 分钟里不满 3 个）：不报', hook.bodies.length === n0 + 2, json(contents().slice(n0)));
      alertNow += 60_000;
      await push('wecom:wmAlertSend02');
      // 账本上结果不明（超时、网络异常）的一段同样算最终失败
      const h = ledger.recordSend('wecom:wmAlertSend03', 'notice', null);
      h.attempt();
      h.settle('unknown');
      await A.settle();
      check(
        '10 分钟内 3 个分段最终失败（rejected 2、unknown 1）：收到一条，带错误码',
        hook.bodies.length === n0 + 3 &&
          contents()[n0 + 2]!.startsWith('[selftest] 企微发送 10 分钟内 3 个分段最终失败（rejected 2、unknown 1，错误码 40096） · '),
        json(contents().slice(n0)),
      );
      alertNow += 10 * 60_000;
      A.tick();
      await A.settle();
      check(
        '之后 10 分钟没有失败：恢复',
        hook.bodies.length === n0 + 4 && contents()[n0 + 3]!.includes('已恢复：企微发送'),
        json(contents().slice(n0)),
      );
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(process.env, { WECOM_CORP_ID: '', WECOM_APP_SECRET: '', WECOM_KF_OPEN_KFID: '' });
    }
  }

  // ---------------- tenant_lock：锁进入 lost、重新拿到 ----------------
  {
    A.reset();
    const n0 = hook.bodies.length;
    __configTest.setTimings({ reacquireMs: 20 });
    const lock = theLock as ReturnType<typeof fakeLock> | null;
    check('前提：配置源的租户锁拿到了', !!lock && configHealth().lock === 'held');
    lock!.next = 'unreachable';
    lock!.lose();
    await sleep(120);
    await A.settle();
    check(
      'tenant_lock：锁进入 lost 收到一条；重取连不上的那几次不再发',
      configHealth().lock === 'lost' &&
        hook.bodies.length === n0 + 1 &&
        contents()[n0]!.startsWith('[selftest] 租户锁连接断开：配置写入暂停、对话照常，正在重取 · '),
      json(contents().slice(n0)),
    );
    lock!.next = 'ok';
    await sleep(120);
    await A.settle();
    check(
      '锁重新拿到：收到「已恢复」',
      configHealth().lock === 'held' && hook.bodies.length === n0 + 2 && contents()[n0 + 1]!.includes('已恢复：租户锁重新取得'),
      json(contents().slice(n0)),
    );
  }

  // ---------------- store：积压、poisoned、丢遥测行、回放失败、冲突（读法换成假的；积压要 60 秒才造得出来） ----------------
  {
    A.reset();
    const n0 = hook.bodies.length;
    const base = {
      mode: 'db' as const,
      conversations: 3,
      dirty: 0,
      lagMs: 0,
      lastError: null as string | null,
      conflict: false,
      poisoned: [] as string[],
    };
    let h = { ...base };
    let c = { telemetryDropped: 0, replayFailedFiles: 0 };
    A.setProbe({ health: () => h, counters: () => c });
    try {
      h = { ...base, dirty: 2, lagMs: 60_000 };
      A.tick();
      await A.settle();
      check('store：积压正好 60 秒不报（要超过）', hook.bodies.length === n0);
      h = { ...base, dirty: 2, lagMs: 61_000 };
      A.tick();
      A.tick();
      await A.settle();
      check(
        'store：积压超过 60 秒收到一条（只有秒数与会话个数），持续时不重发',
        hook.bodies.length === n0 + 1 && contents()[n0]!.startsWith('[selftest] 写库积压 61 秒（2 个会话有没落库的改动） · '),
        json(contents().slice(n0)),
      );
      h = { ...base, dirty: 1, lagMs: 5_001 };
      A.tick();
      await A.settle();
      check('积压回到 5 秒多一点：还不算恢复', hook.bodies.length === n0 + 1);
      h = { ...base, lagMs: 5_000 };
      A.tick();
      await A.settle();
      check(
        '积压回到 5 秒以内：收到「已恢复」',
        hook.bodies.length === n0 + 2 && contents()[n0 + 1]!.includes('已恢复：写库积压回到 5 秒以内'),
        json(contents().slice(n0)),
      );
      h = { ...base, poisoned: ['AB12'], lastError: 'window_corrupt · AB12' };
      A.tick();
      A.tick();
      await A.settle();
      check(
        '会话 poisoned（WindowCorruptError）：收到一条，带短码与错误码；同一个会话不重复报',
        hook.bodies.length === n0 + 3 &&
          contents()[n0 + 2]!.startsWith('[selftest] 会话 AB12 停止落库（poisoned，window_corrupt · AB12），内存照旧服务客户 · '),
        json(contents().slice(n0)),
      );
      alertNow += 31 * 60_000;
      h = { ...base, poisoned: ['AB12'], lagMs: 70_000, dirty: 1, lastError: 'window_corrupt · AB12' };
      A.tick();
      h = { ...base, poisoned: ['AB12'], lastError: 'window_corrupt · AB12' };
      A.tick();
      await A.settle();
      check(
        '还有 poisoned 的会话时积压回落不发「已恢复」',
        hook.bodies.length === n0 + 4 && !contents()[n0 + 3]!.includes('已恢复'),
        json(contents().slice(n0)),
      );
      A.reset();
      h = { ...base };
      c = { telemetryDropped: 5, replayFailedFiles: 0 };
      A.tick();
      await A.settle();
      check('丢遥测行的计数：第一次读到的是基线，不报', hook.bodies.length === n0 + 4, json(contents().slice(n0)));
      alertNow += 5 * 60_000;
      c = { telemetryDropped: 6, replayFailedFiles: 0 };
      A.tick();
      alertNow += 3 * 60_000;
      c = { telemetryDropped: 7, replayFailedFiles: 1 };
      A.tick();
      await A.settle();
      check(
        '10 分钟内存档点里丢了遥测行：收到一条（批数）；同一键 30 分钟内的下一条（又丢了、spill 回放失败）不再发',
        hook.bodies.length === n0 + 5 &&
          contents()[n0 + 4]!.startsWith('[selftest] 最近 10 分钟有 1 批遥测行（trace、护栏事件、发送账本）没写进库，已丢弃 · '),
        json(contents().slice(n0)),
      );
      alertNow += 31 * 60_000;
      c = { telemetryDropped: 9, replayFailedFiles: 1 };
      A.tick();
      await A.settle();
      check(
        '过了 30 分钟又丢：再收到一条，批数只算最近 10 分钟里的',
        hook.bodies.length === n0 + 6 && contents()[n0 + 5]!.startsWith('[selftest] 最近 10 分钟有 2 批遥测行'),
        json(contents().slice(n0)),
      );
      A.reset();
      c = { telemetryDropped: 2, replayFailedFiles: 1 };
      A.tick();
      await A.settle();
      check(
        '启动时 spill 回放失败、改名 .failed：收到一条',
        hook.bodies.length === n0 + 7 && contents()[n0 + 6]!.startsWith('[selftest] 启动时 1 个 spill 文件回放失败'),
        json(contents().slice(n0)),
      );
      A.reset();
      c = { telemetryDropped: 0, replayFailedFiles: 0 };
      h = { ...base, conflict: true };
      A.tick();
      await A.settle();
      check(
        '健康里 conflict 为 true：收到 store_conflict',
        hook.bodies.length === n0 + 8 && contents()[n0 + 7]!.includes('store_conflict'),
      );
      A.reset();
      h = { ...base };
      store.__storeTest.emitIncident({ kind: 'conflict', detail: '会话 CD34' });
      await A.settle();
      check(
        'store_conflict 的事故（落库撞上另一写者）：立刻收到一条，带短码',
        hook.bodies.length === n0 + 9 &&
          contents()[n0 + 8]!.startsWith('[selftest] store_conflict：落库撞上另一写者（会话 CD34），本进程优雅停机'),
        json(contents().slice(n0)),
      );
    } finally {
      A.setProbe(null);
    }
  }

  // ---------------- store：真的丢遥测行、真的 poisoned（读法是真的 storeHealth 与计数） ----------------
  {
    A.reset();
    const n0 = hook.bodies.length;
    A.tick(); // 记下现在的计数
    await su(`alter table turn_traces add constraint ops_alert_no_replied check (outcome <> 'replied') not valid`);
    try {
      await say('wecom:wmAlertDrop01', '你好', [{ content: '您好～想去哪儿玩呢？' }]);
    } finally {
      await su('alter table turn_traces drop constraint ops_alert_no_replied');
    }
    A.tick();
    await A.settle();
    check(
      '真的写不进 trace（存档点里丢掉）：巡检读到计数涨了，收到一条',
      hook.bodies.length === n0 + 1 && contents()[n0]!.startsWith('[selftest] 最近 10 分钟有 1 批遥测行'),
      json(contents().slice(n0)),
    );
    A.reset();
    const sid = 'wecom:wmAlertPoison01';
    await say(sid, '你好', [{ content: '您好～' }]);
    await say(sid, '想去云南', [{ content: '云南不错～几位出行？' }]);
    const s = store.getSession(sid)!;
    s.messages.splice(1, 1);
    s.messages.push({ role: 'agent', content: '补一句', at: Date.now() });
    store.saveSession(s);
    A.tick();
    await A.settle();
    const code = shortIdOf(sid);
    check(
      '真的 WindowCorruptError：会话 poisoned，巡检收到一条（短码与 window_corrupt），没有会话原 id',
      store.storeHealth().poisoned.includes(code) &&
        hook.bodies.length === n0 + 2 &&
        contents()[n0 + 1]!.includes(`会话 ${code} 停止落库（poisoned，window_corrupt · ${code}）`),
      json(contents().slice(n0)),
    );
  }

  // ---------------- jobs：handoff_notify 用完重试记 failed、启动归位记 failed；没有恢复 ----------------
  {
    A.reset();
    const n0 = hook.bodies.length;
    const prev = runner.__jobsTest.setHandler('handoff_notify', async () => {
      throw new TypeError('selftest：通知发不出去');
    });
    try {
      for (const key of ['ops-alert-notify-1', 'ops-alert-notify-2']) {
        await store.withJobsTx((tx) =>
          enqueueJob(tx, {
            kind: 'handoff_notify',
            dedupeKey: key,
            runAt: new Date(Date.now() - 1000),
            payload: { sessionId: 'wecom:wmAlertJob1' },
            maxAttempts: 1,
          }),
        );
      }
      runner.__jobsTest.reset();
      await runner.runJobsOnce(Date.now() + 1000);
      await A.settle();
      check(
        'jobs：handoff_notify 用完重试记 failed 收到一条（种类与错误名）；同一拍的第二个 30 分钟内不再发',
        hook.bodies.length === n0 + 1 &&
          contents()[n0]!.startsWith('[selftest] 任务 handoff_notify 用完重试次数，记 failed（TypeError） · '),
        json(contents().slice(n0)),
      );
    } finally {
      runner.__jobsTest.setHandler('handoff_notify', prev);
    }
    // 上一个进程留下的 running，再加 1 次就到 max_attempts：启动归位记 failed
    await su(
      `insert into jobs (tenant_id, kind, dedupe_key, run_at, status, attempts, max_attempts, payload, claimed_at)
       values ($1, 'retention_purge', 'ops-alert-recover', now(), 'running', 2, 3, '{}', now())`,
      [DEMO],
    );
    alertNow += 31 * 60_000;
    runner.__jobsTest.reset();
    await runner.runJobsOnce(Date.now() + 1000);
    await A.settle();
    check(
      '启动归位时 retention_purge 用完重试记 failed：过了 30 分钟，收到一条（个数）',
      hook.bodies.length === n0 + 2 && contents()[n0 + 1]!.startsWith('[selftest] 启动归位：1 个任务用完重试次数，记 failed · '),
      json(contents().slice(n0)),
    );
  }

  // ---------------- 推送：失败只记日志不抛、重试 2 次、超时、不阻塞；限流 ----------------
  {
    A.reset();
    const u0 = unhandled;
    for (const [mode, want] of [
      ['s500', 'HTTP 500'],
      ['errcode', 'errcode 93000'],
    ] as const) {
      hook.mode = mode;
      const h0 = hook.hits;
      const n0 = alertLogs.length;
      alertMod.alert('jobs', `推送失败的一条（${mode}）`, { escalate: true });
      await A.settle();
      const lines = alertLogs.slice(n0);
      check(
        `webhook ${want}：一共发 3 次（至多重试 2 次），之后只记一行错误，不带地址与 key`,
        hook.hits - h0 === 3 &&
          lines.length === 1 &&
          lines[0]!.startsWith(`[alert] 告警没推出去（重试 2 次仍失败：${want}）`) &&
          !lines[0]!.includes(HOOK_KEY) &&
          !lines[0]!.includes('127.0.0.1'),
        `${hook.hits - h0} ${json(lines)}`,
      );
    }
    hook.mode = 'hang';
    A.setTimings({ timeoutMs: 400 });
    const h0 = hook.hits;
    const n0 = alertLogs.length;
    const t0 = performance.now();
    const ret = alertMod.alert('jobs', '推送挂住的一条', { escalate: true });
    const syncMs = performance.now() - t0;
    check('不变量 50：alert() 同步返回，不等推送（webhook 挂住）', ret === undefined && syncMs < 50 && A.inflight() === 1, `${syncMs}ms`);
    const tTurn = performance.now();
    const r = await say('wecom:wmAlertBusy01', '你好', [{ content: '您好～' }]);
    const turnMs = performance.now() - tTurn;
    const busy = await serverApp.request('/healthz');
    const stillHanging = A.inflight();
    check(
      '不变量 50：推送挂住时一轮对话与请求照常、不等它（之后推送还挂着）',
      r.turn.outcome === 'replied' && busy.status === 200 && (stillHanging === 1 || turnMs < 1000),
      `${Math.round(turnMs)}ms ${stillHanging}`,
    );
    await A.settle();
    const lines = alertLogs.slice(n0);
    check(
      '超时：每次按超时放弃，一共 3 次，只记一行 TimeoutError，不带地址',
      hook.hits - h0 === 3 && lines.length === 1 && lines[0]!.includes('TimeoutError') && !lines[0]!.includes('127.0.0.1'),
      `${hook.hits - h0} ${json(lines)}`,
    );
    hook.mode = 'ok';
    A.setTimings({ timeoutMs: 5000 });
    // 连不上：开一个端口再关掉
    const refused = await new Promise<string>((resolve) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => resolve(`http://127.0.0.1:${port}/cgi-bin/webhook/send?key=${HOOK_KEY}`));
      });
    });
    process.env.ALERT_WEBHOOK_URL = refused;
    const n1 = alertLogs.length;
    alertMod.alert('jobs', '连不上的一条', { escalate: true });
    await A.settle();
    const refusedLines = alertLogs.slice(n1);
    check(
      '连不上：只记一行（错误名与 errno 码），不带地址与端口',
      refusedLines.length === 1 &&
        refusedLines[0]!.includes('ECONNREFUSED') &&
        !refusedLines[0]!.includes(HOOK_KEY) &&
        !refusedLines[0]!.includes('127.0.0.1'),
      json(refusedLines),
    );
    process.env.ALERT_WEBHOOK_URL = hookUrl;
    check('推送失败、超时、连不上：没有未处理的 rejection', unhandled === u0, String(unhandled - u0));

    // 限流：一分钟至多 10 条，多出来的只记一行（一分钟至多一行）
    A.reset();
    const b0 = hook.bodies.length;
    const n2 = alertLogs.length;
    for (let i = 1; i <= 12; i++) alertMod.alert('tenant_lock', `限流第 ${i} 条`, { escalate: true });
    await A.settle();
    check(
      '限流：一分钟里 12 条只推了 10 条，多出来的只记一行',
      hook.bodies.length === b0 + 10 && alertLogs.slice(n2).filter((l) => l.startsWith('[alert] 一分钟内已推了 10 条告警')).length === 1,
      `${hook.bodies.length - b0} ${json(alertLogs.slice(n2))}`,
    );
    alertNow += 61_000;
    alertMod.alert('tenant_lock', '限流过后', { escalate: true });
    await A.settle();
    check('过了一分钟照常推', hook.bodies.length === b0 + 11 && contents().at(-1)!.includes('限流过后'));

    // 正文的兜底：调用方误把会话原 id 或地址写进去，推出去的是短码、地址整段去掉
    A.reset();
    alertMod.alert('jobs', '会话 wecom:wmLeakAlert42 出错，见 https://example.com/x?key=abc');
    await A.settle();
    check(
      '告警正文的兜底：会话原 id 换成短码、地址整段去掉',
      contents().at(-1)!.startsWith('[selftest] 会话 RT42 出错，见 [地址已略] · '),
      contents().at(-1),
    );
    logMod.setConvRefResolver((id) => channelRefs.get(id) ?? store.conversationRef(id));
    __profileTest.use({ DEPLOY_PROFILE: 'prod', ADMIN_PASS: 'x' });
    try {
      for (const { raw, code } of channelIdCases) {
        A.reset();
        const before = hook.bodies.length;
        alertMod.alert('jobs', `会话 ${raw} 出错`);
        await A.settle();
        const out = contents().at(-1)!;
        check(
          `03 R22 告警正文：${raw} 换成 ${code}`,
          hook.bodies.length === before + 1 && out.startsWith(`[selftest] 会话 ${code} 出错 · `) && channelIdsHidden(hook.bodies.at(-1)!),
          out,
        );
      }
      A.reset();
      const before = hook.bodies.length;
      alertMod.alert('jobs', ordinaryWebText);
      await A.settle();
      check(
        '03 R22 告警正文：普通 web 文本与长度不对的 id 原样保留',
        hook.bodies.length === before + 1 && contents().at(-1)!.startsWith(`[selftest] ${ordinaryWebText} · `),
        contents().at(-1),
      );
    } finally {
      __profileTest.reset();
      logMod.setConvRefResolver(store.conversationRef);
    }
    process.env.INSTANCE_LABEL = '';
    A.reset();
    alertMod.alert('jobs', '没设实例名');
    await A.settle();
    check('没设 INSTANCE_LABEL：实例名是 wecom-sales-agent', contents().at(-1)!.startsWith('[wecom-sales-agent] 没设实例名 · '));
    process.env.INSTANCE_LABEL = 'selftest';
  }
});

// ================ 部署脚本：deploy/watch.sh 与 backup.sh 的告警（PATH 里的假 docker、curl、df、age） ================
const wtmp = fs.mkdtempSync(path.join(VAR_DIR, 'watch-'));
const wbin = path.join(wtmp, 'bin');
const wfake = path.join(wtmp, 'fake');
fs.mkdirSync(wbin);
fs.mkdirSync(wfake);
const realCurl = (process.env.PATH ?? '')
  .split(path.delimiter)
  .map((d) => path.join(d, 'curl'))
  .find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
check('前提：本机有 curl（假 curl 把 /healthz 以外的请求交给它）', !!realCurl);
const fakeCmd = (name: string, lines: string[]): void =>
  fs.writeFileSync(path.join(wbin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
fakeCmd('docker', [
  'case "$*" in',
  '  *RestartCount*) cat "$FAKE_DIR/restart" 2>/dev/null || exit 1 ;;',
  '  *"volume inspect"*) echo "$FAKE_DIR/volume" ;;',
  '  *pg_dumpall*) echo "-- globals" ;;',
  // 03 第 12 步：pg_dump 记进调用顺序（FAKE_CALLS），并在线上 var/ 里写一个文件（FAKE_DUMP_TOUCH）：先打包 var/ 的话归档里没有它
  '  *pg_dump*) if [ -n "${FAKE_DUMP_FAIL:-}" ]; then exit 3; fi; if [ -n "${FAKE_CALLS:-}" ]; then echo pg_dump >> "$FAKE_CALLS"; fi; if [ -n "${FAKE_DUMP_TOUCH:-}" ]; then echo late > "$FAKE_DUMP_TOUCH"; fi; echo dump ;;',
  '  *"pg_restore --list"*) cat >/dev/null; for t in ${FAKE_TOC:-memberships sop_versions catalog_items audit_log conversations messages orders}; do echo "1; 0 0 TABLE DATA public $t agent_owner"; done ;;',
  '  *psql*) echo "2|43|conversations messages orders" ;;',
  '  *) exit 97 ;;',
  'esac',
]);
// /healthz 的回包在 $FAKE_DIR/health（down 时像连不上那样以 7 退出）；别的请求（推 webhook）交给真的 curl
fakeCmd('curl', [
  'for a in "$@"; do',
  '  case "$a" in',
  '    */healthz) h="$(cat "$FAKE_DIR/health")"; if [ "$h" = down ]; then exit 7; fi; printf "%s" "$h"; exit 0 ;;',
  '  esac',
  'done',
  'exec "$REAL_CURL" "$@"',
]);
// df -P <挂载点>：根分区与数据卷各自的使用率。$FAKE_DIR/df_wrap 存在时模拟设备名过长（overlay2/LVM/NFS 长挂载）、
// df -P 把设备名单独占一行、数据挪到下一行且少一列的情况（审查第 1 条）
fakeCmd('df', [
  'p="${@: -1}"',
  'if [ "$p" = / ]; then pct="$(cat "$FAKE_DIR/df_root")"; else pct="$(cat "$FAKE_DIR/df_volume")"; fi',
  'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
  'if [ -f "$FAKE_DIR/df_wrap" ]; then',
  '  echo "/dev/mapper/a-device-name-so-long-that-df--P-wraps-it-onto-its-own-line"',
  '  echo "1000 500 500 ${pct}% $p"',
  'else',
  '  echo "/dev/fake 1000 500 500 ${pct}% $p"',
  'fi',
]);
fakeCmd('age', ['out=""', 'while [ $# -gt 1 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done', 'cp "$1" "$out"']);
// 03 第 12 步：tar 记进同一份调用顺序，再交给真的 tar（看 backup.sh 先打包 var/、后 pg_dump）
const realTar = ['/usr/bin/tar', '/bin/tar'].find((p) => fs.existsSync(p)) ?? 'tar';
fakeCmd('tar', ['if [ -n "${FAKE_CALLS:-}" ]; then echo "tar $1" >> "$FAKE_CALLS"; fi', `exec ${realTar} "$@"`]);
const setFake = (k: string, v: string): void => fs.writeFileSync(path.join(wfake, k), v);
const srv = path.join(wtmp, 'srv');
const bk = path.join(wtmp, 'bk');
fs.mkdirSync(path.join(srv, 'var'), { recursive: true });
fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\n');
fs.writeFileSync(path.join(srv, 'var', 'sessions.json'), '[]');
fs.writeFileSync(
  path.join(srv, '.env.backup'),
  ['BACKUP_AGE_RECIPIENTS=age1test', `BACKUP_DIR=${bk}`, 'COMPOSE_PROJECT=opswatch', ''].join('\n'),
);
const WATCH_KEY = 'WATCHKEY55';
const watchHook = `${hookBase}/cgi-bin/webhook/send?key=${WATCH_KEY}`;
const writeOps = (lines: string[]): void =>
  fs.writeFileSync(
    path.join(srv, '.env.ops'),
    [...lines, 'INSTANCE_LABEL=selftest-host', 'HOST_PORT=3999', `WATCH_STATE=${path.join(wtmp, 'state', 'watch.state')}`, ''].join('\n'),
  );
writeOps([`ALERT_WEBHOOK_URL=${watchHook}`]);
const scriptEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] =>
      e[1] !== undefined &&
      !/^(ALERT_WEBHOOK_URL|INSTANCE_LABEL|COMPOSE_PROJECT|BACKUP_.*|WATCH_.*|APP_CONTAINER|HOST_PORT|DISK_PATHS)$/.test(e[0]),
  ),
);
Object.assign(scriptEnv, { PATH: `${wbin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_DIR: wfake, REAL_CURL: realCurl ?? 'curl' });
const scriptOut: string[] = [];
const runWatch = async (now: number, extra: Record<string, string> = {}): Promise<{ status: number | null; out: string }> => {
  const r = await spawnAsync('bash', [path.join(repoRoot, 'deploy', 'watch.sh'), srv], {
    cwd: wtmp,
    env: { ...scriptEnv, WATCH_NOW: String(now), ...extra },
    timeoutMs: 60_000,
  });
  scriptOut.push(r.stdout + r.stderr);
  return { status: r.status, out: r.stdout + r.stderr };
};
const runBackup = async (extra: Record<string, string> = {}): Promise<{ status: number | null; out: string }> => {
  const r = await spawnAsync('bash', [path.join(repoRoot, 'deploy', 'backup.sh'), srv], {
    cwd: wtmp,
    env: { ...scriptEnv, ...extra },
    timeoutMs: 60_000,
  });
  scriptOut.push(r.stdout + r.stderr);
  return { status: r.status, out: r.stdout + r.stderr };
};
const hostStampRe = /^\[selftest-host\] (?:已恢复：)?[^\n]+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
{
  const deploySrc = fs.readFileSync(path.join(repoRoot, 'deploy.sh'), 'utf8');
  const installed = /install -m 755 \$\{REMOTE_DIR\}\/deploy\/watch\.sh (\/\S+)\/\$\{NAME\}\/watch\.sh/.exec(deploySrc)?.[1];
  const cronLine = /^# +\* \* \* \* \* +bash (\S+) \/opt\/wecom-sales-agent /m.exec(
    fs.readFileSync(path.join(repoRoot, 'deploy', 'watch.sh'), 'utf8'),
  )?.[1];
  check(
    'deploy.sh 每次部署把 watch.sh 装到部署目录之外（有才装，部署更早的 tag 不失败），正是 cron 那一行跑的路径',
    installed !== undefined &&
      cronLine === `${installed}/wecom-sales-agent/watch.sh` &&
      /if \[ -f \$\{REMOTE_DIR\}\/deploy\/watch\.sh \]; then install/.test(deploySrc),
    `${installed} / ${cronLine}`,
  );

  const T0 = Math.floor(Date.UTC(2026, 9, 3, 2, 0, 0) / 1000);
  let now = T0;
  const b0 = hook.bodies.length;
  const fresh = (): string[] => contents().slice(b0);
  fs.mkdirSync(path.join(bk, 'opswatch'), { recursive: true });
  const stampAt = (s: number): void => fs.writeFileSync(path.join(bk, 'opswatch', 'last-success'), `${s}\n`);
  stampAt(T0 - 3600);
  setFake('restart', '3');
  setFake('health', '{"ok":true,"revision":"v1"}');
  setFake('df_root', '50');
  setFake('df_volume', '40');
  const first = await runWatch(now);
  check('watch.sh：一切正常时什么都不推、不打', first.status === 0 && fresh().length === 0 && first.out === '', first.out);

  // 重启：10 分钟内增加 2 次以上；持续时去重；30 分钟没有重启恢复
  setFake('restart', '4');
  await runWatch((now += 60));
  check('watch.sh：10 分钟内重启 1 次不报', fresh().length === 0, json(fresh()));
  setFake('restart', '5');
  await runWatch((now += 60));
  setFake('restart', '6');
  await runWatch((now += 60));
  check(
    'watch.sh：RestartCount 10 分钟内增加 2 次收到一条，再增加时 30 分钟内不重发',
    fresh().length === 1 && fresh()[0]!.startsWith('[selftest-host] app 容器 10 分钟内重启了 2 次 · ') && hostStampRe.test(fresh()[0]!),
    json(fresh()),
  );
  await runWatch(now + 29 * 60);
  check('watch.sh：没有重启才 29 分钟，不恢复', fresh().length === 1, json(fresh()));
  await runWatch((now += 30 * 60));
  check(
    'watch.sh：30 分钟没有重启，收到「已恢复」',
    fresh().length === 2 && fresh()[1]!.includes('已恢复：app 容器 30 分钟没有重启'),
    json(fresh()),
  );
  setFake('restart', '0');
  await runWatch((now += 60));
  setFake('restart', '1');
  await runWatch((now += 60));
  check('watch.sh：容器重建（计数变小）之后从头数，重建本身不算重启', fresh().length === 2, json(fresh()));

  // 健康检查：连续 3 分钟失败（连不上或 ok 为 false）；连续 3 分钟正常恢复
  setFake('health', 'down');
  await runWatch((now += 60));
  await runWatch((now += 60));
  check('watch.sh：健康检查失败 2 分钟不报', fresh().length === 2, json(fresh()));
  await runWatch((now += 60));
  await runWatch((now += 60));
  check(
    'watch.sh：/healthz 连续 3 分钟连不上收到一条，第 4 分钟不重发',
    fresh().length === 3 && fresh()[2]!.startsWith('[selftest-host] 健康检查连续 3 分钟失败（连不上或 HTTP 出错，curl 退出码 7） · '),
    json(fresh()),
  );
  setFake('health', '{"ok":true}');
  await runWatch((now += 60));
  await runWatch((now += 60));
  check('watch.sh：正常 2 分钟不算恢复', fresh().length === 3);
  await runWatch((now += 60));
  check(
    'watch.sh：连续 3 分钟正常，收到「已恢复」',
    fresh().length === 4 && fresh()[3]!.includes('已恢复：健康检查连续 3 分钟正常'),
    json(fresh()),
  );
  setFake('health', '{"ok":false,"revision":"v1"}');
  for (let i = 0; i < 3; i++) await runWatch((now += 60));
  check(
    'watch.sh：ok 为 false 连续 3 分钟同样收到一条',
    fresh().length === 5 && fresh()[4]!.includes('健康检查连续 3 分钟失败（ok 为 false）'),
    json(fresh()),
  );
  setFake('health', '{"ok":true}');
  for (let i = 0; i < 3; i++) await runWatch((now += 60));
  check('watch.sh：又恢复', fresh().length === 6 && fresh()[5]!.includes('已恢复：健康检查'));

  // 磁盘：≥ 85% 一条、≥ 95% 再发一次、回到 80% 以下恢复
  setFake('df_root', '86');
  await runWatch((now += 60));
  setFake('df_root', '90');
  await runWatch((now += 60));
  check(
    'watch.sh：根分区 86% 收到一条，涨到 90% 不重发',
    fresh().length === 7 && fresh()[6]!.startsWith('[selftest-host] 磁盘使用率 86%（根分区） · '),
    json(fresh()),
  );
  setFake('df_volume', '96');
  await runWatch((now += 60));
  setFake('df_volume', '97');
  await runWatch((now += 60));
  check(
    'watch.sh：数据卷到 96% 再发一次（不受 30 分钟去重），之后不重发',
    fresh().length === 8 && fresh()[7]!.startsWith('[selftest-host] 磁盘使用率 96%（数据库数据卷） · '),
    json(fresh()),
  );
  setFake('df_root', '82');
  setFake('df_volume', '82');
  await runWatch((now += 60));
  check('watch.sh：回到 82% 还不算恢复（要 80% 以下）', fresh().length === 8);
  setFake('df_root', '50');
  setFake('df_volume', '79');
  await runWatch((now += 60));
  check(
    'watch.sh：回到 80% 以下，收到「已恢复」',
    fresh().length === 9 && fresh()[8]!.includes('已恢复：磁盘使用率回到 80% 以下（79%）'),
    json(fresh()),
  );

  // 备份：上次成功早于 26 小时；条件持续时每 30 分钟至多一次；有了新的成功恢复
  stampAt(now - 27 * 3600);
  await runWatch((now += 60));
  await runWatch((now += 60));
  check(
    'watch.sh：上次成功的备份早于 26 小时收到一条，下一分钟不重发',
    fresh().length === 10 && fresh()[9]!.startsWith('[selftest-host] 上次成功的备份是 27 小时前（超过 26 小时） · '),
    json(fresh()),
  );
  await runWatch((now += 31 * 60));
  check('watch.sh：条件持续 30 分钟以上，再发一次', fresh().length === 11 && fresh()[10]!.includes('超过 26 小时'), json(fresh()));
  stampAt(now - 600);
  await runWatch((now += 60));
  check(
    'watch.sh：有了新的成功，收到「已恢复」',
    fresh().length === 12 && fresh()[11]!.includes('已恢复：备份成功（0 小时前）'),
    json(fresh()),
  );
  fs.rmSync(path.join(bk, 'opswatch', 'last-success'));
  await runWatch((now += 60));
  check(
    'watch.sh：没有成功记录也没有日期目录：收到「没有找到成功的备份」',
    fresh().length === 13 && fresh()[12]!.includes('没有找到成功的备份'),
    json(fresh()),
  );
  fs.mkdirSync(path.join(bk, 'opswatch', '2026-10-02'));
  await runWatch(Math.floor(Date.now() / 1000) + 60);
  check(
    'watch.sh：还没有成功记录时按最新的日期目录算（这一版的 backup.sh 还没跑过）',
    fresh().length === 14 && fresh()[13]!.includes('已恢复：备份成功'),
    json(fresh()),
  );
  const off = await runWatch(now + 40 * 3600, { WATCH_BACKUP: '0' });
  check('watch.sh：WATCH_BACKUP=0 不查备份', fresh().length === 14 && off.status === 0, json(fresh()));

  // 没配地址：只写 stderr，不推
  writeOps([]);
  const h0 = hook.hits;
  setFake('health', 'down');
  for (let i = 0; i < 3; i++) await runWatch((now += 60));
  const noUrl = scriptOut.at(-1) ?? '';
  check(
    'watch.sh：没配 ALERT_WEBHOOK_URL 只写一行 stderr（带告警正文），不推',
    hook.hits === h0 && noUrl.includes('watch: ⚠️ 没配 ALERT_WEBHOOK_URL') && noUrl.includes('健康检查连续 3 分钟失败'),
    noUrl,
  );
  writeOps([`ALERT_WEBHOOK_URL=${watchHook}`]);
  setFake('health', '{"ok":true}');
  const state = fs.readFileSync(path.join(wtmp, 'state', 'watch.state'), 'utf8');
  check(
    'watch.sh：去重状态是一个小文件，只有名字与数字',
    state.split('\n').every((l) => l === '' || /^[a-z0-9_]+=[0-9 :]*$/.test(l)) && state.includes('a_health_active=1'),
    state,
  );

  // backup.sh：中途失败（trap 在非零退出时）推一条、写失败标记；下一次成功记下时刻并推「已恢复」
  const day = (await spawnAsync('date', ['+%F'], { cwd: wtmp, env: scriptEnv })).stdout.trim();
  const fb0 = hook.bodies.length;
  const failed = await runBackup({ FAKE_TOC: 'memberships sop_versions catalog_items audit_log messages orders' });
  check(
    'backup.sh：校验那一步失败，退出码照旧是 1，推一条（哪一步、退出码），写下失败标记',
    failed.status === 1 &&
      contents().length === fb0 + 1 &&
      contents()[fb0]!.startsWith('[selftest-host] 备份失败（校验这一步，退出码 1），这次的备份不可用 · ') &&
      hostStampRe.test(contents()[fb0]!) &&
      fs.existsSync(path.join(bk, 'opswatch', 'last-failure')),
    `${failed.status} ${json(contents().slice(fb0))} ${failed.out.slice(-300)}`,
  );
  const failed2 = await runBackup({ FAKE_DUMP_FAIL: '1' });
  check(
    'backup.sh：导出那一步失败（docker 退出码 3）同样推一条，退出码照旧',
    failed2.status === 3 && contents().length === fb0 + 2 && contents()[fb0 + 1]!.includes('备份失败（导出这一步，退出码 3）'),
    `${failed2.status} ${json(contents().slice(fb0))}`,
  );
  const before = Math.floor(Date.now() / 1000);
  const ok1 = await runBackup();
  const stamp = Number(fs.readFileSync(path.join(bk, 'opswatch', 'last-success'), 'utf8').trim());
  check(
    'backup.sh：成功时写下 last-success（现在的秒数）、去掉失败标记，推一条「已恢复」',
    ok1.status === 0 &&
      stamp >= before - 1 &&
      stamp <= Math.floor(Date.now() / 1000) + 1 &&
      !fs.existsSync(path.join(bk, 'opswatch', 'last-failure')) &&
      contents().length === fb0 + 3 &&
      contents()[fb0 + 2]!.startsWith('[selftest-host] 已恢复：备份成功 · ') &&
      fs.existsSync(path.join(bk, 'opswatch', day, 'agent.dump.age')),
    `${ok1.status} ${ok1.out.slice(-300)} ${json(contents().slice(fb0))}`,
  );
  const ok2 = await runBackup();
  check('backup.sh：上一次就成功的，这次成功不再推', ok2.status === 0 && contents().length === fb0 + 3);
  const latest = Number(fs.readFileSync(path.join(bk, 'opswatch', 'last-success'), 'utf8').trim());
  const watched = await runWatch(latest + 27 * 3600);
  check(
    'watch.sh 读的正是 backup.sh 写的 last-success：过了 27 小时报备份过期',
    watched.status === 0 && contents().at(-1)!.includes('上次成功的备份是 27 小时前'),
    json(contents().slice(-2)),
  );
  // 03 第 12 步（spec R7、R19、验收 21 的 backup.sh 部分；「测试与 CI」允许改的 backup.sh 步骤顺序）：先打包 var/、再 pg_dump，
  // 归档里有恢复哨兵、线上 var/ 里没有。pg_dump 时往线上 var/ 写一个文件：先打包的话归档里没有它
  {
    const { RESTORE_SENTINEL } = await import('../channels/markers.js');
    const { CHANNEL_KEY_ENV } = await import('../channels/secrets.js');
    const callsFile = path.join(wtmp, 'backup-calls.log');
    const touched = path.join(srv, 'var', 'written-during-dump.json');
    fs.rmSync(callsFile, { force: true });
    const t0 = Date.now();
    const pushed = contents().length;
    const ordered = await runBackup({ FAKE_CALLS: callsFile, FAKE_DUMP_TOUCH: touched });
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : [];
    const tarAt = calls.indexOf('tar -czf');
    check(
      'backup.sh（03）：先打包 var/、再 pg_dump（调用顺序），成功且这次不推告警',
      ordered.status === 0 && tarAt >= 0 && calls.indexOf('pg_dump') > tarAt && contents().length === pushed,
      `${ordered.status} ${json(calls)} ${ordered.out.slice(-300)}`,
    );
    const archive = path.join(bk, 'opswatch', day, 'var.tar.gz.age');
    const listed = (await spawnAsync(realTar, ['-tzf', archive], { cwd: wtmp, env: scriptEnv })).stdout.split('\n').filter(Boolean);
    check(
      'backup.sh（03）：归档里是打包那一刻的 var/：有原来的文件，没有 pg_dump 时才写进线上 var/ 的文件',
      listed.includes('var/sessions.json') && !listed.some((f) => f.endsWith('written-during-dump.json')) && fs.existsSync(touched),
      json(listed),
    );
    const sentinel = await spawnAsync(realTar, ['-xzOf', archive, `var/${RESTORE_SENTINEL}`], { cwd: wtmp, env: scriptEnv });
    let backupAt = NaN;
    try {
      const v = JSON.parse(sentinel.stdout) as { backupAt?: unknown };
      if (Object.keys(v).join() === 'backupAt' && typeof v.backupAt === 'string' && v.backupAt.endsWith('Z'))
        backupAt = Date.parse(v.backupAt);
    } catch {
      backupAt = NaN;
    }
    check(
      'backup.sh（03）：归档里有恢复哨兵 var/restored-from-backup.json（名字与 markers.ts 一致，内容只有 backupAt，是这次打包的时刻）',
      sentinel.status === 0 && backupAt >= Math.floor(t0 / 1000) * 1000 && backupAt <= Date.now(),
      `${sentinel.status} ${sentinel.stdout} ${sentinel.stderr}`,
    );
    check(
      'backup.sh（03）：线上 var/ 里没有恢复哨兵',
      !fs.existsSync(path.join(srv, 'var', RESTORE_SENTINEL)),
      fs.readdirSync(path.join(srv, 'var')).join(','),
    );
    // 恢复手册（脚本开头）：解开 var/ 之后、起应用之前加两步——确认密钥、跑 restore-cutoff，并写明截止点怎么取（开放问题 5）
    const manual = fs.readFileSync(path.join(repoRoot, 'deploy', 'backup.sh'), 'utf8').split('\nset -euo pipefail')[0]!;
    const stepAt = (n: number, re: RegExp): number => {
      const m = new RegExp(`^#   ${n}\\) (.*)$`, 'm').exec(manual);
      return m && re.test(manual.slice(m.index, m.index + 900)) ? m.index : -1;
    };
    const steps = [
      stepAt(5, /解开 var\//),
      stepAt(6, new RegExp(`${CHANNEL_KEY_ENV}[\\s\\S]*secrets_key_id[\\s\\S]*离线保管`)),
      stepAt(7, /restore-cutoff --tenant <slug> --until <时刻>[\s\S]*最后一次正常回复[\s\S]*恢复开始的时刻/),
      stepAt(8, /启动/),
    ];
    check(
      'backup.sh（03）：恢复手册第 5 步解开 var/ 之后、起应用之前多两步：确认渠道密钥是同一把，跑 restore-cutoff（截止点怎么取）',
      steps.every((at, i) => at >= 0 && (i === 0 || at > steps[i - 1]!)),
      json(steps),
    );
    fs.rmSync(touched, { force: true });
  }
  // 推不出去、没配地址：退出码不变，只写 stderr，不带地址
  writeOps([`ALERT_WEBHOOK_URL=http://127.0.0.1:9/cgi-bin/webhook/send?key=${WATCH_KEY}`]);
  const down = await runBackup({ FAKE_DUMP_FAIL: '1' });
  check(
    'backup.sh：告警推不出去时退出码照旧，只写一行 stderr，不带地址与 key',
    down.status === 3 && down.out.includes('backup: ⚠️ 告警没推出去（curl 退出码') && !down.out.includes(WATCH_KEY),
    down.out.slice(-400),
  );
  writeOps([]);
  const none = await runBackup({ FAKE_DUMP_FAIL: '1' });
  check(
    'backup.sh：没配 ALERT_WEBHOOK_URL 时只写 stderr，退出码照旧',
    none.status === 3 && none.out.includes('backup: ⚠️ 没配 ALERT_WEBHOOK_URL') && none.out.includes('备份失败（导出这一步'),
    none.out.slice(-400),
  );
  writeOps([`ALERT_WEBHOOK_URL=${watchHook}`]);

  // 磁盘：df -P 的设备名过长时单独占一行、百分比那行少一列（审查第 1 条）：仍要从里面读出使用率，不能静默不报。
  // 按内容找而不是按下标数：这里的 now 是整段测试共用的模拟时钟，跑到这一步时可能同时越过备份去重的边界触发别的告警
  setFake('df_wrap', '1');
  setFake('df_root', '92');
  const wrapBefore = fresh().length;
  await runWatch((now += 60));
  check(
    'watch.sh：df -P 输出里设备名单独占一行（overlay2/LVM/NFS 长挂载）、数据行少一列时仍读得到使用率，92% 照样告警',
    fresh()
      .slice(wrapBefore)
      .some((m) => m.includes('磁盘使用率 92%（根分区）')),
    json(fresh().slice(wrapBefore)),
  );
  fs.rmSync(path.join(wfake, 'df_wrap'));
  setFake('df_root', '50');
  const recoverBefore = fresh().length;
  await runWatch((now += 60));
  check(
    'watch.sh：回到 50%，收到「已恢复」',
    fresh()
      .slice(recoverBefore)
      .some((m) => m.includes('已恢复：磁盘使用率回到 80% 以下')),
    json(fresh().slice(recoverBefore)),
  );

  check(
    'watch.sh 与 backup.sh 的输出里一次都没有 webhook 的 key 与地址',
    scriptOut.every((o) => !o.includes(WATCH_KEY) && !o.includes(hookBase)),
    scriptOut.find((o) => o.includes(WATCH_KEY)),
  );
}

// ---------------- 告警正文：只有计数、短码、错误码 ----------------
{
  const all = contents();
  const leaks = all.filter(
    (c) =>
      c.includes(ALERT_SAID) ||
      c.includes('李四') ||
      /wm[A-Z][A-Za-z0-9]{4,}/.test(c) ||
      c.includes('wecom:') ||
      c.includes('sim-') ||
      c.includes(HOOK_KEY) ||
      c.includes(WATCH_KEY) ||
      /https?:\/\//.test(c) ||
      c.includes('127.0.0.1'),
  );
  check(
    '不变量 32：收到的每条告警都是「[实例名] 中文说明 · 时间」，没有客户原话、external_userid、会话原 id、地址与密钥',
    all.length > 40 &&
      leaks.length === 0 &&
      all.every((c) => stampRe.test(c) || hostStampRe.test(c) || c.startsWith('[wecom-sales-agent] ')),
    json(leaks.length ? leaks : all.filter((c) => !stampRe.test(c) && !hostStampRe.test(c)).slice(0, 3)),
  );
  check(
    '告警地址只在 env 里：webhook 收到的请求都打到配置的那个路径，告警这一段的日志里没有地址与 key',
    hook.urls.every((u) => u === `/cgi-bin/webhook/send?key=${HOOK_KEY}` || u === `/cgi-bin/webhook/send?key=${WATCH_KEY}`) &&
      alertLogs.every((l) => !l.includes(HOOK_KEY) && !l.includes('127.0.0.1')),
    json(hook.urls.slice(0, 3)),
  );
}

// ---------------- 停机：drain 段 flush ----------------
{
  const sid = 'wecom:wmOtelShutdown';
  receiver.bodies.length = 0;
  const { turn: f } = await say(sid, '你好', [{ content: '您好呀～' }]);
  check('停机之前：这一轮还排在批处理里，没导出', !treeOf(spansReceived(), f.turn.turnId).root);
  await store.runShutdownHooks(5000);
  check('停机：drain 段把排着的 span 导出去了', !!treeOf(spansReceived(), f.turn.turnId).root, json(receiver.paths.slice(-3)));
}

// ---------------- 停机时端点挂住、拒连、503：按 drain 段的截止时刻放弃，按时返回 ----------------
{
  // 拒连：开一个端口再关掉
  const refusedUrl = await new Promise<string>((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  // 导出器照默认的 10 秒超时一直重试：不按 deadline 放弃的话 drain 段会被拖满
  process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '10000';
  const sample = finished.at(-1)!;
  const n = 1 + sample.turn.llm.length + sample.turn.calls.length + sample.turn.guards.length;
  for (const [label, mode, endpoint] of [
    ['挂住', 'hang', otlpUrl],
    ['拒连', 'ok', refusedUrl],
    ['回 503', 's503', otlpUrl],
  ] as const) {
    receiver.mode = mode;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
    await otel.startOtel();
    otel.exportTurn(sample, {
      tenant: 'demo',
      conversationRef: 'otel-selftest-ref',
      channel: 'wecom',
      agent: 'travel',
      provider: 'zhipu',
      requestModel: 'glm-5.3-flashx',
    });
    const logs: string[] = [];
    const orig = { warn: console.warn, error: console.error };
    console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    const t0 = Date.now();
    let ok = false;
    try {
      ok = await store.runShutdownHooks(8000);
    } finally {
      console.warn = orig.warn;
      console.error = orig.error;
    }
    const ms = Date.now() - t0;
    check(
      `停机时端点${label}：runShutdownHooks(8000) 返回 true，drain 段在 1.5 秒的预算之内结束`,
      ok && ms < 1500,
      `${ok} ${ms}ms ${json(logs)}`,
    );
    check(
      `停机时端点${label}：记一行「[otel] 停机时导出未完成，已放弃 ${n} 条」（不带端点地址），没有「drain 段超时」`,
      logs.includes(`[otel] 停机时导出未完成，已放弃 ${n} 条`) && !logs.some((l) => l.includes('drain 段超时') || l.includes('127.0.0.1')),
      json(logs),
    );
  }
  receiver.mode = 'ok';
}

// ================ 告警：租户锁被别的进程拿走、停机写 spill（会让本进程不再写库，放在最后） ================
{
  A.reset();
  hook.mode = 'ok';
  const n0 = hook.bodies.length;
  const lock = theLock as ReturnType<typeof fakeLock> | null;
  lock!.next = 'held_by_other';
  lock!.lose();
  await sleep(150);
  await A.settle();
  check(
    'tenant_lock：锁进入 lost 一条；确认被别的进程持有、开始停机时再发一条（不受 30 分钟去重）',
    contents().length === n0 + 2 &&
      contents()[n0]!.includes('租户锁连接断开') &&
      contents()[n0 + 1]!.startsWith('[selftest] 租户锁已被另一个进程持有，本进程开始停机 · '),
    json(contents().slice(n0)),
  );
  // 锁在别人手里：drain 段不写库，没落库的真实会话（含前面 poisoned 的那个）退出时写进 spill。告警在 drain 段末尾发出，
  // late 段等在途的推送推完再结束
  check('前提：还有没落库的真实会话（前面 poisoned 的那个）', store.storeHealth().dirty > 0, json(store.storeHealth()));
  const h0 = hook.hits;
  const ok = await store.runShutdownHooks(8000);
  const spill = contents().slice(n0 + 2);
  check(
    'store：停机写了 spill 收到一条（会话个数）；停机钩子返回之前就推到了（late 段等在途的推送）',
    ok &&
      hook.hits > h0 &&
      spill.length === 1 &&
      /^\[selftest\] 停机时 \d+ 个会话没落库，退出时写进 spill 文件（下次启动先回放） · /.test(spill[0]!),
    json(spill),
  );
}

check('全程没有未处理的 rejection', unhandled === 0, String(unhandled));
otlp.close();
fakeLlm.close();
hookSrv.closeAllConnections();
hookSrv.close();
await t.close().catch(() => undefined);
if (fails.length) {
  console.error(`OPS SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `OPS SELFTEST PASS: ${pass} 项断言全通（边界 lint / 没设端点不加载、不连接 / 运行数字逐字段、时区、保留期截断、60 秒缓存、文件存储 503、角色 403、参数 / OpenTelemetry 的 span 树与属性、provider、默认无原文、capture、出错与工具失败、匿名引用、端点挂掉、停机 flush 与按时放弃 / 日志：JSON 行与字段、req 与 x-request-id、轮次的 tenant·conv·turn、没有原话与会话原 id、兜底与 redact、纯文本不变 / 告警：五个键的触发与恢复、30 分钟去重、条件变重、限流、超时与失败不抛不阻塞、没配地址只 warn、正文禁止项 / watch.sh 与 backup.sh）`,
);
process.exit(0);
