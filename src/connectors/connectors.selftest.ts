// 11 第 3 步：固定 JSON-2 契约；不依赖本机样本、容器或真实 ERP。
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Redacted } from '../channels/secrets.js';
import { createEgress, EgressError, type EgressCode, type EgressRequest } from '../net/egress.js';
import { createOdooConnector } from './odoo.js';
import { startOdooMock, type MockFault } from './odoo-mock.js';
import { ErpError, type ErpErrorCode } from './types.js';

const key = 'synthetic-key';
const marker = 'synthetic-sensitive-response';
const apiKey = new Redacted({ apiKey: key });
const resolver = { resolve4: async () => ['127.0.0.1'], resolve6: async () => [] };
let count = 0;
function pass(version: number, name: string) {
  count++;
  console.log(`connectors Odoo ${version}: ✔ ${name}`);
}
async function fails(action: () => unknown, code: ErpErrorCode) {
  await assert.rejects(
    async () => action(),
    (error) => {
      assert.ok(error instanceof ErpError);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
      const printed = inspect(error, { showHidden: true, depth: null }) + JSON.stringify(error, Object.getOwnPropertyNames(error));
      for (const forbidden of [key, marker, 'erp.example.test', 'Synthetic diagnostic']) assert.ok(!printed.includes(forbidden));
      return true;
    },
  );
}

