// 15 验收 2–5：真实路由、QueryClient 与 DOM；--real-api 由真实 prod/PG 贯穿调用，不替换认证或设置 API。
import '../overview/selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { QueryClient, QueryClientProvider, focusManager, timeoutManager } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { App as AntApp } from 'antd';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Me, SettingsResponses, UsageView } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import acceptance from '../catalog/acceptance.fixture.json';
import { api, unwrap } from '../api.js';
import { abandonRelogin, beginMemberSession, endMemberSession } from '../session.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { VIEWER_KEY, type Viewer } from '../viewer.js';
import { settingsQueryKey } from '../../../src/shared/console-api.js';
import { usageMoney } from './UsagePage.js';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('.css')) return {format:'module',source:'export {};',shortCircuit:true};
  const r=await next(url,context); if(!url.includes('/console/src/')||r.source==null)return r;
  const source=typeof r.source==='string'?r.source:new TextDecoder().decode(r.source);
  return source.includes('import.meta.env')?{...r,source:source.replaceAll('import.meta.env','({ BASE_URL: "/console/", VITE_SPECIMEN: "0" })')}:r;
}`)}`,
);
const { router: appRouter } = await import('../router.js');
const nativeFetch = globalThis.fetch;
const realUsage = process.argv.includes('--real-usage');
const real = process.argv.includes('--real-api') || realUsage;
const calls: { path: string; method: string; cache?: RequestCache }[] = [];
const pack = acceptance.pack as unknown as IndustryPack;
const BASE_ME: Me = {
  userId: 'synthetic-owner',
  displayName: '合成成员',
  role: 'owner',
  csrf: 'synthetic-csrf',
  tenantSlug: 'synthetic-a',
  tenantName: '合成甲',
  sandbox: null,
};
let me = { ...BASE_ME };
let org: SettingsResponses['organization'] = {
  name: '合成甲',
  slug: me.tenantSlug,
  packId: pack.id,
  status: 'trial',
  publishedBrandName: null,
  pendingBrandChange: true,
};
let members: SettingsResponses['members'] = {
  items: [{ userId: me.userId, displayName: me.displayName, role: me.role, email: 'owner@settings.example.test', disabled: false }],
};
let channels: SettingsResponses['channels'] = { items: [] };
let onboarding: SettingsResponses['onboarding'] = {
  steps: [
    { key: 'team', state: 'todo', href: '/console/settings/members', reason: '成员由平台开通' },
    { key: 'catalog', state: 'todo', href: `/console/catalog/${pack.entities[0]!.kind}` },
    { key: 'sop', state: 'done', href: '/console/sop' },
    { key: 'channel', state: 'blocked', href: '/console/settings/channels', reason: '请联系平台完成接入配置' },
  ],
};
let failure: { page: string; status: number } | null = null;
let usage: UsageView = {
  status: 'active',
  month: '2026-10',
  replies: { used: 5, quota: 20 },
  daily: { costMilli: 123, capMilli: 500 },
  days: [{ day: '2026-10-03', replies: 5, costMilli: 123 }],
};
let holdPage = '';
let release: (() => void) | null = null;
const pendingResponses: (() => void)[] = [];
function releaseResponses() {
  release?.();
  release = null;
}
let cookie = '';
const json = (body: unknown, status = 200) => Response.json(body, { status });
globalThis.fetch = async (input, init) => {
  const source = input instanceof Request ? input.url : String(input);
  const url = new URL(source, 'http://localhost');
  const method = init?.method ?? 'GET';
  calls.push({ path: url.pathname, method, cache: init?.cache });
  if (real) {
    const headers = new Headers(init?.headers);
    headers.set('host', 'app.erp.example.test');
    headers.set('origin', 'https://app.erp.example.test');
    if (cookie) headers.set('cookie', cookie);
    const target = new URL(process.env.SETTINGS_TEST_ORIGIN!);
    const response = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: url.pathname + url.search,
          method,
          headers: Object.fromEntries(headers),
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (b) => chunks.push(b));
          res.on('end', () => {
            const out = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              if (value) out.set(key, Array.isArray(value) ? value.join(', ') : value);
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: out }));
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('UI HTTP timeout')));
      req.end(init?.body as string | undefined);
    });
    const session = response.headers.get('set-cookie');
    if (session) cookie = session.split(';')[0]!;
    return response;
  }
  const path = url.pathname.replace('/api/console', '');
  if (path === '/me') return json(me);
  if (path === '/pack') return json(pack);
  if (path === '/entry') return json({ tryUrl: null, showcase: null });
  if (path === '/usage')
    return failure?.page === 'usage' ? json({ error: failure.status === 403 ? 'forbidden' : 'internal' }, failure.status) : json(usage);
  if (path === '/conversations/counts')
    return json({ total: 0, byState: { ai: 0, human: 0, assigned: 0, paid: 0 }, aiByStage: {}, updatedToday: 0 });
  if (path === '/conversations') return json({ items: [], total: 0 });
  if (path.startsWith('/catalog/')) return json({ items: [] });
  if (path.startsWith('/settings/')) {
    const page = path.slice('/settings/'.length) as Exclude<keyof SettingsResponses, 'usage'>;
    if (failure?.page === page)
      return json({ error: failure.status === 401 ? 'unauthorized' : failure.status === 403 ? 'forbidden' : 'internal' }, failure.status);
    const value = structuredClone({ organization: org, members, channels, onboarding }[page]);
    if (holdPage === page) {
      await new Promise<void>((resolve) => {
        pendingResponses.push(resolve);
        release = () => {
          holdPage = '';
          for (const done of pendingResponses.splice(0)) done();
        };
      });
    }
    return json(value);
  }
  return json({ error: 'not_found' }, 404);
};

