// 话术页自测（sop.selftest.tsx）第一个 import 它，要在 TanStack Router 加载之前跑：router-core 在 Node 里按 node 条件取
// isServer，NODE_ENV 不是 test 就当成服务端渲染，页面挂上去以后路由的过渡不跑、直接报错。自测要挂真的路由，所以先设好。
// 只影响这一个自测进程；构建入口不 import 它
process.env.NODE_ENV = 'test';
