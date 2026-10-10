# 05 · 同部署多租户 + 一键体验沙箱

Status: draft
Phase: 5 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」（2026-10-10 拆分之后的编号）
Depends on: [04 · 行业包抽取](../04-industry-packs/spec.md)（开工时须已 implemented）；[03](../03-channels-v2/spec.md) 的按账号运行时与 R20 留的缝；[02](../02-conversations-workbench/spec.md) 的 PG 会话存储、写队列、spill、清除函数、任务表、console 事件流；[01](../01-pg-config-console/spec.md) 的 `withTenant`、三个角色、RLS 模板、认证函数、租户锁。选型见 [ADR-001](../../adr/adr-001-postgres-drizzle.md)（隔离两层都做、公开路由按域名或 `SECURITY DEFINER` 函数解析、内存键带租户）、[ADR-002](../../adr/adr-002-console-vite-react.md)（一个镜像）
Supersedes in part: [01](../01-pg-config-console/spec.md) 不变量 3「DB 模式下进程只装载 `DEFAULT_TENANT_SLUG` 这一个租户，每个进程内配置缓存都带着它的 id，并持有它的 advisory lock」——改为按进程角色装载（宿主进程：宿主与设了 `public_host` 的 standard 租户；沙箱进程：未到期的沙箱），租户状态带所属租户的 id，进程持有它装载的每个租户的锁（R1、R2）；01 R9 末句「一个容器一个租户期间，进程只装载 `DEFAULT_TENANT_SLUG` 这一个租户，公开路由都用它」——改为 R4；01 不变量 23「认证只能经五个 SECURITY DEFINER 函数」——加上 R7 的四个沙箱函数；01 不变量 24「`agent_app` 与 `agent_platform` 都不能 DELETE `sop_versions`、`catalog_items`、`audit_log`」——表级授权不变，唯一例外是 `sandbox_tenant_purge` 删除到期沙箱的这些行；[02](../02-conversations-workbench/spec.md) 不变量 6「保留期内的会话、消息、trace，`agent_app` 删不掉」——例外限于 `kind='sandbox'`、已到期（含主动结束与闲置回收）的整租户删除；02 不变量 13「正常停机之后，没落库的改动要么已提交，要么在 spill 文件里」——沙箱进程不写 spill，停机时没落库的改动丢弃、只记条数（R6）。原因：同一进程要能服务多个租户，公开路由与登录不能再落到环境变量定的租户上；沙箱由公开请求开通、24 小时后整体删除，`agent_app` 要经收窄的函数建、删沙箱，而 app 进程照旧不能持有平台凭据（01 R19）；沙箱的数据本来就要整体删掉，为它保留 spill 只会多一处要清理的文件。
Amends: 00「部署 profile 与开关」：`APP_ROLE=sandbox` 只在 demo profile 下能起（R16）；01「数据库」：`tenants` 的五列、表 `sandbox_pool_daily`、四个沙箱函数与授权、`channel_accounts` 的 INSERT 触发器，命令 `tenant-host`、`tenant-budget`、`sandbox`，审计动作（R7、R13、R15）；02 R6：新增一类「沙箱会话」，进 PG、随租户整体删除，**不是 demo 类**（R8）；02 R22 的公开路由加沙箱进程的一组（R4、R10）；后台 UX spec 的 `Me` 加 `sandbox`（R10）；03 R20 留下的「公开路由怎么解析租户」定为按 Host、key 仍只在租户内唯一（R4）；03 R22 的脱敏正则认 `sbx-`；04 R2 的 `bindPack` 绑定挂到租户运行时上（R3）；04 R14 的回滚检查加 `pre-05`（R18）；`deploy/compose.yml`、`deploy.sh`、`deploy/watch.sh` 认第二个服务 `sandbox`（R1、R13）。ADR-002 决策 3「始终是一个进程、一个端口、一个镜像」的原意是不另起前端服务；沙箱进程是同一镜像、同一代码的第二个角色，ready 时在 ADR-002 补一行注。
Revisions: 2026-10-11 起草期评审（一路 Opus、一路 Codex）之后就地修订，尚无代码依赖。一、沙箱改到单独的进程（同一镜像，`APP_ROLE=sandbox`，compose 服务 `sandbox`），宿主进程线上仍只有一个运行时；原稿是同一进程装载宿主与沙箱（见开放问题 11）。二、删掉「注册表里只有一个运行时就隐式回落」这条通用规则：严格与否在启动时按角色与配置定，入口清单补停机钩子、`exit`、模块加载期、事件监听与 `AsyncLocalStorage.snapshot()`，后台入口缺作用域时只记日志与告警，状态清单 lint 改为默认拒绝。三、沙箱会话一律 `channel: 'simulator'`、id 一律 `sbx-`（原稿种子副本留着 `wecom:` 前缀与 `channel: 'wecom'`）；逐条列出渠道路径，任务在 `queueJobs` 丢弃，不靠 `jobs` 表触发器。四、预算改为每次请求尝试之前原子预占沙箱与全池的额度，在尝试层计次，沙箱禁用对冲（原稿是操作开始前判一次、按成功响应记账，池上限只在开通时判）。五、删除加取消屏障、最后刷用量、purge 的锁与语句超时；加闲置回收、`sandbox` 命令与 `sandbox_purge` 告警。六、免密会话改为开通事务里签发、受限的解析函数，空闲期限等于剩余寿命；「一个浏览器至多一个沙箱」收窄为「有效 cookie 期间复用」；沙箱的所有写请求查同源。七、模板的品牌、SOP、产品库取自同一份宿主已发布快照（原稿由函数复制待生效的 `tenants.brand`），开通读宿主用只读事务、不取宿主的锁。八、沙箱进程不挂 `var/`、不写 spill。九、文件头补 01 不变量 24、02 不变量 6 与 13 的部分取代。十、回滚检查的退出码改 7（6 已被 04 占用），有沙箱行时由检查脚本跑 `sandbox purge --all` 后放行。十一、补匿名 owner 的写入上限、Host 规范化与反向代理约束；改正公开路由表里 `/api/sessions/:id` 的矛盾、`channel_accounts_guard` 只挂在 UPDATE 上的误写、独立 Host 的理由。

## 背景与问题

04 之后同一套引擎只改配置就能换品牌、换行业，但一个进程仍只服务一个租户。目前没有具体客户，第一批真实客户仍「一家一个实例」，本阶段的价值主要是让访客亲手体验工作台（一键体验沙箱），以及以后的托管。开工前的只读盘点（按 `e5affab`，协调者另存，不进仓库）查到：

- **一个进程一个租户写在很多地方。** 启动按 `DEFAULT_TENANT_SLUG` 解析租户、取锁、装一份配置（`src/config/source.ts:332`、`:620`）；会话存储与渠道从同一个 `configRuntime()` 取 `tenantId`（`src/server.ts:1038`、`:1044`）；登录与 cookie 固定查它（`src/auth/session.ts:137`、`:206`）；产品库写入与运行数字明确拒绝别的租户（`src/config/catalog.ts:109`、`src/ops/metrics.ts:55`）。
- **公开路由没有租户维度。** 订单、支付页、方案书、隐私说明、模拟器直接查全局 identity map 与当前绑定（`src/server.ts:613`、`:696`、`:757`、`:919`、`:410`）；网页入口与企微回调按 key 在当前租户的账号里找（`src/channels/accounts.ts:221`）。库里不同租户可以有相同的会话 id、订单 id 与账号 key。
- **进程内状态多是按裸 id 的模块级单例。** 行业包绑定一个模块变量（`src/core/pack-api.ts:600`），配置一个 `loaded`（`src/config/source.ts:209`），会话与订单各一个全局 Map（`src/store.ts:113`），接管代次、发送账本、洞察缓存、console 事件环、SSE 订阅只按会话 id 建键。`src/` 里模块顶层的集合 91 个、模块级 `let` 115 个，另有模块级数组、当字典用的对象、事件发射器与加载时调一次的工厂闭包；评测的清理清单（`eval/v2/isolation.ts:11`）只登记了一部分。RLS 管不到它们（ADR-001 决策 4）。还有几处会悄悄继承作用域：`AsyncLocalStorage.snapshot()` 恢复的是模块加载时的上下文（`src/store/pg-backend.ts:64`、`src/store.ts:297`），模块级的去抖定时器会继承第一个触发者的上下文（`src/store.ts:146`）。
- **用量有租户、预算没有。** `usage_daily` 主键带租户（`src/db/schema.ts:466`），内存累加器却只按（日、模型、用途）建键，由绑在当前 PG 后端上的一个 writer 每 30 秒写一次（`src/trace/usage-daily.ts:41`、`:118`）。用量只按成功采用的响应记，重试与对冲的输家不记（`src/llm-gate.ts:95`、`src/core/llm/client.ts:317`）。访客预算是一个 `budget.json`，只在模拟器渠道的主对话占一个轮次名额（`src/budget.ts:9`、`src/core/engine/index.ts:610`）。
- **没有开通与删除整个租户的路径。** 开通是几条平台命令的组合，身份各不相同（`src/cli/tenant-create.ts:18`、`src/cli/import-config.ts:11`）；`erase-conversation` 只删一个会话、留下订单与审计；租户外键没有级联，`agent_app` 对 `tenants` 只有 SELECT（`drizzle/0001_rls_auth.sql:284`）；登录会话的创建函数固定写 7 天期限（`:190`）。
- **demo 的「免密」只是只读**（`src/console-api/app.ts:251`）。直接开一个可写的公开账号，人工回复会经企微真发给扫码的客户，访客之间互相看到聊天、改坏 SOP 与价格（owner 2026-10-10 否决）。
- **很多分支按「企微渠道」判断。** 发送按会话的 `channel` 选适配器（`src/server.ts:103`），人工回复的窗口与额度、工作台的送达状态与发送窗口只对 `wecom` 会话算（`src/handoff/takeover.ts:354`、`src/console-api/workbench.ts:251`）；转人工与订单通知任务、未保存转人工的群通知走另外的路（`src/handoff/record.ts:109`、`src/notify/handoff.ts:154`）；企微适配器内部还有自动回复、兜底、欢迎语、恢复的发送（`src/adapters/wecom.ts:1407`、`:1788`）。

本文的词：**宿主租户**是 `DEFAULT_TENANT_SLUG` 指的那个（线上 demo 就是它）；**standard 租户**是普通租户（含宿主）；**沙箱**是 `kind='sandbox'` 的临时租户；**宿主进程**是现在的 `app` 服务，**沙箱进程**是新的 `sandbox` 服务；**沙箱 Host** 是沙箱进程服务的主机名。

