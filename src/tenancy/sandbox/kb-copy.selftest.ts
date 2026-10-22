// 07 R13 / 验收 6：沙箱开通把宿主的块与向量一并复制（和 05 R9 的其余内容同一个只读快照），开通与装载不发嵌入请求，
// 沙箱里检索照常，删除沙箱之后两张表里没有它的行。
// - 真实 PG（PG_TEST_URL，pgvector 镜像）：宿主先同步出向量，再开通沙箱；计数的假嵌入服务是本机回环（非 prod 的端点白名单放行），
//   所以这组不设 LLM_MOCK。宿主没有向量时沙箱自己嵌入，吃的是进程里「首次建索引」那一次免单名额（claimSandboxInitialIndex）。
// - PGlite（没有 kb_vectors）：只有 kb_chunks，复制与删除照样成立。
// 用法：PG_TEST_URL=… npx tsx src/tenancy/sandbox/kb-copy.selftest.ts
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRealPgFixture, fakeLock, openTestDb, purgeTestSandbox, testConfigDeps } from '../../db/testing.js';
import { openDb, type Db } from '../../db/client.js';
import { importConfig } from '../../config/transfer.js';
import { closeConfig, currentPack, initConfig, __configTest } from '../../config/source.js';
import { buildIndex, indexReady, semanticRecall, __retrievalTest } from '../../core/retrieval.js';
import { expireBrokenSandbox } from '../../db/sandbox-process.js';
import { dropShutdownHooks } from '../../shutdown.js';
import {
  configureTenancy,
  createTenantRuntime,
  runtimeOf,
  tenantRuntimes,
  tenantStoreIfLoaded,
  unregisterRuntime,
  withTenantScope,
  type TenantRuntime,
} from '../runtime.js';
import { dropTenantState } from '../state.js';
import { provisionSandbox, type ProvisionOptions } from './provision.js';
import type { TenantLock } from '../../db/client.js';

type Query = <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<R[]>;
let checks = 0;
function check(cond: unknown, name: string, detail = ''): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  checks++;
}

for (const k of ['EMBED_MODEL', 'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'ZHIPU_BASE_URL', 'ZHIPU_API_KEY']) process.env[k] = '';
process.env.LLM_MOCK = '';

// ---------------- 计数的假嵌入服务 ----------------
const vecOf = (text: string): number[] => {
  const v = Array.from({ length: 2048 }, () => 0);
  for (const c of text) v[c.codePointAt(0)! % 2048]! += 1;
  return v;
};
const requests: string[][] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d: Buffer) => (body += d.toString()));
  req.on('end', () => {
    const { input } = JSON.parse(body) as { input: string[] };
    requests.push(input);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: input.map((x) => ({ embedding: vecOf(x) })), usage: { prompt_tokens: input.length } }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
process.env.EMBED_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.EMBED_API_KEY = 'fake-key'; // gitleaks:allow

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, name: string, ms = 10_000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await wait(10);
  check(cond(), name);
}
async function releaseRuntimes(): Promise<void> {
  for (const rt of tenantRuntimes()) {
    rt.state = 'closed';
    tenantStoreIfLoaded(rt)?.pgBackend?.close();
    await withTenantScope(rt, closeConfig);
    dropTenantState(rt.id);
    dropShutdownHooks(rt);
    unregisterRuntime(rt.id);
  }
}
const inRuntime = <T>(rt: TenantRuntime, fn: () => T): T => withTenantScope(rt, fn);

interface KbRow {
  ref: string;
  id: string;
  body_hash: string;
}
const chunksOf = (q: Query, tenant: string): Promise<KbRow[]> =>
  q<KbRow>('select ref, id, body_hash from kb_chunks where tenant_id = $1 order by ref', [tenant]);
const vectorCount = async (q: Query, tenant: string): Promise<number> =>
  (await q<{ n: number }>('select count(*)::int as n from kb_vectors where tenant_id = $1', [tenant]))[0]!.n;

