// 11 第 2 步：凭据兼容、域隔离、存储契约；同一组数据库断言跑 PGlite 与真实 PG。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { createDecipheriv, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { format, inspect } from 'node:util';
import { sql } from 'drizzle-orm';
import { ChannelSecretError, openJson, openSecrets, sealJson, sealSecrets, type KeyRing } from '../channels/secrets.js';
import { openConnectorSecrets, sealConnectorSecrets } from '../connectors/secrets.js';
import { openDb, pgErrorOf, rowsOf, withTenant, type Db, type Tx } from './client.js';
import { createRealPgFixture, openTestDb } from './testing.js';
import {
  deleteErpItemLink,
  insertErpConnector,
  listErpConnectors,
  listErpItemLinks,
  readErpConnector,
  readErpItemLink,
  updateErpConnector,
  upsertErpItemLink,
  type ErpItemLink,
  type NewErpConnector,
} from './repo/erp.js';

const key = Buffer.alloc(32, 0x11); // 明显合成的测试密钥，无对应服务。
const ring: KeyRing = { current: { id: 'synthetic', key }, all: new Map([['synthetic', key]]) };
const binding = { tenantId: 'synthetic-tenant', connectorId: 'synthetic-row' };
const channelBinding = { tenantId: binding.tenantId, accountId: binding.connectorId };
const channelValue = { appSecret: 'fake-app', callbackToken: 'fake-token', callbackAesKey: 'fake-aes' };
const value = { apiKey: 'fake-erp-credential' };

function cryptoSuite() {
  // 在 origin/dev 的 sealSecrets 上，以本文件的合成密钥与 channelBinding 生成；固定夹具保护旧密文格式。 gitleaks:allow
  const fixture = Buffer.from(
    'j69s/W/1/O4Q5FRfajxLDMfyWFcf0hhgiIVtt1DjHoAdpwiJ1ru00GAjGsS8IUMMkXyqReTxLGcTlB9XxyriAvODxva51kTgfsf7vgZP4IX1Dym30JF3BxHLBWQQ3sQCZLUfF3DWqEO+KfSObA==',
    'base64',
  );
  assert.deepEqual(openSecrets(ring, channelBinding, fixture, 'synthetic').reveal(), channelValue);
  const channel = sealSecrets(ring, channelBinding, channelValue);
  // 原渠道解封算法独立保留：AAD、nonce/tag 位置、JSON 字节序都与抽取之前一致。
  const decipher = createDecipheriv('aes-256-gcm', key, channel.ct.subarray(0, 12));
  decipher.setAAD(Buffer.from(`channel_accounts:v1:${channelBinding.tenantId}:${channelBinding.accountId}`, 'utf8'));
  decipher.setAuthTag(channel.ct.subarray(-16));
  assert.equal(
    Buffer.concat([decipher.update(channel.ct.subarray(12, -16)), decipher.final()]).toString('utf8'),
    JSON.stringify(channelValue),
  );
  const sealed = sealConnectorSecrets(ring, binding, value);
  const opened = openConnectorSecrets(ring, binding, sealed.ct, sealed.keyId);
  assert.deepEqual(opened.reveal(), value);
  assert.equal(sealed.ct.length, 12 + Buffer.byteLength(JSON.stringify(value)) + 16);
  assert.notDeepEqual(sealConnectorSecrets(ring, binding, value).ct.subarray(0, 12), sealed.ct.subarray(0, 12));
  for (const run of [
    () => openConnectorSecrets(ring, binding, channel.ct, channel.keyId),
    () => openSecrets(ring, channelBinding, sealed.ct, sealed.keyId),
    () => openConnectorSecrets(ring, { ...binding, tenantId: 'other-tenant' }, sealed.ct, sealed.keyId),
    () => openConnectorSecrets(ring, { ...binding, connectorId: 'other-row' }, sealed.ct, sealed.keyId),
  ])
    assert.throws(run, ChannelSecretError);
  for (const output of [
    inspect(opened),
    inspect({ deep: [opened] }),
    JSON.stringify(opened),
    `${opened}`,
    format('%s', opened),
    format('%o', opened),
  ]) {
    assert.ok(output.includes('[已遮盖]'));
    assert.ok(!output.includes(value.apiKey));
  }
  const changed = Buffer.from(sealed.ct);
  changed[12] ^= 1;
  assert.throws(() => openConnectorSecrets(ring, binding, changed, sealed.keyId), /认证失败/);
  assert.throws(() => openConnectorSecrets(ring, binding, Buffer.alloc(27), sealed.keyId), /密文长度不足/);
  assert.throws(() => openConnectorSecrets(ring, binding, sealed.ct, 'missing'), /密钥不存在/);
  for (const bad of [null, {}, { apiKey: 3 }, { apiKey: '' }, channelValue]) {
    const encrypted = sealJson(ring, 'erp_connectors:v1', { tenantId: binding.tenantId, id: binding.connectorId }, bad);
    assert.throws(() => openConnectorSecrets(ring, binding, encrypted.ct, encrypted.keyId), /凭据字段无效/);
  }
  assert.throws(
    () =>
      openJson(ring, 'erp_connectors:v1', { tenantId: binding.tenantId, id: binding.connectorId }, sealed.ct, sealed.keyId, () => {
        throw new Error(value.apiKey);
      }),
    (e) => e instanceof ChannelSecretError && !inspect(e).includes(value.apiKey),
  );
  const nextKey = Buffer.alloc(32, 0x22);
  const rotated: KeyRing = { current: { id: 'next', key: nextKey }, all: new Map([...ring.all, ['next', nextKey]]) };
  const rekeyed = sealConnectorSecrets(rotated, binding, openConnectorSecrets(rotated, binding, sealed.ct, sealed.keyId).reveal());
  assert.deepEqual(
    openConnectorSecrets({ current: rotated.current, all: new Map([['next', nextKey]]) }, binding, rekeyed.ct, rekeyed.keyId).reveal(),
    value,
  );
  console.log('ERP crypto: origin/dev 固定密文、新密文旧算法解封、双向域隔离、换租户/行、轮换、Redacted、错误不泄露 PASS');
}

