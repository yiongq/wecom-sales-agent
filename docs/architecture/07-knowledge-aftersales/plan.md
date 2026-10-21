# 07 · 政策单一来源 + 知识库 + 售后退改 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题编号都指本 spec。共 25 步（第 0–24 步），合计约 34–44 个 agent 人日；按 03–06 的实际速度折算，开发约 3–5 天，日历一周左右（主要等 owner 授权与真实模型评测）。出代码的步骤每步一个 PR 进 `dev`，CI 绿了再合；第 0、17、18、20–24 步不出代码 PR，记录由协调者随相邻 PR 或单独的 docs PR 提交。spec 于 2026-10-22 由 owner 定为 ready，开放问题 1–9、11–13、15 照推荐；10 的数等第 0.5 步实测后 owner 确认，14 等第 0.3 步之后协调者裁决（第 0.7 步）。

## 开工条件

缺一条就停下，告诉 owner：

1. 06 已 `implemented`，线上 `demo-v7`（已满足；第 0.1 步核对 `/healthz`）。
2. 本 spec `Status: ready`（2026-10-22，已满足）。翻 ready 的反向引用随 07 的 docs PR 合入：00、01、02、04、06 顶部 `Superseded in part by:`，01、02、04、05 顶部 `Amended by:`，master-reference 阶段 7 的 spec 链接（第 0.1 步核对）。
3. 本机能跑 format / lint / typecheck、`test:locked`、受影响自测与 v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器；完整 `pnpm test` 由 CI 跑。
4. 真实模型凭据由 owner 在仓库外提供；真实模型评测只由协调者出沙箱跑（第 0.5、17、19、20 步）。
5. 不挡开工、只挡线上：两次部署各要 owner 当次授权（第 18、20 步）；第一次部署前应用库要有 vector 扩展（R12、开放问题 14）；批 S 的合并要 owner 看过 k=5 前后对比后授权（第 19 步）。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」与「交接记录」，再看 `git log -5`。代码出处以第 0.2 步核对后的位置为准；spec 不够用就记「Open」停下，不另定架构。部署照 06 plan 第 15、19 步的做法。
- **分工**：owner 2026-10-22 续订了 Codex，实现由 Codex 与 Claude 子 agent（默认 Sonnet）并行，各在自己的 git worktree 里做；两条车道，一条一个实现者，换一个模型交叉评审对方的 PR。派 Codex 照 `codex-dispatch` skill（它在沙箱里提交不了，一律不提交）。每份任务说明都引用 `.claude/runs/07-step-common.md`（主仓库检出目录下的本机文件，不进仓库）。协调者写任务说明、审 diff、提交、开 PR，CI 绿了开自动合并（`gh pr merge --auto --merge`），开了之后不再追加提交。碰线上、花钱、要 owner 拍板的事由协调者做。
- **锁定的 8 个文件**：`src/engine.selftest.ts`、`src/dejargon.selftest.ts`、`src/engine-holiday.selftest.ts`、`src/price-guard.selftest.ts`、`src/llm.selftest.ts`、`src/server.selftest.ts`、`src/adapters/wecom.selftest.ts`、`eval/cases.json`，sha256 见「实施记录 · 第 0 步」。全程一字不动：本 spec 不授权改任何锁定断言，spec「锁定断言」一节点名的那些约束实现。测试红了先查本步改动；确认与 spec 冲突就记「Open」停下。`public/chat.html` 也不改（R20）。
- **前缀**：第 0–18 步的两个 `PREFIX sha256` 都等于第 0 步记的值（验收 1）。只有第 19 步（批 S）换前缀，新值记进实施记录。
- **共同门禁**：本机跑 `pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck`、`pnpm -s test:locked`；按改动文件 grep 出受影响的自测，逐个跑；v2 假模型回归跑文件与 PGlite 两条。完整 `pnpm test` 只在 CI 跑（required check 叫 `check`）。新自测串进 `test` 末尾；新的 v2 用例放本步自己的文件 `eval/cases-v2/q07-<主题>.json`。改了界面文案跑 `tsx scripts/check-fonts.ts`。
- **v2 快照**（06 R4）：有意改变行为的 PR 生成 `eval/baselines/v2-07-step<N>.json`（N 是本文件的步骤号），默认基线改指它，与上一份逐条 diff、逐条归因，`reply-verdicts.json` 同样说明。没改变行为的 PR 不生成快照。合并前协调者 rebase 到最新 `dev`，由该车道在新基础上重生成、重审。
- **迁移**：从 0014 起按合并顺序编号，只加不删，过 `scripts/check-migrations.ts`。两个 PR 同时带迁移时，后合的那个 rebase 后改号。`sandbox_tenant_purge` 被第 9、13 步各 `CREATE OR REPLACE` 一次：后合的那一步整段重写，包含先合那一步加的表。
- **真实模型评测**：只由协调者出沙箱跑，每次显式带 `--budget`，到了就停；跑的配置与线上开关一致。每次都记进「费用记录」，整份 ≤¥35（开放问题 11）。实现者只有在任务说明明确允许、并给了上限时才能发真实模型请求。
- **数据**：回归目标、v2 用例只用合成数据（不变量 21）。临时探针与脚本放在仓库外，不进提交。
- **线上**：每次部署都要 owner 在当次会话明确授权；部署前手动备份并复制到异地；先用 `dev` 上的本地 rc tag 上线（不推），第 23 步之后再发版到 `main`。别的线上读写照旧要当次授权；第 0.1 步只读公开地址的 `/healthz`。
- 可能挂住的命令加超时（`perl -e 'alarm N; exec @ARGV' …`），收尾查进程与容器。变异测试在隔离副本里跑。本机凌晨跑限额、按日累计相关的自测时加 `TZ=UTC`。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、企微标识与凭据、客户原文。只记不敏感的结果与聚合数。

