// 销售话术页第 5.1 步的自测（spec「销售话术（B、C 页）」的状态句、额度条、目录，设计系统 §6.2 与 B 页）：
// 1. 目录的数据：节表与锁定取 /sop 的 spec，锁定原因按 key 取行业包；匿名只用行业包；包里没有的节照样画得出来；
//    字数与相对线上的差、改过的节、问题数、分段筛选的计数、底部说明；
// 2. 额度条：与服务端同一个 editableChars 算（含还没保存的改动，先按保存时的规则规范化），B 页的数（2,303 / 2,658 字 · 87% · 还能写355字，
//    比例尺 0–2,800，刻度在 649、683 px 处），95% 与上限两道线上的颜色与百分比，超限的写法；
// 3. 状态句：成员与匿名，发布人没有名字时按来源写；
// 4. URL 的 section 与方向键：不认识的节退回默认节，到头不绕回，被筛掉的当前节；未保存保护只拦离开这一页；
// 5. 在 DOM 里挂载（happy-dom）：目录的链接、当前节、锁与圆点、只占一个 Tab 位、方向键 / Home / End / Enter、
//    点击与带修饰键的点击、分段筛选、锁定原因的 Tooltip；额度条的文字、段宽、刻度与颜色；窄屏的下拉。
// 6. 逐字重渲不碰弹层：打字时目录只重渲字数变了的那一行，窄屏下拉不重渲，关着的危险确认不挂 Portal
//    （这几处重渲会让 @rc-component/portal 在 effect 里 setState，快速连按时 React 报 #185，见 sop/Directory.tsx 文件头）。
// 7. 整页的接线：/sop 挂在真的路由上（内存里的地址栏），接口的数据预置在 QueryClient 里、不发请求。URL 的 section 选节，
//    方向键不进浏览历史、点击进；换节不弹未保存保护、去别的页弹；打字以后额度条跟着变；匿名的锁取自行业包；
//    Enter 以后焦点在编辑器正文上（只读节也一样）；加载骨架按身份画不画分段控件。
// 8. 编辑器（第 5.2 步，spec「销售话术 · 编辑器」）：行的排法、粗体、芯片的名字、相对线上的改动（按字比、只动空白的不算，
//    竖条画满改到的段落）；EditorState 上算出的装饰（藏起来的标记、芯片在外层、图标、挤压按看得见的字算，支持 text-spacing-trim
//    时只补隔着藏掉的「**」的几对）；CodeMirror 的每句内置文案都有中文；挂在 DOM 里的芯片、图标、改动标记、aria-label、只读、
//    失焦以后藏回「**」、挤压回退，换属性不重建编辑器；中栏的标题、说明行、固定规则说明；整页的接线。
// 9. 自动保存与三栏（第 5.3 步，spec「自动保存」「右栏」，不变量 20、21）：失败的分类、退避、⌘S、哪些节算没存上；
//    状态机（假的计时器）；整页接假服务端：请求带的 rev、状态句的保存那一段、断网与离开保护、409 冻结与载入最新草稿、
//    格式不对；三栏里各有哪几格（检查清单、工具卡片），骨架与窄屏。第 7、8 节不自动保存（计时设成永远不到）。
// 10. 检查与定位（第 6.2 步，spec「销售话术 · 检查」，验收 12）：问题落在哪一节、点了去哪、说明的写法、「改成…」的候选；
//    编辑器里的波浪线、行内提醒与「改成…」那一笔；整页接按正文算问题的假服务端：每次存上以后检查、打开时已有草稿也查、
//    只认最后发出的那次、没跑成与重试、清单点了定位、「改成…」以后马上存、没有草稿与只读成员不查；回滚以后再查、
//    先发的晚回来没跑成与丢弃时在路上的都不认；过期的草稿只有一条合并提示。
// 11. 发布（第 6.3 步，spec「发布条」「发布抽屉」）：行数、摘要、不能发布的原因、第一个问题、替换说明、预填与「再写至少一个字」、
//    逐节改动取哪几节、行内 / 并排的存取；差异的两种样子，@codemirror/merge 自带的颜色都被盖掉；整页接假服务端：
//    点「发布…」先存再开抽屉、只检查一次，发布成功写在条里（不弹 toast）、「回滚到v2」，发布被拒、没成功、检查在路上或没跑成，
//    查看改动与查看本节改动、焦点回到打开它的按钮，没有草稿、只读成员、匿名、有问题（跳到第一个）、409 停住。
// 整个进程按不支持 text-spacing-trim 的浏览器跑（selftest-env.ts），界面上的 cjk() 与编辑器都走 .halt 回退。
// 行业包用文件里的夹具（console/src 里只有渲染器自测能 import 行业包，spec「行业包通用架构 · 放在哪里」）：
// 一份照旅游包的节表写（B 页的场景数据），一份照家装整装假包的节表写，节的 key、标题、条数都和旅游包不同。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/sop/sop.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import './selftest-env.js';
import { win } from '../fields/selftest-dom.js';
import { EditorState, type RangeSet } from '@codemirror/state';
import { type Decoration, EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { act, type ReactElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AnonSopOverview,
  ContractViolation,
  DraftCheck,
  SectionSpecView,
  SopOverview,
  SopSectionText,
  SopVersion,
} from '../../../src/shared/console-api.js';
import type { IndustryPack, SopSectionDef } from '../../../src/shared/pack.js';
import { canonicalBody, editableChars } from '../../../src/shared/sop-sections.js';
import { HttpError } from '../api.js';
import { SopPage } from '../pages/SopPage.js';
import { SectionDiff } from '../SectionDiff.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { LEAVING_PAGE } from '../parts/UnsavedGuard.js';
import { needsTrimFallback } from '../typography.js';
import { VIEWER_KEY, type Viewer } from '../viewer.js';
import {
  AUTOSAVE_TIMING,
  type AutosaveTiming,
  AutosaveTimingContext,
  COMPOSE_POLL,
  createAutosaver,
  isSaveShortcut,
  retryDelay,
  saveFailure,
  type SaveStatus,
} from './autosave.js';
import { Directory, DirectorySelect, type SelectVia } from './Directory.js';
import { DiffList, trimEnd } from './DiffView.js';
import {
  buildDecorations,
  chipLabel,
  chipRanges,
  CM_PHRASES,
  draftMarks,
  fixNameAt,
  haltChars,
  lineShape,
  paragraphLines,
  problemFix,
  problemPlaces,
  problemsField,
  selectFirst,
  setProblems,
  sopEditorSetup,
  strongRanges,
  type Vocabulary,
} from './editor.js';
import {
  anonOutline,
  anonStatus,
  bodyWithoutHeading,
  changedSections,
  countText,
  defaultSection,
  draftChars,
  filterCounts,
  lockLine,
  lockNote,
  lockTip,
  matchesFilter,
  memberOutline,
  memberStatus,
  niceCeil,
  type OutlineFilter,
  type OutlineRow,
  quotaModel,
  quotaPercent,
  quotaTone,
  resolveSection,
  scaleMaxOf,
  sectionMeta,
  stepSection,
  unsavedEdits,
  withSavedDraft,
} from './outline.js';
import {
  editDistance,
  type EditorProblem,
  editorProblems,
  fixLabel,
  hintNote,
  locateViolations,
  nearestName,
  occurrences,
  problemText,
  sectionNotes,
} from './problems.js';
import {
  barBlock,
  changedText,
  DIFF_MODE_KEY,
  drawerBlock,
  firstProblem,
  lineStat,
  notePrefill,
  noteReady,
  publishedText,
  readDiffMode,
  replaceLine,
  statText,
  writeDiffMode,
} from './publish.js';
import { useShownWhileClosing } from './PublishParts.js';
import { QuotaBar } from './QuotaBar.js';
import { checkItems } from './SideCards.js';
import { cmPhrases, SectionPane, SopEditor } from './SopEditor.js';
import { SopSkeleton } from './SopSkeleton.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);

// ---------------- 夹具 ----------------

/** 照旅游包的节表（顺序、标题、锁定与 src/packs/travel/console-pack.ts 相同），锁定原因随便写，只要各不相同 */
const TRAVEL: readonly SopSectionDef[] = [
  { key: 'preamble', heading: null, locked: false },
  { key: 'stages', heading: '各阶段目标', locked: true, lockReason: '阶段目标由代码核对' },
  { key: 'orders', heading: '订单：改单、给别人再订、重发链接', locked: true, lockReason: '改单和下单工具绑在一起' },
  { key: 'tone', heading: '话术原则', locked: false },
  { key: 'quote-discipline', heading: '报价纪律（硬性）', locked: true, lockReason: '和算报价工具绑在一起' },
  { key: 'price-rules', heading: '定价规则（只有这两条，硬性）', locked: true, lockReason: '和价格护栏是同一套规则' },
  { key: 'objections', heading: '异议处理', locked: false },
  { key: 'capabilities', heading: '能力边界（硬性，先看这条）', locked: true, lockReason: '承诺由代码守' },
  { key: 'no-destinations', heading: '我们没有的目的地（如南极、冰岛）', locked: true, lockReason: '没有的目的地由代码判断' },
  { key: 'handoff', heading: '转人工条件（满足任一立即调用 handoff_to_human）', locked: true, lockReason: '要和转人工判断一致' },
  { key: 'wechat-style', heading: '微信语气规范', locked: false },
];
const SPEC: SectionSpecView[] = TRAVEL.map(({ key, heading, locked }) => ({ key, heading, locked }));

/** 照家装整装假包（src/shared/pack-fixtures/renovation.ts）的节表：9 节，key 与标题和旅游包不同 */
const RENO: readonly SopSectionDef[] = [
  { key: 'preamble', heading: null, locked: false },
  { key: 'stages', heading: '各阶段目标', locked: true, lockReason: '量房、出方案、报价的顺序由代码核对' },
  { key: 'tone', heading: '话术原则', locked: false },
  { key: 'pricing', heading: '报价规则（硬性）', locked: true, lockReason: '和算估价工具是同一套规则' },
  { key: 'measure', heading: '量房预约规则', locked: true, lockReason: '可约时段来自预约工具' },
  { key: 'objections', heading: '异议处理', locked: false },
  { key: 'capabilities', heading: '能力边界（硬性）', locked: true, lockReason: '工期和增项承诺由代码守' },
  { key: 'handoff', heading: '转人工条件', locked: true, lockReason: '要和系统的转人工判断一致' },
  { key: 'wechat-style', heading: '微信语气规范', locked: false },
];

/**
 * 正文恰好 n 个 UTF-16 码元（设计系统 §10.0 的场景字数），并且和服务端存下的一样是规范形：
 * 非末节以一个空行结尾（\n\n），末节以一个换行结尾
 */
const body = (n: number, ch = '话', last = false): string => {
  const end = last ? '\n' : '\n\n';
  return ch.repeat(n - end.length) + end;
};
const textFor = (def: Pick<SopSectionDef, 'heading'>, b: string): string => (def.heading === null ? b : `## ${def.heading}\n\n${b}`);
function sections(defs: readonly SopSectionDef[], lens: Record<string, number>, ch = '话'): SopSectionText[] {
  return defs.map((d, i) => ({ key: d.key, text: textFor(d, body(lens[d.key]!, ch, i === defs.length - 1)) }));
}

// B 页场景：线上 v2，草稿改了话术原则 910 → 954、异议处理 531 → 540，上限 2,658
const ONLINE_LENS = {
  preamble: 232,
  stages: 3117,
  orders: 448,
  tone: 910,
  'quote-discipline': 638,
  'price-rules': 559,
  objections: 531,
  capabilities: 779,
  'no-destinations': 317,
  handoff: 514,
  'wechat-style': 577,
};
const DRAFT_LENS = { ...ONLINE_LENS, tone: 954, objections: 540 };
const PUBLISHED = sections(TRAVEL, ONLINE_LENS);
// 草稿里改过的节换一个字，长度不变的改动也认得出
const DRAFT = sections(TRAVEL, DRAFT_LENS).map((s) =>
  s.key === 'tone' || s.key === 'objections' ? { ...s, text: s.text.replace(/话(\n+)$/, '改$1') } : s,
);
const LIMIT = 2658;
const NOW = Date.parse('2026-09-26T14:30:00+08:00');

// ---------------- 1. 目录的数据 ----------------
const rows = memberOutline({ spec: SPEC, packSections: TRAVEL, published: PUBLISHED, current: DRAFT, edits: {} });
{
  eq(
    '节的顺序与节表相同（prompt 的原顺序）',
    rows.map((r) => r.key),
    SPEC.map((s) => s.key),
  );
  eq(
    '前言没有标题，叫「前言」；其余照标题原文',
    [rows[0]!.name, rows[3]!.name, rows[9]!.name],
    ['前言', '话术原则', '转人工条件（满足任一立即调用 handoff_to_human）'],
  );
  eq(
    '锁定取 /sop 的节表',
    rows.map((r) => r.locked),
    SPEC.map((s) => s.locked),
  );
  eq(
    '锁定原因按 key 取行业包，可编辑节没有',
    rows.map((r) => r.lockReason),
    TRAVEL.map((d) => d.lockReason ?? null),
  );
  eq(
    '字数是正文（去掉标题行和空行）的长度',
    rows.map((r) => r.chars),
    SPEC.map((s) => DRAFT_LENS[s.key as keyof typeof DRAFT_LENS]),
  );
  eq(
    '只有话术原则、异议处理改过',
    rows.filter((r) => r.changed).map((r) => r.key),
    ['tone', 'objections'],
  );
  eq(
    '相对线上的差：+44、+9，没改的是 0',
    rows.map((r) => r.delta),
    [0, 0, 0, 44, 0, 0, 9, 0, 0, 0, 0],
  );
  eq('目录右侧的字数（B 页）', rows.map(countText), [
    '232',
    '3,117',
    '448',
    '954（+44）',
    '638',
    '559',
    '540（+9）',
    '779',
    '317',
    '514',
    '577',
  ]);
  eq('分段筛选的计数：全部 11 / 可编辑 4 / 已改 2', filterCounts(rows), { all: 11, editable: 4, changed: 2 });
  eq(
    '「可编辑」筛掉带锁的节',
    rows.filter((r) => matchesFilter(r, 'editable')).map((r) => r.key),
    ['preamble', 'tone', 'objections', 'wechat-style'],
  );
  eq('底部说明：带锁的7节', lockNote(rows), '带锁的7节是固定规则，由代码逐条核对，这里只能看');
  eq('没有带锁的节时不写说明', lockNote(rows.filter((r) => !r.locked)), null);
  eq('锁定节的悬停说明：「固定规则 · 原因」', lockTip(rows[1]!), ['固定规则', '阶段目标由代码核对']);

  // 长度不变的改动：圆点照画，字数不带差
  const same = memberOutline({
    spec: SPEC,
    published: PUBLISHED,
    current: PUBLISHED,
    edits: { preamble: body(232, '改') },
  });
  eq('长度没变的改动也算改过，字数不带「（+0）」', [same[0]!.changed, countText(same[0]!)], [true, '232']);
  // 删字写成「-33」
  const shorter = memberOutline({ spec: SPEC, published: PUBLISHED, current: PUBLISHED, edits: { tone: body(877) } });
  eq('删了字：「877（-33）」', countText(shorter[3]!), '877（-33）');

  // 本地还没保存的改动：敲了字算改过，删回原样就不算
  const typed = memberOutline({ spec: SPEC, published: PUBLISHED, current: DRAFT, edits: { preamble: body(240) } });
  eq('本地改动：前言 240（+8）', [typed[0]!.changed, countText(typed[0]!)], [true, '240（+8）']);
  const undone = memberOutline({ spec: SPEC, published: PUBLISHED, current: DRAFT, edits: { tone: body(910) } });
  eq('改回和线上一样：话术原则不再算改过', [undone[3]!.changed, filterCounts(undone).changed], [false, 1]);

  // 固定规则节即使草稿与线上不同（镜像换过）也不算「改过」，编辑器里改不了
  const drifted = memberOutline({
    spec: SPEC,
    published: PUBLISHED,
    current: PUBLISHED.map((s) => (s.key === 'stages' ? { ...s, text: `${s.text}新` } : s)),
    edits: {},
  });
  eq('固定规则节不算改过', drifted[1]!.changed, false);

  // 问题数：按 sectionKey 计，整体的问题（sectionKey 为 null）不落到任何一节
  const withIssues = memberOutline({
    spec: SPEC,
    published: PUBLISHED,
    current: DRAFT,
    edits: {},
    violations: [{ sectionKey: 'tone' }, { sectionKey: 'tone' }, { sectionKey: null }, { sectionKey: 'objections' }],
  });
  eq(
    '问题数按节计',
    withIssues.map((r) => r.issues),
    [0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0],
  );

  // 包还没到或包里没有这一节：锁照画，原因是 null，悬停只写「固定规则节」
  const noPack = memberOutline({ spec: SPEC, published: PUBLISHED, current: DRAFT, edits: {} });
  eq('包没到：锁照画、没有原因', [noPack[1]!.locked, noPack[1]!.lockReason, lockTip(noPack[1]!)], [true, null, ['固定规则节']]);
  const otherPack = memberOutline({ spec: SPEC, packSections: RENO, published: PUBLISHED, current: DRAFT, edits: {} });
  eq(
    '别的包里同 key 的节给原因，没有的给 null',
    [otherPack[1]!.lockReason, otherPack[2]!.lockReason],
    ['量房、出方案、报价的顺序由代码核对', null],
  );

  // 草稿里缺一节（节表里有）：不崩，按空算，额度与服务端一样不计它
  const missing = memberOutline({ spec: SPEC, published: PUBLISHED, current: DRAFT.filter((s) => s.key !== 'wechat-style'), edits: {} });
  eq('草稿缺一节：字数按 0', missing[10]!.chars, 0);

  // 匿名：只用行业包；照家装整装包的节表，key、标题、锁定、原因都取包
  const renoPublished = sections(RENO, {
    preamble: 120,
    stages: 800,
    tone: 300,
    pricing: 200,
    measure: 150,
    objections: 260,
    capabilities: 400,
    handoff: 180,
    'wechat-style': 210,
  });
  const anon = anonOutline(renoPublished, RENO);
  eq(
    '匿名（家装整装包）：标题取包',
    anon.map((r) => r.name),
    ['前言', '各阶段目标', '话术原则', '报价规则（硬性）', '量房预约规则', '异议处理', '能力边界（硬性）', '转人工条件', '微信语气规范'],
  );
  eq(
    '匿名：锁定与原因取包',
    anon.map((r) => (r.locked ? r.lockReason : '')),
    RENO.map((d) => (d.locked ? d.lockReason : '')),
  );
  eq('匿名：带锁的5节', lockNote(anon), '带锁的5节是固定规则，由代码逐条核对，这里只能看');
  eq('匿名：没有改过的节、没有问题', [filterCounts(anon).changed, anon.every((r) => r.issues === 0)], [0, true]);
  eq('匿名：字数是正文长度', anon[1]!.chars, 800);
  // 包里没有的节（旅游包的话术配着家装包）：标题从「## 」行取，按没锁算
  const mixed = anonOutline(PUBLISHED, RENO);
  eq(
    '匿名、包里没有的节：标题从正文取、不锁',
    [mixed[2]!.name, mixed[2]!.locked, mixed[1]!.locked, mixed[1]!.lockReason],
    ['订单：改单、给别人再订、重发链接', false, true, '量房、出方案、报价的顺序由代码核对'],
  );
  eq(
    '匿名、包没到：全都不锁，没有底部说明',
    [anonOutline(PUBLISHED).some((r) => r.locked), lockNote(anonOutline(PUBLISHED))],
    [false, null],
  );
}

// ---------------- 2. 额度条 ----------------
{
  const chars = draftChars(SPEC, DRAFT, {});
  eq('可编辑正文 2,303 字（与服务端同一个 editableChars）', [chars, editableChars(DRAFT, SPEC)], [2303, 2303]);
  const q = quotaModel(rows, chars, LIMIT);
  eq('B 页：87% · 还能写355字，中性', [q.percent, q.tail, q.tone], [87, '还能写355字', 'ok']);
  eq('比例尺 0–2,800 字', q.scaleMax, 2800);
  eq('720 宽的条上，95% 刻度在 649、上限在 683.5（B 页）', [Math.round(q.warnAt * 720), Math.round(q.limitAt * 7200) / 10], [649, 683.5]);
  eq(
    '每个可编辑节一段，按节的顺序，改过的标出来',
    q.parts.map((p) => [p.name, p.chars, p.changed]),
    [
      ['前言', 232, false],
      ['话术原则', 954, true],
      ['异议处理', 540, true],
      ['微信语气规范', 577, false],
    ],
  );
  eq('段宽按比例尺：前言 232 / 2,800', q.parts[0]!.share, 232 / 2800);
  eq(
    '条的读屏说明（B 页）',
    q.ariaLabel,
    '可编辑正文用了87%：前言232字，话术原则954字（已改），异议处理540字（已改），微信语气规范577字；到95%提醒，2,658字是上限',
  );

  // 本地还没保存的改动实时算进去（末节以一个换行结尾）
  eq('本地改动实时算：+23 字', draftChars(SPEC, DRAFT, { 'wechat-style': body(600, '话', true) }), 2326);
  eq('前言的本地改动不带标题行', draftChars(SPEC, DRAFT, { preamble: body(200) }), 2303 - 32);
  eq('锁定节的改动不计', draftChars(SPEC, DRAFT, { stages: body(10) }), 2303);

  // 编辑器里的原文按服务端保存时的规则规范化以后再算（src/sop/sections.ts 的 normalizeBody，规则见 canonicalBody）：
  // 去掉行尾空白与开头的空行，结尾补成一个空行（末节一个换行）。下面的数按那几条规则手算，保存前后不跳
  const online = 2250; // 线上：前言232、话术原则910、异议处理531、微信语气规范577
  const tone = body(910); // 线上的话术原则正文：908 个字加一个空行
  const toneRow = (raw: string): OutlineRow =>
    memberOutline({ spec: SPEC, published: PUBLISHED, current: PUBLISHED, edits: { tone: raw } })[3]!;
  const typedAtEnd = `${tone}测试`;
  eq(
    '在节末的空行上打「测试」：存下来是空行、测试、空行，+4 字而不是 +2',
    [draftChars(SPEC, PUBLISHED, { tone: typedAtEnd }), toneRow(typedAtEnd).chars, countText(toneRow(typedAtEnd))],
    [online + 4, 914, '914（+4）'],
  );
  const trailingSpace = tone.replace('\n', ' \n');
  eq(
    '行尾多敲一个空格：存下来与线上相同，不算改过',
    [draftChars(SPEC, PUBLISHED, { tone: trailingSpace }), toneRow(trailingSpace).changed, filterCounts([toneRow(trailingSpace)]).changed],
    [online, false, 0],
  );
  const noBlank = tone.slice(0, -1);
  eq(
    '删掉节末的空行：存下来照样补回，不算改过',
    [draftChars(SPEC, PUBLISHED, { tone: noBlank }), toneRow(noBlank).changed],
    [online, false],
  );
  eq(
    '末节以一个换行结尾：在末尾打「测试」+3 字',
    draftChars(SPEC, PUBLISHED, { 'wechat-style': `${body(577, '话', true)}测试` }),
    online + 3,
  );
  const ch = String.fromCharCode;
  // 粘贴进来的：开头两个空行、紧贴正文的 BOM、第一行行尾的空格和制表符、Windows 换行、
  // 分解形式的 é（e 加组合重音，NFC 以后是一个码元）、末尾两个空格
  const pasted = `\n\n${ch(0xfeff)}${'话'.repeat(10)} \t\r\ne${ch(0x301)}  `;
  eq(
    '粘贴的正文：去 BOM、开头空行、\\r，转 NFC，去行尾空白，补上空行',
    memberOutline({ spec: SPEC, published: PUBLISHED, current: PUBLISHED, edits: { preamble: pasted } })[0]!.chars,
    10 + 1 + 1 + 2,
  );
  // 单独的 \r（老式 Mac 换行）换成 \n：与线上逐字相同，不算改过
  const twoLines = PUBLISHED.map((x) => (x.key === 'preamble' ? { ...x, text: '上一行\n下一行\n\n' } : x));
  eq(
    '单独的 \\r 当换行：不算改过',
    memberOutline({ spec: SPEC, published: twoLines, current: twoLines, edits: { preamble: '上一行\r下一行' } })[0]!.changed,
    false,
  );
  // 快到上限时，打字的那一下按存下来的算：差 2 字到上限时在节末空行上打两个字，存下来超 2 字，条上就得是 danger
  const near = quotaModel(
    memberOutline({ spec: SPEC, published: PUBLISHED, current: PUBLISHED, edits: { tone: typedAtEnd } }),
    draftChars(SPEC, PUBLISHED, { tone: typedAtEnd }),
    online + 2,
  );
  eq('快到上限：按存下来的字数上色', [near.tone, near.tail], ['danger', '超出2字，发布会被拦下']);

  // 两道线：95% 起 warning，超过上限 danger；百分比与颜色一致（2,525 是 94.99%，写 94）
  const at = (n: number) => quotaModel(rows, n, LIMIT);
  eq('2,525 字：中性、94%', [at(2525).tone, at(2525).percent], ['ok', 94]);
  eq('2,526 字：warning、95%', [at(2526).tone, at(2526).percent, at(2526).tail], ['warning', 95, '还能写132字']);
  eq('正好到上限：warning、100%、还能写0字', [at(LIMIT).tone, at(LIMIT).percent, at(LIMIT).tail], ['warning', 100, '还能写0字']);
  eq('超 1 字：danger、101%', [at(LIMIT + 1).tone, at(LIMIT + 1).percent, at(LIMIT + 1).tail], ['danger', 101, '超出1字，发布会被拦下']);
  eq('超 38 字（spec 的例子）', at(LIMIT + 38).tail, '超出38字，发布会被拦下');
  check('超限时读屏说明写出超了多少', at(LIMIT + 38).ariaLabel.startsWith('可编辑正文用了101%，超出38字：'), at(LIMIT + 38).ariaLabel);
  eq('远超上限：百分比照实写', at(4000).percent, 150);
  eq(
    'quotaTone 的两道线',
    [quotaTone(94, 100), quotaTone(95, 100), quotaTone(100, 100), quotaTone(101, 100)],
    ['ok', 'warning', 'warning', 'danger'],
  );
  // 超限时比例尺放得下全部字数，刻度往左挪
  const over = at(3000);
  eq('超限：比例尺放宽到 3,200', over.scaleMax, 3200);
  check('超限：上限刻度仍在条内、在 95% 刻度右边', over.warnAt < over.limitAt && over.limitAt < 1);
  eq('两位有效数字取整', [niceCeil(2790.9), niceCeil(99), niceCeil(101.5), niceCeil(1), niceCeil(0)], [2800, 99, 110, 1, 1]);
  eq('比例尺：上限与字数取大的再放宽 5%', [scaleMaxOf(2658, 2303), scaleMaxOf(2658, 3000), scaleMaxOf(1000, 0)], [2800, 3200, 1100]);
}

// ---------------- 3. 状态句 ----------------
{
  const v2 = { versionNo: 2, publishedAt: '2026-09-25T10:30:00Z', publishedByName: '老板', source: 'console' as const };
  eq('成员（B 页）', memberStatus(v2, 2, NOW), ['线上v2', '老板发布于9月25日 18:30', '草稿改了2节']);
  eq('没有改动', memberStatus(v2, 0, NOW), ['线上v2', '老板发布于9月25日 18:30', '没有未发布的改动']);
  eq(
    '导入的版本没有发布人：按来源写',
    memberStatus({ ...v2, versionNo: 1, publishedByName: null, source: 'import', publishedAt: '2026-09-24T02:02:00Z' }, 0, NOW),
    ['线上v1', '导入于9月24日 10:02', '没有未发布的改动'],
  );
  eq('系统重渲染的版本', memberStatus({ ...v2, publishedByName: null, source: 'rerender' }, 1, NOW)[1], '系统更新于9月25日 18:30');
  eq('去年发布的写年份', memberStatus({ ...v2, publishedAt: '2025-12-31T02:00:00Z' }, 0, NOW)[1], '老板发布于2025年12月31日 10:00');
  eq('匿名：只有版本与日期', anonStatus({ versionNo: 2, publishedAt: '2026-09-25T10:30:00Z' }, NOW), ['线上v2', '9月25日']);
}

// ---------------- 4. URL 的 section、方向键、未保存保护 ----------------
{
  eq('默认节：第一个可编辑节', defaultSection(rows), 'preamble');
  const lockedFirst: OutlineRow[] = rows.map((r, i) => ({ ...r, locked: r.locked || i === 0 }));
  eq('第一节带锁时默认第一个可编辑节', defaultSection(lockedFirst), 'tone');
  eq('全都带锁时默认第一节', defaultSection(rows.map((r) => ({ ...r, locked: true }))), 'preamble');
  eq('没有节', defaultSection([]), undefined);
  eq('URL 上认得的节', resolveSection('objections', rows), 'objections');
  eq('URL 上不认得的节退回默认', resolveSection('nope', rows), 'preamble');
  eq('原型链上的名字不算认得', resolveSection('toString', rows), 'preamble');
  eq('没给 section', resolveSection(undefined, rows), 'preamble');

  const keys = ['a', 'b', 'c'];
  eq(
    '方向键：下一节、上一节、Home、End',
    [stepSection(keys, 'a', 'ArrowDown'), stepSection(keys, 'c', 'ArrowUp'), stepSection(keys, 'b', 'Home'), stepSection(keys, 'a', 'End')],
    ['b', 'b', 'a', 'c'],
  );
  eq(
    '到头不绕回',
    [stepSection(keys, 'c', 'ArrowDown'), stepSection(keys, 'a', 'ArrowUp'), stepSection(keys, 'a', 'Home')],
    [null, null, null],
  );
  eq('当前节被筛掉：向下从第一节、向上从最后一节', [stepSection(keys, 'x', 'ArrowDown'), stepSection(keys, 'x', 'ArrowUp')], ['a', 'c']);
  eq('一节都看不见', stepSection([], 'a', 'ArrowDown'), null);

  const loc = (pathname: string) => ({ pathname }) as never;
  eq(
    '未保存保护：只换查询参数（换节）不拦，离开这一页拦',
    [
      LEAVING_PAGE({ current: loc('/console/sop'), next: loc('/console/sop'), action: 'PUSH' }),
      LEAVING_PAGE({ current: loc('/console/sop'), next: loc('/console/catalog/route'), action: 'PUSH' }),
    ],
    [false, true],
  );
}

// ---------------- 5. 在 DOM 里挂载 ----------------

async function mount(el: ReactElement): Promise<{ box: HTMLElement; unmount(): Promise<void> }> {
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(el));
  await settle();
  return {
    box,
    async unmount() {
      await act(async () => root.unmount());
      box.remove();
    },
  };
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await win.happyDOM.waitUntilComplete();
  });
}
const all = <T extends Element>(root: ParentNode, sel: string): T[] => [...root.querySelectorAll<T>(sel)];
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
async function key(el: Element | null | undefined, k: string, mods: { altKey?: boolean } = {}): Promise<Event | null> {
  if (!el) return null;
  const e = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }) as unknown as Event;
  await act(async () => void el.dispatchEvent(e));
  return e;
}
async function clickEv(el: Element | null | undefined, init: { ctrlKey?: boolean; metaKey?: boolean } = {}): Promise<Event | null> {
  if (!el) return null;
  const e = new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }) as unknown as Event;
  await act(async () => void el.dispatchEvent(e));
  return e;
}

