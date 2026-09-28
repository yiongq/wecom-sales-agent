// 销售话术页的目录、额度条与状态句（spec「销售话术（B、C 页）」，设计系统 §6.2、B 页）。纯函数，不依赖 React，自测直接调。
// 节表与锁定：成员取 /sop 的 spec（顺序、标题、锁定），锁定原因按 key 取行业包的 sopSections；匿名只有已发布版本的节，
// 标题、锁定、原因都取行业包，包里没有的节从正文的「## 」行取标题、按没锁算。console 不认识任何一个包的节。
// 字数与服务端同一口径（src/shared/sop-sections.ts）：可编辑节的正文（去掉标题行和其后的空行），UTF-16 长度求和。
// 编辑器里还没保存的正文先按服务端保存时的规则规范化（canonicalBody：去行尾空白、开头空行，结尾补成一个空行或一个换行），
// 再计数、再和线上比：保存前后数字不跳，只多了行尾空格的节也不算改过。
import type { ContractViolation, SectionSpecView, SopOverview, SopSectionText, SopVersion } from '../../../src/shared/console-api.js';
import { absoluteTime, dateText, digits } from '../../../src/shared/format.js';
import type { SopSectionDef } from '../../../src/shared/pack.js';
import { canonicalBody, editableChars, headingLine, sectionBody, SopStructureError } from '../../../src/shared/sop-sections.js';

/** 前言没有标题行，目录里叫「前言」 */
export const PREAMBLE_NAME = '前言';

export interface OutlineRow {
  key: string;
  /** 标题行的原文，前言写「前言」 */
  name: string;
  locked: boolean;
  /** 固定规则节为什么不能改（行业包的 lockReason）；包里没写或不认识这一节时是 null */
  lockReason: string | null;
  /** 正文字数（含本地还没保存的改动） */
  chars: number;
  /** 相对线上版本的字数差；没改过是 0 */
  delta: number;
  /** 可编辑节的正文与线上不同 */
  changed: boolean;
  /** 最近一次检查在这一节报的问题数 */
  issues: number;
}

/** 正文；万一不是规范形（服务端保证是），整段当正文，不让页面崩掉 */
function bodyOf(text: string, spec: Pick<SectionSpecView, 'key' | 'heading'>): string {
  try {
    return sectionBody({ key: spec.key, text }, { ...spec, locked: false });
  } catch (e) {
    if (e instanceof SopStructureError) return text;
    throw e;
  }
}

const textOf = (sections: readonly SopSectionText[], key: string): string => sections.find((s) => s.key === key)?.text ?? '';

export interface MemberOutlineInput {
  /** /sop 的节表：顺序、标题、锁定 */
  spec: readonly SectionSpecView[];
  /** 行业包的话术节（取锁定原因）；包还没到时不给 */
  packSections?: readonly SopSectionDef[];
  /** 线上版本的节 */
  published: readonly SopSectionText[];
  /** 草稿的节，没有草稿就是线上版本的 */
  current: readonly SopSectionText[];
  /** 本地改过、还没保存的正文（编辑器里的原文），按节 key */
  edits: Readonly<Record<string, string>>;
  /** 最近一次检查（或发布被拒）的问题，按 sectionKey 计数 */
  violations?: readonly Pick<ContractViolation, 'sectionKey'>[] | null;
}

/** 编辑器里的原文存进草稿以后的正文：与服务端保存时同一个规范化，末节的结尾是一个换行 */
const savedBody = (spec: readonly SectionSpecView[], i: number, raw: string): string => canonicalBody(raw, i === spec.length - 1);

