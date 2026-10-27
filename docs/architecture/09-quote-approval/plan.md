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

- [x] 0. 做：核对 08 接口、链接写死处、转人工消费方与库约束、六个订单入口，在实际开工提交采集旅游字节与 v2 基准；验：核对记录可逐项复查；固定时钟下的前缀、四类输出、卡片、部件与 v2 结果有具名基准，锁定套件全绿（验收 1）；依赖：开工条件 1–3。
- [x] 1. 做：实现 `PackRuntime.siteLinks`、核心登记与沙箱 `resources` 合并，旅游登记 `proposal`（R10）；验：旅游沙箱白名单逐项等价、按租户隔离，卡片与部件字节保持基准；报价路径先用证明包夹具验证登记（验收 1、9）；依赖：0。
- [x] 2. 做：仅给 `public/web.js` 加通用 `part.title` 分支，`chat.html`、`admin.html` 守原输出（R10）；验：有标题与无标题部件均正确，旅游字节及 `stripLink` 锁定断言不变（验收 1、9）；依赖：1。
- [x] 3. 做：实现 `linkWhitelistStep` 并在证明包使用（R10）；验：删未登记或不允许的链接及孤立引导语；旅游不使用该步骤，字节不变（验收 9）；依赖：1、2。
- [x] 4. 做：实现 `QuoteApproval`、建单 `approval` 选项、自动批准与工具结果形态（R1、R2）；验：待审工具结果无订单号 / 合计 / 链接，试算有出处；自动批准按建单快照判定（验收 3、4）；依赖：3。
- [x] 5. 做：实现复用、取代、过期与 `quoteState`（R6）；验：待审与已批准复用及取代关系正确，自然日边界与过期总览正确（验收 6）；依赖：4。
- [x] 6. 做：收紧六个订单入口与正式金额来源（R1、R4）；验：六入口逐项符合 R4，online / advisor 都验；旅游公开输出不变（验收 1–3）；依赖：5。
- [x] 7. 做：实现批准、驳回、撤回的条件写入、重读、推送、备注与转人工（R3、R5）；验：状态表、并发两种先后与提交期间失效正确；卡片条数、驳回备注、过期撤回通知正确（验收 4、5，权限在第 8 步验）；依赖：6。
- [x] 8. 做：接入报价动作权限与审计标签（R7）；验：角色与接手关系符合 R7，agent 可审 AI 接待会话、viewer 为 403；审计动作与操作者正确（验收 4、5）；依赖：7。
- [x] 9. 做：实现工作台报价按钮、发送窗口提示、高亮和总览（R5、R8）；验：按钮受权限 / 状态限制，加载 / 空 / 错误态、窗口提示、待审计数正确（验收 5、7、8）；依赖：8。
- [x] 10. 做：实现两类提醒及执行体，首次确认时间与排程同事务持久化（R8）；验：提醒完成后与重启后重复确认不再提醒；事务失败无半写入；过时任务跳过且不排旧原因（验收 8）；依赖：9。
- [x] 11. 做：实现报价单页、品牌槽与数据接口，复用 02 重置规则（R9）；验：七种显示状态及加载 / 空 / 错误态正确，所有状态重置后页与接口 404，DB 审批历史保留；沙箱 GET 数据可用（验收 7、9）；依赖：10。
- [x] 12. 做：实现确定性回复四字段、执行顺序和固定句核对，扩展 `HandoffKind` 与全部消费方（R11、R12）；验：转人工、状态写入、提醒及原因统计正确，未登记或文本不匹配抛错，旅游不变（验收 1、10）；依赖：11。
- [x] 13. 做：扩展 `handoffKind` 谓词、按包读取 `richTools`，实现两个包钩子（R12、R13、R16）；验：证明包与旅游的谓词结论、批准后阶段及待审时跳过跟进均正确（验收 11、12）；依赖：12；钩子复用第 7 步动作。
- [x] 14. 做：完成证明包并实现 R15 检查，在一次性本机容器演练 08 tag 的手动与自动回滚（R14、R15）；验：按验收 13：有报价单以 9 拒绝并打印两条出路，无报价单时本项放行，自动回滚同检；覆盖所有保留审批的状态并记录日志；依赖：13。
- [x] 15. 做：中期逐条核对验收 1–13，审查 diff、权限 / 数据边界与质量门；上线仅在 owner 当次授权后执行；验：各条都有证据，验收 13 引用第 14 步有 / 无报价单及自动回滚的日志；四门全绿，上线后复查旅游验收 1；依赖：14；上线另需开工条件 4。
- [x] 16. 做：对照当前全部验收 1–13 逐条复核，将通过 / 部分通过 / 未过及证据写入验收记录；验：覆盖每条验收与质量门，验收 13 引用第 14 步对应日志；偏离交 owner 决定，不自行判通过；依赖：15。
- [x] 17. 做：清理本次临时探针、测试产物、容器、后台进程及不再使用的临时 worktree / 分支；验：无遗留进程和容器，diff 只含交付内容，耐久回归测试保留；共享与无关资源不动；依赖：16。
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

### 第 0 步 · 开工基准（2026-10-26）

- 开工提交：#323 合入后的 `dev`（基准在其内容 `2e9e169` 上采集，产品代码与 `e2e724f` 相同）。`git diff --stat e2e724f HEAD -- . ':(exclude)docs'` 输出为空、退出 0：#314 之后到本次开工只改文档。未重写上方开工核对表，未修改产品代码、spec、旧夹具或 v2 基线。
- 第 0 步已勾选：范围 1–4 的基准与核对完成；范围 5 的 Docker 检查在 Codex 沙箱里跑不了，协调者在本机补验通过（见下）。开工条件 1–3 全部满足。

本轮在当前 HEAD 实际复核的定位（源码与 e2e724f 相同）：

| 核对项                      | 定位                                                                                                                                                                        | 结论                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 08 通用订单类型、建单与导出 | `src/core/order-view.ts:5-75`；`src/core/pack-api.ts:33、951`                                                                                                               | 类型与异步返回联合均与上表一致；尚无 approval 参数。                                                                                                                                                       |
| 待付通用单复用 / 取代       | `src/core/order-view.ts:135-146`                                                                                                                                            | 仍按 kind、code、qty、unitPriceFen 排序比较，未复用时取代全部旧待付单。                                                                                                                                    |
| 包运行时成员                | `src/core/pack-api.ts:749-811`                                                                                                                                              | preModel、sessionState、priceLine 已有；09 的四个新成员尚无。                                                                                                                                              |
| 确定性回复与引擎钩子        | `src/core/pack-api.ts:257-259、832-865`                                                                                                                                     | 回复只有 text；paidLineText 已有，两个报价钩子尚无。                                                                                                                                                       |
| 金额来源                    | `src/core/guards/money-provenance.ts:26-36`；`src/core/tools/registry.ts:24-32`                                                                                             | 通用单单价、行金额、总额与 moneyLedger 都进入集合。                                                                                                                                                        |
| 消息部件与 shape            | `src/shared/channel-types.ts:24-28`；`src/core/pack-api.ts:531-542`；`src/core/guards/shape.ts:190-192`；`eval/sim/judge.ts:32-39`                                          | linkKind 仍三值、无 title；出口读包 richTools，评测仍固定五种工具。                                                                                                                                        |
| 固定句                      | `src/core/consistency.ts:31-45`                                                                                                                                             | samples() 不变，尚无 pattern。                                                                                                                                                                             |
| 链接识别与卡片              | `src/core/message-parts.ts:10、29`；`src/adapters/wecom.ts:657、673-705、889-893、1125-1134`                                                                                | order / proposal / site 仍写死；env 与 DB 都跳过空正文，方案卡仍经 routeForProposal。                                                                                                                      |
| 其他写死处                  | `src/core/guards/dejargon.ts:8`；`src/core/guards/shape.ts:27`；`src/core/insight.ts:184-187`；`public/chat.html:411-430`；`public/web.js:54`；`public/admin.html:954、981` | 原清单对应文件与开工前源码一致；text.ts 的版本保护仍不算登记表。                                                                                                                                           |
| 公开订单 GET                | `src/server.ts:329-338、766-770`                                                                                                                                            | 经 getAnyOrder / publicAnyOrder 返回公开投影。                                                                                                                                                             |
| 支付页 GET                  | `src/server.ts:856-876`                                                                                                                                                     | 通用单经 orderDisplay。                                                                                                                                                                                    |
| 模拟支付 POST               | `src/server.ts:784-797`                                                                                                                                                     | 经 getAnyOrder / markOrderPaid，没有报价审批判断。                                                                                                                                                         |
| console 确认价格            | `src/console-api/app.ts:940-945`；`src/payment/orders.ts:64-74`                                                                                                             | confirmOrder 只处理既有价格确认。                                                                                                                                                                          |
| console 确认收款            | `src/console-api/app.ts:946-951`；`src/payment/orders.ts:95-117`                                                                                                            | markPaidByAdvisor，保留既有权限和收款方式判断。                                                                                                                                                            |
| console 取消                | `src/console-api/app.ts:967-972`；`src/payment/orders.ts:77-85`                                                                                                             | cancelOrder，未加审批动作。                                                                                                                                                                                |
| 转人工值集与消费方          | `src/shared/conversation-types.ts:8-35`；`src/handoff/reasons.ts:8-20`；`src/shared/conversation.ts:125`；`src/jobs/notify.ts:29、46`；`src/notify/handoff.ts:51-57`        | 仍 11 类、无 pack；固定原因是 Partial Record；执行体白名单仍四个提醒原因。另以 rg 复核上表所列 types、events、console-api、goal-draft、board、traces 及 console 展示消费方，仍复用共享类型、值集或标签表。 |
| 数据库约束                  | `drizzle/0002_conversations.sql:36、78-86`；`src/db/schema.ts:323、534-550`                                                                                                 | handoff_kind 为无枚举 CHECK 的 text；任务 payload 为 JSON，CHECK 只限制任务 kind，新增原因无需迁移。                                                                                                       |

新增基准与取舍：

- `src/core/link-bytes.selftest.ts` + `link-bytes.fixture.json`：放 core 是因为同时覆盖渠道卡片、网页部件和沙箱资源的消费契约，不属于支付专属出口。沿用 `UPDATE_LINK_BYTES=1` 的一次生成惯例；常规运行只读夹具，具名键集及 JSON 字符串逐字节相同，不归一输出。
- 时钟为 `PARITY_CLOCK_MS=1790913600000`，与 legacy-bytes 相同。固定合成订单、路线和方案版本；只在发送段固定 randomBytes，让完整 send_msg 的随机 msgid 可重复，退出发送段即恢复随机源。全部 fetch 由封闭 mock 接住，未登记端点直接报错。
- 12 组文本含订单、方案书、privacy、订单与方案同条、?v=1、无链接、两种纯卡片、相对链接、不存在版本和站外链接；env / DB 各记录卡片抽取、MessagePart[]、AI 与 human 的完整最终发送载荷（含标题、摘要、URL、缩略图、接收方、账号和 msgid），共 96 条。env 从公开 push 进入 sendRich；DB 用 PGlite 真实账号装载，从公开 push 进入 pushDb / payloadsFor，未增加测试导出。
- 沙箱 17 条具名路径 × 6 种方法（GET / HEAD / POST / PUT / DELETE / OPTIONS），另存 17 条 wxPage 判定，共 221 条。既比较 outbound.ts 的 wxResource，也用真实 process.ts 中间件、有效链接 cookie 和哨兵路由比较 HTTP 状态 / Location，覆盖三类公开页、订单 / 方案接口、模拟支付 POST 及越界路径和方法。
- package.json 仅在 test 末尾追加新命令；CI 清单直接从 test 导出，在 `scripts/ci-weights.json` 登记 10 秒估值。`ci-shard.ts --check 4`：186 units、25 strict suites，打印的新单元包含 link-bytes。分片器自测 49 条断言通过。

基准证据：

```text
PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
LEGACY BYTES SELFTEST PASS: 140 项断言全通（60 条出口字节与夹具逐字节相同；旅游会话 state json 无 packState、moneyLedger）
LINK BYTES SELFTEST PASS: 317 条字节基准，517 项断言
link-bytes.fixture.json sha256=4688c34e5ee02df443f6986ed110af066e5a7fd513a1ee6ea6c33dd8f943f14e
```

