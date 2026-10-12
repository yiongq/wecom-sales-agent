# 05 · 同部署多租户 + 一键体验沙箱 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题编号都指本 spec。共 35 步，合计约 50.25 个工程日。每步一个 PR 进 `dev`，仓库全绿、CI 通过再合。spec 已于 2026-10-11 由 owner 定为 ready，开放问题 1–15 全部照推荐定，其中 12 即授权一次性修改锁定的 `server.selftest.ts` 所列断言（第 2 步）。

## 开工条件

缺一条就停下，告诉 owner：

1. 04 spec 已是 `Status: implemented`（2026-10-11，已满足），线上 demo 跑 04 之后的版本（第 1 步核对 `/healthz` 的 `revision`）。
2. 本 spec 已由 owner 翻成 `Status: ready`，开放问题 1–15 已定（2026-10-11，已满足）。
3. 本机能跑 format / lint / typecheck 与受影响自测，完整 `pnpm test` 由 CI 跑；能起一次性 `pgvector/pgvector:pg17` 容器与真实 docker 演练（compose 的旁路项目、`deploy.sh`）；真实模型凭据由 owner 在仓库外提供。
4. 不挡开工、只挡线上：沙箱 Host 的 DNS、证书与反向代理站点（第 31 步前），企微后台的体验客服接入（第 32 步，要求沙箱已上线），见「上线清单」。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」与「交接记录」，再看 `git log -5`。部署与演练照 03 plan 第 20、21 步与 04 plan 第 25、26 步的做法。代码出处以第 1 步核对后的位置为准；spec 不够用就记「Open」停下，不另定架构。
- 锁定的 8 个文件：`src/engine.selftest.ts`、`src/dejargon.selftest.ts`、`src/engine-holiday.selftest.ts`、`src/price-guard.selftest.ts`、`src/llm.selftest.ts`、`src/server.selftest.ts`、`src/adapters/wecom.selftest.ts`、`eval/cases.json`。唯一的例外是第 2 步那一个提交（开放问题 12），之后 `server.selftest.ts` 以第 2 步记下的新 sha256 为准。红了先查本步改动，确认与 spec 冲突就记「Open」停下。
- **共同门禁**：四个门禁全绿（本机跑 format / lint / typecheck，完整 `pnpm test` 只在 CI 跑，本机不跑全量）；8 个锁定文件 sha256 等于基准；`PREFIX sha256 system/tools` 与 `JSON.stringify(toolDefs)` 字节与第 1 步相同；v2 假模型回归在文件与 PGlite 两条路径全绿。新自测串进 `test`、新检查串进 `lint`；第 11 步起 `check-tenant-state` 在 `lint` 里、`TENANCY_STRICT=1` 的重跑在 `test` 里。本机按改动文件用 grep 列清单，逐个跑受影响的自测；碰库的自测带一次性 `PG_TEST_URL`，跑完删除本次容器。CI 照常跑真实 PG，自 #199 起由 `scripts/ci-shard.ts` 拆成 4 片并行，一轮约 13 分钟，required check 仍叫 `check`（见 [CI 分片 spec](../ci-shards/spec.md)）。PR 先不开自动合并，CI 绿了再开。
- **宿主不变**（目标 7、不变量 15）：宿主进程线上只有一个运行时，单 standard 的回落只为它留。改到宿主路径的步骤以锁定套件与 02–04 自测为回归网，演练与上线另核四个哈希与 04 验收 14 那一组。
- 测试替身：本机假模型 HTTP 服务（04 R10 同一种，能晚到、能回 500）；假企微（记下每个请求的路径、`open_kfid`、`touser` 与正文，回调用测试密钥签名，能回 42001、40014、48007、95003）；两个 webhook 与 OTLP 的记录器。假 id 短（`wm` 加至多 13 位），测试密钥带 `// gitleaks:allow`。
- 本机起沙箱进程：同一份代码、同一个库，`APP_ROLE=sandbox` 加 R16 要求的变量，环境里不带 `DEFAULT_TENANT_SLUG` 与任何 `WECOM_*`；两个进程各用自己的端口。体验客服没配时沙箱照常（只有模拟器）：第 12–24 步的测试都在「没配」下跑，「配了」的情形由第 25–29 步加。
- 变异测试在隔离副本里跑；可能挂住的命令加超时（`perl -e 'alarm N; exec @ARGV' …`），收尾查 `ps`，不留进程、浏览器、容器与临时 tag。沙箱下 tsx 报 `EPERM listen` 是环境原因，在沙箱外重跑即可。
- 派 Codex：标「可派 Codex」的步骤用独立 worktree，一路实现加一路只读评审，Claude 审两路结论、改动范围（没碰锁定套件、没越出本步的文件）与关键几处，门禁以 CI 的 `check` 为准；额度紧时标 Claude 的实现步骤也可这样派。碰线上、花钱、要 owner 拍板的由 Claude 做。共享文件的分工见「工作量、依赖与并行」。这里只给派工建议，不启动并行实施。
- 线上：每次部署都要 owner 在当次会话明确授权（或 owner 自己执行）；部署前手动备份并复制到异地；先用 dev 上的本地 rc tag 上线（不推），验收通过再发版到 main。企微后台由 owner 登录、协调者用 Playwright 操作。
- 不进仓库、不进本文件：域名、服务器 IP、主机与路径、本机绝对路径、企微的 corp id / open_kfid / external_userid / Secret / Token / EncodingAESKey、客服链接、二维码、应用 id；只记不敏感的结果。

## 步骤

### 开工（第 1–2 步）

- [x] 1. 开工核对、四张清单与反向引用（1 工程日，Claude；清单可派 Codex 写、另一路只读 Codex 评审，基准由协调者补）
  - 做：核对开工条件；记开工提交、8 个锁定文件 sha256、`PREFIX sha256` 两个值、工具定义字节、线上 `/healthz` 的 `revision` 与四个哈希；核对开放问题 12 列的行号与 spec 引用的代码出处在开工提交上仍对得上，不对的记新位置；跑四个门禁留基线。
  - 做：四张清单（spec「前置条件」）写进「实施记录 · 第 1 步」：① 模块级状态，逐项按 R5 归类，给登记名与归属步骤，是第 11 步 `state-manifest.ts` 的底稿；② 入口，R3 列的每一类在哪里建作用域、归哪一步；③ 渠道与出站路径，「渠道与出站路径」表逐行对上代码，按两类沙箱会话标自然不走、要显式挡、照企微走，表外的路径单列；④ console 的内部投影（`/status` 的 `channels`、`tenantSlug` 等）在沙箱里怎么处理。另列 02–04 在 DB 模式下的非锁定自测名单（第 11 步严格重跑用）。
  - 做：内存。沙箱进程还不存在，先用开工提交的镜像以 DB 模式、`LLM_MOCK=1`、不配企微与 `var/` 起一个进程，空闲 10 分钟记 RSS 作预估；服务器可用内存由 owner 给或授权只读查看（主机另记）。放不下就记「Open」，第 31 步之前由 owner 定；第 21、30 步用真的沙箱进程复测。
  - 做：记一句企微后台的官方提示「企业未认证，累计仅可接待100位客户」：spec 前置条件里的「约 100」由此确认为累计 100，不改 spec。00、01、02、03、04 与后台 UX spec 顶部按本 spec 文件头的条款清单补 `Superseded in part by:` / `Amended by:`，正文不动。
  - 验：共同门禁；只改文档。依赖：开工条件。
- [x] 2. 锁定断言的授权修改与 `/` 跳转（0.5 工程日，Claude）
  - 做：一个 PR、两个提交。提交一只改 `src/server.selftest.ts` 里开放问题 12 列的几行（1167–1168、1196–1197、1210、1211–1216），别的一字不动；提交二改 `src/server.ts`：`GET /` 在两种 profile、两种配置来源下都 302 到 `/console/`，删 `public/guide.html` 与静态兜底里的它，引用它的非锁定测试与注释一并改。登录页、`/try`、README 留给第 23 步。用 merge commit 合并（不 squash），授权的那个提交原样留在历史里。
  - 验：本步前后 `pnpm -s test:locked` 全绿；`/guide.html` 的大小写与编码写法在 prod、demo、demo 关模拟器下都 404（非锁定自测）；新的 sha256 记进「实施记录 · 第 1 步」作此后的基准；对开工提交 `git diff` 锁定文件只有那几行（验收 14 前半、验收 17 的 `/` 部分）。依赖：1。

### 多租户核心（第 3–11 步）

本段结束时，两个 standard 租户能在测试里同进程交错，严格模式下作用域外访问一律抛错；宿主进程线上照旧只有一个运行时。

- [x] 3. 迁移 0008：新列、沙箱表、四个函数与触发器（2 工程日，Claude）
  - 做：按「数据库」一次建齐：`tenants` 五列与 CHECK（带 `migration-allow` 注）、`public_host` 唯一索引、四张新表（`sandbox_process_epoch` 插 epoch 0）、四个 `SECURITY DEFINER` 函数、`channel_accounts` 的 `BEFORE INSERT` 触发器、授权与审计动作名，schema 与 meta 随之；`src/db/client.ts` 加 `withNewSandboxTenant`。迁移整份放在核心段开头：spec 只有一份 0008，第 8、10 步就要用 `public_host` 与软上限列；函数在这里只建与测，第 14、15、18 步才调。
  - 验：新自测（真实 PG）：各角色授权逐格；空 GUC 下 `agent_app` 读 `sandbox_wechat` 是 0 行；四个函数对 standard 一律报错、只取 `now()`；purge 只删已到期，删除清单覆盖系统目录里每张带 `tenant_id` 的表；resolve 的三种状态；create 的登录会话到期等于沙箱到期；触发器拒插（不变量 9、10；验收 9、11、16 ⑧ 的库层部分）。依赖：1。
- [x] 4. 平台命令 `tenant-host`、`tenant-budget`（0.5 工程日，可派 Codex）
  - 做：R7 的 `tenant-host set/clear`、`tenant-budget set/clear`（`agent_platform`、列级 UPDATE、审计 `tenant.host_*`、`tenant.budget_*`，下次启动生效）；R4 的 Host 规范化函数建在新文件 `src/tenancy/hosts.ts`，第 8 步在同一文件续写。
  - 验：真实 PG：带端口、末尾点、大写、IPv6 字面量规范化正确，非法值被拒；沙箱租户被 CHECK 拒；审计只记字段名。依赖：3。
- [x] 5. 状态清单检查脚本（1 工程日，可派 Codex）
  - 做：`scripts/check-tenant-state.ts` 与夹具自测，按 R5 默认拒绝；定下 `src/tenancy/state-manifest.ts` 的格式（键是「文件:标识符」），标成租户状态的要有同名登记（静态查 `registerTenantState` 的登记名）。本步只把夹具自测串进 `test`，不接 `lint`：清单要等第 6、7、9、10 步搬完，第 11 步接。
  - 验：夹具里的模块级数组、`new Map()`、事件发射器、有状态的类实例、加载时调一次的工厂闭包、`let` 都被点出位置；函数、类、import、原始类型常量、`as const`、`Object.freeze` 字面量放行；对开工提交跑一遍，点出的数与第 1 步清单 ① 对得上。依赖：1。
- [x] 6. 租户运行时、作用域与严格模式（3 工程日，Claude）
  - 做：`src/tenancy/runtime.ts`、`state.ts` 按「租户运行时」一次建齐全部字段（`budget`、`inflight`、`cancel` 先给最小实现，第 10、18、20 步填），此后各步只填实现、不改接口。严格与否按 R3 在启动时定；`TenantScopeMissing` 在 HTTP 回 500，后台入口记日志并推 `tenant_scope_missing`。宿主进程按 R2 装载（宿主加设了 `public_host` 的 standard 租户、`tenant_host_missing`、每个租户一把锁）。配置 `loaded`（`src/config/source.ts`）、行业包绑定（`src/core/pack-api.ts` 的 `bindPack(runtime, brand)` 与 `currentPack()`）、会话与订单 Map 及后端（`src/store.ts`）挂到运行时；清单 ② 的入口逐个建作用域，实例级定时器与监听用 `withoutTenantScope`；日志的租户取作用域。
  - 验：锁定套件与前缀照旧（文件模式只有一个运行时，回落）；严格模式下作用域外 `getSession`、`currentPack()`、`currentCatalog()` 抛错，后台入口缺作用域时不退出、日志一行、告警一条（验收 2 前半）。依赖：3。
- [x] 7. 进程内状态归运行时（2 工程日，Claude）
  - 做：清单 ① 里归本步的租户状态挂到运行时或键带 `tenantId`，并登记 `keyCount`、`drop`、`reset`：接管代次与回复去重、发送账本、洞察 / 建议 / 草稿缓存（留好落地前核对运行时状态的钩子，第 18 步用）、运行数字（去掉「拒绝非当前租户」）、隐私说明与轮询（宿主进程逐个 standard 租户）、引擎会话串行链、语义索引的共享缓存（缓存文件只在宿主）、OTel 的租户；`eval/v2/isolation.ts` 改调登记表的 `reset()`。
  - 验：共同门禁；每个登记项的 `keyCount`、`drop` 有自测。依赖：6。
- [x] 8. 公开路由按 Host 解析（1.5 工程日，可派 Codex，安全相关由 Claude 审）
  - 做：R4 与「公开路由」表的宿主列：`hosts.ts` 的解析与中间件；订单、支付页、方案书、隐私说明、模拟器、网页入口、企微回调、console 登录各在解析出的租户里找；`accountByKey` 加租户参数；旧接口与作战室只给宿主；绝对链接按租户拼，宿主 `PUBLIC_BASE_URL` 与 `public_host` 主机名不同就拒绝启动。
  - 验：验收 3 的进程内部分（单 standard 任何 Host 都是它、多个时未知 Host 404、缺 `public_host` 以 `tenant_host_missing` 拒绝启动）。依赖：4、6。
- [x] 9. 事件、渠道、任务与 spill 按租户（2 工程日，Claude）
  - 做：R6：领域事件带 `tenantId`；每个运行时一个 console 事件环、序号、listener 与计数去抖；`storeEvents` 按运行时分开；模拟器与网页 SSE 按（租户，会话）建键；渠道注册表装已装载 standard 租户的账号，`pushRoute` 只在会话所属租户的账号里匹配；任务 runner 每拍逐个 standard 租户认领，跟进与通知的键带租户；spill 按租户回放。
  - 验：两个 standard 租户下 SSE 与 console 事件互不可见、任务各认各的、spill 各回各的；03 的渠道、恢复与 spill 自测照绿。依赖：6（与第 7 步改的文件不重叠，有第二个 Claude worktree 时可并行）。
- [x] 10. 用量按租户记账（1 工程日，可派 Codex）
  - 做：R15 的记账与 standard 部分：`usage_daily` 累加器按（租户、日、模型、用途）建键、每租户一个 writer；`src/tenancy/budget.ts` 的 `TenantBudget` 与 standard 实现（恒返回只记账的 `Reservation`）；`src/llm-gate.ts` 每次 fetch 之前经作用域调 `reserve`；`usage.json`、`/api/usage`、`budget.json` 只管宿主；`llm_daily_alert_milli` 当天越过告警一次。
  - 验：验收 7 的 standard 部分（只告警一次、不降级、作战室口径不变）。依赖：6。
- [x] 11. 清单接入 lint 与两个 standard 租户的隔离套件（2 工程日，Claude）
  - 做：按第 1 步清单写全 `state-manifest.ts`，`check-tenant-state` 接进 `pnpm lint`；`src/tenancy/isolation.selftest.ts` 的两个 standard 租户部分（R17 的 A、B，假模型记 system 与 tools 字节，B 的响应晚到）；`test` 末尾加 `TENANCY_STRICT=1` 重跑第 1 步列的 02–04 DB 模式非锁定自测（放进 `test`，CI 全量跑；本机按改动文件列清单，只跑受影响的自测）。
  - 验：验收 1；验收 2 的清单与严格重跑部分（在隔离副本里往 `src/` 某模块顶层加一个不进清单的数组或 `new Map()`，`pnpm lint` 失败，补上后通过）；验收 3 的路由表逐行（两个租户各设 `public_host`）。真实 PG 部分带 `PG_TEST_URL`。依赖：5、7–10。

### 沙箱（第 12–22 步）

本段做不带微信的沙箱：体验客服不配，只有模拟器。

- [x] 12. 沙箱进程：角色、启动检查与进程锁（2 工程日，Claude）
  - 做：`src/tenancy/sandbox/role.ts`：`APP_ROLE`、R16 的全部启动检查与强制开关，基线开关日志行不变、角色与生效值另打一行；R2 的进程锁（至多等 30 秒、`sandbox_already_running`）、epoch、锁丢了 fail-stop（绕开 `gracefulExit`）、fencing 的事务工具；只装沙箱、只答 `SANDBOX_HOST`（别的 Host 只有 `/healthz`）；不挂 `var/`、不写 spill（停机排空，10 秒后丢弃并记条数）；不起注册表、任务 runner 与 `kf-main`；`LLM_MAX_INFLIGHT`、不设对冲；R19 的两个 `/healthz`（宿主加 `role`，多 standard 时 `ok` 并入其余租户；沙箱的 `wecom` 先恒为未配）。
  - 验：验收 6 的启动拒绝部分（含体验客服变量的三种拒绝）；验收 10 的角色、第二个进程被拒、`pg_terminate_backend` 之后 fail-stop 与 epoch 两种先后（先用一个受 fencing 的测试写代替绑定事务，第 27 步用绑定复验）、`var/` 没有新文件、停机丢弃有条数。真实 PG。依赖：11。
- [x] 13. 沙箱种子文件（0.75 工程日，可派 Codex）
  - 做：`scripts/seed-demo.py --fixture` 生成 `data/sandbox-seeds.json`（默认场景，时间存相对值）；`src/tenancy/seed-fixture.selftest.ts` 串进 `test`；`.github/workflows/ci.yml` 在四个门禁之外加一步：重新生成，与仓库里的不同就失败（本步独占 `ci.yml`）。
  - 验：验收 14 的种子部分（13 个会话、3 个订单、引用对得上、线路 id 都在 `data/routes.json`、时间是相对值；四个门禁不依赖 python3）。依赖：1。
- [x] 14. 从模板开通与装载（2 工程日，Claude）
  - 做：R8、R9 与「开通与删除」的开通部分（路由与 cookie 在第 15 步）：只读、可重复读的事务读宿主已发布快照；一个事务里 `sandbox_tenant_create` → `withNewSandboxTenant` → 复用 `src/config/transfer.ts` 与 `src/cli/session-transfer.ts` 写配置、隐私说明、快捷回复、种子（新 `sbx-` id、`simulator`、时间平移）与 `sandbox_wechat` 行（链接令牌）→ 审计 `sandbox.create`；提交后按启动的同一条路径装载、取锁、登记，失败就 `sandbox_tenant_expire` 并回 503；开通在进程内串行，R14 的判定点先留空（第 19、20 步填）；启动时装载未到期的沙箱。
  - 验：验收 4 中 p95 与 cookie 复用之外的全部；沙箱进程重启后活着的沙箱还在（验收 10 前半）。真实 PG。依赖：12、13。
- [x] 15. 免密会话、沙箱路由与写保护（2 工程日，Claude）
  - 做：R10 与「公开路由」表的沙箱列（体验客服回调与 `/wx/` 除外）：开通响应签发 `__Host-sbx`；`sandbox_session_resolve` 的三种结果对应 410 / 401 两套返回并清 cookie；`POST /api/sandbox`（同源、JSON、有效 cookie 复用）、`POST /api/sandbox/end`、沙箱 Host 的 `/`；console 在沙箱上没有口令登录、不读 `__Host-sid`（宿主不读 `__Host-sbx`），`x-csrf` 由 token 派生，`Me.sandbox`（`wechat` 先恒为 `off`，`steps` 由服务端按沙箱自己的数据算），清单 ④ 的投影；模拟器把 `sim-<x>` 对照成 `sbx-<x>`、认 `?c=<id>`、刷新恢复历史；所有非安全方法过 `isCrossSite`；记最近访问（闲置回收在第 18 步）；脱敏正则认 `sbx-`。
  - 验：验收 11 中页面 XSS 之外的全部；验收 4 的 cookie 复用；验收 5 的后端部分。依赖：14。
- [x] 16. `/try` 页面与沙箱页面的 CSP（1 工程日，可派 Codex）
  - 做：`public/try.html`（照「界面 · `/try`」：说明、开通进度、被限额拒绝时给宿主只读工作台与网页模拟器两个入口、出错重试、`?ended=1` 的提示；只有 POST 开通）；沙箱进程页面的 CSP（`chat.html`、`pay.html`、`proposal.html` 的内联脚本按 hash 或 nonce 放行，不许外部来源）；沙箱模拟器的顶部提示。改 `chat.html` 时锁定 `server.selftest.ts` 对它源码的几项检查照旧通过。
  - 验：验收 11 的 XSS 一句（支付页、方案书、模拟器当文本显示，响应带 CSP）；沙箱 Host 上 `GET /try` 不开通（验收 17 的一句）。依赖：15。
- [x] 17. 结构性的出站挡板（1 工程日，可派 Codex，Claude 审）
  - 做：R11 中与体验客服无关的部分：沙箱的 `TenantStore.queueJobs` 丢弃任务操作；`noteUnsaved` / `onHandoffUnsaved` 按租户跳过沙箱；宿主进程的企微 `pushRoute` 与 `push` 拒绝沙箱租户的会话（DB 与 env 两条分支）；`adapterFor` 对沙箱租户只返回模拟器适配器（体验客服的第 26 步加）；只关乎某个沙箱的告警只记日志；照清单 ③ 逐行补测。
  - 验：验收 6 中不配体验客服的那一半（企微 API、两个 webhook、OTLP 换成记录器，最早的种子会话接手回复、无 SSE 时回复、一次落库失败、advisor 建单、一次转人工、一次进程级告警；种子与模拟器会话 0 个企微请求，群通知 0、OTLP 0，沙箱 `jobs` 与 `channel_accounts` 0 行，没有 poisoned，插 `channel_accounts` 被触发器拒）。依赖：15。
- [x] 18. 到期删除、reaper 与运维命令（2.5 工程日，Claude）
  - 做：R12、R13：reaper 每分钟（实例级定时器，逐个沙箱进作用域）走 ① 到 ⑥，没成就停在原地、下一分钟重来；运行时的取消信号与在途登记（模型与 embedding 请求、配置写事务、写队列的数据库操作；签码与绑定事务第 27 步登记），promise 落定才算结束，迟到的结果落地前核对运行时状态；先刷用量、再关后端；purge 事务的锁与语句超时；⑥ 摘运行时、逐项 `drop`、放锁；启动时先删到期的；闲置回收；「结束体验」；`src/cli/sandbox.ts` 的 `list`、`end`、`purge --all`（拿不到锁以 3 退出）；`sandbox_purge` 告警、`/healthz.purgeOverdue`、删除日志一行。
  - 验：验收 9 中与微信无关的全部（30 秒还没返回的模型请求、被另一条连接的行锁挂住的配置写事务、用量写入失败、purge 锁超时、删除事务中途杀进程、「结束体验」与闲置）；不变量 7 以超级用户按系统目录数行；验收 10 的三个命令。真实 PG。依赖：15。
- [x] 19. 限额与写入上限（1.5 工程日，可派 Codex）
  - 做：R14：开通在锁里判的各项（每 IP 按 IPv4 地址、IPv6 /64）、每个沙箱的新会话数与 SSE 至多 10 条、写入的六项上限与 `sandbox_write_limited`、模型降级之后写额度照计；数值取 env（「环境变量」表、开放问题 8）。只改 `src/tenancy/sandbox/limits.ts` 与第 14、15 步留的判定点。
  - 验：验收 8 的上限部分，每项各验一次（含同一 /64 的两个 IPv6 地址）。依赖：15。
- [x] 20. 沙箱预算预占（1.5 工程日，Claude）
  - 做：R15 的沙箱部分与「预算」：尝试层同步预占本沙箱与全池（预占值的估算、未知价格按最贵价），按实际用量结算或按预占值记；对话降级 mock（`outcome = 'budget'`，与宿主 `sim-` 的访客预算走同一个 `forceMock`），洞察、建议、草稿回 429，索引不重建；还没落库的用量超过 60 秒全停；重启读回已花数与池的当天数（含已到期还没删的沙箱）；首次建索引记在池上；`sandbox_pool` 告警；开通的池判定接进第 19 步的判定点。
  - 验：验收 7 的沙箱部分。真实 PG、假模型（先回 500 再回 200）。依赖：18、19。
- [x] 21. 沙箱进程的隔离套件与压测（1.5 工程日，Claude；压测脚本可派 Codex）
  - 做：`isolation.selftest.ts` 的沙箱进程部分：从 0 个运行时开通到 2 个、交错对话、删到 1 个再到 0 个，全程严格，覆盖提交失败通知、写队列重试、SSE 复核、索引重试与停机钩子；`scripts/load/` 加一组（不进 `test`）：20 个沙箱各连发 5 轮、一个沙箱按写上限连续写，宿主同时跑基线负载，有无沙箱各 3 遍取中位数。
  - 验：验收 2 的沙箱部分；验收 8 的压测（宿主每轮排队中位数多不超过 1 秒、写库积压不超过 2 秒，沙箱进程空闲与 20 个沙箱时的 RSS）；验收 4 的开通 p95（20 次，真实 PG）。依赖：17、20。
- [x] 22. compose、`deploy.sh`、`watch.sh` 与回滚检查（2 工程日，可派 Codex，Claude 审）
  - 做：`deploy/compose.yml` 加 `sandbox` 服务（profile `sandbox`、`APP_ROLE=sandbox`、`../.env.sandbox`、宿主端口另取且只绑 127.0.0.1、不挂 `var/`），文件头写明只重建沙箱的手工命令（带 `--profile sandbox`、`--no-deps`）；`deploy.sh` 照 R20：第 5 步试读 `.env.sandbox`，第 7 步先宿主后沙箱（沙箱 90 秒，失败只删沙箱容器并以 1 退出），`pre-05` 判定，自动回滚到 pre-05 前先删容器、改名；`deploy/rollback-guard.sh` 照 R18 的三项与退出码 7（同时有品牌风险先报 6）；`deploy/watch.sh` 有 `.env.sandbox` 时另拨沙箱的 `/healthz`。
  - 验：`ops.selftest.ts`、`rollback-guard.selftest.ts` 用假 `docker`、`psql` 与 `bash -s` 覆盖验收 13 ①–④、验收 15 ①–⑥ 的分支；真实 docker 在第 30 步。依赖：12、18。

### 主站入口与体验界面（第 23–24 步）

- [x] 23. 主站入口（1.5 工程日，可派 Codex）
  - 做：R23 除第 2 步之外的部分：宿主 `/try`（demo 且配了 `SANDBOX_HOST` 时 302，否则 404）、`GET /api/console/entry`；登录页的「免登录体验」次级按钮与「只看演示数据」文字链接，demo 匿名先到登录页，外壳里的「登录」回登录页，去掉「返回演示」；prod 是纯登录页；分享卡片（登录页标题上方一张真实可见的产品图，`<title>` 是产品名）；README 在线体验表的「引导页」一行、第 319、454 行，引导页「它是怎么工作的」一节从开工提交的 `public/guide.html` 取出挪进 README。
  - 验：验收 17 中可自动化的部分（三种 profile 组合、按钮出现的条件、`/try` 的跳转）与验收 12 的「只看演示数据」；console 登录页与外壳的自测随之改（非锁定）。依赖：2（可与核心段并行；`src/server.ts` 只加 `/try` 一个路由，尽早合）。
- [x] 24. 沙箱 console 的横幅与体验清单（1.5 工程日，可派 Codex）
  - 做：照「界面 · 沙箱 console」：横幅（剩余时间；没配体验客服时写「只进模拟器」）、「打开模拟器」「结束体验」、会话详情的「在模拟器里打开」（只对 `sbx-`）、沙箱上不显示登录页、`/me` 回 401 时跳 `/try`、`sandbox_write_limited` 与 `llm_budget_exhausted` 的提示（按 spec 的错误码，不等第 19、20 步）、右侧体验清单（第一步先是模拟器版；收起状态按沙箱记在浏览器里，读写包 try/catch）、`Me.sandbox` 的类型。
  - 验：console 自测覆盖加载、空、错误三态与清单四步的完成判定；验收 5 的工作台一侧。依赖：15、23。

### 微信：体验客服（第 25–29 步）

