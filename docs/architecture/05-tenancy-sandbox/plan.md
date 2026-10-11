# 05 · 同部署多租户 + 一键体验沙箱 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题编号都指本 spec。共 35 步，合计约 50.25 个工程日。每步一个 PR 进 `dev`，仓库全绿、CI 通过再合。spec 已于 2026-10-11 由 owner 定为 ready，开放问题 1–15 全部照推荐定，其中 12 即授权一次性修改锁定的 `server.selftest.ts` 所列断言（第 2 步）。

## 开工条件

缺一条就停下，告诉 owner：

1. 04 spec 已是 `Status: implemented`（2026-10-11，已满足），线上 demo 跑 04 之后的版本（第 1 步核对 `/healthz` 的 `revision`）。
2. 本 spec 已由 owner 翻成 `Status: ready`，开放问题 1–15 已定（2026-10-11，已满足）。
3. 本机能跑四个门禁、一次性 `pgvector/pgvector:pg17` 容器与真实 docker 演练（compose 的旁路项目、`deploy.sh`）；真实模型凭据由 owner 在仓库外提供。
4. 不挡开工、只挡线上：沙箱 Host 的 DNS、证书与反向代理站点（第 31 步前），企微后台的体验客服接入（第 32 步，要求沙箱已上线），见「上线清单」。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」与「交接记录」，再看 `git log -5`。部署与演练照 03 plan 第 20、21 步与 04 plan 第 25、26 步的做法。代码出处以第 1 步核对后的位置为准；spec 不够用就记「Open」停下，不另定架构。
- 锁定的 8 个文件：`src/engine.selftest.ts`、`src/dejargon.selftest.ts`、`src/engine-holiday.selftest.ts`、`src/price-guard.selftest.ts`、`src/llm.selftest.ts`、`src/server.selftest.ts`、`src/adapters/wecom.selftest.ts`、`eval/cases.json`。唯一的例外是第 2 步那一个提交（开放问题 12），之后 `server.selftest.ts` 以第 2 步记下的新 sha256 为准。红了先查本步改动，确认与 spec 冲突就记「Open」停下。
- **共同门禁**：四个门禁全绿；8 个锁定文件 sha256 等于基准；`PREFIX sha256 system/tools` 与 `JSON.stringify(toolDefs)` 字节与第 1 步相同；v2 假模型回归在文件与 PGlite 两条路径全绿。新自测串进 `test`、新检查串进 `lint`；第 11 步起 `check-tenant-state` 在 `lint` 里、`TENANCY_STRICT=1` 的重跑在 `test` 里。碰库的步骤本机带一次性 `PG_TEST_URL` 跑一遍，CI 照常跑真实 PG。
- **宿主不变**（目标 7、不变量 15）：宿主进程线上只有一个运行时，单 standard 的回落只为它留。改到宿主路径的步骤以锁定套件与 02–04 自测为回归网，演练与上线另核四个哈希与 04 验收 14 那一组。
- 测试替身：本机假模型 HTTP 服务（04 R10 同一种，能晚到、能回 500）；假企微（记下每个请求的路径、`open_kfid`、`touser` 与正文，回调用测试密钥签名，能回 42001、40014、48007、95003）；两个 webhook 与 OTLP 的记录器。假 id 短（`wm` 加至多 13 位），测试密钥带 `// gitleaks:allow`。
- 本机起沙箱进程：同一份代码、同一个库，`APP_ROLE=sandbox` 加 R16 要求的变量，环境里不带 `DEFAULT_TENANT_SLUG` 与任何 `WECOM_*`；两个进程各用自己的端口。体验客服没配时沙箱照常（只有模拟器）：第 12–24 步的测试都在「没配」下跑，「配了」的情形由第 25–29 步加。
- 变异测试在隔离副本里跑；可能挂住的命令加超时（`perl -e 'alarm N; exec @ARGV' …`），收尾查 `ps`，不留进程、浏览器、容器与临时 tag。沙箱下 tsx 报 `EPERM listen` 是环境原因，在沙箱外重跑即可。
- 派 Codex：标「可派 Codex」的步骤用独立 worktree，一路实现加一路只读评审，Claude 审两路结论、改动范围（没碰锁定套件、没越出本步的文件）与关键几处，门禁以 CI 的 `check` 为准；额度紧时标 Claude 的实现步骤也可这样派。碰线上、花钱、要 owner 拍板的由 Claude 做。共享文件的分工见「工作量、依赖与并行」。这里只给派工建议，不启动并行实施。
- 线上：每次部署都要 owner 在当次会话明确授权（或 owner 自己执行）；部署前手动备份并复制到异地；先用 dev 上的本地 rc tag 上线（不推），验收通过再发版到 main。企微后台由 owner 登录、协调者用 Playwright 操作。
- 不进仓库、不进本文件：域名、服务器 IP、主机与路径、本机绝对路径、企微的 corp id / open_kfid / external_userid / Secret / Token / EncodingAESKey、客服链接、二维码、应用 id；只记不敏感的结果。

