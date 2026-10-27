import { linkCandidates } from './site-links.js';

/** 挖掉链接后只剩的标签（「· 支付链接」「方案书」「2. 付款入口」「这是您的专属支付链接」「👉 立即支付」）。
 *  标签本是给链接起的名字，链接改走卡片后它独占一行、后面什么都没有——卡片要等整段正文发完才到，
 *  客户读到这里会以为链接漏发了。前面可以带列表序号和「这是您的专属」这类修饰 */
const LINK_LABEL_RE = new RegExp(
  '^(?:\\d{1,2}\\s*[.、．)）]\\s*|[①-⑩]\\s*)?(?:这是|这里是)?(?:您|你)?的?(?:专属)?的?(?:本单|订单)?的?' +
    '(?:(?:支付|付款|订单|下单)(?:链接|入口|页面|地址)?|(?:立即|马上|去|点击)(?:支付|付款)' +
    '|(?:详细|完整)?的?(?:行程)?(?:方案书?|计划书|行程单)(?:链接|地址)?|(?:详细|完整)?的?行程|(?:方案|行程)?链接)$',
);
/** 列表序号开头的：整行删掉会让「1. 2. 3.」断号，改成「2. 支付链接见下方卡片」 */
const NUMBERED_RE = /^(?:\d{1,2}\s*[.、．)）]|[①-⑩])/;
const linkLabelCore = (s: string): string => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
/** 标签后面跟着的括注（「支付链接（名额以付款为准）」「方案书（含逐日行程）。」）：只是说明，不改变这一行是个标签。
 *  此前带括注的认不出是标签，链接改走卡片后留下一行「支付链接（名额以付款为准）。」，指向空气（A09/C03） */
const LABEL_NOTE_RE = /\s*[（(][^（）()\n]{1,24}[）)][\s。.！!～~]*$/;
const isLinkLabel = (s: string): boolean =>
  LINK_LABEL_RE.test(linkLabelCore(s)) || LINK_LABEL_RE.test(linkLabelCore(s.replace(LABEL_NOTE_RE, '')));
/** 标签带着括注：括注是要留给客户的话（「24 小时内有效」「名额以付款为准」），不能整行删，改成指着卡片 */
const notedLabel = (s: string): boolean => LABEL_NOTE_RE.test(s) && !LINK_LABEL_RE.test(linkLabelCore(s)) && isLinkLabel(s);
/** 标签改成指着卡片，括注挪到后面：「2. 支付链接（24 小时内有效）」→「2. 支付链接见下方卡片（24 小时内有效）」 */
function labelToCard(s: string): string {
  const note = LABEL_NOTE_RE.exec(s)?.[0] ?? '';
  return `${s.slice(0, s.length - note.length)}见下方卡片${note.trim().replace(/[。.！!～~]+$/, '')}`;
}
/** 紧挨着链接、指着它的符号（「点这里付款 👉 <url>」「<url> 👈」）：链接挖走后一并拿掉，留着就是指向空气 */
const POINTER_BEFORE_RE = /(?:\s*(?:👉|👈|👇|➡️?|⬇️?|→|↓))+\s*$/u;
const POINTER_AFTER_RE = /^\s*(?:(?:👉|👈|👇|➡️?|⬇️?|→|↓)\s*)+/u;

/** 把指着链接的说法改成指着卡片。「在这儿」「如下」「点这里」原本指的是紧跟着的那串网址，
 *  网址挖走后就指向了空气；「发您」「做好了」收尾的补一句「见下方卡片」，客户知道东西在后面 */
function pointToCard(s: string, title?: string): string {
  if (!s || /下方|卡片/.test(s)) return s; // 模型已经这么写了，别再补一遍
  // 「支付链接：<url>（24 小时内有效）」：标签后面还跟着话，整行删不得，标签改成指着卡片
  if (isLinkLabel(s)) return labelToCard(s);
  const tap = s.replace(/(?:点击|点|戳)(?:这里|这儿|此处)/, '点下方卡片');
  if (tap !== s) return tap;
  // 「付款请点：<url>」：只认付款/请 + 点，「景点」「重点」这类收尾不能接「下方卡片」
  if (/(?:请|烦请|麻烦|支付|付款)点击?$/.test(s)) return `${s}下方卡片`;
  // 只认「方案/链接…在这儿」这种名词带指代的说法：「我放在这里」这类动词短语换掉会变成病句
  const here = s.replace(
    /(方案书?|计划书?|行程单?|链接|入口|明细|详情)(?:就|都)?(?:在这里|在这儿|在这|如下)(?=$|[，,。！!～~；;])/,
    '$1见下方卡片',
  );
  if (here !== s) return here;
  if (/(?:发(?:给)?您|给您|(?:做|生成|准备|整理|出)好了?|已生成)(?:看看|过目)?(?:了|啦)?$/.test(s)) return `${s}，见下方卡片`;
  // 带标题的网页部件为其余引导语补上指代；企微不传标题，保留原输出。
  return title && !linkCandidates(s).length ? `${s}，见下方卡片` : s;
}

