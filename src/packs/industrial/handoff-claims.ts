import { cleanText, expandedReply, replyStep, sentenceUnits, type ReplyGuardContext, type Session } from '../../core/pack-api.js';
import { trimRfq, TRIM_FALLBACK } from './guards.js';
import { isHandoffIntent } from './handoff-intent.js';

// 工业包独立词表：完成式转接与普通报价审批分开；提议、条件、否定、疑问和转述不算已转。
const TRANSFER = /(?:转(?:接|交|给|至|到)?(?:给|到)?|(?<!提)交给)(?:销售|专属|采购)?(?:顾问|人工|真人|专人|同事)/;
const SUBMITTED = /提交(?:给|至)(?:顾问|人工|真人|专人|同事)/;
const TAKEN_OVER = /(?:顾问|人工|真人|专人|同事)已(?:经)?接手/;
const CONDITIONAL = /如果|如需|假如|要是|需要的话|的话/;
const NOT_DONE =
  /如果|如需|假如|要是|需要的话|的话|可以|将会|将要|准备|打算|稍后|待会|还没|尚未|没有|并未|并没有|不曾|未曾|不是|并非|不会|不能|不再|是否|有没有|您说|您提到|您问|例如|比如/;
const ASK = /[？?]|[吗么呢][。！!\s]*$/;
const CONTACT_NOTICE =
  /(?:顾问|人工|真人|专人|同事)[^。！？!?；;\n]{0,18}(?:继续确认|继续跟您核对|核对处理|接手|跟进|联系您|与您联系|跟您联系|与您对接)/;
const CONDITIONAL_NOTICE = /如果|如需|假如|要是|需要的话|的话|可以|还没|尚未|没有|并未|不是|不会|不能|未接手|是否|您说|您提到|例如|比如/;
const DECLINED =
  /(?:不用|不要|不需要|无需|不必|不想|先别|别|暂不)[^，,。！？!?；;\n]{0,10}(?:转|顾问|人工|真人|专人)|(?:稍后|以后|下次|晚点)再转|(?:还是|先)你(?:来|帮我)|^\s*(?:不用了?|先不用|暂时不用|先不了|算了)(?:[，,。！!\s]|$)/;
const REQUEST = /(?:请|让|叫|找|联系|安排|麻烦)(?:一位|一名|个|位)?(?:顾问|人工|真人|专人|同事)/;
const AGREED = /^(?:好(?:的)?|可以|行|同意|没问题|那就这样|就这样|麻烦了)(?:[，,。！!\s]|$)/;
const FOLLOWUP = '这个我记下了，会请顾问跟您确认。';

function units(text: string): string[] {
  return sentenceUnits(text).map(({ start, end }) => text.slice(start, end));
}

function completed(unit: string): boolean {
  const takeover = TAKEN_OVER.exec(unit);
  const match = takeover ?? TRANSFER.exec(unit) ?? (!/报价单|审核|审批/.test(unit) ? SUBMITTED.exec(unit) : null);
  if (!match || ASK.test(unit)) return false;
  if (
    !takeover &&
    !/已(?:经)?[^，,。！？!?；;\n]{0,60}$/.test(unit.slice(0, match.index)) &&
    !/^(?:了|成功|完成)/.test(unit.slice(match.index + match[0].length))
  )
    return false;
  // 否定只修饰当前小句，条件可跨逗号；「目录没有这个型号，已转顾问」不能因前半句被漏判。
  const prefix = unit.slice(0, match.index);
  return !CONDITIONAL.test(prefix) && !NOT_DONE.test(prefix.split(/[，,；;]/).at(-1)! + match[0]);
}

export function claimsIndustrialHandoff(text: string): boolean {
  return units(text).some(completed);
}

export function hasIndustrialHandoffNotice(text: string): boolean {
  return units(text).some((unit) => {
    // 这里只用于已转人工的轮：前半句虽带「的话」，后半句明确说「我已转给顾问」时不重复补告知。
    // 是否因空头承诺进入转人工仍由 claimsIndustrialHandoff 按完整条件句判断。
    if (completed(unit) || unit.split(/[，,]/).some(completed)) return true;
    const transfer = TRANSFER.exec(unit);
    if (transfer && !ASK.test(unit)) {
      const prefix = unit.slice(0, transfer.index);
      const clause = prefix.split(/[，,；;]/).at(-1)!;
      // 工具已经转成功时，「正在为您转接」也是告知；这类现在时不能反过来触发 claimed。
      if (!CONDITIONAL.test(prefix) && !NOT_DONE.test(clause) && !/需要|希望|建议|或者|要不要|请您|请把|请将|[不没未]$/.test(clause))
        return true;
    }
    const match = CONTACT_NOTICE.exec(unit);
    if (!match || ASK.test(unit)) return false;
    const prefix = unit.slice(0, match.index);
    return !CONDITIONAL.test(prefix) && !CONDITIONAL_NOTICE.test(prefix.split(/[，,；;]/).at(-1)! + match[0]);
  });
}