## 步骤

### 开工（第 1–2 步）

- [ ] 1. 开工核对、四张清单与反向引用（1 工程日，Claude；清单可派 Codex 写、另一路只读 Codex 评审，基准由协调者补）
  - 做：核对开工条件；记开工提交、8 个锁定文件 sha256、`PREFIX sha256` 两个值、工具定义字节、线上 `/healthz` 的 `revision` 与四个哈希；核对开放问题 12 列的行号与 spec 引用的代码出处在开工提交上仍对得上，不对的记新位置；跑四个门禁留基线。
  - 做：四张清单（spec「前置条件」）写进「实施记录 · 第 1 步」：① 模块级状态，逐项按 R5 归类，给登记名与归属步骤，是第 11 步 `state-manifest.ts` 的底稿；② 入口，R3 列的每一类在哪里建作用域、归哪一步；③ 渠道与出站路径，「渠道与出站路径」表逐行对上代码，按两类沙箱会话标自然不走、要显式挡、照企微走，表外的路径单列；④ console 的内部投影（`/status` 的 `channels`、`tenantSlug` 等）在沙箱里怎么处理。另列 02–04 在 DB 模式下的非锁定自测名单（第 11 步严格重跑用）。
  - 做：内存。沙箱进程还不存在，先用开工提交的镜像以 DB 模式、`LLM_MOCK=1`、不配企微与 `var/` 起一个进程，空闲 10 分钟记 RSS 作预估；服务器可用内存由 owner 给或授权只读查看（主机另记）。放不下就记「Open」，第 31 步之前由 owner 定；第 21、30 步用真的沙箱进程复测。
  - 做：记一句企微后台的官方提示「企业未认证，累计仅可接待100位客户」：spec 前置条件里的「约 100」由此确认为累计 100，不改 spec。00、01、02、03、04 与后台 UX spec 顶部按本 spec 文件头的条款清单补 `Superseded in part by:` / `Amended by:`，正文不动。
  - 验：共同门禁；只改文档。依赖：开工条件。
- [ ] 2. 锁定断言的授权修改与 `/` 跳转（0.5 工程日，Claude）
  - 做：一个 PR、两个提交。提交一只改 `src/server.selftest.ts` 里开放问题 12 列的几行（1167–1168、1196–1197、1210、1211–1216），别的一字不动；提交二改 `src/server.ts`：`GET /` 在两种 profile、两种配置来源下都 302 到 `/console/`，删 `public/guide.html` 与静态兜底里的它，引用它的非锁定测试与注释一并改。登录页、`/try`、README 留给第 23 步。用 merge commit 合并（不 squash），授权的那个提交原样留在历史里。
  - 验：本步前后 `pnpm -s test:locked` 全绿；`/guide.html` 的大小写与编码写法在 prod、demo、demo 关模拟器下都 404（非锁定自测）；新的 sha256 记进「实施记录 · 第 1 步」作此后的基准；对开工提交 `git diff` 锁定文件只有那几行（验收 14 前半、验收 17 的 `/` 部分）。依赖：1。

### 多租户核心（第 3–11 步）

本段结束时，两个 standard 租户能在测试里同进程交错，严格模式下作用域外访问一律抛错；宿主进程线上照旧只有一个运行时。

- [ ] 3. 迁移 0008：新列、沙箱表、四个函数与触发器（2 工程日，Claude）
  - 做：按「数据库」一次建齐：`tenants` 五列与 CHECK（带 `migration-allow` 注）、`public_host` 唯一索引、四张新表（`sandbox_process_epoch` 插 epoch 0）、四个 `SECURITY DEFINER` 函数、`channel_accounts` 的 `BEFORE INSERT` 触发器、授权与审计动作名，schema 与 meta 随之；`src/db/client.ts` 加 `withNewSandboxTenant`。迁移整份放在核心段开头：spec 只有一份 0008，第 8、10 步就要用 `public_host` 与软上限列；函数在这里只建与测，第 14、15、18 步才调。
  - 验：新自测（真实 PG）：各角色授权逐格；空 GUC 下 `agent_app` 读 `sandbox_wechat` 是 0 行；四个函数对 standard 一律报错、只取 `now()`；purge 只删已到期，删除清单覆盖系统目录里每张带 `tenant_id` 的表；resolve 的三种状态；create 的登录会话到期等于沙箱到期；触发器拒插（不变量 9、10；验收 9、11、16 ⑧ 的库层部分）。依赖：1。
