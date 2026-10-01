// 回滚确认（spec「销售话术 · 回滚」，设计系统 §5.14 与 C 页）：版本记录的「回滚到这版…」和发布条的「回滚到v2」共用。
// 640 宽弹窗，标题「回滚到v1」。先写后果（history.ts 的 rollbackConsequences）：会生成哪一版并立即上线、线上那一版还在、
// 固定规则节用现在的写法；目标版本的固定规则节和线上不同时，提交之前就写「固定规则改过」；有草稿时按发布时的三方合并比一次，
// 有交集写 warning「回滚后要先合并」，没有写 info「发布时自动并入」。草稿的基线不是线上版本（这期间别人发布过）时
// 要另取那一版，取的时候那一条是骨架，取不到就地报错、能重试，回滚照样能做。
// 下面是差异块「回滚后，线上的可编辑节会变成这样」（--subtle 底，逐节的行内差异），再下面是必填的「为什么回滚」。
// 按钮「再看看」（默认焦点）和「回滚到v1」（墨色主按钮：回滚会生成新版本，还能再回滚，不是破坏性操作）；
// 没写原因时「回滚到v1」是 aria-disabled，点了到输入框。成功以后刷新 /sop 与版本记录，toast 报新版本号；
// 回滚后的新版本与目标版本的固定规则不同时，调用方用 rollbackNotice 在页面上写说明
import { useQueryClient } from '@tanstack/react-query';
import { Button, type GetRef, Input, Modal } from 'antd';
import { Info, Lock, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { RollbackResult, SectionSpecView, SopSectionText, SopVersion } from '../../../src/shared/console-api.js';
import { api, unwrap } from '../api.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { Skeleton } from '../parts/StateView.js';
import { toast } from '../parts/toast.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import { DiffView, trimEnd } from './DiffView.js';
import {
  type ConsequenceIcon,
  rollbackConsequences,
  rollbackDiffTitle,
  rollbackHelp,
  rollbackPlan,
  rollbackSectionTitle,
} from './history.js';
import { useKnownVersion } from './HistoryParts.js';

/** 回滚后的新版本与目标版本的固定规则不同（sameHashAsTarget 为 false）时的说明 */
export const rollbackNotice = (v: RollbackResult, target: Pick<SopVersion, 'versionNo'>): string | null =>
  v.sameHashAsTarget
    ? null
    : `v${target.versionNo}之后代码里的固定规则改过，固定规则节用的是现在的写法，所以v${v.versionNo}不会和v${target.versionNo}完全一样。`;

const ICONS: Readonly<Record<ConsequenceIcon, { of: typeof Info; className: string }>> = {
  info: { of: Info, className: 'sop-rb-icon' },
  lock: { of: Lock, className: 'sop-rb-icon' },
  warning: { of: TriangleAlert, className: 'sop-rb-icon is-warning' },
};

/** 没写原因时点「回滚到v1」的提示（写在按钮左边，同发布抽屉） */
const NEED_NOTE = '写上为什么回滚';

export interface RollbackModalProps {
  target: SopVersion | null;
  /** 现在的线上版本（页面上的，或检查时另取到的更新的那一版） */
  online: SopVersion;
  spec: readonly SectionSpecView[];
  /** 草稿：基线版本的 id 与草稿的节（含还没存上的改动）；没有草稿、什么也没改是 null */
  draft: { basedOn: string; mine: readonly SopSectionText[] } | null;
  onClose: () => void;
  onDone: (v: RollbackResult, target: SopVersion) => void;
}

/**
 * 关着时不挂弹层（同 ConfirmDanger：话术页逐字重渲）。关上的动画放完以前照关上那一刻的目标画，放完以后清掉写过的原因与错误
 */
export function RollbackModal({ target, online, spec, draft, onClose, onDone }: RollbackModalProps) {
  const qc = useQueryClient();
  const [shown, setShown] = useState<SopVersion | null>(target);
  if (target && target !== shown) setShown(target);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tried, setTried] = useState(false);
  const inputRef = useRef<GetRef<typeof Input>>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const helpId = useId();
  const reasonId = useId();
  // 草稿的基线：多半就是线上版本；这期间别人发布过时是更早的一版，另取（版本记录里已经有的不再取）
  const stale = draft !== null && draft.basedOn !== online.id;
  const base = useKnownVersion(target && stale ? draft.basedOn : null);
  const baseVersion = !draft ? null : stale ? (base.data ?? null) : online;
  const plan =
    shown && rollbackPlan({ spec, online, target: shown, draft: draft && baseVersion ? { base: baseVersion, mine: draft.mine } : null });
  const ready = note.trim() !== '';

  const submit = async (): Promise<void> => {
    if (!shown || busy) return;
    if (!ready) {
      setTried(true);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const v = await unwrap(api.sop.versions[':id'].rollback.$post({ param: { id: shown.id }, json: { changeNote: note } }));
      onDone(v, shown);
      await qc.invalidateQueries({ queryKey: ['sop'] });
      await qc.invalidateQueries({ queryKey: ['sop-versions'] });
      toast(`已回滚到v${shown.versionNo}：新版本v${v.versionNo}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      destroyOnHidden
      open={!!target}
      width={640}
      title={`回滚到v${shown?.versionNo ?? ''}`}
      onCancel={onClose}
      rootClassName="sop-rb-root"
      afterOpenChange={(visible) => {
        // 打开时焦点先进内容区（antd 的焦点陷阱），这里挪到「再看看」上：安全的那个按钮默认聚焦
        if (visible) cancelRef.current?.focus();
        else {
          setShown(null);
          setNote('');
          setError(null);
          setTried(false);
        }
      }}
      footer={
        <>
          {!ready && (
            <span id={reasonId} className="sop-rb-reason">
              {cjk(NEED_NOTE)}
            </span>
          )}
          <Button ref={cancelRef} onClick={onClose}>
            再看看
          </Button>
          <PrimaryButton blocked={!ready} loading={busy} aria-describedby={ready ? undefined : reasonId} onClick={() => void submit()}>
            回滚到v{shown?.versionNo ?? ''}
          </PrimaryButton>
        </>
      }
    >
      {plan && (
        <div className="sop-rb">
          <ul className="sop-rb-list">
            {rollbackConsequences(plan).map((c) => (
              <li key={c.text}>
                <Icon of={ICONS[c.icon].of} className={ICONS[c.icon].className} />
                <span>{cjk(c.text)}</span>
              </li>
            ))}
            {stale && base.isPending && (
              <li aria-hidden="true" className="sop-rb-pending">
                <Skeleton rows={1} rowHeight={22} />
              </li>
            )}
          </ul>
          {stale && base.isError && <ErrorAlert error={base.error} title="没取到草稿的基线版本" onRetry={() => void base.refetch()} />}
          <div className="sop-rb-diff">
            {/* 只有一节时标题与节名写成一行（C 页）：「回滚后，线上的可编辑节会变成这样：异议处理531 → 496字」 */}
            <p className="sop-rb-diff-title">
              {cjk(plan.changes.length === 1 ? rollbackDiffTitle + rollbackSectionTitle(plan.changes[0]!, plan) : rollbackDiffTitle)}
            </p>
            {plan.changes.map((c) => (
              <section key={c.key} className="sop-rb-diff-item" aria-label={c.name}>
                {plan.changes.length > 1 && <p className="sop-rb-diff-name">{cjk(rollbackSectionTitle(c, plan))}</p>}
                <div className="sop-diff">
                  <DiffView change={trimEnd(c)} mode="inline" labels={[`v${plan.onlineNo}`, `v${plan.targetNo}`]} />
                </div>
              </section>
            ))}
            {plan.changes.length === 0 && <p className="sop-rb-diff-none">{cjk('可编辑节和线上一样，不会变')}</p>}
          </div>
          <div className="sop-rb-note">
            <label htmlFor={noteId} className="sop-publish-label">
              为什么回滚
            </label>
            <Input
              ref={inputRef}
              id={noteId}
              value={note}
              required
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              onPressEnter={() => void submit()}
              placeholder={`例：v${plan.onlineNo}的嫌贵话术让客户觉得被追问预算`}
              aria-describedby={helpId}
              aria-invalid={tried && !ready ? true : undefined}
            />
            <p id={helpId} className="sop-publish-help">
              {cjk(rollbackHelp(plan.nextNo))}
            </p>
          </div>
          {error !== null && <ErrorAlert error={error} onRetry={() => void submit()} />}
        </div>
      )}
    </Modal>
  );
}
