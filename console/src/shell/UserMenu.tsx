// 侧栏底部的用户行与用户菜单（spec「外壳 · 用户行」「外壳 · 用户菜单」，设计系统 §4.2 第 5 项）。
// 用户行：头像、名字、角色。放不下时先藏角色：名字和角色在同一个 22 高、可换行、裁掉溢出的容器里，角色整个折到第二行被裁掉，
// 名字完整显示；名字本身也放不下才省略名字。纯 CSS，不用 JS 测宽（shell.css 的 .user-names）。
// 角色仍在 Tooltip（「名字·角色」）、菜单的身份块和读屏里：裁掉不是隐藏。
// 用户菜单向上弹出：身份块、外观（浅色〔默认〕/ 深色 / 跟随系统）、减少动态效果、关于、退出登录。没有单键切主题的快捷键。
// 外观与「减少动态效果」存在 localStorage（theme/prefs.ts，读写都包 try/catch）；切外观时下一帧就是终值颜色（data-theme-switching）。
// 点这两样只改偏好，菜单（连同外观子菜单）不收起，勾、开关和「外观」右边的值当场换成新的；关于、退出登录点了照常收起。
// 读屏：用户按钮的名字是「名字，角色」（收起时名字和角色都不画，按钮上只剩头像）；外观三项是 menuitemradio、
// 减少动态效果是 menuitemcheckbox，都带 aria-checked；子菜单的箭头换成 lucide 的 chevron-right，不带 antd 图标的英文名
import { Dropdown, type MenuProps, Tooltip } from 'antd';
import { Check, ChevronRight, ChevronsUpDown, LogOut } from 'lucide-react';
import { useReducer, useRef, useState } from 'react';
import type { Me } from '../../../src/shared/console-api.js';
import { ROLE_LABEL } from '../../../src/shared/ui-labels.js';
import { PopupRegion, popupRegion } from '../parts/popupRegion.js';
import { type Appearance, getPrefs, setAppearance, setReduceMotion } from '../theme/prefs.js';
import { Icon } from './icons.js';
import { avatarIndex, firstChar } from './model.js';

export const APPEARANCE_LABEL: Readonly<Record<Appearance, string>> = { light: '浅色', dark: '深色', system: '跟随系统' };
const APPEARANCES: readonly Appearance[] = ['light', 'dark', 'system'];

export function Avatar({ name }: { name: string }) {
  return (
    <span className={`avatar avatar-${avatarIndex(name)}`} aria-hidden="true">
      {firstChar(name)}
    </span>
  );
}

/** 用户按钮里的名字与角色（纯 CSS 先藏角色） */
export function UserNames({ name, role }: { name: string; role: string }) {
  return (
    <span className="user-names">
      <span className="user-name">{name}</span>
      <span className="user-role">{role}</span>
    </span>
  );
}

export interface UserMenuProps {
  me: Me;
  collapsed: boolean;
  onAbout: () => void;
  onSignOut: () => void;
}

/** 菜单项上的读屏属性：rc-menu 把条目上多余的键原样放到 li 上（role 盖掉默认的 menuitem） */
const checkable = (role: 'menuitemradio' | 'menuitemcheckbox', checked: boolean): object => ({ role, 'aria-checked': checked });

/** 用户菜单的条目（外观子菜单、减少动态效果、关于、退出登录）；身份块在 popupRender 里 */
export function userMenuItems({ appearance, reduce }: { appearance: Appearance; reduce: boolean }): NonNullable<MenuProps['items']> {
  return [
    {
      key: 'appearance',
      label: (
        <span className="menu-row">
          <span>外观</span>
          <span className="menu-value">{APPEARANCE_LABEL[appearance]}</span>
        </span>
      ),
      popupClassName: 'user-submenu',
      // 子菜单另挂在 body 下、在地标外面：同样包成有名字的区域（parts/popupRegion.tsx）
      popupRender: popupRegion('外观'),
      children: APPEARANCES.map((a) => ({
        key: `appearance:${a}`,
        ...checkable('menuitemradio', a === appearance),
        label: (
          <span className="menu-row">
            <span>{a === 'light' ? '浅色（默认）' : APPEARANCE_LABEL[a]}</span>
            {a === appearance && <Icon of={Check} className="menu-check" />}
          </span>
        ),
      })),
    },
    {
      key: 'reduce-motion',
      ...checkable('menuitemcheckbox', reduce),
      label: (
        <span className="menu-row">
          <span>减少动态效果</span>
          {/* 只是个样子：开关状态由这一项的 aria-checked 说（菜单项里再放一个按钮是嵌套的可交互元素，读屏照样能停上去） */}
          <span className={reduce ? 'menu-switch is-on' : 'menu-switch'} aria-hidden="true" />
        </span>
      ),
    },
    { key: 'about', label: '关于' },
    { type: 'divider' },
    { key: 'logout', label: '退出登录', icon: <Icon of={LogOut} /> },
  ];
}

