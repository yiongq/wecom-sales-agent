// 销售话术页第 5.1 步的自测（spec「销售话术（B、C 页）」的状态句、额度条、目录，设计系统 §6.2 与 B 页）：
// 1. 目录的数据：节表与锁定取 /sop 的 spec，锁定原因按 key 取行业包；匿名只用行业包；包里没有的节照样画得出来；
//    字数与相对线上的差、改过的节、问题数、分段筛选的计数、底部说明；
// 2. 额度条：与服务端同一个 editableChars 算（含还没保存的改动），B 页的数（2,303 / 2,658 字 · 87% · 还能写355字，
//    比例尺 0–2,800，刻度在 649、683 px 处），95% 与上限两道线上的颜色与百分比，超限的写法；
// 3. 状态句：成员与匿名，发布人没有名字时按来源写；
// 4. URL 的 section 与方向键：不认识的节退回默认节，到头不绕回，被筛掉的当前节；未保存保护只拦离开这一页；
// 5. 在 DOM 里挂载（happy-dom）：目录的链接、当前节、锁与圆点、只占一个 Tab 位、方向键 / Home / End / Enter、
//    点击与带修饰键的点击、分段筛选、锁定原因的 Tooltip；额度条的文字、段宽、刻度与颜色；窄屏的下拉。
// 6. 逐字重渲不碰弹层：打字时目录只重渲字数变了的那一行，窄屏下拉不重渲，关着的危险确认不挂 Portal
//    （这几处重渲会让 @rc-component/portal 在 effect 里 setState，快速连按时 React 报 #185，见 sop/Directory.tsx 文件头）。
// 行业包用文件里的夹具（console/src 里只有渲染器自测能 import 行业包，spec「行业包通用架构 · 放在哪里」）：
// 一份照旅游包的节表写（B 页的场景数据），一份照家装整装假包的节表写，节的 key、标题、条数都和旅游包不同。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/sop/sop.selftest.tsx
process.env.TZ = 'Asia/Shanghai';

import { win } from '../fields/selftest-dom.js';
import { act, type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SectionSpecView, SopSectionText } from '../../../src/shared/console-api.js';
import type { SopSectionDef } from '../../../src/shared/pack.js';
import { editableChars } from '../../../src/shared/sop-sections.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { LEAVING_PAGE } from '../parts/UnsavedGuard.js';
import { Directory, DirectorySelect, type SelectVia } from './Directory.js';
import {
  anonOutline,
  anonStatus,
  countText,
  defaultSection,
  draftChars,
  filterCounts,
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
  stepSection,
} from './outline.js';
import { QuotaBar } from './QuotaBar.js';

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

/** 正文恰好 n 个 UTF-16 码元（设计系统 §10.0 的场景字数） */
const body = (n: number, ch = '话'): string => ch.repeat(n);
const textFor = (def: Pick<SopSectionDef, 'heading'>, b: string): string => (def.heading === null ? b : `## ${def.heading}\n\n${b}`);
function sections(defs: readonly SopSectionDef[], lens: Record<string, number>, ch = '话'): SopSectionText[] {
  return defs.map((d) => ({ key: d.key, text: textFor(d, body(lens[d.key]!, ch)) }));
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
  s.key === 'tone' || s.key === 'objections' ? { ...s, text: s.text.replace(/话$/, '改') } : s,
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

  // 本地还没保存的改动实时算进去，与把它存进草稿以后服务端算的相同
  const edits = { 'wechat-style': body(600) };
  const merged = DRAFT.map((s) => (s.key === 'wechat-style' ? { ...s, text: `## 微信语气规范\n\n${body(600)}` } : s));
  eq('本地改动实时算：+23 字', [draftChars(SPEC, DRAFT, edits), editableChars(merged, SPEC)], [2326, 2326]);
  eq('前言的本地改动不带标题行', draftChars(SPEC, DRAFT, { preamble: body(200) }), 2303 - 32);
  eq('锁定节的改动不计', draftChars(SPEC, DRAFT, { stages: body(10) }), 2303);

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
    edits: { 'wechat-style': body(600) },
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
  await m.render(sel(rows.map((r) => (r.key === 'preamble' ? { ...r, changed: true, delta: 1, chars: r.chars + 1 } : r))));
  check('有一节变成「改过」：下拉重渲', props() !== p0);
  const pre = all<HTMLElement>(document.body, '.ant-select-item-option').find((o) => text(o).startsWith('前言'));
  check('选项里这一节带上圆点', !!pre?.querySelector('.sop-toc-dot'));
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

if (fails.length) {
  console.error(`sop: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`sop: ${pass} 条断言全部通过`);
process.exit(0);
