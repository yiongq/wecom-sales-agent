// 两种会话存储的等价套件（docs/architecture/02-conversations-workbench/spec.md「测试与 CI」「消息只追加」，验收 2、7；plan 第 7 步）。
// 同一组场景分别跑在文件存储与 PG 存储上，比较每一轮的回复、发给企微的消息、会话投影与订单，并断言 PG 里确实有这些会话、
// 库里的消息与内存一致。比较之前只做两件事：时间戳的取值换成占位（键照留），随机的订单号按出现顺序换成编号；别的字段原样比。
// 场景：E5 生成中接手；模型返回之后、推送之前接手（strandedReply 的 await 里）；生成中付款；重置；裁剪（引擎与企微适配器两处）；
// 企微重放（已记下没回复、已回复没发出、后面夹了欢迎语）；跟进（文件存储的扫描器，与 PG 存储下先等记账提交再推送）；
// 转人工各入口（安全网三类、模型调工具、改行程承诺、回复说了转接、旧 /handoff）。
// store 是进程级单例，一个进程只能装一种后端：本文件带上 PARITY_CHILD 再起两次自己（单进程 node --import tsx，spawnSync 带
// SIGKILL 超时），两个子进程跑同一份场景脚本与假模型（输入逐字相同），各自把原始结果写进文件，由父进程规范化、比较。
// 两个子进程的配置源相同（PGlite 上 installSeededConfig），钟也相同（父进程定的基准时刻，见 parity-clock.ts），只差会话存储；
// 会话 id 一律是非 demo 类的 wecom:parity-*。
// 用法：npx tsx src/store/parity.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { ChatMessage, Session } from '../types.js';

type Mode = 'file' | 'db';

/** 一轮：回复（或抛出的错误）与这一轮没用完的脚本步数（多调、少调模型都看得出来） */
interface TurnOut {
  label: string;
  reply: unknown;
  leftover: number;
}
/** 一轮的 trace（第 9 步）：两种存储都收集，内容与存储无关，逐项比。turnId、时刻与耗时不比 */
interface TraceOut {
  sid: string;
  outcome: string;
  stageBefore: string | null;
  stageAfter: string | null;
  finalText: string;
  catalogVersions: Record<string, number>;
  guards: { guard: string; action: string; removed: string[]; added: string[] }[];
  calls: { name: string; prefetch: boolean }[];
  /** 每次模型调用的失败类别（成功为 null） */
  llm: (string | null)[];
}
interface ScenarioOut {
  name: string;
  ids: string[];
  turns: TurnOut[];
  /** 这个场景里经假企微接口发出去的消息 */
  sent: { to: string; content: string }[];
  /** 场景结束时每个会话经 normalizeForStore 的投影（内存里的） */
  sessions: Record<string, unknown>;
  orders: unknown[];
  notes: Record<string, unknown>;
  /** 这个场景里结束的每一轮的 trace（onTurnEnd 收到的，按结束顺序） */
  traces: TraceOut[];
  error: string | null;
}
interface CheckOut {
  scenario: string;
  name: string;
  ok: boolean;
  detail: string;
}
interface ChildOut {
  mode: Mode;
  scenarios: ScenarioOut[];
  checks: CheckOut[];
  log: string[];
  fatal: string | null;
}

/**
 * 场景之后的核对项（子进程 verify 产出），父进程按每组场景的 ids 逐个会话要求它们都在、都通过：verify 跳过哪一组、哪个会话，
 * 父进程都会少项（各项本身过没过另外逐条报）。放在子进程入口之前：子进程在模块求值到这里之前就开跑
 */
const DB_SESSION_CHECK = {
  present: '库里有这个会话',
  rebuilt: '库里按预载那条路重建的会话与内存相同',
  seqs: '库里的消息 seq 从 1 起连续，条数等于 last_seq',
  window: '内存里每条消息的 seq 与库里的窗口对得上',
  orders: '库里未作废的订单与内存相同',
  frozen: '内存里的消息都已冻结（原地修改会抛 TypeError）',
  traces: '库里有这个会话每一轮的 trace（id、outcome 与护栏事件条数与内存相同）',
  turnIds: '库里窗口内消息的 turn_id 与内存的关联相同，每条回复都关联到它那一轮',
  outbound: '库里的发送账本行与内存的账本相同（msgid、kind、status、对应消息的 seq；第 12 步）',
};
const DB_SCENARIO_CHECK = {
  drained: '排空写队列之后库里不欠改动',
  healthy: '库里：没有 poisoned 的会话、没有撞上另一写者',
  identity: '库里：saveSession 没收到过副本（identity map 唯一）',
};
const FILE_SESSION_CHECK = '文件存储下消息不冻结';
/** 经企微适配器走的那几轮，标签里用这个箭头（父进程据此要求处理链排空） */
const WECOM_TURN = ' ⇐ ';

const CHILD = process.env.PARITY_CHILD;
if (CHILD === 'file' || CHILD === 'db') await childMain(CHILD);

// ======================================================================================
// 父进程：起两个子进程，规范化、比较
// ======================================================================================

const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(varParent, 'wecom-parity-selftest-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * 两个子进程共用的基准时刻：当天本地 12:00。子进程预加载 parity-clock.ts，从这个时刻起走（各自现取「今天」的话，先后跑的两个子进程
 * 跨过本地零点就会报假差异）；正午离两头都远，也让套件不受在几点跑的影响
 */
const CLOCK_MS = new Date().setHours(12, 0, 0, 0);
const CLOCK_MODULE = fileURLToPath(new URL('./parity-clock.ts', import.meta.url));

function runChild(mode: Mode): ChildOut | null {
  const varDir = fs.mkdtempSync(path.join(ROOT, `${mode}-`));
  const result = path.join(ROOT, `${mode}.json`);
  // 单进程：node 自己带 tsx 加载器；超时用 SIGKILL，不留孤儿
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', CLOCK_MODULE, fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PARITY_CHILD: mode,
      PARITY_RESULT: result,
      PARITY_CLOCK_MS: String(CLOCK_MS),
      VAR_DIR: varDir,
      CONFIG_SOURCE: 'file',
    },
    timeout: 240_000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  const ok = r.status === 0 && fs.existsSync(result);
  check(`${mode} 子进程正常结束`, ok, `status=${r.status} signal=${r.signal} ${(r.stderr ?? '').slice(-1500)}`);
  if (!fs.existsSync(result)) return null;
  const out = JSON.parse(fs.readFileSync(result, 'utf8')) as ChildOut;
  check(`${mode} 子进程没有中途抛错`, out.fatal === null, `${out.fatal ?? ''}\n${out.log.slice(-60).join('\n')}`);
  return out;
}

/** 时间戳：取值是毫秒数的这些键换成占位，键本身留着（不删字段）。seq 不在内存的投影里（WeakMap），无需处理 */
const TIME_KEYS = new Set(['at', 'createdAt', 'updatedAt', 'paidAt', 'sentAt', 'lastAt', 'pendingAt', 'firstHandoffAt', 'confirmedAt']);
const ORDER_ID = /ord_[0-9a-f]{24}/g;

/** 规范化：时间戳换成「<t>」，订单号按在这个场景输出里第一次出现的顺序换成「ord#1」「ord#2」…（两边建单的先后相同） */
function canon(x: unknown, ids = new Map<string, string>()): unknown {
  if (typeof x === 'string') {
    return x.replace(ORDER_ID, (id) => {
      if (!ids.has(id)) ids.set(id, `ord#${ids.size + 1}`);
      return ids.get(id)!;
    });
  }
  if (Array.isArray(x)) return x.map((v) => canon(v, ids));
  if (x !== null && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, TIME_KEYS.has(k) && typeof v === 'number' ? '<t>' : canon(v, ids)]));
  }
  return x;
}
/** 逐项比的几样：每一轮的回复、发出的消息、会话投影、订单、场景记下的观测 */
const COMPARED = ['turns', 'sent', 'sessions', 'orders', 'notes', 'traces'] as const;
type Compared = Pick<ScenarioOut, (typeof COMPARED)[number]>;
/**
 * 两边一个场景的比较（真比较与下面「比较器对每个字段都敏感」的探测走的是同一个函数）：规范化之后逐项 deepStrictEqual，
 * 订单号的编号在整个场景里共用一套。返回不同的那几项与第一处不同的路径
 */
