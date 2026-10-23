// 模板模式的锁定节（07 R3）：不再手抄一份，而是由镜像 data/sop.md 的 7 个锁定节按声明的替换表生成。
// 模板模式不点名渠道，所以和镜像的差别只有 6 行「微信」说法，全写在 LOCKED_SECTION_REPLACEMENTS 里；其余字节与镜像相同。
// 镜像里的锁定节随发版改（01 R25 / 07 批 S）时，模板自动跟着变；表里某条对不上了（命中 0 次或多次），包装载时抛错，启动失败。
import fs from 'node:fs';
import { TRAVEL_SOP_SECTIONS } from './sop.js';
import { applyReplacements, type Replacement } from './replacements.js';

export interface SectionReplacement extends Replacement {
  /** 节表里的 key；替换只在这一节的文字里数命中次数 */
  section: string;
}

export const LOCKED_SECTION_REPLACEMENTS: readonly SectionReplacement[] = Object.freeze([
  { section: 'orders', from: '顾问核实后会在微信上联系您', to: '顾问核实后会联系您' },
  { section: 'capabilities', from: '或顾问在微信里发给您的收款方式', to: '或顾问发给您的收款方式' },
  {
    section: 'capabilities',
    from: '企业微信里拿不到客户手机号，顾问只会在微信上联系：说「顾问会在微信上联系您」',
    to: '未提供客户手机号时，顾问通过当前会话联系：说「顾问会联系您」',
  },
  { section: 'no-destinations', from: '只说顾问会在微信上联系您、评估一下', to: '只说顾问会联系您、评估一下' },
  {
    section: 'handoff',
    from: '统一说「顾问会在微信上联系您」（企业微信拿不到手机号，不说电话联系）',
    to: '统一说「顾问会联系您」（未提供手机号时，不说电话联系）',
  },
  { section: 'handoff', from: '说明顾问会在微信上联系您，不要再推荐线路', to: '说明顾问会联系您，不要再推荐线路' },
]);

/** 仓库里的镜像 data/sop.md（按本文件的位置找，不依赖 cwd；运行镜像把 data/ 拷在 src/ 旁边） */
export function readMirrorSop(): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(new URL('../../../data/sop.md', import.meta.url)));
}

/**
 * 镜像 → 模板模式的锁定节模板（key 为节表里的 key，顺序同节表）。每一节的文字从标题行起、到下一个行首「## 」之前，
 * 切法与 splitSop 相同；表里没提到的节与镜像逐字节相同。表指向的节不是锁定节、镜像缺锁定节、任一条没有恰好命中一次，都抛错
 */
export function deriveLockedSectionTemplates(
  mirror: string,
  table: readonly SectionReplacement[] = LOCKED_SECTION_REPLACEMENTS,
): Record<string, string> {
  const locked = TRAVEL_SOP_SECTIONS.filter((s) => s.locked);
  for (const r of table) {
    if (!locked.some((s) => s.key === r.section)) throw new Error(`锁定节替换表：「${r.section}」不是锁定节`);
  }
  const starts = [...mirror.matchAll(/^## /gm)].map((m) => m.index);
  const out: Record<string, string> = {};
  for (const s of locked) {
    const at = s.heading === null ? -1 : starts.findIndex((i) => mirror.startsWith(`## ${s.heading}\n`, i));
    if (at < 0) throw new Error(`锁定节模板：镜像里没有「${s.heading}」节`);
    const text = mirror.slice(starts[at], starts[at + 1] ?? mirror.length);
    out[s.key] = applyReplacements(
      text,
      table.filter((r) => r.section === s.key),
      `锁定节「${s.key}」`,
    );
  }
  return out;
}
