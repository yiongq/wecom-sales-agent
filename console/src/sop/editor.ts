// 话术编辑器的 CodeMirror 扩展（spec「销售话术 · 编辑器」，设计系统 §2.3 的 reading、§2.5、§6.5、§6.6 与 B 页中栏）。
// 话术原文一个字都不改，下面这些都只是显示方式（装饰）：
// - markdown：列表的「- 」换成圆点、悬挂缩进，续行按缩进对齐；「**」包着的是粗体 600，光标不在那一行时藏起「**」；不折叠正文。
// - 工具名与字段名：行业包 vocabulary.tools 与 sopFields 里有的名字显示成芯片「查线路 search_routes」（包住原名的一个标记，
//   中文名是它的 ::before；原名仍是可编辑的原文，改错一个字芯片就消失）；不认识的名字照原文显示。console 不认识任何一个包的词。
// - ✗ ✓：Noto Sans SC 里没有，换成 16 的 lucide x、check，aria-label 仍是原字符。
// - 相对线上改过的段落，左侧沟槽里一根主色竖条，与段落等高（改到一行，整个列表项连同续行都画）；新加的文字 accent-bg 底。
//   只动空白（行尾空格、空行）的改动不标：服务端保存时本来就会规范化掉它们（canonicalBody），目录与额度条也不算它们改过。
// - 不支持 text-spacing-trim 的浏览器（第 1.3 步的回退），按 haltIndices 给要挤的标点加 .halt，在「看得见的字」上算：
//   藏起来的「- 」「**」不算。支持的浏览器自己挤，但隔着藏起来的「**」的两个标点它不挤，这几对照样加 .halt。
// - 检查出的问题（第 6.2 步，spec「检查 · 定位」「行内提醒」）：禁用短语、写错的工具名与字段名，每一处画 danger 波浪线；
//   写错的名字在那一段之后插一条行内提醒（块级部件，设计系统 §5.12），行业包里有编辑距离 ≤2 的名字时带「改成…」按钮，
//   点了替换这一段里的那几处。问题由页面经 setProblems 给，位置每次改动都在正文里重新找，改掉了波浪线就没了。
// 装饰只在这一节的正文上算（一节几千字），每次改动或移动光标整节重算；输入法组字时只平移、不重算。
import { diff } from '@codemirror/merge';
import {
  Annotation,
  Compartment,
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
  type TransactionSpec,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { LucideIconData, LucideIconNode } from 'lucide-react';
import { __iconData as CHECK } from 'lucide-react/dist/esm/icons/check.mjs';
import { __iconData as CIRCLE_ALERT } from 'lucide-react/dist/esm/icons/circle-alert.mjs';
import { __iconData as X } from 'lucide-react/dist/esm/icons/x.mjs';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { haltIndices } from '../../../src/shared/typography.js';
import { needsTrimFallback } from '../typography.js';
import { type EditorProblem, fixLabel, hintNote, type NameHint, occurrences } from './problems.js';

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

/** lucide 图标的 SVG，线宽任何尺寸下都是 1.5px（设计系统 §7 的 absoluteStrokeWidth：1.5 × 24 / size） */
function lucideSvg(data: LucideIconData, size: number): SVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const attrs: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': String((1.5 * 24) / size),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const n of data.node) svg.append(svgNode(n));
  return svg;
}

/** 16 的图标 */
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
    span.append(lucideSvg(ICON_CHARS.get(this.char)!, 16));
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

/**
 * 一行里要加 .halt 的字（行内下标），在看得见的字上算：hidden 是藏掉的下标（行首的「- 」、缩进、「**」）。
 * 芯片的中文名画在原名前面，原名以字母开头，挤压只看相邻的两个标点，它夹在中间与否结果都一样；图标本来就不是标点。
 * fallback（不支持 text-spacing-trim）：每一对都算。支持时浏览器自己挤，只补隔着藏掉的字的几对：藏起来的「**」在 DOM 里是
 * CodeMirror 的部件（一个 widget buffer 加一个不可编辑的空 span），Chromium 不把它两边的标点当成挨着的（「）**：」这样的一对）
 */
