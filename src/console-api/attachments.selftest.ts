// 12 第 9 步（R12）：工作台下载附件原件的自测（spec 12 不变量 5、验收 8、9 中与下载有关的部分）。
// 三段：
//   1. 响应头与文件名（纯函数）：白名单类型、强制 attachment、RFC 5987 编码、控制字符与孤立代理项、没有名字时的名字。
//   2. downloadAttachment（读原件加写审计，同一个租户事务）：PGlite 与真实 PG（给了 PG_TEST_URL）各跑一遍同一份断言——属于这个会话、
//      没有原件、别的会话、别的租户（RLS）、id 不合格，审计行的内容，审计写不进时不给文件且不留半截。
//   3. 接口（PGlite 上的 db 会话存储，走 server.ts 的 app.request）：五种角色与匿名的权限、跨站、响应头与字节原样、审计、
//      审计写不进就不给文件、MessageView.attachment 的 stored 以库里附件行为准（消息上写 stored: true 而库里没有字节）、
//      只读成员的文件名打码、demo 类会话（附件在文件后端）。
// 用法：npx tsx src/console-api/attachments.selftest.ts（真实 PG：PG_TEST_URL=postgres://… 另跑一遍第二段）
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tx } from '../db/client.js';
import type { AttachmentItem } from '../db/repo/attachments.js';
import { hostRuntime, withoutTenantScope } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-attdl-selftest-'));
process.env.LLM_MOCK = '1';
process.env.CONFIG_SOURCE = 'file';
process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const { openTestDb, installSeededConfig, installPgSessionStore, createRealPgFixture } = await withoutTenantScope(
  () => import('../db/testing.js'),
);
const { openDb, withTenant } = await withoutTenantScope(() => import('../db/client.js'));
const { insertAttachments, purgeAttachmentBytes } = await withoutTenantScope(() => import('../db/repo/attachments.js'));
const { attachmentHeaders, downloadAttachment, isAttachmentId } = await withoutTenantScope(() => import('./attachments.js'));
const { stripImageMetadata } = await withoutTenantScope(() => import('../core/attachments.js'));

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const attId = (): string => `att_${randomBytes(12).toString('hex')}`;
const hex = (text: string): Buffer => Buffer.from(text.replaceAll(' ', ''), 'hex');
/** 合成的最小 JPEG：SOI、JFIF、一段扫描、EOI（过得了 stripImageMetadata 的结构检查；不是真照片） */
const JFIF = hex('ffe0 0010 4a46494600 0101 00 0001 0001 0000');
const SCAN = hex('ffda 0008 01 01 00 00 3f 00 a1b2c3');
const JPEG = Buffer.concat([hex('ffd8'), JFIF, SCAN, hex('ffd9')]);
const item = (over: Partial<AttachmentItem> = {}): AttachmentItem => {
  const bytes = over.bytes === undefined ? new Uint8Array(JPEG) : over.bytes;
  return {
    id: attId(),
    channel: 'wecom',
    sourceKey: randomBytes(8).toString('hex'),
    cls: 'image',
    mime: 'image/jpeg',
    name: null,
    size: bytes?.byteLength ?? 10,
    sha256: 'synthetic',
    bytes,
    intakeId: null,
    result: null,
    createdAt: Date.now(),
    ...over,
  };
};
const same = (a: Uint8Array | Buffer | null | undefined, b: Uint8Array | Buffer): boolean =>
  !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const disposition = (h: Record<string, string>): string => h['content-disposition']!;
/** jsonb 取回来的键序不保证：按键名排序后再比 */
const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a, Object.keys(a as object).sort()) === JSON.stringify(b, Object.keys(b as object).sort());
/** filename*=UTF-8''… 解出来的文件名 */
const starName = (h: Record<string, string> | string): string => {
  const v = typeof h === 'string' ? h : disposition(h);
  return decodeURIComponent(/filename\*=UTF-8''([^;]+)$/.exec(v)![1]!);
};

