// 会话存储自测（docs/architecture/02-conversations-workbench/spec.md「测试与 CI」）。
// 文件后端的部分（plan 第 2 步）：seq 的两种分配模式、flushSession 等到落盘、事件在落盘之后、
// SESSION_STORE 的非法组合与 boot() 的失败分支、标记文件、三段停机的顺序与时限、导入期行为与模式无关。
// 第 5 步：投影的往返（纯函数）；PG 后端的 PGlite 部分（子进程里：预载往返与校验、写队列的顺序与合并、冻结、窗口推进、
// 重置作废、事件只在提交后、COMMIT 断线后认出已提交、数据类错误与 poisoned、NUL 与切开的 emoji、存档点、chat() 与 withTenant、
// 一轮不查库、孤儿订单的收养与交接、同一段同步代码的改动合进一个事务、spill 回放的接续判定与错误类型、drain、租户锁被拿走后不写库；
// 落盘的 PGlite 上一串「启动」：20 轮后 SIGTERM、一轮中间 SIGTERM（都让最后一次落库卡在退避里，靠 drain 段排空）、
// drain 段 PG 不可写写出 spill 与回放（含在途快照的附带行与作废）、spill_conflict、模拟崩溃、另一写者、孤儿订单重启不复活、late 段之后不落库）；
// 真实 Postgres 部分有 PG_TEST_URL 才跑（第二个进程拒绝启动、另一写者、COMMIT 之后回包丢掉、新会话 COMMIT 晚到）。
// 第 6 步：导入导出与切换（落盘的 PGlite 上一步一个子进程：首次导入与往返、各种拒绝、重复导入、补完改写、内容不同、读回不等、
// db 存储启动、导出、文件存储下再聊、--resync、再以 db 存储启动；真实 PG 上以子进程执行两个命令行，持锁的是真的 server.ts）。
// 用法：npx tsx src/store/store.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { ChatMessage, Order, Session } from '../types.js';

/** 第 6 步导入导出夹具里的真实会话 id（子进程入口在下面就要用，所以放在最前面） */
const XFER = { alpha: 'wecom:wmXferAlpha01', beta: 'wecom:wmXferBeta02', gamma: 'wecom:wmXferGamma03', delta: 'wecom:wmXferDelta04' };

// PG 会话存储的几组在子进程里跑：本文件带上 STORE_SELFTEST_CHILD 再起一次自己（见文件末尾的 childMain）
const CHILD_MODE = process.env.STORE_SELFTEST_CHILD ?? '';
if (CHILD_MODE) await childMain(CHILD_MODE);

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

