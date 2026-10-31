// 报价单专属动作；权限来自服务端，窗口关闭只提示，不阻止审批。
import { Button, Input, Modal } from 'antd';
import { useRef, useState } from 'react';
import type { ConversationDetail, LineOrderView } from '../../../src/shared/console-api.js';
import type { SendWindow } from '../../../src/shared/conversation-types.js';
import { HttpError } from '../api.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { cjk } from '../typography.js';
import { sendWindowView } from './workbench.js';

export type QuoteAction = 'approve' | 'reject' | 'withdraw';
export interface QuoteActionProps {
  can: ConversationDetail['can'];
  window: SendWindow | null;
  now: number;
  pending: boolean;
  error: unknown;
  onAction(action: QuoteAction, reason?: string): void;
  onRetry(): void;
}
export const QUOTE_STATE_LABEL = {
  pending: '报价单等你审核',
  approved: '报价单已批准',
  expired: '报价单已过期',
  invalid: '报价单已失效',
  superseded: '报价单已被取代',
  paid: '报价单已付',
} as const;

export function QuoteActions({
  order,
  can,
  window: w,
  now,
  pending,
  error,
  onAction,
  onRetry,
}: QuoteActionProps & { order: LineOrderView }) {
  const [action, setAction] = useState<QuoteAction | null>(null);
  const [reason, setReason] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const state = order.quoteState;
  const view = sendWindowView(w, now);
  const closed = !!w && (w.closesAt === null || now >= w.closesAt);
  const warning = closed ? '客户48小时内没发过消息，报价单发不出去' : view?.reason;
  const forbidden = error instanceof HttpError && error.status === 403;
  const conflict = error instanceof HttpError && error.status === 409;
  const disabled = pending || forbidden;
  const label = action === 'approve' ? '批准报价单' : action === 'reject' ? '驳回报价单' : '撤回报价单';
  const sendNote = warning ?? (view?.text ? cjk(view.text) : null);
  return (
    <>
      <p className="wb-order-status wb-quote-state" data-state={state ?? undefined}>
        {state ? QUOTE_STATE_LABEL[state] : '报价单'}
      </p>
      {order.approval?.reason && <p>{`原因：${order.approval.reason}`}</p>}
      {order.approval?.decidedBy && <p>{`审批人：${order.approval.decidedBy.name}`}</p>}
      {(state === 'pending' || state === 'approved' || state === 'expired') && (
        <>
          {sendNote && <p className="wb-order-status">{sendNote}</p>}
          <div className="wb-order-actions">
            {state === 'pending' && can.approveQuote && (
              <PrimaryButton size="small" disabled={disabled} onClick={() => setAction('approve')}>
                批准报价单
              </PrimaryButton>
            )}
            {state === 'pending' && can.rejectQuote && (
              <Button size="small" disabled={disabled} onClick={() => setAction('reject')}>
                驳回报价单
              </Button>
            )}
            {can.withdrawQuote && (
              <Button size="small" type="text" disabled={disabled} onClick={() => setAction('withdraw')}>
                撤回报价单
              </Button>
            )}
          </div>
        </>
      )}
      {conflict && <p role="status">报价单状态已更新，请查看最新状态。</p>}
      {error != null && !conflict && <ErrorAlert error={error} onRetry={forbidden ? undefined : onRetry} />}
      <Modal
        open={action !== null}
        title={label}
        onCancel={() => setAction(null)}
        afterOpenChange={(open) => {
          if (open) cancelRef.current?.focus();
        }}
        footer={
          <>
            <Button ref={cancelRef} onClick={() => setAction(null)}>
              返回
            </Button>
            <PrimaryButton
              disabled={disabled || (action === 'reject' && !reason.trim())}
              onClick={() => {
                if (!action) return;
                onAction(action, action === 'approve' ? undefined : reason.trim());
                setAction(null);
                setReason('');
              }}
            >
              {label}
            </PrimaryButton>
          </>
        }
      >
        {warning && <p>{warning}</p>}
        <p>
          {action === 'approve'
            ? '批准后向客户发送报价单。'
            : action === 'reject'
              ? '驳回后由顾问继续处理，原因只给顾问看。'
              : '撤回后报价单失效，已批准的报价单会通知客户。'}
        </p>
        {action !== 'approve' && (
          <>
            <label htmlFor={`quote-reason-${order.id}`}>{action === 'reject' ? '驳回原因（必填）' : '撤回原因（选填）'}</label>
            <Input.TextArea
              id={`quote-reason-${order.id}`}
              maxLength={120}
              showCount
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </>
        )}
      </Modal>
    </>
  );
}