锁定八文件 sha256（本轮 diff 为空）：

```text
66e9cd26464e5d71bdf945ac22d9a09b9ed354be05d31766ccf345af88369730  src/engine.selftest.ts
166c124e28cec35a9b8b0e306bbda653e653ee5795fd186388185812e32a3941  src/dejargon.selftest.ts
351fd745fcb65ed6f87605fe3deb4a60841598e983b44a6d91c9493571ff9cb8  src/engine-holiday.selftest.ts
d3f11083704b51fc13bc6be93933a094c2e0abd0310da6f87021e3df4a8d92a1  src/price-guard.selftest.ts
4a577bb23225aa54881c783ffe7bd41b1e115179a2f8b62044af21b70b07dc04  src/llm.selftest.ts
090741c5b244dc74160647aaf9e0e7d3a45c6c534d20e008d8af96920c7b3365  src/server.selftest.ts
d37341de95e87956b643dfd6ef5aee28011e39a7ce5391148e0157f9800c7882  src/adapters/wecom.selftest.ts
aa8f00693fa63182361d4a03e2020ad1743000d7e15167bca8c0451f49b7ea91  eval/cases.json
```

v2 默认基线 `eval/baselines/v2-08-step17.json`，两次均未更新基线：

```text
CONFIG_SOURCE=file LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
v1 mock：19/19 用例通过，跳过 32 条需真实模型的用例，43 项断言
CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
v1 mock：19/19 用例通过，跳过 32 条需真实模型的用例，43 项断言；19 个会话入库核对，0 处与内存不符
```

变异在隔离副本执行，工作树产品文件始终不改；仅把 message-parts 的 site 分支临时改为 proposal，结果：

```text
变异运行退出码：1
AssertionError [ERR_ASSERTION]: 字节：env/parts/site
还原运行退出码：0
LINK BYTES SELFTEST PASS: 317 条字节基准，517 项断言
```

副本及其临时目录已删除。相关自测按新文件名、夹具名与 ci-shard / ci-weights 搜索，直接受影响的是新字节自测和分片器自测，均通过；另跑 legacy-bytes、锁定套件与两种 v2 回归。format:check、lint、typecheck 均通过；按本步任务要求，完整 pnpm test 留 CI。lint 的内容黑名单因缺少 SENSITIVE_PATTERNS / .sensitive-patterns 按既有行为跳过，其余子检查通过；补以 diff 的绝对路径、假企微长 id 与锁定文件检查，均无新增命中。

容器检查仅试一次（60 秒上限）：`docker run --rm pgvector/pgvector:pg17 postgres --version` 退出 1，输出 `failed to connect to the docker API at unix:///var/run/docker.sock`、`connect: no such file or directory`。CLI 同时提示默认配置不可读；没有访问配置内容，也未创建容器。协调者需在可用 Docker 环境复核，成功后再决定勾选第 0 步。

协调者补验（2026-10-26，本机，出 Claude 沙箱）：`docker run --rm pgvector/pgvector:pg17 postgres --version` 退出 0，输出 `postgres (PostgreSQL) 17.11`；跑完没有残留容器。

### B 批 · 第 1–3 步

- 第 1 步：新增 `src/core/site-links.ts`，核心登记 `site` / `order`，`PackRuntime.siteLinks` / `SiteLinkDef.resources` 声明包文档与接口方法。旅游在 `src/packs/travel/site-links.ts` 登记 `proposal`，卡片的 `routeForProposal` 仍调用旅游 catalog；证明包登记 `quote` 与仅 GET 的数据资源，本批不实现报价数据或页面。
- 写死处逐项迁移：`message-parts.ts` 的链接识别和 linkKind、`shape.ts` 的相对链接保护、`dejargon.ts` 的路径掩码、`insight.ts` 的草稿删链；`wecom.ts` 的分段保护、单卡识别、卡片文字与相对链接绝对化；`server.ts` 的文档静态页选择、`BrandPage` 的字符串类型；`sandbox/outbound.ts` 的改写和最终白名单、`sandbox/process.ts` 的页面包装、令牌入口与 cookie 资源鉴权。全部只合并核心与所选租户包，不取全局包并集。
- 第 2 步：`MessagePart.linkKind` 改为字符串，增加可选 `title`；消息回复、历史和 SSE 推送传递所属会话给 `partTitle`。只有 `web.js` 增加 `part.title ?? 原标题`，`chat.html`、`admin.html` 与两处 `stripLink` 未修改；核心和旅游均不提供 `partTitle`。
- 第 3 步：核心 `linkWhitelistStep()` 删除未登记、站外、伪协议或 `allowed=false` 的链接，只删除因删链而悬空的引导句。证明包将它排在 `money_provenance` 后、后置接管检查前；旅游继续自己的原 `link_whitelist`（`after: order_net`），没有换用核心工厂。
- 本批定的细节：登记模块在调用时读现有租户运行时的包绑定与订单内存，避免经 `pack-api` 装配时反向加载配置/存储形成循环；静态核心登记冻结，不新增租户状态。卡片保留旧的单链接识别口径，核心订单卡仍由旧 `card` 读者渲染（顾问已有订单卡不新增会话限制）；新包文档卡检查当前会话的 `allowed`，核心白名单步骤对订单也执行 `allowed`。网页部件仍只是最终文本投影，不新增订单查询或存在性限制。
- 本批定的细节：证明包 `quote.allowed` 暂时恒为 false，审批能力未实现前默认拒绝外发；自测用合成放行函数验证正向卡片消费，不提前新增审批字段。文档查询串沿用 `?v=数字`；资源只匹配原始 pathname，接口方法不补 HEAD。无协议的相对路径从 ASCII 路径首字符识别，避免误删金额单位 `/件`。文档静态文件按登记路径首段选择；尚无页面文件时返回 404。
- 沙箱按链接令牌 / cookie 解析出运行时后再匹配登记；HTML 收尾从请求的 `publicHostRuntime` 取包，不能在 ALS 退出后回落宿主。保留精确路径、同源、令牌、限频检查；隐私页不新增页面包装。
- 新增 `src/site-links.selftest.ts`：逐项核对旅游六行资源清单、旅游不认 quote、核心订单 allowed 的会话与取代限制、证明包登记与有/无标题部件、实际 `web.js` 标题分支、核心白名单删链及保留实质信息、真实沙箱中间件的 cookie 隔离与 GET/HEAD/POST 等方法边界，以及证明包 HTML 响应的 CSP 包装。沙箱数据用哨兵路由证明资源通路，实际报价页与数据仍留后续步骤。
- `web.selftest.ts` 只补独立投影测试前的文件包重新绑定（其前段主动 closeConfig 清除了绑定），原有期望值不改。`eval/cases-v2/q08-fixture.json` 仅给五处精确裁决列表追加新步骤的 pass，模型文字、工具定义、快照与基线未改。新自测只追加到 `package.json` 的 test 末尾，并在 `scripts/ci-weights.json` 登记；分片器自测通过。
- 最终门禁：`pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck`、`pnpm -s test:locked` 全部退出 0。lint 的既有敏感内容黑名单因缺少 `SENSITIVE_PATTERNS` / `.sensitive-patterns` 跳过，依赖边界、迁移、console 和租户状态检查均通过；额外扫描相对 `origin/dev` 的新增行，绝对路径与长假企微 id 均为 0。
- 旅游字节：`LINK BYTES SELFTEST PASS: 317 条字节基准，517 项断言`；`LEGACY BYTES SELFTEST PASS: 140 项断言全通（60 条出口字节与夹具逐字节相同；旅游会话 state json 无 packState、moneyLedger）`。两份夹具均没有 diff；链接夹具 sha256 仍为 `4688c34e5ee02df443f6986ed110af066e5a7fd513a1ee6ea6c33dd8f943f14e`。
- 锁定八文件、`eval/baselines/`、`public/chat.html`、`public/admin.html` 和 spec 的 diff 均为空。`JSON.stringify(toolDefs)` 由锁定套件的请求前缀字节断言与相同 tools 哈希核对，不改工具定义。

```text
PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
CONFIG_SOURCE=file LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
```

- 已按改动文件名和导出能力检索关联自测，逐个以 tsx 执行。下表是最终结果，失败后修复并重跑的网页、沙箱 HTTP / 发送 / 微信全程也已通过；另有上面的锁定套件与两套字节自测。`ci-shard.ts --check 4`：187 units、25 strict suites，CHECK PASS。PGlite 分支全过；相关套件的真实 PG 分支按既有条件跳过，本批不运行真实 PG、真实模型或外部服务。完整 `pnpm test` 按批次任务要求留 CI。

| 自测                                             | 结果     |
| ------------------------------------------------ | -------- |
| `src/site-links.selftest.ts`                     | ✔ 退出 0 |
| `src/web/web.selftest.ts`                        | ✔ 退出 0 |
| `src/adapters/wecom-02.selftest.ts`              | ✔ 退出 0 |
| `src/adapters/wecom-03.selftest.ts`              | ✔ 退出 0 |
| `src/adapters/wecom-outbound-host.selftest.ts`   | ✔ 退出 0 |
| `src/tenancy/sandbox/outbound.selftest.ts`       | ✔ 退出 0 |
| `src/tenancy/sandbox/wecom-outbound.selftest.ts` | ✔ 退出 0 |
| `src/tenancy/sandbox/http.selftest.ts`           | ✔ 退出 0 |
| `src/tenancy/sandbox/pages.selftest.ts`          | ✔ 退出 0 |
| `src/tenancy/sandbox/wechat-e2e.selftest.ts`     | ✔ 退出 0 |
| `src/tenancy/public-routes.selftest.ts`          | ✔ 退出 0 |
| `src/core/guards/shape.selftest.ts`              | ✔ 退出 0 |
| `src/config/pack-runtime.selftest.ts`            | ✔ 退出 0 |
| `src/config/reply-pipeline.selftest.ts`          | ✔ 退出 0 |
| `src/config/brand.selftest.ts`                   | ✔ 退出 0 |
| `src/config/brand-publish.selftest.ts`           | ✔ 退出 0 |
| `src/config/brand-transfer.selftest.ts`          | ✔ 退出 0 |
| `src/config/template-derive.selftest.ts`         | ✔ 退出 0 |
| `src/config/consistency.selftest.ts`             | ✔ 退出 0 |
| `src/packs/packs.selftest.ts`                    | ✔ 退出 0 |
| `src/followup-guards.selftest.ts`                | ✔ 退出 0 |
| `src/packs/travel/shape-words.selftest.ts`       | ✔ 退出 0 |
| `src/packs/travel/turn.selftest.ts`              | ✔ 退出 0 |
| `src/packs/travel/progress.selftest.ts`          | ✔ 退出 0 |
| `src/packs/travel/tools/tools.selftest.ts`       | ✔ 退出 0 |
| `src/core/guards/execute.selftest.ts`            | ✔ 退出 0 |
| `src/core/guards/validate.selftest.ts`           | ✔ 退出 0 |
| `src/core/consistency.selftest.ts`               | ✔ 退出 0 |
| `src/core/guards/money-provenance.selftest.ts`   | ✔ 退出 0 |
| `src/pack-session.selftest.ts`                   | ✔ 退出 0 |
| `src/order-readers.selftest.ts`                  | ✔ 退出 0 |
| `src/config/registry-binding.selftest.ts`        | ✔ 退出 0 |
| `src/ops/board.selftest.ts`                      | ✔ 退出 0 |
| `src/trace/trace.selftest.ts`                    | ✔ 退出 0 |
| `scripts/ci-shard.selftest.ts`                   | ✔ 退出 0 |
| `scripts/check-tenant-state.selftest.ts`         | ✔ 退出 0 |
| `scripts/check-boundaries.selftest.ts`           | ✔ 退出 0 |

### C 批 · 第 4–6 步

