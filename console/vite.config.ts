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

export default defineConfig({
  base: '/console/',
  plugins: [react(), basicSsl(), previewWithCsp()],
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4096 },
});
