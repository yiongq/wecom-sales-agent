// /console 的托管与 SPA 回退（01 spec「构建与部署 · 托管与回退」）：
// /console 301 到 /console/；/console/assets/* 按文件返回，文件不存在就 404；/console/* 下其余路径有文件就返回文件，
// 否则一律返回 index.html。index.html 每次响应现生成 CSP nonce、换掉构建时留的占位符（见 src/shared/security-headers.ts），
// 所以不交给 serveStatic：它在目录路径上会把带占位符的原文件直接吐出去。所有响应都带后台的安全头。
// 带内容哈希的 /console/assets/* 长缓存，其中的 JS、CSS 按 Accept-Encoding 返回 gzip；页面与 /api/console/* 不压缩：
// 响应里有 csrf，压缩加上攻击者可控的输入会让 BREACH 类攻击变得可行（后台 UX spec「性能」）。woff2 本来就是压缩过的
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { CONSOLE_SECURITY_HEADERS, consoleAssetHeaders, consolePageHeaders, renderConsoleIndex } from '../shared/security-headers.js';

/** 构建产物目录：默认 cwd/console/dist（镜像里就在这里）；自测用 CONSOLE_DIST 指到临时目录。每次现取，不缓存 */
const distDir = (): string => path.resolve(process.env.CONSOLE_DIST || path.join(process.cwd(), 'console', 'dist'));

/**
 * 读 dist 里的一个文件；不是文件、读不到、或者路径跑出了 dist（../ 之类）都返回 null。
 * notIndex：落到 index.html 上也返回 null。'index.html/' 经 path.resolve 去掉末尾的斜杠也会落到它，大小写不敏感的文件系统上
 * 'INDEX.HTML' 也是它，所以按文件本身（dev + inode）比，不按路径字符串比
 */
async function readDistFile(rel: string, notIndex = false): Promise<Buffer | null> {
  const root = distDir();
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return null;
    if (notIndex) {
      const index = await fs.stat(path.join(root, 'index.html')).catch(() => null);
      if (index && index.dev === st.dev && index.ino === st.ino) return null;
    }
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export const consolePages = new Hono()
  // 小于 1 KB 的不压（按下面带上的 Content-Length 判断）
  .use('/console/assets/*', compress({ encoding: 'gzip', contentTypeFilter: /^text\/(?:javascript|css)(?:[;\s]|$)/ }))
  .get('/console', (c) => c.redirect('/console/', 301))
  .get('/console/*', async (c) => {
    const rel = c.req.path.slice('/console/'.length);
    if (rel) {
      // 带占位符的原 index.html 不按文件返回，落到它上面的路径都走下面现生成 nonce 的那一支
      const file = await readDistFile(rel, true);
      if (file) return c.body(new Uint8Array(file), 200, { ...consoleAssetHeaders(rel), 'Content-Length': String(file.length) });
      // 资源文件不存在就是 404：回退成 index.html 会让浏览器把一页 HTML 当脚本执行，报错也看不懂
      if (rel.startsWith('assets/')) return c.text('not found', 404, { ...CONSOLE_SECURITY_HEADERS });
    }
    const html = await readDistFile('index.html');
    if (!html) return c.text('后台前端还没有构建：pnpm --filter console build', 404, { ...CONSOLE_SECURITY_HEADERS });
    const nonce = randomBytes(16).toString('base64');
    return c.html(renderConsoleIndex(html.toString('utf8'), nonce), 200, consolePageHeaders(nonce));
  });

/** 仅供自测：路由层已经把 ../ 规范掉了，这里直接看读文件那一层的兜底 */
export const __hostTest = { readDistFile };
