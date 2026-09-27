// 会话只读列表（spec「后台 API 与页面 · 会话只读列表」）：只列 id、渠道、阶段、状态、消息条数、更新时间，
// 不带消息正文；详情仍在 admin.html 里看。成员都能看，匿名看不到入口。整页随后台 UX spec 第 13 步重做。
// 状态一列只经 src/shared/conversation.ts 的 conversationState 判定（不变量 17，设计系统 §5.6）：转人工以后成交的，
// 引擎不清 handedOver，也写已成交。console 里不直接读 handedOver（scripts/check-console-src.ts 查）。
// 阶段名取自当前租户行业包的 stages（/pack，不变量 11，设计系统「界面代码里不写阶段名」）；包里没有的阶段照写原值
import { useQuery } from '@tanstack/react-query';
import { Table } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { ConversationRow } from '../../../src/shared/console-api.js';
import { conversationState } from '../../../src/shared/conversation.js';
import { api, unwrap } from '../api.js';
import { Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { PageHeader } from '../shell/PageHeader.js';
import { usePack } from '../viewer.js';

const PAGE_SIZE = 20;
const CHANNEL_LABEL: Record<string, string> = { wecom: '企业微信', simulator: '网页' };

export function ConversationsPage() {
  const [page, setPage] = useState(1);
  const stages = usePack()?.stages;
  // 转人工不算阶段，它对应状态「等人接手」，阶段写「—」（设计系统 I 页）；页面上不出现「已转人工」（验收 6）
  const stageLabel = (s: string): string => (s === 'handoff' ? '—' : (stages?.find((x) => x.key === s)?.label ?? s));
  const q = useQuery({
    queryKey: ['conversations', page],
    queryFn: () => unwrap(api.conversations.$get({ query: { limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) } })),
    // 翻页时先留着上一页，不换成骨架
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <PageHeader title="会话" />
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
