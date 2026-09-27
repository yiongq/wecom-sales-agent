// 话术编辑器的 CodeMirror 扩展（spec「销售话术 · 编辑器」，设计系统 §2.3 的 reading、§2.5、§6.5、§6.6 与 B 页中栏）。
// 话术原文一个字都不改，下面这些都只是显示方式（装饰）：
// - markdown：列表的「- 」换成圆点、悬挂缩进，续行按缩进对齐；「**」包着的是粗体 600，光标不在那一行时藏起「**」；不折叠正文。
// - 工具名与字段名：行业包 vocabulary.tools 与 sopFields 里有的名字显示成芯片「查线路 search_routes」（中文名是插在前面的部件，
//   原名仍是可编辑的原文，改错一个字芯片就消失）；不认识的名字照原文显示。console 不认识任何一个包的词。
// - ✗ ✓：Noto Sans SC 里没有，换成 16 的 lucide x、check，aria-label 仍是原字符。
// - 相对线上改过的段落，左侧沟槽里一根主色竖条；新加的文字 accent-bg 底。只动空白（行尾空格、空行）的改动不标：
//   服务端保存时本来就会规范化掉它们（canonicalBody），目录与额度条也不算它们改过。
// - 不支持 text-spacing-trim 的浏览器（第 1.3 步的回退），按 haltIndices 给要挤的标点加 .halt，在「看得见的字」上算：
//   藏起来的「- 」「**」不算。
// 装饰只在这一节的正文上算（一节几千字），每次改动或移动光标整节重算；输入法组字时只平移、不重算。
import { diff } from '@codemirror/merge';
import { Compartment, type EditorState, type Extension, Facet, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { LucideIconData, LucideIconNode } from 'lucide-react';
import { __iconData as CHECK } from 'lucide-react/dist/esm/icons/check.mjs';
import { __iconData as X } from 'lucide-react/dist/esm/icons/x.mjs';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { haltIndices } from '../../../src/shared/typography.js';
import { needsTrimFallback } from '../typography.js';

// ---------------- 内置文案 ----------------

/**
 * CodeMirror 与 @codemirror/merge 的内置文案（EditorState.phrases）。编辑器与差异视图都用这一份：
 * 控制字符的提示、面板的关闭按钮、删掉选中内容时读屏的播报、差异里折叠起来的行、合并时逐块的按钮
 */
export const CM_PHRASES: Readonly<Record<string, string>> = {
  'Control character': '控制字符',
  close: '关闭',
  'Selection deleted': '已删除选中的内容',
  '$ unchanged lines': '$行没有改动',
  'Revert this chunk': '采用线上的写法',
  Accept: '采用',
  Reject: '不采用',
};

// ---------------- 行业包的词汇 ----------------

/** 芯片用的两张名称表：原名 → 中文名 */
export type Vocabulary = Pick<IndustryPack['vocabulary'], 'tools' | 'sopFields'>;

const NO_VOCABULARY: Vocabulary = { tools: {}, sopFields: {} };

export const vocabularyFacet = Facet.define<Vocabulary, Vocabulary>({
  combine: (values) => values[0] ?? NO_VOCABULARY,
});

/** 换行业包（包比 /sop 晚到、匿名换成成员）时整体换掉 */
export const vocabularySlot = new Compartment();

/** 按原名查中文名；只认自己的键（constructor、toString 这类原型上的名字不算） */
export function chipLabel(vocab: Vocabulary, name: string): string | null {
  if (Object.hasOwn(vocab.tools, name)) return vocab.tools[name]!;
  if (Object.hasOwn(vocab.sopFields, name)) return vocab.sopFields[name]!;
  return null;
}

/** 行里的 ASCII 标识符：前面不是字母、数字、下划线（与服务端检查工具名、字段名时的 \b 一致） */
const NAME = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*/g;

/** 行里要做成芯片的名字：[起, 止, 中文名]，下标相对行首 */
export function chipRanges(text: string, vocab: Vocabulary): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (const m of text.matchAll(NAME)) {
    const label = chipLabel(vocab, m[0]);
    if (label !== null) out.push([m.index, m.index + m[0].length, label]);
  }
  return out;
}

// ---------------- markdown 的行 ----------------

