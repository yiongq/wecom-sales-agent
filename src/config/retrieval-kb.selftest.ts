// 07 R11–R13 / 验收 6：线路向量进 Postgres、装载、增量嵌入。
// 计数的假嵌入服务是本机回环（非 prod 的端点白名单放行，R15），所以这组自测不设 LLM_MOCK（mock 下 readEmbedding 一个请求都不发）。
// - 真实 PG（PG_TEST_URL，pgvector 镜像）：向量真的在 kb_vectors 里、装载进内存、每轮不查库、重启不重嵌、改一条只嵌一块、
//   嵌入失败不动库、维数不对只放内存、DB 模式不碰 var/route-vectors.json。向量一律合成，不调真实嵌入接口。
// - PGlite（没有 vector 扩展，没有 kb_vectors）：DB 模式退回进程内建索引、不持久，也不碰 var/route-vectors.json；mock 下装载不抛（K8）。
// 沙箱开通复制与删除在 src/tenancy/sandbox/kb-copy.selftest.ts；跨租户读不到、级联、迁移失败在 src/db/db.selftest.ts。
// 用法：PG_TEST_URL=… npx tsx src/config/retrieval-kb.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
const root = path.join(import.meta.dirname, '..', '..');
const varDir = fs.mkdtempSync(path.join(process.env.VAR_DIR ?? os.tmpdir(), 'wecom-retrieval-kb-selftest-'));
process.env.VAR_DIR = varDir;
for (const k of [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'ZHIPU_BASE_URL',
  'ZHIPU_API_KEY',
  'EMBED_BASE_URL',
  'EMBED_API_KEY',
  'EMBED_MODEL',
]) {
  process.env[k] = '';
}
process.env.LLM_MOCK = '';
process.env.LLM_MAX_RETRY = '0'; // 假服务回 500 就是一次失败，不让网关重试
process.env.CONFIG_SOURCE = 'file';
process.env.PACK_FIXTURES = '1';

const retrieval = await withoutTenantScope(() => import('../retrieval.js'));
const cfg = await withoutTenantScope(() => import('./source.js'));
const cat = await withoutTenantScope(() => import('./catalog.js'));
const { importConfig } = await withoutTenantScope(() => import('./transfer.js'));
const { executeTool } = await withoutTenantScope(() => import('../tools.js'));
const { getOrCreateSession } = await withoutTenantScope(() => import('../store.js'));
const { openDb, queryCount } = await withoutTenantScope(() => import('../db/client.js'));
const { withTenant } = await import('../db/client.js');
const { bindPack } = await import('../core/pack-api.js');
const { packById, runtimeById } = await import('../packs/registry.js');
const { readKbSnapshot, writeKbSync } = await import('../db/repo/kb.js');
const { openTestDb, installSeededConfig, testConfigDeps, fakeLock, createRealPgFixture } = await withoutTenantScope(
  () => import('../db/testing.js'),
);

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------- 计数的假嵌入服务 ----------------
// 向量按字符码位落到 2048 维上（与 kb_vectors 的列宽一样）：一条线路的正文作为查询，余弦恰好为 1，召回里排第一
let dims = 2048;
const vecOf = (text: string): number[] => {
  const v = Array.from({ length: dims }, () => 0);
  for (const c of text) v[c.codePointAt(0)! % dims]! += 1;
  return v;
};
const requests: string[][] = [];
let failEmbeds = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d: Buffer) => (body += d.toString()));
  req.on('end', () => {
    const { input } = JSON.parse(body) as { input: string[] };
    requests.push(input);
    if (failEmbeds) {
      res.statusCode = 500;
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: input.map((x) => ({ embedding: vecOf(x) })), usage: { prompt_tokens: input.length } }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
process.env.EMBED_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.EMBED_API_KEY = 'fake-key'; // gitleaks:allow

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  for (let i = 0; i < ms / 10 && !(await cond()); i++) await wait(10);
  return cond();
}
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
// 开工数据全部 20 块的（source, ref, body_hash）指纹；正文与引用的顺序变化也会被发现。
const travelChunksHash = 'e5dfed29b80c71a4fe004e4921821c884cfe954501cf9aab8073118fd9bf7e19';
const chunksHash = (rows: { source: string; ref: string; body_hash: string }[]): string =>
  sha256(JSON.stringify(rows.sort((a, b) => a.ref.localeCompare(b.ref)).map((r) => [r.source, r.ref, r.body_hash])));
let simSeq = 0;
const freshSession = (): import('../types.js').Session => getOrCreateSession(`sim-kbtest${String(simSeq++).padStart(4, '0')}`, 'simulator');
const cacheFile = path.join(varDir, 'route-vectors.json');
/** 现在的线路正文：和 retrieval 装载时用的同一个函数 */
const routeTexts = (): Map<string, string> =>
  new Map(
    cfg
      .currentPack()
      .runtime.retrievalItems()
      .map((item) => [item.code, cfg.currentPack().runtime.retrievalText(item)]),
  );
const topHit = async (q: string): Promise<string | undefined> => (await retrieval.semanticRecall(q, 1))?.[0]?.id;
const captureLogs = async <T>(fn: () => Promise<T>): Promise<{ out: T; logs: string[] }> => {
  const logs: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    return { out: await fn(), logs };
  } finally {
    Object.assign(console, saved);
  }
};

