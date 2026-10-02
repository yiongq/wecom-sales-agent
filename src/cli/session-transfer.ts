// 会话的导入与导出（docs/architecture/02-conversations-workbench/spec.md「导入、导出与切换」）。import-sessions、export-sessions
// 两个命令行是薄包装，逻辑在这里，自测直接调用。只用 src/store/project.ts 的投影与 src/db/repo/**，不 import 运行时模块
// （store、引擎、工具、模型、渠道；scripts/check-boundaries.ts 守）。以 app 身份运行、要求应用已停：先取租户锁。
// 读回比对与启动预载走同一条路：repo 的 readSessionBatch（每批 500 个）加 project.ts 的 rebuildSessions、rowToOrder（不变量 14）；
// 首次导入按库里 id 的排序分批写，每批写完读回的正好是预载的那一页。
// 退出码：0 成功或已一致；2 库里已有不一致的内容，或读回与 JSON 不等（已回滚），或 export 时 JSON 比库新；3 拿不到租户锁；1 其他错误。
// 改写 var/ 的顺序保证中途崩溃都落在安全的中间态：import 先写标记再改写 JSON（sessions.json → orders.json），export 先 orders.json、
// 再 sessions.json、最后删标记；每次改名之后对目录 fsync，改名的先后在断电之后也成立。
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pgErrorOf, withTenant, type Db, type TenantCtx, type TenantLock, type Tx } from '../db/client.js';
import {
  insertConversation,
  orderLikeConversations,
  readConversationsAfter,
  readSessionBatch,
  updateConversation,
  type ConversationRow,
} from '../db/repo/conversations.js';
import { insertMessages } from '../db/repo/messages.js';
import { readOrderIdsIn, upsertOrders } from '../db/repo/orders.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { shortIdOf } from '../shared/conversation.js';
import { cleanText } from '../shared/text.js';
import {
  isDemoClassId,
  messageToRow,
  normalizeForStore,
  orderToRow,
  ORDERS_JSON,
  ProjectionError,
  rebuildSessions,
  rowToMessage,
  rowToOrder,
  sessionToRow,
  SESSIONS_IN_DB_MARKER,
  SESSIONS_JSON,
  SPILL_FILE_RE,
} from '../store/project.js';
import type { Order, Session } from '../types.js';

export const EXIT = { ok: 0, error: 1, inconsistent: 2, locked: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** 每批的会话数：与启动预载相同（R2） */
const BATCH = 500;

export interface SessionStats {
  /** 写进库或从库里导出的真实会话 */
  sessions: number;
  messages: number;
  orders: number;
  /** 被 normalizeForStore 改过的字符串（含键）条数：去掉 U+0000、修孤立代理项 */
  normalized: number;
  /** 改写之后 JSON 里剩下的 demo 类会话与订单（demo 类的与孤儿订单） */
  jsonSessions: number;
  jsonOrders: number;
  /** 库里这个租户的真实会话数（写进标记文件） */
  dbSessions: number;
  /** --resync：库里没有、按首次写入的会话；追加了消息的会话与条数；窗口推进的会话与整段追加的条数；作废的订单；库里已作废、没有恢复的订单 */
  created: number;
  appendedTo: number;
  appended: number;
  pushed: number;
  pushedMessages: number;
  voided: number;
  skippedVoided: number;
  /** 原件复制到的目录（--keep 下按次新建） */
  kept: string | null;
}

export interface SessionsResult {
  code: ExitCode;
  /** 给人看的几行，命令行原样打印 */
  lines: string[];
  /** 自测看的计数 */
  stats: Partial<SessionStats>;
}

interface TransferOptions {
  db: Db;
  tenantSlug: string;
  /** 数据目录（sessions.json、orders.json、标记文件所在） */
  varDir: string;
  /** 原件复制到这里；必须在 varDir 之外（不进每晚 var/ 的备份） */
  keepDir: string;
  /** 取租户锁；拿不到（应用还在跑）返回 null */
  lock(tenantId: string): Promise<TenantLock | null>;
  /** 作废时间等用的时钟，自测可替换 */
  now?: () => number;
}

export interface ImportSessionsOptions extends TransferOptions {
  /** 只打印将写入的条数与往返结果：照样写进事务、读回比对，最后回滚；文件一个都不动（--keep 只试写一次、随即删掉） */
  dryRun?: boolean;
  /** 回退到文件存储跑过一段之后再切回：按 spec 的规则把 JSON 的改动接到库里 */
  resync?: boolean;
}

/** 提前结束：带退出码与要打印的话 */
class Stop extends Error {
  constructor(
    readonly code: ExitCode,
    readonly why: string,
  ) {
    super(why);
  }
}
/** --dry-run：事务里的结果带出去，同时让 withTenant 回滚 */
class DryRun<T> extends Error {
  constructor(readonly result: T) {
    super('dry-run');
  }
}

const short = (id: string): string => shortIdOf(id) || '?';
const ctxOf = (tenantId: string, name: string): TenantCtx => ({ tenantId, actor: { kind: 'system', userId: null, name, ip: null } });
const errLabel = (e: unknown): string => {
  const { code, constraint } = pgErrorOf(e);
  if (code) return `${code}${constraint ? ` ${constraint}` : ''}`;
  if (e instanceof ProjectionError) return e.message;
  return e instanceof Error ? e.name : 'unknown';
};

// ---------------- var/ 里的文件 ----------------

interface VarFiles {
  /** 与文件后端的读法相同：按 id，同 id 以后出现的为准，顺序是第一次出现的位置 */
  sessions: Map<string, Session>;
  orders: Map<string, Order>;
}

function readArrayFile<T>(varDir: string, name: string): Map<string, T> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(varDir, name), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Stop(EXIT.error, `读不了 ${name}（${(e as NodeJS.ErrnoException).code ?? errLabel(e)}）`);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    // 解析错误的说明里带着出错处的原文片段（可能是客户的话），不打出来
    throw new Stop(EXIT.error, `${name} 不是合法的 JSON，没有改动任何东西`);
  }
  if (!Array.isArray(arr)) throw new Stop(EXIT.error, `${name} 不是数组，没有改动任何东西`);
  const map = new Map<string, T>();
  arr.forEach((x: unknown, i) => {
    if (!x || typeof x !== 'object' || typeof (x as { id?: unknown }).id !== 'string') {
      throw new Stop(EXIT.error, `${name} 第 ${i + 1} 条没有字符串的 id，没有改动任何东西`);
    }
    map.set((x as { id: string }).id, x as T);
  });
  return map;
}

