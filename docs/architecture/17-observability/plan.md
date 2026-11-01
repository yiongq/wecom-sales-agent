# 17 · 可观测性增强 — 执行计划

Status: ready
Revisions: 2026-10-31 owner 明确批准，原话「17 改 ready」，并按「点这个就同时确认 heavy 档」确认档位；Status 改为 ready，Tier 定为 heavy。实现排在 15 第 1 批之后，依赖其设置导航、试用公司和概览页改动；同次补 02、07、后台 UX 反向标记及主参考登记。
Tier: heavy
Revisions: 2026-10-31 owner 对「7 个决策卡都按推荐吗」答「都按推荐」，D1–D7 全部照 ★ 推荐定案；Status 保持 draft，ready 须 owner 另外点名，Tier proposal 仍待 owner 确认，不属于本次决策卡定案。

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、D 决策卡均指本 spec。本轮只登记 ready 与 heavy 批准、同步依赖和关联标记，不实施、不提交。

## 开工条件

1. 已满足：D1–D7 全部照推荐定案；owner 于 2026-10-31 明确说「17 改 ready」，并按「点这个就同时确认 heavy 档」确认档位，当前 Status: ready、Tier: heavy。
2. 已满足（2026-11-01 第 0 步核对）：15、14 已 `implemented`（#416，`origin/dev` `89807cf8`），设置导航、试用公司及其种子/7 天留存/手动重置、概览页与引导布局均已合入，14 R6/R9 在代码里。
3. 已满足：本次 ready 文档变更已给 02、07、后台 UX 顶部各加一行 `Amended by:`，原正文不动；主参考阶段 8 已登记日期与批准原话。
4. 本机可跑四门禁、一次性真实 PG、浏览器及固定版本 Langfuse；生产、真实数据与真实模型不在本期本机验收范围。

## 开工须知

- 先读 AGENTS.md、本 spec、14/15 plan 和 git log；不得把本轮静态核对当已经实施。
- 锁定 8 个文件、四个哈希、demo 行为全程不动；新增测试为 plain tsx durable 自测。
- 实施期间每个批次跑适当自测，交付前完整四门禁；真实 PG 只用本次一次性容器。所有可能挂住的命令加 timeout，所有进程/容器清理。
- 任何并行工作使用独立 worktree，最多三路，整合者占其中一路；公共文件串行合入，不在本 checkout 派多个写入者。

## 步骤

- [x] 0. 开工核对与契约冻结。核对 14 R6/R9、15 的 seed/reset/7 天留存和原 metrics、旧 exporter；确认 origin 分类、消息与 trace 对应、runbook 路径与现有后台路由。冻结 R5/R10 DTO、错误码、日期/金额单位、coverage、评分 revision、job 与账本状态、脱敏白名单。核实日采集检查点及删除失效如何复用生命周期钩子。依赖：15 第 1 批完成并合入及其余开工条件；不可并行。
- [x] 1. Langfuse 版本预检。按 R11 核实固定 tag 的 web/worker 与所有依赖镜像 digest、本机架构及资源，登记到本 plan；验证配置只指向本机、不设置内容捕获。只读核对导出器与接收字段；版本不可用或要求改 SDK 时停止记录并修订 spec，不静默换版本。依赖：0；与 2、3 可并行。
- [x] 2. 数据与清理。新增四表、FORCE RLS、复合键、索引、最小权限、jobs kind，以及清理/回滚增补；不改旧迁移。跑验收 3 的真实 PG 边界与 7 天删除，验证旧函数仍级联评分；日账本跨终态去重与数据字段到期清理。依赖：0；与 1、3 可并行，迁移编号集中分配。
- [x] 3. 日指标与趋势后端。实现 R5/R10 的共用日 SQL、coverage、60 秒租户缓存、采集/删除失效及新趋势接口，保持旧 metrics/UsageView。用固定时钟、真实 PG 对照验收 6、11 的接口部分。依赖：0；纯读聚合先行，ops_metric_coverage 采集检查点持久化接入等 2 合入后完成。
- [x] 4. 抽检与安全草稿后端。实现评分 revision、审计事务、角色检查、过滤/详情/安全深链接及无源内容的 v2 骨架；保留 travel 旧导出。验收 1–5 的 API/外部文件链路，特别证明工业草稿不得调用旧 goal-draft 获取正文。依赖：2；可接替已完成的 2 路，与 1、3 并行。
- [x] 5. 每日摘要与延迟任务。实现 R6–R8 的 ops lane、日账本、跨重启恢复、显式重发命令、固定窗口告警及租户配置；注册运行时状态；接现有告警传输而不以 void 返回值当成功。执行验收 7–9，带进程中止/重启与本机 webhook，不只测纯函数。依赖：2、3；按下节三路安排启动。
- [x] 6. 分级与运维手册。穷尽映射现有 AlertKey、safeText 外的类型化链接、watch/backup 前缀、固定 runbook 路由；新增公共 docs/ops/observability.md，同批更新部署说明和 .env.example 的新配置名，真实值另记。按验收 10 验证恶意 URL、鉴权链接、阈值不变及无 trace 降级；与 5 对 alert.ts 的修改串行合入。依赖：4、5。
- [x] 7. 抽检与趋势前端。消费已冻结真 API，做评分原因、冲突提示、差评草稿说明、7/30 天趋势与可读表格；不改 15 设置导航与用量页。覆盖所有页面状态、键盘/窄屏/深浅主题与字体；浏览器按验收 1、2、4、11 走查，写 BEFORE/AFTER，截图只用合成数据。依赖：3、4 及 15 前端公共布局合入；可与 5、8 并行。
- [x] 8. 本机真实 Langfuse 验证。真实引擎/recorder/exporter → 本机指定版本 → UI/API 字段核对，完成验收 12；失败/断网/关闭出口均测试，无原文无真实 key。把版本、映射、命令与结果写本 plan，不复制第三方截图入仓库；清理当次资源。依赖：1；与 5、7 并行。
- [x] 9. 真实链路贯穿与回滚演练。按验收 13 走真实认证、API、SQL、队列、外部 v2 回归及安全定位；再用新旧镜像和同一测试库验证验收 14。核对 14 用量、15 宿主停用/工业继续服务/重置；开启新功能前后四哈希及锁定文件一致。依赖：5–8；整合串行。
- [ ] 10. 对照当前全部验收逐条验证并记录。跑四门禁、锁定套件、受影响真实 PG、v2 回归、字体检查和 PR 范围公开边界/密钥扫描；每条记录命令、结果、证据和限制，未执行不得标通过。核对删除、导出和发送未知窗口，不以局部测试代替贯穿。依赖：9。
- [ ] 11. 清理临时探针和测试。保留 durable 自测，清除本次临时案例、证据原件、浏览器、后台服务、容器及卷；复核无客户内容、地址、凭据、本机路径，最终 diff 范围明确。依赖：10。
- [ ] 12. owner 确认后更新 spec 与 plan 的 Status 为 implemented。前置为验收全部有证据，未完成不得推进；本期没有默认生产操作，不自行开启线上开关。依赖：11。