/** 成员的目录：节表来自 /sop，锁定原因来自行业包 */
export function memberOutline(input: MemberOutlineInput): OutlineRow[] {
  const { spec, packSections, published, current, edits, violations } = input;
  return spec.map((s, i) => {
    const body = Object.hasOwn(edits, s.key) ? savedBody(spec, i, edits[s.key]!) : bodyOf(textOf(current, s.key), s);
    const online = bodyOf(textOf(published, s.key), s);
    const changed = !s.locked && body !== online;
    const def = packSections?.find((d) => d.key === s.key);
    return {
      key: s.key,
      name: s.heading ?? PREAMBLE_NAME,
      locked: s.locked,
      lockReason: s.locked ? (def?.lockReason ?? null) : null,
      chars: body.length,
      delta: changed ? body.length - online.length : 0,
      changed,
      issues: violations?.filter((v) => v.sectionKey === s.key).length ?? 0,
    };
  });
}

/** 一节相对线上的改动：before 是线上的正文，after 是草稿（含本地还没保存的改动，按保存时的规则规范化）的 */
export interface SectionChange {
  key: string;
  name: string;
  before: string;
  after: string;
}

/**
 * 相对线上改过的可编辑节（发布抽屉与「查看改动」的逐节改动），按节表的顺序；与目录的「改过」同一口径（memberOutline）
 */
export function changedSections(
  spec: readonly SectionSpecView[],
  published: readonly SopSectionText[],
  current: readonly SopSectionText[],
  edits: Readonly<Record<string, string>>,
): SectionChange[] {
  const out: SectionChange[] = [];
  for (const [i, s] of spec.entries()) {
    if (s.locked) continue;
    const after = Object.hasOwn(edits, s.key) ? savedBody(spec, i, edits[s.key]!) : bodyOf(textOf(current, s.key), s);
    const before = bodyOf(textOf(published, s.key), s);
    if (after !== before) out.push({ key: s.key, name: s.heading ?? PREAMBLE_NAME, before, after });
  }
  return out;
}

/**
 * 本地改过、还没存进草稿的节（自动保存要发的）：编辑器里的原文按保存时的规则规范化以后，与草稿（没有草稿就是线上）
 * 这一节的正文不同。body 照原文发，服务端存的时候自己规范化。改回草稿里的样子（含只多了行尾空格）就不算；固定规则节不发
 */
export function unsavedEdits(
  spec: readonly SectionSpecView[],
  current: readonly SopSectionText[],
  edits: Readonly<Record<string, string>>,
): { key: string; body: string }[] {
  const out: { key: string; body: string }[] = [];
  for (const [i, s] of spec.entries()) {
    if (s.locked || !Object.hasOwn(edits, s.key)) continue;
    const raw = edits[s.key]!;
    if (savedBody(spec, i, raw) !== bodyOf(textOf(current, s.key), s)) out.push({ key: s.key, body: raw });
  }
  return out;
}

/** 自动保存成功以后的 /sop：草稿换成服务端返回的那份，字数按它重算；线上版本、节表、上限不变 */
export function withSavedDraft(old: SopOverview, draft: SopVersion): SopOverview {
  return {
    ...old,
    draft: { ...draft, stale: draft.basedOn !== old.published.id },
    budget: { ...old.budget, chars: editableChars(draft.sections, old.spec) },
  };
}

/** 正文开头的「## 标题」行；没有就是前言 */
function headingFromText(text: string): string | null {
  if (!text.startsWith('## ')) return null;
  const end = text.indexOf('\n');
  return end < 0 ? text.slice(3) : text.slice(3, end);
}

/** 节的正文：去掉开头的「## 标题」行和其后的一个空行（匿名只有整节原文，中栏的标题已经单独写了）；前言原样 */
export function bodyWithoutHeading(text: string): string {
  if (headingFromText(text) === null) return text;
  const end = text.indexOf('\n');
  if (end < 0) return '';
  return text.startsWith('\n', end + 1) ? text.slice(end + 2) : text.slice(end + 1);
}