## 目标

1. **同部署多租户。** 一个进程能安全地服务多个租户：线上是沙箱进程里同时活着的多个沙箱；测试里同一进程装两个 standard 租户交错对话。配置、品牌、绑定、产品库、索引、会话与订单、缓存、事件与订阅互不可见。宿主进程线上仍只有宿主一个运行时。
2. **公开路由按租户解析。** 一个进程装了多个 standard 租户时按 Host 解析，缺 `public_host` 拒绝启动、未知 Host 404；只装了一个 standard 租户时任何 Host 都是它（「单 standard 实例的兼容」，即今天「一家一个实例」的部署形态）；沙箱只在沙箱 Host 上、按会话 cookie 解析。
3. **沙箱从模板开通、整租户删除。** 开通一个事务；删除能证明删干净（库里 0 行、进程里 0 个键）。standard 租户的模板开通与整租户删除不在本阶段。
4. **模型用量与花费按租户记账**：沙箱与全池在每次请求之前预占硬额度；standard 租户只有软上限告警。
5. **一键体验沙箱。** 引导页点「体验工作台」→ 从模板开通临时租户（配置、种子会话、订单、产品库都是副本）→ 免密进工作台随便操作（接管、回复、改价、标已付、改 SOP）→ 模拟器连着同一份副本，工作台回复实时出现 → 发送只进模拟器 → 24 小时后（或闲置、主动结束时）整个租户删掉。
6. **跨租户泄漏测试覆盖进程内状态**；两个租户交错对话时各自命中自己的前缀；运行时个数从 0 到多再回到 0 的全过程不串台。
7. **宿主不受影响。** 宿主进程的四个哈希、demo 行为、作战室口径、`/healthz` 照旧；`docker compose stop sandbox` 不碰宿主。

## 非目标

- 第二个真实行业包与类型泛化（阶段 7）；看板拆分与撤掉作战室 `admin.html`（以后；本阶段作战室只属宿主）。
- standard 租户的模板开通、整租户删除、托管运营设施；付费、计费、试用转正式、自助注册：另记（ADR-003 归私有运营层）。
- 线上开共享的可操作 demo 账号加定时重置：否决，见「被否决的方案」。
- 线上 demo 建网页渠道账号（owner 2026-10-11 定不建）；线上让宿主进程装第二个 standard 租户（只在测试与本机演练里验）。
- console 的渠道账号页（04 非目标写的「阶段 5」，见开放问题 10）、成员管理页、在 console 里切换租户。
- prod 开沙箱；沙箱里的正式渠道、跟进、群通知；沙箱会话的「企微观感」展示；把沙箱模拟器分享给别人当客户（开放问题 9）。
- 多副本、LISTEN/NOTIFY、按租户的公平排队（沙箱进程有自己的模型并发闸）。

## 前置条件

- 04 `Status: implemented`，线上 demo 跑 04 之后的版本。
- 锁定套件（8 个文件）照旧锁定；开工核对记下它们的 sha256、`PREFIX sha256` 与线上 `/healthz` 的四个哈希。
- 开工核对把四张清单落进 plan：模块级状态（每项按 R5 归类）；入口（R3 列的每一类各在哪里建立作用域）；渠道与出站路径（「渠道与出站路径」表逐行对上代码，标明在 `simulator` 渠道下自然不走还是要显式挡）；console 的内部投影（如 `/status` 的 `channels`、`tenantSlug`，`src/console-api/app.ts:437`）。另实测一个空闲沙箱进程的常驻内存（预计 150–250 MiB）记进 plan。
- 线上开沙箱之前：沙箱 Host 的 DNS 与证书已配好（域名不进仓库）；反向代理的两个站点块都原样转发 Host、不写 `header_up Host`；宿主机上沙箱进程的端口只绑 127.0.0.1。

## 开工前裁决