// ---------------- 真实 PG ----------------
async function realPostgres(url: string): Promise<void> {
  const f = await createRealPgFixture(url, { slug: 'kbhost' });
  const app = await openDb(f.urls.app);
  const T = f.tenantId;
  const kbRows = async (): Promise<{ chunks: number; vectors: number }> => {
    const [c] = await f.query<{ n: number }>('select count(*)::int as n from kb_chunks where tenant_id = $1', [T]);
    const [v] = await f.query<{ n: number }>('select count(*)::int as n from kb_vectors where tenant_id = $1', [T]);
    return { chunks: c!.n, vectors: v!.n };
  };
  const idle = (): boolean => !retrieval.indexHealth().stale && retrieval.indexHealth().indexGeneration === cfg.currentCatalog().generation;
  try {
    cfg.__configTest.reset();
    retrieval.__retrievalTest.reset();
    retrieval.__retrievalTest.setBackoff([20]);
    const deps = testConfigDeps({ db: app.db }, { tenantSlug: 'kbhost' });
    const imported = await importConfig({
      db: app.db,
      tenantSlug: 'kbhost',
      dataDir: path.join(root, 'data'),
      imageSop: deps.imageSop,
      lock: async () => fakeLock(),
    });
    check('真实 PG：导入 data/ 成功', imported.code === 0, imported.message);
    await cfg.initConfig(deps);
    const ctx: import('../db/client.js').TenantCtx = { tenantId: T, actor: { kind: 'user', userId: null, name: '运营甲', ip: null } };
    const texts = routeTexts();
    const ids = [...texts.keys()];
    check('真实 PG：装载了 20 条线路', ids.length === 20, String(ids.length));
    check('真实 PG：装载之前两张表都是空的', JSON.stringify(await kbRows()) === JSON.stringify({ chunks: 0, vectors: 0 }));

    // ---- 1 第一次装载：库是空的，全部块一次嵌入、一个事务写回 ----
    const first = await captureLogs(() => retrieval.buildIndex());
    check(
      '真实 PG：第一次装载发了恰好一个嵌入请求，带全部 20 块',
      requests.length === 1 && requests[0]!.length === 20,
      JSON.stringify(requests.map((r) => r.length)),
    );
    check(
      '真实 PG：请求里是每条线路的 retrievalText',
      requests[0]!.every((t, i) => t === texts.get(ids[i]!)),
    );
    const after = await kbRows();
    check('真实 PG：写进 kb_chunks 20 块、kb_vectors 20 个向量', after.chunks === 20 && after.vectors === 20, JSON.stringify(after));
    check(
      '真实 PG：旅游全部知识块 source/ref/body_hash 与开工指纹相同',
      chunksHash(await f.query('select source, ref, body_hash from kb_chunks where tenant_id = $1', [T])) === travelChunksHash,
    );
    const [chunk] = await f.query<{ ref: string; source: string; body: string; body_hash: string }>(
      `select ref, source, body, body_hash from kb_chunks where tenant_id = $1 and ref = $2`,
      [T, ids[0]],
    );
    check(
      '真实 PG：块的身份是（route, 线路 id），正文是 retrievalText，body_hash 是它的 sha256',
      chunk?.source === 'route' && chunk.body === texts.get(ids[0]!) && chunk.body_hash === sha256(texts.get(ids[0]!)!),
      JSON.stringify(chunk),
    );
    const [vector] = await f.query<{ model: string; body_hash: string; dims: number; first: string }>(
      `select v.model, v.body_hash, vector_dims(v.embedding) as dims, (v.embedding::text::json -> 0)::text as first
         from kb_vectors v join kb_chunks c on c.tenant_id = v.tenant_id and c.id = v.chunk_id where c.tenant_id = $1 and c.ref = $2`,
      [T, ids[0]],
    );
    check(
      '真实 PG：向量是 2048 维 halfvec，带模型名和算它时那块正文的哈希',
      vector?.model === 'embedding-3' && vector.body_hash === sha256(texts.get(ids[0]!)!) && vector.dims === 2048,
      JSON.stringify(vector),
    );
    check(
      '真实 PG：索引就绪，日志说明是从库装载',
      retrieval.indexReady() && first.logs.some((l) => l.includes('从库装载') && l.includes('新嵌入 20')),
      first.logs.join(' | '),
    );
    check(
      '真实 PG：DB 模式没有写 var/route-vectors.json',
      !fs.existsSync(cacheFile) && fs.readdirSync(varDir).every((x) => !x.startsWith('route-vectors')),
    );

    // ---- 2 每轮不查库：5 轮带检索的对话，查询向量照旧每次现算 ----
    const reqBefore = requests.length;
    const q0 = queryCount();
    const asked = ids.slice(0, 5);
    const tops: (string | undefined)[] = [];
    for (const id of asked) {
      const out = JSON.parse(await executeTool('search_routes', { query: texts.get(id)! }, freshSession())) as
        | { id?: string }[]
        | { routes?: { id: string }[] };
      const list = Array.isArray(out) ? out : (out.routes ?? []);
      tops.push(list[0]?.id);
    }
    check('真实 PG：5 轮检索之后 queryCount 没变（读路径只用内存索引）', queryCount() === q0, `${q0} → ${queryCount()}`);
    check(
      '真实 PG：每轮检索只发一个单条的查询嵌入请求，没有再建索引',
      requests.length - reqBefore === 5 && requests.slice(reqBefore).every((r, i) => r.length === 1 && r[0] === texts.get(asked[i]!)),
      JSON.stringify(requests.slice(reqBefore).map((r) => r.length)),
    );
    check(
      '真实 PG：语义召回用库里装载的向量，查询原文的线路排第一',
      tops.every((t, i) => t === asked[i]),
      JSON.stringify(tops),
    );

    // ---- 3 向量确实来自 kb_vectors：库里把两条线路的向量对调，重启装载之后召回跟着对调 ----
    const [a, b] = [ids[0]!, ids[1]!];
    const swap = async (): Promise<void> => {
      await f.query(
        `update kb_vectors v set embedding = o.embedding
           from (select c.ref, v2.embedding from kb_vectors v2 join kb_chunks c on c.tenant_id = v2.tenant_id and c.id = v2.chunk_id
                  where c.tenant_id = $1 and c.ref in ($2, $3)) o, kb_chunks c
          where v.tenant_id = $1 and c.tenant_id = v.tenant_id and c.id = v.chunk_id and c.ref = case o.ref when $2 then $3 else $2 end`,
        [T, a, b],
      );
    };
    await swap();
    retrieval.__retrievalTest.reset();
    const n3 = requests.length;
    await retrieval.buildIndex();
    check('真实 PG：对调向量后重启装载没有嵌入请求', requests.length === n3, String(requests.length - n3));
    check(
      '真实 PG：召回的向量来自 kb_vectors：问 A 的原文，排第一的是被对调了向量的 B（反之亦然）',
      (await topHit(texts.get(a)!)) === b && (await topHit(texts.get(b)!)) === a,
    );
    await swap();

    // ---- 4 重启之后不重新嵌入 ----
    retrieval.__retrievalTest.reset();
    check('真实 PG：重启（清掉内存）后索引是空的', !retrieval.indexReady());
    const n4 = requests.length;
    await retrieval.buildIndex();
    check('真实 PG：重启之后装载不重新嵌入：没有任何嵌入请求', requests.length === n4, String(requests.length - n4));
    check(
      '真实 PG：重启装载的索引与产品库顺序一致，召回正常',
      retrieval.__retrievalTest.indexIds().join(',') === ids.join(',') && (await topHit(texts.get(a)!)) === a,
    );

    // ---- 5 改一条线路：嵌入请求只带这一块，提交之后内存索引换新 ----
    const target = ids[2]!;
    const n5 = requests.length;
    const item = await cat.getCatalogItem(ctx, 'route', target);
    const changed = await cat.updateCatalogItem(ctx, 'route', target, {
      rev: item!.rev,
      set: { highlights: ['七彩云南深度慢游专属亮点'] },
    });
    check('真实 PG：改线路亮点成功', changed.rev > item!.rev);
    check('真实 PG：产品库变化后后台增量同步完成', await waitFor(idle), JSON.stringify(retrieval.indexHealth()));
    const fresh = routeTexts().get(target)!;
    check('真实 PG：线路正文变了', fresh !== texts.get(target) && fresh.includes('七彩云南深度慢游专属亮点'));
    const bulk = requests.slice(n5);
    check(
      '真实 PG：改一条线路，嵌入请求只带一块（新正文）',
      bulk.length === 1 && bulk[0]!.length === 1 && bulk[0]![0] === fresh,
      JSON.stringify(bulk.map((r) => r.length)),
    );
    const [row5] = await f.query<{ body_hash: string; vec_hash: string; n: number }>(
      `select c.body_hash, v.body_hash as vec_hash, (select count(*)::int from kb_vectors where tenant_id = $1) as n
         from kb_chunks c join kb_vectors v on v.tenant_id = c.tenant_id and v.chunk_id = c.id where c.tenant_id = $1 and c.ref = $2`,
      [T, target],
    );
    check(
      '真实 PG：库里这一块换了新的 body_hash，向量也是按新正文算的，向量没有多出行',
      row5?.body_hash === sha256(fresh) && row5.vec_hash === sha256(fresh) && row5.n === 20,
      JSON.stringify(row5),
    );
    check('真实 PG：提交之后内存索引换新：新正文做查询排第一', (await topHit(fresh)) === target);
    check('真实 PG：其余线路的块与向量原样（只动了一块）', JSON.stringify(await kbRows()) === JSON.stringify({ chunks: 20, vectors: 20 }));

    // ---- 6 新上架一条、库里多出一条产品库里没有的块：补缺删多，只嵌新的那一块 ----
    await f.query(`insert into kb_chunks (tenant_id, source, ref, body, body_hash) values ($1, 'route', 'r-orphan', '孤块', $2)`, [
      T,
      sha256('孤块'),
    ]);
    const n6 = requests.length;
    const base = (await cat.getCatalogItem(ctx, 'route', ids[0]!))!.payload;
    const created = await cat.createCatalogItem(ctx, 'route', { ...base, id: 'r-kb-new', title: '鲸歌湾专线', highlights: ['看鲸鱼'] });
    check('真实 PG：新建（草稿）不触发构建', (await wait(100), requests.length === n6));
    await cat.activateCatalogItem(ctx, 'route', 'r-kb-new', { rev: created.rev });
    check('真实 PG：上架后同步完成', await waitFor(idle));
    const added = requests.slice(n6);
    check(
      '真实 PG：上架一条，嵌入请求只带新线路这一块',
      added.length === 1 && added[0]!.length === 1,
      JSON.stringify(added.map((r) => r.length)),
    );
    const refs = (await f.query<{ ref: string }>('select ref from kb_chunks where tenant_id = $1 order by ref', [T])).map((r) => r.ref);
    check(
      '真实 PG：孤块被删，新线路的块在，共 21 块 21 向量',
      !refs.includes('r-orphan') && refs.includes('r-kb-new') && refs.length === 21 && (await kbRows()).vectors === 21,
      refs.join(','),
    );
    check('真实 PG：新线路能被召回', (await topHit(routeTexts().get('r-kb-new')!)) === 'r-kb-new');

    // ---- 7 嵌入失败：库里什么都不动，旧索引照常服务，放行后退避重试成功 ----
    retrieval.__retrievalTest.setBackoff([20]); // reset() 会把退避调回默认的 30 秒
    failEmbeds = true;
    const item7 = (await cat.getCatalogItem(ctx, 'route', ids[3]!))!;
    await cat.updateCatalogItem(ctx, 'route', ids[3]!, { rev: item7.rev, set: { highlights: ['嵌入失败时的亮点'] } });
    check(
      '真实 PG：嵌入失败时报过期与错误',
      await waitFor(() => retrieval.indexHealth().stale && retrieval.indexHealth().lastError !== null),
    );
    const [still] = await f.query<{ body_hash: string }>(`select body_hash from kb_chunks where tenant_id = $1 and ref = $2`, [T, ids[3]]);
    check('真实 PG：失败时库里这一块还是旧的 body_hash', still?.body_hash === sha256(texts.get(ids[3]!)!), still?.body_hash);
    check(
      '真实 PG：失败时旧索引照常服务（查询向量这时也发不出去，召回退回关键词；索引本身还在）',
      retrieval.indexReady() &&
        retrieval.__retrievalTest.indexIds().length === 21 &&
        (await retrieval.semanticRecall(texts.get(ids[4]!)!)) === null,
    );
    failEmbeds = false;
    check('真实 PG：放行之后退避重试成功', await waitFor(idle, 10_000));
    const [healed] = await f.query<{ body_hash: string }>(`select body_hash from kb_chunks where tenant_id = $1 and ref = $2`, [T, ids[3]]);
    check('真实 PG：重试之后库里是新的 body_hash', healed?.body_hash === sha256(routeTexts().get(ids[3]!)!));

    // ---- 8 维数不是 2048：这批向量只放内存、不写库，召回照常 ----
    await f.query('delete from kb_chunks where tenant_id = $1', [T]); // 向量级联
    dims = 32;
    retrieval.__retrievalTest.reset();
    const short = await captureLogs(() => retrieval.buildIndex());
    check('真实 PG：维数不对时索引照样建起来，召回照常', retrieval.indexReady() && (await topHit(routeTexts().get(ids[0]!)!)) === ids[0]);
    check(
      '真实 PG：维数不对时不写库，日志点名原因',
      JSON.stringify(await kbRows()) === JSON.stringify({ chunks: 0, vectors: 0 }) &&
        short.logs.some((l) => l.includes('维数不是 2048')) &&
        short.logs.some((l) => l.includes('未写库')),
      short.logs.join(' | '),
    );
    dims = 2048;

    // ---- 9 DB 模式不读写 var/route-vectors.json：放一个假的，装载前后原样 ----
    fs.writeFileSync(cacheFile, '{"fp":"x","model":"embedding-3","items":[]}');
    const planted = fs.statSync(cacheFile);
    retrieval.__retrievalTest.reset();
    const n9 = requests.length;
    await retrieval.buildIndex();
    check(
      '真实 PG：库被清空之后重建：发了一个带全部线路的请求',
      requests.length - n9 === 1 && requests[n9]!.length === 21,
      JSON.stringify(requests.slice(n9).map((r) => r.length)),
    );
    check(
      '真实 PG：DB 模式不读写 var/route-vectors.json（原样，没有临时文件）',
      fs.readFileSync(cacheFile, 'utf8') === '{"fp":"x","model":"embedding-3","items":[]}' &&
        fs.statSync(cacheFile).mtimeMs === planted.mtimeMs &&
        fs.readdirSync(varDir).every((x) => !x.includes('.tmp-')),
    );
    fs.rmSync(cacheFile, { force: true });
    await packKind(app.db, f.query, true);
  } finally {
    retrieval.__retrievalTest.reset();
    cfg.__configTest.reset();
    await app.close();
    await f.drop();
  }
}

