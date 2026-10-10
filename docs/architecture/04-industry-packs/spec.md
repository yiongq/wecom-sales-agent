# 04 · 行业包抽取

Status: draft
Phase: 4 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」（2026-10-10 拆分之后的编号）
Depends on: [03 · 渠道层 v2](../03-channels-v2/spec.md)（开工时须已 implemented）；[01](../01-pg-config-console/spec.md) 的 SOP 节表、锁定节与发布流程；[00](../00-baseline/spec.md) 的前缀稳定检查。
Amends: 01「SOP 契约与锁定节」（锁定节可以按包模板与品牌档案渲染，demo 租户仍取镜像原文）；03 R17、R18 的「推到阶段 4」在本 spec 落地。

## 背景与问题

产品要从「旅游 demo」变成「通用企业微信 AI 销售助手」，旅游只是第一个参考行业包。现在旅游写死在核心里，03 之前做的 `src/packs/travel/` 只覆盖后台展示（词表、实体、阶段、SOP 节）。开工前的只读盘点（协调者另存，不进仓库）查到的现状：

- **旅游逻辑与通用逻辑交织。** 至少 16 个文件里有旅游概念；`src/engine.ts`（4616 行）里客群、目的地推荐、行程能力、人数与天数、日期与节假日、预取与工具参数落地这几段合计约 3000 行，夹着通用的会话、并发、接管处理。`src/tools.ts` 的 7 个工具、`src/price-guard.ts`、`src/price-rules.ts`、`src/llm.ts` 的 mock、`src/handoff/triggers.ts`、`src/retrieval.ts`、`src/followup.ts`、`src/insight.ts` 都带旅游内容。
- **品牌写死。** `src/prompt/system.ts` 的【硬性要求】写死「云途定制旅行」「旅行顾问」「微信」「与旅行无关的问题」；身份说明（`answerIdentity`）、欢迎语、SOP 契约里的「顾问会在微信上联系您」也是。换一家客户、换一个品牌都要改代码。
- **出口护栏没有统一的流水线。** 主回复路径上实际有 20 个护栏标识、22 个执行位置（主参考写的「13 道」是早先的数；`repair_links` 与 `custom_promise` 各在两处执行），按位置内联执行，「必须在谁之后」只体现在代码顺序里；有的护栏会建单、转人工、调工具，不只是改文字。trace 只记改了文字的裁决，放行不记（主参考要求每次裁决都记）。主动跟进另走一条 11 步的 `guardOutbound`。
- **中文解析重复实现。** 金额、日期、人数在引擎、价格护栏、价格规则、工具、mock 里各有一套，人数至少 4 处不同实现；金额只有数值、没有币种身份，识别下限 1000 写在 6 处。
- **阈值散落。** 16 组主要阈值与政策（金额下限、容差、团体 4 人起与折扣、搜索放宽、日期范围、窗口条数、失败判定……），有的已经能用环境变量配，有的是旅游定价政策，有的是算法参数，没有分开。
- **评测只有固定回放。** `eval/cases.json` 51 条（v1，裸数组），runner 只回放预写的客户输入；`src/engine.selftest.ts`（锁定）里的场景是测试代码，不是数据；没有模拟客户、没有业务终态判分、没有 pass^k。
- **锁定套件钉着内部形状。** 锁定的自测直接从 `src/engine.ts`（`handleMessage`、`historyWindow`、`onToolCall`、`promptPrefix`、`notifyPaid`、`__engineTest`、`__orderTest`）、`src/tools.ts`（`loadRoutes`、`searchRoutes`、`executeTool`、`toolDefs`、`createQuote`、`HANDOFF_NOTE`、`LOWLAND_MAX_ALTITUDE`、`offCatalogPlaces`、`catalogCovers`、`visitedDestinations`、`loadHotels`）、`src/price-guard.ts`、`src/price-rules.ts`、`src/followup.ts`（`__followupTest`）、`src/retrieval.ts` 引入函数，还钉住历史窗口的分块、wire 请求的顺序与字节、六轮工具循环、卡片提取的文本形状。

## 目标

