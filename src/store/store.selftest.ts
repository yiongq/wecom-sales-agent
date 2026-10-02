// 会话存储自测（docs/architecture/02-conversations-workbench/spec.md「测试与 CI」）。
// 本组目前是文件后端的部分（plan 第 2 步）：seq 的两种分配模式、flushSession 等到落盘、事件在落盘之后、
// SESSION_STORE 的非法组合与 boot() 的失败分支、标记文件、三段停机的顺序与时限、导入期行为与模式无关。
// PGlite 与真实 Postgres 的部分在第 5、6 步加。
// 用法：npx tsx src/store/store.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatMessage, Order, Session } from '../types.js';

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-store-selftest-'));
process.env.VAR_DIR = VAR_DIR;
process.env.CONFIG_SOURCE = 'file';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const msg = (role: ChatMessage['role'], content: string, at = Date.now()): ChatMessage => ({ role, content, at });
const session = (id: string, messages: ChatMessage[], channel = 'wecom'): Session => ({
  id,
  channel,
  stage: 'greeting',
  profile: {},
  messages,
  orderIds: [],
  handedOver: false,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
});

// ---------------- seq：两种分配模式（纯函数） ----------------
{
  const { assignSeqs, seedSeqs, seqOf, lastSeqOf, windowStartOf, noteWindowReset, WindowCorruptError } = await import('./seq.js');
  const seqsOf = (s: Session) => s.messages.map((m) => seqOf(m) ?? null);
  const throws = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof WindowCorruptError ? e.detail : `别的错误：${String(e)}`;
    }
  };

  const a = session('wecom:seq-a', [msg('customer', '1'), msg('agent', '2'), msg('customer', '3')]);
  const fresh = assignSeqs(a, 'strict');
  check('seq：从 1 起依次分配，返回新分配的消息', fresh.length === 3 && seqsOf(a).join() === '1,2,3', seqsOf(a).join());
  check('seq：幂等，没有新消息时什么都不分配', assignSeqs(a, 'strict').length === 0 && seqsOf(a).join() === '1,2,3');
  a.messages.push(msg('agent', '4'), msg('customer', '5'));
  assignSeqs(a, 'strict');
  check('seq：追加的接着分配', seqsOf(a).join() === '1,2,3,4,5' && lastSeqOf(a) === 5 && windowStartOf(a) === 1);
  check('seq：不往消息对象上加字段', Object.keys(a.messages[0]).join() === 'role,content,at');

  a.messages.splice(0, 2); // 裁剪：从头部截掉
  a.messages.push(msg('agent', '6'));
  check('seq 严格模式：头部裁剪照常，只推进窗口起点', throws(() => assignSeqs(a, 'strict')) === null);
  check('seq 严格模式：裁剪之后的窗口', seqsOf(a).join() === '3,4,5,6' && windowStartOf(a) === 3 && lastSeqOf(a) === 6);

  const b = session('wecom:seq-b', [msg('customer', '1'), msg('agent', '2'), msg('customer', '3'), msg('agent', '4')]);
  assignSeqs(b, 'strict');
  b.messages.splice(1, 1); // 中间删一条
  check('seq 严格模式：中间删除抛 WindowCorruptError', /中间删除/.test(throws(() => assignSeqs(b, 'strict')) ?? ''));
  b.messages.push(msg('agent', 'x'));
  check('seq 严格模式：抛出之后不给新消息分配', seqOf(b.messages.at(-1)!) === undefined && lastSeqOf(b) === 4);

  const c = session('wecom:seq-c', [msg('customer', '你好'), msg('agent', '您好'), msg('customer', '想去云南')]);
  assignSeqs(c, 'strict');
  const last = c.messages.at(-1)!;
  c.messages.splice(c.messages.lastIndexOf(last), 1); // 企微重放今天的写法：删掉末尾这句，再交给引擎重新 push
  c.messages.push(msg('customer', '想去云南'));
  check('seq 严格模式：末尾删除再追加抛错（库里会多一条同样的话）', /末尾/.test(throws(() => assignSeqs(c, 'strict')) ?? ''));

  const d = session('wecom:seq-d', [msg('customer', '1'), msg('agent', '2')]);
  assignSeqs(d, 'strict');
  d.messages.splice(1, 0, msg('system', '插进来的'));
  check('seq 严格模式：中间插入抛错', /排在没分配过的消息后面/.test(throws(() => assignSeqs(d, 'strict')) ?? ''));

  const e = session('wecom:seq-e', [msg('customer', '1'), msg('agent', '2')]);
  assignSeqs(e, 'strict');
  e.messages = e.messages.map((m) => ({ ...m }));
  check('seq 严格模式：整体换成副本抛错', /全不见了/.test(throws(() => assignSeqs(e, 'strict')) ?? ''));

  const f = session('wecom:seq-f', [msg('customer', '1'), msg('agent', '2'), msg('customer', '重置')]);
  assignSeqs(f, 'strict');
  noteWindowReset(f);
  f.messages = [msg('agent', '已为您重置')];
  check('seq 严格模式：先 noteWindowReset 的重置照常', throws(() => assignSeqs(f, 'strict')) === null);
  check('seq 严格模式：重置推进窗口到重置回复那一条', seqsOf(f).join() === '4' && windowStartOf(f) === 4 && lastSeqOf(f) === 4);
  f.messages = [msg('agent', '又一次')];
  check('seq 严格模式：noteWindowReset 只管下一次', /全不见了/.test(throws(() => assignSeqs(f, 'strict')) ?? ''));

  const g = session('wecom:seq-g', [msg('customer', '1'), msg('agent', '2'), msg('customer', '3')]);
  assignSeqs(g, 'strict');
  const trimmed = g.messages.splice(0, 1);
  assignSeqs(g, 'strict');
  g.messages.unshift(...trimmed); // 裁掉的旧消息又塞回来：窗口起点后退
  check('seq 严格模式：窗口起点后退抛错', /退回/.test(throws(() => assignSeqs(g, 'strict')) ?? ''));

  const h = session('wecom:seq-h', [msg('customer', '1'), msg('agent', '2')]);
  assignSeqs(h, 'lenient');
  h.messages.splice(0, 2, msg('customer', 'x'));
  h.messages = h.messages.map((m) => ({ ...m }));
  h.messages.push(msg('agent', 'y'));
  check('seq 宽松模式：错位不抛，只给尾部没 seq 的分配', throws(() => assignSeqs(h, 'lenient')) === null && seqsOf(h).join() === '3,4');
  const h2 = session('wecom:seq-h2', [msg('customer', '1'), msg('agent', '2'), msg('customer', '3')]);
  assignSeqs(h2, 'lenient');
  h2.messages.splice(1, 1);
  h2.messages.push(msg('agent', '4'));
  check(
    'seq 宽松模式：中间删除也不抛，新消息接着最大 seq',
    throws(() => assignSeqs(h2, 'lenient')) === null && seqsOf(h2).join() === '1,3,4',
  );
  const h3 = session('wecom:seq-h3', [msg('customer', '1')]);
  assignSeqs(h3, 'lenient');
  h3.messages = [];
  h3.messages.push(msg('agent', '重置'));
  assignSeqs(h3, 'lenient');
  check('seq 宽松模式：不调 noteWindowReset 的重置照常，接着最大 seq', seqsOf(h3).join() === '2');
  const h4 = session('wecom:seq-h4', [msg('customer', '1'), msg('agent', '2')]);
  assignSeqs(h4, 'lenient');
  h4.messages.splice(1, 0, msg('system', '插进来的'));
  h4.messages.push(msg('customer', '3'));
  assignSeqs(h4, 'lenient');
  check('seq 宽松模式：中间插入的不分配，已有的号不变，尾部接着分配', seqsOf(h4).join() === '1,,2,3', seqsOf(h4).join());

  // 旧数据可能是畸形的：没有 messages、数组里有 null。开工时这类会话碰到才出错，不能让 store 在导入期就崩
  const bad = { ...session('wecom:seq-bad', []), messages: undefined } as unknown as Session;
  check(
    'seq：没有 messages 的会话不抛，什么都不分配',
    throws(() => assignSeqs(bad, 'lenient')) === null && throws(() => seedSeqs(bad, 1)) === null,
  );
  const holes = session('wecom:seq-holes', [msg('customer', 'a'), null as unknown as ChatMessage, msg('agent', 'b')]);
  check('seq：消息数组里的 null 被跳过，不抛', throws(() => seedSeqs(holes, 1)) === null && seqOf(holes.messages[2]) === 2);
  holes.messages.push(null as unknown as ChatMessage, msg('customer', 'c'));
  check('seq：宽松分配跳过 null', throws(() => assignSeqs(holes, 'lenient')) === null && seqOf(holes.messages[4]) === 3);

  const i = session('wecom:seq-i', [msg('customer', 'a'), msg('agent', 'b'), msg('customer', 'c')]);
  seedSeqs(i, 11);
  check('seq：装载时按库里的窗口起点记 seq', seqsOf(i).join() === '11,12,13' && lastSeqOf(i) === 13 && windowStartOf(i) === 11);
  i.messages.push(msg('agent', 'd'));
  assignSeqs(i, 'strict');
  check('seq：装载之后接着分配', seqOf(i.messages.at(-1)!) === 14);
  const j = session('wecom:seq-j', []);
  seedSeqs(j, 11);
  check('seq：空窗口装载，最大 seq 是起点减 1', lastSeqOf(j) === 10 && windowStartOf(j) === 11);
  j.messages.push(msg('customer', 'x'));
  check('seq：空窗口之后的第一条', throws(() => assignSeqs(j, 'strict')) === null && seqsOf(j).join() === '11');
  let rangeErr = false;
  try {
    seedSeqs(j, 0);
  } catch (err) {
    rangeErr = err instanceof RangeError;
  }
  check('seq：起点不是正整数时拒绝', rangeErr);
}

