// 12 R5：每轮独立的附件能力；超时、租户退出后封住迟到的结果。
import type { AttachmentRef, DeterministicReply, IntakeKit, PackRuntime, TurnContext } from '../pack-api.js';
import { readAttachment, queueAttachmentResult } from '../../store.js';
import { readSheet } from '../sheet-read.js';
import { vision } from '../llm/vision.js';
import { currentRuntime } from '../../tenancy/runtime.js';
import { alert } from '../../ops/alert.js';
import { noteGuard } from '../../trace/recorder.js';

export const INTAKE_FAILED = '这份附件没读出来，请把型号和数量打字发来';
export const INTAKE_LIMIT = '请把型号和数量打字发来';

export async function receiveAttachment(
  runtime: PackRuntime,
  ctx: TurnContext & { attachment: AttachmentRef },
  attachmentBytes?: Uint8Array,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, currentRuntime().cancel]);
  let closed = false;
  let limited = false;
  const results: { result: unknown; intakeId: string }[] = [];
  // 包只能把本轮的状态交回；超时后继续跑的脚本拿不到正在接待的会话对象。
  const session = structuredClone(ctx.session);
  // 保留 moreQueued 的 getter；对象展开会在识别前把队列状态固化成快照。
  const intakeContext = Object.defineProperties({} as typeof ctx, Object.getOwnPropertyDescriptors(ctx));
  intakeContext.session = session;
  const bytes = async () => {
    signal.throwIfAborted();
    if (attachmentBytes !== undefined) return { ...ctx.attachment, bytes: attachmentBytes };
    const row = await readAttachment(ctx.attachment.id, true);
    signal.throwIfAborted();
    return row?.conversationId === session.id && 'bytes' in row ? row : null;
  };
  const kit: IntakeKit = {
    signal,
    async sheet() {
      if (ctx.attachment.cls !== 'sheet') return { ok: false, reason: 'corrupt' };
      const row = await bytes();
      return row?.cls === 'sheet' && row.bytes ? readSheet(row.bytes, row.name ?? '') : { ok: false, reason: 'corrupt' };
    },
    async vision(req) {
      if (ctx.attachment.cls !== 'image') return null;
      const row = await bytes();
      if (!row?.bytes || row.cls !== 'image' || (row.mime !== 'image/png' && row.mime !== 'image/jpeg')) return null;
      const result = await vision({ ...req, bytes: row.bytes, mime: row.mime, signal, sessionId: session.id });
      if (closed || signal.aborted) return null;
      if (result.ok) return result.value;
      if (result.reason === 'limit') {
        limited = true;
        alert('attachment_limit', '附件视觉识别达到当日上限，请客户改用文字提供型号和数量');
      }
      return null;
    },
    saveResult(result, intakeId) {
      if (!closed && !signal.aborted) results.push({ result: structuredClone(result), intakeId });
    },
  };
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new DOMException('intake_timeout', 'TimeoutError')), 60_000);
  let reply: DeterministicReply | null;
  let coreReply = false;
  try {
    signal.throwIfAborted();
    if (!runtime.intake?.classes.includes(ctx.attachment.cls)) throw new Error('intake_unsupported');
    reply = await Promise.race([runtime.intake.receive(intakeContext, kit), cancelled]);
    if (limited) {
      reply = { text: INTAKE_LIMIT };
      coreReply = true;
      noteGuard('intake_limit', ctx.text, INTAKE_LIMIT, 'replace');
    }
  } catch {
    reply = { text: limited ? INTAKE_LIMIT : INTAKE_FAILED };
    coreReply = true;
    noteGuard(limited ? 'intake_limit' : signal.aborted ? 'intake_timeout' : 'intake_failed', ctx.text, reply.text, 'replace');
  } finally {
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  return {
    reply,
    coreReply,
    // 仅成功的 receive 可以交回状态和结果。校验与消息追加之前不入保存队列。
    statePatch: !coreReply ? session.packState : undefined,
    commitResults() {
      if (coreReply || signal.aborted) return;
      for (const result of results) queueAttachmentResult(ctx.session.id, { id: ctx.attachment.id, ...result });
    },
  };
}
