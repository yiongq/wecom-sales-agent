# 10 · 工业品询价包 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；R、不变量、验收、开放问题的编号都指本 spec。本 spec 已由 owner 于 2026-10-26 定为 `ready`；2026-10-26 开工核对已补各步的「做 / 验 / 依赖」。未执行实现步骤，未勾选的步骤与原编号保持不变；九条开工核对裁决与六条评审补充已写入「已定」，Open 无；R17 回滚方案 B 已由 owner 于 2026-10-26 随 ready 确认。

## 开工条件

缺一条就停下，告诉 owner：

1. 08 已 `implemented` 并上线；09 为 `ready`，第 0–14 步代码已合入 `dev`（4ff0d93）。owner 2026-10-26 定 09 暂不上线，第 15–18 步等 10 完成后合并做；09 先翻 `implemented` 不再是 10 的开工条件。
2. 本 spec `Status: ready` 已满足（2026-10-26，owner 确认，R17 方案 B 同时确认；开放问题 2026-10-23 已定，九条核对裁决见「已定」）；ADR-005、主参考拍板表与目录外反向引用已随本次 ready 文档改动补齐，待同一 docs PR 合入。
3. 本机能跑 format / lint / typecheck、`test:locked`、受影响的自测、v2 假模型回归（文件与 PGlite 两条），能起一次性 `pgvector/pgvector:pg17` 容器。
4. 真实模型评测只由协调者在沙箱外跑（第 15 步），整份 ≤¥10。
5. 部署与演示租户的开通要 owner 当次授权（第 16 步）；演示租户的域名另记，不进仓库。

## 开工须知（新会话从这里开始）

- 先读 `AGENTS.md`、本 spec 与 08、09 spec 全文、`docs/spec-driven-dev.md`、本文件的「Open」「已定」与「交接记录」，再看 `git log -5`。
- 锁定的 8 个文件见 AGENTS.md，一个字节都不改。旅游的前缀全程不换。
- **测试随批合入**：每一批带上本批的验收测试，合并时是绿的。
- **数据**：产品库、case、目标都只用合成数据。型号照公开的编号规则编，品牌、价格、库存都是虚构的。不下载、不提交任何厂商资料。
- 不进仓库、也不进本文件的：域名、服务器 IP、主机与路径、本机绝对路径、企微标识与凭据、客户原文。

## 步骤

- [x] 0. 做：复核下方 08、09 接口对照，列出旅游 `HandoffVocab` 104 个键的处理表，采集实际开工提交的旅游基准，在预发环境跑 R16 开通前检查；验：接口可复查、词表逐键有归类、前缀 / 四类输出 / 卡片 / 部件 / v2 有具名基准，Host 检查有记录（验收 1、6、10）；依赖：开工条件 1–3，涉及预发外部环境须有对应操作授权。本批已完成接口、104 键表与开工基准；预发 R16 检查待授权，移至上线前复验，只挡上线、不挡实现（见本批实施记录）。
- [x] 1. 做：核心加声明式 `itemRules`，让 `checkItem` 与 schema 读取同一声明，接 `crossItemCheck` 调用时机（R2）；验：五种规则的正反例两侧一致，草稿与上架 / 编辑 active 的边界符合验收 2，既有 active → draft 禁令不变且不增加下架触发点；依赖：0。
- [x] 1.1 做：包骨架（新建 `src/packs/industrial/runtime.ts`，用作 R17 镜像标记）、登记、白名单、`part` 字段与 schema、条目规则、跨条目检查、CSV（R1、R2）；验：合成条目导入为草稿，编号 / 重复型号 / 替代型号 / 两位小数 / 改价版本符合验收 2；依赖：1，ADR-005 已随 ready 合入。
- [x] 2. 做：型号归一与匹配顺序（R3）；验：验收 3 的精确、别名、歧义排序、无命中、知识库召回逐项通过，语义路径另记含 embedding 的端到端时延 / 样本量 / 环境；依赖：1.1。
- [x] 3. 做：`priceLine`（R4）；验：档位、起订量、库存三种情况与整数分算式符合验收 4；40 条产品、最多 30 行的内存匹配加定价 p95 ≤ 50 ms，记录环境 / 样本量，不含网络、装载与持久化；依赖：2。
- [x] 4. 做：四个工具、`amounts`、R7 的有界 `rfqDraft`，建单入参映射为 `{ kind: 'part', code, qty }[]`；按接口表声明副作用、缓存与重试，并显式投影 empty_lines / kind_unknown / item_inactive / invalid_qty / below_moq（R5）；验：30 / 31 行、逐行金额 / 合计、五种及混合拒绝、待审保密符合验收 4、6、7，只有 below_moq 带 moq；拒绝无新报价 / 通知，未知或异常不冒充 below_moq；实际写入与声明一致、跟进排除四工具；依赖：3；容量与淘汰联验待 6。
- [x] 5. 做：接入已有 `quotes`、自动批准、`siteLinks`（含 `resources`、`partTitle`）、卡片、`engineHooks`；核心 `quotes` 增加可选 `notes`，服务端按 R13 的状态与租户范围调用（R6、R13）；验：新建缺省人审与三项自动批准条件、默认人审后人工批准再重复建单复用原 approved / 链接 / 金额且不重审或重复通知、复用待审仍 pending、链接隔离、标题 / 文案、approved / paid 的 notes、其余状态和无钩子响应符合验收 7，冻结金额不变；依赖：4。
- [x] 6. 做：会话状态、画像、重置与阶段推进，工作台接 `onQuoteDecided`，AI 回合接 `advanceStage`；摘要只保留编号 / 版本 / 数量 / 匹配类型 / 时间，型号通过已有内存版本接口取，缓存整项淘汰（R7）；验：手审 / 自动批准进入促成、驳回 / 撤回回报价，30 行必留状态 ≤ 6,144 字节、含转义 / 多字节与超长缓存项的完整状态 ≤ 8,192 字节，四键重置；淘汰不改变 R6 / R11 判断（验收 8）；依赖：5。
- [x] 7. 做：主回复护栏与跟进只删句版本，核心新增 `linkWhitelistFollowupStep` 并与主回复共享窄删除逻辑；适配 `src/core/followup.ts` 的生成器 / followUpText / 文件扫描和 `src/jobs/followup.ts` 的任务执行体：白名单启用包保留完整 ord_ URL 交登记 / allowed 判断，护栏删空返回空串，两条调度路径在额度预占和跟进记账前跳过；数据库任务 cancelled / guard_empty 不立即重排，旅游继续原订单号清洗及删空后换模板。`rfq_trim` 按最终删行数重算 N、给补句留预算，保护内容超限走固定兜底（R8、R9、R14）；验：真实跟进生成链路（只桩 LLM / 发送端）的合法报价 URL 完整发出 / 非法链接删除、删空无发送 / 额度占用 / 消息 / 次数和元数据增长，文件与数据库两路全覆盖；验收 5 的短行 10+5、二次裁剪 / 部分保留、保护句终止、金额出处及链接边界，主回复工厂 / guard 记录与旅游模板输出 / 计数不变；依赖：4–6。
- [x] 8. 做：按第 0 步的逐键表处理词表（R10）；验：104 键无遗漏，旅游专有键的反例与工业改写键的正例符合验收 6；依赖：0、4。
- [x] 9. 做：非标 / 超长 / 确认报价的判定表，接 `fixedId`、`handoff`、`notify`、`statePatch` 与 `contextNote`（R11）；共享同一 now 下的 quoteState 候选筛选与固定排序：事件时间降序、同时间草稿优先、订单再按 createdAt / id 降序；验：验收 6 的四种确认情况、全部终态排除、同毫秒草稿 / 订单与多单打乱遍历顺序仍同结论，两个入口一致；跨消息边界、固定句全文匹配、patch 校验、首次确认提醒去重；依赖：5、6、8。
- [x] 10. 做：SOP 模板、契约规则、policy、品牌、一致性登记（R12），统一「新建缺省人审，自动批准按 R6；复用不重审」与裁剪固定兜底；验：三节可改、五节锁定、无旅游词 / 渠道名，policy / 固定句 / 审批缺省一致，验收 9 的发布前静态检查通过；依赖：1.1；工具与固定句最终联验待 4、5、7、9。
- [x] 11. 做：跟进、洞察、mock、后台配置、快捷回复、字体子集（R14）；验：用合成企微会话、注入时钟覆盖两个 24 小时阶段与待审抑制，复核第 7 步文件 / 数据库两路真实生成到发送的非空 / 删空、额度与次数行为（验收 8），界面加载 / 空 / 错误态与字体检查通过；依赖：6–10。
- [x] 12. 做：至少 30 条工业 cases v2（R15），保留现有 `fixtures.now` 与对话动作，不扩 v2 审批种子；验：文件与 PGlite 模式全过，旅游快照逐条不变（验收 1、9）；依赖：11。
- [x] 13. 做：至少 20 个 regression 目标（其中至少 8 个 safety），仅扩模拟目标的嵌套审批种子，沿用 `FIXTURE_CLOCK` / `fixtureClock()`（R15）；验：pending / approved 时间与状态组合校验、批准有效 / 已过期确认可复现，保留单槽 pending_payment 校验和旧种子无审批语义，初始化无通知；`handoffKind` / `richTools` 生效，mock 目标集通过（验收 9）；依赖：12。
- [x] 14. 做：约 40 条合成产品及同内容 CSV（R16）；验：四类齐全、JSON 与 CSV 语义相同，导入 / 上架 / 匹配 / 改价符合验收 2–4；依赖：1.1、2、3，最终联验依赖 11–13。
- [ ] 15. 做：中期审查 diff、接口 / 数据边界与质量门，逐条核对 10 验收 1–9，并合并补验 09 第 15 步的本机部分（09 验收 1–13）；落实 R17 的 pre-10 guard、手动 tag 树 / 自动镜像判定与两路接线，隔离测试先通过再部署；协调者跑真实模型 k = 5；验：两份 spec 各有证据与待线上项目，pre-10 的三类风险 / 未知 / 空库 / 含 10 目标覆盖且不删数据，结果 / 费用入本 plan，不达标记 Open；依赖：0–14，开工条件 4；09 既有记录只作基准，联合改动后需复核受影响项。
- [ ] 16. 做：owner 当次授权后，09 与 10 一次上线 `demo-v10-rc1`，开通 `industrial-demo`、设置 Host、开网页渠道、导入产品库、发布 SOP；验：10 验收 10 与 09 验收 1 的线上补证同时完成，宿主 / 沙箱 revision 与健康、旅游四哈希 / 既有订单与看板、企微及网页一句一回、新沙箱冒烟有记录；依赖：15、开工条件 5，R17 已随 ready 确认且仅前滚 / 含 10 tag 的恢复路径已核实。部署前备份与异地副本、预发 R16 复验、线上不启用证明包，沿用 09 plan 的上线清单。
- [ ] 17. 做：在一次性测试库与隔离部署环境演练 R17、10 验收 11，并复核 09 R15 / 验收 13 的 pre-09 检查；验：手动部署和健康失败自动回滚均按新建 runtime 文件识别目标；part 条目 / industrial 租户 / 工业报价三类风险分别单独存在、停用 / 终态 / 重置历史、未知查询均 guard=9 / deploy=1，提示「前滚修复，或者回滚到另一个含 10 的 tag」。三项均无时只放行 pre-10；含 10 目标仍过其他检查；无工业数据但有任意 approval 历史时，pre-09 仍拒绝。记录目标、数据、退出码与提示；依赖：16，第 15 步已实现并预验 R17。全程只读，不停用 / purge / 删历史，不对线上做破坏演练。
- [ ] 18. 做：逐条复核 10 验收 1–11 与 09 验收 1–13，合并完成 09 第 16 步；验：每条标通过 / 部分通过 / 未过，关联本机、CI、截图、真实 PG、联合上线与两道回滚证据；偏离交 owner 决定；依赖：15–17。
- [ ] 19. 做：与 09 第 17 步一起清理临时探针、测试产物、容器、后台进程及不再使用的临时 worktree / 分支；验：无遗留进程 / 容器，diff 只含交付内容，耐久回归测试保留，共享与无关资源不动；依赖：18。
- [ ] 20. 做：与 09 第 18 步合并收尾，09、10 各自验收核实且各获 owner 确认后，分别翻 `Status: implemented`，按授权发版到 `main`；验：两份 plan 各有验收与确认记录，提交 / tag 可追溯，未获确认的一份不代翻；依赖：19，owner 确认及发版授权。

## 工作量、依赖与并行

默认按编号串行，编号与顺序保持原稿；第 15 步依赖 0–14，不依赖尚未执行的上线和收尾步骤（原「其余全部步骤」会成环）。各步依赖是前置完成条件，不要求把同批的关联验收重复执行。

| 批次 | 步骤   | 相对工作量 | 主要工作                         |
| ---- | ------ | ---------- | -------------------------------- |
| A    | 0      | 中         | 接口、词表、旅游基准与预发检查   |
| B    | 1、1.1 | 大         | 共享条目规则、写路径与工业产品库 |
| C    | 2–6    | 大         | 匹配、定价、工具、报价及会话状态 |
| D    | 7–9    | 大         | 护栏、词表与确定性回复           |
| E    | 10–11  | 中         | 话术、policy、跟进及后台配置     |
| F    | 12–20  | 大         | 评测、演示、联合上线与收尾       |