| #   | 主题                            | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 两个进程角色                    | 按开放问题 11 的推荐，对照见「两个进程」表。compose 加服务 `sandbox`：同一个镜像，`APP_ROLE=sandbox`，env 文件 `../.env.sandbox`，宿主端口另取（如 3211），放在 compose profile `sandbox` 里（不开这个 profile 就不起），反向代理的沙箱站点指向它；同一个 PG、同一套迁移、RLS 与 `TenantRuntime` 代码。**宿主进程**（`app`，`APP_ROLE` 缺省为 `host`）线上只有宿主一个运行时，不装沙箱、没有 reaper、没有 `/api/sandbox`，引导页的「体验」链接跳到沙箱 Host。**沙箱进程**只服务沙箱 Host、只装沙箱，固定严格模式（R3），环境里没有企微凭据、`NOTIFY_WEBHOOK_URL`、OTLP 端点与对冲模型（有就拒绝启动，R16），不挂 `var/`、不写 spill，模型并发闸按进程设（`LLM_MAX_INFLIGHT=2`）。紧急开关：`docker compose stop sandbox` 或从反向代理摘掉沙箱站点，宿主不受影响、不用重启。代价：多一个 Node 进程与一组数据库连接；`deploy.sh`、compose、`watch.sh` 认第二个服务；语义索引不跨进程共用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R2  | 每个进程装载哪些租户、宿主、锁  | **宿主进程**：DB 模式照旧要求 `DEFAULT_TENANT_SLUG`，含义收窄为宿主——`var/` 下的文件状态（demo 类 JSON、`budget.json`、`usage.json`、env 企微账号与 cursor、`kf-qr.png`、检索缓存）、旧接口与作战室、`sim-` 访客、种子保鲜与访客清理都只属于它。另装设了 `public_host` 的其他 standard 租户（线上不用）；装了两个及以上 standard 租户时每一个（含宿主）都要有 `public_host`，否则以 `tenant_host_missing` 拒绝启动；没设 `public_host` 的其他 standard 租户不装载、记一行。**沙箱进程**：要求 `SANDBOX_TEMPLATE_SLUG`（未停用的 standard 租户，就是宿主），启动时先删到期的沙箱（R12），再装载未到期的；不装任何 standard 租户。每个进程一条专用锁连接，持有它装载的每个租户的 advisory lock；沙箱开通后取、删除后放。standard 租户装载失败照 01 R1 拒绝启动；沙箱装载失败就改成到期、跳过。文件模式只有一个运行时，就是宿主                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R3  | 作用域与严格模式                | 每个装载的租户一个 `TenantRuntime`（R5 的租户状态挂在上面或键以 `tenantId` 开头），`AsyncLocalStorage` 携带当前运行时。严格与否在启动时定：沙箱进程永远严格；宿主进程装了多个 standard 租户、或设了 `TENANCY_STRICT=1` 时严格；否则（宿主进程只有一个 standard 运行时）`currentRuntime()` 在作用域外回落到它——这是「单 standard 实例的兼容」，不是通用规则。严格模式下作用域外访问租户状态抛 `TenantScopeMissing`：HTTP 回 500；后台入口（定时器、轮询、任务、reaper、停机钩子）只记日志并推实例级告警 `tenant_scope_missing`，进程不退出。入口与建立作用域的位置：HTTP 中间件（R4 之后）；渠道运行时的回调与轮询（`account.tenantId`）；任务认领（逐个租户）；每个租户的定时器（显式 `withTenantScope(rt, …)`）；store 的提交回调；停机钩子（`src/store.ts:223`、`src/adapters/wecom.ts:2783`）与 `process.on('exit')`（`src/store.ts:577`、`src/adapters/wecom.ts:2788`）逐个租户进作用域；模块加载期的代码（`src/store.ts:680`）改到每个运行时装载时调；事件发射器的监听在发出方的作用域里同步执行（`storeEvents`、领域事件、console 事件环），发出方必须在正确的租户作用域里发；`AsyncLocalStorage.snapshot()` 恢复的是模块加载时的上下文（`src/store/pg-backend.ts:64`、`src/store.ts:297`），在里面要重新建立租户作用域。规则：实例级的定时器与监听在空作用域里挂（`als.exit()`），防止模块级定时器经 `AsyncLocalStorage` 继承第一个触发者的租户而静默串台（如 `src/store.ts:146` 的去抖）。`bindPack(runtime, brand)` 写进当前运行时，`currentPack()` 读作用域；04 的门面不加租户参数（锁定套件跑文件模式，只有一个运行时）。02–04 在 DB 模式下的非锁定自测在 CI 里另以 `TENANCY_STRICT=1` 再跑一遍 |
| R4  | 公开路由按 Host 解析            | **宿主进程**：只装了一个 standard 租户时任何 Host 都是它（单 standard 实例的兼容；装哪个租户由 `DEFAULT_TENANT_SLUG` 定，是部署形态，不是公开路由的回落）；装了多个时 Host 等于某个租户的 `public_host` → 它，否则租户路由 404。**沙箱进程**：只认 `SANDBOX_HOST`，租户由会话 cookie 决定（R10），别的 Host 只有 `/healthz`、其余 404。Host 规范化：取请求头、去端口（含 `[…]` 形式的 IPv6 字面量）、去末尾的点、转小写，不读 `X-Forwarded-Host`。解析出租户之后只在它里面按订单 id、线路 id、账号 key 找；key、企微前缀、`open_kfid` 仍只在租户内唯一（03 R20 留的「key 全局唯一还是路由里带租户」定为后者，Host 就是路由里的租户）。逐条见「公开路由」表。消息里的相对链接不变；绝对链接按租户拼：宿主照旧 `PUBLIC_BASE_URL`（宿主设了 `public_host` 时两者主机名必须相同，否则拒绝启动），其他 standard 租户 `https://<public_host>`。客户端地址照旧经 `clientKey()` 按可信代理跳数取 XFF（`src/http-guards.ts:45`），线上的实际跳数在验收里核对                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R5  | 进程内状态与清单                | 逐项见「进程内状态」表，分三类：**租户状态**挂在运行时上或键以 `tenantId` 开头，并向登记表登记 `keyCount`、`drop`、`reset`；**实例级**（IP 限流桶、模型并发闸、按模型的探测与统计、profile、告警总量限流）保持全局，各写一句理由；**按对象键**（以会话对象为键的弱引用表、每轮局部的 Map、每轮的 `AsyncLocalStorage`）不动。新检查 `scripts/check-tenant-state.ts` 进 `pnpm lint`，**默认拒绝**：`src/**`（自测除外）的模块级绑定，除函数、类、import、原始类型常量、`as const` 或 `Object.freeze` 的字面量之外，都要在 `src/tenancy/state-manifest.ts` 里标了类，标成租户状态的要有同名登记项。这样模块级数组（如 `src/llm-gate.ts:21`）、当字典用的对象、事件发射器、有状态的类实例、加载时调一次的工厂闭包（如 `src/store.ts:121` 的文件后端）都逃不掉。这道检查只证明登记覆盖；访问、回调与销毁对不对，靠严格模式与 R17 的交错测试。`eval/v2/isolation.ts` 改为调登记表的 `reset()`，私有补丁只留给实例级状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R6  | 事件、渠道、任务、spill         | 领域事件带 `tenantId`；每个运行时一个 console 事件环、序号、listener 与计数去抖（今天一份，`src/console-api/events.ts:23`、`:48`）；`storeEvents` 的 `change` 按运行时分开（`src/store.ts:146`）；模拟器与网页的 SSE 订阅按（租户，会话）建键。渠道注册表只在宿主进程，装它装载的 standard 租户的账号，`accountByKey` 加租户参数，`pushRoute` 只在会话所属租户的账号里匹配前缀。任务 runner 只在宿主进程，每拍逐个 standard 租户认领。spill 只在宿主进程：回放时每个租户只认自己的（今天遇到别的租户的就以 `spill_conflict` 拒绝启动，`src/store/pg-backend.ts:904`）。沙箱进程不写 spill（02 不变量 13 的例外）：停机排空写队列，到 `stop_grace_period`（10 秒）还没落库的改动丢弃，记一行条数——沙箱的数据本来就是一次性的。沙箱的隐私说明只经本进程改，不轮询                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R7  | 租户种类、新列与沙箱函数        | `tenants` 加 `kind`、`expires_at`、`template_tenant_id`、`public_host`、`llm_daily_alert_milli`（DDL 见「数据库」）。`agent_app` 照旧不能写 `tenants`；沙箱只经四个 `SECURITY DEFINER` 函数（属主 `agent_owner`、`search_path` 钉死、表名全限定、只 GRANT EXECUTE 给 `agent_app`）：`sandbox_tenant_create`（租户、合成用户、owner 成员关系、登录会话、池计数，一并）、`sandbox_session_resolve`（cookie 解析）、`sandbox_tenant_expire`、`sandbox_tenant_purge`；对 standard 租户一律报错，时刻一律取库内 `now()`，不收调用方传的时间。`sandbox_tenant_expire` 能提前结束任何沙箱是有意的（「结束体验」、闲置回收与运维命令都用它）。`channel_accounts` 另建一个 `BEFORE INSERT` 触发器拒绝沙箱租户（现有的 `channel_accounts_guard` 只挂在 UPDATE 上，`drizzle/0005_channels_rls.sql:45`）。`public_host` 与软上限由平台命令 `tenant-host set/clear`、`tenant-budget set/clear` 改（列级 UPDATE，写审计，下次启动生效）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R8  | 沙箱的数据契约                  | 按开放问题 2 的推荐。沙箱的会话、消息、订单、trace、同意记录与 standard 租户一样进 PG（沙箱进程要求 `SESSION_STORE=db`），随租户整体删除。沙箱里的会话一律 `channel: 'simulator'`，id 一律 `sbx-` 加 24–64 位小写十六进制（与 `public/chat.html:387` 的 `sim-` 形状去掉前缀后相同）：种子副本按新生成的随机 id，模拟器新会话由页面的 `sim-<x>` 对照成 `sbx-<x>`。没有 `wecom:` 前缀，所以按「企微渠道」判断的分支在沙箱里大多自然不走；剩下的在 R11 显式挡。沙箱会话不是 demo 类：02 R6、`conversations_id_check`、02 不变量 11、console 排除 `sim-` 原文都不动（Amends 写清这一点），宿主的种子与访客照旧只在 JSON。「企微观感」以后要做就在视图层加展示字段，不改 `Session.channel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R9  | 从模板开通                      | 按开放问题 1 的推荐，复制范围与步骤见「开通与删除」。模板是宿主**已发布**的状态：沙箱进程在一个只读、可重复读的事务里读宿主的当前发布 SOP 版本（节、渲染输入与其中的品牌快照）、active 产品条目、未归档的快捷回复、当前隐私说明，不取宿主的租户锁；品牌、SOP、产品库取自这同一份快照，函数不许换成宿主 `tenants.brand` 的待生效值（宿主 `tenant-brand set` 之后、重启之前开通，沙箱的哈希仍等于宿主已发布的）。写入在**一个事务**里，身份 `agent_app`：先调 `sandbox_tenant_create`，再由 `withNewSandboxTenant`（`src/db/client.ts`）把事务的 `app.tenant_id` 设成新租户，复用 `src/config/transfer.ts` 与 `src/cli/session-transfer.ts` 的写入，SOP 按沙箱自己的输入渲染一次。提交后按启动装载的同一条路径装载（读库预载）。开通在进程内串行，R14 的上限在锁里判。点开始到进工作台 p95 不超过 3 秒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R10 | 沙箱 Host、免密会话与跨源写保护 | 按开放问题 5、7 的推荐。沙箱进程上的租户由 cookie `__Host-sbx` 决定（32 字节随机，库里存 sha256，HttpOnly、Secure、SameSite=Lax、Path=/，Max-Age 到沙箱到期）。cookie 在租户作用域建立之前解析，所以走受限的 `sandbox_session_resolve(token_hash)`：只在 `kind='sandbox'`、未到期、成员关系在、用户未停用时返回租户、用户、角色与到期时刻，并刷新最近访问时间；会话行由开通事务里的 `sandbox_tenant_create` 写入，`expires_at` 等于沙箱到期，空闲期限等于剩余寿命（不套 01 的 12 小时）。同一套 console、模拟器、支付页、方案书、隐私说明按这个租户服务；没有有效 cookie 时只有 `/try`、`POST /api/sandbox`、静态资源与 `/healthz`，其余页面跳 `/try`、接口回 401 `sandbox_required`。角色 owner、显示名「体验访客」；没有口令登录，不读 `__Host-sid`；宿主进程不读 `__Host-sbx`。「有效 cookie 期间复用」：带着有效 cookie 再开通返回同一个；没有 cookie 的两个标签页同时首开会开出两个（各占名额）。**写保护**：沙箱的所有非安全方法（聊天、模拟支付、结束体验、开通、console 的写）一律过 `isCrossSite`（`src/http-guards.ts:13`）；console 照旧要 `x-csrf`，由 `__Host-sbx` 的 token 派生。沙箱 Host 若与主站同属一个注册域（同站），`SameSite=Lax` 挡不住兄弟源带 cookie 的请求，防线是 `isCrossSite` 把 `same-site` 也当跨站拒绝，这一条不许放宽                                                                                                                                                                                                                                                                                                                                                     |
| R11 | 只进模拟器                      | 按开放问题 6 的推荐，逐条见「渠道与出站路径」表。结构上：沙箱进程不起渠道注册表与企微运行时、不起任务 runner，环境里没有凭据、群通知与 OTLP 地址（R16），发不出去。代码里仍在汇点按租户种类再兜一层，防止以后有人给沙箱进程配了凭据：`adapterFor` 对沙箱租户一律返回它的模拟器适配器，企微的 `pushRoute` 与 `push` 拒绝沙箱租户的会话（DB 与 env 两条分支都拒）；沙箱 `TenantStore.queueJobs` 丢弃任务操作（不用 `jobs` 表触发器挡：那会让会话落库失败、被标 poisoned）；`noteUnsaved` / `onHandoffUnsaved` 按会话所属租户跳过沙箱（`src/notify/handoff.ts:154`、`:178`）。转人工只出现在沙箱自己工作台的铃铛里。只关乎某个沙箱的告警只记日志，实例级的照发。模型与 embedding 照常，计预算（R15）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R12 | 到期删除                        | 沙箱进程的 reaper 每分钟查 `kind='sandbox' AND expires_at <= now()`，逐个：① 运行时改 `closing`，新请求回 410 `sandbox_expired`（页面跳 `/try`），关掉它的 SSE；② 触发运行时的取消信号：在途登记表覆盖全部用途的模型与 embedding 请求、配置写事务与会话写队列，等它们结束至多 30 秒，到时间的 abort；关闭之后迟到的结果一律不许改状态（如草稿返回后写缓存，`src/core/insight.ts:149`），由在途登记在落地前核对运行时状态；③ 关存储后端（`src/store/pg-backend.ts:1970`），最后刷一次它的用量；刷不进去就停在这一步（运行时保持 `closed`、内存里的用量留着），下一分钟从这一步重来；④ 一个事务（`lock_timeout` 5 秒、`statement_timeout` 30 秒）调 `sandbox_tenant_purge`：先把它的 `usage_daily` 按天并进 `sandbox_pool_daily`，再按外键顺序删掉每张带 `tenant_id` 的表里它的行、登录会话、成员关系、合成用户与租户行，删完逐表复数、有剩就报错回滚，返回每表删除数；⑤ ③ 成功之后，不论 ④ 成败：摘下运行时、登记表逐项 `drop`、放锁；④ 失败下一分钟只重试 ④（它不会再被装载）。删除清单是函数里的静态表名，一条自测按系统目录核对它覆盖每一张带 `tenant_id` 的表。日志一行：短码、寿命、轮次、花费、每表删除数。到期有三个来源：24 小时寿命、「结束体验」、闲置回收（`SANDBOX_IDLE_MINUTES` 内没有带它 cookie 的请求，就调 `sandbox_tenant_expire`）。备份里的副本随保留期（本地 7 天、异地 30 天，`deploy/backup.sh:21`）滚掉，`/try` 页写明                                                                                                                                                                                                                                                              |
| R13 | 运维手段                        | 命令 `sandbox list`、`sandbox end <slug>` / `--all`（只调 `sandbox_tenant_expire`，删除由运行中的 reaper 做）、`sandbox purge --all`（到期并直接删，要求沙箱进程已停，取每个沙箱的租户锁，拿不到以 3 退出），身份 `agent_app`（同 03 R23 的渠道命令）。告警 `sandbox_purge`：有沙箱过期超过 1 小时仍没删掉，或 purge 连续失败 5 次。`watch.sh` 在配了沙箱服务时另拨沙箱进程的 `/healthz`，拨不通或 `purgeOverdue > 0` 都告警。沙箱 Host 的证书续期纳入外部拨测。沙箱服务长期停用时，跑一次 `sandbox purge --all`，否则过期的行没人删（停着的时候 `watch.sh` 会持续提醒）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R14 | 限额与写入上限                  | 数值见开放问题 8。**开通**在锁里判：同时活着的沙箱数、全局每小时与每天的开通数、每 IP 每天的开通数（IPv4 按地址、IPv6 按 /64 计；`clientKey`，尽力而为，兜底靠全局上限）、全池额度（R15）；每天的开通数读 `sandbox_pool_daily.provisioned`，每小时与每 IP 的计数在进程内存里（崩溃重启后归零，写进不变量的例外）。超了回 429 `sandbox_limited`（带 `retryAfter`）或 503 `sandbox_unavailable`。**每个沙箱**：模型额度（R15）；新会话数；模拟器 SSE 至多 10 条；写入：每分钟写请求数、产品条目总数、每个条目的版本数、单次 CSV 导入行数、每天的 SOP 发布数、快捷回复数各有上限，超了回 429 `sandbox_write_limited`；模型额度用完降级成 mock 之后写额度照计。聊天照旧按 IP 限流。开通只收同源、`application/json` 的 POST，不加验证码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R15 | 预算与计费                      | 按开放问题 4 的推荐。**记账**：每次请求的用量带作用域里的 `tenantId`；`usage_daily` 累加器按（租户、日、模型、用途）建键，每租户一个 writer；宿主进程的 `usage.json`、`/api/usage` 与访客预算 `budget.json` 只管宿主（作战室口径不变）。**沙箱：原子预占。** 预占发生在请求尝试层（`src/llm-gate.ts:95` 的每一次 fetch，含重试与失败）：拿到并发闸的名额之后、发出之前，同步地同时预占本沙箱与全池的 1 次与一笔金额（预占值 = 这次请求输入长度折算的 token 上限加 `max_tokens`，按价格表算；未知价格的模型按表里最贵的价）；任一不够就不发。返回后按实际用量结算，拿不到用量的尝试（失败、超时）按预占值记。沙箱进程不设对冲模型（R16），所以没有拿不到用量的对冲输家。超了：对话这一轮降级成 mock（`turn_traces.outcome = 'budget'`，与访客预算同一条降级路径），洞察、建议、草稿回 429 `llm_budget_exhausted`，索引不重建（旧索引照旧服务）。全池用完之后，已有的沙箱也一样停调，不只拦开通。每次尝试（含按预占值记的）都进 `usage_daily`，每 30 秒落库；重启时每个沙箱的已花数从它的 `usage_daily` 读回，池的当天数 = `sandbox_pool_daily` 当天那行 + 活着的沙箱当天的花费；崩溃最多少记 30 秒（写进不变量的例外）。沙箱进程第一次建检索索引的 embedding 记在池上、不记在某个沙箱。**standard 租户**：只有软上限 `llm_daily_alert_milli`，当天越过时告警一次，不降级、不拒绝任何调用                                                                                                                                                                                                                                                                                                                    |
| R16 | 启动检查与开关                  | 按开放问题 3 的推荐。`APP_ROLE` 取 `host`（缺省）或 `sandbox`。`APP_ROLE=sandbox` 要求 `DEPLOY_PROFILE=demo`、`CONFIG_SOURCE=db`、`SESSION_STORE=db`、`SANDBOX_HOST`、`SANDBOX_TEMPLATE_SLUG`；环境里出现任何企微凭据或渠道密钥环（`WECOM_*`、`CHANNEL_SECRETS_KEY`）、`NOTIFY_WEBHOOK_URL`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`LLM_HEDGE_MODEL` 就以 `sandbox_env_forbidden` 拒绝启动。沙箱进程在代码里强制关掉 `anon_readonly_admin`、`seed_freshen`、`legacy_admin_writes`、`web_channel`（不看 env），`reset_command`、`mock_pay` 随 demo profile 开着，`ai_disclosure` 照旧 always。00 的基线开关日志行不变（锁定的 `server.selftest.ts` 逐字比较），角色与生效值另打一行。宿主进程不需要新开关：`SANDBOX_HOST` 只用于引导页跳转                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R17 | 隔离测试                        | 新套件 `src/tenancy/isolation.selftest.ts`：进程内部分跑 PGlite；RLS、沙箱函数、删除与清单覆盖跑真实 PG（`PG_TEST_URL`，CI 必跑）。**两个 standard 租户同进程**（只在测试里起）：A 是旧版模式的宿主；B 是「山海旅行」品牌，多一条只有它有的线路、改过一条共有线路的价格，并与 A 有**同一个**会话 id、订单 id 与网页账号 key；本机假模型 HTTP 服务（04 R10 同一种）记下每个请求的 system 与 tools 字节，B 的响应故意晚到，让两边的轮次交错。**沙箱进程**：从 0 个运行时开通到 2 个、交错对话、删到 1 个、再删到 0 个，全程严格模式；覆盖提交失败通知、写队列重试、SSE 复核、索引重试与停机钩子这些后台入口。另在 CI 里以 `TENANCY_STRICT=1` 把 02–04 在 DB 模式下的非锁定自测再跑一遍                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R18 | 回滚                            | 04 及更早的镜像不认 `APP_ROLE`：`sandbox` 服务用旧镜像起来就是第二个宿主进程，沙箱 Host 会拿到宿主的页面；别的 standard 租户的 Host 会拿到宿主的数据（同 id 的订单就是串台）；沙箱也不再到期删除。`deploy.sh` 的目标判定加 `pre-05`（目标 tag 里没有 `src/tenancy/runtime.ts`），部署旧 tag 与健康检查失败后的自动回滚都经 `rollback-guard.sh`。风险与处置：宿主以外有 standard 租户设了 `public_host` → 拒绝，打印「`tenant-host clear` 那些租户、摘掉它们的域名」；`sandbox` 服务在跑 → 拒绝，打印「停掉 `sandbox` 服务、从 compose profile 与反向代理摘掉沙箱站点」；库里有沙箱行 → 检查脚本用当前镜像跑一次 `sandbox purge --all`，之后再问库，没有沙箱行才放行（以库为准，不看运行时计数）；库问不到时，正在跑的是 05 之后的镜像就按有风险处理。拒绝以 7 退出（6 已被 04 的品牌风险占用；两者都有时先报 6），`deploy.sh` 照约定转成 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R19 | 可观测                          | 宿主进程的 `/healthz` 原样（装了多个 standard 租户时，`ok` 另并入其余租户的同类条件）。沙箱进程的 `/healthz`：`{ ok, revision, role: 'sandbox', sandboxes, purgeOverdue, scopeMissing, pool: { day, provisioned, costMilli, capMilli }, llmGate, store: { lagMs, poisoned } }`，只有个数与金额；库不可达、`purgeOverdue > 0` 时 `ok` 为 false。日志的租户取作用域（今天是模块变量，`src/log.ts:40`）。新告警键：`sandbox_pool`（池额度用完或开通被全局上限拒绝，每天至多一次）、`sandbox_purge`（R13）、`tenant_scope_missing`（R3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 接口与数据流

### 两个进程

|                  | 宿主进程（`app`）                                     | 沙箱进程（`sandbox`）                                            |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `APP_ROLE`       | `host`（缺省）                                        | `sandbox`，只在 demo profile                                     |
| 装载             | 宿主；设了 `public_host` 的 standard 租户（线上不用） | 未到期的沙箱                                                     |
| 服务的 Host      | 单 standard 时任何 Host；多个时按 `public_host`       | 只有 `SANDBOX_HOST`                                              |
| 作用域           | 单 standard 时可回落；多个或 `TENANCY_STRICT=1` 严格  | 永远严格                                                         |
| 渠道、任务、跟进 | 照旧                                                  | 不起                                                             |
| `var/`、spill    | 照旧                                                  | 不挂、不写                                                       |
| 外发             | 照旧                                                  | 只有模型、embedding 与 `ALERT_WEBHOOK_URL`；有别的凭据就拒绝启动 |
| 模型并发闸       | 照旧                                                  | `LLM_MAX_INFLIGHT=2`，不设对冲                                   |
| reaper、开通     | 无                                                    | 有                                                               |
| 停掉的影响       | —                                                     | 只有沙箱不可用；`docker compose stop sandbox`，宿主不用重启      |

### 模块

```
src/tenancy/
  runtime.ts          TenantRuntime、注册表、作用域、严格模式、currentRuntime()（R3）
  hosts.ts            Host 规范化、解析与中间件（R4）
  state.ts            登记表（R5）
  state-manifest.ts   模块级状态清单（R5，lint 读它）
  budget.ts           TenantBudget 与池（R15）
  sandbox/            role.ts（R1、R16）、provision.ts（R9）、session.ts（R10）、reaper.ts（R12）、routes.ts、limits.ts（R14）
