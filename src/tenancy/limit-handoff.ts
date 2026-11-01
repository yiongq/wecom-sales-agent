// 14 R4、R5：引擎及引擎外入站共用的额度转人工与固定回复。
import type { ChatMessage, Session } from '../types.js';
import { enterHandoff, HANDOFF_REASON } from '../handoff/record.js';
import { saveSession } from '../store.js';
import { LIMIT_QUOTA_REPLY } from './limit-replies.js';

export function limitHandoffReply(session: Session, reason: 'quota' | 'dailyCap'): ChatMessage {
  // 沿用旧镜像认识的 failure kind，新原因是普通字符串。
  enterHandoff(session, { kind: 'failure', reason: HANDOFF_REASON[reason], at: Date.now() });
  const message: ChatMessage = { role: 'agent', content: LIMIT_QUOTA_REPLY, at: Date.now() };
  session.messages.push(message);
  saveSession(session);
  return message;
}
