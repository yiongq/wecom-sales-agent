// 11 第 5 步：R5 映射真值、R9 命令行、凭据边界与轮换；数据均为合成。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNEL_KEY_ENV, Redacted, type KeyRing } from '../channels/secrets.js';
import { packSources } from '../config/source.js';
import { autoMapProducts, manualMapProduct, mappingToUnset, type MappingInput } from '../connectors/mapping.js';
import { createOdooConnector } from '../connectors/odoo.js';
import { startOdooMock, type MockProduct } from '../connectors/odoo-mock.js';
import { openConnectorSecrets } from '../connectors/secrets.js';
import { ErpError, type ErpConnector } from '../connectors/types.js';
import { openDb, withTenant, type Db } from '../db/client.js';
import { readErpConnector, listErpItemLinks } from '../db/repo/erp.js';
import { openTestDb, fakeLock, createRealPgFixture } from '../db/testing.js';
import { createEgress } from '../net/egress.js';
import { runtimeById } from '../packs/registry.js';
import { AUDIT_ACTIONS } from '../shared/ui-labels.js';
import { checkErpConnector, runErpConnector, type ConnectorFactory } from './erp-connector.js';

fs.mkdirSync('var', { recursive: true });
const directory = fs.mkdtempSync(path.resolve('var/erp-cli-'));
const credential = path.join(directory, 'credential.json');
const apiKey = 'synthetic-erp-api-value';
fs.writeFileSync(credential, JSON.stringify({ apiKey }), { mode: 0o600 });
const oldKey = Buffer.alloc(32, 11);
const newKey = Buffer.alloc(32, 22);
const oldRing: KeyRing = { current: { id: 'old', key: oldKey }, all: new Map([['old', oldKey]]) };
const newRing: KeyRing = { current: { id: 'new', key: newKey }, all: new Map([['new', newKey]]) };
const ringEnv = `old:${oldKey.toString('base64')}`;
const rotatedEnv = `new:${newKey.toString('base64')},${ringEnv}`;
const declaration = runtimeById('industrial', packSources())!.erp!;
const baseArgs = ['--tenant', 'erp-cli'];
const addArgs = [
  'add-odoo',
  ...baseArgs,
  '--base-url',
  'https://erp.example.test',
  '--database',
  'synthetic-db',
  '--location',
  '10',
  '--uom',
  '件=1',
  '--key-expires',
  '2099-01-01',
  '--secrets-file',
  credential,
];
const ctx = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
let sensitive: string[] = [apiKey, 'https://erp.example.test', 'synthetic-db'];
function clean(output: string) {
  for (const value of sensitive) assert.ok(!output.includes(value), '输出不得含地址、库名、凭据或密文');
}
const fakeConnector: ErpConnector = {
  check: async () => ({ companyCurrency: 'CNY', locationOk: true }),
  products: async () => [{ id: 1, code: 'PART-A', uomId: 1 }],
  stock: async (ids) => new Map(ids.map((id) => [id, { freeQty: 7, uomId: 1, active: true }])),
};