体验客服没配时沙箱照常工作，前面各步都不依赖本段；本段的代码随第 31 步一起上线，第 32 步再在企微后台接上。

企微后台现状（2026-10-11 owner 与协调者实测）：已建客服账号「云途定制旅行·体验」（暂为人工接待、未交给 API）与自建应用「体验客服接入」（可见范围只有 owner，未配回调、可信 IP、API 权限）；「可调用接口的应用」是复选框多选，「企业内部开发」是「应用 → 可管理的客服账号」表，界面上支持多应用各管各的账号。卡点：没配可信 IP 的应用拿不到微信客服 API 权限，配可信 IP 之前必须先配可信域名或接收消息的服务器 URL。所以回调路由要在拿到体验客服的 Secret 之前就上线并通过 URL 校验（echostr），它与 R16「五个变量全有或全无」之间的空当见「Open」第 1 条。

- [x] 25. 体验客服运行时与收件（2 工程日，Claude）
  - 做：R21 的第三种运行时与收件（`src/adapters/wecom.ts`、`src/tenancy/sandbox/wecom.ts`），env 与 03 两种运行时的行为一字不变；五个变量配齐才挂不带 key 的 `/wecom/callback`，GET 的 URL 校验只用 Token、EncodingAESKey、CorpID，不依赖 access_token 与客服链接；POST 触发串行的 `kf/sync_msg`，cursor 存 `sandbox_wecom_state`、每页先提交（核 epoch）再派发，没有 cursor 只认启动前 10 分钟之后的；按绑定表找沙箱（本步表恒空，一律当未绑定）→ R22 的固定话术与限频；启动经 `kf/add_contact_way` 取客服链接、只放内存，取不到时照「Open」第 1 条的裁决；`/healthz.wecom` 的 `configured`、`lastSyncOkAt`、`failing`，持续失败 10 分钟推 `channel` 告警（账号 key `sandbox`）。
  - 验：锁定 `wecom.selftest.ts` 与 `wecom-02`、`wecom-03` 自测照绿；假企微：签名错被拒，`gettoken` 一律失败时用测试密钥签的 echostr 照样回明文；没配时回调 404（验收 16 ⑩ 前半）；未绑定的人连发三条只回第一条、没有模型请求、任何租户的库里没有他（验收 16 ⑤ 前半）。依赖：17、owner 对「Open」第 1 条的确认。
- [x] 26. 出站汇点、链接令牌与 `/wx/`（2 工程日，Claude）
  - 做：R21 的出站与 R11 的汇点核对：走 02 的发送与账本（`outbound_sends.account_id` 为空，停机时没结果的段记 `unknown`，不补发）；`callApi` 与 `postSendMsg` 在 `fetch` 之前同步核对 `open_kfid`、`touser`、welcome_code 表与作用域外的固定话术，覆盖每次重试与 token 强刷之后的重发，不符就记失败并推 `sandbox_send_refused`；回执的 msgid → 沙箱表；`adapterFor` 与沙箱进程的 `pushRoute` 对沙箱的 `wecom:` 会话返回体验客服；请求体里的链接改写（卡片 URL 含 `extractCard` 重建的、正文、卡片失败后的补文、欢迎语里的隐私链接）；`GET /wx/:token/*`、`__Host-sbxw`、只开三类页面与它们的接口、两个响应头；两种 profile 下日志遮盖令牌，不进审计与 `/healthz`。
  - 验：验收 16 ②、⑨；验收 6 的故意违规中不需要真实绑定的几条（`open_kfid` 换值、作用域外的非固定话术、不在表里或属于另一个沙箱的 welcome_code）；需要绑定的用测试钩子直接发布，第 29 步用真实绑定复验。依赖：25。
- [x] 27. 绑定、改绑与名额（2.5 工程日，Claude）
  - 做：R22 全部：`POST /api/sandbox/wechat/code`；进程内三张解析表在拿到 epoch 之后从各沙箱的 `sandbox_wechat` 重建，全部装完才起体验客服运行时；签码、绑定、解绑过同一把互斥锁，照 R22 的发布顺序与失败恢复，发布与恢复前复核 `serving`；扫码（`scene_param`）主路径与手打码备用；后绑的赢、旧会话留作历史；绑定欢迎语与 welcome_code 关联的填写时点；签码与绑定事务进第 18 步的在途登记；名额已满（95003）的置位、入库、重读、新签码 409、不再回话术、`sandbox_wecom_full` 告警与 `sandbox wecom-reset-full`；`Me.sandbox.wechat` 的四种状态与 3 分钟提示的条件。
  - 验：验收 16 ①、③–⑧、⑩ 的后端部分；验收 9 的绑定部分（绑定事务挂住时到期或点「结束体验」）；用绑定事务复验验收 10 的 epoch 两种先后；不变量 18、22。真实 PG、假企微。依赖：18、26。
- [x] 28. 体验清单的微信部分（1 工程日，可派 Codex）
  - 做：照「界面 · 沙箱 console」体验清单的第一步：二维码（新增一个 MIT 的二维码库，钉精确版本，只在浏览器里生成）与 `XXXX-XXXX`、窄屏「在微信里打开」、过期自动换新、取码失败重试、「已连上你的微信」与「换一个微信」、3 分钟提示、名额已满与没配时换成模拟器；绑定微信的会话显示窗口、剩余条数、送达状态与「这个微信已不再连着这次体验」；横幅文字随状态。
  - 验：console 自测覆盖 `wechat` 四种状态各自的三态；验收 16 ①、③、⑩ 的界面一侧。依赖：24、27。
- [x] 29. 微信段全程套件与对抗评审（1 工程日，Claude；另派一路只读 Codex 对整段做对抗评审）
  - 做：用假企微把验收 16 ①–⑩ 与验收 6 的完整版（含三段回复发出第一段后改绑、假企微先回 42001 而 token 强刷期间改绑、在 A 的作用域里发给 B 绑定的微信）串成一个全程套件。评审重点：汇点核对与 `fetch` 之间有没有 `await`、在途登记是否覆盖签码与绑定、`closing` 之后有没有迟到的发布、日志里搜不搜得到令牌。
  - 验：验收 6、16 ①–⑩ 全部通过；评审结论与改动记进实施记录。依赖：27、28。

### 演练、上线与收尾（第 30–35 步）

- [x] 30. 本机部署与演练（2 工程日，Claude）
  - 做：隔离 compose 项目（`NAME`、`REMOTE_DIR`、`HOST_PORT` 三个都换）、一次性真实 PG、假企微、假 ssh，跑真的 `deploy.sh`：先部署 `demo-v5` 作上一版 → 放 `.env.sandbox`、部署 05 的候选 tag → 验收 15 ①–⑥ → 验收 13 ①–⑥ → `docker compose stop sandbox` 宿主不受影响、再起一个沙箱进程被拒、终止锁连接（验收 10 的容器部分）→ 浏览器走一遍（登录页的三种状态、免登录体验 → `/try` → 工作台、体验清单的模拟器版与假企微扫码版、XSS 那一句）→ 预演第 32 步的顺序：Secret 与 OPEN_KFID 放占位值时 echostr 校验能过、清单退回模拟器，换成有效值后能签码 → 真的沙箱进程空闲与 20 个沙箱时的 RSS、容器里的开通 p95 → 宿主的 04 验收 14 那一组。
  - 验：结果记进实施记录与验收记录（验收 4、8、10、12、13、15 的本机部分）；结束删除本次容器、卷、镜像、临时 tag 与浏览器，不碰线上与别的项目。依赖：1–29。
- [ ] 31. 线上 · 宿主与沙箱上线，体验客服先不配（0.5 工程日，Claude；owner 执行或当次授权代办）
  - 做：「上线清单」里第 31 步之前的各项齐了才开始。dev 上打本地 tag（如 `demo-v6-rc1`，不推）；每次部署前手动备份并复制到异地。同一个 tag 分两次部署：① 服务器上先不放 `.env.sandbox`，核对宿主 `revision`、`role: host`、四个哈希与第 1 步相同，`/` 跳 `/console/`、`/guide.html` 404，owner 用测试微信给 `kf-main` 发一句、一句一回；② 放 `.env.sandbox`（不带 `SANDBOX_WECOM_*`）、宿主 `.env` 加 `SANDBOX_HOST` 后再部署，沙箱 `/healthz` 的 `revision` 对、`role: sandbox`；从登录页「免登录体验」开一个沙箱，用模拟器走完体验清单（真实模型，约 0.5 元）；经真实反向代理核对两个站点收到的 Host 原样、`clientKey()` 取到访客的真实地址；`watch.sh` 拨得到沙箱。
  - 验：验收 3、12 的线上部分与验收 5 的线上冒烟；不敏感的证据记进验收记录，主机与路径另记。依赖：30、owner 的线上授权与花费确认。
- [ ] 32. 线上 · 体验客服接入（0.5 工程日；企微后台由 owner 登录、协调者用 Playwright 操作，服务器操作要 owner 当次授权）
  - 做，按序，任何一步不符就停下报告 owner：
    1. 服务器上随机生成 Token 与 EncodingAESKey（不打印），连同 CorpID 写进 `.env.sandbox`，Secret 与 OPEN_KFID 先放占位值（照「Open」第 1 条）；只重建沙箱服务；`/healthz.wecom` 的 `configured`、`failing` 都为真，沙箱 Host 的 `/wecom/callback` 不再是 404。
    2. 应用「体验客服接入」填接收消息的服务器 URL `https://<沙箱 Host>/wecom/callback` 与 Token、EncodingAESKey；保存时企微当场校验，过了才往下。
    3. 可信 IP 填服务器的出口 IP。
    4. 「微信客服 → API → 可调用接口的应用」勾上它，宿主原来那个应用照旧勾着。
    5. 「企业内部开发」表里给它指定体验客服，核对 `kf-main` 那一行不变。
    6. 取 Secret 写进 `.env.sandbox`，用它调 `kf/account/list` 找到体验客服的 open_kfid 换掉占位值（顺带记列表里有没有 `kf-main`），重建沙箱服务，`failing` 变假。
    7. 在服务器上用体验客服的凭据对 `kf-main` 的 open_kfid 调一次 `kf/sync_msg`，预期 48007。不是 48007 就停：删掉 `.env.sandbox` 里的五个变量、重建沙箱服务、后台取消这个应用的 API 权限，交 owner 按开放问题 9 的 B 另注册企业。是 48007 时，owner 再给 `kf-main` 发一句：宿主一句一回，沙箱日志里没有这条回调。
    8. 后台查已用名额，记数字；离 100 不远时交 owner 定。
    9. 真手机扫码走完体验清单四步（真实模型，约 0.5 元）；在微信里分享登录页，卡片截图；`kf-main` 再自检一次。
  - 验：验收 16 ⑪、验收 17 的真机部分、spec 前置条件的两项实测记进验收记录；凭据、open_kfid、客服链接与二维码不进仓库与本文件。依赖：31。
- [ ] 33. 对照当前全部验收标准逐条验证（1 工程日，Claude）
  - 验收 1–17 逐条填通过 / 未通过与证据；对开工提交 `git diff` 锁定文件，只有第 2 步那个提交的几行；未通过与偏离交 owner 裁决，不靠改锁定套件收尾。依赖：32。
- [ ] 34. 清理临时探针与测试（0.25 工程日，Claude）
  - 只留耐久回归；删 Codex 的 worktree 与已合并分支、一次性 PG 容器与卷、演练项目、隔离副本、临时 tag 与浏览器；线上验收开的沙箱用 `sandbox end` 结束、由 reaper 删；不删他人资源，结果记进本文件。依赖：33。
- [ ] 35. owner 确认后更新 Status（0.25 工程日，Claude）
  - owner 明确确认后 spec 改 `Status: implemented`；核对第 1 步补的反向引用与 ADR-002、master-reference 里的注；未获确认只报告结果，停在本步。之后照 03、04 发版：release 分支 → main、打 `demo-v6`，owner 说换后手动备份、`deploy.sh demo-v6`。依赖：34、owner 确认。

## 验收映射

本阶段不改 SOP、提示词与模型，宿主四个哈希不变，不跑付费评测。花真实模型钱的只有第 31、32 步的线上体验，预计合计约 1 元，记在沙箱自己的额度与池上限之内；第 31 步之前 owner 点头（含上线后沙箱每天至多 10 元的池上限）。其余全用本机假模型。

| 验收                  | 在哪几步验                                     | 需要                                           |
| --------------------- | ---------------------------------------------- | ---------------------------------------------- |
| 1 进程内隔离          | 11                                             | PGlite、假模型；RLS 部分真实 PG（CI 必跑）     |
| 2 作用域与清单        | 6、11（lint 反证、严格重跑）、21（沙箱 0→2→0） | 隔离副本、真实 PG                              |
| 3 公开路由与 Host     | 4、8、11、12；线上 31                          | 线上真实反向代理                               |
| 4 开通                | 14、15；p95 在 21 与 30                        | 真实 PG；容器里再量一次                        |
| 5 工作台全程          | 15、24；浏览器 30；线上冒烟 31                 | 假模型；线上真实模型约 0.5 元                  |
| 6 只发给访客自己      | 12、17、26、29                                 | 假企微、webhook 与 OTLP 记录器                 |
| 7 预算                | 10、20                                         | 真实 PG、假模型                                |
| 8 限额与写入上限      | 19、21；RSS 在 30 再测                         | 真实 PG、两个进程、假模型                      |
| 9 到期删除            | 18、27                                         | 真实 PG（超级用户数行、跨连接行锁、杀进程）    |
| 10 重启与角色         | 12、14、18、27；容器部分 30                    | 真实 PG、真实 docker                           |
| 11 会话与安全         | 3、15、16；浏览器 30                           | 真实 PG                                        |
| 12 demo 照常          | 2、23；本机 30；线上 31                        | owner 的测试微信（`kf-main`）                  |
| 13 回滚检查           | 22（假 docker）、30（真实 docker）             | 真实 docker、`demo-v5` 镜像                    |
| 14 锁定与门禁         | 1、2、13、每一步、33                           | CI 里种子重新生成那一步                        |
| 15 两个服务的部署     | 22、30                                         | 真实 docker                                    |
| 16 扫码绑定与微信全程 | 25–29（①–⑩）、32（⑪）                          | 假企微、真实 PG；线上真手机，真实模型约 0.5 元 |
| 17 主站入口           | 2、16、23；浏览器 30；真机分享 32              | 真手机微信                                     |

## 工作量、依赖与并行

合计约 **50.25 个工程日**：开工 1.5 个，多租户核心 15 个，沙箱 17.75 个，主站入口与体验界面 3 个，微信段 8.5 个，演练、上线与收尾 4.5 个。owner 裁决、线上授权与企微后台操作的等待不算工程日。

| 步骤                | 工程日 | 依赖（合并后再开）     | 建议执行者            |
| ------------------- | -----: | ---------------------- | --------------------- |
| 1 核对与清单        |      1 | 开工条件               | Claude                |
| 2 锁定断言与 `/`    |    0.5 | 1                      | Claude                |
| 3 迁移 0008         |      2 | 1                      | Claude                |
| 4 平台命令          |    0.5 | 3                      | 可派 Codex            |
| 5 清单检查脚本      |      1 | 1                      | 可派 Codex            |
| 6 运行时与作用域    |      3 | 3                      | Claude                |
| 7 状态归运行时      |      2 | 6                      | Claude                |
| 8 Host 解析         |    1.5 | 4、6                   | 可派 Codex，Claude 审 |
| 9 事件与渠道        |      2 | 6                      | Claude                |
| 10 用量记账         |      1 | 6                      | 可派 Codex            |
| 11 lint 与 A/B 套件 |      2 | 5、7–10                | Claude                |
| 12 沙箱角色         |      2 | 11                     | Claude                |
| 13 种子文件         |   0.75 | 1                      | 可派 Codex            |
| 14 开通             |      2 | 12、13                 | Claude                |
| 15 会话与路由       |      2 | 14                     | Claude                |
| 16 页面与 CSP       |      1 | 15                     | 可派 Codex            |
| 17 出站挡板         |      1 | 15                     | 可派 Codex，Claude 审 |
| 18 到期删除         |    2.5 | 15                     | Claude                |
| 19 限额             |    1.5 | 15                     | 可派 Codex            |
| 20 预算预占         |    1.5 | 18、19                 | Claude                |
| 21 沙箱套件与压测   |    1.5 | 17、20                 | Claude                |
| 22 部署与回滚检查   |      2 | 12、18                 | 可派 Codex，Claude 审 |
| 23 主站入口         |    1.5 | 2                      | 可派 Codex            |
| 24 沙箱 console     |    1.5 | 15、23                 | 可派 Codex            |
| 25 体验客服收件     |      2 | 17、「Open」第 1 条    | Claude                |
| 26 汇点与 `/wx/`    |      2 | 25                     | Claude                |
| 27 绑定与名额       |    2.5 | 18、26                 | Claude                |
| 28 清单的微信部分   |      1 | 24、27                 | 可派 Codex            |
| 29 微信全程套件     |      1 | 27、28                 | Claude                |
| 30 本机演练         |      2 | 1–29                   | Claude                |
| 31 线上上线         |    0.5 | 30、线上授权、花费确认 | Claude                |
| 32 体验客服接入     |    0.5 | 31                     | owner + 协调者        |
| 33 逐条验收         |      1 | 32                     | Claude                |
| 34 清理             |   0.25 | 33                     | Claude                |
| 35 Status           |   0.25 | 34、owner 确认         | Claude                |

可派 Codex 合计 14.25 工程日（4、5、8、10、13、16、17、19、22、23、24、28）；Claude 那一列 36 个，只有一条 Claude 主线时日历约 36 个工作日加 owner 的线上等待。并行缩短日历时间，不减少工程日：

| 批次   | Claude 主线                 | 另一个 worktree（可派 Codex）                | 文件边界                                                                                                                                                               |
| ------ | --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开工   | 1 → 2                       | 13（1 合并后）、23（2 合并后）               | 13：`scripts/seed-demo.py`、`data/sandbox-seeds.json`、`ci.yml`；23：console 登录页与外壳、`console-api/app.ts` 的 entry、`server.ts` 只加 `/try`、README              |
| 核心一 | 3 → 6                       | 5（1 合并后）、4（3 合并后）                 | 5：`scripts/check-tenant-state*` 与清单的格式；4：`src/cli/` 与 `hosts.ts` 的规范化函数                                                                                |
| 核心二 | 7 → 9 → 11                  | 8、10（6 合并后）                            | 8：`hosts.ts`、公开路由、`channels/accounts.ts`、`auth/session.ts`；10：`usage-daily.ts`、`llm-gate.ts`、`tenancy/budget.ts`、`usage.ts`、`budget.ts`；7、9 不碰这两组 |
| 沙箱一 | 12 → 14 → 15                | —                                            | 启动路径与运行时，串行                                                                                                                                                 |
| 沙箱二 | 18 → 20 → 21                | 16、17、19、24（15 合并后），22（18 合并后） | 16：`public/`；17：`queueJobs`、`notify/handoff.ts`、`wecom.ts` 的拒绝分支；19：`sandbox/limits.ts` 与判定点；22：`deploy*` 与两份运维自测；24：`console/`             |
| 微信   | 25 → 26 → 27 → 29           | 28（27 合并后）                              | 28 只改 `console/`                                                                                                                                                     |
| 收尾   | 30 → 31 → 32 → 33 → 34 → 35 | —                                            | 线上与 owner                                                                                                                                                           |

共享文件只由下列步骤改，按依赖串行合并：

- `package.json`：各步只在 `test` 末尾追加自己的自测，合并时手工合；`lint` 只由第 11 步改。`.github/workflows/ci.yml` 的第 13 步种子一致性检查已随 #199 入 CI；后续 CI 分片按 [CI 分片 spec](../ci-shards/spec.md) 维护。
- `src/tenancy/runtime.ts` 的接口由第 6 步一次建齐，之后各步只填实现；`src/core/pack-api.ts` 只由第 6 步改。
- `src/server.ts`：2 → 23（只加 `/try`，先合）→ 6 → 8 → 12 → 15；Codex 步骤碰它要等前一步合并后 rebase。
- `src/adapters/wecom.ts`：9（`pushRoute` 按租户）→ 17（拒绝沙箱会话）→ 25 → 26，同一时间只开一个。`src/store.ts`：17 只改 `queueJobs`，先于 18 合。
- `src/llm-gate.ts`：10（`reserve` 挂点）→ 18（取消与在途）→ 20（预占）。`console/src/`：23 → 24 → 28。
- 第 25–27 步改同一片体验客服与绑定代码，只能串行。

要砍就砍微信段（第 25–29、32 步，约 9 个工程日）：体验客服不配时沙箱照常只有模拟器（R21），但验收 16 与目标 5 的「自己的微信就是客户」随之落空，spec 要记 `Revisions:`，只有 owner 能定。其余各段互相依赖，不能单独砍。

## 上线清单

第 30–32 步的演练、上线与体验客服接入是本 spec 的完成条件。下面是仓库外要做的事，标谁做、什么时候；域名、IP、主机、凭据另记。

- [x] 服务器内存放得下宿主加沙箱进程（第 1 步预估，第 21、30 步实测）。协调者核对、owner 定；第 31 步前。
- [x] 沙箱 Host 的 DNS 与证书。owner；第 31 步前。
- [x] 反向代理加沙箱站点块，指向沙箱的宿主端口（只绑 127.0.0.1）；两个站点块都原样转发 Host、不写 `header_up Host`，主站块别的不动。owner（协调者可代拟配置）；第 31 步前。
- [ ] 外部拨测加沙箱 Host 的 `/healthz`（顺带盯证书续期）；原来拨 `/guide.html` 的改拨 `/healthz`。owner；第 31 步。
- [x] 花费点头：上线后沙箱每天至多 10 元（池上限，开放问题 8），验收约 1 元。owner；第 31 步前。
- [ ] 服务器上写 `.env.sandbox`：`DEPLOY_PROFILE=demo`、`CONFIG_SOURCE=db`、`SESSION_STORE=db`、`agent_app` 的 `DATABASE_URL`、`SANDBOX_HOST`、`SANDBOX_TEMPLATE_SLUG`、模型与 embedding 的 key、`LLM_MAX_INFLIGHT=2`、`ALERT_WEBHOOK_URL`、`INSTANCE_LABEL`；不许有 `DEFAULT_TENANT_SLUG`、`WECOM_*`、`CHANNEL_SECRETS_KEY`、`NOTIFY_WEBHOOK_URL`、OTLP 端点、`LLM_HEDGE_MODEL`。宿主 `.env` 加 `SANDBOX_HOST`，不许有 `SANDBOX_WECOM_*`；`.env.ops` 加沙箱的拨测端口（变量名第 22 步定）。协调者（owner 授权）；第 31 步 ②。
- [ ] 每次部署前手动备份并复制到异地。协调者（owner 授权）；第 31 步两次部署前、第 35 步发版部署前。
- [ ] 企微后台：第 32 步 2–5（回调 URL、可信 IP、可调用接口的应用、企业内部开发表）。owner 登录、协调者用 Playwright；第 32 步。
- [ ] `.env.sandbox` 加五个 `SANDBOX_WECOM_*`：Token、EncodingAESKey 在服务器上生成、不打印，Secret 从后台取，open_kfid 用 `kf/account/list` 查。协调者（owner 授权）；第 32 步。
- [ ] 48007 实测、`kf-main` 不受影响、已用名额（spec 前置条件的两项）。协调者加 owner 的测试微信；第 32 步。
- [ ] 上线后第一份每晚备份恢复到临时集群抽查一次：新表与函数在、沙箱行随之恢复（03 的做法）。协调者；第 31 步之后，建议做。
- [ ] 上线一周后按 `sandbox_pool_daily` 调开放问题 8 的数值，改 `.env.sandbox`。owner 定、协调者改。
- [ ] 名额用完（`sandbox_wecom_full`）时：验证企业、或按开放问题 9 的 B 换企业之后跑 `sandbox wecom-reset-full`。owner；发生时。
- [ ] 长期停用沙箱：删容器、`.env.sandbox` 改名、跑 `sandbox purge --all`、从反向代理摘站点；体验客服长期不用就在后台停用；回到 pre-05 照 R18。协调者（owner 授权）；需要时。
- 新告警键（`sandbox_pool`、`sandbox_purge`、`tenant_scope_missing`、`sandbox_send_refused`、`sandbox_wecom_full`）走现有告警群，不用另配。02、03 plan「上线清单」里没勾的各项照旧有效，不在这里重复。

## 实施记录

### 第 1 步 · 开工核对与四张清单（2026-10-11）

**基准**（协调者）

- 开工条件逐条核对通过：04 spec `Status: implemented`（2026-10-11，PR #170），线上 demo 跑 04 之后的版本；本 spec `Status: ready`、开放问题 1–15 已定（PR #172）；本机能跑门禁、一次性 PG 与 docker。
- 开工提交 `02792ee`（dev，合并 PR #172）。
- 锁定文件 sha256（与 02、03、04 开工时相同）：

  ```
  c71a4966983925bc422a55240b289675584485693a49d6410f5e5d5a2555a6e3  src/engine.selftest.ts
  166c124e28cec35a9b8b0e306bbda653e653ee5795fd186388185812e32a3941  src/dejargon.selftest.ts
  351fd745fcb65ed6f87605fe3deb4a60841598e983b44a6d91c9493571ff9cb8  src/engine-holiday.selftest.ts
  d3f11083704b51fc13bc6be93933a094c2e0abd0310da6f87021e3df4a8d92a1  src/price-guard.selftest.ts
  4a577bb23225aa54881c783ffe7bd41b1e115179a2f8b62044af21b70b07dc04  src/llm.selftest.ts
  f371ea7e93fd75bd0c3054b36276cb55476672b3462576edf8dfc3fd6c5f9f61  src/server.selftest.ts
  d37341de95e87956b643dfd6ef5aee28011e39a7ce5391148e0157f9800c7882  src/adapters/wecom.selftest.ts
  aa8f00693fa63182361d4a03e2020ad1743000d7e15167bca8c0451f49b7ea91  eval/cases.json
  ```

  第 2 步之后 `src/server.selftest.ts` 以第 2 步记下的新值为准。

- `PREFIX sha256 system=dd2c10ee4d4205c1938f7ebdd3a4258490828a146a30c9931c33e35872ffdd60 tools=64c16fc8f464d5757f02411b7f8a2a6ce6f43da63416283851a6e997819692d1`（与 04 开工时相同，`pnpm -s test:locked` 全绿）。四个门禁在开工提交上全绿（CI `check`，PR #172）。
- 线上 `/healthz`（2026-10-11）：`revision demo-v5`，`promptHash dd2c10ee4d42`、`toolsHash 64c16fc8f464`、`prefixHash 3ac7e7b91512`、`sopHash 55e5caa59580`，`config.mode`、`store.mode`、`channels.mode` 都是 `db`，`channels.accounts = 1`。
- 内存：本机以开工提交、文件模式、`LLM_MOCK=1` 起一个空闲进程，RSS 30–120 秒约 97 MiB，之后 macOS 回收到约 45 MiB；线上宿主容器约 86 MiB。预估沙箱进程空闲 100–150 MiB，另加活着的沙箱（每个一份配置快照加十来个会话）。服务器可用内存约 3.6 GiB（swap 已用约 1.5 GiB，同机还有别的项目），放得下；第 21、30 步用真的沙箱进程复测。
- 企微后台官方提示「企业未认证，累计仅可接待100位客户」：spec 前置条件里的「约 100」确认为累计 100，不改 spec。
- **协调者裁决**（对本记录末尾的两个问题）：① spec 背景的「91 个集合」是起草时的估数，不来自入库的盘点；R5 的 lint 默认拒绝、不依赖总数，以本记录在开工提交上数出的 87 个直接集合绑定、115 个 `let` 为准，spec 不改。② 沙箱进程上 `POST /api/console/auth/logout` 与口令登录一样回 404（沙箱没有口令会话）；console 在 `Me.sandbox` 非空时不显示「退出登录」，只有横幅里的「结束体验」。已作为开工期澄清记进 spec 的 `Revisions:`，第 15、24 步照此做。

本记录只完成清单与反向引用，源码位置均按开工提交 `02792ee` 核对。未改代码、锁定文件、05 spec、步骤勾选或实施记录以外的 plan 内容；未访问网络、服务器或数据库，未提交。下一步由协调者补基准、审阅清单后决定第 1 步的完成状态。

#### 1. 模块级状态

