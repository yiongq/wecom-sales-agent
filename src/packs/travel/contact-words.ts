// 06 原则：对客户的固定文字按三种情形渲染，R5、R12、R13、R16 共用。
//   旧版模式（企微）  ：顾问会在微信上联系您
//   网页渠道          ：顾问会在这个页面里回复您
//   模板模式非网页    ：顾问会联系您（不点名渠道，也不出现品牌名，与 contractRules 在模板模式下的写法一致）
// 纯函数，不带 markdown。

export interface ContactMode {
  /** 会话渠道，'web' 是网页访客 */
  channel: string;
  /** 品牌模板模式（引擎的 brand 非空）；旧版模式为 false */
  templateMode: boolean;
}

/** 「会……您」的后半句，接在「顾问会」「顾问核实后会」后面 */
function contactTail({ channel, templateMode }: ContactMode): string {
  if (channel === 'web') return '在这个页面里回复您';
  return templateMode ? '联系您' : '在微信上联系您';
}

/** 「顾问会在微信上联系您」/「顾问会在这个页面里回复您」/「顾问会联系您」 */
export function advisorContact(mode: ContactMode): string {
  return `顾问会${contactTail(mode)}`;
}

/** R5 的到账口径对客句：客户说已付款而系统还没收到到账时用；不说已到账、订单生效、订单已确认。 */
export function paymentPendingReply(mode: ContactMode): string {
  return `款项到账后您会收到确认，顾问核实后会${contactTail(mode)}。`;
}