function compareScenario(f: Compared, d: Compared): { key: string; diff: string }[] {
  const cf = canon(Object.fromEntries(COMPARED.map((k) => [k, f[k]]))) as Record<string, unknown>;
  const cd = canon(Object.fromEntries(COMPARED.map((k) => [k, d[k]]))) as Record<string, unknown>;
  return COMPARED.filter((k) => !isDeepStrictEqual(cf[k], cd[k])).map((k) => ({ key: k, diff: firstDiff(cf[k], cd[k], k) ?? '' }));
}

/** 第一处不同的路径（给失败信息用，不打整段原文） */
function firstDiff(a: unknown, b: unknown, at = '$', names: [string, string] = ['文件', 'PG']): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    for (const k of new Set([...ka, ...kb])) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`, names);
      if (d) return d;
    }
  }
  const brief = (v: unknown): string => (JSON.stringify(v) ?? 'undefined').slice(0, 160);
  return `${at}：${names[0]} ${brief(a)} ≠ ${names[1]} ${brief(b)}`;
}

/**
 * 场景合起来会碰到的字段：两边收集到的结果里都得有。比较器只探得到收集到了的字段，收集时就少收的（投影里漏了 stage、订单漏了金额）
 * 要靠这一条拦
 */
const MUST_SEE: Record<'session' | 'message' | 'order' | 'reply' | 'trace', string[]> = {
  session: [
    'id',
    'channel',
    'stage',
    'profile',
    'messages',
    'orderIds',
    'handedOver',
    'createdAt',
    'updatedAt',
    'handoff',
    'firstHandoffAt',
    'handoffCount',
    'assignee',
    'stageBeforeHandoff',
    'lastQuote',
    'quoteHistory',
    'seenRouteIds',
    'followup',
    'lastShownRoutes',
  ],
  message: ['role', 'content', 'at', 'msgid', 'sentAt'],
  order: [
    'id',
    'sessionId',
    'routeId',
    'routeTitle',
    'travelers',
    'departDate',
    'totalPrice',
    'status',
    'createdAt',
    'paidAt',
    'handoffBeforePaid',
  ],
  reply: ['text', 'stage', 'handoff', 'orderId', 'silent', 'idle'],
  trace: ['sid', 'outcome', 'stageBefore', 'stageAfter', 'finalText', 'catalogVersions', 'guards', 'calls', 'llm'],
};
function keysSeen(out: ChildOut): Record<keyof typeof MUST_SEE, Set<string>> {
  const seen = {
    session: new Set<string>(),
    message: new Set<string>(),
    order: new Set<string>(),
    reply: new Set<string>(),
    trace: new Set<string>(),
  };
  const add = (set: Set<string>, o: unknown) => {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) set.add(k);
  };
  for (const sc of out.scenarios) {
    for (const s of Object.values(sc.sessions) as (Session | null)[]) {
      add(seen.session, s);
      for (const m of s?.messages ?? []) add(seen.message, m);
    }
    for (const o of sc.orders) add(seen.order, o);
    for (const t of sc.turns) add(seen.reply, t.reply);
    for (const t of sc.traces) add(seen.trace, t);
  }
  return seen;
}

/**
 * 场景本身的期望（两边各验一遍）。等价只说明两边一样：场景悄悄失效（接手没发生、付款没落在生成途中、重放又记了一遍、跟进没发出去）
 * 时两边照样一样，这几条钉住每组场景真的走到了它要测的那条路
 */
function anchors(out: ChildOut): [string, boolean, string][] {
  type S = Session & { followup?: { count?: number; stages?: string[]; failures?: number } };
  const sc = (name: string): ScenarioOut | undefined => out.scenarios.find((x) => x.name === name);
  const ses = (name: string, id: string): S | null => (sc(name)?.sessions[id] ?? null) as S | null;
  const said = (s: S | null, role: string): string[] => (s?.messages ?? []).filter((m) => m.role === role).map((m) => m.content);
  const res: [string, boolean, string][] = [];
  const add = (name: string, ok: boolean, detail: unknown): void => void res.push([name, ok, (JSON.stringify(detail) ?? '').slice(0, 300)]);

  const e5 = sc('E5 生成中接手');
  const e5s = ses('E5 生成中接手', 'wecom:parity-e5');
  add(
    'E5：旧 /handoff 在生成途中接手成功，AI 这条没发出，记了一条「未发送」',
    e5?.notes.takeover === 200 &&
      e5.notes.aiReplySent === false &&
      !!e5s?.handedOver &&
      said(e5s, 'system').some((c) => c.includes('未发送')),
    e5?.notes,
  );
  const af = sc('模型返回后推送前接手');
  const afs = ses('模型返回后推送前接手', 'wecom:parity-after');
  add(
    '模型返回后推送前接手：接手恰好发生一次、发生在 strandedReply 的 create_quote 里；今天的机制下 AI 回复照样发出（第 13 步改成不发）',
    af?.notes.takeovers === 1 &&
      af.notes.armedLeft === false &&
      afs?.handoff?.kind === 'agent' &&
      af.sent.some((x) => x.content.startsWith('按 4 位给您报好了')),
    { notes: af?.notes, handoff: afs?.handoff },
  );
  const pd = sc('生成中付款');
  const pds = ses('生成中付款', 'wecom:parity-paid');
  const stages = (pd?.turns ?? []).map((t) => (t.reply as { stage?: string } | null)?.stage);
  add(
    '生成中付款：付款落在第三轮生成途中，那一轮与之后都停在 paid，付款确认发出去了',
    pd?.notes.pay === 200 &&
      stages[2] === 'paid' &&
      stages[3] === 'paid' &&
      pds?.stage === 'paid' &&
      (pd.orders as { status?: string }[]).map((o) => o.status).join() === 'paid' &&
      pd.sent.some((x) => x.content.startsWith('已收到您的支付')),
    { stages, notes: pd?.notes },
  );
  const rs = ses('重置', 'wecom:parity-reset');
  add(
    '重置：内存只剩重置回复与之后的一问一答，订单移出，转人工解除，firstHandoffAt 与 handoffCount 不清',
    rs?.messages.length === 3 &&
      rs.messages[0]!.content.includes('重新开始') &&
      sc('重置')?.orders.length === 0 &&
      rs.handedOver === false &&
      rs.handoffCount === 1 &&
      typeof rs.firstHandoffAt === 'number',
    { n: rs?.messages.length, count: rs?.handoffCount },
  );
  add(
    '裁剪：引擎与企微适配器两处都裁到 300 条再追加一条',
    JSON.stringify(sc('裁剪')?.notes.lengths) === '[301,301]' &&
      said(ses('裁剪', 'wecom:parity-trim-img'), 'customer').at(-1) === '[图片]' &&
      said(ses('裁剪', 'wecom:parity-trim'), 'customer').at(-1) === '想去云南看看',
    sc('裁剪')?.notes,
  );
  const rp = sc('企微重放');
  const rpIds = ['wecom:parity-rp-recorded', 'wecom:parity-rp-generated', 'wecom:parity-rp-welcome'];
  add(
    '企微重放：三个会话里客户这句都只记一次，各发出一条；已回复没发出的原样重发',
    rpIds.every((id) => said(ses('企微重放', id), 'customer').length === 1) &&
      rp?.sent.length === 3 &&
      new Set(rp.sent.map((x) => x.to)).size === 3 &&
      rp.sent.some((x) => x.to === 'parity-rp-generated' && x.content === '您好～想去哪儿玩呢？'),
    rp?.sent,
  );
  const fu = sc('跟进');
  const ok = ses('跟进', 'wecom:parity-fu-ok');
  const bad = ses('跟进', 'wecom:parity-fu-fail');
  const pushes = (fu?.notes.pushes ?? []) as { id: string; text: string; durableAtPush: { count?: number; pending?: boolean } | null }[];
  add(
    '跟进：第一轮推两条（一条送达、一条没送达），第二轮只重试没送达的；推送那一刻持久副本里已记账；送达的写进会话，没送达的退账、失败计 2 次',
    fu?.notes.round1 === 1 &&
      fu.notes.round2 === 0 &&
      pushes.length === 3 &&
      pushes.every((x) => x.durableAtPush?.pending === true && (x.durableAtPush.count ?? 0) >= 1) &&
      ok?.followup?.count === 1 &&
      said(ok, 'agent').at(-1) === pushes[0]?.text &&
      bad?.followup?.failures === 2 &&
      !bad.followup.count,
    { notes: fu?.notes, ok: ok?.followup, bad: bad?.followup },
  );
  const ho = (k: string) => ses('转人工各入口', `wecom:parity-ho-${k}`);
  const kinds = ['request', 'complaint', 'refund', 'model', 'promise', 'claimed'].map((k) => ho(k)?.handoff?.kind ?? null);
  add(
    '转人工各入口：六类入口各自的类型，之后客户再说话静默',
    kinds.join() === 'request,complaint,refund,model,promise,claimed' &&
      ['request', 'complaint', 'refund', 'model', 'promise', 'claimed'].every((k) => ho(k)?.handedOver === true) &&
      (sc('转人工各入口')?.turns ?? [])
        .filter((t) => t.label.endsWith('在吗'))
        .every((t) => (t.reply as { silent?: boolean }).silent === true),
    kinds,
  );
  const hm = ho('model');
  add(
    '模型调 handoff_to_human：客户原话带出行时间，转人工记录里有 departNote',
    hm?.handoff?.departNote?.includes('10月12号') === true,
    hm?.handoff,
  );
  add(
    '模型调 handoff_to_human：「AI 已转人工」那条 system 消息里含出行时间（一次写成，第 1 步第 4 处写入点）',
    said(hm, 'system').some((c) => c.startsWith('AI 已转人工：') && c.includes('客户原话里的出行时间：「我们10月12号出发')),
    said(hm, 'system'),
  );
  const lg = sc('转人工各入口');
  const lgs = ho('legacy');
  add(
    '旧 /handoff：两次都 200、只进一次转人工；人工回复经企微发出；交还之后 AI 照常接待',
    JSON.stringify(lg?.notes.legacy) === '[200,200]' &&
      lg?.notes.legacyReply === 200 &&
      lg.notes.legacyResume === 200 &&
      lgs?.handedOver === false &&
      lgs.handoffCount === 1 &&
      // 人工回复在企微客户侧以「【顾问】」开头（第 12 步，不变量 18）
      lg.sent.some((x) => x.to === 'parity-ho-legacy' && x.content.startsWith('【顾问】顾问回复')) &&
      said(lgs, 'agent').at(-1)?.startsWith('云南这边') === true,
    lg?.notes,
  );
  // 第 9 步：trace 的比较不是空比——有护栏改了文本的轮次，也有确定性路径、沉默与转人工的轮次
  const traces = out.scenarios.flatMap((x) => x.traces);
  const outcomes = new Set(traces.map((x) => x.outcome));
  add(
    'trace：每一轮都收集到了，其中有护栏事件、有工具调用，outcome 有 replied、handoff、silent、reset',
    traces.length >= 20 &&
      traces.some((x) => x.guards.length > 0) &&
      traces.some((x) => x.calls.length > 0) &&
      ['replied', 'handoff', 'silent', 'reset'].every((o) => outcomes.has(o)),
    { n: traces.length, outcomes: [...outcomes], guards: traces.flatMap((x) => x.guards.map((g) => g.guard)) },
  );
  return res;
}

const probes = { fields: 0, time: 0 };
const outs = { file: runChild('file'), db: runChild('db') };
const file = outs.file;
const db = outs.db;
if (file && db) {
  check(
    '两边跑的是同一组场景',
    isDeepStrictEqual(
      file.scenarios.map((s) => s.name),
      db.scenarios.map((s) => s.name),
    ) && file.scenarios.length >= 8,
    JSON.stringify({ file: file.scenarios.map((s) => s.name), db: db.scenarios.map((s) => s.name) }),
  );
  for (const [i, f] of file.scenarios.entries()) {
    const d = db.scenarios[i];
    if (!d) continue;
    check(`${f.name}：两边都没有抛错`, f.error === null && d.error === null, `文件：${f.error ?? '无'}；PG：${d.error ?? '无'}`);
    const errTurns = [...f.turns, ...d.turns].filter((t) => t.reply && typeof t.reply === 'object' && 'error' in t.reply);
    check(
      `${f.name}：每一轮都没有抛错（PG 存储下原地改已冻结的消息会抛 TypeError）`,
      !errTurns.length,
      JSON.stringify(errTurns.map((t) => [t.label, t.reply])),
    );
    const diffs = compareScenario(f, d);
    for (const k of COMPARED) {
      const hit = diffs.find((x) => x.key === k);
      check(`${f.name}：${k} 两边相同`, !hit, hit?.diff ?? '');
    }
  }
  for (const c of [...file.checks, ...db.checks]) check(`${c.scenario}：${c.name}`, c.ok, c.detail);
  // 场景之后的核对确实逐组、逐个会话做了且通过。重置、裁剪两组 PG 那边另有专项核对（每个会话都要有），按名字确认
  const DB_EXTRA_CHECK: Record<string, string[]> = {
    重置: ['库里重置之前的消息都还在（窗口之前还有消息）', '窗口起点推进到重置回复那一条', '订单在库里记作废（void_reason=reset），不删'],
    裁剪: ['库里 402 条全留着，窗口起点推进到第 102 条', '内存照旧只留 301 条'],
  };
  const passed = (out: ChildOut, scenario: string, name: string): boolean =>
    out.checks.some((c) => c.scenario === scenario && c.name === name && c.ok);
  for (const s of db.scenarios) {
    const missing = Object.values(DB_SCENARIO_CHECK).filter((n) => !passed(db, s.name, n));
    check(`${s.name}：PG 子进程做了这组的库里核对`, !missing.length, `少了或没过：${missing.join('；')}`);
    for (const id of s.ids) {
      const want = [...Object.values(DB_SESSION_CHECK), ...(DB_EXTRA_CHECK[s.name] ?? [])].map((n) => `${id}：${n}`);
      const lack = want.filter((n) => !passed(db, s.name, n));
      check(`${s.name}：PG 子进程逐项核对了 ${id} 在库里`, !lack.length, `少了或没过：${lack.join('；')}`);
    }
  }
  for (const s of file.scenarios) {
    for (const id of s.ids) check(`${s.name}：文件子进程核对了 ${id}`, passed(file, s.name, `${id}：${FILE_SESSION_CHECK}`));
  }
  // 模型脚本逐轮恰好用完（少调模型就剩步数；跟进那组记在 notes 的 leftover*），经企微的每一轮处理链都排空了；多调由子进程的
  // overrun 管。现在没有哪一轮该剩步数，以后真有，在场景里给那一轮标出期望值
  for (const out of [file, db]) {
    for (const s of out.scenarios) {
      const left = [
        ...s.turns.map((t) => [t.label, t.leftover] as const),
        ...Object.entries(s.notes).filter(([k]) => k.startsWith('leftover')),
      ].filter(([, n]) => n !== 0);
      check(`${out.mode} · ${s.name}：每一轮的模型脚本都恰好用完（没有少调模型）`, !left.length, JSON.stringify(left));
      const viaWecom = s.turns.filter((t) => t.label.includes(WECOM_TURN));
      const stuck = viaWecom.filter((t) => (t.reply as { idle?: unknown } | null)?.idle !== true).map((t) => t.label);
      if (viaWecom.length) check(`${out.mode} · ${s.name}：经企微的每一轮处理链都排空了`, !stuck.length, stuck.join('；'));
    }
  }
  for (const out of [file, db]) {
    const seen = keysSeen(out);
    for (const [kind, keys] of Object.entries(MUST_SEE) as [keyof typeof MUST_SEE, string[]][]) {
      const missing = keys.filter((k) => !seen[kind].has(k));
      check(`${out.mode} 收集到的${kind}字段是全的`, !missing.length, `少了 ${missing.join('、')}`);
    }
  }
  for (const out of [file, db]) for (const [n, ok, detail] of anchors(out)) check(`${out.mode} · ${n}`, ok, detail);

  // 比较器对每一个字段都敏感（防止为了比得上多去掉字段）：在文件那一份的原始结果上，每一种字段形状改一处，规范化之后必须与 PG 那份不同；
  // 时间戳的取值改了必须仍然相同（只有它们被抹掉）。每一处是一项断言
  for (const [i, f] of file.scenarios.entries()) {
    const d = db.scenarios[i];
    if (!d || compareScenario(f, d).length) continue;
    // 探的是子进程收集到的全部几样（不按 COMPARED 取）：逐项比漏了哪一样，那一样的字段就探不出差异
    const raw = { turns: f.turns, sent: f.sent, sessions: f.sessions, orders: f.orders, notes: f.notes, traces: f.traces };
    for (const { path: p, time } of leafShapes(raw)) {
      const perturbed = structuredClone(raw);
      perturb(perturbed, p);
      const same = compareScenario(perturbed as unknown as Compared, d).length === 0;
      if (time) {
        probes.time += 1;
        check(`比较器：${f.name} 的 ${p.join('.')} 是时间戳，改了照样相同`, same);
      } else {
        probes.fields += 1;
        check(`比较器：${f.name} 的 ${p.join('.')} 改了比得出来`, !same);
      }
    }
  }
  check('比较器：探过的字段形状够多', probes.fields > 200 && probes.time > 20, JSON.stringify(probes));
}

if (fails.length) {
  console.error(`\n✗ 等价套件 ${fails.length} 项失败（通过 ${pass} 项）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `SELFTEST PASS: 两种会话存储等价（${file?.scenarios.length ?? 0} 组场景、${pass} 项：回复、发出的消息、会话投影、订单逐项相同，` +
    `PG 里有这些会话且与内存一致；比较器探了 ${probes.fields} 种字段形状都比得出来、${probes.time} 处时间戳被抹掉）`,
);
process.exit(0);

