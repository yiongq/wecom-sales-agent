# 08 · 核心去旅游化：产品种类、通用订单与金额

Status: ready
Revisions: 2026-10-23 起草期评审（一路 Claude Opus，对照 e1433e0 的代码）之后就地修订，尚无代码依赖。一、订单：旧访问器只返回旧版旅游单，另加新访问器；逐个写出读订单的地方的去向；单价改由包的确定性函数算，`createLineOrder` 不收价格；补上通用单的改单作废规则，并规定通用单不进退款（R3）。二、新增 R10「SOP 子系统按包」和 R11「文件模式的产品库」：原稿没写，证明包在 DB 模式下发布不了 SOP，在文件模式下也读不到产品库。三、旅游不经视图，保留原有渲染路径，去掉逐像素比对；视图改名 `OrderDisplay`，只给通用单用（R12）。四、金额出处步骤的放行集合只认工具声明的金额与包的静态金额，去掉「在场条目」和「客户说过的数」；补跟进路径；定死步骤位置（R8）。五、补金额解析表与反例（R6）、money 字段的 CSV、上架检查与显示（R7）。六、写路径与写死处补全，包括沙箱条目上限、按 kind 的进程缓存、闸的缓存键（R2）；知识库每个包至多一个可检索的 kind（R9）。七、回滚检查的退出码改为 9，判定方式照 `rollback-guard.sh` 现有的写法（R13）。八、改写顶部的取代与修订清单。九、沙箱按包移到后续 spec。
Revisions: 2026-10-23 owner 定开放问题 1–7，全部照推荐：金额出处步骤放本 spec；旧版旅游单不迁；产品库金额存元、最多两位小数；通用单的 `total_price` 写 `round(total_fen / 100)`；非旅游包只支持模板模式；同一会话最多一张待付的通用单；沙箱按包出种子移到后续 spec。正文的裁决与这些推荐本来一致，没有其他改动。`Status` 仍是 `draft`。
Revisions: 2026-10-23 为 09、10 的起草补两处，尚无代码依赖：`priceLine` 可以返回 `{ reject, detail }`，表示这一行不定价，例如低于起订量（旧的写法只能返回单价）；「后续」一节改成 09–12 的编号与链接。
Revisions: 2026-10-24 owner 定 `ready`，开放问题 1–7 照 2026-10-23 的裁决。同一个 docs PR 里按 plan 第 0.3 步核对被取代与被修订的条款，反向引用连同行号写进各被改文件的顶部；比原来两行多核出的几处补进本文顶部：取代的加 01 的 `CatalogKind` 类型、导入时用 `RouteSchema` / `HotelSchema` 校验、`catalog-fix --kind` 的取值，与 02 验收 9 的键集合；修订的加 01 的 `CatalogSnapshot.items` 与 `catalog_startup`，02 的方案书路由，04 R2、R14、R17，06 的 `SimGoal.initial`。这些都是正文 R2–R13 本来就写了的改动，行为不变；原写「行号在开工核对时补上」一句改为指向反向引用，「开放问题」开头一句同步。plan 补齐每一步的做 / 验 / 依赖与工作量。
Phase: 8 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」——阶段 8 候选「第二个真实行业包：模板机制要靠它来验证」的前半段。本 spec 只改核心，并用证明包验证；第二个真实行业包另起一份 spec。
Depends on: [07 · 政策单一来源 + 知识库 + 售后退改](../07-knowledge-aftersales/spec.md)（开工时须已 implemented、发版到 `main`）；[04](../04-industry-packs/spec.md)：`PackRuntime`、门面（R1）、步骤表（R7）、假包（R16）、回滚检查（R14）；[05](../05-tenancy-sandbox/spec.md)：租户运行时、进程内状态清单（R5）、沙箱写限额；[06](../06-reply-quality/spec.md)：cases v2 快照、模拟客户；[02](../02-conversations-workbench/spec.md)：订单、工作台、看板、公开订单接口（R22）。
Supersedes in part: [01](../01-pg-config-console/spec.md) 产品库 `kind` 只能是 `route` / `hotel`（`CatalogKind` 类型、`catalog_items.kind` 的 CHECK、`/catalog/:kind` 与 `catalog-fix --kind` 的取值）、导入时用 `RouteSchema` / `HotelSchema` 校验、启动时「没有 active 线路就拒绝」——kind 改由包定义，写入用包的 schema 校验，启动检查改由包给出，旅游的错误码与文案不变（R2）。[02](../02-conversations-workbench/spec.md) R22、不变量 43 与验收 9「`/api/orders/:id` 的键集合恰为白名单」——通用单另有一份白名单，旧版旅游单不变（R12）。[04](../04-industry-packs/spec.md) R16 假包的能力范围（升级为证明包，R14）；「`PackRuntime`」一节「画像字段仍是现有 8 个」（加 `attrs`，R4）。[07](../07-knowledge-aftersales/spec.md)「知识库只收线路」与 `kb_chunks.source` 的 DDL（source 存 kind，R9）。[ADR-004](../../adr/adr-004-pack-field-rendering.md) 决策 4「服务端用 `RouteSchema` / `HotelSchema` 校验写入」——改为用包的 schema，旅游仍是这两个（R2）。[设计系统](../../features/console-ux/design-system.md)「money 只收整数（元）」——`decimals: 2` 的 money 字段收两位小数；「金额写『42,800 元』、全站不出现『¥』」不变（R7）。行号见各被改文件顶部的反向引用（2026-10-24 按 plan 第 0.3 步核对）。
Amends: [ADR-004](../../adr/adr-004-pack-field-rendering.md) 决策 2：`money` 加可选配置 `decimals: 0 | 2`（R7）。[ADR-003](../../adr/adr-003-open-core-boundary.md) 决策 4：路径白名单同样管 `data/packs/<名>/`（R5）。01「两种模式与启动装载」：`CatalogSnapshot` 加 `items`，`ConfigStartupError` 的原因加 `catalog_startup`（R2）。04 R2：`check-boundaries` 加两条规则（R5）。04 R12：`MoneyParseOptions` 加可选的 `decimals`（R6）。04 R10、R11、R17：cases v2 与 `SimGoal` 加可选的 `pack`；配置目录加 `pack.json` 与 `catalog/*.json`（R11）。04 R14：回滚检查加 pre-08 与退出码 9（R13）。06 的 `SimGoal.initial`：非旅游包的 `orders` 用通用单的形状（R11）。07 R8、R9：闸的目标目录与导出按包（R11）。02「数据库」：`orders` 加列 `total_fen`（R3）；方案书路由只对声明了 `documents.proposal` 的包开放（R12）。05 沙箱写限额：按全部 kind 计数（R2）。

