// 抽检（17 spec R2、R4）：在 AI 记录详情的最终回复之后给这一轮打分。好评点一下就存；差评先选原因，点原因才存，
// 所以不存在「差评没有原因」。两个管理员同时改时后到的 409，这里写明并换成最新的结论，不覆盖别人的意见。
// 差评之后可以下载回归草稿：只有骨架，没有任何源对话内容，要管理员在受控位置用虚构内容重写。
// 接口 403、503 时整块不画：沙箱和文件存储没有抽检（17 R1），不是出错。
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button } from 'antd';
import { Download, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import {
  REVIEW_REASONS,
  type ApiError,
  type ReviewReason,
  type TurnReviewInput,
  type TurnTraceDetailView,
} from '../../../src/shared/console-api.js';
import { fullTime } from '../../../src/shared/format.js';
import { api, HttpError, unwrap } from '../api.js';
import { saveText } from '../download.js';
import { errorLine } from '../parts/ErrorAlert.js';
import { Skeleton } from '../parts/StateView.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import { REVIEW_REASON_LABEL } from './model.js';

const statusOf = (e: unknown): number | null => (e instanceof HttpError ? e.status : null);

export const traceDetailQuery = (turnId: string) =>
  queryOptions({
    queryKey: ['traces', 'turn', turnId] as const,
    queryFn: () => unwrap(api.traces[':turnId'].$get({ param: { turnId } })),
  });

async function downloadRegressionDraft(turnId: string): Promise<void> {
  const res = await api.traces[':turnId']['regression-draft'].$post({ param: { turnId } });
  const text = await res.text();
  if (res.status !== 200) {
    let body: ApiError;
    try {
      body = JSON.parse(text) as ApiError;
    } catch {
      body = { error: 'bad_response' };
    }
    throw new HttpError(res.status, body);
  }
  saveText('regression-draft.json', text, 'application/json;charset=utf-8');
}

function DraftAction({ turnId }: { turnId: string }) {
  const m = useMutation({ mutationFn: () => downloadRegressionDraft(turnId) });
  return (
    <div className="tr-review-draft">
      <Button size="small" onClick={() => m.mutate()} loading={m.isPending} icon={<Icon of={Download} />}>
        准备回归草稿
      </Button>
      <p className="td-hint">
        {cjk(
          m.isSuccess
            ? '已下载，文件里没有客户原话。用虚构的产品和数量在受控位置重写，不要放进代码仓库'
            : '下载空白骨架，不含这轮对话的任何内容',
        )}
      </p>
      {m.isError && <p className="td-error">{errorLine(m.error, {}).text}</p>}
    </div>
  );
}

function ReviewForm({ turn }: { turn: TurnTraceDetailView }) {
  const qc = useQueryClient();
  const key = traceDetailQuery(turn.turnId).queryKey;
  const current = turn.review;
  // 只在点了差评、还没选原因时为 true；已有差评时原因一直显示，可以直接改
  const [choosing, setChoosing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const save = useMutation({
    mutationFn: (json: TurnReviewInput) => unwrap(api.traces[':turnId'].review.$put({ param: { turnId: turn.turnId }, json })),
    onSuccess: (review) => {
      setChoosing(false);
      setConflict(false);
      qc.setQueryData(key, (old) => old && { ...old, review });
      void qc.invalidateQueries({ queryKey: ['traces', 'list'] });
    },
    onError: (e) => {
      if (statusOf(e) !== 409) return;
      setChoosing(false);
      setConflict(true);
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const submit = (rating: 'good' | 'bad', reason: ReviewReason | null) =>
    save.mutate({ rating, reason, expectedRevision: current?.revision ?? 0 });
  const showReasons = choosing || current?.rating === 'bad';
  return (
    <section className="td-block tr-review" aria-label="评价这轮回复">
      <h4 className="td-h">评价这轮回复</h4>
      <div className="tr-review-actions">
        <Button
          size="small"
          aria-pressed={current?.rating === 'good' && !choosing}
          icon={<Icon of={ThumbsUp} />}
          disabled={save.isPending}
          onClick={() => {
            setChoosing(false);
            if (current?.rating !== 'good') submit('good', null);
          }}
        >
          好评
        </Button>
        <Button
          size="small"
          aria-pressed={choosing || current?.rating === 'bad'}
          icon={<Icon of={ThumbsDown} />}
          disabled={save.isPending}
          onClick={() => setChoosing(true)}
        >
          差评
        </Button>
      </div>
      {showReasons && (
        <div className="tr-review-reasons" role="group" aria-label="差评原因，选一项后保存">
          {REVIEW_REASONS.map((reason) => (
            <Button
              key={reason}
              size="small"
              type="text"
              className="tr-review-reason"
              aria-pressed={current?.reason === reason}
              disabled={save.isPending}
              onClick={() => (current?.reason === reason ? setChoosing(false) : submit('bad', reason))}
            >
              {REVIEW_REASON_LABEL[reason]}
            </Button>
          ))}
        </div>
      )}
      {choosing && current?.rating !== 'bad' && <p className="td-hint">选一个原因就保存</p>}
      {conflict && <Alert type="warning" showIcon title="刚才有人改过这条评价，这里已换成最新的结果" />}
      {save.isError && statusOf(save.error) !== 409 && <p className="td-error">{errorLine(save.error, {}).text}</p>}
      {current && <p className="td-hint">{cjk(`${current.reviewer}评于${fullTime(current.updatedAt)}`)}</p>}
      {current?.rating === 'bad' && <DraftAction turnId={turn.turnId} />}
    </section>
  );
}

export function ReviewBlock({ turnId }: { turnId: string }) {
  const q = useQuery(traceDetailQuery(turnId));
  if (q.isPending) return <Skeleton rows={1} rowHeight={32} />;
  const status = statusOf(q.error);
  if (status === 403 || status === 503) return null;
  if (q.isError) return <p className="td-error">{errorLine(q.error, {}).text}</p>;
  if (!q.data.reviewable) return <p className="td-hint">这一轮没有发出最终回复，不用评价</p>;
  return <ReviewForm turn={q.data} />;
}
