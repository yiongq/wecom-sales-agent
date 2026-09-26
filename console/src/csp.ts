// 页面的 CSP nonce：托管方把它写进 <meta property="csp-nonce">（vite 的 html.cspNonce 留的位置）。
// 浏览器会把 nonce 属性藏起来，getAttribute 拿不到，要读 .nonce。开发服务器不发 CSP，这里拿到的是占位符，无害
export const cspNonce: string | undefined =
  (document.querySelector('meta[property="csp-nonce"]') as HTMLMetaElement | null)?.nonce || undefined;
