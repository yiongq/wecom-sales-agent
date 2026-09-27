import './setup.js'; // 必须第一个：CSP 相关的全局设置（见 setup.ts）
import './theme/brand.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { cspNonce } from './csp.js';
import { router } from './router.js';
import { ThemeProvider } from './theme/ThemeProvider.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider locale={zhCN} csp={cspNonce ? { nonce: cspNonce } : undefined}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ThemeProvider>
  </StrictMode>,
);