/** 目录加一个假的地址栏：选中的节存在状态里，和页面按 URL 换节一样 */
function harness(initial: { current?: string; filter?: OutlineFilter; anon?: boolean; list?: readonly OutlineRow[] } = {}) {
  const log: { selects: [string, SelectVia][]; enters: string[]; filters: OutlineFilter[] } = { selects: [], enters: [], filters: [] };
  function H() {
    const [cur, setCur] = useState(initial.current ?? 'tone');
    const [f, setF] = useState<OutlineFilter>(initial.filter ?? 'all');
    return (
      <Directory
        rows={initial.list ?? rows}
        current={cur}
        filter={initial.anon ? undefined : f}
        onFilter={
          initial.anon
            ? undefined
            : (x) => {
                log.filters.push(x);
                setF(x);
              }
        }
        showCounts={!initial.anon}
        hrefOf={(k) => `/console/sop?section=${k}`}
        onSelect={(k, via) => {
          log.selects.push([k, via]);
          setCur(k);
        }}
        onEnter={(k) => log.enters.push(k)}
      />
    );
  }
  return { el: <H />, log };
}

// 5.1 目录的结构
{
  const { el } = harness();
  const m = await mount(el);
  const nav = m.box.querySelector('nav');
  eq('目录是 nav 地标「话术目录」', nav?.getAttribute('aria-label'), '话术目录');
  const links = all<HTMLAnchorElement>(m.box, 'a.sop-toc-row');
  eq(
    '11 节，每节一个链接，地址带 section',
    links.map((a) => a.getAttribute('href')),
    SPEC.map((s) => `/console/sop?section=${s.key}`),
  );
  eq(
    '只有当前节 aria-current="page"',
    links.map((a) => a.getAttribute('aria-current')),
    SPEC.map((s) => (s.key === 'tone' ? 'page' : null)),
  );
  eq(
    '整个目录只占一个 Tab 位：当前节',
    links.map((a) => a.tabIndex),
    SPEC.map((s) => (s.key === 'tone' ? 0 : -1)),
  );
  eq(
    '带锁的节有锁（读屏念「固定规则节」），可编辑节没有',
    links.map((a) => a.querySelector('[role="img"][aria-label="固定规则节"]') !== null),
    SPEC.map((s) => s.locked),
  );
  eq(
    '改过的节带圆点（读屏念「已改」）',
    links.map((a) => a.querySelector('.sop-toc-dot[aria-label="已改"]') !== null),
    rows.map((r) => r.changed),
  );
  eq(
    '右侧字数',
    links.map((a) => text(a.querySelector('.sop-toc-count'))),
    rows.map(countText),
  );
  eq(
    '带锁的节、改过的节各有 class（次要色节名、主色字数）',
    links.map((a) => [a.classList.contains('is-locked'), a.classList.contains('is-changed')]),
    rows.map((r) => [r.locked, r.changed]),
  );
  const group = m.box.querySelector('[role="radiogroup"]');
  eq('分段控件是「显示哪些节」', group?.getAttribute('aria-label'), '显示哪些节');
  eq('分段控件的三段带计数', all(m.box, '.sop-toc-filter-label').map(text), ['全部11', '可编辑4', '已改2']);
  eq('底部说明', text(m.box.querySelector('.sop-toc-note')), '带锁的7节是固定规则，由代码逐条核对，这里只能看');
  eq('没有问题时不写问题数', m.box.querySelector('.sop-toc-issue'), null);
  await m.unmount();
}

// 5.2 键盘与点击
{
  const { el, log } = harness();
  const m = await mount(el);
  const link = (k: string) => all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').find((a) => a.dataset.key === k);
  link('tone')!.focus();
  let e = await key(link('tone'), 'ArrowDown');
  eq('↓：换到下一节（不进浏览历史）', log.selects.at(-1), ['quote-discipline', 'key']);
  check('↓：拦下浏览器的滚动', e?.defaultPrevented === true);
  eq('↓：焦点跟到下一节', (document.activeElement as HTMLElement | null)?.dataset.key, 'quote-discipline');
  eq('换节以后 Tab 位跟着走', link('quote-discipline')!.tabIndex, 0);
  await key(link('quote-discipline'), 'ArrowUp');
  eq('↑：回到上一节', log.selects.at(-1), ['tone', 'key']);
  await key(link('tone'), 'End');
  eq('End：最后一节', log.selects.at(-1), ['wechat-style', 'key']);
  const before = log.selects.length;
  await key(link('wechat-style'), 'ArrowDown');
  eq('最后一节再 ↓：不动', log.selects.length, before);
  await key(link('wechat-style'), 'Home');
  eq('Home：第一节', log.selects.at(-1), ['preamble', 'key']);
  const n = log.selects.length;
  await key(link('preamble'), 'ArrowDown', { altKey: true });
  eq('带修饰键的方向键不管', log.selects.length, n);
  e = await key(link('preamble'), 'Enter');
  eq('Enter：进这一节的编辑器', log.enters, ['preamble']);
  check('Enter：不跟着链接走', e?.defaultPrevented === true);
  eq('Enter 在当前节上：不再选一次', log.selects.length, n);

  e = await clickEv(link('objections'));
  eq('点一节：选中（进浏览历史）', log.selects.at(-1), ['objections', 'click']);
  check('点一节：不整页跳转', e?.defaultPrevented === true);
  eq('点了以后它是当前节', link('objections')!.getAttribute('aria-current'), 'page');
  const k = log.selects.length;
  e = await clickEv(link('stages'), { ctrlKey: true });
  check('带修饰键的点击交给浏览器（新标签打开这一节）', log.selects.length === k && e?.defaultPrevented === false);
  e = await clickEv(link('stages'), { metaKey: true });
  check('⌘点击同样交给浏览器', log.selects.length === k && e?.defaultPrevented === false);
  await clickEv(link('objections'));
  eq('点当前节：不再选一次', log.selects.length, k);
  await m.unmount();
}

// 5.3 分段筛选
{
  const { el, log } = harness({ current: 'stages' });
  const m = await mount(el);
  const seg = (label: string) =>
    all<HTMLLabelElement>(m.box, '.ant-segmented-item')
      .find((l) => text(l).startsWith(label))
      ?.querySelector('input');
  await clickEv(seg('已改'));
  eq('点「已改」', log.filters, ['changed']);
  eq(
    '「已改」只列改过的节',
    all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').map((a) => a.dataset.key),
    ['tone', 'objections'],
  );
  eq(
    '当前节被筛掉时，Tab 位落在看得见的第一节',
    all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').map((a) => a.tabIndex),
    [0, -1],
  );
  const first = all<HTMLAnchorElement>(m.box, 'a.sop-toc-row')[0]!;
  await key(first, 'Enter');
  eq(
    '在看得见的第一节上按 Enter：先选中它，再进编辑器',
    [log.enters, m.box.querySelector('[aria-current="page"]')?.getAttribute('data-key')],
    [['tone'], 'tone'],
  );
  await clickEv(seg('可编辑'));
  eq(
    '「可编辑」只列可编辑节',
    all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').map((a) => a.dataset.key),
    ['preamble', 'tone', 'objections', 'wechat-style'],
  );
  eq('筛选以后底部说明照写全部带锁的节', text(m.box.querySelector('.sop-toc-note')), '带锁的7节是固定规则，由代码逐条核对，这里只能看');
  await m.unmount();

  const none = harness({ filter: 'changed', list: rows.map((r) => ({ ...r, changed: false, delta: 0 })) });
  const m2 = await mount(none.el);
  eq('「已改」一节都没有时写一句说明', text(m2.box.querySelector('.sop-toc-empty')), '还没有改过的节');
  eq('这时没有链接', all(m2.box, 'a.sop-toc-row').length, 0);
  await m2.unmount();
}

// 5.4 问题数、锁定原因的 Tooltip
{
  const withIssues = memberOutline({
    spec: SPEC,
    packSections: TRAVEL,
    published: PUBLISHED,
    current: DRAFT,
    edits: {},
    violations: [{ sectionKey: 'tone' }],
  });
  const { el } = harness({ list: withIssues });
  const m = await mount(el);
  const link = (k: string) => all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').find((a) => a.dataset.key === k)!;
  eq('有问题的节下一行写「1个问题」', text(link('tone').querySelector('.sop-toc-issue')), '1个问题');
  eq('只有这一节写', all(m.box, '.sop-toc-issue').length, 1);
  await act(async () => link('stages').focus());
  await settle();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  await settle();
  const tips = all(document.body, '.ant-tooltip');
  check(
    '聚焦带锁的节：Tooltip 写锁定原因',
    tips.some((t) => text(t).includes('固定规则·阶段目标由代码核对')),
    tips.map(text).join(' | '),
  );
  const described = link('stages').getAttribute('aria-describedby');
  check(
    '读屏：锁定原因接进 aria-describedby',
    !!described && text(document.getElementById(described)).includes('阶段目标由代码核对'),
    String(described),
  );
  await m.unmount();
}

// 5.5 匿名：没有分段控件和字数
{
  const anonRows = anonOutline(PUBLISHED, TRAVEL);
  const { el } = harness({ anon: true, list: anonRows, current: 'preamble' });
  const m = await mount(el);
  eq('匿名：没有分段控件', m.box.querySelector('[role="radiogroup"]'), null);
  eq('匿名：没有字数', m.box.querySelector('.sop-toc-count'), null);
  eq('匿名：锁照画', all(m.box, '[aria-label="固定规则节"]').length, 7);
  eq('匿名：11 节', all(m.box, 'a.sop-toc-row').length, 11);
  await m.unmount();
}

// 5.6 额度条
{
  const q = quotaModel(rows, 2303, LIMIT);
  const m = await mount(<QuotaBar model={q} />);
  const sec = m.box.querySelector('section.sop-quota');
  check('中性时的 class', sec?.classList.contains('is-ok') === true, sec?.className);
  eq('标签（B 页）', text(m.box.querySelector('.sop-quota-line')), '可编辑正文2,303 / 2,658字·87%·还能写355字');
  eq('数字另有 class（text 500）', text(m.box.querySelector('.sop-quota-num')), '2,303 / 2,658');
  eq('图例', all(m.box, '.sop-quota-legend > span').map(text), ['改过的节', '没改的节', '固定规则节不计入']);
  eq('中性时没有图标', m.box.querySelector('.sop-quota-icon'), null);
  const bar = m.box.querySelector('[role="img"]');
  eq('条的读屏说明', bar?.getAttribute('aria-label'), q.ariaLabel);
  const segs = all<HTMLElement>(m.box, '.sop-quota-track > span');
  eq(
    '四段，段宽按比例尺，改过的是主色',
    segs.map((s) => [s.style.width, s.classList.contains('is-changed')]),
    [
      [`${((232 / 2800) * 100).toFixed(3)}%`, false],
      [`${((954 / 2800) * 100).toFixed(3)}%`, true],
      [`${((540 / 2800) * 100).toFixed(3)}%`, true],
      [`${((577 / 2800) * 100).toFixed(3)}%`, false],
    ],
  );
  eq(
    '两根刻度',
    all<HTMLElement>(m.box, '.sop-quota-tick').map((t) => t.style.left),
    [`${(((LIMIT * 0.95) / 2800) * 100).toFixed(3)}%`, `${((LIMIT / 2800) * 100).toFixed(3)}%`],
  );
  eq('刻度下的字', all(m.box, '.sop-quota-tick-label').map(text), ['95%', '上限']);
  await m.unmount();

  const w = await mount(<QuotaBar model={quotaModel(rows, 2600, LIMIT)} />);
  check('≥95%：warning 的 class 与图标', !!w.box.querySelector('section.sop-quota.is-warning .sop-quota-icon'));
  eq('≥95% 的标签', text(w.box.querySelector('.sop-quota-line')), '可编辑正文2,600 / 2,658字·98%·还能写58字');
  await w.unmount();
  const d = await mount(<QuotaBar model={quotaModel(rows, LIMIT + 38, LIMIT)} />);
  check('超限：danger 的 class 与图标', !!d.box.querySelector('section.sop-quota.is-danger .sop-quota-icon'));
  eq('超限的标签', text(d.box.querySelector('.sop-quota-line')), '可编辑正文2,696 / 2,658字·101%·超出38字，发布会被拦下');
  await d.unmount();
}

// 5.7 窄屏的下拉
{
  const picked: string[] = [];
  function H() {
    const [cur, setCur] = useState('tone');
    return (
      <DirectorySelect
        rows={rows}
        current={cur}
        onSelect={(k) => {
          picked.push(k);
          setCur(k);
        }}
      />
    );
  }
  const m = await mount(<H />);
  const input = m.box.querySelector('input');
  eq('下拉的名字「选择节」', input?.getAttribute('aria-label'), '选择节');
  const chosen = m.box.querySelector('.ant-select-content .sop-toc-option, .ant-select-selection-item .sop-toc-option');
  eq(
    '选中项写当前节，改过的带圆点，不写字数',
    [text(chosen), !!chosen?.querySelector('.sop-toc-dot'), chosen?.querySelector('.sop-toc-count') ?? null],
    ['话术原则', true, null],
  );
  // 展开
  await act(async () => {
    m.box
      .querySelector('.ant-select')!
      .dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await settle();
  const options = all<HTMLElement>(document.body, '.ant-select-item-option');
  eq(
    '展开：11 项，照目录的顺序',
    options.map((o) => text(o.querySelector('.sop-toc-name'))),
    rows.map((r) => r.name),
  );
  eq(
    '选项里带锁',
    options.map((o) => o.querySelector('[aria-label="固定规则节"]') !== null),
    rows.map((r) => r.locked),
  );
  check(
    '下拉底部有锁的说明',
    all(document.body, '.ant-select-dropdown .sop-toc-note').some((n) => text(n).startsWith('带锁的7节')),
  );
  check('节多于 7 个：可以搜', input?.getAttribute('readonly') === null, String(input?.getAttribute('readonly')));
  await clickEv(options.find((o) => text(o).startsWith('异议处理')));
  await settle();
  eq('选一项：换节', picked, ['objections']);
  await m.unmount();
}

// ---------------- 6. 逐字重渲不碰弹层 ----------------
// 看一个组件这次有没有重渲：从 DOM 节点取 React 挂的 fiber（__reactFiber$ 键），走到根上，再从根的 current 树往下
// 找这个组件（DOM 上挂的可能是旧的那一棵）；memo 跳过时 React 把 memoizedProps 设回上一次的那个对象，重渲时是这次
// 传进来的新对象。用的是 React 内部结构（版本钉在 19.3），找不到要看的组件时断言失败，不会悄悄通过。
type Fiber = {
  type: unknown;
  memoizedProps: unknown;
  stateNode: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
};
function fiberOf(el: Element | null | undefined): Fiber | null {
  if (!el) return null;
  const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
  return k ? ((el as unknown as Record<string, Fiber>)[k] ?? null) : null;
}
function nameOf(f: Fiber): string | undefined {
  const t = f.type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string } } | string | null;
  if (typeof t === 'function') return (t as { displayName?: string }).displayName ?? (t as { name: string }).name;
  if (t && typeof t === 'object') return t.displayName ?? t.render?.displayName ?? t.render?.name;
  return undefined;
}
/** el 所在的那棵树现在的样子里，所有叫 name 的组件 */
function currentNamed(el: Element | null | undefined, name: string): Fiber[] {
  let top = fiberOf(el);
  while (top?.return) top = top.return;
  const root = (top?.stateNode as { current?: Fiber } | undefined)?.current ?? null;
  const out: Fiber[] = [];
  const walk = (f: Fiber | null): void => {
    for (let c = f; c; c = c.sibling) {
      if (nameOf(c) === name) out.push(c);
      walk(c.child);
    }
  };
  walk(root);
  return out;
}
function hasDescendantNamed(f: Fiber | null, name: string): boolean {
  for (let c = f?.child ?? null; c; c = c.sibling) if (nameOf(c) === name || hasDescendantNamed(c, name)) return true;
  return false;
}

/** 挂一个根，之后用 render 换属性重渲（和页面按新的字数重渲一样） */
async function rootFor(el: ReactElement): Promise<{ box: HTMLElement; render(el: ReactElement): Promise<void>; unmount(): Promise<void> }> {
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  const render = async (next: ReactElement): Promise<void> => {
    await act(async () => root.render(next));
    await settle();
  };
  await render(el);
  return {
    box,
    render,
    async unmount() {
      await act(async () => root.unmount());
      box.remove();
    },
  };
}
const noop = (): void => undefined;
const hrefFor = (k: string): string => `/console/sop?section=${k}`;

// 6.1 目录：在「微信语气规范」里打字，只有这一行重渲；打开过 Tooltip 的带锁行不重渲
{
  const dir = (list: readonly OutlineRow[]) => (
    <Directory rows={list} current="wechat-style" filter="all" onFilter={noop} showCounts hrefOf={hrefFor} onSelect={noop} onEnter={noop} />
  );
  const m = await rootFor(dir(rows));
  const link = (k: string) => all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').find((a) => a.dataset.key === k);
  // 先让一个带锁行的 Tooltip 打开一次：弹层（和它的 Portal）从此一直挂着
  await act(async () => link('stages')!.focus());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  await act(async () => link('stages')!.blur());
  await settle();
  const propsOf = () =>
    new Map(currentNamed(link('tone'), 'TocRow').map((f) => [(f.memoizedProps as { rowKey: string }).rowKey, f.memoizedProps]));
  const before = propsOf();
  eq(
    '找得到每一行的 TocRow',
    [...before.keys()],
    SPEC.map((sp) => sp.key),
  );
  const typed = memberOutline({
    spec: SPEC,
    packSections: TRAVEL,
    published: PUBLISHED,
    current: DRAFT,
    edits: { 'wechat-style': body(600, '话', true) },
  });
  await m.render(dir(typed));
  const after = propsOf();
  eq(
    '打字：只有字数变了的那一行重渲',
    SPEC.map((sp) => sp.key).filter((k) => before.get(k) !== after.get(k)),
    ['wechat-style'],
  );
  eq('这一行的字数跟着变', text(link('wechat-style')?.querySelector('.sop-toc-count')), '600（+23）');
  await m.unmount();
}

// 6.2 窄屏下拉：打开过以后，打字（字数变）不重渲；某一节变成「改过」时重渲
{
  const sel = (list: readonly OutlineRow[]) => <DirectorySelect rows={list} current="wechat-style" onSelect={noop} />;
  const m = await rootFor(sel(rows));
  await act(async () => {
    m.box
      .querySelector('.ant-select')!
      .dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await settle();
  const found = () => currentNamed(m.box.querySelector('.sop-toc-select'), 'DirectorySelect');
  const props = () => found()[0]?.memoizedProps;
  const p0 = props();
  eq('找得到 DirectorySelect', found().length, 1);
  // 「话术原则」草稿里已经改过：再打字只是字数变
  const more = memberOutline({ spec: SPEC, packSections: TRAVEL, published: PUBLISHED, current: DRAFT, edits: { tone: body(960) } });
  eq('打字前后「话术原则」都算改过、字数变了', [rows[3]!.changed, more[3]!.changed, more[3]!.chars], [true, true, 960]);
  await m.render(sel(more));
  check('打字：下拉不重渲', props() === p0);
  const preChanged = rows.map((r) => (r.key === 'preamble' ? { ...r, changed: true, delta: 1, chars: r.chars + 1 } : r));
  await m.render(sel(preChanged));
  check('有一节变成「改过」：下拉重渲', props() !== p0);
  const pre = all<HTMLElement>(document.body, '.ant-select-item-option').find((o) => text(o).startsWith('前言'));
  check('选项里这一节带上圆点', !!pre?.querySelector('.sop-toc-dot'));
  // 检查以后「话术原则」有 1 个问题：下拉跟着重渲，选项与目录一样写问题数
  const p1 = props();
  await m.render(sel(preChanged.map((r) => (r.key === 'tone' ? { ...r, issues: 1 } : r))));
  check('问题数变了：下拉重渲', props() !== p1);
  const option = (name: string) => all<HTMLElement>(document.body, '.ant-select-item-option').find((o) => text(o).startsWith(name));
  eq(
    '选项里写问题数，没有问题的不写',
    [text(option('话术原则')?.querySelector('.sop-toc-issue')), option('异议处理')?.querySelector('.sop-toc-issue') ?? null],
    ['1个问题', null],
  );
  await m.unmount();
}

// 6.3 危险确认：关着时不挂弹层的 Portal，打开时才有
{
  const H = ({ open }: { open: boolean }) => (
    <div className="confirm-host">
      <ConfirmDanger open={open} title="t" confirmText="a" cancelText="b" onConfirm={noop} onCancel={noop} />
    </div>
  );
  const m = await rootFor(<H open={false} />);
  const host = () => currentNamed(m.box.querySelector('.confirm-host'), 'H')[0] ?? null;
  check('找得到外层的组件', host() !== null);
  eq('关着：没有 Portal', hasDescendantNamed(host(), 'Portal'), false);
  await m.render(<H open />);
  eq('打开：有 Portal', hasDescendantNamed(host(), 'Portal'), true);
  await m.unmount();
}

// ---------------- 7. 整页的接线 ----------------
// 路由照 router.tsx 的 /sop（basepath /console，search 只有 section），另有一页 /audit 当「别的页」。
// 接口的数据预置在 QueryClient 里（staleTime 无限，不会再取）；真发了请求就记下来、永远不回（加载中的骨架靠它停在加载中）。

/** 同 router.tsx 的 sopSearch：只收字符串的 section */
const sopSearch = (s: Record<string, unknown>): { section?: string } => (typeof s.section === 'string' ? { section: s.section } : {});

const requests: string[] = [];
/** 第 9 节的假服务端：给了就由它回，没给就永远不回（第 7、8 节） */
interface Call {
  method: string;
  path: string;
  body: unknown;
}
let respond: ((call: Call) => Promise<Response>) | null = null;
const calls: Call[] = [];
globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  requests.push(String(input));
  const call: Call = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: new URL(String(input), 'http://localhost').pathname,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
  };
  calls.push(call);
  return respond ? respond(call) : new Promise<never>(() => undefined);
}) as typeof fetch;

/** 第 7、8 节不自动保存（打字以后等得再久也不发 PUT），第 9 节换成短的时间 */
const NO_AUTOSAVE: AutosaveTiming = { debounce: 1e9, backoff: [1e9], now: () => NOW };

/** 页面只用到行业包的话术节；其余照类型填空 */
const packOf = (sopSections: readonly SopSectionDef[]): IndustryPack => ({
  id: 'fixture',
  name: '夹具',
  vocabulary: { customer: '客户', advisor: '顾问', productNoun: '产品', tools: {}, sopFields: {} },
  entities: [],
  stages: [],
  sopSections: [...sopSections],
  nav: { catalogGroup: '产品库', entities: [] },
});

const version = (versionNo: number | null, secs: SopSectionText[], extra: Partial<SopVersion> = {}): SopVersion => ({
  id: versionNo === null ? 'draft' : `v${versionNo}`,
  versionNo,
  status: versionNo === null ? 'draft' : 'published',
  source: 'console',
  sections: secs,
  basedOn: null,
  rev: 0,
  promptHash: 'a'.repeat(64),
  toolsHash: null,
  prefixHash: null,
  sopHash: null,
  changeNote: null,
  createdByName: '老板',
  createdAt: '2026-09-25T10:30:00Z',
  publishedByName: '老板',
  publishedAt: '2026-09-25T10:30:00Z',
  ...extra,
});
const V2 = version(2, PUBLISHED);
const MEMBER_SOP: SopOverview = {
  published: V2,
  draft: { ...version(null, DRAFT, { basedOn: 'v2', rev: 4, publishedAt: null, publishedByName: null }), stale: false },
  spec: SPEC,
  budget: { chars: 2303, limit: LIMIT },
};
const OWNER: Viewer = {
  kind: 'member',
  me: { userId: 'u1', displayName: '老板', role: 'owner', csrf: 'c1', tenantSlug: 't', tenantName: '云途' },
  pack: packOf(TRAVEL),
};

interface PageBox {
  box: HTMLElement;
  qc: QueryClient;
  router: ReturnType<typeof createRouter>;
  section(): string | undefined;
  pathname(): string;
  unmount(): Promise<void>;
}

/** 挂整页：url 是地址栏里的原样（带 /console） */
async function mountPage(
  url: string,
  viewer: Viewer,
  sop: SopOverview | AnonSopOverview | null,
  timing: AutosaveTiming = NO_AUTOSAVE,
): Promise<PageBox> {
  const root = createRootRoute({ component: Outlet });
  const sopRoute = createRoute({ getParentRoute: () => root, path: '/sop', validateSearch: sopSearch, component: SopPage });
  const other = createRoute({ getParentRoute: () => root, path: '/audit', component: () => <p className="other-page">别的页</p> });
  const router = createRouter({
    routeTree: root.addChildren([sopRoute, other]),
    history: createMemoryHistory({ initialEntries: [url] }),
    basepath: '/console',
  });
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(VIEWER_KEY, viewer);
  if (sop) qc.setQueryData(['sop'], sop);
  qc.setQueryData(['sop-versions'], { pages: [{ items: [V2] }], pageParams: [undefined] });
  const box = document.createElement('div');
  document.body.append(box);
  const r = createRoot(box);
  await act(async () =>
    r.render(
      <QueryClientProvider client={qc}>
        <AutosaveTimingContext.Provider value={timing}>
          <RouterProvider router={router as never} />
        </AutosaveTimingContext.Provider>
      </QueryClientProvider>,
    ),
  );
  await until(() => box.querySelector('.sop-editor .cm-content, .sop-skel-editor') !== null);
  return {
    box,
    qc,
    router: router as never,
    section: () => (router.state.location.search as { section?: string }).section,
    pathname: () => router.state.location.pathname,
    async unmount() {
      await act(async () => r.unmount());
      box.remove();
      qc.clear();
    },
  };
}

/** 等一会儿，其间的定时器（Tooltip 的显示、隐藏）都在 act 里跑 */
const rest = (ms: number): Promise<void> => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/** 等到条件成立（路由换地址、编辑器重建都要几个回合）；等不到就算了，由后面的断言报 */
async function until(cond: () => boolean, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await settle();
}

const rowIn = (m: PageBox, k: string): HTMLAnchorElement | undefined =>
  all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').find((a) => a.dataset.key === k);
const currentRow = (m: PageBox): string | undefined => m.box.querySelector<HTMLElement>('a.sop-toc-row[aria-current="page"]')?.dataset.key;
const editorText = (m: PageBox): string | undefined => {
  const el = m.box.querySelector<HTMLElement>('.sop-editor .cm-content');
  return el ? EditorView.findFromDOM(el)?.state.doc.toString() : undefined;
};
const bodyIn = (secs: readonly SopSectionText[], k: string): string => {
  const def = TRAVEL.find((d) => d.key === k)!;
  const text = secs.find((x) => x.key === k)!.text;
  return def.heading === null ? text : text.slice(`## ${def.heading}\n\n`.length);
};
const quotaNum = (m: PageBox): string => text(m.box.querySelector('.sop-quota-num'));
const guardOpen = (): boolean => all(document.body, '.ant-modal-title').some((t) => text(t) === '有改动还没保存');
const historyLength = (m: PageBox): number => m.router.history.length;

// 7.1 URL 的 section 选节；不认得的退回默认节
{
  const m = await mountPage('/console/sop?section=objections', OWNER, MEMBER_SOP);
  eq('?section=objections：目录选中异议处理', currentRow(m), 'objections');
  eq('?section=objections：编辑器里是异议处理的正文', editorText(m), bodyIn(DRAFT, 'objections'));
  await m.unmount();
  const n = await mountPage('/console/sop?section=nope', OWNER, MEMBER_SOP);
  eq('?section=nope：退回默认节（第一个可编辑节）', [currentRow(n), editorText(n)], ['preamble', bodyIn(DRAFT, 'preamble')]);
  await n.unmount();
}

// 7.2 方向键换节不进浏览历史，点击进；后退回到点之前的节
{
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP);
  const len = historyLength(m);
  await act(async () => rowIn(m, 'tone')!.focus());
  await key(rowIn(m, 'tone'), 'ArrowDown');
  await until(() => m.section() === 'quote-discipline');
  eq('↓：地址换成下一节，浏览历史不加一条', [m.section(), historyLength(m)], ['quote-discipline', len]);
  eq('↓：目录与编辑器跟着换', [currentRow(m), editorText(m)], ['quote-discipline', bodyIn(DRAFT, 'quote-discipline')]);
  await clickEv(rowIn(m, 'objections'));
  await until(() => m.section() === 'objections');
  eq('点一节：地址换成这一节，浏览历史加一条', [m.section(), historyLength(m)], ['objections', len + 1]);
  await act(async () => m.router.history.back());
  await until(() => m.section() === 'quote-discipline');
  eq('后退：回到点之前的节', currentRow(m), 'quote-discipline');
  await m.unmount();
}

// 7.3 打字：额度条与目录跟着变；换节不弹未保存保护、改动还在；去别的页弹，「留下」后留在原页
{
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP);
  eq('打字前：额度条是草稿的字数', quotaNum(m), '2,303 / 2,658');
  const view = EditorView.findFromDOM(m.box.querySelector<HTMLElement>('.sop-editor .cm-content')!)!;
  // 在节末的空行上打两个字：存下来是 +4（规范化以后结尾补一个空行）
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '测试' }, userEvent: 'input.type' }));
  await settle();
  eq('打字以后：额度条按存下来的字数算', quotaNum(m), '2,307 / 2,658');
  eq('打字以后：目录这一行的字数', text(rowIn(m, 'tone')?.querySelector('.sop-toc-count')), '958（+48）');
  await clickEv(rowIn(m, 'objections'));
  await until(() => m.section() === 'objections');
  eq('有改动时换节：不弹未保存保护，换过去了', [guardOpen(), m.section()], [false, 'objections']);
  eq('换节以后改动还在，额度照算', quotaNum(m), '2,307 / 2,658');
  // 被拦下、又选了「留下」的跳转不会完成，不等它
  await act(async () => void m.router.navigate({ to: '/audit' } as never));
  await until(() => guardOpen());
  eq('去别的页：弹未保存保护，地址不动', [guardOpen(), m.pathname()], [true, '/sop']);
  const stay = all<HTMLButtonElement>(document.body, '.ant-modal button').find((b) => text(b) === '留下');
  await clickEv(stay);
  await until(() => !guardOpen());
  eq('「留下」：还在话术页，改动还在', [m.pathname(), quotaNum(m)], ['/sop', '2,307 / 2,658']);
  await m.unmount();
}

// 7.4 Enter 进编辑器：当前节、还不是当前节的、只读的固定规则节
{
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP);
  const cm = (): HTMLElement | null => m.box.querySelector<HTMLElement>('.sop-editor .cm-content');
  await act(async () => rowIn(m, 'tone')!.focus());
  await key(rowIn(m, 'tone'), 'Enter');
  await settle();
  check('当前节上按 Enter：焦点在编辑器正文上', document.activeElement === cm() && cm() !== null);
  // 还不是当前节的：先换节，编辑器按新的节重建以后再聚焦
  await key(rowIn(m, 'stages'), 'Enter');
  await until(() => m.section() === 'stages' && document.activeElement === cm());
  eq('别的节上按 Enter：换到那一节', m.section(), 'stages');
  check('别的节（固定规则，只读）：焦点在它的正文上', document.activeElement === cm() && cm()?.getAttribute('contenteditable') === 'false');
  check('只读的正文在 Tab 顺序里', cm()?.tabIndex === 0, String(cm()?.getAttribute('tabindex')));
  // 只读节是当前节时再按 Enter
  // 带锁的行聚焦时出 Tooltip，离开时收起：两段定时器都等完
  await act(async () => rowIn(m, 'stages')!.focus());
  await rest(200);
  await key(rowIn(m, 'stages'), 'Enter');
  await rest(300);
  check('固定规则节是当前节时按 Enter：焦点在正文上', document.activeElement === cm());
  await m.unmount();
}