**一句话：** 04 把行业逻辑抽成了包，但产品种类、订单、金额、SOP 子系统、文件模式、评测都还写死旅游，第二个行业包上不来。本 spec 的做法：旅游的会话字段、订单形状、产品 schema、价格护栏和它的全部渲染路径原样冻结；新包走一套通用形状——包自己定义的产品种类、按行记的订单、整数分的金额、包自有的会话状态。核心读通用形状经包给的视图，单价只由包的确定性函数算。用证明包在 DB 模式与文件模式下端到端验证，旅游的前缀、锁定套件、回归结论与客户看到的每个字节全程不变。

## 背景与问题

行号按 `dev` e1433e0，开工核对时重核。

04 的非目标第二条把「第二个真实行业包，与 `Session`、`Order`、`SalesStage`、画像字段、产品快照（routes / hotels）的类型泛化」推到了后面；主参考也写着「第二个真实行业包跑通之前，『通用』只是设计主张」。今天写死旅游的地方：

- **产品种类**：
  - `catalog_items` 的 `kind` 由 CHECK 限定为 `route` / `hotel`（`src/db/schema.ts:300`）；`CatalogKind` 在 `src/shared/catalog.ts` 与 `src/db/repo/catalog.ts:6` 各有一份；`CATALOG_SCHEMAS`、`LOCKED_WHEN_ACTIVE`、`REPRICE_FIELDS` 按这两个 kind 索引。
  - 快照的增量更新把所有不是 `route` 的条目写进 `hotels`（`src/config/source.ts:976`）；`ords`（:212）与 `snapshotOf`（:524）丢掉其他 kind。
  - 接口参数 `CatalogKindParam` 是这两个值的枚举（`src/shared/console-api.ts:85-86`）；沙箱复制、导入导出、`catalog-fix` 都只循环这两个 kind（`src/config/transfer.ts:125、194、247、361-365`，`src/cli/catalog-fix.ts:21`）。
  - 沙箱条目上限只数 route 和 hotel（`src/config/catalog.ts:142-146`），别的 kind 能绕过 05 的写限额。
  - CSV 列形状按 kind 做进程级缓存（`src/shared/catalog-csv.ts:58`），两个包有同名 kind 时会串用。
  - 启动时没有 active 线路就以 `no_active_routes` 拒绝（`src/config/source.ts:818`）。
- **订单**：
  - `Order` 的 `routeId`、`routeTitle`、`travelers`、`departDate` 都是必填（`src/types.ts:187-213`）；`getOrder` 返回 `Order`（`src/store.ts:1037`），锁定的 `src/engine.selftest.ts:1194、1662` 直接读 `.travelers`、`.departDate`。
  - 读订单的地方按旅游形状写死：公开订单接口、支付页、企微付款卡片、看板、洞察、退款、确认价格与标记已付、工作台、落库投影、v2 评测（逐个见 R3 的表）。
  - `orders.total_price` 是整数元。
- **金额**：
  - `amountHits` 只认 3 位以上的整数（`src/core/parse/money.ts:30`），`3.65元`、`99元` 识别不到。
  - 产品库的 `money` 字段、CSV 的 money 列、上架检查都只收整数元（`src/shared/pack.ts:405`，`src/shared/catalog-csv.ts:98-100、240-242`）；显示时 `digits` 会四舍五入成整数（`src/shared/format.ts:10-17`）。
  - 价格护栏整个在旅游包里（`src/packs/travel/price-guard.ts`），核心没有可复用的「金额要有出处」步骤。
- **SOP 子系统**：
  - 节表、镜像、契约、policy lint、哈希、导入导出、console 的可编辑节都默认用旅游的：`src/config/source.ts:59、352、647、680、1210`，`src/config/hashes.ts:64`，`src/config/transfer.ts:199、271`，`src/config/sop.ts:30、79`，`src/sop/contract.ts:17-21、61`。
  - 证明包在 DB 模式下发布不了 SOP。
- **文件模式**：
  - `currentCatalog()` 在文件模式下没装载就抛错（`src/config/source.ts:232`），旅游的工具自己读 `ROUTES_PATH`（`src/packs/travel/tools/catalog.ts:62-82`）。
  - v2 与模拟评测都跑在文件模式（`eval/v2/worker.ts:68-73`，`eval/sim/runtime.ts:88-91`），模拟评测强制要 `routes.json`、`hotels.json`。
  - 闸的子进程只放行部分环境变量（`src/config/gate.ts:37`），目标目录写死 `eval/sim/goals/quality`。
  - OTel 在文件模式下写死 `travel`（`src/ops/otel.ts:58`）。
- **会话与画像**：
  - `Session` 上有 9 个旅游字段（`lastQuote` 到 `afterSale`）；`CustomerProfile` 有 5 个旅游字段，`notes`、`nickname`、`avatar` 是通用字段。
  - 非包模块读旅游会话字段的有三处：工作台的报价卡与按报价金额排序（`src/console-api/workbench.ts:94、284`）、交还 AI 时推断阶段（`src/handoff/takeover.ts:241`）、沙箱种子的售后状态（`src/tenancy/sandbox/seeds.ts:127`）。
- **注册表与依赖方向**：
  - `runtimeById` 写死「是 travel 就取旅游，否则取假包」（`src/packs/registry.ts:46`）；`currentPack()` 没绑包时回落旅游。
  - 非包模块直接 import 旅游包：`src/config/source.ts`、`src/config/sop.ts:36`、`src/sop/contract.ts`、`src/sop/sections.ts`、`src/prompt/system.ts`、`src/handoff/triggers.ts:2`、`src/adapters/wecom.ts:18`、`src/tool-defs.ts:9`。`scripts/check-boundaries.ts` 只管 `src/core/`。

`SalesStage` 的 8 个值是通用的销售阶段，不在改动范围内。

## 目标

1. **产品种类由包定义。** kind、schema、锁定字段、计价字段、金额字段、是否进知识库、启动检查都由包声明；库里只做格式约束，归属由写路径统一校验；写限额与缓存按包隔离。
2. **通用订单。** 新包的订单按行记：条目、数量、单位、单价，单价和金额都是整数分。单价由包的确定性函数算，模型只给条目和数量。旅游的旧单与它的全部读者原样保留。
3. **金额。** 解析支持两位小数和低单价，由包开启；核心提供通用的「金额要有出处」步骤（主回复与跟进各一份），新包选用。
4. **SOP 子系统与文件模式按包。** 节表、镜像、契约、哈希、导入导出、可编辑节取绑定的包；文件模式能装载任意包的产品库。
5. **会话与画像。** 包有自己的状态槽和画像字段；旅游字段冻结，非包模块不再读写它们。
6. **评测与闸按包。** 用例、目标、配置目录、闸的目标集与导出都能指定包。
7. **通用单的客户页与工作台。** 支付页、公开订单接口、付款卡片、工作台、看板对通用单经 `OrderDisplay` 渲染；旧版旅游单走原路径。
8. **注册表与依赖方向。** 去掉旅游兜底；包目录与门面之外的代码不直接 import 某个包，也不读写旅游会话字段。
9. **证明。** 证明包在 DB 模式下走完 产品库导入 → SOP 发布 → 对话 → 多行订单 → 支付页 → 工作台 → 闸，在文件模式下跑通 v2 与模拟评测。旅游不变。

