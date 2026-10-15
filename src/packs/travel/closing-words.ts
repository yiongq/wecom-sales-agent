// 06 R12：收尾轮的结尾句文字与判定。纯函数，不带 markdown，按「原则」的三种情形渲染：
//   旧版模式（企微）  ：有问题随时在微信上问我～
//   网页渠道          ：有问题随时在这个页面里问我～
//   模板模式非网页    ：有问题随时问我～（不点名渠道，也不出现品牌名）
// 文字约束（plan 第 0.2 步）：不得含「随时告诉我 / 马上帮您查 / 随时找我」。
import type { ContactMode } from './contact-words.js';

/** 固定结尾句 */
export function closingLine({ channel, templateMode }: ContactMode): string {
  if (channel === 'web') return '有问题随时在这个页面里问我～';
  return templateMode ? '有问题随时问我～' : '有问题随时在微信上问我～';
}

/** 回复里已经有同类结尾（「有问题随时问我」「欢迎再来问」「不着急慢慢看」这类），不再重复加 */
export const HAS_CLOSING =
  /随时[^。！？!?\n]{0,8}?(?:问|联系|找|告诉|说|咨询|留言|来)|(?:有|如有|若有|还有|任何)[^。！？!?\n]{0,10}(?:问题|疑问|需要|想了解|想确认)[^。！？!?\n]{0,10}(?:问我|找我|联系我|告诉我|跟我说|再说|再问|再聊)|欢迎(?:随时|再|您)?[^。！？!?\n]{0,6}(?:问|咨询|联系|来聊|找我)|不着急|慢慢(?:考虑|看|想|选|来)|(?:想好|考虑好|商量好|商量完)了?[^。！？!?\n]{0,6}(?:告诉|跟|找|联系)/;

export interface ClosingTurnPatterns {
  ORDER_DEFERRED: RegExp;
  QUOTE_ONLY: RegExp;
  ORDER_QUESTION: RegExp;
  PRICE_OK: RegExp;
}

const THANKS_OR_LEAVE = /谢谢|感谢|多谢|先这样/;
// 「别的不考虑」是在坚持，不是收尾：「不考虑」整体先去掉再认推迟
const NOT_CONSIDER = /不考虑/g;

/**
 * 客户这句是不是收尾（先放一放、回去商量、谢谢、先这样）。
 * 顺序：先照 netOrderIntent 的做法去掉 PRICE_OK；命中 QUOTE_ONLY（报个价、发方案）、问句、「不考虑」的不算；
 * 再认 ORDER_DEFERRED，另加「谢谢」「先这样」。排除顺序不能改（锁定 p2 依赖 QUOTE_ONLY 命中不算收尾）。
 */
export function isClosingTurn(text: string, p: ClosingTurnPatterns): boolean {
  const said = text.replace(p.PRICE_OK, '');
  if (p.QUOTE_ONLY.test(said)) return false;
  if (p.ORDER_QUESTION.test(said)) return false;
  const rest = said.replace(NOT_CONSIDER, '');
  return p.ORDER_DEFERRED.test(rest) || THANKS_OR_LEAVE.test(rest);
}
