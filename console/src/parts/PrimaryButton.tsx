// 墨色主按钮（spec 不变量 2，design-system §5.1）：全站的主按钮只经它渲染，console/src 里没有 type="primary"，
// 实心按钮也只在这里和 ConfirmDanger 里（scripts/check-console-src.ts 查）。每个操作区至多一个，放在最右。
// 要禁用时优先用 blocked：aria-disabled，外观同禁用，保留焦点，点击照常回调，由调用方跳到第一个原因；
// 真正的 disabled 只留给提交中这类一闪而过的状态
import { Button, type ButtonProps } from 'antd';

export type PrimaryButtonProps = Omit<ButtonProps, 'type' | 'color' | 'variant' | 'danger' | 'ghost'> & {
  /** 不能执行：aria-disabled，外观同禁用，点击仍回调 onClick（跳到原因） */
  blocked?: boolean;
};

export function PrimaryButton({ blocked, className, ...rest }: PrimaryButtonProps) {
  return (
    <Button
      {...rest}
      color="default"
      variant="solid"
      aria-disabled={blocked || undefined}
      className={[className, blocked ? 'primary-blocked' : ''].filter(Boolean).join(' ') || undefined}
    />
  );
}
