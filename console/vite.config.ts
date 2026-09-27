// 后台前端（ADR-002）：挂在 /console/，开发时把 /api 代理到本地服务端。
// 开发和 preview 都走 https（自签证书）：会话 cookie 是 __Host- 前缀、必须 Secure，WebKit（Safari）在 http://localhost 上不存
// Secure cookie（第 12 步实测，01 spec 开放问题 8）。第一次打开要在浏览器里接受自签证书。
// preview 按线上的做法托管构建产物：页面每次响应现生成 CSP nonce、换掉 index.html 里的占位符，其余响应带同一套安全头。
// 构建产物在 CSP 下能不能跑，本地就看得到
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import {
  CONSOLE_SECURITY_HEADERS,
  CSP_NONCE_PLACEHOLDER,
  consoleAssetHeaders,
  consolePageHeaders,
  renderConsoleIndex,
} from '../src/shared/security-headers.js';

const api = { '/api': 'http://localhost:3200' };

function previewWithCsp(): Plugin {
  return {
    name: 'console-preview-csp',
    configurePreviewServer(server) {
      const dist = path.resolve(server.config.root, server.config.build.outDir);
      const index = path.join(dist, 'index.html');
      // public/ 下的文件（theme-boot.js 等）落在 dist 根目录，和 host 一样按文件返回，不回退成 index.html
      const isDistFile = (url: string): boolean => {
        try {
          const file = path.resolve(dist, decodeURIComponent(url.split('?')[0].slice('/console/'.length)));
          return file.startsWith(dist + path.sep) && file !== index && (fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false);
        } catch {
          return false; // 解不开的 %xx 之类，交给下面按页面处理
        }
      };
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/console')) return next();
        // 资源文件的头与服务端 host 取自同一个函数，先设好再交给 vite 的静态服务（它保留已设的头）。
        // 文件不存在时只带安全头，不能长缓存。preview 上的 gzip 是 vite 自带的，压缩以真实 host 为准（后台 UX spec 验收 23）
        if (url.startsWith('/console/assets/')) {
          const rel = url.split(/[?#]/)[0]!.slice('/console/'.length);
          const file = path.resolve(dist, rel);
          const exists = file.startsWith(dist + path.sep) && fs.statSync(file, { throwIfNoEntry: false })?.isFile();
          for (const [k, v] of Object.entries(exists ? consoleAssetHeaders(rel) : CONSOLE_SECURITY_HEADERS)) res.setHeader(k, v);
          return next();
        }
        if (isDistFile(url)) {
          for (const [k, v] of Object.entries(CONSOLE_SECURITY_HEADERS)) res.setHeader(k, v);
          return next();
        }
        const nonce = randomBytes(16).toString('base64');
        for (const [k, v] of Object.entries(consolePageHeaders(nonce))) res.setHeader(k, v);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderConsoleIndex(fs.readFileSync(index, 'utf8'), nonce));
      });
    },
  };
}

// 首屏字体的 preload（console-ux spec「字体与授权义务」）：只放 Geist 和 UI 优先片两个，都带 crossorigin，
// 否则预载的请求和 @font-face 的请求对不上、字体下两遍。文件名带内容哈希，所以在产物里按原文件名找。
// 只在构建时注入：开发服务器上字体按需加载就够了
const PRELOAD_FONTS = ['geist-ui.woff2', 'noto-sans-sc-ui.woff2'];

function preloadFonts(): Plugin {
  let base = '/';
  return {
    name: 'console-preload-fonts',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const assets = Object.values(ctx.bundle ?? {}).filter((o) => o.type === 'asset');
        return PRELOAD_FONTS.map((name) => {
          const asset = assets.find((a) => a.originalFileNames.some((f) => path.basename(f) === name));
          if (!asset) throw new Error(`构建产物里没有 ${name}，preload 注入不了（main.tsx 有没有引 fonts/fonts.css？）`);
          return {
            tag: 'link',
            attrs: { rel: 'preload', href: base + asset.fileName, as: 'font', type: 'font/woff2', crossorigin: true },
            injectTo: 'head',
          };
        });
      },
    },
  };
}

// 每个 JS 块由哪些模块组成，写到 manifest 旁边的 .vite/modules.json（路径相对 console/，虚拟模块去掉开头的 \0）。
// vite 的 manifest 只记块与块之间的引用，不记模块；scripts/check-console-dist.ts 靠这份清单查入口集合里没有 @codemirror、
// 产物里没有样张页与假包的模块（spec「性能」、不变量 25）
function chunkModules(): Plugin {
  let root = '';
  return {
    name: 'console-chunk-modules',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const modules: Record<string, string[]> = {};
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue;
        modules[out.fileName] = out.moduleIds.map((id) =>
          id.startsWith('\0') ? id.slice(1) : path.relative(root, id).split(path.sep).join('/'),
        );
      }
      this.emitFile({ type: 'asset', fileName: '.vite/modules.json', source: `${JSON.stringify(modules, null, 2)}\n` });
    },
  };
}

export default defineConfig({
  base: '/console/',
  plugins: [react(), basicSsl(), previewWithCsp(), preloadFonts(), chunkModules()],
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  // assetsInlineLimit: 0：长尾分片里有 3 片小于默认的 4 KB 阈值，默认会被写成 data: 进 CSS，font-src 'self' 会拦下它们。
  // manifest：scripts/check-console-dist.ts 按它算首屏与每次换页的 JS 预算（spec「性能」）。块大小的告警阈值用 vite 的默认值，
  // 不再调高压掉告警，由那份预算把关
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, manifest: true },
});