// ---------------- PGlite：没有 kb_vectors，DB 模式退回进程内建索引、不持久 ----------------
async function pglite(): Promise<void> {
  const t = await openTestDb();
  try {
    cfg.__configTest.reset();
    retrieval.__retrievalTest.reset();
    await installSeededConfig(t);
    const [v] = (await t.pg.query<{ ok: boolean }>("select to_regclass('public.kb_vectors') is not null as ok")).rows;
    check('PGlite：没有 kb_vectors 这张表', v?.ok === false);
    const texts = routeTexts();
    check(
      'PGlite：导入后的旅游全部知识块 source/ref/body_hash 与开工指纹相同',
      chunksHash([...texts].map(([ref, body]) => ({ source: 'route', ref, body_hash: sha256(body) }))) === travelChunksHash,
    );
    // mock：装载不抛，不发请求（K8）
    process.env.LLM_MOCK = '1';
    const n0 = requests.length;
    await retrieval.buildIndex();
    check('PGlite：DB 模式 + mock 下装载不抛、不发嵌入请求', requests.length === n0 && !retrieval.indexReady());
    process.env.LLM_MOCK = '';
    // 非 mock：进程内建一次索引（一个请求带全部线路），不写 var、不写库
    await retrieval.buildIndex();
    check(
      'PGlite：DB 模式退回进程内建索引：一个请求带全部线路，索引就绪，召回正常',
      requests.length - n0 === 1 &&
        requests[n0]!.length === texts.size &&
        retrieval.indexReady() &&
        (await topHit([...texts.values()][1]!)) === [...texts.keys()][1],
      JSON.stringify(requests.slice(n0).map((r) => r.length)),
    );
    check('PGlite：不写 var/route-vectors.json', !fs.existsSync(cacheFile));
    const [chunks] = (await t.pg.query<{ n: number }>('select count(*)::int as n from kb_chunks')).rows;
    check('PGlite：不持久：kb_chunks 里没有行', chunks?.n === 0);
    // 重启：和今天文件丢失时一样，重新嵌入
    retrieval.__retrievalTest.reset();
    const n1 = requests.length;
    await retrieval.buildIndex();
    check('PGlite：重启后重新嵌入（不持久）', requests.length - n1 === 1 && retrieval.indexReady() && !fs.existsSync(cacheFile));
    const query: Query = async (text, values = []) => {
      await t.pg.exec('RESET ROLE');
      try {
        return (await t.pg.query(text, values)).rows as never;
      } finally {
        await t.pg.exec('SET ROLE agent_app');
      }
    };
    await packKind(t.db, query, false);
  } finally {
    process.env.LLM_MOCK = '';
    retrieval.__retrievalTest.reset();
    cfg.__configTest.reset();
    await t.close();
  }
}

