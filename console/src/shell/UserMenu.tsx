// 侧栏底部的用户行与用户菜单（spec「外壳 · 用户行」「外壳 · 用户菜单」，设计系统 §4.2 第 5 项）。
// 用户行：头像、名字、角色。放不下时先藏角色：名字和角色在同一个 22 高、可换行、裁掉溢出的容器里，角色整个折到第二行被裁掉，
// 名字完整显示；名字本身也放不下才省略名字。纯 CSS，不用 JS 测宽（shell.css 的 .user-names）。
// 角色仍在 Tooltip（「名字·角色」）、菜单的身份块和读屏里：裁掉不是隐藏。
// 用户菜单向上弹出：身份块、外观（浅色〔默认〕/ 深色 / 跟随系统）、减少动态效果、关于、退出登录。没有单键切主题的快捷键。
// 外观与「减少动态效果」存在 localStorage（theme/prefs.ts，读写都包 try/catch）；切外观时下一帧就是终值颜色（data-theme-switching）
import { Dropdown, type MenuProps, Switch, Tooltip } from 'antd';
import { Check, ChevronsUpDown, LogOut } from 'lucide-react';
import { useReducer, useRef, useState } from 'react';
import type { Me } from '../../../src/shared/console-api.js';
import { type Appearance, getPrefs, setAppearance, setReduceMotion } from '../theme/prefs.js';
import { Icon } from './icons.js';
import { avatarIndex, firstChar, ROLE_LABEL } from './model.js';

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

export function UserMenu({ me, collapsed, onAbout, onSignOut }: UserMenuProps) {
  const role = ROLE_LABEL[me.role];
  const [open, setOpen] = useState(false);
  // 偏好只存在 prefs.ts 一处（⌘K、别的标签页也会改），每次渲染现读；这里改了以后重渲一次
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const { appearance, reduceMotion: reduce } = getPrefs();
  // 点「减少动态效果」只拨开关，菜单不收起
  const keepOpen = useRef(false);

  const items: MenuProps['items'] = [
    {
      key: 'appearance',
      label: (
        <span className="menu-row">
          <span>外观</span>
          <span className="menu-value">{APPEARANCE_LABEL[appearance]}</span>
        </span>
      ),
      popupClassName: 'user-submenu',
      children: APPEARANCES.map((a) => ({
        key: `appearance:${a}`,
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
      label: (
        <span className="menu-row">
          <span>减少动态效果</span>
          <Switch size="small" checked={reduce} tabIndex={-1} aria-hidden="true" />
        </span>
      ),
    },
    { key: 'about', label: '关于' },
    { type: 'divider' },
    { key: 'logout', label: '退出登录', icon: <Icon of={LogOut} /> },
  ];

  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key.startsWith('appearance:')) {
      setAppearance(key.slice('appearance:'.length) as Appearance);
      rerender();
    } else if (key === 'reduce-motion') {
      keepOpen.current = true;
      setReduceMotion(!reduce);
      rerender();
    } else if (key === 'about') onAbout();
    else if (key === 'logout') onSignOut();
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
      menu={{ items, onClick, selectable: false }}
      rootClassName="user-menu-root"
      popupRender={(menu) => (
        <div className="user-menu">
          <div className="user-menu-id">
            <div className="user-menu-name">{me.displayName}</div>
            <div className="user-menu-role">{role}</div>
          </div>
          <div className="user-menu-divider" />
          {menu}
        </div>
      )}
    >
      <Tooltip title={`${me.displayName}·${role}`} placement={collapsed ? 'right' : 'top'} open={open ? false : undefined}>
        <button type="button" className="user-btn" aria-haspopup="menu" aria-expanded={open}>
          <Avatar name={me.displayName} />
          <UserNames name={me.displayName} role={role} />
          <Icon of={ChevronsUpDown} size={14} className="user-chevron" />
        </button>
      </Tooltip>
    </Dropdown>
  );
}
