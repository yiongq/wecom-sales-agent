// R10 / 验收 11、17：只处理沙箱响应，hash 在租户品牌与页面头部渲染完成后生成。
import { createHash } from 'node:crypto';
import { SANDBOX_DATA_COPY, SHOWCASE_COPY } from '../../shared/entry-ui.js';
import { loginShowcase } from '../../console-api/entry.js';

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
    .replace('id="hostConsole"', () => `id="hostConsole" href="${esc(`${root}/console/?view=demo`)}"`)
    .replace('id="hostLogin"', () => `id="hostLogin" href="${esc(`${root}/console/`)}"`)
    .replace('id="hostChat"', () => `id="hostChat" href="${esc(`${root}/chat.html`)}"`);
}

/** 静态准备页引用 console 的构建样式：令牌、布局、字体同源且只有一份。 */
export function sandboxTryDesign(html: string, consoleIndex: string): string {
  const styles = [...consoleIndex.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((m) => m[0]).join('\n');
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  const showcase = loginShowcase();
  return html
    .replace('<!-- console styles -->', styles)
    .replace('<!-- data copy -->', SANDBOX_DATA_COPY.map((line) => `<p>${escape(line)}</p>`).join(''))
    .replace(
      '<!-- showcase -->',
      showcase
        ? `<aside class="entry-showcase" aria-label="产品画面"><div class="entry-showcase-content"><img src="${escape(showcase.src)}" alt="${escape(showcase.alt)}" width="460"><h2>${escape(SHOWCASE_COPY.title)}</h2><p>${escape(SHOWCASE_COPY.description)}</p></div></aside>`
        : '',
    );
}
