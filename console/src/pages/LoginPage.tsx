import { useQueryClient } from '@tanstack/react-query';
import { Card, Typography } from 'antd';
import { LoginForm } from '../LoginForm.js';
import { VIEWER_KEY } from '../viewer.js';

export function LoginPage() {
  const qc = useQueryClient();
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={4}>登录后台</Typography.Title>
        <LoginForm onSuccess={(me) => qc.setQueryData(VIEWER_KEY, { kind: 'member', me })} />
      </Card>
    </div>
  );
}
