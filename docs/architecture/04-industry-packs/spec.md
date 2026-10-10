# 04 · 行业包抽取

Status: draft
Phase: 4 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」（2026-10-10 拆分之后的编号）
Depends on: [03 · 渠道层 v2](../03-channels-v2/spec.md)（开工时须已 implemented）；[01](../01-pg-config-console/spec.md) 的 SOP 节表、锁定节、发布与启动重渲染；[02](../02-conversations-workbench/spec.md) 的 trace 与护栏事件（R16）；[00](../00-baseline/spec.md) 的前缀稳定检查。
Supersedes in part: 01 不变量 11「当前发布的锁定节与镜像原文逐字节相同」——改为与**租户的镜像**逐字节相同（R5）；01「渲染与哈希」的渲染输入（加品牌）与「启动重渲染」的原因（加 `brand`）；主参考「护栏」一节「每次裁决记一行 `guard_events`」——改为 `guard_events` 只记改了文字的裁决，全部裁决（含放行）记在 `turn_traces.guard_verdicts`（R8）。
Amends: 03 R17、R18 的「推到阶段 4」在本 spec 落地；03 R19 的欢迎语默认值改为按品牌渲染（demo 不变）；`deploy.sh` 与 `deploy/rollback-guard.sh` 加一类风险（R14）；01 的配置导出加品牌快照（R17）。
Revisions: 2026-10-10 起草期两轮评审（一路 Claude Opus、两轮 Codex 交叉评审）之后就地修订，尚无代码依赖。第一轮：品牌接进 01 的发布与启动重渲染（旧版模式 / 模板模式、租户的镜像、品牌快照）；护栏改成带读写声明的步骤表、跟进单列；裁决记录从「新 trace 事件」改为保留 `guard_events` 加 `turn_traces.guard_verdicts` 列；消息部件从「白名单那一步产出」改为从最终文本现算并覆盖历史与重试；外币的现状写错了（实际是按数值混认），改为照旧并记为已知缺陷；补了品牌出现处清单、包钩子与组合根、门面参数适配、cases v2 格式、模拟客户谓词、回滚风险。第二轮：回滚检查要经 `deploy.sh` 的目标判定才会触发，加 `pre-04` 并按已发布版本放行；阶段推进放回护栏之前（原稿挪到了之后，会改变行为）；前言节随品牌切换的规则；契约检查范围不缩小；工具缓存与复用的契约；配置导出带品牌快照；模拟客户的目标格式与结束协议。第三轮：阶段推进作为步骤表里的核心步骤，放在第一次接管检查之后（原稿放在整个步骤表之前，会让生成中被接管的那一轮推进阶段）；缓存复用只在现有条件下重放展示状态；导出复用目录时删掉旧的 `brand.json`；01 补反向引用。

## 背景与问题

产品要从「旅游 demo」变成「通用企业微信 AI 销售助手」，旅游只是第一个参考行业包。目前没有具体客户，本阶段的目的是展示能力：同一套引擎只改配置就换品牌、换行业。现在旅游写死在核心里，`src/packs/travel/` 只覆盖后台展示（词表、实体、阶段、SOP 节）。开工前的两份只读盘点（协调者另存，不进仓库）查到的现状：

- **旅游逻辑与通用逻辑交织。** 至少 16 个文件里有旅游概念；`src/engine.ts`（4616 行）里客群、目的地推荐、行程能力、人数与天数、日期与节假日、预取与工具参数落地合计约 3000 行，夹着通用的会话、并发、接管处理。`src/tools.ts` 的 7 个工具、`src/price-guard.ts`、`src/price-rules.ts`、`src/llm.ts` 的 mock、`src/handoff/triggers.ts`、`src/retrieval.ts`、`src/followup.ts`、`src/insight.ts` 都带旅游内容。`Session` 上有旅游私有字段（`lastQuote` 到 `missedDestinations`），`SalesStage` 是固定的 8 个值，产品快照是 routes / hotels。
- **品牌写死在客户看得到的地方。** `src/prompt/system.ts` 的【硬性要求】（「云途定制旅行」「旅行顾问」「微信」「与旅行无关的问题」）、身份说明（`src/engine.ts` 的 `IDENTITY_ANSWER`）、离题回复（`src/engine.ts:517`）、企微欢迎语（`src/adapters/wecom.ts:184-196`）、网页欢迎语（`src/web/routes.ts:124`）、mock 开场（`src/llm.ts:1101`）、快捷回复默认模板（`src/packs/travel/quick-reply-defaults.ts`）、支付页商户名（`public/pay.html`）、方案书抬头（`public/proposal.html`）、聊天页标题（`public/chat.html`）、SOP 的前言节与锁定节、SOP 契约里的「顾问会在微信上联系您」。
- **出口护栏没有统一的流水线。** 主回复路径上有 20 个护栏标识、22 个执行位置（主参考写的「13 道」是早先的数；`repair_links`、`custom_promise` 各在两处执行），夹着不走 `noteGuard` 的步骤（前置清理、两次接管检查、末尾的 `dropAdvisorPrefix` 与 `cleanText`、「待顾问确认」系统备注）。护栏之间共享本轮状态（`guardHit`、`handedOverSelfDecided`、删句前快照、改行程承诺的结论），顺序约束只体现在代码顺序里；有的护栏会建单、转人工、补调工具。主动跟进走另一条 11 步的 `guardOutbound`，标识同名、处置不同（只删句、不转人工、不补工具）。trace 的 `guard_events` 只记改了文字的裁决。
- **中文解析重复实现。** 金额、日期、人数在引擎、价格护栏、价格规则、工具、mock 里各有一套，人数至少 4 处不同实现。金额只有数值、没有币种：「每人 12800 美元」被解析成 12800，没有出处时被价格护栏拦下，客户说过 12800 元的预算时被放行。金额识别下限 1000 写在 `price-guard.ts` 6 处与 `engine.ts`、`price-rules.ts` 各 2 处。
- **阈值散落。** 16 组主要阈值与政策，有的已经能用环境变量配，有的是旅游定价政策，有的是算法参数，没有分开。
- **评测只有固定回放。** `eval/cases.json` 51 条（v1，裸数组），runner 只回放预写的客户输入；`src/engine.selftest.ts`（锁定）里的场景是测试代码，不是数据；没有模拟客户、没有 pass^k。
- **锁定套件钉着内部形状与签名。** 锁定的自测直接从 `src/engine.ts`、`src/tools.ts`、`src/price-guard.ts`、`src/price-rules.ts`、`src/followup.ts`、`src/retrieval.ts`、`src/llm.ts`、`src/insight.ts` 引入函数与测试出口（`__engineTest`、`__orderTest`、`__followupTest`），按旧签名调用（如 `executeTool(name, args, session)`、`dropUnbackedClaims(text, session, calls, { travelers })`），还钉住历史窗口的分块、wire 请求的顺序与字节、六轮工具循环、卡片提取的文本形状。

