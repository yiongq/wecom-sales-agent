// 全站的 antd ConfigProvider：按 <html> 上的 data-theme / data-reduce-motion 取亮暗主题（antd.ts），
// 关掉水波纹（wave），表单只给选填字段加「（选填）」、不画星号（design-system §8、§5.2）。
// <html> 的两个属性首帧由 /console/theme-boot.js 设好，之后由 prefs.ts 改；这里只是跟着它们走
import { ConfigProvider, type ConfigProviderProps } from 'antd';
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from 'react';
import { antdTheme } from './antd.js';
import { applyPrefs, currentThemeState, REDUCED_MOTION_QUERY, watchPrefs } from './prefs.js';

const WAVE = { disabled: true } as const;

const FORM: ConfigProviderProps['form'] = {
  requiredMark: (label: ReactNode, { required }: { required: boolean }) =>
    required ? (
      label
    ) : (
      <>
        {label}
        <span className="optional-mark">（选填）</span>
      </>
    ),
};

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-reduce-motion'] });
  let mq: MediaQueryList | null = null;
  try {
    mq = window.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    mq = null;
  }
  mq?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    mq?.removeEventListener('change', onChange);
  };
}

/** 快照用字符串，React 按 Object.is 比较，不会每次读出新对象引起重渲 */
function snapshot(): string {
  const s = currentThemeState();
  return `${s.mode}|${s.reduceMotion ? 1 : 0}`;
}

export function ThemeProvider({ children, ...rest }: Omit<ConfigProviderProps, 'theme' | 'wave' | 'form'>) {
  // 第三个参数只给 theme.selftest.ts 用：它在 Node 里用 react-dom/server 渲染这个组件，核对传给 ConfigProvider 的东西
  const key = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [mode, reduce] = key.split('|');
  const theme = useMemo(() => antdTheme(mode === 'dark' ? 'dark' : 'light', reduce === '1'), [mode, reduce]);
  useEffect(() => {
    // 首帧已由 theme-boot.js 设好，这里再设一次是兜底（脚本没加载成时晚一帧，但主题照样对）
    applyPrefs();
    return watchPrefs();
  }, []);
  return (
    <ConfigProvider {...rest} theme={theme} wave={WAVE} form={FORM}>
      {children}
    </ConfigProvider>
  );
}