- [ ] 4. 平台命令 `tenant-host`、`tenant-budget`（0.5 工程日，可派 Codex）
  - 做：R7 的 `tenant-host set/clear`、`tenant-budget set/clear`（`agent_platform`、列级 UPDATE、审计 `tenant.host_*`、`tenant.budget_*`，下次启动生效）；R4 的 Host 规范化函数建在新文件 `src/tenancy/hosts.ts`，第 8 步在同一文件续写。
  - 验：真实 PG：带端口、末尾点、大写、IPv6 字面量规范化正确，非法值被拒；沙箱租户被 CHECK 拒；审计只记字段名。依赖：3。
- [ ] 5. 状态清单检查脚本（1 工程日，可派 Codex）
  - 做：`scripts/check-tenant-state.ts` 与夹具自测，按 R5 默认拒绝；定下 `src/tenancy/state-manifest.ts` 的格式（键是「文件:标识符」），标成租户状态的要有同名登记（静态查 `registerTenantState` 的登记名）。本步只把夹具自测串进 `test`，不接 `lint`：清单要等第 6、7、9、10 步搬完，第 11 步接。
  - 验：夹具里的模块级数组、`new Map()`、事件发射器、有状态的类实例、加载时调一次的工厂闭包、`let` 都被点出位置；函数、类、import、原始类型常量、`as const`、`Object.freeze` 字面量放行；对开工提交跑一遍，点出的数与第 1 步清单 ① 对得上。依赖：1。
- [ ] 6. 租户运行时、作用域与严格模式（3 工程日，Claude）
  - 做：`src/tenancy/runtime.ts`、`state.ts` 按「租户运行时」一次建齐全部字段（`budget`、`inflight`、`cancel` 先给最小实现，第 10、18、20 步填），此后各步只填实现、不改接口。严格与否按 R3 在启动时定；`TenantScopeMissing` 在 HTTP 回 500，后台入口记日志并推 `tenant_scope_missing`。宿主进程按 R2 装载（宿主加设了 `public_host` 的 standard 租户、`tenant_host_missing`、每个租户一把锁）。配置 `loaded`（`src/config/source.ts`）、行业包绑定（`src/core/pack-api.ts` 的 `bindPack(runtime, brand)` 与 `currentPack()`）、会话与订单 Map 及后端（`src/store.ts`）挂到运行时；清单 ② 的入口逐个建作用域，实例级定时器与监听用 `withoutTenantScope`；日志的租户取作用域。
  - 验：锁定套件与前缀照旧（文件模式只有一个运行时，回落）；严格模式下作用域外 `getSession`、`currentPack()`、`currentCatalog()` 抛错，后台入口缺作用域时不退出、日志一行、告警一条（验收 2 前半）。依赖：3。
- [ ] 7. 进程内状态归运行时（2 工程日，Claude）
  - 做：清单 ① 里归本步的租户状态挂到运行时或键带 `tenantId`，并登记 `keyCount`、`drop`、`reset`：接管代次与回复去重、发送账本、洞察 / 建议 / 草稿缓存（留好落地前核对运行时状态的钩子，第 18 步用）、运行数字（去掉「拒绝非当前租户」）、隐私说明与轮询（宿主进程逐个 standard 租户）、引擎会话串行链、语义索引的共享缓存（缓存文件只在宿主）、OTel 的租户；`eval/v2/isolation.ts` 改调登记表的 `reset()`。
  - 验：共同门禁；每个登记项的 `keyCount`、`drop` 有自测。依赖：6。
- [ ] 8. 公开路由按 Host 解析（1.5 工程日，可派 Codex，安全相关由 Claude 审）
  - 做：R4 与「公开路由」表的宿主列：`hosts.ts` 的解析与中间件；订单、支付页、方案书、隐私说明、模拟器、网页入口、企微回调、console 登录各在解析出的租户里找；`accountByKey` 加租户参数；旧接口与作战室只给宿主；绝对链接按租户拼，宿主 `PUBLIC_BASE_URL` 与 `public_host` 主机名不同就拒绝启动。
  - 验：验收 3 的进程内部分（单 standard 任何 Host 都是它、多个时未知 Host 404、缺 `public_host` 以 `tenant_host_missing` 拒绝启动）。依赖：4、6。
- [ ] 9. 事件、渠道、任务与 spill 按租户（2 工程日，Claude）
  - 做：R6：领域事件带 `tenantId`；每个运行时一个 console 事件环、序号、listener 与计数去抖；`storeEvents` 按运行时分开；模拟器与网页 SSE 按（租户，会话）建键；渠道注册表装已装载 standard 租户的账号，`pushRoute` 只在会话所属租户的账号里匹配；任务 runner 每拍逐个 standard 租户认领，跟进与通知的键带租户；spill 按租户回放。
  - 验：两个 standard 租户下 SSE 与 console 事件互不可见、任务各认各的、spill 各回各的；03 的渠道、恢复与 spill 自测照绿。依赖：6（与第 7 步改的文件不重叠，有第二个 Claude worktree 时可并行）。
