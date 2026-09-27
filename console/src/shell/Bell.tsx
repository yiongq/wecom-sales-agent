// 铃铛（spec「外壳 · 铃铛」「外壳 · 计数刷新」，设计系统 §4.2）：实心徽标是等人接手数，点开是一个弹层，列出这些会话，
// 每行「企微客户 · F01」「8分钟前有新动静」，行尾「打开工作台」在新标签打开 admin.html#s=<id>；底部「查看全部会话」。
// - 数字来自 counts 的 byState.human（和侧栏「会话」的软徽标同一次响应，不变量 17–19），列表来自 ?state=human；
//   两个都在页面可见时每 30 秒取一次，数字变了背景闪一次。
// - 没有等人接手的会话：弹层里只有一行「没有等人接手的会话」，底部链接照旧，徽标不画。
// - 轮询失败：徽标保留上一次的数；弹层顶部加一行 13 danger「没取到最新的」和文字按钮「重试」。不弹 toast
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, Popover, type PopoverProps } from 'antd';
import { ArrowUpRight, Bell as BellIcon } from 'lucide-react';
import { useState } from 'react';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { conversationCountsQuery, waitingConversationsQuery } from '../queries.js';
import { cjk } from '../typography.js';
import { useChangeFlash } from './hooks.js';
import { IconButton } from './IconButton.js';
import { Icon } from './icons.js';
import { badgeText, conversationLabel, POLL, sinceText, workbenchHref } from './model.js';

/** 等人接手数：侧栏软徽标与铃铛共用这一个查询（同一次 counts 响应） */
export function useWaitingCount() {
  const counts = useQuery({ ...conversationCountsQuery, ...POLL });
  return { count: counts.data?.byState.human, counts };
}

export function Bell({ pack, placement }: { pack: IndustryPack; placement: PopoverProps['placement'] }) {
  const { count, counts } = useWaitingCount();
  const waiting = useQuery({ ...waitingConversationsQuery, ...POLL });
  const flash = useChangeFlash(count);
  const text = badgeText(count);
  const [open, setOpen] = useState(false);
  const stale = counts.isError || waiting.isError;
  const retry = (): void => {
    void counts.refetch();
    void waiting.refetch();
  };
  // 相对时间按这一页数据取回的时刻算，随每 30 秒的轮询更新
  const now = waiting.dataUpdatedAt;
  const rows = waiting.data?.items ?? [];

  const content = (
    <div className="bell-pop">
      {stale && (
        <div className="bell-stale" role="alert">
          <span>没取到最新的</span>
          <Button type="link" size="small" onClick={retry}>
            重试
          </Button>
        </div>
      )}
      {waiting.data === undefined ? (
        // 第一次还没取到：一行骨架；第一次就失败了：只有上面那行「没取到最新的」
        !waiting.isError && (
          <div className="bell-row" aria-hidden="true">
            <span className="skeleton-bar bell-skeleton" />
          </div>
        )
      ) : rows.length === 0 ? (
        <div className="bell-empty">没有等人接手的会话</div>
      ) : (
        <ul className="bell-list">
          {rows.map((row) => (
            <li key={row.id} className="bell-row">
              <div className="bell-row-main">
                <div className="bell-row-title">{cjk(conversationLabel(row, pack))}</div>
                <div className="bell-row-sub">{`${sinceText(row.updatedAt, now)}有新动静`}</div>
              </div>
              <Button
                type="text"
                size="small"
                href={workbenchHref(row.id)}
                target="_blank"
                rel="noopener noreferrer"
                icon={<Icon of={ArrowUpRight} size={14} />}
                iconPlacement="end"
              >
                打开工作台
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="bell-foot">
        <Link to="/conversations" onClick={() => setOpen(false)}>
          查看全部会话
        </Link>
      </div>
    </div>
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