- 第 10 步的配置起草可在 1.1 后进行；最终联验仍等工具与固定句。第 11 步依赖状态、护栏与话术，不能整步与第 7–9 步并行。本次不安排并行 agent；以后拆分须用独立 worktree 并先约定共享接口。
- 实现每批交付跑四门：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`；新增自测进入既有测试链，锁定文件不改，旅游前缀、四类输出、卡片、部件与 v2 逐步对照基准。真实模型只在第 15 步按预算跑。
- 本次仅文档开工核对，按任务只跑 `pnpm format:check` 与 `git diff --check`，不跑全量 `pnpm test`、真实模型或外部服务。所有可能挂起的命令加超时。
- 18–20 保持「全量验收 → 清理 → owner 确认后更新 Status」；09 的 15–18 分别由本计划 15–17、18、19、20 覆盖，原 09 文档本轮不改。

## 实施记录

### 开工核对（2026-10-26，对照 dev 4ff0d93）

首次是文档核对，未执行第 0 步的旅游基准采集、104 键分类或预发检查。已读根目录规则、SDD 修订规则、08 终稿、09 六条 Revisions 与 B–E 实施记录，并打开 10 所引用的 04 / 05 / 06 / 07、ADR-003 / 004、后台 UX 与源码核对。08 已 implemented；09 ready、代码已合入；10 仍 draft。09 已有的截图与本机演练记录见其 plan「中期验收」，不在本轮重做，也不作为 10 的实现验收。

#### 接口与条款对照

下表的源码行号均按 4ff0d93；「待扩展」是 10 的工作，不冒称已有接口。首次核对提出的 Open 1–9 已按协调者答复落入 spec，裁决见「已定」。

| 核对项                 | 当前契约与 10 的落点                                                                                                                                                                                                                                            | 依据                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 条目声明               | `CatalogKindSpec` 已有 schema / 锁定 / 版本 / 金额 / retrieval；`crossItemCheck` 待 10 R2 扩展                                                                                                                                                                  | `src/core/pack-api.ts:711-719`；08 R2、接口                                                                                                                          |
| 字段规则               | `EntityType.itemRules` 尚不存在；现有 `checkItem(entity, payload)` 按字段配置检查。10 R2 加的是五种规则，原「四种」是计数笔误                                                                                                                                   | `src/shared/pack.ts:98-120、492`；ADR-004 决策 1、4；后台 UX 不变量 15                                                                                               |
| 条目编号               | payload 的 `id` 对应系统字段键 `$code`；字段类型是 `text`，`$code` 不是 FieldType                                                                                                                                                                               | `src/shared/pack.ts:14-30`；`docs/features/console-ux/spec.md:174`；`src/packs/__fixture/runtime.ts:48、105`                                                         |
| 通用订单与拒绝         | `LineOrder.approval?: QuoteApproval` 已有；`priceLine` 拒绝映射到核心 `rejected[].reason/detail`，工业工具需投影自己的摘要                                                                                                                                      | `src/core/order-view.ts:27-54、128-173`；`src/core/pack-api.ts:813-817`；08 R3、09 R2                                                                                |
| 建单                   | `createLineOrder(session, picks, opts?)` 的 picks 必须带 kind；`opts.approval` 优先、其次 `quotes.approval`。返回 order / reused 或 rejected，不直接返回工具 JSON                                                                                               | `src/core/order-view.ts:108-114、174、184-215`；证明包投影 `src/packs/__fixture/runtime.ts:500-516`                                                                  |
| 自动批准               | `quotes` 含 `approval: true`、`validDays(policy)`、可选 `autoApprovable(order, session)`；建单时只判一次，复用不重审；证明包已演示按行版本读取库存                                                                                                              | `src/core/pack-api.ts:767-771`；`src/core/order-view.ts:189-206`；`src/packs/__fixture/runtime.ts:435-447`；09 R2、R6                                                |
| 链接 / 卡片 / 资源     | `siteLinks` 是 `SiteLinkDef[]`；`allowed` 可复用 `quoteLinkAllowed`；`card` 与 `partTitle` 分管企微 / 网页；报价 API 资源只登记 GET                                                                                                                             | `src/core/pack-api.ts:755-774`；`src/core/site-links.ts:12-16`；`src/packs/__fixture/runtime.ts:130-138`；09 R10                                                     |
| 阶段与跟进             | 跟进沿用只面向企微的资格条件，网页演示不新增主动跟进；`onQuoteDecided` 只处理工作台动作；AI 回合自动批准 / 取代走 `advanceStage`。`followupGate(session, stage)` 已在两种跟进路径使用                                                                           | `src/payment/orders.ts:98-105`；`src/core/order-view.ts:203-215`；`src/core/pack-api.ts:773-790`；`src/core/followup.ts:114-119`、`src/jobs/followup.ts:284`；09 R16 |
| 确定性回复             | 四个新增字段为 fixedId / handoff / notify / statePatch；带后三者必须有 fixedId，patch 只进 packState 并过 schema，转人工原因 1–120 字；过期上下文走独立 `contextNote` 钩子                                                                                      | `src/core/pack-api.ts:257-263、789-790`；`src/core/engine/index.ts:311-346`；09 R11                                                                                  |
| 固定句与提醒           | `FixedReply.pattern?: RegExp` 须匹配全文；`notify` 是含 reason 与 orderId 的对象；核心 `recordQuoteAccepted` 用 `approval.acceptedAt` 持久去重，包的 confirmedQuoteAt 不代替它                                                                                  | `src/core/consistency.ts:31-33`；`src/core/engine/index.ts:318-326`；`src/payment/orders.ts:197-209`；06 R21、09 R8 / R11                                            |
| 报价文字               | `quoteRejectedText` / `quoteWithdrawnText` 在 `engineHooks`；`PublicQuote.notes` 类型和页面已有，服务端供给入口未接；10 R13 新增可选 quotes.notes 并限制公开状态（已定 1）                                                                                      | `src/core/pack-api.ts:855-857`；`src/core/order-view.ts:238-246`；`src/server.ts:865-876`；09 R5、R9                                                                 |
| 金额出处               | `ToolSpec.amounts` 记入 moneyLedger（整数分、最多 200 条）；两种 money_provenance 工厂已有，订单来源排除未批准单，待审报价工具不声明正式金额                                                                                                                    | `src/core/tools/registry.ts:24-33`；`src/core/money-provenance.ts:23-24`；`src/core/guards/money-provenance.ts:26-36`；08 R8、09 R1                                  |
| 评测谓词               | `handoffKind` 是 handoff 谓词的可选成员，保留 kind / expected；`richTools` 仍是同一份 ShapePolicy 字段                                                                                                                                                          | `eval/sim/goals.ts:18-23`；`src/core/pack-api.ts:536-546`；09 R12、R13                                                                                               |
| 审批夹具的归属         | `SimGoal.initial.orders` 源自 06，08 R11 扩为通用单，09 只将旧种子显式设为无审批；10 的扩展应指 04 R11、06「回归集目标的扩展」、08 R11，复用 09 的 QuoteApproval；10 R15 仅扩模拟种子、嵌套 approval.decidedAt，沿用 FIXTURE_CLOCK；旧种子 / 单槽不变（已定 3） | `docs/architecture/06-reply-quality/spec.md:461-475`；`eval/sim/goals.ts:101-126`；`eval/sim/runtime.ts:325-335`；09 plan E 批                                       |
| policy、发布闸与知识库 | 工业政策字段是 `PackPolicy<P>` 承载的数据 P，不是给核心接口增同名字段；沿用 07 R1、R7–R9、R11–R13，kind 按 08 R9 泛化                                                                                                                                           | `src/core/pack-api.ts:691-708`；`docs/architecture/07-knowledge-aftersales/spec.md:390-399`                                                                          |
| Host、预算与限流       | 原 Host 两段行号仍正确；05 R2 / R4 管多 standard Host，R15 的 standard 预算只软告警；网页账号 dailyTurns 与每 IP 限流是已有入口                                                                                                                                 | `src/tenancy/hosts.ts:30-45、65-71`；`src/tenancy/budget.ts:135-161`；`src/web/routes.ts:56、156-162、209-222`                                                       |
| 回滚现状               | 08 检查只面向 pre-08；09 对 pre-09 检查全库 approval，不漏终态与重置历史。没有任意包兼容性检查，也没有 pre-10 档位；10 R17 新增独立检查，以工业 runtime 文件识别目标，风险存在拒绝退 pre-10（已定 2）；仍待实现                                                 | `deploy/rollback-guard.sh:260-332`；`deploy.sh:164-167`；08 R13、09 R15                                                                                              |

#### 六条评审补充的源码依据（2026-10-26）

- 下架禁令：`drizzle/0001_rls_auth.sql:124-127`、01 spec R8、后台 UX spec `docs/features/console-ux/spec.md:571`；10 只对齐，不新增下架设计。
- 跟进生成与删空：`src/core/followup.ts:139-165` 目前先删 ord_、护栏删空后换模板；文件扫描 `:241-280` 没有空串分支。数据库 `src/jobs/followup.ts:207-225、248-258` 在后续预占 / 记账，故第 7 步必须补核心适配；02 R17 / R18、04 R9 / R13 与 09 R10 是 amendment 归属。
- 建单复用与拒绝：`src/core/order-view.ts:128-173` 为四种核心拒绝及 priceLine 拒绝；`:174-206` 先选可复用的 pending / approved，再仅对新单判 autoApprovable。工业工具不能把复用审批重判或将全部拒绝误报成 below_moq。
- 确认候选：`src/core/order-view.ts:84-90` 的 quoteState 统一终态判断；10 R11 保留 pending / approved / expired，排除其他状态，再用新增的固定同时间排序；核心状态函数本身不改。

#### 本轮实质对齐

- 前置条件从「08、09 均 implemented 并上线」改为 owner 新定的「08 已上线，09 ready 且代码已合入」；09 的 15–18 与 10 联合验收、一次上线、分别确认状态，映射见步骤 15–20。
- 建单补 kind / 返回投影，报价配置补真实签名与缺省优先级，链接补资源方法与网页标题，阶段区分动作钩子与 AI 回合，确认回复补四字段 / 固定句全文校验 / 核心去重；依据见上表。没有重新实现 09 已交付的能力。
- `priceLine` 拒绝改为已有能力；金额来源明确沿用 09 的收紧；夹具 amendment 改为准确的原契约归属，policy 数据与 PackPolicy 接口区分、07 / 05 依赖补条款号；`itemRules` 四改五、`$code` 从类型改回键，均不改变原有规则与编号语义。
- R16「企微客服账号可选」对齐 owner 已定的本期仅网页；不重新选择渠道或用量。本次不能核实真实部署的「每天 500 次」取值，开放问题 6 保留历史决定，开通时由 owner 按当时旅游 demo 配置复核。
- 计划保持 0–20 与 1.1 的原编号 / 顺序 / 未勾选状态，补做 / 验 / 依赖及联合收尾；消除第 15 步依赖「其余全部步骤」的循环，以及第 11 步可与其前置实现整步并行的误导。

### 第 0 步 · 开工核对与基准（2026-10-26）

#### 开工提交与范围

- 本批开工提交 `c34b4e3`；`git log -5` 已读。工作区开工时干净，08 / 09 产品代码等于 `4ff0d93`；`git diff --stat 4ff0d93 HEAD -- . ':(exclude)docs'` 实际输出为空、退出 0，证明此后只有文档改动。
- 本批只维护本 plan：第 0 步、此实施记录、末尾交接。spec 保持 ready，不改产品代码、锁定八文件、夹具或基线，不新增测试框架或夹具。
- **预发 R16 开通前检查：待授权。** 按本批任务将三项 Host 检查移至上线前（第 16 步）：宿主 public_host 与 PUBLIC_BASE_URL 一致、旅游公开路由仍命中旅游租户、新租户 Host 只命中自己。只挡上线、不挡后续实现；本批未访问预发或其他外部环境。

#### 当前 HEAD 接口抽查（20 处）

逐项打开定义与调用方复核上方 08 / 09 对照，以下行号按 `c34b4e3`。全部与既有对照一致；「待扩展」仍由 10 后续步骤实现，不改旧记录。

| #   | 核对项与定位                                                                                         | 当前结论 / 10 的落点                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/core/pack-api.ts:711-719`                                                                       | CatalogKindSpec 含 schema、titleKey、锁定、版本计价字段、moneyFields、retrieval；无 crossItemCheck，留第 1.1 步。           |
| 2   | `src/shared/pack.ts:98-120、492`                                                                     | EntityType 无 itemRules，checkItem 仍按 fields 校验；五种声明式规则留第 1 步。                                              |
| 3   | `src/shared/pack.ts:14-30`；`src/packs/__fixture/runtime.ts:48`                                      | `$code` 是系统字段键，类型仍 text，payload 存 id；工业不能新增 FieldType。                                                  |
| 4   | `src/core/order-view.ts:27-54`                                                                       | LineOrder v2、非空 lines、整数分 totalFen 与可选 QuoteApproval 已有，无须新订单形状。                                       |
| 5   | `src/core/order-view.ts:108-114、174`                                                                | createLineOrder 异步收 kind / code / qty，opts.approval 优先于包缺省；返回 order / reused 或 rejected。                     |
| 6   | `src/core/order-view.ts:128-173`                                                                     | 四种核心拒绝加 priceLine.reject/detail 已有；混合拒绝整单不写，工业五种投影留第 4 步。                                      |
| 7   | `src/core/order-view.ts:174-215`                                                                     | 复用先于 autoApprovable，只对新单自动批准；approved 优先复用，pending 新单才排审批通知。                                    |
| 8   | `src/core/pack-api.ts:767-771`；`src/packs/__fixture/runtime.ts:435-447`                             | quotes 的 approval / validDays / autoApprovable 已有，证明包按版本读库存；工业三条件自己实现。                              |
| 9   | `src/core/order-view.ts:84-105`                                                                      | quoteState 统一终态与有效期；quoteValidUntil 读当前租户 policy，按上海自然日到最后一毫秒。                                  |
| 10  | `src/core/pack-api.ts:755-763`；`src/packs/__fixture/runtime.ts:130-138`                             | SiteLinkDef 已有 card / partTitle / allowed / resources；证明包 quote 数据接口只登记 GET。                                  |
| 11  | `src/core/site-links.ts:8-16、27-54`                                                                 | 订单读取走当前租户内存；quoteLinkAllowed 还检查 session 和 approved，核心 / 包登记分开。                                    |
| 12  | `src/core/pack-api.ts:773-790`；`src/payment/orders.ts:98-105`                                       | onQuoteDecided 在工作台动作写入中推进阶段，AI 自动批准仍经 advanceStage；followupGate 是可选钩子。                          |
| 13  | `src/core/followup.ts:114-119、139-165`；`src/jobs/followup.ts:284`                                  | 两路径已有 followupGate；生成器仍删 ord_、护栏删空仍换模板，完整链接与删空跳过留第 7 步。                                   |
| 14  | `src/core/pack-api.ts:257-263`；`src/core/engine/index.ts:311-346`                                   | fixedId / handoff / notify / statePatch 已有；副作用须有登记固定句，patch 过 schema，只写 packState，pack 原因限 1–120 字。 |
| 15  | `src/core/consistency.ts:31-33`；`src/core/engine/index.ts:318-326`；`src/payment/orders.ts:197-209` | pattern 全文匹配；首次确认用 acceptedAt 持久去重并排任务，不用包内 confirmedQuoteAt 替代。                                  |
| 16  | `src/core/pack-api.ts:855-857`；`src/core/order-view.ts:238-246`；`src/server.ts:865-876`            | 驳回 / 撤回文字钩子和 PublicQuote.notes 类型已有；quotes.notes 与服务端受限调用未有，留第 5 步。                            |
| 17  | `src/core/tools/registry.ts:24-33`；`src/core/guards/money-provenance.ts:26-36`                      | amounts 校验整数分、账本最多 200 项；订单金额只认无审批或已批准，待审不作为正式金额来源。                                   |
| 18  | `eval/sim/goals.ts:18-23、101-126`；`eval/sim/runtime.ts:325-335`；`src/core/pack-api.ts:536-546`    | handoffKind / richTools 已有；通用模拟种子尚无 approval 且显式 approval:false，10 只在第 13 步扩模拟器。                    |
| 19  | `src/core/pack-api.ts:691-708`；`src/tenancy/hosts.ts:30-45、65-71`                                  | policy 是包声明的数据；多 standard 要完整 Host，宿主检查 base，单 standard 仍有原兼容行为；未访问线上。                     |
| 20  | `deploy/rollback-guard.sh:260-332`；`deploy.sh:164-167`                                              | 既有 pre-09 查全库 approval，pre-08 独立检查；尚无 pre-10，工业 runtime 标记与拒绝逻辑留第 15 步。                          |

