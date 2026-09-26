# 01 · Postgres 底座 + 配置入库 + 后台 v0

Status: ready
Phase: 1 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」
Depends on: [00-baseline](../00-baseline/spec.md)（`DEPLOY_PROFILE`、`promptPrefix()`、四个门禁、按 tag 部署）。选型见 [ADR-001](../../adr/adr-001-postgres-drizzle.md)、[ADR-002](../../adr/adr-002-console-vite-react.md)、[ADR-003](../../adr/adr-003-open-core-boundary.md)
Revisions: 2026-09-25 首版草稿经多角度对抗审查后就地修订（尚无代码依赖）。主要改动：DB 模式改为 `CONFIG_SOURCE=db` 显式开启（原为看有没有 `DATABASE_URL`），并要求显式写 `DEPLOY_PROFILE`；启动顺序写死在 `src/boot.ts`（R18）；锁连接断开先进入 lost 状态、后台重取（原为立即退出）；`renderSystemPrompt` 不读 profile（原随 `ai_disclosure` 变化）；哈希由一个扩为四个；版本号在发布时分配（原在建草稿时）；检索改为失效后全量重建（原为按条向量缓存，推到 03）；产品库编辑改为字段级 PATCH 加递归键序合并，计价、识别与条款字段锁定；凭据按 compose 服务隔离（R19）；备份改由超级用户在 db 容器里导出并加密；验收 21 改为前缀哈希自动断言加真实模型 p90 绝对阈值；恢复演练的结论记进 plan，细节另记（原为整条另记）。2026-09-25 owner 确认后翻为 ready，同时定下开放问题 1（`test` 多串三组自测）。

Revisions: 2026-09-26 实现期修订（owner 确认）：后台页面的 CSP 在原来那条之外加 `style-src 'self' 'nonce-…'`，每个响应现生成（第 12 步实测 Ant Design 与 CodeMirror 在原 CSP 下没有样式）；`/api/console/*` 的 CSP 不变。见「后台 API 与页面 · 安全头」。

## 背景与问题

现在 SOP 和产品库是 git 里的三个文件，随镜像发布：

- `buildSystemPrompt()` 每轮调 `loadSop()` 读一次 `data/sop.md`，再拼上代码里写死的【硬性要求】（含品牌名和身份口径）。00 规定身份那一行逐字节不变，`ai_disclosure` 只影响欢迎语，不进 system prompt。请求的前缀是 `[tools][system]`，前缀缓存要求两段都逐字节不变。
- `loadRoutes()` / `loadHotels()` 每次调用都重新 `JSON.parse` 文件。引擎、工具、价格护栏、服务端和企微适配器里有二十多处同步调用。因为每次拿到的都是新对象，调用方可以随手改返回值：`searchHotels` 在没有过滤条件时就对它原地 `sort`。
- 改一个价或一句话术，都要改文件、提交、重新部署。后台 `admin.html` 只有一个 `ADMIN_PASS`，没有账号，也没有审计。

要把这两样挪进数据库交给运营编辑，下面几处现状决定了哪些东西必须先定死：

- **键序就是字节。** `get_route_detail` 把整条线路 `{ ...route }` 展开后 `JSON.stringify` 发给模型，`search_hotels` 直接序列化酒店对象。`data/routes.json` 的 20 条线路有 3 种不同的键序，而且都带一个 `types.ts` 里没有声明的 `overseas` 字段，`foreign()` 靠它区分境内外线路。
- **mock 回归当不了发布闸。** `mockChat` 只读客户消息和工具，从不读 system prompt。SOP 改成什么样，mock 下的 19 条用例都照样全过。
- **代码依赖 SOP 原文。** `engine.selftest.ts` 对 `buildSystemPrompt()` 的结果有 17 条短语断言：14 条要求出现，3 条要求不出现。要求出现的 14 条全部落在代码依赖的那几节里。SOP 还点名了工具名和工具结果字段，这些字段分散在 `tools.ts` 和 `price-rules.ts` 两处。
- **检索索引不会自己更新。** `buildIndex()` 一旦建过索引就直接返回，进程内永远不重建。
- **方案书按当前数据算价。** `/api/proposal/:routeId` 每次用当前产品库重算报价，链接里只有线路 id、人数和日期。报价快照要到 02 才有。
- **启动顺序。** `server.ts` 在模块顶层调 `startWecom()`，它一启动就补拉并处理 cursor 之后的客户消息；价格护栏和引擎里有五处 `try { loadRoutes() } catch {}`，会把「配置还没装载」吞成空线路表。
- **`.env` 会进测试进程。** `src/env.ts` 把 cwd 下 `.env` 里尚未设置的变量填进 `process.env`，几乎所有模块都 import 它。开发机的 `.env` 里有什么，自测就看到什么。

本阶段只把「之后改不起的东西」定下来：七张表与三个角色的形状；产品库条目的存储格式（`json` 加 `ord`）；SOP 的节键、锁定表和正文边界；「发布时渲染一次，运行时逐字节复用」的语义和四个哈希；会话 cookie 与 token 的存法；前后端共用 zod 的依赖边界；三个角色的凭据按服务隔离；迁移只增不删。会话、消息、订单仍在文件里，02 再入库。工作量按 plan 的逐步估算约 35 个工程日。

## 目标

1. 配置（SOP、产品库）可以存进 Postgres，由 `CONFIG_SOURCE=db` 显式开启。不开时行为与开工时逐字节相同，现有 selftest 与 eval 的断言不改（唯一的例外见验收 1）。
2. SOP 分节并版本化，支持草稿、契约检查、发布和回滚。发布时存下整段 system prompt 和四个哈希，运行时逐字节复用，不重新渲染。
3. 产品库按条目入库，每条的字节和顺序都保持不变，运行时读冻结的进程内快照。运营可以上新条目、改文案类字段；计价、识别与条款字段在 v0 只读。产品库变化后检索索引自动重建。
4. 七张表、三个角色、RLS 模板和 SECURITY DEFINER 认证函数就位，RLS 测试跑在真实 Postgres 上。
5. 个人账号登录：scrypt、`__Host-sid`、CSRF 头、限流。React 后台 v0 挂在 `/console`，共五页：登录、SOP、产品库、会话只读列表、审计日志。
6. 多阶段镜像、按服务隔离凭据的 compose（db / migrate / app / platform）、加密的每晚备份、导出脚本和回滚流程就位；demo 实例切到 DB 模式，并完成一次恢复演练。

## 非目标

- 会话、消息、订单、报价快照、逐轮 trace、`jobs` 和 identity map 入库（02）。`usage_daily` 也归 02，见裁决 R14。
- 坐席工作台、会话详情、接管、交还、人工回复，以及按租户鉴权的 SSE（02）。01 的会话列表只读，只有摘要。
- 开放 active 条目的计价、识别与条款字段；下架或删除条目（02，有了报价快照之后）。01 里锁定字段只能用停机执行的命令行 `catalog-fix` 修正。
- 一轮之内固定产品库快照（02 放开计价字段之前必须做，见裁决 R6）。
- policy 单一来源；品牌名和 AI 标识改成租户变量；租户设置，即 `capFlags` 的接线；真实模型发布闸；沙盒对话；知识库与 pgvector；检索的按条向量缓存（03）。
- 增删节、改节标题、调整节序（03 由行业包定义节表时再做）。
- 行业包抽取、同部署多租户、渠道账号、跨租户的平台查询（04）；多副本与 LISTEN/NOTIFY（05，按信号定）。
- 成员管理页、改口令页、企微扫码登录。01 用命令行管账号。
- `admin.html` 和 `ADMIN_PASS` 流程不动，包括「列表 401 时自动弹登录框」（推迟到 02，见下一节）。唯一的改动是 prod 下 `/api/admin/stream` 的鉴权。
- `eval/ab-models.ts` 仍直接读 `data/sop.md`。它是选型脚本，不走配置源。

## 前置条件（00-baseline 交付）

开工时逐项核对，缺一项就停下，由 owner 决定补进 00 还是并入本阶段：

- 四个门禁名接上了真实工具，`format:check` 的范围排除了 `data/sop.md`。
- `src/profile.ts` 提供 `profile().flags.anon_readonly_admin`。本阶段后台的匿名只读读它。
- 【硬性要求】身份那一行逐字节不变，`ai_disclosure` 只有 `always` 一个取值、只影响欢迎语。01 的渲染据此不读 profile。
- `engine.ts` 导出 `promptPrefix(): { system; tools }`，`engine.selftest.ts` 里有「多轮之间逐字节不变」的断言。
- `deploy.sh <tag>` 按 tag 部署并保留 `:prev` 回滚，`/healthz` 返回 `revision`。

## 从 00 与总参考接过来的事项

| 事项                                      | 来源                    | 01 的处理                                                            | 理由                                                                                                |
| ----------------------------------------- | ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| cookie 会话鉴权、compose 编排             | 00 非目标               | 本阶段做                                                             | —                                                                                                   |
| 后台 SSE（`/api/admin/stream`）鉴权       | 00 非目标、总参考阶段 1 | 本阶段做：`anon_readonly_admin` 关闭时，要求有效的后台会话，否则 401 | `admin.html` 已有 30 秒兜底轮询，没登录后台时退回轮询                                               |
| `admin.html` 列表 401 时自动弹登录框      | 00 非目标               | 推迟到 02                                                            | 02 对齐 `admin.html` 与后台时一起改；`server.selftest.ts` 从页面里抽脚本源码做断言，01 不动页面脚本 |
| 品牌名参数化、租户设置（`capFlags` 接线） | 00 非目标               | 推迟到 03                                                            | 参数化会改硬性要求的字节，要有真实模型回归闸兜底；01 没有租户设置的读写方                           |
| `tenants` 带 `locale` / `region`          | 总参考、ADR-001         | 本阶段做                                                             | —                                                                                                   |
| 本阶段 8 张表                             | 总参考、ADR-001         | 7 张，`usage_daily` 移到 02                                          | 裁决 R14                                                                                            |
| 检索「按条增量向量化」                    | 总参考开工空缺 5        | 01 做失效与全量重建，按条缓存推到 03                                 | 裁决 R7                                                                                             |
| 验收「缓存命中与 p90 不退化」             | 总参考阶段 1 验收       | 改为自动断言前缀哈希，加真实模型的绝对阈值                           | 验收 21                                                                                             |

## 开工前裁决

迁移计划的代码审查（另记）列出了若干空缺，总参考也给 01 留了几个开放问题。下表逐条给结论，细节见「接口与数据流」对应的小节。

| #   | 问题                                                                           | 裁决                                                                                                                                                                                                                                                                                                                                                                             | 本阶段落地                                                                                              | 推迟                                |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| R1  | 自测和 eval 直接读 `data/`，「读不到快照就启动失败」会让它们全挂               | 只有 `CONFIG_SOURCE=db` 才是 DB 模式；未设、空串或 `file` 都是文件模式，行为与开工时逐字节相同。不单看 `DATABASE_URL`：首次切换时命令行要先连库，而应用还在文件模式；开发机的 `.env` 也常带它。DB 模式下任何一步失败都拒绝启动，绝不回落去读文件                                                                                                                                 | `configMode()` / `initConfig()`；`buildSystemPrompt`、`loadRoutes`、`loadHotels` 签名不变               | —                                   |
| R2  | 发布闸 v0 对 SOP 不起作用：`mockChat` 不读 system prompt                       | 闸改成同步执行的 SOP 契约检查，查五项：节表与正文结构；锁定节未动；共享短语清单；工具名与字段名真实存在；可编辑节的字符预算。前四项在每次启动时也跑                                                                                                                                                                                                                              | `src/sop/contract.ts`；源码扫描测试保证清单覆盖 `engine.selftest.ts` 里每条 SOP 短语断言，断言原文不动  | 真实模型回归闸、沙盒对话（03）      |
| R3  | 只锁四节不够；前言会破坏往返                                                   | 按行首 `## ` 切节，第一个 `## ` 之前的前言单独成一节，共 11 节。锁定其中 7 节：各阶段目标、订单、报价纪律、定价规则、能力边界、我们没有的目的地、转人工条件。**锁定节归代码所有**：DB 模式下永远取镜像里 `data/sop.md` 的对应节                                                                                                                                                  | 节表 `TRAVEL_SOP_SECTIONS`；后台只能改可编辑节的正文                                                    | 随 policy 单一来源逐节开放（03）    |
| R4  | 哈希只算 SOP 不够；只看 system 也不够；静态 golden 会不停失效                  | 四个哈希：`prompt_hash`（整段 system）、`tools_hash`（`promptPrefix().tools`）、`prefix_hash`（前两者合成）、`sop_hash`（只算 SOP 正文，跨代码版本可比）。发布时渲染一次并存下；每轮逐字节读缓存。等价性用「同一进程里文件渲染 == DB 渲染」断言，不设静态常量。硬性要求、锁定节、节表或工具定义一变，启动流程自动生成 `rerender` 版本                                            | `renderSystemPrompt()` 从 `buildSystemPrompt` 拆到 `src/prompt/system.ts`；已发布的行由触发器保证不可改 | 品牌与 AI 标识参数化（03）          |
| R5  | 缓存怎么失效；要不要 LISTEN/NOTIFY                                             | 只跑单副本，写入都发生在本进程：事务提交后直接更新进程内缓存。不用 LISTEN/NOTIFY。启动时取租户级 advisory lock，第二个进程连到同一个库就拒绝启动。锁连接断开时不立即退出：配置写入暂停、对话照常，后台重连重取；只有「连上了而锁在别人手里」才走优雅停机退出                                                                                                                     | `source.ts`；`holdTenantLock`                                                                           | 多副本（05）                        |
| R6  | jsonb 会重排键序；`searchHotels` 原地排序；一轮里快照会不会换                  | 条目整条存进 `payload json`，另加 `ord` 列保住数组顺序。两种模式下 `loadRoutes()` / `loadHotels()` 都返回 deep-frozen 的对象。编辑是字段级补丁，写库的是请求原值按原键序递归合并的结果，不是 zod 的输出。`searchHotels` 改成先拷贝再排序。01 接受一轮之内看到不同代的快照：锁定字段不变，工具输出和护栏看到的计价与识别字段一致                                                  | `catalog_items`；`mergeKeyOrder()`；快照冻结                                                            | 按轮固定快照（02 放开计价字段之前） |
| R7  | 新增的线路永远召回不到                                                         | 加 `invalidateIndex()`；产品库变化后全量重建（20 条线路一次请求）；按代际丢弃过期的构建结果；失败按退避重试。按条向量缓存对 01 的规模是过度设计，03 换 pgvector 时一起做                                                                                                                                                                                                         | `retrieval.ts`                                                                                          | 按条缓存、pgvector（03）            |
| R8  | 改价会让已发出的方案书变价                                                     | active 条目的计价、识别与条款字段在 v0 只读，清单见「编辑规则」；`id` 任何状态下都不能改。active 条目不能回到 draft，也不能删除，否则已发出的方案书会 404。锁定字段的紧急修正走停机执行的 `catalog-fix`，写审计                                                                                                                                                                  | `LOCKED_WHEN_ACTIVE`、`ALWAYS_LOCKED`；由服务端校验，不靠界面                                           | 有报价快照后逐字段开放（02）        |
| R9  | 登录相关的表不能套租户模板；公开路由拿不到租户                                 | `tenants`、`users`、`auth_sessions` 不启用 RLS；其余带 `tenant_id` 的表都套 RLS 模板（FORCE），豁免清单只有 `auth_sessions`。`agent_app` 对 `users`、`memberships`、`auth_sessions` 没有任何表权限，只能调 SECURITY DEFINER 认证函数。平台命令行用 `agent_platform` 连接，同样走 `withTenant`。一个容器一个租户期间，进程只装载 `DEFAULT_TENANT_SLUG` 这一个租户，公开路由都用它 | 见「数据库」                                                                                            | 跨租户的平台查询（04）              |
| R10 | 鉴权细节                                                                       | 口令用 scrypt，参数随哈希存。cookie 用 `__Host-sid`，库里只存 token 的 sha256。空闲 12 小时、绝对 7 天过期。限流按 IP、按「邮箱 + IP」硬锁，按邮箱只做延迟，不存在的邮箱同样计数。写请求要带 `x-csrf` 头，同时保留 `sameOriginOnly`。`admin.html` 继续用 `ADMIN_PASS`                                                                                                            | 见「鉴权」                                                                                              | 扫码登录、成员管理页（以后）        |
| R11 | 构建链没设计                                                                   | 多阶段 Dockerfile；`/console/*` 做 SPA 回退；后台接口写成单独的链式 Hono 子应用；共用 zod 放在 `src/shared/`，只依赖 `zod`，由 lint 和产物扫描两道把关；命令行放在 `src/cli/`，受类型检查、随镜像发布                                                                                                                                                                            | 见「构建与部署」                                                                                        | —                                   |
| R12 | 回滚到文件版镜像会静默丢掉 DB 里的修改                                         | 自动回滚落在 `:prev` 上，而 `:prev` 取自正在运行的容器，所以切换完成后它永远是能读库的镜像。回到文件模式只能手动操作，而且必须先按目标版本的锁定节导出。启动日志按节、按条目点名 DB 与镜像内 `data/` 的差异                                                                                                                                                                      | `src/cli/export-config.ts`；「导入、导出与回滚」                                                        | —                                   |
| R13 | PGlite 默认以超级用户连接，测不了 RLS；`json` 列的字节承诺只在 PGlite 上测不够 | RLS、授权、租户锁，以及 node-postgres 驱动下的字节等价和命令行子进程，都跑在 CI 的 Postgres 服务容器上；其余用 PGlite。真实 PG 部分并进 `test`：有 `PG_TEST_URL` 就跑；`CI=true` 而没有它时直接失败，不静默跳过                                                                                                                                                                  | `db.selftest.ts`                                                                                        | —                                   |
| R14 | `usage_daily` 建了表，却没有迁移 `usage.ts`                                    | 移出 01。01 没有它的写入方；它和逐轮 trace 挂在同一个模型用量回调上，02 一起做                                                                                                                                                                                                                                                                                                   | `usage.json` 不动                                                                                       | 02                                  |
| R15 | demo 匿名只读时，后台不能露出身份和未发布内容                                  | 审计页和会话列表一律要求登录。匿名能读的只有脱敏投影：已发布 SOP 和 active 条目，不含任何用户 id、姓名、变更说明和草稿。复用 `anon_readonly_admin`：它原本放行的是公开演示用的只读数据，这里加的也只是已公开对外说出的内容，prod 两者一起封顶                                                                                                                                    | 权限表                                                                                                  | —                                   |
| R16 | 自测默认跑哪种存储（总参考的开放问题）                                         | 现有 6 组自测和 eval 默认跑文件模式，`test` 对它们显式设 `CONFIG_SOURCE=file`。DB 路径由新增的三组自测，加一遍 DB 模式的 mock eval 覆盖                                                                                                                                                                                                                                          | 见「测试与 CI」                                                                                         | 02 的会话存储沿用同一原则，由 02 定 |
| R17 | 工期吃紧时先砍什么（总参考的开放问题）                                         | 两级砍法和可观察的触发点见 plan。Hono RPC 不砍：它是 ADR-002 定下的接口契约，链式子应用本来就要写，工作量在子应用上，不在 RPC 上                                                                                                                                                                                                                                                 | plan「工作量与砍法」                                                                                    | —                                   |
| R18 | 企微拉取、跟进、索引构建在配置装载之前就开跑                                   | 启动顺序写死：`await initConfig()` 成功之后才 `serve()`，监听成功后再依次做数据预检、`buildIndex`、`startFollowUpScheduler`、`startWecom`。装载失败时这些一个都不调，企微 cursor 不动                                                                                                                                                                                            | `src/boot.ts`                                                                                           | —                                   |
| R19 | 三个角色的凭据怎么分发                                                         | 按 compose 服务隔离：app 只拿 `agent_app`，migrate 只拿 `agent_owner`，platform 只拿 `agent_platform`，db 服务不对外发布端口。app 进程的环境里出现 owner 或 platform 的凭据，DB 模式拒绝启动                                                                                                                                                                                     | 见「构建与部署」                                                                                        | —                                   |

