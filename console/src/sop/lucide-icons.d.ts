// lucide-react 每个图标模块都导出它的图形数据 __iconData（路径与属性，不带 React）。话术编辑器在 CodeMirror 的部件里
// 自己画 SVG，只要这份数据，不要 React 组件。包没有 exports 字段，单个图标模块可以直接 import，但没有类型声明
declare module 'lucide-react/dist/esm/icons/*.mjs' {
  import type { LucideIconData } from 'lucide-react';

  export const __iconData: LucideIconData;
}