## 非目标

- 第二个真实行业包，以及它的工具、护栏、产品数据、品牌：下一份 spec。
- 外部业务系统（ERP、CRM）连接器、报价人工审批、报价单页、客户发来的图片与文件、沙箱按包出种子：后续 spec（见文末）。
- 改 `SalesStage` 的值集；改旅游的会话字段、订单形状、`Route` / `Hotel` schema、价格护栏与价格规则、任何一处旅游的渲染；修外币混淆（04 R12 的已知缺陷）。
- 把旧版旅游单迁成通用单（开放问题 2）；通用单的退款与售后（R3）。
- 非旅游包的旧版模式：非旅游包只支持模板模式（R10）。
- 一个包有多个可进知识库的 kind（R9）。
- 解锁锁定套件；运营侧的开通自动化与计费（ADR-003 的私有运营层，另记）。

## 前置条件

- 07 `Status: implemented`，`demo-v8` 已发到 `main`。
- 锁定套件（AGENTS.md 列的 8 个文件）照旧锁定。开工核对记下：它们的 sha256、demo 的 `PREFIX sha256`、`/healthz` 的四个哈希；一组固定种子订单在 `/pay/<id>` 的 HTML、`/api/orders/:id` 的 JSON、企微付款卡片文本、工作台订单卡接口 JSON 上的字节（验收 1 的基准）。
- 开工核对把下面七张清单落进 plan，每项带文件与行号：
  1. 非包、非门面代码对旅游会话字段与画像字段的读写处；
  2. 读 `routes` / `hotels`、`CatalogKind`、`CATALOG_SCHEMAS` 的地方；
  3. 读订单的地方（R3 的表在开工提交上重核、补全）；
  4. 产品库与知识库的写路径；
  5. 非包、非门面代码 import 某个包的地方；
  6. SOP 子系统里默认取旅游的地方；
  7. 文件模式下按旅游装载的地方。

## 开工前裁决

