# 14 · 用量限制 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。

## 开工条件

缺一条就停下，告诉 owner：

1. 本 spec 已由 owner 于 2026-10-31 定为 `ready`，开放问题 1–5 已定；翻 `ready` 的 docs PR 同时给 01 加 `Superseded in part by:`，给 05、01 加 `Amended by:`，主参考「阶段 8」加一条。
2. 11 的代码已在 `dev`（已满足）。
3. 本机能跑四个门禁、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。

## 开工须知

- 先读 `AGENTS.md`、本 spec、05 spec 的 R15、`docs/spec-driven-dev.md`、`git log -5`。
- 锁定的 8 个文件一个字节都不改；四个哈希全程不变。
- 测试随批合入，每一批合并时是绿的。新自测接进 `package.json` 的 `test` 行，跑 `scripts/ci-shard.ts --check 4`。
- 第 2、3 步并行时，两步之间的共享契约是 `limitVerdict()`、`noteAiReply()` 的签名，先合第 1 步再开工；合并后要有走真实链路的贯穿用例，不用假门面。

## 步骤

- [x] 0. 开工核对。对照 spec 引用的行号核对现状；列出读 `usage_daily` 的所有路径，确认 `reply` 行不影响现有数字（模型费用、运行数字、`/api/usage`）。结果记进实施记录。依赖：无。
- [x] 1. 数据与状态（R2、R3）。
  - 文件：新迁移与 journal、`src/db/schema.ts`、`src/db/repo/tenants.ts`、`src/usage.ts`、`src/db/repo/usage.ts`、`src/tenancy/limits.ts`、`src/tenancy/state-manifest.ts`、`src/ops/alert.ts`。
  - 验：迁移检查通过；月度计数跨日、跨月、重启后接得上（注入时钟）；轮询失败保留旧值；严格租户模式下两个租户不串（验收 11）。
  - 依赖：0。
- [x] 2. 启动隔离（R6 启动部分）。
  - 文件：`src/config/source.ts`、`src/config/config.selftest.ts`。
  - 验：验收 8（真实 PG）。
  - 依赖：1。
- [x] 3. 引擎闸门（R4、R5、R6 运行部分）。
  - 文件：`src/core/engine/index.ts`、`src/handoff/reasons.ts`、`src/tenancy/budget.ts`、跟进任务入口。
  - 验：验收 2、3、4、5、7；`done()` 与跟进都计数；固定句不计数。
  - 依赖：1。
- [x] 4. 单客户限速（R7）。
  - 文件：`src/tenancy/customer-rate.ts`、`src/core/engine/index.ts`、`src/tenancy/state-manifest.ts`。
  - 验：验收 6。
  - 依赖：3。
- [x] 5. 命令行（R8）。
  - 文件：`src/cli/tenant-budget.ts`、`src/cli/tenant-settings.selftest.ts`、`src/shared/ui-labels.ts`。
  - 验：子进程测每个子命令与审计；拒绝沙箱租户；验收 9 的本机部分。
  - 依赖：1。
- [x] 6. 用量读接口（R9）。
  - 文件：`src/console-api/`、`src/shared/console-api.ts`。
  - 验：验收 10。
  - 依赖：1。
- [x] 7. 贯穿用例。不用假门面，走真实的命令行写库 → 轮询 → 引擎 → 转人工，覆盖验收 2、7、9。依赖：3、5。
- [x] 8. 中期审查与回滚演练。对照不变量与验收核证据；另派一路只读评审；真镜像演练 R11（验收 12）。依赖：1–7。
- [ ] 9. 上线（随 11 一起，owner 当次授权）。按开放问题 3、4 的结论写 `.env` 与上限，只读核对四个哈希与演示行为。依赖：8。
- [ ] 10. 对照全部验收逐条验证并记录。依赖：9。
- [ ] 11. 清理临时探针、容器与后台进程。依赖：10。
- [ ] 12. owner 确认后翻 `Status: implemented`。依赖：11。

## 工作量与并行

- 第 2、3、5、6 步在第 1 步之后可并行，只同改 `package.json`。第 4 步等第 3 步。
- 按 03–12 的实际速度折算，日历时间约一两天，不含等 owner 授权与上线。