## 目标

1. **品牌与身份可配置。** 品牌名、顾问称呼、身份说明、业务范围来自租户的品牌档案；上面列的每一处客户看得到的品牌都按档案渲染。没配品牌的租户（含 demo）逐字节照旧；虚构品牌「山海旅行」的租户只改配置就能跑同一组回归，客户看到的地方没有「云途」。
2. **行业包运行时接口。** 引擎主流程、护栏流水线执行器、解析、工具运行时、模型客户端进 `src/core/`；旅游的工具、护栏、规则、mock、检索文本、跟进模板、洞察提示、阶段推进、画像抽取、词表进 `src/packs/travel/`。`src/core/` 不引用 `src/packs/`，也不经老路径绕过去。主流程（`handleMessage` 的核心路径）约 150 行。
3. **出口护栏流水线。** 主回复的每一步（含不走 `noteGuard` 的那几步）是一个声明了先后与读写的步骤；跟进路径是另一张表。旅游的回复与跟进与开工时相同；每轮的每个裁决（含放行）都记下。
4. **中文通用解析。** 金额（带币种字段）、日期、人数的解析收到 `src/core/parse/` 一处；旅游的行为不变（外币混淆这个已知缺陷照旧，见 R12）。
5. **阈值与政策分类进包。** 算法参数、行业规则、运行配置分开；旅游包的默认值等于现值。
6. **cases v2 与黑盒场景库。** 定 cases v2 的数据格式，把引擎自测里能用黑盒表达的场景导出成数据；在只加了评测工具、引擎未动的那一步上跑绿，之后每一步照样全绿。
7. **模拟客户评测与 pass^k。** 模型扮演带隐藏目标的客户，按确定性谓词判分；核心流程与护栏用例在真实模型上跑 k = 5，抽取前后各跑一次（手动、花钱、不进 CI）。
8. **消息部件与渠道能力**（03 R17）：网页渠道的链接卡片来自服务端按最终文本给出的部件；企微的文本与卡片逐字节不变。
9. **渠道中立的 SOP 锁定节**（03 R18）：配了品牌的租户，锁定节与【硬性要求】按包模板渲染、不点名渠道；没配品牌的租户照旧。

## 非目标

- 同部署多租户（公开路由按租户解析、按租户预算、进程内缓存按租户隔离、跨租户泄漏测试、从模板开通租户）、一键体验沙箱、console 里的渠道账号页：阶段 5。本阶段仍是一个实例一个租户。
- 第二个真实行业包（家装、电商售后等）与 `Session`、`Order`、`SalesStage`、画像字段、产品快照（routes / hotels）的类型泛化：阶段 7 按信号。本阶段这些类型与 DB 列不变，用「山海旅行」与一个只在测试里注册的假包证明配置化。
- 政策单一来源（价格规则、AI 标识、品牌这些由一份结构化 policy 生成 SOP 对应节）、知识库、售后退改、看板拆分、非金额承诺的拦截：阶段 6。本阶段的品牌档案是那份 policy 以后的一个输入。
- 修外币混淆（R12）：记为已知缺陷，阶段 6 的政策陈述护栏一起评估。
- 改 demo 的 SOP 正文、产品库或系统前缀：demo 的 `PREFIX sha256` 全程不变。
- prod 放开网页渠道：见开放问题 3，默认不在本阶段做。
- 多副本；私有行业包与 ADR-003 的 workspace + submodule 切换（本阶段的包都公开，没有触发条件）。

## 前置条件

- 03 `Status: implemented`，demo 线上跑 03 之后的版本。
- 锁定套件（03 的 8 个文件）照旧锁定；开工核对记下它们的 sha256 与 `PREFIX sha256`。
- 开工核对把三张清单落进 plan：门面清单（锁定套件从老路径引入的每个名字与调用签名，R1）、主回复与跟进两张步骤表（每步的标识、位置、读写的本轮状态，R7）、可导出的场景清单（R10）。

## 开工前裁决

