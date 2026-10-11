// 05 第 4 步：命令、列级权限与原子审计；有 PG_TEST_URL 时以真实登录角色重跑。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../db/client.js';
import { createRealPgFixture, openTestDb } from '../db/testing.js';
import { runTenantHost } from './tenant-host.js';
import { runTenantBudget } from './tenant-budget.js';

type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
type Connect = () => Promise<{ db: Db; close(): Promise<void> }>;
let passed = 0;
function check(fn: () => void): void {
  fn();
  passed++;
}

async function suite(q: Query, connect: Connect, asApp: Connect): Promise<void> {
  const [tenant] = await q<{ id: string }>("insert into tenants (slug,name,pack_id) values ('settings-a','测试','travel') returning id");
  const id = tenant!.id;
  await q("insert into tenants (slug,name,pack_id) values ('settings-b','测试','travel')");
  await q(
    "insert into tenants (slug,name,pack_id,kind,expires_at,template_tenant_id) values ('sbx-settings','测试','travel','sandbox',now()+interval '1 day',$1)",
    [id],
  );
  const [original] = await q('select * from tenants where id=$1', [id]);
  const logs: string[] = [];
  const savedLog = console.log;
  const savedError = console.error;
  console.log = console.error = (...args: unknown[]) => logs.push(args.join(' '));
  let closed = 0;
  const deps = {
    connect: async () => {
      const c = await connect();
      return {
        db: c.db,
        close: async () => {
          closed++;
          await c.close();
        },
      };
    },
  };
  const expectCode = async (result: Promise<number>, expected: number): Promise<void> => {
    assert.equal(await result, expected);
    passed++;
  };
  const host = (args: string[]) => runTenantHost(args, deps);
  const budget = (args: string[]) => runTenantBudget(args, deps);
  const state = async () =>
    (
      await q<{ public_host: string | null; llm_daily_alert_milli: string | number | null }>(
        'select public_host,llm_daily_alert_milli from tenants where id=$1',
        [id],
      )
    )[0]!;
  const audit = () =>
    q<{ action: string; actor_kind: string; actor_name: string; target_type: string; target_id: string; diff: unknown }>(
      'select action,actor_kind,actor_name,target_type,target_id,diff from audit_log where tenant_id=$1 order by id',
      [id],
    );
  try {
    let invalidConnections = 0;
    const noConnect = {
      connect: async (): Promise<never> => {
        invalidConnections++;
        throw new Error('不应连接数据库');
      },
    };
    for (const args of [
      [],
      ['remove'],
      ['set'],
      ['set', '--tenant', 'settings-a'],
      ['set', '--tenant', 'settings-a', '--host', 'https://invalid'],
      ['clear', '--tenant', 'settings-a', '--host', 'example.invalid'],
      ['clear', '--tenant', 'settings-a', '--unknown'],
      ['set', '--tenant', 'settings-a', '--host', 'example.invalid', 'extra'],
    ])
      await expectCode(runTenantHost(args, noConnect), 1);
    for (const raw of ['', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 1', '9007199254740992']) {
      await expectCode(runTenantBudget(['set', '--tenant', 'settings-a', '--milli', raw], noConnect), 1);
    }
    for (const args of [
      [],
      ['remove'],
      ['set', '--tenant', 'settings-a'],
      ['clear', '--tenant', 'settings-a', '--milli', '0'],
      ['clear', '--unknown'],
    ]) {
      await expectCode(runTenantBudget(args, noConnect), 1);
    }
    check(() => assert.equal(invalidConnections, 0));
    await expectCode(host(['set', '--tenant', 'settings-a', '--host', 'Example.Invalid.:443']), 0);
    check(() => assert.equal((logs.at(-1) ?? '').includes('下次启动生效'), true));
    check(() => assert.equal(logs.join('\n').includes('Example.Invalid'), false));
    const hostState = await state();
    check(() => assert.equal(hostState.public_host, 'example.invalid'));
    await expectCode(budget(['set', '--tenant', 'settings-a', '--milli', '1000']), 0);
    const budgetState = await state();
    check(() => assert.equal(Number(budgetState.llm_daily_alert_milli), 1000));
    await expectCode(budget(['set', '--tenant', 'settings-a', '--milli', '0']), 0);
    const zeroState = await state();
    check(() => assert.equal(Number(zeroState.llm_daily_alert_milli), 0));
    await expectCode(host(['set', '--tenant', 'settings-b', '--host', 'EXAMPLE.INVALID:80']), 1);
    await expectCode(host(['set', '--tenant', 'missing', '--host', 'unused.invalid']), 1);
    await expectCode(budget(['clear', '--tenant', 'missing']), 1);
    for (const slug of ['sbx-settings']) {
      await expectCode(host(['set', '--tenant', slug, '--host', 'unused.invalid']), 1);
      await expectCode(budget(['set', '--tenant', slug, '--milli', '1']), 1);
      await expectCode(host(['clear', '--tenant', slug]), 1);
      await expectCode(budget(['clear', '--tenant', slug]), 1);
    }
    // agent_app 没有修改这些列的途径，命令失败也不能写审计。
    await expectCode(runTenantHost(['set', '--tenant', 'settings-a', '--host', 'denied.invalid'], { connect: asApp }), 1);
    await expectCode(runTenantBudget(['set', '--tenant', 'settings-a', '--milli', '9'], { connect: asApp }), 1);
    const beforeFailure = await state();
    const beforeAudit = await audit();
    await q('revoke insert on audit_log from agent_platform');
    try {
      await expectCode(host(['set', '--tenant', 'settings-a', '--host', 'rollback.invalid']), 1);
      await expectCode(budget(['set', '--tenant', 'settings-a', '--milli', '99']), 1);
    } finally {
      await q('grant insert on audit_log to agent_platform');
    }
    const afterFailure = await state();
    check(() => assert.deepEqual(afterFailure, beforeFailure));
    const afterAuditFailure = await audit();
    check(() => assert.deepEqual(afterAuditFailure, beforeAudit));
    await expectCode(host(['clear', '--tenant', 'settings-a']), 0);
    await expectCode(budget(['clear', '--tenant', 'settings-a']), 0);
    const cleared = await state();
    check(() => assert.deepEqual(cleared, { public_host: null, llm_daily_alert_milli: null }));
    // clear 后释放唯一 Host，其他列保持原值。
    await expectCode(host(['set', '--tenant', 'settings-b', '--host', 'example.invalid']), 0);
    const [after] = await q('select * from tenants where id=$1', [id]);
    check(() => assert.deepEqual(after, original));
    const rows = await audit();
    check(() =>
      assert.deepEqual(
        rows.map((r) => r.action),
        ['tenant.host_set', 'tenant.budget_set', 'tenant.budget_set', 'tenant.host_clear', 'tenant.budget_clear'],
      ),
    );
    for (const r of rows) {
      const name = r.action.startsWith('tenant.host_') ? 'tenant-host' : 'tenant-budget';
      check(() =>
        assert.deepEqual(r, {
          action: r.action,
          actor_kind: 'platform',
          actor_name: name,
          target_type: 'tenant',
          target_id: id,
          diff: { fields: [name === 'tenant-host' ? 'public_host' : 'llm_daily_alert_milli'] },
        }),
      );
    }
    const otherAudit = await q("select 1 from audit_log where tenant_id <> $1 and action like 'tenant.%'", [id]);
    check(() => assert.equal(otherAudit.length, 1));
    check(() => assert.equal(closed, 15));
    // CHECK 独立兜底沙箱 set；命令提前拒绝，不靠角色权限绕过约束。
    for (const patch of ["public_host='sandbox.invalid'", 'llm_daily_alert_milli=0']) {
      await assert.rejects(() => q(`update tenants set ${patch} where slug='sbx-settings'`), { code: '23514' });
      passed++;
    }
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }
}

const t = await openTestDb();
try {
  const q: Query = async <T>(text: string, params: unknown[] = []) => {
    await t.pg.exec('RESET ROLE');
    return (await t.pg.query<T>(text, params)).rows;
  };
  const asRole =
    (role: string): Connect =>
    async () => {
      await t.pg.exec(`SET ROLE ${role}`);
      return {
        db: t.db,
        close: async () => {
          await t.pg.exec('RESET ROLE');
        },
      };
    };
  await suite(q, asRole('agent_platform'), asRole('agent_app'));
} finally {
  await t.close();
}
if (process.env.PG_TEST_URL) {
  const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'settings-fixture' });
  try {
    await suite(
      fx.query,
      () => openDb(fx.urls.platform),
      () => openDb(fx.urls.app),
    );
  } finally {
    await fx.drop();
  }
} else console.log('TENANT SETTINGS：未设置 PG_TEST_URL，真实 PG 分支未运行');
console.log(`TENANT SETTINGS SELFTEST：${passed} 项通过`);
