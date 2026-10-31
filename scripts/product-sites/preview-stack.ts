// 本机合成预览：不 import env.ts；服务器与数据初始化都在没有 .env 的独立 cwd 内运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { PreviewAccount } from './preview-data.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATE = path.join(ROOT, 'var/preview-stack.json');
const LABEL = 'wecom-sales-agent.preview';
export interface PreviewState {
  version: 1;
  runId: string;
  container: string;
  serverPid: number | null;
  url: string;
  port: number;
  postgresPort: number;
  controlPort: number;
  owner: PreviewAccount;
  agent: PreviewAccount;
}
export function previewNames(runId: string) {
  if (!/^[a-f0-9]{12}$/.test(runId)) throw new Error('preview_invalid_id');
  return { container: `wsa15-preview-${runId}`, directory: `preview-${runId}` };
}
/** 仅预览 app 子进程安装；Node/Hono 未指定 host 时也只能绑定 loopback。 */
export function previewListenArgs(args: readonly unknown[]): unknown[] {
  const port = args[0];
  if (port && typeof port === 'object' && 'port' in port) return [{ ...port, host: '127.0.0.1' }, ...args.slice(1)];
  if (typeof port !== 'number') throw new Error('preview_listen_port_required');
  return [port, '127.0.0.1', ...args.slice(typeof args[1] === 'string' || args[1] === undefined ? 2 : 1)];
}
/** 模拟 Chrome/Firefox 的 HTTP localhost cookie 例外；不改服务端响应，不代表 Safari。 */
export function previewCookie(header: string | null, responseUrl: string, requestUrl = responseUrl): string {
  const source = new URL(responseUrl),
    target = new URL(requestUrl);
  if (source.protocol !== 'http:' || source.hostname !== 'localhost' || source.origin !== target.origin)
    throw new Error('preview_cookie_origin');
  const [pair, ...attributes] = (header ?? '').split(';').map((part) => part.trim());
  if (!/^__Host-sid=[A-Za-z0-9_-]{43}$/.test(pair)) throw new Error('preview_cookie_name');
  const expected = ['httponly', 'max-age=604800', 'path=/', 'samesite=lax', 'secure'];
  if (
    attributes
      .map((part) => part.toLowerCase())
      .toSorted()
      .join(';') !== expected.join(';')
  )
    throw new Error('preview_cookie_attributes');
  return pair;
}
/** 子进程只接受明确列出的环境，不继承模型/数据库/渠道/告警配置。 */
export function previewEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH,
    HOME: source.HOME,
    TMPDIR: source.TMPDIR,
    TZ: 'Asia/Shanghai',
    NODE_ENV: 'production',
    DEPLOY_PROFILE: 'prod',
    APP_ROLE: 'host',
    CONFIG_SOURCE: 'db',
    SESSION_STORE: 'db',
    LLM_MOCK: '1',
    DEFAULT_TENANT_SLUG: 'preview-travel',
    FOLLOWUP_ENABLED: '0',
    FLAG_SANDBOX_ENTRY: 'off',
  };
}
function runtimeDir(state: PreviewState) {
  return path.join(ROOT, 'var', previewNames(state.runId).directory);
}
type InternalCommand = 'seed' | 'serve' | 'app';
/** 当次 up 逐个签发的一次性能力；文件只在当次隔离目录内，不能从运维 shell 继承连接串。 */
export function previewInternalEnv(command: InternalCommand, state: PreviewState, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(runtimeDir(state), `.internal-${command}.json`), JSON.stringify({ token, env, parentPid: process.pid }), {
    mode: 0o600,
    flag: 'wx',
  });
  return { ...env, PREVIEW_INTERNAL_TOKEN: token };
}
export function consumePreviewInternal(
  command: InternalCommand,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
  stateFile = STATE,
): PreviewState {
  const fail = () => {
    throw new Error('preview_internal_denied');
  };
  if (!/^[a-f0-9]{64}$/.test(env.PREVIEW_INTERNAL_TOKEN ?? '')) fail();
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as PreviewState;
    const dir = runtimeDir(state);
    if (
      state.version !== 1 ||
      state.container !== previewNames(state.runId).container ||
      fs.realpathSync(cwd) !== fs.realpathSync(dir) ||
      fs.existsSync(path.join(dir, '.env')) ||
      !Number.isInteger(state.postgresPort) ||
      state.postgresPort < 1 ||
      state.postgresPort > 65535
    )
      fail();
    const ticketFile = path.join(dir, `.internal-${command}.json`);
    const ticket = JSON.parse(fs.readFileSync(ticketFile, 'utf8')) as {
      token: string;
      env: NodeJS.ProcessEnv;
      parentPid: number;
    };
    if (ticket.token !== env.PREVIEW_INTERNAL_TOKEN || !Number.isInteger(ticket.parentPid) || ticket.parentPid < 1) fail();
    process.kill(ticket.parentPid, 0);
    const keys = command === 'seed' ? ['DATABASE_URL', 'DATABASE_OWNER_URL', 'DATABASE_PLATFORM_URL'] : ['DATABASE_URL'];
    if (Object.keys(env).some((key) => key.startsWith('DATABASE_') && !keys.includes(key))) fail();
    for (const key of keys) {
      if (!env[key] || env[key] !== ticket.env[key]) fail();
      const url = new URL(env[key]!);
      const user = key === 'DATABASE_OWNER_URL' ? 'agent_owner' : key === 'DATABASE_PLATFORM_URL' ? 'agent_platform' : 'agent_app';
      if (
        url.protocol !== 'postgres:' ||
        url.hostname !== '127.0.0.1' ||
        url.port !== String(state.postgresPort) ||
        url.pathname !== '/preview' ||
        url.username !== user ||
        !url.password ||
        url.search ||
        url.hash
      )
        fail();
    }
    // 不允许额外继承模型、渠道等环境；通过后只安装 up 签发的已隔离环境。
    if (Object.entries(env).some(([key, value]) => key !== 'PREVIEW_INTERNAL_TOKEN' && value !== ticket.env[key])) fail();
    if (ticket.env.LLM_MOCK !== '1' || ticket.env.DEPLOY_PROFILE !== 'prod') fail();
    fs.unlinkSync(ticketFile);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, ticket.env);
    return state;
  } catch {
    return fail();
  }
}
function writeState(state: PreviewState) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(STATE, 0o600);
}
async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = ROOT,
  deadline = 120_000,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    let stdout = '';
    child.stdout.on('data', (b) => {
      stdout += String(b);
    });
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr += String(b);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('preview_command_start'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(/preview_seed_[a-z_]+/.exec(stderr)?.[0] ?? 'preview_command_failed'));
    });
  });
}
function dockerEnv() {
  return { ...previewEnv(process.env), DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${process.env.HOME}/.colima/default/docker.sock` };
}
const docker = (args: string[], env: NodeJS.ProcessEnv = dockerEnv(), input?: string) => run('docker', args, env, ROOT, 120_000, input);
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
async function serve() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8')) as PreviewState;
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'app'], {
    cwd: runtimeDir(state),
    env: previewInternalEnv('app', state, process.env),
    // 账号、地址及端口仅保留在私有状态文件；不转存服务端的启动信息和详细诊断。
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const shutdown = () => stopChild(child);
  const control = createServer((socket) => {
    socket.setTimeout(2000, () => socket.destroy());
    let message = '';
    socket.on('data', (data) => {
      message += String(data);
      if (message.length > 32) socket.destroy();
      else if (message === `${state.runId}\n`) {
        socket.setTimeout(0);
        closing = true;
        void shutdown().then(() => {
          socket.end('stopped\n');
          control.close();
        });
      } else if (message.includes('\n')) socket.destroy();
    });
  });
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await shutdown();
    control.close();
    process.exit(0);
  };
  control.listen(state.controlPort, '127.0.0.1');
  child.once('exit', () => {
    if (!closing) {
      control.close();
      process.exit(1);
    }
  });
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}
async function down() {
  if (!fs.existsSync(STATE)) return;
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8')) as PreviewState;
  if (state.container !== previewNames(state.runId).container) throw new Error('preview_state_mismatch');
  if (state.serverPid)
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(state.controlPort, '127.0.0.1');
      let acknowledged = false;
      const t = setTimeout(() => {
        socket.destroy();
        reject(new Error('preview_stop_timeout'));
      }, 20_000);
      socket.on('connect', () => socket.write(`${state.runId}\n`));
      socket.on('data', (data) => {
        if (String(data) === 'stopped\n') acknowledged = true;
      });
      socket.on('close', () => {
        clearTimeout(t);
        if (acknowledged) resolve();
        else reject(new Error('preview_stop_unconfirmed'));
      });
      socket.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') acknowledged = true;
        else reject(new Error('preview_stop_failed'));
      });
    });
  const existing = await docker(['ps', '-aq', '--filter', `name=^/${state.container}$`, '--filter', `label=${LABEL}=${state.runId}`]);
  if (existing) await docker(['rm', '-f', '-v', state.container]);
  fs.rmSync(runtimeDir(state), { recursive: true, force: true });
  fs.rmSync(STATE);
}
function previewRequest(state: PreviewState, p: string, init?: RequestInit) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: state.port,
        path: new URL(p, state.url).pathname + new URL(p, state.url).search,
        method: init?.method ?? 'GET',
        headers: { ...Object.fromEntries(new Headers(init?.headers)), host: `localhost:${state.port}` },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('preview_http_timeout')));
    req.end(init?.body as string | undefined);
  });
}
async function verify(state: PreviewState) {
  const request = (p: string, init?: RequestInit) => previewRequest(state, p, init);
  const login = await request('/api/console/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(state.url).origin },
    body: JSON.stringify(state.owner),
  });
  if (login.status !== 200) throw new Error('preview_login_failed');
  const cookie = previewCookie(login.headers.get('set-cookie'), new URL('/api/console/auth/login', state.url).href, state.url);
  if ((await request('/console/', { headers: { cookie } })).status !== 200) throw new Error('preview_console_failed');
  const get = async (p: string) => {
    const response = await request(`/api/console/${p}`, { headers: { cookie } });
    if (response.status !== 200) throw new Error(`preview_http_${p.split('?')[0].replaceAll('/', '_')}_failed`);
    return response.json();
  };
  const me = await get('me');
  if (me.tenantSlug !== 'preview-industrial' || me.role !== 'owner' || me.sharedTrial !== true) throw new Error('preview_identity_failed');
  const usage = await get('usage');
  const conversations = await get('conversations');
  const orders = await get('orders?status=pending_payment&limit=100');
  const metrics = await get('metrics');
  const traces = await get('traces');
  await get('settings/organization');
  if (
    !usage.days.length ||
    !usage.replies.used ||
    metrics.turns < 7 ||
    traces.items.length < 7 ||
    !conversations.items.some((item: { handedOver: boolean }) => item.handedOver) ||
    !orders.items.some((item: { approval?: { state: string } }) => item.approval?.state === 'pending')
  )
    throw new Error('preview_content_missing');
  const agent = await request('/api/console/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state.agent),
  });
  if (agent.status !== 200) throw new Error('preview_agent_login_failed');
  if ((await agent.json()).sharedTrial !== true) throw new Error('preview_trial_notice_missing');
  if (
    (await request('/api/console/usage', { headers: { cookie: previewCookie(agent.headers.get('set-cookie'), state.url) } })).status !== 403
  )
    throw new Error('preview_agent_permission_failed');
}
async function up() {
  await down();
  const runId = randomBytes(6).toString('hex');
  const state: PreviewState = {
    version: 1,
    runId,
    container: previewNames(runId).container,
    serverPid: null,
    url: '',
    port: await freePort(),
    controlPort: await freePort(),
    postgresPort: 0,
    owner: { email: `owner-${randomBytes(4).toString('hex')}@preview.example.test`, password: randomBytes(24).toString('base64url') },
    agent: { email: `agent-${randomBytes(4).toString('hex')}@preview.example.test`, password: randomBytes(24).toString('base64url') },
  };
  state.url = `http://localhost:${state.port}/console/`;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  writeState(state);
  let phase = 'container';
  try {
    const env = dockerEnv();
    const password = randomBytes(24).toString('hex');
    await docker(
      [
        'run',
        '-d',
        '--name',
        state.container,
        '--label',
        `${LABEL}=${runId}`,
        '-e',
        'POSTGRES_PASSWORD',
        '-p',
        '127.0.0.1::5432',
        'pgvector/pgvector:pg17',
      ],
      { ...env, POSTGRES_PASSWORD: password },
    );
    state.postgresPort = Number((await docker(['port', state.container, '5432/tcp'])).split(':').at(-1));
    writeState(state);
    const url = (user: string, pass: string, database: string) => `postgres://${user}:${pass}@127.0.0.1:${state.postgresPort}/${database}`;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        await docker(['exec', state.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await delay(250);
      }
    }
    if (!ready) throw new Error('preview_pg_timeout');
    phase = 'roles';
    const pw = { owner: randomBytes(24).toString('hex'), app: randomBytes(24).toString('hex'), platform: randomBytes(24).toString('hex') };
    const statements = fs
      .readFileSync(path.join(ROOT, 'deploy/db-init/roles.sql'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('--'));
    const roles = statements
      .map((statement) =>
        statement
          .replaceAll(":'owner_password'", `'${pw.owner}'`)
          .replaceAll(":'app_password'", `'${pw.app}'`)
          .replaceAll(":'platform_password'", `'${pw.platform}'`)
          .replaceAll(':"db_name"', '"preview"'),
      )
      .join('\n');
    // 复用正式初始化 SQL；随机口令只经 stdin，不出现在进程参数或日志。
    await docker(['exec', '-i', state.container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], env, roles);
    await docker(
      ['exec', '-i', state.container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'preview'],
      env,
      fs.readFileSync(path.join(ROOT, 'deploy/db-init/extensions.sql'), 'utf8'),
    );
    // 所有 src import 都在空 cwd 内的种子子进程发生，绝不加载开发机 .env。
    const dir = runtimeDir(state);
    fs.mkdirSync(dir, { mode: 0o700 });
    for (const name of ['data', 'public', 'console']) fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
    const common = {
      ...previewEnv(process.env),
      DATABASE_URL: url('agent_app', pw.app, 'preview'),
      DATABASE_PLATFORM_URL: url('agent_platform', pw.platform, 'preview'),
      DATABASE_OWNER_URL: url('agent_owner', pw.owner, 'preview'),
    };
    phase = 'seed';
    await run(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), 'seed'],
      previewInternalEnv('seed', state, common),
      dir,
    );
    phase = 'build';
    await run(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'build'], previewEnv(process.env), dir);
    const log = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
    const serviceEnv = {
      ...previewEnv(process.env),
      DATABASE_URL: common.DATABASE_URL,
      PORT: String(state.port),
      VAR_DIR: path.join(dir, 'state'),
      PUBLIC_BASE_URL: `http://127.0.0.1:${state.port}`,
      ADMIN_PASS: randomBytes(24).toString('hex'),
      TRIAL_TENANT_ALLOWLIST: fs.readFileSync(path.join(dir, 'trial-allowlist.json'), 'utf8'),
    };
    const service = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve'], {
      cwd: dir,
      env: previewInternalEnv('serve', state, serviceEnv),
      detached: true,
      stdio: ['ignore', log, log],
    });
    state.serverPid = service.pid!;
    writeState(state);
    service.unref();
    fs.closeSync(log);
    phase = 'http';
    let healthy = false;
    let readinessError = 'preview_http_transport';
    for (let i = 0; i < 60; i++) {
      try {
        if ((await previewRequest(state, '/console/')).status !== 200) throw new Error('preview_listener_pending');
        healthy = true;
        break;
      } catch (error) {
        if (error instanceof Error && /^preview_[a-z_]+$/.test(error.message)) readinessError = error.message;
        await delay(500);
      }
    }
    if (!healthy) throw new Error(readinessError);
    await verify(state);
    console.log(
      '[preview-stack] ready：HTTP loopback + prod + LLM_MOCK + DB；Secure cookie 属性保持；登录、/me、/usage 200。账号与地址见 var/preview-stack.json。',
    );
  } catch (error) {
    await down();
    throw error instanceof Error && /^preview_[a-z_]+$/.test(error.message) ? error : new Error(`preview_up_${phase}`);
  }
}
async function main(command: string | undefined) {
  // 在任何业务模块 import、迁移和数据库连接之前核验并消费能力。serve 同样不能旁路签发 app。
  const internal =
    command === 'seed' || command === 'app' || command === 'serve' ? consumePreviewInternal(command, process.env) : undefined;
  if (command === 'up') await up();
  else if (command === 'down') {
    await down();
    console.log('[preview-stack] stopped：服务、容器及卷已清理。');
  } else if (command === 'serve') await serve();
  else if (command === 'app') {
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
      return Reflect.apply(listen, this, previewListenArgs(args));
    };
    await import('../../src/server.js');
  } else if (command === 'seed') {
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(process.env.DATABASE_OWNER_URL!);
    const { seedPreview } = await import('./preview-data.js');
    const state = internal!;
    const tenantId = await seedPreview({ app: process.env.DATABASE_URL!, platform: process.env.DATABASE_PLATFORM_URL! }, state);
    fs.writeFileSync(
      path.join(runtimeDir(state), 'trial-allowlist.json'),
      JSON.stringify([{ tenantId, slug: 'preview-industrial', packId: 'industrial', kind: 'standard', isHost: false }]),
      { mode: 0o600 },
    );
  } else if (command === 'build') {
    const vite = createRequire(new URL('../../console/package.json', import.meta.url)).resolve('vite');
    await (
      await import(pathToFileURL(vite).href)
    ).build({ root: path.join(ROOT, 'console'), configFile: path.join(ROOT, 'console/vite.config.ts'), envDir: false });
  } else throw new Error('usage: preview-stack up|down');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv[2]).catch((error: unknown) => {
    console.error(
      `[preview-stack] failed ${error instanceof Error && /^preview_[a-z_]+$/.test(error.message) ? error.message : ''}（未输出私有值）；检查环境后重试 up/down。`,
    );
    process.exitCode = 1;
  });
}
