// 可观测性自测（docs/architecture/02-conversations-workbench/spec.md「可观测性与告警」、R24、不变量 49、验收 34）。
// 第 18 步先建这个套件，管运行数字与 OpenTelemetry；第 17 步往这里加日志与告警的部分（plan 记了这一顺序调整）。
// 运行数字：PGlite 上造 trace 与 usage_daily 行，逐字段核对口径（p90 只算 replied、转人工率按会话、出错率含 llm 里的 error、
// 今天按服务器时区）、60 秒缓存、文件存储 503、角色 403；带 PG_TEST_URL 时同一份数据在真实 Postgres 上（agent_app、RLS）再算一遍。
// OpenTelemetry：子进程里没设端点时一个 @opentelemetry/* 都没加载（加载钩子与 require.cache）、不向外连接；设了端点时进程内的
// 假 OTLP/HTTP 接收端收到的 span 名字、父子关系、起止时刻与属性逐项对，默认没有原文与 external_userid，OTEL_CAPTURE_CONTENT=1
// 时才有；导出端点挂掉时对话照常、只记日志；停机时 flush。另有 check-boundaries 新加的三条规则。
// 用法：npx tsx src/ops/ops.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

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
    startWecom: () => void calls.push('wecom'),
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
const receiver = { bodies: [] as string[], paths: [] as string[], down: false };
const otlp = http.createServer((req, res) => {
  if (receiver.down) {
    req.socket.destroy();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    receiver.paths.push(`${req.method} ${req.url}`);
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
const { readMetrics } = await import('../db/repo/metrics.js');
const accounts = await import('../auth/accounts.js');
const { SESSION_COOKIE } = await import('../auth/session.js');
const { consoleApi, __consoleTest } = await import('../console-api/app.js');
const { metricsWindow, __metricsTest } = await import('./metrics.js');
const { boot } = await import('../boot.js');
const { startOtelExport } = await import('./otel.js');
const { handleMessage } = await import('../engine.js');
const { createRequire } = await import('node:module');
const otelLoaded = (): number =>
  Object.keys(createRequire(import.meta.url).cache).filter((k) => /[/\\]@opentelemetry[/+\\]/.test(k)).length;

const t = await openTestDb();
await t.pg.exec('RESET ROLE');
await t.pg.query(`insert into tenants (slug, name, pack_id) values ('demo', 'demo', 'travel'), ('other', 'other', 'travel')`);
await installSeededConfig(t, { deps: { lock: async () => fakeLock() } });
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
      startWecom: () => void calls.push('wecom'),
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
        r['gen_ai.provider.name'] === '_OTHER' &&
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
        r['langfuse.trace.name'] === 'turn',
      json(r),
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
            s.attrs['gen_ai.provider.name'] === '_OTHER' &&
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
    '出错的轮次：根 outcome=error、状态 ERROR；chat 带 error.type=http_5xx、状态 ERROR、没有用量与 response.model',
    f.outcome === 'error' &&
      root?.attrs['app.turn.outcome'] === 'error' &&
      root.span.status?.code === 2 &&
      chat?.attrs['error.type'] === 'http_5xx' &&
      chat.span.status?.code === 2 &&
      !('gen_ai.usage.input_tokens' in chat.attrs) &&
      !('gen_ai.response.model' in chat.attrs) &&
      chat.attrs['gen_ai.request.model'] === 'glm-5.3-flashx',
    json({ root: root?.attrs, chat: chat?.attrs, status: root?.span.status }),
  );
}

// ---------------- demo 类会话：没有 ref，用短码 ----------------
{
  const sid = 'wecom:cust_OtelDemo';
  receiver.bodies.length = 0;
  const { turn: f } = await say(sid, '你好', [{ content: '您好呀～这次想去哪儿玩呢？' }]);
  const { root } = treeOf(await flush(), f.turn.turnId);
  check(
    'demo 类会话：会话引用是短码（与日志的 conv 同一口径），不带会话原 id',
    store.conversationRef(sid) === null &&
      root?.attrs['langfuse.session.id'] === 'DEMO' &&
      root.attrs['gen_ai.conversation.id'] === 'DEMO' &&
      !receiver.bodies.join('\n').includes('OtelDemo'),
    json(root?.attrs),
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
  receiver.down = true;
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
    receiver.down = false;
  }
  const line = warns.find((w) => w.startsWith('[otel] 导出'));
  check('导出端点挂掉：这一轮照常回复', r.turn.outcome === 'replied' && r.text.includes('丽江大理'), r.text);
  check(
    '导出端点挂掉：只记一行日志（类别与条数），不带端点地址；没有未处理的 rejection',
    !!line && line.includes('失败') && !line.includes('127.0.0.1') && !line.includes(otlpUrl) && unhandled === u0,
    json(warns),
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

check('全程没有未处理的 rejection', unhandled === 0, String(unhandled));
otlp.close();
fakeLlm.close();
await t.close().catch(() => undefined);
if (fails.length) {
  console.error(`OPS SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `OPS SELFTEST PASS: ${pass} 项断言全通（边界 lint / 没设端点不加载、不连接 / 运行数字逐字段、时区、60 秒缓存、文件存储 503、角色 403、参数 / OpenTelemetry 的 span 树与属性、默认无原文、capture、出错、短码、端点挂掉、停机 flush）`,
);
process.exit(0);