/** 匿名的目录：只有已发布版本的节，标题、锁定与原因取行业包 */
export function anonOutline(sections: readonly SopSectionText[], packSections?: readonly SopSectionDef[]): OutlineRow[] {
  return sections.map((s) => {
    const def = packSections?.find((d) => d.key === s.key);
    const heading = def ? def.heading : headingFromText(s.text);
    const locked = def?.locked ?? false;
    return {
      key: s.key,
      name: heading ?? PREAMBLE_NAME,
      locked,
      lockReason: locked ? (def?.lockReason ?? null) : null,
      chars: bodyOf(s.text, { key: s.key, heading }).length,
      delta: 0,
      changed: false,
      issues: 0,
    };
  });
}

/** 本地改动（规范化以后）合进草稿以后的全部节（额度按它算，与服务端的 editableChars 同一个函数） */
export function mergedSections(
  spec: readonly SectionSpecView[],
  current: readonly SopSectionText[],
  edits: Readonly<Record<string, string>>,
): SopSectionText[] {
  const out: SopSectionText[] = [];
  for (const [i, s] of spec.entries()) {
    if (Object.hasOwn(edits, s.key)) {
      const body = savedBody(spec, i, edits[s.key]!);
      out.push({ key: s.key, text: s.heading === null ? body : headingLine({ ...s, locked: false }) + body });
      continue;
    }
    // 草稿里没有的节不计，与服务端一样
    const own = current.find((x) => x.key === s.key);
    if (own) out.push(own);
  }
  return out;
}

// ---------------- 目录的分段筛选 ----------------

export type OutlineFilter = 'all' | 'editable' | 'changed';

export const OUTLINE_FILTERS: ReadonlyArray<readonly [OutlineFilter, string]> = [
  ['all', '全部'],
  ['editable', '可编辑'],
  ['changed', '已改'],
];

/** 筛掉以后一节都没有时的说明 */
export const FILTER_EMPTY: Readonly<Record<OutlineFilter, string>> = {
  all: '没有节',
  editable: '没有可编辑的节',
  changed: '还没有改过的节',
};

export const matchesFilter = (row: OutlineRow, f: OutlineFilter): boolean =>
  f === 'all' ? true : f === 'editable' ? !row.locked : row.changed;

export const filterCounts = (rows: readonly OutlineRow[]): Record<OutlineFilter, number> => ({
  all: rows.length,
  editable: rows.filter((r) => matchesFilter(r, 'editable')).length,
  changed: rows.filter((r) => matchesFilter(r, 'changed')).length,
});

/** 目录右侧的字数：「3,117」；改过的节带相对线上的差「954（+44）」，差为 0 时只写字数（圆点已经说明改过） */
export function countText(row: OutlineRow): string {
  if (!row.changed || row.delta === 0) return digits(row.chars);
  return `${digits(row.chars)}（${row.delta > 0 ? '+' : ''}${digits(row.delta)}）`;
}

/** 目录底部的说明；没有固定规则节时不写 */
export function lockNote(rows: readonly OutlineRow[]): string | null {
  const n = rows.filter((r) => r.locked).length;
  return n ? `带锁的${n}节是固定规则，由代码逐条核对，这里只能看` : null;
}

/** 锁定节的悬停说明，各段之间用 Sep 隔开：「固定规则 · 报价时机…由代码逐条核对」 */
export const lockTip = (row: Pick<OutlineRow, 'lockReason'>): string[] => (row.lockReason ? ['固定规则', row.lockReason] : ['固定规则节']);

// ---------------- 中栏的说明行（B 页） ----------------

/**
 * 可编辑节标题下那一行，各段之间用 Sep 隔开：能改的成员「可编辑 · 910 → 954字（+44）」，只读的成员只写字数，匿名不写。
 * 没改过（或改过但字数没变）只写「954字」
 */
export function sectionMeta(row: Pick<OutlineRow, 'chars' | 'delta' | 'changed'>, who: 'editor' | 'reader' | 'anon'): string[] | null {
  if (who === 'anon') return null;
  const count =
    row.changed && row.delta !== 0
      ? `${digits(row.chars - row.delta)} → ${digits(row.chars)}字（${row.delta > 0 ? '+' : ''}${digits(row.delta)}）`
      : `${digits(row.chars)}字`;
  return who === 'editor' ? ['可编辑', count] : [count];
}

