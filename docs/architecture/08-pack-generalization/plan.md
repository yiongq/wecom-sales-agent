# 08 · 核心去旅游化 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。本文件是起草稿：spec 翻 `ready` 时，由协调者细化每一步的「做 / 验 / 依赖」和工作量，并补齐「开工须知」。

## 开工条件

缺一条就停下，告诉 owner：

1. 07 已 `implemented`，`demo-v8` 已发到 `main`；线上 `/healthz` 的 `revision` 是 `demo-v8`。
2. 本 spec `Status: ready`；反向引用随 08 的 docs PR 合入，包括被取代与被修订条款所在 spec 的顶部、ADR-003 与 ADR-004 的顶部、设计系统、master-reference 阶段 8 的链接。
3. 本机能跑 format / lint / typecheck、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。
4. 真实模型评测只由协调者在沙箱外跑（第 0、22 步），整份 ≤¥5。
5. 部署要 owner 当次授权（第 23 步）。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」与「交接记录」，再看 `git log -5`。
- 锁定的 8 个文件见 AGENTS.md，一个字节都不改。
- **前缀**：全程不换。每一步结束时，demo 的两个 `PREFIX sha256` 都等于第 0 步记的值（不变量 1）。
- **旅游不变**：每一步结束时，跑一遍第 0 步记下的旅游输出比对（不变量 4），以及 v2 的 mock 全量回归。任何一处变了都是缺陷，不另存基线。
- **测试随批合入**：每一批带上本批要用的证明包能力和对应的验收测试，合并时是绿的（spec「兼容与迁移」）。
- **迁移**：从 0018 起按合并顺序编号，只加不删，过 `scripts/check-migrations.ts`。两个 PR 同时带迁移时，后合的那个 rebase 后改号。
- **数据**：证明包与它的 case、目标、种子只用合成数据。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、企微标识与凭据、客户原文。

## 步骤

### 批 A：开工（第 0–1 步）

- [ ] 0. 开工核对（协调者 + 实现者；真实模型 ≤¥1.5）
  - 0.1 基准：
    - 开工提交、8 个锁定文件的 sha256、两个 `PREFIX sha256`；
    - 线上 `/healthz` 的 `revision` 与四个哈希；
    - v2 mock 的总耗时（三遍取中位数）；
    - 一组固定种子订单在四类出口上的字节（不变量 4）。
  - 0.2 七张清单（spec「前置条件」），每项带文件与行号；重核 spec 里「R3 订单读者的去向」那张表。
  - 0.3 取代与修订条款：被 R2–R13 改动的条款，带行号，起草各被改文件顶部的那一行，交 owner 定。
  - 0.4 旅游闸的 20 个 regression 目标，各跑 k = 1，作为验收 14 的开工基线。
- [ ] 1. 证明包骨架（R14）：登记方式、品牌与 SOP 模板、参考配置目录、测试夹具。本步不接核心能力，只保证 `PACK_FIXTURES=1` 时能装载，旅游不变。

### 批 B：产品种类、金额字段与知识库（第 2–6 步）

- [ ] 2. 包接口：`CatalogKindSpec`、`PackRuntime.catalog`；旅游的 `catalog` 指向 `shared/catalog.ts` 的现有定义；注册表做两项装载校验，kind 与字段配置一致、至多一个可检索的 kind（R2、R9）。
- [ ] 3. 迁移放宽 kind 的 CHECK；`assertKind` 接到全部写路径；`CatalogKindParam` 改为按格式校验（R2）。
- [ ] 4. 快照的 `items`，以及增量更新、`ords`、`snapshotOf`；沙箱条目上限按全部 kind 计；CSV 缓存键加包名；trace 记条目版本；`catalog_startup`（R2）。
- [ ] 5. `money` 的 `decimals`：字段配置、`checkItem`、CSV、`formatYuan`、元与分的换算（R7）。
- [ ] 6. 知识库：source 的 CHECK；`retrieval-kb.ts` 与 `db/repo/kb.ts` 按包取可检索的 kind（R9）。

### 批 C：订单与金额（第 7–11 步，排在批 B 之后）

