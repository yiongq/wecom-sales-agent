// 全站的 antd ConfigProvider：按 <html> 上的 data-theme / data-reduce-motion 取亮暗主题（antd.ts），
// 关掉水波纹（wave），表单只给选填字段加「（选填）」、不画星号（design-system §8、§5.2），
// 按钮不在两个汉字之间插空格（「关闭」不写成「关 闭」；中文不手打空格，design-system §2.5），
// Alert 是无描边的语义底色块（§5.12：标题 14/22/500 text、说明 13/20 text-2，图标用描线的）。
// <html> 的两个属性首帧由 /console/theme-boot.js 设好，之后由 prefs.ts 改；这里只是跟着它们走
import { CheckCircleOutlined, ExclamationCircleOutlined, InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { ConfigProvider, type ConfigProviderProps } from 'antd';
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { antdTheme } from './antd.js';
import { applyPrefs, currentThemeState, REDUCED_MOTION_QUERY, watchPrefs } from './prefs.js';

const WAVE = { disabled: true } as const;
const BUTTON: ConfigProviderProps['button'] = { autoInsertSpace: false };
/** Tooltip 无箭头（design-system §5.15） */
const TOOLTIP: ConfigProviderProps['tooltip'] = { arrow: false };

// 图标先用 @ant-design/icons 里描线的那一套，接 lucide 时换成 info / circle-check / triangle-alert / circle-alert
const ALERT: ConfigProviderProps['alert'] = {
  variant: 'filled',
  infoIcon: <InfoCircleOutlined />,
  successIcon: <CheckCircleOutlined />,
  warningIcon: <WarningOutlined />,
  errorIcon: <ExclamationCircleOutlined />,
  styles: {
    title: { fontSize: 14, lineHeight: '22px', fontWeight: 500, color: 'var(--text)' },
    description: { fontSize: 13, lineHeight: '20px', color: 'var(--text-2)' },
  },
};

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

export function ThemeProvider({
  children,
  ...rest
}: Omit<ConfigProviderProps, 'theme' | 'wave' | 'form' | 'button' | 'alert' | 'tooltip'>) {
  // 第三个参数只给 theme.selftest.ts 用：它在 Node 里用 react-dom/server 渲染这个组件，核对传给 ConfigProvider 的东西
  const key = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [mode, reduce] = key.split('|');
  const theme = useMemo(() => antdTheme(mode === 'dark' ? 'dark' : 'light', reduce === '1'), [mode, reduce]);
  useEffect(() => {
    // 首帧已由 theme-boot.js 设好，这里再设一次是兜底（脚本没加载成时晚一帧，但主题照样对）
    applyPrefs();
    return watchPrefs();
  }, []);
  // antd 的 MotionWrapper 只在 motion 第一次与上层不同时才包一层 MotionProvider（用 ref 记住，之后一直包）。
  // 所以运行中第一次打开「减少动态效果」时整棵树换了结构、全部重挂载：用户菜单收起，编辑中的内容也会丢（第 2.2 步走查发现）。
  // 外面垫一层 motion 与首帧相反的 ConfigProvider，里面那层从第一帧起就包着，之后切换只改值、不改结构
  const [outer] = useState(() => ({ token: { motion: reduce === '1' } }));
  return (
    <ConfigProvider theme={outer}>
      <ConfigProvider {...rest} theme={theme} wave={WAVE} form={FORM} button={BUTTON} alert={ALERT} tooltip={TOOLTIP}>
        {children}
      </ConfigProvider>
    </ConfigProvider>
  );
}
