// 在 Docker host 网络中运行，Colima 下即虚拟机网络；不依赖 macOS 的端口自动转发。
import http from 'node:http';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

async function reserve() {
  const servers = [];
  try {
    for (let i = 0; i < 3; i++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    // 同时占住三个端口后才读取并释放，保证互不相同；后续 compose 绑定冲突会直接失败。
    console.log(JSON.stringify(servers.map((server) => server.address().port)));
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

async function request(raw) {
  const input = JSON.parse(raw);
  const url = new URL(input.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    !Number.isInteger(input.timeout) ||
    input.timeout < 1 ||
    input.timeout > 25000 ||
    (input.body !== undefined && typeof input.body !== 'string')
  )
    throw new Error('invalid_request');
  const start = performance.now();
  const result = await new Promise((resolve) => {
    let finished = false;
    let status = 0;
    let timer;
    const finish = (body) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ status, body, waitMs: Math.ceil(performance.now() - start) });
    };
    // 独立连接、只发一次、不跟随重定向；已连接后断开也不能在测量客户端重发 POST。
    const req = http.request(
      url,
      {
        method: input.body === undefined ? 'GET' : 'POST',
        agent: false,
        headers: input.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(input.body) },
      },
      (res) => {
        status = res.statusCode ?? 0;
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy();
            finish(null);
          } else chunks.push(chunk);
        });
        res.once('error', () => finish(null));
        res.once('aborted', () => finish(null));
        res.once('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            /* HTTP 错误可能返回非 JSON。 */
          }
          finish(body);
        });
      },
    );
    req.once('error', () => finish(null));
    timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, input.timeout);
    req.end(input.body);
  });
  console.log(JSON.stringify(result));
}

try {
  switch (process.argv[2]) {
    case 'idle':
      setInterval(() => {}, 60_000);
      break;
    case 'reserve':
      await reserve();
      break;
    case 'request':
      await request(process.argv[3]);
      break;
    default:
      throw new Error('invalid_mode');
  }
} catch {
  console.error('drill_probe_failed');
  process.exitCode = 1;
}
