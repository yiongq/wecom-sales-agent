// 加载、空、出错（spec「通用部件 · StateView」，design-system §4.5）。
// - 加载：和成品同尺寸的骨架，静态不闪，300ms 后才看得见（之前先占着位置，页面不跳）；不用整页转圈。
// - 空：替换整块内容，不留空表头；标题不超过 5 个词、一句说明、最多一个主按钮。筛选没结果时只给「清除筛选」链接。
// - 出错：就地放 Alert，写「没取到」，文案取 ERROR_COPY，重试是次要按钮；中性的（系统正在启动、没有这项内容、
//   登录已过期）不用红色，整块写成说明加按钮
import { Button } from 'antd';
import type { ReactNode } from 'react';
import { cjk } from '../typography.js';
import { ErrorAlert, type ErrorHandlers, errorLine } from './ErrorAlert.js';
import { type CopyContext, PageCrash, routeError } from './errors.js';

export interface EmptyState {
  icon?: ReactNode;
  /** 不超过 5 个词 */
  title: string;
  description?: string;
  /** 最多一个主按钮 */
  action?: ReactNode;
  /** 一个链接，如「清除筛选」 */
  link?: ReactNode;
}

export interface StateViewProps extends ErrorHandlers {
  pending?: boolean;
  /** null / undefined 表示没出错 */
  error?: unknown;
  ctx?: CopyContext;
  /** 与成品同尺寸的骨架；不给就是 3 行 */
  skeleton?: ReactNode;
  /** 有值就显示空状态（调用方判断数据是不是空的） */
  empty?: EmptyState | null | false;
  children?: ReactNode;
}

export function EmptyBlock({ icon, title, description, action, link }: EmptyState) {
  return (
    <div className="state-empty">
      {icon && (
        <div className="state-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="state-empty-title">{cjk(title)}</h3>
      {description && <p className="state-empty-desc">{cjk(description)}</p>}
      {(action || link) && (
        <div className="state-empty-actions">
          {action}
          {link}
        </div>
      )}
    </div>
  );
}

/** 骨架：rows 行、每行 rowHeight 高的静态灰条 */
export function Skeleton({ rows = 3, rowHeight = 44 }: { rows?: number; rowHeight?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" style={{ height: rowHeight }}>
          <div className="skeleton-bar" style={{ width: `${[72, 56, 64, 48][i % 4]}%` }} />
        </div>
      ))}
    </div>
  );
}

/**
 * 整页的骨架：页头一行（与页名同高 32、下距 20）加表格 8 行（设计系统 §4.5）。路由下载页面块时用（router.tsx），
 * 块到了以后由页面自己的 StateView 接着放它那一页的骨架
 */
export function PageSkeleton() {
  return (
    <>
      <div className="skeleton-page-title">
        <div className="skeleton-bar" style={{ width: 160 }} />
      </div>
      <Skeleton rows={8} />
    </>
  );
}

function ErrorState({ error, ctx, ...handlers }: { error: unknown; ctx?: CopyContext } & ErrorHandlers) {
  const { copy, label, onAction } = errorLine(error, handlers, ctx);
  if (copy.tone !== 'neutral') return <ErrorAlert error={error} title="没取到" ctx={ctx} {...handlers} />;
  return (
    <EmptyBlock
      title={copy.title}
      description={copy.next && copy.next !== label ? copy.next : undefined}
      action={label && onAction ? <Button onClick={onAction}>{label}</Button> : undefined}
    />
  );
}

/**
 * 路由接住的错误（router.tsx 的 defaultErrorComponent）。页面块没取到和取数据失败一样写「没取到 · 服务暂时连不上」；
 * 页面渲染时抛错是代码的毛病，不写「没取到」，也不说连不上，文案走兜底「无法完成这项操作」，原来的类型与消息在技术详情里
 */
export function RouteError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const e = routeError(error);
  return e instanceof PageCrash ? <ErrorAlert error={e} onRetry={onRetry} /> : <StateView error={e} onRetry={onRetry} />;
}

export function StateView({ pending, error, ctx, skeleton, empty, children, ...handlers }: StateViewProps) {
  if (error !== undefined && error !== null) return <ErrorState error={error} ctx={ctx} {...handlers} />;
  if (pending) {
    return (
      <div className="state-skeleton" role="status" aria-label="正在载入">
        {skeleton ?? <Skeleton />}
      </div>
    );
  }
  if (empty) return <EmptyBlock {...empty} />;
  return <>{children}</>;
}
