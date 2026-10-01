// 冲突合并的纯函数（spec「销售话术 · 冲突合并」、「接口改动 · rebaseOnto」）。不依赖 React，自测直接调。
// 检查报了在你编辑期间被别人改过的节（rebase.conflicts）时，主区进入合并模式：每个要合并的节左边是线上那一版的写法（只读），
// 右边是你的草稿（可改，逐块「采用线上的写法」）；每节点「这一节处理好了」，全都处理好了才能「完成合并」。
// 完成合并是一次 PUT /sop/draft：带 rebaseOnto（合并到的线上版本），edits 是全部要合并的节右边的写法；服务端按发布时的三方
// 合并把上游别的改动并进来、基线换成线上版本。合并期间不自动保存，退出时恢复。
import type { SectionSpecView, SopOverview, SopSectionText, SopVersion } from '../../../src/shared/console-api.js';
import { digits } from '../../../src/shared/format.js';
import { editableChars } from '../../../src/shared/sop-sections.js';
import { bodyOf, type OutlineRow, PREAMBLE_NAME } from './outline.js';
import { namesText } from './publish.js';

export interface MergeState {
  /** 合并到的线上版本（检查时取到的）：左边的写法、rebaseOnto 都是它 */
  online: SopVersion;
  /** 要合并的节，按节表的顺序 */
  keys: readonly string[];
  /** 右边现在的写法（编辑器里的原文），按节 */
  texts: Readonly<Record<string, string>>;
  /** 进入合并时右边的写法（草稿里这一节的正文）：退出时比它，知道合并里改没改过 */
  start: Readonly<Record<string, string>>;
  /** 点过「这一节处理好了」的节 */
  done: readonly string[];
}

const textOf = (sections: readonly SopSectionText[], key: string): string => sections.find((s) => s.key === key)?.text ?? '';

/**
 * 进入合并：要合并的节按节表排（节表里没有的、固定规则节不算，服务端只比可编辑节），右边从草稿这一节的正文开始。
 * 一节也没有时是 null（不进合并模式）
 */
export function startMerge(input: {
  spec: readonly SectionSpecView[];
  online: SopVersion;
  conflicts: readonly string[];
  /** 草稿的节 */
  draft: readonly SopSectionText[];
}): MergeState | null {
  const keys = input.spec.filter((s) => !s.locked && input.conflicts.includes(s.key)).map((s) => s.key);
  if (!keys.length) return null;
  const start: Record<string, string> = {};
  for (const k of keys)
    start[k] = bodyOf(
      textOf(input.draft, k),
      input.spec.find((s) => s.key === k)!,
    );
  return { online: input.online, keys, texts: { ...start }, start, done: [] };
}

/**
 * 合并期间别人又改了草稿或发布了新版本（完成合并时 409）：按新的线上版本与草稿重新比一次。仍要合并的节里，你在合并里改过的
 * 写法留着，没改过的换成新草稿里的；左边换了，「处理好了」都清掉，重看一遍。一节也不用合并了是 null
 */
export function restartMerge(
  prev: MergeState,
  input: { spec: readonly SectionSpecView[]; online: SopVersion; conflicts: readonly string[]; draft: readonly SopSectionText[] },
): MergeState | null {
  const next = startMerge(input);
  if (!next) return null;
  const texts: Record<string, string> = { ...next.texts };
  for (const k of next.keys) if (prev.keys.includes(k) && prev.texts[k] !== prev.start[k]) texts[k] = prev.texts[k]!;
  return { ...next, texts };
}

/** 左边：线上那一版这一节的正文 */
export const onlineBody = (m: Pick<MergeState, 'online'>, spec: readonly SectionSpecView[], key: string): string =>
  bodyOf(textOf(m.online.sections, key), spec.find((s) => s.key === key) ?? { key, heading: null });

/** 左边那一栏的名字：「线上v4的写法」 */
export const onlineLabel = (m: Pick<MergeState, 'online'>): string => `线上v${m.online.versionNo ?? '—'}的写法`;

/** 右边那一栏的名字 */
export const MINE_LABEL = '你的草稿';

/** 还没点「这一节处理好了」的节，按节表的顺序 */
export const remaining = (m: Pick<MergeState, 'keys' | 'done'>): string[] => m.keys.filter((k) => !m.done.includes(k));