export interface LineShape {
  /** 行首藏起来的字数：缩进的空白，列表项再加「- 」 */
  hide: number;
  /** 正文往右缩几级（每级 20），0–3 */
  indent: number;
  /** 列表项：圆点画在正文左边 */
  bullet: boolean;
}

const LIST_ITEM = /^([ \t]*)[-*+] (?=\S)/;
const LEADING = /^[ \t]+(?=\S)/;

/** 缩进的空白有几级：两个空格是第一级（列表项的续行），四五个空格是第二级；制表符算 4 个空格 */
const levelOf = (ws: string): number => Math.ceil(ws.replaceAll('\t', '    ').length / 3);

/**
 * 一行在编辑器里怎么排：列表项「- 」（前面可以有缩进）换成圆点，正文缩到圆点右边；只有缩进的续行，缩进换成等宽的级。
 * 只有空白的行、「- 」后面没有字的行照原样（正在敲的列表项，敲出第一个字才变成圆点）
 */
export function lineShape(text: string): LineShape {
  const item = LIST_ITEM.exec(text);
  if (item) return { hide: item[0].length, indent: Math.min(levelOf(item[1]!), 2) + 1, bullet: true };
  const lead = LEADING.exec(text);
  if (lead) return { hide: lead[0].length, indent: Math.min(levelOf(lead[0]), 3), bullet: false };
  return { hide: 0, indent: 0, bullet: false };
}

/** 「**」包着的粗体：[起, 止]，含两头的「**」；里面不能以空白开头或结尾，也不能有「*」 */
const STRONG = /\*\*(?!\s)[^*]+?(?<!\s)\*\*/g;

export function strongRanges(text: string, from = 0): [number, number][] {
  STRONG.lastIndex = from;
  const out: [number, number][] = [];
  for (let m = STRONG.exec(text); m; m = STRONG.exec(text)) out.push([m.index, m.index + m[0].length]);
  return out;
}

// ---------------- ✗ ✓ 图标 ----------------

// 码位用数字写：这几个字不上页面（换成了图标），不进 UI 字体子集的取字范围
/** 原字符 → lucide 图标：✗ ✘ 换成 x，✓ ✔ 换成 check */
export const ICON_CHARS: ReadonlyMap<string, LucideIconData> = new Map([
  [String.fromCodePoint(0x2717), X],
  [String.fromCodePoint(0x2718), X],
  [String.fromCodePoint(0x2713), CHECK],
  [String.fromCodePoint(0x2714), CHECK],
]);

const SVG = 'http://www.w3.org/2000/svg';

function svgNode([tag, attrs, children]: LucideIconNode): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (k !== 'key' && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children ?? []) el.append(svgNode(c));
  return el;
}