// ---------------- 文件后端：导入期读 JSON、seq、flushSession、事件 ----------------
const SESSIONS_FILE = path.join(VAR_DIR, 'sessions.json');
const ORDERS_FILE = path.join(VAR_DIR, 'orders.json');
const fixtureSessions = (): Session[] => [
  session('wecom:u1', [msg('customer', '你好', 1), msg('agent', '您好', 2), msg('customer', '想去云南', 3)]),
  session('wecom:cust_A01', [msg('customer', '种子', 1)]),
  session('sim-abcdefghijklmnop', [msg('customer', '访客', 1)], 'simulator'),
];
const fixtureOrders = (): Order[] => [
  {
    id: 'ord_fixture1',
    sessionId: 'wecom:u1',
    routeId: 'r-yunnan-mid',
    routeTitle: '云南',
    travelers: 2,
    departDate: '2026-11-01',
    totalPrice: 2000,
    status: 'pending_payment',
    createdAt: 1,
  } as Order,
];
fs.writeFileSync(SESSIONS_FILE, JSON.stringify(fixtureSessions(), null, 2));
fs.writeFileSync(ORDERS_FILE, JSON.stringify(fixtureOrders(), null, 2));

const store = await import('../store.js');
const shutdown = await import('../shutdown.js');
const { SessionStoreStartupError, StoreLaggingError } = await import('./backend.js');
// store 的 exit 钩子可能在最后再写一次 JSON：清理排在它之后（exit 监听按注册顺序执行），中途抛错也照样清
process.on('exit', () => fs.rmSync(VAR_DIR, { recursive: true, force: true }));
const readDisk = (): Session[] => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Session[];
const onDisk = (id: string): Session | undefined => readDisk().find((s) => s.id === id);

