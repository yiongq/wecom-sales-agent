// 通用术语替换算法，词表由包提供。
import type { DejargonVocab } from '../pack-api.js';
import { convLabel } from '../../log.js';
export function dejargon(text: string, sessionId: string, vocab: DejargonVocab): string {
  const { english: EN_JARGON, internal: INTERNAL_TERMS } = vocab;
  // 先把站内链接挖出来，避免路径里的英文被当成夹带词
  const links: string[] = [];
  let masked = text.replace(/\/(?:proposal|pay)\/\S+/g, (m) => {
    links.push(m);
    return `\u0000${links.length - 1}\u0000`;
  });
  const hit: string[] = [];
  masked = masked.replace(/(^|[^A-Za-z])([A-Za-z]{2,})(?=[^A-Za-z]|$)/g, (full, pre: string, word: string) => {
    const zh = EN_JARGON[word.toLowerCase()];
    if (!zh) return full;
    hit.push(word);
    return pre + zh;
  });
  if (hit.length) {
    console.warn(`[engine] 话术夹带英文已替换（会话 ${convLabel(sessionId)}）: ${hit.join(', ')}`);
  }
  const internal: string[] = [];
  for (const [re, to] of INTERNAL_TERMS) {
    masked = masked.replace(re, (m) => {
      internal.push(m);
      return to;
    });
  }
  if (internal.length) {
    console.warn(`[engine] 话术夹带内部用语已替换（会话 ${convLabel(sessionId)}）: ${internal.join(', ')}`);
  }
  // oxlint-disable-next-line no-control-regex -- 链接先被换成 \u0000序号\u0000 占位，英文替换碰不到网址；正文里不会有这个字符
  return masked.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)]);
}
