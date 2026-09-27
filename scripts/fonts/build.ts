// 生成后台自托管的字体（docs/features/console-ux/spec.md「字体与授权义务」，设计系统 §2.6）。
// 只在开发机上跑，CI 不跑：要联网取源文件，要本机装 fonttools 和 brotli（pip install fonttools brotli）。
// 默认用 PATH 上的 python3，装在别处时用 FONTTOOLS_PYTHON 指过去。
// 界面文案改了（scripts/check-fonts.ts 报缺字）就重跑：pnpm exec tsx scripts/fonts/build.ts
//
// 做的事：
// 1. 从钉死的 URL 取 OFL 原字体和许可原文，逐个校验 sha256，缓存在 node_modules/.cache/console-fonts/；
// 2. 用 fonttools 的 pyftsubset 切子集，varLib.instancer 把字重轴收窄，再压成 woff2，写到 console/src/fonts/：
//    - geist-ui.woff2、geist-mono-ui.woff2：U+0020–007E、U+00A0、U+00B7；
//    - noto-sans-sc-ui.woff2（UI 优先片）：界面文字里的全部汉字（取法见 ui-text.ts），加全部 CJK 标点和由 Noto 画的符号；
// 3. 写 console/src/fonts/manifest.json（每个文件的码位清单、字节数、sha256）和 fonts.css（长尾在前、UI 优先片在后）；
// 4. 许可原文写到 console/public/licenses/，随构建发布在 /console/licenses/。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  FONTS_CSS,
  FONTS_DIR,
  LICENSES_DIR,
  MANIFEST,
  UI_FILES,
  fontsCss,
  fromUnicodeRange,
  longTailSlices,
  toUnicodeRange,
  type FontFile,
  type FontsManifest,
} from './css.js';
import { NOTO_SYMBOLS, cjkPunct, hanChars, uiTexts } from './ui-text.js';

/** google/fonts 的一个提交：Geist 1.800、Geist Mono 1.701、Noto Sans SC 2.004 都在这个提交里 */
const GOOGLE_FONTS = 'https://raw.githubusercontent.com/google/fonts/9e25e2ba265e5298f70f6182dd4e8a3ebf1b9123/ofl';
/** lucide 的许可原文，取自与 lucide-react 同号的 tag */
const LUCIDE = 'https://raw.githubusercontent.com/lucide-icons/lucide/1.48.0';

const SOURCES = {
  geist: { url: `${GOOGLE_FONTS}/geist/Geist%5Bwght%5D.ttf`, sha256: '73894e0448cae90a92b6c2f8732b7bb9acb7b94c418bff559dad4a18e1de9659' },
  geistMono: {
    url: `${GOOGLE_FONTS}/geistmono/GeistMono%5Bwght%5D.ttf`,
    sha256: 'd00e590b8eb3a59acc329b2d044fd143ae935090b7da33199ebee27cc7de8196',
  },
  noto: {
    url: `${GOOGLE_FONTS}/notosanssc/NotoSansSC%5Bwght%5D.ttf`,
    sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
  },
} as const;

/** 许可原文。Geist 与 Geist Mono 的 OFL.txt 逐字节相同（同一份版权声明），发布一份 */
const LICENSES: Record<string, { url: string; sha256: string }> = {
  'OFL-Geist.txt': { url: `${GOOGLE_FONTS}/geist/OFL.txt`, sha256: '1781d2806a07d91c4edf4740b88449fab7d0eadad53f7c351b94cd4d4eb8c00f' },
  'OFL-NotoSansSC.txt': {
    url: `${GOOGLE_FONTS}/notosanssc/OFL.txt`,
    sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9',
  },
  'lucide-ISC.txt': { url: `${LUCIDE}/LICENSE`, sha256: 'b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57' },
};
const GEIST_MONO_OFL = { url: `${GOOGLE_FONTS}/geistmono/OFL.txt`, sha256: LICENSES['OFL-Geist.txt'].sha256 };

const LATIN_UI = [...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i), 0xa0, 0xb7];
/**
 * 保留的 OpenType 特性（设计系统 §2.6）。Noto 的 ccmp 不能丢：「——」是 ccmp 把两个 U+2015 连成一个两字宽的字形，
 * 丢了两段之间就有缝（plan 第 1.2 步在三个引擎上实测）
 */
const GEIST_FEATURES = 'kern,liga,tnum,pnum,ccmp,locl';
const NOTO_FEATURES = 'halt,vhal,palt,vpal,kern,ccmp,locl,vert,vrt2';

const CACHE = 'node_modules/.cache/console-fonts';
const PYTHON = process.env.FONTTOOLS_PYTHON || 'python3';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function fetchPinned(url: string, expected: string): Promise<Buffer> {
  const cached = path.join(CACHE, expected);
  if (fs.existsSync(cached)) {
    const buf = fs.readFileSync(cached);
    if (sha256(buf) === expected) return buf;
  }
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) throw new Error(`${url} 的 sha256 是 ${got}，不是钉死的 ${expected}`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, buf);
  return buf;
}