- [ ] 10. 用量按租户记账（1 工程日，可派 Codex）
  - 做：R15 的记账与 standard 部分：`usage_daily` 累加器按（租户、日、模型、用途）建键、每租户一个 writer；`src/tenancy/budget.ts` 的 `TenantBudget` 与 standard 实现（恒返回只记账的 `Reservation`）；`src/llm-gate.ts` 每次 fetch 之前经作用域调 `reserve`；`usage.json`、`/api/usage`、`budget.json` 只管宿主；`llm_daily_alert_milli` 当天越过告警一次。
  - 验：验收 7 的 standard 部分（只告警一次、不降级、作战室口径不变）。依赖：6。
- [ ] 11. 清单接入 lint 与两个 standard 租户的隔离套件（2 工程日，Claude）
  - 做：按第 1 步清单写全 `state-manifest.ts`，`check-tenant-state` 接进 `pnpm lint`；`src/tenancy/isolation.selftest.ts` 的两个 standard 租户部分（R17 的 A、B，假模型记 system 与 tools 字节，B 的响应晚到）；`test` 末尾加 `TENANCY_STRICT=1` 重跑第 1 步列的 02–04 DB 模式非锁定自测（放进 `test`，CI 与本机都跑）。
  - 验：验收 1；验收 2 的清单与严格重跑部分（在隔离副本里往 `src/` 某模块顶层加一个不进清单的数组或 `new Map()`，`pnpm lint` 失败，补上后通过）；验收 3 的路由表逐行（两个租户各设 `public_host`）。真实 PG 部分带 `PG_TEST_URL`。依赖：5、7–10。

### 沙箱（第 12–22 步）

本段做不带微信的沙箱：体验客服不配，只有模拟器。

- [ ] 12. 沙箱进程：角色、启动检查与进程锁（2 工程日，Claude）
  - 做：`src/tenancy/sandbox/role.ts`：`APP_ROLE`、R16 的全部启动检查与强制开关，基线开关日志行不变、角色与生效值另打一行；R2 的进程锁（至多等 30 秒、`sandbox_already_running`）、epoch、锁丢了 fail-stop（绕开 `gracefulExit`）、fencing 的事务工具；只装沙箱、只答 `SANDBOX_HOST`（别的 Host 只有 `/healthz`）；不挂 `var/`、不写 spill（停机排空，10 秒后丢弃并记条数）；不起注册表、任务 runner 与 `kf-main`；`LLM_MAX_INFLIGHT`、不设对冲；R19 的两个 `/healthz`（宿主加 `role`，多 standard 时 `ok` 并入其余租户；沙箱的 `wecom` 先恒为未配）。
  - 验：验收 6 的启动拒绝部分（含体验客服变量的三种拒绝）；验收 10 的角色、第二个进程被拒、`pg_terminate_backend` 之后 fail-stop 与 epoch 两种先后（先用一个受 fencing 的测试写代替绑定事务，第 27 步用绑定复验）、`var/` 没有新文件、停机丢弃有条数。真实 PG。依赖：11。
- [ ] 13. 沙箱种子文件（0.75 工程日，可派 Codex）
  - 做：`scripts/seed-demo.py --fixture` 生成 `data/sandbox-seeds.json`（默认场景，时间存相对值）；`src/tenancy/seed-fixture.selftest.ts` 串进 `test`；`.github/workflows/ci.yml` 在四个门禁之外加一步：重新生成，与仓库里的不同就失败（本步独占 `ci.yml`）。
  - 验：验收 14 的种子部分（13 个会话、3 个订单、引用对得上、线路 id 都在 `data/routes.json`、时间是相对值；四个门禁不依赖 python3）。依赖：1。
- [ ] 14. 从模板开通与装载（2 工程日，Claude）
  - 做：R8、R9 与「开通与删除」的开通部分（路由与 cookie 在第 15 步）：只读、可重复读的事务读宿主已发布快照；一个事务里 `sandbox_tenant_create` → `withNewSandboxTenant` → 复用 `src/config/transfer.ts` 与 `src/cli/session-transfer.ts` 写配置、隐私说明、快捷回复、种子（新 `sbx-` id、`simulator`、时间平移）与 `sandbox_wechat` 行（链接令牌）→ 审计 `sandbox.create`；提交后按启动的同一条路径装载、取锁、登记，失败就 `sandbox_tenant_expire` 并回 503；开通在进程内串行，R14 的判定点先留空（第 19、20 步填）；启动时装载未到期的沙箱。
  - 验：验收 4 中 p95 与 cookie 复用之外的全部；沙箱进程重启后活着的沙箱还在（验收 10 前半）。真实 PG。依赖：12、13。
