// 登录页的自测（console UX spec「登录」「外壳 · 启动」、错误文案表，plan 第 15 步）。在 happy-dom 里挂真的 Shell（登录与否由它判断），
// 加照服务端规则的假接口：/me、/pack 按 prod、demo 与是否登录回 200 或 401，登录接口可以指定回什么。
// 1. prod（/me、/pack 都 401）：一栏的登录页，标题「运营后台」与一句说明；「邮箱」「密码」两个标签连着各自的输入框、不加冒号，
//    全页没有「口令」；邮箱的占位符以「例：」开头；焦点在邮箱上；没有外壳，也没有「返回演示」；标签页标题「登录」。
// 2. 没填就提交：不发请求，控件下方写「没填邮箱」「没填密码」，aria-invalid、aria-describedby 连上，焦点到第一个没填的；
//    填上一个，它的原因就消失。
// 3. 服务端的错：401 invalid_credentials、429 busy 与 rate_limited、连不上，都在按钮上方的页内 Alert 里，文案取 ERROR_COPY，
//    detail 不上页面（只在折叠的技术详情里），不弹 toast；只留一条 Alert。
// 4. 提交中：按钮 loading，这时再提交不发第二个请求；上一条错误先收起。
// 5. 登录成功：请求体是输入的邮箱与密码，之后重新判断来者、进成员外壳，地址不变。
// 6. demo：从匿名外壳侧栏的「登录」和横幅的「登录后编辑」进来，表单下方有「返回演示」，它是指向当前地址（带 /console 与 search）的
//    链接，标签页标题「登录 · 演示」；左键点它回到匿名外壳，地址不变，不重新取 /me、/pack，焦点到内容面板；带修饰键点不拦。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/pages/login.selftest.tsx
import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import { register } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Me } from '../../../src/shared/console-api.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { ToastHost } from '../parts/toast.js';
import { endMemberSession } from '../session.js';
import { PageHeader } from '../shell/PageHeader.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { toLogin, type Viewer } from '../viewer.js';

// Shell 经「关于」弹窗在模块顶层读 import.meta.env.BASE_URL（vite 构建时替换），Node 里没有 import.meta.env。
// 在 tsx 转好的源码上把它换成构建时的值；钩子只对之后才载入的模块生效，所以 Shell 用动态 import
const VITE_ENV_HOOK = `export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!url.includes('/console/src/') || r.source == null) return r;
  const s = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
  return s.includes('import.meta.env') ? { ...r, source: s.replaceAll('import.meta.env', '({ BASE_URL: "/console/" })') } : r;
}`;
register(`data:text/javascript,${encodeURIComponent(VITE_ENV_HOOK)}`);
const { NotFound, Shell } = await import('../shell/Shell.js');

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

// ---------------- 夹具 ----------------

const entity = (kind: string, label: string): EntityType => ({
  kind,
  label,
  icon: 'box',
  codeLabel: `${label}编号`,
  codeExample: 'x-1',
  titleKey: 'title',
  subtitleKeys: [],
  groups: [{ key: 'basic', label: '基本信息' }],
  lockGroups: {},
  fields: [{ key: '$code', type: 'text', label: `${label}编号`, group: 'basic' }],
  list: { columns: [], filters: [], search: [], defaultSort: '-$updated' },
  csvImport: false,
  activateLine: '',
});
const PACK: IndustryPack = {
  id: 'fixture',
  name: '夹具',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: {}, sopFields: {} },
  entities: [entity('route', '线路')],
  stages: [
    { key: 'discovery', label: '问需' },
    { key: 'paid', label: '已支付', terminal: true },
  ],
  sopSections: [{ key: 'preamble', heading: null, locked: false }],
  nav: { catalogGroup: '产品库', entities: ['route'] },
};
const EMAIL = 'boss@yuntu.test';
const PASSWORD = 'correct horse battery';
const ME: Me = { userId: 'u1', displayName: '老板', role: 'owner', csrf: 'c1', tenantSlug: 'yuntu', tenantName: '云途定制旅行' };
const BUSY_DETAIL = '密码校验排队超时，请稍后再试';

// ---------------- 假接口 ----------------