## 实施记录

下列来源文件名均相对本任务的 runs 目录；结果按实施先后记录，日期均为 2026-10-31。

### 第 0、1 步 · 数据与运行时状态

来源：`14-core.result.md`。完成现状与 `usage_daily` 全部读取路径核对；新增 0023 的两个上限列、约束、`reply` 用途与列级更新授权。回复事件费用和 token 为 0，不进入旧的 usage.json 统计；费用汇总、视觉用途过滤及沙箱读取不变。实现启动计数恢复、30 秒轮询、失败保留旧值、跨月归零、80%/100% 告警和状态登记。PGlite、真实 PG、严格租户套件通过，`scope_missing=0`；两条 v2 均 923/923、快照 0 差异。

### 第 2–4 步 · 引擎闸门及补充修复

来源：`14-gates.result.md`、`14-gates-fix.result.md`、`14-gates-fix2.result.md`。允许停用租户启动隔离装载；接入停用、额度、限速、日费用熔断及跟进跳过。回复在存储分配序号时统一计数，排除三句固定话术；转人工沿用旧镜像认识的 `failure` kind，新增原因文字为普通字符串。PGlite、真实 PG 覆盖验收 2–8、11，锁定与受影响回归通过，四个哈希不变。

引擎外路径补充：停用时欢迎语、非文本引导和附件等待提示不发，异步等待后发送前复核；非文本静默记录，不占固定句次数。旧欢迎语及旧 pending 附件等待沿用取消规则；已入库的原轮回复恢复时只交付原文，不重新生成或计数。`suspendedReplyAt` 随会话状态落库，新进程真实 PG 重启及历史窗口裁剪后仍不重复。客户固定话术移至 tenancy，字体检查通过，未重建字体。

审查记录：闸门一度排在紧急与撤回同意之前，已恢复为「客户消息记录 → 紧急 → 撤回同意 → 已转人工静默 → 闸门 → 其余」。三种受限状态 × 两类请求在 PGlite、真实 PG 全过；隔离副本中移回错误顺序，六个场景全部失败（退出 1），恢复后通过。R6 的「不转人工」针对普通消息；紧急及行权优先于闸门和「至多一句固定句」。

### 第 5、6 步 · 平台命令与用量读接口

来源：`14-ops.result.md`、`14-ops-fix.result.md`。新增 quota、cap、status、show，保留 set/clear；写入与字段名审计原子提交，拒绝沙箱与越权。新增 owner/admin 的 `GET /api/console/usage`，按月及按日聚合回复数、费用与上限；其他角色、匿名及沙箱均 403，不含会话内容，验收 10 通过。

初次发现平台缺少 usage_daily 读取权限，隔离验证后经授权追加 `0024_platform_usage_read.sql`，仅 GRANT SELECT 给 agent_platform，0023 保持不变，FORCE RLS 继续隔离租户。补迁移后 CLI 的 PGlite、真实 PG 子进程套件通过，生产 30 秒轮询使 CLI 写入的新额度生效（验收 9 本机部分）。

审查记录：`src/db/brand.selftest.ts` 的 tenants 列白名单曾漏加两个上限列，导致 CI 失败；已补齐，保留白名单断言。

### 第 7 步 · CLI、轮询、引擎与用量接口贯穿

新增 `src/tenancy/limits-e2e.selftest.ts`，接在 package.json 的 test 行末尾。一次性真实 PG 上，经实际 CLI 子进程、平台授权与审计、真实租户锁、生产轮询体、真实引擎和成员登录后的 HTTP 路由贯穿；仅模型传输使用合成替身。CLI 写库后先断言运行时快照仍旧，再调用现有轮询入口，生产 30 秒默认值未改。

