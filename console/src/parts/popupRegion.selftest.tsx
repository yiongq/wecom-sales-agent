// 包了 popupRegion 的弹层的键盘与焦点（02 plan 第 20.1 步，后台 UX plan「Open」验收之后那一条；后台 UX spec「可访问性 · 键盘」）。
// 1. 三个入口（用户菜单、话术页的「更多」、条目详情的「更多」）：键盘打开后焦点在菜单项上，↓ 在菜单项间移动，Enter 触发，
//    Esc 关上、焦点回到按钮，Tab / Shift+Tab 关上、从按钮往后 / 往前走（同列表筛选）；鼠标点开的不动焦点、没有高亮的项，
//    之后按 Tab 照旧进菜单。用户菜单的外观子菜单：→ 进去、焦点在选中的那一项，Enter 选了不收起，Esc 只关子菜单，
//    「关于」打开之前焦点先回到用户按钮（弹窗关上时还给它）。
//    鼠标与键盘混用（第 20.1 步审查之后补的）：鼠标点开后 Shift+Tab 关上往前走；鼠标点进菜单项、子菜单的项以后 Esc、Tab
//    照样回到按钮（子菜单的 Esc 只关子菜单）；点身份块、菜单与子菜单的内边距、禁用的项，焦点不动（不落到 ul、不掉到 body）；
//    话术页没有草稿（一项都聚焦不了）时鼠标点开后第一下 Tab 就关上往后走；Shift+Tab 回到按钮以后读屏「点」开照样转进菜单。
// 2. 下拉选择与联想的弹层也经 popupRegion 包：点弹层空白处、点列表、用鼠标选项，焦点都留在输入框里，敲了一半的字与光标不变。
// happy-dom 的焦点比浏览器宽：不可聚焦的元素 focus() 也能聚焦（原来的 bug 在它里面看不出来），按下鼠标、按 Enter、按 Tab
// 也不带浏览器的默认动作，元素也没有布局（rc-menu 的方向键靠 offsetParent 判断可见）。本文件先把这几样按浏览器的规矩补上
// （只在本进程），再经组件按键、点鼠标。真实浏览器里的焦点另在 Chromium 里验过，记在 02 plan「实施记录 · 第 20.1 步」。
// 用法：npx tsx --tsconfig console/tsconfig.json console/src/parts/popupRegion.selftest.tsx
import { win } from '../fields/selftest-dom.js';
import { ConfigProvider } from 'antd';
import { act, type ReactElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Me } from '../../../src/shared/console-api.js';
import type { FieldDef } from '../../../src/shared/pack.js';
import { MoreMenu } from '../catalog/CatalogDetail.js';
import { type FieldEnv, FieldEnvContext } from '../fields/env.js';
import type { RefItem } from '../fields/model.js';
import { RENDERERS } from '../fields/renderers.js';
import { SopActions } from '../sop/HistoryParts.js';
import { UserMenu } from '../shell/UserMenu.js';
import { getPrefs, setAppearance, setReduceMotion } from '../theme/prefs.js';
import { menuFocusTarget, PopupRegion, popupRegion } from './popupRegion.js';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `得到 ${g}，应为 ${w}`);
}

// ---------------- 按浏览器的规矩补上焦点、布局与默认动作 ----------------

/** 浏览器里可聚焦的元素（本文件用得到的几种）：表单控件、带 href 的链接、带 tabindex 的、可编辑的 */
const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]';
/** 收起的弹层（display: none）：antd 收起以后挂 -hidden */
const HIDDEN = '.ant-dropdown-hidden, .ant-select-dropdown-hidden, [hidden]';
const shown = (el: Element): boolean => el.isConnected && !el.closest(HIDDEN);
const focusable = (el: Element): boolean => el.matches(FOCUSABLE) && !(el as HTMLButtonElement).disabled && shown(el);
/** Tab 顺序里的：可聚焦、tabindex 不是负数 */
const tabbable = (el: Element): boolean => focusable(el) && !(Number(el.getAttribute('tabindex') ?? '0') < 0);

const proto = win.HTMLElement.prototype as unknown as HTMLElement;
const realFocus = proto.focus;
// 不可聚焦的元素 focus() 什么都不做（浏览器的行为；happy-dom 照样聚焦）
proto.focus = function focus(this: HTMLElement, opts?: FocusOptions): void {
  if (focusable(this)) realFocus.call(this, opts);
};
// rc-menu 的方向键只在「看得见」的菜单项间走（@rc-component/util 的 isVisible 看 offsetParent），happy-dom 没有布局
Object.defineProperty(proto, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement) {
    return shown(this) ? this.parentElement : null;
  },
});