for (const version of [19, 20] as const) {
  const mock = await startOdooMock({ version });
  try {
    const requests: EgressRequest[] = [];
    const network = createEgress(mock.url, { allowLoopback: true, resolver });
    const send: typeof network = async (request) => {
      requests.push(request);
      return network(request);
    };
    const start = Date.now();
    let clock = start;
    const sleeps: number[] = [];
    const connector = createOdooConnector({
      send,
      apiKey,
      database: 'synthetic',
      locationId: 10,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const deadline = Date.now() + 2000;
    assert.deepEqual(
      await connector.stock([1, 2, 4, 5], deadline),
      new Map([
        [1, { freeQty: 9, uomId: 1, active: true }],
        [2, { freeQty: 0, uomId: 1, active: true }],
        [4, { freeQty: 4, uomId: 1, active: false }],
      ]),
    );
    assert.deepEqual(requests[0], {
      path: '/json/2/product.product/search_read',
      headers: { Authorization: `bearer ${key}`, 'Content-Type': 'application/json', 'X-Odoo-Database': 'synthetic' },
      body: JSON.stringify({
        domain: [['id', 'in', [1, 2, 4, 5]]],
        fields: ['free_qty', 'uom_id', 'active'],
        context: { location: 10, active_test: false },
      }),
      deadline,
      maxBytes: 65536,
    });
    assert.equal(mock.requests[0].method, 'POST');
    assert.equal(mock.requests[0].headers.authorization, `bearer ${key}`);
    assert.equal(mock.requests[0].headers['content-type'], 'application/json');
    assert.equal(mock.requests[0].headers['x-odoo-database'], 'synthetic');
    assert.deepEqual(mock.requests[0].body, JSON.parse(requests[0].body));
    assert.deepEqual(await connector.stock([], deadline), new Map());
    for (const ids of [[0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], Array<number>(31).fill(1)]) {
      await assert.rejects(() => connector.stock(ids, deadline), RangeError);
    }
    assert.equal(requests.length, 1, '空数组和非法 id 不出站');
    await connector.stock(
      Array.from({ length: 30 }, (_, i) => i + 1),
      Date.now() + 2000,
    );
    const otherLocation = createOdooConnector({ send, apiKey, locationId: 20 });
    assert.equal((await otherLocation.stock([1], Date.now() + 2000)).get(1)?.freeQty, 21);
    pass(version, 'stock 请求逐字段、30 个上限、空数组、按库位、小数、负数、归档与删除');

    const beforeInvalidDatabase = requests.length;
    for (const database of ['', 'bad space', 'bad\nheader', 'a\n', 'a\r', 'a/b', '中文', 'a'.repeat(64)]) {
      assert.throws(
        () => createOdooConnector({ send, apiKey, database, locationId: 10 }),
        (err) => err instanceof ErpError && err.code === 'invalid',
      );
    }
    assert.equal(requests.length, beforeInvalidDatabase);
    for (const database of [null, undefined, 'A_0.-', 'a'.repeat(63)]) {
      const captured: EgressRequest[] = [];
      await createOdooConnector({
        send: async (request) => {
          captured.push(request);
          return { status: 200, mediaType: 'application/json', body: Buffer.from('[]') };
        },
        apiKey,
        database,
        locationId: 10,
      }).stock([1], deadline);
      assert.deepEqual(captured[0].headers, {
        Authorization: `bearer ${key}`,
        'Content-Type': 'application/json',
        ...(database == null ? {} : { 'X-Odoo-Database': database }),
      });
    }
    assert.equal(String(apiKey), '[已遮盖]');
    assert.equal(JSON.stringify(apiKey), '"[已遮盖]"');
    assert.equal(inspect(apiKey), '[已遮盖]');
    let reveals = 0;
    const countedKey = new (class extends Redacted<{ apiKey: string }> {
      override reveal() {
        reveals++;
        return super.reveal();
      }
    })({ apiKey: key });
    const counted = createOdooConnector({ send, apiKey: countedKey, locationId: 10 });
    await counted.stock([], Date.now() + 2000);
    assert.equal(reveals, 0, '构造与空请求不解封');
    await counted.stock([1], Date.now() + 2000);
    assert.equal(reveals, 1, '只在构造请求头时解封一次');
    pass(version, 'database 字符集与长度、可空请求头、Redacted 打印');

    const pageStart = requests.length;
    assert.deepEqual(await connector.products({ offset: 0, limit: 2 }), [
      { id: 1, code: 'PART-A', uomId: 1 },
      { id: 2, code: 'PART-DUP', uomId: 1 },
    ]);
    assert.deepEqual(await connector.products({ offset: 2, limit: 2 }), [{ id: 3, code: 'PART-DUP', uomId: 1 }]);
    assert.deepEqual(await connector.products({ offset: 3, limit: 500 }), []);
    assert.deepEqual(requests[pageStart], {
      path: '/json/2/product.product/search_read',
      headers: requests[0].headers,
      body: JSON.stringify({
        domain: [
          ['default_code', '!=', false],
          ['sale_ok', '=', true],
        ],
        fields: ['default_code', 'uom_id'],
        order: 'id asc',
        offset: 0,
        limit: 2,
      }),
      deadline: start + 15000,
      maxBytes: 2 * 1024 * 1024,
    });
    for (const page of [
      { offset: -1, limit: 1 },
      { offset: 0.5, limit: 1 },
      { offset: 0, limit: 501 },
      { offset: 0, limit: 0 },
      { offset: 0, limit: NaN },
    ])
      await assert.rejects(() => connector.products(page), RangeError);
    pass(version, 'products 请求逐字段、默认归档过滤、id asc 分页、重复编号与 500 上限');

    const checkStart = requests.length;
    assert.deepEqual(await connector.check(), { companyCurrency: 'CNY', locationOk: true });
    assert.deepEqual(sleeps, [1000, 1000, 1000, 1000]);
    const checks = [
      ['res.users/context_get', {}],
      ['res.users/read', { ids: [5], fields: ['company_id'] }],
      ['res.company/read', { ids: [2], fields: ['currency_id'] }],
      ['res.currency/read', { ids: [6], fields: ['name'] }],
      ['stock.location/search_read', { domain: [['id', '=', 10]], fields: ['id'], limit: 1 }],
    ] as const;
    for (const [index, [path, body]] of checks.entries())
      assert.deepEqual(requests[checkStart + index], {
        path: `/json/2/${path}`,
        headers: requests[0].headers,
        body: JSON.stringify(body),
        deadline: start + 5000 + index * 1000,
        maxBytes: 65536,
      });
    const missing = createOdooConnector({ send, apiKey, locationId: 999, sleep: async () => {} });
    assert.deepEqual(await missing.check(), { companyCurrency: 'CNY', locationOk: false });
    pass(version, 'check 五次请求逐字段、默认公司、币种代码、独立 5 秒/64 KiB 与四段 1 秒间隔');

    for (const [status, code] of [
      [400, 'invalid'],
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [405, 'invalid'],
      [408, 'invalid'],
      [422, 'invalid'],
      [429, 'server'],
      [500, 'server'],
      [502, 'server'],
      [503, 'server'],
    ] as const) {
      for (const fault of [{ status }, { status, html: true }, { status, rawBody: '{broken' }]) {
        mock.enqueue(fault);
        await fails(() => connector.stock([1], Date.now() + 2000), code);
      }
    }
    for (const fault of [
      { mediaType: 'text/html' },
      { mediaType: null },
      { mediaType: 'application/problem+json' },
      { rawBody: '{' },
      { body: { result: [] } },
      { body: null },
      { body: {} },
    ] satisfies MockFault[]) {
      mock.enqueue(fault);
      await fails(() => connector.stock([1], Date.now() + 2000), 'bad_response');
    }
    mock.enqueue({ mediaType: 'Application/JSON; Charset=UTF-8' });
    assert.equal((await connector.stock([1], Date.now() + 2000)).get(1)?.freeQty, 9);
    const dangerous = { name: marker, message: `${key} https://erp.example.test`, debug: marker, arguments: [key], context: {} };
    mock.enqueue({ status: 500, body: dangerous });
    await fails(() => connector.stock([1], Date.now() + 2000), 'server');
    pass(version, 'R6 错误表逐行、其他 4xx/429、HTML/坏 JSON 状态优先、媒体参数与错误脱敏');

    const good = { id: 1, free_qty: 2.9, uom_id: [1, 'Synthetic units'], active: true };
    for (const patch of [
      { id: 0 },
      { id: 1.1 },
      { id: '1' },
      { free_qty: null },
      { free_qty: '2' },
      { free_qty: Infinity },
      { active: null },
      { active: 1 },
      { uom_id: false },
      { uom_id: [] },
      { uom_id: [0, 'units'] },
      { uom_id: [1, 2] },
      { uom_id: [1, 'units', 'extra'] },
    ]) {
      mock.enqueue({ body: [good, { ...good, id: 2, ...patch }] });
      await fails(() => connector.stock([1, 2], Date.now() + 2000), 'bad_response');
    }
    mock.enqueue({ rawBody: '[{"id":1,"free_qty":1e999,"uom_id":[1,"units"],"active":true}]' });
    await fails(() => connector.stock([1], Date.now() + 2000), 'bad_response');
    for (const body of [
      [null],
      [1],
      [{ id: 1, default_code: false, uom_id: [1, 'units'] }],
      [{ id: 1, default_code: '', uom_id: [1, 'units'] }],
      [{ id: 1, default_code: 'PART', uom_id: [1] }],
      { result: [] },
    ]) {
      mock.enqueue({ body });
      await fails(() => connector.products({ offset: 0, limit: 10 }), 'bad_response');
    }
    const checkBodies = [
      { uid: 5 },
      [{ id: 5, company_id: [2, 'ignored'] }],
      [{ id: 2, currency_id: [6, 'ignored'] }],
      [{ id: 6, name: 'CNY' }],
      [{ id: 10 }],
    ];
    for (const [index, badBody] of [
      { uid: 0 },
      [{ id: 5, company_id: false }],
      [{ id: 2, currency_id: ['6', 'bad'] }],
      [{ id: 6, name: false }],
      [{ id: 0 }],
    ].entries()) {
      mock.enqueue(...checkBodies.slice(0, index).map((body) => ({ body })), { body: badBody });
      await fails(() => missing.check(), 'bad_response');
    }
    mock.enqueue({ body: { uid: 5 } }, { body: [{ id: 5, company_id: [2] }] }, { body: [{ id: 2, currency_id: [6, { ignored: true }] }] });
    assert.equal((await missing.check()).companyCurrency, 'CNY', '关系展示值不用于币种');
    pass(version, 'stock/products/check 坏行整次拒绝、有限数、many2one 与逐阶段结构校验');

    for (const egressCode of [
      'scheme',
      'userinfo',
      'port',
      'host',
      'blocked_address',
      'dns',
      'timeout',
      'too_large',
      'redirect',
      'network',
    ] satisfies EgressCode[]) {
      const bad = createOdooConnector({
        send: async () => {
          throw new EgressError(egressCode);
        },
        apiKey,
        locationId: 10,
      });
      await fails(
        () => bad.stock([1], Date.now() + 2000),
        egressCode === 'timeout' ? 'timeout' : egressCode === 'too_large' ? 'bad_response' : 'egress',
      );
    }
    const bad = createOdooConnector({
      send: async () => {
        throw new Error(`${key} ${marker}`);
      },
      apiKey,
      locationId: 10,
    });
    await fails(() => bad.products({ offset: 0, limit: 1 }), 'egress');
    mock.enqueue({ hang: true });
    await fails(() => connector.stock([1], Date.now() + 100), 'timeout');
    mock.enqueue({ delayMs: 15 });
    assert.equal((await connector.stock([1], Date.now() + 2000)).get(1)?.freeQty, 9);
    mock.enqueue({ rawBody: 'x'.repeat(65537) });
    await fails(() => connector.stock([1], Date.now() + 2000), 'bad_response');
    mock.enqueue({ rawBody: 'x'.repeat(2 * 1024 * 1024 + 1) });
    await fails(() => connector.products({ offset: 0, limit: 1 }), 'bad_response');
    pass(version, 'EgressError 全码、未知网络异常、真实挂起超时、延迟成功与响应大小上限');

    for (const [body, status] of [
      [{ fields: ['unknown_field'] }, 500],
      [{ unexpected: true }, 500],
      [{ ids: [1] }, 422],
    ] as const) {
      const response = await network({
        path: '/json/2/product.product/search_read',
        headers: requests[0].headers,
        body: JSON.stringify(body),
        deadline: Date.now() + 2000,
        maxBytes: 65536,
      });
      assert.equal(response.status, status);
      assert.equal(response.mediaType, 'application/json');
      const error = JSON.parse(response.body.toString());
      assert.deepEqual(
        Object.keys(error).sort(),
        ['name', 'message', 'arguments', 'context', 'debug', ...(version === 20 ? ['timestamp'] : [])].sort(),
      );
      assert.equal(typeof error.name, 'string');
      assert.equal(typeof error.message, 'string');
      assert.equal(typeof error.debug, 'string');
      assert.ok(Array.isArray(error.arguments));
      assert.deepEqual(error.context, {});
      if (version === 20) assert.ok(Number.isInteger(error.timestamp));
    }
    pass(version, '模拟器原生错字段/未知参数 500、模型 ids 422 与 19/20 JSON 错误字段');
  } finally {
    await mock.close();
  }

  const scoped = await startOdooMock({ version, keyScope: '' });
  try {
    const connector = createOdooConnector({ send: createEgress(scoped.url, { allowLoopback: true, resolver }), apiKey, locationId: 10 });
    if (version === 20) await fails(() => connector.stock([1], Date.now() + 2000), 'auth');
    else assert.equal((await connector.stock([1], Date.now() + 2000)).get(1)?.freeQty, 9);
    pass(version, '空 scope：19 接受、20 拒绝');
  } finally {
    await scoped.close();
  }

  const malformedQty = await startOdooMock({
    version,
    products: [{ id: 1, default_code: 'PART', uom_id: [1, 'units'], active: true, sale_ok: true, freeQty: { 10: null, 20: 'non-number' } }],
  });
  try {
    const send = createEgress(malformedQty.url, { allowLoopback: true, resolver });
    for (const locationId of [10, 20])
      await fails(() => createOdooConnector({ send, apiKey, locationId }).stock([1], Date.now() + 2000), 'bad_response');
    pass(version, '模拟器可注入 null 与字符串可售量，均按 bad_response 拒绝');
  } finally {
    await malformedQty.close();
  }

  const reusable = await startOdooMock({ version, keepAlive: true, fault: () => ({ delayMs: 30 }) });
  try {
    const sends = [
      createEgress(reusable.url, { allowLoopback: true, resolver }),
      createEgress(reusable.url, { allowLoopback: true, resolver }),
    ];
    await Promise.all(sends.map((send) => createOdooConnector({ send, apiKey, locationId: 10 }).stock([1], Date.now() + 2000)));
    assert.equal(reusable.requests.length, 2);
    assert.equal(reusable.maxInFlight, 2);
    reusable.enqueue({ hang: true });
    const pending = sends[0]({
      path: '/json/2/res.users/context_get',
      headers: { Authorization: `bearer ${key}` },
      body: '{}',
      deadline: Date.now() + 2000,
      maxBytes: 65536,
    });
    const rejected = assert.rejects(pending, EgressError);
    // 等到挂起请求已被服务端接收，再关闭保活与在途连接。
    const acceptedBy = Date.now() + 1000;
    while (reusable.requests.length < 3 && Date.now() < acceptedBy) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(reusable.requests.length, 3);
    await reusable.close();
    await rejected;
    pass(version, '模拟器记录在途最大值、保活与挂起连接关闭');
  } catch (error) {
    await reusable.close();
    throw error;
  }
  // 默认 sleep 也用真实时钟验证；其余时限用上面的注入时钟逐字段覆盖。
  const paced = await startOdooMock({ version });
  try {
    await createOdooConnector({ send: createEgress(paced.url, { allowLoopback: true, resolver }), apiKey, locationId: 10 }).check();
    for (let i = 1; i < paced.requests.length; i++) assert.ok(paced.requests[i].at - paced.requests[i - 1].at >= 1000);
    pass(version, '默认 sleep 的真实请求间隔不少于 1 秒');
  } finally {
    await paced.close();
  }
}
console.log(`CONNECTORS SELFTEST PASS: ${count} 组（Odoo 19/20）`);