/**
 * 这处取值看起来是毫秒时间戳（2001 年到 2286 年之间的毫秒数）。按取值判断、不看 TIME_KEYS：TIME_KEYS 多收一个键（比如把人数当时间戳抹掉），
 * 探测要能发现，不能用同一张表给自己作证
 */
function looksLikeEpochMs(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1e12 && v < 1e13;
}

/** 每一种字段形状（数组下标记成同一个）的第一处叶子；空数组、空对象也算叶子。time：这处是时间戳的取值 */
function leafShapes(x: unknown): { path: (string | number)[]; time: boolean }[] {
  const seen = new Set<string>();
  const out: { path: (string | number)[]; time: boolean }[] = [];
  const walk = (v: unknown, p: (string | number)[]): void => {
    const isObj = v !== null && typeof v === 'object';
    const empty = isObj && Object.keys(v).length === 0;
    if (!isObj || empty) {
      const shape = p.map((s) => (typeof s === 'number' ? '*' : s)).join('.');
      if (seen.has(shape)) return;
      seen.add(shape);
      out.push({ path: p, time: looksLikeEpochMs(v) });
      return;
    }
    if (Array.isArray(v)) v.forEach((c, i) => walk(c, [...p, i]));
    else for (const [k, c] of Object.entries(v)) walk(c, [...p, k]);
  };
  walk(x, []);
  return out;
}

