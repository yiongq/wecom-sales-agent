# 05 · 同部署多租户 + 一键体验沙箱

Status: draft
Phase: 5 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」（2026-10-10 拆分之后的编号）
Depends on: [04 · 行业包抽取](../04-industry-packs/spec.md)（开工时须已 implemented）；[03](../03-channels-v2/spec.md) 的按账号运行时与 R20 留的缝；[02](../02-conversations-workbench/spec.md) 的 PG 会话存储、写队列、spill、清除函数、任务表、console 事件流；[01](../01-pg-config-console/spec.md) 的 `withTenant`、三个角色、RLS 模板、认证函数、租户锁。选型见 [ADR-001](../../adr/adr-001-postgres-drizzle.md)（隔离两层都做、公开路由按域名或 `SECURITY DEFINER` 函数解析、内存键带租户）、[ADR-002](../../adr/adr-002-console-vite-react.md)（一个进程一个镜像）
Supersedes in part: [01](../01-pg-config-console/spec.md) 不变量 3「DB 模式下进程只装载 `DEFAULT_TENANT_SLUG` 这一个租户，每个进程内配置缓存都带着它的 id，并持有它的 advisory lock」——改为装载宿主、设了 `public_host` 的其他 standard 租户与未到期的沙箱，租户状态带所属租户的 id，进程持有每个已装载租户的锁（R1–R3）；01 R9 末句「一个容器一个租户期间，进程只装载 `DEFAULT_TENANT_SLUG` 这一个租户，公开路由都用它」——改为按 Host 解析（R4）；01 不变量 23「认证只能经五个 SECURITY DEFINER 函数」——加上 R7 的三个沙箱函数（它们建、删沙箱的合成用户、成员关系与登录会话）。原因：一个进程要服务多个租户，公开路由与登录不能再落到环境变量定的租户上；沙箱由公开请求开通，`agent_app` 要经收窄的函数建、删沙箱，而 app 进程照旧不能持有平台凭据（01 R19）。
Amends: 00「部署 profile 与开关」加开关 `sandbox`（R15）；01「数据库」加 `tenants` 的五列、表 `sandbox_pool_daily`、三个沙箱函数与授权、命令 `tenant-host` 与 `tenant-budget`、审计动作（R7、R12、R14）；02 R6 加一类「沙箱会话」：进 PG、随租户整体删除、不是 demo 类（R8）；02 R22 的公开路由加沙箱 Host 一组，`/healthz` 加 `tenancy`（R4、R10、R18）；后台 UX spec 的 `Me` 加 `sandbox`（R10）；03 R20 留下的「公开路由怎么解析租户」定为按 Host、key 仍只在租户内唯一（R4）；03 R22 的脱敏正则认 `sbx-`；03 的 `channel_accounts_guard` 拒绝沙箱租户（R11）；04 R2 的 `bindPack` 绑定挂到租户运行时上（R2）；04 R14 的回滚检查加 `pre-05`（R17）。

## 背景与问题

04 之后同一套引擎只改配置就能换品牌、换行业，但一个进程仍只服务一个租户。目前没有具体客户，第一批真实客户仍「一家一个实例」，本阶段的价值主要是让访客亲手体验工作台（一键体验沙箱），以及以后的托管。开工前的只读盘点（按 `e5affab`，协调者另存，不进仓库）查到：

- **一个进程一个租户写在很多地方。** 启动按 `DEFAULT_TENANT_SLUG` 解析租户、取锁、装一份配置（`src/config/source.ts:332`、`:620`）；会话存储与渠道从同一个 `configRuntime()` 取 `tenantId`（`src/server.ts:1038`、`:1044`）；登录与 cookie 固定查它（`src/auth/session.ts:137`、`:206`）；产品库写入与运行数字明确拒绝别的租户（`src/config/catalog.ts:109`、`src/ops/metrics.ts:55`）。
- **公开路由没有租户维度。** 订单、支付页、方案书、隐私说明、模拟器直接查全局 identity map 与当前绑定（`src/server.ts:613`、`:696`、`:757`、`:919`、`:410`）；网页入口与企微回调按 key 在当前租户的账号里找（`src/channels/accounts.ts:221`）。库里不同租户可以有相同的会话 id、订单 id 与账号 key。
- **进程内状态多是按裸 id 的模块级单例。** 行业包绑定一个模块变量（`src/core/pack-api.ts:600`），配置一个 `loaded`（`src/config/source.ts:209`），会话与订单各一个全局 Map（`src/store.ts:113`），接管代次、发送账本、洞察缓存、console 事件环、SSE 订阅只按会话 id 建键。`src/` 里模块顶层的集合 91 个、模块级 `let` 115 个，评测的清理清单（`eval/v2/isolation.ts:11`）只登记了一部分；RLS 管不到它们（ADR-001 决策 4）。
- **用量有租户、预算没有。** `usage_daily` 主键带租户（`src/db/schema.ts:466`），内存累加器却只按（日、模型、用途）建键、由绑在当前 PG 后端上的一个 writer 写（`src/trace/usage-daily.ts:41`、`src/store.ts:238`）。访客预算是一个 `budget.json`，只在模拟器渠道的主对话占一个轮次名额（`src/budget.ts:9`、`src/core/engine/index.ts:610`）。
- **没有开通与删除整个租户的路径。** 开通是几条平台命令的组合，身份各不相同（`src/cli/tenant-create.ts:18`、`src/cli/import-config.ts:11`）；`erase-conversation` 只删一个会话、留下订单与审计；租户外键没有级联，`agent_app` 对 `tenants` 只有 SELECT（`drizzle/0001_rls_auth.sql:284`）。
- **demo 的「免密」只是只读**（`src/console-api/app.ts:251`）。直接开一个可写的公开账号，人工回复会经企微真发给扫码的客户，访客之间互相看到聊天、改坏 SOP 与价格（owner 2026-10-10 否决）。
- **出站不看租户。** 发送按会话的 `channel` 选适配器（`src/server.ts:103`）；企微适配器内部还有自动回复、兜底、欢迎语、恢复的发送（`src/adapters/wecom.ts:1407`、`:1788`）；群通知与告警各走一个全局 webhook（`src/notify/notifier.ts:85`、`src/ops/alert.ts:117`）。

本文的词：**宿主租户**是 `DEFAULT_TENANT_SLUG` 指的那个（线上 demo 就是它）；**standard 租户**是普通租户（含宿主）；**沙箱**是 `kind='sandbox'` 的临时租户；**沙箱 Host** 是专门服务沙箱的主机名。

## 目标

1. **一个进程服务多个租户**：宿主、按 Host 选入的 standard 租户与沙箱；配置、品牌、绑定、产品库、索引、会话与订单、缓存、事件与订阅互不可见。
2. **公开路由按 Host 解析租户**（沙箱 Host 上按会话 cookie），解析不出就 404，不落到环境变量里的默认租户。
3. **从模板开通租户、整租户删除**：开通一个事务；删除能证明删干净（库里 0 行、进程里 0 个键）。
4. **模型用量与花费按租户记账**：沙箱硬上限，standard 租户软上限告警。
5. **一键体验沙箱**：引导页点「体验工作台」→ 从模板开通临时租户（配置、种子会话、订单、产品库都是副本）→ 免密进工作台随便操作（接管、回复、改价、标已付、改 SOP）→ 模拟器连着同一份副本，工作台回复实时出现 → 发送只进模拟器 → 24 小时后整个租户删掉。
6. **跨租户泄漏测试覆盖进程内状态**；两个租户交错对话时各自命中自己的前缀。
7. **宿主不受影响**：线上 demo 的四个哈希、demo 行为、作战室口径照旧。

