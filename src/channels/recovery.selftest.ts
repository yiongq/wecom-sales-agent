// 03 第 10 步：启动恢复与崩溃点（docs/architecture/03-channels-v2/spec.md「重启、崩溃与恢复」、R5、R6、R21 的保底，不变量 5、6、10、15；
// 验收 4、7 的杀进程部分、18、20 的重启部分）。两部分：
//   纯函数（总是跑）：recovery-rules.ts 的出站恢复表、保底与入站恢复表，每一格一条表驱动断言，期望值是照 spec 原表写的独立字面量。
//   杀进程（PG_TEST_URL 设了才跑；没设打一行「跳过」、以 0 退出；CI 下必须设）：父进程在真实 Postgres 上建一次性库，带上 RECOVERY_CHILD
//   起三对子进程（单进程 node --import tsx，超时 SIGKILL，不留孤儿）。前一个驱动真实的渠道装载、企微适配器与 PG 会话存储，把每个场景卡在
//   要杀的那一刻（假企微挂住请求的接收或回包、假模型挂住生成、账本的 markSending 钩子、借连接的闸门），存下结果后自己 SIGKILL；后一个在
//   同一个库上重启、做完启动恢复之后核对。假企微与假模型都在进程里（替换 fetch，不开端口）；收到的每次 send_msg、模型调用与告警同步追加进
//   文件，跨进程数「客户恰好收到一组」。
//     k1 → r1：验收 4 的五个杀点（recorded、replied 而第一段没开始、两段发完第一段、请求已到回包挂住、markSending 之后请求没到）、
//              验收 7 的 A、验收 20 的重启部分（截止之后才回包、markSending 挂住跨过截止）
//     k2 → r2（重启之前经 __channelTest 把 RESEND_UNKNOWN 设为真）：验收 4 后两种重跑、验收 7 的 B
//     k3 → r3：验收 18 每一种没结果的出站行；恢复做完之前到期的跟进等恢复做完才发；等恢复超过上限的人工回复按没发出去处理
// 用法：npx tsx src/channels/recovery.selftest.ts（杀进程的部分要 PG_TEST_URL 指向一次性的 pgvector/pgvector:pg17 容器）
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 与会话存储钉住，本机 .env 进不来（见 selftest-env.ts）
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '../types.js';
import {
  aiReplyAfter,
  effectiveInboxState,
  HUMAN_RESEND_WINDOW_MS,
  outboundRecovery,
  RESEND_UNKNOWN,
  recordedRecovery,
  repliedRecovery,
  type OpenOutboundFacts,
} from './recovery-rules.js';

const CHILD = process.env.RECOVERY_CHILD ?? '';
const SELF = fileURLToPath(import.meta.url);
const H = 3_600_000;

let pass = 0;
const fails: string[] = [];
const logBuf: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const json = (v: unknown): string => JSON.stringify(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(20);
  }
  return cond();
}

// ---------------- 账号与客户（假 id 不用 ww、wk 开头；external_userid 是 wm 加至多 13 个字符） ----------------

interface AcctDef {
  key: string;
  corp: string;
  kf: string;
  prefix: string;
  seed: number;
}
const ACCTS: AcctDef[] = [
  { key: 'r1', corp: 'corp10a', kf: 'kf10r1', prefix: 'wecom:', seed: 21 },
  { key: 'r2', corp: 'corp10a', kf: 'kf10r2', prefix: 'wecom:r2:', seed: 22 },
  { key: 'r3', corp: 'corp10b', kf: 'kf10r3', prefix: 'wecom:r3:', seed: 23 },
];
const acct = (key: string): AcctDef => ACCTS.find((a) => a.key === key)!;
const secretsOf = (a: AcctDef): { appSecret: string; callbackToken: string; callbackAesKey: string } => ({
  appSecret: `s10-${a.key}-app`,
  callbackToken: `s10-${a.key}-cb`,
  callbackAesKey: Buffer.alloc(32, a.seed).toString('base64').slice(0, 43),
});
const sidOf = (key: string, uid: string): string => acct(key).prefix + uid;

/** 两段的回复（超过企微 2000 字节的分段上限） */
const LONG_REPLY = `这条线路的安排是这样的：${'每天早上八点出发，下午四点回到酒店休息，晚上自由活动。'.repeat(30)}您看可以吗？`;
const DEFAULT_REPLY = '好的～您几位出行、大概什么时候走？';

/** k1 → r1、k2 → r2 的客户（一个场景一个客户） */
const U = {
  a: 'wm10a', // recorded：模型生成途中（同一客户一页两句）
  b: 'wm10b', // replied、第一段没开始
  c: 'wm10c', // 两段发完第一段、第二段没标 sending
  d: 'wm10d', // 请求已到假企微、回包挂住
  e: 'wm10e', // markSending 提交之后、请求没到假企微
  f: 'wm10f', // 停机截止之后模型才回包
  g: 'wm10g', // markSending 挂住期间跨过截止
  h: 'wm10h', // 验收 7 的 A：pending 已提交、markSending 判 db_unavailable、照发之后结果没落库
  i: 'wm10i', // RESEND_UNKNOWN 重跑：请求已到、回包挂住
  j: 'wm10j', // RESEND_UNKNOWN 重跑：markSending 之后请求没到
  k: 'wm10k', // 验收 7 的 B：commitOutbound 超时照发、结果没落库
  l: 'wm10l', // RESEND_UNKNOWN 重跑：AI 回复的段 sending（请求已到、回包挂住），杀之前顾问接手 → 不补发、记 unknown
  m: 'wm10m', // RESEND_UNKNOWN 重跑：通知的段 sending，杀之前顾问接手 → 通知照样按同一 msgid 补发
};

/** k3 → r3 的客户（验收 18：每一种没结果的出站行一个客户） */
const V = {
  n: 'wm10n', // notice、pending → 补发
  o: 'wm10o', // followup、pending → cancelled
  p: 'wm10p', // human、10 分钟内、接手人没变 → 补发
  q: 'wm10q', // human、超过 10 分钟 → cancelled
  r: 'wm10r', // human、接手人变了（交还） → cancelled
  s: 'wm10s', // menu、pending → cancelled
  t: 'wm10t', // welcome、pending → cancelled
  u: 'wm10u', // 没有 inbox_id 的 ai（异常道歉）→ cancelled
  v: 'wm10v', // notice、sending → unknown、不补发
  w: 'wm10w', // pending、sent_at 不晚于恢复截止点（r3）→ cancelled
  x: 'wm10x', // pending、有 inbox_id、入站已结束 → cancelled
  y: 'wm10y', // pending、有 inbox_id、入站没结束 → 入站恢复补发
  z: 'wm10z', // kind=card 的 pending（不该有）→ cancelled、记一行
  rc: 'wm10rc', // notice、pending，另有一条指着它的失败回执停在 received（第 9 步：回执的短事务没写成）→ 不补发、回执重做后 failed
  tk: 'wm10tk', // 入站 replied、分段 pending，杀之前顾问接手了 → 名下 pending 的段 cancelled、记「本轮未发送」
  rr: 'wm10rr', // 入站 recorded、会话里这句之后已有 AI 回复（库里没有它的出站行）→ 按那条回复切分段照常发、不调模型
  ro: 'wm10ro', // 入站 received、名下已有 pending 的出站行（保底：按 replied 处理）→ 按同一 msgid 补发、不调模型
  fu: 'wm10fu', // 恢复做完之前到期的跟进
  p2: 'wm10p2', // 恢复做完之前的人工回复，等过上限
};

/** k4 → p1…p4 的客户（验收 3：一页 3 条；验收 9：毒消息与排在它后面的第二句） */
const A3 = ['wm10s1', 'wm10s2', 'wm10s3'];
const PZ = 'wm10pz';
const POISON_NOTE = '⚠️ 客户有一条消息 AI 未能处理（已重放 2 次仍未处理完），请人工回复';

/** 毒消息那个客户的入站行：原文 → msgid（payload 在入站行结束之后清空，先按原文找到的记下来） */
const pzMsgids = new Map<string, string>();

/** 子进程：先把结果写下来，再像被 OOM、kill -9 那样硬杀自己（childMain 装上；假企微、假模型在约好的那一刻调它） */
let die: (() => void) | null = null;

if (CHILD) await childMain(CHILD);
else await parentMain();

// ======================================================================================
// 纯函数：恢复表每一格
// ======================================================================================