- 第 4 步（R1、R2）：`LineOrder` 增加可选 `QuoteApproval`，`createLineOrder` 接受 `approval` 并默认取包的 `quotes.approval`。建单的同步段只调用一次 `autoApprovable`，当场批准写 `auto`、`decidedAt`、`confirmedAt`；复用不重审。待审工具结果严格只有 `{ state: 'pending' }`，自动批准结果严格为 `state` / `quoteUrl` / `totalText`。`money_provenance` 的订单来源只接受无审批或 `approval.state=approved`；试算仍由工具 `amounts` 记账，待审建单不向账本写正式金额。
- 第 5 步（R6）：报价单与无审批单分开复用、取代；待审与有效已批准各保留一个槽。同样的行优先复用有效正式单，其次待审单；新待审单取代旧待审，自动批准新单取代旧待审与旧正式单。过期单不复用，下次建单（包括复用另一张单）时标取代。`quoteState` 将拒绝 / 撤回映为 invalid，paid 与 superseded 优先于过期，过期只推算、不改持久状态；总览待付款只统计无审批单与有效已批准单。
- 第 6 步（R4）：三条旧公开入口对所有带审批的通用单返回 404；console 确认价格返回 `quote_order`，待审收款返回 `not_approved`，无效 / 被取代按状态表拒绝；已批准与过期单在 online、advisor 两种模式都可收款，已付幂等。存储的 `markOrderPaid` 同样拦未批准单。取消入口将报价单写为 withdrawn / cancelled，待审不通知，曾批准的单提交成功后发包的撤回固定句（过期也发），失败记备注；重复取消不重复通知，原因只给顾问。
- 接回第 1 步：证明包 `quote.allowed` 经核心只读辅助函数读取当前租户订单，核对所属会话与 `quoteState=approved`，待审、过期、无效、被取代、已付均不放行。核心 order 卡片同时拒绝报价单，避免旧支付卡片泄露其正式金额；旅游与无审批单的卡片路径保持原状。
- 本批取舍：在证明包导出 `createFixtureQuoteRuntime`，为 09 验收显式装配审批，沿用同一工具定义与参数。08 的原证明场景仍由 `createFixtureRuntime` 建无审批单（原工具显式传 false），不改四个旧证明 case 或任何基线。证明装配有效期为 2 天、合计不超过 1000 分自动批准；没有自动钩子时全部人审。后续证明包收口可复用该装配。
- 本批取舍：有效期按上海固定 UTC+8 的自然日计算，截止日 23:59:59.999 仍有效、下一毫秒过期；有效天数从包对当前已发布政策的 `validDays` 读取，不新增订单字段。将现有 `readFilePolicy` 原样提取到 `config/file-policy.ts`，DB 读已装载政策、文件模式复用原读取，避免同步状态读者反向装载包注册表引起模块循环；没有新增模块状态、环境变量或迁移。
- 本批取舍：为本批已实际写出的 `quote.withdraw` 同步补齐中文审计标签与句子，避免 console 的审计动作穷举检查出现缺项；只补撤回，批准 / 驳回的登记仍在后续步骤。`shared/audit-text.selftest.ts` 新增两项断言，console 的 465 项断言重跑通过。
- 本批取舍：保留旧 `cancelOrder` 同步签名，console 经 `cancelOrderAndNotify` 包装提交与通知；无审批单仍走原取消逻辑及原路由提交。第 7 步新增报价动作时应复用这条撤回路径，勿重复发送。本批不实现批准 / 驳回动作、权限扩展、提醒或报价页，分别留给第 7 步及以后。
- 新增 `src/quote-approval.selftest.ts`：PGlite 持久化 / 预载、真实核心 mock 一轮试算与待审工具保密、金额来源、并发建单复用、两槽取代、自动批准快照、上海跨年边界、过期总览；真实 HTTP 对 online / advisor 各遍历七状态的六入口、错误码、过期撤回通知与重复取消幂等。`package.json` 仅在 test 末尾追加该自测，CI 耗时登记 10 秒。
- 最终门禁：`pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck`、`pnpm -s test:locked` 均退出 0。lint 的既有内容黑名单因未配置 `SENSITIVE_PATTERNS` / `.sensitive-patterns` 跳过，其余边界 / 迁移 / console / 租户状态检查通过；补扫相对 `origin/dev` 的新增行及两个新文件，无本机绝对路径或超长假企微 id，`git diff --check` 通过。
- 旅游硬性对照：两份字节夹具不改，`LINK BYTES SELFTEST PASS: 317 条字节基准，517 项断言`；`LEGACY BYTES SELFTEST PASS: 140 项断言全通（60 条出口字节与夹具逐字节相同；旅游会话 state json 无 packState、moneyLedger）`。锁定八文件、`eval/baselines/`、spec 均零 diff；锁定套件的请求前缀字节断言与 tools 哈希证明 `JSON.stringify(toolDefs)` 不变。链接字节夹具 sha256 仍为 `4688c34e5ee02df443f6986ed110af066e5a7fd513a1ee6ea6c33dd8f943f14e`。

```text
PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
CONFIG_SOURCE=file LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
```

- 验收对照：验收 3 的真实核心 mock 一轮及试算出处已验证；验收 4 的本批建单 / 自动批准 / 收款 / 取消状态部分已验证，工作台批准 / 驳回与并发部分留第 7 步；验收 6 的复用、自动批准取代、自然日边界与过期汇总已验证，手审批准后的取代随第 7 步动作补验。验收 2 的六入口在 online / advisor 下逐个通过；验收 1 的旅游硬性对照见上。本批不宣称验收 4、5 已全量完成。
- 按改动文件名及其符号（建单、订单动作、存储付款、金额工厂、站内链接、总览、政策读取、审计标签）检索关联自测，并逐个执行；下表是最终结果，console 补标签后的重跑也已通过。前端四个自测使用 `tsx --tsconfig console/tsconfig.json`，其余使用普通 tsx。另跑上面的锁定套件、两份字节自测与两种 v2。PGlite 全过，相关套件的真实 PG 分支按既有条件跳过；按本批任务不连真实 PG、不运行真实模型、不启动外部服务，完整 `pnpm test` 留 CI。`ci-shard.ts --check 4`：188 units、25 strict suites，CHECK PASS。

| 自测                                           | 结果     |
| ---------------------------------------------- | -------- |
| `src/quote-approval.selftest.ts`               | ✔ 退出 0 |
| `src/line-order.selftest.ts`                   | ✔ 退出 0 |
| `src/order-view.selftest.ts`                   | ✔ 退出 0 |
| `src/order-readers.selftest.ts`                | ✔ 退出 0 |
| `src/core/guards/money-provenance.selftest.ts` | ✔ 退出 0 |
| `src/money-ledger.selftest.ts`                 | ✔ 退出 0 |
| `src/site-links.selftest.ts`                   | ✔ 退出 0 |
| `src/payment/orders.selftest.ts`               | ✔ 退出 0 |
| `src/payment/refunds.selftest.ts`              | ✔ 退出 0 |
| `src/payment/legacy-pay-poisoned.selftest.ts`  | ✔ 退出 0 |
| `src/ops/board.selftest.ts`                    | ✔ 退出 0 |
| `src/ops/ops.selftest.ts`                      | ✔ 退出 0 |
| `src/store/order-storage.selftest.ts`          | ✔ 退出 0 |
| `src/store/store.selftest.ts`                  | ✔ 退出 0 |
| `src/console-api/console.selftest.ts`          | ✔ 退出 0 |
| `src/web/web.selftest.ts`                      | ✔ 退出 0 |
| `src/jobs/jobs.selftest.ts`                    | ✔ 退出 0 |
| `src/notify/notify.selftest.ts`                | ✔ 退出 0 |
| `src/handoff/handoff.selftest.ts`              | ✔ 退出 0 |
| `src/pack-session.selftest.ts`                 | ✔ 退出 0 |
| `src/pack-catalog.selftest.ts`                 | ✔ 退出 0 |
| `src/after-sales.selftest.ts`                  | ✔ 退出 0 |
| `src/policy-ask.selftest.ts`                   | ✔ 退出 0 |
| `src/packs/travel/tools/tools.selftest.ts`     | ✔ 退出 0 |
| `src/packs/travel/policy.selftest.ts`          | ✔ 退出 0 |
| `src/adapters/wecom-03.selftest.ts`            | ✔ 退出 0 |
| `src/config/config.selftest.ts`                | ✔ 退出 0 |
| `src/config/consistency.selftest.ts`           | ✔ 退出 0 |
| `src/config/file-pack.selftest.ts`             | ✔ 退出 0 |
| `src/config/policy.selftest.ts`                | ✔ 退出 0 |
| `src/config/brand.selftest.ts`                 | ✔ 退出 0 |
| `src/config/brand-publish.selftest.ts`         | ✔ 退出 0 |
| `src/config/brand-transfer.selftest.ts`        | ✔ 退出 0 |
| `src/config/template-derive.selftest.ts`       | ✔ 退出 0 |
| `scripts/check-boundaries.selftest.ts`         | ✔ 退出 0 |
| `scripts/ci-shard.selftest.ts`                 | ✔ 退出 0 |
| `src/shared/audit-text.selftest.ts`            | ✔ 退出 0 |
| `src/channels/restore-cutoff.selftest.ts`      | ✔ 退出 0 |
| `src/channels/channels.selftest.ts`            | ✔ 退出 0 |
| `src/console-api/traces.selftest.ts`           | ✔ 退出 0 |
| `src/db/brand.selftest.ts`                     | ✔ 退出 0 |
| `console/src/overview/overview.selftest.tsx`   | ✔ 退出 0 |
| `console/src/shell/shell.selftest.ts`          | ✔ 退出 0 |
| `console/src/traces/traces.selftest.tsx`       | ✔ 退出 0 |
| `console/src/audit/audit.selftest.tsx`         | ✔ 退出 0 |

### D 批 · 第 7–10 步