// 7.5 匿名：锁、标题取行业包（家装整装假包的节表），只读正文照样能 Enter 进去
{
  const renoSecs = sections(RENO, {
    preamble: 120,
    stages: 800,
    tone: 300,
    pricing: 200,
    measure: 150,
    objections: 260,
    capabilities: 400,
    handoff: 180,
    'wechat-style': 210,
  });
  const anonSop: AnonSopOverview = {
    published: { versionNo: 2, publishedAt: '2026-09-25T10:30:00Z', promptHash: 'a'.repeat(12), sections: renoSecs },
  };
  const m = await mountPage('/console/sop', { kind: 'anon', pack: packOf(RENO) }, anonSop);
  eq(
    '匿名：带锁的节取自行业包',
    all<HTMLAnchorElement>(m.box, 'a.sop-toc-row').map((a) => a.querySelector('[aria-label="固定规则节"]') !== null),
    RENO.map((d) => d.locked),
  );
  eq('匿名：节名取自行业包', text(rowIn(m, 'measure')?.querySelector('.sop-toc-name')), '量房预约规则');
  eq('匿名：状态句只有版本与日期', text(m.box.querySelector('.page-status')), '线上v2·9月25日');
  eq('匿名：没有额度条和分段控件', [m.box.querySelector('.sop-quota'), m.box.querySelector('[role="radiogroup"]')], [null, null]);
  await act(async () => rowIn(m, 'preamble')!.focus());
  await key(rowIn(m, 'preamble'), 'Enter');
  await settle();
  const cm = m.box.querySelector<HTMLElement>('.sop-editor .cm-content');
  check('匿名：Enter 以后焦点在只读正文上', cm !== null && document.activeElement === cm);
  await m.unmount();
}

// 7.6 加载骨架：成员画额度条和分段控件，匿名都不画（成品里也没有）
{
  const member = await mount(<SopSkeleton sections={11} quota filter meta />);
  eq(
    '成员的骨架：额度条、分段控件、11 行；中栏有节标题和说明行',
    [
      !!member.box.querySelector('.sop-skel-quota'),
      !!member.box.querySelector('.sop-skel-filter'),
      all(member.box, '.sop-skel-row').length,
      !!member.box.querySelector('.sop-skel-title'),
      !!member.box.querySelector('.sop-skel-meta'),
    ],
    [true, true, 11, true, true],
  );
  await member.unmount();
  const anon = await mount(<SopSkeleton sections={9} quota={false} filter={false} meta={false} />);
  eq(
    '匿名的骨架：没有额度条和分段控件，9 行；中栏有节标题、没有说明行',
    [
      !!anon.box.querySelector('.sop-skel-quota'),
      !!anon.box.querySelector('.sop-skel-filter'),
      all(anon.box, '.sop-skel-row').length,
      !!anon.box.querySelector('.sop-skel-title'),
      !!anon.box.querySelector('.sop-skel-meta'),
    ],
    [false, false, 9, true, false],
  );
  await anon.unmount();
  const anonLocked = await mount(<SopSkeleton sections={9} quota={false} filter={false} meta />);
  eq('匿名打开固定规则节的骨架：节标题下有一行（成品是锁定说明）', !!anonLocked.box.querySelector('.sop-skel-meta'), true);
  await anonLocked.unmount();
  // 整页在 /sop 还没回来时按身份与要打开的节画骨架：匿名打开可编辑节没有那一行，打开固定规则节（地址上的 section，
  // 锁定取行业包）有；地址上的节不认识时退回默认节（第一个可编辑节）
  const skelOf = async (url: string, viewer: Viewer): Promise<[boolean, number, boolean]> => {
    const p = await mountPage(url, viewer, null);
    const out: [boolean, number, boolean] = [
      !!p.box.querySelector('.sop-skel-filter'),
      all(p.box, '.sop-skel-row').length,
      !!p.box.querySelector('.sop-skel-meta'),
    ];
    await p.unmount();
    return out;
  };
  const anonReno: Viewer = { kind: 'anon', pack: packOf(RENO) };
  eq('整页加载中（匿名）：骨架不画分段控件，行数取行业包，默认节没有说明行', await skelOf('/console/sop', anonReno), [false, 9, false]);
  eq('整页加载中（匿名，打开固定规则节）：画锁定说明那一行', await skelOf('/console/sop?section=measure', anonReno), [false, 9, true]);
  eq(
    '整页加载中（匿名，不认识的节、可编辑节）：没有那一行',
    [(await skelOf('/console/sop?section=nope', anonReno))[2], (await skelOf('/console/sop?section=tone', anonReno))[2]],
    [false, false],
  );
  eq('整页加载中（成员，可编辑节）：画说明行', await skelOf('/console/sop?section=tone', OWNER), [true, 11, true]);
}
eq(
  '整页的自测没有发出请求（除了加载中那一次取 /sop，和打开时已有草稿跑的检查）',
  requests.filter((u) => !u.endsWith('/api/console/sop') && !u.endsWith('/api/console/sop/draft/check')),
  [],
);

// ---------------- 8. 编辑器（第 5.2 步） ----------------
// 话术正文的显示：markdown（列表圆点与悬挂缩进、续行的缩进、粗体与藏起来的「**」）、行业包词汇的芯片、✗ ✓ 图标、
// 挤压回退（在看得见的字上算）、相对线上的改动（按字比、只动空白的不算），以及包装组件与中栏的接线。

/** 一个装饰集合里的全部装饰：[起, 止, spec] */
function decoList(set: RangeSet<Decoration>): { from: number; to: number; spec: Record<string, unknown> }[] {
  const out: { from: number; to: number; spec: Record<string, unknown> }[] = [];
  for (const it = set.iter(); it.value; it.next()) out.push({ from: it.from, to: it.to, spec: it.value.spec as Record<string, unknown> });
  return out;
}
const XMARK = String.fromCodePoint(0x2717);
const VMARK = String.fromCodePoint(0x2713);
/** 照旅游包的两张名称表写一小份（自测可以写行业包的词，console 的源码不行） */
const VOCAB: Vocabulary = { tools: { search_routes: '查线路', generate_proposal: '生成方案书' }, sopFields: { payUrl: '付款链接' } };
/** 照家装整装假包写一小份：名字和旅游包的都不同 */
const RENO_VOCAB: Vocabulary = { tools: { search_packages: '查套餐' }, sopFields: { measureSlot: '量房时段' } };
const DOC = [
  '- **先查再聊（要紧）**：先调 search_routes 查线路，结果里带 payUrl 的原样发。',
  '  客户只会答「可以」。',
  `  ${XMARK}「想了解吗？」`,
  `  ${VMARK}「您几号出发？」`,
  '     → search_route 之后紧接着 generate_proposal，constructor 与 xsearch_routes 照原文。',
  '- 第二条也是列表项',
  '',
  '- 空行后的列表项不空开',
  '  - 第二级的列表项',
  '',
].join('\n');
const lineOf = (doc: string, n: number): { from: number; text: string } => {
  const lines = doc.split('\n');
  return { from: lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0), text: lines[n - 1]! };
};

// 8.1 行怎么排、粗体、芯片的名字
{
  eq('列表项：藏「- 」，缩一级，画圆点', lineShape('- 甲'), { hide: 2, indent: 1, bullet: true });
  eq('第二级列表项：连缩进一起藏，缩两级', lineShape('  - 甲'), { hide: 4, indent: 2, bullet: true });
  eq('「* 」也是列表项', lineShape('* 甲'), { hide: 2, indent: 1, bullet: true });
  eq('续行（两个空格）：缩一级', lineShape('  甲'), { hide: 2, indent: 1, bullet: false });
  eq('五个空格：缩两级', lineShape('     → 甲'), { hide: 5, indent: 2, bullet: false });
  eq('制表符算 4 个空格：缩两级', lineShape('\t甲'), { hide: 1, indent: 2, bullet: false });
  eq('缩进最多三级', lineShape(' '.repeat(12) + '甲'), { hide: 12, indent: 3, bullet: false });
  eq('「- 」后面还没有字：照原样', lineShape('- '), { hide: 0, indent: 0, bullet: false });
  eq('只有空白的行：照原样', lineShape('   '), { hide: 0, indent: 0, bullet: false });
  eq(
    '「-甲」「**甲**」不是列表项',
    [lineShape('-甲'), lineShape('**甲** 乙')].map((x) => x.bullet),
    [false, false],
  );
  eq('粗体：两处', strongRanges('**甲**乙**丙丁**'), [
    [0, 5],
    [6, 12],
  ]);
  eq(
    '粗体：里面以空白开头或结尾、含「*」、是空的，都不算',
    ['** 甲**', '**甲 **', '**甲*乙**', '****'].map((t) => strongRanges(t)),
    [[], [], [], []],
  );
  eq('粗体：从列表标记之后开始找', strongRanges('- **甲**', 2), [[2, 7]]);
  const t1 = '调 search_routes(q)、search_route、xsearch_routes、2search_routes、payUrl。constructor toString';
  eq('芯片：包里有的名字，前后不连着字母、数字、下划线；原型上的名字不算', chipRanges(t1, VOCAB), [
    [2, 15, '查线路'],
    [t1.indexOf('payUrl'), t1.indexOf('payUrl') + 6, '付款链接'],
  ]);
  const t2 = 'search_routes 与 search_packages、measureSlot';
  eq('芯片：换一个包，认的名字跟着换', chipRanges(t2, RENO_VOCAB), [
    [t2.indexOf('search_packages'), t2.indexOf('search_packages') + 15, '查套餐'],
    [t2.indexOf('measureSlot'), t2.length, '量房时段'],
  ]);
  eq('芯片的中文名：原型上的名字、另一张表的名字', [chipLabel(VOCAB, 'hasOwnProperty'), chipLabel(VOCAB, 'payUrl')], [null, '付款链接']);
}

// 8.2 相对线上的改动：改了哪几行、新加了哪些字
{
  const base = '第一段。\n第二段，先回应一句，再谈线路。\n第三段。\n\n';
  eq('没改：什么都不标', draftMarks(base, base), { lines: [], inserted: [] });
  const ins = base.replace('先回应一句，', '先回应一句，一句就够，');
  const m1 = draftMarks(base, ins);
  eq('行中插一句：只标这一行', m1.lines, [2]);
  eq(
    '插进来的字：一处，5 个字，不按「词」扩到前后没改的字',
    [m1.inserted.length, m1.inserted[0] && m1.inserted[0][1] - m1.inserted[0][0]],
    [1, 5],
  );
  check(
    '插进来的字：落在「先回应一句，」之后、「再谈线路」之前',
    !!m1.inserted[0] && m1.inserted[0][0] >= base.indexOf('句，') && m1.inserted[0][1] <= ins.indexOf('再谈'),
  );
  // 夹在一串汉字中间插进来的字：按字比只标这几个字；按「词」对齐（presentableDiff）会把前后没改的汉字一起标上
  eq('汉字中间插进来的字：只标新加的', draftMarks('先回应一句再谈线路。\n', '先回应一句一句就够再谈线路。\n').inserted, [[5, 9]]);
  // 插进来的一段以换行开头（在一行末尾另起一行）：原来那一行没动，只标新的一行
  eq('在末尾另起一行：只标新的一行', draftMarks('甲乙', '甲乙\n丙丁'), { lines: [2], inserted: [[2, 5]] });
  eq('只加了行尾空白：不标', draftMarks(base, base.replace('第一段。\n', '第一段。  \n')), { lines: [], inserted: [] });
  eq('末尾多了空行：不标', draftMarks(base, `${base}\n\n`), { lines: [], inserted: [] });
  eq('开头多了空行：不标', draftMarks(base, `\n\n${base}`), { lines: [], inserted: [] });
  const lead = draftMarks(base, `  ${base}`);
  eq('第一行开头打了空格（保存时不去掉）：标', [lead.lines, lead.inserted], [[1], [[0, 2]]]);
  const newLine = base.replace('第一段。\n', '第一段。\n新的一段。\n');
  const m2 = draftMarks(base, newLine);
  eq('新加一行：只标新的那一行，前后两行没动', m2.lines, [2]);
  eq(
    '新加一行：新加的字',
    m2.inserted.map(([a, b]) => newLine.slice(a, b).replaceAll('\n', '⏎')),
    ['新的一段。⏎'],
  );
  const del = base.replace('，再谈线路', '');
  eq('删掉几个字：标这一行，没有新加的字', [draftMarks(base, del).lines, draftMarks(base, del).inserted], [[2], []]);
  eq('删掉整行：标删掉处的那一行', draftMarks(base, base.replace('第二段，先回应一句，再谈线路。\n', '')).lines, [2]);
  // 两处改动之间只隔 2 个没改的字，连成一处；隔 3 个字就分开
  eq('隔 2 个字：连成一处', draftMarks('甲乙丙丁戊\n', '甲X乙丙Y丁戊\n').inserted, [[1, 5]]);
  eq('隔 3 个字：两处', draftMarks('甲乙丙丁戊\n', '甲X乙丙丁Y戊\n').inserted, [
    [1, 2],
    [5, 6],
  ]);
}

// 8.2b 竖条画满改到的段落：空行隔开的一块，块里每个顶格的列表项连同续行各是一段
{
  const doc = [
    '前言第一行，', // 1
    '前言第二行。', // 2
    '', // 3
    '- 第一条', // 4
    '  它的续行', // 5
    '     → 更深的续行', // 6
    '  - 第二级的列表项', // 7
    '没缩进的续行', // 8
    '- 第二条', // 9
    '1. 编号的一条', // 10
    '2. 编号的又一条', // 11
    '', // 12
    '', // 13
    '末段。', // 14
  ].join('\n');
  eq('改到列表项的续行：整个列表项（续行、下一级、没缩进的续行）', paragraphLines(doc, [6]), [4, 5, 6, 7, 8]);
  eq('改到列表项的第一行：一样', paragraphLines(doc, [4]), [4, 5, 6, 7, 8]);
  eq('下一个顶格的列表项（「- 」「1. 」）另起一段', [paragraphLines(doc, [9]), paragraphLines(doc, [11])], [[9], [11]]);
  eq('没有列表的一块：空行之间的几行是一段', paragraphLines(doc, [2]), [1, 2]);
  eq('最后一段、空行自己', [paragraphLines(doc, [14]), paragraphLines(doc, [12])], [[14], [12]]);
  eq('几处改动：各自的段落合起来，升序', paragraphLines(doc, [14, 5, 1]), [1, 2, 4, 5, 6, 7, 8, 14]);
  const base = '- 第一条\n  客户只会答「可以」。\n- 第二条\n';
  eq(
    '改动落在续行上：draftMarks 标这一行，竖条画满这一条',
    [draftMarks(base, base.replace('可以', '好的')).lines, paragraphLines(base.replace('可以', '好的'), [2])],
    [[2], [1, 2]],
  );
}

// 8.3 装饰：直接在 EditorState 上算，不挂 DOM
{
  const state = (halt: boolean, vocab = VOCAB): EditorState =>
    EditorState.create({ doc: DOC, extensions: [sopEditorSetup({ vocabulary: vocab, halt })] });
  const d = buildDecorations(state(false), new Set());
  const all8 = decoList(d.deco);
  const lineClasses = (n: number): string =>
    all8
      .filter(
        (x) =>
          x.from === lineOf(DOC, n).from &&
          x.to === x.from &&
          typeof x.spec.class === 'string' &&
          (x.spec.class as string).startsWith('sop-md'),
      )
      .map((x) => x.spec.class)
      .join(' ');
  eq('行的类：列表项、续行、第二级；空行前的列表项之间空开，空行后的不空', [1, 2, 5, 6, 8, 9].map(lineClasses), [
    'sop-md-in1 sop-md-bullet',
    'sop-md-in1',
    'sop-md-in2',
    'sop-md-in1 sop-md-bullet sop-md-gap',
    'sop-md-in1 sop-md-bullet',
    'sop-md-in2 sop-md-bullet',
  ]);
  const hidden = all8.filter(
    (x) => x.to > x.from && x.spec.widget === undefined && x.spec.class === undefined && x.spec.attributes === undefined,
  );
  const l1 = lineOf(DOC, 1);
  eq(
    '藏起来的：第一行的「- 」和两处「**」，第二行的两个空格……',
    hidden.slice(0, 4).map((x) => DOC.slice(x.from, x.to)),
    ['- ', '**', '**', '  '],
  );
  eq('藏起来的都是光标跳过的整块', decoList(d.atomic).filter((x) => x.spec.widget === undefined).length, hidden.length);
  const strong = all8.find((x) => x.spec.class === 'sop-md-strong');
  eq('粗体：「**」里面的字', strong && DOC.slice(strong.from, strong.to), '先查再聊（要紧）');
  eq(
    '芯片：包里有的三个名字，在不会被拆开的一层，中文名在 data-label',
    decoList(d.outer).map((x) => [DOC.slice(x.from, x.to), (x.spec.attributes as Record<string, string>)['data-label'], x.spec.class]),
    [
      ['search_routes', '查线路', 'sop-chip'],
      ['payUrl', '付款链接', 'sop-chip'],
      ['generate_proposal', '生成方案书', 'sop-chip'],
    ],
  );
  const icons = decoList(d.atomic).filter((x) => x.spec.widget !== undefined);
  eq(
    '✗ ✓：换成图标，光标跳过',
    icons.map((x) => DOC.slice(x.from, x.to)),
    [XMARK, VMARK],
  );
  // 支持 text-spacing-trim（Chromium）：浏览器自己挤，只有「（要紧）**：」里隔着藏掉的「**」的「）：」它不挤，给「）」加 .halt
  eq(
    '支持 text-spacing-trim 时：只给隔着藏掉的「**」的一对加 .halt',
    all8.filter((x) => x.spec.class === 'halt').map((x) => `${DOC.slice(x.from, x.to)}@${DOC.slice(x.to, x.to + 2)}`),
    ['）@**'],
  );
  // 光标在第一行：这一行的「**」显示出来（text-3），别的行照藏
  const r = decoList(buildDecorations(state(false), new Set([1])).deco);
  eq(
    '光标在第一行：「**」显示、不藏',
    [
      r.filter((x) => x.spec.class === 'sop-md-marker').map((x) => DOC.slice(x.from, x.to)),
      r.some((x) => x.from === l1.from + 2 && x.to === l1.from + 4 && x.spec.class === undefined),
    ],
    [['**', '**'], false],
  );
  // 挤压回退：在看得见的字上算。第一行「（要紧）**：」藏了「**」以后是「）：」，挤「）」；第二行「」。」挤「」」
  const halts = (reveal: Set<number>): string[] =>
    decoList(buildDecorations(state(true), reveal).deco)
      .filter((x) => x.spec.class === 'halt')
      .map((x) => `${DOC.slice(x.from, x.to)}@${DOC.slice(x.to, x.to + 2)}`);
  eq('挤压回退：藏掉的「**」不算，隔着它的两个标点也挤', halts(new Set()), ['）@**', '」@。\n']);
  eq('挤压回退：光标所在行显示了「**」，两个标点不再挨着', halts(new Set([1])), ['」@。\n']);
  eq(
    '支持 text-spacing-trim、光标所在行显示了「**」：一个 .halt 都没有',
    decoList(buildDecorations(state(false), new Set([1])).deco).filter((x) => x.spec.class === 'halt').length,
    0,
  );
  // haltChars 单独测：hidden 是行内藏掉的下标
  const t = '甲（乙）**」丙」「丁';
  const hid = new Set([4, 5]);
  eq('haltChars 回退：每一对都挤，按看得见的字算', haltChars(t, hid, true), [3, 8]);
  eq('haltChars 支持时：只挤隔着藏掉的字的一对', haltChars(t, hid, false), [3]);
  eq('haltChars 支持时：没藏字就不用管', haltChars('（乙）」「', new Set(), false), []);
  eq('haltChars 支持时：「开标点 + 开标点」隔着藏掉的字，挤后一个', haltChars('「**「甲', new Set([1, 2]), false), [3]);
  eq('没有行业包的词汇：一个芯片都没有', decoList(buildDecorations(state(false, { tools: {}, sopFields: {} }), new Set()).outer).length, 0);
}

// 8.4 内置文案：CodeMirror 用到的每一句都有中文
{
  const require = createRequire(import.meta.url);
  const used = new Set<string>();
  for (const pkg of ['@codemirror/view', '@codemirror/state', '@codemirror/commands', '@codemirror/merge']) {
    const src = readFileSync(require.resolve(pkg), 'utf8');
    for (const m of src.matchAll(/\.phrase\("([^"]+)"/g)) used.add(m[1]!);
  }
  check('在 CodeMirror 的源码里找到了内置文案', used.size >= 7, [...used].join(' | '));
  eq(
    '每一句内置文案都有中文',
    [...used].filter((k) => !Object.hasOwn(CM_PHRASES, k)),
    [],
  );
  // 差异视图（01 的逐节对比，第 6.3 步换掉以前）也带着这份文案：没改的长段落折叠成「N行没有改动」
  const same = Array.from({ length: 20 }, (_, i) => `第${i + 1}行`).join('\n');
  const d = await mount(<SectionDiff before={`${same}\n旧的一行\n`} after={`${same}\n新的一行\n`} beforeLabel="线上" afterLabel="草稿" />);
  eq(
    '差异视图：折叠起来的行写中文',
    all(d.box, '.cm-collapsedLines').map((e) => text(e)),
    ['18行没有改动', '18行没有改动'],
  );
  await d.unmount();
  const st = EditorState.create({ extensions: [cmPhrases] });
  eq('折叠起来的行数：「3行没有改动」', st.phrase('$ unchanged lines', 3), '3行没有改动');
  eq('逐块合并的按钮', st.phrase('Revert this chunk'), '采用线上的写法');
}

// 8.5 挂在 DOM 里：芯片、图标、改动标记、aria-label；换属性不重建编辑器
{
  const edits: string[] = [];
  const base = DOC.replace('，结果里带 payUrl 的原样发', '');
  const el = (p: Partial<Parameters<typeof SopEditor>[0]> = {}) => (
    <SopEditor name="话术原则" value={DOC} baseline={base} onChange={(v) => edits.push(v)} {...p} />
  );
  const m = await rootFor(el());
  const cm = (): HTMLElement => m.box.querySelector<HTMLElement>('.cm-content')!;
  const view = EditorView.findFromDOM(cm())!;
  eq('正文的 aria-label', cm().getAttribute('aria-label'), '「话术原则」正文');
  eq('能改：contenteditable，不另加 tabindex', [cm().getAttribute('contenteditable'), cm().getAttribute('tabindex')], ['true', null]);
  eq('行业包还没到：一个芯片都没有', all(m.box, '.sop-chip').length, 0);
  await m.render(el({ vocabulary: VOCAB }));
  eq(
    '包到了：芯片出现，中文名在 data-label，原名照旧是正文',
    all<HTMLElement>(m.box, '.sop-chip').map((c) => [c.dataset.label, c.textContent]),
    [
      ['查线路', 'search_routes'],
      ['付款链接', 'payUrl'],
      ['生成方案书', 'generate_proposal'],
    ],
  );
  check('换词汇不重建编辑器', EditorView.findFromDOM(cm()) === view);
  eq(
    '图标：role=img，aria-label 是原字符，16 的 SVG，线宽 2.25',
    all(m.box, '.sop-icon').map((i) => [
      i.getAttribute('role'),
      i.getAttribute('aria-label'),
      i.querySelector('svg')?.getAttribute('width'),
      i.querySelector('svg')?.getAttribute('stroke-width'),
      i.querySelectorAll('path').length,
    ]),
    [
      ['img', XMARK, '16', '2.25', 2],
      ['img', VMARK, '16', '2.25', 1],
    ],
  );
  const lines = all<HTMLElement>(m.box, '.cm-line');
  check(
    '正文里看不到「- 」和「**」',
    lines.every((l) => !l.textContent!.startsWith('- ') && !l.textContent!.includes('**')),
    lines.map((l) => l.textContent).join(' / '),
  );
  eq(
    '改过的段落：改在第一行，整个列表项（第一行到第 5 行的续行）都画竖条',
    all(m.box, '.cm-line.sop-changed').map((l) => lines.indexOf(l as HTMLElement) + 1),
    [1, 2, 3, 4, 5],
  );
  // 启动时检测到不支持 text-spacing-trim（selftest-env.ts）：没传 halt 的编辑器照检测结果走回退，每一对都挤
  check('自测按不支持 text-spacing-trim 的浏览器跑', needsTrimFallback);
  eq(
    '挤压回退：编辑器不传 halt 就取启动时的检测，「）**：」与「」。」都挤',
    all(m.box, '.halt').map((e) => e.textContent),
    ['）', '」'],
  );
  eq(
    '新加的文字：整句都标出来',
    all(m.box, '.sop-ins')
      .map((e) => e.textContent)
      .join(''),
    '，结果里带 payUrl 的原样发',
  );
  eq('新加的字里的芯片不被拆开', all(m.box, '.sop-chip[data-label="付款链接"]').length, 1);
  // 用户输入回调 onChange；外面换正文不回调
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '补一句' }, userEvent: 'input.type' }));
  eq('用户输入：回调一次，是新的正文', edits, [`${DOC}补一句`]);
  eq(
    '打字以后：改动标记跟着重算',
    all(m.box, '.sop-ins').map((e) => e.textContent),
    ['，结果里带 ', 'payUrl', ' 的原样发', '补一句'],
  );
  eq('编辑器带着中文的内置文案', view.state.phrase('$ unchanged lines', 2), '2行没有改动');
  await m.render(el({ vocabulary: VOCAB, value: `${DOC}补一句` }));
  await m.render(el({ vocabulary: VOCAB, value: '换了一节的正文\n' }));
  eq('外面换正文：编辑器跟着换，不回调', [view.state.doc.toString(), edits.length], ['换了一节的正文\n', 1]);
  // 线上的正文换了（发布以后）：标记跟着换，编辑器不重建
  await m.render(el({ vocabulary: VOCAB, value: DOC, baseline: DOC }));
  eq('线上和正文一样：没有改动标记', [all(m.box, '.sop-changed').length, all(m.box, '.sop-ins').length], [0, 0]);
  check('换线上的正文不重建编辑器', EditorView.findFromDOM(cm()) === view);
  await m.render(el({ vocabulary: VOCAB, value: DOC, baseline: undefined }));
  eq('不给线上的正文：不标', all(m.box, '.sop-changed').length, 0);
  // 聚焦并把光标放到第一行：这一行的「**」显示出来
  await act(async () => {
    view.focus();
    view.dispatch({ selection: { anchor: 5 } });
  });
  await settle();
  eq(
    '有焦点、光标在第一行：显示这一行的「**」',
    view.hasFocus ? all(m.box, '.cm-line')[0]?.querySelectorAll('.sop-md-marker').length : 'no-focus',
    2,
  );
  // 失焦（选区没动）：「**」藏回去；再用 Tab 之类进来（也不动选区）：光标那一行又露出来。
  // CodeMirror 在焦点事件之后隔 10 ms 才通知焦点变了，这里等 30 ms
  const afterFocusChange = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 30)));
  await act(async () => cm().blur());
  await afterFocusChange();
  eq('失焦以后：「**」藏回去', [view.hasFocus, all(m.box, '.sop-md-marker').length], [false, 0]);
  await act(async () => cm().focus());
  await afterFocusChange();
  eq('再获得焦点、选区没动：光标那一行的「**」又露出来', [view.hasFocus, all(m.box, '.sop-md-marker').length], [true, 2]);
  await m.render(el({ vocabulary: VOCAB, readOnly: true }));
  const ro = cm();
  eq('只读：不可编辑，在 Tab 顺序里', [ro.getAttribute('contenteditable'), ro.getAttribute('tabindex')], ['false', '0']);
  await act(async () => {
    ro.focus();
    EditorView.findFromDOM(ro)!.dispatch({ selection: { anchor: 5 } });
  });
  await settle();
  eq('只读时光标在第一行也不显示「**」', all(m.box, '.sop-md-marker').length, 0);
  await m.unmount();
}

// 8.6 中栏：节标题、说明行、固定规则说明
{
  const row = (x: Partial<OutlineRow>): OutlineRow => ({
    key: 'tone',
    name: '话术原则',
    locked: false,
    lockReason: null,
    chars: 954,
    delta: 44,
    changed: true,
    issues: 0,
    ...x,
  });
  eq('说明行：能改的成员', sectionMeta(row({}), 'editor'), ['可编辑', '910 → 954字（+44）']);
  eq('说明行：只读的成员只写字数', sectionMeta(row({}), 'reader'), ['910 → 954字（+44）']);
  eq('说明行：匿名不写', sectionMeta(row({}), 'anon'), null);
  eq('说明行：没改过', sectionMeta(row({ changed: false, delta: 0 }), 'editor'), ['可编辑', '954字']);
  eq('说明行：改过但字数没变', sectionMeta(row({ delta: 0 }), 'editor'), ['可编辑', '954字']);
  eq('说明行：删了字，千位分隔', sectionMeta(row({ chars: 954, delta: -1046 }), 'editor'), ['可编辑', '2,000 → 954字（-1,046）']);
  eq('固定规则：带原因', lockLine({ lockReason: '和算报价工具绑在一起' }), [
    '固定规则',
    '和算报价工具绑在一起。这里改不了，要改请联系技术。',
  ]);
  eq('固定规则：原因自带句号不重复', lockLine({ lockReason: '和算报价工具绑在一起。' }), [
    '固定规则',
    '和算报价工具绑在一起。这里改不了，要改请联系技术。',
  ]);
  eq('固定规则：包里没写原因', lockLine({ lockReason: null }), ['固定规则', '这里改不了，要改请联系技术。']);
  eq(
    '去掉标题行：有标题、前言、只有标题、标题后没有空行',
    ['## 甲\n\n正文\n\n', '前言的正文\n', '## 甲', '## 甲\n正文\n'].map(bodyWithoutHeading),
    ['正文\n\n', '前言的正文\n', '', '正文\n'],
  );
  const e = await mount(<SectionPane row={row({})} who="editor" value={'正文\n'} vocabulary={VOCAB} />);
  const sec = e.box.querySelector('section.sop-pane');
  eq(
    '中栏（能改）：标题、说明行、可编辑的正文，区块以标题命名',
    [
      text(e.box.querySelector('h2.sop-pane-title')),
      text(e.box.querySelector('.sop-pane-meta')),
      e.box.querySelector('.sop-pane-lock'),
      e.box.querySelector('.sop-editor-card .cm-content')?.getAttribute('contenteditable'),
      sec?.getAttribute('aria-labelledby') === e.box.querySelector('h2')?.id,
    ],
    ['话术原则', '可编辑·910 → 954字（+44）', null, 'true', true],
  );
  await e.unmount();
  const r = await mount(<SectionPane row={row({})} who="reader" value={'正文\n'} />);
  eq(
    '中栏（只读成员）：只写字数，正文只读',
    [text(r.box.querySelector('.sop-pane-meta')), r.box.querySelector('.cm-content')?.getAttribute('contenteditable')],
    ['910 → 954字（+44）', 'false'],
  );
  await r.unmount();
  const a = await mount(<SectionPane row={row({ changed: false, delta: 0 })} who="anon" value={'正文\n'} />);
  eq('中栏（匿名）：没有说明行', [text(a.box.querySelector('h2')), a.box.querySelector('.sop-pane-meta')], ['话术原则', null]);
  await a.unmount();
  const l = await mount(
    <SectionPane
      row={row({ key: 'stages', name: '各阶段目标', locked: true, lockReason: '阶段目标由代码核对', changed: false, delta: 0 })}
      who="editor"
      value={'正文\n'}
    />,
  );
  eq(
    '中栏（固定规则节）：锁与原因，没有说明行，正文只读',
    [
      text(l.box.querySelector('.sop-pane-lock')),
      !!l.box.querySelector('.sop-pane-lock svg'),
      l.box.querySelector('.sop-pane-meta'),
      l.box.querySelector('.cm-content')?.getAttribute('contenteditable'),
    ],
    ['固定规则·阶段目标由代码核对。这里改不了，要改请联系技术。', true, null, 'false'],
  );
  await l.unmount();
}