按 TypeScript 语法树逐个枚举 `src/**/*.ts`（排除 `*.selftest.ts`），解构按实际标识符拆开；函数声明、类声明、import、函数值及其直接别名、原始类型 const、带 `as const` 的字面量（含 `satisfies`）、`Object.freeze` 的字面量不列。工厂返回的闭包保留；`readonly` 类型、`deepFreeze`、RegExp、Zod / Drizzle schema、自测出口对象均没有扩大豁免。模块加载期块内的短命局部变量不是模块绑定，副作用入口另见清单 ②。

共 **690 个模块绑定**：模块级 `let` **115** 个，与 spec 一致；直接以 `new Map / Set / WeakMap / WeakSet` 初始化的模块绑定 **87** 个（含规则常量与对象键表），比 spec 背景的 **91** 少 4。若把 `canHandle`、`canManageReplies` 工厂参数内的两个 `new Set`（`src/console-api/app.ts:281`、`:283`）也算构造位置则是 89，但它们不是另外两个绑定。`e5affab..02792ee` 的 `src/` 无代码差异，不能把差额解释成代码移动；原只读盘点的统计口径未随 spec 入库，91 的其余位置需要协调者提供。下面不依靠该历史总数筛选，逐项覆盖 R5 的默认拒绝范围。

租户项的登记名是第 11 步 manifest 的底稿；按模块与标识符唯一命名，不引入新接口。实例级每项写保留理由；“不动”只表示归类，不免除 manifest 登记。`eval/v2/isolation.ts:11` 的 bodies 与 `:68` 之后的额外 reset 出口逐项核对：已登记表示它确实被清 / 重置 / 等待；不是模块名出现就把整个模块标已登记。工厂内部清理的覆盖单列在表后。

