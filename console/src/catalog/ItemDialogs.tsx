// 产品库一条的两个弹窗（spec「产品库详情与编辑」的上架、复制为新草稿；设计系统 §5.14、F 页；plan 第 10.3 步）：
// - 上架确认（640）：标题「上架「条目名」」；第一句是 activateLine（字段按类型写成值）；「下面这些内容会锁定」，按锁定组分行，
//   每行是 Tag 加用 Sep 串起来的「字段 值」；有建议没做时一句 warning；最后一句 danger「上架后无法下架…」。
//   按钮「再检查一下」（默认焦点）和主按钮「上架，开始推荐」；
// - 复制为新草稿（480）：填新编号，提醒「两条都上架会同时被推荐，请区分名称和适用对象」，用这一条存着的 payload 换掉编号去建。
// 后果列表每条 16 图标加 14 文字（§5.14）；产品库文本只以文本节点渲染（不变量 28）。行业包只经 props 进来
import { Button, Input, type InputRef, Modal } from 'antd';
import { CircleAlert, CircleX, Info, Lock, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { type CheckIssue, CODE_RULE, type EntityType, type FieldDef } from '../../../src/shared/pack.js';
import { HttpError } from '../api.js';
import { useFieldEnv } from '../fields/env.js';
import { type Payload, resolveRef } from '../fields/model.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { Icon } from '../shell/icons.js';
import { cjk, Sep } from '../typography.js';
import { activateSentence, CODE_HELP, codeProblem, type LockLine, lockLines, type RefName, recommendLine } from './actions.js';

/** 引用的值写名称：按编号存的去候选里找名称，找不到（库外文本、被删的）写原文 */
function useRefName(): RefName {
  const env = useFieldEnv();
  return (f: FieldDef, v: string) => (f.store === 'label' ? v : (resolveRef(f, v, f.to ? env.refItems(f.to) : undefined)?.name ?? v));
}

/** 后果列表的一条：16 图标加 14 文字，图标与文字间隔 8（§5.14） */
function Consequence({ icon, tone, children }: { icon: typeof Info; tone: 'info' | 'lock' | 'warn' | 'danger'; children: ReactNode }) {
  return (
    <li className={`consequence consequence-${tone}`}>
      <Icon of={icon} size={16} className="consequence-icon" />
      <div className="consequence-body">{children}</div>
    </li>
  );
}

/** 锁定清单的一行：Tag（前置 lock）「识别」，后面是「字段 值」；每段整体不断行，间隔号跟在段尾，不会落到行首 */
function LockLineRow({ line }: { line: LockLine }) {
  return (
    <li className="activate-lock-line">
      <span className="lock-tag">
        <Icon of={Lock} size={12} />
        {cjk(line.tag)}
      </span>
      <span className="activate-pairs">
        {line.pairs.map((p, i) => (
          <span key={p.key} className="activate-pair">
            {p.label === null ? null : (
              // 值以「开头时不再空开：全角引号自己带着半个字的空白（「标签「国内」」）
              <span className={p.value.startsWith('「') ? 'activate-pair-label is-tight' : 'activate-pair-label'}>{cjk(p.label)}</span>
            )}
            <span className={['activate-pair-value', p.mono && 'mono', p.empty && 'is-empty'].filter(Boolean).join(' ')}>
              {p.mono ? p.value : cjk(p.value)}
            </span>
            {i < line.pairs.length - 1 ? <Sep /> : null}
          </span>
        ))}
      </span>
    </li>
  );
}

export interface ActivateDialogProps {
  open: boolean;
  entity: EntityType;
  /** 条目名（标题里写出对象） */
  title: string;
  /** 要上架的内容：表单里眼下的（有没保存的改动时先保存，所以锁定的就是这些） */
  payload: Payload;
  /** 上架前检查没做的建议 */
  recommended: readonly CheckIssue[];
  /** 没保存的改动有几处：有的话先保存再上架，这里说一声 */
  pending: number;
  busy: boolean;
  /** 关上以后焦点回到「上架…」（取消时）；上架成功、失败时为假，焦点由页面放到结果上 */
  returnFocus: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 上架确认（F 页）：只在上架前检查的必须项全过时打开 */
export function ActivateDialog(p: ActivateDialogProps) {
  const { open, entity, title, payload, recommended, pending, busy, onConfirm, onCancel } = p;
  const refName = useRefName();
  const recheck = useRef<HTMLButtonElement>(null);
  const lines = lockLines(entity, payload, refName);
  const rec = recommendLine(recommended);
  return (
    <Modal
      open={open}
      destroyOnHidden
      width={640}
      rootClassName="activate-dialog"
      title={cjk(`上架「${title}」`)}
      closeIcon={<Icon of={X} />}
      focusable={{ focusTriggerAfterClose: p.returnFocus }}
      onCancel={onCancel}
      // 默认焦点在安全的那个按钮上（§5.14）；autoFocus 在弹窗还是 display:none 时就跑了，打开以后再挪
      afterOpenChange={(visible) => {
        if (visible) recheck.current?.focus();
      }}
      footer={
        <>
          <Button ref={recheck} onClick={onCancel}>
            再检查一下
          </Button>
          <PrimaryButton loading={busy} onClick={onConfirm}>
            上架，开始推荐
          </PrimaryButton>
        </>
      }
    >
      <ul className="consequences">
        <Consequence icon={Info} tone="info">
          {cjk(activateSentence(entity, payload, refName))}
        </Consequence>
        {pending ? (
          <Consequence icon={Info} tone="info">
            {cjk(`先保存这${pending}处改动，再上架`)}
          </Consequence>
        ) : null}
        {lines.length ? (
          <Consequence icon={Lock} tone="lock">
            <div className="consequence-strong">下面这些内容会锁定</div>
            <ul className="activate-lock-lines">
              {lines.map((l) => (
                <LockLineRow key={l.key} line={l} />
              ))}
            </ul>
          </Consequence>
        ) : null}
        {rec ? (
          <Consequence icon={TriangleAlert} tone="warn">
            {cjk(rec)}
          </Consequence>
        ) : null}
        <Consequence icon={CircleAlert} tone="danger">
          {cjk('上架后无法下架，锁定的内容只能由技术修正。')}
        </Consequence>
      </ul>
    </Modal>
  );
}

export interface CopyDialogProps {
  open: boolean;
  entity: EntityType;
  /** 被复制的这一条：编号与名称 */
  from: { code: string; title: string };
  /** 列表里已有的编号：撞了提前说 */
  codes: readonly string[];
  /** 这一页没保存的改动有几处：不会带过去，说一声 */
  pending: number;
  /**
   * 这一页有没保存的内容时给：建之前先问要不要离开（同未保存保护），答「留下」时什么也不建、弹窗还开着。
   * 建好以后页面直接去新草稿，不再经离开保护
   */
  confirmLeave?(): Promise<boolean>;
  /** 建新草稿；失败时抛 HttpError（编号撞了是 409 catalog_code_taken），成功后页面去新草稿 */
  onCopy(code: string): Promise<void>;
  onCancel(): void;
  /** 关完以后（没复制成）：页面把焦点还给「更多」 */
  onClosed(): void;
}

/** 服务端说编号不行（409 撞了、422 格式不对）时写在输入框下的话；别的失败返回 null，整句报在弹窗里 */
function codeError(e: unknown): string | null {
  if (!(e instanceof HttpError)) return null;
  if (e.body.error === 'catalog_code_taken') return '这个编号已经有了，换一个';
  if (e.body.error === 'invalid_item' && (e.body.issues ?? []).some((i) => i.path === 'id')) return CODE_RULE;
  return null;
}

/** 复制为新草稿（spec「复制为新草稿」）：填新编号；默认焦点在输入框里，回车就是复制 */
export function CopyDialog({ open, entity, from, codes, pending, confirmLeave, onCopy, onCancel, onClosed }: CopyDialogProps) {
  const uid = useId();
  const input = useRef<InputRef>(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  /** 从点下去到结束（含问离开的那一段）只提交一次：回车连按、确认框开着时再按都不重复建 */
  const submitting = useRef(false);
  const submit = async (): Promise<void> => {
    if (submitting.current) return;
    const c = code.trim();
    const bad = codeProblem(c, from.code, codes);
    setFailure(null);
    if (bad) {
      setProblem(bad);
      input.current?.focus();
      return;
    }
    submitting.current = true;
    try {
      if (confirmLeave && !(await confirmLeave())) return;
      setBusy(true);
      await onCopy(c);
    } catch (e) {
      const own = codeError(e);
      if (own) {
        setProblem(own);
        input.current?.focus();
      } else setFailure(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const noteId = `${uid}n`;
  return (
    <Modal
      open={open}
      destroyOnHidden
      width={480}
      title={cjk(`复制「${from.title}」为新草稿`)}
      closeIcon={<Icon of={X} />}
      // 打开它的是「更多」菜单里的一项，关上时已经收起、拿不到焦点：不让 antd 去还，由页面还给「更多」
      focusable={{ focusTriggerAfterClose: false }}
      onCancel={onCancel}
      afterOpenChange={(visible) => {
        if (visible) input.current?.focus();
        else {
          setCode('');
          setProblem(null);
          setFailure(null);
          onClosed();
        }
      }}
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <PrimaryButton loading={busy} onClick={() => void submit()}>
            复制为新草稿
          </PrimaryButton>
        </>
      }
    >
      <ul className="consequences">
        <Consequence icon={Info} tone="info">
          {cjk('新草稿的内容与这一条存着的相同，只换编号')}
        </Consequence>
        {pending ? (
          <Consequence icon={Info} tone="info">
            {cjk(`这一页还有${pending}处改动没保存，不会带过去`)}
          </Consequence>
        ) : null}
        <Consequence icon={TriangleAlert} tone="warn">
          {cjk('两条都上架会同时被推荐，请区分名称和适用对象')}
        </Consequence>
      </ul>
      <div className="copy-code field">
        <label className="field-label" htmlFor={`${uid}c`}>
          {cjk(`新的${entity.codeLabel}`)}
        </label>
        <Input
          ref={input}
          id={`${uid}c`}
          className="mono"
          value={code}
          placeholder={`例：${entity.codeExample}`}
          status={problem ? 'error' : undefined}
          aria-invalid={problem ? true : undefined}
          aria-describedby={noteId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setCode(e.target.value);
            setProblem(null);
          }}
          onPressEnter={() => void submit()}
        />
        <div id={noteId} className={problem ? 'field-error' : 'field-help'}>
          {problem ? <Icon of={CircleX} size={14} /> : null}
          {cjk(problem ? `${entity.codeLabel}：${problem}` : CODE_HELP)}
        </div>
      </div>
      {failure === null ? null : (
        <div className="copy-failure">
          <ErrorAlert error={failure} onRetry={() => void submit()} />
        </div>
      )}
    </Modal>
  );
}
