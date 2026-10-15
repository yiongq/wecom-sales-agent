// 06 R10：出口形状检查（裁剪）。阈值与可删句由包给（thresholds.shape，ShapePolicy）；本文件只有数法、受保护句判定与裁剪顺序。
// 不调模型（R11 重写推后，ReplyGuardContext.rewriteReply() 恒为 null，这里不调用）：裁完仍超限就发裁剪稿，形状里记 overLimit。
import type { ReplyGuardContext, ReplyShape, ShapePolicy } from '../pack-api.js';
import { sentenceUnits } from '../parse/sentences.js';
import { stripMarkdown } from './text.js';
import { replyStep } from './reply-step.js';

/** 行数：先去 markdown，再数非空行；「·」开头的每一项各占一行，所以与普通行同样计数。 */
export function replyLineCount(text: string): number {
  return stripMarkdown(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '').length;
}

/** 字数：先去 markdown，不计空白字符（空格、换行、制表），按码点计。 */
export function replyCharCount(text: string): number {
  return [...stripMarkdown(text).replace(/\s/g, '')].length;
}

// ---------- 识别 ----------
const AMOUNT_RE = /¥\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|万元|万)/g;
/** 句子里的金额，归一成去掉 ¥、逗号、空白、「元」的字符串 */
export function amountsOf(s: string): string[] {
  return (s.match(AMOUNT_RE) ?? []).map((a) => a.replace(/[¥,\s元]/g, ''));
}
const DATE_RE = /\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}[日号]?)?|\d{1,2}月\d{1,2}[日号]?/;
const LINK_RE = /https?:\/\/\S+|\/(?:proposal|pay|order)s?\/\S*/;
const ORDER_RE = /ord_[0-9a-f]{6,}|(?:订单|单号)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/;
const HANDOFF_RE =
  /转(?:接)?人工|交(?:给|由).{0,6}(?:同事|顾问|人工)|真人|人工(?:客服|顾问)|同事.{0,8}(?:跟进|联系|对接)|顾问.{0,6}(?:接手|跟进|联系您|转接)|转接/;
const IDENTITY_RE = /AI|人工智能|智能(?:助手|顾问|客服)|机器人|不是真人/;
const QUESTION_RE = /[？?][」』”）)～~]*$|[吗呢么][」』”）)～~]*$/;
const isQuestion = (s: string): boolean => QUESTION_RE.test(s.trim());
const BULLET_RE = /^\s*[·•]/;

// ---------- 与 repeatedQuestion 同口径的相似：去标点空白后相同，或字二元组 Jaccard ≥0.8，长度 ≥4 字 ----------
const squash = (s: string): string => s.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
function bigrams(s: string): Set<string> {
  const cs = [...s];
  const out = new Set<string>();
  for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i]! + cs[i + 1]!);
  return out;
}
function similar(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  if ([...x].length < 4 || [...y].length < 4) return false;
  if (x === y) return true;
  const ga = bigrams(x);
  const gb = bigrams(y);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter) >= 0.8;
}

interface Unit {
  text: string;
  /** 带原始空白的切片，装回去用 */
  raw: string;
  line: number;
  protectedBy: string | null;
  dropped?: boolean;
}

/** 项目符号行整行一个单位；其余行按 sentenceUnits 切句（保留方案书链接的 ?v= 版本后缀、区间波浪号） */
function splitUnits(lines: readonly string[]): Unit[] {
  const out: Unit[] = [];
  lines.forEach((line, li) => {
    if (!line.trim()) return;
    if (BULLET_RE.test(line)) {
      out.push({ text: line.trim(), raw: line, line: li, protectedBy: null });
      return;
    }
    for (const { start, end } of sentenceUnits(line)) {
      const raw = line.slice(start, end);
      if (raw.trim()) out.push({ text: raw.trim(), raw, line: li, protectedBy: null });
    }
  });
  return out;
}

