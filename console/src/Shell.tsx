// 外框：判断来者（成员 / demo 匿名 / 要登录 / 文件模式），成员与匿名进同一个布局；匿名挂「演示只读」横幅、看不到审计入口
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Alert, App, Button, Layout, Menu, Result, Space, Spin, Tag, Typography } from 'antd';
import { api, describe, setCsrf, unwrap } from './api.js';
import { LoginPage } from './pages/LoginPage.js';
import { canEdit, useViewer, VIEWER_KEY } from './viewer.js';

const ROLE_LABEL: Record<string, string> = { owner: '所有者', admin: '管理员', supervisor: '主管', agent: '坐席', viewer: '只读' };

export function Shell() {
  const viewer = useViewer();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const path = useRouterState({ select: (s) => s.location.pathname });

  if (viewer.isPending) return <Spin fullscreen />;
  if (viewer.isError) return <Result status="error" title="后台接口不可用" subTitle={describe(viewer.error)} />;
  const v = viewer.data;
  if (v.kind === 'disabled') {
    return (
      <Result
        status="info"
        title="后台只在数据库模式可用"
        subTitle="服务端现在按文件模式运行（CONFIG_SOURCE 不是 db），SOP 和产品库改 data/ 目录。"
      />
    );
  }
  if (v.kind === 'login') return <LoginPage />;

  const logout = async (): Promise<void> => {
    try {
      await unwrap(api.auth.logout.$post());
    } catch (e) {
      message.error(describe(e));
    }
    setCsrf('');
    qc.clear();
    await qc.invalidateQueries({ queryKey: VIEWER_KEY });
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
    ...(canEdit(v) ? [{ key: '/audit', label: <Link to="/audit">审计日志</Link> }] : []),
  ];
  const selected = items.map((i) => i.key).filter((k) => path.startsWith(`/console${k}`));

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff' }}>
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
          <Button type="primary" onClick={() => qc.setQueryData(VIEWER_KEY, { kind: 'login' })}>
            登录
          </Button>
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
              description="这里是已发布的 SOP 和已上架的产品，登录之后才能编辑。"
            />
          )}
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

export function NotFound() {
  return <Result status="404" title="没有这个页面" extra={<Link to="/sop">回到 SOP</Link>} />;
}