## 步骤

### 开工（第 0 步）

- [ ] 0. 开工核对与实测（1 天，协调者 + 实现者；真实模型 ≤¥3）
  - 次序：0.1 最先；0.2–0.6 在 0.1 之后同时开，并与第 1、2 步并行。0.3 挡第 9 步合并，0.4 挡第 4 步合并，0.5 挡第 13 步合并，0.7 挡第 18 步。
  - [ ] 0.1 基准（协调者）
    - 做：记开工提交（07 docs PR 合并后的 `dev`）、8 个锁定文件 sha256、两个 `PREFIX sha256`、线上 `/healthz` 的 `revision` 与四个哈希；核对「开工条件」第 2 条的反向引用；四个门禁在开工提交上全绿（CI `check`）。
    - 验：结果写进「实施记录 · 第 0 步」。
  - [ ] 0.2 行号与锁定断言再核（实现者，只读）
    - 做：spec「背景与问题」与各 R 引用的行号、函数名、步骤名在开工提交上逐条核，对不上的记新位置。「锁定断言」一节逐条核；按批列出每条 R 可能碰到的锁定断言（8 个锁定文件，含 `eval/cases.json` 的 v1 用例），每行写断言位置、要求什么、怎么避开。
    - 验：清单写进实施记录。会变红又避不开的记「Open」。
  - [ ] 0.3 pgvector 建扩展实测（协调者）
    - 做：起一次性 `pgvector/pgvector:pg17` 容器，跑 `deploy/db-init/roles.sql`，再以 `agent_owner` 连应用库执行 `CREATE EXTENSION vector WITH SCHEMA public`；记成功与否、报错原文、扩展版本（`halfvec` 要 ≥0.7）。用完删容器。
    - 验：结果写进实施记录，供 0.7 裁决开放问题 14。
  - [ ] 0.4 旧镜像读到新订单状态（实现者；不调模型）
    - 做：在开工提交（06 的代码）上起一次性库并迁移；建一个租户、一段会话和一张已付订单；以超级用户临时放宽 `orders_status_check`（模拟 07 的迁移），把订单改成 `refunded`，再各试一次 `refund_pending`；在 DB 模式下启动，记启动是否成功、会话是否被标 poisoned、预载与后台订单、会话、统计接口是否报错、网页聊天与支付页显示什么。脚本放仓库外。
    - 验：两种状态各一行结论写进实施记录，决定 R20 回滚检查只拦 `refund_pending` 还是两种都拦。
  - [ ] 0.5 闸两边实测（协调者，出沙箱；真实模型 ≤¥3）
    - 做：在开工提交上用 `eval/sim/run.ts` 跑 16 个 `safety` 目标（拟定回归集里已经存在的部分）两遍，代表草稿与线上两边，各 k=1，失败的目标再重跑至多 2 次；`--budget 3` 分两次用。配置与线上一致（销售与客户模型照 06 第 18 步）。
    - 验：每边耗时、费用、需要重跑的目标数，外推 20 个目标时的单次费用与耗时，给出 `SOP_GATE_BUDGET_CNY` 与 `SOP_GATE_TIMEOUT_MS` 的建议值。记进实施记录与「费用记录」。
  - [ ] 0.6 Codex 冒烟与通用约定（协调者）
    - 做：`codex exec` 跑一个只读小任务，确认登录态、模型名与 `service_tier`；照 06 的写法写 `.claude/runs/07-step-common.md`（先读、文件边界、门禁、快照、迁移改号、数据、进程、回复格式）。
    - 验：冒烟结果一句话记进交接记录。
  - [ ] 0.7 owner 确认与协调者裁决
    - 做：把 0.5 的建议值（单次预算、每天次数、超时）交 owner 确认（开放问题 10）；按 0.3 裁决开放问题 14：`agent_owner` 能建就由迁移建，不能就加 `deploy/db-init/extensions.sql`，现有线上库由 owner 用超级用户执行一次。
    - 验：两项写进 spec 顶部下一条 `Revisions:`。

