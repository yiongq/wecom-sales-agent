// 会话只读列表（spec「后台 API 与页面 · 会话只读列表」）：只列 id、渠道、阶段、是否转人工、消息条数、更新时间，
// 不带消息正文；详情仍在 admin.html 里看。成员都能看，匿名看不到入口
import { useQuery } from '@tanstack/react-query';
import { Alert, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { ConversationRow } from '../../../src/shared/console-api.js';
import { api, describe, unwrap } from '../api.js';

const PAGE_SIZE = 20;
const STAGE_LABEL: Record<string, string> = {
  greeting: '开场',
  discovery: '问需',
  recommend: '推荐',
  quote: '报价',
  objection: '异议',
  closing: '促成',
  paid: '已支付',
  handoff: '已转人工',
};
const CHANNEL_LABEL: Record<string, string> = { wecom: '企业微信', simulator: '网页' };

export function ConversationsPage() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['conversations', page],
    queryFn: () => unwrap(api.conversations.$get({ query: { limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) } })),
  });
  if (q.isError) return <Alert type="error" title={describe(q.error)} />;
  return (
    <Table<ConversationRow>
      rowKey="id"
      size="small"
      loading={q.isPending}
      dataSource={q.data?.items ?? []}
      pagination={{ current: page, pageSize: PAGE_SIZE, total: q.data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
      columns={[
        { title: '会话', dataIndex: 'id' },
        { title: '渠道', dataIndex: 'channel', render: (ch: string) => CHANNEL_LABEL[ch] ?? ch },
        { title: '阶段', dataIndex: 'stage', render: (s: string) => STAGE_LABEL[s] ?? s },
        { title: '转人工', dataIndex: 'handedOver', render: (h: boolean) => (h ? <Tag color="orange">已转人工</Tag> : null) },
        { title: '消息数', dataIndex: 'messageCount' },
        { title: '更新时间', dataIndex: 'updatedAt', render: (t: string) => dayjs(t).format('YYYY-MM-DD HH:mm') },
      ]}
    />
  );
}
