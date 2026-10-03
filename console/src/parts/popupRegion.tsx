// 弹层的地标（spec「可访问性与响应式」，plan 第 16 步）：下拉菜单、下拉选择、铃铛的弹层由 antd 挂在 body 下，在侧栏的 banner、
// 内容面板的 main 这些地标外面。读屏按地标找不到它们，axe 报 region。包一层有名字的区域（section 带 aria-label 就是 region 地标），
// 名字写这个弹层是什么（「更多操作」「筛选：目的地」「选择节」）。弹窗、抽屉是 dialog，本来就不用包。
//
// 键盘与焦点（02 plan 第 20.1 步，后台 UX plan「Open」验收之后那一条）：
// - rc-dropdown 打开时（带 autoFocus）和焦点还在按钮上按 Tab 时，调弹层根节点的 focus()。包了这一层，根节点就是这个 section，
//   不可聚焦，焦点留在按钮上，方向键到不了菜单项。这里不让 section 可聚焦（列表筛选是那样做的），而是经 ref 接住那一下 focus()，
//   转给里面的菜单项（选中的那一项，没有就第一项）；之后方向键、Enter 照 rc-menu 走。
// - 这几种时候不转（focus 是个 getter，给 undefined：rc-dropdown 就当这一层聚焦不了，也不记成已进菜单；按 Tab 时它就关上菜单、
//   不拦默认动作，Tab 照常从按钮往后、Shift+Tab 往前走）：上一下输入是鼠标（指针），鼠标点开的菜单不动焦点、第一项不高亮，
//   同改之前，之后按 Tab 照旧进菜单；这一下是 Shift+Tab（往前走，不进菜单）；这一下 Tab 是在菜单里按的（鼠标点进了菜单项，
//   下面已经把焦点还给按钮）；菜单里一项都聚焦不了（话术页没有草稿时只有一项禁用的「丢弃草稿」）。键盘打开、读屏「点」开
//   （不经过指针）都转。
// - Esc、Tab：先把焦点还给打开它的按钮，菜单由 rc-dropdown 关上，Tab 再从按钮往后（Shift+Tab 往前）走，同列表筛选。
//   打开它的按钮现取：鼠标点开的菜单没调过 focus()，焦点却可能被鼠标带了进来。子菜单（外观）里的 Esc 只关子菜单。
// - 点弹层里不可聚焦的地方（四周的内边距、分组标题、用户菜单的身份块、禁用的菜单项），焦点不动：下拉选择与联想的焦点一直在
//   输入框里（它们不调 focus()，列表上 rc-select 自己拦下了 mousedown 的默认动作，弹层四周的内边距没拦，点上去输入框失焦、
//   下拉收起）；菜单的焦点不掉到 body 上，Esc 照样回到按钮。
import {
  createContext,
  forwardRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';

/** 菜单项：rc-menu 的 menuitem，和条目上改了 role 的 menuitemradio、menuitemcheckbox。带 tabindex 的才可聚焦（rc-menu 给禁用的项不带） */
const MENU_ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** 点了会拿到焦点的元素 */
const FOCUSABLE = 'input, textarea, select, button, a[href], [tabindex], [contenteditable="true"]';

/** 打开后焦点去哪：选中的那一项（menuitemradio 的 aria-checked），没有就第一项；一项都聚焦不了时没有 */
export function menuFocusTarget(root: ParentNode): HTMLElement | undefined {
  const items = [...root.querySelectorAll<HTMLElement>(MENU_ITEM)].filter((i) => i.hasAttribute('tabindex'));
  return items.find((i) => i.getAttribute('role') === 'menuitemradio' && i.getAttribute('aria-checked') === 'true') ?? items[0];
}

/**
 * 打开这个菜单的按钮：开着菜单的菜单按钮（aria-haspopup="menu" 且 aria-expanded="true"，三个入口与列表筛选的按钮都这样写）；
 * 没有这样的按钮时取眼下的焦点。不直接取焦点：话术页的编辑器在菜单打开后、焦点转进菜单前会把焦点拿回去（CodeMirror 量尺寸时
 * 重设选区，Chromium 里实测），那时取到的是编辑器
 */
function openerOf(root: HTMLElement): HTMLElement | null {
  const button = document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
  if (button && !root.contains(button)) return button;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && !root.contains(active) ? active : null;
}

// 上一下输入是不是指针（鼠标、触屏）：按下指针算是，按键算不是；还记下那一下按键。挂在 window 的捕获阶段，比 rc-dropdown 挂在
// window 冒泡阶段的 Tab 处理先到。模块加载时就挂：弹层第一次打开才挂载，等它挂载再听就错过了打开它的那一下
let lastPointer = false;
let lastKey: KeyboardEvent['nativeEvent'] | null = null;
if (typeof window !== 'undefined') {
  const opts = { capture: true, passive: true };
  window.addEventListener('pointerdown', () => void (lastPointer = true), opts);
  window.addEventListener(
    'keydown',
    (e) => {
      lastPointer = false;
      lastKey = e;
    },
    opts,
  );
}

/** 这一下按键还在派发（派发完 eventPhase 回到 NONE）：rc-dropdown 在 Tab 的处理里取 focus 时用，autoFocus 隔几帧取时已经派发完 */
const pressing = (e: Event | null): e is Event => !!e && e.eventPhase !== Event.NONE;

/**
 * 菜单里的子菜单（外观）也包了一层。那一层不处理按键，经 React 树冒到外面那一层再处理：不然子菜单里按 Esc，焦点先跳到用户按钮、
 * 再被 rc-menu 拉回「外观」（读屏多念一次按钮）
 */
const Nested = createContext(false);

/** 弹层的根节点：下拉选择与联想的、下拉菜单的、子菜单的（antd 的内边距在它上面、区域外面） */
const POPUP_ROOT = '.ant-select-dropdown, .ant-dropdown, .ant-dropdown-menu-submenu-popup';

export interface PopupRegionProps {
  /** 区域的名字（读屏按地标列出来的就是它） */
  label: string;
  className?: string;
  children?: ReactNode;
}

/** rc-dropdown 经弹层根节点的 ref 调的只有 focus() */
export interface PopupRegionHandle {
  readonly focus: (() => void) | undefined;
}

export const PopupRegion = forwardRef<PopupRegionHandle, PopupRegionProps>(function PopupRegion({ label, className, children }, ref) {
  const box = useRef<HTMLElement>(null);
  const nested = useContext(Nested);
  // 打开它的按钮（接住 focus() 时记下）。Esc、Tab 把焦点还给它
  const opener = useRef<HTMLElement | null>(null);
  // 在菜单里按的、已经把焦点还给按钮的那一下 Tab
  const left = useRef<Event | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      get focus() {
        if (lastPointer || pressing(left.current)) return undefined;
        if (pressing(lastKey) && lastKey.key === 'Tab' && lastKey.shiftKey) return undefined;
        const root = box.current;
        if (!root || !menuFocusTarget(root)) return undefined;
        return () => {
          opener.current = openerOf(root);
          menuFocusTarget(root)?.focus();
        };
      },
    }),
    [],
  );
  useEffect(() => {
    const popup = box.current?.closest<HTMLElement>(POPUP_ROOT);
    if (!popup) return;
    // 浏览器的默认动作是把焦点挪到点的地方最近的可聚焦祖先，没有就挪到 body 上。菜单本身（rc-menu 的 ul 带 tabindex）不算：
    // 点它的内边距、禁用的项，焦点落在 ul 上，按 Esc 时 rc-menu 再把焦点挪到最后一项，菜单卸下以后掉到 body
    const keep = (e: MouseEvent): void => {
      const host = (e.target as Element).closest(FOCUSABLE);
      if (!host || host.matches('[role="menu"]')) e.preventDefault();
    };
    popup.addEventListener('mousedown', keep);
    return () => popup.removeEventListener('mousedown', keep);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (nested || (e.key !== 'Escape' && e.key !== 'Tab')) return;
    // 子菜单（外观）另挂在 body 下，按键经 React 树冒到这里：Esc 只关子菜单（rc-menu 已经把焦点放回父项），不让它再冒到
    // window 上把整个菜单关掉；Tab 照常整个关上
    if (e.key === 'Escape' && !e.currentTarget.contains(e.target as Node)) {
      e.nativeEvent.stopPropagation();
      return;
    }
    const back = opener.current?.isConnected ? opener.current : openerOf(e.currentTarget);
    if (!back) return;
    back.focus();
    if (e.key === 'Tab') left.current = e.nativeEvent;
  };
  return (
    <section ref={box} className={className} aria-label={label} onKeyDown={onKeyDown}>
      <Nested.Provider value>{children}</Nested.Provider>
    </section>
  );
});

/** 给 antd 的 popupRender 用：popupRender={popupRegion('更多操作')} */
export function popupRegion(label: string): (menu: ReactNode) => ReactElement {
  return function renderPopupRegion(menu: ReactNode): ReactElement {
    return <PopupRegion label={label}>{menu}</PopupRegion>;
  };
}