{
  const u1 = store.getSession('wecom:u1')!;
  check('文件存储：导入期读进 JSON', !!u1 && !!store.getSession('wecom:cust_A01') && !!store.getOrder('ord_fixture1'));
  check('文件存储：读 JSON 时按条数记 seq', u1.messages.map((m) => store.seqOf(m)).join() === '1,2,3');
  check('文件存储：sessionStoreMode 是 file', store.sessionStoreMode() === 'file');
  check(
    'isDemoClassId：sim- 与 wecom:cust_ 是 demo 类，其余不是',
    store.isDemoClassId('sim-x') &&
      store.isDemoClassId('wecom:cust_B01') &&
      !store.isDemoClassId('wecom:u1') &&
      !store.isDemoClassId('wecom:customer') &&
      !store.isDemoClassId('eval:x') &&
      !store.isDemoClassId('simx'),
  );
  const h = store.storeHealth();
  check(
    'storeHealth：文件存储，只数真实会话，没有积压',
    h.mode === 'file' && h.conversations === 1 && h.dirty === 0 && h.lagMs === 0 && !h.conflict && h.poisoned.length === 0,
    JSON.stringify(h),
  );

  u1.messages.push(msg('agent', '云南有几条线路'));
  store.saveSession(u1);
  check('saveSession 返回时新消息已有 seq', store.seqOf(u1.messages.at(-1)!) === 4);
  check('saveSession 之后落盘还在去抖里', (onDisk('wecom:u1')?.messages.length ?? 0) === 3);
  check('storeHealth：标脏', store.storeHealth().dirty === 1);
  let flushedAt: number | null = null;
  const t0 = Date.now();
  await store.flushSession('wecom:u1').then(() => {
    flushedAt = Date.now();
  });
  check('flushSession 等到落盘才 resolve', (onDisk('wecom:u1')?.messages.length ?? 0) === 4 && flushedAt !== null);
  check('flushSession 等的是那一次去抖落盘（≈200ms）', flushedAt! - t0 >= 150 && flushedAt! - t0 < 2000, `${flushedAt! - t0}ms`);
  check('落盘之后不再积压', store.storeHealth().dirty === 0);
  const t1 = Date.now();
  await store.flushSession('wecom:u1');
  check('没有改动时 flushSession 立即 resolve', Date.now() - t1 < 50);

  // 订阅者先无条件记下收到了什么，再看盘上：落盘失败时盘读不出来，也不能让断言跟着落空
  const got: string[] = [];
  const off = store.onCommitted((ev) => {
    let disk: string;
    try {
      disk = (onDisk(ev.id)?.messages.length ?? 0) > 4 ? '已落盘' : '未落盘';
    } catch {
      disk = '读盘失败';
    }
    got.push(`${ev.type}:${ev.id}:${disk}`);
  });
  u1.messages.push(msg('customer', '要两个人'));
  store.saveSession(u1);
  store.emitAfterCommit('wecom:u1', { type: 'conversation.changed', id: 'wecom:u1' });
  check('事件不在 emitAfterCommit 里同步发出', got.length === 0);
  await store.flushSession('wecom:u1');
  check('事件在落盘之后才发出，发出时改动已在盘上', got.join() === 'conversation.changed:wecom:u1:已落盘', got.join());

  // 落盘失败：sessions.json 换成一个非空目录，rename 失败
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(' '));
  fs.renameSync(SESSIONS_FILE, `${SESSIONS_FILE}.bak`);
  fs.mkdirSync(SESSIONS_FILE);
  fs.writeFileSync(path.join(SESSIONS_FILE, 'blocker'), 'x');
  got.length = 0;
  u1.messages.push(msg('agent', '好的'));
  store.saveSession(u1);
  store.emitAfterCommit('wecom:u1', { type: 'conversation.changed', id: 'wecom:u1' });
  let lagErr: unknown = null;
  const tLag = Date.now();
  await store.flushSession('wecom:u1', { timeoutMs: 600 }).catch((err: unknown) => {
    lagErr = err;
  });
  const lagTook = Date.now() - tLag;
  check('落盘失败：flushSession 超时以 StoreLaggingError reject', lagErr instanceof StoreLaggingError);
  check('落盘失败：按传入的 timeoutMs 超时', lagTook >= 550 && lagTook < 1500, `${lagTook}ms`);
  check('落盘失败：事件不发', got.length === 0, got.join());
  const stuck = await store.drainStore(100);
  check('落盘失败：drainStore 返回没落盘的会话', stuck.undrained.includes('wecom:u1'), JSON.stringify(stuck));
  const failed = store.storeHealth();
  check('落盘失败：storeHealth 报积压与错误码', failed.dirty === 1 && failed.lagMs > 0 && !!failed.lastError, JSON.stringify(failed));
  check(
    '落盘失败：日志照旧一行',
    errs.some((l) => l.includes('[store] 落盘失败')),
  );
  console.error = origErr;
  fs.rmSync(SESSIONS_FILE, { recursive: true });
  fs.renameSync(`${SESSIONS_FILE}.bak`, SESSIONS_FILE);
  // 恢复磁盘、不做新的改动，drain 也要把上次失败留下的写出去
  const healed = await store.drainStore(1000);
  check(
    '恢复之后：drainStore 写出上次失败留下的改动',
    healed.undrained.length === 0 && onDisk('wecom:u1')?.messages.at(-1)?.content === '好的',
  );
  check('恢复之后：排着的事件随下一次成功落盘恰好发出一次', got.join() === 'conversation.changed:wecom:u1:已落盘', got.join());
  check('恢复之后：积压清零', store.storeHealth().dirty === 0);
  off();

  const fresh = store.getOrCreateSession('wecom:u2', 'wecom');
  fresh.messages.push(msg('customer', '在吗'));
  store.saveSession(fresh);
  const drained = await store.drainStore(1000);
  check('drainStore：排空去抖中的改动，没有剩下的', drained.undrained.length === 0 && onDisk('wecom:u2')?.messages.length === 1);
  check('storeHealth：新的真实会话计入', store.storeHealth().conversations === 2);
  u1.messages.push(msg('agent', 'x'));
  store.saveSession(u1);
  store.flushStoreNow();
  check('flushStoreNow 照旧同步落盘', onDisk('wecom:u1')?.messages.at(-1)?.content === 'x');
}

