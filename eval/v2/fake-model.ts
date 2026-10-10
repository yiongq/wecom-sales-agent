import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ScriptStep } from './schema.js';
import { resolveValues, type Values } from './values.js';

interface WireMessage {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string } }[];
}

export async function startFakeModel(caseId: string, values: Values) {
  let script: ScriptStep[] = [];
  let turn = 0;
  let requests = 0;
  let initialWireLength = 0;
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
        requests++;
        if (requests === 1) initialWireLength = body.messages?.length ?? 0;
        // 模型下一次请求里的 tool 消息带完整结果，避免 trace 的 4KB 截断。
        const names = new Map<string, string>();
        for (const [index, message] of (body.messages ?? []).entries()) {
          for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
          if (message.role === 'tool' && message.tool_call_id) {
            const name = names.get(message.tool_call_id);
            if (name) values.calls.set(name, JSON.parse(message.content ?? 'null'));
          }
          // llm.ts 的文本工具调用兜底把结果放在这条系统备注式 user 消息里。
          if (message.role === 'user' && index >= initialWireLength) {
            const fallback = message.content?.match(
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
    begin(n: number, steps: ScriptStep[] = []) {
      turn = n;
      script = steps;
      requests = 0;
    },
    finish() {
      if (requests < script.length) {
        errors.push(`[${caseId}] 第${turn}轮 第${requests + 1}次请求：脚本剩余 ${script.length - requests} 项`);
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