const active = (): Element | null => document.activeElement;
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').trim();
async function rest(ms = 0): Promise<void> {
  await act(async () => new Promise((r) => setTimeout(r, ms)));
}
/** rc-dropdown 打开以后隔三帧才调 focus()，rc-menu 的方向键也隔一帧：等够 */
const frames = (): Promise<void> => rest(120);

const KEY_CODES: Readonly<Record<string, number>> = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowLeft: 37,
  ' ': 32,
};
/**
 * 在当前焦点上按一个键（keydown 发给焦点所在的元素），再补上浏览器的默认动作：按钮、链接上的 Enter 是一次 detail 为 0 的点击；
 * Tab 按文档顺序把焦点移到下一个（Shift 时上一个）可 Tab 的元素，后面没有了就离开页面（落到 body）。返回 keydown 事件
 */
async function key(name: string, opts: { shift?: boolean } = {}): Promise<KeyboardEvent> {
  const target = active() ?? document.body;
  const e = new win.KeyboardEvent('keydown', {
    key: name,
    keyCode: KEY_CODES[name] ?? 0,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true,
  }) as unknown as KeyboardEvent;
  await act(async () => void target.dispatchEvent(e));
  if (!e.defaultPrevented) {
    if (name === 'Enter' && target.matches('button, a[href]')) {
      await act(
        async () =>
          void target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }) as unknown as Event),
      );
    } else if (name === 'Tab') {
      // 默认动作从按键处理完以后的焦点起算（处理里挪了焦点，就从挪到的地方往后走）
      const from = active() ?? document.body;
      const order = [...document.querySelectorAll('*')].filter(tabbable);
      const after = order.filter((el) => from.compareDocumentPosition(el) & (opts.shift ? 2 : 4));
      const next = opts.shift ? after.at(-1) : after[0];
      await act(async () => {
        if (next) (next as HTMLElement).focus();
        else (active() as HTMLElement | null)?.blur();
      });
    }
  }
  return e;
}
/**
 * 用鼠标点一下：pointerdown、mousedown，没被拦下默认动作时焦点移到点的地方最近的可聚焦祖先（没有就离开当前元素、落到 body），
 * 再 mouseup、click（detail 1）。返回 mousedown 有没有被拦下默认动作
 */
async function mouse(target: Element | null | undefined): Promise<boolean> {
  if (!target) return false;
  const init = { bubbles: true, cancelable: true, button: 0, detail: 1 };
  await act(async () => void target.dispatchEvent(new win.PointerEvent('pointerdown', init) as unknown as Event));
  const down = new win.MouseEvent('mousedown', init) as unknown as MouseEvent;
  await act(async () => void target.dispatchEvent(down));
  if (!down.defaultPrevented) {
    let host: Element | null = target;
    while (host && !focusable(host)) host = host.parentElement;
    await act(async () => {
      if (host) (host as HTMLElement).focus();
      else (active() as HTMLElement | null)?.blur();
    });
  }
  await act(async () => void target.dispatchEvent(new win.MouseEvent('mouseup', init) as unknown as Event));
  await act(async () => void target.dispatchEvent(new win.MouseEvent('click', init) as unknown as Event));
  return down.defaultPrevented;
}

const BARE: FieldEnv = { now: Date.parse('2026-10-03T10:00:00+08:00'), refItems: () => undefined, distinct: () => [] };

async function mount(el: ReactElement, env: FieldEnv = BARE): Promise<{ box: HTMLElement; unmount(): Promise<void> }> {
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  // 动效关掉（同「减少动态效果」）：happy-dom 不发 animationend，开着动效时收起的弹层一直停在离场的那一帧，既不藏起也不卸下
  await act(async () =>
    root.render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <FieldEnvContext.Provider value={env}>{el}</FieldEnvContext.Provider>
      </ConfigProvider>,
    ),
  );
  await rest(0);
  return {
    box,
    async unmount() {
      await act(async () => root.unmount());
      // 弹层的容器留在 body 下：一起拿掉，免得下一段还在
      document.body.replaceChildren();
    },
  };
}