- [ ] 15. 免密会话、沙箱路由与写保护（2 工程日，Claude）
  - 做：R10 与「公开路由」表的沙箱列（体验客服回调与 `/wx/` 除外）：开通响应签发 `__Host-sbx`；`sandbox_session_resolve` 的三种结果对应 410 / 401 两套返回并清 cookie；`POST /api/sandbox`（同源、JSON、有效 cookie 复用）、`POST /api/sandbox/end`、沙箱 Host 的 `/`；console 在沙箱上没有口令登录、不读 `__Host-sid`（宿主不读 `__Host-sbx`），`x-csrf` 由 token 派生，`Me.sandbox`（`wechat` 先恒为 `off`，`steps` 由服务端按沙箱自己的数据算），清单 ④ 的投影；模拟器把 `sim-<x>` 对照成 `sbx-<x>`、认 `?c=<id>`、刷新恢复历史；所有非安全方法过 `isCrossSite`；记最近访问（闲置回收在第 18 步）；脱敏正则认 `sbx-`。
  - 验：验收 11 中页面 XSS 之外的全部；验收 4 的 cookie 复用；验收 5 的后端部分。依赖：14。
- [ ] 16. `/try` 页面与沙箱页面的 CSP（1 工程日，可派 Codex）
  - 做：`public/try.html`（照「界面 · `/try`」：说明、开通进度、被限额拒绝时给宿主只读工作台与网页模拟器两个入口、出错重试、`?ended=1` 的提示；只有 POST 开通）；沙箱进程页面的 CSP（`chat.html`、`pay.html`、`proposal.html` 的内联脚本按 hash 或 nonce 放行，不许外部来源）；沙箱模拟器的顶部提示。改 `chat.html` 时锁定 `server.selftest.ts` 对它源码的几项检查照旧通过。
  - 验：验收 11 的 XSS 一句（支付页、方案书、模拟器当文本显示，响应带 CSP）；沙箱 Host 上 `GET /try` 不开通（验收 17 的一句）。依赖：15。
- [ ] 17. 结构性的出站挡板（1 工程日，可派 Codex，Claude 审）
  - 做：R11 中与体验客服无关的部分：沙箱的 `TenantStore.queueJobs` 丢弃任务操作；`noteUnsaved` / `onHandoffUnsaved` 按租户跳过沙箱；宿主进程的企微 `pushRoute` 与 `push` 拒绝沙箱租户的会话（DB 与 env 两条分支）；`adapterFor` 对沙箱租户只返回模拟器适配器（体验客服的第 26 步加）；只关乎某个沙箱的告警只记日志；照清单 ③ 逐行补测。
  - 验：验收 6 中不配体验客服的那一半（企微 API、两个 webhook、OTLP 换成记录器，最早的种子会话接手回复、无 SSE 时回复、一次落库失败、advisor 建单、一次转人工、一次进程级告警；种子与模拟器会话 0 个企微请求，群通知 0、OTLP 0，沙箱 `jobs` 与 `channel_accounts` 0 行，没有 poisoned，插 `channel_accounts` 被触发器拒）。依赖：15。
- [ ] 18. 到期删除、reaper 与运维命令（2.5 工程日，Claude）
  - 做：R12、R13：reaper 每分钟（实例级定时器，逐个沙箱进作用域）走 ① 到 ⑥，没成就停在原地、下一分钟重来；运行时的取消信号与在途登记（模型与 embedding 请求、配置写事务、写队列的数据库操作；签码与绑定事务第 27 步登记），promise 落定才算结束，迟到的结果落地前核对运行时状态；先刷用量、再关后端；purge 事务的锁与语句超时；⑥ 摘运行时、逐项 `drop`、放锁；启动时先删到期的；闲置回收；「结束体验」；`src/cli/sandbox.ts` 的 `list`、`end`、`purge --all`（拿不到锁以 3 退出）；`sandbox_purge` 告警、`/healthz.purgeOverdue`、删除日志一行。
  - 验：验收 9 中与微信无关的全部（30 秒还没返回的模型请求、被另一条连接的行锁挂住的配置写事务、用量写入失败、purge 锁超时、删除事务中途杀进程、「结束体验」与闲置）；不变量 7 以超级用户按系统目录数行；验收 10 的三个命令。真实 PG。依赖：15。
- [ ] 19. 限额与写入上限（1.5 工程日，可派 Codex）
  - 做：R14：开通在锁里判的各项（每 IP 按 IPv4 地址、IPv6 /64）、每个沙箱的新会话数与 SSE 至多 10 条、写入的六项上限与 `sandbox_write_limited`、模型降级之后写额度照计；数值取 env（「环境变量」表、开放问题 8）。只改 `src/tenancy/sandbox/limits.ts` 与第 14、15 步留的判定点。
  - 验：验收 8 的上限部分，每项各验一次（含同一 /64 的两个 IPv6 地址）。依赖：15。