### 批 P：政策单一来源（第 1–3 步）

- [ ] 1. policy 骨架与生成段（R2；2 天）
  - 做：
    - `src/core/pack-api.ts` 加 spec「接口与数据流」的 `PolicyTopic`、`PolicyClause`、`RefundTier`、`RefundTerms`、`PackPolicy`，`PackRuntime` 加可选 `policy`（不含 `afterSales`，那是第 6 步）。
    - `P/policy.ts`：`TravelPolicy` 严格 schema、`defaultTravelPolicy`（退改按 R16 的表、阈值 30,000、`selfService: true`、改期句）、`canonical`、`upgrade`、`clauses`、`refund`、`segments`。`P/thresholds.ts` 的四个值改为引用默认 policy，值不变。
    - 六个生成段（`sop:price-rules`、`sop:far-future`、`note:peak`、`note:group`、`help:price`、`help:season`）由默认值渲染；`catalog.ts`、`console-pack.ts` 改为引用生成段。`data/sop.md` 字节不动，加 `scripts/gen-sop-policy.ts --write`。
    - `public/admin.html:608` 的比对自测。
    - `eval/sim/goals.ts` 的 `goalSchema` 加 `tags`。
  - 验：每段一条逐字节自测；夹具把 `peakMultiplier` 改成 1.15，带上浮的四段同时出现「15%」、admin.html 比对自测变红（验收 2 前半）；`PREFIX` 不变，默认基线不重生成照样全绿。
  - 依赖：0.1。
- [ ] 2. 锁定节模板、硬性要求、欢迎语去重（R3；1 天）
  - 做：`lockedSectionTemplates` 由镜像 7 节按声明的替换表生成（每条恰好命中一次，否则启动失败）；旧版硬性要求由模板模式渲染再过替换表；`src/adapters/wecom.ts` 的两段欢迎语改引用包的旧版文字，`LEGACY_WELCOME_TEXTS` 原样。先写断言新旧逐字节相同的自测，再删手抄那份。
  - 验：验收 2 后半；替换表一条不命中时启动失败的反例；`wecom.selftest.ts` 照绿，`PREFIX` 不变。
  - 依赖：0.1。和第 1 步同时开、不碰同一文件。
- [ ] 3. policy 入库与发布路径（R1、R4、R5；2 天）
  - 做：
    - 迁移 0014 `sop_versions.policy json`；`render_inputs.policyHash`；`SopVersion.policyHash`；运行时只读本轮捕获的已发布快照。
    - 启动重渲染：「直接用存下的行」加 `policyHash` 条件，原因与 `causes` 枚举加 `policy`；07 之前的已发布行首次启动物化默认 policy、写 `sop.rerender`（前后 `promptHash` 相同）；`upgrade` 补出差异才重渲染。
    - 文件模式与导出导入：`policy.json`；`import-config --dry-run` 打印 `promptHash`、`policyHash`；沙箱开通复制 `policy`。
    - 写入：`saveSopDraft` 收 `policy`，`PUT /sop/draft` 的 body 加 `policy`；CLI `src/cli/sop-policy.ts set`，审计 `sop.policy_draft`；`editable` 之外的字段改了报 `policy_invalid`。
    - lint：`policy_invalid`、`policy_mismatch`（三条），发布、回滚、启动重渲染都查。
    - 后台 SOP 页「退改条款」只读卡片（档位、阈值、自助退款开关、草稿差异）。
  - 验：验收 3（旧版与模板模式各一遍）、验收 4；PGlite 与真实 PG 各跑 config 自测；`check-fonts` 过；`PREFIX` 不变。
  - 依赖：1。

