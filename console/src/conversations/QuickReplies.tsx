// 快捷回复卡片与管理抽屉（02 spec「后台页面 · 会话工作台（J 页）」「快捷回复管理」，plan 第 22 步）。
// 卡片：J 页右栏，读列表、点一条插进输入框（第 20.2 步已做）。
// 抽屉：卡片的「管理」打开，设计系统 §5.13 M 480——列表（标题、正文摘要、上移/下移/编辑/归档）、新建与编辑表单
// （标题、正文，正文不许 markdown，保存时前后端都查一遍同一份 hasMarkdown）、归档的二次确认（ConfirmDanger：归档后
// 不会再出现在插入列表，也没有「取消归档」）。Esc 关闭、关闭后焦点回到「管理」按钮：在关上之后的 plain effect 里还、
// 不等抽屉的收起动画（同 SOP 发布抽屉 SopPage.tsx 的既有做法——动画完成的回调 afterOpenChange 不可靠，这里不靠它）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Drawer, Input } from 'antd';
import { Archive, ArrowDown, ArrowUp, SquarePen, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { hasMarkdown, QUICK_REPLY_MARKDOWN_MSG } from '../../../src/shared/console-api.js';
import type { QuickReply } from '../../../src/shared/console-api.js';
import { api, unwrap } from '../api.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { errorLine } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { IconButton } from '../shell/IconButton.js';
import { cjk } from '../typography.js';
import { QUICK_REPLIES_KEY } from './workbench.js';

/** 就地的一行出错说明，同 WorkbenchPage 的 InlineError：不用 toast，不读 .detail */
function InlineError({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const { text } = errorLine(error, {});
  return <p className="wb-inline-error">{text}</p>;
}

export function QuickRepliesCard({ onInsert, canManage }: { onInsert: (body: string) => void; canManage: boolean }) {
  const manageBtnRef = useRef<HTMLButtonElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (drawerOpen) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      manageBtnRef.current?.focus();
    }
  }, [drawerOpen]);
  const q = useQuery({ queryKey: QUICK_REPLIES_KEY, queryFn: () => unwrap(api['quick-replies'].$get()) });
  const items: readonly QuickReply[] = q.data?.items ?? [];
  return (
    <div className="wb-card">
      <div className="wb-card-head">
        <h3 className="wb-card-title">快捷回复</h3>
        {canManage && (
          <Button ref={manageBtnRef} size="small" type="text" onClick={() => setDrawerOpen(true)}>
            管理
          </Button>
        )}
      </div>
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
      {canManage && <QuickRepliesDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
    </div>
  );
}

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; item: QuickReply };

function QuickRepliesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [archiving, setArchiving] = useState<QuickReply | null>(null);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QUICK_REPLIES_KEY, queryFn: () => unwrap(api['quick-replies'].$get()), enabled: open });
  const items: readonly QuickReply[] = q.data?.items ?? [];
  const invalidate = (): Promise<void> => qc.invalidateQueries({ queryKey: QUICK_REPLIES_KEY });

  const create = useMutation({
    mutationFn: (b: { title: string; body: string }) => unwrap(api['quick-replies'].$post({ json: b })),
    onSuccess: async () => {
      await invalidate();
      setView({ kind: 'list' });
    },
  });
  const update = useMutation({
    mutationFn: (b: { id: string; title: string; body: string }) =>
      unwrap(api['quick-replies'][':id'].$patch({ param: { id: b.id }, json: { title: b.title, body: b.body } })),
    onSuccess: async () => {
      await invalidate();
      setView({ kind: 'list' });
    },
  });
  const move = useMutation({
    mutationFn: (b: { id: string; direction: 'up' | 'down' }) =>
      unwrap(api['quick-replies'][':id'].move.$post({ param: { id: b.id }, json: { direction: b.direction } })),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) => unwrap(api['quick-replies'][':id'].archive.$post({ param: { id } })),
    onSuccess: invalidate,
  });

  const closeAll = (): void => {
    setView({ kind: 'list' });
    setArchiving(null);
    onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={closeAll}
      destroyOnHidden
      focusable={{ focusTriggerAfterClose: false }}
      size={480}
      closable={false}
      title={cjk('快捷回复')}
      extra={<IconButton icon={X} label="关闭" tip="关闭" placement="bottomRight" onClick={closeAll} />}
      rootClassName="wb-qr-drawer"
    >
      <div className="wb-qr-scroll">
        {view.kind === 'list' ? (
          <>
            <div className="wb-qr-toolbar">
              <PrimaryButton size="small" onClick={() => setView({ kind: 'create' })}>
                新建
              </PrimaryButton>
            </div>
            {q.isPending ? (
              <p className="wb-side-empty">加载中…</p>
            ) : q.error ? (
              <InlineError error={q.error} />
            ) : items.length === 0 ? (
              <p className="wb-side-empty">还没有快捷回复，点右上角「新建」加一条</p>
            ) : (
              <ul className="wb-qr-list">
                {items.map((r, i) => (
                  <li key={r.id} className="wb-qr-row">
                    <div className="wb-qr-row-main">
                      <p className="wb-qr-row-title">{cjk(r.title)}</p>
                      <p className="wb-qr-row-body">{cjk(r.body)}</p>
                    </div>
                    <div className="wb-qr-row-actions">
                      <IconButton
                        icon={ArrowUp}
                        label="上移"
                        size={28}
                        disabled={i === 0 || move.isPending}
                        onClick={() => move.mutate({ id: r.id, direction: 'up' })}
                      />
                      <IconButton
                        icon={ArrowDown}
                        label="下移"
                        size={28}
                        disabled={i === items.length - 1 || move.isPending}
                        onClick={() => move.mutate({ id: r.id, direction: 'down' })}
                      />
                      <IconButton icon={SquarePen} label="编辑" size={28} onClick={() => setView({ kind: 'edit', item: r })} />
                      <IconButton icon={Archive} label="归档" size={28} onClick={() => setArchiving(r)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <InlineError error={move.error} />
            <InlineError error={archive.error} />
          </>
        ) : (
          <QuickReplyForm
            initial={view.kind === 'edit' ? view.item : null}
            busy={create.isPending || update.isPending}
            error={view.kind === 'edit' ? update.error : create.error}
            onCancel={() => setView({ kind: 'list' })}
            onSubmit={(b) => (view.kind === 'edit' ? update.mutate({ id: view.item.id, ...b }) : create.mutate(b))}
          />
        )}
      </div>
      <ConfirmDanger
        open={archiving !== null}
        title={`归档「${archiving?.title ?? ''}」？`}
        confirmText="归档"
        cancelText="留着"
        focusTriggerAfterClose={false}
        onCancel={() => setArchiving(null)}
        onConfirm={async () => {
          const id = archiving!.id;
          setArchiving(null);
          await archive.mutateAsync(id);
        }}
      >
        归档之后不会再出现在插入列表里，这里也没有「取消归档」。
      </ConfirmDanger>
    </Drawer>
  );
}

/** 新建或编辑的表单：标题、正文；正文不许 markdown，前端先查一遍（同服务端 QuickReplyBody 的那份 hasMarkdown），
 * 过了才提交，省一次往返；服务端的校验照样跑（防的是绕过前端直接打接口） */
function QuickReplyForm({
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  initial: QuickReply | null;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (b: { title: string; body: string }) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [touched, setTouched] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const bodyHelpId = useId();
  const markdownBad = hasMarkdown(body);
  const titleBad = title.trim() === '';
  const bodyBad = body.trim() === '' || markdownBad;
  const blocked = titleBad || bodyBad;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setTouched(true);
    if (blocked || busy) return;
    onSubmit({ title: title.trim(), body });
  };
  return (
    <form onSubmit={submit}>
      <InlineError error={error} />
      <div className="wb-qr-field">
        <label htmlFor={titleId} className="wb-qr-label">
          {cjk('标题')}
        </label>
        <Input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={20} placeholder="例：问出行日期" />
        {touched && titleBad && <p className="wb-qr-help is-error">{cjk('标题不能为空')}</p>}
      </div>
      <div className="wb-qr-field">
        <label htmlFor={bodyId} className="wb-qr-label">
          {cjk('正文')}
        </label>
        <Input.TextArea
          id={bodyId}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={500}
          aria-describedby={bodyHelpId}
        />
        {touched && markdownBad ? (
          <p id={bodyHelpId} className="wb-qr-help is-error">
            {cjk(QUICK_REPLY_MARKDOWN_MSG)}
          </p>
        ) : touched && bodyBad ? (
          <p id={bodyHelpId} className="wb-qr-help is-error">
            {cjk('正文不能为空')}
          </p>
        ) : (
          <p id={bodyHelpId} className="wb-qr-help">
            {cjk('客户在企业微信里看到的就是这段文字，不能用Markdown格式')}
          </p>
        )}
      </div>
      <div className="wb-qr-form-actions">
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <PrimaryButton htmlType="submit" loading={busy} blocked={touched && blocked}>
          保存
        </PrimaryButton>
      </div>
    </form>
  );
}
