// 会话过期的判定与就地重登（console UX spec「通用部件 · 会话过期的判定」、不变量 24）。拿假的 fetch 驱动 session.ts：
// 1. 匿名身份下的 401 原样交回，不算过期；
// 2. 成员身份下，error 为 unauthorized 的响应、GET 拿到匿名形状、/me 的 401 都判为过期：请求停住、弹重登框，
//    登录成功后带新的 csrf、原样的请求体重放，调用方只拿到重放的结果；
// 3. 登录与退出接口、403 这类不算过期；空的产品库列表分不出身份，按成员算；
// 4. 关掉登录框或退出登录：等着的请求拿到 401 unauthorized，匿名形状的数据不交出去；
// 5. React Query：过期期间缓存里还是原来的数据，匿名形状的数据从来没进过缓存；
// 6. ANON_SHAPES 每一条只认它那个接口，成员形状不算匿名，匿名投影算（夹具按 src/shared 的类型写）；
// 7. 就地登录的换了一个人：等着的请求按 401 结束，不重放上一个人的写；
// 8. api.ts 导出的真客户端经 sessionFetch 走一轮过期、重登、重放；退出登录带着当前的 x-csrf（假服务端照 guardWrites 验），
//    之后 /me 的 401 不弹重登框；退出失败仍是成员，会话本来就没了（401）也算退出。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/session.selftest.ts
import { QueryClient } from '@tanstack/react-query';
import type { AnonCatalogItem, AnonSopOverview, AnonStatus, CatalogItem, SopOverview, Status } from '../../src/shared/console-api.js';
import { api, HttpError } from './api.js';
import {
  abandonRelogin,
  ANON_SHAPES,
  beginMemberSession,
  createSessionFetch,
  csrfHeader,
  endMemberSession,
  isMemberSession,
  isSessionExpired,
  resumeSession,
  subscribeSession,
} from './session.js';
import { logout } from './viewer.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}

// ---------------- 夹具 ----------------

const route = { id: 'r-a', title: '线路甲' } as unknown as CatalogItem['payload'];
const anonStatus: AnonStatus = { mode: 'db' };
const memberStatus = { mode: 'db', tenantSlug: 'demo' } as unknown as Status;
const anonSop: AnonSopOverview = { published: { versionNo: 2, publishedAt: '2026-09-25T10:30:00Z', promptHash: 'abc', sections: [] } };
const memberSop = { published: {}, draft: null, spec: [], budget: { chars: 1, limit: 2 } } as unknown as SopOverview;
const memberSop2 = { ...memberSop, budget: { chars: 5, limit: 9 } } as unknown as SopOverview;
const anonItem: AnonCatalogItem = { kind: 'route', code: 'r-a', payload: route };
const memberItem: CatalogItem = {
  kind: 'route',
  code: 'r-a',
  ord: 1,
  status: 'draft',
  rev: 3,
  payload: route,
  updatedByName: '小林',
  updatedAt: '2026-09-25T10:30:00Z',
};

const json = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Seen {
  url: string;
  method: string;
  csrf: string | null;
  body: string | undefined;
}

/** 假的 fetch：按顺序回放给定的响应，记下每次请求 */
function fakeFetch(responses: Array<() => Response>) {
  const seen: Seen[] = [];
  const base = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      csrf: new Headers(init?.headers).get('x-csrf'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`没有准备第 ${seen.length} 个响应：${String(input)}`);
    return next();
  };
  return { run: createSessionFetch(base), seen };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const STUCK = 'stuck' as const;
/** 应该马上回来的请求：停住了（在等重登）就给 STUCK，免得整个自测挂住、失败了也点不出名 */
const settle = <T>(p: Promise<T>): Promise<T | typeof STUCK> =>
  Promise.race([p, new Promise<typeof STUCK>((r) => setTimeout(() => r(STUCK), 300))]);
const statusOf = (r: Response | typeof STUCK): number | typeof STUCK => (r === STUCK ? STUCK : r.status);