function perturb(root: Record<string, unknown>, p: (string | number)[]): void {
  let o = root as Record<string | number, unknown>;
  for (const k of p.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  const k = p.at(-1)!;
  const v = o[k];
  if (typeof v === 'number') o[k] = v + 1;
  else if (typeof v === 'string') o[k] = `${v}·改`;
  else if (typeof v === 'boolean') o[k] = !v;
  else if (v === null || v === undefined) o[k] = '改';
  else if (Array.isArray(v)) v.push('改');
  else (v as Record<string, unknown>).改 = 1;
}

// ======================================================================================
// 子进程：装好存储，跑场景，写结果
// ======================================================================================

async function childMain(mode: Mode): Promise<never> {
  const out: ChildOut = { mode, scenarios: [], checks: [], log: [], fatal: null };
  // 业务日志先收着：全过就不刷屏，父进程在失败时倒出最后几十行
  for (const k of ['log', 'warn', 'error'] as const) {
    console[k] = (...args: unknown[]) => {
      out.log.push(
        args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      );
    };
  }
  try {
    await runScenarios(mode, out);
  } catch (e) {
    out.fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
  }
  fs.writeFileSync(process.env.PARITY_RESULT!, JSON.stringify(out));
  process.exit(0);
}

interface Step {
  content?: string | ((msgs: WireMsg[]) => string);
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  delayMs?: number;
}
interface WireMsg {
  role: string;
  content: string | null;
}
interface FakeMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text?: { content: string };
}