export function haltChars(text: string, hidden: ReadonlySet<number>, fallback: boolean): number[] {
  if (!fallback && hidden.size === 0) return [];
  let visible = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (hidden.has(i)) continue;
    visible += text[i];
    origin.push(i);
  }
  if (fallback) return haltIndices(visible).map((k) => origin[k]!);
  // haltIndices 只看相邻的一对，所以逐对算的结果与整串算的相同
  const out: number[] = [];
  for (let k = 0; k + 1 < visible.length; k++) {
    // 原文里也挨着的一对，浏览器自己挤
    if (origin[k + 1] === origin[k]! + 1) continue;
    for (const j of haltIndices(visible[k]! + visible[k + 1]!)) out.push(origin[k + j]!);
  }
  return out;
}

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

    for (const i of haltChars(text, hidden, halt)) deco.push(HALT.range(at(i), at(i + 1)));
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

/** 顶格的列表项（「- 」「* 」「+ 」「1. 」「1) 」开头）：新的一段从这一行起 */
const ITEM_START = /^(?:[-*+]|\d+[.)]) (?=\S)/;

/**
 * 第 n 行（从 1 数）所在的段落：[首行, 末行]。段落是空行隔开的一块；块里每个顶格的列表项连同它下面的行（缩进的续行、
 * 下一级的列表项、没缩进但也不是列表项的行）各是一段，第一个列表项之前的行是一段。空行自己算一段。text 是按行切开的正文
 */
export function paragraphSpan(text: readonly string[], n: number): [number, number] {
  const blank = (k: number): boolean => BLANK.test(text[k - 1]!);
  const starts = (k: number): boolean => ITEM_START.test(text[k - 1]!);
  let a = n;
  let b = n;
  if (!blank(n)) {
    while (a > 1 && !starts(a) && !blank(a - 1)) a -= 1;
    while (b < text.length && !blank(b + 1) && !starts(b + 1)) b += 1;
  }
  return [a, b];
}

