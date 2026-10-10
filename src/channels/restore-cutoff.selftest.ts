// 03 第 12 步：channel-account restore-cutoff 与恢复哨兵（docs/architecture/03-channels-v2/spec.md R7、R19、「重启、崩溃与恢复 · 恢复截止点、
// 恢复哨兵」、不变量 9、14；验收 6 的命令行与哨兵部分、22 的最后一句）。四部分：
//   --until 的解析（进程内；换几个 TZ 结果相同，截止点与「明天」的判断不经本机时区）；
//   命令行（子进程、agent_app 身份、取租户锁（真实 PG 上是真锁）；PGlite 总是跑，有 PG_TEST_URL 时另在真实 Postgres 上跑一遍）：每一类改动、退出码、
//     拒绝时什么都不动、只动本租户、重跑无操作、企微状态不在库里时无操作、审计与输出只有账号 key 与条数；
//   哨兵端到端（PGlite）：backup.sh（假 docker、假 age）打出的归档解开之后，有启用的企微账号时 initChannels 以 channel_restore_pending
//     拒绝；跑过 restore-cutoff（缺省 var 目录取 VAR_DIR）之后照常装载，截止点进了账号。
//   「恢复截止点让 N 个会话只补记未回复」的告警（进程内，不连库）：按会话数合成一条、安静 10 秒之后发、一个进程只发一次。
// 截止点之前的入站「只补记、不调模型、不发送」与重启后不重复，在 recovery.selftest.ts 的 k5 → c5 → r5（真实 PG、完整运行时）。
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(process.env.VAR_DIR ?? os.tmpdir(), 'wecom-restore-cutoff-selftest-'));
process.env.VAR_DIR = path.join(root, 'app-var');
fs.mkdirSync(process.env.VAR_DIR);
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
process.env.CONFIG_SOURCE = 'file';
process.env.ALERT_WEBHOOK_URL = '';

const { parseUntil, RESTORE_CUTOFF_CLI_NOTE } = await import('../cli/channel-account.js');
const { RESTORE_SENTINEL, CHANNELS_IN_DB_MARKER } = await import('./markers.js');
const { sealSecrets, CHANNEL_KEY_ENV } = await import('./secrets.js');
const { openTestDb, createRealPgFixture } = await import('../db/testing.js');
const { holdTenantLock } = await import('../db/client.js');
const { AUDIT_ACTIONS } = await import('../shared/ui-labels.js');

let pass = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  pass++;
  console.log(`  ✔ ${name}`);
}
const MIN = 60_000;
const H = 60 * MIN;
const repo = process.cwd();
const cli = path.join(repo, 'src', 'cli', 'channel-account.ts');

// ================ --until 的解析 ================

const codeOf = (fn: () => unknown): number | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: number }).code ?? -1;
  }
};
{
  const now = Date.UTC(2026, 9, 9, 4, 0, 0);
  const cases: [string, number | null][] = [
    ['now', now],
    ['2026-10-09T03:00:00+08:00', Date.UTC(2026, 9, 8, 19)],
    ['2026-10-08T19:00:00Z', Date.UTC(2026, 9, 8, 19)],
    ['2026-10-08T14:30:00-04:30', Date.UTC(2026, 9, 8, 19)],
    ['2026-10-08T19:00Z', Date.UTC(2026, 9, 8, 19)],
    ['2026-10-08T19:00:00.5Z', Date.UTC(2026, 9, 8, 19, 0, 0, 500)],
    ['2026-10-08T19:00:00.123456+00:00', Date.UTC(2026, 9, 8, 19, 0, 0, 123)],
    ['2024-02-29T00:00:00Z', Date.UTC(2024, 1, 29)],
    ['2026-10-09T04:04:59Z', Date.UTC(2026, 9, 9, 4, 4, 59)], // 钟差：晚于现在不到 5 分钟可以
  ];
  const rejected = [
    '2026-10-10T04:00:00Z', // 明天
    '2026-10-10T12:00:00+08:00', // 明天（带时区）
    '2026-10-09T04:05:01Z', // 晚于现在 5 分钟以上
    '2026-10-09T12:05:01+08:00',
    '2026-10-09T03:00:00', // 不带时区
    '2026-10-09T03:00', // 不带时区
    '2026-10-09', // 只有日期
    '2026-10-09 03:00:00Z', // 空格分隔
    '2026-10-09T03:00:00+0800', // 时区不带冒号
    '2026-10-09T03:00:00z',
    'yesterday',
    'NOW',
    '',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-09T24:00:00Z',
    '2026-10-09T03:60:00Z',
    '2026-10-09T03:00:60Z',
    '2026-10-09T03:00:00+24:00',
    '0099-10-09T03:00:00Z',
    '1999-12-31T23:59:59Z',
    '1790913600000',
  ];
  const saved = process.env.TZ;
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Chatham']) {
    process.env.TZ = tz;
    await check(`--until（TZ=${tz}）：now 与带时区的 ISO 各种写法算出同一个绝对时刻`, () => {
      for (const [v, want] of cases) assert.equal(parseUntil(v, now).getTime(), want, v);
    });
    await check(`--until（TZ=${tz}）：明天、晚于现在 5 分钟以上、不带时区、格式或范围不对都以 1 拒绝`, () => {
      for (const v of rejected)
        assert.equal(
          codeOf(() => parseUntil(v, now)),
          1,
          v,
        );
    });
  }
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
}

// ================ 命令行：子进程、agent_app、每一类改动与退出码 ================

