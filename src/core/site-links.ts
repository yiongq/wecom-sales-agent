// 09 R10：核心只登记通用页面；包的文档始终从当前租户绑定取得。
import type { PackRuntime, SiteLinkDef } from './pack-api.js';
import { currentRuntime } from '../tenancy/runtime.js';
import type { AnyOrder } from './order-view.js';
import { isLineOrder, orderDisplay } from './order-view.js';

// 与存储门面的同步访问器相同，读取当前租户内存权威；不在 pack-api 装配期反向加载存储/配置。
function getAnyOrder(id: string): AnyOrder | undefined {
  return currentRuntime().store.orders.get(id);
}

/** 日期格式沿用旅游旧卡片，跨年才带年份。 */
function cnDate(iso: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(iso);
  if (!m) return iso;
  const md = `${Number(m[2])}月${Number(m[3])}日`;
  return Number(m[1]) === now.getFullYear() ? md : `${m[1]}年${md}`;
}

export const coreSiteLinks: readonly SiteLinkDef[] = Object.freeze([
  { linkKind: 'site', pattern: /^\/privacy$/, allowed: () => true },
  {
    linkKind: 'order',
    pattern: /^\/pay\/[A-Za-z0-9_-]+$/,
    resources: [
      { pattern: /^\/api\/orders\/[A-Za-z0-9_-]+$/, methods: ['GET', 'HEAD'] },
      { pattern: /^\/api\/orders\/[A-Za-z0-9_-]+\/pay$/, methods: ['POST'] },
    ],
    allowed(session, path) {
      const order = getAnyOrder(path.slice('/pay/'.length));
      return !!order && order.sessionId === session.id && !('approval' in order) && !order.supersededBy;
    },
    card(path) {
      const o = getAnyOrder(path.slice('/pay/'.length));
      if (!o) return null;
      if (isLineOrder(o)) {
        const display = orderDisplay(o);
        return { title: `${display.title} · 待支付`, desc: `${display.summary} · 合计 ${display.totalText}` };
      }
      return {
        title: `${o.routeTitle} · 待支付`,
        desc: `${o.travelers} 位出行 · ${o.departDate ? cnDate(o.departDate) + '出发' : '日期待定'} · 合计 ¥${o.totalPrice.toLocaleString('zh-CN')}`,
      };
    },
  },
]);

export function siteLinks(runtime: PackRuntime | undefined = currentRuntime().pack?.runtime): readonly SiteLinkDef[] {
  return [...coreSiteLinks, ...(runtime?.siteLinks ?? [])];
}

// 不使用有状态的 lastIndex；包提供 /g 或 /y 也不会跨请求改变匹配结果。
export function matchesPath(pattern: RegExp, path: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(path);
}

/** 文本投影沿用包文档的 ?v=数字；资源白名单始终只匹配原始 pathname。 */
export function linkDef(path: string, defs = siteLinks()): SiteLinkDef | undefined {
  return defs.find(
    (def) =>
      matchesPath(def.pattern, path) ||
      (!coreSiteLinks.includes(def) && /\?v=\d+$/.test(path) && matchesPath(def.pattern, path.replace(/\?v=\d+$/, ''))),
  );
}

/** 消费完整 URL，保留原文偏移；不从外站或伪协议里挖相对路径。 */
export function linkCandidates(text: string): { raw: string; index: number }[] {
  return [...text.matchAll(/(?:[a-z][a-z\d+.-]*:|\/\/|\/(?=[A-Za-z0-9_%./-]))[^\s<>"'`，。！？；、（）【】]+/gi)]
    .filter((m) => m.index === 0 || !/[\w./:@%\\-]/.test(text[m.index - 1]!))
    .map((m) => ({ raw: m[0], index: m.index }));
}

export function ownLinkPath(raw: string, base: string): string | null {
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  const ownBase = base.replace(/\/+$/, '');
  if (!ownBase || !raw.startsWith(`${ownBase}/`)) return null;
  try {
    const url = new URL(raw);
    const own = new URL(ownBase);
    if (!/^https?:$/.test(own.protocol) || url.origin !== own.origin || url.username || url.password) return null;
    return raw.slice(ownBase.length);
  } catch {
    return null;
  }
}

/** 旧文本路径掩码/分段允许尾随正文，按登记的路径前缀匹配，整段保护到空白。 */
export function registeredTextLinks(text: string): RegExpMatchArray[] {
  const defs = siteLinks();
  return [...text.matchAll(/\/[^\s]+/g)].filter((m) =>
    defs.some((def) => new RegExp(def.pattern.source.replace(/\$$/, ''), def.pattern.flags.replace(/[gy]/g, '')).test(m[0])),
  );
}

/** 保留旧卡片对紧邻中文、?v= 和多链接的识别口径，种类由登记决定。 */
export function cardLinks(text: string, runtime?: PackRuntime): { raw: string; path: string; def: SiteLinkDef }[] {
  const out: { raw: string; path: string; def: SiteLinkDef }[] = [];
  for (const def of siteLinks(runtime).filter((d) => d.card)) {
    const source = def.pattern.source.replace(/^\^/, '').replace(/\$$/, '');
    const re = new RegExp(`(?:https?:\\/\\/[^\\s]*)?(${source})(?:\\?v=\\d+)?`, 'g');
    for (const m of text.matchAll(re)) {
      const raw = m[0];
      const path = raw.slice(raw.lastIndexOf(m[1]!));
      out.push({ raw, path, def });
    }
  }
  return out;
}

/** 登记路径的首段对应品牌 HTML 槽；接口资源不参与静态页选择。 */
export function isSiteHtml(path: string, runtime?: PackRuntime): boolean {
  return siteLinks(runtime).some((def) => {
    const root = /^\^\\\/([A-Za-z0-9_-]+)\\\//.exec(def.pattern.source)?.[1];
    return !!root && path.toLowerCase() === `/${root}.html`;
  });
}
