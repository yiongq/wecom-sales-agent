// 铃铛（spec「外壳 · 铃铛」「通知」，设计系统 §4.2）：实心徽标是等人接手数，点开是一个弹层，列出这些会话，
// 每行写原因与等待时长，行尾「打开工作台」在当前标签打开 J 页；等人接手之后另起一组「已成交客户要人工」
// （只在有时出现，不计入徽标）；底部「查看全部会话」与「开启桌面提醒」。
// - 数字来自 counts 的 byState.human（和侧栏「会话」的软徽标同一次响应，不变量 17–19）；等人接手的列表来自 ?state=human，
//   已成交客户要人工来自 ?group=paid_needs_human：三个查询断线超过 30 秒退回轮询，重连成功立刻停（shell/live.ts）。
// - 没有等人接手的会话：弹层里只有一行「没有等人接手的会话」，底部链接照旧，徽标不画。
// - 轮询失败：徽标保留上一次的数；弹层顶部加一行 13 danger「没取到最新的」和文字按钮「重试」。不弹 toast
// - 「开启桌面提醒」：只在点它时申请通知授权；被拒绝之后那一行改成说明，不再申请（spec「通知」）
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, Popover, type PopoverProps } from 'antd';
import { Bell as BellIcon } from 'lucide-react';
import { useState } from 'react';
import { relativeTime } from '../../../src/shared/format.js';
import type { ConversationRow } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { conversationCountsQuery, paidNeedsHumanQuery, waitingConversationsQuery } from '../queries.js';
import { cjk } from '../typography.js';
import { useChangeFlash } from './hooks.js';
import { IconButton } from './IconButton.js';
import { useLivePollInterval } from './live.js';
import { badgeText, conversationLabel, POLL } from './model.js';
import { notificationPermission, type NotifyPermission, requestNotificationPermission } from './notifications.js';

/**
 * 等人接手数：侧栏软徽标、铃铛与外壳的标签页标题前缀共用这一个查询（同一次 counts 响应）。
 * enabled 默认开，外壳给匿名传 false：匿名没有铃铛与会话入口，不该发这个请求（原来只靠「调用方不挂载」做到，
 * 现在外壳本身也要读这个数算标题前缀，所以这里加一道)
 */
export function useWaitingCount(enabled = true) {
  const interval = useLivePollInterval(POLL.refetchInterval);
  const counts = useQuery({
    ...conversationCountsQuery,
    enabled,
    refetchInterval: enabled ? interval : false,
    refetchIntervalInBackground: false,
  });
  return { count: counts.data?.byState.human, counts };
}

/** 一行的原因与等待时长（设计系统「每行加原因与等待时长」，从 handoff.at 算） */
function rowSub(reason: string, at: string, now: number): string {
  return `${reason} · ${relativeTime(at, now)}`;
}

interface BellRow {
  id: string;
  label: readonly [string, string];
  sub: string;
}

function BellRowItem({ row, onOpen }: { row: BellRow; onOpen: (id: string) => void }) {
  return (
    <li className="bell-row">
      <div className="bell-row-main">
        <div className="bell-row-title">{cjk(row.label)}</div>
        <div className="bell-row-sub">{row.sub}</div>
      </div>
      <Button type="text" size="small" onClick={() => onOpen(row.id)} aria-label={`打开工作台，${row.label.join(' ')}`}>
        打开工作台
      </Button>
    </li>
  );
}

/** 「开启桌面提醒」：default 给按钮，granted 给确认的说明，denied 给「被拒绝」的说明，unsupported 不画 */
function NotifyRow({ permission, onAsk }: { permission: NotifyPermission; onAsk: () => void }) {
  if (permission === 'unsupported') return null;
  if (permission === 'granted') return <p className="bell-notify">桌面提醒已开启</p>;
  if (permission === 'denied') return <p className="bell-notify">桌面提醒不能用了，可以到系统设置里重新开启</p>;
  return (
    <button type="button" className="bell-notify bell-notify-btn" onClick={onAsk}>
      开启桌面提醒
    </button>
  );
}

