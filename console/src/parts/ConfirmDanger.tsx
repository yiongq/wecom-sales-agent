// 危险确认（spec「通用部件」、不变量 3，design-system §5.1、§5.14）：全站唯一能出现危险按钮的组件，用于丢弃草稿、
// 放弃没保存的改动这类撤销不了的事。弹窗里不放主按钮；取消按钮默认聚焦，Esc 与右上角关闭都等于取消。
// 上架和回滚不算危险操作，那两处的确认按钮用墨色主按钮。
// console/src 里 danger 属性、color="danger" 只准出现在这个文件里（scripts/check-console-src.ts 查）
import { Button, Modal } from 'antd';
import { type ReactNode, useRef, useState } from 'react';
import { cjk } from '../typography.js';

export interface ConfirmDangerProps {
  open: boolean;
  /** 写出对象，如「丢弃草稿？」 */
  title: string;
  /** 后果：先写会发生什么、能不能撤销 */
  children?: ReactNode;
  /** 危险按钮写具体动作，如「丢弃草稿」 */
  confirmText: string;
  /** 安全的那个按钮，如「保留」「留下」，默认聚焦 */
  cancelText: string;
  /** 返回 Promise 时，按钮在它结束前显示提交中 */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDanger({ open, title, children, confirmText, cancelText, onConfirm, onCancel }: ConfirmDangerProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      width={480}
      title={cjk(title)}
      maskClosable={false}
      onCancel={onCancel}
      // 弹窗打开时先把焦点放进内容区，这里再挪到取消按钮上：autoFocus 在弹窗还是 display:none 时就跑了，不生效
      afterOpenChange={(visible) => {
        if (visible) cancelRef.current?.focus();
      }}
      footer={
        <>
          <Button ref={cancelRef} onClick={onCancel}>
            {cancelText}
          </Button>
          <Button color="danger" variant="solid" className="danger-solid" loading={busy} onClick={() => void confirm()}>
            {confirmText}
          </Button>
        </>
      }
    >
      {typeof children === 'string' ? <p className="confirm-body">{cjk(children)}</p> : children}
    </Modal>
  );
}