function assemble(lines: readonly string[], units: readonly Unit[]): string {
  const kept = new Map<number, string>();
  for (const u of units) if (!u.dropped) kept.set(u.line, (kept.get(u.line) ?? '') + u.raw);
  const out: string[] = [];
  lines.forEach((line, li) => {
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      return;
    }
    const k = kept.get(li);
    if (k !== undefined && k.trim()) out.push(k.trimEnd());
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export interface ShapeTrimResult {
  text: string;
  trimmed: number;
}

/** 裁剪（纯函数，不碰 ctx）：按 ①重复 ②多余问句 ③包可删句 的顺序，超限才删，删到不超为止。 */
export function trimToShape(input: {
  text: string;
  lineCap: number;
  policy: ShapePolicy;
  inputText: string;
  priorReplies: readonly string[];
  /** 本会话全部 AI 回复里出现过的金额 */
  priorAmounts: ReadonlySet<string>;
  proposalSent: boolean;
  /** 本轮是否转人工或已有订单文本等：传 true 时调用方不应走到这里 */
}): ShapeTrimResult {
  const { text, lineCap, policy } = input;
  const over = (t: string): boolean => replyLineCount(t) > lineCap || replyCharCount(t) > policy.maxChars;
  if (!over(text)) return { text, trimmed: 0 };

  const lines = text.split('\n');
  const units = splitUnits(lines);
  const last3 = input.priorReplies.slice(-3);
  const last3Texts = last3.flatMap((r) => splitUnits(r.split('\n')).map((u) => u.text));
  const last3Amounts = new Set(last3.flatMap((r) => amountsOf(r)));
  const askedPrice = policy.asksPrice(input.inputText);
  const closingTurn = policy.isClosingTurn(input.inputText);

  // 受保护句
  const seenAmount = new Set<string>();
  let lastQ = -1;
  units.forEach((u, i) => {
    if (isQuestion(u.text)) lastQ = i;
  });
  units.forEach((u, i) => {
    for (const a of amountsOf(u.text)) {
      if (seenAmount.has(a)) continue;
      seenAmount.add(a);
      // 复述例外：同一金额已在最近 3 条 AI 回复里、客户这句又没问价，这句算复述，不受保护
      if (!(last3Amounts.has(a) && !askedPrice)) u.protectedBy ??= 'amount';
    }
    if (DATE_RE.test(u.text.replace(/\s+/g, ''))) u.protectedBy ??= 'date';
    if (LINK_RE.test(u.text)) u.protectedBy ??= 'link';
    if (ORDER_RE.test(u.text)) u.protectedBy ??= 'order';
    if (HANDOFF_RE.test(u.text)) u.protectedBy ??= 'handoff';
    if (IDENTITY_RE.test(u.text)) u.protectedBy ??= 'identity';
    if (policy.isRouteTitleLine(lines[u.line]!.trim()) || policy.isRouteTitleLine(u.text)) u.protectedBy ??= 'route';
    if (closingTurn && policy.isClosingLine(u.text)) u.protectedBy ??= 'closing';
    if (i === lastQ) u.protectedBy ??= 'last_question';
  });

  let trimmed = 0;
  let current = text;
  const alive = (): number => units.filter((u) => !u.dropped).length;
  const drop = (u: Unit): boolean => {
    if (u.dropped || u.protectedBy || alive() <= 1) return false;
    u.dropped = true;
    trimmed++;
    current = assemble(lines, units);
    return true;
  };
  // ① 和最近 3 条 AI 回复重复的句子
  for (const u of units) {
    if (!over(current)) break;
    if (!u.protectedBy && last3Texts.some((p) => similar(u.text, p))) drop(u);
  }
  // ② 多余的问句，只留最后一个（受保护的不删）
  units.forEach((u, i) => {
    if (!over(current)) return;
    if (i !== lastQ && isQuestion(u.text)) drop(u);
  });
  // ③ 包定义的可删句，从后往前删
  for (let i = units.length - 1; i >= 0; i--) {
    if (!over(current)) break;
    const u = units[i]!;
    if (u.dropped || u.protectedBy) continue;
    const reason = policy.droppable(u.text, {
      closingTurn,
      proposalSent: input.proposalSent,
      askedPrice,
      amounts: amountsOf(u.text),
      priorAmounts: input.priorAmounts,
    });
    if (reason) drop(u);
  }
  return { text: trimmed ? current : text, trimmed };
}

/** 核心步骤 `shape_check`：默认排在 identity 之后、takeover_check:post 之前（装载校验守着）。 */
export function shapeCheckStep<Context extends ReplyGuardContext>() {
  return replyStep<Context>('shape_check', 'identity', [], ['replyShape'], (ctx) => {
    const policy = (ctx.thresholds as { shape?: ShapePolicy } | undefined)?.shape;
    if (!policy || !ctx.text.trim()) return;
    const rich = ctx.toolSources.some((c) => policy.richTools.includes(c.name));
    // 代码整段生成的推荐 / 线路列表（rich 类且 fixedReply）有单独的上限；模型写的回复仍按 rich / plain
    const generatedList = rich && !!ctx.turn.flags.fixedReply && policy.generatedListMaxLines !== undefined;
    const lineCap = generatedList ? policy.generatedListMaxLines! : rich ? policy.richMaxLines : policy.plainMaxLines;
    // 整段由代码生成或替换的回复（订单文本、兜底话术）与转人工轮：不删句，只记形状
    const fixed = !!ctx.turn.flags.fixedReply || ctx.handoffThisTurn() || ctx.session.handedOver;
    let trimmed = 0;
    if (!fixed) {
      const prior = ctx.session.messages.filter((m) => m.role === 'agent').map((m) => m.content);
      const before = ctx.text;
      const r = trimToShape({
        text: before,
        lineCap,
        policy,
        inputText: ctx.inputText,
        priorReplies: prior,
        priorAmounts: new Set(prior.flatMap((p) => amountsOf(p))),
        proposalSent: policy.proposalSent(ctx.session),
      });
      trimmed = r.trimmed;
      if (trimmed) {
        ctx.text = r.text;
        ctx.recordGuard('shape_check', before, ctx.text, 'drop_sentence');
      }
    }
    const lines = replyLineCount(ctx.text);
    const chars = replyCharCount(ctx.text);
    const shape: ReplyShape = {
      class: rich ? 'rich' : 'plain',
      lines,
      chars,
      limit: lineCap,
      ...(generatedList ? { generatedList: true as const } : {}),
      trimmed,
      overLimit: lines > lineCap || chars > policy.maxChars,
      rewrite: 'off',
      rewriteMs: null,
    };
    ctx.turn.flags.replyShape = shape;
  });
}
