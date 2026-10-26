# 09 · 报价审批、报价单页与站内链接 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。本文件是起草稿：spec 翻 `ready` 时，由协调者细化每一步的「做 / 验 / 依赖」和工作量。

## 开工条件

缺一条就停下，告诉 owner：

1. 08 已 `implemented` 并上线。
2. 本 spec `Status: ready`；反向引用随 09 的 docs PR 合入，包括 02、05 的 `Superseded in part by:`，以及 08 的 `Superseded in part by:` 与 08、04、06 的 `Amended by:`。
3. 本机能跑 format / lint / typecheck、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。
4. 部署要 owner 当次授权（第 15 步）。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 与 08 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」与「交接记录」，再看 `git log -5`。
- 锁定的 8 个文件见 AGENTS.md，一个字节都不改。`public/chat.html` 的 `stripLink` 会被锁定测试抠出来运行，必须保持自包含。
- **旅游的字节基准**：第 0 步记下的四类输出、企微卡片、网页部件，每一步结束时都要比对。任何一处变了都是缺陷。
- **测试随批合入**：每一批带上本批的验收测试，合并时是绿的。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、企微标识与凭据、客户原文。

## 步骤

- [ ] 0. 开工核对：
  - 08 接口对照；
  - 链接写死处的完整清单；
  - `HandoffKind` 与任务原因的消费方、有没有库约束；
  - 6 个订单入口的代码位置；
  - 旅游字节基准。
- [ ] 1. `PackRuntime.siteLinks` 与核心登记；把 TypeScript 写死处改成读登记；旅游登记 `proposal` 的页面与资源，补沙箱白名单逐项等价自测（R10）。
- [ ] 2. 仅给 `public/web.js` 加通用的 `part.title` 分支；`chat.html`、`admin.html` 只守原输出；锁定测试全绿（R10）。
- [ ] 3. `linkWhitelistStep` 与自测（R10）。
- [ ] 4. `QuoteApproval`、`createLineOrder` 的 `approval` 选项、`autoApprovable`、工具结果的待审形态（R1、R2）。
- [ ] 5. 复用、取代、过期与 `quoteState`（R6）。
- [ ] 6. 6 个订单入口对报价单的行为（R4）。
- [ ] 7. 批准、驳回、撤回的接口：按条件写入、重读、推送、备注、转人工；并发批准 / 驳回后到者为 `already_decided`，过期后撤回仍通知（R3、R5）。
- [ ] 8. 权限与审计标签（R7）。
- [ ] 9. 工作台订单卡：按钮、窗口提示、高亮；总览的「报价单等你审核」（R5、R8）。
- [ ] 10. `quote_pending`、`quote_accepted` 两条提醒，以及执行体；首次确认时间与排程同事务持久化，验提醒完成后与重启后再次确认不再提醒（R8）。
- [ ] 11. 报价单页与 `GET /api/quotes/:orderId`；各状态按 02 重置后均返回 404，DB 保留审批历史（R9）。
- [ ] 12. `DeterministicReply` 的四个字段与执行顺序、`fixedId` 核对；`HandoffKind` 加 `pack`，补齐全部消费方（R11、R12）。
- [ ] 13. `shape` 谓词改读 `ShapePolicy.richTools`；`handoff` 谓词加可选的 `handoffKind?: HandoffKind`；`onQuoteDecided` 与 `followupGate` 两个钩子（R12、R13、R16）。
- [ ] 14. 证明包收口；`quote-void --all`；回滚检查与本机 docker 演练（R14、R15）。
- [ ] 15. 中期验收：验收 1–13 在本机逐条核对，第 13 条以第 14 步的回滚演练为证据；上线（owner 当次授权）。
- [ ] 16. 对照验收标准 1–13 逐条核对，写下通过、部分通过或未过，以及证据；第 13 条引用第 14 步的回滚演练。
- [ ] 17. 清理：临时探针、容器、worktree、分支。
- [ ] 18. 更新 Status（owner 确认后翻 `implemented`），发版到 `main`。

## 工作量、依赖与并行

翻 `ready` 时补。已知的依赖：

- 第 1–3 步先做，并跑通旅游的字节基准。
- 第 5–11 步依赖第 4 步。
- 第 10 步与第 12 步都改 `src/shared/conversation.ts` 的通知文案表，串行做；第 13 步可以与第 5–11 步并行。

## 实施记录

### 开工核对（2026-10-26，对照 dev e2e724f 与 08 终稿）