### 车道 1：售后（第 4–7 步）

- [ ] 4. 订单状态与消费方（R20；1.5 天）
  - 做：迁移（`orders_status_check` 六个值、`orders_refund_paid_check`、`orders_guard` 加「`refunded` 之后不变」）；`OrderStatus` 与 `RefundRecord` 类型、`Order.refund`；spec R20「要跟着改的地方」逐处改（类型、`hasPaidOrder`、对客订单行与已付判断、支付拒付与支付页、公开投影加 `refund`、后台与统计、评测枚举）；`public/pay.html`、`public/admin.html` 只加分支；demo 重置作废两种新状态；`deploy/rollback-guard.sh` 退出码 8（按 0.4 的结论定拦哪几种状态）。
  - 验：验收 9；`server.selftest.ts:514、516` 照绿；`handoff.selftest.ts` 的 `WHITELIST` 加 `refund`；真实 PG 上约束与触发器的正反例。
  - 依赖：P 合并；合并等 0.4。
- [ ] 5. 退款申请、审批与结算（R19；2 天）
  - 做：`src/core/refund.ts` 的 `quoteRefund`（经 `pack-api` 导出）；`src/payment/refunds.ts` 四个函数；后台三个路由与权限；四个审计动作进 `AUDIT_ACTIONS` 与审计句子；通知失败留系统备注；工作台订单卡两种新状态。
  - 验：验收 8 第三条（批准、驳回、结算、403、409、幂等不重复通知与审计）；`quoteRefund` 的档位边界（30、29、15、14、7、6、0 天、已出发）与取整；`check-fonts` 过。
  - 依赖：4。
- [ ] 6. 售后钩子与核心提交（R17、R18；2.5 天）
  - 做：`EnginePackHooks.afterSales`；`preflight` 里的位置与核心先判投诉、负面情绪；旅游包的选单、报价、确认与固定文字（登记进 `fixedReplies`，过 06 R21 一致性检查）；`Session.afterSale` 进 `resetSession`；核心 `submit`：调 `requestRefund`、等提交 ≤5 秒、选文字、要人时 `enterHandoff(kind='refund')`。`handoff.selftest.ts:547-590` 改为在 `selfService=false` 下跑原链、另加自助链；`27-paid-refund.json` 改写；新增两个 `regression` 目标（低于、高于阈值）。
  - 验：验收 8 第一、二、四、五条；锁定 :1935、:1940、:2141–2170 与 `dejargon.selftest.ts:394` 照绿；退款那几轮不发模型请求（计数断言）；新快照逐条归因。两个新目标用 sim 假模型冒烟，协调者另跑一次真实模型 k=1（≤¥1）。
  - 依赖：5。
- [ ] 7. 沙箱种子（R21；1 天）
  - 做：`departOffsetDays`、开通时打 `seed: true`；新增 G01（已付、开通后 40 天、`refund_pending`、超过阈值、在「已成交客户要人工」里）；A01 不动。
  - 验：`seed-fixture.selftest.ts`；新开沙箱 G01 出发日正确、点批准后变已退款（验收 10 前半，自测加第 21 步手动）。
  - 依赖：6。

### 车道 2：知识库与政策护栏（第 8–11 步）

- [ ] 8. 嵌入端点白名单（R15；0.5 天）
  - 做：`src/core/llm/endpoints.ts`；DB 模式启动校验；`readEmbedding` 发请求前校验；非 prod 放行本机回环。
  - 验：白名单外主机 DB 模式拒绝启动、文件模式不发请求并退回关键词；`LLM_MOCK=1` 行为不变。
  - 依赖：0.1（不依赖 P，可以最先开）。
