# 08 · 核心去旅游化 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。共 27 步（第 0–26 步），合计约 36–46 个 agent 人日；按 03–07 的实际速度折算，开发约 3–4 天，日历一周左右（主要等 owner 授权与真实模型评测）。出代码的步骤每步一个 PR 进 `dev`，CI 绿了再合；第 0（0.5 除外）、22–26 步不出代码 PR，记录由协调者随相邻 PR 或单独的 docs PR 提交。spec 于 2026-10-24 由 owner 定为 ready，开放问题 1–7 已于 2026-10-23 照推荐定。

## 开工条件

缺一条就停下，告诉 owner：

1. 07 已 `implemented`，`demo-v8` 已发到 `main`；线上 `/healthz` 的 `revision` 是 `demo-v8`（第 0.1 步核对）。
2. 本 spec `Status: ready`（2026-10-24，已满足）。反向引用随 08 的 docs PR 合入（第 0.3 步）：01、02、04、07 顶部 `Superseded in part by:` 与 `Amended by:`，05、06 顶部 `Amended by:`，ADR-003 的 `Amended by`，ADR-004 的 `Superseded in part by` 与 `Amended by`，设计系统顶部 `Superseded in part by:`，master-reference 阶段 8 的 spec 链接。
3. 本机能跑 format / lint / typecheck、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器与 docker（第 21 步演练）；完整 `pnpm test` 由 CI 跑。
4. 真实模型凭据由 owner 在仓库外提供；真实模型评测只由协调者出沙箱跑（第 0.4、22 步），整份 ≤¥5。
5. 不挡开工、只挡线上：部署要 owner 当次授权（第 23 步）。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」与「交接记录」，再看 `git log -5`。代码出处以第 0.2 步核对后的位置为准；spec 不够用就记「Open」停下，不另定架构。部署照 07 plan 第 18、20 步的做法。
- **分工**：两条车道，一条一个实现者，换一个模型交叉评审对方的 PR：车道 1 默认 Codex，车道 2 默认 Claude 子 agent（Sonnet），各在自己的 git worktree 里做。派 Codex 照 `codex-dispatch` skill（它在沙箱里提交不了，一律不提交）。每份任务说明都引用协调者 worktree 里的 `.claude/runs/08-step-common.md`（git 忽略，不进仓库；绝对路径只写在任务说明里）。协调者写任务说明、审 diff、提交、开 PR，CI 绿了开自动合并（`gh pr merge --auto --merge`），开了之后不再追加提交。碰线上、花钱、要 owner 拍板的事由协调者做。
- **锁定的 8 个文件**：`src/engine.selftest.ts`、`src/dejargon.selftest.ts`、`src/engine-holiday.selftest.ts`、`src/price-guard.selftest.ts`、`src/llm.selftest.ts`、`src/server.selftest.ts`、`src/adapters/wecom.selftest.ts`、`eval/cases.json`，sha256 见「实施记录 · 第 0 步」。全程一字不动，本 spec 不授权改任何锁定断言。测试红了先查本步改动；确认与 spec 冲突就记「Open」停下。
- **前缀**：全程不换。每一步结束时，demo 的两个 `PREFIX sha256` 都等于第 0.1 步记的值（不变量 1）。
- **旅游不变**：每一步合并前，第 0.5 步的出口字节自测（不变量 4、5）与 v2 的 mock 全量回归（文件与 PGlite 两条）都要绿，v2 结论与开工时逐条相同（不变量 3）。任何一处变了都是缺陷，不重生成基线。
- **先证明、再搬家**：每一步把本步要用的证明包能力加进 `src/packs/__fixture/`，连同本步的验收测试一起合入，合并时是绿的（spec「兼容与迁移」）。证明包只在 `PACK_FIXTURES=1` 时登记。
- **共同门禁**：本机跑 `pnpm -s format:check`、`pnpm -s lint`、`pnpm -s typecheck`、`pnpm -s test:locked`；按改动文件 grep 出受影响的自测，逐个跑；v2 假模型回归跑文件与 PGlite 两条。完整 `pnpm test` 只在 CI 跑（required check 叫 `check`）。新自测串进 `test` 末尾。改了界面文案跑 `tsx scripts/check-fonts.ts`。
- **v2 快照**（06 R4）：只有加 v2 case 的第 17 步生成 `eval/baselines/v2-08-step17.json`，默认基线改指它；旅游 case 的条目与上一份逐字节相同，只多出新 case。别的步骤不生成快照：快照比对失败就是旅游变了。
- **迁移**：从 0018 起按合并顺序编号，只加不删、只放宽约束或加可空列，过 `scripts/check-migrations.ts`。预计第 3、6、8 步依次是 0018、0019、0020，都在车道 1 串行；两个 PR 同时带迁移时，后合的那个 rebase 后改号。
- **真实模型评测**：只由协调者出沙箱跑，每次显式带 `--budget`，到了就停；配置与线上一致。每次都记进「费用记录」。实现者不发真实模型请求。
- **数据**：证明包与它的 case、目标、种子只用合成数据。临时探针与脚本放在仓库外，不进提交。
- **线上**：部署要 owner 在当次会话明确授权；部署前手动备份并复制到异地；先用 `dev` 上的本地 rc tag 上线（不推），第 26 步再发版到 `main`。别的线上读写照旧要当次授权；第 0.1 步只读公开地址的 `/healthz`。
- 可能挂住的命令加超时（`perl -e 'alarm N; exec @ARGV' …`），收尾查进程与容器。变异测试在隔离副本里跑。本机凌晨跑限额、按日累计相关的自测时加 `TZ=UTC`。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、企微标识与凭据、客户原文。只记不敏感的结果与聚合数。