## 共享契约与最多三路

| 两端            | 先冻结的契约                                                                                    | 合入后共同证明                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2 ↔ 4 ↔ 7       | turn_id 归属、revision、角色、原因枚举、错误码、删除级联、无正文草稿 DTO                        | 两租户真实登录评分/冲突/删除；外部 v2 用例可运行                               |
| 3 ↔ 5 ↔ 7       | R5 日窗口、单位、分母、coverage、来源分类、60 秒缓存                                            | 同日摘要与趋势 SQL 值一致，14 reply 行不重复计费                               |
| 5 ↔ 6           | accepted/rejected/unknown、限流优先级、severity/runbook/traceId 与安全 host                     | 不重复自动发送，正文不漏敏感数据，链接仍需登录                                 |
| 1 ↔ 8           | 版本/digest、端点、属性映射、无正文、失败与停机行为                                             | 实际接收树及 UI 识别，不以配置截图当验收                                       |
| 14/15 ↔ 2/3/7/9 | UsageView 不变；settings 导航、OverviewPage 布局；seed/reset、7 天、旅游 suspended/工业 serving | 不抢写设置页、不把种子计入接待、不用旅游 host 链接工业 trace；重置清评分和缓存 |

15 第 1 批完成并合入后，第一波 `0 → {1,2,3}`，完成 2 的路可继续 4，3 的采集检查点接入等 2 合入。第二波等相关契约合入：A `5 → 6`，B `7`，C `8`；不得在第一波三路都忙时额外开 4。第二波全合入后 `9 → 10 → 11 → 12` 串行。公共 `src/shared/console-api.ts`、`src/console-api/app.ts`、schema/journal、alert.ts、package.json 由对应阶段的一路集中合并，另一侧只消费签名。

本期整体实现排在 15 第 1 批之后，不只让第 7 步等前端布局：设置导航、试用公司和概览/引导改动均须先完成并合入，不与 15 抢写公共文件，也不复制设置导航；15 用量页只消费 14 R9，本期趋势是独立接口。14 的 `purpose='reply'` 只用于原用量，接待数不能用其 calls 替代。开发可在未部署时完成，本期本机通过也不能宣称 14/15 已上线。

共 **13 步（0–12）**，最多三路；1 与 8 为第三方预检和实测，2–7 为六个实现步骤，9 是必须的贯穿与回滚，最后三步遵循仓库固定收尾顺序。

## 第 0 步冻结契约

2026-11-01 第 0 步对照 `origin/dev`（`89807cf8`，含 #416）核对。DTO 代码在 `src/shared/console-api.ts` 末段，这里写代码表达不了的规则。各路只消费，要改先写进 Open。

### 核对结论

| 项            | 结论                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14 R6/R9      | `GET /usage`、`UsageView`、`canSeeUsage` 在 `src/console-api/app.ts`；suspended 租户照常装载，判定在 `src/tenancy/limits.ts`，所以摘要要在事务里重读 `tenants.status`，不能只看 `rt.state`。14 与 15 已 `implemented` |
| 15 种子与留存 | 种子会话 `state.seed=true`、带 `seedBaselineSeq`，订单 `ord_seed_` 前缀，经 `originOf` 判 seed；`resetTrial` 要求三个保留期都是 7、逐会话 `eraseConversation`                                                         |
| 旧 metrics    | `src/ops/metrics.ts`、`src/db/repo/metrics.ts` 含种子与全部来源、成交取内存。新接口不复用也不改它们                                                                                                                   |
| AI 消息       | AI 回复 `messages.author` 是 NULL，确定性提示同样如此，`linkTurn` 写 `turn_id`。判定：`role='agent' AND (author IS NULL OR author='ai')`。spec R2 已改                                                                |
| 删除路径      | `erase_conversation` 与试用重置要拿租户锁，应用必须停着；进程内缓存随重启清空。进程内只有 `purgeOnce` 要主动作废                                                                                                      |
| 时区          | 清除函数在库里跑，不知道部署 `TZ`，不能按本地日定位删除日期；用下面的区间法                                                                                                                                           |
| 手册内容      | 镜像不含 `docs/`，第 6 步给 Dockerfile 加 `COPY docs/ops ./docs/ops`，接口读这份公共手册                                                                                                                              |
| 登录          | 未登录时 Shell 在原地址渲染登录页，不跳转，深链接登录后留在原路径，无外部返回地址                                                                                                                                     |