## 非目标

- 第二个真实行业包与类型泛化（阶段 7）；看板拆分与撤掉作战室 `admin.html`（以后；本阶段作战室只属宿主）。
- 付费、计费、试用转正式、自助注册与托管的运营设施：另记（ADR-003 归私有运营层）。
- 线上开共享的可操作 demo 账号加定时重置：否决，见「被否决的方案」。
- 线上 demo 建网页渠道账号（owner 2026-10-11 定不建）；线上开第二个 standard 租户（只在测试与本机演练里验）。
- console 的渠道账号页（04 非目标写的「阶段 5」，见开放问题 10）、成员管理页、在 console 里切换租户（同一邮箱属于多个租户时按各自的 Host 登录）。
- prod 开沙箱；沙箱里的正式渠道、跟进、群通知；把沙箱模拟器分享给别人当客户（开放问题 9）。
- 多副本、LISTEN/NOTIFY、按租户的公平排队（沙箱只有一个并发上限）。

## 前置条件

- 04 `Status: implemented`，线上 demo 跑 04 之后的版本。
- 锁定套件（8 个文件）照旧锁定；开工核对记下它们的 sha256、`PREFIX sha256` 与线上 `/healthz` 的四个哈希。
- 开工核对把三张清单落进 plan：模块级状态（每项标成 R5 的三类之一）、入口（每个 HTTP 路由、定时器、渠道回调与轮询、任务、store 回调在哪建立租户作用域）、出站（「出站」表逐行对上代码位置）。
- 线上开沙箱之前，沙箱 Host 的 DNS 与 Caddy 已配好（域名不进仓库）。

## 开工前裁决