// ---------------- 标记文件与 initSessionStore ----------------
{
  const marker = path.join(VAR_DIR, store.SESSIONS_IN_DB_MARKER);
  let ok = true;
  await store.initSessionStore(null).catch(() => {
    ok = false;
  });
  check('initSessionStore(null)：没有标记文件时 resolve', ok);
  fs.writeFileSync(marker, JSON.stringify({ tenant: 'demo', at: 1, sessions: 3 }));
  let reason = '';
  await store.initSessionStore(null).catch((e: unknown) => {
    reason = e instanceof SessionStoreStartupError ? e.reason : String(e);
  });
  check('initSessionStore(null)：有标记文件时以 sessions_in_db 拒绝', reason === 'sessions_in_db', reason);
  fs.unlinkSync(marker);
  let rejected = false;
  await store.initSessionStore({ db: null as never, tenantId: 't', varDir: VAR_DIR }).catch(() => {
    rejected = true;
  });
  check('initSessionStore(deps)：PG 后端还没有时拒绝，不回落到文件存储', rejected && store.sessionStoreMode() === 'file');
}

// ---------------- SESSION_STORE 的校验（接在 01 的 initConfigFromEnv 上） ----------------
{
  const { initConfigFromEnv, ConfigStartupError } = await import('../config/source.js');
  const tryEnv = async (env: Record<string, string>): Promise<string> => {
    try {
      await initConfigFromEnv(env, () => {});
      return 'ok';
    } catch (e) {
      return e instanceof ConfigStartupError ? `${e.reason}:${e.detail}` : `other:${String(e)}`;
    }
  };
  for (const v of ['postgres', 'DB', 'File', 'pg']) {
    const r = await tryEnv({ SESSION_STORE: v });
    check(`SESSION_STORE=${v} → env_invalid`, r.startsWith('env_invalid:') && r.includes('SESSION_STORE'), r);
  }
  // 线上是 CONFIG_SOURCE=db：非法值同样在装载配置之前拒绝（不会走到 DATABASE_URL 的检查，更不会静默落到文件存储）
  for (const v of ['postgres', 'DB']) {
    const r = await tryEnv({ SESSION_STORE: v, CONFIG_SOURCE: 'db' });
    check(
      `SESSION_STORE=${v} 且 CONFIG_SOURCE=db → env_invalid，排在 DB 依赖之前`,
      r.startsWith('env_invalid:') && r.includes('SESSION_STORE') && !r.includes('DATABASE_URL'),
      r,
    );
  }
  const leaky = await tryEnv({ SESSION_STORE: 'postgres://agent_app:hunter2@db:5432/agent' });
  check('SESSION_STORE 的非法值像连接串时不回显', leaky.startsWith('env_invalid:') && !leaky.includes('hunter2'), leaky);
  const noDb = await tryEnv({ SESSION_STORE: 'db' });
  check('SESSION_STORE=db 而 CONFIG_SOURCE 未设 → env_invalid', noDb.startsWith('env_invalid:') && noDb.includes('CONFIG_SOURCE=db'), noDb);
  const fileCfg = await tryEnv({ SESSION_STORE: 'db', CONFIG_SOURCE: 'file' });
  check('SESSION_STORE=db 而 CONFIG_SOURCE=file → env_invalid', fileCfg.startsWith('env_invalid:') && fileCfg.includes('CONFIG_SOURCE=db'));
  const valid: Record<string, string>[] = [
    {},
    { SESSION_STORE: '' },
    { SESSION_STORE: 'file' },
    { SESSION_STORE: 'file', CONFIG_SOURCE: 'file' },
  ];
  for (const env of valid) {
    check(`SESSION_STORE 合法（${JSON.stringify(env)}）照常装载文件模式`, (await tryEnv(env)) === 'ok');
  }
  const both = await tryEnv({ SESSION_STORE: 'db', CONFIG_SOURCE: 'db' });
  check(
    'SESSION_STORE=db 与 CONFIG_SOURCE=db 过了这道校验（接着因为没有 DATABASE_URL 拒绝）',
    both.startsWith('env_invalid:') && both.includes('DATABASE_URL') && !both.includes('SESSION_STORE'),
    both,
  );
}

