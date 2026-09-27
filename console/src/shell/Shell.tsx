// 外壳（spec「逐页设计 · 外壳」，设计系统 §4）：侧栏 240（收起 56）加一块内嵌的内容面板，没有全宽页头。
// - 启动：并发取 /me 与 /pack，两个都回来才渲染侧栏和路由；没回来时 300ms 后出骨架；出错整页说明（判定在 boot.ts）。
// - 成员与 demo 匿名进同一个外壳；匿名没有铃铛、会话和审计入口，每页页头下挂横幅（PageHeader）。成员身份下挂就地登录框
//   （会话过期时弹出，不卸载页面）；viewer 已经有值时，刷新失败也照旧按原来的身份渲染。
// - 收起是受控的：进入销售话术页时默认收起为 56，换页时回到那一页的默认；视口三档由 useViewport() 判断，
//   992–1279 固定是图标栏，<992 侧栏隐藏，52 高的顶栏里的菜单按钮打开抽屉。
// - 每页首个可聚焦元素是「跳到主要内容」；侧栏的导航是 nav 地标，内容面板是 main 地标。
// - 退出没成功（服务端的会话还在）时仍是成员，错误就地显示在内容区顶上
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Drawer } from 'antd';
import { Info, LogIn, LogOut, Menu, Moon, Sun, SunMoon } from 'lucide-react';
import { type MouseEvent, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { catalogKind } from '../api.js';
import { LoginPage } from '../pages/LoginPage.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { ERROR_COPY } from '../parts/errors.js';
import { SessionExpiredDialog } from '../SessionExpiredDialog.js';
import { getPrefs, setAppearance, setReduceMotion } from '../theme/prefs.js';
import { logout, useViewer, VIEWER_KEY, type Viewer } from '../viewer.js';
import { AboutDialog } from './AboutDialog.js';
import { Bell } from './Bell.js';
import { CommandPalette, type PaletteAction } from './CommandPalette.js';
import { isMac, useDocumentTitle, useViewport } from './hooks.js';
import { IconButton } from './IconButton.js';
import { navIcon } from './icons.js';
import {
  buildNav,
  collapsedByDefault,
  documentTitle,
  searchPlaceholder,
  selectedNavKey,
  type ShellViewer,
  sidebarMode,
  tenantLabel,
  workbenchHref,
} from './model.js';
import { shellViewerOf } from './PageHeader.js';
import { isPaletteShortcut, type StaticRow } from './search.js';
import { Sidebar, TenantMark } from './Sidebar.js';

/** 整页的说明或出错（启动失败、文件模式）：没有外壳，居中一块 */
function Whole({ children }: { children: ReactElement }) {
  useDocumentTitle('后台');
  return <div className="boot-whole">{children}</div>;
}

/** 启动时两个请求都没回来：侧栏骨架（租户行、搜索、6 行导航）加面板骨架，延迟 300ms 出现 */
function BootSkeleton() {
  useDocumentTitle('后台');
  return (
    <div className="shell shell-expanded state-skeleton" role="status" aria-label="正在载入">
      <div className="sidebar boot-sidebar" aria-hidden="true">
        <div className="sb-tenant">
          <span className="skeleton-bar" style={{ width: 120 }} />
        </div>
        <div className="sb-search boot-block" />
        {[72, 56, 64, 48, 60, 52].map((w, i) => (
          <div key={i} className="nav-item">
            <span className="skeleton-bar" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <div className="shell-panel" aria-hidden="true">
        <div className="shell-content">
          <span className="skeleton-bar boot-title" />
          <span className="skeleton-bar boot-line" />
        </div>
      </div>
    </div>
  );
}

export function Shell() {
  const viewer = useViewer();
  const v = viewer.data;
  if (v === undefined) {
    if (viewer.isPending) return <BootSkeleton />;
    return (
      <Whole>
        <StateView error={viewer.error} onRetry={() => void viewer.refetch()} />
      </Whole>
    );
  }
  if (v.kind === 'disabled') {
    return (
      <Whole>
        <EmptyBlock title={ERROR_COPY.db_disabled!.title as string} />
      </Whole>
    );
  }
  if (v.kind === 'login') return <LoginPage />;
  return <Frame viewer={v} />;
}

type Framed = Extract<Viewer, { kind: 'member' | 'anon' }>;

function Frame({ viewer: v }: { viewer: Framed }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tier = useViewport();
  const sv = shellViewerOf(v) as ShellViewer;
  const pack: IndustryPack = v.pack;
  // v 是查询缓存里的对象，身份不变时引用不变
  const groups = useMemo(() => buildNav(pack, shellViewerOf(v) as ShellViewer), [pack, v]);
  const selected = selectedNavKey(path, groups);
  const placeholder = searchPlaceholder(pack, sv);
  const shortcut = isMac() ? '⌘K' : 'Ctrl+K';

  // 收起：每页有默认（销售话术默认收起）；用户在这一页切过就按切的，换到别的页回到那一页的默认
  const pageKey = selected ?? path;
  const [override, setOverride] = useState<{ page: string; collapsed: boolean } | null>(null);
  const collapsed = override?.page === pageKey ? override.collapsed : collapsedByDefault(path);
  // <992 的导航抽屉：在哪个地址打开的；换了地址（点了导航）就算关上
  const [drawerAt, setDrawerAt] = useState<string | null>(null);
  const drawerOpen = drawerAt === path;
  // 面板自己滚动（路由的滚动还原只管 window）：换了地址回到顶上
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef(path);
  useEffect(() => {
    if (scrolledFor.current === path) return;
    scrolledFor.current = path;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [path]);
  const mode = sidebarMode(tier, collapsed);

  const [searchOpen, setSearchOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [logoutError, setLogoutError] = useState<unknown>(null);

  // ⌘K / Ctrl+K 打开或关上搜索，在哪里都认（输入框里也认：带修饰键，不会和输入冲突）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const login = useCallback(() => qc.setQueryData<Viewer>(VIEWER_KEY, { kind: 'login' }), [qc]);
  const signOut = useCallback(async (): Promise<void> => {
    setLogoutError(null);
    try {
      await logout();
    } catch (e) {
      setLogoutError(e);
      return;
    }
    // 不能 clear() 再 invalidate：clear 只把查询拿出缓存、不通知还挂着的 observer，invalidate 又找不到它，页面就停在成员视图。
    // 先拿掉其余查询（草稿、审计这些成员才看得到的），再重置 viewer：外壳转成骨架，重新判断来者（demo 匿名或登录页）
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== VIEWER_KEY[0] });
    await qc.resetQueries({ queryKey: VIEWER_KEY });
  }, [qc]);

  const focusMain = (e: MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault();
    document.getElementById('main')?.focus();
  };

  // ⌘K 的「页面」与「操作」
  const pages: StaticRow<PaletteAction>[] = groups.flatMap((g) =>
    g.items.flatMap((item): StaticRow<PaletteAction>[] => {
      const kind = item.entity === undefined ? null : catalogKind(item.entity);
      if (item.entity !== undefined && !kind) return [];
      const go = (): void => {
        if (kind) void navigate({ to: '/catalog/$kind', params: { kind } });
        else if (item.key === '/conversations') void navigate({ to: '/conversations' });
        else if (item.key === '/audit') void navigate({ to: '/audit' });
        else void navigate({ to: '/sop' });
      };
      return [{ key: `page:${item.key}`, label: item.label, hint: g.title ?? undefined, icon: navIcon(item.icon), action: go }];
    }),
  );
  const prefs = getPrefs();
  const actions: StaticRow<PaletteAction>[] = [
    { key: 'appearance:light', label: '外观：浅色', icon: Sun, action: () => setAppearance('light') },
    { key: 'appearance:dark', label: '外观：深色', icon: Moon, action: () => setAppearance('dark') },
    { key: 'appearance:system', label: '外观：跟随系统', icon: SunMoon, action: () => setAppearance('system') },
    {
      key: 'reduce-motion',
      label: prefs.reduceMotion ? '关闭减少动态效果' : '打开减少动态效果',
      action: () => setReduceMotion(!getPrefs().reduceMotion),
    },
    { key: 'about', label: '关于', icon: Info, action: () => setAboutOpen(true) },
    sv.kind === 'member'
      ? { key: 'logout', label: '退出登录', icon: LogOut, action: () => void signOut() }
      : { key: 'login', label: '登录', icon: LogIn, action: login },
  ];

  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      viewer={sv}
      pack={pack}
      groups={groups}
      selected={selected}
      collapsed={!inDrawer && mode === 'collapsed'}
      placeholder={placeholder}
      shortcut={shortcut}
      onSearch={() => setSearchOpen(true)}
      onAbout={() => setAboutOpen(true)}
      onLogin={login}
      onSignOut={() => void signOut()}
      onToggle={!inDrawer && tier === 'wide' ? () => setOverride({ page: pageKey, collapsed: !collapsed }) : undefined}
    />
  );

  return (
    <div className={`shell shell-${mode}`}>
      <a className="skip-link" href="#main" onClick={focusMain}>
        跳到主要内容
      </a>
      {mode === 'hidden' ? (
        <header className="topbar">
          <IconButton icon={Menu} size={32} label="打开导航" placement="bottom" onClick={() => setDrawerAt(path)} />
          <span className="tenant">
            <TenantMark name={tenantLabel(sv)} />
            <span className="tenant-name">{tenantLabel(sv)}</span>
          </span>
          {sv.kind === 'member' && <Bell pack={pack} placement="bottomRight" />}
        </header>
      ) : (
        sidebar(false)
      )}
      <div className="shell-panel">
        <div className="shell-scroll" ref={scrollRef}>
          <main id="main" tabIndex={-1} className="shell-content">
            {sv.kind === 'member' && logoutError !== null && (
              <div className="shell-alert">
                <ErrorAlert error={logoutError} title="没退出登录" onRetry={() => void signOut()} />
              </div>
            )}
            <Outlet />
          </main>
        </div>
      </div>
      {mode === 'hidden' && (
        <Drawer open={drawerOpen} placement="left" size={240} closable={false} onClose={() => setDrawerAt(null)} rootClassName="nav-drawer">
          {sidebar(true)}
        </Drawer>
      )}
      <CommandPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        viewer={sv}
        pack={pack}
        placeholder={placeholder}
        pages={pages}
        actions={actions}
        // 条目详情页在第 10 步（/catalog/$kind/$code）；在那之前打开这个实体的列表
        openEntity={(kind) => {
          const k = catalogKind(kind);
          if (k) void navigate({ to: '/catalog/$kind', params: { kind: k } });
        }}
        openConversation={(row) => window.open(workbenchHref(row.id), '_blank', 'noopener,noreferrer')}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      {sv.kind === 'member' && <SessionExpiredDialog />}
    </div>
  );
}

export function NotFound() {
  const viewer = shellViewerOf(useViewer().data);
  useDocumentTitle(viewer ? documentTitle(['没有这个页面'], viewer) : '没有这个页面');
  return <EmptyBlock title="没有这个页面" description="地址可能写错了" link={<Link to="/sop">回到销售话术</Link>} />;
}