| #   | 主题               | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | 门面               | 老路径 `src/engine.ts`、`src/tools.ts`、`src/price-guard.ts`、`src/price-rules.ts`、`src/followup.ts`、`src/retrieval.ts`、`src/llm.ts`、`src/insight.ts` 保留为门面：门面清单里的每个名字仍从原路径导出、按旧签名调用、行为不变（测试出口的键集合不变）。门面可以做参数适配（补上旅游包与 demo 品牌、把旧参数包成新的 ctx），不做业务判断。门面清单之外的名字可以移走。门面永久保留，直到锁定套件解锁（另起 spec）。                                                                                                                                                                                                                                                                |
| R2  | 依赖方向与组合根   | `src/core/**` 不 import `src/packs/**`，也不 import 门面路径；包只经 `src/core/pack-api.ts` 拿核心类型与工具函数。组合根是 `src/config/source.ts` 的启动装载：按租户的 `pack_id` 从 `src/packs/registry.ts` 取 `PackRuntime`，连同已发布的品牌快照调 `bindPack(runtime, brand)` 注入核心。`scripts/check-boundaries.ts` 加三条（core 不引 packs、core 不引门面、packs 只引 `pack-api`），违反时 `pnpm lint` 失败。现在 `config/source.ts` 直接取 `toolDefs` 与 `renderSystemPrompt`、`trace/recorder.ts` 从 `price-guard` 引 `sentenceUnits`、`llm.ts` 转发旅游 mock 的解析，都改成经核心或包接口拿。                                                                                |
| R3  | 包接口             | 现有后台用的 `IndustryPack`（`src/shared/pack.ts`）不动；运行时另定 `PackRuntime`（见「接口与数据流」），两者由注册表按同一个 `pack_id` 配对，`PackRuntime.stages` 与 `IndustryPack.stages` 同源、只能取 `SalesStage` 的子集。                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R4  | 品牌档案与两种模式 | 新列 `tenants.brand json`（可空）。**为空是旧版模式**：锁定节取 `data/sop.md` 镜像、【硬性要求】与欢迎语等用现在的原文，逐字节照旧（demo 就是这种）。**非空是模板模式**：锁定节、【硬性要求】、欢迎语、离题回复、身份说明按包模板与档案渲染，不点名渠道。把档案显式设成「云途」值也是模板模式，与旧版模式的字节不同；回到旧版模式用 `tenant-brand clear`。                                                                                                                                                                                                                                                                                                                           |
| R5  | 租户的镜像         | 锁定节的来源按租户定：旧版模式取 `data/sop.md` 镜像（现状）；模板模式取 `lockedSectionTemplates` 按档案渲染的结果，作为这个租户的镜像，`mergeWithImage`、SOP 契约检查、`imageSopHash` 都用它。导入、发布、回滚、启动重渲染四条写路径不变，只是镜像换成租户的。console 照旧不能改锁定节。                                                                                                                                                                                                                                                                                                                                                                                             |
| R6  | 品牌的生效与快照   | 渲染输入从（SOP 节）变成（SOP 节、品牌档案、包）；`render_inputs` 加 `brandHash` 与完整的品牌快照；`sop.rerender` 的原因加 `brand`。`tenant-brand set` / `clear`（平台身份，写审计，只记改了哪些字段）只改 `tenants.brand`，运行中的实例不受影响；下次启动时按原因 `brand` 自动重渲染、发布一版，之后生效。本轮用到品牌的地方（system、身份说明、离题回复、欢迎语）一律取本轮捕获的已发布版本里的品牌快照，不读 `tenants.brand`。                                                                                                                                                                                                                                                    |
| R7  | 护栏步骤           | 主回复的每一步是一个 `GuardStep`：22 个护栏执行位置（同一标识的两处用后缀区分，如 `repair_links:mark` 与 `repair_links:fill`），加上前置清理、前后两次接管检查、阶段推进（`stage_advance`，见「主流程」）、末尾清理、系统备注。每步声明 `after`、`reads`、`writes`（本轮共享状态 `turn.flags` 的键，如 `guardHit`、`handedOverSelfDecided`、`preDropSnapshot`、`customPromise`）；装载时校验：`after` 成立、读某个键的步骤排在写它的步骤之后、后置接管检查排在 `turn_failure` 之前，违反就启动失败。有副作用的步骤（建单、转人工、补调工具）经 `GuardContext` 的方法做。顺序等于开工步骤表。                                                                                         |
| R8  | 裁决记录           | `guard_events` 契约不变（02 R16）：只记改了文字的裁决，护栏名用基础标识（不带后缀），动作是现有六种。另加 `turn_traces.guard_verdicts json`（可空）：按执行顺序 `[{ id, action }]`，`action` 取 `pass`、现有六种、`abort`（接管检查中止）。进了流水线的每一轮恰好一份；前置返回的路径（重置、紧急、已接管、同意菜单）不进流水线，这一列为空。文件存储与 demo 类会话只在内存的 FinishedTurn 里有，经 `onTurnEnd` 可读。                                                                                                                                                                                                                                                               |
| R9  | 跟进路径           | 跟进单独一张 11 步的表（开工步骤表的第二张），标识可以与主回复同名，实现各自独立；跟进步骤只能调没有副作用的工具（`ToolSpec.sideEffects` 为空），不建单、不转人工、不补链接；不记 `guard_verdicts`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R10 | cases v2           | 格式见「接口与数据流 · 评测」。一条 case 是一段对话；假模型脚本按**模型请求**消费，耗尽或剩余都算失败；动态值用声明式占位（`{{call:create_order.payUrl}}`、`{{order:0.id}}`）；比较前把订单号（`ord_[0-9a-f]{24}`）与方案版本号归一。runner 起本机假模型 HTTP 服务（与自测同一种做法），不走 `LLM_MOCK` 的关键词 mock。需要在途动作的并发场景（生成中接管、生成中付款）不导出，导出映射里写明由哪个保留的自测覆盖。v1 照旧能跑。锁定的 `src/engine.selftest.ts` 与 `eval/cases.json` 不改。基线是「只加了 v2 与模拟客户 runner、引擎未动」的那一步。                                                                                                                                 |
| R11 | 模拟客户评测       | 新 runner `eval/sim/`。目标（goal）是数据：隐藏设定（意向、人数、日期、预算、约束、会不会确认下单、什么时候要人工）加一组确定性谓词。判分输入是完整对话、每轮的工具调用与结果、订单与转人工状态的轨迹；谓词作用在订单字段、转人工状态、工具调用、回复正则上，每个目标另带一份禁用短语表（非金额承诺、提示词泄露的标记句）。一段对话在客户模型说结束或满 12 轮时停。pass^k：同一目标跑 5 遍、5 遍全过才算过。每次跑有费用上限（开放问题 2），到了就停。                                                                                                                                                                                                                               |
| R12 | 解析与币种         | `Money = { amount: number; currency: 'CNY' \| null; unit: string }`：认得的人民币单位是 `CNY`，外币单位（美元、日元……）是 `null` 并带原单位。本阶段**不改行为**：价格护栏照旧按数值比对出处（「12800 美元」与 12800 元的出处照旧相互认）；这是已知缺陷，修它会改变客户看到的结果，留给阶段 6。金额识别下限、容差、团体规则进包的阈值。工具参数的硬校验（ISO 日期、人数 1–50）留在工具执行端；mock 的解析留在 mock 里。                                                                                                                                                                                                                                                               |
| R13 | 阈值分类           | **算法参数**（历史窗口、工具循环轮数、重复与失败判定）进 `core` 常量；**行业规则**（金额下限与容差、团体人数与折扣、旺季系数、搜索放宽、可订日期范围、节假日表）进包的 `thresholds`；**运行配置**（超时、对冲、并发、跟进间隔）保持现有环境变量。旅游包的默认值等于现值。                                                                                                                                                                                                                                                                                                                                                                                                            |
| R14 | 回滚               | 03 之前的代码不认模板模式：回滚到 04 之前的镜像，启动重渲染会把锁定节与【硬性要求】换回「云途」「微信」。`deploy.sh` 的目标判定加 `pre-04`（目标镜像里没有 `src/core/pack-api.ts`），部署旧 tag 与健康检查失败后的自动回滚都经 `rollback-guard.sh`。风险：库里有租户的 `tenants.brand` 不为空，**或**有租户当前发布版本的 `render_inputs` 带品牌快照（clear 了但还没重启重渲染的也拦）；库问不到时，正在跑的是 04 之后的镜像就按有风险处理（与 03 同一种从严）。检查脚本以 6 退出并打印「先 `tenant-brand clear`、重启、确认 `/healthz` 的 `promptHash` 回到旧版模式的值，再回滚」；`deploy.sh` 照现有约定把检查拒绝转成 1、打印的步骤原样透出。两样都没有的照常回滚（新列被忽略）。 |
| R15 | 消息部件（03 R17） | 部件在最后一次 `cleanText` 之后从最终文本算：每个过了站内白名单的链接一项 `{ kind: 'link', linkKind: 'order' \| 'proposal' \| 'site', url }`。服务端对所有发往网页的消息（AI 回复、顾问回复、付款通知）与历史都用同一个 `partsOf(text)` 现算，不落库；HTTP 回复、同一 `cid` 的重试、`/history`、SSE 都带部件。企微忽略部件（卡片照旧从文本提取）。渠道声明能力 `ChannelCaps`，本阶段只有 `markdown: false`，行为不变。                                                                                                                                                                                                                                                               |
| R16 | 虚构品牌与假包     | 测试与评测里放「山海旅行」品牌档案 fixture 与它自己的 SOP 前言节（同一份旅游产品库与可编辑节）。假包放 `src/packs/__fixture/`，只在设了 `PACK_FIXTURES=1` 时由注册表登记：它有自己的工具名、阶段推进与一个护栏步骤，用来证明核心没有暗含旅游规则。                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R17 | 配置导出           | 见「配置导出与文件模式」：导出带已发布的品牌快照，文件模式据此渲染，往返哈希相同。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 接口与数据流

