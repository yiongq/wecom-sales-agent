// 转人工的外部提醒（docs/architecture/02-conversations-workbench/spec.md「通知」、R13、开放问题 3、不变量 32）：Notifier 接口与
// 企微群机器人的实现。console 没开时顾问靠它知道有人要人工；与告警（src/ops/alert.ts，ALERT_WEBHOOK_URL）不是同一个群。
// 消息体只有类型的中文、短码、时间与工作台链接（不带会话 id）：不含客户原话、external_userid、会话原 id。
// NOTIFY_WEBHOOK_URL 等同密钥，只在服务器的 env 文件里；日志里一律不打它（错误只记错误码与错误名，不取 message：undici 的消息带地址）。
// 发送 5 秒超时；失败抛 NotifySendError，由调用方重试（handoff_notify 任务按 max_attempts，unsaved 通知在内存里退避）。
// 没配地址时只写一行 warn、不算失败。
// 第 17 步的告警（src/ops/alert.ts）合并之后，两处的「POST 一条 text 消息、5 秒超时、看 errcode」可以合成一个函数（plan 第 14 步记了一笔）。
import { absoluteTime } from '../shared/format.js';
import { HANDOFF_NOTICE_TEXT, handoffNoticeTitle, type HandoffNoticeKind } from '../shared/conversation.js';

export interface HandoffNotice {
  /** shortIdOf(会话 id) */
  shortId: string;
  kind: HandoffNoticeKind;
  /** 已成交客户要人工（R9） */
  paidCustomer: boolean;
  /** 这条提醒说的那个时刻：转人工的时刻；窗口快关了是窗口关闭的时刻；待确认的订单是下单时刻 */
  at: number;
  /** 工作台链接：PUBLIC_BASE_URL + /console/conversations?state=human，不带会话 id */
  link: string;
  /** 这次转人工的记录还没写进库（库写不进去时的转人工）；提交之后不再补发 */
  unsaved: boolean;
  /**
   * 窗口快关了，这个企微窗口的发送额度（剩余条数）已用完：顾问没法再靠这个通道主动发消息（审查之后改的第 1 条，
   * plan「实施记录 · 第 14 步」）。只在 kind 为 window_closing 时有意义
   */
  quotaExhausted?: boolean;
  /**
   * 会话标签的前半截，如「企微客户」（channelCustomerLabel：渠道短名加行业包里客户的叫法）。spec 的接口里没有这一项，
   * 标题「企微客户 · 7F3A 等人接手」要它（plan「实施记录 · 第 14 步」）
   */
  label: string;
}

export interface Notifier {
  send(n: HandoffNotice): Promise<void>;
}

/** 「记录暂未保存」：unsaved 的提醒在正文里标出来（验收 15） */
export const UNSAVED_MARK = '记录暂未保存';

/** 工作台链接：等人接手的列表，不带会话 id（spec「通知」） */
export function workbenchLink(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return `${base}/console/conversations?state=human`;
}

const TIME_LABEL: Partial<Record<HandoffNoticeKind, string>> = { window_closing: '窗口关闭', order_unconfirmed: '下单' };

/** 窗口的发送额度用完时追加的一句：只有这几个字，不碰会话内容（审查之后改的第 1 条） */
export const QUOTA_EXHAUSTED_MARK = '这个窗口的发送额度已用完，没法再主动发消息';

/**
 * 消息正文（text 消息）：标题、类型的中文、时间、（window_closing 且额度用完时）额度用完那一句、（unsaved 时）「记录暂未保存」、
 * 链接。只用这几样，不碰会话内容
 */
export function noticeText(n: HandoffNotice, now = Date.now()): string {
  const lines = [handoffNoticeTitle(n), HANDOFF_NOTICE_TEXT[n.kind], `${TIME_LABEL[n.kind] ?? '转人工'}时间：${absoluteTime(n.at, now)}`];
  if (n.kind === 'window_closing' && n.quotaExhausted) lines.push(QUOTA_EXHAUSTED_MARK);
  if (n.unsaved) lines.push(`${UNSAVED_MARK}：库暂时写不进去，工作台可能打不开，恢复之后不会再提醒这一条`);
  lines.push(`打开工作台：${n.link}`);
  return lines.join('\n');
}

/** 发送失败：code 是 http_<状态码>、errcode_<企微错误码>、timeout，或网络错误码（ECONNREFUSED 等），不含地址 */
export class NotifySendError extends Error {
  constructor(readonly code: string) {
    super(`转人工提醒没发出去（${code}）`);
    this.name = 'NotifySendError';
  }
}

const timing = { timeoutMs: 5_000 };

/** 网络错误只取错误码与错误名（不取 message：undici 的 message 与 cause 里带着地址与端口） */
function netCode(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
  const cause = (e as { cause?: unknown }).cause as { code?: unknown } | undefined;
  const code = (e as { code?: unknown }).code ?? cause?.code;
  return typeof code === 'string' && /^[\w.-]{1,40}$/.test(code) ? code : e.name;
}

/** 企微群机器人：POST { msgtype: 'text', text: { content } }，HTTP 2xx 且 errcode 为 0 才算发出 */
export function webhookNotifier(url: string): Notifier {
  return {
    async send(n) {
      let res: Response;
      let raw: string;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: noticeText(n) } }),
          signal: AbortSignal.timeout(timing.timeoutMs),
        });
        raw = await res.text();
      } catch (e) {
        throw new NotifySendError(netCode(e));
      }
      if (!res.ok) throw new NotifySendError(`http_${res.status}`);
      let errcode = 0;
      try {
        const body = JSON.parse(raw) as { errcode?: unknown } | null;
        if (typeof body?.errcode === 'number') errcode = body.errcode;
      } catch {
        // 不是 JSON：按 HTTP 状态算
      }
      if (errcode !== 0) throw new NotifySendError(`errcode_${errcode}`);
    },
  };
}

let override: Notifier | null = null;

/**
 * 当前的通知通道：NOTIFY_WEBHOOK_URL（每次现读，改 env 文件重启生效）配了是企微群机器人；没配时只写一行 warn（只有标题，
 * 不打地址），不算失败
 */
export function notifier(): Notifier {
  if (override) return override;
  const url = (process.env.NOTIFY_WEBHOOK_URL ?? '').trim();
  if (url) return webhookNotifier(url);
  return {
    send(n) {
      console.warn(
        `[notify] 没配 NOTIFY_WEBHOOK_URL，这条转人工提醒没有外发：${handoffNoticeTitle(n)}${n.unsaved ? `（${UNSAVED_MARK}）` : ''}`,
      );
      return Promise.resolve();
    },
  };
}

/** 仅供自测 */
export const __notifierTest = {
  /** 换掉通知通道（null 还原成按 NOTIFY_WEBHOOK_URL） */
  use(n: Notifier | null): void {
    override = n;
  },
  setTimeoutMs(ms: number): void {
    timing.timeoutMs = ms;
  },
};
