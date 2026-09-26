// main.tsx 的第一个 import：在任何 schema 建出来、任何组件插样式之前，把页面 CSP 要的两件事做了。
//
// 1. zod 默认先试一次 Function('') 看能不能 JIT，页面 CSP（script-src 'self'）下会报一条违规：关掉 JIT。校验消息用中文。
//    必须在这里而不是 main.tsx 的正文里：ESM 先求值全部 import，共用的 schema 在那时就建好了。
// 2. 运行时插进来的 <style> 都带上页面的 nonce。antd 与 CodeMirror 自己认 nonce（main.tsx、TextEditor 也各自传了），
//    但 @rc-component/portal 锁滚动时插的 <style> 不带，Drawer 一开就违规、背景照样能滚。能调 createElement 的只有本站脚本，
//    它们本来就读得到 meta 里的 nonce；注入进来的标记（innerHTML 之类）走不到这里，照样被拦
import { z } from 'zod';
import { cspNonce } from './csp.js';

z.config({ jitless: true });
z.config(z.locales.zhCN());

if (cspNonce) {
  const nonce = cspNonce;
  const create = document.createElement.bind(document);
  document.createElement = ((tagName: string, options?: ElementCreationOptions): HTMLElement => {
    const el = create(tagName, options);
    if (el instanceof HTMLStyleElement) el.nonce = nonce;
    return el;
  }) as typeof document.createElement;
}
