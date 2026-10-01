// 发布条、发布抽屉与逐节改动的纯函数（spec「销售话术 · 发布条」「发布抽屉」，设计系统 §5.16、§6.5）。不依赖 React，自测直接调。
// - 发布条：左边摘要（改了几节、几个问题、字数），发布成功以后写「已发布v3（改了…）」，直到下一次改动；
//   右边「发布…」不能点时旁边写原因：草稿和线上一样、有问题要改（点它跳到第一个问题）、409 停住。
// - 发布抽屉：替换说明、变更说明的预填与「在预填之外再写至少一个字」、「发布」不能点的原因。
// - 逐节改动的「+3行 −1行」：与差异视图同一个按行分块的算法（@codemirror/merge 的 Chunk），改了一行里的字算 +1 −1。
// - 行内 / 并排：存在 localStorage，读写包 try/catch（无痕模式、禁用了存储时按默认的行内，只在本页生效）。
import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';
import type { SectionSpecView, SopVersion } from '../../../src/shared/console-api.js';
import { absoluteTime, digits } from '../../../src/shared/format.js';
import { SOP_CHECKS } from '../../../src/shared/ui-labels.js';
import { PREAMBLE_NAME, type PublishedHead, SOURCE_VERB } from './outline.js';
import type { LocatedViolation, ProblemTarget } from './problems.js';

// ---------------- 逐节改动 ----------------

/** 差异视图的默认扫描上限（@codemirror/merge 的 MergeView、unifiedMergeView 都是 500），行数按同一个分块算 */
export const DIFF_CONFIG = { scanLimit: 500 } as const;

/** 一节改了几行：新加的与删掉的行数 */
export function lineStat(before: string, after: string): { added: number; removed: number } {
  const a = Text.of(before.split('\n'));
  const b = Text.of(after.split('\n'));
  let added = 0;
  let removed = 0;
  for (const ch of Chunk.build(a, b, DIFF_CONFIG)) {
    if (ch.toA > ch.fromA) removed += a.lineAt(ch.endA).number - a.lineAt(ch.fromA).number + 1;
    if (ch.toB > ch.fromB) added += b.lineAt(ch.endB).number - b.lineAt(ch.fromB).number + 1;
  }
  return { added, removed };
}

/** 节标题行后面的「+3行 −1行」；没有的一边不写 */
export function statText({ added, removed }: { added: number; removed: number }): string {
  const out: string[] = [];
  if (added > 0) out.push(`+${digits(added)}行`);
  if (removed > 0) out.push(`−${digits(removed)}行`);
  return out.join(' ');
}

export type DiffMode = 'inline' | 'split';

export const DIFF_MODE_KEY = 'console.sopDiffMode';

export function readDiffMode(): DiffMode {
  try {
    return window.localStorage.getItem(DIFF_MODE_KEY) === 'split' ? 'split' : 'inline';
  } catch {
    return 'inline';
  }
}

export function writeDiffMode(mode: DiffMode): void {
  try {
    window.localStorage.setItem(DIFF_MODE_KEY, mode);
  } catch {
    // 存不了就只在本页生效
  }
}

// ---------------- 发布条 ----------------

/** 发布成功以后条里的那句：保留到下一次改动 */
export interface PublishedResult {
  versionNo: number | null;
  /** 这次改了的节名（相对被替换下来的那一版） */
  names: readonly string[];
  /** 被替换下来的版本：「回滚到v2」回到它；没取到（只在别人刚又发布过、又没连上时）是 null，不给回滚 */
  previous: SopVersion | null;
}

/**
 * 发布替换下来的版本：服务端发布结果的 basedOn。先在已知的版本里找（页面打开时的线上版本、检查时取到的线上版本），
 * 都不是（这期间别人又发布过）返回 null，由调用方按版本号去取
 */
export const replacedIn = (basedOn: string | null, known: readonly (SopVersion | null | undefined)[]): SopVersion | null =>
  known.find((k) => k && k.id === basedOn) ?? null;

/** 这次发布改了的可编辑节（相对被替换下来的版本） */
export function publishedNames(
  spec: readonly SectionSpecView[],
  previous: Pick<SopVersion, 'sections'> | null,
  v: Pick<SopVersion, 'sections'>,
): string[] {
  if (!previous) return [];
  const textOf = (x: Pick<SopVersion, 'sections'>, key: string): string => x.sections.find((s) => s.key === key)?.text ?? '';
  return spec.filter((s) => !s.locked && textOf(previous, s.key) !== textOf(v, s.key)).map((s) => s.heading ?? PREAMBLE_NAME);
}