- 本次只对齐文档；spec 保持 `draft`，步骤 0–18 的数量、顺序与勾选状态不变。第 0 步的接口、引用与消费方核对已做；旅游字节基准尚未在 09 开工提交上采集，所以第 0 步不打勾。
- 08 已 `implemented` 并发版，依据 08 plan「交接（2026-10-25，08 完成）」。其验收 13、14 的 owner 已确认偏离照旧；09 的旅游基准应取当前提交，不能拿 08 起跑时的闸哈希代替：08 发版后合入的 #314 已修正模拟评测谓词，见 08 plan「验收 14」。本次没有访问线上或调用模型。

| 09 引用                                                    | e2e724f 的实际接口 / 位置                                                                               | 核对结论                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `createLineOrder`、`LinePick`、`LineOrder`、`OrderDisplay` | `src/core/order-view.ts:5-75`；其中建单、`LinePick`、`LineOrder` 从 `src/core/pack-api.ts:33、951` 导出 | 名称不变；建单返回 `Promise` 联合，09 的占位名 `createLineOrder08` 改成实际返回形状；第三个 `approval` 参数仍是 09 新增                   |
| 通用单复用与取代                                           | `src/core/order-view.ts:135-146`；08 R3                                                                 | 现状按 `(kind, code, qty, unitPriceFen)` 排序比对，所有旧待付通用单被新单取代；09 R6 是部分取代，头部归属已补正                           |
| `PackRuntime`、`preModel`、`sessionState`、`priceLine`     | `src/core/pack-api.ts:749-811`                                                                          | 已有成员保持；`quotes`、`siteLinks`、`onQuoteDecided`、`followupGate` 均尚未存在，仍由 09 新增                                            |
| `DeterministicReply`、`EnginePackHooks`                    | `src/core/pack-api.ts:257-259、832-865`                                                                 | 确定性回复仍只有 `text`；新增字段共四个。08 已有 `paidLineText`，09 不另造付款确认钩子；`quoteRejectedText` / `quoteWithdrawnText` 仍新增 |
| `money_provenance` 放行集合                                | `src/core/guards/money-provenance.ts:26-36`；`src/core/tools/registry.ts:24-32`                         | 订单来源包含通用单的单价、行金额、总额；工具来源是 `ToolSpec.amounts` 写入的 `Session.moneyLedger`。R1 仅收紧订单来源，原有工具来源不改   |
| `MessagePart.linkKind`、`ShapePolicy.richTools`            | `src/shared/channel-types.ts:24-28`；`src/core/pack-api.ts:531-542`；`src/core/guards/shape.ts:190-192` | 前者仍是三值联合且无 `title`；后者从包的 `thresholds.shape` 读取，评测仍用 `eval/sim/judge.ts:32-39` 的固定集合                           |
| 固定句登记                                                 | `src/core/consistency.ts:31-45`；06 R21                                                                 | 实际类型为 `FixedReply`，样例由 `samples()` 给出；`pattern` 尚不存在，09 头部补入对 06 R21 的 amendment                                   |
| 站内链接与卡片                                             | spec「背景与问题」的逐项清单；`src/adapters/wecom.ts:889-893、1125-1134`                                | 链接种类仍写死；env / DB 两条发送路径都已跳过空正文。`text.ts` 的版本后缀保护与企微文本字节上限不属于链接种类表                           |
| 证明包与回归基点                                           | `src/packs/__fixture/runtime.ts:153-158、255-313、367`；`src/web/web.selftest.ts:719-723`               | 建单工具叫 `fixture_order`，已走 `createLineOrder` 并声明金额；`thresholds` 当前为空，审批与报价页能力尚未实现。网页部件仍按原键集合比对  |

六个订单入口的现状：

