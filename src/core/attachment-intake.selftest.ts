import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import type { Db } from '../db/client.js';
import type { PreparedAttachment } from './attachment-intake.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-intake-'));
Object.assign(process.env, { VAR_DIR: dir, CONFIG_SOURCE: 'file', LLM_MOCK: '1', ATTACHMENT_DAILY_PER_TENANT: '300' });
const { hostRuntime } = await import('../tenancy/runtime.js');
const { enterTenantScopeForTest } = await import('../tenancy/testing.js');
enterTenantScopeForTest(hostRuntime());
const store = await import('../store.js');
const config = await import('../config/source.js');
await config.initConfig(null);
const testing = await import('../db/testing.js');
const { prepareAttachment, earlyAttachment } = await import('./attachment-intake.js');
const { tenantKeys } = await import('../tenancy/state.js');
let db: Db;
let tenantId: string;
let query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let closeDb: () => Promise<void>;
if (process.env.PG_TEST_URL) {
  const fx = await testing.createRealPgFixture(process.env.PG_TEST_URL, { slug: 'attachment-intake' });
  const app = await testing.openGatedDb(fx.urls.app);
  db = app.db;
  tenantId = fx.tenantId;
  query = fx.query;
  closeDb = async () => {
    await app.close();
    await fx.drop();
  };
} else {
  const t = await testing.openTestDb();
  const fx = await testing.installPgSessionStore(t, { slug: 'attachment-intake', varDir: dir });
  db = fx.deps.db;
  tenantId = fx.deps.tenantId;
  query = <T>(sql: string, params: unknown[] = []) =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<T>(sql, params)).rows;
    });
  closeDb = () => t.close();
}
await store.initSessionStore({ db, tenantId, tenantSlug: 'attachment-intake', varDir: dir });
function segment(marker: number, text: string | Buffer): Buffer {
  const data = Buffer.from(text);
  const head = Buffer.from([255, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}
const input = (sourceKey: string) => ({ bytes: Buffer.from('A,2'), name: 'a.csv', channel: 'web' as const, sourceKey });
async function persist(id: string, prepared: PreparedAttachment) {
  const s = store.getOrCreateSession(id, 'web');
  assert.equal(store.queueAttachment(id, prepared.attachmentItem), true);
  store.saveSession(s);
  await store.flushSession(id);
}
try {
  const s = store.getOrCreateSession('quota-seed', 'web');
  store.saveSession(s);
  await store.flushSession(s.id);
  await query(
    `insert into attachments (tenant_id,id,conversation_id,channel,source_key,cls,mime,size,created_at)
    select $1, 'att_' || lpad(to_hex(i),24,'0'), $2, 'web', 'seed-' || i, 'other', 'application/octet-stream', 0, $3
    from generate_series(1,299) as i`,
    [tenantId, s.id, new Date()],
  );

  assert.equal((await store.readAttachmentUsage()).count, 299);

  const parallel = await Promise.all([prepareAttachment(input('session-a')), prepareAttachment(input('session-b'))]);
  assert.equal(parallel.filter((r) => r.ok).length, 1, '299 基数并发只放行一份');
  assert.deepEqual(
    parallel.find((r) => !r.ok),
    { ok: false, text: '请把型号和数量打字发来', cls: 'sheet' },
  );
  const winner = parallel.find((r) => r.ok)!;
  assert.equal(winner.ok, true);
  assert.ok(tenantKeys(hostRuntime().id)['attachment.daily'] > 0);
  console.log('PASS intake: 基数 299 并发两会话只放行一次，另一份回超限固定句');

  assert.equal((await prepareAttachment(input('not-saved-over'))).ok, false, '准备成功即计数，未保存也不退还');
  process.env.ATTACHMENT_DAILY_PER_TENANT = '301';
  await assert.rejects(
    prepareAttachment({
      ...input('failed'),
      get sourceKey(): string {
        throw new Error('prepare_failed');
      },
    }),
    /prepare_failed/,
  );
  const early = earlyAttachment(Buffer.from('PK'), 3 * 1024 * 1024);
  const metadata = await prepareAttachment(input('early-limit'), early.metadata);
  assert.equal(metadata.ok, true, '准备失败后下一份可以放行');
  assert.equal(metadata.value.attachmentItem.bytes, null);
  assert.equal(metadata.value.attachmentItem.sha256, null);
  await persist('metadata-session', metadata.value);
  assert.equal((await store.readAttachmentUsage()).count, 300);
  assert.equal((await prepareAttachment(input('over'))).ok, false, '只存元数据也计一份，提交后不释放');
  console.log('PASS intake: 成功未保存仍占份数、准备失败释放、早判只存元数据仍计一份');

  const nextDay = new Date();
  nextDay.setDate(nextDay.getDate() + 1);
  nextDay.setHours(12, 0, 0, 0);
  mock.timers.enable({ apis: ['Date'], now: nextDay });
  process.env.ATTACHMENT_DAILY_PER_TENANT = '1';
  const tomorrow = await prepareAttachment(input('tomorrow'));
  assert.equal(tomorrow.ok, true, '跨日重读新基数');
  assert.equal((await prepareAttachment(input('tomorrow-over'))).ok, false);
  console.log('PASS intake: 跨日重新读基数，与前一天计数隔离');
  mock.timers.reset();
  process.env.ATTACHMENT_DAILY_PER_TENANT = '301';

  const scan = Buffer.from('ffda000273ff0020ffd031ffd9', 'hex');
  const orientation = Buffer.from('ffe100224578696600004d4d002a00000008000101120003000000010006000000000000', 'hex');
  const clean = Buffer.concat([Buffer.from('ffd8', 'hex'), orientation, segment(0xe0, 'JFIF'), scan]);
  const original = Buffer.concat([
    Buffer.from('ffd8', 'hex'),
    segment(0xe1, 'XMP private location'),
    segment(0xed, 'IPTC private'),
    // IFD0 含 Orientation=6 与设备 Make；净字节只能留下前一项。
    segment(
      0xe1,
      Buffer.from('4578696600004d4d002a000000080002011200030000000100060000010f000200000006000000260000000043616d657261', 'hex'),
    ),
    segment(0xe0, 'JFIF'),
    segment(0xfe, 'private comment'),
    scan,
  ]);
  const image = await prepareAttachment({ ...input('metadata'), bytes: original, name: 'a.jpg' });
  assert.equal(image.ok, true);
  assert.deepEqual(image.value.attachmentBytes, clean, '交给引擎的字节保留最小 Orientation=6，删除其余元数据');
  assert.deepEqual(image.value.attachmentItem.bytes, clean, '待存字节保留最小 Orientation=6，删除其余元数据');
  assert.equal(image.value.attachmentItem.sha256, createHash('sha256').update(clean).digest('hex'));
  await persist('image-session', image.value);
  const saved = await store.readAttachment(image.value.attachment.id, true);
  assert.ok(saved && 'bytes' in saved && saved.bytes);
  assert.deepEqual(Buffer.from(saved.bytes), clean, '实际持久化字节保留最小 Orientation=6，删除其余元数据');
  console.log('PASS intake: 存库与 attachmentBytes 都只保留最小 Orientation=6，哈希按净字节计算');
} finally {
  mock.timers.reset();
  delete process.env.ATTACHMENT_DAILY_PER_TENANT;
  try {
    assert.deepEqual((await store.drainStore(20_000)).undrained, []);
  } finally {
    await config.closeConfig();
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`PASS attachment-intake: ${process.env.PG_TEST_URL ? '真实 PG' : 'PGlite'}`);