### 模块与依赖方向

```
src/core/              不 import packs，也不 import 门面
  pack-api.ts          PackRuntime、GuardStep、ToolSpec、BrandProfile、MessagePart、ChannelCaps 等类型；bindPack
  engine/              handleMessage 主流程与通用步骤（接管、并发、历史窗口、context 拼装）
  guards/              步骤表执行器、校验、通用步骤（清理、markdown、半句、顾问前缀、身份、接管检查、失败计数）
  parse/               金额、日期、人数
  tools/               工具注册、执行分派、前后钩子
  llm/                 模型客户端（从 src/llm.ts 搬来；mock 的行业部分由包提供）
src/packs/travel/      旅游包
src/packs/__fixture/   假包（只在测试里登记）
src/packs/registry.ts  pack_id → { IndustryPack（后台）, PackRuntime（运行时） }
src/config/source.ts   组合根：装载配置时 bindPack
老路径（门面）          只转发与参数适配（R1）
```

### `PackRuntime`

```ts
// src/core/pack-api.ts（新）
export interface PackRuntime {
  id: string; // 与 tenants.pack_id、IndustryPack.id 相同
  // 品牌与 SOP
  defaultBrand: BrandProfile; // 只用于模板模式下缺字段时的补全，旧版模式不用
  legacy: LegacyTexts; // 旧版模式的原文（【硬性要求】、身份说明、离题回复、欢迎语），逐字节等于开工时
  templates: BrandTemplates; // 模板模式：【硬性要求】、锁定节、前言节、身份说明、离题回复、欢迎语，占位符见 BrandProfile
  sopSections: SopSectionDef[]; // 节表（今天的 TRAVEL_SOP_SECTIONS）
  contractRules(mode: 'legacy' | { brand: BrandProfile }): SopContractRule[];
  knownFields: { names: string[]; sourceFiles: string[] }; // SOP 契约的已知字段与它们的出处文件（漂移测试扫这些文件）
  // 对话
  stages: { id: SalesStage; terminal?: boolean }[]; // SalesStage 的子集，与 IndustryPack.stages 同源（R3）
  tools: ToolSpec[]; // 顺序即 tools 数组顺序，序列化字节进 toolsHash
  beforeTool?(name: string, args: unknown, ctx: ToolContext): { args: unknown } | { reject: string };
  afterTool?(name: string, result: ToolResult, ctx: ToolContext): void;
  extractProfile(text: string, session: Session): Partial<CustomerProfile>; // 画像抽取（字段仍是现有 8 个）
  advanceStage(session: Session, turn: TurnOutcome): SalesStage | null; // 阶段推进；核心只认 terminal 与 handoff 的语义
  prefetch?(ctx: TurnContext): Promise<PrefetchResult | null>;
  contextNote(ctx: TurnContext): string[]; // 每轮 context 的行业部分
  preModel?(ctx: TurnContext): DeterministicReply | null; // 模型前的确定性判定（行业部分）
  replySteps: GuardStep[]; // 包自己的主回复步骤，按 after 插进核心步骤表
  followupSteps: GuardStep[];
  vocab: { handoff: HandoffVocab; dejargon: DejargonVocab };
  thresholds: PackThresholds; // R13
  retrievalText(item: CatalogItem): string;
  followupTemplates: FollowupTemplates;
  insightPrompts: InsightPrompts;
  mock: MockPolicy; // LLM_MOCK=1 时的行业行为（含 mock 自己的解析）
}

export interface BrandProfile {
  brandName: string; // 「山海旅行」
  advisorTitle: string; // 「旅行顾问」
  aiTitle: string; // 「AI 旅行顾问」
  scopeNoun: string; // 「旅行」：与业务无关时说「这是{scopeNoun}顾问」
  identityLine: string; // 客户问身份时的整句，不带结尾的「～」，身份步骤追加时补上
}

export interface ToolSpec {
  def: ToolDef; // 现有 tool-defs 的形状
  sideEffects: ReadonlyArray<'session' | 'order' | 'handoff' | 'notify'>; // 读方：跟进步骤只能调空的（R9）
  /** 同一轮同样参数的调用可以复用结果（现在由模型客户端按旅游工具名判断，改由这里声明） */
  cacheable: boolean;
  /** 本轮调过它之后，空回复不整轮重试（现在按工具名判断） */
  blocksRetry: boolean;
  /**
   * 命中缓存时：不调 execute、beforeTool、afterTool；toolReused 每次都计。只在现在 src/llm.ts 的条件成立时（同名工具上一次调用的参数与这次不同、这次命中的是更早的缓存）
   * 调 onReuse 重放展示状态（如「最近展示的线路」）；锁定的 llm.selftest.ts 钉着「北京→云南→北京→北京」只重放一次
   */
  onReuse?(result: ToolResult, ctx: ToolContext): void;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface GuardStep {
  id: string; // 开工步骤表里的标识，如 'link_whitelist'、'repair_links:fill'、'takeover_check:post'
  after?: string[];
  reads?: string[]; // turn.flags 的键
  writes?: string[];
  run(ctx: GuardContext): Promise<StepVerdict> | StepVerdict;
}
export type StepVerdict =
  | { action: 'pass' }
  | { action: 'drop_sentence' | 'replace' | 'patch' | 'append' | 'strip'; text: string; removed?: string[]; added?: string[] }
  | { action: 'handoff'; text: string; reason: string }
  | { action: 'abort' }; // 接管检查：本轮不发
```