- [ ] 7. `order-view.ts`：`LineOrder`、`orderTotalFen`、`orderDisplay`；访问器 `getAnyOrder` / `listAnyOrders`；`orderToRow` 加通用单分支（R3）。
- [ ] 8. `orders.total_fen` 迁移与两个 CHECK（R3）。
- [ ] 9. `createLineOrder`、`priceLine`、复用与作废规则；通用单拒绝退款（R3）。
- [ ] 10. `MoneyParseOptions.decimals`、`PackRuntime.money`，以及解析表的全部自测（R6）。
- [ ] 11. `ToolSpec.amounts`、`Session.moneyLedger`、主回复与跟进两个步骤工厂，以及它们的自测（R8）。

### 批 D：SOP 子系统与文件模式（第 12–13 步，可与批 C 并行）

- [ ] 12. SOP 子系统按包：节表、契约、policy lint、哈希、导入导出、console 的可编辑节；非旅游包只支持模板模式（R10）。
- [ ] 13. 文件模式按 `pack.json` 装载，核心读 `catalog/*.json`；OTel 取包名（R11）。

### 批 E：会话、画像、客户页与工作台（第 14–16 步，排在第 7 步之后）

- [ ] 14. `packState`、`attrs` 按键合并、`profileForPrompt` 后过滤、`profileView` 打码；`quoteCard`、`stageOnReturn`、`seedSession` 三个钩子，旅游的实现照搬现状；`anonSession` 改为只拷白名单字段（R4）。
- [ ] 15. 「R3 订单读者的去向」表里标「两种」的读者，逐个接上 `orderDisplay`；`PublicLineOrder`；方案书按 `documents.proposal` 开放（R12）。
- [ ] 16. 工作台与 console：通用单的订单卡与画像卡；`fillPayCard` 兼容没有 `display` 的 JSON（R12）。

### 批 F：评测、闸、收口、回滚与上线（第 17–26 步）

- [ ] 17. cases v2 与 `SimGoal` 加 `pack`，订单夹具用通用单，`expect.orders.last` 支持通用单（R11）。
- [ ] 18. `export-config`、闸的导出与目标目录按包；复用输出目录时清旧文件（R11）。
- [ ] 19. 注册表表驱动；`currentPack()` 在 DB 模式下不回落（R5）。
- [ ] 20. `check-boundaries` 加两条规则，`check-public-boundary` 管住 `data/packs/`，允许名单清零（R5、不变量 10）。
- [ ] 21. 回滚检查：`pre08_image` 与退出码 9，本机 docker 演练（R13、验收 10）。
- [ ] 22. 中期验收：验收 1–13 在本机逐条核对；真实模型冒烟（验收 14），费用记进「费用记录」。
- [ ] 23. 上线（owner 当次授权）：备份 → 打 rc tag → 部署 → `/healthz` 四个哈希与开工值相同，企微与网页各一句一回（验收 1）。
- [ ] 24. 对照验收标准 1–14 逐条核对，写下通过、部分通过或未过，以及证据。
- [ ] 25. 清理：临时探针、容器、worktree、分支。
- [ ] 26. 更新 Status（owner 确认后翻 `implemented`），发版到 `main`。

## 工作量、依赖与并行

翻 `ready` 时补。已知的依赖：

- 批 B 与批 C 都改 `src/db/schema.ts` 和迁移编号，串行做。
- 批 D 不碰订单与 schema，可以与批 C 并行；开工清单 6、7 确认之后定。
- 批 E 依赖第 7 步。
- 批 F 的第 17、18 步依赖批 D；第 19–21 步依赖其余全部批次。

## 实施记录

## 验收记录

## 费用记录

| 日期 | 步骤 | 内容 | 金额 |
| ---- | ---- | ---- | ---: |

## Open

## 交接记录

### 交接（2026-10-23，起草）

- spec 与本文件的起草稿在分支 `docs/08-spec`，没推，也没开 PR。Opus 独立评审了一轮：3 个阻断项、11 个主要问题、十几条次要问题已经按评审修订，记在 spec 的 `Revisions:`。
- 开放问题 1–7 已由 owner 定（全部照推荐，spec 第二条 `Revisions:`）。`Status` 仍是 `draft`。
- 下一步：owner 翻 `ready` → 补「工作量、依赖与并行」与第 0.3 步的取代条款清单；开工要等 07 `implemented` 并发版到 `main`（开工条件 1）。