| #   | 主题                    | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 宿主租户                | DB 模式照旧要求 `DEFAULT_TENANT_SLUG`，含义收窄为宿主：`var/` 下的文件状态（demo 类 JSON、`budget.json`、`usage.json`、env 企微账号与 cursor、`kf-qr.png`、检索缓存）、旧接口与作战室、`sim-` 访客、种子保鲜与访客清理都只属于它；它也是沙箱的配置模板（R9）。宿主必须是未停用的 standard 租户。公开路由不再直接用它（R4）。文件模式只有一个运行时，就是宿主                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R2  | 租户运行时与作用域      | 每个装载的租户一个 `TenantRuntime`，今天的模块级租户状态搬进它或改成以 `tenantId` 开头的键（R5）。`AsyncLocalStorage` 携带当前运行时，由入口建立：HTTP 中间件（R4 解析之后）、渠道运行时的回调与轮询（`account.tenantId`）、任务认领、每个租户的定时器、store 的提交回调。`currentRuntime()` 返回作用域里的；没有作用域时注册表里只有一个就是它（文件模式、自测、单租户实例），否则抛 `TenantScopeMissing`，不回落。`bindPack(runtime, brand)` 写进当前运行时，`currentPack()` 读作用域；04 的门面不加租户参数（锁定套件跑文件模式，只有一个运行时）                                                                                                                                                                                                                                                                                                                                        |
| R3  | 装载哪些租户、锁        | 启动时先删到期的沙箱（R12），再装载宿主、设了 `public_host` 的其他 standard 租户、未到期的沙箱；没设 `public_host` 的其他 standard 租户不装载、记一行（库里的测试或演练租户不会被意外服务）。装了两个及以上 standard 租户时每一个（含宿主）都要有 `public_host`，否则以 `tenant_host_missing` 拒绝启动。standard 租户装载失败照 01 R1 拒绝启动；沙箱装载失败就改成到期、跳过。一条专用锁连接持有每个已装载租户的 advisory lock，沙箱开通后取、删除后放；锁连接断开时全部租户的配置写入一起暂停，重连后逐个重取                                                                                                                                                                                                                                                                                                                                                                              |
| R4  | 公开路由按 Host 解析    | 租户只由 Host 决定：等于 `SANDBOX_HOST` → R10；等于某个已装载 standard 租户的 `public_host` → 它；否则本进程只装了一个 standard 租户 → 它；否则租户路由一律 404。Host 取请求头、去端口、转小写，不读 `X-Forwarded-Host`。解析出租户之后只在它里面按订单 id、线路 id、账号 key 找；key、企微前缀、`open_kfid` 仍只在租户内唯一（03 R20 留的「key 全局唯一还是路由里带租户」定为后者，Host 就是路由里的租户）。逐条见「公开路由」表。消息里的相对链接不变；绝对链接按租户拼：宿主照旧 `PUBLIC_BASE_URL`（宿主设了 `public_host` 时两者主机名必须相同，否则拒绝启动），其他 standard 租户 `https://<public_host>`                                                                                                                                                                                                                                                                              |
| R5  | 进程内状态按租户        | 逐项见「进程内状态」表，分三类：**租户状态**挂在运行时上或键以 `tenantId` 开头，并向登记表登记 `keyCount`、`drop`、`reset`；**实例级**（IP 限流桶、模型并发闸、按模型的探测与统计、profile、告警总量限流）保持全局，各写一句理由；**按对象键**（以会话对象为键的弱引用表、每轮局部的 Map、每轮的 `AsyncLocalStorage`）不动。新检查 `scripts/check-tenant-state.ts` 进 `pnpm lint`：`src/**`（自测除外）每个模块顶层的 `Map`、`Set`、`WeakMap`、`WeakSet`、`AsyncLocalStorage` 与模块级 `let` 都要在 `src/tenancy/state-manifest.ts` 里标了类，标成租户状态的要有同名登记项。`eval/v2/isolation.ts` 改为调登记表的 `reset()`，私有补丁只留给实例级状态                                                                                                                                                                                                                                       |
| R6  | 事件、渠道、任务、spill | 领域事件带 `tenantId`；每个运行时一个 console 事件环、序号、listener 与计数去抖（今天一份，`src/console-api/events.ts:23`）；模拟器与网页的 SSE 订阅按（租户，会话）建键。渠道注册表装全部已装载 standard 租户的账号，`accountByKey` 加租户参数，`pushRoute` 只在会话所属租户的账号里匹配前缀。任务 runner 仍是一个，每拍逐个 standard 租户认领。spill 回放时每个租户只认自己的（今天遇到别的租户的就以 `spill_conflict` 拒绝启动，`src/store/pg-backend.ts:904`），已删沙箱的 spill 丢弃并记一行。停机时 standard 先、沙箱后逐个排空                                                                                                                                                                                                                                                                                                                                                       |
| R7  | 租户种类与新列          | `tenants` 加 `kind`、`expires_at`、`template_tenant_id`、`public_host`、`llm_daily_alert_milli`（DDL 见「数据库」）。`agent_app` 照旧不能写 `tenants`；建、删沙箱只经三个 `SECURITY DEFINER` 函数（属主 `agent_owner`、`search_path` 钉死、只 GRANT 给 `agent_app`）：`sandbox_tenant_create`、`sandbox_tenant_expire`、`sandbox_tenant_purge`，对 standard 租户一律报错。`public_host` 与软上限由平台命令 `tenant-host set/clear`、`tenant-budget set/clear` 改（列级 UPDATE，写审计，下次启动生效）                                                                                                                                                                                                                                                                                                                                                                                       |
| R8  | 沙箱的数据契约          | 按开放问题 2 的推荐。沙箱的会话、消息、订单、trace、同意记录与 standard 租户一样进 PG（要求 `SESSION_STORE=db`），随租户整体删除，没有 JSON 落盘。沙箱里没有 demo 类 id：种子副本 `wecom:cust_<x>` 改成 `wecom:sbx_<x>`，模拟器新会话是 `sbx-` 加 24 位十六进制。02 R6、`conversations_id_check`、02 不变量 11、console 排除 `sim-` 原文都不动，宿主的种子与访客照旧只在 JSON。沙箱会话的 `channel` 只用于展示，发送规则一律按模拟器（R11）                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R9  | 从模板开通              | 按开放问题 1 的推荐，范围与步骤见「开通与删除」。一个事务，身份 `agent_app`：经 `sandbox_tenant_create` 建租户行、合成用户与 owner 成员关系，再由 `withNewSandboxTenant`（`src/db/client.ts`）把事务的 `app.tenant_id` 设成新租户；写入复用 `src/config/transfer.ts` 与 `src/cli/session-transfer.ts`，SOP 按沙箱自己的输入渲染一次，登录会话经 01 的 `auth_session_create`。提交后按启动装载的同一条路径装载（读库预载，不从宿主内存拼）。开通在进程内串行，R13 的上限在锁里判。点开始到进工作台 p95 不超过 3 秒                                                                                                                                                                                                                                                                                                                                                                           |
| R10 | 沙箱 Host 与免密会话    | 按开放问题 5、7 的推荐。沙箱只在 `SANDBOX_HOST` 上服务，那里的租户由 cookie `__Host-sbx` 决定（32 字节随机，库里存 sha256，HttpOnly、Secure、SameSite=Lax、Path=/，Max-Age 到沙箱到期）；同一套 console、模拟器、支付页、方案书、隐私说明按这个租户服务。没有有效 cookie 时只有 `/try`、`POST /api/sandbox`、静态资源与 `/healthz`，其余页面跳 `/try`、接口回 401 `sandbox_required`。会话行在 `auth_sessions`，角色 owner、显示名「体验访客」，期限照 01、另以沙箱到期为上限。沙箱 Host 上不读 `__Host-sid`、没有口令登录；别的 Host 不读 `__Host-sbx`。一个浏览器至多一个活着的沙箱：带有效 cookie 再开通返回同一个；结束或到期之后才能开新的；多个标签页共用                                                                                                                                                                                                                             |
| R11 | 只进模拟器              | 按开放问题 6 的推荐，逐个出口见「出站」表。沙箱没有渠道账号（库触发器拦），企微的一切请求不会为它发生；server 的发送选择先看租户种类，沙箱一律走自己的模拟器 SSE，没有 48 小时窗口与发送额度。沙箱不排跟进、转人工通知、保留期清理任务，转人工只出现在它自己工作台的铃铛里。只关乎某个沙箱的告警只记日志与 `/healthz` 计数，实例级的照发。沙箱轮次不导出 OTel。模型与 embedding 照常，计沙箱预算                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R12 | 到期删除                | 实例级定时器每分钟查 `kind='sandbox' AND expires_at <= now()`，逐个：① 运行时改 `closing`，新请求回 410 `sandbox_expired`（页面跳 `/try`），关掉它的 SSE；② 等在途轮次与写队列至多 30 秒，排队的模型请求 abort；③ 关存储后端；④ 一个事务调 `sandbox_tenant_purge`：先把它的 `usage_daily` 按天并进 `sandbox_pool_daily`，再按外键顺序删掉每张带 `tenant_id` 的表里它的行、它的 `auth_sessions`、成员关系、合成用户与租户行，删完逐表复数、有剩就报错回滚，返回每表删除数；⑤ 不论 ④ 成败：摘下运行时、登记表逐项 `drop`、放锁；④ 失败下一分钟重试（它不会再被装载）。删除清单是函数里的静态表名，一条自测按系统目录核对它覆盖每一张带 `tenant_id` 的表。日志一行：短码、寿命、轮次、花费、每表删除数。「结束体验」调 `sandbox_tenant_expire` 后走同一条路。启动时先删到期的；`FLAG_SANDBOX` 关着启动时删掉全部沙箱。备份里的副本随保留期（本地 7 天、异地 30 天，`deploy/backup.sh:21`）滚掉 |
| R13 | 限额与滥用              | 数值见开放问题 8。开通前在锁里判：同时活着的沙箱数、全局每小时与每天的开通数、每 IP 每天的开通数（`clientKey`，尽力而为，兜底靠全局上限）、当天池花费；超了回 429 `sandbox_limited`（带 `retryAfter`）或 503 `sandbox_unavailable`。每个沙箱：模型额度（R14）、新会话数、模拟器 SSE 至多 10 条，聊天照旧按 IP 限流。沙箱的模型请求先过信号量 `SANDBOX_LLM_MAX_INFLIGHT` 再进全局闸（`src/llm-gate.ts:28`），其余名额留给 standard 租户。开通只收同源、`application/json` 的 POST（与 console 登录同一套跨站判定），不加验证码                                                                                                                                                                                                                                                                                                                                                               |
| R14 | 每租户预算与成本        | 按开放问题 4 的推荐。**记账**：`UsageEvent` 带作用域里的 `tenantId`；`usage_daily` 累加器按（租户、日、模型、用途）建键，每租户一个 writer；`usage.json`、`/api/usage` 与访客预算 `budget.json` 只管宿主（作战室口径不变）。**沙箱**：金额（千分之一元，价格表同 `src/usage.ts`）与请求次数两道硬上限，先到先停（未知价格的模型记 0 元，靠次数兜底），覆盖全部用途；每次要花模型的操作开始前判一次。超了：对话这一轮降级成 mock（`turn_traces.outcome = 'budget'`，与访客预算同一条路），洞察、建议、草稿回 429 `llm_budget_exhausted`，索引不重建；超出至多一次操作。已花数装载时从它的 `usage_daily` 读回；池的当天数 = `sandbox_pool_daily` 当天的行 + 活着的沙箱当天的花费。**standard 租户**：只有软上限 `llm_daily_alert_milli`，当天越过时告警一次，不降级、不拒绝任何调用                                                                                                           |
| R15 | profile 与开关          | 按开放问题 3 的推荐。新开关 `sandbox`（`FLAG_SANDBOX`）：demo 默认关，线上 demo 显式开；prod 封顶为关。开着时要求 `CONFIG_SOURCE=db`、`SESSION_STORE=db`、`SANDBOX_HOST` 已设且不等于任何 `public_host` 与 `PUBLIC_BASE_URL` 的主机名，否则以 `sandbox_misconfigured` 拒绝启动。它不进 00 的基线开关日志行（锁定的 `server.selftest.ts` 逐字比较），生效值另打一行。每个租户的生效开关 = profile ∧ 种类掩码：沙箱关掉 `anon_readonly_admin`、`seed_freshen`、`legacy_admin_writes`、`web_channel`，其余随 profile；standard 租户的掩码全开                                                                                                                                                                                                                                                                                                                                                  |
| R16 | 隔离测试                | 新套件 `src/tenancy/isolation.selftest.ts`：进程内部分跑 PGlite；RLS、沙箱函数、删除与清单覆盖跑真实 PG（`PG_TEST_URL`，CI 必跑）。两个 standard 租户：A 是旧版模式的宿主；B 是「山海旅行」品牌，多一条只有它有的线路、改过一条共有线路的价格，并与 A 有**同一个**会话 id、订单 id 与网页账号 key。本机假模型 HTTP 服务（04 R10 同一种）记下每个请求的 system 与 tools 字节，B 的响应故意晚到，让两边的轮次交错。另一组用宿主加沙箱跑沙箱全程                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R17 | 回滚                    | 04 及更早的镜像只认宿主：别的 standard 租户的 Host 会拿到宿主的页面与数据（同 id 的订单就是串台），沙箱也不再到期删除。`deploy.sh` 的目标判定加 `pre-05`（目标 tag 里没有 `src/tenancy/runtime.ts`），部署旧 tag 与健康检查失败后的自动回滚都经 `rollback-guard.sh`。风险：宿主以外有 standard 租户设了 `public_host`，**或**库里有任何沙箱行；库问不到时正在跑的是 05 之后的镜像就按有风险处理。检查以 6 退出并打印步骤（前者「`tenant-host clear` 那些租户、摘掉域名」，后者「`FLAG_SANDBOX=off` 重启、确认 `tenancy.sandboxes` 为 0」）；`deploy.sh` 照约定转成 1。两样都没有的照常回滚                                                                                                                                                                                                                                                                                                  |
| R18 | 可观测                  | `/healthz` 原有字段含义不变（`config`、`store`、`channels`、`visitorLLM` 都是宿主的，四个哈希就是宿主的）；加 `tenancy: { standard, sandboxes, sandboxFailing, pool: { day, provisioned, costMilli, capMilli } }`。`ok` 另并入其他 standard 租户的同类条件，沙箱不影响 `ok`。日志的租户取作用域（今天是模块变量，`src/log.ts:40`）。新告警键 `sandbox_pool`：池花费到上限或开通被全局上限拒绝，每天至多一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 接口与数据流

