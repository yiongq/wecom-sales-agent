// 弹层的地标（spec「可访问性与响应式」，plan 第 16 步）：下拉菜单、下拉选择、铃铛的弹层由 antd 挂在 body 下，在侧栏的 banner、
// 内容面板的 main 这些地标外面。读屏按地标找不到它们，axe 报 region。包一层有名字的区域（section 带 aria-label 就是 region 地标），
// 名字写这个弹层是什么（「更多操作」「筛选：目的地」「选择节」）。弹窗、抽屉是 dialog，本来就不用包
import type { ReactElement, ReactNode } from 'react';

/** 给 antd 的 popupRender 用：popupRender={popupRegion('更多操作')} */
export function popupRegion(label: string): (menu: ReactNode) => ReactElement {
  return function PopupRegion(menu: ReactNode): ReactElement {
    return <section aria-label={label}>{menu}</section>;
  };
}
