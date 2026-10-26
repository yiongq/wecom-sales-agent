# 09 · 报价审批、报价单页与站内链接 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。owner 已于 2026-10-26 定本 spec 为 `ready`；各步的「做 / 验 / 依赖」与相对工作量已补齐，下一步从第 0 步开始。

## 开工条件

缺一条就停下，告诉 owner：

1. 08 已 `implemented` 并上线。
2. 本 spec `Status: ready`；反向引用随 09 的 docs PR 合入，包括 02、05、08 的 `Superseded in part by:` 与 02、04、06、08 的 `Amended by:`，整行文本见下方「翻 ready 的 PR：目录外反向引用」。已满足（2026-10-26）：owner 定 ready，七条反向引用随本次 docs 改动落入上述五份 spec。
3. 本机能跑 format / lint / typecheck、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。
4. 部署要 owner 当次授权（第 15 步）。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 与 08 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」与「交接记录」，再看 `git log -5`。
- 锁定的 8 个文件见 AGENTS.md，一个字节都不改。`public/chat.html` 的 `stripLink` 会被锁定测试抠出来运行，必须保持自包含。
- **旅游的字节基准**：第 0 步记下的四类输出、企微卡片、网页部件，每一步结束时都要比对。任何一处变了都是缺陷。
- **测试随批合入**：每一批带上本批的验收测试，合并时是绿的。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、企微标识与凭据、客户原文。

## 步骤

- [ ] 0. 做：核对 08 接口、链接写死处、转人工消费方与库约束、六个订单入口，在实际开工提交采集旅游字节与 v2 基准；验：核对记录可逐项复查；固定时钟下的前缀、四类输出、卡片、部件与 v2 结果有具名基准，锁定套件全绿（验收 1）；依赖：开工条件 1–3。
- [ ] 1. 做：实现 `PackRuntime.siteLinks`、核心登记与沙箱 `resources` 合并，旅游登记 `proposal`（R10）；验：旅游沙箱白名单逐项等价、按租户隔离，卡片与部件字节保持基准；报价路径先用证明包夹具验证登记（验收 1、9）；依赖：0。
- [ ] 2. 做：仅给 `public/web.js` 加通用 `part.title` 分支，`chat.html`、`admin.html` 守原输出（R10）；验：有标题与无标题部件均正确，旅游字节及 `stripLink` 锁定断言不变（验收 1、9）；依赖：1。
- [ ] 3. 做：实现 `linkWhitelistStep` 并在证明包使用（R10）；验：删未登记或不允许的链接及孤立引导语；旅游不使用该步骤，字节不变（验收 9）；依赖：1、2。
- [ ] 4. 做：实现 `QuoteApproval`、建单 `approval` 选项、自动批准与工具结果形态（R1、R2）；验：待审工具结果无订单号 / 合计 / 链接，试算有出处；自动批准按建单快照判定（验收 3、4）；依赖：3。
- [ ] 5. 做：实现复用、取代、过期与 `quoteState`（R6）；验：待审与已批准复用及取代关系正确，自然日边界与过期总览正确（验收 6）；依赖：4。
- [ ] 6. 做：收紧六个订单入口与正式金额来源（R1、R4）；验：六入口逐项符合 R4，online / advisor 都验；旅游公开输出不变（验收 1–3）；依赖：5。
- [ ] 7. 做：实现批准、驳回、撤回的条件写入、重读、推送、备注与转人工（R3、R5）；验：状态表、并发两种先后与提交期间失效正确；卡片条数、驳回备注、过期撤回通知正确（验收 4、5，权限在第 8 步验）；依赖：6。
- [ ] 8. 做：接入报价动作权限与审计标签（R7）；验：角色与接手关系符合 R7，agent 可审 AI 接待会话、viewer 为 403；审计动作与操作者正确（验收 4、5）；依赖：7。
- [ ] 9. 做：实现工作台报价按钮、发送窗口提示、高亮和总览（R5、R8）；验：按钮受权限 / 状态限制，加载 / 空 / 错误态、窗口提示、待审计数正确（验收 5、7、8）；依赖：8。
- [ ] 10. 做：实现两类提醒及执行体，首次确认时间与排程同事务持久化（R8）；验：提醒完成后与重启后重复确认不再提醒；事务失败无半写入；过时任务跳过且不排旧原因（验收 8）；依赖：9。
- [ ] 11. 做：实现报价单页、品牌槽与数据接口，复用 02 重置规则（R9）；验：七种显示状态及加载 / 空 / 错误态正确，所有状态重置后页与接口 404，DB 审批历史保留；沙箱 GET 数据可用（验收 7、9）；依赖：10。
- [ ] 12. 做：实现确定性回复四字段、执行顺序和固定句核对，扩展 `HandoffKind` 与全部消费方（R11、R12）；验：转人工、状态写入、提醒及原因统计正确，未登记或文本不匹配抛错，旅游不变（验收 1、10）；依赖：11。
- [ ] 13. 做：扩展 `handoffKind` 谓词、按包读取 `richTools`，实现两个包钩子（R12、R13、R16）；验：证明包与旅游的谓词结论、批准后阶段及待审时跳过跟进均正确（验收 11、12）；依赖：12；钩子复用第 7 步动作。
- [ ] 14. 做：完成证明包并实现 R15 检查，在一次性本机容器演练 08 tag 的手动与自动回滚（R14、R15）；验：按验收 13：有报价单以 9 拒绝并打印两条出路，无报价单时本项放行，自动回滚同检；覆盖所有保留审批的状态并记录日志；依赖：13。
- [ ] 15. 做：中期逐条核对验收 1–13，审查 diff、权限 / 数据边界与质量门；上线仅在 owner 当次授权后执行；验：各条都有证据，验收 13 引用第 14 步有 / 无报价单及自动回滚的日志；四门全绿，上线后复查旅游验收 1；依赖：14；上线另需开工条件 4。
- [ ] 16. 做：对照当前全部验收 1–13 逐条复核，将通过 / 部分通过 / 未过及证据写入验收记录；验：覆盖每条验收与质量门，验收 13 引用第 14 步对应日志；偏离交 owner 决定，不自行判通过；依赖：15。
- [ ] 17. 做：清理本次临时探针、测试产物、容器、后台进程及不再使用的临时 worktree / 分支；验：无遗留进程和容器，diff 只含交付内容，耐久回归测试保留；共享与无关资源不动；依赖：16。
- [ ] 18. 做：仅在全部验收核实且 owner 确认后更新 `Status: implemented`，按授权发版到 `main`；验：验收记录与 owner 确认齐全，质量门通过，提交 / tag 可追溯，交接无遗漏；依赖：17；owner 确认及发版授权。

