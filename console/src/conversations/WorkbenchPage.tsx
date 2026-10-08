// 会话工作台（J 页）占位（02 spec「后台页面 · 会话工作台（J 页）」，路由 /conversations/$id，$id 经 encodeURIComponent）。
// 完整的三栏工作台（接手、回复、交接卡、订单与付款、快捷回复、「AI为什么这么回」）是第 20.2 步；本步先把路由接上，
// 读 GET /conversations/:id 画一个最小的概要：标题与状态、转人工摘要（有的话）、需求要素、消息数，提示完整工作台
// 还没上线。I 页与铃铛「打开工作台」都落在这里（02 第 19 步起在当前标签打开，取代 admin.html 的新标签）。
// 三态：加载是气泡骨架；出错就地重试；会话不存在（conversation_not_found）写「这个会话已经不在了」加返回列表
// （ERROR_COPY，src/shared/ui-labels.ts）。匿名与非成员没有入口，同 I 页
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { conversationState } from '../../../src/shared/conversation.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { conversationDetailQuery } from '../queries.js';
import { Icon } from '../shell/icons.js';
import { conversationLabel } from '../shell/model.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk } from '../typography.js';
import { usePack, useViewer } from '../viewer.js';

/** 面包屑「会话 / 企微客户·F01」，同产品库详情页的写法（CatalogDetail.tsx 的 Breadcrumb），这里就手写一份：
 * 分组名「会话」链回 I 页，当前会话的标签是纯文本 */
function WorkbenchCrumb({ label }: { label: readonly string[] }) {
  return (
    <nav className="breadcrumb" aria-label="当前位置">
      <Link to="/conversations">会话</Link>
      <span className="breadcrumb-sep" aria-hidden="true">
        /
      </span>
      <span className="breadcrumb-current" aria-current="page">
        {cjk(label)}
      </span>
    </nav>
  );
}

function Detail({ id, pack }: { id: string; pack: IndustryPack }) {
  const navigate = useNavigate();
  const q = useQuery(conversationDetailQuery(id));
  const back = () => void navigate({ to: '/conversations' });
  if (!q.data) {
    return (
      <>
        <PageHeader title="会话工作台" />
        <StateView pending={q.isPending} error={q.error} onRetry={() => void q.refetch()} onBack={back} skeleton={<Skeleton rows={6} />} />
      </>
    );
  }
  const { row, handoffCard, need, messages } = q.data;
  const label = conversationLabel(row, pack);
  const state = conversationState(row, pack);
  const needLine = [need.destination, need.segment, need.travelers].filter((v): v is string => !!v).join('、');
  return (
    <>
      <PageHeader
        title={label.join(' · ')}
        breadcrumb={<WorkbenchCrumb label={label} />}
        titleStatus={<Status kind={state} />}
        status={<span>{cjk(`共${messages.length}条消息`)}</span>}
      />
      <div className="wb-placeholder-note">
        完整的会话工作台（接手、回复、交接卡）还没上线，这里先看个概要；去「会话」列表能看到其余会话。
      </div>
      {handoffCard && (
        <div className="wb-card">
          <h2 className="wb-card-title">转人工</h2>
          <p>{`原因：${handoffCard.reason}`}</p>
          {handoffCard.assigneeName && <p>{`接手人：${handoffCard.assigneeName}`}</p>}
        </div>
      )}
      {needLine && (
        <div className="wb-card">
          <h2 className="wb-card-title">需求</h2>
          <p>{needLine}</p>
        </div>
      )}
    </>
  );
}

function MemberWorkbench({ pack }: { pack: IndustryPack }) {
  const { id } = useParams({ from: '/conversations/$id' });
  return <Detail id={id} pack={pack} />;
}

export function WorkbenchPage() {
  const viewer = useViewer().data;
  const pack = usePack();
  if (!pack) return null;
  if (viewer?.kind === 'member') return <MemberWorkbench pack={pack} />;
  return (
    <>
      <PageHeader title="会话工作台" />
      <EmptyBlock
        level={2}
        icon={<Icon of={MessagesSquare} size={20} />}
        title="登录后才能看会话"
        description={`会话里有${pack.vocabulary.customer}的信息，只给成员看`}
      />
    </>
  );
}