### 数据（第 2 步，迁移 `0026`，第 5 步若要函数用 `0027`）

- `turn_reviews`：R2 的列；`reviewer_user_id` 不设外键，展示名按当前成员查，查不到写「已移除成员」；`CHECK ((rating='bad') = (reason IS NOT NULL))`。
- `ops_daily_reports`：PK `(tenant_id, day)`，`report_id uuid` 唯一；`status`、`attempts`、`resend_count`、`next_attempt_at`、`claim_token uuid`、`computed_at`、`sent_at`、`error_code`、`snapshot json`（`DailyOpsPoint`，清业务值就置 NULL）。
- `ops_latency_state`：PK `tenant_id`；`last_window_end`、`bad_streak`、`good_streak`、`active`、`paused`、`last_sent_at`、`last_p90_ms`、`last_samples`。
- `ops_metric_coverage`：PK `(tenant_id, day)`；`first_seen_at`、`last_seen_at`、`has_gap`、`has_deletion`。
- 四表 `agent_app` 只有 SELECT、INSERT、UPDATE，删除只走函数。`purge_ops_data(p_tenant, p_now)` 只 GRANT `agent_app`，随 `purgeOnce` 调：报告 35 天删行，`min(35, retention_trace_days)` 天清 `snapshot`，coverage 留 `min(30, retention_trace_days)` 个自然日。
- `jobs_kind_check` 加 `ops_daily_digest`，TS 的 `JobKind` 到第 5 步才加。`erase_conversation` 的返回值加 `reviews`。
- 删除标记：内部函数 `ops_coverage_mark_deleted(p_tenant, p_at timestamptz[])`，把 `p_at` 落在 `[first_seen_at-2分钟, last_seen_at+2分钟]` 内的 coverage 行置 `has_deletion`。`purge_conversation`、`erase_conversation` 在删除前传该会话的 `started_at` 和已付订单的 `paid_at`；`purge_expired_traces` 按 cutoff 批量标。不落在任何行区间的时刻必在采集缺口内，那天本来就不是 complete，不用标。

### 指标与 coverage（第 3 步）

- 日窗口由 JS 按本地零点算出后传 timestamptz，`todayIso` 同口径；`usage_daily.day` 直接比日期。
- 来源谓词：`src/shared/origin.ts` 导出前缀常量，`originOf` 与 SQL 共用。standard 的 customer 会话是 `state.seed` 不为真且 id 不带种子、访客前缀；订单再排除 `ord_seed_` 与关联种子会话。三种来源要有对照自测。
- `paidOrders`：`paid_at` 在窗口内、`status IN ('paid','refund_pending','refunded')`、`voided_at IS NULL`。
- 窗口：`请求天数 ∩ retention_trace_days ∩ tenants.created_at 本地日`。截到保留期报 `retention`，截到开通日报 `collection_start`。没有 coverage 行的历史日留在窗口内，报 `unknown_history`。
- complete 的条件：非今天，coverage 行 `first_seen_at` 不晚于零点后 2 分钟、`last_seen_at` 不早于次日零点前 2 分钟，无 `has_gap`、无 `has_deletion`。
- 非 complete 日逐字段取值：记录值大于 0 才给数，否则 null；比率的分母为零时 null。至少一项有值是 `partial`，全空是 `unavailable`。今天固定 `partial`，报 `today`。
- 检查点：每分钟一次（第 3 步接 `ops_metric_coverage`）。启动、与上次检查点间隔超过 2 分钟、`storeHealth()` 有 conflict、poisoned 或积压超 60 秒时置 `has_gap`；跨日间隔同时标两天。
- 缓存键：租户、请求天数、时区、起始日、今天、保留期；每次请求现读 `tenants`，保留期变更立即失效。`purgeOnce` 删过东西就作废。摘要与告警绕过缓存。

### 接口（第 4 步）

权限顺序：未登录 401 → 角色 403 `forbidden` → 沙箱 403 `observability_unavailable` → 文件存储 503 `store_file_mode` → 解析定位参数。