| 出处                                                | 标识符                     | 形态                           | R5 类别  | 登记名 / 实例级理由                                              | 改动步骤 | isolation 覆盖                  |
| --------------------------------------------------- | -------------------------- | ------------------------------ | -------- | ---------------------------------------------------------------- | -------- | ------------------------------- |
| `src/adapters/simulator.ts:9`                       | `clients`                  | Map                            | 租户状态 | `simulator.clients`                                              | 9        | 未登记                          |
| `src/adapters/simulator.ts:25`                      | `simulatorAdapter`         | 对象字典                       | 实例级   | 固定适配器能力对象；所引用租户状态另登记                         | 不动     | 未登记                          |
| `src/adapters/web.ts:14`                            | `clients`                  | Map                            | 租户状态 | `web.clients`                                                    | 9        | 未登记                          |
| `src/adapters/web.ts:15`                            | `ips`                      | Map                            | 实例级   | 网页 SSE 的全实例数量 / 关闭集合（R5）；连接回调须保持所属作用域 | 不动     | 未登记                          |
| `src/adapters/web.ts:16`                            | `total`                    | let / 可替换绑定               | 实例级   | 网页 SSE 的全实例数量 / 关闭集合（R5）；连接回调须保持所属作用域 | 不动     | 未登记                          |
| `src/adapters/web.ts:50`                            | `webAdapter`               | 对象字典                       | 实例级   | 固定包 / 元数据（此写法不在 R5 字面豁免内），不含运行时租户数据  | 不动     | 未登记                          |
| `src/adapters/wecom-callback.ts:30`                 | `KEY_RE`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:162`                         | `tokenErrorListeners`      | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 不动     | 未登记                          |
| `src/adapters/wecom.ts:197`                         | `LEGACY_WELCOME_TEXTS`     | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/adapters/wecom.ts:203`                         | `WELCOME_TEXTS`            | Set                            | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/adapters/wecom.ts:248`                         | `observationClock`         | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/adapters/wecom.ts:361`                         | `runtimes`                 | Map                            | 租户状态 | `wecom.runtimes`                                                 | 9        | 未登记                          |
| `src/adapters/wecom.ts:364`                         | `envRuntime`               | 有状态实例                     | 租户状态 | `wecom.envRuntime`                                               | 9        | 未登记                          |
| `src/adapters/wecom.ts:599`                         | `ALL_LINKS_RE`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:684`                         | `LINK_LABEL_RE`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:690`                         | `NUMBERED_RE`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:694`                         | `LABEL_NOTE_RE`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:705`                         | `POINTER_BEFORE_RE`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:706`                         | `POINTER_AFTER_RE`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:1331`                        | `preparedGroups`           | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/adapters/wecom.ts:1465`                        | `LEADING_EMOJI_BULLET`     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:1623`                        | `NON_TEXT_HINT`            | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/adapters/wecom.ts:1632`                        | `NON_TEXT_PLACEHOLDER`     | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/adapters/wecom.ts:1875`                        | `ATTEMPT_RETRY_MS`         | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/adapters/wecom.ts:2842`                        | `wecomAdapter`             | 对象字典                       | 实例级   | 固定适配器能力对象；所引用租户状态另登记                         | 不动     | 未登记                          |
| `src/adapters/wecom.ts:2924`                        | `__test`                   | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/adapters/wecom.ts:2941`                        | `__wecomTest`              | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/auth/accounts.ts:21`                           | `ROLES`                    | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/auth/password.ts:7`                            | `CURRENT`                  | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/auth/password.ts:23`                           | `running`                  | let / 可替换绑定               | 实例级   | scrypt 的进程资源上限与等待队列                                  | 不动     | 未登记                          |
| `src/auth/password.ts:24`                           | `waiting`                  | 数组                           | 实例级   | scrypt 的进程资源上限与等待队列                                  | 不动     | 未登记                          |
| `src/auth/password.ts:93`                           | `__passwordTest`           | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/auth/session.ts:33`                            | `TOKEN_RE`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/auth/session.ts:98`                            | `perIp`                    | 有状态实例                     | 实例级   | 认证攻击限流按 IP / 邮箱；保护整个进程                           | 不动     | 未登记                          |
| `src/auth/session.ts:99`                            | `failByEmailIp`            | 有状态实例                     | 实例级   | 认证攻击限流按 IP / 邮箱；保护整个进程                           | 不动     | 未登记                          |
| `src/auth/session.ts:100`                           | `failByEmail`              | 有状态实例                     | 实例级   | 认证攻击限流按 IP / 邮箱；保护整个进程                           | 不动     | 未登记                          |
| `src/auth/session.ts:101`                           | `invalidCookieByIp`        | 有状态实例                     | 实例级   | 认证攻击限流按 IP / 邮箱；保护整个进程                           | 不动     | 未登记                          |
| `src/auth/session.ts:102`                           | `slowDelayMs`              | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/auth/session.ts:225`                           | `__authTest`               | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/budget.ts:27`                                  | `state`                    | let / 可替换绑定               | 租户状态 | `budget.host.state`                                              | 10       | 已登记                          |
| `src/budget.ts:39`                                  | `flushTimer`               | let / 定时器句柄               | 租户状态 | `budget.host.flushTimer`                                         | 10       | 已登记                          |
| `src/channels/accounts.ts:66`                       | `SENTENCE_END`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/channels/accounts.ts:68`                       | `HANDOFF_PHRASE`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/channels/accounts.ts:187`                      | `SYSTEM_ACTOR`             | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/channels/accounts.ts:208`                      | `installed`                | let / 数组                     | 租户状态 | `channels.accounts.installed`                                    | 9        | 未登记                          |
| `src/channels/inbox.ts:140`                         | `abandonedListeners`       | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 不动     | 未登记                          |
| `src/channels/recovery-rules.ts:72`                 | `AI_KINDS`                 | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/channels/recovery.ts:24`                       | `resendUnknown`            | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/channels/recovery.ts:48`                       | `pushWaitMs`               | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/channels/recovery.ts:251`                      | `__channelTest`            | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/channels/registry.ts:93`                       | `registry`                 | let / 可替换绑定               | 租户状态 | `channels.registry.registry`                                     | 9        | 未登记                          |
| `src/channels/registry.ts:94`                       | `startedAt`                | let / 可替换绑定               | 实例级   | 渠道总巡检时间 / 定时器；第 9 步逐账号进入所属作用域             | 9        | 未登记                          |
| `src/channels/registry.ts:95`                       | `observationClock`         | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/channels/registry.ts:96`                       | `restartUnknown`           | let / 数组                     | 租户状态 | `channels.registry.restartUnknown`                               | 9        | 未登记                          |
| `src/channels/registry.ts:104`                      | `observations`             | Map                            | 租户状态 | `channels.registry.observations`                                 | 9        | 未登记                          |
| `src/channels/registry.ts:105`                      | `refreshing`               | let / 可替换绑定               | 租户状态 | `channels.registry.refreshing`                                   | 9        | 未登记                          |
| `src/channels/registry.ts:106`                      | `pendingRead`              | let / 对象或实例               | 租户状态 | `channels.registry.pendingRead`                                  | 9        | 未登记                          |
| `src/channels/registry.ts:107`                      | `statsTimer`               | let / 定时器句柄               | 实例级   | 渠道总巡检时间 / 定时器；第 9 步逐账号进入所属作用域             | 9        | 未登记                          |
| `src/channels/registry.ts:108`                      | `statsRefreshMs`           | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/channels/registry.ts:109`                      | `statsTimeoutMs`           | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/channels/registry.ts:110`                      | `lastStatsAt`              | let / 可替换绑定               | 租户状态 | `channels.registry.lastStatsAt`                                  | 9        | 未登记                          |
| `src/channels/registry.ts:134`                      | `SYSTEM_ACTOR`             | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/channels/registry.ts:563`                      | `__channelsTest`           | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/channels/transitions.ts:27`                    | `OUTBOUND_TRANSITIONS`     | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/channels/transitions.ts:53`                    | `OUTBOUND_KEEPS_PAYLOAD`   | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/channels/transitions.ts:74`                    | `INBOX_TRANSITIONS`        | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/channels/transitions.ts:96`                    | `INBOX_OPEN_STATES`        | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/channels/transitions.ts:98`                    | `INBOX_FINISHED_STATES`    | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/cli/channel-account.ts:66`                     | `UNTIL_RE`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/config/sop.ts:72`                              | `UUID_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/config/sop.ts:73`                              | `EDITABLE`                 | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/config/source.ts:209`                          | `dbInstalled`              | let / 可替换绑定               | 租户状态 | `config.dbInstalled`                                             | 6        | 未登记                          |
| `src/config/source.ts:210`                          | `loaded`                   | let / 可替换绑定               | 租户状态 | `config.loaded`                                                  | 6        | 未登记                          |
| `src/config/source.ts:211`                          | `lockState`                | let / 可替换绑定               | 租户状态 | `config.lockState`                                               | 6        | 未登记                          |
| `src/config/source.ts:213`                          | `lockTaken`                | let / 可替换绑定               | 租户状态 | `config.lockTaken`                                               | 6        | 未登记                          |
| `src/config/source.ts:214`                          | `sopStale`                 | let / 可替换绑定               | 租户状态 | `config.sopStale`                                                | 6        | 未登记                          |
| `src/config/source.ts:215`                          | `catalogStale`             | let / 可替换绑定               | 租户状态 | `config.catalogStale`                                            | 6        | 未登记                          |
| `src/config/source.ts:216`                          | `shuttingDown`             | let / 可替换绑定               | 租户状态 | `config.shuttingDown`                                            | 6        | 未登记                          |
| `src/config/source.ts:217`                          | `reacquireMs`              | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/config/source.ts:218`                          | `reacquireTimer`           | let / 定时器句柄               | 租户状态 | `config.reacquireTimer`                                          | 6        | 未登记                          |
| `src/config/source.ts:219`                          | `catalogListeners`         | 数组                           | 租户状态 | `config.catalogListeners`                                        | 6        | 未登记                          |
| `src/config/source.ts:238`                          | `turnPin`                  | 有状态实例 / AsyncLocalStorage | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/config/source.ts:273`                          | `lockListeners`            | Set                            | 租户状态 | `config.lockListeners`                                           | 6        | 未登记                          |
| `src/config/source.ts:316`                          | `PRIVILEGED`               | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/config/source.ts:471`                          | `CAUSE`                    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/config/source.ts:794`                          | `catalogWrites`            | let / 可替换绑定               | 租户状态 | `config.catalogWrites`                                           | 6        | 未登记                          |
| `src/config/source.ts:875`                          | `reloading`                | let / 可替换绑定               | 租户状态 | `config.reloading`                                               | 6        | 未登记                          |
| `src/config/source.ts:876`                          | `reloadAgain`              | let / 可替换绑定               | 租户状态 | `config.reloadAgain`                                             | 6        | 未登记                          |
| `src/config/source.ts:877`                          | `RELOAD_BACKOFF_MS`        | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/config/source.ts:878`                          | `reloadBackoff`            | let / 数组                     | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/config/source.ts:978`                          | `__configTest`             | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/config/source.ts:1071`                         | `runtimeSources`           | let / 可替换绑定               | 实例级   | 能力接线 / 模块引用；调用时读取当前作用域，不在绑定里缓存租户值  | 不动     | 未登记                          |
| `src/console-api/app.ts:191`                        | `clock`                    | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/console-api/app.ts:215`                        | `SAFE_METHODS`             | Set                            | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/console-api/app.ts:216`                        | `JSON_TYPE`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/console-api/app.ts:217`                        | `EDITORS`                  | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/console-api/app.ts:281`                        | `canHandle`                | 工厂闭包                       | 实例级   | 静态路由 / 权限能力表，不存租户认证结果；请求入口另建作用域      | 不动     | 未登记                          |
| `src/console-api/app.ts:283`                        | `canManageReplies`         | 工厂闭包                       | 实例级   | 静态路由 / 权限能力表，不存租户认证结果；请求入口另建作用域      | 不动     | 未登记                          |
| `src/console-api/app.ts:308`                        | `UUID_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/console-api/app.ts:396`                        | `consoleApi`               | 有状态实例                     | 实例级   | 静态路由 / 权限能力表，不存租户认证结果；请求入口另建作用域      | 不动     | 未登记                          |
| `src/console-api/app.ts:954`                        | `__consoleTest`            | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/console-api/events.ts:23`                      | `ring`                     | 数组                           | 租户状态 | `console.events.ring`                                            | 9        | 未登记                          |
| `src/console-api/events.ts:24`                      | `last`                     | let / 可替换绑定               | 租户状态 | `console.events.last`                                            | 9        | 未登记                          |
| `src/console-api/events.ts:25`                      | `listeners`                | Set                            | 租户状态 | `console.events.listeners`                                       | 9        | 未登记                          |
| `src/console-api/events.ts:27`                      | `timing`                   | let / 对象或实例               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/console-api/events.ts:28`                      | `countsOf`                 | let / 可替换绑定               | 租户状态 | `console.events.countsOf`                                        | 9        | 未登记                          |
| `src/console-api/events.ts:29`                      | `countsTimer`              | let / 定时器句柄               | 租户状态 | `console.events.countsTimer`                                     | 9        | 未登记                          |
| `src/console-api/events.ts:30`                      | `unsubscribe`              | let / 可替换绑定               | 租户状态 | `console.events.unsubscribe`                                     | 9        | 未登记                          |
| `src/console-api/events.ts:126`                     | `__eventsTest`             | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/console-api/host.ts:39`                        | `consolePages`             | 有状态实例                     | 实例级   | 静态路由 / 权限能力表，不存租户认证结果；请求入口另建作用域      | 不动     | 未登记                          |
| `src/console-api/host.ts:59`                        | `__hostTest`               | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/console-api/mask.ts:14`                        | `NUMBER_RUN`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/console-api/mask.ts:15`                        | `PHONE_AFTER_LETTER`       | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/console-api/mask.ts:16`                        | `ID_LETTER`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/console-api/workbench.ts:110`                  | `HANDOFF_NOTE_RE`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/console-api/workbench.ts:188`                  | `ISO_DATE`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/brand.ts:4`                               | `graphemes`                | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/core/engine/index.ts:138`                      | `toolObservers`            | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 7        | 未登记                          |
| `src/core/engine/index.ts:150`                      | `sessionChain`             | Map                            | 租户状态 | `engine.sessionChain`                                            | 7        | 未登记                          |
| `src/core/engine/index.ts:194`                      | `replyMessages`            | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/core/engine/index.ts:207`                      | `SENSITIVE_CATEGORIES`     | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/core/engine/index.ts:853`                      | `__triggerTest`            | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/core/followup.ts:140`                          | `stopping`                 | let / 可替换绑定               | 租户状态 | `followup.scan.stopping`                                         | 9        | 已登记                          |
| `src/core/followup.ts:141`                          | `scanTask`                 | let / 可替换绑定               | 租户状态 | `followup.scan.scanTask`                                         | 9        | 已登记                          |
| `src/core/followup.ts:142`                          | `scanTimer`                | let / 定时器句柄               | 租户状态 | `followup.scan.scanTimer`                                        | 9        | 未登记                          |
| `src/core/followup.ts:144`                          | `composeWaiters`           | Set                            | 租户状态 | `followup.scan.composeWaiters`                                   | 9        | 未登记                          |
| `src/core/followup.ts:287`                          | `__followupTest`           | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/core/guards/text.ts:2`                         | `VERSION_SUFFIX_AHEAD`     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/guards/text.ts:24`                        | `IDENTITY_QUESTION`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/insight.ts:33`                            | `insightCache`             | let / 数组                     | 租户状态 | `insight.insightCache`                                           | 7        | 未登记                          |
| `src/core/insight.ts:93`                            | `sugCache`                 | Map                            | 租户状态 | `insight.sugCache`                                               | 7        | 未登记                          |
| `src/core/insight.ts:94`                            | `sugInflight`              | Map                            | 租户状态 | `insight.sugInflight`                                            | 7        | 未登记                          |
| `src/core/insight.ts:122`                           | `draftCache`               | Map                            | 租户状态 | `insight.draftCache`                                             | 7        | 未登记                          |
| `src/core/insight.ts:123`                           | `draftInflight`            | Map                            | 租户状态 | `insight.draftInflight`                                          | 7        | 未登记                          |
| `src/core/llm/client.ts:50`                         | `requestObserver`          | let / 可替换绑定               | 实例级   | 按模型的事实、总量统计或观测接线；不作为租户数据缓存             | 不动     | 已登记                          |
| `src/core/llm/client.ts:150`                        | `CHEAP_TIER_MODELS`        | 有状态实例                     | 实例级   | 按模型的事实、总量统计或观测接线；不作为租户数据缓存             | 不动     | 未登记                          |
| `src/core/llm/client.ts:182`                        | `REASONING_EFFORTS`        | Set                            | 实例级   | 按模型的事实、总量统计或观测接线；不作为租户数据缓存             | 不动     | 未登记                          |
| `src/core/llm/client.ts:190`                        | `learnedThinking`          | Set                            | 实例级   | 按模型的事实、总量统计或观测接线；不作为租户数据缓存             | 不动     | 已登记                          |
| `src/core/llm/client.ts:192`                        | `warnedIgnoredDisabled`    | Set                            | 实例级   | 按模型的事实、总量统计或观测接线；不作为租户数据缓存             | 不动     | 已登记                          |
| `src/core/llm/client.ts:194`                        | `stats`                    | 对象字典                       | 实例级   | 按模型的事实、总量统计或观测接线；不作为租户数据缓存             | 不动     | 已登记                          |
| `src/core/llm/client.ts:691`                        | `llmCallObservers`         | Set                            | 实例级   | 按模型的事实、总量统计或观测接线；不作为租户数据缓存             | 7        | 未登记                          |
| `src/core/llm/client.ts:836`                        | `__llmTest`                | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/core/pack-api.ts:183`                          | `brandText`                | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/core/pack-api.ts:184`                          | `BrandProfileSchema`       | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/core/pack-api.ts:600`                          | `binding`                  | let / 可替换绑定               | 租户状态 | `pack.binding`                                                   | 6        | 未登记                          |
| `src/core/parse/counts.ts:2`                        | `CN_DAY`                   | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/core/parse/counts.ts:15`                       | `HEADCOUNT`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/counts.ts:17`                       | `PER_PERSON_ASK`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/counts.ts:19`                       | `HEADCOUNT_DELTA`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/counts.ts:42`                       | `TOTAL_HEADCOUNT`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/counts.ts:43`                       | `KIDS_COUNT`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/counts.ts:64`                       | `HEADS_SAID`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:54`                        | `EXPLICIT_DATE_RE`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:55`                        | `PAST_TRIP_AFTER`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:98`                        | `NOT_DEPART_BEFORE`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:100`                       | `NOT_DEPART_AFTER`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:104`                       | `OTHER_PLAN_AFTER`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:106`                       | `DEPART_AFTER`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:108`                       | `SWITCH_BEFORE`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:109`                       | `SWITCH_AFTER`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:111`                       | `NEAR_NOT_ON`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:113`                       | `AFTER_HOLIDAY`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:212`                       | `ASIDE_QUESTION`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:213`                       | `ASIDE_NOT`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:233`                       | `MONTH_ASIDE_QUESTION`     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:235`                       | `MONTH_ASIDE_NOT`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/dates.ts:346`                       | `MONTH_SAID`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:30`                        | `AMOUNT_RE`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:32`                        | `BARE_NUM_RE`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:42`                        | `CN_CAPITAL`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/core/parse/money.ts:60`                        | `CN_CAPITAL_RE`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:80`                        | `TIGHT_HINT`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:139`                       | `CN_NUM`                   | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/core/parse/money.ts:140`                       | `CN_UNIT`                  | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/core/parse/money.ts:142`                       | `NUM_CHAR`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:146`                       | `CLASSIFIER_AFTER`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:326`                       | `MONEY_UNIT_AFTER`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:328`                       | `MEASURE_AFTER`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:335`                       | `CN_FOLLOW_OK`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:343`                       | `MONEY_CUE`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:350`                       | `NOT_MONEY_BETWEEN`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:351`                       | `ALTITUDE_BEFORE`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:352`                       | `PER_HEAD_AFTER`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:441`                       | `CN_RANGE_RE`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:443`                       | `AR_RANGE_RE`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/parse/money.ts:488`                       | `CURRENCY_SUFFIX`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/core/retrieval.ts:28`                          | `index`                    | let / 数组                     | 租户状态 | `retrieval.index`                                                | 7        | 已登记                          |
| `src/core/retrieval.ts:29`                          | `building`                 | let / 可替换绑定               | 租户状态 | `retrieval.building`                                             | 7        | 已登记                          |
| `src/core/retrieval.ts:32`                          | `stale`                    | let / 可替换绑定               | 租户状态 | `retrieval.stale`                                                | 7        | 已登记                          |
| `src/core/retrieval.ts:33`                          | `indexGeneration`          | let / 可替换绑定               | 租户状态 | `retrieval.indexGeneration`                                      | 7        | 已登记                          |
| `src/core/retrieval.ts:34`                          | `lastError`                | let / 可替换绑定               | 租户状态 | `retrieval.lastError`                                            | 7        | 已登记                          |
| `src/core/retrieval.ts:35`                          | `retryAttempt`             | let / 可替换绑定               | 租户状态 | `retrieval.retryAttempt`                                         | 7        | 已登记                          |
| `src/core/retrieval.ts:36`                          | `retryTimer`               | let / 定时器句柄               | 租户状态 | `retrieval.retryTimer`                                           | 7        | 已登记                          |
| `src/core/retrieval.ts:37`                          | `RETRY_BACKOFF_MS`         | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/core/retrieval.ts:38`                          | `retryBackoff`             | let / 数组                     | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 已登记                          |
| `src/core/retrieval.ts:233`                         | `__retrievalTest`          | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/db/client.ts:24`                               | `queries`                  | let / 可替换绑定               | 实例级   | 查询总量计数，不存行或租户配置                                   | 不动     | 未登记                          |
| `src/db/client.ts:26`                               | `countingLogger`           | 对象字典                       | 实例级   | 查询总量计数，不存行或租户配置                                   | 不动     | 未登记                          |
| `src/db/client.ts:46`                               | `drivers`                  | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/db/client.ts:166`                              | `tenantStore`              | 有状态实例 / AsyncLocalStorage | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/db/repo/catalog.ts:24`                         | `columns`                  | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/channel-accounts.ts:49`                | `COLUMNS`                  | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/channel-inbox.ts:47`                   | `COLUMNS`                  | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/conversations.ts:42`                   | `rowColumns`               | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/jobs.ts:26`                            | `FINISHED`                 | 数组                           | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/outbound.ts:61`                        | `FLUSH_WRITERS`            | 数组                           | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/privacy.ts:13`                         | `columns`                  | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/quick-replies.ts:17`                   | `columns`                  | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/quick-replies.ts:26`                   | `live`                     | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/sop.ts:28`                             | `columns`                  | 对象字典                       | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/repo/traces.ts:56`                          | `UUID_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/db/schema.ts:41`                               | `bytea`                    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/db/schema.ts:48`                               | `tenants`                  | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:79`                               | `users`                    | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:93`                               | `memberships`              | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:111`                              | `authSessions`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:132`                              | `auditLog`                 | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:174`                              | `sopVersions`              | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:245`                              | `catalogItems`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:283`                              | `conversations`            | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:331`                              | `messages`                 | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:368`                              | `orders`                   | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:402`                              | `turnTraces`               | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:443`                              | `guardEvents`              | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:466`                              | `usageDaily`               | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:490`                              | `jobs`                     | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:526`                              | `quickReplies`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:547`                              | `outboundSends`            | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:603`                              | `catalogItemVersions`      | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:630`                              | `privacyNotices`           | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:645`                              | `consents`                 | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:677`                              | `channelAccounts`          | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/db/schema.ts:733`                              | `channelInbox`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/engine.ts:24`                                  | `runtime`                  | 工厂实例 / 旧门面              | 实例级   | 04 永久旧旅游门面；依赖是调用时读配置的能力，不是已发布租户快照  | 不动     | 未登记                          |
| `src/engine.ts:24`                                  | `turnHooks`                | 工厂实例 / 旧门面              | 实例级   | 04 永久旧旅游门面；依赖是调用时读配置的能力，不是已发布租户快照  | 不动     | 未登记                          |
| `src/engine.ts:24`                                  | `replyHelpers`             | 工厂实例 / 旧门面              | 实例级   | 04 永久旧旅游门面；依赖是调用时读配置的能力，不是已发布租户快照  | 不动     | 未登记                          |
| `src/engine.ts:27`                                  | `PURCHASE_INTENT`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/engine.ts:28`                                  | `OTHER_ORDER`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/engine.ts:29`                                  | `RESEND_ASK`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/engine.ts:30`                                  | `BUDGET_FLOOR`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/engine.ts:50`                                  | `PROPOSAL_PROMISE`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/engine.ts:51`                                  | `LINK_PROMISE`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/engine.ts:60`                                  | `__orderTest`              | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/engine.ts:63`                                  | `__engineTest`             | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/followup.ts:18`                                | `FOLLOWUP_STAGES`          | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/consent.ts:12`                         | `SENSITIVE_CATEGORY_LABEL` | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/consent.ts:46`                         | `CATEGORIES`               | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/record.ts:19`                          | `EMERGENCY_LABEL`          | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/takeover.ts:60`                        | `HANDLERS`                 | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/takeover.ts:61`                        | `SUPERVISORS`              | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/takeover.ts:117`                       | `gens`                     | Map                            | 租户状态 | `takeover.gens`                                                  | 7        | 已登记                          |
| `src/handoff/takeover.ts:254`                       | `transport`                | let / 可替换绑定               | 实例级   | 能力接线 / 模块引用；调用时读取当前作用域，不在绑定里缓存租户值  | 不动     | 未登记                          |
| `src/handoff/takeover.ts:276`                       | `preparer`                 | let / 可替换绑定               | 实例级   | 能力接线 / 模块引用；调用时读取当前作用域，不在绑定里缓存租户值  | 不动     | 未登记                          |
| `src/handoff/takeover.ts:304`                       | `recent`                   | Map                            | 租户状态 | `takeover.recent`                                                | 7        | 已登记                          |
| `src/handoff/takeover.ts:425`                       | `__takeoverTest`           | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:24`                 | `EMERGENCY_YES`            | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:323`                | `EMERGENCY_MODEL`          | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:529`                | `EMERGENCY_NO_PRESALE`     | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:1127`               | `EMERGENCY_NO_OTHER`       | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:1340`               | `NEGATIVE_YES`             | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:1740`               | `NEGATIVE_MODEL`           | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:1854`               | `NEGATIVE_NO_PRESALE`      | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:2248`               | `NEGATIVE_NO_OTHER`        | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:2431`               | `ASKING_YES`               | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:2732`               | `ASKING_MODEL`             | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:2796`               | `ASKING_NO_PRESALE`        | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/handoff/triggers.corpus.ts:3043`               | `ASKING_NO_OTHER`          | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/http-guards.ts:43`                             | `PRIVATE_PEER`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/http-guards.ts:91`                             | `lookupRateLimited`        | 工厂闭包                       | 实例级   | IP 限流保护整个进程（R5），闭包含 hits 与清理定时器              | 不动     | 未登记                          |
| `src/jobs/followup.ts:71`                           | `known`                    | Map                            | 租户状态 | `followup.jobs.known`                                            | 9        | 已登记                          |
| `src/jobs/followup.ts:73`                           | `selfSaving`               | let / 可替换绑定               | 租户状态 | `followup.jobs.selfSaving`                                       | 9        | 已登记                          |
| `src/jobs/followup.ts:134`                          | `push`                     | let / 可替换绑定               | 实例级   | 能力接线 / 模块引用；调用时读取当前作用域，不在绑定里缓存租户值  | 不动     | 未登记                          |
| `src/jobs/followup.ts:135`                          | `installed`                | let / 可替换绑定               | 租户状态 | `followup.jobs.installed`                                        | 9        | 未登记                          |
| `src/jobs/followup.ts:136`                          | `stopping`                 | let / 可替换绑定               | 租户状态 | `followup.jobs.stopping`                                         | 9        | 已登记                          |
| `src/jobs/followup.ts:138`                          | `composeWaiters`           | Set                            | 租户状态 | `followup.jobs.composeWaiters`                                   | 9        | 未登记                          |
| `src/jobs/followup.ts:161`                          | `quotaAllows`              | let / 可替换绑定               | 实例级   | 能力接线 / 模块引用；调用时读取当前作用域，不在绑定里缓存租户值  | 不动     | 未登记                          |
| `src/jobs/followup.ts:331`                          | `followupJobs`             | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/jobs/optout.ts:15`                             | `TRAD`                     | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/jobs/optout.ts:48`                             | `TRAD_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:50`                             | `EMOJI`                    | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:51`                             | `WECHAT_FACE`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:54`                             | `CLAUSE_SPLIT`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:56`                             | `LEAD`                     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:59`                             | `TAIL`                     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:60`                             | `ASKING`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:65`                             | `ACK`                      | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/jobs/optout.ts:68`                             | `OPT_OUT`                  | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/jobs/purge.ts:40`                              | `runningJobChecker`        | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/jobs/purge.ts:45`                              | `purgeTickHook`            | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/jobs/purge.ts:55`                              | `purgeHoldHook`            | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/jobs/runner.ts:59`                             | `LANES`                    | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/jobs/runner.ts:64`                             | `RETRY_MS`                 | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/jobs/runner.ts:121`                            | `handlers`                 | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/jobs/runner.ts:131`                            | `mine`                     | Map                            | 租户状态 | `jobs.mine`                                                      | 9        | 已登记                          |
| `src/jobs/runner.ts:133`                            | `started`                  | let / 可替换绑定               | 实例级   | 宿主进程任务编排 / 日志节流；第 9 步每拍逐租户执行               | 9        | 未登记                          |
| `src/jobs/runner.ts:134`                            | `stopping`                 | let / 可替换绑定               | 实例级   | 宿主进程任务编排 / 日志节流；第 9 步每拍逐租户执行               | 9        | 已登记                          |
| `src/jobs/runner.ts:135`                            | `recovered`                | let / 可替换绑定               | 租户状态 | `jobs.recovered`                                                 | 9        | 已登记                          |
| `src/jobs/runner.ts:137`                            | `recovering`               | let / 可替换绑定               | 租户状态 | `jobs.recovering`                                                | 9        | 已登记                          |
| `src/jobs/runner.ts:138`                            | `timer`                    | let / 定时器句柄               | 实例级   | 宿主进程任务编排 / 日志节流；第 9 步每拍逐租户执行               | 9        | 未登记                          |
| `src/jobs/runner.ts:140`                            | `laneTasks`                | Map                            | 租户状态 | `jobs.laneTasks`                                                 | 9        | 已登记                          |
| `src/jobs/runner.ts:141`                            | `lastPurgeEnsure`          | let / 可替换绑定               | 租户状态 | `jobs.lastPurgeEnsure`                                           | 9        | 已登记                          |
| `src/jobs/runner.ts:142`                            | `lastClaimLog`             | let / 可替换绑定               | 实例级   | 宿主进程任务编排 / 日志节流；第 9 步每拍逐租户执行               | 不动     | 未登记                          |
| `src/jobs/runner.ts:145`                            | `unsettled`                | Map                            | 租户状态 | `jobs.unsettled`                                                 | 9        | 已登记                          |
| `src/jobs/runner.ts:210`                            | `failedListeners`          | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 不动     | 未登记                          |
| `src/jobs/runner.ts:437`                            | `__jobsTest`               | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/llm-gate.ts:19`                                | `inflight`                 | let / 可替换绑定               | 实例级   | 进程模型并发资源闸与等待队列（R5）                               | 不动     | 未登记                          |
| `src/llm-gate.ts:21`                                | `waiting`                  | 数组                           | 实例级   | 进程模型并发资源闸与等待队列（R5）                               | 不动     | 未登记                          |
| `src/llm.ts:22`                                     | `toolsModule`              | let / 可替换绑定               | 实例级   | 能力接线 / 模块引用；调用时读取当前作用域，不在绑定里缓存租户值  | 不动     | 未登记                          |
| `src/log.ts:37`                                     | `ctxStore`                 | 有状态实例 / AsyncLocalStorage | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/log.ts:39`                                     | `refOf`                    | let / 可替换绑定               | 实例级   | 能力接线 / 模块引用；调用时读取当前作用域，不在绑定里缓存租户值  | 不动     | 未登记                          |
| `src/log.ts:40`                                     | `tenantSlug`               | let / 可替换绑定               | 租户状态 | `log.tenantSlug`                                                 | 6        | 未登记                          |
| `src/log.ts:84`                                     | `RAW_CONV_ID`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/log.ts:100`                                    | `SECRET_PARAM`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/log.ts:101`                                    | `BEARER`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/log.ts:103`                                    | `CONN_PASSWORD`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/log.ts:105`                                    | `COOKIE_HEADER`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/log.ts:108`                                    | `REDACT_KEYS`              | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/log.ts:134`                                    | `REDACT_PATHS`             | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/log.ts:139`                                    | `REDACT_SET`               | Set                            | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/log.ts:143`                                    | `REDACT_JSON_FIELD`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/log.ts:187`                                    | `jsonLogger`               | let / 可替换绑定               | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/log.ts:194`                                    | `consoleHooked`            | let / 可替换绑定               | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/log.ts:234`                                    | `log`                      | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/log.ts:288`                                    | `__logTest`                | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/notify/handoff.ts:29`                          | `REASONS`                  | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/notify/handoff.ts:133`                         | `unsaved`                  | Map                            | 租户状态 | `notify.unsaved`                                                 | 9        | 已登记                          |
| `src/notify/handoff.ts:135`                         | `waiting`                  | Map                            | 租户状态 | `notify.waiting`                                                 | 9        | 已登记                          |
| `src/notify/handoff.ts:136`                         | `unsavedTiming`            | 数组                           | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/notify/handoff.ts:145`                         | `installed`                | let / 可替换绑定               | 租户状态 | `notify.installed`                                               | 9        | 未登记                          |
| `src/notify/handoff.ts:224`                         | `__handoffNotifyTest`      | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/notify/notifier.ts:48`                         | `TIME_LABEL`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/notify/notifier.ts:73`                         | `timing`                   | 对象字典                       | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/notify/notifier.ts:114`                        | `override`                 | let / 可替换绑定               | 实例级   | 进程通知替身，生产按唯一 env webhook 选；不存通知内容            | 不动     | 未登记                          |
| `src/notify/notifier.ts:135`                        | `__notifierTest`           | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/ops/alert.ts:45`                               | `timing`                   | 数组                           | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:49`                               | `clock`                    | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:55`                               | `states`                   | Map                            | 租户状态 | `alert.states`；租户告警去重，实例键须区分                       | 7        | 未登记                          |
| `src/ops/alert.ts:56`                               | `sentAt`                   | 数组                           | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:57`                               | `lastThrottleLog`          | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:58`                               | `inflight`                 | Set                            | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:168`                              | `failStreak`               | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:169`                              | `okStreak`                 | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:170`                              | `streakKinds`              | let / 数组                     | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:172`                              | `recentTurns`              | let / 数组                     | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:206`                              | `wecomAccounts`            | Map                            | 租户状态 | `alert.wecomAccounts`；账号 key 只在租户内唯一                   | 7        | 未登记                          |
| `src/ops/alert.ts:250`                              | `lastUnsafeAlertAt`        | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:269`                              | `inboxAlerted`             | Map                            | 租户状态 | `alert.inboxAlerted`；账号 key 只在租户内唯一                    | 7        | 未登记                          |
| `src/ops/alert.ts:270`                              | `INBOX_REASON_TEXT`        | 对象字典                       | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:280`                              | `restoreCutoff`            | 对象字典                       | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:329`                              | `lagAlerted`               | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:330`                              | `poisonedSeen`             | let / Set                      | 租户状态 | `alert.poisonedSeen`；会话 id 须与所属租户合用                   | 7        | 未登记                          |
| `src/ops/alert.ts:331`                              | `dropSamples`              | let / 数组                     | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:332`                              | `replayFailedSeen`         | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:335`                              | `probe`                    | let / 对象或实例               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:441`                              | `started`                  | let / 可替换绑定               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:442`                              | `timer`                    | let / 定时器句柄               | 实例级   | 进程告警、去重或总量统计；R5 保留实例级，沙箱过滤按 R19          | 不动     | 未登记                          |
| `src/ops/alert.ts:476`                              | `__alertTest`              | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/ops/metrics.ts:51`                             | `retention`                | 有状态实例                     | 租户状态 | `metrics.retention`                                              | 7        | 未登记                          |
| `src/ops/metrics.ts:52`                             | `views`                    | 有状态实例                     | 租户状态 | `metrics.views`                                                  | 7        | 未登记                          |
| `src/ops/metrics.ts:66`                             | `__metricsTest`            | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/otel/export.ts:53`                             | `provider`                 | let / 可替换绑定               | 实例级   | 唯一进程 OTel 导出器 / 节流；租户字段由调用作用域取（第 7 步）   | 7        | 未登记                          |
| `src/otel/export.ts:54`                             | `exporter`                 | let / 可替换绑定               | 实例级   | 唯一进程 OTel 导出器 / 节流；租户字段由调用作用域取（第 7 步）   | 7        | 未登记                          |
| `src/otel/export.ts:55`                             | `tracer`                   | let / 可替换绑定               | 实例级   | 唯一进程 OTel 导出器 / 节流；租户字段由调用作用域取（第 7 步）   | 7        | 未登记                          |
| `src/otel/export.ts:56`                             | `breakNext`                | let / 可替换绑定               | 实例级   | 唯一进程 OTel 导出器 / 节流；租户字段由调用作用域取（第 7 步）   | 7        | 未登记                          |
| `src/otel/export.ts:76`                             | `warnExport`               | 工厂闭包                       | 实例级   | 唯一进程 OTel 导出器 / 节流；租户字段由调用作用域取（第 7 步）   | 7        | 未登记                          |
| `src/otel/export.ts:77`                             | `warnBuild`                | 工厂闭包                       | 实例级   | 唯一进程 OTel 导出器 / 节流；租户字段由调用作用域取（第 7 步）   | 7        | 未登记                          |
| `src/otel/export.ts:78`                             | `warnFlush`                | 工厂闭包                       | 实例级   | 唯一进程 OTel 导出器 / 节流；租户字段由调用作用域取（第 7 步）   | 7        | 未登记                          |
| `src/otel/export.ts:277`                            | `__otelTest`               | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 7        | 未登记                          |
| `src/packs/__fixture/runtime.ts:4`                  | `fixture`                  | 对象字典                       | 实例级   | 固定包 / 元数据（此写法不在 R5 字面豁免内），不含运行时租户数据  | 不动     | 未登记                          |
| `src/packs/registry.ts:12`                          | `PACKS`                    | 对象字典                       | 实例级   | 固定包 / 元数据（此写法不在 R5 字面豁免内），不含运行时租户数据  | 不动     | 未登记                          |
| `src/packs/registry.ts:18`                          | `PACK_IDS`                 | 数组                           | 实例级   | 固定包 / 元数据（此写法不在 R5 字面豁免内），不含运行时租户数据  | 不动     | 未登记                          |
| `src/packs/registry.ts:29`                          | `QUICK_REPLY_DEFAULTS`     | 数组                           | 实例级   | 固定包 / 元数据（此写法不在 R5 字面豁免内），不含运行时租户数据  | 不动     | 未登记                          |
| `src/packs/registry.ts:36`                          | `legacyTravel`             | let / 数组                     | 实例级   | 04 永久旧旅游门面；依赖是调用时读配置的能力，不是已发布租户快照  | 不动     | 未登记                          |
| `src/packs/travel/brand-fixture.ts:5`               | `shanhaiBrand`             | 对象字典                       | 实例级   | 固定包 / 元数据（此写法不在 R5 字面豁免内），不含运行时租户数据  | 不动     | 未登记                          |
| `src/packs/travel/console-pack.ts:7`                | `route`                    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/console-pack.ts:242`              | `hotel`                    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/console-pack.ts:289`              | `travelStages`             | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/console-pack.ts:299`              | `travel`                   | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:15`                      | `LUNAR_HOLIDAYS`           | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:21`                      | `SOLAR_HOLIDAYS`           | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:22`                      | `HOLIDAY_ALIAS`            | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:27`                      | `HOLIDAY_DAYS`             | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:56`                      | `NEW_YEAR_SAID`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:60`                      | `NEW_YEAR_SAID_ALL`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:86`                      | `travelDatePolicy`         | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:100`                     | `HOLIDAY_MONTHS`           | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dates.ts:120`                     | `travelMonthPolicy`        | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dejargon-vocab.ts:11`             | `EN_JARGON`                | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dejargon-vocab.ts:56`             | `INTERNAL_TERMS`           | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/dejargon-vocab.ts:68`             | `dejargonVocab`            | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/followup.ts:5`                    | `IDLE_MINUTES`             | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/followup.ts:15`                   | `TEMPLATE`                 | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/followup.ts:31`                   | `followupTemplates`        | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:5`               | `TRAD`                     | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:169`             | `TRAD_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:172`             | `COND`                     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:175`             | `HEARSAY`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:179`             | `PAST`                     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:183`             | `PAST_CUT`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:186`             | `HEARSAY_CUT`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:189`             | `NOW_LEAD`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:192`             | `ASKING_TAIL`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:194`             | `ASKING_WORDS`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:198`             | `NOT_A_QUESTION`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:201`             | `NEG_BEFORE`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:245`             | `E_ALTITUDE_MARKER`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:249`             | `E_ALTITUDE_OVERLAP`       | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:252`             | `EMERGENCY_RULES`          | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:310`             | `CARELESS`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:314`             | `E_HYPO`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:318`             | `E_PRETRIP`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:323`             | `E_NEAR`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:334`             | `E_HABIT`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:337`             | `E_PRICE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:341`             | `E_JOKE`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:344`             | `E_POLICY`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:347`             | `E_HEARSAY`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:355`             | `E_NEG_BEFORE`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:358`             | `E_UNSURE`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:362`             | `E_EXAGGERATE`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:366`             | `E_AFTER_SKIP`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:369`             | `E_ATTACHED`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:373`             | `E_HAPPENED_BEFORE`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:376`             | `E_FEVER`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:379`             | `E_NOW`                    | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:382`             | `E_ONGOING`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:386`             | `E_FALL_HURT`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:390`             | `E_FALL_THING`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:393`             | `E_VEHICLE_STUCK`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:396`             | `E_WOUND`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:399`             | `E_FINE_AFTER`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:403`             | `E_TRAPPED_AT`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:406`             | `E_TRAPPED_ABSTRACT`       | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:409`             | `E_NOT_STUCK`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:412`             | `E_ELSEWHERE`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:415`             | `E_RESCUE_LEAD`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:419`             | `E_HELP`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:422`             | `E_IDENTITY`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:424`             | `E_GREETING`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:427`             | `E_UNKNOWN`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:430`             | `E_ASKING`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:434`             | `E_EVERY`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:437`             | `E_ARRANGE`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:441`             | `COMPANION_PHRASE`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:455`             | `PARTY_MENTION`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:462`             | `OTHER_MENTION`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:470`             | `NOT_SUBJECT_LEAD`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:473`             | `FAMILY_LEAD`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:476`             | `THIRD_PARTY`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:508`             | `ASK_TAIL`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:511`             | `EMBEDDED`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:515`             | `DEPENDS_LEAD`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:522`             | `ASK_WORDS`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:534`             | `EVERY_AFTER`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:536`             | `EVERY_ANOTA_AFTER`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:539`             | `NOT_ASKING_REST`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:562`             | `US`                       | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:566`             | `OWNED_BY_US`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:569`             | `OWNED_KIND`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:572`             | `SELF`                     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:575`             | `OTHERS`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:579`             | `OBJECT_LEAD`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:582`             | `OTHER_AGENCY`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:586`             | `JOKE`                     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:589`             | `DOUBT_WORD`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:592`             | `STRONG_DIRECTED`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:596`             | `INSULT`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:600`             | `STUPID`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:604`             | `INSULT_TARGET_AFTER`      | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:608`             | `INSULT_OBJECT`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:611`             | `BARE_FILLER`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:613`             | `BARE_INSULT`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:617`             | `BROKEN`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:620`             | `INTENSIFIER`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:623`             | `WEAK`                     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:627`             | `SLOW_PACE`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:630`             | `WEAK_US_BEFORE`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:633`             | `WEAK_RHETORICAL`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:637`             | `REPEAT_SAID`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:639`             | `PEOPLE`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:643`             | `WEAK_DIRECTED`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:646`             | `POSITIVE_BEFORE`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:650`             | `WORRY_BEFORE`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:653`             | `SEG_ASKING`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:655`             | `COMPLAINT_TAG`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:658`             | `ONLY_US`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:664`             | `HEALTH`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:668`             | `PERSON`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:674`             | `CHILD_AGE_AFTER`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:676`             | `CHILD_AGE_BEFORE`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:679`             | `SCHOOL`                   | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:681`             | `CHILD_RE`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:691`             | `WITHDRAW`                 | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:701`             | `POLITE_ASK`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:703`             | `POLICY_ASK`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:706`             | `NOT_WANTED`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/handoff-vocab.ts:708`             | `handoffVocab`             | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/insight.ts:4`                     | `REACH`                    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/insight.ts:15`                    | `DRAFT_FALLBACK`           | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/insight.ts:26`                    | `insightPrompts`           | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/itinerary.ts:26`                  | `CUSTOM_PROMISE`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/itinerary.ts:36`                  | `CUSTOM_FOLLOWUP`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/itinerary.ts:42`                  | `DAY_MARK`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/itinerary.ts:44`                  | `NIGHTS_MARK`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/itinerary.ts:46`                  | `NUMBERED_LINE`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/itinerary.ts:54`                  | `TARGET_DAYS`              | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/itinerary.ts:55`                  | `ANY_DAYS`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/mock.ts:10`                       | `DESTINATIONS`             | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/mock.ts:44`                       | `CN_NUM`                   | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/mock.ts:225`                      | `travelMock`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:17`                   | `STAGE_RANK`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:32`                   | `OBJECTION_INTENT`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:83`                   | `SEGMENT_RULES`            | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:98`                   | `NOT_TRAVELLING`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:128`                  | `BUDGET_RE`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:131`                  | `BUDGET_NOT_CAP_AFTER`     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:133`                  | `BUDGET_NOT_CAP_BEFORE`    | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:141`                  | `MONEY_NOT_BUDGET`         | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:142`                  | `PAST_SPEND`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:143`                  | `PRICE_REMARK`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/progress.ts:144`                  | `MONEY_AT`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/packs/travel/quick-reply-defaults.ts:7`        | `travelQuickReplyDefaults` | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/runtime.ts:35`                    | `thresholds`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/stages.ts:4`                      | `runtimeStages`            | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/templates.ts:11`                  | `travelTemplates`          | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/thresholds.ts:11`                 | `travelPriceThresholds`    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/packs/travel/tool-defs.ts:4`                   | `toolDefs`                 | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/payment/orders.ts:37`                          | `SEED_SESSION_RE`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/price-guard.ts:18`                             | `__priceGuardTest`         | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/price-rules.ts:7`                              | `BUDGET_LIFTED`            | 有状态实例 / RegExp            | 实例级   | 04 永久旧旅游门面；依赖是调用时读配置的能力，不是已发布租户快照  | 不动     | 未登记                          |
| `src/price-rules.ts:7`                              | `__priceRulesTest`         | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/privacy/privacy.ts:14`                         | `current`                  | let / 可替换绑定               | 租户状态 | `privacy.current`                                                | 7        | 未登记                          |
| `src/privacy/privacy.ts:15`                         | `pollTimer`                | let / 定时器句柄               | 租户状态 | `privacy.pollTimer`                                              | 7        | 未登记                          |
| `src/privacy/privacy.ts:68`                         | `__privacyTest`            | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/profile.ts:73`                                 | `BOOL_FLAGS`               | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/profile.ts:76`                                 | `PROFILE_ENV_NAMES`        | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/profile.ts:79`                                 | `WECOM_CREDENTIAL_ENV`     | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/profile.ts:134`                                | `current`                  | let / 可替换绑定               | 实例级   | 部署 profile 属于进程角色（R5）                                  | 不动     | 已登记                          |
| `src/profile.ts:142`                                | `__profileTest`            | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/quota/ledger.ts:87`                            | `RECEIPT_INBOX_RETRY_MS`   | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/quota/ledger.ts:92`                            | `waits`                    | 对象字典                       | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/quota/ledger.ts:179`                           | `bySession`                | Map                            | 租户状态 | `ledger.bySession`                                               | 7        | 已登记                          |
| `src/quota/ledger.ts:180`                           | `byMsgid`                  | Map                            | 租户状态 | `ledger.byMsgid`                                                 | 7        | 已登记                          |
| `src/quota/ledger.ts:182`                           | `holds`                    | Map                            | 租户状态 | `ledger.holds`                                                   | 7        | 已登记                          |
| `src/quota/ledger.ts:184`                           | `awaitingSeq`              | Map                            | 租户状态 | `ledger.awaitingSeq`                                             | 7        | 已登记                          |
| `src/quota/ledger.ts:186`                           | `pendingWrites`            | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/quota/ledger.ts:189`                           | `COUNTED`                  | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/quota/ledger.ts:366`                           | `settledListeners`         | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 不动     | 未登记                          |
| `src/quota/ledger.ts:473`                           | `PLAN_KINDS`               | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/quota/ledger.ts:474`                           | `UUID_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/quota/ledger.ts:475`                           | `MSGID_RE`                 | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/quota/ledger.ts:527`                           | `planRejectedListeners`    | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 不动     | 未登记                          |
| `src/quota/ledger.ts:741`                           | `markHook`                 | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 已登记                          |
| `src/quota/ledger.ts:742`                           | `planHook`                 | let / 数组                     | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 已登记                          |
| `src/quota/ledger.ts:783`                           | `NO_MORE_SENDS`            | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/quota/ledger.ts:950`                           | `unsafeAt`                 | let / 数组                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 已登记                          |
| `src/quota/ledger.ts:951`                           | `unsafeListeners`          | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 不动     | 未登记                          |
| `src/quota/ledger.ts:1180`                          | `__ledgerTest`             | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/server.ts:95`                                  | `app`                      | 有状态实例                     | 实例级   | 静态路由 / 权限能力表，不存租户认证结果；请求入口另建作用域      | 不动     | 未登记                          |
| `src/server.ts:142`                                 | `DEMO_DATA_RE`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/server.ts:144`                                 | `SEED_SESSION_RE`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/server.ts:157`                                 | `OWN_SIM_RE`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/server.ts:348`                                 | `SIM_SESSION_RE`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/server.ts:356`                                 | `chatRateLimited`          | 工厂闭包                       | 实例级   | IP 限流保护整个进程（R5），闭包含 hits 与清理定时器              | 不动     | 未登记                          |
| `src/server.ts:941`                                 | `SIMULATOR_PAGE_RE`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/shared/audit-text.ts:333`                      | `MERGEABLE`                | Set                            | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/audit-text.ts:335`                      | `WRITES_VERSION`           | Set                            | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/audit-text.ts:343`                      | `absorbedVersion`          | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/shared/catalog-csv.ts:58`                      | `schemaShapes`             | Map                            | 实例级   | 按静态 CatalogKind 缓存 schema 形状，不含产品条目                | 不动     | 未登记                          |
| `src/shared/catalog-csv.ts:165`                     | `FORMULA_START`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/shared/catalog-csv.ts:322`                     | `utf8`                     | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/catalog-types.ts:6`                     | `SALES_SEGMENTS`           | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/catalog.ts:12`                          | `CATALOG_CODE`             | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/shared/catalog.ts:16`                          | `text`                     | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/catalog.ts:17`                          | `texts`                    | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/catalog.ts:18`                          | `int`                      | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/catalog.ts:20`                          | `ItineraryDay`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/catalog.ts:29`                          | `RouteSchema`              | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/catalog.ts:58`                          | `HotelSchema`              | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:33`                      | `str`                      | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:37`                      | `jsonObject`               | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:39`                      | `LoginBody`                | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:44`                      | `VersionsQuery`            | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:51`                      | `SaveDraftBody`            | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:65`                      | `RevBody`                  | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:67`                      | `PublishBody`              | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:69`                      | `RollbackBody`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:71`                      | `CatalogKindParam`         | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:72`                      | `CatalogItemParam`         | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:74`                      | `CreateItemBody`           | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:77`                      | `ImportCsvBody`            | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:80`                      | `PatchItemBody`            | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:91`                      | `ConvQuery`                | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:114`                     | `AuditQuery`               | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:132`                     | `MetricsQuery`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:137`                     | `ReplyBody`                | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:139`                     | `TakeoverBody`             | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:140`                     | `CancelOrderBody`          | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:142`                     | `MessagesQuery`            | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:143`                     | `OrdersQuery`              | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:153`                     | `MARKDOWN_BLOCK_RE`        | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/shared/console-api.ts:161`                     | `SINGLE_STAR_RE`           | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/shared/console-api.ts:162`                     | `SINGLE_UNDERSCORE_RE`     | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/shared/console-api.ts:171`                     | `QuickReplyBody`           | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/console-api.ts:178`                     | `MoveBody`                 | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/shared/conversation-types.ts:63`               | `DELIVERY_RANK`            | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/conversation.ts:53`                     | `HEADCOUNT`                | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/shared/conversation.ts:128`                    | `HANDOFF_NOTICE_TEXT`      | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/conversation.ts:146`                    | `CHANNEL_SHORT`            | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/pack-fixtures/renovation-l-page.ts:8`   | `pkg`                      | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/pack-fixtures/renovation-l-page.ts:112` | `material`                 | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/pack-fixtures/renovation-l-page.ts:155` | `renovationLPage`          | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/pack-fixtures/renovation.ts:11`         | `pkg`                      | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/pack-fixtures/renovation.ts:124`        | `material`                 | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/pack-fixtures/renovation.ts:176`        | `renovation`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/pack.ts:209`                            | `SYSTEM_KEYS`              | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/security-headers.ts:31`                 | `ASSET_TYPES`              | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:12`                        | `ROLE_LABEL`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:27`                        | `SOP_CHECK_LABEL`          | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:38`                        | `SOP_CHECKS`               | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:76`                        | `AUDIT_ACTIONS`            | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:145`                       | `ACTOR_KIND_LABEL`         | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:151`                       | `CLI_ACTOR_LABEL`          | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:160`                       | `RERENDER_CAUSE_LABEL`     | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:178`                       | `ERROR_ACTION_LABEL`       | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:207`                       | `ERROR_COPY`               | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:283`                       | `NETWORK_COPY`             | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shared/ui-labels.ts:285`                       | `FALLBACK_COPY`            | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shutdown.ts:12`                                | `PHASES`                   | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shutdown.ts:17`                                | `hooks`                    | 数组                           | 实例级   | 进程停机编排；租户钩子归所属 rt，drop 注销（见表后）             | 6        | 未登记                          |
| `src/shutdown.ts:29`                                | `SHARE`                    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/shutdown.ts:68`                                | `shuttingDown`             | let / 可替换绑定               | 实例级   | 进程停机编排；租户钩子由第 6 步逐运行时执行                      | 不动     | 未登记                          |
| `src/sop/contract.ts:26`                            | `SNAKE`                    | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/sop/contract.ts:28`                            | `CAMEL`                    | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/store.ts:82`                                   | `storeEvents`              | 事件发射器                     | 租户状态 | `store.storeEvents`                                              | 9        | 未登记                          |
| `src/store.ts:90`                                   | `incidentHooks`            | Set                            | 租户状态 | `store.incidentHooks`                                            | 9        | 未登记                          |
| `src/store.ts:113`                                  | `sessions`                 | Map                            | 租户状态 | `store.sessions`                                                 | 6        | 已登记                          |
| `src/store.ts:114`                                  | `orders`                   | Map                            | 租户状态 | `store.orders`                                                   | 6        | 已登记                          |
| `src/store.ts:116`                                  | `tombstoned`               | WeakSet                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/store.ts:119`                                  | `pgBackend`                | let / 可替换绑定               | 租户状态 | `store.pgBackend`                                                | 6        | 部分：forget 会话；不撤后端绑定 |
| `src/store.ts:121`                                  | `fileBackend`              | 对象字典                       | 租户状态 | `store.fileBackend`                                              | 6        | 部分：flushNow；工厂状态见下表  |
| `src/store.ts:141`                                  | `changeTimer`              | let / 定时器句柄               | 租户状态 | `store.changeTimer`                                              | 9        | 已登记                          |
| `src/store.ts:297`                                  | `detachedAudit`            | 工厂闭包 / snapshot            | 实例级   | 保存模块装载上下文；第 6 步恢复后重建租户作用域（R3）            | 6        | 未登记                          |
| `src/store.ts:363`                                  | `forgetSessionProbe`       | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 未登记                          |
| `src/store.ts:408`                                  | `saveHooks`                | Set                            | 租户状态 | `store.saveHooks`                                                | 9        | 未登记                          |
| `src/store.ts:436`                                  | `outboundCommitHooks`      | Set                            | 租户状态 | `store.outboundCommitHooks`                                      | 9        | 未登记                          |
| `src/store.ts:488`                                  | `UUID_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/store.ts:489`                                  | `INBOX_CHANGE_STATES`      | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/store.ts:587`                                  | `DEMO_SESSION_RE`          | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/store.ts:628`                                  | `VISITOR_SESSION_RE`       | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/store.ts:873`                                  | `__storeTest`              | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/store/events.ts:24`                            | `subscribers`              | Set                            | 租户状态 | `domain.subscribers`                                             | 9        | 未登记                          |
| `src/store/events.ts:48`                            | `unsavedSubscribers`       | Set                            | 租户状态 | `domain.unsavedSubscribers`                                      | 9        | 未登记                          |
| `src/store/pg-backend.ts:64`                        | `detached`                 | 工厂闭包 / snapshot            | 实例级   | 保存模块装载上下文；第 6 步恢复后重建租户作用域（R3）            | 6        | 未登记                          |
| `src/store/pg-backend.ts:71`                        | `RETRY_MS`                 | 数组                           | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/store/pg-backend.ts:229`                       | `MAIN_TX_OUTBOUND`         | 有状态实例                     | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/store/project.ts:14`                           | `SPILL_FILE_RE`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/store/project.ts:16`                           | `DEMO_CLASS_RE`            | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/store/project.ts:201`                          | `AUTHORS`                  | Set                            | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/store/project.ts:202`                          | `UUID_RE`                  | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/store/seq.ts:23`                               | `seqs`                     | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/store/seq.ts:24`                               | `states`                   | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/store/seq.ts:25`                               | `resets`                   | WeakSet                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/store/seq.ts:38`                               | `turns`                    | WeakMap                        | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/tools.ts:21`                                   | `travelTools`              | 数组                           | 实例级   | 04 永久旧旅游门面；依赖是调用时读配置的能力，不是已发布租户快照  | 不动     | 未登记                          |
| `src/tools.ts:22`                                   | `registry`                 | 数组                           | 实例级   | 04 永久旧旅游门面；依赖是调用时读配置的能力，不是已发布租户快照  | 不动     | 未登记                          |
| `src/trace/recorder.ts:115`                         | `turns`                    | 有状态实例 / AsyncLocalStorage | 按对象键 | 按对象 / 每轮作用域；R5、进程内状态表                            | 不动     | 未登记                          |
| `src/trace/recorder.ts:200`                         | `HOLE_MARKS`               | 有状态实例 / RegExp            | 实例级   | 固定解析规则；lastIndex 仅在同步解析调用中使用，不存租户数据     | 不动     | 未登记                          |
| `src/trace/recorder.ts:364`                         | `endObservers`             | Set                            | 实例级   | 观测接线；租户订阅只收同租户事件，drop 注销（见表后）            | 7        | 未登记                          |
| `src/trace/usage-daily.ts:30`                       | `acc`                      | Map                            | 租户状态 | `usage.daily.acc`                                                | 10       | 已登记                          |
| `src/trace/usage-daily.ts:31`                       | `writer`                   | let / 数组                     | 租户状态 | `usage.daily.writer`                                             | 10       | 未登记                          |
| `src/trace/usage-daily.ts:32`                       | `timer`                    | let / 定时器句柄               | 租户状态 | `usage.daily.timer`                                              | 10       | 已登记                          |
| `src/trace/usage-daily.ts:34`                       | `chain`                    | let / 可替换绑定               | 租户状态 | `usage.daily.chain`                                              | 10       | 已登记                          |
| `src/trace/usage-daily.ts:35`                       | `lastDay`                  | let / 可替换绑定               | 租户状态 | `usage.daily.lastDay`                                            | 10       | 已登记                          |
| `src/trace/usage-daily.ts:126`                      | `armedMs`                  | let / 可替换绑定               | 实例级   | 进程测试时钟 / 时序配置 / 测试接线，不保存生产租户数据           | 不动     | 已登记                          |
| `src/trace/usage-daily.ts:135`                      | `__usageDailyTest`         | 数组                           | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |
| `src/usage.ts:29`                                   | `PRICE`                    | 对象字典                       | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 未登记                          |
| `src/usage.ts:59`                                   | `warnedUnknown`            | Set                            | 实例级   | 固定规则、词表或能力对象；无按租户变化的业务数据                 | 不动     | 已登记                          |
| `src/usage.ts:88`                                   | `state`                    | let / 可替换绑定               | 租户状态 | `usage.host.state`                                               | 10       | 已登记                          |
| `src/usage.ts:98`                                   | `timer`                    | let / 定时器句柄               | 租户状态 | `usage.host.timer`                                               | 10       | 已登记                          |
| `src/usage.ts:150`                                  | `usageListeners`           | Set                            | 实例级   | 进程观测订阅接线；事件发出方须保留租户作用域，订阅不得捕获宿主值 | 不动     | 未登记                          |
| `src/web/routes.ts:32`                              | `cid`                      | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/web/routes.ts:36`                              | `bodySchema`               | 工厂实例 / 静态 schema         | 实例级   | 静态校验 / 查询元数据，不含数据库行或租户快照                    | 不动     | 未登记                          |
| `src/web/routes.ts:42`                              | `processing`               | Set                            | 租户状态 | `web.routes.processing`                                          | 9        | 未登记                          |
| `src/web/routes.ts:43`                              | `streams`                  | Set                            | 实例级   | 实例 SSE 数量 / 关闭集合；连接归请求 rt，关闭释放（见表后）      | 9        | 未登记                          |
| `src/web/routes.ts:44`                              | `messageLimited`           | 工厂闭包                       | 实例级   | IP 限流保护整个进程（R5），闭包含 hits 与清理定时器              | 不动     | 未登记                          |
| `src/web/routes.ts:45`                              | `newIpHits`                | Map                            | 实例级   | IP 限流保护整个进程（R5），闭包含 hits 与清理定时器              | 不动     | 未登记                          |
| `src/web/routes.ts:47`                              | `dailyCounts`              | Map                            | 租户状态 | `web.routes.dailyCounts`                                         | 9        | 未登记                          |
| `src/web/routes.ts:114`                             | `webRoutes`                | 有状态实例                     | 实例级   | 静态路由 / 权限能力表，不存租户认证结果；请求入口另建作用域      | 不动     | 未登记                          |
| `src/web/routes.ts:330`                             | `__webTest`                | 对象字典                       | 实例级   | 自测能力出口；本对象不另存租户数据，所读写状态按各自条目归类     | 不动     | 未登记                          |

分类小计：租户状态 95、实例级 581、按对象键 14。

**工厂 / 类字段的覆盖（不重复计入上面的模块绑定数）**：模块实例登记必须覆盖其内部，不得只清一个外壳引用。下列是持久存活状态的事实归属，不把每轮局部 Map 加进模块总数。

| 所属模块绑定 / 出处                                                                                         | 内部状态与 R5 归类                                                                                                                                                                                                                                                                             | isolation 覆盖                                                                                                                | 改动步骤                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `store.fileBackend`；`src/store/file-backend.ts:44`                                                         | `dirty` Map、`:45` `pendingEvents` 数组、`:46` `waiters` Set、`:47` `lastError`、`:48` `saveTimer`；宿主租户状态，由 `store.fileBackend` 登记覆盖                                                                                                                                              | flushNow 间接清已成功提交的 dirty / events / waiters；失败状态与 timer 不是完整 reset                                         | 6                          |
| `store.pgBackend`；`src/store/pg-backend.ts:964`                                                            | `entries` Map、`:966` `preRefs` Map、`:968` `adopted` Set、`:970` `voidedIds` Set、`:971` `conflict`、`:972` `closed`、`:973` `lastError`、`:974` `stats`；各 Entry 的排队数组、Map、Set、计时器与 promise 都属该租户后端                                                                      | entries / preRefs / adopted / voidedIds / conflict / lastError / stats 已清，entries 的在途检查与 timer 已处理；closed 未重置 | 6；spill 路径 9            |
| `wecom.runtimes` / `wecom.envRuntime`；`src/adapters/wecom.ts:250`                                          | issuedWelcomeTexts、token / tokenInflight / 到期、thumbCache / inflight / 冷却、welcomeBackAt、userChains、eventTasks、haltedChains、syncTask / pendingRequested / pendingToken、readyPromise、recovery / gate、pollTimer、stopping / sendsClosedAt 与观测时刻；账号所属租户状态，env 只属宿主 | 未登记                                                                                                                        | 9                          |
| `wecom.envRuntime.state`；`src/adapters/wecom-state.ts:99`、`src/channels/inbox.ts:169`                     | FileWecomState 的 cursor、coldStartCutoff、handled、inflight、saveChain 与 stateSaveTimer；AccountInbox 的 account、cursor、coldStartCutoff 与 recordOnlyUntil；由各账号运行时覆盖                                                                                                             | 未登记                                                                                                                        | 9                          |
| `wecom.*.gate`；`src/channels/recovery.ts:51`                                                               | RecoveryGate 的 opened / waiters，归账号运行时；等待 timeout 归请求                                                                                                                                                                                                                            | 未登记                                                                                                                        | 9                          |
| `channels.registry.registry`；`src/channels/registry.ts:78`                                                 | mode、wecomState、channels ReadonlyMap、warnings 数组与 db；值属于各账号的租户，由 registry 登记覆盖                                                                                                                                                                                           | 未登记                                                                                                                        | 9                          |
| `auth.session` 四个 Window；`src/auth/session.ts:55`                                                        | 各自 map（键为 IP / 邮箱，值含 start / count），超键按 LRU 淘汰；认证攻击资源保护，实例级                                                                                                                                                                                                      | 未登记                                                                                                                        | 不动                       |
| `lookupRateLimited` / `chatRateLimited` / `messageLimited`；`src/http-guards.ts:68`                         | makeLimiter 内 hits Map 与清理定时器；实例级 IP 资源保护                                                                                                                                                                                                                                       | 未登记                                                                                                                        | 不动；入口的空作用域接线 6 |
| `warnExport` / `warnBuild` / `warnFlush`；`src/otel/export.ts:62`                                           | throttled 内 last / suppressed（:63 / :64）；实例级导出器节流                                                                                                                                                                                                                                  | 未登记                                                                                                                        | 不动                       |
| `packs.registry.legacyTravel`、`tools.registry`；`src/packs/registry.ts:39`、`src/core/tools/registry.ts:5` | 工厂能力对象 / byName Map / defs 数组是旧旅游声明与调用时取配置的能力；实例级，不持已发布租户快照；每次 execute 的参数和返回值不缓存于模块                                                                                                                                                     | 未登记                                                                                                                        | 不动                       |

**告警状态的租户边界（第 7 步）**：`alert.states` 的去重键当前在 `src/ops/alert.ts:144` 只拼告警类型与 scope；账号 key 只在租户内唯一，按账号的失败记录（`:206`）、入站原因计数（`:269`）与按会话的 poisoned 集合（`:330`）也不能跨租户共享。上述四项按所属运行时或 tenantId 分开登记，drop / reset 清所属租户；实例告警的去重键须与租户键区分，不能借用某个租户。`sentAt`、`lastThrottleLog`、发送在途 `inflight` 的总量限流与发送生命周期仍属实例级，不随单租户 drop 清掉。

**持有租户闭包的实例集合（R3、R5、R12）**：保留实例级不等于租户引用可常驻，也不等于任意事件可广播给所有租户。下列归属、派发与注销责任在第 6、7、9 步落实，第 18 步删除按 R12 复核释放；当前代码尚未完整实现这些责任。

| 集合 / 出处                                                 | 回调的租户归属与隔离                                                                                                                                                             | 注销责任 / R12 释放证据                                                                                                                                                                                                  | 改动步骤   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `shutdown.hooks`；`src/shutdown.ts:17`、`:21`               | 实例设施钩子无租户；捕获 store backend / writer 的钩子属于装载它的 rt（如 `src/store.ts:236`）。全进程停机逐 rt 在所属作用域执行；单租户关闭只执行该 rt 的钩子，不派发给别的租户 | 注册方保存注销责任；rt 关闭 / drop 后从 hooks 移除其回调。仅调用 `src/store/pg-backend.ts:1970` 的 close 不会释放集合。删除验证该 rt 的钩子引用数为 0，后续停机不再调用其 backend / writer                               | 6；18 复核 |
| `endObservers`；`src/trace/recorder.ts:364`、`:370`、`:418` | 实例观测器按 R19 保留；网页请求的观察器捕获 s，归请求 rt（`src/web/routes.ts:190`）。派发给租户观察器时同时匹配 tenantId 与 conversationId，只给同租户；执行时保留发出方作用域   | 请求方在结束时调用 unsubscribe；rt 关闭 / drop 负责摘掉仍在途的所属订阅。删除验证该 rt 的观察器引用数为 0；其他租户的同 id 结束事件不触发旧回调                                                                          | 7；18 复核 |
| 网页 `streams`；`src/web/routes.ts:43`、`:279`、`:296`      | 每个连接闭包捕获请求、会话订阅、心跳 timer，归建立连接的请求 rt。消息只派发到同租户连接；实例巡检 / 总量关闭可遍历集合，但逐连接保留所属 rt                                      | 请求 abort / cancel、连接关闭与 rt drop 都由连接 close 释放；沿 `src/web/routes.ts:251` 的清理职责注销订阅、清 timer、移除 abort 监听并从 streams 删除。删除验证所属连接 / 订阅 / timer 引用均为 0，其他租户连接不受影响 | 9；18 复核 |

强引用的 `ledger.holds`、`ledger.awaitingSeq` 虽以 ChatMessage 对象为键，值仍持发送行与计时器，且支持遍历，不按弱引用豁免：归租户账本、随 drop 清理。`pendingWrites` 等 WeakMap 按对象键不动。检索的共享只读缓存按 spec（指纹、模型）共享，当前 index / building / generation / retry 仍包含当前目录的引用与代次，归第 7 步逐租户改；不要把今天的单个 index 标成可无条件全实例共享。

#### 2. 入口

主表 **164 个入口**，表外 **40 个入口**（含 18 个 CLI 命令启动点、共用 main 与迁移命令）。以下按具体注册点、恢复点或派发点列出。HTTP 路由在共同中间件下继承作用域（R4 解析之后）；表中的新作用域位置指 spec / plan 已定的工作归属，不设计额外接口。实例定时器与监听注册用 `withoutTenantScope`（R3），访问租户的回调再显式进入运行时。局部等待 / abort 也列出，以便区分“继承请求作用域”和“后台业务入口”。

| 出处                                 | 入口 / 回调                                                      | 今天的租户来源                                                | 05 的作用域位置                                                                                                                                | 改动步骤  |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `src/adapters/wecom-state.ts:181`    | setTimeout                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 每账号回调 / 轮询进所属 rt；体验客服解析绑定后才进沙箱（R21）                                                                                  | 9         |
| `src/adapters/wecom.ts:849`          | setTimeout                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 每账号回调 / 轮询进所属 rt；体验客服解析绑定后才进沙箱（R21）                                                                                  | 9         |
| `src/adapters/wecom.ts:913`          | setTimeout                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 每账号回调 / 轮询进所属 rt；体验客服解析绑定后才进沙箱（R21）                                                                                  | 9         |
| `src/adapters/wecom.ts:1190`         | setTimeout                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 每账号回调 / 轮询进所属 rt；体验客服解析绑定后才进沙箱（R21）                                                                                  | 9         |
| `src/adapters/wecom.ts:2114`         | setTimeout                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 每账号回调 / 轮询进所属 rt；体验客服解析绑定后才进沙箱（R21）                                                                                  | 9         |
| `src/adapters/wecom.ts:2621`         | setTimeout                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 每账号回调 / 轮询进所属 rt；体验客服解析绑定后才进沙箱（R21）                                                                                  | 9         |
| `src/adapters/wecom.ts:2658`         | setTimeout                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 每账号回调 / 轮询进所属 rt；体验客服解析绑定后才进沙箱（R21）                                                                                  | 9         |
| `src/adapters/wecom.ts:2783`         | onShutdown                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 遍历账号，逐所属租户进入作用域（R3）；沙箱第三种由 R21 接入                                                                                    | 9         |
| `src/adapters/wecom.ts:2788`         | process.on                                                       | rt.tenantId；envRuntime 为空 id、实际属宿主                   | 遍历账号，逐所属租户进入作用域（R3）；沙箱第三种由 R21 接入                                                                                    | 9         |
| `src/auth/password.ts:37`            | setTimeout                                                       | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/auth/session.ts:155`            | setTimeout                                                       | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/budget.ts:42`                   | setTimeout                                                       | 宿主 JSON 状态                                                | 只在宿主运行时装载与刷写；实例注册不继承首个请求的租户                                                                                         | 10        |
| `src/channels/recovery.ts:75`        | setTimeout                                                       | registry / account 所属租户（当前只有一个）                   | 巡检在空作用域挂；逐账号进入所属 rt；局部 timeout 继承账号调用                                                                                 | 9         |
| `src/channels/registry.ts:121`       | setInterval                                                      | registry / account 所属租户（当前只有一个）                   | 巡检在空作用域挂；逐账号进入所属 rt；局部 timeout 继承账号调用                                                                                 | 9         |
| `src/channels/registry.ts:125`       | onShutdown                                                       | registry / account 所属租户（当前只有一个）                   | 巡检在空作用域挂；逐账号进入所属 rt；局部 timeout 继承账号调用                                                                                 | 9         |
| `src/channels/registry.ts:496`       | setTimeout                                                       | registry / account 所属租户（当前只有一个）                   | 巡检在空作用域挂；逐账号进入所属 rt；局部 timeout 继承账号调用                                                                                 | 9         |
| `src/config/source.ts:846`           | setTimeout                                                       | loaded.tenantId                                               | 各 runtime 的锁回调 / 重取 / 重载保持该 rt 作用域                                                                                              | 6         |
| `src/config/source.ts:950`           | setTimeout                                                       | loaded.tenantId                                               | 各 runtime 的锁回调 / 重取 / 重载保持该 rt 作用域                                                                                              | 6         |
| `src/console-api/app.ts:399`         | HTTP 中间件链（日志、安全头、DB 检查、loadSession、guardWrites） | loadSession → 当前配置租户；SSE 捕获登录会话                  | R4 解析 / R10 cookie 后建 rt 作用域；SSE 每次复核恢复该 rt                                                                                     | 6         |
| `src/console-api/app.ts:868`         | setTimeout                                                       | loadSession → 当前配置租户；SSE 捕获登录会话                  | R4 解析 / R10 cookie 后建 rt 作用域；SSE 每次复核恢复该 rt                                                                                     | 6         |
| `src/console-api/app.ts:875`         | stream.onAbort                                                   | loadSession → 当前配置租户；SSE 捕获登录会话                  | R4 解析 / R10 cookie 后建 rt 作用域；SSE 每次复核恢复该 rt                                                                                     | 6         |
| `src/console-api/events.ts:48`       | setTimeout                                                       | 唯一事件环 / countsOf                                         | 每 rt 事件环；提交 relay 沿发出方作用域，counts 去抖显式进所属 rt                                                                              | 9         |
| `src/console-api/events.ts:98`       | onCommitted                                                      | 唯一事件环 / countsOf                                         | 每 rt 事件环；提交 relay 沿发出方作用域，counts 去抖显式进所属 rt                                                                              | 9         |
| `src/console-api/host.ts:41`         | 静态资源压缩中间件                                               | 静态资源无租户                                                | 不需要租户状态；经过 Host / 角色路由保护                                                                                                       | 不动      |
| `src/core/engine/index.ts:144`       | onToolCall                                                       | 当前轮次 ALS（未有租户 ALS）                                  | 发出方 / 当前轮次作用域；进程观测监听在空作用域注册                                                                                            | 7         |
| `src/core/engine/sources.ts:42`      | installRuntimeSources                                            | 调用时读配置的能力接线                                        | 接线不读租户值；加载 runtime 时 pack/config 写入所属 rt                                                                                        | 6         |
| `src/core/followup.ts:171`           | onShutdown                                                       | 当前 store / 配置的唯一租户                                   | 宿主每拍逐 standard rt 进入作用域；扫描器只在宿主，提交钩子沿发出方作用域                                                                      | 9         |
| `src/core/followup.ts:275`           | setInterval                                                      | 当前 store / 配置的唯一租户                                   | 宿主每拍逐 standard rt 进入作用域；扫描器只在宿主，提交钩子沿发出方作用域                                                                      | 9         |
| `src/core/llm/client.ts:417`         | setTimeout                                                       | 发起模型调用的轮次                                            | 对冲 timer 继承该 rt 作用域；进程探测 / 并发资源不占租户作用域                                                                                 | 10        |
| `src/core/retrieval.ts:148`          | setTimeout                                                       | 当前目录单例                                                  | 索引重试进入引用该索引的 rt；catalog 监听在发出方作用域同步执行                                                                                | 7         |
| `src/core/retrieval.ts:230`          | onCatalogChanged                                                 | 当前目录单例                                                  | 索引重试进入引用该索引的 rt；catalog 监听在发出方作用域同步执行                                                                                | 7         |
| `src/db/client.ts:78`                | pool.on                                                          | 锁连接 owner / 实例连接池                                     | pool 日志监听为空作用域；锁 onLost 显式进入锁所属 rt（R2、R3）                                                                                 | 6         |
| `src/db/client.ts:81`                | pool.on                                                          | 锁连接 owner / 实例连接池                                     | pool 日志监听为空作用域；锁 onLost 显式进入锁所属 rt（R2、R3）                                                                                 | 6         |
| `src/db/client.ts:82`                | client.on                                                        | 锁连接 owner / 实例连接池                                     | pool 日志监听为空作用域；锁 onLost 显式进入锁所属 rt（R2、R3）                                                                                 | 6         |
| `src/db/client.ts:263`               | c.on                                                             | 锁连接 owner / 实例连接池                                     | pool 日志监听为空作用域；锁 onLost 显式进入锁所属 rt（R2、R3）                                                                                 | 6         |
| `src/db/client.ts:296`               | c.on                                                             | 锁连接 owner / 实例连接池                                     | pool 日志监听为空作用域；锁 onLost 显式进入锁所属 rt（R2、R3）                                                                                 | 6         |
| `src/db/client.ts:297`               | c.on                                                             | 锁连接 owner / 实例连接池                                     | pool 日志监听为空作用域；锁 onLost 显式进入锁所属 rt（R2、R3）                                                                                 | 6         |
| `src/http-guards.ts:69`              | setInterval                                                      | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/jobs/followup.ts:337`           | onSessionSaved                                                   | 当前 store / 配置的唯一租户                                   | 宿主每拍逐 standard rt 进入作用域；扫描器只在宿主，提交钩子沿发出方作用域                                                                      | 9         |
| `src/jobs/runner.ts:429`             | onShutdown                                                       | 当前 store / 配置的唯一租户                                   | 宿主每拍逐 standard rt 进入作用域；扫描器只在宿主，提交钩子沿发出方作用域                                                                      | 9         |
| `src/jobs/runner.ts:432`             | setInterval                                                      | 当前 store / 配置的唯一租户                                   | 宿主每拍逐 standard rt 进入作用域；扫描器只在宿主，提交钩子沿发出方作用域                                                                      | 9         |
| `src/jobs/runner.ts:444`             | onShutdown                                                       | 当前 store / 配置的唯一租户                                   | 宿主每拍逐 standard rt 进入作用域；扫描器只在宿主，提交钩子沿发出方作用域                                                                      | 9         |
| `src/llm-gate.ts:45`                 | signal.addEventListener                                          | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/llm-gate.ts:57`                 | setTimeout                                                       | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/llm-gate.ts:61`                 | signal.addEventListener                                          | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/notify/handoff.ts:149`          | setTimeout                                                       | 领域事件裸会话 id / 全局 store                                | 事件带 tenantId；通知与延迟重试进入所属 rt；沙箱跳过（R11）                                                                                    | 9         |
| `src/notify/handoff.ts:161`          | setTimeout                                                       | 领域事件裸会话 id / 全局 store                                | 事件带 tenantId；通知与延迟重试进入所属 rt；沙箱跳过（R11）                                                                                    | 9         |
| `src/notify/handoff.ts:217`          | onHandoffUnsaved                                                 | 领域事件裸会话 id / 全局 store                                | 事件带 tenantId；通知与延迟重试进入所属 rt；沙箱跳过（R11）                                                                                    | 9         |
| `src/notify/handoff.ts:218`          | onCommitted                                                      | 领域事件裸会话 id / 全局 store                                | 事件带 tenantId；通知与延迟重试进入所属 rt；沙箱跳过（R11）                                                                                    | 9         |
| `src/ops/alert.ts:90`                | setTimeout                                                       | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:448`               | onTurnEnd                                                        | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:449`               | onSendSettled                                                    | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:450`               | onUnsafeSend                                                     | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:451`               | onPlanRejected                                                   | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:452`               | onInboxAbandoned                                                 | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:453`               | onTokenError                                                     | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:454`               | onLockEvent                                                      | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:455`               | onStoreIncident                                                  | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:456`               | onJobFailed                                                      | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:458`               | onShutdown                                                       | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/alert.ts:471`               | setInterval                                                      | 实例汇总 + 当前配置                                           | 订阅 / 巡检为空作用域；事件发出方携带租户，沙箱过滤按 R19                                                                                      | 6         |
| `src/ops/otel.ts:55`                 | onTurnEnd                                                        | startOtelExport 时捕获 tenant                                 | 监听为空作用域注册；每次 onTurnEnd 从发出方作用域读租户（R19）                                                                                 | 7         |
| `src/otel/export.ts:119`             | onShutdown                                                       | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/otel/export.ts:152`             | setTimeout                                                       | 实例资源 / 请求携带的上下文                                   | 实例监听 / 定时器在 withoutTenantScope 中注册；局部等待沿用调用上下文                                                                          | 6         |
| `src/privacy/privacy.ts:42`          | setInterval                                                      | configRuntime 单例                                            | 宿主逐 standard rt 轮询；沙箱不轮询（R6）                                                                                                      | 7         |
| `src/quota/ledger.ts:334`            | setTimeout                                                       | 会话 / 消息对象及裸 id                                        | 提交监听沿发出方 rt；等待 / timeout 回调进入行所属 rt                                                                                          | 7         |
| `src/quota/ledger.ts:351`            | onSessionSaved                                                   | 会话 / 消息对象及裸 id                                        | 提交监听沿发出方 rt；等待 / timeout 回调进入行所属 rt                                                                                          | 7         |
| `src/quota/ledger.ts:564`            | onOutboundCommitted                                              | 会话 / 消息对象及裸 id                                        | 提交监听沿发出方 rt；等待 / timeout 回调进入行所属 rt                                                                                          | 7         |
| `src/quota/ledger.ts:700`            | setTimeout                                                       | 会话 / 消息对象及裸 id                                        | 提交监听沿发出方 rt；等待 / timeout 回调进入行所属 rt                                                                                          | 7         |
| `src/quota/ledger.ts:726`            | setTimeout                                                       | 会话 / 消息对象及裸 id                                        | 提交监听沿发出方 rt；等待 / timeout 回调进入行所属 rt                                                                                          | 7         |
| `src/quota/ledger.ts:1101`           | setTimeout                                                       | 会话 / 消息对象及裸 id                                        | 提交监听沿发出方 rt；等待 / timeout 回调进入行所属 rt                                                                                          | 7         |
| `src/server.ts:97`                   | app.use                                                          | 唯一配置租户 / 请求                                           | R4 解析之后的 HTTP 中间件建立 rt（第 8 步解析；第 6 步接作用域）                                                                               | 6         |
| `src/server.ts:117`                  | setReplyTransport                                                | 唯一配置租户 / 请求                                           | 传输能力不捕获租户；被调用时沿会话所属作用域                                                                                                   | 6         |
| `src/server.ts:119`                  | setPrepareTransport                                              | 唯一配置租户 / 请求                                           | 传输能力不捕获租户；被调用时沿会话所属作用域                                                                                                   | 6         |
| `src/server.ts:360`                  | app.use                                                          | 唯一配置租户 / 请求                                           | R4 解析之后的 HTTP 中间件建立 rt（第 8 步解析；第 6 步接作用域）                                                                               | 6         |
| `src/server.ts:436`                  | stream.onAbort                                                   | 唯一配置租户 / 请求                                           | 模拟器订阅按（tenantId, sessionId）；断开回调进入连接所属 rt                                                                                   | 9         |
| `src/server.ts:463`                  | storeEvents.on                                                   | 唯一配置租户 / 请求                                           | 宿主旧事件流；发出方在宿主 rt，监听在空作用域挂（R3、R4）                                                                                      | 9         |
| `src/server.ts:464`                  | stream.onAbort                                                   | 唯一配置租户 / 请求                                           | 宿主旧事件流；发出方在宿主 rt，监听在空作用域挂（R3、R4）                                                                                      | 9         |
| `src/server.ts:942`                  | app.use                                                          | 唯一配置租户 / 请求                                           | R4 解析之后的 HTTP 中间件建立 rt（第 8 步解析；第 6 步接作用域）                                                                               | 6         |
| `src/server.ts:944`                  | app.use                                                          | 唯一配置租户 / 请求                                           | R4 解析之后的 HTTP 中间件建立 rt（第 8 步解析；第 6 步接作用域）                                                                               | 6         |
| `src/server.ts:952`                  | app.use                                                          | 唯一配置租户 / 请求                                           | R4 解析之后的 HTTP 中间件建立 rt（第 8 步解析；第 6 步接作用域）                                                                               | 6         |
| `src/server.ts:1031`                 | onShutdown                                                       | 唯一配置租户 / 请求                                           | R4 解析之后的 HTTP 中间件建立 rt（第 8 步解析；第 6 步接作用域）                                                                               | 6         |
| `src/server.ts:1032`                 | onShutdown                                                       | 唯一配置租户 / 请求                                           | R4 解析之后的 HTTP 中间件建立 rt（第 8 步解析；第 6 步接作用域）                                                                               | 6         |
| `src/shutdown.ts:40`                 | setTimeout                                                       | 实例资源 / 请求携带的上下文                                   | 信号 / 停机截止定时器为空作用域；按 R3 逐租户运行钩子                                                                                          | 6         |
| `src/shutdown.ts:85`                 | process.on                                                       | 实例资源 / 请求携带的上下文                                   | 信号 / 停机截止定时器为空作用域；按 R3 逐租户运行钩子                                                                                          | 6         |
| `src/store.ts:148`                   | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 9         |
| `src/store.ts:223`                   | onShutdown                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store.ts:236`                   | onShutdown                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store.ts:238`                   | startUsageDaily                                                  | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 每个 rt 的用量 writer 回调进入该 rt 作用域                                                                                                     | 10        |
| `src/store.ts:239`                   | onShutdown                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store.ts:297`                   | AsyncLocalStorage.snapshot                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 恢复 snapshot 后显式重建后端 / 调用所属 rt 的租户作用域                                                                                        | 6         |
| `src/store.ts:398`                   | setConvRefResolver                                               | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store.ts:577`                   | process.on                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store.ts:682`                   | setInterval                                                      | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/file-backend.ts:120`      | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/file-backend.ts:187`      | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/pg-backend.ts:64`         | AsyncLocalStorage.snapshot                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 恢复 snapshot 后显式重建后端 / 调用所属 rt 的租户作用域                                                                                        | 6         |
| `src/store/pg-backend.ts:1209`       | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/pg-backend.ts:1441`       | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/pg-backend.ts:1464`       | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/pg-backend.ts:1482`       | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/pg-backend.ts:1738`       | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/store/pg-backend.ts:1889`       | setTimeout                                                       | 后端 deps.tenantId / 全局 identity map（文件只属宿主）        | 在所属 rt 的 withTenantScope 中执行（R3）                                                                                                      | 6         |
| `src/trace/recorder.ts:344`          | onLlmCall                                                        | 当前轮次 ALS（未有租户 ALS）                                  | 发出方 / 当前轮次作用域；进程观测监听在空作用域注册                                                                                            | 7         |
| `src/trace/usage-daily.ts:130`       | setInterval                                                      | 一个 writer、累加器无 tenant 键                               | 空作用域挂实例拍；逐 rt 刷其带租户键的累加器                                                                                                   | 10        |
| `src/usage.ts:101`                   | setTimeout                                                       | 宿主 JSON 状态                                                | 只在宿主运行时装载与刷写；实例注册不继承首个请求的租户                                                                                         | 10        |
| `src/web/routes.ts:122`              | webRoutes.use                                                    | accountByKey 当前租户 / 请求会话                              | Host → account.tenantId → rt；SSE 每拍与关闭保持连接所属作用域                                                                                 | 9         |
| `src/web/routes.ts:123`              | webRoutes.use                                                    | accountByKey 当前租户 / 请求会话                              | Host → account.tenantId → rt；SSE 每拍与关闭保持连接所属作用域                                                                                 | 9         |
| `src/web/routes.ts:190`              | onTurnEnd                                                        | accountByKey 当前租户 / 请求会话                              | Host → account.tenantId → rt；SSE 每拍与关闭保持连接所属作用域                                                                                 | 9         |
| `src/web/routes.ts:297`              | c.req.raw.signal.addEventListener                                | accountByKey 当前租户 / 请求会话                              | Host → account.tenantId → rt；SSE 每拍与关闭保持连接所属作用域                                                                                 | 9         |
| `src/web/routes.ts:303`              | setInterval                                                      | accountByKey 当前租户 / 请求会话                              | Host → account.tenantId → rt；SSE 每拍与关闭保持连接所属作用域                                                                                 | 9         |
| `src/web/routes.ts:325`              | onShutdown                                                       | accountByKey 当前租户 / 请求会话                              | Host → account.tenantId → rt；SSE 每拍与关闭保持连接所属作用域                                                                                 | 9         |
| `src/server.ts:830`                  | 带 key 企微 GET 校验                                             | 当前账号列表按 key                                            | Host → standard rt（R4）；账号校验在所属作用域                                                                                                 | 8、9      |
| `src/server.ts:834`                  | 带 key 企微 POST 派发                                            | 当前账号列表按 key                                            | Host → standard rt → account.tenantId（R3）；沙箱 404                                                                                          | 8、9      |
| `src/server.ts:839`                  | 无 key 企微 GET 校验                                             | env 或当前租户默认账号                                        | 宿主按 R4；沙箱体验客服仅验签，无租户（R21）                                                                                                   | 8、25     |
| `src/server.ts:863`                  | 无 key 企微 POST 回调                                            | env 或当前默认账号                                            | 宿主所属 rt；沙箱解析微信绑定后入作用域（R21）                                                                                                 | 8、25、27 |
| `src/adapters/wecom-callback.ts:42`  | routeOf                                                          | loadedAccounts 当前列表                                       | Host 作用域中按 key / 默认前缀找账号（R4）                                                                                                     | 8、9      |
| `src/adapters/wecom-callback.ts:139` | syncAccountFromCallback 派发                                     | target 账号行                                                 | target.tenantId 的运行时作用域（R3）                                                                                                           | 9         |
| `src/adapters/wecom.ts:2575`         | syncFromCallback                                                 | envRuntime                                                    | 宿主 rt；体验客服不走 env（R21）                                                                                                               | 9         |
| `src/adapters/wecom.ts:2582`         | syncAccountFromCallback                                          | runtimes.get(accountId)                                       | account.tenantId → rt（R3）                                                                                                                    | 9         |
| `src/adapters/wecom.ts:2595`         | startRuntime / tick                                              | 捕获 rt                                                       | 按 rt.tenantId 建作用域；体验客服消息解析后再进沙箱                                                                                            | 9、25     |
| `src/adapters/wecom.ts:2703`         | startWecomAccount                                                | WecomAccountStart.tenantId                                    | 装载每个账号的所属 rt（R3）                                                                                                                    | 9         |
| `src/adapters/wecom.ts:2632`         | startWecom                                                       | envRuntime                                                    | 只在宿主作用域启动（R2）                                                                                                                       | 9         |
| `src/jobs/runner.ts:285`             | 启动 recoverJobsAtStartup                                        | withJobsTx 当前唯一后端                                       | 每个 standard rt 作用域，沙箱不启动（R6）                                                                                                      | 9         |
| `src/jobs/runner.ts:342`             | claimDueJobs                                                     | withJobsTx 当前唯一后端                                       | 每拍逐 standard rt 认领并执行（R3、R6）                                                                                                        | 9         |
| `src/store.ts:130`                   | afterPersist 回调                                                | fileBackend 依赖                                              | 宿主 rt 内发 storeEvents.change（R3、R6）                                                                                                      | 6、9      |
| `src/store.ts:132`                   | fileBackend.load（加载期）                                       | 模块全局 sessions / orders                                    | 宿主运行时装载时调用（R2、R3）                                                                                                                 | 6         |
| `src/store.ts:133`                   | fileBackend.probe（加载期）                                      | 宿主 var/                                                     | 宿主运行时装载时调用（R3）                                                                                                                     | 6         |
| `src/store.ts:203`                   | onConflict 回调                                                  | PG backend deps.tenantId                                      | 所属 rt；进程事故聚合在空作用域注册（R3）                                                                                                      | 6         |
| `src/store.ts:208`                   | afterCommit 回调                                                 | PG backend deps.tenantId                                      | 所属 rt 的 committedChange（R3、R6）                                                                                                           | 6、9      |
| `src/store.ts:209`                   | ordersTaken 回调                                                 | 同一后端与文件后端                                            | 在所属 rt 执行；文件仅宿主（R2）                                                                                                               | 6         |
| `src/store.ts:210`                   | outboundCommitted 回调                                           | PG backend deps.tenantId                                      | 所属 rt 发给同租户账本监听（R3）                                                                                                               | 6、7      |
| `src/store.ts:739`                   | saveHooks 派发                                                   | saveSession 的会话对象                                        | 发出方正确 rt 中同步执行（R3）                                                                                                                 | 6、9      |
| `src/store/file-backend.ts:114`      | deliverCommitted                                                 | 工厂依赖会话表                                                | 宿主 rt 同步发领域事件（R3、R6）                                                                                                               | 6、9      |
| `src/store/pg-backend.ts:1116`       | queueMicrotask（写队列）                                         | 工厂 deps.tenantId                                            | detached 后重建后端所属 rt（R3）                                                                                                               | 6         |
| `src/store/pg-backend.ts:1156`       | queueMicrotask（poisoned 渠道队列）                              | 工厂 deps.tenantId                                            | detached 后重建后端所属 rt（R3）                                                                                                               | 6         |
| `src/store/pg-backend.ts:1191`       | poisoned 出站提交回调                                            | 工厂 deps.tenantId                                            | 所属 rt 回调 outboundCommitted（R3）                                                                                                           | 6、9      |
| `src/store/pg-backend.ts:1390`       | ordersTaken 提交回调                                             | 工厂 deps.tenantId                                            | 所属 rt 内执行（R3）                                                                                                                           | 6         |
| `src/store/pg-backend.ts:1392`       | 出站提交回调                                                     | 工厂 deps.tenantId                                            | 所属 rt 内同步通知账本（R3）                                                                                                                   | 6、7      |
| `src/store/pg-backend.ts:1393`       | 领域事件提交派发                                                 | 工厂 deps.tenantId                                            | 所属 rt；事件加 tenantId（R6）                                                                                                                 | 6、9      |
| `src/store/pg-backend.ts:1394`       | afterCommit 派发                                                 | 工厂 deps.tenantId                                            | 所属 rt；每 rt storeEvents（R6）                                                                                                               | 6、9      |
| `src/store/pg-backend.ts:1573`       | reset 之后 ordersTaken 回调                                      | 工厂 deps.tenantId                                            | 所属 rt 内执行（R3）                                                                                                                           | 6         |
| `src/store/events.ts:34`             | 领域事件 subscribers 同步调用                                    | ev 裸 id                                                      | 事件带 tenantId；发出方在正确 rt（R3、R6）                                                                                                     | 9         |
| `src/store/events.ts:64`             | 未保存事件 unsavedSubscribers 调用                               | ev 裸 id                                                      | 所属 rt；沙箱 noteUnsaved 跳过（R11）                                                                                                          | 9、17     |
| `src/console-api/events.ts:39`       | listeners 同步调用                                               | 唯一 ring                                                     | 每 rt 的 event hub，发出方作用域（R6）                                                                                                         | 9         |
| `src/config/source.ts:278`           | lockListeners 派发                                               | loaded.tenantId                                               | 锁所属 rt 的作用域；R2 沙箱 fail-stop 在第 12 步                                                                                               | 6         |
| `src/config/source.ts:916`           | catalogListeners 派发                                            | loaded.tenantId                                               | 所属 rt 内同步执行（R3）                                                                                                                       | 6、7      |
| `src/quota/ledger.ts:353`            | setImmediate（释放等待 seq）                                     | ChatMessage / 当前 store                                      | 所属 rt 的账本作用域（R3）                                                                                                                     | 7         |
| `src/core/pack-api.ts:603`           | bindPack 的装载写入                                              | 单个 binding                                                  | 装载每个 rt 时绑定（R3）                                                                                                                       | 6         |
| `src/budget.ts:28`                   | 加载 budget.json                                                 | 宿主文件                                                      | 只在宿主运行时装载（R2、R15）                                                                                                                  | 10        |
| `src/usage.ts:89`                    | 加载 usage.json                                                  | 宿主文件                                                      | 只在宿主运行时装载（R2、R15）                                                                                                                  | 10        |
| `src/store.ts:680`                   | 加载期 freshenDemoData                                           | 宿主 JSON                                                     | 只在宿主运行时装载（R3）                                                                                                                       | 6         |
| `src/store.ts:681`                   | 加载期 pruneStaleVisitorData                                     | 宿主 JSON                                                     | 只在宿主运行时装载（R3）                                                                                                                       | 6         |
| `src/server.ts:1033`                 | boot 初始化配置 / store / channels                               | DEFAULT_TENANT_SLUG → configRuntime                           | 按 R2 装载每个 rt；boot 的租户操作逐 rt scope                                                                                                  | 6         |
| `src/server.ts:1053`                 | preflight                                                        | 当前 file / DB 配置                                           | 宿主 rt 中核对目录（R2）                                                                                                                       | 6         |
| `src/server.ts:1062`                 | buildIndex                                                       | 当前目录                                                      | 每个 rt 装载后进入作用域（共享规则 R5）                                                                                                        | 7         |
| `src/server.ts:1074`                 | startPrivacy / initPrivacy                                       | 当前唯一配置                                                  | 宿主各 standard rt；沙箱不轮询（R6）                                                                                                           | 7         |
| `src/trace/recorder.ts:350`          | onUsage 订阅（模块加载期）                                       | 同步发出用量事件的当前调用 / 轮次作用域；live() 取当前 Holder | 继承发出方 tenant runtime 与轮次作用域，只关联该轮用量；模块订阅不捕获宿主 rt（R3、R5）                                                        | 7         |
| `src/trace/usage-daily.ts:37`        | onUsage 订阅（模块加载期）                                       | 发出方调用上下文；今天写唯一 acc / writer                     | 派发到当前所属 rt 的累加器 / writer，不另建或回落到宿主作用域；租户订阅若捕获 rt，drop 时注销（R3、R5、R15）                                   | 10        |
| `src/config/source.ts:246`           | turnPin.run（pinCatalogForTurn）                                 | 当前 loaded.catalog 与调用方上下文                            | 只建立每轮目录快照 ALS，继承既有 tenant runtime；固定当前 rt 的目录，不建立租户作用域（R3、R5）                                                | 6         |
| `src/db/client.ts:207`               | tenantStore.run（withTenant）                                    | 显式 ctx.tenantId / actor                                     | 建立数据库事务的租户 ALS，并 SET LOCAL tenantId；继承服务 runtime 作用域，调用方保证 ctx 与所属 rt 一致，不能用事务 ALS 代替 runtime ALS（R3） | 6         |
| `src/log.ts:242`                     | ctxStore.run（withLogContext）                                   | 调用方日志上下文 + 显式 ctx                                   | 建立 / 叠加日志 ALS，继承既有 tenant runtime；日志租户字段取当前所属 rt，不由日志字段创建运行时（R3）                                          | 6         |
| `src/log.ts:247`                     | ctxStore.run（withConversationLog）                              | 已有日志上下文 + conversationId                               | 建立日志 ALS 的会话层，继承既有 tenant runtime；裸会话 id 只能在当前 rt 查，不建立租户作用域（R3）                                             | 6         |
| `src/trace/recorder.ts:126`          | turns.run（withTurnScope）                                       | 调用方上下文 + 新建 Holder                                    | 只建立每轮 trace ALS（内层另建日志上下文），继承既有 tenant runtime；不以轮次 Holder 创建租户作用域（R3、R5）                                  | 7         |

