// console/src/fonts/ 的清单格式与 fonts.css 的写法。build.ts 按它生成，scripts/check-fonts.ts 按它重算比对，
// 所以 fonts.css 不能手改：声明顺序（先长尾、后 UI 优先片）由这里的函数保证（spec「字体与授权义务」）。
import fs from 'node:fs';
import path from 'node:path';

export const FONTS_DIR = 'console/src/fonts';
export const MANIFEST = `${FONTS_DIR}/manifest.json`;
export const FONTS_CSS = `${FONTS_DIR}/fonts.css`;
export const LICENSES_DIR = 'console/public/licenses';
/** 长尾分片来自这个钉死版本的依赖；它的 unicode.json 就是分片清单 */
export const LONG_TAIL_PKG = '@fontsource-variable/noto-sans-sc';

export interface FontFile {
  family: string;
  /** font-weight 描述符，写成范围 */
  weight: string;
  /** unicode-range 描述符，就是这个文件的码位清单（取自产物的 cmap） */
  unicodeRange: string;
  codepoints: number;
  bytes: number;
  sha256: string;
  /** 配方要了、源字体里却没有的码位（切不出来，check 不再要求它们） */
  absentInSource?: string;
}

export interface FontsManifest {
  generatedBy: string;
  tools: Record<string, string>;
  /** 键是 console/src/fonts/ 下的文件名 */
  fonts: Record<string, FontFile>;
  /** 键是 console/public/licenses/ 下的文件名 */
  licenses: Record<string, { url: string; sha256: string }>;
}

export const UI_FILES = { geist: 'geist-ui.woff2', geistMono: 'geist-mono-ui.woff2', noto: 'noto-sans-sc-ui.woff2' } as const;

const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** 码位 → unicode-range：连续的并成区间，如 U+0020-007E,U+00A0 */
export function toUnicodeRange(codepoints: Iterable<number>): string {
  const cps = [...new Set(codepoints)].toSorted((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < cps.length;) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    parts.push(i === j ? `U+${hex(cps[i])}` : `U+${hex(cps[i])}-${hex(cps[j])}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** unicode-range → 码位（只认 U+X 与 U+X-Y 两种写法，不认通配符） */
export function fromUnicodeRange(range: string): Set<number> {
  const out = new Set<number>();
  for (const part of range.split(',')) {
    const m = /^\s*U\+([0-9A-F]+)(?:-([0-9A-F]+))?\s*$/i.exec(part);
    if (!m) throw new Error(`unicode-range 写法不认识：${part}`);
    const a = parseInt(m[1], 16);
    const b = m[2] ? parseInt(m[2], 16) : a;
    for (let c = a; c <= b; c++) out.add(c);
  }
  return out;
}

export function readManifest(root = '.'): FontsManifest {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')) as FontsManifest;
}

/** 控制字符（C0、DEL、C1）：没有字形可画 */
const isControl = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);

/**
 * 长尾分片：依赖的 unicode.json 里每一项（键如 "[4]"、"latin"）对应 files/noto-sans-sc-<键>-wght-normal.woff2。
 * 范围里去掉控制字符：latin 片的范围从 U+0000 起，WebKit 遇到拉丁字母后面的换行符会去下载它
 * （plan 第 1.2 步实测，只渲染界面文字也会多下一片）
 */
export function longTailSlices(root = '.'): Array<{ file: string; unicodeRange: string }> {
  const dir = path.join(root, 'console/node_modules', LONG_TAIL_PKG);
  const table = JSON.parse(fs.readFileSync(path.join(dir, 'unicode.json'), 'utf8')) as Record<string, string>;
  return Object.entries(table).map(([key, range]) => {
    const file = `files/noto-sans-sc-${key.replace(/^\[(\d+)\]$/, '$1')}-wght-normal.woff2`;
    if (!fs.existsSync(path.join(dir, file))) throw new Error(`${LONG_TAIL_PKG} 里没有 ${file}（unicode.json 的 ${key}）`);
    return { file: `${LONG_TAIL_PKG}/${file}`, unicodeRange: toUnicodeRange([...fromUnicodeRange(range)].filter((cp) => !isControl(cp))) };
  });
}

function face(family: string, url: string, weight: string, unicodeRange: string): string {
  return [
    '@font-face {',
    `  font-family: '${family}';`,
    `  src: url(${url}) format('woff2');`,
    `  font-weight: ${weight};`,
    '  font-style: normal;',
    '  font-display: swap;',
    `  unicode-range: ${unicodeRange};`,
    '}',
  ].join('\n');
}

export function fontsCss(manifest: FontsManifest, longTail: ReadonlyArray<{ file: string; unicodeRange: string }>): string {
  const ui = (name: string) => {
    const f = manifest.fonts[name];
    if (!f) throw new Error(`清单里没有 ${name}`);
    return face(f.family, `./${name}`, f.weight, f.unicodeRange);
  };
  return [
    '/* 由 scripts/fonts/build.ts 生成，不要手改（scripts/check-fonts.ts 会重算比对）。',
    ' * 声明顺序（spec「字体与授权义务」）：同一家族的 unicode-range 重叠时，后声明的先被查到，',
    ' * 所以先声明长尾分片，最后声明 UI 优先片，界面文字和全部标点都取自 UI 优先片。 */',
    '',
    `/* 长尾：${LONG_TAIL_PKG} 的 ${longTail.length} 片，家族名改成 Noto Sans SC，页面上出现界面没用过的字时按需加载 */`,
    ...longTail.map((s) => face('Noto Sans SC', s.file, '400 600', s.unicodeRange)),
    '',
    '/* UI 优先片：最后声明，preload */',
    ui(UI_FILES.noto),
    ui(UI_FILES.geist),
    ui(UI_FILES.geistMono),
    '',
  ].join('\n');
}