/** 改过的行（从 1 数）扩到它们所在的段落（paragraphSpan），沟槽里的竖条与段落等高 */
export function paragraphLines(doc: string, lines: readonly number[]): number[] {
  const text = doc.split('\n');
  const out = new Set<number>();
  for (const n of lines) {
    if (out.has(n)) continue;
    const [a, b] = paragraphSpan(text, n);
    for (let k = a; k <= b; k++) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
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
  const doc = state.doc.toString();
  const marks = draftMarks(baseline, doc);
  const out: Range<Decoration>[] = paragraphLines(doc, marks.lines).map((n) => CHANGED_LINE.range(state.doc.line(n).from));
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

// ---------------- 检查出的问题：波浪线与行内提醒 ----------------

/** 换这一节的问题（每次检查以后、换节时由页面给） */
export const setProblems = StateEffect.define<readonly EditorProblem[]>();

/** 点「改成…」的那一笔：编辑器据此通知页面马上保存 */
export const problemFix = Annotation.define<boolean>();

const BAD = Decoration.mark({ class: 'sop-bad' });

/** 一条行内提醒插在哪：at 是那一段末行的行尾；indent 是那一段第一行的缩进级（与列表的正文对齐） */
export interface HintPlace {
  at: number;
  indent: number;
  match: string;
  hint: NameHint;
}

/**
 * 正文里的问题：每一处 match 的 [起, 止]（画波浪线），和行内提醒的位置（写错的名字，每一段每个名字一条，按位置排）
 */
export function problemPlaces(doc: string, problems: readonly EditorProblem[]): { marks: [number, number][]; hints: HintPlace[] } {
  const marks: [number, number][] = [];
  const hints: HintPlace[] = [];
  if (!problems.length) return { marks, hints };
  const text = doc.split('\n');
  const starts = [0];
  for (const line of text) starts.push(starts.at(-1)! + line.length + 1);
  /** pos 所在的行（从 1 数） */
  const lineAt = (pos: number): number => {
    let n = 1;
    while (n < text.length && starts[n]! <= pos) n += 1;
    return n;
  };
  for (const p of problems) {
    const seen = new Set<number>();
    for (const [from, to] of occurrences(doc, p.match, p.name)) {
      marks.push([from, to]);
      if (!p.hint) continue;
      const [a, b] = paragraphSpan(text, lineAt(from));
      if (seen.has(b)) continue;
      seen.add(b);
      hints.push({ at: starts[b - 1]! + text[b - 1]!.length, indent: lineShape(text[a - 1]!).indent, match: p.match, hint: p.hint });
    }
  }
  marks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  hints.sort((x, y) => x.at - y.at);
  return { marks, hints };
}

/**
 * 「改成…」：把 pos 所在那一段里的每一处 match 换成 name，光标放在最后一处后面。
 * 这一段里已经没有 match（先手改掉了）时是 null
 */
export function fixNameAt(state: EditorState, pos: number, match: string, name: string): TransactionSpec | null {
  const { doc } = state;
  const [a, b] = paragraphSpan(doc.toString().split('\n'), doc.lineAt(pos).number);
  const from = doc.line(a).from;
  const found = occurrences(state.sliceDoc(from, doc.line(b).to), match, true);
  if (!found.length) return null;
  const end = from + found.at(-1)![1] + found.length * (name.length - match.length);
  return {
    changes: found.map(([s, e]) => ({ from: from + s, to: from + e, insert: name })),
    selection: { anchor: end },
    annotations: problemFix.of(true),
    userEvent: 'input.fix',
  };
}

/** 我们自己拼的文字（部件里没有 React 的 cjk()）：要挤的标点包进 .halt */
function appendText(el: HTMLElement, text: string, fallback: boolean): void {
  if (!fallback) {
    el.append(text);
    return;
  }
  const halt = new Set(haltIndices(text));
  let run = '';
  let runHalt = false;
  const push = (): void => {
    if (!run) return;
    if (runHalt) {
      const s = document.createElement('span');
      s.className = 'halt';
      s.textContent = run;
      el.append(s);
    } else el.append(run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (halt.has(i) !== runHalt) {
      push();
      runHalt = !runHalt;
    }
    run += text[i];
  }
  push();
}

const el = (tag: string, cls: string): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
};

/**
 * 行内提醒（设计系统 §5.12、B 页）：留在文字流里，--danger-bg 底；14 的 circle-alert，第一行「提到了不存在的工具「search_route」，
 * 是不是「查线路 search_routes」？」（候选是芯片），右边幽灵小按钮「改成search_routes」，第二行写后果。
 * fixable：编辑器能改（只读、409 停住时不给按钮）
 */
class HintWidget extends WidgetType {
  constructor(
    readonly place: HintPlace,
    readonly fixable: boolean,
    readonly fallback: boolean,
  ) {
    super();
  }
  eq(o: HintWidget): boolean {
    const a = this.place;
    const b = o.place;
    return (
      a.indent === b.indent &&
      a.match === b.match &&
      a.hint.what === b.hint.what &&
      a.hint.known === b.hint.known &&
      a.hint.fix?.name === b.hint.fix?.name &&
      a.hint.fix?.label === b.hint.fix?.label &&
      this.fixable === o.fixable &&
      this.fallback === o.fallback
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const { match, hint, indent } = this.place;
    const wrap = el('div', `sop-hint-wrap${indent ? ` sop-hint-in${indent}` : ''}`);
    const box = el('div', 'sop-hint');
    const icon = el('span', 'sop-hint-icon');
    icon.append(lucideSvg(CIRCLE_ALERT, 14));
    const main = el('div', 'sop-hint-main');
    const row = el('div', 'sop-hint-row');
    const title = el('div', 'sop-hint-title');
    appendText(title, `提到了不存在的${hint.what === 'tool' ? '工具' : '字段'}「`, this.fallback);
    const bad = el('span', 'sop-hint-name');
    bad.textContent = match;
    title.append(bad);
    if (hint.fix) {
      appendText(title, '」，是不是', this.fallback);
      // 「芯片」？不拆开折行
      const tail = el('span', 'sop-hint-nowrap');
      appendText(tail, '「', this.fallback);
      const chip = el('span', 'sop-hint-chip');
      const label = el('span', 'sop-hint-chip-label');
      label.textContent = hint.fix.label;
      const name = el('span', 'sop-hint-chip-name');
      name.textContent = hint.fix.name;
      chip.append(label, name);
      tail.append(chip);
      appendText(tail, '」？', this.fallback);
      title.append(tail);
    } else appendText(title, '」', this.fallback);
    row.append(title);
    const fix = hint.fix;
    if (fix && this.fixable) {
      const button = el('button', 'sop-hint-fix') as HTMLButtonElement;
      button.type = 'button';
      button.textContent = fixLabel(fix.name);
      button.addEventListener('click', () => {
        const spec = fixNameAt(view.state, view.posAtDOM(wrap), match, fix.name);
        if (!spec) return;
        view.dispatch(spec);
        view.focus();
      });
      row.append(button);
    }
    const note = el('div', 'sop-hint-note');
    appendText(note, hintNote(hint), this.fallback);
    main.append(row, note);
    box.append(icon, main);
    wrap.append(box);
    return wrap;
  }
  get estimatedHeight(): number {
    return 76;
  }
}

interface ProblemsState {
  problems: readonly EditorProblem[];
  deco: DecorationSet;
}

function problemDecorations(state: EditorState, problems: readonly EditorProblem[]): DecorationSet {
  if (!problems.length) return Decoration.none;
  const { marks, hints } = problemPlaces(state.doc.toString(), problems);
  const fixable = !state.readOnly;
  const fallback = state.facet(haltFallback);
  const out: Range<Decoration>[] = marks.map(([from, to]) => BAD.range(from, to));
  for (const h of hints) out.push(Decoration.widget({ widget: new HintWidget(h, fixable, fallback), block: true, side: 1 }).range(h.at));
  return Decoration.set(out, true);
}

/** 这一节的问题与由它算出的装饰；块级部件只能由 StateField 给（ViewPlugin 不行） */
export const problemsField = StateField.define<ProblemsState>({
  create: () => ({ problems: [], deco: Decoration.none }),
  update(value, tr) {
    let problems = value.problems;
    for (const e of tr.effects) if (e.is(setProblems)) problems = e.value;
    if (problems === value.problems && !tr.docChanged) return value;
    return { problems, deco: problemDecorations(tr.state, problems) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** 页面点清单里的一项：选中这一节正文里第一处 match 并滚过去；找不到（已经改掉了）时是 false */
export function selectFirst(view: EditorView, match: string, name: boolean): boolean {
  const first = occurrences(view.state.doc.toString(), match, name)[0];
  if (!first) return false;
  view.dispatch({ selection: { anchor: first[0], head: first[1] }, effects: EditorView.scrollIntoView(first[0], { y: 'center' }) });
  return true;
}

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
  // 检查出的问题：danger 波浪线（§6.6）
  '.sop-bad': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationColor: 'var(--danger)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
  // 行内提醒（§5.12、B 页）：上边空 12，左边与那一段的正文对齐；块级部件的高度要量得准，空白用内边距，不用外边距
  '.sop-hint-wrap': { paddingTop: '12px', whiteSpace: 'normal', cursor: 'default' },
  '.sop-hint-in1': { paddingLeft: '20px' },
  '.sop-hint-in2': { paddingLeft: '40px' },
  '.sop-hint-in3': { paddingLeft: '60px' },
  '.sop-hint': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '8px 8px 8px 12px',
    borderRadius: 'var(--r-sm)',
    background: 'var(--danger-bg)',
    fontSize: '14px',
    lineHeight: '22px',
  },
  '.sop-hint-icon': { flex: 'none', height: '22px', paddingTop: '4px', boxSizing: 'border-box', color: 'var(--danger)' },
  '.sop-hint-icon svg': { display: 'block' },
  '.sop-hint-main': { flex: '1', minWidth: '0' },
  // 放不下时（窄屏）按钮折到第一行下面：标题至少占 240，再加按钮放不下就换行
  '.sop-hint-row': { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: '12px', rowGap: '4px' },
  '.sop-hint-title': { flex: '1 1 240px', minWidth: '0', fontWeight: '500', color: 'var(--text)', textWrap: 'pretty' },
  '.sop-hint-name': { fontFamily: 'var(--mono)', fontSize: '12.5px', fontWeight: '400' },
  '.sop-hint-nowrap': { whiteSpace: 'nowrap' },
  // 候选是芯片（§6.6），在 danger-bg 上用 panel 底
  '.sop-hint-chip': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    boxSizing: 'border-box',
    height: '22px',
    margin: '0 2px',
    padding: '0 6px',
    borderRadius: 'var(--r-sm)',
    background: 'var(--panel)',
    whiteSpace: 'nowrap',
    verticalAlign: '1px',
  },
  '.sop-hint-chip-label': { fontSize: '14px', lineHeight: '20px', fontWeight: '500', color: 'var(--text)' },
  '.sop-hint-chip-name': { fontFamily: 'var(--mono)', fontSize: '12.5px', lineHeight: '20px', fontWeight: '400', color: 'var(--text-3)' },
  // 幽灵小按钮（§5.1）：28 高，左右 10，14/500；悬停 --hover、按下 --pressed，焦点 2px --focus 外框
  '.sop-hint-fix': {
    flex: 'none',
    height: '28px',
    margin: '-3px 0',
    padding: '0 10px',
    border: '0',
    borderRadius: 'var(--r-sm)',
    background: 'transparent',
    fontFamily: 'var(--font)',
    fontSize: '14px',
    lineHeight: '22px',
    fontWeight: '500',
    color: 'var(--text)',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  '.sop-hint-fix:hover': { background: 'var(--hover)' },
  '.sop-hint-fix:active': { background: 'var(--pressed)' },
  '.sop-hint-fix:focus-visible': { outline: '2px solid var(--focus)', outlineOffset: '2px' },
  '.sop-hint-note': { marginTop: '2px', fontSize: '13px', lineHeight: '20px', fontWeight: '400', color: 'var(--text-2)' },
});

/**
 * 话术正文的整套显示：版式、markdown、芯片、图标、挤压回退，加上相对线上的改动标记（线上的正文经 setBaseline 给）。
 * vocabulary 放在 vocabularySlot 里，换包时 reconfigure
 */
export function sopEditorSetup(
  opts: { vocabulary?: Vocabulary; baseline?: string | null; halt?: boolean; problems?: readonly EditorProblem[] } = {},
): Extension {
  const problems = opts.problems ?? [];
  return [
    theme,
    vocabularySlot.of(vocabularyFacet.of(opts.vocabulary ?? NO_VOCABULARY)),
    ...(opts.halt === undefined ? [] : [haltFallback.of(opts.halt)]),
    markdownPlugin,
    baselineField.init((state) => ({ baseline: opts.baseline ?? null, deco: draftDecorations(state, opts.baseline ?? null) })),
    problemsField.init((state) => ({ problems, deco: problemDecorations(state, problems) })),
  ];
}
