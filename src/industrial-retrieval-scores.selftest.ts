import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostRuntime, withoutTenantScope } from './tenancy/runtime.js';
import { enterTenantScopeForTest } from './tenancy/testing.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-scores-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  SOP_PATH: path.resolve('data/packs/industrial/sop.md'),
  LLM_MOCK: '0',
  LLM_MAX_RETRY: '0',
  EMBED_BASE_URL: 'http://127.0.0.1:1',
  EMBED_API_KEY: 'synthetic',
  LLM_PROVIDER: '',
});
const rt = hostRuntime();
enterTenantScopeForTest(rt);
await withoutTenantScope(() => import('./core/engine/sources.js'));
const cfg = await import('./config/source.js');
const retrieval = await import('./core/retrieval.js');
const { queryCount } = await import('./db/client.js');
const fetchBefore = globalThis.fetch;
let calls = 0;
let fail = false;
let malformed = false;
let pending: (() => void) | undefined;
let started: (() => void) | undefined;
let hold = false;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'http://127.0.0.1:1/embeddings');
  calls++;
  if (hold) {
    started?.();
    await new Promise<void>((resolve) => {
      pending = resolve;
    });
  }
  if (fail) return new Response('{}', { status: 500 });
  const { input } = JSON.parse(String(init?.body)) as { input: string[] };
  return new Response(
    JSON.stringify({
      data: input.map((text) => ({ embedding: malformed ? [1] : text.includes('25mm') ? [1, 0] : [0, 1] })),
      usage: { prompt_tokens: input.length },
    }),
    { status: 200 },
  );
};
try {
  await cfg.initConfig(null);
  retrieval.__retrievalTest.reset();
  assert.equal(await retrieval.semanticScores('内径25mm', ['bearing-01']), null);
  assert.equal(calls, 0, '索引未就绪不发请求');
  await retrieval.buildIndex();
  assert.equal(calls, 1);
  const dbBefore = queryCount();
  const scored = await cfg.packSources().semanticScores('内径25mm', ['bearing-01', 'fastener-01', 'absent']);
  assert.equal(calls, 2, '通过正式PackSources接线，只嵌入一次');
  assert.deepEqual([...scored!.keys()], ['bearing-01', 'fastener-01']);
  assert.equal(scored!.get('bearing-01'), 1);
  assert.equal(scored!.get('fastener-01'), 0);
  assert.equal(queryCount(), dbBefore, '每轮查询不查库');
  assert.equal(await retrieval.semanticScores('   ', ['bearing-01']), null);
  assert.deepEqual(await retrieval.semanticScores('内径25mm', []), new Map());
  assert.equal(calls, 2, '空查询/空候选不发请求');
  fail = true;
  assert.equal(await retrieval.semanticScores('内径25mm', ['bearing-01']), null);
  assert.equal(calls, 3, '嵌入失败只调用一次');
  fail = false;
  malformed = true;
  assert.equal(await retrieval.semanticScores('内径25mm', ['bearing-01']), null, '维度错误按不可用降级');
  malformed = false;
  hold = true;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const old = retrieval.semanticScores('内径25mm', ['bearing-01']);
  await entered;
  retrieval.__retrievalTest.reset();
  pending!();
  assert.equal(await old, null, '清理期间的在途结果不能落入新索引');
  const n = calls;
  assert.equal(await retrieval.semanticScores('内径25mm', ['bearing-01']), null);
  assert.equal(calls, n, '清理后索引不可用');
  console.log('RETRIEVAL SCORES PASS: 真实接线、候选余弦、每查询至多一次嵌入、零查库、未就绪/失败/维度错误降级、在途清理栅栏');
} finally {
  pending?.();
  globalThis.fetch = fetchBefore;
  retrieval.__retrievalTest.reset();
  await cfg.closeConfig();
  cfg.__configTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