- [ ] 20. 沙箱预算预占（1.5 工程日，Claude）
  - 做：R15 的沙箱部分与「预算」：尝试层同步预占本沙箱与全池（预占值的估算、未知价格按最贵价），按实际用量结算或按预占值记；对话降级 mock（`outcome = 'budget'`，与宿主 `sim-` 的访客预算走同一个 `forceMock`），洞察、建议、草稿回 429，索引不重建；还没落库的用量超过 60 秒全停；重启读回已花数与池的当天数（含已到期还没删的沙箱）；首次建索引记在池上；`sandbox_pool` 告警；开通的池判定接进第 19 步的判定点。
  - 验：验收 7 的沙箱部分。真实 PG、假模型（先回 500 再回 200）。依赖：18、19。
- [ ] 21. 沙箱进程的隔离套件与压测（1.5 工程日，Claude；压测脚本可派 Codex）
  - 做：`isolation.selftest.ts` 的沙箱进程部分：从 0 个运行时开通到 2 个、交错对话、删到 1 个再到 0 个，全程严格，覆盖提交失败通知、写队列重试、SSE 复核、索引重试与停机钩子；`scripts/load/` 加一组（不进 `test`）：20 个沙箱各连发 5 轮、一个沙箱按写上限连续写，宿主同时跑基线负载，有无沙箱各 3 遍取中位数。
  - 验：验收 2 的沙箱部分；验收 8 的压测（宿主每轮排队中位数多不超过 1 秒、写库积压不超过 2 秒，沙箱进程空闲与 20 个沙箱时的 RSS）；验收 4 的开通 p95（20 次，真实 PG）。依赖：17、20。
- [ ] 22. compose、`deploy.sh`、`watch.sh` 与回滚检查（2 工程日，可派 Codex，Claude 审）
  - 做：`deploy/compose.yml` 加 `sandbox` 服务（profile `sandbox`、`APP_ROLE=sandbox`、`../.env.sandbox`、宿主端口另取且只绑 127.0.0.1、不挂 `var/`），文件头写明只重建沙箱的手工命令（带 `--profile sandbox`、`--no-deps`）；`deploy.sh` 照 R20：第 5 步试读 `.env.sandbox`，第 7 步先宿主后沙箱（沙箱 90 秒，失败只删沙箱容器并以 1 退出），`pre-05` 判定，自动回滚到 pre-05 前先删容器、改名；`deploy/rollback-guard.sh` 照 R18 的三项与退出码 7（同时有品牌风险先报 6）；`deploy/watch.sh` 有 `.env.sandbox` 时另拨沙箱的 `/healthz`。
  - 验：`ops.selftest.ts`、`rollback-guard.selftest.ts` 用假 `docker`、`psql` 与 `bash -s` 覆盖验收 13 ①–④、验收 15 ①–⑥ 的分支；真实 docker 在第 30 步。依赖：12、18。

### 主站入口与体验界面（第 23–24 步）

- [ ] 23. 主站入口（1.5 工程日，可派 Codex）
  - 做：R23 除第 2 步之外的部分：宿主 `/try`（demo 且配了 `SANDBOX_HOST` 时 302，否则 404）、`GET /api/console/entry`；登录页的「免登录体验」次级按钮与「只看演示数据」文字链接，demo 匿名先到登录页，外壳里的「登录」回登录页，去掉「返回演示」；prod 是纯登录页；分享卡片（登录页标题上方一张真实可见的产品图，`<title>` 是产品名）；README 在线体验表的「引导页」一行、第 319、454 行，引导页「它是怎么工作的」一节从开工提交的 `public/guide.html` 取出挪进 README。
  - 验：验收 17 中可自动化的部分（三种 profile 组合、按钮出现的条件、`/try` 的跳转）与验收 12 的「只看演示数据」；console 登录页与外壳的自测随之改（非锁定）。依赖：2（可与核心段并行；`src/server.ts` 只加 `/try` 一个路由，尽早合）。
- [ ] 24. 沙箱 console 的横幅与体验清单（1.5 工程日，可派 Codex）
  - 做：照「界面 · 沙箱 console」：横幅（剩余时间；没配体验客服时写「只进模拟器」）、「打开模拟器」「结束体验」、会话详情的「在模拟器里打开」（只对 `sbx-`）、沙箱上不显示登录页、`/me` 回 401 时跳 `/try`、`sandbox_write_limited` 与 `llm_budget_exhausted` 的提示（按 spec 的错误码，不等第 19、20 步）、右侧体验清单（第一步先是模拟器版；收起状态按沙箱记在浏览器里，读写包 try/catch）、`Me.sandbox` 的类型。
  - 验：console 自测覆盖加载、空、错误三态与清单四步的完成判定；验收 5 的工作台一侧。依赖：15、23。

### 微信：体验客服（第 25–29 步）

体验客服没配时沙箱照常工作，前面各步都不依赖本段；本段的代码随第 31 步一起上线，第 32 步再在企微后台接上。