**表外入口（不在 R3 的服务业务入口枚举里）**：

| 出处                               | 入口                                | 今天的租户来源                               | 05 的作用域位置                                                                     | 改动步骤 |
| ---------------------------------- | ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| `src/cli/channel-account.ts:175`   | setTimeout                          | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 不动     |
| `src/cli/channel-account.ts:197`   | input.on                            | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 不动     |
| `src/cli/channel-account.ts:200`   | process.once                        | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 不动     |
| `src/cli/channel-account.ts:201`   | process.once                        | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 不动     |
| `src/cli/channel-account.ts:202`   | process.once                        | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 不动     |
| `src/db/migrate.ts:30`             | client.on                           | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 不动     |
| `src/db/testing.ts:284`            | pool.on                             | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:285`            | pool.on                             | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:285`            | c.on                                | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:309`            | setTimeout                          | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:347`            | pool.on                             | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:348`            | pool.on                             | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:348`            | c.on                                | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:377`            | c.on                                | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:413`            | su.on                               | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/db/testing.ts:459`            | c.on                                | 命令显式 --tenant / 测试夹具；非服务业务入口 | 命令保持显式 withTenant；测试按装载的 rt 建作用域，基础连接事件无租户               | 6        |
| `src/env.ts:7`                     | 加载 env 文件                       | 进程环境                                     | 实例初始化，不建租户作用域                                                          | 不动     |
| `src/profile-boot.ts:10`           | JSON console 接线 / profile 检查    | 进程环境                                     | 实例初始化；角色检查按 R16                                                          | 不动     |
| `src/selftest-env.ts:8`            | 自测环境钉 demo / file              | 测试进程                                     | 测试启动，不是生产入口                                                              | 不动     |
| `src/store/parity-clock.ts:22`     | 安装固定时钟                        | 测试进程                                     | 实例级测试时钟                                                                      | 不动     |
| `src/cli/erase-conversation.ts:39` | CLI 命令启动                        | --tenant，平台连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/import-config.ts:12`      | CLI 命令启动                        | --tenant，app 连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/user-disable.ts:7`        | CLI 命令启动                        | --tenant，平台连接；账号 / 成员服务          | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/channel-export.ts:11`     | CLI 命令启动                        | --tenant，app 连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/channel-import.ts:10`     | CLI 命令启动                        | --tenant，app 连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/tenant-brand.ts:84`       | CLI 命令启动                        | --tenant，平台连接；显式 withTenant          | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/user-create.ts:9`         | CLI 命令启动                        | --tenant，平台连接；账号 / 成员服务          | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/export-config.ts:12`      | CLI 命令启动                        | --tenant，app 连接；导出服务                 | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/privacy-publish.ts:14`    | CLI 命令启动                        | --tenant，平台连接；显式 withTenant          | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/member-remove.ts:7`       | CLI 命令启动                        | --tenant，平台连接；账号 / 成员服务          | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/catalog-fix.ts:12`        | CLI 命令启动                        | --tenant，app 连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/tenant-retention.ts:26`   | CLI 命令启动                        | --tenant，平台连接；审计显式 withTenant      | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/user-password.ts:7`       | CLI 命令启动                        | --tenant，平台连接；账号 / 成员服务          | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/member-role.ts:8`         | CLI 命令启动                        | --tenant，平台连接；账号 / 成员服务          | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/export-sessions.ts:15`    | CLI 命令启动                        | --tenant，app 连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/import-sessions.ts:16`    | CLI 命令启动                        | --tenant，app 连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/tenant-create.ts:112`     | CLI 命令启动                        | --slug，平台连接；新分配 tenantId            | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/channel-account.ts:593`   | CLI 命令启动                        | --tenant，app 连接；独立租户锁               | 独立命令不借用服务 currentRuntime；tenant DB 操作保持显式 withTenant（R3、R4、R18） | 不动     |
| `src/cli/common.ts:42`             | main 与完成 / 拒绝回调（:44 / :45） | 调用命令显式参数；此包装自身无租户           | 独立进程退出，不建立服务 runtime 作用域                                             | 不动     |
| `src/db/migrate.ts:47`             | runMigrations 与完成 / 拒绝回调     | owner 连接，全库迁移，无业务租户             | 实例 / 工具入口，不能套宿主 tenant 作用域                                           | 不动     |