- 第 7 步（R3、R5，验收 4、5）：报价动作沿用订单 identity map 的同步条件写入和会话落库队列。批准写审批人与价格确认、取代旧正式单、排审计，提交后核对订单身份、会话订单集合与当前状态再推送；重复批准不发第二条。驳回原因必填且不超过 120 字，取消订单、写审计；未转人工时复用 `takeover` 由驳回人接手（kind=agent），已转人工时只记备注。撤回复用 C 批取消通知路径，待审不通知、已批准含过期通知，原因不对客。
- 第 8 步（R7，验收 4、5）：三个专用接口只接受成员，agent 可操作 AI 接待或自己接手的会话，主管以上不限，viewer/shared 拒绝；确认收款权限不变。三类 `quote.*` 审计均带中文标签及操作者，原 console 路由权限矩阵扩展三个新接口。
- 第 9 步（R5、R8，验收 5、7、8 的工作台部分）：报价单下发独立审批投影与 `can`，工作台待审高亮、状态/权限控制动作，审批弹窗展示窗口提示，原因支持必填/选填。403 禁用、409 自动重取；报价卡和总览在重取时隐藏旧金额、出错可重试、无记录显示原空态。报价单待审进入审核待办，不显示确认价格，过期单不进待付款；旅游分支与文字不改。
- 第 10 步（R8，验收 8）：待审建单排 `quote_pending:<id>`；`recordQuoteAccepted` 在同步段内写首次 `acceptedAt`、排 `quote_accepted:<id>` 并保存同一会话，沿用现有事务。执行体重新读取订单与会话，跳过过时状态，不要求转人工；禁止旧 `order_unconfirmed` 执行体通知报价单。提醒完成后、预载重载后和独立新进程确认后均不新增任务，任务约束故障注入验证时间与任务均回滚。
- 实现取舍：批准通知正文仅相对报价链接，经原适配器生成一张卡片、原账本计 1 次；新增消息字段 `quoteStates` 经现有投影进入 `messages.extra`，记录外发当时的 approved 状态。种子会话不推送，失败只追加备注、不重试。报价群提醒链接打开含报价待办的总览，避免 AI 接待会话被旧 human 筛选隐藏；原通知链接不变。窗口提示按 console 的 text-autospace 规范显示，状态冲突文案局限报价控件，不改通用错误文案表。
- 证明包 `createFixtureQuoteRuntime` 增加驳回固定句，保持原工具定义与 08 装配不变；没有新增表、列、环境变量或模块级租户状态。新增两份请求 schema 按惯例登记为实例静态规则。
- 本批测试：新增 `src/quote-actions.selftest.ts`。七状态逐格覆盖批准 / 驳回 / 撤回 / 收款 / 新单（含自动批准）/ 重置；批准与驳回两种先后各只有一方成功；待审批准及幂等批准等提交期间被撤回 / 重置 / 另一张单批准均返回相应 409，旧链接零推送。6 身份 × 4 接手关系 × 3 动作与实际 HTTP 的 agent=200 / viewer=403、400 原因校验、工作台权限投影、三类审计操作者均通过。真正企微适配器用假 fetch 验证一张带包标题的卡片、账本 1 次、网页带标题部件、消息 `extra` 实际入库；重复与种子零推送、失败有备注，过期撤回仍通知。
- 验收 8：实际建单只排新原因并按订单号去重；两类任务走原认领 / 完成路径，过时任务跳过；非转人工也能收到确认提醒，完成后重复确认不新增任务 / 提醒。内存清空预载与独立新进程读磁盘 PGlite 后再次确认，首次时间与已完成任务均保留，任务仍只有一条。给 jobs 临时加失败约束，确认时间与任务均未提交；真实 PG 的同类 FORCE RLS / 事务失败自测写在 `PG_TEST_URL` 分支，本机按任务约定跳过，交 CI 一次性测试库执行。
- 验收 5、7、8 的界面部分：工作台 **177 项**、总览 **246 项**断言通过，覆盖权限 / 状态按钮、待审高亮、关闭窗口仍可审批且先提示、120 字原因校验、403 禁用、409 重取以及加载隐藏旧金额 / 空态 / 请求失败重试。报价单页与公共数据接口的七状态、截图及重置后 404 仍由第 11 步实现；确定性回复确认触发器留第 12 步调用 `recordQuoteAccepted`，本批没有提前扩展 `DeterministicReply` 或转人工类型。验收 4、5、7、8 的最终全链路收口仍按第 15–16 步核对。
- 最终门禁：`pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck`、`pnpm -s test:locked` 全部退出 0。lint 的既有内容黑名单因未配置 `SENSITIVE_PATTERNS` / `.sensitive-patterns` 跳过，其余边界 / 迁移 / console / 租户状态检查通过；新增行和新文件另查无本机绝对路径或超长假企微 id，`git diff --check` 通过。gitleaks 对 `origin/dev..HEAD` 历史及本批工作区（含新文件）均未发现泄露。
- 旅游硬性对照：两份字节夹具未改；`LINK BYTES SELFTEST PASS: 317 条字节基准，517 项断言`，`LEGACY BYTES SELFTEST PASS: 140 项断言全通（60 条出口字节与夹具逐字节相同；旅游会话 state json 无 packState、moneyLedger）`。锁定八文件、spec、`eval/baselines/`、`public/chat.html` 和 `public/admin.html` 零 diff；前缀锁定断言与相同 tools 哈希确认 `JSON.stringify(toolDefs)` 不变。链接夹具 sha256 仍为 `4688c34e5ee02df443f6986ed110af066e5a7fd513a1ee6ea6c33dd8f943f14e`。

```text
PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
CONFIG_SOURCE=file LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：861/861 用例通过 · 跳过 0 条 realOnly · 8565 项断言
v2 快照比对：861 条 case · 0 处差异
```

- 按改动文件名及符号检索关联自测，下面 **95 个**最终均退出 0。新增能力使四处枚举需同步：报价路由登记进原权限矩阵、提醒中文数量增至 16、AI 记录筛选排除两个报价提醒；全局 ERROR_COPY 保留原表，报价 409 仅在报价控件提示。对应套件修正后已逐个重跑通过，未放宽断言或修改锁定测试。真实 PG 条件分支未跑，完整 `pnpm test` 按本批任务留 CI。
- 补充检查：`check-fonts` 通过，716 个界面汉字与已有字体产物匹配，不需要重建字体；console 构建与 `check-console-dist` 通过，首屏 JS 356,913 B / 上限 420,000 B；`ci-shard.ts --check 4` 为 189 units、25 strict suites，CHECK PASS。构建产物和临时测试日志已清理，不留后台进程或容器。

| 自测                                                   | 最终结果 |
| ------------------------------------------------------ | -------- |
| `console/src/audit/audit.selftest.tsx`                 | ✔ 退出 0 |
| `console/src/conversations/conversations.selftest.tsx` | ✔ 退出 0 |
| `console/src/conversations/pack-cards.selftest.tsx`    | ✔ 退出 0 |
| `console/src/conversations/workbench.selftest.tsx`     | ✔ 退出 0 |
| `console/src/fields/fields.selftest.tsx`               | ✔ 退出 0 |
| `console/src/overview/overview.selftest.tsx`           | ✔ 退出 0 |
| `console/src/pages/login.selftest.tsx`                 | ✔ 退出 0 |
| `console/src/parts/errors.selftest.ts`                 | ✔ 退出 0 |
| `console/src/parts/popupRegion.selftest.tsx`           | ✔ 退出 0 |
| `console/src/session.selftest.ts`                      | ✔ 退出 0 |
| `console/src/shell/shell.selftest.ts`                  | ✔ 退出 0 |
| `console/src/sop/sop.selftest.tsx`                     | ✔ 退出 0 |
| `console/src/traces/traces.selftest.tsx`               | ✔ 退出 0 |
| `scripts/check-boundaries.selftest.ts`                 | ✔ 退出 0 |
| `scripts/check-console-src.selftest.ts`                | ✔ 退出 0 |
| `scripts/check-tenant-state.selftest.ts`               | ✔ 退出 0 |
| `scripts/ci-shard.selftest.ts`                         | ✔ 退出 0 |
| `src/after-sales.selftest.ts`                          | ✔ 退出 0 |
| `src/catalog-money.selftest.ts`                        | ✔ 退出 0 |
| `src/channels/channels.selftest.ts`                    | ✔ 退出 0 |
| `src/channels/recovery.selftest.ts`                    | ✔ 退出 0 |
| `src/channels/restore-cutoff.selftest.ts`              | ✔ 退出 0 |
| `src/config/brand-publish.selftest.ts`                 | ✔ 退出 0 |
| `src/config/brand-transfer.selftest.ts`                | ✔ 退出 0 |
| `src/config/brand.selftest.ts`                         | ✔ 退出 0 |
| `src/config/catalog-kind.selftest.ts`                  | ✔ 退出 0 |
| `src/config/catalog-snapshot.selftest.ts`              | ✔ 退出 0 |
| `src/config/consistency.selftest.ts`                   | ✔ 退出 0 |
| `src/config/file-pack.selftest.ts`                     | ✔ 退出 0 |
| `src/config/gate.selftest.ts`                          | ✔ 退出 0 |
| `src/config/pack-runtime.selftest.ts`                  | ✔ 退出 0 |
| `src/config/registry-binding.selftest.ts`              | ✔ 退出 0 |
| `src/config/retrieval-kb.selftest.ts`                  | ✔ 退出 0 |
| `src/config/sop-per-pack.selftest.ts`                  | ✔ 退出 0 |
| `src/console-api/console.selftest.ts`                  | ✔ 退出 0 |
| `src/console-api/traces.selftest.ts`                   | ✔ 退出 0 |
| `src/core/link-bytes.selftest.ts`                      | ✔ 退出 0 |
| `src/db/brand.selftest.ts`                             | ✔ 退出 0 |
| `src/db/db.selftest.ts`                                | ✔ 退出 0 |
| `src/db/rollback-guard.selftest.ts`                    | ✔ 退出 0 |
| `src/followup-guards.selftest.ts`                      | ✔ 退出 0 |
| `src/handoff/handoff.selftest.ts`                      | ✔ 退出 0 |
| `src/jobs/jobs.selftest.ts`                            | ✔ 退出 0 |
| `src/line-order.selftest.ts`                           | ✔ 退出 0 |
| `src/money-ledger.selftest.ts`                         | ✔ 退出 0 |
| `src/notify/notify.selftest.ts`                        | ✔ 退出 0 |
| `src/ops/ops.selftest.ts`                              | ✔ 退出 0 |
| `src/order-readers.selftest.ts`                        | ✔ 退出 0 |
| `src/order-view.selftest.ts`                           | ✔ 退出 0 |
| `src/pack-catalog.selftest.ts`                         | ✔ 退出 0 |
| `src/pack-session.selftest.ts`                         | ✔ 退出 0 |
| `src/packs/packs.selftest.ts`                          | ✔ 退出 0 |
| `src/packs/travel/claim-words.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/dates.selftest.ts`                   | ✔ 退出 0 |
| `src/packs/travel/policy-ask.selftest.ts`              | ✔ 退出 0 |
| `src/packs/travel/policy-claims.selftest.ts`           | ✔ 退出 0 |
| `src/packs/travel/policy.selftest.ts`                  | ✔ 退出 0 |
| `src/packs/travel/price.selftest.ts`                   | ✔ 退出 0 |
| `src/packs/travel/progress.selftest.ts`                | ✔ 退出 0 |
| `src/packs/travel/quote-template.selftest.ts`          | ✔ 退出 0 |
| `src/packs/travel/refund-words.selftest.ts`            | ✔ 退出 0 |
| `src/packs/travel/reply-notes.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/shape-words.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/state-note.selftest.ts`              | ✔ 退出 0 |
| `src/packs/travel/tools/tools.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/turn.selftest.ts`                    | ✔ 退出 0 |
| `src/payment/legacy-bytes.selftest.ts`                 | ✔ 退出 0 |
| `src/payment/legacy-pay-poisoned.selftest.ts`          | ✔ 退出 0 |
| `src/payment/orders.selftest.ts`                       | ✔ 退出 0 |
| `src/policy-ask.selftest.ts`                           | ✔ 退出 0 |
| `src/price-guard-parse.selftest.ts`                    | ✔ 退出 0 |
| `src/quota/outbound.selftest.ts`                       | ✔ 退出 0 |
| `src/quota/quota.selftest.ts`                          | ✔ 退出 0 |
| `src/quote-actions.selftest.ts`                        | ✔ 退出 0 |
| `src/quote-approval.selftest.ts`                       | ✔ 退出 0 |
| `src/shared/audit-text.selftest.ts`                    | ✔ 退出 0 |
| `src/site-links.selftest.ts`                           | ✔ 退出 0 |
| `src/store/order-storage.selftest.ts`                  | ✔ 退出 0 |
| `src/store/parity.selftest.ts`                         | ✔ 退出 0 |
| `src/store/spill-channel.selftest.ts`                  | ✔ 退出 0 |
| `src/store/store.selftest.ts`                          | ✔ 退出 0 |
| `src/tenancy/events-channels.selftest.ts`              | ✔ 退出 0 |
| `src/tenancy/fixture-tenant.selftest.ts`               | ✔ 退出 0 |
| `src/tenancy/local-state.selftest.ts`                  | ✔ 退出 0 |
| `src/tenancy/public-routes.selftest.ts`                | ✔ 退出 0 |
| `src/tenancy/runtime.selftest.ts`                      | ✔ 退出 0 |
| `src/tenancy/sandbox/budget.selftest.ts`               | ✔ 退出 0 |
| `src/tenancy/sandbox/http.selftest.ts`                 | ✔ 退出 0 |
| `src/tenancy/sandbox/isolation.selftest.ts`            | ✔ 退出 0 |
| `src/tenancy/sandbox/outbound.selftest.ts`             | ✔ 退出 0 |
| `src/tenancy/sandbox/provision.selftest.ts`            | ✔ 退出 0 |
| `src/tenancy/sandbox/refund-seed.selftest.ts`          | ✔ 退出 0 |
| `src/tenancy/seed-fixture.selftest.ts`                 | ✔ 退出 0 |
| `src/trace/trace.selftest.ts`                          | ✔ 退出 0 |
| `src/web/web.selftest.ts`                              | ✔ 退出 0 |

### E 批 · 第 11–14 步