src/cli/sandbox.ts    list / end / purge（R13）
src/db/client.ts      withNewSandboxTenant
drizzle/0008_*.sql    新列、新表、四个函数、授权、channel_accounts 的 INSERT 触发器
scripts/check-tenant-state.ts、scripts/check-seed-fixture.ts
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
  readonly isHost: boolean; // 宿主（R2）
  readonly expiresAt: number | null; // 只有沙箱有
  readonly publicBase: string; // R4；沙箱是 https://<SANDBOX_HOST>
  readonly flags: Readonly<DeployFlags>; // 宿主进程即 profile；沙箱进程见 R16
  state: 'serving' | 'closing' | 'closed';
  readonly cancel: AbortSignal; // R12：关闭时触发
  readonly inflight: InflightRegistry; // R12：模型与 embedding 请求、配置写事务、写队列
  readonly config: TenantConfig; // 今天 source.ts 的 Loaded
  pack: PackBinding; // 今天 pack-api.ts 的 binding
  readonly store: TenantStore; // sessions、orders、PG 后端；宿主另有文件后端；沙箱的 queueJobs 丢弃（R11）
  readonly budget: TenantBudget;
  readonly events: ConsoleEventHub; // 事件环、序号、listener、计数去抖、storeEvents
}
export class TenantScopeMissing extends Error {}
export function withTenantScope<T>(rt: TenantRuntime, fn: () => T): T;
export function withoutTenantScope<T>(fn: () => T): T; // 实例级定时器与监听用（als.exit）
export function currentRuntime(): TenantRuntime; // R3
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