`GuardContext` 带本轮的会话、回复文本、`turn.flags`、工具与订单出处、本轮捕获的品牌快照与包阈值，以及有副作用的方法（`createOrder`、`enterHandoff`、`callTool`）；步骤不直接 import 存储。

### 主流程

`handleMessage` 的顺序与现在相同，拆成核心函数与包钩子：前置返回（重置、紧急、已接管、同意菜单，原样）→ 记客户消息 → 行业的确定性早返回（包的 `preModel`，在现在那几条早返回的原位置执行，如重发支付链接在拼 context 与预取之前；开工步骤表逐条记下位置）→ 画像抽取（包）→ 捕获本轮状态、拼 context（核心 + 包的 `contextNote`）→ 预取（包，在拼 context 之后，与现在相同）→ 模型与工具循环（核心，工具经注册表分派，`beforeTool` / `afterTool` 在记录调用之前与之后，缓存复用见 `ToolSpec`）→ 主回复步骤表 → 写会话、记 trace。阶段推进与按工具结果补画像（包的 `advanceStage` / `extractProfile`）是步骤表里的一个核心步骤 `stage_advance`，位置与现在相同：在前置清理与第一次接管检查之后（顾问生成中接管时，本轮没发出去的工具结果不推进阶段）、在 `other_order` 与成单等业务步骤之前（兜底话术读推进之后的阶段）；建单、确定性推荐等步骤照现在的做法就地更新阶段。生成中顾问接管、生成中客户付款的语义不变。

