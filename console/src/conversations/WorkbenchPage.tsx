// 会话工作台（J 页，02 spec「后台页面 · 会话工作台（J 页）」，设计系统 §10.2 J 页）。路由 /conversations/$id，$id 经
// encodeURIComponent。三栏：列表 320（分组：等人接手、顾问处理中、AI接待中、已成交，没有会话的组不画）、对话（自适应）、
// 「客户与交接」360；进入时侧栏收起（shell/model.ts collapsedByDefault）。
// 第 19 步的占位版（最小概要）整个替掉；路由注册、GET /conversations/:id 的读法、各处「打开工作台」的入口都已经接好，
// 这里只换 WorkbenchPage 的内容。匿名与非成员没有入口，同 I 页（原样保留占位版的空态）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Button, Dropdown, Input, Modal, Switch } from 'antd';
import { Ellipsis, MessagesSquare } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversationDetail,
  MessageView,
  OrderView,
  QuickReply,
  Role,
  TurnDiffView,
  TurnStepsView,
  TurnTraceView,
} from '../../../src/shared/console-api.js';
import { conversationState } from '../../../src/shared/conversation.js';
import { clockTime } from '../../../src/shared/format.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { api, unwrap } from '../api.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { errorLine } from '../parts/ErrorAlert.js';
import { popupRegion } from '../parts/popupRegion.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { TechDetails } from '../parts/TechDetails.js';
import { conversationDetailQuery } from '../queries.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { Icon } from '../shell/icons.js';
import { IconButton } from '../shell/IconButton.js';
import { conversationLabel, documentTitle } from '../shell/model.js';
import { shellViewerOf } from '../shell/PageHeader.js';
import { cjk } from '../typography.js';
import { usePack, useViewer } from '../viewer.js';
import { stageLabel } from './model.js';
import {
  advisorLabel,
  CAN_HANDLE_ROLES,
  deliveryNote,
  guardLine,
  handoffCardHead,
  handoffNoteLine,
  headWait,
  needLine,
  ORDER_STATUS_LABEL,
  orderLine,
  quoteLine,
  sendWindowView,
  type SendWindowView,
  stepsLine,
  type WbGroup,
  wbGroups,
  type WbRow,
} from './workbench.js';

const CONV_PREFIX = ['conversations'] as const;

// ---------------- 小部件 ----------------

