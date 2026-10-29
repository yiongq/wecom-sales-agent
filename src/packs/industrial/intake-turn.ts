// 12 R9 / R10：识别清单的文字修订、确认判定与确认后的试算行；只消费清洗后的 rfqIntake，不碰附件原文。
import type { DeterministicReply, PackSources, Session, TurnContext } from '../../core/pack-api.js';
import { PartSchema, type Part } from './catalog.js';
import {
  cleanIntakePartNo,
  intakeQuantity,
  intakeUnreadNote,
  renderIntake,
  INTAKE_FIXED,
  INTAKE_FOOTER,
  INTAKE_RANGE_NOTE,
} from './intake.js';
import { matchInMemory } from './match.js';
import { normalizePartNo } from './normalize.js';
import { latestQuoteCandidate } from './quote-candidate.js';
import { pendingIntake, readState, writeState, type RfqIntake } from './state.js';

export function intakeParts(sources: Pick<PackSources, 'currentCatalog'>): Part[] {
  return (sources.currentCatalog().items.part ?? []).map((part) => PartSchema.parse(part));
}

/** R2 / R9 第 0 条：企微超过 20 MB 的文件只会变成一条内容就是原文件名的文字；必须是整条消息、不带句内标点。 */
const FILE_NAME =
  /^[^\n\r\\/:*?"<>|，。！？；：、,;!?]{1,100}\.(?:xlsx|xls|csv|pdf|docx?|pptx?|wps|et|zip|rar|7z|dwg|dxf|dwf|stp|step|igs|iges|jpe?g|png|txt)$/iu;
export function isOversizedHint(text: string): boolean {
  return FILE_NAME.test(text.trim());
}

/** R9 第 1 条：整句以「第N行」或「删第N行」开头。 */
const EDIT = /^\s*(删除|删掉|删)?\s*第\s*(\d{1,6})\s*行\s*([\s\S]*?)\s*$/u;
/** 全角数字与字母先折成半角，其余按原文。 */
const half = (text: string) => text.normalize('NFKC');
export function isIntakeEdit(text: string): boolean {
  return EDIT.test(half(text));
}
const VERB = /^(?:改成|改为|换成|换为|选择|选|改|换)\s*/u;
// 只改数量：「50件」或「数量 50」；单独一个数字是型号（6205），不是数量。
const QTY_ONLY = /^(?:(-?\d+(?:\.\d+)?)\s*(?:件|个|套|pcs)|数量\s*(?:改成|改为|换成|是|为)?\s*(-?\d+(?:\.\d+)?)\s*(?:件|个|套|pcs)?)$/iu;
const TRAILING_QTY = /^([\s\S]*?)(?:\s*[,，;；:：]\s*|\s+|(?<=\p{Script=Han}))(-?\d+(?:\.\d+)?)\s*(?:件|个|套|pcs)?$/iu;

/** 改完的清单连同新展示的条目一起过 writeState，算出整份 packState；不直接改会话，由引擎随回复保存。 */
function patchOf(session: Session, intake: RfqIntake, shown: readonly Part[]): Record<string, unknown> {
  const scratch = { packState: structuredClone(session.packState ?? {}) } as unknown as Session;
  writeState(scratch, { rfqIntake: intake }, shown);
  return scratch.packState as Record<string, unknown>;
}

function listReply(intake: RfqIntake, parts: readonly Part[], note?: string, statePatch?: Record<string, unknown>): DeterministicReply {
  return { fixedId: 'industrial.intake.list', text: renderIntake(intake, parts, note), ...(statePatch ? { statePatch } : {}) };
}

/** R9 改行：第N行改型号 / 数量、删行；改完整份重新渲染，N 超出或这一句读不出来时清单不变并加一句提示。 */
export function editIntake(session: Session, text: string, parts: readonly Part[]): DeterministicReply | null {
  const current = pendingIntake(session);
  const match = EDIT.exec(half(text));
  if (!current || !match) return null;
  const n = Number(match[2]);
  const rest = match[3]!.replace(/[。.!！~～]+$/u, '').trim();
  const line = current.lines[n - 1];
  if (!line) return listReply(current, parts, INTAKE_RANGE_NOTE);
  const intake = structuredClone(current);
  let shown: Part[] = [];
  if (match[1]) {
    if (rest && !/^(?:吧|谢谢|谢了)$/u.test(rest)) return listReply(current, parts, intakeUnreadNote(n));
    intake.lines.splice(n - 1, 1);
    if (!intake.lines.length)
      return {
        fixedId: 'industrial.intake.cleared',
        text: INTAKE_FIXED.cleared,
        statePatch: patchOf(session, { ...intake, status: 'superseded' }, []),
      };
  } else {
    const body = rest.replace(VERB, '');
    const qtyOnly = QTY_ONLY.exec(body);
    const trailing = qtyOnly ? null : TRAILING_QTY.exec(body);
    const q = qtyOnly ? line.q : cleanIntakePartNo(trailing ? trailing[1]! : body);
    if (!q) return listReply(current, parts, intakeUnreadNote(n));
    const qty = qtyOnly ? intakeQuantity(qtyOnly[1] ?? qtyOnly[2]!) : trailing ? intakeQuantity(trailing[2]!) : line.qty;
    const found = matchInMemory(normalizePartNo(q), parts);
    intake.lines[n - 1] = { q, qty, m: qty === null ? 'bad_qty' : found.match };
    shown = found.parts;
  }
  return listReply(intake, parts, undefined, patchOf(session, intake, shown));
}

/** R9 判定的第 0、1 条，排在 10 原有判定之前。 */
export function intakePreModel(ctx: TurnContext, sources: Pick<PackSources, 'currentCatalog'>): DeterministicReply | null {
  if (isOversizedHint(ctx.text)) return { text: INTAKE_FIXED.oversized, fixedId: 'industrial.intake.oversized' };
  if (isIntakeEdit(ctx.text) && pendingIntake(ctx.session)) return editIntake(ctx.session, ctx.text, intakeParts(sources));
  return null;
}

const EXPLICIT = /^(?:确认|确认无误|按这个报|就这些)$/u;
const GENERAL = /^(?:对的|是的|没问题|可以)$/u;
/**
 * R9 确认：明确说法在清单待确认时就算；泛化肯定只有上一条 AI 消息就是这份清单时才算。
 * 都必须整句、允许句末标点，所以带否定或问号的句子天然不匹配。
 */
export function confirmsIntake(session: Session, text: string): boolean {
  const intake = pendingIntake(session);
  if (!intake) return false;
  const sentence = text
    .trim()
    .replace(/[。.!！~～,，；;]+$/u, '')
    .trim();
  if (EXPLICIT.test(sentence)) return true;
  if (!GENERAL.test(sentence)) return false;
  const reply = session.messages.findLastIndex((message) => message.role === 'agent');
  const message = session.messages[reply];
  if (!message || message.at < intake.at) return false;
  // 清单之后又来了新附件，那份还没回复：客户看到的不是现在这份清单。
  if (reply < session.messages.findLastIndex((m) => m.role === 'customer' && !!m.attachment)) return false;
  return (
    message.content.includes(`从您发来的询价单里认出 ${intake.lines.length} 行，请核对：\n`) && message.content.endsWith(INTAKE_FOOTER)
  );
}

/** 确认那一轮试算的行（q 重新匹配，试算时不再精确的算未匹配）和要通知顾问的行号。 */
export function intakeQuoteLines(intake: RfqIntake, parts: readonly Part[]) {
  const items: { query: string; qty: number }[] = [];
  const unmatched: number[] = [];
  intake.lines.forEach((line, i) => {
    if (line.m === 'exact' && line.qty !== null && matchInMemory(normalizePartNo(line.q), parts).match === 'exact')
      items.push({ query: line.q, qty: line.qty });
    else unmatched.push(i + 1);
  });
  return { items, unmatched };
}
/** beforeTool：入参恰好等于确认的那几行。 */
export function sameQuoteItems(args: unknown, expected: readonly { query: string; qty: number }[]): boolean {
  if (!args || typeof args !== 'object' || Object.keys(args).length !== 1) return false;
  const items = (args as { items?: unknown }).items;
  return (
    Array.isArray(items) &&
    items.length === expected.length &&
    items.every(
      (item: Record<string, unknown> | null, i) =>
        !!item && Object.keys(item).length === 2 && item.query === expected[i]!.query && item.qty === expected[i]!.qty,
    )
  );
}

/** R9 候选比较：待确认的清单比最新的报价候选（试算或报价单）更新。 */
export function intakeNewer(session: Session, now: number): boolean {
  const intake = pendingIntake(session);
  if (!intake) return false;
  const candidate = latestQuoteCandidate(session, now);
  return !candidate || intake.at > candidate.at;
}

/** contextNote：清单摘要与当前该怎么回；确认那一轮告诉模型哪几行不报价（试算结果在预取里）。 */
export function intakeNotes(session: Session, text: string, sources: Pick<PackSources, 'currentCatalog'>): string[] {
  const intake = readState(session).rfqIntake;
  if (!intake) return [];
  const summary = `识别清单摘要：${JSON.stringify(intake)}`;
  if (intake.status !== 'pending') return [summary];
  if (!confirmsIntake(session, text)) return [summary, '识别清单还没确认，只能请客户确认或改行'];
  const { items, unmatched } = intakeQuoteLines(intake, intakeParts(sources));
  return [
    summary,
    items.length
      ? '客户刚确认了识别清单：已匹配的行已按清单试算（见预取结果），据结果报价，不要改数量、不要另查型号、不起草正式报价单'
      : '客户刚确认了识别清单，但没有可试算的行：说明顾问会核对，不要报价',
    ...(unmatched.length ? [`清单第${unmatched.join('、')}行不报价，已通知顾问核对，请向客户说明`] : []),
  ];
}
