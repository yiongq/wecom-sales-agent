// 只读成员（viewer）看到的正文打码（docs/architecture/02-conversations-workbench/spec.md「后台接口」MessageView.text、不变量 47）：
// 手机号、证件号、银行卡号只留后 4 位。只做号码类（spec 评审时定的：敏感类别的折叠留给 PIA 的结论）。
//
// 纯数字号码：一串数字（中间可以夹 1–3 个空格、点号或连字符，每段至少 3 位，最后可以跟证件号的 X）合计 11 位以上就当号码：
// 手机号 11 位、身份证 15 / 18 位、银行卡 16–19 位、带区号的座机 11–12 位都在里面；价格、日期（2026-10-12 有 2 位的段）、
// 人数都短于 11 位，不动。前后紧挨着字母或数字的不算（订单号 ord_…、链接里的串）。
// 段与段之间的分隔符必须有：可有可无的话一长串数字的切法是指数级的，客户发一串数字加一个字母就能把正则拖死。
//
// 另外两条有界规则（审查第 2 条，复现属实，取舍见 plan「实施记录 · 第 13 步」）：
// - 手机号前面可以紧挨字母（出境游客户常写「vx13812345678」「wx」代指微信），但后面不能紧挨字母或数字。
// - 护照、港澳通行证等证件号是「1–2 个字母 + 7–9 位数字」的形状（E12345678、EA1234567、C12345678），不受 11 位数字门槛限制，
//   前后也不能紧挨字母或数字，否则会把 ord_ 开头的订单号前几位截进来。
// 没做：全角数字、不规整的多段分组（「138 12 34 56 78」）——brief 没点名，范围内不展开。
const NUMBER_RUN = /(?<![0-9A-Za-z])\d{3,}(?:[ .-]{1,3}\d{3,})*[Xx]?(?![0-9A-Za-z])/g;
const PHONE_AFTER_LETTER = /(?<!\d)1[3-9]\d{9}(?![0-9A-Za-z])/g;
const ID_LETTER = /(?<![A-Za-z0-9])[A-Za-z]{1,2}\d{7,9}[Xx]?(?![A-Za-z0-9])/g;
const MIN_DIGITS = 11;

/** 除最后 4 个号码字符（数字或证件号的 X）外的数字换成 *，分隔符与字母原样 */
function maskKeepLast4(run: string): string {
  const chars = [...run];
  const idx = chars.flatMap((ch, i) => (/[0-9Xx]/.test(ch) ? [i] : []));
  const keep = new Set(idx.slice(-4));
  return chars.map((ch, i) => (/\d/.test(ch) && !keep.has(i) ? '*' : ch)).join('');
}

export function maskNumbers(text: string): string {
  // 证件号、紧挨字母的手机号：形状已经够窄，不用再按数字位数设门槛
  let out = text.replace(ID_LETTER, maskKeepLast4);
  out = out.replace(PHONE_AFTER_LETTER, maskKeepLast4);
  return out.replace(NUMBER_RUN, (run) => {
    const chars = [...run];
    const idx = chars.flatMap((ch, i) => (/[0-9Xx]/.test(ch) ? [i] : []));
    if (idx.filter((i) => /\d/.test(chars[i]!)).length < MIN_DIGITS) return run;
    return maskKeepLast4(run);
  });
}
