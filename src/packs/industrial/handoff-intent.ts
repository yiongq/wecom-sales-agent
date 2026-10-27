// 通用投诉与显式人工意图；不引入旅游话术或业务条件。
const HANDOFF_REQUEST = /转人工|要人工|人工客服|真人客服|找真人|人工顾问|要退款|要退订|要退钱|退我钱/;

const HANDOFF_BARE = /^\s*我?(?:要|找|接)?(?:人工|真人)(?:服务)?\s*[!！。.~～]*\s*$/;

const COMPLAINT_WORD = /差评|欺骗|骗人|骗子|被骗/;
const DOUBT_CLAUSE = /不会|不是|会不会|是不是|是否|有没有|靠谱|有人|别人|听说|看到|网上|[吗吧嘛呢?？]/;
/** 「不是…吗」反问。其余疑虑词（会不会/是不是/听说…）同在时仍按打消疑虑处理 */
const RHETORICAL = /(?<!是)不是.*吗/;
const STRONG_DOUBT = /不会|会不会|是不是|是否|有没有|靠谱|有人|别人|听说|看到|网上/;
/** 说的是别人的投诉，或自己否认要投诉。「有没有投诉电话」里的「没有投诉」不是否认 */
const NOT_OWN_COMPLAINT = /有人|别人|听说|看到|网上|被投诉|投诉(?:多|率|记录)|(?<!有)(?:不是|不想|不会|不打算|没有?|不)\s*[来去要]?\s*投诉/;
/** 投诉或指控（按小句判，规则见上） */
export function isComplaint(text: string): boolean {
  return text
    .split(/[，,。！!；;~～\n]+/)
    .some(
      (c) =>
        (c.includes('投诉') && !NOT_OWN_COMPLAINT.test(c)) ||
        (COMPLAINT_WORD.test(c) && (!DOUBT_CLAUSE.test(c) || (RHETORICAL.test(c) && !STRONG_DOUBT.test(c)))),
    );
}
export function isHandoffIntent(text: string): boolean {
  return HANDOFF_REQUEST.test(text) || HANDOFF_BARE.test(text) || isComplaint(text);
}
