// console 生产构建产物的检查（01 spec 验收 17）：浏览器包里不能混进服务端的数据库驱动与 Node 内置模块。
// 另查首帧主题脚本的加载方式（console UX spec 第 1.1 步）。
// 另查样张页没有混进生产产物（console UX spec 不变量 25：/_specimen 只在 VITE_SPECIMEN=1 的构建里注册，第 1.3 步）。
// 另查 ⌘K 的拼音库不在入口集合里（第 2.2 步）。
// 挂在 `pnpm test` 末尾、紧跟 `pnpm --filter console build`。
// 包名按子串查；Node 内置模块只查带引号的模块名（"node:crypto"），压缩后的对象键 {node:x} 不算。
// assets/ 下每个文件名都要带 vite 的内容哈希（<name>-<8 位>.<扩展名>）：服务端给 /console/assets/* 一律一年的 immutable
// 缓存（src/shared/security-headers.ts），不带哈希的文件混进来，改了内容浏览器也不会重新下载（后台 UX spec 不变量 26）。
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.join('console', 'dist');
const BANNED = ['drizzle-orm', 'pg-protocol', '@electric-sql/pglite'];
const NODE_BUILTIN = /["'`]node:[a-z_/]+/;
/** 样张页的路由、样式类名和「不挤压」对照行：生产构建里这些分支连同页面代码一起被摇掉，出现就是条件没在构建时定下来 */
const SPECIMEN_MARKERS = ['_specimen', 'spec-panel', 'space-all'];
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

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
  const text = fs.readFileSync(f, 'utf8');
  for (const b of BANNED) if (text.includes(b)) bad.push(`${f}: ${b}`);
  const m = NODE_BUILTIN.exec(text);
  if (m) bad.push(`${f}: ${m[0]}`);
  for (const mk of SPECIMEN_MARKERS) if (text.includes(mk)) bad.push(`${f}: 样张页的内容（${mk}）混进了生产产物`);
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
if (bad.length) {
  console.error(`console-dist: 构建产物里有不该有的东西：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `console-dist: ${all.length} 个文件，没有服务端依赖、Node 内置模块与样张页，首帧主题脚本在应用脚本之前同步加载；assets/ 下 ${assets.length} 个文件都带内容哈希；拼音库在懒加载的 ${path.basename(pinyinChunks[0]!)} 里`,
);
