import type { SopSection } from '../../core/pack-api.js';
import { forbiddenClaims } from './sop.js';
export function sopConsistencyViolations(sections: readonly SopSection[]) {
  return sections.flatMap(({ key, text }) => {
    const claims = [...forbiddenClaims, '无需审核', '待审直接发链接', '已批准也要重新审核'];
    return claims
      .filter((claim) => text.includes(claim))
      .map((match) => ({ sectionKey: key, detail: `[industrial.claims] sop:${key} 与确定性报价或护栏冲突`, match }));
  });
}