const readVar = (varDir: string): VarFiles => ({
  sessions: readArrayFile<Session>(varDir, SESSIONS_JSON),
  orders: readArrayFile<Order>(varDir, ORDERS_JSON),
});

interface Split {
  /** 真实会话（不是 demo 类），JSON 里的顺序 */
  real: Session[];
  /** 改写之后留在 JSON 里的：demo 类会话，demo 类会话的订单与孤儿订单（所属会话不在真实会话里） */
  demo: Session[];
  kept: Order[];
  /** 订单跟着所属会话走 */
  ordersOf: Map<string, Order[]>;
}

function split(v: VarFiles): Split {
  const real: Session[] = [];
  const demo: Session[] = [];
  for (const s of v.sessions.values()) (isDemoClassId(s.id) ? demo : real).push(s);
  const realIds = new Set(real.map((s) => s.id));
  const ordersOf = new Map<string, Order[]>();
  const kept: Order[] = [];
  for (const o of v.orders.values()) {
    const sid = (o as { sessionId?: unknown }).sessionId;
    if (typeof sid === 'string' && realIds.has(sid)) ordersOf.set(sid, [...(ordersOf.get(sid) ?? []), o]);
    else kept.push(o);
  }
  return { real, demo, kept, ordersOf };
}

/** 被 normalizeForStore 改动的字符串条数（值与键都算） */
function countNormalized(x: unknown): number {
  if (typeof x === 'string') return cleanText(x) === x ? 0 : 1;
  if (Array.isArray(x)) return x.reduce((n: number, v) => n + countNormalized(v), 0);
  if (x !== null && typeof x === 'object') {
    return Object.entries(x).reduce((n, [k, v]) => n + (cleanText(k) === k ? 0 : 1) + countNormalized(v), 0);
  }
  return 0;
}

/** 路径的真实位置：不存在的部分接在最近一个存在的上级目录的 realpath 后面（--keep 可以还没建） */
function realOf(p: string): string {
  const tail: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/** --keep 必须在 --var 之外：原件含全部客户对话，进了 var/ 就随每晚的备份一份份留下来，删不干净 */
function checkKeep(keepDir: string, varDir: string): void {
  const keep = realOf(keepDir);
  const v = realOf(varDir);
  if (keep === v || keep.startsWith(v.endsWith(path.sep) ? v : v + path.sep)) {
    throw new Stop(EXIT.error, `--keep（${keepDir}）在数据目录 ${varDir} 之内：原件要放在 var/ 之外（不进每晚的备份），什么都没动`);
  }
}

/** var/ 里还有没回放的 spill：那是上次 db 存储停机时没落库的改动，导入导出都会把它们丢掉 */
function checkSpill(varDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(varDir);
  } catch {
    return [];
  }
  const spills = names.filter((f) => SPILL_FILE_RE.test(f));
  if (spills.length) {
    throw new Stop(
      EXIT.error,
      `数据目录里有没回放的 spill 文件（${spills.join('、')}）：上次 db 存储停机时没落库的改动在里面。` +
        '先以 db 存储启动一次让它回放（成功后文件会删掉），再停机跑本命令；什么都没动',
    );
  }
  const failed = names.filter((f) => /^store-spill-.+\.json\.failed$/.test(f));
  return failed.length ? [`注意：数据目录里有回放失败的 spill（${failed.join('、')}），里面的改动不在库里，要人工处理`] : [];
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** --keep 下这次要用的子目录（每次一个，不覆盖上一次的原件）。discard：没用上时删掉它与本次新建的上级目录（只删空目录） */
interface KeepTo {
  dir: string;
  discard(): void;
}

/** 从 dir 往上逐级删空目录，删到 top（含）为止；top 为 undefined 时什么都不删 */
function removeEmptyUpTo(dir: string, top: string | undefined): void {
  if (!top) return;
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    try {
      fs.rmdirSync(p);
    } catch {
      return;
    }
    if (p === path.resolve(top) || path.dirname(p) === p) return;
  }
}

