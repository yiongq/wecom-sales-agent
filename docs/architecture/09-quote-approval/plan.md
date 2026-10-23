# 09 · 报价审批、报价单页与站内链接 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。本文件是起草稿：spec 翻 `ready` 时，由协调者细化每一步的「做 / 验 / 依赖」和工作量。

## 开工条件

缺一条就停下，告诉 owner：

1. 08 已 `implemented` 并上线。
2. 本 spec `Status: ready`；反向引用随 09 的 docs PR 合入，包括 02 的 `Superseded in part by:`，以及 08、04 的 `Amended by:`。
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
- [ ] 1. `PackRuntime.siteLinks` 与核心登记；把 TypeScript 写死处改成读登记；旅游登记 `proposal`（R10）。
- [ ] 2. 静态页的 `quote` 分支（`chat.html`、`web.js`、`admin.html`）；锁定测试全绿（R10）。
- [ ] 3. `linkWhitelistStep` 与自测（R10）。
- [ ] 4. `QuoteApproval`、`createLineOrder` 的 `approval` 选项、`autoApprovable`、工具结果的待审形态（R1、R2）。
- [ ] 5. 复用、取代、过期与 `quoteState`（R6）。
- [ ] 6. 6 个订单入口对报价单的行为（R4）。
- [ ] 7. 批准、驳回、撤回的接口：按条件写入、重读、推送、备注、转人工（R3、R5）。
- [ ] 8. 权限与审计标签（R7）。
- [ ] 9. 工作台订单卡：按钮、窗口提示、高亮；总览的「报价单等你审核」（R5、R8）。
- [ ] 10. `quote_pending`、`quote_accepted` 两条提醒，以及执行体（R8）。
- [ ] 11. 报价单页与 `GET /api/quotes/:id`（R9）。
- [ ] 12. `DeterministicReply` 的四个字段与执行顺序、`fixedId` 核对；`HandoffKind` 加 `pack`，补齐全部消费方（R11、R12）。
- [ ] 13. `shape` 谓词改读 `ShapePolicy.richTools`；`handoff` 谓词加 `kind`；`onQuoteDecided` 与 `followupGate` 两个钩子（R12、R13、R16）。
- [ ] 14. 证明包收口；`quote-void --all`；回滚检查与本机 docker 演练（R14、R15）。
- [ ] 15. 中期验收：验收 1–12 在本机逐条核对；上线（owner 当次授权）。
- [ ] 16. 对照验收标准 1–12 逐条核对，写下通过、部分通过或未过，以及证据。
- [ ] 17. 清理：临时探针、容器、worktree、分支。
- [ ] 18. 更新 Status（owner 确认后翻 `implemented`），发版到 `main`。

## 工作量、依赖与并行

翻 `ready` 时补。已知的依赖：

- 第 1–3 步先做，并跑通旅游的字节基准。
- 第 5–11 步依赖第 4 步。
- 第 10 步与第 12 步都改 `src/shared/conversation.ts` 的通知文案表，串行做；第 13 步可以与第 5–11 步并行。

## 实施记录

## 验收记录

## Open

## 交接记录

### 交接（2026-10-23，起草）

- 原「09 · 工业品询价包」经 Opus 评审后拆成两份：本 spec（核心）与 [10](../10-industrial-rfq-pack/spec.md)（工业包与演示）。起草稿在分支 `docs/08-spec`，没推。
- 经三轮 Opus 评审修订；开放问题 1–5 owner 2026-10-23 全部照推荐定（spec 第三条 `Revisions:`）。`Status` 仍是 `draft`。
- 下一步：08 实现并上线之后，owner 翻 `ready`，再补「工作量、依赖与并行」。