企微后台现状（2026-10-11 owner 与协调者实测）：已建客服账号「云途定制旅行·体验」（暂为人工接待、未交给 API）与自建应用「体验客服接入」（可见范围只有 owner，未配回调、可信 IP、API 权限）；「可调用接口的应用」是复选框多选，「企业内部开发」是「应用 → 可管理的客服账号」表，界面上支持多应用各管各的账号。卡点：没配可信 IP 的应用拿不到微信客服 API 权限，配可信 IP 之前必须先配可信域名或接收消息的服务器 URL。所以回调路由要在拿到体验客服的 Secret 之前就上线并通过 URL 校验（echostr），它与 R16「五个变量全有或全无」之间的空当见「Open」第 1 条。

- [ ] 25. 体验客服运行时与收件（2 工程日，Claude）
  - 做：R21 的第三种运行时与收件（`src/adapters/wecom.ts`、`src/tenancy/sandbox/wecom.ts`），env 与 03 两种运行时的行为一字不变；五个变量配齐才挂不带 key 的 `/wecom/callback`，GET 的 URL 校验只用 Token、EncodingAESKey、CorpID，不依赖 access_token 与客服链接；POST 触发串行的 `kf/sync_msg`，cursor 存 `sandbox_wecom_state`、每页先提交（核 epoch）再派发，没有 cursor 只认启动前 10 分钟之后的；按绑定表找沙箱（本步表恒空，一律当未绑定）→ R22 的固定话术与限频；启动经 `kf/add_contact_way` 取客服链接、只放内存，取不到时照「Open」第 1 条的裁决；`/healthz.wecom` 的 `configured`、`lastSyncOkAt`、`failing`，持续失败 10 分钟推 `channel` 告警（账号 key `sandbox`）。
  - 验：锁定 `wecom.selftest.ts` 与 `wecom-02`、`wecom-03` 自测照绿；假企微：签名错被拒，`gettoken` 一律失败时用测试密钥签的 echostr 照样回明文；没配时回调 404（验收 16 ⑩ 前半）；未绑定的人连发三条只回第一条、没有模型请求、任何租户的库里没有他（验收 16 ⑤ 前半）。依赖：17、owner 对「Open」第 1 条的确认。
- [ ] 26. 出站汇点、链接令牌与 `/wx/`（2 工程日，Claude）
  - 做：R21 的出站与 R11 的汇点核对：走 02 的发送与账本（`outbound_sends.account_id` 为空，停机时没结果的段记 `unknown`，不补发）；`callApi` 与 `postSendMsg` 在 `fetch` 之前同步核对 `open_kfid`、`touser`、welcome_code 表与作用域外的固定话术，覆盖每次重试与 token 强刷之后的重发，不符就记失败并推 `sandbox_send_refused`；回执的 msgid → 沙箱表；`adapterFor` 与沙箱进程的 `pushRoute` 对沙箱的 `wecom:` 会话返回体验客服；请求体里的链接改写（卡片 URL 含 `extractCard` 重建的、正文、卡片失败后的补文、欢迎语里的隐私链接）；`GET /wx/:token/*`、`__Host-sbxw`、只开三类页面与它们的接口、两个响应头；两种 profile 下日志遮盖令牌，不进审计与 `/healthz`。
  - 验：验收 16 ②、⑨；验收 6 的故意违规中不需要真实绑定的几条（`open_kfid` 换值、作用域外的非固定话术、不在表里或属于另一个沙箱的 welcome_code）；需要绑定的用测试钩子直接发布，第 29 步用真实绑定复验。依赖：25。
- [ ] 27. 绑定、改绑与名额（2.5 工程日，Claude）
  - 做：R22 全部：`POST /api/sandbox/wechat/code`；进程内三张解析表在拿到 epoch 之后从各沙箱的 `sandbox_wechat` 重建，全部装完才起体验客服运行时；签码、绑定、解绑过同一把互斥锁，照 R22 的发布顺序与失败恢复，发布与恢复前复核 `serving`；扫码（`scene_param`）主路径与手打码备用；后绑的赢、旧会话留作历史；绑定欢迎语与 welcome_code 关联的填写时点；签码与绑定事务进第 18 步的在途登记；名额已满（95003）的置位、入库、重读、新签码 409、不再回话术、`sandbox_wecom_full` 告警与 `sandbox wecom-reset-full`；`Me.sandbox.wechat` 的四种状态与 3 分钟提示的条件。
  - 验：验收 16 ①、③–⑧、⑩ 的后端部分；验收 9 的绑定部分（绑定事务挂住时到期或点「结束体验」）；用绑定事务复验验收 10 的 epoch 两种先后；不变量 18、22。真实 PG、假企微。依赖：18、26。
