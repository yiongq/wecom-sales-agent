// 登录页通往官网和文档的入口。正式环境后台固定在 app.<根域>，官网和文档是同一根域的 www、docs；
// 公开仓库不写生产域名，所以从当前地址推出来。本机、演示等其他地址没有这些站点，返回 null，入口不显示。
export interface SiteLinks {
  www: string;
  docs: string;
  privacy: string;
  terms: string;
}

export function siteLinks(hostname: string): SiteLinks | null {
  const root = /^app\.(.+\..+)$/.exec(hostname)?.[1];
  if (!root) return null;
  const www = `https://www.${root}/`;
  return { www, docs: `https://docs.${root}/`, privacy: `${www}privacy/`, terms: `${www}terms/` };
}
