// 检查出的问题落在哪、怎么说（spec「销售话术 · 检查」的表、「定位」与「行内提醒」）。纯函数，不依赖 React 与 CodeMirror，自测直接调。
// - 落在哪：每条问题一节（目录的问题数、清单的节名按它算）。phrase_missing 服务端不给节（这句已经不在草稿里了），
//   取线上版本里含这句的节；其余取 sectionKey。
// - 点了去哪：phrase_forbidden、unknown_tool、unknown_field 在那一节的正文里选中 match；structure、locked_changed、
//   phrase_missing 打开那一节；over_budget 去额度条。
// - 怎么说：说明按 code、match 由前端生成（服务端的 detail 只进技术详情）。unknown_* 的说明就是编辑器里的行内提醒；
//   其余四类写在中栏编辑卡片的上方（这一节的问题）；over_budget 写在清单的那一项上。
// - 「改成…」的候选：只在行业包的词汇里找，工具名找 vocabulary.tools，字段名找 sopFields，编辑距离 ≤2 里最近的一个。
import type { ContractViolation, ViolationCode } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';

type Vocabulary = Pick<IndustryPack['vocabulary'], 'tools' | 'sopFields'>;

/** 点清单里的一项去哪；null 是没处可去（整份的节表不对这类，技术详情里有原文） */
export type ProblemTarget =
  /** 打开这一节，选中正文里第一处 match；name 为真时按标识符找（前后不连字母、数字、下划线，与服务端的 \b 一致） */
  | { kind: 'match'; section: string; match: string; name: boolean }
  /** 打开这一节 */
  | { kind: 'section'; section: string }
  | { kind: 'quota' }
  | null;

export interface LocatedViolation {
  code: ViolationCode;
  /** 问题落在的节 */
  section: string | null;
  match: string | null;
  target: ProblemTarget;
}

/** 按标识符找的几类：match 是工具名、字段名 */
const NAME_CODES: ReadonlySet<ViolationCode> = new Set(['unknown_tool', 'unknown_field']);
/** 在正文里选中 match 的几类 */
const MATCH_CODES: ReadonlySet<ViolationCode> = new Set(['phrase_forbidden', 'unknown_tool', 'unknown_field']);

/**
 * 每条问题落在哪、点了去哪。published 是线上版本的节（phrase_missing 去「线上版本里含这句的节」）
 */
export function locateViolations(
  violations: readonly Pick<ContractViolation, 'code' | 'sectionKey' | 'match'>[],
  published: readonly { key: string; text: string }[],
): LocatedViolation[] {
  return violations.map((v) => {
    const match = v.match ?? null;
    if (v.code === 'over_budget') return { code: v.code, section: null, match, target: { kind: 'quota' } };
    const section =
      v.code === 'phrase_missing' ? (match ? (published.find((s) => s.text.includes(match))?.key ?? null) : null) : v.sectionKey;
    if (section === null) return { code: v.code, section, match, target: null };
    const target: ProblemTarget =
      match && MATCH_CODES.has(v.code) ? { kind: 'match', section, match, name: NAME_CODES.has(v.code) } : { kind: 'section', section };
    return { code: v.code, section, match, target };
  });
}

// ---------------- 说明 ----------------

/** 前端生成的说明（spec「检查」的表）；over_budget 的「超出N字」要字数，由清单那一项自己写；没有 match 的说不清，不写 */
export function problemText(v: Pick<LocatedViolation, 'code' | 'match'>): string | null {
  switch (v.code) {
    case 'structure':
      return '这一节的标题或位置被改了，改回原来的标题';
    case 'locked_changed':
      return '固定规则节不能改，撤回这一节的改动';
    case 'phrase_missing':
      return v.match ? `要保留这句：「${v.match}」` : null;
    case 'phrase_forbidden':
      return v.match ? `「${v.match}」不能出现在话术里` : null;
    case 'unknown_tool':
      return v.match ? `提到了不存在的工具「${v.match}」` : null;
    case 'unknown_field':
      return v.match ? `提到了不存在的字段「${v.match}」` : null;
    default:
      return null;
  }
}

