import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Button, Input } from 'antd';
import { useEffect, useState } from 'react';
import type { ChannelView, MemberView, OrganizationView } from '../../../src/shared/console-api.js';
import { ROLE_LABEL } from '../../../src/shared/ui-labels.js';
import { absoluteTime, fullTime } from '../../../src/shared/format.js';
import { HttpError } from '../api.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk, Sep } from '../typography.js';
import { useViewer } from '../viewer.js';
import { SettingsAccess } from './Access.js';
import { canReadSettings, SETTINGS_PAGES, settingsIdentity, type SettingsPageKey } from './model.js';
import { settingsQuery } from './queries.js';
import { UsagePage } from './UsagePage.js';

export function Organization({ value, packName }: { value: OrganizationView; packName: string }) {
  return (
    <section className="settings-section" aria-label="企业信息">
      <dl className="settings-details">
        <dt>企业名称</dt>
        <dd>{value.name}</dd>
        <dt>企业标识</dt>
        <dd>{value.slug}</dd>
        <dt>行业包</dt>
        <dd>{packName}</dd>
        <dt>企业状态</dt>
        <dd>{{ trial: '试用中', active: '使用中', suspended: '已停用' }[value.status]}</dd>
        <dt>已发布品牌</dt>
        <dd>{value.publishedBrandName ?? value.name}</dd>
      </dl>
      {value.pendingBrandChange && <p role="status">{cjk('品牌变更待发布，当前仍使用已发布品牌')}</p>}
      <p className="settings-help">{cjk('企业信息由平台维护，如需修改请联系平台')}</p>
    </section>
  );
}
export function Members({ items }: { items: MemberView[] }) {
  const [filter, setFilter] = useState('');
  const shown = items.filter((m) =>
    `${m.displayName} ${m.email} ${ROLE_LABEL[m.role]}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  return (
    <section aria-label="成员列表">
      <Input
        aria-label="筛选成员"
        placeholder="搜索姓名、邮箱或角色"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        allowClear
      />
      <p className="settings-help">
        {cjk(items.length <= 1 ? '成员由平台开通，一名成员也可继续使用' : '成员由平台开通，变更角色或停用请联系平台')}
      </p>
      {shown.length === 0 ? (
        <EmptyBlock
          level={2}
          title={filter ? '没有符合条件的成员' : '暂无成员'}
          description={filter ? undefined : '请联系平台开通成员'}
          link={
            filter ? (
              <Button type="link" onClick={() => setFilter('')}>
                清除筛选
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="settings-list">
            {shown.map((m) => (
              <li key={m.userId}>
                <h2>{m.displayName}</h2>
                <p className="settings-email">{m.email}</p>
                <p>
                  {ROLE_LABEL[m.role]}
                  <Sep />
                  {m.disabled ? '已停用' : '使用中'}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
export function Channels({ items }: { items: ChannelView[] }) {
  const [now] = useState(() => Date.now());
  return (
    <section aria-label="接入列表">
      <p className="settings-help">{cjk('接入由平台在维护窗口配置并重启生效，请通过微信发送消息验证收发')}</p>
      {items.length === 0 ? (
        <EmptyBlock level={2} title="还未接入" description="请联系平台开通企业微信接入，再发送消息验证收发" />
      ) : (
        <>
          <ul className="settings-list">
            {items.map((a) => (
              <li key={`${a.source}:${a.key}`}>
                <h2>{a.name}</h2>
                <dl className="settings-details">
                  <dt>类型</dt>
                  <dd>{a.kind === 'wecom' ? '企业微信' : '网页'}</dd>
                  <dt>来源</dt>
                  <dd>{a.source === 'db' ? '租户配置' : '环境配置'}</dd>
                  <dt>配置状态</dt>
                  <dd>{a.enabled ? '已启用' : '未启用'}</dd>
                  <dt>运行状态</dt>
                  <dd>{a.blockedByProfile ? '当前环境未启用' : a.loaded ? '已载入' : '未载入，配置变更需重启'}</dd>
                  <dt>认证信息</dt>
                  <dd>{a.credentialsConfigured ? '已配置' : '未配置'}</dd>
                  <dt>回调路径</dt>
                  <dd>{a.callbackPath ?? '—'}</dd>
                  <dt>最近入站</dt>
                  <dd>
                    {a.lastInboundAt ? (
                      <time dateTime={a.lastInboundAt} title={fullTime(a.lastInboundAt)}>
                        {absoluteTime(a.lastInboundAt, now)}
                      </time>
                    ) : (
                      '暂无可靠入站记录'
                    )}
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
function SettingsData({ page }: { page: SettingsPageKey }) {
  const viewer = useViewer().data;
  // 外层先验证权限，身份改变时按新身份重新挂载。
  if (viewer?.kind !== 'member' || !canReadSettings(viewer)) return null;
  return <SettingsRead page={page} viewer={viewer} />;
}
function SettingsRead({
  page,
  viewer,
}: {
  page: SettingsPageKey;
  viewer: Extract<NonNullable<ReturnType<typeof useViewer>['data']>, { kind: 'member' }>;
}) {
  const query = useQuery(settingsQuery(viewer.me, page));
  return (
    <StateView level={2} pending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {query.data &&
        (page === 'organization' ? (
          <Organization value={query.data as OrganizationView} packName={viewer.pack.name} />
        ) : page === 'members' ? (
          <Members items={(query.data as { items: MemberView[] }).items} />
        ) : page === 'channels' ? (
          <Channels items={(query.data as { items: ChannelView[] }).items} />
        ) : null)}
    </StateView>
  );
}
export function SettingsPage() {
  const viewer = useViewer().data;
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    if (/^(\/console)?\/settings(?:\/|$)/.test(path)) document.getElementById('main')?.focus({ preventScroll: true });
  }, [path]);
  const segment = path.replace(/\/$/, '').split('/').at(-1);
  const page: SettingsPageKey = segment === 'members' || segment === 'channels' || segment === 'usage' ? segment : 'organization';
  if (viewer?.kind !== 'member' || !canReadSettings(viewer))
    return (
      <>
        <PageHeader title="设置" />
        <StateView level={2} error={new HttpError(403, { error: 'forbidden' })} />
      </>
    );
  if (segment !== 'settings' && segment !== 'organization' && segment !== 'members' && segment !== 'channels' && segment !== 'usage')
    return (
      <>
        <PageHeader title="设置" />
        <EmptyBlock level={2} title="没有这个页面" link={<Link to="/settings">查看企业设置</Link>} />
      </>
    );

  return (
    <>
      <PageHeader title={`${SETTINGS_PAGES[page]}设置`} />
      <SettingsAccess identity={settingsIdentity(viewer.me)}>
        <nav className="settings-tabs" aria-label="设置页面">
          {Object.entries(SETTINGS_PAGES).map(([key, label]) => (
            <Link key={key} to="/settings/$page" params={{ page: key }} aria-current={key === page ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        {page === 'usage' ? (
          <UsagePage key={settingsIdentity(viewer.me)} me={viewer.me} />
        ) : (
          <SettingsData key={`${settingsIdentity(viewer.me)}/${page}`} page={page} />
        )}
      </SettingsAccess>
    </>
  );
}