## 接口与数据流

### 模块与依赖方向

```
src/
  boot.ts                 启动顺序：initConfig → serve → 预检、索引、跟进、企微
  tool-defs.ts            toolDefs（从 tools.ts 搬出的纯数据，无副作用；tools.ts 再导出）
  prompt/system.ts        renderSystemPrompt：从 buildSystemPrompt 拆出，纯函数
  sop/sections.ts         节表、切分 / 拼接 / 规范化 / 与镜像合并（纯函数）
  sop/contract.ts         契约清单、字段表、checkSopContract（纯函数）
  shared/                 前后端共用，只依赖 zod
    catalog-types.ts      Route、Hotel 及其嵌套类型（从 types.ts 搬出，types.ts 再导出）
    season.ts             peakMonths（从 tools.ts 搬出，tools.ts 再导出）
    catalog.ts            RouteSchema / HotelSchema、LOCKED_WHEN_ACTIVE、ALWAYS_LOCKED、mergeKeyOrder
    console-api.ts        后台接口的请求与响应 schema
  db/                     全仓唯一能 import pg / drizzle-orm / @electric-sql/pglite 的目录
    schema.ts             drizzle 表定义
    client.ts             openDb、withTenant、queryCount、租户锁
    migrate.ts            以 agent_owner 跑迁移
    repo/                 sop.ts、catalog.ts、audit.ts、auth.ts：数据访问，只收发领域类型
    testing.ts            PGlite 测试库，只给 *.selftest.ts 与 eval/run.ts 用
  config/
    source.ts             配置源：模式判断、启动装载、进程内缓存、锁状态
    sop.ts                草稿、检查、发布、回滚
    catalog.ts            条目的新建、编辑、上架，以及快照更新
  auth/                   口令、会话、限流
  console-api/app.ts      链式子应用，导出 ConsoleApp 类型
  cli/                    tenant-create、user-*、member-*、import-config、export-config、catalog-fix
console/                  Vite + React 工作区（ADR-002）
drizzle/                  迁移：drizzle-kit 生成的部分 + custom SQL
deploy/
  compose.yml
  db-init/roles.sql、roles.sh   集群级角色与建库，不放在迁移里
  backup.sh
```

依赖规则，都由 `lint` 守：

- `pg`、`drizzle-orm`、`@electric-sql/pglite` 只能被 `src/db/**` import。
- 字符串 `app.tenant_id` 只出现在 `src/db/client.ts` 和迁移 SQL 里（覆盖 `set_config`、`SET`、`SET LOCAL`、`RESET` 各种写法）；全仓禁用 drizzle 的 `sql.raw`。
- `src/shared/**` 只能 import `zod` 和 `src/shared/**`，`import type` 也一样。
- `console/src/**` 只能 import `src/shared/**`，外加用 `import type` 引 `src/console-api/app.ts`。
- `src/db/testing.ts` 只能被 `*.selftest.ts` 和 `eval/run.ts` import。
- `src/prompt/**` 与 `src/sop/**` 不 import `src/db/**` 和 `src/config/**`。
- `src/config/**`、`src/db/**`、`src/sop/**`、`src/prompt/**`、`src/auth/**`、`src/cli/**` 不 import `store`、`tools`、`engine`、`retrieval`、`llm` 和 `adapters/**`；需要工具定义时 import `tool-defs`。这几个运行时模块在加载时就读 `var/`、登记信号处理、跑保鲜和清理，退出时还会把内存里的会话写回磁盘。依赖方向只能是运行时模块 import 配置层，反过来由回调注册（`onCatalogChanged`）。

### 两种模式与启动装载

```ts
// src/config/source.ts
import type { Hotel, Route } from '../shared/catalog-types.js';

export type ConfigMode = 'file' | 'db';

export interface PublishedSop {
  tenantId: string;
  versionId: string;
  versionNo: number;
  /** 与镜像合并之后的全部节，deep-frozen；匿名只读页也从这里取，不查库 */
  sections: readonly SopSection[];
  /** 整段 system prompt：SOP 各节拼接，再加代码里的【硬性要求】。每轮原样交给 chat()，从不重新渲染 */
  renderedPrompt: string;
  /** 以下都是 64 位小写十六进制 sha256，含义见「渲染与哈希」 */
  promptHash: string;
  toolsHash: string;
  prefixHash: string;
  sopHash: string;
}

export interface CatalogSnapshot {
  tenantId: string;
  /** 进程内单调递增，每次快照变化加 1。检索索引据此丢弃过期的构建结果；文件模式恒为 0 */
  generation: number;
  /** 只含 active 条目，各自按 ord 升序，deep-frozen */
  routes: readonly Route[];
  hotels: readonly Hotel[];
}

/** 装过 DB 配置源（initConfig 收到非空 deps），或 CONFIG_SOURCE === 'db'，就是 'db'；否则 'file' */
export function configMode(): ConfigMode;

export interface TenantLock {
  /** 锁连接断开时回调；进入停机之后不再回调 */
  onLost(cb: () => void): void;
  /** 重连并重取：'ok' 恢复持锁；'held_by_other' 连上了但锁在别人手里；'unreachable' 还连不上 */
  reacquire(): Promise<'ok' | 'held_by_other' | 'unreachable'>;
  release(): Promise<void>;
}

/** 装载所需的全部外部依赖。生产由 productionConfigDeps 构造；自测逐项替换 */
export interface ConfigDeps {
  db: Db;
  tenantSlug: string;
  lock(tenantId: string): Promise<TenantLock | null>; // null = 锁在别人手里
  imageSop: string;                  // 镜像里 data/sop.md 的全文，启动时读一次，之后的发布、回滚、导出都用这一份
  toolsJson: string;                 // JSON.stringify(toolDefs)，与 promptPrefix().tools 相同
  toolNames: readonly string[];
  knownFields: readonly string[];    // 默认 SOP_KNOWN_FIELDS
  render(sop: string): string;       // 默认 renderSystemPrompt；render_inputs 的 hardRulesHash 也用它算
  gracefulExit(code: number): void;  // 由 server.ts 传入 store.ts 的 gracefulExit：与 SIGTERM 走同一条停机路径
}

/**
 * 从环境变量构造生产依赖。要求：CONFIG_SOURCE 只能是空、'file' 或 'db'；DB 模式下 DATABASE_URL
 * 是 postgres:// 或 postgresql://，DEFAULT_TENANT_SLUG 与 DEPLOY_PROFILE 显式设置；
 * 环境里不能有 DATABASE_OWNER_URL、DATABASE_PLATFORM_URL、POSTGRES_PASSWORD 或 AGENT_*_PASSWORD。
 * 不满足时抛 ConfigStartupError('env_invalid' | 'env_privileged')，detail 里的连接串一律脱敏。
 * 配置层不 import store.ts，停机函数由调用方传入
 */
export function productionConfigDeps(env: NodeJS.ProcessEnv, gracefulExit: (code: number) => void): Promise<ConfigDeps>;
/** 停机：server.ts 在 onShutdown 的普通阶段调 markConfigShuttingDown()（此后忽略锁连接的一切事件），
 *  在 late 阶段调 closeConfig()（释放锁、关连接池） */
export function markConfigShuttingDown(): void;
export function closeConfig(): Promise<void>;

/**
 * deps 为 null：文件模式，立即 resolve，什么都不做。
 * 否则依次执行，前 8 步只读：
 *   1 连库，核对 server_encoding 为 UTF8 → 2 核对迁移（见「迁移纪律」）→ 3 按 tenantSlug 解析租户，
 *   拒绝 suspended → 4 取租户锁 → 5 切分并校验 imageSop → 6 装载已发布 SOP，校验完整性，
 *   算出合并、渲染与契约结果（见「启动重渲染」）→ 7 装载产品库快照（至少一条 active 线路）
 *   → 8 按节、按条目打印 DB 与镜像 data/ 的差异 → 9 需要时写入 rerender 版本 → 10 装上缓存。
 * 任何一步失败都以 ConfigStartupError reject，释放锁、关闭连接池，不留半装载状态。
 */
export function initConfig(deps: ConfigDeps | null): Promise<void>;

/** db 模式且装载完成后才能调用，否则抛 ConfigNotReadyError */
export function currentSop(): PublishedSop;
export function currentCatalog(): CatalogSnapshot;
/** 产品库快照变化后回调；retrieval.ts 在加载时注册，用来失效并重建索引 */
export function onCatalogChanged(cb: (snap: CatalogSnapshot) => void): void;
/** { lock: 'held' | 'lost'; sopStale: boolean; catalogStale: boolean }，供 /healthz 与 /status */
export function configHealth(): ConfigHealth;

/** 只给 src/config/{sop,catalog}.ts 在事务提交之后调用；next.versionNo 不大于当前值时忽略 */
export function replacePublishedSop(next: PublishedSop): void;
/** 用提交后 RETURNING 的行在内存里更新快照：替换同 code 的条目，或按 ord 插入新上架的条目；generation 加 1 */
export function applyCatalogRow(row: CatalogItem): void;
/** COMMIT 抛错、结果不明时调用：标脏，从库里整体重读 SOP 与产品库。单飞：进行中再被调用只置位，结束后再跑一遍；失败按退避重试 */
export function reloadFromDb(): Promise<void>;

export class ConfigNotReadyError extends Error {}
export class ConfigLockLostError extends Error {} // → 503 lock_lost
export class ConfigStartupError extends Error {
  constructor(
    readonly reason:
      | 'env_invalid' | 'env_privileged' | 'db_unreachable' | 'db_encoding' | 'schema_behind'
      | 'tenant_not_found' | 'tenant_suspended' | 'lock_held' | 'image_sop_invalid'
      | 'no_published_sop' | 'integrity' | 'renderer_nondeterministic' | 'contract_failed'
      | 'no_active_routes',
    detail: string,
  );
}

/** 仅供自测：卸下配置源、清空缓存，回到文件模式 */
export const __configTest: { reset(): void };
```

启动顺序：

```ts
// src/boot.ts
export interface BootDeps {
  initConfig(): Promise<void>; // 生产：先校验 CONFIG_SOURCE（非法值报 env_invalid）；是 db 就 productionConfigDeps 再 initConfig(deps)，否则 initConfig(null)
  serve(onListening: () => void): void;
  preflight(): void; // 现有的数据文件启动预检
  buildIndex(): Promise<void>;
  startFollowUpScheduler(): void;
  startWecom(): void;
  exit(code: number): void;
}
/** await initConfig → serve → 监听成功后依次 preflight、buildIndex、startFollowUpScheduler、startWecom。
 *  initConfig reject 时打印 reason 与 detail，exit(1)，其余一个都不调 */
export function boot(deps: BootDeps): Promise<void>;
// server.ts：if (!SELFTEST) await boot({...})。startWecom() 从模块顶层挪进 boot
```

引擎和工具只改函数体，签名不变：

```ts
// src/engine.ts
function buildSystemPrompt(): string {
  return configMode() === 'db' ? currentSop().renderedPrompt : renderSystemPrompt(loadSop());
}
// promptPrefix().system 与 __engineTest.buildSystemPrompt 都经由它；promptPrefix().tools = JSON.stringify(toolDefs)，两种模式相同

// src/tools.ts
export function loadRoutes(): Route[]; // db 模式：currentCatalog().routes；文件模式：JSON.parse 后 deep-freeze。类型仍是 Route[]，写入在运行时抛 TypeError
export function loadHotels(): Hotel[]; // 同上
```

DB 模式下，那五处 `try { loadRoutes() } catch {}` 由启动顺序保证不会碰到 `ConfigNotReadyError`；另外把它们收窄成只吞文件解析错误，`ConfigNotReadyError` 照常抛出。

**锁丢失。** 锁连接开 TCP keepalive（10 秒）。连接断开时进入 `lost` 状态：配置写入一律抛 `ConfigLockLostError`，对话照常（每轮不查库）；每 5 秒调一次 `reacquire()`。结果是 `ok` 就恢复；`unreachable` 继续重试；`held_by_other` 说明另一个进程已经接管，调 `gracefulExit(1)`：先跑全部停机钩子（等在途的企微回复发完、会话落盘），再退出。进入停机之后忽略锁连接的一切事件。连接池和锁连接在其他停机钩子都结束之后才关闭：`store.ts` 的 `onShutdown` 加一个 `{ phase: 'late' }` 选项，late 钩子在普通钩子全部结束后才跑，仍在同一个 8 秒上限内。

环境变量：

| 变量                                                                                         | 进哪个 compose 服务                                | 说明                                                               |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `CONFIG_SOURCE`                                                                              | app                                                | `db` 开启 DB 模式；未设、空串、`file` 都是文件模式；其他值拒绝启动 |
| `DATABASE_URL`                                                                               | app（应用与 import / export / catalog-fix 命令行） | `agent_app` 的连接串，只接受 `postgres://` 和 `postgresql://`      |
| `DEFAULT_TENANT_SLUG`                                                                        | app                                                | 本实例的租户。DB 模式下必填                                        |
| `DEPLOY_PROFILE`                                                                             | app                                                | 00 定义。DB 模式下必须显式设置，不接受缺省的 demo                  |
| `DATABASE_OWNER_URL`                                                                         | migrate                                            | `agent_owner`，只用来跑迁移                                        |
| `DATABASE_PLATFORM_URL`                                                                      | platform                                           | `agent_platform`，用于租户与账号命令行                             |
| `POSTGRES_PASSWORD`、`AGENT_OWNER_PASSWORD`、`AGENT_APP_PASSWORD`、`AGENT_PLATFORM_PASSWORD` | db                                                 | 超级用户与三个角色的口令，只在 db 容器里                           |
| `PG_TEST_URL`                                                                                | CI 与本地 `test`                                   | 真实 Postgres 的超级用户连接串。RLS 套件用它自己建库、建角色       |