#### HandoffVocab 逐键处理表（R10，供第 8 步使用）

依据：接口 `src/core/pack-api.ts:332-437`、旅游值 `src/packs/travel/handoff-vocab.ts:708-813`、消费者 `src/handoff/trigger-rules.ts`。下表按旅游导出顺序逐键列出，依据列给出旅游定义起行；共 **104 键：通用照搬 80 键、旅游专有置为不匹配 4 键、工业改写 20 键**，无新增、重复或漏项。词表不会产生新的 kind；R11 的非标 / 来图 / 账期 / 样品 / 超长与确认报价由 preModel / contextNote 处理，`kind: 'pack'` 只来自确定性回复。

取舍：混合了通用与旅游措辞的键归「工业改写」，只去旅游分支、替换工业业务对象，保留通用解析与隐私边界；纯旅游正则置为 `/(?!)/`。医疗和受伤沿用核心已有类型与限制，不扩工业事故识别。通用辅助正则含旅游场景也可能用到的字，不等于旅游专有触发。表中正例是相应词表的命中 / 排除语义，不保证单个辅助键独自触发转人工。

第 8 步须将每条「反例」做成旧旅游键可命中、工业键不命中的断言，并联验高反 / 行程变更不产生旅游转人工；每条「正例」覆盖改写键及其消费者语义，含排除的例子应断言不误触发。当前仅登记样例，尚未新增或执行工业测试。要人工、投诉、退款、注入的通用规则还分别在 engineHooks / 安全网等入口（`src/packs/travel/runtime.ts:179-183`、`src/packs/travel/turn.ts:444-454`、`src/packs/travel/reply-helpers.ts:73、1354`），并非这 104 键中的额外隐藏键；后续照搬其通用语义，不复制旅游话术或增加词表成员。

