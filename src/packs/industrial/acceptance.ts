/** 报价承诺只按客户原话判定：逐分句整句匹配明确的接受说法；问句、请求和未决定的说法不接受。 */
const ACK = /^(?:好的?|行|可以|没问题|嗯|ok|收到|谢谢|不用改了|(?:价格|报价|这个价格?)(?:没问题|可以))$/iu;
// 采购口吻也算：愿意按这份报价采购、同意采购、这份报价我们认可。
const ACCEPT =
  /^(?:(?:好的?|好吧|行吧?|可以的?|没问题|嗯+|ok|那就|那|就|我们|我|这(?:个|份)(?:报价|价格?)|愿意|决定|同意)\s*)*(?:(?:(?:帮我|请|麻烦|给我)\s*)?下单|确认下单|确认报价|确认这(?:个|份)报价|(?:接受|认可|同意)(?:这(?:个|份))?(?:报价|价格?)?(?:并?(?:采购|购买|订购|下单))?|可以接受|成交|(?:采购|购买|订购)|就?按这(?:个|份)(?:报价|价格?)?(?:来|办|下单|采购|购买|订购)?|就这个|就这样|就这么(?:定|办)|就?定这个|就它|可以下单|安排(?:下单|采购)?|确认(?:无误|没问题)?)(?:吧|了|的|啦)*$/iu;
const QUESTION = /[?？]|吗|是否|能否|能不能|会不会|是不是/u;
// 任一分句出现就不算接受：还没决定，或要改这张单（改完会有新报价）。
const HOLD =
  /先别|暂不|还没|尚未|再想想|再看看|考虑一下|考虑考虑|等等|等一下|稍等|问问领导|回头再说|再说吧|不确认|再加|加\s*\d|加到|改成|改为|换成|换个|减到|少要|多要/u;

export function quoteAcceptance(text: string): { accepted: boolean; needsModel: boolean } {
  // 问号保留在所属分句里，不能把「确认下单？」切成肯定；逗号后的问题不影响前面的接受。
  const clauses = (text.normalize('NFKC').match(/[^,。.!！;；\n\r?？]+[?？]?/gu) ?? []).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.some((clause) => HOLD.test(clause))) return { accepted: false, needsModel: true };
  const accepts = clauses.map((clause) => !QUESTION.test(clause) && ACCEPT.test(clause));
  return {
    accepted: accepts.some(Boolean),
    needsModel: clauses.some((clause, i) => !accepts[i] && !ACK.test(clause)),
  };
}
