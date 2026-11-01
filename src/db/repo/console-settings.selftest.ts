// 15 验收 3/4：repo 白名单、租户 RLS 与消息证据；真实 PG 的认证/权限另由 settings API 与 console-members 覆盖。
import '../../selftest-env.js';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { openTestDb } from '../testing.js';
import { withTenant } from '../client.js';
import { readConsoleChannels, readConsoleInbound, readConsoleMembers, readConsoleOrganization } from './console-settings.js';
const t = await openTestDb();
try {
  const a = randomUUID(),
    b = randomUUID();
  await t.pg.query(
    "insert into tenants(id,slug,name,pack_id) values ($1,'settings-repo-a','合成甲','travel'),($2,'settings-repo-b','合成乙','travel')",
    [a, b],
  );
  for (const id of [a, b]) {
    await t.pg.query("insert into channel_accounts(tenant_id,key,name,kind,status) values ($1,'web-main','合成网页','web','active')", [id]);
    await t.pg.query(
      `insert into conversations(tenant_id,id,channel,stage,handed_over,state,created_at,updated_at,last_seq)
      values ($1,'wecom:wmProof','wecom','discovery',false,'{"id":"wecom:wmProof"}',now(),now(),1)`,
      [id],
    );
    await t.pg.query(
      "insert into messages(tenant_id,conversation_id,seq,role,content,at) values ($1,'wecom:wmProof',1,'customer','合成消息',now())",
      [id],
    );
  }
  await t.pg.exec('SET ROLE agent_app');
  for (const statement of [sql`select * from users`, sql`select * from memberships`, sql`select * from auth_sessions`])
    await assert.rejects(t.db.execute(statement));
  await withTenant(
    t.db,
    { tenantId: a, actor: { kind: 'system', userId: null, name: null, ip: null } },
    async (tx) => {
      assert.deepEqual(await readConsoleMembers(tx, 'bad-hash'), []);
      assert.equal((await readConsoleOrganization(tx)).view.name, '合成甲');
      const channels = await readConsoleChannels(tx);
      assert.equal(channels.length, 1);
      assert.deepEqual(
        Object.keys(channels[0]!).sort(),
        [
          'accountId',
          'key',
          'name',
          'kind',
          'source',
          'enabled',
          'loaded',
          'blockedByProfile',
          'credentialsConfigured',
          'callbackPath',
          'lastInboundAt',
        ].sort(),
      );
      assert.equal(channels[0]!.credentialsConfigured, false);
      const inbound = await readConsoleInbound(tx);
      assert.equal(inbound.size, 1);
      assert.ok(inbound.get(null));
    },
    { readOnly: true },
  );
  console.log('15 验收 3/4 PASS: repo tenant projection, channels whitelist, persisted customer inbound, invalid session');
} finally {
  await t.close();
}
