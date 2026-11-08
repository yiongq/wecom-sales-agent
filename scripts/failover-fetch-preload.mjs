// 只在演练子进程中 --import；配置由父进程写临时文件，产品不增加环境变量或可替换的企微地址。
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./failover-fetch.json', import.meta.url), 'utf8'));
const target = new URL(config.origin);
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('drill_preload_requires_loopback');
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol === 'https:' && url.hostname === 'qyapi.weixin.qq.com' && !url.port && url.pathname.startsWith('/cgi-bin/')) {
    const headers = new Headers(request.headers);
    headers.set('x-drill-auth', config.auth);
    headers.set('x-drill-process', config.process);
    // 不转发 query 中的凭据；假服务只认路径和 JSON 请求体。
    return original(new URL(url.pathname, target), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal: request.signal,
      redirect: 'error',
    });
  }
  // 合成演练不得意外调用真实模型、第三方媒体或真实企微。
  throw new Error('drill_unexpected_fetch');
};