async function mappingSuite() {
  const products: MockProduct[] = Array.from({ length: 498 }, (_, i) => ({
    id: i + 1,
    default_code: `IGNORE-${i}`,
    uom_id: [1, 'Synthetic name never printed'],
    active: true,
    sale_ok: true,
    freeQty: { 10: 1 },
  }));
  products.push(
    { id: 499, default_code: '6205 2RS', uom_id: [1, 'Synthetic'], active: true, sale_ok: true, freeQty: { 10: 7 } },
    { id: 500, default_code: 'DUP', uom_id: [1, 'Synthetic'], active: true, sale_ok: true, freeQty: { 10: 8 } },
    { id: 501, default_code: 'DUP', uom_id: [1, 'Synthetic'], active: true, sale_ok: true, freeQty: { 10: 9 } },
    { id: 502, default_code: 'UNIT', uom_id: [2, 'Synthetic'], active: true, sale_ok: true, freeQty: { 10: 2 } },
    { id: 503, default_code: 'ARCHIVED', uom_id: [1, 'Synthetic'], active: false, sale_ok: true, freeQty: { 10: 3 } },
  );
  const mock = await startOdooMock({ version: 20, products });
  try {
    const connector = createOdooConnector({
      send: createEgress(mock.url, { allowLoopback: true, resolver: { resolve4: async () => ['127.0.0.1'], resolve6: async () => [] } }),
      apiKey: new Redacted({ apiKey: 'synthetic-key' }),
      locationId: 10,
    });
    const item = (code: string, partNo: string, status = 'active', unit = '件') => ({
      kind: 'part',
      code,
      status,
      payload: { partNo, unit, stock: 100, leadDays: 12 },
    });
    const input: MappingInput = {
      declaration,
      connector,
      connectorId: 'synthetic-row',
      uom: { 件: 1 },
      existing: [],
      items: [
        item('a', '6205-2RS'),
        item('missing', 'MISSING'),
        item('dup', 'DUP', 'draft'),
        item('unit', 'UNIT'),
        item('archived', 'ARCHIVED'),
        item('hidden', '6205-2RS', 'disabled'),
        { ...item('other-kind', '6205-2RS'), kind: 'route' },
      ],
    };
    const original = JSON.stringify(input.items);
    const sleeps: number[] = [];
    const result = await autoMapProducts(input, async (ms) => {
      sleeps.push(ms);
    });
    assert.deepEqual(
      [result.mapped, result.unmapped, result.conflict, result.unitMismatch],
      [['a'], ['missing', 'archived'], ['dup'], ['unit']],
    );
    assert.deepEqual(sleeps, [1000]);
    assert.equal(result.links[0].remoteId, 499);
    assert.equal(result.links[0].source, 'auto');
    assert.equal(JSON.stringify(input.items), original, '未映射条目的库存与交期不变');
    const manual = await manualMapProduct(input, 'dup', 500);
    assert.equal(manual.source, 'manual');
    assert.equal(manual.remoteId, 500);
    const preserved = await autoMapProducts({ ...input, existing: [manual] }, async () => {});
    assert.ok(preserved.mapped.includes('dup'));
    assert.ok(!preserved.remove.includes('dup'));
    assert.ok(!preserved.links.some((l) => l.code === 'dup'));
    assert.equal(mappingToUnset([manual], 'part', 'dup'), manual);
    assert.throws(() => mappingToUnset([], 'part', 'dup'), ErpError);
    await assert.rejects(manualMapProduct(input, 'a', 502), ErpError);
    await assert.rejects(manualMapProduct(input, 'a', 503), ErpError);
    await assert.rejects(manualMapProduct(input, 'a', 9999), ErpError);
    await assert.rejects(manualMapProduct(input, 'hidden', 499), ErpError);
    const requests = mock.requests.filter((r) => (r.body as { limit?: number }).limit === 500);
    assert.deepEqual(
      requests.slice(0, 2).map((r) => (r.body as { offset: number }).offset),
      [0, 500],
    );
    console.log('PASS 映射：四类真值 1/2/1/1、跨页重复、500 分页/1 秒等待、草稿、手工保留、单位/归档/缺失拒绝、未映射库存交期不变');
  } finally {
    await mock.close();
  }
}