1. **品牌与身份可配置。** 品牌名、顾问称呼、身份说明、业务范围、渠道称呼来自租户的品牌档案；demo 租户用现在的「云途」值，渲染出的 system prompt 与开工时逐字节相同；另配一个虚构品牌的旅游租户，只改配置就能跑同一组回归。
2. **行业包运行时接口。** 引擎的主流程、护栏流水线、解析、工具运行时进 `src/core/`；旅游的工具、护栏、规则、mock、检索文本、跟进模板、洞察提示、阶段与画像进 `src/packs/travel/`。`src/core/` 不引用 `src/packs/`（import lint）；包经注册表装载。主流程（`handleMessage` 的核心路径）约 150 行。
3. **出口护栏流水线。** 22 个执行位置各包装成一个 `Guard`，组成有序列表，「必须在谁之后」写成声明并在装载时校验；旅游的回复与开工时逐字节相同；每轮的每个裁决（含放行）都记进 trace。
4. **中文通用解析与币种。** 金额（带币种）、日期、人数的解析收到 `src/core/parse/` 一处，旅游的调用点行为不变；金额识别下限等变成包的阈值。
5. **阈值与政策进包配置。** 算法参数、行业政策、环境配置分开；旅游包的默认值等于现值。
6. **cases v2 与黑盒场景库。** 定 cases v2 格式（夹具、假模型脚本、断言），把引擎自测里能用黑盒表达的场景导出成数据；先在旧引擎上跑绿，抽取的每一步之后照样全绿。
7. **模拟客户评测与 pass^k。** 模型扮演带隐藏目标的客户，按业务终态确定性判分；核心流程与护栏用例在真实模型上跑 k = 5，抽取前后各跑一次对比（手动、花钱、不进 CI）。
8. **R17 消息部件与渠道能力描述**（03 推过来的）：引擎在文本之外显式产出链接部件；企微的文本与卡片逐字节不变，网页渠道改用部件渲染链接。
9. **R18 渠道中立的 SOP 锁定节**（03 推过来的）：包提供锁定节模板，新租户按品牌档案渲染出中立措辞；demo 租户的锁定节仍是镜像原文。

## 非目标

- 同部署多租户（公开路由按租户解析、按租户预算、进程内缓存按租户隔离、跨租户泄漏测试、从模板开通租户）与一键体验沙箱：阶段 5。本阶段仍是一个实例一个租户。
- 第二个真实行业包（家装、电商售后等）：阶段 7 按信号。本阶段只用「虚构品牌的旅游租户」与一个最小的假包（只为验证 import 边界与注册表，不对外）证明配置化。
- 政策单一来源、知识库、售后退改、看板拆分：阶段 6。
- 改 demo 的 SOP 正文、产品库或系统前缀：demo 的 `PREFIX sha256` 全程不变（不变量 1）。
- prod 放开网页渠道：见开放问题 4，默认不在本阶段做。
- 多副本：阶段 7 按信号。
- 私有行业包与 ADR-003 的 workspace + submodule 切换：本阶段的包都是公开的，没有触发条件。

## 前置条件

- 03 `Status: implemented`，demo 线上跑 03 之后的版本。
- 锁定套件（03 的 8 个文件）照旧锁定；开工核对记下它们的 sha256 与 `PREFIX sha256`。
- 开工核对把盘点里的三张清单落进 plan：锁定套件从老路径引入的全部名字（门面清单，R1）、22 个护栏的标识与顺序（R4）、可导出的场景清单（R7）。

## 开工前裁决