/** 16 的图标，线宽任何尺寸下都是 1.5px（设计系统 §7 的 absoluteStrokeWidth：1.5 × 24 / 16） */
class IconWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }
  eq(other: IconWidget): boolean {
    return other.char === this.char;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'sop-icon';
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', this.char);
    const svg = document.createElementNS(SVG, 'svg');
    const attrs: Record<string, string> = {
      width: '16',
      height: '16',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': String((1.5 * 24) / 16),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const n of ICON_CHARS.get(this.char)!.node) svg.append(svgNode(n));
    span.append(svg);
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// ---------------- markdown、芯片、图标与挤压的装饰 ----------------

/** 不支持 text-spacing-trim 时为真（自测可以强行打开） */
export const haltFallback = Facet.define<boolean, boolean>({ combine: (v) => v[0] ?? needsTrimFallback });

const HIDE = Decoration.replace({});
const STRONG_MARK = Decoration.mark({ class: 'sop-md-strong' });
const SHOWN_MARKER = Decoration.mark({ class: 'sop-md-marker' });
/**
 * 芯片是包住原名的一个标记，中文名是它的 ::before（data-label），读屏不念（生成内容的替代文字为空）。
 * 一个盒子：中文名与原名不会被折到两行；它放在 outerDecorations 里，别的标记（粗体、新加的字）只会在它里面，不会把它拆开
 */
const chipMark = (label: string): Decoration => Decoration.mark({ class: 'sop-chip', attributes: { 'data-label': label } });
const HALT = Decoration.mark({ class: 'halt' });

export interface Decorations {
  /** 行、粗体、藏起来的标记、图标、挤压 */
  deco: DecorationSet;
  /** 芯片（EditorView.outerDecorations，不被别的标记拆开） */
  outer: DecorationSet;
  /** 光标整个跳过的范围：藏起来的行首与「**」、图标 */
  atomic: DecorationSet;
}

/**
 * 整节正文的装饰。reveal：这几行（从 1 数）显示「**」，就是光标所在的行（只在能编辑、有焦点时给）
 */
export function buildDecorations(state: EditorState, reveal: ReadonlySet<number>): Decorations {
  const vocab = state.facet(vocabularyFacet);
  const halt = state.facet(haltFallback);
  const deco: Range<Decoration>[] = [];
  const outer: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const { doc } = state;
  let prevBlank = true;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;
    const at = (i: number): number => line.from + i;
    const shape = lineShape(text);
    const classes: string[] = [];
    if (shape.indent) classes.push(`sop-md-in${shape.indent}`);
    if (shape.bullet) {
      classes.push('sop-md-bullet');
      // 顶格的列表项之间空 12；前面是空行（已经空开了）或是第一行时不空
      if (shape.indent === 1 && !prevBlank) classes.push('sop-md-gap');
    }
    if (classes.length) deco.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
    prevBlank = text.trim() === '';

    // 看得见的字里藏掉的下标（行内）
    const hidden = new Set<number>();
    const hide = (from: number, to: number): void => {
      const r = HIDE.range(at(from), at(to));
      deco.push(r);
      atomic.push(r);
      for (let i = from; i < to; i++) hidden.add(i);
    };
    if (shape.hide) hide(0, shape.hide);

    for (const [from, to] of strongRanges(text, shape.hide)) {
      deco.push(STRONG_MARK.range(at(from + 2), at(to - 2)));
      if (reveal.has(n)) {
        deco.push(SHOWN_MARKER.range(at(from), at(from + 2)), SHOWN_MARKER.range(at(to - 2), at(to)));
      } else {
        hide(from, from + 2);
        hide(to - 2, to);
      }
    }

    for (const [from, to, label] of chipRanges(text, vocab)) {
      outer.push(chipMark(label).range(at(from), at(to)));
    }

    for (let i = shape.hide; i < text.length; i++) {
      const ch = text[i]!;
      if (!ICON_CHARS.has(ch)) continue;
      const r = Decoration.replace({ widget: new IconWidget(ch) }).range(at(i), at(i + 1));
      deco.push(r);
      atomic.push(r);
    }

    if (halt) {
      // 在看得见的字上算：藏掉的「- 」「**」不算。芯片的中文名画在原名前面，原名以字母开头，挤压只看相邻的两个标点，
      // 它夹在中间与否结果都一样；图标本来就不是标点
      let visible = '';
      const origin: number[] = [];
      for (let i = 0; i < text.length; i++) {
        if (hidden.has(i)) continue;
        visible += text[i];
        origin.push(i);
      }
      for (const k of haltIndices(visible)) deco.push(HALT.range(at(origin[k]!), at(origin[k]! + 1)));
    }
  }
  return { deco: Decoration.set(deco, true), outer: Decoration.set(outer, true), atomic: Decoration.set(atomic, true) };
}

/** 显示「**」的行：能编辑、有焦点时，每个选区碰到的行 */
function revealLines(view: EditorView): Set<number> {
  const out = new Set<number>();
  if (!view.hasFocus || !view.state.facet(EditorView.editable)) return out;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

const markdownPlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    outer: DecorationSet;
    atomic: DecorationSet;
    constructor(view: EditorView) {
      ({ deco: this.deco, outer: this.outer, atomic: this.atomic } = buildDecorations(view.state, revealLines(view)));
    }
    update(u: ViewUpdate): void {
      // 输入法组字时只平移，换掉组字附近的节点会打断组字
      if (u.view.composing) {
        this.deco = this.deco.map(u.changes);
        this.outer = this.outer.map(u.changes);
        this.atomic = this.atomic.map(u.changes);
        return;
      }
      if (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.reconfigured))
        ({ deco: this.deco, outer: this.outer, atomic: this.atomic } = buildDecorations(u.state, revealLines(u.view)));
    }
  },
  {
    decorations: (p) => p.deco,
    provide: (plugin) => [
      EditorView.outerDecorations.of((view) => view.plugin(plugin)?.outer ?? Decoration.none),
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
    ],
  },
);

