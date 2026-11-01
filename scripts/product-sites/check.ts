import fs from 'node:fs';
import path from 'node:path';
import { baseUrl } from './input.js';
import type { ProductPublishInput } from '../../src/shared/product-surface.js';

export function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('产物不能含软链接');
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
const decode = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** 同时检查 HTML、搜索索引、站点地图和 JS；不以侧栏隐藏代替内容隔离。 */
export function checkArtifacts(roots: { directory: string; base: string }[], input: ProductPublishInput): void {
  const publicBases = Object.values(input.bases).map((base) => new URL(base).origin);
  const prohibited =
    /(?:docs\/)?(?:architecture\/|features\/console-ux|adr\/|guides\/(?:deployment|observability|local-dev))|\b(?:spec|plan)\.md\b|\bADR-\d{3}\b|\/Users\/|\/private\/tmp\/|(?:^|[^a-z])(?:ww[0-9a-f]{16}|wm[A-Za-z0-9_]{14,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?:\/\/)|(?:corpsecret|access_token)\s*[:=]\s*["'][^"']{8}/im;
  for (const root of roots) {
    const files = filesUnder(root.directory);
    for (const file of files) {
      const relative = path.relative(root.directory, file);
      if (/\.map$|(?:^|\/)(?:spec|plan)\.md$|\.env(?:\.|$)/i.test(relative)) throw new Error(`禁止的产物路径：${relative}`);
      // 二进制也按 latin1 扫 ASCII，防止私有路径落在图片或字体元数据中。
      const raw = fs.readFileSync(file);
      const content = /\.(?:woff2|png|ico|webp)$/.test(file) ? raw.toString('latin1') : raw.toString('utf8');
      if (prohibited.test(content)) throw new Error(`产物含内部或敏感材料：${relative}`);
      if (!file.endsWith('.html')) continue;
      if (!/<html[^>]+lang="zh-CN"/.test(content) || !/<(?:main|article)\b/.test(content)) throw new Error(`正文或语言缺失：${relative}`);
      const pageUrl = new URL(relative.replace(/index\.html$/, ''), baseUrl(root.base));
      for (const match of content.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
        const href = decode(match[1]!);
        if (href.startsWith('data:')) continue;
        const url = new URL(href, pageUrl);
        if (url.protocol !== 'https:') throw new Error(`链接协议不允许：${relative}`);
        if (!publicBases.includes(url.origin)) {
          // 唯一外链为私有输入给出的公开源码及品牌说明。
          if (!url.href.startsWith(input.sourceRepositoryUrl.replace(/\/$/, '') + '/') && url.href !== input.sourceRepositoryUrl)
            throw new Error(`未登记的外链：${relative}`);
          continue;
        }
        const targetRoot = roots.find((candidate) => new URL(candidate.base).origin === url.origin);
        if (!targetRoot) continue; // 单站构建时，另一静态站在 all 构建中复核。
        let target = path.join(targetRoot.directory, decodeURIComponent(url.pathname));
        if (url.pathname.endsWith('/')) target = path.join(target, 'index.html');
        if (!fs.existsSync(target) && !path.extname(target)) target += '.html';
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`内链或资源不存在：${relative} → ${url.pathname}`);
        if (url.hash && target.endsWith('.html')) {
          const id = decodeURIComponent(url.hash.slice(1));
          const targetHtml = fs.readFileSync(target, 'utf8');
          if (![...targetHtml.matchAll(/\bid="([^"]+)"/g)].some((item) => decode(item[1]!) === id))
            throw new Error(`锚点不存在：${relative}`);
        }
      }
    }
  }
}
