// 主题自测（console UX spec 验收 1、不变量 1；design-system §1.2、§1.5、§8）。四件事：
// 1. brand.css 两个块里的变量与 tokens.ts 逐个相同，一个不多、一个不少；
// 2. 写进 antd token 的每个值都原样出现在 theme.getDesignToken() 的结果里（种子色会被算法改掉，见 antd.ts 的 pinSeeds）；
// 3. 两套主题下 §1.2 的每一对：先用 brand.css 的值算，再把同一对换成 antd 令牌（getDesignToken() 的实际输出）算，
//    另加组件令牌的配对（antd.ts 里显式写的值，没写就算失败：不写 antd 会从 colorPrimary 派生）。文字 ≥4.5，控件边界、焦点与状态图形 ≥3；
// 4. theme-boot.js（首帧）与 prefs.ts（页面起来以后）读同一组键、得出同样的属性；localStorage 抛错时照常按浅色；
//    换主题那两帧挂 data-theme-switching，brand.css 按它关掉过渡（主题切换 0ms）；
// 5. 页面里没有拿 colorPrimary 当字色的按钮变体（ghost、color="primary" 的非实心变体），它们不在 3 的配对里；
// 6. ThemeProvider 的接线：用 react-dom/server 渲染它，核对 antd 实际拿到的令牌（含 motion）、wave 与表单的 requiredMark。
// 失败时点名主题、令牌（或组件键）、底和算出来的对比度。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/theme/theme.selftest.ts（ThemeProvider.tsx 要按 react-jsx 编译）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Alert, Button, ConfigProvider, Form, Input, Tabs, theme } from 'antd';
import { createElement, useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ANTD_THEMES, antdTheme } from './antd.js';
import {
  applyPrefs,
  currentThemeState,
  DARK_QUERY,
  readPrefs,
  REDUCED_MOTION_QUERY,
  setAppearance,
  setReduceMotion,
  SWITCHING_ATTR,
} from './prefs.js';
import { ThemeProvider } from './ThemeProvider.js';
import { SHARED, THEMED_KEYS, type ThemeMode, TOKENS } from './tokens.js';

const HERE = import.meta.dirname;
const BRAND_CSS = path.join(HERE, 'brand.css');
const BOOT_JS = path.join(HERE, '..', '..', 'public', 'theme-boot.js');
const MODES: readonly ThemeMode[] = ['light', 'dark'];
const NAME: Record<ThemeMode, string> = { light: '浅色', dark: '深色' };

let pass = 0;
const fails: string[] = [];
function check(ok: boolean, msg: string): void {
  if (ok) pass += 1;
  else fails.push(msg);
}

// ---------------- 颜色与对比度（WCAG 2.x） ----------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(c: string): Rgba {
  const s = c.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length === 6 || h.length === 8) {
      const n = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  throw new Error(`认不出的颜色「${c}」`);
}

/** 半透明色叠到不透明的底上，按浏览器的做法取整到 8 位 */
function over(top: Rgba, base: Rgba): Rgba {
  const mix = (t: number, b: number): number => Math.round(t * top.a + b * (1 - top.a));
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 };
}

/** 从下往上逐层叠合；最底下一层必须不透明 */
function flatten(layers: readonly string[]): Rgba {
  const [first, ...rest] = layers.map(parseColor);
  if (first.a !== 1) throw new Error(`最底层「${layers[0]}」不是不透明色`);
  return rest.reduce((acc, c) => over(c, acc), first);
}