### 品牌渲染

- `renderSystemPrompt(sop, mode)`：旧版模式是 `sop` + 空行 + `legacy.hardRequirements`，与开工时 `renderSystemPrompt(sop)` 逐字节相同；模板模式用 `templates.hardRequirements` 按品牌渲染。
- 品牌出现的每一处（背景里那张清单）都改成取本轮捕获的品牌快照：旧版模式用 `legacy` 原文，模板模式用模板渲染。账号自定义的欢迎语（03 R19）优先于两者。
- 静态页（`pay.html`、`proposal.html`、`chat.html`）里的品牌名改成服务端在返回页面时替换的占位符；旧版模式替换出的字节与现在相同。
- 前言节是可编辑节，里面有品牌名。随品牌切换的规则（启动重渲染时做）：前言节**没被运营改过**（等于切换前那个模式与品牌渲染出的前言）就换成切换后的渲染——旧版模式的前言是 `data/sop.md` 原文，模板模式的是 `templates.preamble` 按品牌渲染；**被改过**就保留原样、启动日志与 console 的 SOP 页提示「前言节里可能还有旧品牌名」，不拦发布。新租户（模板模式）发布第一版时前言节用模板渲染。
- 01 的契约检查（禁用短语、工具与字段、结构、可编辑预算……）范围不变；本阶段新增的品牌专属检查（锁定节与【硬性要求】里没有别的品牌名与渠道名）只查锁定节与【硬性要求】。

### 消息部件

按 R15。`ChatMessage` 不加字段；`partsOf(text)` 放在 `src/core/`，网页渠道的回复、重试、历史、SSE 都调它。`public/web.js` 只按部件渲染可点的链接，不再自己从文本里找链接。

### 数据库

- `tenants` 加列 `brand json`（可空），不回填；`agent_platform` 加 `GRANT UPDATE (brand) ON tenants`。
- `turn_traces` 加列 `guard_verdicts json`（可空）；`agent_app` 按 02 的列级授权方式给写权限。
- `sop_versions.render_inputs` 的 json 多两个键（`brandHash`、`brand`），不改列。
- 审计动作加 `tenant.brand_set`、`tenant.brand_clear`；`sop.rerender` 的原因加 `brand`。

### 配置导出与文件模式（R17）

01 的配置导出（`export-config`）在模板模式的租户上多写一个 `brand.json`：内容是**当前发布版本**里的品牌快照，不是待生效的 `tenants.brand`；旧版模式的导出删掉输出目录里已有的 `brand.json`（输出目录可以复用，不删会残留）。文件模式装载时，有效 `SOP_PATH` 所在目录里有 `brand.json` 就按模板模式渲染，没有就是旧版模式；导出物在文件模式下渲染出的前缀与线上发布版本的哈希相同（01 的往返核对照旧）。

### 评测

```ts
// eval/cases-v2/*.json 的一项
interface CaseV2 {
  version: 2;
  id: string;
  desc: string;
  tags: string[];
  realOnly?: boolean; // 只在真实模型下跑
  brand?: string; // fixture 名，如 'shanhai'；缺省是旧版模式
  fixtures?: {
    now?: string; // ISO 时刻，夹具时钟
    session?: Record<string, unknown>; // 预置的会话状态（阶段、画像、报价……），按现有 Session 字段
    orders?: { status: string; travelers: number; departDate: string; routeId: string }[];
  };
  turns: {
    say: string;
    script?: { content?: string; toolCalls?: { name: string; args: Record<string, unknown> }[] }[]; // 每项对应一次模型请求
    expect: {
      replyMatches?: string[];
      replyExcludes?: string[];
      stage?: string;
      tools?: string[]; // 本轮按顺序调用的工具名
      orders?: { count: number; last?: Record<string, unknown> };
      silent?: boolean;
      handoff?: boolean;
      guardVerdicts?: { id: string; action: string }[]; // 断言步骤表的裁决
    };
  }[];
}
```

- `eval/run.ts` 认 v1 与 v2；`package.json` 的 `test` 跑 v2 的 mock 部分（文件配置与 PGlite 配置两种）。
- `eval/sim/run.ts`：`--goals <文件>`、`--k 5`、`--budget <元>`、`--model <名>`；输出每个目标每遍的谓词结果与失败原因、pass^k 汇总、模型费用。

```ts
// eval/sim/goals/*.json 的一项
interface SimGoal {
  id: string;
  persona: string; // 给客户模型的隐藏设定（自然语言），如「两位老人想去不太累、低海拔的地方，预算每人一万以内，会确认下单」
  brand?: string; // fixture 名；缺省是旧版模式
  maxTurns?: number; // 缺省 12
  allowedTools: string[]; // 这段对话里允许出现的工具调用
  predicates: Predicate[];
  forbidden: string[]; // 禁用短语（非金额承诺、提示词标记句），出现在任一条回复里就不过
}
type Predicate =
  | { kind: 'order'; count: number; fields?: Record<string, unknown> } // 终态订单数与字段（如 travelers: 2）
  | { kind: 'no_order_before'; turnMatches: string } // 客户说出匹配这句的话之前不许建单
  | { kind: 'handoff'; expected: boolean }
  | { kind: 'tool_called'; name: string; min?: number; max?: number }
  | { kind: 'reply_matches' | 'reply_excludes'; pattern: string; scope: 'any' | 'all' | 'last' };
```

