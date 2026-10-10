import type { MessagePart } from './pack-api.js';

/** R15：只投影最终文本，不清洗正文、不读取会话、不保存部件。 */
export function partsOf(text: string, base = process.env.PUBLIC_BASE_URL ?? ''): MessagePart[] {
  const parts: MessagePart[] = [];
  const ownBase = base.replace(/\/+$/, '');
  // 消费完整 URL，避免把站外 URL 或伪协议里的站内路径单独挖出来。
  const candidates = /(?:[a-z][a-z\d+.-]*:|\/\/|\/)[^\s<>"'`，。！？；、（）【】]+/gi;
  const sitePath = /^\/(?:pay\/[A-Za-z0-9_-]+|proposal\/[A-Za-z0-9_-]+(?:\/[\d-]+)*(?:\?v=\d+)?|privacy)$/;
  for (const match of text.matchAll(candidates)) {
    const raw = match[0];
    if (match.index > 0 && /[\w./:@%\\-]/.test(text[match.index - 1]!)) continue;
    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
      if (!ownBase || !raw.startsWith(`${ownBase}/`)) continue;
      try {
        const url = new URL(raw);
        const own = new URL(ownBase);
        if (!/^https?:$/.test(own.protocol) || url.origin !== own.origin || url.username || url.password) continue;
      } catch {
        continue;
      }
      path = raw.slice(ownBase.length);
    }
    if (!sitePath.test(path)) continue;
    parts.push({
      kind: 'link',
      linkKind: path.startsWith('/pay/') ? 'order' : path.startsWith('/proposal/') ? 'proposal' : 'site',
      url: raw,
    });
  }
  return parts;
}
