// 11 R4 / R12：合成地址、注入 DNS；真实连接只到回环，不访问公网。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { createEgress, EgressError, normalizeBaseUrl, type EgressCode, type EgressRequest, type Resolver } from './egress.js';

let count = 0;
function pass(name: string) {
  count++;
  console.log(`egress: ✔ ${name}`);
}
const request = (overrides: Partial<EgressRequest> = {}): EgressRequest => ({
  path: '/ok',
  headers: { 'content-type': 'application/json' },
  body: '{"ids":[1]}',
  deadline: Date.now() + 2000,
  maxBytes: 1024,
  ...overrides,
});
const records = (v4: string[] = [], v6: string[] = []): Resolver => ({ resolve4: async () => v4, resolve6: async () => v6 });
function cleanError(error: unknown, code: EgressCode, forbidden: string[] = []) {
  assert.ok(error instanceof EgressError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const printed = inspect(error, { showHidden: true, depth: null }) + JSON.stringify(error, Object.getOwnPropertyNames(error));
  for (const value of forbidden) assert.ok(!printed.includes(value), printed);
  return true;
}
async function fails(action: () => unknown, code: EgressCode, forbidden: string[] = []) {
  await assert.rejects(
    async () => action(),
    (error) => cleanError(error, code, forbidden),
  );
}

// 每个 IPv4 特殊用途段的首尾与紧邻范围；相邻段也是禁区时另列。
const v4Ranges = [
  ['0.0.0.0', '0.255.255.255', '1.0.0.0'],
  ['10.0.0.0', '10.255.255.255', '9.255.255.255', '11.0.0.0'],
  ['100.64.0.0', '100.127.255.255', '100.63.255.255', '100.128.0.0'],
  ['127.0.0.0', '127.255.255.255', '126.255.255.255', '128.0.0.0'],
  ['169.254.0.0', '169.254.255.255', '169.253.255.255', '169.255.0.0'],
  ['172.16.0.0', '172.31.255.255', '172.15.255.255', '172.32.0.0'],
  ['192.0.0.0', '192.0.0.255', '191.255.255.255', '192.0.1.0'],
  ['192.0.2.0', '192.0.2.255', '192.0.1.255', '192.0.3.0'],
  ['192.88.99.0', '192.88.99.255', '192.88.98.255', '192.88.100.0'],
  ['192.168.0.0', '192.168.255.255', '192.167.255.255', '192.169.0.0'],
  ['198.18.0.0', '198.19.255.255', '198.17.255.255', '198.20.0.0'],
  ['198.51.100.0', '198.51.100.255', '198.51.99.255', '198.51.101.0'],
  ['203.0.113.0', '203.0.113.255', '203.0.112.255', '203.0.114.0'],
  ['224.0.0.0', '239.255.255.255', '223.255.255.255'],
  ['240.0.0.0', '255.255.255.255'],
];
const blocked = [
  ...v4Ranges.flatMap(([first, last]) => [first, last]),
  '127.0.0.1',
  '2130706433',
  '0x7f.1',
  '0177.0.0.1',
  '10.1.2.3',
  '169.254.169.254',
  '100.100.100.200',
  '[::]',
  '[::1]',
  '[::ffff:a00:1]',
  '[::ffff:8.8.8.8]',
  '[64:ff9b::a00:1]',
  '[64:ff9b:1::1]',
  '[fc00::1]',
  '[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[fe80::1]',
  '[fec0::1]',
  '[ff02::1]',
  '[1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[4000::]',
  '[2001::]',
  '[2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[2001:0:1234::1]',
  '[2001:db8::]',
  '[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[2002::]',
  '[2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[3fff::]',
  '[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]',
];
let dnsCalls = 0;
const neverDns: Resolver = {
  resolve4: async () => {
    dnsCalls++;
    return [];
  },
  resolve6: async () => {
    dnsCalls++;
    return [];
  },
};
for (const address of blocked) {
  const base = `https://${address}`;
  assert.deepEqual(normalizeBaseUrl(base), { ok: false, code: 'blocked_address' }, address);
  await fails(() => createEgress(base, { resolver: neverDns })(request()), 'blocked_address', [address]);
}
assert.equal(dnsCalls, 0, 'IP 字面量在任何 DNS 或连接之前被拒');
pass(`IPv4/IPv6 禁区逐段首尾、特殊字面量（${blocked.length} 个），运行时复检与错误脱敏`);

const publicIps = [
  ...v4Ranges.flatMap(([, , ...neighbors]) => neighbors),
  '[2000::]',
  '[2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[2001:200::]',
  '[2001:db7:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[2001:db9::]',
  '[2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[2003::]',
  '[3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  '[3fff:1000::]',
  '[3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
];
for (const address of publicIps) assert.deepEqual(normalizeBaseUrl(`https://${address}/`), { ok: true, url: `https://${address}` });
pass(`IPv4/IPv6 放行段与禁区紧邻正例（${publicIps.length} 个，仅验证不连接）`);

for (const [base, code] of [
  ['http://erp.example.test', 'scheme'],
  ['ftp://erp.example.test', 'scheme'],
  ['https://user:pass@erp.example.test', 'userinfo'],
  ['https://erp.example.test:22', 'port'],
  ['https://erp.example.test:80', 'port'],
  ['https://localhost', 'host'],
  ['https://foo.localhost', 'host'],
  ['https://localhost.', 'host'],
  ['https://FOO.localhost.', 'host'],
  ['https://erp.example.test/?', 'host'],
  ['https://erp.example.test/#', 'host'],
  ['https://erp.example.test/?q=1', 'host'],
  ['https://erp.example.test/#part', 'host'],
  ['bad address', 'host'],
] as const) {
  assert.deepEqual(normalizeBaseUrl(base), { ok: false, code });
  await fails(() => createEgress(base)(request()), code, ['erp.example.test']);
}
assert.deepEqual(normalizeBaseUrl('HTTPS://ERP.EXAMPLE.TEST:443/odoo///'), { ok: true, url: 'https://erp.example.test/odoo' });
for (const port of [443, 8443, 8069]) assert.equal(normalizeBaseUrl(`https://erp.example.test:${port}`).ok, true);
for (const host of ['localhost', 'foo.localhost', 'localhost.', 'foo.localhost.']) {
  await fails(() => createEgress(`http://${host}:12345`, { allowLoopback: true })(request()), 'host');
}
await fails(() => createEgress('http://8.8.8.8', { allowLoopback: true })(request()), 'blocked_address');
await fails(() => createEgress('https://10.1.2.3', { allowLoopback: true })(request()), 'blocked_address');
await fails(() => createEgress('https://8.8.8.8:22', { allowLoopback: true })(request()), 'port');
for (const address of ['127.0.0.0', '127.255.255.255', '[::1]']) {
  for (const protocol of ['http', 'https']) {
    assert.doesNotThrow(() => createEgress(`${protocol}://${address}:12345`, { allowLoopback: true, resolver: neverDns }));
  }
}
await fails(
  () => createEgress('http://erp.example.test', { allowLoopback: true, resolver: records(['8.8.8.8']) })(request()),
  'blocked_address',
);
await fails(() => createEgress('https://erp.example.test:22', { allowLoopback: true, resolver: records(['8.8.8.8']) })(request()), 'port');
pass('URL 形状、协议、凭据、端口、末尾点 localhost、严格 normalize 与回环例外');

for (const resolver of [
  records(['8.8.8.8', '10.0.0.1']),
  records(['10.0.0.1']),
  records(['8.8.8.8'], ['::1']),
  records([], ['64:ff9b::a00:1']),
]) {
  await fails(() => createEgress('https://erp.example.test', { resolver })(request()), 'blocked_address', [
    'erp.example.test',
    '10.0.0.1',
    '::1',
  ]);
}
for (const code of ['ENODATA', 'ENOTFOUND']) {
  const missing = async (): Promise<string[]> => {
    throw Object.assign(new Error('erp.example.test'), { code });
  };
  await fails(() => createEgress('https://erp.example.test', { resolver: { resolve4: missing, resolve6: missing } })(request()), 'dns', [
    'erp.example.test',
  ]);
}
for (const family of [4, 6]) {
  const broken = async (): Promise<string[]> => {
    throw new Error('erp.example.test 10.1.2.3');
  };
  await fails(
    () =>
      createEgress('https://erp.example.test', {
        resolver: {
          resolve4: family === 4 ? broken : async () => ['8.8.8.8'],
          resolve6: family === 6 ? broken : async () => ['2003::1'],
        },
      })(request()),
    'dns',
    ['erp.example.test', '10.1.2.3'],
  );
}
for (const resolver of [records(), records(['not-an-ip']), records([], ['8.8.8.8'])]) {
  await fails(() => createEgress('https://erp.example.test', { resolver })(request()), 'dns', ['erp.example.test']);
}
const hanging = (): Promise<string[]> => new Promise(() => {});
for (const family of [4, 6]) {
  await fails(
    () =>
      createEgress('https://erp.example.test', {
        resolver: {
          resolve4: family === 4 ? hanging : async () => ['8.8.8.8'],
          resolve6: family === 6 ? hanging : async () => ['2003::1'],
        },
      })(request()),
    'dns',
    ['erp.example.test'],
  );
}
await fails(
  () =>
    createEgress('https://erp.example.test', { resolver: { resolve4: hanging, resolve6: hanging } })(
      request({ deadline: Date.now() + 30 }),
    ),
  'timeout',
);
pass('DNS 两族完整检查、混合公私拒绝、空记录、任一族异常/超时、解析阶段总截止时间');

// 截在连接边界，核实 lookup 的两种 Node 回调形状与转交的全部地址，绝不连公网。
const originalHttpsRequest = https.request;
try {
  let all = true;
  let family = 0;
  let used: unknown;
  https.request = ((options: https.RequestOptions, onResponse: (res: http.IncomingMessage) => void) => {
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.ok(options.agent instanceof https.Agent);
    assert.equal(options.agent.maxSockets, 1);
    const outgoing = new EventEmitter() as http.ClientRequest;
    outgoing.destroy = () => outgoing;
    outgoing.end = (() => {
      options.lookup!('erp.example.test', { all, family }, (_error, address, foundFamily) => {
        if (_error) {
          outgoing.emit('error', _error);
          return;
        }
        used = all ? address : { address, family: foundFamily };
        const incoming = new EventEmitter() as http.IncomingMessage;
        incoming.statusCode = 200;
        incoming.headers = {};
        onResponse(incoming);
        queueMicrotask(() => incoming.emit('end'));
      });
      return outgoing;
    }) as typeof outgoing.end;
    return outgoing;
  }) as typeof https.request;
  for (all of [true, false]) {
    for (family of [0, 4, 6]) {
      await createEgress('https://erp.example.test', { resolver: records(['8.8.8.8'], ['2003::1']) })(request());
      assert.deepEqual(
        used,
        all
          ? [
              { address: '8.8.8.8', family: 4 },
              { address: '2003::1', family: 6 },
            ]
          : family === 6
            ? { address: '2003::1', family: 6 }
            : { address: '8.8.8.8', family: 4 },
      );
    }
  }
  all = true;
  family = 0;
  let publicThenPrivateCalls = 0;
  const publicThenPrivate = createEgress('https://erp.example.test', {
    resolver: {
      resolve4: async () => (++publicThenPrivateCalls === 1 ? ['8.8.8.8'] : ['10.0.0.1']),
      resolve6: async () => [],
    },
  });
  await publicThenPrivate(request());
  await fails(() => publicThenPrivate(request()), 'blocked_address', ['erp.example.test', '10.0.0.1']);
  assert.equal(publicThenPrivateCalls, 2, '严格模式下第一次公网、第二次私网的解析被拒，校验边界不连公网');
  for (const missingFamily of [4, 6]) {
    for (const code of ['ENODATA', 'ENOTFOUND']) {
      const missing = async (): Promise<string[]> => {
        throw Object.assign(new Error(), { code });
      };
      await createEgress('https://erp.example.test', {
        resolver: {
          resolve4: missingFamily === 4 ? missing : async () => ['8.8.8.8'],
          resolve6: missingFamily === 6 ? missing : async () => ['2003::1'],
        },
      })(request());
    }
  }
} finally {
  https.request = originalHttpsRequest;
}
pass('lookup all:true / 单地址形状与 family，只有校验后的地址交给连接，单族缺记录可用');

const sockets = new Set<net.Socket>();
const timers = new Set<ReturnType<typeof setTimeout>>();
const paths: string[] = [];
let connections = 0;
let release: (() => void) | undefined;
let heldStarted: (() => void) | undefined;
let stale: net.Socket | undefined;
const server = http.createServer((req, res) => {
  paths.push(req.url!);
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'http://10.0.0.1/private' });
    res.end();
  } else if (req.url === '/length') {
    res.writeHead(200, { 'content-length': '999999' });
    res.flushHeaders();
  } else if (req.url === '/chunks') {
    res.writeHead(200);
    res.write(Buffer.alloc(8));
    res.end(Buffer.alloc(8));
  } else if (req.url === '/hang') {
    res.writeHead(200);
    res.flushHeaders();
  } else if (req.url === '/hold') {
    release = () => res.end('released');
    heldStarted?.();
  } else if (req.url === '/reset') req.socket.destroy(new Error('erp.example.test'));
  else if (req.url === '/short') {
    res.writeHead(200, { 'content-length': 99, connection: 'close' });
    res.end('short');
  } else if (req.url === '/empty') res.end();
  else if (req.url === '/hint') {
    res.setHeader('keep-alive', 'timeout=5');
    res.end('ok');
  } else if (req.url === '/stale') {
    stale = req.socket;
    res.end('ok');
  } else if (req.url === '/slow') {
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.end('late');
    }, 150);
    timers.add(timer);
  } else {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/json');
      assert.equal(body, '{"ids":[1]}');
      res.setHeader('content-type', 'Application/JSON; charset=utf-8');
      res.end('测试');
    });
  }
});
// 不发默认的 Keep-Alive 提示；30 秒与更短的提示分开验。
server.keepAliveTimeout = 0;
server.on('connection', (socket) => {
  connections++;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as net.AddressInfo).port;
const proxyBefore = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
try {
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  const base = `http://127.0.0.1:${port}`;
  const send = createEgress(base, { allowLoopback: true, resolver: neverDns });
  const result = await send(request());
  assert.equal(result.status, 200);
  assert.equal(result.mediaType, 'application/json');
  assert.equal(result.body.toString(), '测试');
  const firstConnections = connections;
  await send(request());
  assert.equal(connections, firstConnections);
  assert.equal((await send(request({ path: '/empty' }))).mediaType, null);
  assert.equal(dnsCalls, 0, '回环字面量不调用 lookup');
  await createEgress(`${base}/odoo///`, { allowLoopback: true, resolver: neverDns })(request());
  assert.equal(paths.at(-1), '/odoo/ok');
  pass('POST 头/体、路径拼接、媒体类型、缺省 null、直连不读代理变量、保活复用');

  // 实际 Node autoSelectFamily:true 与 false 都连到注入的回环地址。
  const autoBefore = net.getDefaultAutoSelectFamily();
  try {
    for (const auto of [true, false]) {
      net.setDefaultAutoSelectFamily(auto);
      let resolves = 0;
      const rebinding: Resolver = {
        resolve4: async () => {
          resolves++;
          return resolves === 1 ? ['127.0.0.1'] : ['10.0.0.1'];
        },
        resolve6: async () => [],
      };
      const sendByName = createEgress(`http://erp.example.test:${port}`, { allowLoopback: true, resolver: rebinding });
      await sendByName(request());
      await sendByName(request());
      assert.equal(resolves, 1, '保活连接不重复解析');
      await fails(() => sendByName(request({ path: '/reset' })), 'network');
      await fails(() => sendByName(request()), 'blocked_address', ['erp.example.test', '10.0.0.1']);
      assert.equal(resolves, 2, '新连接重查 DNS，重绑定私网被拒');
    }
  } finally {
    net.setDefaultAutoSelectFamily(autoBefore);
  }
  pass('实际 Node 两种 lookup 形状、校验地址固定、保活后新建连接防 DNS rebinding');

  const originalHttpRequest = http.request;
  let capturedAgent: http.Agent | undefined;
  let idleResolves = 0;
  const idleSend = createEgress(`http://erp.example.test:${port}`, {
    allowLoopback: true,
    resolver: {
      resolve4: async () => {
        idleResolves++;
        return ['127.0.0.1'];
      },
      resolve6: async () => [],
    },
  });
  try {
    http.request = ((options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
      assert.ok(options.agent instanceof http.Agent);
      capturedAgent = options.agent;
      return originalHttpRequest(options, callback);
    }) as typeof http.request;
    await idleSend(request());
  } finally {
    http.request = originalHttpRequest;
  }
  assert.ok(capturedAgent);
  const idleSocket = Object.values(capturedAgent.freeSockets).flat()[0]!;
  assert.equal(idleSocket.timeout, 30_000);
  // 触发已注册的空闲计时事件，不为每轮自测真的等待 30 秒。
  const idleClosed = once(idleSocket, 'close');
  idleSocket.emit('timeout');
  await idleClosed;
  assert.equal(idleSocket.destroyed, true);
  await idleSend(request());
  assert.equal(idleResolves, 2, '空闲关闭之后新连接重新校验');
  await idleSend(request({ path: '/hint' }));
  assert.equal(Object.values(capturedAgent.freeSockets).flat()[0]!.timeout, 4_000, '服务端 Keep-Alive 提示更短时不被 30 秒盖掉');
  pass('空闲 socket 设 30 秒计时、到期销毁、下次连接重新校验、服从服务端更短的保活提示');

  const beforeRedirect = paths.length;
  await fails(() => send(request({ path: '/redirect' })), 'redirect', ['10.0.0.1']);
  assert.equal(paths.length, beforeRedirect + 1);
  await fails(() => send(request({ path: '/length', maxBytes: 8 })), 'too_large');
  await fails(() => send(request({ path: '/chunks', maxBytes: 15 })), 'too_large');
  assert.equal((await send(request({ maxBytes: Buffer.byteLength('测试') }))).body.toString(), '测试');
  await fails(() => send(request({ maxBytes: 5 })), 'too_large');
  await fails(() => send(request({ path: '/hang', deadline: Date.now() + 40 })), 'timeout');
  await fails(() => send(request({ path: '/slow', deadline: Date.now() + 40 })), 'timeout');
  await fails(() => send(request({ path: '/short', deadline: Date.now() + 100 })), 'network');
  await fails(() => send(request({ path: '/reset' })), 'network', ['127.0.0.1', 'erp.example.test']);
  await send(request());
  pass('302 不跟随、Content-Length 与流式字节上限、连接/读取截止、网络中断脱敏与恢复');

  const expiredBefore = paths.length;
  await fails(() => send(request({ deadline: Date.now() - 1 })), 'timeout');
  assert.equal(paths.length, expiredBefore);
  const started = new Promise<void>((resolve) => {
    heldStarted = resolve;
  });
  const held = send(request({ path: '/hold' }));
  await started;
  const queuedBefore = paths.length;
  await fails(() => send(request({ deadline: Date.now() + 40 })), 'timeout');
  assert.equal(paths.length, queuedBefore, '排队过期不发请求');
  release!();
  await held;
  await send(request());
  const interrupted = send(request({ path: '/hang', deadline: Date.now() + 40 }));
  const next = send(request());
  await fails(() => interrupted, 'timeout');
  await next;
  pass('已过期零请求、maxSockets:1 排队计入截止、销毁当前请求后下一请求可用');

  const lateBefore = paths.length;
  const lateSend = createEgress(`http://erp.example.test:${port}`, {
    allowLoopback: true,
    resolver: {
      resolve4: () => new Promise((resolve) => setTimeout(() => resolve(['127.0.0.1']), 60)),
      resolve6: async () => [],
    },
  });
  await fails(() => lateSend(request({ deadline: Date.now() + 20 })), 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(paths.length, lateBefore, '过期后晚到的 DNS 答复不能继续连接');
  await lateSend(request());
  pass('晚到的 DNS 答复不会在截止后发请求，后续请求仍可建立连接');

  const staleSend = createEgress(base, { allowLoopback: true, resolver: neverDns });
  await staleSend(request({ path: '/stale' }));
  assert.ok(stale);
  // 让保活连接的对端在下一请求到达时关闭，失败不得自动重发。
  stale.once('data', () => stale?.destroy());
  const beforeFailure = paths.length;
  await fails(() => staleSend(request({ path: '/hang' })), 'network');
  assert.equal(paths.length, beforeFailure + 1);
  await staleSend(request());
  pass('保活对端关闭归 network，单次失败不自动重试，后续请求可恢复');
} finally {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY'] as const) {
    if (proxyBefore[key] === undefined) delete process.env[key];
    else process.env[key] = proxyBefore[key];
  }
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// 自签证书只在运行时生成，私钥不进仓库。真实 HTTPS 必须校验证书。
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-tls-'));
let tlsServer: https.Server | undefined;
const tlsSockets = new Set<import('node:stream').Duplex>();
let tlsConnections = 0;
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=erp.example.test',
      '-keyout',
      path.join(certDir, 'key.pem'),
      '-out',
      path.join(certDir, 'cert.pem'),
    ],
    { stdio: 'ignore', timeout: 15_000 },
  );
  tlsServer = https.createServer(
    { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) },
    (_req, res) => res.end('unexpected'),
  );
  tlsServer.on('connection', (socket) => {
    tlsConnections++;
    tlsSockets.add(socket);
    socket.on('close', () => tlsSockets.delete(socket));
  });
  tlsServer.listen(0, '127.0.0.1');
  await once(tlsServer, 'listening');
  const tlsPort = (tlsServer.address() as net.AddressInfo).port;
  const tlsBase = `https://127.0.0.1:${tlsPort}`;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  await fails(() => createEgress(tlsBase, { allowLoopback: true, resolver: neverDns })(request()), 'network', [
    '127.0.0.1',
    'erp.example.test',
  ]);
  assert.equal(tlsConnections, 1, '请求直连 HTTPS 服务而不是代理');
  pass('HTTPS 自签证书归 network、不可关闭证书校验，显式 Agent 绕过代理');
} finally {
  if (proxyBefore.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = proxyBefore.HTTPS_PROXY;
  for (const socket of tlsSockets) socket.destroy();
  if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()));
  fs.rmSync(certDir, { recursive: true, force: true });
}

const handshakeSockets = new Set<net.Socket>();
const handshakeServer = net.createServer((socket) => {
  handshakeSockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => handshakeSockets.delete(socket));
});
try {
  handshakeServer.listen(0, '127.0.0.1');
  await once(handshakeServer, 'listening');
  const handshakePort = (handshakeServer.address() as net.AddressInfo).port;
  await fails(
    () =>
      createEgress(`https://127.0.0.1:${handshakePort}`, { allowLoopback: true, resolver: neverDns })(
        request({ deadline: Date.now() + 40 }),
      ),
    'timeout',
  );
  pass('截止时刻覆盖 TLS 握手挂起，超时销毁连接');
} finally {
  for (const socket of handshakeSockets) socket.destroy();
  await new Promise<void>((resolve) => handshakeServer.close(() => resolve()));
}

console.log(`EGRESS SELFTEST PASS: ${count} 组安全边界与真实回环连接测试`);