| 路由（现状出处）                                                                                                                                                                              | 宿主进程                                                                                                       | 沙箱进程（都要有效 cookie）                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/pay/:orderId`、`GET /api/orders/:id`、`POST /api/orders/:id/pay`（全局 identity map、当前绑定，`src/server.ts:613`、`:631`、`:696`）                                                        | R4 解析出的租户里按订单 id 找，用它的品牌；模拟支付照旧按 profile                                              | 沙箱里按订单 id 找；模拟支付开着，过同源检查                                                                         |
| `/proposal/*`、`/api/proposal/:routeId`（当前产品库与版本历史，`:757`、`:813`）                                                                                                               | 该租户的                                                                                                       | 沙箱的                                                                                                               |
| `/privacy`（全局快照，`:919`）                                                                                                                                                                | 该租户的当前隐私说明                                                                                           | 沙箱的                                                                                                               |
| 模拟器：`/chat.html`、`POST /api/chat`、`GET /api/stream/:sessionId`、`GET /api/sessions/:id`（`sim-`、全局订阅，`:410`、`:429`、`:507`）                                                     | 只在宿主：照旧（`sim-`、JSON，`GET /api/sessions/:id` 照旧读种子与本人的 `sim-` 会话）；别的 standard 租户 404 | 页面带来的 `sim-<x>` 对照成 `sbx-<x>`，也认沙箱里已有的会话 id（工作台「在模拟器里打开」带 `?c=<id>`）；写过同源检查 |
| `/w/:key`、`/api/web/:key/*`（已装载账号按 key，`src/web/routes.ts:119`）                                                                                                                     | 该租户的账号里按 key                                                                                           | 404                                                                                                                  |
| `/wecom/callback/:key`、`/wecom/callback`（`src/server.ts:830`、`:839`）                                                                                                                      | 该租户的账号里按 key；不带 key 是该租户前缀为 `wecom:` 的账号，env 凭据只属宿主                                | 404                                                                                                                  |
| `/console/*`、`/api/console/*`（登录与 cookie 固定查当前租户，`src/auth/session.ts:137`、`:206`）                                                                                             | 登录查该租户成员，`__Host-sid` 的会话租户必须是它（认证函数本就按租户查）                                      | R10：没有口令登录，cookie 经 `sandbox_session_resolve`                                                               |
| 旧接口与作战室：`GET /api/sessions`（列表）、`/api/sessions/:id/*`（接手、交还、回复、草稿、建议）、`/api/orders`、`/api/admin/*`、`/api/usage`、`/api/insights`、`/admin.html`、`/kf-qr.png` | 只给宿主，其余租户 404                                                                                         | 404                                                                                                                  |
| `/healthz`                                                                                                                                                                                    | 照旧                                                                                                           | 沙箱进程自己的（R19），任何 Host 都答                                                                                |
| `/`、`/guide.html`、`/try`                                                                                                                                                                    | 照旧；`/try` 302 到沙箱 Host（没配 `SANDBOX_HOST` 时回引导页并带「暂未开放」）                                 | `/try` 是开通页                                                                                                      |
| `POST /api/sandbox`、`POST /api/sandbox/end`（新）                                                                                                                                            | 404                                                                                                            | 开通（R9）、结束体验（R12），都过同源检查                                                                            |

### 进程内状态

| 状态（出处）                                                                                                                                                                                                                                                                                      | 05                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行业包绑定（`src/core/pack-api.ts:600`）；配置 `loaded`、`catalogListeners`、过期标记（`src/config/source.ts:164`、`:209`）                                                                                                                                                                       | 运行时的 `pack`、`config`；`turnPin` 已核对 tenantId，保留                                                                                         |
| 语义索引（`src/core/retrieval.ts:28`）                                                                                                                                                                                                                                                            | 每个进程一份按（检索文本指纹，模型）共享的只读缓存，运行时持引用；内容相同才共用，不泄漏。缓存文件只在宿主进程；沙箱进程只在内存，沙箱之间共用一份 |
| 会话与订单 Map、PG 后端、文件后端（`src/store.ts:113`、`:119`、`:121`）；引擎会话串行链（`src/core/engine/index.ts:150`）                                                                                                                                                                         | 运行时的 `store`（文件后端只在宿主）；串行链键（租户，会话）                                                                                       |
| 接管代次、回复去重（`src/handoff/takeover.ts:117`、`:304`）、发送账本（`src/quota/ledger.ts:179`）、洞察 / 建议 / 草稿缓存（`src/core/insight.ts:33`、`:93`）                                                                                                                                     | 键带租户或挂到运行时；草稿等异步结果落地前核对运行时状态（R12）                                                                                    |
| 运行数字缓存（`src/ops/metrics.ts:50`）                                                                                                                                                                                                                                                           | 已按租户建键；去掉「拒绝非当前租户」，按作用域                                                                                                     |
| 渠道账号与注册表（`src/channels/accounts.ts:208`、`src/channels/registry.ts:93`）；SSE（`src/adapters/simulator.ts:9`、`src/adapters/web.ts:14`）、console 事件环与计数去抖（`src/console-api/events.ts:23`、`:48`）、领域事件（`src/store/events.ts:12`）、`storeEvents`（`src/store.ts:146`）   | R6                                                                                                                                                 |
| 隐私说明与轮询（`src/privacy/privacy.ts:14`、`:19`）                                                                                                                                                                                                                                              | 运行时上；宿主进程轮询逐个 standard 租户，沙箱进程不轮询                                                                                           |
| 跟进 `known`、任务 `mine`、通知 `unsaved`/`waiting`（`src/jobs/followup.ts:87`、`src/jobs/runner.ts:131`、`src/notify/handoff.ts:133`）                                                                                                                                                           | 只在宿主进程，键带租户                                                                                                                             |
| `usage_daily` 累加器与 writer（`src/trace/usage-daily.ts:30`、`:41`）                                                                                                                                                                                                                             | 键带租户，每租户一个 writer                                                                                                                        |
| `usage.json`、`budget.json`（`src/usage.ts:88`、`src/budget.ts:9`）、种子保鲜与访客清理（`src/store.ts:589`、`:660`、`:680`）                                                                                                                                                                     | 只属宿主，只在宿主进程                                                                                                                             |
| 日志与 OTel 的租户（`src/log.ts:40`、`src/ops/otel.ts:49`）                                                                                                                                                                                                                                       | 取作用域                                                                                                                                           |
| **实例级**：IP 桶与网页 SSE 总量（`src/http-guards.ts:67`、`src/web/routes.ts:42`、`src/adapters/web.ts:23`）、模型并发闸与等待队列（`src/llm-gate.ts:21`、`:28`）、模型探测与统计（`src/core/llm/client.ts:50`、`:190`）、profile（`src/profile.ts:134`）、告警（`src/ops/alert.ts:55`、`:141`） | 保持全局：资源保护或按模型的事实，不含租户数据；定时器与监听在空作用域里挂（R3）                                                                   |
| **按对象键 / 每轮**：以会话对象为键的弱引用表（如 `src/store.ts` 的 `tombstoned`）、每轮的工具复用 Map（`src/core/llm/client.ts:600`）、trace 的 `AsyncLocalStorage`（`src/trace/recorder.ts:115`）                                                                                               | 不动                                                                                                                                               |

### 渠道与出站路径

沙箱会话都是 `channel: 'simulator'`，下表标明每条路径在沙箱里是自然不走，还是要显式挡（R11）。

| 路径（出处）                                                                                                                                                                   | 沙箱                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 人工回复的窗口判断与额度预占（`src/handoff/takeover.ts:354`）                                                                                                                  | 自然不走：只对 `wecom` 会话算                                                                                       |
| 工作台的送达状态、发送窗口与回复框禁用（`src/console-api/workbench.ts:211`、`:251`，`src/console-api/app.ts:629`）                                                             | 自然不走：同上                                                                                                      |
| 人工回复、prepare、release、同意菜单、付款确认的适配器选择（`src/server.ts:103`、`:117`、`:119`、`:665`；`src/core/engine/index.ts:225`、`:849`；`src/payment/orders.ts:105`） | 按 channel 选到模拟器；另在 `adapterFor` 按租户种类兜底                                                             |
| 推送失败备注（`src/handoff/takeover.ts:413`、`src/payment/orders.ts:109`、`src/server.ts:672`）                                                                                | 自然不走：模拟器的 push 恒为成功（客户不在线时消息已在会话里）                                                      |
| 跟进资格与排程（`src/core/followup.ts:79`、`src/jobs/followup.ts:90`）                                                                                                         | 自然不走：资格要求真实企微会话；排程另被 `queueJobs` 丢弃                                                           |
| 转人工与订单通知任务（`src/handoff/record.ts:109`；`src/jobs/notify.ts:43`、`:74`；`src/packs/travel/tools/index.ts:253`）                                                     | 要挡：沙箱 `TenantStore.queueJobs` 丢弃任务操作（`src/store.ts:365`）                                               |
| 保留期清理任务（`src/jobs/runner.ts:307`）                                                                                                                                     | 自然不走：沙箱进程不起任务 runner                                                                                   |
| 未保存转人工的群通知（`src/store/events.ts:61`；`src/notify/handoff.ts:154`、`:178`）                                                                                          | 要挡：按会话所属租户跳过沙箱；沙箱进程也没有 `NOTIFY_WEBHOOK_URL`                                                   |
| 企微底层：`pushRoute` 与 `push`（`src/adapters/wecom.ts:2796`、`:2848`），自动回复、兜底、欢迎语、`send_msg_on_event`、恢复、token、拉取、上传（`:1407`、`:1788`、`:419`）     | 结构上不可达：沙箱进程不起企微运行时、没有凭据；另让 `pushRoute` 与 `push` 拒绝沙箱租户的会话（DB 与 env 两条分支） |
| 运维告警（`src/ops/alert.ts:174`、`:342`）                                                                                                                                     | 只关乎某个沙箱的只记日志；进程级的（库不可达、模型失败率、purge 积压、池）照发                                      |
| OTel（`src/ops/otel.ts:55`、`src/otel/export.ts:112`）                                                                                                                         | 结构上不可达：沙箱进程没有 OTLP 端点                                                                                |
| 模型与 embedding（`src/llm-gate.ts:89`、`src/core/retrieval.ts:60`）                                                                                                           | 照常，过沙箱进程的并发闸、预占预算（R15）                                                                           |
| 整实例拨测与备份（`deploy/watch.sh:92`、`deploy/backup.sh:89`）                                                                                                                | 照旧；备份里的沙箱数据随保留期滚掉                                                                                  |

### 开通与删除

| 内容               | 沙箱里是什么（开放问题 1 的推荐）                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SOP 与品牌         | 宿主当前发布版本的节与渲染输入里的品牌快照，渲染成沙箱的发布版本 1，四个哈希与宿主已发布的相同；沙箱的 `tenants.brand` 写这份快照；草稿与历史不复制                                                                                                |
| 产品库             | active 条目的当前内容，各自版本 1，`ord` 原样；草稿条目与历史不复制                                                                                                                                                                                |
| 快捷回复、隐私说明 | 未归档的快捷回复，顺序原样；当前隐私说明作为版本 1                                                                                                                                                                                                 |
| 种子               | `data/sandbox-seeds.json`（由 `scripts/seed-demo.py` 默认场景生成、时间存相对值）：13 个会话、3 个订单；会话 id 换成新的 `sbx-` 随机 id、`channel` 改 `simulator`，订单 id 原样（主键带租户）；时间整体平移到最新一条在开通前 5 分钟（同保鲜规则） |
| 成员与会话         | 只有合成用户「体验访客」（owner）：邮箱 `<slug>@sandbox.invalid`，口令哈希是校验不过的固定值；一个登录会话，到期等于沙箱到期                                                                                                                       |
| 不复制             | 宿主的成员、审计、渠道账号、真实会话与访客会话、trace、用量、任务、同意记录；复制只带内容，不带任何用户 id、成员姓名与变更说明                                                                                                                     |

`scripts/check-seed-fixture.ts` 进 `pnpm lint`：调 `python3 scripts/seed-demo.py --fixture` 重新生成，与 `data/sandbox-seeds.json` 不同就失败。

开通（`POST /api/sandbox`，沙箱进程）：① 过同源检查；带着有效 cookie 且沙箱在服务 → 200 原样返回；② 进互斥锁，判 R14；③ 只读事务读宿主的已发布快照（R9）；④ 一个事务：`sandbox_tenant_create(slug, 宿主 id, 快照里的品牌, token_hash, ip, user_agent)` → 设 `app.tenant_id` → 写配置、隐私说明、快捷回复、种子 → 审计 `sandbox.create`；slug 是 `sbx-` 加 20 位小写 base32；⑤ 提交后按 R2 的路径装载、取锁、登记，失败则 `sandbox_tenant_expire` 并回 503；⑥ 回 201 `{ url: '/console/', expiresAt }` 并 `Set-Cookie`。删除按 R12。

### 预算

```ts
// src/tenancy/budget.ts（新）
export interface Reservation {
  /** 按实际用量结算；拿不到用量（失败、超时）传 null，按预占值记 */
  settle(actualMilli: number | null): void;
}
export interface TenantBudget {
  /** 每次请求尝试发出之前同步调（拿到并发闸名额之后）：同时预占本沙箱与全池的 1 次与 estimateMilli；任一不够返回 null。standard 恒返回只记账的 Reservation */
  reserve(purpose: UsagePurpose, estimateMilli: number): Reservation | null;
  status(): { calls: number; costMilli: number; capCalls: number | null; capMilli: number | null };
}
```

`src/llm-gate.ts` 在每次 fetch 之前经作用域里的运行时调 `reserve`，拿到 `null` 就以 `BudgetExhausted` 结束这次调用；引擎里今天的 `visitor = channel === 'simulator'`（`src/core/engine/index.ts:610`）改为：沙箱的对话轮次遇到 `BudgetExhausted` 降级成 mock，宿主的 `sim-` 会话照旧看访客预算；降级都经同一个 `forceMock`。

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
--   public_host 是规范化之后的小写主机名、不带端口；llm_daily_alert_milli >= 0
CREATE UNIQUE INDEX tenants_public_host_uq ON tenants (public_host) WHERE public_host IS NOT NULL;

-- 不带 tenant_id：只有计数与金额，不是租户数据，不套 RLS；沙箱删了统计还在
CREATE TABLE sandbox_pool_daily (
  day         date   PRIMARY KEY,
  provisioned int    NOT NULL DEFAULT 0 CHECK (provisioned >= 0),
  purged      int    NOT NULL DEFAULT 0 CHECK (purged >= 0),
  calls       bigint NOT NULL DEFAULT 0 CHECK (calls >= 0),
  cost_milli  bigint NOT NULL DEFAULT 0 CHECK (cost_milli >= 0)
);

-- 四个函数：属主 agent_owner，SECURITY DEFINER，search_path = pg_catalog, public, pg_temp，表名全限定，只 GRANT EXECUTE 给 agent_app；
-- 时刻一律取 now()；函数内设、复原 app.tenant_id，同 01 的认证函数
-- create：模板须是未停用的 standard；slug 以 sbx- 开头；建租户（pack_id 取模板，brand 用参数，不读模板的 tenants.brand；
--   expires_at = now() + 24h）、合成用户、owner 成员关系、登录会话（expires_at 等于沙箱到期）；provisioned + 1
CREATE FUNCTION sandbox_tenant_create(p_slug text, p_template uuid, p_brand json, p_token_hash bytea, p_ip inet, p_user_agent text)
  RETURNS TABLE (o_tenant uuid, o_user uuid, o_expires_at timestamptz);
-- resolve：只在 kind = 'sandbox'、未到期、成员关系在、用户未停用时返回；刷新 last_seen_at；空闲期限等于剩余寿命
CREATE FUNCTION sandbox_session_resolve(p_token_hash bytea)
  RETURNS TABLE (o_tenant uuid, o_user uuid, o_role text, o_display_name text, o_expires_at timestamptz);
CREATE FUNCTION sandbox_tenant_expire(p_tenant uuid) RETURNS boolean;
-- purge：只删 kind = 'sandbox' 且 expires_at <= now() 的；调用方须已在 withTenant(p_tenant) 里（同 02 的清除函数）
CREATE FUNCTION sandbox_tenant_purge(p_tenant uuid) RETURNS json;
-- channel_accounts：新建 BEFORE INSERT 触发器，所属租户 kind = 'sandbox' 时拒绝
```

