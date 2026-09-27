// console 生产构建产物的检查（01 spec 验收 17）：浏览器包里不能混进服务端的数据库驱动与 Node 内置模块。
// 另查首帧主题脚本的加载方式（console UX spec 第 1.1 步）。
// 另查样张页没有混进生产产物（console UX spec 不变量 25：/_specimen 只在 VITE_SPECIMEN=1 的构建里注册，第 1.3 步）。
// 另查 ⌘K 的拼音库不在入口集合里（第 2.2 步）。
// 另查拆包后的预算与禁入内容（console UX spec「性能」、不变量 25，第 2.4 步）：读 console/build-meta/ 下 vite 的
// manifest.json（块与块的引用）和 modules.json（每块的模块），两份都由 console/vite.config.ts 的 buildMeta 写、不留在 dist 里；
// 算首屏与每次换页的 JS、首屏字体，查入口集合里没有页面代码，@codemirror 只能经话术页的块下载，产物里没有样张页、
// 假包的模块和第三方字体域名，CSS 里没有 data: 的 url()。
// 另按文字查假包（不变量 25，第 3.3 步）：模块清单只认得出从 src/shared/pack-fixtures/ 进来的模块，内容被抄进别的文件就看不见。
// 所以把每个 JS 块用 TypeScript 的解析器读一遍，取出全部字符串字面量与模板字符串的文字段（转义已经解开），
// 与假包里「认得出是它」的字符串逐个整串比对：假包配置里的全部字符串值，去掉注册包里也有的（「基本信息」「subItems」这类），
// 去掉不到 3 个字符的（「业主」「方案」这类常用词，界面以后可能自己要用）和纯小写的英文单词（kind、分组 key、图标名，依赖库里到处都有）。
// 另要求同一个解析在产物里找得到界面自己的字「等人接手」，否则这条检查是空的；再拿一段拼出来的假块做正对照：全部标记串按压缩器的
// 三种写法（双引号、反引号、插值之间的文字段）写进去，同一套取法与比对要一个不漏地找出来，否则比对本身坏了。
// 挂在 `pnpm test` 末尾、紧跟 `pnpm --filter console build`。
// 包名按子串查；Node 内置模块只查带引号的模块名（"node:crypto"），压缩后的对象键 {node:x} 不算。
// assets/ 下每个文件名都要带 vite 的内容哈希（<name>-<8 位>.<扩展名>）：服务端给 /console/assets/* 一律一年的 immutable
// 缓存（src/shared/security-headers.ts），不带哈希的文件混进来，改了内容浏览器也不会重新下载（后台 UX spec 不变量 26）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import ts from 'typescript';
import { PACK_IDS, packById } from '../src/packs/registry.js';