// 8.7 整页：中栏取 /sop 与行业包；词汇取行业包；匿名的正文去掉标题行
{
  const travelPack = { ...packOf(TRAVEL), vocabulary: { ...packOf(TRAVEL).vocabulary, ...VOCAB } };
  const owner: Viewer = { ...OWNER, pack: travelPack };
  const draftTone = DRAFT.find((x) => x.key === 'tone')!;
  const withNames: SopOverview = {
    ...MEMBER_SOP,
    draft: {
      ...MEMBER_SOP.draft!,
      sections: MEMBER_SOP.draft!.sections.map((x) =>
        x.key === 'tone' ? { ...x, text: draftTone.text.replace(/改(\n+)$/, '改search_routes$1') } : x,
      ),
    },
  };
  const m = await mountPage('/console/sop?section=tone', owner, withNames);
  eq(
    '成员：节标题、说明行（改过的节末尾是「查看本节改动」，第 6.3 步）、正文的 aria-label',
    [
      text(m.box.querySelector('.sop-pane-title')),
      text(m.box.querySelector('.sop-pane-meta')),
      m.box.querySelector('.sop-editor .cm-content')?.getAttribute('aria-label'),
    ],
    ['话术原则', '可编辑·910 → 967字（+57）·查看本节改动', '「话术原则」正文'],
  );
  eq(
    '成员：芯片的中文名取行业包',
    all<HTMLElement>(m.box, '.sop-editor .sop-chip').map((c) => c.dataset.label),
    ['查线路'],
  );
  check('成员：草稿相对线上改过的段落有竖条', all(m.box, '.sop-editor .sop-changed').length === 1);
  await clickEv(rowIn(m, 'stages'));
  await until(() => m.section() === 'stages');
  eq(
    '固定规则节：锁定原因取行业包',
    text(m.box.querySelector('.sop-pane-lock')),
    '固定规则·阶段目标由代码核对。这里改不了，要改请联系技术。',
  );
  await m.unmount();
  const renoSecs = sections(RENO, {
    preamble: 120,
    stages: 800,
    tone: 300,
    pricing: 200,
    measure: 150,
    objections: 260,
    capabilities: 400,
    handoff: 180,
    'wechat-style': 210,
  });
  const renoPack = { ...packOf(RENO), vocabulary: { ...packOf(RENO).vocabulary, ...RENO_VOCAB } };
  const anonSop: AnonSopOverview = {
    published: {
      versionNo: 2,
      publishedAt: '2026-09-25T10:30:00Z',
      promptHash: 'a'.repeat(12),
      sections: renoSecs.map((x) => (x.key === 'tone' ? { ...x, text: x.text.replace('话话', '话 measureSlot 话') } : x)),
    },
  };
  const a = await mountPage('/console/sop?section=tone', { kind: 'anon', pack: renoPack }, anonSop);
  const doc = editorText(a) ?? '';
  eq(
    '匿名：正文去掉了标题行，只读',
    [doc.startsWith('## '), doc.length, a.box.querySelector('.sop-editor .cm-content')?.getAttribute('contenteditable')],
    [false, 300 + ' measureSlot '.length, 'false'],
  );
  eq(
    '匿名：没有说明行；芯片取假包的词汇；没有改动标记',
    [
      a.box.querySelector('.sop-pane-meta'),
      all<HTMLElement>(a.box, '.sop-chip').map((c) => c.dataset.label),
      all(a.box, '.sop-changed').length,
    ],
    [null, ['量房时段'], 0],
  );
  await a.unmount();
}
eq(
  '编辑器的自测没有发出请求（除了加载中那一次取 /sop，和打开时已有草稿跑的检查）',
  requests.filter((u) => !u.endsWith('/api/console/sop') && !u.endsWith('/api/console/sop/draft/check')),
  [],
);

// ---------------- 9. 自动保存与三栏（第 5.3 步） ----------------
// spec「销售话术 · 自动保存」「状态句」「右栏」，不变量 20、21，验收 11 的前三条：
// 9.1 纯函数：失败怎么分、退避的间隔、⌘S 的认法、哪些节算没存上、存上以后的缓存；
// 9.2 状态机：假的计时器驱动（防抖、同一时刻只有一个请求、退避、409 停住、不自动试的失败、恢复联网、卸下、改回原样）；
// 9.3 整页：假服务端回 PUT /sop/draft。请求体里的 rev（有草稿、没草稿、接着存）、状态句最后一段、⌘S、断网与离开保护、
//     409 冻结与载入最新草稿、格式不对、页头按钮、编辑中降成只读；接连几次 409 时对比不丢、横幅滚进视口与焦点；
//     放弃改动并离开以后不再发；422 回来时防抖还在数不马上再发；输入法组字；丢弃、发布以后的状态句；载入、关掉对比以后的焦点；
//     匿名重取失败；
// 9.4 三栏的格子：成员、只读成员、匿名、骨架、窄屏各有哪几格，检查清单挪进来了，工具卡片取行业包。

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

// 9.1 纯函数
{
  const http = (status: number, error: string): HttpError => new HttpError(status, { error });
  eq(
    '失败怎么办：连不上、5xx、429 自动重试；409 停住；别的 4xx 不自动试',
    [
      new TypeError('Failed to fetch'),
      http(500, 'internal'),
      http(503, 'lock_lost'),
      http(429, 'rate_limited'),
      http(409, 'rev_conflict'),
      http(409, 'conflict'),
      http(422, 'invalid_sop'),
      http(422, 'locked_section'),
      http(403, 'forbidden'),
      http(401, 'unauthorized'),
      http(400, 'bad_request'),
    ].map(saveFailure),
    ['retry', 'retry', 'retry', 'retry', 'conflict', 'conflict', 'stop', 'stop', 'stop', 'stop', 'stop'],
  );
  eq('停止输入 1.5 秒后保存', AUTOSAVE_TIMING.debounce, 1500);
  eq(
    '退避：2、5、15 秒，之后一直是 15 秒',
    [0, 1, 2, 3, 7].map((n) => retryDelay(AUTOSAVE_TIMING, n)),
    [2000, 5000, 15000, 15000, 15000],
  );
  const k = (key: string, m: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}): boolean =>
    isSaveShortcut({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  eq(
    '⌘S 与 Ctrl+S 都认（大写 S 也认）；不带修饰键、带 Alt 或 Shift、别的键不认',
    [
      k('s', { metaKey: true }),
      k('s', { ctrlKey: true }),
      k('S', { metaKey: true }),
      k('s'),
      k('s', { metaKey: true, altKey: true }),
      k('s', { ctrlKey: true, shiftKey: true }),
      k('d', { metaKey: true }),
    ],
    [true, true, true, false, false, false, false],
  );

  const tone = bodyIn(DRAFT, 'tone');
  eq('没改过：没有要存的', unsavedEdits(SPEC, DRAFT, {}), []);
  eq('改回草稿里的样子（行尾多了空格、节末少了空行）：不算没存上', unsavedEdits(SPEC, DRAFT, { tone: tone.replace(/\n\n$/, '  \n') }), []);
  eq(
    '改过的节照原文发（服务端自己规范化），没改的不发',
    unsavedEdits(SPEC, DRAFT, { tone: `${tone}新  `, objections: bodyIn(DRAFT, 'objections') }),
    [{ key: 'tone', body: `${tone}新  ` }],
  );
  eq('固定规则节不发', unsavedEdits(SPEC, DRAFT, { stages: '随便写' }), []);
  eq(
    '和草稿比，不是和线上比：改回线上的样子也要存（草稿里还是改过的）',
    unsavedEdits(SPEC, DRAFT, { tone: bodyIn(PUBLISHED, 'tone') }).map((e) => e.key),
    ['tone'],
  );
  eq('没有草稿时和线上比', unsavedEdits(SPEC, PUBLISHED, { tone: bodyIn(PUBLISHED, 'tone') }), []);

  // 存上的草稿比缓存里的多 5 个字：字数要按返回的那份重算，不能沿用旧的
  const grown = DRAFT.map((s) => (s.key === 'tone' ? { ...s, text: s.text.replace(/\n\n$/, '新新新新新\n\n') } : s));
  const saved = version(null, grown, { basedOn: 'v1', rev: 7, publishedAt: null, publishedByName: null });
  const next = withSavedDraft(MEMBER_SOP, saved);
  eq(
    '存上以后的 /sop：草稿换成返回的那份，基于旧版本时是 stale，字数重算，线上与上限不变',
    [next.draft?.rev, next.draft?.stale, next.budget, next.published === MEMBER_SOP.published, next.spec === MEMBER_SOP.spec],
    [7, true, { chars: MEMBER_SOP.budget.chars + 5, limit: LIMIT }, true, true],
  );
  eq('基于当前线上时不是 stale', withSavedDraft(MEMBER_SOP, { ...saved, basedOn: 'v2' }).draft?.stale, false);
}

// 9.2 状态机：假的计时器，时间只在 advance 里走；send 的结果由 outcome 定
function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  type T = ReturnType<typeof setTimeout>;
  return {
    now: (): number => now,
    set: (fn: () => void, ms: number): T => {
      seq += 1;
      due.set(seq, { at: now + ms, fn });
      return seq as unknown as T;
    },
    clear: (t: T): void => void due.delete(t as unknown as number),
    timers: (): number => due.size,
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const e of due) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flushMicro();
      }
      now = end;
      await flushMicro();
    },
  };
}
function machine() {
  const clock = fakeClock();
  const h = {
    clock,
    sends: [] as number[],
    statuses: [] as SaveStatus[],
    conflicts: 0,
    pending: true,
    composing: false,
    outcome: (): Promise<void> => Promise.resolve(),
    last: (): string => {
      const s = h.statuses.at(-1);
      return !s ? 'none' : s.kind === 'saved' ? `saved@${s.at}` : s.kind === 'failed' ? `failed:${s.retrying ? 'retry' : 'stop'}` : s.kind;
    },
  };
  const m = createAutosaver({
    timing: () => ({ ...AUTOSAVE_TIMING, now: clock.now }),
    hasPending: () => h.pending,
    composing: () => h.composing,
    send: () => {
      h.sends.push(clock.now());
      return h.outcome();
    },
    onStatus: (s) => h.statuses.push(s),
    onConflict: () => {
      h.conflicts += 1;
    },
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  return { m, h };
}
const fail = (e: unknown) => (): Promise<void> => Promise.reject(e);
{
  // 防抖：停止输入 1.5 秒才存；接着打字从头数
  const { m, h } = machine();
  m.edited();
  await h.clock.advance(1499);
  eq('防抖：1,499 毫秒时还没存', h.sends, []);
  await h.clock.advance(1);
  eq(
    '防抖：1,500 毫秒时存一次，状态「保存中」→「已自动保存」',
    [h.sends, h.statuses.map((s) => s.kind), h.last()],
    [[1500], ['saving', 'saved'], 'saved@1500'],
  );
  m.edited();
  await h.clock.advance(1000);
  m.edited();
  await h.clock.advance(1499);
  eq('接着打字：从最后一下重新数', h.sends, [1500]);
  await h.clock.advance(1);
  eq('接着打字：最后一下以后 1.5 秒存', h.sends, [1500, 4000]);
}
{
  // 同一时刻只有一个请求：路上又要存（计时到了、⌘S），等它回来马上接着存
  const { m, h } = machine();
  const first = deferred<void>();
  h.outcome = () => first.promise;
  m.edited();
  await h.clock.advance(1500);
  m.edited();
  await h.clock.advance(1500);
  m.flush();
  await flushMicro();
  eq('请求在路上：计时到了、⌘S 都不另发', h.sends, [1500]);
  h.outcome = () => Promise.resolve();
  first.resolve();
  await flushMicro();
  eq('回来以后马上接着存（不再等 1.5 秒）', [h.sends, h.last()], [[1500, 3000], 'saved@3000']);
  const second = deferred<void>();
  h.outcome = () => second.promise;
  m.flush();
  m.flush();
  h.pending = false;
  second.resolve();
  await flushMicro();
  eq('路上又要求存过，回来时已经没有要存的：不再发', h.sends, [1500, 3000, 3000]);
}
{
  // 连不上：按 2、5、15 秒重试，之后每 15 秒；存上以后退避从头算
  const { m, h } = machine();
  h.outcome = fail(new TypeError('Failed to fetch'));
  m.edited();
  await h.clock.advance(1500);
  eq('连不上：状态是会自动重试的失败', h.last(), 'failed:retry');
  await h.clock.advance(40_000);
  eq('重试的时刻：+2、+5、+15、+15 秒', h.sends, [1500, 3500, 8500, 23500, 38500]);
  h.outcome = () => Promise.resolve();
  await h.clock.advance(15_000);
  eq('恢复以后存上', [h.sends.at(-1), h.last()], [53500, 'saved@53500']);
  h.outcome = fail(new HttpError(503, { error: 'lock_lost' }));
  m.flush();
  await flushMicro();
  await h.clock.advance(2000);
  eq('存上过一次，再失败时又从 2 秒开始', h.sends.slice(-2), [56500, 58500]);
  await h.clock.advance(1000);
  m.online();
  await flushMicro();
  eq('恢复联网：在等自动重试的马上试（不等 5 秒）', h.sends.slice(-2), [58500, 59500]);
  m.stop();
  eq('卸下：等着的重试马上清掉', h.clock.timers(), 0);
  await h.clock.advance(60_000);
  eq('卸下以后：不再重试', h.sends.length, 9);
}
{
  // 恢复联网在等的重试：马上试，不等退避
  const { m, h } = machine();
  h.outcome = fail(new TypeError('Failed to fetch'));
  m.edited();
  await h.clock.advance(1500);
  h.outcome = () => Promise.resolve();
  m.online();
  await flushMicro();
  eq('online 事件：马上重试，不等 2 秒', [h.sends, h.last()], [[1500, 1500], 'saved@1500']);
  m.online();
  await flushMicro();
  eq('存上以后 online 不再发', h.sends.length, 2);
}
{
  // 409：停住，不再重试；打字、⌘S、等多久都不发；载入最新草稿以后（resume）接着存
  const { m, h } = machine();
  const inFlight = deferred<void>();
  h.outcome = () => inFlight.promise;
  m.edited();
  await h.clock.advance(1500);
  // 路上又打了字：防抖在数，409 回来时一并清掉
  m.edited();
  inFlight.reject(new HttpError(409, { error: 'rev_conflict' }));
  await flushMicro();
  eq('409：停住、通知页面一次、没有计时器', [h.last(), h.conflicts, h.clock.timers()], ['conflict', 1, 0]);
  m.edited();
  eq('409 以后打字：不计时', h.clock.timers(), 0);
  m.flush();
  m.online();
  await h.clock.advance(120_000);
  eq('409 以后打字、⌘S、恢复联网都不发', h.sends, [1500]);
  h.outcome = () => Promise.resolve();
  m.resume();
  eq('载入最新草稿以后：回到还没保存过', h.last(), 'idle');
  m.edited();
  await h.clock.advance(1500);
  eq('接着自动保存', [h.sends, h.last()], [[1500, 123000], 'saved@123000']);
}
{
  // 格式不对（422）这类：不自动重试；下一次改动、「重试」照发
  const { m, h } = machine();
  h.outcome = fail(new HttpError(422, { error: 'invalid_sop' }));
  m.edited();
  await h.clock.advance(1500);
  await h.clock.advance(60_000);
  m.online();
  await flushMicro();
  eq('422：不自动重试，恢复联网也不试', [h.sends, h.last(), h.clock.timers()], [[1500], 'failed:stop', 0]);
  m.edited();
  await h.clock.advance(1500);
  eq('422 以后再改：照常 1.5 秒后存', h.sends, [1500, 63000]);
  m.flush();
  await flushMicro();
  eq('「重试」：马上发', h.sends, [1500, 63000, 63000]);
  h.pending = false;
  h.outcome = () => Promise.resolve();
  m.flush();
  await flushMicro();
  eq('没存上的改动改回了原样：不发，状态回到还没保存过', [h.sends.length, h.last()], [3, 'idle']);
}
{
  // 422 这类回来时，路上又要求存过（计时到了或 ⌘S）：新打的字可能就改好了，不等下一次改动，马上拿新的内容再试
  const { m, h } = machine();
  const first = deferred<void>();
  h.outcome = () => first.promise;
  m.edited();
  await h.clock.advance(1500);
  m.edited();
  await h.clock.advance(1500);
  h.outcome = () => Promise.resolve();
  first.reject(new HttpError(422, { error: 'invalid_sop' }));
  await flushMicro();
  eq('422 回来时路上又改过：马上再试，存上了', [h.sends, h.last()], [[1500, 3000], 'saved@3000']);
}
{
  // 改回原样时回到上一次存上的时刻；没有要存的时计时到了也不发
  const { m, h } = machine();
  m.edited();
  await h.clock.advance(1500);
  h.outcome = fail(new TypeError('Failed to fetch'));
  m.flush();
  await flushMicro();
  h.pending = false;
  await h.clock.advance(2000);
  eq(
    '失败以后改回了存上的样子：重试时不发，状态回到「已自动保存」上一次的时刻',
    [h.sends, h.last(), h.clock.timers()],
    [[1500, 1500], 'saved@1500', 0],
  );
  m.edited();
  await h.clock.advance(1500);
  eq('没有要存的：计时到了也不发', h.sends.length, 2);
  h.pending = true;
  m.edited();
  m.stop();
  eq('卸下：还在数的防抖马上清掉', h.clock.timers(), 0);
  m.edited();
  eq('卸下以后：打字不再计时', h.clock.timers(), 0);
  await h.clock.advance(5000);
  eq('卸下以后：不再发', h.sends.length, 2);
}
{
  // 卸下时请求在路上、又要求存过：它照常回来，但不再接着存
  const { m, h } = machine();
  const first = deferred<void>();
  h.outcome = () => first.promise;
  m.edited();
  await h.clock.advance(1500);
  m.flush();
  m.stop();
  h.outcome = () => Promise.resolve();
  first.resolve();
  await flushMicro();
  eq('卸下时路上的请求回来以后：不再接着存', h.sends, [1500]);
}

{
  // 输入法组字（编辑器里是还没上屏的拼音）：计时到了、⌘S 都不存，每 1.5 秒再看一次；字上屏以后，下一次看的时候存
  const { m, h } = machine();
  h.composing = true;
  m.edited();
  await h.clock.advance(1500);
  m.flush();
  await flushMicro();
  eq('组字时计时到了、按了 ⌘S：不存', h.sends, []);
  await h.clock.advance(6000);
  eq('一直在组字：一直不存，还在等', [h.sends, h.last(), h.clock.timers()], [[], 'none', 1]);
  h.composing = false;
  await h.clock.advance(1500);
  eq('字上屏了（这之后没再打字）：下一次看的时候存', [h.sends, h.last()], [[9000], 'saved@9000']);
}
{
  // 组字时到了自动重试、路上的请求回来要接着存：同样等字上屏
  const { m, h } = machine();
  h.outcome = fail(new TypeError('Failed to fetch'));
  m.edited();
  await h.clock.advance(1500);
  h.composing = true;
  await h.clock.advance(2000);
  eq('组字时到了自动重试：不发', h.sends, [1500]);
  h.composing = false;
  h.outcome = () => Promise.resolve();
  await h.clock.advance(1500);
  eq('字上屏以后：重试照常发出去', [h.sends, h.last()], [[1500, 5000], 'saved@5000']);
  const held = deferred<void>();
  h.outcome = () => held.promise;
  m.edited();
  await h.clock.advance(1500);
  m.flush();
  h.composing = true;
  h.outcome = () => Promise.resolve();
  held.resolve();
  await flushMicro();
  eq('路上的请求回来时在组字：不接着存', h.sends, [1500, 5000, 6500]);
  h.composing = false;
  await h.clock.advance(1500);
  eq('字上屏以后：接着存', h.sends, [1500, 5000, 6500, 8000]);
}
{
  // 409 在组字时回来：先不停住（停住时编辑器整个重建，组到一半的字被打断），字上屏以后马上停住；这期间不存
  const { m, h } = machine();
  const inFlight = deferred<void>();
  h.outcome = () => inFlight.promise;
  m.edited();
  await h.clock.advance(1500);
  h.composing = true;
  inFlight.reject(new HttpError(409, { error: 'rev_conflict' }));
  await flushMicro();
  eq('组字时回来 409：还不通知页面，状态还是「保存中」', [h.last(), h.conflicts], ['saving', 0]);
  await h.clock.advance(150);
  m.edited();
  m.flush();
  m.online();
  // 打字的防抖（如果计了）在 3,150 毫秒时到，字在 3,120 上屏：抢在下一次看（3,200）之前也不能发
  await h.clock.advance(1470);
  h.composing = false;
  await h.clock.advance(COMPOSE_POLL - 20);
  eq('等字上屏时：打字、⌘S、恢复联网都不发；上屏以后下一次看的时候停住', [h.sends, h.last(), h.conflicts], [[1500], 'conflict', 1]);
  eq('停住以后没有计时器', h.clock.timers(), 0);
}
{
  // 等字上屏时页面卸下：不再通知
  const { m, h } = machine();
  const inFlight = deferred<void>();
  h.outcome = () => inFlight.promise;
  m.edited();
  await h.clock.advance(1500);
  h.composing = true;
  inFlight.reject(new HttpError(409, { error: 'rev_conflict' }));
  await flushMicro();
  m.stop();
  eq('等字上屏时卸下：计时器清掉', h.clock.timers(), 0);
  h.composing = false;
  await h.clock.advance(1000);
  eq('卸下以后字上屏：不再通知页面', [h.conflicts, h.last()], [0, 'saving']);
}
{
  // 连不上重试了几次（退避到了 15 秒那一档）以后 409，载入最新草稿（resume）以后再连不上：退避从 2 秒重新算
  const { m, h } = machine();
  h.outcome = fail(new TypeError('Failed to fetch'));
  m.edited();
  await h.clock.advance(1500 + 2000 + 5000);
  h.outcome = fail(new HttpError(409, { error: 'rev_conflict' }));
  await h.clock.advance(15_000);
  eq('重试到第四次答 409：停住', [h.sends, h.last()], [[1500, 3500, 8500, 23500], 'conflict']);
  m.resume();
  h.outcome = fail(new TypeError('Failed to fetch'));
  m.edited();
  await h.clock.advance(1500 + 2000);
  eq('载入以后再连不上：2 秒以后重试（不接着 15 秒）', h.sends.slice(-2), [25000, 27000]);
}

// 9.3 整页：假服务端
const FAST: AutosaveTiming = { debounce: 30, backoff: [80, 10_000], now: () => NOW };
const json = (status: number, b: unknown): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
/** 服务端存正文的做法：按节表重建，规范化（与 src/sop/sections.ts 的 rebuildSection 同一个 canonicalBody） */
function applyEdits(secs: readonly SopSectionText[], edits: readonly { key: string; body: string }[]): SopSectionText[] {
  return secs.map((s) => {
    const e = edits.find((x) => x.key === s.key);
    if (!e) return s;
    const i = TRAVEL.findIndex((d) => d.key === s.key);
    return { key: s.key, text: textFor(TRAVEL[i]!, canonicalBody(e.body, i === TRAVEL.length - 1)) };
  });
}
type PutMode = 'ok' | 'network' | 'conflict' | 'invalid' | 'hold';
/** 第 9 节的检查结果：话术原则里一个工具名不对（01 的形状，不带 match） */
const FIXED_CHECK = (): DraftCheck => ({
  promptHash: 'b'.repeat(64),
  prefixHash: 'c'.repeat(64),
  chars: 2303,
  limit: LIMIT,
  violations: [{ code: 'unknown_tool', sectionKey: 'tone', detail: 'x' }],
  rebase: { needed: false, conflicts: [] },
});
function fakeServer(start: SopOverview) {
  const srv = {
    state: start,
    mode: 'ok' as PutMode,
    /** POST /sop/draft/check 按那时的草稿答什么（第 10 节换成按正文算的） */
    check: (_s: SopOverview): DraftCheck => FIXED_CHECK(),
    /** 检查答 500，或者按住（放开时按那时的 checkFails 回） */
    checkFails: false,
    checkHold: false,
    checkHeld: [] as { resolve(): void }[],
    checks: (): number => calls.filter((c) => c.method === 'POST' && c.path === '/api/console/sop/draft/check').length,
    /** GET /sop 答 500（载入最新草稿失败） */
    getFails: false,
    /** 发布答 409 sop_conflict（撞上的节与它们的线上正文） */
    publishConflict: null as { keys: string[]; current: SopSectionText[] } | null,
    /** 发布答 422 契约没过（带这些问题），或 500（第 11 节） */
    publishFails: null as { contract: ContractViolation[] } | 'error' | null,
    held: [] as { resolve(): void }[],
    nextRev: 10,
    puts: (): { basedOn: string; rev: number | null; edits: { key: string; body: string }[] }[] =>
      calls.filter((c) => c.method === 'PUT' && c.path === '/api/console/sop/draft').map((c) => c.body as never),
  };
  const save = (body: { rev: number | null; edits: { key: string; body: string }[] }): Response => {
    const base = srv.state.draft ?? srv.state.published;
    const draft = version(null, applyEdits(base.sections, body.edits), {
      basedOn: srv.state.draft?.basedOn ?? srv.state.published.id,
      rev: srv.nextRev,
      publishedAt: null,
      publishedByName: null,
    });
    srv.nextRev += 1;
    srv.state = { ...srv.state, draft: { ...draft, stale: false } };
    return json(200, draft);
  };
  calls.length = 0;
  respond = async (call) => {
    if (call.method === 'GET' && call.path === '/api/console/sop')
      return srv.getFails ? json(500, { error: 'internal' }) : json(200, srv.state);
    if (call.method === 'GET' && call.path === '/api/console/sop/versions') return json(200, { items: [srv.state.published] });
    if (call.method === 'POST' && call.path === '/api/console/sop/draft/discard') {
      srv.state = { ...srv.state, draft: null };
      return json(200, { ok: true });
    }
    if (call.method === 'POST' && call.path === '/api/console/sop/draft/publish') {
      if (srv.publishConflict) return json(409, { error: 'sop_conflict', detail: '冲突', ...srv.publishConflict });
      if (srv.publishFails === 'error') return json(500, { error: 'internal', detail: '出错了' });
      if (srv.publishFails) return json(422, { error: 'contract', detail: '没过', violations: srv.publishFails.contract });
      const no = (srv.state.published.versionNo ?? 0) + 1;
      const v = version(no, srv.state.draft!.sections, { publishedAt: '2026-09-26T06:31:00Z' });
      srv.state = { ...srv.state, published: v, draft: null };
      return json(200, v);
    }
    // 回滚：线上换成新的版本号，草稿不动（它的 basedOn 从此过期），同 src/config/sop.ts 的 rollback
    if (call.method === 'POST' && /^\/api\/console\/sop\/versions\/[^/]+\/rollback$/.test(call.path)) {
      const no = (srv.state.published.versionNo ?? 0) + 1;
      const v = version(no, srv.state.published.sections, { changeNote: (call.body as { changeNote: string }).changeNote });
      const d = srv.state.draft;
      srv.state = { ...srv.state, published: v, draft: d ? { ...d, stale: d.basedOn !== v.id } : null };
      return json(200, { ...v, sameHashAsTarget: true });
    }
    if (call.method === 'POST' && call.path === '/api/console/sop/draft/check') {
      // 按住时记下发出时的草稿，放开时照它答（晚回来的是旧草稿的结果）
      const at = srv.state;
      if (srv.checkHold) {
        const d = deferred<void>();
        srv.checkHeld.push({ resolve: () => d.resolve() });
        await d.promise;
      }
      if (srv.checkFails) return json(500, { error: 'internal' });
      return at.draft ? json(200, srv.check(at)) : json(404, { error: 'not_found', detail: '没有草稿' });
    }
    if (call.method !== 'PUT') return new Promise<never>(() => undefined);
    const body = call.body as { rev: number | null; edits: { key: string; body: string }[] };
    // 按住的请求放开时按那时的 mode 回（先改 mode 再放开，就能让路上的那一个答 422、409）
    if (srv.mode === 'hold') {
      const d = deferred<void>();
      srv.held.push({ resolve: () => d.resolve() });
      await d.promise;
    }
    if (srv.mode === 'network') throw new TypeError('Failed to fetch');
    if (srv.mode === 'conflict') return json(409, { error: 'rev_conflict', detail: '草稿已被别人改过' });
    if (srv.mode === 'invalid') return json(422, { error: 'invalid_sop', detail: '编码不对' });
    return save(body);
  };
  return srv;
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await rest(10);
}
async function typeAtEnd(m: PageBox, s: string): Promise<void> {
  const view = EditorView.findFromDOM(m.box.querySelector<HTMLElement>('.sop-editor .cm-content')!)!;
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: s }, userEvent: 'input.type' }));
}
const saveNow = (m: PageBox): string => text(m.box.querySelector('.sop-save-now'));
/** 自测没套 ThemeProvider，antd 在两个汉字的按钮里插了空格（页面上的 autoInsertSpace 是关的） */
const label = (b: Element): string => text(b).replace(/ /g, '');
const headerButton = (m: PageBox, name: string): HTMLButtonElement | undefined =>
  all<HTMLButtonElement>(m.box, '.page-actions button').find((b) => label(b) === name);
/** 发布条（第 6.3 步）：页头只剩丢弃；发布条的「发布…」不能点时是 aria-disabled（点了跳到原因），不是 disabled */
const publishBar = (m: PageBox): HTMLElement | null => m.box.querySelector<HTMLElement>('.action-bar[aria-label="发布"]');
const barButton = (m: PageBox, name: string): HTMLButtonElement | undefined =>
  all<HTMLButtonElement>(publishBar(m) ?? m.box, 'button').find((b) => label(b) === name);
const barBlocked = (m: PageBox): boolean => barButton(m, '发布…')?.getAttribute('aria-disabled') === 'true';
/** [页头的丢弃 disabled，发布条的「发布…」不能点] */
const headerDisabled = (m: PageBox): boolean[] => [!!headerButton(m, '丢弃')?.disabled, barBlocked(m)];
/** 开着的抽屉（标题以 title 开头）；关上以后收起的那一下还在 DOM 里，不算 */
const drawerOf = (title: string): HTMLElement | undefined =>
  all<HTMLElement>(document.body, '.sop-drawer.ant-drawer-open').find((d) => text(d.querySelector('.ant-drawer-title')).startsWith(title));
async function setText(el: HTMLTextAreaElement | HTMLInputElement, v: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
    el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  });
}
/** 点发布条的「发布…」，在抽屉里的说明后面接着写 more，点「发布」 */
async function publishVia(m: PageBox, more: string): Promise<void> {
  await clickEv(barButton(m, '发布…'));
  await waitFor(() => !!drawerOf('发布草稿')?.querySelector('textarea'));
  const ta = drawerOf('发布草稿')!.querySelector<HTMLTextAreaElement>('textarea')!;
  await setText(ta, ta.value + more);
  await waitFor(() =>
    all(drawerOf('发布草稿')!, '.ant-drawer-footer button').some((b) => label(b) === '发布' && !b.getAttribute('aria-disabled')),
  );
  await clickEv(all(drawerOf('发布草稿')!, '.ant-drawer-footer button').find((b) => label(b) === '发布'));
}
async function pressSave(mods: { metaKey?: boolean; ctrlKey?: boolean }): Promise<Event> {
  const e = new win.KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true, ...mods }) as unknown as Event;
  await act(async () => void window.dispatchEvent(e));
  return e;
}
async function leaveAndStay(m: PageBox): Promise<boolean> {
  await act(async () => void m.router.navigate({ to: '/audit' } as never));
  await until(() => guardOpen());
  const blocked = guardOpen() && m.pathname() === '/sop';
  await clickEv(all<HTMLButtonElement>(document.body, '.ant-modal button').find((b) => text(b) === '留下'));
  await until(() => !guardOpen());
  return blocked;
}
const editorEditable = (m: PageBox): string | null | undefined =>
  m.box.querySelector('.sop-editor .cm-content')?.getAttribute('contenteditable');