type Query = <T = Record<string, unknown>>(text: string, args?: unknown[]) => Promise<T[]>;
async function databaseSuite(db: Db, query: Query, label: string) {
  const [tenant] = await query<{ id: string }>(
    "insert into tenants(slug,name,pack_id) values ('erp-cli','合成租户','industrial') returning id",
  );
  await query(
    "insert into tenants(slug,name,pack_id,kind,template_tenant_id,expires_at) values ('erp-sandbox','合成沙箱','industrial','sandbox',$1,now()+interval '1 day')",
    [tenant.id],
  );
  await query(
    "insert into catalog_items(tenant_id,kind,code,ord,status,payload) values ($1,'part','part-a',0,'active',$2),($1,'part','part-b',1,'draft',$3)",
    [
      tenant.id,
      JSON.stringify({ id: 'part-a', partNo: 'PART-A', unit: '件', stock: 100 }),
      JSON.stringify({ id: 'part-b', partNo: 'MISSING', unit: '件', stock: 100 }),
    ],
  );
  let lock = fakeLock();
  const invoke = async (args: string[], connector: ConnectorFactory = () => fakeConnector) => {
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args) => {
      lines.push(args.join(' '));
    };
    console.error = console.log;
    let code: number;
    try {
      code = await runErpConnector(args, { connect: async () => ({ db, lock: async () => lock, close: async () => {} }), connector });
    } finally {
      console.log = log;
      console.error = error;
    }
    const output = lines.join('\n');
    clean(output);
    if (!args.includes('erp-sandbox')) assert.equal(lock.released, true);
    lock = fakeLock();
    return { code, output };
  };
  const read = () => withTenant(db, ctx(tenant.id), readErpConnector);
  assert.equal((await invoke(['show', '--tenant', 'erp-sandbox'])).code, 1);
  assert.equal((await invoke(['rekey', ...baseArgs])).code, 0);
  assert.equal(
    (
      await invoke(addArgs, () => ({
        ...fakeConnector,
        check: async () => {
          throw new ErpError('egress');
        },
      }))
    ).code,
    1,
  );
  assert.equal(await read(), null, 'egress 拒绝不写库');
  assert.equal(
    (
      await invoke(addArgs, () => ({
        ...fakeConnector,
        check: async () => {
          throw new ErpError('auth');
        },
      }))
    ).code,
    1,
  );
  let row = (await read())!;
  assert.equal(row.settings.lastCheck!.result, 'auth');
  sensitive.push(row.secretsCt.toString('base64'), row.secretsCt.toString('hex'));
  assert.equal(
    openConnectorSecrets(oldRing, { tenantId: tenant.id, connectorId: row.id }, row.secretsCt, row.secretsKeyId).reveal().apiKey,
    apiKey,
  );
  assert.equal((await invoke(addArgs)).code, 2);
  assert.equal((await invoke(['show', ...baseArgs])).code, 0);
  assert.equal((await invoke(['check', ...baseArgs])).code, 0);
  assert.equal((await read())!.settings.lastCheck!.result, 'ok');
  for (const [checked, expected] of [
    [{ companyCurrency: 'USD', locationOk: true }, 'currency'],
    [{ companyCurrency: 'CNY', locationOk: false }, 'location'],
  ] as const) {
    assert.equal((await invoke(['check', ...baseArgs], () => ({ ...fakeConnector, check: async () => checked }))).code, 1);
    assert.equal((await read())!.settings.lastCheck!.result, expected);
  }
  const before = row.baseUrl;
  assert.equal(
    (
      await invoke(['set', ...baseArgs, '--base-url', 'https://erp.example.test/new'], () => ({
        ...fakeConnector,
        check: async () => {
          throw new ErpError('egress');
        },
      }))
    ).code,
    1,
  );
  assert.equal((await read())!.baseUrl, before);
  assert.equal(
    (
      await invoke(['set', ...baseArgs, '--base-url', 'https://erp.example.test/new'], () => ({
        ...fakeConnector,
        check: async () => {
          throw new ErpError('auth');
        },
      }))
    ).code,
    1,
  );
  assert.equal((await read())!.baseUrl, 'https://erp.example.test/new');
  assert.equal((await invoke(['set', ...baseArgs, '--status', 'disabled', '--location', '20', '--uom', '件=1,箱=2'])).code, 0);
  assert.equal((await read())!.status, 'disabled');
  assert.equal((await invoke(['map', ...baseArgs, '--auto', '--dry-run'])).code, 0);
  assert.equal((await withTenant(db, ctx(tenant.id), (tx) => listErpItemLinks(tx, row.id))).length, 0);
  assert.equal((await invoke(['map', ...baseArgs, '--auto'])).code, 0);
  let links = await withTenant(db, ctx(tenant.id), (tx) => listErpItemLinks(tx, row.id));
  assert.deepEqual(
    links.map((l) => l.code),
    ['part-a'],
  );
  assert.equal((await invoke(['map', ...baseArgs, '--set', 'part-b=2'])).code, 0);
  assert.equal((await invoke(['map', ...baseArgs, '--auto'])).code, 0);
  links = await withTenant(db, ctx(tenant.id), (tx) => listErpItemLinks(tx, row.id));
  assert.equal(links.find((l) => l.code === 'part-b')!.source, 'manual');
  assert.equal((await invoke(['map', ...baseArgs, '--unset', 'part-b'])).code, 0);
  assert.equal((await invoke(['map', ...baseArgs, '--unset', 'part-b'])).code, 1);
  await query("update tenants set pack_id='travel' where id=$1", [tenant.id]);
  assert.equal((await invoke(['map', ...baseArgs, '--auto'])).code, 1);
  await query("update tenants set pack_id='industrial' where id=$1", [tenant.id]);
  for (const [name, value, mode] of [
    ['loose', { apiKey }, 0o644],
    ['extra', { apiKey, extra: 'bad' }, 0o600],
    ['empty', { apiKey: '' }, 0o600],
  ] as const) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, JSON.stringify(value), { mode });
    assert.equal((await invoke(['set-secrets', ...baseArgs, '--key-expires', '2099-02-01', '--secrets-file', file])).code, 1);
  }
  assert.equal((await invoke(['set-secrets', ...baseArgs, '--key-expires', '2099-02-01', '--secrets-file', credential])).code, 0);
  assert.equal((await read())!.settings.keyExpiresAt, '2099-02-01');
  assert.equal((await read())!.settings.lastCheck, undefined);
  process.env[CHANNEL_KEY_ENV] = rotatedEnv;
  assert.equal((await invoke(['rekey', ...baseArgs])).code, 0);
  row = (await read())!;
  assert.equal(
    openConnectorSecrets(newRing, { tenantId: tenant.id, connectorId: row.id }, row.secretsCt, row.secretsKeyId).reveal().apiKey,
    apiKey,
  );
  sensitive.push(row.secretsCt.toString('base64'), row.secretsCt.toString('hex'));
  process.env[CHANNEL_KEY_ENV] = ringEnv;
  assert.equal((await invoke(['rekey', ...baseArgs])).code, 2, '缺旧钥不改密文');
  assert.deepEqual((await read())!.secretsCt, row.secretsCt);
  process.env[CHANNEL_KEY_ENV] = rotatedEnv;
  lock = fakeLock();
  const lostLock = lock;
  assert.equal(
    (
      await invoke(['check', ...baseArgs], () => ({
        ...fakeConnector,
        check: async () => {
          lostLock.lose();
          return { companyCurrency: 'CNY', locationOk: true };
        },
      }))
    ).code,
    3,
  );
  assert.equal((await read())!.settings.lastCheck, undefined, '丢锁写入回滚');
  const audits = await query<{ action: keyof typeof AUDIT_ACTIONS; diff: { fields: string[] } }>(
    'select action,diff from audit_log where tenant_id=$1',
    [tenant.id],
  );
  for (const audit of audits) {
    assert.ok(AUDIT_ACTIONS[audit.action]);
    assert.deepEqual(Object.keys(audit.diff), ['fields']);
    clean(JSON.stringify(audit));
  }
  const auditCount = audits.length;
  await invoke(['map', ...baseArgs, '--auto', '--dry-run']);
  assert.equal((await query('select id from audit_log where tenant_id=$1', [tenant.id])).length, auditCount, 'dry-run 不写审计');
  console.log(
    `PASS ${label} CLI：七个命令、auth 写库/egress 不写、CNY/库位、dry-run、manual/unset、无 ERP 包、沙箱、严格凭据、丢锁回滚、字段名审计、rekey 前后解封`,
  );
}

