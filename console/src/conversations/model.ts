// 会话列表（I 页）的纯逻辑（spec「逐页设计 · 会话列表（I 页）」，设计系统 §5.5、§5.6、§6.7、§10.2 I 页）：
// 页签、阶段条的去向、接口的查询参数、表格每一行写什么。不依赖 React，conversations.selftest.tsx 直接 import。
// - 页签与阶段条的数都取同一次 counts 响应（不变量 18）；会话状态只经 conversationState 判定（不变量 17）；
// - 阶段名和顺序来自行业包（不变量 11），渠道与客户的叫法同外壳（conversationLabel）；
// - 今天只有接口里的 6 个字段：不写昵称、需求、最后一句话、转人工原因、等待时长。「最后动静」就是 updatedAt
import type { ConversationCounts, ConversationRow, ConversationState } from '../../../src/shared/console-api.js';
import { absoluteTime, relativeTime } from '../../../src/shared/format.js';
import { conversationState } from '../../../src/shared/conversation.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import type { ConversationsSearch } from '../conversations-search.js';
import { STATUS_LABEL } from '../parts/Status.js';
import { conversationLabel, workbenchHref } from '../shell/model.js';

/** 每页 20 条（设计系统 §5.5 分页器） */
export const PAGE_SIZE = 20;

// ---------------- 页签 ----------------

export type TabKey = 'all' | ConversationState;

export interface Tab {
  key: TabKey;
  label: string;
  /** counts 还没回来或没取到时是 null，页签只写名字 */
  count: number | null;
  /** 「等人接手」的数用软徽标（设计系统 §4.4、§5.7），其余是 13 text-3 的数字 */
  soft: boolean;
}

/**
 * 状态页签的顺序：全部之后是等人接手、顾问处理中、AI接待中、已成交（设计系统 I 页、02 spec R12）。写成 Record：
 * ConversationState 加减一种时这里不跟着改，typecheck 就失败
 */
const TAB_RANK: Readonly<Record<ConversationState, number>> = { human: 1, assigned: 2, ai: 3, paid: 4 };

export function tabs(counts: ConversationCounts | undefined): Tab[] {
  // 「顾问处理中」页签到 02 第 19 步才画（只在有这种会话或地址里选了它时出现，不做成灰的）
  const states = (Object.keys(TAB_RANK) as ConversationState[]).filter((s) => s !== 'assigned').sort((a, b) => TAB_RANK[a] - TAB_RANK[b]);
  return [
    { key: 'all', label: '全部', count: counts?.total ?? null, soft: false },
    ...states.map((s) => ({ key: s, label: STATUS_LABEL[s], count: counts?.byState[s] ?? null, soft: s === 'human' })),
  ];
}

/** 地址里的 state 就是选中的页签；没有时是「全部」 */
export const activeTab = (search: ConversationsSearch): TabKey => search.state ?? 'all';

/** 换页签：只留状态，阶段筛选与页码都清掉（阶段条只数 AI 接待中的会话） */
export const tabSearch = (key: TabKey): ConversationsSearch => (key === 'all' ? {} : { state: key });

// ---------------- 阶段筛选 ----------------

/**
 * 点阶段条的一行：只看这个阶段、AI 接待中的会话（与总览的阶段条同一个去向，验收 10）；
 * 再点一次已选中的那一行，取消阶段筛选、留在原来的页签
 */
export const stageSearch = (key: string, search: ConversationsSearch): ConversationsSearch =>
  search.stage === key ? clearStage(search) : { state: 'ai', stage: key };

/** 清掉阶段筛选：留着页签，回到第一页 */
export const clearStage = (search: ConversationsSearch): ConversationsSearch => (search.state ? { state: search.state } : {});

/** 阶段的名字取自行业包；包里没有的阶段照写原值 */
export function stageLabel(pack: IndustryPack, stage: string): string {
  return pack.stages.find((s) => s.key === stage)?.label ?? stage;
}

// ---------------- 列表 ----------------

/** 当前第几页，从 1 数 */
export const pageOf = (search: ConversationsSearch): number => search.page ?? 1;

/** 共几页；没有会话时算 1 页 */
export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));

/** 翻到第 p 页：筛选照旧，第 1 页不写 page */
export const pageSearch = (search: ConversationsSearch, p: number): ConversationsSearch => {
  const { page: _page, ...rest } = search;
  return p > 1 ? { ...rest, page: p } : rest;
};

/**
 * 列表接口的查询：等人接手的在前，其余按最后动静倒序（order=waiting_first，服务端排好再分页，spec I 页），
 * 每页 20 条；state、stage 由服务端先过滤再分页
 */
export interface ListQuery {
  limit: string;
  offset: string;
  order: 'waiting_first';
  state?: ConversationState;
  stage?: string;
}

export function listQuery(search: ConversationsSearch): ListQuery {
  return {
    limit: String(PAGE_SIZE),
    offset: String((pageOf(search) - 1) * PAGE_SIZE),
    order: 'waiting_first',
    ...(search.state ? { state: search.state } : {}),
    ...(search.stage ? { stage: search.stage } : {}),
  };
}

export interface RowView {
  id: string;
  /** 「企微客户」「F01」：渠道中文名加客户叫法、shortIdOf 短码（与工作台 admin.html 的短码规则相同） */
  label: [string, string];
  state: ConversationState;
  /** 阶段名；等人接手的行写「—」（设计系统 I 页） */
  stage: string;
  messages: number;
  /** 最后动静（updatedAt 原样，ISO 串） */
  at: string;
  /** 最后动静：相对时间（「8分钟前」「昨天21:40」，更早写日期）；悬停看 whenFull */
  when: string;
  whenFull: string;
  /** 新标签打开工作台并选中这个会话 */
  href: string;
}

export function rowView(row: ConversationRow, pack: IndustryPack, now: number): RowView {
  const state = conversationState(row, pack);
  // 转人工不算阶段：等人接手的行、以及阶段停在 handoff 的行都写「—」，页面上不出现「转人工」这类阶段名（验收 6）
  const stage = state === 'human' || row.stage === 'handoff' ? '—' : stageLabel(pack, row.stage);
  return {
    id: row.id,
    label: conversationLabel(row, pack),
    state,
    stage,
    messages: row.messageCount,
    at: row.updatedAt,
    when: relativeTime(row.updatedAt, now),
    whenFull: absoluteTime(row.updatedAt, now),
    href: workbenchHref(row.id),
  };
}

/** 读屏念的一行：「企微客户 F01，等人接手，在工作台打开（新标签页）」 */
export const rowAria = (r: RowView): string => `${r.label.join(' ')}，${STATUS_LABEL[r.state]}，在工作台打开（新标签页）`;

/**
 * 行内「打开工作台」按钮的读屏名：以看得见的字开头（WCAG 2.5.3），语音控制说「打开工作台」能对上。
 * 「打开工作台，企微客户 F01（新标签页）」
 */
export const openAria = (r: RowView): string => `打开工作台，${r.label.join(' ')}（新标签页）`;

/** 表格的名字写明排序规则：等人接手的排在最前，其余才按「最后动静」倒序，光看那一列的 aria-sort 会误以为整表按时间排 */
export const tableAria = (total: number): string => `会话，共${total}个，等人接手的排在最前`;