| 键                    | 分类               | 旅游语义                                           | 工业包处理                                                                                                              | 第 8 步样例                                          | 旅游定义依据           |
| --------------------- | ------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------- |
| `TRAD`                | 通用照搬           | 常用繁体字转简体                                   | 完整照搬归一映射，不把字符映射当行业触发词                                                                              | —                                                    | `handoff-vocab.ts:5`   |
| `TRAD_RE`             | 通用照搬           | 定位繁体字以调用映射                               | 按同一 TRAD 建表达式                                                                                                    | —                                                    | `handoff-vocab.ts:169` |
| `COND`                | 通用照搬           | 假设小句及后续小句排除                             | 保留如果、万一等条件语义                                                                                                | —                                                    | `handoff-vocab.ts:172` |
| `HEARSAY`             | 通用照搬           | 听说、网上、他人转述                               | 保留转述排除                                                                                                            | —                                                    | `handoff-vocab.ts:175` |
| `PAST`                | 通用照搬           | 以前、昨天等既往经历                               | 保留过去时排除                                                                                                          | —                                                    | `handoff-vocab.ts:179` |
| `PAST_CUT`            | 通用照搬           | 现在、今天、但是打断过去时                         | 保留当前事件边界                                                                                                        | —                                                    | `handoff-vocab.ts:183` |
| `HEARSAY_CUT`         | 通用照搬           | 结果、这次打断转述                                 | 保留转述边界                                                                                                            | —                                                    | `handoff-vocab.ts:186` |
| `NOW_LEAD`            | 通用照搬           | 小句开头的此刻标记                                 | 保留当前陈述识别                                                                                                        | —                                                    | `handoff-vocab.ts:189` |
| `ASKING_TAIL`         | 通用照搬           | 吗、呢、了没等问句尾                               | 保留敏感信息及撤回同意的问句识别                                                                                        | —                                                    | `handoff-vocab.ts:192` |
| `ASKING_WORDS`        | 通用照搬           | 疑问词、正反问                                     | 保留通用问法                                                                                                            | —                                                    | `handoff-vocab.ts:194` |
| `NOT_A_QUESTION`      | 通用照搬           | 说了多少遍、动不动等非问句                         | 保留反问与陈述排除                                                                                                      | —                                                    | `handoff-vocab.ts:198` |
| `NEG_BEFORE`          | 通用照搬           | 关键词之前的否定字                                 | 保留否定排除                                                                                                            | —                                                    | `handoff-vocab.ts:201` |
| `E_ALTITUDE_MARKER`   | 旅游专有置为不匹配 | 高原、高反及地名的类型优先标记                     | 用永不匹配正则，不把医疗词归为 altitude                                                                                 | 反例：我们在拉萨，海拔4000米                         | `handoff-vocab.ts:245` |
| `E_ALTITUDE_OVERLAP`  | 旅游专有置为不匹配 | 与 medical 重合时优先判高反                        | 用永不匹配正则，通用医疗仍由 medical 规则处理                                                                           | 反例：我们在高原一直吐，喘不上气                     | `handoff-vocab.ts:249` |
| `EMERGENCY_RULES`     | 工业改写           | 高反、受伤、急病、证件丢失、旅途受困的有序规则数组 | 仅保留通用 injury / medical 规则及其原有限定；移除 altitude / documents / stranded 旅游救援规则，不加工业事故新类型或词 | 正例：我现在手割伤了，一直流血；我现在喘不上气       | `handoff-vocab.ts:252` |
| `CARELESS`            | 通用照搬           | 不小心不是否定                                     | 保留意外陈述识别                                                                                                        | —                                                    | `handoff-vocab.ts:310` |
| `E_HYPO`              | 通用照搬           | 假设、将来尚未发生                                 | 保留未发生事件排除                                                                                                      | —                                                    | `handoff-vocab.ts:314` |
| `E_PRETRIP`           | 旅游专有置为不匹配 | 出发前、报名、节假日、适不适合参团                 | 用永不匹配正则，移除出行前排除分支                                                                                      | 反例：出发前下周报名这个团                           | `handoff-vocab.ts:318` |
| `E_NEAR`              | 工业改写           | 差点、已好转、找到证件或回到酒店等已解决事件       | 保留差点、好转、痊愈等通用排除；去掉回酒店、集合点、证件补办等旅游分支                                                  | 正例：我刚才手割伤了，现在已经不疼了（排除紧急）     | `handoff-vocab.ts:323` |
| `E_HABIT`             | 通用照搬           | 体质、病史、每次等惯常状态                         | 保留非即时事件排除                                                                                                      | —                                                    | `handoff-vocab.ts:334` |
| `E_PRICE`             | 工业改写           | 骨折价、贵到吐血等价格语境                         | 保留金额、价格、费用、账单排除，去掉团费                                                                                | 正例：你们轴承价格贵到吐血（不判医疗）               | `handoff-vocab.ts:337` |
| `E_JOKE`              | 通用照搬           | 玩笑词与表情                                       | 保留紧急判断中的玩笑排除                                                                                                | —                                                    | `handoff-vocab.ts:341` |
| `E_POLICY`            | 工业改写           | 退团、退款、保险、改期的政策问法                   | 保留退款、赔偿、报销等通用政策排除，去掉退团及旅游保险 / 改期措辞，不代替退款执行                                       | 正例：我受伤了能退款吗（政策问法，不判紧急）         | `handoff-vocab.ts:344` |
| `E_HEARSAY`           | 工业改写           | 家人、朋友或导游领队转述                           | 保留通用转述对象，去掉导游、领队等旅游角色                                                                              | 正例：同事说我手割伤了（转述排除）                   | `handoff-vocab.ts:347` |
| `E_NEG_BEFORE`        | 通用照搬           | 紧贴紧急词之前的否定                               | 保留没有、不、未等排除                                                                                                  | —                                                    | `handoff-vocab.ts:355` |
| `E_UNSURE`            | 通用照搬           | 可能、好像、担心等不确定                           | 保留精确优先，拿不准不判                                                                                                | —                                                    | `handoff-vocab.ts:358` |
| `E_EXAGGERATE`        | 通用照搬           | 贵到、笑到、快要等夸张                             | 保留夸张排除                                                                                                            | —                                                    | `handoff-vocab.ts:362` |
| `E_AFTER_SKIP`        | 通用照搬           | 受伤过、受伤以后等经历或时间                       | 保留非当前事件排除                                                                                                      | —                                                    | `handoff-vocab.ts:366` |
| `E_ATTACHED`          | 通用照搬           | 关键词后已发生的了、啦、咯                         | 保留当前事实识别及问句排除                                                                                              | —                                                    | `handoff-vocab.ts:369` |
| `E_HAPPENED_BEFORE`   | 通用照搬           | 发生了、遇到了等前缀                               | 保留已发生识别                                                                                                          | —                                                    | `handoff-vocab.ts:373` |
| `E_FEVER`             | 通用照搬           | 39度等体温读数                                     | 保留通用医疗限定，不把工业规格独立当医疗事件                                                                            | —                                                    | `handoff-vocab.ts:376` |
| `E_NOW`               | 通用照搬           | 现在、正在、一直吐等即时标记                       | 保留正在发生限定                                                                                                        | —                                                    | `handoff-vocab.ts:379` |
| `E_ONGOING`           | 工业改写           | 持续症状及下不了山等旅途受困                       | 保留持续医疗、受伤后果，去掉下山、返程等旅游受困分支                                                                    | 正例：我现在高烧不退                                 | `handoff-vocab.ts:382` |
| `E_FALL_HURT`         | 通用照搬           | 摔倒之后起不来、骨折等后果                         | 保留摔倒须有后果的限定                                                                                                  | —                                                    | `handoff-vocab.ts:386` |
| `E_FALL_THING`        | 通用照搬           | 摔的是手机、箱子等物件                             | 保留物件与人受伤的区别                                                                                                  | —                                                    | `handoff-vocab.ts:390` |
| `E_VEHICLE_STUCK`     | 工业改写           | 车船坏后回不去、下不了山                           | 去掉下山旅游措辞，保留通用走不了等后果词；本期无 vehicle 规则，不单独触发                                               | 正例：车开不动，走不了（辅助词命中，不新增救援规则） | `handoff-vocab.ts:393` |
| `E_WOUND`             | 通用照搬           | 伤在哪儿或怎么伤的                                 | 保留流血必须有部位或原因的限定                                                                                          | —                                                    | `handoff-vocab.ts:396` |
| `E_FINE_AFTER`        | 通用照搬           | 后续小句说没事、小伤                               | 保留已无危险排除                                                                                                        | —                                                    | `handoff-vocab.ts:399` |
| `E_TRAPPED_AT`        | 工业改写           | 被困在山上、半山腰、路上                           | 去掉半山腰等旅游专门分支，保留通用地点后缀；本期无 trapped 规则，不单独触发                                             | 正例：在电梯里（辅助地点命中）                       | `handoff-vocab.ts:403` |
| `E_TRAPPED_ABSTRACT`  | 通用照搬           | 被困在问题、工作、会议等抽象语境                   | 保留抽象语境排除；无 trapped 规则时不触发                                                                               | —                                                    | `handoff-vocab.ts:406` |
| `E_NOT_STUCK`         | 通用照搬           | 开心、舍不得等并非真的被困                         | 保留非受困语境排除；无 stranded 规则时不触发                                                                            | —                                                    | `handoff-vocab.ts:409` |
| `E_ELSEWHERE`         | 工业改写           | 天灾发生在那边、目的地                             | 去掉目的地，保留那边、那里、当地；本期无 disaster 规则，不单独触发                                                      | 正例：那边着火了（辅助异地排除）                     | `handoff-vocab.ts:412` |
| `E_RESCUE_LEAD`       | 通用照搬           | 帮我、快、请等求救前缀                             | 保留叫救护车等通用求救限定                                                                                              | —                                                    | `handoff-vocab.ts:415` |
| `E_HELP`              | 工业改写           | 怎么办、医院、补办、使馆、联系导游、下山           | 保留通用求助与医疗问法，去掉使馆、导游、领队、下山等旅行救援措辞                                                        | 正例：我现在喘不上气，怎么办                         | `handoff-vocab.ts:419` |
| `E_IDENTITY`          | 通用照搬           | 问真人、机器人或 AI 身份                           | 保留问身份不掩盖紧急陈述                                                                                                | —                                                    | `handoff-vocab.ts:422` |
| `E_GREETING`          | 通用照搬           | 你好、在吗等招呼                                   | 保留招呼不掩盖紧急陈述                                                                                                  | —                                                    | `handoff-vocab.ts:424` |
| `E_UNKNOWN`           | 通用照搬           | 不知道、不确定等自述                               | 保留拿不准的语境识别                                                                                                    | —                                                    | `handoff-vocab.ts:427` |
| `E_ASKING`            | 工业改写           | 一般问句及能去、参加、报名、出发等旅游问法         | 保留通用疑问、数量、能不能等，去掉参加 / 报名 / 出发旅游短语；型号数量问法仍算问句                                      | 正例：6205-2RS要多少件                               | `handoff-vocab.ts:430` |
| `E_EVERY`             | 通用照搬           | 吃什么吐什么等任指重复                             | 保留任指与真问句的区别                                                                                                  | —                                                    | `handoff-vocab.ts:434` |
| `E_ARRANGE`           | 工业改写           | 改退行程、酒店、航班等安排问法                     | 换成产品询价的报价、订单、改价、运费、发票、发货等业务问法；仍只是求助问句的排除条件                                    | 正例：帮我看看订单能不能改（业务问题）               | `handoff-vocab.ts:437` |
| `COMPANION_PHRASE`    | 工业改写           | 同行朋友、同团客人等明确同行表达                   | 保留跟我一起的朋友 / 同事等通用关系，去掉团里、同团、游客、驴友等旅行关系，不新增工厂角色推断                           | 正例：跟我一起来的同事现在手割伤了                   | `handoff-vocab.ts:441` |
| `COMPANION_MARK`      | 通用照搬           | 同行短语替换后的内部占位符                         | 保留同一占位字符，仅在解析内部使用                                                                                      | —                                                    | `handoff-vocab.ts:452` |
| `PARTY_MENTION`       | 工业改写           | 自己、家人、全团、一车人                           | 保留自己、我们、家人与占位符，去掉全团、一车人                                                                          | 正例：我们现在喘不上气                               | `handoff-vocab.ts:455` |
| `OTHER_MENTION`       | 工业改写           | 陌生人及别团游客、导游等非客户主体                 | 保留同事、朋友、他人等通用主体，去掉别团 / 游客 / 导游 / 领队旅游角色；明确一起的同事仍先由 COMPANION_PHRASE 处理       | 正例：同事现在发高烧了（无同行标记，不能当客户本人） | `handoff-vocab.ts:462` |
| `NOT_SUBJECT_LEAD`    | 通用照搬           | 和、被、把、给之后的人不是主语                     | 保留主宾关系排除                                                                                                        | —                                                    | `handoff-vocab.ts:470` |
| `FAMILY_LEAD`         | 通用照搬           | 紧急词以家人称谓开头                               | 保留本人家人与旁观者的边界                                                                                              | —                                                    | `handoff-vocab.ts:473` |
| `THIRD_PARTY`         | 通用照搬           | 撤回同意时的第三方转述对象                         | 保留别人说删除资料不代表本人行权                                                                                        | —                                                    | `handoff-vocab.ts:476` |
| `ASK_TAIL`            | 通用照搬           | 交互失败判定用的高把握吗、么结尾                   | 保留疑问尾，不因重复回答增加失败次数                                                                                    | —                                                    | `handoff-vocab.ts:508` |
| `EMBEDDED`            | 通用照搬           | 知道、确认、考虑等内嵌疑问                         | 保留陈述与真问句的区别                                                                                                  | —                                                    | `handoff-vocab.ts:511` |
| `DEPENDS_LEAD`        | 通用照搬           | 就看、得看等条件开头                               | 保留条件陈述排除                                                                                                        | —                                                    | `handoff-vocab.ts:515` |
| `ASK_WORDS`           | 通用照搬           | 疑问词、量词与正反问                               | 保留原量词和问法；件、套等工业数量问法本来已支持                                                                        | —                                                    | `handoff-vocab.ts:522` |
| `EVERY_AFTER`         | 通用照搬           | 疑问词后接都、也、就的任指                         | 保留任指排除                                                                                                            | —                                                    | `handoff-vocab.ts:534` |
| `EVERY_ANOTA_AFTER`   | 通用照搬           | 正反问后接都行、都可以                             | 保留非问句排除                                                                                                          | —                                                    | `handoff-vocab.ts:536` |
| `NOT_ASKING_REST`     | 通用照搬           | 随便、无论及玩住待几天等不定数陈述                 | 保留通用非问句排除；其中动词只是排除项，不会触发旅游转人工                                                              | —                                                    | `handoff-vocab.ts:539` |
| `US`                  | 工业改写           | 客服、顾问、回复与这家酒店等对象例外               | 保留你们、客服、顾问、贵司、回复等当前服务对象，去掉酒店 / 景区旅游例外，不扩大到型号词                                 | 正例：你们客服太差了                                 | `handoff-vocab.ts:562` |
| `OWNED_BY_US`         | 通用照搬           | 你们安排的、你们提供的归属前缀                     | 保留服务归属判断                                                                                                        | —                                                    | `handoff-vocab.ts:566` |
| `OWNED_KIND`          | 工业改写           | 导游、司机、领队、酒店等我方服务对象               | 替换成工业产品、报价、报价单、订单等已有业务对象，供情绪归属判断；不当作新转人工种类                                    | 正例：你们的报价太离谱了                             | `handoff-vocab.ts:569` |
| `SELF`                | 通用照搬           | 我、我们、自己等自称                               | 保留自嘲与对我方抱怨的区别                                                                                              | —                                                    | `handoff-vocab.ts:572` |
| `OTHERS`              | 工业改写           | 家人、别家及酒店、景区、导游等外部对象             | 保留通用他人 / 别家 / 快递 / 天气，移除旅游角色；与 OWNED_KIND 对齐产品、报价、订单等对象以维持归属优先级               | 正例：别人的报价太离谱了（不是冲着我们）             | `handoff-vocab.ts:575` |
| `OBJECT_LEAD`         | 通用照搬           | 让、给、对、把之后的是宾语                         | 保留情绪对象边界                                                                                                        | —                                                    | `handoff-vocab.ts:579` |
| `OTHER_AGENCY`        | 工业改写           | 别家旅行社及点名旅游平台                           | 保留别家、其他公司 / 平台等第三方排除，去掉旅行社及点名旅游平台，不新增真实厂商品牌                                     | 正例：别家公司报价太离谱了（他方排除）               | `handoff-vocab.ts:582` |
| `JOKE`                | 通用照搬           | 情绪判断中的玩笑词和表情                           | 保留玩笑不计情绪阈值                                                                                                    | —                                                    | `handoff-vocab.ts:586` |
| `DOUBT_WORD`          | 通用照搬           | 骗、坑、靠谱等售前疑虑                             | 保留疑问与辱骂的区别                                                                                                    | —                                                    | `handoff-vocab.ts:589` |
| `STRONG_DIRECTED`     | 通用照搬           | 明确冲着人的强辱骂                                 | 保留强负面情绪判断                                                                                                      | —                                                    | `handoff-vocab.ts:592` |
| `INSULT`              | 通用照搬           | 辱骂词                                             | 保留原强情绪词及限定                                                                                                    | —                                                    | `handoff-vocab.ts:596` |
| `STUPID`              | 通用照搬           | 冲着我方的蠢、笨、傻                               | 保留主语限定                                                                                                            | —                                                    | `handoff-vocab.ts:600` |
| `INSULT_TARGET_AFTER` | 工业改写           | 辱骂后接客服、AI、旅行社等对象                     | 保留客服、顾问、公司、平台、回复等，去掉旅行社                                                                          | 正例：垃圾客服                                       | `handoff-vocab.ts:604` |
| `INSULT_OBJECT`       | 通用照搬           | 垃圾袋、白痴问题等物件本义                         | 保留非辱骂排除                                                                                                          | —                                                    | `handoff-vocab.ts:608` |
| `BARE_FILLER`         | 通用照搬           | 单独辱骂周围的语气填充词                           | 保留原去填充算法输入                                                                                                    | —                                                    | `handoff-vocab.ts:611` |
| `BARE_INSULT`         | 通用照搬           | 单独成句的辱骂                                     | 保留强情绪判断                                                                                                          | —                                                    | `handoff-vocab.ts:613` |
| `BROKEN`              | 通用照搬           | 破客服、破系统等明确对象                           | 保留强情绪判断                                                                                                          | —                                                    | `handoff-vocab.ts:617` |
| `INTENSIFIER`         | 通用照搬           | 他妈的等程度脏话                                   | 保留须冲着我们的限定                                                                                                    | —                                                    | `handoff-vocab.ts:620` |
| `WEAK`                | 通用照搬           | 失望、慢、乱收费等弱抱怨                           | 保留原弱情绪词及否定 / 对象限定                                                                                         | —                                                    | `handoff-vocab.ts:623` |
| `SLOW_PACE`           | 旅游专有置为不匹配 | 行程节奏慢、休闲、慢游等褒义例外                   | 用永不匹配正则，不给工业回复慢套用行程节奏例外                                                                          | 反例：行程节奏这么慢，老人喜欢慢游                   | `handoff-vocab.ts:627` |
| `WEAK_US_BEFORE`      | 通用照搬           | 你们没听懂等前置对象的抱怨                         | 保留只认我方对象的限定                                                                                                  | —                                                    | `handoff-vocab.ts:630` |
| `WEAK_RHETORICAL`     | 通用照搬           | 答非所问、还要说几遍等本次对话抱怨                 | 保留交互抱怨与反问                                                                                                      | —                                                    | `handoff-vocab.ts:633` |
| `REPEAT_SAID`         | 通用照搬           | 说了多少遍类抱怨前缀                               | 保留家人 / 他人语境排除                                                                                                 | —                                                    | `handoff-vocab.ts:637` |
| `PEOPLE`              | 通用照搬           | 家人、同事、老板等第三方人物                       | 保留抱怨是否冲着我们的判断                                                                                              | —                                                    | `handoff-vocab.ts:639` |
| `WEAK_DIRECTED`       | 通用照搬           | 别敷衍我、坑我等禁止式抱怨                         | 保留弱情绪判断                                                                                                          | —                                                    | `handoff-vocab.ts:643` |
| `POSITIVE_BEFORE`     | 通用照搬           | 便宜得离谱、美到无语等褒义前缀                     | 保留褒义排除，不把词本身当旅游触发                                                                                      | —                                                    | `handoff-vocab.ts:646` |
| `WORRY_BEFORE`        | 通用照搬           | 怕、担心、避免等售前疑虑                           | 保留疑虑排除                                                                                                            | —                                                    | `handoff-vocab.ts:650` |
| `SEG_ASKING`          | 通用照搬           | 分段问句与打消疑虑问法                             | 保留问句排除                                                                                                            | —                                                    | `handoff-vocab.ts:653` |
| `COMPLAINT_TAG`       | 通用照搬           | 太坑了吧、别敷衍我好吗等投诉语气                   | 保留问句式抱怨                                                                                                          | —                                                    | `handoff-vocab.ts:655` |
| `ONLY_US`             | 通用照搬           | 下一段只有你们、客服等对象                         | 保留跨小句情绪对象判断                                                                                                  | —                                                    | `handoff-vocab.ts:658` |
| `HEALTH`              | 通用照搬           | 病史、孕期、行动不便等健康隐私                     | 保留敏感信息识别，工业客户主动提及时仍受保护                                                                            | —                                                    | `handoff-vocab.ts:664` |
| `PERSON`              | 通用照搬           | 敏感健康句中的本人、家人与长辈                     | 保留敏感类别判断的具体人限定                                                                                            | —                                                    | `handoff-vocab.ts:668` |
| `CHILD_AGE_AFTER`     | 通用照搬           | 孩子在前、年龄在后                                 | 保留未满14周岁信息识别                                                                                                  | —                                                    | `handoff-vocab.ts:674` |
| `CHILD_AGE_BEFORE`    | 通用照搬           | 年龄在前、孩子在后                                 | 保留未满14周岁信息识别                                                                                                  | —                                                    | `handoff-vocab.ts:676` |
| `SCHOOL`              | 通用照搬           | 幼儿园、小学、初一等未成年人线索                   | 保留未成年人隐私保护                                                                                                    | —                                                    | `handoff-vocab.ts:679` |
| `CHILD_RE`            | 通用照搬           | 孩子、宝宝等儿童称谓                               | 保留跨小句年龄归属                                                                                                      | —                                                    | `handoff-vocab.ts:681` |
| `WITHDRAW`            | 通用照搬           | 撤回同意、删除本人资料等请求数组                   | 完整照搬行权规则，不把删除产品 / 订单当删除个人信息                                                                     | —                                                    | `handoff-vocab.ts:691` |
| `POLITE_ASK`          | 通用照搬           | 可以帮我删除等礼貌请求                             | 保留问句式本人行权                                                                                                      | —                                                    | `handoff-vocab.ts:701` |
| `POLICY_ASK`          | 通用照搬           | 会不会、怎么删除等咨询问法                         | 保留政策咨询与行权的区别                                                                                                | —                                                    | `handoff-vocab.ts:703` |
| `NOT_WANTED`          | 通用照搬           | 不用删除、不想撤回等否定请求                       | 保留不执行的边界                                                                                                        | —                                                    | `handoff-vocab.ts:706` |

#### 开工基准与本机验证

环境：Node 22.22.0、pnpm 10.30.2；所有测试有外层 alarm 或 subprocess timeout（静态门禁 180 秒、字节与 09 各套 300 秒、锁定与两种 v2 各 600 秒）。只使用本机 mock / PGlite 与封闭发送桩；未设置 PG_TEST_URL，未创建容器、浏览器或外部服务连接，未调用真实模型，费用为零。日志位于 gitignored 的 `var/10-a/logs/`，不提交。

- `pnpm -s test:locked`：退出 0，七套锁定自测全部通过；下面的 tools 摘要即原 `JSON.stringify(toolDefs)` 的字节哈希，未修改工具定义。

```text
PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd
```

锁定八文件实际 SHA-256（本机 `shasum -a 256`，与 sha256sum 算法相同）：

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

按改动文件及本步基准的文件名检索相关测试引用后，实际逐套运行以下已有自测（`pnpm exec tsx <文件>`；两套 bytes 加 `PARITY_CLOCK_MS=1790913600000` 和 `--import ./src/store/parity-clock.ts`）。只读旧夹具，不运行 UPDATE / snapshot-write：

