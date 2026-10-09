// 03 plan 第 19 步「压测」专用的假企微 + 假模型：覆盖 globalThis.fetch，不连真实网络、不调真实模型。
// 与 scripts/load/fake-upstream.ts（02 步骤 25）的区别：按 open_kfid 分开排队/发送记录，支持同一进程里多个
// 企微客服账号（03 的两账号场景）；没有 429 风暴与对冲统计，只管「2–8 秒延迟应答」与「按 open_kfid 记账」。
// 本文件会被压测驱动脚本（channel-run.ts）原样复制到基线 worktree（02 commit）与本 worktree（03），
// 两边跑的是同一份代码——这正是「同一个负载脚本」要求的字面意思。

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
  openKfId: string;
  to: string;
  content: string;
  msgid: string;
  at: number;
}

export interface ChannelFakeUpstream {
  /** 把一条客户文本消息放进这个账号的队列（下一次 sync_msg 才会被拉到）；返回放入的时刻（毫秒） */
  pushCustomerMessage(openKfId: string, uid: string, content: string): number;
  /** 这个账号、这个客户收到的全部送达消息，按到达顺序 */
  sentTo(openKfId: string, uid: string): Sent[];
  /** 全部账号的全部送达消息，按到达顺序（用来查 msgid 是否有重复） */
  allSent(): Sent[];
  stats(): { chatCalls: number };
}

/** 极简的可复现伪随机数生成器（mulberry32），只用来给模型延迟取数，让同一个种子下的「随机」延迟序列可比较复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

/**
 * 装上假 fetch。llmHost 是选定的假模型主机名（LLM_BASE_URL、EMBED_BASE_URL 都指向它）。按 open_kfid 分开排队与
 * 发送记录：sync_msg、send_msg 的请求体里都带 open_kfid（企微真实接口形状，src/adapters/wecom.ts 已经这样发），
 * 不需要靠 access_token 区分账号。seed 固定模型延迟的伪随机序列，方便几次复测互相比较。
 */
export function installChannelFakeUpstream(opts: { llmHost: string; seed: number }): ChannelFakeUpstream {
  const queues = new Map<string, FakeMsg[]>(); // open_kfid -> 队列
  let msgSeq = 0;
  const sent: Sent[] = [];
  const stats = { chatCalls: 0 };
  const rng = mulberry32(opts.seed);

  const queueOf = (openKfId: string): FakeMsg[] => {
    let q = queues.get(openKfId);
    if (!q) {
      q = [];
      queues.set(openKfId, q);
    }
    return q;
  };

  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlStr);
    const signal = (init?.signal ?? (input instanceof Request ? input.signal : null)) as AbortSignal | null;

    // 本机环回（脚本自己打本机服务，这次压测没有用到，留着与 fake-upstream.ts 一致、防止意外请求被误判成外部请求）
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);

    if (url.hostname === 'qyapi.weixin.qq.com') {
      const ep = url.pathname.replace(/^\/cgi-bin\//, '');
      if (ep === 'gettoken') {
        const corpid = url.searchParams.get('corpid') ?? 'unknown';
        return json({ errcode: 0, access_token: `loadtest-token-${corpid}`, expires_in: 7200 });
      }
      if (ep === 'media/upload') return json({ errcode: 40004, errmsg: 'loadtest: 缩略图上传失败' });
      if (ep === 'kf/customer/batchget') return json({ errcode: 0, customer_list: [] });
      const body = bodyOf(init);
      if (ep === 'kf/sync_msg') {
        const openKfId = String((body as { open_kfid?: unknown }).open_kfid ?? '');
        const q = queueOf(openKfId);
        const from = Number(body.cursor ?? '0') || 0;
        const list = q.slice(from);
        return json({ errcode: 0, next_cursor: String(from + list.length), has_more: 0, msg_list: list });
      }
      if (ep === 'kf/send_msg') {
        const touser = String((body as { touser?: unknown }).touser ?? '');
        const openKfId = String((body as { open_kfid?: unknown }).open_kfid ?? '');
        const msgid = String((body as { msgid?: unknown }).msgid ?? '');
        const text = (body as { text?: { content?: unknown } }).text;
        sent.push({ openKfId, to: touser, content: String(text?.content ?? ''), msgid, at: Date.now() });
        return json({ errcode: 0 });
      }
      if (ep === 'kf/send_msg_on_event') {
        const openKfId = String((body as { open_kfid?: unknown }).open_kfid ?? '');
        const msgid = String((body as { msgid?: unknown }).msgid ?? '');
        const text = (body as { text?: { content?: unknown } }).text;
        sent.push({
          openKfId,
          to: `code:${String((body as { code?: unknown }).code ?? '')}`,
          content: String(text?.content ?? ''),
          msgid,
          at: Date.now(),
        });
        return json({ errcode: 0 });
      }
      return json({ errcode: 40001, errmsg: `loadtest: 未模拟的企微接口 ${ep}` });
    }

    if (url.hostname === opts.llmHost) {
      if (url.pathname.endsWith('/embeddings')) {
        const body = bodyOf(init);
        const input_ = Array.isArray((body as { input?: unknown }).input) ? ((body as { input: unknown[] }).input as unknown[]) : [];
        return json({
          data: input_.map((_, i) => ({ embedding: [1, i % 3, (i * 7) % 5] })),
          usage: { prompt_tokens: 11 * input_.length + 3, completion_tokens: 0 },
        });
      }
      if (url.pathname.endsWith('/chat/completions')) {
        stats.chatCalls += 1;
        const n = stats.chatCalls;
        await delay(2000 + rng() * 6000, signal); // 2–8 秒均匀分布，spec「压测」原文
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

    throw new Error(`channel-fake-upstream: 未预期的请求（既不是企微也不是假模型）：${urlStr}`);
  }) as typeof fetch;

  return {
    pushCustomerMessage(openKfId, uid, content) {
      msgSeq += 1;
      const at = Date.now();
      queueOf(openKfId).push({
        msgid: `loadtest-msg-${msgSeq}`,
        open_kfid: openKfId,
        external_userid: uid,
        send_time: Math.floor(at / 1000),
        origin: 3,
        msgtype: 'text',
        text: { content },
      });
      return at;
    },
    sentTo: (openKfId, uid) => sent.filter((s) => s.openKfId === openKfId && s.to === uid),
    allSent: () => sent,
    stats: () => ({ ...stats }),
  };
}
