// 05 第 24 步：沙箱三态、四步、会话入口、失效跳转与结束体验。
import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encode } from 'uqr';
import { WechatStep } from './WechatStep.js';
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
// 四种微信状态下，清单进度自身的加载、空态和错误均由 /me 决定。
for (const wechat of ['off', 'full', 'unbound', 'bound'] as const) {
  const sandbox = { ...info, wechat };
  check(() => assert.match(markup({ sandbox, pending: true }), /正在载入体验进度/));
  check(() => assert.match(markup({ sandbox, error: new TypeError('offline') }), /没取到体验进度/));
  check(() => assert.match(markup({ sandbox }), /0\/4/));
  const banner = renderToStaticMarkup(createElement(SandboxBanner, { sandbox }));
  check(() => assert.match(banner, wechat === 'off' || wechat === 'full' ? /只进模拟器/ : /回复只发到你自己的微信/));
}
check(() => assert.match(markup({ sandbox: { ...info, wechat: 'full' } }), /微信体验名额已满/));
check(() => assert.match(markup({ sandbox: { ...info, wechat: 'bound' } }), /已连上你的微信/));
check(() => assert.doesNotMatch(markup({ sandbox: { ...info, wechat: 'bound' } }), /微信体验二维码/));
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
  check(() => assert.equal(host.querySelector<HTMLElement>('#sandbox-checklist-steps')?.hidden, true));
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

  {
    // 用假时钟走真实组件，覆盖签码的超时、重试、换新、收起、绑定与迟到响应。
    const fetchBefore = globalThis.fetch;
    const nowBefore = Date.now;
    const timeoutBefore = globalThis.setTimeout;
    const clearBefore = globalThis.clearTimeout;
    const uaBefore = navigator.userAgent;
    const visibilityBefore = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let now = Date.parse('2026-10-12T01:00:00Z');
    const timers = new Map<number, { at: number; run: () => void }>();
    let timerId = 9000;
    let calls = 0;
    let respond: (res: Response) => void = () => {};
    let requestSignal: AbortSignal | null = null;
    let requestInit: RequestInit | undefined;
    const flush = () => new Promise((resolve) => timeoutBefore(resolve, 30));
    const response = (code = 'TEST-0001', contactLink = 'https://wechat.invalid/fixture?test=1#fake') =>
      new Response(JSON.stringify({ code, expiresAt: new Date(now + 600_000).toISOString(), contactLink }), {
        headers: { 'content-type': 'application/json' },
      });
    const settle = async (res: Response) => {
      await act(async () => {
        respond(res);
        await flush();
      });
    };
    const advance = async (ms: number) => {
      now += ms;
      await act(async () => {
        for (const [id, timer] of timers) if (timer.at <= now && timers.delete(id)) timer.run();
        await flush();
      });
    };
    const visibility = async (value: DocumentVisibilityState) => {
      await act(async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value });
        document.dispatchEvent(new win.Event('visibilitychange') as unknown as Event);
        await flush();
      });
    };
    const step = (wechat: SandboxInfo['wechat']) => createElement(WechatStep, { key: wechat, wechat });
    Date.now = () => now;
    globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
      if (ms < 1000) return timeoutBefore(fn, ms, ...args);
      const id = ++timerId;
      timers.set(id, { at: now + ms, run: fn });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      if (!timers.delete(Number(id))) clearBefore(id);
    }) as typeof clearTimeout;
    beginMemberSession({ userId: 'visitor', csrf: 'visitor-csrf' });
    globalThis.fetch = async (input, init) => {
      check(() => assert.equal(String(input), '/api/sandbox/wechat/code'));
      calls++;
      requestInit = init;
      requestSignal = init?.signal ?? null;
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    };
    try {
      for (const wechat of ['off', 'full', 'bound'] as const) {
        await render(step(wechat));
        check(() => assert.equal(calls, 0));
        check(() => assert.equal(host.querySelector('svg[aria-label="微信体验二维码"]'), null));
      }
      await render(step('unbound'));
      check(() => assert.ok(host.querySelector('[aria-label="正在取微信体验码"]')));
      check(() => assert.equal(requestInit?.method, 'POST'));
      check(() => assert.equal(new Headers(requestInit?.headers).get('x-csrf'), 'visitor-csrf'));
      await settle(response());
      check(() => assert.match(host.textContent ?? '', /TEST-0001/));
      check(() => assert.equal(host.querySelector('.sandbox-open-wechat'), null));
      // 矩阵与含 scene_param 的假链接完全一致，静区 4 格，绘制不经 img/data URL。
      const href = 'https://wechat.invalid/fixture?test=1&scene_param=TEST0001#fake';
      const qr = encode(href, { border: 4, ecc: 'M' });
      const expectedPath = qr.data.flatMap((row, y) => row.flatMap((black, x) => (black ? [`M${x},${y}h1v1h-1z`] : []))).join('');
      check(() => assert.equal(host.querySelector('.sandbox-qr path')?.getAttribute('d'), expectedPath));
      check(() => assert.equal(host.querySelector('.sandbox-qr')?.getAttribute('viewBox'), `0 0 ${qr.size} ${qr.size}`));
      check(() => assert.equal(host.querySelector('img'), null));
      await advance(179_999);
      check(() => assert.doesNotMatch(host.textContent ?? '', /扫码没反应/));
      await advance(1);
      check(() => assert.match(host.textContent ?? '', /扫码没反应？先用模拟器体验/));
      await advance(420_000);
      check(() => assert.equal(calls, 2));
      check(() => assert.doesNotMatch(host.textContent ?? '', /TEST-0001/));
      await settle(json(503, 'sandbox_wecom_unavailable'));
      check(() => assert.match(host.textContent ?? '', /没取到微信体验码/));
      await click('重试', host);
      await settle(response('TEST-0002'));
      check(() => assert.match(host.textContent ?? '', /TEST-0002/));
      check(() => assert.doesNotMatch(host.textContent ?? '', /扫码没反应/));
      await render(step('bound'));
      check(() => assert.match(host.textContent ?? '', /已连上你的微信/));
      check(() => assert.equal(host.querySelector('.sandbox-qr'), null));
      const beforeBoundWait = calls;
      await advance(600_000);
      check(() => assert.equal(calls, beforeBoundWait));
      await click('换一个微信', host);
      check(() => assert.ok(host.querySelector('[aria-label="正在取微信体验码"]')));
      await settle(json(503, 'sandbox_wecom_unavailable'));
      check(() => assert.match(host.textContent ?? '', /已连上你的微信/));
      await click('重试', host);
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Fixture MicroMessenger' });
      await settle(response('TEST-0003'));
      check(() => assert.match(host.textContent ?? '', /TEST-0003/));
      check(() =>
        assert.equal(
          host.querySelector('.sandbox-open-wechat')?.getAttribute('href'),
          'https://wechat.invalid/fixture?test=1&scene_param=TEST0003#fake',
        ),
      );
      await click('收起二维码', host);
      check(() => assert.equal(host.querySelector('.sandbox-qr'), null));
      await click('换一个微信', host);
      const late = respond;
      const aborted = requestSignal as AbortSignal | null;
      await render(step('full'));
      check(() => assert.equal(aborted?.aborted, true));
      await act(async () => {
        late(response());
        await flush();
      });
      check(() => assert.match(host.textContent ?? '', /微信体验名额已满/));
      check(() => assert.equal(host.querySelector('.sandbox-qr'), null));
      await render(step('unbound'));
      await settle(json(409, 'sandbox_wecom_full'));
      check(() => assert.match(host.textContent ?? '', /微信体验名额已满/));
      check(() => assert.equal(host.querySelector('a')?.getAttribute('href'), '/chat.html'));
      const fullCalls = calls;
      await advance(600_000);
      check(() => assert.equal(calls, fullCalls));
      await render(step('off'));
      await render(step('unbound'));
      await advance(15_000);
      check(() => assert.equal(requestSignal?.aborted, true));
      check(() => assert.match(host.textContent ?? '', /没取到微信体验码/));
      await settle(response()); // 忽略未遵守 AbortSignal 的迟到响应。
      check(() => assert.equal(host.querySelector('.sandbox-qr'), null));
      await click('重试', host);
      await settle(response('TEST-0004', 'javascript:fake'));
      check(() => assert.match(host.textContent ?? '', /没取到微信体验码/));
      check(() => assert.equal(host.querySelector('a'), null));
      await click('重试', host);
      await settle(response('TEST-0004'));
      check(() => assert.match(host.textContent ?? '', /TEST-0004/));
      await render(step('off'));
      check(() => assert.equal(timers.size, 0));

      // 收起/展开不重新签码，避免清单刷新后让手机上的旧码失效。
      await render(createElement(SandboxChecklist, { slug: 'sbx-wechat', sandbox: { ...info, wechat: 'unbound' }, onRetry: () => {} }));
      await settle(response());
      const beforeCollapse = calls;
      await click('收起', host);
      await click('展开', host);
      check(() => assert.equal(calls, beforeCollapse));
      check(() => assert.match(host.textContent ?? '', /TEST-0001/));
      await render(step('off'));
      // 页面隐藏、清单收起各跨三个有效期，不刷新服务端最近访问时间。
      const beforeHiddenMount = calls;
      await visibility('hidden');
      await render(step('unbound'));
      for (let i = 0; i < 3; i++) await advance(600_000);
      check(() => assert.equal(calls, beforeHiddenMount, '初次挂载于隐藏页：三个有效期内不签码'));
      await visibility('visible');
      check(() => assert.equal(calls, beforeHiddenMount + 1, '初次恢复可见：只签一次码'));
      await settle(response());
      const beforeHide = calls;
      await visibility('hidden');
      await advance(1_000);
      await visibility('visible');
      check(() => assert.equal(calls, beforeHide, '恢复可见且码仍有效：继续用原码'));
      check(() => assert.match(host.textContent ?? '', /TEST-0001/));
      await visibility('hidden');
      for (let i = 0; i < 3; i++) {
        await advance(600_000);
        check(() => assert.equal(calls, beforeHide, '页面隐藏：连续三个有效期不再签码'));
      }
      await visibility('visible');
      check(() => assert.equal(calls, beforeHide + 1, '恢复可见且码已过期：只换新一次'));
      await visibility('visible');
      check(() => assert.equal(calls, beforeHide + 1, '重复可见事件：不重复请求'));
      await settle(json(503, 'sandbox_wecom_unavailable'));
      const beforeFailureWait = calls;
      for (let i = 0; i < 3; i++) {
        await visibility('hidden');
        await advance(600_000);
        await visibility('visible');
      }
      check(() => assert.equal(calls, beforeFailureWait, '取码失败：等待和可见切换均不自动重试'));
      await click('重试', host);
      check(() => assert.equal(calls, beforeFailureWait + 1, '取码失败：用户点重试才请求一次'));
      await settle(response());
      await render(step('off'));

      const checklist = (slug: string) =>
        createElement(SandboxChecklist, {
          key: slug,
          slug,
          sandbox: { ...info, wechat: 'unbound' },
          onRetry: () => {},
        });
      await render(checklist('sbx-collapse'));
      await settle(response());
      const beforeCollapsed = calls;
      await click('收起', host);
      for (let i = 0; i < 3; i++) {
        await advance(600_000);
        check(() => assert.equal(calls, beforeCollapsed, '清单收起：连续三个有效期不再签码'));
      }
      await click('展开', host);
      check(() => assert.equal(calls, beforeCollapsed + 1, '展开清单且码已过期：只换新一次'));
      await settle(response());
      await click('收起', host);
      await advance(1_000);
      await click('展开', host);
      check(() => assert.equal(calls, beforeCollapsed + 1, '展开清单且码仍有效：继续用原码'));
      await click('收起', host);
      await visibility('hidden');
      await advance(1_800_000);
      await visibility('visible');
      check(() => assert.equal(calls, beforeCollapsed + 1, '页面恢复可见但清单收起：不签码'));
      await visibility('hidden');
      await click('展开', host);
      check(() => assert.equal(calls, beforeCollapsed + 1, '清单展开但页面隐藏：不签码'));
      await visibility('visible');
      check(() => assert.equal(calls, beforeCollapsed + 2, '页面与清单同时恢复：只换新一次'));
      await settle(response());
      await render(step('off'));

      writeCollapsed('sbx-initial', true);
      const beforeInitialCollapse = calls;
      await render(checklist('sbx-initial'));
      for (let i = 0; i < 3; i++) await advance(600_000);
      check(() => assert.equal(calls, beforeInitialCollapse, '初次挂载于已收起清单：不签码'));
      await click('展开', host);
      check(() => assert.equal(calls, beforeInitialCollapse + 1, '首次展开清单：只签一次码'));
      const lateHidden = respond;
      const hiddenSignal = requestSignal as AbortSignal | null;
      await visibility('hidden');
      check(() => assert.equal(hiddenSignal?.aborted, true, '隐藏页面：取消在途取码'));
      await act(async () => {
        lateHidden(response());
        await flush();
      });
      check(() => assert.equal(host.querySelector('.sandbox-qr'), null, '隐藏期间：不展示迟到响应的码'));
      await advance(1_800_000);
      check(() => assert.equal(calls, beforeInitialCollapse + 1, '暂停在途取码后：后台不发请求'));
      await visibility('visible');
      check(() => assert.equal(calls, beforeInitialCollapse + 2, '在途取码被暂停后恢复：只重取一次'));
      await settle(response());
      await render(step('off'));
      check(() => assert.equal(timers.size, 0, '卸载：暂停与换码定时器全部清理'));
      await render(step('bound'));
      const beforeRebind = calls;
      for (let i = 0; i < 2; i++) {
        await click('换一个微信', host);
        check(() => assert.equal(calls, beforeRebind + i + 1, '重复打开改绑：每次只签一次新码'));
        await settle(response());
        check(() => assert.ok(host.querySelector('.sandbox-qr'), '重复打开改绑：正常显示新码'));
        await click('收起二维码', host);
      }
      await render(step('off'));
      const css = fs.readFileSync(new URL('./sandbox.css', import.meta.url), 'utf8');
      check(() => assert.match(css, /@media \(max-width: 767px\)/));
      check(() => assert.match(css, /\.sandbox-qr\.is-wechat\s*\{\s*display: none/));
      check(() => assert.match(css, /\.sandbox-open-wechat\s*\{\s*display: none/));
    } finally {
      await render(step('off'));
      Date.now = nowBefore;
      globalThis.fetch = fetchBefore;
      globalThis.setTimeout = timeoutBefore;
      globalThis.clearTimeout = clearBefore;
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: uaBefore });
      if (visibilityBefore) Object.defineProperty(document, 'visibilityState', visibilityBefore);
      else Reflect.deleteProperty(document, 'visibilityState');
      endMemberSession();
    }
  }
} finally {
  await act(async () => root.unmount());
  host.remove();
  await win.happyDOM.abort();
}
console.log(`SELFTEST PASS: 沙箱 console ${checks} 项`);
