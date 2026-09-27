// 外壳的纯逻辑（spec「信息架构、导航与路由」「逐页设计 · 外壳」，设计系统 §4）：侧栏由行业包生成、选中项、标签页标题、
// 徽标、头像取色、会话标签、视口三档。不依赖 React，shell.selftest.ts 直接 import。
// 角色的中文名在 src/shared/ui-labels.ts，相对时间在 src/shared/format.ts。
// 界面代码不认行业：实体名、图标名、产品库分组名、客户的叫法都取自 /pack 下发的行业包（spec「行业包通用架构 · 下发」）
import type { ConversationRow, Me } from '../../../src/shared/console-api.js';
import { shortIdOf } from '../../../src/shared/conversation.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';

/** 外壳关心的来者：成员带角色，匿名只在 demo 下有 */
export type ShellViewer = { kind: 'member'; me: Me } | { kind: 'anon' };

/** 改话术、改产品库、看审计：只有所有者、管理员（01 的权限矩阵） */
export const isEditor = (v: ShellViewer): boolean => v.kind === 'member' && (v.me.role === 'owner' || v.me.role === 'admin');

// ---------------- 侧栏 ----------------

/** 导航项的图标：固定页面用自己的图标，实体用行业包给的 lucide 名称 */
export type NavIcon = { page: 'sop' | 'conversations' | 'audit' } | { entity: string };

export interface NavItem {
  /** 按它匹配当前路由：不带 /console 的路径 */
  key: string;
  label: string;
  icon: NavIcon;
  /** 实体项：行业包里的 kind，右侧写这个实体的条目数 */
  entity?: string;
  /** 会话项：右侧是等人接手的软徽标 */
  waiting?: true;
}

export interface NavGroup {
  key: string;
  /** 分组标题；第一组没有标题 */
  title: string | null;
  items: NavItem[];
}

/**
 * 侧栏、搜索占位、⌘K 的「各实体」组共用的实体表：按 `nav.entities` 的顺序，nav 里写了、`entities` 里没有的 kind 跳过。
 * 三处取同一张表，侧栏有哪些实体，占位就写哪些、⌘K 就搜哪些
 */
export const packEntities = (pack: IndustryPack): EntityType[] =>
  pack.nav.entities.map((kind) => pack.entities.find((e) => e.kind === kind)).filter((e) => e !== undefined);

/**
 * 侧栏的导航（spec「信息架构」，设计系统 §4.2）：顺序固定，产品库分组名和各实体取自行业包。
 * 会话只给成员（匿名没有入口）；审计日志只给所有者、管理员。「总览」随第 4 步的路由加上，「平台 / 系统」要后端
 */
export function buildNav(pack: IndustryPack, viewer: ShellViewer): NavGroup[] {
  const entities = packEntities(pack).map((e): NavItem => ({
    key: `/catalog/${e.kind}`,
    label: e.label,
    icon: { entity: e.icon },
    entity: e.kind,
  }));
  const groups: NavGroup[] = [
    { key: 'main', title: null, items: [{ key: '/sop', label: '销售话术', icon: { page: 'sop' } }] },
    { key: 'catalog', title: pack.nav.catalogGroup, items: entities },
  ];
  const ops: NavItem[] = [];
  if (viewer.kind === 'member') ops.push({ key: '/conversations', label: '会话', icon: { page: 'conversations' }, waiting: true });
  if (isEditor(viewer)) ops.push({ key: '/audit', label: '审计日志', icon: { page: 'audit' } });
  if (ops.length) groups.push({ key: 'ops', title: '运营', items: ops });
  return groups.filter((g) => g.items.length > 0);
}

/** 路由的 pathname 带不带 basepath（/console）都认 */
export const stripBase = (pathname: string): string => pathname.replace(/^\/console(?=\/|$)/, '') || '/';

/** 当前路由对应的导航项：按整段比，最长的那个；没有对应项时是 null（登录页、404） */
export function selectedNavKey(pathname: string, groups: readonly NavGroup[]): string | null {
  const here = stripBase(pathname);
  let best: string | null = null;
  for (const g of groups) {
    for (const { key } of g.items) {
      if ((here === key || here.startsWith(`${key}/`)) && (best === null || key.length > best.length)) best = key;
    }
  }
  return best;
}