| #   | 主题                 | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 目录与门面           | 新代码放 `src/core/`（主流程、流水线、解析、工具运行时、包接口）与 `src/packs/travel/`。老路径 `src/engine.ts`、`src/tools.ts`、`src/price-guard.ts`、`src/price-rules.ts`、`src/followup.ts`、`src/retrieval.ts`、`src/llm.ts` 保留为门面：锁定套件引入的每个名字仍从原路径导出、行为不变（`__engineTest`、`__orderTest` 等测试出口的键集合不变）。门面只做转发，不放逻辑；门面清单之外的名字可以移走。                                                |
| R2  | 依赖方向             | `src/core/**` 不 import `src/packs/**`；包只经 `src/core/pack-api.ts` 拿核心类型与工具函数；注册表 `src/packs/registry.ts` 是唯一同时认识两边的模块。`scripts/check-boundaries.ts` 加这两条，违反时 `pnpm lint` 失败。                                                                                                                                                                                                                                  |
| R3  | 包接口               | 现有后台用的 `IndustryPack`（`src/shared/pack.ts`）不动、继续给 console 用；运行时另定 `PackRuntime`（见「接口与数据流」），两者由注册表按同一个 `pack_id` 配对。                                                                                                                                                                                                                                                                                       |
| R4  | 护栏流水线           | 22 个执行位置各包成一个 `Guard`（同一标识的两处用后缀区分，如 `repair_links:mark` 与 `repair_links:fill`），带 `after` 声明；顺序是开工时代码里的实际顺序，装载时按 `after` 校验，违反就启动失败。有副作用的护栏（建单、转人工、补调工具）照旧在流水线里执行，副作用经 `GuardContext` 的方法做，不直接调存储。跟进路径的 11 步是同一批 `Guard` 的子集，顺序不变。                                                                                       |
| R5  | 裁决记录             | 每轮一条 `guard_verdicts` trace 事件：按执行顺序列出每个护栏的 `id` 与动作（`pass`、`rewrite`、`drop`、`replace`、`handoff`、`order`），放行也记；改写的护栏另记改动前后的长度，不记原文（原文已在 trace 的回复里）。不为每个护栏单独记一条事件（trace 量）。                                                                                                                                                                                           |
| R6  | 品牌档案             | 新表列 `tenants.brand`（json，可空）。空就用包的默认品牌：旅游包的默认品牌就是现在的「云途」值，所以 demo 不用迁移数据。prod profile 下 `tenant-create` 必须带品牌（`--brand-file`），不带以 2 拒绝；demo profile 不强制。改品牌走命令行 `tenant-brand set`（平台身份、写审计），改完要重新发布 SOP 才生效（品牌进 system prompt，与 SOP 发布同一个版本号，前缀哈希随之变）。                                                                           |
| R7  | cases v2             | 新格式带版本号 `"version": 2`，一条 case 是一段对话；支持夹具（当前时刻、预置会话状态、预置订单、预置报价）、可选的假模型脚本（mock 模式下按轮给出模型输出与工具调用）、按轮断言（回复正则、禁用文本、阶段、工具调用、订单数与字段、静默、转人工）。v1 文件照旧能跑（runner 认两种格式）。导出的场景放 `eval/cases-v2/*.json`；锁定的 `src/engine.selftest.ts` 与 `eval/cases.json` 不改。计数单位是 case；开工核对给出可导出的清单，验收按清单逐条核。 |
| R8  | 模拟客户评测         | 新 runner `eval/sim/`：一个「客户」模型拿到隐藏目标（目的地意向、人数、日期、预算、约束、会不会确认下单、什么时候要人工），与真实引擎对话至多 N 轮；判分只看业务终态（订单字段、没确认不建单、该转人工时转了、没有编造的非金额承诺），由确定性代码判，不用模型打分。pass^k：同一目标跑 k = 5 遍，5 遍全过才算过。真实模型、手动跑、每次跑有费用上限（开放问题 3），结果进 plan。                                                                        |
| R9  | 消息部件（03 R17）   | 引擎的回复在 `text` 之外带 `parts?: MessagePart[]`：每个白名单链接一个 `{ kind: 'link', linkKind: 'order' \| 'proposal', url, title }`。`text` 与现在逐字节相同（企微的卡片提取照旧从文本做，锁定的 `wecom.selftest.ts` 不动）；网页渠道改用 `parts` 渲染卡片，不再自己从文本里解析链接。渠道声明能力 `ChannelCaps`，本阶段只用来让引擎知道渠道渲不渲 markdown（现在由 `stripMarkdown` 一律去掉，行为不变）。                                           |
| R10 | 中立锁定节（03 R18） | 包提供锁定节模板（带 `{brandName}`、`{advisorTitle}`、`{channelPhrase}` 这类占位符）；SOP 契约里引用品牌与渠道的规则改成按品牌档案生成期望文本。demo 租户的锁定节仍取镜像原文，逐字节不变；新租户发布时用模板渲染。console 照旧不能改锁定节。                                                                                                                                                                                                           |
| R11 | 解析与币种           | `Money = { amount: number; currency: 'CNY' }`，本阶段只支持人民币；识别到外币单位（美元、日元……）时结果带 `currency: null` 与原单位，旅游的处理与现在相同（现在是当作没有出处的金额）。金额识别下限、容差、团体政策进包的阈值。工具参数的硬校验（ISO 日期、人数 1–50）留在工具执行端，不并进自然语言解析（两者契约不同）。mock 的解析留在 mock 里（它的默认值语义与引擎不同）。                                                                         |
| R12 | 阈值分类             | 分三类：**算法参数**（历史窗口、工具循环轮数、重复判定、失败判定）进 `core` 的常量，不进包；**行业政策**（金额下限与容差、团体人数与折扣、旺季系数、搜索放宽、可订日期范围、节假日表）进包的 `policy`；**运行配置**（超时、对冲、并发、跟进间隔）保持现有环境变量。旅游包的默认值等于现值。                                                                                                                                                             |
| R13 | 虚构品牌验证         | 仓库里放一份「山海旅行」品牌档案 fixture（只在测试与评测里用）：同一份旅游 SOP 与产品库，换这个品牌渲染，mock 回归全过；system prompt 与 demo 的差异只在品牌占位符处。                                                                                                                                                                                                                                                                                  |