// 9.3a 有草稿：带草稿的 rev；「保存中…」→「已自动保存14:30」；接着存带上一次响应的 rev；页头按钮
{
  const srv = fakeServer(MEMBER_SOP);
  // 检查没有问题，发布条的「发布…」只看有没有改动
  srv.check = () => ({ ...FIXED_CHECK(), violations: [] });
  srv.mode = 'hold';
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  eq(
    '页头：没有「保存草稿」「检查」「发布」按钮（检查在自动保存以后自动跑，发布在底部的发布条里），只有丢弃；状态句还没有保存那一段',
    [all(m.box, '.page-actions button').map(label), saveNow(m)],
    [['丢弃'], ''],
  );
  eq(
    '状态句的保存那一段按最宽的两种写法占位；会变的那一行是 role=status（读屏念出变化），占位不念',
    [
      all(m.box, '.sop-save-sizer').map((e) => text(e)),
      all(m.box, '.sop-save [role="status"]').map((e) => e.className),
      all(m.box, '.sop-save-sizer').map((e) => e.getAttribute('aria-hidden')),
    ],
    [['·已自动保存00:00', '·没保存上·重试'], ['sop-save-now'], ['true', 'true']],
  );
  eq('没有没存上的改动：丢弃、发布都能点', headerDisabled(m), [false, false]);
  await typeAtEnd(m, '测');
  eq('打了字还没存：丢弃不能点，发布条的「发布…」照样能点（点了先存）', headerDisabled(m), [true, false]);
  await waitFor(() => srv.puts().length === 1);
  eq('停止输入以后存：带草稿的 rev，只带改过的节，正文是编辑器里的原文', srv.puts(), [
    { basedOn: 'v2', rev: 4, edits: [{ key: 'tone', body: editorText(m)! }] },
  ]);
  eq('请求在路上：状态句写「保存中…」', saveNow(m), '·保存中…');
  srv.mode = 'ok';
  await act(async () => srv.held.shift()?.resolve());
  await waitFor(() => saveNow(m) !== '·保存中…');
  eq(
    '存上了：「已自动保存14:30」，按钮能点，缓存里的草稿换成返回的那份',
    [saveNow(m), headerDisabled(m), (m.qc.getQueryData(['sop']) as SopOverview).draft?.rev],
    ['·已自动保存14:30', [false, false], 10],
  );
  await typeAtEnd(m, '试');
  await waitFor(() => srv.puts().length === 2);
  eq('接着存：带上一次成功响应的 rev', srv.puts()[1]?.rev, 10);
  await waitFor(() => saveNow(m) === '·已自动保存14:30' && !headerButton(m, '丢弃')?.disabled);
  await act(async () => void m.router.navigate({ to: '/audit' } as never));
  await until(() => m.pathname() === '/audit');
  eq('全存上了：离开这一页不拦', [guardOpen(), m.pathname()], [false, '/audit']);
  await m.unmount();
}

// 9.3b 没有草稿：首次 rev 为 null、basedOn 是线上版本；路上又打的字，等这一个回来马上接着存
{
  const noDraft: SopOverview = { ...MEMBER_SOP, draft: null };
  const srv = fakeServer(noDraft);
  srv.mode = 'hold';
  const m = await mountPage('/console/sop?section=tone', OWNER, noDraft, FAST);
  await typeAtEnd(m, '一');
  await waitFor(() => srv.puts().length === 1);
  await typeAtEnd(m, '二');
  await rest(120);
  eq('请求在路上：不另发', srv.puts().length, 1);
  srv.mode = 'ok';
  await act(async () => srv.held.shift()?.resolve());
  await waitFor(() => srv.puts().length === 2);
  eq(
    '没有草稿：首次 rev 为 null、basedOn 是线上 v2；第二次带第一次响应的 rev 和路上新打的字',
    srv.puts().map((p) => [p.basedOn, p.rev, p.edits[0]?.body.endsWith('一二')]),
    [
      ['v2', null, false],
      ['v2', 10, true],
    ],
  );
  await m.unmount();
}

// 9.3c ⌘S / Ctrl+S 马上存，不等计时；拦下浏览器的「存储网页」；只读成员不管
{
  const srv = fakeServer(MEMBER_SOP);
  const slow: AutosaveTiming = { ...FAST, debounce: 60_000 };
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, slow);
  await typeAtEnd(m, '快');
  const e = await pressSave({ metaKey: true });
  await waitFor(() => srv.puts().length === 1);
  eq('⌘S：马上存，拦下浏览器的默认动作', [srv.puts().length, e.defaultPrevented], [1, true]);
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  await typeAtEnd(m, '存');
  await pressSave({ ctrlKey: true });
  await waitFor(() => srv.puts().length === 2);
  eq('Ctrl+S：同样马上存', srv.puts().length, 2);
  await m.unmount();
  const agent: Viewer = { ...OWNER, me: { ...(OWNER as Extract<Viewer, { kind: 'member' }>).me, role: 'agent' } };
  const r = await mountPage('/console/sop?section=tone', agent, MEMBER_SOP, slow);
  const re = await pressSave({ metaKey: true });
  await rest(30);
  eq(
    '只读成员：⌘S 不拦、不存，状态句没有保存那一段',
    [re.defaultPrevented, srv.puts().length, !!r.box.querySelector('.sop-save')],
    [false, 2, false],
  );
  await r.unmount();
}

// 9.3d 连不上：「没保存上 · 重试」，离开要确认；按退避自动重试；「重试」马上试；恢复以后存上
{
  const srv = fakeServer(MEMBER_SOP);
  srv.mode = 'network';
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  await typeAtEnd(m, '断');
  await waitFor(() => saveNow(m).includes('没保存上'));
  eq(
    '连不上：状态句是 danger 的「没保存上 · 重试」，「重试」是按钮；连不上只写在状态句里，页头下没有横幅',
    [
      saveNow(m),
      text(m.box.querySelector('.sop-save-failed')),
      text(m.box.querySelector('.sop-save-failed button')),
      all(m.box, '.sop-banners .ant-alert').length,
    ],
    ['·没保存上·重试', '没保存上·重试', '重试', 0],
  );
  eq('没保存上时离开：弹确认，「留下」后还在', await leaveAndStay(m), true);
  await waitFor(() => srv.puts().length === 2);
  eq('按退避自动重试了一次', srv.puts().length, 2);
  await rest(150);
  eq('第二次的退避还没到：不再发', srv.puts().length, 2);
  srv.mode = 'ok';
  await act(async () => void window.dispatchEvent(new win.Event('online') as unknown as Event));
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  eq('恢复联网（online 事件）：马上试，存上了', [srv.puts().length, saveNow(m)], [3, '·已自动保存14:30']);
  srv.mode = 'network';
  await typeAtEnd(m, '又断');
  await waitFor(() => srv.puts().length === 5);
  await rest(100);
  srv.mode = 'ok';
  await clickEv(m.box.querySelector('.sop-save-retry'));
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  eq('再断：退避到 10 秒那一档时点「重试」，马上试、存上', [srv.puts().length, saveNow(m)], [6, '·已自动保存14:30']);
  await m.unmount();
}

// 9.3e 409：横幅、编辑器冻住、不再发；载入最新草稿以后，编辑器换成最新的，没存上的节以对比形式留着，接着存带新的 rev
{
  const srv = fakeServer(MEMBER_SOP);
  srv.mode = 'conflict';
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  // 打开时已有草稿，检查自动跑了一次；载入最新草稿以后草稿换了，要再跑
  await waitFor(() => !!m.box.querySelector('.sop-col-check .check-list-summary'));
  eq('打开时已有草稿：检查跑了一次', srv.checks(), 1);
  await typeAtEnd(m, '我写的');
  const mine = editorText(m)!;
  await waitFor(() => !!m.box.querySelector('.sop-banners .ant-alert'));
  const banner = m.box.querySelector('.sop-banners .ant-alert');
  eq(
    '409：横幅「草稿刚被别人改过」点名没存上的节，按钮「载入最新草稿」；状态句「没保存上」，没有「重试」',
    [
      text(banner?.querySelector('.ant-alert-title')),
      text(banner?.querySelector('.ant-alert-description')).includes('你没保存上的1节（话术原则）'),
      text(banner?.querySelector('.ant-alert-actions button')),
      saveNow(m),
      !!m.box.querySelector('.sop-save-retry'),
    ],
    ['草稿刚被别人改过', true, '载入最新草稿', '·没保存上', false],
  );
  eq('409：编辑器只读，还是你写的', [editorEditable(m), editorText(m)], ['false', mine]);
  await pressSave({ metaKey: true });
  await rest(200);
  eq('409 以后：⌘S、等多久都不再发', srv.puts().length, 1);
  eq('409 停住时离开：弹确认', await leaveAndStay(m), true);
  // 别人存了一版草稿
  const theirs = srv.state.draft!.sections.map((x) => (x.key === 'tone' ? { ...x, text: x.text.replace(/改(\n+)$/, '别人$1') } : x));
  srv.state = { ...srv.state, draft: { ...srv.state.draft!, sections: theirs, rev: 9 } };
  srv.mode = 'ok';
  srv.getFails = true;
  await clickEv(banner?.querySelector('.ant-alert-actions button'));
  await waitFor(() => all(m.box, '.sop-banners .ant-alert').length === 2);
  eq(
    '载入最新草稿没取到：页面还在，编辑器还冻着、是你写的，横幅下面就地报错',
    [
      editorText(m) === mine,
      editorEditable(m),
      all(m.box, '.sop-banners .ant-alert-title').map((t) => text(t)),
      m.box.querySelector('.sop-lost'),
    ],
    [true, 'false', ['草稿刚被别人改过', '服务暂时连不上'], null],
  );
  srv.getFails = false;
  eq('409 停住时：检查结果还在（还是存上的那份草稿）', text(m.box.querySelector('.sop-col-check .check-list-summary')), '6/7通过');
  const gets = calls.filter((c) => c.method === 'GET' && c.path === '/api/console/sop').length;
  await clickEv(banner?.querySelector('.ant-alert-actions button'));
  await waitFor(() => !!m.box.querySelector('.sop-lost'));
  eq(
    '载入最新草稿：重取 /sop，编辑器换成最新的、能改了，横幅没了，状态句回到还没保存过',
    [
      calls.filter((c) => c.method === 'GET' && c.path === '/api/console/sop').length - gets,
      editorText(m) === bodyIn(theirs, 'tone'),
      editorEditable(m),
      text(m.box.querySelector('.sop-banners .ant-alert-title')),
      saveNow(m),
    ],
    [1, true, 'true', '', ''],
  );
  await waitFor(() => srv.checks() === 2);
  eq('载入最新草稿：草稿换了（rev 9），检查再跑一次', srv.checks(), 2);
  const sides = all<HTMLElement>(m.box, '.sop-lost .cm-mergeView .cm-content').map((c) => EditorView.findFromDOM(c)?.state.doc.toString());
  eq(
    '没存上的节以只读对比留着：节名、左边载入时的草稿、右边你写的',
    [text(m.box.querySelector('.sop-lost-name')), sides[0] === bodyIn(theirs, 'tone'), sides[1] === mine],
    ['话术原则', true, true],
  );
  eq('对比还留着时离开：弹确认', await leaveAndStay(m), true);
  await typeAtEnd(m, '再改');
  await waitFor(() => srv.puts().length === 2);
  eq('接着存：带载入的草稿的 rev', srv.puts()[1]?.rev, 9);
  await clickEv(all<HTMLButtonElement>(m.box, '.sop-lost button').find((b) => text(b) === '关掉对比'));
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  eq('关掉对比', m.box.querySelector('.sop-lost'), null);
  await act(async () => void m.router.navigate({ to: '/audit' } as never));
  await until(() => m.pathname() === '/audit');
  eq('对比关掉、全存上了：离开不拦', guardOpen(), false);
  await m.unmount();
}

// 9.3f 格式不对（422）：页头下的横幅，不自动重试；再改照常存
{
  const srv = fakeServer(MEMBER_SOP);
  srv.mode = 'invalid';
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  await typeAtEnd(m, '坏');
  await waitFor(() => saveNow(m).includes('没保存上'));
  await rest(200);
  eq(
    '422：横幅按 ERROR_COPY 写，状态句「没保存上 · 重试」，不自动重试',
    [text(m.box.querySelector('.sop-banners .ant-alert-title')), saveNow(m), srv.puts().length],
    ['无法保存这份话术：格式不对·撤回刚才的改动再试', '·没保存上·重试', 1],
  );
  srv.mode = 'ok';
  await typeAtEnd(m, '好');
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  eq('再改：照常存上，横幅没了', [srv.puts().length, m.box.querySelector('.sop-banners')], [2, null]);
  await m.unmount();
}

// 9.3g rev 只跟自己存上的走：有没存上的改动时，重取带回来的草稿（别人的 rev）不跟；没有待存的改动时跟着服务端
{
  const srv = fakeServer(MEMBER_SOP);
  const slow: AutosaveTiming = { ...FAST, debounce: 60_000 };
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, slow);
  await typeAtEnd(m, '甲');
  const theirs = (rev: number): void => {
    m.qc.setQueryData<SopOverview>(['sop'], (old) => (old ? { ...old, draft: { ...old.draft!, rev } } : old));
  };
  await act(async () => theirs(99));
  // React Query 隔一个宏任务才通知订阅者：等页面按 rev 99 重渲过再存，不然测不到「不跟」
  await rest(20);
  await pressSave({ metaKey: true });
  await waitFor(() => srv.puts().length === 1);
  eq('有没存上的改动时重取到别人的草稿：照旧带打开时的 rev（让服务端答 409），不跟着换', srv.puts()[0]?.rev, 4);
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  await act(async () => theirs(50));
  await rest(20);
  await typeAtEnd(m, '乙');
  await pressSave({ metaKey: true });
  await waitFor(() => srv.puts().length === 2);
  eq('全存上了以后重取到新的草稿：下一次带它的 rev', srv.puts()[1]?.rev, 50);
  await m.unmount();
}

// 9.3h 编辑中被降成只读成员（重取 /me 以后角色变了）：编辑器只读，没存上的改动不再发（发了也是 403），离开照拦
{
  const srv = fakeServer(MEMBER_SOP);
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, { ...FAST, debounce: 200 });
  const agent: Viewer = { ...OWNER, me: { ...(OWNER as Extract<Viewer, { kind: 'member' }>).me, role: 'agent' } };
  await typeAtEnd(m, '甲');
  await act(async () => void m.qc.setQueryData(VIEWER_KEY, agent));
  await rest(400);
  eq('降成只读以后：计时到了也不发，编辑器只读', [srv.puts().length, editorEditable(m)], [0, 'false']);
  eq('降成只读以后离开：弹确认', await leaveAndStay(m), true);
  await m.unmount();
}

// 9.3i 接连几次 409（别人接着在存，每 1.5 秒一次）：上一批对比不丢，这一批载入以后接在后面，同一节写「第几次没存上」；
// 冻着时关掉对比，这一次没存上的照样接上来。409 的那一刻横幅滚进视口；焦点原来在编辑器里的移到横幅上，在别处的不抢
{
  const proto = win.Element.prototype as unknown as { scrollIntoView(this: Element, o?: unknown): void };
  const original = proto.scrollIntoView;
  const scrolled: string[] = [];
  proto.scrollIntoView = function (this: Element, o?: unknown) {
    scrolled.push(`${this.className} ${(o as { block?: string } | undefined)?.block}`);
  };
  const srv = fakeServer(MEMBER_SOP);
  srv.mode = 'conflict';
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  const cm = (): HTMLElement => m.box.querySelector<HTMLElement>('.sop-editor .cm-content')!;
  const bannerText = (): string => text(m.box.querySelector('.sop-conflict .ant-alert-description'));
  /** 每次 409 时编辑器里你写的；对比右边是第几次的，按它查 */
  const mines: string[] = [];
  const conflictOnce = async (s: string): Promise<void> => {
    await typeAtEnd(m, s);
    mines.push(editorText(m)!);
    await waitFor(() => editorEditable(m) === 'false' && !!m.box.querySelector('.sop-conflict'));
  };
  const reload = async (): Promise<void> => {
    await clickEv(all<HTMLButtonElement>(m.box, '.sop-conflict button').find((b) => label(b) === '载入最新草稿'));
    await waitFor(() => editorEditable(m) === 'true');
  };
  const mineIn = (it: HTMLElement): string | undefined =>
    EditorView.findFromDOM(all<HTMLElement>(it, '.cm-mergeView .cm-content')[1]!)?.state.doc.toString();
  const shown = (): [string, number][] =>
    all<HTMLElement>(m.box, '.sop-lost-item').map((it) => [text(it.querySelector('.sop-lost-name')), mines.indexOf(mineIn(it) ?? '')]);

  await act(async () => cm().focus());
  await conflictOnce('【第一次】');
  eq(
    '409：横幅按底边对齐滚进视口（紧挨着页头，一直滚到顶）；焦点原来在编辑器里，移到横幅外层上（不落在「载入最新草稿」上）',
    [scrolled, document.activeElement?.className, m.box.querySelector('.sop-conflict')?.getAttribute('tabindex')],
    [['sop-conflict end'], 'sop-conflict', '-1'],
  );
  await reload();
  eq('载入以后：第一批对比', shown(), [['话术原则', 0]]);

  await act(async () => cm().focus());
  await conflictOnce('【第二次】');
  eq(
    '又一次 409：上一批对比照样留着，横幅点名这一次没存上的节',
    [shown(), bannerText().includes('你没保存上的1节（话术原则）'), scrolled.length],
    [[['话术原则', 0]], true, 2],
  );
  await reload();
  eq('再载入：这一批接在后面，同一节写第几次', shown(), [
    ['话术原则（第1次没存上）', 0],
    ['话术原则（第2次没存上）', 1],
  ]);

  await conflictOnce('【第三次】');
  await clickEv(all<HTMLButtonElement>(m.box, '.sop-lost button').find((b) => label(b) === '关掉对比'));
  eq(
    '冻着时关掉对比：对比没了，横幅照样点名这一次没存上的节，离开照拦',
    [m.box.querySelector('.sop-lost'), bannerText().includes('你没保存上的1节（话术原则）'), await leaveAndStay(m)],
    [null, true, true],
  );
  await reload();
  eq('载入以后：这一次没存上的照样变成对比', shown(), [['话术原则', 2]]);

  const tocRow = rowIn(m, 'tone')!;
  await act(async () => tocRow.focus());
  await conflictOnce('【第四次】');
  eq('焦点在目录上时 409：横幅照样滚进视口，焦点不抢', [scrolled.length, document.activeElement === tocRow], [4, true]);

  proto.scrollIntoView = original;
  await m.unmount();
}

// 9.3j 放弃改动并离开以后不再发：还在数的防抖、连不上时等着的自动重试都跟着页面清掉
{
  const leaveAndDrop = async (m: PageBox): Promise<void> => {
    await act(async () => void m.router.navigate({ to: '/audit' } as never));
    await until(() => guardOpen());
    await clickEv(all<HTMLButtonElement>(document.body, '.ant-modal button').find((b) => label(b) === '放弃改动并离开'));
    await until(() => m.pathname() === '/audit');
  };
  const srv = fakeServer(MEMBER_SOP);
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, { ...FAST, debounce: 300 });
  await typeAtEnd(m, '不要了');
  await leaveAndDrop(m);
  await rest(500);
  eq('防抖还在数时放弃改动并离开：到了别的页，计时到了也不发', [m.pathname(), srv.puts().length], ['/audit', 0]);
  await m.unmount();

  const off = fakeServer(MEMBER_SOP);
  off.mode = 'network';
  const n = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, { ...FAST, backoff: [300, 300] });
  await typeAtEnd(n, '断了');
  await waitFor(() => saveNow(n).includes('没保存上'));
  await leaveAndDrop(n);
  await rest(700);
  eq('连不上、等着自动重试时放弃改动并离开：不再重试', [n.pathname(), off.puts().length], ['/audit', 1]);
  await n.unmount();
}

// 9.3k 请求在路上时要求过接着存（⌘S），又打了字、防抖还在数，这时答 422：不马上再发，等防抖到了带上新打的字发
{
  const srv = fakeServer(MEMBER_SOP);
  srv.mode = 'hold';
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, { ...FAST, debounce: 400 });
  await typeAtEnd(m, '甲');
  await waitFor(() => srv.puts().length === 1);
  await pressSave({ metaKey: true });
  await typeAtEnd(m, '乙');
  srv.mode = 'invalid';
  await act(async () => srv.held.shift()?.resolve());
  await waitFor(() => saveNow(m).includes('没保存上'));
  await rest(60);
  eq('422 回来时防抖还在数：不马上再发', srv.puts().length, 1);
  srv.mode = 'ok';
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  eq(
    '防抖到了：发一次，带路上新打的字，存上了',
    [srv.puts().length, srv.puts()[1]?.edits[0]?.body.endsWith('甲乙'), saveNow(m)],
    [2, true, '·已自动保存14:30'],
  );
  await m.unmount();
}

// 9.3l 输入法组字：没上屏的拼音不存，字上屏以后存汉字；409 在组字时回来，等字上屏再冻结编辑器，对比里是上屏的字。
// CodeMirror 按输入法的 composition 事件与 DOM 的变化判断在不在组字，happy-dom 里没有输入法：这里直接接管 view.composing
{
  const srv = fakeServer(MEMBER_SOP);
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  const content = (): HTMLElement => m.box.querySelector<HTMLElement>('.sop-editor .cm-content')!;
  const view = EditorView.findFromDOM(content())!;
  let composing = true;
  Object.defineProperty(view, 'composing', { configurable: true, get: () => composing });
  /** 上屏：末尾的拼音换成汉字 */
  const commit = async (pinyin: string, han: string): Promise<void> => {
    const end = view.state.doc.length;
    await act(async () => view.dispatch({ changes: { from: end - pinyin.length, to: end, insert: han }, userEvent: 'input.type.compose' }));
    composing = false;
  };
  await typeAtEnd(m, 'ni hao');
  await rest(250);
  eq('组字时：计时到了也不存，状态句没有保存那一段', [srv.puts().length, saveNow(m)], [0, '']);
  await commit('ni hao', '你好');
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  const first = srv.puts()[0]?.edits[0]?.body ?? '';
  eq('字上屏以后：存的是汉字，没有拼音', [srv.puts().length, first.endsWith('你好'), first.includes('ni hao')], [1, true, false]);

  srv.mode = 'hold';
  await typeAtEnd(m, '甲');
  await waitFor(() => srv.puts().length === 2);
  composing = true;
  await typeAtEnd(m, 'yi');
  srv.mode = 'conflict';
  await act(async () => srv.held.shift()?.resolve());
  await rest(300);
  eq(
    '组字时回来 409：编辑器没有重建、还能改（组到一半的字不被打断），还没有横幅，状态句「保存中…」',
    [EditorView.findFromDOM(content()) === view, editorEditable(m), !!m.box.querySelector('.sop-conflict'), saveNow(m)],
    [true, 'true', false, '·保存中…'],
  );
  await commit('yi', '乙');
  await waitFor(() => editorEditable(m) === 'false');
  const mine = editorText(m)!;
  eq(
    '字上屏以后停住：编辑器冻住、横幅出来，编辑器里是上屏的字',
    [mine.endsWith('你好甲乙'), text(m.box.querySelector('.sop-conflict .ant-alert-title')), srv.puts().length],
    [true, '草稿刚被别人改过', 2],
  );
  await clickEv(all<HTMLButtonElement>(m.box, '.sop-conflict button').find((b) => label(b) === '载入最新草稿'));
  await waitFor(() => !!m.box.querySelector('.sop-lost'));
  const side = all<HTMLElement>(m.box, '.sop-lost .cm-mergeView .cm-content')[1];
  const right = side ? EditorView.findFromDOM(side)?.state.doc.toString() : undefined;
  eq('载入以后：对比右边是上屏的字，没有拼音', [right === mine, right?.includes('yi')], [true, false]);
  await m.unmount();
}

// 9.3m 丢弃、发布以后：那份草稿已经没了，状态句不再写「已自动保存14:30」；之后再改，从新建草稿存起
{
  const srv = fakeServer(MEMBER_SOP);
  // 检查没有问题，发布条的「发布…」能点
  srv.check = () => ({ ...FIXED_CHECK(), violations: [] });
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  const status = (): string => text(m.box.querySelector('.page-status'));
  const modal = (title: string): Element | undefined =>
    all(document.body, '.ant-modal').find((x) => text(x.querySelector('.ant-modal-title')) === title);
  const saved = (): boolean => saveNow(m) === '·已自动保存14:30' && !headerButton(m, '丢弃')?.disabled;
  await typeAtEnd(m, '丢');
  await waitFor(saved);
  await clickEv(headerButton(m, '丢弃'));
  await until(() => !!modal('丢弃草稿？'));
  await clickEv(all(modal('丢弃草稿？')!, 'button').find((b) => label(b) === '丢弃草稿'));
  await waitFor(() => status().includes('没有未发布的改动'));
  eq('丢弃以后：没有未发布的改动，保存那一段清空', [status().includes('没有未发布的改动'), saveNow(m)], [true, '']);
  await typeAtEnd(m, '发');
  await waitFor(saved);
  eq('丢弃以后再改：新建草稿（rev 为 null、basedOn 线上 v2）', [srv.puts().at(-1)?.rev, srv.puts().at(-1)?.basedOn], [null, 'v2']);
  await publishVia(m, '改了话术原则');
  await waitFor(() => status().startsWith('线上v3'));
  eq('发布以后：线上v3、没有未发布的改动，保存那一段清空', [status().includes('没有未发布的改动'), saveNow(m)], [true, '']);
  await m.unmount();
}

// 9.3n 载入最新草稿、关掉对比以后焦点去哪：按过的按钮跟着横幅、对比卸下，焦点不能掉到 body 上。
// 载入以后有对比的到对比的标题上；关掉对比回到编辑器，还冻着时回到横幅；焦点已经在别处的不抢
{
  const srv = fakeServer(MEMBER_SOP);
  srv.mode = 'conflict';
  const m = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP, FAST);
  const cm = (): HTMLElement => m.box.querySelector<HTMLElement>('.sop-editor .cm-content')!;
  const button = (sel: string, name: string): HTMLButtonElement | undefined =>
    all<HTMLButtonElement>(m.box, `${sel} button`).find((b) => label(b) === name);
  /** 用键盘按按钮：焦点先在它上面 */
  const press = async (b: HTMLButtonElement | undefined): Promise<void> => {
    await act(async () => b?.focus());
    await clickEv(b);
  };
  const conflictOnce = async (s: string): Promise<void> => {
    await act(async () => cm().focus());
    await typeAtEnd(m, s);
    await waitFor(() => editorEditable(m) === 'false' && !!m.box.querySelector('.sop-conflict'));
  };
  const loaded = (): boolean => !!m.box.querySelector('.sop-lost') && editorEditable(m) === 'true';
  await conflictOnce('一');
  await press(button('.sop-conflict', '载入最新草稿'));
  await waitFor(loaded);
  await settle();
  const title = m.box.querySelector('.sop-lost .sop-card-title');
  eq(
    '载入最新草稿以后：焦点在对比的标题上（它不在 Tab 顺序里）',
    [document.activeElement === title, title?.getAttribute('tabindex')],
    [true, '-1'],
  );
  await press(button('.sop-lost', '关掉对比'));
  await waitFor(() => !m.box.querySelector('.sop-lost'));
  await settle();
  eq('关掉对比以后：焦点回到编辑器', document.activeElement === cm(), true);

  await conflictOnce('二');
  await press(button('.sop-conflict', '载入最新草稿'));
  await waitFor(loaded);
  await conflictOnce('三');
  await press(button('.sop-lost', '关掉对比'));
  await waitFor(() => !m.box.querySelector('.sop-lost'));
  await settle();
  eq('冻着时关掉对比：焦点回到横幅上', document.activeElement === m.box.querySelector('.sop-conflict'), true);

  const tocRow = rowIn(m, 'tone')!;
  await act(async () => tocRow.focus());
  await clickEv(button('.sop-conflict', '载入最新草稿'));
  await waitFor(loaded);
  await settle();
  eq('焦点在目录上时点「载入最新草稿」（鼠标）：焦点不抢', document.activeElement === tocRow, true);
  await m.unmount();
}

// 9.3o 匿名：已经有数据时重取失败，页头下就地报错，正文照样在
{
  respond = async (call) =>
    call.method === 'GET' && call.path === '/api/console/sop' ? json(500, { error: 'internal' }) : new Promise<never>(() => undefined);
  const a = await mountPage(
    '/console/sop?section=tone',
    { kind: 'anon', pack: packOf(TRAVEL) },
    { published: { versionNo: 2, publishedAt: '2026-09-25T10:30:00Z', promptHash: 'a'.repeat(12), sections: PUBLISHED } },
  );
  eq('匿名：一开始没有横幅', !!a.box.querySelector('.sop-banners'), false);
  await act(async () => void a.qc.refetchQueries({ queryKey: ['sop'] }));
  await waitFor(() => !!a.box.querySelector('.sop-banners .ant-alert'));
  eq(
    '匿名重取失败：页头下的横幅（服务暂时连不上），正文还在',
    [text(a.box.querySelector('.sop-banners .ant-alert-title')), !!a.box.querySelector('.sop-editor .cm-content')],
    ['服务暂时连不上', true],
  );
  await a.unmount();
  respond = null;
}

// 9.4 三栏的格子
{
  const cols = (m: PageBox): string[] =>
    all<HTMLElement>(m.box, '.sop-layout > .sop-body > *').map((e) => [...e.classList].find((c) => c.startsWith('sop-col-')) ?? '?');
  const travelPack = { ...packOf(TRAVEL), vocabulary: { ...packOf(TRAVEL).vocabulary, ...VOCAB } };
  const owner: Viewer = { ...OWNER, pack: travelPack };
  const noDraft: SopOverview = { ...MEMBER_SOP, draft: null };
  const srv = fakeServer(noDraft);
  const m = await mountPage('/console/sop?section=tone', owner, noDraft);
  eq('成员：目录、中栏、检查清单、工具，DOM 里依次排（Tab 顺序：目录 → 编辑器）', cols(m), [
    'sop-col-toc',
    'sop-col-main',
    'sop-col-check',
    'sop-col-tools',
  ]);
  eq(
    '检查清单在右栏那一格：没有草稿时不检查，7 项都是「还没跑」，没有通过数',
    [all(m.box, '.sop-col-check .check-item-pending').length, m.box.querySelector('.sop-col-check .check-list-summary'), srv.checks()],
    [7, null, 0],
  );
  eq(
    '工具卡片：标题、每行一个芯片（中文名、原名取行业包）、卡底说明',
    [
      text(m.box.querySelector('.sop-tools-card .sop-card-title')),
      all(m.box, '.sop-tools-card .sop-tool-chip').map((c) => [
        text(c.querySelector('.sop-tool-label')),
        text(c.querySelector('.sop-tool-name')),
      ]),
      text(m.box.querySelector('.sop-tools-note')),
    ],
    [
      '话术里可以点名的工具',
      [
        ['查线路', 'search_routes'],
        ['生成方案书', 'generate_proposal'],
      ],
      '写别的名字模型会当成不存在',
    ],
  );
  await m.unmount();
  eq('没打字就不存', srv.puts().length, 0);
  fakeServer(MEMBER_SOP);
  const again = await mountPage('/console/sop?section=tone', owner, MEMBER_SOP, FAST);
  await waitFor(() => !!again.box.querySelector('.sop-col-check .check-list-summary'));
  eq(
    '打开时已有草稿：自动检查，结果列在右栏的清单里（6/7通过，没过的写几处、哪一节）',
    [text(again.box.querySelector('.sop-col-check .check-list-summary')), text(again.box.querySelector('.sop-col-check .check-item-fail'))],
    ['6/7通过', '工具名都存在1处·话术原则'],
  );
  await again.unmount();
  const agent: Viewer = { ...owner, me: { ...(owner as Extract<Viewer, { kind: 'member' }>).me, role: 'agent' } };
  const r = await mountPage('/console/sop?section=tone', agent, MEMBER_SOP);
  eq('只读成员：没有检查清单，工具卡片照画', cols(r), ['sop-col-toc', 'sop-col-main', 'sop-col-tools']);
  await r.unmount();
  const noTools = await mountPage('/console/sop?section=tone', OWNER, MEMBER_SOP);
  eq('行业包没有工具：不画工具那一格', cols(noTools), ['sop-col-toc', 'sop-col-main', 'sop-col-check']);
  await noTools.unmount();
  const a = await mountPage(
    '/console/sop?section=tone',
    { kind: 'anon', pack: travelPack },
    { published: { versionNo: 2, publishedAt: '2026-09-25T10:30:00Z', promptHash: 'a'.repeat(12), sections: PUBLISHED } },
  );
  eq('匿名：只有目录和中栏', cols(a), ['sop-col-toc', 'sop-col-main']);
  await a.unmount();
  // /sop 永远不回，停在加载中
  respond = null;
  const skel = await mountPage('/console/sop?section=tone', OWNER, null);
  eq('加载骨架：同一个网格，目录一格、中栏一格', cols(skel), ['sop-col-toc', 'sop-col-main']);
  await skel.unmount();
  win.happyDOM.setWindowSize({ width: 1100, height: 1100 });
  const narrow = await mountPage('/console/sop?section=tone', owner, MEMBER_SOP);
  eq(
    '窄屏（<1280）：一栏，下拉、中栏、检查清单依次往下',
    [
      !!narrow.box.querySelector('.sop-body.is-narrow'),
      cols(narrow).slice(0, 3),
      !!narrow.box.querySelector('.sop-col-toc .sop-toc-select'),
    ],
    [true, ['sop-col-toc', 'sop-col-main', 'sop-col-check'], true],
  );
  await narrow.unmount();
  win.happyDOM.setWindowSize({ width: 1440, height: 1100 });
}
respond = null;

