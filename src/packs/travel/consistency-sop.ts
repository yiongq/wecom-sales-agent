// 06 R21：一致性检查里只和 SOP 文字有关的那部分，纯数据加纯函数：契约检查（src/sop/contract.ts）也用，所以单独放，不拖进别的登记。
import { formatConflict, hedgeConflicts, resolveConflicts, type ConsistencyException, type ConsistencyText } from '../../core/pack-api.js';

// ---------------- 说法 ----------------

/** 「按最终行程…微调」「可能微调」。不能只写「微调」：产品库有「次日节奏微调」这样的线路亮点（06 R2） */
export const QUOTE_HEDGE = /按最终行程.{0,8}微调|最终按行程微调|可能微调/;
/** 确定价的说法：总价、每人价，或带 ¥ 的金额 */
export const QUOTE_DEFINITE = /总价|每人价|¥\s?\d[\d,]*/;
/** quote-final 在代码模板里没有同段确定价说法时，点名的那条确定价模板 */
export const QUOTE_TEMPLATE_ID = 'fixed:quote.line.exact-date';

// ---------------- 有期限的白名单与待裁决 ----------------

/**
 * quote-final 的白名单，有期限：现在锁定节里就有「起价，按最终行程微调」，规则要等第二批（第 16 步）改掉这两处才能无豁免生效。
 * 只有这两处，白名单之外不许有任何豁免。第 16 步删除这个数组，并启用契约检查的 `consistency` 违规码。
 */
export const QUOTE_FINAL_EXEMPTIONS: readonly ConsistencyException[] = Object.freeze([
  // 第 16 步删除：data/sop.md 与模板模式渲染出来的 SOP 里，stages「quote」那一条
  { rule: 'quote-final', where: 'sop:stages/quote', note: '第 16 步删除：锁定节 stages 的 quote 条里的「按最终行程微调」' },
  // 第 16 步删除：templates.ts（模板模式的锁定节模板）里的同一句
  { rule: 'quote-final', where: 'templates.ts', note: '第 16 步删除：templates.ts 锁定节模板里的「按最终行程微调」' },
]);

// ---------------- SOP 切成可定位的段 ----------------

/**
 * 把渲染后的 SOP 切成段：顶层的「- 」条目各一段（缩进的续行归上一条），其余按空行分段。
 * 位置键 sop:节/条目名：条目名取 `**quote 报价**` 里的第一个词（quote），没有就用段序号。
 * 同一位置在旧版与模板模式里键相同，所以一份白名单两边都管。
 */
export function splitSopUnits(sections: readonly { key: string; text: string }[]): ConsistencyText[] {
  const out: ConsistencyText[] = [];
  for (const section of sections) {
    const units: string[] = [];
    let cur: string[] = [];
    const flush = (): void => {
      const t = cur.join('\n').trim();
      if (t) units.push(t);
      cur = [];
    };
    const inBullet = (): boolean => cur.length > 0 && /^[-*] /.test(cur[0]!);
    for (const line of section.text.split('\n')) {
      if (/^[-*] /.test(line)) {
        flush();
        cur.push(line);
      } else if (!line.trim()) {
        // 条目里的空行不分段（条目靠缩进续行）；普通段落靠空行分段
        if (!inBullet()) flush();
      } else if (/^\s/.test(line) && cur.length) {
        cur.push(line);
      } else if (inBullet()) {
        flush();
        cur.push(line);
      } else {
        cur.push(line);
      }
    }
    flush();
    const seen = new Map<string, number>();
    units.forEach((text, i) => {
      const bold = /^[-*] \*\*([^*]+)\*\*/.exec(text)?.[1];
      let name = bold ? (/^[A-Za-z0-9_]+/.exec(bold)?.[0] ?? bold) : `#${i + 1}`;
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name}#${n}`;
      const where = `sop:${section.key}/${name}`;
      out.push({ id: where, where, text });
    });
  }
  return out;
}

// ---------------- 契约检查（第 16 步才接进发布路径） ----------------

export interface SopConsistencyViolation {
  sectionKey: string;
  detail: string;
  match: string;
}

/**
 * 一份 SOP 里和代码模板矛盾的说法：现在只有 quote-final。白名单里的位置不算。
 * 注意：这个函数写好了但没有接进发布路径（checkSopContract 的 consistency 开关默认关）。
 */
export function sopConsistencyViolations(sections: readonly { key: string; text: string }[]): SopConsistencyViolation[] {
  const conflicts = hedgeConflicts({
    rule: 'quote-final',
    texts: splitSopUnits(sections),
    hedge: QUOTE_HEDGE,
    definite: QUOTE_DEFINITE,
    counterpart: QUOTE_TEMPLATE_ID,
  });
  return resolveConflicts(conflicts, QUOTE_FINAL_EXEMPTIONS).failing.map((c) => ({
    sectionKey: c.where.slice('sop:'.length).split('/')[0]!,
    detail: formatConflict(c),
    match: c.match ?? '',
  }));
}
