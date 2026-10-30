// 12 R1 / R4：渠道中立的接收入口。只准备待提交的行，由引擎随客户消息保存。
import { createHash, randomBytes } from 'node:crypto';
import { classifyAttachment, sniffAttachment, stripImageMetadata } from './attachments.js';
import type { AttachmentItem } from '../db/repo/attachments.js';
import type { AttachmentRef } from '../shared/channel-types.js';
import { readAttachmentUsage } from '../store.js';
import { numEnv, todayIso } from '../env.js';
import { alert } from '../ops/alert.js';
import { TenantLocal } from '../tenancy/local-state.js';
import { currentRuntime } from '../tenancy/runtime.js';
import { registerTenantState } from '../tenancy/state.js';

interface DayCount {
  day: string;
  count: number;
  ready: Promise<void> | null;
}
const counts = new TenantLocal(() => ({ current: null as DayCount | null }));
registerTenantState({ name: 'attachment.daily', ...counts.registration((s) => (s.current ? 1 : 0)) });

/** 每租户每天只读一次基数；等待者醒来后同步预占，避免把已提交份数重复相加。
 * 成本护栏而非计费：仅准备失败退还，成功后不随落库结果回退；重启重新读库。
 */
async function reserveAttachment(): Promise<(() => void) | null> {
  const rt = currentRuntime();
  const state = counts.get();
  for (;;) {
    if (!counts.owns(rt, state) || rt.cancel.aborted) throw new Error('tenant_closing');
    const day = todayIso();
    if (state.current?.day !== day) state.current = { day, count: 0, ready: null };
    const current = state.current;
    if (!current.ready) {
      current.ready = readAttachmentUsage(new Date())
        .then(({ count }) => {
          if (counts.owns(rt, state) && state.current === current && !rt.cancel.aborted) current.count = count;
        })
        .catch((error: unknown) => {
          if (state.current === current) current.ready = null;
          throw error;
        });
    }
    await current.ready;
    if (!counts.owns(rt, state) || rt.cancel.aborted) throw new Error('tenant_closing');
    if (state.current !== current || current.day !== todayIso()) continue;
    if (current.count >= Math.max(0, Math.floor(numEnv('ATTACHMENT_DAILY_PER_TENANT', 300)))) return null;
    current.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (counts.owns(rt, state) && state.current === current) current.count--;
    };
  }
}

export interface AttachmentInput {
  bytes: Uint8Array;
  name: string | null;
  msgtype?: string;
  channel: 'wecom' | 'web';
  sourceKey: string;
  /** received 重放遇到已提交的唯一键时，沿用原来的引用。 */
  id?: string;
}
export interface PreparedAttachment {
  attachment: AttachmentRef;
  attachmentItem: AttachmentItem;
  attachmentBytes?: Uint8Array;
}
export type AttachmentIntakeResult = { ok: true; value: PreparedAttachment } | { ok: false; text: string; cls: AttachmentRef['cls'] };

export function attachmentName(name: string | null): string | null {
  if (name === null) return null;
  const chars = Array.from(name.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ''));
  // 保留扩展名，CSV 的确定性读取仍需它；总长度始终不超过 100 个可显示字符。
  const extension = /\.[a-z0-9]{1,10}$/i.exec(chars.join(''))?.[0] ?? '';
  return chars.length <= 100 ? chars.join('') : chars.slice(0, 100 - extension.length).join('') + extension;
}

/** 下载只看前 64 KiB 与响应长度；流式下载无长度时由调用方传累计字节数。 */
export function earlyAttachment(prefix: Uint8Array, contentLength: number | null) {
  const sniff = sniffAttachment(prefix, contentLength);
  return {
    abort: sniff.tooLarge,
    maxBytes: sniff.maxBytes,
    metadata: { cls: 'other' as const, mime: 'application/octet-stream', size: contentLength ?? prefix.length, sha256: null },
  };
}

/** early 为下载已中断的元数据：绝不把前缀当作原件、也不对前缀计算 sha256。 */
export async function prepareAttachment(
  input: AttachmentInput,
  early?: ReturnType<typeof earlyAttachment>['metadata'],
): Promise<AttachmentIntakeResult> {
  const name = attachmentName(input.name);
  let kind = early ?? classifyAttachment(input.bytes, name, input.msgtype);
  let bytes = input.bytes;
  if (kind.cls === 'image') {
    const stripped = stripImageMetadata(bytes);
    if (stripped.ok) bytes = stripped.bytes;
    else kind = { cls: 'other', mime: 'application/octet-stream' };
  }
  const releaseReservation = await reserveAttachment();
  if (!releaseReservation) {
    alert('attachment_limit', '附件达到当日份数上限，请客户改用文字提供型号和数量');
    return { ok: false, text: '请把型号和数量打字发来', cls: kind.cls };
  }
  try {
    const stored = kind.cls === 'image' || kind.cls === 'sheet';
    const attachment: AttachmentRef = {
      id: input.id ?? `att_${randomBytes(12).toString('hex')}`,
      cls: kind.cls,
      mime: kind.mime,
      name,
      size: early?.size ?? bytes.byteLength,
      stored,
    };
    return {
      ok: true,
      value: {
        attachment,
        attachmentItem: {
          id: attachment.id,
          cls: attachment.cls,
          mime: attachment.mime,
          name,
          size: attachment.size,
          channel: input.channel,
          sourceKey: input.sourceKey,
          sha256: early ? null : createHash('sha256').update(bytes).digest('hex'),
          bytes: stored ? bytes : null,
          intakeId: null,
          result: null,
          createdAt: Date.now(),
        },
        ...(stored ? { attachmentBytes: bytes } : {}),
      },
    };
  } catch (error) {
    releaseReservation();
    throw error;
  }
}