async function suite(db: Db, q: Query, acquire: (id: string) => Promise<TenantLock | null>, real: boolean): Promise<void> {
  process.env.SESSION_STORE = 'db';
  configureTenancy({ role: 'sandbox', standardCount: 0 });
  requests.length = 0;
  const [host] = await q<{ id: string }>("select id from tenants where slug='template'");
  const hostId = host!.id;
  const hostRuntime = createTenantRuntime({ id: hostId, slug: 'template' });
  const deps = testConfigDeps({ db }, { tenantSlug: 'template', usePackRuntime: true });
  const imported = await withTenantScope(hostRuntime, () =>
    importConfig({ db, tenantSlug: 'template', dataDir: 'data', imageSop: deps.imageSop, lock: async () => fakeLock() }),
  );
  check(imported.code === 0, '导入模板租户', imported.message);

  // ---- 宿主的块与向量 ----
  let hostRoutes: Map<string, string>;
  if (real) {
    // 宿主进程的装载：读空库 → 一次嵌入全部线路 → 写 kb_chunks / kb_vectors
    hostRoutes = await withTenantScope(hostRuntime, async () => {
      await initConfig(deps);
      await buildIndex();
      const items = currentPack().runtime.retrievalItems();
      const texts = new Map(items.map((item) => [item.code, currentPack().runtime.retrievalText(item)]));
      await closeConfig();
      __configTest.reset();
      return texts;
    });
    check(
      requests.length === 1 && requests[0]!.length === hostRoutes.size,
      '宿主同步：一个请求带全部线路',
      JSON.stringify(requests.map((r) => r.length)),
    );
    check((await vectorCount(q, hostId)) === hostRoutes.size, '宿主同步：向量都写进了 kb_vectors');
  } else {
    // PGlite 上宿主不会自己写块（没有 kb_vectors，不持久）；种几行，验证 kb_chunks 的复制与删除
    hostRoutes = new Map();
    for (const ref of ['r-kb-a', 'r-kb-b', 'r-kb-c']) {
      await q(`insert into kb_chunks (tenant_id, source, ref, body, body_hash) values ($1, 'route', $2, $3, $4)`, [
        hostId,
        ref,
        `正文 ${ref}`,
        ref
          .charCodeAt(ref.length - 1)
          .toString(16)
          .padStart(64, '0'),
      ]);
    }
  }
  const hostChunks = await chunksOf(q, hostId);
  check(hostChunks.length === (real ? 20 : 3), '宿主有块', String(hostChunks.length));

  const base: ProvisionOptions = {
    env: { SANDBOX_PER_HOUR: '100', SANDBOX_PER_IP_DAY: '100' },
    deps,
    templateSlug: 'template',
    host: 'sandbox.example.invalid',
    epoch: '0',
    acquireTenant: acquire,
    ip: null,
    userAgent: 'selftest',
  };

  // ---- 1 宿主已有向量：开通复制它们，开通与装载一个嵌入请求都不发 ----
  const before = requests.length;
  const first = await provisionSandbox(base);
  const rt = runtimeOf(first.tenantId)!;
  const copied = await chunksOf(q, first.tenantId);
  check(
    JSON.stringify(copied) === JSON.stringify(hostChunks),
    '沙箱的块与宿主的块逐行相同（块 id、线路 id、正文哈希原样复制）',
    JSON.stringify(copied.slice(0, 2)),
  );
  if (real) {
    check((await vectorCount(q, first.tenantId)) === hostRoutes.size, '沙箱的向量与宿主一样多');
    const [same] = await q<{ n: number }>(
      `select count(*)::int as n from kb_vectors s join kb_vectors h on h.chunk_id = s.chunk_id and h.model = s.model
        and h.body_hash = s.body_hash and h.embedding = s.embedding where s.tenant_id = $1 and h.tenant_id = $2`,
      [first.tenantId, hostId],
    );
    check(same!.n === hostRoutes.size, '沙箱每个向量与宿主的同一块逐位相等');
    check(requests.length === before, '开通过程没有嵌入请求', String(requests.length - before));
    await until(() => inRuntime(rt, indexReady), '沙箱的索引从自己的行装载好');
    check(requests.length === before, '沙箱装载索引也没有嵌入请求（全部块已有向量）', String(requests.length - before));
    check(inRuntime(rt, () => rt.budget.status().calls) === 0, '装载没有占沙箱的预算');
    const [route0, text0] = [...hostRoutes][0]!;
    const hit = await inRuntime(rt, () => semanticRecall(text0, 1));
    check(hit?.[0]?.id === route0, '沙箱里检索照常：问线路原文，这条线路排第一', JSON.stringify(hit));
    check(requests.length === before + 1 && requests.at(-1)!.length === 1, '沙箱里检索只发一个查询嵌入请求');
    check(inRuntime(rt, () => rt.budget.status().calls) === 1, '查询嵌入照常计入沙箱预算');
  }
  const afterHost = await chunksOf(q, hostId);
  check(JSON.stringify(afterHost) === JSON.stringify(hostChunks), '开通没有改动宿主的块');

  // ---- 2 删除沙箱：先到期、关运行时，再走 sandbox_tenant_purge，两张表里没有它的行；宿主的行还在 ----
  await expireBrokenSandbox(db, first.tenantId);
  await releaseRuntimes();
  await purgeTestSandbox(db, first.tenantId);
  check((await chunksOf(q, first.tenantId)).length === 0, '删除沙箱之后 kb_chunks 里没有它的行');
  if (real) check((await vectorCount(q, first.tenantId)) === 0, '删除沙箱之后 kb_vectors 里没有它的行');
  check(
    JSON.stringify(await chunksOf(q, hostId)) === JSON.stringify(hostChunks) &&
      (!real || (await vectorCount(q, hostId)) === hostRoutes.size),
    '宿主的块与向量原样在',
  );

  // ---- 3 宿主还没有向量：claimSandboxInitialIndex 才用得上，沙箱自己嵌入，这一次免单（1 里没有占用名额）----
  // 同一份目录的第二个沙箱在进程里直接用第一个的向量，不再发请求（和原来的共享索引一样），也写进自己的行
  if (real) {
    await q('delete from kb_chunks where tenant_id = $1', [hostId]); // 向量级联
    check((await vectorCount(q, hostId)) === 0, '宿主的块与向量清空');
    // 宿主装载阶段缓存在进程里的同目录向量也清掉，才看得出第一个沙箱是不是真的自己嵌入
    await withTenantScope(hostRuntime, () => __retrievalTest.reset());
    const n = requests.length;
    const second = await provisionSandbox(base);
    const rt2 = runtimeOf(second.tenantId)!;
    await until(() => inRuntime(rt2, indexReady), '宿主没有向量时沙箱自己建好索引');
    check(
      requests.length - n === 1 && requests[n]!.length === hostRoutes.size,
      '宿主没有向量：沙箱发一个请求带全部线路',
      JSON.stringify(requests.slice(n).map((r) => r.length)),
    );
    check(inRuntime(rt2, () => rt2.budget.status().calls) === 0, '这一次是进程里首次建索引，免单名额还在（第一个沙箱没占它）');
    check((await vectorCount(q, second.tenantId)) === hostRoutes.size, '沙箱把自己的向量写进了库');
    const n2 = requests.length;
    const third = await provisionSandbox(base);
    const rt3 = runtimeOf(third.tenantId)!;
    await until(() => inRuntime(rt3, indexReady), '第三个沙箱的索引建好');
    check(requests.length === n2, '同一份目录的第三个沙箱直接用进程里现成的向量，没有嵌入请求', String(requests.length - n2));
    check(inRuntime(rt3, () => rt3.budget.status().calls) === 0, '现成向量不占第三个沙箱的预算');
    check((await vectorCount(q, third.tenantId)) === hostRoutes.size, '第三个沙箱也把向量写进了自己的行');
    for (const id of [second.tenantId, third.tenantId]) await expireBrokenSandbox(db, id);
    await releaseRuntimes();
    for (const id of [second.tenantId, third.tenantId]) await purgeTestSandbox(db, id);
    check(
      (await vectorCount(q, second.tenantId)) + (await vectorCount(q, third.tenantId)) === 0 &&
        (await chunksOf(q, second.tenantId)).length + (await chunksOf(q, third.tenantId)).length === 0,
      '第二、第三个沙箱删除之后也没有行',
    );
  }
  await releaseRuntimes();
}

