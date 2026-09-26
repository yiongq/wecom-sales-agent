// SOP 的节表与切分、拼接、规范化（docs/architecture/01-pg-config-console/spec.md「节表」「切分、拼接与规范化」）。
// 纯函数，无 I/O。只认行首的「## 」；字节约定：一节的 text 从标题行开始（前言从文件开头开始），到下一个「## 」行之前为止，
// 含结尾的换行，所以 joinSop 就是逐节相连，切开再拼回去逐字节相同。
// 本文件的源码里特殊字符一律写成 \u 转义：编辑器或工具把它们写成原字符时，源码里就混进了本文件要拒绝的东西。

export interface SectionSpec {
  key: string;
  /** 标题行去掉「## 」后的原文，逐字节比较；前言为 null */
  heading: string | null;
  /** true：代码依赖它。01 里不可编辑，DB 模式下内容以镜像里的 data/sop.md 为准 */
  locked: boolean;
}

/** 旅行行业包的节表。顺序就是 data/sop.md 里的顺序；锁定节的「代码依赖」见 spec 的节表 */
export const TRAVEL_SOP_SECTIONS: readonly SectionSpec[] = Object.freeze(
  [
    { key: 'preamble', heading: null, locked: false },
    { key: 'stages', heading: '各阶段目标', locked: true },
    { key: 'orders', heading: '订单：改单、给别人再订、重发链接', locked: true },
    { key: 'tone', heading: '话术原则', locked: false },
    { key: 'quote-discipline', heading: '报价纪律（硬性）', locked: true },
    { key: 'price-rules', heading: '定价规则（只有这两条，硬性）', locked: true },
    { key: 'objections', heading: '异议处理', locked: false },
    { key: 'capabilities', heading: '能力边界（硬性，先看这条）', locked: true },
    { key: 'no-destinations', heading: '我们没有的目的地（如南极、冰岛）', locked: true },
    { key: 'handoff', heading: '转人工条件（满足任一立即调用 handoff_to_human）', locked: true },
    { key: 'wechat-style', heading: '微信语气规范', locked: false },
  ].map((s) => Object.freeze(s)),
);

export interface SopSection {
  key: string;
  text: string;
}

/** 标题序列与节表不符；标题后缺空行；正文为空；正文里出现行首「## 」；某节不是规范形 */
export class SopStructureError extends Error {}
/** BOM、\r、非 NFC、孤立代理项、\n 与 \t 以外的 C0 控制字符、U+2028 / U+2029 */
export class SopEncodingError extends Error {}

const BOM = '\uFEFF';
const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** \n 与 \t 以外的 C0 控制字符（含 NUL）的位置；没有返回 -1。不写成正则：正则里的控制字符会被 lint 当成笔误 */
function controlCharAt(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x0a && c !== 0x09) return i;
  }
  return -1;
}

/** 规范化也不替换的几类字符：孤立代理项、控制字符、行分隔符。出现就拒绝，不猜它原本想写什么 */
function assertNoIrreparable(text: string): void {
  const surrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.exec(text);
  if (surrogate) throw new SopEncodingError(`第 ${lineOf(text, surrogate.index)} 行有孤立的代理项（不是合法的 UTF-16）`);
  const ctl = controlCharAt(text);
  if (ctl >= 0) {
    const code = text.charCodeAt(ctl).toString(16).padStart(4, '0').toUpperCase();
    throw new SopEncodingError(`第 ${lineOf(text, ctl)} 行有控制字符 U+${code}`);
  }
  const sep = /[\u2028\u2029]/.exec(text);
  if (sep) throw new SopEncodingError(`第 ${lineOf(text, sep.index)} 行有行分隔符 U+2028 或段分隔符 U+2029`);
}

/**
 * 读文件用它，不用 fs.readFileSync(…, 'utf8')：后者把非法的 UTF-8 字节（例如编码过的孤立代理项）悄悄换成 U+FFFD，
 * 坏文件就被当成合法的收下了。这里遇到非法字节直接拒绝
 */
export function decodeSopFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SopEncodingError('不是合法的 UTF-8（含非法字节，或编码过的孤立代理项）');
  }
}

/** 编码检查，不合格抛 SopEncodingError，带行号 */
export function assertSopEncoding(text: string): void {
  const bom = text.indexOf(BOM);
  if (bom >= 0) throw new SopEncodingError(`第 ${lineOf(text, bom)} 行有 BOM（U+FEFF）`);
  const cr = text.indexOf('\r');
  if (cr >= 0) throw new SopEncodingError(`第 ${lineOf(text, cr)} 行有回车符 \\r，只收 \\n 换行`);
  assertNoIrreparable(text);
  if (text.normalize('NFC') !== text) {
    const line = text.split('\n').findIndex((l) => l.normalize('NFC') !== l);
    throw new SopEncodingError(`不是 NFC 规范形${line >= 0 ? `（第 ${line + 1} 行）` : ''}`);
  }
}

/**
 * 正文的规范形：去 BOM；\r\n 与 \r 换成 \n；转 NFC；去掉每一行的行尾空白；去掉开头的空行；去掉末尾空白；
 * 再补上结尾，非末节补 \n\n，末节补 \n。孤立代理项、控制字符和行分隔符不替换，直接拒绝
 */
