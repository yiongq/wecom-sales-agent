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
import { CONSOLE_SECURITY_HEADERS, CSP_NONCE_PLACEHOLDER, consolePageHeaders, renderConsoleIndex } from '../src/shared/security-headers.js';

const api = { '/api': 'http://localhost:3200' };

function previewWithCsp(): Plugin {
  return {
    name: 'console-preview-csp',
    configurePreviewServer(server) {
      const index = path.resolve(server.config.root, server.config.build.outDir, 'index.html');
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/console')) return next();
        if (url.startsWith('/console/assets/')) {
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

export default defineConfig({
  base: '/console/',
  plugins: [react(), basicSsl(), previewWithCsp(), preloadFonts()],
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  // assetsInlineLimit: 0：长尾分片里有 3 片小于默认的 4 KB 阈值，默认会被写成 data: 进 CSS，font-src 'self' 会拦下它们
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4096, assetsInlineLimit: 0 },
});
