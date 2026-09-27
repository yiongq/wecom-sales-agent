// 保存条与发布条（spec「通用部件 · ActionBar」，design-system §5.16）：吸在内容面板底部，不透明，上边一条细线，无阴影，
// 不做成居中的悬浮胶囊。左边是状态图标、摘要和补充（可以跟一个文字按钮）；右边从左到右是说明、次要按钮、主按钮。
// 保存条只在有改动时渲染（由调用方决定），发布条在话术页常驻；成功结果写在条里，不弹 toast
import type { ReactNode } from 'react';
import { cjk } from '../typography.js';

export interface ActionBarProps {
  icon?: ReactNode;
  /** 14/500 摘要，如「有2处改动」 */
  summary: ReactNode;
  /** 13 text-2 补充，可以带一个文字按钮 */
  hint?: ReactNode;
  /** 右侧按钮前的说明，如「销售助手下一条回复就用新内容」 */
  note?: ReactNode;
  /** 右侧的按钮：次要按钮在前，主按钮（至多一个）在最右 */
  children?: ReactNode;
  /** 给读屏的名称，如「保存」「发布」 */
  label: string;
}

const text = (v: ReactNode): ReactNode => (typeof v === 'string' ? cjk(v) : v);

export function ActionBar({ icon, summary, hint, note, children, label }: ActionBarProps) {
  return (
    <div className="action-bar" role="region" aria-label={label}>
      <div className="action-bar-main">
        {icon && (
          <span className="action-bar-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="action-bar-summary">{text(summary)}</span>
        {hint && <span className="action-bar-hint">{text(hint)}</span>}
      </div>
      <div className="action-bar-side">
        {note && <span className="action-bar-note">{text(note)}</span>}
        {children}
      </div>
    </div>
  );
}
