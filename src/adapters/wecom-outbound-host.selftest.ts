// 05 R21：宿主 env 账号保留 02 的发送边界、强刷、重试与分段时序。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-outbound-'));
process.env.VAR_DIR = temp;
process.env.CONFIG_SOURCE = 'file';
process.env.LLM_MOCK = '1';
process.env.WECOM_CORP_ID = 'fake-host-corp';
process.env.WECOM_APP_SECRET = 'fake-host-secret'; // gitleaks:allow
process.env.WECOM_KF_OPEN_KFID = 'fake-host-kf';
process.env.PUBLIC_BASE_URL = '';
const { wecomAdapter, SandboxWecomRuntime, installSandboxWecomOutbound } = await import('./wecom.js');
const { hostRuntime, withTenantScope, configureTenancy } = await import('../tenancy/runtime.js');
const { sandboxWechatIndex } = await import('../tenancy/sandbox/outbound.js');
const { __ledgerTest } = await import('../quota/ledger.js');
const { dropTenantState } = await import('../tenancy/state.js');
const { dropShutdownHooks } = await import('../shutdown.js');
const host = hostRuntime();
configureTenancy({ role: 'host', standardCount: 1 });
const originalFetch = globalThis.fetch;
const events: string[] = [];
const bodies: Record<string, any>[] = [];
let mode = 'ok',
  tokens = 0,
  ticks = 0,
  measure = false,
  sendTick = -1;
let sandboxRequests = 0;
const sandbox = new SandboxWecomRuntime(
  { corpId: 'fake-sandbox-corp', secret: 'fake-sandbox-secret', openKfid: 'fake-sandbox-kf', host: 'sandbox.example.invalid' },
  async () => {
    sandboxRequests++;
    throw new Error('宿主不能用体验客服');
  },
); // gitleaks:allow
installSandboxWecomOutbound(sandbox);
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/gettoken')) {
    events.push('token');
    tokens++;
    assert.equal(url.searchParams.get('corpid'), 'fake-host-corp');
    return Response.json({ access_token: `fake-host-access-${tokens}`, expires_in: 7200 });
  }
  assert.ok(url.pathname.endsWith('/kf/send_msg'));
  const body = JSON.parse(String(init?.body));
  bodies.push(body);
  events.push(`send:${url.searchParams.get('access_token')}`);
  assert.equal(body.open_kfid, 'fake-host-kf');
  assert.equal(body.touser, 'wmHost');
  if (measure) {
    measure = false;
    sendTick = ticks;
  }
  if (mode === 'expired' || mode === 'invalid') {
    const errcode = mode === 'expired' ? 42001 : 40014;
    mode = 'ok';
    return Response.json({ errcode });
  }
  if (mode === 'busy') {
    mode = 'ok';
    return Response.json({ errcode: 45009 });
  }
  return Response.json({ errcode: 0 });
};
try {
  await withTenantScope(host, async () => {
    // 没有体验绑定，照常能发；正文里合法同站链接也不被改成 /wx/。
    sandboxWechatIndex.reset();
    const fakeLinkToken = randomBytes(32).toString('base64url');
    assert.equal(await wecomAdapter.push('wecom:wmHost', `宿主测试 /privacy /wx/${fakeLinkToken}/privacy`), true);
    assert.ok(bodies.at(-1)!.text.content.includes(fakeLinkToken));
    assert.deepEqual(events, ['token', 'send:fake-host-access-1']);
    // cache 命中时从 push 到 fetch 的 microtask 数保持 02 基线；增加 await 会令断言失败。
    ticks = 0;
    sendTick = -1;
    measure = true;
    const pending = wecomAdapter.push('wecom:wmHost', '时序测试');
    const tick = () => {
      ticks++;
      if (measure && ticks < 30) queueMicrotask(tick);
    };
    queueMicrotask(tick);
    await pending;
    assert.equal(sendTick, 1);
    for (const expired of ['expired', 'invalid']) {
      events.length = 0;
      bodies.length = 0;
      mode = expired;
      assert.equal(await wecomAdapter.push('wecom:wmHost', '强刷测试'), true);
      assert.deepEqual(events, [`send:fake-host-access-${tokens - 1}`, 'token', `send:fake-host-access-${tokens}`]);
      assert.equal(bodies[0]!.msgid, bodies[1]!.msgid);
    }
    events.length = 0;
    bodies.length = 0;
    mode = 'busy';
    assert.equal(await wecomAdapter.push('wecom:wmHost', '重试测试'), true);
    assert.equal(events.length, 2);
    assert.equal(bodies[0]!.msgid, bodies[1]!.msgid);
    bodies.length = 0;
    assert.equal(await wecomAdapter.push('wecom:wmHost', '一'.repeat(1700)), true);
    assert.equal(bodies.length, 3);
    assert.ok(__ledgerTest.rows('wecom:wmHost').every((r) => r.status === 'accepted' && !r.v2));
  });
  assert.equal(sandboxRequests, 0);
  console.log('SELFTEST PASS: 宿主发送前同步时序、两种 token 强刷、重试和三段回复');
} finally {
  sandbox.stop();
  globalThis.fetch = originalFetch;
  dropTenantState(host.id);
  dropShutdownHooks(host);
  fs.rmSync(temp, { recursive: true, force: true });
}
