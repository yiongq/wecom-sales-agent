// 审计日志（spec「后台 API 与页面 · 审计日志」）：按 id 倒序分页（before 游标），可按 action 过滤。只有 owner / admin 看得到入口
import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, AutoComplete, Button, Space, Table, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { AuditEntryView } from '../../../src/shared/console-api.js';
import { api, describe, unwrap } from '../api.js';

const ACTIONS = [
  'sop.publish',
  'sop.rollback',
  'sop.discard',
  'sop.rerender',
  'catalog.create',
  'catalog.update',
  'catalog.activate',
  'catalog.locked_fix',
  'auth.login',
  'auth.logout',
  'config.import',
  'platform.tenant_create',
  'platform.user_create',
  'platform.user_password',
  'platform.user_disable',
  'platform.member_role',
  'platform.member_remove',
];
const ACTOR_LABEL: Record<AuditEntryView['actorKind'], string> = { user: '成员', system: '系统', platform: '平台' };

export function AuditPage() {
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState<string | undefined>(undefined);
  const q = useInfiniteQuery({
    queryKey: ['audit', applied],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.audit.$get({
          query: { limit: '50', ...(pageParam ? { before: String(pageParam) } : {}), ...(applied ? { action: applied } : {}) },
        }),
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Space>
        <AutoComplete
          style={{ width: 260 }}
          placeholder="按 action 过滤，如 sop.publish"
          options={ACTIONS.map((a) => ({ value: a }))}
          value={action}
          onChange={setAction}
          allowClear
          onClear={() => setApplied(undefined)}
        />
        <Button onClick={() => setApplied(action.trim() || undefined)}>过滤</Button>
      </Space>
      {q.isError && <Alert type="error" title={describe(q.error)} />}
      <Table<AuditEntryView>
        rowKey="id"
        size="small"
        loading={q.isPending}
        dataSource={rows}
        pagination={false}
        expandable={{
          rowExpandable: (r) => r.diff !== null && r.diff !== undefined,
          expandedRowRender: (r) => <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.diff, null, 2)}</pre>,
        }}
        columns={[
          { title: '时间', dataIndex: 'at', render: (at: string) => dayjs(at).format('YYYY-MM-DD HH:mm:ss') },
          { title: '操作者', render: (_: unknown, r) => r.actorName ?? ACTOR_LABEL[r.actorKind] },
          { title: '动作', dataIndex: 'action', render: (a: string) => <Typography.Text code>{a}</Typography.Text> },
          { title: '对象', render: (_: unknown, r) => [r.targetType, r.targetId].filter(Boolean).join(' ') },
        ]}
      />
      {q.hasNextPage && (
        <Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          更早的
        </Button>
      )}
    </Space>
  );
}
