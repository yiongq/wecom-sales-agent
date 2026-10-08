// 压测用的假企微接口 + 假模型：覆盖 globalThis.fetch，不连真实网络、不调真实模型
// （照 src/adapters/wecom.selftest.ts 的写法：按路径分发、cursor 式的 sync_msg 队列）。
// 模型侧额外做了压测需要的两件事：每次成功应答前按 2–8 秒均匀分布延迟，以及一段可控的「429 风暴」窗口。

export interface FakeMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text?: { content: string };
}

export interface Sent {
  to: string;
  content: string;
  at: number;
}

export interface LlmStats {
  chatCalls: number;
  chat429: number;
  chatOk: number;
  embedCalls: number;
}

export interface FakeUpstream {
  /** 把一条客户文本消息放进「服务端日志」，下一次 callSync 才会被企微适配器拉到 */
  pushCustomerMessage(uid: string, content: string): void;
  /** 全部已成功送达客户的消息（send_msg / send_msg_on_event），按到达顺序 */
  allSent(): Sent[];
  sentTo(uid: string): Sent[];
  /** 开始一次 60 秒的 429 风暴：此后 30% 的 chat/completions 请求直接拒绝；60 秒后自动结束 */
  startStorm(ms?: number): void;
  isStormActive(): boolean;
  stats(): LlmStats;
}

const delay = (ms: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

const bodyOf = (init?: RequestInit): Record<string, unknown> => {
  const raw = init?.body;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

// 装上假 fetch。llmHost 是选定的假模型主机名（环境变量 LLM_BASE_URL、EMBED_BASE_URL 都指向它，不解析真实 DNS，
// 全部请求在到达网络之前就被这个覆盖接住）。调用方负责把企微与模型相关的环境变量设成与这里一致的值。
export function installFakeUpstream(opts: { llmHost: string }): FakeUpstream {
  const serverLog: FakeMsg[] = [];
  let msgSeq = 0;
  const sent: Sent[] = [];
  const stats: LlmStats = { chatCalls: 0, chat429: 0, chatOk: 0, embedCalls: 0 };
  let stormUntil = 0;

  const isStormActive = (): boolean => Date.now() < stormUntil;

  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlStr);
    const signal = (init?.signal ?? (input instanceof Request ? input.signal : null)) as AbortSignal | null;

    // 压测脚本自己拿真实 HTTP 打本机起的 server.ts（console 登录、SSE、接手、人工回复）：这是本机环回，
    // 不是外部服务，原样放给真的 fetch
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);

    if (url.hostname === 'qyapi.weixin.qq.com') {
      const ep = url.pathname.replace(/^\/cgi-bin\//, '');
      if (ep === 'gettoken') return json({ errcode: 0, access_token: 'loadtest-token', expires_in: 7200 });
      if (ep === 'media/upload') return json({ errcode: 40004, errmsg: 'loadtest: 缩略图上传失败' });
      if (ep === 'kf/customer/batchget') return json({ errcode: 0, customer_list: [] });
      const body = bodyOf(init);
      if (ep === 'kf/sync_msg') {
        const from = Number(body.cursor ?? '0') || 0;
        const list = serverLog.slice(from);
        return json({ errcode: 0, next_cursor: String(from + list.length), has_more: 0, msg_list: list });
      }
      if (ep === 'kf/send_msg') {
        const touser = String((body as { touser?: unknown }).touser ?? '');
        const text = (body as { text?: { content?: unknown } }).text;
        sent.push({ to: touser, content: String(text?.content ?? ''), at: Date.now() });
        return json({ errcode: 0 });
      }
      if (ep === 'kf/send_msg_on_event') {
        const text = (body as { text?: { content?: unknown } }).text;
        sent.push({ to: `code:${String((body as { code?: unknown }).code ?? '')}`, content: String(text?.content ?? ''), at: Date.now() });
        return json({ errcode: 0 });
      }
      return json({ errcode: 40001, errmsg: `loadtest: 未模拟的企微接口 ${ep}` });
    }

    if (url.hostname === opts.llmHost) {
      if (url.pathname.endsWith('/embeddings')) {
        stats.embedCalls += 1;
        const body = bodyOf(init);
        const input_ = Array.isArray((body as { input?: unknown }).input) ? ((body as { input: unknown[] }).input as unknown[]) : [];
        return json({
          data: input_.map((_, i) => ({ embedding: [1, i % 3, (i * 7) % 5] })),
          usage: { prompt_tokens: 11 * input_.length + 3, completion_tokens: 0 },
        });
      }
      if (url.pathname.endsWith('/chat/completions')) {
        stats.chatCalls += 1;
        if (isStormActive() && Math.random() < 0.3) {
          await delay(100 + Math.random() * 200, signal);
          stats.chat429 += 1;
          return json({ error: { code: '1302', message: 'loadtest: 429 风暴模拟' } }, 429);
        }
        await delay(2000 + Math.random() * 6000, signal);
        stats.chatOk += 1;
        const n = stats.chatOk;
        return json({
          choices: [
            {
              message: { role: 'assistant', content: `好的，我了解您的需求，稍后为您详细介绍（第 ${n} 次应答）。` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 500 + n, completion_tokens: 30 + (n % 7) },
        });
      }
      return json({ error: { message: `loadtest: 未模拟的模型接口 ${url.pathname}` } }, 404);
    }

    throw new Error(`fake-upstream: 未预期的请求（既不是企微也不是假模型）：${urlStr}`);
  }) as typeof fetch;

  return {
    pushCustomerMessage(uid, content) {
      msgSeq += 1;
      serverLog.push({
        msgid: `loadtest-msg-${msgSeq}`,
        open_kfid: 'loadtest-kf',
        external_userid: uid,
        send_time: Math.floor(Date.now() / 1000),
        origin: 3,
        msgtype: 'text',
        text: { content },
      });
    },
    allSent: () => sent,
    sentTo: (uid) => sent.filter((s) => s.to === uid),
    startStorm(ms = 60_000) {
      stormUntil = Date.now() + ms;
    },
    isStormActive,
    stats: () => ({ ...stats }),
  };
}