/**
 * 将被替换的线上版本：检查发现草稿跟不上线上版本时另取了一次线上版本，它比页面打开时的新（这期间别人发布过）就用它
 */
export const onlineNow = <T extends Pick<SopVersion, 'versionNo'>>(published: T, fetched: T | null | undefined): T =>
  fetched && (fetched.versionNo ?? 0) > (published.versionNo ?? 0) ? fetched : published;

/** 摘要的名单：「话术原则、异议处理」 */
export const namesText = (names: readonly string[]): string => names.join('、');

/** 「草稿改了2节（话术原则、异议处理）」 */
export const changedText = (names: readonly string[]): string => `草稿改了${names.length}节（${namesText(names)}）`;

/** 「已发布v3（改了话术原则、异议处理）」；只动了空白、节名单为空时不写括号 */
export const publishedText = (r: Pick<PublishedResult, 'versionNo' | 'names'>): string =>
  `已发布v${r.versionNo ?? '—'}${r.names.length ? `（改了${namesText(r.names)}）` : ''}`;

/** 「发布…」不能点的原因（至多一条，按先后）；null 是能点（还有没存上的改动也能点：点了先存） */
export function barBlock(input: { frozen: boolean; changed: number; problems: number }): {
  reason: string;
  /** 点它跳到第一个问题 */
  jump: boolean;
} | null {
  if (input.frozen) return { reason: '载入最新草稿以后才能发布', jump: false };
  // 左边的摘要已经写了「草稿和线上一样」（或发布成功的那句），这里接着写后半句
  if (input.changed === 0) return { reason: '没有可发布的改动', jump: false };
  if (input.problems > 0) return { reason: `改完${digits(input.problems)}个问题即可发布`, jump: true };
  return null;
}

/** 第一个问题：按清单的顺序，第一个有去处的 */
export function firstProblem(located: readonly LocatedViolation[]): NonNullable<ProblemTarget> | null {
  for (const [code] of SOP_CHECKS) {
    const hit = located.find((v) => v.code === code && v.target !== null);
    if (hit?.target) return hit.target;
  }
  return null;
}

// ---------------- 发布抽屉 ----------------

/** 替换说明：「将替换线上v2（老板 · 9月25日 18:30发布）」；发布人没有名字时按来源写「9月24日 10:02导入」 */
export function replaceLine(published: PublishedHead, now: number): string[] {
  const head = `将替换线上v${published.versionNo ?? '—'}`;
  if (!published.publishedAt) return [head];
  const when = absoluteTime(published.publishedAt, now);
  return published.publishedByName
    ? [`${head}（${published.publishedByName}`, `${when}发布）`]
    : [`${head}（${when}${SOURCE_VERB[published.source]}）`];
}

/** 变更说明的预填：「修改：话术原则、异议处理。」 */
export const notePrefill = (names: readonly string[]): string => (names.length ? `修改：${namesText(names)}。` : '');

/**
 * 变更说明能不能交：要在预填之外再写至少一个字。只剩预填（或删掉了预填末尾的几个字）不算；改写了预填的算自己写的。
 * 空着（只有空白）也不算：空串是任何预填的开头
 */
export function noteReady(note: string, prefill: string): boolean {
  return !prefill.trim().startsWith(note.trim());
}

/**
 * 抽屉里「发布」不能点的原因（至多一条，按先后）；null 是能点。
 * running：打开抽屉时的检查还没回来；failed：没检查上；conflicts：检查报了在你编辑期间被别人改过的节
 */
export function drawerBlock(input: {
  running: boolean;
  failed: boolean;
  conflicts: number;
  problems: number;
  noteReady: boolean;
}): { reason: string; focus: 'checks' | 'note' | null } | null {
  if (input.running) return { reason: '正在检查…', focus: null };
  if (input.failed) return { reason: '没检查上，重试以后再发布', focus: 'checks' };
  if (input.conflicts > 0) return { reason: `有${digits(input.conflicts)}节被别人改过，发布不了`, focus: null };
  if (input.problems > 0) return { reason: `改完${digits(input.problems)}个问题即可发布`, focus: 'checks' };
  if (!input.noteReady) return { reason: '在说明里写上为什么改', focus: 'note' };
  return null;
}
