// 07 R15 嵌入端点白名单自测：清单与按主机判断的函数、readEmbedding 发请求之前的检查、DB 模式启动校验。
// 不连外网：全局 fetch 被替换成计数的假实现（结束还原），DB 是 PGlite。
// 用法：npx tsx src/core/llm/endpoints.selftest.ts
import '../../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostRuntime, withoutTenantScope } from '../../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
const root = path.join(import.meta.dirname, '..', '..', '..');
const varDir = fs.mkdtempSync(path.join(process.env.VAR_DIR ?? os.tmpdir(), 'wecom-endpoints-selftest-'));
process.env.VAR_DIR = varDir;
// 设成空串而不是 delete：env.ts 只补「尚不存在」的变量，空串挡得住本机 .env 里的真实配置
for (const k of [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'ZHIPU_BASE_URL',
  'ZHIPU_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_API_KEY',
  'EMBED_BASE_URL',
  'EMBED_API_KEY',
  'EMBED_MODEL',
]) {
  process.env[k] = '';
}
process.env.LLM_MOCK = '0';
process.env.LLM_MAX_RETRY = '0';
// 开发机 .env 里写着 CONFIG_SOURCE=db 也不能影响这组：DB 模式只经 initConfig(deps) 显式装上
process.env.CONFIG_SOURCE = 'file';
process.env.SOP_PATH = path.join(root, 'data', 'sop.md');
process.env.ROUTES_PATH = path.join(root, 'data', 'routes.json');
process.env.HOTELS_PATH = path.join(root, 'data', 'hotels.json');

const { embedEndpointAllowed, embedEndpointHost } = await import('./endpoints.js');
const { __profileTest } = await import('../../profile.js');
await withoutTenantScope(() => import('../engine/sources.js')); // 同 src/retrieval.ts：先装好检索要用的运行时能力
const retrieval = await withoutTenantScope(() => import('../retrieval.js'));
const cfg = await withoutTenantScope(() => import('../../config/source.js'));
const { boot } = await withoutTenantScope(() => import('../../boot.js'));
const { queryCount } = await withoutTenantScope(() => import('../../db/client.js'));
const { openTestDb, installSeededConfig, testConfigDeps, fakeLock } = await withoutTenantScope(() => import('../../db/testing.js'));

let pass = 0;
function ok(cond: unknown, message: string): void {
  assert.ok(cond, message);
  pass += 1;
}
function equal<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message);
  pass += 1;
}

const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4';
const EVIL = 'https://embed.evil.example/v1';
const KEY = 'sk-endpoints-selftest'; // gitleaks:allow

/** 收集 console.error / warn / log 的输出，结束还原 */
async function captured<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string[] }> {
  const logs: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const push = (...a: unknown[]): void => {
    logs.push(a.map(String).join(' '));
  };
  console.error = console.warn = console.log = push;
  try {
    return { out: await fn(), logs };
  } finally {
    Object.assign(console, saved);
  }
}

