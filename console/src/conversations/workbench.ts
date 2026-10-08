// 会话工作台（J 页）的纯逻辑（02 spec「后台页面 · 会话工作台（J 页）」「后台接口」，设计系统 §6.7、§10.0、§10.2 J 页）。
// 不依赖 React，workbench.selftest.tsx 直接 import。界面代码不认行业：阶段名取自行业包；会话状态只经 conversationState 判定；
// 不读 handedOver、不拿 stage 跟 'paid' 比（scripts/check-console-src.ts 不变量 17）——用 src/shared/conversation.ts 的
// paidNeedsHuman 分辨「已成交客户要人工」。
import type { ConversationCounts, ConversationRow, ConversationState, MessageView, Role } from '../../../src/shared/console-api.js';
import { conversationState, paidNeedsHuman, shortIdOf } from '../../../src/shared/conversation.js';
import {
  type OrderStatus,
  QUOTA_EXHAUSTED_TEXT,
  type SendWindow,
  sendFailText,
  WINDOW_CLOSED_TEXT,
} from '../../../src/shared/conversation-types.js';
import { absoluteTime, clockTime, dateText, money, relativeTime } from '../../../src/shared/format.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { STATUS_LABEL } from '../parts/Status.js';
import { conversationLabel, workbenchPath } from '../shell/model.js';
import { stageLabel } from './model.js';

const MINUTE = 60_000;

/** 等人接手的等待时长达到这么久用 danger 字，否则 warning（设计系统 J 页列表「≥10 分钟 danger 字，否则 warning 字」） */
export const WAIT_DANGER_MS = 10 * MINUTE;

// ---------------- 左栏：分组列表 ----------------

/** 分组的顺序（设计系统 J 页：等人接手、顾问处理中、AI接待中、已成交），没有会话的组不画 */
export const WB_GROUP_ORDER: readonly ConversationState[] = ['human', 'assigned', 'ai', 'paid'];

export interface WbRow {
  id: string;
  /** 「企微客户」「F01」，带 needSummary 时再加一段（与 I 页首列同一条写法） */
  label: readonly string[];
  state: ConversationState;
  /** 第二行中段：等人接手「原因：…」、顾问处理中「接手人：…」、已成交客户要人工「要人工：…」、其余「停在：{阶段}」 */
  context: string;
  /** 右对齐的时间：等人接手是等待时长，其余是最后动静的相对时间 */
  time: string;
  timeFull: string;
  /** 等人接手的行总是上色（≥10 分钟 danger，否则 warning）；其余行不上色 */
  timeTone: 'warning' | 'danger' | null;
  href: string;
  selected: boolean;
}

/** 行的上下文文案（第二行中段），见 WbRow.context 的规则 */
export function wbContext(row: ConversationRow, pack: IndustryPack, state: ConversationState): string {
  if (state === 'human') return `原因：${row.handoff?.reason ?? '—'}`;
  if (state === 'assigned') return `接手人：${row.assignee?.name ?? '—'}`;
  if (state === 'paid' && paidNeedsHuman(row, pack)) return `要人工：${row.handoff?.reason ?? '—'}`;
  return `停在：${stageLabel(pack, row.stage)}`;
}

export function wbRow(row: ConversationRow, pack: IndustryPack, now: number, selectedId: string | null): WbRow {
  const state = conversationState(row, pack);
  const waiting = state === 'human' && row.handoff !== null;
  const at = waiting ? row.handoff!.at : row.updatedAt;
  const waitMs = waiting ? now - Date.parse(row.handoff!.at) : null;
  return {
    id: row.id,
    label: row.needSummary ? [...conversationLabel(row, pack), row.needSummary] : conversationLabel(row, pack),
    state,
    context: wbContext(row, pack, state),
    time: relativeTime(at, now),
    timeFull: absoluteTime(at, now),
    timeTone: waiting ? (waitMs !== null && waitMs >= WAIT_DANGER_MS ? 'danger' : 'warning') : null,
    href: workbenchPath(row.id),
    selected: row.id === selectedId,
  };
}

export interface WbGroup {
  state: ConversationState;
  label: string;
  /** 组标题的计数：取同一次 counts 响应（没取到时退回这个组里已经取到的行数） */
  count: number;
  /** 「等人接手」用软徽标 */
  soft: boolean;
  rows: WbRow[];
}

/** 分组列表：按 WB_GROUP_ORDER 排，组里的会话顺序沿用接口给的顺序（order=waiting_first）。没有会话的组不画 */
export function wbGroups(
  items: readonly ConversationRow[],
  counts: ConversationCounts | undefined,
  pack: IndustryPack,
  now: number,
  selectedId: string | null,
): WbGroup[] {
  const rows = items.map((r) => wbRow(r, pack, now, selectedId));
  return WB_GROUP_ORDER.flatMap((state) => {
    const rowsOfState = rows.filter((r) => r.state === state);
    if (rowsOfState.length === 0) return [];
    return [
      {
        state,
        label: STATUS_LABEL[state],
        count: counts?.byState[state] ?? rowsOfState.length,
        soft: state === 'human',
        rows: rowsOfState,
      },
    ];
  });
}