export function Bell({ pack, placement }: { pack: IndustryPack; placement: PopoverProps['placement'] }) {
  const { count, counts } = useWaitingCount();
  const interval = useLivePollInterval(POLL.refetchInterval);
  const pollOpts = { refetchInterval: interval, refetchIntervalInBackground: false } as const;
  const waiting = useQuery({ ...waitingConversationsQuery, ...pollOpts });
  const paidNeedsHuman = useQuery({ ...paidNeedsHumanQuery, ...pollOpts });
  const flash = useChangeFlash(count);
  const text = badgeText(count);
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<NotifyPermission>(() => notificationPermission());
  const navigate = useNavigate();
  const stale = counts.isError || waiting.isError || paidNeedsHuman.isError;
  const retry = (): void => {
    void counts.refetch();
    void waiting.refetch();
    void paidNeedsHuman.refetch();
  };
  // 相对时间按这一页数据取回的时刻算，随每次轮询或事件流更新
  const now = waiting.dataUpdatedAt;
  const openWorkbench = (id: string): void => {
    setOpen(false);
    void navigate({ to: '/conversations/$id', params: { id } });
  };
  const askNotify = (): void => {
    void requestNotificationPermission().then(setPermission);
  };

  // row.handoff 按不变量 24 对等人接手、已成交客户要人工这两组一定有值；兜底按 updatedAt 走旧的「有新动静」写法，
  // 防的是夹具或旧数据没带 handoff 的情况
  const rowsOf = (items: readonly ConversationRow[]): BellRow[] =>
    items.map((row) => ({
      id: row.id,
      label: conversationLabel(row, pack),
      sub: row.handoff ? rowSub(row.handoff.reason, row.handoff.at, now) : `${relativeTime(row.updatedAt, now)}有新动静`,
    }));
  const rows = waiting.data ? rowsOf(waiting.data.items) : [];
  const paidRows = paidNeedsHuman.data ? rowsOf(paidNeedsHuman.data.items) : [];

  // 弹层挂在 body 下、在侧栏的地标外面：自己是一个有名字的区域（读屏的地标列表里有它，axe region）
  const content = (
    <section className="bell-pop" aria-label="等人接手的会话">
      {stale && (
        <div className="bell-stale" role="alert">
          <span>没取到最新的</span>
          <Button type="link" size="small" onClick={retry}>
            重试
          </Button>
        </div>
      )}
      {waiting.data === undefined ? (
        // 第一次还没取到：一行骨架，300ms 后才出现（设计系统 §3）；第一次就失败了：只有上面那行「没取到最新的」
        !waiting.isError && (
          <div className="bell-row state-skeleton" aria-hidden="true">
            <span className="skeleton-bar bell-skeleton" />
          </div>
        )
      ) : rows.length === 0 ? (
        <div className="bell-empty">没有等人接手的会话</div>
      ) : (
        <ul className="bell-list">
          {rows.map((row) => (
            <BellRowItem key={row.id} row={row} onOpen={openWorkbench} />
          ))}
        </ul>
      )}
      {paidRows.length > 0 && (
        <>
          <p className="bell-group-title">已成交客户要人工</p>
          <ul className="bell-list">
            {paidRows.map((row) => (
              <BellRowItem key={row.id} row={row} onOpen={openWorkbench} />
            ))}
          </ul>
        </>
      )}
      <div className="bell-foot">
        <Link to="/conversations" onClick={() => setOpen(false)}>
          查看全部会话
        </Link>
        <NotifyRow permission={permission} onAsk={askNotify} />
      </div>
    </section>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement={placement}
      arrow={false}
      content={content}
      rootClassName="bell-popover"
    >
      <IconButton
        icon={BellIcon}
        label={text ? `等人接手的会话，${text}个` : '等人接手的会话'}
        tip="等人接手的会话"
        placement="bottom"
        tipOpen={open ? false : undefined}
        className="bell"
      >
        {text && (
          <span key={flash} className={flash ? 'badge-solid count-flash' : 'badge-solid'} aria-hidden="true">
            {text}
          </span>
        )}
      </IconButton>
    </Popover>
  );
}