## 步骤

### 批 A：开工（第 0–1 步）

- [ ] 0. 开工核对（1 天，协调者 + 实现者；真实模型 ≤¥1.5）
  - 次序：0.1 最先；0.2、0.4–0.6 在 0.1 之后同时开，并与第 1、2 步并行。0.2 挡第 3 步开工；0.5 挡第 1 步合并，之后每一步合并前都跑它。0.3 已随 08 的 docs PR 完成。
  - [ ] 0.1 基准（协调者）
    - 做：记开工提交（08 docs PR 合并后的 `dev`）、8 个锁定文件的 sha256、demo 的两个 `PREFIX sha256`、线上 `/healthz` 的 `revision` 与四个哈希；同一台机器上 v2 mock 的总耗时（文件与 PGlite 两条，各三遍取中位数，验收 13 的基线）；四个门禁在开工提交上全绿（CI `check`）。
    - 验：写进「实施记录 · 第 0 步」。
  - [ ] 0.2 七张清单与锁定断言（实现者，只读）
    - 做：spec「前置条件」的七张清单，每项带文件与行号，并写明去向（进包、经钩子、列为门面、按包取）；在开工提交上重核「R3 订单读者的去向」表与「背景与问题」的行号，对不上的记新位置；按批列出每条 R 可能碰到的锁定断言（8 个锁定文件，含 `eval/cases.json` 的 v1 用例），每行写位置、要求什么、怎么避开，spec 点名的 `server.selftest.ts:283-310、486、1182`、`wecom.selftest.ts:300-302`、`engine.selftest.ts:1194、1662` 逐条核。
    - 验：清单写进实施记录；清单 1、5 是第 20 步允许名单的初值，清单 4 是第 3 步写路径的全集。会变红又避不开的记「Open」。
  - [x] 0.3 取代与修订条款（协调者）——2026-10-24，随 08 的 docs PR
    - 做：被 R2–R13 改动的条款逐条带行号，写进被改文件顶部的 `Superseded in part by:` / `Amended by:`；比 spec 原两行多核出的几处补进 spec 顶部，记进第四条 `Revisions:`。
    - 验：见「实施记录 · 第 0.3 步」。
  - [ ] 0.4 真实模型开工基线（协调者，出沙箱；≤¥1.5）
    - 做：在开工提交上跑旅游闸的 20 个 `regression` 目标各 k=1，`--budget 1.5`，配置与线上一致。
    - 验：每个目标过与不过、总费用记进实施记录与「费用记录」，作为验收 14 的开工值。
  - [ ] 0.5 旅游出口字节自测（实现者）
    - 做：新自测（放 `src/payment/`，串进 `test` 末尾）：一组固定的种子旧版旅游单，六个状态各一张、其中一张已确认价格，渲染四类出口——`/pay/<id>` 的 HTML、`/api/orders/:id` 的 JSON、企微付款卡片文本、工作台订单卡接口 JSON（PGlite）——与开工时的字节逐字节比对，开工字节作夹具提交；另断言旅游会话落库后的 state json 里没有 `packState`、`moneyLedger` 键（不变量 5）。
    - 验：在开工提交上绿；故意改支付页一个字，自测变红。
- [ ] 1. 证明包骨架（R14；1 天）
  - 做：`src/packs/__fixture/` 从 04 R16 的假包升级为证明包的骨架，原有的工具名、阶段推进与护栏步骤保留，照旧只在 `PACK_FIXTURES=1` 时由注册表登记（表驱动在第 19 步）。加：`IndustryPack` 的 `widget` 实体与字段配置（单价 money、单位、标签）；模板模式的品牌档案与 SOP 模板（锁定节模板、前言节、硬性要求、欢迎语）；参考配置目录 `data/packs/__fixture/` 的品牌与可编辑节（`pack.json` 与 `catalog/` 在第 13 步）；测试夹具：PGlite 上建证明包租户的辅助函数，供后面各步的验收测试用。本步不接核心能力。
  - 验：`PACK_FIXTURES=1` 时证明包能装载，`IndustryPack` 与 `PackRuntime` 照 04 R3 配对；不设时注册表里没有它；04 验收 13 的那组假包自测照绿；旅游的前缀、锁定套件、0.5 的自测不变。
  - 依赖：0.1；合并排在 0.5 之后。

### 批 B：产品种类、金额字段与知识库（第 2–6 步）

- [ ] 2. 包接口与装载校验（R2、R9；1.5 天）
  - 做：`src/core/pack-api.ts` 加 `CatalogKindSpec`、`PackRuntime.catalog` 与可选的 `catalogStartupCheck`（只加类型，行为在第 4 步接）；旅游的 `catalog` 由 `src/shared/catalog.ts` 现有的 `RouteSchema`、`HotelSchema`、`LOCKED_WHEN_ACTIVE`、`REPRICE_FIELDS` 组成（引用同一个对象，`route` 可检索）；证明包声明 `widget`（可检索）与只在测试里登记的 `hotel`。注册表装载时校验三项：`IndustryPack.entities[].kind` 与 `catalog` 逐项相同；`moneyFields` 与字段配置里 `money` 字段的路径和 `decimals` 一致（第 5 步之前 `decimals` 一律按 0）；至多一个 kind 的 `retrieval` 为 true。
  - 验：三项各一条反例自测，装载时被拒、报错点名包与 kind；旅游 `catalog` 的各项与 `shared/catalog.ts` 是同一个引用；前缀、锁定套件、0.5 不变。
  - 依赖：1。
