// 成功提示（spec「通用部件」、不变量 4，design-system §5.15）：全站唯一的 toast 函数，只报成功。
// 反相底、一句话、3 秒消失、不带操作；错误一律就地显示（ErrorAlert、StateView），不用 toast。
// antd 的 message 要从 App 的上下文里拿才跟得上主题，所以由 ToastHost（挂在 main.tsx 的 <App> 里）把它交给 toast()。
// console/src 里只有这个文件能碰 message / notification（scripts/check-console-src.ts 查）
import { App } from 'antd';
import { useEffect } from 'react';
import { cjk } from '../typography.js';

type MessageApi = ReturnType<typeof App.useApp>['message'];

let messageApi: MessageApi | null = null;

/** 挂在 antd 的 <App> 里，渲染为空 */
export function ToastHost(): null {
  const { message } = App.useApp();
  useEffect(() => {
    messageApi = message;
    return () => {
      if (messageApi === message) messageApi = null;
    };
  }, [message]);
  return null;
}

/** 报一次成功，如「草稿已保存」 */
export function toast(text: string): void {
  void messageApi?.success({ content: cjk(text), duration: 3 });
}
