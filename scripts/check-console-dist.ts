// console 生产构建产物的检查（01 spec 验收 17）：浏览器包里不能混进服务端的数据库驱动与 Node 内置模块。
// 另查首帧主题脚本的加载方式（console UX spec 第 1.1 步）。
// 挂在 `pnpm test` 末尾、紧跟 `pnpm --filter console build`。
// 包名按子串查；Node 内置模块只查带引号的模块名（"node:crypto"），压缩后的对象键 {node:x} 不算。
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.join('console', 'dist');
const BANNED = ['drizzle-orm', 'pg-protocol', '@electric-sql/pglite'];
const NODE_BUILTIN = /["'`]node:[a-z_/]+/;

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
if (bad.length) {
  console.error(`console-dist: 构建产物里有不该有的东西：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`console-dist: ${all.length} 个文件，没有服务端依赖与 Node 内置模块，首帧主题脚本在应用脚本之前同步加载`);
