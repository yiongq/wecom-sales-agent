// 12 第 1 步：附件的持久化、权限、清理、原子提交与 spill；同一套断言跑 PGlite / PG。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pgDriver from 'pg';
import { installVectorExtension } from './testing-extensions.js';
import { openDb, pgErrorOf, rowsOf, withTenant, type Db, type Tx } from './client.js';
import { createRealPgFixture, fakeDbError, installPgSessionStore, openGatedDb, openTestDb } from './testing.js';
import {
  insertAttachments,
  listAttachmentMetadata,
  purgeAttachmentBytes,
  readAttachment,
  readAttachmentUsage,
  writeAttachmentResult,
  type AttachmentItem,
} from './repo/attachments.js';
import { eraseConversation, purgeConversation } from './repo/retention.js';
import { addUsage } from './repo/usage.js';
import { attachments } from './schema.js';
import { ATTACHMENT_CLASSES } from '../core/attachments.js';
import { createFileBackend } from '../store/file-backend.js';
import { openPgBackend, type PgBackend } from '../store/pg-backend.js';
import type { Order, Session } from '../types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-selftest-'));
const ctx = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
const item = (over: Partial<AttachmentItem> = {}): AttachmentItem => ({
  id: `att_${randomBytes(12).toString('hex')}`,
  channel: 'wecom',
  sourceKey: randomBytes(8).toString('hex'),
  cls: 'image',
  mime: 'image/png',
  name: null,
  size: 3,
  sha256: 'synthetic',
  bytes: new Uint8Array([0, 128, 255]),
  intakeId: null,
  result: null,
  createdAt: Date.now(),
  ...over,
});
const session = (id: string): Session => ({
  id,
  channel: 'wecom',
  stage: 'greeting',
  profile: {},
  messages: [],
  orderIds: [],
  handedOver: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
type Query = <T = Record<string, unknown>>(text: string, args?: unknown[]) => Promise<T[]>;
type AsRole = <T>(role: 'agent_app' | 'agent_platform', run: (db: Db) => Promise<T>) => Promise<T>;
async function denied(fn: () => Promise<unknown>, code = '42501') {
  await assert.rejects(fn, (e) => pgErrorOf(e).code === code);
}
async function until(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error('等待写队列超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 从有业务行的 0020 升级，随后按旧用途继续写；也核对迁移重跑不会重复执行。 */
async function upgradeSuite(real?: Awaited<ReturnType<typeof createRealPgFixture>>) {
  const folder = fs.mkdtempSync(path.join(root, 'migrations-'));
  fs.mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 20);
  fs.writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const e of journal.entries) fs.copyFileSync(`drizzle/${e.tag}.sql`, path.join(folder, `${e.tag}.sql`));
  const exercise = async (q: Query, migrateFrom: (folder: string) => Promise<void>) => {
    await migrateFrom(folder);
    const tenantId = (
      await q<{ id: string }>("insert into tenants (slug,name,pack_id) values ('upgrade-att','升级测试','travel') returning id")
    )[0]!.id;
    await q("insert into usage_daily (tenant_id,day,model,purpose,calls) values ($1,current_date,'mock','chat',2)", [tenantId]);
    await migrateFrom('drizzle');
    await migrateFrom('drizzle');
    assert.equal((await q<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations'))[0]!.n, journal.entries.length + 1);
    await q(
      "insert into usage_daily (tenant_id,day,model,purpose,calls) values ($1,current_date,'mock-old','chat',1),($1,current_date,'mock','vision',1)",
      [tenantId],
    );
    assert.equal((await q<{ n: number }>('select sum(calls)::int as n from usage_daily'))[0]!.n, 4);
  };
  if (real) {
    const name = `attachment_upgrade_${randomBytes(6).toString('hex')}`;
    await real.query(`create database "${name}" owner agent_owner`);
    const url = (source: string) => {
      const u = new URL(source);
      u.pathname = `/${name}`;
      return u.toString();
    };
    const admin = new pgDriver.Client({ connectionString: url(real.urls.super) });
    const owner = new pgDriver.Client({ connectionString: url(real.urls.owner) });
    try {
      await admin.connect();
      await installVectorExtension((text) => admin.query(text));
      await owner.connect();
      await exercise(
        async <T>(text: string, args: unknown[] = []) => (await admin.query(text, args)).rows as T[],
        (folder) => migratePg(drizzlePg(owner), { migrationsFolder: folder }),
      );
    } finally {
      await owner.end();
      await admin.end();
      await real.query(`drop database "${name}" with (force)`);
    }
  } else {
    const pg = new PGlite();
    try {
      await pg.exec(`CREATE ROLE agent_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
        CREATE ROLE agent_app LOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE agent_platform LOGIN NOSUPERUSER NOBYPASSRLS;
        ALTER DATABASE postgres OWNER TO agent_owner;`);
      await exercise(
        async <T>(text: string, args: unknown[] = []) => (await pg.query<T>(text, args)).rows,
        async (folder) => {
          await pg.exec('SET ROLE agent_owner');
          try {
            await migrate(drizzle(pg), { migrationsFolder: folder });
          } finally {
            await pg.exec('RESET ROLE');
          }
        },
      );
    } finally {
      await pg.close();
    }
  }
  console.log(`${real ? 'PG' : 'PGlite'} migration: 含旧用量的 0020 升级、旧用途继续写、vision、重跑幂等 PASS`);
}

async function databaseSuite(q: Query, as: AsRole, label: string) {
  const tenant = async (slug: string) =>
    (await q<{ id: string }>("insert into tenants (slug,name,pack_id) values ($1,$1,'travel') returning id", [slug]))[0]!.id;
  const a = await tenant('attachment-a');
  const b = await tenant('attachment-b');
  const tx = <T>(t: string, fn: (tx: Tx) => Promise<T>, role: 'agent_app' | 'agent_platform' = 'agent_app') =>
    as(role, (db) => withTenant(db, ctx(t), fn));
  const conv = async (t: string, id: string) =>
    q(
      "insert into conversations (tenant_id,id,channel,stage,handed_over,state,created_at,updated_at) values ($1,$2,'wecom','greeting',false,json_build_object('id',$2::text),date_trunc('milliseconds',now())-interval '800 days',date_trunc('milliseconds',now())-interval '800 days')",
      [t, id],
    );
  await conv(a, 'a');
  await conv(b, 'b');
  const first = item();
  await tx(a, (t) => insertAttachments(t, 'a', [first]));
  assert.deepEqual(Array.from((await tx(a, (t) => readAttachment(t, first.id, true)))!.bytes!), [0, 128, 255]);
  assert.equal(await tx(b, (t) => readAttachment(t, first.id, true)), null);
  // R2：超限当场中断下载的那份算不出 sha256，只记元数据
  const aborted = item({ cls: 'other', mime: 'application/octet-stream', sha256: null, bytes: null, size: 9 * 1024 * 1024 });
  await conv(a, 'a2');
  await tx(a, (t) => insertAttachments(t, 'a2', [aborted]));
  assert.equal((await tx(a, (t) => readAttachment(t, aborted.id)))!.sha256, null);
  assert.equal(rowsOf(await tx(b, (t) => t.execute(sql`select id from attachments`))).length, 0);
  await denied(() =>
    tx(b, (t) =>
      t.execute(
        sql`insert into attachments (tenant_id,id,conversation_id,channel,source_key,cls,mime,size,sha256) values (${a}, 'cross', 'a', 'web', 'cross', 'image', 'image/png', 0, 'fake')`,
      ),
    ),
  );
  await denied(() => tx(b, (t) => insertAttachments(t, 'a', [item()])), '23503');
  await denied(() => tx(a, (t) => t.execute(sql`delete from attachments`)));
  await denied(() => tx(a, (t) => t.execute(sql`update attachments set bytes=null`)));
  await denied(() => tx(a, (t) => t.execute(sql`update attachments set source_key='changed'`)));
  for (const over of [{ cls: 'invalid' }, { channel: 'invalid' }, { size: -1 }]) {
    await denied(() => tx(a, (t) => insertAttachments(t, 'a', [item(over as Partial<AttachmentItem>)])), '23514');
  }
  await tx(a, (t) => insertAttachments(t, 'a', [first, item({ sourceKey: first.sourceKey })]));
  assert.equal((await tx(a, (t) => listAttachmentMetadata(t, 'a'))).length, 1);
  const meta = (await tx(a, (t) => readAttachment(t, first.id)))!;
  assert.equal(meta.stored, true);
  assert.equal('bytes' in meta, false);
  await tx(a, (t) => writeAttachmentResult(t, 'a', { id: first.id, intakeId: 'list-a', result: { rows: [1] } }));
  await tx(b, (t) => writeAttachmentResult(t, 'b', { id: first.id, intakeId: 'wrong', result: null }));
  assert.equal((await tx(a, (t) => readAttachment(t, first.id)))!.intakeId, 'list-a');
  console.log(`${label}: RLS、CHECK、唯一键去重、列权限、元数据不读 bytes PASS`);

  const now = new Date();
  const old = item({ createdAt: now.getTime() - 31 * 86400000, result: { keep: true }, intakeId: 'old' });
  const edge = item({ createdAt: now.getTime() - 30 * 86400000 });
  await tx(a, (t) => insertAttachments(t, 'a', [old, edge]));
  await denied(() => tx(a, (t) => purgeAttachmentBytes(t, new Date(now.getTime() + 3600000))), '22023');
  await denied(() => tx(b, (t) => t.execute(sql`select purge_attachment_bytes(${a}::uuid,now())`)));
  await denied(() => tx(a, (t) => purgeAttachmentBytes(t, now), 'agent_platform'));
  assert.equal(await tx(a, (t) => purgeAttachmentBytes(t, now)), 1);
  const kept = (await tx(a, (t) => readAttachment(t, old.id, true)))!;
  assert.equal(kept.bytes, null);
  assert.deepEqual(kept.result, { keep: true });
  assert.equal(kept.intakeId, 'old');
  assert.notEqual((await tx(a, (t) => readAttachment(t, edge.id, true)))!.bytes, null);
  assert.equal(await tx(a, (t) => purgeAttachmentBytes(t, now)), 0);
  console.log(`${label}: 30 天边界、保留元数据/result、清理权限与时间校验 PASS`);

  process.env.ATTACHMENT_DAILY_BYTES = '5';
  const quota = item();
  await tx(b, (t) => insertAttachments(t, 'b', [quota, item()]));
  assert.deepEqual(await tx(b, (t) => readAttachmentUsage(t)), { count: 2, bytes: 3 });
  await tx(b, (t) => insertAttachments(t, 'b', [quota, item({ bytes: new Uint8Array([1, 2]), size: 2 })]));
  assert.deepEqual(await tx(b, (t) => readAttachmentUsage(t)), { count: 3, bytes: 5 });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await tx(b, (t) => insertAttachments(t, 'b', [item({ createdAt: yesterday.getTime() })]));
  assert.deepEqual(await tx(b, (t) => readAttachmentUsage(t, yesterday)), { count: 1, bytes: 3 });
  delete process.env.ATTACHMENT_DAILY_BYTES;
  // 用数组调用并读回，确保 vision 的 TS 与 SQL 契约都能写入。
  await tx(a, (t) =>
    addUsage(t, [
      {
        day: '2026-10-29',
        model: 'mock',
        purpose: 'vision',
        calls: 1,
        promptTokens: 1,
        completionTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        costMilliCny: 0,
      },
    ]),
  );
  assert.equal((await q<{ calls: number }>("select calls from usage_daily where tenant_id=$1 and purpose='vision'", [a]))[0]!.calls, 1);
  const erased = await tx(a, (t) => eraseConversation(t, 'a', '合成行权测试'), 'agent_platform');
  assert.equal(erased.attachments, 3);
  assert.equal((await tx(a, (t) => listAttachmentMetadata(t, 'a'))).length, 0);
  const [stale] = await q<{ updated_at: Date }>("select updated_at from conversations where tenant_id=$1 and id='b'", [b]);
  assert.equal(await tx(b, (t) => purgeConversation(t, 'b', new Date(), 0, new Date(stale!.updated_at))), true);
  assert.equal((await tx(b, (t) => listAttachmentMetadata(t, 'b'))).length, 0);
  const [sbx] = await q<{ id: string }>(
    "insert into tenants (slug,name,pack_id,kind,expires_at,template_tenant_id) values ('sbx-att','沙箱','travel','sandbox',now()-interval '1 day',$1) returning id",
    [a],
  );
  await conv(sbx!.id, 'sbx');
  await tx(sbx!.id, (t) => insertAttachments(t, 'sbx', [item()]));
  const purged = await tx(
    sbx!.id,
    async (t) => rowsOf<{ r: { attachments: number } }>(await t.execute(sql`select sandbox_tenant_purge(${sbx!.id}::uuid) as r`))[0]!.r,
  );
  assert.equal(purged.attachments, 1);
  assert.equal((await q('select id from attachments where tenant_id=$1', [sbx!.id])).length, 0);
  console.log(`${label}: 本地日界、字节上限、vision、行权计数、保留级联与沙箱回收 PASS`);
}

async function storeSuite(db: Db, tenantId: string, faults: { acquire: Error | null }, q: Query, label: string) {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  let sessions = new Map<string, Session>();
  const deps = () => ({
    db,
    tenantId,
    varDir: dir,
    sessions,
    orders: new Map<string, Order>(),
    onConflict() {
      throw new Error('意外冲突');
    },
    writable: () => true,
  });
  let backend: PgBackend = await openPgBackend(deps());
  backend.install();
  try {
    const s = session('wecom:att-new');
    s.messages.push({ role: 'customer', content: '合成附件占位', at: Date.now() });
    sessions.set(s.id, s);
    const a = item();
    backend.queueAttachment(s.id, a);
    backend.queueAttachmentResult(s.id, { id: a.id, intakeId: 'queued', result: { ok: true } });
    backend.schedule(s);
    // 入队必须复制字节和结果，调用者之后释放/复用 buffer 不改变已经排队的行。
    a.bytes![0] = 99;
    await backend.flush(s.id);
    const [row] = await q<{ same: boolean; bytes: Uint8Array; intake_id: string }>(
      'select a.xmin=c.xmin and a.xmin=m.xmin as same,a.bytes,a.intake_id from attachments a join conversations c on a.tenant_id=c.tenant_id and a.conversation_id=c.id join messages m on m.tenant_id=a.tenant_id and m.conversation_id=c.id and m.seq=1 where a.id=$1',
      [a.id],
    );
    assert.equal(row!.same, true);
    assert.equal(row!.bytes[0], 0);
    assert.equal(row!.intake_id, 'queued');
    process.env.ATTACHMENT_DAILY_BYTES = '3';
    const capped = session('wecom:att-cap');
    sessions.set(capped.id, capped);
    const capItem = item();
    backend.queueAttachment(capped.id, capItem);
    backend.schedule(capped);
    await backend.flush(capped.id);
    assert.equal((await withTenant(db, ctx(tenantId), (tx) => readAttachment(tx, capItem.id, true)))!.bytes, null);
    delete process.env.ATTACHMENT_DAILY_BYTES;
    const bad = session('wecom:att-fail');
    sessions.set(bad.id, bad);
    const good = item();
    backend.queueAttachment(bad.id, good);
    backend.queueAttachment(bad.id, item({ size: -1 }));
    backend.schedule(bad);
    await assert.rejects(backend.flush(bad.id));
    assert.equal((await q('select id from attachments where id=$1', [good.id])).length, 0);
    assert.equal((await q('select id from conversations where tenant_id=$1 and id=$2', [tenantId, bad.id])).length, 0);
    backend.close();
    console.log(`${label}: 新会话与附件同事务、识别结果同事务、失败全回滚 PASS`);
    // 用另一个目录隔离上面的 poisoned 测例。模拟断线后同时留下在途与排队的附件。
    const spillDir = fs.mkdtempSync(path.join(root, 'spill-'));
    sessions = new Map();
    const spillDeps = () => ({ ...deps(), varDir: spillDir });
    backend = await openPgBackend(spillDeps());
    backend.install();
    const s2 = session('wecom:att-spill');
    sessions.set(s2.id, s2);
    faults.acquire = fakeDbError('08006');
    const x = item();
    const y = item();
    backend.queueAttachment(s2.id, x);
    backend.schedule(s2);
    await until(() => backend.stats().retries > 0);
    backend.queueAttachment(s2.id, y);
    backend.queueAttachmentResult(s2.id, { id: x.id, intakeId: 'spill-result', result: { retained: true } });
    backend.close();
    assert.equal(backend.spillSync(), 1);
    const file = fs.readdirSync(spillDir).find((f) => f.startsWith('store-spill-'))!;
    const raw = fs.readFileSync(path.join(spillDir, file), 'utf8');
    const doc = JSON.parse(raw);
    assert.equal(doc.sessions[0].inflight.attachments[0].bytes, null);
    assert.equal(doc.sessions[0].attachments[0].bytes, null);
    assert.equal(raw.includes('"type":"Buffer"'), false);
    faults.acquire = null;
    sessions = new Map();
    backend = await openPgBackend(spillDeps());
    backend.install();
    const got = await withTenant(db, ctx(tenantId), (t) => listAttachmentMetadata(t, s2.id));
    assert.equal(got.length, 2);
    assert.ok(got.every((r) => !r.stored));
    assert.equal(got.find((r) => r.id === x.id)!.intakeId, 'spill-result');
    backend.close();
    // 回放确认前进程崩溃：同一个 spill 再出现也不重复插入。
    fs.writeFileSync(path.join(spillDir, file), raw);
    sessions = new Map();
    backend = await openPgBackend(spillDeps());
    backend.install();
    assert.equal((await withTenant(db, ctx(tenantId), (t) => listAttachmentMetadata(t, s2.id))).length, 2);
    console.log(`${label}: 在途/排队 spill 无原件、回放元数据与识别结果、重复回放去重 PASS`);
  } finally {
    faults.acquire = null;
    backend.close();
  }
}

function fileSuite() {
  const dir = fs.mkdtempSync(path.join(root, 'file-'));
  const sessions = new Map<string, Session>();
  const s = session('web:attachment');
  sessions.set(s.id, s);
  const deps = {
    varDir: dir,
    sessions,
    orders: new Map<string, Order>(),
    owns: () => true,
    ownsOrder: () => true,
    isReal: () => true,
    afterPersist() {},
  };
  let b = createFileBackend(deps);
  try {
    const a = item({ channel: 'web' });
    b.queueAttachment(s.id, a);
    b.queueAttachmentResult(s.id, { id: a.id, intakeId: 'file-list', result: { ok: true } });
    b.schedule(s);
    b.flushNow();
    b.reset();
    b = createFileBackend(deps);
    b.load();
    const read = b.readAttachment(a.id, true)!;
    assert.ok('bytes' in read);
    assert.deepEqual(Array.from(read.bytes!), [0, 128, 255]);
    assert.deepEqual(read.result, { ok: true });
    assert.equal('bytes' in b.readAttachment(a.id, false)!, false);
    assert.equal(fs.existsSync(path.join(dir, 'attachments', a.id)), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'attachments', `${a.id}.json`), 'utf8')).bytes, undefined);
    b.queueAttachment(s.id, item({ sourceKey: a.sourceKey, channel: 'web' }));
    b.flushNow();
    assert.equal(b.listAttachmentMetadata(s.id).length, 1);
    process.env.ATTACHMENT_DAILY_BYTES = '3';
    const over = item();
    b.queueAttachment(s.id, over);
    b.flushNow();
    assert.equal((b.readAttachment(over.id, false) as { stored: boolean }).stored, false);
    assert.deepEqual(b.readAttachmentUsage(), { count: 2, bytes: 3 });
    assert.throws(() => b.readAttachment('../escape', true));
    console.log('file: 原件/元数据往返、结果保存、去重、字节预算、路径边界 PASS');
  } finally {
    b.reset();
    delete process.env.ATTACHMENT_DAILY_BYTES;
  }
}

try {
  // 库里的类别 CHECK 与判类模块（R1）是同一张表
  assert.deepEqual([...attachments.cls.enumValues], [...ATTACHMENT_CLASSES]);
  await upgradeSuite();
  const t = await openTestDb();
  try {
    await t.migrate();
    const q: Query = async <T>(text: string, args: unknown[] = []) =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<T>(text, args)).rows;
      });
    await databaseSuite(
      q,
      async (role, run) => {
        await t.pg.exec(`SET ROLE ${role}`);
        try {
          return await run(t.db);
        } finally {
          await t.pg.exec('RESET ROLE');
        }
      },
      'PGlite',
    );
    const fx = await installPgSessionStore(t, { varDir: root, slug: 'attachment-store' });
    await storeSuite(fx.deps.db, fx.deps.tenantId, fx.faults, q, 'PGlite');
  } finally {
    await t.close();
  }
  fileSuite();
  if (process.env.PG_TEST_URL) {
    const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'attachment-store' });
    const app = await openGatedDb(fx.urls.app);
    const platform = await openDb(fx.urls.platform);
    try {
      await upgradeSuite(fx);
      await databaseSuite(fx.query, (role, run) => run(role === 'agent_app' ? app.db : platform.db), 'PG');
      await storeSuite(app.db, fx.tenantId, app.faults, fx.query, 'PG');
      process.env.ATTACHMENT_DAILY_BYTES = '5';
      // 两条独立事务竞争同一租户预算，只有一份 3 字节原件能写入。
      await fx.query('delete from attachments where tenant_id=$1', [fx.tenantId]);
      await Promise.all([1, 2].map(() => withTenant(app.db, ctx(fx.tenantId), (tx) => insertAttachments(tx, 'wecom:att-new', [item()]))));
      assert.deepEqual(await withTenant(app.db, ctx(fx.tenantId), (tx) => readAttachmentUsage(tx)), { count: 2, bytes: 3 });
      console.log('PG: 并发事务的租户字节预算 PASS');
    } finally {
      delete process.env.ATTACHMENT_DAILY_BYTES;
      await app.close();
      await platform.close();
      await fx.drop();
    }
  } else if (process.env.CI === 'true') throw new Error('CI 必须提供 PG_TEST_URL');
  else console.log('未设 PG_TEST_URL：真实 PG 待补跑');
  console.log('ATTACHMENTS SELFTEST PASS');
} finally {
  delete process.env.ATTACHMENT_DAILY_BYTES;
  fs.rmSync(root, { recursive: true, force: true });
}
