// 只读成员（viewer）看到的正文打码（docs/architecture/02-conversations-workbench/spec.md「后台接口」MessageView.text、不变量 47）：
// 手机号、证件号、银行卡号只留后 4 位。只做号码类（spec 评审时定的：敏感类别的折叠留给 PIA 的结论）。
//
// 认法：一串数字（中间可以夹单个空格或连字符，每段至少 3 位，最后可以跟证件号的 X）合计 11 位以上就当号码：
// 手机号 11 位、身份证 15 / 18 位、银行卡 16–19 位、带区号的座机 11–12 位都在里面；价格、日期（2026-10-12 有 2 位的段）、
// 人数都短于 11 位，不动。前后紧挨着字母或数字的不算（订单号 ord_…、链接里的串）。除最后 4 个号码字符外的数字换成 *，分隔符原样。
// 段与段之间的分隔符必须有：可有可无的话一长串数字的切法是指数级的，客户发一串数字加一个字母就能把正则拖死
const NUMBER_RUN = /(?<![0-9A-Za-z])\d{3,}(?:[ -]\d{3,})*[Xx]?(?![0-9A-Za-z])/g;
const MIN_DIGITS = 11;

export function maskNumbers(text: string): string {
  return text.replace(NUMBER_RUN, (run) => {
    const chars = [...run];
    const idx = chars.flatMap((ch, i) => (/[0-9Xx]/.test(ch) ? [i] : []));
    if (idx.filter((i) => /\d/.test(chars[i]!)).length < MIN_DIGITS) return run;
    const keep = new Set(idx.slice(-4));
    return chars.map((ch, i) => (/\d/.test(ch) && !keep.has(i) ? '*' : ch)).join('');
  });
}
