// 「关于」（spec「关于」，设计系统 §2.6、P 页的关于弹窗样张）：480 宽的弹窗，写明字体、图标和各自的许可，
// 两个链接打开随构建发布的许可原文（/console/licenses/，不变量 31）。不写版本号和构建哈希；默认焦点在「关闭」上。
// 第一句用「），」不用「）；」（owner 2026-09-27）；中文与拉丁字母、数字之间不手打空格，由 text-autospace 补
import { Button, Modal } from 'antd';
import { X } from 'lucide-react';
import { useRef } from 'react';
import { cjk } from '../typography.js';
import { Icon } from './icons.js';

const LICENSES = `${import.meta.env.BASE_URL}licenses/`;

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      width={480}
      title="关于"
      onCancel={onClose}
      closeIcon={<Icon of={X} />}
      afterOpenChange={(visible) => {
        if (visible) closeRef.current?.focus();
      }}
      footer={
        <Button ref={closeRef} onClick={onClose}>
          关闭
        </Button>
      }
    >
      <p className="about-line">
        {cjk('字体：Geist、Geist Mono（Vercel），思源黑体Noto Sans SC（Adobe、Google）。都按SIL Open Font License 1.1使用。')}
      </p>
      <p className="about-line">{cjk('图标：Lucide（ISC许可）。')}</p>
      <div className="about-links">
        <a href={`${LICENSES}OFL-Geist.txt`} target="_blank" rel="noopener noreferrer">
          查看字体许可
        </a>
        <a href={`${LICENSES}lucide-ISC.txt`} target="_blank" rel="noopener noreferrer">
          查看图标许可
        </a>
      </div>
    </Modal>
  );
}
