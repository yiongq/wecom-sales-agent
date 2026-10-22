// 「AI为什么这么回」：一轮对话的详情（02 spec「后台页面 · 会话工作台」右栏的页签；07 R24 起 AI 记录页的抽屉也用它，不另写一份）。
// 只给所有者、管理员（GET /conversations/:id/turns/:turnId 的权限）。从上到下：客户说了什么、这一轮的结果与阶段、触发的护栏、
// 回复的篇幅、转人工原因、「存为回归用例」，最后是默认折叠的技术详情（原稿、护栏步骤的 id、模型调用这些毫秒级的原文）。
// 「存为回归用例」下载一份 SimGoal 草稿（GET …/goal-draft，附件，不落盘；服务端每次留一行审计）：号码已打码，但客户原话还是原话，
// 要开发者改写成合成的话、写好判定条件才能放进回归集，所以这里只说草稿，不说「已加入」。样式在 trace-detail.css，由用到它的两个懒加载页面引入
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import { Download } from 'lucide-react';
import type { ApiError, TurnTraceView } from '../../../src/shared/console-api.js';
import { HANDOFF_NOTICE_TEXT } from '../../../src/shared/conversation.js';
import { guardLabel, outcomeLabel } from '../../../src/shared/ui-labels.js';
import { api, HttpError, unwrap } from '../api.js';
import { saveText } from '../download.js';
import { errorLine } from '../parts/ErrorAlert.js';
import { Skeleton } from '../parts/StateView.js';
import { TechDetails } from '../parts/TechDetails.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import { usePack } from '../viewer.js';
import { stageLabel } from './model.js';

/** 与会话工作台共用的查询键前缀：会话有动静时整组失效，详情跟着重取 */
const CONV_PREFIX = ['conversations'] as const;

/** 就地的一行出错说明（不用 toast，不读 .detail） */
function DetailError({ error }: { error: unknown }) {
  const { text } = errorLine(error, {});
  return <p className="td-error">{text}</p>;
}

/** 下载草稿：附件的文件名取响应头里的（只含轮次 id 前 8 位），拿不到就按同样的规则拼 */
async function downloadGoalDraft(id: string, turnId: string): Promise<void> {
  const res = await api.conversations[':id'].turns[':turnId']['goal-draft'].$get({ param: { id, turnId } });
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
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `goal-draft-${turnId.slice(0, 8)}.json`;
  saveText(name, text, 'application/json;charset=utf-8');
}

function SaveAsCase({ id, turnId }: { id: string; turnId: string }) {
  const m = useMutation({ mutationFn: () => downloadGoalDraft(id, turnId) });
  return (
    <section className="td-block td-save">
      <Button onClick={() => m.mutate()} loading={m.isPending} icon={<Icon of={Download} />}>
        存为回归用例
      </Button>
      <p className="td-hint">
        {cjk(
          m.isSuccess
            ? '已下载。放进回归集之前，要把客户原话改写成合成的话、写好判定条件'
            : '下载一份草稿：客户原话要先改写成合成的话，才能放进回归集',
        )}
      </p>
      {m.error && <DetailError error={m.error} />}
    </section>
  );
}

/** 触发的护栏：不是 pass 的步骤，同名的合并；没经过流水线的轮次（固定回复、沉默）单说 */
function guardSentence(verdicts: TurnTraceView['guardVerdicts']): string {
  if (verdicts === null) return '这一轮没有经过护栏检查';
  const fired = [...new Set(verdicts.filter((v) => v.action !== 'pass').map((v) => guardLabel(v.id)))];
  return fired.length ? `触发的护栏：${fired.join('、')}` : `检查了${verdicts.length}步，都没有改动回复`;
}

function shapeSentence(s: NonNullable<TurnTraceView['replyShape']>): string {
  return [
    `回复${s.lines}行、${s.chars}字，上限${s.limit}行`,
    ...(s.trimmed > 0 ? [`裁掉${s.trimmed}句`] : []),
    ...(s.overLimit ? ['仍然超长'] : []),
  ].join('，');
}

export function TraceTab({ id, turnId }: { id: string; turnId: string | null }) {
  const pack = usePack();
  const q = useQuery({
    queryKey: [...CONV_PREFIX, 'turnTrace', id, turnId] as const,
    queryFn: () => unwrap(api.conversations[':id'].turns[':turnId'].$get({ param: { id, turnId: turnId! } })),
    enabled: turnId !== null,
  });
  if (turnId === null) return <p className="td-empty">选中一条AI回复，看它为什么这么回</p>;
  if (q.isPending) return <Skeleton rows={4} />;
  if (q.error) return <DetailError error={q.error} />;
  const t: TurnTraceView = q.data!;
  const stage = (s: string | null): string => (s === null ? '—' : pack ? stageLabel(pack, s) : s);
  return (
    <div className="td">
      {t.customerText !== null && (
        <section className="td-block">
          <h4 className="td-h">客户说</h4>
          <p className="td-quote">{t.customerText}</p>
        </section>
      )}
      <section className="td-block">
        <p>{cjk(`结果：${outcomeLabel(t.outcome)}`)}</p>
        <p>{`模型用了${t.durationMs}毫秒`}</p>
        <p>{cjk(`阶段：${stage(t.stageBefore)} → ${stage(t.stageAfter)}`)}</p>
        <p>{cjk(guardSentence(t.guardVerdicts))}</p>
        {t.replyShape && <p>{cjk(shapeSentence(t.replyShape))}</p>}
        {t.handoffKind !== null && <p>{cjk(`转人工原因：${HANDOFF_NOTICE_TEXT[t.handoffKind]}`)}</p>}
      </section>
      <SaveAsCase id={id} turnId={turnId} />
      <TechDetails
        rows={[
          ['SOP版本', String(t.sopVersion ?? '—')],
          ['前缀哈希', t.prefixHash],
          ['产品库版本', JSON.stringify(t.catalogVersions)],
        ]}
        json={{
          calls: t.calls,
          llm: t.llm,
          signals: t.signals,
          draft: t.draft,
          finalText: t.finalText,
          guardVerdicts: t.guardVerdicts,
          replyShape: t.replyShape,
          handoffKind: t.handoffKind,
        }}
      />
    </div>
  );
}