/** 固定规则节正文上方那一行：「固定规则 · {lockReason}。这里改不了，要改请联系技术。」；包里没写原因时不写那半句 */
export function lockLine(row: Pick<OutlineRow, 'lockReason'>): string[] {
  const tail = '这里改不了，要改请联系技术。';
  const reason = row.lockReason?.replace(/[。.\s]+$/, '');
  return ['固定规则', reason ? `${reason}。${tail}` : tail];
}

/** 默认打开的节：第一个可编辑节，没有就第一节 */
export const defaultSection = (rows: readonly Pick<OutlineRow, 'key' | 'locked'>[]): string | undefined =>
  (rows.find((r) => !r.locked) ?? rows[0])?.key;

/** URL 上的 section：认得就用它，不认得（或没给）用默认节。加载骨架拿行业包的 sopSections 当 rows */
export function resolveSection(param: string | undefined, rows: readonly Pick<OutlineRow, 'key' | 'locked'>[]): string | undefined {
  return param !== undefined && rows.some((r) => r.key === param) ? param : defaultSection(rows);
}

export type StepKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';
export const STEP_KEYS: ReadonlySet<string> = new Set<StepKey>(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/**
 * 目录里按方向键：看得见的节里的上一节、下一节，Home、End 到头尾；到头不绕回（与 ⌘K 一致）。
 * 当前节被筛掉了时，向下从第一节开始、向上从最后一节开始。没有可去的节是 null
 */
export function stepSection(keys: readonly string[], cur: string | undefined, key: StepKey): string | null {
  if (!keys.length) return null;
  const i = cur === undefined ? -1 : keys.indexOf(cur);
  let j: number;
  if (key === 'Home') j = 0;
  else if (key === 'End') j = keys.length - 1;
  else if (i < 0) j = key === 'ArrowDown' ? 0 : keys.length - 1;
  else j = Math.min(Math.max(i + (key === 'ArrowDown' ? 1 : -1), 0), keys.length - 1);
  const next = keys[j]!;
  return next === cur ? null : next;
}

// ---------------- 额度条（设计系统 §6.2） ----------------

export type QuotaTone = 'ok' | 'warning' | 'danger';

export interface QuotaSegment {
  key: string;
  name: string;
  chars: number;
  changed: boolean;
  /** 占比例尺的比例（0–1） */
  share: number;
}

export interface QuotaModel {
  chars: number;
  limit: number;
  /** 写在标签里的百分比：<95% 最多写 94，95%–100% 写 95–100，超限至少写 101，与颜色一致 */
  percent: number;
  tone: QuotaTone;
  /** 百分比后面那段：「还能写355字」或「超出38字，发布会被拦下」 */
  tail: string;
  /** 比例尺的最大值（字） */
  scaleMax: number;
  /** 95% 与上限两根刻度在比例尺上的位置（0–1） */
  warnAt: number;
  limitAt: number;
  /** 每个可编辑节一段，按节的顺序 */
  parts: QuotaSegment[];
  /** 条的读屏说明 */
  ariaLabel: string;
}

/** 向上取到两位有效数字：2,790.9 → 2,800 */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const step = 10 ** Math.max(Math.floor(Math.log10(x)) - 1, 0);
  return Math.ceil(x / step) * step;
}

/**
 * 比例尺：上限与当前字数里大的那个，再放宽 5%，向上取两位有效数字。上限 2,658 时是 0–2,800（B 页），
 * 95% 刻度在 2,525、上限刻度在 2,658；超限时整段都画得下
 */
export const scaleMaxOf = (limit: number, chars: number): number => niceCeil((Math.max(limit, chars) * 105) / 100);