- 开发机同样适用：迁移和平台命令行的连接串不写进 `.env`，而是在命令行前临时给出。
- DB 模式下如果还设了 `SOP_PATH`、`ROUTES_PATH` 或 `HOTELS_PATH`，启动时打一条 warn 并忽略它们。这三个变量只供文件模式使用（测试夹具，以及「切换后的真相来源」里的回归跑法）。
- `/healthz` 增加 `config: { mode, sopVersion: number | null, promptHash, toolsHash, prefixHash, sopHash, lock, sopStale, catalogStale }`，哈希都取前 12 位。文件模式下 `sopVersion` 为 null、`lock` 为 null，哈希按当前文件现算。

### SOP：节表、渲染、版本、发布闸

#### 节表

| key                | 标题（`## ` 之后的原文）                        | 锁定 | 代码依赖                                                                                                                     |
| ------------------ | ----------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `preamble`         | 第一个 `## ` 之前的全部内容，含 `# ` 标题行     | 否   | —                                                                                                                            |
| `stages`           | 各阶段目标                                      | 是   | 报价时机、节假日算日期、细节只按原文答、`payUrl` / `altitudeNote` / `intensityNote` 这些字段的用法（engine.selftest 有断言） |
| `orders`           | 订单：改单、给别人再订、重发链接                | 是   | `create_order` 的改单语义与 `supersededOrderId`                                                                              |
| `tone`             | 话术原则                                        | 否   | —                                                                                                                            |
| `quote-discipline` | 报价纪律（硬性）                                | 是   | `overBudget` / `withinBudget`、按总价比预算（有断言）                                                                        |
| `price-rules`      | 定价规则（只有这两条，硬性）                    | 是   | 与 `createQuote`、价格护栏是同一套规则（有断言）                                                                             |
| `objections`       | 异议处理                                        | 否   | —                                                                                                                            |
| `capabilities`     | 能力边界（硬性，先看这条）                      | 是   | 天数与住宿固定、顾问在微信上联系（有断言）                                                                                   |
| `no-destinations`  | 我们没有的目的地（如南极、冰岛）                | 是   | `destinationMiss`、坚持才转人工（有断言）                                                                                    |
| `handoff`          | 转人工条件（满足任一立即调用 handoff_to_human） | 是   | 与 `isHandoffIntent`、`handoff_to_human` 的口径一致                                                                          |
| `wechat-style`     | 微信语气规范                                    | 否   | —                                                                                                                            |

#### 切分、拼接与规范化

```ts
// src/sop/sections.ts —— 纯函数，无 I/O
export interface SectionSpec {
  key: string;
  /** 标题行去掉「## 」后的原文，逐字节比较；前言为 null */
  heading: string | null;
  /** true：代码依赖它。01 里不可编辑，DB 模式下内容以镜像里的 data/sop.md 为准 */
  locked: boolean;
}
export const TRAVEL_SOP_SECTIONS: readonly SectionSpec[];

/** text 从标题行开始（前言从文件开头开始），到下一个「## 」行之前结束，含结尾的换行 */
export interface SopSection {
  key: string;
  text: string;
}

export function splitSop(md: string, spec?: readonly SectionSpec[]): SopSection[];
export function joinSop(sections: readonly SopSection[]): string;
/** 正文：标题行及其后一个空行之后的部分；前言的正文就是整段 text */
export function sectionBody(section: SopSection, spec: SectionSpec): string;
/** `## ${heading}\n\n` + normalizeBody(body, isLast)；前言没有标题行 */
export function withBody(spec: SectionSpec, body: string, isLast: boolean): SopSection;
export function normalizeBody(body: string, isLast: boolean): string;
/** 按当前节表合并：锁定节取 image；可编辑节优先取 stored 里同 key 的，stored 没有时取 image */
export function mergeWithImage(stored: readonly SopSection[], image: readonly SopSection[], spec?: readonly SectionSpec[]): SopSection[];
/** 可编辑节正文的总长度（UTF-16 码元，即 String.length） */
export function editableChars(sections: readonly SopSection[], spec?: readonly SectionSpec[]): number;
/** 编码检查，不合格抛 SopEncodingError */
export function assertSopEncoding(text: string): void;

export class SopStructureError extends Error {} // 标题序列与节表不符；标题后缺空行；正文为空；正文里出现行首「## 」；某节不是规范形
export class SopEncodingError extends Error {} // 见下
```

- 只认行首的 `## `。切出的标题序列必须和节表逐条相同，每个标题行之后必须紧跟一个空行，否则抛 `SopStructureError`。
- 编码检查（`assertSopEncoding`）拒绝：BOM；`\r`；不是 NFC；`!text.isWellFormed()`（孤立代理项）；除 `\n` 和 `\t` 以外的 C0 控制字符（含 NUL）；U+2028 / U+2029。
- 正文依次这样规范化：去 BOM；`\r\n` 和 `\r` 换成 `\n`；转 NFC；去掉每一行的行尾空白；去掉开头的空行；去掉末尾空白；再补上结尾，非末节补 `\n\n`，末节补 `\n`。规范化之后再过一遍编码检查，孤立代理项、控制字符和行分隔符不做替换，直接拒绝。
- 导入不改写任何字节：文件先过编码检查，再要求每一节都已经是规范形（`normalizeBody(body) === body`），否则拒绝。`data/sop.md` 的每一节已经是这个形状。
- 后台只提交可编辑节的正文。把 GET 到的正文原样 PUT 回去，`sections` 和所有哈希都不变。
- 正文不能为空，也不许出现行首 `## `，否则导出后再导入会多切出一节。
- 仓库加 `.gitattributes`：`data/sop.md` 与 `data/*.json` 设 `text eol=lf`，避免 Windows 检出时混进 CRLF。

#### 渲染与哈希

```ts
// src/prompt/system.ts —— 从 buildSystemPrompt 拆出，纯函数：不读 profile、环境变量、时间
export function renderSystemPrompt(sop: string): string;
```

- `rendered_prompt = renderSystemPrompt(joinSop(sections))`。
- `prompt_hash = sha256(UTF-8(rendered_prompt))`；`tools_hash = sha256(UTF-8(promptPrefix().tools))`；`prefix_hash = sha256(UTF-8(tools_hash + prompt_hash))`，两段十六进制串直接相连；`sop_hash = sha256(UTF-8(joinSop(sections)))`。
- `prefix_hash` 对应模型看到的整个固定前缀，只在同一代码版本内比较有意义；跨代码版本核对「SOP 内容有没有丢」用 `sop_hash`。
- 每个已发布版本另存 `render_inputs`：`{ hardRulesHash, imageSopHash, sectionTableHash, toolsHash }`。`hardRulesHash = sha256(renderSystemPrompt(''))`，`imageSopHash` 是镜像 `data/sop.md` 的 sha256，`sectionTableHash` 是 `JSON.stringify(TRAVEL_SOP_SECTIONS)` 的 sha256。启动重渲染据此判断是哪类输入变了。
- 每轮的 `system` 是缓存里的 `renderedPrompt`。一轮之内的多次模型调用用的是同一个字符串。发布只影响之后开始的轮次。
- 每轮可追溯：DB 模式下引擎每轮结束时打一行日志，带 `sopVersion` 和 `prefixHash` 前 12 位；现有的慢轮日志两种模式都带上这两个字段（文件模式的 `sopVersion` 记 `file`）。02 的逐轮 trace 沿用这两个字段名。

#### 契约检查（发布闸 v0）

```ts
// src/sop/contract.ts —— 纯数据加纯函数，不 import 引擎
export type ContractRule =
  | { id: string; kind: 'include'; text: string; from: string }
  | { id: string; kind: 'exclude'; text: string; from: string }
  | { id: string; kind: 'exclude-pattern'; pattern: RegExp; from: string };

/** engine.selftest.ts 里对 buildSystemPrompt() 结果的每一条短语断言，原文照抄；from 写场景名 */
export const SOP_CONTRACT: readonly ContractRule[];
/** SOP 可以点名的字段：工具参数和工具结果里真实存在的字段名，如 destinationMiss、intensityNote、payUrl、withinBudget */
export const SOP_KNOWN_FIELDS: readonly string[];
/** 产出工具参数与结果字段的源文件。漂移测试只认这份列表 */
export const KNOWN_FIELD_SOURCES: readonly ['src/tools.ts', 'src/price-rules.ts'];
export const BUDGET_RATIO = 1.2;

export type ViolationCode =
  | 'structure' // 节表不符、标题被改、正文为空、正文里出现行首「## 」
  | 'locked_changed' // 锁定节与镜像不一致
  | 'phrase_missing'
  | 'phrase_forbidden'
  | 'unknown_tool' // snake_case 标识符不是现有工具名
  | 'unknown_field' // camelCase 标识符不在 knownFields 里
  | 'over_budget'; // 可编辑节正文总长 > 基线 × BUDGET_RATIO

export interface ContractViolation {
  code: ViolationCode;
  sectionKey: string | null;
  detail: string;
}

export function checkSopContract(input: {
  sections: readonly SopSection[];
  imageSections: readonly SopSection[]; // 镜像 data/sop.md 切出的节
  rendered: string; // render(joinSop(sections))
  toolNames: readonly string[]; // toolDefs 里的 function.name
  knownFields: readonly string[];
  /** 该租户导入版本（source='import'）的 editableChars。null 表示不查预算：启动重渲染和导出都传 null */
  baselineEditableChars: number | null;
}): ContractViolation[];
```

- 短语规则对整段 `rendered` 执行，和 selftest 的断言对象相同。
- 标识符扫描覆盖每一节的标题与正文：`/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/` 必须是工具名，`/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/` 必须在 `knownFields` 里。大写开头的词（酒店品牌名等）和纯小写单词（`greeting`、`emoji`）不查。
- 预算只管运营能控制的部分，即可编辑节的正文；代码拥有的锁定节和硬性要求变长，不占运营的余量。
- 清单不会自己漂移，有三个测试守着：
  - 源码扫描：`engine.selftest.ts` 里 `sys.includes('…')`、`sop.includes('…')`、`/…/.test(sys)` 的每一处字面量，都必须在 `SOP_CONTRACT` 里。
  - `SOP_KNOWN_FIELDS` 的每一项都必须以标识符的形式出现在 `KNOWN_FIELD_SOURCES` 的某个文件里。
  - 对当前 `data/sop.md` 跑 `checkSopContract`（预算传 null），结果为零条 violation。工具字段改名、SOP 点名了新字段，CI 当场就红，不会拖到线上启动时才发现。
- 由于要求出现的短语都在锁定节里，在 01 里真正拦住运营编辑的是「不许出现」、工具名与字段名、结构与预算。「要求出现」这一类防的是将来有人改锁定表，以及代码部署改了锁定节。

#### 版本与发布

状态只有四种迁移：`draft → draft`（改草稿或 rebase）、`draft → published`、`draft → discarded`（丢弃）、`published → archived`。其余一律由触发器拒绝。版本号在发布时才分配：草稿和丢弃的行没有版本号，已发布版本号按发布顺序严格递增。

```ts
// src/config/sop.ts
export type SopStatus = 'draft' | 'published' | 'archived' | 'discarded';
export type SopSource = 'import' | 'console' | 'rollback' | 'rerender';

export interface SopVersion {
  id: string;
  versionNo: number | null;        // draft 与 discarded 为 null
  status: SopStatus;
  source: SopSource;
  sections: SopSection[];          // 与当时镜像合并之后的全部节
  basedOn: string | null;
  rev: number;
  promptHash: string | null;
  toolsHash: string | null;
  prefixHash: string | null;
  sopHash: string | null;
  changeNote: string | null;
  createdByName: string | null;
  createdAt: string;
  publishedByName: string | null;
  publishedAt: string | null;
}

export function getSopOverview(ctx: TenantCtx): Promise<{
  published: SopVersion;
  draft: (SopVersion & { stale: boolean }) | null; // stale：basedOn 已不是当前发布版本
  spec: readonly SectionSpec[];
  budget: { chars: number; limit: number };
}>;
/** 只列 published 与 archived，按 versionNo 倒序；limit ≤ 100 */
export function listSopVersions(ctx: TenantCtx, q: { limit: number; beforeVersionNo?: number }): Promise<SopVersion[]>;
/** 没有草稿时，以 basedOn 新建一份（basedOn 必须是当前已发布版本）；已有草稿时 rev 必须相等。edits 只能点名可编辑节 */
export function saveSopDraft(ctx: TenantCtx, input: {
  basedOn: string;
  rev: number | null;
  edits: readonly { key: string; body: string }[];
}): Promise<SopVersion>;
/** 不写库。返回按当前镜像合并、必要时 rebase 之后的结果 */
export function checkSopDraft(ctx: TenantCtx): Promise<{
  promptHash: string; prefixHash: string; chars: number; limit: number;
  violations: ContractViolation[];
  rebase: { needed: boolean; conflicts: string[] };
}>;
export function publishSopDraft(ctx: TenantCtx, input: { rev: number; changeNote: string }): Promise<SopVersion>;
export function discardSopDraft(ctx: TenantCtx, input: { rev: number }): Promise<void>;
/** 取 versionId（必须是 published 或 archived）的可编辑节，锁定节取镜像，新建并发布一个版本（source='rollback'），同样要过契约检查 */
export function rollbackSop(ctx: TenantCtx, input: { versionId: string; changeNote: string }): Promise<SopVersion & { sameHashAsTarget: boolean }>;

export class SopConflictError extends Error { constructor(readonly keys: string[], readonly current: SopSection[]) } // → 409，带当前发布版本的可编辑节
export class SopLockedSectionError extends Error { constructor(readonly key: string) }                           // → 422
export class SopContractError extends Error { constructor(readonly violations: ContractViolation[]) }           // → 422
export class SopNotFoundError extends Error {}                                                                     // → 404
```

每个函数自己开一个 `withTenant(db, ctx, tx => …)` 事务，第一条语句取本租户的配置写锁（见「withTenant」），同一租户的配置写入因此串行。仓储函数显式接收 `tx`；审计函数从 AsyncLocalStorage 取操作者。发布在一个事务里完成：

1. 对草稿行 `SELECT … FOR UPDATE`，核对 `rev`。
2. 草稿的 `based_on` 不是当前已发布版本时，只比较可编辑节，三方判定：`base` 是 `based_on` 版本，`cur` 是当前发布版本，`mine` 是草稿。上游改过的 key（`base ≠ cur`）和草稿改过的 key（`base ≠ mine`）没有交集时，自动 rebase：上游改过的 key 取 `cur` 的正文，`based_on` 改成当前版本；有交集时抛 `SopConflictError`，点名冲突的 key。锁定节不参与判定：它们在发布时本来就取镜像。
3. 草稿的节与镜像做 `mergeWithImage`，渲染，跑契约检查；有 violation 就抛 `SopContractError`。
4. 把当前 published 改成 archived；把草稿改成 published，写入 `sections = merged`、分配 `version_no = max + 1`，写四个哈希、`render_inputs`、`published_by`、`published_by_name`、`published_at`。
5. 写一行 `sop.publish` 审计。
6. COMMIT。**提交成功之后**，用写入的行构造 `PublishedSop` 调 `replacePublishedSop()`；提交失败时缓存不动；COMMIT 抛错而结果不明时调 `reloadFromDb()`。

回滚走同样的第 3–6 步，只是直接插入一行 published。回滚不碰已有的草稿：草稿的 `based_on` 从此过期，再发布时按第 2 步处理。回滚结果的 `prompt_hash` 等于目标版本的，前提是目标版本之后硬性要求、锁定节和工具定义都没变；变过时 `sameHashAsTarget` 为 false，界面提示「哈希会与该版本不同」。

导入、后台发布、回滚、启动重渲染这四条写路径，存进 `sections` 的都是 `mergeWithImage` 之后的全部节，所以任何一行都满足 `rendered_prompt === render(joinSop(sections))`。

#### 启动重渲染

`initConfig()` 读到已发布版本 `pub` 后，依次执行（第 1–6 步只读）：

1. 完整性：`sha256(pub.rendered_prompt) === pub.prompt_hash`，`sha256(joinSop(pub.sections)) === pub.sop_hash`，否则 `integrity`。
2. `merged = mergeWithImage(pub.sections, imageSections)`；`rendered = render(joinSop(merged))`。
3. 再渲染一遍，两次结果不同就 `renderer_nondeterministic`。
4. 对 `merged` 跑契约检查（预算传 null）。有 violation 就 `contract_failed`，打印全部 violation。这一步不论字节是否变化都做：删掉或改名一个工具、一个字段，不会改动 system 的字节，却会让已发布的 SOP 指挥模型去用不存在的东西。
5. `rendered === pub.rendered_prompt` 且 `toolsHash === pub.tools_hash`：直接用存下的行。
6. 否则比较当前的 `render_inputs` 和 `pub.render_inputs`。完全相同却渲染出不同结果，说明渲染不确定，报 `renderer_nondeterministic`。有差异就记下 `causes`（`hard_rules`、`locked_sections`、`section_table`、`tools` 中变了的那几项），留给 `initConfig` 的第 9 步写入。
7. 装载产品库、打印差异（`initConfig` 的第 7、8 步）。
8. 以上全部通过后，才写 rerender：在一个事务里新建并发布一个 `source='rerender'` 的版本，运营编辑过的可编辑节原样保留；写一行 `actor_kind='system'` 的 `sop.rerender` 审计，`diff` 里写明 `causes` 和新旧 `prompt_hash`。

