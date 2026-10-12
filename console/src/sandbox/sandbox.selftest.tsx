// 05 第 24 步：沙箱三态、四步、会话入口、失效跳转与结束体验。
import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { startLiveEvents } from '../shell/live.js';
import { VIEWER_KEY } from '../viewer.js';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpError } from '../api.js';
import { errorCopy } from '../parts/errors.js';
import { beginMemberSession, createSessionFetch, endMemberSession, isSessionExpired } from '../session.js';
import { resolveBoot } from '../shell/boot.js';
import { userMenuItems } from '../shell/UserMenu.js';
import {
  readCollapsed,
  remainingTime,
  SandboxBanner,
  SandboxChecklist,
  SimulatorLink,
  simulatorHref,
  writeCollapsed,
  type SandboxInfo,
} from './Sandbox.js';

let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}
const info: SandboxInfo = {
  expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  wechat: 'off',
  steps: [false, false, false, false],
};
const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
const markup = (extra: Partial<Parameters<typeof SandboxChecklist>[0]> = {}) =>
  renderToStaticMarkup(createElement(SandboxChecklist, { slug: 'sbx-a', sandbox: info, onRetry: () => {}, ...extra }));
check(() => assert.match(markup(), /从发一句消息开始/));
check(() => assert.match(markup({ pending: true }), /正在载入体验进度/));
check(() => assert.doesNotMatch(markup({ pending: true }), /未完成/));
check(() => assert.match(markup({ error: new TypeError('offline') }), /没取到体验进度/));
check(() => assert.match(markup({ error: new TypeError('offline') }), /重\s*试/));
for (let mask = 0; mask < 16; mask++) {
  const steps = [0, 1, 2, 3].map((i) => !!(mask & (1 << i))) as SandboxInfo['steps'];
  const html = markup({ sandbox: { ...info, steps } });
  check(() => assert.equal((html.match(/aria-label="已完成"/g) ?? []).length, steps.filter(Boolean).length));
  check(() => assert.equal((html.match(/aria-label="未完成"/g) ?? []).length, steps.filter((v) => !v).length));
}
check(() => assert.match(markup({ sandbox: { ...info, steps: [true, true, true, true] } }), /四步已完成/));
check(() => assert.match(renderToStaticMarkup(createElement(SandboxBanner, { sandbox: info })), /只进模拟器/));
check(() => assert.equal(simulatorHref('sbx-a&x=1'), '/chat.html?c=sbx-a%26x%3D1'));
check(() => assert.equal(simulatorHref('sim-a'), null));
check(() => assert.equal(renderToStaticMarkup(createElement(SimulatorLink, { id: 'wecom:wmTest' })), ''));
check(() => assert.match(renderToStaticMarkup(createElement(SimulatorLink, { id: 'sbx-a' })), /在模拟器里打开/));
check(() => assert.equal(remainingTime('2026-10-11T02:00:00Z', Date.parse('2026-10-11T01:00:00Z')), '剩余1小时'));
check(() => assert.equal(remainingTime('2026-10-11T01:15:00Z', Date.parse('2026-10-11T01:00:00Z')), '剩余15分钟'));
check(() => assert.equal(remainingTime('2026-10-11T01:00:00Z', Date.parse('2026-10-11T01:00:00Z')), '体验已到期'));
check(() =>
  assert.ok(!userMenuItems({ appearance: 'light', reduce: false, sandbox: true }).some((i) => i && 'key' in i && i.key === 'logout')),
);
check(() => assert.match(errorCopy(new HttpError(429, { error: 'sandbox_write_limited' })).title, /写入次数已达上限/));
check(() => assert.match(errorCopy(new HttpError(429, { error: 'llm_budget_exhausted' })).title, /模型额度已用完/));
for (const [status, error, url] of [
  [401, 'sandbox_required', '/try'],
  [410, 'sandbox_expired', '/try?ended=1'],
] as const) {
  check(() => assert.deepEqual(resolveBoot({ status, body: { error } }, { status, body: { error } }, false), { kind: 'redirect', url }));
  for (const member of [false, true]) {
    endMemberSession();
    if (member) beginMemberSession({ userId: 'visitor', csrf: 'csrf' });
    const replace = win.location.replace;
    let target = '';
    win.location.replace = (next: string) => {
      target = next;
    };
    try {
      const res = await createSessionFetch(async () => json(status, error))('/api/console/me');
      check(() => assert.equal(res.status, status));
      check(() => assert.equal(target, url));
      check(() => assert.equal(isSessionExpired(), false));
    } finally {
      win.location.replace = replace;
      endMemberSession();
    }
  }
}
// 消息事件让服务端重算清单，未收到事件时 useViewer 的轮询兜底。
{
  const qc = new QueryClient();
  qc.setQueryData(VIEWER_KEY, { kind: 'member', me: { sandbox: info } });
  const source = new EventTarget();
  const stop = startLiveEvents({ qc, onNotify: () => {}, createEventSource: () => Object.assign(source, { close() {} }) });
  source.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 'sbx-a' }) }));
  check(() => assert.equal(qc.getQueryState(VIEWER_KEY)?.isInvalidated, true));
  stop();
  qc.clear();
}
writeCollapsed('sbx-a', true);
check(() => assert.equal(readCollapsed('sbx-a'), true));
check(() => assert.equal(readCollapsed('sbx-b'), false));
writeCollapsed('sbx-a', false);
const storage = globalThis.localStorage;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get: () => {
    throw new Error('blocked');
  },
});
try {
  check(() => assert.equal(readCollapsed('sbx-a'), false));
  check(() => assert.doesNotThrow(() => writeCollapsed('sbx-a', true)));
} finally {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const render = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 10));
  });
};
const click = async (text: string, scope: ParentNode = document) => {
  const b = Array.from(scope.querySelectorAll('button')).find((x) => x.textContent?.replace(/\s+/g, '').includes(text));
  assert.ok(b, text);
  await act(async () => {
    b.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as MouseEvent);
    await new Promise((r) => setTimeout(r, 30));
  });
};
let retries = 0;
try {
  await render(
    createElement(SandboxChecklist, {
      slug: 'sbx-a',
      sandbox: info,
      onRetry: () => {
        retries++;
      },
    }),
  );
  await click('收起', host);
  check(() => assert.equal(host.querySelector('ol'), null));
  check(() => assert.equal(readCollapsed('sbx-a'), true));
  await click('展开', host);
  check(() => assert.ok(host.querySelector('ol')));
  await render(
    createElement(SandboxChecklist, {
      slug: 'sbx-a',
      sandbox: info,
      error: new TypeError('offline'),
      onRetry: () => {
        retries++;
      },
    }),
  );
  await click('重试', host);
  check(() => assert.equal(retries, 1));
  const fetchBefore = globalThis.fetch;
  const replaceBefore = win.location.replace;
  let path = '';
  let csrf = '';
  let target = '';
  let fail = true;
  beginMemberSession({ userId: 'visitor', csrf: 'visitor-csrf' });
  globalThis.fetch = async (input, init) => {
    path = String(input);
    csrf = new Headers(init?.headers).get('x-csrf') ?? '';
    return fail ? json(503, 'not_ready') : new Response('{}', { status: 200 });
  };
  win.location.replace = (next: string) => {
    target = next;
  };
  try {
    await render(createElement(SandboxBanner, { sandbox: info }));
    await click('结束体验', host);
    check(() => assert.match(document.body.textContent ?? '', /无法恢复/));
    await click('继续体验');
    check(() => assert.equal(path, ''));
    await click('结束体验', host);
    await click('结束体验', document.querySelector('.ant-modal')!);
    check(() => assert.equal(path, '/api/sandbox/end'));
    check(() => assert.equal(csrf, 'visitor-csrf'));
    check(() => assert.equal(target, ''));
    check(() => assert.match(host.textContent ?? '', /系统正在启动/));
    fail = false;
    await click('重试', host);
    check(() => assert.equal(target, '/try?ended=1'));
  } finally {
    globalThis.fetch = fetchBefore;
    win.location.replace = replaceBefore;
    endMemberSession();
  }
} finally {
  await act(async () => root.unmount());
  host.remove();
  await win.happyDOM.abort();
}
console.log(`SELFTEST PASS: 沙箱 console ${checks} 项`);