const keyBytes = Buffer.alloc(32, 12);
const keyRing = { current: { id: 'k12', key: keyBytes }, all: new Map([['k12', keyBytes]]) };
const restoreCiphertexts: Buffer[] = [];
const SECRETS = { appSecret: 'selftest12-app-value', callbackToken: 'selftest12-cb-value', callbackAesKey: 'selftest12-aes-value' };

interface Snapshot {
  accounts: { t: string; key: string; until: string | null }[] | null;
  outbound: { t: string; msgid: string; status: string; payload: boolean }[] | null;
  jobs: { t: string; key: string; status: string; err: string | null; fin: boolean }[] | null;
  messages: { c: string; seq: number; role: string; content: string }[] | null;
  conversations: { c: string; last: number; win: number; upd: string; flush: string | null; state: string }[] | null;
  inbox: { msgid: string; state: string; attempts: number }[] | null;
  audit:
    | { t: string; action: string; kind: string; name: string; type: string; target: string | null; diff: Record<string, unknown> }[]
    | null;
}
const SNAPSHOT_SQL = `select json_build_object(
  'accounts', (select json_agg(json_build_object('t', tenant_id, 'key', key, 'until', record_only_until) order by tenant_id, key) from channel_accounts),
  'outbound', (select json_agg(json_build_object('t', tenant_id, 'msgid', channel_msgid, 'status', status, 'payload', payload is not null) order by channel_msgid) from outbound_sends),
  'jobs', (select json_agg(json_build_object('t', tenant_id, 'key', dedupe_key, 'status', status, 'err', last_error, 'fin', finished_at is not null) order by dedupe_key) from jobs),
  'messages', (select json_agg(json_build_object('c', conversation_id, 'seq', seq, 'role', role, 'content', content) order by conversation_id, seq) from messages),
  'conversations', (select json_agg(json_build_object('c', id, 'last', last_seq, 'win', window_start_seq, 'upd', updated_at, 'flush', flush_id, 'state', state::text) order by id) from conversations),
  'inbox', (select json_agg(json_build_object('msgid', msgid, 'state', state, 'attempts', attempts) order by msgid) from channel_inbox),
  'audit', (select json_agg(json_build_object('t', tenant_id, 'action', action, 'kind', actor_kind, 'name', actor_name, 'type', target_type, 'target', target_id, 'diff', diff) order by id) from audit_log)
) as s`;

interface Suite {
  label: string;
  /** 以超级用户执行 SQL（造数据、读快照） */
  su<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R[]>;
  /** 跑一次命令行；lockHeld 时租户锁已被别人拿着 */
  run(args: string[], opts?: { env?: Record<string, string>; lockHeld?: boolean }): Promise<{ status: number | null; out: string }>;
  close(): Promise<void>;
}

const bridge = path.join(root, 'cli-bridge.mts');
// PGlite 只经自测桥接注入（生产入口只连 DATABASE_URL）：每次一个子进程，SET ROLE agent_app 之后跑，真正受列级授权与 RLS 约束
fs.writeFileSync(
  bridge,
  `
const { openTestDb, fakeLock } = await import(process.env.CLI_TEST_DB_MODULE);
const { runChannelAccount } = await import(process.env.CLI_TEST_MODULE);
const t = await openTestDb({ dataDir: process.env.CLI_TEST_DISK });
let code = 90;
try {
  await t.pg.exec('SET ROLE agent_app');
  code = await runChannelAccount(process.argv.slice(2), {
    connect: async () => ({ db: t.db, close: async () => {},
      lock: async () => process.env.CLI_TEST_LOCK === 'held' ? null : fakeLock() }),
  });
} finally {
  await t.close();
}
process.exit(code);
`,
);
const baseEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  DEPLOY_PROFILE: 'demo',
  DATABASE_URL: '',
  DATABASE_PLATFORM_URL: '',
  [CHANNEL_KEY_ENV]: '',
  VAR_DIR: path.join(root, 'no-such-var'),
});

function pgliteSuite(disk: string): Suite {
  return {
    label: 'PGlite 子进程',
    su: async (text, params = []) => {
      const t = await openTestDb({ dataDir: disk });
      try {
        return (await t.pg.query(text, params)).rows as never[];
      } finally {
        await t.close();
      }
    },
    run: async (args, opts = {}) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', bridge, ...args], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 90_000,
        killSignal: 'SIGKILL',
        env: {
          ...baseEnv(),
          CLI_TEST_MODULE: pathToFileURL(cli).href,
          CLI_TEST_DB_MODULE: pathToFileURL(path.join(repo, 'src', 'db', 'testing.ts')).href,
          CLI_TEST_DISK: disk,
          ...(opts.lockHeld ? { CLI_TEST_LOCK: 'held' } : {}),
          ...opts.env,
        },
      });
      assert.equal(r.signal, null, '命令行子进程超时');
      assert.notEqual(r.status, 90, `PGlite 命令行桥接失败：${r.stderr}`);
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
    close: async () => {},
  };
}

async function realPgSuite(url: string): Promise<Suite & { tenantSeed: string }> {
  const fx = await createRealPgFixture(url, { slug: 'rc12-seed' });
  return {
    label: '真实 PG 子进程',
    tenantSeed: fx.tenantId,
    su: fx.query,
    run: async (args, opts = {}) => {
      let release: (() => Promise<void>) | null = null;
      if (opts.lockHeld) {
        const [t] = await fx.query<{ id: string }>(`select id from tenants where slug = 'rc12'`);
        const lock = await holdTenantLock(fx.urls.app, t!.id);
        assert.ok(lock, '前提：自测先拿到租户锁');
        release = () => lock.release();
      }
      try {
        const r = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
          cwd: repo,
          encoding: 'utf8',
          timeout: 90_000,
          killSignal: 'SIGKILL',
          env: { ...baseEnv(), DATABASE_URL: fx.urls.app, ...opts.env },
        });
        assert.equal(r.signal, null, '命令行子进程超时');
        return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
      } finally {
        await release?.();
      }
    },
    close: fx.drop,
  };
}