| 入口                       | 位置 / 函数                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/orders/:id`      | `src/server.ts:766-770`，`publicAnyOrder` 在 `src/server.ts:329-338`                     |
| `GET /pay/:orderId`        | `src/server.ts:856-876`，通用单经 `orderDisplay`                                         |
| `POST /api/orders/:id/pay` | `src/server.ts:784-797`，经 `getAnyOrder` / `markOrderPaid`                              |
| console 确认价格           | `src/console-api/app.ts:940-945` → `src/payment/orders.ts:64-74` 的 `confirmOrder`       |
| console 确认收款           | `src/console-api/app.ts:946-951` → `src/payment/orders.ts:95-117` 的 `markPaidByAdvisor` |
| console 取消               | `src/console-api/app.ts:967-972` → `src/payment/orders.ts:77-85` 的 `cancelOrder`        |

- 条款对照：08 R3 / R5 / R8 / R12 分别是通用订单、依赖方向、金额出处、通用单页面；不变量 4 与验收 1 编号不变。04 包接口是 R3，模拟评测是 R11，消息部件是 R15；06 谓词是 R2、固定句是 R21。02 权限条款在第 773、986 行，不变量 39 在第 1462 行；09 已定的撤回权限一并补进头部，权限本身不改。
- `HandoffKind` 消费方：值集与运行时校验在 `src/shared/conversation-types.ts`；固定原因在 `src/handoff/reasons.ts`（`record.ts` 再导出）；通知正文与标题在 `src/shared/conversation.ts`，时间标签在 `src/notify/notifier.ts`；提醒排程与执行体在 `src/jobs/notify.ts`、`src/notify/handoff.ts`。`HANDOFF_REASON` 是 `Partial<Record<HandoffKind, string>>`，R12 加 `pack` 时仍由包给实际原因。
- 其余类型与展示消费方已核：`src/types.ts`、`src/store/events.ts`、`src/shared/console-api.ts`、`src/console-api/app.ts`、`src/console-api/goal-draft.ts`、`src/ops/board.ts`、`src/db/repo/traces.ts`，以及 `console/src/overview/model.ts`、`console/src/conversations/TraceDetail.tsx`、`console/src/traces/model.ts`、`console/src/traces-search.ts`、`console/src/shell/notifications.ts`。它们复用共享类型、值集或标签表；模拟评测的可选类型字段按协调者答复定为 `handoffKind?: HandoffKind`（R12）。
- 库约束：`handoff_kind` 是无枚举 CHECK 的 text（`drizzle/0002_conversations.sql:36`、`src/db/schema.ts:323`）；任务原因在 JSON payload，CHECK 约束的是任务 `kind`（`drizzle/0002_conversations.sql:78-86`、`src/db/schema.ts:534-550`）。现状不要求为新增 `pack` / 提醒原因写迁移；执行体自己的原因白名单 `REASONS` 仍需扩展（`src/notify/handoff.ts:51-57`）。

### 评审补齐（2026-10-26）

- 提醒去重选订单 `approval.acceptedAt`：`enqueueJob` 只对未结束任务去重（`src/db/repo/jobs.ts:28-47`），`jobs_open_uq` 也是部分唯一索引（`src/db/schema.ts:553-556`）；结束任务还会按 30 天保留期清理（`drizzle/0003_conversations_rls.sql:250-268`），所以不把整张报价单的去重记录只寄托在任务行上。订单 JSON 可保存新增字段（`src/db/schema.ts:417-418`、`src/store/project.ts:269-291`），已有落库路径把订单与任务交给同一事务（`src/store/pg-backend.ts:670-682、1347-1350、1379`），R8 与接口已明确沿用此路径；验收 8 补提醒完成、重启与事务失败场景。
- 沙箱资源登记选 `SiteLinkDef.resources`：现有白名单只有页面的 GET / HEAD、订单和方案书接口的 GET / HEAD、模拟支付的 POST（`src/tenancy/sandbox/outbound.ts:387-392`），可完整表达为路径模式与方法列表。`process.ts` 已能从链接令牌取得租户运行时（`src/tenancy/sandbox/process.ts:315-355`），改为解析租户后匹配其登记；R10、接口、登记清单与验收 9 已补齐，旅游逐项保持原白名单。05 R21 的固定白名单归属已加到 spec 的部分取代头部；05 正文保持不变，反向引用留 docs PR 时补。
- 状态表：重置统一引用 02 spec 第 282 行，DB 保留审批历史但订单退出可读集合；拆开已驳回与已撤回，仅把已驳回时的批准错误码改成 `already_decided`；已批准且过期的单撤回仍推送。验收 4、5、7 同步覆盖。没有实现代码或执行这些验收。

## 验收记录

## Open

仅保留 Open 2，待 owner 确认；spec 的 R15 与验收 13 原文不动。不重开 spec 已定的开放问题 1–5。

2. **作废后的回滚放行条件（阻塞，留 owner 定）。** R15 凡 `data->'approval' IS NOT NULL` 就拒绝，而 `quote-void --all` 不删除 `approval`，与验收 13 的「作废后放行」冲突。更正前轮影响说明：平台作废只处理待审和已批准两种，落为撤回、订单 `cancelled`；已付、已驳回、已撤回、被取代的单不变，仍带 `approval`（spec「状态表」后的平台作废规则）。不能再说「作废后的报价单都是 cancelled」。

   - **选项 A：** 保留严格拒绝，另补完整的清理或归档办法，让 08 的旧镜像不再读取这些单。代价：要新设计覆盖所有报价单状态的清理 / 归档及审计保留办法，不能只去掉 `approval` 后当普通单暴露；还要补旧镜像读取边界与回滚验收。推荐理由：保住审批保护金额的边界，同时保留安全退回 pre-09 的路径。
   - **选项 B（修正后）：** 作废之后，只要「没有处于待审或已批准的报价单」就放行；先按订单终态判断，已付、已取消、被取代不算待审或已批准，未终结的已批准单即使过期也要先作废。这个谓词不是「没有带 `approval` 的订单」。代价是接受两条影响：08 的公开接口和支付页会显示这些仍可读订单的金额（`src/server.ts:329-338、766-770、867-876`）；`money_provenance` 不按订单状态过滤，放行集合会包含本会话这些通用单的金额（`src/core/guards/money-provenance.ts:28-35`）。这些单要么已终结、不能再付款（已付只幂等返回，已取消或被取代被拒，`src/server.ts:784-797`），要么未批准的链接按不变量 2 从没发出去过、客户没有订单号；已批准后撤回的单，客户本来就看过金额。推荐理由：无需新增归档机制即可回滚，适合 owner 接受上述金额可见性与放行集合变化的情形。
   - **选项 C：** 库里一旦有报价单，就不支持回滚到 pre-09；检查脚本以 9 拒绝，提示只能前滚修复，或者回滚到另一个含 09 的 tag。代价：放弃有报价单数据时退回 pre-09 的路径；选定后须一并删去 `quote-void` 及其验收，将验收 13 改成「有报价单时拒绝、没有时放行」。推荐理由：规则最直接，不需要跨版本清理，也不会让旧镜像读取报价单金额。

   **已核事实与适用范围：** 09 只用 `__fixture` 验证报价审批（spec 目标 6、R14，真实行业包与演示租户在 10）；它只在 `PACK_FIXTURES=1` 时登记为可用包（`src/packs/registry.ts:28-35`），测试租户创建也再次检查该开关（`src/tenancy/fixture-testing.ts:10-18`）。08 上线记录确认线上 env 未启用该开关、只有旅游租户，上线后租户未变（`docs/architecture/08-pack-generalization/plan.md:810-815`）；09 保持旅游不建报价单。因此，按已记录的部署与 09 / 10 范围，10 上线之前线上库不会产生报价单，这道检查实际上不会触发；开启证明包的本地验收库仍会触发。本轮只核仓库记录与代码，没有访问线上。

   本次仍推荐 A；最终由 owner 在 A / B / C 中决定。R15 与验收 13 原文不动，`quote-void` 及第 14 步仍保留，等选定后统一修订。

## 交接记录

### 交接（2026-10-23，起草）

- 原「09 · 工业品询价包」经 Opus 评审后拆成两份：本 spec（核心）与 [10](../10-industrial-rfq-pack/spec.md)（工业包与演示）。起草稿在分支 `docs/08-spec`，没推。
- 经三轮 Opus 评审修订；开放问题 1–5 owner 2026-10-23 全部照推荐定（spec 第三条 `Revisions:`）。`Status` 仍是 `draft`。
- 下一步：08 实现并上线之后，owner 翻 `ready`，再补「工作量、依赖与并行」。

### 交接（2026-10-26，开工核对）

- 已完成：按 `dev e2e724f` 与 08 终稿核对 09 的路径、行号、接口和条款，spec 增加第四条 `Revisions:`；本文件记录实际接口、六个入口、转人工消费方和库约束。路径与行号引用逐项核过，并用只读脚本确认引用文件与 e2e724f 相同、行号不越界。按协调者答复落实 `handoffKind`、第 2 步页面范围与验收 1–13 的收尾覆盖。本轮按评审补了提醒持久化去重、重置 404、并发错误码、过期撤回通知与沙箱资源登记；做法和依据见「评审补齐」。
- 状态：仅本目录的 spec 与 plan 有未提交改动，没有实现代码，spec 仍为 `draft`。步骤 0–18 的编号与勾选状态保持不变；旅游基准尚未采集，第 0 步保持未勾选。仅 Open 2 的 A / B / C 回滚方案留待 owner 确认，已核证明包开关与 10 上线前的适用范围；spec 的 R15 与验收 13 原文没改。
- 下一步：owner 确认 Open 2 后修订；owner 翻 `ready` 时补齐各步做 / 验 / 依赖与反向引用，再在实际开工提交上采集旅游字节基准。
