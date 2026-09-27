// 页头（设计系统 §4.3）：标题 24/32/600、状态句、右侧操作区；同时写标签页标题「页名 · 租户名」（不变量 23）。
// 外壳的两种身份提示也挂在这里，每页都有（spec「外壳」）：
// - 非编辑角色（主管、坐席、只读）：状态句末尾一个「只读」胶囊，悬停说明「你的角色是坐席，只能查看」；编辑类按钮由页面不渲染；
// - demo 匿名：页头下一条 info 横幅（说明不是警告，不用黄色），右侧「去体验对话」「登录后编辑」
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Tooltip } from 'antd';
import type { ReactNode } from 'react';
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
  return (
    <>
      <header className={viewer?.kind === 'anon' ? 'page-header with-banner' : 'page-header'}>
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
