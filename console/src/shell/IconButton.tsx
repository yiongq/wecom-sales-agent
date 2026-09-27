// 图标按钮（设计系统 §5.1）：28 或 32 见方，幽灵样式，16 图标 text-2；必须有 aria-label 和 Tooltip
import { Tooltip, type TooltipProps } from 'antd';
import type { LucideIcon } from 'lucide-react';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { Icon } from './icons.js';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  icon: LucideIcon;
  /** 默认 28 */
  size?: 28 | 32;
  /** Tooltip 的字，默认同 label */
  tip?: ReactNode;
  placement?: TooltipProps['placement'];
  /** 按钮打开的弹层开着时传 false，Tooltip 不压在弹层上 */
  tipOpen?: false;
  /** 叠在图标上的东西，如实心徽标 */
  children?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 28, tip, placement, tipOpen, className, children, ...rest },
  ref,
) {
  return (
    <Tooltip title={tip ?? label} placement={placement} open={tipOpen}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={[`icon-btn icon-btn-${size}`, className].filter(Boolean).join(' ')}
        {...rest}
      >
        <Icon of={icon} />
        {children}
      </button>
    </Tooltip>
  );
});
