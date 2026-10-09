// 浏览器桌面提醒（02 spec「通知」）：授权只在用户点铃铛弹层底部「开启桌面提醒」时申请，被拒绝之后不再申请；
// 标题、正文与 tag 的写法与外部通道（企微群机器人）共用同一份文案（src/shared/conversation.ts 的 handoffNoticeTitle、
// HANDOFF_NOTICE_TEXT），正文不含客户原话。点击聚焦窗口并打开 J 页。
// 事件payload（ConsoleEventMap['handoff']）里没有 channel，sim- 访客会话的事件本来就不发（src/console-api/events.ts），
// 现在能收到事件的只有企微渠道，标题的渠道短名固定写「企微」（偏离：spec 没有点名这里的渠道从哪儿来，第 19 步的取舍）。
import { channelCustomerLabel, handoffNoticeTitle, HANDOFF_NOTICE_TEXT } from '../../../src/shared/conversation.js';
import type { ConsoleEventMap } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { shortIdOf } from '../../../src/shared/conversation.js';

export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** 当前授权状态；没有 Notification API（不支持，或非 https）时算 unsupported：那一行只给说明，不提供按钮 */
export function notificationPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** 只在用户点「开启桌面提醒」时调用：申请一次授权，返回结果。被拒绝之后调用方不再调它（spec「通知」） */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * 已授权时弹一条浏览器通知：标题照 spec 三种写法（等人接手 / 紧急 / 已成交客户要人工），正文是转人工类型的中文，
 * 不含客户原话；tag 为 handoff:<id>，同一个会话的新通知替换旧的。点击交给调用方（聚焦窗口、打开 J 页），随后关掉通知。
 * 没有授权（或不支持）时什么都不做，返回 null
 */
export function notifyHandoff(data: ConsoleEventMap['handoff'], pack: IndustryPack, onClick: (id: string) => void): Notification | null {
  if (notificationPermission() !== 'granted') return null;
  const title = handoffNoticeTitle({
    label: channelCustomerLabel('wecom', pack.vocabulary.customer),
    shortId: shortIdOf(data.id),
    kind: data.kind,
    paidCustomer: data.paidCustomer,
  });
  const n = new Notification(title, { body: HANDOFF_NOTICE_TEXT[data.kind], tag: `handoff:${data.id}` });
  n.addEventListener('click', () => {
    if (typeof window !== 'undefined') window.focus();
    onClick(data.id);
    n.close();
  });
  return n;
}