/** 登录接口回什么：照服务端核对邮箱与密码；或者指定状态与响应体、连不上、一直不回（手动放行） */
type LoginMode = 'check' | 'network' | 'hang' | { status: number; body: unknown };
interface Server {
  demo: boolean;
  loggedIn: boolean;
  login: LoginMode;
}
let server: Server = { demo: false, loggedIn: false, login: 'check' };
let requests: string[] = [];
let loginBodies: unknown[] = [];
let release: (() => void) | null = null;

const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = (): Response => json(401, { error: 'unauthorized', detail: '要先登录' });

function checkLogin(body: { email?: string; password?: string }): Response {
  if (body.email?.trim().toLowerCase() === EMAIL && body.password === PASSWORD) {
    server.loggedIn = true;
    return json(200, ME);
  }
  return json(401, { error: 'invalid_credentials', detail: '邮箱或密码不对' });
}

async function respond(method: string, url: URL, body: unknown): Promise<Response> {
  const p = url.pathname.replace(/^\/api\/console/, '');
  if (method === 'GET' && p === '/me') return server.loggedIn ? json(200, ME) : unauthorized();
  if (method === 'GET' && p === '/pack') return server.loggedIn || server.demo ? json(200, PACK) : unauthorized();
  if (method === 'POST' && p === '/auth/login') {
    const mode = server.login;
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'hang') {
      await new Promise<void>((res) => (release = res));
      return json(401, { error: 'invalid_credentials', detail: '邮箱或密码不对' });
    }
    if (mode === 'check') return checkLogin(body as { email?: string; password?: string });
    return json(mode.status, mode.body);
  }
  if (method === 'GET' && p.startsWith('/catalog/')) return json(200, { items: [] });
  if (method === 'GET' && p === '/conversations/counts')
    return json(200, { total: 0, byState: { ai: 0, human: 0, paid: 0 }, aiByStage: {}, updatedToday: 0 });
  if (method === 'GET' && p === '/conversations') return json(200, { items: [], total: 0 });
  return json(404, { error: 'not_found' });
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url.pathname}`);
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
  if (method === 'POST' && url.pathname.endsWith('/auth/login')) loginBodies.push(body);
  return respond(method, url, body);
}) as typeof fetch;
const count = (r: string): number => requests.filter((x) => x === r).length;

// ---------------- 挂载 ----------------

async function settle(qc: QueryClient): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0 && qc.isMutating() === 0) break;
  }
}

/** 像敲字一样改输入框：走原型上的 value setter（React 盯着实例上的那个），再发 input 事件 */
function setValue(el: HTMLInputElement, text: string): void {
  let proto: object | null = Object.getPrototypeOf(el);
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
  desc?.set?.call(el, text);
  el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
}

/** 挂上真的 Shell：/catalog/$kind 是一页只有页头的空页（匿名时页头下挂横幅，「登录后编辑」在横幅里） */
async function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/catalog/$kind',
    component: () => createElement(PageHeader, { title: '测试页' }),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    basepath: '/console',
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  // 与 main.tsx 同样的外层：主题（按钮不在两个汉字之间插空格）、App（toast 的宿主）
  await act(async () =>
    r.render(
      createElement(
        ThemeProvider,
        { locale: zhCN },
        createElement(
          AntApp,
          null,
          createElement(ToastHost),
          createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never })),
        ),
      ),
    ),
  );
  await settle(qc);
  const $ = <E extends Element = HTMLElement>(sel: string): E | null => box.querySelector<E>(sel);
  const $$ = (sel: string): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(sel)];
  const text = (e: Element | null | undefined): string => (e?.textContent ?? '').trim();
  const email = (): HTMLInputElement | null => {
    const id = $$('.login-label')[0]?.getAttribute('for');
    return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
  };
  const password = (): HTMLInputElement | null => {
    const id = $$('.login-label')[1]?.getAttribute('for');
    return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
  };
  return {
    qc,
    router,
    box,
    $,
    $$,
    text,
    email,
    password,
    /** 页上的 Alert：[标题, 整块文字] */
    alerts: (): string[] => $$('.login-form .ant-alert').map((a) => text(a.querySelector('.ant-alert-title'))),
    fieldErrors: (): string[] => $$('.login-field-error').map(text),
    /** 默认看得见的字：去掉折叠的技术详情（<details>）里的 */
    visibleText(): string {
      const copy = box.cloneNode(true) as HTMLElement;
      for (const d of Array.from(copy.querySelectorAll('details'))) d.remove();
      return copy.textContent ?? '';
    },
    url: (): string => router.state.location.href,
    async type(el: HTMLInputElement | null, value: string) {
      if (!el) throw new Error('输入框不在页面上');
      await act(async () => setValue(el, value));
    },
    /** 点「登录」按钮（走表单的 submit） */
    async submit() {
      const btn = $<HTMLButtonElement>('.login-submit');
      if (!btn) throw new Error('「登录」按钮不在页面上');
      await act(async () => btn.click());
      await settle(qc);
    },
    async click(el: Element | null | undefined) {
      if (!el) throw new Error('要点的元素不在页面上');
      await act(async () => (el as HTMLElement).click());
      await settle(qc);
    },
    async unmount() {
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
      for (const n of Array.from(document.body.children)) if (n !== box) n.remove();
      endMemberSession();
    },
  };
}

// ---------------- 0. 去登录页的视图 ----------------

{
  const anon: Viewer = { kind: 'anon', pack: PACK };
  eq('toLogin：从 demo 匿名来的带着原来的匿名视图', toLogin(anon), { kind: 'login', demo: anon });
  eq(
    'toLogin：别的来处不带（没有「返回演示」）',
    [toLogin(undefined), toLogin({ kind: 'member', me: ME, pack: PACK })],
    [{ kind: 'login' }, { kind: 'login' }],
  );
}

// ---------------- 1–5. prod ----------------

{
  server = { demo: false, loggedIn: false, login: 'check' };
  requests = [];
  loginBodies = [];
  const m = await mount('/console/catalog/route?status=draft');

  // 1. 版式与文案
  eq('prod：启动只取 /me、/pack 各一次', [count('GET /api/console/me'), count('GET /api/console/pack')], [1, 1]);
  check('prod：是登录页，没有外壳（侧栏）', m.$('.login-page') !== null && document.querySelector('.sidebar') === null);
  eq('prod：main 地标里只有一栏，h1 是「运营后台」', [m.$$('main').length, m.$$('h1').map(m.text)], [1, ['运营后台']]);
  check('prod：h1 用登录页的 display 样式', m.$('h1')?.className === 'login-title');
  eq(
    'prod：一句说明（中文与字母之间不打空格）',
    m.text(m.$('.login-lead')),
    '在这里维护销售话术和产品库，企业微信里的AI销售按它们接待客户',
  );
  eq('prod：两个标签「邮箱」「密码」，不加冒号', m.$$('.login-label').map(m.text), ['邮箱', '密码']);
  check('prod：标签连着各自的输入框', m.email()?.tagName === 'INPUT' && m.password()?.tagName === 'INPUT');
  eq(
    'prod：邮箱框的类型、自动填充与占位符（只放示例，以「例：」开头），密码框是 password',
    [m.email()?.type, m.email()?.autocomplete, m.email()?.placeholder.startsWith('例：'), m.password()?.type, m.password()?.autocomplete],
    ['email', 'username', true, 'password', 'current-password'],
  );
  check('prod：全页没有「口令」', !m.box.textContent!.includes('口令'), m.box.textContent ?? '');
  check('prod：焦点在邮箱上', document.activeElement === m.email());
  check('prod：没有「返回演示」', m.$('.login-back') === null && !m.box.textContent!.includes('返回演示'));
  eq('prod：标签页标题', document.title, '登录');
  eq(
    'prod：按钮只有一个主按钮「登录」，占满一栏',
    [m.$$('button[type="submit"]').map(m.text), m.$('.login-submit')?.classList.contains('ant-btn-block')],
    [['登录'], true],
  );

  // 2. 没填就提交
  requests = [];
  await m.submit();
  eq('没填：不发请求', requests, []);
  eq('没填：两个控件下方就地写原因', m.fieldErrors(), ['没填邮箱', '没填密码']);
  const describedBy = (el: HTMLInputElement | null): string =>
    m.text(document.getElementById(el?.getAttribute('aria-describedby') ?? '') ?? null);
  eq(
    '没填：aria-invalid 与 aria-describedby 连着原因',
    [
      m.email()?.getAttribute('aria-invalid'),
      describedBy(m.email()),
      m.password()?.getAttribute('aria-invalid'),
      describedBy(m.password()),
    ],
    ['true', '没填邮箱', 'true', '没填密码'],
  );
  check('没填：输入框画成出错的样子', m.email()?.classList.contains('ant-input-status-error') === true);
  check('没填：焦点到第一个没填的（邮箱）', document.activeElement === m.email());
  check('没填：页上没有 Alert（原因写在控件下方）', m.alerts().length === 0);
  await m.type(m.email(), `  ${EMAIL.toUpperCase()}`);
  eq('填上邮箱：它的原因就消失，密码的还在', m.fieldErrors(), ['没填密码']);
  check('填上邮箱：不再标出错', m.email()?.getAttribute('aria-invalid') === null);
  await m.submit();
  eq('只差密码：仍不发请求，焦点到密码', [requests, document.activeElement === m.password()], [[], true]);
  await m.type(m.email(), '   ');
  eq('邮箱只有空格也算没填', m.fieldErrors(), ['没填邮箱', '没填密码']);
  await m.type(m.email(), EMAIL);

  // 3. 服务端的错
  await m.type(m.password(), 'wrong-password');
  requests = [];
  loginBodies = [];
  await m.submit();
  eq(
    '密码不对：发了一次登录，请求体是输入的邮箱与密码',
    [count('POST /api/console/auth/login'), loginBodies],
    [1, [{ email: EMAIL, password: 'wrong-password' }]],
  );
  const onlyAlert = (name: string, want: string[]): void => {
    const alerts = m.$$('.login-form .ant-alert');
    const btn = m.$('.login-submit');
    eq(`${name}：一条 Alert，文案取 ERROR_COPY`, [alerts.length, want.every((w) => m.alerts()[0]?.includes(w))], [1, true]);
    check(
      `${name}：Alert 在表单里、按钮上方`,
      alerts[0] !== undefined &&
        btn !== null &&
        (alerts[0].compareDocumentPosition(btn) & 4) !== 0 &&
        alerts[0].closest('form') === btn.closest('form'),
    );
    check(`${name}：是出错色的 Alert`, alerts[0]?.classList.contains('ant-alert-error') === true);
    check(`${name}：不弹 toast`, document.querySelector('.ant-message-notice') === null);
    check(`${name}：还在登录页`, m.$('.login-page') !== null && document.querySelector('.sidebar') === null);
  };
  onlyAlert('密码不对', ['邮箱或密码不对', '检查后重试']);
  check('密码不对：没有控件下方的原因', m.fieldErrors().length === 0);

  server.login = { status: 429, body: { error: 'busy', detail: BUSY_DETAIL } };
  await m.submit();
  onlyAlert('排队超时（429 busy）', ['尝试太频繁', '稍后再试']);
  check(
    '排队超时：服务端的 detail 只在技术详情里',
    m.box.textContent!.includes(BUSY_DETAIL) && !m.visibleText().includes('排队超时'),
    m.visibleText(),
  );
  eq(
    '排队超时：技术详情在 Alert 里，默认折叠',
    m.$$('details').map((d) => [d.closest('.ant-alert') !== null, d.hasAttribute('open')]),
    [[true, false]],
  );

  server.login = { status: 429, body: { error: 'rate_limited', detail: '登录太频繁，稍后再试' } };
  await m.submit();
  onlyAlert('被限流（429 rate_limited）', ['尝试太频繁', '稍后再试']);
  check('被限流：detail 只在技术详情里', m.box.textContent!.includes('登录太频繁') && !m.visibleText().includes('登录太频繁'));

  server.login = 'network';
  await m.submit();
  onlyAlert('连不上', ['服务暂时连不上']);

  // 4. 提交中
  server.login = 'hang';
  requests = [];
  const btn = m.$('.login-submit');
  await act(async () => btn!.click());
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
  eq('提交中：按钮 loading，上一条错误先收起', [m.$('.login-submit')?.classList.contains('ant-btn-loading'), m.alerts().length], [true, 0]);
  const form = m.$<HTMLFormElement>('.login-form');
  await act(async () => {
    form!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
  });
  eq('提交中：再按回车也不发第二个请求', count('POST /api/console/auth/login'), 1);
  await act(async () => release?.());
  await settle(m.qc);
  eq('回来以后：loading 收起，错误就地显示', [m.$('.login-submit')?.classList.contains('ant-btn-loading'), m.alerts().length], [false, 1]);

  // 5. 登录成功
  server.login = 'check';
  await m.type(m.password(), PASSWORD);
  requests = [];
  loginBodies = [];
  await m.submit();
  eq('登录成功：请求体', loginBodies, [{ email: EMAIL, password: PASSWORD }]);
  eq('登录成功：重新判断来者（/me、/pack 各取一次）', [count('GET /api/console/me'), count('GET /api/console/pack')], [1, 1]);
  check('登录成功：进成员外壳，登录页没了', document.querySelector('.sidebar') !== null && m.$('.login-page') === null);
  eq('登录成功：地址不变', m.url(), '/catalog/route?status=draft');
  eq('登录成功：页头是这一页的', m.text(m.$('h1')), '测试页');
  await m.unmount();
}

// ---------------- 6. demo ----------------

{
  server = { demo: true, loggedIn: false, login: 'check' };
  requests = [];
  const m = await mount('/console/catalog/route?status=draft');
  check('demo：匿名外壳（侧栏有「登录」按钮）', m.$('.sb-login') !== null && m.$('.login-page') === null);
  const bootRequests = [count('GET /api/console/me'), count('GET /api/console/pack')];

  // 侧栏的「登录」
  await m.click(m.$('.sb-login'));
  const back = (): HTMLAnchorElement | null => m.$<HTMLAnchorElement>('.login-back a');
  check('demo 点「登录」：进登录页', m.$('.login-page') !== null && document.querySelector('.sidebar') === null);
  eq(
    'demo：表单下方有「返回演示」',
    [m.text(back()), back() !== null && (m.$('.login-form')!.compareDocumentPosition(back()!) & 4) !== 0],
    ['返回演示', true],
  );
  eq(
    'demo：「返回演示」是指向当前地址的链接（带 /console 与 search）',
    back()?.getAttribute('href'),
    '/console/catalog/route?status=draft',
  );
  eq('demo：标签页标题', document.title, '登录 · 演示');
  check('demo：焦点在邮箱上', document.activeElement === m.email());

  // 带修饰键点：不拦，交给浏览器（新开标签）；这里在 document 上记下之后替浏览器拦住
  let prevented: boolean | null = null;
  const spy = (e: Event): void => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', spy);
  await act(async () => {
    back()!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }) as unknown as Event);
  });
  await settle(m.qc);
  eq('demo：Ctrl 点「返回演示」不拦，还在登录页', [prevented, m.$('.login-page') !== null], [false, true]);
  await act(async () => {
    back()!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }) as unknown as Event);
  });
  await settle(m.qc);
  eq('demo：⌘ 点「返回演示」同样不拦', [prevented, m.$('.login-page') !== null], [false, true]);

  // 左键点
  await act(async () => {
    back()!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
  });
  await settle(m.qc);
  document.removeEventListener('click', spy);
  check('demo：左键点「返回演示」拦下了链接的跳转', prevented === true);
  check('demo 返回：回到匿名外壳与这一页', m.$('.login-page') === null && m.$('.sb-login') !== null && m.text(m.$('h1')) === '测试页');
  eq('demo 返回：地址不变', m.url(), '/catalog/route?status=draft');
  eq('demo 返回：不重新取 /me、/pack', [count('GET /api/console/me'), count('GET /api/console/pack')], bootRequests);
  check(
    'demo 返回：焦点在内容面板（外壳的 main）',
    document.activeElement !== null && document.activeElement === m.$('main#main.shell-content'),
  );

  // 横幅的「登录后编辑」
  const bannerLogin = m.$$('.anon-banner button').find((b) => m.text(b) === '登录后编辑');
  await m.click(bannerLogin);
  check('demo 横幅「登录后编辑」：进登录页，也有「返回演示」', m.$('.login-page') !== null && back() !== null);

  // 从演示登录：进成员外壳，没有「返回演示」可言
  await m.type(m.email(), EMAIL);
  await m.type(m.password(), PASSWORD);
  await m.submit();
  check(
    'demo 登录成功：进成员外壳，地址不变',
    document.querySelector('.sidebar') !== null && m.$('.login-page') === null && m.url() === '/catalog/route?status=draft',
  );
  await m.unmount();
}

if (fails.length) {
  console.error(`登录页自测：${fails.length} 条失败（${pass} 条通过）`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`登录页自测：${pass} 条全部通过`);
process.exit(0);