// ---------------- 10. 检查与定位（第 6.2 步） ----------------
// spec「销售话术 · 检查」：说明由前端按 code、match 生成；点清单里的一项去哪；每一处 match 画波浪线；写错的工具名、字段名在那一段
// 之后插行内提醒，行业包词汇里编辑距离 ≤2 的名字给「改成…」，点了替换那一段里的几处并马上存；每次存上以后检查。

// 10.1 纯函数：问题落在哪一节、点了去哪、说明、候选、正文里的每一处；清单的各项
{
  const published: SopSectionText[] = [
    { key: 'preamble', text: '前言。\n\n' },
    { key: 'price-rules', text: '## 定价规则（只有这两条，硬性）\n\n定价只有两条规则。\n\n' },
  ];
  const vs: ContractViolation[] = [
    { code: 'structure', sectionKey: 'tone', detail: 'x' },
    { code: 'structure', sectionKey: null, detail: 'x' },
    { code: 'locked_changed', sectionKey: 'stages', detail: 'x' },
    { code: 'phrase_missing', sectionKey: null, detail: 'x', match: '定价只有两条规则' },
    { code: 'phrase_missing', sectionKey: null, detail: 'x', match: '线上也没有这句' },
    { code: 'phrase_forbidden', sectionKey: 'tone', detail: 'x', match: '缩短天数重新报价' },
    { code: 'phrase_forbidden', sectionKey: null, detail: 'x', match: '只在固定要求里' },
    { code: 'unknown_tool', sectionKey: 'tone', detail: 'x', match: 'search_route' },
    { code: 'unknown_field', sectionKey: 'objections', detail: 'x', match: 'payURL' },
    { code: 'unknown_tool', sectionKey: 'tone', detail: 'x' },
    { code: 'over_budget', sectionKey: null, detail: 'x' },
  ];
  const located = locateViolations(vs, published);
  eq(
    '落在哪一节：必需说法取线上版本里含这句的节（线上也没有就不落），超额不落在节上，其余取 sectionKey',
    located.map((v) => v.section),
    ['tone', null, 'stages', 'price-rules', null, 'tone', null, 'tone', 'objections', 'tone', null],
  );
  eq(
    '点了去哪：禁用短语、写错的名字选中 match（名字按标识符找），结构、固定规则、必需说法打开那一节，超额去额度条，没有节的哪也不去',
    located.map((v) => v.target),
    [
      { kind: 'section', section: 'tone' },
      null,
      { kind: 'section', section: 'stages' },
      { kind: 'section', section: 'price-rules' },
      null,
      { kind: 'match', section: 'tone', match: '缩短天数重新报价', name: false },
      null,
      { kind: 'match', section: 'tone', match: 'search_route', name: true },
      { kind: 'match', section: 'objections', match: 'payURL', name: true },
      { kind: 'section', section: 'tone' },
      { kind: 'quota' },
    ],
  );
  eq('说明：照 spec「检查」的表，服务端的 detail 不用；没有 match 的说不清就不写', located.map(problemText), [
    '这一节的标题或位置被改了，改回原来的标题',
    '这一节的标题或位置被改了，改回原来的标题',
    '固定规则节不能改，撤回这一节的改动',
    '要保留这句：「定价只有两条规则」',
    '要保留这句：「线上也没有这句」',
    '「缩短天数重新报价」不能出现在话术里',
    '「只在固定要求里」不能出现在话术里',
    '提到了不存在的工具「search_route」',
    '提到了不存在的字段「payURL」',
    null,
    null,
  ]);
  eq(
    '编辑卡片上方的说明：这一节里没有行内提醒的几类，去重；写错的名字不在这里（在行内提醒里）',
    [sectionNotes([...located, located[0]!], 'tone'), sectionNotes(located, 'price-rules'), sectionNotes(located, 'objections')],
    [['这一节的标题或位置被改了，改回原来的标题', '「缩短天数重新报价」不能出现在话术里'], ['要保留这句：「定价只有两条规则」'], []],
  );

  eq(
    '编辑距离：多一个字 1、少两个字 2、对调 2、空串、相同 0；超过 2 的一律报 3',
    [
      editDistance('search_route', 'search_routes'),
      editDistance('serch_route', 'search_routes'),
      editDistance('abc', 'acb'),
      editDistance('', 'ab'),
      editDistance('abc', 'abc'),
      editDistance('abcdef', 'uvwxyz'),
      editDistance('a', 'abcd'),
    ],
    [1, 2, 2, 2, 0, 3, 3],
  );
  const tools = { search_routes: '查线路', search_hotels: '查酒店', create_quote: '算报价' };
  eq(
    '候选：编辑距离 ≤2 里最近的一个；远了、就是它自己都不给',
    [
      nearestName('search_route', tools),
      nearestName('create_quota', tools),
      nearestName('search_hotel', tools),
      nearestName('zzz_tool', tools),
      nearestName('search_routes', tools),
    ],
    [
      { name: 'search_routes', label: '查线路' },
      { name: 'create_quote', label: '算报价' },
      { name: 'search_hotels', label: '查酒店' },
      null,
      null,
    ],
  );
  eq('一样近的取表里靠前的', nearestName('ab_e', { ab_c: '甲', ab_d: '乙' }), { name: 'ab_c', label: '甲' });
  eq('更近的在后面也取更近的', nearestName('ab_cd', { ab_xy: '甲', ab_ce: '乙' }), { name: 'ab_ce', label: '乙' });
  const withProto = Object.assign(Object.create({ proto_x: '原型上的' }) as Record<string, string>, { far_away_name: '自己的' });
  eq('只认自己的键：原型上的名字不当候选', nearestName('proto_z', withProto), null);

  const vocab: Vocabulary = { tools: { search_routes: '查线路', generate_proposal: '生成方案书' }, sopFields: { payUrl: '付款链接' } };
  eq(
    '话术原则的问题：禁用短语只画波浪线；写错的工具名带行内提醒，候选从工具名里找，「模型只认2个」；没有 match 的不列',
    editorProblems(located, 'tone', vocab),
    [
      { match: '缩短天数重新报价', name: false, hint: null },
      { match: 'search_route', name: true, hint: { what: 'tool', known: 2, fix: { name: 'search_routes', label: '查线路' } } },
    ],
  );
  eq('字段名从 sopFields 里找候选（大小写各算一处）', editorProblems(located, 'objections', vocab), [
    { match: 'payURL', name: true, hint: { what: 'field', known: 1, fix: { name: 'payUrl', label: '付款链接' } } },
  ]);
  eq('行业包没到：照样画波浪线、插提醒，只是没有「改成…」、不写个数', editorProblems(located, 'tone', undefined)[1], {
    match: 'search_route',
    name: true,
    hint: { what: 'tool', known: 0, fix: null },
  });
  eq('同一个名字报了两次（检查与发布被拒）：只列一次', editorProblems([...located, located[7]!], 'tone', vocab).length, 2);
  const renoLocated = locateViolations([{ code: 'unknown_tool', sectionKey: 'tone', match: 'search_package' }], []);
  eq(
    '家装整装假包：候选取它自己的词汇',
    editorProblems(renoLocated, 'tone', { tools: { search_packages: '查套餐' }, sopFields: {} })[0]?.hint,
    {
      what: 'tool',
      known: 1,
      fix: { name: 'search_packages', label: '查套餐' },
    },
  );

  const t = 'search_route、search_routes、xsearch_route、search_route1、search_route_x、（search_route）';
  const last = t.indexOf('（search_route）') + 1;
  eq('按标识符找：前后连着字母、数字、下划线的不算（与服务端的 \\b 一致）', occurrences(t, 'search_route', true), [
    [0, 12],
    [last, last + 12],
  ]);
  eq('按原文找：不重叠', occurrences('aaaa', 'aa', false), [
    [0, 2],
    [2, 4],
  ]);
  eq('空的 match：一处也没有', occurrences('abc', '', false), []);
  eq(
    '行内提醒的第二行：写错的后果',
    [
      hintNote({ what: 'tool', known: 7, fix: null }),
      hintNote({ what: 'field', known: 13, fix: null }),
      hintNote({ what: 'tool', known: 0, fix: null }),
    ],
    [
      '模型只认7个工具名，写错的名字会被当成不存在，这条规则就不起作用了。',
      '模型只认13个字段名，写错的名字会被当成不存在，这条规则就不起作用了。',
      '写错的名字会被当成不存在，这条规则就不起作用了。',
    ],
  );
  eq('按钮：「改成search_routes」，不手打空格', fixLabel('search_routes'), '改成search_routes');

  // 清单的各项
  const clicked: unknown[] = [];
  const items = checkItems(SPEC, located, { chars: 2303, limit: LIMIT }, (target) => clicked.push(target));
  eq(
    '没过的项：处数和问题落在的节（去重，不落在节上的不写）；有去处的整行能点',
    items.map((i) => [i.key, i.state, i.note, typeof i.onClick]),
    [
      ['structure', 'fail', ['2处', '话术原则'], 'function'],
      ['locked_changed', 'fail', ['1处', '各阶段目标'], 'function'],
      ['phrase_missing', 'fail', ['2处', '定价规则（只有这两条，硬性）'], 'function'],
      ['phrase_forbidden', 'fail', ['2处', '话术原则'], 'function'],
      ['unknown_tool', 'fail', ['2处', '话术原则'], 'function'],
      ['unknown_field', 'fail', ['1处', '异议处理'], 'function'],
      ['over_budget', 'fail', ['1处'], 'function'],
    ],
  );
  for (const i of items) i.onClick?.();
  eq('点了去这一项第一个有去处的问题', clicked, [
    { kind: 'section', section: 'tone' },
    { kind: 'section', section: 'stages' },
    { kind: 'section', section: 'price-rules' },
    { kind: 'match', section: 'tone', match: '缩短天数重新报价', name: false },
    { kind: 'match', section: 'tone', match: 'search_route', name: true },
    { kind: 'match', section: 'objections', match: 'payURL', name: true },
    { kind: 'quota' },
  ]);
  eq(
    '超了额度：「字数在额度内」写「超出N字」',
    checkItems(SPEC, locateViolations([vs[10]!], []), { chars: LIMIT + 42, limit: LIMIT }).at(-1)?.note,
    '超出42字',
  );
  const passed = checkItems(SPEC, [], { chars: 2303, limit: LIMIT });
  eq(
    '全过：只有「字数在额度内」写百分比（B 页的 87%）',
    passed.map((i) => [i.state, i.note ?? null]),
    [...Array.from({ length: 6 }, () => ['pass', null]), ['pass', '87%']],
  );
  eq('没有字数：百分比不写', checkItems(SPEC, [], null).at(-1)?.note, undefined);
  eq(
    '还没跑：7 项都是「还没跑」，没有说明、不能点',
    checkItems(SPEC, null, null, noop).map((i) => [i.state, i.note, i.onClick]),
    Array.from({ length: 7 }, () => ['pending', undefined, undefined]),
  );
  eq('不给 onLocate：没过的项不能点', checkItems(SPEC, located, null).filter((i) => i.onClick).length, 0);
  const nowhere = checkItems(SPEC, locateViolations([vs[1]!], []), null, noop)[0]!;
  eq(
    '没过的项里没有一条有去处（节表整体不对）：不能点，只写处数',
    [nowhere.key, nowhere.state, nowhere.note, typeof nowhere.onClick],
    ['structure', 'fail', ['1处'], 'undefined'],
  );
  eq(
    '百分比与额度条同一个写法',
    [quotaPercent(2303, LIMIT), quotaPercent(2525, LIMIT), quotaPercent(LIMIT, LIMIT), quotaPercent(LIMIT + 1, LIMIT), quotaPercent(10, 0)],
    [87, 94, 100, 101, 0],
  );
}

// 10.2 编辑器：波浪线与行内提醒（EditorState 上算、挂在 DOM 里），「改成…」的那一笔
// 第一段里另有一处写对的 search_routes（B 页的话术原则就是这样）：「改成…」按标识符找，不能把它当成 search_route 再补一个 s
const DOC2 = [
  '- 先调 search_route 查线路，search_routes 才是对的，别用 search_route 猜。',
  '     续行里也写了 search_route。',
  '- 第二条：缩短天数重新报价不行。',
  '',
  '顶格的一段提到 search_route，还有 payURL。',
].join('\n');
/** 第一段（第 1、2 行）点了「改成search_routes」以后：只换写错的三处，写对的那一处照旧 */
const DOC2_FIXED = [
  '- 先调 search_routes 查线路，search_routes 才是对的，别用 search_routes 猜。',
  '     续行里也写了 search_routes。',
  ...DOC2.split('\n').slice(2),
].join('\n');
const TOOL_HINT = { what: 'tool', known: 2, fix: { name: 'search_routes', label: '查线路' } } as const;
const PROBLEMS: EditorProblem[] = [
  { match: 'search_route', name: true, hint: TOOL_HINT },
  { match: '缩短天数重新报价', name: false, hint: null },
  { match: 'payURL', name: true, hint: { what: 'field', known: 1, fix: { name: 'payUrl', label: '付款链接' } } },
];
{
  const endOf = (n: number): number => lineOf(DOC2, n).from + lineOf(DOC2, n).text.length;
  const [s1, s2, s3, s4] = [...DOC2.matchAll(/\bsearch_route\b/g)].map((x) => x.index);
  const f = DOC2.indexOf('缩短天数重新报价');
  const p = DOC2.indexOf('payURL');
  const places = problemPlaces(DOC2, PROBLEMS);
  eq('波浪线：每一处，按位置排', places.marks, [
    [s1, s1 + 12],
    [s2, s2 + 12],
    [s3, s3 + 12],
    [f, f + 8],
    [s4, s4 + 12],
    [p, p + 6],
  ]);
  eq(
    '行内提醒：写错的名字每一段一条，插在那一段（列表项连同续行）的末行后面，缩进取那一段第一行（续行缩两级，提醒缩一级）；禁用短语没有',
    places.hints.map((h) => [h.at, h.indent, h.match]),
    [
      [endOf(2), 1, 'search_route'],
      [endOf(5), 0, 'search_route'],
      [endOf(5), 0, 'payURL'],
    ],
  );
  eq('没有问题：什么都不画', problemPlaces(DOC2, []), { marks: [], hints: [] });

  const st = EditorState.create({ doc: DOC2, extensions: [sopEditorSetup({ problems: PROBLEMS, halt: false })] });
  const kinds = (state: EditorState): [number, number] => {
    const d = decoList(state.field(problemsField).deco);
    return [d.filter((x) => x.spec.class === 'sop-bad').length, d.filter((x) => x.spec.block === true).length];
  };
  eq('EditorState 上：6 处波浪线、3 条块级的行内提醒', kinds(st), [6, 3]);
  const typed = st.update({ changes: { from: s1, to: s1 + 12, insert: 'search_routes' } }).state;
  eq('改掉一处：波浪线跟着少一处（位置每次改动都重新找），这一段还有别的，提醒还在', kinds(typed), [5, 3]);
  eq('换成没有问题：都没了', kinds(st.update({ effects: setProblems.of([]) }).state), [0, 0]);
  // 点清单定位：选中第一处（四处里的第一处），找不到时不动
  const sv = new EditorView({ state: st, parent: document.createElement('div') });
  const picked = selectFirst(sv, 'search_route', true);
  const missing = selectFirst(sv, 'zzz_tool', true);
  eq(
    '定位：选中第一处；找不到时报 false、选区不动',
    [picked, sv.state.selection.main.from, sv.state.selection.main.to, missing],
    [true, s1, s1 + 12, false],
  );
  sv.destroy();
  const fixable = (state: EditorState): unknown[] =>
    decoList(state.field(problemsField).deco)
      .filter((x) => x.spec.block === true)
      .map((x) => (x.spec.widget as { fixable: boolean }).fixable);
  eq(
    '只读的编辑器：提醒照画，不给「改成…」',
    [
      fixable(st),
      fixable(EditorState.create({ doc: DOC2, extensions: [sopEditorSetup({ problems: PROBLEMS }), EditorState.readOnly.of(true)] })),
    ],
    [
      [true, true, true],
      [false, false, false],
    ],
  );

  const spec = fixNameAt(st, endOf(2), 'search_route', 'search_routes');
  const tr = spec ? st.update(spec) : null;
  const want = DOC2_FIXED;
  eq(
    '「改成…」：换掉这一段（第 1、2 行）里写错的三处，写对的那一处和别的段不动；光标在最后一处后面；带 problemFix 标记',
    [tr?.state.doc.toString() === want, tr?.state.selection.main.head, tr?.annotation(problemFix)],
    [true, want.indexOf('search_routes。') + 13, true],
  );
  const firstPara = (d: string | undefined): string => (d ?? '').split('\n').slice(0, 2).join('\n');
  eq(
    '「改成…」以后第一段：四处都是 search_routes，没有补成 search_routess 的',
    [firstPara(tr?.state.doc.toString()).match(/\bsearch_routes\b/g)?.length, tr?.state.doc.toString().includes('search_routess')],
    [4, false],
  );
  eq('「改成…」的那一段已经没有这个名字：不改', fixNameAt(st, endOf(3), 'search_route', 'search_routes'), null);
  const field = fixNameAt(st, endOf(5), 'payURL', 'payUrl');
  eq('字段名一样：只换那一段', field ? st.update(field).state.doc.toString() === DOC2.replace('payURL', 'payUrl') : false, true);
}

// 10.2b 挂在 DOM 里：波浪线、行内提醒的文字与按钮，点了以后回调；换问题不重建；只读没有按钮
{
  const changes: string[] = [];
  let fixes = 0;
  const el = (p: Partial<Parameters<typeof SopEditor>[0]> = {}) => (
    <SopEditor
      name="话术原则"
      value={DOC2}
      vocabulary={VOCAB}
      problems={PROBLEMS}
      onChange={(v) => changes.push(v)}
      onFix={() => (fixes += 1)}
      {...p}
    />
  );
  const m = await rootFor(el());
  const cm = (): HTMLElement => m.box.querySelector<HTMLElement>('.cm-content')!;
  const view = EditorView.findFromDOM(cm())!;
  eq(
    '波浪线：每一处都包在 .sop-bad 里',
    all(m.box, '.sop-bad').map((e) => e.textContent),
    ['search_route', 'search_route', 'search_route', '缩短天数重新报价', 'search_route', 'payURL'],
  );
  const hints = (): HTMLElement[] => all<HTMLElement>(m.box, '.sop-hint-wrap');
  const h0 = hints()[0];
  eq(
    '第一条提醒：紧跟在第一个列表项的续行后面，缩一级；在文字流里（不可编辑的块）',
    [hints().length, text(h0?.previousElementSibling), h0?.classList.contains('sop-hint-in1'), h0?.getAttribute('contenteditable')],
    [3, '续行里也写了 search_route。', true, 'false'],
  );
  eq(
    '第一条提醒：第一行点名写错的名字与候选（芯片：中文名、原名），第二行写后果，右边是「改成…」',
    [
      text(h0?.querySelector('.sop-hint-title')),
      [text(h0?.querySelector('.sop-hint-chip-label')), text(h0?.querySelector('.sop-hint-chip-name'))],
      text(h0?.querySelector('.sop-hint-note')),
      text(h0?.querySelector('button.sop-hint-fix')),
      h0?.querySelector('.sop-hint-icon svg')?.getAttribute('width'),
    ],
    [
      '提到了不存在的工具「search_route」，是不是「查线路search_routes」？',
      ['查线路', 'search_routes'],
      '模型只认2个工具名，写错的名字会被当成不存在，这条规则就不起作用了。',
      '改成search_routes',
      '14',
    ],
  );
  eq(
    '字段名的提醒',
    [
      text(hints()[2]?.querySelector('.sop-hint-title')),
      text(hints()[2]?.querySelector('.sop-hint-note')),
      text(hints()[2]?.querySelector('button')),
    ],
    [
      '提到了不存在的字段「payURL」，是不是「付款链接payUrl」？',
      '模型只认1个字段名，写错的名字会被当成不存在，这条规则就不起作用了。',
      '改成payUrl',
    ],
  );
  eq(
    '挤压回退：提醒里连用的「」，」也挤（「」？」不挤：「？」不参与）',
    all(h0!, '.halt').map((e) => e.textContent),
    ['」'],
  );
  await clickEv(h0?.querySelector('button.sop-hint-fix'));
  await settle();
  const want = DOC2_FIXED;
  eq(
    '点「改成search_routes」：这一段换掉；onChange 一次（新正文）、onFix 一次；焦点回到正文；这一段的提醒没了',
    [changes.length, changes[0] === want, fixes, document.activeElement === cm(), hints().length],
    [1, true, 1, true, 2],
  );
  await m.render(el({ value: want, problems: [] }));
  eq(
    '换成没有问题：波浪线、提醒都没了，编辑器不重建',
    [all(m.box, '.sop-bad').length, hints().length, EditorView.findFromDOM(cm()) === view],
    [0, 0, true],
  );
  eq('外面换问题与正文：不回调', [changes.length, fixes], [1, 1]);
  // 行业包比检查结果晚到：同一处的提醒从没有候选换成有候选，按钮要出来（部件不能沿用旧的 DOM）
  const early: EditorProblem[] = [{ match: 'search_route', name: true, hint: { what: 'tool', known: 2, fix: null } }];
  await m.render(el({ value: DOC2, problems: early }));
  const before = all(m.box, 'button.sop-hint-fix').length;
  await m.render(el({ value: DOC2, problems: [{ match: 'search_route', name: true, hint: TOOL_HINT }] }));
  eq(
    '候选后到：同样的位置，提醒换成带「改成…」的',
    [before, all(m.box, 'button.sop-hint-fix').length, text(hints()[0]?.querySelector('.sop-hint-note'))],
    [0, 2, '模型只认2个工具名，写错的名字会被当成不存在，这条规则就不起作用了。'],
  );
  // 换了包：候选的中文名一样、原名不同，按钮跟着换
  const renamed = { ...TOOL_HINT, fix: { name: 'search_routes_v2', label: '查线路' } };
  await m.render(el({ value: DOC2, problems: [{ match: 'search_route', name: true, hint: renamed }] }));
  eq('候选只换了原名：按钮跟着换', text(m.box.querySelector('button.sop-hint-fix')), '改成search_routes_v2');
  const odd: EditorProblem[] = [{ match: 'zzz_tool', name: true, hint: { what: 'tool', known: 0, fix: null } }];
  await m.render(el({ value: '用 zzz_tool 查。\n', problems: odd }));
  eq(
    '没有候选：第一行只点名，没有按钮；不写个数',
    [
      text(hints()[0]?.querySelector('.sop-hint-title')),
      text(hints()[0]?.querySelector('.sop-hint-note')),
      hints()[0]?.querySelector('button') ?? null,
    ],
    ['提到了不存在的工具「zzz_tool」', '写错的名字会被当成不存在，这条规则就不起作用了。', null],
  );
  await m.render(el({ problems: PROBLEMS, readOnly: true }));
  eq('只读（固定规则、只读成员、409 停住）：提醒照画，没有按钮', [hints().length, all(m.box, 'button.sop-hint-fix').length], [3, 0]);
  await m.unmount();
}

// 10.3 整页：假服务端按正文算问题
/** 草稿：话术原则写错一个工具名、写了禁用短语；异议处理删掉了线上版本里的一句必需说法 */
const TONE_BAD = '- 先调 search_route 查线路。\n\n- 客户嫌贵时缩短天数重新报价。\n\n';
function withBodies(base: readonly SopSectionText[], bodies: Record<string, string>): SopSectionText[] {
  return base.map((s) => {
    const def = TRAVEL.find((d) => d.key === s.key)!;
    return bodies[s.key] === undefined ? s : { key: s.key, text: textFor(def, bodies[s.key]!) };
  });
}
const P_ONLINE = withBodies(PUBLISHED, { objections: '定价只有两条规则。\n\n' });
const D_BAD = withBodies(PUBLISHED, { tone: TONE_BAD, objections: '先共情。\n\n' });
const BAD_SOP: SopOverview = {
  published: version(2, P_ONLINE),
  draft: { ...version(null, D_BAD, { basedOn: 'v2', rev: 4, publishedAt: null, publishedByName: null }), stale: false },
  spec: SPEC,
  budget: { chars: editableChars(D_BAD, SPEC), limit: LIMIT },
};
const KNOWN_TOOLS = ['search_routes', 'generate_proposal', 'handoff_to_human'];
/** 按草稿的正文算问题（与服务端同样的认法：snake_case 的标识符不是工具名、禁用短语、必需说法）；over 给了就报超额 */
function scan(s: SopOverview, over: number | null = null): DraftCheck {
  const secs = s.draft!.sections;
  const violations: ContractViolation[] = [];
  for (const sec of secs) {
    for (const [name] of sec.text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g))
      if (!KNOWN_TOOLS.includes(name))
        violations.push({ code: 'unknown_tool', sectionKey: sec.key, detail: `「${name}」不是现有的工具名`, match: name });
    if (sec.text.includes('缩短天数重新报价'))
      violations.push({ code: 'phrase_forbidden', sectionKey: sec.key, detail: '不能出现', match: '缩短天数重新报价' });
  }
  if (!secs.some((x) => x.text.includes('定价只有两条规则')))
    violations.push({ code: 'phrase_missing', sectionKey: null, detail: '缺少', match: '定价只有两条规则' });
  const chars = over ?? editableChars(secs, SPEC);
  if (chars > LIMIT) violations.push({ code: 'over_budget', sectionKey: null, detail: '超了' });
  return {
    promptHash: 'b'.repeat(64),
    prefixHash: 'c'.repeat(64),
    chars,
    limit: LIMIT,
    violations,
    rebase: { needed: false, conflicts: [] },
  };
}
const travelOwner: Viewer = { ...OWNER, pack: { ...packOf(TRAVEL), vocabulary: { ...packOf(TRAVEL).vocabulary, ...VOCAB } } };
const cmOf = (m: PageBox): HTMLElement | null => m.box.querySelector<HTMLElement>('.sop-editor .cm-content');
const viewOf = (m: PageBox): EditorView => EditorView.findFromDOM(cmOf(m)!)!;
const selected = (m: PageBox): string => {
  const v = viewOf(m);
  const r = v.state.selection.main;
  return v.state.sliceDoc(r.from, r.to);
};
const checkCard = (m: PageBox): Element => m.box.querySelector('.sop-col-check')!;
const summaryOf = (m: PageBox): string => text(checkCard(m).querySelector('.check-list-summary'));
const metaOf = (m: PageBox): string => text(checkCard(m).querySelector('.check-list-meta'));
const itemOf = (m: PageBox, name: string): HTMLElement | undefined =>
  all<HTMLElement>(checkCard(m), '.check-item').find((i) => text(i.querySelector('.check-item-label')) === name);
const noteOf = (m: PageBox, name: string): string => text(itemOf(m, name)?.querySelector('.check-item-note'));
function recordScroll(): { calls: string[]; restore(): void } {
  const proto = win.Element.prototype as unknown as { scrollIntoView(this: Element, o?: unknown): void };
  const original = proto.scrollIntoView;
  const calls: string[] = [];
  proto.scrollIntoView = function (this: Element, o?: unknown) {
    calls.push(`${this.className} ${(o as { block?: string } | undefined)?.block}`);
  };
  return { calls, restore: () => void (proto.scrollIntoView = original) };
}

