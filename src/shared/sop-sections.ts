// SOP 节的正文与字数（docs/features/console-ux/spec.md「额度条」）：前后端共用，只依赖 src/shared。
// 话术页的额度条要按服务端的同一口径实时算字数，所以 sectionBody、editableChars 从 src/sop/sections.ts 挪到这里，
// 连同它们用到的 SopStructureError、SopSection、SectionSpec。src/sop/sections.ts 原样再导出同一个类：
// 契约检查靠 instanceof SopStructureError 捕获结构错误，两处要是各有一个类，就捕获不到这里抛的。
// 节表属于行业包，这里的 editableChars 不带默认节表；src/sop/sections.ts 包一层补上 TRAVEL_SOP_SECTIONS。
// 正文的规范形 canonicalBody 也在这里（spec 顶部 Revisions，第 5.1 步评审之后）：服务端保存草稿时先规范化再计数，
// 额度条和目录的「改过」要按规范化以后的正文算才是同一口径。服务端的 normalizeBody 在它前后再查编码、不合格就抛。

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

/** 字节顺序标记 U+FEFF。不写成转义：编辑工具会把转义还原成这个看不见的字符 */
const BOM = String.fromCharCode(0xfeff);

/** 去掉 BOM，\r\n 与单独的 \r 换成 \n */
export const toLf = (text: string): string => text.replaceAll(BOM, '').replace(/\r\n?/g, '\n');

/**
 * 正文的规范形：去 BOM；\r\n 与 \r 换成 \n；转 NFC；去掉每一行的行尾空白；去掉开头的空行；去掉末尾空白；
 * 再补上结尾，非末节补 \n\n，末节补 \n。只规范化，不查编码、不抛错
 */
export function canonicalBody(body: string, isLast: boolean): string {
  const text = toLf(body)
    .normalize('NFC')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/^\n+/, '')
    .trimEnd();
  return text + (isLast ? '\n' : '\n\n');
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
