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
// 8. 编辑器（第 5.2 步，spec「销售话术 · 编辑器」）：行的排法、粗体、芯片的名字、相对线上的改动（按字比、只动空白的不算）；
//    EditorState 上算出的装饰（藏起来的标记、芯片在外层、图标、挤压回退按看得见的字算）；CodeMirror 的每句内置文案都有中文；
//    挂在 DOM 里的芯片、图标、改动标记、aria-label、只读，换属性不重建编辑器；中栏的标题、说明行、固定规则说明；整页的接线。
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
import { act, type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AnonSopOverview, SectionSpecView, SopOverview, SopSectionText, SopVersion } from '../../../src/shared/console-api.js';
import type { IndustryPack, SopSectionDef } from '../../../src/shared/pack.js';
import { editableChars } from '../../../src/shared/sop-sections.js';
import { SopPage } from '../pages/SopPage.js';
import { SectionDiff } from '../SectionDiff.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { LEAVING_PAGE } from '../parts/UnsavedGuard.js';
import { VIEWER_KEY, type Viewer } from '../viewer.js';
import { Directory, DirectorySelect, type SelectVia } from './Directory.js';
import {
  buildDecorations,
  chipLabel,
  chipRanges,
  CM_PHRASES,
  draftMarks,
  lineShape,
  sopEditorSetup,
  strongRanges,
  type Vocabulary,
} from './editor.js';
import {
  anonOutline,
  anonStatus,
  bodyWithoutHeading,
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
  quotaTone,
  resolveSection,
  scaleMaxOf,
  sectionMeta,
  stepSection,
} from './outline.js';
import { QuotaBar } from './QuotaBar.js';
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
globalThis.fetch = ((input: unknown) => {
  requests.push(String(input));
  return new Promise<never>(() => undefined);
}) as typeof fetch;

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
  router: ReturnType<typeof createRouter>;
  section(): string | undefined;
  pathname(): string;
  unmount(): Promise<void>;
}

/** 挂整页：url 是地址栏里的原样（带 /console） */
async function mountPage(url: string, viewer: Viewer, sop: SopOverview | AnonSopOverview | null): Promise<PageBox> {
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
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    ),
  );
  await until(() => box.querySelector('.sop-editor .cm-content, .sop-skel-editor') !== null);
  return {
    box,
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
  const member = await mount(<SopSkeleton sections={11} quota filter />);
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
  const anon = await mount(<SopSkeleton sections={9} quota={false} filter={false} />);
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
  // 整页在 /sop 还没回来时按身份画骨架
  const pending = await mountPage('/console/sop', { kind: 'anon', pack: packOf(RENO) }, null);
  eq(
    '整页加载中（匿名）：骨架不画分段控件，行数取行业包',
    [!!pending.box.querySelector('.sop-skel-filter'), all(pending.box, '.sop-skel-row').length],
    [false, 9],
  );
  await pending.unmount();
}
eq(
  '整页的自测没有发出请求（除了加载中那一次取 /sop）',
  requests.filter((u) => !u.endsWith('/api/console/sop')),
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
  eq('不需要回退时没有 .halt', all8.filter((x) => x.spec.class === 'halt').length, 0);
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
    '改过的段落：只有第一行',
    all(m.box, '.cm-line.sop-changed').map((l) => lines.indexOf(l as HTMLElement) + 1),
    [1],
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
    '成员：节标题、说明行、正文的 aria-label',
    [
      text(m.box.querySelector('.sop-pane-title')),
      text(m.box.querySelector('.sop-pane-meta')),
      m.box.querySelector('.sop-editor .cm-content')?.getAttribute('aria-label'),
    ],
    ['话术原则', '可编辑·910 → 967字（+57）', '「话术原则」正文'],
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
  '编辑器的自测没有发出请求（除了加载中那一次取 /sop）',
  requests.filter((u) => !u.endsWith('/api/console/sop')),
  [],
);

if (fails.length) {
  console.error(`sop: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`sop: ${pass} 条断言全部通过`);
process.exit(0);