// ---------------- project：会话、订单、消息与行的往返（纯函数，plan 第 5 步） ----------------
{
  const p = await import('./project.js');
  const NUL = String.fromCharCode(0);
  const LONE = String.fromCharCode(0xd83d); // 孤立的高位代理项
  const REPL = String.fromCharCode(0xfffd);
  const UID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  /** 模拟库：json 列按文本存取（键序原样），timestamptz 按毫秒往返 */
  const viaJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const viaDbMsg = (r: ReturnType<typeof p.messageToRow>) => ({
    ...r,
    at: new Date(r.at.getTime()),
    sentAt: r.sentAt && new Date(r.sentAt.getTime()),
    extra: r.extra && viaJson(r.extra),
  });
  const t0 = 1_760_000_000_000;
  const messages: ChatMessage[] = [
    { role: 'customer', content: '想去云南', at: t0, msgid: 'msgA1', sentAt: t0 - 1500 },
    { role: 'agent', content: '好的，几位出行？', at: t0 + 1000 }, // agent 而没有 author：缺省 ai
    { role: 'agent', content: '我是顾问小林', at: t0 + 2000, author: 'human', authorId: UID, authorName: '小林' },
    { role: 'agent', content: '共享工作台回复', at: t0 + 3000, author: 'human', authorId: null, authorName: '共享工作台' },
    { role: 'agent', content: '还在考虑吗', at: t0 + 4000, author: 'followup' },
    { role: 'system', content: 'AI 已转人工：客户投诉', at: t0 + 5000, card: { kind: 'handoff', n: 1 }, tag: 'x' } as ChatMessage,
    // 已知字段放不进列的：customer 带 author、非 human 带 authorName、authorId 不是 uuid、msgid 不是串
    { role: 'customer', content: `含${NUL}的话${LONE}`, at: t0 + 6000, author: 'ai', authorName: '冒名' } as ChatMessage,
    {
      role: 'agent',
      content: '怪 id',
      at: t0 + 7000,
      author: 'human',
      authorId: 'not-a-uuid',
      authorName: '某人',
      msgid: 42,
    } as unknown as ChatMessage,
  ];
  const sessionObj = {
    id: 'wecom:wmRoundTrip1',
    channel: 'wecom',
    stage: 'quote',
    profile: { destinationInterest: '云南', segment: '带爸妈', travelers: '4', nickname: `小王${NUL}🙂${LONE}`, notes: ['爸妈腿脚慢'] },
    messages,
    orderIds: ['ord_1a2b3c4d', 'ord_0123456789abcdef01234567'],
    handedOver: true,
    createdAt: t0 - 86_400_000,
    updatedAt: t0 + 7000,
    lastQuote: { routeId: 'r-yunnan-mid', routeTitle: '云南', travelers: 4, perPerson: 3280, total: 13120, departDate: '2026-11-01' },
    quoteHistory: [{ routeId: 'r-yunnan-mid', travelers: 4, perPerson: 3280, total: 13120, departDate: '2026-11-01' }],
    stageBeforeHandoff: 'quote',
    followup: { count: 1, stages: ['quote'], lastAt: t0 - 3600_000, failures: 0 },
    handoff: { kind: 'complaint', at: t0 + 5000, reason: '客户投诉', quote: '你们太差了', departNote: '（11月1号出发）' },
    firstHandoffAt: t0 - 7200_000,
    handoffCount: 2,
    assignee: { userId: null, name: '共享工作台', at: t0 + 3000 },
    lastShownRoutes: undefined, // 值为 undefined 的键：JSON 里没有它
    futureField: { nested: [1, 'two', null, `three${NUL}`] }, // 将来的字段：原样往返
  } as unknown as Session;

  const row = p.sessionToRow(sessionObj);
  const msgRows = sessionObj.messages.map((m, i) => p.messageToRow(m, i + 1));
  const rebuilt = p.rowToSession(
    { state: viaJson(row.state) },
    msgRows.map((r) => p.rowToMessage(viaDbMsg(r))),
  );
  const expected = p.normalizeForStore(sessionObj);
  check(
    'project：会话经投影再重建，与 normalizeForStore 之后的原对象 deepStrictEqual',
    isDeepStrictEqual(rebuilt, expected),
    JSON.stringify(rebuilt).slice(0, 300),
  );
  check(
    'project：state 不含 messages，键序与原对象相同',
    Object.keys(row.state).join() ===
      Object.keys(expected)
        .filter((k) => k !== 'messages')
        .join(),
  );
  check(
    'project：state 里值为 undefined 的键去掉',
    !('lastShownRoutes' in row.state) && !JSON.stringify(row.state).includes('lastShownRoutes'),
  );
  check(
    'project：投影列取自会话（转人工、接手人、客户最后一条的 sentAt）',
    row.id === 'wecom:wmRoundTrip1' &&
      row.handedOver &&
      row.handoffKind === 'complaint' &&
      row.handoffAt?.getTime() === t0 + 5000 &&
      row.firstHandoffAt?.getTime() === t0 - 7200_000 &&
      row.assigneeUserId === null &&
      row.assigneeName === '共享工作台' &&
      row.lastCustomerAt?.getTime() === t0 + 6000 &&
      row.createdAt.getTime() === t0 - 86_400_000 &&
      row.updatedAt.getTime() === t0 + 7000,
  );
  const nick = (row.state.profile as { nickname: string }).nickname;
  check('project：昵称里的 NUL 去掉、孤立代理项换成 U+FFFD', nick === `小王🙂${REPL}`, JSON.stringify(nick));
  check('project：重建后的消息不含 NUL 与孤立代理项', rebuilt.messages[6]!.content === `含的话${REPL}`);
  const [c1, a1, h1, h2, f1, sys, odd1, odd2] = msgRows;
  check('project：客户消息的 msgid、sentAt 进列', c1!.msgid === 'msgA1' && c1!.sentAt?.getTime() === t0 - 1500 && c1!.extra === null);
  check(
    'project：role=agent 而没有 author 的，author 列为 NULL，重建后也没有 author 键',
    a1!.author === null && !('author' in rebuilt.messages[1]!),
  );
  check(
    'project：author=human 带 authorId / authorName 进列',
    h1!.author === 'human' && h1!.authorUserId === UID && h1!.authorName === '小林' && h1!.extra === null,
  );
  check(
    'project：共享工作台的 authorId 为 null，往返后仍是 null',
    h2!.authorUserId === null && h2!.authorName === '共享工作台' && rebuilt.messages[3]!.authorId === null,
  );
  check('project：author=followup 进列，不带操作者', f1!.author === 'followup' && f1!.authorUserId === null && f1!.authorName === null);
  check('project：已知字段以外的键进 extra', isDeepStrictEqual(sys!.extra, { card: { kind: 'handoff', n: 1 }, tag: 'x' }));
  check(
    'project：customer 带的 author、authorName 不进列（messages_author_human_check 的 NULL 语义由投影守住）',
    odd1!.author === null &&
      odd1!.authorName === null &&
      odd1!.authorUserId === null &&
      isDeepStrictEqual(odd1!.extra, { author: 'ai', authorName: '冒名' }),
  );
  check(
    'project：authorId 不是 uuid、msgid 不是串的，原值进 extra，列为 NULL',
    odd2!.author === 'human' &&
      odd2!.authorUserId === null &&
      odd2!.authorName === '某人' &&
      odd2!.msgid === null &&
      isDeepStrictEqual(odd2!.extra, { authorId: 'not-a-uuid', msgid: 42 }),
  );
  check(
    'project：消息的行投影里没有一条「没有 author 却带操作者」',
    msgRows.every((r) => r.author === 'human' || (r.authorUserId === null && r.authorName === null)),
  );

  const orderOld = {
    id: 'ord_1a2b3c4d', // 旧格式：8 位十六进制
    sessionId: 'wecom:wmRoundTrip1',
    routeId: 'r-yunnan-mid',
    routeTitle: `云南${NUL}环线`,
    travelers: 4,
    departDate: '2026-11-01',
    totalPrice: 13120,
    status: 'superseded',
    createdAt: t0 - 3600_000,
    supersededBy: 'ord_0123456789abcdef01234567',
    legacyNote: { from: '01' },
  } as unknown as Order;
  const orderNew = {
    id: 'ord_0123456789abcdef01234567',
    sessionId: 'wecom:wmRoundTrip1',
    routeId: 'r-yunnan-mid',
    routeTitle: '云南环线',
    travelers: 4,
    departDate: '2026-11-01',
    totalPrice: 13120,
    status: 'paid',
    createdAt: t0 - 1800_000,
    paidAt: t0 - 600_000,
    handoffBeforePaid: true,
    confirmedAt: t0 - 900_000,
    confirmedBy: { userId: null, name: '共享工作台' },
  } as Order;
  for (const o of [orderOld, orderNew]) {
    const r = p.orderToRow(o);
    check(
      `project：订单 ${o.id} 经投影再重建，与 normalizeForStore 之后的原对象 deepStrictEqual`,
      isDeepStrictEqual(p.rowToOrder({ data: viaJson(r.data) }), p.normalizeForStore(o)),
    );
  }
  const ro = p.orderToRow(orderNew);
  check(
    'project：订单的列取自订单，未作废',
    ro.id === orderNew.id &&
      ro.sessionId === orderNew.sessionId &&
      ro.status === 'paid' &&
      ro.totalPrice === 13120 &&
      ro.paidAt?.getTime() === t0 - 600_000 &&
      ro.confirmedAt?.getTime() === t0 - 900_000 &&
      ro.voidedAt === null &&
      ro.voidReason === null,
  );
  const rv = p.orderToRow(orderNew, { at: t0, reason: 'reset' });
  check(
    'project：作废的订单带 voided_at 与原因，data 不变',
    rv.voidedAt?.getTime() === t0 && rv.voidReason === 'reset' && isDeepStrictEqual(rv.data, ro.data),
  );
  check('project：订单 data 里的 NUL 去掉', (p.orderToRow(orderOld).data.routeTitle as string) === '云南环线');

  const n = p.normalizeForStore({ a: undefined, b: [undefined, 1], d: new Date(t0), [`k${NUL}`]: 'v', ['__proto__']: { x: 1 } } as Record<
    string,
    unknown
  >);
  check(
    'normalizeForStore：按 JSON 的语义取（undefined 去掉或变 null、Date 变串），键也清洗，__proto__ 是自有键',
    !('a' in n) &&
      isDeepStrictEqual(n.b, [null, 1]) &&
      n.d === new Date(t0).toISOString() &&
      n.k === 'v' &&
      Object.getPrototypeOf(n) === Object.prototype &&
      Object.hasOwn(n, '__proto__'),
    JSON.stringify(n),
  );
  let projErr = '';
  try {
    p.sessionToRow({ ...sessionObj, createdAt: Number.NaN });
  } catch (e) {
    projErr = e instanceof p.ProjectionError ? e.field : String(e);
  }
  check('project：时间不是有限的毫秒数时抛 ProjectionError', projErr === 'createdAt', projErr);
  check(
    'project：isDemoClassId 与标记文件名在纯模块里，store 原样再导出',
    p.isDemoClassId('sim-x') &&
      p.isDemoClassId('wecom:cust_B01') &&
      !p.isDemoClassId('wecom:u1') &&
      p.SESSIONS_IN_DB_MARKER === 'sessions-in-db.json',
  );
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
  const proj = await import('./project.js');
  check(
    'store 再导出的 isDemoClassId、SESSIONS_IN_DB_MARKER 就是 project.ts 的',
    store.isDemoClassId === proj.isDemoClassId && store.SESSIONS_IN_DB_MARKER === proj.SESSIONS_IN_DB_MARKER,
  );
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
  // sessions.json 里有真实会话（wecom:u1、wecom:u2）：预载之前就以 real_in_json 拒绝，库一下都不碰（db 给的是个空对象），JSON 原样不动
  const sjBefore = fs.readFileSync(SESSIONS_FILE, 'utf8');
  const ojBefore = fs.readFileSync(ORDERS_FILE, 'utf8');
  let dbReason = '';
  let dbDetail = '';
  await store.initSessionStore({ db: {} as never, tenantId: 't', tenantSlug: 't', varDir: VAR_DIR }).catch((e: unknown) => {
    dbReason = e instanceof SessionStoreStartupError ? e.reason : String(e);
    dbDetail = e instanceof SessionStoreStartupError ? e.detail : '';
  });
  await sleep(250); // 有落盘的话也该落完了
  check(
    'initSessionStore(deps)：sessions.json 里有真实会话 → 预载之前以 real_in_json 拒绝（提示 import-sessions，只写短码），仍是文件存储',
    dbReason === 'real_in_json' &&
      dbDetail.includes('import-sessions') &&
      dbDetail.includes(' 2 个真实会话') &&
      !dbDetail.includes('wecom:u1') &&
      store.sessionStoreMode() === 'file' &&
      store.getSession('wecom:u1') !== undefined,
    `${dbReason} ${dbDetail}`,
  );
  check(
    'initSessionStore(deps)：real_in_json 拒绝时 JSON 原样不动',
    fs.readFileSync(SESSIONS_FILE, 'utf8') === sjBefore && fs.readFileSync(ORDERS_FILE, 'utf8') === ojBefore,
  );
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

let realPgRan = false;
await pgSuites();

if (fails.length) {
  console.error(`STORE SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `STORE SELFTEST PASS: ${pass} 项断言全通（seq 的严格与宽松模式 / 投影往返 / 文件后端读 JSON、flushSession 等落盘、事件在落盘之后、落盘失败不发事件 / 标记文件 / SESSION_STORE 校验 / boot 的失败分支 / 三段停机的顺序与时限 / SIGTERM / 导入期与模式无关 / healthz / PGlite：预载往返与校验、写队列、冻结、窗口推进、重置作废、事件在提交后、COMMIT 断线、poisoned、存档点、chat() 与 withTenant、一轮不查库、孤儿订单、spill 回放、drain、重启与崩溃 / 导入导出：往返、重复导入、补完改写、内容不同、持锁、--keep、spill、导出 → 文件存储 → --resync → db 存储${realPgRan ? ' / 真实 PG：第二个进程、另一写者、COMMIT 之后回包丢掉、两个命令行的退出码' : '；真实 PG 部分未跑'}）`,
);
process.exit(0);

// ======================================================================================
// PG 会话存储（plan 第 5 步）。几组都在子进程里跑：本文件带上 STORE_SELFTEST_CHILD 再起一次自己（childMain），
// 每个子进程有干净的 VAR_DIR 与 store 模块；「重启」类在前后两个子进程之间交接同一个落盘的 PGlite；
// 真实 Postgres 的几组有 PG_TEST_URL 才跑。子进程把结果同步写进 STORE_CHILD_RESULT 指的文件（被信号杀掉之前也来得及）
// ======================================================================================

interface ChildResult {
  pass: number;
  fails: string[];
  data: Record<string, unknown>;
}
type Ck = (name: string, cond: boolean, detail?: string) => void;
type StoreMod = typeof import('../store.js');

/** 子进程入口。mode：pg（PGlite 上的进程内各组）、disk（落盘的 PGlite：重启、停机、崩溃、spill）、rpg（真实 Postgres） */
async function childMain(mode: string): Promise<never> {
  const res: ChildResult = { pass: 0, fails: [], data: {} };
  const ck: Ck = (name, cond, detail = '') => {
    if (cond) res.pass += 1;
    else res.fails.push(`${name}${detail ? ' — ' + detail : ''}`);
  };
  const save = (): void => fs.writeFileSync(process.env.STORE_CHILD_RESULT!, JSON.stringify(res));
  try {
    if (mode === 'pg') await childPg(ck);
    else if (mode === 'disk') await childDisk(res, save);
    else if (mode === 'rpg') await childRealPg(res, save);
    else if (mode === 'xfer') await childXfer(ck, res);
    else res.fails.push(`未知的子进程模式 ${mode}`);
  } catch (e) {
    res.fails.push(`子进程 ${mode} 抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  save();
  process.exit(0);
}

/** identity map 里的真实会话与订单，经 JSON.parse(JSON.stringify(…)) 规范化（验收 4） */
function memDump(store: StoreMod): { sessions: Session[]; orders: Order[] } {
  const sessions = store
    .listSessions()
    .filter((s) => !store.isDemoClassId(s.id))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const orders = store
    .listOrders()
    .filter((o) => !store.isDemoClassId(o.sessionId))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return JSON.parse(JSON.stringify({ sessions, orders })) as { sessions: Session[]; orders: Order[] };
}

function wellFormed(x: string): boolean {
  return (x as unknown as { isWellFormed(): boolean }).isWellFormed();
}

function traceRow(id: string, conversationId: string) {
  return {
    id,
    conversationId,
    startedAt: new Date(),
    durationMs: 12,
    outcome: 'replied' as const,
    sopVersion: null,
    prefixHash: 'a'.repeat(64),
    catalogVersions: {},
    stageBefore: 'greeting',
    stageAfter: 'discovery',
    draft: null,
    finalText: '好的',
    calls: [],
    llm: [],
    signals: null,
  };
}

// ---------------- 导入导出的夹具（plan 第 6 步，验收 3） ----------------

/**
 * 一份 var/：真实会话三个（followup、quoteHistory、昵称、转人工记录、author、消息上的未知键、空窗口）、种子与访客各一、
 * 孤儿订单、旧格式订单号。NUL 与孤立代理项运行时构造（不写进源码字面量）：被 normalizeForStore 改动的字符串恰好 5 条，
 * 都在真实会话与它们的订单里；种子里另有一个 NUL，不进库、不计数
 */
function xferFixture(): { sessions: Session[]; orders: Order[]; real: string[]; normalized: number; messages: number } {
  const NUL = String.fromCharCode(0);
  const HI = String.fromCharCode(0xd83d);
  const LO = String.fromCharCode(0xdc00);
  const t0 = Date.parse('2026-09-20T08:00:00.000Z');
  const ordNew = `ord_${'a1'.repeat(12)}`;
  const ordOld = 'ORD-20240501-0007';
  const ordBeta = `ord_${'b2'.repeat(12)}`;
  const alpha = {
    id: XFER.alpha,
    channel: 'wecom',
    stage: 'quote',
    profile: { destinationInterest: '云南', travelers: '2人', nickname: `小王${NUL}` },
    messages: [
      { role: 'customer', content: '你好，想去云南', at: t0, msgid: 'xfer-msg-a1', sentAt: t0 - 1500 },
      { role: 'agent', content: '您好，云南有几条线路可以选', at: t0 + 1000 },
      { role: 'customer', content: `两个人${NUL}多少钱`, at: t0 + 60_000, msgid: 'xfer-msg-a2', sentAt: t0 + 59_000 },
      { role: 'agent', content: '两位一共 6,560 元', at: t0 + 61_000 },
      { role: 'system', content: '已为客户生成订单', at: t0 + 62_000 },
    ],
    orderIds: [ordOld, ordNew],
    handedOver: false,
    createdAt: t0 - 5000,
    updatedAt: t0 + 62_000,
    lastQuote: { routeId: 'r-yunnan-mid', routeTitle: '云南', travelers: 2, perPerson: 3280, total: 6560, departDate: '2026-11-01' },
    quoteHistory: [
      { routeId: 'r-yunnan-mid', travelers: 2, perPerson: 3500, total: 7000, departDate: '2026-12-30' },
      { routeId: 'r-yunnan-mid', travelers: 2, perPerson: 3280, total: 6560, departDate: '2026-11-01' },
    ],
    seenRouteIds: ['r-yunnan-mid'],
    followup: { count: 1, stages: ['quote'], lastAt: t0 + 3_600_000 },
  };
  const beta = {
    id: XFER.beta,
    channel: 'wecom',
    stage: 'handoff',
    stageBeforeHandoff: 'discovery',
    profile: { nickname: '李姐', segment: 'parents' },
    messages: [
      { role: 'customer', content: '带爸妈去贵州', at: t0 + 100_000 },
      { role: 'agent', content: `可以的${HI}`, at: t0 + 101_000 },
      { role: 'agent', content: '方案书已发您', at: t0 + 102_000, card: { [`title${LO}`]: '贵州' } },
      { role: 'agent', content: '您好，还在考虑吗', at: t0 + 200_000, author: 'followup' },
      { role: 'customer', content: '我要人工', at: t0 + 300_000 },
      { role: 'system', content: 'AI 已转人工：客户要人工', at: t0 + 300_500 },
    ],
    orderIds: [ordBeta],
    handedOver: true,
    handoff: { kind: 'request', at: t0 + 300_500, reason: '客户要人工', quote: '我要人工' },
    firstHandoffAt: t0 + 300_500,
    handoffCount: 1,
    assignee: null,
    createdAt: t0 + 99_000,
    updatedAt: t0 + 300_500,
  };
  // 旧形状：没有任何可选字段，窗口是空的
  const gamma = {
    id: XFER.gamma,
    channel: 'wecom',
    stage: 'greeting',
    profile: {},
    messages: [],
    orderIds: [],
    handedOver: false,
    createdAt: t0 + 400_000,
    updatedAt: t0 + 400_000,
  };
  const seed = {
    id: 'wecom:cust_X01',
    channel: 'wecom',
    stage: 'paid',
    profile: {},
    messages: [{ role: 'customer', content: `种子${NUL}`, at: t0 }],
    orderIds: ['ord_seed_X01'],
    handedOver: false,
    createdAt: t0,
    updatedAt: t0,
  };
  const visitor = {
    id: 'sim-xfervisitor000001',
    channel: 'simulator',
    stage: 'greeting',
    profile: {},
    messages: [{ role: 'customer', content: '访客', at: t0 }],
    orderIds: [],
    handedOver: false,
    createdAt: t0,
    updatedAt: t0,
  };
  const order = (id: string, sessionId: string, extra: Record<string, unknown> = {}) => ({
    id,
    sessionId,
    routeId: 'r-yunnan-mid',
    routeTitle: '云南·大理丽江 6 日',
    travelers: 2,
    departDate: '2026-11-01',
    totalPrice: 6560,
    status: 'pending_payment',
    createdAt: t0 + 62_000,
    ...extra,
  });
  const orders = [
    order('ord_seed_X01', seed.id, { status: 'paid', paidAt: t0 + 1000 }),
    order(ordNew, XFER.alpha),
    order(`ord_${'d4'.repeat(12)}`, 'wecom:wmXferGone99', { createdAt: t0 - 86_400_000 }),
    order(ordOld, XFER.alpha, { routeTitle: `云南${LO}`, status: 'paid', paidAt: t0 + 63_000, totalPrice: 6000 }),
    order(ordBeta, XFER.beta, { createdAt: t0 + 102_000 }),
    order(`ord_${'c3'.repeat(12)}`, visitor.id),
  ];
  return {
    sessions: [seed, alpha, visitor, beta, gamma] as unknown as Session[],
    orders: orders as unknown as Order[],
    real: [XFER.alpha, XFER.beta, XFER.gamma],
    normalized: 5,
    messages: alpha.messages.length + beta.messages.length,
  };
}

// ---------------- 子进程 xfer：落盘的 PGlite 上的导入导出（一个子进程一步，XFER_STEP） ----------------
// import（首次导入与各种拒绝、重复导入、补完改写、内容不同、读回不等）→ dbstart（db 存储启动、再聊一轮）→ export →
// filechat（文件存储下再聊几轮、重置一个、新来一个）→ resync → dbstart2（db 存储启动，内存与库一致）
async function childXfer(ck: Ck, res: ChildResult): Promise<void> {
  const step = process.env.XFER_STEP ?? '';
  const v = process.env.VAR_DIR!;
  const keep = process.env.XFER_KEEP!;
  const { openTestDb, installPgSessionStore, fakeLock } = await import('../db/testing.js');
  const { withTenant } = await import('../db/client.js');
  const { readConversationsAfter } = await import('../db/repo/conversations.js');
  const { readMessagesFrom } = await import('../db/repo/messages.js');
  const { importSessions, exportSessions } = await import('../cli/session-transfer.js');
  const { isDemoClassId, normalizeForStore, rowToMessage, sessionState, SESSIONS_IN_DB_MARKER } = await import('./project.js');
  const t = await openTestDb({ dataDir: process.env.STORE_DATA_DIR! });
  // 主链用 demo 租户；中途崩溃（crash*）与补写标记（fresh）各用自己的租户与 var/
  const slug = process.env.XFER_SLUG ?? 'demo';
  const fx = await installPgSessionStore(t, { slug, varDir: v });
  // 命令行的库经 fixture 那个会计数的 db：看得到事务发出的 set transaction / set local
  const base = { db: fx.deps.db, tenantSlug: slug, varDir: v, keepDir: keep, lock: async () => fakeLock() };
  const su = <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  const counts = async (tenantSlug = slug): Promise<string> => {
    const [r] = await su<{ c: number; m: number; o: number; v: number }>(
      `select (select count(*)::int from conversations where tenant_id = t.id) c, (select count(*)::int from messages where tenant_id = t.id) m,
              (select count(*)::int from orders where tenant_id = t.id) o, (select count(*)::int from orders where tenant_id = t.id and voided_at is not null) v
         from tenants t where t.slug = $1`,
      [tenantSlug],
    );
    return `${r!.c}/${r!.m}/${r!.o}/${r!.v}`;
  };
  const read = (dir: string, f: string): string | null =>
    fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null;
  const files = (dir: string): string =>
    JSON.stringify([read(dir, 'sessions.json'), read(dir, 'orders.json'), read(dir, SESSIONS_IN_DB_MARKER)]);
  const keeps = (): string[] => (fs.existsSync(keep) ? fs.readdirSync(keep).toSorted() : []);
  const has = (r: { lines: string[] }, s: string): boolean => r.lines.some((l) => l.includes(s));
  const markerOf = (dir: string): { tenant?: string; at?: string; sessions?: number } | null =>
    JSON.parse(read(dir, SESSIONS_IN_DB_MARKER) ?? 'null') as { tenant?: string; at?: string; sessions?: number } | null;
  /** 记录时序的假锁：每次 release 的那一刻都记下数据目录的样子（两个 JSON 与标记文件），断言锁一直持到最后一次写之后 */
  const timedLock = (dir: string) => {
    const at: string[] = [];
    return {
      at,
      lock: async () => {
        const l = fakeLock();
        const release = l.release;
        l.release = async () => {
          at.push(files(dir));
          await release();
        };
        return l;
      },
    };
  };
  /** 一次 fs 调用抛错（模拟磁盘或权限出错），跑完 fn 再换回来 */
  const failing = async <R>(name: 'copyFileSync', fn: () => Promise<R>): Promise<R> => {
    const real = fs[name];
    fs[name] = (() => {
      throw Object.assign(new Error('模拟的文件系统错误'), { code: 'EIO' });
    }) as never;
    try {
      return await fn();
    } finally {
      fs[name] = real;
    }
  };
  /**
   * 照常执行 fn，同时按先后记下数据目录 dir 里的改名、删除与对 dir 本身的 fsync：看改写 var/ 的顺序，
   * 以及每次改名、删除之后都把目录落了盘（崩溃之后改名的先后也成立）
   */
  const traced = async <R>(dir: string, fn: () => Promise<R>): Promise<{ r: R; ops: string[] }> => {
    const ops: string[] = [];
    const real = { renameSync: fs.renameSync, rmSync: fs.rmSync, fsyncSync: fs.fsyncSync };
    const ino = fs.statSync(dir).ino;
    const inDir = (p: fs.PathLike): boolean => path.dirname(path.resolve(String(p))) === path.resolve(dir);
    fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      real.renameSync(a, b);
      if (inDir(b)) ops.push(`rename ${path.basename(String(b))}`);
    }) as typeof fs.renameSync;
    fs.rmSync = ((p: fs.PathLike, opts?: fs.RmOptions) => {
      real.rmSync(p, opts);
      if (inDir(p)) ops.push(`rm ${path.basename(String(p))}`);
    }) as typeof fs.rmSync;
    fs.fsyncSync = ((fd: number) => {
      real.fsyncSync(fd);
      if (fs.fstatSync(fd).ino === ino) ops.push('fsync dir');
    }) as typeof fs.fsyncSync;
    try {
      return { r: await fn(), ops };
    } finally {
      Object.assign(fs, real);
    }
  };
  const fx6 = xferFixture();
  const realOf = (all: Session[]): Session[] => all.filter((s) => fx6.real.includes(s.id));
  const store = (): Promise<StoreMod> => import('../store.js');
  const { SessionStoreStartupError } = await import('./backend.js');
  const startupReason = async (st: StoreMod, deps: Parameters<StoreMod['initSessionStore']>[0]): Promise<string> =>
    st.initSessionStore(deps).then(
      () => 'ok',
      (e: unknown) => (e instanceof SessionStoreStartupError ? e.reason : String(e)),
    );

  if (step === 'import') {
    const pristine = files(v);
    // --dry-run：照样写进事务、读回比对，最后回滚；库与文件都不动
    const dry = await importSessions({ ...base, dryRun: true });
    ck(
      'import --dry-run：退出码 0，打印将写入的条数与往返结果',
      dry.code === 0 &&
        has(dry, 'dry-run：会写入 3 个真实会话、11 条消息、3 张订单') &&
        has(dry, `被规范化的字符串 ${fx6.normalized} 条`) &&
        has(dry, '读回与 JSON 逐个一致'),
      dry.lines.join(' / '),
    );
    ck(
      'import --dry-run：不写库、不改文件、不建 --keep',
      (await counts()) === '0/0/0/0' && files(v) === pristine && keeps().length === 0,
      await counts(),
    );

    // --keep 在 var/ 之内（含经符号链接绕进去的）拒绝
    const link = path.join(path.dirname(keep), `link-${path.basename(v)}`);
    fs.symlinkSync(v, link);
    for (const [label, keepDir] of [
      ['在 var/ 之下', path.join(v, 'keep')],
      ['就是 var/', v],
      ['经符号链接指进 var/', path.join(link, 'keep')],
    ] as const) {
      const r = await importSessions({ ...base, keepDir });
      ck(
        `import：--keep ${label}时拒绝（1），什么都没动`,
        r.code === 1 && has(r, '--keep') && (await counts()) === '0/0/0/0' && files(v) === pristine && !fs.existsSync(path.join(v, 'keep')),
        r.lines.join(' / '),
      );
    }
    fs.unlinkSync(link);
    // 拿不到租户锁（应用还在跑）
    const locked = await importSessions({ ...base, lock: async () => null });
    ck(
      'import：拿不到租户锁时退出码 3，什么都没动',
      locked.code === 3 && has(locked, 'lock_held') && (await counts()) === '0/0/0/0' && files(v) === pristine,
      locked.lines.join(' / '),
    );
    const lockedExp = await exportSessions({ ...base, lock: async () => null });
    ck(
      'export：拿不到租户锁时退出码 3，什么都没动',
      lockedExp.code === 3 && files(v) === pristine && keeps().length === 0,
      lockedExp.lines.join(' / '),
    );
    // 数据目录里有没回放的 spill
    const spill = path.join(v, 'store-spill-2026-10-01T00-00-00-000Z.json');
    fs.writeFileSync(spill, '{}');
    const spilled = await importSessions(base);
    ck(
      'import：数据目录里有没回放的 spill 时拒绝（1）并点名文件',
      spilled.code === 1 && has(spilled, 'store-spill-2026-10-01T00-00-00-000Z.json') && (await counts()) === '0/0/0/0',
      spilled.lines.join(' / '),
    );
    const spilledExp = await exportSessions(base);
    ck('export：数据目录里有没回放的 spill 时同样拒绝', spilledExp.code === 1 && has(spilledExp, 'spill') && files(v) === pristine);
    fs.unlinkSync(spill);
    const tenantless = await importSessions({ ...base, tenantSlug: 'no-such-tenant' });
    ck('import：没有这个租户时退出码 1', tenantless.code === 1 && has(tenantless, 'tenant_not_found'));

    // 首次导入（记录时序的锁：release 在写完标记与两个 JSON 之后）
    const modes0 = fx.stats.txModes.length;
    const firstLock = timedLock(v);
    const { r: first, ops: firstOps } = await traced(v, () => importSessions({ ...base, lock: firstLock.lock }));
    ck(
      'import：提交之后先写标记、再 sessions.json、再 orders.json，每次改名之后都 fsync 数据目录',
      firstOps.join() === 'rename sessions-in-db.json,fsync dir,rename sessions.json,fsync dir,rename orders.json,fsync dir',
      firstOps.join(),
    );
    ck(
      'import：一个 longRunning 事务（放宽语句超时与事务空闲超时）',
      fx.stats.txModes.slice(modes0).join() ===
        "set local statement_timeout = '60s',set local idle_in_transaction_session_timeout = '120s'",
      JSON.stringify(fx.stats.txModes.slice(modes0)),
    );
    ck(
      'import：首次导入退出码 0，打印真实会话数、消息数、订单数与被规范化的字符串条数',
      first.code === 0 &&
        has(first, '已导入 3 个真实会话、11 条消息、3 张订单') &&
        has(first, `被规范化的字符串 ${fx6.normalized} 条`) &&
        first.stats.normalized === fx6.normalized,
      first.lines.join(' / '),
    );
    ck('import：库里是 3 个会话、11 条消息、3 张订单（demo 类与孤儿订单不进库）', (await counts()) === '3/11/3/0', await counts());
    const rows = await su<{ id: string; last_seq: number; window_start_seq: number; flush_id: string | null; seqs: number[] | null }>(
      `select c.id, c.last_seq, c.window_start_seq, c.flush_id, (select array_agg(seq order by seq) from messages m where m.tenant_id = c.tenant_id and m.conversation_id = c.id) seqs
         from conversations c order by c.id`,
    );
    ck(
      'import：消息按数组下标写 seq（从 1 起），window_start_seq = 1，last_seq = 消息条数',
      rows.length === 3 &&
        rows.every((r) => {
          const n = (fx6.sessions.find((s) => s.id === r.id)?.messages ?? []).length;
          return (
            r.window_start_seq === 1 &&
            r.last_seq === n &&
            r.flush_id === null &&
            (r.seqs ?? []).join() === Array.from({ length: n }, (_, i) => i + 1).join()
          );
        }),
      JSON.stringify(rows),
    );
    const states = await su<{ id: string; state: Record<string, unknown> }>('select id, state from conversations');
    ck(
      'import：state 是会话去掉 messages 之后经 normalizeForStore 的原样（昵称里的 NUL 去掉了）',
      states.every((r) => isDeepStrictEqual(r.state, sessionState(fx6.sessions.find((s) => s.id === r.id)!))) &&
        (states.find((r) => r.id === XFER.alpha)?.state.profile as { nickname?: string } | undefined)?.nickname === '小王',
    );
    const odata = await su<{ id: string; data: Record<string, unknown> }>('select id, data from orders');
    ck(
      'import：订单 data 原样（经 normalizeForStore），旧格式订单号照收',
      odata.length === 3 &&
        odata.every((r) => isDeepStrictEqual(r.data, normalizeForStore(fx6.orders.find((o) => o.id === r.id)))) &&
        odata.some((r) => r.id === 'ORD-20240501-0007'),
      JSON.stringify(odata.map((r) => r.id)),
    );
    const demoSessions = fx6.sessions.filter((s) => !fx6.real.includes(s.id));
    const keptOrders = fx6.orders.filter((o) => !fx6.real.includes(o.sessionId));
    const rewritten = files(v);
    ck(
      'import：JSON 改写成只剩 demo 类会话与 demo 类、孤儿订单（与文件后端同一种写法，种子里的 NUL 原样留着）',
      read(v, 'sessions.json') === JSON.stringify(demoSessions, null, 2) &&
        read(v, 'orders.json') === JSON.stringify(keptOrders, null, 2) &&
        keptOrders.length === 3 &&
        (read(v, 'sessions.json') ?? '').includes('种子\\u0000'),
    );
    const marker = markerOf(v);
    ck(
      'import：写了标记文件 { tenant, at, sessions }，没留下临时文件',
      marker?.tenant === 'demo' &&
        marker.sessions === 3 &&
        !Number.isNaN(Date.parse(marker.at ?? '')) &&
        fs.readdirSync(v).every((f) => !f.endsWith('.tmp')),
      JSON.stringify(marker),
    );
    ck(
      'import：租户锁一直持到写完标记文件与两个 JSON 之后才放（release 那一刻数据目录已是最终的样子）',
      firstLock.at.length > 0 && firstLock.at.every((f) => f === rewritten),
      firstLock.at.map((f) => f.slice(0, 80)).join(' | '),
    );
    const k1 = keeps();
    ck(
      'import：原件逐字节复制到 --keep 下新建的目录（--keep 原来不存在也行）',
      k1.length === 1 &&
        first.stats.kept === path.join(keep, k1[0]!) &&
        JSON.stringify([read(first.stats.kept, 'sessions.json'), read(first.stats.kept, 'orders.json'), null]) === pristine,
      k1.join(),
    );

    // 再导入一次：JSON 里没有真实会话、有标记 → 0，什么都不动
    const again = await importSessions(base);
    ck(
      'import：再导入一次退出码 0（已经导入过），库与文件都没动',
      again.code === 0 && has(again, '已经导入过') && (await counts()) === '3/11/3/0' && files(v) === rewritten && keeps().length === 1,
      again.lines.join(' / '),
    );
    const againResync = await importSessions({ ...base, resync: true });
    ck(
      'import --resync：JSON 里没有真实会话、有标记时同样 0、不动',
      againResync.code === 0 && has(againResync, '已经导入过') && files(v) === rewritten,
    );

    // 补完改写：提交之后、改写 JSON 之前崩了（JSON 还是原件、没有标记）→ 逐个一致，补完改写与标记，0
    fs.copyFileSync(path.join(first.stats.kept!, 'sessions.json'), path.join(v, 'sessions.json'));
    fs.copyFileSync(path.join(first.stats.kept!, 'orders.json'), path.join(v, 'orders.json'));
    fs.unlinkSync(path.join(v, SESSIONS_IN_DB_MARKER));
    const dryFinish = await importSessions({ ...base, dryRun: true });
    ck(
      'import --dry-run：库里已有、逐个一致时只说会补完改写，什么都不动',
      dryFinish.code === 0 && has(dryFinish, '会补完改写') && files(v) === pristine,
      dryFinish.lines.join(' / '),
    );
    const finish = await importSessions(base);
    ck(
      'import：库里已有、JSON 里的真实会话与库里逐个一致 → 补完改写 JSON 与标记，退出码 0，库没动',
      finish.code === 0 &&
        has(finish, '逐个一致：补完改写') &&
        (await counts()) === '3/11/3/0' &&
        read(v, 'sessions.json') === JSON.stringify(demoSessions, null, 2) &&
        read(v, 'orders.json') === JSON.stringify(keptOrders, null, 2) &&
        markerOf(v)?.sessions === 3 &&
        keeps().length === 2,
      finish.lines.join(' / '),
    );

    // 改写完 JSON、写标记之前崩了（JSON 已经只剩 demo 类、没有标记）：同样逐个一致（JSON 里没有真实会话），补写标记，0
    fs.unlinkSync(path.join(v, SESSIONS_IN_DB_MARKER));
    const finishMarker = await importSessions(base);
    ck(
      'import：JSON 已只剩 demo 类而没有标记文件 → 补完改写、补写标记，退出码 0',
      finishMarker.code === 0 &&
        has(finishMarker, '逐个一致：补完改写') &&
        markerOf(v)?.tenant === 'demo' &&
        markerOf(v)?.sessions === 3 &&
        (await counts()) === '3/11/3/0',
      finishMarker.lines.join(' / '),
    );

    // 一批 500 个：1001 个会话分批写、按预载的循环分三批读回。--keep 写不进去在开事务之前就以 1 退出；
    // 提交之后、写完标记而改写 JSON 之前失败 → 1、说明库已提交；修好再跑一次补完改写；再导出（读的也不止一页）
    await su(`insert into tenants (slug, name, pack_id) values ('demo3', 'demo3', 'travel') on conflict (slug) do nothing`);
    const many = fs.mkdtempSync(path.join(path.dirname(v), 'xfer-many-'));
    const t1 = Date.parse('2026-09-21T00:00:00.000Z');
    const manySessions = Array.from({ length: 1001 }, (_, i) => ({
      id: `wecom:wmXferMany${String(i).padStart(4, '0')}`,
      channel: 'wecom',
      stage: 'greeting',
      profile: {},
      messages: [{ role: 'customer', content: `第 ${i} 位`, at: t1 + i }],
      orderIds: [],
      handedOver: false,
      createdAt: t1,
      updatedAt: t1 + i,
    }));
    fs.writeFileSync(path.join(many, 'sessions.json'), JSON.stringify(manySessions, null, 2));
    const manyBefore = files(many);
    const blocker = path.join(path.dirname(v), `xfer-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'x'); // --keep 的上级是个文件：建不了目录
    const blockedKeep = path.join(blocker, 'keep');
    for (const [label, run] of [
      ['import', () => importSessions({ ...base, tenantSlug: 'demo3', varDir: many, keepDir: blockedKeep })],
      ['import --dry-run', () => importSessions({ ...base, tenantSlug: 'demo3', varDir: many, keepDir: blockedKeep, dryRun: true })],
      ['export', () => exportSessions({ ...base, tenantSlug: 'demo3', varDir: many, keepDir: blockedKeep })],
    ] as const) {
      const tx0 = fx.stats.txModes.length;
      const r = await run();
      ck(
        `${label}：--keep 写不进去（上级是个文件）→ 开事务之前就以 1 退出、提示什么都没动，库与文件都没动`,
        r.code === 1 &&
          has(r, '--keep') &&
          has(r, '什么都没动') &&
          fx.stats.txModes.length === tx0 &&
          (await counts('demo3')) === '0/0/0/0' &&
          files(many) === manyBefore,
        `${r.lines.join(' / ')} ${await counts('demo3')} ${JSON.stringify(fx.stats.txModes.slice(tx0))}`,
      );
    }
    // 提交之后写完标记、改写 sessions.json 时失败（它的临时文件名被一个目录占着）
    fs.mkdirSync(path.join(many, 'sessions.json.tmp'));
    const manyKeeps = keeps().length;
    const broken = await importSessions({ ...base, tenantSlug: 'demo3', varDir: many });
    ck(
      'import：1001 个会话分批写入、读回逐个一致后提交；之后先写好标记，改写 JSON 时失败 → 退出码 1，说明库已提交、再跑一次会补完改写',
      broken.code === 1 &&
        has(broken, '库已提交') &&
        (await counts('demo3')) === '1001/1001/0/0' &&
        markerOf(many)?.sessions === 1001 &&
        read(many, 'sessions.json') === JSON.parse(manyBefore)[0] &&
        keeps().length === manyKeeps + 1,
      `${broken.lines.join(' / ')} ${await counts('demo3')}`,
    );
    fs.rmdirSync(path.join(many, 'sessions.json.tmp'));
    const recovered = await importSessions({ ...base, tenantSlug: 'demo3', varDir: many });
    ck(
      'import：修好之后再跑一次 → 逐个一致、补完改写，退出码 0，标记文件记的是库里的 1001 个',
      recovered.code === 0 &&
        has(recovered, '库里已有这 1001 个真实会话、逐个一致：补完改写') &&
        recovered.stats.dbSessions === 1001 &&
        read(many, 'sessions.json') === '[]' &&
        markerOf(many)?.tenant === 'demo3' &&
        markerOf(many)?.sessions === 1001,
      recovered.lines.join(' / '),
    );
    const manyExp = await exportSessions({ ...base, tenantSlug: 'demo3', varDir: many });
    const manyJson = JSON.parse(read(many, 'sessions.json') ?? '[]') as Session[];
    ck(
      'export：1001 个真实会话（不止一页）全部导出进 JSON，删掉标记文件',
      manyExp.code === 0 &&
        manyExp.stats.sessions === 1001 &&
        new Set(manyJson.filter((s) => !isDemoClassId(s.id)).map((s) => s.id)).size === 1001 &&
        !fs.existsSync(path.join(many, SESSIONS_IN_DB_MARKER)),
      `${manyExp.lines.join(' / ')} ${manyJson.length}`,
    );

    // 内容不同：另一份 var/，库里已有会话
    const otherVar = (edit: (s: Session[], o: Order[]) => void): string => {
      const dir = fs.mkdtempSync(path.join(path.dirname(v), 'xfer-diff-'));
      const f = xferFixture();
      edit(f.sessions, f.orders);
      fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(f.sessions, null, 2));
      fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(f.orders, null, 2));
      return dir;
    };
    const diffs: [string, (s: Session[], o: Order[]) => void, string, string][] = [
      ['改了一条消息', (s) => void (s.find((x) => x.id === XFER.beta)!.messages[1]!.content = '改过的'), 'TA02', '第 2 条消息不同'],
      [
        '多一个库里没有的真实会话',
        (s) => void s.push({ ...s.find((x) => x.id === XFER.gamma)!, id: 'wecom:wmXferExtra77' }),
        'RA77',
        '库里没有这个会话',
      ],
      ['订单金额不同', (_s, o) => void (o.find((x) => x.id === 'ORD-20240501-0007')!.totalPrice = 1), 'HA01', '订单不同'],
      // 消息与订单都一样、只有 state 不同：同样不是「逐个一致」
      ['只改了 stage', (s) => void (s.find((x) => x.id === XFER.beta)!.stage = 'quote'), 'TA02', '字段 stage 不同'],
      ['只改了昵称', (s) => void (s.find((x) => x.id === XFER.alpha)!.profile.nickname = '小李'), 'HA01', '字段 profile 不同'],
    ];
    for (const [label, edit, code, why] of diffs) {
      const dir = otherVar(edit);
      const before = files(dir);
      const r = await importSessions({ ...base, varDir: dir });
      ck(
        `import：库里已有会话而 JSON ${label} → 退出码 2，点名短码 ${code}、提示 --resync，库与文件都没动`,
        r.code === 2 && has(r, code) && has(r, why) && has(r, '--resync') && (await counts()) === '3/11/3/0' && files(dir) === before,
        r.lines.join(' / '),
      );
    }

    // 首次导入时读回不等（at 不是整数毫秒，进库之后对不上）：回滚、退出码 2、点名第一个不等的会话
    await su(`insert into tenants (slug, name, pack_id) values ('demo2', 'demo2', 'travel') on conflict (slug) do nothing`);
    const lossy = otherVar((s) => {
      s.find((x) => x.id === XFER.beta)!.messages[3]!.at += 0.5;
      s.find((x) => x.id === XFER.gamma)!.messages.push({ role: 'customer', content: 'x', at: 1.25 });
    });
    const lossyBefore = files(lossy);
    const badDry = await importSessions({ ...base, tenantSlug: 'demo2', varDir: lossy, dryRun: true });
    ck(
      'import --dry-run：首次导入读回与 JSON 不等时同样退出码 2、点名第一个不等的会话短码，库与文件都没动',
      badDry.code === 2 &&
        has(badDry, 'TA02') &&
        has(badDry, '第 4 条消息不同') &&
        (await counts('demo2')) === '0/0/0/0' &&
        files(lossy) === lossyBefore,
      `${badDry.lines.join(' / ')} ${await counts('demo2')}`,
    );
    const bad = await importSessions({ ...base, tenantSlug: 'demo2', varDir: lossy });
    ck(
      'import：首次导入读回与 JSON 不等 → 回滚、退出码 2、点名第一个不等的会话短码，库与文件都没动',
      bad.code === 2 &&
        has(bad, 'TA02') &&
        has(bad, '第 4 条消息不同') &&
        has(bad, '已回滚') &&
        (await counts('demo2')) === '0/0/0/0' &&
        files(lossy) === lossyBefore,
      `${bad.lines.join(' / ')} ${await counts('demo2')}`,
    );
    res.data.imported = true;
    return;
  }

  // export 与 resync 这两步不起 store：store 在导入期读 JSON、退出时可能再写一遍，会盖掉命令行刚改写的文件（应用要求已停）
  if (step === 'export') {
    const pristine = files(v);
    const n0 = await counts();
    // --keep 在 var/ 之内（含经符号链接绕进去的）：export 同样拒绝
    const link = path.join(path.dirname(keep), `link-${path.basename(v)}`);
    fs.symlinkSync(v, link);
    for (const [label, keepDir] of [
      ['在 var/ 之下', path.join(v, 'keep')],
      ['就是 var/', v],
      ['经符号链接指进 var/', path.join(link, 'keep')],
    ] as const) {
      const r = await exportSessions({ ...base, keepDir });
      ck(
        `export：--keep ${label}时拒绝（1），什么都没动`,
        r.code === 1 && has(r, '--keep') && files(v) === pristine && !fs.existsSync(path.join(v, 'keep')),
        r.lines.join(' / '),
      );
    }
    fs.unlinkSync(link);
    // 复制原件失败：退出码 1，标记文件还在、两个 JSON 逐字节没变
    const kc = keeps().length;
    const copyFail = await failing('copyFileSync', () => exportSessions(base));
    ck(
      'export：复制原件失败 → 退出码 1、提示标记文件还在，两个 JSON 与标记文件逐字节没变，--keep 下没留下空目录',
      copyFail.code === 1 && has(copyFail, '标记文件还在') && files(v) === pristine && keeps().length === kc,
      copyFail.lines.join(' / '),
    );
    // 改写 JSON 中途失败（某个临时文件名被目录占着）：先 orders.json、再 sessions.json、最后删标记，
    // 停在哪一步都不会让之后的 import / --resync 作废订单
    for (const blocked of ['sessions.json.tmp', 'orders.json.tmp']) {
      fs.mkdirSync(path.join(v, blocked));
      const r = await exportSessions(base);
      ck(
        `export：${blocked} 写不了 → 退出码 1，标记文件还在、sessions.json 没变`,
        r.code === 1 &&
          fs.existsSync(path.join(v, SESSIONS_IN_DB_MARKER)) &&
          read(v, 'sessions.json') === JSON.parse(pristine)[0] &&
          (blocked === 'orders.json.tmp' ? files(v) === pristine : read(v, 'orders.json') !== JSON.parse(pristine)[1]),
        r.lines.join(' / '),
      );
      fs.rmdirSync(path.join(v, blocked));
      const imp = await importSessions(base);
      const rs = await importSessions({ ...base, resync: true });
      ck(
        `export 在 ${blocked} 处失败之后：import 与 --resync 都是 0（已经导入过），不作废任何订单`,
        imp.code === 0 && has(imp, '已经导入过') && rs.code === 0 && (await counts()) === n0 && n0.endsWith('/0'),
        `${imp.lines.join(' / ')} | ${rs.lines.join(' / ')} ${await counts()}`,
      );
      const [ps, po] = JSON.parse(pristine) as [string, string];
      fs.writeFileSync(path.join(v, 'sessions.json'), ps);
      fs.writeFileSync(path.join(v, 'orders.json'), po);
    }
    ck('export 的失败用例之后数据目录回到原样', files(v) === pristine);

    const before = { s: read(v, 'sessions.json'), o: read(v, 'orders.json'), n: await counts() };
    const k0 = keeps().length;
    const modes0 = fx.stats.txModes.length;
    const expLock = timedLock(v);
    const { r: exp, ops: expOps } = await traced(v, () => exportSessions({ ...base, lock: expLock.lock }));
    ck(
      'export：先 orders.json、再 sessions.json、最后删标记，每一步之后都 fsync 数据目录',
      expOps.join() === 'rename orders.json,fsync dir,rename sessions.json,fsync dir,rm sessions-in-db.json,fsync dir',
      expOps.join(),
    );
    const modes = fx.stats.txModes.slice(modes0);
    ck(
      'export：在 REPEATABLE READ READ ONLY 的 longRunning 事务里读',
      modes.some((q) => /repeatable read/i.test(q) && /read only/i.test(q)) && modes.some((q) => /statement_timeout = '60s'/.test(q)),
      JSON.stringify(modes),
    );
    ck(
      'export：退出码 0，打印导出的会话、消息与订单数',
      exp.code === 0 && has(exp, '已导出 3 个真实会话') && has(exp, '3 张未作废订单'),
      exp.lines.join(' / '),
    );
    ck('export：删掉了标记文件、库没动', !fs.existsSync(path.join(v, SESSIONS_IN_DB_MARKER)) && (await counts()) === before.n);
    ck(
      'export：租户锁一直持到写完两个 JSON、删掉标记文件之后才放',
      expLock.at.length > 0 && expLock.at.every((f) => f === files(v)) && JSON.parse(files(v))[2] === null,
      expLock.at.map((f) => f.slice(0, 80)).join(' | '),
    );
    ck(
      'export：原 JSON 逐字节复制到 --keep 下新建的目录',
      keeps().length === k0 + 1 &&
        !!exp.stats.kept &&
        read(exp.stats.kept, 'sessions.json') === before.s &&
        read(exp.stats.kept, 'orders.json') === before.o,
    );
    const sj = JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[];
    const oj = JSON.parse(read(v, 'orders.json') ?? '[]') as Order[];
    const was = { s: JSON.parse(before.s ?? '[]') as Session[], o: JSON.parse(before.o ?? '[]') as Order[] };
    ck(
      'export：合并进 JSON，demo 类会话、demo 类与孤儿订单原样留着',
      was.s.every((s) =>
        isDeepStrictEqual(
          sj.find((x) => x.id === s.id),
          s,
        ),
      ) &&
        was.o.every((o) =>
          isDeepStrictEqual(
            oj.find((x) => x.id === o.id),
            o,
          ),
        ) &&
        sj.length === was.s.length + 3 &&
        oj.length === was.o.length + 3,
      `${sj.length} ${oj.length}`,
    );
    res.data.exported = {
      sessions: sj.filter((s) => !isDemoClassId(s.id)).toSorted((a, b) => a.id.localeCompare(b.id)),
      orders: oj.filter((o) => !isDemoClassId(o.sessionId)).toSorted((a, b) => a.id.localeCompare(b.id)),
    };
    // 导出结果再交给 import-sessions：--resync 什么都不追加；不带 --resync 是逐个一致（dry-run 都不动库与文件）
    const exported = files(v);
    const dry = await importSessions({ ...base, resync: true, dryRun: true });
    ck(
      '导出结果交给 import-sessions --resync（dry-run）：退出码 0，库里已是这些，不追加、不推进、不作废，什么都没动',
      dry.code === 0 &&
        dry.stats.created === 0 &&
        dry.stats.appended === 0 &&
        dry.stats.pushed === 0 &&
        dry.stats.voided === 0 &&
        (await counts()) === before.n &&
        files(v) === exported,
      dry.lines.join(' / '),
    );
    const plainDry = await importSessions({ ...base, dryRun: true });
    ck(
      '导出结果原样交给 import-sessions（dry-run）：逐个一致，会补完改写',
      plainDry.code === 0 && has(plainDry, '会补完改写') && files(v) === exported,
    );
    // 没有标记文件时再 export：JSON 与库里逐个一致 → 已经导出过、0、什么都不动；文件存储下改过（JSON 比库新）→ 2、什么都不动；
    // 库里有 JSON 里没有的真实会话 → 照常导出，只把它补进来
    const k1 = keeps().length;
    const again = await exportSessions(base);
    ck(
      'export：没有标记文件、JSON 与库里逐个一致时再导出 → 退出码 0（已经导出过），文件与 --keep 都没动',
      again.code === 0 && has(again, '已经导出过') && files(v) === exported && keeps().length === k1,
      again.lines.join(' / '),
    );
    const newer = (JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[]).map((x) =>
      x.id === XFER.alpha
        ? { ...x, messages: [...x.messages, { role: 'customer' as const, content: '文件存储下的新消息', at: Date.now() }] }
        : x,
    );
    fs.writeFileSync(path.join(v, 'sessions.json'), JSON.stringify(newer, null, 2));
    const newerFiles = files(v);
    const clobber = await exportSessions(base);
    ck(
      'export：没有标记文件、JSON 比库新（文件存储下又聊过）→ 退出码 2，点名短码、提示 import-sessions --resync，文件、库与 --keep 都没动',
      clobber.code === 2 &&
        has(clobber, 'HA01') &&
        has(clobber, 'import-sessions --resync') &&
        files(v) === newerFiles &&
        (await counts()) === before.n &&
        keeps().length === k1,
      clobber.lines.join(' / '),
    );
    const [es] = JSON.parse(exported) as [string];
    fs.writeFileSync(
      path.join(v, 'sessions.json'),
      JSON.stringify(
        (JSON.parse(es) as Session[]).filter((x) => x.id !== XFER.gamma),
        null,
        2,
      ),
    );
    const fill = await exportSessions(base);
    ck(
      'export：没有标记文件、库里有 JSON 里没有的真实会话 → 照常导出，把它补进 JSON',
      fill.code === 0 &&
        has(fill, '已导出 3 个真实会话') &&
        (JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[]).some((x) => x.id === XFER.gamma) &&
        !fs.existsSync(path.join(v, SESSIONS_IN_DB_MARKER)),
      fill.lines.join(' / '),
    );
    fs.writeFileSync(path.join(v, 'sessions.json'), es);
    ck('export 的再导出用例之后数据目录回到导出的样子', files(v) === exported);
    return;
  }
  if (step === 'resync') {
    const before = await counts();
    const plain = await importSessions(base);
    ck(
      '文件存储下聊过之后不带 --resync 导入：退出码 2，提示 --resync，库与文件都没动',
      plain.code === 2 && has(plain, '--resync') && (await counts()) === before && !fs.existsSync(path.join(v, SESSIONS_IN_DB_MARKER)),
      plain.lines.join(' / '),
    );
    // 先把文件存储下聊完的 JSON 存一份：后面拿它的变体做 dry-run
    const snapshot = (edit: (s: Session[], o: Order[]) => void): string => {
      const dir = fs.mkdtempSync(path.join(path.dirname(v), 'xfer-resync-'));
      const s = JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[];
      const o = JSON.parse(read(v, 'orders.json') ?? '[]') as Order[];
      edit(s, o);
      fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(s, null, 2));
      fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(o, null, 2));
      return dir;
    };
    const plainSnap = snapshot(() => {});
    // 条数够、内容不同（文件存储下改过一条）：库里的窗口不是文件窗口的前缀，也要推进窗口起点
    const edited = snapshot((s) => void (s.find((x) => x.id === XFER.alpha)!.messages[1]!.content = '文件存储下改过的一句'));
    const editedDry = await importSessions({ ...base, varDir: edited, resync: true, dryRun: true });
    ck(
      '--resync（dry-run）：库里的窗口与文件窗口条数够但有一条不同，不算前缀，推进窗口起点、整段追加',
      editedDry.code === 0 && editedDry.stats.pushed === 2 && editedDry.stats.appendedTo === 1 && (await counts()) === before,
      `${editedDry.lines.join(' / ')} ${JSON.stringify(editedDry.stats)}`,
    );
    // 写完之后读回与 JSON 不等（文件里有一条 at 不是整数毫秒，进库之后对不上）：回滚、退出码 2，库不动
    const lossy = snapshot(
      (s) => void s.find((x) => x.id === XFER.delta)!.messages.push({ role: 'customer', content: '晚点再说', at: Date.now() + 0.5 }),
    );
    const lossyFiles = files(lossy);
    const lossyDry = await importSessions({ ...base, varDir: lossy, resync: true, dryRun: true });
    ck(
      '--resync --dry-run：写完读回与 JSON 不等时同样退出码 2、点名短码，库与文件都没动',
      lossyDry.code === 2 && has(lossyDry, 'TA04') && (await counts()) === before && files(lossy) === lossyFiles,
      lossyDry.lines.join(' / '),
    );
    // JSON 里缺了库里的一个会话（alpha 与它的订单）：作废只算文件里这些会话在库里有、文件里没有的订单，不碰 alpha 的
    const noAlpha = snapshot((s, o) => {
      s.splice(
        s.findIndex((x) => x.id === XFER.alpha),
        1,
      );
      for (let i = o.length - 1; i >= 0; i--) if (o[i]!.sessionId === XFER.alpha) o.splice(i, 1);
    });
    const noAlphaDry = await importSessions({ ...base, varDir: noAlpha, resync: true, dryRun: true });
    ck(
      '--resync（dry-run）：JSON 缺了库里的某个会话时，作废数只算文件里这些会话的（beta 的 1 张，不含 alpha 的 2 张）',
      noAlphaDry.code === 0 && noAlphaDry.stats.voided === 1 && (await counts()) === before,
      `${noAlphaDry.lines.join(' / ')} ${JSON.stringify(noAlphaDry.stats)}`,
    );
    const lossyRun = await importSessions({ ...base, varDir: lossy, resync: true });
    ck(
      '--resync：写完读回与 JSON 不等时回滚、退出码 2、点名短码，库与文件都没动',
      lossyRun.code === 2 &&
        has(lossyRun, 'TA04') &&
        has(lossyRun, '已回滚') &&
        (await counts()) === before &&
        !fs.existsSync(path.join(lossy, SESSIONS_IN_DB_MARKER)),
      lossyRun.lines.join(' / '),
    );
    const seqs = async () =>
      Object.fromEntries(
        (
          await su<{ id: string; last_seq: number; window_start_seq: number }>(
            "select c.id, c.last_seq, c.window_start_seq from conversations c join tenants t on t.id = c.tenant_id where t.slug = 'demo'",
          )
        ).map((r) => [r.id, [r.last_seq, r.window_start_seq]]),
      );
    const prev = await seqs();
    const k0 = keeps().length;
    const r = await importSessions({ ...base, resync: true });
    const now = await seqs();
    ck('--resync：退出码 0', r.code === 0, r.lines.join(' / '));
    ck(
      '--resync：库里没有的（文件存储下新来的）按首次写入；窗口是前缀的追加多出来的；重置过的推进窗口起点、整段追加',
      r.stats.created === 1 &&
        r.stats.appendedTo === 2 &&
        (r.stats.appended ?? 0) >= 3 &&
        r.stats.pushed === 1 &&
        (r.stats.pushedMessages ?? 0) >= 1,
      JSON.stringify(r.stats),
    );
    ck(
      '--resync：前缀的窗口起点不动、last_seq 往后加；接不上的窗口起点推到原 last_seq + 1；新会话从 1 起',
      now[XFER.alpha]![1] === prev[XFER.alpha]![1] &&
        now[XFER.alpha]![0]! > prev[XFER.alpha]![0]! &&
        now[XFER.beta]![1] === prev[XFER.beta]![0]! + 1 &&
        now[XFER.beta]![0] === prev[XFER.beta]![0]! + (r.stats.pushedMessages ?? 0) &&
        now[XFER.delta]![1] === 1,
      `${JSON.stringify(prev)} → ${JSON.stringify(now)}`,
    );
    const voided = await su<{ id: string; void_reason: string | null }>(
      "select o.id, o.void_reason from orders o join tenants t on t.id = o.tenant_id where t.slug = 'demo' and o.voided_at is not null",
    );
    ck(
      '--resync：这些会话在库里有、文件里没有的订单作废（void_reason = resync，行还在）',
      r.stats.voided === 1 && voided.length === 1 && voided[0]!.id === `ord_${'b2'.repeat(12)}` && voided[0]!.void_reason === 'resync',
      JSON.stringify(voided),
    );
    // 库里已作废的订单又出现在文件里（陈旧的 JSON）：不复活（库里不拦 voided_at 写回 NULL，只有这里守）
    const stale = fx6.orders.find((o) => o.id === `ord_${'b2'.repeat(12)}`)!;
    const staleDir = fs.mkdtempSync(path.join(path.dirname(v), 'xfer-stale-'));
    for (const f of ['sessions.json', 'orders.json']) fs.copyFileSync(path.join(plainSnap, f), path.join(staleDir, f));
    fs.writeFileSync(
      path.join(staleDir, 'orders.json'),
      JSON.stringify([...(JSON.parse(read(staleDir, 'orders.json') ?? '[]') as Order[]), stale], null, 2),
    );
    const staleDry = await importSessions({ ...base, varDir: staleDir, resync: true, dryRun: true });
    const [staleRow] = await su<{ v: boolean }>('select voided_at is not null as v from orders where id = $1', [stale.id]);
    ck(
      '--resync（dry-run）：库里已作废、文件里还有的订单不恢复，读回照样一致，退出码 0',
      staleDry.code === 0 && staleDry.stats.skippedVoided === 1 && staleDry.stats.voided === 0 && staleRow?.v === true,
      `${staleDry.lines.join(' / ')} ${JSON.stringify(staleDry.stats)}`,
    );
    const sj = JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[];
    ck(
      '--resync：之后同样改写 JSON（只剩 demo 类）、写标记文件，原件进 --keep',
      sj.length > 0 &&
        sj.every((s) => isDemoClassId(s.id)) &&
        fs.existsSync(path.join(v, SESSIONS_IN_DB_MARKER)) &&
        keeps().length === k0 + 1 &&
        path.basename(r.stats.kept ?? '').startsWith('resync-'),
    );
    return;
  }

  if (step === 'export2') {
    // 同 id 以库为准：JSON 里有真实会话的陈旧副本、库里已作废订单的陈旧副本、改过金额的订单副本时，导出之后都是库里的样子
    const { readSessionBatch } = await import('../db/repo/conversations.js');
    const { rebuildSessions, rowToOrder } = await import('./project.js');
    const ctx = { tenantId: fx.deps.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const sj = JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[];
    const oj = JSON.parse(read(v, 'orders.json') ?? '[]') as Order[];
    const voidedId = `ord_${'b2'.repeat(12)}`;
    const staleAlpha = fx6.sessions.find((s) => s.id === XFER.alpha)!;
    const staleOrder = { ...fx6.orders.find((o) => o.id === 'ORD-20240501-0007')!, totalPrice: 1 };
    fs.writeFileSync(path.join(v, 'sessions.json'), JSON.stringify([...sj, staleAlpha], null, 2));
    fs.writeFileSync(path.join(v, 'orders.json'), JSON.stringify([...oj, fx6.orders.find((o) => o.id === voidedId)!, staleOrder], null, 2));
    const exp = await exportSessions(base);
    const batch = await withTenant(fx.deps.db, ctx, (tx) => readSessionBatch(tx, null, 1000));
    const dbAlpha = rebuildSessions(batch.rows, batch.messages).find((x) => x.row.id === XFER.alpha)?.session;
    const dbOrder = batch.orders.map(rowToOrder).find((o) => o.id === 'ORD-20240501-0007');
    const after = {
      s: JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[],
      o: JSON.parse(read(v, 'orders.json') ?? '[]') as Order[],
    };
    ck(
      'export：JSON 里真实会话的陈旧副本被库里的盖掉（同 id 以库为准）',
      exp.code === 0 &&
        !!dbAlpha &&
        after.s.filter((s) => s.id === XFER.alpha).length === 1 &&
        isDeepStrictEqual(
          after.s.find((s) => s.id === XFER.alpha),
          dbAlpha,
        ),
      exp.lines.join(' / '),
    );
    ck(
      'export：库里已作废的订单从 JSON 里去掉，改过金额的订单副本换回库里的',
      !after.o.some((o) => o.id === voidedId) &&
        !!dbOrder &&
        isDeepStrictEqual(
          after.o.find((o) => o.id === 'ORD-20240501-0007'),
          dbOrder,
        ) &&
        dbOrder.totalPrice === 6000,
    );
    return;
  }

  // 中途崩溃（另一个租户 demo4、另一份 var/）：提交之后写好标记、改写 sessions.json 时失败 → 1；这时两种存储都拒绝启动（crashstart），
  // 重跑 import 按逐个一致补完改写（crashfix）
  if (step === 'crash') {
    const pristine = files(v);
    fs.mkdirSync(path.join(v, 'sessions.json.tmp'));
    const r = await importSessions(base);
    fs.rmdirSync(path.join(v, 'sessions.json.tmp'));
    ck(
      'import：提交之后先写标记，改写 JSON 之前失败 → 退出码 1、库已提交；标记在、两个 JSON 还是原件',
      r.code === 1 &&
        has(r, '库已提交') &&
        (await counts()) === '3/11/3/0' &&
        markerOf(v)?.tenant === slug &&
        markerOf(v)?.sessions === 3 &&
        JSON.stringify((JSON.parse(files(v)) as unknown[]).slice(0, 2)) === JSON.stringify((JSON.parse(pristine) as unknown[]).slice(0, 2)),
      `${r.lines.join(' / ')} ${await counts()}`,
    );
    return;
  }
  if (step === 'crashfix') {
    const r = await importSessions(base);
    ck(
      'import：写了标记、改写 JSON 之前崩了之后重跑 → 逐个一致、补完改写，退出码 0',
      r.code === 0 &&
        has(r, '逐个一致：补完改写') &&
        (await counts()) === '3/11/3/0' &&
        (JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[]).every((x) => isDemoClassId(x.id)) &&
        markerOf(v)?.sessions === 3,
      r.lines.join(' / '),
    );
    return;
  }
  // 补写标记（demo5）：库里已有会话、这份 var/ 只有 demo 类而没有标记文件（没经过 import-sessions 直接以 db 存储起）
  if (step === 'fresh') {
    const side = fs.mkdtempSync(path.join(path.dirname(v), 'xfer-side-'));
    fs.writeFileSync(path.join(side, 'sessions.json'), JSON.stringify(fx6.sessions, null, 2));
    fs.writeFileSync(path.join(side, 'orders.json'), JSON.stringify(fx6.orders, null, 2));
    const seeded = await importSessions({ ...base, varDir: side });
    ck(
      '补写标记的前提：库里已有 3 个会话，这份 var/ 里只有 demo 类、没有标记文件',
      seeded.code === 0 &&
        (await counts()) === '3/11/3/0' &&
        !fs.existsSync(path.join(v, SESSIONS_IN_DB_MARKER)) &&
        (JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[]).every((x) => isDemoClassId(x.id)),
      seeded.lines.join(' / '),
    );
  }
  const st = await store();
  if (step === 'crashstart') {
    ck('写了标记、JSON 还是原件：文件存储以 sessions_in_db 拒绝启动', (await startupReason(st, null)) === 'sessions_in_db');
    ck('写了标记、JSON 还是原件：db 存储以 real_in_json 拒绝启动', (await startupReason(st, fx.deps)) === 'real_in_json');
    return;
  }
  if (step === 'fresh') {
    const t0 = Date.now();
    ck('没有标记文件、JSON 里没有真实会话：db 存储启动成功', (await startupReason(st, fx.deps)) === 'ok');
    const m = markerOf(v);
    ck(
      'db 存储启动之后补写了标记文件 { tenant, at, sessions: 预载的真实会话数 }，没留下临时文件',
      m?.tenant === 'demo5' &&
        m.sessions === 3 &&
        Date.parse(m.at ?? '') >= t0 - 1000 &&
        Object.keys(m).join() === 'tenant,at,sessions' &&
        fs.readdirSync(v).every((f) => !f.endsWith('.tmp')),
      JSON.stringify(m),
    );
    ck('补写的标记文件让文件存储以 sessions_in_db 拒绝启动', (await startupReason(st, null)) === 'sessions_in_db');
    return;
  }
  if (step === 'dbstart') {
    // 导入（含补完改写）之后：文件存储以 sessions_in_db 拒绝；db 存储启动，预载重建的就是原 JSON 经 normalizeForStore（不变量 14、15）
    ck('import 写的标记文件让文件存储以 sessions_in_db 拒绝启动', (await startupReason(st, null)) === 'sessions_in_db');
    const markerBefore = read(v, SESSIONS_IN_DB_MARKER);
    ck('补完改写之后 db 存储启动成功', (await startupReason(st, fx.deps)) === 'ok');
    ck('db 存储启动时标记文件已在：原样不动（不重写）', !!markerBefore && read(v, SESSIONS_IN_DB_MARKER) === markerBefore);
    const dump = memDump(st);
    const want = {
      sessions: realOf(fx6.sessions)
        .map((s) => normalizeForStore(s))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
      orders: fx6.orders
        .filter((o) => !isDemoClassId(o.sessionId))
        .map((o) => normalizeForStore(o))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    };
    ck(
      '不变量 14：db 存储启动后经预载重建的每个真实会话与订单，与原 JSON 经 normalizeForStore 之后 deepStrictEqual',
      isDeepStrictEqual(dump, JSON.parse(JSON.stringify(want))),
      `${JSON.stringify(dump).slice(0, 300)}`,
    );
    ck(
      'db 存储启动后 demo 类会话、订单与孤儿订单仍在（JSON 里）',
      !!st.getSession('wecom:cust_X01') &&
        !!st.getSession('sim-xfervisitor000001') &&
        !!st.getOrder('ord_seed_X01') &&
        !!st.getOrder(`ord_${'d4'.repeat(12)}`),
    );
    ck(
      '不变量 15：db 存储启动之后 JSON 里没有真实会话',
      (JSON.parse(read(v, 'sessions.json') ?? '[]') as Session[]).every((s) => !fx6.real.includes(s.id)),
    );
    process.env.LLM_MOCK = '1';
    const { handleMessage } = await import('../engine.js');
    await handleMessage(XFER.alpha, '还有别的推荐吗', 'wecom');
    await handleMessage(XFER.gamma, '你好', 'wecom');
    const drained = await st.drainStore(5000);
    ck('db 存储下再聊两句，都落了库', drained.undrained.length === 0 && st.storeHealth().dirty === 0, JSON.stringify(drained));
    res.data.afterDb = memDump(st);
    return;
  }
  if (step === 'filechat') {
    ck('导出之后（标记文件删了）文件存储照常启动', (await startupReason(st, null)) === 'ok' && st.sessionStoreMode() === 'file');
    process.env.LLM_MOCK = '1';
    const { handleMessage } = await import('../engine.js');
    await handleMessage(XFER.alpha, '想再加一个人', 'wecom');
    await handleMessage(XFER.alpha, '三个人多少钱', 'wecom');
    await handleMessage(XFER.gamma, '在吗', 'wecom');
    await handleMessage(XFER.beta, '重置', 'wecom');
    await handleMessage(XFER.delta, '你好，我想去西藏', 'wecom');
    st.flushStoreNow();
    res.data.fileAfter = memDump(st);
    res.data.betaOrders = st.listOrders().filter((o) => o.sessionId === XFER.beta).length;
    // db 存储而 JSON 里有真实会话：预载之前以 real_in_json 拒绝（不碰库与 JSON）
    const before = files(v);
    ck(
      'db 存储而 JSON 里有真实会话（导出之后）：以 real_in_json 拒绝启动，JSON 不动',
      (await startupReason(st, fx.deps)) === 'real_in_json' && files(v) === before,
    );
    return;
  }
  if (step === 'dbstart2') {
    ck('--resync 之后 db 存储启动成功', (await startupReason(st, fx.deps)) === 'ok');
    res.data.dump = memDump(st);
    // 内存与库一致：每个真实会话库里窗口内的消息就是内存里的（同一投影），窗口起点与 last_seq 就是内存里 seq 的样子
    const ctx = { tenantId: fx.deps.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
    const rows = await withTenant(fx.deps.db, ctx, (tx) => readConversationsAfter(tx, null, 1000));
    const mismatched: string[] = [];
    for (const r of rows) {
      const s = st.getSession(r.id);
      const win = await withTenant(fx.deps.db, ctx, (tx) => readMessagesFrom(tx, r.id, r.windowStartSeq));
      const ok =
        !!s &&
        isDeepStrictEqual(JSON.parse(JSON.stringify(s.messages)), win.map(rowToMessage)) &&
        win.length === r.lastSeq - r.windowStartSeq + 1 &&
        (s.messages.length === 0 || (st.seqOf(s.messages[0]!) === r.windowStartSeq && st.seqOf(s.messages.at(-1)!) === r.lastSeq));
      if (!ok) mismatched.push(r.id);
    }
    ck(
      '--resync 之后 db 存储启动：每个真实会话库里窗口内的消息与内存相同，seq 对得上',
      rows.length === 4 && mismatched.length === 0,
      mismatched.join(),
    );
    res.data.history = Object.fromEntries(
      await Promise.all(
        rows.map(async (r) => [r.id, (await withTenant(fx.deps.db, ctx, (tx) => readMessagesFrom(tx, r.id, 1))).length] as const),
      ),
    );
    return;
  }
  res.fails.push(`未知的 XFER_STEP ${step}`);
}

// ---------------- 子进程 pg：PGlite 上的进程内各组 ----------------
async function childPg(ck: Ck): Promise<void> {
  const VAR = process.env.VAR_DIR!;
  process.env.LLM_MOCK = '1';
  process.env.SERVER_SELFTEST = '1';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const NUL = String.fromCharCode(0);
  const LONE = String.fromCharCode(0xdc00);
  const { openTestDb, installSeededConfig, installPgSessionStore, fakeLock, fakeDbError } = await import('../db/testing.js');
  const { withTenant, queryCount, inTenantTx } = await import('../db/client.js');
  const convRepo = await import('../db/repo/conversations.js');
  const msgRepo = await import('../db/repo/messages.js');
  const ordRepo = await import('../db/repo/orders.js');
  const proj = await import('./project.js');
  const { openPgBackend } = await import('./pg-backend.js');
  const { SessionStoreStartupError } = await import('./backend.js');
  const { shortIdOf } = await import('../shared/conversation.js');
  const config = await import('../config/source.js');

  const t = await openTestDb();
  const lock = fakeLock();
  await installSeededConfig(t, { deps: { lock: async () => lock } });
  const fx = await installPgSessionStore(t, { varDir: VAR });
  const tid = fx.deps.tenantId;
  const ctxOf = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } });
  /** 以超级用户执行：一个事务里临时换回会话用户，排着的落库不会跟着变成超级用户 */
  const su = <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  const convRow = async (id: string) =>
    (
      await su<{ last_seq: number; window_start_seq: number; flush_id: string | null }>(
        'select last_seq, window_start_seq, flush_id from conversations where id = $1',
        [id],
      )
    )[0];
  const dbMsgs = (id: string) =>
    su<{ seq: number; role: string; content: string }>('select seq, role, content from messages where conversation_id = $1 order by seq', [
      id,
    ]);
  const count = async (sqlText: string, params: unknown[] = []) => (await su<{ n: number }>(sqlText, params))[0]!.n;
  const reasonOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof SessionStoreStartupError ? e.reason : `other:${String(e)}`;
    }
  };
  const newTenant = async (slug: string) =>
    (await su<{ id: string }>(`insert into tenants (slug, name, pack_id) values ($1, $1, 'travel') returning id`, [slug]))[0]!.id;
  const probeDeps = (tenantId: string, varDir = fs.mkdtempSync(path.join(VAR, 'probe-'))) => ({
    db: fx.deps.db,
    tenantId,
    varDir,
    sessions: new Map<string, Session>(),
    orders: new Map<string, Order>(),
    onConflict() {},
    writable: () => true,
  });

  // ---- 预载要读的数据：先写进库，再装上 PG 后端 ----
  const now = Date.now();
  const day = 86_400_000;
  const A = 'wecom:wmPreloadA';
  const allMsgs: ChatMessage[] = [
    { role: 'customer', content: '八天前的', at: now - 8 * day, msgid: 'mid-old' },
    { role: 'customer', content: '一天前的', at: now - day, msgid: 'mid-recent-out' },
    { role: 'customer', content: '窗口里的', at: now - 3600_000, msgid: 'mid-in', sentAt: now - 3601_000 },
    { role: 'agent', content: '顾问回的', at: now - 3500_000, author: 'human', authorId: null, authorName: '共享工作台' },
    { role: 'system', content: 'AI 已转人工：客户投诉', at: now - 3400_000, card: { kind: 'handoff', n: [1, 2] } } as ChatMessage,
  ];
  const seedA = {
    id: A,
    channel: 'wecom',
    stage: 'quote',
    profile: { destinationInterest: '云南', nickname: '小王🙂' },
    messages: allMsgs.slice(2),
    orderIds: ['ord_aaaa1111'],
    handedOver: true,
    createdAt: now - 10 * day,
    updatedAt: now - 3400_000,
    quoteHistory: [{ routeId: 'r-yunnan-mid', travelers: 2, perPerson: 3280, total: 6560 }],
    followup: { count: 1, stages: ['quote'] },
    handoff: { kind: 'complaint', at: now - 3400_000, reason: '客户投诉', quote: '太差了' },
    firstHandoffAt: now - 3400_000,
    handoffCount: 1,
    assignee: { userId: null, name: '共享工作台', at: now - 3500_000 },
    futureField: { x: [1, 'two'] },
  } as unknown as Session;
  const orderLive = {
    id: 'ord_aaaa1111',
    sessionId: A,
    routeId: 'r-yunnan-mid',
    routeTitle: '云南',
    travelers: 2,
    departDate: '2026-11-01',
    totalPrice: 6560,
    status: 'pending_payment',
    createdAt: now - 3000_000,
  } as Order;
  const orderVoid = { ...orderLive, id: 'ord_aaaa2222', status: 'paid', paidAt: now - 2000_000 } as Order;
  await withTenant(t.db, ctxOf(tid), async (tx) => {
    await convRepo.insertConversation(tx, proj.sessionToRow(seedA), { lastSeq: 5, windowStartSeq: 3, flushId: null });
    await msgRepo.insertMessages(
      tx,
      A,
      allMsgs.map((m, i) => proj.messageToRow(m, i + 1)),
    );
    await ordRepo.upsertOrders(tx, [proj.orderToRow(orderLive), proj.orderToRow(orderVoid, { at: now - 1000_000, reason: 'reset' })]);
  });

  // ---- 预载的校验与分批（openPgBackend 不改 identity map，拿别的租户直接试） ----
  {
    const tSeq = await newTenant('bad-seq');
    await withTenant(t.db, ctxOf(tSeq), async (tx) => {
      const s = { ...seedA, id: 'wecom:wmBadSeq' } as Session;
      await convRepo.insertConversation(tx, proj.sessionToRow(s), { lastSeq: 3, windowStartSeq: 1, flushId: null });
      await msgRepo.insertMessages(
        tx,
        s.id,
        allMsgs.slice(0, 2).map((m, i) => proj.messageToRow(m, i + 1)),
      );
    });
    ck(
      '预载校验：窗口里的消息条数与 last_seq 对不上 → preload_integrity',
      (await reasonOf(openPgBackend(probeDeps(tSeq)))) === 'preload_integrity',
    );
    const tGap = await newTenant('bad-gap');
    await withTenant(t.db, ctxOf(tGap), async (tx) => {
      const s = { ...seedA, id: 'wecom:wmBadGap' } as Session;
      await convRepo.insertConversation(tx, proj.sessionToRow(s), { lastSeq: 3, windowStartSeq: 2, flushId: null });
      await msgRepo.insertMessages(tx, s.id, [proj.messageToRow(allMsgs[0]!, 2), proj.messageToRow(allMsgs[1]!, 4)]);
    });
    ck('预载校验：条数对得上但 seq 有空洞 → preload_integrity', (await reasonOf(openPgBackend(probeDeps(tGap)))) === 'preload_integrity');
    const tOrd = await newTenant('bad-order');
    await withTenant(t.db, ctxOf(tOrd), async (tx) => {
      const s = { ...seedA, id: 'wecom:wmBadOrd', messages: [] } as unknown as Session;
      await convRepo.insertConversation(tx, proj.sessionToRow(s));
      const row = proj.orderToRow({ ...orderLive, id: 'ord_bbbb1111', sessionId: s.id });
      await ordRepo.upsertOrders(tx, [{ ...row, data: { ...row.data, sessionId: 'wecom:someoneElse' } }]);
    });
    ck('预载校验：订单 data 里的会话与列对不上 → orphan_order', (await reasonOf(openPgBackend(probeDeps(tOrd)))) === 'orphan_order');
    const tDemo = await newTenant('bad-demo');
    // 表上的 CHECK 本来就拦着 demo 类，先拿掉它才造得出来（纵深防御那一层）
    await su('alter table conversations drop constraint conversations_id_check');
    try {
      await withTenant(t.db, ctxOf(tDemo), (tx) =>
        convRepo.insertConversation(tx, proj.sessionToRow({ ...seedA, id: 'sim-demoinpgxxxxxx', messages: [] } as unknown as Session)),
      );
      ck('预载校验：库里有 demo 类会话 → demo_class_in_db', (await reasonOf(openPgBackend(probeDeps(tDemo)))) === 'demo_class_in_db');
    } finally {
      await su('delete from conversations where tenant_id = $1', [tDemo]);
      await su(
        `alter table conversations add constraint conversations_id_check check (id !~ '^(sim-|wecom:cust_)' and length(id) between 1 and 200)`,
      );
    }
    const tBatch = await newTenant('batch');
    await su(
      `insert into conversations (tenant_id, id, channel, stage, handed_over, state, created_at, updated_at)
       select $1, 'wecom:wmBatch' || lpad(g::text, 4, '0'), 'wecom', 'greeting', false,
              json_build_object('id', 'wecom:wmBatch' || lpad(g::text, 4, '0'), 'channel', 'wecom', 'stage', 'greeting',
                                'profile', '{}'::json, 'orderIds', '[]'::json, 'handedOver', false, 'createdAt', 1, 'updatedAt', 1),
              now() - interval '1 day', now() - interval '1 day'
         from generate_series(1, 1001) g`,
      [tBatch],
    );
    const batch = probeDeps(tBatch);
    const bb = await openPgBackend(batch);
    bb.install();
    ck(
      '预载：按 500 个一批读，三批 1001 个会话不重不漏',
      batch.sessions.size === 1001 && batch.sessions.has('wecom:wmBatch0001') && batch.sessions.has('wecom:wmBatch1001'),
      String(batch.sessions.size),
    );
  }

  // ---- spill 回放的接续判定（openPgBackend 在预载之后回放；手写的 spill 文件，别的租户） ----
  {
    const tR = await newTenant('replay');
    const R = 'wecom:wmReplay1';
    const base = {
      id: R,
      channel: 'wecom',
      stage: 'greeting',
      profile: {},
      orderIds: [],
      handedOver: false,
      createdAt: now - day,
      updatedAt: now - day,
    };
    const m = (i: number): ChatMessage => ({ role: i % 2 ? 'customer' : 'agent', content: `回放${i}`, at: now - day + i * 1000 });
    await withTenant(t.db, ctxOf(tR), async (tx) => {
      await convRepo.insertConversation(tx, proj.sessionToRow({ ...base, messages: [m(1), m(2)] } as unknown as Session), {
        lastSeq: 2,
        windowStartSeq: 1,
        flushId: randomUUID(),
      });
      await msgRepo.insertMessages(tx, R, [proj.messageToRow(m(1), 1), proj.messageToRow(m(2), 2)]);
    });
    const dir = fs.mkdtempSync(path.join(VAR, 'replay-'));
    const audit = (action: string) => ({ actor: { kind: 'system', userId: null, name: 'selftest', ip: null }, entry: { action } });
    const entry = (over: Record<string, unknown>) => ({
      id: R,
      committedSeq: 2,
      inflight: null,
      flushId: randomUUID(),
      lastSeq: 3,
      windowStartSeq: 1,
      messages: [{ seq: 3, message: m(3) }],
      state: { ...base, updatedAt: now - day + 3000 },
      lastCustomerAt: null,
      orders: [],
      audits: [],
      jobs: [],
      consents: [],
      poisoned: null,
      ...over,
    });
    const writeSpill = (name: string, sessions: unknown[], tenant = tR): string => {
      const file = path.join(dir, `store-spill-${name}.json`);
      fs.writeFileSync(file, JSON.stringify({ version: 1, tenant, at: now, sessions }));
      return file;
    };
    const open = async () => {
      const deps = probeDeps(tR, dir);
      const b = await openPgBackend(deps);
      b.install();
      return { b, deps };
    };
    const e1 = entry({ audits: [audit('selftest.replay.c')] });
    const f1 = writeSpill('2026-01-01T00-00-00-000Z', [e1]);
    const r1 = await open();
    const c1 = await convRow(R);
    ck(
      'spill 回放：库里的 last_seq 等于「已提交到第几条」→ 按一次落库写入，回放之后删掉文件',
      c1?.last_seq === 3 &&
        c1.flush_id === e1.flushId &&
        (await dbMsgs(R)).length === 3 &&
        !fs.existsSync(f1) &&
        r1.b.stats().replayed === 1,
      JSON.stringify(c1),
    );
    ck('spill 回放：回放之后再预载一遍，内存里是回放后的样子', r1.deps.sessions.get(R)?.messages.length === 3);
    ck('spill 回放：排着的审计一起写', (await count(`select count(*)::int as n from audit_log where action = 'selftest.replay.c'`)) === 1);
    const f1b = writeSpill('2026-01-01T00-00-01-000Z', [e1]);
    const r1b = await open();
    ck(
      'spill 回放：回放提交之后、删文件之前崩溃，再回放按 flush_id 认出、跳过，不重复写',
      r1b.b.stats().replaySkipped === 1 &&
        (await dbMsgs(R)).length === 3 &&
        !fs.existsSync(f1b) &&
        (await count(`select count(*)::int as n from audit_log where action = 'selftest.replay.c'`)) === 1,
    );
    // 在途那次其实提交了（COMMIT 时断线之后停机）：库里是在途那次的 flush_id，只补它之后的
    const e2 = entry({
      committedSeq: 2,
      inflight: { flushId: e1.flushId, lastSeq: 3, audits: [audit('selftest.replay.inflight')], jobs: [], consents: [] },
      lastSeq: 4,
      messages: [
        { seq: 3, message: m(3) },
        { seq: 4, message: m(4) },
      ],
      audits: [audit('selftest.replay.queued')],
    });
    writeSpill('2026-01-01T00-00-02-000Z', [e2]);
    await open();
    ck(
      'spill 回放：库里是在途那次的 flush_id 与 last_seq → 在途那次已提交，只补它之后的消息与附带行',
      (await convRow(R))?.last_seq === 4 &&
        (await dbMsgs(R)).map((r) => r.seq).join() === '1,2,3,4' &&
        (await count(`select count(*)::int as n from audit_log where action = 'selftest.replay.inflight'`)) === 0 &&
        (await count(`select count(*)::int as n from audit_log where action = 'selftest.replay.queued'`)) === 1,
    );
    const e3 = entry({ committedSeq: 3, lastSeq: 4, messages: [{ seq: 4, message: m(4) }] });
    const f3 = writeSpill('2026-01-01T00-00-03-000Z', [e3]);
    const r3 = await open();
    ck('spill 回放：库里已经等于文件里最后一条的 seq 且内容一致 → 跳过', r3.b.stats().replaySkipped === 1 && !fs.existsSync(f3));
    // 只有会话投影与审计、没有新消息的一条：回放提交之后、删文件之前崩溃，再回放靠 flush_id 认出（内容比对管不到它）
    const eState = entry({
      committedSeq: 4,
      lastSeq: 4,
      messages: [],
      audits: [audit('selftest.replay.stateonly')],
      state: { ...base, stage: 'quote' },
    });
    writeSpill('2026-01-01T00-00-03-500Z', [eState]);
    await open();
    writeSpill('2026-01-01T00-00-03-600Z', [eState]);
    const rState = await open();
    ck(
      'spill 回放：没有新消息的一条（只有投影与审计）回放两遍，审计只写一次、第二遍认出跳过',
      rState.b.stats().replaySkipped === 1 &&
        (await count(`select count(*)::int as n from audit_log where action = 'selftest.replay.stateonly'`)) === 1 &&
        rState.deps.sessions.get(R)?.stage === 'quote',
    );
    const e4 = entry({ committedSeq: 3, lastSeq: 4, messages: [{ seq: 4, message: { ...m(4), content: '内容不同' } }] });
    const f4 = writeSpill('2026-01-01T00-00-04-000Z', [e4]);
    ck('spill 回放：seq 对上了内容却不同 → spill_conflict', (await reasonOf(openPgBackend(probeDeps(tR, dir)))) === 'spill_conflict');
    fs.unlinkSync(f4);
    const f5 = writeSpill('2026-01-01T00-00-05-000Z', [entry({ committedSeq: 1, lastSeq: 2, messages: [{ seq: 2, message: m(2) }] })]);
    let detail = '';
    try {
      await openPgBackend(probeDeps(tR, dir));
    } catch (e) {
      detail = e instanceof SessionStoreStartupError ? `${e.reason} ${e.detail}` : String(e);
    }
    ck(
      'spill 回放：「已提交到第几条」接不上库里的 last_seq → spill_conflict，点名短码，文件留着',
      detail.startsWith('spill_conflict') && detail.includes(shortIdOf(R)) && !detail.includes(R) && fs.existsSync(f5),
      detail,
    );
    fs.unlinkSync(f5);
    // 在途那次没提交（库里的 flush_id 不是它）：按「已提交到第几条」写入，在途快照带的审计也要写进去
    const eLost = entry({
      committedSeq: 4,
      inflight: { flushId: randomUUID(), lastSeq: 5, audits: [audit('selftest.replay.inflightlost')], jobs: [], consents: [] },
      lastSeq: 5,
      messages: [{ seq: 5, message: m(5) }],
      audits: [audit('selftest.replay.afterlost')],
    });
    writeSpill('2026-01-01T00-00-05-500Z', [eLost]);
    await open();
    ck(
      'spill 回放：在途那次没提交（库里的 flush_id 不是它）→ 按一次落库写入，在途快照带的审计与之后排的都写进去',
      (await convRow(R))?.last_seq === 5 &&
        (await count(`select count(*)::int as n from audit_log where action = 'selftest.replay.inflightlost'`)) === 1 &&
        (await count(`select count(*)::int as n from audit_log where action = 'selftest.replay.afterlost'`)) === 1,
    );
    // flush_id 对上而 last_seq 对不上（库被别人动过）：两种都按接不上处理，不跳过、不按在途已提交补写
    const lostFlush = (await convRow(R))!.flush_id!;
    const fA = writeSpill('2026-01-01T00-00-05-600Z', [
      entry({
        flushId: lostFlush,
        committedSeq: 5,
        lastSeq: 7,
        messages: [
          { seq: 6, message: m(6) },
          { seq: 7, message: m(7) },
        ],
      }),
    ]);
    ck(
      'spill 回放：库里是这一条的回放 flush_id、last_seq 却不是文件里最后一条 → spill_conflict，不当成已回放跳过',
      (await reasonOf(openPgBackend(probeDeps(tR, dir)))) === 'spill_conflict' && fs.existsSync(fA),
    );
    fs.unlinkSync(fA);
    const fB = writeSpill('2026-01-01T00-00-05-700Z', [
      entry({
        committedSeq: 3,
        inflight: { flushId: lostFlush, lastSeq: 4, audits: [], jobs: [], consents: [] },
        lastSeq: 6,
        messages: [
          { seq: 5, message: m(5) },
          { seq: 6, message: m(6) },
        ],
      }),
    ]);
    ck(
      'spill 回放：库里是在途那次的 flush_id、last_seq 却不是它的 → spill_conflict，不按在途已提交补写',
      (await reasonOf(openPgBackend(probeDeps(tR, dir)))) === 'spill_conflict' && fs.existsSync(fB) && (await convRow(R))?.last_seq === 5,
    );
    fs.unlinkSync(fB);
    // 别的租户的 spill：换成本租户就能干净写入的一条（接得上库里的 last_seq），照样拒绝，库里不多出消息
    const msgsBefore = (await dbMsgs(R)).length;
    const f6 = writeSpill(
      '2026-01-01T00-00-06-000Z',
      [entry({ committedSeq: 5, lastSeq: 6, messages: [{ seq: 6, message: m(6) }] })],
      'not-this-tenant',
    );
    let d6 = '';
    try {
      await openPgBackend(probeDeps(tR, dir));
    } catch (e) {
      d6 = e instanceof SessionStoreStartupError ? `${e.reason} ${e.detail}` : String(e);
    }
    ck(
      'spill 回放：别的租户的 spill → spill_conflict，detail 写明不是本租户，库里没多出消息，文件留着',
      d6.startsWith('spill_conflict') && d6.includes('不是本租户') && (await dbMsgs(R)).length === msgsBefore && fs.existsSync(f6),
      d6,
    );
    fs.unlinkSync(f6);
    // 结构不对的文件（缺 sessions、version 不认识）按读不出处理：改名 .failed，不抛别的错
    const f6a = path.join(dir, 'store-spill-2026-01-01T00-00-06-100Z.json');
    fs.writeFileSync(f6a, JSON.stringify({ version: 1, tenant: tR, at: now }));
    const f6b = path.join(dir, 'store-spill-2026-01-01T00-00-06-200Z.json');
    fs.writeFileSync(f6b, JSON.stringify({ version: 2, tenant: tR, at: now, sessions: [] }));
    ck(
      'spill 回放：缺 sessions、version 不认识的文件按读不出处理，改名 .failed，照常启动',
      (await reasonOf(openPgBackend(probeDeps(tR, dir)))) === 'ok' &&
        fs.existsSync(`${f6a}.failed`) &&
        fs.existsSync(`${f6b}.failed`) &&
        !fs.existsSync(f6a) &&
        !fs.existsSync(f6b),
    );
    // 文件系统出错（这里是同名的目录，读它 EISDIR）：以 spill_conflict 拒绝，detail 只写文件名与错误码
    const f6c = path.join(dir, 'store-spill-2026-01-01T00-00-06-300Z.json');
    fs.mkdirSync(f6c);
    let d6c = '';
    try {
      await openPgBackend(probeDeps(tR, dir));
    } catch (e) {
      d6c = e instanceof SessionStoreStartupError ? `${e.reason} ${e.detail}` : `other:${String(e)}`;
    }
    ck(
      'spill 回放：文件系统出错 → SessionStoreStartupError(spill_conflict)，detail 是文件名与错误码',
      d6c.startsWith('spill_conflict') && d6c.includes(path.basename(f6c)) && d6c.includes('EISDIR') && !d6c.includes(dir),
      d6c,
    );
    fs.rmdirSync(f6c);
    // 一个文件里一条回放成功、一条仍失败：改名 .failed，日志点名哪些已回放、哪些失败，要人工处理，不再叫人改回原名重启
    const longId = `wecom:${'r'.repeat(195)}`;
    const okId = 'wecom:wmReplayOk7';
    const f7 = writeSpill('2026-01-01T00-00-07-000Z', [
      entry({ id: okId, committedSeq: 0, lastSeq: 1, messages: [{ seq: 1, message: m(1) }], state: { ...base, id: okId } }),
      entry({ id: longId, committedSeq: 0, lastSeq: 1, messages: [{ seq: 1, message: m(1) }], state: { ...base, id: longId } }),
    ]);
    const logs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    let r7: string;
    try {
      r7 = await reasonOf(openPgBackend(probeDeps(tR, dir)));
    } finally {
      console.error = origErr;
    }
    ck(
      'spill 回放：回放仍失败（数据类错误）→ 文件改名 .failed，从库里的状态起',
      r7 === 'ok' && !fs.existsSync(f7) && fs.existsSync(`${f7}.failed`) && (await convRow(okId))?.last_seq === 1,
    );
    const line = logs.find((l) => l.includes('改名 .failed') && l.includes(path.basename(f7))) ?? '';
    ck(
      'spill 回放：.failed 的日志要人工处理，点名已回放与失败的会话（短码），不叫人改回原名重启',
      line.includes('需要人工处理') &&
        line.includes(`已回放：${shortIdOf(okId)}`) &&
        line.includes(`失败：${shortIdOf(longId)}`) &&
        !line.includes('改回原名再启动') &&
        !line.includes(okId),
      line,
    );
  }

  // ---- spill 不投影订单：订单投影失败让会话 poisoned，spillSync 照样写出这个会话（不变量 13） ----
  {
    const tP = await newTenant('poison-order');
    const dir = fs.mkdtempSync(path.join(VAR, 'poison-order-'));
    const deps = probeDeps(tP, dir);
    const sid = 'wecom:wmBadOrderSpill';
    // 旧的 orders.json 里就可能有这样的孤儿单：createdAt 为 null，投影成行时抛 ProjectionError
    const badOrder = {
      id: 'ord_badcreated1',
      sessionId: sid,
      routeId: 'r-yunnan-mid',
      routeTitle: '云南',
      travelers: 2,
      departDate: '2026-11-01',
      totalPrice: 6560,
      status: 'paid',
      createdAt: null,
    } as unknown as Order;
    deps.orders.set(badOrder.id, badOrder);
    const b = await openPgBackend(deps);
    b.install();
    const s = {
      id: sid,
      channel: 'wecom',
      stage: 'greeting',
      profile: {},
      messages: [{ role: 'customer', content: '坏订单的主人', at: Date.now() }],
      orderIds: [],
      handedOver: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Session;
    deps.sessions.set(sid, s);
    b.schedule(s);
    await sleep(30);
    const h = b.health();
    ck(
      'spill：收养的孤儿订单投影失败（createdAt 为 null）→ 会话 poisoned',
      h.poisoned.includes(shortIdOf(sid)) && /projection order\.createdAt/.test(h.lastError ?? ''),
      String(h.lastError),
    );
    s.messages.push({ role: 'agent', content: '照样服务', at: Date.now() });
    b.schedule(s);
    const n = b.spillSync();
    const file = fs.readdirSync(dir).find((f) => /^store-spill-.+\.json$/.test(f));
    const doc = file
      ? (JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
          sessions: { id: string; messages: { message: ChatMessage }[]; orders: { order: Record<string, unknown> }[]; poisoned: string }[];
        })
      : null;
    const se = doc?.sessions.find((x) => x.id === sid);
    ck(
      'spill：poisoned 的会话照样写出消息与原始订单（spill 里不投影订单）',
      n === 1 &&
        se?.messages.map((x) => x.message.content).join() === '坏订单的主人,照样服务' &&
        se.orders.length === 1 &&
        se.orders[0]!.order.createdAt === null &&
        /projection/.test(se.poisoned),
      String(JSON.stringify(se ?? null)).slice(0, 300),
    );
    b.close();
  }

  const store = await import('../store.js');
  const { handleMessage } = await import('../engine.js');
  // ---- 装上之前：库连不上 ----
  fx.faults.acquire = fakeDbError('08006');
  ck(
    'initSessionStore：库连不上 → db_unreachable，仍是文件存储，identity map 里没有半装载的会话',
    (await reasonOf(store.initSessionStore(fx.deps))) === 'db_unreachable' && store.sessionStoreMode() === 'file' && !store.getSession(A),
  );
  fx.faults.acquire = null;
  const modes0 = fx.stats.txModes.length;
  await store.initSessionStore(fx.deps);
  ck(
    '预载：整个预载一个 REPEATABLE READ 只读的事务',
    fx.stats.txModes.slice(modes0).some((q) => /repeatable read/i.test(q) && /read only/i.test(q)),
    JSON.stringify(fx.stats.txModes.slice(modes0)),
  );
  let twice = '';
  try {
    await store.initSessionStore(fx.deps);
  } catch (e) {
    twice = e instanceof SessionStoreStartupError ? e.reason : `other:${String(e)}`;
  }
  ck('initSessionStore：装上之后再调一次也以 SessionStoreStartupError 拒绝（sessions_in_db）', twice === 'sessions_in_db', twice);
  const stats = () => store.__storeTest.pgStats()!;
  const mk = (id: string) => store.getOrCreateSession(id, 'wecom');
  const say = (s: Session, role: ChatMessage['role'], content: string): void => {
    s.messages.push({ role, content, at: Date.now() });
    store.saveSession(s);
  };
  /** 等排在 microtask 里的起落库跑起来（写队列在 microtask 里取快照） */
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const poisoned = (id: string) => store.storeHealth().poisoned.includes(shortIdOf(id));

  // ---- 预载往返 ----
  {
    const a = store.getSession(A)!;
    ck('db 存储：装上之后 sessionStoreMode 是 db', store.sessionStoreMode() === 'db');
    ck(
      '预载往返：rowToSession 重建的会话与 normalizeForStore 之后的原对象（只留窗口）deepStrictEqual',
      isDeepStrictEqual(a, proj.normalizeForStore(seedA)),
      String(JSON.stringify(a ?? null)).slice(0, 300),
    );
    ck('预载：窗口里的消息按库里的 seq 记上 seq', a.messages.map((x) => store.seqOf(x)).join() === '3,4,5');
    ck(
      '预载：预载的消息是冻结的',
      a.messages.every((x) => Object.isFrozen(x)),
    );
    ck('预载：未作废的订单进内存，作废的不进', !!store.getOrder('ord_aaaa1111') && store.getOrder('ord_aaaa2222') === undefined);
    const ids = store.recentMsgids(A);
    ck(
      '预载：企微去重集合是最近 7 天带 msgid 的客户消息（含窗口外的），不含 8 天前的',
      ids.has('mid-recent-out') && ids.has('mid-in') && !ids.has('mid-old'),
      [...ids].join(),
    );
    ck('db 存储：同一个 id 两次 getSession 返回同一个对象', store.getSession(A) === a);
    const h = store.storeHealth();
    ck('storeHealth：db 存储只数真实会话，不含 demo 类', h.mode === 'db' && h.conversations === 1 && h.dirty === 0, JSON.stringify(h));
  }

  // ---- 写队列：顺序与合并 ----
  {
    const s = mk('wecom:wmQueue1');
    await store.flushSession(s.id);
    const before = stats().attempts;
    for (let i = 1; i <= 10; i++) say(s, i % 2 ? 'customer' : 'agent', `第${i}句`);
    ck('saveSession 返回时新消息已有 seq（同步分配）', store.seqOf(s.messages.at(-1)!) === 10);
    await store.flushSession(s.id);
    const n = stats().attempts - before;
    ck('写队列：同一段同步代码里的十次 saveSession 合进一次落库（起落库推迟到 microtask）', n === 1, String(n));
    let open!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open = r));
    const b2 = stats().attempts;
    say(s, 'customer', '第11句');
    await tick(); // 这一次已经起了，卡在闸门前
    for (let i = 12; i <= 20; i++) say(s, i % 2 ? 'customer' : 'agent', `第${i}句`);
    fx.faults.gate = null;
    open();
    await store.flushSession(s.id);
    const n2 = stats().attempts - b2;
    ck('写队列：在途期间的九次 saveSession 合并成它提交之后的那一次', n2 === 2, String(n2));
    const rows = await dbMsgs(s.id);
    ck(
      '写队列：库里的消息顺序与内存相同',
      rows.map((r) => r.content).join() === s.messages.map((x) => x.content).join() &&
        rows.map((r) => r.seq).join() === Array.from({ length: 20 }, (_, i) => i + 1).join(),
    );
    const c = await convRow(s.id);
    ck('写队列：会话行的 last_seq、window_start_seq、flush_id', c?.last_seq === 20 && c.window_start_seq === 1 && c.flush_id !== null);
    s.messages.push({ role: 'customer', content: '带 msgid 的', at: Date.now(), msgid: 'mid-local-1' });
    store.saveSession(s);
    ck('去重集合：本进程分配了 seq 的客户消息的 msgid 进集合', store.recentMsgids(s.id).has('mid-local-1'));
    await store.flushSession(s.id);
  }
  {
    const s1 = mk('wecom:wmGate1');
    const s2 = mk('wecom:wmGate2');
    await store.flushSession(s1.id);
    await store.flushSession(s2.id);
    let open!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open = r));
    const acq0 = fx.stats.acquires;
    say(s1, 'customer', 'a1');
    say(s1, 'agent', 'a2');
    say(s1, 'customer', 'a3');
    say(s2, 'customer', 'b1');
    await sleep(30);
    ck('写队列：同一会话至多一个落库在途，不同会话各起一次', fx.stats.acquires - acq0 === 2, String(fx.stats.acquires - acq0));
    ck(
      '写队列：在途期间 storeHealth 报积压，lagMs 从最早一次没提交的改动算起',
      store.storeHealth().dirty === 2 && store.storeHealth().lagMs >= 20,
      JSON.stringify(store.storeHealth()),
    );
    fx.faults.gate = null;
    open();
    await store.flushSession(s1.id);
    await store.flushSession(s2.id);
    ck(
      '写队列：在途的那次提交之后，合并的那次接着落库',
      (await dbMsgs(s1.id)).map((r) => r.content).join() === 'a1,a2,a3' && (await dbMsgs(s2.id)).length === 1,
    );
    ck('写队列：都提交之后不再积压', store.storeHealth().dirty === 0);
  }

  // ---- 冻结 ----
  {
    const s = store.getSession('wecom:wmQueue1')!;
    let err: unknown = null;
    try {
      (s.messages[0] as { content: string }).content = '改写';
    } catch (e) {
      err = e;
    }
    ck('冻结：改写已落库消息的 content 抛 TypeError（验收 5）', err instanceof TypeError);
    const fresh: ChatMessage = { role: 'agent', content: '还没存', at: Date.now() };
    s.messages.push(fresh);
    fresh.content = '存之前可以改';
    ck('冻结：saveSession 之前的新消息还能改', !Object.isFrozen(fresh));
    store.saveSession(s);
    ck('冻结：saveSession 分配 seq 时即冻结（起落库在 microtask 里，冻结不等取快照）', Object.isFrozen(fresh));
    await store.flushSession(s.id);
    ck('冻结：冻结之前的改动随快照落库', (await dbMsgs(s.id)).at(-1)?.content === '存之前可以改');
  }

  // ---- 窗口推进（裁剪） ----
  {
    const s = mk('wecom:wmTrim1');
    for (let i = 1; i <= 12; i++) say(s, i % 2 ? 'customer' : 'agent', `t${i}`);
    await store.flushSession(s.id);
    s.messages.splice(0, 5);
    say(s, 'customer', 't13');
    await store.flushSession(s.id);
    const c = await convRow(s.id);
    ck(
      '窗口推进：头部裁剪只推进 window_start_seq，库里的旧消息都在',
      c?.window_start_seq === 6 && c.last_seq === 13 && (await dbMsgs(s.id)).length === 13 && !poisoned(s.id),
      JSON.stringify(c),
    );
  }

  // ---- 重置：窗口推进、订单作废（E6、E6p 的内存行为照旧） ----
  {
    const sid = 'wecom:wmReset1';
    for (const text of ['想去云南玩', '2个人，11月1号出发', '就订这个']) await handleMessage(sid, text, 'wecom');
    const s = store.getSession(sid)!;
    const oid = s.orderIds[0] ?? '';
    store.markOrderPaid(oid);
    await store.flushSession(sid);
    const before = await convRow(sid);
    const r = await handleMessage(sid, '重置', 'wecom');
    await store.flushSession(sid);
    const after = await convRow(sid);
    const rows = await dbMsgs(sid);
    const ord = (
      await su<{ status: string; voided_at: Date | null; void_reason: string | null; paid_at: Date | null }>(
        'select status, voided_at, void_reason, paid_at from orders where id = $1',
        [oid],
      )
    )[0];
    ck('重置：先建好了一张已付订单', oid !== '' && ord?.status === 'paid');
    ck(
      '重置：内存照旧（只剩重置回复、订单从 getOrder 消失、orderIds 清空）',
      s.messages.length === 1 && s.messages[0]!.content === r.text && store.getOrder(oid) === undefined && s.orderIds.length === 0,
    );
    ck(
      '重置：库里旧消息都在，窗口起点推进到重置回复那一条',
      !!before &&
        after?.last_seq === before.last_seq + 1 &&
        after.window_start_seq === after.last_seq &&
        rows.length === after.last_seq &&
        rows.at(-1)?.content === r.text,
      `${JSON.stringify(before)} ${JSON.stringify(after)}`,
    );
    ck(
      '重置：订单记作废（已付的也作废，paid_at 不动），不删',
      ord?.voided_at !== null && ord?.void_reason === 'reset' && ord.paid_at !== null,
    );
    ck('重置：不 poisoned', !poisoned(sid));
  }

  // ---- 同一段同步代码里的复合改动合进一个事务：重置一个带订单、已转人工的会话，只借一次连接，库里没有半个重置 ----
  {
    const { enterHandoff } = await import('../handoff/record.js');
    const sid = 'wecom:wmResetTx1';
    for (const text of ['想去云南玩', '2个人，11月1号出发', '就订这个']) await handleMessage(sid, text, 'wecom');
    const s = store.getSession(sid)!;
    const oid = s.orderIds[0] ?? '';
    enterHandoff(s, { kind: 'request', at: Date.now(), reason: '客户要人工', quote: '转人工' });
    store.saveSession(s);
    await store.flushSession(sid);
    const conv = async () =>
      (
        await su<{
          stage: string;
          handed_over: boolean;
          handoff_kind: string | null;
          last_seq: number;
          window_start_seq: number;
          order_ids: string[];
          has_handoff: boolean;
        }>(
          `select stage, handed_over, handoff_kind, last_seq, window_start_seq,
                  state->'orderIds' as order_ids, (state->'handoff') is not null as has_handoff
             from conversations where id = $1`,
          [sid],
        )
      )[0];
    const pre = await conv();
    ck(
      '复合改动：先有一个带订单、已转人工的会话',
      oid !== '' && pre?.handed_over === true && pre.has_handoff && pre.order_ids.includes(oid),
    );
    // 第一次借连接放行，第二次起都失败：把重置拆成两次提交的话，库里会停在第一次提交的样子
    fx.faults.acquire = fakeDbError('08006');
    fx.faults.skipAcquires = 1;
    const a0 = fx.stats.acquires;
    const r = await handleMessage(sid, '重置', 'wecom');
    await sleep(60);
    const acquired = fx.stats.acquires - a0;
    const post = await conv();
    const ord = (await su<{ voided: boolean }>('select voided_at is not null as voided from orders where id = $1', [oid]))[0];
    const tail = (await dbMsgs(sid)).at(-1);
    const dirty = store.storeHealth().dirty;
    fx.faults.acquire = null;
    fx.faults.skipAcquires = 0;
    ck(
      '复合改动：真引擎「重置」里的作废订单、清转人工、重置回复与 saveSession 合进一次落库（只借了一次连接）',
      acquired === 1 && dirty === 0,
      `acquired=${acquired} dirty=${dirty}`,
    );
    ck(
      '复合改动：库里没有中间态，全是重置之后的样子（阶段、转人工、订单引用与作废、窗口起点、重置回复）',
      !!pre &&
        post?.stage === 'greeting' &&
        !post.handed_over &&
        post.handoff_kind === null &&
        !post.has_handoff &&
        post.order_ids.length === 0 &&
        post.last_seq === pre.last_seq + 1 &&
        post.window_start_seq === post.last_seq &&
        ord?.voided === true &&
        tail?.content === r.text,
      JSON.stringify({ pre, post, ord, tail }),
    );
  }

  // ---- 事件只在提交后；提交失败时不发，恢复后补上 ----
  {
    const s = mk('wecom:wmEvents1');
    say(s, 'customer', 'e1');
    await store.flushSession(s.id);
    const got: string[] = [];
    const off = store.onCommitted((ev) => {
      if (ev.id === s.id) got.push(ev.type);
    });
    await sleep(250); // 上一次提交合并出来的那个 change 先发完
    let changes = 0;
    const onChange = (): void => {
      changes++;
    };
    store.storeEvents.on('change', onChange);
    let open!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open = r));
    store.emitAfterCommit(s.id, { type: 'conversation.changed', id: s.id });
    await sleep(250);
    ck('事件：落库还没提交时不发（领域事件与旧 /api/admin/stream 的 change 都不发）', got.length === 0 && changes === 0);
    fx.faults.gate = null;
    fx.faults.acquire = fakeDbError('08006');
    const retries0 = stats().retries;
    open();
    await sleep(50);
    const h = store.storeHealth();
    ck('事件：落库失败时不发', got.length === 0 && h.dirty === 1);
    ck(
      '失败：连接类错误退避重试，lastError 只有 SQLSTATE 与短码',
      stats().retries - retries0 === 1 && h.lastError === `08006 · ${shortIdOf(s.id)}`,
      String(h.lastError),
    );
    fx.faults.acquire = null;
    ck('事件：提交失败时旧 /api/admin/stream 的 change 也不发', changes === 0);
    await store.flushSession(s.id, { timeoutMs: 4000 }); // 1 秒后的那次重试
    ck('事件：恢复之后随重试提交恰好发出一次', got.join() === 'conversation.changed', got.join());
    await sleep(250);
    ck('事件：提交之后旧 /api/admin/stream 收到 change（约 200ms 合并一次）', changes === 1, String(changes));
    store.storeEvents.off('change', onChange);
    off();
  }

  // ---- COMMIT 时断线：重试按 flush_id 认出已提交 ----
  {
    const s = mk('wecom:wmCommitLost');
    say(s, 'customer', 'c1');
    await store.flushSession(s.id);
    const got: string[] = [];
    const off = store.onCommitted((ev) => {
      if (ev.id === s.id) got.push(ev.type);
    });
    let open!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open = r));
    say(s, 'agent', 'c2'); // 第一次落库：在闸门前等着
    await tick();
    say(s, 'customer', 'c3'); // 在途期间来的，合并进第二次
    store.emitAfterCommit(s.id, { type: 'conversation.changed', id: s.id });
    fx.faults.releaseOnce = fakeDbError('08006', '模拟 COMMIT 之后回包丢了');
    fx.faults.skipReleases = 1; // 第二次落库的回包才丢
    const st0 = stats();
    fx.faults.gate = null;
    open();
    await sleep(150);
    const mid = await convRow(s.id);
    ck(
      'COMMIT 断线：库里其实已经提交了，store 还当作没提交（积压、事件没发）',
      mid?.last_seq === 3 && store.storeHealth().dirty === 1 && got.length === 0,
      `${JSON.stringify(mid)} ${got.join()}`,
    );
    await store.flushSession(s.id, { timeoutMs: 4000 });
    const st1 = stats();
    ck(
      'COMMIT 断线：重试按 flush_id 认出上一次已提交，不重复插入',
      st1.recognized - st0.recognized === 1 && (await dbMsgs(s.id)).map((r) => r.content).join() === 'c1,c2,c3',
    );
    ck(
      'COMMIT 断线：补做提交后的步骤，事件恰好发出一次，不冲突、不停写',
      got.join() === 'conversation.changed' && !store.storeHealth().conflict && !poisoned(s.id),
      got.join(),
    );
    off();
  }

  // ---- 数据类错误：不重试，这个会话标 poisoned，别的会话照常 ----
  const longId = `wecom:${'x'.repeat(195)}`;
  {
    const r0 = stats().retries;
    const a0 = stats().attempts;
    const bad = mk(longId);
    say(bad, 'customer', '超长 id');
    await sleep(1200); // 过了第一次退避（1 秒）：要是排了重试，这时已经又试过一次
    const h = store.storeHealth();
    ck(
      '数据类错误：违反 CHECK 的投影（id 超长）不重试，会话标 poisoned，storeHealth 点名短码',
      h.poisoned.includes(shortIdOf(longId)) && h.lastError === `23514 conversations_id_check · ${shortIdOf(longId)}`,
      String(h.lastError),
    );
    ck(
      '数据类错误：只试了一次，退避时间过去之后也没有重试',
      stats().retries === r0 && stats().attempts - a0 === 1,
      `retries +${stats().retries - r0} attempts +${stats().attempts - a0}`,
    );
    const t0 = Date.now();
    let lag: unknown = null;
    await store.flushSession(longId).catch((e: unknown) => {
      lag = e;
    });
    ck('poisoned：flushSession 立即以 StoreLaggingError reject', lag instanceof store.StoreLaggingError && Date.now() - t0 < 200);
    say(bad, 'agent', '照样服务');
    ck('poisoned：内存照旧服务，新消息照样有 seq（宽松模式）', store.seqOf(bad.messages.at(-1)!) === 2);
    const ok = mk('wecom:wmAfterPoison');
    say(ok, 'customer', '别的会话');
    await store.flushSession(ok.id);
    ck('poisoned：别的会话照常落库', (await dbMsgs(ok.id)).length === 1 && !poisoned(ok.id));
    const o = mk('wecom:wmBadOrder');
    say(o, 'customer', '下单');
    await store.flushSession(o.id);
    store.createOrder({
      sessionId: o.id,
      routeId: 'r-yunnan-mid',
      routeTitle: '云南',
      travelers: 2,
      departDate: '2026-11-01',
      totalPrice: -1,
    });
    await sleep(50);
    ck(
      '数据类错误：订单违反 CHECK（金额为负）同样标 poisoned',
      poisoned(o.id) && /orders_total_price_check/.test(store.storeHealth().lastError ?? ''),
    );
    const w = mk('wecom:wmCorrupt1');
    say(w, 'customer', '1');
    say(w, 'agent', '2');
    say(w, 'customer', '3');
    await store.flushSession(w.id);
    w.messages.splice(1, 1);
    say(w, 'agent', '4');
    ck(
      'WindowCorruptError：从会话中间删一条再 saveSession，会话标 poisoned（验收 5），新消息照样有 seq',
      poisoned(w.id) && store.seqOf(w.messages.at(-1)!) === 4 && store.storeHealth().lastError === `window_corrupt · ${shortIdOf(w.id)}`,
    );
    let again: unknown = null;
    try {
      say(w, 'customer', '5'); // 数组仍然错位：之后对它改用宽松模式，saveSession 不抛
    } catch (e) {
      again = e;
    }
    ck(
      'WindowCorruptError：poisoned 之后再 saveSession 不抛（改用宽松模式），新消息照样有 seq',
      again === null && store.seqOf(w.messages.at(-1)!) === 5,
      String(again),
    );
    await sleep(30);
    ck('WindowCorruptError：库里不动', (await convRow(w.id))?.last_seq === 3);
    const { app } = await import('../server.js');
    const hz = (await (await app.request('/healthz')).json()) as { ok: boolean; store: Record<string, unknown> };
    ck(
      '/healthz：db 存储、有 poisoned 时 ok 为 false，poisoned 只给个数、不带会话 id',
      hz.ok === false && hz.store.mode === 'db' && hz.store.poisoned === 3 && !JSON.stringify(hz).includes('wmCorrupt'),
      JSON.stringify(hz.store),
    );
  }

  // ---- identity map：同 id 的另一个对象 ----
  {
    const s = store.getSession('wecom:wmAfterPoison')!;
    const clone = { ...s, messages: [...s.messages, { role: 'customer', content: '副本里的', at: Date.now() }] } as Session;
    const st0 = stats();
    store.saveSession(clone);
    await sleep(30);
    const st1 = stats();
    ck(
      'identity map：saveSession 收到同 id 的另一个对象，拒绝（不落库、不换掉 map 里的），不编出重复的 seq',
      store.getSession(s.id) === s && st1.foreign - st0.foreign === 1 && st1.attempts === st0.attempts && (await dbMsgs(s.id)).length === 1,
    );
  }

  // ---- NUL、切开的 emoji、存档点里的 trace ----
  {
    const sid = 'wecom:wmNul1';
    await handleMessage(sid, `你好${NUL}在吗`, 'wecom');
    await handleMessage(sid, `${'x'.repeat(1999)}😀尾巴`, 'wecom');
    const s = store.getSession(sid)!;
    s.messages.push({ role: 'system', content: `直接写进来的${NUL}${LONE}`, at: Date.now() });
    store.saveSession(s);
    const turnId = randomUUID();
    const dropped0 = stats().telemetryDropped;
    store.queueTelemetry(sid, {
      traces: [traceRow(turnId, sid)],
      guards: [{ turnId, ord: 0, guard: 'Bad-Guard', action: 'replace', removed: [], added: [] }],
    });
    say(s, 'customer', '之后的消息');
    await store.flushSession(sid);
    const rows = await dbMsgs(sid);
    ck('NUL 与切开的 emoji 不堵队列：之后的消息照常落库，不 poisoned', rows.at(-1)?.content === '之后的消息' && !poisoned(sid));
    ck('NUL 与孤立代理项不进库', rows.length >= 5 && rows.every((r) => !r.content.includes(NUL) && wellFormed(r.content)));
    ck(
      '第 2000 个字处的 emoji 不被切开',
      rows.some((r) => r.content === `${'x'.repeat(1999)}😀`),
    );
    ck(
      '存档点：非法护栏名的那一批回到存档点、丢掉并计数（trace 在同一个存档点里也没了），会话照常提交',
      stats().telemetryDropped - dropped0 === 1 &&
        (await count('select count(*)::int as n from turn_traces where id = $1', [turnId])) === 0,
    );
    const t2 = randomUUID();
    store.queueTelemetry(sid, {
      traces: [traceRow(t2, sid)],
      guards: [{ turnId: t2, ord: 0, guard: 'price', action: 'drop_sentence', removed: ['编的价'], added: [] }],
    });
    await store.flushSession(sid);
    ck(
      '存档点：合法的 trace 与护栏事件随下一次落库写进去',
      (await count('select count(*)::int as n from turn_traces where id = $1', [t2])) === 1 &&
        (await count('select count(*)::int as n from guard_events where turn_id = $1', [t2])) === 1,
    );
  }

  // ---- chat() 与 withTenant ----
  {
    const { chat } = await import('../llm.js');
    const opts = { system: 's', messages: [{ role: 'user' as const, content: '你好' }], tools: [], executeTool: async () => '{}' };
    let inside = '';
    await withTenant(t.db, ctxOf(tid), async () => {
      await chat(opts).catch((e: unknown) => {
        inside = String(e);
      });
    });
    ck('chat()：在 withTenant 回调里调用即断言失败（不变量 9）', /不能在 withTenant/.test(inside), inside);
    ck('chat()：在外面照常', typeof (await chat(opts)) === 'string');
    const s = mk('wecom:wmInTx');
    await store.flushSession(s.id);
    let wasIn = false;
    const retries0 = stats().retries;
    await withTenant(t.db, ctxOf(tid), async () => {
      wasIn = inTenantTx();
      say(s, 'customer', '事务里存的');
    });
    await store.flushSession(s.id);
    ck(
      '在 withTenant 回调里 saveSession 照常落库：排出的落库不继承那个上下文，一次就成（不是靠重试）',
      wasIn && (await dbMsgs(s.id)).length === 1 && !poisoned(s.id) && stats().retries === retries0,
    );
  }

  // ---- 一轮里除写队列的落库外不发查询（不变量 9） ----
  {
    const sid = 'wecom:wmQuery1';
    await handleMessage(sid, '你好', 'wecom');
    await store.flushSession(sid);
    const q0 = queryCount();
    const s0 = fx.stats.queries;
    const a0 = fx.stats.acquires;
    const st0 = stats().attempts;
    await handleMessage(sid, '想去云南玩，2个人', 'wecom');
    await store.flushSession(sid);
    ck(
      '一轮的读路径不查库：配置那条连接上没有查询，会话写入只经写队列',
      queryCount() === q0 && fx.stats.queries > s0,
      `global ${queryCount() - q0}, store ${fx.stats.queries - s0}`,
    );
    ck('一轮里写队列的查询都在它自己的落库事务里', fx.stats.acquires - a0 === stats().attempts - st0);
  }

  // ---- 孤儿订单与 demo 类 ----
  {
    const ordersOnDisk = () => JSON.parse(fs.readFileSync(path.join(VAR, 'orders.json'), 'utf8')) as Order[];
    ck('孤儿订单：所属会话不在内存里的订单照样在内存（文件后端管）', !!store.getOrder('ord_orphan1'));
    store.markOrderPaid('ord_orphan1');
    await store.drainStore(1000); // 只有孤儿订单这一处改动：要靠它自己让文件后端落盘
    ck(
      '孤儿订单：db 存储下孤儿订单的改动本身让文件后端落盘，orders.json 里是改过的',
      ordersOnDisk().some((o) => o.id === 'ord_orphan1' && o.status === 'paid'),
    );
    const demo = store.getSession('sim-storeselftestdemo1')!;
    say(demo, 'customer', 'demo 类照旧走 JSON');
    await store.drainStore(1000);
    const sj = JSON.parse(fs.readFileSync(path.join(VAR, 'sessions.json'), 'utf8')) as Session[];
    ck(
      'db 存储：sessions.json 只装 demo 类，demo 会话照旧落盘、不进库',
      sj.every((x) => store.isDemoClassId(x.id)) &&
        sj.find((x) => x.id === 'sim-storeselftestdemo1')?.messages.at(-1)?.content === 'demo 类照旧走 JSON' &&
        (await count(`select count(*)::int as n from conversations where id like 'sim-%' or id like 'wecom:cust_%'`)) === 0,
    );
    // 同 id 的真实会话又建出来，订单被收养；PG 暂时不可写，这期间先来一次 demo 落盘：订单还没随会话提交，仍归文件后端
    fx.faults.acquire = fakeDbError('08006');
    const g = mk('wecom:wmGone');
    say(g, 'customer', '我回来了');
    await sleep(30); // 落库失败一次，在 1 秒退避里
    say(demo, 'customer', '收养之后的 demo 落盘');
    await sleep(350); // 文件后端的去抖落盘
    ck(
      '孤儿订单：收养之后、随会话在库里提交之前，demo 落盘的 orders.json 里仍有它（崩溃不丢）',
      ordersOnDisk().some((o) => o.id === 'ord_orphan1' && o.status === 'paid') &&
        (await count('select count(*)::int as n from orders where id = $1', ['ord_orphan1'])) === 0,
    );
    fx.faults.acquire = null;
    await store.flushSession(g.id, { timeoutMs: 4000 });
    const row = (
      await su<{ session_id: string; status: string }>('select session_id, status from orders where id = $1', ['ord_orphan1'])
    )[0];
    ck('孤儿订单：同 id 的真实会话又建出来，订单转归 PG、随它的落库写进库', row?.session_id === 'wecom:wmGone' && row.status === 'paid');
    await store.drainStore(1000);
    ck('孤儿订单：随会话在库里提交之后，文件后端重写 orders.json 去掉它', !ordersOnDisk().some((o) => o.id === 'ord_orphan1'));
  }

  // ---- 附带行：审计（带操作者与 IP）、任务、同意记录；demo 类的审计单独一个短事务 ----
  {
    const s = store.getSession('wecom:wmGone')!;
    store.queueAudit(
      s.id,
      { kind: 'user', userId: null, name: '小林', ip: '10.0.0.7' },
      { action: 'selftest.queued', targetType: 'conversation', targetId: 'ref-x' },
    );
    store.queueAudit(s.id, { kind: 'system', userId: null, name: null, ip: null }, { action: 'selftest.queued2' });
    store.queueJobs(s.id, [
      {
        op: 'enqueue',
        kind: 'followup',
        dedupeKey: `followup:${s.id}:quote`,
        runAt: Date.now() + 3600_000,
        payload: { sessionId: s.id },
        maxAttempts: 3,
      },
    ]);
    store.queueConsents(s.id, [{ category: 'health', decision: 'asked', noticeVersion: 1, evidence: null, at: Date.now() }]);
    await store.flushSession(s.id);
    // 在途期间排进来的审计、订单改动：不并进在途的那次，随它提交之后的下一次落库写，不丢
    let open!: () => void;
    fx.faults.gate = new Promise<void>((r) => (open = r));
    say(s, 'customer', '在途的这一次');
    await tick();
    store.queueAudit(s.id, { kind: 'system', userId: null, name: null, ip: null }, { action: 'selftest.queued.inflight' });
    fx.faults.gate = null;
    open();
    await store.flushSession(s.id);
    ck(
      '附带行：在途期间排进来的审计随下一次落库写进去',
      (await count(`select count(*)::int as n from audit_log where action = 'selftest.queued.inflight'`)) === 1,
    );
    const audits = await su<{ action: string; actor_name: string | null; ip: string | null; actor_kind: string }>(
      `select action, actor_name, host(ip) as ip, actor_kind from audit_log where action in ('selftest.queued', 'selftest.queued2') order by id`,
    );
    ck(
      '附带行：审计随会话的落库写，各自带操作者与 IP',
      audits.length === 2 &&
        audits[0]!.actor_name === '小林' &&
        audits[0]!.ip === '10.0.0.7' &&
        audits[0]!.actor_kind === 'user' &&
        audits[1]!.actor_kind === 'system',
      JSON.stringify(audits),
    );
    ck(
      '附带行：任务的排程随会话的落库写',
      (await count(`select count(*)::int as n from jobs where dedupe_key = $1 and status = 'pending'`, [`followup:${s.id}:quote`])) === 1,
    );
    ck('附带行：同意记录随会话的落库写', (await count(`select count(*)::int as n from consents where conversation_id = $1`, [s.id])) === 1);
    store.queueAudit('sim-storeselftestdemo1', { kind: 'user', userId: null, name: '小林', ip: null }, { action: 'selftest.demo' });
    let n = 0;
    for (let i = 0; i < 50 && n === 0; i++) {
      await sleep(20);
      n = await count(`select count(*)::int as n from audit_log where action = 'selftest.demo'`);
    }
    ck('附带行：demo 类会话的审计单独一个短事务写进去', n === 1);
    store.queueJobs('sim-storeselftestdemo1', [{ op: 'cancel', dedupeKey: 'x' }]);
    store.queueTelemetry('sim-storeselftestdemo1', { traces: [traceRow(randomUUID(), 'sim-storeselftestdemo1')] });
    await sleep(50);
    ck(
      '附带行：demo 类会话的 trace、任务不入库',
      (await count(`select count(*)::int as n from turn_traces where conversation_id like 'sim-%'`)) === 0,
    );
  }

  // ---- 失败分两类：按 SQLSTATE（spec「失败」） ----
  {
    const table: [string, Error, 'data' | 'retry'][] = [
      ['22P05（数据，如 text 里的 NUL）', fakeDbError('22P05'), 'data'],
      ['23505（约束）', fakeDbError('23505'), 'data'],
      ['42501（权限）', fakeDbError('42501'), 'data'],
      ['不带 code 的 TypeError（确定性的程序错误）', new TypeError('x is undefined'), 'data'],
      ['08006（连接）', fakeDbError('08006'), 'retry'],
      ['40001（串行化失败）', fakeDbError('40001'), 'retry'],
      ['40P01（死锁）', fakeDbError('40P01'), 'retry'],
      ['57014（语句超时）', fakeDbError('57014'), 'retry'],
      ['53300（连接数满）', fakeDbError('53300'), 'retry'],
      ['57P01（库在停机）', fakeDbError('57P01'), 'retry'],
      ['ECONNREFUSED（网络层）', fakeDbError('ECONNREFUSED'), 'retry'],
      ['不带 code 的「连接意外中断」', new Error('Connection terminated unexpectedly'), 'retry'],
    ];
    let i = 0;
    for (const [label, err, want] of table) {
      const s = mk(`wecom:wmClassify${++i}`);
      const r0 = stats().retries;
      fx.faults.acquire = err;
      say(s, 'customer', label);
      await sleep(20);
      fx.faults.acquire = null;
      const dr = stats().retries - r0;
      const got =
        poisoned(s.id) && dr === 0 ? 'data' : !poisoned(s.id) && dr === 1 ? 'retry' : `? poisoned=${poisoned(s.id)} retries+${dr}`;
      ck(`失败分类：${label} → ${want === 'data' ? '不重试、标 poisoned' : '退避重试'}`, got === want, got);
    }
    // 慢事务：单个落库事务超过 2 秒记一行 warn 并计数
    const s = mk('wecom:wmSlow1');
    await store.flushSession(s.id);
    const slow0 = stats().slowTx;
    fx.faults.gate = sleep(2100) as Promise<void>;
    say(s, 'customer', '慢');
    await tick(); // 落库已经起了、在闸门前等着
    fx.faults.gate = null;
    await store.flushSession(s.id, { timeoutMs: 5000 });
    ck('慢事务：超过 2 秒的落库计数', stats().slowTx - slow0 === 1);
    // 退避：1 秒、5 秒、30 秒、2 分钟、之后每 2 分钟。drain 让退避中的重试立即再试，不用真等
    await store.drainStore(3000); // 上面分类表里排着重试的先都提交掉
    const b = mk('wecom:wmBackoff1');
    say(b, 'customer', 'b0');
    await store.flushSession(b.id);
    fx.faults.acquire = fakeDbError('08006');
    say(b, 'agent', 'b1');
    await sleep(20);
    const delays = [stats().lastRetryDelayMs];
    for (let i = 0; i < 4; i++) {
      await store.drainStore(30);
      delays.push(stats().lastRetryDelayMs);
    }
    fx.faults.acquire = null;
    const rb = await store.drainStore(2000);
    ck('退避：连续失败依次等 1 秒、5 秒、30 秒、2 分钟、之后每 2 分钟', delays.join() === '1000,5000,30000,120000,120000', delays.join());
    ck('退避：恢复之后提交', (await dbMsgs(b.id)).length === 2 && !rb.undrained.includes(b.id));
  }

  // ---- drain：退避中的重试立即再试；租户锁在别人手里时不写库 ----
  {
    const s = mk('wecom:wmDrain1');
    say(s, 'customer', 'd1');
    await store.flushSession(s.id);
    fx.faults.acquire = fakeDbError('08006');
    say(s, 'agent', 'd2');
    await sleep(50); // 失败一次，退避 1 秒
    fx.faults.acquire = null;
    const t0 = Date.now();
    const r = await store.drainStore(2000);
    const took = Date.now() - t0;
    ck(
      'drain：退避中的重试不等了，立即再试，排空',
      !r.undrained.includes(s.id) && took < 800 && (await dbMsgs(s.id)).length === 2,
      `${took}ms ${r.undrained.length}`,
    );
    ck('drain：poisoned 的会话留给 spill（在 undrained 里）', r.undrained.includes(longId) && r.undrained.includes('wecom:wmCorrupt1'));
    // 租户锁被别的进程拿走（held_by_other）：normal 段里也不再写库，退避到点的重试也不发，改动全部留给 spill
    const idle = mk('wecom:wmLockIdle');
    say(idle, 'customer', 'l1');
    await store.flushSession(idle.id);
    fx.faults.acquire = fakeDbError('08006');
    say(s, 'customer', 'd3'); // 失败一次，1 秒后重试
    await sleep(30);
    fx.faults.acquire = null;
    config.__configTest.setTimings({ reacquireMs: 10 });
    lock.next = 'held_by_other';
    lock.lose();
    await sleep(100);
    ck('租户锁被另一个进程拿走：tenantLockTaken() 为真', config.tenantLockTaken());
    const st0 = stats().attempts;
    say(idle, 'customer', 'held_by_other 之后的这一句');
    await sleep(30);
    ck('租户锁在别人手里：saveSession 不起落库', stats().attempts === st0, `attempts +${stats().attempts - st0}`);
    const r2 = await store.drainStore(300); // d3 还在 1 秒的退避里：drain 也不许提前重试
    ck(
      'drain：租户锁在别人手里时不写库（退避中的重试也不提前试），全部留给 spill',
      r2.undrained.includes(s.id) && r2.undrained.includes(idle.id) && stats().attempts === st0,
      `attempts +${stats().attempts - st0}`,
    );
    await sleep(1000); // d3 的退避到点了（失败之后已过 1 秒多）
    ck(
      '租户锁在别人手里：退避到点的重试也不发，库里没有新写入',
      stats().attempts === st0 &&
        !(await dbMsgs(idle.id)).some((x) => x.content === 'held_by_other 之后的这一句') &&
        !(await dbMsgs(s.id)).some((x) => x.content === 'd3'),
      `attempts +${stats().attempts - st0}`,
    );
    // 子进程退出时 exit 钩子写 spill：父进程查它（带着「held_by_other 之后的这一句」）
  }
}

// ---------------- 子进程 disk：落盘的 PGlite，一个子进程就是一次「启动」 ----------------
// STORE_STEPS：dump（启动之后记下 identity map）加至多一个场景。场景在结尾自己发信号或被杀，结果在那之前写好
async function childDisk(res: ChildResult, save: () => void): Promise<void> {
  const steps = (process.env.STORE_STEPS ?? '').split(',').filter(Boolean);
  const tag = process.env.STORE_TAG ?? '';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { openTestDb, installPgSessionStore, fakeDbError } = await import('../db/testing.js');
  const { withTenant } = await import('../db/client.js');
  const t = await openTestDb({ dataDir: process.env.STORE_DATA_DIR! });
  const fx = await installPgSessionStore(t, { varDir: process.env.VAR_DIR! });
  const ctx = { tenantId: fx.deps.tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  /** 以超级用户查：一个事务里临时换回会话用户 */
  const su = <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  const ordersJson = (): Order[] => {
    try {
      return JSON.parse(fs.readFileSync(path.join(process.env.VAR_DIR!, 'orders.json'), 'utf8')) as Order[];
    } catch {
      return [];
    }
  };
  const store = await import('../store.js');
  const { SessionStoreStartupError } = await import('./backend.js');
  try {
    await store.initSessionStore(fx.deps);
  } catch (e) {
    // 与 boot() 一样：拒绝启动，打出 reason 与 detail，以 1 退出
    res.data.startup = e instanceof SessionStoreStartupError ? e.reason : String(e);
    res.data.startupDetail = e instanceof SessionStoreStartupError ? e.detail : '';
    save();
    process.exit(1);
  }
  res.data.startup = 'ok';
  res.data.stats = store.__storeTest.pgStats();
  if (steps.includes('dump')) {
    res.data.dump = memDump(store);
    const rows = await withTenant(fx.deps.db, ctx, async (tx) => {
      const { readConversationsAfter } = await import('../db/repo/conversations.js');
      return readConversationsAfter(tx, null, 1000);
    });
    // 内存与库一致：每个会话库里的 last_seq 与窗口起点就是内存里 seq 的样子
    res.data.seqsMatch = rows.every((r) => {
      const s = store.getSession(r.id);
      const first = s?.messages[0];
      return (
        !!s &&
        (first ? store.seqOf(first) === r.windowStartSeq : r.windowStartSeq === r.lastSeq + 1) &&
        (store.seqOf(s.messages.at(-1) ?? first!) ?? r.lastSeq) === r.lastSeq
      );
    });
    const { readMessagesFrom } = await import('../db/repo/messages.js');
    res.data.audits = await withTenant(fx.deps.db, ctx, async (tx) => {
      const { readAudit } = await import('../db/repo/audit.js');
      return (await readAudit(tx, { limit: 100 })).map((a) => a.action).filter((a) => a.startsWith('selftest.'));
    });
    res.data.dbMessages = Object.fromEntries(
      await Promise.all(
        rows.map(async (r) => [r.id, (await withTenant(fx.deps.db, ctx, (tx) => readMessagesFrom(tx, r.id, 1))).length] as const),
      ),
    );
    // spill 回放之后库里的附带行：任务、同意记录、订单（作废的也列）
    res.data.side = {
      jobs: (await su<{ k: string }>(`select dedupe_key as k from jobs where status = 'pending' order by 1`)).map((r) => r.k),
      consents: Object.fromEntries(
        (await su<{ c: string; n: number }>('select conversation_id as c, count(*)::int as n from consents group by 1')).map((r) => [
          r.c,
          r.n,
        ]),
      ),
      orders: await su<{ id: string; session_id: string | null; voided: boolean; void_reason: string | null }>(
        'select id, session_id, voided_at is not null as voided, void_reason from orders order by id',
      ),
    };
    res.data.voidedInMem = (res.data.side as { orders: { id: string; voided: boolean }[] }).orders
      .filter((o) => o.voided && store.getOrder(o.id) !== undefined)
      .map((o) => o.id);
  }
  const scenario = steps.find((s) => s !== 'dump');
  if (!scenario) return;
  const mk = (id: string) => store.getOrCreateSession(id, 'wecom');
  const say = (s: Session, role: ChatMessage['role'], content: string): void => {
    s.messages.push({ role, content, at: Date.now() });
    store.saveSession(s);
  };
  const keepAlive = setInterval(() => {}, 1000);
  const sigterm = async (): Promise<never> => {
    save();
    process.kill(process.pid, 'SIGTERM');
    await new Promise(() => {});
    throw new Error('unreachable');
  };
  void keepAlive;

  if (scenario === 'turns20') {
    // 20 轮（两个客户各 10 轮，含报价与下单）之后 SIGTERM：重启后的 identity map 与停机前相同（验收 4）
    process.env.LLM_MOCK = '1';
    const { handleMessage } = await import('../engine.js');
    const scripts: Record<string, string[]> = {
      'wecom:wmR20a': [
        '你好',
        '想去云南玩',
        '2个人',
        '11月1号出发',
        '多少钱',
        '有优惠吗',
        '就订这个',
        '好的谢谢',
        '还有别的推荐吗',
        '贵州呢',
      ],
      'wecom:wmR20b': ['在吗', '带爸妈去哪好', '4个人', '十月底', '贵州有什么', '报个价', '再便宜点', '下单', '怎么付款', '谢谢'],
    };
    for (let i = 0; i < 10; i++) for (const [sid, texts] of Object.entries(scripts)) await handleMessage(sid, texts[i]!, 'wecom');
    // 停机前最后一次落库失败一次、停在 1 秒的退避里：只有 drain 段立即重试才排得空（drain 钩子没接上就会进 spill）
    const a = store.getSession('wecom:wmR20a')!;
    fx.faults.acquire = fakeDbError('08006');
    say(a, 'system', '停机前的最后一条');
    say(a, 'agent', '再补一句');
    await sleep(30);
    fx.faults.acquire = null;
    res.data.retryPending = { dirty: store.storeHealth().dirty, retries: store.__storeTest.pgStats()?.retries ?? 0 };
    res.data.before = memDump(store);
    await sigterm();
  }
  if (scenario === 'midturn') {
    // mock LLM 延迟 6 秒的一轮进行中发 SIGTERM：normal 段等处理链（企微适配器的停机钩子同样这么做），重启后这一轮的客户消息与回复都在库里
    const http = await import('node:http');
    let calls = 0;
    const fake = http.createServer((req, rs) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        rs.setHeader('content-type', 'application/json');
        if (req.url?.endsWith('/embeddings')) {
          const input = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] }).input;
          rs.end(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 0 } }));
          return;
        }
        calls++;
        const body = JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '云南这个季节很合适，您几位出行？' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
        setTimeout(() => rs.end(body), calls === 1 ? 6000 : 0);
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    fake.unref();
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    Object.assign(process.env, {
      LLM_MOCK: '0',
      LLM_PROVIDER: '',
      LLM_BASE_URL: url,
      LLM_API_KEY: 'selftest-fake-key',
      LLM_MODEL: 'selftest-fake',
      EMBED_BASE_URL: url,
      EMBED_API_KEY: 'selftest-fake-key',
      LLM_HEDGE_MODEL: '',
      LLM_MAX_RETRY: '0',
    });
    const { handleMessage } = await import('../engine.js');
    const t0 = Date.now();
    const turn = handleMessage('wecom:wmMid1', '你好，想去云南看看', 'wecom');
    // normal 段等这一轮；回复那次落库失败一次、停在退避里，这一轮结束之后才恢复：只有 drain 段立即重试才排得空
    store.onShutdown(async () => {
      await turn;
      await sleep(20);
      res.data.replyRetried = (store.__storeTest.pgStats()?.retries ?? 0) >= 1;
      fx.faults.acquire = null;
      save();
    });
    await sleep(1000);
    res.data.sigtermAfterMs = Date.now() - t0;
    res.data.customerSaved = (store.getSession('wecom:wmMid1')?.messages.length ?? 0) === 1 && store.storeHealth().dirty === 0;
    fx.faults.acquire = fakeDbError('08006');
    await sigterm();
  }
  if (scenario === 'unwritable') {
    // drain 段 PG 不可写：停机写出 spill 文件，恢复后重启回放，库与停机前的内存一致（验收 4）。
    // 在途（失败、等着重试）的快照与之后排进来的各带一份订单、审计、任务、同意记录，另一个会话断库期间作废一张已提交的订单
    const order = (sessionId: string) =>
      store.createOrder({
        sessionId,
        routeId: 'r-yunnan-mid',
        routeTitle: '云南',
        travelers: 2,
        departDate: '2026-11-01',
        totalPrice: 6560,
      });
    const actor = { kind: 'user' as const, userId: null, name: '小林', ip: null };
    const job = (sid: string, key: string) => ({
      op: 'enqueue' as const,
      kind: 'followup' as const,
      dedupeKey: `followup:${sid}:${key}`,
      runAt: Date.now() + 3600_000,
      payload: { sessionId: sid },
      maxAttempts: 3,
    });
    const a = mk(`wecom:wmUw${tag}a`);
    say(a, 'customer', '先落库的');
    say(a, 'agent', '这句也落了');
    const b = mk(`wecom:wmUw${tag}b`);
    say(b, 'customer', 'b 先落库的');
    const dd = mk(`wecom:wmUw${tag}d`);
    dd.orderIds.push(order(dd.id).id);
    say(dd, 'customer', 'd 下了单');
    await store.flushSession(a.id);
    await store.flushSession(b.id);
    await store.flushSession(dd.id);
    fx.faults.acquire = fakeDbError('08006', '模拟 PG 不可写');
    // 第一段同步代码：进各自在途的那个快照
    store.queueAudit(a.id, actor, { action: `selftest.spill${tag}.inflight` });
    say(a, 'customer', '没落库的');
    const c = mk(`wecom:wmUw${tag}c`);
    c.orderIds.push(order(c.id).id);
    say(c, 'customer', '库里还没有这个会话');
    store.queueJobs(dd.id, [job(dd.id, `inflight${tag}`)]);
    store.queueConsents(dd.id, [{ category: 'health', decision: 'asked', noticeVersion: 1, evidence: null, at: Date.now() }]);
    say(dd, 'customer', 'd 断库时说的');
    await sleep(50); // 快照都取了、各失败一次，停在退避里
    // 之后排进来的：留在写队列顶层
    store.queueAudit(a.id, actor, { action: `selftest.spill${tag}` });
    a.orderIds.push(order(a.id).id);
    store.saveSession(a);
    say(b, 'agent', 'b 没落库的');
    res.data.voidedOrder = dd.orderIds[0];
    store.deleteOrdersOfSession(dd.id);
    dd.orderIds = [];
    store.queueJobs(dd.id, [job(dd.id, `queued${tag}`)]);
    store.queueConsents(dd.id, [{ category: 'minor', decision: 'granted', noticeVersion: 1, evidence: null, at: Date.now() }]);
    store.saveSession(dd);
    await sleep(100);
    res.data.dirtyBefore = store.storeHealth().dirty;
    res.data.before = memDump(store);
    await sigterm();
  }
  if (scenario === 'crash') {
    // 模拟崩溃（落库之前丢弃进程，没有停机钩子、没有 spill）：重启后只少最后一次没提交的落库
    const s = mk('wecom:wmCrash1');
    say(s, 'customer', '崩溃前 1');
    say(s, 'agent', '崩溃前 2');
    await store.flushSession(s.id);
    say(s, 'customer', '崩溃前 3');
    await store.flushSession(s.id);
    res.data.before = memDump(store);
    fx.faults.gate = new Promise(() => {}); // 下一次落库永远卡在借连接之前
    say(s, 'agent', '没提交的这一句');
    await sleep(50);
    save();
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  if (scenario === 'conflict') {
    // 另一写者让库里的 last_seq 前进一格：落库发现对不上 → store_conflict，优雅停机（以 1 退出），没落库的进 spill
    const s = mk('wecom:wmConf1');
    say(s, 'customer', '冲突前');
    await store.flushSession(s.id);
    // 另一写者：照样锁行、插一条消息、把 last_seq 推前一格（库本身仍然自洽，只是接不上本进程的「已提交到第几条」）
    const { lockConversation, updateConversation } = await import('../db/repo/conversations.js');
    const { insertMessages } = await import('../db/repo/messages.js');
    const proj = await import('./project.js');
    await withTenant(fx.deps.db, ctx, async (tx) => {
      const cur = (await lockConversation(tx, s.id))!;
      await insertMessages(tx, s.id, [proj.messageToRow({ role: 'agent', content: '另一写者写的', at: Date.now() }, cur.lastSeq + 1)]);
      await updateConversation(tx, proj.sessionToRow(s), {
        lastSeq: cur.lastSeq + 1,
        windowStartSeq: cur.windowStartSeq,
        flushId: randomUUID(),
      });
    });
    say(s, 'agent', '冲突后的这一句');
    save();
    await new Promise(() => {});
  }
  if (scenario === 'orphan') {
    // orders.json 里的孤儿订单：同 id 的会话建出来 → 随它的落库进库 → orders.json 去掉它 → 重置（作废）
    const oid = 'ord_diskorphan1';
    const sid = 'wecom:wmDiskOrphan';
    res.data.orphanBefore = store.getOrder(oid)?.status ?? null;
    const s = mk(sid);
    say(s, 'customer', '孤儿订单的主人回来了');
    await store.flushSession(sid);
    await store.drainStore(1000);
    res.data.jsonAfterCommit = ordersJson().some((o) => o.id === oid);
    res.data.dbAfterCommit =
      (
        await su<{ session_id: string; voided: boolean }>('select session_id, voided_at is not null as voided from orders where id = $1', [
          oid,
        ])
      )[0] ?? null;
    store.deleteOrdersOfSession(sid);
    s.orderIds = [];
    store.saveSession(s);
    await store.flushSession(sid);
    res.data.dbAfterVoid =
      (
        await su<{ voided: boolean; void_reason: string | null }>(
          'select voided_at is not null as voided, void_reason from orders where id = $1',
          [oid],
        )
      )[0] ?? null;
    res.data.gone = store.getOrder(oid) === undefined;
    await sigterm();
  }
  if (scenario === 'orphan2') {
    // 重启时 orders.json 里还留着那张作废订单的旧副本（老版本的进程没来得及重写 JSON）：以库为准，不复活、不取消作废；
    // 另一张属于预载会话、库里没有的订单挂到这个会话的写队列上
    const oid = 'ord_diskorphan1';
    res.data.staleGone = store.getOrder(oid) === undefined;
    res.data.superseded = store.supersedeOrder(oid, 'ord_x');
    res.data.paid = store.markOrderPaid(oid) !== undefined;
    res.data.adoptInMem = store.getOrder('ord_jsonadopt1')?.sessionId ?? null;
    await store.flushSession('wecom:wmCrash1');
    await store.drainStore(1000);
    const json = ordersJson();
    res.data.staleInJson = json.some((o) => o.id === oid);
    res.data.adoptInJson = json.some((o) => o.id === 'ord_jsonadopt1');
    res.data.dbStale =
      (
        await su<{ status: string; voided: boolean; void_reason: string | null }>(
          'select status, voided_at is not null as voided, void_reason from orders where id = $1',
          [oid],
        )
      )[0] ?? null;
    res.data.dbAdopt =
      (await su<{ session_id: string | null }>('select session_id from orders where id = $1', ['ord_jsonadopt1']))[0] ?? null;
    // late 段关了写队列：之后的 saveSession 不再起落库（留给 exit 时的 spill）
    store.onShutdown(
      async () => {
        const a0 = store.__storeTest.pgStats()!.attempts;
        say(store.getSession('wecom:wmCrash1')!, 'customer', 'late 段之后的这一句');
        await sleep(30);
        res.data.lateAttempts = store.__storeTest.pgStats()!.attempts - a0;
        save();
      },
      { phase: 'late' },
    );
    await sigterm();
  }
  if (scenario === 'poisonspill') {
    // poisoned 的会话停机时随 spill 写出；原因没修好就重启，回放仍失败 → spill 改名 .failed，从库里的状态起
    const s = mk(`wecom:${'p'.repeat(195)}`);
    say(s, 'customer', 'id 超长，落不了库');
    await sleep(100);
    res.data.poisoned = store.storeHealth().poisoned;
    await sigterm();
  }
}

// ---------------- 子进程 rpg：真实 Postgres（PG_TEST_URL） ----------------
async function childRealPg(res: ChildResult, save: () => void): Promise<void> {
  const scenario = process.env.STORE_SCENARIO;
  const APP = process.env.STORE_APP_URL!;
  const tenantId = process.env.STORE_TENANT_ID!;
  const varDir = process.env.VAR_DIR!;
  const { openDb, withTenant } = await import('../db/client.js');
  const { openFlakyDb } = await import('../db/testing.js');
  const store = await import('../store.js');
  const ctx = { tenantId, actor: { kind: 'system' as const, userId: null, name: null, ip: null } };
  const say = (s: Session, role: ChatMessage['role'], content: string): void => {
    s.messages.push({ role, content, at: Date.now() });
    store.saveSession(s);
  };
  if (scenario === 'conflict') {
    const main = await openDb(APP);
    await store.initSessionStore({ db: main.db, tenantId, tenantSlug: 'demo', varDir });
    const s = store.getOrCreateSession('wecom:wmRpgConf', 'wecom');
    say(s, 'customer', '冲突前');
    await store.flushSession(s.id);
    // 另一写者：另一条 agent_app 连接把 last_seq 推前一格
    const other = await openDb(APP, { max: 1 });
    // 另一写者：照样锁行、插一条消息、把 last_seq 推前一格（库本身仍然自洽，只是接不上本进程的「已提交到第几条」）
    const { lockConversation, updateConversation } = await import('../db/repo/conversations.js');
    const { insertMessages } = await import('../db/repo/messages.js');
    const proj = await import('./project.js');
    await withTenant(other.db, ctx, async (tx) => {
      const cur = (await lockConversation(tx, s.id))!;
      await insertMessages(tx, s.id, [proj.messageToRow({ role: 'agent', content: '另一写者写的', at: Date.now() }, cur.lastSeq + 1)]);
      await updateConversation(tx, proj.sessionToRow(s), {
        lastSeq: cur.lastSeq + 1,
        windowStartSeq: cur.windowStartSeq,
        flushId: randomUUID(),
      });
    });
    await other.close();
    store.onShutdown(() => main.close(), { phase: 'late' });
    setInterval(() => {}, 1000);
    say(s, 'agent', '冲突后的这一句');
    save();
    await new Promise(() => {});
  }
  if (scenario === 'commitdrop') {
    const flaky = await openFlakyDb(APP);
    await store.initSessionStore({ db: flaky.db, tenantId, tenantSlug: 'demo', varDir });
    const s = store.getOrCreateSession('wecom:wmRpgDrop', 'wecom');
    say(s, 'customer', '第一句');
    say(s, 'agent', '第二句');
    await store.flushSession(s.id);
    const got: string[] = [];
    store.onCommitted((ev) => got.push(ev.type));
    // 第一次落库照常；之后来的第二次（一条消息加一个事件）COMMIT 之后回包丢掉
    flaky.faults.skipCommits = 1;
    flaky.faults.dropCommitReply = 1;
    say(s, 'customer', '第三句');
    await new Promise<void>((r) => setImmediate(r)); // 第一次已经起了
    say(s, 'agent', 'COMMIT 之后回包丢了的这一句');
    store.emitAfterCommit(s.id, { type: 'conversation.changed', id: s.id });
    const t0 = Date.now();
    let flushed = 'ok';
    await store.flushSession(s.id, { timeoutMs: 6000 }).catch((e: unknown) => {
      flushed = String(e);
    });
    const check = await openDb(APP, { max: 1 });
    const { readMessagesFrom } = await import('../db/repo/messages.js');
    const { lockConversation } = await import('../db/repo/conversations.js');
    const inDb = await withTenant(check.db, ctx, async (tx) => ({
      seqs: (await readMessagesFrom(tx, s.id, 1)).map((m) => m.seq),
      row: await lockConversation(tx, s.id),
    }));
    await check.close();
    const h = store.storeHealth();
    res.data.commitdrop = {
      flushed,
      tookMs: Date.now() - t0,
      stats: store.__storeTest.pgStats(),
      seqs: inDb.seqs,
      lastSeq: inDb.row?.lastSeq,
      conflict: h.conflict,
      poisoned: h.poisoned.length,
      dirty: h.dirty,
      events: got,
      dropsLeft: flaky.faults.dropCommitReply,
    };
    await flaky.close();
  }
  if (scenario === 'newcommitdelay') {
    // 新会话第一次落库：客户端立即收到断线，COMMIT 过 1.5 秒才到库里。1 秒后的重试锁不到那一行（还没提交、看不见），
    // 插入在主键上等它提交、冲突了不报错，再锁一次就认出已提交：不 poisoned、不重复插入
    const flaky = await openFlakyDb(APP);
    await store.initSessionStore({ db: flaky.db, tenantId, tenantSlug: 'demo', varDir });
    flaky.faults.dropCommitReply = 1;
    flaky.faults.delayCommitMs = 1500;
    const s = store.getOrCreateSession('wecom:wmRpgNewDelay', 'wecom');
    say(s, 'customer', '新会话的第一句');
    say(s, 'agent', '第二句');
    let flushed = 'ok';
    await store.flushSession(s.id, { timeoutMs: 8000 }).catch((e: unknown) => {
      flushed = String(e);
    });
    const check = await openDb(APP, { max: 1 });
    const { readMessagesFrom } = await import('../db/repo/messages.js');
    const { readConversationsAfter } = await import('../db/repo/conversations.js');
    const inDb = await withTenant(check.db, ctx, async (tx) => ({
      seqs: (await readMessagesFrom(tx, s.id, 1)).map((m) => m.seq),
      rows: (await readConversationsAfter(tx, null, 100)).filter((r) => r.id === s.id).map((r) => r.lastSeq),
    }));
    await check.close();
    const h = store.storeHealth();
    res.data.newcommit = {
      flushed,
      stats: store.__storeTest.pgStats(),
      seqs: inDb.seqs,
      rows: inDb.rows,
      conflict: h.conflict,
      poisoned: h.poisoned.length,
      dirty: h.dirty,
      dropsLeft: flaky.faults.dropCommitReply,
    };
    await flaky.close();
  }
}

// ---------------- 父进程：起子进程、收结果 ----------------
async function pgSuites(): Promise<void> {
  const self = import.meta.filename;
  const runStoreChild = (
    mode: string,
    env: Record<string, string | undefined>,
    timeoutMs = 60_000,
  ): { status: number | null; signal: NodeJS.Signals | null; out: string; took: number; result: ChildResult | null } => {
    const resultFile = path.join(VAR_DIR, `child-${mode}-${randomUUID()}.json`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--import', 'tsx', self], {
      cwd: process.cwd(),
      env: childEnv({ ...env, STORE_SELFTEST_CHILD: mode, STORE_CHILD_RESULT: resultFile, CONFIG_SOURCE: 'file' }),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    let result: ChildResult | null = null;
    try {
      result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as ChildResult;
    } catch {
      result = null;
    }
    return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, took: Date.now() - t0, result };
  };
  /**
   * 子进程里的断言并进本进程的计数。disk 子进程启动失败（startup 不是预期的那个）时把 reason 与 detail 也记成失败，
   * 后面的断言拿不到数据时不至于只剩一段堆栈
   */
  const merge = (label: string, r: ReturnType<typeof runStoreChild>, expectStartup?: string): ChildResult['data'] => {
    if (!r.result) {
      fails.push(`${label}：子进程没留下结果（status=${r.status} signal=${r.signal}）${r.out.slice(-600)}`);
      return {};
    }
    pass += r.result.pass;
    for (const f of r.result.fails) fails.push(`${label}：${f}`);
    const st = r.result.data.startup;
    if (expectStartup !== undefined && st !== expectStartup) {
      fails.push(
        `${label}：启动结果是 ${String(st)}（预期 ${expectStartup}）${String(r.result.data.startupDetail ?? '')} ${r.out.slice(-300)}`,
      );
    }
    return r.result.data;
  };
  /** 断言的 detail：undefined 也能截断 */
  const brief = (x: unknown, n = 200): string => String(JSON.stringify(x ?? null)).slice(0, n);
  const spillsIn = (dir: string) => fs.readdirSync(dir).filter((f) => /^store-spill-.+\.json$/.test(f));
  const sameMem = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);

  // ---- PGlite 上的进程内各组 ----
  {
    const dir = freshVarDir(
      'pg',
      [
        session('sim-storeselftestdemo1', [msg('customer', '访客', 1)], 'simulator'),
        session('wecom:cust_A01', [msg('customer', '种子', 1)]),
      ],
      [
        {
          id: 'ord_orphan1',
          sessionId: 'wecom:wmGone',
          routeId: 'r-yunnan-mid',
          routeTitle: '云南',
          travelers: 2,
          departDate: '2026-11-01',
          totalPrice: 6560,
          status: 'pending_payment',
          createdAt: Date.now() - 86_400_000,
        },
      ],
    );
    const r = runStoreChild('pg', { VAR_DIR: dir }, 120_000);
    merge('PGlite', r);
    check('PGlite：子进程正常结束', r.status === 0, `status=${r.status} ${r.out.slice(-400)}`);
    const exitSpill = spillsIn(dir);
    check(
      '租户锁在别人手里时没写库的改动，进程退出时写进 spill',
      exitSpill.length === 1 && fs.readFileSync(path.join(dir, exitSpill[0]!), 'utf8').includes('held_by_other 之后的这一句'),
      exitSpill.join(),
    );
  }

  // ---- 落盘的 PGlite：重启、停机、崩溃、spill 与回放（一个库，一串「启动」） ----
  {
    const dataDir = fs.mkdtempSync(path.join(VAR_DIR, 'pgdata-'));
    const varDisk = freshVarDir('disk', [], []);
    const disk = (steps: string[], extra: Record<string, string> = {}) =>
      runStoreChild('disk', { VAR_DIR: varDisk, STORE_DATA_DIR: dataDir, STORE_STEPS: steps.join(','), LLM_MOCK: '1', ...extra }, 90_000);

    const c1 = disk(['turns20']);
    const d1 = merge('重启 1', c1, 'ok');
    check('SIGTERM：20 轮之后收到 SIGTERM，以 143 退出（优雅停机）', c1.status === 143, `status=${c1.status} ${c1.out.slice(-400)}`);
    check(
      'SIGTERM：停机前最后一次落库停在退避里，drain 段立即重试排空，没有 spill',
      ((d1.retryPending as { dirty?: number } | undefined)?.dirty ?? 0) >= 1 &&
        ((d1.retryPending as { retries?: number } | undefined)?.retries ?? 0) >= 1 &&
        spillsIn(varDisk).length === 0,
      `${brief(d1.retryPending)} ${spillsIn(varDisk).join()}`,
    );
    const c2 = disk(['dump', 'midturn']);
    const d2 = merge('重启 2', c2, 'ok');
    const before1 = (d1.before ?? null) as { sessions: Session[] } | null;
    check(
      '重启不丢：20 轮之后 SIGTERM 再启动，identity map 与停机前经 JSON 规范化之后 deepStrictEqual（验收 4）',
      !!before1 && before1.sessions.length === 2 && sameMem(d2.dump, before1),
      brief(d2.dump),
    );
    check('重启：库里的 last_seq 与窗口起点就是内存里 seq 的样子', d2.seqsMatch === true);
    check(
      'SIGTERM 在一轮中间：normal 段等这一轮的模型回复（6 秒）回来再停，以 143 退出',
      c2.status === 143 && c2.took >= 6000 && d2.customerSaved === true,
      `status=${c2.status} took=${c2.took}`,
    );
    check(
      'SIGTERM 在一轮中间：回复那次落库停在退避里，drain 段立即重试排空，没有 spill',
      d2.replyRetried === true && spillsIn(varDisk).length === 0,
      `${String(d2.replyRetried)} ${spillsIn(varDisk).join()}`,
    );
    const c3 = disk(['dump', 'unwritable'], { STORE_TAG: '1' });
    const d3 = merge('重启 3', c3, 'ok');
    check('SIGTERM 在一轮中间：重启时没有要回放的 spill', (d3.stats as { replayed?: number } | undefined)?.replayed === 0);
    const mid = (d3.dump as { sessions: Session[] } | undefined)?.sessions.find((s) => s.id === 'wecom:wmMid1');
    check(
      'SIGTERM 在一轮中间：重启后这一轮的客户消息与回复都在库里（验收 4）',
      mid?.messages.length === 2 &&
        mid.messages[0]!.content === '你好，想去云南看看' &&
        mid.messages[1]!.role === 'agent' &&
        mid.messages[1]!.content.includes('云南'),
      JSON.stringify(mid?.messages),
    );
    check('drain 段 PG 不可写：照样以 143 退出', c3.status === 143, `status=${c3.status} ${c3.out.slice(-300)}`);
    const spill1 = spillsIn(varDisk);
    check(
      'drain 段 PG 不可写：exit 时写出 spill 文件（先写临时文件再改名，没有残留的 .tmp）',
      spill1.length === 1 && !fs.readdirSync(varDisk).some((f) => f.endsWith('.tmp')),
      spill1.join(),
    );
    type SpillSide = { audits: unknown[]; jobs: unknown[]; consents: unknown[] };
    const spillDoc = spill1.length
      ? (JSON.parse(fs.readFileSync(path.join(varDisk, spill1[0]!), 'utf8')) as {
          sessions: (SpillSide & {
            id: string;
            committedSeq: number;
            messages: unknown[];
            orders: { voided: unknown }[];
            inflight: (SpillSide & { flushId: string }) | null;
          })[];
        })
      : null;
    const sp = (id: string) => spillDoc?.sessions.find((s) => s.id === id);
    check(
      'spill：每个有未提交改动的会话一条，带已提交到第几条、未提交的消息、订单与审计',
      spillDoc?.sessions.length === 4 &&
        sp('wecom:wmUw1a')?.committedSeq === 2 &&
        sp('wecom:wmUw1a')?.messages.length === 1 &&
        sp('wecom:wmUw1a')?.orders.length === 1 &&
        sp('wecom:wmUw1a')?.audits.length === 1 &&
        sp('wecom:wmUw1c')?.committedSeq === 0 &&
        sp('wecom:wmUw1c')?.orders.length === 1,
      brief(
        spillDoc?.sessions.map((s) => [s.id, s.committedSeq, s.messages.length, s.orders.length, s.audits.length]),
        400,
      ),
    );
    check(
      'spill：在途（失败、等着重试）那个快照带的审计、任务、同意记录分开记在 inflight 里，之后排的在顶层',
      sp('wecom:wmUw1a')?.inflight?.audits.length === 1 &&
        sp('wecom:wmUw1c')?.inflight !== null &&
        sp('wecom:wmUw1d')?.inflight?.jobs.length === 1 &&
        sp('wecom:wmUw1d')?.inflight?.consents.length === 1 &&
        sp('wecom:wmUw1d')?.jobs.length === 1 &&
        sp('wecom:wmUw1d')?.consents.length === 1,
      brief(sp('wecom:wmUw1d'), 400),
    );
    check(
      'spill：断库期间作废的订单带着作废信息写进 spill',
      sp('wecom:wmUw1d')?.orders.length === 1 && !!sp('wecom:wmUw1d')?.orders[0]?.voided,
    );
    const before3 = d3.before as { sessions: Session[]; orders: Order[] } | undefined;
    const c4 = disk(['dump', 'unwritable'], { STORE_TAG: '2' });
    const d4 = merge('重启 4', c4, 'ok');
    check(
      'spill 回放：恢复 PG 后重启，先回放 spill，库与停机前的内存一致（验收 4）',
      !!before3 && sameMem(d4.dump, before3) && (d4.stats as { replayed?: number } | undefined)?.replayed === 4,
      brief(d4.stats),
    );
    check(
      'spill 回放：订单与审计一起回放（在途快照带的审计与之后排的都在）',
      (d4.audits as string[] | undefined)?.includes('selftest.spill1') === true &&
        (d4.audits as string[]).includes('selftest.spill1.inflight') &&
        (before3?.orders.length ?? 0) > 0,
      brief(d4.audits),
    );
    check(
      'spill 回放：库里的消息就是停机前内存里的（没提交的那几条补上了）',
      (d4.dbMessages as Record<string, number> | undefined)?.['wecom:wmUw1a'] === 3,
    );
    const side4 = d4.side as
      | {
          jobs: string[];
          consents: Record<string, number>;
          orders: { id: string; session_id: string | null; voided: boolean; void_reason: string | null }[];
        }
      | undefined;
    check(
      'spill 回放：在途快照与顶层的任务、同意记录都写进库',
      !!side4 &&
        side4.jobs.includes('followup:wecom:wmUw1d:inflight1') &&
        side4.jobs.includes('followup:wecom:wmUw1d:queued1') &&
        side4.consents['wecom:wmUw1d'] === 2,
      brief(side4 && { jobs: side4.jobs, consents: side4.consents }, 400),
    );
    const vo = side4?.orders.find((o) => o.id === d3.voidedOrder);
    check(
      'spill 回放：断库期间的作废写进库，重启后 getOrder 拿不到作废单；在途快照里新会话的订单也进了库',
      !!vo &&
        vo.voided &&
        vo.void_reason === 'reset' &&
        (d4.voidedInMem as string[] | undefined)?.length === 0 &&
        side4!.orders.some((o) => o.session_id === 'wecom:wmUw1c' && !o.voided),
      brief({ vo, inMem: d4.voidedInMem }),
    );
    const spill2 = spillsIn(varDisk);
    check('spill 回放：回放成功后删掉旧的 spill，这次停机写出新的', spill2.length === 1 && spill2[0] !== spill1[0]);
    // 把「已提交到第几条」改错一格：启动以 spill_conflict 拒绝
    const spill2Path = path.join(varDisk, spill2[0] ?? 'missing');
    const original = fs.existsSync(spill2Path) ? fs.readFileSync(spill2Path, 'utf8') : '{}';
    const tampered = JSON.parse(original) as { sessions: { id: string; committedSeq: number }[] };
    const victim = (tampered.sessions ?? []).find((s) => s.id === 'wecom:wmUw2a');
    if (victim) victim.committedSeq += 1;
    fs.writeFileSync(spill2Path, JSON.stringify(tampered));
    const c5 = disk([]);
    const d5 = merge('重启 5', c5, 'spill_conflict');
    check(
      'spill 回放：「已提交到第几条」改错一格，启动以 spill_conflict 拒绝，点名会话短码，spill 留着（验收 4）',
      c5.status === 1 && d5.startup === 'spill_conflict' && String(d5.startupDetail).includes('UW2A') && fs.existsSync(spill2Path),
      `${c5.status} ${String(d5.startup)} ${String(d5.startupDetail)}`,
    );
    fs.writeFileSync(spill2Path, original);
    const before4 = d4.before as unknown;
    const c6 = disk(['dump', 'crash']);
    const d6 = merge('重启 6', c6, 'ok');
    check('spill 改回原样之后照常回放启动', sameMem(d6.dump, before4) && spillsIn(varDisk).length === 0);
    check('模拟崩溃：进程被 SIGKILL', c6.signal === 'SIGKILL', `${c6.status} ${c6.signal}`);
    check('模拟崩溃：没有停机钩子，也没有 spill', spillsIn(varDisk).length === 0);
    const c7 = disk(['dump', 'conflict']);
    const d7 = merge('重启 7', c7, 'ok');
    check(
      '模拟崩溃后重启：只少最后一次没提交的落库，库与内存一致（验收 4）',
      sameMem(d7.dump, d6.before) && d7.seqsMatch === true,
      brief(
        (d7.dump as { sessions: Session[] } | undefined)?.sessions.find((s) => s.id === 'wecom:wmCrash1')?.messages.map((m) => m.content),
      ),
    );
    check(
      '另一写者（PGlite）：库里的 last_seq 前进一格后再落库，进程以优雅停机退出（1），日志点名 store_conflict',
      c7.status === 1 && c7.out.includes('store_conflict') && c7.out.includes('[shutdown]'),
      `status=${c7.status} ${c7.out.slice(-400)}`,
    );
    const conflictSpill = spillsIn(varDisk);
    check(
      '另一写者：drain 段跳过 PG，没落库的直接进 spill',
      conflictSpill.length === 1 && fs.readFileSync(path.join(varDisk, conflictSpill[0]!), 'utf8').includes('冲突后的这一句'),
    );
    const c8 = disk([]);
    const d8 = merge('重启 8', c8, 'spill_conflict');
    check(
      '另一写者之后：spill 接不上库里的 last_seq，启动以 spill_conflict 拒绝（要人来查）',
      c8.status === 1 && d8.startup === 'spill_conflict',
    );
    for (const f of spillsIn(varDisk)) fs.unlinkSync(path.join(varDisk, f));
    const c9 = disk(['dump', 'poisonspill']);
    const d9 = merge('重启 9', c9, 'ok');
    check(
      'poisoned 的会话：停机时随 spill 写出',
      c9.status === 143 && (d9.poisoned as string[] | undefined)?.length === 1 && spillsIn(varDisk).length === 1,
    );
    const c10 = disk(['dump']);
    const d10 = merge('重启 10', c10, 'ok');
    check(
      'poisoned 的 spill：原因没修好就重启，回放仍失败 → 改名 .failed，从库里的状态起',
      c10.status === 0 &&
        d10.startup === 'ok' &&
        spillsIn(varDisk).length === 0 &&
        fs.readdirSync(varDisk).some((f) => f.endsWith('.json.failed')),
      `${c10.status} ${String(d10.startup)} ${c10.out.slice(-300)}`,
    );

    // ---- 孤儿订单在 JSON 与 PG 之间的交接：收养 → 提交后 orders.json 去掉它 → 重置作废 → 重启（JSON 里还留着旧副本也不复活） ----
    const ordersFile = path.join(varDisk, 'orders.json');
    const ordersNow = (): Order[] => (fs.existsSync(ordersFile) ? (JSON.parse(fs.readFileSync(ordersFile, 'utf8')) as Order[]) : []);
    const orphan = {
      id: 'ord_diskorphan1',
      sessionId: 'wecom:wmDiskOrphan',
      routeId: 'r-yunnan-mid',
      routeTitle: '云南',
      travelers: 2,
      departDate: '2026-11-01',
      totalPrice: 6560,
      status: 'pending_payment',
      createdAt: Date.now() - 86_400_000,
    } as Order;
    fs.writeFileSync(ordersFile, JSON.stringify([...ordersNow(), orphan], null, 2));
    const c11 = disk(['orphan']);
    const d11 = merge('重启 11', c11, 'ok');
    check('孤儿订单（重启链）：启动时在内存里（文件后端管）', d11.orphanBefore === 'pending_payment' && c11.status === 143, brief(d11));
    check(
      '孤儿订单（重启链）：随收养它的会话提交之后进了库，orders.json 去掉它',
      (d11.dbAfterCommit as { session_id?: string } | null)?.session_id === 'wecom:wmDiskOrphan' && d11.jsonAfterCommit === false,
      brief(d11),
    );
    check(
      '孤儿订单（重启链）：重置之后库里记作废，内存里拿不到',
      (d11.dbAfterVoid as { voided?: boolean; void_reason?: string } | null)?.voided === true &&
        (d11.dbAfterVoid as { void_reason?: string }).void_reason === 'reset' &&
        d11.gone === true,
    );
    // 模拟老版本没来得及重写 JSON：作废订单的旧副本塞回 orders.json；另放一张属于预载会话、库里没有的订单
    const adoptee = { ...orphan, id: 'ord_jsonadopt1', sessionId: 'wecom:wmCrash1' } as Order;
    fs.writeFileSync(ordersFile, JSON.stringify([...ordersNow(), orphan, adoptee], null, 2));
    const c12 = disk(['orphan2']);
    const d12 = merge('重启 12', c12, 'ok');
    check(
      '孤儿订单（重启链）：JSON 里留着作废订单的旧副本也不复活：getOrder 是 undefined，碰它（改单、付款）什么都不做',
      d12.staleGone === true && d12.superseded === false && d12.paid === false,
      brief(d12),
    );
    check(
      '孤儿订单（重启链）：库里仍是作废，orders.json 重写之后没有它',
      (d12.dbStale as { voided?: boolean; status?: string } | null)?.voided === true &&
        (d12.dbStale as { status?: string }).status === 'pending_payment' &&
        d12.staleInJson === false,
      brief(d12.dbStale),
    );
    check(
      'JSON 里属于预载会话、库里没有的订单：挂到这个会话的写队列上，提交之后进库、orders.json 去掉它',
      d12.adoptInMem === 'wecom:wmCrash1' &&
        (d12.dbAdopt as { session_id?: string } | null)?.session_id === 'wecom:wmCrash1' &&
        d12.adoptInJson === false,
      brief({ m: d12.adoptInMem, db: d12.dbAdopt, j: d12.adoptInJson }),
    );
    check(
      'late 段之后不再起落库（close 停掉写队列）',
      d12.lateAttempts === 0 && c12.status === 143,
      `${String(d12.lateAttempts)} ${c12.status}`,
    );
  }

  // ---- 导入导出与切换（plan 第 6 步，验收 3、不变量 14、15）：落盘的 PGlite 上一串子进程，一步一个 ----
  {
    const fx6 = xferFixture();
    const dataDir = fs.mkdtempSync(path.join(VAR_DIR, 'xferdata-'));
    const v = freshVarDir('xfer', fx6.sessions, fx6.orders);
    // --keep 在 var/ 之外、事先不存在（导入时建）
    const keep = path.join(VAR_DIR, `xferkeep-${randomUUID()}`);
    const data: Record<string, ChildResult['data']> = {};
    for (const step of ['import', 'dbstart', 'export', 'filechat', 'resync', 'dbstart2', 'export2']) {
      // 夹具的时间戳是固定的过去时刻：关掉访客的闲置清理（demo 行为，与导入导出无关），访客会话一路都在
      const env = { VAR_DIR: v, STORE_DATA_DIR: dataDir, XFER_STEP: step, XFER_KEEP: keep, LLM_MOCK: '1', DEMO_PRUNE_HOURS: '0' };
      const r = runStoreChild('xfer', env, 90_000);
      data[step] = merge(`导入导出 ${step}`, r);
      check(`导入导出 ${step}：子进程正常结束`, r.status === 0, `status=${r.status} ${r.out.slice(-600)}`);
      if (r.status !== 0) break;
    }
    check(
      'export：导出的真实会话与订单就是 db 存储停机前的内存（导入之后 db 存储期间的新消息都在导出里）',
      !!data.dbstart?.afterDb && sameMem(data.export?.exported, data.dbstart.afterDb),
      `${brief(data.export?.exported, 300)} / ${brief(data.dbstart?.afterDb, 300)}`,
    );
    const fileAfter = data.filechat?.fileAfter as { sessions: Session[]; orders: Order[] } | undefined;
    check(
      '文件存储下聊过：重置的会话订单删了（之后由 --resync 作废），新来了一个客户',
      data.filechat?.betaOrders === 0 && !!fileAfter?.sessions.some((s) => s.id === XFER.delta),
      `${String(data.filechat?.betaOrders)}`,
    );
    check(
      '导出 → 文件存储下再聊 → --resync → db 存储启动：identity map 与文件存储下聊完的内存经 JSON 规范化之后 deepStrictEqual（验收 3）',
      !!fileAfter && fileAfter.sessions.length === 4 && sameMem(data.dbstart2?.dump, fileAfter),
      `${brief(data.dbstart2?.dump, 300)} / ${brief(fileAfter, 300)}`,
    );
    const history = (data.dbstart2?.history ?? {}) as Record<string, number>;
    const windowOf = (id: string): number => fileAfter?.sessions.find((s) => s.id === id)?.messages.length ?? -1;
    check(
      '--resync 之后：库里有导出之后的新消息；重置过的会话旧消息仍在库里（窗口之外），历史比窗口长',
      history[XFER.alpha] === windowOf(XFER.alpha) &&
        windowOf(XFER.alpha) > fx6.sessions.find((s) => s.id === XFER.alpha)!.messages.length &&
        history[XFER.beta]! > windowOf(XFER.beta) &&
        history[XFER.delta] === windowOf(XFER.delta),
      JSON.stringify(history),
    );
    // 同一个落盘的 PGlite 上另两条链，各用自己的租户与 var/：import 写完标记、改写 JSON 之前崩了（crash → crashstart → crashfix），
    // 没经过 import 直接以 db 存储起时补写标记（fresh）
    const sideChain = (label: string, slug: string, steps: string[], sessions: unknown[], orders: unknown[]): void => {
      const sv = freshVarDir(label, sessions, orders);
      for (const step of steps) {
        const env = {
          VAR_DIR: sv,
          STORE_DATA_DIR: dataDir,
          XFER_STEP: step,
          XFER_SLUG: slug,
          XFER_KEEP: keep,
          LLM_MOCK: '1',
          DEMO_PRUNE_HOURS: '0',
        };
        const r = runStoreChild('xfer', env, 90_000);
        merge(`导入导出 ${step}`, r);
        check(`导入导出 ${step}：子进程正常结束`, r.status === 0, `status=${r.status} ${r.out.slice(-600)}`);
        if (r.status !== 0) break;
      }
    };
    sideChain('xfer-crash', 'demo4', ['crash', 'crashstart', 'crashfix'], fx6.sessions, fx6.orders);
    sideChain(
      'xfer-fresh',
      'demo5',
      ['fresh'],
      fx6.sessions.filter((x) => !fx6.real.includes(x.id)),
      fx6.orders.filter((o) => !fx6.real.includes(o.sessionId)),
    );
  }

  // ---- 真实 Postgres（PG_TEST_URL）：第二个进程、另一写者、COMMIT 之后回包丢掉（验收 8） ----
  const PG_TEST_URL = process.env.PG_TEST_URL;
  if (!PG_TEST_URL) {
    if (process.env.CI === 'true') fails.push('CI 下必须设 PG_TEST_URL：另一写者与 COMMIT 断线只在真实 Postgres 上测，不能静默跳过');
    else
      console.log(
        'STORE SELFTEST：没有 PG_TEST_URL，跳过真实 Postgres 部分（第二个进程、另一写者、COMMIT 之后回包丢掉、两个命令行的退出码）',
      );
    return;
  }
  realPgRan = true;
  const { createRealPgFixture } = await import('../db/testing.js');
  const fxr = await createRealPgFixture(PG_TEST_URL);
  const repo = path.join(import.meta.dirname, '..', '..');
  const cleanup: (() => unknown)[] = [];
  try {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DATABASE_|^PG_TEST_URL$/.test(k)));
    const imported = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(repo, 'src', 'cli', 'import-config.ts'), '--tenant', 'demo'],
      {
        cwd: repo,
        env: { ...base, DATABASE_URL: fxr.urls.app },
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
    );
    check('真实 PG：import-config 导入配置（给 server 启动用）', imported.status === 0, `${imported.stdout}${imported.stderr}`.slice(-300));
    // 第一个进程：真的 server.ts，SESSION_STORE=db
    const portOf = async (): Promise<number> => {
      const net = await import('node:net');
      return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
          const p = (srv.address() as AddressInfo).port;
          srv.close(() => resolve(p));
        });
      });
    };
    const port = await portOf();
    const serverEnv = (varDir: string, p: number): NodeJS.ProcessEnv => ({
      ...base,
      CONFIG_SOURCE: 'db',
      SESSION_STORE: 'db',
      DATABASE_URL: fxr.urls.app,
      DEFAULT_TENANT_SLUG: 'demo',
      DEPLOY_PROFILE: 'demo',
      PORT: String(p),
      VAR_DIR: varDir,
      LLM_MOCK: '1',
      SERVER_SELFTEST: '',
      ADMIN_PASS: '',
    });
    const serverTs = path.join(repo, 'src', 'server.ts');
    const srv1 = freshVarDir('srv1', [], []);
    const first = spawn(process.execPath, ['--import', 'tsx', serverTs], { cwd: repo, env: serverEnv(srv1, port) });
    let firstOut = '';
    first.stdout.on('data', (c: Buffer) => (firstOut += c.toString()));
    first.stderr.on('data', (c: Buffer) => (firstOut += c.toString()));
    const firstExit = new Promise<number | null>((r) => first.on('exit', (code) => r(code)));
    cleanup.push(() => first.kill('SIGKILL'));
    for (let i = 0; i < 300 && !firstOut.includes('[server] 已启动'); i++) await sleep(100);
    check('真实 PG：第一个进程以 SESSION_STORE=db 启动、监听', firstOut.includes('[server] 已启动'), firstOut.slice(-500));
    const hz = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json().catch(() => ({}))) as { store?: { mode?: string } };
    check('真实 PG：第一个进程的 /healthz 报 store.mode = db', hz.store?.mode === 'db', JSON.stringify(hz.store));
    const srvMarker = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(srv1, 'sessions-in-db.json'), 'utf8')) as { tenant?: unknown; sessions?: unknown };
      } catch {
        return null;
      }
    })();
    check(
      '真实 PG：server.ts 没经过 import-sessions 直接以 db 存储起来之后，var/ 里补写了标记文件（tenant 是 DEFAULT_TENANT_SLUG）',
      srvMarker?.tenant === 'demo' && Number.isInteger(srvMarker.sessions),
      JSON.stringify(srvMarker),
    );
    const second = spawnSync(process.execPath, ['--import', 'tsx', serverTs], {
      cwd: repo,
      env: serverEnv(freshVarDir('srv2', [], []), await portOf()),
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    check(
      '真实 PG：第二个进程连同一个库拒绝启动（租户锁，lock_held），以 1 退出（验收 8）',
      second.status === 1 && `${second.stdout}${second.stderr}`.includes('lock_held') && !`${second.stdout}`.includes('[server] 已启动'),
      `status=${second.status} ${`${second.stdout}${second.stderr}`.slice(-300)}`,
    );
    first.kill('SIGTERM');
    const code = await Promise.race([firstExit, sleep(15_000).then(() => 'timeout' as const)]);
    check('真实 PG：第一个进程收到 SIGTERM 优雅退出（143）', code === 143, String(code));

    const rpgEnv = (varDir: string, scenario: string) => ({
      VAR_DIR: varDir,
      STORE_SCENARIO: scenario,
      STORE_APP_URL: fxr.urls.app,
      STORE_TENANT_ID: fxr.tenantId,
    });
    const varConf = freshVarDir('rpg-conf', [], []);
    const rc = runStoreChild('rpg', rpgEnv(varConf, 'conflict'), 60_000);
    merge('真实 PG 冲突', rc);
    check(
      '真实 PG：人为让库里的 last_seq 前进一格后再落库，进程以优雅停机退出（1），日志点名 store_conflict（验收 8）',
      rc.status === 1 && rc.out.includes('store_conflict') && rc.out.includes('[shutdown]'),
      `status=${rc.status} ${rc.out.slice(-400)}`,
    );
    check(
      '真实 PG：冲突之后 drain 不写库，没落库的进 spill',
      spillsIn(varConf).length === 1 && fs.readFileSync(path.join(varConf, spillsIn(varConf)[0]!), 'utf8').includes('冲突后的这一句'),
    );
    const rd = runStoreChild('rpg', rpgEnv(freshVarDir('rpg-drop', [], []), 'commitdrop'), 60_000);
    const dd = merge('真实 PG 回包丢掉', rd).commitdrop as
      | {
          flushed: string;
          stats: { recognized: number } | null;
          seqs: number[];
          lastSeq: number;
          conflict: boolean;
          poisoned: number;
          dirty: number;
          events: string[];
          dropsLeft: number;
        }
      | undefined;
    check(
      '真实 PG：COMMIT 之后回包丢掉，重试按 flush_id 认出已提交，不停机、不重复插入（验收 8）',
      rd.status === 0 &&
        dd?.dropsLeft === 0 &&
        dd.flushed === 'ok' &&
        dd.stats?.recognized === 1 &&
        dd.seqs.join() === '1,2,3,4' &&
        dd.lastSeq === 4 &&
        !dd.conflict &&
        dd.poisoned === 0 &&
        dd.dirty === 0,
      JSON.stringify(dd),
    );
    check(
      '真实 PG：认出已提交之后补做提交后的步骤，事件恰好一次',
      dd?.events.filter((e) => e === 'conversation.changed').length === 1,
      JSON.stringify(dd?.events),
    );
    const rn = runStoreChild('rpg', rpgEnv(freshVarDir('rpg-newdelay', [], []), 'newcommitdelay'), 60_000);
    const dn = merge('真实 PG 新会话 COMMIT 晚到', rn).newcommit as
      | {
          flushed: string;
          stats: { recognized: number; attempts: number } | null;
          seqs: number[];
          rows: number[];
          conflict: boolean;
          poisoned: number;
          dirty: number;
          dropsLeft: number;
        }
      | undefined;
    check(
      '真实 PG：新会话第一次落库 COMMIT 断线、服务端稍后才提交，重试插入冲突不报错、再锁一次认出已提交，不 poisoned、不重复插入',
      rn.status === 0 &&
        dn?.dropsLeft === 0 &&
        dn.flushed === 'ok' &&
        dn.stats?.recognized === 1 &&
        dn.seqs.join() === '1,2' &&
        dn.rows.join() === '2' &&
        !dn.conflict &&
        dn.poisoned === 0 &&
        dn.dirty === 0,
      JSON.stringify(dn) + rn.out.slice(-300),
    );

    // ---- 导入导出（plan 第 6 步，验收 3）：两个命令行以子进程执行、断言退出码；持锁的是真的 server.ts（db 存储） ----
    await fxr.query(`insert into tenants (slug, name, pack_id) values ('xfer', 'xfer', 'travel')`);
    const cli = (name: string, args: string[]) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli', `${name}.ts`), ...args], {
        cwd: repo,
        env: { ...base, DATABASE_URL: fxr.urls.app },
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    check('真实 PG：import-config 给 xfer 租户导入配置（给 server 启动用）', cli('import-config', ['--tenant', 'xfer']).status === 0);
    const fx6 = xferFixture();
    const xv = freshVarDir('rpg-xfer', fx6.sessions, fx6.orders);
    const xk = path.join(VAR_DIR, `rpg-xferkeep-${randomUUID()}`);
    const marker = path.join(xv, 'sessions-in-db.json');
    const imp = (...extra: string[]) => cli('import-sessions', ['--tenant', 'xfer', '--keep', xk, '--var', xv, ...extra]);
    const exp = () => cli('export-sessions', ['--tenant', 'xfer', '--keep', xk, '--var', xv]);
    const xCounts = async (): Promise<string> => {
      const [r] = await fxr.query<{ c: number; m: number; o: number }>(
        `select (select count(*)::int from conversations where tenant_id = t.id) c, (select count(*)::int from messages where tenant_id = t.id) m,
                (select count(*)::int from orders where tenant_id = t.id) o from tenants t where t.slug = 'xfer'`,
      );
      return `${r!.c}/${r!.m}/${r!.o}`;
    };
    /** 真的 server.ts 以 db 存储起在 xfer 租户上，等到监听；返回进程、输出与退出 */
    const startXferServer = async () => {
      const p = await portOf();
      const proc = spawn(process.execPath, ['--import', 'tsx', serverTs], {
        cwd: repo,
        env: { ...serverEnv(xv, p), DEFAULT_TENANT_SLUG: 'xfer' },
      });
      let out = '';
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
      const exit = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      cleanup.push(() => proc.kill('SIGKILL'));
      for (let i = 0; i < 300 && !out.includes('[server] 已启动') && proc.exitCode === null; i++) await sleep(100);
      const hz = out.includes('[server] 已启动')
        ? ((await (await fetch(`http://127.0.0.1:${p}/healthz`)).json().catch(() => ({}))) as { store?: { mode?: string } })
        : {};
      const stop = async (): Promise<number | null | 'timeout'> => {
        proc.kill('SIGTERM');
        return Promise.race([exit, sleep(15_000).then(() => 'timeout' as const)]);
      };
      return { out: () => out, mode: hz.store?.mode, stop };
    };

    const xDry = imp('--dry-run');
    check(
      '真实 PG：import-sessions --dry-run 退出码 0，只打印条数与往返结果，库不动',
      xDry.status === 0 &&
        xDry.out.includes('dry-run：会写入 3 个真实会话、11 条消息、3 张订单') &&
        (await xCounts()) === '0/0/0' &&
        !fs.existsSync(marker),
      xDry.out.slice(-400),
    );
    const xImported = imp();
    check(
      '真实 PG：import-sessions 首次导入退出码 0，打印会话、消息、订单与规范化条数，写了标记文件（验收 3）',
      xImported.status === 0 &&
        xImported.out.includes('已导入 3 个真实会话、11 条消息、3 张订单') &&
        xImported.out.includes(`被规范化的字符串 ${fx6.normalized} 条`) &&
        (await xCounts()) === '3/11/3' &&
        fs.existsSync(marker),
      `${xImported.out.slice(-400)} ${await xCounts()}`,
    );
    const xAgain = imp();
    check('真实 PG：再导入一次退出码 0', xAgain.status === 0 && xAgain.out.includes('已经导入过'), xAgain.out.slice(-300));
    const s1 = await startXferServer();
    check('真实 PG：导入之后 server.ts 以 db 存储启动，/healthz 报 db', s1.mode === 'db', s1.out().slice(-500));
    const held = imp();
    const heldExp = exp();
    check(
      '真实 PG：应用持锁时 import-sessions、export-sessions 都以 3 退出，库与文件不动',
      held.status === 3 &&
        held.out.includes('lock_held') &&
        heldExp.status === 3 &&
        fs.existsSync(marker) &&
        (await xCounts()) === '3/11/3',
      `${held.status} ${heldExp.status} ${held.out.slice(-200)}`,
    );
    check('真实 PG：server.ts 收到 SIGTERM 优雅退出（143）', (await s1.stop()) === 143);
    const e1 = exp();
    const exported = JSON.parse(fs.readFileSync(path.join(xv, 'sessions.json'), 'utf8')) as Session[];
    check(
      '真实 PG：应用停了之后 export-sessions 退出码 0，删掉标记文件，真实会话回到 JSON',
      e1.status === 0 && !fs.existsSync(marker) && fx6.real.every((id) => exported.some((s) => s.id === id)),
      e1.out.slice(-300),
    );
    // 文件存储下改了一条消息（库里的窗口不再是文件窗口的前缀）：不带 --resync 是 2，带上是 0、窗口推进、整段追加
    exported.find((s) => s.id === XFER.beta)!.messages[1]!.content = '改过的';
    fs.writeFileSync(path.join(xv, 'sessions.json'), JSON.stringify(exported, null, 2));
    const diff = imp();
    check(
      '真实 PG：JSON 与库里不一致时 import-sessions 退出码 2，点名短码、提示 --resync，库不动',
      diff.status === 2 &&
        diff.out.includes('TA02') &&
        diff.out.includes('--resync') &&
        (await xCounts()) === '3/11/3' &&
        !fs.existsSync(marker),
      diff.out.slice(-300),
    );
    const rs = imp('--resync');
    const [beta] = await fxr.query<{ last_seq: number; window_start_seq: number }>(
      `select last_seq, window_start_seq from conversations where id = $1 and tenant_id = (select id from tenants where slug = 'xfer')`,
      [XFER.beta],
    );
    check(
      '真实 PG：import-sessions --resync 退出码 0，接不上的窗口推到 last_seq + 1、整段追加（历史不丢），写回标记文件',
      rs.status === 0 && beta?.window_start_seq === 7 && beta.last_seq === 12 && (await xCounts()) === '3/17/3' && fs.existsSync(marker),
      `${rs.out.slice(-300)} ${JSON.stringify(beta)} ${await xCounts()}`,
    );
    const s2 = await startXferServer();
    check('真实 PG：--resync 之后 server.ts 以 db 存储启动', s2.mode === 'db', s2.out().slice(-500));
    check('真实 PG：第二次启动的 server.ts 收到 SIGTERM 优雅退出（143）', (await s2.stop()) === 143);
  } finally {
    for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => {});
    await fxr.drop();
  }
}