// ---------------- 1 清单与按主机判断的函数 ----------------
{
  for (const url of [
    ZHIPU,
    `${ZHIPU}/`,
    'https://open.bigmodel.cn',
    'https://OPEN.bigmodel.cn/api/paas/v4',
    'https://open.bigmodel.cn:8443/api/paas/v4',
  ]) {
    ok(embedEndpointAllowed(url), `清单内主机（https）放行：${url}`);
  }
  // 公网主机必须 https：明文 http 即使主机在清单里也拒绝
  for (const url of [
    'http://open.bigmodel.cn/api/paas/v4',
    'http://open.bigmodel.cn',
    'http://open.bigmodel.cn:80/api/paas/v4',
    'HTTP://OPEN.BIGMODEL.CN/v1',
  ]) {
    ok(!embedEndpointAllowed(url), `清单内主机但是明文 http，不放行：${url}`);
  }
  for (const url of [
    'https://api.openai.com/v1',
    'https://embed.evil.example/v1',
    'https://open.bigmodel.cn.evil.example/api/paas/v4', // 前缀像
    'https://evil-open.bigmodel.cn/v1', // 后缀像
    'https://api.bigmodel.cn/v1', // 同一个主域的别的主机也不放行：清单按主机写
    'https://bigmodel.cn/v1',
    'https://open.bigmodel.cn@embed.evil.example/v1', // 主机在 @ 后面
    'https://embed.evil.example/open.bigmodel.cn',
    'https://embed.evil.example/?h=open.bigmodel.cn',
    'ftp://open.bigmodel.cn/v1',
    'open.bigmodel.cn/api/paas/v4', // 没有协议
    'not a url',
    '',
  ]) {
    ok(!embedEndpointAllowed(url), `清单外或解析不了的地址不放行：${url || '（空）'}`);
  }

  // 回环：非 prod 放行 127.0.0.1 与 localhost（http / https、任意端口）；未设 DEPLOY_PROFILE 按 demo
  const loopbacks = [
    'http://127.0.0.1:8080/v1',
    'https://127.0.0.1/v1',
    'http://localhost:3000',
    'https://localhost:8443/v1',
    'http://LOCALHOST/v1',
  ];
  const lookalikes = [
    'http://127.0.0.1.evil.example/v1',
    'http://localhost.evil.example/v1',
    'http://[::1]:8080/v1', // 清单只写了这两个名字
    'http://0.0.0.0:8080/v1',
    'http://127.0.0.2:8080/v1',
  ];
  const useProfile = (env: Record<string, string | undefined>): void => __profileTest.use(env);
  try {
    useProfile({ DEPLOY_PROFILE: 'demo' });
    for (const url of loopbacks) ok(embedEndpointAllowed(url), `demo 下回环放行：${url}`);
    for (const url of lookalikes) ok(!embedEndpointAllowed(url), `demo 下长得像回环的也不放行：${url}`);
    useProfile({});
    ok(embedEndpointAllowed('http://127.0.0.1:9/v1'), '没设 DEPLOY_PROFILE 按 demo：回环放行（K2）');
    useProfile({ DEPLOY_PROFILE: 'prod' });
    for (const url of loopbacks) ok(!embedEndpointAllowed(url), `prod 下回环不放行：${url}`);
    ok(embedEndpointAllowed(ZHIPU), 'prod 下清单内主机照样放行');
    // 按调用时的 profile() 判断：同一个地址，切一次结果跟着变，切回来又变回去
    __profileTest.reset();
    ok(embedEndpointAllowed('http://127.0.0.1:9/v1'), '还原之后回环又放行（selftest-env 钉的 demo）');
  } finally {
    __profileTest.reset();
  }

  // profile() 自己解析失败（环境变量非法）时按最严的 prod 算：回环不放行，清单内主机照旧
  const savedProfile = process.env.DEPLOY_PROFILE;
  process.env.DEPLOY_PROFILE = 'bogus';
  __profileTest.reset();
  try {
    ok(!embedEndpointAllowed('http://127.0.0.1:9/v1'), 'profile 解析失败：回环不放行');
    ok(embedEndpointAllowed(ZHIPU), 'profile 解析失败：清单内主机照旧放行');
  } finally {
    process.env.DEPLOY_PROFILE = savedProfile;
    __profileTest.reset();
  }

  equal(
    embedEndpointHost('https://user:topsecret@embed.evil.example:8443/v1'),
    'embed.evil.example',
    '给日志的只有主机，没有账号口令与端口',
  );
  const unparsable = embedEndpointHost('topsecret not a url');
  ok(!unparsable.includes('topsecret'), `解析不了的地址不回显原文（${unparsable}）`);
}

// ---------------- 2 embedCfg 仍是纯函数：原样返回，不抛、不过滤（K1） ----------------
{
  process.env.EMBED_BASE_URL = `${EVIL}/`;
  process.env.EMBED_API_KEY = KEY;
  equal(retrieval.embedCfg(), { baseUrl: EVIL, apiKey: KEY }, '白名单外的地址 embedCfg 照旧原样返回（去掉末尾斜杠），不抛');
}

