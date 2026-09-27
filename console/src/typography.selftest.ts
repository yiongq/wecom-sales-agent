// 标点与间距在 console 一侧的自测（spec「标点与间距」，设计系统 §2.5、§5.19）。两件事：
// 1. cjk() 与 Sep 渲染出来的标记：需要回退时，haltIndices 算出的字包进 .halt，其余连续的文字留在同一个文本节点里
//    （renderToString 在相邻文本节点之间插 <!-- -->，出现就是拆碎了；renderToStaticMarkup 不插）；数组的各段之间是 Sep，挤压在拼好的串上算；
//    不需要回退时原样返回；
// 2. 全局样式的约定：根元素 lang="zh-CN"；brand.css 的 body 上写 text-spacing-trim、text-autospace 为 normal；
//    不在任何地方写 space-all（样张页的对照行除外），不全局开 halt / palt / chws：font-feature-settings 只出现在 .halt 里，
//    组件里也不用 style 改这两项。
// 用法：pnpm exec tsx --tsconfig console/tsconfig.json console/src/typography.selftest.ts
import fs from 'node:fs';
import path from 'node:path';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { haltIndices } from '../../src/shared/typography.js';
import { cjk, Sep } from './typography.js';

const HERE = import.meta.dirname;
const SRC = HERE;
const SPECIMEN_DIR = path.join(SRC, '_specimen');

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown): void {
  if (got === want) pass += 1;
  else fails.push(`${name}\n      得到: ${String(got)}\n      期望: ${String(want)}`);
}
function ok(cond: boolean, msg: string): void {
  if (cond) pass += 1;
  else fails.push(msg);
}

const html = (node: ReturnType<typeof cjk>): string => renderToStaticMarkup(createElement(Fragment, null, node));
const SEP = '<span class="sep" aria-hidden="true">·</span><span class="sep-sr"></span>';
const halt = (s: string) => `<span class="halt">${s}</span>`;

// 1. 标记
eq('Sep', renderToStaticMarkup(createElement(Sep)), SEP);
eq('不需要回退时原样返回字符串', cjk('客户答「可以」「好」，', false), '客户答「可以」「好」，');
eq('不需要回退时数组只插 Sep', html(cjk(['企微客户', 'A01', '7条消息'], false)), `企微客户${SEP}A01${SEP}7条消息`);
eq('没有连用标点', html(cjk('有1个问题要改', true)), '有1个问题要改');
eq(
  '收标点连着开标点，挤收标点',
  html(cjk('客户答「可以」「好」，你还得再问一遍', true)),
  `客户答「可以${halt('」')}「好${halt('」')}，你还得再问一遍`,
);
eq('连着几个要挤的字包在一个 span 里', html(cjk('」」」', true)), `${halt('」」')}」`);
eq('开标点连着开标点，挤后一个', html(cjk('（「不用倒时差」）', true)), `（${halt('「')}不用倒时差${halt('」')}）`);
eq(
  '收标点后面是 Sep：挤收标点',
  html(cjk(['改了2节（话术原则、异议处理）', '有1个问题要改'], true)),
  `改了2节（话术原则、异议处理${halt('）')}${SEP}有1个问题要改`,
);
eq('Sep 后面是开标点：挤开标点', html(cjk(['线上v2', '（草稿）'], true)), `线上v2${SEP}${halt('（')}草稿）`);
eq('Sep 两侧都挤', html(cjk(['写「甲」', '「乙」'], true)), `写「甲${halt('」')}${SEP}${halt('「')}乙」`);