| 套件                                   | 退出码与结论                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/payment/legacy-bytes.selftest.ts` | 0；60 条出口与夹具逐字节相同，140 项断言；四类输出（支付页 HTML、公开订单 JSON、企微付款卡片、工作台订单卡 JSON）保留。                                                                     |
| `src/core/link-bytes.selftest.ts`      | 0；317 条字节基准，517 项断言；卡片、网页部件、沙箱资源白名单沿用 09 夹具。                                                                                                                 |
| `src/quote-approval.selftest.ts`       | 0；QUOTE DATA / ENTRIES / RECOVERY PASS：金额隔离、复用、自动批准、两槽、自然日、六入口及持久恢复。                                                                                         |
| `src/quote-actions.selftest.ts`        | 0；MATRIX / CONCURRENCY / PERMISSIONS / HTTP/AUDIT / DELIVERY / NOTIFY / ATOMIC / PROCESS RESTART 全 PASS；真实 PG 分支因无 PG_TEST_URL 明示 SKIP，交 CI 一次性库，不冒称本机真实 PG 通过。 |
| `src/quote-page.selftest.ts`           | 0；七状态响应、各状态重置 404、历史保留 / 重载、品牌与加载 / 空 / 错 / 重试通过。                                                                                                           |
| `src/quote-replies.selftest.ts`        | 0；固定句全文、schema、pack 转人工、去重、动作钩子与待审跳过跟进通过。                                                                                                                      |
| `src/site-links.selftest.ts`           | 0；登记、按租户隔离、可选标题、删链及引导语、沙箱 cookie 与显式方法通过。                                                                                                                   |

v2 默认基线实查 `eval/v2/snapshot.ts:156` 为 `eval/baselines/v2-09-step14.json`，未传覆盖项或关闭比对，两种配置都保留既有 865 条（857 条旅游、8 条证明包）。使用 `pnpm exec tsx` 调本地已安装版本，等价于任务的 `npx tsx`，不下载依赖：

```text
CONFIG_SOURCE=file LLM_MOCK=1 pnpm exec tsx eval/run.ts
v2 回归评测：865/865 用例通过 · 跳过 0 条 realOnly · 8587 项断言
v2 快照比对：865 条 case · 0 处差异

CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1 pnpm exec tsx eval/run.ts
v2 回归评测：865/865 用例通过 · 跳过 0 条 realOnly · 8587 项断言
v2 快照比对：865 条 case · 0 处差异
DB 模式：22 个请求的前缀哈希核对，0 个与 /healthz 不符
```

- `pnpm -s lint`、`pnpm -s typecheck` 均退出 0；lint 的内容黑名单因无 SENSITIVE_PATTERNS / .sensitive-patterns 按既有逻辑跳过，其余边界、迁移、console、租户状态清单检查通过。补查新增行无本机绝对路径、无过长假企微 ID。
- `pnpm -s format:check`：退出 0，832 个文件通过；`git diff --check`：退出 0。以脚本将表中 104 键与 HandoffVocab 接口逐键同序比较，键集、顺序、唯一性与分类计数全部一致；4 条旅游反例均已对旧旅游正则实测命中，工业侧断言留第 8 步。
- 锁定八文件、`eval/baselines/`、两份 bytes 夹具相对 HEAD 与 origin/dev 的 diff 均为空；`git diff --stat` 只有本 plan。未新增夹具；10 的新链接种类在后续步骤继续对照这份基准。
- 按本批共同约定，完整 `pnpm test` 留 CI，本机不跑；预发 R16 待当次授权，移到上线前。此记录只完成第 0 步本机基准，不替代 09 / 10 联合上线与全量验收。

### B+C 批 · 第 1–6 步

第 1、1.1、2、3、4、5、6 步已完成本批本机实现与验收；后续真实 PG / 全量测试留 CI，整份 spec 仍为 ready。本批只用合成夹具，不生成第 14 步的演示产品，不提交、push 或开 PR。

- 第 1 步：`EntityType.itemRules` 声明五种规则，`checkItem` 与 `withItemRules` 的 zod refinement 共用解释器，配置自检核对引用键与数值类型。`CatalogKindSpec.crossItemCheck` 在上架、编辑 active（包括已有 catalog-fix 修正路径）时调用；草稿创建、编辑、CSV 不调用。在配置锁内重读本租户 active 集合，避免旧回合快照漏掉并发冲突；原有 active → draft 禁令不变。
- 第 1.1 步：工业包入口、生产注册、公开包白名单、part 字段与 schema、跨条目检查及 CSV 完成；证明包仍受 PACK_FIXTURES 门控。型号 / 别名归一后冲突与替代型号缺失在上架 / active 编辑时点名字段拒绝；价格两位小数，改价留新版本。参考配置只有 pack.json；三套既有自测只更新新增包 / 目录的枚举预期，不改旧夹具。
- 第 2 步：全半角、前缀、分隔符、乘号归一，按型号 → 别名 → 至少四位前缀 → 知识库匹配，候选有现货优先再按型号升序，最多五条。局部取舍：前缀 / 语义候选均要求客户选择，不作 exact；纯型号查无命中时不把语义最近邻当另一型号返回，25mm / IP65 这类规格须有条目 specs 的字面支持。完整工具 / 检索 / 查询 embedding 处理使用 HTTP 边界合成桩，20 次端到端 p95 为 42.154 ms；Node 22.22.0、darwin/arm64、PGlite，与兼容回归并行运行，无外部请求。这是本机桩环境证据，不冒称外部 embedding 服务时延。
- 第 3 步：按数量取最高适用档，起订量拒绝、库存三种交期、整数分乘加与安全整数检查通过。即时生成 40 条测试夹具、每批 30 行、1,000 批覆盖精确 / 别名 / 前缀，内存匹配加定价 p95 为 9.849 ms，小于 50 ms；同一 Node / 系统，与兼容回归并行运行，不含装载、持久化与语义调用。
- 第 4 步：四工具与副作用 / 缓存 / 重试声明、各档 / 行 / 合计金额出处、30 / 31 行、建单补 kind 完成。五种拒绝逐行保留，只有 below_moq 带合法 moq；混合拒绝、未知原因、缺失 moq 与定价异常不会伪报成功或起订量，不改 lastQuoteId、不建单、不排通知。待审只返回 state；跟进按原 sideEffects 过滤后四工具全部排除，转人工的会话 / 备注 / 通知实际写入已核对。
- 第 5 步：复用核心 quotes；默认阈值 0，开启后仅合计不超阈值、建单时所有行现货足够、草稿中每个编号都是 exact 才自动批准，库存读不到不放行。实际验证默认待审、pending 复用、工作台批准后再建单 reused=true，原 id / 链接 / 金额保留，不重审、不重复通知。登记 quote 页、仅 GET 的 API 资源、allowed、网页标题与企微卡片；服务端 notes 只在本租户可读的 approved / paid 调用，复制只读数组，无钩子 / 空数组不加字段，其他状态 / 404 不调用；当前发布政策、文件 policy.json、跨租户隔离与页面真实脚本的 textContent 展示均已验证。实际改价后新试算 / 新单按新价，已批准单行与总额仍冻结。
- 第 6 步：画像四字段的提取 / 投影 / 持久化，四键重置、版本读取和阶段全链路完成。真 handleMessage / stage_advance 跑出问需、多候选 / 替代型号 → 推荐、试算 → 报价、自动批准 / 取代 → 促成、新试算覆盖旧批准状态；真工作台动作跑出批准 → 促成、驳回 / 撤回 → 报价，实际收款进入已支付。摘要只存 code / version / qty / match / at，文件模式只回退版本 1；缓存为型号和规格数组，插入顺序代表新旧，重复展示移到末尾。必留最坏 30 行状态实测 **4,404 ≤ 6,144 字节，余量 1,740 字节**；缓存同时满足最多 100 项与完整 UTF-8 JSON ≤ 8,192 字节，转义 / 多字节 / 超长项均按最旧整项淘汰，不截型号。淘汰前后自动批准及 latestQuoteCandidate 结果不变，缓存清空仍按摘要版本取型号；真实重置清四键，重载后仍不沿用状态，旧报价 404 且审批历史保留。latestQuoteCandidate 按 R11 的状态 / 时间 / 草稿优先 / createdAt / ASCII id 排序，供 D 批两个入口共用；本批不实现 D 批的确认回复。

协调者裁决（2026-10-26，本轮已落实）：

1. 为 R6 增加只读 `PackSources.currentPolicy()`，两个 sources 装配点接已有同名函数；DB 读内存已发布快照、文件模式读既有 policy.json，不读草稿、不写状态、不加环境开关。10 spec 加实现中 Revisions 与 Amends（04 R2 / R3、08 R5），Status 不变。
2. 不放宽静态检查：工业字段改为「零件编号」「品名」，中文 CSV 表头随标签；既有后台文字、GENERIC 与依赖允许名单均未改。
3. R6 / R13 所需 policy 先落 schema / defaults：已定的 7 天、阈值 0、含税 true、税率 13；未指定的参考运费取 freeOverFen=0 / feeFen=0，付款文字取 spec 例句「款到发货，对公转账」，票种用普通 / 专用发票。全是合成缺省值，自动批准始终读取发布值；E 批继续补政策文案、SOP 与后台配置，不另造政策接口成员。
4. 未增加模块级可变租户数据；静态 schema / 包定义也被现有清单检查要求登记，故 state-manifest 补 21 个 instance 条目并注明不保存租户快照，未修改检查规则。

新增耐久自测均只追加在 package.json 的 test 末尾，CI 从原链自动分片，无第二份清单：

| 自测                                 | 覆盖与本机结果                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/item-rules.selftest.ts`         | 五种规则 26 个正反例，schema / checkItem 的结论及字段消息一致，退出 0。                                                                                                                                                                         |
| `src/industrial-domain.selftest.ts`  | 产品字段、CSV、匹配排序、阶梯 / 起订量 / 库存、工具声明 / 金额 / 拒绝、摘要容量 / 缓存淘汰 / 历史读取及内存性能，退出 0。                                                                                                                       |
| `src/industrial-catalog.selftest.ts` | PGlite 实际写路径、草稿 / 上架 / active 编辑、锁定 / 禁下架、版本 / 冻结、30 / 31 行、拒绝 / 异常无建单通知、实际转人工，以及完整语义链路与启用索引后的无命中 / 规格召回，退出 0。PG_TEST_URL 分支覆盖重复型号并发上架恰一成功，本机明确 SKIP。 |
| `src/industrial-quotes.selftest.ts`  | 实际工具 / 引擎 / 工作台动作 / 公开路由 / 页面脚本 / 存储，只桩模型策略与发送边界；自动批准三条件、人审复用、链接 / notes、冻结金额、阶段 / 收款、画像 / 重置 / 重载、淘汰判断不变、DB / 文件政策读取，退出 0。                                 |

本机质量门与硬性对照（日志在 gitignored 的 `var/10-bc/logs/`）：

- format:check、lint、typecheck、test:locked 全部退出 0；公开边界路径检查无拒绝，内容黑名单因未配置 SENSITIVE_PATTERNS / .sensitive-patterns 按既有逻辑明示跳过；依赖方向为「656 个代码文件、6312 处 import，没有越界」。console-src 全部不变量通过，tenant-state 的 582 个绑定与清单一致；未放宽检查。
- 锁定输出：`PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd`，tools 即 JSON.stringify(toolDefs) 的字节哈希。
- 文件配置与 PGlite 配置 v2 各为 **865/865、8587 项断言**，各输出 `v2 快照比对：865 条 case · 0 处差异`；PGlite 另核对 22 请求前缀，0 个不符。没有新增工业 v2 case 或改基线。
- legacy-bytes：60 条出口、140 项断言；link-bytes：317 条基准、517 项断言，旧夹具不改全部通过。quote-approval / quote-actions / quote-page / quote-replies / site-links 五套 09 自测全绿；真实 PG 分支按环境明确跳过，交 CI 一次性 pgvector:pg17。
- 按改动文件路径及文件名检索后，额外逐套跑 packs、registry-binding、pack-runtime、catalog-kind、catalog-snapshot、config、file-pack、policy、brand、brand-publish、brand-transfer、reply-pipeline、sop-per-pack、transfer-per-pack、gate-per-pack、retrieval-kb、pack-catalog、catalog-money、line-order、pack-session、money-ledger、tools/registry、console-api/console、check-tenant-state、ci-shard，全部退出 0。console 套件最初只有新增包的旧枚举预期失败，更新为 travel / industrial 后复跑 465 项通过；没有改旅游行为断言。
- 锁定八文件、eval/baselines、两份 bytes 夹具零 diff，git diff --check 与新增行公共边界补查通过。所有可能挂起的命令设超时；未连接外部服务、真实模型或服务器，没有容器 / 浏览器 / 后台服务遗留，费用零。完整 pnpm test 按共同约定交 CI，本机不跑。

### D+E 批 · 第 7–11 步

2026-10-26：按第 7、8、9、10、11 步依次交付；只使用合成小夹具，不生成第 14 步的演示产品，不改 spec、既有 v2 基线或锁定测试，不提交、不 push、不开 PR。Status 保持 ready。

逐步实现与验收：

| 步骤 | 实际改动与验收证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7    | 核心链接主回复与新增跟进工厂共用窄删除执行函数，保留登记 / 原始 URL / allowed / guard 事件语义；工业主回复与跟进分别装配链接、库存交期 / 替代 / 税票 / 价格承诺 / 型号、金额出处及 rfq_trim。文件扫描删空直接跳过；数据库任务在 holdSend / 渠道 pending / sending 前返回 cancelled / guard_empty，现有 afterSettle 不重排。industrial-followup 只桩模型与发送端，真实生成到两路发送覆盖合法完整 ord_ URL、非法链接、跨租户 / 会话、待审 / 过期 / 撤回、零消息 / outbound / 额度 / 次数及全部跟进元数据变化；旅游同输入保留旧清洗字节，裸链接删空仍发旧模板且计一次。industrial-replies 覆盖金额以外的每条护栏正反例、12 类规格、10+5、二次裁剪、部分行不计 N、保护内容超限终止；实际引擎分别制造编造库存、替代、型号、税票、最低价与无来源金额，并核对 guard_events 落库。 |
| 8    | 独立工业 handoff-vocab 声明 104 键：80 通用语义与旅游逐键一致，4 键永不匹配，20 键按第 0 步表改写。industrial-replies 从本 plan 读表核对 104 键、80 键值、4 条旧旅游命中 / 工业不命中样例及20条改写样例；联验通用医疗、业务问法、情绪归属与高反 / 行程变更不触发旅游转人工。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9    | preModel / contextNote 复用 B+C 的 latestQuoteCandidate，每次只捕获一次 now。非标 / 来图 / 账期 / 样品 / 单条31行携 fixedId 与 handoff；已批确认携 schema patch 与 notify，待审固定句，过期 / 新试算 / 无候选交回模型。industrial-replies 覆盖两条20行不累计、终态全排除、同毫秒草稿优先 / createdAt / id 排序及乱序输入；industrial-followup 通过实际引擎核对5类 pack 转人工、固定句 / patch、approval.acceptedAt 与 quote_accepted 任务同事务去重。                                                                                                                                                                                                                                                                                                                      |
| 10   | data/packs/industrial 的 SOP / policy / 品牌参考文件，包内8节 / 三可改五锁定、契约禁语、policy clauses / segments / lint、固定句与一致性登记。所有固定内容无旅游词或渠道名；默认 autoApproveMaxFen=0、7天有效期、13%税率及付款口径保持原契约。新建缺省人审、三条件自动批准、复用不重审与 R13 notes / 驳回 / 撤回文案保持一致；industrial-replies 真实调用 checkSopContract 与 policy lint，新增工业默认 mock 经实际工具 / 引擎分别验证试算合计、自动批准链接和缺省待审不泄露。                                                                                                                                                                                                                                                                                             |
| 11   | 报价 / 促成各24小时跟进、全部待审抑制、询价洞察与离线脚本、part 阶段 / SOP / 词汇、五条快捷回复及注册表接线；无新开关。工业正常 / 加载 / 空 / 错误页加入既有 fields DOM 套件（1751项全过）。缓存的固定版本字体源离线重建 UI 优先片至913码位 / 191968 B，Geist 与许可原文无差异，check-fonts 通过。                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

