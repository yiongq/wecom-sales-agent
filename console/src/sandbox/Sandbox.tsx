// 05 第 24 步：同一外壳里的体验提示与清单。完成度只读 /me，不在浏览器推断。
import { Button, Modal } from 'antd';
import { CircleCheck, Info, MessageSquare, PanelRightClose } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { SANDBOX_DATA_COPY } from '../../../src/shared/entry-ui.js';
import type { Me } from '../../../src/shared/console-api.js';
import { HttpError } from '../api.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { Skeleton } from '../parts/StateView.js';
import { csrfHeader, sessionFetch } from '../session.js';
import { cjk } from '../typography.js';
import { Icon } from '../shell/icons.js';
import { WechatStep } from './WechatStep.js';

export type SandboxInfo = NonNullable<Me['sandbox']>;

export const simulatorHref = (id?: string): string | null =>
  id === undefined ? '/chat.html' : id.startsWith('sbx-') ? `/chat.html?c=${encodeURIComponent(id)}` : null;

export function SimulatorLink({ id }: { id: string }) {
  const href = simulatorHref(id);
  return href ? (
    <Button size="small" icon={<Icon of={MessageSquare} size={14} />} href={href} target="_blank" rel="noopener noreferrer">
      在模拟器里打开
    </Button>
  ) : null;
}

export function remainingTime(expiresAt: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
  if (!Number.isFinite(minutes)) return '剩余时间暂不可用';
  if (minutes === 0) return '体验已到期';
  return minutes >= 60 ? `还剩${Math.ceil(minutes / 60)}小时` : `还剩${minutes}分钟`;
}

const ChecklistContext = createContext<{ collapsed: boolean; toggle: () => void } | null>(null);

export function SandboxControls({ slug, children }: { slug: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(slug));
  const toggle = () =>
    setCollapsed((previous) => {
      writeCollapsed(slug, !previous);
      return !previous;
    });
  return <ChecklistContext.Provider value={{ collapsed, toggle }}>{children}</ChecklistContext.Provider>;
}

export function wechatCopy(wechat: SandboxInfo['wechat']): string {
  return wechat === 'unbound'
    ? '扫码后，回复只发到你自己的微信'
    : wechat === 'bound'
      ? '已连上你的微信，回复只发给它'
      : '回复只出现在网页模拟器里';
}

