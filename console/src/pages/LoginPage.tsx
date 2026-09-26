import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { api, describe, setCsrf, unwrap } from '../api.js';
import { VIEWER_KEY } from '../viewer.js';

export function LoginPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (values: { email: string; password: string }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(api.auth.login.$post({ json: values }));
      setCsrf(me.csrf);
      qc.setQueryData(VIEWER_KEY, { kind: 'member', me });
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={4}>登录后台</Typography.Title>
        <Form layout="vertical" onFinish={(v: { email: string; password: string }) => void submit(v)}>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '填邮箱' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="口令" rules={[{ required: true, message: '填口令' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          {error && <Typography.Paragraph type="danger">{error}</Typography.Paragraph>}
          <Button type="primary" htmlType="submit" block loading={busy}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
