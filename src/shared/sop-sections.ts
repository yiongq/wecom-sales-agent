// SOP 节的正文与字数（docs/features/console-ux/spec.md「额度条」）：前后端共用，只依赖 src/shared。
// 话术页的额度条要按服务端的同一口径实时算字数，所以 sectionBody、editableChars 从 src/sop/sections.ts 挪到这里，
// 连同它们用到的 SopStructureError、SopSection、SectionSpec。src/sop/sections.ts 原样再导出同一个类：
// 契约检查靠 instanceof SopStructureError 捕获结构错误，两处要是各有一个类，就捕获不到这里抛的。
// 节表属于行业包，这里的 editableChars 不带默认节表；src/sop/sections.ts 包一层补上 TRAVEL_SOP_SECTIONS。

export interface SectionSpec {
  key: string;
  /** 标题行去掉「## 」后的原文，逐字节比较；前言为 null */
  heading: string | null;
  /** true：代码依赖它。01 里不可编辑，DB 模式下内容以镜像里的 data/sop.md 为准 */
  locked: boolean;
}

export interface SopSection {
  key: string;
  text: string;
}

/** 标题序列与节表不符；标题后缺空行；正文为空；正文里出现行首「## 」；某节不是规范形 */
export class SopStructureError extends Error {}

/** 标题行连同其后的一个空行 */
export function headingLine(spec: SectionSpec): string {
  return `## ${spec.heading}\n\n`;
}

/** 正文：标题行及其后一个空行之后的部分；前言的正文就是整段 text */
export function sectionBody(section: SopSection, spec: SectionSpec): string {
  if (spec.heading === null) return section.text;
  const head = headingLine(spec);
  if (!section.text.startsWith(head)) throw new SopStructureError(`「${spec.key}」节的开头不是「## ${spec.heading}」加一个空行`);
  return section.text.slice(head.length);
}

/** 可编辑节正文的总长度（UTF-16 码元，即 String.length）；节表里有、sections 里没有的节不计 */
export function editableChars(sections: readonly SopSection[], spec: readonly SectionSpec[]): number {
  let n = 0;
  for (const s of spec) {
    if (s.locked) continue;
    const section = sections.find((x) => x.key === s.key);
    if (section) n += sectionBody(section, s).length;
  }
  return n;
}
