// /console 的托管与 SPA 回退（01 spec「构建与部署 · 托管与回退」）：
// /console 301 到 /console/；/console/assets/* 按文件返回，文件不存在就 404；/console/* 下其余路径有文件就返回文件，
// 否则一律返回 index.html。index.html 每次响应现生成 CSP nonce、换掉构建时留的占位符（见 src/shared/security-headers.ts），
// 所以不交给 serveStatic：它在目录路径上会把带占位符的原文件直接吐出去。所有响应都带后台的安全头
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { CONSOLE_SECURITY_HEADERS, consolePageHeaders, renderConsoleIndex } from '../shared/security-headers.js';

const MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** 构建产物目录：默认 cwd/console/dist（镜像里就在这里）；自测用 CONSOLE_DIST 指到临时目录。每次现取，不缓存 */
const distDir = (): string => path.resolve(process.env.CONSOLE_DIST || path.join(process.cwd(), 'console', 'dist'));

/** 读 dist 里的一个文件；不是文件、读不到、或者路径跑出了 dist（../ 之类）都返回 null */
async function readDistFile(rel: string): Promise<Buffer | null> {
  const root = distDir();
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    return (await fs.stat(file)).isFile() ? await fs.readFile(file) : null;
  } catch {
    return null;
  }
}

export const consolePages = new Hono()
  .get('/console', (c) => c.redirect('/console/', 301))
  .get('/console/*', async (c) => {
    const rel = c.req.path.slice('/console/'.length);
    if (rel && rel !== 'index.html') {
      const file = await readDistFile(rel);
      if (file) {
        const type = MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
        return c.body(new Uint8Array(file), 200, { ...CONSOLE_SECURITY_HEADERS, 'Content-Type': type });
      }
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