// ---------------- boot()：会话存储在配置之后、监听之前 ----------------
{
  const { boot } = await import('../boot.js');
  const run = async (init: { config?: () => Promise<void>; store?: () => Promise<void> }) => {
    const calls: string[] = [];
    const exits: number[] = [];
    const logs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      await boot({
        initConfig: async () => {
          calls.push('config');
          await init.config?.();
        },
        initSessionStore: async () => {
          calls.push('store');
          await init.store?.();
        },
        serve: (onListening) => {
          calls.push('serve');
          onListening();
        },
        preflight: () => void calls.push('preflight'),
        buildIndex: async () => void calls.push('buildIndex'),
        startFollowUpScheduler: () => void calls.push('followup'),
        startWecom: () => void calls.push('startWecom'),
        exit: (c) => void exits.push(c),
      });
    } finally {
      console.error = origErr;
    }
    return { calls: calls.join(','), exits: exits.join(','), log: logs.join('\n') };
  };
  const ok = await run({});
  check(
    'boot：配置 → 会话存储 → 监听 → 预检、索引、跟进、企微',
    ok.calls === 'config,store,serve,preflight,buildIndex,followup,startWecom' && ok.exits === '',
    ok.calls,
  );
  const refused = await run({
    store: async () => {
      throw new SessionStoreStartupError('sessions_in_db', '标记文件在');
    },
  });
  check(
    'boot：会话存储拒绝 → 以 1 退出、打出 reason 与 detail，serve 与企微都没调',
    refused.calls === 'config,store' &&
      refused.exits === '1' &&
      refused.log.includes('（sessions_in_db）') &&
      refused.log.includes('标记文件在'),
    `${refused.calls} ${refused.log}`,
  );
  const crashed = await run({
    store: async () => {
      throw new Error('意外');
    },
  });
  check('boot：会话存储抛别的错 → 同样以 1 退出', crashed.calls === 'config,store' && crashed.exits === '1', crashed.calls);
  const cfgFail = await run({
    config: async () => {
      throw new Error('配置坏了');
    },
  });
  check('boot：配置装载失败时不碰会话存储', cfgFail.calls === 'config' && cfgFail.exits === '1', cfgFail.calls);
  fs.writeFileSync(path.join(VAR_DIR, store.SESSIONS_IN_DB_MARKER), '{}');
  const real = await run({ store: () => store.initSessionStore(null) });
  check(
    'boot：文件存储而 var/ 里有标记文件 → 拒绝启动',
    real.calls === 'config,store' && real.exits === '1' && real.log.includes('（sessions_in_db）'),
  );
  fs.unlinkSync(path.join(VAR_DIR, store.SESSIONS_IN_DB_MARKER));
}

// ---------------- 三段停机：顺序与时限 ----------------
{
  type Mode = 'off' | 'timing' | 'hang-normal' | 'hang-drain' | 'cap';
  let mode: Mode = 'off';
  type Rec = { phase: string; at: number; end: number; deadline: number };
  let recs: Rec[] = [];
  let start = 0;
  const busyWait = (ms: number) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      /* 同步阻塞事件循环 */
    }
  };
  const hook =
    (phase: 'normal' | 'drain' | 'late') =>
    async ({ deadline }: { deadline: number }) => {
      if (mode === 'off') return;
      const rec: Rec = { phase, at: Date.now() - start, end: -1, deadline: deadline - start };
      recs.push(rec);
      if (mode === `hang-${phase}` || (mode === 'cap' && phase !== 'normal')) await new Promise(() => {});
      if (mode === 'cap') {
        await sleep(550);
        busyWait(300); // 跨过 normal 的截止（第 600ms）才放开事件循环
      } else await sleep(phase === 'normal' && mode === 'timing' ? 200 : 10);
      rec.end = Date.now() - start;
    };
  shutdown.onShutdown(hook('late'), { phase: 'late' });
  shutdown.onShutdown(hook('drain'), { phase: 'drain' });
  shutdown.onShutdown(hook('normal'));
  shutdown.onShutdown(async () => {
    if (mode === 'timing') throw new Error('钩子自己出错');
  });
  const run = async (m: Mode): Promise<{ ok: boolean; took: number }> => {
    mode = m;
    recs = [];
    start = Date.now();
    const ok = await shutdown.runShutdownHooks(800);
    return { ok, took: Date.now() - start };
  };

  const origErr = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(' '));
  try {
    const t = await run('timing');
    const [n, dr, l] = recs;
    check('三段停机：依次 normal → drain → late', recs.map((r) => r.phase).join() === 'normal,drain,late', JSON.stringify(recs));
    check('三段停机：后一段在前一段的钩子结束之后才开始', dr.at >= n.end && l.at >= dr.end, JSON.stringify(recs));
    check('三段停机：都按时结束返回 true（出错的钩子只记日志）', t.ok && errs.some((x) => x.includes('钩子自己出错')));
    check('三段停机：normal 的截止是总上限的 6/8，从开始算', Math.abs(n.deadline - 600) <= 10, String(n.deadline));
    check('三段停机：drain 的时限是 1.5/8，从 normal 结束时算', Math.abs(dr.deadline - dr.at - 150) <= 10, `${dr.at} ${dr.deadline}`);
    check('三段停机：late 的时限是 0.5/8，从 drain 结束时算', Math.abs(l.deadline - l.at - 50) <= 10, `${l.at} ${l.deadline}`);

    const hn = await run('hang-normal');
    check('三段停机：normal 卡住 → 返回 false，后两段照样跑', !hn.ok && recs.map((x) => x.phase).join() === 'normal,drain,late');
    check('三段停机：normal 卡住，到第 600ms 才进 drain', hn.took >= 590 && hn.took <= 720, `${hn.took}ms`);
    const hd = await run('hang-drain');
    check('三段停机：drain 卡住 → 返回 false，late 照样跑', !hd.ok && recs.map((x) => x.phase).join() === 'normal,drain,late');
    check('三段停机：drain 卡住只等它自己的 1.5/8', hd.took >= 150 && hd.took <= 320, `${hd.took}ms`);
    check('三段停机：超时的段各有一行日志', errs.some((x) => x.includes('normal 段超时')) && errs.some((x) => x.includes('drain 段超时')));
    const cap = await run('cap');
    check('三段停机：normal 的计时器因阻塞晚触发时，后两段不顺延，总耗时不超过上限', !cap.ok && cap.took <= 800 + 60, `${cap.took}ms`);
  } finally {
    console.error = origErr;
    mode = 'off';
  }
}