自定的小实现细节（均不新增接口成员、环境变量、表或错误码）：

- **同名步骤辨识。** 旅游自己的旧步骤也叫 link_whitelist，单查 id 会错误改变旅游行为。因此按 replySteps 中 id 与核心工厂的共享 run 函数身份共同识别“接入核心白名单”；不按包 id 分支，不改旅游步骤，不新增能力开关。两工厂输出 / 事件格式不变，link-bytes 与两种 v2 均零差异。
- **事实与规格。** 历史 exact 摘要按编号 / 版本重算当时工具的交期投影，不把缓存或当前改价后的产品当事实；本轮同型号工具结果覆盖旧摘要。部分现货、现货数字、预计天数分别核对，不把部分库存升级为全现货；未知型号检查跳过已登记的绝对 / 相对链接，规格按保守白名单与 partsInPlay 的规格词保留。
- **统一裁剪。** ShapePolicy 的现有保护回调使 shape_check 只记录；rfq_trim 是统一删行 / 删句的地方。保留原始行索引、每次按最终完全删空的行重算 N，补句计入预算；绝对 / 相对合法站内链接句受保护，保护内容仍超限走已登记短句。主回复被前置护栏全部删空时用已登记的型号 / 数量短句兜底；跟进始终只删，删空不发送。
- **固定前缀与政策。** 锁定节规定从本轮已发布政策读取税票 / 运费 / 有效期 / 收款条款，数值片段通过 policy 纯函数与 contextNote 给模型及固定护栏，避免将每轮政策或会话摘要拼进系统前缀；不读取草稿，也不在工厂初始化时访问未装载的政策。确认措辞保守排除问句、否定、尚未决定的说法。
- **登记与测试。** 25个新增固定字典 / 正则 / 模板绑定按静态配置登记进 state-manifest；没有新增租户运行时状态。package.json 只在 test 末尾追加 industrial-replies 与 industrial-followup 两个 tsx 自测；CI分片由原链派生，ci-shard 自测通过，无第二份清单。真实 PostgreSQL 分支继续留给 CI 的一次性 pgvector:pg17，未连接外部服务、生产、密钥或真实模型，费用零。

质量门与硬性对照（日志留在 gitignored 的 var/10-de/logs）：

- format:check、lint、typecheck、test:locked 均通过；完整 pnpm test 按本批共同约定留 CI，不在本机跑。
- 中断恢复后复查工作区与本批 diff，再跑 format:check、lint、typecheck、test:locked、industrial-replies、industrial-followup、industrial-quotes，七项均退出0（resumed-results.json）；再次确认 package.json 仅追加两条自测、锁定文件 / spec / 基线 / 字节自测零 diff、公共边界补查及 git diff --check 通过。
- lint：公开边界路径检查通过；未配置 SENSITIVE_PATTERNS / .sensitive-patterns，内容黑名单按既有逻辑明确跳过，未放宽检查。依赖方向结论为“667 个代码文件、6399 处 import，没有越界”；tenant-state 的607个绑定与清单一致。
- `PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd`；tools 对应 JSON.stringify(toolDefs) 的字节哈希。
- 文件与 PGlite 两种 v2 各 **865/865、8587项断言**，各为 `v2 快照比对：865 条 case · 0 处差异`；PGlite另核对22请求前缀，0不符。未新增工业 v2 case或更改基线。
- legacy-bytes **60条出口 / 140项断言**，link-bytes **317条基准 / 517项断言**，夹具不改全过；quote-approval / quote-actions / quote-page / quote-replies / site-links 五套09自测全绿。锁定八文件、eval/baselines、两份 bytes 夹具零 diff。
- 按实际改动路径 / 文件名检索消费套件后逐个跑61套，全部退出0；工业护栏复核补例后再次单跑两套新增自测通过。具名结论见下表。
- console生产构建与check-console-dist通过：169个文件，首屏JS 357295 B、双字体preload 203852 B，无服务端依赖 / 假包 / 第三方字体进入产物；git diff --check、全PR新增行 / 新文件的绝对路径与假ID检查、工作区diff加未跟踪新文件的gitleaks扫描通过。无PR或提交，未把空的提交范围扫描当作工作区证据。
- 浏览器附加走查未完成：Browser plugin not available（没有对应 browser skill）；使用已有 Playwright 与已缓存 Chromium 尝试本地页面，Chromium 的 MachPortRendezvous 因沙箱 Permission denied退出，不能提供浏览器截图或视觉通过结论。DOM 的工业正常 / 加载 / 空 / 错误态已全过；本地 QA 服务与浏览器启动尝试已退出，不保留进程。

| 自测 / 检查                                         | 结论    |
| --------------------------------------------------- | ------- |
| `scripts/check-boundaries.selftest.ts`              | ✔ 退出0 |
| `src/store/parity.selftest.ts`                      | ✔ 退出0 |
| `console/src/fields/fields.selftest.tsx`            | ✔ 退出0 |
| `scripts/check-tenant-state.selftest.ts`            | ✔ 退出0 |
| `src/line-order.selftest.ts`                        | ✔ 退出0 |
| `src/quote-replies.selftest.ts`                     | ✔ 退出0 |
| `src/quote-approval.selftest.ts`                    | ✔ 退出0 |
| `src/industrial-domain.selftest.ts`                 | ✔ 退出0 |
| `src/pack-catalog.selftest.ts`                      | ✔ 退出0 |
| `src/order-readers.selftest.ts`                     | ✔ 退出0 |
| `src/industrial-catalog.selftest.ts`                | ✔ 退出0 |
| `src/jobs/jobs.selftest.ts`                         | ✔ 退出0 |
| `src/industrial-replies.selftest.ts`                | ✔ 退出0 |
| `src/tenancy/seed-fixture.selftest.ts`              | ✔ 退出0 |
| `src/quota/quota.selftest.ts`                       | ✔ 退出0 |
| `src/config/registry-binding.selftest.ts`           | ✔ 退出0 |
| `src/config/config.selftest.ts`                     | ✔ 退出0 |
| `src/quote-page.selftest.ts`                        | ✔ 退出0 |
| `src/config/catalog-kind.selftest.ts`               | ✔ 退出0 |
| `src/config/gate-per-pack.selftest.ts`              | ✔ 退出0 |
| `src/config/sop-per-pack.selftest.ts`               | ✔ 退出0 |
| `src/tenancy/fixture-tenant.selftest.ts`            | ✔ 退出0 |
| `src/money-ledger.selftest.ts`                      | ✔ 退出0 |
| `src/industrial-followup.selftest.ts`               | ✔ 退出0 |
| `src/trace/trace.selftest.ts`                       | ✔ 退出0 |
| `src/config/consistency.selftest.ts`                | ✔ 退出0 |
| `src/config/retrieval-kb.selftest.ts`               | ✔ 退出0 |
| `src/config/catalog-snapshot.selftest.ts`           | ✔ 退出0 |
| `src/config/reply-pipeline.selftest.ts`             | ✔ 退出0 |
| `src/console-api/console.selftest.ts`               | ✔ 退出0 |
| `src/config/pack-runtime.selftest.ts`               | ✔ 退出0 |
| `src/quote-actions.selftest.ts`                     | ✔ 退出0 |
| `src/catalog-money.selftest.ts`                     | ✔ 退出0 |
| `src/tenancy/sandbox/refund-seed.selftest.ts`       | ✔ 退出0 |
| `src/console-api/traces.selftest.ts`                | ✔ 退出0 |
| `src/industrial-quotes.selftest.ts`                 | ✔ 退出0 |
| `src/pack-session.selftest.ts`                      | ✔ 退出0 |
| `src/handoff/handoff.selftest.ts`                   | ✔ 退出0 |
| `src/after-sales.selftest.ts`                       | ✔ 退出0 |
| `src/tenancy/sandbox/http.selftest.ts`              | ✔ 退出0 |
| `src/tenancy/sandbox/provision.selftest.ts`         | ✔ 退出0 |
| `src/site-links.selftest.ts`                        | ✔ 退出0 |
| `src/payment/legacy-bytes.selftest.ts`              | ✔ 退出0 |
| `src/core/link-bytes.selftest.ts`                   | ✔ 退出0 |
| `src/followup-guards.selftest.ts`                   | ✔ 退出0 |
| `src/core/guards/money-provenance.selftest.ts`      | ✔ 退出0 |
| `src/core/guards/execute.selftest.ts`               | ✔ 退出0 |
| `src/core/guards/validate.selftest.ts`              | ✔ 退出0 |
| `src/core/guards/shape.selftest.ts`                 | ✔ 退出0 |
| `src/packs/packs.selftest.ts`                       | ✔ 退出0 |
| `src/config/brand.selftest.ts`                      | ✔ 退出0 |
| `src/config/brand-publish.selftest.ts`              | ✔ 退出0 |
| `src/config/policy.selftest.ts`                     | ✔ 退出0 |
| `src/config/template-derive.selftest.ts`            | ✔ 退出0 |
| `src/config/file-pack.selftest.ts`                  | ✔ 退出0 |
| `src/core/consistency.selftest.ts`                  | ✔ 退出0 |
| `src/core/tools/registry.selftest.ts`               | ✔ 退出0 |
| `scripts/ci-shard.selftest.ts`                      | ✔ 退出0 |
| `scripts/check-fonts.ts`                            | ✔ 退出0 |
| `console/src/conversations/pack-cards.selftest.tsx` | ✔ 退出0 |
| `console/src/sop/sop.selftest.tsx`                  | ✔ 退出0 |

### F 批 · 第 12–14 步

- 第 12 步：新增 35 条 `industrial` cases v2，保持既有 `fixtures.now` 与对话动作，未扩 v2 审批种子；仅本步生成 `eval/baselines/v2-10-step12.json` 并切换默认基线。独立用 JSON 解码器定位对象原文、截取 UTF-8 字节比对：原 865 条逐字节相同，新文件共 900 条，旧快照不改。
- PGlite 装配发现旧 `eval/v2/pack-db.ts` 将非旅游政策一律写 null，工业契约以 `policy_invalid` 拒绝。按已有 `policySnapshot` 接口装载参考目录政策并保存同源哈希；没有 policy 能力的证明包仍为 null。该修复仅在评测装配，不改业务运行时 / SOP / 工具定义或 v2 schema。
- 第 13 步：新增 28 个 regression 目标，其中 15 个 safety，目录沿工业 `evalGoalsDir` 接入既有发布闸。仅扩模拟目标通用单的嵌套 approval；pending / approved 时间为非负安全整数、时间顺序合法且不超前，pending 仅搭配 pending_payment，保留单槽末位校验。装载按 FIXTURE_CLOCK 校验，初始化再按 fixtureClock 当前时间与包 quotes 能力校验，整组验证发生在创建会话前。先经 `priceLine` 与 `{ approval: false }` 建单，再在隔离模拟器里落审批快照，createdAt 对齐 requestedAt；不走自动批准或通知动作。旧无审批种子维持原语义。
- 模拟新增自测覆盖非法时间 / 状态 / 顶层字段 / 新时钟拒绝、四种订单状态与旧种子、待审 / 已批有效 / 已批过期确认；过期样例比自然日边界早至少一天。真实引擎只桩模型 HTTP，以 28 个目标验证 simulate / simulateGate / runGate 入口、包目标选择、完整报告；handoffKind 与 richTools 均有反例判红，不新增谓词或核心接口。脚本只证明结构、确定性流程与闸接线，不当作真实模型质量结果。
- 第 14 步：新增 `catalog/part.json` 与同内容 `part.csv`，40 条全合成产品，轴承 / 紧固件 / 气动元件 / 低压电器各 10 条；品牌统一「衡石工业品」，每条标注合成演示数据。沿公开型号规则自行编写，不取厂商资料；库存、价格、规格均为演示值，未写真实联系方式。CSV 金额写两位小数，含四档价格、三种库存情况、别名与有 / 无替代；按依赖顺序先上架替代目标。
- 数据验收自测核对 JSON / CSV 语义一致、40 条 CSV 导入全为草稿、40 条逐一上架、列表与详情一致、所有型号与别名匹配及跨条目校验；实际批准报价后改价，生成版本 2，之后两件试算由 20 元变 20.50 元，原已批准订单所有字段不变。40 条实际演示数据 / 30 行 / 1000 批内存匹配加定价 p95 低于 50 ms；不含装载、网络或持久化。
- 自定细节：评测先固定 4 条合成产品，第 14 步只追加其余 36 条，工业快照不再重写；共 28 个目标以覆盖全部 R15 场景，15 个 safety；模拟脚本复用 v2 的假响应但使用独立目标谓词，真实模型入口不读取假脚本。两个新增自测只追加到 package.json 的 test 尾部，CI 分片自动从该脚本导出，无第二份清单。

新增快照 id（全部是工业用例）：

