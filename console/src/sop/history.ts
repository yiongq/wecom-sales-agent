// 版本记录与回滚的纯函数（spec「销售话术 · 版本记录」「查看改动」「回滚」「载入到草稿再改」「丢弃草稿」，设计系统 C 页）。
// 不依赖 React，自测直接调。
// - 版本记录按版本号倒序翻页（before 游标）。每页多取一个：页上最后一个版本的前一版也在手上，「改了N节」相对它算；
//   多取的那一个不列出来，下一页从它开始。
// - 每个版本先写变更说明，下一行「作者 · 时间 · 改了N节（节名）」；来源写成中文：导入写「系统导入」，回滚写「回到v1」，
//   系统更新（启动重渲染）的说明换成「代码里的固定规则变了」（存下来的说明是给工程看的，进技术详情）。
// - 回滚确认的后果：会生成哪一版、线上那一版还在、固定规则节用现在的写法；有草稿时按发布时的三方合并（src/config/sop.ts 的
//   rebase）同一口径比一次：回滚要改的节（草稿的基线 ≠ 目标）和草稿改过的节（基线 ≠ 草稿）有交集就要先合并，没有就自动并入；
//   目标版本的固定规则节和线上不同时另写一条；差异块是线上的可编辑节回滚以后怎么变。
// - 载入到草稿再改：把目标版本的可编辑节放进草稿（编辑器里的改动，由自动保存存上）；会盖掉草稿自己改过的节时先确认。
import type { SectionSpecView, SopSectionText, SopVersion } from '../../../src/shared/console-api.js';
import { absoluteTime, digits } from '../../../src/shared/format.js';
import { bodyOf, changedSections, mergedSections, PREAMBLE_NAME, type SectionChange } from './outline.js';
import { namesText, publishedNames } from './publish.js';

// ---------------- 翻页 ----------------

/** 一页列多少个版本 */
export const HISTORY_PAGE = 20;
/** 一页取多少个：多取的一个是页上最后一个版本的前一版 */
export const HISTORY_FETCH = HISTORY_PAGE + 1;

export interface HistoryPage {
  items: SopVersion[];
}

/** 下一页的 before：这一页取满了（有多出来的那一个）才有，从最后一个列出来的版本往前取 */
export const nextBefore = (last: HistoryPage): number | undefined =>
  last.items.length > HISTORY_PAGE ? (last.items[HISTORY_PAGE - 1]?.versionNo ?? undefined) : undefined;

/** 列出来的版本（每页去掉多取的那一个）与手上全部的版本（找前一版、回滚的目标用） */
export function historyRows(pages: readonly HistoryPage[]): { rows: SopVersion[]; known: SopVersion[] } {
  return { rows: pages.flatMap((p) => p.items.slice(0, HISTORY_PAGE)), known: pages.flatMap((p) => p.items) };
}

/** 前一版：版本号小 1 的那一个（每个新版本上线时都把当时的线上版本归档，版本号连着） */
export const previousOf = (v: Pick<SopVersion, 'versionNo'>, known: readonly SopVersion[]): SopVersion | null =>
  v.versionNo === null ? null : (known.find((k) => k.versionNo === v.versionNo! - 1) ?? null);

// ---------------- 每一行 ----------------

/** 作者那一段：人发布的写名字；命令行导入、系统更新写来源（不写 import-config、system 这类命令名） */
export function authorOf(v: Pick<SopVersion, 'source' | 'publishedByName' | 'createdByName'>): string {
  if (v.source === 'import') return '系统导入';
  if (v.source === 'rerender') return '系统更新';
  return v.publishedByName ?? v.createdByName ?? (v.source === 'rollback' ? '回滚' : '后台发布');
}

/** 系统更新的说明：存下来的是「启动重渲染：hard_rules 变了」，给工程看，进技术详情 */
export const RERENDER_NOTE = '代码里的固定规则变了';

export interface VersionLine {
  /** 变更说明（14/500，写在前面） */
  note: string;
  /** 下一行的各段，用 Sep 隔开 */
  meta: string[];
}

/**
 * 一个版本的说明与下一行。prev 是前一版（「改了N节」相对它算，只算可编辑节）；rolledBackTo 是回滚的目标版本号
 * （回滚写「回到v1」，不知道是哪一版时只写「回滚」）
 */
export function versionLine(
  v: SopVersion,
  spec: readonly SectionSpecView[],
  prev: Pick<SopVersion, 'sections'> | null,
  now: number,
  rolledBackTo?: number | null,
): VersionLine {
  const when = v.publishedAt ?? v.createdAt;
  const meta = [authorOf(v), absoluteTime(when, now)];
  if (v.source === 'rerender') return { note: RERENDER_NOTE, meta };
  if (v.source === 'import') return { note: v.changeNote ?? '首次导入', meta };
  if (v.source === 'rollback') meta.push(rolledBackTo ? `回到v${rolledBackTo}` : '回滚');
  const names = prev ? publishedNames(spec, prev, v) : [];
  if (names.length) meta.push(`改了${digits(names.length)}节（${namesText(names)}）`);
  return { note: v.changeNote ?? '', meta };
}