// ---------------- 信号接线：SIGTERM 依次跑三段再以 143 退出（子进程） ----------------
const storeUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'store.ts')).href;
/** env 里取值为 undefined 的变量从子进程环境里删掉（做到真正的「未设」） */
const childEnv = (env: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};
const runFile = (file: string, env: Record<string, string | undefined>) => {
  const t0 = Date.now();
  // 单进程：node 自己带 tsx 加载器；超时用 SIGKILL（子进程装了 SIGTERM 的处理，SIGTERM 杀不掉卡住的它），不留孤儿
  const r = spawnSync(process.execPath, ['--import', 'tsx', file], {
    cwd: process.cwd(),
    env: childEnv(env),
    timeout: 15_000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  return { ...r, took: Date.now() - t0 };
};
const runChild = (name: string, code: string, env: Record<string, string | undefined>) => {
  const file = path.join(VAR_DIR, `${name}.mts`);
  fs.writeFileSync(file, code);
  return runFile(file, env);
};
/** 一个装好 fixture 的独立数据目录 */
const freshVarDir = (name: string, sessions: unknown[] = fixtureSessions(), orders: unknown[] = fixtureOrders()): string => {
  const dir = fs.mkdtempSync(path.join(VAR_DIR, `${name}-`));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions, null, 2));
  fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(orders, null, 2));
  return dir;
};
const sessionsIn = (dir: string): Session[] => JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Session[];
{
  const out = path.join(VAR_DIR, 'phases.txt');
  const r = runChild(
    'sigterm-phases',
    `import fs from 'node:fs';\n` +
      `const { onShutdown } = await import(${JSON.stringify(storeUrl)});\n` +
      `const log = (p) => () => fs.appendFileSync(${JSON.stringify(out)}, p + '\\n');\n` +
      `onShutdown(log('late'), { phase: 'late' });\n` +
      `onShutdown(log('drain'), { phase: 'drain' });\n` +
      `onShutdown(async () => { await new Promise((r) => setTimeout(r, 200)); log('normal')(); });\n` +
      `setInterval(() => {}, 1000);\n` +
      `setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);\n`,
    { VAR_DIR },
  );
  const order = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').join() : '';
  check('SIGTERM：经 store 的导入期接线，三段依次跑完', order === 'normal,drain,late', `${order} ${(r.stderr ?? '').slice(0, 300)}`);
  check(
    'SIGTERM：自己以 143 退出（不是超时被杀）',
    r.status === 143 && r.signal === null && !r.error,
    `status=${r.status} signal=${r.signal}`,
  );
  check('SIGTERM：钩子跑完就退，不等到总上限', r.took < 5000, `${r.took}ms`);
}

// ---------------- exit 时同步写出去抖里的改动（R7 的同步落盘点，子进程） ----------------
{
  const saveThen = (tail: string) =>
    `const s = await import(${JSON.stringify(storeUrl)});\n` +
    `const x = s.getOrCreateSession('wecom:exit-1', 'wecom');\n` +
    `x.messages.push({ role: 'customer', content: '最后一句', at: Date.now() });\n` +
    `s.saveSession(x);\n` +
    tail;
  const dirA = freshVarDir('exit-a');
  const a = runChild('exit-a', saveThen(`process.exit(0);\n`), { VAR_DIR: dirA });
  check(
    'exit：去抖里的改动在 process.exit 时同步写出',
    a.status === 0 && sessionsIn(dirA).some((x) => x.id === 'wecom:exit-1'),
    a.stderr.slice(0, 200),
  );
  const dirB = freshVarDir('exit-b');
  const b = runChild('exit-b', saveThen(`setInterval(() => {}, 1000);\nprocess.kill(process.pid, 'SIGTERM');\n`), { VAR_DIR: dirB });
  check('exit：SIGTERM 之后同样写出', b.status === 143 && sessionsIn(dirB).some((x) => x.id === 'wecom:exit-1'), `status=${b.status}`);
  const dirC = freshVarDir('exit-c');
  const sj = JSON.stringify(path.join(dirC, 'sessions.json'));
  const c = runChild(
    'exit-c',
    `import fs from 'node:fs';\n` +
      `fs.renameSync(${sj}, ${sj} + '.bak'); fs.mkdirSync(${sj}); fs.writeFileSync(${sj} + '/blocker', 'x');\n` +
      saveThen(
        `await new Promise((r) => setTimeout(r, 400));\n` + // 去抖落盘失败一次
          `fs.rmSync(${sj}, { recursive: true }); fs.renameSync(${sj} + '.bak', ${sj});\n` +
          `process.exit(0);\n`,
      ),
    { VAR_DIR: dirC },
  );
  check(
    'exit：上次落盘失败留下的改动，恢复之后在 exit 时再写一次',
    c.status === 0 && sessionsIn(dirC).some((x) => x.id === 'wecom:exit-1') && c.stderr.includes('落盘失败'),
    c.stderr.slice(0, 200),
  );
}