CLI 的每个导出 `run` / `main` 是显式命令入口（`src/cli/common.ts:42` 共用 main），租户取 `--tenant` / `--slug`，租户 DB 操作保持显式 `withTenant`，需要租户锁的命令使用独立锁连接，不从 HTTP currentRuntime 推断；05 新的命令归第 4、18 步。本表不把 CLI 命令行解析的每个局部函数当后台 tenant 入口。`src/boot.ts` 的启动顺序由 server 注入，实例设施（serve、alert、OTel）在空作用域起，tenant 的 store/config/privacy/index 逐 rt 起。

#### 3. 渠道与出站路径

spec 原表 **13 行**全部逐行核对；另发现 **8 行现存表外发送 / 外发路径**，并单列 **1 行第 25 步新增调用**。下表“照企微走”只指绑定微信经体验客服的出站；宿主 env 与库里账号运行时不允许接沙箱，沙箱第三种运行时归第 25–27 步。当前代码尚没有这些挡板，不能把 spec 的“要挡”写成已经挡住。

| spec 路径 / 当前出处                                                                                                                          | 种子与模拟器（sbx- / simulator）               | 绑定微信（wecom: / wecom）           | 依据 / 改动步骤                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 人工窗口与额度：`src/handoff/takeover.ts:354`                                                                                                 | 自然不走                                       | 照企微走                             | 明确 `s.channel === 'wecom'`；R8，7 / 26                                                                                    |
| 工作台送达 / 窗口：`src/console-api/workbench.ts:211`、`:251`；更早消息 `src/console-api/app.ts:629`                                          | 自然不走                                       | 照企微走                             | 只为 wecom 读 delivery / outbound / sendWindow；R8，15 / 28                                                                 |
| 适配器选择：`src/server.ts:103`、`:117`、`:119`、`:665`；菜单 `src/core/engine/index.ts:225`；付款 `:849`、`src/payment/orders.ts:105`        | 自然选模拟器；要显式挡其他适配器落入沙箱       | 照企微走，但必须选体验客服并过汇点   | 当前仅按 channel，未查 kind / 绑定；R11、R21；17 → 26                                                                       |
| 失败备注：`src/handoff/takeover.ts:413`、`src/payment/orders.ts:109`、`src/server.ts:672`                                                     | 自然不走：模拟器 push 返回 true，无 SSE 也成功 | 照企微走                             | R8；回执经 msgid → sandbox 表找作用域（R21），26                                                                            |
| 跟进：`src/core/followup.ts:79`、`src/jobs/followup.ts:90`                                                                                    | 自然不走                                       | 要显式挡：资格成立，queueJobs 丢弃   | 资格要求 wecom；沙箱不起 runner；R11，17                                                                                    |
| 转人工 / 订单通知任务：`src/handoff/record.ts:109`；`src/jobs/notify.ts:43`、`:74`；`src/packs/travel/tools/index.ts:253`；`src/store.ts:365` | 要显式挡                                       | 要显式挡                             | 生产者不是全部依赖 wecom；在 queueJobs 丢弃全部 JobOp，不能用触发器拒事务；R11，17                                          |
| 保留期任务：`src/jobs/runner.ts:307`                                                                                                          | 自然不走（沙箱不启动 runner）                  | 自然不走（同左）                     | R6、R11；进程角色启动检查，12                                                                                               |
| 未保存转人工群通知：`src/store/events.ts:61`；`src/notify/handoff.ts:154`、`:178`                                                             | 要显式挡                                       | 要显式挡                             | noteUnsaved / fireUnsaved 不依赖 wecom，按事件所属租户跳过；没配 webhook 是结构兜底，R11，17                                |
| 企微底层：`src/adapters/wecom.ts:2796`、`:2848`；欢迎 `:1407`、兜底 `:1788`、token `:419`                                                     | 自然不走；宿主 pushRoute / push 仍要显式挡沙箱 | 照企微走：只能经体验客服；恢复不补发 | callApi `:460`（fetch `:468`）、postSendMsg `:1096`（fetch `:1097`）；每次发送含重发核收件人 / code；R11、R21，17 / 25 / 26 |
| 运维告警：`src/ops/alert.ts:174`、`:342`（webhook fetch `:98`）                                                                               | 要显式挡沙箱局部告警；实例级照给               | 同左                                 | R19，实例级的 scope / pool / purge / 体验客服失败与 send_refused 照发；17 / 18 / 20 / 25 / 26                               |
| OTel：`src/ops/otel.ts:55`、`src/otel/export.ts:112`                                                                                          | 自然不走：沙箱禁止 OTLP env                    | 同左                                 | R16，启动拒绝而不是只靠不调用 export；12                                                                                    |
| 模型 / embedding：`src/llm-gate.ts:89`（实际 fetch `:113`）、`src/core/retrieval.ts:60`（gatedFetch `:64`）                                   | 照给，计沙箱预算                               | 照给，计沙箱预算                     | 不是企微发送；R15 尝试层计费，10 / 20                                                                                       |
| 整实例拨测 / 备份：`deploy/watch.sh:92`、`deploy/backup.sh:89`                                                                                | 照给（实例任务）                               | 照给（实例任务）                     | 这两行是告警 curl；健康拨测在 watch `:144`，异地备份在 backup `:219`；不从会话 channel 选择；R12、R20，22                   |

**表外路径**（其中前三行细化企微两条 fetch，单列以防只在 push 上加挡板）：