/** 就地的一行出错说明（不用 toast，不读 .detail；ERROR_COPY 里 place: 'inline' 的几条都走这里） */
function InlineError({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const { text } = errorLine(error, {});
  return <p className="wb-inline-error">{text}</p>;
}

/** 非危险的二次确认（§5.14：改派这类不算危险操作，确认按钮用主按钮；默认焦点在安全的那个按钮上） */
function ActionConfirm({
  open,
  title,
  children,
  confirmText,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmText: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      destroyOnHidden
      width={480}
      title={cjk(title)}
      onCancel={onCancel}
      afterOpenChange={(visible) => {
        if (visible) cancelRef.current?.focus();
      }}
      footer={
        <>
          <Button ref={cancelRef} onClick={onCancel}>
            再想想
          </Button>
          <PrimaryButton loading={busy} onClick={() => void confirm()}>
            {confirmText}
          </PrimaryButton>
        </>
      }
    >
      {children}
    </Modal>
  );
}

// ---------------- 左栏：分组列表 ----------------

function WbListRow({ row }: { row: WbRow }) {
  return (
    <li className={row.selected ? 'wb-row is-selected' : 'wb-row'}>
      <Link to="/conversations/$id" params={{ id: row.id }} className="wb-row-link" aria-label={`${row.label.join(' ')}，${row.context}`}>
        <span className="wb-row-title">{cjk(row.label)}</span>
        <span className="wb-row-sub">
          <Status kind={row.state} />
          <span className="wb-row-ctx" title={row.context}>
            {cjk(row.context)}
          </span>
          <time className={row.timeTone ? `wb-row-time is-${row.timeTone}` : 'wb-row-time'} title={row.timeFull}>
            {row.time}
          </time>
        </span>
      </Link>
    </li>
  );
}

function WbList({
  groups,
  total,
  pending,
  error,
  onRetry,
}: {
  groups: readonly WbGroup[];
  total: number | null;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="wb-list">
      <div className="wb-list-head">
        <h2 className="wb-list-title">{total === null ? '会话' : `会话${total}个`}</h2>
      </div>
      <div className="wb-list-body">
        <StateView
          pending={pending}
          error={error}
          onRetry={onRetry}
          skeleton={<Skeleton rows={8} rowHeight={64} />}
          empty={groups.length === 0 && { title: '还没有会话' }}
        >
          {groups.map((g) => (
            <section key={g.state} className="wb-group" aria-label={g.label}>
              <h3 className="wb-group-title">
                {g.label}
                {g.soft ? (
                  <span className="badge-soft" aria-hidden="true">
                    {g.count}
                  </span>
                ) : (
                  <span className="wb-group-count">{g.count}</span>
                )}
              </h3>
              <ul className="wb-group-rows">
                {g.rows.map((r) => (
                  <WbListRow key={r.id} row={r} />
                ))}
              </ul>
            </section>
          ))}
        </StateView>
      </div>
    </div>
  );
}

function WbListColumn({ pack, selectedId }: { pack: IndustryPack; selectedId: string }) {
  const listQ = useQuery({
    queryKey: [...CONV_PREFIX, 'recent'] as const,
    queryFn: () => unwrap(api.conversations.$get({ query: { limit: '100', order: 'waiting_first' } })),
  });
  const countsQ = useQuery({
    queryKey: [...CONV_PREFIX, 'counts'] as const,
    queryFn: () => unwrap(api.conversations.counts.$get()),
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const groups = listQ.data ? wbGroups(listQ.data.items, countsQ.data, pack, now, selectedId) : [];
  return (
    <WbList
      groups={groups}
      total={countsQ.data?.total ?? listQ.data?.total ?? null}
      pending={listQ.isPending}
      error={listQ.error}
      onRetry={() => void listQ.refetch()}
    />
  );
}

// ---------------- 对话头 ----------------

function MoreMenu({
  canRelease,
  canReassign,
  onRelease,
  onReassign,
  onCopyLink,
}: {
  canRelease: boolean;
  canReassign: boolean;
  onRelease: () => void;
  onReassign: () => void;
  onCopyLink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const items = [
    { key: 'release', label: '交还AI', disabled: !canRelease },
    { key: 'copy', label: '复制会话链接' },
    ...(canReassign ? [{ key: 'reassign', label: '改由我处理' }] : []),
  ];
  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      placement="bottomRight"
      autoFocus
      destroyOnHidden
      popupRender={popupRegion('更多')}
      menu={{
        items,
        onClick: ({ key, domEvent }) => {
          domEvent.preventDefault();
          setOpen(false);
          if (key === 'release') onRelease();
          else if (key === 'copy') onCopyLink();
          else if (key === 'reassign') onReassign();
        },
      }}
    >
      <IconButton label="更多" icon={Ellipsis} size={32} aria-haspopup="menu" aria-expanded={open} tipOpen={open ? false : undefined} />
    </Dropdown>
  );
}

// 这个参数不叫 detail：scripts/check-console-src.ts 不变量 8 不许解构出一个叫 detail 的绑定（服务端错误体的 detail
// 只许 TechDetails.tsx 读），cd 是 ConversationDetail 的缩写，与 Detail() 里 const cd = q.data 同一个叫法
function ConversationHead({
  cd,
  pack,
  now,
  handles,
  onTakeover,
  onReassign,
  onRelease,
  onCopyLink,
  copied,
  takeoverError,
  releaseError,
}: {
  cd: ConversationDetail;
  pack: IndustryPack;
  now: number;
  handles: boolean;
  onTakeover: () => void;
  onReassign: () => void;
  onRelease: () => void;
  onCopyLink: () => void;
  copied: boolean;
  takeoverError: unknown;
  releaseError: unknown;
}) {
  const { row } = cd;
  const state = conversationState(row, pack);
  const label = conversationLabel(row, pack);
  const wait = state === 'human' && row.handoff ? headWait(row.handoff.at, now) : null;
  return (
    <div className="wb-head">
      <div className="wb-head-main">
        <span className="wb-head-title">{cjk(label)}</span>
        <Status kind={state} />
        {wait && (
          <span className={wait.urgent ? 'wb-head-wait is-danger' : 'wb-head-wait'} title={wait.full}>
            {wait.text}
          </span>
        )}
      </div>
      {handles && (
        <div className="wb-head-actions">
          {cd.can.takeover ? (
            <PrimaryButton onClick={onTakeover}>接手会话</PrimaryButton>
          ) : (
            row.assignee && <span className="wb-head-note">{`${row.assignee.name}处理中`}</span>
          )}
          <MoreMenu
            canRelease={cd.can.release}
            canReassign={cd.can.reassign}
            onRelease={onRelease}
            onReassign={onReassign}
            onCopyLink={onCopyLink}
          />
        </div>
      )}
      {(cd.consentDeclined || copied) && (
        <p className="wb-head-note2" role={copied ? 'status' : undefined}>
          {copied ? '已复制' : '客户没有同意，不能交给AI'}
        </p>
      )}
      <InlineError error={takeoverError} />
      <InlineError error={releaseError} />
    </div>
  );
}

// ---------------- 消息 ----------------

function HandoffNoteRow({ m }: { m: MessageView }) {
  return <p className="wb-timeline">{cjk(handoffNoteLine(m.text, m.at))}</p>;
}

function SystemRow({ m }: { m: MessageView }) {
  return <p className="wb-system">{cjk(m.text)}</p>;
}

function GuardDiff({ id, turnId }: { id: string; turnId: string }) {
  const q = useQuery({
    queryKey: [...CONV_PREFIX, 'turnDiff', id, turnId] as const,
    queryFn: () => unwrap(api.conversations[':id'].turns[':turnId'].diff.$get({ param: { id, turnId } })),
  });
  if (q.isPending) return <Skeleton rows={1} rowHeight={16} />;
  if (q.error) return <InlineError error={q.error} />;
  const d: TurnDiffView = q.data!;
  return (
    <dl className="wb-guard-diff">
      {d.removed.length > 0 && (
        <>
          <dt>删去</dt>
          {d.removed.map((s, i) => (
            <dd key={`r${i}`}>{cjk(s)}</dd>
          ))}
        </>
      )}
      {d.added.length > 0 && (
        <>
          <dt>发出</dt>
          {d.added.map((s, i) => (
            <dd key={`a${i}`}>{cjk(s)}</dd>
          ))}
        </>
      )}
    </dl>
  );
}

function AgentBubble({
  id,
  m,
  canTraces,
  selectedTurnId,
  onSelectTurn,
  pendingSave,
}: {
  id: string;
  m: MessageView;
  canTraces: boolean;
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  /** POST /reply 返回 persisted: false：改动还在写队列里，没落库（02 spec：「已发出，记录稍后保存」） */
  pendingSave: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = m.author === 'human' ? advisorLabel(m.authorName) : m.author === 'followup' ? '自动跟进' : null;
  const note = deliveryNote(m.delivery);
  const clickable = canTraces && m.turnId !== null;
  const bubbleCls = `wb-bubble wb-bubble-ai${selectedTurnId !== null && selectedTurnId === m.turnId ? ' is-traced' : ''}`;
  const bubble = (
    <div className={bubbleCls}>
      {label && <div className="wb-bubble-label">{label}</div>}
      <p className="wb-bubble-text">{cjk(m.text)}</p>
    </div>
  );
  return (
    <div className="wb-msg wb-msg-agent">
      {clickable ? (
        <button type="button" className="wb-bubble-btn" onClick={() => onSelectTurn(m.turnId!)} aria-label="看AI为什么这么回">
          {bubble}
        </button>
      ) : (
        bubble
      )}
      {m.guarded && (
        <>
          <button type="button" className="wb-guard-toggle" onClick={() => setExpanded((e) => !e)}>
            {cjk(guardLine(m.guarded, expanded))}
          </button>
          {expanded && <GuardDiff id={id} turnId={m.turnId!} />}
        </>
      )}
      {pendingSave && <p className="wb-pending-note">已发出，记录稍后保存</p>}
      {note && <p className="wb-delivery-note">{cjk(note)}</p>}
    </div>
  );
}

function MessageRow({
  id,
  m,
  steps,
  canTraces,
  selectedTurnId,
  onSelectTurn,
  pendingSave,
}: {
  id: string;
  m: MessageView;
  steps: readonly string[] | null;
  canTraces: boolean;
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  pendingSave: boolean;
}) {
  if (m.kind === 'handoff_note') return <HandoffNoteRow m={m} />;
  if (m.role === 'system') return <SystemRow m={m} />;
  return (
    <>
      {steps && <p className="wb-steps-line">{cjk(steps)}</p>}
      {m.role === 'customer' ? (
        <div className="wb-msg wb-msg-customer">
          <div className="wb-bubble wb-bubble-customer">
            <p className="wb-bubble-text">{cjk(m.text)}</p>
          </div>
        </div>
      ) : (
        <AgentBubble
          id={id}
          m={m}
          canTraces={canTraces}
          selectedTurnId={selectedTurnId}
          onSelectTurn={onSelectTurn}
          pendingSave={pendingSave}
        />
      )}
    </>
  );
}

function MessageList({
  id,
  messages,
  hasEarlier,
  onLoadEarlier,
  loadingEarlier,
  showSteps,
  steps,
  canTraces,
  selectedTurnId,
  onSelectTurn,
  pendingSeqs,
}: {
  id: string;
  messages: readonly MessageView[];
  hasEarlier: boolean;
  onLoadEarlier: () => void;
  loadingEarlier: boolean;
  showSteps: boolean;
  steps: TurnStepsView | undefined;
  canTraces: boolean;
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  pendingSeqs: ReadonlySet<number>;
}) {
  const stepsOf = useMemo(() => {
    const map = new Map<string, readonly string[]>();
    if (!showSteps || !steps) return map;
    for (const t of steps.turns) {
      const line = stepsLine(t.steps);
      if (line) map.set(t.turnId, line);
    }
    return map;
  }, [showSteps, steps]);
  return (
    <div className="wb-messages">
      {hasEarlier && (
        <div className="wb-earlier">
          <Button size="small" loading={loadingEarlier} onClick={onLoadEarlier}>
            看更早的消息
          </Button>
        </div>
      )}
      {messages.map((m) => (
        <MessageRow
          key={m.seq}
          id={id}
          m={m}
          steps={m.turnId ? (stepsOf.get(m.turnId) ?? null) : null}
          canTraces={canTraces}
          selectedTurnId={selectedTurnId}
          onSelectTurn={onSelectTurn}
          pendingSave={pendingSeqs.has(m.seq)}
        />
      ))}
    </div>
  );
}

// ---------------- 交接卡、输入框 ----------------

function HandoffCard({ handoffCard, pack }: { handoffCard: NonNullable<ConversationDetail['handoffCard']>; pack: IndustryPack }) {
  const head = handoffCardHead(handoffCard);
  return (
    <div className="wb-handoff-card">
      <p className={head.urgent ? 'wb-handoff-head is-danger' : 'wb-handoff-head'}>{cjk([head.text, clockTime(handoffCard.at)])}</p>
      <p className="wb-handoff-row">{`原因：${handoffCard.reason}`}</p>
      {handoffCard.quote && <p className="wb-handoff-row">{`客户原话：「${handoffCard.quote}」`}</p>}
      {handoffCard.departNote && <p className="wb-handoff-row">{handoffCard.departNote}</p>}
      {handoffCard.stageBefore && <p className="wb-handoff-row">{`停在：${stageLabel(pack, handoffCard.stageBefore)}`}</p>}
    </div>
  );
}

function ReplyBox({
  canReply,
  sendWindow,
  text,
  onChangeText,
  onSend,
  sending,
  replyError,
}: {
  canReply: boolean;
  sendWindow: SendWindowView | null;
  text: string;
  onChangeText: (t: string) => void;
  onSend: (text: string) => void;
  sending: boolean;
  replyError: unknown;
}) {
  const disabled = !canReply || (sendWindow !== null && !sendWindow.canSend);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled || sending) return;
    onSend(trimmed);
  };
  return (
    <form className="wb-replybox" onSubmit={submit}>
      <Input.TextArea
        className="wb-replybox-input"
        value={text}
        onChange={(e) => onChangeText(e.target.value)}
        disabled={disabled}
        rows={3}
        maxLength={2000}
        showCount={{ formatter: ({ count }) => String(count) }}
        placeholder={canReply ? undefined : '接管后在此回复，客户在企业微信中看到'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="wb-replybox-foot">
        <span className="wb-replybox-hint">
          {/* 接手之前（!canReply）不显示发送窗口这一行：那是接手之后才有意义的说明，接手之前的禁用原因是占位文字 */}
          {!canReply ? null : sendWindow && !sendWindow.canSend ? (
            <span className="wb-send-reason">{sendWindow.reason}</span>
          ) : sendWindow?.text ? (
            cjk(sendWindow.text)
          ) : null}
        </span>
        <Button htmlType="submit" disabled={disabled || sending || !text.trim()} loading={sending}>
          发送
        </Button>
      </div>
      <InlineError error={replyError} />
    </form>
  );
}

// ---------------- 右栏 ----------------

function OrderRow({
  o,
  canConfirm,
  canMarkPaid,
  onConfirm,
  onMarkPaid,
  onCancel,
  confirmError,
  markPaidError,
  cancelError,
}: {
  o: OrderView;
  canConfirm: boolean;
  canMarkPaid: boolean;
  onConfirm: () => void;
  onMarkPaid: () => void;
  onCancel: (reason: string) => void;
  confirmError: unknown;
  markPaidError: unknown;
  cancelError: unknown;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);
  return (
    <div className="wb-order">
      <p className="wb-order-line">{cjk(orderLine(o))}</p>
      {/* 订单状态不是会话的四态，design-system §5.6 的 Status 没有给它配色；按原则 9（红色只表示出错），
          这里只用文字，不新造一种带色胶囊（不新加令牌、不碰 Status 组件） */}
      <p className="wb-order-status">{ORDER_STATUS_LABEL[o.status]}</p>
      {o.status === 'pending_payment' && (
        <div className="wb-order-actions">
          {!o.confirmed && canConfirm && (
            <Button size="small" onClick={onConfirm}>
              确认价格
            </Button>
          )}
          {o.confirmed && canMarkPaid && (
            <Button size="small" onClick={onMarkPaid}>
              确认收款
            </Button>
          )}
          {(canConfirm || canMarkPaid) && (
            <Button size="small" type="text" onClick={() => setCancelOpen(true)}>
              取消订单
            </Button>
          )}
        </div>
      )}
      <InlineError error={confirmError} />
      <InlineError error={markPaidError} />
      <InlineError error={cancelError} />
      <ConfirmDanger
        open={cancelOpen}
        title="取消这张订单？"
        confirmText="取消订单"
        cancelText="留着"
        onCancel={() => setCancelOpen(false)}
        onConfirm={() => {
          setCancelOpen(false);
          onCancel('顾问在工作台取消');
        }}
      >
        取消之后这张订单作废，不能恢复；客户需要新的报价才能再下单。
      </ConfirmDanger>
    </div>
  );
}

function TraceTab({ id, turnId }: { id: string; turnId: string | null }) {
  const q = useQuery({
    queryKey: [...CONV_PREFIX, 'turnTrace', id, turnId] as const,
    queryFn: () => unwrap(api.conversations[':id'].turns[':turnId'].$get({ param: { id, turnId: turnId! } })),
    enabled: turnId !== null,
  });
  if (turnId === null) return <p className="wb-side-empty">选中一条AI回复，看它为什么这么回</p>;
  if (q.isPending) return <Skeleton rows={4} />;
  if (q.error) return <InlineError error={q.error} />;
  const t: TurnTraceView = q.data!;
  return (
    <div className="wb-trace">
      <p>{`模型用了${t.durationMs}毫秒`}</p>
      <p>{`阶段：${t.stageBefore ?? '—'} → ${t.stageAfter ?? '—'}`}</p>
      <TechDetails
        rows={[
          ['SOP版本', String(t.sopVersion ?? '—')],
          ['前缀哈希', t.prefixHash],
          ['产品库版本', JSON.stringify(t.catalogVersions)],
        ]}
        json={{ calls: t.calls, llm: t.llm, signals: t.signals, draft: t.draft, finalText: t.finalText }}
      />
    </div>
  );
}

function QuickRepliesCard({ id, onInsert }: { id: string; onInsert: (body: string) => void }) {
  const q = useQuery({
    queryKey: [...CONV_PREFIX, 'quickReplies', id] as const,
    queryFn: () => unwrap(api['quick-replies'].$get()),
  });
  const items: readonly QuickReply[] = q.data?.items ?? [];
  return (
    <div className="wb-card">
      <h3 className="wb-card-title">快捷回复</h3>
      {items.length === 0 ? (
        <p className="wb-side-empty">还没有快捷回复</p>
      ) : (
        <ul className="wb-quick-list">
          {items.map((r) => (
            <li key={r.id}>
              <button type="button" className="wb-quick-btn" onClick={() => onInsert(r.body)}>
                {cjk(r.title)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- 对话栏 + 右栏：整合 ----------------

function Detail({ id, pack, me }: { id: string; pack: IndustryPack; me: { userId: string | null; role: Role; displayName: string } }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const viewer = useViewer().data;
  const q = useQuery(conversationDetailQuery(id));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [showSteps, setShowSteps] = useState(false);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'side' | 'trace'>('side');
  const [earlier, setEarlier] = useState<MessageView[]>([]);
  const [earlierHasMore, setEarlierHasMore] = useState<boolean | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [copied, setCopied] = useState(false);
  const [pendingSeqs, setPendingSeqs] = useState<ReadonlySet<number>>(new Set());
  // 同一次composing 沿用同一个 clientId（02 spec：「失败就地显示并可重试」、plan 实施记录「clientId 重试沿用」）：
  // 发成功、换了会话、或把输入框清空重新开始，才换一个新的；重试同一段没发出去的文字时沿用这个，服务端按它去重
  const clientIdRef = useRef<string | null>(null);
  const idRef = useRef(id);
  useEffect(() => {
    if (idRef.current === id) return;
    idRef.current = id;
    setEarlier([]);
    setEarlierHasMore(null);
    setSelectedTurnId(null);
    setRightTab('side');
    setReplyText('');
    clientIdRef.current = null;
  }, [id]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const stepsQ = useQuery({
    queryKey: [...CONV_PREFIX, 'turns', id] as const,
    queryFn: () => unwrap(api.conversations[':id'].turns.$get({ param: { id } })),
    enabled: showSteps,
  });

  const invalidate = (): void => void qc.invalidateQueries({ queryKey: CONV_PREFIX });

  const takeover = useMutation({
    mutationFn: (force: boolean) => unwrap(api.conversations[':id'].takeover.$post({ param: { id }, json: force ? { force: true } : {} })),
    onSuccess: invalidate,
  });
  const release = useMutation({
    mutationFn: () => unwrap(api.conversations[':id'].release.$post({ param: { id } })),
    onSuccess: invalidate,
  });
  const reply = useMutation({
    mutationFn: ({ text, clientId }: { text: string; clientId: string }) =>
      unwrap(api.conversations[':id'].reply.$post({ param: { id }, json: { text, clientId } })),
    onSuccess: invalidate,
  });
  const confirmOrder = useMutation({
    mutationFn: (orderId: string) => unwrap(api.orders[':id'].confirm.$post({ param: { id: orderId } })),
    onSuccess: invalidate,
  });
  const markPaid = useMutation({
    mutationFn: (orderId: string) => unwrap(api.orders[':id']['mark-paid'].$post({ param: { id: orderId } })),
    onSuccess: invalidate,
  });
  const cancelOrder = useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason: string }) =>
      unwrap(api.orders[':id'].cancel.$post({ param: { id: orderId }, json: { reason } })),
    onSuccess: invalidate,
  });
  const loadEarlier = useMutation({
    mutationFn: (beforeSeq: number) =>
      unwrap(api.conversations[':id'].messages.$get({ param: { id }, query: { beforeSeq: String(beforeSeq), limit: '50' } })),
  });

  const sv = shellViewerOf(viewer);
  const label = q.data ? conversationLabel(q.data.row, pack).join(' · ') : '会话工作台';
  useDocumentTitle(sv ? documentTitle([label, '会话工作台'], sv) : label);

  const back = (): void => void navigate({ to: '/conversations' });

  // combined 用 useMemo：不能放在下面「!q.data 时提前 return」之后——那样这个 Hook 只在数据到手以后才调用，
  // 两次渲染调用的 Hook 数量不一样，React 会报「Rendered more hooks than during the previous render」
  const detailMessages = q.data?.messages;
  const combined = useMemo(() => {
    const byKey = new Map<number, MessageView>();
    for (const m of earlier) byKey.set(m.seq, m);
    for (const m of detailMessages ?? []) byKey.set(m.seq, m);
    return [...byKey.values()].sort((a, b) => a.seq - b.seq);
  }, [earlier, detailMessages]);

  if (!q.data) {
    return (
      <div className="wb-conv">
        <StateView pending={q.isPending} error={q.error} onRetry={() => void q.refetch()} onBack={back} skeleton={<Skeleton rows={6} />} />
      </div>
    );
  }
  const detail = q.data;
  const hasEarlier = earlierHasMore ?? detail.hasEarlier;
  // 输入框只在「这个会话现在的接手人就是我」时可用（spec「J 页」：接手之前禁用，接手后可用）。detail.can.reply
  // 由服务端算，handles && (!cur || mine)——没有接手人时也是 true（reply() 支持隐式接手，后端行为没错），但界面
  // 不能靠它判断「是不是已经点过接手会话」，要另外比「当前接手人」与登录成员是不是同一个人（审查 major 第 1 条）
  const mine = detail.row.assignee != null && detail.row.assignee.userId === me.userId;
  const canReply = detail.can.reply && mine;

  const onLoadEarlier = (): void => {
    const first = combined[0];
    if (!first) return;
    loadEarlier.mutate(first.seq, {
      onSuccess: (page) => {
        setEarlier((prev) => [...page.messages, ...prev]);
        setEarlierHasMore(page.hasEarlier);
      },
    });
  };

  const copyLink = (): void => {
    const href = `${window.location.origin}${window.location.pathname}`;
    void navigator.clipboard?.writeText(href).then(
      () => setCopied(true),
      () => {},
    );
  };

  return (
    <>
      <div className="wb-conv">
        <ConversationHead
          cd={detail}
          pack={pack}
          now={now}
          handles={CAN_HANDLE_ROLES.has(me.role)}
          onTakeover={() => takeover.mutate(false)}
          onReassign={() => setReassignOpen(true)}
          onRelease={() => release.mutate()}
          onCopyLink={copyLink}
          copied={copied}
          takeoverError={takeover.error}
          releaseError={release.error}
        />
        <label className="wb-steps-toggle">
          <Switch checked={showSteps} onChange={setShowSteps} />
          显示AI步骤
        </label>
        <MessageList
          id={id}
          messages={combined}
          hasEarlier={hasEarlier}
          onLoadEarlier={onLoadEarlier}
          loadingEarlier={loadEarlier.isPending}
          showSteps={showSteps}
          steps={stepsQ.data}
          canTraces={detail.can.traces}
          selectedTurnId={selectedTurnId}
          onSelectTurn={(turnId) => {
            setSelectedTurnId(turnId);
            setRightTab('trace');
          }}
          pendingSeqs={pendingSeqs}
        />
        {detail.handoffCard && <HandoffCard handoffCard={detail.handoffCard} pack={pack} />}
        <ReplyBox
          canReply={canReply}
          sendWindow={sendWindowView(detail.sendWindow, now)}
          text={replyText}
          onChangeText={(t) => {
            // 输入框清空重新开始：换一个新的 clientId（不是在重试刚才那条）
            if (t === '') clientIdRef.current = null;
            setReplyText(t);
          }}
          onSend={(text) => {
            const clientId = clientIdRef.current ?? (clientIdRef.current = crypto.randomUUID());
            reply.mutate(
              { text, clientId },
              {
                onSuccess: (result) => {
                  setReplyText('');
                  clientIdRef.current = null;
                  if (!result.persisted) {
                    setPendingSeqs((prev) => new Set(prev).add(result.seq));
                    setTimeout(() => setPendingSeqs((prev) => new Set([...prev].filter((s) => s !== result.seq))), 8_000);
                  }
                },
                // 失败（409、503）：文字与 clientId 都留着，旁边的 InlineError 就地显示，点「发送」原样重试
              },
            );
          }}
          sending={reply.isPending}
          replyError={reply.error}
        />
      </div>
      <div className="wb-side">
        {detail.can.traces && (
          <div className="wb-side-tabs" role="tablist" aria-label="客户与交接">
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'side'}
              className="wb-side-tab"
              onClick={() => setRightTab('side')}
            >
              客户与交接
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'trace'}
              className="wb-side-tab"
              onClick={() => setRightTab('trace')}
            >
              AI为什么这么回
            </button>
          </div>
        )}
        {rightTab === 'trace' && detail.can.traces ? (
          <TraceTab id={id} turnId={selectedTurnId} />
        ) : (
          <>
            <div className="wb-card">
              <h3 className="wb-card-title">需求</h3>
              <p>{cjk(needLine(detail.need, now))}</p>
            </div>
            <div className="wb-card">
              <h3 className="wb-card-title">最近报价</h3>
              <p>{detail.quote ? cjk(quoteLine(detail.quote)) : '还没有报价'}</p>
            </div>
            <div className="wb-card">
              <h3 className="wb-card-title">订单与付款</h3>
              {detail.orders.length === 0 ? (
                <p className="wb-side-empty">还没有订单</p>
              ) : (
                detail.orders.map((o) => (
                  <OrderRow
                    key={o.id}
                    o={o}
                    canConfirm={detail.can.confirmOrder}
                    canMarkPaid={detail.can.markPaid}
                    onConfirm={() => confirmOrder.mutate(o.id)}
                    onMarkPaid={() => markPaid.mutate(o.id)}
                    onCancel={(reason) => cancelOrder.mutate({ orderId: o.id, reason })}
                    confirmError={confirmOrder.error}
                    markPaidError={markPaid.error}
                    cancelError={cancelOrder.error}
                  />
                ))
              )}
            </div>
            {detail.handoffCard && (
              <div className="wb-card">
                <h3 className="wb-card-title">转人工</h3>
                <p>{`原因：${detail.handoffCard.reason}`}</p>
                <p>{`时间：${clockTime(detail.handoffCard.at)}`}</p>
                <p>{`由谁处理：${detail.handoffCard.assigneeName ?? '还没人接手'}`}</p>
              </div>
            )}
            <QuickRepliesCard id={id} onInsert={(body) => setReplyText((t) => (t ? `${t}\n${body}` : body))} />
          </>
        )}
      </div>
      <ActionConfirm
        open={reassignOpen}
        title="改由我处理？"
        confirmText="改由我处理"
        onCancel={() => setReassignOpen(false)}
        onConfirm={() =>
          new Promise<void>((resolve) => {
            takeover.mutate(true, {
              onSettled: () => {
                setReassignOpen(false);
                resolve();
              },
            });
          })
        }
      >
        <p>{`这个会话现在由${detail.row.assignee?.name ?? '别人'}处理，改派之后接手人变成你，${detail.row.assignee?.name ?? '对方'}不会再收到提醒。`}</p>
      </ActionConfirm>
    </>
  );
}

function MemberWorkbench({ pack }: { pack: IndustryPack }) {
  const { id } = useParams({ from: '/conversations/$id' });
  const viewer = useViewer().data;
  const me =
    viewer?.kind === 'member'
      ? { userId: viewer.me.userId, role: viewer.me.role, displayName: viewer.me.displayName }
      : { userId: null, role: 'viewer' as Role, displayName: '' };
  return (
    <div className="wb-root">
      <WbListColumn pack={pack} selectedId={id} />
      <Detail id={id} pack={pack} me={me} />
    </div>
  );
}

export function WorkbenchPage() {
  const viewer = useViewer().data;
  const pack = usePack();
  if (!pack) return null;
  if (viewer?.kind === 'member') return <MemberWorkbench pack={pack} />;
  return (
    <div className="wb-root wb-root-empty">
      <EmptyBlock
        level={1}
        icon={<Icon of={MessagesSquare} size={20} />}
        title="登录后才能看会话"
        description={`会话里有${pack.vocabulary.customer}的信息，只给成员看`}
      />
    </div>
  );
}
