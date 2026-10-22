// 07 R5：只查可编辑节里的明确数字陈述；不把一般行程天数当作退改承诺。
import type { SopSection } from '../../core/pack-api.js';
import { TRAVEL_SOP_SECTIONS } from './sop.js';
import { defaultTravelPolicy, travelPolicySchema, travelPolicy, peakPercent } from './policy.js';

type PolicyViolation = { code: 'policy_invalid' | 'policy_mismatch'; sectionKey: string | null; detail: string; match?: string };

export function policyViolations(raw: unknown, sections: readonly SopSection[] = []): PolicyViolation[] {
  const invalid = (detail: string): PolicyViolation[] => [{ code: 'policy_invalid', sectionKey: null, detail }];
  const parsed = travelPolicySchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
  const p = parsed.data;
  if (
    (Object.keys(p) as (keyof typeof p)[]).some(
      (key) => !travelPolicy.editable.includes(key) && JSON.stringify(p[key]) !== JSON.stringify(defaultTravelPolicy[key]),
    )
  )
    return invalid('定价与预订字段必须等于包默认值');
  const tiers = p.refund.tiers.toSorted((a, b) => b.minDays - a.minDays);
  if (new Set(tiers.map((t) => t.id)).size !== tiers.length || tiers.some((t) => t.id === 'below-min'))
    return invalid('档位标识重复或占用保留标识');
  if (tiers[0]!.maxDays !== null || tiers.some((t, i) => i > 0 && t.maxDays !== tiers[i - 1]!.minDays - 1))
    return invalid('退改档位须连续覆盖到无穷，不能重叠或有缺口');
  const out: PolicyViolation[] = [];
  for (const section of sections) {
    if (!TRAVEL_SOP_SECTIONS.some((s) => s.key === section.key && !s.locked)) continue;
    for (const sentence of section.text
      .split(/[。！？；\n]/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      let mismatch = [...sentence.matchAll(/上浮\s*(\d+(?:\.\d+)?)\s*%/g)].some((m) => Number(m[1]) !== peakPercent(p));
      mismatch ||= [...sentence.matchAll(/(\d+(?:\.\d+)?)\s*折/g)].some((m) => {
        const n = Number(m[1]);
        return Math.abs((n > 10 ? n / 100 : n / 10) - p.pricing.groupDiscount) > 1e-9;
      });
      if (/退|取消/.test(sentence)) {
        const days = [
          ...sentence.matchAll(/(?:出发前\s*)?(\d+)\s*(?:[–—~～-]\s*(\d+)\s*)?天(及以上|以上|及之前|以前|以内|内|及以下|以下)?/g),
        ];
        const rates = (text: string): number[] => [
          ...(/退全款|全额退/.test(text) ? [100] : []),
          ...[...text.matchAll(/退(?:订单金额的|款\s*|\s*)(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1])),
        ];
        // 比例不依赖词序；退款处理/到账需要的天数不当作距出发天数。
        mismatch ||= rates(sentence).some((value) => !tiers.some((t) => t.percent === value));
        for (const [i, day] of days.entries()) {
          let values = rates(sentence.slice(day.index + day[0].length, days[i + 1]?.index));
          if (!values.length && days.length === 1 && /出发前/.test(day[0])) values = rates(sentence);
          const below = /以内|内|及以下|以下/.test(day[3] ?? '');
          const lo = below ? 0 : Number(day[1]);
          const hi = day[2] ? Number(day[2]) : below ? Number(day[1]) : day[3] ? Infinity : lo;
          mismatch ||= values.some((value) => !tiers.some((t) => lo >= t.minDays && hi <= (t.maxDays ?? Infinity) && value === t.percent));
        }
      }
      if (mismatch)
        out.push({
          code: 'policy_mismatch',
          sectionKey: section.key,
          match: sentence,
          detail: `这句话与退改条款或定价规则不一致：${sentence}`,
        });
    }
  }
  return out;
}
