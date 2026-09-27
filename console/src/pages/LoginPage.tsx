// 登录页（整页随后台 UX spec 第 15 步重做）。登录成功后重新判断来者：并发取 /me 与 /pack（shell/boot.ts），进成员外壳
import { useQueryClient } from '@tanstack/react-query';
import { Card, Typography } from 'antd';
import { LoginForm } from '../LoginForm.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { VIEWER_KEY } from '../viewer.js';

export function LoginPage() {
  const qc = useQueryClient();
  useDocumentTitle('登录');
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={4}>登录后台</Typography.Title>
        <LoginForm onSuccess={() => void qc.resetQueries({ queryKey: VIEWER_KEY })} />
      </Card>
    </div>
  );
}
