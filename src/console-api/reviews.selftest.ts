// 17 R1/R2/R4：完整 server、两种数据库、CAS 与无源内容草稿。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { RegressionDraft, Role, TurnReviewView, TracePage, TurnTraceDetailView } from '../shared/console-api.js';
import { validateCase } from '../../eval/v2/schema.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.env.REVIEWS_SELFTEST_CHILD;
if (!mode) {
  if (process.env.CI === 'true' && !process.env.PG_TEST_URL) throw new Error('CI 下必须设 PG_TEST_URL');
  for (const child of ['pglite', ...(process.env.PG_TEST_URL ? ['pg'] : [])]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, REVIEWS_SELFTEST_CHILD: child, TZ: 'Asia/Shanghai' },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.equal(result.status, 0, `${child}: ${result.error ?? result.signal ?? 'failed'}`);
  }
  if (!process.env.PG_TEST_URL) console.log('REVIEWS：未设 PG_TEST_URL，跳过真实 PG');
  console.log('REVIEWS SELFTEST PASS');
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-selftest-'));
  for (const name of ['data', 'public', 'console', 'node_modules']) fs.symlinkSync(path.join(root, name), path.join(directory, name));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  process.chdir(directory);
  Object.assign(process.env, { VAR_DIR: path.join(directory, 'state'), CONFIG_SOURCE: 'file', SERVER_SELFTEST: '1', LLM_MOCK: '1' });
  try {
    await suite();
  } finally {
    process.chdir(root);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  async function suite(): Promise<void> {
    const testing = await import('../db/testing.js');
    const { openDb } = await import('../db/client.js');
    const { configRuntime, initConfig, closeConfig } = await import('../config/source.js');
    const { hostRuntime, createTenantRuntime } = await import('../tenancy/runtime.js');
    const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
    const { createUser } = await import('../auth/accounts.js');
    const { importConfig } = await import('../config/transfer.js');
    const host = hostRuntime();
    enterTenantScopeForTest(host);
    type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
    let db: Db;
    let su: Query;
    let platform: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
    let closeDb: () => Promise<void>;
    if (mode === 'pglite') {
      const t = await testing.openTestDb();
      db = t.db;
      await testing.installSeededConfig(t);
      su = (text, params = []) =>
        t.pg.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE NONE');
          return (await tx.query<Record<string, unknown>>(text, params)).rows;
        });
      platform = async (fn) => {
        await t.pg.exec('SET ROLE agent_platform');
        try {
          return await fn(db);
        } finally {
          await t.pg.exec('SET ROLE agent_app');
        }
      };
      closeDb = () => t.close();
    } else {
      const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL!);
      const appDb = await openDb(fx.urls.app, { max: 4 });
      const platformDb = await openDb(fx.urls.platform, { max: 4 });
      db = appDb.db;
      su = (text, params) => fx.query(text, params);
      platform = (fn) => fn(platformDb.db);
      const deps = testing.testConfigDeps({ db });
      const imported = await importConfig({
        db,
        tenantSlug: 'demo',
        dataDir: path.join(root, 'data'),
        imageSop: deps.imageSop,
        lock: async () => testing.fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      await initConfig(deps);
      closeDb = async () => {
        await appDb.close();
        await platformDb.close();
        await fx.drop();
      };
    }
    const { app } = await import('../server.js');
    const { __consoleTest } = await import('./app.js');
    const { __profileTest } = await import('../profile.js');
    const { initSessionStore } = await import('../store.js');
    const { runShutdownHooks } = await import('../shutdown.js');
    const { withTenantScope, unregisterRuntime } = await import('../tenancy/runtime.js');
    const { installPublicHost } = await import('../tenancy/hosts.js');
    const { packSources } = await import('../config/source.js');
    const { createIndustrialRuntime } = await import('../packs/industrial/runtime.js');
    const tenantId = configRuntime().tenantId;
    const roles: Role[] = ['owner', 'admin', 'supervisor', 'agent', 'viewer'];
    type Login = { cookie: string; csrf: string; userId: string };
    const tokens = new Map<string, Login>();
    const hostName = 'reviews.example.test';
    const otherHost = 'industry.reviews.example.test';
    let industry: ReturnType<typeof createTenantRuntime> | undefined;
    async function request(suffix: string, role?: string, method = 'GET', body?: unknown, hostname = hostName) {
      const login = tokens.get(role ?? '');
      const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      return app.request(`/api/console/traces${suffix}`, {
        method,
        headers: {
          host: hostname,
          ...(method !== 'GET' ? { 'content-length': String(Buffer.byteLength(raw ?? '')) } : {}),
          ...(login ? { cookie: login.cookie, 'x-csrf': login.csrf } : {}),
          ...(raw !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: raw,
      });
    }
    const put = (id: string, role = 'owner', expectedRevision = 0, rating = 'bad', reason: string | null = 'incorrect') =>
      request(`/${id}/review`, role, 'PUT', { expectedRevision, rating, reason });
    async function status(response: Response, expected: number, error?: string) {
      assert.equal(response.status, expected, await response.clone().text());
      if (error) assert.equal((await response.json()).error, error);
    }
    async function user(key: string, role: Role, slug = 'demo', hostname = hostName) {
      const email = `${key}@reviews.example.test`;
      const made = await platform((p) =>
        createUser(p, {
          tenantSlug: slug,
          email,
          name: key,
          role,
          password: async () => `synthetic-${key}-password`,
        }),
      );
      assert.equal(made.code, 0, made.message);
      const loginBody = JSON.stringify({ email, password: `synthetic-${key}-password` });
      const response = await app.request('/api/console/auth/login', {
        method: 'POST',
        headers: { host: hostname, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(loginBody)) },
        body: loginBody,
      });
      await status(response, 200);
      const me = await response.json();
      tokens.set(key, { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: me.csrf, userId: me.userId });
    }
    const endpoints = (id: string): [string, string, unknown?][] => [
      ['?review=none', 'GET'],
      [`/${id}`, 'GET'],
      [`/${id}/review`, 'GET'],
      [`/${id}/review`, 'PUT', { expectedRevision: 0, rating: 'good', reason: null }],
      [`/${id}/regression-draft`, 'POST'],
    ];
    try {
      for (const role of roles) await user(role, role);
      // 文件模式：用坏 UUID/筛选参数证明权限与存储检查先执行。
      for (const role of [undefined, ...roles]) {
        const allowed = role === 'owner' || role === 'admin';
        for (const [url, method, body] of endpoints('invalid'))
          await status(
            await request(url, role, method, body),
            !role ? 401 : allowed ? 503 : 403,
            !role ? 'unauthorized' : allowed ? 'store_file_mode' : 'forbidden',
          );
      }
      await initSessionStore({ db, tenantId, tenantSlug: 'demo', varDir: process.env.VAR_DIR! });
      const marker = 'SYNTHETIC_REVIEW_SOURCE_ONLY_9264';
      const poison = `${marker} 虚构姓名样例甲 13900001234 虚构市样例路88号`;
      const otherId = (
        await su("insert into tenants(slug,name,pack_id) values('reviews-industry','合成工业','industrial') returning id")
      )[0]!.id as string;
      await su('update tenants set brand=$2 where id=$1', [otherId, JSON.stringify(createIndustrialRuntime(packSources()).defaultBrand)]);
      const imported = await importConfig({
        db,
        tenantSlug: 'reviews-industry',
        dataDir: path.join(root, 'data/packs/industrial'),
        imageSop: fs.readFileSync(path.join(root, 'data/packs/industrial/sop.md'), 'utf8'),
        lock: async () => testing.fakeLock(),
      });
      assert.equal(imported.code, 0, imported.message);
      industry = createTenantRuntime({ id: otherId, slug: 'reviews-industry', isHost: false, publicBase: `https://${otherHost}` });
      await withTenantScope(industry, async () => {
        await initConfig(testing.testConfigDeps({ db }, { tenantSlug: 'reviews-industry', usePackRuntime: true }));
        await initSessionStore({ db, tenantId: otherId, tenantSlug: 'reviews-industry', varDir: path.join(directory, 'industrial') });
      });
      installPublicHost(host, hostName);
      installPublicHost(industry, otherHost);
      process.env.TRIAL_TENANT_ALLOWLIST = JSON.stringify([
        { tenantId: otherId, slug: 'reviews-industry', packId: 'industrial', kind: 'standard', isHost: false },
      ]);
      await user('trial-agent', 'agent', 'reviews-industry', otherHost);
      await user('industry-owner', 'owner', 'reviews-industry', otherHost);
      const trialMe = await app.request('/api/console/me', { headers: { host: otherHost, cookie: tokens.get('trial-agent')!.cookie } });
      assert.equal((await trialMe.json()).sharedTrial, true);
      for (const [id, tenant, seed] of [
        ['review-main', tenantId, false],
        ['review-seed', tenantId, true],
        ['review-other', otherId, true],
      ] as const)
        await su(
          `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at)
          values($1,$2,'wecom','greeting',false,$3,now(),now())`,
          [tenant, id, JSON.stringify({ id, seed, profile: { notes: [poison] } })],
        );
      let seq = 0;
      async function turn(
        options: {
          outcome?: string;
          final?: string | null;
          author?: string | null | false;
          role?: string;
          tenant?: string;
          conversation?: string;
        } = {},
      ) {
        const id = randomUUID();
        const tenant = options.tenant ?? tenantId;
        const conversation = options.conversation ?? 'review-main';
        await su(
          `insert into turn_traces(tenant_id,id,conversation_id,started_at,duration_ms,outcome,prefix_hash,catalog_versions,calls,llm,draft,final_text)
          values($1,$2,$3,now(),100,$4,$5,'{}',$6,'[]',$7,$8)`,
          [
            tenant,
            id,
            conversation,
            options.outcome ?? 'replied',
            'a'.repeat(64),
            JSON.stringify([{ name: 'synthetic', args: { marker: poison }, result: poison }]),
            poison,
            options.final === undefined ? poison : options.final,
          ],
        );
        await su(`insert into messages(tenant_id,conversation_id,seq,role,content,at) values($1,$2,$3,'customer',$4,now())`, [
          tenant,
          conversation,
          ++seq,
          poison,
        ]);
        if (options.author !== false)
          await su(
            `insert into messages(tenant_id,conversation_id,seq,role,author,content,at,turn_id)
          values($1,$2,$3,$4,$5,$6,now(),$7)`,
            [tenant, conversation, ++seq, options.role ?? 'agent', options.author ?? null, poison, id],
          );
        return id;
      }
      const id = await turn();
      const seedId = await turn({ conversation: 'review-seed', author: 'ai', outcome: 'deterministic' });
      const foreignId = await turn({ tenant: otherId, conversation: 'review-other' });
      const invalidIds = [];
      for (const options of [
        { final: null },
        { final: '' },
        { author: false as const },
        { outcome: 'silent' },
        { outcome: 'reset' },
        { author: 'human' },
        { author: 'followup' },
        { role: 'customer' },
      ])
        invalidIds.push(await turn(options));
      // 同一轮追加分段回复，分页及评分仍只有一轮。
      await su(
        `insert into messages(tenant_id,conversation_id,seq,role,content,at,turn_id) values($1,'review-main',$2,'agent',$3,now(),$4)`,
        [tenantId, ++seq, poison, id],
      );
      const snapshot = async () =>
        JSON.stringify(
          await su(`select c.updated_at::text, c.state::text,
        (select json_agg(row_to_json(m) order by m.seq) from messages m where m.tenant_id=c.tenant_id and m.conversation_id=c.id) as messages
        from conversations c order by c.tenant_id,c.id`),
        );
      const permissionId = await turn();
      const before = await snapshot();
      let permissionRevision = 0;
      for (const profile of ['demo', 'prod'] as const) {
        __profileTest.use({ DEPLOY_PROFILE: profile });
        for (const role of [undefined, ...roles, 'trial-agent']) {
          const allowed = role === 'owner' || role === 'admin';
          for (const [url, method, body] of endpoints(permissionId)) {
            if (allowed && method === 'PUT') (body as { expectedRevision: number }).expectedRevision = permissionRevision++;
            const r = await request(url, role, method, body, role === 'trial-agent' ? otherHost : hostName);
            // 草稿此时还不是差评，其余合法请求成功；非特权角色每个入口都拒绝。
            await status(
              r,
              !role ? 401 : !allowed ? 403 : method === 'POST' ? 422 : 200,
              !role ? 'unauthorized' : !allowed ? 'forbidden' : method === 'POST' ? 'review_not_applicable' : undefined,
            );
          }
        }
      }
      for (const badId of ['not-uuid', randomUUID(), foreignId])
        for (const [url, method, body] of endpoints(badId).slice(1))
          await status(await request(url, 'owner', method, body), 404, 'not_found');
      for (const [url, method, body] of endpoints(id).slice(1))
        await status(await request(url, 'industry-owner', method, body, otherHost), 404, 'not_found');
      const detail = (await (await request(`/${id.toUpperCase()}`, 'owner')).json()) as TurnTraceDetailView;
      assert.equal(detail.conversationId, 'review-main');
      assert.equal(detail.channel, 'wecom');
      assert.equal(detail.customerText, poison);
      assert.equal(detail.finalText, poison);
      assert.equal(detail.handoffKind, null, '内存没有会话时不从 state 拼转人工原因');
      assert.equal(detail.reviewable, true);
      assert.equal(detail.review, null);
      for (const body of [
        { rating: 'bad', expectedRevision: 0 },
        { rating: 'bad', reason: null, expectedRevision: 0 },
        { rating: 'good', reason: 'other', expectedRevision: 0 },
        { rating: 'bad', reason: 'free text', expectedRevision: 0 },
        { rating: 'bad', reason: 'other', expectedRevision: 0, comment: poison },
        { rating: 'bad', reason: 'other', expectedRevision: -1 },
        '{invalid json',
      ])
        await status(await request(`/${id}/review`, 'owner', 'PUT', body), 400);
      await status(await request(`/${id}/review`, 'owner', 'PUT', ' '.repeat(4097)), 413, 'payload_too_large');
      // 权限先于 4 KiB 上限，也先于参数校验。
      await status(await request('/invalid/review', 'agent', 'PUT', ' '.repeat(4097)), 403, 'forbidden');
      for (const badId of invalidIds) {
        await status(await put(badId), 422, 'review_not_applicable');
        assert.equal(((await (await request(`/${badId}`, 'owner')).json()) as TurnTraceDetailView).reviewable, false);
      }
      const readReview = async (turnId = id): Promise<TurnReviewView | null> =>
        (await (await request(`/${turnId}/review`, 'owner')).json()).review;
      const auditCount = async () => Number((await su("select count(*)::int as n from audit_log where action='trace.review'"))[0]!.n);
      const first = await put(id, 'owner', 0, 'good', null);
      await status(first, 200);
      assert.equal((await first.json()).revision, 1);
      const count = await auditCount();
      await status(await put(id, 'owner', 0, 'good', null), 200);
      assert.equal(await auditCount(), count, '幂等不增加审计');
      await status(await put(id, 'admin', 0, 'good', null), 409, 'review_conflict');
      await status(await put(id, 'owner', 0), 409, 'review_conflict');
      await status(await put(id, 'owner', 1), 200);
      assert.deepEqual((await readReview())?.reason, 'incorrect');
      const afterBad = await auditCount();
      await status(await put(id, 'owner', 1), 200);
      assert.equal(await auditCount(), afterBad);
      await status(await put(id, 'owner', 0, 'good', null), 409, 'review_conflict');
      const race = await Promise.all([put(id, 'owner', 2, 'bad', 'missing'), put(id, 'admin', 2, 'bad', 'format')]);
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409], 'CAS 两个竞争者恰好一胜');
      assert.equal((await readReview())?.revision, 3);
      assert.equal(await auditCount(), afterBad + 1, '竞争不丢更新、不多审计');
      const winner = race[0]!.status === 200 ? 'owner' : 'admin';
      const winningReview = (await readReview())!;
      await status(await put(id, winner, 2, 'bad', winningReview.reason), 200);
      await status(await put(id, winner, 1, 'bad', winningReview.reason), 409, 'review_conflict');
      assert.equal(await auditCount(), afterBad + 1, '只允许紧邻 revision 的幂等重放');
      await status(await put(seedId, 'owner', 0, 'bad', 'other'), 200);
      const industryResponse = await request(
        `/${foreignId}/review`,
        'industry-owner',
        'PUT',
        { expectedRevision: 0, rating: 'bad', reason: 'handoff' },
        otherHost,
      );
      await status(industryResponse, 200);
      const list = async (query = ''): Promise<TracePage> => {
        const response = await request(query, 'owner');
        await status(response, 200);
        return response.json();
      };
      assert.equal(await snapshot(), before, '评分不改会话时间与消息字节');
      const unreviewed = await turn();
      const afterFixture = await snapshot();
      // 新夹具的创建单独更新基线，评分前后原有会话和消息不变的断言在它创建前执行。
      const none = await list('?review=none');
      assert.deepEqual(
        none.items.map((r) => r.turnId),
        [unreviewed],
      );
      assert.ok(none.items.every((r) => r.reviewable && r.review === null));
      assert.equal((await list('?review=none&outcome=silent')).items.length, 0);
      assert.equal((await list('?review=none&reason=other')).items.length, 0);
      assert.deepEqual(
        (await list('?review=bad&reason=other')).items.map((r) => r.turnId),
        [seedId],
      );
      assert.equal((await list('?review=good')).items.length, 1);
      const all = await list();
      assert.equal(all.items.filter((r) => r.turnId === id).length, 1, '分段只一轮');
      assert.equal(
        all.items.some((r) => r.turnId === foreignId),
        false,
      );
      const visited = [];
      let cursor: string | null = null;
      do {
        const page: TracePage = await list(`?limit=1${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
        visited.push(...page.items.map((r) => r.turnId));
        cursor = page.next;
      } while (cursor);
      assert.deepEqual(
        visited,
        all.items.map((r) => r.turnId),
        '游标无重复遗漏',
      );
      await status(await request('?review=unknown', 'owner'), 400);
      await status(await request('?reason=free-text', 'owner'), 400);
      await status(await request(`/${unreviewed}/regression-draft`, 'owner', 'POST'), 422, 'review_not_applicable');
      await status(await request(`/${permissionId}/regression-draft`, 'owner', 'POST'), 422, 'review_not_applicable');
      let industrialDraft: RegressionDraft | undefined;
      for (const [turnId, role, hostname] of [
        [id, 'owner', hostName],
        [seedId, 'owner', hostName],
        [foreignId, 'industry-owner', otherHost],
      ]) {
        const response = await request(`/${turnId}/regression-draft`, role, 'POST', undefined, hostname);
        await status(response, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('content-disposition'), 'attachment; filename="regression-draft.json"');
        const text = await response.text();
        for (const forbidden of [poison, marker, '13900001234', '样例甲', '样例路', turnId!, 'review-main', 'review-seed', 'review-other'])
          assert.ok(!text.includes(forbidden));
        const draft = JSON.parse(text) as RegressionDraft;
        assert.deepEqual(Object.keys(draft).sort(), ['_draft', 'case', 'format', 'reason']);
        assert.deepEqual(draft.case, {
          version: 2,
          pack: role === 'industry-owner' ? 'industrial' : 'travel',
          id: '',
          desc: '',
          tags: ['regression'],
          turns: [],
        });
        assert.throws(() => validateCase(draft));
        assert.throws(() => validateCase(draft.case));
        if (role === 'industry-owner') industrialDraft = draft;
      }
      assert.ok(industrialDraft);
      const auditText = JSON.stringify(await su('select row_to_json(a) from audit_log a'));
      for (const forbidden of [
        marker,
        '13900001234',
        '样例甲',
        '样例路',
        id,
        seedId,
        foreignId,
        'review-main',
        'review-seed',
        'review-other',
      ])
        assert.ok(!auditText.includes(forbidden), `审计不得带源内容 ${forbidden}`);
      const audits = await su("select target_type,target_id,diff from audit_log where action in ('trace.review','trace.regression_draft')");
      assert.ok(audits.length > 0);
      for (const row of audits) {
        assert.equal(row.target_type, null);
        assert.equal(row.target_id, null);
        const keys = Object.keys(row.diff as object).sort();
        assert.ok(JSON.stringify(keys) === '["rating","reason","revision"]' || JSON.stringify(keys) === '["format","pack","reason"]');
      }
      // 审计故障用真实数据库触发器，不向生产路径添加测试注入点。
      await su(`create function review_test_fail_audit() returns trigger language plpgsql as $$ begin
        if NEW.action in ('trace.review','trace.regression_draft') then raise exception 'synthetic_audit_failure'; end if;
        return NEW; end $$`);
      await su('create trigger review_test_fail before insert on audit_log for each row execute function review_test_fail_audit()');
      try {
        const current = await readReview();
        await status(await put(id, 'owner', current!.revision, 'good', null), 503, 'store_unavailable');
        assert.deepEqual(await readReview(), current, '审计失败时评分修订回滚');
        await status(await put(unreviewed), 503, 'store_unavailable');
        assert.equal(await readReview(unreviewed), null, '审计失败时首次评分回滚');
        const failedDraft = await request(`/${id}/regression-draft`, 'owner', 'POST');
        await status(failedDraft, 503, 'store_unavailable');
        assert.equal(failedDraft.headers.get('content-disposition'), null);
      } finally {
        await su('drop trigger review_test_fail on audit_log');
        await su('drop function review_test_fail_audit()');
      }
      // 成员展示名取当前成员，不把姓名/邮箱复制到评分表。
      const reviewer = (await su('select reviewer_user_id from turn_reviews where tenant_id=$1 and turn_id=$2', [tenantId, id]))[0]!
        .reviewer_user_id;
      await su("update users set display_name='合成新展示名' where id=$1", [reviewer]);
      assert.equal((await readReview())!.reviewer, '合成新展示名');
      await su('delete from memberships where tenant_id=$1 and user_id=$2', [tenantId, reviewer]);
      // 如果获胜者是 owner，改由 admin 读取；保证读取者仍有权限。
      const reader = reviewer === tokens.get('owner')!.userId ? 'admin' : 'owner';
      const removed = await request(`/${id}/review`, reader);
      await status(removed, 200);
      assert.equal((await removed.json()).review.reviewer, '已移除成员');
      // 外部文件从空草稿人工补成独立合成工业用例；原样与反向预期分别验证成功/失败。
      const caseFile = path.join(directory, 'synthetic-case.json');
      const executable = {
        ...industrialDraft.case,
        id: 'review-synthetic-industrial',
        desc: '合成回复行为',
        turns: [{ say: '你好', script: [{ content: '您好，请提供型号。' }], expect: { replyMatches: ['型号'] } }],
      };
      validateCase(executable);
      const runCase = () =>
        spawnSync('pnpm', ['exec', 'tsx', path.join(root, 'eval/run.ts'), '--cases-v2', caseFile], {
          cwd: directory,
          env: {
            ...process.env,
            CONFIG_SOURCE: 'file',
            CONFIG_TEST_DB: '',
            LLM_MOCK: '1',
            EVAL_V2_BASELINE: 'off',
            VAR_DIR: path.join(directory, 'eval'),
          },
          encoding: 'utf8',
          timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      fs.writeFileSync(caseFile, JSON.stringify([executable]));
      const success = runCase();
      assert.equal(success.status, 0, success.stderr + success.stdout);
      executable.turns[0]!.expect.replyMatches = ['IMPOSSIBLE_EXPECTATION_3719'];
      fs.writeFileSync(caseFile, JSON.stringify([executable]));
      const failure = runCase();
      assert.equal(failure.status, 1, failure.stderr + failure.stdout);
      assert.match(failure.stdout, /IMPOSSIBLE_EXPECTATION_3719/, '实际失败为断言不匹配');
      // 静态边界补充运行时内容污染测试：新草稿路由不调用旧 exporter/正文 reader。
      const builderSource = fs.readFileSync(path.join(root, 'src/console-api/review-draft.ts'), 'utf8');
      assert.doesNotMatch(builderSource, /(?:import|from).*goal-draft/);
      const routeSource = fs
        .readFileSync(path.join(root, 'src/console-api/app.ts'), 'utf8')
        .split(".post('/traces/:turnId/regression-draft'")[1]!
        .split('// ---------------- AI 记录')[0]!;
      assert.doesNotMatch(
        routeSource,
        /readTurnTrace|readTurnCustomerMessage|readTurnExportSource|readReviewState|buildGoalDraft|finalText|draft:|\.calls|\.signals|\.state/,
      );
      const projectionSource = fs
        .readFileSync(path.join(root, 'src/db/repo/turn-reviews.ts'), 'utf8')
        .split('export async function readRegressionReason')[1]!
        .split('export async function readReviewState')[0]!;
      assert.doesNotMatch(projectionSource, /select\s+\*|t\.(?:final_text|draft|calls|llm|signals)|c\.state|reviewableSql/);
      assert.equal(await snapshot(), afterFixture, '导出与失败事务不改会话或消息');
      console.log(`${mode} REVIEWS SQL/HTTP PASS：角色、两租户、CAS、幂等、筛选、分段、审计回滚、无源草稿、外部 v2 正反例`);
      // 沙箱拒绝新能力，列表只有新增筛选才拒绝；仍经 server.ts。
      const { Hono } = await import('hono');
      const { setSandboxSession } = await import('../tenancy/sandbox/session.js');
      const sandbox = createTenantRuntime({ id: randomUUID(), slug: 'reviews-sandbox', kind: 'sandbox' });
      sandbox.config.dbInstalled = true;
      const sandboxApp = new Hono()
        .use('*', async (c, next) => {
          setSandboxSession(c, {
            status: 'ok',
            token: 'synthetic',
            runtime: sandbox,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            user: { userId: randomUUID(), tenantId: sandbox.id, role: 'owner', displayName: '合成', csrf: 'synthetic' },
          });
          return next();
        })
        .route('/', app);
      for (const [url, method, body] of [...endpoints('invalid'), ['?reason=other', 'GET']] as [string, string, unknown?][])
        await status(
          await sandboxApp.request(`/api/console/traces${url}`, {
            method,
            headers: {
              'x-csrf': 'synthetic',
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body ? JSON.stringify(body) : '')),
            },
            body: body ? JSON.stringify(body) : undefined,
          }),
          403,
          'observability_unavailable',
        );
      await status(await sandboxApp.request('/api/console/traces'), 503, 'store_file_mode');
      await su("update tenants set status='suspended' where id=$1", [otherId]);
      for (const [url, method, body] of endpoints(foreignId))
        await status(await request(url, 'industry-owner', method, body, otherHost), 401, 'unauthorized');
    } finally {
      delete process.env.TRIAL_TENANT_ALLOWLIST;
      __consoleTest.reset();
      __profileTest.reset();
      await runShutdownHooks();
      if (industry) {
        await withTenantScope(industry, async () => {
          await industry!.store.pgBackend?.close();
          await closeConfig();
        });
        unregisterRuntime(industry.id);
      }
      await host.store.pgBackend?.close();
      await closeConfig();
      await closeDb();
    }
  }
}
