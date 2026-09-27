// 控件样张 /_specimen 的懒加载部分：只在 VITE_SPECIMEN=1 的构建里被 router.tsx 引用
import { createLazyRoute } from '@tanstack/react-router';
import { ControlsSpecimen } from './ControlsSpecimen.js';

export const Route = createLazyRoute('/_specimen')({ component: ControlsSpecimen });