- [ ] 3. kind 的库约束与写路径（R2；2 天）
  - 做：迁移把 `catalog_items_kind_check` 改为格式检查 `^[a-z][a-z0-9_]{1,31}$`，drizzle 的 `kind` 枚举去掉；`CatalogKind` 改成 `string`，删掉 `src/db/repo/catalog.ts:6` 那份；`assertKind(packId, kind)` 接到第 0.2 步清单 4 的每条写路径（console 的新建、补丁、上架、复制，CSV 导入，`catalog-fix`，`import-config`，沙箱复制 `transfer.ts:125`，种子与回填）；`CatalogKindParam`（`shared/console-api.ts:85-86`）改为按格式校验的字符串，格式不对 400、不属于包 422 `kind_unknown`；锁定与计价规则改从 `pack.catalog[kind]` 取，逻辑不变。
  - 验：验收 3 第 2 条（422、400、在库里直接插 `Bad-Kind` 被 CHECK 拒，真实 PG 与 PGlite 各一遍）；清单 4 的每条写路径各一条「kind 不属于包」的自测；旅游租户的写入与锁定字段的 422 与今天相同；`check-migrations` 过。
  - 依赖：2、0.2。
- [ ] 4. 快照、隔离与启动检查（R2；2 天）
  - 做：`CatalogSnapshot.items`，`routes` / `hotels` 等于 `items.route` / `items.hotel`；增量更新（`source.ts:976`）、`ords`（:212）、`snapshotOf`（:524）按 kind 通用；导入导出与沙箱复制按包的全部 kind 循环（`transfer.ts:194、247、361-365`，`catalog-fix.ts:21`）；沙箱条目上限按全部 kind 合计（`config/catalog.ts:142-146`）；CSV 列形状缓存键改为 `packId:kind`（`catalog-csv.ts:58`），进程内状态登记表与 `check-tenant-state` 同步改；trace 的条目版本对所有 kind 生效（`trace/recorder.ts:292、317`）；`catalogStartupCheck` 与 `ConfigStartupError('catalog_startup', …)`，旅游照旧 `no_active_routes`。旅游闸的缓存键保持 `[routes, hotels]`（`gate.ts:310`），不改。
  - 验：验收 3 第 3–6 条（两个包的 `hotel` CSV 列互不串用、沙箱上限计入 `widget`、没有 active `widget` 时以 `catalog_startup` 拒绝、trace 记 `widget` 条目版本）；旅游快照的 `routes` / `hotels` 与开工时逐字节相同；旅游闸的缓存键与开工时相同。
  - 依赖：3。
- [ ] 5. money 字段的两位小数（R7；1.5 天）
  - 做：ADR-004 的 `money` 加 `decimals?: 0 | 2`（`src/shared/pack.ts`）；为 2 时表单、`checkItem`（`pack.ts:405`）、CSV 导入（`catalog-csv.ts:98-100、240-242`）收「大于 0、最多两位小数」；新函数 `formatYuan(fen)`（`src/shared/format.ts`，整元「1,330 元」、带角分「1,330.50 元」，不出现「¥」），旧的 `digits` 留给旅游；元到分的换算按 `moneyFields` 的路径（含 `[]`）取值，`Math.round(x * 100)` 并校验换算前后相差小于 1e-9；console 的 money 渲染器按 `decimals` 输入与显示；注册表的 `moneyFields` 校验接上 `decimals`。证明包 `widget` 的单价 `decimals: 2`。
  - 验：验收 3 第 1 条（console 导航有 `widget`；CSV 导入 3 行、其中一行 `3.65`，成为草稿；上架后列表显示「3.65 元」）；`formatYuan` 与换算的边界自测（浮点误差、超过两位小数被拒）；旅游的表单、CSV、显示与今天相同；`check-fonts` 过。
  - 依赖：3（`widget` 要能写进库）。
- [ ] 6. 知识库（R9；1 天）
  - 做：迁移把 `kb_chunks_source_check` 改为同样的格式检查，drizzle 的 `source` 枚举去掉；`retrieval-kb.ts:61、96` 与 `db/repo/kb.ts:74` 写死的 `'route'` 改为包里那个可检索的 kind；证明包的 `widget` 增量嵌入。
  - 验：验收 11（`widget` 进 `kb_chunks`、`source = 'widget'`，假 embedding 下语义召回命中；两个可检索 kind 的包装载被拒，用第 2 步的反例；旅游的知识块与开工时相同）；真实 PG（带 vector）与 PGlite 各一遍；`check-migrations` 过。
  - 依赖：4。

### 批 C：订单与金额（第 7–11 步）