/**
 * 取锁之后、开事务之前把 --keep 下这次要用的子目录建好并试写一次：写不进去（宿主目录没先建好、属主不对）就以 1 退出，
 * 库与文件都没动——不能等到库已提交才发现原件放不进去
 */
function prepareKeep(keepDir: string, label: string, now: number): KeepTo {
  let created: string | undefined;
  let dir: string | null = null;
  try {
    created = fs.mkdirSync(keepDir, { recursive: true });
    dir = fs.mkdtempSync(path.join(keepDir, `${label}-${stamp(now)}-`));
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (e) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    removeEmptyUpTo(keepDir, created);
    throw new Stop(
      EXIT.error,
      `--keep（${keepDir}）写不进去（${(e as NodeJS.ErrnoException).code ?? errLabel(e)}）：宿主目录要先建好、属主给容器内的 node（install -d -o 1000 -g 1000）；什么都没动`,
    );
  }
  const made = dir;
  return {
    dir: made,
    discard: () => {
      try {
        fs.rmdirSync(made);
      } catch {
        return; // 里面已经有原件（复制到一半失败）：留着
      }
      removeEmptyUpTo(path.dirname(made), created);
    },
  };
}

/** 把 var/ 里的两个原文件复制到 prepareKeep 建好的目录。返回那个目录，没有文件时 null */
function keepOriginals(keepTo: KeepTo, varDir: string): string | null {
  const names = [SESSIONS_JSON, ORDERS_JSON].filter((n) => fs.existsSync(path.join(varDir, n)));
  if (!names.length) return null;
  for (const n of names) fs.copyFileSync(path.join(varDir, n), path.join(keepTo.dir, n), fs.constants.COPYFILE_EXCL);
  return keepTo.dir;
}

/** 目录本身落到盘上：之前的改名、删除在断电之后也按发生的先后可见 */
function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** 先写临时文件、落到盘上，再改名，再 fsync 所在目录：崩溃不会留下半截文件，两次改名的先后也落了盘 */
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

/** 两个 JSON 的写法与文件后端落盘相同 */
const jsonOf = (items: readonly (Session | Order)[]): string => JSON.stringify(items, null, 2);

// ---------------- 库：读法与启动预载相同 ----------------

interface DbConv {
  row: ConversationRow;
  session: Session;
  orders: Order[];
}

/** 启动预载的一页：afterId 之后按 id 的 500 个会话（窗口内的消息）与它们的未作废订单，同样的读法、同样的重建 */
async function readPage(tx: Tx, afterId: string | null): Promise<{ convs: Map<string, DbConv>; last: string | null; full: boolean }> {
  const convs = new Map<string, DbConv>();
  const batch = await readSessionBatch(tx, afterId, BATCH);
  for (const { row, session, windowCount } of rebuildSessions(batch.rows, batch.messages)) {
    if (!session) {
      throw new Stop(
        EXIT.error,
        `库里的会话 ${short(row.id)} 本身不自洽（last_seq=${row.lastSeq}、window_start_seq=${row.windowStartSeq}，窗口里却是 ${windowCount} 条）`,
      );
    }
    convs.set(row.id, { row, session, orders: [] });
  }
  for (const r of batch.orders) if (r.sessionId !== null) convs.get(r.sessionId)?.orders.push(rowToOrder(r));
  return { convs, last: batch.rows.at(-1)?.id ?? null, full: batch.rows.length === BATCH };
}