### 模块

```
src/tenancy/
  runtime.ts          TenantRuntime、注册表、作用域、currentRuntime()（R2）
  hosts.ts            Host 解析与中间件（R4）
  state.ts            登记表（R5）
  state-manifest.ts   模块级状态清单（R5，lint 读它）
  budget.ts           TenantBudget（R14）
  sandbox/            provision.ts（R9）、reaper.ts（R12）、routes.ts（R10）
src/db/client.ts      withNewSandboxTenant
drizzle/0008_*.sql    新列、新表、三个函数、授权、channel_accounts_guard
scripts/check-tenant-state.ts
data/sandbox-seeds.json、public/try.html
```

### 租户运行时

```ts
// src/tenancy/runtime.ts（新）
export type TenantKind = 'standard' | 'sandbox';
export interface TenantRuntime {
  readonly id: string;
  readonly slug: string;
  readonly kind: TenantKind;
  readonly isHost: boolean; // 宿主（R1）
  readonly expiresAt: number | null; // 只有沙箱有
  readonly publicBase: string; // R4；沙箱是 https://<SANDBOX_HOST>
  readonly flags: Readonly<DeployFlags>; // profile ∧ 种类掩码（R15）
  state: 'serving' | 'closing' | 'closed';
  readonly config: TenantConfig; // 今天 source.ts 的 Loaded
  pack: PackBinding; // 今天 pack-api.ts 的 binding
  readonly store: TenantStore; // sessions、orders、PG 后端；宿主另有文件后端
  readonly budget: TenantBudget;
  readonly events: ConsoleEventHub;
}
export class TenantScopeMissing extends Error {}
export function withTenantScope<T>(rt: TenantRuntime, fn: () => T): T;
export function currentRuntime(): TenantRuntime; // R2
export function runtimeOf(tenantId: string): TenantRuntime | undefined;

// src/tenancy/state.ts（新）
export interface TenantScopedState {
  name: string; // 与清单里的登记名一致，如 'takeover.gens'
  keyCount(tenantId: string): number;
  drop(tenantId: string): void;
  reset(): void; // 评测场景之间
}
export function registerTenantState(s: TenantScopedState): void;
export function tenantKeys(tenantId: string): Record<string, number>; // 删除证明与泄漏测试用

// src/tenancy/state-manifest.ts（新）：键是「文件:标识符」
export const STATE_MANIFEST: Record<
  string,
  { kind: 'tenant'; state: string } | { kind: 'instance'; why: string } | { kind: 'object-keyed' }
>;
```

### 公开路由