- [ ] 7. 通用单的类型、访问器与展示（R3；1.5 天）
  - 做：新文件 `src/core/order-view.ts`：`OrderLine`、`LineOrder`、`AnyOrder`、`OrderDisplay`、`PublicLineOrder`、`isLineOrder`、`orderTotalFen`、`orderDisplay`（金额用 `formatYuan`，多行时标题加「等 N 项」）；`store.ts` 加 `getAnyOrder` / `listAnyOrders`，`getOrder` / `listOrders` 的类型与行为不变、只返回旧版旅游单。
  - 验：`orderTotalFen` 两种单各一条；`orderDisplay` 的标题、摘要、逐行文字自测；夹具直接写入一张 `v: 2` 单，`getOrder` / `listOrders` 看不到它、`getAnyOrder` 能取到；锁定套件全绿。
  - 依赖：5。
- [ ] 8. `total_fen` 与落库投影（R3；1.5 天）
  - 做：迁移给 `orders` 加 `total_fen bigint`（可空）与两个 CHECK，授权照 02 对 `orders` 的做法（`drizzle/0003`），不回填；`orderToRow`（`store/project.ts:273-275`）加通用单分支：`route_id` 写第一行的 `code`（schema 注释改为「主条目编号」）、`total_price = round(total_fen / 100)`、`total_fen = totalFen`；旧版旅游单的行逐列不变（`total_fen` 为空）。
  - 验：通用单落库后 `total_fen = data.totalFen`；直接插一行 `v: 2` 而 `total_fen` 对不上的、`total_fen` 为负的都被 CHECK 拒；旅游单的行与开工时相同；真实 PG 与 PGlite 各一遍；`check-migrations` 过。
  - 依赖：6（迁移编号）、7。
- [ ] 9. 建单与作废（R3；2 天）
  - 做：`PackRuntime.priceLine`、`maxQty`；`createLineOrder(session, picks)`：入参只有 `{ kind, code, qty }`，核心校验 kind 属于包、条目 active、`qty` 是 1 到 `maxQty` 的整数，调包的 `priceLine` 算每行单价（整数分），任一行 `reject` 就整单拒绝并带回每行原因，`amountFen = unitPriceFen × qty`、`totalFen = Σ amountFen`；「复用与作废」照 R3；经 02 的订单路径落库。`requestRefund`（`core/refund.ts:16-20`、`payment/refunds.ts:75`）收到通用单直接拒绝。证明包加建单工具（经 `createLineOrder`）与两档数量阶梯的 `priceLine`，带自测（AGENTS.md 硬规则）。
  - 验：验收 4 的建单部分（一段 mock 对话：200 件 A 单价 3.65 元、50 件 B 单价 12 元，`totalFen = 133000`，库里 `total_fen = 133000`、`total_price = 1330`；同样条目和数量复用待付单，改一行数量旧单 `superseded`；对通用单申请退款被拒；工具参数里塞 `unitPriceFen` 被丢弃、金额不变）；`priceLine` 返回 `reject` 时整单拒绝；不变量 6、7。
  - 依赖：8、4。
- [ ] 10. 金额解析（R6；1.5 天）
  - 做：`MoneyParseOptions.decimals`（缺省 false，旅游不传）与 `PackRuntime.money`；为 true 时照 spec「金额解析」表识别（带单位的小数与低单价、紧跟价格词的裸数、口语与汉字数、倍率、量词「块」、日期型号版本号、低于 `minimumAmount`），约数词跟在小数后时按 R6 的容差；`AmountHit.value` 仍以元计。只改 `src/core/parse/money.ts` 与 `pack-api.ts`。
  - 验：表里每一行一条自测，反例与正例一样多（验收 5）；锁定的 `price-guard.selftest.ts` 与 v2 结论不变。
  - 依赖：0.1。
- [ ] 11. 金额出处（R8；2.5 天）
  - 做：`ToolSpec.amounts`、`MoneyEntry`；工具执行成功后由核心记进 `Session.moneyLedger`（封顶 200 条、留最新的）；两个步骤工厂 `moneyProvenanceStep` / `moneyProvenanceFollowupStep`（基础标识 `money_provenance`），放行集合与判定照 R8，主回复删残时换 `options.fallback`，跟进只删句；装载时校验主回复步骤排在 `stage_advance` 之后、`takeover_check:post` 与 `turn_failure` 之前；裁决按 04 R8 记录；`resetSession` 清 `moneyLedger`。旅游不放这两个步骤，旅游会话不写这个键。证明包启用两个步骤，查询工具与建单工具声明金额，并给静态运费。
  - 验：验收 6 全部（含同一份输入下旅游的 `guard_verdicts` 与开工时相同）；步骤排错位置时装载被拒；两个工厂各带自测；0.5 的自测里旅游 state json 照旧没有 `moneyLedger`；不变量 9。
  - 依赖：7、9、10、14。

### 批 D：SOP 子系统与文件模式（第 12–13 步）

- [ ] 12. SOP 子系统按包（R10；2.5 天）
  - 做：第 0.2 步清单 6 的每一处（节表、契约规则、policy lint、哈希的节表参数、导入导出、console 的可编辑节；出处见 spec「背景与问题 · SOP 子系统」）改取绑定包的 `sopSections` / `contractRules` / `policy`，不再缺省取旅游；非旅游包只支持模板模式：租户没有品牌就拒绝启动（拒绝原因见 Open 1），锁定节由包的模板渲染成租户的镜像，不读 `data/sop.md`。
  - 验：验收 8（证明包租户，DB 模式、模板模式：首次发布、在 console 改一个可编辑节再发布都成功，契约检查用的是证明包的规则；清掉品牌后启动被拒）；旅游两种模式的 `promptHash`、`toolsHash`、导入导出的哈希与开工时相同。
  - 依赖：4、1；合并等 Open 1。
