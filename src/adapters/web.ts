// 正式网页渠道：凭据只在 HTTP 层，适配器只认推导出的会话 id。
import { createHash } from 'node:crypto';
import { partsOf, type ChannelCaps, type MessagePart } from '../core/pack-api.js';
import { numEnv } from '../env.js';
import { consentMenuButtonId } from '../handoff/consent.js';
import { withAdvisorPrefix } from '../shared/conversation.js';
import type { ChannelAdapter } from '../types.js';

export type WebEvent =
  | { type: 'push'; text: string; parts: MessagePart[] }
  | { type: 'menu'; text: string; parts: MessagePart[]; buttons: { id: string; label: string }[] };

type Client = { send: (ev: WebEvent) => void; remove: () => void };
const clients = new Map<string, Set<Client>>();
const ips = new Map<string, number>();
let total = 0;

export function webConversationId(accountId: string, token: string): string {
  return `web:${createHash('sha256').update(`${accountId}:${token}`).digest('hex').slice(0, 32)}`;
}

/** 同步占位：响应开始之前就判并发，取消可重复调用。 */
export function subscribeWeb(sessionId: string, clientKey: string, send: (ev: WebEvent) => void): (() => void) | 'too_many' {
  const set = clients.get(sessionId) ?? new Set<Client>();
  if (
    set.size >= 3 ||
    (ips.get(clientKey) ?? 0) >= Math.max(1, numEnv('WEB_SSE_MAX_PER_IP', 10)) ||
    total >= Math.max(1, numEnv('WEB_SSE_MAX_TOTAL', 2000))
  )
    return 'too_many';
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    set.delete(client);
    if (!set.size) clients.delete(sessionId);
    const n = (ips.get(clientKey) ?? 1) - 1;
    if (n) ips.set(clientKey, n);
    else ips.delete(clientKey);
    total--;
  };
  const client = { send, remove };
  set.add(client);
  clients.set(sessionId, set);
  ips.set(clientKey, (ips.get(clientKey) ?? 0) + 1);
  total++;
  return remove;
}

export const webAdapter: ChannelAdapter & { readonly caps: Readonly<ChannelCaps> } = {
  name: 'web',
  caps: Object.freeze({ markdown: false }),
  async push(sessionId, text, opts): Promise<boolean> {
    const set = clients.get(sessionId);
    const menu = opts?.kind === 'menu';
    if (menu && !opts.category) return false;
    const body = opts?.kind === 'human' ? withAdvisorPrefix(text) : text;
    const event: WebEvent = menu
      ? {
          type: 'menu',
          text,
          parts: partsOf(text),
          buttons: [
            { id: consentMenuButtonId(opts!.category!, 'granted'), label: '同意' },
            { id: consentMenuButtonId(opts!.category!, 'declined'), label: '不同意' },
          ],
        }
      : { type: 'push', text: body, parts: partsOf(body) };
    let delivered = false;
    for (const client of set ?? []) {
      try {
        client.send(event);
        delivered = true;
      } catch {
        client.remove();
      }
    }
    // 正文已经在历史里；菜单没有在线接收方时引擎按「再问一次」处理。
    return menu ? delivered : true;
  },
};