- [ ] 28. 体验清单的微信部分（1 工程日，可派 Codex）
  - 做：照「界面 · 沙箱 console」体验清单的第一步：二维码（新增一个 MIT 的二维码库，钉精确版本，只在浏览器里生成）与 `XXXX-XXXX`、窄屏「在微信里打开」、过期自动换新、取码失败重试、「已连上你的微信」与「换一个微信」、3 分钟提示、名额已满与没配时换成模拟器；绑定微信的会话显示窗口、剩余条数、送达状态与「这个微信已不再连着这次体验」；横幅文字随状态。
  - 验：console 自测覆盖 `wechat` 四种状态各自的三态；验收 16 ①、③、⑩ 的界面一侧。依赖：24、27。
- [ ] 29. 微信段全程套件与对抗评审（1 工程日，Claude；另派一路只读 Codex 对整段做对抗评审）
  - 做：用假企微把验收 16 ①–⑩ 与验收 6 的完整版（含三段回复发出第一段后改绑、假企微先回 42001 而 token 强刷期间改绑、在 A 的作用域里发给 B 绑定的微信）串成一个全程套件。评审重点：汇点核对与 `fetch` 之间有没有 `await`、在途登记是否覆盖签码与绑定、`closing` 之后有没有迟到的发布、日志里搜不搜得到令牌。
  - 验：验收 6、16 ①–⑩ 全部通过；评审结论与改动记进实施记录。依赖：27、28。

### 演练、上线与收尾（第 30–35 步）

- [ ] 30. 本机部署与演练（2 工程日，Claude）
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

- `package.json`：各步只在 `test` 末尾追加自己的自测，合并时手工合；`lint` 只由第 11 步改。`.github/workflows/ci.yml` 只由第 13 步改。
- `src/tenancy/runtime.ts` 的接口由第 6 步一次建齐，之后各步只填实现；`src/core/pack-api.ts` 只由第 6 步改。
- `src/server.ts`：2 → 23（只加 `/try`，先合）→ 6 → 8 → 12 → 15；Codex 步骤碰它要等前一步合并后 rebase。
- `src/adapters/wecom.ts`：9（`pushRoute` 按租户）→ 17（拒绝沙箱会话）→ 25 → 26，同一时间只开一个。`src/store.ts`：17 只改 `queueJobs`，先于 18 合。
- `src/llm-gate.ts`：10（`reserve` 挂点）→ 18（取消与在途）→ 20（预占）。`console/src/`：23 → 24 → 28。
- 第 25–27 步改同一片体验客服与绑定代码，只能串行。

要砍就砍微信段（第 25–29、32 步，约 9 个工程日）：体验客服不配时沙箱照常只有模拟器（R21），但验收 16 与目标 5 的「自己的微信就是客户」随之落空，spec 要记 `Revisions:`，只有 owner 能定。其余各段互相依赖，不能单独砍。

## 上线清单

第 30–32 步的演练、上线与体验客服接入是本 spec 的完成条件。下面是仓库外要做的事，标谁做、什么时候；域名、IP、主机、凭据另记。

- [ ] 服务器内存放得下宿主加沙箱进程（第 1 步预估，第 21、30 步实测）。协调者核对、owner 定；第 31 步前。
- [ ] 沙箱 Host 的 DNS 与证书。owner；第 31 步前。
- [ ] 反向代理加沙箱站点块，指向沙箱的宿主端口（只绑 127.0.0.1）；两个站点块都原样转发 Host、不写 `header_up Host`，主站块别的不动。owner（协调者可代拟配置）；第 31 步前。
- [ ] 外部拨测加沙箱 Host 的 `/healthz`（顺带盯证书续期）；原来拨 `/guide.html` 的改拨 `/healthz`。owner；第 31 步。
- [ ] 花费点头：上线后沙箱每天至多 10 元（池上限，开放问题 8），验收约 1 元。owner；第 31 步前。
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

## 验收记录

## Open

- **体验客服「已配、凭据还没生效」时的表现（第 25 步开工前请 owner 确认）。** 企微后台要先填回调 URL（保存时当场校验 echostr），才能配可信 IP、给 API 权限、拿到 Secret；open_kfid 后台若不显示，也要等有了 API 权限才查得到。而 R16 要求五个 `SANDBOX_WECOM_*` 全有或全无，缺一部分就拒绝启动。所以第 32 步的空当里只能先放真的 CorpID、Token、EncodingAESKey，Secret 与 OPEN_KFID 放占位值；R21 只说启动时取客服链接，没写取不到怎么办。推荐：回调的 URL 校验只用 Token、EncodingAESKey、CorpID；取 token 或客服链接失败时进程照常起（R19 已定体验客服失败不影响 `ok`），`/healthz.wecom.failing` 为真，不签码，`Me.sandbox.wechat` 按 `off` 处理、体验清单第一步是模拟器，每分钟重试，取到即恢复；持续 10 分钟的 `channel` 告警照发（空当里预期有一条）。owner 同意后在 spec 顶部记一条 `Revisions:` 再做第 25 步；不同意就停在第 25 步，另议上线顺序。

## 交接记录