- [ ] 9. 线路向量入库、装载、增量嵌入、沙箱复制与删除（R11–R13；3.5 天）
  - 做：迁移（`kb_chunks`、按扩展判断的 `kb_vectors` DO 块，按 0.7 裁决的建法）；装载进内存索引；`onCatalogChanged` 后台增量；DB 模式不再读写 `var/route-vectors.json`；沙箱开通复制块与向量；`sandbox_tenant_purge` 加两张表（`to_regclass` 判断）。
  - 验：验收 6 全部（计数假嵌入服务；`queryCount()` 不增；重启不重嵌；改一条只嵌一块；沙箱开通无嵌入请求、删除后无行；真实 PG 跨租户读不到；PGlite 全绿；没扩展又建不了时 migrate 失败并写明原因）。`db.selftest.ts` 的表清单两边分开写。
  - 依赖：P 合并、8；合并等 0.7。
- [ ] 10. 政策问法进上下文（R14；1.5 天）
  - 做：旅游包认问法（退款、退订、改期、保险、费用含不含，只认问法）；按主题确定性取条款，有订单时标出适用的一条；并进 contextNote；签证、保险、费用口径句在 `P/claim-words.ts` 补齐；新增一个 `regression` 目标（问退改规则带出处）。
  - 验：验收 7 第一条与最后一条；没有订单、不是政策问法的轮 contextNote 哈希不变（用 06 第 0.3 步那种探针）；没有嵌入请求。
  - 依赖：P 合并（不依赖第 9 步，可与之同时开发，按序合并）。
- [ ] 11. 政策陈述护栏（R22；2.5 天）
  - 做：旅游包步骤 `policy_claims`（`claim_words` 之后、`price` 之前），三条规则；跟随改步骤表（`validate.selftest.ts`、`trace.selftest.ts`、`reply-verdicts.json`）；待顾问确认备注；新增一个 `regression` 目标（无出处的保险问法）。
  - 验：验收 7 其余各条；每条规则一正一反（含否定句）；带支付链接的句子不动；V8 r8d、`price-guard.selftest.ts` 照绿；不变量 19 的装载校验。
  - 依赖：10。

### 车道 1：发布闸（第 12–14 步）

- [ ] 12. 评测侧（R8、R9 的评测部分；2 天）
  - 做：`eval/sim/runtime.ts` 的 `--config-dir`，`runner.ts:194` 的拒绝只在没给时生效；`run.ts` 加 `--tag`、`--rerun`；新入口 `eval/sim/gate.ts`（只输出机器读的报告，逐目标追加）；06 的 16 个 `safety` 目标打 `regression` 标；`Dockerfile` 带 `eval/sim/`（`initial.orders.status` 的两个新值由第 4 步加）。
  - 验：sim 自测覆盖 `--config-dir`（含品牌目标）、`--tag` 过滤、重跑判定 `pass` / `flaky` / `fail` / `skipped_budget`；镜像构建后 `eval/sim/gate.ts` 能用假模型跑通。
  - 依赖：P 合并；第 6 步之后合并（状态枚举）。
- [ ] 13. 闸服务端（R7、R9、R10；3.5 天）
  - 做：迁移（`sop_gate_runs`、部分唯一索引、RLS 与授权、`usage_daily.purpose` 加 `gate`、`sandbox_tenant_purge` 加 `sop_gate_runs`，见「开工须知 · 迁移」）；`src/config/gate.ts`（静态检查、建行、单槽、子进程与环境白名单、超时、报告解析、基线复用与同次跑线上版、判定、用量入账、每天次数）；装载租户时把 `queued` / `running` 改 `abandoned`；`publishSopDraft` 的发布条件、`override`（只有所有者）、四个新错误；回滚、重渲染、导入、沙箱不经闸；四个环境变量、`gate_unavailable`；05 R5 清单登记。
  - 验：验收 5 中不花钱的部分全用假模型（静态拦截照旧、语义拦截的假模型版、不稳与已知失败不拦、强发与 403、回滚不跑闸、沙箱不跑闸、重启变 `abandoned`、超预算与超时记 `error`、429）；不变量 9–13；子进程环境里没有数据库凭据的断言。
  - 依赖：12；合并等 0.5、0.7（预算与超时的默认值）。
- [ ] 14. 闸面板（R7 界面；1.5 天）
  - 做：后台 SOP 页「跑回归」与七种状态，3 秒轮询，强发对话框只对所有者出现。
  - 验：七种状态各一条自测；`check-fonts` 过；console 构建与 `check-console-dist`。
  - 依赖：13。

