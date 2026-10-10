// 主回复与兼容门面共用的通用文本处理。
const VERSION_SUFFIX_AHEAD = /^v=\d/;

/** 回复停在半句上（B01 实测模型原文停在「可以直接说：」）：截到上一个完整句，截不出就原样 */
export function trimDangling(text: string): string {
  const t = text.trimEnd();
  if (!/[：:，,、]$/.test(t)) return text;
  // 方案书链接的版本后缀（/proposal/…/2?v=2）里的「?」不是句末：截在那儿链接就只剩「/2?」，点开是版本 1 的旧价
  let q = t.lastIndexOf('?');
  while (q >= 0 && VERSION_SUFFIX_AHEAD.test(t.slice(q + 1))) q = q > 0 ? t.lastIndexOf('?', q - 1) : -1;
  const cut = Math.max(q, ...['。', '！', '？', '!', '～', '~', '…', '\n'].map((c) => t.lastIndexOf(c)));
  if (cut <= 0) return text;
  return t.slice(0, t[cut] === '\n' ? cut : cut + 1).trimEnd() || text;
}

// 客户直接追问身份。诚实回答是硬要求，但模型在「不要主动提 AI」的约束下常把这题绕过去
// （实测 3 问只承认 1 次），所以不赌模型：命中就由引擎确定性地补上承认句。
// 不经过模型的确定性回复（转人工安全网、重发支付链接）也要补：此前兜底只在模型路径末尾，
// 「你是机器人吧？我要投诉」「你是真人吗？转人工」都转了人工，回复里却没有一个 AI 字样。
// 「真人」后面跟服务角色（真人导游/真人管家…）问的是配不配真人服务，不是在质疑 AI 身份。
// 不排除的话，「你们有真人导游吗」会被强行加一句身份承认句当开头，答非所问。
const REAL_PERSON = '真人(?!导游|管家|司机|领队|向导|陪同|跟团|带团|服务)';

export const IDENTITY_QUESTION = new RegExp(
  `(?:你|您|你们|您们).{0,8}(?:${REAL_PERSON}|机器人|机器|AI|ai|Ai|人工智能|智能助手|智能客服)` +
    `|(?:${REAL_PERSON}|机器人|AI|ai)\\s*(?:吗|还是|吧|嘛)`,
);

/** 客户这句在问身份、回复里又没承认：把承认句放在最前面 */
export function answerIdentity(text: string, reply: string, identityAnswer: string): string {
  if (!IDENTITY_QUESTION.test(text) || /AI|ai\b|人工智能/.test(reply)) return reply;
  return reply ? identityAnswer + '\n' + reply : identityAnswer;
}

/** 去 markdown（对话轮次与跟进共用） */
export function stripMarkdown(visible: string): string {
  return visible
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[-*]\s+/gm, '$1· ')
    .replace(/[ \t]{2,}/g, ' ');
}
