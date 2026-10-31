// 11 R7：工业工具与建单回归；包含合成ERP门面及真实映射/连接器/registry的接缝用例。
import './selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIndustrialRuntime } from './packs/industrial/runtime.js';
import { defaultIndustrialPolicy } from './packs/industrial/policy.js';
import { industrialReplyGuard, industrialFollowupGuard } from './packs/industrial/guards.js';
import { normalizePartNo } from './packs/industrial/normalize.js';
import { prefetch } from './packs/industrial/turn.js';
import type { PackSources, Session, LineOrder, TurnContext, ReplyGuardContext, FollowupGuardContext } from './core/pack-api.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-erp-'));
Object.assign(process.env, {
  VAR_DIR: dir,
  CONFIG_SOURCE: 'file',
  LLM_MOCK: '1',
  SOP_PATH: path.join(dir, 'sop.md'),
  SERVER_SELFTEST: '1',
  PUBLIC_BASE_URL: 'https://shop.example.test',
});
const tenancy = await import('./tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('./tenancy/testing.js');
enterTenantScopeForTest(tenancy.hostRuntime());
const config = await import('./config/source.js');
const store = await import('./store.js');
const { bindPack } = await import('./core/pack-api.js');
assert.equal(config.packSources().erp.active('part'), false, '未装配引擎时连接器不启用');
assert.equal(config.packSources().erp.mapped('part', 'part-0'), false);
await import('./core/engine/sources.js');
const parts = Array.from({ length: 32 }, (_, i) => ({
  id: `part-${i}`,
  partNo: `HS${1000 + i}`,
  name: '合成轴承',
  brand: '合成品牌',
  category: '轴承' as const,
  specs: ['内径25mm'],
  unit: '件' as const,
  unitPrice: 8,
  moq: 1,
  stock: 100,
  leadDays: 12,
  aliases: [`AL${1000 + i}`],
  substitutes: i === 0 ? ['HS1001'] : [],
}));
for (const file of ['sop.md', 'brand.json', 'pack.json']) fs.copyFileSync(`data/packs/industrial/${file}`, path.join(dir, file));
fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ ...defaultIndustrialPolicy, autoApproveMaxFen: 100000 }));
fs.mkdirSync(path.join(dir, 'catalog'));
fs.writeFileSync(path.join(dir, 'catalog/part.json'), JSON.stringify(parts));
const originalNow = Date.now;
let now = Date.parse('2026-10-26T04:00:00Z');
Date.now = () => now;
let sequence = 0;
let sources = config.packSources();
let runtime = createIndustrialRuntime(sources);
const freshSession = () => store.getOrCreateSession(`erp-test-${++sequence}`, 'web');
const execute = async (name: string, args: unknown, session: Session) =>
  runtime.tools
    .find((tool) => tool.def.function.name === name)!
    .execute(args, {
      session,
      hints: {},
      text: '',
      args: {},
      notes: {},
      handoffDeclined: false,
    });