一次失败的部署最多留下两个 rerender 版本：新镜像写一个，健康检查失败后 `:prev` 起来再写一个反向的。反向那个的 `prompt_hash` 等于原来的，缓存照样命中；草稿的冲突只比较可编辑节，不受影响。

### 产品库：存储、快照、编辑、检索

#### 存储

每个条目一行，`payload` 就是文件里那个对象本身。列类型用 `json`，因为 `json` 原样保存输入文本，读出后 `JSON.parse` 的键序与写入时相同；`jsonb` 会按键长和字节重排键序。`ord` 记住它在文件数组里的位置。node-postgres 和 PGlite 对 `json` 列默认都用 `JSON.parse` 解析，这一点由真实 PG 上的字节等价测试证实，不只靠断言。

导入时，每条先用 `RouteSchema` / `HotelSchema` 校验，校验通过后写库的仍是**原对象**，不是 zod 的输出。zod 的输出会按 schema 的顺序重排键。

#### 快照

- 快照只含 active 条目，按 `(kind, ord)` 读出后递归 `Object.freeze`。
- `loadRoutes()` / `loadHotels()` 在 DB 模式下返回快照里的数组本身，不做拷贝；文件模式下对 `JSON.parse` 的结果也 deep-freeze。字节不变，现有 6 组自测和 eval 因此都跑在冻结数据上，漏网的原地修改在 CI 里就会抛 `TypeError`。
- 已知唯一的原地修改是 `searchHotels` 无过滤时的 `sort`，改成 `[...list].sort(...)`，结果不变。
- 产品库写接口在事务提交之后，用 `RETURNING` 拿回的行调 `applyCatalogRow()`，快照更新完才返回 200。单副本、单写者，结果是确定的，不从库里重读。COMMIT 抛错而结果不明时调 `reloadFromDb()`，重读失败期间 `/healthz` 与 `/status` 报 `catalogStale: true`，按 5 秒、30 秒、2 分钟退避重试。
- 快照每次变化都回调 `onCatalogChanged`。

#### 编辑规则

```ts
// src/shared/catalog.ts —— 只依赖 zod 与 src/shared/**
export type CatalogKind = 'route' | 'hotel';
/**
 * 所有已知键都声明（含 overseas），顶层和嵌套对象一律 strict，未知键 422。
 * 不用 z.coerce；数值字段用 z.number().int()；可选的字符串与数组不接受空值，空的可选字段就是键不存在。
 * bestSeason 必须能被 peakMonths 解析出至少一个月份，或者含「全年」。
 * itinerary 至少一项，条数等于 days。
 */
export const RouteSchema: z.ZodType<Route>;
export const HotelSchema: z.ZodType<Hotel>;

/** 任何状态下都不可改 */
export const ALWAYS_LOCKED: readonly ['id'];
/** active 条目不可改的字段。'tags:国内' 指 tags 里「国内」这一项的有无 */
export const LOCKED_WHEN_ACTIVE: {
  readonly route: readonly [
    'id', 'title', 'destination', 'days', 'priceFrom', 'bestSeason',
    'segments', 'aliases', 'maxAltitude', 'overseas', 'tags:国内', 'inclusions', 'exclusions',
  ];
  readonly hotel: readonly ['id', 'name', 'destination', 'nightlyFrom'];
};
export function lockedFieldChanges(kind: CatalogKind, status: 'draft' | 'active', prev: object, next: object): string[];
/**
 * 递归合并键序：对象按 prev 的键序，prev 里原有的键保持原位，next 新增的键按 next 的顺序追加在后面，
 * next 删掉的键去掉；数组按下标对齐元素，再逐项递归
 */
export function mergeKeyOrder<T>(prev: T, next: T): T;

// src/config/catalog.ts
export interface CatalogItem {
  kind: CatalogKind;
  code: string;
  ord: number;
  status: 'draft' | 'active';
  rev: number;
  payload: Route | Hotel;
  updatedByName: string | null;
  updatedAt: string;
}
/** 字段级补丁：set 里点名的顶层字段整体替换，unset 里的字段删除，没点名的一律不动 */
export interface CatalogPatch { rev: number; set: Record<string, unknown>; unset?: string[] }

export function listCatalog(ctx: TenantCtx, kind: CatalogKind): Promise<CatalogItem[]>; // 按 ord 排序；v0 条目只有几十条，不分页
export function getCatalogItem(ctx: TenantCtx, kind: CatalogKind, code: string): Promise<CatalogItem | null>;
/** 新条目为 draft，ord 取该 kind 的最大 ord 加 1 */
export function createCatalogItem(ctx: TenantCtx, kind: CatalogKind, payload: unknown): Promise<CatalogItem>;
export function updateCatalogItem(ctx: TenantCtx, kind: CatalogKind, code: string, patch: CatalogPatch): Promise<CatalogItem>;
export function activateCatalogItem(ctx: TenantCtx, kind: CatalogKind, code: string, input: { rev: number }): Promise<CatalogItem>;

export class CatalogValidationError extends Error { constructor(readonly issues: { path: string; message: string }[]) } // → 422
export class CatalogLockedFieldError extends Error { constructor(readonly fields: string[]) }                           // → 422
export class CatalogRevConflictError extends Error {}                                                                  // → 409
export class CatalogCodeTakenError extends Error {}                                                                    // → 409 catalog_code_taken
export class CatalogNotFoundError extends Error {}                                                                     // → 404
```

各字段为什么锁：

- `priceFrom`、`bestSeason`、`nightlyFrom`：`createQuote` 用前两个算价，价格护栏用它们放行金额。已发出的方案书按当前数据重算，一改就变价。
- `inclusions`、`exclusions`：商业条款。价格不变而含什么、不含什么变了，对已发出的方案书同样是实质变更。
- `segments`、`maxAltitude`、`overseas`、tags 里的「国内」：它们决定推荐和护栏，包括长辈低海拔替代、境内外过滤、价格护栏认线路的范围。
- `title`、`destination`、`days`、`aliases`、酒店的 `name`：引擎和护栏靠它们认出「客户或模型在说哪条线、哪家酒店」，改名会让对话历史里的旧说法认不出来。
- `id`：方案书链接、订单和 eval 夹具都引用它，任何状态下都不改。

其余字段可以改：`highlights`、`hotelLevel`、`itinerary`（条数必须仍等于 `days`）、`intensity`、酒店的 `stars` / `roomType` / `highlights`，以及除「国内」以外的 tags。代价是已发出的方案书会显示改后的行程文案，但价格和条款不变；行程也要冻结，得等 02 的报价快照。

写入规则：

- 每个写函数在 `withTenant` 里第一句取本租户的配置写锁；唯一约束冲突（23505）一律映射成 409，`code` 已存在时报 `catalog_code_taken`。
- 更新时 `WHERE rev = $expected`，影响 0 行就抛 `CatalogRevConflictError`。`rev` 加 1 和 `updated_at` 由触发器负责。
- 锁定字段（active 条目按 `LOCKED_WHEN_ACTIVE`，任何条目按 `ALWAYS_LOCKED`）有变化，就抛 `CatalogLockedFieldError`，逐个点名字段。`unset` 只能点名非锁定的可选字段。
- 写库对象是 `mergeKeyOrder(旧 payload, 旧 payload 应用补丁之后的对象)`，补丁里的值取请求原文，不取 zod 的输出；合并后的整条再过一遍 schema。
- 上架（draft → active）要求重新过一遍 schema。界面上的二次确认写明：上架后计价、识别和条款字段只能停机用命令行修正。
- 接口上没有下架和删除。
- 每次写入都记一行审计，`diff` 里只放变了的顶层字段 `{ 字段: [旧, 新] }`。
- 产品库文本对公开页（方案书、支付页）一律是不可信输入：页面插值一律转义，数值字段先过 `Number()`。

#### 检索

```ts
// src/retrieval.ts（新增与改动的部分）
/** 标记当前索引对应的产品库已过期，并安排一次重建。旧索引继续服务，直到新索引就绪。文件模式下什么都不做 */
export function invalidateIndex(): void;
/** 语义不变：幂等，失败不抛。过期后再调用会全量重建 */
export function buildIndex(): Promise<void>;
/** { indexGeneration, snapshotGeneration, lastError } 供 /status */
export function indexHealth(): IndexHealth;
```

- `retrieval.ts` 加载时注册 `onCatalogChanged(() => { invalidateIndex(); void buildIndex(); })`。
- 每次构建开始时记下快照的 `generation`。构建结束时如果 `generation` 已经变了，丢弃这次结果，按新快照再建一次。
- 构建失败时保留过期标记，按 30 秒、2 分钟、10 分钟退避重试，之后每 10 分钟一次。
- 磁盘缓存的格式和键（整库内容指纹）不变，写入改成先写临时文件再 rename。文件模式下的行为和缓存文件与开工时相同。
- 索引按快照顺序排列；01 没有下架，旧索引里的 id 都还在快照里。

### 数据库

#### 角色

| 角色             | 连接串                  | 做什么                                                                                      |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `agent_owner`    | `DATABASE_OWNER_URL`    | 拥有库、全部表和函数，只跑迁移。不是超级用户，没有 BYPASSRLS；FORCE 之下它自己也受 RLS 约束 |
| `agent_app`      | `DATABASE_URL`          | 运行时，以及 import / export / catalog-fix。NOBYPASSRLS，不是任何表的属主                   |
| `agent_platform` | `DATABASE_PLATFORM_URL` | 租户与账号命令行。NOBYPASSRLS；写带租户的表时也走 `withTenant`                              |

三个运行时和命令行角色都不依赖 BYPASSRLS（ADR-001 第 3 个坑）。备份另用超级用户，见「备份与恢复」。01 没有跨租户读取的需求，所以不给 `agent_platform` 写全放行策略。

#### DDL

```sql
-- deploy/db-init/roles.sql：集群级，由 roles.sh 在 db 首次初始化时执行，口令经 psql 变量从 db 容器的环境读入。
-- roles.sh 可以重复执行：已存在的角色改用 ALTER ROLE … PASSWORD 只更新口令（轮换口令就是重跑一遍），已存在的库跳过。
-- RLS 套件读同一个文件，自己替换口令变量和库名后执行
CREATE ROLE agent_owner    LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD :'owner_password';
CREATE ROLE agent_app      LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'app_password';
CREATE ROLE agent_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'platform_password';
ALTER ROLE agent_app SET statement_timeout = '5s';
ALTER ROLE agent_app SET idle_in_transaction_session_timeout = '10s';   -- 不设 idle_session_timeout：锁连接平时就是空闲的
CREATE DATABASE agent OWNER agent_owner ENCODING 'UTF8' TEMPLATE template0;
REVOKE CONNECT, TEMPORARY ON DATABASE agent FROM PUBLIC;
GRANT CONNECT ON DATABASE agent TO agent_owner, agent_app, agent_platform;
-- 01 不建扩展。03 用到 pgvector 时由这里以超级用户建

-- ===== 以下在 drizzle 迁移里，以 agent_owner 执行 =====
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name       text NOT NULL,
  pack_id    text NOT NULL,                  -- 'travel'，决定 SOP 节表和产品库的 kind
  locale     text NOT NULL DEFAULT 'zh-CN',  -- 海外适配保留的缝，01 没有读方
  region     text NOT NULL DEFAULT 'CN',
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text NOT NULL,               -- 'scrypt$<logN>$<r>$<p>$<salt>$<hash>'（base64url），参数随哈希存
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL CHECK (role IN ('owner','admin','supervisor','agent','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE auth_sessions (
  token_hash   bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),  -- sha256(cookie 值)
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,          -- created_at + 7 天，绝对上限
  ip           inet,
  user_agent   text
);
CREATE INDEX auth_sessions_by_user ON auth_sessions (user_id);

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid REFERENCES users(id),
  actor_name    text,                         -- 写入时的 display_name 快照；列表不再查 users
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user','system','platform')),
  action        text NOT NULL,                -- 取值见「审计」
  target_type   text,
  target_id     text,
  diff          jsonb,
  ip            inet,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_by_tenant ON audit_log (tenant_id, id DESC);

CREATE TABLE sop_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  version_no        int CHECK (version_no > 0),   -- 发布时分配；draft 与 discarded 为 NULL
  status            text NOT NULL CHECK (status IN ('draft','published','archived','discarded')),
  source            text NOT NULL CHECK (source IN ('import','console','rollback','rerender')),
  pack_id           text NOT NULL,
  sections          jsonb NOT NULL,               -- [{"key":"preamble","text":"# …\n\n"}, …]；数组顺序就是拼接顺序
  based_on          uuid,
  rev               int  NOT NULL DEFAULT 1,      -- 草稿的乐观锁，由触发器加 1
  rendered_prompt   text,                         -- 整段 system prompt；draft 与 discarded 为 NULL
  prompt_hash       text CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  tools_hash        text CHECK (tools_hash  ~ '^[0-9a-f]{64}$'),
  prefix_hash       text CHECK (prefix_hash ~ '^[0-9a-f]{64}$'),
  sop_hash          text CHECK (sop_hash    ~ '^[0-9a-f]{64}$'),
  render_inputs     jsonb,                        -- { hardRulesHash, imageSopHash, sectionTableHash, toolsHash }
  change_note       text,
  created_by        uuid REFERENCES users(id),
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  published_by      uuid REFERENCES users(id),
  published_by_name text,
  published_at      timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version_no),
  FOREIGN KEY (tenant_id, based_on) REFERENCES sop_versions (tenant_id, id),
  CHECK ((status IN ('published','archived')) = (version_no IS NOT NULL)),
  CHECK ((status IN ('published','archived')) = (rendered_prompt IS NOT NULL)),
  CHECK (num_nulls(rendered_prompt, prompt_hash, tools_hash, prefix_hash, sop_hash, render_inputs) IN (0, 6)),
  CHECK (prompt_hash IS NULL OR prompt_hash = encode(sha256(convert_to(rendered_prompt, 'UTF8')), 'hex')),
  CHECK (prefix_hash IS NULL OR prefix_hash = encode(sha256(convert_to(tools_hash || prompt_hash, 'UTF8')), 'hex'))
);
CREATE UNIQUE INDEX sop_one_published ON sop_versions (tenant_id) WHERE status = 'published';
CREATE UNIQUE INDEX sop_one_draft     ON sop_versions (tenant_id) WHERE status = 'draft';

CREATE TABLE catalog_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN ('route','hotel')),
  code            text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,63}$'),   -- 'r-yunnan-mid'、'h-aman-tokyo'
  ord             int  NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active')),
  payload         json NOT NULL,                  -- 条目原对象；json 而非 jsonb，见「存储」
  rev             int  NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users(id),
  updated_by      uuid REFERENCES users(id),
  updated_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, code),
  UNIQUE (tenant_id, kind, ord),
  CHECK (json_typeof(payload) = 'object' AND coalesce(payload->>'id' = code, false))
);
```

三个触发器，违反时 `RAISE … USING ERRCODE = 'check_violation'`：

- `sop_versions_guard_insert`（`BEFORE INSERT`）：新行只能是 `status='draft'`、`source='console'`、没有版本号；或者 `status='published'`、`source` 属于 `import`、`rollback`、`rerender`。
- `sop_versions_guard_update`（`BEFORE UPDATE`）：
  - `id`、`tenant_id`、`pack_id`、`source`、`created_*` 永不改变。
  - `version_no` 只能在 `draft → published` 这一步从 NULL 赋值一次，此外永不改变。
  - 状态迁移只允许上文列出的四种。
  - `OLD.status <> 'draft'` 时，除 `status` 以外的列一律不许变：`(to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')` 即拒绝。
  - `OLD.status = 'draft'` 时 `NEW.rev := OLD.rev + 1`。
- `catalog_items_guard`（`BEFORE UPDATE`）：
  - `tenant_id`、`kind`、`code`、`ord` 永不改变。
  - `OLD.status = 'active'` 时 `NEW.status` 必须仍是 `active`。
  - `NEW.rev := OLD.rev + 1`，`NEW.updated_at := now()`。

计价与识别字段的锁定是 v0 的临时策略，02 要放开，所以放在服务端做，不写成触发器。

#### RLS、授权与认证函数