- 授权：`agent_app` 对 `sandbox_pool_daily` SELECT、INSERT、UPDATE；`agent_platform` 加 `GRANT UPDATE (public_host, llm_daily_alert_milli) ON tenants`。
- 审计动作加 `sandbox.create`、`sandbox.end`（在沙箱自己的审计里，随它删除）、`tenant.host_set`、`tenant.host_clear`、`tenant.budget_set`、`tenant.budget_clear`。
- 迁移 lint：`tenants` 的 CHECK 标注 `-- migration-allow: add-check 新列可空或带默认，旧镜像不写这几列`。

### 界面

- **引导页**：「体验工作台」按钮链到 `/try`，一句说明：临时环境、24 小时后删除、发送只进模拟器。
- **`/try`**（沙箱 Host）：说明（另加「不要输入真实个人信息」、闲置会提前结束与备份保留期）与「开始体验」。开通中显示进度；被限额拒绝时显示原因并给宿主的只读工作台、网页模拟器两个入口；出错可重试；从已结束的体验跳来时说一句「上一次体验已结束」。
- **沙箱 console**：同一个前端。顶栏横幅「体验环境 · 剩余 X 小时 · 发送只进模拟器」，带「打开模拟器」「结束体验」；会话详情加「在模拟器里打开」；不显示登录页，`/me` 回 401 `sandbox_required` 时跳 `/try`；写入被限时提示 `sandbox_write_limited`。`Me` 加 `sandbox: { expiresAt: string } | null`。
- **沙箱模拟器**：同一份 `chat.html`，顶部同样一条提示，认 `?c=<id>`；刷新之后照旧经 `GET /api/sessions/:id` 恢复历史。锁定的 `server.selftest.ts` 对 `chat.html` 源码的检查（`LS_KEY`、单独执行的 `newSessionId()` 仍产出 `sim-`、`fillPayCard`、开场句）照旧通过。

### 环境变量

| 变量                                                          | 进程 | 默认（沙箱的值见开放问题 8） | 说明                                                     |
| ------------------------------------------------------------- | ---- | ---------------------------- | -------------------------------------------------------- |
| `APP_ROLE`                                                    | 两者 | `host`                       | R1、R16                                                  |
| `SANDBOX_HOST`                                                | 两者 | 空                           | 宿主只用于 `/try` 跳转；域名不进仓库                     |
| `SANDBOX_TEMPLATE_SLUG`                                       | 沙箱 | 空（必填）                   | 模板租户（宿主）                                         |
| `TENANCY_STRICT`                                              | 宿主 | 空                           | `1` 时单运行时也严格（CI 用）                            |
| `LLM_MAX_INFLIGHT`                                            | 沙箱 | 2                            | 沙箱进程的 `.env.sandbox` 里设                           |
| `SANDBOX_MAX_LIVE`                                            | 沙箱 | 20                           | 同时活着的沙箱                                           |
| `SANDBOX_PER_HOUR` / `SANDBOX_PER_DAY` / `SANDBOX_PER_IP_DAY` | 沙箱 | 10 / 50 / 3                  | 开通数；IPv6 按 /64                                      |
| `SANDBOX_IDLE_MINUTES`                                        | 沙箱 | 120                          | 闲置回收                                                 |
| `SANDBOX_LLM_CALLS` / `SANDBOX_LLM_CNY`                       | 沙箱 | 300 / 1                      | 每个沙箱从开通到删除，按请求尝试计                       |
| `SANDBOX_POOL_DAILY_CNY`                                      | 沙箱 | 10                           | 当天全部沙箱合计（含首次建索引）                         |
| `SANDBOX_MAX_CONVERSATIONS`                                   | 沙箱 | 30                           | 每个沙箱的新会话（种子不算）                             |
| `SANDBOX_WRITE_LIMITS`                                        | 沙箱 | 见开放问题 8                 | 写请求速率、条目数、版本数、导入行数、发布数、快捷回复数 |

24 小时的寿命是常量。

## 不变量