function pureSuite(): void {
  check('RESEND_UNKNOWN 缺省为假（开放问题 4 核实之前）', RESEND_UNKNOWN === false);
  check('人工回复补发的窗口是 10 分钟（开放问题 6）', HUMAN_RESEND_WINDOW_MS === 10 * 60_000);

  // ---- 出站恢复表：spec 原表一行一组，自上而下第一行命中 ----
  const now = 1_800_000_000_000;
  const base: OpenOutboundFacts = {
    status: 'pending',
    kind: 'notice',
    sentAt: now - 60_000,
    inboxId: null,
    inboxOpen: false,
    recordOnlyUntil: null,
    humanAssigneeSame: true,
    hasAssignee: false,
    now,
    resendUnknown: false,
    failReceived: false,
  };
  const KINDS = ['ai', 'human', 'followup', 'notice', 'menu', 'welcome', 'card'] as const;
  const show = (r: unknown): string => json(r);
  // 表前一行：失败回执停在 received、指着这一段 → 留给回执（任何状态、种类，截止点、入站、RESEND_UNKNOWN 都不看）
  for (const status of ['pending', 'sending'] as const) {
    for (const kind of KINDS) {
      for (const extra of [
        {},
        { inboxId: 'i1', inboxOpen: true },
        { recordOnlyUntil: now },
        { resendUnknown: true },
        { resendUnknown: true, hasAssignee: true },
      ]) {
        check(
          `出站表 ${status}/${kind} ${json(extra)} 已收到失败回执：留给回执`,
          show(outboundRecovery({ ...base, ...extra, status, kind, failReceived: true })) === show({ do: 'receipt' }),
        );
      }
    }
  }
  // sending（任何种类）：RESEND_UNKNOWN 为假 unknown、为真保持 sending 补发（截止点、入站、人工回复的接手人都不看）；
  // 为真而会话有接手人：AI 产生的（ai、followup、menu、welcome、card）记 unknown、不补发，通知与人工回复照样补发（不变量 10）
  const AI_MADE = new Set(['ai', 'followup', 'menu', 'welcome', 'card']);
  for (const kind of KINDS) {
    for (const extra of [
      {},
      { inboxId: 'i1', inboxOpen: true },
      { recordOnlyUntil: now },
      { humanAssigneeSame: false },
      { hasAssignee: true },
      { hasAssignee: true, inboxId: 'i1', inboxOpen: true },
    ]) {
      const f = { ...base, ...extra, status: 'sending' as const, kind };
      check(`出站表 sending/${kind} ${json(extra)}：unknown`, show(outboundRecovery(f)) === show({ do: 'unknown' }));
      const want = f.hasAssignee && AI_MADE.has(kind) ? { do: 'unknown' } : { do: 'resend', alreadySending: true };
      check(
        `出站表 sending/${kind} ${json(extra)}、RESEND_UNKNOWN：${json(want)}`,
        show(outboundRecovery({ ...f, resendUnknown: true })) === show(want),
      );
    }
  }
  // pending 的各行不看会话有没有接手人（人工回复看的是「接手人没变」，见下）
  for (const kind of KINDS) {
    check(
      `出站表 pending/${kind} 的处理不看会话有没有接手人`,
      show(outboundRecovery({ ...base, kind, hasAssignee: true })) === show(outboundRecovery({ ...base, kind })),
    );
  }
  // pending，sent_at 不晚于恢复截止点：cancelled（任何种类、有没有入站都先看它；等于截止点也算）
  for (const kind of KINDS) {
    for (const extra of [{}, { inboxId: 'i1', inboxOpen: true }]) {
      for (const sentAt of [now - 2 * H, now - H]) {
        const f = { ...base, ...extra, kind, sentAt, recordOnlyUntil: now - H };
        check(
          `出站表 pending/${kind} ${json(extra)} sent_at ${sentAt === now - H ? '等于' : '早于'}截止点：cancelled（restore_cutoff）`,
          show(outboundRecovery(f)) === show({ do: 'cancel', why: 'restore_cutoff' }),
        );
      }
    }
  }
  // 截止点之后建的行不受截止点影响（下面各行照常）
  check(
    '出站表 pending/notice sent_at 晚于截止点：照常补发',
    show(outboundRecovery({ ...base, recordOnlyUntil: base.sentAt - 1 })) === show({ do: 'resend', alreadySending: false }),
  );
  // pending，有 inbox_id：入站行还没结束 → 留给入站恢复；已结束或已被清理 → cancelled（种类不看）
  for (const kind of KINDS) {
    check(
      `出站表 pending/${kind} 有 inbox_id、入站行没结束：留给入站恢复`,
      show(outboundRecovery({ ...base, kind, inboxId: 'i1', inboxOpen: true })) === show({ do: 'inbound' }),
    );
    check(
      `出站表 pending/${kind} 有 inbox_id、入站行已结束或已清理：cancelled（inbox_finished）`,
      show(outboundRecovery({ ...base, kind, inboxId: 'i1', inboxOpen: false })) === show({ do: 'cancel', why: 'inbox_finished' }),
    );
  }
  // pending，没有 inbox_id，按种类
  const EXPECT: Record<(typeof KINDS)[number], unknown> = {
    followup: { do: 'cancel', why: 'followup' },
    notice: { do: 'resend', alreadySending: false },
    human: { do: 'resend', alreadySending: false },
    menu: { do: 'cancel', why: 'menu' },
    welcome: { do: 'cancel', why: 'welcome' },
    ai: { do: 'cancel', why: 'ai_without_inbox' },
    card: { do: 'cancel', why: 'card' },
  };
  for (const kind of KINDS) {
    check(`出站表 pending/${kind} 没有 inbox_id：${json(EXPECT[kind])}`, show(outboundRecovery({ ...base, kind })) === show(EXPECT[kind]));
  }
  // 人工回复：10 分钟内、接手人没变才补发（边界：正好 10 分钟算内，多 1 毫秒算外）；种类之外的不看接手人
  const human = { ...base, kind: 'human' as const };
  const HUMAN_CASES: [string, Partial<OpenOutboundFacts>, unknown][] = [
    ['刚建、接手人没变', { sentAt: now - 1 }, { do: 'resend', alreadySending: false }],
    ['正好 10 分钟、接手人没变', { sentAt: now - 10 * 60_000 }, { do: 'resend', alreadySending: false }],
    ['10 分钟多 1 毫秒', { sentAt: now - 10 * 60_000 - 1 }, { do: 'cancel', why: 'human_stale' }],
    ['10 分钟多 1 毫秒、接手人也变了', { sentAt: now - 10 * 60_000 - 1, humanAssigneeSame: false }, { do: 'cancel', why: 'human_stale' }],
    ['刚建、接手人变了', { sentAt: now - 1, humanAssigneeSame: false }, { do: 'cancel', why: 'human_assignee_changed' }],
    ['钟回拨（建行时刻在将来）、接手人没变', { sentAt: now + 60_000 }, { do: 'resend', alreadySending: false }],
  ];
  for (const [label, extra, want] of HUMAN_CASES) {
    check(`出站表 pending/human ${label}：${json(want)}`, show(outboundRecovery({ ...human, ...extra })) === show(want));
  }
  for (const kind of KINDS.filter((k) => k !== 'human')) {
    check(
      `出站表 pending/${kind} 的处理不看接手人`,
      show(outboundRecovery({ ...base, kind, humanAssigneeSame: false })) === show(EXPECT[kind]),
    );
    check(
      `出站表 pending/${kind} 的处理不看建行多久`,
      show(outboundRecovery({ ...base, kind, sentAt: now - 30 * 86_400_000 })) === show(EXPECT[kind]),
    );
  }

  // ---- 保底三条（R21）：只对客户消息 ----
  const STATES = ['received', 'recorded', 'replied'] as const;
  for (const state of STATES) {
    for (const inSession of [false, true]) {
      for (const known of [false, true]) {
        for (const hasOutbound of [false, true]) {
          const got = effectiveInboxState({ kind: 'message', state, inSession, known, hasOutbound });
          let want: { state: string; restore: boolean };
          if (state === 'received') {
            want = hasOutbound
              ? { state: 'replied', restore: false }
              : inSession || known
                ? { state: 'recorded', restore: false }
                : { state: 'received', restore: false };
          } else if (state === 'recorded') want = { state: 'recorded', restore: !inSession && !known };
          else want = { state: 'replied', restore: false };
          check(`保底 message/${state} ${json({ inSession, known, hasOutbound })}：${json(want)}`, json(got) === json(want));
          for (const kind of ['menu_click', 'send_fail', 'legacy'] as const) {
            check(
              `保底只对客户消息：${kind}/${state} ${json({ inSession, known, hasOutbound })} 原样`,
              json(effectiveInboxState({ kind, state, inSession, known, hasOutbound })) === json({ state, restore: false }),
            );
          }
        }
      }
    }
  }

  // ---- 入站恢复表：recorded 的三行（加「不在窗口里」与「有回复而有接手人」两种）----
  for (const inWindow of [false, true]) {
    for (const ai of [false, true]) {
      for (const handedOver of [false, true]) {
        for (const hasAssignee of [false, true]) {
          if (hasAssignee && !handedOver) continue; // 有接手人必在转人工中
          const got = recordedRecovery({ inWindow, aiReplyAfter: ai, handedOver, hasAssignee });
          const want = !inWindow
            ? { do: 'done', why: 'out_of_window' }
            : ai
              ? hasAssignee
                ? { do: 'cancel_reply' }
                : { do: 'send_reply' }
              : handedOver
                ? { do: 'done', why: 'handed_over' }
                : { do: 'rerun' };
          check(`入站表 recorded ${json({ inWindow, ai, handedOver, hasAssignee })}：${json(want)}`, json(got) === json(want));
        }
      }
    }
  }
  // replied：有接手人 → 取消名下 pending；否则补发；名下没有 pending 的 → done
  for (const hasAssignee of [false, true]) {
    for (const pending of [0, 1, 3]) {
      const want = !pending ? { do: 'done' } : hasAssignee ? { do: 'cancel_pending' } : { do: 'resend_pending' };
      check(
        `入站表 replied ${json({ hasAssignee, pending })}：${json(want)}`,
        json(repliedRecovery({ hasAssignee, pending })) === json(want),
      );
    }
  }

  // ---- 「这句之后有 AI 回复」：下一条客户消息之前、agent 且 author 为空或 ai、不是欢迎语 ----
  const W = '欢迎来到这里';
  const welcome = (c: string): boolean => c === W;
  const m = (role: string, content = 'x', author?: string): { role: string; content: string; author?: string } =>
    author === undefined ? { role, content } : { role, content, author };
  const AI_CASES: [string, ReturnType<typeof m>[], number][] = [
    ['紧跟一条 AI 回复', [m('customer'), m('agent')], 1],
    ['author=ai 也算', [m('customer'), m('agent', 'x', 'ai')], 1],
    ['中间夹着 system 与欢迎语', [m('customer'), m('system'), m('agent', W), m('agent', 'y')], 3],
    ['人工回复、跟进不算', [m('customer'), m('agent', 'h', 'human'), m('agent', 'f', 'followup')], -1],
    ['下一条客户消息之后的不算', [m('customer'), m('customer'), m('agent')], -1],
    ['只有欢迎语', [m('customer'), m('agent', W)], -1],
    ['这句是最后一条', [m('agent'), m('customer')], -1],
  ];
  for (const [label, msgs, want] of AI_CASES) {
    const at = label === '这句是最后一条' ? 1 : 0;
    check(`AI 回复判定：${label}`, aiReplyAfter(msgs, at, welcome) === want, String(aiReplyAfter(msgs, at, welcome)));
  }
}

// ======================================================================================
// 父进程
// ======================================================================================

async function parentMain(): Promise<never> {
  pureSuite();
  const purePass = pass;
  const url = process.env.PG_TEST_URL;
  if (!url) {
    if (process.env.CI === 'true') fails.push('CI 下必须设 PG_TEST_URL：启动恢复的杀进程自测要在真实 Postgres 上跑');
    if (!fails.length) {
      console.log(
        `RECOVERY SELFTEST PASS: 纯函数 ${purePass} 项（出站恢复表、保底、入站恢复表每一格）；真实 PG 的杀进程部分跳过（没设 PG_TEST_URL）`,
      );
      process.exit(0);
    }
  } else {
    const varParent = process.env.VAR_DIR ?? os.tmpdir();
    fs.mkdirSync(varParent, { recursive: true });
    const ROOT = fs.mkdtempSync(path.join(varParent, 'recovery-selftest-'));
    process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
    const testing = await import('../db/testing.js');
    const runChild = (
      mode: string,
      env: Record<string, string>,
    ): { status: number | null; signal: NodeJS.Signals | null; out: string; result: { pass: number; fails: string[] } | null } => {
      const resultFile = path.join(ROOT, `${mode}-${Date.now()}.json`);
      const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RECOVERY_CHILD: mode,
          RECOVERY_RESULT: resultFile,
          CONFIG_SOURCE: 'file',
          // 跟进的夜间时段关掉（真实 PG 的子进程用真钟：库的 now() 拨不动）
          FOLLOWUP_QUIET_START: '0',
          FOLLOWUP_QUIET_END: '0',
          ...env,
        },
        timeout: 240_000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      let result: { pass: number; fails: string[] } | null = null;
      try {
        result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { pass: number; fails: string[] };
      } catch {
        result = null;
      }
      return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, result };
    };
    const merge = (label: string, r: ReturnType<typeof runChild>): void => {
      if (!r.result) {
        fails.push(`${label}：子进程没留下结果（status=${r.status} signal=${r.signal}）${r.out.slice(-3000)}`);
        return;
      }
      pass += r.result.pass;
      for (const f of r.result.fails) fails.push(`${label}：${f}`);
      if (r.result.fails.length) fails.push(`${label} 的日志：${r.out.slice(-4000)}`);
    };
    // 每一组前后几个子进程连同一个库；kill 的那一个卡到约好的那一刻自己 SIGKILL，ok 的那一个正常结束
    const SEQS: { label: string; steps: [string, 'kill' | 'ok'][] }[] = [
      {
        label: '验收 4 的杀点、验收 7 的 A、验收 20',
        steps: [
          ['k1', 'kill'],
          ['r1', 'ok'],
        ],
      },
      {
        label: 'RESEND_UNKNOWN 为真、验收 7 的 B',
        steps: [
          ['k2', 'kill'],
          ['r2', 'ok'],
        ],
      },
      {
        label: '验收 18 每一种出站行、跟进等恢复',
        steps: [
          ['k3', 'kill'],
          ['r3', 'ok'],
        ],
      },
      {
        label: '验收 3 提交之后立刻杀、验收 9 毒消息',
        steps: [
          ['k4', 'kill'],
          ['p1', 'kill'],
          ['p2', 'kill'],
          ['p3', 'kill'],
          ['p4', 'ok'],
        ],
      },
    ];
    for (const { label, steps } of SEQS) {
      // 每一组一个一次性库（createRealPgFixture 会改集群级角色的口令：一组用完再建下一组）
      const fx = await testing.createRealPgFixture(url, { slug: 'recov10' });
      const dir = fs.mkdtempSync(path.join(ROOT, `${steps[0]![0]}-`));
      const env = {
        RECOVERY_APP_URL: fx.urls.app,
        RECOVERY_SUPER_URL: fx.urls.super,
        RECOVERY_TENANT: fx.tenantId,
        RECOVERY_DIR: dir,
        VAR_DIR: fs.mkdtempSync(path.join(dir, 'var-')),
      };
      try {
        for (const [mode, expect] of steps) {
          const r = runChild(mode, env);
          if (expect === 'kill') {
            check(`${label}：${mode} 走到约好的那一刻之后被 SIGKILL`, r.signal === 'SIGKILL', `status=${r.status} ${r.out.slice(-2000)}`);
          } else {
            check(`${label}：${mode} 重启之后正常结束`, r.status === 0, `status=${r.status} signal=${r.signal} ${r.out.slice(-2000)}`);
          }
          merge(`${label}（${mode}）`, r);
        }
      } finally {
        await fx.drop();
      }
    }
  }

  if (fails.length) {
    console.error(`RECOVERY SELFTEST FAIL：${fails.length} 项（通过 ${pass} 项）`);
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log(
    `RECOVERY SELFTEST PASS: ${pass} 项断言全通（纯函数 ${purePass} 项：出站恢复表、保底、入站恢复表每一格 / 真实 PG 子进程 SIGKILL：` +
      `模型生成途中、回复落库第一段没开始、两段发完第一段、请求已到回包挂住、markSending 之后请求没到、RESEND_UNKNOWN 为真重跑、` +
      `R6 的 A 与 B、停机截止之后留 pending、每一种没结果的出站行、恢复做完之前跟进与人工回复排队、一页提交之后立刻杀、` +
      `毒消息第三次重启记 poison）`,
  );
  process.exit(0);
}