/** 请求还停着吗：settled 由调用方的 then 置真 */
function track<T>(p: Promise<T>): { settled: () => boolean; value: Promise<T> } {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  return { settled: () => done, value: p };
}

const reset = (): void => endMemberSession();

// ---------------- 1. 匿名身份 ----------------
{
  reset();
  const { run } = fakeFetch([() => json(401, { error: 'unauthorized' }), () => json(200, anonSop)]);
  const r = await settle(run('/api/console/sop/draft', { method: 'PUT', body: '{}' }));
  check('匿名身份：写请求的 401 原样交回', statusOf(r) === 401 && !isSessionExpired(), String(statusOf(r)));
  reset();
  const g = await settle(run('/api/console/sop'));
  check(
    '匿名身份：匿名形状的 GET 原样交回',
    g !== STUCK && g.status === 200 && JSON.stringify(await g.json()) === JSON.stringify(anonSop),
    String(statusOf(g)),
  );
}

// ---------------- 2. 成员身份：三条过期判据 ----------------
{
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  let notified = 0;
  const unsubscribe = subscribeSession(() => (notified += 1));
  const { run, seen } = fakeFetch([() => json(401, { error: 'unauthorized', detail: '需要登录后台' }), () => json(200, { ok: true })]);
  const body = JSON.stringify({ basedOn: 'v2', rev: 3, edits: [{ key: 'principles', body: '正文' }] });
  const t = track(run('/api/console/sop/draft', { method: 'PUT', headers: { 'x-csrf': 'c1', 'Content-Type': 'application/json' }, body }));
  await tick();
  check('过期（unauthorized）：请求停住、弹重登框', !t.settled() && isSessionExpired() && notified === 1, `${t.settled()} ${notified}`);
  resumeSession({ csrf: 'c2', userId: 'u1' });
  const r = await t.value;
  check('重登之后：调用方拿到重放的结果', r.status === 200 && JSON.stringify(await r.json()) === '{"ok":true}');
  check(
    '重放：同一个接口、同样的请求体，带新的 csrf',
    seen.length === 2 && seen[1]!.url === seen[0]!.url && seen[1]!.method === 'PUT' && seen[1]!.body === body && seen[1]!.csrf === 'c2',
    JSON.stringify(seen),
  );
  check('重登之后：重登框收起', !isSessionExpired() && notified === 2, String(notified));
  unsubscribe();
}
{
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  const { run } = fakeFetch([() => json(200, anonSop), () => json(200, memberSop)]);
  const t = track(run('/api/console/sop'));
  await tick();
  check('过期（GET 拿到匿名形状）：请求停住', !t.settled() && isSessionExpired());
  resumeSession({ csrf: 'c2', userId: 'u1' });
  const body = (await (await t.value).json()) as unknown;
  check('过期（GET 拿到匿名形状）：调用方只拿到成员形状', JSON.stringify(body) === JSON.stringify(memberSop), JSON.stringify(body));
}
{
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  const { run } = fakeFetch([() => json(401, '不是 JSON'), () => json(200, { userId: 'u1', csrf: 'c3' })]);
  const t = track(run('/api/console/me'));
  await tick();
  check('过期（/me 401，响应体读不出来也算）：请求停住', !t.settled() && isSessionExpired());
  resumeSession({ csrf: 'c3', userId: 'u1' });
  check('过期（/me 401）：重登后拿到 200', (await t.value).status === 200);
}

