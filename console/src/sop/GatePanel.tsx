import { Alert, Button, Input, Modal } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';
import type { GateGoalResult, GateRunView } from '../../../src/shared/console-api.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { cjk } from '../typography.js';
import { gateActive, type GateController, gateError } from './gate.js';

function resultName(result: GateGoalResult['result'] | undefined): string {
  switch (result) {
    case 'pass':
      return '通过';
    case 'fail':
      return '失败';
    case 'flaky':
      return '不稳';
    case 'skipped_budget':
      return '没跑完';
    default:
      return '暂无结果';
  }
}

function GoalResults({ run }: { run: GateRunView }) {
  const ids = [...new Set([...run.draft.map((g) => g.id), ...(run.baseline ?? []).map((g) => g.id)])];
  const groups = [
    { title: '拦发布的目标', ids: run.blocking },
    {
      title: '已知失败（不拦发布）',
      ids: ids.filter((id) => !run.blocking.includes(id) && run.baseline?.some((g) => g.id === id && g.result === 'fail')),
    },
    {
      title: '不稳（不拦发布）',
      ids: ids.filter(
        (id) => !run.blocking.includes(id) && [...run.draft, ...(run.baseline ?? [])].some((g) => g.id === id && g.result === 'flaky'),
      ),
    },
    {
      title: '没跑完（目标不拦发布）',
      ids: ids.filter(
        (id) =>
          !run.blocking.includes(id) && [...run.draft, ...(run.baseline ?? [])].some((g) => g.id === id && g.result === 'skipped_budget'),
      ),
    },
  ];
  return groups
    .filter((g) => g.ids.length > 0)
    .map((group) => (
      <section key={group.title} className="sop-gate-results">
        <h4>{cjk(group.title)}</h4>
        <ul>
          {group.ids.map((id) => {
            const draft = run.draft.find((g) => g.id === id);
            const baseline = run.baseline?.find((g) => g.id === id);
            return (
              <li key={id}>
                <strong>{id}</strong>
                <p>{cjk(`草稿：${resultName(draft?.result)}；线上：${resultName(baseline?.result)}`)}</p>
                {[
                  ['草稿', draft],
                  ['线上', baseline],
                ].map(([label, goal]) => {
                  const failures = typeof goal === 'object' ? [...new Set(goal.attempts.flatMap((a) => a.failures))] : [];
                  return failures.length > 0 ? <p key={String(label)}>{cjk(`${label}失败原因：${failures.join('；')}`)}</p> : null;
                })}
              </li>
            );
          })}
        </ul>
      </section>
    ));
}

function WaitingTime() {
  const [began] = useState(Date.now);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - began) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [began]);
  return <p>{cjk(`已等待${seconds}秒，结果会自动更新`)}</p>;
}

export function GatePanel({ gate, blocked, onStart }: { gate: GateController; blocked: string | null; onStart: () => void }) {
  const titleId = useId();
  const { run, error, starting } = gate;
  const active = starting || gateActive(run) || (!!gate.id && !run);
  const errorOnly = error !== null && !gate.id;
  let title = '发布前要先跑一次回归';
  let tone: 'info' | 'success' | 'warning' | 'error' = 'info';
  if (errorOnly || run?.status === 'error') {
    title = '回归出错了';
    tone = 'error';
  } else if (run?.status === 'abandoned') {
    title = '服务重启过，请重新跑';
    tone = 'warning';
  } else if (run?.status === 'done') {
    title = run.verdict === 'pass' ? (gate.passed ? '回归通过，可以发布' : '回归已结束，请为当前草稿重新跑') : '回归没有通过';
    tone = run.verdict === 'pass' ? (gate.passed ? 'success' : 'warning') : 'error';
  } else if (run?.status === 'running') title = '回归运行中';
  else if (active) title = '回归已排队';
  return (
    <section className="sop-gate" aria-labelledby={titleId}>
      <h3 id={titleId}>{cjk('发布回归')}</h3>
      <Alert type={tone} showIcon title={cjk(title)} />
      {run?.mock && <p>{cjk('这是模拟回归结果')}</p>}
      {active && (
        <p role="status">{cjk(run?.progress ? `已完成${run.progress.done} / 共${run.progress.total}个目标` : '正在等待回归进度')}</p>
      )}
      {active && <WaitingTime key={gate.id} />}
      {run && <p>{cjk(`已花${(run.costMilli / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })}元`)}</p>}
      {active && <p>{cjk('线上结果能复用时约需4分钟，发版后第一次约需8分钟；重跑失败目标会更久')}</p>}
      {run?.status === 'error' && <p>{cjk(gateError(run.error))}</p>}
      {error !== null && <ErrorAlert error={error} />}
      {error !== null && gate.id && <p role="status">{cjk('暂时没取到进度，正在自动重试')}</p>}
      {run?.status === 'done' && (
        <>
          {!gate.own && <p>{cjk('这次回归可能对应先前的草稿，请为当前草稿重新跑一次')}</p>}
          <p>{cjk(run.baselineReused ? '已复用线上结果' : '已在本次回归中检查线上版本')}</p>
        </>
      )}
      {run && <GoalResults run={run} />}
      {blocked && <p>{cjk(blocked)}</p>}
      <Button loading={starting} disabled={active || !!blocked} onClick={onStart}>
        {active ? (run?.status === 'running' ? '回归运行中' : '回归已排队') : run || error !== null ? '重新跑回归' : '跑回归'}
      </Button>
    </section>
  );
}

/** 强发不跳过静态检查和变更说明；仅给所有者的独立确认，原因必填、最多500字。 */
export function ForcePublish({ busy, error, onPublish }: { busy: boolean; error: unknown; onPublish: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const ready = reason.trim().length > 0 && reason.trim().length <= 500;
  return (
    <>
      <Button
        ref={trigger}
        disabled={busy}
        onClick={() => {
          setReason('');
          setOpen(true);
        }}
      >
        强制发布
      </Button>
      <Modal
        open={open}
        destroyOnHidden
        title="强制发布"
        rootClassName="sop-rb-root"
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: !busy }}
        onCancel={busy ? undefined : () => setOpen(false)}
        focusable={{ focusTriggerAfterClose: false }}
        afterOpenChange={(visible) => {
          if (visible) cancel.current?.focus();
          else trigger.current?.focus();
        }}
        footer={
          <>
            {!ready && <span className="sop-rb-reason">{cjk('填写强制发布的原因（最多500字）')}</span>}
            <Button ref={cancel} disabled={busy} onClick={() => setOpen(false)}>
              再看看
            </Button>
            <PrimaryButton
              blocked={!ready}
              loading={busy}
              onClick={() => {
                if (ready && !busy) onPublish(reason.trim());
              }}
            >
              确认强制发布
            </PrimaryButton>
          </>
        }
      >
        <p>{cjk('回归未通过或无法完成。强制发布后客户下一句就用新话术，原因会写进版本记录与操作记录。')}</p>
        {error !== null && <ErrorAlert error={error} />}
        <label htmlFor={id}>{cjk('强制发布原因')}</label>
        <Input.TextArea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={500} disabled={busy} />
      </Modal>
    </>
  );
}
