import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { AgentReply, Order } from '../../src/types.js';
import type { FinishedTurn, GuardEvent } from '../../src/trace/recorder.js';
import type { CaseResult } from './run.js';
import { normalize } from './values.js';

export interface TurnObservation {
  text: string;
  silent: boolean;
  handoff: boolean;
  stage: AgentReply['stage'];
  tools: string[];
  orders: { count: number; last: Record<string, unknown> | null };
  guard_events: Omit<GuardEvent, 'at'>[];
}
interface TextDigest {
  sha256: string;
  head: string;
}
export interface CaseSnapshot {
  id: string;
  turns: (Omit<TurnObservation, 'text'> & { text: TextDigest })[];
}
export interface V2Snapshot {
  version: 1;
  cases: CaseSnapshot[];
}

// 客户正文与护栏摘要走同一规则。只替换本轮实际观测到的运行量，
// 不泛匹配日期/数字，避免把出发日、人数、金额或业务条目 id 的变化藏掉。
// ord_… 与 ?v=N/&v=N 沿用 values.ts；sessionId/turnId/订单引用按精确值替换；
// 实际记录的毫秒时刻及其完整 ISO 表示归一，日期字符串（如 departDate）保留。
export function observeTurn(reply: AgentReply, handoff: boolean, orders: Order[], finished: FinishedTurn): TurnObservation {
  const replacements = new Map<string, string>([
    [finished.turn.conversationId, 'SESSION_NORMALIZED'],
    [finished.turn.turnId, 'TURN_NORMALIZED'],
  ]);
  for (const order of orders) {
    replacements.set(order.id, 'ord_NORMALIZED');
    if (order.supersededBy) replacements.set(order.supersededBy, 'ord_NORMALIZED');
  }
  const times = [
    finished.turn.startedAt,
    ...finished.turn.guards.map((g) => g.at),
    ...orders.flatMap((o) => [o.createdAt, o.paidAt, o.confirmedAt]),
  ];
  for (const time of times) {
    if (time === undefined) continue;
    replacements.set(String(time), 'TIME_NORMALIZED');
    replacements.set(new Date(time).toISOString(), 'TIME_NORMALIZED');
  }
  const text = (s: string): string => {
    for (const [value, replacement] of [...replacements].toSorted(([a], [b]) => b.length - a.length)) {
      if (value) s = s.replaceAll(value, replacement);
    }
    return normalize(s);
  };
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, normalizeValue(v)]));
    return value;
  };
  const last = orders.at(-1);
  // catalogVersion 是配置源元数据（文件没有版本，DB 有条目版本），不是订单业务字段。
  // 其余业务字段全部保留；supersededBy 保留是否有替代订单，引用值归一。
  const ignored = new Set(['id', 'sessionId', 'createdAt', 'paidAt', 'confirmedAt', 'catalogVersion']);
  return {
    text: text(reply.text),
    silent: !!reply.silent,
    handoff,
    stage: reply.stage,
    tools: finished.turn.calls.map((c) => c.name),
    orders: {
      count: orders.length,
      last: last
        ? (normalizeValue(Object.fromEntries(Object.entries(last).filter(([key]) => !ignored.has(key)))) as Record<string, unknown>)
        : null,
    },
    // recorder 的 removed/added 已是每句最多 200 字的摘要；存归一后的原摘要，
    // 保留顺序与重复句，失败时能直接看出差别，无须对护栏文本再做哈希。
    guard_events: finished.turn.guards.map(({ guard, action, removed, added }) => ({
      guard,
      action,
      removed: removed.map(text),
      added: added.map(text),
    })),
  };
}

function digest(text: string): TextDigest {
  return { sha256: createHash('sha256').update(text).digest('hex'), head: [...text].slice(0, 40).join('') };
}

export function createSnapshot(results: CaseResult[]): V2Snapshot {
  const ids = new Set<string>();
  return {
    version: 1,
    cases: results
      .map((r) => {
        if (!r.pass || !r.observations) throw new Error(`[${r.id}] 用例失败或缺少观测，不写快照`);
        if (ids.has(r.id)) throw new Error(`[${r.id}] 重复 case id，不写快照`);
        ids.add(r.id);
        return { id: r.id, turns: r.observations.map(({ text, ...t }) => ({ ...t, text: digest(text) })) };
      })
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** 所有层级的对象键排序，数组的业务顺序保留；固定两空格和末尾换行。 */
export async function serializeSnapshot(snapshot: V2Snapshot): Promise<string> {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sorted(x)]),
      );
    return v;
  };
  // 复用已固定版本的仓库格式器，生成的文件也直接通过 format:check。
  // 只在写快照/自测时加载，不进入 worker 的观测与默认比对路径。
  const { format } = await import('oxfmt');
  const { code, errors } = await format('snapshot.json', JSON.stringify(sorted(snapshot), null, 2), {
    printWidth: 140,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
  });
  if (errors.length) throw new Error('v2 快照序列化失败');
  return code;
}

export function readBaseline(setting = process.env.EVAL_V2_BASELINE): V2Snapshot | undefined {
  if (setting === 'off') return undefined;
  const target = setting ?? new URL('../baselines/v2-pre04.json', import.meta.url);
  if (setting === undefined && !fs.existsSync(target)) return undefined;
  const data = JSON.parse(fs.readFileSync(target, 'utf8')) as V2Snapshot;
  if (data.version !== 1 || !Array.isArray(data.cases)) throw new Error('v2 快照格式错误（需要 version: 1 与 cases 数组）');
  const ids = new Set<string>();
  for (const c of data.cases) {
    if (typeof c.id !== 'string' || !Array.isArray(c.turns) || ids.has(c.id)) throw new Error('v2 快照 case 格式错误或 id 重复');
    ids.add(c.id);
  }
  return data;
}

/** 按字段报差异；正文哈希不同则打印快照的前缀/哈希与本次完整归一正文。 */
export function compareCaseSnapshot(result: CaseResult, expected?: CaseSnapshot): string[] {
  const failures: string[] = [];
  const fail = (turn: number, field: string, before: unknown, after: unknown) => {
    failures.push(`[${result.id}] 第${turn}轮 snapshot.${field}: 快照 ${JSON.stringify(before)}；当前 ${JSON.stringify(after)}`);
  };
  if (!expected) {
    fail(0, 'case', '缺少 case', result.id);
    return failures;
  }
  const actual = result.observations ?? [];
  if (actual.length !== expected.turns.length) fail(0, 'turns.length', expected.turns.length, actual.length);
  const compare = (before: unknown, after: unknown, field: string, turn: number): void => {
    if (Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) fail(turn, `${field}.length`, before.length, after.length);
      for (let i = 0; i < Math.min(before.length, after.length); i++) compare(before[i], after[i], `${field}.${i}`, turn);
    } else if (before && after && typeof before === 'object' && typeof after === 'object') {
      const a = before as Record<string, unknown>;
      const b = after as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].toSorted()) compare(a[key], b[key], `${field}.${key}`, turn);
    } else fail(turn, field, before, after);
  };
  for (let i = 0; i < Math.min(expected.turns.length, actual.length); i++) {
    const { text: before, ...a } = expected.turns[i];
    const { text: after, ...b } = actual[i];
    if (before.sha256 !== digest(after).sha256 || before.head !== digest(after).head) fail(i + 1, 'text', before, after);
    for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].toSorted())
      compare(Reflect.get(a, field), Reflect.get(b, field), field, i + 1);
  }
  return failures;
}