| #   | 主题                         | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | 冻结旅游，新包走新形状       | 旅游的 `Session` 字段（`lastQuote`、`quoteHistory`、`budgetGaps`、`lastShownRoutes`、`seenRouteIds`、`missedDestinations`、`reminders`、`recommendedRoutes`、`afterSale`）、`Order` 形状、`Route` / `Hotel` schema、价格护栏与价格规则、所有客户与工作台看得到的渲染，逐字节不动；锁定套件零修改。新包只用本 spec 的通用形状。旅游会话不写 `packState`、`moneyLedger` 这两个键，会话的 state json 与今天逐字节相同。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R2  | 产品种类                     | **声明**：包在 `PackRuntime.catalog` 里声明每个 kind 的 `CatalogKindSpec`（见接口）；`IndustryPack.entities[].kind` 必须与之逐项相同，`moneyFields` 必须与字段配置里 `money` 字段的路径和 `decimals` 一致，两项都由注册表在装载时校验。`CatalogKind` 改成 `string`，删掉 `src/db/repo/catalog.ts` 里的那份。`RouteSchema`、`HotelSchema`、`CATALOG_SCHEMAS`、`LOCKED_WHEN_ACTIVE`、`REPRICE_FIELDS` 原样留在 `src/shared/catalog.ts`，作为旅游包 `catalog` 的来源。<br>**库约束**：`catalog_items_kind_check` 改为格式检查 `^[a-z][a-z0-9_]{1,31}$`。<br>**写路径**：kind 是否属于租户的包，由同一个函数 `assertKind(packId, kind)` 校验，不属于返回 422 `kind_unknown`。`CatalogKindParam` 改成按格式校验的字符串，格式不对是 400，格式对但不属于包是 422。写路径清单：console 的新建、补丁、上架、复制（`/catalog/:kind`）；CSV 导入；`catalog-fix`；`import-config`；沙箱复制（`transfer.ts:125`）；种子与回填（开工清单 4 补全）。<br>**快照**：`CatalogSnapshot` 加 `items: Readonly<Record<string, readonly unknown[]>>`（各 kind 的 payload 数组，与今天 `routes` 的元素相同）；`routes` / `hotels` 保留，等于 `items.route` / `items.hotel`（没有时是空数组）。增量更新、`ords`、`snapshotOf` 按 kind 通用。<br>**隔离**：沙箱条目上限按全部 kind 计数；CSV 列形状的缓存键改为 `packId:kind`，并在进程内状态清单里改登记。旅游闸的缓存键保持 `[routes, hotels]`（`gate.ts:310`），线上不必重跑基线。<br>**启动检查**：由包的 `catalogStartupCheck` 给出。旅游仍以 `no_active_routes` 和原文案拒绝；其他包的拒绝统一包成 `ConfigStartupError('catalog_startup', message)`，联合类型只加这一个值。<br>**其他**：条目 `code` 规则不变，编号写法不合规则的包另设展示字段；trace 的条目版本（`trace/recorder.ts:292、317`）对所有 kind 生效。 |
| R3  | 通用订单                     | **两种形状**：旧版旅游单是今天的 `Order`（`data` 里没有 `v`），只由旅游包产生；通用单 `LineOrder`（`data.v = 2`），由新包产生。<br>**访问器**：`getOrder` / `listOrders` 类型照旧是 `Order`，只返回旧版旅游单，锁定套件不受影响；新增 `getAnyOrder` / `listAnyOrders` 返回 `AnyOrder`。<br>**建单**：经核心的 `createLineOrder(session, picks)`，`picks` 只有 `{ kind, code, qty }`，不收任何金额。每行的单价由包的确定性函数 `priceLine(item, qty, ctx)` 算出整数分（阶梯价、折扣都在里面落成整数分），核心校验 kind 属于包、条目 active、`qty` 是 1 到 `maxQty` 的整数，再算 `amountFen = unitPriceFen × qty`、`totalFen = Σ amountFen`。`priceLine` 必须配自测（AGENTS.md 硬规则）。<br>**复用与作废**：同一会话最多一张待付的通用单。新单的行集合 `(kind, code, qty, unitPriceFen)` 与待付单相同就复用；不同就建新单，旧的待付通用单标 `superseded`，`supersededBy` 指向新单。<br>**落库**：`orderToRow`（`store/project.ts:273-275`）对通用单写：`route_id` 是第一行的 `code`（列名不改，schema 注释改为「主条目编号」）、`total_price = round(total_fen / 100)`（只给旧的读者兜底）、`total_fen = totalFen`。<br>**金额口径**：内存里的读者统一用 `orderTotalFen(o)`（通用单取 `totalFen`，旧版旅游单取 `totalPrice × 100`），不另写 SQL 口径。<br>**状态**：`ord_` 编号与六个状态同 02。通用单本 spec 内不进 `refund_pending` / `refunded`，`requestRefund` 收到通用单直接拒绝。读者逐个的去向见下表。                                                                                                                                                                                                                                                                                                                                    |
| R4  | 会话与画像                   | **状态槽**：`Session` 加 `packState?: Record<string, unknown>`。包用 `PackRuntime.sessionState` 的 zod schema 校验，声明 `resetKeys`；`resetSession` 只清这些键。核心只存取、不解读。<br>**画像**：`CustomerProfile` 加 `attrs?: Record<string, string>`，键由包的 `profileFields` 声明。引擎合并画像时 `attrs` 按键合并，不整块覆盖（今天 `core/engine/index.ts:864` 是浅合并）。<br>**发给模型**：画像改由包的 `profileForPrompt` 给，旅游的实现等于今天的函数，逐字节相同；核心对任何包的输出再删一次 `nickname`、`avatar`（不依赖包自觉）。<br>**展示**：会话标题与工作台画像卡由包的 `profileView` 给；viewer 角色下核心照 `workbench.ts:258` 的规则打码。<br>**新钩子**：今天非包代码读旅游字段的三处改走包钩子，旅游的实现照搬现在的逻辑——`quoteCard(session)` 给工作台的报价卡与排序金额；`stageOnReturn(session)` 给交还 AI 时的阶段；`seedSession(session, seed)` 给沙箱种子写售后状态。<br>**匿名接口**：`anonSession`（`server.ts:251`）从删字段改成只拷白名单字段，`packState`、`attrs`、`moneyLedger` 不在白名单里。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R5  | 注册表与依赖方向             | **注册表**：改成表驱动，每个包登记 `{ pack, runtime(sources), quickReplies }`，去掉 `id === 'travel' ? … : 假包` 的分支。<br>**取包**：DB 模式下没绑包时 `currentPack()` 直接抛错，不回落旅游；文件模式按配置目录的 `pack.json`（R11）。`legacyTravelRuntime` 只给门面用。<br>**依赖检查**：`scripts/check-boundaries.ts` 加两条规则，都按 TypeScript 语法树里的 import 与标识符判断，不按文本，只管 `src/` 下的非自测代码：<br>(1) `src/packs/` 与门面之外不 import `src/packs/<名>/**`，`src/packs/registry.ts` 除外；<br>(2) R1 列的 9 个旅游会话字段不在 `src/packs/travel/`、门面与 `src/types.ts` 之外被读写。<br>现存违例由开工清单 1、5 列出，作为允许名单写进脚本，本 spec 结束时清空；每个文件的去向（进包、经钩子、列为门面）在 plan 里逐个写明。<br>**公开边界**：`scripts/check-public-boundary.ts` 的包白名单同样管 `data/packs/<名>/`（ADR-003 决策 4 的 Amends）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R6  | 金额解析                     | `MoneyParseOptions` 加 `decimals?: boolean`（缺省 false）；旅游不传，识别结果与今天逐条相同。为 true 时按下表识别；倍率写法、全角与大写归一照旧；`AmountHit.value` 仍以元计，落库与计算一律用整数分。包的解析选项放在新成员 `PackRuntime.money`（`PackThresholds` 是不透明对象，放不进去）。约数词（多、余、来）跟在小数后面时，不按约数算，容差取最末一位的半个单位。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R7  | 产品库金额字段               | **配置**：ADR-004 的 `money` 加 `decimals?: 0 \| 2`，缺省 0，旅游不变。<br>**存储**：payload 存元（`3.65`），不存分。条目会原样进入模型，存分的话模型会把 365 当成价钱读。<br>**校验与导入**：为 2 时，表单、上架前检查（`checkItem`）、CSV 导入都收「大于 0、最多两位小数」。<br>**显示**：统一用新函数 `formatYuan(fen)`——整元写「1,330 元」，带角分写「1,330.50 元」，全站不出现「¥」（设计系统）；旧的 `digits` 留给旅游。<br>**换算**：核心按 `CatalogKindSpec.moneyFields` 用 `Math.round(x * 100)` 换算成分，并校验换算前后相差小于 1e-9。<br>**路径写法**：`moneyFields` 的路径数组项用 `[]`，如 `tiers[].unitPrice`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R8  | 通用金额出处步骤             | **启用**：核心提供两个步骤工厂，基础标识都是 `money_provenance`——主回复用 `moneyProvenanceStep(options)`，跟进用 `moneyProvenanceFollowupStep(options)`。包放进自己的 `replySteps` / `followupSteps` 才生效，旅游不放。<br>**放行集合**：<br>(1) 本会话的金额账本 `Session.moneyLedger`。工具经 `ToolSpec.amounts` 声明这次调用产生的、可以对客户说的金额（单价、行金额、合计），执行成功后由核心记账，封顶 200 条，留最新的；<br>(2) 本会话订单的行金额与总额；<br>(3) 包的静态金额 `options.staticAmounts(policy)`，如运费、起订金额。<br>产品库里的价格不整库放行（旅游 `price-guard.ts:514` 的教训：整库放行会让编出来的价恰好撞上某个条目）；客户说过的金额不放行（会把客户的砍价洗成成交价，旅游在成交语境里同样排除客户的数，见 `price-guard.ts:52-60、450-457`）。<br>**判定**：回复里每个金额（按 `PackRuntime.money` 解析）都要在集合中某个值的半分容差内，否则整句删掉。派生金额（两数之差、几行之和、数量乘单价）同样删掉，这是有意的设计——工具要把客户可能问到的合计也声明出来。<br>**兜底**：主回复删残时换成 `options.fallback`；跟进只删句，不替换、不转人工（04 R9）。<br>**位置**：主回复步骤的 `after` 至少含 `stage_advance`，装载时校验它排在 `takeover_check:post` 与 `turn_failure` 之前；`writes: ['guardHit']`。<br>**记录与自测**：裁决按 04 R8 记录，自测随步骤提交（AGENTS.md 硬规则）。`moneyLedger` 在 `resetSession` 时清掉。                                                                                                                                                                                                                                                                                                                                                                                     |
| R9  | 知识库                       | `kb_chunks.source` 存 kind，库里的 CHECK 改为 R2 的格式检查。一个包至多一个 kind 的 `retrieval` 为 true（注册表校验），所以 `ref` 照旧是条目编号，内存索引不会撞号（`core/retrieval.ts:201`）。`retrieval-kb.ts:61、96` 与 `db/repo/kb.ts:74` 写死的 `'route'` 改为包里那个可检索的 kind；旅游是 `route`，行为不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R10 | SOP 子系统按包               | 节表、契约规则、policy lint、哈希的节表参数、导入导出、console 的可编辑节，都取绑定包的 `sopSections` / `contractRules` / `policy`，不再缺省取旅游（开工清单 6 逐处列出）。**非旅游包只支持模板模式**：租户必须有品牌（04 R4），锁定节由包的模板渲染成租户的镜像（04 R5），不读 `data/sop.md`。旅游的旧版模式与模板模式都不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R11 | 文件模式的产品库与评测、闸   | **装载**：配置目录（`SOP_PATH` 所在目录）有 `pack.json`（`{ "id": "<包>" }`）就按这个包装载；没有就是旅游，与今天完全相同。非旅游包由核心读同目录的 `catalog/<kind>.json`，组成 `CatalogSnapshot`，版本恒为 1；`currentCatalog()` 在文件模式下对它们可用。旅游的工具照旧自己读 `ROUTES_PATH`。<br>**评测**：cases v2 与 `SimGoal` 加 `pack?: string`（缺省 `travel`）。不是 `travel` 时：`fixtures.session.profile` 只收 `{ attrs, notes }`；`fixtures.orders` 与 `initial.orders` 用 `{ status, lines: { kind, code, qty }[] }`，按包的 `priceLine` 建成通用单；`expect.orders.last` 能断言 `lines` 与 `totalFen`（`eval/v2/worker.ts:102`）。`travel` 的 schema 不变。<br>**导出与闸**：`CONFIG_DIR_REQUIRED`、`export-config`、闸的导出、模拟评测的 `--config-dir` 都按包；非旅游包导出 `pack.json` 与 `catalog/*.json`。`export-config` 复用输出目录时，先删掉旧的 `routes.json`、`hotels.json`、`pack.json` 与 `catalog/`。闸的子进程靠配置目录里的 `pack.json` 认包，不新增要放行的环境变量。闸的目标目录取 `PackRuntime.evalGoalsDir`，旅游是 `eval/sim/goals/quality`，不变。<br>**其他**：OTel 在文件模式下取 `pack.json` 的包名。非旅游包的参考配置放 `data/packs/<id>/`；旅游的仍在 `data/`，不搬。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R12 | 通用单的客户页、工作台与看板 | **分流**：旧版旅游单一律走今天的路径，不经视图，字节不变。通用单经 `orderDisplay(order)` 渲染：支付页、公开订单接口、企微付款卡片、工作台订单卡、看板、洞察、审计文字。<br>**公开订单接口**：`/api/orders/:id` 对通用单用另一份白名单（`PublicLineOrder`，见接口），没有旅游字段；对旧版旅游单的键集合不变。<br>**页面兼容**：`chat.html` 与 `pay.html` 的 `fillPayCard` 拿到不带 `display` 的 JSON 时照今天渲染（`server.selftest.ts:283-310` 用旅游形状直接跑它）。<br>**接口金额**：通用单的接口金额字段一律带后缀 `Fen`、是整数分，另带已格式化的文字；看板汇总在内存里按分求和，接口仍以元计——没有通用单的租户，数值与今天相同。<br>**方案书**：`/proposal/...` 与 `/api/proposal/...` 只对声明了 `documents.proposal` 的包开放，其余包返回 404。<br>**console**：照旧不 import 包（ADR-004），展示数据经接口下发。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R13 | 回滚                         | **判定**：照 `deploy/rollback-guard.sh` 现有的写法，加 `pre08_image` 探测：目标镜像里没有 `src/core/order-view.ts`。目标是 pre-02 到 pre-07 的任何一档，都同样跑 08 的检查。<br>**风险项**（任一存在即算有风险）：`pack_id <> 'travel'` 的租户；`data->>'v' = '2'` 的订单；kind 不是 `route` / `hotel` 的条目；`source` 不是 `route` 的知识块。<br>**结果**：有风险时检查脚本以 **9** 退出（6、7、8 已被占用），打印处理步骤：停用并清理非旅游租户，确认四项都为零。`deploy.sh` 两处 `case` 补上 9 的文案，照现有约定转成 1。库问不到时按有风险处理（与 04 R14 同一种从严）。部署旧 tag 和健康检查失败后的自动回滚都经过这道检查。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R14 | 证明包                       | `src/packs/__fixture/` 升级为证明包，只在 `PACK_FIXTURES=1` 时登记，不给客户用。它包括：<br>- 一个可检索的 kind `widget`：单价 `decimals: 2`、单位、一个标签字段，可 CSV 导入；<br>- 一个只在测试里登记的 kind `hotel`，schema 与旅游的不同，用来验证 CSV 缓存按包隔离；<br>- 一个查询工具（声明金额）和一个建单工具（经 `createLineOrder`，`priceLine` 带两档数量阶梯）；<br>- `packState` 与 `attrs` 各至少一个键；`money_provenance` 的主回复与跟进两个步骤；<br>- 模板模式的品牌与 SOP 模板，参考配置放在 `data/packs/__fixture/`；<br>- 至少 3 条 v2 case、2 个模拟客户目标。<br>不实现 `quoteCard`，也不声明 `documents.proposal`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### R3 订单读者的去向

