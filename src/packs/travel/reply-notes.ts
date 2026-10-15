// 06 R7、R14：本轮回复的会话记录（已提醒项、已推荐线路）与付款后寒暄短路。纯函数，不碰存储与模型。
import type { Route, Session } from '../../core/pack-api.js';
import { advisorContact, type ContactMode } from './contact-words.js';

type Reminders = NonNullable<Session['reminders']>;

/** R7 四项提醒：从最终文本里认。值是展示给模型的名字，顺序即 contextNote 里的顺序 */
export const REMINDER_LABELS: readonly [keyof Reminders, string][] = [
  ['altitude', '海拔提醒'],
  ['elderAge', '问过长辈年龄'],
  ['proposalSent', '发过方案书'],
  ['paidNext', '说过付款后安排'],
];

const ELDER = /长辈|爸妈|父母|老人|二老|叔叔阿姨|爷爷奶奶|外公外婆/;
const ELDER_AGE_ASK = /多大|几岁|年龄|岁数|年纪|身体状况|身体情况|腿脚/;
const REMINDER_RULES: Record<keyof Reminders, (clauses: string[], text: string) => boolean> = {
  altitude: (_c, text) => /海拔|高反|高原反应/.test(text),
  // 同一个小句里既点了长辈，又在问年龄或身体
  elderAge: (clauses) => clauses.some((c) => ELDER.test(c) && ELDER_AGE_ASK.test(c)),
  proposalSent: (_c, text) => /\/proposal\//.test(text),
  paidNext: (_c, text) => /确认书|服务群|拉群|拉您进群/.test(text),
};

/** 本轮最终文本里认出的提醒项 */
export function remindersIn(text: string): (keyof Reminders)[] {
  const clauses = text.split(/[，,。！!？?；;\n]+/).filter(Boolean);
  return REMINDER_LABELS.map(([key]) => key).filter((key) => REMINDER_RULES[key](clauses, text));
}

const compact = (s: string): string => s.replace(/\s+/g, '');
/** 标题去掉开头的目的地和结尾的「N 日」后剩下的特色部分（「丽江大理·洱海古城」），太短不当名字 */
function titleCore(title: string): string {
  const core = title
    .replace(/^\S+\s+/, '')
    .replace(/\s*\d+\s*[日天]\s*$/, '')
    .trim();
  return compact(core).length >= 4 ? compact(core) : '';
}

/** 最终文本里点了名的线路：整个标题，或标题里的特色部分 */
export function routesNamedIn(text: string, routes: readonly Route[]): { id: string; title: string }[] {
  const flat = compact(text);
  return routes
    .filter((r) => flat.includes(compact(r.title)) || (titleCore(r.title) && flat.includes(titleCore(r.title))))
    .map((r) => ({ id: r.id, title: r.title }));
}

/** 这条客户消息是本会话的第几轮：会话里客户消息的条数（重置会清空消息，轮次随之从头算） */
export function turnNumber(session: Session): number {
  return session.messages.filter((m) => m.role === 'customer').length;
}

/** R7 note_reply 的步骤体：写 reminders（只记第一次）与 recommendedRoutes（去重，最多 5 条，满了挤掉最早的） */
export function noteReply(session: Session, text: string, routes: readonly Route[]): void {
  const found = remindersIn(text);
  if (found.length) {
    const turn = Math.max(1, turnNumber(session));
    const reminders: Reminders = { ...session.reminders };
    for (const key of found) reminders[key] ??= turn;
    session.reminders = reminders;
  }
  const named = routesNamedIn(text, routes);
  if (named.length) {
    const list = [...(session.recommendedRoutes ?? [])];
    for (const r of named) if (!list.some((x) => x.id === r.id)) list.push(r);
    session.recommendedRoutes = list.slice(-5);
  }
}

/** R7 contextNote 的两行；没有记录时返回空数组（会话 contextNote 逐字节不变） */
export function reminderLines(session: Session): string[] {
  const lines: string[] = [];
  const said = REMINDER_LABELS.filter(([key]) => session.reminders?.[key] !== undefined).map(
    ([key, label]) => `${label}（第 ${session.reminders![key]} 轮）`,
  );
  if (said.length) lines.push(`已对客户说过：${said.join('、')}——客户没再问就别重复`);
  const routes = session.recommendedRoutes ?? [];
  if (routes.length) lines.push(`本会话推荐过：${routes.map((r) => `《${r.title}》`).join('、')}；做对比或总结时把这些都算上`);
  return lines;
}

// ---------- R14 付款后寒暄 ----------
const CHITCHAT_TOKENS = [
  '谢谢您',
  '谢谢你',
  '谢谢',
  '多谢',
  '感谢',
  '您好',
  '你好',
  '哈喽',
  '嗨',
  'hello',
  'hi',
  '在不在',
  '在吗',
  '在么',
  '在的',
  '好的',
  '好哒',
  '好滴',
  '好',
  '嗯嗯',
  '嗯',
  '哦哦',
  '哦',
  '收到',
  '知道了',
  '明白',
  'okay',
  'ok',
  '辛苦了',
  '辛苦',
];
const CHITCHAT_MAX = 8;

/** 纯寒暄：去掉标点、表情和空白后全由上面的词组成，且不超过 8 个字。带任何别的内容（疑问词、名词）都不算 */
export function isPureChitchat(text: string): boolean {
  let rest = text.toLowerCase().replace(/[\s，,。.！!？?、～~…；;：:'"“”‘’()（）]+|\p{Extended_Pictographic}|️|‍/gu, '');
  if (!rest || rest.length > CHITCHAT_MAX) return false;
  while (rest) {
    const hit = CHITCHAT_TOKENS.find((t) => rest.startsWith(t));
    if (!hit) return false;
    rest = rest.slice(hit.length);
  }
  return true;
}

/**
 * 回一行，3 个变体轮换（按客户消息条数取，上一条回复正好是它就顺延一个）。
 * 说过付款后安排（reminders.paidNext）的，不再提顾问后续安排。三种联系方式渲染见 contact-words。
 */
export function paidChitchatReply(session: Session, mode: ContactMode): string {
  const contact = advisorContact(mode);
  const variants = session.reminders?.paidNext
    ? ['好的～订单已经付款，行程上有想问的直接说～', '收到～行程上有什么想了解的，直接问我就行～', '嗯嗯～订单这边没问题，有想问的直接说～']
    : [
        `好的～订单已付款成功，后续安排${contact}。`,
        `收到～付款已经登记，后续的安排${contact}。`,
        `嗯嗯～您这单已经付款了，行程上有想问的直接说，后续安排${contact}。`,
      ];
  const lastAgent = session.messages.findLast((m) => m.role === 'agent')?.content;
  let at = turnNumber(session) % variants.length;
  if (variants[at] === lastAgent) at = (at + 1) % variants.length;
  return variants[at]!;
}