function subprocess(args: string[], extra: NodeJS.ProcessEnv = {}, entry = 'src/cli/erp-connector.ts') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: { ...process.env, DATABASE_URL: '', CONFIG_SOURCE: 'db', SESSION_STORE: 'db', [CHANNEL_KEY_ENV]: rotatedEnv, ...extra },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  clean(output);
  return { code: result.status, output };
}
async function subprocessSuite() {
  for (const url of [
    'http://erp.example.test',
    'https://user:pass@erp.example.test',
    'https://erp.example.test:22',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://169.254.169.254',
    'https://100.100.100.200',
    'https://2130706433',
    'https://[::1]',
    'https://[::ffff:a00:1]',
    'https://[64:ff9b::a00:1]',
  ]) {
    const args = [...addArgs];
    args[args.indexOf('--base-url') + 1] = url;
    const result = subprocess(args);
    assert.equal(result.code, 1);
    assert.match(result.output, /scheme|userinfo|port|blocked_address/);
    assert.ok(!result.output.includes(url));
    const set = subprocess(['set', ...baseArgs, '--base-url', url]);
    assert.equal(set.code, 1);
    assert.match(set.output, /scheme|userinfo|port|blocked_address/);
  }
  for (const command of ['add-odoo', 'set-secrets']) {
    const args =
      command === 'add-odoo' ? [...addArgs] : [command, ...baseArgs, '--key-expires', '2099-01-01', '--secrets-file', credential];
    const index = args.indexOf('--key-expires');
    const missing = [...args];
    missing.splice(index, 2);
    assert.match(subprocess(missing).output, /缺少 --key-expires/);
    for (const date of ['2000-01-01', new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), '2099-02-30', 'bad']) {
      const invalid = [...args];
      invalid[index + 1] = date;
      assert.match(subprocess(invalid).output, /key-expires 须为/);
    }
  }
  assert.match(subprocess(['show', ...baseArgs], { SESSION_STORE: 'file' }).output, /db_storage_required/);
  assert.match(subprocess(['show', ...baseArgs], { CONFIG_SOURCE: 'file' }).output, /db_storage_required/);
  assert.match(subprocess(['set-secrets', ...baseArgs, '--api-key', apiKey]).output, /参数无效/);
  for (const args of [['--auto', '--set', 'part-a=1'], ['--dry-run'], ['--unset', ''], ['--set', 'part-a=0']])
    assert.equal(subprocess(['map', ...baseArgs, ...args]).code, 1);
  console.log('PASS 子进程：add/set 地址拒绝全表、缺失/今天/过期/非法日期、文件存储、严格参数；输出无地址/key/库名/密文 base64/hex');
}

