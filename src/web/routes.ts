// 03 R14：正式网页渠道。每次读写的会话都只由账号与 HttpOnly cookie 推导。
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { subscribeWeb, webConversationId, type WebEvent } from '../adapters/web.js';
import { accountByKey, type ChannelAccount } from '../channels/accounts.js';
import { handleMessage, inboundText, trimSessionMessages } from '../engine.js';
import { numEnv } from '../env.js';
import { applyConsentDecision, CONSENT_DECLINED_REPLY, consentMenuButtonId, parseConsentMenuId } from '../handoff/consent.js';
import { enterHandoff } from '../handoff/record.js';
import { clientKey, lookupLimit, makeLimiter } from '../http-guards.js';
import { log } from '../log.js';
import { alert } from '../ops/alert.js';
import { currentPrivacyNotice } from '../privacy/privacy.js';
import { profile } from '../profile.js';
import type { WebMessage } from '../shared/channel-types.js';
import { withAdvisorPrefix } from '../shared/conversation.js';
import { getOrCreateSession, getSession, onShutdown, recentMsgids, saveSession } from '../store.js';
import { onTurnEnd } from '../trace/recorder.js';
import type { Session } from '../types.js';

const COOKIE = '__Host-wv';
const MAX_AGE = 30 * 24 * 60 * 60;
const IDLE_MS = 30 * 60_000;
const PING_MS = 15_000;
const TURN_LIMIT_REPLY = '现在咨询的人有点多，顾问会在这里回复您';
const cid = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .optional();
const bodySchema = z.union([
  z.object({ text: z.string().trim().min(1).max(1000), cid }).strict(),
  z.object({ menu: z.string().max(64), cid }).strict(),
]);
// 状态随 conversations.state 落库：即使顾问交还、重启或消息窗口推进，也不重复触发预算转人工。
type WebSession = Session & { webTurnLimited?: true };
const processing = new Set<string>();
const streams = new Set<{ tick: (now: number) => void; close: () => void }>();
const messageLimited = makeLimiter(Math.max(1, numEnv('WEB_RATE_PER_MIN', 20)));
const newIpHits = new Map<string, number[]>();
type Daily = { day: string; newConversations: number; turns: number; alerted: boolean };
const dailyCounts = new Map<string, Daily>();

function daily(account: ChannelAccount): Daily {
  // 自然日用服务器时区，与定时清理、告警的日期口径相同。
  const d = new Date();
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  let counter = dailyCounts.get(account.id);
  if (!counter || counter.day !== day) {
    counter = { day, newConversations: 0, turns: 0, alerted: false };
    dailyCounts.set(account.id, counter);
  }
  return counter;
}