type Query = <T = Record<string, unknown>>(text: string, args?: unknown[]) => Promise<T[]>;
type Role = 'agent_app' | 'agent_platform' | 'agent_owner';
type AsRole = <T>(role: Role, run: (db: Db) => Promise<T>) => Promise<T>;
const ctx = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
async function denied(run: () => Promise<unknown>, code = '42501') {
  await assert.rejects(run, (e) => pgErrorOf(e).code === code);
}
const newConnector = (tenantId: string): NewErpConnector => {
  const id = randomUUID();
  const sealed = sealConnectorSecrets(ring, { tenantId, connectorId: id }, value);
  return {
    id,
    kind: 'odoo',
    baseUrl: 'https://erp.example.test',
    database: null,
    settings: { locationId: 1, uom: { 件: 1 }, keyExpiresAt: '2030-01-01' },
    secretsCt: sealed.ct,
    secretsKeyId: sealed.keyId,
  };
};

async function databaseSuite(q: Query, as: AsRole, label: string) {
  const tenant = async (slug: string) =>
    (await q<{ id: string }>("insert into tenants (slug,name,pack_id) values ($1,$1,'travel') returning id", [slug]))[0]!.id;
  const a = await tenant('erp-a');
  const b = await tenant('erp-b');
  const tx = <T>(tenantId: string, run: (tx: Tx) => Promise<T>, role: Role = 'agent_app') =>
    as(role, (db) => withTenant(db, ctx(tenantId), run));
  const input = newConnector(a);
  const row = await tx(a, (t) => insertErpConnector(t, input));
  const other = await tx(b, (t) => insertErpConnector(t, newConnector(b)));
  assert.equal(row.status, 'active');
  assert.equal(row.database, null);
  assert.deepEqual(row.settings, input.settings);
  assert.deepEqual(openConnectorSecrets(ring, { tenantId: a, connectorId: row.id }, row.secretsCt, row.secretsKeyId).reveal(), value);
  assert.equal((await tx(b, listErpConnectors)).length, 1);
  assert.equal((await tx(b, readErpConnector))!.id, other.id);
  assert.equal(await tx(b, (t) => updateErpConnector(t, row.id, { status: 'disabled' })), false);
  assert.equal(await tx(a, (t) => updateErpConnector(t, row.id, {})), false);
  assert.equal(await tx(a, (t) => updateErpConnector(t, row.id, { status: undefined })), false);
  const replacement = sealConnectorSecrets(ring, { tenantId: a, connectorId: row.id }, { apiKey: 'fake-replacement' });
  await tx(a, (t) =>
    updateErpConnector(t, row.id, {
      status: 'disabled',
      baseUrl: 'https://erp.example.test/odoo',
      database: 'synthetic.db-1',
      settings: { ...row.settings, locationId: 2 },
      secretsCt: replacement.ct,
      secretsKeyId: replacement.keyId,
    }),
  );
  const updated = (await tx(a, readErpConnector))!;
  assert.equal(updated.status, 'disabled');
  assert.equal(updated.baseUrl, 'https://erp.example.test/odoo');
  assert.equal(updated.database, 'synthetic.db-1');
  assert.equal(updated.settings.locationId, 2);
  assert.ok(updated.updatedAt > row.updatedAt);
  assert.deepEqual(openConnectorSecrets(ring, { tenantId: a, connectorId: row.id }, updated.secretsCt, updated.secretsKeyId).reveal(), {
    apiKey: 'fake-replacement',
  });
  await tx(a, (t) => updateErpConnector(t, row.id, { database: null }));
  assert.equal((await tx(a, readErpConnector))!.database, null);
  await denied(() => tx(a, (t) => insertErpConnector(t, newConnector(a))), '23505');
  for (const patch of [
    sql`kind='other'`,
    sql`status='other'`,
    sql`database=''`,
    sql`database='bad name'`,
    sql`database=${'a'.repeat(64)}`,
  ]) {
    await denied(() => tx(a, (t) => t.execute(sql`update erp_connectors set ${patch}`), 'agent_owner'), '23514');
  }
  await denied(() =>
    tx(a, (t) =>
      t.execute(
        sql`insert into erp_connectors (tenant_id,kind,base_url,settings,secrets_ct,secrets_key_id) values (${b},'odoo','https://erp.example.test','{}','x','synthetic')`,
      ),
    ),
  );

  const link: ErpItemLink = {
    connectorId: row.id,
    kind: 'part',
    code: 'synthetic-part',
    remoteId: 1,
    remoteCode: 'SYN-1',
    remoteUomId: 1,
    source: 'auto',
    checkedAt: new Date('2026-10-29T00:00:00Z'),
  };
  await tx(a, (t) => upsertErpItemLink(t, link));
  assert.deepEqual(await tx(a, (t) => readErpItemLink(t, row.id, link.kind, link.code)), link);
  await tx(a, (t) =>
    upsertErpItemLink(t, {
      ...link,
      remoteId: 2,
      remoteCode: 'SYN-2',
      remoteUomId: 2,
      source: 'manual',
      checkedAt: new Date('2026-10-30T00:00:00Z'),
    }),
  );
  const links = await tx(a, (t) => listErpItemLinks(t, row.id));
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], {
    ...link,
    remoteId: 2,
    remoteCode: 'SYN-2',
    remoteUomId: 2,
    source: 'manual',
    checkedAt: new Date('2026-10-30T00:00:00Z'),
  });
  assert.deepEqual(await tx(b, (t) => listErpItemLinks(t, row.id)), []);
  assert.equal(await tx(b, (t) => readErpItemLink(t, row.id, link.kind, link.code)), null);
  assert.equal(await tx(b, (t) => deleteErpItemLink(t, row.id, link.kind, link.code)), false);
  await denied(() => tx(b, (t) => upsertErpItemLink(t, link)), '23503');
  for (const patch of [sql`remote_id=0`, sql`remote_id=-1`, sql`remote_uom_id=0`, sql`remote_uom_id=-1`, sql`source='other'`]) {
    await denied(() => tx(a, (t) => t.execute(sql`update erp_item_links set ${patch}`)), '23514');
  }
  await denied(() => q('delete from erp_connectors where id=$1', [row.id]), '23503');
  await denied(() => tx(a, (t) => t.execute(sql`delete from erp_connectors`)));
  for (const column of ['tenant_id', 'id', 'kind', 'created_at']) {
    await denied(() => tx(a, (t) => t.execute(sql`update erp_connectors set ${sql.identifier(column)}=${sql.identifier(column)}`)));
  }

  // 与系统目录逐列比对，额外权限（含表级 UPDATE、DELETE / TRUNCATE）也会被拦。
  const mutable = ['status', 'base_url', 'database', 'settings', 'secrets_ct', 'secrets_key_id', 'updated_at'];
  for (const table of ['erp_connectors', 'erp_item_links']) {
    const [security] = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(
      'select relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) as owner from pg_class where oid=$1::regclass',
      [table],
    );
    assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true, owner: 'agent_owner' });
    const columns = await q<{ name: string; s: boolean; i: boolean; u: boolean; p: boolean }>(
      `select attname as name,has_column_privilege('agent_app',attrelid,attname,'SELECT') as s,
       has_column_privilege('agent_app',attrelid,attname,'INSERT') as i,has_column_privilege('agent_app',attrelid,attname,'UPDATE') as u,
       has_column_privilege('agent_platform',attrelid,attname,'SELECT,INSERT,UPDATE,REFERENCES') as p
       from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped`,
      [table],
    );
    for (const column of columns)
      assert.deepEqual(column, {
        name: column.name,
        s: true,
        i: true,
        u: table === 'erp_item_links' || mutable.includes(column.name),
        p: false,
      });
    for (const role of ['agent_app', 'agent_platform']) {
      const granted = (
        await q<{ p: string }>(
          "select p from unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege($1,$2,p)",
          [role, table],
        )
      ).map((r) => r.p);
      assert.deepEqual(
        granted,
        role === 'agent_platform' ? [] : table === 'erp_connectors' ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      );
    }
    for (const role of ['agent_app', 'agent_owner'] as const) {
      const unscoped = await as(role, async (db) =>
        rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`)),
      );
      assert.equal(unscoped[0]!.n, 0);
    }
    await denied(() => tx(a, (t) => t.execute(sql`select * from ${sql.identifier(table)}`), 'agent_platform'));
  }
  await denied(() =>
    as('agent_app', (db) =>
      db.execute(
        sql`insert into erp_item_links (tenant_id,connector_id,kind,code,remote_id,remote_code,remote_uom_id,source,checked_at) values (${a},${row.id},'part','no-tenant',1,'SYN',1,'auto',now())`,
      ),
    ),
  );
  assert.equal(await tx(a, (t) => deleteErpItemLink(t, row.id, link.kind, link.code)), true);
  assert.equal(await tx(a, (t) => deleteErpItemLink(t, row.id, link.kind, link.code)), false);
  assert.deepEqual(await tx(a, (t) => listErpItemLinks(t, row.id)), []);
  console.log(`${label}: FORCE RLS（含属主）、跨租户复合外键、CHECK、唯一键、repo 往返/upsert、列级 UPDATE、连接器禁删/映射可删 PASS`);

  const sandbox = (
    await q<{ id: string }>(
      "insert into tenants (slug,name,pack_id,kind,expires_at,template_tenant_id) values ('erp-sandbox','合成沙箱','travel','sandbox',now()-interval '1 day',$1) returning id",
      [a],
    )
  )[0]!.id;
  const sbxConnector = await tx(sandbox, (t) => insertErpConnector(t, newConnector(sandbox)));
  await tx(sandbox, (t) => upsertErpItemLink(t, { ...link, connectorId: sbxConnector.id }));
  const counts = await tx(
    sandbox,
    async (t) =>
      rowsOf<{ counts: Record<string, number> }>(await t.execute(sql`select sandbox_tenant_purge(${sandbox}::uuid) as counts`))[0]!.counts,
  );
  assert.equal(counts.erp_item_links, 1);
  assert.equal(counts.erp_connectors, 1);
  assert.equal((await q('select id from tenants where id=$1', [sandbox])).length, 0);
  assert.equal((await tx(a, readErpConnector))!.id, row.id);
  console.log(`${label}: 带映射的沙箱先删链接再删连接器、计数、保留其他租户 PASS`);
}

// R11：剔除两个表的删除与核对片段，新函数其余字节必须与 0021 完全相同。
function purgeCompatibility() {
  const body = (p: string) =>
    fs.readFileSync(p, 'utf8').split('CREATE OR REPLACE FUNCTION sandbox_tenant_purge')[1]!.split('--> statement-breakpoint')[0]!.trim();
  let actual = body('drizzle/0022_erp_connectors.sql');
  for (const table of ['erp_item_links', 'erp_connectors']) {
    actual = actual.replace(
      `  DELETE FROM public.${table} WHERE tenant_id = p_tenant;\n  GET DIAGNOSTICS v_n = ROW_COUNT;\n  v_counts := v_counts || jsonb_build_object('${table}', v_n);\n`,
      '',
    );
    actual = actual.replace(
      `  SELECT count(*) INTO v_n FROM public.${table} WHERE tenant_id = p_tenant;\n  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 ${table}' USING ERRCODE = 'check_violation'; END IF;\n`,
      '',
    );
  }
  assert.equal(actual, body('drizzle/0021_attachments.sql'));
  console.log('ERP migration: sandbox_tenant_purge 其余字节与 0021 相同 PASS');
}

cryptoSuite();
purgeCompatibility();
const test = await openTestDb();
try {
  await test.migrate();
  const q: Query = async <T>(text: string, args: unknown[] = []) => (await test.pg.query<T>(text, args)).rows;
  await databaseSuite(
    q,
    async (role, run) => {
      await test.pg.exec(`SET ROLE ${role}`);
      try {
        return await run(test.db);
      } finally {
        await test.pg.exec('RESET ROLE');
      }
    },
    'PGlite',
  );
} finally {
  await test.close();
}
if (process.env.PG_TEST_URL) {
  const fx = await createRealPgFixture(process.env.PG_TEST_URL);
  const app = await openDb(fx.urls.app);
  const platform = await openDb(fx.urls.platform);
  const owner = await openDb(fx.urls.owner);
  try {
    await databaseSuite(fx.query, (role, run) => run({ agent_app: app, agent_platform: platform, agent_owner: owner }[role].db), 'PG');
  } finally {
    await app.close();
    await platform.close();
    await owner.close();
    await fx.drop();
  }
} else if (process.env.CI === 'true') throw new Error('CI 必须提供 PG_TEST_URL');
else console.log('未设 PG_TEST_URL：真实 PG 待补跑');
console.log('ERP SELFTEST PASS');