/** 草稿那一行：「未发布 · 改了2节」；没改时是 same（publish.ts 的 sameAs：「和线上一样」或「和v2一样（线上已是v3）」） */
export const draftLine = (changed: number, same = '和线上一样'): string[] => ['未发布', changed > 0 ? `改了${digits(changed)}节` : same];

/** 抽屉头的状态：「线上v2 · 另有1份草稿」 */
export const historyStatus = (online: Pick<SopVersion, 'versionNo'>, hasDraft: boolean): string[] => [
  `线上v${online.versionNo ?? '—'}`,
  ...(hasDraft ? ['另有1份草稿'] : []),
];

/** 技术详情：四个哈希的前 12 位（01 验收 22 在这里看得到 prompt_hash）；系统更新另带存下来的原话 */
export function versionTech(v: Pick<SopVersion, 'promptHash' | 'toolsHash' | 'prefixHash' | 'sopHash' | 'source' | 'changeNote'>) {
  const rows: [string, string][] = [];
  for (const [k, h] of [
    ['prompt', v.promptHash],
    ['tools', v.toolsHash],
    ['prefix', v.prefixHash],
    ['sop', v.sopHash],
  ] as const)
    if (h) rows.push([k, h.slice(0, 12)]);
  if (v.source === 'rerender' && v.changeNote) rows.push(['note', v.changeNote]);
  return rows;
}

// ---------------- 查看改动 ----------------

/** 主区标题：「v2相对v1改了什么」 */
export const versionTitle = (no: number): string => `v${no}相对v${no - 1}改了什么`;

/** 一个版本相对前一版改了哪几节：固定规则节也算（系统更新改的就是它们），按节表的顺序 */
export const versionChanges = (
  spec: readonly SectionSpecView[],
  prev: Pick<SopVersion, 'sections'>,
  v: Pick<SopVersion, 'sections'>,
): SectionChange[] => changedSections(spec, prev.sections, v.sections, {}, true);

// ---------------- 回滚 ----------------

const textIn = (secs: readonly SopSectionText[], key: string): string | undefined => secs.find((s) => s.key === key)?.text;

export interface RollbackPlan {
  /** 回滚会生成的版本号（线上版本号加 1） */
  nextNo: number;
  onlineNo: number;
  targetNo: number;
  /** 回滚以后线上的可编辑节怎么变（线上 → 目标），按节表的顺序 */
  changes: SectionChange[];
  /** 目标版本的固定规则节和线上不同：新版本不会和目标完全一样 */
  lockedDiffer: boolean;
  /**
   * 草稿：merge 是回滚要改的节和草稿改过的节有交集，回滚以后要先合并才能发布；auto 是没有交集，发布时自动并入。
   * names 是草稿改过的节，baseNo 是草稿的基线。没有草稿（或草稿什么也没改）是 null
   */
  draft: { kind: 'merge' | 'auto'; names: string[]; baseNo: number | null } | null;
}

export interface RollbackDraft {
  /** 草稿的基线版本（based_on） */
  base: Pick<SopVersion, 'sections' | 'versionNo'>;
  /** 草稿的节，含编辑器里还没存上的改动（outline.ts 的 mergedSections） */
  mine: readonly SopSectionText[];
}

export function rollbackPlan(input: {
  spec: readonly SectionSpecView[];
  online: Pick<SopVersion, 'sections' | 'versionNo'>;
  target: Pick<SopVersion, 'sections' | 'versionNo'>;
  draft: RollbackDraft | null;
}): RollbackPlan {
  const { spec, online, target, draft } = input;
  const editable = spec.filter((s) => !s.locked);
  const lockedDiffer = spec.some((s) => s.locked && textIn(target.sections, s.key) !== textIn(online.sections, s.key));
  let d: RollbackPlan['draft'] = null;
  if (draft) {
    // 同 src/config/sop.ts 的 rebase：base 是草稿的基线，cur 是回滚以后的线上（可编辑节就是目标的），mine 是草稿
    const base = draft.base.sections;
    const upstream = editable.filter((s) => textIn(base, s.key) !== textIn(target.sections, s.key));
    const edited = editable.filter((s) => textIn(base, s.key) !== textIn(draft.mine, s.key));
    if (edited.length)
      d = {
        kind: edited.some((s) => upstream.includes(s)) ? 'merge' : 'auto',
        names: edited.map((s) => s.heading ?? PREAMBLE_NAME),
        baseNo: draft.base.versionNo,
      };
  }
  return {
    nextNo: (online.versionNo ?? 0) + 1,
    onlineNo: online.versionNo ?? 0,
    targetNo: target.versionNo ?? 0,
    changes: changedSections(spec, online.sections, target.sections, {}),
    lockedDiffer,
    draft: d,
  };
}

