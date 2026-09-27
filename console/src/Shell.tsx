// 外框：判断来者（成员 / demo 匿名 / 要登录 / 文件模式），成员与匿名进同一个布局；匿名挂「演示只读」横幅、看不到审计入口。
// 成员身份下挂就地登录框（会话过期时弹出，不卸载页面）；viewer 已经有值时，刷新失败也照旧按原来的身份渲染
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Alert, Button, Layout, Menu, Result, Space, Spin, Tag, Typography } from 'antd';
import { api, unwrap } from './api.js';
import { LoginPage } from './pages/LoginPage.js';
import { PrimaryButton } from './parts/PrimaryButton.js';
import { StateView } from './parts/StateView.js';
import { SessionExpiredDialog } from './SessionExpiredDialog.js';
import { endMemberSession } from './session.js';
import { canEdit, useViewer, VIEWER_KEY } from './viewer.js';

const ROLE_LABEL: Record<string, string> = { owner: '所有者', admin: '管理员', supervisor: '主管', agent: '坐席', viewer: '只读' };

export function Shell() {
  const viewer = useViewer();
  const qc = useQueryClient();
  const path = useRouterState({ select: (s) => s.location.pathname });

  const v = viewer.data;
  if (v === undefined) {
    if (viewer.isPending) return <Spin fullscreen />;
    return (
      <div style={{ maxWidth: 640, margin: '120px auto', padding: '0 16px' }}>
        <StateView error={viewer.error} onRetry={() => void viewer.refetch()} />
      </div>
    );
  }
  if (v.kind === 'disabled') {
    return <Result status="info" title="后台只在数据库模式下可用" />;
  }
  if (v.kind === 'login') return <LoginPage />;

  const logout = async (): Promise<void> => {
    // 先离开成员身份：之后 /me 的 401 是「已退出」，不是会话过期。退出接口失败时不另报错：下面重新判断来者，
    // 服务端的会话还在就照旧是成员
    endMemberSession();
    await unwrap(api.auth.logout.$post()).catch(() => undefined);
    // 不能 clear() 再 invalidate：clear 只把查询拿出缓存、不通知还挂着的 observer，invalidate 又找不到它，页面就停在成员视图。
    // 先拿掉其余查询（草稿、审计这些成员才看得到的），再重置 viewer：Shell 转圈、卸掉页面，重新判断来者（demo 匿名或登录页）
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== VIEWER_KEY[0] });
    await qc.resetQueries({ queryKey: VIEWER_KEY });
  };

  const items = [
    { key: '/sop', label: <Link to="/sop">SOP</Link> },
    {
      key: '/catalog/route',
      label: (
        <Link to="/catalog/$kind" params={{ kind: 'route' }}>
          线路
        </Link>
      ),
    },
    {
      key: '/catalog/hotel',
      label: (
        <Link to="/catalog/$kind" params={{ kind: 'hotel' }}>
          酒店
        </Link>
      ),
    },
    ...(v.kind === 'member' ? [{ key: '/conversations', label: <Link to="/conversations">会话</Link> }] : []),
    ...(canEdit(v) ? [{ key: '/audit', label: <Link to="/audit">审计日志</Link> }] : []),
  ];
  // 路由的 location.pathname 不带 basepath（/console）；带不带都认，按整段比，免得 /catalog/route 认成别的前缀
  const here = path.replace(/^\/console(?=\/|$)/, '');
  const selected = items.map((i) => i.key).filter((k) => here === k || here.startsWith(`${k}/`));

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--panel)' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          后台
        </Typography.Title>
        {v.kind === 'member' ? (
          <Space>
            <span>{v.me.displayName}</span>
            <Tag>{ROLE_LABEL[v.me.role] ?? v.me.role}</Tag>
            <Button onClick={() => void logout()}>退出</Button>
          </Space>
        ) : (
          <PrimaryButton onClick={() => qc.setQueryData(VIEWER_KEY, { kind: 'login' })}>登录</PrimaryButton>
        )}
      </Layout.Header>
      <Layout>
        <Layout.Sider width={180} theme="light">
          <Menu mode="inline" selectedKeys={selected} items={items} />
        </Layout.Sider>
        <Layout.Content style={{ padding: 24 }}>
          {v.kind === 'anon' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="演示只读"
              description="这里是已发布的销售话术和已上架的产品，登录之后才能编辑。"
            />
          )}
          <Outlet />
        </Layout.Content>
      </Layout>
      {v.kind === 'member' && <SessionExpiredDialog />}
    </Layout>
  );
}

export function NotFound() {
  return <Result status="404" title="没有这个页面" extra={<Link to="/sop">回到销售话术</Link>} />;
}
