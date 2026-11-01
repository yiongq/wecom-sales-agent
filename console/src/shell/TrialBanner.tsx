import { Alert } from 'antd';
import { cjk } from '../typography.js';

export function TrialBanner() {
  return (
    <Alert
      className="trial-banner"
      type="info"
      role="note"
      showIcon
      title={cjk('这是共享试用环境，会话可能被其他试用者看到，请不要发送个人信息。试用消息保留7天。')}
    />
  );
}
