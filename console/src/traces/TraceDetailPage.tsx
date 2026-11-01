// 单轮记录（17 spec R9）：告警里的安全链接落到这里。地址只有随机 id，打开后照常鉴权：只给所有者、管理员，
// 跨租户、已清理都是 404，不说这条记录是否存在过。数据来自 GET /traces/:turnId，不依赖会话还在内存里。
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowUpRight, ScrollText } from 'lucide-react';
import { fullTime } from '../../../src/shared/format.js';
import { HttpError } from '../api.js';
import { TraceBody } from '../conversations/TraceDetail.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { Icon } from '../shell/icons.js';
import { conversationLabel } from '../shell/model.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk } from '../typography.js';
import { canEdit, usePack, useViewer } from '../viewer.js';
import { ReviewBlock, traceDetailQuery } from './ReviewBlock.js';

function Detail({ turnId }: { turnId: string }) {
  const pack = usePack();
  const q = useQuery(traceDetailQuery(turnId));
  if (q.error instanceof HttpError && q.error.status === 404) {
    return (
      <>
        <PageHeader title="AI记录" />
        <EmptyBlock
          level={2}
          icon={<Icon of={ScrollText} size={20} />}
          title="找不到这条记录"
          description="可能已过保留期，或者不属于当前公司"
          link={<Link to="/traces">回到AI记录</Link>}
        />
      </>
    );
  }
  const t = q.data;
  return (
    <>
      <PageHeader
        title="AI为什么这么回"
        status={
          t && pack ? (
            <span>
              <Link to="/conversations/$id" params={{ id: t.conversationId }} className="tr-conv">
                {cjk(conversationLabel({ id: t.conversationId, channel: t.channel }, pack))}
                <Icon of={ArrowUpRight} size={14} />
              </Link>
              {cjk(['', fullTime(t.startedAt)])}
            </span>
          ) : undefined
        }
      />
      <StateView pending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={6} />}>
        {t && (
          <div className="tr-detail-page">
            <TraceBody t={t} id={t.conversationId} turnId={t.turnId} review={<ReviewBlock turnId={t.turnId} />} />
          </div>
        )}
      </StateView>
    </>
  );
}

export function TraceDetailPage() {
  const { turnId } = useParams({ from: '/traces/$turnId' });
  const viewer = useViewer().data;
  if (canEdit(viewer)) return <Detail turnId={turnId} />;
  return (
    <>
      <PageHeader title="AI记录" />
      <EmptyBlock
        level={2}
        icon={<Icon of={ScrollText} size={20} />}
        title={viewer?.kind === 'member' ? '你的角色看不到AI记录' : '登录后才能看AI记录'}
        description="AI记录只给所有者、管理员看"
      />
    </>
  );
}
