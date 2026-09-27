// 字段渲染器自测用的 DOM（happy-dom，只是 DOM 实现，不是测试框架）。fields.selftest.tsx 第一个 import 它：
// antd 与 rc 组件在模块加载时判断有没有 DOM，装晚了，客户端挂载的输入框收不到 input 事件。
// 构建入口不 import 它，生产产物里没有；这里不写中文字符串，免得进 UI 字体子集。
import { Window } from 'happy-dom';

export const win = new Window({ url: 'http://localhost/console/', width: 1440, height: 1100 });

const g = globalThis as Record<string, unknown>;
const w = win as unknown as Record<string, unknown>;
// Node 自己有的（setTimeout、URL、Event 这些）照用 Node 的，只补 DOM 独有的
for (const k of Object.getOwnPropertyNames(win)) {
  if (k in g) continue;
  try {
    g[k] = w[k];
  } catch {
    // 只读的属性跳过
  }
}
// Node 22 自带一个只读的 navigator，换成 DOM 的
Object.defineProperty(g, 'navigator', { value: win.navigator, configurable: true });
g.window = win;
g.document = win.document;
// React 的 act() 要求
g.IS_REACT_ACT_ENVIRONMENT = true;
