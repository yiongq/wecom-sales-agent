// 话术页自测（sop.selftest.tsx）第一个 import 它，要在 TanStack Router 加载之前跑：router-core 在 Node 里按 node 条件取
// isServer，NODE_ENV 不是 test 就当成服务端渲染，页面挂上去以后路由的过渡不跑、直接报错。自测要挂真的路由，所以先设好。
// 只影响这一个自测进程；构建入口不 import 它
import '../fields/selftest-dom.js';

process.env.NODE_ENV = 'test';

// 按不支持 text-spacing-trim 的浏览器（Firefox、Safari、老版本企业微信）跑：happy-dom 的 CSS.supports 一律答支持，
// 这里让它对 text-spacing-trim 答不支持，界面代码启动时的检测（typography.tsx 的 needsTrimFallback）为真，
// cjk() 与话术编辑器都走 .halt 的回退。支持时编辑器的挤压由自测第 8.3 节显式传 halt 测
const supports = CSS.supports.bind(CSS);
Object.defineProperty(CSS, 'supports', {
  configurable: true,
  value: (a: string, b?: string): boolean => (a === 'text-spacing-trim' ? false : b === undefined ? supports(a) : supports(a, b)),
});