// ---------------- 3 readEmbedding：文件模式，请求发出去之前再查一遍 ----------------
{
  const realFetch = globalThis.fetch;
  const requests: { url: string; auth: string | null; body: string }[] = [];
  const vec = (text: string): number[] => {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) v[i % 4]! += text.charCodeAt(i) % 31;
    return v;
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, auth: headers.get('authorization'), body: String(init?.body ?? '') });
    const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: texts.map((t) => ({ embedding: vec(t) })), usage: { prompt_tokens: texts.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  // 换一个地址重来：清掉内存索引，也清掉磁盘缓存（缓存命中不经 readEmbedding，会让下面的计数对不上）
  const point = (url: string, key = KEY): void => {
    process.env.EMBED_BASE_URL = url;
    process.env.EMBED_API_KEY = key;
    retrieval.__retrievalTest.reset();
    for (const f of fs.readdirSync(varDir)) if (f.includes('vectors')) fs.rmSync(path.join(varDir, f), { force: true });
  };
  const QUERY = '想带爸妈看看雪山，节奏慢一点';
  try {
    ok(cfg.configMode() === 'file', '这一段是文件模式');

    // K4：LLM_MOCK=1 的判断排在白名单检查之前——白名单外的地址也只打「跳过」、不报端点、不发请求
    point(EVIL);
    process.env.LLM_MOCK = '1';
    const mock = await captured(() => retrieval.buildIndex());
    process.env.LLM_MOCK = '0';
    ok(
      mock.logs.some((l) => l.includes('mock 模式跳过语义索引')) && !mock.logs.some((l) => l.includes('不在境内已备案清单')),
      `mock：照旧打「跳过语义索引」，不提端点（${mock.logs.join(' | ')}）`,
    );
    equal(requests.length, 0, 'mock：一次 fetch 都没发');
    ok(!retrieval.indexReady() && (await retrieval.semanticRecall(QUERY)) === null, 'mock：索引没建、语义召回返回 null（关键词）');

    // 白名单外的主机：建索引一次 fetch 都不发，语义召回不可用（调用方走关键词）。地址里带着账号口令，日志里不能有
    point('https://user:topsecret@embed.evil.example/v1');
    const blocked = await captured(() => retrieval.buildIndex());
    equal(requests.length, 0, '白名单外：建索引一次 fetch 都没发');
    ok(!retrieval.indexReady(), '白名单外：索引没建起来');
    const errors = blocked.logs.filter((l) => l.includes('不在境内已备案清单'));
    ok(errors.length === 1 && errors[0]!.includes('embed.evil.example'), `白名单外：记一条错误，点名主机（${blocked.logs.join(' | ')}）`);
    ok(!blocked.logs.some((l) => l.includes(KEY) || l.includes('topsecret')), '日志里没有 key，也没有地址里的账号口令');
    ok(retrieval.indexHealth().lastError !== null, '白名单外：indexHealth 记下了构建失败');
    ok((await retrieval.semanticRecall(QUERY)) === null, '白名单外：语义召回返回 null');

    // 清单内主机但是明文 http：同样一次 fetch 都不发（启动校验与这里是同一个判断）
    point(ZHIPU.replace('https:', 'http:'));
    const plain = await captured(() => retrieval.buildIndex());
    equal(requests.length, 0, '明文 http：建索引一次 fetch 都没发');
    ok(!retrieval.indexReady(), '明文 http：索引没建起来');
    ok(
      plain.logs.filter((l) => l.includes('不在境内已备案清单')).length === 1 && plain.logs.some((l) => l.includes('open.bigmodel.cn')),
      `明文 http：记一条错误（${plain.logs.join(' | ')}）`,
    );

    // 清单内主机：请求照常发出（假 fetch 应答），索引建成
    point(ZHIPU);
    const built = await captured(() => retrieval.buildIndex());
    ok(retrieval.indexReady(), `清单内：索引建成（${built.logs.join(' | ')}）`);
    equal(requests.length, 1, '清单内：建索引恰好一次请求');
    equal(requests[0]!.url, `${ZHIPU}/embeddings`, '清单内：请求发往配置的地址');
    equal(requests[0]!.auth, `Bearer ${KEY}`, '清单内：带着配置的 key');
    ok((await retrieval.semanticRecall(QUERY, 3))?.length === 3, '清单内：语义召回照常');
    equal(requests.length, 2, '清单内：查询向量也是一次请求');
    ok(requests[1]!.body.includes(QUERY), '（假 fetch 确实收到了查询原文）');

    // 索引已经在（比如从磁盘缓存装回来）而地址换成白名单外：客户这句话的查询向量不能发出去
    const before = requests.length;
    process.env.EMBED_BASE_URL = EVIL;
    const query = await captured(() => retrieval.semanticRecall(QUERY, 3));
    equal(requests.length, before, '白名单外：查询（含客户原文）一次 fetch 都没发');
    ok(query.out === null, '白名单外：语义召回返回 null，调用方退回关键词');
    ok(
      query.logs.length === 1 &&
        query.logs[0]!.includes('embed.evil.example') &&
        !query.logs[0]!.includes(QUERY) &&
        !query.logs[0]!.includes(KEY),
      `白名单外：一条错误日志，只有主机，没有查询原文与 key（${query.logs.join(' | ')}）`,
    );
    process.env.EMBED_BASE_URL = ZHIPU;
    ok((await retrieval.semanticRecall(QUERY, 3))?.length === 3 && requests.length === before + 1, '地址改回清单内，同一个索引立刻又能用');

    // K4：LLM_MOCK=1 的判断排在白名单检查之前——索引已在、地址在清单外，mock 下查询照旧静默返回 null：不发请求、不报端点
    process.env.EMBED_BASE_URL = EVIL;
    process.env.LLM_MOCK = '1';
    const mockQuery = await captured(() => retrieval.semanticRecall(QUERY, 3));
    process.env.LLM_MOCK = '0';
    ok(mockQuery.out === null && mockQuery.logs.length === 0, `mock：查询静默返回 null，不报端点（${mockQuery.logs.join(' | ')}）`);
    equal(requests.length, before + 1, 'mock：查询没发请求');
    process.env.EMBED_BASE_URL = ZHIPU;

    // 回环：demo 放行（假服务能建索引，K2）；调用时切成 prod 就拒绝
    const loop = 'http://127.0.0.1:18081/v1';
    point(loop);
    const base = requests.length;
    await captured(() => retrieval.buildIndex());
    ok(retrieval.indexReady() && requests.length === base + 1 && requests.at(-1)!.url === `${loop}/embeddings`, 'demo：回环假服务能建索引');
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    try {
      const inProd = await captured(() => retrieval.semanticRecall(QUERY, 3));
      equal(requests.length, base + 1, 'prod：回环地址的查询一次 fetch 都没发');
      ok(inProd.out === null && inProd.logs.some((l) => l.includes('127.0.0.1')), 'prod：回环被拒，语义召回返回 null，日志点名主机');
      point(loop);
      await captured(() => retrieval.buildIndex());
      equal(requests.length, base + 1, 'prod：回环地址建索引一次 fetch 都没发');
      ok(!retrieval.indexReady(), 'prod：索引没建起来');
    } finally {
      __profileTest.reset();
    }

    // 没配 key：本来就不发请求，也不报端点错误（日志不增加噪音）
    point(EVIL, '');
    const noKey = await captured(() => retrieval.buildIndex());
    ok(!noKey.logs.some((l) => l.includes('不在境内已备案清单')), '没配 key：照旧只提示没配 key，不报端点');
  } finally {
    globalThis.fetch = realFetch;
    __profileTest.reset();
    process.env.EMBED_BASE_URL = '';
    process.env.EMBED_API_KEY = '';
    process.env.LLM_MOCK = '0';
    retrieval.__retrievalTest.reset();
  }
}

