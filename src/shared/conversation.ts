// 会话状态与短码（docs/features/console-ux/spec.md「接口改动」、不变量 17）：前后端共用，只依赖 src/shared。
// 全站只有这一处判定会话状态：服务端的过滤、计数和 console 的列表、首页、徽标、铃铛都调 conversationState，
// console 里不直接读 handedOver、也不拿 stage 和 'paid' 比（plan 第 3.3 步的检查拦这两种写法）。
// 已成交按租户行业包的终态（stages 里标了 terminal 的阶段）判定：旅游包是「已支付」paid，家装假包是「已付定金」deposit。
// 状态值仍叫 paid（接口的取值名不变），只是判定不再认 'paid' 这个阶段 key。
// 02 扩成四态（docs/architecture/02-conversations-workbench/spec.md「转人工记录与四种状态」、R12）：转人工且有接手人是 assigned。
import type { ConversationState } from './console-api.js';
import type { IndustryPack, SalesStageDef } from './pack.js';

/** 行业包的终态阶段，按包里的顺序：会话的阶段停在其中之一就算已成交 */
export function terminalStages(pack: Pick<IndustryPack, 'stages'>): SalesStageDef[] {
  return pack.stages.filter((s) => s.terminal === true);
}

const isTerminal = (stage: string, pack: Pick<IndustryPack, 'stages'>): boolean => terminalStages(pack).some((s) => s.key === stage);

/**
 * paid（已成交）：stage 是行业包的终态；assigned（顾问处理中）：handedOver 且有接手人；human（等人接手）：handedOver 且没有接手人；
 * ai（AI 接待中）：其余。没有接手人的数据上判定与 02 之前逐个相同。
 * 参数是结构类型：Session（assignee 可选）与 ConversationRow 都能直接传
 */
export function conversationState(
  row: { stage: string; handedOver: boolean; assignee?: { userId: string | null; name: string } | null },
  pack: Pick<IndustryPack, 'stages'>,
): ConversationState {
  if (isTerminal(row.stage, pack)) return 'paid';
  if (row.handedOver) return row.assignee ? 'assigned' : 'human';
  return 'ai';
}

/** 「已成交客户要人工」（R9，开放问题 12 选 A）：终态、handedOver、没有接手人。状态仍是 paid，铃铛弹层与 A2 单列一组 */
export function paidNeedsHuman(
  row: { stage: string; handedOver: boolean; assignee?: unknown },
  pack: Pick<IndustryPack, 'stages'>,
): boolean {
  return row.handedOver && !row.assignee && isTerminal(row.stage, pack);
}

export interface NeedProfile {
  destinationInterest?: string;
  segment?: string;
  travelers?: number | string;
}
export interface NeedVocabulary {
  /** 产品库里 active 条目的目的地名 */
  destinations: readonly string[];
  /** 行业包客群词表：键 → 短标签 */
  segments: Readonly<Record<string, string>>;
}

/** 人数只认整数：数字，或整句就是「4」「4人」「4位」这样的写法；「2大1小」这种说不准总数的不取 */
const HEADCOUNT = /^(\d{1,3})\s*[人位]?$/;

/**
 * 会话标题后半段，如「贵州带爸妈4人」。只用规范化的取值：目的地取 destinationInterest 里命中的第一个词表目的地
 * （按在原文里出现的位置，同一位置取长的），客群只认词表里的键，人数只取数字；画像里的自由文本一个字也不回显。
 * 取不到的部分省略，全空时为 null。不含昵称
 */
export function needSummary(profile: NeedProfile, vocab: NeedVocabulary): string | null {
  const { destination, segment, travelers } = needParts(profile, vocab);
  return `${destination ?? ''}${segment ?? ''}${travelers ?? ''}` || null;
}

/**
 * needSummary 的三段（J 页右栏的需求要素与它同源，02 第 13 步）：目的地、客群短标签、「N人」，取不到的为 null。
 * 规则同 needSummary：只用规范化的取值，画像里的自由文本一个字也不回显
 */
export function needParts(
  profile: NeedProfile,
  vocab: NeedVocabulary,
): { destination: string | null; segment: string | null; travelers: string | null } {
  const interest = profile.destinationInterest ?? '';
  let destination = '';
  let at = -1;
  for (const d of vocab.destinations) {
    const i = d ? interest.indexOf(d) : -1;
    if (i >= 0 && (at < 0 || i < at || (i === at && d.length > destination.length))) {
      destination = d;
      at = i;
    }
  }
  const segment = profile.segment !== undefined && Object.hasOwn(vocab.segments, profile.segment) ? vocab.segments[profile.segment] : '';
  const raw = profile.travelers;
  const n = typeof raw === 'number' ? raw : Number(HEADCOUNT.exec(raw?.trim() ?? '')?.[1] ?? NaN);
  const travelers = Number.isInteger(n) && n > 0 && n < 1000 ? `${n}人` : '';
  return { destination: destination || null, segment: segment || null, travelers: travelers || null };
}

/**
 * 会话的短码，如 wecom:cust_A01 → A01。与 public/admin.html 的 shortIdOf 同一规则，后台和工作台里能对上号：
 * 去掉 wecom:、sim-、cust / cust_ 前缀，只留字母数字，取最后 4 位转大写。没有字母数字时是空串
 */
export function shortIdOf(id: string): string {
  return id
    .replace(/^wecom:/, '')
    .replace(/^sim-/, '')
    .replace(/^cust_?/, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-4)
    .toUpperCase();
}

/**
 * 人工回复的标记（02 spec「接手、人工回复与交还」、不变量 18）：人工回复在客户侧（企微与网页模拟器）以它开头；发给模型的历史里
 * author='human' 的消息同样以它开头，模型才分得清哪些话是顾问说的；AI 回复写进会话之前去掉开头的它
 */
export const ADVISOR_PREFIX = '【顾问】';

/** 正文前加「【顾问】」；已经以它开头的原样返回（顾问自己打了的不叠两遍） */
export function withAdvisorPrefix(text: string): string {
  return text.startsWith(ADVISOR_PREFIX) ? text : `${ADVISOR_PREFIX}${text}`;
}

/** 去掉开头的「【顾问】」（可连着几个，后面可跟冒号与空白）；没有就原样返回 */
export function stripAdvisorPrefix(text: string): string {
  return text.replace(/^\s*(?:【顾问】[\s:：]*)+/, '');
}