export function quotaTone(chars: number, limit: number): QuotaTone {
  if (chars > limit) return 'danger';
  return chars * 100 >= limit * 95 ? 'warning' : 'ok';
}

/** 写在标签里的百分比：<95% 最多写 94，95%–100% 写 95–100，超限至少写 101，与颜色一致（检查清单「字数在额度内」同一个写法） */
export function quotaPercent(chars: number, limit: number): number {
  if (!(limit > 0)) return 0;
  const tone = quotaTone(chars, limit);
  const raw = Math.round((chars * 100) / limit);
  return tone === 'ok' ? Math.min(raw, 94) : tone === 'warning' ? Math.min(Math.max(raw, 95), 100) : Math.max(raw, 101);
}

/** chars 用 editableChars 算（与服务端同一口径），parts 是可编辑节 */
export function quotaModel(rows: readonly OutlineRow[], chars: number, limit: number): QuotaModel {
  const tone = limit > 0 ? quotaTone(chars, limit) : 'ok';
  const percent = quotaPercent(chars, limit);
  const tail = tone === 'danger' ? `超出${digits(chars - limit)}字，发布会被拦下` : `还能写${digits(limit - chars)}字`;
  const scaleMax = scaleMaxOf(limit, chars);
  const parts = rows
    .filter((r) => !r.locked)
    .map((r) => ({ key: r.key, name: r.name, chars: r.chars, changed: r.changed, share: r.chars / scaleMax }));
  const spoken = parts.map((s) => `${s.name}${digits(s.chars)}字${s.changed ? '（已改）' : ''}`).join('，');
  const over = tone === 'danger' ? `，超出${digits(chars - limit)}字` : '';
  return {
    chars,
    limit,
    percent,
    tone,
    tail,
    scaleMax,
    warnAt: (limit * 0.95) / scaleMax,
    limitAt: limit / scaleMax,
    parts,
    ariaLabel: `可编辑正文用了${percent}%${over}：${spoken}；到95%提醒，${digits(limit)}字是上限`,
  };
}

// ---------------- 状态句（spec「状态句」） ----------------

/** 发布人没有名字（命令行导入、系统重渲染）时按来源写 */
export const SOURCE_VERB: Readonly<Record<SopVersion['source'], string>> = {
  import: '导入',
  console: '发布',
  rollback: '回滚',
  rerender: '系统更新',
};

export type PublishedHead = Pick<SopVersion, 'versionNo' | 'publishedAt' | 'publishedByName' | 'source'>;

/**
 * 成员：「线上v2 · 老板发布于9月25日 18:30 · 草稿改了2节」；没有改动时最后一段是「没有未发布的改动」。
 * changed 是草稿（含本地还没保存的改动）相对线上改了几个可编辑节。「已自动保存14:05」一段由自动保存（第 5.3 步）接在后面
 */
export function memberStatus(published: PublishedHead, changed: number, now: number): string[] {
  const out = [`线上v${published.versionNo ?? '—'}`];
  if (published.publishedAt) {
    const when = absoluteTime(published.publishedAt, now);
    out.push(published.publishedByName ? `${published.publishedByName}发布于${when}` : `${SOURCE_VERB[published.source]}于${when}`);
  }
  out.push(changed > 0 ? `草稿改了${changed}节` : '没有未发布的改动');
  return out;
}

/** 匿名：页头只有「线上v2 · 9月25日」 */
export const anonStatus = (published: { versionNo: number; publishedAt: string }, now: number): string[] => [
  `线上v${published.versionNo}`,
  dateText(published.publishedAt, now),
];

/** 额度与字数：本地改动合进草稿以后，与服务端 budget.chars 同一个函数算 */
export const draftChars = (
  spec: readonly SectionSpecView[],
  current: readonly SopSectionText[],
  edits: Readonly<Record<string, string>>,
): number => editableChars(mergedSections(spec, current, edits), spec);
