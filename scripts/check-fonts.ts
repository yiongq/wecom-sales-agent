// 字体的码位与产物检查（docs/features/console-ux/spec.md 不变量 30，「字体与授权义务」）。挂在 `pnpm test` 里。
// 不需要 fonttools、不联网：只读 console/src/fonts/manifest.json 和已提交的文件。
// - 界面文字里的每个汉字（取法见 scripts/fonts/ui-text.ts）都在 UI 优先片的码位清单里，缺字时点名这个字和它出现的文件；
// - 全部 CJK 标点和由 Noto 画的符号都在清单里（源字体本来就没有的除外，清单的 absentInSource 记着）；
// - 三个 woff2 与三份许可原文的 sha256 等于清单里记的值；
// - fonts.css 与按清单重算的结果逐字相同，声明顺序（先长尾、后 UI 优先片）因此也钉住了。
// 任何一项不过，都是重跑 `pnpm exec tsx scripts/fonts/build.ts`（要本机装 fonttools，见该脚本开头）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FONTS_CSS, FONTS_DIR, LICENSES_DIR, UI_FILES, fontsCss, fromUnicodeRange, longTailSlices, readManifest } from './fonts/css.js';
import { NOTO_SYMBOLS, cjkPunct, hanChars, uiTexts } from './fonts/ui-text.js';

const REBUILD = '界面文案或字体改了就重跑 pnpm exec tsx scripts/fonts/build.ts';
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const u = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

const manifest = readManifest();
const bad: string[] = [];

const noto = manifest.fonts[UI_FILES.noto];
const covered = fromUnicodeRange(noto.unicodeRange);
const absent = noto.absentInSource ? fromUnicodeRange(noto.absentInSource) : new Set<number>();

const han = hanChars(uiTexts());
const missing = new Map<string, string[]>();
for (const [cp, file] of han) if (!covered.has(cp)) missing.set(file, [...(missing.get(file) ?? []), String.fromCodePoint(cp)]);
for (const [file, chars] of missing) bad.push(`${file}：UI 优先片里没有「${chars.join('')}」`);

const punct = [...cjkPunct(), ...NOTO_SYMBOLS].filter((cp) => !covered.has(cp) && !absent.has(cp));
if (punct.length) bad.push(`UI 优先片缺 CJK 标点或符号：${punct.map(u).join(' ')}`);

for (const [name, f] of Object.entries(manifest.fonts)) {
  const file = path.join(FONTS_DIR, name);
  if (!fs.existsSync(file)) bad.push(`${file} 不存在`);
  else if (sha256(file) !== f.sha256) bad.push(`${file} 的 sha256 与清单不符`);
}
for (const [name, l] of Object.entries(manifest.licenses)) {
  const file = path.join(LICENSES_DIR, name);
  if (!fs.existsSync(file)) bad.push(`${file} 不存在`);
  else if (sha256(file) !== l.sha256) bad.push(`${file} 与许可原文（${l.url}）不符`);
}

if (!fs.existsSync(FONTS_CSS) || fs.readFileSync(FONTS_CSS, 'utf8') !== fontsCss(manifest, longTailSlices()))
  bad.push(`${FONTS_CSS} 与按清单重算的结果不同（被手改了，或依赖的长尾分片清单变了）`);

if (bad.length) {
  console.error(`fonts: ${bad.length} 处不对（${REBUILD}）：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `fonts: 界面用到的 ${han.size} 个汉字都在 UI 优先片里（${noto.codepoints} 个码位，${noto.bytes} B），产物与许可原文的 sha256 一致`,
);