## 接口与数据流

### 模块与依赖方向

```
src/core/            主流程、护栏流水线、解析、工具运行时、包接口（不 import packs）
  pack-api.ts        PackRuntime、Guard、ToolSpec、BrandProfile、MessagePart、ChannelCaps 等类型
  engine/            handleMessage 主流程（约 150 行）与通用步骤（接管、并发、历史窗口、context 拼装）
  guards/            流水线执行器、通用护栏（清理、markdown、半句、顾问前缀、身份、接管检查、失败计数）
  parse/             金额、日期、人数
  tools/             工具注册、执行分派、副作用标记
src/packs/travel/    旅游包：工具、旅游护栏、价格规则、日期与节假日政策、mock、检索文本、跟进模板、洞察提示、阶段与画像、品牌默认值、锁定节模板
src/packs/registry.ts  pack_id → { IndustryPack（后台）, PackRuntime（运行时） }
src/engine.ts 等老路径   门面：只转发锁定套件引入的名字（R1）
```

### `PackRuntime`

```ts
// src/core/pack-api.ts（新）
export interface PackRuntime {
  id: string; // 与 tenants.pack_id、IndustryPack.id 相同
  defaultBrand: BrandProfile;
  /** 【硬性要求】段落；demo 品牌渲染出的字节与现在的 renderSystemPrompt 相同 */
  renderHardRequirements(brand: BrandProfile): string;
  lockedSectionTemplates: Record<string, string>; // 节 key → 带占位符的锁定节原文（R10）
  contractRules(brand: BrandProfile): SopContractRule[];
  tools: ToolSpec[]; // 顺序即 tools 数组顺序，进 toolsHash
  guards: Guard[]; // 包自己的护栏，按 id 插进核心流水线的位置（R4）
  stages: StageSpec[]; // 销售阶段与推进规则（核心只认 terminal 与 handoff 两个语义）
  profileFields: ProfileFieldSpec[]; // 画像字段；hasModelAccess=false 的不进模型请求（昵称、头像）
  policy: PackPolicy; // 行业政策阈值（R12）
  prefetch?(ctx: TurnContext): Promise<PrefetchResult | null>; // 预取（旅游的线路检索）
  contextNote(ctx: TurnContext): string[]; // 每轮 context 的行业部分
  retrievalText(item: CatalogItem): string;
  followupTemplates: FollowupTemplates;
  insightPrompts: InsightPrompts;
  mock: MockPolicy; // LLM_MOCK=1 时的行业行为
}

export interface BrandProfile {
  brandName: string; // 「云途定制旅行」
  advisorTitle: string; // 「旅行顾问」
  aiTitle: string; // 「AI 旅行顾问」
  scopeNoun: string; // 「旅行」：与业务无关时说「这是{scopeNoun}顾问」
  channelName: string; // 「微信」：「直接输出发给客户的{channelName}正文」
  channelPhrase: string; // 「在微信上」
  identityLine: string; // 客户问身份时的整句
}

export interface ToolSpec {
  def: ToolDef; // 现有 tool-defs 的形状；序列化字节进 toolsHash
  sideEffects: ReadonlyArray<'session' | 'order' | 'handoff' | 'notify'>;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface Guard {
  id: string; // 开工核对清单里的标识，如 'link_whitelist'、'price'、'identity'
  after?: string[];
  scope: 'reply' | 'followup' | 'both';
  run(ctx: GuardContext): Promise<GuardVerdict> | GuardVerdict;
}
export type GuardVerdict =
  | { action: 'pass' }
  | { action: 'rewrite' | 'replace' | 'drop'; text: string }
  | { action: 'handoff'; text: string; reason: string }
  | { action: 'order'; text: string; orderId: string };
```