const DIST = path.join('console', 'dist');
/** 构建的元数据：vite 的 manifest 与每块的模块清单（console/vite.config.ts 的 buildMeta 写），不随产物发布 */
const META = path.join('console', 'build-meta');
const BANNED = ['drizzle-orm', 'pg-protocol', '@electric-sql/pglite'];
const NODE_BUILTIN = /["'`]node:[a-z_/]+/;
/** 样张页的路由、样式类名和「不挤压」对照行：生产构建里这些分支连同页面代码一起被摇掉，出现就是条件没在构建时定下来 */
const SPECIMEN_MARKERS = ['_specimen', 'spec-panel', 'space-all'];
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
/** CSS 里的 data: 地址，带不带引号、括号里有没有空白都算 */
const CSS_DATA_URL = /url\(\s*['"]?\s*data:/i;
/** 生产页面只从本站加载字体（不变量 29） */
const THIRD_PARTY_FONTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/**
 * 预算（spec「性能」），单位字节。JS 按 gzip 算，用 zlib 的默认级别，与 host 的 Hono compress（CompressionStream）
 * 实际发出去的一样；vite 构建日志里的 gzip 数字算法不同，不作准。字体按文件原样的大小（woff2 不再压缩）
 */
const BUDGET = {
  /** 打开总览：入口、它的静态依赖、总览路由的块 */
  firstScreenJs: 420_000,
  /** 任意一次站内导航额外下载的 JS */
  navJs: 250_000,
  fonts: { 'geist-ui.woff2': 16_384, 'geist-mono-ui.woff2': 12_288, 'noto-sans-sc-ui.woff2': 280_000 } as Record<string, number>,
  /** preload 的两个字体合计 */
  preloadFonts: 300_000,
};
/** 首屏 preload 的字体只有这两个（spec「字体与授权义务」） */
const PRELOAD_FONTS = ['geist-ui.woff2', 'noto-sans-sc-ui.woff2'];
/** 总览路由的懒加载文件（第 4 步加）：有了就算进首屏；在那之前 / 重定向到销售话术，首屏只算入口集合 */
const OVERVIEW = 'src/pages/overview.lazy.tsx';
/** 话术页的懒加载文件：@codemirror 只能经它下载 */
const SOP = 'src/pages/sop.lazy.tsx';
/** 路由的懒加载文件（router.tsx 的 .lazy()）：manifest 里这些动态入口按「换页」算预算 */
const ROUTE_CHUNK = /^src\/(pages|_specimen)\/[^/]+\.lazy\.tsx$/;
/** 入口集合里准许出现的页面模块：登录页由外壳直接渲染，不是路由 */
const ENTRY_PAGES_OK = new Set(['src/pages/LoginPage.tsx']);

function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`console-dist: ${DIST}/index.html 不存在，先跑 pnpm --filter console build`);
  process.exit(1);
}
const bad: string[] = [];
const all = files(DIST);
for (const f of all) {
  if (f.endsWith('.woff2')) continue; // 文本扫描跳过字体（spec「性能」）
  const text = fs.readFileSync(f, 'utf8');
  for (const b of BANNED) if (text.includes(b)) bad.push(`${f}: ${b}`);
  const m = NODE_BUILTIN.exec(text);
  if (m) bad.push(`${f}: ${m[0]}`);
  for (const mk of SPECIMEN_MARKERS) if (text.includes(mk)) bad.push(`${f}: 样张页的内容（${mk}）混进了生产产物`);
  for (const d of THIRD_PARTY_FONTS) if (text.includes(d)) bad.push(`${f}: 引用了第三方字体域名 ${d}，字体只从本站加载`);
  // assetsInlineLimit: 0 生效的证据：小于 4 KB 的长尾分片也是单独的文件，没被写成 data: 进 CSS（font-src 'self' 会拦下）。
  // 带引号的也算：data: 里有空格时压缩后留着引号，url("data:…")；CSP 没写 img-src，data: 图片同样被 default-src 'self' 拦下
  if (f.endsWith('.css') && CSS_DATA_URL.test(text)) {
    bad.push(`${f}: CSS 里有 data: 的 url()（console/vite.config.ts 的 assetsInlineLimit 要是 0；页面 CSP 会拦下它）`);
  }
}
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
if (!html.includes('/console/assets/')) bad.push(`${DIST}/index.html: 资源路径不在 /console/assets/ 下（vite 的 base 不对）`);

// 首帧主题脚本（console UX spec「视觉与字体 · 主题」）：<head> 里同步加载 /console/theme-boot.js，排在应用脚本前面，
// 深色刷新才不闪白；页面 CSP 是 script-src 'self'，所以不能有内联脚本
const BOOT = '/console/theme-boot.js';
if (!fs.existsSync(path.join(DIST, 'theme-boot.js'))) bad.push(`${DIST}/theme-boot.js 不存在（console/public/theme-boot.js 没进产物）`);
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
if (scripts.some((s) => !/\bsrc=/.test(s.attrs) || s.body.trim())) {
  bad.push(`${DIST}/index.html: 有内联脚本，页面 CSP（script-src 'self'）会拦下`);
}
const boot = scripts.findIndex((s) => s.attrs.includes(`src="${BOOT}"`));
const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
if (boot < 0 || !head.includes(`src="${BOOT}"`)) bad.push(`${DIST}/index.html: <head> 里没有加载 ${BOOT}`);
else if (/\btype="module"|\bdefer\b|\basync\b/.test(scripts[boot].attrs)) {
  bad.push(`${DIST}/index.html: ${BOOT} 要同步加载（不能是 module、defer、async），否则首帧来不及设主题`);
} else if (scripts.slice(0, boot).some((s) => s.attrs.includes('type="module"'))) {
  bad.push(`${DIST}/index.html: ${BOOT} 要排在应用脚本前面`);
}
const assets = fs.existsSync(path.join(DIST, 'assets')) ? files(path.join(DIST, 'assets')) : [];
for (const f of assets) if (!HASHED_NAME.test(path.basename(f))) bad.push(`${f}: 文件名不带内容哈希，却会按 immutable 长缓存`);

// ⌘K 的拼音库（pinyin-match）在第一次打开 ⌘K 时才加载，不进入口集合（console UX spec「外壳 · 搜索触发器」「性能」，第 2.2 步）：
// index.html 直接加载的模块脚本与 modulepreload 里不能有它的字典；产物里另得有一个分块带着字典，不然这条检查是空的
const PINYIN_DICT = /nuan:["'`]暖["'`]/;
const entry = [
  ...[...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/console\/([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/console\/([^"]+)"/g)].map((m) => m[1]),
].map((rel) => path.join(DIST, rel!));
if (!entry.length) bad.push(`${DIST}/index.html: 找不到应用的入口脚本`);
for (const f of entry) if (PINYIN_DICT.test(fs.readFileSync(f, 'utf8'))) bad.push(`${f}: 拼音库进了入口集合，应在第一次打开 ⌘K 时才加载`);
const pinyinChunks = assets.filter((f) => f.endsWith('.js') && !entry.includes(f) && PINYIN_DICT.test(fs.readFileSync(f, 'utf8')));
if (!pinyinChunks.length) bad.push('产物里找不到拼音库的字典：pinyin-match 换了写法就更新 PINYIN_DICT，没用上拼音库就删掉这条检查');

// ---- 拆包与预算（spec「性能」，第 2.4 步）----
interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}
function readJson<T>(rel: string, hint: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(META, rel), 'utf8')) as T;
  } catch {
    bad.push(`${META}/${rel} 读不出来（${hint}）`);
    return null;
  }
}
const manifest = readJson<Record<string, ManifestChunk>>(
  'manifest.json',
  'console/vite.config.ts 要开 build.manifest，buildMeta 插件把它挪到这里',
);
const modules = readJson<Record<string, string[]>>('modules.json', 'console/vite.config.ts 的 buildMeta 插件写这份清单');
// 元数据不随产物发布：dist 整个进镜像，host 按文件返回 /console/* 下的任何文件，依赖的确切版本不能公开出去
if (fs.existsSync(path.join(DIST, '.vite'))) bad.push(`${DIST}/.vite 还在：构建的元数据要由 buildMeta 挪到 ${META}，不随产物发布`);
const report: string[] = [];
if (manifest && modules) {
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const sizeOf = (file: string): number => fs.statSync(path.join(DIST, file)).size;
  const gzipSum = (list: string[]): number => list.reduce((s, f) => s + zlib.gzipSync(fs.readFileSync(path.join(DIST, f))).length, 0);
  /** 一个块连同它全部的静态依赖（manifest 的 imports 递归），按 manifest 的键 */
  const closure = (key: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(key) || !manifest[key]) return seen;
    seen.add(key);
    for (const i of manifest[key].imports ?? []) closure(i, seen);
    return seen;
  };
  /** 同上，换成其中的 JS 文件（路径相对 dist） */
  const jsOf = (key: string): string[] => [...closure(key)].map((k) => manifest[k]!.file).filter((f) => f.endsWith('.js'));
  /** 从一个块出发、静态与动态引用都算，最终可能下载的块的文件；不进 skip 这一块 */
  const reach = (key: string, skip: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(key) || key === skip || !manifest[key]) return seen;
    seen.add(key);
    for (const i of [...(manifest[key].imports ?? []), ...(manifest[key].dynamicImports ?? [])]) reach(i, skip, seen);
    return seen;
  };
  const filesOf = (keys: Set<string>): Set<string> => new Set([...keys].map((k) => manifest[k]!.file));

  const entries = Object.keys(manifest).filter((k) => manifest[k]!.isEntry);
  if (entries.length !== 1) bad.push(`manifest 里的入口应该正好一个，现在是 ${entries.length} 个：${entries.join('、')}`);
  const entryJs = entries.length === 1 ? jsOf(entries[0]!) : [];
  for (const k of Object.keys(manifest)) {
    const f = manifest[k]!.file;
    if (f.endsWith('.js') && !modules[f]) bad.push(`${f}: ${META}/modules.json 里没有这一块`);
  }
  // index.html 直接加载的脚本都要在入口集合里，不然首屏预算少算了
  for (const f of entry) {
    const rel = path.relative(DIST, f).split(path.sep).join('/');
    if (!entryJs.includes(rel)) bad.push(`${f}: index.html 加载了它，manifest 的入口集合里却没有`);
  }

  // 首屏：入口集合加总览路由的块
  const firstScreen = [...new Set([...entryJs, ...(manifest[OVERVIEW] ? jsOf(OVERVIEW) : [])])];
  const firstGzip = gzipSum(firstScreen);
  if (firstGzip > BUDGET.firstScreenJs) {
    bad.push(`打开总览要下载的 JS gzip 后 ${fmt(firstGzip)} B，超过预算 ${fmt(BUDGET.firstScreenJs)} B（${firstScreen.join('、')}）`);
  }
  report.push(
    `首屏 JS ${fmt(firstGzip)} / ${fmt(BUDGET.firstScreenJs)} B（${manifest[OVERVIEW] ? '入口集合加总览' : '总览还没有，只算入口集合'}）`,
  );

  // 换页：每个路由块连同它的静态依赖，去掉入口集合里已有的。从哪一页出发，额外下载的都不会比这个多
  const routes = Object.keys(manifest).filter((k) => manifest[k]!.isDynamicEntry && ROUTE_CHUNK.test(k));
  if (!routes.length) bad.push('manifest 里没有路由的懒加载块：各页要在 router.tsx 里用 .lazy() 拆出去');
  let worst = { key: '', gzip: 0 };
  for (const k of routes) {
    const extra = jsOf(k).filter((f) => !entryJs.includes(f));
    const g = gzipSum(extra);
    if (g > BUDGET.navJs) bad.push(`进 ${k} 要额外下载的 JS gzip 后 ${fmt(g)} B，超过预算 ${fmt(BUDGET.navJs)} B（${extra.join('、')}）`);
    if (g > worst.gzip) worst = { key: k, gzip: g };
  }
  report.push(`换页最多 ${fmt(worst.gzip)} / ${fmt(BUDGET.navJs)} B（${worst.key}）`);

  // 入口集合里没有页面代码（各页 .lazy()）；@codemirror 只进话术页的块
  const entryModules = entryJs.flatMap((f) => modules[f] ?? []);
  for (const id of entryModules) {
    if (id.startsWith('src/pages/') && !ENTRY_PAGES_OK.has(id))
      bad.push(`入口集合里有页面模块 ${id}：各页要在 router.tsx 里用 .lazy() 拆出去`);
  }
  const isCodemirror = (id: string): boolean => id.includes('node_modules/@codemirror/');
  const cmInEntry = entryModules.filter(isCodemirror);
  if (cmInEntry.length) bad.push(`入口集合里有 @codemirror 的模块（${cmInEntry.length} 个，如 ${cmInEntry[0]}），它只该进话术页的块`);
  const cmFiles = Object.keys(modules).filter((f) => modules[f]!.some(isCodemirror));
  if (!cmFiles.length) {
    bad.push('产物里找不到 @codemirror 的模块：模块清单的路径写法变了就更新 isCodemirror，不再用 CodeMirror 就删掉这条检查');
  }
  // 带着 @codemirror 的每一块都只能经话术页下载：从话术页的块到得了它；从入口出发、不进话术页的块就到不了它
  // （别的页、它们的共用块、⌘K 这类按需加载的块都算）
  if (!manifest[SOP]) bad.push(`manifest 里没有 ${SOP}：话术页要在 router.tsx 里用 .lazy() 拆出去`);
  else if (entries.length === 1) {
    const viaSop = filesOf(reach(SOP, ''));
    const withoutSop = filesOf(reach(entries[0]!, SOP));
    for (const f of cmFiles) {
      if (withoutSop.has(f))
        bad.push(`${f}: 带着 @codemirror，不经话术页也会下载（入口集合、别的页或别的懒加载块引用了它），它只该进话术页的块`);
      else if (!viaSop.has(f)) bad.push(`${f}: 带着 @codemirror，话术页的块却引用不到它`);
    }
    report.push(`@codemirror 在 ${cmFiles.map((f) => path.basename(f)).join('、')} 里，只经话术页下载`);
  }

  // 样张页与假包的模块都不能进生产产物（不变量 25；假包的文字见文件末尾）
  for (const [file, ids] of Object.entries(modules)) {
    for (const id of ids) {
      if (id.startsWith('src/_specimen/')) bad.push(`${file}: 样张页的模块 ${id} 进了生产产物`);
      if (id.includes('src/shared/pack-fixtures/')) bad.push(`${file}: 假包的模块 ${id} 进了生产产物`);
    }
  }

  // 首屏字体：各自的上限；preload 的正好是那两个，合计也有上限
  const fontFile = (name: string): string | undefined => manifest[`src/fonts/${name}`]?.file;
  for (const [name, limit] of Object.entries(BUDGET.fonts)) {
    const f = fontFile(name);
    if (!f) bad.push(`manifest 里没有 src/fonts/${name}`);
    else if (sizeOf(f) > limit) bad.push(`${f}: ${fmt(sizeOf(f))} B，超过预算 ${fmt(limit)} B`);
  }
  const preloaded = [...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)]
    .filter((m) => /\bas="font"/.test(m[0]))
    .map((m) => /\bhref="\/console\/([^"]+)"/.exec(m[0])?.[1] ?? m[0]);
  const expected = PRELOAD_FONTS.map(fontFile);
  if (preloaded.length !== expected.length || expected.some((f) => !f || !preloaded.includes(f))) {
    bad.push(`${DIST}/index.html: preload 的字体应该正好是 ${PRELOAD_FONTS.join('、')}，现在是 ${preloaded.join('、') || '没有'}`);
  }
  const preloadBytes = preloaded.filter((f) => fs.existsSync(path.join(DIST, f))).reduce((s, f) => s + sizeOf(f), 0);
  if (preloadBytes > BUDGET.preloadFonts) bad.push(`preload 的字体合计 ${fmt(preloadBytes)} B，超过预算 ${fmt(BUDGET.preloadFonts)} B`);
  report.push(`preload 字体 ${fmt(preloadBytes)} / ${fmt(BUDGET.preloadFonts)} B`);
}

