// console 生产构建产物的检查（01 spec 验收 17）：浏览器包里不能混进服务端的数据库驱动与 Node 内置模块。
// 挂在 `pnpm test` 末尾、紧跟 `pnpm --filter console build`。
// 包名按子串查；Node 内置模块只查带引号的模块名（"node:crypto"），压缩后的对象键 {node:x} 不算。
// assets/ 下每个文件名都要带 vite 的内容哈希（<name>-<8 位>.<扩展名>）：服务端给 /console/assets/* 一律一年的 immutable
// 缓存（src/shared/security-headers.ts），不带哈希的文件混进来，改了内容浏览器也不会重新下载（后台 UX spec 不变量 26）。
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.join('console', 'dist');
const BANNED = ['drizzle-orm', 'pg-protocol', '@electric-sql/pglite'];
const NODE_BUILTIN = /["'`]node:[a-z_/]+/;
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
}
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
if (!html.includes('/console/assets/')) bad.push(`${DIST}/index.html: 资源路径不在 /console/assets/ 下（vite 的 base 不对）`);
const assets = fs.existsSync(path.join(DIST, 'assets')) ? files(path.join(DIST, 'assets')) : [];
for (const f of assets) if (!HASHED_NAME.test(path.basename(f))) bad.push(`${f}: 文件名不带内容哈希，却会按 immutable 长缓存`);
if (bad.length) {
  console.error(`console-dist: 构建产物里有不该有的东西：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`console-dist: ${all.length} 个文件，没有服务端依赖与 Node 内置模块；assets/ 下 ${assets.length} 个文件都带内容哈希`);
