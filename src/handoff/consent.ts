// 敏感信息同意（docs/architecture/02-conversations-workbench/spec.md「隐私说明、敏感信息同意、保留期与行权」，R23）。
// sensitiveCategoriesOf、consentWithdrawalOf 的识别在 triggers.ts；本模块是同意状态的记账与菜单/回复文案，
// 由 engine.ts（新出现的类别、撤回同意）与 adapters/wecom.ts（企微菜单的点击回调）两处调用。
// 只在发布过隐私说明时才会被调用（调用方先查 currentPrivacyNotice()，不变量 40）；demo（文件配置模式）永远不会走到这里。
import { privacyLink } from '../privacy/privacy.js';
import { queueConsents, type ConsentItem } from '../store.js';
import type { Session } from '../types.js';
import type { SensitiveCategory } from './triggers.js';
import { enterHandoff, HANDOFF_REASON } from './record.js';

/** 类别的中文叫法（企微菜单问句、contextNote 里用） */
export const SENSITIVE_CATEGORY_LABEL: Readonly<Record<SensitiveCategory, string>> = {
  health: '家人的健康情况',
  minor: '孩子的信息',
};

/** 同一类别最多问两次（开放问题 7 的裁决）：第一次出现时问一次，仍没点的下次出现同类别再问一次，之后不再问 */
export const CONSENT_MAX_ASKS = 2;

/** 企微菜单的问句（spec 原文，类别名代入）；没有发布隐私说明时不会调用这个函数（调用方已经先查过） */
export function consentMenuText(category: SensitiveCategory): string {
  const link = privacyLink();
  return (
    `您提到了${SENSITIVE_CATEGORY_LABEL[category]}，这属于敏感个人信息。我们只用它来推荐合适的线路、安排行程强度和住宿，` +
    `不做别的用途，按隐私说明保存，您可以随时撤回。不提供也能继续咨询，只是推荐可能没那么贴合。可以吗？隐私说明：${link ?? ''}`
  );
}

/** 没点菜单、contextNote 提示模型别主动提这一类信息（R23：「没点时照常接待」） */
export function sensitiveContextNote(category: SensitiveCategory): string {
  return `客户提到过${SENSITIVE_CATEGORY_LABEL[category]}，还没明确同意我们使用这类信息：不要在回复里主动提起或追问这类信息。`;
}

/** 撤回同意或删除请求命中（consentWithdrawalOf）时的固定回复（spec 原文） */
export const CONSENT_WITHDRAWN_REPLY = '好的，已经记下您的要求，顾问会尽快联系您处理。';
/** 撤回同意时转人工的原因（spec 原文） */
export const CONSENT_WITHDRAWAL_REASON = '客户要求撤回同意或删除信息';

/** 客户在企微菜单点「不同意」之后的确认回复（没有明确给定措辞，选最贴近「回一句确认」字面意思的说法） */
export const CONSENT_DECLINED_REPLY = '好的，这类信息我们不会收集或使用，马上为您转接人工顾问处理。';

/** 菜单按钮的 id：category:decision，两边各自编解码（企微的 menu_id 回调按它解析决定是哪个类别） */
export function consentMenuButtonId(category: SensitiveCategory, decision: 'granted' | 'declined'): string {
  return `${category}:${decision}`;
}
const CATEGORIES: readonly SensitiveCategory[] = ['health', 'minor'];
export function parseConsentMenuId(
  id: string | undefined | null,
): { category: SensitiveCategory; decision: 'granted' | 'declined' } | null {
  if (!id) return null;
  const [cat, decision] = id.split(':');
  if (!CATEGORIES.includes(cat as SensitiveCategory) || (decision !== 'granted' && decision !== 'declined')) return null;
  return { category: cat as SensitiveCategory, decision };
}