/** 入口前后各放一个按钮：Tab、Shift+Tab 从入口的按钮往哪儿走 */
function Around({ children }: { children: ReactElement }) {
  return (
    <div>
      <button type="button" className="t-before">
        前一个
      </button>
      {children}
      <button type="button" className="t-after">
        后一个
      </button>
    </div>
  );
}

// ---------------- 1. 打开后焦点去哪 ----------------
{
  /** 一个元素：属性与文字 */
  const node = (tag: string, attrs: Readonly<Record<string, string>>, label: string): HTMLElement => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.textContent = label;
    return el;
  };
  const box = document.createElement('div');
  box.append(
    node('li', { role: 'menuitem', 'aria-disabled': 'true' }, '禁用'),
    node('li', { role: 'menuitem', tabindex: '-1' }, '第一项'),
    node('li', { role: 'menuitemradio', 'aria-checked': 'false', tabindex: '-1' }, '没选'),
    node('li', { role: 'menuitemradio', 'aria-checked': 'true', tabindex: '-1' }, '选中'),
  );
  eq('焦点去选中的那一项（menuitemradio 的 aria-checked）', text(menuFocusTarget(box)), '选中');
  box.querySelector('[aria-checked="true"]')?.setAttribute('aria-checked', 'false');
  eq('没有选中的：第一项，跳过禁用的（rc-menu 给禁用的项不带 tabindex）', text(menuFocusTarget(box)), '第一项');
  const off = document.createElement('div');
  off.append(node('li', { role: 'menuitem', 'aria-disabled': 'true' }, '禁用'), node('div', {}, '不是菜单项'));
  eq('一项都聚焦不了：没有', menuFocusTarget(off), undefined);
}

// ---------------- 2. 三个入口 ----------------

/** 开着的那个弹层（rc-trigger 的根上带 -hidden 就是收起了） */
const openPopup = (sel: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(sel)].find(
    (el) => !el.closest(HIDDEN) && !/-leave\b/.test(el.closest('.ant-dropdown')?.className ?? ''),
  );
const inRegion = (label: string): boolean => {
  const a = active();
  return !!a && !!a.closest(`section[aria-label="${label}"]`) && (a.getAttribute('role') ?? '').startsWith('menuitem');
};

interface Entry {
  name: string;
  /** 区域名 */
  region: string;
  el: (log: string[]) => ReactElement;
  trigger: (box: HTMLElement) => HTMLElement | null;
  /** 打开后第一项、↓ 以后的那一项 */
  first: string;
  second: string;
  /** 在第一项上按 Enter 记下的 */
  fired: string;
}

const ME: Me = { userId: 'u1', displayName: '小林', role: 'owner', csrf: 'c', tenantSlug: 't', tenantName: '云途' };

const ENTRIES: Entry[] = [
  {
    name: '用户菜单',
    region: '用户选项',
    el: (log) => (
      <UserMenu
        me={ME}
        collapsed={false}
        onAbout={() => log.push(`关于:${active()?.className === 'user-btn' ? '焦点在用户按钮' : text(active())}`)}
        onSignOut={() => log.push('退出')}
      />
    ),
    trigger: (box) => box.querySelector<HTMLElement>('.user-btn'),
    first: '外观浅色',
    second: '减少动态效果',
    fired: '',
  },
  {
    name: '话术页的「更多」',
    region: '更多操作',
    el: (log) => {
      function Sop() {
        const ref = useRef<HTMLButtonElement>(null);
        return (
          <SopActions
            editable
            discardBlocked={null}
            moreRef={ref}
            onDiscard={() => log.push('丢弃')}
            onHistory={() => log.push('版本记录')}
          />
        );
      }
      return <Sop />;
    },
    trigger: (box) => box.querySelector<HTMLElement>('button[aria-label="更多操作"]'),
    first: '丢弃草稿',
    second: '丢弃草稿',
    fired: '丢弃',
  },
  {
    name: '条目详情的「更多」',
    region: '更多',
    el: (log) => {
      function Detail() {
        const ref = useRef<HTMLButtonElement>(null);
        return <MoreMenu buttonRef={ref} onCopy={() => log.push('复制')} />;
      }
      return <Detail />;
    },
    trigger: (box) => box.querySelector<HTMLElement>('button[aria-label="更多"]'),
    first: '复制为新草稿',
    second: '复制为新草稿',
    fired: '复制',
  },
];