`GuardContext` 带本轮的会话、回复文本、删句前快照、工具与订单出处、品牌档案、包政策，以及只读的接管检查与有副作用的方法（`createOrder`、`enterHandoff`、`callTool`），护栏不直接 import 存储。

### 主流程

`handleMessage` 拆成固定的几步，每步是核心函数或包的钩子：前置返回（重置、紧急、已接管、同意菜单——现有的几条前置路径原样）→ 记客户消息 → 画像抽取（包的 `profileFields` 与核心解析）→ 预取（包）→ 拼 context（核心 + 包的 `contextNote`）→ 模型与工具循环（核心，工具经注册表分派）→ 护栏流水线 → 写会话、记 trace。并发与接管的语义（生成中顾问接管、生成中客户付款）不变，接管检查仍在流水线前后各一次。

### 品牌渲染

`renderSystemPrompt(sop)` 变成 `renderSystemPrompt(sop, brand, pack)`：`sop` + 空行 + 包的 `renderHardRequirements(brand)`。旅游包用 demo 品牌渲染的结果必须与开工时 `renderSystemPrompt(sop)` 逐字节相同（不变量 2）。DB 模式在 SOP 发布时连同品牌一起渲染、存哈希（01 的发布流程不变，只多一个输入）；文件模式每轮现渲染，品牌取包默认值（文件模式没有租户行）。

### 消息部件

`handleMessage` 的返回在现有字段之外加 `parts?: MessagePart[]`；链接白名单护栏（`link_whitelist`）在保留一个链接时同时产出部件，`proposal_suffix` 恢复版本号之后部件里的 URL 与文本里的相同。企微适配器忽略 `parts`。网页渠道（`src/adapters/web.ts`、`public/web.js`）用部件渲染卡片；没有部件的历史消息照旧按文本显示。

### 数据库

- `tenants` 加列 `brand json`（可空）。迁移只加列，不回填。
- trace 事件类型加 `guard_verdicts`（`turn_traces` 的事件 json 里一项），不改表结构。
- 没有别的表变化。

### 评测

- `eval/run.ts` 认 v1 与 v2；v2 的夹具在临时 `VAR_DIR` 与 PGlite 上准备；假模型脚本复用自测里的 `Step` 形状。
- `eval/sim/run.ts`：`--goals <文件>`、`--k 5`、`--budget <元>`、`--model <名>`；输出每个目标 k 次的终态判定与 pass^k 汇总、模型费用。
- `package.json` 的 `test` 跑 v2 的 mock 部分（文件配置与 PGlite 配置两种）；模拟客户与真实模型的 v1/v2 不进 CI。

## 不变量