const text = () => document.querySelector('#main')?.textContent ?? '';
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.replace(/\s/g, '') === label);
async function settle(qc: QueryClient, rounds = 16) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await win.happyDOM.waitUntilComplete();
    });
    if (i > 3 && qc.isFetching() === 0) break;
  }
}
async function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const router = createRouter({ ...appRouter.options, history: createMemoryHistory({ initialEntries: [path] }) });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          ThemeProvider,
          null,
          createElement(
            AntApp,
            null,
            createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: router as never })),
          ),
        ),
      ),
    ),
  );
  // 等待真实懒加载路由完成；仅等 QueryClient 会在路由 chunk 到达前误认页面已就绪。
  await act(async () => router.load());
  await settle(qc, 100);
  return {
    qc,
    router,
    async close() {
      await qc.cancelQueries();
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      qc.clear();
      container.remove();
      endMemberSession();
    },
  };
}
async function navigate(m: Awaited<ReturnType<typeof mount>>, page: string) {
  await act(async () => {
    await m.router.navigate({ to: '/settings/$page', params: { page } });
  });
  await settle(m.qc);
}
async function click(m: Awaited<ReturnType<typeof mount>>, el: HTMLElement | undefined | null) {
  assert.ok(el, 'click target exists');
  await act(async () => el.click());
  await settle(m.qc);
}
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
}

