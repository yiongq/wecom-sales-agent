import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

export interface CustomerMessage {
  msgid: string;
  external_userid: string;
  open_kfid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text: { content: string };
  queuedAt: number;
}
export interface RequestRecord {
  process: string;
  endpoint: string;
  start: number;
  end: number | null;
  body: Record<string, unknown>;
}
export interface OutboundRow {
  inbound: string | null;
  msgid: string;
  status: string;
  segment: number;
  messageSeq: number | null;
}
export function hasWaitMode(sources: string[]): boolean {
  return sources.some((source) => /\bTENANT_LOCK_WAIT\b/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')));
}
export function callbackEnvelope(secrets: { corpId: string; openKfId: string; callbackToken: string; callbackAesKey: string }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(12).toString('hex');
  const plain = `<xml><ToUserName>${secrets.corpId}</ToUserName><CreateTime>${timestamp}</CreateTime><MsgType>event</MsgType><Event>kf_msg_or_event</Event><Token>drill-${nonce}</Token><OpenKfId>${secrets.openKfId}</OpenKfId></xml>`;
  const key = Buffer.from(secrets.callbackAesKey, 'base64');
  const message = Buffer.from(plain);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const body = Buffer.concat([randomBytes(16), length, message, Buffer.from(secrets.corpId)]);
  const pad = 32 - (body.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([body, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
  const signature = createHash('sha1').update([secrets.callbackToken, timestamp, nonce, encrypted].toSorted().join('')).digest('hex');
  return {
    query: new URLSearchParams({ msg_signature: signature, timestamp, nonce }).toString(),
    xml: `<xml><ToUserName>${secrets.corpId}</ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
  };
}
export function summarizeWecom(messages: CustomerMessage[], requests: RequestRecord[], rows: OutboundRow[], sendingAtFault: Set<string>) {
  const sends = requests.filter((r) => r.endpoint === 'kf/send_msg' || r.endpoint === 'kf/send_msg_on_event');
  const unknown = rows.filter((r) => r.status === 'unknown');
  const boundary = unknown.filter((r) => sendingAtFault.has(r.msgid));
  const bySegment = new Map<string, Set<string>>();
  for (const r of sends) {
    if (typeof r.body.msgid !== 'string') continue;
    const row = rows.find((row) => row.msgid === r.body.msgid);
    const segmentKey = row?.inbound ? `${row.inbound}:${row.segment}` : r.body.msgid;
    const processes = bySegment.get(segmentKey) ?? new Set<string>();
    processes.add(r.process);
    bySegment.set(segmentKey, processes);
  }
  const perMessage = messages.map((message) => {
    const out = rows.filter((r) => r.inbound === message.msgid);
    const attempts = sends.filter((r) => r.body.touser === message.external_userid);
    const expected = new Set(out.map((r) => r.msgid));
    const delivered = new Set(attempts.map((r) => String(r.body.msgid)));
    const missing = out.filter((r) => !delivered.has(r.msgid));
    // 按入站 + messageSeq 识别整条回复，按 msgid / segment 识别同段重发；不把合法的多段回复算成重复。
    const deliveredRows = out.filter((r) => delivered.has(r.msgid));
    const groups = new Set(deliveredRows.map((r) => r.messageSeq ?? 'notice'));
    const duplicate =
      Math.max(0, attempts.length - delivered.size) +
      Math.max(0, groups.size - 1) +
      deliveredRows.filter((r, i) => deliveredRows.findIndex((other) => other.segment === r.segment) < i).length;
    const boundarySegments = out.filter((r) => boundary.includes(r));
    const unexpected = attempts.filter((r) => !expected.has(String(r.body.msgid))).length;
    const replied = out.length > 0 && missing.length === 0 && unexpected === 0;
    return {
      msgid: message.msgid,
      conversation: message.external_userid,
      replyCount: groups.size + Math.max(0, attempts.length - delivered.size),
      sendRequests: attempts.length,
      segments: out.map((r) => ({ ...r, requests: attempts.filter((a) => a.body.msgid === r.msgid).length })),
      replied,
      duplicate,
      unexpected,
      missingOutsideBoundary: out.length === 0 ? 1 : missing.filter((r) => !boundary.includes(r)).length,
      boundarySegments: boundarySegments.length,
      waitMs: replied ? Math.max(...attempts.map((r) => r.start)) - message.queuedAt : null,
    };
  });
  return {
    perMessage,
    sent: messages.length,
    replied: perMessage.filter((m) => m.replied).length,
    maxWaitMs: perMessage.some((m) => m.waitMs !== null)
      ? Math.max(...perMessage.flatMap((m) => (m.waitMs === null ? [] : [m.waitMs])))
      : null,
    missingOutsideBoundary: perMessage.reduce((n, m) => n + m.missingOutsideBoundary + m.unexpected, 0),
    duplicateReplies: perMessage.filter((m) => m.duplicate > 0).length,
    unknownSegments: unknown.length,
    boundarySegments: boundary.length,
    dualProcessSentSegments: [...bySegment.values()].filter((p) => p.size > 1).length,
  };
}
export async function fakeWecom() {
  const messages: CustomerMessage[] = [];
  const requests: RequestRecord[] = [];
  const errors: string[] = [];
  const auth = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  let holdNextSend = false;
  let held: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    if (req.headers['x-drill-auth'] !== auth || !['a', 'b'].includes(String(req.headers['x-drill-process']))) {
      res.writeHead(403).end();
      return;
    }
    const endpoint = new URL(req.url!, 'http://localhost').pathname.replace(/^\/cgi-bin\//, '');
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('body_limit');
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString();
      const body = raw && req.headers['content-type']?.includes('json') ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const record: RequestRecord = { process: String(req.headers['x-drill-process']), endpoint, body, start: Date.now(), end: null };
      requests.push(record);
      res.once('close', () => {
        record.end = Date.now();
      });
      let response: unknown;
      if (endpoint === 'gettoken') response = { errcode: 0, access_token: token, expires_in: 7200 };
      else if (endpoint === 'kf/sync_msg') {
        const cursor = body.cursor === '' || body.cursor === undefined ? 0 : Number(body.cursor);
        if (!Number.isInteger(cursor) || cursor < 0 || cursor > messages.length) throw new Error('cursor_invalid');
        const batch = messages.slice(cursor, cursor + 100).map(({ queuedAt: _at, ...m }) => m);
        response = {
          errcode: 0,
          msg_list: batch,
          next_cursor: String(cursor + batch.length),
          has_more: cursor + batch.length < messages.length ? 1 : 0,
        };
      } else if (endpoint === 'kf/send_msg' || endpoint === 'kf/send_msg_on_event') {
        // 不替应用去重：每次请求都入账，重复 msgid 也保留，才能看到旧进程的重试。
        if (holdNextSend) {
          holdNextSend = false;
          await new Promise<void>((resolve) => {
            held = resolve;
          });
          held = undefined;
        }
        await sleep(30);
        response = { errcode: 0, msgid: body.msgid ?? 'drill-event' };
      } else if (endpoint === 'media/upload')
        response = { errcode: 0, type: 'image', media_id: 'drill-image', created_at: Math.floor(Date.now() / 1000) };
      else throw new Error('endpoint_unsupported');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    } catch {
      errors.push(endpoint);
      res.writeHead(500).end('{"errcode":-1}');
    }
  });
  server.requestTimeout = 5000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    auth,
    messages,
    requests,
    errors,
    holdNextSend: () => {
      holdNextSend = true;
    },
    hasHeldSend: () => held !== undefined,
    release: () => held?.(),
    close: async () => {
      held?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