async function runScenarios(mode: Mode, out: ChildOut): Promise<void> {
  const VAR = process.env.VAR_DIR!;
  process.env.SERVER_SELFTEST = '1'; // 不 listen、不起企微轮询与跟进定时器
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASS = 'parity-pass';
  process.env.FOLLOWUP_ENABLED = '';
  // 企微的占位凭据：只为让 readConfig() 认为企微已配置，请求全部被下面的假 fetch 接住；不配公网地址，不走链接卡片
  process.env.WECOM_CORP_ID = 'parity-corp';
  process.env.WECOM_APP_SECRET = 'parity-secret';
  process.env.WECOM_KF_OPEN_KFID = 'parity-kf';
  process.env.PUBLIC_BASE_URL = '';

  // ---------------- 假模型：按脚本回话（可拖延），请求一到就通知等着的场景 ----------------
  const script: Step[] = [];
  /** 脚本空了还来的请求：引擎多调了模型（每轮的 leftover 只看得出少调） */
  let overrun = 0;
  const arrivals: (() => void)[] = [];
  const nextChat = (): Promise<void> => new Promise((r) => arrivals.push(r));
  const fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[]; messages?: WireMsg[] };
      if (req.url?.endsWith('/embeddings')) {
        res.end(JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 0 } }));
        return;
      }
      const step = script.shift();
      if (!step) overrun += 1;
      for (const wake of arrivals.splice(0)) wake();
      const message = step?.toolCalls
        ? {
            role: 'assistant',
            content: null,
            tool_calls: step.toolCalls.map((c, i) => ({
              id: `call_${i}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : {
            role: 'assistant',
            content: typeof step?.content === 'function' ? step.content(body.messages ?? []) : (step?.content ?? '（假模型脚本已耗尽）'),
          };
      setTimeout(() => {
        res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }, step?.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fake.unref();
  const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.LLM_MOCK = '0';
  process.env.LLM_PROVIDER = '';
  process.env.LLM_BASE_URL = fakeUrl;
  process.env.LLM_API_KEY = 'parity-fake-key';
  process.env.LLM_MODEL = 'parity-fake';
  process.env.EMBED_BASE_URL = fakeUrl;
  process.env.EMBED_API_KEY = 'parity-fake-key';
  process.env.LLM_HEDGE_MODEL = '';
  process.env.LLM_MAX_RETRY = '0';

  // ---------------- 假企微服务端：sync_msg 按 cursor 返回日志里之后的消息，send_msg 记下发了什么；别的请求照常发 ----------------
  const serverLog: FakeMsg[] = [];
  const sent: { to: string; content: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'qyapi.weixin.qq.com') return realFetch(input, init);
    const ep = url.pathname.replace(/^\/cgi-bin\//, '');
    const res = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    if (ep === 'gettoken') return res({ errcode: 0, access_token: 'parity-token', expires_in: 7200 });
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, any>;
    if (ep === 'kf/sync_msg') {
      const from = Number(String(body.cursor ?? '').split(':')[1] ?? 0) || 0;
      const list = serverLog.slice(from);
      return res({ errcode: 0, next_cursor: `0:${from + list.length}`, has_more: 0, msg_list: list });
    }
    if (ep === 'kf/send_msg') {
      sent.push({ to: String(body.touser), content: String(body.text?.content ?? body.link?.url ?? '') });
      return res({ errcode: 0 });
    }
    if (ep === 'kf/customer/batchget') return res({ errcode: 0, customer_list: [] });
    return res({ errcode: 40001, errmsg: `parity: 未模拟的接口 ${ep}` });
  }) as typeof fetch;

  // ---------------- 存储：两边同一个配置源；PG 那边另装 PG 会话存储 ----------------
  const { openTestDb, installSeededConfig, installPgSessionStore, readStoredConversations } = await import('../db/testing.js');
  const t = await openTestDb();
  await installSeededConfig(t);
  const store = await import('../store.js');
  let tenantId = '';
  if (mode === 'db') {
    const fx = await installPgSessionStore(t, { varDir: VAR });
    await store.initSessionStore(fx.deps);
    tenantId = fx.deps.tenantId;
  }
  const ck = (scenario: string, name: string, ok: boolean, detail = ''): void => {
    out.checks.push({ scenario, name, ok, detail: ok ? '' : detail });
  };
  ck('装配', `会话存储是 ${mode}`, store.sessionStoreMode() === mode, store.sessionStoreMode());
  const clock = Number(process.env.PARITY_CLOCK_MS);
  const clockNow = [Date.now(), new Date().getTime()];
  ck(
    '装配',
    'Date.now() 与无参 new Date() 都从父进程给的基准时刻起走',
    clockNow.every((x) => x >= clock && x - clock < 60_000),
    `基准 ${clock}，现在 ${clockNow.join('、')}`,
  );

  const { handleMessage, onToolCall } = await import('../engine.js');
  const { onTurnEnd } = await import('../trace/recorder.js');
  const { __ledgerTest: ledgerTest } = await import('../quota/ledger.js');
  /** 这个进程里结束的每一轮（第 9 步的 trace）：场景收集 TraceOut，PG 那边拿 turnId 核对库里 */
  const turnLog: { sid: string; turnId: string; guards: number; t: TraceOut }[] = [];
  onTurnEnd((f) => {
    const t: TraceOut = {
      sid: f.turn.conversationId,
      outcome: f.outcome,
      stageBefore: f.stageBefore,
      stageAfter: f.stageAfter,
      finalText: f.finalText,
      catalogVersions: { ...f.turn.catalogVersions },
      guards: f.turn.guards.map((g) => ({ guard: g.guard, action: g.action, removed: [...g.removed], added: [...g.added] })),
      calls: f.turn.calls.map((c) => ({ name: c.name, prefetch: c.prefetch })),
      llm: f.turn.llm.map((c) => c.error),
    };
    turnLog.push({ sid: t.sid, turnId: f.turn.turnId, guards: f.turn.guards.length, t });
  });
  const { app } = await import('../server.js');
  const { __test: wecomTest, syncFromCallback } = await import('../adapters/wecom.js');
  const { runFollowUpScan } = await import('../followup.js');
  const jobs = await import('../jobs/runner.js');
  const { enterHandoff, HANDOFF_REASON } = await import('../handoff/record.js');
  const { normalizeForStore } = await import('./project.js');
  const { todayIso } = await import('../env.js');

  const today = todayIso();
  const y = Number(today.slice(0, 4));
  const next = (md: string): string => (`${y}-${md}` >= today ? `${y}-${md}` : `${y + 1}-${md}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await sleep(10);
    }
    return cond();
  }
  const idle = (): Promise<boolean> => waitFor(() => !wecomTest.inspectForTest().busy);
  const sess = (id: string): Session => {
    const s = store.getSession(id);
    if (!s) throw new Error(`没有会话 ${id}`);
    return s;
  };

  // ---------------- 后台的旧写接口（app.request，不占端口） ----------------
  const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:parity-pass').toString('base64') };
  let ip = 0;
  const post = async (url: string, body?: unknown): Promise<number> => {
    ip += 1;
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...ADMIN, 'x-forwarded-for': `198.51.100.${(ip % 250) + 1}` };
    if (raw !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) });
    const res = await app.request(url, { method: 'POST', headers, body: raw });
    await res.text();
    return res.status;
  };
  const legacy = (id: string, op: 'handoff' | 'resume' | 'reply') =>
    post(`/api/sessions/${encodeURIComponent(id)}/${op}`, op === 'reply' ? { text: '顾问回复：给您核了一下，这个日期可以' } : undefined);
  /** 与旧 /api/sessions/:id/handoff 同一套写法（共享工作台接手），给只能同步插进引擎途中的那一处用 */
  const deskTakeover = (id: string): void => {
    const s = sess(id);
    if (s.handedOver) return;
    enterHandoff(s, { kind: 'agent', at: Date.now(), reason: HANDOFF_REASON.agent });
    s.updatedAt = Date.now();
    store.saveSession(s);
  };

  // ---------------- 「模型返回之后、推送之前」的接手：引擎在模型返回之后调的那次工具一到，排一个 microtask 接手 ----------------
  let armed: { sid: string; tool: string } | null = null;
  let takeovers = 0;
  onToolCall((name, _args, sid, meta) => {
    // 脚本已经用完（模型的最后一步已经返回）、不是预取：这是 strandedReply 等出口修补里的调用
    if (!armed || armed.sid !== sid || armed.tool !== name || meta?.prefetch || script.length) return;
    armed = null;
    takeovers += 1;
    queueMicrotask(() => deskTakeover(sid));
  });

  // ---------------- 场景框架 ----------------
  interface Ctx {
    out: ScenarioOut;
    note(k: string, v: unknown): void;
  }
  const takeLeftover = (): number => script.splice(0).length;
  async function say(o: Ctx, sid: string, text: string, steps: Step[], label = text): Promise<{ orderId?: string }> {
    script.push(...steps);
    let reply: unknown;
    try {
      reply = await handleMessage(sid, text, 'wecom');
    } catch (e) {
      reply = { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    o.out.turns.push({ label: `${sid} ← ${label}`, reply, leftover: takeLeftover() });
    return reply as { orderId?: string };
  }
  let msgSeq = 0;
  const customerMsg = (uid: string, content: string, msgtype = 'text'): FakeMsg => {
    msgSeq += 1;
    return {
      msgid: `parity-msg-${msgSeq}`,
      open_kfid: 'parity-kf',
      external_userid: uid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype,
      ...(msgtype === 'text' ? { text: { content } } : {}),
    };
  };
  /** 经企微适配器走一轮：假接口上客户发来一条，回调拉取、处理、发送，等处理链空了才返回 */
  async function wecomSay(o: Ctx, uid: string, text: string, steps: Step[], msgtype = 'text'): Promise<void> {
    script.push(...steps);
    serverLog.push(customerMsg(uid, text, msgtype));
    await syncFromCallback(`tok-${msgSeq}`);
    const done = await idle();
    o.out.turns.push({
      label: `wecom:${uid}${WECOM_TURN}${msgtype === 'text' ? text : `[${msgtype}]`}`,
      reply: { idle: done },
      leftover: takeLeftover(),
    });
  }
  /** 模拟进程重启（只清适配器内存，盘上的状态文件与 store 都留着） */
  const restart = (): Promise<void> => wecomTest.resetForTest();
  /** 把一条消息放进盘上的在途表：进程死在处理它的半路上，cursor 已越过它，只能靠启动重放 */
  function pendOnDisk(m: FakeMsg): void {
    const st = fs.existsSync(wecomTest.STATE_FILE)
      ? (JSON.parse(fs.readFileSync(wecomTest.STATE_FILE, 'utf8')) as { cursor?: string; handled?: [string, number][] })
      : {};
    fs.writeFileSync(
      wecomTest.STATE_FILE,
      JSON.stringify({ cursor: st.cursor, handled: [...(st.handled ?? []), [m.msgid, Date.now()]], pending: [{ msg: m, tries: 0 }] }),
    );
  }

  /** 以超级用户查库（一个事务里临时换回会话用户，排着的落库不会跟着变成超级用户） */
  const su = <R>(text: string, params: unknown[]): Promise<R[]> =>
    t.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE');
      return (await tx.query<R>(text, params)).rows;
    });
  /** 场景之后 PG 那边的库里核对（文件那边只核对消息没被冻结） */
  type DbExtra = (id: string, stored: Awaited<ReturnType<typeof readStoredConversations>>, mem: Session) => [string, boolean, string][];
  async function verify(name: string, ids: string[], extra?: DbExtra): Promise<void> {
    if (mode === 'file') {
      for (const id of ids) {
        const s = store.getSession(id);
        ck(name, `${id}：${FILE_SESSION_CHECK}`, !!s && !s.messages.some((m) => Object.isFrozen(m)));
      }
      return;
    }
    const { undrained } = await store.drainStore(10_000);
    ck(name, DB_SCENARIO_CHECK.drained, undrained.length === 0, undrained.join(','));
    const stored = await readStoredConversations(t, tenantId);
    for (const id of ids) {
      const mem = store.getSession(id);
      const got = stored.get(id);
      ck(name, `${id}：${DB_SESSION_CHECK.present}`, !!mem && !!got);
      if (!mem || !got) continue;
      const want = normalizeForStore(mem);
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.rebuilt}`,
        !!got.session && isDeepStrictEqual(got.session, want),
        got.session ? (firstDiff(want, got.session, '$', ['内存', '库里']) ?? '') : '窗口与 last_seq、window_start_seq 对不上',
      );
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.seqs}`,
        got.seqs.length === got.lastSeq && got.seqs.every((q, i) => q === i + 1),
        `${got.seqs.length} 条，last_seq=${got.lastSeq}`,
      );
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.window}`,
        mem.messages.every((m, i) => store.seqOf(m) === got.windowStartSeq + i) &&
          got.windowStartSeq === got.lastSeq - mem.messages.length + 1,
        `window_start_seq=${got.windowStartSeq} last_seq=${got.lastSeq} 内存 ${mem.messages.length} 条`,
      );
      const memOrders = store
        .listOrders()
        .filter((o) => o.sessionId === id)
        .map((o) => normalizeForStore(o))
        .toSorted((a, b) => a.id.localeCompare(b.id));
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.orders}`,
        isDeepStrictEqual(got.liveOrders, memOrders),
        firstDiff(memOrders, got.liveOrders, '$', ['内存', '库里']) ?? '',
      );
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.frozen}`,
        mem.messages.every((m) => Object.isFrozen(m)),
      );
      // 第 9 步：每一轮的 trace 随会话落库，AI 回复的 turn_id 与内存的 WeakMap 关联相同
      const dbTraces = await su<{ id: string; outcome: string; guards: number }>(
        `select t.id, t.outcome, (select count(*)::int from guard_events g where g.tenant_id = t.tenant_id and g.turn_id = t.id) as guards
           from turn_traces t where t.tenant_id = $1 and t.conversation_id = $2`,
        [tenantId, id],
      );
      const memTurns = turnLog.filter((x) => x.sid === id);
      const key = (l: { id: string; outcome: string; guards: number }[]) => JSON.stringify(l.toSorted((a, b) => a.id.localeCompare(b.id)));
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.traces}`,
        key(dbTraces) === key(memTurns.map((x) => ({ id: x.turnId, outcome: x.t.outcome, guards: x.guards }))),
        `库里 ${key(dbTraces)}，内存 ${memTurns.length} 轮`,
      );
      const dbTurnOf = new Map(
        (
          await su<{ seq: number; turn_id: string | null }>(
            'select seq, turn_id from messages where tenant_id = $1 and conversation_id = $2',
            [tenantId, id],
          )
        ).map((r) => [Number(r.seq), r.turn_id] as const),
      );
      const linked = new Set([...dbTurnOf.values()].filter((v): v is string => v !== null));
      const replied = memTurns.filter((x) => x.t.finalText !== '');
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.turnIds}`,
        mem.messages.every((m) => (dbTurnOf.get(store.seqOf(m) ?? -1) ?? null) === (store.turnIdOf(m) ?? null)) &&
          replied.every((x) => linked.has(x.turnId)) &&
          [...linked].every((v) => memTurns.some((x) => x.turnId === v)),
        `库里关联了 ${linked.size} 条，有回复的 ${replied.length} 轮`,
      );
      // 第 12 步：经企微适配器发出去的每个分段一行账，随会话落库；message_seq 是对应那条消息的 seq
      const dbSends = await su<{ m: string; kind: string; status: string; seq: number | null }>(
        'select channel_msgid as m, kind, status, message_seq as seq from outbound_sends where tenant_id = $1 and conversation_id = $2',
        [tenantId, id],
      );
      const memSends = ledgerTest
        .rows(id)
        .filter((r) => r.status !== 'pending')
        .map((r) => ({ m: r.msgid, kind: r.kind, status: r.status, seq: r.message ? (store.seqOf(r.message) ?? null) : null }));
      const sendKey = (l: { m: string; kind: string; status: string; seq: number | null }[]) =>
        JSON.stringify(l.map((r) => ({ ...r, seq: r.seq === null ? null : Number(r.seq) })).toSorted((a, b) => a.m.localeCompare(b.m)));
      ck(
        name,
        `${id}：${DB_SESSION_CHECK.outbound}`,
        sendKey(dbSends) === sendKey(memSends),
        `库里 ${sendKey(dbSends)}，内存 ${sendKey(memSends)}`,
      );
      for (const [n, ok, detail] of extra?.(id, stored, mem) ?? []) ck(name, `${id}：${n}`, ok, detail);
    }
    const h = store.storeHealth();
    ck(name, DB_SCENARIO_CHECK.healthy, !h.poisoned.length && !h.conflict, JSON.stringify(h));
    ck(name, DB_SCENARIO_CHECK.identity, store.__storeTest.pgStats()?.foreign === 0);
  }

  async function scenario(name: string, ids: string[], body: (o: Ctx) => Promise<void>, extra?: DbExtra): Promise<void> {
    const so: ScenarioOut = { name, ids, turns: [], sent: [], sessions: {}, orders: [], notes: {}, traces: [], error: null };
    const sentFrom = sent.length;
    const tracesFrom = turnLog.length;
    const o: Ctx = { out: so, note: (k, v) => void (so.notes[k] = v) };
    try {
      await body(o);
      await idle();
    } catch (e) {
      so.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      script.length = 0;
    }
    so.sent = sent.slice(sentFrom);
    so.traces = turnLog.slice(tracesFrom).map((x) => x.t);
    for (const id of ids) so.sessions[id] = store.getSession(id) ? normalizeForStore(store.getSession(id)) : null;
    // 订单号是随机的：按会话、创建先后与内容排（父进程再把订单号换成编号）
    so.orders = store
      .listOrders()
      .filter((x) => ids.includes(x.sessionId))
      .toSorted(
        (a, b) => ids.indexOf(a.sessionId) - ids.indexOf(b.sessionId) || a.createdAt - b.createdAt || a.routeId.localeCompare(b.routeId),
      )
      .map((x) => normalizeForStore(x));
    out.scenarios.push(so);
    await verify(name, ids, extra);
  }

  // 场景里共用的模型脚本
  const searchYunnan: Step[] = [
    { toolCalls: [{ name: 'search_routes', args: { destination: '云南' } }] },
    { content: '云南这边有丽江大理和香格里拉两条线，您几位出行？' },
  ];
  const shownQuote: Step[] = [
    { toolCalls: [{ name: 'create_quote', args: { routeId: 'r-yunnan-mid', travelers: 2 } }] },
    { content: '丽江大理这条每人 ¥16,800，2 位总价 ¥33,600。' },
  ];

  // ======== 1. E5：模型生成期间顾问在旧工作台接手，AI 这条不发、记一条 system ========
  await scenario('E5 生成中接手', ['wecom:parity-e5'], async (o) => {
    await wecomSay(o, 'parity-e5', '你好', [{ content: '您好～这次想去哪儿玩？' }]);
    const arrived = nextChat();
    const turn = wecomSay(o, 'parity-e5', '想去三亚', [{ delayMs: 400, content: '三亚这边给您推荐亚特兰蒂斯，亲子设施很全～' }]);
    await arrived;
    o.note('takeover', await legacy('wecom:parity-e5', 'handoff'));
    await turn;
    await wecomSay(o, 'parity-e5', '在吗', []);
    o.note(
      'aiReplySent',
      sent.some((x) => x.content.includes('亚特兰蒂斯')),
    );
  });

  // ======== 2. 模型返回之后、推送之前接手（strandedReply 的 await 里） ========
  // 第二句模型自己算的价被价格护栏删掉、只剩残句，strandedReply 按 4 位实报一次（runTool create_quote）：这次工具调用一到就接手。
  // 今天的机制只有 handedOver：AI 回复照样写进会话、照样发出（两边相同）。不发出要等第 13 步的接手代次（takeoverGen），届时在这里补断言
  await scenario('模型返回后推送前接手', ['wecom:parity-after'], async (o) => {
    const oct15 = next('10-15');
    await wecomSay(o, 'parity-after', '西安那个5天的 10月15号走 就俩大人', [
      { toolCalls: [{ name: 'create_quote', args: { routeId: 'r-xian', travelers: 2, departDate: oct15 } }] },
      { content: '西安兵马俑 5 日，10 月 15 日出发，每人 14,080 元，两位 28,160 元。' },
    ]);
    armed = { sid: 'wecom:parity-after', tool: 'create_quote' };
    await wecomSay(o, 'parity-after', '哦对了 我爸妈也要跟着去 一共4个人', [
      {
        content:
          '好嘞，4 位一起走更热闹～按 4 人重新报价（4 人及以上每人还能打 95 折）：\n\n西安 兵马俑·大唐不夜城 5 日\n10 月 15 日出发 · 4 位出行\n\n' +
          '· 每人 13384 元（12800 元基础上最佳季上浮 10%，再享 4 人 95 折）\n· 合计 53536 元\n\n报价为起价，按最终行程微调。',
      },
    ]);
    o.note('takeovers', takeovers);
    o.note('armedLeft', armed !== null);
    armed = null;
    await wecomSay(o, 'parity-after', '在吗', []);
  });

  // ======== 3. 生成中付款：阶段停在已付，之后客户再发消息仍是已付 ========
  await scenario('生成中付款', ['wecom:parity-paid'], async (o) => {
    const sid = 'wecom:parity-paid';
    await say(o, sid, '丽江大理两个人报个价', shownQuote);
    const r = await say(o, sid, '就订这个，12月10号出发', [{ content: '好的～' }]);
    if (!r.orderId) throw new Error('安全网没有建单');
    const arrived = nextChat();
    const turn = say(o, sid, '我先问问家里人', [{ delayMs: 400, content: '好的，有问题随时找我～' }]);
    await arrived;
    o.note('pay', await post(`/api/orders/${r.orderId}/pay`));
    await turn;
    await say(o, sid, '谢谢', [{ content: '不客气，祝您旅途愉快～' }]);
  });

  // ======== 4. 重置：内存清空、订单移出；库里旧消息都在、窗口推进到重置回复、订单作废 ========
  await scenario(
    '重置',
    ['wecom:parity-reset'],
    async (o) => {
      const sid = 'wecom:parity-reset';
      await say(o, sid, '想去云南看看', searchYunnan);
      await say(o, sid, '丽江大理两个人报个价', shownQuote);
      const r = await say(o, sid, '就订这个，12月10号出发', [{ content: '好的～' }]);
      if (!r.orderId) throw new Error('安全网没有建单');
      o.note('pay', await post(`/api/orders/${r.orderId}/pay`)); // 已付订单 demo 下也随重置移出（E6p）
      await say(o, sid, '我要投诉', []);
      await say(o, sid, '重置', []);
      await say(o, sid, '想去三亚', [{ content: '三亚有亲子线，您几位出行？' }]);
    },
    (_id, stored, mem) => {
      const got = stored.get('wecom:parity-reset')!;
      const resetSeq = got.windowStartSeq;
      return [
        [
          '库里重置之前的消息都还在（窗口之前还有消息）',
          got.lastSeq > mem.messages.length && got.seqs.length === got.lastSeq,
          `${got.lastSeq}`,
        ],
        ['窗口起点推进到重置回复那一条', mem.messages[0]?.content.includes('重新开始') === true && resetSeq > 1, String(resetSeq)],
        [
          '订单在库里记作废（void_reason=reset），不删',
          got.voided.length === 1 && got.voided[0]!.reason === 'reset',
          JSON.stringify(got.voided),
        ],
      ];
    },
  );

  // ======== 5. 裁剪：引擎（超过 400 条裁到 300）与企微适配器的非文本占位（同一道封顶） ========
  await scenario(
    '裁剪',
    ['wecom:parity-trim', 'wecom:parity-trim-img'],
    async (o) => {
      for (const sid of ['wecom:parity-trim', 'wecom:parity-trim-img']) {
        const s = store.getOrCreateSession(sid, 'wecom');
        for (let i = 0; i < 400; i++) s.messages.push({ role: i % 2 ? 'agent' : 'customer', content: `第${i + 1}句`, at: Date.now() });
        store.saveSession(s);
      }
      await say(o, 'wecom:parity-trim', '想去云南看看', searchYunnan);
      await wecomSay(o, 'parity-trim-img', '', [], 'image');
      o.note(
        'lengths',
        ['wecom:parity-trim', 'wecom:parity-trim-img'].map((id) => sess(id).messages.length),
      );
    },
    (id, stored, mem) => {
      const got = stored.get(id)!;
      return [
        [
          '库里 402 条全留着，窗口起点推进到第 102 条',
          got.lastSeq === 402 && got.seqs.length === 402 && got.windowStartSeq === 102,
          `${got.lastSeq}/${got.windowStartSeq}`,
        ],
        ['内存照旧只留 301 条', mem.messages.length === 301, String(mem.messages.length)],
      ];
    },
  );

  // ======== 6. 企微重放：已记下没回复 / 已回复没发出 / 后面夹了欢迎语 ========
  await scenario('企微重放', ['wecom:parity-rp-recorded', 'wecom:parity-rp-generated', 'wecom:parity-rp-welcome'], async (o) => {
    const recorded = async (uid: string, text: string, after: ChatMessage[], steps: Step[]) => {
      await restart();
      const m = customerMsg(uid, text);
      const s = store.getOrCreateSession(`wecom:${uid}`, 'wecom');
      s.messages.push({ role: 'customer', content: text, at: Date.now(), msgid: m.msgid, sentAt: m.send_time * 1000 }, ...after);
      store.saveSession(s);
      pendOnDisk(m);
      script.push(...steps);
      await syncFromCallback(`tok-rp-${msgSeq}`);
      const done = await idle();
      o.out.turns.push({ label: `wecom:${uid}${WECOM_TURN}重放「${text}」`, reply: { idle: done }, leftover: takeLeftover() });
    };
    await recorded('parity-rp-recorded', '你好，想看看', [], [{ content: '您好～这次想去哪儿玩？' }]);
    await recorded('parity-rp-generated', '你好，想去玩', [{ role: 'agent', content: '您好～想去哪儿玩呢？', at: Date.now() }], []);
    await recorded(
      'parity-rp-welcome',
      '想去云南看看',
      [{ role: 'agent', content: wecomTest.WELCOME_BACK_TEXT, at: Date.now() }],
      searchYunnan,
    );
  });

  // ======== 7. 跟进：文件存储的扫描器（先同步落盘再推送）与 PG 存储的任务表（第 10 步：记账与 sending 一起提交之后再推送） ========
  // 推送那一刻，各自的持久副本（sessions.json / 库里的会话行）里已经记了账；两边发出的跟进与记账相同。PG 那边另核对任务表里的状态。
  // 两个会话的先后在两边相同：扫描器按 updatedAt 从新到旧（ok 沉默 4 小时、fail 5 小时），任务表按 run_at（ok 是报价后 2 小时、
  // fail 是异议后 4 小时，ok 的更早）
  await scenario('跟进', ['wecom:parity-fu-ok', 'wecom:parity-fu-fail'], async (o) => {
    // 客户先问过一句（带 sentAt）：db 存储下跟进查发送账本的窗口（第 12 步），没有客户消息窗口就没开、一条都不发
    const silent = (sid: string, stage: Session['stage'], hours: number) => {
      const f = store.getOrCreateSession(sid, 'wecom');
      f.stage = stage;
      f.updatedAt = Date.now() - hours * 3600_000;
      f.messages.push(
        { role: 'customer', content: '这条线多少钱', at: f.updatedAt - 60_000, sentAt: f.updatedAt - 60_000 },
        { role: 'agent', content: '这条线每人 19,800 元起', at: f.updatedAt },
      );
      store.saveSession(f, false);
    };
    type Fu = { count?: number; stages?: string[]; pendingAt?: number; failures?: number };
    const su = <R>(sql: string, params: unknown[]): Promise<R[]> =>
      t.pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE NONE');
        return (await tx.query<R>(sql, params)).rows;
      });
    const durable = async (id: string): Promise<unknown> => {
      let fu: Fu | undefined;
      if (mode === 'file') {
        const all = JSON.parse(fs.readFileSync(path.join(VAR, 'sessions.json'), 'utf8')) as (Session & { followup?: Fu })[];
        fu = all.find((s) => s.id === id)?.followup;
      } else {
        fu = (await su<{ f: Fu | null }>("select state->'followup' as f from conversations where id = $1", [id]))[0]?.f ?? undefined;
      }
      return fu ? { count: fu.count, stages: fu.stages, pending: fu.pendingAt != null, failures: fu.failures ?? 0 } : null;
    };
    const pushes: unknown[] = [];
    let delivered = 0;
    const push = async (id: string, text: string): Promise<boolean> => {
      pushes.push({ id, text, durableAtPush: await durable(id) });
      if (id.endsWith('-ok')) delivered += 1;
      return id.endsWith('-ok');
    };
    const noon = new Date();
    noon.setHours(12, 0, 0, 0); // 避开夜间免打扰
    /** 一轮：文件存储扫一遍；PG 存储认领一批到点的任务。返回这一轮送达的条数 */
    const round = async (at: number): Promise<number> => {
      const before = delivered;
      if (mode === 'file') await runFollowUpScan(push, noon);
      else await jobs.runJobsOnce(at);
      for (const id of ['wecom:parity-fu-ok', 'wecom:parity-fu-fail']) await store.flushSession(id);
      return delivered - before;
    };
    process.env.FOLLOWUP_ENABLED = '1';
    try {
      if (mode === 'db') jobs.__jobsTest.start(push);
      silent('wecom:parity-fu-ok', 'quote', 4);
      silent('wecom:parity-fu-fail', 'objection', 5);
      for (const id of ['wecom:parity-fu-ok', 'wecom:parity-fu-fail']) await store.flushSession(id);
      script.push({ content: '出行日期定下来了吗？' }, { content: '您更想哪天出发？' });
      o.note('round1', await round(Date.now()));
      o.note('leftover1', takeLeftover());
      // 第二轮：发出去的那个这个阶段追过了，不再追；没送达的退了账、失败计 1 次，再追一次（又没送达）。
      // 扫描器下一轮就会再扫到它；任务表按扫描器的间隔排了重试，拨到那之后
      script.push({ content: '这两天方便聊聊出发日期吗？' });
      o.note('round2', await round(Date.now() + 16 * 60_000));
      o.note('leftover2', takeLeftover());
      if (mode === 'db') {
        const rows = await su<{ sid: string; status: string; last_error: string | null }>(
          `select payload->>'sessionId' as sid, status, last_error from jobs where kind = 'followup' and payload->>'sessionId' like 'wecom:parity-fu-%' order by created_at`,
          [],
        );
        const of = (sid: string) => rows.filter((r) => r.sid === sid).map((r) => r.status);
        ck(
          '跟进',
          'PG：任务表里送达的那个 done；没送达的两次 failed（push_failed），还排着下一次重试',
          JSON.stringify(of('wecom:parity-fu-ok')) === JSON.stringify(['done']) &&
            JSON.stringify(of('wecom:parity-fu-fail')) === JSON.stringify(['failed', 'failed', 'pending']) &&
            rows.filter((r) => r.status === 'failed').every((r) => r.last_error === 'push_failed'),
          JSON.stringify(rows),
        );
      }
    } finally {
      process.env.FOLLOWUP_ENABLED = '';
    }
    o.note('pushes', pushes);
  });

  // ======== 8. 转人工各入口 ========
  const HO = {
    request: 'wecom:parity-ho-request',
    complaint: 'wecom:parity-ho-complaint',
    refund: 'wecom:parity-ho-refund',
    model: 'wecom:parity-ho-model',
    promise: 'wecom:parity-ho-promise',
    claimed: 'wecom:parity-ho-claimed',
    legacy: 'wecom:parity-ho-legacy',
  };
  await scenario('转人工各入口', Object.values(HO), async (o) => {
    // 安全网三类：确定性转人工，本轮不调模型；之后客户再说话 AI 静默
    for (const [sid, text] of [
      [HO.request, '转人工'],
      [HO.complaint, '我要投诉'],
      [HO.refund, '转人工，我想取消订单'],
    ] as const) {
      await say(o, sid, text, []);
      await say(o, sid, '在吗', []);
    }
    // 模型调 handoff_to_human：原话带出行时间，转人工备注随「AI 已转人工」那条 system 消息一次写成（第 1 步第 4 处写入点，
    // 原来是工具写完之后再 rec.content += 原地追加，PG 存储下会抛 TypeError）
    await say(o, HO.model, '想去云南看看', searchYunnan);
    await say(o, HO.model, '我们10月12号出发，想换几个景点', [
      { toolCalls: [{ name: 'handoff_to_human', args: { reason: '客户要换景点' } }] },
      { content: '好的，我马上为您转接资深顾问，请稍候～' },
    ]);
    await say(o, HO.model, '在吗', []);
    // 改行程承诺（promise）与回复说了转接（claimed），原话都带出行时间
    await say(o, HO.promise, '我们10月12号出发，这条能改成5天吗', [{ content: '可以的，我按5天帮您重排行程。' }]);
    await say(o, HO.promise, '在吗', []);
    await say(o, HO.claimed, '我们10月12号出发，签证这块能让顾问帮我看看吗', [
      { content: '好的，签证这块我马上为您转接资深顾问，请稍候～' },
    ]);
    await say(o, HO.claimed, '在吗', []);
    // 旧 /handoff：共享工作台转人工；再点一次什么都不改；人工回复经企微发出；交还之后 AI 照常接待
    await say(o, HO.legacy, '10月12号出发，先看看', [{ content: '好的～您几位出行？' }]);
    o.note('legacy', [await legacy(HO.legacy, 'handoff'), await legacy(HO.legacy, 'handoff')]);
    await say(o, HO.legacy, '两个人', []);
    o.note('legacyReply', await legacy(HO.legacy, 'reply'));
    o.note('legacyResume', await legacy(HO.legacy, 'resume'));
    await say(o, HO.legacy, '想去云南看看', searchYunnan);
  });

  // 少调模型由父进程逐轮看 leftover；这里只管多调（脚本空了还来的请求）
  ck('收尾', '没有多出来的模型请求（脚本空了还来的）', overrun === 0, `多 ${overrun} 次`);
}
