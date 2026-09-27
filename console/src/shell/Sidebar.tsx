// 侧栏（spec「信息架构」「外壳」，设计系统 §4.2）：租户行（logo、租户名、铃铛）、搜索触发器、由行业包生成的导航、用户行。
// 展开 240；收起 56 时每项是 32 见方的图标按钮，悬停出标签，当前项另加一圈 control-border（只有图标，要一个 ≥3:1 的图形标记），
// 租户只剩 logo，搜索变图标按钮，「会话」的软徽标改成叠在图标右上角的实心徽标。
// 匿名：租户行写「演示」，没有铃铛、会话和审计入口；用户行换成「登录」按钮和「关于」图标按钮
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, type PopoverProps, Tooltip } from 'antd';
import { Info, LogIn, PanelLeft, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CatalogKind } from '../../../src/shared/catalog.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { catalogKind } from '../api.js';
import { catalogListQuery } from '../queries.js';
import { Bell, useWaitingCount } from './Bell.js';
import { useChangeFlash } from './hooks.js';
import { IconButton } from './IconButton.js';
import { Icon, navIcon } from './icons.js';
import { badgeText, firstChar, type NavGroup, type NavItem, type ShellViewer, tenantLabel } from './model.js';
import { UserMenu } from './UserMenu.js';

export interface SidebarProps {
  viewer: ShellViewer;
  pack: IndustryPack;
  groups: readonly NavGroup[];
  selected: string | null;
  collapsed: boolean;
  placeholder: string;
  /** 打开 ⌘K 的快捷键：提示写「⌘K」或「Ctrl+K」，aria-keyshortcuts 同平台 */
  shortcut: { label: string; aria: string };
  onSearch: () => void;
  /**
   * ⌘K 开着时关掉搜索触发器的 Tooltip：指针停在触发器上时，Tooltip 会排到 antd 的 Esc 栈顶，
   * 刚打开 ⌘K 就按的 Esc 被它吃掉、⌘K 关不上（铃铛同理用 tipOpen）
   */
  searchOpen: boolean;
  onAbout: () => void;
  onLogin: () => void;
  onSignOut: () => void;
  /** 收起 / 展开；图标栏档位和抽屉里没有这个按钮 */
  onToggle?: () => void;
}

export function TenantMark({ name }: { name: string }) {
  return (
    <span className="tenant-logo" aria-hidden="true">
      {firstChar(name)}
    </span>
  );
}

/** 实体项右侧的条目数：取自列表（与列表页共用缓存）；13 text-3 等宽数字，不做成徽标 */
function EntityCount({ kind }: { kind: CatalogKind }) {
  const q = useQuery(catalogListQuery(kind));
  return q.data ? <span className="nav-count">{q.data.items.length}</span> : null;
}

/** 「会话」右侧的等人接手数：展开时是软徽标，收起时是叠在图标上的实心徽标；0 不画 */
function WaitingBadge({ solid }: { solid: boolean }) {
  const { count } = useWaitingCount();
  const flash = useChangeFlash(count);
  const text = badgeText(count);
  if (!text) return null;
  const cls = solid ? 'badge-solid' : 'badge-soft';
  return (
    <span key={flash} className={flash ? `${cls} count-flash` : cls} aria-label={`等人接手${text}个`}>
      {text}
    </span>
  );
}