- [ ] 13. 文件模式按包（R11 的装载部分；1.5 天）
  - 做：配置目录有 `pack.json` 就按这个包装载，没有就是旅游；非旅游包由核心读同目录的 `catalog/<kind>.json` 组成 `CatalogSnapshot`（版本恒为 1），`currentCatalog()` 在文件模式下对它们可用（`source.ts:232`）；旅游的工具照旧读 `ROUTES_PATH`；OTel 取 `pack.json` 的包名（`ops/otel.ts:58`）；v2 与模拟评测的文件模式装载（`eval/v2/worker.ts:68-73`、`eval/sim/runtime.ts:88-91`）对非旅游包不再要 `routes.json`、`hotels.json`；`data/packs/__fixture/` 补 `pack.json` 与 `catalog/widget.json`。
  - 验：用 `data/packs/__fixture/` 起文件模式，`currentCatalog().items.widget` 有数据、OTel 的包名是 `__fixture`；没有 `pack.json` 的目录与今天完全相同（旅游的文件模式自测、v2 文件配置那条照绿）。
  - 依赖：12。

### 批 E：会话、画像、客户页与工作台（第 14–16 步）

- [ ] 14. 会话与画像（R4；2.5 天）
  - 做：`Session.packState` 与 `PackRuntime.sessionState`（zod 校验、`resetKeys`，`resetSession` 只清这些键）；`CustomerProfile.attrs` 与 `profileFields`，引擎合并画像时 `attrs` 按键合并（`core/engine/index.ts:864`）；`profileForPrompt`（旅游的实现等于今天的函数）之后核心再删 `nickname`、`avatar`；`profileView` 给会话标题与画像卡，viewer 照 `workbench.ts:258` 打码；三个钩子 `quoteCard`（`workbench.ts:94、284`）、`stageOnReturn`（`handoff/takeover.ts:241`）、`seedSession`（`tenancy/sandbox/seeds.ts:127`），旅游的实现照搬现在的逻辑；`anonSession`（`server.ts:251`）改为只拷白名单字段。证明包加 `packState` 与 `attrs` 各至少一个键。
  - 验：验收 7 全部；旅游的工作台报价卡与排序、交还 AI 的阶段、沙箱种子的售后状态与开工时相同；前缀与 v2 结论不变；不变量 13、14。
  - 依赖：2。
- [ ] 15. 订单读者接上展示（R12；2.5 天）
  - 做：第 0.2 步重核后的「R3 订单读者的去向」表里标「两种」的读者，逐个改用 `getAnyOrder` / `listAnyOrders`，通用单经 `orderDisplay`、旧版旅游单走原路径：公开订单接口与支付页（通用单用 `PublicLineOrder`）、企微付款卡片、看板（按 `orderTotalFen` 在内存里按分求和，接口仍以元计）、洞察、确认价格 / 标记已付 / 取消与审计文字、工作台订单卡接口（金额字段带 `Fen` 后缀，另带格式化文字）、落库投影已在第 8 步；方案书的页面与接口只对声明了 `documents.proposal` 的包开放，其余 404；`goal-draft` 对非旅游包隐藏入口。
  - 验：验收 4 的展示部分（支付页与 `/api/orders/:id` 按 `PublicLineOrder` 返回两行明细与「1,330 元」、没有旅游字段；看板「本月成交额」包含 1,330 元）；验收 12 后半（证明包租户的方案书两条路由 404）；不变量 12；0.5 的自测不变。
  - 依赖：9、14。
- [ ] 16. 工作台与客户页（R12；2 天）
  - 做：console 的工作台订单卡与画像卡渲染通用单与 `profileView`（console 照旧不 import 包，数据经接口下发）；`public/chat.html` 与 `public/pay.html` 的 `fillPayCard` 认 `display`，没有 `display` 的 JSON 照今天渲染（`server.selftest.ts:283-310` 用旅游形状直接跑它）。
  - 验：验收 4 的「工作台订单卡显示两行」；锁定的 `server.selftest.ts` 照绿；PR 里写 BEFORE/AFTER；`check-fonts` 过；浏览器里看证明包租户的工作台与支付页（截图不进仓库）。
  - 依赖：15。

### 批 F：评测、闸、收口、回滚与上线（第 17–26 步）

- [ ] 17. 评测按包（R11 的评测部分；2 天）
  - 做：cases v2 与 `SimGoal` 加 `pack?: string`（缺省 `travel`；`goalSchema` 是 strict 的，同步加）；不是 `travel` 时 `fixtures.session.profile` 只收 `{ attrs, notes }`，`fixtures.orders` 与 `initial.orders` 用 `{ status, lines }`、按包的 `priceLine` 建成通用单，`expect.orders.last` 能断言 `lines` 与 `totalFen`（`eval/v2/worker.ts:102`）；证明包至少 3 条 v2 case（`eval/cases-v2/q08-fixture.json`）、2 个模拟客户目标（`eval/sim/goals/__fixture/`，第 18 步登记为它的 `evalGoalsDir`）；生成 `eval/baselines/v2-08-step17.json`，默认基线改指它。
  - 验：验收 9 第 1 条（`pack: '__fixture'` 的 case 在文件与 PGlite 两种配置下 mock 通过；证明包的模拟目标在 mock 下跑完）；快照与 `v2-07-step6.json` 的 diff 只有新增的 case；`travel` 的 schema 与旧 case 不变。
  - 依赖：9、11、13、14。