1. 严格模式下（沙箱进程、多 standard 的宿主进程、`TENANCY_STRICT=1`），在租户作用域外读写任何登记的租户状态都抛 `TenantScopeMissing`，不回落；HTTP 回 500，后台入口记日志并推 `tenant_scope_missing`，进程不退出。
2. 两个租户用同一个会话 id、订单 id、账号 key 时，各自的 `getSession`、`getOrder`、接管代次、账本、SSE 订阅、console 事件互不可见。
3. 对话轮次发出的每个模型请求，system 与 tools 字节等于这一轮所属租户本轮捕获的发布版本；两个租户交错对话时各自的 `promptHash`、品牌、产品库、identity map 互不可见。
4. 一个公开请求只从 R4 解析出的那一个租户取数据；装了多个 standard 租户的进程里未知 Host 是 404；沙箱进程只答沙箱 Host（`/healthz` 除外）。
5. 沙箱进程的环境里没有企微凭据、渠道密钥环、`NOTIFY_WEBHOOK_URL`、OTLP 端点、对冲模型；沙箱租户的人工回复、通知与付款确认只进它的模拟器 SSE；库里沙箱的 `channel_accounts` 与 `jobs` 行数恒为 0。
6. 沙箱里的会话 id 都以 `sbx-` 开头、`channel` 都是 `simulator`；沙箱进程不在 `var/` 写任何文件。
7. 到期删除成功之后：以不经 RLS 的身份数，每张带 `tenant_id` 的表里该 id 的行数为 0，`tenants`、`users`、`auth_sessions` 里没有它；`tenantKeys(id)` 每项为 0，注册表里没有它。
8. 运行时进入 `closing` 之后，没有任何迟到的结果改它的状态；用量刷进库之后才 purge。
9. `sandbox_tenant_purge` 的删除清单覆盖系统目录里每一张带 `tenant_id` 的表。
10. 四个沙箱函数对 standard 租户一律报错，时刻只取库内 `now()`；purge 只删已到期的；`agent_app` 没有别的途径建、删租户。
11. `__Host-sbx` 只在沙箱进程被读；沙箱进程不读 `__Host-sid`、没有口令登录；一个沙箱的会话只能操作它自己；沙箱的所有非安全方法拒绝 `Sec-Fetch-Site` 为 `same-site` 与 `cross-site` 的请求。
12. 每次请求尝试发出之前，本沙箱与全池的次数与金额都已预占；一个沙箱一生、全部沙箱一天的花费与尝试次数不超过各自上限，例外只有崩溃重启（至多少记 30 秒）；全池用完之后没有沙箱再发出请求。开通的每小时与每 IP 计数同样只有崩溃重启这一个例外。
13. standard 租户的模型调用不因预算降级或被拒。
14. `src/**` 的模块级绑定（R5 列的例外之外）都在状态清单里，标成租户状态的都已登记。
15. 宿主进程的四个哈希、demo 行为与 `/healthz` 与开工时相同；停掉沙箱进程不改变宿主的任何行为。

## 兼容与迁移

- 迁移只扩：新列可空或带默认，新表、新函数、新触发器旧镜像不碰。
- 升级没有手工步骤：宿主进程只装宿主，行为照旧；`sandbox` 服务在 compose profile 里，默认不起。线上 demo 开沙箱：配好沙箱 Host 的 DNS、证书与反向代理站点，写 `.env.sandbox`，开 `sandbox` profile，部署。
- 文件模式与锁定套件只有一个运行时，行为不变。回滚按 R18。

## 安全、隐私与性能

- 匿名访客能写的内容（SOP、产品文字、快捷回复、聊天）只在沙箱 Host 上渲染；沙箱 Host 与主站不同源，转义疏漏最多是访客在自己沙箱里自伤，碰不到成员的 cookie 与工作台。沙箱进程的页面另加 CSP：脚本只许同源与按 hash 或 nonce 放行的本页内联脚本（`chat.html`、`pay.html`、`proposal.html` 有内联脚本，不能直接照搬网页渠道那一套，`src/web/routes.ts:137`），不许任何外部来源。沙箱里的会话 id、订单 id 不再是凭据，一律要 cookie；写请求另过同源检查（R10）。
- 隐私：`/try` 与横幅写明临时、24 小时或闲置后删除、不要输入真实个人信息、备份保留期；沙箱进程没有 OTLP 端点；日志脱敏正则加 `sbx-`。
- 性能：沙箱进程多占一份 Node 常驻内存（开工实测）与一组数据库连接（池 max 5 加一条锁连接）；沙箱全量预载在内存，每个约一份配置快照加十来个会话，索引在沙箱之间共用。宿主进程不受沙箱的模型并发与内存影响，共享的只有数据库与模型供应商的速率限制；验收记录沙箱压测时宿主的排队延迟与库的写入积压。

## 验收标准

1. **进程内隔离（R17 的 A、B）。** 同一会话 id、订单 id、网页账号 key 在 A、B 各取到自己的对象；交错对话时，假模型记下的每个请求的 system、tools 哈希等于所属租户的值，A 的请求与回复里没有「山海」、B 的没有「云途」；只有 B 有的线路只出现在 B 的检索与报价里，改过价的线路在 A 照旧原价；A 的模拟器 SSE 与 console 事件流收不到 B 的推送，反之亦然；日志的租户字段各自正确。
2. **作用域与清单。** 严格模式下在作用域外调 `getSession`、`currentPack()`、`currentCatalog()` 都抛 `TenantScopeMissing`；后台入口缺作用域时进程不退出，日志有一行、`tenant_scope_missing` 推了一条；沙箱进程从 0 个运行时到 2 个再回到 0 个，全程没有串台、没有 `TenantScopeMissing`；`TENANCY_STRICT=1` 下 02–04 在 DB 模式下的非锁定自测全绿。往 `src/` 任一模块顶层加一个不进清单的数组或 `new Map()`，`pnpm lint` 失败，补上后通过。
3. **公开路由与 Host。** 测试里两个 standard 租户各设 `public_host`：「公开路由」表的宿主列每一行在自己的 Host 上取到自己的数据，换到另一个租户的 Host 是 404 或那个租户自己的数据；未知 Host 404；装两个而一个缺 `public_host` 时以 `tenant_host_missing` 拒绝启动；只装一个时任何 Host 都是它。沙箱进程对别的 Host 只答 `/healthz`。Host 带末尾点、带端口、IPv6 字面量都规范化正确。线上 demo：经真实反向代理，两个站点收到的 Host 原样，`clientKey()` 取到的是访客的真实地址。
4. **开通。** 从 `/try` 点开始到进工作台，20 次 p95 不超过 3 秒；沙箱里 13 个种子会话（都是 `sbx-`、`simulator`）、3 个订单、产品条目数等于宿主的 active 条目数，四个哈希与宿主已发布的相同；宿主已 `tenant-brand set`、还没重启时开通，沙箱的哈希仍等于宿主已发布的；宿主的库行数与哈希不变；带有效 cookie 再开通返回同一个沙箱。
5. **工作台全程。** 在沙箱里接手一个种子会话并回复，模拟器 1 秒内出现「【顾问】……」；交还后在模拟器发消息，AI 回复；刷新模拟器，聊天历史恢复；改一条线路的价格，模拟器里新报价用新价，宿主不变；标已付，模拟器收到付款确认；改 SOP 前言并发布，沙箱 `promptHash` 变、宿主不变；模拟器开的新会话实时出现在工作台；「重置」只影响沙箱的那个会话。
6. **只进模拟器。** 沙箱进程的环境里设任意一个 `WECOM_*`、`NOTIFY_WEBHOOK_URL`、`OTEL_EXPORTER_OTLP_ENDPOINT` 或 `LLM_HEDGE_MODEL`，以 `sandbox_env_forbidden` 拒绝启动。测试里把企微 API、两个 webhook、OTLP 都换成本机记录器、并强行给沙箱进程装上企微运行时，跑完验收 5 再加：最早时间戳的种子会话（今天的企微窗口早已关闭）接手回复成功；模拟器没有 SSE 连接时回复成功、没有失败备注；一次会话落库失败；advisor 模式下顾问建单；一次转人工；一次进程级告警。结果：企微请求 0、群通知 0，告警只有进程级那条，OTLP 0；沙箱的 `jobs` 与 `channel_accounts` 行数为 0，没有会话被标 poisoned；给沙箱插 `channel_accounts` 被触发器拒。
7. **预算。** 同一沙箱多个会话加洞察并发、`SANDBOX_LLM_CALLS=5`：发出的请求尝试恰好 5 次，之后对话降级成 mock、`outcome = 'budget'`；假模型先回 500 再回 200，一次调用计 2 次；全池额度用完之后，已有的沙箱也停止调用（降级），开通回 503 并推一条 `sandbox_pool` 告警；重启之后已花数接着算（崩溃时至多少记 30 秒）。standard 租户越过 `llm_daily_alert_milli` 只告警一次、对话不降级。作战室的「当日模型成本」不含沙箱花费。
8. **限额与写入上限。** 活着的沙箱到上限时下一个 429；每小时、每天、每 IP（含同一 /64 的两个 IPv6 地址）的上限各验一次；写入的每一项上限各验一次（`sandbox_write_limited`），模型降级之后写额度照计。20 个沙箱各连发 5 轮、并有一个沙箱按写上限连续写入时，宿主每轮的排队等待中位数比没有沙箱时多不超过 1 秒，宿主的写库积压不超过 2 秒；沙箱进程的 RSS 记进 plan。
9. **到期删除。** 把一个沙箱的 `expires_at` 拨到过去：1 分钟内接口回 410、页面跳 `/try`；以超级用户按系统目录逐表数它的行全为 0，`tenants`、`users`、`auth_sessions` 里没有它；`tenantKeys(id)` 每项为 0；`sandbox_pool_daily` 当天的 `purged` 与花费加上了。另验：一个请求超过 30 秒等待才返回，它的结果没有改任何状态（草稿缓存里没有它）；用量刷写失败时这一轮不删、下一分钟删干净；purge 失败（锁超时）之后重试删干净；删除事务中途杀进程，重启时删干净。「结束体验」与闲置 `SANDBOX_IDLE_MINUTES` 之后同样删掉。过期超过 1 小时仍没删掉时推 `sandbox_purge`，沙箱进程 `/healthz` 的 `ok` 为 false。
10. **重启与角色。** 沙箱进程重启之后活着的沙箱还在（cookie、会话、改过的价格），到期的在启动时删掉、不装载；停机时没落库的写入丢弃、日志有条数、`var/` 下没有新文件。`docker compose stop sandbox` 之后宿主的 `/healthz`、四个哈希、企微一句一回不变，宿主没有重启。prod profile 下 `APP_ROLE=sandbox` 启动失败；缺 `SANDBOX_HOST` 或 `SANDBOX_TEMPLATE_SLUG` 启动失败。`sandbox list`、`sandbox end <slug>`、`sandbox purge --all`（沙箱进程在跑时以 3 退出）各验一次。
11. **会话与安全。** 沙箱进程上带 `__Host-sid`、宿主进程上带 `__Host-sbx`，都是 401；沙箱 A 的 cookie 访问沙箱 B 的会话 id 是 404；沙箱进程上口令登录 404；`sandbox_session_resolve` 对 standard 租户的 token、到期沙箱的 token 返回空；闲置 13 小时（未超过剩余寿命与闲置回收）之后 cookie 仍有效。从兄弟源（`Sec-Fetch-Site: same-site`）发的简单 POST 到聊天、模拟支付、结束体验、console 写接口都是 403。产品标题放 `<img src=x onerror=alert(1)>`：沙箱的支付页、方案书、模拟器、工作台都当文本显示，页面响应带 CSP。
12. **demo 照常。** 04 验收 14 那一组（重置、种子保鲜、访客清理与上限、匿名只读、模拟支付、AI 标识）在宿主进程照旧；线上部署后宿主 `/healthz` 四个哈希与开工相同，企微一句一回。
13. **回滚检查。** 本机真实 docker 经 `deploy.sh`：`sandbox` 服务在跑时部署 04 的 tag，检查以 7 拒绝、`deploy.sh` 1、打印停服务与摘站点的步骤、服务器不动；停掉服务但库里有沙箱行时，检查脚本跑 `sandbox purge --all` 之后放行；purge 持续失败、或运行时计数为 0 而库里仍有沙箱行时拒绝；库不可达时拒绝；宿主以外的 standard 租户设了 `public_host` 时拒绝；04 的品牌风险同时存在时先报 6；健康检查失败后的自动回滚同样经过检查。
14. **锁定与门禁。** 每一步结束时锁定套件零修改、全绿，`PREFIX sha256` 与开工相同；四个门禁全绿（含 `check-tenant-state` 与 `check-seed-fixture`）；最后一步对开工提交 `git diff` 锁定文件为空。

