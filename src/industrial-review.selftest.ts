// 第15步：审查复现经真实工具、主回复与跟进生成链路；只替换模型出口。
import './selftest-env.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatOptions, Session, TurnContext } from './core/pack-api.js';
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
const { bindPack, createLineOrder } = await import('./core/pack-api.js');
const { createIndustrialRuntime } = await import('./packs/industrial/runtime.js');
const { writeState, readState } = await import('./packs/industrial/state.js');
const { handleMessage } = await import('./engine.js');
const { followUpText } = await import('./followup.js');
const { guardOutbound } = await import('./engine.js');
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
      const actual =
        route === 'reply'
          ? (await handleMessage(s.id, `请查${query} ${qty}件`, 'wecom')).text
          : text.includes('\n')
            ? await guardOutbound(s, text, { kind: 'followup' })
            : await followUpText(s);
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
  await sample('G1-跨行库存', 'HS1000 2件。\n库存：现货。', 'HS1000 2件。\n库存：现货。');
  await sample('G1-跨行部分库存', '6205-2RS 100件。\n现货30件，其余约7天。', '6205-2RS 100件。\n现货30件，其余约7天。', '6205-2RS', 100);
  await sample('G1-无现货后交期', '6205-ZZ无现货。\n交期约7天。', '6205-ZZ无现货。\n交期约7天。', '6205-ZZ');
  await sample('G1-有效期不是交期', 'HS1000 2件。\n报价有效期7天。', 'HS1000 2件。\n报价有效期7天。');
  await sample('G1-跨行不可借型号', 'HS1000。\nHS1001。\n库存：现货。', /确认为准/, 'HS1000', 2, undefined, 'HS1000。\nHS1001。');
  await sample(
    'G1-被删句不沿用旧型号',
    'HS1000。\nHS1001价格、订单、付款链接由代码与工具决定。\n库存：现货。',
    /确认为准/,
    'HS1000',
    2,
    undefined,
    'HS1000。',
  );
  await sample('G1-有效期不掩盖假交期', 'HS1000报价有效期7天，交期3天。', /确认为准/, 'HS1000', 2, undefined, 'HS1000报价有效期7天，');
  await sample('G1-无现货不掩盖假交期', '6205-ZZ无现货，交期3天。', /确认为准/, '6205-ZZ', 2, undefined, '6205-ZZ无现货，');
  for (const [name, check] of [
    [
      'G2-过期报价续算上下文',
      async () => {
        const s = store.getOrCreateSession('wecom:wmExpired', 'wecom');
        const created = await createLineOrder(s, [{ kind: 'part', code: 'bearing-02', qty: 2 }], { approval: true });
        assert.ok('order' in created);
        const order = store.getAnyOrder(s.orderIds[0]!)!;
        assert.ok('v' in order && order.approval);
        order.approval.state = 'approved';
        order.approval.decidedAt = Date.now() - 20 * 86400000;
        s.packState = {};
        raw = '报价单已过期，需要重新试算。';
        prepare = async (opts) => {
          assert.match(opts.contextNote!, /已过期/);
          assert.match(opts.contextNote!, /6205-2RS/);
          assert.match(opts.contextNote!, /"qty":2/);
          assert.match(opts.contextNote!, /quote_items/);
          assert.ok(!opts.system.includes('6205-2RS'), '订单行只能进入独立上下文');
        };
        process.env.LLM_MOCK = '1';
        await handleMessage(s.id, '确认报价；若过期请按原型号数量续算', 'wecom');
        assert.equal(order.approval.acceptedAt, undefined);
        assert.equal(s.packState?.confirmedQuoteAt, undefined);
        // 上下文是只读投影，不能复活旧单或泄露旧金额 / 链接。
        const notes = runtime.contextNote({ session: s, text: '确认报价' } as TurnContext).join('');
        assert.ok(!/totalFen|unitPriceFen|amountFen|https?:/.test(notes));
      },
    ],
    [
      'G3-模型收到查询试算顺序与参数语义',
      async () => {
        const s = store.getOrCreateSession('wecom:wmSchedule', 'wecom');
        raw = '请确认型号。';
        prepare = async (opts) => {
          assert.match(opts.system, /收到型号即可.*find_parts/);
          assert.match(opts.system, /数量齐全.*必须.*quote_items/);
          assert.doesNotMatch(opts.system, /先确认型号与数量，再查/);
          const descriptions = opts.tools.map((t) => t.function.description).join('\n');
          assert.match(descriptions, /query.*型号.*不是.*code/);
          assert.match(descriptions, /code.*返回.*编号.*不是.*型号/);
        };
        process.env.LLM_MOCK = '1';
        await handleMessage(s.id, '6205RS', 'wecom');
      },
    ],
  ] as const) {
    try {
      await check();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
      console.log(`FAIL ${name}`);
    }
  }
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
  // 首次真实闸 12-lines 第2遍的实际 draft；型号、数量与价格均为合成数据。
  await sample(
    'G4-真实回复内部规则外露',
    '为您试算如下：\n\n型号：6205-2RS 深沟球轴承（编号 bearing-02）\n数量：24件\n单价：9.00元/件\n金额：216.00元（含税，税率13%）\n库存：现货\n\n价格、订单、付款链接由代码与工具决定，不自行计算、修改或承诺。税票、运费、付款条款与有效期只按本轮已发布政策说明。询价太长时只列前10行，其余用正式报价单展示。库存与交期：现货（以此为准，交期以顾问确认为准）。\n\n如果确认需要，我可以为您起草正式报价单，是否继续？',
    /^(?![\s\S]*(?:代码与工具|本轮已发布政策|只列前10行))[\s\S]*6205-2RS[\s\S]*24件[\s\S]*216\.00元[\s\S]*正式报价单/u,
    '6205-2RS',
    24,
  );
  assert.deepEqual(failures, []);
} finally {
  globalThis.fetch = originalFetch;
  assert.deepEqual((await store.drainStore(5000)).undrained, []);
  config.__configTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
