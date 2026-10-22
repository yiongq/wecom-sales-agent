// 07 R15：嵌入请求只发往境内已备案服务商的 API 主机。客户原文会作为检索查询发给嵌入服务，
// 所以清单写死在代码里：加一家服务商要改这里、过评审，不开环境变量口子。
// 只放纯判断：不读 EMBED_*、不发请求。embedCfg() 照旧原样返回配置的地址（不抛、不过滤），
// 两处检查——DB 模式启动校验、readEmbedding 发请求之前——各自调这里。
import { profile } from '../../profile.js';

/** 境内已备案服务商的 API 主机（小写，不含端口）。本期只有智谱 */
const DOMESTIC_EMBED_HOSTS: readonly string[] = Object.freeze(['open.bigmodel.cn']);

/** DEPLOY_PROFILE 不是 prod 时另放行的本机回环，给自测与评测的假服务；http / https、任意端口 */
const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost']);

/**
 * 回环只在非 prod 放行。按调用时的 profile() 判断，不在加载时拷进常量（自测会用 __profileTest 临时切 prod）；
 * 没设 DEPLOY_PROFILE 就是 demo。profile() 解析失败（环境变量非法）时按最严的 prod 算：启动时 profile-boot 已经报过它
 */
function loopbackAllowed(): boolean {
  try {
    return profile().name !== 'prod';
  } catch {
    return false;
  }
}

function parse(baseUrl: string): URL | null {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * 嵌入服务地址的主机，给日志和拒绝启动的说明用。地址里可能带账号口令，所以只给主机；解析不了就不回显原文
 */
export function embedEndpointHost(baseUrl: string): string {
  return parse(baseUrl)?.hostname ?? '（地址无法解析）';
}

/**
 * 这个嵌入服务地址能不能用。按主机判断，用 URL 解析器取主机（`https://open.bigmodel.cn@evil.example/` 的主机是 evil.example）；
 * 解析不了、不是 http / https 的一律不放行。
 * - 清单里的公网主机必须 https：客户原文走公网，不能明文（`http://open.bigmodel.cn` 也拒绝）；
 * - 回环只在非 prod 放行，http / https 都行（本机假服务一般没有证书）。
 */
export function embedEndpointAllowed(baseUrl: string): boolean {
  const url = parse(baseUrl);
  if (!url) return false;
  if (DOMESTIC_EMBED_HOSTS.includes(url.hostname)) return url.protocol === 'https:';
  return LOOPBACK_HOSTS.includes(url.hostname) && loopbackAllowed();
}