export function normalizeBody(body: string, isLast: boolean): string {
  const lf = body.replaceAll(BOM, '').replace(/\r\n?/g, '\n');
  // 先查不能替换的字符：后面的去行尾空白和 trimEnd 会把行尾的 U+2028 当成空白悄悄删掉
  assertNoIrreparable(lf);
  const text = lf
    .normalize('NFC')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/^\n+/, '')
    .trimEnd();
  const out = text + (isLast ? '\n' : '\n\n');
  assertSopEncoding(out);
  return out;
}

function headingLine(spec: SectionSpec): string {
  return `## ${spec.heading}\n\n`;
}

/** 正文：标题行及其后一个空行之后的部分；前言的正文就是整段 text */
export function sectionBody(section: SopSection, spec: SectionSpec): string {
  if (spec.heading === null) return section.text;
  const head = headingLine(spec);
  if (!section.text.startsWith(head)) throw new SopStructureError(`「${spec.key}」节的开头不是「## ${spec.heading}」加一个空行`);
  return section.text.slice(head.length);
}

/** 正文不能为空，也不许出现行首「## 」：导出后再导入会多切出一节 */
function assertBody(spec: SectionSpec, body: string): void {
  if (!body.trim()) throw new SopStructureError(`「${spec.key}」节的正文为空`);
  const m = /^## /m.exec(body);
  if (m) throw new SopStructureError(`「${spec.key}」节的正文第 ${lineOf(body, m.index)} 行以「## 」开头，会被当成新的一节`);
}

/** `## ${heading}\n\n` + normalizeBody(body, isLast)；前言没有标题行 */
export function withBody(spec: SectionSpec, body: string, isLast: boolean): SopSection {
  const normalized = normalizeBody(body, isLast);
  assertBody(spec, normalized);
  return { key: spec.key, text: spec.heading === null ? normalized : headingLine(spec) + normalized };
}

/**
 * 按节表切开并校验：先过编码检查；标题序列必须与节表逐条相同；每个标题行之后紧跟一个空行；
 * 每节正文非空且已是规范形（导入不改写任何字节，不是规范形就拒绝）
 */
export function splitSop(md: string, spec: readonly SectionSpec[] = TRAVEL_SOP_SECTIONS): SopSection[] {
  assertSopEncoding(md);
  const starts = [...md.matchAll(/^## /gm)].map((m) => m.index);
  const hasPreamble = spec[0]?.heading === null;
  if (!hasPreamble && starts[0] !== 0) throw new SopStructureError('第一个「## 」标题之前还有内容，而节表里没有前言');
  const bounds = hasPreamble ? [0, ...starts] : starts;
  const headings = starts.map((i) => {
    const eol = md.indexOf('\n', i);
    return md.slice(i + 3, eol === -1 ? md.length : eol);
  });
  const expected = spec.filter((s) => s.heading !== null).map((s) => s.heading);
  let at = -1;
  for (let i = 0; i < Math.max(headings.length, expected.length) && at < 0; i++) if (headings[i] !== expected[i]) at = i;
  if (at >= 0) {
    throw new SopStructureError(
      `标题序列与节表不符：第 ${at + 1} 个标题是「${headings[at] ?? '（缺）'}」，节表要求「${expected[at] ?? '（没有了）'}」`,
    );
  }
  const sections = spec.map((s, i) => ({ key: s.key, text: md.slice(bounds[i], bounds[i + 1] ?? md.length) }));
  sections.forEach((section, i) => {
    const s = spec[i]!;
    const isLast = i === spec.length - 1;
    const body = sectionBody(section, s);
    assertBody(s, body);
    if (normalizeBody(body, isLast) !== body) {
      throw new SopStructureError(`「${s.key}」节不是规范形：有行尾空白或开头空行，或者结尾不是${isLast ? '一个换行' : '一个空行'}`);
    }
  });
  return sections;
}

export function joinSop(sections: readonly SopSection[]): string {
  return sections.map((s) => s.text).join('');
}

/**
 * 按当前节表合并：锁定节取 image；可编辑节优先取 stored 里同 key 的，stored 没有时取 image。
 * 从 stored 取的节按当前节表重建标题行和结尾：节表换了标题、在末尾加了节时，拼出来仍是合法的 SOP；
 * 节表没变时重建结果与原文逐字节相同
 */
export function mergeWithImage(
  stored: readonly SopSection[],
  image: readonly SopSection[],
  spec: readonly SectionSpec[] = TRAVEL_SOP_SECTIONS,
): SopSection[] {
  return spec.map((s, i) => {
    const fromImage = image.find((x) => x.key === s.key);
    if (!fromImage) throw new SopStructureError(`镜像的 SOP 里没有「${s.key}」节`);
    const mine = s.locked ? undefined : stored.find((x) => x.key === s.key);
    if (!mine) return { key: s.key, text: fromImage.text };
    // 存下来的节可能是旧节表的标题：去掉它自己的标题行，只留正文
    const cut = s.heading === null ? 0 : mine.text.indexOf('\n\n') + 2;
    if (cut === 1) throw new SopStructureError(`存下来的「${s.key}」节缺少标题行后的空行`);
    return withBody(s, mine.text.slice(cut), i === spec.length - 1);
  });
}

/** 可编辑节正文的总长度（UTF-16 码元，即 String.length） */
export function editableChars(sections: readonly SopSection[], spec: readonly SectionSpec[] = TRAVEL_SOP_SECTIONS): number {
  let n = 0;
  for (const s of spec) {
    if (s.locked) continue;
    const section = sections.find((x) => x.key === s.key);
    if (section) n += sectionBody(section, s).length;
  }
  return n;
}
