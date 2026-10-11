// R10 / 验收 11、17：只处理沙箱响应，hash 在租户品牌与页面头部渲染完成后生成。
import { createHash } from 'node:crypto';

export function sandboxPage(html: string): { html: string; csp: string } {
  const withUi = html.replace(/<\/body\s*>/i, '<script src="/sandbox-ui.js"></script>\n</body>');
  const hashes = [...withUi.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]!))
    .map((match) => `'sha256-${createHash('sha256').update(match[2]!).digest('base64')}'`);
  return {
    html: withUi,
    csp: [
      "default-src 'none'",
      `script-src 'self' ${hashes.join(' ')}`,
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  };
}

export function sandboxTryLinks(html: string, publicBaseUrl: string | undefined): string {
  if (!publicBaseUrl) return html;
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    return html;
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return html;
  const esc = (value: string) =>
    value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  const root = base.href.replace(/\/+$/, '');
  return html
    .replace('id="hostConsole"', () => `id="hostConsole" href="${esc(`${root}/console/`)}"`)
    .replace('id="hostChat"', () => `id="hostChat" href="${esc(`${root}/chat.html`)}"`);
}