// ---------------- 4 DB 模式：启动校验（PGlite，不连外网） ----------------
{
  const t = await openTestDb();
  try {
    const queriesBefore = queryCount();
    process.env.EMBED_API_KEY = KEY;

    // 4.1 白名单外的主机：拒绝启动，原因 embed_endpoint_forbidden；不碰库、不取锁
    const reasonOf = async (over: Parameters<typeof testConfigDeps>[1] = {}): Promise<{ reason: string; detail: string }> => {
      cfg.__configTest.reset();
      try {
        await cfg.initConfig(testConfigDeps(t, over));
        return { reason: 'ok', detail: '' };
      } catch (e) {
        return e instanceof cfg.ConfigStartupError ? { reason: e.reason, detail: e.detail } : { reason: String(e), detail: '' };
      }
    };
    let lockCalls = 0;
    const counting = {
      lock: async () => {
        lockCalls += 1;
        return fakeLock();
      },
    };
    process.env.EMBED_BASE_URL = 'https://user:topsecret@embed.evil.example/v1';
    const refused = await reasonOf(counting);
    equal(refused.reason, 'embed_endpoint_forbidden', 'DB 模式：EMBED_BASE_URL 指向白名单外的主机 → 拒绝启动');
    ok(
      refused.detail.includes('embed.evil.example') && !refused.detail.includes('topsecret') && !refused.detail.includes(KEY),
      `拒绝说明点名主机，没有账号口令与 key（${refused.detail}）`,
    );
    equal(queryCount(), queriesBefore, '拒绝发生在连库之前：一条 SQL 都没发');
    equal(lockCalls, 0, '拒绝发生在取租户锁之前');
    ok(cfg.configMode() === 'file', '拒绝之后不留半装载状态');

    // 清单内主机但是明文 http：同样拒绝启动
    process.env.EMBED_BASE_URL = ZHIPU.replace('https:', 'http:');
    equal((await reasonOf()).reason, 'embed_endpoint_forbidden', 'DB 模式：清单内主机但是明文 http → 拒绝启动');
    process.env.EMBED_BASE_URL = 'https://user:topsecret@embed.evil.example/v1';

    // 只配了地址、没配 key 也拒绝：验收写的是「EMBED_BASE_URL 指向白名单外的主机」
    process.env.EMBED_API_KEY = '';
    equal((await reasonOf()).reason, 'embed_endpoint_forbidden', '没配 key 也拒绝');
    process.env.EMBED_API_KEY = KEY;

    // 不配 EMBED_BASE_URL、主模型是白名单外的主机时，嵌入跟着主模型走（embedCfg 的回落），同样拒绝
    process.env.EMBED_BASE_URL = '';
    process.env.LLM_BASE_URL = 'https://llm.evil.example/v1';
    equal((await reasonOf()).reason, 'embed_endpoint_forbidden', '没配 EMBED_BASE_URL：回落到主模型地址，主机不在清单里也拒绝');
    process.env.LLM_BASE_URL = '';

    // 4.2 boot()：拒绝启动，serve 之类一个都没调，日志点名原因
    process.env.EMBED_BASE_URL = EVIL;
    const calls: string[] = [];
    const exits: number[] = [];
    const booted = await captured(async () => {
      cfg.__configTest.reset();
      await boot({
        initConfig: () => cfg.initConfig(testConfigDeps(t)),
        initSessionStore: async () => void calls.push('store'),
        initChannels: async () => void calls.push('channels'),
        serve: () => void calls.push('serve'),
        preflight: () => void calls.push('preflight'),
        buildIndex: async () => void calls.push('buildIndex'),
        storeMode: () => 'file',
        startFollowUpScheduler: () => void calls.push('followup'),
        startJobs: () => void calls.push('jobs'),
        startChannels: () => void calls.push('startChannels'),
        exit: (c) => void exits.push(c),
      });
    });
    ok(
      exits.join() === '1' &&
        calls.length === 0 &&
        booted.logs.some((l) => l.includes('（embed_endpoint_forbidden）') && l.includes('embed.evil.example')),
      `boot：以 embed_endpoint_forbidden 拒绝启动，会话存储、渠道、监听都没调（${exits} ${calls} ${booted.logs.join(' | ')}）`,
    );

    // 4.3 prod 下回环也拒绝（按调用时的 profile()）
    process.env.EMBED_BASE_URL = 'http://127.0.0.1:18081/v1';
    __profileTest.use({ DEPLOY_PROFILE: 'prod' });
    try {
      equal((await reasonOf()).reason, 'embed_endpoint_forbidden', 'DB 模式 prod：回环地址拒绝启动');
    } finally {
      __profileTest.reset();
    }

    // 4.4 清单内主机、非 prod 的回环、LLM_MOCK=1 下任意地址：正常启动
    process.env.EMBED_BASE_URL = ZHIPU;
    cfg.__configTest.reset();
    await installSeededConfig(t);
    ok(cfg.configMode() === 'db' && cfg.currentSop().versionNo >= 1, 'DB 模式：EMBED_BASE_URL 指向清单内主机，正常启动');

    process.env.EMBED_BASE_URL = '';
    equal((await reasonOf()).reason, 'ok', 'DB 模式：没配 EMBED_BASE_URL、主模型走默认的智谱地址，正常启动');
    process.env.EMBED_BASE_URL = 'http://127.0.0.1:18081/v1';
    equal((await reasonOf()).reason, 'ok', 'DB 模式 demo：回环地址正常启动');
    process.env.EMBED_BASE_URL = EVIL;
    process.env.LLM_MOCK = '1';
    equal((await reasonOf()).reason, 'ok', 'LLM_MOCK=1：不发任何请求，白名单外的地址也照常启动（行为不变）');
    process.env.LLM_MOCK = '0';

    // 4.5 文件模式：什么都不拒绝，也不多打一行
    cfg.__configTest.reset();
    process.env.EMBED_BASE_URL = ZHIPU;
    const fileOk = await captured(() => cfg.initConfig(null));
    cfg.__configTest.reset();
    process.env.EMBED_BASE_URL = EVIL;
    const fileEvil = await captured(() => cfg.initConfig(null));
    ok(cfg.configMode() === 'file', '文件模式：白名单外的地址不拒绝启动');
    equal(fileEvil.logs, fileOk.logs, '文件模式：启动输出与清单内地址时逐行相同，没有新增一行');
  } finally {
    cfg.__configTest.reset();
    process.env.EMBED_BASE_URL = '';
    process.env.EMBED_API_KEY = '';
    process.env.LLM_BASE_URL = '';
    process.env.LLM_MOCK = '0';
    __profileTest.reset();
    await t.close();
  }
}

fs.rmSync(varDir, { recursive: true, force: true });
console.log(`ENDPOINTS SELFTEST PASS: ${pass} 项断言全通（清单与回环、readEmbedding 发请求前检查、DB 模式启动校验、mock 与文件模式不变）`);