/** 从正文里挖掉那条 URL，保留同一行的其余内容。
 *  不能按整行删——链接常和报价写在一起（「方案书在这 <url> 人均 15,800」），
 *  整行删会把报价一起删掉，客户只收到一张卡片、正文凭空少一句。 */
export function stripLink(body: string, raw: string, title?: string): string {
  const tidy = (s: string) => s.replace(/[ \t]{2,}/g, ' ').replace(/^[\s，,：:、]+|[\s，,：:、]+$/g, '');
  const lines: (string | null)[] = body.split('\n'); // null = 整行拿掉（与原文里的空行区分开，段落间距照旧）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null) continue;
    // 网页按完整部件匹配，不能从完整地址或外站地址里挖走相同的相对路径。
    const at = title === undefined ? line.indexOf(raw) : (linkCandidates(line).find((link) => link.raw === raw)?.index ?? -1);
    if (at < 0) continue;
    const beforeRaw = line.slice(0, at).replace(POINTER_BEFORE_RE, (m) => (/^\s/.test(m) ? ' ' : ''));
    const afterRaw = line.slice(at + raw.length).replace(POINTER_AFTER_RE, (m) => (/\s$/.test(m) ? ' ' : ''));
    // 冒号原本指着链接，后面紧跟逗号或括号时就悬空了（「总价：，30 分钟内有效」）
    const rest = tidy(beforeRaw + afterRaw)
      .replace(/[：:][ \t]*([，,、；;])/, '$1')
      .replace(/[：:][ \t]*(?=[（(])/, '');
    const core = linkLabelCore(rest);
    // 「支付链接（名额以付款为准）：<url>」「· 支付链接：<url>（24 小时内有效）」：剩下的是标签加括注，标签改成指着卡片，括注留着
    if (notedLabel(rest)) {
      lines[i] = labelToCard(rest);
      continue;
    }
    if (core && !isLinkLabel(rest)) {
      const before = tidy(beforeRaw);
      const after = tidy(afterRaw);
      const pointed = pointToCard(before, title);
      if (pointed === before) lines[i] = rest;
      // 后面只剩表情（「😊」）不加逗号；句读、括号开头的直接接
      else if (!after) lines[i] = pointed;
      else if (!/[\p{L}\p{N}]/u.test(after)) lines[i] = `${pointed} ${after}`;
      else lines[i] = pointed + (/^[。！!？?～~（(]/.test(after) ? '' : '，') + after;
      continue;
    }
    if (core && NUMBERED_RE.test(core)) {
      lines[i] = labelToCard(rest);
      continue;
    }
    // 链接独占一行、或只剩「👉」「·」这类符号、或只剩「支付链接」这类标签：整行拿掉，再看上一行：
    //  · 上一行也只是个标签（「· 支付链接：」换行接链接）：同样整行拿掉，此前留下「· 支付链接。」；
    //    带序号、带括注的（「支付链接（名额以付款为准）：」）不删，改成指着卡片；
    //  · 上一行以冒号收尾：冒号原本指着这条链接，链接改走卡片后就指向了空气（「费用明细：」后面接一句不相干的话），
    //    换成句号，「详细方案书在这儿，…：」「方案给您做好了：」这种再改成指着卡片；
    //  · 紧挨着的上一行没冒号、但在指着链接（「详细方案书发您」换行接链接）：同样改成指着卡片
    lines[i] = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j];
      if (prev === null || !prev.trim()) continue;
      const colon = /[：:]\s*$/.test(prev);
      const p = prev.replace(/[：:]?\s*$/, '');
      if ((colon || j === i - 1) && isLinkLabel(p)) lines[j] = NUMBERED_RE.test(linkLabelCore(p)) || notedLabel(p) ? labelToCard(p) : null;
      else if (colon) lines[j] = `${pointToCard(p, title)}。`;
      else if (j === i - 1) lines[j] = pointToCard(p, title);
      break;
    }
  }
  return lines
    .filter((l): l is string => l !== null)
    .map((l) => (l.trim() ? l : ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
