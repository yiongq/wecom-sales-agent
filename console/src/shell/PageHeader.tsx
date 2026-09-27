// 页头（设计系统 §4.3）：标题 24/32/600、状态句、右侧操作区；同时写标签页标题「页名 · 租户名」（不变量 23）。
// 滚动后缩成吸顶条：还是这一个 header（h1 与操作按钮不复制，读屏和按钮状态都只有一份），贴在面板顶上，高 52、
// 页名 15/22/600、只留操作区，不透明，底部一条 --divider。缩起时用外边距补足原来的高度，下面的内容不跳。
// 页头的父元素要是整页（不要包进 antd Space），吸顶才吸得住。
// 外壳的两种身份提示也挂在这里，每页都有（spec「外壳」）：
// - 非编辑角色（主管、坐席、只读）：状态句末尾一个「只读」胶囊，悬停说明「你的角色是坐席，只能查看」；编辑类按钮由页面不渲染；
// - demo 匿名：页头下一条 info 横幅（说明不是警告，不用黄色），右侧「去体验对话」「登录后编辑」
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Tooltip } from 'antd';
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import type { Role } from '../../../src/shared/console-api.js';
import { Status } from '../parts/Status.js';
import { cjk } from '../typography.js';
import { useViewer, VIEWER_KEY, type Viewer } from '../viewer.js';
import { useDocumentTitle } from './hooks.js';
import { documentTitle, isEditor, ROLE_LABEL, type ShellViewer } from './model.js';

/** 外壳关心的身份；还没判定出来、要登录、文件模式时是 null */
export function shellViewerOf(v: Viewer | undefined): ShellViewer | null {
  if (v?.kind === 'member') return { kind: 'member', me: v.me };
  if (v?.kind === 'anon') return { kind: 'anon' };
  return null;
}

/** 演示里的网页对话（public/chat.html） */
const CHAT_HREF = '/chat.html';

export function ReadOnlyPill({ role }: { role: Role }) {
  const why = `你的角色是${ROLE_LABEL[role]}，只能查看`;
  return (
    <Tooltip title={why} placement="right">
      <span className="readonly-pill" tabIndex={0} role="note" aria-label={`只读：${why}`}>
        <Status kind="readonly" />
      </span>
    </Tooltip>
  );
}

export function AnonBanner({ onLogin }: { onLogin: () => void }) {
  return (
    <Alert
      className="anon-banner"
      type="info"
      showIcon
      title={
        <>
          <span className="anon-banner-lead">{cjk(['演示模式', '只读'])}</span>
          {cjk('：这里配置的销售话术和产品库，直接驱动企业微信里的AI销售。')}
        </>
      }
      action={
        <span className="anon-banner-actions">
          <Button size="small" href={CHAT_HREF} target="_blank" rel="noopener noreferrer">
            去体验对话
          </Button>
          <Button size="small" onClick={onLogin}>
            登录后编辑
          </Button>
        </span>
      }
    />
  );
}

/**
 * 页头有没有滚出面板顶部：盯着页头前面 1px 高的哨兵，它整个到了滚动区顶边以上就是吸住了。
 * 吸住时返回页头原来的高度（缩起前量的），缩起的页头用它补外边距；没吸住是 null。不在外壳的滚动区里（样张页）时一直是 null
 */
function useStuckHeight(sentinel: RefObject<HTMLElement | null>, header: RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    const root = el?.closest('.shell-scroll');
    if (!el || !root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        const above = !e.isIntersecting && e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0);
        const natural = header.current?.offsetHeight ?? null;
        // 已经吸住时 offsetHeight 是缩起后的 52，沿用吸住那一刻量的
        setHeight((cur) => (above ? (cur ?? natural) : null));
      },
      { root },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sentinel, header]);
  return height;
}

export interface PageHeaderProps {
  title: string;
  /** 标签页标题里租户名前面的几段；不给就是 [title]。详情页写「条目名 · 实体名」 */
  docTitle?: readonly string[];
  /** 状态句：一句话，13/20 text-2 */
  status?: ReactNode;
  /** 右侧操作区：「更多」、次要按钮、主按钮（至多一个，放最右） */
  actions?: ReactNode;
}

export function PageHeader({ title, docTitle, status, actions }: PageHeaderProps) {
  const viewer = shellViewerOf(useViewer().data);
  const qc = useQueryClient();
  useDocumentTitle(viewer ? documentTitle(docTitle ?? [title], viewer) : title);
  const readOnlyRole = viewer?.kind === 'member' && !isEditor(viewer) ? viewer.me.role : null;
  const sentinel = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const stuck = useStuckHeight(sentinel, headerRef);
  const cls = ['page-header', viewer?.kind === 'anon' && 'with-banner', stuck !== null && 'is-stuck'].filter(Boolean).join(' ');
  const style = stuck === null ? undefined : ({ '--page-header-h': `${stuck}px` } as CSSProperties);
  return (
    <>
      <div ref={sentinel} className="page-header-sentinel" aria-hidden="true" />
      <header ref={headerRef} className={cls} style={style}>
        <div className="page-header-main">
          <h1 className="page-title">{cjk(title)}</h1>
          {(status || readOnlyRole) && (
            <div className="page-status">
              {status}
              {readOnlyRole && <ReadOnlyPill role={readOnlyRole} />}
            </div>
          )}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {viewer?.kind === 'anon' && <AnonBanner onLogin={() => qc.setQueryData<Viewer>(VIEWER_KEY, { kind: 'login' })} />}
    </>
  );
}
