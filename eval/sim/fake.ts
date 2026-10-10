// 本机脚本服务，仅供自测与 CLI 冒烟；没有任何真实模型调用。
import http from 'node:http';
import type { AddressInfo } from 'node:net';
export interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}
export interface FakeStep {
  content?: string | ((messages: WireMessage[]) => string);
  tools?: { name: string; args: Record<string, unknown> }[];
  prompt?: number;
  completion?: number;
  cached?: number;
  reasoning?: number;
}
export async function fakeService(): Promise<{
  url: string;
  script: FakeStep[];
  requests: { model: string; messages: WireMessage[] }[];
  close(): Promise<void>;
}> {
  const script: FakeStep[] = [];
  const requests: { model: string; messages: WireMessage[] }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: WireMessage[]; input?: string[] };
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      res.end(
        JSON.stringify({
          data: (body.input ?? []).map(() => ({ embedding: [1, 0, 1] })),
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      );
      return;
    }
    requests.push(body);
    const step = script.shift();
    if (!step) {
      res.statusCode = 500;
      res.end('{"error":"fake_script_exhausted"}');
      return;
    }
    const message = step.tools
      ? {
          content: null,
          tool_calls: step.tools.map((t, i) => ({
            id: `fake_${requests.length}_${i}`,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        }
      : { content: typeof step.content === 'function' ? step.content(body.messages) : step.content };
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: step.prompt ?? 100,
          completion_tokens: step.completion ?? 20,
          prompt_tokens_details: { cached_tokens: step.cached ?? 0 },
          completion_tokens_details: { reasoning_tokens: step.reasoning ?? 0 },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    script,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
export function fakeEnv(salesUrl: string, customerUrl: string): void {
  Object.assign(process.env, {
    CONFIG_SOURCE: 'file',
    LLM_MOCK: '0',
    LLM_PROVIDER: '',
    LLM_BASE_URL: salesUrl,
    LLM_MODEL: 'sim-fake-sales',
    LLM_MODEL_CHEAP: 'sim-fake-sales',
    LLM_API_KEY: 'fake',
    LLM_HEDGE_MODEL: '',
    LLM_MAX_RETRY: '0',
    EMBED_BASE_URL: salesUrl,
    EMBED_API_KEY: 'fake',
    SIM_CUSTOMER_BASE_URL: customerUrl,
    SIM_CUSTOMER_API_KEY: 'fake',
    DAILY_VISITOR_LLM_CALLS: '0',
    VISITOR_SESSION_LLM_CALLS: '0',
    TZ: 'Asia/Shanghai',
  });
}
export const fakePrices = {
  'sim-fake-sales': { in: 1, out: 2, cachedIn: 0.5 },
  'sim-fake-customer': { in: 1, out: 2, cachedIn: 0.5 },
  'embedding-3': { in: 0, out: 0, cachedIn: 0 },
};
export const say = (text: string, done = false): FakeStep => ({ content: JSON.stringify({ say: text, done }) });
