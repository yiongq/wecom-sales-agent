// 第15步：审查复现经真实工具、主回复与跟进生成链路；只替换模型出口。
import './selftest-env.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatOptions, Session } from './core/pack-api.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-review-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  SOP_PATH: path.join(dir, 'sop.md'),
  SERVER_SELFTEST: '1',
  LLM_MOCK: '1',
  LLM_PROVIDER: '',
  LLM_BASE_URL: 'https://model.example.test/v1',
  LLM_API_KEY: randomBytes(24).toString('hex'),
  LLM_MODEL: 'glm-5.3-flashx',
  LLM_MODEL_CHEAP: '',
  LLM_HEDGE_MODEL: '',
  LLM_MAX_RETRY: '0',
  PUBLIC_BASE_URL: 'https://shop.example.test',
  NOTIFY_WEBHOOK_URL: '',
});
for (const file of ['sop.md', 'policy.json', 'brand.json', 'pack.json'])
  fs.copyFileSync(`data/packs/industrial/${file}`, path.join(dir, file));
const demo = JSON.parse(fs.readFileSync('data/packs/industrial/catalog/part.json', 'utf8'));
const parts = Array.from({ length: 3 }, (_, i) => ({
  id: `review-${i}`,
  partNo: `HS${1000 + i}`,
  name: '合成轴承',
  brand: '合成品牌',
  category: '轴承',
  specs: ['内径25mm'],
  unit: '件',
  unitPrice: 10,
  moq: 1,
  stock: 100,
  leadDays: 7,
  substitutes: i === 0 ? ['HS1001'] : [],
}));
fs.mkdirSync(path.join(dir, 'catalog'));
fs.writeFileSync(path.join(dir, 'catalog/part.json'), JSON.stringify([...demo, ...parts]));
const { hostRuntime } = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
enterTenantScopeForTest(hostRuntime());
const config = await import('./config/source.js');
const store = await import('./store.js');
const { bindPack } = await import('./core/pack-api.js');
const { createIndustrialRuntime } = await import('./packs/industrial/runtime.js');
const { writeState, readState } = await import('./packs/industrial/state.js');
const { handleMessage } = await import('./engine.js');
const { followUpText } = await import('./followup.js');
const runtime = createIndustrialRuntime(config.packSources());
bindPack(runtime, runtime.defaultBrand);
let raw = '';
let prepare: (opts: ChatOptions) => Promise<void>;
runtime.mock = {
  chat: async (opts) => {
    await prepare(opts);
    return raw;
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () =>
  Response.json({ choices: [{ message: { content: raw } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const failures: string[] = [];
let seq = 0;
async function sample(
  name: string,
  text: string,
  expected: RegExp | string,
  query = 'HS1000',
  qty = 2,
  inspect?: (s: Session) => void,
  followupExpected = '',
  extraQuery?: string,
) {
  const s = store.getOrCreateSession(`wecom:wmReview${++seq}`, 'wecom');
  // 在场缓存不等于库存依据；第二、第三个型号没有询价事实。
  writeState(s, {}, parts.slice(1));
  raw = text;
  prepare = async (opts) => {
    const found = JSON.parse(await opts.executeTool('find_parts', { query }));
    assert.equal(found.match, 'exact');
    assert.equal(found.parts.length, 1, '精确查询不能靠前缀把替代目标混入结果');
    if (name === 'R6-精确查询替代') assert.deepEqual(found.parts[0].substitutes, ['6205-ZZ']);
    const result = JSON.parse(
      await opts.executeTool('quote_items', { items: [{ query, qty }, ...(extraQuery ? [{ query: extraQuery, qty }] : [])] }),
    );
    if (qty > 1000000) assert.equal(result.lines[0].note, 'over_max');
  };
  for (const route of ['reply', 'followup'] as const) {
    try {
      process.env.LLM_MOCK = route === 'reply' ? '1' : '0';
      const actual = route === 'reply' ? (await handleMessage(s.id, `请查${query} ${qty}件`, 'wecom')).text : await followUpText(s);
      if (typeof expected === 'string') assert.equal(actual, expected);
      else if (route === 'followup' && /确认为准|能否替代/.test(expected.source)) assert.equal(actual, followupExpected);
      else assert.match(actual, expected);
      inspect?.(s);
      console.log(`PASS ${name}/${route}`);
    } catch (error) {
      failures.push(`${name}/${route}: ${error instanceof Error ? error.message : error}`);
      console.log(`FAIL ${name}/${route}`);
    }
  }
}
try {
  for (const text of ['HS1000预计3天交货。', 'HS1000交期约3天。', 'HS1000不保证最低价，但今天发货。'])
    await sample('R1-分句交期', text, /确认为准/, 'HS1000', 2, undefined, text.includes('不保证') ? 'HS1000不保证最低价，' : '');
  await sample('R1-条件分句', '如果HS1000没有现货，但HS1001今天发货。', /确认为准/, 'HS1000', 2, undefined, '如果HS1000没有现货，');
  await sample('R1-合法交期', 'HS1000预计7天交货。', 'HS1000预计7天交货。', 'HS1000', 101);
  await sample('R1-工具交期格式', 'HS1000现货100件，其余约3天。', /确认为准/, 'HS1000', 101, undefined, 'HS1000现货100件，');
  await sample('R1-否定条件', '如果HS1000有现货就好了。', '如果HS1000有现货就好了。');
  await sample('R2-全部型号证据', 'HS1000和HS1001全部现货。', /确认为准/);
  await sample('R2-两型号证据齐全', 'HS1000和HS1001全部现货。', 'HS1000和HS1001全部现货。', 'HS1000', 2, undefined, '', 'HS1001');
  await sample('R2-替代逐对', 'HS1000可以替代HS1001和HS1002。', /能否替代请顾问确认/);
  await sample(
    'R2-不同分句替代',
    'HS1000可以替代HS1001，但HS1001可以替代HS1002。',
    /能否替代请顾问确认/,
    'HS1000',
    2,
    undefined,
    'HS1000可以替代HS1001，',
  );
  await sample('R4-超量摘要', '数量超过上限，请顾问核对。', '数量超过上限，请顾问核对。', '6205-2RS', 1000001, (s) =>
    assert.equal(readState(s).rfqDraft?.lines[0]?.qty, 1000001),
  );
  await sample('R6-精确查询替代', '6205-2RS 可以替代6205-ZZ。', '6205-2RS 可以替代6205-ZZ。', '6205-2RS');
  assert.deepEqual(failures, []);
} finally {
  globalThis.fetch = originalFetch;
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  config.__configTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