/** 进入这些页面时侧栏默认收起为 56（spec「外壳 · 收起」；会话工作台随第 18 步加上） */
export const collapsedByDefault = (pathname: string): boolean => {
  const here = stripBase(pathname);
  return here === '/sop' || here.startsWith('/sop/');
};

/** 搜索触发器里的占位：「搜索线路、酒店、会话…」；匿名没有会话 */
export function searchPlaceholder(pack: IndustryPack, viewer: ShellViewer): string {
  const names = packEntities(pack).map((e) => e.label);
  if (viewer.kind === 'member') names.push('会话');
  return `搜索${names.join('、')}…`;
}

// ---------------- 租户、标题 ----------------

/** 侧栏租户行与标签页标题里的租户名；匿名不显示租户名，写「演示」（开放问题 5） */
export const tenantLabel = (v: ShellViewer): string => (v.kind === 'member' ? v.me.tenantName : '演示');

/** 标签页标题：「页名 · 租户名」，详情页「条目名 · 实体名 · 租户名」（spec「信息架构」，不变量 23） */
export const documentTitle = (page: readonly string[], v: ShellViewer): string => [...page, tenantLabel(v)].join(' · ');

/** 首字：租户 logo 的兜底与头像里的字 */
export const firstChar = (name: string): string => Array.from(name.trim())[0] ?? '';

// ---------------- 徽标、头像 ----------------

/** 数字徽标的文字：0 不画，超过 99 写「99+」（设计系统 §5.7） */
export function badgeText(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
  return n > 99 ? '99+' : String(Math.floor(n));
}

/** 头像取色（设计系统 §6.8）：名字各字符的 UTF-16 码相加，mod 6 再加 1，取 --av{n}-bg / --av{n}-fg */
export function avatarIndex(name: string): number {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) sum += name.charCodeAt(i);
  return (sum % 6) + 1;
}

// ---------------- 会话 ----------------

/** 渠道的短名：会话标签「企微客户 · F01」的前半截，后接行业包里客户的叫法 */
const CHANNEL_SHORT: Readonly<Record<string, string>> = { wecom: '企微', simulator: '网页' };

/** 会话标签的两段：「企微客户」与短码（spec「接口改动」：由 channel 和 shortIdOf 拼，不另加字段），中间用 Sep 隔开 */
export function conversationLabel(row: Pick<ConversationRow, 'id' | 'channel'>, pack: IndustryPack): [string, string] {
  const channel = Object.hasOwn(CHANNEL_SHORT, row.channel) ? CHANNEL_SHORT[row.channel] : '';
  return [`${channel}${pack.vocabulary.customer}`, shortIdOf(row.id) || '····'];
}

/**
 * 工作台里打开这个会话。admin.html 读 #s=<id> 选中它是第 13 步的事：在那之前这个链接只打开工作台、不选中会话（plan「Open」）
 */
export const workbenchHref = (id: string): string => `/admin.html#s=${encodeURIComponent(id)}`;

// ---------------- 视口 ----------------

/**
 * 视口三档（spec「可访问性与响应式」，由 useViewport() 统一判断）：
 * wide ≥1280 侧栏展开（可手动收起）；rail 992–1279 收成 56 的图标栏；narrow <992 侧栏隐藏，52 高的顶栏里的菜单按钮打开抽屉
 */
export type ViewportTier = 'wide' | 'rail' | 'narrow';
export const WIDE_MIN = 1280;
export const RAIL_MIN = 992;
export const viewportTier = (width: number): ViewportTier => (width >= WIDE_MIN ? 'wide' : width >= RAIL_MIN ? 'rail' : 'narrow');

/** 侧栏的形态：展开 240、收起 56、隐藏（顶栏 + 抽屉） */
export type SidebarMode = 'expanded' | 'collapsed' | 'hidden';
export function sidebarMode(tier: ViewportTier, collapsed: boolean): SidebarMode {
  if (tier === 'narrow') return 'hidden';
  if (tier === 'rail') return 'collapsed';
  return collapsed ? 'collapsed' : 'expanded';
}

// ---------------- 计数刷新 ----------------

/**
 * 计数与等人接手列表的轮询（spec「外壳 · 计数刷新」）：页面可见时每 30 秒一次，隐藏时停
 * （React Query 的 refetchIntervalInBackground: false 按 document.visibilityState 暂停）。只取计数和等人接手的首页
 */
export const POLL = { refetchInterval: 30_000, refetchIntervalInBackground: false } as const;