```sql
-- 对 memberships、sop_versions、catalog_items、audit_log 各执行一遍：
-- public schema 里所有带 tenant_id 列的表都套这个模板，豁免清单只有 auth_sessions（登录时还不知道租户）
ALTER TABLE sop_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sop_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sop_versions
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT USAGE ON SCHEMA public TO agent_app, agent_platform;
GRANT SELECT ON tenants TO agent_app;
GRANT SELECT, INSERT, UPDATE ON sop_versions, catalog_items TO agent_app;          -- 没有 DELETE
GRANT SELECT, INSERT ON audit_log TO agent_app, agent_platform;                    -- 没有 UPDATE / DELETE
GRANT SELECT, INSERT ON tenants TO agent_platform;
GRANT SELECT, INSERT, UPDATE ON users TO agent_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO agent_platform;            -- 受 RLS，要经 withTenant
GRANT SELECT, DELETE ON auth_sessions TO agent_platform;                           -- 改口令、停用、移除成员时吊销会话
GRANT USAGE ON SCHEMA drizzle TO agent_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO agent_app;                         -- 启动时核对迁移
ALTER DEFAULT PRIVILEGES FOR ROLE agent_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 认证函数：属主 agent_owner，SECURITY DEFINER，SET search_path = pg_catalog, public, pg_temp（pg_temp 显式放在最后）；
-- 函数体内的表名一律写全限定名（public.users）。只 GRANT EXECUTE 给 agent_app。
-- 每个函数开头：记下 current_setting('app.tenant_id', true) 的原值；原值非空且不等于 p_tenant 就报错；
-- 否则 set_config('app.tenant_id', p_tenant::text, true)，这样才能在 FORCE 之下读到 memberships；返回前恢复原值。
-- 租户 status = 'suspended' 时，lookup 与 touch 一律返回空。
auth_login_lookup(p_tenant uuid, p_email text)
  RETURNS TABLE (o_user_id uuid, o_password_hash text, o_role text, o_display_name text)
  -- 只返回 p_tenant 的成员、未停用的账号；邮箱按 lower() 匹配
auth_session_create(p_tenant uuid, p_token_hash bytea, p_user_id uuid, p_now timestamptz, p_ip inet, p_user_agent text)
  RETURNS void
  -- expires_at = p_now + 7 天；顺手删掉该用户已过期的会话
auth_session_touch(p_tenant uuid, p_token_hash bytea, p_now timestamptz)
  RETURNS TABLE (o_user_id uuid, o_role text, o_display_name text)
  -- 以下情况删行并返回空：p_now - last_seen_at > 12 小时，或 p_now > expires_at。
  -- 以下情况只返回空：会话属于别的租户、账号已停用、已不是成员、租户已停用。
  -- last_seen_at 距 p_now 超过 1 分钟才更新，避免每个请求都写一次
auth_session_delete(p_token_hash bytea) RETURNS void
auth_password_rehash(p_tenant uuid, p_user_id uuid, p_old_hash text, p_new_hash text) RETURNS boolean
  -- 登录成功时把旧参数的哈希升级成新参数；只有库里的哈希仍等于 p_old_hash 才替换，避免覆盖并发的改口令
```

各角色对各表的期望（RLS 套件逐格断言）：

| 表                              | `agent_app`            | `agent_platform`               | `agent_owner`       |
| ------------------------------- | ---------------------- | ------------------------------ | ------------------- |
| `tenants`（无 RLS）             | SELECT                 | SELECT、INSERT                 | 属主                |
| `users`（无 RLS）               | 无权限                 | SELECT、INSERT、UPDATE         | 属主                |
| `auth_sessions`（无 RLS，豁免） | 无权限                 | SELECT、DELETE                 | 属主                |
| `memberships`（RLS）            | 无权限                 | SELECT、INSERT、UPDATE、DELETE | 属主，受 FORCE 约束 |
| `sop_versions`（RLS）           | SELECT、INSERT、UPDATE | 无权限                         | 属主，受 FORCE 约束 |
| `catalog_items`（RLS）          | SELECT、INSERT、UPDATE | 无权限                         | 属主，受 FORCE 约束 |
| `audit_log`（RLS）              | SELECT、INSERT         | SELECT、INSERT                 | 属主，受 FORCE 约束 |

对 RLS 表：有权限的格子，没设租户时 SELECT 得到 0 行、INSERT 被 RLS 拒绝；「无权限」的格子报 permission denied。

#### withTenant

```ts
// src/db/client.ts
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
/** 两个驱动共同的基类，node-postgres 与 PGlite 都满足；第 2 步先用 typecheck 验证 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = PgTransaction<PgQueryResultHKT, typeof schema>;

export interface TenantCtx {
  tenantId: string;
  actor: { kind: 'user' | 'system' | 'platform'; userId: string | null; name: string | null; ip: string | null };
}

/** 只接受 postgres:// 与 postgresql://；PGlite 只经 testing.ts 进来 */
export function openDb(url: string): Promise<{ db: Db; close(): Promise<void> }>;
/**
 * 租户数据的唯一入口：BEGIN → 断言会话级的 app.tenant_id 为空（不为空说明有人在会话级 SET 过，销毁这条连接并抛错）
 * → SELECT set_config('app.tenant_id', $1, true) → fn → COMMIT；fn 抛错就 ROLLBACK。
 * ctx 经 AsyncLocalStorage 传给 fn 里调用的仓储与审计函数（ADR-001）。
 * 在 withTenant 里再嵌套 withTenant 会抛错，不管租户是否相同。
 */
export function withTenant<T>(
  db: Db,
  ctx: TenantCtx,
  fn: (tx: Tx) => Promise<T>,
  opts?: { isolation?: 'read committed' | 'repeatable read'; readOnly?: boolean },
): Promise<T>;
/** 在 withTenant 之外调用即抛 */
export function currentTenantCtx(): TenantCtx;
/** 配置写锁：pg_advisory_xact_lock(hashtextextended('cfg:' || tenantId, 0))。每个 SOP 与产品库写函数的第一条语句 */
export function lockTenantConfig(tx: Tx): Promise<void>;
/** 进程启动以来发出的查询条数（drizzle logger 计数），供测试用 */
export function queryCount(): number;
/** 在一条专用连接上执行 pg_try_advisory_lock(hashtextextended('wecom-sales-agent:' || tenantId, 0))；拿不到返回 null */
export function holdTenantLock(url: string, tenantId: string, opts?: { keepAliveMs?: number }): Promise<TenantLock | null>;
```

#### 迁移纪律

- 表、索引、约束写在 `src/db/schema.ts`，由 drizzle-kit 生成 SQL。RLS、策略、触发器、函数和授权写在 `--custom` 迁移里。所有迁移文件提交进仓库，人工审阅。
- 租户内的表之间的外键一律带上 `tenant_id`（`sop_versions.based_on` 已经这样做）。外键检查以属主身份运行，不受 FORCE RLS 约束，单列外键拦不住跨租户引用。
- 迁移只增不删，上一版镜像必须能在新 schema 上读**和写**。`lint` 里的检查脚本拒绝没有标注的：`DROP`、`RENAME`、`ALTER … TYPE`；`ADD COLUMN … NOT NULL` 而没有 `DEFAULT`；`SET NOT NULL`；新增 `CHECK`；`CREATE OR REPLACE FUNCTION`；`DROP TRIGGER`；`ALTER POLICY`；`REVOKE`。
- 同一脚本和基准（`git merge-base HEAD origin/dev`）比较：已经存在的迁移文件被修改就失败；新迁移在 journal 里的 `when` 必须大于基准上最新的一条（drizzle 只应用比库里最后一条更晚的迁移，乱序的会被静默跳过）。取不到基准时 CI 下失败，本地只 warn。
- 迁移由 compose 里的一次性 `migrate` 任务以 `agent_owner` 执行。应用启动时只核对：镜像 journal 里每一条迁移的 hash 都在 `drizzle.__drizzle_migrations` 里，缺任何一条就报 `schema_behind`；库里比镜像多出来的迁移（来自更新的镜像）允许存在，只打一条 warn。回滚到 `:prev` 时正是这种情况。应用自己不跑迁移。

#### 审计

| action                                                                                                                                                     | 什么时候写           | actor_kind | diff                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.login` / `auth.logout`                                                                                                                               | 登录成功 / 登出      | user       | —                                                                                                                                           |
| `sop.publish`                                                                                                                                              | 发布草稿             | user       | `{ versionNo, changedKeys, rebasedFrom? }`                                                                                                  |
| `sop.rollback`                                                                                                                                             | 回滚                 | user       | `{ fromVersionNo, toVersionNo, targetVersionNo, sameHashAsTarget }`                                                                         |
| `sop.discard`                                                                                                                                              | 丢弃草稿             | user       | —                                                                                                                                           |
| `sop.rerender`                                                                                                                                             | 启动重渲染           | system     | `{ causes: ('hard_rules' \| 'locked_sections' \| 'section_table' \| 'tools')[], fromVersionNo, toVersionNo, oldPromptHash, newPromptHash }` |
| `config.import`                                                                                                                                            | 导入                 | platform   | `{ sections, routes, hotels }` 各自的条数                                                                                                   |
| `catalog.create` / `catalog.update` / `catalog.activate`                                                                                                   | 产品库写入           | user       | 变了的顶层字段                                                                                                                              |
| `catalog.locked_fix`                                                                                                                                       | `catalog-fix` 命令行 | platform   | 变了的顶层字段，加 `reason`                                                                                                                 |
| `platform.tenant_create` / `platform.user_create` / `platform.user_password` / `platform.user_disable` / `platform.member_role` / `platform.member_remove` | 平台命令行           | platform   | 永远不含口令                                                                                                                                |

保存草稿不记审计，这类记录太多也没有用。版本行本身记着创建人和发布人。登录失败只打日志，不进审计。

01 一个库一个租户，账号只属于这一个租户，平台命令行的审计记在 `--tenant` 指定的租户下。04 同库多租户时，改口令和停用要在账号所属的每个租户各写一行，那时平台角色才有跨租户读取。

### 鉴权

```ts
// src/auth/password.ts
/** 'scrypt$17$8$1$<salt>$<hash>'：N = 2^17、r = 8、p = 1、16 字节盐、64 字节输出（OWASP Password Storage Cheat Sheet 的 scrypt 下限） */
export function hashPassword(plain: string, opts?: { logN?: number; p?: number }): Promise<string>;
/** 参数从 stored 里取；比较用 timingSafeEqual。needsRehash：stored 的参数不是当前参数 */
export function verifyPassword(plain: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }>;