async function persistedSubprocessSuite() {
  const disk = path.join(directory, 'db');
  const test = await openTestDb({ dataDir: disk });
  try {
    await test.pg.query("insert into tenants(slug,name,pack_id) values ('erp-cli','合成租户','industrial')");
    await test.pg.query(
      "insert into tenants(slug,name,pack_id,kind,template_tenant_id,expires_at) select 'erp-sandbox','合成沙箱','industrial','sandbox',id,now()+interval '1 day' from tenants where slug='erp-cli'",
    );
    await test.pg.exec('SET ROLE agent_app');
    const log = console.log;
    console.log = () => {};
    process.env[CHANNEL_KEY_ENV] = ringEnv;
    try {
      assert.equal(
        await runErpConnector(addArgs, {
          connect: async () => ({ db: test.db, close: async () => {}, lock: async () => fakeLock() }),
          connector: () => fakeConnector,
        }),
        0,
      );
    } finally {
      console.log = log;
    }
  } finally {
    await test.close();
  }
  const snapshot = path.join(directory, 'snapshot.json');
  const bridge = path.join(directory, 'bridge.mts');
  fs.writeFileSync(
    bridge,
    `
import fs from 'node:fs';
const {runErpConnector} = await import(${JSON.stringify(pathToFileURL(path.resolve('src/cli/erp-connector.ts')).href)});
const {openTestDb,fakeLock} = await import(${JSON.stringify(pathToFileURL(path.resolve('src/db/testing.ts')).href)});
const t = await openTestDb({dataDir:process.env.ERP_CLI_DISK});
try {
await t.pg.exec('SET ROLE agent_app');
const code = await runErpConnector(process.argv.slice(2), {connect:async()=>({db:t.db,close:async()=>{},lock:async()=>fakeLock()})});
await t.pg.exec('RESET ROLE');
fs.writeFileSync(process.env.ERP_CLI_SNAPSHOT, JSON.stringify((await t.pg.query("select tenant_id,id,encode(secrets_ct,'hex') as secrets_ct,secrets_key_id,settings from erp_connectors")).rows));
await t.close(); process.exit(code);
} catch {await t.close(); process.exit(90);}
`,
  );
  const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    subprocess(args, { ERP_CLI_DISK: disk, ERP_CLI_SNAPSHOT: snapshot, ...extra }, bridge);
  const rows = () =>
    JSON.parse(fs.readFileSync(snapshot, 'utf8')) as {
      tenant_id: string;
      id: string;
      secrets_ct: string;
      secrets_key_id: string;
    }[];
  assert.equal(invoke(['show', ...baseArgs]).code, 0);
  const before = rows()[0];
  const ctBefore = Buffer.from(before.secrets_ct, 'hex');
  assert.equal(
    openConnectorSecrets(oldRing, { tenantId: before.tenant_id, connectorId: before.id }, ctBefore, before.secrets_key_id).reveal().apiKey,
    apiKey,
  );
  sensitive.push(ctBefore.toString('base64'), ctBefore.toString('hex'));
  assert.match(invoke(['show', ...baseArgs]).output, /mappings.*keyExpiresAt.*lastCheck/);
  assert.match(invoke(['show', '--tenant', 'erp-sandbox']).output, /standard_tenant_required/);
  assert.equal(invoke(['rekey', ...baseArgs]).code, 0);
  const after = rows()[0];
  const ctAfter = Buffer.from(after.secrets_ct, 'hex');
  sensitive.push(ctAfter.toString('base64'), ctAfter.toString('hex'));
  assert.equal(
    openConnectorSecrets(newRing, { tenantId: after.tenant_id, connectorId: after.id }, ctAfter, after.secrets_key_id).reveal().apiKey,
    apiKey,
  );
  assert.equal(invoke(['show', ...baseArgs]).code, 0);
  assert.equal(invoke(['set', ...baseArgs, '--status', 'disabled']).code, 0);
  assert.equal(invoke(['check', ...baseArgs]).code, 1); // 严格出站，合成域名不可达。
  assert.equal(invoke(addArgs).code, 2);
  const link = path.join(directory, 'symlink');
  fs.symlinkSync(credential, link);
  for (const file of [link, directory])
    assert.equal(invoke(['set-secrets', ...baseArgs, '--key-expires', '2099-01-01', '--secrets-file', file]).code, 1);
  assert.equal(invoke(['rekey', ...baseArgs], { [CHANNEL_KEY_ENV]: ringEnv }).code, 2);
  console.log('PASS 持久化子进程：show/set/check/重复添加/沙箱/符号链接与目录拒绝、轮换前后解封、成功失败输出脱敏');
}