客户模型每轮输出一个 JSON：`{ "say": string, "done": boolean }`；`done` 为真或满 `maxTurns` 时停。输出不是合法 JSON 时重试一次，再不合法就这一遍记失败、原因 `customer_protocol`（不算引擎的错，汇总里单列）。plan 里至少写一个完整目标作为样例。

## 不变量

1. 旧版模式租户（demo）的 `PREFIX sha256` 在每一步结束时都等于开工值；`JSON.stringify(toolDefs)` 逐字节相同。
2. 锁定套件 8 个文件零修改、全绿；门面清单里的每个名字仍可引入、按旧签名调用、行为相同。
3. `src/core/**` 不 import `src/packs/**` 与门面路径。
4. 主回复步骤的执行顺序等于开工步骤表；违反 `after`、`reads` / `writes` 或「后置接管检查在 `turn_failure` 之前」的注册在启动时失败。
5. 进了流水线的每一轮恰好一份 `guard_verdicts`，列出每个执行过的步骤，放行也在内；`guard_events` 的内容与开工时同一份输入下相同。
6. 跟进步骤不建单、不转人工、不调有副作用的工具。
7. 同一份 case、同一份假模型脚本：抽取前后客户收到的文本、阶段、订单字段、工具调用在归一订单号与方案版本号之后相同。
8. 画像里不进模型的字段（昵称、头像）在任何模型请求里都不出现。
9. 本轮用到的品牌一律来自本轮捕获的已发布版本；`tenants.brand` 改了而没重启，客户看到的不变。
10. 网页里能点开的链接都来自服务端给的部件；部件里的 URL 都过了站内白名单。

## 兼容与迁移

- 「先导出、再搬家」：先加 v2 与模拟客户 runner（引擎不动），跑出 v2 基线与 pass^k 基线；再按门面清单与步骤表一块一块搬，每块搬完全量与 v2 照绿。
- `tenants.brand` 为空的租户（含 demo）不需要数据迁移，行为照旧。
- 回滚：按 R14，品牌为空可以回到 03；配了品牌的要先 clear。
- 品牌改动会改前缀：改完下次启动自动重渲染，与改【硬性要求】的代码发版走同一个机制。

## 安全、隐私与性能

- 步骤表只是重排调用方式，安全相关的步骤（链接白名单、价格、注入、身份、接管检查）的顺序与判定不变；`after` 与读写校验防止以后插入新步骤时把它们挤错位置。
- 品牌档案不含凭据；审计只记改了哪些字段。
- `guard_verdicts` 每轮一份，条数等于开工步骤表的步数（约三十），只有短标识与动作，不带原文（原文已在 trace 的回复与 `guard_events` 里）。
- 主流程多一层包钩子分派，不加网络往返。

## 验收标准