// ---------------- 畸形的旧数据不让 store 在导入期崩（与开工时一致） ----------------
{
  const dir = freshVarDir('malformed', [
    { ...session('wecom:no-msgs', []), messages: undefined },
    session('wecom:null-msg', [msg('customer', 'a'), null as unknown as ChatMessage]),
  ]);
  const r = runChild(
    'malformed',
    `const s = await import(${JSON.stringify(storeUrl)});\n` +
      `s.saveSession(s.getSession('wecom:no-msgs'));\n` +
      `const y = s.getSession('wecom:null-msg'); y.messages.push({ role: 'agent', content: 'b', at: Date.now() }); s.saveSession(y);\n` +
      `console.log('seq=' + s.seqOf(y.messages.at(-1)));\n` +
      `process.exit(0);\n`,
    { VAR_DIR: dir },
  );
  check(
    '畸形数据：缺 messages、数组里有 null 的会话照常导入与 saveSession',
    r.status === 0 && r.stdout.includes('seq=2'),
    `${r.status} ${r.stderr.slice(0, 300)}`,
  );
}

// ---------------- server.ts 的真实接线：文件存储而 var/ 里有标记文件，拒绝启动（不变量 15 的文件一半） ----------------
{
  const dir = freshVarDir('server-marker');
  fs.writeFileSync(path.join(dir, store.SESSIONS_IN_DB_MARKER), '{}');
  const r = runFile(path.join(import.meta.dirname, '..', 'server.ts'), {
    VAR_DIR: dir,
    CONFIG_SOURCE: 'file',
    SESSION_STORE: undefined,
    SERVER_SELFTEST: undefined,
    PORT: '0',
    LLM_MOCK: '1',
  });
  check(
    'server：var/ 里有标记文件 → 以 1 退出、打出 sessions_in_db，没有开始监听',
    r.status === 1 && r.stderr.includes('（sessions_in_db）') && !r.error,
    `status=${r.status} ${(r.stderr ?? '').slice(0, 300)}`,
  );
}

// ---------------- 导入期行为与 SESSION_STORE 无关（不变量 1，R3） ----------------
{
  // fixture 里另放一个几天前的种子会话和一个过期的访客：保鲜与清理在导入期的效果看得见
  const day = 86_400_000;
  const probeSessions = (): Session[] => [
    // 种子全都是几天前的，保鲜才会动（它把最新的种子挪到 5 分钟前）
    ...fixtureSessions().map((x) => (x.id.startsWith('wecom:cust_') ? { ...x, updatedAt: Date.now() - 3 * day } : x)),
    { ...session('wecom:cust_OLD', [msg('customer', '旧种子', Date.now() - 3 * day)]), updatedAt: Date.now() - 3 * day },
    { ...session('sim-stalestalestale1', [msg('customer', '过期访客', 1)], 'simulator'), updatedAt: Date.now() - 2 * day },
  ];
  const child =
    `import dc from 'node:diagnostics_channel';\n` +
    `let sockets = 0;\n` +
    `dc.subscribe('net.client.socket', () => { sockets++; });\n` +
    `const timers = { setInterval: 0, setTimeout: 0 };\n` +
    `const oi = globalThis.setInterval, ot = globalThis.setTimeout;\n` +
    `globalThis.setInterval = (...a) => { timers.setInterval++; return oi(...a); };\n` +
    `globalThis.setTimeout = (...a) => { timers.setTimeout++; return ot(...a); };\n` +
    `const s = await import(${JSON.stringify(storeUrl)});\n` +
    `await new Promise((r) => ot(r, 300));\n` +
    `const old = s.getSession('wecom:cust_OLD');\n` +
    `console.log(JSON.stringify({\n` +
    `  mode: s.sessionStoreMode(),\n` +
    `  sessions: s.listSessions().map((x) => x.id).toSorted(),\n` +
    `  seqs: s.getSession('wecom:u1').messages.map((m) => s.seqOf(m)),\n` +
    `  orders: s.listOrders().map((o) => o.id),\n` +
    `  freshened: Date.now() - old.updatedAt < 600000,\n` +
    `  listeners: ['exit', 'SIGTERM', 'SIGINT'].map((e) => process.listenerCount(e)),\n` +
    `  sockets,\n` +
    `  timers,\n` +
    `}));\n` +
    `process.exit(0);\n`;
  const probe = (label: string, storeEnv: string | undefined, opts: { readOnly?: boolean } = {}) => {
    const dir = freshVarDir(`import-${label}`, probeSessions());
    if (opts.readOnly) fs.chmodSync(dir, 0o555);
    const before = fs.readdirSync(dir).toSorted().join();
    const r = runChild(`import-${label}`, child, {
      VAR_DIR: dir,
      SESSION_STORE: storeEnv,
      CONFIG_SOURCE: storeEnv === 'db' ? 'db' : '',
      DATABASE_URL: 'postgres://agent_app:x@127.0.0.1:1/none',
    });
    const after = fs.readdirSync(dir).toSorted().join();
    if (opts.readOnly) fs.chmodSync(dir, 0o755);
    // stdout 里还有 store 自己的保鲜与清理日志，结果是最后一行
    const out = (r.stdout ?? '').trim().split('\n').at(-1) ?? '';
    return { out, err: r.stderr ?? '', status: r.status, filesSame: before === after };
  };
  const asFile = probe('file', 'file');
  const asDb = probe('db', 'db');
  const unset = probe('unset', undefined);
  check(
    '导入期：子进程正常退出',
    asFile.status === 0 && asDb.status === 0 && unset.status === 0,
    `${asFile.err.slice(0, 200)} ${asDb.err.slice(0, 200)}`,
  );
  check(
    '导入期：SESSION_STORE=db 与 file、真正未设时的行为相同',
    asFile.out !== '' && asFile.out === asDb.out && asFile.out === unset.out,
    `${asFile.out}\n${asDb.out}\n${unset.out}`,
  );
  const parsed = JSON.parse(asFile.out || '{}') as {
    mode?: string;
    sessions?: string[];
    seqs?: number[];
    freshened?: boolean;
    listeners?: number[];
    sockets?: number;
    timers?: { setInterval: number; setTimeout: number };
  };
  check('导入期：读进 JSON 并记好 seq，模式是 file（initSessionStore 之前）', parsed.mode === 'file' && parsed.seqs?.join() === '1,2,3');
  check('导入期：保鲜把旧种子挪到眼前、清理删掉过期访客', parsed.freshened === true && !parsed.sessions?.includes('sim-stalestalestale1'));
  check('导入期：起了保鲜与清理的定时器', (parsed.timers?.setInterval ?? 0) >= 1, JSON.stringify(parsed.timers));
  check(
    '导入期：exit 与信号的钩子都已注册',
    (parsed.listeners ?? []).every((n) => n >= 1),
    JSON.stringify(parsed.listeners),
  );
  check('导入期：没有发起任何网络连接（db 存储下也不为会话连库）', parsed.sockets === 0, String(parsed.sockets));
  check('导入期：探针写完就删，数据目录里没多出文件', asFile.filesSame && asDb.filesSame && unset.filesSame);
  // 探测本身：连一次网络，计数器要看得见
  const control = runChild(
    'socket-control',
    `import dc from 'node:diagnostics_channel'; import net from 'node:net';\n` +
      `let n = 0; dc.subscribe('net.client.socket', () => { n++; });\n` +
      `net.connect(1, '127.0.0.1').on('error', () => {});\n` +
      `console.log(n); process.exit(0);\n`,
    {},
  );
  check('导入期：连接计数的探测是灵的（正对照）', control.stdout.trim() === '1', control.stdout + control.stderr.slice(0, 200));
  if (process.getuid?.() !== 0) {
    const roFile = probe('ro-file', 'file', { readOnly: true });
    const roDb = probe('ro-db', 'db', { readOnly: true });
    check(
      '导入期：数据目录不可写时，两种模式都在启动时喊出来',
      roFile.err.includes('数据目录不可写') && roDb.err.includes('数据目录不可写'),
      `${roFile.err.slice(0, 120)} | ${roDb.err.slice(0, 120)}`,
    );
  }
}

