// 会话只读列表（spec「后台 API 与页面 · 会话只读列表」）：只列 id、渠道、阶段、状态、消息条数、更新时间，
// 不带消息正文；详情仍在 admin.html 里看。成员都能看，匿名看不到入口。整页随后台 UX spec 第 13 步重做。
// 状态一列只经 src/shared/conversation.ts 的 conversationState 判定（不变量 17，设计系统 §5.6）：转人工以后成交的，
// 引擎不清 handedOver，也写已成交。console 里不直接读 handedOver（scripts/check-console-src.ts 查）。
// 阶段名取自当前租户行业包的 stages（/pack，不变量 11，设计系统「界面代码里不写阶段名」）；包里没有的阶段照写原值。
// 地址里的 state、stage 是筛选（总览的业务数与阶段条带过来的，spec 路由表），服务端先过滤再分页；页头写明只看哪些，
// 「看全部」清掉筛选。页签与阶段条随第 13 步
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Table } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { ConversationRow } from '../../../src/shared/console-api.js';
import { conversationState } from '../../../src/shared/conversation.js';
import { api, unwrap } from '../api.js';
import { Skeleton, StateView } from '../parts/StateView.js';
import { STATUS_LABEL, Status } from '../parts/Status.js';
import { PageHeader } from '../shell/PageHeader.js';
import { usePack } from '../viewer.js';

const PAGE_SIZE = 20;
const CHANNEL_LABEL: Record<string, string> = { wecom: '企业微信', simulator: '网页' };

export function ConversationsPage() {
  const { state, stage } = useSearch({ from: '/conversations' });
  // 换了筛选就回到第一页
  const filter = `${state ?? ''}|${stage ?? ''}`;
  const [paging, setPaging] = useState({ filter, page: 1 });
  const page = paging.filter === filter ? paging.page : 1;
  const setPage = (p: number): void => setPaging({ filter, page: p });
  const stages = usePack()?.stages;
  // 转人工不算阶段，它对应状态「等人接手」，阶段写「—」（设计系统 I 页）；页面上不出现「已转人工」（验收 6）
  const stageLabel = (s: string): string => (s === 'handoff' ? '—' : (stages?.find((x) => x.key === s)?.label ?? s));
  const q = useQuery({
    queryKey: ['conversations', 'list', state ?? null, stage ?? null, page],
    queryFn: () =>
      unwrap(
        api.conversations.$get({
          query: {
            limit: String(PAGE_SIZE),
            offset: String((page - 1) * PAGE_SIZE),
            ...(state ? { state } : {}),
            ...(stage ? { stage } : {}),
          },
        }),
      ),
    // 翻页时先留着上一页，不换成骨架
    placeholderData: (prev) => prev,
  });
  const only = [stage && `${stageLabel(stage)}阶段`, state && STATUS_LABEL[state]].filter(Boolean).join('、');
  return (
    <>
      <PageHeader
        title="会话"
        status={
          only ? (
            <>
              {`只看${only}的会话`}
              <Link to="/conversations">看全部</Link>
            </>
          ) : undefined
        }
      />
      <StateView pending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={8} />}>
        <Table<ConversationRow>
          rowKey="id"
          size="small"
          dataSource={q.data?.items ?? []}
          pagination={{ current: page, pageSize: PAGE_SIZE, total: q.data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
          columns={[
            { title: '会话', dataIndex: 'id' },
            { title: '渠道', dataIndex: 'channel', render: (ch: string) => CHANNEL_LABEL[ch] ?? ch },
            { title: '阶段', dataIndex: 'stage', render: stageLabel },
            { title: '状态', render: (_: unknown, r) => <Status kind={conversationState(r)} /> },
            { title: '消息数', dataIndex: 'messageCount' },
            { title: '更新时间', dataIndex: 'updatedAt', render: (t: string) => dayjs(t).format('YYYY-MM-DD HH:mm') },
          ]}
        />
      </StateView>
    </>
  );
}