// ======================================================================================
// 子进程
// ======================================================================================

interface FakeMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number;
  msgtype: string;
  text?: { content: string };
}
/** 假企微收到的一次 send_msg（跨进程：sends.jsonl） */
interface SendLine {
  p: string;
  to: string;
  msgid: string;
  msgtype: string;
  content: string;
}

async function childMain(mode: string): Promise<never> {
  const save = (): void => fs.writeFileSync(process.env.RECOVERY_RESULT!, JSON.stringify({ pass, fails }));
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) {
    console[k] = (...args: unknown[]) => {
      logBuf.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : json(a))).join(' '));
      if (logBuf.length > 3000) logBuf.splice(0, logBuf.length - 3000);
    };
  }
  const flushLogs = (): void => {
    Object.assign(console, orig);
    if (fails.length) for (const l of logBuf.slice(-150)) console.error(`  ${l}`);
  };
  die = (): void => {
    flushLogs();
    save();
    process.kill(process.pid, 'SIGKILL');
  };
  try {
    const h = await harness(mode);
    if (mode === 'k1') await kill1(h);
    else if (mode === 'r1') await restart1(h);
    else if (mode === 'k2') await kill2(h);
    else if (mode === 'r2') await restart2(h);
    else if (mode === 'k3') await kill3(h);
    else if (mode === 'r3') await restart3(h);
    else if (mode === 'k4') await kill4(h);
    else if (mode === 'p1') await poison1(h);
    else if (mode === 'p2' || mode === 'p3') await poisonAgain(h, mode === 'p2' ? 2 : 3);
    else if (mode === 'p4') await poison4(h);
    else fails.push(`不认识的子进程 ${mode}`);
    if (mode === 'p1' || mode === 'p2' || mode === 'p3') fails.push(`${mode}：毒消息没有让进程崩溃`);
    if (mode.startsWith('k')) {
      // 卡在要杀的那一刻：先把结果写下来，再像被 OOM、kill -9 那样硬杀（没有停机钩子、没有 spill）
      flushLogs();
      save();
      process.kill(process.pid, 'SIGKILL');
      await sleep(10_000);
    }
    await h.close();
  } catch (e) {
    fails.push(`子进程抛错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  flushLogs();
  save();
  process.exit(0);
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(mode: string) {
  const dir = process.env.RECOVERY_DIR!;
  const varDir = process.env.VAR_DIR!;
  Object.assign(process.env, {
    // 假模型：主机名不可解析（.invalid），请求全被假 fetch 接住，绝不会打到真实模型
    LLM_MOCK: '0',
    LLM_PROVIDER: '',
    LLM_BASE_URL: 'https://llm.selftest.invalid/v1',
    LLM_API_KEY: 'selftest-fake-key',
    LLM_MODEL: 'selftest-fake',
    LLM_MODEL_CHEAP: '',
    LLM_HEDGE_MODEL: '',
    LLM_MAX_RETRY: '0',
    LLM_TIMEOUT_MS: '600000',
    EMBED_BASE_URL: 'https://llm.selftest.invalid/v1',
    EMBED_API_KEY: 'selftest-fake-key',
    PUBLIC_BASE_URL: '',
    SERVER_SELFTEST: '1',
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'selftest-pass',
    FOLLOWUP_ENABLED: '',
    DEMO_PRUNE_HOURS: '0',
    ALERT_WEBHOOK_URL: 'https://alert.selftest.invalid/hook',
  });
  const files = {
    sends: path.join(dir, 'sends.jsonl'),
    alerts: path.join(dir, 'alerts.jsonl'),
    llm: path.join(dir, 'llm.jsonl'),
  };
  const append = (f: string, o: Record<string, unknown>): void => fs.appendFileSync(f, `${JSON.stringify({ p: mode, ...o })}\n`);

  // ---- 假企微、假模型、假告警群（都在进程里，替换 fetch） ----
  interface Hold {
    reached: boolean;
    gate: Promise<void>;
    release: () => void;
  }
  const newHold = (): Hold => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { reached: false, gate, release };
  };
  const fake = {
    logs: new Map<string, FakeMsg[]>(),
    tokens: new Map<string, string>(),
    n: 0,
    /** send_msg 按收件人挂住：before 请求没进去就挂住（不记下）；after 记下之后挂住回包 */
    sendHolds: new Map<string, Hold & { how: 'before' | 'after' }>(),
    /** 假模型：客户这句里含 match 的那一轮回 content；有 hold 的先挂住 */
    model: [] as { match: string; content?: string; hold?: Hold; die?: () => Promise<void> }[],
    /** 下一页非空的 sync_msg 回 has_more=1；紧接着同一账号的下一次 sync_msg（acceptPage 已提交、刚派发）就地硬杀（验收 3） */
    killAfterPage: null as string | null,
    killOnNextSync: null as string | null,
  };
  const res = (o: unknown): Response => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, any>;
    if (url.hostname === 'llm.selftest.invalid') {
      if (url.pathname.endsWith('/embeddings')) {
        const input = Array.isArray(body.input) ? body.input : [body.input];
        return res({ data: input.map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 1 } });
      }
      const user = [...((body.messages ?? []) as { role: string; content: unknown }[])].reverse().find((x) => x.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : json(user?.content ?? '');
      append(files.llm, { user: text.slice(0, 120) });
      const step = fake.model.find((s) => text.includes(s.match));
      if (step?.die) {
        // 毒消息（验收 9）：处理到调模型这一步就把进程带崩（先做完要在死之前看的断言）
        await step.die();
        die?.();
        await sleep(10_000);
      }
      if (step?.hold) {
        step.hold.reached = true;
        await step.hold.gate;
      }
      return res({
        choices: [{ message: { role: 'assistant', content: step?.content ?? DEFAULT_REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }
    if (url.hostname === 'alert.selftest.invalid') {
      append(files.alerts, { text: String(body.text?.content ?? '') });
      return res({ errcode: 0 });
    }
    if (url.hostname !== 'qyapi.weixin.qq.com') return realFetch(input, init);
    const ep = url.pathname.replace(/^\/cgi-bin\//, '');
    if (ep === 'gettoken') {
      const a = ACCTS.find(
        (x) => x.corp === url.searchParams.get('corpid') && secretsOf(x).appSecret === url.searchParams.get('corpsecret'),
      );
      if (!a) return res({ errcode: 40013, errmsg: 'selftest: invalid corpid' });
      const tok = `t10-${a.key}-${++fake.n}`;
      fake.tokens.set(tok, a.key);
      return res({ errcode: 0, access_token: tok, expires_in: 7200 });
    }
    if (!fake.tokens.has(url.searchParams.get('access_token') ?? '')) return res({ errcode: 40014, errmsg: 'selftest: invalid token' });
    if (ep === 'media/upload') return res({ errcode: 40004, errmsg: 'selftest' });
    if (ep === 'kf/sync_msg') {
      const kf = String(body.open_kfid);
      // 同步地硬杀：这一刻上一页的 acceptPage 已提交、新行刚派发，处理链还没写成任何东西（计次要等一次往返）
      if (fake.killOnNextSync === kf) die?.();
      const log = fake.logs.get(kf) ?? [];
      const [k, i] = String(body.cursor ?? '').split(':');
      const from = k === kf ? Number(i) || 0 : 0;
      const list = log.slice(from);
      const more = list.length > 0 && fake.killAfterPage === kf;
      if (more) {
        fake.killAfterPage = null;
        fake.killOnNextSync = kf;
      }
      return res({ errcode: 0, next_cursor: `${kf}:${from + list.length}`, has_more: more ? 1 : 0, msg_list: list });
    }
    if (ep === 'kf/send_msg') {
      const to = String(body.touser);
      const hold = fake.sendHolds.get(to);
      if (hold?.how === 'before') {
        hold.reached = true;
        await hold.gate;
      }
      append(files.sends, {
        to,
        msgid: String(body.msgid ?? ''),
        msgtype: String(body.msgtype ?? ''),
        content: String(body.text?.content ?? body.link?.url ?? body.msgmenu?.head_content ?? '').slice(0, 60),
      });
      if (hold?.how === 'after') {
        hold.reached = true;
        await hold.gate;
      }
      return res({ errcode: 0, msgid: body.msgid });
    }
    if (ep === 'kf/send_msg_on_event') return res({ errcode: 0 });
    if (ep === 'kf/customer/batchget') return res({ errcode: 0, customer_list: [] });
    return res({ errcode: 40001, errmsg: `selftest: 未模拟的接口 ${ep}` });
  }) as typeof fetch;
  let seq = 0;
  /** 客户在这个客服账号上说一句（进假企微的日志，等拉取） */
  const say = (key: string, uid: string, content: string): FakeMsg => {
    const kf = acct(key).kf;
    const msg: FakeMsg = {
      msgid: `m10${mode}-${++seq}`,
      open_kfid: kf,
      external_userid: uid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content },
    };
    fake.logs.set(kf, [...(fake.logs.get(kf) ?? []), msg]);
    return msg;
  };

  // ---- 库与会话存储（真实 PG：父进程建的一次性库，前后几个子进程连同一个库） ----
  const store = await import('../store.js');
  const testing = await import('../db/testing.js');
  const tenantId = process.env.RECOVERY_TENANT!;
  const app = await testing.openGatedDb(process.env.RECOVERY_APP_URL!);
  const sq = await testing.connectSuperQuery(process.env.RECOVERY_SUPER_URL!);
  const su = sq.query;
  await store.initSessionStore({ db: app.db, tenantId, tenantSlug: 'recov10', varDir });

  // ---- 渠道账号：杀进程的那一个建（id 先生成，AAD 要用），重启的那一个读回 ----
  const { sealSecrets } = await import('./secrets.js');
  const keyBytes = Buffer.alloc(32, 7);
  const keyRing = { current: { id: 'k10', key: keyBytes }, all: new Map([['k10', keyBytes]]) };
  const ids = new Map<string, string>();
  if (mode.startsWith('k')) {
    for (const a of ACCTS) {
      const id = randomUUID();
      ids.set(a.key, id);
      const { ct, keyId } = sealSecrets(keyRing, { tenantId, accountId: id }, secretsOf(a));
      await su(
        `insert into channel_accounts (tenant_id, id, key, kind, name, status, id_prefix, corp_id, open_kfid, secrets_ct, secrets_key_id)
         values ($1, $2, $3, 'wecom_kf', $3, 'active', $4, $5, $6, decode($7, 'hex'), $8)`,
        [tenantId, id, a.key, a.prefix, a.corp, a.kf, ct.toString('hex'), keyId],
      );
    }
  } else {
    for (const r of await su<{ id: string; key: string; cursor: string | null }>(
      'select id, key, cursor from channel_accounts where tenant_id = $1',
      [tenantId],
    )) {
      ids.set(r.key, r.id);
      // 假企微的日志只在进程里：重启的子进程先垫到库里的 cursor 那一位，之后客户说的话接在后面（垫的这几条永远拉不到）
      const kf = acct(r.key).kf;
      const n = r.cursor?.startsWith(`${kf}:`) ? Number(r.cursor.slice(kf.length + 1)) || 0 : 0;
      fake.logs.set(
        kf,
        Array.from({ length: n }, (_, i) => ({
          msgid: `pad-${r.key}-${i}`,
          open_kfid: kf,
          external_userid: 'wm10pad',
          send_time: 0,
          origin: 3,
          msgtype: 'text',
          text: { content: 'pad' },
        })),
      );
    }
  }

  const reg = await import('./registry.js');
  const wecom = await import('../adapters/wecom.js');
  const ledger = await import('../quota/ledger.js');
  const tk = await import('../handoff/takeover.js');
  const alerts = await import('../ops/alert.js');
  await import('../server.js'); // 推送通道（人工回复、跟进经 adapterFor 找到企微适配器）与 prepare 的接线
  await reg.initChannels({ db: app.db, tenantId, tenantSlug: 'recov10', varDir, keyRing });

  // ---- markSending 的钩子：按会话（与段号）挂住，或在那一刻挡住写库 ----
  const markHolds: { match: (i: { sessionId: string; segment: number }) => boolean; hold: Hold; onReach?: () => void }[] = [];
  ledger.__ledgerTest.setMarkHook(async (intent) => {
    const i = markHolds.findIndex((x) => !x.hold.reached && x.match(intent));
    if (i < 0) return;
    const x = markHolds[i]!;
    x.hold.reached = true;
    x.onReach?.();
    await x.hold.gate;
  });
  const holdMark = (sid: string, segment: number | null = null, onReach?: () => void): Hold => {
    const hold = newHold();
    markHolds.push({
      match: (i) => i.sessionId === sid && (segment === null || i.segment === segment),
      hold,
      ...(onReach ? { onReach } : {}),
    });
    return hold;
  };
  const holdSend = (uid: string, how: 'before' | 'after'): Hold => {
    const hold = { ...newHold(), how };
    fake.sendHolds.set(uid, hold);
    return hold;
  };
  const holdModel = (match: string, content?: string): Hold => {
    const hold = newHold();
    fake.model.push({ match, hold, ...(content ? { content } : {}) });
    return hold;
  };

  const start = (): void => {
    reg.startChannels();
    alerts.startAlerts();
  };
  const idle = (ms = 30_000): Promise<boolean> => waitFor(() => wecom.__wecomTest.idle(), ms);
  const settle = async (): Promise<void> => {
    await idle();
    for (let i = 0; i < 3; i++) {
      await sleep(30);
      await store.drainStore(5000);
    }
  };
  const pull = (key: string): void => void wecom.syncAccountFromCallback(ids.get(key)!, `poll-${key}-${++seq}`);
  /** 只有一个客户消息、没有入站行的会话（人工回复、通知、跟进等先落库的几类要有会话） */
  const mkSession = async (key: string, uid: string, ago = 0): Promise<string> => {
    const sid = sidOf(key, uid);
    const s = store.getOrCreateSession(sid, 'wecom');
    if (acct(key).prefix !== 'wecom:') s.channelAccountId = ids.get(key)!;
    s.messages.push({ role: 'customer', content: '你好', at: Date.now() - ago, msgid: `mk-${uid}`, sentAt: Date.now() - ago });
    store.saveSession(s);
    await store.flushSession(sid);
    return sid;
  };
  interface OutRow {
    msgid: string;
    status: string;
    segment: number;
    kind: string;
    inbox_id: string | null;
    message_seq: number | null;
  }
  const outOf = (sid: string): Promise<OutRow[]> =>
    su<OutRow>(
      `select channel_msgid as msgid, status, segment, kind, inbox_id::text as inbox_id, message_seq from outbound_sends
       where conversation_id = $1 order by segment, sent_at`,
      [sid],
    );
  interface InRow {
    id: string;
    msgid: string;
    state: string;
    attempts: number;
    reason: string | null;
  }
  const inboxOf = async (msgid: string): Promise<InRow | null> =>
    (await su<InRow>('select id::text as id, msgid, state, attempts, reason from channel_inbox where msgid = $1', [msgid]))[0] ?? null;
  const inboxesOf = (sid: string): Promise<InRow[]> =>
    su<InRow>('select id::text as id, msgid, state, attempts, reason from channel_inbox where conversation_id = $1 order by ord', [sid]);
  const sendsTo = (uid: string): SendLine[] => lines<SendLine>(files.sends).filter((x) => x.to === uid);
  const llmCalls = (match: string, p = mode): number =>
    lines<{ p: string; user: string }>(files.llm).filter((x) => x.p === p && x.user.includes(match)).length;
  const alertLines = (p = mode): string[] =>
    lines<{ p: string; text: string }>(files.alerts)
      .filter((x) => x.p === p)
      .map((x) => x.text);
  const customerRows = (sid: string, msgid: string): Promise<{ n: string }[]> =>
    su<{ n: string }>(`select count(*)::text as n from messages where conversation_id = $1 and msgid = $2`, [sid, msgid]);
  /** 会话里这句客户消息之后的第一条 AI 回复（工作台的投递状态挂在它上面） */
  const replyAfter = (sid: string, msgid: string): ChatMessage | undefined => {
    const msgs = store.getSession(sid)?.messages ?? [];
    const at = msgs.findIndex((x) => x.role === 'customer' && x.msgid === msgid);
    return at < 0 ? undefined : msgs.slice(at + 1).find((x) => x.role === 'agent' && (x.author === undefined || x.author === 'ai'));
  };

  return {
    mode,
    fake,
    say,
    pull,
    store,
    reg,
    wecom,
    ledger,
    tk,
    ids,
    su,
    faults: app.faults,
    start,
    idle,
    settle,
    mkSession,
    outOf,
    inboxOf,
    inboxesOf,
    sendsTo,
    llmCalls,
    alertLines,
    customerRows,
    replyAfter,
    holdMark,
    holdSend,
    holdModel,
    async close(): Promise<void> {
      await settle();
      ledger.__ledgerTest.setMarkHook(null);
      reg.__channelsTest.reset();
      await app.close();
      await sq.close();
    },
  };
}

/** 等一个挂住点到了（被调到），超时记一条失败 */
async function reached(name: string, hold: { reached: boolean }, ms = 20_000): Promise<void> {
  if (!(await waitFor(() => hold.reached, ms))) fails.push(`（前提）${name}：${ms / 1000} 秒内没走到挂住的那一刻`);
}

// ======================================================================================
// k1 → r1：验收 4 的五个杀点、验收 7 的 A、验收 20 的重启部分
// ======================================================================================

async function kill1(h: Harness): Promise<void> {
  h.ledger.__ledgerTest.setWaits({ commitMs: 700, markMs: 700 });
  h.start();
  await h.idle();
  // A：同一客户一页两句，第一句的模型挂住（入站 recorded、第二句 received 从没开始）
  const aHold = h.holdModel('A1-hang');
  const a1 = h.say('r1', U.a, 'A1-hang 想去云南看看');
  const a2 = h.say('r1', U.a, 'A2 两个人五天');
  // B：回复落库、第一段 markSending 之前挂住
  const bHold = h.holdMark(sidOf('r1', U.b));
  const b = h.say('r1', U.b, 'B 想去西藏');
  // C：两段的回复，第二段 markSending 之前挂住
  h.fake.model.push({ match: 'C-long', content: LONG_REPLY });
  const cHold = h.holdMark(sidOf('r1', U.c), 1);
  const c = h.say('r1', U.c, 'C-long 详细说说行程');
  // D：请求到了假企微、回包挂住
  const dHold = h.holdSend(U.d, 'after');
  const d = h.say('r1', U.d, 'D 想去新疆');
  // E（r2）：markSending 提交了、请求没进假企微
  const eHold = h.holdSend(U.e, 'before');
  const e = h.say('r2', U.e, 'E 想去贵州');
  h.pull('r1');
  h.pull('r2');
  await reached('A 的模型在生成', aHold);
  await reached('B 的第一段 markSending', bHold);
  await reached('C 的第二段 markSending', cHold);
  await reached('D 的请求到了假企微', dHold);
  await reached('E 的请求在路上（没进假企微）', eHold);
  const ok = await waitFor(async () => {
    const [ia1, ia2, ib, ic, id, ie] = await Promise.all([a1, a2, b, c, d, e].map((m) => h.inboxOf(m.msgid)));
    const [ob, oc, od, oe] = await Promise.all([U.b, U.c, U.d].map((u) => h.outOf(sidOf('r1', u))).concat([h.outOf(sidOf('r2', U.e))]));
    return (
      ia1?.state === 'recorded' &&
      ia1.attempts === 1 &&
      ia2?.state === 'received' &&
      ia2.attempts === 0 &&
      ib?.state === 'replied' &&
      ob.length >= 1 &&
      ob.every((x) => x.status === 'pending') &&
      ic?.state === 'replied' &&
      oc.length === 2 &&
      oc[0]!.status === 'accepted' &&
      oc[1]!.status === 'pending' &&
      id?.state === 'replied' &&
      od.length === 1 &&
      od[0]!.status === 'sending' &&
      ie?.state === 'replied' &&
      oe.length === 1 &&
      oe[0]!.status === 'sending'
    );
  });
  check(
    '（前提）A recorded、attempts 1，第二句 received、0；B replied、分段全 pending；C 第一段 accepted、第二段 pending；D、E 那一段 sending',
    ok,
    json({
      a: await Promise.all([a1, a2].map((m) => h.inboxOf(m.msgid))),
      b: await h.outOf(sidOf('r1', U.b)),
      c: await h.outOf(sidOf('r1', U.c)),
      d: await h.outOf(sidOf('r1', U.d)),
      e: await h.outOf(sidOf('r2', U.e)),
    }),
  );
  check(
    '（前提）D 的请求到了假企微一次；E 的请求没进假企微',
    h.sendsTo(U.d).length === 1 && h.sendsTo(U.e).length === 0,
    json({ d: h.sendsTo(U.d), e: h.sendsTo(U.e) }),
  );

  // 验收 20（r3）：G 的 markSending 挂住、F 的模型挂住 → 跨过停机截止 → 放开：G 迁回 pending、F 的分段落成 pending，都没有请求
  const gHold = h.holdMark(sidOf('r3', U.g));
  const fHold = h.holdModel('F-late');
  const g = h.say('r3', U.g, 'G 想去四川');
  const f = h.say('r3', U.f, 'F-late 想去北京');
  h.pull('r3');
  await reached('G 的 markSending', gHold);
  await reached('F 的模型在生成', fHold);
  await waitFor(async () => (await h.inboxOf(f.msgid))?.state === 'recorded');
  h.wecom.__wecomTest.closeSends(h.ids.get('r3')!, Date.now());
  gHold.release();
  fHold.release();
  const ok20 = await waitFor(async () => {
    const [og, of] = await Promise.all([h.outOf(sidOf('r3', U.g)), h.outOf(sidOf('r3', U.f))]);
    const [ig, iF] = await Promise.all([h.inboxOf(g.msgid), h.inboxOf(f.msgid)]);
    return (
      og.length === 1 &&
      og[0]!.status === 'pending' &&
      of.length >= 1 &&
      of.every((x) => x.status === 'pending') &&
      ig?.state === 'replied' &&
      iF?.state === 'replied'
    );
  });
  check(
    '（前提）截止之后：G 那一段从 sending 迁回 pending、F 的分段 pending，两条入站都停在 replied，假企微上没有请求',
    ok20 && h.sendsTo(U.g).length === 0 && h.sendsTo(U.f).length === 0,
    json({ g: await h.outOf(sidOf('r3', U.g)), f: await h.outOf(sidOf('r3', U.f)), sends: [h.sendsTo(U.g), h.sendsTo(U.f)] }),
  );

  // 验收 7 的 A（r2）：pending 已提交，markSending 那一刻挡住写库 → db_unavailable → 照发 → 结果落不了库，这时杀
  const hMark = h.holdMark(sidOf('r2', U.h), null, () => {
    h.faults.gate = new Promise<void>(() => {});
  });
  hMark.release(); // 不挂住：只在走到那一刻时挡住写库
  const hm = h.say('r2', U.h, 'H 想去海南');
  h.pull('r2');
  await reached('H 的 markSending', hMark);
  const sentH = await waitFor(() => h.sendsTo(U.h).length === 1 && h.alertLines().some((l) => l.includes('没落库时照发')));
  check(
    '（前提）验收 7 的 A：markSending 判 db_unavailable 之后照发（假企微收到一次），「没落库就发」告警一条',
    sentH && h.alertLines().filter((l) => l.includes('没落库时照发')).length === 1,
    json({ sends: h.sendsTo(U.h), alerts: h.alertLines() }),
  );
  await sleep(300);
  const [ih] = await h.su<{ state: string }>('select state from channel_inbox where msgid = $1', [hm.msgid]);
  const [oh] = await h.su<{ status: string }>(`select status from outbound_sends where conversation_id = $1`, [sidOf('r2', U.h)]);
  check(
    '（前提）验收 7 的 A：杀之前库里这一段还是 pending（结果没落库）、入站 replied',
    oh?.status === 'pending' && ih?.state === 'replied',
    json({ ih, oh }),
  );
}

async function restart1(h: Harness): Promise<void> {
  const before = {
    b: await h.outOf(sidOf('r1', U.b)),
    c: await h.outOf(sidOf('r1', U.c)),
    d: await h.outOf(sidOf('r1', U.d)),
    e: await h.outOf(sidOf('r2', U.e)),
    f: await h.outOf(sidOf('r3', U.f)),
    g: await h.outOf(sidOf('r3', U.g)),
    h: await h.outOf(sidOf('r2', U.h)),
  };
  h.start();
  await h.settle();
  const sidA = sidOf('r1', U.a);
  const ia = await h.inboxesOf(sidA);
  const groups = await Promise.all(
    ia.map((r) => h.su<{ msgid: string }>('select channel_msgid as msgid from outbound_sends where inbox_id = $1', [r.id])),
  );
  const sentA = h.sendsTo(U.a);
  const idx = (msgid: string): number => sentA.findIndex((x) => x.msgid === msgid);
  check(
    '验收 4 · 杀在模型生成途中（recorded）：重启后第一句 attempts 2、第二句 1，都 done；第一句重跑一次模型、第二句一次',
    json(ia.map((r) => [r.state, r.attempts])) ===
      json([
        ['done', 2],
        ['done', 1],
      ]) &&
      h.llmCalls('A1-hang') === 1 &&
      h.llmCalls('A2 两个人') === 1,
    json({ ia, calls: [h.llmCalls('A1-hang'), h.llmCalls('A2 两个人')] }),
  );
  check(
    '验收 4 · recorded：假企微上每句恰好一组、每段一次、没有别的；第一句那组在前；客户这句在库里只记了一次',
    groups.every((g) => g.length >= 1) &&
      sentA.length === groups.flat().length &&
      groups.flat().every((x) => sentA.filter((s) => s.msgid === x.msgid).length === 1) &&
      Math.max(...groups[0]!.map((x) => idx(x.msgid))) < Math.min(...groups[1]!.map((x) => idx(x.msgid))) &&
      (await h.customerRows(sidA, ia[0]!.msgid))[0]?.n === '1',
    json({ groups, sentA }),
  );
  // B：按同一 msgid 补发，不调模型
  const ob = await h.outOf(sidOf('r1', U.b));
  check(
    '验收 4 · 回复已落库而第一段没开始（replied、pending）：重启后按同一 msgid 补发、恰好一组、不调模型；入站 done',
    ob.length === before.b.length &&
      ob.every((x) => x.status === 'accepted') &&
      json(h.sendsTo(U.b).map((x) => x.msgid)) === json(before.b.map((x) => x.msgid)) &&
      h.llmCalls('B 想去西藏') === 0 &&
      (await h.inboxesOf(sidOf('r1', U.b)))[0]?.state === 'done',
    json({ ob, sent: h.sendsTo(U.b), calls: h.llmCalls('B 想去西藏') }),
  );
  // C：只补第二段
  const oc = await h.outOf(sidOf('r1', U.c));
  check(
    '验收 4 · 两段发完第一段、第二段没标 sending：重启后只补第二段（同一 msgid），假企微上恰好一整组两段、没有重复、不调模型',
    oc.length === 2 &&
      oc.every((x) => x.status === 'accepted') &&
      json(h.sendsTo(U.c).map((x) => x.msgid)) === json(before.c.map((x) => x.msgid)) &&
      h.llmCalls('C-long') === 0 &&
      (await h.inboxesOf(sidOf('r1', U.c)))[0]?.state === 'done',
    json({ oc, sent: h.sendsTo(U.c), calls: h.llmCalls('C-long') }),
  );
  // D：请求已到、回包挂住 → unknown、不重发、工作台「可能没送达」
  const od = await h.outOf(sidOf('r1', U.d));
  const dMsg = (await h.inboxesOf(sidOf('r1', U.d)))[0]!;
  const dReply = h.replyAfter(sidOf('r1', U.d), dMsg.msgid);
  check(
    '验收 4 · 请求已到假企微、回包挂住：重启后不重发，假企微上恰好一组，库里那一段 unknown，工作台「可能没送达」，入站 done',
    od.length === 1 &&
      od[0]!.status === 'unknown' &&
      od[0]!.msgid === before.d[0]!.msgid &&
      h.sendsTo(U.d).length === 1 &&
      !!dReply &&
      h.ledger.deliveryOf(sidOf('r1', U.d), dReply)?.status === 'unknown' &&
      dMsg.state === 'done',
    json({ od, sent: h.sendsTo(U.d), delivery: dReply ? h.ledger.deliveryOf(sidOf('r1', U.d), dReply) : null, dMsg }),
  );
  // E：markSending 之后、请求没到 → unknown、不重发、客户少收这一段
  const oe = await h.outOf(sidOf('r2', U.e));
  const eMsg = (await h.inboxesOf(sidOf('r2', U.e)))[0]!;
  const eReply = h.replyAfter(sidOf('r2', U.e), eMsg.msgid);
  check(
    '验收 4 · markSending 提交之后、请求没到假企微（R5 的边界）：重启后不重发、客户少收这一段，库里 unknown，工作台「可能没送达」',
    oe.length === 1 &&
      oe[0]!.status === 'unknown' &&
      h.sendsTo(U.e).length === 0 &&
      !!eReply &&
      h.ledger.deliveryOf(sidOf('r2', U.e), eReply)?.status === 'unknown' &&
      eMsg.state === 'done',
    json({ oe, sent: h.sendsTo(U.e), delivery: eReply ? h.ledger.deliveryOf(sidOf('r2', U.e), eReply) : null }),
  );
  const unknownAlerts = h.alertLines().filter((l) => l.includes('停在「发送中」'));
  check(
    '验收 4 · sending 转 unknown 的告警：一条，按账号写明段数（r1、r2 各 1），没有 external_userid',
    unknownAlerts.length === 1 &&
      unknownAlerts[0]!.includes('企微账号 r1 重启时有 1 段') &&
      unknownAlerts[0]!.includes('企微账号 r2 重启时有 1 段') &&
      !/wm10/.test(unknownAlerts[0]!),
    json(h.alertLines()),
  );
  // 验收 20：截止之后留在 pending 的，重启后发一次、同一 msgid、不调模型
  const of = await h.outOf(sidOf('r3', U.f));
  const og = await h.outOf(sidOf('r3', U.g));
  check(
    '验收 20 · 模型在截止之后才回包（replied、pending）：重启后发一次、msgid 与停机前生成的相同、不调模型；入站 done',
    of.length === before.f.length &&
      of.every((x) => x.status === 'accepted') &&
      json(h.sendsTo(U.f).map((x) => x.msgid)) === json(before.f.map((x) => x.msgid)) &&
      h.llmCalls('F-late') === 0 &&
      (await h.inboxesOf(sidOf('r3', U.f)))[0]?.state === 'done',
    json({ of, sent: h.sendsTo(U.f) }),
  );
  check(
    '验收 20 · markSending 挂住期间跨过截止、迁回 pending 的那一段：重启后按同一 msgid 发一次',
    og.length === 1 &&
      og[0]!.status === 'accepted' &&
      json(h.sendsTo(U.g).map((x) => x.msgid)) === json(before.g.map((x) => x.msgid)) &&
      h.llmCalls('G 想去四川') === 0,
    json({ og, sent: h.sendsTo(U.g) }),
  );
  // 验收 7 的 A：重启后那一段还是 pending，按同一 msgid 再发一次（至多多一组、msgid 相同）
  const oh = await h.outOf(sidOf('r2', U.h));
  const sentH = h.sendsTo(U.h);
  check(
    '验收 7 · A（pending 已提交、markSending db_unavailable 照发、结果没落库就杀）：重启后按同一 msgid 再发一次，假企微上多一组、msgid 相同',
    oh.length === 1 &&
      oh[0]!.status === 'accepted' &&
      sentH.length === 2 &&
      sentH.every((x) => x.msgid === before.h[0]!.msgid) &&
      sentH.map((x) => x.p).join() === 'k1,r1' &&
      h.llmCalls('H 想去海南') === 0,
    json({ oh, sentH }),
  );
  const open = await h.su<{ n: string }>(`select count(*)::text as n from outbound_sends where status in ('pending', 'sending')`);
  const openIn = await h.su<{ n: string }>(
    `select count(*)::text as n from channel_inbox where state in ('received', 'recorded', 'replied')`,
  );
  check(
    '重启之后库里没有 pending、sending 的出站行，也没有没结束的入站行（不变量 15）',
    open[0]?.n === '0' && openIn[0]?.n === '0',
    json({ open, openIn }),
  );
}

// ======================================================================================
// k2 → r2：RESEND_UNKNOWN 为真重跑后两种；验收 7 的 B
// ======================================================================================

async function kill2(h: Harness): Promise<void> {
  h.ledger.__ledgerTest.setWaits({ commitMs: 700, markMs: 700 });
  h.start();
  await h.idle();
  const iHold = h.holdSend(U.i, 'after');
  const jHold = h.holdSend(U.j, 'before');
  h.say('r1', U.i, 'I 想去云南');
  h.say('r2', U.j, 'J 想去西藏');
  h.pull('r1');
  h.pull('r2');
  await reached('I 的请求到了假企微', iHold);
  await reached('J 的请求在路上', jHold);
  const ok = await waitFor(async () => {
    const [oi, oj] = await Promise.all([h.outOf(sidOf('r1', U.i)), h.outOf(sidOf('r2', U.j))]);
    return oi.length === 1 && oi[0]!.status === 'sending' && oj.length === 1 && oj[0]!.status === 'sending';
  });
  check('（前提）I、J 那一段都是 sending；I 的请求进了假企微、J 的没进', ok && h.sendsTo(U.i).length === 1 && h.sendsTo(U.j).length === 0);
  // L（AI 回复）与 M（通知）：那一段 sending、请求进了假企微、回包挂住；杀之前顾问接手（接手落库之后再杀）
  const lHold = h.holdSend(U.l, 'after');
  h.say('r1', U.l, 'L 想去丽江');
  h.pull('r1');
  const mSid = await h.mkSession('r1', U.m);
  const mHold = h.holdSend(U.m, 'after');
  void h.wecom.wecomAdapter.push(mSid, '您的订单已付款，我们会尽快为您安排', { kind: 'notice' });
  await reached('L 的请求到了假企微', lHold);
  await reached('M 的请求到了假企微', mHold);
  for (const uid of [U.l, U.m]) {
    h.tk.takeover(sidOf('r1', uid), h.tk.sharedActor());
    await h.store.flushSession(sidOf('r1', uid));
  }
  const okLm = await waitFor(async () => {
    const [ol, om] = await Promise.all([h.outOf(sidOf('r1', U.l)), h.outOf(sidOf('r1', U.m))]);
    const assigned = await h.su<{ id: string }>(
      `select id from conversations where id = any($1::text[]) and handed_over and assignee_name is not null`,
      [[sidOf('r1', U.l), sidOf('r1', U.m)]],
    );
    return ol.length === 1 && ol[0]!.status === 'sending' && om.length === 1 && om[0]!.status === 'sending' && assigned.length === 2;
  });
  check('（前提）L（ai）、M（notice）那一段 sending、请求进了假企微，两个会话的接手已落库', okLm);

  // 验收 7 的 B（r3）：入站与计次照常提交、引擎开始生成之后挡住写库；commitOutbound 等满超时照发；结果没落库就杀
  const kHold = h.holdModel('K-r6');
  const k = h.say('r3', U.k, 'K-r6 想去新疆');
  h.pull('r3');
  await reached('K 的模型在生成', kHold);
  await waitFor(async () => (await h.inboxOf(k.msgid))?.state === 'recorded');
  check('（前提）验收 7 的 B：入站 recorded 已提交、模型在生成', (await h.inboxOf(k.msgid))?.state === 'recorded');
  h.faults.gate = new Promise<void>(() => {});
  kHold.release();
  const sentK = await waitFor(() => h.sendsTo(U.k).length >= 1 && h.alertLines().some((l) => l.includes('没落库时照发')));
  check(
    '（前提）验收 7 的 B：commitOutbound 超时之后照发（假企微收到这一组），「没落库就发」告警一条',
    sentK && h.alertLines().filter((l) => l.includes('没落库时照发')).length === 1,
    json({ sends: h.sendsTo(U.k), alerts: h.alertLines() }),
  );
  await sleep(300);
}

async function restart2(h: Harness): Promise<void> {
  const before = { i: await h.outOf(sidOf('r1', U.i)), j: await h.outOf(sidOf('r2', U.j)) };
  const kIn = (await h.inboxesOf(sidOf('r3', U.k)))[0];
  check(
    '（前提）验收 7 的 B：重启时入站停在 recorded、库里没有这一组的出站行',
    kIn?.state === 'recorded' && (await h.outOf(sidOf('r3', U.k))).length === 0,
    json({ kIn, out: await h.outOf(sidOf('r3', U.k)) }),
  );
  // spec：RESEND_UNKNOWN 经适配器的 __channelTest 在子进程里设（不在产品代码里留按环境变量触发的钩子）
  h.wecom.__channelTest.setResendUnknown(true);
  h.start();
  await h.settle();
  const oi = await h.outOf(sidOf('r1', U.i));
  const oj = await h.outOf(sidOf('r2', U.j));
  const uniq = (xs: SendLine[]): string[] => [...new Set(xs.map((x) => x.msgid))];
  check(
    'RESEND_UNKNOWN 为真 · 请求已到、回包挂住：重启时保持 sending、按同一 msgid 补发；假企微按 msgid 去重之后恰好一组',
    oi.length === 1 &&
      oi[0]!.status === 'accepted' &&
      h.sendsTo(U.i).length === 2 &&
      json(uniq(h.sendsTo(U.i))) === json([before.i[0]!.msgid]) &&
      h.llmCalls('I 想去云南') === 0,
    json({ oi, sent: h.sendsTo(U.i) }),
  );
  check(
    'RESEND_UNKNOWN 为真 · markSending 之后请求没到：重启时按同一 msgid 补发，客户收到恰好一组',
    oj.length === 1 &&
      oj[0]!.status === 'accepted' &&
      h.sendsTo(U.j).length === 1 &&
      h.sendsTo(U.j)[0]!.msgid === before.j[0]!.msgid &&
      h.llmCalls('J 想去西藏') === 0,
    json({ oj, sent: h.sendsTo(U.j) }),
  );
  // 有接手人的会话里 AI 产生的 sending 段：不补发、记 unknown（不变量 10）；通知照表补发
  const ol = await h.outOf(sidOf('r1', U.l));
  const lMsg = (await h.inboxesOf(sidOf('r1', U.l)))[0]!;
  const lReply = h.replyAfter(sidOf('r1', U.l), lMsg.msgid);
  check(
    'RESEND_UNKNOWN 为真 · 有接手人的会话里 AI 回复的 sending 段：不补发（假企微上仍只有杀之前那一次）、记 unknown、工作台「可能没送达」',
    ol.length === 1 &&
      ol[0]!.status === 'unknown' &&
      h.sendsTo(U.l).length === 1 &&
      h.sendsTo(U.l)[0]!.p === 'k2' &&
      !!lReply &&
      h.ledger.deliveryOf(sidOf('r1', U.l), lReply)?.status === 'unknown',
    json({ ol, sent: h.sendsTo(U.l) }),
  );
  const om = await h.outOf(sidOf('r1', U.m));
  check(
    'RESEND_UNKNOWN 为真 · 有接手人的会话里通知的 sending 段：照表按同一 msgid 补发（去重之后恰好一组）',
    om.length === 1 && om[0]!.status === 'accepted' && h.sendsTo(U.m).length === 2 && json(uniq(h.sendsTo(U.m))) === json([om[0]!.msgid]),
    json({ om, sent: h.sendsTo(U.m) }),
  );
  const unknownAlerts = h.alertLines().filter((l) => l.includes('停在「发送中」'));
  check(
    'RESEND_UNKNOWN 为真：「sending 转 unknown」的告警只算有接手人的会话里那一段 AI 回复（r1 1 段，r2 没有）',
    unknownAlerts.length === 1 && unknownAlerts[0]!.includes('企微账号 r1 重启时有 1 段') && !unknownAlerts[0]!.includes('企微账号 r2'),
    json(h.alertLines()),
  );
  // 验收 7 的 B：入站 recorded、引擎重新生成一组再发（多一组、msgid 不同）
  const ok = await h.outOf(sidOf('r3', U.k));
  const sentK = h.sendsTo(U.k);
  const kNow = (await h.inboxesOf(sidOf('r3', U.k)))[0];
  check(
    '验收 7 · B（commitOutbound 超时照发、结果没落库就杀）：重启后入站 recorded → 引擎重新生成一组再发：假企微上多一组、msgid 不同；入站 done',
    h.llmCalls('K-r6') === 1 &&
      ok.length >= 1 &&
      ok.every((x) => x.status === 'accepted') &&
      sentK.filter((x) => x.p === 'k2').length >= 1 &&
      sentK.filter((x) => x.p === 'r2').length === ok.length &&
      sentK.filter((x) => x.p === 'k2').every((x) => !ok.some((o) => o.msgid === x.msgid)) &&
      kNow?.state === 'done' &&
      (await h.customerRows(sidOf('r3', U.k), kNow.msgid))[0]?.n === '1',
    json({ ok, sentK, kNow, calls: h.llmCalls('K-r6') }),
  );
}

// ======================================================================================
// k3 → r3：验收 18 每一种没结果的出站行；恢复做完之前到期的跟进等恢复做完才发
// ======================================================================================

async function kill3(h: Harness): Promise<void> {
  h.start();
  await h.idle();
  const sid = (k: string, key = 'r1'): string => sidOf(key, k);
  for (const uid of [V.n, V.o, V.p, V.q, V.r, V.s, V.t, V.u, V.v, V.z, V.rc]) await h.mkSession('r1', uid);
  await h.mkSession('r3', V.w);
  const push = h.wecom.wecomAdapter.push.bind(h.wecom.wecomAdapter);
  const holds: [string, { reached: boolean }][] = [];
  const hold = (uid: string, key = 'r1'): void => void holds.push([uid, h.holdMark(sid(uid, key))]);
  hold(V.n);
  void push(sid(V.n), '您的订单已付款，我们会尽快为您安排', { kind: 'notice' });
  hold(V.o);
  const fuMsg: ChatMessage = { role: 'agent', content: '上次聊的行程还在考虑吗？', at: Date.now(), author: 'followup' };
  void push(sid(V.o), fuMsg.content, { kind: 'followup', message: fuMsg });
  for (const uid of [V.p, V.q, V.r]) {
    hold(uid);
    void h.tk.reply(sid(uid), h.tk.sharedActor(), `好的，我来跟进（${uid}）`, `c10-${uid}`).catch(() => undefined);
  }
  hold(V.s);
  void push(sid(V.s), '为了推荐更合适的行程，可以告诉我们同行人的健康情况吗？', { kind: 'menu', category: 'health' });
  hold(V.t);
  void push(sid(V.t), '欢迎回来～我是 AI 旅行顾问，需要真人服务时回复「人工」即可。', { kind: 'welcome' });
  hold(V.u);
  void push(sid(V.u), '抱歉，系统开小差了，请稍后再发一次，或直接联系人工顾问。', { kind: 'ai' });
  const vHold = h.holdSend(V.v, 'after');
  void push(sid(V.v), '顾问已确认收款，订单生效', { kind: 'notice' });
  hold(V.w, 'r3');
  void push(sid(V.w, 'r3'), '您的订单已付款', { kind: 'notice' });
  hold(V.rc);
  void push(sid(V.rc), '您的订单已付款', { kind: 'notice' });
  hold(V.tk);
  h.say('r1', V.tk, 'TK 想去黄山');
  hold(V.x);
  const xm = h.say('r1', V.x, 'X 想去海南');
  hold(V.y);
  h.say('r1', V.y, 'Y 想去桂林');
  h.pull('r1');
  for (const [uid, x] of holds) await reached(`${uid} 的 markSending`, x);
  await reached('V 的请求到了假企微', vHold);
  // TK：回复的分段落库之后、发出之前顾问接手（接手落库之后再杀）
  h.tk.takeover(sid(V.tk), h.tk.sharedActor());
  await h.store.flushSession(sid(V.tk));
  // RR、RO：直接造库里的状态（会话部分与入站行、出站行不同步的两种：R6、poisoned 之后的渠道短事务、spill 回放失败会留下）
  const crafted = async (uid: string, said: string, reply: string): Promise<{ msgid: string; customerSeq: number; replySeq: number }> => {
    const msgid = `m10k3-${uid}`;
    const s = h.store.getOrCreateSession(sid(uid), 'wecom');
    s.messages.push({ role: 'customer', content: said, at: Date.now(), msgid, sentAt: Date.now() });
    s.messages.push({ role: 'agent', content: reply, at: Date.now() });
    h.store.saveSession(s);
    await h.store.flushSession(sid(uid));
    const seqs = await h.su<{ seq: number; role: string }>('select seq, role from messages where conversation_id = $1 order by seq', [
      sid(uid),
    ]);
    return { msgid, customerSeq: seqs.find((x) => x.role === 'customer')!.seq, replySeq: seqs.find((x) => x.role === 'agent')!.seq };
  };
  const kfMsg = (uid: string, msgid: string, content: string): string =>
    json({
      msgid,
      open_kfid: acct('r1').kf,
      external_userid: uid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content },
    });
  const rr = await crafted(V.rr, 'RR 想去敦煌', '敦煌 4–10 月最合适～您几位出行？');
  await h.su(
    `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, sent_at, state, attempts, message_seq, payload)
     values ((select tenant_id from channel_accounts where id = $1), $1, $2, 'message', $3, now(), 'recorded', 1, $4, $5::json)`,
    [h.ids.get('r1'), rr.msgid, sid(V.rr), rr.customerSeq, kfMsg(V.rr, rr.msgid, 'RR 想去敦煌')],
  );
  const ro = await crafted(V.ro, 'RO 想去青海', '青海湖 7 月油菜花最好看～您几位出行？');
  const [roIn] = await h.su<{ id: string }>(
    `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, sent_at, state, payload)
     values ((select tenant_id from channel_accounts where id = $1), $1, $2, 'message', $3, now(), 'received', $4::json) returning id::text as id`,
    [h.ids.get('r1'), ro.msgid, sid(V.ro), kfMsg(V.ro, ro.msgid, 'RO 想去青海')],
  );
  await h.su(
    `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, message_seq, kind, sent_at, status, account_id, inbox_id, segment, payload)
     values ((select tenant_id from channel_accounts where id = $1), $2, $3, $4, 'ai', now(), 'pending', $1, $5, 0, $6::json)`,
    [
      h.ids.get('r1'),
      sid(V.ro),
      randomBytes(16).toString('hex'),
      ro.replySeq,
      roIn!.id,
      json({ msgtype: 'text', text: { content: '青海湖 7 月油菜花最好看～您几位出行？' } }),
    ],
  );
  // Q：建行时刻挪到 11 分钟前；R：交还 AI（接手人变了）；W：r3 的恢复截止点设在它之后；X：入站已结束；Z：一行 kind=card 的 pending
  await h.su(`update outbound_sends set sent_at = sent_at - interval '11 minutes' where conversation_id = $1`, [sid(V.q)]);
  h.tk.release(sid(V.r), h.tk.sharedActor());
  await h.store.flushSession(sid(V.r));
  await h.su(`update channel_accounts set record_only_until = now() where id = $1`, [h.ids.get('r3')]);
  await waitFor(async () => (await h.inboxOf(xm.msgid))?.state === 'replied');
  await h.su(`update channel_inbox set state = 'done', payload = null where msgid = $1`, [xm.msgid]);
  const [rcRow] = await h.outOf(sid(V.rc));
  await h.su(
    `insert into channel_inbox (tenant_id, account_id, msgid, kind, conversation_id, sent_at, state, payload)
     values ((select tenant_id from channel_accounts where id = $1), $1, 'm10k3-rcpt', 'send_fail', $2, now(), 'received', $3::json)`,
    [h.ids.get('r1'), sid(V.rc), json({ fail_msgid: rcRow?.msgid, fail_type: 4 })],
  );
  await h.su(
    `insert into outbound_sends (tenant_id, conversation_id, channel_msgid, kind, sent_at, status, account_id, segment, payload)
     values ((select tenant_id from channel_accounts where id = $1), $2, $3, 'card', now(), 'pending', $1, 0, $4::json)`,
    [h.ids.get('r1'), sid(V.z), randomBytes(16).toString('hex'), json({ msgtype: 'text', text: { content: '卡片' } })],
  );
  const rows = Object.fromEntries(
    await Promise.all(
      Object.entries(V)
        .filter(([k]) => k.length === 1)
        .map(async ([k, uid]) => [k, (await h.outOf(sid(uid, k === 'w' ? 'r3' : 'r1'))).map((x) => [x.kind, x.status])] as const),
    ),
  );
  const want = {
    n: [['notice', 'pending']],
    o: [['followup', 'pending']],
    p: [['human', 'pending']],
    q: [['human', 'pending']],
    r: [['human', 'pending']],
    s: [['menu', 'pending']],
    t: [['welcome', 'pending']],
    u: [['ai', 'pending']],
    v: [['notice', 'sending']],
    w: [['notice', 'pending']],
    x: [['ai', 'pending']],
    y: [['ai', 'pending']],
    z: [['card', 'pending']],
  };
  check('（前提）每一种没结果的出站行都在库里', json(rows) === json(want), json(rows));
}

async function restart3(h: Harness): Promise<void> {
  const sid = (k: string, key = 'r1'): string => sidOf(key, k);
  const before = Object.fromEntries(
    await Promise.all(Object.entries(V).map(async ([k, uid]) => [k, await h.outOf(sid(uid, k === 'w' ? 'r3' : 'r1'))] as const)),
  );
  // 恢复做完之前到期的跟进：沉默了 3 小时的报价会话，落库时排上跟进（02 的写法）
  process.env.FOLLOWUP_ENABLED = '1';
  const runner = await import('../jobs/runner.js');
  runner.__jobsTest.start((id, text, opts) => h.wecom.wecomAdapter.push(id, text, opts));
  const fuSid = sid(V.fu);
  {
    const s = h.store.getOrCreateSession(fuSid, 'wecom');
    s.stage = 'quote';
    s.messages.push(
      {
        role: 'customer',
        content: '这条线多少钱',
        at: Date.now() - 3 * H - 60_000,
        msgid: `q-${V.fu}`,
        sentAt: Date.now() - 3 * H - 60_000,
      },
      { role: 'agent', content: '这条线每人 19,800 元起，您几位出行？', at: Date.now() - 3 * H },
    );
    s.updatedAt = Date.now() - 3 * H;
    h.store.saveSession(s, false);
    await h.store.flushSession(fuSid);
  }
  const p2Sid = await h.mkSession('r1', V.p2);
  const jobs = await h.su<{ status: string }>(`select status from jobs where kind = 'followup' and payload->>'sessionId' = $1`, [fuSid]);
  check('（前提）跟进任务已排上', jobs.length === 1 && jobs[0]!.status === 'pending', json(jobs));
  // 恢复挂在 N 的补发上（请求到了假企微、回包挂住），这期间跟进到期、顾问发人工回复
  const nHold = h.holdSend(V.n, 'after');
  h.start();
  await reached('N 的补发到了假企微（恢复挂在这里）', nHold);
  const waitLines = (): number => logBuf.filter((l) => l.includes('启动恢复还没做完，这次推送排队等待')).length;
  const run = runner.runJobsOnce();
  await waitFor(() => waitLines() >= 1);
  await sleep(300);
  check(
    '验收 18 · 恢复做完之前到期的跟进：生成好了、推送排队等待，恢复没做完之前假企微上没有它的请求',
    waitLines() >= 1 && h.sendsTo(V.fu).length === 0 && h.wecom.__wecomTest.inspect(h.ids.get('r1')!)?.recovery === 'recovering',
    json({ waitLines: waitLines(), sends: h.sendsTo(V.fu) }),
  );
  // 等恢复超过上限（自测缩到 300 毫秒）：人工回复按没发出去处理（「未能发送」），它排进库的那一段取消
  h.wecom.__channelTest.setPushWaitMs(300);
  const r = await h.tk.reply(p2Sid, h.tk.sharedActor(), '稍等，我查一下', 'c10-p2');
  h.wecom.__channelTest.setPushWaitMs(null);
  check(
    '恢复超过等待上限：人工回复返回没发出去、会话记「未能发送」，假企微上没有它的请求',
    !r.sent &&
      h.sendsTo(V.p2).length === 0 &&
      !!h.store.getSession(p2Sid)?.messages.some((m) => m.role === 'system' && m.content === h.tk.REPLY_FAILED_NOTE),
    json({ r, last: h.store.getSession(p2Sid)?.messages.at(-1) }),
  );
  nHold.release();
  await run;
  await h.settle();
  const after = Object.fromEntries(
    await Promise.all(Object.entries(V).map(async ([k, uid]) => [k, await h.outOf(sid(uid, k === 'w' ? 'r3' : 'r1'))] as const)),
  );
  const st = (k: keyof typeof V): string => after[k]!.map((x) => x.status).join();
  const once = (k: keyof typeof V): boolean =>
    json(h.sendsTo(V[k]).map((x) => x.msgid)) === json(before[k]!.map((x) => x.msgid)) && h.sendsTo(V[k]).every((x) => x.p === 'r3');
  check('验收 18 · notice 的 pending：按同一 msgid 补发一次', st('n') === 'accepted' && once('n'), json({ n: after.n, s: h.sendsTo(V.n) }));
  check('验收 18 · followup 的 pending：cancelled、不发', st('o') === 'cancelled' && h.sendsTo(V.o).length === 0, json(after.o));
  check(
    '验收 18 · 人工回复，10 分钟内、接手人没变：按同一 msgid 补发一次',
    st('p') === 'accepted' && once('p'),
    json({ p: after.p, s: h.sendsTo(V.p) }),
  );
  for (const [k, label] of [
    ['q', '超过 10 分钟'],
    ['r', '接手人变了（交还 AI）'],
  ] as const) {
    const humanMsg = h.store.getSession(sid(V[k]))?.messages.find((m) => m.author === 'human');
    check(
      `验收 18 · 人工回复，${label}：cancelled、不发，工作台这条显示「未发送」`,
      st(k) === 'cancelled' &&
        h.sendsTo(V[k]).length === 0 &&
        !!humanMsg &&
        h.ledger.deliveryOf(sid(V[k]), humanMsg)?.status === 'cancelled',
      json({ rows: after[k], delivery: humanMsg ? h.ledger.deliveryOf(sid(V[k]), humanMsg) : null }),
    );
  }
  for (const [k, label] of [
    ['s', '同意菜单'],
    ['t', '欢迎语'],
    ['u', '没有 inbox_id 的 ai（异常道歉）'],
    ['x', '有 inbox_id、入站行已结束'],
    ['w', 'sent_at 不晚于恢复截止点'],
  ] as const) {
    const uid = V[k];
    check(`验收 18 · ${label}的 pending：cancelled、不发`, st(k) === 'cancelled' && h.sendsTo(uid).length === 0, json(after[k]));
  }
  check(
    '验收 18 · kind=card 的 pending（库里账号不该有）：cancelled、记一行日志',
    st('z') === 'cancelled' && logBuf.some((l) => l.includes('kind=card 的 pending')),
    json(after.z),
  );
  check(
    '验收 18 · sending：unknown、不补发（假企微上仍只有杀之前那一次），告警一条',
    st('v') === 'unknown' &&
      h.sendsTo(V.v).length === 1 &&
      h.sendsTo(V.v)[0]!.p === 'k3' &&
      h.alertLines().filter((l) => l.includes('企微账号 r1 重启时有 1 段停在「发送中」')).length === 1,
    json({ v: after.v, s: h.sendsTo(V.v), alerts: h.alertLines() }),
  );
  const tkIn = (await h.inboxesOf(sid(V.tk)))[0];
  check(
    '入站 replied、杀之前顾问接手：名下 pending 的段 cancelled、不发，会话记「本轮未发送」，入站 done（不变量 10）',
    after.tk!.length >= 1 &&
      st('tk')
        .split(',')
        .every((x) => x === 'cancelled') &&
      h.sendsTo(V.tk).length === 0 &&
      tkIn?.state === 'done' &&
      !!h.store.getSession(sid(V.tk))?.messages.some((m) => m.role === 'system' && m.content === h.tk.TAKEN_OVER_NOTE),
    json({ tk: after.tk, tkIn, sends: h.sendsTo(V.tk) }),
  );
  const rrIn = await h.inboxOf('m10k3-wm10rr');
  check(
    '入站 recorded、会话里这句之后已有 AI 回复：按那条回复切分段照常发一组、不调模型，入站 done',
    after.rr!.length >= 1 &&
      st('rr')
        .split(',')
        .every((x) => x === 'accepted') &&
      h.sendsTo(V.rr).length === after.rr!.length &&
      h.sendsTo(V.rr)[0]!.content.startsWith('敦煌 4–10 月最合适') &&
      h.llmCalls('RR 想去敦煌') === 0 &&
      rrIn?.state === 'done',
    json({ rr: after.rr, rrIn, sends: h.sendsTo(V.rr) }),
  );
  const roIn = await h.inboxOf('m10k3-wm10ro');
  check(
    '保底：入站 received 而名下已有 pending 的出站行，按 replied 处理：按同一 msgid 补发、不调模型，入站 done',
    st('ro') === 'accepted' && once('ro') && h.llmCalls('RO 想去青海') === 0 && roIn?.state === 'done',
    json({ ro: after.ro, roIn, sends: h.sendsTo(V.ro) }),
  );
  const rcpt = await h.inboxOf('m10k3-rcpt');
  check(
    '失败回执停在 received、指着一段 pending：出站恢复不补发，入站恢复重做回执短事务，那一段 failed、回执行 done',
    st('rc') === 'failed' && h.sendsTo(V.rc).length === 0 && rcpt?.state === 'done',
    json({ rc: after.rc, rcpt, s: h.sendsTo(V.rc) }),
  );
  check(
    '验收 18 · 有入站的 pending（入站没结束）：入站恢复按同一 msgid 补发一次，入站 done',
    st('y') === 'accepted' && once('y') && (await h.inboxesOf(sid(V.y)))[0]?.state === 'done',
    json({ y: after.y, s: h.sendsTo(V.y) }),
  );
  const fuJob = await h.su<{ status: string }>(`select status from jobs where kind = 'followup' and payload->>'sessionId' = $1`, [fuSid]);
  const all = lines<SendLine>(path.join(process.env.RECOVERY_DIR!, 'sends.jsonl'));
  const at = (uid: string): number => all.findIndex((x) => x.to === uid && x.p === 'r3');
  check(
    '验收 18 · 恢复做完之后跟进才发：在恢复补发的那几段之后到达假企微，任务 done',
    h.sendsTo(V.fu).length === 1 && at(V.fu) > at(V.n) && at(V.fu) > at(V.p) && fuJob[0]?.status === 'done',
    json({ fuJob, order: all.filter((x) => x.p === 'r3').map((x) => x.to) }),
  );
  const p2Rows = await h.outOf(p2Sid);
  check('恢复超过等待上限：那条人工回复排进库的那一段 cancelled', p2Rows.length === 1 && p2Rows[0]!.status === 'cancelled', json(p2Rows));
  const open = await h.su<{ n: string }>(`select count(*)::text as n from outbound_sends where status in ('pending', 'sending')`);
  check('重启之后库里没有 pending、sending 的出站行（不变量 15：每一行都给出了处理）', open[0]?.n === '0', json(open));
}

/** jsonl 文件的行（restart3 里核对先后用） */
function lines<T>(f: string): T[] {
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
}

// ======================================================================================
// k4 → p1 → p2 → p3 → p4：验收 3（一页提交之后立刻杀）、验收 9（每次处理都让进程崩溃的毒消息）
// ======================================================================================

async function kill4(h: Harness): Promise<void> {
  h.start();
  await h.idle();
  // 验收 3（r2）：假企微一页 3 条；acceptPage 提交之后、这一页回 has_more，紧接着的下一次 sync_msg 就地硬杀
  for (const [i, uid] of A3.entries()) h.say('r2', uid, `S${i + 1} 想去云南看看`);
  h.fake.killAfterPage = acct('r2').kf;
  h.pull('r2');
  await sleep(30_000);
  fails.push('k4：acceptPage 提交之后没有被杀');
}

async function poison1(h: Harness): Promise<void> {
  // 验收 3：重启之前库里是这一页的 3 行（received、attempts 0），cursor 已随它们推进
  const rows = await Promise.all(A3.map(async (uid) => (await h.inboxesOf(sidOf('r2', uid)))[0]));
  const [cur] = await h.su<{ cursor: string | null }>('select cursor from channel_accounts where key = $1', ['r2']);
  check(
    '验收 3 · acceptPage 提交之后立刻 SIGKILL：库里有这 3 行（received、attempts 0），cursor 已推进到这一页之后，还没有出站行',
    rows.every((r) => r?.state === 'received' && r.attempts === 0) &&
      cur?.cursor === `${acct('r2').kf}:3` &&
      (await Promise.all(A3.map((uid) => h.outOf(sidOf('r2', uid))))).every((o) => o.length === 0),
    json({ rows, cur }),
  );
  h.start();
  await h.settle();
  const after = await Promise.all(
    A3.map(async (uid) => ({ inbox: (await h.inboxesOf(sidOf('r2', uid)))[0], out: await h.outOf(sidOf('r2', uid)) })),
  );
  check(
    '验收 3 · 重启后这 3 条各回复一次：入站 done、attempts 1，每个客户在假企微上恰好一组、每段一次，各调一次模型',
    after.every(
      (x, i) =>
        x.inbox?.state === 'done' &&
        x.inbox.attempts === 1 &&
        x.out.length >= 1 &&
        x.out.every((o) => o.status === 'accepted') &&
        json(h.sendsTo(A3[i]!).map((s) => s.msgid)) === json(x.out.map((o) => o.msgid)) &&
        h.llmCalls(`S${i + 1} 想去云南`) === 1,
    ),
    json({ after, sends: A3.map((u) => h.sendsTo(u).length) }),
  );
  // 验收 9（r1）：客户先正常聊一句（会话建好），再在一页里发毒消息与第二句；毒消息处理到调模型就把进程带崩（第 1 次）
  h.say('r1', PZ, 'PZ0 你好');
  h.pull('r1');
  await h.settle();
  check('（前提）验收 9：客户先正常聊了一句，有回复', h.sendsTo(PZ).length >= 1 && !!h.store.getSession(sidOf('r1', PZ)));
  h.fake.model.push({ match: 'POISON', die: async () => {} });
  h.say('r1', PZ, 'POISON 每次都让进程崩溃的一句');
  h.say('r1', PZ, 'PZ2 两个人五天');
  h.pull('r1');
  await sleep(30_000);
}

/** 毒消息、第 n 次处理（重启之后由启动恢复派发）：计次 n 之后调模型、进程又崩；排在后面的第二句一直没出队 */
async function poisonAgain(h: Harness, n: number): Promise<void> {
  const [p, q] = await Promise.all([inboxOfText(h, 'POISON'), inboxOfText(h, 'PZ2 两个人')]);
  check(
    `验收 9 · 第 ${n - 1} 次重启之前：毒消息 attempts ${n - 1}、第二句 attempts 0、received（不受连累）`,
    p?.attempts === n - 1 && q?.attempts === 0 && q.state === 'received',
    json({ p, q }),
  );
  h.fake.model.push({
    match: 'POISON',
    die: async () => {
      const [p2, q2] = await Promise.all([inboxOfText(h, 'POISON'), inboxOfText(h, 'PZ2 两个人')]);
      check(
        `验收 9 · 第 ${n - 1} 次重启：毒消息出队、计次到 ${n} 之后再把进程带崩；第二句还没出队（attempts 0）`,
        p2?.attempts === n && q2?.attempts === 0,
        json({ p2, q2 }),
      );
    },
  });
  h.start();
  await sleep(30_000);
}

async function poison4(h: Harness): Promise<void> {
  const [p0, q0] = await Promise.all([inboxOfText(h, 'POISON'), inboxOfText(h, 'PZ2 两个人')]);
  check('（前提）验收 9 · 第三次重启之前：毒消息 attempts 3、第二句 0', p0?.attempts === 3 && q0?.attempts === 0, json({ p0, q0 }));
  h.start();
  await h.settle();
  const sid = sidOf('r1', PZ);
  const [p, q] = await Promise.all([inboxOfText(h, 'POISON', true), inboxOfText(h, 'PZ2 两个人', true)]);
  const notes = (h.store.getSession(sid)?.messages ?? []).filter((m) => m.role === 'system' && m.content === POISON_NOTE);
  check(
    '验收 9 · 第三次重启：毒消息出队时 attempts 已是 3 → abandoned（poison）、payload 已空，不再调模型；会话里多一条说明',
    p?.state === 'abandoned' && p.reason === 'poison' && p.attempts === 3 && p.nopay && h.llmCalls('POISON') === 0 && notes.length === 1,
    json({ p, notes: notes.length, calls: h.llmCalls('POISON') }),
  );
  const alerts = h.alertLines().filter((l) => l.includes('处理了三次都没走完'));
  check(
    '验收 9 · 告警一条：账号 key 与条数，没有 external_userid',
    alerts.length === 1 && alerts[0]!.includes('企微账号 r1 有 1 条客户消息') && !alerts[0]!.includes(PZ),
    json(h.alertLines()),
  );
  const qOut = await h.su<{ msgid: string; status: string }>(
    'select channel_msgid as msgid, status from outbound_sends where inbox_id = $1',
    [q!.id],
  );
  check(
    '验收 9 · 排在它后面、同一客户的第二句不受连累：attempts 1、done、回复一组（调一次模型）',
    q?.state === 'done' &&
      q.attempts === 1 &&
      qOut.length >= 1 &&
      qOut.every((o) => o.status === 'accepted') &&
      h.llmCalls('PZ2 两个人') === 1,
    json({ q, qOut }),
  );
  // 之后的消息照常处理
  h.say('r1', PZ, 'PZ3 之后再问一句');
  h.pull('r1');
  await h.settle();
  const r = await inboxOfText(h, 'PZ3 之后再问', true);
  const rOut = r ? await h.su<{ status: string }>('select status from outbound_sends where inbox_id = $1', [r.id]) : [];
  check(
    '验收 9 · 之后的消息照常处理：done、attempts 1、回复一组；毒消息从头到尾没有回复（假企微上这个客户只有 PZ0、PZ2、PZ3 三组）',
    r?.state === 'done' &&
      r.attempts === 1 &&
      rOut.length >= 1 &&
      rOut.every((o) => o.status === 'accepted') &&
      h.sendsTo(PZ).length ===
        (await h.su<{ n: string }>(`select count(*)::text as n from outbound_sends where conversation_id = $1`, [sid])).map((x) =>
          Number(x.n),
        )[0],
    json({ r, rOut, sends: h.sendsTo(PZ).length }),
  );
}

/** 毒消息那个客户的入站行（按原文找：入站行 payload 在结束之后清空，结束的按 msgid 找回） */
async function inboxOfText(
  h: Harness,
  text: string,
  withPayloadGone = false,
): Promise<{ id: string; msgid: string; state: string; attempts: number; reason: string | null; nopay: boolean } | null> {
  const known = pzMsgids.get(text);
  const rows = await h.su<{
    id: string;
    msgid: string;
    state: string;
    attempts: number;
    reason: string | null;
    nopay: boolean;
    said: string | null;
  }>(
    `select id::text as id, msgid, state, attempts, reason, payload is null as nopay, payload->'text'->>'content' as said
       from channel_inbox where conversation_id = $1 order by ord`,
    [sidOf('r1', PZ)],
  );
  const row = rows.find((r) => (known ? r.msgid === known : (r.said ?? '').includes(text)));
  if (row && !known) pzMsgids.set(text, row.msgid);
  if (!row && withPayloadGone) {
    // 结束之后 payload 清空：按会话里记下的客户消息原文找 msgid
    const [m] = await h.su<{ msgid: string }>(
      `select msgid from messages where conversation_id = $1 and role = 'customer' and content like $2 order by seq limit 1`,
      [sidOf('r1', PZ), `%${text}%`],
    );
    const hit = m ? rows.find((r) => r.msgid === m.msgid) : undefined;
    if (hit) return hit;
  }
  return row ?? null;
}