for (const en of ENTRIES) {
  const log: string[] = [];
  const m = await mount(<Around>{en.el(log)}</Around>);
  const btn = en.trigger(m.box);
  const before = m.box.querySelector<HTMLElement>('.t-before');
  // Tab 顺序里按钮前后的那一个（话术页的「更多」后面是「版本记录」）
  const order = [...document.querySelectorAll('*')].filter(tabbable);
  const prev = order[order.indexOf(btn!) - 1];
  const next = order[order.indexOf(btn!) + 1];
  check(`${en.name}：找得到按钮`, !!btn && !!prev && !!next);

  // 键盘：Tab 到按钮、Enter 打开
  before?.focus();
  await key('Tab');
  check(`${en.name}：Tab 到按钮上`, active() === btn);
  await key('Enter');
  await frames();
  eq(
    `${en.name}：Enter 打开，焦点在第一项「${en.first}」上（不在按钮上）`,
    [btn?.getAttribute('aria-expanded'), inRegion(en.region), text(active())],
    ['true', true, en.first],
  );
  await key('ArrowDown');
  await frames();
  eq(`${en.name}：↓ 到下一项（只有一项时停在它上）`, [inRegion(en.region), text(active())], [true, en.second]);
  await key('ArrowUp');
  await frames();
  eq(`${en.name}：↑ 回来`, text(active()), en.first);
  await key('Escape');
  await frames();
  eq(`${en.name}：Esc 关上，焦点回到按钮`, [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);

  // 打开以后、焦点转进菜单之前，焦点被别处拿走（话术页的编辑器在 Chromium 里会这样）：照样转进菜单，Esc 照样回到按钮。
  // 在打开它的那一下点击之后的微任务里拿走，赶在 rc-dropdown 隔几帧调 focus() 之前
  btn?.addEventListener('click', () => queueMicrotask(() => before?.focus()), { once: true });
  await key('Enter');
  await frames();
  check(`${en.name}：打开后焦点被别处拿走，照样转进菜单`, inRegion(en.region));
  await key('Escape');
  await frames();
  eq(
    `${en.name}：这时 Esc 也回到打开它的按钮（不回到拿走焦点的那一处）`,
    [btn?.getAttribute('aria-expanded'), active() === btn],
    ['false', true],
  );

  // Tab、Shift+Tab：关上，从按钮往后、往前走（同列表筛选）
  await key('Enter');
  await frames();
  check(`${en.name}：再打开，焦点又在菜单项上`, inRegion(en.region));
  await key('Tab');
  await frames();
  eq(`${en.name}：Tab 关上菜单，焦点到按钮后面那一个`, [btn?.getAttribute('aria-expanded'), active() === next], ['false', true]);
  btn?.focus();
  await key('Enter');
  await frames();
  await key('Tab', { shift: true });
  await frames();
  eq(`${en.name}：Shift+Tab 关上菜单，焦点到按钮前面那一个`, [btn?.getAttribute('aria-expanded'), active() === prev], ['false', true]);

  // 鼠标点开：焦点不动、没有高亮的项（同改之前）；之后按 Tab 照旧进菜单，Esc 回到按钮
  await mouse(btn);
  await frames();
  eq(
    `${en.name}：鼠标点开，焦点留在按钮上，没有项高亮`,
    [
      btn?.getAttribute('aria-expanded'),
      active() === btn,
      document.querySelectorAll('.ant-dropdown-menu-item-active, .ant-dropdown-menu-submenu-active').length,
    ],
    ['true', true, 0],
  );
  await key('Tab');
  await frames();
  eq(`${en.name}：鼠标点开以后按 Tab，焦点进到第一项`, [inRegion(en.region), text(active())], [true, en.first]);
  await key('Escape');
  await frames();
  eq(`${en.name}：Esc 回到按钮`, [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);

  // 鼠标点开以后按 Shift+Tab：关上，从按钮往前走（不进菜单）
  await mouse(btn);
  await frames();
  const back = await key('Tab', { shift: true });
  await frames();
  eq(
    `${en.name}：鼠标点开以后按 Shift+Tab，菜单关上，焦点到按钮前面那一个（不进菜单、不拦默认动作）`,
    [btn?.getAttribute('aria-expanded'), active() === prev, back.defaultPrevented],
    ['false', true, false],
  );

  // 读屏「点」开（没有按键、没有指针，如 VoiceOver 的 VO+空格）：转进菜单。上一下按键是落到按钮上的 Shift+Tab 也一样
  // （「这一下是 Shift+Tab」只管那一下按键还在派发的时候）
  (next as HTMLElement | undefined)?.focus();
  await key('Tab', { shift: true });
  await act(async () => btn?.click());
  await frames();
  eq(
    `${en.name}：Shift+Tab 回到按钮以后读屏「点」开，焦点转进菜单`,
    [btn?.getAttribute('aria-expanded'), inRegion(en.region)],
    ['true', true],
  );
  await key('Escape');
  await frames();
  eq(`${en.name}：Esc 回到按钮`, [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);

  // 鼠标点开，点菜单本身（ul 的内边距；rc-menu 给 ul tabindex 0）：焦点不落到 ul 上（落上去的话 Esc 时 rc-menu 把焦点挪到
  // 最后一项，菜单卸下以后掉到 body），留在按钮上，Esc 回到按钮
  await mouse(btn);
  await frames();
  const ul = openPopup(`section[aria-label="${en.region}"]`)?.querySelector('[role="menu"]');
  const kept = await mouse(ul);
  await frames();
  eq(
    `${en.name}：鼠标点开、点菜单的内边距，焦点留在按钮上，菜单开着`,
    [!!ul, kept, active() === btn, btn?.getAttribute('aria-expanded')],
    [true, true, true, 'true'],
  );
  await key('Escape');
  await frames();
  eq(`${en.name}：这时 Esc 关上，焦点在按钮上`, [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);

  // Enter 触发（第一项是外观子菜单的用户菜单另测）
  if (en.fired) {
    await key('Enter');
    await frames();
    const enter = await key('Enter');
    await frames();
    eq(
      `${en.name}：在「${en.first}」上按 Enter 触发它，拦下默认动作（这一下不落到随即拿到焦点的按钮上），菜单关上`,
      [log, enter.defaultPrevented, btn?.getAttribute('aria-expanded')],
      [[en.fired], true, 'false'],
    );
  }
  await m.unmount();
}

// 用户菜单：外观子菜单、减少动态效果、关于
{
  setAppearance('light');
  const log: string[] = [];
  const m = await mount(<Around>{ENTRIES[0]!.el(log)}</Around>);
  const btn = m.box.querySelector<HTMLElement>('.user-btn');
  btn?.focus();
  await key('Enter');
  await frames();
  await key('ArrowRight');
  await frames();
  eq(
    '用户菜单：在「外观」上按 →，打开子菜单，焦点在第一项「浅色（默认）」上（子菜单由 rc-menu 自己放焦点）',
    [active()?.closest('section')?.getAttribute('aria-label'), active()?.getAttribute('role'), text(active())],
    ['外观', 'menuitemradio', '浅色（默认）'],
  );
  await key('ArrowDown');
  await frames();
  eq('用户菜单：子菜单里 ↓ 到「深色」', text(active()), '深色');
  const pick = await key('Enter');
  await frames();
  eq(
    '用户菜单：Enter 选深色，菜单与子菜单都开着，焦点还在「深色」上，拦下默认动作',
    [
      getPrefs().appearance,
      btn?.getAttribute('aria-expanded'),
      text(active()),
      active()?.getAttribute('aria-checked'),
      pick.defaultPrevented,
    ],
    ['dark', 'true', '深色', 'true', true],
  );
  await key('Escape');
  await frames();
  eq(
    '用户菜单：子菜单里按 Esc 只关子菜单，焦点回到「外观」，整个菜单还开着',
    [text(active()).startsWith('外观'), btn?.getAttribute('aria-expanded')],
    [true, 'true'],
  );
  await key('ArrowDown');
  await frames();
  eq('用户菜单：↓ 到「减少动态效果」', [text(active()), active()?.getAttribute('aria-checked')], ['减少动态效果', 'false']);
  await key('Enter');
  await frames();
  eq(
    '用户菜单：Enter 打开「减少动态效果」，菜单不收起，焦点还在这一项上',
    [getPrefs().reduceMotion, btn?.getAttribute('aria-expanded'), text(active()), active()?.getAttribute('aria-checked')],
    [true, 'true', '减少动态效果', 'true'],
  );
  await key('Enter');
  await frames();
  await key('ArrowDown');
  await frames();
  eq('用户菜单：↓ 到「关于」', text(active()), '关于');
  const about = await key('Enter');
  await frames();
  eq(
    '用户菜单：Enter 打开「关于」之前焦点先回到用户按钮（关于弹窗关上时还给它），菜单关上',
    [log, about.defaultPrevented, btn?.getAttribute('aria-expanded'), active() === btn],
    [['关于:焦点在用户按钮'], true, 'false', true],
  );
  await key('Enter');
  await frames();
  await key('ArrowUp');
  await frames();
  eq('用户菜单：从「外观」按 ↑ 绕到最后一项「退出登录」', text(active()), '退出登录');
  await key('Enter');
  await frames();
  eq('用户菜单：Enter 退出登录', log, ['关于:焦点在用户按钮', '退出']);
  setAppearance('light');
  await m.unmount();
}

// 用户菜单：鼠标把焦点带进弹层以后（鼠标点开的菜单没调过 focus()），Esc、Tab 照样回到按钮；子菜单里的 Esc 只关子菜单；
// 点身份块（不可聚焦）焦点不动
{
  setAppearance('light');
  const m = await mount(<Around>{ENTRIES[0]!.el([])}</Around>);
  const btn = m.box.querySelector<HTMLElement>('.user-btn');
  const after = m.box.querySelector<HTMLElement>('.t-after');
  const region = (): HTMLElement | undefined => openPopup('section[aria-label="用户选项"]');
  const item = (label: string): HTMLElement | undefined =>
    [...(region()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].find((i) => text(i).startsWith(label));
  const reduceWas = getPrefs().reduceMotion;

  await mouse(btn);
  await frames();
  await mouse(item('减少动态效果'));
  await frames();
  eq(
    '用户菜单：鼠标点开、点「减少动态效果」，菜单不收起，焦点落在这一项上',
    [getPrefs().reduceMotion, btn?.getAttribute('aria-expanded'), text(active())],
    [!reduceWas, 'true', '减少动态效果'],
  );
  await key('Escape');
  await frames();
  eq('用户菜单：这时 Esc 关上，焦点回到用户按钮（不掉到 body）', [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);

  await mouse(btn);
  await frames();
  await mouse(item('减少动态效果'));
  await frames();
  const tab = await key('Tab');
  await frames();
  eq(
    '用户菜单：鼠标点开、点「减少动态效果」以后按 Tab，菜单关上，焦点到用户按钮后面那一个（不在菜单里打转）',
    [btn?.getAttribute('aria-expanded'), active() === after, tab.defaultPrevented],
    ['false', true, false],
  );
  setReduceMotion(reduceWas);

  await mouse(btn);
  await frames();
  const idKept = await mouse(region()?.querySelector('.user-menu-name'));
  await frames();
  eq(
    '用户菜单：鼠标点开、点身份块，焦点留在用户按钮上（不掉到 body），菜单开着',
    [idKept, active() === btn, btn?.getAttribute('aria-expanded')],
    [true, true, 'true'],
  );
  await key('Escape');
  await frames();
  eq('用户菜单：这时 Esc 关上，焦点在用户按钮上', [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);

  await key('Enter');
  await frames();
  await mouse(region()?.querySelector('.user-menu-role'));
  await frames();
  eq('用户菜单：键盘打开、点身份块，焦点留在「外观」上', text(active()).startsWith('外观'), true);
  await key('Escape');
  await frames();
  eq('用户菜单：这时 Esc 回到用户按钮', [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);

  // 鼠标点开、悬停「外观」打开子菜单、点「深色」：焦点在「深色」上；Esc 只关子菜单、焦点回到「外观」，再 Esc 回到用户按钮
  await mouse(btn);
  await frames();
  const title = item('外观');
  await act(async () => void title?.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }) as unknown as Event));
  await rest(250);
  const sub = [...document.querySelectorAll<HTMLElement>('section[aria-label="外观"]')].find(shown);
  // 子菜单的弹层另挂在 body 下（不在下拉菜单的弹层里）：点它的 ul（内边距）焦点同样不动
  const subKept = await mouse(sub?.querySelector('[role="menu"]'));
  await frames();
  eq(
    '用户菜单：鼠标点开、悬停「外观」、点子菜单的内边距，焦点留在用户按钮上（不掉到 body），子菜单开着',
    [!!sub, subKept, active() === btn, title?.getAttribute('aria-expanded')],
    [true, true, true, 'true'],
  );
  const dark = [...(sub?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])].find((i) => text(i) === '深色');
  await mouse(dark);
  await frames();
  eq(
    '用户菜单：鼠标点开、悬停「外观」、点「深色」，选上深色，焦点在「深色」上，菜单开着',
    [!!dark, getPrefs().appearance, text(active()), btn?.getAttribute('aria-expanded')],
    [true, 'dark', '深色', 'true'],
  );
  // 子菜单那一层不处理按键（交给外面那一层）：焦点不会先跳到用户按钮再被 rc-menu 拉回「外观」（读屏会多念一次按钮）
  let hops = 0;
  const hop = (): void => void (hops += 1);
  btn?.addEventListener('focus', hop);
  await key('Escape');
  await frames();
  btn?.removeEventListener('focus', hop);
  eq(
    '用户菜单：这时 Esc 只关子菜单，焦点回到「外观」（中间没有跳到用户按钮），整个菜单还开着',
    [text(active()).startsWith('外观'), hops, title?.getAttribute('aria-expanded'), btn?.getAttribute('aria-expanded')],
    [true, 0, 'false', 'true'],
  );
  await key('Escape');
  await frames();
  eq('用户菜单：再 Esc 关上，焦点回到用户按钮', [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);
  setAppearance('light');
  await m.unmount();
}

// 话术页没有草稿时：「更多」里只有一项禁用的「丢弃草稿」（rc-menu 不给它 tabindex），菜单里一项都聚焦不了
{
  const log: string[] = [];
  function Sop() {
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <SopActions
        editable
        discardBlocked="还没有草稿"
        moreRef={ref}
        onDiscard={() => log.push('丢弃')}
        onHistory={() => log.push('版本记录')}
      />
    );
  }
  const m = await mount(<Around>{<Sop />}</Around>);
  const btn = m.box.querySelector<HTMLElement>('button[aria-label="更多操作"]');
  const history = m.box.querySelector<HTMLElement>('.sop-history-btn');

  await mouse(btn);
  await frames();
  const tab = await key('Tab');
  await frames();
  eq(
    '话术页没有草稿：鼠标点开以后第一下 Tab 就关上菜单、到「版本记录」（不吞掉这一下）',
    [btn?.getAttribute('aria-expanded'), active() === history, tab.defaultPrevented],
    ['false', true, false],
  );

  btn?.focus();
  await key('Enter');
  await frames();
  eq('话术页没有草稿：键盘打开，焦点留在按钮上', [btn?.getAttribute('aria-expanded'), active() === btn], ['true', true]);
  await key('Tab');
  await frames();
  eq('话术页没有草稿：键盘打开以后 Tab 关上、到「版本记录」', [btn?.getAttribute('aria-expanded'), active() === history], ['false', true]);

  btn?.focus();
  await mouse(btn);
  await frames();
  const disabled = openPopup('section[aria-label="更多操作"]')?.querySelector('[aria-disabled="true"]');
  const kept = await mouse(disabled);
  await frames();
  eq(
    '话术页没有草稿：鼠标点开、点禁用的「丢弃草稿」，焦点留在按钮上（不落到菜单的 ul 上），没有丢弃',
    [!!disabled, kept, active() === btn, log],
    [true, true, true, []],
  );
  await key('Escape');
  await frames();
  eq('话术页没有草稿：这时 Esc 关上，焦点在按钮上', [btn?.getAttribute('aria-expanded'), active() === btn], ['false', true]);
  await m.unmount();
}

// ---------------- 3. 下拉选择与联想：焦点留在输入框里 ----------------

const field = (f: Partial<FieldDef> & Pick<FieldDef, 'key' | 'type' | 'label'>): FieldDef => ({ group: 'g', ...f });
const HOTELS: RefItem[] = ['贵阳某某酒店', '荔波某某宾馆', '西江某某客栈'].map((name, i) => ({
  code: `H${i + 1}`,
  name,
  status: 'active',
}));
const ENV: FieldEnv = { ...BARE, refItems: () => HOTELS, entityLabel: () => '酒店', distinct: () => ['贵州', '贵阳', '云南'] };

/** 一个字段的表单控件，值存在自己的状态里 */
function Control({ f, initial }: { f: FieldDef; initial?: unknown }) {
  const [v, setV] = useState<unknown>(initial);
  const R = RENDERERS[f.type].Form;
  return <R field={f} value={v} row={{}} id={`c-${f.key}`} labelId={`l-${f.key}`} ariaLabel={f.label} onChange={setV} />;
}

interface Case {
  name: string;
  f: FieldDef;
  /** 敲进输入框的字（下拉选择没有可敲的就不给） */
  typed?: string;
}
const CASES: Case[] = [
  { name: '联想（文本的 suggest）', f: field({ key: 'dest', type: 'text', label: '目的地', suggest: 'distinct' }), typed: '贵' },
  {
    name: '联想（可以写库外文本的引用）',
    f: field({ key: 'hotel', type: 'reference', label: '当晚住宿', to: 'hotel', allowFree: true }),
    typed: '某某',
  },
  { name: '下拉选择（带搜索的引用）', f: field({ key: 'hotel2', type: 'reference', label: '酒店', to: 'hotel' }), typed: '某某' },
  {
    name: '下拉选择（枚举）',
    f: field({ key: 'month', type: 'enum', label: '出发月份', options: ['1月', '2月', '3月', '4月', '5月', '6月', '7月'] }),
  },
  { name: '下拉选择（标签）', f: field({ key: 'tags', type: 'tags', label: '标签', suggest: ['国内', '亲子', '徒步'] }), typed: '亲' },
];

for (const c of CASES) {
  const m = await mount(<Control f={c.f} />, ENV);
  const input = m.box.querySelector<HTMLInputElement>('input');
  check(`${c.name}：有输入框`, !!input);
  if (!input) continue;
  // 鼠标点进输入框，敲字（联想与带搜索的下拉敲了字才开）；没有可敲的下拉选择点一下就开
  await mouse(input);
  if (c.typed !== undefined) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, c.typed);
      input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    });
    input.setSelectionRange(1, 1);
  }
  await frames();
  const region = openPopup(`section[aria-label="${c.f.label}"]`);
  eq(
    `${c.name}：下拉开着，包在有名字的区域「${c.f.label}」里，焦点还在输入框里（包的这一层不抢）`,
    [!!region, input.getAttribute('aria-expanded'), active() === input],
    [true, 'true', true],
  );
  const caret = (): [string, number | null, number | null] => [input.value, input.selectionStart, input.selectionEnd];
  const was = caret();
  const blanks: [string, Element | null | undefined][] = [
    ['四周的内边距（antd 的弹层根节点，在区域外面）', region?.closest('.ant-select-dropdown')],
    ['区域本身', region],
    ['列表', region?.querySelector('.rc-virtual-list, .rc-virtual-list-holder')],
    ['分组标题', region?.querySelector('.ant-select-item-group')],
  ];
  for (const [where, el] of blanks) {
    if (!el) continue;
    await mouse(el);
    await frames();
    eq(
      `${c.name}：点弹层的${where}，焦点留在输入框里，字与光标不变，下拉还开着`,
      [active() === input, caret(), input.getAttribute('aria-expanded')],
      [true, was, 'true'],
    );
  }
  check(`${c.name}：区域本身不可聚焦（点它不会把焦点从输入框抢走）`, !!region && !focusable(region));
  // 用鼠标选一项：焦点照旧在输入框里
  const option = region?.querySelector('.ant-select-item-option');
  const label = text(option);
  await mouse(option);
  await frames();
  check(`${c.name}：用鼠标选「${label}」，焦点留在输入框里`, !!option && active() === input, text(active()));
  await m.unmount();
}

// 没接过 focus() 的区域（下拉选择、联想的弹层就是这样）：按 Esc 不挪焦点。两种写法都是有名字、不可聚焦的区域
{
  const m = await mount(
    <div>
      <PopupRegion label="样子">
        <button type="button" className="t-inside">
          里面
        </button>
      </PopupRegion>
      {popupRegion('另一种写法')(<span>内容</span>)}
    </div>,
  );
  const inside = m.box.querySelector<HTMLElement>('.t-inside');
  inside?.focus();
  await key('Escape');
  eq('没接过 focus() 的区域：Esc 不挪焦点', active() === inside, true);
  eq(
    'popupRegion() 与 <PopupRegion>：都是有名字的区域，不可聚焦',
    [...m.box.querySelectorAll('section')].map((s) => `${s.getAttribute('aria-label')}|${s.hasAttribute('tabindex')}`),
    ['样子|false', '另一种写法|false'],
  );
  await m.unmount();
}

if (fails.length) {
  console.error(`弹层键盘自测：${fails.length} 条失败（${pass} 条通过）`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`弹层键盘自测：${pass} 条全部通过`);
process.exit(0);