type Query = <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<R[]>;

// 08 R9：同一个假嵌入服务验证证明包；PGlite 保留 07 R13 的不持久化分支。
async function packKind(db: import('../db/client.js').Db, query: Query, real: boolean): Promise<void> {
  const label = real ? '真实 PG widget' : 'PGlite widget';
  const rt = hostRuntime();
  const travel = rt.config.loaded!;
  const travelBinding = cfg.currentPack();
  const [tenant] = await query<{ id: string }>(
    "insert into tenants (slug, name, pack_id) values ('kbfixture', '合成知识库租户', '__fixture') returning id",
  );
  const tenantId = tenant!.id;
  const ctx: import('../db/client.js').TenantCtx = {
    tenantId,
    actor: { kind: 'system', userId: null, name: null, ip: null },
  };
  const runtime = runtimeById('__fixture', cfg.packSources())!;
  const insert = 'insert into kb_chunks (tenant_id, source, ref, body, body_hash) values ($1, $2, $3, $4, $5)';
  const badKind = (e: unknown): boolean =>
    (e as { code?: string }).code === '23514' && (e as { constraint?: string }).constraint === 'kb_chunks_source_check';
  for (const source of ['Bad-Kind', 'x', 'a'.repeat(33)]) {
    await assert.rejects(query(insert, [tenantId, source, 'bad', '合成正文', sha256('合成正文')]), badKind);
  }
  check(`${label}：非法 source 被数据库格式 CHECK 拒绝`, true);
  // 32 字符合法；与 widget 同 ref 的其他 source 不能被本次同步误删或被当成现成的块。
  const other = 'a'.repeat(32);
  await query(insert, [tenantId, other, 'w-one', '其他 kind 的正文', sha256('其他 kind 的正文')]);
  try {
    retrieval.__retrievalTest.reset();
    // 第 12 步才接上证明包 SOP 发布；与 catalog-snapshot 自测同样复用旅游的已验证配置外壳。
    rt.config.loaded = {
      ...travel,
      tenantId,
      tenantName: '合成知识库租户',
      pack: packById('__fixture')!,
      deps: { ...travel.deps, tenantSlug: 'kbfixture' },
      catalog: { tenantId, generation: 0, items: {}, routes: [], hotels: [], versions: {} },
      ords: {},
      history: new Map(),
    };
    bindPack(runtime, runtime.defaultBrand);
    process.env.LLM_MOCK = '1';
    const payload = (id: string, title: string) => ({ id, title, unitPrice: 12, unit: '件', tags: ['合成'] });
    const one = await cat.createCatalogItem(ctx, 'widget', payload('w-one', '琥珀方盒采样核验'));
    const two = await cat.createCatalogItem(ctx, 'widget', payload('w-two', '蓝晶方盒尺寸复核'));
    await cat.createCatalogItem(ctx, 'widget', payload('w-draft', '未上架草稿'));
    await cat.activateCatalogItem(ctx, 'widget', one.code, { rev: one.rev });
    await cat.activateCatalogItem(ctx, 'widget', two.code, { rev: two.rev });
    const items = runtime.retrievalItems();
    const texts = items.map((item) => runtime.retrievalText(item));
    assert.deepEqual(
      items.map((item) => [item.kind, item.code, item.status]),
      [
        ['widget', 'w-one', 'active'],
        ['widget', 'w-two', 'active'],
      ],
    );
    assert.deepEqual(
      texts,
      items.map((item) => JSON.stringify(item.payload)),
    );
    process.env.LLM_MOCK = '';
    const n = requests.length;
    await retrieval.buildIndex();
    assert.deepEqual(requests.slice(n), [texts]);
    assert.equal(await topHit(texts[1]!), 'w-two');
    check(`${label}：只索引两条 active widget，假 embedding 语义召回命中`, true);

    const readChunks = () => withTenant(db, ctx, readKbSnapshot);
    if (!real) {
      assert.deepEqual(
        (await readChunks()).chunks.map((c) => c.source),
        [other],
      );
      // 单独验可移植仓库契约：无向量表时 writeKbSync 只写块，不改变自动构建不持久的行为。
      await withTenant(db, ctx, (tx) =>
        writeKbSync(tx, {
          source: 'widget',
          model: 'embedding-3',
          keep: items.map((i) => i.code),
          writes: items.map((item) => {
            const body = runtime.retrievalText(item);
            return { source: 'widget', ref: item.code, body, bodyHash: sha256(body), vector: [] };
          }),
        }),
      );
    }
    const before = (await readChunks()).chunks;
    assert.deepEqual(
      before.filter((c) => c.source === 'widget').map((c) => [c.source, c.ref, c.bodyHash]),
      items.map((item) => ['widget', item.code, sha256(runtime.retrievalText(item))]),
    );
    check(`${label}：块 source=widget、ref=条目编号、正文哈希准确${real ? '' : '（仓库写入）'}`, true);
    const n1 = requests.length;
    await cat.updateCatalogItem(ctx, 'widget', 'w-one', { rev: 2, set: { title: '珊瑚方盒新核验说明' } });
    assert.ok(
      await waitFor(() => !retrieval.indexHealth().stale && retrieval.indexHealth().indexGeneration === cfg.currentCatalog().generation),
    );
    const freshText = runtime.retrievalText(runtime.retrievalItems()[0]!);
    if (real) {
      assert.deepEqual(requests.slice(n1), [[freshText]]);
      const after = (await readChunks()).chunks;
      assert.equal(after.find((c) => c.source === 'widget' && c.ref === 'w-one')!.bodyHash, sha256(freshText));
      assert.deepEqual(
        after.find((c) => c.source === 'widget' && c.ref === 'w-two'),
        before.find((c) => c.source === 'widget' && c.ref === 'w-two'),
      );
      check(`${label}：改一条只重新嵌入一块，另一块逐字段不变`, true);
      retrieval.__retrievalTest.reset();
      const n2 = requests.length;
      await retrieval.buildIndex();
      assert.equal(requests.length, n2);
      assert.equal(await topHit(freshText), 'w-one');
      check(`${label}：重启从库装载，不重新嵌入`, true);
    } else {
      assert.deepEqual(requests.slice(n1), [runtime.retrievalItems().map((item) => runtime.retrievalText(item))]);
      assert.deepEqual((await readChunks()).chunks, before);
      check(`${label}：自动构建仍仅在内存，全量重嵌且不改库（07 R13）`, true);
    }
    // keep 非空与为空两条删除分支；都只能删除指定 source，不能误删同 ref 的其他 kind。
    for (const keep of [['w-two'], []]) {
      await withTenant(db, ctx, (tx) => writeKbSync(tx, { source: 'widget', model: 'embedding-3', keep, writes: [] }));
      assert.deepEqual(
        (await readChunks()).chunks.filter((c) => c.source === 'widget').map((c) => c.ref),
        keep,
      );
      assert.deepEqual(
        (await readChunks()).chunks.filter((c) => c.source === other),
        before.filter((c) => c.source === other),
      );
    }
    check(`${label}：按 kind 删除多余块，保留其他 source 的同 ref 块`, true);
    retrieval.__retrievalTest.reset();
    bindPack({ ...runtime, catalog: { widget: { ...runtime.catalog.widget!, retrieval: false } } }, runtime.defaultBrand);
    const n3 = requests.length;
    await retrieval.buildIndex();
    assert.equal(requests.length, n3);
    assert.deepEqual(retrieval.__retrievalTest.indexIds(), []);
    assert.deepEqual(
      (await readChunks()).chunks,
      before.filter((c) => c.source === other),
    );
    check(`${label}：包没有可检索 kind 时不建知识库、不请求 embedding`, true);
  } finally {
    process.env.LLM_MOCK = '';
    retrieval.__retrievalTest.reset();
    rt.config.loaded = travel;
    bindPack(travelBinding.runtime, travelBinding.brand);
  }
}

try {
  await pglite();
  const url = process.env.PG_TEST_URL;
  if (url) {
    requests.length = 0;
    await realPostgres(url);
  } else if (process.env.CI === 'true') {
    fails.push('CI 下必须设 PG_TEST_URL：kb_vectors 只在装了 vector 扩展的真实 Postgres 上测（07 R12）');
  } else {
    console.log('RETRIEVAL-KB SELFTEST：没有 PG_TEST_URL，跳过真实 Postgres 部分（kb_vectors、装载、增量嵌入）');
  }
} finally {
  server.close();
  fs.rmSync(varDir, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`RETRIEVAL-KB SELFTEST FAIL: ${fails.length} 项失败（另有 ${pass} 项通过）\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(`RETRIEVAL-KB SELFTEST PASS: ${pass} 项断言`);
