import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ScriptStep } from './schema.js';
import { resolveValues, type Values } from './values.js';

interface WireMessage {
  role: string;
  /** 主对话是字符串；视觉请求（12 R7）是 [{ type: 'text' }, { type: 'image_url' }] */
  content?: string | { type?: string }[];
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string } }[];
}

export async function startFakeModel(caseId: string, values: Values) {
  let script: ScriptStep[] = [];
  let turn = 0;
  let requests = 0;
  let initialWireLength = 0;
  let contextNote: string | undefined;
  // 12 R13：本轮图片的视觉输出（用例的 vision）与已收到的视觉请求数
  let vision: Record<string, unknown> | undefined;
  let visionRequests = 0;
  const errors: string[] = [];
  const fail = (reason: string) => errors.push(`[${caseId}] 第${turn}轮 第${requests}次请求：${reason}`);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', (e) => {
      fail(e.message);
      res.destroy();
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: WireMessage[];
          stream?: boolean;
          tools?: unknown;
          input?: string[];
        };
        if (req.url?.endsWith('/embeddings')) {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              data: (body.input ?? []).map((t, index) => {
                const embedding = Array.from({ length: 32 }, () => 0);
                for (const ch of t) embedding[ch.codePointAt(0)! % 32]++;
                return { index, embedding };
              }),
              usage: { prompt_tokens: 0 },
            }),
          );
          return;
        }
        if (!req.url?.endsWith('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        // 视觉请求不是主对话：不占脚本的一步，也不算 contextNote 所在的第一次请求。按 vision 原样回 JSON；
        // 附件轮没写 vision 却来了视觉请求，是用例的缺口，记成错误
        if (body.messages?.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'))) {
          visionRequests++;
          if (vision === undefined) fail('收到视觉请求，但这一轮没有写 vision');
          // 12 R7 与不变量 9：视觉请求是独立的一条 user 消息（不带主对话的系统前缀、历史与工具），不流式，图片是 data URL
          const [message] = body.messages;
          const image = Array.isArray(message.content) ? message.content.find((part) => part.type === 'image_url') : undefined;
          const url = (image as { image_url?: { url?: unknown } } | undefined)?.image_url?.url;
          if (body.messages.length !== 1 || message.role !== 'user' || body.tools !== undefined || body.stream)
            fail('视觉请求不该带系统前缀、历史、工具或流式');
          if (typeof url !== 'string' || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]{100,}={0,2}$/.test(url))
            fail('视觉请求的图片不是 png / jpeg 的 data URL');
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: JSON.stringify(vision ?? { kind: 'other', lines: [] }) },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 0, completion_tokens: 0 },
            }),
          );
          return;
        }
        requests++;
        if (requests === 1) {
          initialWireLength = body.messages?.length ?? 0;
          // 引擎把 contextNote 放成独立的 system 消息（第 0 条是 system prompt）
          contextNote = body.messages?.find(
            (m, index) => index > 0 && m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('【当前会话状态】'),
          )?.content as string | undefined;
        }
        // 模型下一次请求里的 tool 消息带完整结果，避免 trace 的 4KB 截断。
        const names = new Map<string, string>();
        for (const [index, message] of (body.messages ?? []).entries()) {
          for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
          if (message.role === 'tool' && message.tool_call_id) {
            const name = names.get(message.tool_call_id);
            if (name) values.calls.set(name, JSON.parse(typeof message.content === 'string' ? message.content : 'null'));
          }
          // llm.ts 的文本工具调用兜底把结果放在这条系统备注式 user 消息里。
          if (message.role === 'user' && index >= initialWireLength && typeof message.content === 'string') {
            const fallback = message.content.match(
              /^【系统】工具 (\S+) 返回：([\s\S]*)\n请根据以上结果用中文微信语气回复客户，不要再输出任何工具调用或标签。$/,
            );
            if (fallback) values.calls.set(fallback[1], JSON.parse(fallback[2]));
          }
        }
        const step = script[requests - 1];
        if (!step) fail('脚本耗尽');
        const source = step ?? { content: '请稍候。' };
        const resolved: ScriptStep = {
          content: source.content === undefined ? undefined : String(resolveValues(source.content, values, false)),
          toolCalls: resolveValues(source.toolCalls, values) as ScriptStep['toolCalls'],
        };
        const tool_calls = resolved.toolCalls?.map((call, index) => ({
          id: `v2_${turn}_${requests}_${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }));
        const message = { role: 'assistant', content: resolved.content ?? null, ...(tool_calls?.length ? { tool_calls } : {}) };
        const finish_reason = tool_calls?.length ? 'tool_calls' : 'stop';
        if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          const delta = { ...message, ...(tool_calls ? { tool_calls: tool_calls.map((c, index) => ({ ...c, index })) } : {}) };
          res.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }] })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        // 返回有效的最终文本，让引擎停止重试；真实失败由 runner 的 errors 判定。
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '请稍候。' }, finish_reason: 'stop' }] }));
      }
    });
  });
  server.requestTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    errors,
    begin(n: number, steps: ScriptStep[] = [], visionOutput?: Record<string, unknown>) {
      turn = n;
      script = steps;
      requests = 0;
      contextNote = undefined;
      vision = visionOutput;
      visionRequests = 0;
    },
    /** 本轮第一次模型请求里的 contextNote；本轮没有模型请求时是 undefined */
    contextNote: () => contextNote,
    finish() {
      if (requests < script.length) {
        errors.push(`[${caseId}] 第${turn}轮 第${requests + 1}次请求：脚本剩余 ${script.length - requests} 项`);
      }
      // 写了 vision 就该恰好有一次视觉请求（一张图一次，包不重试）。
      if (vision !== undefined && visionRequests !== 1)
        errors.push(`[${caseId}] 第${turn}轮：写了 vision，视觉请求 ${visionRequests} 次（应为 1 次）`);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
