// 字体的码位与产物检查（docs/features/console-ux/spec.md 不变量 30，「字体与授权义务」）。挂在 `pnpm test` 里。
// 不需要 fonttools、不联网：只读已提交的文件和 console 的依赖。前五条都不经过生成函数（css.ts 的 fontsCss、longTailSlices），
// 生成脚本被改坏、再按它重新生成，照样拦得住：
// 1. 界面文字里的每个汉字（取法见 scripts/fonts/ui-text.ts）都在 UI 优先片的码位清单里，缺字时点名这个字和它出现的文件；
// 2. 界面文字里的其他字符（控制字符除外）都由 Geist 或 UI 优先片画，不然页面一显示它就要下载长尾分片（验收 8）；
//    例外只有 OUTSIDE_OK 里写明理由的几条，出处里没了这个字符就要删掉那一条；
// 3. 全部 CJK 标点和由 Noto 画的符号都在清单里（源字体本来就没有的除外，清单的 absentInSource 记着）；
// 4. 三个 woff2 的 cmap 等于清单记的码位，字节数、sha256 等于清单；三份许可原文的 sha256 等于清单；
// 5. 解析 fonts.css：自切的三个文件各有一条 @font-face，unicode-range 等于该文件的 cmap；最后一条 Noto Sans SC
//    是 UI 优先片、其余都是长尾分片（声明顺序：先长尾、后 UI 优先片）；长尾的 unicode-range 里没有控制字符。
// 另外 fonts.css 与按清单重算的结果逐字相同，拦下手改（字重、font-display 这些）。
// 任何一项不过，都是改文案或重跑 `pnpm exec tsx scripts/fonts/build.ts`（要本机装 fonttools，见该脚本开头）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FONTS_CSS,
  FONTS_DIR,
  LICENSES_DIR,
  LONG_TAIL_PKG,
  UI_FILES,
  fontsCss,
  fromUnicodeRange,
  longTailSlices,
  readManifest,
} from './fonts/css.js';
import { HAN, NOTO_SYMBOLS, cjkPunct, hanChars, uiTexts } from './fonts/ui-text.js';
import { woff2Codepoints } from './fonts/woff2.js';

/**
 * 界面文字里允许不由 Geist 或 UI 优先片画的字符。每条写明出处和理由；出处里没了这个字符，检查会要求删掉这一条。
 */
const OUTSIDE_OK: ReadonlyArray<{ cp: number; file: string; why: string }> = [
  { cp: 0xfeff, file: 'src/shared/csv.ts', why: 'BOM：解析 CSV 时用来去掉开头的 BOM，不上页面' },
  {
    cp: 0x30fb,
    file: 'src/shared/typography.ts',
    why: '「・」：haltIndices 的字表里用来判断挤压（设计系统 §2.5），界面文案不用它',
  },
];

const REBUILD = '界面文案或字体改了就重跑 pnpm exec tsx scripts/fonts/build.ts';
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const u = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
/** 控制字符（C0、DEL、C1）：没有字形可画 */
const isControl = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
const diff = (a: Set<number>, b: Set<number>) => [...a].filter((c) => !b.has(c));

const manifest = readManifest();
const bad: string[] = [];

