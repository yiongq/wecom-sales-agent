// 17 R9 / 验收 10：真实 webhook、完整 server 入口、固定手册与可信链接。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ALERT_POLICY, RUNBOOKS, type AlertKey, type RunbookKey } from '../shared/alert-policy.js';
import { alert, alertReplyLatency, __alertTest } from './alert.js';
import { opsFixture, receiver } from './digest.selftest.js';
import { readRunbook } from './runbooks.js';
import { checkLatency } from './latency.js';
import { createUser } from '../auth/accounts.js';
import { openDb } from '../db/client.js';
import { purgeExpiredTraces } from '../db/repo/retention.js';
import { withTenantScope, withoutTenantScope } from '../tenancy/runtime.js';
import { installPublicHost } from '../tenancy/hosts.js';
import { __profileTest } from '../profile.js';

function policyContract() {
  const keys: AlertKey[] = [
    'reply_latency',
    'usage_limit',
    'erp',
    'attachment_limit',
    'model_errors',
    'wecom_send',
    'tenant_lock',
    'store',
    'jobs',
    'channel',
    'tenant_scope_missing',
    'sandbox_pool',
    'sandbox_purge',
    'sandbox_send_refused',
    'sandbox_wecom_full',
  ];
  assert.deepEqual(Object.keys(ALERT_POLICY).sort(), keys.sort());
  for (const key of ['tenant_lock', 'tenant_scope_missing', 'sandbox_send_refused'] as const)
    assert.equal(ALERT_POLICY[key].severity, 'P1');
  for (const key of ['usage_limit', 'attachment_limit', 'sandbox_pool', 'sandbox_wecom_full'] as const)
    assert.equal(ALERT_POLICY[key].severity, 'P3');
  for (const key of ['reply_latency', 'model_errors', 'wecom_send', 'channel', 'erp', 'jobs', 'store', 'sandbox_purge'] as const)
    assert.equal(ALERT_POLICY[key].severity, 'P2');
  for (const policy of Object.values(ALERT_POLICY)) {
    assert.match(policy.severity, /^P[123]$/);
    assert.ok(Object.hasOwn(RUNBOOKS, policy.runbook));
  }
  const text = fs.readFileSync('docs/ops/observability.md', 'utf8');
  const headers = [...text.matchAll(/^## (RB-\d{2}) ([a-z_]+) · (.+)$/gm)];
  assert.deepEqual(headers.map((m) => m[2]).sort(), Object.keys(RUNBOOKS).sort(), '手册无多余/缺失小节');
  assert.equal(new Set(headers.map((m) => m[1])).size, headers.length);
  for (const [key, book] of Object.entries(RUNBOOKS)) {
    const section = readRunbook(key);
    assert.ok(section, key);
    assert.equal(section.code, book.code);
    assert.equal(section.title, book.title);
    const start = text.indexOf(`## ${book.code} ${key} · ${book.title}\n`);
    const end = text.indexOf('\n## ', start + 1);
    assert.equal(section.body, text.slice(start, end < 0 ? undefined : end + 1));
    for (const heading of ['症状', '只读检查命令', '下一步', '恢复证据', '什么情况下停止自动重试'])
      assert.ok(section.body.includes(`### ${heading}\n`), `${key}: ${heading}`);
  }
  assert.equal(readRunbook('__proto__'), undefined);
}

function runbookCacheContract() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-cache-'));
  try {
    fs.mkdirSync(path.join(temporary, 'src/ops'), { recursive: true });
    fs.mkdirSync(path.join(temporary, 'src/shared'), { recursive: true });
    fs.copyFileSync('src/ops/runbooks.ts', path.join(temporary, 'src/ops/runbooks.ts'));
    fs.copyFileSync('src/shared/alert-policy.ts', path.join(temporary, 'src/shared/alert-policy.ts'));
    fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(path.resolve('node_modules'), path.join(temporary, 'node_modules'));
    // 缺文件不让 import 失败；首次读失败缓存为 unavailable，重启后才能重新读取。
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { readRunbook } from './src/ops/runbooks.ts';
      assert.equal(readRunbook('not_whitelisted'), undefined);
      assert.equal(readRunbook('jobs'), null);
      fs.mkdirSync('docs/ops', { recursive: true });
      fs.copyFileSync(process.env.RUNBOOK_TEST_SOURCE, 'docs/ops/observability.md');
      assert.equal(readRunbook('jobs'), null);
    `,
      ],
      {
        cwd: temporary,
        env: { ...process.env, RUNBOOK_TEST_SOURCE: path.resolve('docs/ops/observability.md') },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function suite(real: boolean) {
  policyContract();
  runbookCacheContract();
  const fx = await opsFixture(real);
  const net = await receiver();
  const hostname = 'alerts.example.test';
  const otherHost = 'other.alerts.example.test';
  const platform = real ? await openDb(fx.urls!.platform) : undefined;
  let server: ReturnType<typeof serve> | undefined;
  let now = Date.now();
  const uuid = randomUUID();
  process.env.ALERT_WEBHOOK_URL = net.url;
  process.env.INSTANCE_LABEL = 'synthetic-alerts';
  process.env.PUBLIC_BASE_URL = `https://${hostname}`;
  __alertTest.setClock(() => now);
  installPublicHost(fx.host, hostname);
  installPublicHost(fx.other, otherHost);
  const send = async (key: AlertKey, text = '固定错误码 E_TEST 计数 3', opts: Parameters<typeof alert>[2] = {}) => {
    __alertTest.reset();
    net.messages.length = 0;
    await withTenantScope(fx.host, () => alert(key, text, opts));
    await __alertTest.settle();
    assert.equal(net.messages.length, 1);
    return net.messages[0]!;
  };
  try {
    for (const [key, policy] of Object.entries(ALERT_POLICY)) {
      const content = await send(key as AlertKey);
      assert.match(content, new RegExp(`^\\[synthetic-alerts\\] \\[${policy.severity}\\]`));
      assert.ok(content.includes(`手册 ${RUNBOOKS[policy.runbook].code}`));
    }
    for (const runbook of ['__proto__', 'https://evil.example.test', 'store\r\n定位 https://evil.example.test']) {
      const msg = await send('jobs', 'E_TEST', { runbook: runbook as RunbookKey });
      assert.ok(msg.includes('/console/ops/runbooks/jobs'));
      assert.ok(!msg.includes('evil.example.test'));
    }
    const evil = 'https://evil.example.test/fake?token=bad';
    const msg = await send('reply_latency', `E_TEST ${evil}\r\n定位 ${evil} wecom:wmLeak42`, { scope: evil, traceId: uuid });
    assert.ok(!msg.includes(evil));
    assert.ok(!msg.includes('\r'));
    assert.ok(!msg.includes('wecom:') && !msg.includes('wmLeak42'));
    assert.deepEqual(msg.match(/https:\/\/\S+/g), [
      `https://${hostname}/console/ops/runbooks/reply_latency`,
      `https://${hostname}/console/traces/${uuid}`,
    ]);
    assert.equal(msg.split('\n').length, 3, 'CRLF 不能伪造类型化行');
    for (const bad of ['', evil, `${uuid}/extra`, `${uuid}\r\n${evil}`, `${uuid.slice(0, 14)}0${uuid.slice(15)}`]) {
      const message = await send('reply_latency', 'E_TEST', { traceId: bad });
      assert.ok(!message.includes('/traces/'));
      assert.ok(message.includes('无可用单轮记录'));
    }
    for (const base of [
      '',
      'http://alerts.example.test',
      'https://user@alerts.example.test',
      'https://user:pass@alerts.example.test',
      'https://',
    ]) {
      process.env.PUBLIC_BASE_URL = base;
      const content = await send('reply_latency', 'E_TEST', { traceId: uuid });
      assert.ok(!content.includes('https://') && !content.includes('http://'), base);
      assert.ok(content.includes('手册 RB-07\n无可用单轮记录'));
    }
    process.env.PUBLIC_BASE_URL = `https://${hostname}/untrusted-path?next=${evil}`;
    assert.ok(!(await send('jobs')).includes('untrusted-path'));
    process.env.PUBLIC_BASE_URL = 'https://ALERTS.EXAMPLE.TEST.:8443/configured/path';
    assert.ok((await send('jobs')).includes('https://alerts.example.test:8443/console/ops/runbooks/jobs'));
    process.env.PUBLIC_BASE_URL = `https://${hostname}`;
    __alertTest.reset();
    net.messages.length = 0;
    await withTenantScope(fx.other, () => alert('reply_latency', 'E_OTHER_TENANT', { traceId: uuid }));
    await __alertTest.settle();
    assert.ok(!net.messages[0]!.includes(hostname), '其他租户不能借用宿主 publicBase');
    assert.match(net.messages[0]!, /无可用单轮记录/);
    assert.ok(!(await send('jobs', 'E_TEST', { instance: true, traceId: uuid })).includes('https://'));
    __alertTest.reset();
    net.messages.length = 0;
    await withoutTenantScope(() => alert('jobs', 'E_INSTANCE', { instance: true }));
    await __alertTest.settle();
    assert.ok(!net.messages[0]!.includes('https://'));
    // 同键恢复不能用默认 P2 或调用者 P3 覆盖原 P1。
    await send('store', 'E_CONFLICT', { severity: 'P1' });
    await withTenantScope(fx.host, () => alert('store', 'E_RECOVERED', { severity: 'P3', resolved: true }));
    await __alertTest.settle();
    assert.match(net.messages.at(-1)!, /\[P1\] 已恢复/);

    const { app } = await import('../server.js');
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    if (!server.listening) await new Promise<void>((resolve) => server!.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // node:http 保留真实 Host 头；fetch 的实现可能重写 Host，不能用来验证多租户路由。
    const req = (pathname: string, cookie = '', host = hostname, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        const request = http.request(
          `${origin}${pathname}`,
          {
            method: init.method ?? 'GET',
            headers: { host, cookie, ...Object.fromEntries(new Headers(init.headers)) },
            timeout: 10_000,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers))
                if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
              resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
            });
            response.on('error', reject);
          },
        );
        request.on('timeout', () => request.destroy(new Error('selftest_http_timeout')));
        request.on('error', reject);
        request.end(init.body);
      });
    const users = new Map<string, string>();
    for (const [role, rt, host] of [
      ['owner', fx.host, hostname],
      ['admin', fx.host, hostname],
      ['supervisor', fx.host, hostname],
      ['agent', fx.host, hostname],
      ['viewer', fx.host, hostname],
      ['other', fx.other, otherHost],
    ] as const) {
      await fx.setRole('agent_platform');
      try {
        const made = await createUser(platform?.db ?? fx.db, {
          tenantSlug: rt === fx.host ? 'demo' : rt.slug,
          email: `${role}@alerts.example.test`,
          name: `synthetic-member-${role}`,
          role: role === 'other' ? 'owner' : role,
          password: async () => `synthetic-password-${role}`,
        });
        assert.equal(made.code, 0, made.message);
      } finally {
        await fx.setRole('agent_app');
      }
      const response = await req('/api/console/auth/login', '', host, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${role}@alerts.example.test`, password: `synthetic-password-${role}` }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      users.set(role, response.headers.get('set-cookie')!.split(';')[0]!);
    }
    const tracePath = `/api/console/traces/${uuid}`;
    const bookPath = '/api/console/ops/runbooks/reply_latency';
    for (const pathname of [tracePath, bookPath]) {
      assert.equal((await req(pathname)).status, 401);
      for (const role of ['supervisor', 'agent', 'viewer']) assert.equal((await req(pathname, users.get(role))).status, 403);
    }
    for (const role of ['owner', 'admin']) {
      const response = await req(bookPath, users.get(role));
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), readRunbook('reply_latency'));
    }
    for (const key of ['unknown', '__proto__', 'constructor'])
      assert.equal((await req(`/api/console/ops/runbooks/${key}`, users.get('owner'))).status, 404);
    assert.equal((await req(tracePath, users.get('owner'))).status, 404, '不存在/过期记录');
    // 三个慢窗经真实 SQL 挑选 trace，webhook 定位链接用同一登录 cookie 打开。
    const end = Math.floor(Date.now() / 300_000) * 300_000;
    await fx.query(
      `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
      values($1,'policy-conversation','wecom','new',false,'{"id":"policy-conversation"}',now(),now())`,
      [fx.host.id],
    );
    for (let window = 0; window < 3; window++) {
      const at = new Date(end - (2 - window) * 300_000 - 60_000);
      await fx.query(
        `with inserted as (
        insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm,final_text)
        select $1,gen_random_uuid(),'policy-conversation',$2,9001,'replied',$3,'{}','[]','[]','合成客户正文不可出群' from generate_series(1,20)
        returning id,started_at
      ) insert into messages(tenant_id,conversation_id,seq,role,content,at,turn_id)
        select $1,'policy-conversation',$4::int+(row_number() over())::int,'agent','合成客户正文不可出群',started_at,id from inserted`,
        [fx.host.id, at, 'a'.repeat(64), window * 20],
      );
    }
    process.env.OPS_LATENCY_TENANTS = 'demo';
    __alertTest.reset();
    net.messages.length = 0;
    for (let window = 0; window < 3; window++) {
      now = end - (2 - window) * 300_000 + 60_000;
      await withTenantScope(fx.host, () => checkLatency(now));
    }
    await __alertTest.settle();
    assert.equal(net.messages.length, 1);
    const notification = net.messages[0]!;
    const url = new URL(notification.match(/^定位 (\S+)$/m)![1]!);
    assert.equal(url.hostname, hostname);
    const id = url.pathname.split('/').at(-1)!;
    const response = await req(`/api${url.pathname}`, users.get('owner'));
    assert.equal(response.status, 200, await response.clone().text());
    const trace = await response.json();
    assert.equal(trace.turnId, id);
    assert.equal(trace.durationMs, 9001);
    for (const secret of ['合成客户正文不可出群', 'policy-conversation', 'synthetic-member', 'external_userid', 'corp_id', 'open_kfid'])
      assert.ok(!notification.includes(secret));
    assert.equal((await req(`/api${url.pathname}`)).status, 401);
    assert.equal((await req(`/api${url.pathname}`, users.get('other'), otherHost)).status, 404);
    assert.equal((await req(`/api${url.pathname}`, users.get('owner'), 'forged.example.test')).status, 404);
    assert.equal((await req(bookPath, users.get('owner'), hostname, { headers: { 'x-forwarded-host': 'evil.example.test' } })).status, 200);
    assert.ok(!notification.includes('forged.example.test') && !notification.includes('evil.example.test'));
    // 保留期清除后同一链接统一 404（直接到期清掉 trace，不留下正文）。
    await fx.query(
      `update turn_traces set started_at = now() - (select retention_trace_days + 1 from tenants where id=$1)::int * interval '24 hours' where tenant_id=$1 and id=$2`,
      [fx.host.id, id],
    );
    assert.ok((await fx.tx((tx) => purgeExpiredTraces(tx, new Date()))) >= 1);
    assert.equal((await req(`/api${url.pathname}`, users.get('owner'))).status, 404);
    await withTenantScope(fx.host, () => alertReplyLatency('E_NO_TRACE', false, null));
    await __alertTest.settle();
    assert.match(net.messages.at(-1)!, /无可用单轮记录/);
    console.log(
      `${real ? 'PG' : 'PGlite'} ALERT POLICY PASS: exhaustive policy/docs, safe URLs, recovery severity, real HTTP auth/tenant/expiry, latency webhook → trace`,
    );
  } finally {
    __profileTest.reset();
    __alertTest.setClock(null);
    (server as http.Server | undefined)?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await platform?.close();
    await net.close();
    await fx.close();
  }
}
const self = fileURLToPath(import.meta.url);
if (process.env.ALERT_POLICY_TEST) await suite(process.env.ALERT_POLICY_TEST === 'pg');
else
  for (const mode of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', self], {
      env: { ...process.env, ALERT_POLICY_TEST: mode },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    assert.equal(r.status, 0, r.error?.message);
  }