// ---- 假包的文字（不变量 25，第 3.3 步）----
/** 界面自己的字：同一个解析在产物里找不到它，就说明字符串没取出来，这条检查是空的 */
const UI_CONTROL = '等人接手';
const FIXTURES_DIR = path.join('src', 'shared', 'pack-fixtures');
/** 一个值里的全部字符串（对象只取值，不取键） */
const stringsOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) stringsOf(x, out);
  return out;
};
const isPackLike = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && Array.isArray((v as { entities?: unknown }).entities) && 'vocabulary' in v && 'stages' in v;
const registered = new Set<string>();
for (const id of PACK_IDS) stringsOf(packById(id), registered);
const fakeMarkers = new Map<string, string>(); // 字符串 → 哪个假包
const fixtureFiles = fs.existsSync(FIXTURES_DIR)
  ? fs.readdirSync(FIXTURES_DIR).filter((f) => /\.tsx?$/.test(f) && !f.includes('.selftest.'))
  : [];
for (const f of fixtureFiles.toSorted()) {
  const mod = (await import(pathToFileURL(path.resolve(FIXTURES_DIR, f)).href)) as Record<string, unknown>;
  for (const v of Object.values(mod)) {
    if (!isPackLike(v)) continue;
    const name = String((v as { name?: unknown }).name);
    for (const s of stringsOf(v)) if ([...s].length >= 3 && !/^[a-z]+$/.test(s) && !registered.has(s)) fakeMarkers.set(s, name);
  }
}
if (!fakeMarkers.size) bad.push(`${FIXTURES_DIR}/ 下没找到导出的假包，按文字查假包的这条检查是空的`);
/** 一段 JS 里全部字符串字面量与模板字符串文字段的值（转义已解开） */
function jsStrings(file: string, source = fs.readFileSync(file, 'utf8')): Set<string> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** 一个文件的字符串里撞上的假包标记串：[标记串, 哪个假包] */
const fakeHitsIn = (found: Set<string>): [string, string][] => [...fakeMarkers].filter(([s]) => found.has(s));
let controlSeen = false;
let stringCount = 0;
for (const f of assets.filter((a) => a.endsWith('.js'))) {
  const found = jsStrings(f);
  stringCount += found.size;
  if (found.has(UI_CONTROL)) controlSeen = true;
  for (const [s, pack] of fakeHitsIn(found)) bad.push(`${f}: 假包「${pack}」的内容「${s}」进了生产产物（不变量 25）`);
}
if (!controlSeen) bad.push(`产物的 JS 里找不到界面文字「${UI_CONTROL}」：字符串没取出来，按文字查假包的检查是空的`);
// 正对照：假块里每个标记串轮流用 "…"、`…`、`${x}…${x}` 写，比对要全部找出来
const inTemplate = (s: string): string => s.replace(/[\\`$]/g, '\\$&');
const probeSource = `x=[${[...fakeMarkers.keys()]
  .map((s, i) => [JSON.stringify(s), '`' + inTemplate(s) + '`', '`${x}' + inTemplate(s) + '${x}`'][i % 3])
  .join(',')}]`;
const probeHits = fakeHitsIn(jsStrings('fake-chunk.js', probeSource)).length;
if (probeHits !== fakeMarkers.size)
  bad.push(`正对照：拼进假块的 ${fakeMarkers.size} 个假包字符串只找出 ${probeHits} 个，按文字查假包的比对坏了`);
report.push(
  `假包的 ${fakeMarkers.size} 个字符串都不在产物 JS 的 ${stringCount.toLocaleString('en-US')} 个字符串里（正对照 ${probeHits}/${fakeMarkers.size}）`,
);

if (bad.length) {
  console.error(`console-dist: 构建产物里有不该有的东西：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `console-dist: ${all.length} 个文件，没有服务端依赖、Node 内置模块、样张页、假包（模块与文字）与第三方字体，首帧主题脚本在应用脚本之前同步加载；assets/ 下 ${assets.length} 个文件都带内容哈希；拼音库在懒加载的 ${path.basename(pinyinChunks[0]!)} 里；${report.join('；')}`,
);