/** 这个租户的全部真实会话与未作废订单：与启动预载同一个循环 */
async function readAll(tx: Tx): Promise<Map<string, DbConv>> {
  const out = new Map<string, DbConv>();
  for (let after: string | null = null; ;) {
    const page = await readPage(tx, after);
    for (const [id, c] of page.convs) out.set(id, c);
    if (!page.full) break;
    after = page.last;
  }
  return out;
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** JSON 里的一个真实会话与库里重建出来的哪里不同（两边都经 normalizeForStore）；相同返回 null。说明里不带客户原话 */
function difference(s: Session, orders: readonly Order[], db: DbConv | undefined): string | null {
  if (!db) return '库里没有这个会话';
  const want = normalizeForStore(s);
  if (!isDeepStrictEqual(want, db.session)) {
    if (!Array.isArray(want.messages)) return 'messages 不是数组';
    const got = db.session.messages;
    if (want.messages.length !== got.length) return `消息条数不同（JSON ${want.messages.length} 条，库里 ${got.length} 条）`;
    const i = want.messages.findIndex((m, j) => !isDeepStrictEqual(m, got[j]));
    if (i >= 0) return `第 ${i + 1} 条消息不同`;
    const w = want as unknown as Record<string, unknown>;
    const g = db.session as unknown as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(w), ...Object.keys(g)])].filter((k) => k !== 'messages' && !isDeepStrictEqual(w[k], g[k]));
    return `字段 ${keys.join('、')} 不同`;
  }
  const wantOrders = orders.map((o) => normalizeForStore(o)).toSorted(byId);
  const gotOrders = db.orders.toSorted(byId);
  if (!isDeepStrictEqual(wantOrders, gotOrders)) {
    return `订单不同（JSON ${wantOrders.map((o) => o.id).join('、') || '无'}；库里 ${gotOrders.map((o) => o.id).join('、') || '无'}）`;
  }
  return null;
}

/** 第一个与库里不等的真实会话（JSON 里的顺序）。skip：库里已作废、没有恢复的订单 id，不算在期望里 */
function firstDifference(sp: Split, db: Map<string, DbConv>, skip: ReadonlySet<string> = new Set()): { id: string; why: string } | null {
  for (const s of sp.real) {
    const why = difference(
      s,
      (sp.ordersOf.get(s.id) ?? []).filter((o) => !skip.has(o.id)),
      db.get(s.id),
    );
    if (why) return { id: s.id, why };
  }
  return null;
}

/** 一个会话的写入出错时点名短码（会话 id 里有 external_userid，只写短码） */
async function onSession<T>(id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw new Stop(EXIT.error, `会话 ${short(id)} 写不进库（${errLabel(e)}），已回滚，库没动`);
  }
}

const messagesOf = (s: Session): unknown[] => (Array.isArray(s.messages) ? s.messages : []);

/** 首次写入一个会话：消息按数组下标写 seq（从 1 起），window_start_seq = 1，last_seq = 消息条数；state 原样 */
async function writeNew(tx: Tx, s: Session): Promise<void> {
  const rows = messagesOf(s).map((m, i) => messageToRow(m as Session['messages'][number], i + 1));
  const ins = await insertConversation(tx, sessionToRow(s), { lastSeq: rows.length, windowStartSeq: 1, flushId: null });
  if (!ins) throw new Stop(EXIT.error, `会话 ${short(s.id)} 已经在库里（同一事务里刚查过没有），已回滚`);
  await insertMessages(tx, s.id, rows);
}

async function writeOrders(tx: Tx, rows: Parameters<typeof upsertOrders>[1]): Promise<void> {
  if (!rows.length) return;
  try {
    await upsertOrders(tx, rows);
  } catch (e) {
    throw new Stop(EXIT.error, `订单写不进库（${errLabel(e)}），已回滚，库没动`);
  }
}

interface ResyncCounts {
  created: number;
  appendedTo: number;
  appended: number;
  pushed: number;
  pushedMessages: number;
  ordersWritten: number;
  voided: number;
  /** 库里已作废、文件里还有的订单 id：不恢复（库里不拦 voided_at 写回 NULL，只在这里守） */
  skippedVoided: Set<string>;
}

/**
 * --resync（spec「import-sessions」最后一条）：JSON 里每个真实会话，库里没有就按首次写；库里的窗口是文件窗口的前缀，就把多出来的
 * 追加上去；否则把 window_start_seq 推到 last_seq + 1，把文件窗口整个作为新消息追加（历史里重复一段，不丢）。state 换成文件里的。
 * 订单按 id upsert；这些会话在库里有、文件里没有的未作废订单作废（void_reason='resync'）
 */
