// UI 优先片的用字（docs/features/console-ux/spec.md「字体与授权义务」、不变量 30）。
// build.ts 按它切 noto-sans-sc-ui.woff2，scripts/check-fonts.ts 按它核对码位清单，两边取同一份文字。
//
// 收的是界面会显示的文字，不收注释：
// - console/index.html（去掉 <!-- --> 注释）；
// - console/src/** 的代码文件：字符串字面量、模板字符串的文字段、JSX 文本；CSS 去掉注释后的全文；
// - src/shared/** 的代码文件，取法同上：console 会 import 它们（报错文案、格式化、界面标签），跳过假包 pack-fixtures/；
// - 各注册行业包的界面配置 src/packs/<包>/console-pack.ts；
// - antd 的 zh_CN 语言包（空状态、分页、确认按钮这些 antd 自己画的字）。
// 都跳过 *.selftest.*：自测里的字不上页面。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

export interface UiText {
  /** 仓库内路径，报错时点名用 */
  file: string;
  text: string;
}

const CODE = /\.(ts|tsx|mts|js|jsx|mjs)$/;
const SELFTEST = /\.selftest\.[a-z]+$/;
const SKIP_DIRS = new Set(['node_modules', 'dist']);

/** 汉字：Unicode 的 Han 书写系统（含扩展区、兼容区和「々〇」） */
export const HAN = /\p{Script=Han}/u;

/**
 * 全部 CJK 标点（设计系统 §2.6 的配方）：不论界面用没用到都进 UI 优先片，
 * 这样所有标点都在同一个文件里，Chromium 才能对每一对连用标点挤压（设计系统 §2.2）。
 */
export const CJK_PUNCT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x2014, 0x2015],
  [0x2018, 0x2019],
  [0x201c, 0x201d],
  [0x2026, 0x2026],
  [0x2e3a, 0x2e3b],
];

/** 由 Noto 画的符号：× – → ⌘ ㎡ ℃（设计系统 §2.1、§2.4） */
export const NOTO_SYMBOLS: readonly number[] = [0x00d7, 0x2013, 0x2192, 0x2318, 0x33a1, 0x2103];

export function cjkPunct(): number[] {
  const out: number[] = [];
  for (const [a, b] of CJK_PUNCT_RANGES) for (let c = a; c <= b; c++) out.push(c);
  return out;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.posix.join(dir, d.name);
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) out.push(...walk(p));
    } else if (d.isFile()) out.push(p);
  }
  return out.toSorted();
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.m?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** 代码文件里会成为字符串值的文字：字面量、模板的文字段、JSX 文本。注释、正则、标识符不算 */
export function codeLiterals(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, scriptKind(file));
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    )
      out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function textOf(file: string, source: string): string {
  if (CODE.test(file)) return codeLiterals(file, source).join('\n');
  if (file.endsWith('.css')) return source.replace(/\/\*[\s\S]*?\*\//g, '');
  if (file.endsWith('.html')) return source.replace(/<!--[\s\S]*?-->/g, '');
  return '';
}

/** antd 语言包里的全部字符串值（函数、数字不算） */
function stringsIn(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((v) => stringsIn(v, seen));
}

export function uiTexts(root = '.'): UiText[] {
  const rel = (p: string) => path.posix.relative(root, p) || p;
  const files = [
    path.posix.join(root, 'console/index.html'),
    ...walk(path.posix.join(root, 'console/src')),
    ...walk(path.posix.join(root, 'src/shared')).filter((f) => !rel(f).startsWith('src/shared/pack-fixtures/')),
    ...walk(path.posix.join(root, 'src/packs')).filter((f) => /^src\/packs\/[^/]+\/console-pack\.ts$/.test(rel(f))),
  ];
  const out: UiText[] = [];
  for (const f of files) {
    if (SELFTEST.test(f) || !fs.existsSync(f)) continue;
    const text = textOf(f, fs.readFileSync(f, 'utf8'));
    if (text) out.push({ file: rel(f), text });
  }
  const antdLocale = createRequire(path.resolve(root, 'console/package.json'))('antd/lib/locale/zh_CN') as { default?: unknown };
  out.push({ file: 'antd/lib/locale/zh_CN', text: stringsIn(antdLocale.default ?? antdLocale).join('\n') });
  return out;
}

/** 界面文字里的每个汉字，连同第一次出现的文件 */
export function hanChars(texts: readonly UiText[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const { file, text } of texts)
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (HAN.test(ch) && !out.has(cp)) out.set(cp, file);
    }
  return out;
}