const quote = (session: Session, qty = 10, query = 'HS1000') => execute('quote_items', { items: [{ query, qty }] }, session);
const make = async (session: Session, qty = 10) => {
  const result = await execute('create_quote_sheet', { items: [{ code: 'part-0', qty }] }, session);
  return { result, order: store.getAnyOrder(session.orderIds.at(-1)!) as LineOrder };
};
const guard = async (session: Session, text: string, followup = false, toolSources: ReplyGuardContext['toolSources'] = []) => {
  const ctx = { session, text, inputText: '是现货吧', policy: sources.currentPolicy().policy, toolSources, recordGuard() {} };
  const result = followup
    ? await industrialFollowupGuard(sources).run(ctx as unknown as FollowupGuardContext)
    : await industrialReplyGuard(sources).run(ctx as unknown as ReplyGuardContext);
  return result?.action === 'pass' ? text : result && 'text' in result ? result.text : '';
};
const turn = (session: Session, text: string): TurnContext => ({
  session,
  text,
  policy: sources.currentPolicy().policy,
  callTool: async (name, args) => ({ name, args, result: await execute(name, args, session) }),
});
try {
  bindPack(runtime, runtime.defaultBrand);
  // 该段在 df85a025 上执行生成固定夹具；仅抹去随机订单 id，其余订单字段逐字节保留。
  const session = freshSession();
  const exact = await execute('find_parts', { query: 'HS1000' }, session);
  const alias = await execute('find_parts', { query: 'AL1000' }, session);
  const candidates = await execute('find_parts', { query: 'HS10' }, session);
  const estimate = await quote(session);
  const made = await make(session);
  const order = JSON.stringify(made.order).replaceAll(made.order.id, 'ord_fixture');
  const texts = ['HS1000有现货。', 'HS1000现货7件，其余约12天。', 'HS1000明天发。', 'HS1000可以替代HS1001。'];
  const guards = await Promise.all(texts.map(async (text) => [await guard(session, text), await guard(session, text, true)]));
  const snapshot = JSON.stringify({
    exact,
    alias,
    candidates,
    estimate,
    result: made.result.replaceAll(made.order.id, 'ord_fixture'),
    order,
    guards,
  });
  // BASELINE_ASSERT
  assert.equal(snapshot, JSON.stringify(JSON.parse(fs.readFileSync(new URL('./fixtures/industrial-pre11.json', import.meta.url), 'utf8'))));
  console.log('ERP BASELINE PASS: df85a025 工具、完整订单（仅替换随机id）、主回复与跟进逐字节一致');

  // active 为假时，任何其他 ERP 能力被访问都直接失败。
  sources = {
    ...config.packSources(),
    erp: {
      active: () => false,
      mapped: () => {
        throw new Error('inactive mapped');
      },
      fresh: () => {
        throw new Error('inactive fresh');
      },
      availability: () => {
        throw new Error('inactive availability');
      },
    },
  };
  runtime = createIndustrialRuntime(sources);
  bindPack(runtime, runtime.defaultBrand);
  const disabled = freshSession();
  assert.equal(await execute('find_parts', { query: 'HS1000' }, disabled), exact);
  assert.equal(await quote(disabled), estimate);
  const disabledOrder = await make(disabled);
  assert.equal(
    JSON.stringify(disabledOrder.order).replaceAll(disabledOrder.order.id, 'ord_fixture').replace(disabled.id, session.id),
    order,
  );
  assert.deepEqual(await Promise.all(texts.map(async (text) => [await guard(disabled, text), await guard(disabled, text, true)])), guards);
  await prefetch(turn(freshSession(), 'HS1000 10件'), sources);
  console.log('ERP INACTIVE PASS: 所有 ERP 路径门控，无异步调用或新鲜值读取');

  // 接缝回归：真实自动映射 → registry → packSources → 工业工具，三个编号刻意不同。
  const { startOdooMock } = await import('./connectors/odoo-mock.js');
  const { createOdooConnector } = await import('./connectors/odoo.js');
  const { autoMapProducts } = await import('./connectors/mapping.js');
  const { createEgress } = await import('./net/egress.js');
  const { Redacted } = await import('./channels/secrets.js');
  const { __erpTest: seamRegistry } = await import('./connectors/registry.js');
  const { packSources: seamPackSources } = await import('./core/engine/sources.js');
  const { sealConnectorSecrets: sealSeamSecrets } = await import('./connectors/secrets.js');
  const seamPart = { ...parts[0]!, id: 'part-a', partNo: '6205-2RS', moq: 10, aliases: [], substitutes: [] };
  const seamDir = path.join(dir, 'seam');
  fs.mkdirSync(path.join(seamDir, 'catalog'), { recursive: true });
  for (const file of ['sop.md', 'brand.json', 'pack.json', 'policy.json']) fs.copyFileSync(path.join(dir, file), path.join(seamDir, file));
  fs.writeFileSync(path.join(seamDir, 'catalog/part.json'), JSON.stringify([seamPart]));
  const seamTenant = tenancy.createTenantRuntime({ id: '33333333-3333-4333-8333-333333333333', slug: 'erp-seam', isHost: true });
  tenancy.registerRuntime(seamTenant);
  const previousSopPath = process.env.SOP_PATH;
  const mock = await startOdooMock({
    version: 20,
    apiKey: 'synthetic-key',
    products: [{ id: 731, default_code: '6205 2rs', uom_id: [1, 'Synthetic units'], active: true, sale_ok: true, freeQty: { 10: 7 } }],
  });
  try {
    process.env.SOP_PATH = path.join(seamDir, 'sop.md');
    await tenancy.withTenantScope(seamTenant, async () => {
      const seamSources = seamPackSources();
      const seamRuntime = createIndustrialRuntime(seamSources);
      bindPack(seamRuntime, seamRuntime.defaultBrand);
      const send = createEgress(mock.url, {
        allowLoopback: true,
        resolver: { resolve4: async () => ['127.0.0.1'], resolve6: async () => [] },
      });
      const connector = createOdooConnector({ send, apiKey: new Redacted({ apiKey: 'synthetic-key' }), locationId: 10 });
      const connectorId = '44444444-4444-4444-8444-444444444444';
      const mapping = await autoMapProducts({
        declaration: seamRuntime.erp!,
        items: [{ kind: 'part', code: seamPart.id, status: 'active', payload: seamPart }],
        connectorId,
        connector,
        uom: { 件: 1 },
        existing: [],
        now: () => now,
      });
      assert.deepEqual(mapping.mapped, ['part-a']);
      assert.equal(mapping.links[0]!.remoteId, 731);
      assert.notEqual(seamPart.id, seamRuntime.erp!.key(seamPart));
      const key = Buffer.alloc(32, 0x31);
      const ring = { current: { id: 'synthetic', key }, all: new Map([['synthetic', key]]) };
      const sealed = sealSeamSecrets(ring, { tenantId: seamTenant.id, connectorId }, { apiKey: 'synthetic-key' });
      // 仅注入测试出站，客户端、映射、registry 与 PackSources 全走真实实现。
      seamRegistry.configure({ factory: (opts) => createOdooConnector({ ...opts, send }), alert: () => {} });
      seamRegistry.install(
        {
          id: connectorId,
          kind: 'odoo',
          status: 'active',
          baseUrl: 'https://erp.example.test',
          database: null,
          settings: { locationId: 10, uom: { 件: 1 }, keyExpiresAt: '2030-01-01' },
          secretsCt: sealed.ct,
          secretsKeyId: sealed.keyId,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        },
        mapping.links,
        ring,
      );
      assert.equal(seamSources.erp.mapped('part', seamPart.id), true, 'ERP 接缝：映射表以产品库code为键');
      assert.equal(seamSources.erp.mapped('part', normalizePartNo(seamPart.partNo)), false);
      const seamSession = store.getOrCreateSession('erp-seam', 'web');
      const seamExecute = async (name: string, args: unknown) =>
        JSON.parse(
          await seamRuntime.tools
            .find((tool) => tool.def.function.name === name)!
            .execute(args, {
              session: seamSession,
              hints: {},
              text: '',
              args: {},
              notes: {},
              handoffDeclined: false,
            }),
        );
      const found = await seamExecute('find_parts', { query: seamPart.partNo });
      assert.equal(found.parts[0].stock, '部分现货', 'ERP 接缝：find_parts 必须使用产品库code命中自动映射');
      const quoted = await seamExecute('quote_items', { items: [{ query: seamPart.partNo, qty: 10 }] });
      assert.equal(quoted.lines[0].delivery, '现货 7 件，其余约 12 天', 'ERP 接缝：quote_items 必须读取Odoo可售量');
      assert.equal(seamSources.erp.fresh('part', seamPart.id)?.onHand, 7);
      assert.equal(seamSources.erp.fresh('part', normalizePartNo(seamPart.partNo)), undefined);
      const values = await seamSources.erp.availability('part', [seamPart.id]);
      assert.deepEqual([...values.keys()], ['part-a']);
      const stockRequests = mock.requests.filter((request) => (request.body as { fields?: string[] }).fields?.includes('free_qty'));
      assert.equal(stockRequests.length, 1, '接缝查询共用registry缓存');
      assert.deepEqual(
        (stockRequests[0]!.body as { domain: unknown }).domain,
        [['id', 'in', [731]]],
        'ERP 接缝：Odoo只收到自动映射出的整数id',
      );
      assert.equal(seamPart.stock, 100);
    });
    console.log('ERP SEAM PASS: 接缝回归（自动映射→registry→packSources→工业工具），产品库code与型号不同，Odoo收到整数id731');
  } finally {
    process.env.SOP_PATH = previousSopPath;
    seamRegistry.reset();
    tenancy.unregisterRuntime(seamTenant.id);
    await mock.close();
  }

  let enabled = true;
  let cooldown = false;
  let throws = false;
  let onHand = 7;
  const cache = new Map<string, { onHand: number; at: number }>();
  const requests: string[][] = [];
  assert.ok(
    parts.every((part) => normalizePartNo(part.partNo) !== part.id),
    '合成型号归一值必须与条目code不同',
  );
  const mapped = new Set(parts.slice(0, 31).map((part) => part.id));
  const erp: PackSources['erp'] = {
    active: (kind) => enabled && kind === 'part',
    mapped: (kind, code) => kind === 'part' && mapped.has(code),
    fresh: (kind, code) => {
      const value = cache.get(code);
      return kind === 'part' && value && now - value.at <= 60000 ? value : undefined;
    },
    async availability(kind, codes) {
      if (throws) throw new Error('合成外部错误，不应进入会话');
      const missing = codes.filter((code) => mapped.has(code) && (!cache.has(code) || now - cache.get(code)!.at > 30000));
      if (!cooldown && missing.length) {
        requests.push([...missing]);
        for (const code of missing) cache.set(code, { onHand, at: now });
      }
      return new Map(
        codes.flatMap((code) => {
          const value = erp.fresh(kind, code);
          return value ? [[code, value]] : [];
        }),
      );
    },
  };
  sources = { ...config.packSources(), erp };
  runtime = createIndustrialRuntime(sources);
  bindPack(runtime, runtime.defaultBrand);
  const live = await import('./packs/industrial/live.js');
  assert.equal(live.live(parts[0]!), parts[0]);
  assert.deepEqual(live.live(parts[0]!, { onHand: 7, at: now }), { ...parts[0], stock: 7 });
  const liveSession = freshSession();
  const liveQuote = await quote(liveSession);
  assert.equal(JSON.parse(liveQuote).lines[0].delivery, '现货 7 件，其余约 12 天');
  assert.equal((await make(liveSession)).order.lines[0]!.attrs!['交期'], '现货 7 件，其余约 12 天');
  assert.equal(JSON.parse(await execute('find_parts', { query: 'HS1000' }, liveSession)).parts[0].stock, '现货');
  assert.equal(await guard(liveSession, 'HS1000现货7件，其余约12天。'), 'HS1000现货7件，其余约12天。');
  assert.match(await guard(liveSession, 'HS1000全部现货。'), /库存和交期以顾问确认为准/);
  assert.equal(await guard(liveSession, 'HS1000现货7件，其余约12天。', true), 'HS1000现货7件，其余约12天。');
  now += 29999;
  assert.equal(await quote(liveSession), liveQuote);
  assert.equal(requests.length, 1, '30秒内再问不请求');
  assert.equal(parts[0]!.stock, 100, '不能改产品库对象');
  console.log('ERP LIVE PASS: 可售7/库100/交期12，工具与订单同交期；30秒缓存复用');

  cache.clear();
  requests.length = 0;
  const three = freshSession();
  const prefetched = await prefetch(turn(three, 'HS1000 10件，HS1001 10件，HS1002'), sources);
  assert.deepEqual(requests, [['part-0', 'part-1', 'part-2']]);
  assert.deepEqual(
    prefetched!.calls.map((call) => call.name),
    ['quote_items', 'find_parts'],
  );
  cache.clear();
  requests.length = 0;
  const confirm = freshSession();
  confirm.packState = {
    rfqIntake: {
      id: 'int_123456789abc',
      at: now,
      status: 'pending',
      lines: parts.slice(0, 20).map((part) => ({ q: part.partNo, qty: 10, m: 'exact' })),
    },
  };
  await prefetch(turn(confirm, '确认'), sources);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.length, 20);
  cache.clear();
  requests.length = 0;
  await prefetch(turn(freshSession(), parts.map((part) => part.partNo).join('，')), sources);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.length, 30);
  cache.clear();
  requests.length = 0;
  await execute('find_parts', { query: 'HS10' }, freshSession());
  assert.equal(requests.length, 0, '非精确候选不查ERP');
  const expired = freshSession();
  const expiredOrder = (await make(expired)).order;
  expiredOrder.approval = { state: 'approved', requestedAt: now - 10 * 86400000, decidedAt: now - 10 * 86400000 };
  store.saveOrder(expiredOrder);
  cache.clear();
  requests.length = 0;
  const resumed = await prefetch(turn(expired, '重新确认报价，HS1001'), sources);
  assert.deepEqual(requests, [['part-1', 'part-0']], '文字与过期报价行合并一次预热');
  assert.deepEqual(
    resumed!.calls.map((call) => call.name),
    ['quote_items'],
  );
  cache.clear();
  onHand = 0;
  const zero = freshSession();
  assert.equal(JSON.parse(await execute('find_parts', { query: 'AL1000' }, zero)).parts[0].stock, '无现货');
  assert.equal(JSON.parse(await quote(zero)).lines[0].delivery, '约 12 天');
  assert.equal((await make(zero)).order.approval!.state, 'pending');
  onHand = 7;
  console.log('ERP PREFETCH PASS: 3型号/20行确认/过期续算各一次，预热上限30，候选不查，零库存无现货');

  cache.clear();
  requests.length = 0;
  cooldown = true;
  const fallback = freshSession();
  const fallbackQuote = await quote(fallback);
  assert.equal(fallbackQuote, estimate);
  const pending = await make(fallback);
  assert.equal(pending.result, '{"state":"pending"}');
  assert.equal(pending.order.lines[0]!.attrs!['交期'], '现货');
  assert.equal(pending.order.approval!.state, 'pending', '低于自动批准阈值且产品库全现货仍转人审');
  assert.equal(fallback.messages.filter((message) => message.role === 'system').length, 1);
  assert.equal(fallback.messages[0]!.content, 'ERP 这次没查到 1 个型号的库存，按产品库的库存回答');
  await quote(fallback);
  await execute('find_parts', { query: 'HS1000' }, fallback);
  now += 120000;
  assert.equal(await guard(fallback, 'HS1000有现货。'), '库存和交期以顾问确认为准。');
  assert.equal(await guard(fallback, 'HS1000有现货。', true), '');
  assert.equal(await guard(fallback, 'HS1000可以替代HS1001。'), 'HS1000可以替代HS1001。');
  assert.equal(
    await guard(fallback, 'HS1000有现货。', false, [{ name: 'quote_items', args: {}, result: fallbackQuote }]),
    'HS1000有现货。',
    '本轮工具仍为事实',
  );
  await quote(fallback);
  assert.equal(fallback.messages.filter((message) => message.role === 'system').length, 1);
  now += 30 * 60000;
  await quote(fallback);
  assert.equal(fallback.messages.filter((message) => message.role === 'system').length, 2);
  const unmapped = freshSession();
  await quote(unmapped, 10, 'HS1031');
  assert.equal(unmapped.messages.length, 0, '未映射是正常情况，无系统消息');
  const unmappedOrder: LineOrder = { ...pending.order, lines: [{ ...pending.order.lines[0]!, code: 'part-31' }] };
  assert.equal(runtime.quotes!.autoApprovable!(unmappedOrder, unmapped), false);
  throws = true;
  await prefetch(turn(freshSession(), 'HS1000 10件'), sources);
  const failed = freshSession();
  assert.equal(await quote(failed), estimate);
  assert.equal(failed.messages.length, 1);
  throws = false;
  cooldown = false;
  cache.clear();
  onHand = 100;
  const auto = freshSession();
  await quote(auto);
  assert.equal((await make(auto)).order.approval!.auto, true);
  now += 60001;
  assert.equal(await guard(auto, 'HS1000有现货。'), '库存和交期以顾问确认为准。');
  assert.equal(await guard(auto, 'HS1000有现货。', true), '');
  assert.equal(runtime.quotes!.autoApprovable!(store.getAnyOrder(auto.orderIds[0]!) as LineOrder, auto), false);
  enabled = false;
  assert.equal(await guard(auto, 'HS1000有现货。'), 'HS1000有现货。');
  console.log('ERP FALLBACK PASS: 冷却转人审、映射消息30分钟去重、未映射静默、过期库存主回复替换/跟进删句、失败继续');

  // 真实 registry → 两层 sources → 引擎慢轮 trace；只替换连接器传输。
  const { __erpTest, erpSources } = await import('./connectors/registry.js');
  const { packSources } = await import('./core/engine/sources.js');
  const { sealConnectorSecrets } = await import('./connectors/secrets.js');
  const { ErpError } = await import('./connectors/types.js');
  const { handleMessage } = await import('./core/engine/index.js');
  const tenant = tenancy.createTenantRuntime({ id: '11111111-1111-4111-8111-111111111111', slug: 'erp-trace', isHost: true });
  tenancy.registerRuntime(tenant);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let fail = false;
  try {
    await tenancy.withTenantScope(tenant, async () => {
      sources = config.packSources();
      runtime = createIndustrialRuntime(sources);
      let modelText = 'HS1000现货7件，其余约12天。';
      runtime.mock = {
        chat: async (opts) => {
          assert.ok(!JSON.stringify([opts.system, opts.messages, opts.contextNote]).includes('ERP 这次没查到'));
          now += 9000;
          return modelText;
        },
      };
      bindPack(runtime, runtime.defaultBrand);
      const key = Buffer.alloc(32, 0x31);
      const ring = { current: { id: 'synthetic', key }, all: new Map([['synthetic', key]]) };
      const id = '22222222-2222-4222-8222-222222222222';
      const sealed = sealConnectorSecrets(ring, { tenantId: tenant.id, connectorId: id }, { apiKey: 'synthetic-key' });
      __erpTest.configure({
        factory: () => ({
          stock: async (ids) => {
            now += fail ? 1001 : 17;
            if (fail) throw new ErpError('timeout');
            return new Map(ids.map((id) => [id, { freeQty: 7, uomId: 1, active: true }]));
          },
          products: async () => [],
          check: async () => ({ companyCurrency: 'CNY', locationOk: true }),
        }),
        alert: () => {},
      });
      __erpTest.install(
        {
          id,
          kind: 'odoo',
          status: 'active',
          baseUrl: 'https://erp.example.test',
          database: null,
          settings: { locationId: 1, uom: { 件: 1 }, keyExpiresAt: '2030-01-01' },
          secretsCt: sealed.ct,
          secretsKeyId: sealed.keyId,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        },
        parts.slice(0, 3).map((part, i) => ({
          connectorId: id,
          kind: 'part',
          code: part.id,
          remoteId: i + 1,
          remoteCode: part.partNo,
          remoteUomId: 1,
          source: 'auto',
          checkedAt: new Date(now),
        })),
        ring,
      );
      for (const facade of [erpSources, packSources().erp, config.packSources().erp]) {
        assert.equal(facade.mapped('part', 'part-0'), true);
        assert.equal(facade.mapped('part', 'part-31'), false);
        assert.equal(facade.mapped('route', 'part-0'), false);
      }
      assert.equal((await handleMessage('trace-first', 'HS1000 10件', 'web')).text, modelText);
      modelText = '已查询型号。';
      assert.ok(warnings.some((text) => text.includes('ERP 17ms cache=miss deadline=false')));
      warnings.length = 0;
      await handleMessage('trace-cached', 'HS1000', 'web');
      assert.ok(warnings.some((text) => text.includes('整轮耗时')));
      assert.ok(!warnings.some((text) => text.includes('ERP ')), '纯缓存命中不新增ERP段');
      warnings.length = 0;
      fail = true;
      modelText = 'HS1001有现货。';
      const fallbackReply = await handleMessage('trace-deadline', 'HS1001', 'web');
      assert.equal(fallbackReply.text, modelText);
      const traceSession = store.getOrCreateSession('trace-deadline', 'web');
      assert.ok(traceSession.messages.some((message) => message.role === 'system' && message.content.startsWith('ERP 这次没查到 ')));
      now += 120000;
      assert.equal((await handleMessage('trace-deadline', '是现货吧', 'web')).text, '库存和交期以顾问确认为准。');
      assert.ok(warnings.some((text) => text.includes('ERP 1001ms cache=miss deadline=true')));
      assert.ok(!warnings.some((text) => /erp\.example|synthetic-key/.test(text)));
    });
  } finally {
    console.warn = warn;
    __erpTest.reset();
    tenancy.unregisterRuntime(tenant.id);
  }
  console.log('ERP TRACE PASS: mapped三层门面、未命中耗时/截止、缓存命中省略ERP段、无地址凭据');
} finally {
  Date.now = originalNow;
  config.__configTest.reset();
  fs.rmSync(dir, { recursive: true, force: true });
}