async function resyncInTx(tx: Tx, sp: Split, now: number): Promise<ResyncCounts> {
  const before = await readAll(tx);
  const c: ResyncCounts = {
    created: 0,
    appendedTo: 0,
    appended: 0,
    pushed: 0,
    pushedMessages: 0,
    ordersWritten: 0,
    voided: 0,
    skippedVoided: new Set(),
  };
  for (const s of sp.real) {
    await onSession(s.id, async () => {
      const cur = before.get(s.id);
      if (!cur) {
        await writeNew(tx, s);
        c.created += 1;
        return;
      }
      const file = messagesOf(s) as Session['messages'];
      // 比的是进库之后的样子：文件里的消息经同一个投影走一趟，库里的是预载重建出来的
      const canon = file.map((m) => rowToMessage(messageToRow(m, 1)));
      const inDb = cur.session.messages;
      const prefix = inDb.length <= canon.length && inDb.every((m, i) => isDeepStrictEqual(m, canon[i]));
      const add = prefix ? file.slice(inDb.length) : file;
      const base = cur.row.lastSeq;
      await insertMessages(
        tx,
        s.id,
        add.map((m, i) => messageToRow(m, base + 1 + i)),
      );
      const ok = await updateConversation(tx, sessionToRow(s), {
        lastSeq: base + add.length,
        windowStartSeq: prefix ? cur.row.windowStartSeq : base + 1,
        flushId: null,
      });
      if (!ok) throw new Stop(EXIT.error, `会话 ${short(s.id)} 更新不到（同一事务里刚读到过），已回滚`);
      if (prefix) {
        if (add.length) c.appendedTo += 1;
        c.appended += add.length;
      } else {
        c.pushed += 1;
        c.pushedMessages += add.length;
      }
    });
  }
  const fileOrders = sp.real.flatMap((s) => sp.ordersOf.get(s.id) ?? []);
  const fileIds = new Set(fileOrders.map((o) => o.id));
  const live = new Set([...before.values()].flatMap((x) => x.orders.map((o) => o.id)));
  const inDb = await readOrderIdsIn(tx, [...fileIds]);
  for (const id of inDb) if (!live.has(id)) c.skippedVoided.add(id);
  const voids = sp.real.flatMap((s) => (before.get(s.id)?.orders ?? []).filter((o) => !fileIds.has(o.id)));
  let rows: Parameters<typeof upsertOrders>[1];
  try {
    rows = [
      ...voids.map((o) => orderToRow(o, { at: now, reason: 'resync' })),
      ...fileOrders.filter((o) => !c.skippedVoided.has(o.id)).map((o) => orderToRow(o)),
    ];
  } catch (e) {
    throw new Stop(EXIT.error, `订单投影不出合法的行（${errLabel(e)}），已回滚，库没动`);
  }
  await writeOrders(tx, rows);
  c.voided = voids.length;
  c.ordersWritten = rows.length - voids.length;
  return c;
}

// ---------------- import-sessions ----------------

interface ImportOutcome {
  kind: 'imported' | 'consistent' | 'resynced';
  /** 事务结束时库里这个租户的真实会话数 */
  dbSessions: number;
  resync?: ResyncCounts;
}

/**
 * import-sessions（spec「导入、导出与切换」）。读 sessions.json、orders.json，按 isDemoClassId 分成真实与 demo 类，订单跟着所属会话走，
 * 孤儿订单留在 JSON。库里这个租户还没有会话时，一个 longRunning 事务按 500 个一批写入，写完在同一事务里按启动预载的读法读回、
 * 逐个与 normalizeForStore 之后的 JSON 比对，不等就回滚、退出码 2；提交后原件复制到 --keep、JSON 改写成只剩 demo 类、写标记文件。
 * 库里已有会话时：JSON 里没有真实会话且有标记 → 0；逐个一致 → 补完改写与标记、0；不一致 → 2（提示 --resync）
 */