开工清单 3 在开工提交上重核本表。「两种」指经 `getAnyOrder` / `listAnyOrders`，对通用单走 `orderDisplay`、对旧版旅游单走原路径。

| 读者                                 | 位置                                             | 去向                          |
| ------------------------------------ | ------------------------------------------------ | ----------------------------- |
| 公开订单接口、支付页                 | `server.ts:267-290、821-840`                     | 两种（R12）                   |
| 企微付款卡片                         | `adapters/wecom.ts:687`                          | 两种                          |
| 看板                                 | `ops/board.ts:56-79`                             | 两种，按 `orderTotalFen` 求和 |
| 洞察                                 | `core/insight.ts:22-36`                          | 两种                          |
| 确认价格、标记已付、取消及其审计文字 | `payment/orders.ts:69、101`，`audit-text.ts:152` | 两种                          |
| 工作台订单卡                         | `console-api/workbench.ts:219-225`               | 两种                          |
| 落库投影                             | `store/project.ts:273-275`                       | 两种（R3「落库」）            |
| v2 评测断言                          | `eval/v2/worker.ts:102`                          | 两种（R11）                   |
| 退款                                 | `core/refund.ts:16-20`，`payment/refunds.ts:75`  | 只旧版旅游单；通用单拒绝      |
| 方案书、企微方案卡                   | `server.ts:870`，`adapters/wecom.ts:670`         | 只旅游（R12）                 |
| 从会话起草模拟目标                   | `console-api/goal-draft.ts:59-82`                | 只旅游；非旅游包隐藏入口      |
| 锁定套件、门面                       | `engine.selftest.ts` 等                          | 旧访问器，不变                |

## 接口与数据流

### 包接口新增（`src/core/pack-api.ts`）

