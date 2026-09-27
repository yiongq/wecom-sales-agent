// 登录表单：登录页和会话过期后的就地登录框共用。出错显示在按钮上方的页内 Alert 里，文案取 ERROR_COPY，不用 toast
import { Form, Input } from 'antd';
import { useState } from 'react';
import type { Me } from '../../src/shared/console-api.js';
import { api, unwrap } from './api.js';
import { ErrorAlert } from './parts/ErrorAlert.js';
import { PrimaryButton } from './parts/PrimaryButton.js';
import { beginMemberSession } from './session.js';

export function LoginForm({ onSuccess }: { onSuccess: (me: Me) => void }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (values: { email: string; password: string }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(api.auth.login.$post({ json: values }));
      beginMemberSession(me);
      onSuccess(me);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form layout="vertical" onFinish={(v: { email: string; password: string }) => void submit(v)}>
      <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '填邮箱' }]}>
        <Input autoComplete="username" />
      </Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true, message: '填密码' }]}>
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      {error !== null && (
        <div style={{ marginBottom: 16 }}>
          <ErrorAlert error={error} />
        </div>
      )}
      <PrimaryButton htmlType="submit" block loading={busy}>
        登录
      </PrimaryButton>
    </Form>
  );
}