1. **前缀与锁定。** 每一步结束时锁定套件零修改、全绿，demo 的 `PREFIX sha256` 两个值与开工时相同；最后一步对开工提交 `git diff` 锁定文件为空。
2. **依赖方向。** 往 `src/core/` 里任一文件加一行 `import … from '../packs/travel/…'`，或加一行 `import … from '../engine.js'`（门面），`pnpm lint` 失败；去掉后通过。`handleMessage` 的核心路径不超过 150 行（口径见开放问题 4）。
3. **品牌（旧版模式不变）。** demo 不配品牌：system prompt、身份说明、离题回复、两种欢迎语、mock 开场、快捷回复默认模板、支付页、方案书、聊天页与开工时逐字节相同。
4. **品牌（模板模式）。** 「山海旅行」租户：新客欢迎、回访欢迎、身份问答、离题回复、支付页商户名、方案书抬头里是「山海旅行」、没有「云途」也没有「微信」；锁定节与【硬性要求】里没有「微信」与「云途」，SOP 契约检查通过；用它跑 v2 的 mock 回归全过；它的 system prompt 与 demo 的逐行差异记进 plan。
5. **品牌的生效。** `tenant-brand set` 之后不重启：客户看到的与 `/healthz` 的 `promptHash` 都不变；重启：审计里一条 `sop.rerender`（原因 `brand`），`promptHash` 变了，身份说明是新品牌；`tenant-brand clear` 再重启：前言节没改过时 `promptHash` 回到开工值。导出往返：模板模式导出、文件模式渲染的前缀哈希等于线上；clear、重启之后向同一目录再导出一次，`brand.json` 没了、文件模式回到旧版模式的哈希。前言节的三种切换各验一遍：旧版 → 山海、山海 → 另一个虚构品牌、山海 → clear；没改过的前言跟着换、品牌名对；改过的保留原样、启动日志与 SOP 页有提示。prod profile 下 `tenant-create` 不带 `--brand-file` 以 1 拒绝。`tenant-brand set` 写一条只含字段名的审计。
6. **回滚检查。** 本机演练，真实 docker，经 `deploy.sh`：库里有品牌不为空的租户、部署 03 的 tag：检查脚本 6、`deploy.sh` 拒绝并打印 clear 的步骤；clear 但没重启（当前发布版本仍带品牌快照）：仍拒绝；重启之后放行；品牌为空时照常回滚；健康检查失败后的自动回滚同样经过这道检查。
7. **步骤表。** 一组让每个步骤至少命中一次的 v2 case：抽取前后客户收到的文本相同（归一之后），`guard_events` 相同；每轮一份 `guard_verdicts`，标识顺序等于开工步骤表，放行也在内；接管检查中止的那一轮是 `abort`；前置返回的那一轮为空。把一个步骤的 `after` 改成依赖排在它后面的步骤、或让它读一个后面才写的键，启动失败并打印两个标识。
8. **跟进。** 跟进的 11 步与开工时同一份输入下结论相同；一条会触发改行程承诺、缺链接与转接承诺的跟进文本：只删句，不建单、不转人工、不调工具。
9. **cases v2。** 开工清单里的每个可导出场景都有对应的 v2 case；在基线那一步与最后一步 mock 全绿、结论逐条相同；导出映射里列出不导出的场景与覆盖它们的保留自测。v1 照旧能跑、结论与开工时相同。
10. **模拟客户与 pass^k。** 至少覆盖：推荐 → 报价 → 确认下单（订单字段与目标一致）、没确认不建单、明确要人工时转人工、问库外目的地不编线路、注入尝试（谓词：回复里没有禁用短语表里的提示词标记句、没有调用目标没允许的工具）；每个目标真实模型跑 5 遍。基线与最后一步各跑一次，谓词结果与费用记进 plan；任一目标的通过次数少 2 次以上，记进「Open」由 owner 决定。
11. **解析与阈值。** 旅游的金额、日期、人数在 v2 与 `price-guard.selftest.ts`（锁定）上结论不变；「每人 12800 美元」解析为 `{ amount: 12800, currency: null, unit: '美元' }`，价格护栏的处理与开工时相同（无出处拦、有 12800 元出处放行）。把旅游包的金额识别下限改成 500：「每人 800 元」被当作需要出处的金额；改回 1000 时不管。
12. **消息部件。** 一条带订单链接与方案书链接的 AI 回复：网页上两张卡片、URL 与文本里的相同；经链接修补补进来的链接也有卡片；被后续步骤删掉的链接没有卡片；静默的一轮没有部件。刷新、重启、同一 `cid` 重试之后卡片相同；顾问回复里的站内链接照旧可点；站外链接不可点。企微收到的文本与卡片与开工时逐字节相同。
13. **阶段与画像来自包。** 假包登记之后：用它自己的工具名与阶段推进跑一轮 mock 对话，阶段按假包的规则推进，核心代码没有为它改一行；不登记时旅游照常。旅游的阶段推进与画像抽取在 v2 上结论不变。
14. **demo 照常。** 03 验收 16 那一组（重置、种子保鲜、访客清理与上限、匿名只读、模拟支付、AI 标识）照旧；线上部署之后 `/healthz` 四个哈希与开工时相同，企微与网页各一句一回。
15. **性能。** v2 的 mock 回归跑一遍的总耗时，与基线那一步相比不超过 +5%（同一台机器、三遍取中位数）。

## 开放问题

1. **品牌放哪。** 推荐 `tenants.brand` 列（R4）：品牌属于客户，不属于行业包；阶段 5 之后每个租户自带品牌。备选是放进 SOP 前言节（运营可在 console 改），但品牌还出现在【硬性要求】、身份说明、欢迎语与静态页里，只改前言改不全，改品牌也不经平台审计。owner 定 ready 时一并确认。
2. **模拟客户评测的费用上限。** 推荐每次跑上限 30 元（约 6 个目标 × 5 遍 × 至多 12 轮，按 `glm-5.3-flashx` 现价估算在 10 元以内，留余量）。owner 定数。
3. **prod 放开网页渠道。** 03 写的是「阶段 4 的渠道中立锁定节出来之后，由那份 spec 放开 prod 的封顶」。推荐本阶段只做中立锁定节、不放开：放开还要 prod 的网页限流与运营流程（谁看网页会话），等第一个要网页渠道的真实客户再定。owner 定。
4. **主流程 150 行的口径。** 推荐按 `handleMessage` 函数体计，不含类型、注释、日志行与它调用的核心步骤函数；做不到时在 plan 里记实际行数与原因，不为凑数硬拆。

## 被否决的方案

- **先抽取、后补评测。** 抽取会大动引擎，没有抽取前的 v2 与 pass^k 基线，改坏了只能靠锁定套件发现，而锁定套件覆盖的是旅游的老形状、不是业务终态。
- **把档案显式设成「云途」值当作 demo。** 那样 demo 就进了模板模式，【硬性要求】要么为了逐字节相同保留「微信」（新租户的模板就不能中立），要么改了 demo 的前缀。分成旧版模式与模板模式，两头都成立。
- **品牌写进 SOP 正文。** demo 的 SOP 正文要逐字节不变，品牌又出现在【硬性要求】、身份说明、欢迎语与静态页里，只改 SOP 改不全。
- **一个护栏一条新 trace 事件。** 每轮二十多条，trace 量翻几倍；保留 `guard_events` 的语义、加一列存完整的裁决序列更省也更好查。
- **在 `link_whitelist` 那一步产出部件。** 之后的链接修补会补链接、后面的步骤会删句或整条替换，部件会过期；从最终文本现算才可靠。
- **把阶段 5 的多租户一起做。** 盘点显示进程内几乎所有缓存与单例都要按租户隔离，与包化是两类改动；放一起 spec 太大、评审太贵、开工太晚。
