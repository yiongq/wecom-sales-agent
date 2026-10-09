// 就地显示一个错误（spec「通用部件」、原则 6：红色只给出错，错误就地显示并带着能做的操作）。
// 文案取 ERROR_COPY，一行写「标题 · 下一步」；下一步有对应的回调时画成右侧的次要按钮（28 高），
// 按钮已经说了下一步就不再重复。服务端的 detail 与原码只在折叠的「技术详情」里
import { Alert, Button } from 'antd';
import type { ReactNode } from 'react';
import { cjk } from '../typography.js';
import { ACTION_LABEL, type CopyContext, type ErrorAction, errorCopy, type ErrorTone } from './errors.js';
import { TechDetails } from './TechDetails.js';

const ALERT_TYPE: Readonly<Record<ErrorTone, 'info' | 'warning' | 'error'>> = { neutral: 'info', caution: 'warning', danger: 'error' };

export interface ErrorHandlers {
  /** 重试（也用于「重新登录」：重发请求就会弹出就地登录框） */
  onRetry?: () => void;
  /** 载入最新内容（409 rev_conflict） */
  onReload?: () => void;
  /** 去合并（409 sop_conflict） */
  onMerge?: () => void;
  /** 回到列表（404） */
  onBack?: () => void;
}

const reloadPage = (): void => window.location.reload();

function handlerFor(action: ErrorAction | null, h: ErrorHandlers): (() => void) | undefined {
  switch (action) {
    case 'retry':
    case 'relogin':
      return h.onRetry;
    case 'refresh':
      return reloadPage;
    case 'reload':
      return h.onReload;
    case 'merge':
      return h.onMerge;
    case 'back':
      return h.onBack;
    default:
      return undefined;
  }
}

/** 一行字（标题 · 下一步）与按钮：下一步就是按钮上的字时只写标题 */
export function errorLine(error: unknown, h: ErrorHandlers, ctx?: CopyContext) {
  const c = errorCopy(error, ctx);
  const onAction = handlerFor(c.action, h);
  const label = c.action && onAction ? ACTION_LABEL[c.action] : null;
  const parts = c.next && c.next !== label ? [c.title, c.next] : [c.title];
  return { copy: c, text: cjk(parts), label, onAction };
}

export interface ErrorAlertProps extends ErrorHandlers {
  error: unknown;
  /** 换掉标题：StateView 取不到数据时写「没取到」，文案挪到说明里 */
  title?: string;
  ctx?: CopyContext;
  /** 说明下面的补充，如逐条问题 */
  children?: ReactNode;
}

export function ErrorAlert({ error, title, ctx, children, ...handlers }: ErrorAlertProps) {
  const { copy, text, label, onAction } = errorLine(error, handlers, ctx);
  return (
    <Alert
      type={ALERT_TYPE[copy.tone]}
      showIcon
      title={title ? cjk(title) : text}
      description={
        <>
          {title && <div>{text}</div>}
          {children}
          <TechDetails error={error} />
        </>
      }
      action={
        label && onAction ? (
          <Button size="small" onClick={onAction}>
            {label}
          </Button>
        ) : undefined
      }
    />
  );
}