// 10.3a 打开时检查；清单、目录、中栏；点了定位；「改成…」以后马上存、再检查；打字不重渲清单、不重派问题
{
  const scroll = recordScroll();
  let clock = NOW;
  const srv = fakeServer(BAD_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=preamble', travelOwner, BAD_SOP, { ...FAST, debounce: 60_000, now: () => clock });
  await waitFor(() => summaryOf(m) !== '');
  eq(
    '打开时已有草稿：检查一次，4/7通过，下一行「每次自动保存都会跑 · 上次14:30」',
    [srv.checks(), summaryOf(m), metaOf(m)],
    [1, '4/7通过', '每次自动保存都会跑·上次14:30'],
  );
  eq(
    '没过的项写处数和节（必需说法落在线上版本里含这句的节）；没过的整行是按钮，通过的不是',
    [
      ['必备短语都在', '没有禁用短语', '工具名都存在'].map((l) => noteOf(m, l)),
      [itemOf(m, '工具名都存在')?.tagName, itemOf(m, '结构完整')?.tagName],
    ],
    [
      ['1处·异议处理', '1处·话术原则', '1处·话术原则'],
      ['BUTTON', 'DIV'],
    ],
  );
  const pct = noteOf(m, '字数在额度内');
  check(
    '「字数在额度内」写百分比，与额度条上的同一个数',
    /^\d+%$/.test(pct) && text(m.box.querySelector('.sop-quota-line')).includes(`·${pct}·`),
    pct,
  );
  eq(
    '目录：话术原则 2 个问题，异议处理 1 个（必需说法按线上版本落的节）',
    [text(rowIn(m, 'tone')?.querySelector('.sop-toc-issue')), text(rowIn(m, 'objections')?.querySelector('.sop-toc-issue'))],
    ['2个问题', '1个问题'],
  );
  eq(
    '当前节（前言）没有问题：没有波浪线、提醒、说明',
    [all(m.box, '.sop-bad').length, all(m.box, '.sop-hint-wrap').length, m.box.querySelector('.sop-notes')],
    [0, 0, null],
  );

  const len = historyLength(m);
  await clickEv(itemOf(m, '工具名都存在'));
  await until(() => m.section() === 'tone' && selected(m) === 'search_route');
  eq(
    '点「工具名都存在」：切到话术原则（进浏览历史），选中写错的名字，焦点在正文上',
    [m.section(), historyLength(m), selected(m), document.activeElement === cmOf(m)],
    ['tone', len + 1, 'search_route', true],
  );
  eq(
    '话术原则：写错的名字与禁用短语画波浪线',
    all(m.box, '.sop-bad').map((e) => e.textContent),
    ['search_route', '缩短天数重新报价'],
  );
  eq(
    '写错的名字那一段之后插行内提醒，候选取行业包的词汇',
    [text(m.box.querySelector('.sop-hint-title')), text(m.box.querySelector('.sop-hint-note')), text(m.box.querySelector('.sop-hint-fix'))],
    [
      '提到了不存在的工具「search_route」，是不是「查线路search_routes」？',
      '模型只认2个工具名，写错的名字会被当成不存在，这条规则就不起作用了。',
      '改成search_routes',
    ],
  );
  eq(
    '禁用短语的说明写在编辑卡片上方',
    all(m.box, '.sop-notes .sop-note').map((e) => text(e)),
    ['「缩短天数重新报价」不能出现在话术里'],
  );
  await clickEv(itemOf(m, '没有禁用短语'));
  await until(() => selected(m) === '缩短天数重新报价');
  eq('已经在这一节：点「没有禁用短语」不进浏览历史，选中禁用短语', [historyLength(m), selected(m)], [len + 1, '缩短天数重新报价']);

  scroll.calls.length = 0;
  await clickEv(itemOf(m, '必备短语都在'));
  await until(() => m.section() === 'objections' && document.activeElement === cmOf(m));
  eq(
    '点「必备短语都在」：切到线上版本里含这句的节，卡片上方写要保留哪句、滚过去，焦点在正文上',
    [m.section(), all(m.box, '.sop-notes .sop-note').map((e) => text(e)), scroll.calls, document.activeElement === cmOf(m)],
    ['objections', ['要保留这句：「定价只有两条规则」'], ['sop-notes nearest'], true],
  );

  await clickEv(rowIn(m, 'tone'));
  await until(() => m.section() === 'tone' && !!m.box.querySelector('.sop-hint-fix'));
  // 打字（还没存）：右栏清单（memo）不重渲，编辑器里的问题不重派
  const cardProps = (): unknown => currentNamed(checkCard(m), 'CheckCard')[0]?.memoizedProps;
  const p0 = cardProps();
  const probs0 = viewOf(m).state.field(problemsField).problems;
  await act(async () => viewOf(m).dispatch({ changes: { from: 0, insert: '甲' }, userEvent: 'input.type' }));
  await settle();
  eq(
    '打字（还没存）：检查清单不重渲，编辑器里的问题不重派',
    [p0 !== undefined && cardProps() === p0, viewOf(m).state.field(problemsField).problems === probs0],
    [true, true],
  );

  clock = NOW + 60_000;
  const puts = srv.puts().length;
  await clickEv(m.box.querySelector('.sop-hint-fix'));
  await waitFor(() => srv.puts().length === puts + 1);
  const body = srv.puts().at(-1)?.edits[0]?.body ?? '';
  eq(
    '「改成search_routes」：不等 60 秒的防抖，马上存，带换好的正文',
    [
      srv
        .puts()
        .at(-1)
        ?.edits.map((e) => e.key),
      body.includes('search_routes 查线路'),
      body.includes('search_route '),
    ],
    [['tone'], true, false],
  );
  eq(
    '换好以后：提醒没了，只剩禁用短语的波浪线，焦点在正文上',
    [all(m.box, '.sop-hint-wrap').length, all(m.box, '.sop-bad').map((e) => e.textContent), document.activeElement === cmOf(m)],
    [0, ['缩短天数重新报价'], true],
  );
  await waitFor(() => summaryOf(m) === '5/7通过');
  eq(
    '存上以后再检查一次：工具名都存在通过了，「上次」跟着更新',
    [srv.checks(), summaryOf(m), itemOf(m, '工具名都存在')?.classList.contains('check-item-pass'), metaOf(m)],
    [2, '5/7通过', true, '每次自动保存都会跑·上次14:31'],
  );
  scroll.restore();
  await m.unmount();

  // 超了额度：「字数在额度内」写「超出N字」，点了滚到额度条、焦点落在它上面
  const over = fakeServer(BAD_SOP);
  over.check = (s) => scan(s, LIMIT + 42);
  const scroll2 = recordScroll();
  const o = await mountPage('/console/sop?section=tone', travelOwner, BAD_SOP, FAST);
  await waitFor(() => summaryOf(o) !== '');
  eq('超了额度：写「超出42字」', [summaryOf(o), noteOf(o, '字数在额度内')], ['3/7通过', '超出42字']);
  await clickEv(itemOf(o, '字数在额度内'));
  await settle();
  const quota = o.box.querySelector('.sop-quota');
  eq(
    '点「字数在额度内」：滚到额度条，焦点落在它上面（不在 Tab 顺序里），不换节',
    [scroll2.calls.map((c) => c.split(' ').at(-1)), document.activeElement === quota, quota?.getAttribute('tabindex'), o.section()],
    [['nearest'], true, '-1', 'tone'],
  );
  scroll2.restore();
  await o.unmount();
}

// 10.3b 没跑成与重试；有结果以后又没跑成，上一次的留着；两次检查都在路上时只认后发的
{
  const srv = fakeServer(BAD_SOP);
  srv.check = (s) => scan(s);
  srv.checkFails = true;
  const m = await mountPage('/console/sop?section=tone', travelOwner, BAD_SOP, FAST);
  await waitFor(() => metaOf(m).includes('没检查上'));
  eq(
    '打开时没跑成：7 项还没跑，下一行写 danger 的「没检查上 · 重试」',
    [all(checkCard(m), '.check-item-pending').length, metaOf(m), !!checkCard(m).querySelector('.sop-check-failed button')],
    [7, '每次自动保存都会跑·没检查上·重试', true],
  );
  srv.checkFails = false;
  await clickEv(checkCard(m).querySelector('.sop-check-failed button'));
  await waitFor(() => summaryOf(m) !== '');
  eq('点「重试」：再跑一次，跑成了', [srv.checks(), summaryOf(m), metaOf(m)], [2, '4/7通过', '每次自动保存都会跑·上次14:30']);
  srv.checkFails = true;
  await typeAtEnd(m, '甲');
  await waitFor(() => metaOf(m).includes('没检查上'));
  eq(
    '存上以后没跑成：上一次的结果留着，写「没检查上」',
    [srv.checks(), summaryOf(m), metaOf(m)],
    [3, '4/7通过', '每次自动保存都会跑·没检查上·重试'],
  );

  srv.checkFails = false;
  srv.checkHold = true;
  await typeAtEnd(m, '乙');
  await waitFor(() => srv.checks() === 4);
  const v = viewOf(m);
  const at = v.state.doc.toString().indexOf('search_route ');
  await act(async () => v.dispatch({ changes: { from: at, to: at + 12, insert: 'search_routes' }, userEvent: 'input.type' }));
  await waitFor(() => srv.checks() === 5);
  srv.checkHold = false;
  await act(async () => srv.checkHeld[1]?.resolve());
  await waitFor(() => summaryOf(m) === '5/7通过');
  await act(async () => srv.checkHeld[0]?.resolve());
  await rest(60);
  eq(
    '两次检查都在路上：后发的（改好以后的草稿）先回来就用它，先发的晚回来也不认',
    [summaryOf(m), itemOf(m, '工具名都存在')?.classList.contains('check-item-pass'), metaOf(m)],
    ['5/7通过', true, '每次自动保存都会跑·上次14:30'],
  );
  await m.unmount();
}

// 10.3c 没有草稿不检查，第一次存上以后查；丢弃以后清掉；只读成员不查；409 停住时提醒没有「改成…」
{
  const noDraft: SopOverview = { ...BAD_SOP, published: version(2, D_BAD), draft: null };
  const srv = fakeServer(noDraft);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, noDraft, FAST);
  await rest(100);
  eq(
    '没有草稿：不检查，7 项还没跑',
    [srv.checks(), all(checkCard(m), '.check-item-pending').length, metaOf(m)],
    [0, 7, '每次自动保存都会跑'],
  );
  await typeAtEnd(m, '甲');
  await waitFor(() => summaryOf(m) !== '');
  eq(
    '第一次存上（新建了草稿）以后检查；线上版本里也没有那句必需说法：不落在节上，只写处数',
    [srv.checks(), summaryOf(m), noteOf(m, '必备短语都在'), all(m.box, '.sop-hint-wrap').length],
    [1, '4/7通过', '1处', 1],
  );
  eq('这一项没有去处：整行不是按钮', itemOf(m, '必备短语都在')?.tagName, 'DIV');
  const modal = (title: string): Element | undefined =>
    all(document.body, '.ant-modal').find((x) => text(x.querySelector('.ant-modal-title')) === title);
  await waitFor(() => !headerButton(m, '丢弃')?.disabled);
  await clickEv(headerButton(m, '丢弃'));
  await until(() => !!modal('丢弃草稿？'));
  await clickEv(all(modal('丢弃草稿？')!, 'button').find((b) => label(b) === '丢弃草稿'));
  await waitFor(() => text(m.box.querySelector('.page-status')).includes('没有未发布的改动'));
  await settle();
  eq(
    '丢弃以后：草稿没了，清单回到还没跑，波浪线、提醒都没了，不再检查',
    [
      summaryOf(m),
      all(checkCard(m), '.check-item-pending').length,
      all(m.box, '.sop-bad').length,
      all(m.box, '.sop-hint-wrap').length,
      srv.checks(),
    ],
    ['', 7, 0, 0, 1],
  );
  await m.unmount();

  const reader = fakeServer(BAD_SOP);
  const agent: Viewer = { ...travelOwner, me: { ...(travelOwner as Extract<Viewer, { kind: 'member' }>).me, role: 'agent' } };
  const r = await mountPage('/console/sop?section=tone', agent, BAD_SOP, FAST);
  await rest(100);
  eq(
    '只读成员：不检查，没有清单、波浪线和提醒',
    [reader.checks(), r.box.querySelector('.sop-col-check'), all(r.box, '.sop-bad').length],
    [0, null, 0],
  );
  await r.unmount();

  const frozen = fakeServer(BAD_SOP);
  frozen.check = (s) => scan(s);
  frozen.mode = 'conflict';
  const f = await mountPage('/console/sop?section=tone', travelOwner, BAD_SOP, FAST);
  await waitFor(() => !!f.box.querySelector('.sop-hint-fix'));
  await typeAtEnd(f, '甲');
  await waitFor(() => editorEditable(f) === 'false');
  eq(
    '409 停住（编辑器只读）：提醒照写，没有「改成…」',
    [all(f.box, '.sop-hint-wrap').length, f.box.querySelector('.sop-hint-fix')],
    [1, null],
  );
  await f.unmount();
}
// 10.3d 只认该认的结果：回滚以后（草稿的 rev 没变、线上换了）再查；两次都在路上时先发的晚回来没跑成，不把后发的成功说成
// 「没检查上」；丢弃时还在路上的检查回来也不认
{
  const modal = (title: string): Element | undefined =>
    all(document.body, '.ant-modal').find((x) => text(x.querySelector('.ant-modal-title')) === title);
  const status = (m: PageBox): string => text(m.box.querySelector('.page-status'));

  const srv = fakeServer(BAD_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, BAD_SOP, FAST);
  await act(async () =>
    m.qc.setQueryData(['sop-versions'], { pages: [{ items: [BAD_SOP.published, version(1, P_ONLINE)] }], pageParams: [undefined] }),
  );
  await waitFor(() => summaryOf(m) !== '');
  const rollbackButton = (): HTMLButtonElement | undefined =>
    all<HTMLButtonElement>(m.box, '.sop-after button').find((b) => label(b) === '以此版本回滚');
  await waitFor(() => !!rollbackButton());
  await clickEv(rollbackButton());
  await until(() => !!modal('回滚到v1')?.querySelector('textarea'));
  const note = modal('回滚到v1')!.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(note, '退回去');
    note.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  });
  await clickEv(all(modal('回滚到v1')!, '.ant-modal-footer button').find((b) => label(b) === '回滚到v1'));
  await waitFor(() => srv.checks() === 2);
  eq(
    '回滚以后：草稿没存过（rev 还是 4），线上换成 v3，再检查一次',
    [srv.checks(), srv.puts().length, srv.state.draft?.rev, status(m).startsWith('线上v3')],
    [2, 0, 4, true],
  );
  await m.unmount();

  let clock = NOW;
  const late = fakeServer(BAD_SOP);
  late.check = (s) => scan(s);
  const l = await mountPage('/console/sop?section=tone', travelOwner, BAD_SOP, { ...FAST, now: () => clock });
  await waitFor(() => summaryOf(l) !== '');
  late.checkHold = true;
  await typeAtEnd(l, '甲');
  await waitFor(() => late.checks() === 2);
  await typeAtEnd(l, '乙');
  await waitFor(() => late.checks() === 3);
  clock = NOW + 60_000;
  await act(async () => late.checkHeld[1]?.resolve());
  await waitFor(() => metaOf(l) === '每次自动保存都会跑·上次14:31');
  late.checkFails = true;
  await act(async () => late.checkHeld[0]?.resolve());
  await rest(60);
  eq(
    '后发的先跑成，先发的晚回来没跑成：不认，不写「没检查上」',
    [metaOf(l), summaryOf(l), !!checkCard(l).querySelector('.sop-check-failed')],
    ['每次自动保存都会跑·上次14:31', '4/7通过', false],
  );
  await l.unmount();

  const gone = fakeServer(BAD_SOP);
  gone.check = (s) => scan(s);
  gone.checkHold = true;
  const g = await mountPage('/console/sop?section=tone', travelOwner, BAD_SOP, FAST);
  await waitFor(() => gone.checks() === 1);
  await waitFor(() => !headerButton(g, '丢弃')?.disabled);
  await clickEv(headerButton(g, '丢弃'));
  await until(() => !!modal('丢弃草稿？'));
  await clickEv(all(modal('丢弃草稿？')!, 'button').find((b) => label(b) === '丢弃草稿'));
  await waitFor(() => status(g).includes('没有未发布的改动'));
  await act(async () => gone.checkHeld[0]?.resolve());
  await rest(60);
  eq(
    '丢弃时还在路上的检查：回来了也不认，清单仍是 7 个还没跑，没有波浪线',
    [summaryOf(g), all(checkCard(g), '.check-item-pending').length, all(g.box, '.sop-bad').length, gone.checks()],
    ['', 7, 0, 1],
  );
  await g.unmount();
}

// 10.3e 草稿跟不上线上版本（basedOn 不是线上版本）：只有一条提示。/sop 的 draft.stale 与检查的 rebase.needed 是同一个条件，
// 检查回来之前按 draft.stale 写 info；回来以后没有冲突的节照旧是这一条，有冲突的节换成出错色的「发布不了」
{
  const stale: SopOverview = { ...BAD_SOP, published: version(3, P_ONLINE), draft: { ...BAD_SOP.draft!, stale: true } };
  const notices = (m: PageBox): string[] =>
    all(m.box, '.sop-notices .ant-alert').map((a) => `${/ant-alert-(\w+)/.exec(a.className)?.[1]}：${text(a)}`);
  const MERGE = 'info：草稿打开之后发布过新版本，发布时自动合并';
  for (const conflicts of [[], ['tone']]) {
    const srv = fakeServer(stale);
    // 后面要去发布：问题清空，发布条的「发布…」能点（提示只看 rebase）
    srv.check = (s) => ({ ...scan(s), violations: [], rebase: { needed: true, conflicts } });
    srv.checkHold = true;
    const m = await mountPage('/console/sop?section=tone', travelOwner, stale, FAST);
    await waitFor(() => srv.checks() === 1);
    const before = notices(m);
    await act(async () => srv.checkHeld[0]?.resolve());
    await waitFor(() => summaryOf(m) !== '');
    eq(
      `打开一份过期的草稿（${conflicts.length ? '有' : '没有'}冲突的节）：检查回来前后各只有一条提示`,
      [before, notices(m)],
      [
        [MERGE],
        conflicts.length
          ? [
              'error：这几节在你编辑期间被别人改过：话术原则。' +
                '这份草稿已经发布不了：先把你的改动复制出来，丢弃草稿，再在当前版本上重做。',
            ]
          : [MERGE],
      ],
    );
    if (conflicts.length) {
      // 检查报了冲突的节：发布抽屉里写出来，「发布」不能点
      srv.checkHold = false;
      await clickEv(barButton(m, '发布…'));
      await waitFor(
        () =>
          !!drawerOf('发布草稿') && srv.checks() === 2 && text(drawerOf('发布草稿')!.querySelector('.sop-drawer-reason')) !== '正在检查…',
      );
      const d = drawerOf('发布草稿')!;
      eq(
        '检查报了冲突的节：发布抽屉里说哪几节被改了，「发布」不能点、旁边写原因',
        [
          text(d.querySelector('.sop-publish .ant-alert-title')),
          text(d.querySelector('.sop-drawer-reason')),
          all(d, '.ant-drawer-footer button')
            .find((b) => label(b) === '发布')
            ?.getAttribute('aria-disabled'),
        ],
        ['有1节在你改的同时被改了：话术原则', '有1节被别人改过，发布不了', 'true'],
      );
      await clickEv(all(d, '.ant-drawer-footer button').find((b) => label(b) === '取消'));
      await waitFor(() => !drawerOf('发布草稿'));
    } else {
      // 检查说能合并，发布时撞上冲突（409，这期间别人又发布了）：抽屉关上，由发布被拒的那一条说，合并提示不再重复
      srv.publishConflict = { keys: ['tone'], current: P_ONLINE };
      srv.checkHold = false;
      await publishVia(m, '改了话术原则');
      await waitFor(() => notices(m).some((n) => n.includes('发布被拒')));
      eq(
        '发布撞上冲突（409）：抽屉关上，只有发布被拒的那一条',
        [notices(m).map((n) => n.split('——')[0]), !!drawerOf('发布草稿')],
        [['error：发布被拒：这几节在你编辑期间被别人改过'], false],
      );
    }
    await m.unmount();
  }
}
// ---------------- 11. 发布（第 6.3 步） ----------------
// 11.1 纯函数：行数、摘要、「发布…」与抽屉里「发布」不能点的原因、第一个问题、替换说明、预填与「再写至少一个字」、
// 逐节改动取哪几节、行内 / 并排的存取
{
  eq('改了一行里的字：+1行 −1行', lineStat('甲\n乙\n丙\n', '甲\n乙二\n丙\n'), { added: 1, removed: 1 });
  eq('末尾另起一行：只有 +1行', lineStat('甲\n乙\n', '甲\n乙\n丙\n'), { added: 1, removed: 0 });
  eq('删掉中间两行：只有 −2行', lineStat('一\n二\n三\n四\n', '一\n四\n'), { added: 0, removed: 2 });
  eq('隔开的两处各算', lineStat('一\n二\n三\n四\n五\n六\n七\n八\n', '一改\n二\n三\n四\n五\n六\n七\n八改\n'), { added: 2, removed: 2 });
  eq('一样：都是 0', lineStat('甲\n', '甲\n'), { added: 0, removed: 0 });
  eq(
    '节标题行的「+3行 −1行」：没有的一边不写，数字带千位分隔',
    [
      statText({ added: 3, removed: 1 }),
      statText({ added: 1, removed: 0 }),
      statText({ added: 0, removed: 2 }),
      statText({ added: 1200, removed: 0 }),
    ],
    ['+3行 −1行', '+1行', '−2行', '+1,200行'],
  );
  eq(
    '「发布…」不能点的原因按先后：409 停住、没有改动、有问题（只有有问题时点它跳过去）；都没有就能点',
    [
      barBlock({ frozen: true, changed: 0, problems: 3 }),
      barBlock({ frozen: false, changed: 0, problems: 3 }),
      barBlock({ frozen: false, changed: 2, problems: 1 }),
      barBlock({ frozen: false, changed: 2, problems: 0 }),
    ],
    [
      { reason: '载入最新草稿以后才能发布', jump: false },
      { reason: '没有可发布的改动', jump: false },
      { reason: '改完1个问题即可发布', jump: true },
      null,
    ],
  );
  const probs = locateViolations(
    [
      { code: 'unknown_tool', sectionKey: 'tone', match: 'search_route' },
      { code: 'structure', sectionKey: null },
      { code: 'phrase_missing', sectionKey: null, match: '定价只有两条规则' },
    ],
    P_ONLINE,
  );
  eq('第一个问题按清单的顺序，跳过没有去处的（结构不对落不到节上）', firstProblem(probs), { kind: 'section', section: 'objections' });
  eq(
    '只有落不到节上的：没有；只有额度：去额度条',
    [
      firstProblem(locateViolations([{ code: 'structure', sectionKey: null }], P_ONLINE)),
      firstProblem(locateViolations([{ code: 'over_budget', sectionKey: null }], P_ONLINE)),
    ],
    [null, { kind: 'quota' }],
  );
  eq(
    '同一项里先有落不到节上的、后有能去的：去后面那一处，不跳到清单的下一项',
    firstProblem(
      locateViolations(
        [
          { code: 'structure', sectionKey: null },
          { code: 'structure', sectionKey: 'tone' },
          { code: 'unknown_tool', sectionKey: 'tone', match: 'search_route' },
        ],
        P_ONLINE,
      ),
    ),
    { kind: 'section', section: 'tone' },
  );
  eq(
    '摘要与发布成功的那句（只动了空白时不写括号）',
    [
      changedText(['话术原则', '异议处理']),
      publishedText({ versionNo: 3, names: ['话术原则'] }),
      publishedText({ versionNo: 3, names: [] }),
    ],
    ['草稿改了2节（话术原则、异议处理）', '已发布v3（改了话术原则）', '已发布v3'],
  );
  const head = { versionNo: 2, publishedAt: '2026-09-25T10:30:00Z', publishedByName: '老板', source: 'console' as const };
  eq(
    '替换说明：发布人 · 时间；没有名字按来源写；不是今年的写年份',
    [
      replaceLine(head, NOW),
      replaceLine({ ...head, versionNo: 1, publishedByName: null, source: 'import', publishedAt: '2026-09-24T02:02:00Z' }, NOW),
      replaceLine({ ...head, publishedAt: '2025-12-31T02:00:00Z' }, NOW)[1],
    ],
    [['将替换线上v2（老板', '9月25日 18:30发布）'], ['将替换线上v1（9月24日 10:02导入）'], '2025年12月31日 10:00发布）'],
  );
  const pre = notePrefill(['话术原则', '异议处理']);
  eq('变更说明的预填；没有改过的节不预填', [pre, notePrefill([])], ['修改：话术原则、异议处理。', '']);
  eq(
    '只有预填、删掉了预填末尾的字、空着、只加了空白、没有预填时空着：不能交',
    [noteReady(pre, pre), noteReady('修改：话术原则', pre), noteReady('', pre), noteReady(`${pre}  \n`, pre), noteReady(' \n', '')],
    [false, false, false, false, false],
  );
  eq(
    '预填后面写了字、改写了预填、从头自己写：能交',
    [noteReady(`${pre}客户嫌贵`, pre), noteReady('修改：异议处理。', pre), noteReady('先问预算', pre), noteReady('一', '')],
    [true, true, true, true],
  );
  const ok = { running: false, failed: false, conflicts: 0, problems: 0, noteReady: true };
  eq(
    '抽屉里「发布」不能点的原因按先后：正在检查、没检查上、有冲突的节、有问题、说明没写；都没有就能点',
    [
      drawerBlock({ running: true, failed: true, conflicts: 1, problems: 2, noteReady: false }),
      drawerBlock({ ...ok, failed: true, conflicts: 1, problems: 2, noteReady: false }),
      drawerBlock({ ...ok, conflicts: 2, problems: 2, noteReady: false }),
      drawerBlock({ ...ok, problems: 2, noteReady: false }),
      drawerBlock({ ...ok, noteReady: false }),
      drawerBlock(ok),
    ],
    [
      { reason: '正在检查…', focus: null },
      { reason: '没检查上，重试以后再发布', focus: 'checks' },
      { reason: '有2节被别人改过，发布不了', focus: null },
      { reason: '改完2个问题即可发布', focus: 'checks' },
      { reason: '在说明里写上为什么改', focus: 'note' },
      null,
    ],
  );
  const ch = changedSections(SPEC, PUBLISHED, DRAFT, {});
  eq(
    '逐节改动：只列改过的可编辑节，按节表的顺序，前后都是去掉标题行的正文',
    ch.map((c) => [c.key, c.name, c.before === bodyIn(PUBLISHED, c.key), c.after === bodyIn(DRAFT, c.key)]),
    [
      ['tone', '话术原则', true, true],
      ['objections', '异议处理', true, true],
    ],
  );
  eq(
    '本地还没存上的改动也算：改回原样（只多行尾空格）不算，固定规则节不算，前言在最前',
    changedSections(SPEC, PUBLISHED, DRAFT, {
      tone: bodyIn(PUBLISHED, 'tone').replace(/\n\n$/, '   \n\n'),
      stages: '改了固定规则\n\n',
      preamble: `${bodyIn(PUBLISHED, 'preamble')}再加一句\n\n`,
    }).map((c) => [c.key, c.name, c.after.includes('再加一句')]),
    [
      ['preamble', '前言', true],
      ['objections', '异议处理', false],
    ],
  );
  eq('节末的空行只留一个换行', trimEnd({ key: 'a', name: '甲', before: '旧\n\n', after: '新\n' }), {
    key: 'a',
    name: '甲',
    before: '旧\n',
    after: '新\n',
  });

  localStorage.removeItem(DIFF_MODE_KEY);
  const fresh = readDiffMode();
  writeDiffMode('split');
  const stored = [readDiffMode(), localStorage.getItem(DIFF_MODE_KEY)];
  localStorage.setItem(DIFF_MODE_KEY, 'side');
  const junk = readDiffMode();
  const desc = Object.getOwnPropertyDescriptor(win, 'localStorage');
  Object.defineProperty(win, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  let blocked: string = '';
  let threw = false;
  try {
    blocked = readDiffMode();
    writeDiffMode('split');
  } catch {
    threw = true;
  }
  if (desc) Object.defineProperty(win, 'localStorage', desc);
  else delete (win as unknown as Record<string, unknown>).localStorage;
  eq(
    '行内 / 并排：默认行内，存了并排就读出并排，认不得的按行内；存储被禁用时读按行内、写不抛错',
    [fresh, stored, junk, blocked, threw],
    ['inline', ['split', 'split'], 'inline', 'inline', false],
  );
  localStorage.removeItem(DIFF_MODE_KEY);
}

// 11.2 差异的样子：行内是一个编辑器（unifiedMergeView，没有逐块采用的按钮、没有改动沟槽），并排是左右两个；没改的折叠、写中文；
// 节末的空行不画；换显示方式才重建，同样的内容重渲不重建。@codemirror/merge 自带的红绿色都被 sop.css 盖掉
{
  const same = Array.from({ length: 20 }, (_, i) => `第${i + 1}行`).join('\n');
  const tail = '结尾一\n结尾二\n结尾三\n结尾四';
  // 三处改动：行里插半句、行里删几个字、末行换掉再加一行；中间隔着 4 行没改的（不够折叠）
  const c = {
    key: 'tone',
    name: '话术原则',
    before: `${same}\n先回应一句，再谈线路。\n${tail}\n客户嫌贵，别连发，先问预算。\n${tail}\n旧的一行\n\n`,
    after: `${same}\n先回应一句，一句就够，再谈线路。\n${tail}\n客户嫌贵，先问预算。\n${tail}\n新的一行\n再加一行\n\n`,
  };
  const el = (mode: 'inline' | 'split') => <DiffList items={[c]} mode={mode} labels={['线上v2', '草稿']} />;
  const d = await rootFor(el('inline'));
  const views = (): EditorView[] => all<HTMLElement>(d.box, '.cm-content').map((e) => EditorView.findFromDOM(e)!);
  eq(
    '节标题行：节名与「+4行 −3行」（行里的改动算 +1 −1，节末的空行不算）',
    [text(d.box.querySelector('.sop-diff-name')), text(d.box.querySelector('.sop-diff-stat'))],
    ['话术原则', '+4行 −3行'],
  );
  const inline = views();
  eq(
    '行内：一个编辑器，正文是草稿（去掉节末的空行），读屏名称写哪一节的改动',
    [
      inline.length,
      inline[0]?.state.doc.toString() === c.after.replace(/\n+$/, '\n'),
      d.box.querySelector('.cm-content')?.getAttribute('aria-label'),
    ],
    [1, true, '「话术原则」的改动'],
  );
  eq(
    '行内：行里的小改动写在行里（删掉的字、新加的字），换掉的行先写删掉的整行、再写新的；没改的折叠成「18行没有改动」',
    [
      all(d.box, '.cm-inlineChangedLine').length,
      all(d.box, '.cm-inlineChangedLine .cm-changedText').map((e) => e.textContent),
      all(d.box, '.cm-line .cm-deletedText').map((e) => e.textContent),
      all(d.box, 'div.cm-deletedLine').map((e) => text(e)),
      all(d.box, '.cm-changedLine').map((e) => text(e)),
      all(d.box, '.cm-collapsedLines').map((e) => text(e)),
    ],
    [2, ['一句就够，'], ['别连发，'], ['旧的一行'], ['新的一行', '再加一行'], ['18行没有改动']],
  );
  eq(
    '只看不改：没有逐块采用、不采用的按钮，没有改动沟槽，正文不能编辑',
    [
      all(d.box, '.cm-chunkButtons, .cm-merge-revert').length,
      all(d.box, '.cm-gutters, .cm-changeGutter').length,
      d.box.querySelector('.cm-content')?.getAttribute('contenteditable'),
    ],
    [0, 0, 'false'],
  );
  await d.render(el('inline'));
  eq('同样的内容重渲：不重建编辑器', views()[0] === inline[0], true);
  await d.render(el('split'));
  const split = views();
  eq(
    '并排：左右两个编辑器，左边线上、右边草稿，上方写两边的名字，读屏名称写哪一节哪一边',
    [
      d.box.querySelectorAll('.cm-mergeView').length,
      split.map((v) => v.state.doc.toString().split('\n').at(-2)),
      all(d.box, '.sop-diff-cols span').map((e) => text(e)),
      all(d.box, '.cm-content').map((e) => e.getAttribute('aria-label')),
      all(d.box, '.cm-collapsedLines').map((e) => text(e)),
    ],
    [1, ['旧的一行', '再加一行'], ['线上v2', '草稿'], ['「话术原则」线上v2', '「话术原则」草稿'], ['18行没有改动', '18行没有改动']],
  );
  await d.unmount();

  // @codemirror/merge 的 baseTheme 里带颜色的规则（红色的删除、绿色的新增、浅色的折叠行与沟槽），sop.css 在 .sop-diff .sop-diff-view 下
  // 都要盖掉同一个类的同一项；沟槽整个不画。.sop-diff 下的颜色只用令牌（var(--…)）
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve('@codemirror/merge'), 'utf8');
  const theme = src.slice(src.indexOf('EditorView.baseTheme({'), src.indexOf('const collapseCompartment'));
  const colored = new Map<string, Set<string>>();
  for (const m of theme.matchAll(/"([^"]+)":\s*\{([^{}]*)\}/g)) {
    const props = [...m[2]!.matchAll(/(\w+):\s*"([^"]*)"/g)].filter(([, , v]) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(v!)).map(([, p]) => p!);
    if (!props.length) continue;
    for (const sel of m[1]!.split(',')) {
      const subject = sel.trim().match(/cm-[A-Za-z]+$/)?.[0];
      if (!subject) continue;
      const set = colored.get(subject) ?? new Set<string>();
      for (const p of props) set.add(p === 'color' ? 'color' : 'background');
      colored.set(subject, set);
    }
  }
  check(
    '在 @codemirror/merge 的主题里找到了带颜色的类',
    ['cm-changedLine', 'cm-deletedChunk', 'cm-deletedText', 'cm-changedText', 'cm-collapsedLines', 'cm-inlineChangedLine'].every((k) =>
      colored.has(k),
    ),
    [...colored.keys()].join(' '),
  );
  const css = readFileSync(new URL('./sop.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sels: m[1]!.split(',').map((x) => x.trim()), body: m[2]! }))
    .filter((r) => r.sels.some((x) => x.startsWith('.sop-diff')));
  const missing: string[] = [];
  for (const [cls, props] of colored) {
    if (cls.endsWith('Gutter')) {
      if (!rules.some((r) => r.sels.includes('.sop-diff .sop-diff-view .cm-gutters') && /display:\s*none/.test(r.body))) missing.push(cls);
      continue;
    }
    for (const p of props) {
      const decl = p === 'color' ? /(^|[;\s])color:/ : /(^|[;\s])background(-color)?:/;
      const hit = rules.some(
        (r) =>
          r.sels.some((x) => x.startsWith('.sop-diff .sop-diff-view') && new RegExp(`\\.${cls}(::?[a-z-]+)?$`).test(x)) &&
          decl.test(r.body),
      );
      if (!hit) missing.push(`${cls} ${p}`);
    }
  }
  eq('@codemirror/merge 带颜色的每一类都在 .sop-diff 下盖掉了', missing, []);
  eq(
    '.sop-diff 下的颜色只用令牌，不写死颜色',
    rules.filter((r) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(r.body)).map((r) => r.sels.join(', ')),
    [],
  );
  check(
    '删除行：--subtle 底、text-2、1.5px 删除线，行首「−」；新增行 --success-bg 底、行首 --success 的「+」；读屏念「删去：」「发出：」',
    /content:\s*'−'\s*\/\s*'删去：'/.test(css) &&
      /content:\s*'\+'\s*\/\s*'发出：'/.test(css) &&
      /div\.cm-deletedLine,\s*\.sop-diff[^{]*\{[^}]*background:\s*var\(--subtle\);[^}]*color:\s*var\(--text-2\)/.test(css) &&
      /text-decoration-thickness:\s*1\.5px/.test(css) &&
      /cm-merge-b \.cm-changedLine\s*\{[^}]*background:\s*var\(--success-bg\)/.test(css),
  );
}

// 11.2b 抽屉收起的那一下照关上那一刻画（useShownWhileClosing）：发布成功以后线上已经是 v3，收起动画里不闪成「将替换线上v3」。
// happy-dom 没有动画，抽屉一关就卸下，整页测不到这一下，这里直接测钩子
{
  let set: (p: { open: boolean; label: string }) => void = () => {};
  function Shown() {
    const [p, setP] = useState({ open: true, label: '将替换线上v2' });
    useEffect(() => {
      set = setP;
    }, []);
    const shown = useShownWhileClosing(p);
    return <span>{`${shown.open}|${shown.label}`}</span>;
  }
  const r = await mount(<Shown />);
  await act(async () => set({ open: true, label: '将替换线上v2（改了说明）' }));
  const a = text(r.box);
  await act(async () => set({ open: false, label: '将替换线上v3' }));
  const b = text(r.box);
  await act(async () => set({ open: true, label: '将替换线上v3' }));
  eq(
    '开着时跟着变；关上以后留着最后一次开着的样子（open 是 false）；再打开换成新的',
    [a, b, text(r.box)],
    ['true|将替换线上v2（改了说明）', 'false|将替换线上v2（改了说明）', 'true|将替换线上v3'],
  );
  await r.unmount();
}

// 11.3 整页：发布条、发布抽屉、查看改动、回滚到v2
/** 草稿：话术原则、异议处理各改了一处，检查全过 */
const D_CLEAN = withBodies(P_ONLINE, {
  tone: '- 先调 search_routes 查线路。\n\n',
  objections: '定价只有两条规则。\n\n- 先问预算上限。\n\n',
});
const CLEAN_SOP: SopOverview = {
  published: version(2, P_ONLINE),
  draft: { ...version(null, D_CLEAN, { basedOn: 'v2', rev: 4, publishedAt: null, publishedByName: null }), stale: false },
  spec: SPEC,
  budget: { chars: editableChars(D_CLEAN, SPEC), limit: LIMIT },
};
const barText = (m: PageBox): { summary: string; hint: string; note: string } => ({
  summary: text(publishBar(m)?.querySelector('.action-bar-summary')),
  hint: text(publishBar(m)?.querySelector('.action-bar-hint')),
  note: text(publishBar(m)?.querySelector('.action-bar-note')),
});
/** 按钮的 aria-describedby 指的那段字 */
const describedBy = (b: Element | undefined): string | null => {
  const id = b?.getAttribute('aria-describedby');
  return id ? text(document.getElementById(id)) : null;
};
const drawerButton = (d: Element, name: string): HTMLButtonElement | undefined =>
  all<HTMLButtonElement>(d, '.ant-drawer-footer button').find((b) => label(b) === name);
const posted = (path: string): Call[] => calls.filter((c) => c.method === 'POST' && c.path === `/api/console/sop${path}`);
const docsIn = (el: Element): string[] =>
  all<HTMLElement>(el, '.cm-content').map((e) => EditorView.findFromDOM(e)?.state.doc.toString() ?? '');
const modalOf = (title: string): Element | undefined =>
  all(document.body, '.ant-modal').find((x) => text(x.querySelector('.ant-modal-title')) === title);
const cleanChars = editableChars(D_CLEAN, SPEC).toLocaleString('en-US');

// 11.3a 检查全过：摘要与字数；点「发布…」（没有要存的）打开抽屉、再检查一次；抽屉的清单、替换说明、逐节改动、预填的说明；
// 只有预填时「发布」不能点、点了到说明框；发布以后条里写结果（不弹 toast）、焦点回到「发布…」；再改一个字那句就没了
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  eq(
    '发布条：改了哪几节、字数；没有问题时「发布…」能点，旁边不写原因；页头没有「发布」',
    [barText(m), barBlocked(m), !!publishBar(m)?.querySelector('.sop-bar-icon.is-warning'), headerButton(m, '发布')],
    [{ summary: '草稿改了2节（话术原则、异议处理）', hint: `·字数${cleanChars} / 2,658`, note: '' }, false, false, undefined],
  );
  const checks0 = srv.checks();
  await clickEv(barButton(m, '发布…'));
  await waitFor(() => !!drawerOf('发布草稿') && text(drawerOf('发布草稿')!.querySelector('.check-list-meta')) === '检查于14:30');
  const d = drawerOf('发布草稿')!;
  eq(
    '点「发布…」：没有要存的就不存，打开抽屉再检查一次，清单下写检查的时间',
    [srv.puts().length, srv.checks() - checks0, text(d.querySelector('.check-list-meta'))],
    [0, 1, '检查于14:30'],
  );
  eq(
    '抽屉：检查清单（7 项）、替换说明、逐节改动只列改过的节、默认行内',
    [
      text(d.querySelector('.check-list-summary')),
      all(d, '.check-item').length,
      text(d.querySelector('.sop-publish-replace')),
      all(d, '.sop-diff-name').map((e) => text(e)),
      text(d.querySelector('.sop-diff-mode .ant-segmented-item-selected')),
      all(d, '.sop-diff-view.is-inline').length,
      docsIn(d).map((x) => x.includes('search_routes 查线路') || x.includes('先问预算上限')),
    ],
    ['7/7通过', 7, '将替换线上v2（老板·9月25日 18:30发布）', ['话术原则', '异议处理'], '行内', 2, [true, true]],
  );
  const ta = d.querySelector<HTMLTextAreaElement>('textarea')!;
  eq(
    '变更说明：标签、预填改了哪几节、占位；只有预填时「发布」不能点（aria-disabled），旁边写原因',
    [
      text(d.querySelector('.sop-publish-label')),
      ta.value,
      ta.placeholder,
      text(d.querySelector('.sop-drawer-reason')),
      drawerButton(d, '发布')?.getAttribute('aria-disabled'),
      describedBy(drawerButton(d, '发布')),
    ],
    [
      '这次改了什么、为什么',
      '修改：话术原则、异议处理。',
      '例：客户嫌贵时先问预算上限',
      '在说明里写上为什么改',
      'true',
      '在说明里写上为什么改',
    ],
  );
  await clickEv(drawerButton(d, '发布'));
  await settle();
  eq(
    '这时点「发布」：不发，焦点到说明框、光标在末尾',
    [posted('/draft/publish').length, document.activeElement === ta, ta.selectionStart],
    [0, true, ta.value.length],
  );
  await setText(ta, `${ta.value}客户嫌贵先问预算`);
  eq(
    '写了字：「发布」能点，原因没了',
    [drawerButton(d, '发布')?.getAttribute('aria-disabled'), d.querySelector('.sop-drawer-reason')],
    [null, null],
  );
  await clickEv(drawerButton(d, '发布'));
  await waitFor(() => barText(m).summary.startsWith('已发布'));
  await settle();
  eq(
    '发布：带草稿的 rev 与写好的说明',
    posted('/draft/publish').map((c) => c.body),
    [{ rev: 4, changeNote: '修改：话术原则、异议处理。客户嫌贵先问预算' }],
  );
  eq(
    '发布成功：条里写「已发布v3（改了…）· 客户下一句就用新话术」和「回滚到v2」，不弹 toast；抽屉关上，焦点回到「发布…」',
    [
      barText(m),
      !!publishBar(m)?.querySelector('.sop-bar-icon.is-success'),
      all(document.body, '.ant-message-notice').length,
      !!drawerOf('发布草稿'),
      document.activeElement === barButton(m, '发布…'),
    ],
    [
      { summary: '已发布v3（改了话术原则、异议处理）', hint: '·客户下一句就用新话术·回滚到v2', note: '没有可发布的改动' },
      true,
      0,
      false,
      true,
    ],
  );
  eq(
    '这时没有改动：「查看改动」不能点，「发布…」aria-disabled；状态句是 v3',
    [barButton(m, '查看改动')?.disabled, barBlocked(m), text(m.box.querySelector('.page-status')).startsWith('线上v3')],
    [true, true, true],
  );
  await typeAtEnd(m, '甲');
  eq('再改一个字：那句没了，回到改了哪几节', barText(m).summary, '草稿改了1节（话术原则）');
  await clickEv(barButton(m, '发布…'));
  await waitFor(() => !!drawerOf('发布草稿')?.querySelector('textarea'));
  eq('再打开发布抽屉：说明是这一次的预填，上一次写的不留', drawerOf('发布草稿')!.querySelector('textarea')!.value, '修改：话术原则。');
  await m.unmount();
}