- `q10-industrial-12-lines`
- `q10-industrial-31-lines`
- `q10-industrial-alias`
- `q10-industrial-ambiguous`
- `q10-industrial-bargain`
- `q10-industrial-below-moq`
- `q10-industrial-credit`
- `q10-industrial-drawing`
- `q10-industrial-exact`
- `q10-industrial-injection`
- `q10-industrial-invent-model`
- `q10-industrial-invent-stock`
- `q10-industrial-invent-substitute`
- `q10-industrial-lowest`
- `q10-industrial-moq`
- `q10-industrial-multiply-cross`
- `q10-industrial-multiply-star`
- `q10-industrial-multiply-x`
- `q10-industrial-no-stock`
- `q10-industrial-nonstandard`
- `q10-industrial-off-catalog`
- `q10-industrial-pending`
- `q10-industrial-reject-moq`
- `q10-industrial-sample`
- `q10-industrial-short-prefix`
- `q10-industrial-specs`
- `q10-industrial-substitute-known`
- `q10-industrial-substitute-none`
- `q10-industrial-tax`
- `q10-industrial-tier-at`
- `q10-industrial-tier-before`
- `q10-industrial-tier3-at`
- `q10-industrial-tier3-before`
- `q10-industrial-tier4-at`
- `q10-industrial-tier4-before`

验证结果（全部离线；Node v22.22.0，darwin/arm64）：

- ✔ `format:check`、`lint`、`typecheck`、`test:locked` 均通过；完整 `pnpm test` 按本批任务不在本机执行，留 CI。CI 分片自测确认新套件来自 test 尾部自动登记。
- ✔ 文件配置：`v2 回归评测：900/900 用例通过 · 8742 项断言`；`v2 快照比对：900 条 case · 0 处差异`。
- ✔ PGlite 配置：`v2 回归评测：900/900 用例通过 · 8742 项断言`；`v2 快照比对：900 条 case · 0 处差异`；v1 的 22 个请求前缀哈希与 healthz 对照 0 处不符。
- ✔ `PREFIX sha256 system=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900 tools=59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd`。
- ✔ legacy-bytes：60 条出口字节、140 项断言；link-bytes：317 条字节基准、517 项断言；两套夹具不改。09 的 quote-approval / quote-actions / quote-page / quote-replies / site-links 全绿。
- ✔ 模拟：28 regression / 15 safety，模拟器、simulateGate 与 runGate 均通过；另经 PGlite 实际后台发布链，required 闸先拒绝未评测草稿，两边各 28 个目标通过后，tone 可编辑节发布为 v2；不覆盖授权后在线后台操作。
- ✔ 实际演示产品内存计算：40 条 / 30 行 / 1000 批，p95 = 0.816 ms；数据导入、上架、匹配、改价与批准金额冻结通过。字段渲染套件 1751 项断言、金额套件均通过，未改 UI。
- ✔ 独立原文切片验证旧 865 个快照对象逐字节相同，只新增上述 35 个 id；八个锁定文件、旧快照、两套字节夹具、spec 均零 diff；本批不改 PREFIX / toolDefs、旅游文案或业务代码。
- ✔ `git diff --check`、新增与修改文件公共边界补查、相对 origin/dev 的整个 PR 新增行检查：本机路径与超长假企微 id 均 0 命中。lint 未配置敏感词表，内容黑名单按原脚本跳过，数据来源与品牌逐项核对为合成；未打开 PR，未执行提交或推送。
- ✘ 本批不执行真实模型 k = 5、真实 PG / Docker、预发 R16 与生产验收：按任务边界留第 15–16 步及 CI，mock 结果不代替这些证据。没有真实模型费用，没有后台进程 / 浏览器 / 容器遗留。

按文件名与引用搜索出的直接影响套件，加旅游 / 09 硬性对照，逐套结果如下（31 套，退出码均为 0）：

| 自测                                       | 结果          |
| ------------------------------------------ | ------------- |
| `eval/sim/sim.selftest.ts`                 | ✔ 退出 0      |
| `eval/sim/fixture.selftest.ts`             | ✔ 退出 0      |
| `eval/sim/predicates.selftest.ts`          | ✔ 退出 0      |
| `eval/sim/gate.selftest.ts`                | ✔ 退出 0      |
| `eval/sim/industrial.selftest.ts`          | ✔ 退出 0      |
| `eval/v2/runner.selftest.ts`               | ✔ 退出 0      |
| `eval/v2/isolation.selftest.ts`            | ✔ 退出 0      |
| `src/config/gate-per-pack.selftest.ts`     | ✔ 退出 0      |
| `src/config/gate.selftest.ts`              | ✔ 退出 0      |
| `src/config/file-pack.selftest.ts`         | ✔ 退出 0      |
| `src/config/policy.selftest.ts`            | ✔ 退出 0      |
| `src/config/transfer-per-pack.selftest.ts` | ✔ 退出 0      |
| `src/config/sop-per-pack.selftest.ts`      | ✔ 退出 0      |
| `src/config/catalog-snapshot.selftest.ts`  | ✔ 退出 0      |
| `src/config/registry-binding.selftest.ts`  | ✔ 退出 0      |
| `src/industrial-domain.selftest.ts`        | ✔ 退出 0      |
| `src/industrial-catalog.selftest.ts`       | ✔ 退出 0      |
| `src/industrial-quotes.selftest.ts`        | ✔ 退出 0      |
| `src/industrial-replies.selftest.ts`       | ✔ 退出 0      |
| `src/industrial-followup.selftest.ts`      | ✔ 退出 0      |
| `src/industrial-demo.selftest.ts`          | ✔ 退出 0      |
| `src/quote-approval.selftest.ts`           | ✔ 退出 0      |
| `src/quote-actions.selftest.ts`            | ✔ 退出 0      |
| `src/quote-page.selftest.ts`               | ✔ 退出 0      |
| `src/quote-replies.selftest.ts`            | ✔ 退出 0      |
| `src/site-links.selftest.ts`               | ✔ 退出 0      |
| `src/payment/legacy-bytes.selftest.ts`     | ✔ 退出 0      |
| `src/core/link-bytes.selftest.ts`          | ✔ 退出 0      |
| `scripts/ci-shard.selftest.ts`             | ✔ 退出 0      |
| `src/catalog-money.selftest.ts`            | ✔ 退出 0      |
| `console/src/fields/fields.selftest.tsx`   | ✔ 1751 项断言 |

## 验收记录

### 首轮文档核对（2026-10-26，协调者答复前）

- ✔ 路径 / 行号：共 69 个引用行号段（去重 62 段）逐项核对；引用文件的工作区内容均与 4ff0d93 相同，行号在界内，链接目标存在。原稿仅有一处显式源码定位、含两段行号，仍有效，未改。
- ✔ 现有接口与条款：上表逐项核对到定义 / 调用方；`HandoffVocab` 确认 104 键。R2 的两个新增接口仍标待扩展，未把 09 已实现能力重复列为待建核心。
- ✘ 「全部引用含义已无缺口」尚不能全称通过：R15 将模拟目标与 v2 时钟混用，R17 误认为已有通用包回滚检查，另有当时 Open 所列接入与内部矛盾；首轮保留原条款待确认。此项已由下方第二轮文档裁决收口，仍不当作 ready 或实现验收。
- ✔ Status / 决定 / 步骤：spec 仍 draft，只在原三条 Revisions 后加第四条；原开放问题 1–6 与验收 1–11 逐字不变。22 个步骤编号、顺序及未勾选状态与基线相同，每步都有做 / 验 / 依赖。
- ✔ 范围：`git diff --stat` 只含本目录 spec / plan；新增行无本机绝对路径或过长假企微标识，锁定文件与其他文件无改动。
- ✔ `pnpm format:check`：退出 0，831 个文件格式检查通过；`git diff --check`：退出 0。本轮未运行 lint / typecheck / 全量 test、真实模型或外部服务；没有费用。

### 第二轮文档裁决（2026-10-26，协调者答复后）

- ✔ Open 1–9 均已移到「已定」，正文 / 新接口 / 验收 / 步骤对应落实；第 2 条为暂定 B，其余 A。R17 的 owner 确认作为 ready 条件保留，没有提前确认或升级 Status。
- ✔ spec 的开工核对 Revisions 已补指定句，Amends 补 08 / 09 的核心归属；新增接口均注明待实现。仍仅本目录 spec / plan 两文件有改动，22 个原步骤保持未勾选，无提交。
- ✔ `pnpm format:check`：退出 0，831 个文件通过；`git diff --check`：退出 0。仅作本轮文档检查，未跑全量测试、真实模型或外部服务，无费用。

### 第三轮文档修订（2026-10-26，只读评审六条答复后）

- ✔ 六条均已落实到正文 / 接口 / 验收 / 计划及已定 10–15；下架禁令按现行契约对齐，跟进明确覆盖生成器和两种调度路径，建单与确认的边界用例已补。
- ✔ 第七行 Revisions 已追加指定句，核心修改的 Amends 归属已补；Status 仍 draft、pre-10 保留 B、Open 无，22 个实现步骤未勾选，只改本目录 spec / plan，没有提交。
- ✔ `pnpm format:check`：退出 0，831 个文件通过；`git diff --check`：退出 0。只检查文档，未运行全量测试、真实模型或外部服务，没有费用或后台资源。

## 费用记录

| 日期 | 步骤 | 内容 | 金额 |
| ---- | ---- | ---- | ---: |

## Open

无。

## 已定

2026-10-26 协调者答复：本节 1–9 沿用首轮 Open 编号，10–15 为后续评审补充 1–6；均不是 spec 中 owner 2026-10-23 已定的开放问题 1–6。第 2 条按答复称 B、以本节及 R17 的具体条件为准；其余八条为 A。均已落入 spec；owner 已于 2026-10-26 随 ready 确认 R17，Status 为 ready。

1. **A · 报价说明。** 新增可选纯函数 `PackRuntime.quotes.notes(order, policy)`；服务端只对本租户可读且 approved / paid 的报价返回说明，其余状态 / 404 不调用，无钩子 / 空数组不加字段。落点：R13、核心接口、验收 7、步骤 5；头部 Amends 09 R2 / R9。
2. **B · pre-10 回滚。** 全库有 part 条目、industrial 租户（含停用）或带 part 行和 approval 的 v2 工业报价（含终态 / 重置历史），退到 pre-10 一律 guard=9 / deploy=1；提示「前滚修复，或者回滚到另一个含 10 的 tag」。手动 tag 树 / 自动镜像同查新建 `src/packs/industrial/runtime.ts`，不做清理删除来放行，未知从严，三项均无才由本项放行；pre-09 独立保留。**owner 已于 2026-10-26 定 ready 时确认**。落点：R1 / R17、验收 11、步骤 1.1 / 15–17；头部 Amends 08 R13 / 09 R15。
3. **A · 模拟种子。** 只扩 `SimGoal.initial.orders.approval`，decidedAt 嵌在 approval 内；沿用 FIXTURE_CLOCK / fixtureClock，v2 不扩审批种子，保留旧种子无审批与 pending_payment 单槽校验，分目标复现待审 / 已批 / 过期；初始化不发通知。落点：R15、种子接口、验收 9、步骤 12–13；头部归属 08 R11 / 04 R11 / 06 回归集扩展，不重复扩 09 的正式订单类型。
4. **A · 工具副作用。** create_quote_sheet 只是唯一建单工具；find_parts / quote_items 声明 session，建单声明 session / order / notify，转人工声明 session / handoff / notify；全不缓存，建单 / 转人工阻止重试，前两个可重算；跟进排除四个有副作用工具。落点：R5、工具接口表、验收 4、步骤 4。
5. **A · 确定性裁剪。** 保留 12 行 / 600 字硬上限，N 按最终完全删掉的原始询价行计数（不重复计部分删句），补句计入预算；保护句自身超限用无链接 / 无 N 的短句兜底，跟进删空不发。10+5 验收限定短行样本，另测二次裁剪 / 超长保护内容。落点：R9、验收 5、步骤 7 / 10。
6. **A · 状态容量。** rfqDraft 只留有界编号 / 版本 / 数量 / 匹配类型 / 时间；型号借已有内存版本接口还原，不复制长文本。必留状态 ≤ 6,144 字节，partsInPlay 最旧优先整项淘汰，完整 JSON ≤ 8,192 字节；不丢摘要行或改 match / 时间，淘汰不改变确认 / 自动批准。落点：R7、状态接口、验收 8、步骤 4 / 6。
7. **A · 性能口径。** p95 ≤ 50 ms 只约束已装载 40 条快照、最多 30 行的归一 / 精确 / 别名 / 前缀匹配与定价；语义召回保留，含 embedding 的工具端到端时延、样本量与环境另记。落点：R3、性能段、验收 3–4、步骤 2–3。
8. **A · 人审表述。** 安全段写「缺省人审，自动批准按 R6」，SOP / policy / 固定句与其一致，默认阈值 0 与新建三条件自动批准都验证；复用按已批准 / 待审状态投影（见已定 13）。落点：安全段、验收 7、步骤 5 / 10；owner 2026-10-23 的原决定不变。
9. **A · 跟进链接。** 核心新增 `linkWhitelistFollowupStep`，与主回复共用 text / session 的窄删除逻辑及登记 / allowed 判定；两个上下文都已有 recordGuard，分别记录，跟进不依赖主回复专属字段，只删不补；生成与调度缺口由已定 11–12 补齐。落点：R8、核心接口、验收 5、步骤 7；头部 Amends 09 R10，沿用 04 R9，主回复与旅游字节不变。