```ts
export interface CatalogKindSpec {
  schema: z.ZodType<Record<string, unknown>>; // 写入校验；旅游取 RouteSchema / HotelSchema
  titleKey: string;
  lockedWhenActive: readonly string[];
  repriceFields: readonly string[];
  /** R7：金额字段的路径（数组项用 []）与精度，必须与字段配置一致 */
  moneyFields: readonly { path: string; decimals: 0 | 2 }[];
  /** R9：一个包至多一个为 true */
  retrieval: boolean;
}

export interface MoneyEntry {
  fen: number; // 非负整数
  label: string; // ≤ 20 字，只进 trace，不进模型
}

export interface LinePick {
  kind: string;
  code: string;
  qty: number;
}

export interface PackRuntime {
  // …04、07 已有成员不变…
  catalog: Readonly<Record<string, CatalogKindSpec>>;
  catalogStartupCheck?(snapshot: CatalogSnapshot): string | null; // 拒绝原因；旅游另走 no_active_routes
  money?: MoneyParseOptions; // R6
  /** R3：确定性单价（整数分），必须有自测；没有这个钩子的包不能建通用单。返回 reject 时这一行不定价，createLineOrder 整单拒绝并带回每行的原因 */
  priceLine?(
    item: Readonly<Record<string, unknown>>,
    qty: number,
    ctx: { kind: string; session: Session },
  ): { unitPriceFen: number; unit: string; attrs?: Record<string, string> } | { reject: string; detail?: Record<string, unknown> }; // 如 { reject: 'below_moq', detail: { moq: 100 } }
  maxQty?: number; // 缺省 100000
  sessionState?: { schema: z.ZodType<Record<string, unknown>>; resetKeys: readonly string[] };
  profileFields?: readonly { key: string; label: string }[];
  profileForPrompt(profile: CustomerProfile): Record<string, unknown>;
  profileView(profile: CustomerProfile): { title: string; rows: { label: string; value: string }[] };
  quoteCard?(session: Session): { title: string; amountFen: number; lines: string[] } | null;
  stageOnReturn?(session: Session): SalesStage | null;
  seedSession?(session: Session, seed: Readonly<Record<string, unknown>>): void;
  evalGoalsDir: string;
  documents?: { proposal?: boolean };
}

export interface ToolSpec {
  // …04 已有成员不变…
  /** R8：这次调用产生的、可以对客户说的金额；执行成功后由核心记进 session.moneyLedger */
  amounts?(result: ToolResult, args: unknown): readonly MoneyEntry[];
}
```

### 订单（`src/core/order-view.ts`，新）

```ts
export interface OrderLine {
  kind: string;
  code: string;
  version?: number; // 下单时的条目版本
  title: string; // 下单时的名称快照
  qty: number;
  unit: string; // 「件」「套」「米」，由 priceLine 给
  unitPriceFen: number;
  amountFen: number; // = unitPriceFen × qty
  attrs?: Readonly<Record<string, string>>; // 行属性（如交期），只用于展示
}

export interface LineOrder {
  v: 2;
  id: string;
  sessionId: string;
  lines: OrderLine[]; // 至少一行
  totalFen: number; // = Σ amountFen
  status: OrderStatus; // 不取 refund_pending / refunded
  createdAt: number;
  // 与 Order 同名同义：paidAt、supersededBy、handoffBeforePaid、confirmedAt、confirmedBy、paidMarkedBy、cancelReason
}

export type AnyOrder = Order | LineOrder;

/** 与 shared/console-api.ts 已有的 OrderView 不同名 */
export interface OrderDisplay {
  title: string; // 第一行的名称，多行时加「等 N 项」
  summary: string; // 「3 项 · 共 250 件」
  lines: { title: string; qtyText: string; unitPriceText: string; amountText: string; attrs?: Record<string, string> }[];
  totalFen: number;
  totalText: string; // formatYuan
}

export function isLineOrder(o: AnyOrder): o is LineOrder;
export function orderTotalFen(o: AnyOrder): number;
export function orderDisplay(o: LineOrder): OrderDisplay; // 只收通用单
export function createLineOrder(
  session: Session,
  picks: readonly LinePick[],
): Promise<
  { order: LineOrder; reused: boolean } | { rejected: { kind: string; code: string; reason: string; detail?: Record<string, unknown> }[] } // 有任一行被 priceLine 拒绝
>;

/** /api/orders/:id 对通用单的白名单（R12） */
export interface PublicLineOrder {
  id: string;
  status: OrderStatus;
  display: OrderDisplay;
  paidAt?: number;
  payable: boolean;
}
```

旧版旅游单不经视图（R12），所以没有 `legacyOrderView` 这类钩子。

### 金额解析（R6，`decimals: true`）

| 原文                                               | 结果                 | 说明                                                                                          |
| -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `3.65元`、`¥0.85`、`99块`、`12.5元/件`             | 3.65、0.85、99、12.5 | 带单位，1–2 位小数，1–2 位整数                                                                |
| `单价3.80`、`报价 12.5`                            | 3.8、12.5            | 不带单位，紧跟「单价 / 报价 / 价格 / 每件 / 每个」（`decimals` 模式下 TIGHT_HINT 加这几个词） |
| `3块6`、`3块6毛5`、`三块六毛五`                    | 3.6、3.65、3.65      | 口语，数字与汉字都认                                                                          |
| `12.5k`                                            | 12500                | 倍率照旧                                                                                      |
| `2块样板`、`50块钢板`、`3块砖`                     | 不是金额             | 「块」后面紧跟汉字名词时是量词                                                                |
| `3.5天`、`v2.1`、`6205-2RS`、`M8×30`、`2026.10.23` | 不是金额             | 没有金额单位，也没有紧跟价格词                                                                |
| `0元`、`0.00元`                                    | 不是金额             | 低于 `minimumAmount`（≥ 0.01）                                                                |

每一行都要写成自测，反例（不是金额的几行）与正例一样多。

### 数据库（迁移从 0018 起）

- `catalog_items_kind_check`：`kind ~ '^[a-z][a-z0-9_]{1,31}$'`；drizzle 的 `kind` 枚举去掉。`catalog_item_versions.kind` 本来没有 CHECK。
- `kb_chunks_source_check`：同样的格式；drizzle 的 `source` 枚举去掉。
- `orders` 加 `total_fen bigint`（可空），加两个 CHECK：
  - `total_fen IS NULL OR total_fen >= 0`；
  - `(data->>'v') IS DISTINCT FROM '2' OR (total_fen IS NOT NULL AND total_fen = (data->>'totalFen')::bigint)`。

  授权照 02 对 `orders` 的做法（表级，`drizzle/0003`）。不回填，旧单的 `total_fen` 留空。

- 会话的 `packState`、`moneyLedger` 与画像的 `attrs` 都在已有的 state json 里，不加列。

### 数据流

- **写产品库**：
  1. 写路径调 `assertKind(packId, kind)`，再用 `pack.catalog[kind].schema` 校验；
  2. 锁定与计价规则按 `lockedWhenActive` / `repriceFields`，逻辑同今天，只是从包里取；
  3. 校验沙箱条目上限（全部 kind 合计）；
  4. 落库；
  5. 增量嵌入（只有可检索的 kind）。
- **建通用单**：
  1. 模型给 `{ kind, code, qty }`；
  2. 包的工具调 `createLineOrder`；
  3. 核心取 active 条目，调包的 `priceLine` 算出整数分，校验算式；
  4. 按「复用与作废」规则处理，经 02 的订单路径落库；
  5. 工具经 `amounts` 声明行金额与合计。