/** 一个企微账号（凭据用 keyRing 加密，装载时解得开） */
async function addWecom(s: Suite, tenantId: string, key: string, prefix: string, status = 'active'): Promise<string> {
  const id = randomUUID();
  const { ct, keyId } = sealSecrets(keyRing, { tenantId, accountId: id }, SECRETS);
  restoreCiphertexts.push(ct);
  await s.su(
    `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
     values ($1, $2, $3, 'wecom_kf', $3, $4, $5, 'corp12', $6, decode($7, 'hex'), $8)`,
    [tenantId, id, key, status, prefix, `kf12${key}`, ct.toString('hex'), keyId],
  );
  return id;
}
/** 一个会话，n 条消息（客户、AI 交替） */
async function addConversation(
  s: Suite,
  tenantId: string,
  id: string,
  n: number,
  updatedAt: Date,
  state: Record<string, unknown> = {},
): Promise<void> {
  await s.su(
    `insert into conversations (tenant_id, id, channel, stage, handed_over, state, created_at, updated_at, last_seq, window_start_seq)
     values ($1, $2, 'wecom', 'greeting', false, $5::json, $3, $3, $4, 1)`,
    [tenantId, id, updatedAt.toISOString(), n, JSON.stringify({ id, ...state })],
  );
  for (let seq = 1; seq <= n; seq++) {
    await s.su(`insert into messages (tenant_id, conversation_id, seq, role, author, content, at) values ($1, $2, $3, $4, $5, $6, $7)`, [
      tenantId,
      id,
      seq,
      seq % 2 ? 'customer' : 'agent',
      seq % 2 ? null : 'ai',
      `第 ${seq} 句`,
      updatedAt.toISOString(),
    ]);
  }
}
async function addOutbound(
  s: Suite,
  tenantId: string,
  o: { msgid: string; conv: string; status: string; kind: string; at: number; account: string | null; inbox?: string },
): Promise<void> {
  const open = o.status === 'pending' || o.status === 'sending';
  await s.su(
    `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status, account_id, inbox_id, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::json)`,
    [
      tenantId,
      o.conv,
      o.msgid,
      o.kind,
      new Date(o.at).toISOString(),
      o.status,
      o.account,
      o.inbox ?? null,
      open ? JSON.stringify({ msgtype: 'text', text: { content: '发出去的话' } }) : null,
    ],
  );
}
async function addInbox(
  s: Suite,
  tenantId: string,
  o: { msgid: string; account: string; kind: string; conv: string; state: string; at: number },
): Promise<string> {
  const id = randomUUID();
  const open = o.state !== 'done' && o.state !== 'abandoned';
  await s.su(
    `insert into channel_inbox (tenant_id, id, account_id, msgid, kind, conversation_id, sent_at, state, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::json)`,
    [
      tenantId,
      id,
      o.account,
      o.msgid,
      o.kind,
      o.conv,
      new Date(o.at).toISOString(),
      o.state,
      open ? JSON.stringify({ msgid: o.msgid, msgtype: 'text', text: { content: '客户的话' } }) : null,
    ],
  );
  return id;
}
async function addJob(
  s: Suite,
  tenantId: string,
  o: { key: string; kind?: string; status: string; at: number; conv: string; stage?: string },
): Promise<void> {
  const done = ['done', 'failed', 'cancelled', 'abandoned'].includes(o.status);
  await s.su(
    `insert into jobs (tenant_id, kind, dedupe_key, run_at, status, max_attempts, payload, claimed_at, finished_at)
     values ($1, $2, $3, $4, $5, 3, $6::json, $7, $8)`,
    [
      tenantId,
      o.kind ?? 'followup',
      o.key,
      new Date(o.at).toISOString(),
      o.status,
      JSON.stringify({ sessionId: o.conv, ...(o.stage ? { stage: o.stage } : {}) }),
      o.status === 'pending' ? null : new Date(o.at + MIN).toISOString(),
      done ? new Date(o.at + 2 * MIN).toISOString() : null,
    ],
  );
}

const snapshot = async (s: Suite): Promise<Snapshot> => (await s.su<{ s: Snapshot }>(SNAPSHOT_SQL))[0]!.s;
const dirFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