1. demo 租户的 `PREFIX sha256`（system 与 tools）在每一步结束时都等于开工值。
2. 旅游包 + demo 品牌：`renderSystemPrompt` 的输出与开工提交逐字节相同；`JSON.stringify(toolDefs)` 逐字节相同。
3. 锁定套件 8 个文件零修改、全绿；它们从老路径引入的每个名字仍可引入、行为相同。
4. `src/core/**` 不 import `src/packs/**`。
5. 护栏执行顺序等于开工清单的顺序；违反 `after` 声明的注册在启动时失败。
6. 每轮主回复恰好一条 `guard_verdicts` 事件，列出每个执行过的护栏，放行也在内。
7. 同一份输入、同一份假模型脚本：抽取前后客户收到的文本、阶段、订单、工具调用逐字节或逐字段相同（cases v2 与 mock eval 的结论不变）。
8. 画像里标为不进模型的字段（昵称、头像）在任何模型请求里都不出现。
9. 品牌档案只改品牌占位符处的文字；虚构品牌与 demo 的 system prompt 差异只在占位符处。
10. 网页渠道里能点开的链接都来自 `parts`，`parts` 里的 URL 都过了白名单。

## 兼容与迁移

- 抽取按「先导出、再搬家」：先有 cases v2 与模拟客户基线（旧引擎上跑绿、跑出 pass^k 基线），再一块一块搬，每块搬完全量与 v2 照绿。
- 老路径门面永久保留到锁定套件解锁那一天（另起 spec 决定），不是过渡代码。
- `tenants.brand` 为空的租户（含 demo）用包默认品牌，不需要数据迁移；回滚到 03 的镜像：新列被忽略，没有风险（不进回滚检查）。
- 品牌改动影响前缀哈希：改完重新发布 SOP 才生效，与改 SOP 同一条路径。

## 安全、隐私与性能

- 护栏流水线只是重排调用方式，安全相关的护栏（链接白名单、价格、注入、身份）顺序与判定不变；`after` 校验防止以后插入新护栏时把它们挤到错误位置。
- 品牌档案不含凭据；`tenant-brand set` 写审计（只记改了哪些字段）。
- 每轮多一条 trace 事件，单条事件只有 22 个以内的短标识与动作，不带原文。
- 主流程多一层包钩子分派，不加网络往返；mock 回归的单轮耗时与开工时相比不超过 +5%。

## 验收标准

1. **前缀与锁定。** 每一步结束时锁定套件零修改、全绿，`PREFIX sha256` 两个值与开工时相同；最后一步对开工提交 `git diff` 锁定文件为空。
2. **依赖方向。** 往 `src/core/` 里任一文件加一行 `import … from '../packs/travel/…'`，`pnpm lint` 失败；去掉后通过。`src/core/engine/` 里 `handleMessage` 的核心路径不超过 150 行（不含类型与注释）。
3. **品牌。** demo 品牌渲染的 system prompt 与开工提交逐字节相同；虚构品牌「山海旅行」渲染之后，与 demo 的差异只出现在品牌占位符处（逐行 diff 核对），用它跑 v2 的 mock 回归全过，客户收到的身份说明是「山海旅行」的。prod profile 下 `tenant-create` 不带品牌以 2 拒绝；`tenant-brand set` 写一条审计，重新发布 SOP 之后 `/healthz` 的 `promptHash` 变化、再改回 demo 品牌后变回开工值。
4. **护栏流水线。** 一组覆盖每个护栏至少命中一次的 v2 用例：抽取前后客户收到的文本逐字节相同；每轮 trace 里有一条 `guard_verdicts`，护栏标识的顺序等于开工清单，放行的护栏也在内；把一个护栏的 `after` 改成依赖排在它后面的护栏，启动失败并打印两个标识；跟进路径的子集顺序与开工时相同。
5. **cases v2。** 开工清单里的每个可导出场景都有对应的 v2 case；它们在开工提交（旧引擎）上 mock 全绿，在最后一步上 mock 全绿，结论逐条相同。v1 的 `eval/cases.json` 照旧能跑、结论与开工时相同。
6. **模拟客户与 pass^k。** 至少覆盖：推荐 → 报价 → 确认下单（订单字段与目标一致）、没确认不建单、明确要人工时转人工、问库外目的地不编线路、注入尝试不被劫持；每个目标真实模型跑 5 遍。抽取前（开工提交）与抽取后各跑一次，结果与费用记进 plan；抽取后任一目标的通过次数比抽取前少 2 次以上，记进「Open」由 owner 决定是否放行。
7. **解析与阈值。** 旅游的金额、日期、人数解析在 v2 与 `price-guard.selftest.ts`（锁定）上结论不变；改旅游包的金额识别下限为 500，一句「每人 800 元」被价格护栏当作需要出处的金额（改回 1000 时不管），证明阈值来自包；识别到「200 美元」时金额带 `currency: null`，旅游的处理与开工时相同。
8. **消息部件。** 一条带订单链接与方案书链接的回复：`parts` 里两个部件、URL 与文本里的相同；企微收到的文本与卡片与开工时逐字节相同（锁定的 `wecom.selftest.ts` 照过）；网页渠道显示两张卡片，站外链接与不在白名单里的链接不可点；没有 `parts` 的历史消息照旧显示。
9. **中立锁定节。** 用虚构品牌从包模板发布一个新租户的 SOP：锁定节里没有「微信」与「云途」，SOP 契约检查通过；demo 租户的锁定节与开工时逐字节相同；console 改不了锁定节。
10. **假包与注册表。** 测试里注册一个最小的假包（一个工具、一个护栏、一个阶段），核心照常装载它、跑一轮 mock 对话，核心代码没有为它改一行；没注册的 `pack_id` 启动失败、报出这个 id。
11. **demo 照常。** 03 验收 16 那一组（重置、种子保鲜、访客清理与上限、匿名只读、模拟支付、AI 标识）照旧；线上部署之后 `/healthz` 四个哈希与开工时相同，企微与网页各一句一回。
12. **性能。** mock 回归一遍的总耗时与开工提交相比不超过 +5%（同一台机器、三遍取中位数）。

