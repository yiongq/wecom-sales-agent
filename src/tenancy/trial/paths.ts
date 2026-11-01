/** 解码后按大小写/尾斜杠规范化。保留客户 GET /api/orders/:id 和报价资源，关闭旧管理与演示入口。 */
export function productPathClosed(input: string): boolean {
  let value: string;
  try {
    value = decodeURIComponent(input).toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return true;
  }
  return (
    /\/(?:try|admin|chat|web)\.html$/.test(value) ||
    value.endsWith('/kf-qr.png') ||
    /^\/api\/(?:chat|stream(?:\/.*)?|sessions(?:\/.*)?|orders|admin(?:\/.*)?|usage|insights)$/.test(value) ||
    /^\/api\/orders\/[^/]+\/pay$/.test(value)
  );
}