### 车道 2：看板与 trace（第 15–16 步）

- [ ] 15. 看板拆分与来源（R23；2.5 天）
  - 做：`Session.handoffLog`（`enterHandoff` 追加，最多 50 条，重置不清）；`src/shared/origin.ts`；`/orders/summary` 与成交数按来源分；`MetricsView` 加 `deals`、`handoffByKind`、`takeovers`；`admin.html` 去掉「1 − 接管率」；`insight.ts` 改用 `handoffBeforePaid`；console 总览两格与四个视图。
  - 验：验收 11；加载、空、503 三种状态；`check-fonts` 过。
  - 依赖：第 4 步合并（`refunded` 单列）。
- [ ] 16. trace 列表、详情与「存为回归用例」（R24；2.5 天）
  - 做：`GET /traces`（筛选、游标）；后台「AI 记录」页；详情补 `guardVerdicts`、`replyShape`、转人工原因、客户原话；`goal-draft` 下载（打码、`_draft`、审计 `trace.export`）。
  - 验：验收 12；草稿原样放进 `eval/sim/goals/` 时 schema 拒收的自测；坐席与只读成员 403。
  - 依赖：15。

### 第一次验收与上线（第 17–18 步）

- [ ] 17. 中期验收（协调者；真实模型 ≤¥5）
  - 做：第 1–16 步全部合入后的 `dev` 上，逐条核验收 1–12 中不依赖线上的部分；验收 5 的手动付费一次（tone 节加「一说目的地就直接下单」，闸拦下、点名目标）；回归集 20 个目标齐全（16 + 第 6 步 2 + 第 10、11 步各 1）。
  - 验：逐条结果写进「验收记录」，费用进「费用记录」。
  - 依赖：1–16。
- [ ] 18. 第一次上线（协调者，owner 当次授权）
  - 做：确认应用库有 vector 扩展（按 0.7 的裁决，必要时请 owner 执行）；备份并复制到异地；线上 env 写 `SOP_GATE=required` 与三个闸参数；rc tag 上线；核 `/healthz` 的 `promptHash` 不变、每个租户一条 `sop.rerender`（`causes` 含 `policy`）、企微与网页各一句一回、新开沙箱 G01 走一遍。
  - 验：记进「验收记录」。
  - 依赖：17、0.7。

### 批 S：SOP 改版（第 19–20 步）

- [ ] 19. 锁定节与工具描述改版（R25；1.5 天，实现者 + 协调者；真实模型 ≤¥10）
  - 做：照 R25 表的写法（开放问题 15 已照推荐）一个 PR 改 SOP handoff、capabilities 两个锁定节与 `handoff_to_human` 的描述（保留「坚持」）；`templates.ts` 随第 2 步自动生成；更新写死的哈希（`web.selftest.ts` 的 `SYSTEM_SHA`、`TOOLS_SHA`，`brand.selftest.ts`、`brand-publish.selftest.ts`、`tools.selftest.ts`）；新 `PREFIX sha256` 与具名快照。协调者在当前 `dev` 与这个 PR 上各跑一次 k=5（回归集 20 个加报价类 6 个，开放问题 11），逐目标记录。
  - 验：验收 13 的本机部分；`SOP_CONTRACT` 17 条一条不少、不新增；owner 看过对比后授权合并。
  - 依赖：18。
- [ ] 20. 第二次上线与经闸发布可编辑节（协调者，owner 当次授权；真实模型 ≤¥3）
  - 做：备份；rc tag 上线；核 `/healthz` 的 `promptHash` 变了、`sop.rerender` 的 `causes` 含 `locked_sections`、`tools`；owner 在后台改 objections 节（R25 表第 4 行），经闸发布，这是闸的第一次真实使用。
  - 验：验收 13 其余、14；闸的费用 ≤ 单次上限并记在 `gate` 下。
  - 依赖：19。

### 收尾（第 21–24 步）

- [ ] 21. 对照验收标准 1–15 逐条核（协调者；真实模型 ≤¥3）
  - 做：每条写通过、部分通过或未过与证据；验收 10 在线上新开一个沙箱完整走一遍。
  - 依赖：20。
- [ ] 22. 清理（协调者）
  - 做：本机残留的容器、worktree、分支、临时目录；`.env.example` 与部署说明核对四个闸变量。
  - 依赖：21。