function requestsPerson(text: string): boolean {
  if (DECLINED.test(text)) return false;
  if (isHandoffIntent(text)) return true;
  return units(text).some(
    (unit) =>
      !CONDITIONAL.test(unit) &&
      unit.split(/[，,；;]/).some((clause) => {
        const match = TRANSFER.exec(clause) ?? REQUEST.exec(clause);
        return !!match && !/有需要|需要时|以后|下次|之前|上次|昨天|已(?:经)?|是否已/.test(clause.slice(0, match.index));
      }),
  );
}

function agreesToOffer(text: string, previous: string): boolean {
  return AGREED.test(text.trim()) && !DECLINED.test(previous) && TRANSFER.test(previous);
}

function wantsHandoff(session: Session, input: string): boolean {
  if (DECLINED.test(input)) return false;
  if (requestsPerson(input)) return true;
  // 引擎已追加本轮客户消息；只看上一轮请求/同意，不能捞更早的同意来覆盖现在的选择。
  const history = session.messages.filter((message) => message.role === 'customer' || message.role === 'agent');
  if (history.at(-1)?.role === 'customer' && history.at(-1)?.content === input) history.pop();
  if (agreesToOffer(input, history.at(-1)?.role === 'agent' ? history.at(-1)!.content : '')) return true;
  const previous = history.findLastIndex((message) => message.role === 'customer');
  if (previous < 0) return false;
  const text = history[previous]!.content;
  return requestsPerson(text) || agreesToOffer(text, history[previous - 1]?.role === 'agent' ? history[previous - 1]!.content : '');
}

/** rfq_trim 已跑过；补告知仍按展开块后的预算裁正文，块不改，告知放首句以免尾部裁剪再删掉。 */
function withNotice(ctx: ReplyGuardContext, body: string, notice: string): string {
  const text = trimRfq(
    [notice, body].filter(Boolean).join('\n'),
    [],
    false,
    (value) => expandedReply(ctx, value),
    () => false,
  );
  return text === TRIM_FALLBACK || !text.startsWith(notice) ? notice : text;
}

export function industrialHandoffClaimsStep() {
  return replyStep('handoff_claims', 'rfq_trim', ['blocksSuppressed', 'emptyModelReply'], ['handedOverSelfDecided'], (ctx) => {
    if (ctx.takenOver()) return;
    // 已转人工的旧会话由引擎静默返回；跟进表不注册这一步。
    if (ctx.session.handedOver) {
      if (!ctx.handoffThisTurn()) return;
      // 放块还会删正文里的商品金额句：按实际展开后的文本判断，避免告知在最后一步再次丢失。
      if (hasIndustrialHandoffNotice(expandedReply(ctx))) return;
      const before = ctx.text;
      ctx.text = withNotice(ctx, ctx.text, ctx.handoffReply(ctx.session, ctx.inputText, 'request'));
      ctx.recordGuard('handoff_claims', before, ctx.text, 'append');
      return;
    }
    if (!claimsIndustrialHandoff(ctx.text)) return;
    if (!ctx.handoffDeclined && wantsHandoff(ctx.session, ctx.inputText)) {
      const reason = '客户本轮或上一轮要求或同意转人工，回复已声称转交顾问但未调用工具';
      ctx.enterHandoff({ kind: 'claimed', at: Date.now(), reason, quote: cleanText(ctx.inputText, 200) });
      ctx.turn.flags.handedOverSelfDecided = true;
      ctx.appendMessage({ role: 'system', content: `AI 已转人工：${reason}`, at: Date.now() });
      if (!hasIndustrialHandoffNotice(expandedReply(ctx))) {
        const before = ctx.text;
        ctx.text = withNotice(ctx, ctx.text, ctx.handoffReply(ctx.session, ctx.inputText, 'request'));
        ctx.recordGuard('handoff_claims', before, ctx.text, 'append');
      }
      return { action: 'handoff', text: ctx.text, reason };
    }
    const before = ctx.text;
    const kept = units(ctx.text)
      .filter((unit) => !completed(unit))
      .join('')
      .trim();
    ctx.text = /顾问[^。！？\n]{0,12}(?:确认|核实|联系)/.test(kept) ? kept : withNotice(ctx, kept, FOLLOWUP);
    ctx.recordGuard('handoff_claims', before, ctx.text, 'patch');
    ctx.appendMessage({
      role: 'system',
      content: `待顾问跟进：客户问「${cleanText(ctx.inputText, 60)}」，AI 答应请顾问确认（未转人工）`,
      at: Date.now(),
    });
  });
}
