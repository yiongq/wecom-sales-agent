// 压测用的极简后台客户端：真实 HTTP 打 /api/console/*（登录、SSE、接手、人工回复），不借用浏览器的 cookie jar——
// 手动摘 Set-Cookie、手动带 x-csrf，照 src/console-api/app.ts 的契约（登录拿 cookie + csrf，写接口校验 x-csrf）。

export interface LoggedIn {
  cookie: string;
  csrf: string;
  userId: string | null;
  role: string;
}

export async function login(base: string, email: string, password: string): Promise<LoggedIn> {
  const res = await fetch(`${base}/api/console/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}：${await res.text()}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('登录响应没有 Set-Cookie');
  const cookie = setCookie.split(';')[0]!;
  const me = (await res.json()) as { userId: string | null; csrf: string; role: string };
  return { cookie, csrf: me.csrf, userId: me.userId, role: me.role };
}

export interface SseEvent {
  event: string;
  data: string;
  receivedAt: number;
}

export interface SseConn {
  close(): void;
  closed: Promise<void>;
}

/**
 * 打开一条事件流连接，每收到一条完整的 SSE 事件就调 onEvent（含到达的墙钟时刻，压测用它算「提交到送达」延迟）。
 * 心跳行（以 : 开头的注释）不算一条事件。
 */
export async function openEvents(base: string, auth: LoggedIn, onEvent: (e: SseEvent) => void): Promise<SseConn> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/console/events`, {
    headers: { cookie: auth.cookie, accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) throw new Error(`打开事件流失败 ${res.status}`);
  let buf = '';
  let curEvent = '';
  let curData: string[] = [];
  const flush = (): void => {
    if (curData.length) onEvent({ event: curEvent || 'message', data: curData.join('\n'), receivedAt: Date.now() });
    curEvent = '';
    curData = [];
  };
  const pump = (async (): Promise<void> => {
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += Buffer.from(chunk).toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            flush();
          } else if (line.startsWith(':')) {
            // 心跳注释行，忽略
          } else if (line.startsWith('event:')) {
            curEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            curData.push(line.slice(5).trim());
          }
          // id: 行与压测的测量无关，忽略
        }
      }
    } catch {
      // 连接被 close() 中止，或对端断开：压测收尾阶段的正常情况
    }
  })();
  return {
    close: () => ctrl.abort(),
    closed: pump,
  };
}

export async function takeover(base: string, auth: LoggedIn, sessionId: string): Promise<void> {
  const res = await fetch(`${base}/api/console/conversations/${encodeURIComponent(sessionId)}/takeover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth.cookie, 'x-csrf': auth.csrf },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`接手失败 ${res.status}：${await res.text()}`);
}

export async function humanReply(base: string, auth: LoggedIn, sessionId: string, text: string, clientId: string): Promise<unknown> {
  const res = await fetch(`${base}/api/console/conversations/${encodeURIComponent(sessionId)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth.cookie, 'x-csrf': auth.csrf },
    body: JSON.stringify({ text, clientId }),
  });
  if (!res.ok) throw new Error(`人工回复失败 ${res.status}：${await res.text()}`);
  return res.json();
}