- [ ] 23. 更新 Status（协调者，owner 确认）
  - 做：owner 确认后翻 `implemented`。
  - 依赖：22。
- [ ] 24. 发版到 `main`（协调者，owner 当次授权）
  - 做：照 06 发 `demo-v7` 的做法开 release PR 进 `main`、打 tag，记进实施记录。
  - 依赖：23。

## 验收映射

| 验收            | 主要在哪一步验                |
| --------------- | ----------------------------- |
| 1 前缀与锁定    | 每一步；17 汇总               |
| 2 单一来源      | 1、2                          |
| 3 导入哈希      | 3                             |
| 4 policy lint   | 3                             |
| 5 发布闸        | 12–14；17（手动付费一次）、20 |
| 6 知识库        | 8、9                          |
| 7 政策问答      | 10、11                        |
| 8 自助退款      | 5、6                          |
| 9 订单状态      | 4                             |
| 10 完整演示退改 | 7；18、21（线上沙箱）         |
| 11 看板         | 15                            |
| 12 trace        | 16                            |
| 13 SOP 改版     | 19、20                        |
| 14 demo 照常    | 18、20                        |
| 15 费用         | 「费用记录」，21 汇总         |

## 工作量、依赖与并行

两条车道（spec 开放问题 1：最多两条线并行），一条一个实现者；批 P 之前与之间可以按下表穿插。

| 步骤             |  天 | 依赖（合并后再开，另注明的除外） | 车道 | 执行者          | 真实模型 |
| ---------------- | --: | -------------------------------- | ---- | --------------- | -------- |
| 0 核对与实测     |   1 | 开工条件                         | —    | 协调者 + 实现者 | ≤¥3      |
| 1 policy 骨架    |   2 | 0.1                              | P    | Codex           | —        |
| 2 模板去重       |   1 | 0.1                              | P    | Claude          | —        |
| 3 policy 入库    |   2 | 1                                | P    | Codex           | —        |
| 4 订单状态       | 1.5 | P；合并等 0.4                    | 1    | Codex           | —        |
| 5 退款申请       |   2 | 4                                | 1    | Codex           | —        |
| 6 售后钩子       | 2.5 | 5                                | 1    | Codex           | ≤¥1      |
| 7 沙箱种子       |   1 | 6                                | 1    | Codex           | —        |
| 8 端点白名单     | 0.5 | 0.1                              | 2    | Claude          | —        |
| 9 知识库入库     | 3.5 | P、8；合并等 0.7                 | 2    | Claude          | —        |
| 10 政策问法      | 1.5 | P（合并排在 9 之后）             | 2    | Claude          | ≤¥0.5    |
| 11 政策护栏      | 2.5 | 10                               | 2    | Claude          | —        |
| 12 闸评测侧      |   2 | P；合并排在 6 之后               | 1    | Codex           | —        |
| 13 闸服务端      | 3.5 | 12；合并等 0.5、0.7              | 1    | Codex           | —        |
| 14 闸面板        | 1.5 | 13                               | 1    | Codex           | —        |
| 15 看板          | 2.5 | 4                                | 2    | Claude          | —        |
| 16 trace         | 2.5 | 15                               | 2    | Claude          | —        |
| 17 中期验收      |   1 | 1–16                             | —    | 协调者          | ≤¥5      |
| 18 第一次上线    | 0.5 | 17、owner 授权                   | —    | 协调者          | —        |
| 19 SOP 改版      | 1.5 | 18                               | S    | Claude + 协调者 | ≤¥10     |
| 20 第二次上线    | 0.5 | 19、owner 授权                   | —    | 协调者          | ≤¥3      |
| 21 逐条验收      |   1 | 20                               | —    | 协调者          | ≤¥3      |
| 22–24 收尾与发版 |   1 | 21、owner 确认                   | —    | 协调者          | —        |

执行者是默认分配，协调者可以按进度对调；评审由另一条车道的模型做。

**热点文件**：