// ---------------- 3. 不算过期的 ----------------
{
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  const { run } = fakeFetch([
    () => json(401, { error: 'invalid_credentials' }),
    // 会话已经失效时退出：接口回 401 unauthorized，也不弹重登框
    () => json(401, { error: 'unauthorized' }),
    () => json(403, { error: 'forbidden' }),
    () => json(401, { error: 'other' }),
    () => json(200, { items: [] }),
    () => json(200, { items: [memberItem] }),
    () => json(200, memberStatus),
    () => json(200, memberItem),
    () => json(200, anonSop),
  ]);
  // 每个请求前都清掉上一个可能留下的等待，一处出错不连累后面几处
  const one = async (url: string, init?: RequestInit): Promise<number | typeof STUCK> => {
    const r = statusOf(await settle(run(url, init)));
    if (r === STUCK) {
      reset();
      beginMemberSession({ csrf: 'c1', userId: 'u1' });
    }
    return r;
  };
  const statuses = [
    await one('/api/console/auth/login', { method: 'POST', body: '{}' }),
    await one('/api/console/auth/logout', { method: 'POST' }),
    await one('/api/console/sop/draft/publish', { method: 'POST', body: '{}' }),
    await one('/api/console/catalog/route', { method: 'POST', body: '{}' }),
    await one('/api/console/catalog/route'),
    await one('/api/console/catalog/hotel'),
    await one('/api/console/status'),
    await one('/api/console/catalog/route/r-a'),
    // 匿名形状只对 GET 算：写接口返回同样的东西不算
    await one('/api/console/sop', { method: 'POST', body: '{}' }),
  ];
  check(
    '不算过期：登录失败、退出、403、别的 401、空列表、成员形状、非 GET',
    JSON.stringify(statuses) === '[401,401,403,401,200,200,200,200,200]' && !isSessionExpired(),
    JSON.stringify(statuses),
  );
}

// ---------------- 4. 关掉重登框、退出登录 ----------------
{
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  const { run, seen } = fakeFetch([
    () => json(200, { items: [anonItem] }),
    () => json(401, { error: 'unauthorized', detail: '需要登录后台' }),
  ]);
  const list = track(run('/api/console/catalog/route'));
  const write = track(run('/api/console/catalog/route/r-a', { method: 'PATCH', body: '{}' }));
  await tick();
  check('两个请求同时过期：一个重登框，两个都停着', isSessionExpired() && !list.settled() && !write.settled());
  abandonRelogin();
  const a = await list.value;
  const aBody = (await a.json()) as { error?: string; items?: unknown };
  check(
    '关掉重登框：匿名形状的 200 换成 401 unauthorized，数据不交出去',
    a.status === 401 && aBody.error === 'unauthorized' && !('items' in aBody),
  );
  const w = await write.value;
  check('关掉重登框：写请求拿到原来的 401', w.status === 401 && ((await w.json()) as { error: string }).error === 'unauthorized');
  check('关掉重登框：没有重放', seen.length === 2 && !isSessionExpired());

  const again = fakeFetch([() => json(401, { error: 'unauthorized' })]);
  const t = track(again.run('/api/console/sop/draft/check', { method: 'POST' }));
  await tick();
  check('关掉之后仍是成员：下一个过期的请求再弹重登框', isSessionExpired() && !t.settled());
  endMemberSession();
  check('退出登录：等着的请求拿到 401，重登框收起', (await t.value).status === 401 && !isSessionExpired());
  const after = fakeFetch([() => json(401, { error: 'unauthorized' })]);
  check('退出之后：401 原样交回，不再弹', statusOf(await settle(after.run('/api/console/me'))) === 401 && !isSessionExpired());
}

// ---------------- 5. React Query 的缓存 ----------------
{
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['sop'], memberSop);
  const written: unknown[] = [];
  const unsubscribe = qc.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'success') written.push(e.query.state.data);
  });
  const { run } = fakeFetch([() => json(200, anonSop), () => json(200, memberSop2)]);
  const t = track(qc.fetchQuery({ queryKey: ['sop'], queryFn: async () => (await run('/api/console/sop')).json(), staleTime: 0 }));
  await tick();
  check('过期期间：缓存没清，还是原来的数据', !t.settled() && qc.getQueryData(['sop']) === memberSop);
  resumeSession({ csrf: 'c2', userId: 'u1' });
  await t.value;
  check('重登之后：缓存是重放拿到的成员数据', JSON.stringify(qc.getQueryData(['sop'])) === JSON.stringify(memberSop2));
  check(
    '匿名形状的数据从没进过缓存',
    written.length === 1 && written.every((d) => !ANON_SHAPES[1]!.isAnonShape(d)),
    JSON.stringify(written),
  );
  unsubscribe();
  qc.clear();
}