- [ ] 18. 导出与闸按包（R11 的其余部分；1.5 天）
  - 做：`CONFIG_DIR_REQUIRED`、`export-config`、闸的导出、模拟评测的 `--config-dir` 按包，非旅游包导出 `pack.json` 与 `catalog/*.json`；`export-config` 复用输出目录时先删旧的 `routes.json`、`hotels.json`、`pack.json` 与 `catalog/`；闸的子进程靠配置目录里的 `pack.json` 认包，不新增放行的环境变量（`gate.ts:37`）；`PackRuntime.evalGoalsDir`，旅游是 `eval/sim/goals/quality`，证明包是第 17 步的目录。
  - 验：验收 9 第 2–4 条（证明包租户的闸从它的目录取目标，导出目录有 `pack.json` 与 `catalog/widget.json`；向旧的旅游导出目录再导出证明包，`routes.json` 被删；旅游闸的目标集哈希与缓存键与开工时相同）；闸用 `eval/sim/fake.ts` 的假模型跑通证明包。
  - 依赖：17。
- [ ] 19. 注册表与不回落（R5；1 天）
  - 做：`src/packs/registry.ts` 改成表驱动，每个包登记 `{ pack, runtime(sources), quickReplies }`，去掉 `id === 'travel' ? … : 假包` 的分支（`registry.ts:46`）；DB 模式下没绑包时 `currentPack()` 抛错、不回落旅游；文件模式按 `pack.json`；`legacyTravelRuntime` 只给门面用。
  - 验：验收 12 前半（DB 模式不绑包处理一轮，抛错，不用旅游作答）；不变量 11；锁定套件与文件模式照旧。
  - 依赖：16、18。
- [ ] 20. 依赖方向收口（R5、不变量 10；2 天）
  - 做：`scripts/check-boundaries.ts` 加两条按语法树判断的规则，只管 `src/` 下的非自测代码：`src/packs/` 与门面之外不 import `src/packs/<名>/**`（`registry.ts` 除外）；R1 的 9 个旅游会话字段不在 `src/packs/travel/`、门面与 `src/types.ts` 之外读写。允许名单的初值是第 0.2 步清单 1、5 减去第 12–19 步已经搬走的；本步把剩下的按 0.2 写的去向搬完，名单清零。`scripts/check-public-boundary.ts` 的包白名单同样管 `data/packs/<名>/`。
  - 验：验收 2 全部（在 `src/config/` 加一行 import 旅游包、在 `src/core/` 读 `session.lastQuote`，`pnpm lint` 失败，去掉后通过；往 `data/packs/` 下加白名单以外的目录，lint 失败；两条规则的允许名单为空）；前缀、锁定套件、0.5 不变。
  - 依赖：19。
- [ ] 21. 回滚检查（R13；1.5 天，实现者写脚本、协调者演练）
  - 做：`deploy/rollback-guard.sh` 照现有写法加 `pre08_image`（目标镜像里没有 `src/core/order-view.ts`），目标是 pre-02 到 pre-07 的任何一档都跑；四项风险有一项就以 9 退出并打印处理步骤，库问不到按有风险处理；`deploy.sh` 两处 `case` 补 9 的文案，照约定转成 1；部署说明补退出码 9。
  - 验：验收 10，协调者出沙箱用本机真实 docker 经 `deploy.sh` 演练五种情况，结果记进实施记录；02–07 的检查与退出码 4–8 不变。
  - 依赖：8。
- [ ] 22. 中期验收（协调者；真实模型 ≤¥1.5）
  - 做：第 1–21 步全部合入后的 `dev` 上，逐条核验收 1–13 的本机部分；验收 13：v2 mock 总耗时与 0.1 相比不超过 +5%（同一台机器，三遍取中位数）；验收 14：旅游闸 20 个 `regression` 目标各 k=1，`--budget 1.5`。
  - 验：逐条结果写进「验收记录」，费用进「费用记录」（验收 14 两次合计 ≤¥3）。
  - 依赖：1–21。
- [ ] 23. 上线（协调者，owner 当次授权）
  - 做：照「上线清单」：备份并复制到异地；`dev` 上打本地 rc tag 上线；核 `/healthz` 的 `revision` 与四个哈希等于 0.1 的开工值；企微与网页各一句一回；新开沙箱 G01 走一遍。
  - 验：记进「验收记录」（验收 1 的上线部分）。
  - 依赖：22。
- [ ] 24. 对照验收标准 1–14 逐条核（协调者）
  - 做：每条写通过、部分通过或未过，以及证据。
  - 依赖：23。
- [ ] 25. 清理（协调者）
  - 做：本机残留的容器、worktree、分支、临时目录与探针；部署说明核对退出码 9。
  - 依赖：24。
- [ ] 26. 更新 Status 并发版（协调者，owner 确认与当次授权）
  - 做：owner 确认后翻 `implemented`；照 07 发 `demo-v8` 的做法开 release PR 进 `main`、打下一个 `demo-v*` tag，记进实施记录。
  - 依赖：25。

