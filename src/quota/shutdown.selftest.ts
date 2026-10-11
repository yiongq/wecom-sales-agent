// env 账号停机截止后的模型异常：不发兜底、不丢在途消息，重启后照常重放；截止前仍回原来的兜底。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KfMessage } from '../adapters/wecom-state.js';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-shutdown-'));
Object.assign(process.env, {
  VAR_DIR: temp,
  CONFIG_SOURCE: 'file',
  SESSION_STORE: 'file',
  LLM_MOCK: '0',
  LLM_PROVIDER: '',
  LLM_BASE_URL: 'https://model.example.invalid',
  LLM_API_KEY: 'selftest-fake-key',
  LLM_MODEL: 'selftest-fake',
  LLM_HEDGE_MODEL: '',
  LLM_MAX_RETRY: '0',
  PUBLIC_BASE_URL: '',
  WECOM_CORP_ID: 'selftest-corp',
  WECOM_APP_SECRET: 'selftest-secret',
  WECOM_KF_OPEN_KFID: 'selftest-kf',
});
enterTenantScopeForTest(hostRuntime());

const messages: KfMessage[] = [];
const sent: { to: string; content: string }[] = [];
const reply = '西藏 5–10 月最合适～您几位出行？';
let failModel = true;
let rejectModel: ((error: Error) => void) | undefined;
let calls = 0;
const originalFetch = globalThis.fetch;
const response = (body: unknown): Response => Response.json(body);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'model.example.invalid' && url.pathname.endsWith('/chat/completions')) {
    calls++;
    if (failModel) return new Promise<Response>((_resolve, reject) => (rejectModel = reject));
    return response({ choices: [{ message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }
  assert.equal(url.hostname, 'qyapi.weixin.qq.com', '自测不允许真实外发');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  if (url.pathname.endsWith('/gettoken')) return response({ errcode: 0, access_token: 'tok', expires_in: 7200 });
  if (url.pathname.endsWith('/kf/sync_msg')) {
    const from = Number(String(body.cursor ?? '').split(':')[1] ?? 0);
    return response({ errcode: 0, next_cursor: `0:${messages.length}`, has_more: 0, msg_list: messages.slice(from) });
  }
  if (url.pathname.endsWith('/kf/send_msg')) {
    sent.push({ to: body.touser, content: body.text.content });
    return response({ errcode: 0 });
  }
  if (url.pathname.endsWith('/kf/customer/batchget')) return response({ errcode: 0, customer_list: [] });
  throw new Error(`自测未模拟的接口：${url.pathname}`);
};

const wecom = await withoutTenantScope(() => import('../adapters/wecom.js'));
const store = await withoutTenantScope(() => import('../store.js'));
// 排在模块 exit 落盘监听之后，连失败路径也只清理自己的目录。
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await sleep(10);
  assert.ok(condition(), '处理链在五秒内完成');
}
function customer(uid: string): KfMessage {
  return {
    msgid: `qs-${uid}`,
    open_kfid: 'selftest-kf',
    external_userid: uid,
    send_time: Math.floor(Date.now() / 1000),
    origin: 3,
    msgtype: 'text',
    text: { content: '想去西藏看看' },
  };
}
async function failTurn(uid: string): Promise<void> {
  rejectModel = undefined;
  messages.push(customer(uid));
  await wecom.syncFromCallback('tok');
  await waitFor(() => rejectModel !== undefined);
}
const timeoutError = (): Error => new DOMException('selftest model timeout', 'TimeoutError');

try {
  await wecom.syncFromCallback('cold-start');
  await failTurn('wmQlive');
  rejectModel!(timeoutError());
  await waitFor(() => !wecom.__test.inspectForTest().busy);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'wmQlive');
  assert.equal(sent[0]!.content, '抱歉，系统开小差了，请稍后再发一次，或直接联系人工顾问。');

  await failTurn('wmQerr');
  const shutdown = store.runShutdownHooks(200); // normal 段 150ms；真实停机钩子设置截止。
  assert.equal(await shutdown, false);
  rejectModel!(timeoutError());
  await waitFor(() => !wecom.__test.inspectForTest().busy);
  assert.equal(sent.filter((r) => r.to === 'wmQerr').length, 0, '截止后模型异常也不开始 send_msg');
  const pending = (): { msg: KfMessage }[] => JSON.parse(fs.readFileSync(wecom.__test.STATE_FILE, 'utf8')).pending;
  assert.ok(
    pending().some((p) => p.msg.external_userid === 'wmQerr'),
    '异常消息留在盘上供重启重放',
  );
  assert.equal(store.getSession('wecom:wmQerr')!.messages.filter((m) => m.role === 'customer').length, 1);
  assert.equal(store.getSession('wecom:wmQerr')!.messages.filter((m) => m.role === 'agent').length, 0);

  failModel = false;
  await wecom.__test.resetForTest();
  await wecom.syncFromCallback('restart');
  await waitFor(() => !wecom.__test.inspectForTest().busy);
  assert.deepEqual(
    sent.filter((r) => r.to === 'wmQerr'),
    [{ to: 'wmQerr', content: reply }],
  );
  assert.equal(calls, 3, '截止前失败一次、截止后失败一次、重启补生成一次');
  assert.equal(store.getSession('wecom:wmQerr')!.messages.filter((m) => m.role === 'customer').length, 1);
  assert.equal(store.getSession('wecom:wmQerr')!.messages.filter((m) => m.role === 'agent').length, 1);
  await waitFor(() => pending().length === 0);
  console.log('QUOTA SHUTDOWN PASS: 截止前兜底照旧 / 截止后 TimeoutError 零发送 / 在途落盘 / 重启恰好补回一次');
} finally {
  await wecom.__test.resetForTest();
  globalThis.fetch = originalFetch;
}
