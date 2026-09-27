// 字段渲染器样张 /_specimen/fields 的懒加载部分：只在 VITE_SPECIMEN=1 的构建里被 router.tsx 引用
import { createLazyRoute } from '@tanstack/react-router';
import { FieldsSpecimen } from './FieldsSpecimen.js';

export const Route = createLazyRoute('/_specimen/fields')({ component: FieldsSpecimen });