// 4. 产物与清单
const cmaps = new Map<string, Set<number>>();
for (const [name, f] of Object.entries(manifest.fonts)) {
  const file = path.join(FONTS_DIR, name);
  if (!fs.existsSync(file)) {
    bad.push(`${file} 不存在`);
    continue;
  }
  const buf = fs.readFileSync(file);
  if (sha256(buf) !== f.sha256) bad.push(`${file} 的 sha256 与清单不符`);
  if (buf.length !== f.bytes) bad.push(`${file} 是 ${buf.length} B，清单记的是 ${f.bytes} B`);
  let cmap: Set<number>;
  try {
    cmap = woff2Codepoints(buf);
  } catch (e) {
    bad.push(`${file} 读不出 cmap：${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  cmaps.set(name, cmap);
  const listed = fromUnicodeRange(f.unicodeRange);
  const notInFile = diff(listed, cmap);
  const notListed = diff(cmap, listed);
  if (notInFile.length) bad.push(`清单说 ${name} 有、它的 cmap 里却没有：${notInFile.map(u).join(' ')}`);
  if (notListed.length) bad.push(`${name} 的 cmap 里有、清单没记：${notListed.map(u).join(' ')}`);
  if (listed.size !== f.codepoints) bad.push(`${name} 的清单范围是 ${listed.size} 个码位，codepoints 记的是 ${f.codepoints}`);
}
for (const [name, l] of Object.entries(manifest.licenses)) {
  const file = path.join(LICENSES_DIR, name);
  if (!fs.existsSync(file)) bad.push(`${file} 不存在`);
  else if (sha256(fs.readFileSync(file)) !== l.sha256) bad.push(`${file} 与许可原文（${l.url}）不符`);
}

// 1–3. 界面文字
const noto = manifest.fonts[UI_FILES.noto];
const geist = manifest.fonts[UI_FILES.geist];
const covered = fromUnicodeRange(noto.unicodeRange);
const drawn = new Set([...covered, ...fromUnicodeRange(geist.unicodeRange)]);
const absent = noto.absentInSource ? fromUnicodeRange(noto.absentInSource) : new Set<number>();

const texts = uiTexts();
const han = hanChars(texts);
const missing = new Map<string, string[]>();
for (const [cp, file] of han) if (!covered.has(cp)) missing.set(file, [...(missing.get(file) ?? []), String.fromCodePoint(cp)]);
for (const [file, chars] of missing) bad.push(`${file}：UI 优先片里没有「${chars.join('')}」`);

const allowed = new Set<(typeof OUTSIDE_OK)[number]>();
const outside = new Map<string, Set<number>>();
for (const { file, text } of texts)
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (HAN.test(ch) || isControl(cp) || drawn.has(cp)) continue;
    const ok = OUTSIDE_OK.find((o) => o.cp === cp && o.file === file);
    if (ok) allowed.add(ok);
    else outside.set(file, (outside.get(file) ?? new Set()).add(cp));
  }
for (const [file, cps] of outside)
  bad.push(
    `${file}：${[...cps].map((c) => `「${String.fromCodePoint(c)}」${u(c)}`).join(' ')} 既不在 Geist 也不在 UI 优先片里，显示时会下载长尾分片`,
  );
for (const o of OUTSIDE_OK)
  if (!allowed.has(o)) bad.push(`${o.file} 里已经没有 ${u(o.cp)}，把 scripts/check-fonts.ts 的 OUTSIDE_OK 里这一条删掉`);

const punct = [...cjkPunct(), ...NOTO_SYMBOLS].filter((cp) => !covered.has(cp) && !absent.has(cp));
if (punct.length) bad.push(`UI 优先片缺 CJK 标点或符号：${punct.map(u).join(' ')}`);

// 5. fonts.css 的结构，直接解析已提交的文件
interface Face {
  family: string;
  src: string;
  range: Set<number> | null;
}
function parseFaces(css: string): Face[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, decl]) => {
    const range = /unicode-range:\s*([^;]+);/.exec(decl)?.[1];
    return {
      family: /font-family:\s*['"]([^'"]+)['"]/.exec(decl)?.[1] ?? '',
      src: /src:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(decl)?.[1] ?? '',
      range: range ? fromUnicodeRange(range) : null,
    };
  });
}

if (!fs.existsSync(FONTS_CSS)) bad.push(`${FONTS_CSS} 不存在`);
else {
  const css = fs.readFileSync(FONTS_CSS, 'utf8');
  const faces = parseFaces(css);
  for (const name of Object.values(UI_FILES)) {
    const mine = faces.filter((f) => f.src === `./${name}`);
    if (mine.length !== 1) bad.push(`${FONTS_CSS} 里 ${name} 的 @font-face 有 ${mine.length} 条，应当是 1 条`);
    const cmap = cmaps.get(name);
    for (const f of mine) {
      if (f.family !== manifest.fonts[name]?.family) bad.push(`${FONTS_CSS}：${name} 的家族名是「${f.family}」`);
      if (!f.range) bad.push(`${FONTS_CSS}：${name} 没写 unicode-range`);
      else if (cmap && (diff(f.range, cmap).length || diff(cmap, f.range).length))
        bad.push(`${FONTS_CSS}：${name} 的 unicode-range 与文件的 cmap 不一致`);
    }
  }
  const notoFaces = faces.filter((f) => f.family === 'Noto Sans SC');
  const last = notoFaces.at(-1);
  if (last?.src !== `./${UI_FILES.noto}`)
    bad.push(`${FONTS_CSS}：最后一条 Noto Sans SC 是 ${last?.src ?? '（没有）'}，应当是 UI 优先片（先长尾、后 UI 优先片）`);
  const longTail = notoFaces.filter((f) => f.src !== `./${UI_FILES.noto}`);
  if (!longTail.length) bad.push(`${FONTS_CSS} 里没有长尾分片`);
  for (const f of longTail) {
    if (!f.src.startsWith(`${LONG_TAIL_PKG}/files/`)) bad.push(`${FONTS_CSS}：Noto Sans SC 有一条来自 ${f.src}，不是长尾分片`);
    if (!f.range) bad.push(`${FONTS_CSS}：${f.src} 没写 unicode-range`);
    else {
      const ctl = [...f.range].filter(isControl);
      if (ctl.length) bad.push(`${FONTS_CSS}：${f.src} 的 unicode-range 含控制字符 ${u(ctl[0])} 等 ${ctl.length} 个`);
    }
  }
  if (css !== fontsCss(manifest, longTailSlices())) bad.push(`${FONTS_CSS} 与按清单重算的结果不同（被手改了，或依赖的长尾分片清单变了）`);
}

if (bad.length) {
  console.error(`fonts: ${bad.length} 处不对（${REBUILD}）：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `fonts: 界面用到的 ${han.size} 个汉字都在 UI 优先片里（${noto.codepoints} 个码位，${noto.bytes} B），` +
    '三个文件的 cmap、sha256 与清单一致，fonts.css 先长尾、后 UI 优先片',
);