/**
 * 客户这句话里第一次／第二次出现某个还没有结论的类别：更新 session.consent（标 'asked'）与 consentAskCount，
 * 记一条 ConsentItem（decision='asked'）。已经有结论（granted/declined/withdrawn）的类别不再问；已经问过两次仍没点的也不再问，
 * 只在 contextNote 里提示模型。返回这一轮真的要发菜单的类别（第一次或第二次出现）
 */
export function noteSensitiveMentions(
  session: Session,
  categories: readonly SensitiveCategory[],
  noticeVersion: number,
  evidence: string,
): SensitiveCategory[] {
  const toAsk: SensitiveCategory[] = [];
  const items: ConsentItem[] = [];
  for (const category of categories) {
    const decided = session.consent?.[category];
    if (decided === 'granted' || decided === 'declined' || decided === 'withdrawn') continue;
    const asked = session.consentAskCount?.[category] ?? 0;
    if (asked >= CONSENT_MAX_ASKS) continue;
    session.consent = { ...session.consent, [category]: 'asked' };
    session.consentAskCount = { ...session.consentAskCount, [category]: asked + 1 };
    items.push({ category, decision: 'asked', noticeVersion, evidence, at: Date.now() });
    toAsk.push(category);
  }
  if (items.length) queueConsents(session.id, items);
  return toAsk;
}

/** 这个类别现在是不是「问过、还没有结论」（contextNote 提醒模型别主动提它用） */
export function awaitingConsent(session: Session, category: SensitiveCategory): boolean {
  return session.consent?.[category] === 'asked';
}

/**
 * 客户点了企微菜单：记一条同意记录。「不同意」转人工（kind='consent'）且不能交还 AI（ConsentDeclinedError 已按
 * consent 的取值判，见 takeover.ts 的 consentDeclined）；「同意」不转人工。
 * 「不同意」不是终态（spec「不同意……这个会话不能再交还 AI……之后客户点了『同意』才解除」）：declined → granted 放行，
 * 解除之后 consentDeclined 对这个类别不再成立，交还就不再被挡。granted、withdrawn 是终态，改不了；同一个决定重复点
 * （declined→declined、granted→granted）当空操作，不重复记、不重复转人工。
 * 「怎么再给客户第二次点『同意』的机会」spec 没写清——企微的菜单消息一直留在聊天记录里、按钮本身不会失效，
 * 客户随时能回去点旧菜单的「同意」；选这个最小做法（不用再发一条新菜单），已写进 plan「Open」请 owner 确认。
 * 调用方（wecom.ts）负责把「不同意」的确认回复发给客户、写进会话
 */
export function applyConsentDecision(
  session: Session,
  category: SensitiveCategory,
  decision: 'granted' | 'declined',
  evidence: string,
  noticeVersion: number,
): boolean {
  const decided = session.consent?.[category];
  if (decided === 'granted' || decided === 'withdrawn' || decided === decision) return false;
  session.consent = { ...session.consent, [category]: decision };
  queueConsents(session.id, [{ category, decision, noticeVersion, evidence, at: Date.now() }]);
  if (decision === 'declined') {
    enterHandoff(session, { kind: 'consent', at: Date.now(), reason: HANDOFF_REASON.consent });
  }
  return true;
}

/**
 * 撤回同意或删除请求（consentWithdrawalOf）：对已经问过的类别（任何不是 withdrawn 的取值）各记一条 withdrawn。
 * 没有问过任何类别时什么都不记（DB 的 consents 表只收「已问过的类别」），调用方（engine.ts）仍然要转人工、回固定的一句。
 * 返回记了几条
 */
export function withdrawConsent(session: Session, quote: string, noticeVersion: number): number {
  const categories = (Object.keys(session.consent ?? {}) as SensitiveCategory[]).filter((c) => session.consent![c] !== 'withdrawn');
  if (!categories.length) return 0;
  const consent = { ...session.consent };
  for (const c of categories) consent[c] = 'withdrawn';
  session.consent = consent;
  queueConsents(
    session.id,
    categories.map((category) => ({ category, decision: 'withdrawn' as const, noticeVersion, evidence: quote, at: Date.now() })),
  );
  return categories.length;
}