try {
  if (real) {
    const logged = await unwrap(
      api.auth.login.$post({ json: { email: 'owner@settings.example.test', password: 'synthetic-member-password' } }),
    );
    beginMemberSession(logged);
    const m = await mount(realUsage ? '/console/settings/usage' : '/console/settings/organization');
    try {
      const viewer = m.qc.getQueryData<Viewer>(VIEWER_KEY);
      assert.equal(viewer?.kind, 'member');
      if (process.env.SETTINGS_TEST_TRIAL === '1') {
        assert.equal(logged.sharedTrial, true);
        assert.ok(document.querySelector('.trial-banner')?.textContent?.includes('请不要发送个人信息'));
        assert.ok(document.querySelector('.trial-banner')?.textContent?.includes('7'));
        const value = await unwrap(api.usage.$get());
        assert.ok(value.replies.used > 0);
        await navigate(m, 'usage');
        assert.equal(document.querySelector('[data-usage="replies"]')?.textContent, `${value.replies.used}次`);
        assert.ok(document.querySelector('.usage-table'));
        await navigate(m, 'organization');
        console.log(`15 验收 9 REAL UI PASS: authenticated whitelist notice and actual usage page ${value.replies.used}`);
      }
      if (realUsage) {
        const checkUsage = async () => {
          const value = await unwrap(api.usage.$get());
          assert.equal(document.querySelector('[data-usage="replies"]')?.textContent, `${value.replies.used}次`);
          assert.equal(document.querySelector('[data-usage="cost"]')?.textContent, `${(value.daily.costMilli / 1000).toFixed(3)}元`);
          return value;
        };
        assert.equal((await checkUsage()).replies.used, 0);
        await new Promise<void>((resolve) => {
          process.once('message', () => resolve());
          process.send?.({ advanceUsage: true });
        });
        await act(async () => {
          await m.qc.refetchQueries({
            queryKey: ['settings', viewer?.kind === 'member' ? viewer.me.tenantSlug : '', logged.userId, 'usage'],
          });
        });
        await settle(m.qc);
        assert.equal((await checkUsage()).replies.used, 1);
        console.log('15 验收 5 REAL USAGE PASS: real engine reply → usage_daily → authenticated HTTP API → actual usage page 0→1');
      } else if (process.env.SETTINGS_TEST_ROLE === 'agent') {
        assert.ok(!document.querySelector('.sb-nav a[href="/console/settings"]'));
        assert.ok(!document.querySelector('.settings-section'));
        for (const page of ['members', 'channels']) {
          await navigate(m, page);
          assert.ok(!document.querySelector('.settings-list'));
        }
        assert.equal((await api.settings.channels.$get()).status, 403);
        await settle(m.qc);
        console.log('15 验收 2/3 REAL UI PASS: real agent login, all settings pages denied and navigation hidden');
      } else {
        assert.ok(text().includes('合成工业'));
        assert.ok(document.querySelector('.settings-section'));
        await navigate(m, 'members');
        assert.ok(text().includes('合成所有者'));
        assert.ok(!text().includes('surface-travel@erp.example.test'));
        assert.ok(text().includes('owner@settings.example.test'));
        await navigate(m, 'channels');
        assert.ok(text().includes('合成渠道'));
        assert.ok(document.querySelector('time'));
        assert.ok(text().includes('已载入'));
        assert.ok(!text().includes('synthetic-industry-corp'));
        assert.ok(!text().includes('synthetic-industry-secret'));
        await act(async () => {
          await m.router.navigate({ to: '/' });
        });
        await settle(m.qc);
        assert.equal(
          document.querySelector('.onboarding-list li[data-state="done"] a[href="/console/settings/channels"]')?.textContent,
          '验证接入收发',
        );
        assert.ok(calls.some((r) => r.path === '/api/console/settings/onboarding'));
        assert.ok(calls.filter((r) => r.path.includes('/settings/')).every((r) => r.method === 'GET'));
        console.log('15 验收 3/4/5 REAL UI PASS: real login → actual router → actual four APIs → persisted inbound onboarding');
      }
    } finally {
      await m.close();
    }
  } else {
    me = { ...BASE_ME, sharedTrial: true };
    const trial = await mount('/console/settings/organization');
    assert.ok(document.querySelector('.trial-banner')?.textContent?.includes('请不要发送个人信息'));
    assert.ok(document.querySelector('.trial-banner')?.textContent?.includes('7'));
    await trial.close();
    me = { ...BASE_ME };
    const regular = await mount('/console/settings/organization');
    assert.equal(document.querySelector('.trial-banner'), null);
    await regular.close();
    console.log('15 验收 9 PASS: server boolean controls persistent shell banner; other members have none');
    // 深链接、加载、三页真实路由、筛选、空列表、状态、重试。
    holdPage = 'organization';
    const m = await mount('/console/settings/organization');
    try {
      assert.ok(document.querySelector('#main .state-skeleton[role="status"]'));
      assert.ok(!document.querySelector('.settings-section'));
      await act(async () => {
        releaseResponses();
      });
      await settle(m.qc);
      assert.ok(text().includes(org.name));
      assert.ok(text().includes('品牌变更待发布'));
      assert.equal(document.title, '企业设置 · 合成甲 · 单来');
      assert.ok(document.querySelector('.sb-nav a[href="/console/settings"]'));
      assert.ok(m.qc.getQueryData(settingsQueryKey(me.tenantSlug, me.userId, 'organization')));
      assert.ok(calls.filter((r) => r.path.includes('/settings/')).every((r) => r.cache === 'no-store'));
      const before = calls.filter((r) => r.path.endsWith('/organization')).length;
      org = { ...org, publishedBrandName: '合成新品牌', pendingBrandChange: false };
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await settle(m.qc);
      assert.ok(calls.filter((r) => r.path.endsWith('/organization')).length > before);
      assert.ok(text().includes('合成新品牌'));
      await navigate(m, 'members');
      assert.ok(text().includes('成员由平台开通'));
      assert.ok(text().includes('owner@settings.example.test'));
      const search = document.querySelector<HTMLInputElement>('[aria-label="筛选成员"]')!;
      search.focus();
      assert.equal(document.activeElement, search);
      for (const term of ['合成成员', 'owner@settings.example.test', '所有者']) {
        await act(async () => type(search, term));
        assert.ok(document.querySelector('.settings-list li'));
      }
      await act(async () => type(search, 'no-match'));
      assert.ok(text().includes('没有符合条件的成员'));
      await click(m, button('清除筛选'));
      assert.ok(text().includes('owner@settings.example.test'));
      await navigate(m, 'channels');
      assert.ok(text().includes('还未接入'));
      channels = {
        items: [
          {
            accountId: 'synthetic-channel',
            key: 'main',
            name: '合成企微',
            kind: 'wecom',
            source: 'db',
            enabled: true,
            loaded: false,
            blockedByProfile: false,
            credentialsConfigured: true,
            callbackPath: '/wecom/callback/main',
            lastInboundAt: null,
          },
          {
            accountId: 'synthetic-web',
            key: 'web',
            name: '合成网页',
            kind: 'web',
            source: 'db',
            enabled: true,
            loaded: false,
            blockedByProfile: true,
            credentialsConfigured: false,
            callbackPath: null,
            lastInboundAt: null,
          },
        ],
      };
      await navigate(m, 'members');
      await navigate(m, 'channels');
      assert.ok(text().includes('未载入'));
      assert.ok(text().includes('当前环境未启用'));
      assert.ok(text().includes('暂无可靠入站记录'));
      assert.ok(!document.querySelector('#main form'));
      assert.ok(!document.querySelector('#main input[type="password"]'));
      failure = { page: 'organization', status: 500 };
      await navigate(m, 'organization');
      assert.ok(text().includes('没取到'));
      assert.ok(!document.querySelector('.settings-section'));
      failure = null;
      await click(m, button('重试'));
      assert.ok(document.querySelector('.settings-section'));
      await act(async () => {
        await m.router.navigate({ to: '/settings' });
      });
      await settle(m.qc);
      assert.ok(document.querySelector('.settings-section'));
      assert.equal(document.activeElement?.id, 'main');
      const css = document.createElement('style');
      css.textContent = readFileSync('console/src/settings/settings.css', 'utf8');
      document.head.append(css);
      await act(async () => win.happyDOM.setViewport({ width: 390, height: 844 }));
      assert.equal(win.getComputedStyle(document.querySelector('.settings-details') as never).gridTemplateColumns, '1fr');
      const link = document.querySelector<HTMLAnchorElement>('.settings-tabs a[href="/console/settings/members"]')!;
      link.focus();
      assert.equal(document.activeElement, link);
      await click(m, link);
      assert.equal(document.activeElement?.id, 'main');
      css.remove();
      console.log(
        '15 验收 4 PASS: actual deep links/default route, loading/empty/error/retry, member filter, focus refresh, narrow CSS and keyboard focus',
      );
      // 403 立即隐藏旧数据；连不遵守 abort 的迟到响应也不能回写。
      await navigate(m, 'organization');
      holdPage = 'organization';
      const pending = m.qc.refetchQueries({ queryKey: settingsQueryKey(me.tenantSlug, me.userId, 'organization') });
      await settle(m.qc, 3);
      failure = { page: 'members', status: 403 };
      await act(async () => {
        await api.settings.members.$get();
      });
      await settle(m.qc);
      assert.equal(m.qc.getQueriesData({ queryKey: ['settings'] }).length, 0);
      assert.ok(!document.querySelector('.settings-section'));
      await act(async () => {
        releaseResponses();
        await pending;
      });
      await settle(m.qc);
      assert.equal(m.qc.getQueriesData({ queryKey: ['settings'] }).length, 0);
      failure = null;
      await click(m, button('重新检查权限'));
      assert.ok(document.querySelector('.settings-section'));
      failure = { page: 'members', status: 401 };
      const held = api.settings.members.$get();
      await settle(m.qc, 5);
      assert.equal(m.qc.getQueriesData({ queryKey: ['settings'] }).length, 0);
      assert.ok(!document.querySelector('.settings-section'));
      await act(async () => abandonRelogin());
      await held;
      failure = null;
      console.log('15 验收 3 PASS: 401 before relogin and 403 clear all settings; late aborted response cannot repopulate cache');
    } finally {
      releaseResponses();
      failure = null;
      await m.close();
    }
    // 切租户/成员/角色与退出。
    const switched = await mount('/console/settings/members');
    try {
      const next = { ...me, tenantSlug: 'synthetic-b', userId: 'synthetic-new-owner', tenantName: '合成乙' };
      me = next;
      members = { items: [{ ...members.items[0]!, userId: next.userId, displayName: '新成员' }] };
      const nextViewer: Viewer = { kind: 'member', me: next, pack };
      await act(async () => {
        switched.qc.setQueryData<Viewer>(VIEWER_KEY, nextViewer);
      });
      await settle(switched.qc);
      assert.equal(switched.qc.getQueryData(settingsQueryKey(BASE_ME.tenantSlug, BASE_ME.userId, 'members')), undefined);
      assert.ok(switched.qc.getQueryData(settingsQueryKey(next.tenantSlug, next.userId, 'members')));
      assert.ok(text().includes('新成员'));
      for (const role of ['supervisor', 'agent', 'viewer'] as const) {
        me = { ...me, role };
        const roleViewer: Viewer = { kind: 'member', me, pack };
        await act(async () => {
          switched.qc.setQueryData<Viewer>(VIEWER_KEY, roleViewer);
        });
        await settle(switched.qc);
        await navigate(switched, 'usage');
        assert.ok(!document.querySelector('.sb-nav a[href="/console/settings"]'));
        assert.ok(!document.querySelector('[data-usage]'));
        assert.ok(!document.querySelector('.settings-list'));
        assert.equal(switched.qc.getQueriesData({ queryKey: ['settings'] }).length, 0);
      }
      await act(async () => switched.qc.setQueryData<Viewer>(VIEWER_KEY, { kind: 'login' }));
      await settle(switched.qc);
      assert.equal(switched.qc.getQueriesData({ queryKey: ['settings'] }).length, 0);
      console.log('15 验收 2/3 PASS: slug/user change and logout clear cache; supervisor/agent/viewer deep links deny and hide navigation');
    } finally {
      await switched.close();
    }
    me = { ...BASE_ME };
    const usageTicks = new Map<ReturnType<typeof setInterval>, () => void>();
    timeoutManager.setTimeoutProvider({
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => {
        const id = setInterval(fn, ms === 30_000 ? 1_000_000 : ms);
        if (ms === 30_000) usageTicks.set(id, fn);
        return id;
      },
      clearInterval: (id) => {
        if (id !== undefined) usageTicks.delete(id);
        clearInterval(id);
      },
    });
    const usageView = await mount('/console/settings/usage');
    try {
      assert.equal(usageMoney(1), '0.001元');
      assert.equal(usageMoney(1000), '1.000元');
      assert.ok(text().includes('0.123元'));
      assert.ok(text().includes('20次'));
      assert.ok(document.querySelector('.usage-table'));
      const query = usageView.qc.getQueryCache().find({ queryKey: settingsQueryKey(me.tenantSlug, me.userId, 'usage') })!;
      assert.equal(Reflect.get(query.options, 'refetchInterval'), 30_000);
      assert.equal(Reflect.get(query.options, 'refetchIntervalInBackground'), false);
      focusManager.setFocused(false);
      let before = calls.filter((r) => r.path === '/api/console/usage').length;
      await act(async () => {
        for (const tick of Array.from(usageTicks.values())) tick();
      });
      await settle(usageView.qc);
      assert.equal(calls.filter((r) => r.path === '/api/console/usage').length, before, 'hidden interval does not fetch');
      focusManager.setFocused(true);
      await settle(usageView.qc);
      before = calls.filter((r) => r.path === '/api/console/usage').length;
      await act(async () => {
        for (const tick of Array.from(usageTicks.values())) tick();
      });
      await settle(usageView.qc);
      assert.ok(calls.filter((r) => r.path === '/api/console/usage').length > before, 'visible interval fetches real query');
      failure = { page: 'usage', status: 500 };
      await act(async () => {
        await usageView.qc.refetchQueries({ queryKey: ['settings'] });
      });
      await settle(usageView.qc);
      assert.ok(text().includes('未更新'));
      assert.ok(text().includes('0.123元'));
      failure = null;
      usage = { status: 'trial', month: '2026-11', replies: { used: 0, quota: null }, daily: { costMilli: 0, capMilli: 0 }, days: [] };
      await click(usageView, button('重试'));
      assert.ok(text().includes('不限'));
      assert.ok(text().includes('已全拦'));
      assert.ok(text().includes('本月暂无用量'));
      assert.ok(!text().includes('2026-10'));
      failure = { page: 'usage', status: 403 };
      await act(async () => {
        await usageView.qc.refetchQueries({ queryKey: ['settings'] });
      });
      await settle(usageView.qc);
      assert.ok(!document.querySelector('[data-usage]'));
      assert.equal(usageView.qc.getQueriesData({ queryKey: ['settings'] }).length, 0);
      console.log('15 验收 5 PASS: usage units/null/zero/empty/new month/stale retry/403 clearing and 30s visible-only query policy');
    } finally {
      failure = null;
      await usageView.close();
      timeoutManager.setTimeoutProvider({ setTimeout, clearTimeout, setInterval, clearInterval });
    }
    win.localStorage.clear();
    const guide = await mount('/console/');
    try {
      const overviewStyle = document.createElement('style');
      overviewStyle.textContent = readFileSync('console/src/overview/overview.css', 'utf8');
      document.head.append(overviewStyle);
      assert.ok(document.querySelector('.onboarding-list'), `onboarding missing: ${document.body.textContent}`);
      assert.equal(win.getComputedStyle(document.querySelector('.onboarding-list') as never).gridTemplateColumns, '1fr');
      overviewStyle.remove();
      assert.ok(document.querySelector('.onboarding-list li[data-state="todo"]'));
      assert.ok(document.querySelector('.onboarding-list li[data-state="blocked"]'));
      const toggle = button('收起清单')!;
      toggle.focus();
      assert.equal(document.activeElement, toggle);
      await click(guide, toggle);
      assert.equal(button('展开清单')?.getAttribute('aria-expanded'), 'false');
      assert.ok(!document.querySelector('.onboarding-list'));
      assert.equal(win.localStorage.length, 1);
      for (let i = 0; i < win.localStorage.length; i++) assert.equal(win.localStorage.getItem(win.localStorage.key(i)!), 'collapsed');
      await click(guide, button('展开清单'));
      const team = document.querySelector<HTMLAnchorElement>('.onboarding a[href="/console/settings/members"]')!;
      await click(guide, team);
      assert.ok(document.querySelector('[aria-label="筛选成员"]'));
      await act(async () => {
        await guide.router.navigate({ to: '/' });
      });
      await settle(guide.qc);
      assert.ok(document.querySelector('.onboarding-list li[data-state="todo"]'));
      failure = { page: 'onboarding', status: 500 };
      await act(async () => guide.qc.refetchQueries({ queryKey: ['settings', me.tenantSlug, me.userId, 'onboarding'] }));
      await settle(guide.qc);
      assert.ok(document.querySelector('.onboarding-unknown a'));
      assert.ok(!document.querySelector('.onboarding-list li[data-state="done"]'));
      failure = null;
      onboarding = { steps: onboarding.steps.map((step) => ({ ...step, state: 'done' })) };
      await click(guide, button('重试'));
      assert.ok(document.querySelector('.onboarding-complete'));
      assert.ok(calls.filter((r) => r.path.includes('/settings/')).every((r) => r.method === 'GET'));
      console.log('15 验收 5 PASS: server states only, collapse preference only, safe links, failed status unknown and retry/all complete');
    } finally {
      failure = null;
      await guide.close();
    }
  }
} finally {
  globalThis.fetch = nativeFetch;
  endMemberSession();
  focusManager.setFocused(undefined);
  await win.happyDOM.abort();
}