try {
  const t = await openTestDb();
  try {
    await t.pg.query("insert into tenants(slug,name,pack_id) values('template','模板','travel')");
    const q: Query = async (text, values = []) => {
      await t.pg.exec('RESET ROLE');
      try {
        return (await t.pg.query(text, values)).rows as never;
      } finally {
        await t.pg.exec('SET ROLE agent_app');
      }
    };
    await t.pg.exec('SET ROLE agent_app');
    process.env.LLM_MOCK = '1'; // PGlite 上没有向量表，装载走进程内建索引；这一组只验块的复制与删除，不让它去连假服务
    await suite(t.db, q, async () => fakeLock(), false);
    process.env.LLM_MOCK = '';
  } finally {
    await releaseRuntimes();
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const f = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'template' });
    let app: Awaited<ReturnType<typeof openDb>> | null = null;
    try {
      app = await openDb(f.urls.app);
      await suite(app.db, f.query, async () => fakeLock(), true);
    } finally {
      await releaseRuntimes();
      await app?.close();
      await f.drop();
    }
  } else console.log('SKIP: 向量的复制需要 PG_TEST_URL（pgvector 镜像）；PGlite 上只验了 kb_chunks');
} finally {
  server.close();
}
console.log(`SELFTEST PASS: 沙箱复制知识库 ${checks} 项`);