export async function importSessions(o: ImportSessionsOptions): Promise<SessionsResult> {
  const lines: string[] = [];
  const stats: Partial<SessionStats> = {};
  const now = o.now ?? Date.now;
  try {
    const tenant = await findTenantBySlug(o.db, o.tenantSlug);
    if (!tenant) throw new Stop(EXIT.error, `tenant_not_found：没有 slug 为「${o.tenantSlug}」的租户`);
    checkKeep(o.keepDir, o.varDir);
    const lock = await o.lock(tenant.id);
    if (!lock) {
      throw new Stop(
        EXIT.locked,
        `lock_held：租户「${o.tenantSlug}」的锁在别的进程手里（应用还在跑？先 docker compose stop app），什么都没动`,
      );
    }
    let keepTo: KeepTo | null = null;
    try {
      lines.push(...checkSpill(o.varDir));
      keepTo = prepareKeep(o.keepDir, o.resync ? 'resync' : 'import', now());
      const files = readVar(o.varDir);
      const sp = split(files);
      const markerFile = path.join(o.varDir, SESSIONS_IN_DB_MARKER);
      if (!sp.real.length && fs.existsSync(markerFile)) {
        lines.push(`已经导入过：JSON 里没有真实会话，数据目录里有 ${SESSIONS_IN_DB_MARKER}；什么都没动`);
        return { code: EXIT.ok, lines, stats };
      }
      const theirOrders = sp.real.flatMap((s) => sp.ordersOf.get(s.id) ?? []);
      stats.normalized = countNormalized(sp.real) + countNormalized(theirOrders);
      stats.sessions = sp.real.length;
      stats.messages = sp.real.reduce((n, s) => n + messagesOf(s).length, 0);
      stats.orders = theirOrders.length;

      let outcome: ImportOutcome;
      try {
        outcome = await withTenant(
          o.db,
          ctxOf(tenant.id, 'import-sessions'),
          async (tx): Promise<ImportOutcome> => {
            if (o.resync) {
              const resync = await resyncInTx(tx, sp, now());
              const db = await readAll(tx);
              const bad = firstDifference(sp, db, resync.skippedVoided);
              if (bad) {
                throw new Stop(EXIT.inconsistent, `--resync 之后读回的会话 ${short(bad.id)} 与 JSON 不等（${bad.why}），已回滚，库没动`);
              }
              const r: ImportOutcome = { kind: 'resynced', dbSessions: db.size, resync };
              if (o.dryRun) throw new DryRun(r);
              return r;
            }
            if ((await readConversationsAfter(tx, null, 1)).length === 0) {
              // 按库里 id 的排序分批：库里本来没有会话，写完一批，「上一批最后一个 id 之后的 500 个」正好就是这一批，
              // 于是每批写完都能按启动预载的同一页读回、逐个比对（不变量 14）
              const real = new Map(sp.real.map((s) => [s.id, s]));
              const ids = await orderLikeConversations(tx, [...real.keys()]);
              let after: string | null = null;
              for (let i = 0; i < ids.length; i += BATCH) {
                const batch = ids.slice(i, i + BATCH).map((id) => real.get(id)!);
                for (const s of batch) await onSession(s.id, () => writeNew(tx, s));
                const orders = batch.flatMap((s) => sp.ordersOf.get(s.id) ?? []);
                try {
                  await writeOrders(
                    tx,
                    orders.map((x) => orderToRow(x)),
                  );
                } catch (e) {
                  if (e instanceof Stop) throw e;
                  throw new Stop(EXIT.error, `订单投影不出合法的行（${errLabel(e)}），已回滚，库没动`);
                }
                const page = await readPage(tx, after);
                const bad = firstDifference({ ...sp, real: batch }, page.convs);
                if (bad) throw new Stop(EXIT.inconsistent, `读回的会话 ${short(bad.id)} 与 JSON 不等（${bad.why}），已回滚，库没动`);
                if (page.convs.size !== batch.length) {
                  throw new Stop(
                    EXIT.inconsistent,
                    `第 ${i / BATCH + 1} 批读回 ${page.convs.size} 个会话，写入的是 ${batch.length} 个，已回滚，库没动`,
                  );
                }
                after = page.last;
              }
              const r: ImportOutcome = { kind: 'imported', dbSessions: ids.length };
              if (o.dryRun) throw new DryRun(r);
              return r;
            }
            // 库里已有会话：只判一致（补完改写），库不动
            const db = await readAll(tx);
            const bad = firstDifference(sp, db);
            if (bad) {
              throw new Stop(
                EXIT.inconsistent,
                `库里已有会话，JSON 里的真实会话 ${short(bad.id)} 与库里不一致（${bad.why}），什么都没动。` +
                  '回退到文件存储跑过一段之后再切回，用 --resync',
              );
            }
            return { kind: 'consistent', dbSessions: db.size };
          },
          { longRunning: true },
        );
      } catch (e) {
        if (!(e instanceof DryRun)) throw e;
        const r = e.result as ImportOutcome;
        stats.dbSessions = r.dbSessions;
        if (r.kind === 'imported') {
          lines.push(
            `dry-run：会写入 ${stats.sessions} 个真实会话、${stats.messages} 条消息、${stats.orders} 张订单；` +
              `被规范化的字符串 ${stats.normalized} 条；读回与 JSON 逐个一致。已回滚，库与文件都没动`,
          );
        } else {
          Object.assign(stats, resyncStats(r.resync!));
          lines.push(`dry-run：${resyncLine(r.resync!, stats)}；读回与 JSON 逐个一致。已回滚，库与文件都没动`);
        }
        return { code: EXIT.ok, lines, stats };
      }
      stats.dbSessions = outcome.dbSessions;
      if (o.dryRun) {
        // 只有「库里已有会话、逐个一致」会走到这里：它本来就不写库
        lines.push(`dry-run：库里已有这 ${sp.real.length} 个真实会话、逐个一致，会补完改写 JSON 与标记文件；什么都没动`);
        return { code: EXIT.ok, lines, stats };
      }

      // 提交之后：原件复制到 --keep → 写标记文件 → sessions.json 只剩 demo 类 → orders.json 只剩 demo 类与孤儿订单。
      // 标记先写：中途崩溃时要么还没有标记、JSON 是原件（文件存储照旧能起，库里那份由之后的 import 判一致或 --resync 接上），
      // 要么有标记、JSON 里还有真实会话（两种存储都拒绝启动）。库里已经是 JSON 的样子，再跑一次就按「逐个一致」补完改写
      try {
        stats.kept = keepOriginals(keepTo, o.varDir);
        fs.mkdirSync(o.varDir, { recursive: true });
        writeAtomic(
          markerFile,
          `${JSON.stringify({ tenant: o.tenantSlug, at: new Date(now()).toISOString(), sessions: outcome.dbSessions })}\n`,
        );
        writeAtomic(path.join(o.varDir, SESSIONS_JSON), jsonOf(sp.demo));
        writeAtomic(path.join(o.varDir, ORDERS_JSON), jsonOf(sp.kept));
      } catch (e) {
        throw new Stop(
          EXIT.error,
          `库已提交，但复制原件或改写数据目录失败（${errLabel(e)}）：修好原因后再跑一次 import-sessions，会按「逐个一致」补完改写；` +
            '在那之前不要启动应用',
        );
      }
      stats.jsonSessions = sp.demo.length;
      stats.jsonOrders = sp.kept.length;
      const tail =
        `JSON 只剩 ${sp.demo.length} 个 demo 类会话、${sp.kept.length} 张订单（demo 类与孤儿）；写了 ${SESSIONS_IN_DB_MARKER}；` +
        `原件在 ${stats.kept ?? '（数据目录里没有 JSON，没有原件）'}`;
      if (outcome.kind === 'imported') {
        lines.push(`已导入 ${stats.sessions} 个真实会话、${stats.messages} 条消息、${stats.orders} 张订单`);
        lines.push(`被规范化的字符串 ${stats.normalized} 条（去掉 U+0000、修孤立代理项）`);
      } else if (outcome.kind === 'consistent') {
        lines.push(`库里已有这 ${sp.real.length} 个真实会话、逐个一致：补完改写`);
      } else {
        Object.assign(stats, resyncStats(outcome.resync!));
        lines.push(`--resync：${resyncLine(outcome.resync!, stats)}`);
      }
      lines.push(tail);
      return { code: EXIT.ok, lines, stats };
    } finally {
      // 没复制原件（dry-run、已经导入过、拒绝、出错）：试写时建的子目录删掉
      if (keepTo && !stats.kept) keepTo.discard();
      await lock.release();
    }
  } catch (e) {
    if (e instanceof Stop) return { code: e.code, lines: [...lines, e.why], stats };
    return { code: EXIT.error, lines: [...lines, `出错：${errLabel(e)}${e instanceof Error ? ` ${e.message}` : ''}`], stats };
  }
}

