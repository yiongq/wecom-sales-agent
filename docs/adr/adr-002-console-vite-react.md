# ADR-002：后台前端：Vite + React 单页挂在 `/console`，由 Hono 托管

- **状态**：采纳
- **日期**：2026-09-25
- **背景**：现在的后台是 `public/admin.html`，约 1100 行原生 JS，单一 `ADMIN_PASS` 登录，靠 SSE 加 30 秒轮询刷新。产品化路线要在后台里加 SOP 分节编辑与版本 diff、产品库表单、坐席工作台、trace 查看、护栏统计、多角色和租户切换（见[总参考](../architecture/master-reference.md)「分阶段路线」）。

---

## 决策

1. **技术栈**：
   - Vite + React + TypeScript。
   - 路由用 TanStack Router（类型安全），数据请求用 TanStack Query。
   - 组件库用 Ant Design，版本钉死。
   - SOP 编辑和 diff 用 CodeMirror 6 + `@codemirror/merge`，图表用 ECharts。
   - 产品库表单由行业包的 zod schema 转成 JSON Schema 自动生成，新行业不用写新表单。
2. **接口类型**：
   - 用 Hono RPC（`hc<ConsoleApp>`）从后端路由推导类型，不手写前端类型，也不跑代码生成。前端只 `import type` 服务端的路由类型。
   - Hono RPC 要求路由链式注册，而现有 `src/server.ts` 是逐条 `app.get`。所以后台接口单独写成一个链式子应用，挂在 `/api/console/*`，带分页和过滤。旧的 `/api/*` 继续服务 chat.html 和 admin.html。
   - 前后端共用的 zod 定义不得 import drizzle 或 pg，否则会被打进浏览器包。drizzle-zod 只在服务端使用（ADR-001）。
3. **托管与门禁**：
   - 仓库根目录仍是服务端，新增 `console/` 作为 pnpm workspace 包。
   - 多阶段 Dockerfile 构建出 `console/dist`，由 Hono 在 `/console/*` 下提供静态文件，并做 SPA 回退。
   - 开发时 Vite 把 `/api` 代理到本地服务端。
   - 始终是一个进程、一个端口、一个镜像。
   - 四个门禁名不变，内容扩到 `console/`：`typecheck` 同时检查根目录和 `console/`（例如 `tsc --noEmit && tsc --noEmit -p console`，或改用 `tsc -b` 项目引用）；`lint` 和 `format:check` 的范围覆盖 `console/`。hook、CI、Stop hook 都不用改。现在根目录的 `tsconfig.json` 只 include `src` 和 `eval`，也没有 JSX 和 DOM 配置，不扩的话 `console/` 不受类型检查。
4. **面向客户的页面保留原生 HTML**：chat、pay、proposal、guide。
5. **过渡**：
   - demo 上保留 `admin.html`，等后台做到 P0 功能对齐再重定向到 `/console`。guide 页上的演示链接不变。
   - demo 的匿名只读模式下，后台不展示审计日志，因为里面有操作者和 IP。

## 理由

- **服务端是常驻进程。** 引擎、企微拉取、跟进定时器、SSE 推送都必须跑在同一个长期运行的 Node 进程里。后台只是这个进程托管的一组静态文件，不需要第二个服务端运行时。
- **后台在登录之后，不需要 SEO，也不需要服务端渲染。**
- **换框架的信号全部命中。** 下面 6 个信号满足任意 2 个就该换：视图超过 5 个或需要路由；带校验的 CRUD 表单；要筛选、分页、导出的大表格；多角色权限；多租户切换；有第二个人写前端。路线上的后台需求把这 6 个全部命中。
- **Ant Design** 的高密度表格和表单，是国内 B 端后台的事实标准。
- **Hono RPC** 让接口改动在编译期就暴露到前端，前提是 `typecheck` 覆盖 `console/`（决策 3）。
- **客户页不换。** 它们在微信内置浏览器里打开，原生页首屏快、没有构建依赖，而且现在工作正常。

## 被否决的方案

- **Next.js**：它的长处（SSR、SEO、按路由部署的 serverless 函数）后台都用不上。引擎、渠道轮询、定时器和 SSE 仍然需要一个常驻进程，用了 Next.js 就等于两个服务端运行时并存。以后如果要做面向公众、需要 SEO 的站点，再单独评估。
- **继续手写 HTML**：6 个信号全部命中。现在这个约 1100 行的单文件，每收到一次 SSE 变更就全量重拉一次 `/api/sessions`，而且带上全部消息。工作台、分页和表单如果继续手写，成本只会越来越高。
- **Vue + Element Plus**：和 React 方案同样可行，owner 选定 React。

## 后果

- **变好的**：接口改动在类型检查时就暴露到前端；新行业的产品库表单由 schema 生成；表格、分页、表单不用再手写。
- **代价**：
  - 多了一个构建步骤和一个 pnpm workspace 包；Dockerfile 要改成多阶段；`typecheck`、`lint`、`format:check` 要覆盖 `console/`。
  - 前端依赖（React、TanStack、Ant Design、CodeMirror、ECharts）都要钉版本、跟升级。
  - demo 上 `admin.html` 和 `/console` 会并存一段时间，对齐之前两边都要维护。
- **以后变难的事**：
  - 后台接口必须写在链式子应用里才有类型；旧的逐条 `/api/*` 路由拿不到类型，只能逐个搬。
  - Ant Design 换大版本的成本高。
  - 以后要做面向公众、需要 SEO 的页面，这套单页不适用，要另选方案。

## 后续动作

- 01：
  - 搭好 `console/` 工作区和构建链：多阶段 Dockerfile、SPA 回退、链式子应用。
  - 四个门禁扩到 `console/`（决策 3）。验收加一条：故意改坏一个 console 接口的类型，`pnpm typecheck` 失败。
  - 后台 v0 五页：
    - 登录；
    - SOP：分节编辑、草稿、与已发布版本的 diff、历史和回滚；
    - 产品库：表格、schema 生成的表单、CSV 导入；
    - 会话只读列表；
    - 审计日志。
  - 工期偏紧时先砍什么，见总参考「开放问题」。Hono RPC 在 01 最多推迟、不能取消，02 开工前补上；要取消就另写一份 ADR 取代决策 2。
- 02：P0，对齐 admin.html。
  - 坐席工作台：分页和搜索。
  - 会话详情里的接管、交还、人工回复、AI 草稿。
  - 转人工队列、订单。
  - 按租户鉴权的 SSE。
- 03 起：
  - P1：SOP 编辑器与版本（policy 表单、lint、发布闸、沙盒对话）；知识库（上传、分块预览、检索测试）。
  - P2：
    - trace 查看器、指标、评测结果、「存为回归用例」；
    - 渠道配置：凭据只写，只显示后 4 位；
    - 成员管理与租户设置；
    - 平台侧：从模板开通租户。
- 开工前核实 Ant Design 当前的稳定大版本，然后钉死。

## 参考

- 本仓库的 `public/admin.html`、`src/server.ts`、`tsconfig.json`，即现状。
- [ADR-001](adr-001-postgres-drizzle.md)：drizzle-zod 只在服务端使用。
- [总参考](../architecture/master-reference.md)「已定决策」：面向客户的页面保留原生 HTML。
- [Hono RPC](https://hono.dev/docs/guides/rpc)：链式注册路由后用 `hc` 推导客户端类型。