// 真实文案：halt 的位置与 haltIndices 一致，去掉标记后文字不变，没有被拆碎的文本节点
const SAMPLES: ReadonlyArray<string | readonly string[]> = [
  '客户答「可以」「好」，（「不用倒时差」「想找个安静的地方」）',
  '旅程（D1）：「成都→丹巴」。',
  '字体：Geist、Geist Mono（Vercel），思源黑体Noto Sans SC（Adobe、Google）。都按SIL Open Font License 1.1使用。',
  ['改了2节（话术原则、异议处理）', '有1个问题要改'],
  ['上架「贵州 小七孔·西江千户苗寨 5 日」', '「线路」（草稿）'],
];
for (const text of SAMPLES) {
  const parts = typeof text === 'string' ? [text] : text;
  const joined = parts.join('·');
  const out = html(cjk(text, true));
  const name = joined.slice(0, 16);
  const nodes = renderToString(createElement(Fragment, null, cjk(text, true)));
  ok(!nodes.includes('<!-- -->'), `${name}…：连续的文字被拆成了几个文本节点：${nodes}`);
  eq(`${name}…：去掉标记后文字不变`, out.replaceAll(SEP, '·').replace(/<[^>]+>/g, ''), joined);
  // 逐字标出 halt：包在 .halt 里的字的下标
  const got: number[] = [];
  let pos = 0;
  for (const m of out.replaceAll(SEP, '·').matchAll(/<span class="halt">([^<]*)<\/span>|([^<]+)/g)) {
    const [, h, plain] = m;
    if (h !== undefined) for (let i = 0; i < h.length; i += 1) got.push(pos + i);
    pos += (h ?? plain).length;
  }
  eq(`${name}…：halt 的位置`, got.join(','), haltIndices(joined).join(','));
}

// 2. 全局样式
const read = (p: string) => fs.readFileSync(p, 'utf8');
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
ok(/<html\s+lang="zh-CN">/.test(read(path.join(SRC, '..', 'index.html'))), 'console/index.html 的根元素不是 <html lang="zh-CN">');
const brand = stripCss(read(path.join(SRC, 'theme', 'brand.css')));
const body = /(?:^|\})\s*body\s*\{([^}]*)\}/.exec(brand)?.[1] ?? '';
for (const decl of [
  'text-spacing-trim: normal',
  'text-autospace: normal',
  'font-variant-numeric: tabular-nums',
  'font-synthesis-weight: none',
])
  ok(body.includes(`${decl};`), `brand.css 的 body 上没有「${decl}」（设计系统 §2.5）`);
ok(/\.halt\s*\{\s*font-feature-settings:\s*'halt';\s*\}/.test(brand), "brand.css 里没有 .halt { font-feature-settings: 'halt' }");
// Sep 给读屏的「，」是生成内容的替代文字，不是 absolute 的盒子（WebKit 的行里有 absolute 的盒子时 text-autospace 整行失效）
ok(/\.sep-sr::before\s*\{[^}]*content:\s*'' \/ '，';/.test(brand), "brand.css 里没有 .sep-sr::before { content: '' / '，' }");
ok(!/\.sep(-sr)?\b[^{]*\{[^}]*position:\s*absolute/.test(brand), 'brand.css 里 Sep 的部件用了 position: absolute');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => path.relative(path.join(SRC, '..', '..'), p);
for (const f of walk(SRC)) {
  if (/\.selftest\.[a-z]+$/.test(f)) continue;
  const inSpecimen = f.startsWith(SPECIMEN_DIR + path.sep);
  if (f.endsWith('.css')) {
    const css = stripCss(read(f));
    if (!inSpecimen) ok(!css.includes('space-all'), `${rel(f)}：写了 space-all（只有样张页的对照行可以）`);
    ok(!/\b(palt|chws)\b/.test(css), `${rel(f)}：开了 palt / chws（设计系统 §2.5：只在 .halt 里用 halt）`);
    const features = css.match(/font-feature-settings\s*:[^;]*/g) ?? [];
    const allowed = f === path.join(SRC, 'theme', 'brand.css') ? 1 : 0;
    ok(features.length === allowed, `${rel(f)}：font-feature-settings 出现在 .halt 以外：${features.join(' | ')}`);
    const trims = css.match(/text-(spacing-trim|autospace)\s*:[^;]*/g) ?? [];
    const own = f === path.join(SRC, 'theme', 'brand.css') ? 2 : inSpecimen ? trims.length : 0;
    ok(trims.length === own, `${rel(f)}：在 brand.css 的 body 以外改了 text-spacing-trim / text-autospace：${trims.join(' | ')}`);
  } else if (/\.(ts|tsx)$/.test(f)) {
    const code = read(f);
    ok(!/\b(textSpacingTrim|textAutospace|fontFeatureSettings)\b/.test(code), `${rel(f)}：用 style 改了标点挤压或字体特性`);
  }
}

if (fails.length) {
  console.error(`CJK SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 12)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `CJK SELFTEST PASS: ${pass} 项断言全通（cjk() 与 Sep 的回退标记 / 文本节点不拆碎 / 全局 text-spacing-trim、text-autospace 与 halt 的约定）`,
);
