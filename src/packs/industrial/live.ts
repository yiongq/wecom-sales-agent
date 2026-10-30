import type { PackSources, Session } from '../../core/pack-api.js';
import { normalizePartNo } from './normalize.js';

type Availability = ReturnType<PackSources['erp']['fresh']>;

/** 实时库存只覆盖 stock；价格、交期与产品库对象保持原样。 */
export function live<T extends Readonly<Record<string, unknown>>>(part: T, a?: Availability): T {
  return a ? { ...part, stock: a.onHand } : part;
}

/** 调用点先门控；失败继续按产品库回答，仅给顾问留系统消息。 */
export async function refreshParts(sources: PackSources, parts: readonly { partNo: string }[], session?: Session): Promise<void> {
  const codes = [...new Set(parts.map((part) => normalizePartNo(part.partNo)))].slice(0, 30);
  if (!codes.length) return;
  try {
    await sources.erp.availability('part', codes);
  } catch {
    // ERP 失败不能中断询价，也不能把外部错误文字带进会话。
  }
  if (!session) return;
  const missing = codes.filter((code) => sources.erp.mapped('part', code) && !sources.erp.fresh('part', code)).length;
  const at = Date.now();
  const prefix = 'ERP 这次没查到 ';
  if (
    missing &&
    !session.messages.some((message) => message.role === 'system' && message.content.startsWith(prefix) && at - message.at < 30 * 60_000)
  ) {
    session.messages.push({ role: 'system', content: `${prefix}${missing} 个型号的库存，按产品库的库存回答`, at });
  }
}