/** 子菜单的箭头（设计系统 §4.2 第 5 项：`chevron-right`），放在 antd 下拉菜单给箭头留的位置上 */
const SUBMENU_ARROW = (
  <span className="ant-dropdown-menu-submenu-arrow">
    <Icon of={ChevronRight} size={14} className="ant-dropdown-menu-submenu-arrow-icon" />
  </span>
);

export function UserMenu({ me, collapsed, onAbout, onSignOut }: UserMenuProps) {
  const role = ROLE_LABEL[me.role];
  const [open, setOpen] = useState(false);
  // 偏好只存在 prefs.ts 一处（⌘K、别的标签页也会改），每次渲染现读；这里改了以后重渲一次
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const { appearance, reduceMotion: reduce } = getPrefs();
  // 点外观、「减少动态效果」只改偏好，菜单不收起。收起不行：antd 的弹层收起以后不再重渲内容（@rc-component/trigger 关着时
  // 缓存弹层），点得快时外观子菜单还会被点之前悬停排下的定时器重新打开，勾停在旧值上，直到再打开菜单（验收之后在浏览器里看到）
  const keepOpen = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const items = userMenuItems({ appearance, reduce });

  const onClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    // 键盘的 Enter 在 keydown 里就点了菜单项：拦下默认动作，这一下不再落到随即拿到焦点的按钮上（同话术页、条目详情的「更多」）
    if (domEvent.type === 'keydown') domEvent.preventDefault();
    if (key.startsWith('appearance:')) {
      keepOpen.current = true;
      setAppearance(key.slice('appearance:'.length) as Appearance);
      rerender();
    } else if (key === 'reduce-motion') {
      keepOpen.current = true;
      setReduceMotion(!reduce);
      rerender();
    } else if (key === 'about') {
      // 先把焦点放回用户按钮再开「关于」：弹窗记下打开时的焦点、关上时还回去，菜单项那时已经收起，还不回去就掉到 body 上
      button.current?.focus();
      onAbout();
    } else if (key === 'logout') onSignOut();
  };

  return (
    <Dropdown
      open={open}
      onOpenChange={(next, info) => {
        if (!next && info.source === 'menu' && keepOpen.current) {
          keepOpen.current = false;
          return;
        }
        setOpen(next);
      }}
      trigger={['click']}
      placement="topLeft"
      // 键盘打开时焦点进菜单（第一项「外观」）；鼠标点开的不动（parts/popupRegion.tsx）。收起以后卸下：rc-menu 只在鼠标移开时
      // 清掉高亮，键盘停过的那一项不卸下的话，下次用鼠标点开还亮着
      autoFocus
      destroyOnHidden
      // multiple：rc-menu 点了条目就收起子菜单，只有 multiple 时不收；selectable 关着，multiple 不管别的
      menu={{ items, onClick, selectable: false, multiple: true, expandIcon: SUBMENU_ARROW }}
      rootClassName="user-menu-root"
      // 弹层挂在 body 下、在侧栏的地标外面：整块是一个有名字的区域「用户选项」（axe region）；外观子菜单另挂，见 userMenuItems。
      // 包的这一层接住打开时的 focus()、Esc 与 Tab 把焦点还给用户按钮（parts/popupRegion.tsx）
      popupRender={(menu) => (
        <PopupRegion className="user-menu" label="用户选项">
          <div className="user-menu-id">
            <div className="user-menu-name">{me.displayName}</div>
            <div className="user-menu-role">{role}</div>
          </div>
          <div className="user-menu-divider" />
          {menu}
        </PopupRegion>
      )}
    >
      <Tooltip title={`${me.displayName}·${role}`} placement={collapsed ? 'right' : 'top'} open={open ? false : undefined}>
        <button
          ref={button}
          type="button"
          className="user-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${me.displayName}，${role}`}
        >
          <Avatar name={me.displayName} />
          <UserNames name={me.displayName} role={role} />
          <Icon of={ChevronsUpDown} size={14} className="user-chevron" />
        </button>
      </Tooltip>
    </Dropdown>
  );
}
