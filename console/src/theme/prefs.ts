// 两项个人偏好：外观（浅色 / 深色 / 跟随系统）与「减少动态效果」（spec「视觉与字体 · 主题」「可访问性与响应式 · 动效」）。
// 存在 localStorage；首帧由 /console/theme-boot.js（console/public/）读出来设到 <html> 的 data-theme 与 data-reduce-motion 上，
// 页面起来以后由这里接管：用户菜单切换、跟随系统时随系统变、别的标签页改了同步。
// theme-boot.js 不能 import 这里（它是 CSP 下的静态脚本），两边的键名、取值和判定由 theme.selftest.ts 对拍。
// 读写 localStorage 都包 try/catch：无痕模式或禁用了存储时，读按默认（浅色、不减少动效），写只在本页生效
import type { ThemeMode } from './tokens.js';

export type Appearance = 'light' | 'dark' | 'system';

export const APPEARANCE_KEY = 'console.appearance';
export const REDUCE_MOTION_KEY = 'console.reduceMotion';
export const DARK_QUERY = '(prefers-color-scheme: dark)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface Prefs {
  appearance: Appearance;
  reduceMotion: boolean;
}

/** 存的值不认识就按默认的浅色（design-system §0 第 1 条：默认浅色，「跟随系统」只是一个选项） */
export function parseAppearance(raw: string | null): Appearance {
  return raw === 'dark' || raw === 'system' ? raw : 'light';
}

export function resolveMode(appearance: Appearance, systemDark: boolean): ThemeMode {
  return appearance === 'dark' || (appearance === 'system' && systemDark) ? 'dark' : 'light';
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存不下就只在本页生效，刷新后回到默认
  }
}

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function readPrefs(): Prefs {
  return { appearance: parseAppearance(read(APPEARANCE_KEY)), reduceMotion: read(REDUCE_MOTION_KEY) === 'true' };
}

/** 本页当前的偏好：存储写不进去时，以这里为准 */
let current: Prefs | null = null;

export function getPrefs(): Prefs {
  current ??= readPrefs();
  return current;
}

/** 把偏好设到 <html> 上。首帧那一次由 theme-boot.js 做，判定与这里相同 */
export function applyPrefs(p: Prefs = getPrefs()): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveMode(p.appearance, matches(DARK_QUERY)));
  if (p.reduceMotion) root.setAttribute('data-reduce-motion', 'true');
  else root.removeAttribute('data-reduce-motion');
}

export function setAppearance(appearance: Appearance): void {
  current = { ...getPrefs(), appearance };
  write(APPEARANCE_KEY, appearance);
  applyPrefs(current);
}

export function setReduceMotion(on: boolean): void {
  current = { ...getPrefs(), reduceMotion: on };
  write(REDUCE_MOTION_KEY, on ? 'true' : 'false');
  applyPrefs(current);
}

/** 跟随系统时随系统切换；别的标签页改了偏好时同步。返回取消监听的函数 */
export function watchPrefs(): () => void {
  const onSystem = (): void => applyPrefs();
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== APPEARANCE_KEY && e.key !== REDUCE_MOTION_KEY) return;
    current = readPrefs();
    applyPrefs(current);
  };
  let mq: MediaQueryList | null = null;
  try {
    mq = window.matchMedia(DARK_QUERY);
  } catch {
    mq = null;
  }
  mq?.addEventListener('change', onSystem);
  window.addEventListener('storage', onStorage);
  return () => {
    mq?.removeEventListener('change', onSystem);
    window.removeEventListener('storage', onStorage);
  };
}

/** 读 <html> 上现在生效的主题与动效开关；「减少动态效果」算上系统的 prefers-reduced-motion（§1.5） */
export function currentThemeState(): { mode: ThemeMode; reduceMotion: boolean } {
  const root = document.documentElement;
  return {
    mode: root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
    reduceMotion: root.getAttribute('data-reduce-motion') === 'true' || matches(REDUCED_MOTION_QUERY),
  };
}