function luminance({ r, g, b }: Rgba): number {
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const a = luminance(fg.a < 1 ? over(fg, bg) : fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const hex = (c: Rgba): string => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// 算法本身先对几组已知值：黑白 21，§1.2 表里的白字对 accent 5.21、深色 text 对 panel 16.00、浅色 text-3 叠 selected·frame 4.86
check(Math.abs(contrast(parseColor('#FFFFFF'), parseColor('#000000')) - 21) < 1e-9, '对比度算法：黑白不是 21');
check(contrast(parseColor('#FFFFFF'), parseColor('#2B63E6')).toFixed(2) === '5.21', '对比度算法：白对 #2B63E6 不是 5.21');
check(contrast(parseColor('#EDEDEF'), parseColor('#121214')).toFixed(2) === '16.00', '对比度算法：#EDEDEF 对 #121214 不是 16.00');
check(contrast(parseColor('#63636B'), flatten(['#F6F6F7', 'rgba(9,9,11,.06)'])).toFixed(2) === '4.86', '对比度算法：叠层不对');

// ---------------- 1. brand.css 与 tokens.ts 逐个相同 ----------------

/** 比较用的规范形：小写、双引号换单引号、空白与逗号收紧、数字写法统一（0.40 与 .4 相同）、三位十六进制展开 */
function norm(v: string): string {
  return v
    .toLowerCase()
    .replaceAll('"', "'")
    .replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, '#$1$1$2$2$3$3')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,()])\s*/g, '$1')
    .replace(/(?<![\w#.])(\d*\.\d+|\d+)/g, (n) => String(Number(n)))
    .trim();
}

function cssBlock(css: string, selector: RegExp): Map<string, string> | null {
  const m = selector.exec(css);
  if (!m) return null;
  const vars = new Map<string, string>();
  for (const decl of m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const d = /^\s*--([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (d) vars.set(d[1], d[2]);
  }
  return vars;
}

const css = fs.readFileSync(BRAND_CSS, 'utf8');
const rootVars = cssBlock(css, /(?:^|\n)\s*:root\s*\{([^}]*)\}/);
const darkVars = cssBlock(css, /:root\[data-theme=['"]?dark['"]?\]\s*\{([^}]*)\}/);
check(rootVars !== null, 'brand.css：找不到 :root { … } 块');
check(darkVars !== null, "brand.css：找不到 :root[data-theme='dark'] { … } 块");

function sameVars(where: string, got: Map<string, string>, want: Readonly<Record<string, string>>, source: string): void {
  for (const [k, v] of Object.entries(want)) {
    const g = got.get(k);
    if (g === undefined) fails.push(`brand.css ${where} 缺 --${k}（${source}：${v}）`);
    else check(norm(g) === norm(v), `brand.css ${where} 的 --${k} 是「${g}」，${source} 是「${v}」`);
  }
  for (const k of got.keys()) check(k in want, `brand.css ${where} 多了 --${k}，tokens.ts 里没有`);
}
if (rootVars) sameVars(':root', rootVars, { ...TOKENS.light, ...SHARED }, 'tokens.ts 浅色');
if (darkVars) sameVars("[data-theme='dark']", darkVars, TOKENS.dark, 'tokens.ts 深色');
check(
  Object.keys(TOKENS.dark).length === THEMED_KEYS.length && THEMED_KEYS.every((k) => k in TOKENS.light && k in TOKENS.dark),
  'tokens.ts：两套令牌的键不一致',
);

/** 页面上生效的变量：浅色取 :root，深色在它上面叠 [data-theme='dark'] */
const CSS_VARS: Record<ThemeMode, Map<string, string>> = {
  light: new Map(rootVars ?? []),
  dark: new Map([...(rootVars ?? []), ...(darkVars ?? [])]),
};

// ---------------- 2. 写进 token 的值原样出现在 getDesignToken() 里 ----------------

type Dict = Readonly<Record<string, unknown>>;
const DESIGN: Record<ThemeMode, Dict> = {
  light: theme.getDesignToken(ANTD_THEMES.light) as unknown as Dict,
  dark: theme.getDesignToken(ANTD_THEMES.dark) as unknown as Dict,
};
for (const mode of MODES) {
  for (const [k, v] of Object.entries(ANTD_THEMES[mode].token ?? {})) {
    const got = DESIGN[mode][k];
    check(
      norm(String(got)) === norm(String(v)),
      `${NAME[mode]} · antd 的 ${k} 写的是 ${String(v)}，getDesignToken() 算出来是 ${String(got)}`,
    );
  }
  const tabs = (ANTD_THEMES[mode].components?.Tabs ?? {}) as Dict;
  check(
    tabs.motionDurationFast === '0s' && tabs.motionDurationMid === '0s' && tabs.motionDurationSlow === '0s',
    `${NAME[mode]} · Tabs 的三档动效时长不全是 0s（页签不带动画）`,
  );
  const reduced = antdTheme(mode, true).token ?? {};
  check(reduced.motion === false && reduced.motionDurationMid === '0s', `${NAME[mode]} · 减少动态效果时 token.motion 不是 false`);
  check(antdTheme(mode, false).token?.motion !== false, `${NAME[mode]} · 没开减少动态效果时 token.motion 却是 false`);
  // §5.4、§5.20：焦点框 2px；分段控件选中段的圈与关着的开关都是 --control-border（对比度在 3 里另算）
  check(
    DESIGN[mode].lineWidthFocus === 2,
    `${NAME[mode]} · antd 的焦点框宽 lineWidthFocus 是 ${String(DESIGN[mode].lineWidthFocus)}，要 2（§5.20）`,
  );
  const comp = (ANTD_THEMES[mode].components ?? {}) as Readonly<Record<string, Dict | undefined>>;
  const border = TOKENS[mode]['control-border'];
  check(
    comp.Segmented?.boxShadowTertiary === `0 0 0 1px ${border}`,
    `${NAME[mode]} · 分段控件选中段的圈（Segmented.boxShadowTertiary）是 ${String(comp.Segmented?.boxShadowTertiary)}，要 1px --control-border（§5.4）`,
  );
  check(
    comp.Switch?.colorTextQuaternary === border,
    `${NAME[mode]} · 开关关着的底（Switch.colorTextQuaternary）是 ${String(comp.Switch?.colorTextQuaternary)}，要 --control-border（§5.4）`,
  );
}

// ---------------- 3. 对比度 ----------------

const TEXT = 4.5;
const GRAPHIC = 3;

interface Pair {
  fg: string;
  bg: readonly string[];
  min: number;
}
const P = (fg: string, bg: readonly string[], min: number): Pair => ({ fg, bg, min });

// §1.2 主表：底写成从下到上的叠层（alpha 色先叠到它所在的底上：hover、subtle 叠 panel，selected 分别叠 frame 与 panel）。
// raised 与 hover·raised 只在深色表里有；浅色 raised 就是白，照样查
const BGS: Readonly<Record<string, readonly string[]>> = {
  panel: ['panel'],
  frame: ['frame'],
  raised: ['raised'],
  hover: ['panel', 'hover'],
  hover·raised: ['raised', 'hover'],
  selected·frame: ['frame', 'selected'],
  selected·panel: ['panel', 'selected'],
  subtle: ['panel', 'subtle'],
  'accent-bg': ['accent-bg'],
};
const FGS: ReadonlyArray<readonly [string, number]> = [
  ['text', TEXT],
  ['text-2', TEXT],
  ['text-3', TEXT],
  ['accent-text', TEXT],
  ['control-border', GRAPHIC],
  ['focus', GRAPHIC],
];
/** control-border 只在它会出现的底上查：输入框不放在 frame、选中导航和 accent-bg 上（§1.2） */
const NOT_FOR_CONTROLS = new Set(['frame', 'selected·frame', 'accent-bg']);

function brandPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const [fg, min] of FGS) {
    for (const [name, layers] of Object.entries(BGS)) {
      if (fg === 'control-border' && NOT_FOR_CONTROLS.has(name)) continue;
      pairs.push(P(fg, layers, min));
    }
  }
  // 语义色：字对 panel / frame / raised、字对自己的底、text-2 对底、圆点对 panel 与底（warning 的圆点是 -icon）
  for (const s of ['success', 'warning', 'danger', 'info', 'neutral']) {
    const bg = `${s}-bg`;
    const dot = s === 'warning' ? 'warning-icon' : `${s}-dot`;
    pairs.push(P(s, ['panel'], TEXT), P(s, ['frame'], TEXT), P(s, ['raised'], TEXT), P(s, [bg], TEXT), P('text-2', [bg], TEXT));
    pairs.push(P(dot, ['panel'], GRAPHIC), P(dot, [bg], GRAPHIC));
  }
  pairs.push(
    P('on-primary', ['primary'], TEXT),
    P('on-primary', ['primary-hover'], TEXT),
    P('on-primary', ['primary-active'], TEXT),
    P('on-accent', ['accent'], GRAPHIC), // 复选框的勾、开关
    P('accent', ['panel'], GRAPHIC),
    P('on-badge', ['badge'], TEXT),
    P('month-on', ['panel', 'month-off'], GRAPHIC),
    P('month-on', ['panel'], GRAPHIC),
    // 回滚弹窗的差异块：删除行是两层 subtle 叠在 raised 上，这里只用 text 与 text-2（§1.2「嵌套的底」）
    P('text', ['raised', 'subtle', 'subtle'], TEXT),
    P('text-2', ['raised', 'subtle', 'subtle'], TEXT),
    // ⌘K 的当前行：--selected 叠在 raised 上；行字 text，右侧补充在当前行上换成 text-2（text-3 在深色这里只有 4.39，第 16 步 axe）
    P('text', ['raised', 'selected'], TEXT),
    P('text-2', ['raised', 'selected'], TEXT),
    // 收起侧栏的当前项靠 control-border 描边和外面的 frame 区分；分段控件的选中段对 subtle 轨道已在主表里（§1.2 按 1.4.11 处理的两处）
    P('control-border', ['frame'], GRAPHIC),
    // 反相 toast 与 Tooltip：--text 底、--panel 色字，成功图标 --toast-icon（§5.15）
    P('panel', ['text'], TEXT),
    P('toast-icon', ['text'], GRAPHIC),
  );
  for (let i = 1; i <= 6; i += 1) pairs.push(P(`av${i}-fg`, [`av${i}-bg`], TEXT));
  return pairs;
}

/** brand 名 → 在 antd 里承载同一个值的全局令牌（§8）；主表与语义色的每一对都换成这些令牌的全部组合再算一遍 */
const ANTD_GLOBAL: Readonly<Record<string, readonly string[]>> = {
  text: ['colorText', 'colorTextHeading'],
  'text-2': ['colorTextSecondary', 'colorTextLabel'],
  'text-3': ['colorTextTertiary', 'colorTextQuaternary', 'colorTextPlaceholder', 'colorTextDisabled', 'colorTextDescription'],
  'accent-text': ['colorPrimaryText', 'colorLink', 'colorLinkHover', 'colorLinkActive'],
  'control-border': ['colorBorder'],
  focus: ['colorPrimaryBorder'],
  accent: ['colorPrimary'],
  panel: ['colorBgContainer'],
  frame: ['colorBgLayout'],
  raised: ['colorBgElevated'],
  hover: ['controlItemBgHover', 'colorFillQuaternary'],
  selected: ['controlItemBgActive', 'colorFillSecondary'],
  subtle: ['colorFillTertiary'],
  'accent-bg': ['colorPrimaryBg'],
  primary: ['colorBgSolid'],
  'primary-hover': ['colorBgSolidHover'],
  'primary-active': ['colorBgSolidActive'],
  'on-primary': ['Button.solidTextColor'],
  success: ['colorSuccess'],
  warning: ['colorWarning'],
  danger: ['colorError'],
  info: ['colorInfo'],
  'success-bg': ['colorSuccessBg'],
  'warning-bg': ['colorWarningBg'],
  'danger-bg': ['colorErrorBg'],
  'info-bg': ['colorInfoBg'],
};

function antdPairs(brand: readonly Pair[]): Pair[] {
  const out: Pair[] = [];
  const combos = (names: readonly string[]): string[][] =>
    names.reduce<string[][]>((acc, n) => acc.flatMap((prefix) => (ANTD_GLOBAL[n] ?? []).map((r) => [...prefix, r])), [[]]);
  for (const p of brand) {
    if (![p.fg, ...p.bg].every((n) => n in ANTD_GLOBAL)) continue;
    for (const fg of ANTD_GLOBAL[p.fg]) for (const bg of combos(p.bg)) out.push(P(fg, bg, p.min));
  }
  return out;
}

// 组件令牌的配对：组件在它实际的底上。组件键（带点的）必须在 antd.ts 里显式写出
const COMPONENT_PAIRS: readonly Pair[] = [
  // 侧栏菜单：外壳的 Sider 是 frame 底；现在的 Shell 用浅色 Sider（panel 底），第 2.2 步换外壳之前两种底都查
  ...['Layout.siderBg', 'colorBgContainer'].flatMap((base) => [
    P('Menu.itemColor', [base], TEXT),
    P('Menu.itemHoverColor', [base, 'Menu.itemHoverBg'], TEXT),
    P('Menu.itemHoverColor', [base, 'Menu.itemActiveBg'], TEXT),
    P('Menu.itemSelectedColor', [base, 'Menu.itemSelectedBg'], TEXT),
    P('Menu.groupTitleColor', [base], TEXT),
  ]),
  P('Button.defaultColor', ['Button.defaultBg'], TEXT),
  P('Button.defaultHoverColor', ['Button.defaultHoverBg'], TEXT),
  P('Button.defaultActiveColor', ['Button.defaultActiveBg'], TEXT),
  P('Button.solidTextColor', ['colorBgSolid'], TEXT),
  P('Button.solidTextColor', ['colorBgSolidHover'], TEXT),
  P('Button.solidTextColor', ['colorBgSolidActive'], TEXT),
  P('Button.textTextColor', ['colorBgContainer'], TEXT),
  P('Button.textTextColor', ['colorBgContainer', 'Button.textHoverBg'], TEXT),
  // 带 danger 的默认按钮（话术页「丢弃草稿」）：悬停、按下的字色由算法从 colorError 派生
  P('colorErrorHover', ['colorBgContainer'], TEXT),
  P('colorErrorActive', ['colorBgContainer'], TEXT),
  // colorPrimary 实心底上的白字：页面自己的按钮已经没有 type="primary"（第 2.3 步，scripts/check-console-src.ts 查），
  // 01 的 rjsf 表单（第 10.3 步删了）之外，antd 组件内部用主色实底的地方照样按这几对核对
  P('colorTextLightSolid', ['colorPrimary'], TEXT),
  P('colorTextLightSolid', ['colorPrimaryHover'], TEXT),
  P('colorTextLightSolid', ['colorPrimaryActive'], TEXT),
  P('colorWhite', ['colorPrimary'], GRAPHIC), // 复选框的勾
  P('Switch.handleBg', ['colorPrimary'], GRAPHIC),
  P('Tabs.itemColor', ['colorBgContainer'], TEXT),
  P('Tabs.itemHoverColor', ['colorBgContainer'], TEXT),
  P('Tabs.itemSelectedColor', ['colorBgContainer'], TEXT),
  P('Tabs.itemActiveColor', ['colorBgContainer'], TEXT),
  P('Tabs.inkBarColor', ['colorBgContainer'], GRAPHIC),
  P('Segmented.itemColor', ['colorBgContainer', 'Segmented.trackBg'], TEXT),
  P('Segmented.itemHoverColor', ['colorBgContainer', 'Segmented.trackBg', 'Segmented.itemHoverBg'], TEXT),
  P('Segmented.itemSelectedColor', ['Segmented.itemSelectedBg'], TEXT),
  // 选中段的圈（§5.4、§1.2 的 1.4.11）：圈把滑块和外面的轨道（subtle 叠 panel）分开，对轨道 ≥3:1
  P('Segmented.boxShadowTertiary', ['colorBgContainer', 'Segmented.trackBg'], GRAPHIC),
  // 开关关着的底（§5.4）：放在 panel 上（审计页的「显示登录记录」、样张），关着的白色滑块叠在它上面
  P('Switch.colorTextQuaternary', ['colorBgContainer'], GRAPHIC),
  P('Switch.handleBg', ['Switch.colorTextQuaternary'], GRAPHIC),
  P('Tag.defaultColor', ['colorBgContainer', 'Tag.defaultBg'], TEXT),
  P('Table.headerColor', ['colorBgContainer', 'Table.headerBg'], TEXT),
  P('colorText', ['colorBgContainer', 'Table.rowHoverBg'], TEXT),
  P('colorText', ['colorBgContainer', 'Table.rowSelectedBg'], TEXT),
  P('colorText', ['colorBgContainer', 'Table.rowSelectedHoverBg'], TEXT),
  P('colorText', ['colorBgElevated', 'Select.optionActiveBg'], TEXT),
  P('Select.hoverBorderColor', ['colorBgContainer'], GRAPHIC),
  P('Select.activeBorderColor', ['colorBgContainer'], GRAPHIC),
  P('Input.hoverBorderColor', ['colorBgContainer'], GRAPHIC),
  P('Input.activeBorderColor', ['colorBgContainer'], GRAPHIC),
  P('colorText', ['Modal.contentBg'], TEXT),
  P('colorTextSecondary', ['Modal.contentBg'], TEXT),
  P('colorText', ['Modal.footerBg'], TEXT),
  P('Tooltip.colorTextLightSolid', ['colorBgSpotlight'], TEXT),
  P('Message.colorText', ['Message.contentBg'], TEXT),
  P('Message.colorTextHeading', ['Message.contentBg'], TEXT), // 6.6.5 的提示文字实际取这个（走查实测）
  P('Message.colorSuccess', ['Message.contentBg'], GRAPHIC),
  // 页面只经 toast() 报成功（第 2.3 步）；其余类型的图标色照旧钉住，contentBg 对所有 message 生效，loading 图标取 colorInfo
  P('Message.colorError', ['Message.contentBg'], GRAPHIC),
  P('Message.colorInfo', ['Message.contentBg'], GRAPHIC),
  P('Message.colorWarning', ['Message.contentBg'], GRAPHIC),
  // Alert 的 warning 图标用 --warning-icon（§5.12），叠在 warning-bg 上
  P('Alert.colorWarning', ['colorWarningBg'], GRAPHIC),
  P('Pagination.itemActiveColor', ['colorBgContainer', 'Pagination.itemActiveBg'], TEXT),
  P('Pagination.itemActiveColorHover', ['colorBgContainer', 'Pagination.itemActiveBg'], TEXT),
];

type Resolve = (ref: string) => string;

function cssResolver(mode: ThemeMode): Resolve {
  return (ref) => {
    const v = CSS_VARS[mode].get(ref);
    if (v === undefined) throw new Error(`brand.css 没有 --${ref}`);
    return v;
  };
}

function antdResolver(mode: ThemeMode): Resolve {
  const components = (ANTD_THEMES[mode].components ?? {}) as Readonly<Record<string, Dict | undefined>>;
  return (ref) => {
    const dot = ref.indexOf('.');
    const v = dot < 0 ? DESIGN[mode][ref] : components[ref.slice(0, dot)]?.[ref.slice(dot + 1)];
    if (typeof v !== 'string') throw new Error(`${ref} 没有显式写成颜色（antd.ts），antd 会自己派生`);
    // 1px 的圈（Segmented 的 boxShadowTertiary）：取圈的颜色
    return /^0 0 0 1px (\S+)$/.exec(v)?.[1] ?? v;
  };
}

function checkPairs(mode: ThemeMode, source: string, pairs: readonly Pair[], resolve: Resolve, prefix = ''): void {
  for (const p of pairs) {
    const label = `${NAME[mode]} · ${source} ${prefix}${p.fg} 对 ${p.bg.map((b) => prefix + b).join(' 上叠 ')}`;
    try {
      const fg = parseColor(resolve(p.fg));
      const bg = flatten(p.bg.map(resolve));
      const ratio = contrast(fg, bg);
      check(ratio >= p.min, `${label}：${resolve(p.fg)} 对 ${hex(bg)} 只有 ${ratio.toFixed(2)}，要 ≥${p.min}`);
    } catch (e) {
      fails.push(`${label}：${(e as Error).message}`);
    }
  }
}

const BRAND = brandPairs();
const ANTD = antdPairs(BRAND);
for (const mode of MODES) {
  checkPairs(mode, 'brand.css', BRAND, cssResolver(mode), '--');
  checkPairs(mode, 'antd', ANTD, antdResolver(mode));
  checkPairs(mode, 'antd', COMPONENT_PAIRS, antdResolver(mode));
}

// ---------------- 4. theme-boot.js 与 prefs.ts 对拍 ----------------

const BOOT = fs.readFileSync(BOOT_JS, 'utf8');

/** 'blocked'：读 window.localStorage 就抛错（无痕模式、禁用了存储） */
type Store = Map<string, string> | 'blocked';

interface Env {
  attrs: Map<string, string>;
  window: object;
  document: object;
  /** 跑一帧：执行此刻排着的 requestAnimationFrame 回调（回调里再排的留到下一帧） */
  frame: () => void;
}

function makeEnv(store: Store, systemDark: boolean, systemReduced = false): Env {
  const attrs = new Map<string, string>();
  let queued: Array<() => void> = [];
  const storage = {
    getItem: (k: string): string | null => (store === 'blocked' ? null : (store.get(k) ?? null)),
    setItem: (k: string, v: string): void => {
      if (store !== 'blocked') store.set(k, String(v));
    },
  };
  const noop = (): void => {};
  const win = {
    get localStorage() {
      if (store === 'blocked') throw new Error('SecurityError：存储被禁用');
      return storage;
    },
    matchMedia: (q: string) => ({
      matches: q === DARK_QUERY ? systemDark : q === REDUCED_MOTION_QUERY ? systemReduced : false,
      addEventListener: noop,
      removeEventListener: noop,
    }),
    addEventListener: noop,
    removeEventListener: noop,
    requestAnimationFrame: (cb: () => void): number => queued.push(cb),
  };
  const documentElement = {
    setAttribute: (k: string, v: string): void => void attrs.set(k, String(v)),
    removeAttribute: (k: string): void => void attrs.delete(k),
    getAttribute: (k: string): string | null => attrs.get(k) ?? null,
  };
  const frame = (): void => {
    const run = queued;
    queued = [];
    for (const cb of run) cb();
  };
  return { attrs, window: win, document: { documentElement }, frame };
}

const show = (e: Env): string =>
  `data-theme=${e.attrs.get('data-theme') ?? '无'} data-reduce-motion=${e.attrs.get('data-reduce-motion') ?? '无'}`;

function boot(store: Store, systemDark: boolean): string {
  const env = makeEnv(store, systemDark);
  try {
    vm.runInNewContext(BOOT, { window: env.window, document: env.document });
  } catch (e) {
    return `抛错：${(e as Error).message}`;
  }
  return show(env);
}

/** 让 prefs.ts 在这个环境里跑：它用的是全局的 window 与 document */
function install(env: Env): Env {
  Object.assign(globalThis, { window: env.window, document: env.document });
  return env;
}

function viaPrefs(store: Store, systemDark: boolean): string {
  const env = install(makeEnv(store, systemDark));
  try {
    applyPrefs(readPrefs());
  } catch (e) {
    return `抛错：${(e as Error).message}`;
  }
  return show(env);
}

const storeOf = (appearance?: string, reduce?: string): Map<string, string> => {
  const m = new Map<string, string>();
  if (appearance !== undefined) m.set('console.appearance', appearance);
  if (reduce !== undefined) m.set('console.reduceMotion', reduce);
  return m;
};

// 两边在全部组合上得出同样的属性
for (const appearance of [undefined, 'light', 'dark', 'system', 'Dark', '']) {
  for (const reduce of [undefined, 'true', 'false', '1']) {
    for (const systemDark of [false, true]) {
      const a = boot(storeOf(appearance, reduce), systemDark);
      const b = viaPrefs(storeOf(appearance, reduce), systemDark);
      check(a === b, `theme-boot.js 与 prefs.ts 不一致（外观=${appearance}，减少动效=${reduce}，系统深色=${systemDark}）：${a} ≠ ${b}`);
    }
  }
}
for (const systemDark of [false, true]) {
  check(boot('blocked', systemDark) === viaPrefs('blocked', systemDark), 'theme-boot.js 与 prefs.ts 在存储被禁用时不一致');
}

// 期望值：默认浅色；「跟随系统」随系统；不认识的值按浅色；存储被禁用照常按浅色、不抛错
const expect = (got: string, want: string, what: string): void => check(got === want, `theme-boot.js ${what}：${got}，应为 ${want}`);
expect(boot(storeOf(), true), 'data-theme=light data-reduce-motion=无', '没存过偏好（系统是深色也按浅色）');
expect(boot(storeOf('dark'), false), 'data-theme=dark data-reduce-motion=无', '存了深色');
expect(boot(storeOf('system'), true), 'data-theme=dark data-reduce-motion=无', '跟随系统、系统深色');
expect(boot(storeOf('system'), false), 'data-theme=light data-reduce-motion=无', '跟随系统、系统浅色');
expect(boot(storeOf('purple'), true), 'data-theme=light data-reduce-motion=无', '存了不认识的值');
expect(boot(storeOf('light', 'true'), false), 'data-theme=light data-reduce-motion=true', '开了减少动态效果');
expect(boot('blocked', true), 'data-theme=light data-reduce-motion=无', '读 localStorage 抛错');

// 往返：prefs.ts 写进去的，theme-boot.js 下次首帧读得出来
{
  const store = new Map<string, string>();
  const env = install(makeEnv(store, true));
  setAppearance('dark');
  setReduceMotion(true);
  check(show(env) === 'data-theme=dark data-reduce-motion=true', `prefs.ts 设了深色与减少动效，页面上是 ${show(env)}`);
  expect(boot(store, false), 'data-theme=dark data-reduce-motion=true', '读 prefs.ts 存的深色与减少动效');
  setAppearance('system');
  expect(boot(store, true), 'data-theme=dark data-reduce-motion=true', '读 prefs.ts 存的跟随系统（系统深色）');
  expect(boot(store, false), 'data-theme=light data-reduce-motion=true', '读 prefs.ts 存的跟随系统（系统浅色）');
  setAppearance('light');
  setReduceMotion(false);
  expect(boot(store, true), 'data-theme=light data-reduce-motion=无', '读 prefs.ts 存的浅色、关掉减少动效');
}
// 存储被禁用：切换不抛错，本页照样生效；下次首帧回到浅色
{
  const env = install(makeEnv('blocked', false));
  try {
    setAppearance('dark');
    check(show(env).startsWith('data-theme=dark'), `存储被禁用时切到深色，页面上是 ${show(env)}`);
  } catch (e) {
    fails.push(`存储被禁用时 setAppearance 抛错：${(e as Error).message}`);
  }
}
// 系统设了减少动态效果：没开菜单开关也算开着（antd 的 motion 跟着关）
{
  install(makeEnv(storeOf(), false, true));
  applyPrefs(readPrefs());
  check(currentThemeState().reduceMotion, '系统设了 prefers-reduced-motion，currentThemeState().reduceMotion 却是 false');
}
// 主题切换 0ms：data-theme 真变了才挂 data-theme-switching，新颜色那一帧还挂着，第二帧后拿掉；连着切以最后一次为准
{
  const env = install(makeEnv(storeOf('light'), false));
  const switching = (): boolean => env.attrs.get(SWITCHING_ATTR) === 'true';
  setAppearance('light');
  env.frame();
  env.frame();
  check(!switching(), `两帧之后 ${SWITCHING_ATTR} 还挂着`);
  setAppearance('light');
  check(!switching(), `主题没变也挂了 ${SWITCHING_ATTR}`);
  setAppearance('dark');
  check(switching() && env.attrs.get('data-theme') === 'dark', `换成深色时没挂 ${SWITCHING_ATTR}（antd 控件的颜色会渐变过去）`);
  env.frame();
  check(switching(), `换主题后第一帧就拿掉了 ${SWITCHING_ATTR}（新颜色那一帧还会有过渡）`);
  setAppearance('light');
  env.frame();
  check(switching(), `连着切两次，前一次的计时拿掉了后一次的 ${SWITCHING_ATTR}`);
  env.frame();
  check(!switching(), `连着切两次，最后一次的两帧之后 ${SWITCHING_ATTR} 还挂着`);
}
{
  const sel = `:root\\[${SWITCHING_ATTR}\\]`;
  const rule = new RegExp(`${sel} \\*,\\s*${sel} \\*::before,\\s*${sel} \\*::after\\s*\\{\\s*transition:\\s*none\\s*!important;?\\s*\\}`);
  check(rule.test(css), `brand.css 缺 ${SWITCHING_ATTR} 那条规则（换主题那几帧 *、::before、::after 都 transition: none !important）`);
}

// ---------------- 5. 没有拿 colorPrimary 当字色的按钮 ----------------
// ghost 与 color="primary" 的非实心变体，字和描边取 colorPrimary / Hover / Active：深色下叠在 raised 上只有 3.52、2.84、2.26，
// 只够图形不够文字。实心的 type="primary" 由 3 里 colorTextLightSolid 那几对管。ghost 放在默认按钮上是白字透明底，同样不行

/** 源码里每个 <名字 …> 开始标签的全文：跳过 {…} 与引号里的内容，箭头函数的 > 不算标签结束 */
function jsxTags(src: string, name: string): string[] {
  const tags: string[] = [];
  for (const m of src.matchAll(new RegExp(`<${name}(?![\\w.])`, 'g'))) {
    let depth = 0;
    let i = m.index + m[0].length;
    // 带类型参数的写法 <Segmented<DiffMode> …>：先跳过类型参数
    if (src[i] === '<') i = src.indexOf('>', i) + 1;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        const end = src.indexOf(c, i + 1);
        if (end < 0) break;
        i = end;
      } else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(src.slice(m.index, i + 1));
  }
  return tags;
}
{
  const srcDir = path.join(HERE, '..');
  let scanned = 0;
  for (const rel of fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith('.tsx')) continue;
    for (const tag of jsxTags(fs.readFileSync(path.join(srcDir, rel), 'utf8'), 'Button')) {
      scanned += 1;
      const primary = /\s(?:type|color)=(?:"primary"|'primary'|\{\s*['"]primary['"]\s*\})/.test(tag);
      const hollow = /\svariant=(?:"|'|\{\s*['"])(?!solid['"])/.test(tag);
      const ghost = /\sghost(?=[\s/>=])/.test(tag);
      check(
        !ghost && !(primary && hollow),
        `${rel} 的 ${tag.replace(/\s+/g, ' ')}：字色取 colorPrimary，深色下对比不到 4.5（改成默认按钮或实心主按钮）`,
      );
    }
  }
  check(scanned > 0, '5：console/src 里一个 <Button> 都没扫到，扫描写错了');
}

// ---------------- 5b. 分段控件与 antd 焦点框（第 16 步） ----------------
// rc-segmented 1.4.0 给整条轨道也放了 tabIndex 0：Tab 先停在轨道上，那一站方向键不起作用，要再按一次 Tab 才进选中的那一段。
// 每个 <Segmented> 都传 tabIndex={-1}，Tab 直接进选中的那一段（没选的时候进第一段）
{
  const srcDir = path.join(HERE, '..');
  let scanned = 0;
  for (const rel of fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith('.tsx') || rel.includes('selftest')) continue;
    for (const tag of jsxTags(fs.readFileSync(path.join(srcDir, rel), 'utf8'), 'Segmented')) {
      scanned += 1;
      check(/\stabIndex=\{-1\}/.test(tag), `${rel} 的 ${tag.replace(/\s+/g, ' ')}：没传 tabIndex={-1}，Tab 会先停在整条轨道上`);
    }
  }
  check(scanned > 0, '5b：console/src 里一个 <Segmented> 都没扫到，扫描写错了');
}
{
  // 令牌给不了的两处写在 brand.css：antd 焦点框的偏移 2（它写死成 1），分段控件选中段字重 500
  const rule = (selector: string, body: RegExp, src: string = css): boolean => {
    for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sels = m[1]!.split(',').map((x) => x.replace(/\/\*[\s\S]*?\*\//g, '').trim());
      if (sels.includes(selector) && body.test(m[2]!)) return true;
    }
    return false;
  };
  for (const sel of [
    '.ant-btn:not(:disabled):focus-visible',
    '.ant-switch:focus-visible',
    '.ant-segmented .ant-segmented-item-focused',
    '.ant-tabs .ant-tabs-tab.ant-tabs-tab-focus .ant-tabs-tab-btn:focus-visible',
  ]) {
    check(rule(sel, /outline-offset:\s*2px/), `brand.css 没给 ${sel} 写 outline-offset: 2px（antd 写死 1，§3 要 2）`);
  }
  check(
    rule('.ant-segmented .ant-segmented-item:has(.ant-segmented-item-input:focus-visible)', /outline:\s*2px solid var\(--focus\)/),
    'brand.css 没给分段控件里键盘停着的那一段画焦点框（一段都没选时 rc-segmented 不画）',
  );
  check(
    rule('.ant-tabs .ant-tabs-content:focus-visible', /outline-offset:\s*-2px/),
    'brand.css 没给页签的面板写 outline-offset: -2px（§3 容器）',
  );
  check(
    rule('.ant-segmented .ant-segmented-item-selected', /font-weight:\s*500/),
    'brand.css 没给分段控件的选中段写 font-weight: 500（§5.4）',
  );
  // 页签条的 nav-wrap 是 overflow: hidden：左右垫 4、负外边距抵掉，第一个页签的焦点框（伸出去 4）才画得全
  for (const sel of ['.ant-tabs-top > .ant-tabs-nav .ant-tabs-nav-wrap', '.ant-tabs-bottom > .ant-tabs-nav .ant-tabs-nav-wrap']) {
    check(
      rule(sel, /padding-inline:\s*4px/) && rule(sel, /margin-inline:\s*-4px/),
      `brand.css 没给 ${sel} 垫 4、抵 −4（第一个页签的焦点框左边被裁掉）`,
    );
  }
  // ⌘K 的当前行（上面对比度表里那两对的出处）：底是 --selected，右侧补充换成 text-2
  const shellCss = fs.readFileSync(path.join(HERE, '..', 'shell', 'shell.css'), 'utf8');
  check(rule('.cmdk-row.is-active', /background:\s*var\(--selected\)/, shellCss), 'shell.css 的 ⌘K 当前行底不是 var(--selected)');
  check(
    rule('.cmdk-row.is-active .cmdk-hint', /color:\s*var\(--text-2\)/, shellCss),
    'shell.css 没把 ⌘K 当前行的补充换成 text-2（text-3 在深色的 selected·raised 上只有 4.39）',
  );
}

// ---------------- 6. ThemeProvider 的接线 ----------------
// <html> 上的两个属性 → antd 实际拿到的令牌（全局令牌逐个对 antdTheme() 的结果，含 motion 与三档时长）、wave 关掉、
// 表单必填项不画星号（antd 给 label 加 required-mark-optional，星号的 ::before 不显示）且不加「（选填）」，选填项加
// 按钮不在两个汉字之间插空格（第 1.3 步：antd 默认把「关闭」渲染成「关 闭」）

interface Seen {
  wave: unknown;
  token: Dict;
}
/** 渲染时把 antd 实际拿到的 wave 与令牌交给 report */
function Probe({ report }: { report: (seen: Seen) => void }) {
  const { wave } = useContext(ConfigProvider.ConfigContext);
  const { token } = theme.useToken();
  report({ wave, token: token as unknown as Dict });
  return createElement(
    Form,
    null,
    createElement(Form.Item, { label: '名称', name: 'a', required: true }, createElement(Input)),
    createElement(Form.Item, { label: '备注', name: 'b' }, createElement(Input)),
    createElement(Button, null, '关闭'),
    ...ALERT_TYPES.map((type) => createElement(Alert, { key: type, type, showIcon: true, title: '提示' })),
    createElement(Tabs, { items: [{ key: 'a', label: '甲' }] }),
  );
}
/** Alert 的四种图标（§5.12）：lucide 的 info、circle-check、triangle-alert、circle-alert，装饰性的（读屏不念英文名） */
const ALERT_TYPES = ['info', 'success', 'warning', 'error'] as const;
const ALERT_ICONS = ['info', 'circle-check', 'triangle-alert', 'circle-alert'];
for (const mode of MODES) {
  for (const reduce of [false, true]) {
    const env = install(makeEnv(storeOf(), false));
    env.attrs.set('data-theme', mode);
    if (reduce) env.attrs.set('data-reduce-motion', 'true');
    const label = `ThemeProvider（${NAME[mode]}${reduce ? '、减少动态效果' : ''}）`;
    let seen: Seen | undefined;
    let html = '';
    try {
      const report = (s: Seen): void => {
        seen = s;
      };
      html = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(Probe, { report })));
    } catch (e) {
      fails.push(`${label}：渲染抛错 ${(e as Error).message}`);
      continue;
    }
    const want = theme.getDesignToken(antdTheme(mode, reduce)) as unknown as Dict;
    for (const k of new Set(['motion', ...Object.keys(antdTheme(mode, reduce).token ?? {})])) {
      const got = seen?.token[k];
      check(norm(String(got)) === norm(String(want[k])), `${label}：antd 拿到的 ${k} 是 ${String(got)}，应为 ${String(want[k])}`);
    }
    check((seen?.wave as { disabled?: unknown } | undefined)?.disabled === true, `${label}：wave 没关（§8 wave.disabled）`);
    const labels = new Map(
      [...html.matchAll(/<label\b[^>]*\bfor="(\w+)"[^>]*\bclass="([^"]*)"[^>]*>([\s\S]*?)<\/label>/g)].map((m) => [m[1], m]),
    );
    const req = labels.get('a');
    const opt = labels.get('b');
    check(
      req !== undefined && /\bant-form-item-required-mark-optional\b/.test(req[2]) && !req[3].includes('选填'),
      `${label}：必填项的 label 是 ${req?.[0] ?? '无'}，应不画星号、不加「（选填）」`,
    );
    const button = /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
    check(
      button === '<span>关闭</span>',
      `${label}：按钮「关闭」渲染成 ${button || '无'}，两个汉字之间不该插空格（button.autoInsertSpace）`,
    );
    check(
      opt !== undefined && opt[3].endsWith('<span class="optional-mark">（选填）</span>'),
      `${label}：选填项的 label 是 ${opt?.[0] ?? '无'}，应在后面加 <span class="optional-mark">（选填）</span>`,
    );
    const icons = [...html.matchAll(/<span class="ant-alert-icon[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]!);
    const lucide = icons.map((i) => /<svg\b[^>]*\bclass="lucide lucide-([a-z-]+)[^"]*"/.exec(i)?.[1] ?? i.slice(0, 60));
    check(
      JSON.stringify(lucide) === JSON.stringify(ALERT_ICONS) &&
        icons.every((i) => /<svg\b[^>]*\baria-hidden="true"/.test(i) && !i.includes('role="img"') && !i.includes('aria-label')),
      `${label}：Alert 的图标是 ${JSON.stringify(lucide)}，应为 lucide 的 ${ALERT_ICONS.join('、')}，aria-hidden，没有 role=img 与英文名字`,
    );
    // 页签排不下时露出的「更多」按钮，读屏名字取自里面的图标：要是中文的「更多」，不是 antd 图标的 ellipsis
    const more = /<button[^>]*class="ant-tabs-nav-more"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
    check(
      /role="img" aria-label="更多"/.test(more) && /lucide-ellipsis/.test(more) && !/aria-label="ellipsis"/.test(more),
      `${label}：页签的「更多」按钮里是 ${more.slice(0, 160) || '无'}，名字应为「更多」（lucide ellipsis），不是英文 ellipsis`,
    );
  }
}

if (fails.length) {
  console.error(`THEME SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 20)) console.error('  ✗ ' + f);
  if (fails.length > 20) console.error(`  …另有 ${fails.length - 20} 项`);
  process.exit(1);
}
console.log(
  `THEME SELFTEST PASS: ${pass} 项断言全通（brand.css 与令牌一致 / antd 令牌原样生效 / 两套主题 ${BRAND.length}+${ANTD.length}+${COMPONENT_PAIRS.length} 对对比度 / 首帧脚本与偏好对拍 / 换主题不过渡 / 按钮变体 / ThemeProvider 接线）`,
);
