// 验收 11、17：开通页的真实路由、CSP 与浏览器脚本状态；不依赖数据库或真实模型。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { sandboxTryLinks } from './pages.js';

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
}

function boot(html: string, fetch: (url: string, init: RequestInit) => Promise<Response>, ended = false) {
  const ids = new Map<string, Element>();
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    const href = /\bhref="([^"]*)"/.exec(tag[0]);
    if (href) element.setAttribute('href', href[1]!);
    element.hidden = /\bhidden\b/.test(tag[0]);
    ids.set(tag[1]!, element);
  }
  const assigned: string[] = [];
  vm.runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, {
    document: { getElementById: (id: string) => ids.get(id) },
    URLSearchParams,
    location: { search: ended ? '?ended=1' : '', assign: (url: string) => assigned.push(url) },
    fetch,
  });
  return { ids, assigned, click: () => ids.get('startBtn')!.events.get('click')!() };
}

function cspMatches(response: Response, html: string): void {
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
  const service = {
    health: () => {
      throw new Error('unused');
    },
    resolve: async () => ({ status: 'invalid' as const }),
    provision: async () => {
      provisions++;
      throw failure === 'limited'
        ? new SandboxProvisionError(429, 'sandbox_limited', 60)
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
    const close = new Element();
    close.setAttribute('onclick', 'closeWebview()');
    let closed = 0;
    let prevented = 0;
    vm.runInNewContext(uiSource, {
      document: {
        getElementById: () => messages,
        querySelectorAll: () => [close],
        createElement: () => new Element(),
      },
      window: { closeWebview: () => closed++ },
      fetch: async () => Response.json({ sandbox: { wechat, expiresAt: new Date(Date.now() + 3600000).toISOString() } }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    check(() => assert.match(messages.banner!.children[0]!.textContent, /剩余 1 小时/));
    check(() => assert.match(messages.banner!.children[0]!.textContent, wechat === 'off' ? /只进模拟器/ : /回复只发到你自己的微信/));
    check(() => assert.match(messages.banner!.children[1]!.textContent, /本地 7 天、异地 30 天/));
    await close.events.get('click')!({ preventDefault: () => prevented++ });
    check(() => assert.equal(closed, 1));
    check(() => assert.equal(prevented, 1));
    check(() => assert.equal(close.hasAttribute('onclick'), false));
    check(() => assert.equal(close.attrs.get('href'), '#'));
  }

  process.env.PUBLIC_BASE_URL = 'https://host.example.invalid/';
  const app = sandboxApp(service, 'sandbox.example.invalid');
  const fetch = fetchFrom(app);
  const response = await fetch('/try?ended=1');
  const html = await response.text();
  cspMatches(response, html);
  check(() => assert.equal(response.status, 200));
  check(() => assert.equal(provisions, 0));
  const page = boot(html, fetch, true);
  check(() => assert.equal(page.ids.get('ended')!.hidden, false));
  check(() => assert.equal(page.ids.get('hostConsole')!.attrs.get('href'), 'https://host.example.invalid/console/'));
  check(() => assert.equal(page.ids.get('hostChat')!.attrs.get('href'), 'https://host.example.invalid/chat.html'));
  check(() => assert.equal(page.ids.get('hostConsole')!.hidden, false));
  check(() => assert.equal(page.ids.get('hostChat')!.hidden, false));
  check(() => assert.equal(page.ids.get('fallbackUnavailable')!.hidden, true));
  const attempt = page.click();
  check(() => assert.equal(page.ids.get('startBtn')!.disabled, true));
  check(() => assert.match(page.ids.get('status')!.textContent, /正在准备/));
  await page.click();
  await attempt;
  check(() => assert.equal(provisions, 1, '重复点击只发一次 POST'));
  check(() => assert.equal(page.ids.get('fallback')!.hidden, false));
  check(() => assert.match(page.ids.get('status')!.textContent, /名额或开通额度/));
  check(() => assert.equal(page.ids.get('startBtn')!.textContent, '重试'));
  check(() => assert.equal(page.ids.get('startBtn')!.disabled, false));
  failure = 'unavailable';
  await page.click();
  check(() => assert.equal(provisions, 2));
  check(() => assert.match(page.ids.get('status')!.textContent, /暂时无法开通/));
  check(() => assert.equal(page.ids.get('fallback')!.hidden, true));
  check(() => assert.deepEqual(page.assigned, []));

  for (const result of [new Error('offline'), new Response('not JSON'), Response.json({ url: 'https://other.example.invalid/' })]) {
    const errorPage = boot(html, async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    await errorPage.click();
    check(() => assert.match(errorPage.ids.get('status')!.textContent, /暂时无法开通/));
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
    if (url === '/chat.html') check(() => assert.equal(body, fs.readFileSync('public/chat.html', 'utf8')));
  }
} finally {
  if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = savedBase;
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`SELFTEST PASS: 沙箱页面 ${checks} 项`);