function visitorToken(c: Context): string | null {
  const values = (c.req.header('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0]!.slice(COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return Buffer.from(token, 'base64url').toString('base64url') === token ? token : null;
}

function setVisitorCookie(c: Context, token: string, age = MAX_AGE): void {
  c.header('set-cookie', `${COOKIE}=${token}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function ownSession(account: ChannelAccount, token: string | null): WebSession | undefined {
  if (!token) return undefined;
  const s = getSession(webConversationId(account.id, token));
  return s?.channel === 'web' && s.channelAccountId === account.id ? s : undefined;
}

/** 查询不增计数；只有真正创建时才占位，且在下一次 await 之前完成所有限额与会话创建。 */
function reserveNew(account: ChannelAccount, ip: string): boolean {
  const now = Date.now();
  for (const [k, hits] of newIpHits) if (!hits.some((t) => now - t < 3_600_000)) newIpHits.delete(k);
  const key = newIpHits.has(ip) || newIpHits.size < 10_000 ? ip : '__overflow__';
  const hits = (newIpHits.get(key) ?? []).filter((t) => now - t < 3_600_000);
  const count = daily(account);
  if (hits.length >= Math.max(1, numEnv('WEB_NEW_PER_IP_HOUR', 10)) || count.newConversations >= account.web!.dailyNewConversations) {
    return false;
  }
  hits.push(now);
  newIpHits.set(key, hits);
  count.newConversations++;
  return true;
}

function limitedReply(s: WebSession, text: string, msgid: string | undefined, recorded: boolean): { text: string } {
  if (!recorded) s.messages.push({ role: 'customer', content: inboundText(text), at: Date.now(), ...(msgid ? { msgid } : {}) });
  if (!s.webTurnLimited) {
    s.webTurnLimited = true;
    enterHandoff(s, { kind: 'request', reason: '网页咨询轮次达到每日上限', at: Date.now() });
  }
  s.messages.push({ role: 'agent', content: TURN_LIMIT_REPLY, at: Date.now() });
  trimSessionMessages(s);
  saveSession(s);
  return { text: TURN_LIMIT_REPLY };
}

export const webRoutes = new Hono();
// 所有网页响应（含错误与事件流）不缓存；开关与账号检查先于限流和 body 解析。
const webOnly = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  if (!profile().flags.web_channel || !accountByKey(c.req.param('key') ?? '', 'web')) return c.notFound();
  return next();
};
webRoutes.use('/w/:key', webOnly);
webRoutes.use('/api/web/:key/*', webOnly);
webRoutes.get('/w/:key', (c) => c.text('网页咨询页面准备中'));

webRoutes.post('/api/web/:key/messages', async (c) => {
  if (c.req.header('x-web-chat') !== '1') return c.json({ error: 'forbidden' }, 403);
  const ip = clientKey(c);
  if (messageLimited(ip)) return c.json({ error: 'rate_limited' }, 429);
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_message' }, 400);
  const body = parsed.data;
  const account = accountByKey(c.req.param('key'), 'web')!;
  let token = visitorToken(c);
  let s = ownSession(account, token);
  // 点击必须属于已问过的同意菜单，不凭匿名点击创建会话或捏造同意。
  if ('menu' in body) {
    const menu = parseConsentMenuId(body.menu);
    const notice = currentPrivacyNotice();
    if (!s || !notice || !menu || body.menu !== consentMenuButtonId(menu.category, menu.decision) || !s.consent?.[menu.category]) {
      return c.json({ error: 'invalid_menu' }, 400);
    }
    if (processing.has(s.id)) return c.json({ error: 'in_progress' }, 409);
    setVisitorCookie(c, token!);
    const changed = applyConsentDecision(s, menu.category, menu.decision, body.menu, notice.version);
    if (changed && menu.decision === 'declined') s.messages.push({ role: 'agent', content: CONSENT_DECLINED_REPLY, at: Date.now() });
    if (changed) saveSession(s);
    return c.json({ reply: null });
  }
  if (!s) {
    if (!reserveNew(account, ip)) return c.json({ error: 'new_conversation_limit' }, 429);
    // 格式正确但没有所属会话的 cookie 也不能当作服务端签发过的凭据。
    token = randomBytes(32).toString('base64url');
    s = getOrCreateSession(webConversationId(account.id, token), 'web');
    s.channelAccountId = account.id;
    saveSession(s);
  }
  if (processing.has(s.id)) return c.json({ error: 'in_progress' }, 409);
  setVisitorCookie(c, token!);
  const at = body.cid ? s.messages.findIndex((m) => m.role === 'customer' && m.msgid === body.cid) : -1;
  if (at >= 0) {
    // 不越过下一条客户消息，避免把另一个轮次的回复误配给崩溃留下的消息。
    for (const m of s.messages.slice(at + 1)) {
      if (m.role === 'customer') break;
      if (m.role === 'agent' && (!m.author || m.author === 'ai')) return c.json({ reply: { text: m.content } });
    }
    if (s.handedOver && !s.webTurnLimited) return c.json({ reply: null });
  } else if (body.cid && recentMsgids(s.id).has(body.cid)) return c.json({ reply: null });
  processing.add(s.id);
  let reservation: Daily | null = null;
  let usedModel = false;
  const unsubscribeTurn = onTurnEnd(({ turn }) => {
    if (turn.conversationId === s.id && turn.llm.length > 0) usedModel = true;
  });
  try {
    const count = daily(account);
    if (count.turns >= account.web!.dailyTurns && (!s.handedOver || s.webTurnLimited)) {
      if (!count.alerted) {
        count.alerted = true;
        // 已按账号、自然日合并；不被 channel 全局的 30 分钟去重吞掉另一个账号。
        alert('channel', `网页账号 ${account.key} 达到每日咨询轮次上限`, { escalate: true });
      }
      return c.json({ reply: limitedReply(s, body.text, body.cid, at >= 0) });
    }
    // 开始前同步预留，挡并发超支；trace 在成功与异常出口都通知，只给真正调过模型的轮次计数。
    if (!s.handedOver) {
      count.turns++;
      reservation = count;
    }
    const reply = await handleMessage(s.id, at >= 0 ? s.messages[at]!.content : body.text, 'web', {
      ...(body.cid ? { msgid: body.cid } : {}),
      ...(at >= 0 ? { alreadyRecorded: true } : {}),
    });
    return c.json({ reply: s.handedOver || !reply.text ? null : { text: reply.text } });
  } catch {
    // 不序列化异常（上游异常可能含输入），客户端重试同 cid 可从已记录状态恢复。
    log.error('网页咨询处理失败');
    return c.json({ error: 'temporarily_unavailable' }, 503);
  } finally {
    unsubscribeTurn();
    if (reservation && !usedModel) reservation.turns--;
    processing.delete(s.id);
  }
});

webRoutes.get('/api/web/:key/history', lookupLimit, (c) => {
  const account = accountByKey(c.req.param('key'), 'web')!;
  const s = ownSession(account, visitorToken(c));
  const messages: WebMessage[] = (s?.messages ?? []).flatMap((m) =>
    m.role === 'system' ? [] : [{ role: m.role, text: m.author === 'human' ? withAdvisorPrefix(m.content) : m.content, at: m.at }],
  );
  return c.json({ messages });
});

webRoutes.get('/api/web/:key/events', lookupLimit, (c) => {
  // Hono 将 HEAD 分派给 GET 后只移除正文，不取消事件流；在创建订阅前拒绝。
  if (c.req.raw.method === 'HEAD') {
    c.header('Allow', 'GET');
    return c.body(null, 405);
  }
  const account = accountByKey(c.req.param('key'), 'web')!;
  const s = ownSession(account, visitorToken(c));
  if (!s) return c.json({ error: 'unauthorized' }, 401);
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let timer: NodeJS.Timeout | undefined;
  let lastActivity = Date.now();
  let closed = false;
  let cancelSubscription = (): void => {};
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    cancelSubscription();
    streams.delete(connection);
    c.req.raw.signal.removeEventListener('abort', close);
    try {
      controller.close();
    } catch {
      // ReadableStream.cancel 已先关闭控制器；订阅与定时器仍须释放。
    }
  };
  const send = (event: string, data: unknown): void => {
    if (closed) throw new Error('closed');
    // 客户不读时关闭连接，防止慢连接无限积压正文与心跳。
    if ((controller.desiredSize ?? 0) <= 0) {
      close();
      throw new Error('slow_consumer');
    }
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  const unsubscribe = subscribeWeb(s.id, clientKey(c), (ev: WebEvent) => {
    lastActivity = Date.now();
    const { type, ...data } = ev;
    send(type, data);
  });
  if (unsubscribe === 'too_many') return c.json({ error: 'too_many' }, 429);
  cancelSubscription = unsubscribe;
  const connection = {
    close,
    tick(now: number): void {
      if (now - lastActivity >= IDLE_MS) close();
      else {
        try {
          send('ping', now);
        } catch {
          close();
        }
      }
    },
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        controller = ctrl;
        streams.add(connection);
        c.req.raw.signal.addEventListener('abort', close, { once: true });
        if (c.req.raw.signal.aborted) {
          close();
          return;
        }
        send('ping', Date.now());
        timer = setInterval(() => connection.tick(Date.now()), PING_MS);
        timer.unref();
      },
      cancel: close,
    },
    { highWaterMark: 16 },
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    },
  });
});

webRoutes.post('/api/web/:key/end', (c) => {
  if (c.req.header('x-web-chat') !== '1') return c.json({ error: 'forbidden' }, 403);
  setVisitorCookie(c, '', 0);
  return c.json({ ok: true });
});
onShutdown(() => {
  for (const stream of streams) stream.close();
});

/** 自测手动触发生产用的心跳巡检，不缩短生产超时。 */
export const __webTest = {
  tickStreams: (now: number): void => {
    for (const stream of streams) stream.tick(now);
  },
};