function resyncStats(c: ResyncCounts): Partial<SessionStats> {
  return {
    created: c.created,
    appendedTo: c.appendedTo,
    appended: c.appended,
    pushed: c.pushed,
    pushedMessages: c.pushedMessages,
    voided: c.voided,
    skippedVoided: c.skippedVoided.size,
  };
}

function resyncLine(c: ResyncCounts, s: Partial<SessionStats>): string {
  return (
    `JSON 里 ${s.sessions} 个真实会话、${s.messages} 条消息、${s.orders} 张订单：库里没有、按首次写入 ${c.created} 个；` +
    `${c.appendedTo} 个会话追加了 ${c.appended} 条；${c.pushed} 个会话的窗口接不上，推进窗口起点、整段追加 ${c.pushedMessages} 条；` +
    `订单写入 ${c.ordersWritten} 张、作废 ${c.voided} 张（resync）` +
    (c.skippedVoided.size ? `、库里已作废没有恢复 ${c.skippedVoided.size} 张` : '') +
    `；被规范化的字符串 ${s.normalized} 条`
  );
}

// ---------------- export-sessions ----------------

/**
 * export-sessions（spec「导入、导出与切换」）：REPEATABLE READ READ ONLY 的 longRunning 事务里按批读出全部真实会话（窗口内的消息）
 * 与未作废订单，原 JSON 复制到 --keep，合并进 --var 下的两个 JSON（同 id 以库为准：库里作废了的订单从 JSON 里去掉），删掉标记文件。
 * 没有标记文件而 JSON 里有真实会话（已经导出过、文件存储下可能又跑过）：先与库里逐个比对，有不一致就以 2 拒绝（JSON 比库新，
 * 照常导出会把它们盖掉），全部一致就是已经导出过、什么都不动；库里还有 JSON 里没有的真实会话时照常导出（只把它们补进来）
 */
