// /console/* 与 /api/console/* 的安全头（01 spec「后台 API 与页面 · 安全头」）。服务端和 console 的 vite preview 共用这一份：
// 响应里有 csrf 和草稿，不许缓存；同源的 XSS 能拿到 csrf，CSP 只许本站脚本。
//
// 页面（/console 的 index.html）另加 style-src 'self' 'nonce-…'：Ant Design 与 CodeMirror 在运行时插 <style>，
// 只有 default-src 'self' 时整页没有样式（第 12 步实测）。nonce 每个响应现生成，vite 构建时在 index.html 里留占位符，
// 托管页面的一方替换成真值并放进 CSP；前端从 <meta property="csp-nonce"> 读出来交给 antd 与 CodeMirror。脚本仍只许本站文件
//
// font-src 'self'：default-src 'self' 本来就管着字体，显式写出来是防止以后放宽 default-src 时字体被一起放开；
// 不加 data:，也不加第三方域名（后台 UX spec「字体与授权义务」，01 于 2026-09-27 修订为允许另加这一段）
const BASE_CSP = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; font-src 'self'";

export const CONSOLE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': BASE_CSP,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

/** vite 的 html.cspNonce：构建产物的 index.html 里 nonce 的占位符 */
export const CSP_NONCE_PLACEHOLDER = '__CONSOLE_CSP_NONCE__';

/** 页面响应的安全头：在 API 那份之上多一条只认这个 nonce 的 style-src */
export function consolePageHeaders(nonce: string): Record<string, string> {
  return { ...CONSOLE_SECURITY_HEADERS, 'Content-Security-Policy': `${BASE_CSP}; style-src 'self' 'nonce-${nonce}'` };
}

/** 把构建产物 index.html 里的占位符换成这个响应的 nonce */
export function renderConsoleIndex(html: string, nonce: string): string {
  return html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce);
}

const ASSET_TYPES: Readonly<Record<string, string>> = {
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

/** 带内容哈希的资源：内容一变文件名就变，缓存一年、不再回源验证（后台 UX spec「性能 · 缓存」） */
export const HASHED_ASSET_CACHE = 'public, max-age=31536000, immutable';

/**
 * /console/ 下一个存在的静态文件（index.html 除外）的响应头，服务端 host 与 vite preview 共用，两边的缓存头因此一致。
 * rel 是 /console/ 之后的路径。vite 只往 assets/ 里写带内容哈希的构建产物（scripts/check-console-dist.ts 查文件名），
 * 这些长缓存；其余（theme-boot.js、许可文本等）和 API 一样 no-store。文件不存在的 404 不用它，照旧带 no-store
 */
export function consoleAssetHeaders(rel: string): Record<string, string> {
  const ext = /\.[^./]+$/.exec(rel)?.[0].toLowerCase() ?? '';
  return {
    ...CONSOLE_SECURITY_HEADERS,
    ...(rel.startsWith('assets/') ? { 'Cache-Control': HASHED_ASSET_CACHE } : {}),
    'Content-Type': ASSET_TYPES[ext] ?? 'application/octet-stream',
  };
}
