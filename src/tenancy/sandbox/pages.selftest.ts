// 验收 11、17：开通页的真实路由、CSP 与浏览器脚本状态；不依赖数据库或真实模型。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createTenantRuntime } from '../runtime.js';
import type { SandboxSession } from './session.js';
import { createHash } from 'node:crypto';
import { sandboxTryDesign, sandboxTryLinks } from './pages.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-pages-'));
process.env.VAR_DIR = temp;
const { sandboxApp } = await import('./process.js');
const { SandboxProvisionError } = await import('./provision.js');
const savedBase = process.env.PUBLIC_BASE_URL;
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}

function localResources(source: string, name: string): void {
  const origin = 'https://sandbox.example.invalid';
  for (const tag of source.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attr = new RegExp(
      `\\b${tag[1]!.toLowerCase() === 'script' ? 'src' : 'href'}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      'i',
    ).exec(tag[0]);
    if (!attr) continue;
    const value = attr[1] ?? attr[2] ?? attr[3]!;
    check(() => assert.ok(value.startsWith('data:') || new URL(value, origin).origin === origin, `${name}：script/link 资源只来自同源`));
  }
  check(() => assert.doesNotMatch(source, /@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//i, `${name}：没有外部 CSS @import`));
  check(() => assert.doesNotMatch(source, /url\(\s*["']?\s*(?:https?:)?\/\//i, `${name}：没有外部 CSS url`));
}

// 覆盖页面源文件及 console 实际构建入口、CSS；动态 /try 状态共用同一份页面。
for (const file of [
  'public/try.html',
  'public/chat.html',
  'public/pay.html',
  'public/proposal.html',
  'console/index.html',
  'console/dist/index.html',
]) {
  localResources(fs.readFileSync(file, 'utf8'), file);
}
for (const dir of ['console/dist/assets', 'public']) {
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    if (String(file).endsWith('.css')) localResources(fs.readFileSync(path.join(dir, String(file)), 'utf8'), String(file));
  }
}

class Element {
  hidden = false;
  disabled = false;
  textContent = '';
  style = { cssText: '' };
  id = '';
  attrs = new Map<string, string>();
  events = new Map<string, (event?: unknown) => Promise<void> | void>();
  children: Element[] = [];
  banner: Element | null = null;
  setAttribute(key: string, value: string) {
    this.attrs.set(key, value);
  }
  hasAttribute(key: string) {
    return this.attrs.has(key);
  }
  removeAttribute(key: string) {
    this.attrs.delete(key);
  }
  addEventListener(key: string, handler: (event?: unknown) => Promise<void> | void) {
    this.events.set(key, handler);
  }
  append(...elements: Element[]) {
    this.children.push(...elements);
  }
  before(element: Element) {
    this.banner = element;
  }
  querySelectorAll() {
    return [];
  }
}

function boot(html: string, fetch: (url: string, init: RequestInit) => Promise<Response>, search = '', visible = true) {
  const ids = new Map<string, Element>();
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    const href = /\bhref="([^"]*)"/.exec(tag[0]);
    if (href) element.setAttribute('href', href[1]!);
    element.hidden = /\bhidden\b/.test(tag[0]);
    ids.set(tag[1]!, element);
  }
  const assigned: string[] = [];
  const replaced: string[] = [];
  const events = new Map<string, () => void>();
  const timers = new Map<number, () => void>();
  const document = {
    getElementById: (id: string) => ids.get(id),
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
    removeEventListener: (name: string) => events.delete(name),
  };
  let timer = 0;
  vm.runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, {
    document,
    URLSearchParams,
    AbortController,
    history: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
    location: { pathname: '/try', search, hash: '', replace: (url: string) => assigned.push(url) },
    setTimeout: (handler: () => void) => {
      timers.set(++timer, handler);
      return timer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch,
  });
  return {
    ids,
    assigned,
    replaced,
    timers,
    visible: () => {
      document.visibilityState = 'visible';
      events.get('visibilitychange')?.();
    },
    click: () => ids.get('startBtn')!.events.get('click')!(),
  };
}

function cspMatches(response: Response, html: string): void {
  localResources(html, '/try 各状态');
  const policy = response.headers.get('content-security-policy')!;
  check(() => assert.ok(policy));
  const scripts = /(?:^|; )script-src ([^;]*)/.exec(policy)![1]!.split(' ');
  const wanted = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`,
  );
  check(() => assert.deepEqual(scripts, ["'self'", ...wanted]));
  check(() => assert.match(policy, /script-src-attr 'none'/));
  check(() => assert.match(policy, /object-src 'none'; base-uri 'none'; frame-ancestors 'none'/));
  check(() => assert.equal((html.match(/<script src="\/sandbox-ui\.js"><\/script>/g) ?? []).length, 1));
}

try {
  let provisions = 0;
  let failure: 'limited' | 'unavailable' = 'limited';
  let scope: 'pool' | 'ip' = 'pool';
  let session: SandboxSession = { status: 'invalid' };
  const service = {
    health: () => {
      throw new Error('unused');
    },
    resolve: async () => session,
    provision: async () => {
      provisions++;
      throw failure === 'limited'
        ? new SandboxProvisionError(429, 'sandbox_limited', 7200, undefined, scope)
        : new SandboxProvisionError(503, 'sandbox_unavailable');
    },
    end: async () => {},
  };
  const fetchFrom =
    (app: ReturnType<typeof sandboxApp>) =>
    async (url: string, init: RequestInit = {}) =>
      app.request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), host: 'sandbox.example.invalid' } });

  delete process.env.PUBLIC_BASE_URL;
  const missingApp = sandboxApp(service, 'sandbox.example.invalid');
  const missingResponse = await fetchFrom(missingApp)('/try');
  const missing = await missingResponse.text();
  cspMatches(missingResponse, missing);
  const missingPage = boot(missing, fetchFrom(missingApp));
  check(() => assert.equal(missingPage.ids.get('hostConsole')!.hidden, true));
  check(() => assert.equal(missingPage.ids.get('hostChat')!.hidden, true));
  check(() => assert.equal(provisions, 0, 'GET 与页面初始化都不能开通'));
  const ui = await fetchFrom(missingApp)('/sandbox-ui.js');
  check(() => assert.equal(ui.status, 200));
  check(() => assert.match(ui.headers.get('content-type')!, /javascript/));
  const uiSource = await ui.text();
  check(() => assert.equal(uiSource, fs.readFileSync('public/sandbox-ui.js', 'utf8')));
  for (const wechat of ['off', 'full', 'unbound', 'bound']) {
    const messages = new Element();
    const footer = new Element();
    const close = new Element();
    close.setAttribute('onclick', 'closeWebview()');
    let closed = 0;
    let prevented = 0;
    vm.runInNewContext(uiSource, {
      document: {
        getElementById: (id: string) => (id === 'msgs' ? messages : null),
        querySelector: (selector: string) => (selector === '.foot' ? footer : null),
        querySelectorAll: () => [close],
        createElement: () => new Element(),
        createElementNS: () => new Element(),
      },
      window: { closeWebview: () => closed++ },
      MutationObserver: class {
        observe() {}
      },
      fetch: async () => Response.json({ sandbox: { wechat, expiresAt: new Date(Date.now() + 3600000).toISOString() } }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    check(() => assert.match(messages.banner!.children[1]!.children[0]!.textContent, /体验环境 · 你在扮演客户/));
    check(() =>
      assert.equal(
        messages.banner!.children[1]!.children[1]!.textContent,
        '对话会出现在你的工作台里，不会发到任何微信；体验结束后一起删除',
      ),
    );
    check(() => assert.equal(footer.hidden, true));
    check(() => assert.equal(messages.banner!.children[2]!.attrs.get('href'), '/console/'));
    await close.events.get('click')!({ preventDefault: () => prevented++ });
    check(() => assert.equal(closed, 1));
    check(() => assert.equal(prevented, 1));
    check(() => assert.equal(close.hasAttribute('onclick'), false));
    check(() => assert.equal(close.attrs.get('href'), '#'));
  }
  // 支付等没有聊天区域的沙箱页面不隐藏页脚。
  const otherFooter = new Element();
  vm.runInNewContext(uiSource, {
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => otherFooter,
    },
  });
  check(() => assert.equal(otherFooter.hidden, false));

  process.env.PUBLIC_BASE_URL = 'https://host.example.invalid/';
  const app = sandboxApp(service, 'sandbox.example.invalid');
  const fetch = fetchFrom(app);
  const response = await fetch('/try?ended=1');
  const html = await response.text();
  cspMatches(response, html);
  check(() => assert.match(html, /\.try-start:disabled[^}]+background:var\(--primary\)/));
  check(() => assert.doesNotMatch(html, /\.try-start:disabled[^}]+opacity/));
  check(() => assert.match(html, /\.try-icon[^}]+width:16px; height:16px/));
  check(() => assert.match(html, /aria-busy="false"[\s\S]*?try-spinner/));
  check(() => assert.match(html, /\.try-start\[aria-busy="true"\] \.try-spinner[^}]+animation:try-spin/));
  for (const name of ['clock', 'lock', 'info', 'layout-dashboard', 'message-square', 'chevron-right', 'arrow-up-right']) {
    check(() => assert.match(html, new RegExp(`class="try-icon ${name}"`)));
  }
  check(() => assert.match(html, /\.try-fallback strong[^}]+500 14px\/22px/));
  check(() => assert.match(html, /#notes[^}]+border-top:1px solid var\(--divider\)/));
  check(() => assert.doesNotMatch(html, /\.try-steps[^}]+border-top/));
  check(() => assert.match(html, /id="dataWarning">别填真实的姓名和手机号 · <\/span><a/));
  check(() => assert.match(html, /一份只属于你的示例后台，<br class="try-lead-break">带示例会话、订单和产品。/));
  check(() => assert.match(html, /工作台只能在这个浏览器里打开；扫码绑定后，微信里的回复只发到你自己的微信/));
  check(() => assert.match(html, /之后在微信里再发消息，只会收到「去开一个新体验」的提示/));

  check(() => assert.equal(response.status, 200));
  check(() => assert.equal(provisions, 0));
  const page = boot(html, fetch, '?ended=1');
  check(() => assert.equal(page.ids.get('tryLead')!.textContent, '上一次体验已结束，里面的数据会全部删除。想再看一遍，可以重新开一个。'));
  check(() => assert.equal(page.ids.get('ended')!.hidden, false));
  check(() => assert.equal(page.ids.get('hostConsole')!.attrs.get('href'), 'https://host.example.invalid/console/?view=demo'));
  check(() => assert.equal(page.ids.get('hostChat')!.attrs.get('href'), 'https://host.example.invalid/chat.html'));
  check(() => assert.equal(page.ids.get('hostConsole')!.hidden, false));
  check(() => assert.equal(page.ids.get('hostChat')!.hidden, false));
  check(() => assert.equal(page.ids.get('fallbackUnavailable')!.hidden, true));
  const dataToggle = page.ids.get('dataToggle')!;
  await dataToggle.events.get('click')!({ preventDefault: () => {} });
  check(() => assert.equal(page.ids.get('tryData')!.hidden, false));
  check(() => assert.equal(dataToggle.attrs.get('aria-expanded'), 'true'));
  await dataToggle.events.get('click')!({ preventDefault: () => {} });
  check(() => assert.equal(page.ids.get('tryData')!.hidden, true));
  const attempt = page.click();
  check(() => assert.equal(page.ids.get('startBtn')!.disabled, true));
  check(() => assert.equal(page.ids.get('startBtn')!.attrs.get('aria-busy'), 'true'));
  check(() => assert.match(page.ids.get('startLabel')!.textContent, /正在准备/));
  await page.click();
  await attempt;
  check(() => assert.equal(provisions, 1, '重复点击只发一次 POST'));
  check(() => assert.equal(page.ids.get('fallback')!.hidden, false));
  check(() => assert.match(page.ids.get('tryTitle')!.textContent, /暂时没有空余的体验名额/));
  check(() => assert.match(page.ids.get('tryLead')!.textContent, /约2小时后再试/));
  check(() => assert.equal(page.ids.get('startLabel')!.textContent, '重试'));
  check(() => assert.equal(page.ids.get('startBtn')!.disabled, false));
  check(() => assert.equal(page.ids.get('startBtn')!.attrs.get('aria-busy'), 'false'));
  check(() => assert.equal(page.ids.get('dataNote')!.hidden, true));
  check(() => assert.equal(page.ids.get('tryData')!.hidden, true));
  const minutePage = boot(html, async () => Response.json({ error: 'sandbox_limited', scope: 'pool', retryAfter: 120 }, { status: 429 }));
  await minutePage.click();
  check(() => assert.equal(minutePage.ids.get('tryTitle')!.textContent, '暂时没有空余的体验名额'));
  check(() => assert.equal(minutePage.ids.get('tryLead')!.textContent, '体验环境的名额有限，约2分钟后再试。先看看这些：'));
  failure = 'unavailable';
  await page.click();
  check(() => assert.equal(provisions, 2));
  check(() => assert.match(page.ids.get('statusMessage')!.textContent, /暂时无法开通/));
  check(() => assert.equal(page.ids.get('fallback')!.hidden, true));
  check(() => assert.deepEqual(page.assigned, []));

  for (const result of [new Error('offline'), new Response('not JSON'), Response.json({ url: 'https://other.example.invalid/' })]) {
    const errorPage = boot(html, async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    await errorPage.click();
    check(() => assert.match(errorPage.ids.get('statusMessage')!.textContent, /暂时无法开通/));
    check(() => assert.equal(errorPage.ids.get('startBtn')!.disabled, false));
    check(() => assert.deepEqual(errorPage.assigned, []));
  }
  for (const status of [200, 201]) {
    const success = boot(html, async (_url, init) => {
      check(() => assert.equal(init.method, 'POST'));
      check(() => assert.equal(new Headers(init.headers).get('content-type'), 'application/json'));
      check(() => assert.equal(init.body, '{}'));
      return Response.json({ url: '/console/' }, { status });
    });
    await success.click();
    check(() => assert.deepEqual(success.assigned, ['/console/']));
    check(() => assert.equal(success.ids.get('startBtn')!.disabled, true));
    check(() => assert.equal(success.ids.get('ended')!.hidden, true));
  }
  // 自动开通须先清 start、等待可见，再 POST；直接访问与 ended 永远不自动。
  let autoCalls = 0;
  const autoPage = boot(
    html,
    async () => {
      autoCalls++;
      return Response.json({ url: '/console/' });
    },
    '?start=1&keep=2',
    false,
  );
  check(() => assert.deepEqual(autoPage.replaced, ['/try?keep=2']));
  check(() => assert.equal(autoCalls, 0));
  autoPage.visible();
  await new Promise((r) => setImmediate(r));
  check(() => assert.equal(autoCalls, 1));
  check(() => assert.deepEqual(autoPage.assigned, ['/console/']));
  autoPage.visible();
  check(() => assert.equal(autoCalls, 1));
  for (const query of ['', '?ended=1', '?ended=1&start=1']) {
    boot(
      html,
      async () => {
        throw new Error('不得自动POST');
      },
      query,
    );
  }
  const immediate = boot(
    html,
    async () => {
      autoCalls++;
      return Response.json({ url: '/console/' });
    },
    '?start=1',
  );
  await new Promise((r) => setImmediate(r));
  check(() => assert.equal(autoCalls, 2));
  check(() => assert.deepEqual(immediate.replaced, ['/try']));
  let resolveSlow!: (res: Response) => void;
  const slowPage = boot(
    html,
    async () =>
      new Promise<Response>((r) => {
        resolveSlow = r;
      }),
    '?start=1',
  );
  slowPage.timers.get(1)!();
  check(() => assert.equal(slowPage.ids.get('tryLead')!.textContent, '比平时慢一点，再等等'));
  resolveSlow(Response.json({ url: '/console/' }));
  await new Promise((r) => setImmediate(r));
  check(() => assert.equal(slowPage.timers.size, 0));
  failure = 'limited';
  scope = 'ip';
  const ipPage = boot(html, fetch);
  await ipPage.click();
  check(() => assert.equal(ipPage.ids.get('tryTitle')!.textContent, '这个网络今天开得有点多了'));
  check(() => assert.match(ipPage.ids.get('tryLead')!.textContent, /过一会儿再试/));
  check(() => assert.equal(ipPage.ids.get('fallback')!.hidden, false));
  check(() => assert.equal(ipPage.ids.get('dataNote')!.hidden, true));
  check(() => assert.equal(ipPage.ids.get('tryData')!.hidden, true));
  check(() => assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow'));
  const robots = await fetch('/robots.txt');
  const robotText = await robots.text();
  check(() => assert.equal(robotText, 'User-agent: *\nDisallow: /\n'));
  for (const url of ['/login-showcase.png', '/sandbox-ui.js', '/missing', '/api/sandbox/end']) {
    const res = await fetch(url);
    check(() => assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow'));
  }
  check(() => assert.match(html, /<meta name="robots" content="noindex">/));
  check(() => assert.match(html, /href="\/console\/assets\/[^" ]+\.css"/));
  check(() => assert.match(html, /src="\/login-showcase.png"/));
  check(() => assert.match(html, /本地7天、异地30天/));
  check(() => assert.match(html, /对话内容会发送给大模型服务商，用于生成AI回复。/));
  check(() => assert.match(html, /体验结束后，这份环境及其会话、订单、配置和微信绑定将整体删除。/));
  check(() => assert.match(html, /企业微信服务器上的聊天记录按企业微信的规则保存，不随这次体验一起删除。/));
  check(() => assert.equal(ipPage.ids.get('hostLogin')!.attrs.get('href'), 'https://host.example.invalid/console/'));
  const runtime = createTenantRuntime({ id: 'try-visitor', slug: 'sbx-try', kind: 'sandbox' });
  session = {
    status: 'ok',
    token: 'fixture',
    runtime,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    user: { userId: 'visitor', tenantId: runtime.id, role: 'owner', displayName: '体验访客', csrf: 'fixture' },
  };
  for (const query of ['', '?start=1', '?ended=1']) {
    const res = await fetch('/try' + query);
    check(() => assert.equal(res.status, 302));
    check(() => assert.equal(res.headers.get('location'), '/console/'));
  }
  session = { status: 'invalid' };
  check(() =>
    assert.equal(
      sandboxTryDesign('<!-- console styles -->', '<link rel="stylesheet" href="/console/assets/test.css">'),
      '<link rel="stylesheet" href="/console/assets/test.css">',
    ),
  );
  const head = await fetch('/try', { method: 'HEAD' });
  check(() => assert.equal(head.status, 200));
  const headBody = await head.text();
  check(() => assert.equal(headBody, ''));
  check(() => assert.equal(head.headers.get('content-security-policy'), response.headers.get('content-security-policy')));
  for (const base of ['', 'javascript:alert(1)', 'https://host.example.invalid/?q=1']) {
    check(() => assert.equal(sandboxTryLinks(missing, base), missing));
  }
  // 宿主经过真实共用路由，既不加载沙箱脚本，也不接沙箱 CSP。
  process.env.SERVER_SELFTEST = '1';
  process.env.CONFIG_SOURCE = 'file';
  const { app: hostRoutes } = await import('../../server.js');
  for (const url of ['/chat.html', '/pay/test', '/pay.html', '/proposal/r-xian/2', '/proposal.html']) {
    const hostResponse = await hostRoutes.request(url);
    check(() => assert.equal(hostResponse.status, 200));
    check(() => assert.equal(hostResponse.headers.get('content-security-policy'), null));
    const body = await hostResponse.text();
    check(() => assert.equal(body.includes('<script src="/sandbox-ui.js">'), false));
    if (url === '/chat.html') {
      check(() => assert.equal(body, fs.readFileSync('public/chat.html', 'utf8')));
      check(() => assert.match(body, /演示：模拟企业微信里的客户对话。/));
      check(() => assert.match(body, /需要真人服务时，回复「人工」即可转真人顾问。/));
    }
  }
} finally {
  if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = savedBase;
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`SELFTEST PASS: 沙箱页面 ${checks} 项`);