| 出处 / 路径                                                                                   | 种子与模拟器                   | 绑定微信                                         | 依据 / 改动步骤                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `src/adapters/wecom.ts:1204`、`:1218`：postSendMsg 重试 / 42001、40014 强刷后重发             | 自然不走；宿主显式挡           | 照企微走，每次 fetch 前重核绑定                  | 与 callApi 分离，强刷有 await；R11，26                                                                         |
| `src/adapters/wecom.ts:659`、`:854`、`:916`：卡片 / 文本 / 同意菜单 callApi；`:1411` 欢迎事件 | 自然不走；宿主显式挡           | 照企微走；welcome_code 必须属于此刻的微信 / 沙箱 | R11，26；事件 code 在 20 秒内、消费时点按 R11                                                                  |
| `src/adapters/wecom.ts:572`：media/upload 缩略图；`:803`、`:1153`、`:1367`、`:1810` 调上传    | 自然不走                       | 照企微走                                         | 仅体验客服应用上传，图片素材不是另一个收件人；链接改写仍在共同发送边界，R21，25 / 26                           |
| `src/adapters/wecom.ts:1428`、`:1432`：kf/customer/batchget；调用点 `:1733`、`:2196`          | 自然不走                       | 要显式挡（体验客服运行时不调）                   | 当前拉客户昵称 / 头像并回填画像；R22 明确“不拉昵称与头像”，第三种运行时不能沿用 enrichCustomerProfile，25 / 27 |
| 第 25 步新增（当前源码无）：kf/add_contact_way 客服链接                                       | 自然不走                       | 照企微走（体验客服启动取链接）                   | R21：启动取 scene=try 的客服链接，只放内存；这是新增调用，不是现有 customer/batchget                           |
| `src/adapters/web.ts:50` / `src/adapters/simulator.ts:25`：SSE push 与菜单 parts              | 模拟器照给；网页适配器要显式挡 | 自然不走（经体验客服）                           | R6、R11；沙箱 web 路由 404、adapterFor 只给两种允许适配器，9 / 17 / 26                                         |
| `src/notify/notifier.ts:91`：实际 NOTIFY_WEBHOOK_URL fetch                                    | 要显式挡调用，env 结构兜底     | 同左                                             | producer queueJobs、unsaved 两处挡；R11 / R16，17 / 12                                                         |
| `src/otel/export.ts:119`：停机 flush / shutdown 导出器                                        | 自然不走（沙箱不开导出器）     | 同左                                             | 不可仅挡每轮 export 而忘 drain；R16，12                                                                        |
| `deploy/backup.sh:219`、`:220`、`:221`：rclone copy / delete / rmdirs                         | 照给，按实例备份规则           | 同左                                             | 原表 :89 是备份告警，异地数据外发在这些行；R12，保留期照旧，不修改                                             |

#### 4. console 的内部投影

下表按字段 / 同一来源的一组字段计数；列完 `/status` 的全部内部字段，再覆盖认证、SOP / trace、事件流及运行数字中暴露的内部投影。普通产品、消息、订单正文的全字段不算“进程内部状态”，其 id / 身份与缓存 / scope 边界仍列出。沙箱是 owner 成员，不走宿主 demo 的匿名投影（R10、R16）；所有“沙箱自己的”都在 R3 / R10 作用域中取得，不能伪造宿主单例字段。