- 第 11 步（R9、R10，验收 7、9）：新增报价单页与限流公开接口，响应只给白名单字段；approved / paid 才含 OrderDisplay，其余不含行与金额，重置与非报价单返回 404。页面和静态入口注入同一品牌槽，og 无金额，没有付款按钮或货币符号；页面脚本使用 textContent，加载 / 空 / 失败 / 重试均不保留旧金额。七种订单状态逐项验证重置后两路 404，数据库审批历史和 reset 标记保留、清空内存重新预载仍不可读；真正沙箱 cookie 可 GET 报价数据，未登记 POST 不获放行。BrandPage 在 B 批已经扩为 string，本批直接使用 quote 槽；notes 是可选项，证明包没有额外说明，不发明新的包接口。
- 第 12 步（R11、R12，验收 10）：扩展四字段，发送前先校验登记固定句或完整模板匹配，再合并校验 packState、记录回复、pack 转人工、调用 recordQuoteAccepted；沿用原渠道回复出口，不另推一条消息。原因限制 1–120 字；缺 fixedId、未登记、文本不符、越界 patch、缺状态 schema 都拒绝。生产环境沿用 DEPLOY_PROFILE=prod，固定句错误只记不含正文的日志后继续发送；不增加环境变量。旅游原有确定性回复无需 fixedId。新增 pack 进入共享校验 / 中文标签 / 既有统计，实际原因仍由包给出，不往 HANDOFF_REASON 写兜底原因。通知自测的类型数同步为 17，种子枚举同步新增类型。
- 第 13 步（R12、R13、R16，验收 11、12）：handoff 谓词可指定 handoffKind；shape 同出口一样读当前包的 ShapePolicy.richTools。工作台批准 / 驳回 / 撤回及批准造成的取代在原同步写入段调用 onQuoteDecided，幂等动作不重复调用，不另发卡片；AI 自动批准 / 取代不调动作钩子。两种跟进共用资格判断接 followupGate，数据库跟进等提交后、真正推送前也复查。证明包批准推进 closing，quote 阶段存在待审单则跳过跟进。
- 第 14 步（R14、R15，验收 13）：证明包具备 ≤100 元且全部现货才自动批准、报价链接 / 卡片 / 固定句 / 两个触发器 / 两个钩子。现货判定优先读订单行版本对应的产品快照，文件模式用本轮捕获目录快照；缺现货声明不自动批准。注册装配保留 08 的 fixture_order，另加 fixture_quote_order 验证报价；包的订单读取经 pack-api 再导出已有的租户内存访问器，避免反向依赖存储或装配期循环；评测的既有种子通用单显式 approval:false，08 语义和全部旧快照均保持不变。AI / 确定性回复 / 两种跟进在保存前登记消息 extra.quoteStates，原批准通知沿用 D 批记录。
- 新增 4 个 v2 case 与 3 个模拟目标；默认快照改为 **eval/baselines/v2-09-step14.json**。用 JSON 解码器定位每条 case 的原始文件片段、按原始字节比较，v2-08-step17.json 的 **861 条全部逐字节相同**，其中旅游 **857 条、0 处差异**；只新增 q09-fixture-nonstandard / pending / no-stock / auto-accepted 四条。旅游原始片段拼接 sha256：`3d009373eaa0b797ed7d831c880d15fefca7fe50a59145c7239b69e7bfc1d813`。旧基线文件未改；新快照因新增证明用例，总数由 861 增为 865。审批时间戳并入原快照时间归一，不影响旧条目。
- 回滚脚本按 tag 文件树 / 目标镜像的 src/core/site-links.ts 判断 pre-09，直接查询全库 orders.data->'approval' IS NOT NULL，不过滤状态或重置历史。有报价以 9 拒绝并明确打印「前滚修复，或者回滚到另一个含 09 的 tag」，无报价本项放行；手动与自动同检，查询失败从严且带时限。宿主 role 健康校验仅对 pre-05 豁免，不能因 pre-09 触发回滚检查就跳过；部署 / DB 自测同步登记新文件树探测。自测 **316 项**通过，真实 SQL 在 PGlite 逐项验待审 / 批准 / 过期 / 已付 / 驳回 / 撤回 / 被取代 / 重置历史，不改表或列。
- 容器演练交第 16 步：在一次性 pgvector/pgvector:pg17 与隔离 compose 项目上，先用含 09 的镜像建合成报价；对待审 / 批准 / 过期 / 已付 / 驳回 / 撤回 / 被取代 / 重置历史分别尝试部署 08 tag，断言 guard 退出 9、deploy 转 1、打印两条恢复路径、rsync 与旧 app 启动均未发生；再模拟健康检查失败回到 08 的 prev 镜像，断言同样拒绝。使用另一份无 approval 的干净测试库验证本项放行，再验含 09 目标不误拦。最后移除本次项目的容器、卷与合成数据；不得碰其他容器或线上库。
- 页面截图待第 16 步补验：本机已有 Playwright，但 Chromium 启动被 macOS 沙箱以 `bootstrap_check_in … Permission denied (1100)` 拒绝，未生成截图，未声称渲染验收通过；实际页面脚本注入、品牌、七态 HTTP、加载 / 空 / 错 / 重试与 stripLink 的锁定断言已有自动化覆盖。真实 PG 分支与完整 pnpm test 按任务约定交 CI，容器回滚演练按本批约定交协调者。
- 最终门禁：format:check、lint、typecheck、test:locked 全部退出 0；完整 pnpm test 按本批约定不在本机执行。lint 的内容黑名单因未配置 SENSITIVE_PATTERNS / .sensitive-patterns 跳过，依赖方向、迁移、console、租户状态检查均通过；另对新增行和新文件检查本机绝对路径与超长假企微 id，均无命中。锁定八文件、spec、旧快照、两份字节夹具、旅游工具定义、chat.html 与 admin.html 零修改；git diff --check 通过。gitleaks 的 origin/dev..HEAD 历史与本批改动文件扫描均无泄露。
- 字节与评测证据：link-bytes **317 条基准、517 项断言**；legacy-bytes **60 条旧出口逐字节相同、140 项断言**。工具摘要继续覆盖 JSON.stringify(toolDefs)，前缀与开工值相同。两种 v2 均为 **865/865、8587 项断言、快照 0 处差异**；原 861 条全部保留且逐字节相同的证据见上。字体检查通过（716 个界面汉字），无需重建字体；CI 分片为 191 units、25 strict suites，CHECK PASS。模拟证明包五目标共 42 项断言、目标闸 42 项断言通过；工作台 177 项、总览 246 项通过。

```text
PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
CONFIG_SOURCE=file LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：865/865 用例通过 · 跳过 0 条 realOnly · 8587 项断言
v2 快照比对：865 条 case · 0 处差异
CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1 tsx eval/run.ts
v2 回归评测：865/865 用例通过 · 跳过 0 条 realOnly · 8587 项断言
v2 快照比对：865 条 case · 0 处差异
```

- 按变动文件名与接口 grep 关联自测，并补跑共享标签消费方，下面 **101 个**最终均退出 0。首次运行发现的五处装配同步项已修正并逐个复测：通知类型数、新回滚文件探测清单、部署替身的 ls-tree 与宿主 role、08 无审批订单显式 approval:false，以及闸的五个证明目标 / 假模型脚本。断言未放宽，未改锁定套件。新增的生产 / 开发固定句行为、完整模板匹配、状态 schema 边界、恰好 100 元与混合现货、自动批准不调用动作钩子、已付历史不触发取代钩子、冻结前记录 quoteStates 也已覆盖。

| 自测                                                   | 最终结果 |
| ------------------------------------------------------ | -------- |
| `console/src/conversations/conversations.selftest.tsx` | ✔ 退出 0 |
| `console/src/conversations/workbench.selftest.tsx`     | ✔ 退出 0 |
| `console/src/fields/fields.selftest.tsx`               | ✔ 退出 0 |
| `console/src/overview/overview.selftest.tsx`           | ✔ 退出 0 |
| `console/src/parts/errors.selftest.ts`                 | ✔ 退出 0 |
| `console/src/traces/traces.selftest.tsx`               | ✔ 退出 0 |
| `eval/sim/fixture.selftest.ts`                         | ✔ 退出 0 |
| `eval/sim/predicates.selftest.ts`                      | ✔ 退出 0 |
| `eval/v2/runner.selftest.ts`                           | ✔ 退出 0 |
| `scripts/check-boundaries.selftest.ts`                 | ✔ 退出 0 |
| `scripts/check-console-src.selftest.ts`                | ✔ 退出 0 |
| `scripts/check-fonts.ts`                               | ✔ 退出 0 |
| `scripts/ci-shard.selftest.ts`                         | ✔ 退出 0 |
| `scripts/seed-demo.selftest.ts`                        | ✔ 退出 0 |
| `src/after-sales.selftest.ts`                          | ✔ 退出 0 |
| `src/catalog-money.selftest.ts`                        | ✔ 退出 0 |
| `src/channels/recovery.selftest.ts`                    | ✔ 退出 0 |
| `src/config/brand-publish.selftest.ts`                 | ✔ 退出 0 |
| `src/config/brand-transfer.selftest.ts`                | ✔ 退出 0 |
| `src/config/brand.selftest.ts`                         | ✔ 退出 0 |
| `src/config/catalog-kind.selftest.ts`                  | ✔ 退出 0 |
| `src/config/catalog-snapshot.selftest.ts`              | ✔ 退出 0 |
| `src/config/config.selftest.ts`                        | ✔ 退出 0 |
| `src/config/consistency.selftest.ts`                   | ✔ 退出 0 |
| `src/config/file-pack.selftest.ts`                     | ✔ 退出 0 |
| `src/config/gate-per-pack.selftest.ts`                 | ✔ 退出 0 |
| `src/config/pack-runtime.selftest.ts`                  | ✔ 退出 0 |
| `src/config/registry-binding.selftest.ts`              | ✔ 退出 0 |
| `src/config/reply-pipeline.selftest.ts`                | ✔ 退出 0 |
| `src/config/retrieval-kb.selftest.ts`                  | ✔ 退出 0 |
| `src/config/sop-per-pack.selftest.ts`                  | ✔ 退出 0 |
| `src/console-api/console.selftest.ts`                  | ✔ 退出 0 |
| `src/console-api/traces.selftest.ts`                   | ✔ 退出 0 |
| `src/core/guards/execute.selftest.ts`                  | ✔ 退出 0 |
| `src/core/guards/money-provenance.selftest.ts`         | ✔ 退出 0 |
| `src/core/guards/shape.selftest.ts`                    | ✔ 退出 0 |
| `src/core/guards/validate.selftest.ts`                 | ✔ 退出 0 |
| `src/core/link-bytes.selftest.ts`                      | ✔ 退出 0 |
| `src/core/llm/client.selftest.ts`                      | ✔ 退出 0 |
| `src/core/parse/date-count.selftest.ts`                | ✔ 退出 0 |
| `src/core/parse/money-decimals.selftest.ts`            | ✔ 退出 0 |
| `src/core/refund.selftest.ts`                          | ✔ 退出 0 |
| `src/core/tools/registry.selftest.ts`                  | ✔ 退出 0 |
| `src/db/brand.selftest.ts`                             | ✔ 退出 0 |
| `src/db/db.selftest.ts`                                | ✔ 退出 0 |
| `src/db/rollback-guard.selftest.ts`                    | ✔ 退出 0 |
| `src/followup-guards.selftest.ts`                      | ✔ 退出 0 |
| `src/handoff/handoff.selftest.ts`                      | ✔ 退出 0 |
| `src/jobs/jobs.selftest.ts`                            | ✔ 退出 0 |
| `src/line-order.selftest.ts`                           | ✔ 退出 0 |
| `src/money-ledger.selftest.ts`                         | ✔ 退出 0 |
| `src/notify/notify.selftest.ts`                        | ✔ 退出 0 |
| `src/ops/ops.selftest.ts`                              | ✔ 退出 0 |
| `src/order-readers.selftest.ts`                        | ✔ 退出 0 |
| `src/order-view.selftest.ts`                           | ✔ 退出 0 |
| `src/pack-catalog.selftest.ts`                         | ✔ 退出 0 |
| `src/pack-session.selftest.ts`                         | ✔ 退出 0 |
| `src/packs/packs.selftest.ts`                          | ✔ 退出 0 |
| `src/packs/travel/claim-words.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/dates.selftest.ts`                   | ✔ 退出 0 |
| `src/packs/travel/policy-ask.selftest.ts`              | ✔ 退出 0 |
| `src/packs/travel/policy-claims.selftest.ts`           | ✔ 退出 0 |
| `src/packs/travel/policy.selftest.ts`                  | ✔ 退出 0 |
| `src/packs/travel/price.selftest.ts`                   | ✔ 退出 0 |
| `src/packs/travel/progress.selftest.ts`                | ✔ 退出 0 |
| `src/packs/travel/quote-template.selftest.ts`          | ✔ 退出 0 |
| `src/packs/travel/refund-words.selftest.ts`            | ✔ 退出 0 |
| `src/packs/travel/reply-notes.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/shape-words.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/state-note.selftest.ts`              | ✔ 退出 0 |
| `src/packs/travel/tools/tools.selftest.ts`             | ✔ 退出 0 |
| `src/packs/travel/turn.selftest.ts`                    | ✔ 退出 0 |
| `src/payment/legacy-bytes.selftest.ts`                 | ✔ 退出 0 |
| `src/payment/legacy-pay-poisoned.selftest.ts`          | ✔ 退出 0 |
| `src/payment/orders.selftest.ts`                       | ✔ 退出 0 |
| `src/policy-ask.selftest.ts`                           | ✔ 退出 0 |
| `src/price-guard-parse.selftest.ts`                    | ✔ 退出 0 |
| `src/quota/outbound.selftest.ts`                       | ✔ 退出 0 |
| `src/quota/quota.selftest.ts`                          | ✔ 退出 0 |
| `src/quote-actions.selftest.ts`                        | ✔ 退出 0 |
| `src/quote-approval.selftest.ts`                       | ✔ 退出 0 |
| `src/quote-page.selftest.ts`                           | ✔ 退出 0 |
| `src/quote-replies.selftest.ts`                        | ✔ 退出 0 |
| `src/site-links.selftest.ts`                           | ✔ 退出 0 |
| `src/store/order-storage.selftest.ts`                  | ✔ 退出 0 |
| `src/store/parity.selftest.ts`                         | ✔ 退出 0 |
| `src/store/spill-channel.selftest.ts`                  | ✔ 退出 0 |
| `src/store/store.selftest.ts`                          | ✔ 退出 0 |
| `src/tenancy/fixture-tenant.selftest.ts`               | ✔ 退出 0 |
| `src/tenancy/local-state.selftest.ts`                  | ✔ 退出 0 |
| `src/tenancy/public-routes.selftest.ts`                | ✔ 退出 0 |
| `src/tenancy/runtime.selftest.ts`                      | ✔ 退出 0 |
| `src/tenancy/sandbox/budget.selftest.ts`               | ✔ 退出 0 |
| `src/tenancy/sandbox/http.selftest.ts`                 | ✔ 退出 0 |
| `src/tenancy/sandbox/pages.selftest.ts`                | ✔ 退出 0 |
| `src/tenancy/sandbox/provision.selftest.ts`            | ✔ 退出 0 |
| `src/tenancy/sandbox/reaper.selftest.ts`               | ✔ 退出 0 |
| `src/tenancy/sandbox/refund-seed.selftest.ts`          | ✔ 退出 0 |
| `src/tenancy/seed-fixture.selftest.ts`                 | ✔ 退出 0 |
| `src/trace/trace.selftest.ts`                          | ✔ 退出 0 |
| `src/web/web.selftest.ts`                              | ✔ 退出 0 |