| 路由（现状出处）                                                                                                                       | 05                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/pay/:orderId`、`GET /api/orders/:id`、`POST /api/orders/:id/pay`（全局 identity map、当前绑定，`src/server.ts:613`、`:631`、`:696`） | R4 解析出的租户里按订单 id 找，用它的品牌；模拟支付按它的生效开关                                                                                                            |
| `/proposal/*`、`/api/proposal/:routeId`（当前产品库与版本历史，`:757`、`:813`）                                                        | 该租户的                                                                                                                                                                     |
| `/privacy`（全局快照，`:919`）                                                                                                         | 该租户的当前隐私说明                                                                                                                                                         |
| `/chat.html`、`POST /api/chat`、`/api/stream/:sessionId`、`/api/sessions/:id`（`sim-`、全局订阅，`:410`、`:429`、`:507`）              | 宿主的 Host 照旧。沙箱 Host：要 cookie；页面带来的 `sim-<x>` 当作 `sbx-<x>`，也认沙箱里已有的会话 id（工作台「在模拟器里打开」带 `?c=<id>`）。其他 standard 租户的 Host：404 |
| `/w/:key`、`/api/web/:key/*`（已装载账号按 key，`src/web/routes.ts:119`）                                                              | 该租户的账号里按 key；沙箱 Host 404                                                                                                                                          |
| `/wecom/callback/:key`、`/wecom/callback`（`src/server.ts:830`、`:839`）                                                               | 该租户的账号里按 key；不带 key 是该租户前缀为 `wecom:` 的账号，env 凭据只属宿主；沙箱 Host 404                                                                               |
| `/console/*`、`/api/console/*`（登录与 cookie 固定查当前租户，`src/auth/session.ts:137`、`:206`）                                      | standard 的 Host：登录查该租户成员，`__Host-sid` 的会话租户必须是它（认证函数本就按租户查）。沙箱 Host：R10                                                                  |
| 旧接口与作战室（`/api/sessions*`、`/api/orders`、`/api/admin/*`、`/api/usage`、`/api/insights`、`/admin.html`）、`/kf-qr.png`          | 只在宿主的 Host 上，其余 404                                                                                                                                                 |
| `/healthz`、`/`、`/guide.html`                                                                                                         | 实例级，照旧；`/healthz` 加 `tenancy`                                                                                                                                        |
| `/try`、`POST /api/sandbox`、`POST /api/sandbox/end`（新）                                                                             | 宿主的 Host 上 `/try` 302 到沙箱 Host（开关关着时回引导页并带提示）；后两个只在沙箱 Host                                                                                     |

### 进程内状态

| 状态（出处）                                                                                                                                                                                                                                                                     | 05                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行业包绑定（`src/core/pack-api.ts:600`）；配置 `loaded`、`catalogListeners`、过期标记（`src/config/source.ts:164`、`:209`）                                                                                                                                                      | 运行时的 `pack`、`config`；`turnPin` 已核对 tenantId，保留                                                                                                                         |
| 语义索引（`src/core/retrieval.ts:28`）                                                                                                                                                                                                                                           | 按（检索文本指纹，模型）共享的只读缓存，运行时持引用；内容相同才共用，不泄漏，沙箱副本与宿主共用、不花 embedding。缓存文件：宿主照旧，其他 standard 租户按指纹分文件，沙箱只在内存 |
| 会话与订单 Map、PG 后端、文件后端（`src/store.ts:113`、`:119`）；引擎会话串行链（`src/core/engine/index.ts:150`）                                                                                                                                                                | 运行时的 `store`（文件后端只在宿主）；串行链键（租户，会话）                                                                                                                       |
| 接管代次、回复去重（`src/handoff/takeover.ts:117`、`:304`）、发送账本（`src/quota/ledger.ts:179`）、洞察 / 建议 / 草稿缓存（`src/core/insight.ts:33`、`:93`）                                                                                                                    | 键带租户或挂到运行时                                                                                                                                                               |
| 运行数字缓存（`src/ops/metrics.ts:50`）                                                                                                                                                                                                                                          | 已按租户建键；去掉「拒绝非当前租户」，按作用域                                                                                                                                     |
| 渠道账号与注册表（`src/channels/accounts.ts:208`、`src/channels/registry.ts:93`）；SSE（`src/adapters/simulator.ts:9`、`src/adapters/web.ts:14`）、console 事件环（`src/console-api/events.ts:23`）、领域事件（`src/store/events.ts:12`）                                        | R6                                                                                                                                                                                 |
| 隐私说明与轮询（`src/privacy/privacy.ts:14`、`:19`）                                                                                                                                                                                                                             | 运行时上，轮询逐个租户                                                                                                                                                             |
| 跟进 `known`、任务 `mine`、通知 `unsaved`/`waiting`（`src/jobs/followup.ts:87`、`src/jobs/runner.ts:131`、`src/notify/handoff.ts:133`）                                                                                                                                          | 键带租户；沙箱没有这些                                                                                                                                                             |
| `usage_daily` 累加器与 writer（`src/trace/usage-daily.ts:30`、`:41`）                                                                                                                                                                                                            | 键带租户，每租户一个 writer                                                                                                                                                        |
| `usage.json`、`budget.json`（`src/usage.ts:88`、`src/budget.ts:9`）、种子保鲜与访客清理（`src/store.ts:589`、`:660`）                                                                                                                                                            | 只属宿主                                                                                                                                                                           |
| 日志与 OTel 的租户（`src/log.ts:40`、`src/ops/otel.ts:49`）                                                                                                                                                                                                                      | 取作用域                                                                                                                                                                           |
| **实例级**：IP 桶与网页 SSE 总量（`src/http-guards.ts:67`、`src/web/routes.ts:42`、`src/adapters/web.ts:23`）、模型并发闸（`src/llm-gate.ts:28`）、模型探测与统计（`src/core/llm/client.ts:50`、`:190`）、profile（`src/profile.ts:134`）、告警（`src/ops/alert.ts:55`、`:141`） | 保持全局：资源保护或按模型的事实，不含租户数据；沙箱另加信号量（R13）                                                                                                              |
| **按对象键 / 每轮**：以会话对象为键的弱引用表（如 `src/store.ts` 的 `tombstoned`）、每轮的工具复用 Map（`src/core/llm/client.ts:600`）、trace 的 `AsyncLocalStorage`（`src/trace/recorder.ts:115`）                                                                              | 不动                                                                                                                                                                               |

### 出站

| 出口（出处）                                                                                                                           | 沙箱                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 人工回复、付款确认、通知：按会话 `channel` 选适配器（`src/server.ts:103`、`src/payment/orders.ts:105`）                                | 先看租户种类，一律走沙箱的模拟器 SSE                                     |
| 企微发送：env 的 `callApi('kf/send_msg')`、库里账号的 `sendMsgRequest`（`src/adapters/wecom.ts:659`、`:1095`），`pushRoute`（`:2796`） | 不可达：沙箱没有账号（触发器拦），`pushRoute` 只在会话所属租户的账号里找 |
| 适配器内部的自动回复、兜底、欢迎语、`send_msg_on_event`、启动恢复（`:1407`、`:1788`），token、`sync_msg`、上传（`:419`）               | 不可达：沙箱没有企微运行时                                               |
| 转人工群通知，任务与内存退避两条路（`src/notify/notifier.ts:85`、`src/notify/handoff.ts:178`）                                         | 不发，只进沙箱工作台的铃铛                                               |
| 运维告警（`src/ops/alert.ts:117`）                                                                                                     | 实例级的照发；只关乎某个沙箱的只记日志                                   |
| OTel（`src/boot.ts:83`、`src/otel/export.ts:112`）                                                                                     | 沙箱轮次不导出                                                           |
| 模型与 embedding（`src/llm-gate.ts:89`、`src/core/retrieval.ts:60`）                                                                   | 照常，过沙箱信号量、计沙箱预算                                           |
| 整实例拨测与备份（`deploy/watch.sh:92`、`deploy/backup.sh:89`）                                                                        | 照旧；备份里的沙箱数据随保留期滚掉                                       |

### 开通与删除

| 内容               | 沙箱里是什么（开放问题 1 的推荐）                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SOP                | 宿主当前发布版本的节与品牌快照，渲染成沙箱的发布版本 1，四个哈希与宿主相同；草稿与历史不复制                                                                                                                          |
| 品牌、行业包       | `brand`、`pack_id` 取宿主的（demo 品牌为空，旧版模式）                                                                                                                                                                |
| 产品库             | active 条目的当前内容，各自版本 1，`ord` 原样；草稿条目与历史不复制                                                                                                                                                   |
| 快捷回复、隐私说明 | 未归档的快捷回复，顺序原样；当前隐私说明作为版本 1                                                                                                                                                                    |
| 种子               | `data/sandbox-seeds.json`（由 `scripts/seed-demo.py` 默认场景生成、时间存相对值）：13 个会话、3 个订单；会话 id 改成 `wecom:sbx_<x>`，订单 id 原样（主键带租户）；时间整体平移到最新一条在开通前 5 分钟（同保鲜规则） |
| 成员               | 只有合成用户「体验访客」（owner）：邮箱 `<slug>@sandbox.invalid`，口令哈希是校验不过的固定值                                                                                                                          |
| 不复制             | 宿主的成员、审计、渠道账号、真实会话与访客会话、trace、用量、任务、同意记录；复制只带内容，不带任何用户 id、成员姓名与变更说明                                                                                        |

开通（`POST /api/sandbox`，沙箱 Host）：① 带着有效 cookie 且沙箱在服务 → 200 原样返回；② 进互斥锁，判 R13；③ 读宿主的快捷回复（宿主的只读事务），其余模板内容取宿主运行时的内存；④ 一个事务：`sandbox_tenant_create(slug, 宿主 id, now + 24h, now)` → 设 `app.tenant_id` → 写配置、隐私说明、快捷回复、种子 → `auth_session_create` → 审计 `sandbox.create`；slug 是 `sbx-` 加 20 位小写 base32；⑤ 提交后按 R3 的路径装载、取锁、登记，失败则 `sandbox_tenant_expire` 并回 503；⑥ 回 201 `{ url: '/console/', expiresAt }` 并 `Set-Cookie`。删除按 R12。

### 预算

```ts
// src/tenancy/budget.ts（新）
export type LlmOp = 'chat' | 'followup' | 'insight' | 'suggestion' | 'draft' | 'embedding';
export interface TenantBudget {
  admit(op: LlmOp): boolean; // 操作开始前调；沙箱超了返回 false，standard 恒为 true
  charge(e: UsageEvent): void; // recordUsage 按作用域记到这里（UsageEvent 新增 tenantId）
  status(): { calls: number; costMilli: number; capCalls: number | null; capMilli: number | null };
}
```

引擎里今天的 `visitor = channel === 'simulator'`（`src/core/engine/index.ts:610`）改为：沙箱看 `budget.admit('chat')`，宿主的 `sim-` 会话照旧看访客预算，其余不判；降级都经同一个 `forceMock`。

### 数据库

```sql
-- drizzle/0008_*.sql
ALTER TABLE tenants
  ADD COLUMN kind text NOT NULL DEFAULT 'standard',
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN template_tenant_id uuid REFERENCES tenants(id),
  ADD COLUMN public_host text,
  ADD COLUMN llm_daily_alert_milli bigint;
-- CHECK：kind IN ('standard','sandbox')；(kind = 'sandbox') = (expires_at IS NOT NULL)；
--   kind = 'standard' OR (public_host IS NULL AND template_tenant_id IS NOT NULL AND llm_daily_alert_milli IS NULL)；
--   public_host 是小写主机名、不带端口；llm_daily_alert_milli >= 0
CREATE UNIQUE INDEX tenants_public_host_uq ON tenants (public_host) WHERE public_host IS NOT NULL;

-- 不带 tenant_id：只有计数与金额，不是租户数据，不套 RLS；沙箱删了统计还在
CREATE TABLE sandbox_pool_daily (
  day         date   PRIMARY KEY,
  provisioned int    NOT NULL DEFAULT 0 CHECK (provisioned >= 0),
  purged      int    NOT NULL DEFAULT 0 CHECK (purged >= 0),
  calls       bigint NOT NULL DEFAULT 0 CHECK (calls >= 0),
  cost_milli  bigint NOT NULL DEFAULT 0 CHECK (cost_milli >= 0)
);

-- 属主 agent_owner，SECURITY DEFINER，search_path = pg_catalog, public, pg_temp，表名全限定，只 GRANT EXECUTE 给 agent_app
-- create：模板须是未停用的 standard；p_expires_at 在 (p_now, p_now + 25h]；slug 以 sbx- 开头；建租户（pack_id、brand 取模板）、
--   合成用户、owner 成员关系（函数内设、复原 app.tenant_id，同 01 的认证函数）；provisioned + 1
CREATE FUNCTION sandbox_tenant_create(p_slug text, p_template uuid, p_expires_at timestamptz, p_now timestamptz)
  RETURNS TABLE (o_tenant uuid, o_user uuid);
CREATE FUNCTION sandbox_tenant_expire(p_tenant uuid, p_now timestamptz) RETURNS boolean;
-- purge：只删 kind = 'sandbox' 且 expires_at <= p_now 的；调用方须已在 withTenant(p_tenant) 里（同 02 的清除函数）
CREATE FUNCTION sandbox_tenant_purge(p_tenant uuid, p_now timestamptz) RETURNS json;
```

- 授权：`agent_app` 对 `sandbox_pool_daily` SELECT、INSERT、UPDATE；`agent_platform` 加 `GRANT UPDATE (public_host, llm_daily_alert_milli) ON tenants`。`channel_accounts_guard` 拒绝 `kind='sandbox'` 的租户。
- 审计动作加 `sandbox.create`、`sandbox.end`（在沙箱自己的审计里，随它删除）、`tenant.host_set`、`tenant.host_clear`、`tenant.budget_set`、`tenant.budget_clear`。
- 迁移 lint：`tenants` 的 CHECK 标注 `-- migration-allow: add-check 新列可空或带默认，旧镜像不写这几列`。

### 界面

- **引导页**：「体验工作台」按钮链到 `/try`，一句说明：临时环境、24 小时后删除、发送只进模拟器。
- **`/try`**（沙箱 Host）：说明（另加「不要输入真实个人信息」与备份保留期）与「开始体验」。开通中显示进度；被限额拒绝时显示原因并给宿主的只读工作台、网页模拟器两个入口；出错可重试；从已结束的体验跳来时说一句「上一次体验已结束」。
- **沙箱 console**：同一个前端。顶栏横幅「体验环境 · 剩余 X 小时 · 发送只进模拟器」，带「打开模拟器」「结束体验」；会话详情加「在模拟器里打开」；不显示登录页，`/me` 回 401 `sandbox_required` 时跳 `/try`。`Me` 加 `sandbox: { expiresAt: string } | null`。
- **沙箱模拟器**：同一份 `chat.html`，顶部同样一条提示，认 `?c=<id>`。锁定的 `server.selftest.ts` 对 `chat.html` 源码的检查（`LS_KEY`、单独执行的 `newSessionId()` 仍产出 `sim-`、`fillPayCard`、开场句）照旧通过。

### 环境变量

| 变量                                    | 默认    | 说明                         |
| --------------------------------------- | ------- | ---------------------------- |
| `FLAG_SANDBOX`                          | off     | R15                          |
| `SANDBOX_HOST`                          | 空      | R10，域名不进仓库            |
| `SANDBOX_MAX_LIVE`                      | 20      | 同时活着的沙箱               |
| `SANDBOX_PER_HOUR` / `SANDBOX_PER_DAY`  | 10 / 50 | 全局开通数                   |
| `SANDBOX_PER_IP_DAY`                    | 3       | 每 IP 每天开通数             |
| `SANDBOX_LLM_CALLS` / `SANDBOX_LLM_CNY` | 300 / 1 | 每个沙箱从开通到删除         |
| `SANDBOX_POOL_DAILY_CNY`                | 10      | 当天全部沙箱合计             |
| `SANDBOX_LLM_MAX_INFLIGHT`              | 2       | 沙箱同时在飞的模型请求       |
| `SANDBOX_MAX_CONVERSATIONS`             | 30      | 每个沙箱的新会话（种子不算） |

24 小时的寿命是常量。

## 不变量

1. 注册表里有两个及以上运行时时，在租户作用域外读写任何登记的租户状态都抛 `TenantScopeMissing`，不回落。
2. 两个租户用同一个会话 id、订单 id、账号 key 时，各自的 `getSession`、`getOrder`、接管代次、账本、SSE 订阅、console 事件互不可见。
3. 对话轮次发出的每个模型请求，system 与 tools 字节等于这一轮所属租户本轮捕获的发布版本；两个租户交错对话时各自的 `promptHash`、品牌、产品库、identity map 互不可见。
4. 一个公开请求只从 R4 解析出的那一个租户取数据；解析不出时 404。
5. 沙箱的任何出站都不经企微 API 与 `NOTIFY_WEBHOOK_URL`；库里沙箱的 `channel_accounts` 与 `jobs` 行数恒为 0。
6. 沙箱里没有 demo 类 id；宿主以外的租户没有 JSON 落盘。
7. 到期删除成功之后：以不经 RLS 的身份数，每张带 `tenant_id` 的表里该 id 的行数为 0，`tenants`、`users`、`auth_sessions` 里没有它；`tenantKeys(id)` 每项为 0，注册表里没有它。
8. `sandbox_tenant_purge` 的删除清单覆盖系统目录里每一张带 `tenant_id` 的表。
9. 三个沙箱函数对 standard 租户一律报错；`agent_app` 没有别的途径建、删租户。
10. `__Host-sbx` 只在沙箱 Host 上被读；沙箱 Host 上不读 `__Host-sid`、没有口令登录；一个沙箱的会话只能操作它自己。
11. 一个沙箱一生的模型花费与请求数不超过上限加一次操作的量；当天全部沙箱合计同理；沙箱在飞的模型请求不超过 `SANDBOX_LLM_MAX_INFLIGHT`。
12. standard 租户的模型调用不因预算降级或被拒。
13. `src/**` 的模块顶层集合与模块级 `let` 都在状态清单里，标成租户状态的都已登记。
14. 宿主的四个哈希、demo 行为与 `/healthz` 原有字段的含义与开工时相同。

## 兼容与迁移

- 迁移只扩：新列可空或带默认，新表、新函数旧镜像不碰。
- 升级没有手工步骤：单 standard 租户的实例按 R4 第三条照旧服务，`FLAG_SANDBOX` 默认关。线上 demo 开沙箱：配好沙箱 Host 的 DNS 与 Caddy，`.env` 设 `SANDBOX_HOST` 与 `FLAG_SANDBOX=on`，重启。
- 文件模式与锁定套件只有一个运行时，行为不变。回滚按 R17。

## 安全、隐私与性能

- 匿名访客能写的内容（SOP、产品文字、快捷回复、聊天）只在沙箱 Host 上渲染；那里与宿主不同源，转义疏漏最多是访客在自己沙箱里自伤，碰不到成员的 cookie。沙箱 Host 的页面另加 CSP：脚本只许同源与按 hash 或 nonce 放行的本页内联脚本（`chat.html`、`pay.html`、`proposal.html` 有内联脚本，不能直接照搬网页渠道那一套，`src/web/routes.ts:137`），不许任何外部来源。沙箱里的会话 id、订单 id 不再是凭据，一律要 cookie。
- 隐私：`/try` 与横幅写明临时、24 小时删除、不要输入真实个人信息、备份保留期；沙箱轮次不导出 OTel；日志脱敏正则加 `sbx-`。
- 性能：沙箱全量预载在内存，每个约一份配置快照加十来个会话，索引与宿主共用；连接池不变（max 5）。验收记录 20 个沙箱时的 RSS 增量与宿主的排队延迟。

## 验收标准

1. **进程内隔离（R16 的 A、B）。** 同一会话 id、订单 id、网页账号 key 在 A、B 各取到自己的对象；交错对话时，假模型记下的每个请求的 system、tools 哈希等于所属租户的值，A 的请求与回复里没有「山海」、B 的没有「云途」；只有 B 有的线路只出现在 B 的检索与报价里，改过价的线路在 A 照旧原价；A 的模拟器 SSE 与 console 事件流收不到 B 的推送，反之亦然；日志的租户字段各自正确。
2. **作用域与清单。** 两个运行时时，在作用域外调 `getSession`、`currentPack()`、`currentCatalog()` 都抛 `TenantScopeMissing`，一个时照旧。往 `src/` 任一模块顶层加一个不进清单的 `new Map()`，`pnpm lint` 失败，补上后通过。
3. **公开路由。** 两个 standard 租户各设 `public_host`，再加沙箱 Host：「公开路由」表每一行在自己的 Host 上取到自己的数据，换到另一个租户的 Host 是 404 或那个租户自己的数据；未知 Host 404；只装一个 standard 租户时未知 Host 落到它；装两个而一个缺 `public_host` 时以 `tenant_host_missing` 拒绝启动。
4. **开通。** 从 `/try` 点开始到进工作台，20 次 p95 不超过 3 秒；沙箱里 13 个种子会话、3 个订单、产品条目数等于宿主的 active 条目数，四个哈希与宿主相同；宿主的库行数与哈希不变；带 cookie 再开通返回同一个沙箱；宿主 Host 的 `/console/` 照旧是登录页。
5. **工作台全程。** 在沙箱里接手一个种子会话并回复，模拟器 1 秒内出现「【顾问】……」；交还后在模拟器发消息，AI 回复；改一条线路的价格，模拟器里新报价用新价，宿主不变；标已付，模拟器收到付款确认；改 SOP 前言并发布，沙箱 `promptHash` 变、宿主不变；模拟器开的新会话实时出现在工作台；「重置」只影响沙箱的那个会话。
6. **只进模拟器。** 企微 API、两个 webhook、OTLP 端点都换成本机记录器，跑完验收 5 再加一次转人工与一次实例级告警：企微请求 0、通知 0，告警只有实例级那条，OTLP 里没有沙箱轮次；给沙箱插 `channel_accounts` 被触发器拒；沙箱的 `jobs` 行数为 0。
7. **预算。** `SANDBOX_LLM_CALLS=3` 时第 4 轮降级成 mock、`outcome = 'budget'`，同时宿主的模拟器照常走模型；重启后已花数接着算；池上限到了之后开通回 503，推一条 `sandbox_pool` 告警。standard 租户越过 `llm_daily_alert_milli` 只告警一次、对话不降级。作战室的「当日模型成本」不含沙箱花费。
8. **限额与公平。** 活着的沙箱到上限时下一个 429；每小时、每天、每 IP 的上限各验一次；跨站 POST `/api/sandbox` 403。假模型延迟 2 秒、20 个沙箱各连发 5 轮时，沙箱在飞请求不超过 `SANDBOX_LLM_MAX_INFLIGHT`，宿主每轮的排队等待中位数比没有沙箱时多不超过 1 秒；RSS 增量记进 plan，超过 200 MiB 记进「Open」。
9. **到期删除。** 把一个沙箱的 `expires_at` 拨到过去：1 分钟内接口回 410、页面跳 `/try`，`tenancy.sandboxes` 减一；以超级用户按系统目录逐表数它的行全为 0，`tenants`、`users`、`auth_sessions` 里没有它；`tenantKeys(id)` 每项为 0；`sandbox_pool_daily` 当天的 `purged` 与花费加上了。一轮正在等模型时到期同样删干净、无未捕获异常；「结束体验」同样；删除事务中途杀进程，重启时删干净。
10. **重启与开关。** 活着的沙箱跨重启还在（cookie、会话、改过的价格）；到期的在启动时删掉、不装载；`FLAG_SANDBOX` 关掉重启，全部沙箱删掉；prod 下设 on 启动失败；开着而缺 `SANDBOX_HOST` 以 `sandbox_misconfigured` 拒绝启动。
11. **会话与安全。** 沙箱 Host 上带 `__Host-sid`、宿主 Host 上带 `__Host-sbx` 都是 401；沙箱 A 的 cookie 访问沙箱 B 的会话 id 是 404；沙箱 Host 上口令登录 404；沙箱函数对 standard 租户报错。产品标题放 `<img src=x onerror=alert(1)>`：沙箱的支付页、方案书、模拟器、工作台都当文本显示，页面响应带 CSP。
12. **demo 照常。** 04 验收 14 那一组（重置、种子保鲜、访客清理与上限、匿名只读、模拟支付、AI 标识）照旧；线上部署后 `/healthz` 四个哈希与开工相同，企微一句一回。
13. **回滚检查。** 本机真实 docker 经 `deploy.sh`：有沙箱行时部署 04 的 tag，检查 6、`deploy.sh` 1、打印关开关重启的步骤、服务器不动；关开关重启后放行；宿主以外的 standard 租户设了 `public_host` 时同样拒绝；健康检查失败后的自动回滚同样经过检查。
14. **锁定与门禁。** 每一步结束时锁定套件零修改、全绿，`PREFIX sha256` 与开工相同；四个门禁全绿；最后一步对开工提交 `git diff` 锁定文件为空。

## 开放问题

ready 之前由 owner 定；正文的 R 按推荐写，改了选项就改对应的 R。

1. **模板来源与复制范围。** A 配置取宿主当前已发布的，种子取仓库里的固定种子文件；B 全取仓库静态数据（每次开通走一遍导入与渲染）；C 全取宿主当前状态（含内存里的种子）。推荐 A：访客看到的配置就是线上 demo 此刻的样子，四个哈希与宿主相同，还共用前缀缓存与检索索引；宿主内存里的种子会被演示改动（成员回复带真实的显示名、有人点过模拟支付、被接手过），复制过去就把成员姓名与别人的操作带给了访客，所以 C 不行；B 会与线上 demo 不一致。依据：owner 要不要沙箱跟着线上 demo 的配置走。
2. **沙箱的持久化契约。** A 进 PG，副本改用非 demo 类 id，02 R6、`conversations_id_check`、不变量 11、console 排除 `sim-` 原文都不动，02 走 Amends；B 副本保留原 id，`Supersedes in part` 02 R6 与不变量 11，CHECK 换成触发器（只有沙箱租户能存 demo 类 id），`isDemoClassId` 改成看租户，`sim-` 排除改成只对 standard 租户；C 沙箱只在内存，R6 不动，但 `sim-` 排除要改，trace 等在沙箱里都是 503 `store_file_mode`，重启即丢，删除没有库里的证明。推荐 A：已实现的契约一句不改，宿主「demo 类永不进库」的保护原样留着，沙箱走多租户的真实路径，删干净能用 SQL 证明；代价是 id 改写与 `sim-` → `sbx-` 的对照。依据：评审是否接受 id 改写。
3. **沙箱在哪种 profile 下开。** A 只在 demo，新开关默认关、线上 demo 显式开，prod 封顶为关；B prod 也能开（给以后托管的试用）。推荐 A：prod 实例服务真实客户，公开的开通入口与它的模型花费没有理由出现在那里；沙箱要的模拟器、模拟支付本来就是 demo 能力。托管要试用时另写 spec。现在就能定。
4. **每租户预算的口径。** A 按轮次（今天访客预算的口径）；B 按实际请求次数；C 按金额。推荐 C 加 B 兜底、覆盖全部用途：金额最接近真实成本，次数兜住未知价格的模型，A 管不到工具循环、重试、对冲与工作台。沙箱与 standard 分开计：沙箱按个硬上限加当天池上限；standard 只有每天的软上限告警、从不降级，因为把真实客户的对话降成固定话术比多花钱更糟。依据：owner 要不要对 standard 租户设硬上限；现在没有真实的多租户托管，推荐先不设。
5. **免密会话的身份与有效期。** A 独立的 `__Host-sbx`，一个浏览器至多一个活着的沙箱，再点复用，期限以沙箱到期为上限，与成员的 `__Host-sid` 互不相读；B 复用 `__Host-sid` 加租户切换；C 凭 URL 里的令牌进入。推荐 A：B 让同一浏览器里成员登录与沙箱互相挤掉，C 的令牌会经引用头、历史、截图泄露；代价是一个浏览器同时只能体验一个。ready 之前定。
6. **「只进模拟器」的边界。** A 只禁止真实客户渠道的发送；B 管全部对外副作用（客户渠道、群通知、只关乎沙箱的告警、OTel），只有模型与 embedding 照常、靠预算管。推荐 B：访客能随手触发转人工，A 会让任何人刷运营的企微群；沙箱的告警与遥测对运维是噪音，原文导出还多一处第三方存储。ready 之前定。
7. **沙箱用独立 Host 还是与宿主同源。** A 独立 Host（多一条 DNS 与 Caddy 配置）；B 同源，沙箱挂在 `/s/<slug>/` 下，console 要支持运行时 basepath，模拟器与工作台展示时给站内链接补前缀。推荐 A：沙箱是第一个让匿名访客写内容、内容又渲染在页面里的地方，同源时任何转义疏漏都能借成员的会话调后台接口，分开之后最多是自伤；A 也让 cookie 与路由更简单（R10）。依据：owner 是否愿意加一个子域名。
8. **限额的数值。** 推荐「环境变量」表的默认值。按 04 的实测（真实模型 30 段对话约 0.44 元）估算，一个沙箱正常体验远用不到 1 元，池上限只在被刷时起作用。ready 之前先定，上线一周后按 `sandbox_pool_daily` 再调。
9. **能不能把模拟器分享给别人当客户**（电脑开工作台、手机扫码当客户）。推荐本阶段不做：要另发一种只能聊天的令牌、再防一层滥用；同一浏览器开两个标签页就能演示。有需要另写。
10. **console 的渠道账号页。** 04 的非目标写成「阶段 5」。推荐本阶段不做：线上 demo 不建网页渠道账号，沙箱没有渠道账号，第一批真实客户一家一个实例、由运维命令开通；等托管多个真实租户时一起做。owner 确认后，主参考阶段 5 一节随 ready 补一句。

## 被否决的方案

- **线上开共享的可操作 demo 账号，每天定时重置。** 人工回复会经企微真发给扫码的客户；公开账号能看到真实会话与别的访客的聊天；访客之间互相改坏 SOP 与价格（owner 2026-10-10）。
- **沙箱放进单独的容器或库。** 证明不了同部署多租户，内存与运维翻倍。
- **按订单号全局解析公开路由（`SECURITY DEFINER` 函数）。** 方案书、隐私说明、模拟器没有全局唯一的 id，线路 id 在租户之间本就重复；还会让一个租户的支付页在别人的域名下打得开。
- **每个沙箱一个子域名。** 要通配证书与通配解析；一个沙箱 Host 加会话 cookie 就够分开。
- **装载库里全部未停用的 standard 租户。** 留着的测试与演练租户会被意外服务，未知 Host 也就没法安全回落。
- **继续用一个全局 `bindPack`，每轮按租户切换。** 一轮里有多次 `await`，并发的两轮会切走对方的绑定。
- **只靠测试清沙箱的状态。** 漏掉没写到的分支；要靠每个模块级状态都分了类（清单与 lint）。
- **加验证码。** 依赖第三方、还要处理个人信息；全局上限与池上限已封住最坏的花费。
- **删除时留墓碑行。** 与「整个租户删掉」不符；统计进不带租户的 `sandbox_pool_daily`。