| API / 出处                                                                                                                  | 暴露字段                                                                                                                                                        | 沙箱处理                                              | 依据                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/auth/login`；`src/console-api/app.ts:402`                                                                                 | 登录会话 / Set-Cookie / Me                                                                                                                                      | 隐去该入口（404）                                     | R10：沙箱免密、不读 sid                                                                              |
| `/auth/logout`；`src/console-api/app.ts:411`                                                                                | cookie 清理                                                                                                                                                     | 待确认如何对待该接口；结束体验已有独立路由            | R10 / R12 只定 end，现接口清 sid；不能自行定为清 sbx 或结束租户                                      |
| `/me`；`src/console-api/app.ts:333`                                                                                         | userId                                                                                                                                                          | 改成沙箱合成用户自己的                                | R9 / R10                                                                                             |
| 同上 `:334`                                                                                                                 | displayName                                                                                                                                                     | 改成“体验访客”                                        | R10                                                                                                  |
| 同上 `:335`                                                                                                                 | role                                                                                                                                                            | 改成沙箱 owner                                        | R10                                                                                                  |
| 同上 `:336`                                                                                                                 | csrf                                                                                                                                                            | 改成 sbx token 派生的自己的                           | R10                                                                                                  |
| 同上 `:337`                                                                                                                 | tenantSlug                                                                                                                                                      | 改成沙箱自己的（非凭据）                              | R19 / R21                                                                                            |
| 同上 `:338`                                                                                                                 | tenantName                                                                                                                                                      | 改成沙箱自己租户行的名称                              | R3 / R10，现读取 currentTenant                                                                       |
| `/pack`；`src/console-api/app.ts:421`                                                                                       | 行业包 id / 配置                                                                                                                                                | 照给，取沙箱自己的 pack                               | R9 已发布快照副本；静态包定义可共用                                                                  |
| `/status`；`src/console-api/app.ts:437`                                                                                     | channels 的 key / kind / status / inactiveReason / lastSyncAt / lastErrorCode / openInbox / oldestOpenInboxSec / staleOutbound / cursorAgeSec / unknownSends24h | 改成沙箱自己的空数组，不透出宿主账号                  | R11 / R21：无 channel_accounts、无注册表；体验客服状态在 healthz / Me.sandbox.wechat，不自行造渠道行 |
| `/status`；`:438`                                                                                                           | mode                                                                                                                                                            | 照给 db                                               | R16 SESSION_STORE / CONFIG_SOURCE 均 db                                                              |
| `/status`；`:439`                                                                                                           | tenantSlug                                                                                                                                                      | 改成沙箱自己的                                        | R3 / R19                                                                                             |
| `/status`；`:441`                                                                                                           | sop.versionId                                                                                                                                                   | 改成沙箱发布版本 id                                   | R9：副本发布版本 1                                                                                   |
| `/status`；`:442`                                                                                                           | sop.versionNo                                                                                                                                                   | 改成沙箱自己的                                        | R9                                                                                                   |
| `/status`；`:443`                                                                                                           | sop.publishedAt                                                                                                                                                 | 改成沙箱自己的                                        | R9                                                                                                   |
| `/status`；`:444`–`:447`                                                                                                    | sop.promptHash / toolsHash / prefixHash / sopHash                                                                                                               | 照给沙箱自己的，初始等模板已发布值                    | R9，发布后各自变化                                                                                   |
| `/status`；`:449`                                                                                                           | lock                                                                                                                                                            | 改成此沙箱自己的                                      | R2 每沙箱租户锁                                                                                      |
| `/status`；`:450`                                                                                                           | sopStale                                                                                                                                                        | 改成沙箱自己的                                        | R3 / R5 config                                                                                       |
| `/status`；`:451`                                                                                                           | catalogStale                                                                                                                                                    | 改成沙箱自己的                                        | R3 / R5 config                                                                                       |
| `/status`；`:452`                                                                                                           | index.indexGeneration                                                                                                                                           | 改成沙箱自己的引用代次                                | R5 指纹 / 模型可共享内容，不能共享错误目录代次                                                       |
| 同上                                                                                                                        | index.snapshotGeneration                                                                                                                                        | 改成沙箱自己的目录代次                                | R5                                                                                                   |
| 同上                                                                                                                        | index.stale                                                                                                                                                     | 改成沙箱自己的                                        | R5                                                                                                   |
| 同上                                                                                                                        | index.lastError                                                                                                                                                 | 改成沙箱自己索引的状态                                | R5 / R15，沿用脱敏错误契约                                                                           |
| `/status`；`:453`                                                                                                           | drift 的 SOP / catalog 镜像对比                                                                                                                                 | 改成沙箱自己的当前配置与同镜像的对比                  | R3 / R9；不查询宿主当前草稿或 pending brand                                                          |
| `/status`；`:455`                                                                                                           | conversations                                                                                                                                                   | 改成沙箱自己的 PG 会话数                              | R8：sbx 不属 demo 类                                                                                 |
| `/status`；`:456`                                                                                                           | poisoned                                                                                                                                                        | 改成沙箱自己的短码集合                                | R3 / R5；不透出宿主列表                                                                              |
| `/sop`、`/sop/versions`、`/sop/versions/:id`；`src/console-api/app.ts:462`、`:476`、`:481`；`src/shared/console-api.ts:217` | published / draft 的 id、版本、rev、basedOn、状态、source、发布时间、操作者、哈希与渲染输入；spec / budget                                                      | 改成沙箱自己的版本和品牌快照；静态节表 / 字数上限照给 | R9，副本初始无历史草稿；R3                                                                           |
| SOP 写响应；`src/console-api/app.ts:485`、`:490`、`:494`、`:502`                                                            | promptHash / prefixHash / chars / limit / violations / rebase / sameHashAsTarget                                                                                | 照给，计算与基线取沙箱自己的                          | R10 允许改 SOP；R3                                                                                   |
| 会话 / 订单接口；`src/console-api/app.ts:582`、`:609`、`:729`；`src/console-api/workbench.ts:64`                            | id、关联订单 id、assignee.userId / name、handoff、profile、计数                                                                                                 | 改成沙箱自己的 identity map / 合成用户数据            | R8 / R9，种子 id 重生、订单 id 可跨租户重复                                                          |
| 工作台消息；`src/console-api/workbench.ts:211`、`:251`；`src/console-api/app.ts:629`                                        | seq、turnId、guarded、delivery、sendWindow / remaining、操作 disabled 理由                                                                                      | 改成沙箱自己的；simulator 不给企微窗口，绑定微信照给  | R8 / R21 / R22；旧绑定汇点拒绝的视图第 28 步                                                         |
| `/conversations/counts`；`src/console-api/app.ts:601`                                                                       | total / byState / aiByStage / updatedToday                                                                                                                      | 改成沙箱自己的                                        | R6 event hub 与 store                                                                                |
| `/turns`；`src/console-api/app.ts:647`                                                                                      | turnId / startedAt / outcome / steps.name / label / prefetch                                                                                                    | 改成沙箱自己的 PG trace / 词表                        | R8 / R3                                                                                              |
| `/turns/:turnId/diff`；`src/console-api/app.ts:666`                                                                         | removed / added / guard events                                                                                                                                  | 改成沙箱自己的                                        | R8 / R3                                                                                              |
| `/turns/:turnId`；`src/console-api/app.ts:689`                                                                              | turnId / durationMs / outcome / sopVersion / prefixHash / catalogVersions / stageBefore / stageAfter / draft / finalText / calls / llm / signals                | 改成沙箱自己的，沿用脱敏 / owner 权限                 | R8 / R3；不得读宿主 trace                                                                            |
| `/events`；`src/console-api/app.ts:852`；`src/console-api/events.ts:34`                                                     | 启动标识-序号 id、tail / replay / resync、counts、handoff / conversation / message / order / send_failed 的 id / seq / 状态                                     | 改成沙箱自己的环与监听                                | R6 每 runtime 单独事件环；cookie 复核 R10                                                            |
| `/audit`；`src/console-api/app.ts:917`                                                                                      | id / at / action / actor / payload、分页游标                                                                                                                    | 改成沙箱自己的审计（含 sandbox.create / end）         | R7 / R8；无跨租户计数与令牌                                                                          |
| `/metrics`；`src/console-api/app.ts:930`；`src/ops/metrics.ts:55`                                                           | MetricsView 的窗口、计数、失败、护栏、模型用途 / 用量 / 成本                                                                                                    | 改成沙箱自己的 usage_daily / traces / retention       | R15；宿主 usage.json / 作战室不纳沙箱                                                                |
| 快捷回复；`src/console-api/app.ts:783`、`:797`                                                                              | id / rev / ord / archivedAt / updatedByName / updatedAt                                                                                                         | 改成沙箱自己的                                        | R9 副本与 R10 允许写                                                                                 |
| console 错误体；`src/console-api/app.ts:347`、`:944`；`src/shared/console-api.ts:259`                                       | detail / current / violations / keys / fields / issues / rows / assigneeName / closesAt / remaining / status                                                    | 照给契约，业务冲突值取沙箱自己的；内部异常仍泛化      | R3、R10；任何 token 不进错误日志或响应详情（R21）                                                    |

第 15 步补投影与 `Me.sandbox`，第 24、28 步消费它们；后者是新增字段，不计入上面现存内部字段清单。没有把 `/healthz` 或宿主旧 `/api/usage` 算成 console API：前者 R19 单独契约，后者在沙箱 404（R4）。

#### 02–04 DB 模式的非锁定自测（第 11 步严格重跑）

按 `package.json:18` 的 test 串核对（位置以 script 名为准）。下列 **24 个 src 自测**有 DB 配置 / DB store / PG fixture 路径；第 11 步重跑同一文件的完整测试并保留其子进程环境传播，不是只重跑其中一个断言。纯库迁移 / 授权测试也列入，因为同一 test 串必跑、不能以不访问 runtime 为由漏掉。此处只记录当前路径，没执行 DB 测试。

| 自测 / DB 路径出处                               | 当前测试范围                                           |
| ------------------------------------------------ | ------------------------------------------------------ |
| `src/config/brand.selftest.ts:215`               | PGlite 配置 / 品牌装载                                 |
| `src/config/brand-publish.selftest.ts:22`        | DB 发布品牌与前缀                                      |
| `src/config/brand-transfer.selftest.ts:22`       | DB / file 品牌导入导出；子进程                         |
| `src/store/store.selftest.ts:1`、`:561`          | PG 后端 / queue / 清除；含 file 分支与真实 PG 条件分支 |
| `src/store/spill-channel.selftest.ts:93`         | spill 渠道重放，PGlite + PG                            |
| `src/store/parity.selftest.ts:766`               | file / DB 两种存储子进程等价                           |
| `src/trace/trace.selftest.ts:376`                | DB traces / 用量 / guard                               |
| `src/trace/verdicts.selftest.ts:22`              | 真实 PG guard_verdicts（无 PG 时跳过）                 |
| `src/jobs/jobs.selftest.ts:415`                  | DB runner / 跟进 / 并发认领                            |
| `src/notify/notify.selftest.ts:343`              | DB 通知 / 未保存通知恢复                               |
| `src/ops/ops.selftest.ts:236`                    | DB metrics / 告警，另有部署脚本替身                    |
| `src/channels/channels.selftest.ts:843`          | DB 账号装载 / 权限 / 状态                              |
| `src/adapters/wecom-03.selftest.ts:453`          | 03 PG 收件 / cursor / 按账号运行时                     |
| `src/channels/recovery.selftest.ts:383`          | DB 恢复；真实 PG 杀进程分支                            |
| `src/channels/restore-cutoff.selftest.ts:29`     | DB cutoff / 运维命令与子进程                           |
| `src/quota/quota.selftest.ts:1125`               | DB 账本 / 窗口 / 回执                                  |
| `src/quota/outbound.selftest.ts:162`             | DB 出站 pending / 事务边界                             |
| `src/db/rollback-guard.selftest.ts:28`           | 02–04 回滚脚本的 DB 问询替身；不是运行时 DB 装载       |
| `src/db/db.selftest.ts:92`                       | PGlite / PG 迁移、RLS、角色与锁                        |
| `src/db/brand.selftest.ts:215`                   | DB 品牌 schema / 约束                                  |
| `src/config/config.selftest.ts:941`              | DB 配置 / 版本 / reload / 锁                           |
| `src/console-api/console.selftest.ts:48`         | DB 认证 / console / PG 工作台                          |
| `src/web/web.selftest.ts:433`                    | DB 网页账号 / 渠道与写入                               |
| `src/payment/legacy-pay-poisoned.selftest.ts:33` | DB legacy 付款落库失败                                 |

上述 **24 个独立文件**加上 `eval/run.ts` 的 `CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1` 分支（test 串已有）是 **25 个执行目标**。严格模式文件清单按这 24 个文件落地，不重复启动 brand-transfer。

不加进“DB 模式”名单：`config/pack-runtime.selftest.ts` 当前只 `initConfig(null)`；`handoff/handoff.selftest.ts`、`privacy/privacy.selftest.ts`、`adapters/wecom-02.selftest.ts`、`payment/orders.selftest.ts` 当前明确 file / 无库；04 的纯 core / travel / tools / packs / shared 测试没有 DB runtime 装载。这些仍在常规 test 中照跑。console 的浏览器组件纯投影自测、scripts 的扫描器 / seed 自测、eval/v2 与 eval/sim 的 runner 隔离测试另属工具 / 前端，不冒称“02–04 DB 模式 src 套件”。DB 模式 mock eval 是额外目标，锁定文件与 eval/cases.json 均不改。

#### 5. spec 出处核对（B）

开放问题 12 的所有位置均仍准：`src/server.selftest.ts:1165`–`:1170` 是 prod 的 home 断言；`:1167`–`:1168` 是需授权替换的文案与 location；`:1195`–`:1199` 是 demo 关模拟器的断言，`:1196`–`:1197` 是文案 / location；`:1210` 是 demo 跳 guide，`:1211`–`:1216` 是 chat / guide 同为 200；`:1160` 是 prod 对 guide 的 POST 404，SIM_PAGES 的多种写法检查照旧。未修改锁定文件。

R3 的 shutdown、exit、模块加载、snapshot；R5 的数组、fileBackend；R11 的 callApi、postSendMsg、两处 unsaved；R12 的 withTenant、草稿写缓存、drain / close / writeUsage / 后端 close；R21 的第三种运行时出处与 extractCard 均可定位。以下是需要细化 / 修正的引用，**没有代码移动**（`e5affab..HEAD` 的 src 无差异），主要是原引用只落在注释、接口或函数头，不能当成所称变量 / fetch 的精确行。

| spec 出处 → 现在的位置                                                                                                 | 核对结果                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 背景 / 进程内状态表 `src/config/source.ts:209`、`:164` → `:210` loaded、`:219` catalogListeners、`:214` / `:215` stale | 209 是 dbInstalled，164 是 Loaded 接口；同组状态仍在相邻位置            |
| R3 / 背景 / 状态表 `src/store.ts:146` → `:82` storeEvents、`:141` changeTimer、`:148` setTimeout                       | 146 是 committedChange 函数头；作用域继承发生在 148 注册 timer          |
| 状态表 `src/store/events.ts:12` → `:6` DomainEvent 类型、`:24` subscribers、`:48` unsavedSubscribers                   | 12 是事件字段 kind，不是事件发射器 / 订阅集合                           |
| 状态表 `src/jobs/followup.ts:87` → `:71` known                                                                         | 87 是 planOps；资格排程的 :90 仍准                                      |
| 实例状态表 `src/web/routes.ts:42` → `:43` streams、`src/adapters/web.ts:15` / `:16` ips / total                        | 42 是 processing，按会话的执行锁；不能当 SSE 总量解释                   |
| 对象键 / 每轮表 `src/core/llm/client.ts:600` → `:605` reusable、`:608` lastKey                                         | 600 是 sideEffects；每轮 Map 在后面几行                                 |
| 背景 / 预算段 `src/core/engine/index.ts:610` → `:618` visitor                                                          | 610 是 callModel 函数头，具体 channel 判断在 618                        |
| 状态表 `src/ops/metrics.ts:50` → `:51` retention、`:52` views                                                          | 50 是两缓存的注释；拒绝其他租户判断 :56 / :57                           |
| 状态表 `src/trace/usage-daily.ts:41`、`:118` → `:30` acc、`:31` writer、`:130` timer                                   | 41 是 key 构造，118 是 writer 说明注释；所述无租户 key 与 30 秒语义仍准 |
| R11 `src/adapters/wecom.ts:460` / `:1096` → `:468` / `:1097` fetch                                                     | 原函数出处准；加汇点核对时必须定位到实际 HTTP 发起点，含 :1218 重发     |
| 模型出站 `src/llm-gate.ts:89` / 预占 `:95` → `:113` fetch                                                              | 89 是入口、95 是重试循环；每尝试的实际发起点在 113                      |
| 整实例拨测 / 备份 `deploy/watch.sh:92` / `deploy/backup.sh:89` → watch `:144`、backup `:219`                           | 原两行是告警 webhook curl；健康拨测与异地副本传输在新列的位置           |

未列入修正表的相邻函数 / 注释引用只用作区域定位仍有效，例如 `src/core/retrieval.ts:60` 是 embed 函数、`:64` 经 gatedFetch；`src/adapters/wecom.ts:1407` 是欢迎语说明、`:1410` 是函数。05 spec 保持原样，后续实现用本记录精确点位。

#### 6. 反向引用与需要确认的问题

C 已在 00、01、02、03、04、后台 UX spec 的文件头追加 05 的反向引用：原有 metadata、Status 与正文保留；ADR-002 已有注未动。对应 05 文件头的部分取代与增补逐项列条款，不把它们提前写成已实现。

**需要确认的问题**

1. spec 背景的“模块顶层集合 91”来自仓库外盘点；相同源码下本记录能复现 87 个直接绑定 / 89 个模块初始化构造位置。请协调者提供原统计位置 / 口径，再对齐第 5、11 步 lint 的对照数字；不能为了凑 91 把类字段或每轮 Map 混入模块绑定。
2. 沙箱 `/api/console/auth/logout` 的行为未在 R10 定义：当前清 `__Host-sid`，而沙箱不读它；spec 只规定没有口令登录、独立 end 路由和 cookie 失效时清 sbx。第 15 步需要 owner 明确是 404、只清 sbx，还是其他契约；本次不自定。

**本次交接**：四张清单、DB 严格重跑目标与 B / C 由 Codex 写完，基准、内存实测与两个问题的裁决由协调者补在本记录开头。Codex 本次没有跑门禁与内存探针，修改的七份文档格式检查与 `git diff --check` 通过；逐文件验证六份 spec 仅追加元数据、plan 的实施记录前后逐字节不变，新增行的本地路径 / 长企微 id 检查通过。没有步骤勾选、代码半成品或提交。清单另经一路只读 Codex 评审，结论见下。

**2026-10-11 评审修正交接**：按协调者确认的 3 major + 1 minor 修正上述告警归类、租户闭包的隔离与释放、客户资料出站及遗漏入口；模块绑定仍 690 个，入口主表由 157 增至 164，表外出站保留 8 条现存路径并另列 1 条计划新增调用。仅修改本第 1 步记录，未改源码、锁定文件、spec、基准或步骤勾选，未提交；协调者下一步复核这四项，R12 的释放证明由对应实现步骤与第 18 步验收落实。

### 第 2 步 · 锁定断言的授权修改与根路径跳转（2026-10-11）

- 结构：PR #175 用两个提交分别改授权断言与实现；`/` 统一 302 到 `/console/`，删除引导页，新增非锁定入口自测；用 merge commit 保留授权提交。
- 评审：协调者逐行核过锁定文件 diff，只有开放问题 12 授权的四处断言，另外 7 个锁定文件不变。
- 验证：只改断言时锁定套件恰好四项失败，实现后本机全绿；PR 描述未单列 CI 结果。
- 新基准：`src/server.selftest.ts` sha256 为 `090741c5b244dc74160647aaf9e0e7d3a45c6c534d20e008d8af96920c7b3365`，第 1 步原值是开工基准，此后用本值。
- 给后面：README 与登录页交第 23 步；后续步骤不得再改锁定套件。

### 第 3 步 · 迁移 0008 与沙箱数据库边界（2026-10-11）

- 结构：PR #177 建齐 `tenants` 新列、索引、四张沙箱表、四个 definer 函数、渠道账号触发器与授权；schema / meta 同步，新增 `withNewSandboxTenant`。
- 评审：只读安全评审核过 definer、越权、授权、RLS、触发器与迁移安全，无问题。
- 验证：本机一次性真实 PG 下 DB 自测 1211 项、沙箱 DB 自测 454 项通过；PR 描述未单列 CI 结果。
- 给后面：本步只建与测函数，第 14、15、18 步接调用方；其余租户设置由第 4 步接。

### 第 4 步 · 平台租户 Host 与预算命令（2026-10-11）

- 结构：PR #179 已关闭，代码随 #181 合入；新增 `tenant-host` / `tenant-budget` 的 set / clear、列级 UPDATE 与审计，下次启动生效；Host 规范化放在 `hosts.ts`。
- 边界：命令只对 standard 租户；写入只收域名，IP 字面量由数据库 CHECK 拒绝，规范化函数仍能处理 IPv6 Host。
- 验证：规范化 42 例、命令 PGlite 正反例 58 项；PR 描述未单列评审修正与 CI 结果。
- 给后面：第 8 步在同一 `hosts.ts` 续写解析与中间件，避免并行覆盖。

### 第 5 步 · 状态清单检查脚本（2026-10-11）

- 结构：PR #176 用 TypeScript AST 默认拒绝未登记模块级绑定，检查陈旧条目、缺失与重复登记；建立清单格式，夹具自测串进 `test`，暂不接 `lint`。
- 修正：协调者纠正一轮统计口径；开工清单 690 项减去 194 项正则字面量、补 88 项遗漏，报告共 584 项。
- 验证：夹具自测 32 项，开工提交报告耗时约 0.85 秒；PR 描述未单列 CI 结果。
- 给后面：差异明细与空清单交第 11 步填全，再把检查接进 `lint`。

### 第 6 步 · 租户运行时、作用域与严格模式（2026-10-11）

- 结构：PR #180 的代码随 #181 合入；建运行时、作用域、状态登记与预算接口，配置、行业包、store 和后端归运行时，各入口建作用域，实例定时器与监听在空作用域启动。
- 评审修正：两路评审发现的宿主作用域泄漏、严格模式加载失败、HTTP 吞掉缺作用域错误、单租户回调误报、文件定时器与 exit spill 问题均修完，另补 OTel 严格初始化。
- 验证：锁定套件、8 个文件与 PREFIX 基准不变，02–04 全绿；v2 文件 / PGlite 各 774/774、754 条快照零差异，本机真实 PG 五套通过；PR 描述未单列 CI 结果。
- 给后面：严格重跑尚有 18 项失败，属第 7、9、10 步待搬状态，第 11 步统一收口；以后只填运行时实现，不改接口。

### 第 7 步 · 进程内状态归运行时（2026-10-11）

- 结构：PR #183 搬会话串行链、洞察 / 建议 / 草稿、检索构建、接管与去重、账本、告警、运行数字、隐私轮询与 trace 订阅；逐项登记 `keyCount` / `drop` / `reset`。
- 评审修正：关闭后的账本迟到写入、网页 turn 观察器、eval reset 漏 usage、非宿主磁盘缓存、关闭后新建槽、接管漏释放与重复告警均已修完。
- 验证：新增 `local-state` 自测；PR 描述未单列本机完整门禁与 CI 结果，核心段收口验证见第 11 步。
- 给后面：第 18 步复用异步结果落地前核对运行时的钩子；关闭后的取消返回 `deferred`，出站随之停止。

### 第 8 步 · 公开路由按 Host 解析（2026-10-11）

- 结构：PR #181 合入第 4、6 步后实现 Host 启动校验与解析、宿主独有路径隔离；订单、账号、登录 cookie 与绝对链接按解析出的租户取值，不读转发 Host。
- 评审：路由绕过、cookie 与链接无问题；另报 console 事件、隐私快照、渠道列表与账号装载四项，归第 7、9 步处理。
- 验证：新增公开路由自测覆盖同 id 订单、同 key 账号、品牌、cookie、链接与编码 / 大小写绕过；PR 描述未单列本机完整门禁与 CI 结果。
- 给后面：第 11 步 A/B 套件逐行验证公开路由表并兜住并行步骤的衔接。

### 第 9 步 · 事件、渠道、任务与 spill 按租户（2026-10-11）

- 结构：PR #184 将 SSE、console 事件、渠道注册表、任务、通知、spill 与恢复哨兵按租户分开；账本保存 / 出站订阅改实例级，通知带所属运行时。
- 评审修正：账本钩子只挂导入时租户、恢复哨兵只对宿主、事件错租户时抛错漏唤醒、非宿主 env 发送静默失败均修完；合第 8 步时处理企微与网页路由冲突。
- 补修：PR #185 修掉 #184 自动合并时漏掉的回调空闲空窗，完整回调登记 `eventTasks` 并在 finally 释放，补忙闲与租户隔离的确定性回归。
- 验证：本机真实 PG 完整测试发现 recovery 偶发 2/484 失败并定位上述空窗；recovery 断言与锁定文件未改，完整收口通过见第 11 步；PR 描述未单列 CI 结果。
- 给后面：按租户 `initChannels`、SSE 实际接线与 store reset 残余状态由第 11 步收尾；自动合并开启后不再追加提交。

### 第 10 步 · 用量按租户记账（2026-10-11）

- 结构：PR #182 将用量累加器、writer、队列与日期按租户分开；每次 fetch 前 reserve，standard 幂等结算、每日软上限只告警一次，宿主用量与访客预算口径不变。
- 评审修正：结算拉长并发名额占用并影响对冲判定、初始化失败恢复后软上限重复计费两项 major 已修，补探针自测。
- 验证：新增租户用量自测；PR 描述未单列本机完整门禁与 CI 结果，核心段收口验证见第 11 步。
- 给后面：沙箱原子预占交第 20 步；第 18、20 步接 `llm-gate.ts` 时保持并发名额释放时机。

### 第 11 步 · 清单接入 lint 与两租户隔离收口（2026-10-11）

- 结构：PR #186 登记全部 535 个模块级绑定并接入 `lint`；A/B 隔离套件核前缀、品牌、价格、付款、事件、日志、路由与 drop 清零，严格模式重跑 25 个非锁定 DB 目标。
- 评审修正：去掉测试预置作用域掩盖漏洞的做法，产品模块在作用域外 import；补请求标记选租户、渠道初始化、SSE 物理关闭、store / PG reset 与 eval 登记表 reset。
- 验证：本机一次性真实 PG 完整 `pnpm test` 通过，严格重跑 `scope_missing=0`；锁定套件与 PREFIX 不变，v2 两条路径 774/774、快照零差异；未登记集合与故意删后台作用域的反向验证均失败；PR 描述未单列 CI 结果。
- 闭合评审：只读评审复核可以合并；第 1–11 步核心段完成，第 12 步继续沙箱进程与 fencing。

### 第 12 步 · 沙箱进程与进程锁（2026-10-11）

- 结构：PR #188 接入角色、R16 启动检查与强制开关、实例级进程锁和 epoch fencing；沙箱不挂 `var/`、不写 spill，补两个角色的健康检查骨架。
- 评审修正：只读 Codex 1 major、1 minor 已修；拿锁后先推进 epoch 再读清单，避免漏装迟到提交的开通；拿不到租户锁只跳过并告警。
- 验证：真实 PG 覆盖第二进程拒绝、丢锁 fail-stop 与接手、fencing 两种先后和迟到开通装载；本机真实 PG 完整 `pnpm test` 通过。
- 给后面：基于第 11 步；第 14 步接开通与装载，第 27 步用绑定事务复验 fencing。

### 第 13 步 · 沙箱种子文件（2026-10-11）

- 结构：PR #174 新增 `seed-demo.py --fixture`、相对时间的沙箱种子与结构自测；默认模式输出逐字节不变，四个门禁不依赖 python3。
- 修正：fixture 中不存在线路的订单改用目录中的线路与标题 / 单价，各会话 `updatedAt` 对齐最后一条消息时间。
- 验证：13 个会话、3 个订单的结构自测串进 `test`，门禁由协调者补做；PR 描述未单列 CI 结果。
- 给后面：第 14 步导入时平移时间；CI 种子重新生成一致性检查已随 #199 入 CI，原推送权限待补项已被取代（见 2026-10-12 交接）。

### 第 14 步 · 从模板开通与装载（2026-10-11）

- 结构：PR #189 从宿主已发布的只读快照串行开通，单事务复制配置、隐私说明、快捷回复与种子并审计；提交后装载、取锁，失败标到期并回 503。
- 补充：迁移 0009 与 `sandbox_privacy_seed` 的权限缺口已按开工期澄清处理，见 [spec 顶部 `Revisions:`](./spec.md)，standard 只读边界不变。
- 评审修正：只读 Codex 无问题；Claude 的失败原因日志、二次失败覆盖与回滚测试缺口 3 minor 已修。
- 验证：真实 PG 核 13 个会话、3 个订单、四个哈希、待生效品牌隔离、宿主不变与重启恢复；20 次开通 p95 约 60–110 ms，注入失败时 15 张表与池计数完整回滚；本机完整测试通过。

### 第 15 步 · 免密会话、路由与写保护（2026-10-11）

- 结构：PR #190 接入 `__Host-sbx`、受限解析、沙箱 Host 路由与同源写保护，console CSRF 由 token 派生；模拟器认 `sbx-` 与本沙箱的历史会话。
- 边界：到期 / closing 回 410，无效回 401 并清 cookie；库里有效但未装载回 503、不清 cookie；有效 cookie 开通复用，口令登录与登出均 404。
- 评审修正：两路安全评审无 blocker / major；查库前限流、未装载 503、多放行前缀与带历史参数时的新会话 4 minor 已修。
- 验证：HTTP 自测在 PGlite 与真实 PG 覆盖会话安全及后端全程，本机真实 PG 完整测试通过；页面 XSS / CSP 交第 16 步，体验清单计算交第 24 步。

### 第 16 步 · 体验页与页面 CSP（2026-10-12）

- 结构：PR #194 将 `/try` 接成说明、开通进度、限额备用入口、重试与结束提示页面，只用 POST 开通；备用入口未配就隐藏。
- 边界：沙箱四类页面加载共同提示脚本，CSP 按最终内联脚本算 hash、不放外部来源；服务端接线在沙箱路由层，未改 `server.ts`，锁定源码检查照绿。
- 评审与验证：只读 Codex 无问题；新增页面自测与 HTTP 中支付页、方案书、模拟器的 XSS 文本 / CSP 断言，全量测试交 CI。
- 给后面：真实浏览器走查放在第 30 步演练。

### 第 17 步 · 结构性的出站挡板（2026-10-12）

- 结构：PR #191 在适配器、企微 push / 启动 / 拉取、任务入队与未保存转人工群通知各处拒绝沙箱；沙箱专属告警只记日志，进程级告警汇总去重照发。
- 补修：env 账号异常兜底补发送截止检查，截止后回 `deferred`、保留在途消息，补停机回归断言。
- 评审修正：两路评审的自测假通过、进程级告警被屏蔽等 2 major、2 minor 已修。
- 验证：出站自测核企微请求、通知、OTLP、jobs、账号与 poisoned 均为 0，删除挡板时反证变红；本机真实 PG 完整测试通过，并发时停机断言偶发超时、单跑通过。

### 第 18 步 · 到期删除与 reaper（2026-10-12）

- 结构：PR #193 按分钟推进可续跑的删除屏障，登记模型、embedding、配置事务与数据库写入的在途操作；先刷用量再关后端，purge 加超时，最终 drop / 放锁；补启动清理、闲置回收、结束体验与运维命令。
- 补充：迁移 0010 的重启闲置计时播种已按开工期澄清落实，见 [spec 顶部 `Revisions:`](./spec.md)。
- 评审修正：只读 Codex 三轮，修 closing 后工具改会话、CLI 丢锁继续删、删除时缓存重放退出进程、正常停机丢排队轮次 4 major；严格重跑的子进程超时预算也已修，第三轮无问题。
- 验证：PGlite 与真实 PG 共 1013 项覆盖慢模型、行锁、用量失败、purge 超时、事务中途杀进程与闲置；全量测试交 CI。
- 给后面：取消调用按预占值记账交第 20 步，签码与绑定的在途登记交第 27 步。

### 第 19 步 · 限额与写入上限（2026-10-12）

- 结构：PR #192 在锁里判活跃数、每小时 / 每日 / 每 IP 开通数，IPv6 按 /64；模板超限拒绝复制并告警，六类写入上限与 JSON 启动校验接齐，预算不足沿 `forceMock` 降级。
- 评审修正：每日日期口径、模板绕过总数上限、跨午夜 IP 计数与降级测试未走真路径 2 major、2 minor 已修。
- 验证：限额自测在 PGlite 与真实 PG 各 141 项，本机真实 PG 完整测试通过。
- 给后面：池余额判定由第 20 步接入；本步原用 UTC 的日计数已由第 20 步统一为本地日期，见该步记录与 spec。

### 第 20 步 · 沙箱预算预占（2026-10-12）

- 结构：PR #198 在每次模型 / embedding 尝试前原子预占沙箱与全池额度，实际用量结算、失败或取消按预占值记；积压超过 60 秒停调，重启恢复当天花费，开通查最低余额、池告警每日一次。
- 补充：本地日期口径、写型工具后预算不足的收尾规则与迁移 0011 已记进 [spec 顶部 `Revisions:`](./spec.md)；本步闭合第 18 步的取消记账。
- 评审修正：修日期混用、写工具重复执行、删除卡住拖停全池、trace 错位及开通 / 池告警问题；闭合核对剩余的转人工 outcome 按 spec 保留 `handoff` 并补断言。重启后各沙箱建索引的跨租户去重未改，PR 记为金额很小。
- 验证：预算自测 165 项含真实 PG、先 500 后 200 与跨本地午夜，宿主计费、访客预算、降级与 standard 软上限有回归；全量测试交 CI。
- 边界：洞察、建议、草稿只挂宿主旧接口，沙箱按 spec 回 404，console 的 429 映射留备用。

### 第 21 步 · 沙箱隔离套件与压测（2026-10-12）

- 结构：PR #200 将沙箱角色子进程的 0→2→1→0 严格隔离套件接进 `test`，覆盖失败通知、写队列、SSE、索引重试与停机；独立压测脚本用假上游，不进 `test`。
- 验证：PGlite / 真实 PG 隔离套件各一遍，约 7 秒；本机空闲时跑三遍负载对比共 373 秒，宿主等待中位数增量 0.29 ms、逐遍最大增量 1.49 ms，最大写库积压 50.7 ms；真实 PG 开通 p95 69.8 ms。
- 内存：沙箱进程空闲 / 20 个沙箱 / 峰值 RSS 为 183 / 214 / 226 MiB；p95 为 POST 到 `/me` 的后端口径，不含浏览器渲染。
- 给后面：PR 描述未列评审发现与修正，全量测试交 CI；#200 自动合并中，容器里的 p95 与 RSS 交第 30 步复测。

### 第 22 步 · 部署与回滚检查（2026-10-12）

- 结构：PR #196 接 compose 沙箱服务，部署以 `.env.sandbox` 是否存在判启用，先宿主后沙箱、沙箱健康检查总限时 90 秒；补 pre-05 判定、回滚清理 / purge 与独立 watch 状态。
- 评审修正：逐行审部署脚本；只读 Codex 4 major 中修格式错误日志泄密、试读与 compose 取值不一致、取日志挂住挡删容器 3 项。
- 裁决：`ok:false` 仍可部署成功按 R20 保留，成功只核 revision / role，异常由 watch 告警；同时有品牌风险的回滚先报 6，否则沙箱风险报 7。
- 验证：运维 528 项、回滚 164 项以假 docker / psql / ssh 覆盖分支，全量测试交 CI；真实 docker 留第 30 步演练。

### 第 23 步 · 主站入口（2026-10-11）

- 结构：PR #178 新增主站 `/try` 跳转与匿名 entry 接口，demo 登录页提供免登录体验和只读入口，prod 保持口令登录；产品标题、分享图、字体子集与 README 入口同步。
- 边界：体验链接只在 demo 配好沙箱 Host 时返回，未配时 `/try` 回 404，匿名只读工作台与投影照旧。
- 验证：PR 描述未单列评审修正、本机完整门禁与 CI 结果；浏览器视觉与真机微信分享卡片尚未验证。
- 给后面：第 30 步演练补视觉与分享卡片验证，第 24、28 步继续沙箱 console 界面。

### 第 24 步 · 沙箱横幅与体验清单（2026-10-12）

- 结构：PR #195 接剩余时间横幅、打开模拟器 / 结束体验、模拟器版体验清单与沙箱外壳；种子不算完成，四步由服务端按本沙箱数据计算，字体子集同步。
- 边界：沙箱不显示登录页，`/me` 401 跳 `/try`，写限额 / 预算错误有提示，只有 `sbx-` 会话显示模拟器入口；收起状态按沙箱存储并包异常处理。
- 评审修正：窄屏首屏滚到页面底部、清单藏在上方的 1 major 已修并补断言。
- 验证：console 沙箱 79 项、外壳 152 项，HTTP 在 PGlite / 真实 PG 覆盖完成判定与隔离；全量测试交 CI，浏览器视觉交第 30 步，微信清单交第 28 步。

### 第 25 步 · 体验客服运行时与收件（2026-10-12）

- 结构：PR #197 追加第三种企微运行时与串行收件，游标每页核 epoch 提交后派发；绑定表本步恒空，未绑定固定话术限频、无模型请求、不写租户库，启动不等首轮拉取。
- 澄清：owner 已定 Open 第 1 条，回调校验与尚未生效凭据的启动 / 重试行为见 [spec 顶部 `Revisions:`](./spec.md)，本步首个提交先记裁决。
- 评审修正：修串行发送使欢迎码过期、失败提前记限频、健康 failing 粘住与重复告警等两路 major 及 5 minor；派发不挡拉取，发送失败撤销限频。
- 验证：真实 PG 自测 1145 项含慢发送、60 秒重试、跨 30 分钟告警去重；锁定企微与 02 / 03 自测照绿、另补宿主回归，全量测试交 CI。
- 边界：健康与日志只给接口、错误码、计数等，不存敏感明文；第 26 步接出站与链接，第 27 步接绑定。

### 第 26 步 · 出站汇点、链接令牌与 `/wx/`（2026-10-12）

- 结构：PR #202 接体验客服的 02 发送账本，每次真实请求含重试、强刷、欢迎语与上传在 fetch 前同步核作用域、绑定与收件人；站内链接统一改成令牌入口，`__Host-sbxw` 只开三类页面与接口，日志遮盖令牌。
- 评审修正：endpoint 变体绕过核对的 blocker 改为规范化后精确白名单、底层请求私有；getter / toJSON 换收件人改为核对与发送同一串最终字节，token 的转换移到核对前。链接吞标点、userinfo 截断与 Unicode 域名变体改为最终字节检查，检查副本做 NFKC 与点号规范化。
- 补修：欢迎语网络异常误记 rejected、改绑后上传缩略图、`/wx/` 提前拒绝缺响应头与微信 cookie 挡住开通均修完；宿主只加同步分支、不改重试时序。
- 验证：闭合核对两轮后协调者核 diff；最终出站自测 PGlite＋真实 PG 共 485 项通过，锁定企微、02 / 03 与宿主时序回归照绿；全量测试交 CI。
- 给后面：本步绑定用测试钩子，第 27 步接真实绑定，第 29 步复验；沿用 spec R11、R21 的汇点与链接契约。

### 第 27 步 · 绑定、改绑与名额（2026-10-12）

- 结构：PR #203 接签码、扫码 / 手打、后绑的赢、三张解析表重建与名额管理；签码、绑定、解绑共用锁，库提交后才发布，事务进删除屏障并受 epoch fencing。
- 澄清：重复扫码、满额代次与迁移 0012、提交结果不确定时的恢复及码有效期裁决，见 [spec 顶部第 27 步 `Revisions:`](./spec.md)，不在本记录重复契约。
- 评审修正：回执丢失恢复旧授权且不自愈的 blocker 改为锁内回库重读、失败隔离并每分钟恢复；迟到模型写旧会话、绑定消息重放进引擎、事务等待后过期码仍能绑定、复位与新 95003 丢状态四项 major 均修。入站只等本人的绑定、重建按绑定时刻取最新，95003 不计发送失败。
- 闭合核对：正常迟到回执与丢失回执的发布结论相反，去掉提交后的进程时钟复核，两条路径都按库里 `clock_timestamp()` 条件更新结果发布，保留 `serving` 复核。
- 验证：最终绑定自测 PGlite＋真实 PG 共 115 项通过，含行锁、epoch 锁、迟到与丢失回执交错；第 25、26 步回归与锁定文件 / PREFIX 基准不变，全量测试交 CI。

### 第 28 步 · 体验清单的微信部分（2026-10-12）

- 结构：PR #204 接浏览器二维码、手打码、窄屏打开微信、过期换码与重试、绑定 / 换微信、3 分钟提示及模拟器回退；会话显示窗口、条数、送达与旧绑定拒发提示，横幅随状态。
- 评审修正：页面隐藏或清单收起仍持续签码、导致闲置沙箱永不回收的 major 已修；暂停换码并取消在途取码，恢复后只在过期时换新。
- 边界：客服链接只接受无 userinfo 的 https，`scene_param` 与后端规范化一致；新增精确版本 `uqr` 0.1.2（MIT、零依赖），只在浏览器动态加载，许可证逐字节保留；合并后需重装依赖。
- 验证：沙箱界面自测 196 项覆盖四种状态的加载 / 空 / 错误态及假时钟暂停恢复，工作台、登录页、外壳、console build 与 dist 检查通过；全量测试交 CI。

### 第 29 步 · 微信段全程套件与对抗评审（2026-10-12）

- 结构：PR #205 用真实签码与绑定串起开通、两条绑定路径、AI / 坐席回复、链接、改绑、满额与删除；PGlite / 真实 PG 各 17 场景，三种发送交错与独立记录绑定事实的全局收件人断言覆盖验收 6、16 ①–⑩。
- 澄清：微信入站闲置活动、已绑定文字 / 过期码、恢复隔离与重读任务拆分，见 [spec 顶部第 29 步 `Revisions:`](./spec.md)；微信活动是协调者裁决的规格补充。
- 评审修正：两路对抗评审未发现跨沙箱泄漏。隔离期间改绑留下旧库行、重启授权复活的 major 改为涉及的签码 / 绑定暂不可用并清旧重复行；reaper 等绑定锁停住的 major 改为客服独立单飞任务；普通 8 位文字被吞掉的 major 改为只认有效码。过期扫码撤旧绑定、单人发送失败停全池签码、微信聊天误被闲置回收及恒真断言均修完。
- 补修：套件发现借用别人的 welcome_code 被拒后仍消费码，已修；闭合核对新增的恢复不可观测与误清其他沙箱回执映射，分别加超过 10 分钟的 failing / 独立 channel 告警、只重建受影响沙箱。
- 验证：受影响自测在 PGlite / 真实 PG 通过，全程套件约 4.29 秒；锁定文件与 PREFIX 不变，宿主回归照绿，全量测试交 CI；第 25 步全进程 warn 断言的偶发失败也随本 PR 修掉。

### 第 30 步 · 本机部署与演练（2026-10-12）

- 搭法：Claude 子 agent 在本机 colima docker 的旁路 compose 项目，用一次性 PG、假 ssh、假企微与 mock 模型跑真实部署 / 回滚 / watch 脚本。相对 04 第 25 步，宿主先文件模式再切 DB，库内渠道直接 add-wecom；首次旧版部署用旧版脚本，浏览器保留宿主跳转证据后改写到本机沙箱端口。
- 结果：候选 `7a3e498` 对上一版 `demo-v5` 的八项演练全通过：上一版宿主搭建、验收 15 部署六分支、验收 13 回滚六分支、验收 10 容器角色与接手、浏览器三种入口 / 扫码 / 模拟器 / XSS、第 32 步占位凭据校验与恢复、RSS / p95、宿主 04 验收 14 全组；未发现阻挡第 31 步的产品缺陷。
- 实测：20 次开通 p95 81 ms（POST＋console＋me 的 curl 总时长，不含渲染）；沙箱空闲 / 20 个无对话沙箱 RSS 约 111 / 119 MiB，启动峰值约 231 MiB；第 21 个开通 429 并告警，四个宿主哈希全程不变。
- 演练发现：删除沙箱等容器留下空匿名卷，PR #206 改用带卷清理的 rm；另按风险原因补回滚 / 首次旧 tag 指引、平台 demo profile 说明与 end --all 到期数量输出，退出码与优先级不变。1200 px 布局与欢迎语不入工作台会话两条观察留给 owner，见最新交接。
- 偏离与清理：p95 临时提高小时 / 日开通上限、每访客不同 XFF；假企微补 Host 与 Content-Length 后复测，浏览器用 route 模拟 TLS 终止；候选与两棵旧版树各用一次性真实 PG 跑四门禁全绿，同树后续部署只跳过全量 test。容器、卷、镜像、临时 tag、worktree 与浏览器已清，截图另存，没有碰线上或其他项目资源。

## 验收记录

### 第 30 步 · 本机部署演练（2026-10-12）

以下只记本机覆盖部分，模型与企微均为替身，不据此判整条验收完成；线上与真机待第 31/32 步，全部条款汇总留第 33 步。

- 验收 4（开通 p95、种子与哈希）：20 次 POST＋console＋me 总时长 min / median / p95 / max 为 55 / 64 / 81 / 113 ms，不含浏览器渲染；13 个 `sbx-` 种子在重启后保留，种子与四哈希复制的完整断言见第 14 步，宿主四哈希演练全程不变。**本机部分通过，线上待第 31/32 步。**
- 验收 8（RSS 与负载）：容器 node RSS 空闲约 111 MiB、20 个无对话沙箱约 119 MiB，启动峰值约 231 MiB；第 21 个开通 429 `sandbox_limited` 并推池告警。负载对比引用第 21 步：三遍宿主等待中位数增量 0.29 ms、逐遍最大增量 1.49 ms，最大写库积压 50.7 ms；小时 / 日 / IP 与写上限见第 19 步。**本机部分通过，线上待第 31/32 步。**
- 验收 10（容器部分）：停沙箱时宿主 ID、启动时刻、重启次数、健康、四哈希与一句一回不变；重启保留 cookie、种子与改价，`var/` 为空、停机丢弃日志有计数。第二进程等 30 秒拒绝、epoch 与到期时刻不变；终止锁连接后旧进程立即非零退出、无后续企微请求，新进程 epoch 7→8 接手。角色拒绝、list / end / purge 与 watch 已验，绑定事务 fencing 两种先后见第 27 步。**本机容器部分通过，线上待第 31/32 步。**
- 验收 12（demo 照常）：候选版 DB 宿主通过企微 / 模拟器重置、种子保鲜、访客清理与上限、匿名只读、模拟支付与 AI 标识；企微重置消息只追加、订单作废，模拟器重置只留一条，匿名 console 从「只看演示数据」进入。宿主四哈希不变、假企微一句一回。**本机部分通过，线上待第 31/32 步。**
- 验收 13 ①–⑥（真实 docker 回滚）：① 容器在跑 / 已停仍在 / 仅 env 三种都拒绝 7，部署退出 1、现场不动；② 删容器并改名 env 后 purge 4 行再放行；③ 锁占用导致 purge 失败、purge 后幽灵行、库不可达与其他 standard 的 Host 四种都拒绝 7；④ pre-04 目标品牌风险优先报 6，清后报 7；⑤ 回旧版再部署或 compose up 均不起沙箱；⑥ 旧镜像以 `env_invalid` 拒绝沙箱角色、端口无应答。**本机 ①–⑥ 通过，线上待第 31/32 步。**
- 验收 15 ①–⑥（真实 docker 部署）：① 先宿主后沙箱、同 revision 且角色正确，等锁约 20 秒仍成功；② 坏宿主回滚、旧沙箱 ID / 镜像 / 启动时刻不变；③ 模板无效时宿主留新版、约 90 秒删沙箱并退出 1；④ 禁止变量与部分体验客服变量在第 5 步中止、容器不变；⑤ 首次 05 失败回 pre-05，env 改名 off、沙箱不起、四哈希不变；⑥ 无 env 只换宿主、旧入口与一句一回正常。**本机 ①–⑥ 通过，线上待第 31/32 步。**

## Open

- **（已定）体验客服「已配、凭据还没生效」时的表现。** owner 2026-10-12 照推荐，spec 顶部已记 `Revisions:`；以下是原文。 企微后台要先填回调 URL（保存时当场校验 echostr），才能配可信 IP、给 API 权限、拿到 Secret；open_kfid 后台若不显示，也要等有了 API 权限才查得到。而 R16 要求五个 `SANDBOX_WECOM_*` 全有或全无，缺一部分就拒绝启动。所以第 32 步的空当里只能先放真的 CorpID、Token、EncodingAESKey，Secret 与 OPEN_KFID 放占位值；R21 只说启动时取客服链接，没写取不到怎么办。推荐：回调的 URL 校验只用 Token、EncodingAESKey、CorpID；取 token 或客服链接失败时进程照常起（R19 已定体验客服失败不影响 `ok`），`/healthz.wecom.failing` 为真，不签码，`Me.sandbox.wechat` 按 `off` 处理、体验清单第一步是模拟器，每分钟重试，取到即恢复；持续 10 分钟的 `channel` 告警照发（空当里预期有一条）。owner 同意后在 spec 顶部记一条 `Revisions:` 再做第 25 步；不同意就停在第 25 步，另议上线顺序。

## 交接记录

### 交接（2026-10-11，核心段收口）

截至此刻第 1–11 步核心段、第 13、23 步已完成（已合并或正在合并进 dev），第 12 步进行中；本次只补步骤勾选与实施记录，没有代码半成品或提交。后续并行分支合并时，`package.json` 的 test 行应保留双方新增套件、逐项核对不漏不重；共享文件按既定归属串行衔接，冲突按租户语义手工合并，再跑完整门禁，不能整段选一方。开着自动合并的 PR 不再追加提交，#184 的回调空闲修复没赶上合并，已另开 #185 补回。CI 之外，每步在本机用一次性真实 PG 跑完整 `pnpm test`，跑完删除本次容器；回调空闲空窗正是本机完整测试发现的。第 13 步已把 `.github/workflows/ci.yml` 的种子一致性检查拆出另存，因推送凭据缺 `workflow` 权限，待 owner 补权限后单独提交；该项仍待补齐，不随种子文件完成而略过。下一步继续第 12 步，随后按依赖推进沙箱开通；第 23 步视觉与微信分享卡片留第 30 步演练，本文件原有 Open 留待第 25 步开工前裁决。

### 交接（2026-10-12，沙箱段收口）

- 现状：第 1–25 步除 21 外都已合入 dev；第 21 步是 #200，自动合并中。下一步第 26 步（进行中）→ 27 → 28 → 29，然后第 30 步本机演练；第 26 步及以后均未勾选，第 30 步起的部署要 owner 当次授权。
- 流程：完整 `pnpm test` 只在 CI 跑，本机不再跑全量。Codex worktree 也在 owner 本机，多路并行全量会争用资源并偶发超时；本机按改动文件用 grep 列出受影响自测清单、逐个跑，碰库的用一次性真实 PG，结束删除本次容器。CI 自 #199 起由 `scripts/ci-shard.ts` 拆成 4 片并行，一轮约 13 分钟，required check 仍叫 `check`，见 [CI 分片 spec](../ci-shards/spec.md)。PR 先不开自动合并，CI 绿了再开，开启后不再追加提交。
- 取代旧交接：上一节「每步在本机用一次性真实 PG 跑完整 `pnpm test`」已被上述 CI 全量 / 本机受影响自测取代；「ci.yml 补丁待 owner 补权限」也已过时，第 13 步的种子一致性检查已随 #199 进 CI。上一节原文保留为当时记录。
- 本次范围：只更新本 plan 的勾选、实施与交接记录及现行流程指引，没有代码半成品。第 14、18、20、25 步澄清指向 spec 的 `Revisions:`，Open 第 1 条已定；浏览器视觉、容器 p95 / RSS 与真实 docker 演练留第 30 步。
- 本次门禁：`pnpm -s format:check`、`pnpm -s lint` 与 `git diff --check` 通过；记录按步骤号连续排列、只勾第 1–25 步、旧交接原文不变、新增内容边界检查通过。只改 markdown，按任务说明未跑测试。

### 交接（2026-10-12，演练完成、待上线）

- 现状：第 1–30 步完成；第 26–29 步对应 #202–#205，第 30 步发现的修复归 #206。下一步第 31 步线上上线宿主与沙箱，体验客服先不配；每次部署须 owner 当次授权，部署前手动备份并复制到异地。第 31–35 步未勾选，spec Status 不变。
- 上线清单现状：服务器内存已只读核对放得下，数字另记在私有笔记；owner 已同意全池每天 10 元上限。沙箱子域名已定、DNS 已加（协调者用 Playwright 操作、owner 登录），反向代理（Caddy）的沙箱站点块经 owner 授权已追加并平滑重载（改前备份），主站照常、沙箱 Host 证书已签，域名与主机另记在私有笔记。还差：外部拨测在第 31 步 ② 沙箱上线后加沙箱 `/healthz`、原来拨 `/guide.html` 的改拨 `/healthz`。上线清单其他事项按第 31/32 步执行。
- 规格补充：绑定微信的入站对话算闲置活动，是协调者在第 29 步裁决的补充，见 [spec 顶部对应 `Revisions:`](./spec.md)；上线前已告知 owner。
- 留给 owner 的两条观察：视口 1200 px 时体验清单排在页面顶上，工作台列被压成上下排；绑定欢迎语不出现在工作台的会话里。演练未把这两条判为缺陷，布局与呈现是否调整由 owner 看后定。
- 本次范围：只补本 plan 的第 26–30 步勾选、五节实施记录、六条本机验收与本交接，无代码半成品。完整 test 留 CI，线上与真机验证仍待第 31/32 步，不把本机结果记成整条验收通过。
- 本次门禁：`pnpm -s format:check`、`pnpm -s lint` 与 `git diff --check` 通过；只改本文件，只新增第 26–30 步勾选，旧交接保留，新增内容未包含本机绝对路径、域名、IP、主机名、凭据、客服链接或二维码。只改 markdown，未跑测试。