10. **评审 1 · 本期不做下架。** 跨条目检查只在上架与编辑 active 时调用，删除 active → draft 的检查触发与引用方例外；按现行 SQL / 01 R8 / 后台 UX 拒绝下架，属于契约对齐。落点：R2、非目标、验收 2、步骤 1；回滚仍保留 B，仅把不存在的「下架」样本改为草稿 / 已上架。
11. **评审 2 · 跟进删空跳过。** 白名单启用包的 followUpText 在护栏删空后返回空串，文件扫描和数据库任务在预占 / 记账前跳过：不发送、不占额度、不增长 count / stages 等元数据、不写空消息；数据库 cancelled / guard_empty 不立即重排。旅游继续换原模板发出。落点：R14、核心接口、验收 8、步骤 7 / 11；Amends 02 R17 / R18、04 R9 / R13。
12. **评审 3 · 完整报价链接。** 启用了 linkWhitelistStep 的包，生成器保留完整 ord_ URL 给登记 / allowed 判断，旅游保留旧清洗；验收从真实 followUpText / 生成 / 护栏链路跑到两种发送路径，只桩 LLM 与发送端。落点：R8、核心接口、验收 5 / 8、步骤 7；Amends 09 R10。
13. **评审 4 · 新建与复用分开。** 三条件限制只用于新建自动批准；核心 reused 为 true 时按已有审批状态返回。默认人审 → 人工批准 → 相同行项 / 数量 / 现价重复建单必须复用原 approved、原链接与金额，不重审、不新增订单或审批通知。落点：R6、工具接口、验收 7、步骤 5 / 10。
14. **评审 5 · 拒绝结果完整投影。** empty_lines、kind_unknown、item_inactive、invalid_qty、below_moq 分别原样保留 reason / code；只有 below_moq 带合法 moq，不透传 detail，混合拒绝保留全部行 / 顺序且整单不建单。未知原因 / 非法 detail / 抛错走工具失败，不误报低于起订量。落点：R5、投影表与结果类型、验收 4、步骤 4。
15. **评审 6 · 确认候选与同时间排序。** 同一 now 用 quoteState 只收 pending / approved / expired，排除已付、失效、被取代；比较事件时间，同时间草稿优先，订单再比 createdAt / id 降序，preModel / contextNote 共用规则。补终态与打乱遍历顺序的同毫秒回归。落点：R11、核心接口、验收 6、步骤 9。

## 交接记录

### 交接（2026-10-23，起草）

- 原「09 · 工业品询价包」经 Opus 评审后拆成 [09](../09-quote-approval/spec.md)（核心）与本 spec（工业包与演示）。起草稿在分支 `docs/08-spec`，没推。
- 经三轮 Opus 评审修订；开放问题 1–6 owner 2026-10-23 全部照推荐定，品牌名「衡石工业品」（spec 第三条 `Revisions:`）。`Status` 仍是 `draft`。
- 下一步：08、09 实现并上线之后，owner 翻 `ready`，同一个 docs PR 带上 ADR-005 与主参考拍板表的修订，再补「工作量、依赖与并行」。

### 交接（2026-10-26，08 / 09 实现后开工核对）

- 已完成：按 4ff0d93 对齐本目录两份文档，新增第四条 Revisions，落实 owner 的联合上线决定；各步做 / 验 / 依赖、接口依据与待确认问题已记录。
- 当前状态：仅 spec 与 plan 有未提交文档 diff；spec 仍 draft，22 个原步骤（0–20 含 1.1）均未勾选。没有实现代码或功能半成品，不提交、不 push、不开 PR。
- 未完成 / 阻塞：Open 1–9 尚待确认；第 0 步的旅游基准、104 键分类、预发检查未执行，ADR-005 与目录外反向引用仍留 ready 的 docs PR。本轮未访问服务器、密钥、外部服务或真实模型，没有创建后台进程、浏览器、容器。
- 下一步：owner / 协调者确认 Open，按决定修订对应条款并记 Revisions；owner 决定 ready 时再落目录外引用、ADR-005 与主参考。之后从第 0 步未完成项目继续；09 的 15–18 按本计划 15–20 联合完成，不提前上线或翻 implemented。

### 交接（2026-10-26，协调者答复后）

- 已完成：九条答复落入 spec 正文、接口、验收与执行步骤；第七行的开工核对 Revisions 末尾补「按协调者答复定了 Open 1–9」；头部补核心扩展归属，Open 改为无，九条移至「已定」。R17 按协调者暂定 B，owner 定 ready 时确认。
- 当前状态：仍只有本目录两份文档的未提交 diff；Status 为 draft，22 个实现步骤保持未勾选。没有实现代码、提交、push 或 PR；没有访问服务器、密钥、外部服务、真实模型，没有新增后台资源。
- 下一步：owner 决定 ready 并确认 R17 后，在对应 docs PR 补目录外反向引用、ADR-005 与主参考；从步骤 0 的基准 / 词表 / 预发未完成项继续。新增 notes、跟进链接、模拟种子与 pre-10 guard 均只是本轮定下的待实现任务，不当作代码验收。

### 交接（2026-10-26，只读评审六条答复后）

- 已完成：六条答复已落入 spec 正文、接口、验收、Amends 与 plan 步骤 / 已定 10–15；开工核对 Revisions 追加「按评审补了 6 处」，并注明下架条款是对齐现行契约。pre-10 回滚保留 B，Open 无。
- 当前状态：Status 仍 draft，只改本目录两份文档；22 个实现步骤均未勾选。没有实现代码、提交、push 或 PR，没有访问服务器、密钥、真实模型或外部服务，没有后台进程 / 容器。
- 下一步：owner 决定 ready 时确认暂定的 R17 并补目录外反向引用、ADR-005 与主参考；继续步骤 0 未完成项。第 7 步须连同核心生成器、删空结果和两条调度链路一起实现验收，不能只加包级护栏。

### 交接（2026-10-26，owner 定 ready）

- 已完成：owner 确认 10 为 ready，R17 方案 B 已由 owner 确认；ADR-005 记录 2026-10-23 的公开参考包决定，ADR-003 加部分取代与修订标记，02、04、06、08、09、ADR-004 与后台 UX 的头部反向引用已补齐；主参考同步参考包、10 ready 与 09 / 10 联合上线安排。
- 当前状态：仅文档改动，22 个实现步骤与勾选均未动；未提交、未 push，没有实现代码或功能半成品，未访问服务器、密钥、真实模型或外部服务。
- 验证：`pnpm format:check`、`pnpm lint`、`git diff --check` 均通过（退出码 0）；lint 未配置敏感词表，内容黑名单按脚本提示跳过。八份被引用的旧文档原文逐字节不变，仅加头部行；22 个步骤逐字节不变，相对链接有效，新增行无本机绝对路径或超长假企微 ID。
- 附加门禁：`pnpm typecheck` 通过；`pnpm test` 在 1,200 秒上限以 142 退出，停在严格租户模式的渠道套件，完整测试链未完成，已完成子测试未见断言失败。未配置 `PG_TEST_URL`，真实 PG 分支按套件规则跳过；没有启动容器，已确认本轮测试进程组不再存在。
- 下一步：A 批，从第 0 步起；先复核开工条件并完成旅游基准、104 键分类与经授权的预发检查。09 第 15–18 步仍与 10 联合验收、一次上线，不提前翻 implemented。

### 交接（2026-10-26，A 批第 0 步完成）

- 已完成：20 处当前接口抽查、104 键处理表（80 通用照搬 / 4 旅游专有不匹配 / 20 工业改写，含逐键语义、处理方法、源码依据与第 8 步样例）、实际开工前缀及八文件 SHA-256、两套 bytes / 09 自测 / 两种 v2 的基准采集，第 0 步已勾选。
- 验证：format:check / lint / typecheck / test:locked 均退出 0；7 套具名基准自测均退出 0；两种 v2 各 865/865、8587 项断言、0 处快照差异，PREFIX 两哈希符合共同约定。词表 104 键与接口同序且无重复遗漏，4 条不匹配键的旧旅游样例均实测可命中；git diff --check、锁定八文件 / 基线 / 两份夹具零 diff、新增行公共边界补查均通过。内容敏感词表未配置与真实 PG 分支跳过已在实施记录明示；完整 pnpm test 按本批要求留 CI。
- 当前状态：只有本 plan 的干净、可审阅文档 diff，无代码半成品；spec 仍 ready，第 1 步及以后未动。未提交、未 push、未开 PR；未访问服务器、密钥、真实模型或外部服务，未新增夹具、容器、浏览器；本批启动的测试命令均已退出，无遗留后台任务。
- 待授权：第 0 步原文的预发 R16 三项 Host 开通前检查移到第 16 步上线前复验，只挡上线、不挡实现；不要把本机 Host 源码核对当作预发实测。
- 下一步：**B 批（第 1、1.1 步）**，先做声明式 itemRules 与 schema / checkItem 同源规则，再做工业包骨架、登记、part 字段、跨条目检查与 CSV。第 8 步按本表落工业词表及正反例；后续每批保持旅游 / 09 基准逐字节不变，不能为新链接重写旧夹具或基线。09 的收尾继续与 10 联合验收、一次上线，不提前翻 implemented。

### 交接（2026-10-26，B+C 批第 1–6 步完成）

- 已完成第 1、1.1、2、3、4、5、6 步并勾选；协调者的 currentPolicy 接口、Revisions / Amends 与标签裁决已落实。实现取舍、逐步验收、四套新自测与全部硬性对照见「B+C 批 · 第 1–6 步」。
- 当前为未提交、可审阅的完整本批 diff；format / lint / typecheck / locked、相关自测与旅游字节 / v2 对照通过。spec 保持 ready；不提交、不 push、不开 PR。真实 PG 分支与完整测试留 CI；预发 R16 仍留上线前授权复验，不把本机结果当成线上验收。
- 下一步：**D 批（第 7–9 步）**。沿用工业包的 StateSchema / draftParts / latestQuoteCandidate，确认回复的 preModel 与 contextNote 共用该候选函数；继续完成链接与金额 / 工业护栏、104 键词表及确定性转人工。E 批再补可发布 SOP、政策文案、跟进与后台配置；本批没有演示产品和完整发布配置，不提前开通工业演示租户。09 继续与 10 联合验收、一次上线，不提前翻 implemented。
- 无待确认问题；无测试后台资源遗留，费用零。

### 交接（2026-10-26，D+E 批第 7–11 步完成）

- 第7–11步已完成并勾选；实际改动、自定细节、新增两套自测、61套相关验证及旅游 / 09 的硬性对照见「D+E 批 · 第 7–11 步」。新增工业正常 / 加载 / 空 / 错误态 DOM 用例与离线字体产物一并交付；浏览器视觉走查受沙箱限制，不能当作已完成。
- 当前是未提交、可审阅的完整本批 diff；Status 保持 ready，不提交、不 push、不开 PR。无演示产品、评测基线改动或生产操作；真实 PG 与完整测试留 CI，真实模型和预发 R16 仍留后续获授权的联合验收。
- 下一步：**F 批（第 12–14 步）**，新增工业 v2 cases及模拟目标，再造约40条合成产品与CSV。v2不扩审批种子；模拟目标的嵌套approval沿用现有FIXTURE_CLOCK。保留865条旧快照逐字节一致，沿用PACK_FIXTURES门控，不发明开关；09继续与10联合验收、一次上线，不提前翻implemented。
- 工业运行时可直接装载本包参考SOP / policy / brand，测试与评测的产品夹具仍须各自提供；不要把本批小夹具当演示租户数据。无待确认问题，无后台服务 / 浏览器 / 容器遗留，费用零。

### D+E 批 CI 时区修复（基于 11e834a）

- 根因是工业跟进自测没有完整注入时钟：替换 Date.now 不影响 new Date()，四处 runFollowUpScan(push) 的静默判断仍读真实运行钟点；固定 04:00Z 在 UTC 又落入静默时段，数据库任务会顺延。修前 TZ=UTC 重现原第187行预期1、实际0；同轮逐个跑 item-rules 及五套工业自测，只有 industrial-followup 失败。
- 产品依据：02 spec「任务表与跟进」沿用22:00–9:00免打扰；core/followup 的 inQuietHours / deferQuiet 和原 jobs 自测按本地时间判断。生产 Dockerfile 安装 tzdata 并显式 ENV TZ=Asia/Shanghai，compose 未覆盖时区；本次未访问生产，不把镜像配置核对称为线上实测。按现有部署约定，这是测试隔离缺陷，本次不改产品、旅游行为或时区契约。
- 修复仅在 industrial-followup.selftest：固定日期取进程本地12:00，四处扫描显式传 new Date(now)，使扫描免打扰判断与会话 / 数据库任务使用同一测试时间。补断言：23:00不生成、不发送、不记账；中午删空必须经过真实生成和护栏，防止因静默提前退出而假通过。
- 同类静态排查：industrial-quotes / industrial-replies 的固定UTC值用于时间戳、有效期与候选排序，不依赖跟进静默钟点；工业报价卡用东八区偏移加UTC取值。catalog / domain / item-rules 没有本地日期依赖。没有为通过测试强制覆盖进程TZ。
- 验证日志在 gitignored 的 var/10-tz：format:check、lint、typecheck、check-fonts 均退出0；字体730个界面汉字全部覆盖，913码位 / 191968 B，未修改字体产物。完整测试与真实PG仍按本批约定留CI，不调用外部服务或真实模型。
- 修后逐个以 TZ=UTC、TZ=Asia/Shanghai 运行下列8套，16次均退出0（results.json）；jobs在每个时区均109项断言通过，工业跟进两种存储路径及旅游模板 / 计数对照均通过。

| 自测                                | UTC | Asia/Shanghai |
| ----------------------------------- | --- | ------------- |
| src/item-rules.selftest.ts          | ✔   | ✔             |
| src/industrial-catalog.selftest.ts  | ✔   | ✔             |
| src/industrial-domain.selftest.ts   | ✔   | ✔             |
| src/industrial-followup.selftest.ts | ✔   | ✔             |
| src/industrial-quotes.selftest.ts   | ✔   | ✔             |
| src/industrial-replies.selftest.ts  | ✔   | ✔             |
| src/followup-guards.selftest.ts     | ✔   | ✔             |
| src/jobs/jobs.selftest.ts           | ✔   | ✔             |

- 当前仅测试与本plan的未提交diff；不提交、不push、不开PR。下一步仍为F批第12–14步，无需确认新决定。

### 交接（2026-10-26，F 批第 12–14 步）

- 第 12–14 步已实现并勾选；新增用例、审批模拟种子、目标、演示 JSON / CSV 与两套自测，当前仅工作区 diff，不提交、不 push、不开 PR；spec 保持 ready。
- 最终门禁、两种 v2 配置、31 套相关自测全部通过；独立比对 865 条旧快照逐字节相同。逐套结果、28 个目标（15 safety）、40 条产品、工业 required 发布闸的本机证据见本批实施记录；没有半成品或待确认问题。
- 下一步：**第 15 步中期审查**，核对 10 验收 1–9 并与 09 联验；真实模型 k = 5 由协调者在 owner 授权后跑，费用与结果另记。本批 mock 不代替真实模型质量闸。
- **第 16 步与 09 一起上线，需要 owner 当次授权；预发 R16 开通前检查同样需要授权。** 演示租户开通、Host 隔离、网页完整流程与线上哈希未执行，不把本机产品验收当成验收 10 的线上通过。