export function SandboxBanner({ sandbox }: { sandbox: SandboxInfo }) {
  const [now, setNow] = useState(Date.now);
  const [confirm, setConfirm] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const checklist = useContext(ChecklistContext);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const end = async (): Promise<void> => {
    setError(null);
    try {
      const res = await sessionFetch('/api/sandbox/end', { method: 'POST', headers: csrfHeader() });
      if (!res.ok) throw new HttpError(res.status, await res.json());
      window.location.replace('/try?ended=1');
    } catch (e) {
      setConfirm(false);
      setError(e);
    }
  };
  return (
    <section className="sandbox-banner" aria-label="体验环境">
      <div className="sandbox-banner-row">
        <div className="sandbox-banner-copy">
          <Icon of={Info} size={16} />
          <strong>体验环境</strong>
          <span>
            · {remainingTime(sandbox.expiresAt, now)}
            <span className="sandbox-wechat-summary"> · {wechatCopy(sandbox.wechat)}</span>
          </span>
          <button className="sandbox-data-link" onClick={() => setDataOpen(true)}>
            数据怎么处理
          </button>
        </div>
        <div className="sandbox-banner-actions">
          <Button size="small" icon={<Icon of={MessageSquare} size={14} />} href="/chat.html" target="_blank" rel="noopener noreferrer">
            打开模拟器
          </Button>
          {checklist?.collapsed && (
            <Button size="small" type="text" onClick={checklist.toggle}>
              体验清单{sandbox.steps.filter(Boolean).length}/4
            </Button>
          )}
          <Button size="small" type="text" onClick={() => setConfirm(true)}>
            结束体验
          </Button>
        </div>
      </div>
      {error !== null && <ErrorAlert error={error} onRetry={() => void end()} />}
      <Modal open={dataOpen} title="体验数据怎么处理" footer={null} onCancel={() => setDataOpen(false)}>
        {SANDBOX_DATA_COPY.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </Modal>
      <ConfirmDanger
        open={confirm}
        title="结束这次体验？"
        confirmText="结束并删除"
        cancelText="继续体验"
        onCancel={() => setConfirm(false)}
        onConfirm={end}
      >
        <ul className="sandbox-end-effects">
          <li>环境和里面的数据马上删除，不能恢复</li>
          <li>绑定的微信同时解除，之后再发消息不会有回复</li>
          <li>企业微信服务器上的聊天记录，按企业微信的规则保存</li>
        </ul>
      </ConfirmDanger>
    </section>
  );
}

const storageKey = (slug: string): string => `sandbox-checklist:v1:${slug}`;
export function readCollapsed(slug: string): boolean {
  try {
    return localStorage.getItem(storageKey(slug)) === '1';
  } catch {
    return false;
  }
}
export function writeCollapsed(slug: string, collapsed: boolean): void {
  try {
    localStorage.setItem(storageKey(slug), collapsed ? '1' : '0');
  } catch {
    /* 禁用存储时仍可在当前页收起 */
  }
}

export function SandboxChecklist({
  slug,
  sandbox,
  pending = false,
  error,
  onRetry,
}: {
  slug: string;
  sandbox: SandboxInfo;
  pending?: boolean;
  error?: unknown;
  onRetry: () => void;
}) {
  const [localCollapsed, setCollapsed] = useState(() => readCollapsed(slug));
  const controls = useContext(ChecklistContext);
  const collapsed = controls?.collapsed ?? localCollapsed;
  const current = sandbox.steps.findIndex((step) => !step);
  const done = sandbox.steps.filter(Boolean).length;
  const items = [
    {
      title: sandbox.wechat === 'off' || sandbox.wechat === 'full' ? '打开模拟器发一句' : '用微信扫码，当一回客户',
      description: '',
      href: '',
      action: '',
    },
    {
      title: '看AI怎么接待、报价',
      description:
        sandbox.wechat === 'off' || sandbox.wechat === 'full'
          ? '在模拟器里问一句，看AI怎么推荐、报价。'
          : '在微信里问一句，看AI怎么推荐、报价。',
      href: sandbox.conversationId ? `/console/conversations/${encodeURIComponent(sandbox.conversationId)}` : '/chat.html',
      action: sandbox.conversationId ? '查看这段会话' : '打开模拟器',
    },
    {
      title: '接手会话，自己回一句',
      description:
        sandbox.wechat === 'off' || sandbox.wechat === 'full'
          ? '接手一个会话，模拟器里马上收到顾问回复。'
          : '接手微信会话，微信里马上收到顾问回复。',
      href: '/console/conversations',
      action: '去接手会话',
    },
    {
      title: '改价、标已付或改话术',
      description: '任选一项：改产品价格、标记已付，或改话术并发布。',
      href: '/console/sop',
      action: '修改话术',
    },
  ];
  return (
    <aside className={`sandbox-checklist${collapsed ? ' is-collapsed' : ''}`} aria-label="体验清单">
      <div className="sandbox-checklist-head">
        <h2>
          体验清单<span>{done}/4</span>
        </h2>
        <Button
          size="small"
          aria-expanded={!collapsed}
          aria-controls="sandbox-checklist-steps"
          onClick={() => {
            if (controls) {
              controls.toggle();
              return;
            }
            const next = !collapsed;
            setCollapsed(next);
            writeCollapsed(slug, next);
          }}
          type="text"
          aria-label={collapsed ? '展开体验清单' : '收起体验清单'}
          icon={<Icon of={PanelRightClose} size={16} />}
        >
          {collapsed ? '展开' : '收起'}
        </Button>
      </div>
      <div id="sandbox-checklist-steps" hidden={collapsed}>
        {pending ? (
          <div role="status" aria-label="正在载入体验进度">
            <Skeleton rows={4} />
          </div>
        ) : error ? (
          <ErrorAlert error={error} title="没取到体验进度" onRetry={onRetry} />
        ) : (
          <>
            <p className="sandbox-checklist-intro">照着走一遍，大约5分钟</p>
            <ol>
              {items.map((item, i) => (
                <li key={item.title} className={`${sandbox.steps[i] ? 'is-done' : ''}${i === current ? ' is-current' : ''}`}>
                  <div className="sandbox-step-heading">
                    <span className="sandbox-step-mark" aria-label={sandbox.steps[i] ? '已完成' : '未完成'}>
                      {sandbox.steps[i] ? <Icon of={CircleCheck} size={20} /> : i + 1}
                    </span>
                    <h3>{item.title}</h3>
                  </div>
                  {i === 0 ? (
                    <div className="sandbox-step-content" hidden={i !== current && sandbox.wechat !== 'bound'}>
                      <WechatStep
                        key={`${slug}:${sandbox.wechat}`}
                        wechat={sandbox.wechat}
                        expanded={!collapsed && (i === current || sandbox.wechat === 'bound')}
                      />
                    </div>
                  ) : i === current ? (
                    <div className="sandbox-step-content">
                      <p>{cjk(item.description)}</p>
                      <Button size="small" href={item.href}>
                        {item.action}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
            {done === 4 && <p role="status">四步已完成，你可以继续体验。</p>}
          </>
        )}
      </div>
    </aside>
  );
}