function NavLink({ item, selected, collapsed }: { item: NavItem; selected: boolean; collapsed: boolean }) {
  const kind = item.entity === undefined ? null : catalogKind(item.entity);
  // 收起时标签只是看不见（shell.css），名字仍从内容来，「会话」的实心徽标也读得到
  const common = { className: selected ? 'nav-item is-selected' : 'nav-item' };
  const body: ReactNode = (
    <>
      <Icon of={navIcon(item.icon)} className="nav-icon" />
      <span className="nav-label">{item.label}</span>
      {item.waiting && <WaitingBadge solid={collapsed} />}
      {kind && !collapsed && <EntityCount kind={kind} />}
    </>
  );
  const link: ReactNode = kind ? (
    <Link to="/catalog/$kind" params={{ kind }} {...common}>
      {body}
    </Link>
  ) : item.key === '/conversations' ? (
    <Link to="/conversations" {...common}>
      {body}
    </Link>
  ) : item.key === '/audit' ? (
    <Link to="/audit" {...common}>
      {body}
    </Link>
  ) : (
    <Link to="/sop" {...common}>
      {body}
    </Link>
  );
  return collapsed ? (
    <Tooltip title={item.label} placement="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

/**
 * 租户行的内容（侧栏与 <992 的顶栏共用）：租户 logo 与名称，成员另有铃铛；匿名没有铃铛（spec「外壳 · 匿名 demo」）。
 * 收起时只剩 logo：它是 role="img"、名字是租户名，可以聚焦，聚焦和悬停都出 Tooltip
 */
export function TenantRow({
  viewer,
  pack,
  collapsed,
  bellPlacement,
}: {
  viewer: ShellViewer;
  pack: IndustryPack;
  collapsed: boolean;
  bellPlacement: PopoverProps['placement'];
}) {
  const tenant = tenantLabel(viewer);
  return (
    <>
      {collapsed ? (
        <Tooltip title={tenant} placement="right">
          <span className="tenant" role="img" tabIndex={0} aria-label={tenant}>
            <TenantMark name={tenant} />
          </span>
        </Tooltip>
      ) : (
        <span className="tenant">
          <TenantMark name={tenant} />
          <span className="tenant-name">{tenant}</span>
        </span>
      )}
      {viewer.kind === 'member' && <Bell pack={pack} placement={bellPlacement} />}
    </>
  );
}

export function Sidebar(props: SidebarProps) {
  const { viewer, pack, groups, selected, collapsed } = props;
  const toggle = props.onToggle && (
    <IconButton
      icon={PanelLeft}
      label={collapsed ? '展开侧栏' : '收起侧栏'}
      placement={collapsed ? 'right' : 'top'}
      onClick={props.onToggle}
      className="sidebar-toggle"
    />
  );
  return (
    <div className={collapsed ? 'sidebar is-collapsed' : 'sidebar'}>
      <div className="sb-tenant">
        <TenantRow viewer={viewer} pack={pack} collapsed={collapsed} bellPlacement="rightTop" />
      </div>
      {collapsed ? (
        <IconButton
          icon={Search}
          size={32}
          label="搜索"
          tip={`搜索（${props.shortcut.label}）`}
          placement="right"
          tipOpen={props.searchOpen ? false : undefined}
          className="sb-search-icon"
          aria-keyshortcuts={props.shortcut.aria}
          onClick={props.onSearch}
        />
      ) : (
        <Tooltip title={props.shortcut.label} placement="right" open={props.searchOpen ? false : undefined}>
          <button type="button" className="sb-search" onClick={props.onSearch} aria-keyshortcuts={props.shortcut.aria}>
            <Icon of={Search} />
            <span className="sb-search-text">{props.placeholder}</span>
          </button>
        </Tooltip>
      )}
      <nav className="sb-nav" aria-label="主导航">
        {groups.map((g) => (
          <div key={g.key} className="nav-group">
            {g.title && !collapsed && <div className="nav-group-title">{g.title}</div>}
            {g.items.map((item) => (
              <NavLink key={item.key} item={item} selected={item.key === selected} collapsed={collapsed} />
            ))}
          </div>
        ))}
      </nav>
      <div className="sb-user">
        {viewer.kind === 'member' ? (
          <UserMenu me={viewer.me} collapsed={collapsed} onAbout={props.onAbout} onSignOut={props.onSignOut} />
        ) : collapsed ? (
          <IconButton icon={LogIn} size={32} label="登录" placement="right" onClick={props.onLogin} />
        ) : (
          <Button className="sb-login" onClick={props.onLogin}>
            登录
          </Button>
        )}
        {viewer.kind === 'anon' && <IconButton icon={Info} label="关于" placement={collapsed ? 'right' : 'top'} onClick={props.onAbout} />}
        {toggle}
      </div>
    </div>
  );
}
