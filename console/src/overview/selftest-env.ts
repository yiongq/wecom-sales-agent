// 总览自测的第一个 import：在 Node 里按客户端挂载 TanStack Router。router-core 的 isServer 在 Node 下解析到 server 版，
// NODE_ENV 不是 'test' 时恒为 true，RouterProvider 就按服务端渲染、不挂 Transitioner，客户端挂载时报错；
// 是 'test' 时交给 router 自己看有没有 document（happy-dom 给了）。React 在 NODE_ENV 不是 'production' 时都用开发版，不受影响。
// 构建入口不 import 它，生产产物里没有；这里不写中文字符串以外的界面文字
process.env.NODE_ENV = 'test';
