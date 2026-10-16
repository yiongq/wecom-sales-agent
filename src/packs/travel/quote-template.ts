// 06 R9：护栏兜底报价句的统一模板（rewriteUnbackedPrices 的 quoteLine 与 strandedReply 的报价句共用）。
// 纯函数，不带 markdown，不说「起价」「微调」「系统」。
//   《线路》2 位、10 月 12 日出发，每人 ¥17,380，总价 ¥34,760（10 月为最佳出行季，上浮 10%）。不含往返大交通。
// 客户只说了节日或月份时写「国庆出发」「11 月出发」；没有出发日期时写标准价，加一句「出发日期定了我按日期实报」。

export interface QuoteTemplateInput {
  title: string;
  travelers: number;
  perPerson: number;
  total: number;
  /** create_quote 给的定价说明（「10月为最佳出行季，价格上浮 10%」「当前为标准价」） */
  note?: string;
  /** 「10 月 12 日出发」「国庆出发」「11 月出发」；没有就不写日期 */
  when?: string;
  /** 这条线路的「不含」里有往返大交通 */
  excludesTransport: boolean;
  yuan(n: number): string;
}

/** 定价说明改成客户读得顺的写法：「10月为最佳出行季，价格上浮 10%」→「10 月为最佳出行季，上浮 10%」 */
export function readableQuoteNote(note: string | undefined): string {
  const t = (note ?? '').trim();
  if (!t || t === '当前为标准价') return '标准价';
  return t
    .replace(/(\d+)月/g, '$1 月')
    .replace('价格上浮', '上浮')
    .replace(/[；;]/g, '，');
}

/** 这条线路的「不含」里有没有往返大交通（机票、火车票、高铁算在里面） */
export function excludesRoundTripTransport(exclusions: readonly string[] | undefined): boolean {
  return (exclusions ?? []).some((e) => /往返/.test(e) && /大交通|机票|航班|火车|高铁/.test(e));
}

export function renderQuoteLine(input: QuoteTemplateInput): string {
  const { title, travelers, perPerson, total, when, yuan } = input;
  const head = `《${title}》${travelers} 位${when ? `、${when}` : ''}`;
  const money = `每人 ${yuan(perPerson)}，总价 ${yuan(total)}（${readableQuoteNote(input.note)}）。`;
  return head + '，' + money + (when ? '' : '出发日期定了我按日期实报。') + (input.excludesTransport ? '不含往返大交通。' : '');
}