// ---------------- 6. ANON_SHAPES ----------------
{
  const shapeOf = (path: string) => ANON_SHAPES.filter((s) => s.path.test(path));
  const cases: Array<[string, unknown, unknown]> = [
    ['/api/console/status', anonStatus, memberStatus],
    ['/api/console/sop', anonSop, memberSop],
    ['/api/console/catalog/route', { items: [anonItem] }, { items: [memberItem] }],
    ['/api/console/catalog/route/r-a', anonItem, memberItem],
  ];
  for (const [path, anon, mem] of cases) {
    const s = shapeOf(path);
    check(`${path}：恰好一条判断`, s.length === 1, String(s.length));
    check(`${path}：匿名投影算匿名形状`, s[0]?.isAnonShape(anon) === true);
    check(`${path}：成员形状不算`, s[0]?.isAnonShape(mem) === false);
  }
  for (const path of [
    '/api/console/me',
    '/api/console/sop/versions',
    '/api/console/conversations',
    '/api/console/audit',
    '/api/console/pack',
  ])
    check(`${path}：没有匿名形状（匿名拿到的是 401，或两种身份一样）`, shapeOf(path).length === 0);
}

// ---------------- 7. 就地登录的换了一个人 ----------------
{
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  // 后两个响应只在错误地重放时才用得上：重放了就按名字记失败，不是整个自测因为没准备响应而崩掉
  const { run, seen } = fakeFetch([
    () => json(401, { error: 'unauthorized' }),
    () => json(200, anonSop),
    () => json(200, { ok: true }),
    () => json(200, memberSop),
  ]);
  const write = track(
    run('/api/console/sop/draft/publish', { method: 'POST', headers: { 'x-csrf': 'c1' }, body: '{"note":"甲写的说明"}' }),
  );
  const read = track(run('/api/console/sop'));
  await tick();
  check('换人之前：两个请求都停着', isSessionExpired() && !write.settled() && !read.settled());
  // 照 SessionExpiredDialog 的顺序：LoginForm 先 beginMemberSession，再 resumeSession
  beginMemberSession({ csrf: 'c9', userId: 'u2' });
  const replayed = resumeSession({ csrf: 'c9', userId: 'u2' });
  const w = await settle(write.value);
  const r = await settle(read.value);
  check('换了一个人：不重放，重登框收起', !replayed && seen.length === 2 && !isSessionExpired(), JSON.stringify(seen));
  check('换了一个人：上一个人的写拿到 401', statusOf(w) === 401);
  check('换了一个人：匿名形状的 GET 换成 401，数据不交出去', statusOf(r) === 401);
  check('换了一个人：之后按新身份发请求', isMemberSession() && csrfHeader()['x-csrf'] === 'c9');
}
{
  // 等着的时候身份变了（比如 /me 拿到了别的标签页登录的人），又有请求过期：比的仍是开始等的那个人
  reset();
  beginMemberSession({ csrf: 'c1', userId: 'u1' });
  const { run, seen } = fakeFetch([
    () => json(401, { error: 'unauthorized' }),
    () => json(401, { error: 'unauthorized' }),
    () => json(200, { ok: true }),
    () => json(200, { ok: true }),
  ]);
  const first = track(run('/api/console/sop/draft/publish', { method: 'POST', body: '{"note":"甲写的说明"}' }));
  await tick();
  beginMemberSession({ csrf: 'c8', userId: 'u2' });
  const second = track(run('/api/console/sop/draft/check', { method: 'POST' }));
  await tick();
  const replayed = resumeSession({ csrf: 'c8', userId: 'u2' });
  const a = await settle(first.value);
  const b = await settle(second.value);
  check(
    '等着时身份变了：按开始等的那个人比，都不重放',
    !replayed && statusOf(a) === 401 && statusOf(b) === 401 && seen.length === 2,
    JSON.stringify(seen),
  );
}

