// 05 第 24 步：同一外壳里的体验提示与清单。完成度只读 /me，不在浏览器推断。
import { Button } from 'antd';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Me } from '../../../src/shared/console-api.js';
import { HttpError } from '../api.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { Skeleton } from '../parts/StateView.js';
import { csrfHeader, sessionFetch } from '../session.js';
import { cjk } from '../typography.js';
import { WechatStep } from './WechatStep.js';

export type SandboxInfo = NonNullable<Me['sandbox']>;

export const simulatorHref = (id?: string): string | null =>
  id === undefined ? '/chat.html' : id.startsWith('sbx-') ? `/chat.html?c=${encodeURIComponent(id)}` : null;

export function SimulatorLink({ id }: { id: string }) {
  const href = simulatorHref(id);
  return href ? (
    <Button size="small" href={href} target="_blank" rel="noopener noreferrer">
      在模拟器里打开
    </Button>
  ) : null;
}

export function remainingTime(expiresAt: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
  if (!Number.isFinite(minutes)) return '剩余时间暂不可用';
  if (minutes === 0) return '体验已到期';
  return minutes >= 60 ? `剩余${Math.ceil(minutes / 60)}小时` : `剩余${minutes}分钟`;
}

export function SandboxBanner({ sandbox }: { sandbox: SandboxInfo }) {
  const [now, setNow] = useState(Date.now);
  const [confirm, setConfirm] = useState(false);
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
        <p>
          {cjk([
            '体验环境',
            remainingTime(sandbox.expiresAt, now),
            sandbox.wechat === 'off' || sandbox.wechat === 'full' ? '只进模拟器' : '回复只发到你自己的微信',
          ])}
        </p>
        <div className="sandbox-banner-actions">
          <Button size="small" href="/chat.html" target="_blank" rel="noopener noreferrer">
            打开模拟器
          </Button>
          <Button size="small" onClick={() => setConfirm(true)}>
            结束体验
          </Button>
        </div>
      </div>
      {error !== null && <ErrorAlert error={error} onRetry={() => void end()} />}
      <ConfirmDanger
        open={confirm}
        title="结束这次体验？"
        confirmText="结束体验"
        cancelText="继续体验"
        onCancel={() => setConfirm(false)}
        onConfirm={end}
      >
        这次体验的数据将被删除，无法恢复。
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
  const [collapsed, setCollapsed] = useState(() => readCollapsed(slug));
  const done = sandbox.steps.filter(Boolean).length;
  const items = [
    {
      title: sandbox.wechat === 'off' || sandbox.wechat === 'full' ? '打开模拟器发一句' : '用微信给AI发一句',
      description: '',
      href: '',
      action: '',
    },
    { title: '看AI怎么回、怎么报价', description: '继续对话，让AI给出报价。', href: '/console/conversations', action: '查看会话' },
    {
      title: '点接管，自己回一句',
      description:
        sandbox.wechat === 'off' || sandbox.wechat === 'full'
          ? '接手一个会话，模拟器里马上收到顾问回复。'
          : '接手微信会话，微信里马上收到顾问回复。',
      href: '/console/conversations',
      action: '去接手会话',
    },
    {
      title: '改价、标已付、改SOP',
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
            const next = !collapsed;
            setCollapsed(next);
            writeCollapsed(slug, next);
          }}
          icon={collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
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
            {done === 0 && <p className="sandbox-checklist-intro">从发一句消息开始，完成一项就会点亮一项。</p>}
            <ol>
              {items.map((item, i) => (
                <li key={item.title} className={sandbox.steps[i] ? 'is-done' : ''}>
                  <span className="sandbox-step-mark" aria-label={sandbox.steps[i] ? '已完成' : '未完成'}>
                    {sandbox.steps[i] ? <Check size={14} /> : i + 1}
                  </span>
                  <div>
                    {i !== 0 && <h3>{cjk(item.title)}</h3>}
                    {i === 0 ? (
                      <WechatStep key={`${slug}:${sandbox.wechat}`} wechat={sandbox.wechat} expanded={!collapsed} />
                    ) : (
                      <>
                        <p>{cjk(item.description)}</p>
                        <a href={item.href}>{item.action}</a>
                      </>
                    )}
                  </div>
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
