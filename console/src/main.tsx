import './setup.js'; // 必须第一个：CSP 相关的全局设置（见 setup.ts）
import './fonts/fonts.css'; // 自托管字体的 @font-face（由 scripts/fonts/build.ts 生成）
import './theme/brand.css';
import './parts/parts.css'; // 通用部件的样式（全局一份，部件本身不 import CSS，自测才能在 Node 里直接 import 它们）
import './shell/shell.css'; // 外壳的样式，同上
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { cspNonce } from './csp.js';
import { ToastHost } from './parts/toast.js';
import { router } from './router.js';
import { ThemeProvider } from './theme/ThemeProvider.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider locale={zhCN} csp={cspNonce ? { nonce: cspNonce } : undefined}>
      {/* 成功 toast 在内容面板顶部往下 20（面板距窗口顶 8），design-system §5.15 */}
      <AntApp message={{ top: 28, maxCount: 3 }}>
        <ToastHost />
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ThemeProvider>
  </StrictMode>,
);