// ---------------- 8. 真的客户端与退出登录 ----------------
// 假服务端只有一个会话，照 src/console-api/app.ts：登录以外的写要有会话（否则 401）、x-csrf 等于会话的 csrf（否则 403 csrf）；
// 退出删掉会话；没有会话时 /me 401、/sop 给匿名投影
{
  reset();
  const server: { user: { userId: string; csrf: string } | null; failLogout: boolean } = { user: null, failLogout: false };
  const log: Seen[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://console.invalid').pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const csrf = new Headers(init?.headers).get('x-csrf');
    log.push({ url, method, csrf, body: typeof init?.body === 'string' ? init.body : undefined });
    if (method !== 'GET' && url !== '/api/console/auth/login') {
      if (!server.user) return json(401, { error: 'unauthorized' });
      if (csrf !== server.user.csrf) return json(403, { error: 'csrf' });
    }
    if (url === '/api/console/auth/logout') {
      if (server.failLogout) return json(500, { error: 'internal' });
      server.user = null;
      return json(200, { ok: true });
    }
    if (url === '/api/console/me') return server.user ? json(200, server.user) : json(401, { error: 'unauthorized' });
    if (url === '/api/console/sop') return json(200, server.user ? memberSop : anonSop);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  try {
    // 过期、就地登录、重放：走 api.ts 导出的客户端，它没经 sessionFetch 的话匿名投影会直接交回来
    beginMemberSession({ userId: 'u1', csrf: 'c1' });
    const t = track(api.sop.$get());
    await tick();
    check('真客户端：GET 拿到匿名形状时停住、弹重登框', !t.settled() && isSessionExpired(), JSON.stringify(log));
    server.user = { userId: 'u1', csrf: 'c2' };
    beginMemberSession(server.user);
    const again = resumeSession(server.user);
    const res = await settle(t.value);
    check('真客户端：同一个人登录回来（登录表单先进了成员身份）照样重放', again);
    check(
      '真客户端：重登后拿到重放的成员数据',
      res !== STUCK && res.status === 200 && JSON.stringify(await res.json()) === JSON.stringify(memberSop),
      String(statusOf(res)),
    );

    log.length = 0;
    const err = await settle(
      logout().then(
        () => null,
        (e: unknown) => e,
      ),
    );
    const out = log.find((l) => l.url === '/api/console/auth/logout');
    check(
      '退出：请求带着当前的 x-csrf，服务端删掉了会话',
      err === null && out?.csrf === 'c2' && server.user === null,
      JSON.stringify({ err, log }),
    );
    check('退出之后：不是成员，csrf 清掉', !isMemberSession() && !('x-csrf' in csrfHeader()));
    check('退出之后：/me 的 401 原样交回，不弹重登框', statusOf(await settle(api.me.$get())) === 401 && !isSessionExpired());

    server.user = { userId: 'u1', csrf: 'c3' };
    beginMemberSession(server.user);
    server.failLogout = true;
    const failed = await settle(
      logout().then(
        () => null,
        (e: unknown) => e,
      ),
    );
    check(
      '退出失败：错误交给调用方，仍是成员，csrf 还在',
      failed instanceof HttpError && failed.status === 500 && isMemberSession() && csrfHeader()['x-csrf'] === 'c3',
      String(failed),
    );
    server.failLogout = false;

    server.user = null;
    const gone = await settle(
      logout().then(
        () => null,
        (e: unknown) => e,
      ),
    );
    check('会话本来就没了：退出接口的 401 也算退出', gone === null && !isMemberSession(), String(gone));
  } finally {
    globalThis.fetch = realFetch;
  }
}

endMemberSession();
if (fails.length) {
  console.error(`session: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`session: ${pass} 条断言全部通过`);