## 验收记录

### 联合上线与终验（2026-10-27，第 15–17 步，协调者）

- **上线（第 15 步后半）**：09 与 10 一起上线，owner 两次当次授权：`demo-v10-rc1`（07:31）与 `demo-v10-rc2`（10:21）。每次部署前都另存凌晨备份、手动备份并复制异地，只读核对后从 dev 打本地 tag（不推）、`TZ=UTC bash deploy.sh`。上线后宿主与沙箱 revision、健康、四哈希（`cf3b163c9f69 / 59e071568f5d / 6630127f79d7 / 1f850038290b`）不变，21 个迁移，日志无 error；旅游页面字节与企微、网页冒烟见 10 plan「联合上线与终验」。线上不设 `PACK_FIXTURES`，没有证明包租户。
- **线上报价流程**：用工业演示租户在网页渠道走完「询价 → 待审 → 工作台批准 → 收到报价单 → 确认」，并验复用与跨 Host 隔离，逐步结果见 10 plan 同节。

| 09 验收          | 结论                        | 证据                                                                                                                                                |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 旅游不变       | 通过                        | 两次上线四哈希不变；rc2 旅游 12 个路径与 rc1 逐字节对比；rc1 旅游网页与企微一问一答；两配置 v2、link-bytes、legacy-bytes                            |
| 2 六入口         | 通过                        | 本机 `quote-approval` 七态与两种付款模式；线上工业单的 `/pay.html?orderId=`、两个 Host 的 `/api/orders/` 均 404。线上没有点确认收款，不动演示单状态 |
| 3 试算与正式     | 通过                        | 线上待审回复没有金额、单号与链接                                                                                                                    |
| 4 状态表         | 通过                        | `quote-actions` 状态表与并发；CI 真实 PG 分支随 dev CI 绿                                                                                           |
| 5 批准与驳回     | 通过                        | 线上批准、`quote.approve` 审计、客户只收到一张卡片；驳回、撤回与权限由自测覆盖                                                                      |
| 6 复用取代过期   | 通过                        | 线上重发返回原链接、不新建单；取代与自然日过期由自测覆盖                                                                                            |
| 7 报价单页       | 通过                        | 10-26 八张截图；线上已批准页为工业品牌与报价说明，没有「¥」与付款按钮                                                                               |
| 8 提醒与总览     | 通过（通知送达待 owner 看） | 线上总览显示待审 1 项；`quote_pending`、`quote_accepted` 两个通知任务 done                                                                          |
| 9 链接登记       | 通过（有发现）              | 卡片按租户 Host 生成，旅游 Host 下该单 404；链接显示问题见 10 plan 发现 1                                                                           |
| 10 确定性与 pack | 通过                        | 线上客户确认的固定回复                                                                                                                              |
| 11 评测          | 通过                        | 两配置 v2 900/900，模拟谓词与夹具自测                                                                                                               |
| 12 两钩子        | 通过                        | 线上批准后会话阶段推进到「促成」；待审跳过跟进由自测覆盖                                                                                            |
| 13 回滚          | 通过                        | 10-26 pre-09 容器演练 9 / 0；10-27 容器演练场景 G（只有审批单）pre-09 为 9                                                                          |

- **清理（第 17 步）**：与 10 第 19 步一起做，见 10 plan 同节。

### 中期验收（第 15 步前半，2026-10-26）

- 验收对象：`c8cf3ed`，第 0–14 步已提交；本轮仅改本文件的验收记录与交接。spec 保持 ready，第 15 步不打勾。不改产品代码、自测、锁定八文件或任何基线，不提交、不 push、不开 PR。
- 边界：仅进程内请求和 localhost:3290；所有模型调用均为 mock。没有读取部署配置、密钥文件，没有真实 SSH、服务器操作、Docker 或浏览器操作。回滚自测里的 ssh/docker 是隔离目录中的替身，配置为自测自己生成的合成内容。
- **回滚演练（协调者补，2026-10-26，本机一次性容器）**：compose 项目 `wecom-09-acc`（只有 `db`，`pgvector/pgvector:pg17`），用 `createRealPgFixture` 建库并跑完 21 个迁移；macOS 无 `timeout`，演练用 perl 的同名替身。插入合成报价单（已付 + 已驳回，均为终态）后 `bash deploy/rollback-guard.sh <部署目录> pre-09 wecom-09-acc` **退出 9**，打印「拒绝回滚：目标是 09 之前的镜像……」与「前滚修复，或者回滚到另一个含 09 的 tag」；删掉后同命令**退出 0**；空库同样退出 0。`git ls-tree demo-v9 src/core/site-links.ts` 为空（判为 pre-09），当前 HEAD 有该文件（不误拦）。deploy.sh 串联与自动回滚路径由 rollback-guard 自测 316 项（替身）覆盖。容器、卷、网络已删。
- **截图（协调者补，2026-10-26）**：照下方命令在 3290 起服务（`env -i`，不读 `.env`），内置浏览器逐张打开 8 个 URL：1 待审只有状态；2 已批准有效显示行、有效期与「合计 1,250元」；3 已过期、4 已驳回与 5 已撤回（失效）、6 被取代均无行与金额；7 已付显示行与合计；8 显示「报价单不存在」且页面与接口均 404。八张都没有「¥」与付款按钮；接口状态依次为 pending / approved / expired / invalid / invalid / superseded / paid / 404。截图未入库。服务已停。

#### 1. 回滚步骤核对与 E 批演练补充

E 批原步骤的判断与代码一致：手动根据 tag 文件树缺少 `src/core/site-links.ts` 传 `pre-09`，自动根据 prev 镜像文件探测；guard 有审批订单退出 9，deploy 接住后退出 1，打印「前滚修复，或者回滚到另一个含 09 的 tag」。无审批订单本项放行；含 09 的目标不查本项。SQL 不过滤订单状态或重置标记。`src/db/rollback-guard.selftest.ts` 本次 **316 项通过**，包含两入口、SQL 八种历史、查询故障与超时，但 Docker/SSH 为替身、SQL 为 PGlite，真实容器演练未完成。

原步骤缺少直接可执行的命令、数据库选择、macOS 的 timeout 前提和两层退出码，补充如下。此段放在验收记录，保留 E 批原实施记录。协调者须使用本机已有镜像，不拉取外部镜像；镜像探测与完整 app 演练另由协调者记录。

先在仓库根目录的独立 shell 准备一次性真实库。只创建本次项目，无映射端口；不使用仓库原 compose 或已有 env 文件：