export async function exportSessions(o: TransferOptions): Promise<SessionsResult> {
  const lines: string[] = [];
  const stats: Partial<SessionStats> = {};
  const now = o.now ?? Date.now;
  try {
    const tenant = await findTenantBySlug(o.db, o.tenantSlug);
    if (!tenant) throw new Stop(EXIT.error, `tenant_not_found：没有 slug 为「${o.tenantSlug}」的租户`);
    checkKeep(o.keepDir, o.varDir);
    const lock = await o.lock(tenant.id);
    if (!lock) {
      throw new Stop(
        EXIT.locked,
        `lock_held：租户「${o.tenantSlug}」的锁在别的进程手里（应用还在跑？先 docker compose stop app），什么都没动`,
      );
    }
    let keepTo: KeepTo | null = null;
    try {
      lines.push(...checkSpill(o.varDir));
      keepTo = prepareKeep(o.keepDir, 'export', now());
      const markerFile = path.join(o.varDir, SESSIONS_IN_DB_MARKER);
      const marked = fs.existsSync(markerFile);
      const files = readVar(o.varDir);
      const { all, inDb } = await withTenant(
        o.db,
        ctxOf(tenant.id, 'export-sessions'),
        async (tx) => ({ all: await readAll(tx), inDb: new Set(await readOrderIdsIn(tx, [...files.orders.keys()])) }),
        { isolation: 'repeatable read', readOnly: true, longRunning: true },
      );
      const sp = split(files);
      if (!marked && sp.real.length) {
        const bad = firstDifference(sp, all);
        if (bad) {
          throw new Stop(
            EXIT.inconsistent,
            `会话不在库里（没有 ${SESSIONS_IN_DB_MARKER}），JSON 里的真实会话 ${short(bad.id)} 与库里不一致（${bad.why}）：JSON 比库新，` +
              'export 会覆盖它们；什么都没动。要切回 db 存储请用 import-sessions --resync',
          );
        }
        if ([...all.keys()].every((id) => files.sessions.has(id))) {
          stats.sessions = 0;
          lines.push(`没有 ${SESSIONS_IN_DB_MARKER}，JSON 里的 ${sp.real.length} 个真实会话与库里逐个一致：已经导出过，什么都没动`);
          return { code: EXIT.ok, lines, stats };
        }
      }
      const sessions = new Map(files.sessions);
      const orders = new Map(files.orders);
      const live = new Map<string, Order>();
      let messages = 0;
      for (const c of all.values()) {
        sessions.set(c.session.id, c.session);
        messages += c.session.messages.length;
        for (const ord of c.orders) live.set(ord.id, ord);
      }
      for (const id of inDb) if (!live.has(id)) orders.delete(id);
      for (const [id, ord] of live) orders.set(id, ord);
      // 先 orders.json、再 sessions.json、最后删标记：中途崩溃时要么只多出几张订单（所属会话不在 JSON 里，下次 import 当孤儿留着、
      // db 存储预载时认出库里已有而丢掉），要么标记还在（文件存储照旧拒绝启动）。再跑一次就好
      try {
        stats.kept = keepOriginals(keepTo, o.varDir);
        fs.mkdirSync(o.varDir, { recursive: true });
        writeAtomic(path.join(o.varDir, ORDERS_JSON), jsonOf([...orders.values()]));
        writeAtomic(path.join(o.varDir, SESSIONS_JSON), jsonOf([...sessions.values()]));
        fs.rmSync(markerFile, { force: true });
        fsyncDir(o.varDir);
      } catch (e) {
        throw new Stop(
          EXIT.error,
          `复制原件或改写数据目录失败（${errLabel(e)}）：库没动、标记文件还在，修好原因后再跑一次 export-sessions`,
        );
      }
      Object.assign(stats, {
        sessions: all.size,
        messages,
        orders: live.size,
        dbSessions: all.size,
        jsonSessions: sessions.size,
        jsonOrders: orders.size,
      });
      lines.push(`已导出 ${all.size} 个真实会话（窗口内 ${messages} 条消息）、${live.size} 张未作废订单`);
      lines.push(
        `合并进数据目录的两个 JSON（同 id 以库为准），现在是 ${sessions.size} 个会话、${orders.size} 张订单；删掉了 ${SESSIONS_IN_DB_MARKER}；` +
          `原件在 ${stats.kept ?? '（数据目录里原来没有 JSON）'}`,
      );
      return { code: EXIT.ok, lines, stats };
    } finally {
      if (keepTo && !stats.kept) keepTo.discard();
      await lock.release();
    }
  } catch (e) {
    if (e instanceof Stop) return { code: e.code, lines: [...lines, e.why], stats };
    return { code: EXIT.error, lines: [...lines, `出错：${errLabel(e)}${e instanceof Error ? ` ${e.message}` : ''}`], stats };
  }
}