// ---------------- 第一段：响应头与文件名 ----------------
{
  const row = (over: Partial<{ id: string; mime: string; name: string | null }> = {}) => ({
    id: 'att_0123456789abcdef01234567',
    mime: 'image/jpeg',
    name: null as string | null,
    ...over,
  });
  const allowed = ['image/jpeg', 'image/png', XLSX, 'text/csv', 'application/octet-stream'];
  check(
    '类型白名单：JPEG、PNG、XLSX、CSV、octet-stream 原样给',
    allowed.every((m) => attachmentHeaders(row({ mime: m }))['content-type'] === m),
  );
  const outside = [
    'text/html',
    'image/svg+xml',
    'application/pdf',
    'application/vnd.ms-excel',
    'text/csv; charset=utf-8',
    'IMAGE/JPEG',
    '',
  ];
  check(
    '类型白名单：其余一律 application/octet-stream（html、svg、pdf、旧版 xls、带参数或大小写不同的写法也不放行）',
    outside.every((m) => attachmentHeaders(row({ mime: m }))['content-type'] === 'application/octet-stream'),
  );
  const h = attachmentHeaders(row({ name: '报价.xlsx', mime: XLSX }));
  check(
    '头：强制 attachment、不缓存、禁止嗅探',
    disposition(h).startsWith('attachment;') && h['cache-control'] === 'no-store' && h['x-content-type-options'] === 'nosniff',
    JSON.stringify(h),
  );
  check(
    "头：文件名按 RFC 5987 编码（filename*=UTF-8''…），兜底名是纯 ASCII",
    starName(h) === '报价.xlsx' && /filename="attachment-[0-9a-f]{6}\.xlsx"/.test(disposition(h)),
  );
  check(
    '没有名字：「附件-<id 后 6 位>.<按类型的扩展名>」',
    [
      [row({ mime: 'image/jpeg' }), '附件-234567.jpg'],
      [row({ mime: 'image/png' }), '附件-234567.png'],
      [row({ mime: XLSX }), '附件-234567.xlsx'],
      [row({ mime: 'text/csv' }), '附件-234567.csv'],
      [row({ mime: 'text/html' }), '附件-234567.bin'],
    ].every(([r, want]) => starName(attachmentHeaders(r as ReturnType<typeof row>)) === want),
  );
  check('名字清完是空的（只有空白、斜杠）也按没有名字处理', starName(attachmentHeaders(row({ name: '  ' }))) === '附件-234567.jpg');
  const tricky = "询价 (1)*'!~.xlsx";
  const enc = /filename\*=UTF-8''([^;]+)$/.exec(disposition(attachmentHeaders(row({ name: tricky }))))![1]!;
  check(
    'RFC 5987：空格、括号、星号、单引号、感叹号都按百分号编码，解回来与原名一致',
    !/[ ()*'!]/.test(enc) && decodeURIComponent(enc) === tricky,
    enc,
  );
  const evil = attachmentHeaders(row({ name: 'a"b\r\nSet-Cookie: x=1\u0000\t/../..\\evil.html' }));
  check(
    '头注入：回车换行、引号、控制字符、路径分隔符进不了头，只有一个 content-disposition，名字里换成下划线',
    !/[\r\n]/.test(disposition(evil)) &&
      Object.keys(evil).length === 4 &&
      starName(evil) === 'a"b__Set-Cookie: x=1___.._..\\evil.html'.replaceAll('\\', '_') &&
      disposition(evil).split('filename*').length === 2,
    JSON.stringify(evil),
  );
  const lone = `坏${String.fromCharCode(0xd800)}名.jpg`;
  let threw = false;
  let loneName = '';
  try {
    loneName = starName(attachmentHeaders(row({ name: lone })));
  } catch {
    threw = true;
  }
  check('孤立的代理项（encodeURIComponent 会抛 URIError）不让响应出错，换成下划线', !threw && loneName === '坏_名.jpg', loneName);
  const long = starName(attachmentHeaders(row({ name: '长'.repeat(500) })));
  check('文件名最多 200 个字符', [...long].length === 200);
  check(
    '附件 id 的形状：att_ 加 24 位小写十六进制，其余（大写、路径、过短、过长、空）都不是',
    isAttachmentId('att_0123456789abcdef01234567') &&
      ![
        '',
        'att_',
        'att_0123',
        'ATT_0123456789abcdef01234567',
        'att_0123456789ABCDEF01234567',
        '../att_0123456789abcdef01234567',
        'att_0123456789abcdef012345678',
      ].some(isAttachmentId),
  );
}

// ---------------- 第二段：downloadAttachment（读原件加写审计） ----------------
interface CoreEnv {
  label: string;
  tenantId: string;
  /** 超级用户发 SQL（建租户、会话、触发器、读审计） */
  su<R = Record<string, any>>(text: string, params?: unknown[]): Promise<R[]>;
  /** 以应用角色（agent_app、FORCE RLS）在某个租户下开事务 */
  tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}
async function coreSuite(env: CoreEnv): Promise<void> {
  const { label, su, tenantId } = env;
  const conv = (tenant: string, id: string) =>
    su(
      "insert into conversations (tenant_id,id,channel,stage,handed_over,state,created_at,updated_at) values ($1,$2,'wecom','greeting',false,json_build_object('id',$2::text),now(),now())",
      [tenant, id],
    );
  const auditRows = () =>
    su<{ action: string; target_type: string; target_id: string; diff: Record<string, unknown> }>(
      "select action,target_type,target_id,diff from audit_log where action = 'attachment.download' order by id",
    );
  const [other] = await su<{ id: string }>("insert into tenants (slug,name,pack_id) values ($1,'别的租户','travel') returning id", [
    `att-other-${randomBytes(3).toString('hex')}`,
  ]);
  const a = `core-a-${label}`;
  const b = `core-b-${label}`;
  await conv(tenantId, a);
  await conv(tenantId, b);
  const png = item({ mime: 'image/png', name: '图 (1).png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]) });
  const noBytes = item({ bytes: null, size: 99 });
  const inB = item();
  await env.tx(tenantId, (tx) => insertAttachments(tx, a, [png, noBytes]));
  await env.tx(tenantId, (tx) => insertAttachments(tx, b, [inB]));
  const down = (conversationId: string, id: string, tenant = tenantId) =>
    env.tx(tenant, (tx) => downloadAttachment(tx, conversationId, id, 'db'));

  const before = (await auditRows()).length;
  const ok = await down(a, png.id);
  check(
    `${label}：属于这个会话且有原件：字节原样、类型在白名单里、文件名按原名`,
    !!ok && same(ok.bytes, png.bytes!) && ok.headers['content-type'] === 'image/png' && starName(ok.headers) === '图 (1).png',
  );
  const rows = await auditRows();
  check(
    `${label}：同一次调用写了恰好一行审计，diff 只有附件 id、类别、大小（不含文件名与内容），target 是附件`,
    rows.length === before + 1 &&
      rows.at(-1)!.target_type === 'attachment' &&
      rows.at(-1)!.target_id === png.id &&
      sameJson(rows.at(-1)!.diff, { id: png.id, cls: 'image', size: png.bytes!.byteLength }) &&
      !JSON.stringify(rows.at(-1)!.diff).includes('图'),
    JSON.stringify(rows.at(-1)),
  );
  const misses = [
    await down(a, noBytes.id), // 库里没有原件（超日上限、30 天后清掉都是这种行）
    await down(a, inB.id), // 别的会话的附件
    await down(b, png.id), // 反过来
    await down(a, attId()), // 不存在
    await down(a, 'att_xyz'), // 形状不合格：不查库
    await down(a, "att_0123456789abcdef01234567' or 1=1 --"),
    await down(a, png.id, other!.id), // 别的租户：RLS 看不到这一行
  ];
  check(
    `${label}：没有原件、别的会话、不存在、id 不合格、别的租户：都是 null`,
    misses.every((m) => m === null),
    misses.map((m) => (m ? 'x' : '-')).join(''),
  );
  check(`${label}：这些情况都没写审计`, (await auditRows()).length === before + 1);

  // 文件后端的行（demo 类会话、文件存储）由调用者事务外先读好交进来；归属、字节的检查和库里的一样，审计仍写进这个事务
  const fileRow = {
    id: attId(),
    conversationId: a,
    cls: 'image',
    mime: 'image/jpeg',
    name: null,
    size: JPEG.length,
    bytes: new Uint8Array(JPEG),
  };
  const fromFile = (row: unknown) =>
    env.tx(tenantId, (tx) => downloadAttachment(tx, a, (row as { id?: string } | null)?.id ?? attId(), row as never));
  const viaFile = await fromFile(fileRow);
  const fileMisses = [
    await fromFile(null),
    await fromFile({ ...fileRow, conversationId: b }),
    await fromFile({ ...fileRow, bytes: null }),
    await env.tx(tenantId, (tx) => downloadAttachment(tx, a, attId(), fileRow as never)), // 行的 id 与请求的不一致
  ];
  check(
    `${label}：文件后端的行：属于这个会话且有字节就给，并写一行审计；没有行、别的会话、没有字节、id 对不上都是 null`,
    !!viaFile &&
      same(viaFile.bytes, JPEG) &&
      viaFile.headers['content-type'] === 'image/jpeg' &&
      fileMisses.every((m) => m === null) &&
      (await auditRows()).length === before + 2,
    `${(await auditRows()).length - before}`,
  );

  // 审计写不进去：整个事务回滚，调用方拿不到文件
  await su(
    "create function att_audit_down() returns trigger language plpgsql as $$ begin raise exception 'audit down' using errcode = '53100'; end $$",
  );
  await su(
    "create trigger att_audit_down before insert on audit_log for each row when (new.action = 'attachment.download') execute function att_audit_down()",
  );
  let refused = false;
  let leaked: unknown = null;
  try {
    leaked = await down(a, png.id);
  } catch {
    refused = true;
  }
  check(
    `${label}：审计写不进去：调用抛错、没有返回文件、不留审计行`,
    refused && leaked === null && (await auditRows()).length === before + 2,
  );
  await su('drop trigger att_audit_down on audit_log');
  await su('drop function att_audit_down()');
  check(
    `${label}：审计恢复后同一份附件又能下载，多一行审计`,
    (await down(a, png.id)) !== null && (await auditRows()).length === before + 3,
  );
  console.log(`${label}: downloadAttachment 读原件加审计 PASS`);
}

// ---------------- 第三段：接口（PGlite 上的 db 会话存储，走 server.ts） ----------------
let realPgRan = false;
{
  const t = await openTestDb();
  await installSeededConfig(t); // 建 demo 租户、导入 data/、装成 DB 配置源；之后这条连接是 agent_app
  const accounts = await withoutTenantScope(() => import('../auth/accounts.js'));
  const authSession = await withoutTenantScope(() => import('../auth/session.js'));
  const roles = ['owner', 'admin', 'supervisor', 'agent', 'viewer'] as const;
  type RoleName = (typeof roles)[number];
  for (const role of roles) {
    await t.pg.exec('SET ROLE agent_platform');
    try {
      const r = await accounts.createUser(t.db, {
        tenantSlug: 'demo',
        email: `${role}-attdl@example.com`,
        name: `${role}成员`,
        role,
        password: async () => `${role}-attdl-password`,
      });
      if (r.code !== 0) throw new Error(r.message);
    } finally {
      await t.pg.exec('SET ROLE agent_app');
    }
  }
  const fx = await installPgSessionStore(t, { varDir: process.env.VAR_DIR! });
  const store = await withoutTenantScope(() => import('../store.js'));
  await store.initSessionStore(fx.deps);
  const { app } = await withoutTenantScope(() => import('../server.js'));
  const { describeAudit } = await import('../shared/audit-text.js');
  const { packById } = await import('../packs/registry.js');
  check('装配：会话存储是 db', store.sessionStoreMode() === 'db');

  const su = <R = Record<string, any>>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows as R[];
    });
  const tenantId = fx.deps.tenantId;
  const sysCtx = (tenant: string) => ({ tenantId: tenant, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });

  // 第二段在 PGlite 上跑一遍（真实 PG 在最后）
  await coreSuite({ label: 'PGlite', tenantId, su, tx: (tenant, fn) => withTenant(fx.deps.db, sysCtx(tenant), fn) });

  interface W {
    token: string;
    csrf: string;
  }
  let ipN = 0;
  const login = async (role: RoleName): Promise<W> => {
    ipN += 1;
    const body = JSON.stringify({ email: `${role}-attdl@example.com`, password: `${role}-attdl-password` });
    const res = await app.request('/api/console/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-forwarded-for': `203.0.113.${100 + ipN}`,
      },
      body,
    });
    const me = (await res.json()) as { csrf: string };
    const token = new RegExp(`^${authSession.SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    return { token, csrf: me.csrf };
  };
  const who = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await login(r)] as const))) as Record<RoleName, W>;
  interface Res {
    status: number;
    body: Record<string, any>;
    text: string;
    bytes: Buffer;
    headers: Headers;
  }
  const get = async (url: string, as: W | null, extra: Record<string, string> = {}): Promise<Res> => {
    const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.250', ...extra };
    if (as) headers.cookie = `${authSession.SESSION_COOKIE}=${as.token}`;
    const res = await app.request(`/api/console${url}`, { headers });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      /* 不是 JSON */
    }
    return { status: res.status, body, text, bytes, headers: res.headers };
  };
  const enc = encodeURIComponent;
  const auditRows = () =>
    su<{
      action: string;
      target_type: string;
      target_id: string;
      diff: Record<string, unknown>;
      actor_user_id: string | null;
      actor_name: string | null;
    }>("select action,target_type,target_id,diff,actor_user_id,actor_name from audit_log where action = 'attachment.download' order by id");

  // ---- 造数据：会话 S1 有六份附件、S2 有一份；demo 类会话 SD（附件在文件后端）有一份 ----
  const S1 = 'wecom:wmAttDl1';
  const S2 = 'wecom:wmAttDl2';
  const SD = 'wecom:cust_attdl';
  const PHONE = '13812345678';
  // 带 Exif（含 GPS 字样）的 JPEG：去元数据以后应当恰好等于 JPEG
  const EXIF_JPEG = Buffer.concat([hex('ffd8'), JFIF, hex('ffe1 000e'), Buffer.from('Exif\0\0GPSDAT'), SCAN, hex('ffd9')]);
  const stripped = stripImageMetadata(EXIF_JPEG);
  const photo = stripped.ok ? Buffer.from(stripped.bytes) : Buffer.alloc(0);
  const csvBytes = Buffer.from('型号,数量\n6205,10\n');
  const xlsxBytes = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 255, 0, 128]);
  const items = {
    img: item({ bytes: new Uint8Array(photo), size: photo.length }),
    xls: item({ cls: 'sheet', mime: XLSX, name: "询价单 (终版)*'!.xlsx", bytes: new Uint8Array(xlsxBytes), size: xlsxBytes.length }),
    csv: item({
      cls: 'sheet',
      mime: 'text/csv',
      name: `rfq-${PHONE}.csv`,
      bytes: new Uint8Array(csvBytes),
      size: csvBytes.length,
    }),
    evil: item({
      cls: 'other',
      mime: 'text/html',
      name: 'a"b\r\nSet-Cookie: x=1/../evil.html',
      bytes: new Uint8Array(Buffer.from('<script>1</script>')),
      size: 18,
    }),
    none: item({ bytes: null, size: 4096, sourceKey: 'over-daily-cap' }),
    old: item({ createdAt: Date.now() - 40 * 86400000, name: '三十天前.jpg' }),
    other: item({ name: '别人的.jpg' }),
    demo: item({ name: 'demo.jpg' }),
  };
  check(
    '夹具：照片已去掉 EXIF（stripImageMetadata 在写入口做，下载只原样交还）',
    stripped.ok && same(photo, JPEG) && !photo.includes(Buffer.from('Exif')) && !photo.includes(Buffer.from('GPSDAT')),
  );
  const ref = (it: AttachmentItem, name = it.name) => ({
    id: it.id,
    cls: it.cls,
    name,
    mime: it.mime,
    size: it.size,
    stored: true, // 消息上的值是排队时的判断：这里故意都写 true，界面以库里附件行为准
  });
  const s1 = store.getOrCreateSession(S1, 'wecom');
  const order = ['img', 'xls', 'csv', 'evil', 'none', 'old'] as const;
  s1.messages.push({ role: 'customer', content: '你好，附件如下', at: Date.now() });
  for (const k of order) s1.messages.push({ role: 'customer', content: `[附件:${k}]`, at: Date.now(), attachment: ref(items[k]) });
  s1.messages.push({ role: 'agent', content: '收到，我看一下。', at: Date.now() });
  store.saveSession(s1);
  for (const k of order) store.queueAttachment(S1, items[k]);
  const s2 = store.getOrCreateSession(S2, 'wecom');
  s2.messages.push({ role: 'customer', content: '[图片]', at: Date.now(), attachment: ref(items.other) });
  store.saveSession(s2);
  store.queueAttachment(S2, items.other);
  await store.flushSession(S1);
  await store.flushSession(S2);
  check(
    '夹具：「30 天前」的那份经 purge_attachment_bytes 清掉字节，其余不受影响',
    (await withTenant(fx.deps.db, sysCtx(tenantId), (tx) => purgeAttachmentBytes(tx, new Date()))) === 1,
  );
  const sd = store.getOrCreateSession(SD, 'wecom');
  sd.messages.push({ role: 'customer', content: '[图片]', at: Date.now(), attachment: ref(items.demo) });
  store.saveSession(sd);
  store.queueAttachment(SD, items.demo);
  await store.flushSession(SD);
  const sim = store.getOrCreateSession('sim-attdl', 'simulator');
  sim.messages.push({ role: 'customer', content: '[图片]', at: Date.now() });
  store.saveSession(sim);

  const url = (conv: string, id: string): string => `/conversations/${enc(conv)}/attachments/${id}`;

  // ---- 权限：能处理会话的四种角色 200，只读成员 403，匿名 401；被拒的不写审计 ----
  {
    const cells: string[] = [];
    const before = (await auditRows()).length;
    for (const role of roles) {
      const r = await get(url(S1, items.img.id), who[role]);
      const want = role !== 'viewer';
      if (want ? r.status !== 200 || !same(r.bytes, photo) : !(r.status === 403 && r.body.error === 'forbidden' && r.bytes.length < 200))
        cells.push(`${role} → ${r.status}`);
    }
    const anon = await get(url(S1, items.img.id), null);
    if (anon.status !== 401) cells.push(`匿名 → ${anon.status}`);
    check(
      '权限：所有者、管理员、主管、坐席 200 且字节原样；只读成员 403 forbidden（不带文件）；匿名 401',
      cells.length === 0,
      cells.join(' | '),
    );
    const rows = await auditRows();
    check(
      '审计：四次成功各一行（操作者是各自的成员），被拒的两次不写',
      rows.length === before + 4 &&
        ['owner', 'admin', 'supervisor', 'agent'].every(
          (role, i) => rows[before + i]!.actor_name === `${role}成员` && rows[before + i]!.actor_user_id !== null,
        ),
      JSON.stringify(rows.slice(before).map((r) => r.actor_name)),
    );
    check(
      '只读成员读不到：带着查询串、换成别的附件 id 也一样 403',
      (await get(url(S1, items.xls.id), who.viewer)).status === 403 &&
        (await get(`${url(S1, items.img.id)}?x=1`, who.viewer)).status === 403,
    );
  }

  // ---- 响应：类型、强制下载、文件名、字节原样 ----
  {
    const img = await get(url(S1, items.img.id), who.owner);
    check(
      '照片：image/jpeg、attachment、no-store、nosniff，没有名字时「附件-<id 后 6 位>.jpg」，字节与库里存的完全一致（不含 EXIF）',
      img.status === 200 &&
        img.headers.get('content-type') === 'image/jpeg' &&
        img.headers.get('content-disposition')!.startsWith('attachment;') &&
        img.headers.get('cache-control') === 'no-store' &&
        img.headers.get('x-content-type-options') === 'nosniff' &&
        starName(img.headers.get('content-disposition')!) === `附件-${items.img.id.slice(-6)}.jpg` &&
        same(img.bytes, photo) &&
        !img.bytes.includes(Buffer.from('Exif')),
      `${img.status} ${img.headers.get('content-type')} ${img.headers.get('content-disposition')}`,
    );
    const xls = await get(url(S1, items.xls.id), who.admin);
    check(
      'XLSX：白名单类型，中文名带空格、括号、星号、单引号按 RFC 5987 编码，字节原样',
      xls.status === 200 &&
        xls.headers.get('content-type') === XLSX &&
        starName(xls.headers.get('content-disposition')!) === items.xls.name &&
        !/filename\*=UTF-8''[^;]*[ ()*']/.test(xls.headers.get('content-disposition')!) &&
        same(xls.bytes, xlsxBytes),
      xls.headers.get('content-disposition') ?? '',
    );
    const csv = await get(url(S1, items.csv.id), who.agent);
    check('CSV：text/csv，字节原样', csv.status === 200 && csv.headers.get('content-type') === 'text/csv' && same(csv.bytes, csvBytes));
    const evil = await get(url(S1, items.evil.id), who.owner);
    check(
      '库里的类型不在白名单（text/html）、名字里带回车换行和引号：给 octet-stream、强制下载，头里没有换行，名字里的控制字符与斜杠换成下划线',
      evil.status === 200 &&
        evil.headers.get('content-type') === 'application/octet-stream' &&
        evil.headers.get('content-disposition')!.startsWith('attachment;') &&
        !/[\r\n]/.test(evil.headers.get('content-disposition')!) &&
        evil.headers.get('set-cookie') === null &&
        starName(evil.headers.get('content-disposition')!) === 'a"b__Set-Cookie: x=1_.._evil.html',
      `${evil.headers.get('content-type')} ${evil.headers.get('content-disposition')}`,
    );
  }

  // ---- 审计：每次下载一行，内容只有附件 id、类别、大小；审计页读得到、有人话 ----
  {
    const rows = await auditRows();
    const row = rows.find((r) => r.target_id === items.xls.id)!;
    check(
      '审计行：action、target 是附件 id，diff 只有 id、cls、size，不含文件名与内容',
      row.action === 'attachment.download' &&
        row.target_type === 'attachment' &&
        sameJson(row.diff, { id: items.xls.id, cls: 'sheet', size: xlsxBytes.length }) &&
        rows.every((r) => !JSON.stringify(r.diff).includes('询价') && !JSON.stringify(r.diff).includes('Cookie')),
      JSON.stringify(row),
    );
    const page = await get('/audit?actions=attachment.download&limit=50', who.owner);
    const entry = (page.body.items as Record<string, any>[] | undefined)?.[0];
    const sentence = entry ? describeAudit(entry as import('../shared/console-api.js').AuditEntryView, packById('travel')!) : null;
    check(
      '审计页：按 attachment.download 过滤读得到，句子「下载了附件」，分在「会话与订单」',
      page.status === 200 &&
        (page.body.items as unknown[]).length === rows.length &&
        sentence?.text.endsWith('下载了附件') === true &&
        sentence.group === 'conversation',
      `${page.status} ${page.text.slice(0, 200)}`,
    );
  }

  // ---- 不属于这个会话、没有原件、id 不合格：404，不写审计，不给文件 ----
  {
    const before = (await auditRows()).length;
    const cases: [string, Res][] = [
      ['别的会话的附件（S2 的附件从 S1 下）', await get(url(S1, items.other.id), who.owner)],
      ['S1 的附件从 S2 下', await get(url(S2, items.img.id), who.owner)],
      ['消息上写 stored: true，库里这份没有字节（超日上限）', await get(url(S1, items.none.id), who.owner)],
      ['30 天前的那份，字节已清', await get(url(S1, items.old.id), who.owner)],
      ['不存在的附件', await get(url(S1, attId()), who.owner)],
      ['id 不合格', await get(url(S1, 'att_nope'), who.owner)],
      ['id 带路径', await get(url(S1, enc('../../etc/passwd')), who.owner)],
      ['id 大写', await get(url(S1, items.img.id.toUpperCase()), who.owner)],
      ['不存在的会话', await get(url('wecom:wmNoSuchAtt', items.img.id), who.owner)],
      ['sim- 访客会话', await get(url('sim-attdl', items.img.id), who.owner)],
    ];
    check(
      '404：别的会话的附件、没有原件（超上限、30 天后清掉）、不存在、id 不合格、不存在的会话、访客会话；响应里没有文件',
      cases.every(([, r]) => r.status === 404 && r.bytes.length < 300 && !r.bytes.includes(JPEG)),
      cases.map(([n, r]) => `${n}:${r.status}`).join(' | '),
    );
    check('404 不写审计', (await auditRows()).length === before);
  }

  // ---- 跨站：会留审计、给文件的 GET，别的网站把已登录的成员导航过来不给 ----
  {
    const u = url(S1, items.img.id);
    const before = (await auditRows()).length;
    const cross = await get(u, who.owner, { 'sec-fetch-site': 'cross-site' });
    const sameSite = await get(u, who.owner, { 'sec-fetch-site': 'same-site' });
    const blocked = (await auditRows()).length;
    const sameOrigin = await get(u, who.owner, { 'sec-fetch-site': 'same-origin' });
    const typed = await get(u, who.owner, { 'sec-fetch-site': 'none' });
    check(
      '跨站（cross-site、same-site）→ 403 cross_site，不留审计、不给文件；同源和地址栏直接打开（none）照常给',
      cross.status === 403 &&
        cross.body.error === 'cross_site' &&
        sameSite.status === 403 &&
        cross.bytes.length < 200 &&
        blocked === before &&
        sameOrigin.status === 200 &&
        typed.status === 200 &&
        (await auditRows()).length === before + 2,
      [cross.status, sameSite.status, sameOrigin.status, typed.status].join(),
    );
  }

  // ---- 审计写不进就不给文件 ----
  {
    const u = url(S1, items.xls.id);
    const before = (await auditRows()).length;
    await su(
      "create function att_audit_http_down() returns trigger language plpgsql as $$ begin raise exception 'audit down' using errcode = '53100'; end $$",
    );
    await su(
      "create trigger att_audit_http_down before insert on audit_log for each row when (new.action = 'attachment.download') execute function att_audit_http_down()",
    );
    // 接口会把未捕获的异常记一行日志：接住它，核对日志里没有文件名与内容（不变量 5），也不让预期的报错刷屏
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    let r: Res;
    try {
      r = await get(u, who.owner);
    } finally {
      console.error = realError;
    }
    check(
      '审计写不进去：响应不是 200，没有文件、没有下载头，也没有留下审计行',
      r.status >= 500 &&
        r.headers.get('content-disposition') === null &&
        r.headers.get('content-type') !== XLSX &&
        !r.bytes.includes(xlsxBytes) &&
        (await auditRows()).length === before,
      `${r.status} ${r.text.slice(0, 120)}`,
    );
    check(
      '日志：记下了这次失败，但没有文件名、文件内容',
      logged.length > 0 && logged.every((l) => !l.includes('询价单') && !l.includes('终版') && !l.includes(xlsxBytes.toString('latin1'))),
      logged.join(' | ').slice(0, 200),
    );
    await su('drop trigger att_audit_http_down on audit_log');
    await su('drop function att_audit_http_down()');
    const again = await get(u, who.owner);
    check('审计恢复后又能下载，多一行审计', again.status === 200 && (await auditRows()).length === before + 1);
  }

  // ---- MessageView.attachment：stored 以库里的附件行为准 ----
  {
    const viewOf = (r: Res): Map<string, Record<string, any>> =>
      new Map(
        (r.body.messages as Record<string, any>[])
          .filter((m) => m.attachment)
          .map((m) => [m.attachment.id as string, m.attachment as Record<string, any>]),
      );
    const owner = viewOf(await get(`/conversations/${enc(S1)}`, who.owner));
    check(
      'stored：有字节的是 true；消息上写 true 但库里没字节（超日上限）、30 天后清掉的是 false',
      owner.get(items.img.id)?.stored === true &&
        owner.get(items.xls.id)?.stored === true &&
        owner.get(items.csv.id)?.stored === true &&
        owner.get(items.evil.id)?.stored === true &&
        owner.get(items.none.id)?.stored === false &&
        owner.get(items.old.id)?.stored === false &&
        owner.size === 6,
      JSON.stringify([...owner.values()].map((a) => [a.id.slice(-4), a.stored])),
    );
    const csvView = owner.get(items.csv.id)!;
    check(
      '附件字段：id、类别、名称、大小；不带 mime、字节、识别结果',
      JSON.stringify(Object.keys(csvView).sort()) === JSON.stringify(['cls', 'id', 'name', 'size', 'stored']) &&
        csvView.cls === 'sheet' &&
        csvView.name === `rfq-${PHONE}.csv` &&
        csvView.size === csvBytes.length,
      JSON.stringify(csvView),
    );
    const viewer = viewOf(await get(`/conversations/${enc(S1)}`, who.viewer));
    check(
      '只读成员：文件名里的手机号按正文同一口径打码（只留后 4 位），没有名字的还是 null；stored 与成员无关',
      viewer.get(items.csv.id)?.name === 'rfq-*******5678.csv' &&
        viewer.get(items.img.id)?.name === null &&
        viewer.get(items.none.id)?.stored === false &&
        viewer.get(items.img.id)?.stored === true,
      JSON.stringify([...viewer.values()].map((a) => a.name)),
    );
    const detail = await get(`/conversations/${enc(S1)}`, who.owner);
    const msgs = detail.body.messages as Record<string, any>[];
    check(
      '没带附件的消息（客户的文字、AI 回复）没有 attachment 键',
      msgs.filter((m) => !m.attachment).length === 2 && msgs.every((m) => !m.attachment || m.role === 'customer'),
    );
    const earlier = await get(`/conversations/${enc(S1)}/messages?beforeSeq=1000`, who.owner);
    const earlierViewer = await get(`/conversations/${enc(S1)}/messages?beforeSeq=1000`, who.viewer);
    const eo = viewOf(earlier);
    check(
      '更早的消息（翻页读库）同样带 attachment，stored 以库里为准，只读成员的名字打码',
      earlier.status === 200 &&
        eo.size === 6 &&
        eo.get(items.img.id)?.stored === true &&
        eo.get(items.none.id)?.stored === false &&
        eo.get(items.old.id)?.stored === false &&
        viewOf(earlierViewer).get(items.csv.id)?.name === 'rfq-*******5678.csv',
      `${earlier.status} ${earlier.text.slice(0, 160)}`,
    );
  }

  // ---- demo 类会话：附件在文件后端，不在库里；下载仍然写审计（审计在库里） ----
  {
    const before = (await auditRows()).length;
    const view = (await get(`/conversations/${enc(SD)}`, who.owner)).body.messages as Record<string, any>[];
    const r = await get(url(SD, items.demo.id), who.agent);
    check(
      'demo 类会话：stored 取文件后端的元数据，下载给字节并写一行审计；库里没有这份附件',
      view.find((m) => m.attachment)?.attachment.stored === true &&
        r.status === 200 &&
        same(r.bytes, JPEG) &&
        (await auditRows()).length === before + 1 &&
        (await su('select id from attachments where id = $1', [items.demo.id])).length === 0,
      `${r.status}`,
    );
    check('demo 类会话：别的会话的附件从这里下也是 404', (await get(url(SD, items.img.id), who.owner)).status === 404);
  }

  // ---- 没有附件的会话：详情里没有 attachment ----
  {
    const plain = store.getOrCreateSession('wecom:wmAttPlain', 'wecom');
    plain.messages.push({ role: 'customer', content: '随便问问', at: Date.now() });
    store.saveSession(plain);
    await store.flushSession('wecom:wmAttPlain');
    const r = await get(`/conversations/${enc('wecom:wmAttPlain')}`, who.owner);
    check(
      '没有附件的会话：详情 200，消息里没有 attachment',
      r.status === 200 && !(r.body.messages as Record<string, any>[]).some((m) => 'attachment' in m),
    );
  }

  // ---- 真实 PG：同一份 downloadAttachment 断言 ----
  if (process.env.PG_TEST_URL) {
    const real = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'att-dl' });
    try {
      const conn = await openDb(real.urls.app, { max: 1 });
      await coreSuite({
        label: '真实 PG',
        tenantId: real.tenantId,
        su: (text, params) => real.query(text, params),
        tx: (tenant, fn) => withTenant(conn.db, sysCtx(tenant), fn),
      });
      await conn.close();
      realPgRan = true;
    } finally {
      await real.drop();
    }
  }

  await t.close();
}

if (fails.length) {
  console.error(`ATTACHMENT DOWNLOAD SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(`ATTACHMENT DOWNLOAD SELFTEST PASS: ${pass} 项断言全通${realPgRan ? '（含真实 PG）' : '；真实 PG 部分未跑'}`);
process.exit(0);