- **回复里的金额**：
  1. 工具执行后记账；
  2. 模型回复；
  3. `money_provenance` 按包的解析选项取出金额，与放行集合比对，放行或删句。
- **订单展示**：读者调 `getAnyOrder`。旧版旅游单走原路径；通用单走 `orderDisplay`。

## 不变量

1. 旅游租户（demo 与以旅游为模板的沙箱）的 `PREFIX sha256`、`toolsHash`、`promptHash`，每一步结束时都等于开工值。
2. 锁定套件零修改、全绿。
3. 同一份 v2 case、同一份假模型脚本：旅游客户收到的文本、阶段、订单字段、工具调用，每一步结束时都与开工时相同（归一订单号与方案版本号之后）。
4. 旧版旅游单在支付页 HTML、公开订单接口 JSON、企微付款卡片、工作台订单卡接口 JSON 上的字节，每一步结束时都与开工时相同。
5. 旅游会话的 state json 里没有 `packState`、`moneyLedger` 键。
6. 通用单：每行 `amountFen = unitPriceFen × qty`，`totalFen = Σ amountFen`，全是非负整数；库里 `total_fen = data.totalFen`；状态不取 `refund_pending` / `refunded`。
7. 通用单的单价只来自包的 `priceLine`：`createLineOrder` 的入参里没有金额字段。
8. kind 不属于租户包的条目写不进库（应用层，422 `kind_unknown`）；格式不对的 kind 写不进库（库的 CHECK）；沙箱租户的条目总数（全部 kind）不超过 05 的上限。
9. 启用了 `money_provenance` 的包，发出去的每个金额都在放行集合的半分容差内。
10. `src/` 下非自测代码里，`src/packs/` 与门面之外不 import 某个具体的包（`registry.ts` 除外），`src/packs/travel/`、门面与 `src/types.ts` 之外不读写 R1 列的旅游会话字段。
11. DB 模式下，没绑包的运行时调用 `currentPack()` 抛错，不回落旅游。
12. 通用单的支付页、公开订单接口、企微付款卡片、工作台订单卡里，不出现「出行」「出发」「线路」。
13. 任何包经核心发给模型的画像里，都没有 `nickname`、`avatar`。
14. 匿名接口返回的会话里，没有 `packState`、`attrs`、`moneyLedger`。

## 兼容与迁移

- **先证明、再搬家**：每一批都带上这一批要用的证明包能力和它的验收测试，测试在本批合并时就是绿的。不先写一批失败的测试，那样过不了 hooks 和 CI。批次顺序见「分批」，每批结束时旅游全绿、v2 结论不变。
- **旅游数据零迁移**：旧单、旧会话、旧条目原样。
- **迁移只放宽约束、加可空列**：库里没有非旅游数据时，旧镜像照常能跑；有非旅游数据时，由 R13 拦住回滚。

## 安全、隐私与性能

- **产品库**：kind 的归属由同一个函数校验，库有格式 CHECK 兜底；沙箱写限额按全部 kind 计数；RLS 与授权照 02，不变。
- **钱**：单价只由包的确定性函数算，模型只给条目和数量。金额全程是整数分，不经浮点累加；元与分的换算只在 R7 一处，并带校验。
- **隐私**：画像进模型前，核心再删一次昵称与头像；匿名接口改成只拷白名单字段；`moneyLedger` 的标签不进模型。
- **性能**：v2 的 mock 回归总耗时，与开工基线相比不超过 +5%（同一台机器，三遍取中位数）。

## 验收标准

1. **旅游不变。**
   - 每一步结束时：锁定套件零修改、全绿；demo 的 `PREFIX sha256` 两个值与开工时相同；v2 的 mock 全绿，结论逐条与开工时相同；不变量 4 的四类输出与开工基准逐字节相同。
   - 上线之后：`/healthz` 的四个哈希与开工时相同，企微与网页各一句一回。
2. **依赖方向。**
   - 在 `src/config/` 的任一文件里加一行 `import … from '../packs/travel/…'`，或在 `src/core/` 里加一处对 `session.lastQuote` 的读取，`pnpm lint` 失败；去掉后通过。
   - 往 `data/packs/` 下加一个白名单以外的目录，`pnpm lint` 失败。
   - 本 spec 结束时，两条规则的允许名单为空。
3. **产品种类。** 证明包租户（PGlite、DB 模式）：
   - console 的导航里有 `widget`；CSV 导入 3 行，其中一行单价 `3.65`，成为草稿；上架后列表显示「3.65 元」。
   - 对它写 kind `route` 返回 422 `kind_unknown`；kind 写成 `Bad-Kind` 返回 400；在库里直接插入 `Bad-Kind` 被 CHECK 拒绝。
   - 证明包的 `hotel` 与旅游的 `hotel` 的 CSV 列互不串用。
   - 沙箱租户里，`widget` 计入条目上限。
   - 没有 active 的 `widget` 时，以 `catalog_startup` 拒绝启动。
   - trace 里记下了 `widget` 条目的版本。
4. **通用订单。** 证明包的一段 mock 对话，模型只给条目和数量，建出两行订单：
   - 200 件 `widget` A：单价由 `priceLine` 按阶梯算出 3.65 元；
   - 50 件 B：单价 12 元；
   - `totalFen = 133000`，库里 `total_fen = 133000`、`total_price = 1330`。
   - 支付页与 `/api/orders/:id` 按 `PublicLineOrder` 返回两行明细与「1,330 元」，没有旅游字段；工作台订单卡显示两行；看板「本月成交额」包含 1,330 元。
   - 同样的条目和数量再下单，复用这张待付单；改了一行数量，旧单 `superseded`、新单生效。
   - 对通用单申请退款被拒。
   - 在工具参数里塞进 `unitPriceFen`，被丢弃，订单金额不变。
5. **金额解析。** 旅游：锁定的 `price-guard.selftest.ts` 与 v2 结论不变。证明包：「金额解析」表里的每一行都有自测，结论与表相同。
6. **金额出处。** 证明包：
   - 查询工具声明了 3.65：回复「单价 3.65 元」放行；
   - 回复「单价 3.80 元」：这一句被删，`guard_events` 有一行 `money_provenance` / `drop_sentence`；整条只剩这一句时，换成兜底句；
   - 回复里自己算的合计（没有声明过）：被删；
   - 包的静态运费放行；
   - 跟进里的同一个编造金额：只删句，不替换。
   - 同一份输入下，旅游的 `guard_verdicts` 与开工时相同。
7. **会话与画像。**
   - 证明包的 `packState` 在重启之后原样恢复；`resetSession` 之后，`resetKeys` 里的键被清掉，其余保留。
   - 两轮分别抽出 `attrs` 的两个键，两个都在。
   - `attrs` 按证明包的白名单进入模型请求；昵称与头像不在任何模型请求里，包故意把它们放进 `profileForPrompt` 的输出时，核心也会删掉。
   - viewer 角色看到的画像卡已打码；匿名接口的会话里没有 `packState` / `attrs` / `moneyLedger`。
   - 旅游会话的 state json 里没有这两个新键。