## 验收映射

| 验收              | 主要在哪一步验                        |
| ----------------- | ------------------------------------- |
| 1 旅游不变        | 每一步（0.5 的自测、v2 快照）；22、23 |
| 2 依赖方向        | 20                                    |
| 3 产品种类        | 3、4、5                               |
| 4 通用订单        | 9、15、16                             |
| 5 金额解析        | 10                                    |
| 6 金额出处        | 11                                    |
| 7 会话与画像      | 14                                    |
| 8 SOP 按包        | 12                                    |
| 9 文件模式与闸    | 17、18（缓存键另在 4 核）             |
| 10 回滚检查       | 21                                    |
| 11 知识库         | 6                                     |
| 12 不回落与方案书 | 19（不回落）、15（方案书 404）        |
| 13 性能           | 0.1 记基线，22 比对                   |
| 14 真实模型冒烟   | 0.4、22                               |

## 工作量、依赖与并行

两条车道，一条一个实现者；跨车道的依赖在表里写明，合并后再开。

| 步骤              |  天 | 依赖（合并后再开）  | 车道 | 执行者          | 真实模型 |
| ----------------- | --: | ------------------- | ---- | --------------- | -------- |
| 0 开工核对        |   1 | 开工条件            | —    | 协调者 + 实现者 | ≤¥1.5    |
| 1 证明包骨架      |   1 | 0.1；合并等 0.5     | 1    | Codex           | —        |
| 2 包接口          | 1.5 | 1                   | 1    | Codex           | —        |
| 3 kind 与写路径   |   2 | 2、0.2              | 1    | Codex           | —        |
| 4 快照与隔离      |   2 | 3                   | 1    | Codex           | —        |
| 5 money 两位小数  | 1.5 | 3                   | 2    | Claude          | —        |
| 6 知识库          |   1 | 4                   | 1    | Codex           | —        |
| 7 通用单类型      | 1.5 | 5                   | 2    | Claude          | —        |
| 8 `total_fen`     | 1.5 | 6、7                | 1    | Codex           | —        |
| 9 建单与作废      |   2 | 8、4                | 1    | Codex           | —        |
| 10 金额解析       | 1.5 | 0.1                 | 2    | Claude          | —        |
| 11 金额出处       | 2.5 | 7、9、10、14        | 2    | Claude          | —        |
| 12 SOP 按包       | 2.5 | 4、1；合并等 Open 1 | 2    | Claude          | —        |
| 13 文件模式       | 1.5 | 12                  | 2    | Claude          | —        |
| 14 会话与画像     | 2.5 | 2                   | 2    | Claude          | —        |
| 15 订单读者       | 2.5 | 9、14               | 1    | Codex           | —        |
| 16 工作台与客户页 |   2 | 15                  | 1    | Codex           | —        |
| 17 评测按包       |   2 | 9、11、13、14       | 2    | Claude          | —        |
| 18 导出与闸       | 1.5 | 17                  | 2    | Claude          | —        |
| 19 注册表         |   1 | 16、18              | —    | Codex           | —        |
| 20 依赖收口       |   2 | 19                  | —    | Claude          | —        |
| 21 回滚检查       | 1.5 | 8                   | 1    | Codex + 协调者  | —        |
| 22 中期验收       |   1 | 1–21                | —    | 协调者          | ≤¥1.5    |
| 23 上线           | 0.5 | 22、owner 授权      | —    | 协调者          | —        |
| 24–26 收尾与发版  |   1 | 23、owner 确认      | —    | 协调者          | —        |

合计约 40 个 agent 人日；关键路径约 24 天（车道 2 的 0.5 → 10 → 14 → 5 → 7 → 12 → 13 → 11 → 17 → 18，再接 19 → 20 → 22 → 收尾），按实际速度折算开发约 3 天。执行者是默认分配，协调者可以按进度对调；评审由另一条车道的模型做。

**热点文件**：

| 文件                                                   | 改它的步骤                                                    | 怎么避免冲突                                         |
| ------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------- |
| `src/core/pack-api.ts`                                 | 2、9、10、11、14、15（`documents`）、18（`evalGoalsDir`）     | 只追加成员；按合并顺序 rebase                        |
| `src/db/schema.ts`、`drizzle/`                         | 3、6、8                                                       | 都在车道 1，串行；按合并顺序编号                     |
| `src/config/source.ts`                                 | 4（快照、启动检查）、12（SOP 节表）、13（文件模式）、19       | 12 排在 4 之后，13 在 12 之后，19 最后               |
| `src/config/transfer.ts`                               | 3（沙箱复制）、4（kind 循环）、12（SOP 导入导出）、18（导出） | 按依赖串行                                           |
| `src/shared/catalog-csv.ts`                            | 4（缓存键 :58）、5（money 列 :98、:240）                      | 碰不同函数；后合的 rebase                            |
| `src/shared/pack.ts`、`src/shared/catalog.ts`          | 2、3、5                                                       | 按依赖串行                                           |
| `src/store.ts`、`src/store/project.ts`                 | 7（访问器）、8（投影）、9（建单）、11、14（`resetSession`）   | 14 先于 11，同一车道；9 与 11 不同时开               |
| `src/core/engine/index.ts`                             | 11（记账、步骤）、14（画像合并）                              | 同一车道，14 先                                      |
| `src/server.ts`、`src/console-api/workbench.ts`        | 14（`anonSession`、`quoteCard`）、15、16                      | 14 先合，15、16 在车道 1 接着做                      |
| `src/adapters/wecom.ts`                                | 15                                                            | —                                                    |
| `src/packs/__fixture/`、`data/packs/__fixture/`        | 1 起每一步都加本步的能力                                      | 每步只加自己的文件与登记项，登记处 rebase 时两边都留 |
| `src/packs/registry.ts`                                | 2（装载校验）、19（表驱动）                                   | 19 最后                                              |
| `eval/v2/worker.ts`、`eval/sim/goals.ts`、`runtime.ts` | 13、17                                                        | 同一车道，13 先                                      |
| `console/`、`public/pay.html`、`public/chat.html`      | 5（money 渲染器）、16                                         | 5 先合                                               |
| `package.json` 的 `test`                               | 每个加自测的 PR                                               | 只在末尾追加，rebase 时两边都留，逐项核对不漏不重    |

