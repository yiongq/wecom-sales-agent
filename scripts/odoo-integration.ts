/**
 * 本机合成集成：DOCKER_HOST=unix://$HOME/.colima/default/docker.sock pnpm exec tsx scripts/odoo-integration.ts
 * 只使用已安装的 odoo:19、odoo:20、postgres:17、nginx:latest；不拉镜像。
 * 两版顺序执行，总限时 15 分钟；SIGINT / SIGTERM / 失败均清理本次资源。
 * API key 仅通过捕获的 shell 标准输出传入内存，绝不输出原始命令结果或响应体。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redacted } from '../src/channels/secrets.js';
import { autoMapProducts } from '../src/connectors/mapping.js';
import { createOdooConnector } from '../src/connectors/odoo.js';
import { __erpTest, withErpTurn } from '../src/connectors/registry.js';
import { sealConnectorSecrets } from '../src/connectors/secrets.js';
import { ErpError, type ErpConnector } from '../src/connectors/types.js';
import { packSources } from '../src/core/engine/sources.js';
import { bindPack } from '../src/core/pack-api.js';
import { createEgress, EgressError } from '../src/net/egress.js';
import { createIndustrialRuntime } from '../src/packs/industrial/runtime.js';
import { createTenantRuntime, registerRuntime, unregisterRuntime, withTenantScope } from '../src/tenancy/runtime.js';

const prefix = `wsa11-it-${process.pid}-${randomBytes(3).toString('hex')}`;
const dockerEnv = { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${homedir()}/.colima/default/docker.sock` };
const containers: string[] = [];
const volumes: string[] = [];
const networks: string[] = [];
const children = new Set<ChildProcess>();
const abort = new AbortController();
let phase = 'preflight';
let cleanupPromise: Promise<void> | undefined;

// docker 的 stdout/stderr 可能含凭据和响应体，只捕获、不透传；失败只报阶段与固定错误码。
function docker(args: string[], input?: string, timeout = 30_000, cleaning = false): Promise<string> {
  if (!cleaning) abort.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    const kill = () => {
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(kill, timeout);
    if (!cleaning) abort.signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) kill();
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', kill);
      children.delete(child);
      const output = Buffer.concat(chunks).toString('utf8');
      if (code === 0 && !stopped) resolve(output);
      else {
        // 只允许输出自编 fixture 的固定诊断码，不输出异常文字、key 或响应。
        const diagnostic = output.split('\n').find((line) => /^WSA_FIXTURE_FAILURE=\d+:[A-Za-z]+$/.test(line));
        if (diagnostic) console.error(diagnostic);
        reject(new Error(stopped ? 'docker_timeout_or_abort' : 'docker_failed'));
      }
    });
    child.stdin.end(input);
  });
}

async function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    __erpTest.reset();
    for (const names of [containers, volumes, networks]) {
      for (const name of names.toReversed()) {
        const args = names === containers ? ['rm', '-f', '-v', name] : [names === volumes ? 'volume' : 'network', 'rm', name];
        // 失败可能发生在 create 之前；最终列表核对区分不存在与清理失败。
        await docker(args, undefined, 15_000, true).catch(() => {});
      }
    }
    for (const [args, names] of [
      [['ps', '-a', '--format', '{{.Names}}'], containers],
      [['volume', 'ls', '--format', '{{.Name}}'], volumes],
      [['network', 'ls', '--format', '{{.Name}}'], networks],
    ] as const) {
      const remaining = (await docker([...args], undefined, 15_000, true)).trim().split('\n');
      assert.ok(!remaining.some((name) => names.includes(name)), 'cleanup_remaining');
    }
    assert.equal(children.size, 0, 'child_process_remaining');
    console.log('CLEANUP PASS: 本次容器、卷、网络与 docker 子进程均已清理');
  })();
  return cleanupPromise;
}

function stop(): void {
  abort.abort(new Error('interrupted_or_total_timeout'));
}
// registry 的传递导入会安装应用的 gracefulExit（8 秒后 process.exit）。
// 这是独立集成进程，信号由脚本接管，给 finally 留足清理 Docker 的时间。
process.removeAllListeners('SIGINT');
process.removeAllListeners('SIGTERM');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const totalTimer = setTimeout(stop, 15 * 60_000);
const pause = (ms: number) => sleep(ms, undefined, { signal: abort.signal });

interface Fixture {
  apiKey: string;
  emptyKey: string;
  locationA: number;
  locationB: number;
  unit: number;
  ids: number[];
  archived: number;
  version: string;
}

// 自行编写的 fixture，仅调用公开 ORM；19 / 20 的造预留字段差异不进入产品代码。
const fixturePython = `
import json
from datetime import datetime, timedelta
import odoo
company = env.company
company.currency_id = env.ref('base.CNY')
group_field = 'group_ids' if 'group_ids' in env['res.users']._fields else 'groups_id'
robot = env['res.users'].with_context(no_reset_password=True).create({
    'name': 'Synthetic ERP robot', 'login': 'robot@erp.example.test',
    'company_id': company.id, 'company_ids': [(6, 0, [company.id])],
    group_field: [(6, 0, [env.ref('stock.group_stock_user').id])],
})
assert robot.has_group('stock.group_stock_user')
assert not robot.has_group('base.group_system')
assert not robot.has_group('stock.group_stock_manager')
unit = env.ref('uom.product_uom_unit')
other_unit = env.ref('uom.product_uom_kgm')
locs = env['stock.location'].create([
    {'name': 'Synthetic A', 'usage': 'internal', 'company_id': company.id},
    {'name': 'Synthetic B', 'usage': 'internal', 'company_id': company.id},
])
def product(code, uom=unit):
    return env['product.product'].create({
        'name': 'Synthetic bearing', 'default_code': code, 'sale_ok': True,
        'type': 'consu', 'is_storable': True, 'uom_id': uom.id,
    })
products = env['product.product']
for i in range(30):
    p = product('6205-2RS' if i == 0 else str(7000+i) + '-2RS')
    products |= p
    env['stock.quant']._update_available_quantity(p, locs[0], 12.5 if i == 0 else 40+i)
    env['stock.quant']._update_available_quantity(p, locs[1], 21.25 if i == 0 else 80+i)
product('6206-2RS')
product('6206-2RS')
product('6207-2RS', other_unit)
archived = product('6208-2RS')
archived.active = False
move = env['stock.move'].create({
    'product_id': products[0].id, 'product_uom_qty': 3,
    ('product_uom' if 'product_uom' in env['stock.move']._fields else 'uom_id'): unit.id,
    'location_id': locs[0].id, 'location_dest_id': env.ref('stock.stock_location_customers').id,
    'company_id': company.id,
})
move._action_confirm()
move._action_assign()
assert move.state == 'assigned'
assert products[0].with_context(location=locs[0].id).free_qty == 9.5
assert products[0].with_context(location=locs[1].id).free_qty == 21.25
for name in ['sale_management', 'stock']:
    module = env['ir.module.module'].search([('name', '=', name)])
    assert module.state == 'installed'
    if 'demo' in module._fields:
        assert not module.demo
expiry = datetime.now() + timedelta(days=7)
keys = env['res.users.apikeys'].with_user(robot)
api_key = keys._generate('rpc', 'Synthetic integration', expiry)
empty_key = keys._generate('', 'Synthetic empty scope', expiry)
env.cr.commit()
if odoo.release.version_info[0] == 19:
    env.registry.signal_changes()
print('WSA_FIXTURE=' + json.dumps({
    'apiKey': api_key, 'emptyKey': empty_key, 'locationA': locs[0].id,
    'locationB': locs[1].id, 'unit': unit.id, 'ids': products.ids,
    'archived': archived.id, 'version': odoo.release.version,
}))
`;

async function start(version: number): Promise<{ fixture: Fixture; url: string; app: string; network: string }> {
  phase = `Odoo ${version} network/postgres`;
  const root = `${prefix}-${version}`;
  const network = root;
  networks.push(network);
  await docker(['network', 'create', network]);
  const pgVolume = `${root}-pg-data`;
  const appVolume = `${root}-odoo-data`;
  for (const volume of [pgVolume, appVolume]) {
    volumes.push(volume);
    await docker(['volume', 'create', volume]);
  }
  const pg = `${root}-pg`;
  containers.push(pg);
  await docker([
    'run',
    '--pull=never',
    '-d',
    '--name',
    pg,
    '--network',
    network,
    '-e',
    'POSTGRES_USER=odoo',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=postgres',
    '-v',
    `${pgVolume}:/var/lib/postgresql/data`,
    'postgres:17',
  ]);
  for (let i = 0; ; i++) {
    try {
      await docker(['exec', pg, 'pg_isready', '-U', 'odoo']);
      break;
    } catch {
      if (i >= 60 || abort.signal.aborted) throw new Error('postgres_not_ready');
      await pause(500);
    }
  }
  const app = `${root}-odoo`;
  const init = `${root}-init`;
  const common = ['--network', network, '-e', `HOST=${pg}`, '-e', 'USER=odoo', '-v', `${appVolume}:/var/lib/odoo`];
  const odooArgs = ['-d', 'wsa11_it', '--workers=0', '--max-cron-threads=0'];
  phase = `Odoo ${version} init`;
  containers.push(init);
  await docker([
    'run',
    '--pull=never',
    '-d',
    '--name',
    init,
    ...common,
    `odoo:${version}`,
    'odoo',
    ...odooArgs,
    '-i',
    'sale_management,stock',
    '--without-demo',
    '--stop-after-init',
    '--no-http',
  ]);
  assert.equal((await docker(['wait', init], undefined, 240_000)).trim(), '0', 'odoo_init');
  phase = `Odoo ${version} HTTP startup`;
  containers.push(app);
  await docker(['run', '--pull=never', '-d', '--name', app, ...common, '-p', '127.0.0.1::8069', `odoo:${version}`, 'odoo', ...odooArgs]);
  const port = (await docker(['port', app, '8069/tcp'])).trim().split(':').at(-1)!;
  assert.match(port, /^\d+$/);
  const url = `http://127.0.0.1:${port}`;
  // 无鉴权就绪检查也走唯一出站；不输出 HTTP 内容。
  const ready = createEgress(url, { allowLoopback: true });
  for (let i = 0; ; i++) {
    try {
      const response = await ready({ path: '/web/login', headers: {}, body: '', deadline: Date.now() + 2000, maxBytes: 256 * 1024 });
      if (response.status < 500) break;
    } catch {
      if (abort.signal.aborted) throw new Error('interrupted');
    }
    if (i >= 60) throw new Error('odoo_not_ready');
    await pause(500);
  }
  phase = `Odoo ${version} fixture`;
  const fixtureInput = `import traceback\ntry:\n${fixturePython
    .split('\n')
    .map((line) => `    ${line}`)
    .join(
      '\n',
    )}\nexcept Exception as exc:\n    frame = next(f for f in traceback.extract_tb(exc.__traceback__) if f.filename == '<string>')\n    print('WSA_FIXTURE_FAILURE=' + str(frame.lineno) + ':' + type(exc).__name__)\n    raise SystemExit(1)\n`;
  const output = await docker(
    ['exec', '-i', app, 'odoo', 'shell', ...odooArgs, '--no-http', '--db_host', pg, '--db_user', 'odoo'],
    fixtureInput,
    60_000,
  );
  const line = output.split('\n').find((value) => value.startsWith('WSA_FIXTURE='));
  assert.ok(line, 'fixture_missing');
  return { fixture: JSON.parse(line.slice('WSA_FIXTURE='.length)) as Fixture, url, app, network };
}

function connector(url: string, fixture: Fixture, locationId = fixture.locationA, apiKey = fixture.apiKey): ErpConnector {
  return createOdooConnector({
    send: createEgress(url, { allowLoopback: true }),
    apiKey: new Redacted({ apiKey }),
    database: 'wsa11_it',
    locationId,
  });
}

async function benchmark(client: ErpConnector, ids: number[]): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < 21; i++) {
    if (i) await pause(1100);
    const start = performance.now();
    const values = await client.stock(ids, Date.now() + 1000);
    times.push(performance.now() - start);
    assert.equal(values.size, 30, 'stock_30');
    assert.equal(values.get(ids[0])?.freeQty, 9, 'reserved_free_qty_floor');
    for (let j = 1; j < ids.length; j++) assert.equal(values.get(ids[j])?.freeQty, 40 + j);
  }
  const sorted = times.slice(1).toSorted((a, b) => a - b);
  console.log(JSON.stringify({ firstMs: times[0], subsequent: 20, p50Ms: sorted[9], p90Ms: sorted[17], maxMs: sorted[19] }));
}

async function integrate(version: number, fixture: Fixture, url: string): Promise<void> {
  const client = connector(url, fixture);
  assert.deepEqual(await client.check(), { companyCurrency: 'CNY', locationOk: true });
  await pause(1100);
  const tenant = createTenantRuntime({ id: randomUUID(), slug: `erp-integration-${version}` });
  registerRuntime(tenant);
  try {
    await withTenantScope(tenant, async () => {
      const sources = packSources();
      const runtime = createIndustrialRuntime(sources);
      const erp = sources.erp;
      bindPack(runtime, runtime.defaultBrand);
      const codes = Array.from({ length: 30 }, (_, i) => (i === 0 ? '6205-2RS' : `${7000 + i}-2RS`));
      const items = [...codes, '6206-2RS', '6207-2RS', '6208-2RS', '6209-2RS'].map((partNo, i) => ({
        kind: 'part',
        code: `part-${i}`,
        status: 'active',
        payload: { partNo, unit: '件' },
      }));
      const connectorId = randomUUID();
      const mapping = await autoMapProducts({
        declaration: runtime.erp!,
        items,
        connectorId,
        connector: client,
        uom: { 件: fixture.unit },
        existing: [],
      });
      assert.deepEqual(
        mapping.mapped,
        items.slice(0, 30).map((item) => item.code),
      );
      assert.deepEqual(mapping.unmapped, ['part-32', 'part-33']);
      assert.deepEqual(mapping.conflict, ['part-30']);
      assert.deepEqual(mapping.unitMismatch, ['part-31']);
      assert.deepEqual(
        mapping.links.map((link) => link.remoteId),
        fixture.ids,
      );
      await pause(1100);
      const archive = (await client.stock([fixture.archived], Date.now() + 1000)).get(fixture.archived);
      assert.equal(archive?.active, false);
      await pause(1100);
      assert.equal(
        (await connector(url, fixture, fixture.locationB).stock([fixture.ids[0]], Date.now() + 1000)).get(fixture.ids[0])?.freeQty,
        21,
      );
      const key = randomBytes(32);
      const ring = { current: { id: 'integration', key }, all: new Map([['integration', key]]) };
      const sealed = sealConnectorSecrets(ring, { tenantId: tenant.id, connectorId }, { apiKey: fixture.apiKey });
      __erpTest.configure({ factory: () => client, alert: () => {} });
      __erpTest.install(
        {
          id: connectorId,
          kind: 'odoo',
          status: 'active',
          baseUrl: 'https://erp.example.test',
          database: 'wsa11_it',
          settings: { locationId: fixture.locationA, uom: { 件: fixture.unit }, keyExpiresAt: '2030-01-01' },
          secretsCt: sealed.ct,
          secretsKeyId: sealed.keyId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        mapping.links,
        ring,
      );
      assert.equal(erp.active('part'), true);
      assert.equal(erp.mapped('part', '6205-2RS'), false);
      await pause(1100);
      const values = await withErpTurn(() =>
        erp.availability(
          'part',
          items.map((item) => item.code),
        ),
      );
      assert.equal(values.size, 30, 'registry_availability');
      assert.equal(values.get('part-0')?.onHand, 9);
      for (let i = 1; i < 30; i++) assert.equal(values.get(`part-${i}`)?.onHand, 40 + i);
      assert.equal(erp.fresh('part', 'part-0')?.onHand, 9);
      console.log(
        `ASSERT PASS Odoo ${version}: CNY/locationOk; mapped=30 unmapped=2 conflict=1 unitMismatch=1; A=9 B=21; archived=false; registry=30`,
      );
    });
  } finally {
    __erpTest.reset();
    unregisterRuntime(tenant.id);
  }
  if (version === 20) {
    await pause(1100);
    await assert.rejects(
      connector(url, fixture, fixture.locationA, fixture.emptyKey).check(),
      (error: unknown) => error instanceof ErpError && error.code === 'auth',
    );
    console.log('ASSERT PASS Odoo 20: empty scope -> auth (401)');
  }
  await pause(1100);
  console.log(`BENCH Odoo ${version} direct HTTP, 30 products, 1+20 requests, gap=1100ms`);
  await benchmark(connector(url, fixture), fixture.ids);
}

async function proxy(fixture: Fixture, app: string, network: string): Promise<void> {
  const name = `${prefix}-20-nginx`;
  containers.push(name);
  phase = 'Odoo 20 nginx create';
  // 不挂载配置文件；stdin 只含合成配置，日志只记录连接号、请求序号、状态码。
  // 先保持容器存活，写完配置再启动 nginx，避免默认 entrypoint 启动与 reload 竞态。
  await docker([
    'run',
    '--pull=never',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '-p',
    '127.0.0.1::80',
    '--entrypoint',
    'sleep',
    'nginx:latest',
    '900',
  ]);
  phase = 'Odoo 20 nginx configure';
  await docker(
    ['exec', '-i', name, 'sh', '-c', 'cat > /etc/nginx/nginx.conf'],
    `
events {}
http {
  log_format connections '$connection $connection_requests $status';
  access_log /var/log/nginx/wsa-connections.log connections;
  error_log /dev/null crit;
  keepalive_timeout 4s;
  server {
    listen 80;
    location / {
      proxy_pass http://${app}:8069;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host erp.example.test;
    }
  }
}
`,
  );
  phase = 'Odoo 20 nginx start';
  await docker(['exec', name, 'nginx']);
  phase = 'Odoo 20 nginx version';
  const nginxVersion = (await docker(['exec', name, 'sh', '-c', 'nginx -v 2>&1'])).trim();
  assert.match(nginxVersion, /^nginx version: nginx\/[\d.]+$/);
  console.log(nginxVersion);
  await pause(1100);
  const port = (await docker(['port', name, '80/tcp'])).trim().split(':').at(-1)!;
  assert.match(port, /^\d+$/);
  const client = connector(`http://127.0.0.1:${port}`, fixture);
  phase = 'Odoo 20 nginx benchmark/idle';
  console.log('BENCH Odoo 20 via nginx HTTP, 30 products, 1+20 requests, gap=1100ms, keepalive_timeout=4s');
  await benchmark(client, fixture.ids);
  const readLog = async () =>
    (await docker(['exec', name, 'cat', '/var/log/nginx/wsa-connections.log']))
      .trim()
      .split('\n')
      .map((line) => {
        assert.match(line, /^\d+ \d+ 200$/, 'nginx_log_shape');
        const [connection, requests, status] = line.split(' ').map(Number);
        return { connection, requests, status };
      });
  const before = await readLog();
  assert.equal(before.length, 21);
  assert.equal(new Set(before.map((entry) => entry.connection)).size, 1, 'nginx_connection_reuse');
  assert.deepEqual(
    before.map((entry) => entry.requests),
    Array.from({ length: 21 }, (_, i) => i + 1),
  );
  await pause(5500);
  const start = performance.now();
  assert.equal((await client.stock(fixture.ids, Date.now() + 1000)).size, 30);
  const idleMs = performance.now() - start;
  const after = await readLog();
  assert.equal(after.length, 22);
  assert.notEqual(after[21].connection, before[20].connection, 'idle_new_connection');
  assert.equal(after[21].requests, 1);
  console.log(
    JSON.stringify({
      odooVersion: 20,
      reused: 20,
      requests: 21,
      reuseRate: 20 / 21,
      subsequentReuseRate: 1,
      idleWaitMs: 5500,
      idleMs,
      idleNewConnection: true,
      idleStatus: 'ok',
      networkErrors: 0,
    }),
  );
}

try {
  for (const image of ['postgres:17', 'odoo:19', 'odoo:20', 'nginx:latest']) {
    await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  }
  for (const version of [19, 20]) {
    phase = `Odoo ${version} setup`;
    console.log(`START ${phase}`);
    const { fixture, url, app, network } = await start(version);
    console.log(`VERSION ${fixture.version}`);
    phase = `Odoo ${version} assertions/benchmark`;
    await integrate(version, fixture, url);
    if (version === 20) {
      phase = 'Odoo 20 nginx';
      await proxy(fixture, app, network);
    }
    // 两版不同时占用运行资源；最终 finally 再核对所有登记项。
    for (const name of containers.filter((value) => value.startsWith(`${prefix}-${version}-`)).toReversed())
      await docker(['rm', '-f', '-v', name]);
  }
  console.log('INTEGRATION PASS: Odoo 19 + 20');
} catch (error) {
  const code =
    error instanceof ErpError || error instanceof EgressError
      ? error.code
      : error instanceof assert.AssertionError
        ? 'assertion'
        : 'setup_or_interrupted';
  console.error(`INTEGRATION FAIL: ${phase}; ${code}`);
  process.exitCode = 1;
} finally {
  // 先中止所有在途命令，防止清理之后才创建资源。
  stop();
  while (children.size) await sleep(20);
  try {
    await cleanup();
  } catch {
    console.error('CLEANUP FAIL: 请核对本次 wsa11-it- 资源');
    process.exitCode = 1;
  }
  clearTimeout(totalTimer);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