// ---------------- /healthz 的 store 与 ok ----------------
{
  process.env.SERVER_SELFTEST = '1';
  const { app } = await import('../server.js');
  const health = async () => (await app.request('/healthz')).json() as Promise<{ ok: boolean; store: Record<string, unknown> }>;
  const h = await health();
  check(
    '/healthz：store 只有 mode、dirty、lagMs、conflict、poisoned',
    Object.keys(h.store).toSorted().join() === 'conflict,dirty,lagMs,mode,poisoned',
    JSON.stringify(h.store),
  );
  check('/healthz：文件存储、没有积压时 ok', h.ok === true && h.store.mode === 'file' && h.store.poisoned === 0 && h.store.dirty === 0);

  const origErr = console.error;
  console.error = () => {};
  fs.renameSync(SESSIONS_FILE, `${SESSIONS_FILE}.bak`);
  fs.mkdirSync(SESSIONS_FILE);
  fs.writeFileSync(path.join(SESSIONS_FILE, 'blocker'), 'x');
  const u1 = store.getSession('wecom:u1')!;
  const realNow = Date.now;
  const base = realNow();
  let lagging: Awaited<ReturnType<typeof health>>;
  try {
    store.saveSession(u1);
    await sleep(300); // 去抖落盘失败一次
    Date.now = () => base + 60_000;
    store.saveSession(u1); // 一分钟后又改一次：积压按最早那次算
    Date.now = () => base + 121_000;
    lagging = await health();
  } finally {
    Date.now = realNow;
  }
  check(
    '/healthz：积压超过 2 分钟时 ok 为 false，HTTP 照旧 200',
    lagging.ok === false && (lagging.store.lagMs as number) > 120_000,
    JSON.stringify(lagging.store),
  );
  check('/healthz：不带会话数与会话 id', !JSON.stringify(lagging).includes('wecom:u1') && !('conversations' in lagging.store));
  fs.rmSync(SESSIONS_FILE, { recursive: true });
  fs.renameSync(`${SESSIONS_FILE}.bak`, SESSIONS_FILE);
  store.saveSession(u1);
  await store.flushSession('wecom:u1');
  console.error = origErr;
  check('/healthz：恢复落盘之后 ok', (await health()).ok === true);
}

if (fails.length) {
  console.error(`STORE SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `STORE SELFTEST PASS: ${pass} 项断言全通（seq 的严格与宽松模式 / 文件后端读 JSON、flushSession 等落盘、事件在落盘之后、落盘失败不发事件 / 标记文件 / SESSION_STORE 校验 / boot 的失败分支 / 三段停机的顺序与时限 / SIGTERM / 导入期与模式无关 / healthz）`,
);
process.exit(0);