/** 读屏念的一行：「企微客户 F01，等人接手」 */
export const wbRowAria = (r: WbRow): string => `${r.label.join(' ')}，${STATUS_LABEL[r.state]}`;

// ---------------- 对话头：等待时长、「更多」 ----------------

/**
 * 对话头的等待时长（只在等人接手时有）：与列表同一条规则，不带「等了」字样（与 I 页、Bell 一致，见 plan 实施记录的取舍）。
 * urgent 而不叫 danger：对象字面量里的 danger 键只能出现在 ConfirmDanger.tsx（scripts/check-console-src.ts 不变量 3）
 */
export function headWait(handoffAt: string, now: number): { text: string; full: string; urgent: boolean } {
  const ms = now - Date.parse(handoffAt);
  return { text: relativeTime(handoffAt, now), full: absoluteTime(handoffAt, now), urgent: ms >= WAIT_DANGER_MS };
}

// ---------------- 交接卡 ----------------

export interface HandoffCardLike {
  kind: string;
  assigneeName: string | null;
}

/**
 * 交接卡第一行（02 spec「后台页面」：agent 有接手人写「{姓名}接手」、没有接手人写「共享工作台转人工」，
 * emergency 写「紧急情况 · AI交给人工」并用 danger 色；其余写「AI交给人工」）。时间由调用方拼在后面。
 * urgent 而不叫 danger（同 headWait，scripts/check-console-src.ts 不变量 3）
 */
export function handoffCardHead(h: HandoffCardLike): { text: string; urgent: boolean } {
  if (h.kind === 'emergency') return { text: '紧急情况 · AI交给人工', urgent: true };
  if (h.kind === 'agent') return { text: h.assigneeName ? `${h.assigneeName}接手` : '共享工作台转人工', urgent: false };
  return { text: 'AI交给人工', urgent: false };
}

// ---------------- 消息：handoff_note 时间线、送达说明 ----------------

/** handoff_note 的原因：原文冒号之后的部分（到换行为止，departNote 另起一行附在后面，不进时间线） */
export function handoffNoteReason(text: string): string {
  const firstLine = text.split('\n')[0] ?? text;
  const i = firstLine.search(/[:：]/);
  return (i >= 0 ? firstLine.slice(i + 1) : firstLine).trim();
}

/**
 * handoff_note 渲染成的时间线行：「AI交给人工 · 14:18 · 原因：…」。返回数组给 cjk() 用，由它插入 Sep（界面上是「·」，
 * 读屏念「，」），不在字符串里手写「·」
 */
export function handoffNoteLine(text: string, at: string): readonly string[] {
  return ['AI交给人工', clockTime(at), `原因：${handoffNoteReason(text)}`];
}

/** 这条消息是不是 author='human' 且带姓名：气泡标「顾问 · {姓名}」 */
export const advisorLabel = (name: string | null): string => `顾问 · ${name ?? '—'}`;

/** 发送失败或结果不明的消息下写的原因（02 spec「后台页面」）：unknown／rejected 是前端的固定说明，failed 复用 sendFailText */
export function deliveryNote(d: MessageView['delivery']): string | null {
  if (!d) return null;
  if (d.status === 'failed') return d.failType != null ? sendFailText(d.failType) : '这条没送达';
  if (d.status === 'rejected') return '这条没送达（企微拒收）';
  if (d.status === 'unknown') return '结果不明，可能已经送达';
  return null;
}

/** 护栏改写对照的那一行文字：「AI原稿里删了N句 · 展开/收起」；只删不增、只增不删都照写。返回数组给 cjk() 用 */
export function guardLine(g: { removed: number; added: number }, expanded: boolean): readonly string[] {
  const lead = g.removed > 0 ? `AI原稿里删了${g.removed}句` : g.added > 0 ? `AI原稿里改了${g.added}处` : 'AI原稿改过';
  return [lead, expanded ? '收起' : '展开'];
}

/** 「显示AI步骤」打开后插的那一行：「查了线路 · 报了价」，没有步骤时不插。返回数组给 cjk() 用 */
export function stepsLine(steps: readonly { label: string }[]): readonly string[] | null {
  return steps.length ? steps.map((s) => s.label) : null;
}

// ---------------- 发送窗口 ----------------

/** 今天／明天／更早的时刻（企微窗口关闭时刻用，与 relativeTime 的过去时态分开写，这是将来时） */
export function futureDayClock(at: number, now: number): string {
  const a = new Date(at);
  const n = new Date(now);
  const clock = clockTime(at);
  if (a.toDateString() === n.toDateString()) return `今天${clock}`;
  const tomorrow = new Date(n);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (a.toDateString() === tomorrow.toDateString()) return `明天${clock}`;
  return absoluteTime(at, now);
}