/** 中栏编辑卡片上方的几条：这一节里没有行内提醒的问题（结构、固定规则、必需说法、禁用短语），去重 */
export function sectionNotes(located: readonly LocatedViolation[], section: string): string[] {
  const out: string[] = [];
  for (const v of located) {
    if (v.section !== section || NAME_CODES.has(v.code)) continue;
    const t = problemText(v);
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---------------- 编辑器里的问题 ----------------

/** 行内提醒：写错的工具名、字段名，有没有「改成…」 */
export interface NameHint {
  what: 'tool' | 'field';
  /** 行业包里这一类名字有几个：「模型只认7个工具名」 */
  known: number;
  /** 编辑距离 ≤2 里最近的名字；没有就不给按钮 */
  fix: { name: string; label: string } | null;
}

/** 这一节正文里要标出来的：每一处 match 画波浪线；写错的名字另在那一段之后插一条行内提醒 */
export interface EditorProblem {
  match: string;
  /** 按标识符找 */
  name: boolean;
  hint: NameHint | null;
}

/** 编辑距离（插入、删除、替换各算 1）；超过 cap 时返回 cap + 1，不再往下算 */
export function editDistance(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return Math.min(prev[b.length]!, cap + 1);
}

/** 名字表里编辑距离 ≤2 的名字里最近的一个；一样近的取表里靠前的。只认自己的键 */
export function nearestName(name: string, table: Readonly<Record<string, string>>): { name: string; label: string } | null {
  let best: { name: string; label: string } | null = null;
  let bestD = 3;
  for (const [k, label] of Object.entries(table)) {
    if (k === name) continue;
    const d = editDistance(name, k);
    if (d < bestD) {
      best = { name: k, label };
      bestD = d;
    }
  }
  return best;
}

/**
 * 这一节正文里要标出来的问题：禁用短语，写错的工具名、字段名（后两类带行内提醒）。同一个 match 只列一次。
 * 词汇没到（行业包还没取回来）时照样画波浪线，只是不给「改成…」
 */
export function editorProblems(located: readonly LocatedViolation[], section: string, vocab: Vocabulary | undefined): EditorProblem[] {
  const out: EditorProblem[] = [];
  for (const v of located) {
    if (v.section !== section || v.target?.kind !== 'match') continue;
    const { match, name } = v.target;
    if (out.some((p) => p.match === match && p.name === name)) continue;
    let hint: NameHint | null = null;
    if (v.code === 'unknown_tool' || v.code === 'unknown_field') {
      const table = (v.code === 'unknown_tool' ? vocab?.tools : vocab?.sopFields) ?? {};
      hint = { what: v.code === 'unknown_tool' ? 'tool' : 'field', known: Object.keys(table).length, fix: nearestName(match, table) };
    }
    out.push({ match, name, hint });
  }
  return out;
}

const WORD = /[A-Za-z0-9_]/;

/** 正文里每一处 match（不重叠）：[起, 止]。name 为真时前后不能连着字母、数字、下划线 */
export function occurrences(text: string, match: string, name: boolean): [number, number][] {
  const out: [number, number][] = [];
  if (!match) return out;
  let i = text.indexOf(match);
  while (i >= 0) {
    const end = i + match.length;
    if (name && ((i > 0 && WORD.test(text[i - 1]!)) || (end < text.length && WORD.test(text[end]!)))) {
      i = text.indexOf(match, i + 1);
      continue;
    }
    out.push([i, end]);
    i = text.indexOf(match, end);
  }
  return out;
}

/** 行内提醒的第二行：写错的后果 */
export function hintNote(hint: NameHint): string {
  const what = hint.what === 'tool' ? '工具名' : '字段名';
  const known = hint.known > 0 ? `模型只认${hint.known}个${what}，` : '';
  return `${known}写错的名字会被当成不存在，这条规则就不起作用了。`;
}

/** 「改成search_routes」 */
export const fixLabel = (name: string): string => `改成${name}`;
