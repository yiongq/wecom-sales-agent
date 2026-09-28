// 登录表单：登录页和会话过期后的就地登录框共用（spec「登录」，设计系统 §5.2）。
// - 字段是「邮箱」「密码」：标签在控件上方，不加冒号、不加星；占位符只放示例，以「例：」开头。
// - 没填就提交：不发请求，在控件下方就地写原因（13 danger，前置 circle-x），焦点放到第一个没填的控件上；填上了原因就消失。
// - 服务端的错误显示在按钮上方的页内 Alert 里，文案取 ERROR_COPY（邮箱或密码不对、429 尝试太频繁、连不上），不用 toast；
//   detail 只在折叠的技术详情里。提交中按钮显示 loading，这时再按回车不重复提交。
// 控件高度由外面定：登录页 40（设计系统 §3），就地登录框里照常 32
import { Input, type InputRef } from 'antd';
import { CircleX } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import type { Me } from '../../src/shared/console-api.js';
import { api, unwrap } from './api.js';
import { ErrorAlert } from './parts/ErrorAlert.js';
import { PrimaryButton } from './parts/PrimaryButton.js';
import { beginMemberSession } from './session.js';
import { Icon } from './shell/icons.js';

/** 与 LoginBody 的上限相同（邮箱去掉首尾空白后 254，密码 1024）：超长的根本输不进去，不会拿到 400 */
const EMAIL_MAX = 254;
const PASSWORD_MAX = 1024;

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <div id={id} className="login-field-error">
      <Icon of={CircleX} size={14} />
      {text}
    </div>
  );
}

export function LoginForm({ onSuccess, autoFocus = false }: { onSuccess: (me: Me) => void; autoFocus?: boolean }) {
  const uid = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /** 点过「登录」：之后空着的字段就地写原因 */
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<InputRef>(null);
  const passwordRef = useRef<InputRef>(null);

  const emailMissing = tried && email.trim() === '';
  const passwordMissing = tried && password === '';

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (email.trim() === '' || password === '') {
      (email.trim() === '' ? emailRef : passwordRef).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await unwrap(api.auth.login.$post({ json: { email, password } }));
      beginMemberSession(me);
      onSuccess(me);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login-form" noValidate onSubmit={(e) => void submit(e)}>
      <div className="login-field">
        <label className="login-label" htmlFor={`${uid}e`}>
          邮箱
        </label>
        <Input
          ref={emailRef}
          id={`${uid}e`}
          className="login-control"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={autoFocus}
          maxLength={EMAIL_MAX}
          placeholder="例：name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          status={emailMissing ? 'error' : undefined}
          aria-invalid={emailMissing || undefined}
          aria-describedby={emailMissing ? `${uid}ee` : undefined}
        />
        {emailMissing && <FieldError id={`${uid}ee`} text="没填邮箱" />}
      </div>
      <div className="login-field">
        <label className="login-label" htmlFor={`${uid}p`}>
          密码
        </label>
        <Input.Password
          ref={passwordRef}
          id={`${uid}p`}
          className="login-control"
          autoComplete="current-password"
          maxLength={PASSWORD_MAX}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          status={passwordMissing ? 'error' : undefined}
          aria-invalid={passwordMissing || undefined}
          aria-describedby={passwordMissing ? `${uid}pe` : undefined}
        />
        {passwordMissing && <FieldError id={`${uid}pe`} text="没填密码" />}
      </div>
      {error !== null && <ErrorAlert error={error} />}
      <PrimaryButton htmlType="submit" block loading={busy} className="login-submit">
        登录
      </PrimaryButton>
    </form>
  );
}