**合并顺序**：车道 1：1 → 2 → 3 → 4 → 6 → 8 → 9 → 15 → 16 → 21；车道 2：0.5 → 10 → 14 → 5 → 7 → 12 → 13 → 11 → 17 → 18；两条都合完之后 19 → 20。跨车道的等待：5 等 3，7 等 5，8 等 7，12 等 4，11 等 9，15 等 14，17 等 9。两条车道之间同一时间只合一个 PR，轮到的 PR 先 rebase 到最新 `dev`、CI 绿了再合。

## 上线清单

第 23 步核一遍：

- owner 当次授权；部署前备份并复制到异地。
- 迁移 0018 起只放宽约束、加可空列；部署说明写明回滚检查退出码 9 的处理步骤（R13）。
- 线上不设 `PACK_FIXTURES`，证明包不登记；库里没有非旅游租户。
- `/healthz` 的 `revision` 与四个哈希等于 0.1 的开工值。
- 企微与网页各一句一回；新开沙箱 G01 走一遍（沙箱复制在第 3、4 步改过）。
- 看板「本月成交额」与上线前一致（线上没有通用单）。

## 实施记录

### 第 0.3 步 · 取代与修订条款（2026-10-24，协调者，随 08 的 docs PR）

- 反向引用写进 9 个文件的顶部，行号指写入之后的文件，逐条核过：01（取代 7 处、修订 2 处）、02（取代 3 处、修订 2 处）、04（取代 2 处、修订 5 处）、05（修订 1 处）、06（修订 1 处）、07（取代 2 处、修订 2 处）、ADR-003（修订决策 4）、ADR-004（取代决策 4、修订决策 2）、设计系统（取代 §6 money 一行）。
- 比 spec 原两行多核出的：取代——01 的 `CatalogKind` 类型、导入时用 `RouteSchema` / `HotelSchema` 校验、`catalog-fix --kind route|hotel`，02 验收 9 的键集合；修订——01 的 `CatalogSnapshot.items` 与 `catalog_startup`，02 的方案书路由（只对声明了 `documents.proposal` 的包开放），04 R2（边界规则）、R14（pre-08 与退出码 9）、R17（配置目录），06 的 `SimGoal.initial.orders`。都已补进 spec 顶部，记在第四条 `Revisions:`。
- 05 R5「进程内状态」表里没有 CSV 列形状缓存这一项，第 4 步改的是代码里的登记表，所以 05 只加了 R14 一处。

## 验收记录

## 费用记录

| 日期 | 步骤 | 内容 | 金额 |
| ---- | ---- | ---- | ---: |

## Open

1. **非旅游包缺品牌时的启动拒绝原因**（挡第 12 步合并）。R10 与验收 8 要求清掉品牌后启动被拒，但没写用哪个 `ConfigStartupError` 原因；R2 又写「联合类型只加 `catalog_startup` 这一个值」，现有原因里没有表达「缺品牌」的。推荐加一个 `brand_required`，同时把 R2 那句改成「只加 `catalog_startup` 与 `brand_required` 两个值」，记进 spec 的 `Revisions:`；备选是并进 `catalog_startup`，但那样一个原因同时管产品库和品牌，看日志分不清。owner 定。

## 交接记录

### 交接（2026-10-23，起草）

- spec 与本文件的起草稿在分支 `docs/08-spec`，没推，也没开 PR。Opus 独立评审了一轮：3 个阻断项、11 个主要问题、十几条次要问题已经按评审修订，记在 spec 的 `Revisions:`。
- 开放问题 1–7 已由 owner 定（全部照推荐，spec 第二条 `Revisions:`）。`Status` 仍是 `draft`。
- 下一步：owner 翻 `ready` → 补「工作量、依赖与并行」与第 0.3 步的取代条款清单；开工要等 07 `implemented` 并发版到 `main`（开工条件 1）。

### 交接（2026-10-24，翻 ready）

- owner 定 `ready`。同一个 docs PR（分支 `docs/08-ready`）：spec 翻 `ready` 并记第四条 `Revisions:`；第 0.3 步完成，反向引用写进 9 个文件；master-reference 阶段 8 加 08 的链接；本文件补齐每一步的做 / 验 / 依赖、工作量与并行、验收映射、上线清单。09、10 仍是 `draft`。
- 下一步：docs PR 合并后从第 0.1 步开始。Open 1 只挡第 12 步合并，不挡开工。
