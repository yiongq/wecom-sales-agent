import { publicBase } from '../tenancy/hosts.js';
import type { MessagePart, Session } from './pack-api.js';
import { linkCandidates, linkDef, ownLinkPath } from './site-links.js';

/** 只投影最终文本，不清洗正文、不保存部件；有会话时才调用包的标题函数。 */
export function partsOf(text: string, base = publicBase(), session?: Session): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const { raw } of linkCandidates(text)) {
    const path = ownLinkPath(raw, base);
    const def = path === null ? undefined : linkDef(path);
    if (!def) continue;
    const title = session ? def.partTitle?.(path!, session) : undefined;
    parts.push({ kind: 'link', linkKind: def.linkKind, url: raw, ...(title == null ? {} : { title }) });
  }
  return parts;
}

/** R14 / 不变量2：在外发记录上留当时的报价状态，历史链接不会被后来撤回误判。 */
export function recordQuoteStates(message: { content: string }, session: Session): void {
  const states: Record<string, 'approved'> = {};
  for (const { raw } of linkCandidates(message.content)) {
    const path = ownLinkPath(raw, publicBase());
    const def = path === null ? undefined : linkDef(path);
    if (def?.linkKind === 'quote' && def.allowed(session, path!)) {
      const id = /^\/quote\/(ord_[0-9a-f]{24})$/.exec(path!)?.[1];
      if (id) states[id] = 'approved';
    }
  }
  if (Object.keys(states).length) Object.assign(message, { quoteStates: states });
}