- 「14 验收 2、9」：CLI quota=2，正常回复 2 条，第 3 条转人工；quota --clear 后新会话恢复，已转人工会话保持静默，接口 replies.used=3。
- 「14 验收 7、9」：CLI status=suspended，同会话仅一次固定句、不转人工且无模型请求；active 后原会话恢复，接口 replies.used=4，固定句不计数。
- 「14 验收 5、9」：CLI cap=0，真实 chat 费用闸门阻止网络请求并以日上限原因转人工；cap --clear 后恢复，接口 replies.used=5。
- 各阶段均刷新真实 usage_daily writer，核对 GET /api/console/usage、数据库 reply calls 和实际落库 AI 回复数一致；6 次 CLI 更新均有审计。

### 第 8 步 · 真镜像回滚演练（2026-10-31，演练阶段记录）

按 `11-step8-drill.md` 的隔离方式实测，未运行 deploy.sh、未连接生产或真实模型。旧镜像 `wsa14-drill:pre14` 来自 `git archive demo-v11`（提交 `10f56dc5c4e7fe418f285e807cb567fbc10af372`），镜像 ID `sha256:3758a18516595569c3b7157d3c9fe24eef9087932990e776a4fe5368bb3f0aa8`；新镜像 `wsa14-drill:cur` 来自本分支工作区（生产代码基于 `7383989c`），镜像 ID `sha256:2fb130ffe4cfd733bfde00302c34f3b958c20a625197752dddfd8ff3bf263f90`。镜像本地构建均退出 0；Buildx 活动目录位于临时工作目录。

一次性 `pgvector/pgvector:pg17`、专用网络 `wsa14-drill-net` 和命名卷 `wsa14-drill-pgdata`、`wsa14-drill-appdata`。新版镜像以 agent_owner 执行全部 25 条迁移，0023、0024 的落库哈希与文件一致。真实引擎写入 1 条零费用 reply 计数、两种 failure 新原因和 suspendedReplyAt；合成 chat 费用基线为 123 厘（0.123 元）。初始化探针只读挂载已有 roles/extensions 文件，配置读取使用真实 PG 租户锁。模型与通知传输均被合成替身截获，embedding 使用 demo 允许的回环地址并确定性失败后回退关键词，无外部请求。

| 验证项         | 实测结果与证据                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新版前滚基线   | 真实 server 的 /healthz 为 200；额度和日上限均为 0，新消息被额度闸门拦下，模型调用 0；metrics 费用 0.123 元。                                                                                |
| 旧版连接新版库 | /healthz 为 200，只警告库里多出 3 条迁移（0022、0023、0024），没有迁移错误。旧版预算、metrics、视觉限额与沙箱池用量读取成功；视觉预占获准、沙箱池费用为 0，标准租户 reply 行不串入这些用途。 |
| 旧版等于不限   | 保持库中 quota=0、cap=0，旧引擎为两个新真实会话正常回复，捕获到 2 次 chat 请求，无转人工；旧预算 capMilli=null，正费用预占仍获准。                                                           |
| 原因展示与通知 | 旧版已登录后台的会话列表及详情均显示「本月 AI 额度已用完」「今日 AI 用量已到上限」，kind 均为 failure；真实通知任务执行后被合成 webhook 接收，通知路径正常。                                 |
| 停用标记保存   | 旧版预载 suspendedReplyAt 后保存同一会话；除正常变化的 updatedAt 外，完整 state 及全部消息与保存前一致，标记及合成画像字段保留。                                                             |
| 费用与计数行   | 新、旧及再前滚的 metrics 均为 123 厘；旧 usage.json 的费用为 0，没有把 reply 当成模型费用。旧版运行前后 purpose=reply 的 calls=1、费用=0 均未变。                                            |
| 旧版停用限制   | 将租户改为 suspended，旧版真实启动失败，错误码 tenant_suspended，进程退出 1；相同库由新版启动，/healthz 为 200。再改 active 后，旧版重新启动 /healthz 为 200，费用仍 123 厘。                |

完整演练输出 `DRILL ALL PASS`，各成功探针断言通过；成功服务由 docker stop 正常 SIGTERM 收尾（容器退出 143），不计为启动失败。回退前必须选择支持 R6 的镜像，或先把 suspended 租户改为 active。

开发探针曾因缺少部署初始化文件、嵌入地址不满足启动校验、错误使用短码调用详情路由，以及对复验模式套用新版断言而失败；均修正隔离夹具后从空库重跑，未修改产品实现。最终演练通过。演练结束时只读评审待协调者另派；后续评审修复及第 8 步完成结果见本轮记录。