const saved = { ring: process.env[CHANNEL_KEY_ENV], config: process.env.CONFIG_SOURCE, store: process.env.SESSION_STORE };
try {
  process.env.CONFIG_SOURCE = 'db';
  process.env.SESSION_STORE = 'db';
  process.env[CHANNEL_KEY_ENV] = ringEnv;
  await mappingSuite();
  assert.equal(
    await checkErpConnector({
      ...fakeConnector,
      check: async () => {
        throw new Error(apiKey);
      },
    }),
    'bad_response',
  );
  const test = await openTestDb();
  try {
    // app 权限执行 CLI，超级用户仅用于构造合成夹具和读取审计。
    const query: Query = async <T>(text: string, args: unknown[] = []) => {
      await test.pg.exec('RESET ROLE');
      try {
        return (await test.pg.query<T>(text, args)).rows;
      } finally {
        await test.pg.exec('SET ROLE agent_app');
      }
    };
    await test.pg.exec('SET ROLE agent_app');
    await databaseSuite(test.db, query, 'PGlite');
  } finally {
    await test.close();
  }
  if (process.env.PG_TEST_URL) {
    const fx = await createRealPgFixture(process.env.PG_TEST_URL);
    let app: Awaited<ReturnType<typeof openDb>> | undefined;
    process.env[CHANNEL_KEY_ENV] = ringEnv;
    try {
      app = await openDb(fx.urls.app);
      await databaseSuite(app.db, fx.query, 'PG');
    } finally {
      await app?.close();
      await fx.drop();
    }
  } else if (process.env.CI === 'true') throw new Error('CI 必须提供 PG_TEST_URL');
  else console.log('未设 PG_TEST_URL：真实 PG 待补跑');
  await subprocessSuite();
  await persistedSubprocessSuite();
  console.log('ERP CLI SELFTEST PASS');
} finally {
  for (const [key, value] of [
    [CHANNEL_KEY_ENV, saved.ring],
    ['CONFIG_SOURCE', saved.config],
    ['SESSION_STORE', saved.store],
  ])
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  fs.rmSync(directory, { recursive: true, force: true });
}