// src/auth/session.ts
export type Role = 'owner' | 'admin' | 'supervisor' | 'agent' | 'viewer';
export interface AuthedUser {
  userId: string;
  tenantId: string;
  role: Role;
  displayName: string;
  csrf: string;
}
export const IDLE_MS = 12 * 3_600_000;
export const ABSOLUTE_MS = 7 * 24 * 3_600_000;
export function login(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  now: number;
}): Promise<{ token: string; user: AuthedUser } | null>;
export function resolveSession(token: string, now: number): Promise<AuthedUser | null>;
export function logout(token: string): Promise<void>;
/** base64url(sha256('csrf:' + token))：从 token 派生，不另外存库 */
export function csrfFor(token: string): string;
```

- **口令。**
  - `crypto.scrypt` 的 `maxmem` 显式设为 256 MiB。N = 2^17 需要 128 MiB，而默认上限是 32 MiB，不改会直接报错。
  - 同一时刻最多跑 2 个 scrypt。槽满时排队，最多等 2 秒，仍拿不到才返回 429。libuv 线程池默认只有 4 条线程，全被占满会拖慢文件读写和 DNS。
  - 邮箱不存在时，也对一个假哈希跑一次校验。未知邮箱、密码错误、账号停用、不是本实例成员，这四种情况的状态码和响应体完全相同。
  - 校验通过且 `needsRehash` 时，用当前参数重新哈希，经 `auth_password_rehash` 写回。
- **会话。**
  - token 是 32 字节随机数，编码成 base64url 放进 cookie：`__Host-sid=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`，不带 `Domain`。
  - 库里只存 `sha256(token)`。
  - 空闲 12 小时、绝对 7 天过期。失效的会话在下一次被访问时删行。
  - 登出删行。命令行改口令、停用账号、移除成员时，删掉该用户的相应会话。
- **CSRF。** `/api/console/*` 的每个非 GET 请求都要过三道：
  - `sameOriginOnly`（沿用 `server.ts` 现有的中间件）；
  - 有效会话；
  - 请求头 `x-csrf` 等于 `csrfFor(token)`，前端从 `/me` 拿到这个值。

  登录接口还没有会话，只过 `sameOriginOnly`，并要求 `content-type: application/json`：跨站请求要带这个类型必须先过 CORS 预检，而我们不开 CORS。

- **限流。** 计数都在进程内（单副本），登录限流器单独实现，键数到上限时按 LRU 淘汰旧键，不并进全局溢出桶。IPv6 地址按 /64 前缀归桶。
  - 同一 IP 每分钟最多 10 次登录，超出返回 429。
  - 同一「邮箱（小写）+ IP」15 分钟内失败 5 次后，锁到窗口结束，返回 429；这对组合登录成功时清零。
  - 同一邮箱（不分 IP）15 分钟内失败满 10 次后，之后每次尝试先延迟 2 秒再校验，不锁死。攻击者因此锁不住 owner 的账号。
  - 不存在的邮箱和存在的邮箱按同样的规则计数，第 6 次的响应完全相同，限流不能用来探测邮箱是否存在。
  - 带 cookie 但会话无效的请求，先按 IP 限流（每分钟 60 次），再查库。
- **只接纳本实例租户的成员。** 登录时 `p_tenant` 就是 `DEFAULT_TENANT_SLUG` 解析出的 id。
- **`admin.html`** 与 `ADMIN_PASS` 的 Basic 流程不变。`/api/admin/stream` 在 `anon_readonly_admin` 关闭时要求有效的后台会话（同源 EventSource 会带上 cookie），否则 401；`admin.html` 已有的 30 秒轮询兜底照常。

### 后台 API 与页面

```ts
// src/console-api/app.ts —— 必须链式注册，Hono RPC 才推得出类型（ADR-002）
type ConsoleEnv = { Variables: { user: AuthedUser | null; token: string | null } };

export const consoleApi = new Hono<ConsoleEnv>()
  .basePath('/api/console')
  .use('*', securityHeaders, requireDbMode, loadSession, guardWrites) // guardWrites = sameOriginOnly + 会话 + x-csrf（登录接口例外）
  .post('/auth/login', loginLimit, zValidator('json', LoginBody), loginHandler)
  .post('/auth/logout', logoutHandler)
  .get('/me', meHandler)
  .get('/status', canRead, statusHandler) // 登录后：模式、租户、当前版本、锁与索引状态、差异；匿名只有 mode
  .get('/sop', canRead, sopOverviewHandler)
  .get('/sop/versions', canRead, zValidator('query', VersionsQuery), listVersionsHandler)
  .get('/sop/versions/:id', canRead, getVersionHandler)
  .put('/sop/draft', canEdit, zValidator('json', SaveDraftBody), saveDraftHandler)
  .post('/sop/draft/check', canEdit, checkDraftHandler)
  .post('/sop/draft/publish', canEdit, zValidator('json', PublishBody), publishHandler)
  .post('/sop/draft/discard', canEdit, zValidator('json', RevBody), discardHandler)
  .post('/sop/versions/:id/rollback', canEdit, zValidator('json', RollbackBody), rollbackHandler)
  .get('/catalog/:kind', canRead, listCatalogHandler)
  .get('/catalog/:kind/:code', canRead, getItemHandler)
  .post('/catalog/:kind', canEdit, zValidator('json', CreateItemBody), createItemHandler)
  .patch('/catalog/:kind/:code', canEdit, zValidator('json', CatalogPatchBody), updateItemHandler)
  .post('/catalog/:kind/:code/activate', canEdit, zValidator('json', RevBody), activateHandler)
  .post('/catalog/:kind/import-csv', canEdit, importCsvHandler) // 可砍
  .get('/conversations', canSeeCustomers, zValidator('query', ConvQuery), listConversationsHandler) // 可砍
  .get('/audit', canAudit, zValidator('query', AuditQuery), listAuditHandler);

export type ConsoleApp = typeof consoleApi;
// server.ts：app.route('/', consoleApi)，注册在 /console 的 SPA 回退和 public 的 serveStatic 兜底之前
```

- 文件模式下，`requireDbMode` 对所有 `/api/console/*` 返回 `503 { error: 'db_disabled' }`。
- 命名错误统一映射成 `{ error: <code>, detail?, violations?, fields?, keys?, current? }`：Conflict、唯一约束冲突 → 409，Locked / Contract / Validation → 422，NotFound → 404，`ConfigLockLostError` → 503 `lock_lost`。
- `POST /sop/draft/check` 总是 200，带 `violations`；只有 publish 在有 violation 时返回 422。

权限（「匿名」指没有有效会话；demo / prod 指 `profile().flags.anon_readonly_admin` 取开或关）：

| 操作                                 | owner / admin | supervisor / agent / viewer | 匿名（demo）                       | 匿名（prod） |
| ------------------------------------ | ------------- | --------------------------- | ---------------------------------- | ------------ |
| 读 SOP、产品库、状态                 | ✓             | ✓                           | 脱敏投影（页面挂「演示只读」横幅） | 401          |
| 改 SOP、发布、回滚、上新、编辑、上架 | ✓             | 403                         | 401                                | 401          |
| 会话只读列表                         | ✓             | ✓                           | 401                                | 401          |
| 审计日志                             | ✓             | 403                         | 401                                | 401          |

- **匿名投影**：SOP 只给已发布版本的 `sections`、`versionNo`、`publishedAt` 和 `promptHash` 前 12 位；产品库只给 active 条目的 `kind`、`code`、`payload`；`/status` 只给 `mode`。不含草稿、任何 user id、姓名和变更说明。匿名读取一律出自进程内缓存与快照，不查库，并挂上现有的 `lookupLimit`。
- **会话只读列表**读的是现有的文件 store：handler 自己按 `(updatedAt desc, id)` 排序，offset 分页（`limit ≤ 100`），每条只投影 `id`、`channel`、`stage`、`handedOver`、消息条数、`updatedAt`，不带消息正文，也不把 store 里的活对象原样返回。不列 `sim-` 会话：演示访客会话凭 id 就能读全文，id 本身就是凭据。演示数据保鲜会整体平移时间戳，保鲜期间翻页可能漂移。详情仍在 `admin.html` 里看。
- **安全头**：`/console/*` 与 `/api/console/*` 的响应都带 `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'`、`Cache-Control: no-store`（响应里有 csrf 和草稿）、`X-Content-Type-Options: nosniff`。`/console` 的页面（index.html）在这条 CSP 之外再加 `style-src 'self' 'nonce-<每个响应现生成>'`：Ant Design 与 CodeMirror 在运行时插 `<style>`，只有 `default-src 'self'` 时整页没有样式。构建时在 index.html 里留 nonce 的占位符，托管页面时每个响应换成新值并写进这一条；前端从 `<meta property="csp-nonce">` 读出交给组件库。脚本仍只许本站文件，注入的标记带不上 nonce，照样被拦。`/console` 与公开页同源，同源的 XSS 能拿到 csrf，所以公开页对产品库文本的转义是后台安全的一部分。

页面（ADR-002 的栈；本阶段不用 ECharts）：

- **登录**：邮箱和口令。
- **SOP**：
  - 左侧是节列表，锁定节带锁标记、只读展示。
  - 右侧编辑可编辑节的正文。
  - 顶栏：基于哪个版本（草稿已过期时标出）、草稿状态、字符预算条，以及「检查」「发布」（要填变更说明）「丢弃」三个按钮。
  - 检查结果按节列出 violation；需要 rebase 时标出，有冲突时列出冲突的节和当前发布版本的正文。
  - 历史列表显示版本号、来源、发布人、时间、`prompt_hash` 前 12 位，每行可以「以此版本回滚」；回滚结果与目标版本哈希不同时提示原因。
  - 草稿和已发布版本的逐节 diff 用 `@codemirror/merge`（可砍）。
- **产品库**：
  - 线路和酒店两个标签页。表格列：code、标题、目的地、起价、状态、更新人、更新时间。
  - 表单由 `RouteSchema` / `HotelSchema` 转成 JSON Schema 自动生成（ADR-002）。active 条目的锁定字段只读，并注明「有报价快照后开放」。保存时只把改过的顶层字段放进 `set`。
  - 「新建」生成 draft；「上架」要二次确认，提示上架后这些字段就锁定了。
  - CSV 导入（可砍）：只建 draft，只收平铺字段，数组用「、」分隔。
- **会话只读列表**（可砍）。
- **审计日志**：分页，可按 action 过滤。

### 构建与部署

- **workspace。** `pnpm-workspace.yaml` 加 `packages: ['console']`。`console/package.json` 的依赖全部钉精确版本；根目录的 `hono` 也改成精确版本，两边同一版本，否则 RPC 的类型对不上。
- **Dockerfile 多阶段。**
  - `deps` 阶段装整个 workspace；
  - `console` 阶段执行 `pnpm --filter console build`，产出 `console/dist`；
  - 运行阶段沿用现有做法（tsx 直跑、tini、`TZ`、`USER node`），增加 `COPY drizzle`，以及 `COPY --from=console /app/console/dist ./console/dist`。`src/cli/` 在 `src` 里，随镜像发布。console 的依赖不进运行阶段。
- **托管与回退。**
  - `/console` 301 到 `/console/`。
  - `/console/assets/*` 按文件返回，文件不存在就 404。
  - `/console/*` 下的其他路径：存在的静态文件照常返回，其余一律返回 `console/dist/index.html`。
  - Vite 的 `base` 设为 `/console/`，开发时把 `/api` 代理到 `:3200`。
- **compose**（`deploy/compose.yml`），每个服务只拿自己需要的凭据，env 文件放在服务器上、不进仓库：
  - `db`：`pgvector/pgvector:pg17`，数据卷，`pg_isready` 健康检查；首次初始化时由 `deploy/db-init/roles.sh` 建角色和库。**不写 `ports:`**，只在 compose 网络内可达。
  - `migrate`：镜像 `${APP_IMAGE}`，只注入 `DATABASE_OWNER_URL`，跑 `src/db/migrate.ts`，`restart: "no"`。
  - `app`：镜像 `${APP_IMAGE}`，只注入应用自己的 env（含 `DATABASE_URL`，不含 owner、platform 与超级用户口令）。`depends_on` 设为 db `service_healthy`、migrate `service_completed_successfully`。挂 `var/` 卷，端口只绑 `127.0.0.1`，`stop_grace_period: 10s`，与现在相同。
  - `platform`：镜像 `${APP_IMAGE}`，`profiles: [cli]`，只注入 `DATABASE_PLATFORM_URL`，平时不启动。
  - 日志和 `ConfigStartupError` 的 detail 里，连接串一律去掉口令。
- **deploy.sh。** `deploy.sh <tag>` 的构建和 `:prev` 取法不变，「换容器」一步改成 `APP_IMAGE=<新镜像> docker compose up -d app`（先跑 migrate）。回滚是 `APP_IMAGE=<:prev> docker compose up -d --no-deps app`，不跑 migrate：旧镜像的迁移是新镜像的子集。
- **备份与恢复。** 宿主机 cron 每晚跑 `deploy/backup.sh`：
  - 以超级用户在 db 容器里经本地 socket 导出：`docker compose exec -T db pg_dump -U postgres -Fc agent`，另加 `pg_dumpall -U postgres --globals-only --no-role-passwords`。主机上不存超级用户口令。不用任何受 RLS 约束的角色导出，也禁用 `--enable-row-security`：没设租户时它会静默导出 0 行。
  - 导出后用 `pg_restore --list` 确认四张 RLS 表都有 TABLE DATA，并数出 `sop_versions` 和 `catalog_items` 的行数，为 0 就非零退出并告警。
  - `var/` 打成 tar。两份都在离开本机前用 age 公钥加密，私钥不放在服务器上；本地目录权限 0700，按日期建目录，保留 7 天。
  - 异地副本保留 30 天，目标由部署环境变量给出，地域约束另记。没配异地目标时，每次运行都在 stderr 告警，本地备份照常。
  - 恢复固定这几步：解密 → 在新集群上跑 `roles.sh`（建角色和库）→ 以超级用户 `pg_restore -d agent --exit-on-error`，不加 `--no-owner`，属主保持 `agent_owner` → 以 `agent_owner` 跑一次迁移（应为空操作）→ 解开 `var/` 的 tar → 应用以 DB 模式启动。
  - 本阶段做一次恢复演练，之后每月一次。本阶段这次通过或不通过，以及不敏感的证据，记进 plan 的验收记录（验收 19）；演练细节另记。

### 导入、导出与回滚

```
# 以 app 身份运行：docker compose run --rm app node --import tsx src/cli/<name>.ts …
src/cli/import-config.ts   --tenant <slug> [--data <dir>] [--dry-run]
src/cli/export-config.ts   --tenant <slug> --out <dir> [--image-sop <path>]
src/cli/catalog-fix.ts     --tenant <slug> --kind route|hotel --code <code> --set '<json>' --reason <text>

# 以 platform 身份运行：docker compose run --rm platform node --import tsx src/cli/<name>.ts …
src/cli/tenant-create.ts   --slug <slug> --name <name> --pack travel [--locale zh-CN] [--region CN]
src/cli/user-create.ts     --tenant <slug> --email <e> --name <n> --role owner|admin|…   # 邮箱已存在时只加成员关系，不碰口令
src/cli/user-password.ts   --tenant <slug> --email <e>                                 # 同时吊销该用户的全部会话
src/cli/user-disable.ts    --tenant <slug> --email <e>                                 # 设 disabled_at，吊销全部会话
src/cli/member-role.ts     --tenant <slug> --email <e> --role <role>
src/cli/member-remove.ts   --tenant <slug> --email <e>                                 # 删成员关系，吊销该用户在本租户的会话
```

- 命令行不 import 运行时模块（见依赖规则），不读写 `var/`。一律带 `--rm` 运行。
- 口令从 stdin 读（`--password-stdin`），或者生成后只写到 `/dev/tty`；两者都没有就拒绝执行，口令不会进 `docker logs`。
- 退出码：0 成功或已一致；2 库里已有不一致的内容；3 拿不到租户锁；1 其他错误。
- **import-config**：
  - 先取租户锁，DB 模式的应用在跑时拿不到锁，退出码 3。首次切换时应用还在文件模式，不持锁。
  - `--data` 里 `sop.md` 的锁定节必须与镜像里的 `data/sop.md` 逐字节相同，否则以 `locked_changed` 退出。
  - 租户下既没有 SOP 版本、也没有条目时：在一个事务里做完下面几件事——编码与规范形检查、切节、渲染、契约检查（预算基线就是它自己）、写入 v1（`source='import'`，直接 published）、按原对象和数组下标写入全部条目（active）、写一行 `config.import` 审计。打印 `promptHash`、`prefixHash` 和 `sopHash`。
  - 库里已有内容时，「一致」定义为：当前已发布版本的可编辑节等于文件切出的可编辑节，并且每条 active 条目的 `(kind, code, ord, JSON.stringify(payload))` 与文件完全一致。rerender 版本和 draft 条目不影响判定。一致时退出码 0，不一致时退出码 2，库都不动。它只做首次导入，之后的修改走后台。
- **export-config**：
  - 在一个 `REPEATABLE READ READ ONLY` 事务里一次读出已发布版本的行和全部 active 条目，版本号与哈希都取自这一行。
  - `sop.md` 是 `joinSop(mergeWithImage(已发布版本.sections, 目标镜像节))`。目标镜像节默认取本镜像的 `data/sop.md`；给了 `--image-sop` 就取那个文件，这是回到旧版本时用的。
  - 给了 `--image-sop` 时，对导出结果跑一次契约检查（预算传 null），不过就非零退出。工具名与字段名按本镜像的代码检查；目标版本的代码由它自己的 CI 在提交时再验一遍。
  - `routes.json` / `hotels.json` 是 active 条目按 `ord` 排好后的 `JSON.stringify(items, null, 2) + '\n'`。
  - 打印版本号，以及对导出的 `sop.md` 在本地重新算出的 `sopHash`；没给 `--image-sop` 时再本地渲染一遍，`promptHash` 必须等于库里存的值，否则非零退出。
  - 字节级的承诺只到「每条 `JSON.stringify` 相同、顺序相同」。提交之前用格式化器改写这两个 JSON（`oxfmt data/routes.json data/hotels.json`），否则过不了 pre-commit 的 `format:check`。
- **catalog-fix**：锁定字段的唯一修正途径。要求先停应用（`docker compose stop app`），因为它要取租户锁；改完 `docker compose up -d app`，启动时重新装载快照。补丁规则同后台，只是允许改 `LOCKED_WHEN_ACTIVE` 里的字段（`id` 除外），写一行 `catalog.locked_fix` 审计并带上 `--reason`。执行前打印警告：已发出的方案书会按新值重算。
- **切换后的真相来源。** DB 模式下，锁定节以镜像为准，可编辑节和产品库以库为准；`data/` 里对应的部分从此只是新租户的种子。工程师改 `data/sop.md` 的可编辑节或 `routes.json`，部署后线上不会生效，启动日志会按节、按条目点名这些差异。要对线上内容跑回归：`export-config` 导出到一个目录，再用 `SOP_PATH`、`ROUTES_PATH`、`HOTELS_PATH` 指向它跑 `eval/run.ts`（文件模式）。
- **回滚。** 分三种情况：
  1. **部署失败，自动回滚。** `:prev` 取自正在运行的容器。切换完成之后运行的一直是能读库的镜像，所以自动回滚只会落到另一个 DB 模式的版本上。迁移只增不删，旧版本能在新 schema 上读写，启动核对允许库比镜像新。
  2. **首次切换失败。** 切换顺序是：先以文件模式部署能读库的镜像；再起 db、跑迁移、建租户和账号；在 app 的 env 里写入 `DATABASE_URL`、`DEFAULT_TENANT_SLUG`，确认 `DEPLOY_PROFILE` 已显式设置；以 app 身份跑 import；最后加上 `CONFIG_SOURCE=db`，重启。最后一步失败时，去掉 `CONFIG_SOURCE=db` 再重启就回到文件模式。此时库里只有刚导入的内容，和镜像里的 `data/` 相同，不会丢任何东西。
  3. **手动回到文件模式**（部署旧 tag，或者同一镜像去掉 `CONFIG_SOURCE=db`）：
     1. 运行 `export-config`；回到旧 tag 时加 `--image-sop <旧 tag 的 data/sop.md>`。它只读库，应用可以照常在跑。
     2. 把导出的三个文件拷到要部署的那条线上，格式化两个 JSON，提交，由 CI 跑完 `test`，打新 tag。
     3. 部署这个 tag，去掉 `CONFIG_SOURCE=db`。
     4. 核对 `/healthz` 的 `config.sopHash` 等于导出时打印的值。同一代码版本下，`promptHash` 与 `prefixHash` 也应等于 DB 模式最后的值。

     跳过第 1、2 步直接回退，就等于丢掉运营在后台做过的全部修改。之后再回到 DB 模式时，文件模式期间对 `data/` 的改动要在后台重新录入：import 不会覆盖已有内容。

### 测试与 CI

- `test` 对现有 6 组 selftest 和文件模式的 `LLM_MOCK=1 eval/run.ts` 都显式加 `CONFIG_SOURCE=file` 前缀。`env.ts` 不覆盖已存在的变量，开发机 `.env` 里写了 `CONFIG_SOURCE=db` 也影响不到它们。断言一条不改。
- `test` 里新增三组，串在同一个脚本里。每组都先设临时的 `VAR_DIR`，再动态 import 任何会连带加载 `store.ts` 的模块，不碰开发机上真实的 `var/`：
  - `src/db/db.selftest.ts`：
    - PGlite 部分：迁移连跑两遍、约束（含哈希 CHECK）、三个触发器、两个部分唯一索引、复合外键。
    - 真实 Postgres 部分，有 `PG_TEST_URL` 才跑：以超级用户建一个临时库，执行 `roles.sql`，以 `agent_owner` 跑迁移，再按「各角色对各表的期望」逐格断言；按系统目录找出所有带 `tenant_id` 的表，断言除豁免清单外都开了 ENABLE 与 FORCE 并有 `tenant_isolation` 策略；认证函数、同名临时表遮蔽、会话级 SET 泄漏；租户锁（`lock_held`、锁连接被 `pg_terminate_backend` 后的重取与 `held_by_other`）；以 `agent_app` 经 `openDb`（node-postgres）重跑验收 2 的逐条字节比较；以子进程真实执行 `import-config` 与 `export-config`，断言退出码和导出文件。结束时删库。`CI=true` 而没有 `PG_TEST_URL` 时失败。
  - `src/config/config.selftest.ts`：节表与契约（含对当前 `data/sop.md` 零 violation、编码检查）、产品库 schema、两种模式逐字节等价、导入导出往返、两种模式下的快照冻结、每轮零查询、SOP 与产品库的编辑流程、启动重渲染、检索（用计数的假 embedding 服务）、`boot()` 的启动顺序与各个启动失败分支（经 `ConfigDeps` 注入：假锁、改过的 `imageSop`、改过的 `render`、删减过的 `toolNames` / `knownFields`）。
  - `src/console-api/console.selftest.ts`：鉴权和后台接口，走 `app.request`，库用 PGlite。
- DB 模式的 mock eval：`eval/run.ts` 在 `VAR_DIR` 赋值之后加一处开关。`CONFIG_TEST_DB=pglite` 时，它把 `data/` 导入 PGlite 并以 `initConfig(deps)` 装成配置源。这个开关必须放在 `VAR_DIR` 之后：`store.ts` 在加载时就读 `VAR_DIR`。`test` 把 eval 跑两遍，文件模式一遍、DB 模式一遍。同一处还加上 ADR-003 要求的 `--cases <path>`。
- `llm.ts` 在 `chat()` 组装请求的入口（mock 与真实分支之前）加一个只读的观察钩子，默认什么都不做；自测和 DB 模式的 eval 用它记录每个请求实际发出的 system 与 tools。
- `typecheck` 覆盖 `console/`。`test` 末尾做一次 console 生产构建并扫描产物。
- CI 的 `check` job 加 `services.postgres`，镜像用 `pgvector/pgvector:pg17`，与 compose 相同，并设好 `PG_TEST_URL`。步骤仍然只调四个门禁名。

## 不变量

每条都能写成断言或测试。

模式与装载：

1. `CONFIG_SOURCE` 不是 `db`、也没装 DB 配置源时，`buildSystemPrompt()`、`loadRoutes()`、`loadHotels()` 的结果与开工提交逐字节相同，进程不建立任何数据库连接。
2. `CONFIG_SOURCE=db` 而 `initConfig()` 还没成功时，这三个函数抛 `ConfigNotReadyError`，从不退回去读文件；护栏里的 catch 不吞它。
3. DB 模式下进程只装载 `DEFAULT_TENANT_SLUG` 这一个租户，每个进程内配置缓存都带着它的 id，并持有它的 advisory lock。锁连接断开期间配置写入一律被拒；只有确认锁已被别的进程持有时才退出，而且走优雅停机路径。
4. DB 模式下，处理一轮对话不发出任何数据库查询。
5. `initConfig()` reject 时，`serve()`、数据预检、`buildIndex()`、`startFollowUpScheduler()`、`startWecom()` 都没有被调用，企微 cursor 文件不变。
6. DB 模式下 app 进程的环境里没有 owner、platform 或超级用户的凭据；有就拒绝启动。

SOP：

7. 对 `splitSop` 能接受的任何输入 x，`joinSop(splitSop(x)) === x`；`data/sop.md` 切出 11 节，键序与 `TRAVEL_SOP_SECTIONS` 相同。
8. `normalizeBody` 是幂等的；`data/sop.md` 的每一节都已是规范形；把 `sectionBody` 的结果原样经 `withBody` 放回，节的字节不变。
9. 每个 published 或 archived 版本满足 `rendered_prompt === render(joinSop(sections))`（发布那一刻），`prompt_hash`、`prefix_hash` 与各自的输入一致（库里有 CHECK），此后这些列永不改变。
10. 每个租户同一时刻至多一个 published 版本、至多一个 draft 版本；已发布版本号按发布顺序严格递增，草稿没有版本号。
11. DB 模式下，当前已发布版本的每个锁定节都与镜像里 `data/sop.md` 的对应节逐字节相同。
12. 当前已发布版本在本镜像的契约下（不含预算）没有 violation。导入、后台发布和回滚还额外查预算。
13. 每轮交给 `chat()` 的 `system`，逐字节等于这一轮开始时缓存里的 `renderedPrompt`；缓存只在提交之后替换，版本号只增不减。
14. `SOP_CONTRACT` 包含 `engine.selftest.ts` 里对 `buildSystemPrompt()` 结果断言的每一个字面短语和正则；`SOP_KNOWN_FIELDS` 的每一项都出现在 `KNOWN_FIELD_SOURCES` 里；当前 `data/sop.md` 的契约检查为零条 violation。

产品库：

15. 快照里每个 kind 的数组，都是该 kind 的 active 条目按 `ord` 升序排列；刚导入时与文件里的顺序相同。
16. 两种模式下 `loadRoutes()` / `loadHotels()` 的返回值都是 deep-frozen 的：往任何条目、数组或嵌套对象里写都会抛 `TypeError`。
17. 没被编辑过的条目，`JSON.stringify(快照条目) === JSON.stringify(文件条目)`；编辑过的条目，各层原有的键保持原来的位置。
18. `catalog_items.code === payload.id`；`code`、`kind`、`ord`、`tenant_id` 写入后不变；active 永不回到 draft；01 不删除任何条目。
19. active 条目的 `LOCKED_WHEN_ACTIVE` 字段和任何条目的 `id`，不会经后台接口改变；唯一例外是 `catalog-fix`，且必有一行 `catalog.locked_fix` 审计。
20. 产品库写接口返回 200 时，进程内快照已包含这次写入。embed 服务可用时，检索索引的 id 集合最终等于快照的线路 id 集合；构建途中产品库又变了的话，旧的构建结果不会覆盖新产品库的索引。
21. 文件模式下检索的行为和缓存文件与开工提交相同。

数据库与租户：

22. `public` schema 里每张带 `tenant_id` 的表都启用并 FORCE 了 RLS、有 `tenant_isolation` 策略，豁免清单（`auth_sessions`）除外。各角色对各表的权限与「各角色对各表的期望」完全一致；没设 `app.tenant_id` 时，有权限的角色读 RLS 表得到 0 行，写入被拒。
23. `agent_app` 对 `users`、`memberships`、`auth_sessions` 没有任何表权限，认证只能经五个 SECURITY DEFINER 函数。这些函数的 `search_path` 以 `pg_temp` 结尾、表名全限定，对 PUBLIC 撤销了 EXECUTE；调用时如果 `app.tenant_id` 已经设成了别的租户，就报错；返回时 `app.tenant_id` 恢复原值。
24. `agent_app` 与 `agent_platform` 都不能 DELETE `sop_versions`、`catalog_items`、`audit_log`；`agent_app` 对 `audit_log` 只能 SELECT 和 INSERT。
25. 字符串 `app.tenant_id` 只出现在 `src/db/client.ts` 和迁移 SQL 里；全仓没有 `sql.raw`；`pg`、`drizzle-orm`、`@electric-sql/pglite` 只被 `src/db/**` import。
26. `drizzle/` 下的迁移不含未标注的破坏性语句（清单见「迁移纪律」），已提交的迁移文件不被修改。

鉴权与后台：

27. 库里不存在会话 token 的明文，`token_hash = sha256(token)`。
28. 会话在 `now − last_seen_at > 12h` 或 `now > expires_at` 时失效，失效即删行。
29. `/api/console/*` 的每个非 GET 请求，都要求有效会话（登录接口除外）、`x-csrf` 等于该会话的派生值，并通过 `sameOriginOnly`。
30. `src/shared/**` 和 `console/src/**` 在运行时不引用 `pg`、`drizzle-orm`、`@electric-sql/pglite`，也不引用任何 `node:` 模块。
31. 匿名响应里不出现任何 user id、display_name、草稿和变更说明。

## 验收标准

1. **文件模式零变化。** `CONFIG_SOURCE` 不设时，`pnpm test` 全绿。与开工提交相比，`src/*.selftest.ts`（新增的三组除外）、`src/adapters/*.selftest.ts`、`eval/cases.json` 的 diff 为空，唯一的例外是：如果 00 在 `server.selftest.ts` 里断言了「prod 下 `/api/admin/stream` 匿名可连」，这一条改为 401。`eval/run.ts` 只多出 DB 开关和 `--cases` 这两处。开发机 `.env` 里写着 `CONFIG_SOURCE=db` 和 `DATABASE_URL` 时，`pnpm test` 的结果不变。
2. **两种模式逐字节等价。** 在同一进程里，先在文件模式下取值，再把 `data/` 导入 PGlite、装成配置源后再取一遍，逐项比较：
   - `promptPrefix().system` 与 `promptPrefix().tools` 两次都逐字节相同；
   - `loadRoutes()`、`loadHotels()` 顺序相同，每条的 `JSON.stringify` 相同；
   - 5 个只读工具（`search_routes`、`get_route_detail`、`search_hotels`、`create_quote`、`generate_proposal`）各一组代表性参数（包括 `search_hotels({})`、带长辈提示的 `get_route_detail`、分别落在旺季和淡季的 `create_quote`），两种模式各用一个全新的相同会话，经 `executeTool` 返回的字符串逐字节相同；
   - `create_order` 与 `handoff_to_human`：把 `ord_[0-9a-f]{24}`、`payUrl` 和时间戳遮掉后，返回字符串与调用后的会话状态相同。

   DB 模式下 mock eval 通过的用例集合，与文件模式相同。真实 Postgres 上经 node-postgres 驱动重复一遍前两项。

3. **导入 / 导出往返。**
   - import 再 export：`sop.md` 与 `data/sop.md` 逐字节相同；`routes.json`、`hotels.json` 条目顺序相同，每条的 `JSON.stringify` 相同。
   - 含 `\r\n`、NFD 字符、BOM、孤立代理项、NUL、U+2028，或某节不是规范形（如行尾空格）的 sop 文件，import 失败退出，库里没有新行。
   - 对同一份 `data/` 再跑一次 import：退出码 0，库不变。先导入、再以 DB 模式启动一次（产生一个 rerender 版本）、再 import：仍是退出码 0。库里已有不同内容时：退出码 2，库不变。应用持锁时：退出码 3。
   - 在镜像里执行 `import-config --dry-run` 能跑通。
4. **快照不可变。** 两种模式下：
   - 对 `loadRoutes()[0].priceFrom` 赋值、对 `loadHotels()` 原地 `sort`，都抛 `TypeError`；
   - `search_hotels({})` 连调两次，结果相同，快照顺序不变。
5. **发布生效，可以回滚。**
   - 编辑「话术原则」并发布：下一轮 `chat()` 收到的 `system` 等于新版本的 `rendered_prompt`，`/healthz` 的 `config.sopVersion` 等于新版本号且大于原值，进程没有重启。
   - 回滚到 v1：生成一个新的版本号，它的 `prompt_hash` 等于 `render(merge(v1 的可编辑节, 当前镜像))` 的哈希。v1 之后没有发生过 rerender 时，它就等于 v1 的 `prompt_hash`，`sameHashAsTarget` 为 true；中间插入过一次 rerender 时 `sameHashAsTarget` 为 false。两种情况各测一例。
   - 回滚到一个 draft 或 discarded 版本返回 404。
   - 以上每次操作各有一行审计。
6. **契约闸拦得住。** 下面这些草稿，检查返回 200 并在 `violations` 里带上对应的 code，发布返回 422，已发布版本和缓存都不变：
   - 在「话术原则」里写进「明显超出我们现有线路的范围」→ `phrase_forbidden`；
   - 在「异议处理」里写 `search_route` 或 `create_refund` → `unknown_tool`；
   - 写 `destinationMissing` → `unknown_field`；
   - 在「微信语气规范」的正文里加一行 `## 新节` → `structure`；
   - 把可编辑节加长到超出导入时可编辑节总长的 120% → `over_budget`。

   保存草稿时点名锁定节，返回 422 `locked_section`。在 `engine.selftest.ts` 里新增一条 `sys.includes('某短语')` 而不把它加进清单，`pnpm test` 失败并点出这个短语；在 `data/sop.md` 的锁定节里点名一个 `KNOWN_FIELD_SOURCES` 里没有的 camelCase 字段，`pnpm test` 失败并点出它。

7. **版本不可变。**
   - 以 `agent_app` 对已发布的行执行 `UPDATE sections`、`UPDATE rendered_prompt`、`UPDATE version_no`，或把状态从 published 改回 draft，都报错，行不变。
   - 直接 `INSERT` 一行 `status='archived'` 的版本，或 `prompt_hash` 与 `rendered_prompt` 不符的 published 版本，都报错。
   - 同一个租户插入第二个 published 或第二个 draft，被唯一索引拒绝。
   - `agent_app` 执行 `DELETE FROM sop_versions`，报 permission denied。
   - 草稿存在期间先后插入一个 rollback 版本和一个 rerender 版本，再发布这份草稿：它拿到的版本号大于前两者。
8. **启动重渲染。** 经 `ConfigDeps` 注入：
   - 镜像里某个锁定节改了一个字，或 `render` 的【硬性要求】改了一个字，或 `toolsJson` 变了：启动时自动产生并发布一个 `source='rerender'` 的新版本，`causes` 分别是 `locked_sections`、`hard_rules`、`tools`；多一行 `actor_kind='system'` 的审计；运营编辑过的可编辑节原样保留。只改了工具定义时，新版本的 `prompt_hash` 不变、`tools_hash` 与 `prefix_hash` 变了。
   - 这次改动让契约不过（例如删掉「没有节假日价」），进程以非零码退出并打印 violation，库不变。
   - system 的字节不变，但 `toolNames` 或 `knownFields` 里去掉了已发布 SOP 点名的一项：进程以 `contract_failed` 非零退出，库不变。
   - 注入一个每次输出不同的 `render`：以 `renderer_nondeterministic` 退出，库不变。
   - 产品库装载失败（没有 active 线路）时，即使 SOP 需要 rerender，库里也没有新版本。
9. **产品库锁定字段与补丁。**
   - 对 active 线路 PATCH，改 `priceFrom`、`bestSeason`、`segments`、`aliases`、`maxAltitude`、`overseas`、`destination`、`days`、`title`、`inclusions`、`exclusions` 中的任何一个，或增删 tags 里的「国内」：返回 422 并逐个点名字段，库和快照都不变。
   - 改 `highlights`：返回 200，下一次 `get_route_detail` 返回新内容；其他条目的 `JSON.stringify` 不变，这一条除 `highlights` 外的字节也不变。
   - 只改 `itinerary[0].detail`（经表单序列化后提交整个 `itinerary`）：这一条除这个字段外的字节不变，各层键序保持。
   - 把 GET 回来的 payload 原样经表单序列化再提交：审计 `diff` 为空，`JSON.stringify` 不变。
   - `itinerary` 改空或条数不等于 `days`、带未知键、数值字段传字符串：422。
   - draft 条目除 `id` 以外的字段都能改；改 `id` 返回 422 并点名 `id`。
   - 接口上没有下架和删除。
   - 在允许的编辑前后，`/api/proposal/:routeId?travelers=2&departDate=…` 返回的 `quote` 相同。
   - `catalog-fix` 在应用运行时拿不到锁（退出码 3）；停应用后改 `priceFrom` 成功，写一行带 `reason` 的 `catalog.locked_fix` 审计，重启后快照是新值。
10. **乐观锁与并发。**
    - 两次 PATCH 带同一个 `rev`，第二次返回 409。
    - 两个并发的新建请求用同一个 `code`：一个 200、一个 409 `catalog_code_taken`，没有 500；两个并发的新建各拿到不同的 `ord`。
    - 两个并发的首次保存草稿：一个成功，另一个 409，没有 500。
    - 草稿打开期间，发生一次 `locked_sections` 的 rerender：发布成功，结果含新锁定节和草稿里的编辑。
    - 草稿打开期间，别人发布了改动另一节的版本：自动 rebase 后发布成功，两处改动都在。改动同一节：409，响应点名这一节并带当前正文。
11. **检索。** 用一个计数的假 embedding 服务（只计构建索引的请求，不计 `semanticRecall` 的查询 embedding）：
    - 新建并上架一条线路：之后发生恰好一次全量构建，`semanticRecall` 能返回它；
    - 一次构建还没结束时又上架了一条：最终索引的 id 集合等于快照的线路 id 集合；
    - 上架后第一次构建失败：`/status` 报出过期，退避重试成功后能召回新线路；
    - 文件模式下：`buildIndex()` 的请求次数和缓存文件内容与开工提交相同。
12. **RLS 与权限（真实 Postgres）。**
    - 「各角色对各表的期望」逐格成立：有权限的格子没设租户时 SELECT 得到 0 行、INSERT 被拒；无权限的格子报 permission denied。
    - 在租户 A 的上下文里，`SELECT` 看不到 B 的行，`UPDATE` B 的行影响 0 行。
    - 一个事务设过租户并提交后，同一连接上的下一个事务不设租户，读到 0 行。
    - 在一条连接上执行会话级 `SET app.tenant_id = <A>` 后归还连接，下一次 `withTenant` 借到它时抛错并销毁这条连接。
    - `agent_app` 直接 `SELECT` `users`、`memberships`、`auth_sessions`，都报 permission denied；经认证函数能登录。
    - 在 `app.tenant_id` 已设为 B 的事务里，用 A 调认证函数会报错；调用成功之后 `app.tenant_id` 恢复为调用前的值。
    - 以 `agent_app` 建一张名为 `users` 的临时表，认证函数不受影响（`agent_app` 本就没有 TEMP 权限时，建表直接失败，同样算通过）。
    - 按系统目录新增一张带 `tenant_id` 却没开 RLS 的表，这个套件就变红；去掉任何一张表的 `ENABLE ROW LEVEL SECURITY` 也一样。
13. **启动时校验。** 以下每种情况都让 `boot()` 以非零码退出，日志点名原因，`serve()` 和 `startWecom()` 都没被调用，企微 cursor 文件的内容与 mtime 不变：
    - `CONFIG_SOURCE` 取值非法；DB 模式缺 `DATABASE_URL`、`DEFAULT_TENANT_SLUG` 或 `DEPLOY_PROFILE`（`env_invalid`）；
    - app 环境里有 `DATABASE_OWNER_URL`、`DATABASE_PLATFORM_URL` 或 `POSTGRES_PASSWORD`（`env_privileged`）；
    - 连不上库（`db_unreachable`）；
    - 镜像里的某条迁移没在库里（`schema_behind`）；库里多出一条镜像没有的迁移时，照常启动并打 warn；
    - `DEFAULT_TENANT_SLUG` 不存在，或租户已停用；
    - 租户没有已发布的 SOP；
    - 手工改过已发布行的 `sections`，`sop_hash` 对不上（`integrity`）；
    - 没有 active 线路；
    - 另一个进程已经持有该租户的锁（真实 Postgres）；
    - 镜像里的 `data/sop.md` 缺失、切不开，或编码不合格。
14. **每轮不查库。** DB 模式下跑 5 轮 mock 对话（含报价和下单），装载完成之后 `queryCount()` 一次也没有增加。
15. **鉴权。**
    - 登录成功的响应带 `Set-Cookie: __Host-sid=…; Path=/; HttpOnly; Secure; SameSite=Lax`，没有 `Domain`。库里的 `token_hash` 等于 cookie 值的 sha256，全库搜不到 cookie 明文。
    - 用假时钟：最后一次请求之后过 12 小时零 1 秒，返回 401；登录之后过 7 天零 1 秒，即使每小时都有请求，也返回 401；失效的行被删掉。
    - 同一 IP 一分钟内第 11 次登录，返回 429。同一「邮箱 + IP」15 分钟内第 6 次失败，返回 429；这时 owner 从另一个 IP 用正确口令仍能登录。
    - 对不存在的邮箱连续失败，第 6 次的状态码和响应体与存在的邮箱完全相同。
    - 未知邮箱与错误口令的状态码和响应体相同。
    - 写请求缺 `x-csrf`、值不对，或带 `Sec-Fetch-Site: cross-site`，都返回 403。
    - viewer 发布返回 403。
    - 旧参数的口令哈希登录成功后，库里的哈希换成当前参数。
    - `user-disable` 之后，该用户已有的会话立即 401。
    - `server.selftest.ts` 里 `admin.html` 的 Basic 流程不变。prod profile 下匿名连 `/api/admin/stream` 返回 401，带有效后台会话时能连上。
16. **匿名访问。**
    - prod profile：匿名访问 `/auth/login` 以外的任何 `/api/console/*`，都返回 401。
    - demo profile：匿名 `GET /sop`、`GET /catalog/route` 返回 200，响应体里没有任何 user uuid、display_name、`changeNote` 和草稿，产品库只有 active 条目，而且这些请求不增加 `queryCount()`；`GET /status` 只有 `mode`；`GET /audit`、`GET /conversations` 返回 401；任何写请求返回 401。
    - 文件模式：`/api/console/*` 一律返回 503 `db_disabled`。
    - `/console/*` 与 `/api/console/*` 的响应带上文列出的 CSP、`no-store` 和 `nosniff`。
17. **构建。**
    - 在多阶段镜像里：`/console/` 和深链 `/console/sop/versions/3` 都返回 `index.html`；`/console/assets/<hash>.js` 返回 JS；`/api/console/nope` 返回 404 JSON，不是 `index.html`；`/chat.html` 照旧。
    - console 的生产构建产物里，搜不到 `drizzle-orm`、`pg-protocol`、`@electric-sql/pglite`，也搜不到 `node:`。
    - 把 `src/shared/console-api.ts` 里一个响应字段改名，`pnpm typecheck` 在 console/src 的使用处报错。另有一个放在 typecheck 范围内的夹具，用 `@ts-expect-error` 断言对不存在的端点调用 `hc` 客户端是类型错误。
18. **导出与回滚演练。** 两例：
    - 同一镜像：在 DB 模式的实例上改一节 SOP、改一条线路的 highlights → export → 以文件模式启动同一个镜像（用 `SOP_PATH` / `ROUTES_PATH` / `HOTELS_PATH` 指向导出目录，或把导出文件放进 `data/` 重新构建）。`/healthz` 的 `sopHash`、`promptHash`、`prefixHash` 等于 DB 模式下最后的值；`get_route_detail` 返回改过的 highlights。
    - 上一个 tag：用该 tag 的 `data/sop.md` 作为 `--image-sop` 导出，在该 tag 的分支上格式化并执行一次真实的 `git commit`（过得了 pre-commit），CI 的 `test` 通过，部署后 `/healthz` 的 `sopHash` 等于导出时打印的值。
    - 库与镜像内 `data/` 不一致时，DB 模式的启动日志按节、按条目点名差异。
19. **备份与恢复。** 按「备份与恢复」的固定步骤，把一份加密备份恢复到新集群：
    - 应用在 DB 模式下启动，`/healthz` 的 `config.sopVersion`、`promptHash`、`prefixHash` 与原库一致；
    - 四张 RLS 表的行数与原库相同；改过的 highlights 还在；能用原账号登录；
    - 以 `agent_owner` 跑一次迁移成功；以 `agent_app` 不设租户时读到 0 行；
    - `var/` 恢复后会话数与原来相同；
    - `backup.sh` 按日期建目录，超过 7 天的本地目录被清理；备份文件是密文；没配异地目标时 stderr 有告警。
20. **门禁。**
    - `format:check`、`lint`、`typecheck`、`test` 在干净 clone 上全过。
    - CI 里 RLS 套件确实运行了：CI 环境缺 `PG_TEST_URL` 时，`test` 失败而不是跳过。
    - 在迁移里加一句未标注的 `DROP COLUMN` 或 `ALTER TABLE … ALTER COLUMN … SET NOT NULL`，或修改一个已提交的迁移文件，`lint` 失败并点名文件。
    - 在 `src/shared/` 下 import `drizzle-orm`、在 `src/config/` 下 import `store`、在 `src/db/` 以外出现 `app.tenant_id`，`lint` 都失败。
21. **前缀。**
    - 自动（进 `test`）：DB 模式的 mock eval 里，每个请求实际发出的 system 与 tools 的哈希，都等于当时 `/healthz` 报的 `promptHash` 与 `toolsHash`。
    - 手动（不进 CI）：用 `--cases` 指向只含 realOnly 用例的文件（由 `eval/cases.json` 过滤生成，不提交），按「文件 → DB → 文件」交替各跑至少 3 遍，缓存命中率从每个会话的第 2 个请求起统计。通过条件是两种模式的 p90 都不超过 8 秒；命中率只记录，不设门槛。数字记进 plan 的验收记录。
22. **后台走查。** 用 Playwright 脚本，或手工走一遍并把截图记进 plan：登录 → 编辑「话术原则」→「检查」按节列出 violation → 填变更说明后发布 → 历史列表出现新版本和 `prompt_hash` → 以旧版回滚；产品库里 active 条目的锁定字段只读，改 highlights 能保存，新建 draft 后经二次确认上架；审计页有对应记录；demo 匿名时有横幅，看不到审计入口。
23. **demo 切换。** 线上 demo 切换前后，`/healthz` 的 `config.promptHash`、`toolsHash`、`prefixHash` 相同；切换后 `config.mode = db`、`sopVersion = 1`；`docker compose exec app env` 里没有 owner、platform 或超级用户的凭据。

## 开放问题

1. **`test` 新增三组自测（已定，2026-09-25）。** owner 确认：门禁名不变，`test` 脚本里多串数据库、配置源、鉴权三组自测；验收 1 与「测试与 CI」按现文执行。
2. **PGlite 对 `CREATE ROLE`、`SECURITY DEFINER`、`GRANT`、`sha256()` 与触发器的支持程度。** 第 2 步实测。不支持授权语句时，`openTestDb()` 跳过这类语句（PGlite 反正以超级用户运行），这些行为只由真实 Postgres 上的套件覆盖；迁移文件本身不分叉。
3. **console 用 `import type { ConsoleApp }` 引服务端类型时，console 的 tsc 会把服务端源码和 `@types/node` 一起拉进类型检查。** 第 12 步实测。console 的类型检查超过 60 秒，或出现全局类型冲突，就改成服务端用 `tsc --emitDeclarationOnly` 产出 d.ts，console 只引 d.ts。
4. **scrypt N = 2^17 在目标服务器上的耗时和内存（已定，2026-09-26）。** 实测单次 413–499 ms、峰值 RSS 增量约为内存的 3%，没超过下面两条线，维持 2^17，数据见 plan 第 17 步。原文： 第 10 步在服务器上实测两个并发登录。单次超过 500 ms，或峰值 RSS 增量超过机器内存的 25%，就改用 OWASP 列出的等价组合 N = 2^16、r = 8、p = 2；参数随哈希存，旧哈希照样能校验，登录成功时经 `auth_password_rehash` 升级，不需要迁移。
5. **锁定字段按什么顺序开放。** 02 有了报价快照之后，`priceFrom`、`bestSeason`、`nightlyFrom`、`inclusions`、`exclusions` 可以先开。`title`、`destination`、`days`、`aliases`、`segments`、`maxAltitude`、`overseas` 还牵动护栏的线路识别和推荐，要等护栏有了「改名、改目的地」的回归用例才开。由 02 的 spec 逐字段定。
6. **`rerender` 自动发布，对生产租户和多租户是否合适。** demo 和 01 期间自动发布。在 02 spec 开工前定：生产实例是否改成「生成草稿，确认之前拒绝启动」。04 同一部署承载多个租户时，「一个租户契约不过就整个进程拒绝启动」会挡住所有租户：04 要改成按租户隔离，出问题的租户标记为 degraded 并告警，其他租户照常服务，rerender 按 `(tenant, render_inputs)` 做到幂等。
7. **可编辑节预算 120%。** 沿用迁移计划里的数。01 验收时，或 `over_budget` 累计拦下 5 次时复查；调整只改常量，不动表。
8. **`__Host-` cookie 在本地 http 开发下的浏览器差异。** 第 12 步实测。如果某个浏览器在 `http://localhost` 上不存 Secure cookie，开发服务器改走 https（Vite 自签证书），而不是换 cookie 名。
9. **版本线。** Drizzle、zod（内置 `z.toJSONSchema` 的是 v4，v3 要另装转换库）、Ant Design 的大版本。规则：取 npm `latest` 标签上的大版本；它是 beta 或 rc 就退一个大版本。第 2 步和第 12 步开工时核实，然后钉精确版本。
10. **线上内容的真实模型回归。** 切换后线上的可编辑节和产品库不在 git 里，现有回归测不到它们。02 接第一个真实租户之前定：是否把「导出 → 文件模式跑 realOnly 回归」做成发布前的固定步骤或定时任务。

## 被否决的方案

- **`payload jsonb`，读出后按固定键序重建**：20 条线路本来就有 3 种键序，任何一个固定顺序都会改变其中一部分条目的字节。
- **把计价字段拆成独立列（`price_from`、`tags`、`aliases` 加 `attrs`）**：读的时候要按原键序重新拼回对象，同一份数据存两处，还得额外证明两边一致。`payload` 是唯一来源，`code` 另存一列，由 CHECK 约束钉住。
- **drizzle-zod 生成共用 schema**（ADR-001 的理由里提到过它）：`payload` 是 `json` 列，生成出来的类型只有 `unknown`；表定义本身会 import `drizzle-orm`，前端一引用就会被打进浏览器包。共用 schema 在 `src/shared/` 里手写。
- **静态 golden 前缀常量**：00 已经否掉，理由相同。01 用「同一进程里文件渲染 == DB 渲染」。
- **每轮重新渲染**：「发布时渲染一次、运行时逐字节复用」加上启动时渲染两遍比对，让不确定的渲染（混进时间、随机数或会变的配置）在启动时就失败，而不是每轮悄悄漂移。
- **只看 `DATABASE_URL` 决定模式**：首次切换时命令行要先连库，而应用还在文件模式；开发机 `.env` 里常带它，自测会被拖进 DB 模式。
- **用 mock 回归当发布闸**：`mockChat` 不读 system prompt。
- **token 预算**：要为每个模型维护分词器，结果随模型变；字符数确定、与模型无关。只算可编辑节，代码增长不占运营的余量。
- **版本号在建草稿时分配**：之后插进来的回滚或 rerender 拿到更大的号，草稿再发布时版本号会倒退，历史排序和 `/healthz` 都会乱。
- **草稿冲突按整份 sections 比较**：一次改锁定节的部署或一次回滚，就会让所有在编草稿再也发布不了。
- **启动时渲染结果不一致就拒绝启动，或只生成草稿**：代码改了硬性要求或锁定节就发不上去，要人工介入才能恢复服务。01 自动发布，生产租户的做法见开放问题 6。
- **rerender 先只在内存里生效，健康检查通过后再持久化**：要多一套「未持久化版本」的状态；代价只是失败部署留下最多两个版本，接受。
- **LISTEN/NOTIFY 做缓存失效**：单副本下写入就发生在本进程里；LISTEN 要一条独立连接，断线后会一直读旧 SOP。
- **持锁连接一断就立即退出**：会截断正在等待的企微回复和会话落盘，一次普通的 Postgres 重启就让应用硬退出，而对话本来不需要查库。
- **提交后从库里重读产品库快照**：两次写入挨得近时，先开始的重读可能后结束，把旧状态整体换上去。改为用提交后的行在内存里打补丁。
- **产品库 PUT 整条替换**：表单不认识或没回传的字段会被静默删掉，嵌套对象的键序取决于表单的输出顺序。改为字段级补丁加递归键序合并。
- **检索按条向量缓存（01 就做）**：20 条线路全量重建只要一次请求；按条缓存和它的断言测的是 01 用不上的优化，03 换 pgvector 时一起做。
- **报价快照提前到 01**：它牵动订单和报价入库，属于 02 的范围；只把报价快照单独提前，又得先定 02 的报价 schema。01 改为锁定计价与条款字段。
- **现有自测直接切到 PGlite（总参考开放问题的方案 A）**：6 组自测要为异步存储改写，违背「断言一条不改」；DB 路径由新增三组和 DB 模式的 eval 覆盖。
- **砍掉或推迟 Hono RPC**：见 R17。
- **argon2id**：Node 没有内置实现，要引入原生依赖，Alpine 镜像和 CI 都要编译；scrypt 是 `node:crypto` 内置，参数按 OWASP 取下限。
- **锁定节存在 DB 里，跟着版本走**：代码改了锁定节就无法下发；回滚还会把锁定节退回旧代码的口径，跟代码对不上。
- **只锁四节**：「各阶段目标」「订单」「我们没有的目的地」也被代码和断言依赖；前言不单独成节，往返就不相等。
- **让 `engine.selftest.ts` 直接 import 共享清单**：要改 6 处断言代码，违背「断言一条不改」。改用源码扫描测试防止漂移。
- **给 `users`、`auth_sessions`、`tenants` 也套 RLS 模板**：登录时还不知道租户。
- **`memberships` 不启用 RLS**：确实更简单，但「带 `tenant_id` 的表都套模板，除显式豁免清单外」这条规则就多了一个没有理由的例外，以后加成员管理页时容易漏。让函数自己设租户，代价只有一行。
- **认证函数交给 `agent_platform` 拥有，再给它写全放行策略**：要额外给它 schema 的 CREATE 权限，并维护一条放行策略；01 没有跨租户读取的需求。
- **为显示姓名给 `agent_app` 授 `users` 的 SELECT**：`users` 不开 RLS，这等于让运行时角色读到全部账号的口令哈希。改为写入时快照操作者姓名。
- **按邮箱硬锁登录**：知道 owner 邮箱的人每 15 分钟发 5 次错口令，owner 就永远登不进后台。
- **允许下架 active 条目**：`/api/proposal` 和方案书页按 id 查当前产品库，已发出的链接会 404。
- **JWT 或明文存 token**：JWT 做不了空闲过期和即时吊销，明文 token 一旦库被导出就能直接冒用。
- **CSRF 只靠 SameSite**：`Lax` 挡不住同站子域和部分顶层导航。改用派生的 `x-csrf` 头，不用另外存库。
- **应用启动时自己跑迁移**：运行时角色就得有 DDL 权限，而且两个副本会抢着迁移。
- **所有服务共用一份 `.env`**：app 被攻破就能拿到 owner 凭据关掉 RLS，或者用 platform 凭据读出全部口令哈希。
- **备份用受 RLS 约束的角色或 `--enable-row-security`**：前者直接报错，后者在没设租户时静默导出 0 行。
- **库为空时自动从 `data/` 播种**：切换就变成了隐式动作；库空了可能是事故，这时应该拒绝启动，而不是悄悄播种。
- **import 覆盖已有内容**：会冲掉运营在后台的修改。
- **`tenants.catalog_rev` / `tenants.settings` 第一天就进 schema**：没有读写方。以后加列不涉及数据风险。
- **`usage_daily` 在 01 建表**：没有写入方。
- **整个产品库存成租户的一行 JSON**：两个人改不同的条目会互相覆盖，审计 diff 的粒度也太粗。
- **01 就做平台角色的跨租户读取**：一个容器一个租户期间没有这个需求（04）。