/** 钉死 head.modified（取上面那个 google/fonts 提交的时间）：同样的输入切出逐字节相同的文件，重跑不白改 sha256 */
const SOURCE_DATE_EPOCH = '1779273373';

function py(args: string[]): string {
  return execFileSync(PYTHON, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, SOURCE_DATE_EPOCH } });
}

/** 切子集 → 收窄字重轴 → 压成 woff2；返回产物 cmap 里的码位 */
function subset(src: string, out: string, codepoints: number[], features: string, wght: string): number[] {
  const tmp = path.join(CACHE, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const unicodes = path.join(tmp, 'unicodes.txt');
  const cut = path.join(tmp, 'subset.ttf');
  const narrowed = path.join(tmp, 'narrowed.ttf');
  fs.writeFileSync(unicodes, codepoints.map((c) => c.toString(16)).join('\n') + '\n');
  py([
    '-m',
    'fontTools.subset',
    src,
    `--unicodes-file=${unicodes}`,
    `--layout-features=${features}`,
    // 全部 name 记录都留着：版权、许可说明（ID 13、14）随字体走
    '--name-IDs=*',
    `--output-file=${cut}`,
  ]);
  py(['-m', 'fontTools.varLib.instancer', cut, `wght=${wght}`, '-q', '-o', narrowed]);
  py(['-m', 'fontTools.ttLib.woff2', 'compress', '-o', out, narrowed]);
  const cmap = py([
    '-c',
    'import sys,json;from fontTools.ttLib import TTFont;print(json.dumps(sorted(TTFont(sys.argv[1]).getBestCmap())))',
    out,
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return JSON.parse(cmap) as number[];
}

async function main(): Promise<void> {
  const tools = JSON.parse(
    py(['-c', 'import json,fontTools,brotli;print(json.dumps({"fonttools":fontTools.version,"brotli":brotli.__version__}))']),
  ) as Record<string, string>;

  const src: Record<keyof typeof SOURCES, string> = { geist: '', geistMono: '', noto: '' };
  for (const [k, s] of Object.entries(SOURCES) as Array<[keyof typeof SOURCES, { url: string; sha256: string }]>) {
    await fetchPinned(s.url, s.sha256);
    src[k] = path.join(CACHE, s.sha256);
  }

  const han = hanChars(uiTexts());
  const notoWanted = [...new Set([...han.keys(), ...cjkPunct(), ...NOTO_SYMBOLS])].toSorted((a, b) => a - b);

  fs.mkdirSync(FONTS_DIR, { recursive: true });
  const fonts: Record<string, FontFile> = {};
  const build = (name: string, family: string, source: string, wanted: number[], features: string, wght: [number, number]) => {
    const out = path.join(FONTS_DIR, name);
    const got = subset(source, out, wanted, features, `${wght[0]}:${wght[1]}`);
    const gotSet = new Set(got);
    const absent = wanted.filter((c) => !gotSet.has(c));
    const buf = fs.readFileSync(out);
    fonts[name] = {
      family,
      weight: `${wght[0]} ${wght[1]}`,
      unicodeRange: toUnicodeRange(got),
      codepoints: got.length,
      bytes: buf.length,
      sha256: sha256(buf),
      ...(absent.length ? { absentInSource: toUnicodeRange(absent) } : {}),
    };
    console.log(`${name}: ${got.length} 个码位，${buf.length} B${absent.length ? `，源字体缺 ${absent.length} 个` : ''}`);
  };
  build(UI_FILES.geist, 'Geist', src.geist, LATIN_UI, GEIST_FEATURES, [400, 600]);
  build(UI_FILES.geistMono, 'Geist Mono', src.geistMono, LATIN_UI, GEIST_FEATURES, [400, 500]);
  build(UI_FILES.noto, 'Noto Sans SC', src.noto, notoWanted, NOTO_FEATURES, [400, 600]);
  // 界面用到的汉字一个都不能缺：源字体没有的字切不出来，只能改文案
  const notoGot = fromUnicodeRange(fonts[UI_FILES.noto].unicodeRange);
  const missingHan = [...han.keys()].filter((c) => !notoGot.has(c));
  if (missingHan.length) throw new Error(`Noto Sans SC 里没有这些字：${String.fromCodePoint(...missingHan)}`);

  fs.mkdirSync(LICENSES_DIR, { recursive: true });
  await fetchPinned(GEIST_MONO_OFL.url, GEIST_MONO_OFL.sha256);
  for (const [name, l] of Object.entries(LICENSES)) fs.writeFileSync(path.join(LICENSES_DIR, name), await fetchPinned(l.url, l.sha256));

  const manifest: FontsManifest = { generatedBy: 'scripts/fonts/build.ts', tools, fonts, licenses: LICENSES };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(FONTS_CSS, fontsCss(manifest, longTailSlices()));
  console.log(`写好 ${MANIFEST}、${FONTS_CSS}、${LICENSES_DIR}/`);
}

await main();