| 文件                                                                                 | 改它的步骤                                              | 怎么避免冲突                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------ |
| `src/core/pack-api.ts`                                                               | 1（policy 类型）、6（`afterSales`、`quoteRefund` 导出） | 第 1 步只加 policy 相关，第 6 步追加                         |
| `src/packs/travel/turn.ts`                                                           | 4（订单行、已付判断、寒暄）、10（contextNote）          | 两步碰不同函数，按合并顺序 rebase                            |
| `src/packs/travel/reply-steps.ts`、`runtime.ts`                                      | 6（固定文字登记）、11（`policy_claims`）                | 各放新文件，只在登记处追加                                   |
| `src/packs/travel/claim-words.ts`                                                    | 10（补保险、费用两句）、11（引用）                      | 10 先合                                                      |
| `src/core/engine/index.ts`                                                           | 6（`preflight` 钩子与 `submit`）、15（`handoffLog`）    | 15 只碰 `enterHandoff` 一处                                  |
| `src/db/schema.ts`、`drizzle/`                                                       | 3、4、9、13                                             | 按合并顺序编号；`sandbox_tenant_purge` 见「开工须知 · 迁移」 |
| `src/shared/conversation-types.ts`、`console-api.ts`、`ui-labels.ts`                 | 3、4、5、13、15、16                                     | 只追加；`AUDIT_ACTIONS` rebase 时两边都留                    |
| console SOP 页                                                                       | 3（只读卡片）、14（闸面板）                             | 3 先合                                                       |
| `public/admin.html`                                                                  | 1（比对自测只读）、4、15                                | 只加分支；锁定断言 :516 的两处不动                           |
| `src/server.ts`                                                                      | 4                                                       | —                                                            |
| `eval/sim/goals.ts`、`runtime.ts`、`runner.ts`                                       | 1（`tags`）、4（状态枚举）、12                          | 1 先合；12 排在 6 之后                                       |
| `eval/sim/goals/quality/`                                                            | 6、10、11 各加目标，12 打标                             | 每步只碰自己的文件                                           |
| `eval/cases-v2/reply-verdicts.json`、`eval/baselines/`、`eval/v2/snapshot.ts` 默认名 | 改行为的 PR（6、10、11、19）                            | rebase 后重生成，不手工合                                    |
| `package.json` 的 `test`                                                             | 每个加自测的 PR                                         | 只在末尾追加，rebase 时两边都留，逐项核对不漏不重            |
| `data/sop.md`、`templates.ts`、`tool-defs.ts`、写死哈希的四个自测                    | 19                                                      | 第 19 步独占                                                 |

**合并顺序**：1、2（任意先后）→ 3 → 车道 1：4 → 5 → 6 → 7 → 12 → 13 → 14；车道 2：8 → 9 → 10 → 11 → 15 → 16。两条车道之间同一时间只合一个 PR，轮到的 PR 先 rebase 到最新 `dev`、重生成快照、CI 绿了再合。

## 上线清单

两次上线（第 18、20 步）各核一遍：

- owner 当次授权；部署前备份并复制到异地。
- 第一次：应用库有 vector 扩展；env 写 `SOP_GATE=required`、`SOP_GATE_BUDGET_CNY`、`SOP_GATE_DAILY_RUNS`、`SOP_GATE_TIMEOUT_MS`；回滚检查（退出码 8）在部署说明里。
- `/healthz` 的 `revision` 与四个哈希；第一次 `promptHash` 不变，第二次变。
- 审计 `sop.rerender` 的 `causes` 符合预期。
- 企微与网页各一句一回；新开沙箱走 G01。

## 实施记录

### 第 0 步 · 开工核对与实测

**预核**（2026-10-22 写本文件时在 `dev` d5e8b67 上看过，第 0.1 步复核）：`dev` 的产品代码与 spec 核行号时的 9d6b9b9 相同（之间只改了 `AGENTS.md`）；下一个迁移号是 0014；`eval/sim/goals/quality/` 46 个目标，其中 16 个 `safety`。

## 验收记录

## 费用记录

| 日期 | 步骤 | 内容 | 金额 |
| ---- | ---- | ---- | ---: |

合计 ¥0 / 上限 ¥35。

## Open

## 交接记录

### 交接（2026-10-22，plan 起草）

- spec 翻 ready、反向引用与本文件随 docs PR `docs/07-ready` 进 `dev`。旧的本地草稿分支 `docs/07-spec`（及其 worktree）内容已全部包含在内，没推过，可以删。
- 下一步：第 0 步。0.1 等 docs PR 合并后的 `dev`；0.3、0.5、0.6 由协调者做，0.2、0.4 派实现者。