### 本轮门禁与清理（2026-10-31）

第 7 步命令：`PG_TEST_URL=<一次性测试库> pnpm exec tsx src/tenancy/limits-e2e.selftest.ts`，输出 `LIMITS E2E SELFTEST PASS`。补跑 CLI 子进程套件，生产 30 秒定时器在无需重启时使新额度生效，输出「14 验收 9 本机 PASS」。

按改动路径检索的受影响套件为 `scripts/ci-shard.selftest.ts`、`src/payment/legacy-bytes.selftest.ts`、`src/core/link-bytes.selftest.ts`、`src/console-api/console.selftest.ts`、`src/ops/ops.selftest.ts`、`src/db/db.selftest.ts`、`src/db/rollback-guard.selftest.ts`，均单独执行；另补跑 `src/db/brand.selftest.ts`、`src/console-api/usage.selftest.ts`、`src/cli/tenant-budget.selftest.ts` 及新增贯穿套件。回滚脚本自测首次受并行负载影响触发 3 秒时限断言，未改阈值；独立在当次真实 PG 上复跑后 702 项通过，其余套件通过。

format、lint、typecheck、修改前后 test:locked、check-fonts、ci-shard --check 4 均通过；分片为 232 units、27 strict suites。文件和 PGlite 两条 mock v2 均 923/923、9015 项断言、快照 0 差异；PGlite 另核对 22 个请求前缀与 healthz 一致。八个锁定文件未改，四个哈希与原基线一致：

```text
promptHash cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900
toolsHash 59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
prefixHash 6630127f79d7854ec7d3abe96f1eae65e7acbed09f12a5b1bc22b539fd17e19e
sopHash 1f850038290b202f66573695faee972bd0b03a3da9ec3e62e665ff5fa6b81ba3
```

gitleaks 差异扫描、本机绝对路径及合成企微 ID 检查通过。按任务约定未跑完整 pnpm test，未提交、推送或开 PR。lint 的本机内容黑名单未配置，脚本按原规则跳过该项。

本次真镜像演练和贯穿测试的容器、匿名及命名卷、专用网络、两个镜像标签、Buildx 临时目录、归档副本和探针均已清理。docker ps -a、volume ls、network ls、images 的任务命名核对结果为空；构建、测试及演练执行会话均已结束。ps 被沙箱以 Operation not permitted 拒绝，无法独立补做系统进程表核对。当时第 8 步只读评审待协调者进行，后续结果见本轮记录。

### 后续事项

- 第 8 步只读评审及按裁定修复已完成；真镜像演练结果见上节，最新验证见下节。
- 停用租户启动索引及失败重试仍可能调用 embedding，保留现有缓存、增量嵌入和配置的日费用上限，本轮不改。
- 上线、全部验收复核、owner 确认及 Status 晋升仍由后续步骤处理。

### 第 8 步 · 独立评审修复（2026-10-31，完成）

来源：`14-review.result.md` 及协调者裁定。五项需修复；跨会话并发超额不增加回复名额预占，按在途轮数上界及 R5 同步费用预占的取舍写入 spec，新增同日 Revisions，Status 保持 ready。

- 非文本与附件失败：客户消息先记录，停用静默且不消耗停用固定句；额度耗尽复用新抽出的 `limitHandoffReply`，沿用 failure、quota 原因、通知及固定句。两类入站共用 customerRate，超限直接静默，不另发限速提示；已入库原回复的恢复交付例外保留。
- 首次快照：loadStandardTenants 清单只取 ID、slug、publicHost；逐租户配置装载的 findTenantBySlug 已读 status，新增 loaded.tenantStatus 保留它作为初值。状态/上限与月计数独立读取，某项失败仅保留该项旧值并打错误日志；计数失败仍安装已读的停用及上限，恢复和其他租户服务不受阻。
- 异步跟进：stillCurrent 在实际请求、退避重试、token 刷新之后均核对 limitVerdict；非 ok 停止外发，任务 abandoned/tenant_limit，不退回 pending 或重排。
- 同意菜单：标记只属于当前回合，停用、额度、限速和日费用熔断回合跳过 maybeAskConsent，不改询问状态；紧急与撤回同意仍保留原优先顺序。
- poisoned：核对 schedule 在 strict/lenient 两路均为新消息同步分配一次 seq，saveSession 只对新分配的 AI/followup 计数，去掉 isPoisoned 排除。spill 回放直接插入原消息，不再次经过回复计数。

