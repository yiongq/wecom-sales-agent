// 成单安全网（reply-steps 的 order_net）对客的固定文字。纯函数，只拼字，不碰订单和存储；
// 从 reply-steps 原样搬出来，好让一致性检查（R21）能渲染同一份文字。
import { advisorCheck } from './contact-words.js';

export interface OrderNetOrderText {
  title: string;
  travelers: number;
  /** 已经写成客户看的样子（cardDate） */
  date: string;
  /** 已经写成「¥33,600」 */
  total: string;
}

/** advisor 收款模式下顾问怎么核对价格、发收款方式：旧版 / 网页的写法不动，模板模式（非网页）不点名渠道（见 contact-words） */
const advisorCheckPrice = (link: { web: boolean; templateMode?: boolean }): string =>
  advisorCheck({ channel: link.web ? 'web' : 'wecom', templateMode: !!link.templateMode }, '跟您核对价格并发收款方式');

/** 已有完全同参的待付款订单：重发原链接 */
export function existingOrderText(
  o: OrderNetOrderText,
  link: { advisor: boolean; web: boolean; templateMode?: boolean; id: string },
): string {
  // advisor 模式：这条链接不是点开就能付的，同一意思换一种说法（02 spec「收款流程」）；online 模式原样不变
  const how = link.advisor
    ? `订单链接：/pay/${link.id}\n${advisorCheckPrice(link)}，想改人数或日期的话跟我说一声，我重新为您安排～`
    : `直接点这里完成支付即可：/pay/${link.id}\n想改人数或日期的话跟我说一声，我重新为您安排～`;
  return `您这单已经建好啦～《${o.title}》${o.travelers} 位出行、${o.date}出发，总价 ${o.total}。\n${how}`;
}

/** 刚建好的订单 */
export function createdOrderText(
  o: OrderNetOrderText,
  parts: {
    /** 报价时没给日期、建单补上后总价变了：「（之前报的是 …，按 … 出发重新核算：…）」 */
    diff?: { before: string; date: string; note: string };
    /** 被作废的旧单 */
    replaced?: { travelers: number; date: string };
    advisor: boolean;
    web: boolean;
    /** 品牌模板模式（非网页时不点名渠道） */
    templateMode?: boolean;
    payUrl: string;
  },
): string {
  const diff = parts.diff ? `\n（之前报的是 ${parts.diff.before}，按 ${parts.diff.date}出发重新核算：${parts.diff.note}）` : '';
  // advisor 模式：旧单作废后不说「按这张付款」，这条链接不是点开就能付的（02 spec「收款流程」）；online 模式原样不变
  const replaced = parts.replaced
    ? `\n之前那张 ${parts.replaced.travelers} 位、${parts.replaced.date}出发的订单已作废，旧链接失效，${parts.advisor ? '按这张的订单链接来。' : '按这张付款就行。'}`
    : '';
  // 没付款不算锁定名额：此前「已为您锁定名额」和「名额以付款为准」写在同一条里，前后矛盾
  const how = parts.advisor
    ? `订单链接：${parts.payUrl}\n${advisorCheckPrice(parts)}，不用点链接付款。`
    : `请点此完成支付：${parts.payUrl}\n名额以付款为准，付款后顾问会与您确认行程细节～`;
  return `好的，订单已生成～\n《${o.title}》${o.travelers} 位出行、${o.date}出发，总价 ${o.total}。${diff}${replaced}\n${how}`;
}

/** 付款到账后发给客户的确认（engineHooks.paidText） */
export function paidOrderText(order: { routeTitle: string; travelers: number; departDate: string }): string {
  return (
    `已收到您的支付，太开心啦 🎉\n《${order.routeTitle}》${order.travelers} 位出行、` +
    `${order.departDate} 出发已确认预订。\n专属旅行顾问稍后会与您对接行程细节和出行准备，` +
    `有任何想法随时跟我说～`
  );
}

/** 残句兜底：回复只剩线路列表时前面加的引导句（reply-steps 的 stranded 步骤） */
export const STRANDED_LEAD = '给您看看这几条：';