## 工作量、依赖与并行

按 spec 的批次给相对工作量；实际耗时由实现与验收结果记录，不作为放行标准。

| 批次 | 步骤  | 工作量 | 主要工作                                     |
| ---- | ----- | ------ | -------------------------------------------- |
| A    | 0     | 小     | 复核引用与采集基准                           |
| B    | 1–3   | 大     | 跨核心、渠道、沙箱与页面的链接登记及兼容验证 |
| C    | 4–6   | 大     | 审批数据、状态推算与六入口约束               |
| D    | 7–10  | 大     | 动作、权限、工作台和持久化提醒               |
| E    | 11    | 中     | 报价单页、三态与沙箱数据接口                 |
| F    | 12–18 | 大     | 确定性回复、谓词 / 钩子、证明包、回滚与收尾  |

- 默认按编号串行，依赖写在各步；第 13 步的动作钩子依赖第 7 步，不能整步与第 5–11 步并行。
- 第 1、4、12、13 步涉及 `pack-api.ts`，第 10、12 步涉及 `src/shared/conversation.ts`；不得在同一工作树并行写。需要拆分时另用独立 worktree，先约定接口、再合入；当前没有安排并行实现。
- 每批交付跑完整四门：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`；旅游前缀、四类输出、企微卡片、网页部件与 v2 结论逐步对照第 0 步基准。新增自测接入既有 `pnpm test`，锁定套件不改，真实模型评测不属于本次文档工作。
- 第 10、14 步的持久化 / 回滚核验使用一次性测试库和容器；外部命令加超时，结束后清理。最终审查与验证决定放在第 15、16 步，步骤 16–18 保持「全量验收 → 清理 → owner 确认后更新 Status」。

## ready 自查（2026-10-26）

按 `docs/spec-driven-dev.md` 逐条检查文档就绪条件；owner 于 2026-10-26 定 ready，目录外反向引用随本次 docs 改动落入，以下条件已满足。实现验收仍按步骤执行。

| 结果 | 条件与依据                                                                           | 09 的证据与本轮补齐                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✔    | RFC 与唯一执行跟踪，目录 / 来源清楚（`docs/spec-driven-dev.md:17-26、74`）           | 只有 spec / plan 两份交付；spec 顶部 Phase 指向主参考，目标 / 非目标与前置条件齐全（`spec.md:10、42、51、59`）。                                                                                            |
| ✔    | 设计足够落地，接口用真实 TypeScript 字段（`docs/spec-driven-dev.md:34-35`）          | R1–R16、状态表、接口与数据流覆盖状态 / 权限 / 持久化 / 发送 / 链接 / 回滚；此前核对已有接口与新增字段的区别。本轮补 `FixedReply.pattern` 的类型说明与已声明扩展的 amendment 归属（`spec.md:69、106、13`）。 |
| ✔    | 不变量独立且可断言（`docs/spec-driven-dev.md:36`）                                   | 单列 10 条不变量，金额、外发时状态、订单流转与固定句都可测试（`spec.md:212`）。                                                                                                                             |
| ✔    | 验收为可观察结果 / 可验证契约（`docs/spec-driven-dev.md:37`）                        | 验收 1–13 覆盖输出字节、HTTP 状态、并发、提醒、界面、钩子和回滚；本轮把回滚改为退出码 / 提示 / 无单放行 / 自动同检（`spec.md:238、264`）。                                                                  |
| ✔    | 界面覆盖加载 / 空 / 错误（`docs/spec-driven-dev.md:38`）                             | 本轮在 R9 与验收 7 补报价单页、工作台报价卡及总览三态、禁用动作和 409 / 403 展示（`spec.md:81、258`）。                                                                                                     |
| ✔    | 开放问题有结论或裁决时机（`docs/spec-driven-dev.md:39`）                             | 原 1–5 已由 owner 决定；回滚 C 已记录为第五条 Revisions；plan Open 为「无」（`spec.md:8、266`；`plan.md:165`）。                                                                                            |
| ✔    | 合法状态与就地修订留痕（`docs/spec-driven-dev.md:40、42、56`）                       | Status 按 owner 决定更新为 ready；前五条 Revisions 原样保留，新增 ready 裁决，未写实现代码（`spec.md:3、9`）。                                                                                              |
| ✔    | 步骤有序、带勾选且不重排（`docs/spec-driven-dev.md:46`；本轮要求各步做 / 验 / 依赖） | 步骤 0–18 编号与未勾选状态不变，全部补齐做 / 验 / 依赖，补相对工作量和共享文件的串行约束（`plan.md:22、44`）。                                                                                              |
| ✔    | 最终审查、验证决定、质量门与固定最后三步（`docs/spec-driven-dev.md:26、48、69`）     | 第 15、16 步审查和验证；每批四门与新增测试接入已写明；16–18 为全验收、清理、owner 确认后更新 Status（`plan.md:39、40、41、42、59`）。                                                                       |
| ✔    | 按日期交接，只在 plan 跟踪，不复制设计正文（`docs/spec-driven-dev.md:49-50、70`）    | 最新交接写明完成项、半成品、阻塞和下一步；实现步骤引用 R 与验收编号，设计正文留在 spec（`plan.md:191`）。                                                                                                   |
| ✔    | 跨阶段技术选型 / 公开边界（`docs/spec-driven-dev.md:60、62`）                        | 沿用现有存储、排程和渠道技术，无新增跨阶段技术选型；文档没有客户数据、密钥或本机绝对路径。                                                                                                                  |
| ✔    | 部分取代 / amendment 双向可追溯（`docs/spec-driven-dev.md:58`）                      | 09 正向头部已齐（`spec.md:12、13`）；2026-10-26 已按清单将七条反向引用落入 02、04、05、06、08，实际位置见下一节。                                                                                           |
| ✔    | owner 决定 draft → ready（`docs/spec-driven-dev.md:41`）                             | owner 于 2026-10-26 定 ready，本次已更新 Status 并新增第六条 Revisions（`spec.md:3、9`）。                                                                                                                  |

实现环境、旅游基准和功能验收属于开工条件及步骤 0–16，不是这次文档自查的已通过结果；「验收记录」继续只留给实际验收证据。

## 翻 ready 的 PR：目录外反向引用

已于 2026-10-26 落入。按各文件现有头部顺序，同类引用加在最后；没有同类行时放在 Status 后。以下保留整行文字与实际新增行号作记录，五份旧 spec 的 Status、正文及已有引用均未改。

02 除部分取代外，还需一条 amendment：09 的 `Amends:` 已扩展它的 `HandoffKind` 与提醒原因，不能漏掉反向引用。

- 目标 `docs/architecture/02-conversations-workbench/spec.md`，已新增于第 11、13 行：

```text
Superseded in part by: [09 · 报价审批、报价单页与站内链接（核心）](../09-quote-approval/spec.md) — 「订单动作只限接手人本人」及不变量 39 的对应限制：报价单的批准、驳回、撤回允许 agent 操作 AI 接待中（没转人工）的会话，其他接手关系与角色权限按 09 R7；不带审批的订单不变。
Amended by: [09 · 报价审批、报价单页与站内链接（核心）](../09-quote-approval/spec.md)（只做新增，全文见该 spec 顶部 Amends：「转人工记录与四种状态」的 HandoffKind 加 pack；「任务表与跟进」「通知」的 handoff_notify 原因加 quote_pending、quote_accepted，见 09 R8、R12）。
```

- 目标 `docs/architecture/05-tenancy-sandbox/spec.md`，已新增于第 4 行：

```text
Superseded in part by: [09 · 报价审批、报价单页与站内链接（核心）](../09-quote-approval/spec.md) — R21「微信里点开的链接」中固定三类公开页及其接口的白名单：改由核心登记与本租户包的 SiteLinkDef 登记合并生成，页面与 resources 的方法 / 路径按 09 R10；旅游白名单逐项相同，令牌、cookie 优先级、同源与限频规则不变。
```

- 目标 `docs/architecture/08-pack-generalization/spec.md`，已新增于第 4、5 行：

```text
Superseded in part by: [09 · 报价审批、报价单页与站内链接（核心）](../09-quote-approval/spec.md) — R3「复用与作废」中「同一会话最多一张待付的通用单」及对应的复用、取代规则：带审批的报价单改按 09 R6，待审与已批准各至多一张；不带审批的通用单不变。
Amended by: [09 · 报价审批、报价单页与站内链接（核心）](../09-quote-approval/spec.md)（只做新增或收紧，全文见该 spec 顶部 Amends：R3 的 createLineOrder 加 approval 选项；R8 放行集合第 (2) 项限于已批准或不需审批的订单；R12 的公开订单接口与支付入口对报价单返回 404，见 09 R1、R2、R4）。
```

- 目标 `docs/architecture/04-industry-packs/spec.md`，已新增于第 10 行：

```text
Amended by: [09 · 报价审批、报价单页与站内链接（核心）](../09-quote-approval/spec.md)（只做新增或收紧，全文见该 spec 顶部 Amends：R3 的 PackRuntime 加 quotes、siteLinks、onQuoteDecided、followupGate，DeterministicReply 加 fixedId、handoff、notify、statePatch，EnginePackHooks 加 quoteRejectedText、quoteWithdrawnText；R15 的 MessagePart.linkKind 扩为字符串并加 title；R11 的 handoff 谓词加可选 handoffKind，shape 改读包已有的 ShapePolicy.richTools；R14 的回滚检查加 pre-09 与退出码 9，见 09 R5、R10–R13、R15、R16）。
```

- 目标 `docs/architecture/06-reply-quality/spec.md`，已新增于第 5 行：

```text
Amended by: [09 · 报价审批、报价单页与站内链接（核心）](../09-quote-approval/spec.md)（只做新增或收紧，全文见该 spec 顶部 Amends：R21 的 FixedReply 加可选 pattern；R2「谓词修正与新谓词」及「回归集目标的扩展」的 handoff 谓词加可选 handoffKind，shape 改读包已有的 ShapePolicy.richTools，见 09 R11–R13）。
```

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

无。

## 交接记录

### 交接（2026-10-23，起草）

- 原「09 · 工业品询价包」经 Opus 评审后拆成两份：本 spec（核心）与 [10](../10-industrial-rfq-pack/spec.md)（工业包与演示）。起草稿在分支 `docs/08-spec`，没推。
- 经三轮 Opus 评审修订；开放问题 1–5 owner 2026-10-23 全部照推荐定（spec 第三条 `Revisions:`）。`Status` 仍是 `draft`。
- 下一步：08 实现并上线之后，owner 翻 `ready`，再补「工作量、依赖与并行」。

### 交接（2026-10-26，开工核对）

- 已完成：按 `dev e2e724f` 与 08 终稿核对 09 的路径、行号、接口和条款，spec 增加第四条 `Revisions:`；本文件记录实际接口、六个入口、转人工消费方和库约束。路径与行号引用逐项核过，并用只读脚本确认引用文件与 e2e724f 相同、行号不越界。按协调者答复落实 `handoffKind`、第 2 步页面范围与验收 1–13 的收尾覆盖。本轮按评审补了提醒持久化去重、重置 404、并发错误码、过期撤回通知与沙箱资源登记；做法和依据见「评审补齐」。
- 状态：仅本目录的 spec 与 plan 有未提交改动，没有实现代码，spec 仍为 `draft`。步骤 0–18 的编号与勾选状态保持不变；旅游基准尚未采集，第 0 步保持未勾选。回滚已由 owner 同日定 C，后续修订与 ready 自查见下一条交接。
- 下一步：按下方最新交接办理 owner 翻 `ready` 与目录外反向引用，再在实际开工提交上采集旅游字节基准。

### 交接（2026-10-26，owner 定回滚 C 与 ready 自查）

- 已完成：R15 与验收 13 改成有报价单拒绝退回 pre-09、无报价单时本项放行，明确前滚 / 含 09 tag 两条出路；自动回滚同检。已删除停机作废命令、动作与审计的有效条款，历史 Revisions 保留；Open 为「无」。
- 已补齐：步骤 0–18 的做 / 验 / 依赖、相对工作量、质量门和最终审查；报价单页与工作台的加载 / 空 / 错误状态及对应验收；已声明接口的类型与 amendment 归属。目录外反向引用的插入位置与整行文字见自查清单之后。
- 半成品状态：只有 09 两份文档的未提交 diff；没有实现代码、没有执行实现验收，验收记录仍为空，Status 仍是 draft；旅游基准在第 0 步采集，所有步骤保持未勾选。
- 阻塞：无未定设计问题。owner 尚未决定翻 ready，目录外反向引用尚未实际写入；这两项是进入实现前的流程待办。
- 下一步：owner 定 ready 后，由协调者在同一 docs PR 更新 Status 并补齐列出的反向引用；再核实现环境、从第 0 步复核基准，按计划实现。当前不提交、不发版。

### 交接（2026-10-26，owner 定 ready）

- 已完成：owner 在开工核对、评审补齐及回滚选 C 后定 09 为 ready；本次更新 Status、新增 ready 修订，将七条反向引用落入 02、04、05、06、08，并同步主参考的阶段 8 记录。ready 自查全部满足，清单已标实际位置。
- 当前状态：本轮只改了八份文档；没有实现代码，未触碰服务器或密钥。步骤 0–18 的勾选状态不变，验收记录仍留给实际验收。
- 阻塞：无未定设计问题；开工时核对本机实现环境。
- 下一步：第 0 步，在实际开工提交上采集旅游字节基准与 v2 基准，复核已有接口和消费方，再按依赖推进实现。
