// /console/* 与 /api/console/* 的安全头（01 spec「后台 API 与页面 · 安全头」）。服务端和 console 的 vite preview 共用这一份：
// 响应里有 csrf 和草稿，不许缓存；同源的 XSS 能拿到 csrf，CSP 只许本站脚本。
//
// 页面（/console 的 index.html）另加 style-src 'self' 'nonce-…'：Ant Design 与 CodeMirror 在运行时插 <style>，
// 只有 default-src 'self' 时整页没有样式（第 12 步实测）。nonce 每个响应现生成，vite 构建时在 index.html 里留占位符，
// 托管页面的一方替换成真值并放进 CSP；前端从 <meta property="csp-nonce"> 读出来交给 antd 与 CodeMirror。脚本仍只许本站文件
const BASE_CSP = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'";

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
