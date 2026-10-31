// 15 R9：状态只读真实设置接口，点击与本地收起均不改变完成状态。
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from 'antd';
import { useState } from 'react';
import type { Me, OnboardingKey, OnboardingView } from '../../../src/shared/console-api.js';
import { ONBOARDING_HREFS } from '../../../src/shared/console-api.js';
import { StateView } from '../parts/StateView.js';
import { SettingsAccess } from '../settings/Access.js';
import { canReadSettings, settingsIdentity } from '../settings/model.js';
import { settingsQuery } from '../settings/queries.js';
import { cjk } from '../typography.js';
import { useViewer } from '../viewer.js';

const LABELS: Record<OnboardingKey, string> = { team: '查看成员', catalog: '准备产品库', sop: '发布销售话术', channel: '验证接入收发' };
const STATES = { todo: '待完成', done: '已完成', blocked: '需要平台协助' } as const;
function StepLink({ step }: { step: OnboardingView['steps'][number] }) {
  // 后端只输出批准的同源路径；前端仍显式转为路由链接，不接收外部地址。
  if (step.key === 'team')
    return (
      <Link to="/settings/$page" params={{ page: 'members' }}>
        {LABELS.team}
      </Link>
    );
  if (step.key === 'channel')
    return (
      <Link to="/settings/$page" params={{ page: 'channels' }}>
        {LABELS.channel}
      </Link>
    );
  if (step.key === 'sop' || step.href === ONBOARDING_HREFS.sop) return <Link to="/sop">{LABELS[step.key]}</Link>;
  const kind = step.href.startsWith('/console/catalog/') ? step.href.slice('/console/catalog/'.length) : '';
  return kind ? (
    <Link to="/catalog/$kind" params={{ kind: decodeURIComponent(kind) }}>
      {LABELS.catalog}
    </Link>
  ) : null;
}
function Checklist({ me, catalogKind }: { me: Me; catalogKind?: string }) {
  const query = useQuery(settingsQuery(me, 'onboarding'));
  const fallback: OnboardingView['steps'] = [
    { key: 'team', state: 'todo', href: ONBOARDING_HREFS.team },
    ...(catalogKind
      ? [{ key: 'catalog' as const, state: 'todo' as const, href: `/console/catalog/${encodeURIComponent(catalogKind)}` as const }]
      : []),
    { key: 'sop', state: 'todo', href: ONBOARDING_HREFS.sop },
    { key: 'channel', state: 'todo', href: ONBOARDING_HREFS.channel },
  ];
  return (
    <>
      <StateView level={3} pending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {query.data && (
          <>
            {query.data.steps.every((step) => step.state === 'done') && (
              <p className="onboarding-complete" role="status">
                配置已完成
              </p>
            )}
            <ol className="onboarding-list">
              {query.data.steps.map((step) => (
                <li key={step.key} data-state={step.state}>
                  <StepLink step={step} />
                  <span className="onboarding-state">{STATES[step.state]}</span>
                  {step.reason && <p>{cjk(step.reason)}</p>}
                </li>
              ))}
            </ol>
          </>
        )}
      </StateView>
      {query.isError && (
        <div className="onboarding-unknown">
          <p>{cjk('状态暂不可读，仍可查看以下页面')}</p>
          <ul>
            {fallback.map((step) => (
              <li key={step.key}>
                <StepLink step={step} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
function MemberChecklist({ me, catalogKind }: { me: Me; catalogKind?: string }) {
  const preference = `wsa:onboarding:v1:${me.tenantSlug}:${me.userId}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(preference) === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(preference, next ? 'collapsed' : 'expanded');
      } catch {
        /* 本地存储不可用仍可收起 */
      }
      return next;
    });
  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <div className="onboarding-head">
        <h2 id="onboarding-title">新手清单</h2>
        <Button type="text" aria-expanded={!collapsed} aria-controls="onboarding-content" onClick={toggle}>
          {collapsed ? '展开清单' : '收起清单'}
        </Button>
      </div>
      {!collapsed && (
        <div id="onboarding-content">
          <SettingsAccess identity={settingsIdentity(me)}>
            <Checklist me={me} catalogKind={catalogKind} />
          </SettingsAccess>
        </div>
      )}
    </section>
  );
}
export function Onboarding() {
  const viewer = useViewer().data;
  if (viewer?.kind !== 'member' || viewer.me.sandbox) return null;
  if (!canReadSettings(viewer))
    return <p className="onboarding-advisor">{cjk(viewer.me.role === 'viewer' ? '可在会话中查看客户消息' : '可在会话中接手并回复客户')}</p>;
  const kind = viewer.pack.nav.entities.find((key) => viewer.pack.entities.some((entity) => entity.kind === key));
  return <MemberChecklist key={settingsIdentity(viewer.me)} me={viewer.me} catalogKind={kind} />;
}
