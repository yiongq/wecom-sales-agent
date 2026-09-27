// 未保存保护（spec「通用部件 · 未保存保护」、不变量 20）：有没保存的内容时，站内跳转由 TanStack Router 的 useBlocker 拦下，
// 弹「有改动还没保存」，按钮「留下」（默认聚焦）与「放弃改动并离开」；关页和刷新走浏览器的 beforeunload 提示。
// 放弃改动撤销不了，所以确认框用 ConfirmDanger
import { useBlocker } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ConfirmDanger } from './ConfirmDanger.js';

/** 有改动就拦；模块级的常量，免得每次渲染都重新挂一遍拦截 */
const BLOCK = (): boolean => true;

/** 在有未保存内容的组件里调用，把返回的确认框放进渲染结果 */
export function useUnsavedGuard(dirty: boolean): ReactElement {
  const blocker = useBlocker({ shouldBlockFn: BLOCK, enableBeforeUnload: true, disabled: !dirty, withResolver: true });
  return (
    <ConfirmDanger
      open={blocker.status === 'blocked'}
      title="有改动还没保存"
      confirmText="放弃改动并离开"
      cancelText="留下"
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    >
      离开这一页，没保存的改动会丢掉。
    </ConfirmDanger>
  );
}