| 路由                                    | 说明                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metrics/trends?days=7\|30`        | `MetricsTrendsView`（第 3 步）                                                                                                     |
| `GET /traces/:turnId`                   | `TurnTraceView` 加 `conversationId`、`channel`、`reviewable`、`review`；只收 UUID                                                  |
| `GET /traces/:turnId/review`            | `{ review: TurnReviewView \| null }`                                                                                               |
| `PUT /traces/:turnId/review`            | `TurnReviewBody`，返回 `TurnReviewView`；请求体封顶 4 KiB                                                                          |
| `POST /traces/:turnId/regression-draft` | `RegressionDraft` 附件，固定文件名，`no-store`；未差评 422 `review_not_applicable`                                                 |
| `GET /traces`                           | 加 `review=none\|good\|bad`、`reason=<ReviewReason>`，`none` 只含可评未评；行加 `review: { rating, reason } \| null`、`reviewable` |

可评：trace 有非空 `final_text`，outcome 不是 silent、reset，且有上面定义的 AI 消息。错误码：不存在或跨租户 404 `not_found`，内容 400，不可评 422 `review_not_applicable`，竞争 409 `review_conflict`，审计或存储失败 503 `store_unavailable`。审计 `trace.review`、`trace.regression_draft` 不写 target，diff 只有评分、原因、修订号（草稿是原因、格式、包 id）。

### 摘要与告警（第 5、6 步）

- job：`ops_daily_digest`，`dedupeKey=ops_daily_digest:<day>`，payload `{ day }`，`maxAttempts=10`（发送次数在账本，不用 job 计数），独立 `ops` lane。排程到期检查放 runner 每拍。
- 账本：`pending → sending → sent | unknown`；`pending → failed | skipped`。`error_code` 取 `config_missing`、`rate_limited`、`sql_error`、`rejected`、`timeout`、`network`、`bad_response`、`server_error`、`redirect`、`restart_in_sending`、`commit_failed`、`deadline`、`suspended`、`disabled`。启动归位在 `recoverJobsAtStartup` 同一事务、认领之前。发送日是 `day` 的次日，到次日 24:00 截止。
- 传输：`alert.ts` 新增发送函数，单次发送，返回 `accepted`、`rejected`、`unknown` 或 `not_attempted`（`config_missing`、`rate_limited`）。200 且 `errcode=0` 算 accepted；200 且 errcode 非 0、4xx 算 rejected；5xx、3xx、超时、断连、解析失败、响应超 8 KiB 算 unknown。摘要要求一分钟内已发不超过 6 条，给故障告警留 4 条。
- 正文白名单：实例标签、`P3`、日期、`T-<租户 uuid 前 6 位>`（共享试用再加「共享试用」）、报告短号（`report_id` 前 8 位）、接待、轮次、转人工率、AI 错误率、回复 p90 与样本数、模型费用（标「租户全部模型费用（含测试）」）、已付订单数（含后续退款）、数据不足说明。不带 slug、租户名、成员、客户标识。
- CLI：`src/cli/ops-report.ts`，`retry --tenant <slug> --day <date> --ack-duplicate-risk` 把 unknown 改回 pending 并排 job，由应用发送；`prepare-rollback --tenant <slug>` 取消未完 job、sending 归 unknown。都以 platform 身份经 SECURITY DEFINER 函数。
- env：`OPS_DIGEST_TENANTS`、`OPS_LATENCY_TENANTS`，逗号分隔 slug，不存在或非 standard 的项报错跳过，不回显取值。
- 手册：`GET /ops/runbooks/:key`，owner、admin，key 是固定白名单，内容取 `docs/ops/observability.md` 的同名小节，自测逐 key 校验。

### 分路与文件归属

| 路     | 步骤    | 执行   | 独占                                                                                                     |
| ------ | ------- | ------ | -------------------------------------------------------------------------------------------------------- |
| A      | 2 → 4   | Codex  | `drizzle/`、`src/db/schema.ts`、`src/db/repo/retention.ts`、`src/jobs/purge.ts`、`src/db/repo/traces.ts` |
| B      | 3       | Codex  | `src/shared/origin.ts`、`src/ops/trends.ts`、`src/db/repo/ops-metrics.ts`                                |
| 协调者 | 1、7、8 | Claude | `docs/architecture/17-observability/`、`console/`                                                        |

`src/console-api/app.ts`、`src/shared/console-api.ts`、`package.json`、`src/tenancy/state-manifest.ts` 各路都要加行，协调者合并时手工对齐。Codex 不改 plan，也不提交。

## 验收记录模板

实施时逐行补命令、结果与证据；这里不预填“通过”。完整日志、外部用例和截图放仓库外受控位置，公开记录只有合成且不含标识的结果。

| 验收  | 执行步骤 | 必须保留的结果                                        |
| ----- | -------- | ----------------------------------------------------- |
| 1–2   | 4、7、9  | 逐角色 HTTP、跨租户 404、评分竞争与审计原子性         |
| 3     | 2、9     | 真实 PG 角色/RLS 与五条删除路径、7 天/种子边界        |
| 4–5   | 4、7、9  | 下载无源文本、schema 拒收、外部 v2 正反断言           |
| 6     | 3、5、9  | 固定时间 SQL 对照、来源/费用/订单/coverage            |
| 7–8   | 5、9     | 真实认领、接收器条数、进程中止后终态与重发审计        |
| 9–10  | 5、6、9  | 阈值边界/低样本/恢复、级别穷尽、安全链接及脚本兼容    |
| 11    | 3、7     | 7/30 截短、缓存与删除、浏览器状态/可访问性/字体       |
| 12    | 1、8     | tag 与全部 digest、span/UI 字段矩阵、无正文和故障隔离 |
| 13–14 | 9        | 浏览器至回归/摘要/告警定位的完整链，新旧镜像回退      |
| 15    | 10–11    | 四门禁、锁定/哈希、回归、公开边界及资源清理           |

## 实施与验证记录

### 第 9 步 贯穿与回滚（2026-11-01）

- 贯穿：`src/ops/observability-e2e.selftest.ts`，fork 完整 prod server、真实 PG、签名回调、本机 webhook。七步：登录与两轮真实引擎回复 → 列表、差评、筛选 → 无正文草稿与外部 v2 正反例 → 真实 runner 发昨日摘要，与趋势 SQL 一致 → 真实分钟入口触发延迟告警，从「定位」行取链接，匿名 401、登录后是这一轮 → 趋势读到同一批数据 → 跨租户 404、宿主停用后工业继续、旅游摘要 `skipped`。受控手段只有：用超级用户挪 trace 时间列、预置 coverage 与连续慢窗状态、预加载脚本缩短分钟定时器。本机连跑 3 次通过，约 9 秒；沙箱里跑会因写不了 `/tmp` 失败，这是环境限制。去种子谓词、定位改旅游宿主、日窗口错一天三种变异都被拦下。
- 回滚（验收 14）：用 `demo-v12` 与当前分支各构建镜像，同一个一次性 PG。新镜像发摘要 → 写入 sent、unknown、failed、sending 账本与评分 → `ops-report prepare-rollback` → 旧镜像启动，`/metrics`、`/usage` 字节不变，新路由 404，到点的 `ops_daily_digest` 12 秒内仍 pending、无发送 → 旧镜像 `erase-conversation` 后评分消失 → 宿主 suspended 下旧镜像启动，工业可登录 → 新镜像前滚，账本不变，摘要总数仍是 1，趋势可用。演练脚本是一次性的，不进仓库。
- 浏览器（真实镜像）：未登录打开深链接，原地址显示登录页，登录后留在该记录；AI 记录抽屉打好评后列表同步；手册页与未知手册 404；CSP 无报错，控制台只有预期的 401、404。

### 第 10 步 验收逐条（2026-11-01）

| 验收          | 结果  | 证据                                                                                                                              | 限制                                                                               |
| ------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 逐角色权限  | 通过  | `reviews`、`trends`、`console` 自测逐角色 HTTP，走完整 server；贯穿第 7 步跨租户 404                                              | 共享试用 agent 按 agent 角色覆盖                                                   |
| 2 评分与竞争  | 通过  | `reviews` 自测：并发相同 revision 一成一 409、临时触发器让审计失败时评分不提交、`updated_at` 不变；`traces.selftest.tsx` 覆盖界面 | —                                                                                  |
| 3 隔离与删除  | 通过  | `observability`、`trial-reset` 自测，真实角色；五条删除路径与 7 天边界                                                            | —                                                                                  |
| 4 安全导出    | 通过  | `reviews` 自测：唯一标记在文件与审计全表搜不到，`seed` 同样；草稿过不了 `validateCase`；`goal-draft` 既有测试不动                 | —                                                                                  |
| 5 回归落地    | 通过  | `reviews` 与贯穿第 3 步：仓库外合成 v2 用例正例退出 0，改坏后非 0                                                                 | 只用合成数据                                                                       |
| 6 SQL 口径    | 通过  | `trends` 自测三种来源对照、固定时钟；贯穿第 4、6 步摘要与趋势一致                                                                 | —                                                                                  |
| 7 摘要调度    | 通过  | `digest` 自测真实 runner 与本机接收器；回滚演练真实镜像发出                                                                       | —                                                                                  |
| 8 发送故障    | 通过  | `digest` 自测三处 SIGKILL、拒绝 3 次、unknown 不重试、显式重发保留报告 id                                                         | —                                                                                  |
| 9 延迟阈值    | 通过  | `latency` 自测 19/20、8000/8001、6000/6001、缺窗、重启                                                                            | —                                                                                  |
| 10 告警定位   | 通过  | `alert-policy`、`ops`、`app-probe` 自测；贯穿第 5 步                                                                              | 主机脚本用假命令，未碰生产                                                         |
| 11 趋势与后台 | 通过  | `trends`、`coverage`、`trends.selftest.tsx` 与浏览器走查                                                                          | 窄屏、深色在预览栈走查                                                             |
| 12 Langfuse   | 通过  | 第 8 步记录                                                                                                                       | 版本是 3.122.0；缓存 token 只作属性，无重试次数属性                                |
| 13 贯穿       | 通过  | 贯穿自测 + 真实镜像浏览器走查                                                                                                     | 分两段：API 段用真实引擎，浏览器段用合成写库的 trace，不是同一批数据；受控手段见上 |
| 14 迁移回滚   | 通过  | 第 9 步回滚演练                                                                                                                   | 演练用本机 PG，未碰线上                                                            |
| 15 交付边界   | 待 CI | 见下                                                                                                                              | 全量 `pnpm test` 只在 CI 跑                                                        |

- 本机核对：`format:check`、`lint`、`typecheck` 通过；`check-fonts` 通过（762 字）；`ci-shard --check 4` 通过；`test:locked` 通过；文件与 PGlite 两条 `eval/run.ts` 通过，DB 模式 22 个请求前缀与 `/healthz` 一致；旅游四哈希断言在 `product-surface`、`brand`、`policy` 自测里通过。
- 与基线 `89807cf8` 对比：8 个锁定文件字节相同；`src/core`、`data`、`src/packs`、`eval/cases-v2` 没有任何改动。
- 受影响的 33 套自测带一次性 PG 全部通过；涉及告警正文的另 31 套也已核对，修了 `channels.selftest.ts` 里旧格式断言。
- 补文档：R4 差评回归流程写入 `docs/guides/observability.md`，旧镜像长期运行要手动清理写入 `docs/guides/deployment.md`。
- 已知偶发：`feat/17-step0` 的 CI（run 41264499744）里 `settings-e2e` 失败过一次，真实界面切到渠道页后断言 `合成渠道` 不成立。`settle` 在 `isFetching()` 为 0 时就退出，懒加载页面的查询可能还没发起，推断是这条 15 自测的等待竞态，未复现。17 没有改过这个文件，后续 CI 未再出现。

### 第 11 步 清理（2026-11-01）

- 保留持久自测。清掉两个一次性 PG、回滚演练的两个镜像、本机 Langfuse 配置及其全部镜像和卷、`var/` 下的临时文件、两个 Codex worktree、浏览器标签。
- 复核：`docker ps -a` 过滤 `wecom17` 为空，镜像列表没有本次产物，沙箱外列进程没有自测、server、Codex 残留。沙箱里 `pgrep` 取不到进程列表，不能当证据。
- 最终范围：相对基线 `89807cf8` 共 91 个文件，集中在 `console/src`、`src/ops`、`src/db`、`src/shared`、`src/console-api`、`src/jobs`、迁移、部署脚本和文档。`gitleaks git` 扫 24 个提交无泄漏；新增行没有本机路径、超长假企微 id、线上域名或服务器 IP。

### 第 5–6 步（2026-11-01）

- 第 5 步：`src/ops/digest.ts`、`src/ops/latency.ts`、`src/db/repo/ops-reports.ts`、`src/db/repo/ops-latency.ts`、`src/ops/ops-config.ts`、`src/cli/ops-report.ts`、迁移 `0027`。`alert.ts` 加单次发送 `sendOnce`，共用限流，摘要最多占 6 条。启动归位在认领之前把 `sending` 归 `unknown`，同一事务里摘要 job 回 pending 且不消耗 attempts。窗口查询与日指标共用一段有效回复 SQL。
- 第 6 步：`src/shared/alert-policy.ts` 穷尽 15 个 `AlertKey`，21 个手册 key；`docs/ops/observability.md` 21 节；`GET /ops/runbooks/:key`，Dockerfile 带上 `docs/ops`；`deploy/watch.sh`、`deploy/backup.sh` 加级别和编号，状态机不变。`safeText` 未改，链接只由 `publicBase`（HTTPS）与 UUID v4 构造。`store` 默认 P2，冲突、poisoned、spill 回放失败显式 P1。
- 验证：`digest`、`latency`、`ops-report`、`alert-policy` 自测在 PGlite 与一次性 PG 通过，含三处 SIGKILL 中止和本机 HTTP 接收器；`ops` 551 项、`jobs` 126 项、`db` 1396 项、`rollback-guard` 702 项、`console` 467 项、`app-probe` 通过。
- 变异（隔离副本）：去账本终态判断、unknown 可重试、`>=8000`、低样本报恢复、去 `safeText` 的 URL 剔除、放行 http host、删一个 `AlertKey` 映射、删手册一节，都被拦下。
- `rollback-guard` 在机器忙时出现过一次计时断言失败，单独重跑通过，CI 上再看。

### 第 8 步 本机真实 Langfuse（2026-11-01）

- 链路：真实 `handleMessage` → recorder → `src/ops/otel.ts` 与 `src/otel/export.ts` → 本机抓包转发 → Langfuse 3.122.0。模型是本机假服务（走真实 LLM 客户端的 HTTP、重试），两个合成租户 `synth-a`、`synth-b`，db 配置与 db 会话存储（PGlite）。验证脚本是一次性的，放在 `var/`，已删除。
- 样本：每个租户同一会话两轮（工具加 markdown 护栏一轮，429 重试一轮）和另一会话一轮模型失败，共 6 条 trace。

| 字段         | 结果                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| span 树      | `turn` → `invoke_agent travel`（AGENT）→ `execute_tool`（TOOL）、`chat`（GENERATION）、`guard`（SPAN），父子关系正确，耗时有值                                                                     |
| 模型与 token | `chat` 被识别为 GENERATION，`model=glm-5.3-flashx`，input、output、total 可见，界面显示 1,001 → 41                                                                                                 |
| 失败         | 根与 `chat` 都是 `level=ERROR`，`error.type=http_5xx`，`statusMessage` 为空                                                                                                                        |
| 会话分组     | 同一会话两轮共用 `sessionId`，4 个会话互不串，`userId` 同 ref；`trace.name=turn`                                                                                                                   |
| 只保留为属性 | `app.llm.cached_tokens`、`app.llm.hedged`、`app.sop.version`、`app.prefix.hash`、`app.tenant`、`app.turn.*`、`app.guard.*`、`app.tool.prefetch` 在 metadata 里，Langfuse 不把缓存 token 算进 usage |
| 重试         | 没有重试次数属性，429 重试那轮是一个 `chat` span，耗时含等待（849 ms）。这是现状，不改 SDK                                                                                                         |
| 费用         | 没有配模型价格，不作承诺                                                                                                                                                                           |
| 正文         | 抓包负载与 API 读回都搜不到写进客户消息、工具参数、回复的标记串，也搜不到 `wecom:wm` 原始 id；trace 的 input 为 null                                                                               |

- 故障：错鉴权 3 次 401、抓包端断连、真实停掉 Langfuse web（`ECONNREFUSED`），三种情况前两轮回复都照常，`[otel]` 失败日志各一行且不含地址。第三轮是脚本让模型一直 500，与导出无关。
- 关闭：不设端点时抓包 0 个请求，日志里没有 `[otel]`，导出器不加载。
- 界面：登录本机 Langfuse 打开 trace，树、token、Session、User 徽标与 API 一致，输入 null。截图未入库。
- 清理：容器、网络、卷、镜像都已删除（`down --volumes --rmi all`）。

### 第 7 步前端（2026-11-01）

- 概览 `TrendsBlock`：六张小图，每图一个单位，原生 SVG。完整日实心，今天空心、连到今天的线段是虚线，缺失日是底色带，线在缺失处断开，完整日的 0 是贴底短线。悬停或方向键选中一天时六张卡片的数字同步切换，「查看数据」展开同一份表格。
- AI 记录：列表加评价列与「评价」「差评原因」筛选，写进地址；详情在最终回复之后放好评、差评，差评点原因才保存；409 写明并换成最新结果；差评后可下载草稿。新路由 `/console/traces/:turnId`，数据不依赖会话在内存里。
- 浏览器走查（本机预览栈：真实 server、真实 PG、prod 档位，合成工业租户，synthetic 会话直接写库）：登录后切 7/30 天；2 天无数据显示底色带；完整日、今天、gap、deletion 的 coverage 经真实 `ops_metric_coverage` 读取；深链接打开合成 trace，点差评和原因后保存，`?review=bad` 列表筛出同一行，刷新仍在；375 宽 `scrollWidth=clientWidth`，无横向滚动；深色下取到 `--panel`、`--accent` 深色值；方向键让六张卡片同步到前一天；字体 `Geist`、`Noto Sans SC`，`check-fonts` 通过。
- 走查限制：合成会话绕过应用写库，不在内存里，AI 记录抽屉的旧详情接口对它们报「这个会话已经不在了」，抽屉里的抽检由 `traces.selftest.tsx` 覆盖，深链接页用真实接口走查。第 9 步用真实引擎的会话再走一遍抽屉。
- 手册页 `/console/ops/runbooks/:key`：读 `GET /ops/runbooks/:key`，只认标题、段落、代码三种块，不引入 Markdown 库。
- 自测：`console/src/overview/trends.selftest.tsx`、`console/src/traces/traces.selftest.tsx`（114 条）、`console/src/ops/runbook.selftest.ts`（逐节解析真实手册）、`overview`、`errors` 通过。

### 第 2–4 步（2026-11-01）

- 第 2 步：迁移 `0026`，四张表、`ops_coverage_mark_deleted`、`purge_ops_data`；四个被替换的函数逐行对比上一版，只有增补，签名不变。`purgeOnce` 接入 `purge_ops_data`。
- 第 3 步：`src/db/repo/ops-metrics.ts`、`src/ops/trends.ts`、`src/ops/coverage.ts`、`src/ops/minute.ts`、`GET /metrics/trends`。审查时修正：非完整日分母存在时比率 0 不再变 null，p90 取整。检查点写入后也作废展示缓存，最多多一次聚合，保留。
- 第 4 步：`src/db/repo/turn-reviews.ts`、`src/console-api/review-draft.ts`、四个路由与 `/traces` 筛选、两个审计动作。可评谓词只有一处。草稿路径只读评分和原因，不读 trace 正文列。
- 接缝：三路合入同一分支后，下列套件都带一次性 PG 通过：`src/db/observability.selftest.ts`（验收 3 的角色、RLS、五条删除路径、7 天边界）、`src/ops/trends.selftest.ts`（验收 6、11 接口部分）、`src/ops/coverage.selftest.ts`（检查点、删除失效、真实 boot）、`src/console-api/reviews.selftest.ts`（验收 1、2、4、5，完整 server 入口，含外部 v2 用例正反例）；`test:locked` 通过；`trial-reset`、`db`、`sandbox`、`rollback-guard`、`jobs` 由 Codex 带真实 PG 跑过。
- 变异（隔离副本）：去删除标记、去 revision 条件、去差评前置、列表 `none` 不判可评、去种子排除、去消息关联、去启动 gap、去 `invalidateTrends`，都被自测拦下。
- CI：第一轮 #418–#420 都失败在 `check-fonts`，第 0 步校验文案带了 UI 子集没有的「评」，已重建字体子集。#418 另有一次 `settings-e2e`（`合成渠道` 断言）失败，本机同用例通过、dev 为绿，按偶发记录，后续 CI 再看。
- 派活事故：第 1 步拉镜像占满 Docker 虚拟机磁盘时，第 2 步的测试库写入失败，Codex 重建了内存盘容器才跑完；之后测试库一律用内存盘。

### 第 1 步 Langfuse 预检（2026-11-01）

- 版本：D7 定的 `v3.122.1` 没有发布镜像（Docker Hub、GHCR 均无此 tag，`3.122` 与 `3.122.0` 是同一 digest）。`3.122.0` 的 revision 是 `322bc047`，比 `v3.122.1` 少 9 个提交，均未改 OTel 接收代码。owner 原话「用 3.122.0」，spec 已改。
- 官方 compose 的 `langfuse:3`、clickhouse、minio 都是浮动 tag；`minio/minio` 已无法匿名拉取，改用 `bitnamilegacy/minio`。
- 只读核对：接收端认 `langfuse.session.id`、`langfuse.user.id`、`langfuse.trace.name`，OTLP 收 `application/json`，与现有导出器一致。字段映射以第 8 步实测为准。
- 本机：arm64 全部拉取成功。第一次起栈时 Docker 虚拟机 100 GB 磁盘写满，Postgres、ClickHouse 起不来，也波及当时的测试库，已撤掉当次资源。owner 同意后清了 9.66 GB 未使用的构建缓存，第二次起栈全部 healthy，`/api/public/health` 返回版本 `3.122.0`。
- 资源：空闲时 web 约 508 MiB、worker 386 MiB、ClickHouse 507 MiB、MinIO 214 MiB、Postgres 83 MiB、Redis 10 MiB，共约 1.7 GiB；镜像约占 6 GB。
- compose 改动：全部镜像固定 digest，只映射 web 到 `127.0.0.1`，`restart: "no"`，`TELEMETRY_ENABLED=false`，不设 `OTEL_CAPTURE_CONTENT`，凭据运行时生成，放仓库外。

| 服务       | 镜像                                               | digest                                                                    |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| web        | `docker.io/langfuse/langfuse:3.122.0`              | `sha256:c2c726c5904db7d328208136cad6f4e0a8231f2f41134c4f02cb207d01a9e234` |
| worker     | `docker.io/langfuse/langfuse-worker:3.122.0`       | `sha256:08d3b05f80463e86afdef82791ccc3b9c0f81c5e5aa132ddea0f631b9e5e222c` |
| clickhouse | `docker.io/clickhouse/clickhouse-server:25.8.33.6` | `sha256:0152dd511befe6a2c2ef53e930726179669b08116da78500b37c51c96ff5ee77` |
| redis      | `docker.io/library/redis:7.4.12`                   | `sha256:b6b6e3dc0c0952737748e55d5d885272840c7e42ba41ab1d5489f693419882f5` |
| postgres   | `docker.io/library/postgres:17.11`                 | `sha256:31ba9c94a03ada9988f2bb493a22a75eef3a185884533e5cdbcd498ea835b08f` |
| 对象存储   | `docker.io/bitnamilegacy/minio:2025.7.23`          | `sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7` |

### 草案起草（2026-10-31）

- 已读 AGENTS.md、CLAUDE.md、任务说明、SDD 流程、总参考定位、14 spec/plan、ADR-003、02 可观测性条款，补查 07 trace 导出与 15 权限/留存/宿主规则；核对 metrics、alert、jobs、OTel、schema/清理、console 路由及 v2 runner。
- 当前基线 `0f4dda3e`，分支 `docs/17-observability`；未写实现、未操作数据库或生产、未改旧 spec 和锁定文件。仅新增本目录两份文档，提交由协调者完成。
- Langfuse 一手文档仅用于确认候选版本和接入路径；镜像 digest、本机可运行性、实际字段兼容、线上配置均未核实。现有 923 回归与四哈希通过是历史记录，本轮未复验。
- 本轮检查：`pnpm -s format:check` 通过（985 个文件），`git diff --check` 及两份新增文件的 `git diff --no-index --check` 通过。首次格式检查仅报本目录两份文档，限定格式化后复查通过；相对链接、公开边界抽查、13 个未勾步骤与 draft 状态核对通过。按任务要求未跑完整测试、lint/typecheck、数据库或浏览器验证，未提交。

### D1–D7 定案同步（2026-10-31）

- owner 对「7 个决策卡都按推荐吗」答「都按推荐」；D1–D7 全部照 ★ 推荐定案，保留各选项与代价。D2 明确共享试用账号不能打分，面试时由管理员账号演示或用官网截图。
- 两份文档顶部记录原话；一页说明、正文与开工条件/Open 同步为已定，Status 保持 draft，Tier proposal 未获确认。未修改其他 spec 或添加反向标记，步骤 0–12 仍全部未开始。
- 本轮检查：`pnpm -s format:check` 通过（985 个文件）；`git diff --check` 与两份新增文件的 `git diff --no-index --check` 通过。两份文件均保持 draft，13 个实现计划步骤未勾选；未跑完整测试，未提交。

### ready 与 heavy 批准同步（2026-10-31）

- owner 原话「17 改 ready」，并按「点这个就同时确认 heavy 档」确认档位；两份文档已改 ready，Tier 定为 heavy，D1–D7 原结论保持。
- 实现整体排在 15 第 1 批之后，明确设置导航、试用公司与概览页依赖；未执行第 0 步，13 个步骤仍全部未勾。
- 02、07、后台 UX 仅在顶部各新增一行反向标记；主参考仅新增阶段 8 的 17 ready 登记。本轮不写实现、不跑完整测试、不提交。
- 本轮检查：`pnpm -s format:check` 通过（985 个文件），`git diff --check` 通过；逐字核对 02、07、后台 UX 均只新增顶部一行、其余字节不变，主参考仅新增一条阶段 8 登记。17 两份文档 ready/heavy、相对链接及 13 个未勾步骤核对通过；未跑完整测试、未提交。

## Open

- 无未决产品决定或档位/状态审批；D1–D7、heavy 与 ready 均已获 owner 确认。
- 第 12 步翻 `implemented` 等 owner 点名。线上开关 `OPS_DIGEST_TENANTS`、`OPS_LATENCY_TENANTS` 默认关，部署和开启要 owner 当次授权。

## 已定

- D1–D7 全部照 ★ 推荐，owner 对「7 个决策卡都按推荐吗」原话「都按推荐」；选项、代价与结论保留在 spec。
- owner 2026-10-31 原话「17 改 ready」，并按「点这个就同时确认 heavy 档」确认档位；当前 Status: ready、Tier: heavy，无需再次确认。
- 实现须在 15 第 1 批完成并合入后开始，依赖其设置导航、试用公司及概览页改动；14 R6/R9 与 Langfuse 技术验证仍按计划核实。
- 反向标记与主参考登记已随本次更新完成；文档批准不等于实施已完成，也不包含生产操作授权。

## 交接记录

### 2026-10-31 · 草案交接（历史，当前状态以下条为准）

- 已完成：五项范围的 draft spec 与 13 步计划、七张决策卡、权限/删除/私有回归/发送未知/短留存边界、共享契约与三路安排。
- 半成品状态：没有实施代码，步骤 0–12 全部未开始，两份文档均 draft、未提交；检查结果见上方本轮记录。
- 阻塞：尚待 owner 选择 D1–D7 与批准 ready；不把未核实的第三方行为或线上事实写成完成。
- 下一步：协调者审阅并提交草稿；owner 定案后记录 Revisions，补关联 spec 头部/主参考，再按开工条件开始第 0 步。本轮不继续实施。

### 2026-10-31 · D1–D7 定案后交接（历史，当前状态以下条为准）

- 已完成：七张卡的 owner 原话与结论落档，正文改为定案语气，D2 演示方式及计划前置同步。
- 半成品状态：只有本目录两份文档改动，无实现代码，仍为 draft、未提交；检查结果见本轮记录。
- 阻塞：无未决决策卡；heavy 档位仍待 owner 确认，ready 仍须 owner 另外点名。依赖与 Langfuse 技术核实仍按原步骤执行，不以定案代替验收。
- 下一步：协调者审阅并提交；owner 确认档位并另外点名 ready 后，再补关联 spec 反向标记及主参考，满足开工条件后执行第 0 步。

### 2026-10-31 · ready 与 heavy 批准后交接

- 已完成：spec/plan 改 ready、确认 heavy 并记录 owner 原话；开工条件、Open、已定与依赖同步；02/07/后台 UX 顶部反向标记及主参考阶段 8 登记已补齐。
- 半成品状态：仅六份文档改动，无实现代码；步骤 0–12 均未开始，未提交。检查结果见本轮记录。
- 阻塞：无待 owner 决定的问题；实现排期等待 15 第 1 批完成并合入，14 完整验收及 Langfuse 镜像/字段验证仍按原步骤核实。
- 下一步：协调者审阅提交本次文档；15 第 1 批的设置导航、试用公司和概览页改动完成并合入、其余开工条件满足后，按第 0 步核对并继续，不提前抢做实现。