```sh
roll_run="$PWD/var/09-acc/rollback"
roll_project=wecom-09-acc-rollback
mkdir -p "$roll_run/docker-config" "$roll_run/bin"
export DOCKER_CONFIG="$roll_run/docker-config"
unset DOCKER_HOST DOCKER_CONTEXT
# 要求默认本机 Docker socket 可用；若本机需其他 socket，先由协调者核实，不能切远程 context。
# 脚本内部用 GNU timeout；macOS 需已有 gtimeout，没有就先停止此演练。
if ! command -v timeout >/dev/null; then
  roll_timeout=$(command -v gtimeout) || exit 1
  ln -s "$roll_timeout" "$roll_run/bin/timeout"
  export PATH="$roll_run/bin:$PATH"
fi
cat > "$roll_run/compose.yml" <<'YAML'
services:
  db:
    image: pgvector/pgvector:pg17
    pull_policy: never
    container_name: wecom-09-acc-db
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
      POSTGRES_DB: agent
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
YAML
roll_compose() { docker compose -p "$roll_project" -f "$roll_run/compose.yml" "$@"; }
roll_cleanup() { perl -e 'alarm 60; exec @ARGV' docker compose -p "$roll_project" -f "$roll_run/compose.yml" down -v --remove-orphans; }
trap roll_cleanup EXIT INT TERM
perl -e 'alarm 60; exec @ARGV' docker compose -p "$roll_project" -f "$roll_run/compose.yml" up -d db
# 至多等 30 秒，未 ready 就退出，由 trap 清理。
roll_ready=0
for roll_i in $(seq 1 30); do
  if perl -e 'alarm 3; exec @ARGV' docker exec wecom-09-acc-db pg_isready -U postgres -d agent; then
    roll_ready=1
    break
  fi
  sleep 1
done
[ "$roll_ready" = 1 ] || exit 1
roll_sql() { perl -e 'alarm 12; exec @ARGV' docker exec -i wecom-09-acc-db psql -U postgres -d agent -v ON_ERROR_STOP=1 "$@"; }
# 最小表专用于 guard 的真实 SQL，不冒充迁移/RLS/app 端到端验收。
roll_sql -c 'CREATE TABLE orders (status text, data jsonb, void_reason text);'
for roll_state in pending approved expired paid rejected withdrawn superseded reset; do
  roll_approval=approved
  roll_status=pending_payment
  roll_reason=NULL
  roll_decided=1792972800000
  case "$roll_state" in
    pending) roll_approval=pending ;;
    expired) roll_decided=0 ;;
    paid) roll_status=paid ;;
    rejected|withdrawn) roll_approval="$roll_state"; roll_status=cancelled ;;
    superseded) roll_status=superseded ;;
    reset) roll_reason="'reset'" ;;
  esac
  roll_sql -c "TRUNCATE orders; INSERT INTO orders VALUES ('$roll_status', jsonb_build_object('approval', jsonb_build_object('state', '$roll_approval', 'decidedAt', $roll_decided)), $roll_reason);" || exit 1
  perl -e 'alarm 120; exec @ARGV' bash deploy/rollback-guard.sh "$roll_run" pre-09 "$roll_project" 3291 > "$roll_run/$roll_state.log" 2>&1
  roll_rc=$?
  [ "$roll_rc" = 9 ] || exit 1
  rg -q '前滚修复，或者回滚到另一个含 09 的 tag' "$roll_run/$roll_state.log" || exit 1
  printf '%s guard=%s\n' "$roll_state" "$roll_rc"
done
roll_sql -c "TRUNCATE orders; INSERT INTO orders VALUES ('paid', '{}', NULL);" || exit 1
perl -e 'alarm 120; exec @ARGV' bash deploy/rollback-guard.sh "$roll_run" pre-09 "$roll_project" 3291 > "$roll_run/no-approval.log" 2>&1
roll_rc=$?
[ "$roll_rc" = 0 ] || exit 1
printf 'no-approval guard=%s\n' "$roll_rc"
# shell 退出即清理本次容器和卷，保留日志；不要执行全机 prune。
```

以上是 guard 的真库补验命令。完整 E 批演练还须补：

- 用本机已构建的 08、09 镜像与隔离 compose（名称统一 `wecom-09-acc-`，合成配置、mock 模型）覆盖实际目标镜像参数。镜像探测内部 `docker run --rm` 默认未指定名字，演练环境应通过临时命令包装给每次探测加此前缀，退出后核对清理。新库用完整迁移与证明包装配创建合成订单，不能拿上面的最小表声称 app 端到端通过。
- 自动路径须确实走「新 app 健康失败 → prev 为 08 → guard=9 → deploy=1」，并保存旧 app 未启动、未打 current tag 的日志。`bash deploy.sh <tag>` 自身会读部署配置并调用 SSH，本任务禁止直接运行；协调者需在隔离副本中使用只转发到本机 compose 的传输替身，或沿用既有自测核对编排，再补真实库/镜像 guard 结果。不能把单独 guard 的镜像参数检查写成已完成自动部署演练。
- 本次编排自测的等价复跑命令（实际以子进程 timeout=240 秒运行）：`perl -e 'alarm 240; exec @ARGV' pnpm exec tsx src/db/rollback-guard.selftest.ts`，预期退出 0、`PASS rollback brand/sandbox/nontravel：316 项`；它同时断言手动拒绝在 rsync 前、自动拒绝未启动旧 app。完整真容器日志仍由协调者补，验收 13 暂不通过。

#### 2. 报价单页 HTTP 与截图数据

仿照 `src/quote-page.selftest.ts`，使用文件配置、证明包、合成订单和 `app.request` 逐项请求页面/API，并以 node:vm 执行**请求返回的页面脚本**，把 API 响应接给 fetch，断言实际状态文字与明细显隐；没有使用浏览器替代品声称截图完成。八个 HTML 的两个 og 标签均不含金额，HTML 及渲染文字无「¥」，唯一按钮为「重试」，无付款链接/按钮。

| 订单情况   | 固定订单号末位（其余 23 位为 0） | 页 / API  | PublicQuote.state | 页面脚本文字   | 明细 / 金额          | og 无金额 / HTML 无「¥」/ 无付款按钮 |
| ---------- | -------------------------------- | --------- | ----------------- | -------------- | -------------------- | ------------------------------------ |
| 待审       | 1                                | 200 / 200 | pending           | 报价单待审核   | 无                   | 通过 / 通过 / 通过                   |
| 已批准有效 | 2                                | 200 / 200 | approved          | 报价单已批准   | 有；上海自然日有效期 | 通过 / 通过 / 通过                   |
| 已批准过期 | 3                                | 200 / 200 | expired           | 报价单已过期   | 无                   | 通过 / 通过 / 通过                   |
| 已驳回     | 4                                | 200 / 200 | invalid           | 报价单已失效   | 无                   | 通过 / 通过 / 通过                   |
| 已撤回     | 5                                | 200 / 200 | invalid           | 报价单已失效   | 无                   | 通过 / 通过 / 通过                   |
| 被取代     | 6                                | 200 / 200 | superseded        | 报价单已被取代 | 无                   | 通过 / 通过 / 通过                   |
| 已付       | 7                                | 200 / 200 | paid              | 已收款         | 有                   | 通过 / 通过 / 通过                   |
| 不存在     | 8                                | 404 / 404 | 无                | 报价单不存在   | 无                   | 通过 / 通过 / 通过                   |

- `src/quote-page.selftest.ts`：`QUOTE PAGE PASS`，七态 DB 重置后页/API 全 404，审批历史不变、void_reason=reset、重新预载仍无记录；品牌转义、cookie GET 与未登记 POST、加载/空/错/重试通过。
- 另在独立的文件数据副本对七态逐一调用 `handleMessage(..., '重置', 'web')`：每态均 `FILE RESET PASS ... page=404 api=404 memory=deleted disk=deleted`，内存与 orders.json 均删除。截图数据没有被重置。
- 截图资料在已忽略的 `var/09-acc/`：`config/` 为证明包配置副本（pack.json 指定 __fixture，含品牌、SOP、合成 widget 产品库），`data/sessions.json` 和 `data/orders.json` 含七态订单；第八个号码故意不存订单，表示 404。日志在 `logs/`，逐态机器可读结果在 `http-results.json`。文件模式只有宿主运行时的包绑定，不伪称创建了数据库租户。
- 服务实启证据：`/healthz` 为 `ok=true, revision=dev, role=host`；localhost:3290 的 16 个真实 HTTP 请求均为上表状态；SIGTERM 后退出 143。截图仍为「协调者补」。

协调者从仓库根目录起服务（不加载任何现有 env；本工作区没有 .env，换目录前也先核实不存在）：

```sh
[ ! -e .env ] || { echo '此截图命令不允许读取现有 .env'; exit 1; }
env -i PATH="$PATH" PACK_FIXTURES=1 LLM_MOCK=1 CONFIG_SOURCE=file SESSION_STORE=file \
  DEPLOY_PROFILE=demo PORT=3290 PUBLIC_BASE_URL=http://localhost:3290 \
  SOP_PATH="$PWD/var/09-acc/config/sop.md" VAR_DIR="$PWD/var/09-acc/data" \
  perl -e 'alarm 600; exec @ARGV' node --import tsx src/server.ts
```

前台运行，截图完成用 Ctrl-C 停止，最迟 600 秒结束。已批准样例使用生成时的批准时间，证明包有效期两自然日；超过截止日须重新准备有效样例，不把已过期的第 2 张算作有效截图。八个 URL（API 为同一订单号的 `/api/quotes/` 路径）：

```text
http://localhost:3290/quote/ord_000000000000000000000001
http://localhost:3290/quote/ord_000000000000000000000002
http://localhost:3290/quote/ord_000000000000000000000003
http://localhost:3290/quote/ord_000000000000000000000004
http://localhost:3290/quote/ord_000000000000000000000005
http://localhost:3290/quote/ord_000000000000000000000006
http://localhost:3290/quote/ord_000000000000000000000007
http://localhost:3290/quote/ord_000000000000000000000008
```

#### 3. 验收 1–13 对照

「通过」仅指本次本机自动化已验证的契约；群通知/企微卡片使用 mock transport/fetch，不声称真实客户收到。CI 列是仓库定义的套件归属，本次没有访问远端 CI 或声称当前 CI 绿。真实 PG 分支按任务约定留 CI 的一次性 pgvector:pg17 服务。

| 验收            | 结论   | 本次证据与剩余项                                                                                                                                                                                                               | CI 套件归属                                                   |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 1 旅游不变      | 待线上 | 锁定八文件对 origin/dev 零 diff；PREFIX 两哈希与开工一致；link-bytes 317 条/517 项、legacy-bytes 60 条/140 项；两模式 v2 各 865/865、当前快照 0 差异，另对旧基线各 861 条 0 差异。线上四哈希、企微与网页一句一回待授权上线后验 | test:locked、两种 eval/run、两套 bytes；gates + test 1–4      |
| 2 六入口        | 通过   | quote-approval 的 `QUOTE ENTRIES PASS`：online/advisor × 七态，三公开入口 404，confirm=409 quote_order、mark-paid=409 not_approved，批准后收款与取消各态正确                                                                   | quote-approval，test 1                                        |
| 3 试算与正式    | 通过   | `QUOTE DATA PASS`：试算账本、正式金额隔离、待审工具结果仅 state；mock 对话不外泄报价链接                                                                                                                                       | quote-approval，test 1；两种 v2                               |
| 4 状态表        | 通过   | quote-actions 的 `QUOTE MATRIX PASS`、`QUOTE CONCURRENCY PASS`：七态×六动作、批准/驳回两先后、提交期间撤回/重置/另一单批准均零错误推送                                                                                         | quote-actions，test 3                                         |
| 5 批准与驳回    | 通过   | `QUOTE PERMISSIONS PASS` 6 身份×4 关系×3 动作；`QUOTE HTTP/AUDIT PASS` agent=200/viewer=403、空/过长原因拒绝；`QUOTE DELIVERY PASS` 单卡/账本1/extra/重复零推送/失败备注，过期撤回仍通知；真实企微调用由 mock fetch 接住       | quote-actions，test 3                                         |
| 6 复用取代过期  | 通过   | `QUOTE DATA PASS` 并发复用、待审/已批两槽、取代与上海跨年秒边界；总览过期排除                                                                                                                                                  | quote-approval，test 1；quote-actions，test 3                 |
| 7 报价单页      | 通过   | HTTP 八情况与四项检查通过；quote-page 验 DB 全态重置404/历史/重载/页面三态，本轮补文件全态删除；workbench 177 项、overview 246 项通过。**缺八张真实浏览器截图，协调者补**                                                      | quote-page，test 1；workbench，test 4；overview，test 3       |
| 8 提醒总览      | 通过   | `QUOTE NOTIFY PASS` 去重、两类文案、无旧原因、非转人工确认；`QUOTE ATOMIC PASS` 注入 jobs 事务失败全部回滚；`QUOTE PROCESS RESTART PASS` 独立进程再次确认仍一任务；overview 246 项                                             | quote-actions、overview，test 3；真实 PG 分支留 CI            |
| 9 链接登记      | 通过   | `SITE LINKS SELFTEST PASS` 租户隔离、标题、删链/孤立引导语、cookie/显式方法；public-routes、sandbox/pages、sandbox/outbound、锁定 wecom 与 link-bytes 全过；报价 API 的 cookie GET/POST 拒绝由 quote-page 实验覆盖             | site-links，test 3；quote-page，test 1；sandbox 与锁定 suites |
| 10 确定性与pack | 通过   | `QUOTE REPLIES PASS` 固定句/模板全文、schema 拒绝、pack 转人工与统计、确认去重；未登记/文本不符在测试环境抛错                                                                                                                  | quote-replies，test 2                                         |
| 11 评测         | 通过   | quote-replies 验 handoffKind 与包 richTools；sim/predicates 73 项、sim/fixture 42 项；两种 v2 旅游结论不变                                                                                                                     | quote-replies，test 2；sim/predicates、sim/fixture、两种 v2   |
| 12 两钩子       | 通过   | `QUOTE REPLIES PASS` 动作钩子幂等、批准推进 closing、注入时钟的待审跳过跟进；自动批准不误调用动作钩子                                                                                                                          | quote-replies，test 2                                         |
| 13 回滚         | 通过   | rollback-guard 316 项通过，覆盖八种历史SQL、guard=9/deploy=1、无单放行与手动/自动同检。**真实容器与完整隔离编排日志，协调者补**；命令与退出码补充见第1项                                                                       | rollback-guard 普通 test 4 + strict test 1                    |