8. **SOP 按包。** 证明包租户（DB 模式、模板模式）：首次发布、在 console 改一个可编辑节再发布都成功，契约检查用的是证明包的规则；把它的品牌清掉之后启动被拒（非旅游包只支持模板模式）。旅游两种模式不变。
9. **文件模式与评测、闸。**
   - `pack: '__fixture'` 的 v2 case 在 mock 下通过（文件配置与 PGlite 配置两种）；证明包的模拟客户目标在 mock 下跑完。
   - 证明包租户的闸从它的 `evalGoalsDir` 取目标，导出目录里有 `pack.json` 与 `catalog/widget.json`。
   - 向一个旧的旅游导出目录再导出证明包，`routes.json` 被删掉。
   - 旅游闸的目标集哈希与缓存键与开工时相同。
10. **回滚检查。** 本机演练，真实 docker，经 `deploy.sh`：
    - 库里有证明包租户时部署 `demo-v8`：检查脚本 9、`deploy.sh` 1，并打印处理步骤；
    - 只剩一张通用单时，同样被拒；
    - 部署 pre-04 的 tag 时，08 的检查同样执行；
    - 四项都清零之后放行；
    - 健康检查失败后的自动回滚同样经过这道检查。
11. **知识库。** 证明包的 `widget` 进入 `kb_chunks`，`source = 'widget'`，语义召回能命中；注册两个可检索 kind 的包在装载时被拒；旅游的知识块与开工时相同。
12. **不回落与方案书。** DB 模式下，不绑包就处理一轮，抛错，不用旅游作答。证明包租户访问 `/proposal/...` 与 `/api/proposal/...`，返回 404。
13. **性能。** 见「安全、隐私与性能」。
14. **真实模型冒烟。** 旅游闸的 20 个 regression 目标，开工时与最后一步各跑 k = 1；通过数不少于开工时减 2，费用 ≤ ¥3，结果记进 plan。

## 开放问题

以下七条 owner 2026-10-23 定：全部照推荐（见顶部第二条 `Revisions:`）；2026-10-24 翻 `ready`。

1. **通用金额出处步骤放本 spec，还是第二个包的 spec（已定：放本 spec）。** 推荐放本 spec（R8）：没有它，新包上线时没有任何金额保护，违反「钱不由模型决定」的硬规则；它是核心能力，要靠证明包来验。
2. **旧版旅游单要不要迁成通用单（已定：不迁）。** 推荐不迁（R1、R3）：迁的话要改锁定套件、要迁数据、回滚更难。等锁定套件解锁（另起 spec）时再评估。
3. **产品库的金额存元还是存分（已定：存元，最多两位小数）。** 推荐存元，最多两位小数（R7）：条目原样进模型，存分会被读错。
4. **通用单的 `total_price` 写什么（已定：`round(total_fen / 100)`）。** 推荐 `round(total_fen / 100)`，只给旧的读者兜底；核心的读者都改用 `orderTotalFen`（R3）。备选是写 0，但那样旧的读者算出的数是错的，而且看不出来。
5. **非旅游包只支持模板模式（已定：是）。** 推荐是（R10）：旧版模式是为了让 demo 的前缀逐字节不变而保留的，新包没有这个包袱。
6. **通用单的复用与作废（已定：同一会话最多一张待付的通用单）。** 推荐「同一会话最多一张待付的通用单」（R3）。备选是按主条目分别作废（照旅游按线路的做法），但询价单往往多行，按主条目判断容易误作废。
7. **沙箱按包出种子移到后续 spec（已定：移出）。** 推荐移出：一个沙箱进程只服务一个模板，证明包没有演示价值；第二个真实包需要体验页时，连同「沙箱多模板」一起做。

## 被否决的方案

- **把旅游的会话字段和订单迁成通用形状。** 要改锁定套件、要迁数据、回滚更难，收益只是旅游内部更统一。
- **旅游也改走视图渲染。** 锁定断言钉着企微付款卡片与支付页的文字（`wecom.selftest.ts:300-302`，`server.selftest.ts:486、1182`）；改走视图之后，只能靠逐像素比对证明没变。保留原路径，零风险。
- **`createLineOrder` 收单价、核心只校验算式。** 包的工具一旦把模型参数里的价格直接传进来，价格就成了模型决定的，违反硬规则。
- **每个包一张订单表、一张产品表。** RLS、迁移、看板、清理、沙箱复制的工作量都要乘以包的个数。
- **在库里按包校验 kind（触发器查 `tenants.pack_id`）。** 触发器跨表，沙箱复制和迁移的顺序都会变复杂；写路径都经同一个函数，格式 CHECK 加应用层校验已经够用。
- **产品库存分。** 见 R7。
- **先做第二个包，边做边泛化。** 旅游被改坏时，分不清是泛化的问题还是新包的问题。04 是先用假包证明核心，这里照做。
- **把 `SalesStage` 改成由包自定义。** 8 个值本身就是通用的销售阶段；改成字符串要动漏斗、看板、console 的阶段渲染和锁定套件。
- **金额出处整库放行产品库价格、放行客户说过的数。** 见 R8：前者让编造的价碰巧撞上条目就过，后者把客户的砍价洗成成交价，旅游护栏都踩过。

## 分批

1. **批 A**：开工核对与证明包骨架。
2. **批 B**：产品种类、金额字段与知识库（R2、R7、R9）。
3. **批 C**：订单与金额（R3、R6、R8）。
4. **批 D**：SOP 子系统与文件模式（R10、R11 的装载部分）。
5. **批 E**：会话、画像、客户页与工作台（R4、R12）。
6. **批 F**：评测与闸（R11 的其余部分）、注册表与边界收口（R5）、回滚（R13）、验收、上线。

批 B 与批 C 都改 `src/db/schema.ts` 和迁移编号，串行做。批 D 可以与批 C 并行，两者不碰同一批文件，开工清单确认之后定。步骤、依赖与工作量见 [plan](plan.md)。

## 后续（下一份 spec）

- **[09 · 报价审批、报价单页与站内链接](../09-quote-approval/spec.md)。** 核心能力，用本 spec 的证明包验证。
- **[10 · 第二个真实行业包：工业品询价](../10-industrial-rfq-pack/spec.md)。** 连同演示租户，以及 ADR-003 与主参考「场景模板」一条（第二个公开参考包）的修订。
- **11 · 外部业务系统连接器。** 第一家是 Odoo；同时修订 AGENTS.md 里密钥存放的硬规则，并为按租户配置的出站地址加防护（SSRF）。
- **12 · 客户发来的图片与文件。** 下载、解析、大小限制（图片 2MB）、费用计量。
- **沙箱多模板与按包出种子。**
- **渠道接入。** 企业微信代开发应用的授权接入（渠道层，公开）。