// ---------------- 相对线上的改动 ----------------

export interface DraftMarks {
  /** 改过的行（从 1 数），升序 */
  lines: number[];
  /** 新加的文字：[起, 止]，文档里的下标 */
  inserted: [number, number][];
}

const BLANK = /^\s*$/;
/** 两处改动之间没改的字少于这么多就连成一处（@codemirror/merge 的 presentableDiff 也是 3），免得标成碎片 */
const JOIN_GAP = 3;

/**
 * 正文相对线上（baseline）改了哪里。按字比（中文没有词的边界，不按词对齐），离得很近的改动连成一处；
 * 只动空白、会被保存时的规范化抹掉的改动不算：行尾的空白、开头或末尾的空行
 */
export function draftMarks(baseline: string, doc: string): DraftMarks {
  if (baseline === doc) return { lines: [], inserted: [] };
  const changes: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
  for (const c of diff(baseline, doc, { scanLimit: 500 })) {
    const last = changes.at(-1);
    if (last && c.fromB - last.toB < JOIN_GAP) {
      last.toA = c.toA;
      last.toB = c.toB;
    } else changes.push({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB });
  }
  const lineStarts = [0];
  for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') lineStarts.push(i + 1);
  /** pos 所在的行（从 1 数） */
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = new Set<number>();
  const inserted: [number, number][] = [];
  for (const c of changes) {
    const before = baseline.slice(c.fromA, c.toA);
    const after = doc.slice(c.fromB, c.toB);
    if (BLANK.test(before) && BLANK.test(after)) {
      const lineEnd = doc.indexOf('\n', c.toB);
      const trailing = !before.includes('\n') && !after.includes('\n') && BLANK.test(doc.slice(c.toB, lineEnd < 0 ? doc.length : lineEnd));
      const leadingLines = (before.includes('\n') || after.includes('\n')) && BLANK.test(doc.slice(0, c.fromB));
      if (trailing || leadingLines || BLANK.test(doc.slice(c.toB))) continue;
    }
    if (c.toB > c.fromB) inserted.push([c.fromB, c.toB]);
    // 改到的行；插进来的一段以换行开头时，换行前那一行没动，以换行结尾时，后面那一行没动
    let first = lineAt(c.fromB);
    let last = lineAt(c.toB);
    if (c.toB > c.fromB) {
      if (after.startsWith('\n')) first += 1;
      if (after.endsWith('\n')) last -= 1;
    }
    if (first > last) first = last = lineAt(c.fromB);
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return { lines: [...lines].sort((a, b) => a - b), inserted };
}

/** 换线上的正文（发布、回滚以后） */
export const setBaseline = StateEffect.define<string | null>();

const CHANGED_LINE = Decoration.line({ class: 'sop-changed' });
const INSERTED = Decoration.mark({ class: 'sop-ins' });

interface BaselineState {
  baseline: string | null;
  deco: DecorationSet;
}

function draftDecorations(state: EditorState, baseline: string | null): DecorationSet {
  if (baseline === null) return Decoration.none;
  const marks = draftMarks(baseline, state.doc.toString());
  const out: Range<Decoration>[] = marks.lines.map((n) => CHANGED_LINE.range(state.doc.line(n).from));
  for (const [from, to] of marks.inserted) out.push(INSERTED.range(from, to));
  return Decoration.set(out, true);
}

/** 线上的正文与由它算出的改动标记；只随正文或线上版本变，移动光标不重算 */
export const baselineField = StateField.define<BaselineState>({
  create: () => ({ baseline: null, deco: Decoration.none }),
  update(value, tr) {
    let baseline = value.baseline;
    for (const e of tr.effects) if (e.is(setBaseline)) baseline = e.value;
    if (baseline === value.baseline && !tr.docChanged) return value;
    return { baseline, deco: draftDecorations(tr.state, baseline) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// ---------------- 版式（设计系统 §2.3 reading 16/28，行宽 ≤640，§6.5、§6.6） ----------------

/**
 * 颜色一律取 brand.css 的变量，两套主题都跟着变。沟槽的竖条画在行左边 12 处：正文区左边留 12（卡片的左内边距相应少 12），
 * 竖条落在编辑器自己的滚动框里，不会被裁掉
 */
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', fontSize: '16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: '28px' },
  '.cm-content': { padding: '0 0 0 12px', maxWidth: '652px', caretColor: 'var(--text)' },
  '.cm-line': { position: 'relative', padding: '0' },
  // 列表与续行：每级 20；圆点 5×5，在正文左边 14、第一行的中间
  '.sop-md-in1': { paddingLeft: '20px' },
  '.sop-md-in2': { paddingLeft: '40px' },
  '.sop-md-in3': { paddingLeft: '60px' },
  '.sop-md-bullet::after': {
    content: '""',
    position: 'absolute',
    top: '12px',
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'currentColor',
  },
  '.sop-md-in1.sop-md-bullet::after': { left: '6px' },
  '.sop-md-in2.sop-md-bullet::after': { left: '26px' },
  '.sop-md-in3.sop-md-bullet::after': { left: '46px' },
  '.sop-md-gap': { paddingTop: '12px' },
  '.sop-md-gap.sop-md-bullet::after': { top: '24px' },
  '.sop-md-strong': { fontWeight: '600' },
  '.sop-md-marker': { color: 'var(--text-3)' },
  // 芯片：高 22，内边距 0 6，--r-sm，--subtle 底，无描边；中文名 14/500 text，间隔 4，原名 --mono 12.5 text-3（§6.6）。
  // 中文名的替代文字为空，读屏只念原名；不认 "/" 写法的浏览器退回前一条（style-mod 去掉 _ 之后的后缀）
  '.sop-chip': {
    display: 'inline-block',
    boxSizing: 'border-box',
    height: '22px',
    margin: '0 2px',
    padding: '0 6px',
    borderRadius: 'var(--r-sm)',
    background: 'var(--subtle)',
    fontFamily: 'var(--mono)',
    fontSize: '12.5px',
    fontWeight: '400',
    lineHeight: '22px',
    color: 'var(--text-3)',
    whiteSpace: 'nowrap',
    verticalAlign: '1px',
  },
  '.sop-chip::before': {
    content: 'attr(data-label)',
    content_alt: 'attr(data-label) / ""',
    marginRight: '4px',
    fontFamily: 'var(--font)',
    fontSize: '14px',
    fontWeight: '500',
    color: 'var(--text)',
  },
  // 粗体里的芯片：原名照样 400
  '.sop-chip .sop-md-strong': { fontWeight: '400' },
  '.sop-icon': { display: 'inline-block', width: '16px', height: '16px', marginRight: '2px', verticalAlign: '-2px' },
  '.sop-icon svg': { display: 'block' },
  // 改过的段落：沟槽里 2px 的主色竖条，与段落等高；新加的文字 accent-bg 底，--r-xs，左右各 2
  '.sop-changed::before': {
    content: '""',
    position: 'absolute',
    top: '0',
    bottom: '0',
    left: '-12px',
    width: '2px',
    background: 'var(--accent)',
  },
  '.sop-md-gap.sop-changed::before': { top: '12px' },
  '.sop-ins': {
    background: 'var(--accent-bg)',
    borderRadius: 'var(--r-xs)',
    padding: '0 2px',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
});

/**
 * 话术正文的整套显示：版式、markdown、芯片、图标、挤压回退，加上相对线上的改动标记（线上的正文经 setBaseline 给）。
 * vocabulary 放在 vocabularySlot 里，换包时 reconfigure
 */
export function sopEditorSetup(opts: { vocabulary?: Vocabulary; baseline?: string | null; halt?: boolean } = {}): Extension {
  return [
    theme,
    vocabularySlot.of(vocabularyFacet.of(opts.vocabulary ?? NO_VOCABULARY)),
    ...(opts.halt === undefined ? [] : [haltFallback.of(opts.halt)]),
    markdownPlugin,
    baselineField.init((state) => ({ baseline: opts.baseline ?? null, deco: draftDecorations(state, opts.baseline ?? null) })),
  ];
}