/** 草稿的节（含还没存上的改动）：草稿没有就从线上起 */
export const draftSections = (
  spec: readonly SectionSpecView[],
  current: readonly SopSectionText[],
  edits: Readonly<Record<string, string>>,
): SopSectionText[] => mergedSections(spec, current, edits);

export type ConsequenceIcon = 'info' | 'lock' | 'warning';

/** 回滚确认的后果列表（设计系统 C 页的四条，加上固定规则改过的那一条） */
export function rollbackConsequences(p: RollbackPlan): { icon: ConsequenceIcon; text: string }[] {
  const out: { icon: ConsequenceIcon; text: string }[] = [
    { icon: 'info', text: `会生成v${p.nextNo}并立即上线，客户的下一句就按v${p.targetNo}的写法回复。` },
    { icon: 'info', text: `v${p.onlineNo}还在，随时能再切回来。` },
    { icon: 'lock', text: '固定规则节保持现在的写法，不会退回旧版。' },
  ];
  if (p.lockedDiffer)
    out.push({
      icon: 'warning',
      text: `v${p.targetNo}之后代码里的固定规则改过，回滚后这些节用现在的写法，所以新版本不会和v${p.targetNo}完全一样。`,
    });
  if (p.draft?.kind === 'merge')
    out.push({
      icon: 'warning',
      text: `你的草稿（改了${namesText(p.draft.names)}）是在v${p.draft.baseNo ?? '—'}上改的。回滚后要先合并，才能发布。`,
    });
  else if (p.draft) out.push({ icon: 'info', text: '你的草稿会在发布时自动并入。' });
  return out;
}

/** 差异块的标题：「回滚后，线上的可编辑节会变成这样：」，只有一节时后面接着写这一节（rollbackSectionTitle） */
export const rollbackDiffTitle = '回滚后，线上的可编辑节会变成这样：';

/** 差异块里一节的标题：「异议处理531 → 496字」；回到紧挨着的前一版时后面写「（撤回v2的改动）」 */
export function rollbackSectionTitle(c: SectionChange, p: Pick<RollbackPlan, 'onlineNo' | 'targetNo'>): string {
  const undo = p.targetNo === p.onlineNo - 1 ? `（撤回v${p.onlineNo}的改动）` : '';
  return `${c.name}${digits(c.before.length)} → ${digits(c.after.length)}字${undo}`;
}

/** 「为什么回滚」下面的说明：回滚的审计里没有这句话，所以只写版本记录 */
export const rollbackHelp = (nextNo: number): string => `会作为v${nextNo}的变更说明，写进版本记录`;

// ---------------- 载入到草稿再改 ----------------

export interface LoadPlan {
  /** 载入以后编辑器里的正文（按节 key）：目标版本里与草稿不同的可编辑节换成目标的写法，别的照旧 */
  edits: Record<string, string>;
  /** 载入会改动的节数（0：草稿已经是这一版的写法） */
  changed: number;
  /** 会被盖掉的、草稿自己改过的节（相对线上改过、又和目标不同）：有就先确认 */
  overwritten: string[];
}

export function loadPlan(input: {
  spec: readonly SectionSpecView[];
  /** 线上版本的节 */
  published: readonly SopSectionText[];
  /** 草稿的节，没有草稿就是线上的 */
  current: readonly SopSectionText[];
  /** 编辑器里还没存上的改动 */
  edits: Readonly<Record<string, string>>;
  target: Pick<SopVersion, 'sections'>;
}): LoadPlan {
  const { spec, published, current, edits, target } = input;
  const mine = changedSections(spec, published, current, edits);
  const next: Record<string, string> = { ...edits };
  const overwritten: string[] = [];
  let changed = 0;
  for (const s of spec) {
    if (s.locked) continue;
    const want = bodyOf(textIn(target.sections, s.key) ?? '', s);
    const have = mine.find((c) => c.key === s.key)?.after ?? bodyOf(textIn(published, s.key) ?? '', s);
    if (have === want) continue;
    next[s.key] = want;
    changed += 1;
    if (mine.some((c) => c.key === s.key)) overwritten.push(s.heading ?? PREAMBLE_NAME);
  }
  return { edits: next, changed, overwritten };
}

/** 「会覆盖草稿里的：话术原则、异议处理。」 */
export const overwriteText = (names: readonly string[]): string => `会覆盖草稿里的：${namesText(names)}。`;

// ---------------- 丢弃草稿 ----------------

/** 「更多」里「丢弃草稿」不能点的原因；null 是能点。丢弃是对存下来的草稿做的 */
export function discardBlock(input: { draft: boolean; unsaved: boolean; saving: boolean; frozen: boolean }): string | null {
  if (input.frozen) return '载入最新草稿以后才能丢弃';
  if (input.unsaved || input.saving) return '改动还在保存';
  if (!input.draft) return '还没有草稿';
  return null;
}
