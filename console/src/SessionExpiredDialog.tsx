// 会话过期后的就地登录框（spec「通用部件 · 会话过期的判定」、不变量 24）：session.ts 判为过期时弹出，不卸载页面，
// 编辑中的内容还在；登录成功后换上新的 csrf，重放刚才被拦下的请求。换了一个人登录时不重放（那是上一个人发起的写），
// 被拦下的请求按 401 结束，其余查询按新身份重取（页面照样不卸载）。
// 关掉它，等着的请求按 401 unauthorized 结束，页面就地显示「登录已过期 · 重新登录」，重试会再弹出来
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from 'antd';
import { useSyncExternalStore } from 'react';
import { LoginForm } from './LoginForm.js';
import { abandonRelogin, isSessionExpired, resumeSession, subscribeSession } from './session.js';
import { cjk } from './typography.js';
import { memberViewer, type Viewer, VIEWER_KEY } from './viewer.js';

const never = (): boolean => false;

export function SessionExpiredDialog() {
  const expired = useSyncExternalStore(subscribeSession, isSessionExpired, never);
  const qc = useQueryClient();
  return (
    <Modal open={expired} width={480} title="登录已过期" footer={null} maskClosable={false} onCancel={abandonRelogin} destroyOnHidden>
      <p style={{ margin: '0 0 16px', color: 'var(--text-2)' }}>{cjk('重新登录后接着刚才的操作')}</p>
      <LoginForm
        onSuccess={(me) => {
          const replayed = resumeSession(me);
          qc.setQueryData<Viewer>(VIEWER_KEY, (prev) => memberViewer(prev, me));
          if (!replayed) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== VIEWER_KEY[0] });
        }}
      />
    </Modal>
  );
}