/** 页头的状态句：「还有2节要合并」；都处理好了写「要合并的节都处理好了」 */
export const mergeStatus = (m: Pick<MergeState, 'keys' | 'done'>): string => {
  const n = remaining(m).length;
  return n > 0 ? `还有${digits(n)}节要合并` : '要合并的节都处理好了';
};

/** 改了右边：只换这一节，别的不动（引用不变的节不重渲） */
export const withText = (m: MergeState, key: string, text: string): MergeState =>
  m.texts[key] === text ? m : { ...m, texts: { ...m.texts, [key]: text } };

/** 点了「这一节处理好了」 */
export const markDone = (m: MergeState, key: string): MergeState =>
  !m.keys.includes(key) || m.done.includes(key) ? m : { ...m, done: [...m.done, key] };

/** 处理好这一节以后去哪：它后面第一个还没处理的节，后面没有就从头找；都处理好了是 null（去「完成合并」） */
export function nextToMerge(m: Pick<MergeState, 'keys' | 'done'>, after: string): string | null {
  const left = remaining(m).filter((k) => k !== after);
  const i = m.keys.indexOf(after);
  return left.find((k) => m.keys.indexOf(k) > i) ?? left[0] ?? null;
}

/** 「完成合并」不能点的原因：还有没处理的节（点了去第一个）；null 是能点 */
export function finishBlock(m: Pick<MergeState, 'keys' | 'done'>): { reason: string; first: string } | null {
  const left = remaining(m);
  return left.length ? { reason: mergeStatus(m), first: left[0]! } : null;
}

/** 完成合并发的 edits：全部要合并的节右边的写法（原文，服务端存的时候自己规范化） */
export const mergeEdits = (m: Pick<MergeState, 'keys' | 'texts'>): { key: string; body: string }[] =>
  m.keys.map((key) => ({ key, body: m.texts[key] ?? '' }));

/** 合并里改过右边的节名（退出时确认、离开这一页时拦） */
export function mergeTouched(m: MergeState, spec: readonly SectionSpecView[]): string[] {
  return m.keys.filter((k) => m.texts[k] !== m.start[k]).map((k) => spec.find((s) => s.key === k)?.heading ?? PREAMBLE_NAME);
}

/** 退出合并的确认：「合并里改的写法不会保存：话术原则。草稿照旧，还要合并以后才能发布。」 */
export const exitText = (names: readonly string[]): string =>
  `合并里改的写法不会保存：${namesText(names)}。草稿照旧，还要合并以后才能发布。`;

/** 目录上的标记：要合并的节写「需合并」，处理好了写「已处理」；合并期间问题数不写（检查的是合并以前的草稿） */
export function mergeRows(rows: readonly OutlineRow[], m: Pick<MergeState, 'keys' | 'done'> | null): OutlineRow[] {
  if (!m) return [...rows];
  return rows.map((r) => ({
    ...r,
    issues: 0,
    ...(m.keys.includes(r.key) ? { merge: m.done.includes(r.key) ? ('done' as const) : ('todo' as const) } : {}),
  }));
}

/** 中栏说明行（要合并的节）：「需合并 · 线上v4也改了这一节，在右边改成要发布的样子」 */
export const mergeMeta = (m: Pick<MergeState, 'online'>): string[] => [
  '需合并',
  `线上v${m.online.versionNo ?? '—'}也改了这一节，在右边改成要发布的样子`,
];

/** 「有2节在你改的同时被改了：话术原则、异议处理」（发布抽屉与页头下的提醒） */
export const conflictTitle = (names: readonly string[]): string => `有${digits(names.length)}节在你改的同时被改了：${namesText(names)}`;

/**
 * 完成合并以后的 /sop：线上换成合并到的那一版，草稿换成服务端返回的那份（基线就是它，不再过期），字数按草稿重算。
 * 不等重取：发布抽屉马上要按它算逐节改动与预填
 */
export function withMerged(old: SopOverview, online: SopVersion, draft: SopVersion): SopOverview {
  return {
    ...old,
    published: online,
    draft: { ...draft, stale: draft.basedOn !== online.id },
    budget: { ...old.budget, chars: editableChars(draft.sections, old.spec) },
  };
}