本轮命令均带外层 alarm 或子进程 timeout；15 个关联自测全部退出 0：`src/quote-{approval,actions,page,replies}.selftest.ts`、`src/site-links.selftest.ts`、`src/db/rollback-guard.selftest.ts`、`src/tenancy/public-routes.selftest.ts`、`src/tenancy/sandbox/{pages,outbound}.selftest.ts`、`eval/sim/{fixture,predicates}.selftest.ts`、`console/src/conversations/workbench.selftest.tsx`、`console/src/overview/overview.selftest.tsx`、`src/core/link-bytes.selftest.ts`、`src/payment/legacy-bytes.selftest.ts`。命令为 `node --import tsx <文件>` 或 `pnpm exec tsx <文件>`，console 加 `--tsconfig console/tsconfig.json`，两套 bytes 加 `PARITY_CLOCK_MS=1790913600000` 和 `--import ./src/store/parity-clock.ts`。逐套日志与退出码存 `var/09-acc/logs/`，不提交。

质量门与基准：

- ✔ `pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck`、`pnpm -s test:locked` 均退出 0；完整 `pnpm test` 按本次任务约定不在本机执行，交 CI。lint 提示未配置内容黑名单而跳过该子项；依赖方向、迁移、console、租户状态均通过。
- ✔ `CONFIG_SOURCE=file LLM_MOCK=1 pnpm exec tsx eval/run.ts` 与加 `CONFIG_TEST_DB=pglite` 的同命令均退出 0，均 865/865、8587 项断言，`v2 快照比对：865 条 case · 0 处差异`。
- ✔ 另加 `EVAL_V2_BASELINE=eval/baselines/v2-08-step17.json`，用 `node --import tsx eval/run.ts` 重跑文件/PGlite两模式，均退出 0；新增四 case 仍验自身断言。输出分别如下，未伪造旧用例总数：

```text
文件：v2 回归评测：865/865 用例通过 · 跳过 0 条 realOnly · 8587 项断言
v2 快照比对：861 条 case · 0 处差异
PGlite：v2 回归评测：865/865 用例通过 · 跳过 0 条 realOnly · 8587 项断言
v2 快照比对：861 条 case · 0 处差异
PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
```

- ✔ 用 JSON 原始片段对比两份基线：旧 861 条全部逐字节一致，新增四条均为 q09-fixture；旅游 857 条原始片段 sha256 仍为 `3d009373eaa0b797ed7d831c880d15fefca7fe50a59145c7239b69e7bfc1d813`。基线文件未写。
- ✔ `node --import tsx scripts/ci-shard.ts --check 4`：`CHECK PASS: 191 units, 25 strict suites`；完整链归属没有漏套件。本次未运行 CI、真实 PG 或真实模型。
- ✔ 锁定八文件零 diff；本次仅 plan 的两个允许区域有受控改动；新增行无本机绝对路径或超长假企微 id，`git diff --check` 通过。

发现的缺陷：未发现产品缺陷。演练文档缺口的现象为 E 批只有叙述、不能直接复制执行；复现为按原段落找启动命令、库名及 guard/deploy 退出码无明示；位置在本文件 E 批回滚段，本轮仅在允许的验收记录补命令与限制。截图与真实演练是未完成验收项，不把替身自测写成已完成。

清理：未创建容器、浏览器或后台模型任务；3290 服务已 SIGTERM 并 wait 确认退出，测试子进程均完成。删除本轮临时探针、文件重置副本，仅保留 gitignored 的截图配置/数据、HTTP 结果与验收日志给协调者；不提交这些资料。需要确认的问题：无。

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

### 交接（2026-10-26，第 0 步基准）

- 已完成：只改文档的核实、17 项接口 / 消费方 / 六入口 / 库约束复核、317 条新字节基准、60 条旧出口基准、锁定套件与文件 / PGlite 两种 v2 回归；完整哈希和变异证据见「第 0 步 · 开工基准」。产品代码和八个锁定文件未改。
- 当前状态：五个交付文件的未提交 diff（新自测、夹具、package.json、CI 耗时登记、此 plan）；没有功能实现半成品，不提交、不 push、不开 PR，spec 保持 ready。测试副本已清理，未启动外部服务、真实模型或容器。
- 阻塞：无。Docker 检查由协调者在本机补验通过，第 0 步已勾选。
- 下一步：第 1 步，改链接登记时逐项保持本次卡片 / 部件 / 沙箱资源基准。不要重生成夹具来迁就差异。

### 交接（2026-10-26，B 批）

- 第 1–3 步实现与本批验收测试已完成，门禁、两种 v2 及旅游字节基准均通过；改动留工作区，不提交、不推送、不开 PR。spec 与字节夹具、锁定文件未修改。
- 无功能半成品与阻塞；未启动容器、浏览器或外部服务，测试进程均已退出，临时测试脚本和日志在交接前删除。
- 下一步为第 4 步：实现审批数据与建单选项后，将证明包 `quote.allowed` 的默认拒绝换成 R10 的已批准且有效判定；报价页与接口仍按后续步骤推进。

### 交接（2026-10-26，C 批）

- 第 4–6 步与证明包审批装配已完成，审批数据、复用 / 取代 / 过期、六入口和正式金额来源已接通；测试结果见「C 批 · 第 4–6 步」。改动留工作区，不提交、不推送、不开 PR，spec 保持 ready。
- 当前无功能半成品或未定设计；45 个关联自测、门禁、锁定套件、旅游字节与两种 v2 均通过，逐项证据见实施记录。没有启动容器、浏览器、真实模型或外部服务；所有测试进程均已退出，临时脚本和日志已清理。
- 下一步为第 7 步：实现批准、驳回与撤回的完整条件写入、提交后重读及推送。复用本批 `quoteState` 与取消入口的撤回逻辑，补手审批准后取代旧正式单、并发与通知失败验收；权限、钩子与提醒按后续步骤接入，旅游字节夹具与锁定文件仍不可修改。

### 交接（2026-10-26，D 批）

- 第 7–10 步完成：审批动作、成员权限与审计、工作台与总览、两类提醒及首次确认事务持久化均已实现，具体验收与 95 个关联自测见「D 批 · 第 7–10 步」。门禁、锁定套件、旅游字节基准、两种 v2、字体与 console 构建检查均通过；真实 PG 分支与完整 `pnpm test` 按任务约定留 CI。
- 改动保留在工作区，不提交、不推送、不开 PR，spec 保持 ready；没有功能半成品或需要 owner 决策的设计问题。未运行真实模型、外部服务、浏览器、容器或部署；测试与构建临时产物已清理。
- 下一步为第 11 步：实现报价单页、品牌槽与公共数据接口，七状态、截图、加载 / 空 / 错误态及全部状态重置后 404 按 R9 补验。第 12 步的确定性确认复用 `recordQuoteAccepted`（不要直接调用 `quoteNotifyOps` 绕过 acceptedAt 去重与事务）；第 13 步在本批动作的同步写入段接 `onQuoteDecided`，勿重复发送卡片。继续保持旅游字节、两种 v2、锁定文件与工具定义不变。

### 交接（2026-10-26，E 批）

- 第 11–14 步实现与随批自测完成，最终验证结果见「E 批 · 第 11–14 步」。改动留在工作区，不提交、不 push、不开 PR，spec 保持 ready；无新增表、列、环境变量或依赖。
- 当前没有功能半成品或未定设计问题；101 个关联自测、门禁、旅游字节和两种 v2 均通过，测试进程均已退出，没有遗留浏览器、容器或后台服务。
- 下一步为第 15 步：做整体验收与审查；上线必须取得 owner 当次授权。第 16 步由协调者补七态真实浏览器截图、一次性真实 PG 分支与上述手动 / 自动回滚演练。本批未调用真实模型、未访问服务器或外部服务。

### 交接（2026-10-26，第 15 步前半中期验收）

- 已完成：本机七态与404的页面/API及实际页面脚本核对；文件/DB全态重置核验；3290 实启16请求；截图数据准备；验收1–13逐条对照；三项静态门禁、锁定套件、15个关联自测、两种当前/旧基线回归与CI分片覆盖检查。只改本文件「验收记录」与此交接，产品代码、自测和基线未动，未提交。
- 未完成：验收7截图与验收13真实容器演练由协调者补，执行补充见本次验收记录；真实PG分支与完整pnpm test留CI。验收1线上四哈希与企微/网页冒烟待线上。第15步保持未勾选，spec保持ready，不代owner确认implemented。
- 资料与清理：截图资料为gitignored的 `var/09-acc/config/`、`var/09-acc/data/`，固定订单号与3290完整启动命令见本次验收记录；日志/HTTP结果保留作本机证据。临时探针和重置副本已删除，服务及测试进程已退出，无容器、浏览器或其他后台资源。
- 下一步：回滚演练与八张截图已由协调者补完（见本节），验收 2–13 本机通过；确认 CI 完整链及真实 PG 绿后，由owner在当次会话授权上线 `demo-v10-rc1`，本轮不操作服务器。按08「上线清单」写法逐项核对：部署前手动备份并复制到异地；dev上打本地rc tag（不推）；线上不设PACK_FIXTURES、无证明包租户；09无新增迁移/列，保留现有21迁移；上线前记录旅游租户/订单及看板值；上线后宿主与沙箱revision均为demo-v10-rc1，宿主role=host、DB/锁/渠道健康；`/healthz` 四哈希与开工相同（promptHash `cf3b163c9f69`、toolsHash `59e071568f5d`、prefixHash `6630127f79d7`、sopHash `1f850038290b`）；企微与网页各一句一回（企微由owner手机发送），新开沙箱G01走一遍；看板本月成交额及既有订单与上线前一致、检查两容器日志。含审批历史时pre-09回滚必须拒绝，只能前滚修复或退含09的tag。上线补证后再勾第15步，最终Status更新仍需owner确认。
- 无产品半成品或待定设计；需要确认的问题：无。

### 交接（2026-10-26，owner 定上线推迟到 10 之后）

- 开发完成：第 0–14 步全部合入 `dev`（#324–#328，最后一个合并提交 `4ff0d93`，`dev` CI 绿）。合并前 CI 抓出两处测试问题：一是 `drainStore` 超时后没检查返回值；二是测试共用一条 PGlite 连接，切到 `agent_platform` 时写队列还没排空，CI 慢时就报 42501。两处都修在测试里，没有改产品代码。
- owner 当天先授权上线 `demo-v10-rc1`，随后改定：先不部署，等 10 做完后一起上线。上线前的备份做了两次（03:15 那份另存为 `2026-10-26-pre-v10-rc1`，又手动跑了两次 `backup.sh`，都已复制到异地）；只读核对：没有 `PACK_FIXTURES`，只有旅游租户 `demo`，`orders` 为空，21 个迁移，`/healthz` 为 `demo-v9-rc1`，四个哈希等于开工值。tag 没打，线上没动。
- 下一步：先做 10；第 15–18 步（上线、全量验收、清理、owner 确认后翻 `implemented`）放到与 10 一起上线时做。上线前要重新备份、重做只读核对。

### 交接（2026-10-27，联合上线与终验）

- 第 15–17 步完成：09 随 `demo-v10-rc1`、`demo-v10-rc2` 上线，线上走完工业报价流程，验收 1–13 终验见「联合上线与终验」，清理与 10 一起做。
- 下一步：owner 看 10 plan 的 Open（发现 1 关系到报价链接，属 09 R5 / R10 的范围），确认后第 18 步与 10 第 20 步一起翻 `implemented`；发版到 `main` 要 owner 说发版。
