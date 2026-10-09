// 消息 seq 的同步分配与窗口校验（docs/architecture/02-conversations-workbench/spec.md「identity map 与写入 · seq 分配」），
// 两种后端共用。纯函数：不 import 库、store、引擎、工具、模型与渠道（scripts/check-boundaries.ts 守）。
// seq 记在模块内的 WeakMap 里，不往消息对象上加字段：消息对象原样序列化进 sessions.json 与会话的 state。
import type { ChatMessage, Session } from '../types.js';

/** 严格模式下消息数组错位：中间删除或插入、末尾删除、整体换成副本。db 存储下这个会话标成 poisoned */
export class WindowCorruptError extends Error {
  constructor(
    readonly sessionId: string,
    readonly detail: string,
  ) {
    super(`会话的消息数组错位：${detail}`);
  }
}

interface SeqState {
  /** 这个会话分配过的最大 seq，没分配过为 0 */
  last: number;
  /** 内存窗口第一条的 seq；窗口为空时等于 last + 1 */
  windowStart: number;
}

const seqs = new WeakMap<ChatMessage, number>();
const states = new WeakMap<Session, SeqState>();
const resets = new WeakSet<Session>();

const stateOf = (s: Session): SeqState => states.get(s) ?? { last: 0, windowStart: 1 };

/** 旧数据可能是畸形的（没有 messages、数组里有 null）：跳过它们，与开工时「碰到才出错、不在导入期崩」一致 */
const isMsg = (m: unknown): m is ChatMessage => typeof m === 'object' && m !== null;

/** 消息的 seq；还没分配过的返回 undefined */
export function seqOf(m: ChatMessage): number | undefined {
  return seqs.get(m);
}

// 消息所属的轮次（02 spec「逐轮 trace」：AI 回复消息经 WeakMap 关联 turnId，落库进 messages.turn_id）。与 seq 一样不往对象上加字段
const turns = new WeakMap<ChatMessage, string>();

/** 这条消息是哪一轮 trace 的回复；没关联过的返回 undefined */
export function turnIdOf(m: ChatMessage): string | undefined {
  return turns.get(m);
}

/** 把消息关联到一轮 trace（recorder 的 endTurn、PG 预载按 turn_id 列重建时调）。冻结的消息也行 */
export function linkTurn(m: ChatMessage, turnId: string): void {
  turns.set(m, turnId);
}

/** 会话分配过的最大 seq（没分配过为 0） */
export function lastSeqOf(s: Session): number {
  return stateOf(s).last;
}

/** 内存窗口第一条消息的 seq；窗口为空时等于 lastSeqOf + 1 */
export function windowStartOf(s: Session): number {
  return stateOf(s).windowStart;
}

/**
 * 装载时给窗口里已有的消息依次记上 firstSeq、firstSeq + 1 …；分配过的最大 seq 记为最后一条（窗口为空时为 firstSeq - 1）。
 * 文件存储读 JSON 时 firstSeq = 1（seq 只在本进程有效）；PG 预载时是库里的 window_start_seq（窗口内的 seq 连续，不变量 4）
 */
export function seedSeqs(s: Session, firstSeq = 1): void {
  if (!Number.isInteger(firstSeq) || firstSeq < 1) throw new RangeError(`firstSeq 必须是正整数：${firstSeq}`);
  const msgs = Array.isArray(s.messages) ? s.messages.filter(isMsg) : [];
  msgs.forEach((m, i) => seqs.set(m, firstSeq + i));
  states.set(s, { last: firstSeq + msgs.length - 1, windowStart: firstSeq });
}

/**
 * 重置口令清空消息之前调：下一次严格模式的分配看到「窗口里原有的消息全没了」时，认作重置推进窗口，不当成整体换成副本。
 * 只影响下一次 assignSeqs
 */
export function noteWindowReset(s: Session): void {
  resets.add(s);
}

/**
 * 同步、幂等。给 session.messages 尾部还没有 seq 的消息依次分配「分配过的最大 seq + 1 …」，返回本次新分配的消息。
 *
 * strict（db 存储下的真实会话）：已有 seq 的消息必须是数组开头连续的一段，seq 逐条加 1，最后一条等于分配过的最大 seq，
 * 第一条不早于上次的窗口起点；窗口里原有的消息全没了，只有先调过 noteWindowReset 才算重置。否则抛 WindowCorruptError：
 * 中间删除或插入、末尾删除（删掉再 push 同一句，库里就会多一条）、整体换成副本（副本在 WeakMap 里查不到 seq）。
 * 头部被裁掉（裁剪）与重置都只体现为窗口起点的推进。
 *
 * lenient（文件存储与 demo 类会话）：不抛，只给最后一条有 seq 的消息之后那段分配；锁定自测里整体替换 messages 的写法照旧可用
 */
export function assignSeqs(s: Session, mode: 'strict' | 'lenient' = 'strict'): ChatMessage[] {
  if (!Array.isArray(s.messages)) return [];
  const msgs = s.messages.filter(isMsg);
  const st = stateOf(s);
  const reset = resets.delete(s);
  let k = 0;
  while (k < msgs.length && seqs.has(msgs[k])) k++;
  if (mode === 'strict') {
    const corrupt = (detail: string) => new WindowCorruptError(s.id, detail);
    for (let i = k; i < msgs.length; i++) {
      if (seqs.has(msgs[i])) throw corrupt(`第 ${i + 1} 条已有 seq ${seqs.get(msgs[i])}，却排在没分配过的消息后面`);
    }
    for (let i = 1; i < k; i++) {
      const prev = seqs.get(msgs[i - 1])!;
      const cur = seqs.get(msgs[i])!;
      if (cur !== prev + 1) throw corrupt(`seq ${prev} 后面接的是 ${cur}（中间删除或插入）`);
    }
    if (k > 0) {
      const first = seqs.get(msgs[0])!;
      const tail = seqs.get(msgs[k - 1])!;
      if (tail !== st.last) throw corrupt(`已有 seq 的最后一条应是 ${st.last}，实际是 ${tail}（末尾的消息被删掉了）`);
      if (first < st.windowStart) throw corrupt(`窗口起点从 ${st.windowStart} 退回到 ${first}`);
    } else if (st.windowStart <= st.last && !reset) {
      throw corrupt(`窗口里原有的 ${st.last - st.windowStart + 1} 条消息全不见了（整体换成了副本？）`);
    }
  }
  let from = k;
  if (mode === 'lenient') {
    let j = msgs.length - 1;
    while (j >= 0 && !seqs.has(msgs[j])) j--;
    from = j + 1;
  }
  const fresh = msgs.slice(from);
  let last = st.last;
  for (const m of fresh) seqs.set(m, ++last);
  const head = msgs.length ? seqs.get(msgs[0]) : undefined;
  states.set(s, { last, windowStart: head ?? last + 1 });
  return fresh;
}