新增及扩展用例均带「14 验收」：真实适配器 + limits 在 PGlite、真实 PG 覆盖非文本/附件失败的停用、额度、限速及通知；真实跟进任务在首次 token 和重试刷新 token 两个等待边界分别切换 suspended/quota，四个场景均无后续外发、无重排。真实引擎覆盖四种闸门均不发菜单、不写 consents/询问次数，未受限对照仍询问；原紧急/行权六场景通过。首次状态/月计数失败有错误日志，已读状态保留且恢复可用。新增 limits-store 自测接在 package.json test 行末尾，验证 poisoned 回复 +1、重复保存不加、真实 spill 回放及提交后崩溃再回放不加。

本轮验证均通过：

- PGlite 与本次一次性真实 PG：limits、limits-gates、limits-store、真实企微 limits 适配器。首次/刷新 token 等待的四个跟进场景、四种闸门的同意菜单抑制、首次快照失败及 poisoned 回放均通过；贯穿 CLI → 轮询 → 引擎 → 用量接口再次通过。
- 受影响套件：wecom-02（15 项）、wecom-03（262 项）、wecom-attachments、wecom-nontext、jobs（122 项）、store（452 项）、spill-channel（114 项）、recovery（483 项）、restore-cutoff（41 项）、outbound（246 项）、config（543 项）、privacy（42 项）全过，另补 followup-guards、industrial-followup、ci-shard 自测。支持真实 PG 的套件均使用本轮同一隔离容器并串行执行，未碰其他容器。
- format、lint、typecheck、修改前后 test:locked、check-fonts、ci-shard --check 4 全过；字体仍为 731 个汉字，未重建字体。分片 233 units、27 strict suites。文件与 PGlite 两条 v2 均为 923/923、9015 项断言、快照 0 差异；PGlite 的 22 个请求前缀核对一致。四个哈希与上节原基线一致，八个锁定文件逐字节未改。
- 差异秘密扫描、本机绝对路径、合成企微 ID 检查及 git diff --check 通过。lint 的本机内容黑名单未配置，按原规则跳过该项。

新增存储用例第一次清理误用 reset，因 poisoned 脏队列被正常保护而失败；已改为关闭并释放测试运行时，最终 PGlite、真实 PG 两路复跑通过。真实适配器也在最终代码上再次通过，未留下失败项。

第 8 步的独立评审和既有真镜像演练证据已齐，按协调者授权勾选完成。测试容器 wsa14-pg-review 及其匿名卷已删除，测试后台执行会话均结束，临时探针与本轮失败夹具残留已清理。分支为 fix/14-review，保留 15 个文件的未提交改动（生产修复、四组回归、package.json 与 spec/plan）；未提交、未推送，未动 #400，未跑完整 pnpm test、未连接生产。下一步是第 9 步，仅在 owner 当次授权后执行。

## Open

（无。）

## 已定

- 2026-10-31 owner 定开放问题 1–5，全部照推荐（spec 第二条 `Revisions:`）。演示租户日费用上限的数值上线时由 owner 给。

## 交接记录

### 交接（2026-10-31，起草）

- spec 与本 plan 起草为 `draft`，依据：对照代码的只读调研；13 初稿里 owner 定的「按 AI 回复条数计」。
- 起草时发现一个现存缺陷并写进 R6：任何一个 standard 租户停用都会让整个进程拒绝启动。
- 2026-10-31 已向 owner 讲通俗版，开放问题 1–5 全部照推荐。

### 交接（2026-10-31，owner 定 ready）

- spec 翻 `ready`，01、05 的反向标记与主参考同一 PR 补上。
- 下一步：第 0、1 步由 Codex 实现。