## 开放问题

1. **品牌放哪。** 推荐 `tenants.brand` 列（R6）：品牌属于客户，不属于行业包；阶段 5 多租户之后每个租户自带品牌。备选是放进 SOP 的前言节（运营可在 console 改），但那会让锁定节与品牌耦合、改品牌不经平台审计。owner 定 ready 时一并确认。
2. **门面的寿命。** 推荐永久保留（R1）。锁定套件是回归的地基，解锁要单独一份 spec；门面只有转发、成本低。
3. **模拟客户评测的费用上限。** 推荐每次跑设上限 30 元（约 6 个目标 × 5 遍 × 每段对话至多 12 轮，按 `glm-5.3-flashx` 现价估算在 10 元以内，留余量），超了就停、记已跑的部分。owner 定数。
4. **prod 放开网页渠道。** 03 写的是「阶段 4 的渠道中立锁定节出来之后，由那份 spec 放开 prod 的封顶」。推荐本阶段只做中立锁定节、不放开：放开还要 prod 的网页限流与运营流程（谁看网页会话），等第一个要网页渠道的真实客户再定。owner 定。
5. **主流程 150 行的口径。** 推荐按「`handleMessage` 函数体及它直接调用的、只在核心里的步骤函数之外」计，不含类型、注释与日志行；做不到时在 plan 里记实际行数与原因，不为凑数硬拆。

## 被否决的方案

- **先抽取、后补评测。** 抽取会大动引擎，没有抽取前的 v2 基线与 pass^k 基线，改坏了只能靠锁定套件发现，而锁定套件覆盖的是旅游的老形状、不是业务终态。
- **品牌写进 SOP 正文。** demo 的 SOP 正文要逐字节不变，品牌又出现在【硬性要求】与身份护栏里，只改 SOP 改不全；改了也会让每个租户的 SOP 编辑与品牌改动混在一起。
- **一个护栏一条 trace 事件。** 每轮 22 条，trace 量翻几倍，查看时还得再拼回来；一轮一条、按顺序列出更好用。
- **把阶段 5 的多租户一起做。** 盘点显示进程内几乎所有缓存与单例都要按租户隔离，与包化是两类改动，放一起 spec 太大、评审太贵、开工太晚；拆开之后包化先交付「换品牌只改配置」的展示能力。