export interface SendWindowView {
  /** 能发（剩余 > 0 且窗口未过）；为 false 时 reason 给出禁用说明，输入框要禁用 */
  canSend: boolean;
  /** 还能发几条 · 窗口到几时（canSend 时有，给 cjk() 用的数组） */
  text: readonly string[] | null;
  /** 禁用原因（!canSend 时有，取 ERROR_COPY 同一句固定文案） */
  reason: string | null;
}

/** 输入框下方那一行（02 spec：「还能发3条 · 窗口到明天14:18」；剩 0 条或窗口已过写明原因并禁用）。
 * sendWindow 为 null（非企微渠道）时不显示这一行，也不因为它禁用输入框 */
export function sendWindowView(w: SendWindow | null, now: number): SendWindowView | null {
  if (!w || w.closesAt === null) return null;
  const expired = now >= w.closesAt;
  if (expired) return { canSend: false, text: null, reason: WINDOW_CLOSED_TEXT };
  if (w.remaining <= 0) return { canSend: false, text: null, reason: QUOTA_EXHAUSTED_TEXT };
  return { canSend: true, text: [`还能发${w.remaining}条`, `窗口到${futureDayClock(w.closesAt, now)}`], reason: null };
}

// ---------------- 订单 ----------------

export const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  pending_payment: '待付款',
  paid: '已付款',
  cancelled: '已取消',
  superseded: '已失效',
};

/** 右栏「订单与付款」卡一行：线路、人数共多少钱、出发日期。返回数组给 cjk() 用 */
export function orderLine(o: { routeTitle: string; travelers: number; totalPrice: number; departDate: string }): readonly string[] {
  return [o.routeTitle, `${o.travelers}位共${money(o.totalPrice)}`, o.departDate ? `${o.departDate}出发` : null].filter(
    (p): p is string => !!p,
  );
}

export { shortIdOf };

// ---------------- 对话头、「更多」：能不能处理会话 ----------------

/** 能处理会话的角色（与权限表、服务端 canHandle 同一组），只给 UI 决定要不要画「接手会话」这类按钮用；
 * 真正的权限判断在 ConversationDetail.can（服务端算好）*/
export const CAN_HANDLE_ROLES: ReadonlySet<Role> = new Set(['owner', 'admin', 'supervisor', 'agent']);

// ---------------- 右栏：需求 ----------------

/**
 * 「需求」卡要素的类型，与 ConversationDetail.need 结构相同：这里另写一份（不用 ConversationDetail['need'] 这种类型位置的
 * 字符串索引），因为 'quote' 这类键名可能撞上某个行业包的词（scripts/check-console-src.ts 不变量 11 也查类型位置）
 */
export interface NeedLike {
  destination: string | null;
  segment: string | null;
  travelers: string | null;
  dates: string | null;
  budget: string | null;
}

/**
 * 需求要素拼成一行（设计系统 J 页右栏「需求」卡）：目的地、人数（客群）、出行日期、预算，取不到的写「没说」。
 * 不写「目的地」「预算」这类标签——它们恰好是某个行业包的字段名（不变量 11），跟 needSummary 一样只拼规范化的取值本身。
 * 返回数组给 cjk() 用，由它插入 Sep
 */
export function needLine(need: NeedLike, now: number): readonly string[] {
  const travelSeg =
    need.travelers && need.segment ? `${need.travelers}（${need.segment}）` : (need.travelers ?? need.segment ?? '没说人数');
  const depart = need.dates ? `${dateText(need.dates, now)}出发` : '没问到出行时间';
  return [need.destination ?? '没问到目的地', travelSeg, depart, need.budget ? `预算：${need.budget}` : '预算没说'];
}

/** 「最近报价」卡要素的类型，理由同 NeedLike */
export interface QuoteLike {
  routeTitle: string;
  travelers: number;
  perPerson: number | null;
  total: number | null;
  departDate: string | null;
}

/**
 * 最近报价拼成一行（右栏「最近报价」卡）：线路、单价、总价、出发日期。ConversationDetail.quote 没有打折说明这类字段，
 * 只显示接口给的几项（设计系统样张里的「11月不在最佳季，4位95折」是报价工具当时的提示文字，不在这个投影里，J 页不重算）。
 * 返回数组给 cjk() 用
 */
export function quoteLine(q: QuoteLike): readonly string[] {
  return [
    q.routeTitle,
    q.perPerson != null ? `每人${money(q.perPerson)}` : null,
    q.total != null ? `${q.travelers}位共${money(q.total)}` : null,
    q.departDate ? `${q.departDate}出发` : null,
  ].filter((p): p is string => !!p);
}