## 开放问题

ready 之前由 owner 定；正文的 R 按推荐写，改了选项就改对应的 R。

1. **模板来源与复制范围。** A 配置取宿主当前**已发布**的（品牌、SOP、产品库同一份快照），种子取仓库里的固定种子文件；B 全取仓库静态数据（每次开通走一遍导入与渲染）；C 全取宿主当前状态（含内存里的种子）。推荐 A：访客看到的配置就是线上 demo 此刻的样子，四个哈希与宿主已发布的相同；宿主内存里的种子会被演示改动（成员回复带真实的显示名、有人点过模拟支付、被接手过），复制过去就把成员姓名与别人的操作带给了访客，所以 C 不行；B 会与线上 demo 不一致。依据：owner 要不要沙箱跟着线上 demo 的配置走。
2. **沙箱的持久化契约。** A 进 PG，会话一律 `sbx-` id、`channel: 'simulator'`，02 R6、`conversations_id_check`、不变量 11、console 排除 `sim-` 原文不动，02 不变量 6 与 13 按文件头部分取代；B 种子副本保留原 id 与 `channel: 'wecom'`，`Supersedes in part` 02 R6 与不变量 11，CHECK 换成触发器、`isDemoClassId` 改看租户；C 沙箱只在内存。推荐 A：已实现的会话契约不改，宿主「demo 类永不进库」的保护原样留着；`simulator` 渠道让按企微判断的窗口、额度、跟进、失败备注在沙箱里自然不走，剩下的几处显式挡（R11）；删干净能用 SQL 证明。B 要给每个按企微判断的分支开沙箱例外；C 里 trace 等是 503，重启即丢。代价：种子在工作台里显示成「演示」渠道，没有企微观感。依据：owner 是否接受。
3. **沙箱在哪种 profile 下开。** A 只在 demo（`APP_ROLE=sandbox` 在 prod 下拒绝启动）；B prod 也能开（给以后托管的试用）。推荐 A：prod 实例服务真实客户，公开的开通入口与它的模型花费没有理由出现在那里；沙箱要的模拟器、模拟支付本来就是 demo 能力。托管要试用时另写 spec。现在就能定。
4. **每租户预算的口径。** A 按轮次（今天访客预算的口径）；B 按请求尝试次数；C 按金额。推荐 C 加 B、在尝试层原子预占、覆盖全部用途、沙箱禁用对冲：金额最接近真实成本，次数兜住未知价格的模型，预占才挡得住并发与重试；A 管不到工具循环、重试、对冲与工作台。沙箱与 standard 分开计：沙箱按个硬上限加当天池上限；standard 只有每天的软上限告警、从不降级，因为把真实客户的对话降成固定话术比多花钱更糟。依据：owner 要不要对 standard 租户设硬上限；现在没有真实的多租户托管，推荐先不设。
5. **免密会话的身份与有效期。** A 独立的 `__Host-sbx`，开通事务里签发、受限函数解析，空闲期限等于剩余寿命，有效 cookie 期间复用；B 复用 `__Host-sid` 加租户切换；C 凭 URL 里的令牌进入。推荐 A：B 让成员登录与沙箱互相挤掉；C 的令牌会经引用头、历史、截图泄露。代价：没有 cookie 的两个标签页同时首开会开出两个、各占名额（要严格「一个浏览器一个」就得另加开通幂等凭据，不值）。ready 之前定。
6. **「只进模拟器」的边界。** A 只禁止真实客户渠道的发送；B 管全部对外副作用（客户渠道、群通知、只关乎沙箱的告警、OTel），只有模型与 embedding 照常、靠预算管。推荐 B：访客能随手触发转人工，A 会让任何人刷运营的企微群；沙箱的告警与遥测对运维是噪音，原文导出还多一处第三方存储。分进程之后 B 大半是结构上的（沙箱进程没有这些凭据），代价很小。ready 之前定。
7. **沙箱用独立 Host 还是与宿主同源。** A 独立 Host；B 同源，沙箱挂在 `/s/<slug>/` 下。推荐 A，理由主要是同源要改的东西多：chat、pay、console 的根路径都写死；`chat.html` 的 `LS_KEY`（`public/chat.html:379`）同源时会与宿主模拟器共用；console 要支持运行时 basepath，展示时要给站内链接补前缀，还会碰锁定套件对 `chat.html` 的检查。另一个好处是匿名访客写的内容与成员的工作台不同源。注意：A 不等于跨站，沙箱 Host 若与主站同一注册域，防线是 `isCrossSite` 拒绝 `same-site`（R10）。分进程（开放问题 11）也要求独立 Host。依据：owner 是否愿意加一个子域名。
8. **限额的数值。** 推荐：同时 20 个；每小时 10、每天 50、每 IP 每天 3 个；闲置 120 分钟回收；每个沙箱 300 次尝试或 1 元、30 个新会话；全池每天 10 元；沙箱进程并发 2。写入：每分钟 30 个写请求、产品条目至多 80（模板 43 条）、每个条目至多 20 个版本、单次导入至多 80 行、每天至多 20 次 SOP 发布、快捷回复至多 50 条。最坏花费：每次尝试发出前都对全池预占了足额的金额，所以一天的总花费不超过池上限；例外只有崩溃重启时少记的至多 30 秒（并发 2，约二十次请求，按 04 实测不到 0.1 元）。正常体验按 04 的实测（真实模型 30 段对话约 0.44 元）远用不到 1 元。ready 之前先定，上线一周后按 `sandbox_pool_daily` 再调。
9. **能不能把模拟器分享给别人当客户**（电脑开工作台、手机扫码当客户）。推荐本阶段不做：要另发一种只能聊天的令牌、再防一层滥用；同一浏览器开两个标签页就能演示。有需要另写。
10. **console 的渠道账号页。** 04 的非目标写成「阶段 5」。推荐本阶段不做：线上 demo 不建网页渠道账号，沙箱没有渠道账号，第一批真实客户一家一个实例、由运维命令开通；等托管多个真实租户时一起做。owner 确认后，主参考阶段 5 一节随 ready 补一句。
11. **沙箱单独一个进程，还是与宿主同一个进程。** A（推荐）单独的 `sandbox` 服务，同一镜像、`APP_ROLE=sandbox`、同一个 PG，见 R1 与「两个进程」表；B 同一进程装宿主与沙箱（原稿），分两步上线：05a 先上多租户核心与严格模式、在线上空跑几天，05b 再开沙箱。推荐 A：宿主进程线上永远只有一个运行时，02–04 的测试覆盖的就是这个形态，作用域漏了也只会在沙箱进程里暴露，碰不到线上 demo；沙箱进程没有凭据，「只进模拟器」大半变成结构上的；出事 `docker compose stop sandbox` 即可，宿主不用重启。代价：多一个 Node 进程（估 150–250 MiB，开工实测）与一组数据库连接；`deploy.sh`、compose、`watch.sh` 认第二个服务；ADR-002「始终一个进程」要补注；语义索引不跨进程共用（沙箱进程首次多建一次，约 20 条 embedding）；「同部署多租户」的线上证明改由沙箱进程里的多个沙箱承担，两个 standard 租户同进程只在测试里验。B 省一个进程，但任何一处作用域遗漏都发生在线上 demo 的进程里，05a 的空跑只能发现已经走到的分支。依据：owner 能否接受多一个服务；ready 之前定。

## 被否决的方案

- **线上开共享的可操作 demo 账号，每天定时重置。** 人工回复会经企微真发给扫码的客户；公开账号能看到真实会话与别的访客的聊天；访客之间互相改坏 SOP 与价格（owner 2026-10-10）。
- **沙箱用单独的库，或每个沙箱一个进程或容器。** 单独的库要另一套迁移、备份与角色，读模板要跨库；每个沙箱一个进程，内存与运维随沙箱数增长。R1 的做法是固定多一个服务、共用一个库，不随沙箱数增长（原稿以「内存与运维翻倍」否决的是这两种，不是固定的第二个服务）。
- **单运行时隐式回落作为通用规则。** 作用域遗漏会被单租户的测试掩盖，直到第一次开出沙箱才暴露；改为按角色与配置在启动时定（R3）。
- **按订单号全局解析公开路由（`SECURITY DEFINER` 函数）。** 方案书、隐私说明、模拟器没有全局唯一的 id，线路 id 在租户之间本就重复；还会让一个租户的支付页在别人的域名下打得开。
- **每个沙箱一个子域名。** 要通配证书与通配解析；一个沙箱 Host 加会话 cookie 就够分开。
- **装载库里全部未停用的 standard 租户。** 留着的测试与演练租户会被意外服务。
- **继续用一个全局 `bindPack`，每轮按租户切换。** 一轮里有多次 `await`，并发的两轮会切走对方的绑定。
- **沙箱种子保留 `channel: 'wecom'` 求企微观感。** 按企微判断的窗口、额度、跟进、通知、失败备注每一处都要开沙箱例外，漏一处就有副作用或误报。
- **用 `jobs` 表触发器挡沙箱的任务。** 任务随会话落库，触发器一拒，整次落库失败，会话被标 poisoned；在 `queueJobs` 丢弃。
- **按成功响应记账、操作开始前判一次额度。** 并发的操作会同时读到未超限，重试与对冲的输家不记；改为尝试层原子预占（R15）。
- **只靠测试清沙箱的状态。** 漏掉没写到的分支；要靠每个模块级绑定都分了类（清单与默认拒绝的 lint）加严格模式。
- **加验证码。** 依赖第三方、还要处理个人信息；全局上限与池上限已封住最坏的花费。
- **删除时留墓碑行。** 与「整个租户删掉」不符；统计进不带租户的 `sandbox_pool_daily`。
