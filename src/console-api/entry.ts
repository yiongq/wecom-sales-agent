// 05 R23：宿主只在这里读取体验入口的 Host；无效配置不开放跳转。
import { profile } from '../profile.js';

export function sandboxTryUrl(): string | null {
  if (profile().name !== 'demo') return null;
  const host = process.env.SANDBOX_HOST?.trim();
  if (!host) return null;
  try {
    const url = new URL(`https://${host}/try`);
    // 只接收主机名，不接受协议、端口、凭据、路径、查询或片段。
    if (url.host !== host.toLowerCase() || url.username || url.password || url.pathname !== '/try' || url.search || url.hash) return null;
    if (
      !/^\[[\da-f:]+\]$/i.test(host) &&
      !host
        .replace(/\.$/, '')
        .split('.')
        .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