async function cliScenarios(s: Suite): Promise<void> {
  const label = (x: string): string => `${s.label}：${x}`;
  const NOW = Date.now();
  const U = NOW - H; // 截止点：一小时前
  const untilArg = new Date(U + 8 * H).toISOString().replace('Z', '+08:00'); // 同一时刻的 +08:00 写法
  const [t] = await s.su<{ id: string }>(`insert into tenants (slug, name, pack_id) values ('rc12', 'rc12', 'travel') returning id`);
  const tid = t!.id;
  const [o] = await s.su<{ id: string }>(
    `insert into tenants (slug, name, pack_id) values ('rc12-other', 'rc12-other', 'travel') returning id`,
  );
  const other = o!.id;
  const [n] = await s.su<{ id: string }>(
    `insert into tenants (slug, name, pack_id) values ('rc12-none', 'rc12-none', 'travel') returning id`,
  );
  const none = n!.id;
  const [x] = await s.su<{ id: string }>(
    `insert into tenants (slug, name, pack_id) values ('rc12-exp', 'rc12-exp', 'travel') returning id`,
  );
  const exported = x!.id;

  // ---- 本租户：两个企微账号（一个停用）、一个网页账号 ----
  const main = await addWecom(s, tid, 'main', 'wecom:');
  const alt = await addWecom(s, tid, 'alt', 'wecom:alt:', 'disabled');
  await s.su(
    `insert into channel_accounts (tenant_id, key, kind, name, settings) values ($1, 'site', 'web', 'site', '{"title":"网页"}'::json)`,
    [tid],
  );
  const upd = new Date(U - 2 * H);
  const C1 = 'wecom:wm12c1'; // 人工回复 pending、AI 回复 sending、02 留下的通知 pending（account_id 为空）→ 说明
  const C2 = 'wecom:wm12c2'; // 截止点之后的 pending / sending、早就 accepted 的：都不动、没有说明
  const C3 = 'wecom:alt:wm12c3'; // 截止点之前没结束的客户消息 + 它名下的 pending：出站取消，说明留给启动时只补记那一步
  const C4 = 'wecom:wm12c4'; // 跟进 pending、run_at 在截止点之前 → 说明
  const C5 = 'wecom:wm12c5'; // 跟进 running → 说明
  const C6 = 'wecom:wm12c6'; // 截止点之后的跟进、sending / done 的跟进、转人工通知：都不动
  for (const [id, len] of [
    [C1, 2],
    [C2, 1],
    [C3, 1],
    [C4, 1],
  ] as const)
    await addConversation(s, tid, id, len, upd);
  // C5：原来就在 recommend 阶段追过一次（state 里别的键与键序不该变）；C6：截止点之后的跟进不动，记账也不动
  await addConversation(s, tid, C5, 3, upd, { stage: 'quote', followup: { count: 1, stages: ['recommend'], lastAt: 1 }, tail: 'x' });
  await addConversation(s, tid, C6, 1, upd, { stage: 'quote' });
  await addOutbound(s, tid, { msgid: 'o12c1p', conv: C1, status: 'pending', kind: 'human', at: U - 10 * MIN, account: main });
  await addOutbound(s, tid, { msgid: 'o12c1s', conv: C1, status: 'sending', kind: 'ai', at: U - 5 * MIN, account: main });
  await addOutbound(s, tid, { msgid: 'o12c1n', conv: C1, status: 'pending', kind: 'notice', at: U - 15 * MIN, account: null });
  await addOutbound(s, tid, { msgid: 'o12c1e', conv: C1, status: 'pending', kind: 'ai', at: U, account: main }); // 正好在截止点：算之前
  await addOutbound(s, tid, { msgid: 'o12c2p', conv: C2, status: 'pending', kind: 'ai', at: U + 10 * MIN, account: main });
  await addOutbound(s, tid, { msgid: 'o12c2s', conv: C2, status: 'sending', kind: 'ai', at: U + 5 * MIN, account: main });
  await addOutbound(s, tid, { msgid: 'o12c2a', conv: C2, status: 'accepted', kind: 'ai', at: U - 30 * MIN, account: main });
  await addOutbound(s, tid, { msgid: 'o12c2f', conv: C2, status: 'failed', kind: 'ai', at: U - 30 * MIN, account: main });
  const in3 = await addInbox(s, tid, { msgid: 'i12c3', account: alt, kind: 'message', conv: C3, state: 'received', at: U - 5 * MIN });
  await addOutbound(s, tid, { msgid: 'o12c3p', conv: C3, status: 'pending', kind: 'ai', at: U - 4 * MIN, account: alt, inbox: in3 });
  // 没有会话行的欢迎语（conversation_id 是将要用的会话 id）：取消、没有地方加说明
  await addOutbound(s, tid, { msgid: 'o12nx', conv: 'wecom:wm12nx', status: 'pending', kind: 'welcome', at: U - 20 * MIN, account: main });
  await addInbox(s, tid, { msgid: 'i12menu', account: main, kind: 'menu_click', conv: C2, state: 'received', at: U - 3 * MIN });
  await addInbox(s, tid, { msgid: 'i12rec', account: main, kind: 'message', conv: C2, state: 'recorded', at: U - 2 * MIN });
  await addInbox(s, tid, { msgid: 'i12done', account: main, kind: 'message', conv: C2, state: 'done', at: U - 50 * MIN });
  await addInbox(s, tid, { msgid: 'i12late', account: main, kind: 'message', conv: C2, state: 'received', at: U + 5 * MIN });
  await addInbox(s, tid, { msgid: 'i12fail', account: main, kind: 'send_fail', conv: C1, state: 'received', at: U - 2 * MIN });
  await addJob(s, tid, { key: 'j12c4', status: 'pending', at: U - MIN, conv: C4, stage: 'quote' });
  await addJob(s, tid, { key: 'j12c5', status: 'running', at: U - 30 * MIN, conv: C5, stage: 'quote' });
  await addJob(s, tid, { key: 'j12c6late', status: 'pending', at: U + 10 * MIN, conv: C6, stage: 'quote' });
  await addJob(s, tid, { key: 'j12c6send', status: 'sending', at: U - 10 * MIN, conv: C6, stage: 'closing' });
  await addJob(s, tid, { key: 'j12c6done', status: 'done', at: U - 2 * H, conv: C6 });
  await addJob(s, tid, { key: 'j12c6hn', kind: 'handoff_notify', status: 'pending', at: U - 10 * MIN, conv: C6 });
  // ---- 别的租户：同样有截止点之前的 pending、跟进，不受影响 ----
  const otherMain = await addWecom(s, other, 'main', 'wecom:');
  await addConversation(s, other, 'wecom:wm12oc', 1, upd);
  await addOutbound(s, other, {
    msgid: 'o12other',
    conv: 'wecom:wm12oc',
    status: 'pending',
    kind: 'ai',
    at: U - 10 * MIN,
    account: otherMain,
  });
  await addJob(s, other, { key: 'j12other', status: 'pending', at: U - 10 * MIN, conv: 'wecom:wm12oc' });
  // ---- 企微状态未导入（一行企微账号都没有）、已导出 ----
  await addJob(s, none, { key: 'j12none', status: 'pending', at: U - 10 * MIN, conv: 'wecom:wm12nn' });
  await addWecom(s, exported, 'main', 'wecom:', 'exported');
  await addJob(s, exported, { key: 'j12exp', status: 'running', at: U - 10 * MIN, conv: 'wecom:wm12ee' });

  const varDir = path.join(root, `var-${s.label.length}-${Date.now()}`);
  fs.mkdirSync(varDir);
  fs.writeFileSync(path.join(varDir, CHANNELS_IN_DB_MARKER), '{"tenant":"rc12","account":"main","at":"2026-10-09T00:00:00.000Z"}\n');
  fs.writeFileSync(path.join(varDir, RESTORE_SENTINEL), '{"backupAt":"2026-10-09T00:00:00Z"}\n');
  const args = (until: string, extra: string[] = []): string[] => [
    'restore-cutoff',
    '--tenant',
    'rc12',
    '--until',
    until,
    '--var',
    varDir,
    ...extra,
  ];
  let output = '';
  const run = async (a: string[], code: number, opts?: Parameters<Suite['run']>[1]): Promise<string> => {
    const r = await s.run(a, opts);
    output += r.out;
    assert.equal(r.status, code, `退出码应为 ${code}：${r.out}`);
    return r.out;
  };
  const before = await snapshot(s);
  const filesBefore = dirFiles(varDir);
  const unchanged = async (why: string): Promise<void> => {
    assert.deepEqual(await snapshot(s), before, `${why}：库里什么都不该动`);
    assert.deepEqual(dirFiles(varDir), filesBefore, `${why}：哨兵、标记都不该动`);
  };

  await check(label('--until 写明天、不带时区、格式不对、超出范围、缺了：都以 1 拒绝，库与哨兵都不动'), async () => {
    const tomorrow = new Date(Date.now() + 24 * H).toISOString();
    for (const bad of [
      tomorrow,
      tomorrow.replace('Z', '+08:00'),
      '2026-10-09T03:00:00',
      '2026-10-09',
      'yesterday',
      '2026-02-30T00:00:00Z',
    ]) {
      await run(args(bad), 1);
      await unchanged(bad);
    }
    await run(['restore-cutoff', '--tenant', 'rc12', '--var', varDir], 1);
    await run(['restore-cutoff', '--until', 'now', '--var', varDir], 1);
    await run(['restore-cutoff', '--tenant', 'rc12', '--until', 'now', '--key', 'main'], 1);
    await run(['restore-cutoff', '--tenant', 'rc12-nope', '--until', 'now', '--var', varDir], 1);
    await unchanged('缺参数、多参数、租户不存在');
  });
  await check(label('租户锁在别人手里（应用没停）：3，什么都不动'), async () => {
    assert.match(await run(args(untilArg), 3, { lockHeld: true }), /lock_held/);
    await unchanged('持锁');
  });
  await check(label('var/ 里有没回放的 spill：2，什么都不动'), async () => {
    const spill = path.join(varDir, 'store-spill-2026-10-09T00-00-00-000Z.json');
    fs.writeFileSync(spill, '{}');
    assert.match(await run(args(untilArg), 2), /spill[\s\S]*有启用的企微账号时[\s\S]*全部停用时应用照常起来/);
    fs.rmSync(spill);
    await unchanged('spill');
  });

  await check(label('事务里最后一步（审计）失败：整个回滚，截止点、出站、跟进、说明都没写，哨兵留着，以 1 退出'), async () => {
    await s.su(`create function rc12_fail() returns trigger language plpgsql as $$ begin raise exception 'rc12 故障注入'; end $$`);
    await s.su(
      `create trigger rc12_fail before insert on audit_log for each row when (new.action = 'channel.restore_cutoff') execute function rc12_fail()`,
    );
    try {
      assert.match(await run(args(untilArg), 1), /读写失败/);
    } finally {
      await s.su('drop trigger rc12_fail on audit_log');
      await s.su('drop function rc12_fail()');
    }
    await unchanged('审计失败');
  });
  let after!: Snapshot;
  await check(
    label('一个事务：全部企微账号写截止点，截止点之前的出站 pending → cancelled、sending → unknown，跟进 pending / running → cancelled'),
    async () => {
      const out = await run(args(untilArg), 0);
      after = await snapshot(s);
      const until = (key: string, tenant = tid) => after.accounts!.find((a) => a.t === tenant && a.key === key)!.until;
      assert.equal(Date.parse(until('main')!), U, '启用的账号');
      assert.equal(Date.parse(until('alt')!), U, '停用的账号也写（之后启用照样只补记）');
      assert.equal(until('site'), null, '网页账号不写');
      assert.equal(until('main', other), null, '别的租户不写');
      const status = (msgid: string) => after.outbound!.find((r) => r.msgid === msgid)!;
      for (const [msgid, want] of [
        ['o12c1p', 'cancelled'],
        ['o12c1s', 'unknown'],
        ['o12c1n', 'cancelled'],
        ['o12c1e', 'cancelled'],
        ['o12c3p', 'cancelled'],
        ['o12nx', 'cancelled'],
        ['o12c2p', 'pending'],
        ['o12c2s', 'sending'],
        ['o12c2a', 'accepted'],
        ['o12c2f', 'failed'],
        ['o12other', 'pending'],
      ])
        assert.equal(status(msgid).status, want, msgid);
      for (const msgid of ['o12c1p', 'o12c1s', 'o12c1n', 'o12c3p', 'o12nx'])
        assert.equal(status(msgid).payload, false, `${msgid} 的 payload 置空`);
      assert.equal(status('o12c2p').payload, true, '截止点之后的 pending 留着 payload');
      const job = (key: string) => after.jobs!.find((r) => r.key === key)!;
      for (const key of ['j12c4', 'j12c5'])
        assert.deepEqual([job(key).status, job(key).err, job(key).fin], ['cancelled', 'restore_cutoff', true], key);
      assert.equal(job('j12c6late').status, 'pending', '截止点之后的跟进不动');
      assert.equal(job('j12c6send').status, 'sending', 'sending 的跟进不动（启动归位照 02 记 abandoned）');
      assert.equal(job('j12c6done').status, 'done');
      assert.equal(job('j12c6hn').status, 'pending', '转人工通知不是跟进，不动');
      assert.equal(job('j12other').status, 'pending', '别的租户不动');
      assert.equal(job('j12none').status, 'pending');
      assert.equal(job('j12exp').status, 'running');
      assert.deepEqual(after.inbox, before.inbox, '入站行一行不改（启动时按截止点只补记）');
      assert.match(out, /企微账号 2 个（含停用）都写了/);
      // i12c3、i12rec（消息，received 与 recorded 都算）与 i12menu（菜单点击）；done、截止点之后的、回执不算
      assert.match(out, /没结束的入站 3 条/);
      assert.ok(!out.includes('wm12'), '输出里没有会话 id 与客户标识');
    },
  );
  await check(
    label('涉及的会话各加一条说明（system、last_seq + 1、updated_at 不动）；截止点之前还有没结束客户消息的会话留给启动时那一条'),
    async () => {
      const added = after.messages!.filter((m) => !before.messages!.some((b) => b.c === m.c && b.seq === m.seq));
      assert.deepEqual(
        added.map((m) => [m.c, m.seq, m.role, m.content]),
        [
          [C1, 3, 'system', RESTORE_CUTOFF_CLI_NOTE],
          [C4, 2, 'system', RESTORE_CUTOFF_CLI_NOTE],
          [C5, 4, 'system', RESTORE_CUTOFF_CLI_NOTE],
        ],
      );
      for (const c of after.conversations!) {
        const b = before.conversations!.find((x) => x.c === c.c)!;
        const bumped = [C1, C4, C5].includes(c.c) ? 1 : 0;
        assert.deepEqual([c.last, c.win, c.upd, c.flush], [b.last + bumped, b.win, b.upd, b.flush], c.c);
        if (![C4, C5].includes(c.c)) assert.equal(c.state, b.state, `${c.c} 的 state 不动`);
      }
      assert.match(RESTORE_CUTOFF_CLI_NOTE, /^恢复备份之后补记/);
    },
  );
  await check(label('被取消的跟进那一阶段记进会话的跟进记账（stages 加上、count 加一），state 别的键与键序不变'), async () => {
    const state = (c: string, snap: Snapshot) => snap.conversations!.find((x) => x.c === c)!.state;
    const parsed = (c: string, snap: Snapshot) => JSON.parse(state(c, snap)) as Record<string, unknown>;
    assert.deepEqual(parsed(C4, after).followup, { stages: ['quote'], count: 1 });
    assert.deepEqual(parsed(C5, after).followup, { count: 2, stages: ['recommend', 'quote'], lastAt: 1 });
    assert.deepEqual(Object.keys(parsed(C5, after)), Object.keys(parsed(C5, before)), 'C5 的键序不变');
    assert.deepEqual(Object.keys(parsed(C5, after).followup as object), ['count', 'stages', 'lastAt'], 'followup 里的键序不变');
    assert.equal(parsed(C5, after).tail, 'x');
    assert.equal(state(C6, after), state(C6, before), '截止点之后的跟进、sending 的跟进：记账不动');
  });
  await check(label('审计一行 channel.restore_cutoff：命令行身份，只有账号 key、截止点与条数'), async () => {
    const added = after.audit!.slice(before.audit?.length ?? 0);
    assert.equal(added.length, 1);
    const a = added[0]!;
    assert.deepEqual(
      [a.t, a.action, a.kind, a.name, a.type, a.target],
      [tid, 'channel.restore_cutoff', 'platform', 'channel-account', 'channel_account', null],
    );
    assert.deepEqual(a.diff, {
      keys: ['main', 'alt'],
      until: new Date(U).toISOString(),
      accounts: 2,
      inbox: 3,
      cancelled: 5,
      unknown: 1,
      jobs: 2,
      notes: 3,
    });
    assert.ok(!JSON.stringify(a.diff).includes('wm12'));
    assert.match(AUDIT_ACTIONS['channel.restore_cutoff']!.label, /\p{Script=Han}/u);
  });
  await check(label('提交之后删恢复哨兵，标记不动'), async () => {
    assert.ok(!fs.existsSync(path.join(varDir, RESTORE_SENTINEL)), '哨兵删了');
    assert.equal(fs.readFileSync(path.join(varDir, CHANNELS_IN_DB_MARKER), 'utf8'), filesBefore[CHANNELS_IN_DB_MARKER]);
    assert.match(output, /已删恢复哨兵 restored-from-backup\.json/);
  });
  await check(label('同一截止点再跑一次：0，什么都不改、不加说明、不记审计，告诉你没有哨兵'), async () => {
    const out = await run(args(untilArg), 0);
    assert.deepEqual(await snapshot(s), after);
    assert.match(out, /无操作/);
    assert.match(out, /没有恢复哨兵/);
  });
  await check(label('企微状态未导入、已导出（var/ 里有 spill 也一样）：0，什么都不改，哨兵留给应用启动时删'), async () => {
    for (const slug of ['rc12-none', 'rc12-exp']) {
      const dir = path.join(root, `var-${slug}-${s.label.length}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, RESTORE_SENTINEL), '{}');
      // 有没回放的 spill 也一样：先判企微状态，未导入、已导出直接无操作，不以 2 拒绝（第 12 步评审）
      fs.writeFileSync(path.join(dir, 'store-spill-2026-10-09T00-00-00-000Z.json'), '{}');
      const out = await run(['restore-cutoff', '--tenant', slug, '--until', 'now', '--var', dir], 0);
      assert.match(out, /无操作：企微状态未导入或已导出/);
      assert.ok(fs.existsSync(path.join(dir, RESTORE_SENTINEL)), '哨兵留着');
    }
    assert.deepEqual(await snapshot(s), after);
  });
  await check(label('输出凭据补扫：密文 base64、hex、Buffer JSON 与 access_token 零命中'), () => {
    for (const v of [
      'access_token',
      ...restoreCiphertexts.flatMap((ct) => [ct.toString('base64'), ct.toString('hex'), JSON.stringify(ct)]),
    ]) {
      assert.ok(!output.includes(v), '输出出现密文或 access_token');
    }
  });
  await check(label('输出里没有凭据、企微标识'), async () => {
    for (const v of [...Object.values(SECRETS), 'corp12', 'kf12main', 'kf12alt', 'wm12']) assert.ok(!output.includes(v), v);
  });
}

// ================ 哨兵端到端：backup.sh 打出的哨兵拦住启动，restore-cutoff 之后照常装载 ================

async function sentinelEndToEnd(disk: string, s: Suite): Promise<void> {
  const [t] = await s.su<{ id: string }>(
    `insert into tenants (slug, name, pack_id) values ('rc12-e2e', 'rc12-e2e', 'travel') returning id`,
  );
  const tid = t!.id;
  await addWecom(s, tid, 'main', 'wecom:');
  // 线上部署目录：var/ 里有标记（企微状态在库里），没有哨兵。backup.sh 用假 docker、假 age（原样拷贝）
  const srv = path.join(root, 'srv');
  const bin = path.join(root, 'bin');
  const bk = path.join(root, 'bk');
  fs.mkdirSync(path.join(srv, 'var'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(srv, '.env'), 'DEPLOY_PROFILE=demo\n');
  fs.writeFileSync(
    path.join(srv, '.env.backup'),
    ['BACKUP_AGE_RECIPIENTS=age1test', `BACKUP_DIR=${bk}`, 'COMPOSE_PROJECT=rc12', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(srv, 'var', CHANNELS_IN_DB_MARKER),
    '{"tenant":"rc12-e2e","account":"main","at":"2026-10-09T00:00:00.000Z"}\n',
  );
  const fake = (name: string, lines: string[]): void =>
    fs.writeFileSync(path.join(bin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
  fake('docker', [
    'case "$*" in',
    '  *pg_dumpall*) echo "-- globals" ;;',
    '  *pg_dump*) echo dump ;;',
    '  *"pg_restore --list"*) cat >/dev/null; for t in memberships sop_versions catalog_items audit_log conversations messages orders channel_accounts channel_inbox; do echo "1; 0 0 TABLE DATA public $t agent_owner"; done ;;',
    '  *psql*) echo "2|43|conversations messages orders channel_accounts channel_inbox" ;;',
    '  *) exit 97 ;;',
    'esac',
  ]);
  fake('age', ['out=""', 'while [ $# -gt 1 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done', 'cp "$1" "$out"']);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !/^(ALERT_WEBHOOK_URL|COMPOSE_PROJECT|BACKUP_.*)$/.test(e[0]),
    ),
  );
  const b = spawnSync('bash', [path.join(repo, 'deploy', 'backup.sh'), srv], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  await check('哨兵端到端：backup.sh 照常备份，线上 var/ 里没有哨兵', () => {
    assert.equal(b.status, 0, `${b.stdout}${b.stderr}`);
    assert.ok(!fs.existsSync(path.join(srv, 'var', RESTORE_SENTINEL)));
  });
  // 恢复手册第 5 步：在新的地方解开 var/
  const restored = path.join(root, 'restored');
  fs.mkdirSync(restored);
  const [day] = fs.readdirSync(path.join(bk, 'rc12')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const x = spawnSync('tar', ['-xzf', path.join(bk, 'rc12', day!, 'var.tar.gz.age'), '-C', restored], { encoding: 'utf8' });
  const restoredVar = path.join(restored, 'var');
  await check('哨兵端到端：解开的 var/ 里有恢复哨兵与标记', () => {
    assert.equal(x.status, 0, x.stderr);
    assert.ok(fs.existsSync(path.join(restoredVar, RESTORE_SENTINEL)));
    assert.ok(fs.existsSync(path.join(restoredVar, CHANNELS_IN_DB_MARKER)));
  });

  const { initChannels, loadedChannels, channelsMode, ChannelStartupError, __channelsTest } = await import('./registry.js');
  const init = async (): Promise<{ reason: string | null; until: number | null; mode: string }> => {
    const db = await openTestDb({ dataDir: disk });
    // 应用的身份：受 RLS 约束，只看得见本租户的账号
    await db.pg.exec('SET ROLE agent_app');
    try {
      __channelsTest.reset();
      try {
        await initChannels({ db: db.db, tenantId: tid, tenantSlug: 'rc12-e2e', varDir: restoredVar, keyRing });
      } catch (e) {
        if (!(e instanceof ChannelStartupError)) throw e;
        return { reason: e.reason, until: null, mode: channelsMode() };
      }
      const main = [...loadedChannels().values()].find((c) => c.account.key === 'main');
      return { reason: null, until: main?.account.wecom?.recordOnlyUntil ?? null, mode: channelsMode() };
    } finally {
      __channelsTest.reset();
      await db.close();
    }
  };
  await check('哨兵端到端：不跑 restore-cutoff 直接起，以 channel_restore_pending 拒绝、哨兵留着', async () => {
    const r = await init();
    assert.equal(r.reason, 'channel_restore_pending');
    assert.ok(fs.existsSync(path.join(restoredVar, RESTORE_SENTINEL)));
  });
  await check('哨兵端到端：restore-cutoff --until now（var 目录取 VAR_DIR）之后照常装载，截止点进了账号', async () => {
    const t0 = Date.now();
    const r = await s.run(['restore-cutoff', '--tenant', 'rc12-e2e', '--until', 'now'], { env: { VAR_DIR: restoredVar } });
    assert.equal(r.status, 0, r.out);
    assert.ok(!fs.existsSync(path.join(restoredVar, RESTORE_SENTINEL)), '哨兵删了');
    const ok = await init();
    assert.equal(ok.reason, null);
    assert.equal(ok.mode, 'db');
    assert.ok(ok.until !== null && ok.until >= t0 - 1000 && ok.until <= Date.now(), `截止点 ${ok.until}`);
  });
}

// ================ 「只补记」告警：按会话数合成一条（进程内，不连库） ================

async function restoreAlert(): Promise<void> {
  const { __alertTest, startAlerts } = await import('../ops/alert.js');
  const { noteInboxAbandoned } = await import('./inbox.js');
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(' '));
  try {
    let t = Date.UTC(2026, 9, 9, 4);
    __alertTest.setClock(() => t);
    startAlerts();
    __alertTest.stopTimer();
    __alertTest.reset();
    const lines = (): string[] => warned.filter((l) => l.includes('恢复截止点之前的客户消息只补记'));
    // 启动恢复与第一次拉取：会话甲两句（第二句不再加说明）、会话乙一句、一次菜单点击（不补记、不加说明）
    for (const noted of [true, false, true, false]) noteInboxAbandoned({ reason: 'restore_cutoff', account: 'main', noted });
    t += 5_000;
    __alertTest.tick();
    await check('「只补记」告警：最后一个会话之后不到 10 秒不发', () => assert.equal(lines().length, 0));
    t += 6_000;
    __alertTest.tick();
    await check('「只补记」告警：安静 10 秒之后发一条，只有会话数（2 个会话，不是 4 行），不带账号以外的标识', () => {
      assert.equal(lines().length, 1);
      assert.match(lines()[0]!, /：2 个会话，/);
    });
    noteInboxAbandoned({ reason: 'restore_cutoff', account: 'main', noted: true });
    t += 60_000;
    __alertTest.tick();
    await check('「只补记」告警：一个进程只发一次', () => assert.equal(lines().length, 1));
  } finally {
    console.warn = warn;
    __alertTest.setClock(null);
    __alertTest.reset();
  }
}

// ================ 跑 ================

const disk = path.join(root, 'pglite');
const pglite = pgliteSuite(disk);
// 先建出库（迁移），子进程打开的是同一个目录
await (await openTestDb({ dataDir: disk })).close();
await cliScenarios(pglite);
await sentinelEndToEnd(disk, pglite);
await restoreAlert();
if (process.env.PG_TEST_URL) {
  const real = await realPgSuite(process.env.PG_TEST_URL);
  try {
    await cliScenarios(real);
  } finally {
    await real.close();
  }
} else if (process.env.CI === 'true') {
  throw new Error('CI 下必须设 PG_TEST_URL：restore-cutoff 要在真实 Postgres 上再跑一遍');
}

console.log(
  `RESTORE-CUTOFF SELFTEST PASS: ${pass} 项（--until 的解析与 TZ 无关 / 命令行每一类改动、退出码、拒绝不动、重跑无操作、只动本租户、` +
    `审计与输出只有条数${process.env.PG_TEST_URL ? '（PGlite 与真实 PG）' : '（PGlite；真实 PG 没设 PG_TEST_URL 跳过）'} / ` +
    `backup.sh 的哨兵拦住启动、restore-cutoff 之后照常装载 / 「只补记」告警按会话数一条）`,
);