// 11.3b 「回滚到v2」：回滚被替换下来的那一版（回滚确认还是 01 的弹窗，第 7 步重做），成功以后条里那句没了
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  await publishVia(m, '先问预算');
  await waitFor(() => barText(m).summary.startsWith('已发布'));
  await clickEv(barButton(m, '回滚到v2'));
  await waitFor(() => !!modalOf('回滚到v2')?.querySelector('textarea'));
  await setText(modalOf('回滚到v2')!.querySelector('textarea')!, '退回去');
  await clickEv(all(modalOf('回滚到v2')!, '.ant-modal-footer button').find((b) => label(b) === '回滚到v2'));
  await waitFor(() => barText(m).summary === '草稿和线上一样');
  eq(
    '回滚的是 v2；成功以后条里那句没了，线上换成 v4',
    [
      posted('/versions/v2/rollback').map((c) => c.body),
      barText(m).summary,
      text(m.box.querySelector('.page-status')).startsWith('线上v4'),
    ],
    [[{ changeNote: '退回去' }], '草稿和线上一样', true],
  );
  await m.unmount();
}

// 11.3b2 发布以后从版本历史回滚：线上已经不是刚发布的那一版，条里「已发布v3 · 回滚到v2」那句不再留着
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  await publishVia(m, '先问预算');
  await waitFor(() => barText(m).summary.startsWith('已发布v3'));
  await settle();
  await act(async () =>
    m.qc.setQueryData(['sop-versions'], { pages: [{ items: [srv.state.published, CLEAN_SOP.published] }], pageParams: [undefined] }),
  );
  const fromHistory = (): HTMLButtonElement | undefined =>
    all<HTMLButtonElement>(m.box, '.sop-after button').find((b) => label(b) === '以此版本回滚');
  await waitFor(() => !!fromHistory());
  await clickEv(fromHistory());
  await waitFor(() => !!modalOf('回滚到v2')?.querySelector('textarea'));
  await setText(modalOf('回滚到v2')!.querySelector('textarea')!, '退回去');
  await clickEv(all(modalOf('回滚到v2')!, '.ant-modal-footer button').find((b) => label(b) === '回滚到v2'));
  await waitFor(() => text(m.box.querySelector('.page-status')).startsWith('线上v4'));
  await settle();
  eq(
    '版本历史里回滚到 v2：线上 v4，条里不再写「已发布v3」，也没有「回滚到v2」',
    [posted('/versions/v2/rollback').length, barText(m).summary, !!barButton(m, '回滚到v2')],
    [1, '草稿和线上一样', false],
  );
  await m.unmount();
}

// 11.3c 有没存上的改动时点「发布…」：马上存（不等防抖），存上之前不开抽屉、按钮转圈；存上以后打开，只有存上以后那一次检查
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, { ...FAST, debounce: 60_000 });
  await waitFor(() => summaryOf(m) === '7/7通过');
  const checks0 = srv.checks();
  await typeAtEnd(m, '乙');
  srv.mode = 'hold';
  await clickEv(barButton(m, '发布…'));
  await waitFor(() => srv.puts().length === 1);
  await settle();
  eq(
    '点「发布…」：马上存，存上之前不打开抽屉，按钮转圈',
    [srv.puts().length, !!drawerOf('发布草稿'), !!barButton(m, '发布…')?.classList.contains('ant-btn-loading')],
    [1, false, true],
  );
  srv.mode = 'ok';
  srv.checkHold = true;
  await act(async () => srv.held.shift()?.resolve());
  await waitFor(() => !!drawerOf('发布草稿') && srv.checkHeld.length === 1);
  const reason = (): string => text(drawerOf('发布草稿')?.querySelector('.sop-drawer-reason'));
  eq('存上以后打开抽屉：自动保存那一次检查还在路上，「发布」旁边写正在检查', reason(), '正在检查…');
  await act(async () => srv.checkHeld.shift()?.resolve());
  await waitFor(() => reason() !== '正在检查…');
  await rest(60);
  eq(
    '检查回来：只有存上以后自动跑的那一次（不另发），逐节改动里有刚写的字',
    [srv.checks() - checks0, docsIn(drawerOf('发布草稿')!).some((x) => x.includes('乙')), reason()],
    [1, true, '在说明里写上为什么改'],
  );
  await m.unmount();
}

// 11.3l 变更说明：关上再打开，自己写过的留着；只剩上一次的预填时，换成这一次改了哪几节
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=preamble', travelOwner, CLEAN_SOP, { ...FAST, debounce: 60_000 });
  await waitFor(() => summaryOf(m) === '7/7通过');
  const open = async (): Promise<HTMLTextAreaElement> => {
    await clickEv(barButton(m, '发布…'));
    await waitFor(() => !!drawerOf('发布草稿')?.querySelector('textarea'));
    return drawerOf('发布草稿')!.querySelector<HTMLTextAreaElement>('textarea')!;
  };
  const cancel = async (): Promise<void> => {
    await clickEv(drawerButton(drawerOf('发布草稿')!, '取消'));
    await waitFor(() => !drawerOf('发布草稿'));
  };
  await open();
  await cancel();
  await typeAtEnd(m, '己');
  const second = await open();
  eq('只剩上一次的预填：换成这一次改了哪几节（前言是刚存上的）', second.value, '修改：前言、话术原则、异议处理。');
  await setText(second, '先问预算');
  await cancel();
  eq('关上以后「发布…」照样能点', barBlocked(m), false);
  const third = await open();
  eq('自己写过的：关上再打开还在', third.value, '先问预算');
  await m.unmount();
}

// 11.3m 发布成功的那句只对应那一次：之后草稿又有了改动（重取时别人存的），条里照实写改了哪几节
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  await publishVia(m, '先问预算');
  await waitFor(() => barText(m).summary.startsWith('已发布'));
  const now = m.qc.getQueryData(['sop']) as SopOverview;
  const theirs = withBodies(now.published.sections, { preamble: '别人改的前言。\n\n' });
  await act(async () =>
    m.qc.setQueryData(['sop'], {
      ...now,
      draft: { ...version(null, theirs, { basedOn: now.published.id, rev: 30, publishedAt: null, publishedByName: null }), stale: false },
    }),
  );
  await settle();
  eq('草稿里又有改动：不再写发布成功，写改了哪几节', [barText(m).summary, barButton(m, '回滚到v2')], ['草稿改了1节（前言）', undefined]);
  await m.unmount();
}

// 11.3d 点「发布…」时没存上：不打开抽屉；之后自己存上了也不会忽然打开
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, { ...FAST, debounce: 60_000, backoff: [60_000] });
  await waitFor(() => summaryOf(m) === '7/7通过');
  await typeAtEnd(m, '丙');
  srv.mode = 'network';
  await clickEv(barButton(m, '发布…'));
  await waitFor(() => saveNow(m).includes('没保存上'));
  await rest(60);
  eq(
    '没存上：不打开抽屉，按钮不再转圈，状态句写没保存上',
    [!!drawerOf('发布草稿'), !!barButton(m, '发布…')?.classList.contains('ant-btn-loading'), saveNow(m)],
    [false, false, '·没保存上·重试'],
  );
  srv.mode = 'ok';
  await clickEv(m.box.querySelector('.sop-save-retry'));
  await waitFor(() => saveNow(m) === '·已自动保存14:30');
  await rest(80);
  eq('之后重试存上了：抽屉也不会自己打开', !!drawerOf('发布草稿'), false);
  await m.unmount();
}

// 11.3e 发布被拒（422）：抽屉开着，清单换成被拒的问题，写好的说明还在；点没过的一项关抽屉并定位（焦点留在正文里）
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  srv.publishFails = { contract: [{ code: 'unknown_tool', sectionKey: 'tone', detail: 'x', match: 'search_routes' }] };
  const m = await mountPage('/console/sop?section=preamble', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  await publishVia(m, '先问预算');
  await waitFor(() => text(drawerOf('发布草稿')?.querySelector('.sop-drawer-reason')) === '改完1个问题即可发布');
  const d = drawerOf('发布草稿')!;
  eq(
    '发布被拒：抽屉开着，清单 6/7，说明还在',
    [text(d.querySelector('.check-list-summary')), d.querySelector('textarea')?.value.endsWith('先问预算')],
    ['6/7通过', true],
  );
  await clickEv(all<HTMLElement>(d, 'button.check-item').find((b) => text(b.querySelector('.check-item-label')) === '工具名都存在'));
  await until(() => m.section() === 'tone' && selected(m) === 'search_routes');
  await settle();
  eq(
    '点「工具名都存在」：抽屉关上，切到话术原则、选中那个名字，焦点在正文里',
    [!!drawerOf('发布草稿'), m.section(), selected(m), document.activeElement === cmOf(m)],
    [false, 'tone', 'search_routes', true],
  );
  await m.unmount();
}

// 11.3e2 点抽屉清单里的一项，问题就在正在看的这一节：定位以后焦点留在正文里，抽屉收起、卸下以后也不被还给「发布…」
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  srv.publishFails = { contract: [{ code: 'unknown_tool', sectionKey: 'tone', detail: 'x', match: 'search_routes' }] };
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  await publishVia(m, '先问预算');
  await waitFor(() => text(drawerOf('发布草稿')?.querySelector('.sop-drawer-reason')) === '改完1个问题即可发布');
  const d = drawerOf('发布草稿')!;
  await clickEv(all<HTMLElement>(d, 'button.check-item').find((b) => text(b.querySelector('.check-item-label')) === '工具名都存在'));
  await waitFor(() => !document.querySelector('.sop-drawer'), 2000);
  await settle();
  eq(
    '同一节里定位：抽屉卸下以后，选中那个名字、焦点仍在正文里',
    [!!document.querySelector('.sop-drawer'), m.section(), selected(m), document.activeElement === cmOf(m)],
    [false, 'tone', 'search_routes', true],
  );
  await m.unmount();
}

// 11.3d2 之前没存上、点「发布…」时还在组字：那次失败是点之前的，不算这一次没存上；字上屏、存上以后打开抽屉
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, { ...FAST, backoff: [60_000] });
  await waitFor(() => summaryOf(m) === '7/7通过');
  srv.mode = 'invalid';
  await typeAtEnd(m, '丙');
  await waitFor(() => saveNow(m).includes('没保存上'));
  srv.mode = 'ok';
  const view = EditorView.findFromDOM(m.box.querySelector<HTMLElement>('.sop-editor .cm-content')!)!;
  let composing = true;
  Object.defineProperty(view, 'composing', { configurable: true, get: () => composing });
  await typeAtEnd(m, 'yi');
  await clickEv(barButton(m, '发布…'));
  await rest(80);
  eq(
    '组字时点「发布…」：先不存、不打开，按钮转圈',
    [srv.puts().length, !!drawerOf('发布草稿'), !!barButton(m, '发布…')?.classList.contains('ant-btn-loading')],
    [1, false, true],
  );
  const end = view.state.doc.length;
  await act(async () => view.dispatch({ changes: { from: end - 2, to: end, insert: '乙' }, userEvent: 'input.type.compose' }));
  composing = false;
  await waitFor(() => !!drawerOf('发布草稿'));
  const body =
    srv
      .puts()
      .at(-1)
      ?.edits.find((e) => e.key === 'tone')?.body ?? '';
  eq('字上屏、存上以后打开抽屉，存的是汉字', [!!drawerOf('发布草稿'), body.includes('丙乙'), body.includes('yi')], [true, true, false]);
  await m.unmount();
}

// 11.3n 发布成功以后改一个字再改回去：条里写「草稿和线上一样」，不再回到「已发布v3」
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  await publishVia(m, '先问预算');
  await waitFor(() => barText(m).summary.startsWith('已发布v3'));
  await typeAtEnd(m, '甲');
  await waitFor(() => srv.puts().length === 1);
  const view = EditorView.findFromDOM(m.box.querySelector<HTMLElement>('.sop-editor .cm-content')!)!;
  const len = view.state.doc.length;
  await act(async () => view.dispatch({ changes: { from: len - 1, to: len }, userEvent: 'delete.backward' }));
  await waitFor(() => srv.puts().length === 2);
  await settle();
  eq('改一个字再改回去：条里写草稿和线上一样，不再写已发布v3', [barText(m).summary, !!barButton(m, '回滚到v2')], ['草稿和线上一样', false]);
  await m.unmount();
}

// 11.3f 发布没成功（500）：错误写在抽屉里，抽屉开着、说明还在；重试成功
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  srv.publishFails = 'error';
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  await publishVia(m, '先问预算');
  await waitFor(() => !!drawerOf('发布草稿')?.querySelector('.sop-publish .ant-alert-error'));
  const d = drawerOf('发布草稿')!;
  eq(
    '500：抽屉里就地报错，说明还在',
    [!!d.querySelector('.ant-alert-error'), d.querySelector('textarea')?.value.endsWith('先问预算')],
    [true, true],
  );
  srv.publishFails = null;
  await clickEv(all(d, '.ant-alert button').find((b) => label(b) === '重试'));
  await waitFor(() => barText(m).summary.startsWith('已发布'));
  eq('重试：发布成功', [posted('/draft/publish').length, barText(m).summary], [2, '已发布v3（改了话术原则、异议处理）']);
  await m.unmount();
}

// 11.3g 抽屉里的检查：还在路上时「发布」不能点、写正在检查；没检查上写原因，点「发布」到清单的「重试」，重试过了就能发布
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  srv.checkHold = true;
  await clickEv(barButton(m, '发布…'));
  await waitFor(() => !!drawerOf('发布草稿')?.querySelector('textarea') && srv.checkHeld.length === 1);
  const d = drawerOf('发布草稿')!;
  const ta = d.querySelector<HTMLTextAreaElement>('textarea')!;
  await setText(ta, `${ta.value}先问预算`);
  const reason = (): string => text(d.querySelector('.sop-drawer-reason'));
  eq(
    '检查还在路上：「发布」不能点，旁边和清单下一行写正在检查',
    [reason(), text(d.querySelector('.check-list-meta')), drawerButton(d, '发布')?.getAttribute('aria-disabled')],
    ['正在检查…', '正在检查…', 'true'],
  );
  srv.checkFails = true;
  srv.checkHold = false;
  await act(async () => srv.checkHeld.shift()?.resolve());
  await waitFor(() => reason() === '没检查上，重试以后再发布');
  eq(
    '没检查上：原因与清单下一行的「重试」',
    [reason(), text(d.querySelector('.check-list-meta'))],
    ['没检查上，重试以后再发布', '没检查上·重试'],
  );
  await clickEv(drawerButton(d, '发布'));
  eq('这时点「发布」：焦点到「重试」', [posted('/draft/publish').length, label(document.activeElement!)], [0, '重试']);
  srv.checkFails = false;
  await clickEv(document.activeElement);
  await waitFor(() => d.querySelector('.sop-drawer-reason') === null);
  eq('重试检查过了：能发布', drawerButton(d, '发布')?.getAttribute('aria-disabled'), null);
  await m.unmount();
}

// 11.3h 查看改动（含还没存上的改动）、行内 / 并排（存进 localStorage、下次记着）、查看本节改动；关上以后焦点回到打开它的按钮
{
  localStorage.removeItem(DIFF_MODE_KEY);
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=preamble', travelOwner, CLEAN_SOP, { ...FAST, debounce: 60_000 });
  await waitFor(() => summaryOf(m) === '7/7通过');
  const link = (): HTMLButtonElement | null => m.box.querySelector<HTMLButtonElement>('.sop-pane-meta .sop-text-btn');
  eq('没改过的节（前言）：说明行没有「查看本节改动」', link(), null);
  await typeAtEnd(m, '丁');
  eq('改了以后说明行末尾有「查看本节改动」', text(link()), '查看本节改动');
  await clickEv(barButton(m, '查看改动'));
  await waitFor(() => !!drawerOf('草稿的改动'));
  let d = drawerOf('草稿的改动')!;
  eq(
    '查看改动：标题写相对线上v2，改了3节（含还没存上的前言），不存、不检查',
    [
      text(d.querySelector('.ant-drawer-title')),
      text(d.querySelector('.sop-changes-count')),
      all(d, '.sop-diff-name').map((e) => text(e)),
      docsIn(d)[0]?.includes('丁'),
      srv.puts().length,
    ],
    ['草稿的改动相对线上v2', '改了3节', ['前言', '话术原则', '异议处理'], true, 0],
  );
  const splitInput = all<HTMLElement>(d, '.sop-diff-mode .ant-segmented-item')
    .find((i) => text(i) === '并排')
    ?.querySelector('input');
  await clickEv(splitInput);
  await waitFor(() => all(d, '.cm-mergeView').length === 3);
  eq(
    '换成并排：每节一个左右对比，选择存进 localStorage',
    [
      all(d, '.cm-mergeView').length,
      localStorage.getItem(DIFF_MODE_KEY),
      all(d.querySelector('.sop-diff-cols')!, 'span').map((e) => text(e)),
    ],
    [3, 'split', ['线上v2', '草稿']],
  );
  await clickEv(d.querySelector('.ant-drawer-extra button[aria-label="关闭"]'));
  await waitFor(() => !drawerOf('草稿的改动'));
  eq('关上：焦点回到「查看改动」', document.activeElement === barButton(m, '查看改动'), true);
  await clickEv(link());
  await waitFor(() => !!drawerOf('「前言」的改动'));
  d = drawerOf('「前言」的改动')!;
  eq(
    '查看本节改动：只有这一节，记着上次选的并排',
    [text(d.querySelector('.ant-drawer-title')), all(d, '.sop-diff-name').map((e) => text(e)), all(d, '.cm-mergeView').length],
    ['「前言」的改动相对线上v2', ['前言'], 1],
  );
  await key(d.querySelector('.sop-drawer-scroll'), 'Escape');
  await waitFor(() => !drawerOf('「前言」的改动'));
  eq('Esc 关上：焦点回到「查看本节改动」', document.activeElement === link(), true);
  localStorage.removeItem(DIFF_MODE_KEY);
  await m.unmount();
}

// 11.3i 没有草稿：条里写草稿和线上一样，「发布…」不能点、点了什么也不做；只读成员没有发布条，改过的节照样能看改动；匿名都没有
{
  const noDraft: SopOverview = { ...CLEAN_SOP, draft: null, budget: { chars: editableChars(P_ONLINE, SPEC), limit: LIMIT } };
  const srv = fakeServer(noDraft);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, noDraft, FAST);
  await rest(60);
  eq(
    '没有草稿：摘要与字数，「查看改动」不能点，「发布…」aria-disabled、旁边写没有可发布的改动',
    [barText(m), barButton(m, '查看改动')?.disabled, barBlocked(m), describedBy(barButton(m, '发布…'))],
    [
      {
        summary: '草稿和线上一样',
        hint: `·字数${editableChars(P_ONLINE, SPEC).toLocaleString('en-US')} / 2,658`,
        note: '没有可发布的改动',
      },
      true,
      true,
      '没有可发布的改动',
    ],
  );
  await clickEv(barButton(m, '发布…'));
  await rest(60);
  eq('这时点「发布…」：不存、不检查、不打开', [srv.puts().length, srv.checks(), !!drawerOf('发布草稿')], [0, 0, false]);
  await m.unmount();

  fakeServer(CLEAN_SOP);
  const agent: Viewer = { ...travelOwner, me: { ...(travelOwner as Extract<Viewer, { kind: 'member' }>).me, role: 'agent' } };
  const r = await mountPage('/console/sop?section=tone', agent, CLEAN_SOP, FAST);
  eq(
    '只读成员：没有发布条；改过的节照样有「查看本节改动」',
    [publishBar(r), text(r.box.querySelector('.sop-pane-meta .sop-text-btn'))],
    [null, '查看本节改动'],
  );
  await r.unmount();
  const anonSop: AnonSopOverview = {
    published: { versionNo: 2, publishedAt: '2026-09-25T10:30:00Z', promptHash: 'a'.repeat(12), sections: P_ONLINE },
  };
  const a = await mountPage('/console/sop?section=tone', { kind: 'anon', pack: packOf(TRAVEL) }, anonSop);
  eq('匿名：没有发布条，也没有「查看本节改动」', [publishBar(a), a.box.querySelector('.sop-text-btn')], [null, null]);
  await a.unmount();
}

// 11.3j 有问题：摘要后写几个问题要改，「发布…」aria-disabled、旁边写原因；点它不开抽屉，跳到清单顺序上的第一个问题
{
  const srv = fakeServer(BAD_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, BAD_SOP, FAST);
  await waitFor(() => summaryOf(m) !== '');
  eq(
    '有 3 个问题：摘要后是 danger 的「3个问题要改」，图标换成留意；「发布…」aria-disabled，读屏经 aria-describedby 念原因',
    [
      barText(m).hint.startsWith('·3个问题要改·字数'),
      text(publishBar(m)?.querySelector('.sop-bar-problems')),
      !!publishBar(m)?.querySelector('.sop-bar-icon.is-warning'),
      barBlocked(m),
      describedBy(barButton(m, '发布…')),
    ],
    [true, '3个问题要改', true, true, '改完3个问题即可发布'],
  );
  await clickEv(barButton(m, '发布…'));
  await until(() => m.section() === 'objections');
  await settle();
  eq(
    '点「发布…」：不存、不开抽屉，跳到第一个问题（清单的顺序：必备短语都在，去线上版本里含这句的异议处理），焦点在正文里',
    [m.section(), !!drawerOf('发布草稿'), document.activeElement === cmOf(m), srv.puts().length],
    ['objections', false, true, 0],
  );
  await m.unmount();
}

// 11.3k 409 停住：「发布…」不能点，旁边写载入最新草稿以后才能发布；点了不开抽屉
{
  const srv = fakeServer(CLEAN_SOP);
  srv.check = (s) => scan(s);
  const m = await mountPage('/console/sop?section=tone', travelOwner, CLEAN_SOP, FAST);
  await waitFor(() => summaryOf(m) === '7/7通过');
  srv.mode = 'conflict';
  await typeAtEnd(m, '戊');
  await waitFor(() => editorEditable(m) === 'false');
  eq('409 停住：「发布…」不能点、写原因', [barBlocked(m), barText(m).note], [true, '载入最新草稿以后才能发布']);
  await clickEv(barButton(m, '发布…'));
  await rest(40);
  eq('这时点它：不开抽屉', !!drawerOf('发布草稿'), false);
  await m.unmount();
}

respond = null;

if (fails.length) {
  console.error(`sop: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`sop: ${pass} 条断言全部通过`);
process.exit(0);
