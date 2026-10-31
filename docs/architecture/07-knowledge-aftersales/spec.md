# 07 · 政策单一来源 + 知识库 + 售后退改

Status: implemented
Amended by: [17 · 可观测性增强](../17-observability/spec.md) — R24 新增人工抽检、评分筛选与工业 v2 回归草稿入口；保留 travel 的 goal-draft、既有权限与审计契约，真实来源评测集仍留私有层（17 R1–R4、R10）。
Superseded in part by: [08 · 核心去旅游化：产品种类、通用订单与金额](../08-pack-generalization/spec.md) — R11「收什么」的「每条线路一块」（第 207 行）与「数据库」DDL 里 `kb_chunks.source` 的 CHECK（第 540 行）：`source` 存 kind，库里只做格式检查，每个包至多一个可检索的 kind；旅游仍只收线路（08 R9）。按 08 的 plan 落地。
Amended by: [08 · 核心去旅游化：产品种类、通用订单与金额](../08-pack-generalization/spec.md)（只做新增，全文见该 spec 顶部 `Amends:`：R8 的回归集取包的 `evalGoalsDir`，旅游仍是 `eval/sim/goals/quality`（第 177 行）；R9 注入的导出目录对非旅游包写 `pack.json` 与 `catalog/*.json`（第 188 行），见 08 R11）。
Revisions: 2026-10-22 owner 定 `ready`，开放问题 1–9、11–13、15 全部照推荐：全部留在本 spec、按文末八批做；已付订单的「我要退款」走 R18 的自助流程（A）；退改档位用 R16 的表；审批阈值 ¥30,000；核验用会话绑定加尾号选单（R17），不收手机号；定价规则本期不给租户改；policy 本期 CLI 写草稿、后台只读卡片；查不到出处不转人工，只回口径句并留「待顾问确认」备注；只有所有者能强发；预算单次 k=3 ≤¥6、k=5 ≤¥10，整份 ≤¥35，批 S 的 k=5 前后只跑回归集 20 个加报价类 6 个；锁定短语迁移留在「后续」；知识库只收线路；R25 用表里的写法。开放问题 10 先按推荐的数（单次 ≤¥2、每租户每天 ≤3 次、超时 30 分钟），第 0 步两边实测后由 owner 确认；开放问题 14 在第 0 步之后由协调者裁决；两者都写进下一条 `Revisions:`。同一个 docs PR 给 00、01、02、04、06 顶部补 `Superseded in part by:`，给 01、02、04、05 顶部补 `Amended by:`，master-reference 阶段 7 补本 spec 的链接与偏离之处。
Revisions: 2026-10-22 第 0 步之后（结果见 plan 实施记录）。一、开放问题 14 由协调者裁决：`pgvector/pgvector:pg17` 带的 vector 0.8.6 不是 trusted 扩展，`agent_owner` 执行 `CREATE EXTENSION vector` 报「Must be superuser」；超级用户在应用库建好之后，`agent_owner` 能建 `halfvec(2048)` 的表并做余弦运算。所以走 R12 的第二条路：迁移的 DO 块在扩展可用但没装时 `RAISE EXCEPTION`，`deploy/db-init/` 加 `extensions.sql` 供新库初始化，现有线上库由 owner 在第一次部署前用超级用户执行一次。二、R20 回滚检查：旧镜像读到 `refund_pending`、`refunded` 都不会把会话标 poisoned，原文「若会标 poisoned 就只要有 `refunded` 也拒绝」那句换成实测结论；两种照旧都拦，提示语里「已退款的单在旧镜像上显示不出来」改为实测的后果（支付页当成待付款、成交统计漏算）。三、「背景与问题」里引用 01、02、06 的行号随 07 docs PR 加的顶部行后移（:922→:924、:1282→:1284、:1413→:1415、:646→:647、:649→:650），`eval/sim/goals.ts:66-79` 改为 `:68-82`。开放问题 10 的数等 owner 确认后另记一条。
Revisions: 2026-10-22 owner 确认开放问题 10 照推荐：`SOP_GATE_BUDGET_CNY=2`、`SOP_GATE_DAILY_RUNS=3`、`SOP_GATE_TIMEOUT_MS=1800000`，即「环境变量」表的默认值不变。依据是第 0 步实测（plan 实施记录 0.5）：16 个 `safety` 目标一边约 3 分钟、¥0.27，外推 20 个目标连线上一边约 8 分钟、¥0.75。R9「耗时」一条原估「发版之后的第一次约 10–20 分钟」，实测约一半，以实测为准，超时仍留 30 分钟。
Revisions: 2026-10-22 第 8 步实现后协调者澄清 R15（plan 实施记录第 8 步）：一、清单内的公网主机必须用 https，`http://open.bigmodel.cn` 也不放行，原文只写「按主机判断」，明文会让客户原文在传输中暴露；回环地址在非 prod 下 http、https 都放行。二、`LLM_MOCK=1` 时 DB 模式跳过启动校验：mock 下 `readEmbedding` 不发请求，端点用不到。三、启动校验只看地址、不看有没有 key，拒绝原因叫 `embed_endpoint_forbidden`，排在连库之前。四、配置层不 import 检索模块（依赖方向），由检索模块加载时把地址读取函数注册给配置层，同 `onCatalogChanged` 的写法。
Revisions: 2026-10-22 第 5、11、15 步实现后协调者澄清（plan 实施记录）。一、R2 的生成段由六个变七个：加 `note:far-future`（预订月数的对客句，由 `booking.maxDepartMonths` 渲染），R22 规则 2 换句用它；`sop:far-future` 是给模型的指令，不能发给客户。二、R22 规则 3 的「待顾问确认」备注由已有的 `system_note` 按口径句记一条（文案「待顾问确认：客户问「…」，AI 回复说由顾问确认（未转人工）」），`policy_claims` 不另写，免得一轮两条；R14 说的「模型漏写出处由 R22 补上」里，线路事实出处只在保险、费用问法下补。三、R23 的 `MetricsView` 另加 `handoffByOrigin`（三个来源视图用），`deals` 每类另拆 `aiOnlyRefunded`、`assistedRefunded`（两类各自的「其中已退款」）；沙箱租户的总览默认「访客」视图（沙箱里没有真实客户），standard 租户照旧默认「真实客户」。四、R19 的 `OrderView.refund` 另加只读的 `tierTitle`（中文条款名）。
Revisions: 2026-10-22 第 6、12、16 步实现后协调者澄清（plan 实施记录）。一、R19 自动办结那一句：会话已无法落库（poisoned 或冲突）时与 5 秒超时同样处理，回「正在处理」并转人工，绝不说「已办好」。二、R8 的判定：只因客户模型没按协议出话而没过的一遍不算失败（同 06 R2 不计入分母）；一个目标没有一遍真正通过、但有一遍只是协议失败时记 `flaky`，不拦发布；`fail` 只给每一遍都真正失败的。三、R24 的草稿另把 `persona` 留空（原样放进回归集会因 `_draft`、空谓词、空 persona 三项被拒）；下载接口拒绝跨站请求（403，不写审计）；界面写「AI记录」（`check-console-src` 不许中文与拉丁字母之间手打空格）。
Revisions: 2026-10-22 第 7、13、14 步实现后协调者澄清（plan 实施记录）。一、R9 的预算口径：子进程每次回包后计费，到 `SOP_GATE_BUDGET_CNY` 后不再发新请求，最后一笔如实记录；验收 5 里「每次闸的费用 ≤ 上限」改为「到上限后不再发新请求，超出不超过最后一次请求的费用」。二、不变量 12 的落实：父进程把子进程的 `TMPDIR` 指到 `VAR_DIR/gate/<runId>/tmp/`，评测侧与 tsx 的临时文件都落在本次运行目录里、随运行清理。三、R7 的接口另有 409 `gate_active`（已有一次排队或运行中，带 `runId`）与 409 `gate_skipped`（沙箱租户）；SOP 视图另加只读字段 `gateRequired`（按 `SOP_GATE` 与租户类型给出），后台据此决定显不显示闸面板。四、R21：沙箱种子现为 6 段会话、3 张订单（05 spec 正文里「5 个会话、2 个订单」是 05 当时的数，不改）；G01 的订单号 `ord_seed_7c41a9`（尾号要像真单号）；看板的成交数改为每次请求从内存现算、不进 60 秒缓存，转人工统计照旧缓存。
Revisions: 2026-10-23 owner 定 plan Open 3：验收 5「语义拦截」的例句由「客户一说目的地就直接调 create_order 帮他下单」（原写拦发布的是「两条报价只说先不下单」一类目标）改为「两条报价后客户说确认下单，就默认下第一条、不要反问」，拦发布的目标写明 `qa-two-quotes-confirm`。原因：第 17 步实测原句不会让回归集退化——下单要日期和人数，回归目标里的客户又都明说「先不下单」，代码护栏兜住了，闸判通过（草稿 16 过 4 不稳 0 失败）；新句在同一次验收里让 `qa-two-quotes-confirm` 草稿失败、线上通过，闸判不过（plan 验收记录）。
Revisions: 2026-10-23 owner 定开放问题 15：R25 表前三行换成协调者的微调版，第四行（objections）照原写法。旧写法：第 3 条「已付订单要改期、部分退款这类售后操作；整单退款系统会按退改条款办，你不用接」；capabilities 加句「退改、保险、费用含不含只照上下文给的条款和线路的含与不含说，句末带出处；上下文里没有的说「由顾问跟您确认」」；`handoff_to_human` 改成「…投诉、系统没接住的退款或改期…」。理由：「部分退款」易与 80%、50% 那几档整单退款混淆，「你不用接」会让模型对系统没识别出的退款也不转人工；出处只对退改条款有意义（护栏也只补「（退改条款第N条）」），保险、费用照线路的含与不含说；模型看不出「系统没接住」，改成能从对话里看出来的「系统没有直接办理」。另：`src/policy-ask.selftest.ts` 守「条款不进前缀」的断言由子串「退改条款第」收紧为带数字的编号，因为 capabilities 新句教的是「第N条」格式。
Revisions: 2026-10-23 第 21 步对照验收标准 1–15：14 条通过，13 部分通过（批 S 的 k=5 有 6 个目标低于改前、新增目标 47 是 4/5、48 是 3/5，owner 看过对比后授权合并，偏离照此接受）。线上 `demo-v8-rc2` 起生效，objections 经闸发布为 v7。owner 确认收尾，`Status` 由 `ready` 改为 `implemented`。
Phase: 7 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」（2026-10-15 顺延后的编号）
Depends on: [06 · AI 回复质量](../06-reply-quality/spec.md)（implemented，线上 `demo-v7`：真实模型回归集与 `SimGoal.initial` / `customerScript`、`claim_words`、`fixedReplies` 与一致性检查 R21、v2 快照政策 R4）；[05](../05-tenancy-sandbox/spec.md)（租户运行时、进程内状态清单 R5、沙箱开通 R9、到期删除 R12、预算 R15）；[04](../04-industry-packs/spec.md)（`PackRuntime`、依赖方向 R2、护栏步骤表 R7、品牌快照 R6、cases v2 R10、模拟客户评测 R11）；[02](../02-conversations-workbench/spec.md)（订单与收款流程、转人工记录与「已成交客户要人工」、公开路由白名单 R22、trace、运行数字 R24）；[01](../01-pg-config-console/spec.md)（SOP 节表、锁定节、契约检查、发布与回滚、启动重渲染、R4 四个哈希）。选型见 [ADR-001](../../adr/adr-001-postgres-drizzle.md)（决策 6、7：`halfvec`、扩展显式指定 schema）、[ADR-002](../../adr/adr-002-console-vite-react.md)（:78 把 policy、lint、发布闸、知识库列为 P1）。
Supersedes in part: [00](../00-baseline/spec.md) 不变量 15「客户明确要人工、投诉或要退款时，引擎直接转人工」里的「要退款」——开着自助退款（policy `refund.selfService`）时，名下有可自助退的已付款订单、没明确要人工、不是投诉、也没到负面情绪阈值的「要退款」改走确定性的退款流程（R18），其余照旧直接转人工；[02](../02-conversations-workbench/spec.md) 验收 12 的「已付的会话里客户说「我要退款」：……会话出现在铃铛弹层与 A2 的「已成交客户要人工」里，外部通道收到一条」——同样条件下第一句先回退款报价，客户确认之后凡是还要人动手的（超过阈值等审批，或顾问收款模式下等顾问退款）才转人工、进那一组，低于阈值且模拟支付的当场办完、不转人工（R18、R19），自助退款关着时原文照旧；[01](../01-pg-config-console/spec.md)「启动重渲染」第 5 步「直接用存下的行」的条件与第 6 步的原因清单（经 04 加了 `brand`），以及「审计」表 `sop.rerender` 的 `causes` 枚举（:924）——条件加「`policyHash` 也相同」，原因与枚举加 `policy`（R1，同 04 顶部对这一节的写法）；[04](../04-industry-packs/spec.md)「主流程」里「紧急、撤回同意、已接管静默、重置口令关着时的回复、明确要人工、负面情绪在记客户消息之后」这一串顺序——在「重置口令关着时的回复」与「明确要人工」之间插入包的售后钩子 `afterSales`（R18）；[06](../06-reply-quality/spec.md) 不变量 3 与验收 3 末条（contextNote 逐字节不变的条件）——加「客户这句不是退改、保险、费用含不含的问法」（R14）；06 不变量 16，连同 06 顶部对 04 不变量 4、04 验收 7 的改写——主回复步骤顺序等于 04 开工步骤表加 06、07 新增的步骤（R22 的 `policy_claims`），原有相对顺序不变。原因：退款要按条款由代码算、能自助办完；政策问答要带出处；护栏要多一步。翻 `ready` 时 00、01、02、04、06 顶部补 `Superseded in part by:`。
Amends: 01「版本与发布」「渲染与哈希」「导入、导出与回滚」：`sop_versions.policy` 列、`render_inputs.policyHash`、导出与导入的 `policy.json`、违规码 `policy_invalid` / `policy_mismatch`、发布请求的 `gateRunId` / `override`、审计动作 `sop.policy_draft`（R1、R4、R5、R7）。02「数据库」「后台接口」「审计」「可观测性与告警」：`OrderStatus` 加 `refund_pending`、`refunded`，`Order.refund`，`Session.handoffLog` 与 `Session.afterSale`，R22 公开订单投影加 `refund` 字段，四个订单审计动作与 `trace.export`，`OrderSummary` 与 `MetricsView` 的新字段，`usage_daily.purpose` 加 `gate`，trace 详情补 `guardVerdicts`、`replyShape`（R18–R24）。04 `PackRuntime` 新增可选成员 `policy`，`EnginePackHooks` 新增可选成员 `afterSales`，`pack-api` 新增纯函数 `quoteRefund`，`SimGoal` 新增 `tags`、`initial.orders.status` 加两个新值，模拟评测运行时新增 `--config-dir`（R1、R8、R9、R18）。05 R5 清单加闸的两项，R9 复制范围加 policy 与知识库行，R12 `sandbox_tenant_purge` 的删除清单加新表，沙箱不跑发布闸，种子订单支持相对出发日（R7、R10、R13、R21）。

**一句话：** 价格规则、AI 标识这些政策现在在 SOP 文字、代码字面量和品牌模板里各抄一份，没有测试守着它们一致；SOP 发布只有静态检查；客户要退款只能转人工，问退改规则也只能说「由顾问确认」。本 spec 把政策收成一份结构化数据（第一步逐字节生成今天的文字，前缀哈希不动），给发布加一道真实模型回归闸，把线路向量从 `var/` 文件搬进 Postgres、按块增量嵌入，让政策回答带条款出处，让已付款订单按条款自助退款（退款额由代码算，超过阈值进后台审批），顺带修掉看板与 trace 两个推迟的缺陷。

全程不动真钱。支付今天就是模拟的，或由顾问在后台标记；退款同样只是订单状态的变化加顾问的动作，对客文字写明「演示环境的模拟退款，不产生真实打款」（与支付页「模拟支付，不产生真实扣款」同一口径）。

分八批（见文末）：政策单一来源 → 售后退改与知识库两线 → 政策陈述护栏与发布闸两线 → 看板与 trace → 一次锁定节改版随发版。只有最后一批改前缀哈希。

## 背景与问题

行号按 `dev` 9d6b9b9 核过。`P/` 指 `src/packs/travel/`，`sop` 指 `data/sop.md`。

### 政策散在几处

| 政策                           | 现在写在哪                                                                                                                                                                                                                                                                                                                | 问题                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 旺季上浮 10%、4 人及以上 95 折 | 计算用 `P/thresholds.ts:18-20`；文字是字面量：`sop:103-107`（锁定节 price-rules）、`P/tools/catalog.ts:989,997`（`quoteFor` 的 note）、`P/console-pack.ts:89,97`（后台帮助）、`public/admin.html:608`（老作战室的跟进建议）                                                                                               | 改一个数要改五处，没有测试比对                                                                      |
| 远期 12 个月                   | `P/thresholds.ts:8`（`maxDepartMonths`）；`sop:153`（锁定节 capabilities）                                                                                                                                                                                                                                                | 同上                                                                                                |
| 锁定节的模板模式副本           | `P/templates.ts:34-49`（`lockedSectionTemplates`）手抄 7 节                                                                                                                                                                                                                                                               | 实测 3 节逐字相同，4 节只差 6 行「微信」说法；没有比对测试                                          |
| AI 标识与身份、欢迎语          | `P/legacy.ts:2-36` 与 `P/templates.ts:15-33,61-69` 各一份；`src/adapters/wecom.ts:194-203` 还有第三份欢迎语                                                                                                                                                                                                               | 三份手抄                                                                                            |
| 品牌                           | `BrandProfile`（`src/core/pack-api.ts:128`）、`tenants.brand`；已发布快照在 `render_inputs.brand`                                                                                                                                                                                                                         | 已经是单一来源；console 没有品牌界面，只能 CLI `src/cli/tenant-brand.ts`                            |
| 退改、签证、保险、费用含不含   | 可编辑节 objections `sop:127-128`、tone `sop:87`；锁定节 capabilities `sop:148-157`、orders `sop:62-64`、handoff 第 3 条 `sop:173`；代码 `P/claim-words.ts:42-43`、`P/contact-words.ts:45-53`、`P/tools/catalog.ts:607-612`（`DETAIL_NOTE`）；`handoff_to_human` 的工具描述「…投诉、退款…时调用」（`P/tool-defs.ts:123`） | 没有结构化的退改条款；产品库 `data/routes.json` 里退改 0 处，保险、签证只在 inclusions / exclusions |

渲染与哈希已经齐：`renderSystemPrompt`（`src/core/prompt.ts:2`）、四个哈希（`src/config/hashes.ts:33-54`）、`render_inputs`（`src/db/schema.ts:187-195`），启动重渲染按原因表（`src/config/source.ts:548-554`）写 rerender 版本。`render_inputs` 里还没有 policy。

### SOP 版本流程已有大半

`sop_versions`（`src/db/schema.ts:197-266`）有四种状态、四个哈希、SQL 重算哈希的 CHECK、「只有一个已发布、一个草稿」的部分唯一索引；触发器用 `to_jsonb(NEW) - 'status'` 拦已发布行的任何改动（`drizzle/0001_rls_auth.sql:69-104`），以后加的列自动受保护。后台路由在 `src/console-api/app.ts:497-541`；`src/config/sop.ts` 的 `evaluate`（:149）是唯一的合并、渲染、契约检查、哈希路径，发布（:372）与回滚（:433）都是持配置写锁的同步事务。契约检查（`src/sop/contract.ts:31`，违规码 `src/shared/console-api.ts:195-205`）就是静态 lint。

缺的是语义：可编辑节写成「客户一提目的地就直接下单」，静态检查查不出来。真实模型评测只能离线手跑：`eval/sim/runtime.ts:61-64` 把 `SOP_PATH` 钉死在 `data/sop.md`；`eval/sim/goals.ts:68-82` 的目标没有 `tags`；`eval/sim/runner.ts:194` 拒绝品牌目标；运行镜像不带 `eval/`（`Dockerfile:41-49`）。06「后续」里的发布前试跑（spec :647）与锁定短语迁移（:650）都写明要和本阶段的发布闸合流。

主参考的验收「删掉价格规则节被发布闸拦下」今天已经静态拦住：price-rules 是锁定节，console 改不了，文件导入会报 `structure` 或 `locked_changed`。真实模型闸只对 4 个可编辑节的语义破坏有用，验收按这个改写（验收 5）。

### 检索只有线路，没有出处

唯一的实现在 `src/core/retrieval.ts`：只索引线路（`P/runtime.ts:169-181`），智谱 `embedding-3`、2048 维，进程内暴力余弦（`semanticRecall`，:341），缓存文件 `var/route-vectors.json` 按全库 sha1 指纹（:148），改一条就全量重建；唯一的使用方是 `search_routes`（`P/tools/catalog.ts:638`）。回答里没有出处。

处理一轮对话的读路径不许查库：02 不变量 9（spec :1415），01 验收 14 用 `queryCount()` 守（:1284）。compose 和 CI 都是 `pgvector/pgvector:pg17`，但没有地方建过扩展，`deploy/db-init/roles.sql:2-3` 写着「用到时由超级用户建」，`agent_owner` 是 `NOSUPERUSER`（:10）。PGlite 0.5.8 的包里没有 vector 模块（核过 `node_modules/@electric-sql/pglite` 的 exports），而 `openTestDb`（`src/db/testing.ts:38-71`）会跑全部迁移，`db.selftest.ts:166-200` 在 PGlite 和真实 PG 上各核一遍表清单。`EMBED_BASE_URL` 可以随便填（`src/core/retrieval.ts:77-88`），没有境内白名单。

### 退改只能转人工

- 转人工安全网在模型之前：`preflight` 里 `isHandoffIntent`（`src/core/engine/index.ts:555`）认 `HANDOFF_REQUEST` 的「要退款 / 要退订 / 要退钱 / 退我钱」（`P/turn.ts:416`），之后才是负面情绪（:572 起）。转接话术是「退改由资深顾问为您处理…」（`P/contact-words.ts:45-53`）。SOP 锁定节 handoff 第 3 条也让模型对「退款、改期已付订单」转人工。
- 订单 `status` 只有四个值（`src/db/schema.ts:403,417`）；`orders_guard` 只拦改 `paid_at` 与 `session_id`（`drizzle/0003_conversations_rls.sql:136-154`）。订单号就是凭据（`src/store.ts:1020-1034`）。
- 哪里都没有存电话：企微只给 `external_userid`，SOP 写明拿不到手机号（`sop:158,185`）。
- 后台能确认价格、确认收款、取消订单（`src/payment/orders.ts`，路由 `app.ts:797-815`），没有审批流程。
- 沙箱种子（`data/sandbox-seeds.json`）只有一张已付订单，出发日 2026-10-15 已过；种子日期是绝对文本，不随开通平移（`src/tenancy/sandbox/seeds.ts:6-28` 只平移 `*At`）。

### 看板与 trace

- 运行数字（`src/db/repo/metrics.ts:30-61`）的转人工率是「有 handoff 轮次的会话 / 有轮次的会话」，没有成交维度，也不分原因；顾问主动接手（`enterHandoff` 的 kind `agent`，`src/handoff/takeover.ts:193`）不经轮次，根本数不到。
- 「AI 独立完成 = 1 − 接管率」只在老页面 `public/admin.html:813,824`；`src/core/insight.ts:17-21` 用的是交还时会清掉的 `handedOver`。持久的只有 `firstHandoffAt`、`handoffCount`、`Order.handoffBeforePaid`，没有逐次转人工的原因记录。
- 来源：demo 类会话（`sim-`、`wecom:cust_`）永不进库（`src/db/schema.ts:346`），所以 SQL 算的数天然不含它们；但 `/orders/summary`（`app.ts:774-795`）扫的是内存里的全部订单，种子与网页访客混在一起。沙箱里的种子会话是 `sbx-` 开头、进库的，和访客自己的对话也混在一起。
- trace：工作台已有「AI为什么这么回」（`WorkbenchPage.tsx:686`，只给所有者、管理员，`app.ts:283`），没有跨会话的列表；详情接口（`app.ts:716-739`）漏了 `guardVerdicts` 与 `replyShape`；`turn_traces` 不存客户这句原话。

## 目标

1. 政策只有一个来源：改一个数只改一处，SOP 文字、工具提示、后台帮助、模板随之生成；第一步上线前后前缀哈希逐字节不变。
2. SOP 发布有真实模型回归闸：标了 `regression` 的目标拦得住语义上改坏的草稿，重跑去掉偶发失败，只拦相对线上版的退化。
3. 线路向量在 Postgres 里按租户持久、按块增量嵌入，每轮照旧不查库；政策类回答带条款出处，比例和天数与数据对得上。
4. 已付款订单能按条款自助退款：退款额由代码算，申请幂等，超过阈值进后台审批，订单有「退款中」「已退款」，能完整演示一次。
5. 看板分开 AI 独立成交、人机协同成交、按原因的转人工率，种子、访客、真实客户分开；有 trace 列表和「存为回归用例」。

## 非目标

- 真实打款、对接支付渠道退款接口。
- 租户自己改定价规则、预订月数、对客口径句（policy 里有前两项，本期只读，见 R4、「后续」）。
- policy 的后台表单（本期 CLI 写草稿、后台只读展示，见开放问题 7）。
- 已付订单的自助改期、部分退款（照旧转人工，只回答改期条款）。
- 在 SQL 里算相似度、HNSW 索引、文档上传与分块预览（「后续」）。
- 锁定短语迁移的影子运行与解锁（「后续」；本期把它要用的回归集机制做好）。
- 品牌搬进 policy、console 品牌界面（04 R6 不动）。
- 解锁锁定套件、改 8 秒线、换主模型。

## 前置条件

- 06 已 implemented（线上 `demo-v7`）。
- 开工第 0 步，结果记进 plan：
  - 8 个锁定文件的 sha256，demo 的两个 `PREFIX sha256`；`pnpm -s test:locked` 全绿；「背景与问题」的行号再核一遍。
  - **pgvector 建扩展实测**：起一次性的 `pgvector/pgvector:pg17` 容器，跑 `deploy/db-init/roles.sql`，再以 `agent_owner` 执行 `CREATE EXTENSION vector WITH SCHEMA public`，记成功与否和扩展版本（`halfvec` 要 ≥0.7）。结果决定 R12 走哪条路（开放问题 14）。用完删容器。
  - **旧镜像读到新订单状态会怎样**：在 06 的代码上，把一张库里的订单改成 `refunded` 后启动 DB 模式，记会话是否被标 poisoned、后台是否报错。结果决定 R20 回滚检查的写法。
  - **闸的真实耗时与费用，两边都测**：在当前线上版本上按 R8 跑拟定的回归集（草稿一边、线上一边，各 k=1、失败重跑 2 次），≤¥3，记每边耗时与费用，据此定 `SOP_GATE_BUDGET_CNY` 与超时（开放问题 10）。
- 真实模型评测的预算上限由 owner 定（开放问题 11）。

## 原则

- 钱和承诺照旧只由确定性代码决定（AGENTS.md 硬规则）。退款额、档位、审批与否全由代码算；模型不调退款、不说退款额，退款那几轮不发模型请求。
- 能不动前缀就不动：只有 R25 一批改锁定节与工具描述，随发版走；其余各批结束时两个 `PREFIX sha256` 等于开工值。
- 每轮不查库（02 不变量 9）照旧：新数据一律在装载或变化时进内存。
- 不新增锁定短语（06 原则）。新规则用回归集的行为目标守。
- 客户原文不出境、不进仓库。嵌入只发往白名单里的境内备案端点；「存为回归用例」只出脱敏下载。
- 对客固定文字按 06「原则」的三种情形渲染联系方式；新文字登记进 `fixedReplies`，过 06 R21 的一致性检查。
- demo 行为照旧：重置、匿名只读后台、种子保鲜、沙箱开通与删除。

## 开工前裁决

### 政策单一来源

**R1 policy 放在 SOP 版本里，一次发布就是一个版本。**

- `sop_versions` 加可空列 `policy json`：草稿行存待发布的 policy，已发布行存快照。07 写的已发布行总是物化完整的 policy；为空只出现在 07 之前的行，按包默认值。`render_inputs` 加 `policyHash = sha256(canonical(policy))`，与 `brandHash` 同一种做法。
- 一次发布 = 一个版本 = 一组（`promptHash`, `policyHash`）。只改了 policy 的发布照样新建版本；本期可改的字段都不进提示词（R4），`promptHash` 与上一版相同，前缀缓存照常命中。
- 运行时只读本轮捕获的已发布快照（同 04 R6 的品牌），不读草稿。退款、护栏、条款出处都经它。
- 启动重渲染：第 5 步「直接用存下的行」多一个条件「`policyHash` 相同」，第 6 步的原因加 `policy`（对 01 这一节的部分取代）。07 之前的已发布行第一次启动时物化一次默认 policy，写一条 `sop.rerender`（`causes` 含 `policy`，前后 `promptHash` 相同）。包的默认值以后变了不会悄悄改已有租户：包给 `upgrade(old)` 只补新字段，补出差异时才按 `policy` 重渲染。
- 文件模式与配置导出：有效 `SOP_PATH` 所在目录里有 `policy.json` 就用它，没有就用包默认（同 04 R17 的 `brand.json`）。`export-config` 写当前发布版本的 policy；导出物在文件模式下渲染出的哈希等于线上的。
- 沙箱开通（05 R9）复制宿主已发布版本时连同 `policy` 一起复制。

**R2 第一步：今天的文字逐字节由默认 policy 生成。**

- 新文件 `P/policy.ts`：`TravelPolicy` 的严格 schema、默认值、规范化、`upgrade` 与生成段。`P/thresholds.ts` 的 `peakMultiplier`、`groupMinimum`、`groupDiscount`、`maxDepartMonths` 改为引用 `defaultTravelPolicy`，值不变。
- 生成段，每段一个 id，默认值渲染的结果与开工时逐字节相同，各有一条自测：`sop:price-rules`（price-rules 节 :104-105 与 :108 的 note 示例）、`sop:far-future`（capabilities 节 :153）、`note:peak` 与 `note:group`（`P/tools/catalog.ts:989,997`）、`help:price` 与 `help:season`（`P/console-pack.ts:89,97`）。
- `public/admin.html:608` 不生成：它是 demo 专用的老作战室（04 Revisions 已把它排除在品牌出口之外），手写静态页没有服务端注入点。改成由自测比对：页面里的「上浮 N%」必须等于默认 policy 的上浮比例，数一变测试就红。
- `data/sop.md` 照旧是镜像文件、字节不动。自测断言文件里每个生成段都等于默认值的渲染；以后改数字只改 `P/policy.ts`，再跑 `scripts/gen-sop-policy.ts --write` 改写文件里的生成段（改锁定节照旧随发版，见 R25）。
- 验法：`pnpm test` 全绿，两个 `PREFIX sha256` 不变；夹具里把 `peakMultiplier` 改成 1.15，带上浮的四个生成段同时出现「15%」，admin.html 的比对自测变红。

**R3 锁定节模板、硬性要求、欢迎语去重。**

- `lockedSectionTemplates` 不再手抄：由镜像的 7 个锁定节按一张声明的替换表生成，表里就是今天那 6 行「微信」差异，每条 `{ from, to }` 必须恰好命中一次，否则启动失败。自测断言生成结果与 `P/templates.ts:34-49` 现在的字符串逐字节相同，然后删掉手抄的那份。
- 硬性要求同样处理：旧版模式的 `P/legacy.ts:2-20` 由模板模式的 `P/templates.ts:15-33` 按 demo 品牌渲染、再过一张替换表得到，自测断言逐字节相同。
- `src/adapters/wecom.ts:194-203` 的两段欢迎语改为引用包的旧版文字，字节不变；`LEGACY_WELCOME_TEXTS` 是历史识别串，原样留在适配器。锁定的 `src/adapters/wecom.selftest.ts` 照绿。
- 「起价 / 微调」的三套正则（`P/quote-hedge.ts`、`P/consistency-sop.ts:7`、`P/quote-template.ts`）是护栏词表，不是政策，本期不动。

**R4 本期能改什么、怎么改。**

- `PackPolicy.editable` 列出本期租户可改的字段：`refund.*` 与 `change`。`pricing.*`、`booking.*` 必须等于包默认值，否则 `policy_invalid`：可改的这两项都不进系统提示，改了不动 `promptHash`，也不用把租户 policy 贯穿进价格护栏和租户镜像（定价可改见开放问题 6）。
- 签证、保险、费用含不含的对客口径句不进 policy：它们就是 `P/claim-words.ts` 里的常量（`POLICY_REPLY`、`VISA_REPLY`，本期在同一处补保险与费用两句），条款出处（R14）与护栏（R22）都引用这几个常量，只有一个来源。
- 写入只有一条路：`saveSopDraft` 多收一个可选的 `policy`（整份替换，按 schema 校验）。入口两个：后台接口 `PUT /sop/draft` 的 body 加 `policy`；新命令 `src/cli/sop-policy.ts set --tenant <slug> --policy-file <json>`（以 app 身份，写草稿、不发布、写审计 `sop.policy_draft`）。发布照旧在后台，经 R7 的闸。
- 后台 SOP 页加一张只读卡片「退改条款」：档位、审批阈值、自助退款开没开，以及草稿里的差异；没有编辑表单。新文字要进字体子集，跑 `check-fonts`。

**R5 policy lint。**

契约检查加两个违规码，发布、回滚、启动重渲染都查：

- `policy_invalid`：schema 不过；档位重叠或有缺口（按 `minDays` 降序、从某个下限起连续覆盖到无穷）；`percent` 不在 0–100；阈值为负；只读字段改了。
- `policy_mismatch`：可编辑节里的话和 policy 的数对不上。本期三条：「上浮 N%」与 `pricing`、「N 折」与 `groupDiscount`、退改语境里的「N 天 / 退 N%」与档位。点名节与那句话。

### SOP 版本全流程与发布闸

**R6 已有的和新增的。**

| 环节               | 现状                           | 本期                                                                                           |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 渲染一次并存哈希   | 已有（01 R4）                  | `render_inputs` 加 `policyHash`                                                                |
| lint               | 契约检查（01 R2、06 R21）      | 加 `policy_invalid`、`policy_mismatch`（R5）                                                   |
| 发布闸             | 只有静态检查                   | 加真实模型回归（R7–R9）                                                                        |
| 发布               | 同步事务                       | 照旧同步；多一条前置条件：有一次通过的闸运行，或所有者强发（R7）                               |
| 回滚               | 已有，`sameHashAsTarget`       | 连同 policy 一起回到目标版本；不经闸（R10）                                                    |
| 导入哈希等于文件版 | 只有进程内自测，只覆盖旧版模式 | 自测扩到模板模式与 policy；`import-config --dry-run` 打印 `promptHash`、`policyHash`（验收 3） |

**R7 闸是一次异步运行，发布只认它的结果。**

- 发布事务持配置写锁，十几分钟的评测不能放进去。闸单独一步：`POST /sop/draft/gate { rev }` 先跑静态检查，过了才建一行 `sop_gate_runs`（`queued`），返回 202 和 `runId`；console 每 3 秒查 `GET /sop/gate-runs/:id`。
- 一个租户同时只有一次排队或运行中的闸（部分唯一索引）；每个进程同时只跑一个闸（单槽）。进度只在内存里（父进程读子进程逐目标追加的报告文件）。单槽登记为 05 R5 清单里的实例状态，进度登记为租户状态 `gate.progress`（租户摘下时杀掉它的子进程）。
- 重启：宿主进程装载每个 standard 租户时，在它自己的 `withTenant` 事务里把这个租户 `queued` / `running` 的行改成 `abandoned`。进程持有这个租户的锁（05 R2），别的进程不会同时在跑它的闸；作用域与 FORCE RLS 照常生效，不需要跨租户的扫描。用户重新点。
- 不用 `jobs` 表：闸是长任务，重试没有意义，租约与 `maxAttempts` 用不上。
- 发布条件（`SOP_GATE=required`）：`publishSopDraft` 现算出的（`promptHash`, `policyHash`）要有一行同值、`verdict='pass'`、属于这份草稿的闸运行。发布时自动 rebase 改变了合并结果，哈希就对不上，要重跑闸。
- 强发：闸不过或跑不了时，**只有所有者**可以带 `override: { reason }` 发布，原因写进审计 `sop.publish` 的 diff 与变更说明（开放问题 9）。
- 闸面板的状态：还没跑过（「发布前要先跑一次回归」）、排队、运行中（第几个目标 / 共几个、已花多少）、通过、不过（点名拦发布的目标与两边结果）、出错（超预算、超时、子进程退出、当天次数用完）、已放弃（「服务重启过，请重新跑」）。

**R8 回归集与判定。**

- `SimGoal` 加 `tags?: string[]`：`goalSchema` 是 `.strict()`（`eval/sim/goals.ts:67,82`），所以这个字段在批 P 就加，后面各批才能提交带标的目标。只有带 `regression` 的目标进闸、能拦发布。批 Q 给 06 的 16 个 `safety` 目标打标；批 A、K、G 各自上线时加本批的目标（自助退款低于与高于阈值、问退改规则带出处、无出处的保险问法），共 20 个以内。
- 每个目标先跑 1 遍；不过就重跑，最多再 2 遍。第 1 遍过是 `pass`；重跑里有一遍过是 `flaky`；三遍都不过是 `fail`；预算用完没跑到的是 `skipped_budget`。
- 基线是「当前已发布版本最近一次的结果」：找一行键相同的已完成运行，键是（已发布版本的 `promptHash`、`policyHash`、产品库快照哈希、目标集哈希、代码版本、销售与客户模型）。通过的草稿发布之后，它这一边的结果就是新线上版本的基线。找不到（发了版、改了产品库、回滚或重渲染之后）就在同一次运行里先跑一遍线上版：06 的「发布前试跑」由此合流，两边逐目标并排。
- 拦发布：某个 `regression` 目标草稿一边是 `fail`，而基线不是 `fail`。基线就失败的记「已知失败」、`flaky` 记「不稳」、`skipped_budget` 记「没跑完」，都列出来，不拦；没跑完的占一半以上时整次判 `error`。
- v2 用例不进闸：它们用脚本化的假模型，不读 SOP 的语义，`pnpm test` 照旧跑。

**R9 在哪跑、怎么注入草稿、费用与并发。**

- 镜像带上 `eval/sim/`（`Dockerfile` 加一行 `COPY eval/sim ./eval/sim`），它只依赖 Node 内置模块与 `zod`。
- 注入：父进程在 `VAR_DIR/gate/<runId>/draft/` 与 `…/published/` 各写一份导出目录（`sop.md`、`routes.json`、`hotels.json`、`policy.json`，模板模式加 `brand.json`），复用 `export-config` 的写法。`eval/sim/runtime.ts` 加 `--config-dir`：给了就用目录里的文件，没给照旧是 `data/`（先例：`eval/v2/brand.ts` 用临时 `SOP_PATH`）；`runner.ts:194` 对品牌目标的拒绝只在没给 `--config-dir` 时生效。
- 子进程：`node --import tsx eval/sim/gate.ts --config-dir … --tag regression --rerun 2 --budget <元> --report <文件>`。环境变量只放行模型相关的几项（`LLM_*`、`ZHIPU_*`、`EMBED_*`、`TZ`），不给 `DATABASE_URL` 一类：子进程连不到业务库，线上 `var/` 里只读这次运行的导出目录；`LLM_MAX_INFLIGHT=1`，串行跑。超时 `SOP_GATE_TIMEOUT_MS` 到了就杀进程，记 `error`。
- 耗时：06 实测每段 11–20 秒。20 个目标一边约 4–7 分钟，加上重跑与基线一边，发版之后的第一次约 10–20 分钟；超时默认 30 分钟，第 0 步实测后再定。
- 费用：子进程自带 Meter，到 `SOP_GATE_BUDGET_CNY` 就停；父进程按报告把用量记进 `usage_daily`，`purpose='gate'`，计入租户的软告警。每个租户每天最多 `SOP_GATE_DAILY_RUNS` 次，超了回 429。
- 夹具时钟照旧是 `FIXTURE_CLOCK`（`eval/sim/runtime.ts:10`），退款目标的「距出发天数」按它算。
- 自测用 `eval/sim/fake.ts` 的假模型跑整条闸（行上 `mock=true`）。`SOP_GATE=required` 而 `LLM_MOCK=1` 或没配模型 key 时，DB 模式拒绝启动（`gate_unavailable`）。

**R10 回滚、重渲染、导入、沙箱不经闸。**

- 回滚是逃生口：照旧只过静态检查，不跑闸，目标版本当年闸没过也能回；审计 diff 记 `gate: 'skipped_rollback'`。回到的版本若有同键的闸结果，就直接当基线。
- 启动重渲染与首次导入不经闸：代码改锁定节有自己的 k=5 评测与 owner 授权（06 R19、本 spec R25）。
- 沙箱租户不跑闸（访客是自己沙箱的所有者，跑闸就是让匿名访客花钱）：沙箱发布只过静态检查，审计记 `gate: 'skipped_sandbox'`。
- `sop_gate_runs` 里只有合成目标的对话，没有客户数据，不进 02 不变量 42 的清单；沙箱删除时随租户删掉（R13）。

### 知识库

**R11 线路向量进 Postgres 持久，相似度照旧在进程内算。**

- 这是对主参考「pgvector 检索」字面的偏离，理由两条：每轮读路径不许查库（02 不变量 9、01 验收 14），而一个租户只有几十块，内存里精确算余弦不到 1 毫秒。库这边的价值在持久与增量：重启不重新嵌入、改一条只嵌入一块、沙箱开通直接复制、不再有 `var/route-vectors.json`。在 SQL 里用 `<=>` 检索、加 HNSW，等单个租户到了上万块再做，那时要另起 spec 取代 02 不变量 9。
- 收什么：每条线路一块（正文是 `retrievalText(route)`）。policy 条款不进表：它们由已发布 policy 现算（`PackPolicy.clauses`），编号随 SOP 版本走，进表只会多一份要同步的副本。酒店不收（`search_hotels` 是结构化筛选）；上传文档放「后续」。
- 两张表，都带 `tenant_id`、FORCE RLS、`tenant_isolation` 策略，`agent_app` 有 SELECT / INSERT / UPDATE / DELETE（派生数据，可以重建）：`kb_chunks`（可移植，PGlite 上也建；身份是（`source`, `ref`），正文变了就换 `body_hash`）；`kb_vectors`（`embedding halfvec(2048)`，ADR-001 决策 6；外键指向块、`ON DELETE CASCADE`；只在 vector 扩展存在时建，R12）。不建 HNSW。
- 迁移按合并顺序从 0014 起编号，只加不删，过 `scripts/check-migrations.ts`（要标注的规则见「数据库」）。

**R12 扩展权限与测试策略。**

- 建 `kb_vectors` 的那段是 DO 块：扩展已装 → 建表；扩展可用但没装 → 第 0 步证明 `agent_owner` 能建，就 `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public` 后建表，否则 `RAISE EXCEPTION` 写明「先由超级用户在应用库里建 vector 扩展」，migrate 服务失败、部署停在切换之前；扩展根本不可用（PGlite）→ 跳过。
- 不能由 `agent_owner` 建时：`deploy/db-init/` 加一个连应用库执行的 `extensions.sql`（`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`），新库初始化时跑；现有线上库由 owner 在发版前用超级用户执行一次，写进发版说明。
- 测试：PGlite 上没有 `kb_vectors`，`db.selftest.ts` 的表清单两边分开写；真实 PG 部分（`PG_TEST_URL`）测向量的写入、装载、RLS 与级联，用合成向量，不调嵌入接口。`LLM_MOCK=1` 下嵌入本来就返回 null（`readEmbedding`），检索退回关键词，现有自测与 mock 回归的行为不变。

**R13 装载、增量嵌入与沙箱复制。**

- 检索接口与算法不变（`semanticRecall(query, topK)`、进程内余弦）；DB 模式下内存索引的来源从缓存文件换成库：租户装载时读这个租户的块与向量进内存；产品库变化（`onCatalogChanged`）后，在后台按（`source`, `ref`, `body_hash`）补缺的块、删多的块，只给缺向量的块发嵌入请求，写库提交后替换内存索引。这些都不在处理一轮对话的路径上，失败沿用现有的退避重试，向量没就绪时照旧退回关键词。查询向量照旧每次现算。
- DB 模式不再读写 `var/route-vectors.json`；文件模式照旧用它。PGlite 上没有 `kb_vectors`，DB 模式退回进程内建索引、不持久，和今天文件丢失时一样。
- 沙箱开通时把宿主的块与向量一并复制（同一个只读快照，05 R9），开通不发嵌入请求；`claimSandboxInitialIndex`（`src/tenancy/sandbox/budget.ts:210`）只在宿主还没有向量时才用得上。
- `sandbox_tenant_purge` 用 `CREATE OR REPLACE` 把 `kb_chunks`、`kb_vectors`、`sop_gate_runs` 都显式加进删除清单；`kb_vectors` 那一条用 `to_regclass('public.kb_vectors')` 判断后动态执行，PGlite 上跳过。05 不变量 9「删除清单覆盖每张带 `tenant_id` 的表」照旧成立。

**R14 政策问法进上下文，回答带出处。**

- 不加模型工具（工具定义一改就动前缀），不调嵌入。旅游包认问法：客户这句在问退款、退订、改期、保险、费用含不含（签证已在 06 的 `SENSITIVE_ASK`，`P/turn.ts:593`），只认问法，提到这些词的陈述句不算。命中就按主题确定性地取条款：退改主题给全部档位条款加改期条款（上限 ≥ 档位数 + 1），会话里有订单时再按这张单的距出发天数标出适用的那一条；其余主题给那一句口径。加进 contextNote（示例节选，实际列出全部档位）：

```
可引用的条款（照原文说，说到哪条就在句末写出处）：
（退改条款第1条）出发前30天及以上取消，退全款
（退改条款第2条）出发前15–29天取消，退订单金额的80%
您这张单离出发55天，适用退改条款第1条
```

- 只给条款与天数，不给金额：金额只出现在 R18 的代码回复里。
- 出处的写法是句末全角括号「（退改条款第2条）」，线路事实写「（《线路名》费用说明）」，不用 markdown。模型漏写出处的由 R22 补上。
- 没有订单、不是政策问法的会话，contextNote 与开工时逐字节相同（对 06 不变量 3 的部分取代就是加这一个条件）。

**R15 嵌入端点白名单。**

`src/core/llm/endpoints.ts` 写一份境内已备案服务商的 API 主机清单（本期只有智谱）。两处都查：DB 模式启动时 `embedCfg().baseUrl` 的主机不在清单里就拒绝启动；任何模式下 `readEmbedding` 发请求之前再查一遍，不在清单里就不发、记错误、退回关键词（文件模式的评测与闸的子进程也受管）。`DEPLOY_PROFILE` 不是 prod 时另放行 `127.0.0.1` 与 `localhost`（自测的假服务）。加一家服务商要改代码、过评审，不开环境变量口子。

### 售后退改

**R16 退改条款（合成演示数据）。**

`defaultTravelPolicy.refund`，数是合成的，可以进仓库（开放问题 3、4）：

| 条款          | 距出发天数 | 退                     |
| ------------- | ---------- | ---------------------- |
| 退改条款第1条 | ≥30 天     | 100%                   |
| 退改条款第2条 | 15–29 天   | 80%                    |
| 退改条款第3条 | 7–14 天    | 50%                    |
| 退改条款第4条 | 0–6 天     | 不能自助退，由顾问处理 |

- 审批阈值 `approvalThresholdYuan` 默认 30,000（比的是退款额）；`selfService` 默认 true。
- 距出发天数 = 出发日 − 今天，按服务器时区（`todayIso()`，生产 `TZ=Asia/Shanghai`）的日期算。退款额 = `floor(totalPrice × percent / 100)`，到元。
- 改期条款 `change` 默认「出发前15天及以上可以改期一次，由顾问为您办理」：本期只用于回答。

**R17 订单核验按渠道定。**

- 主参考写的是「订单号 + 手机尾号」，但哪里都没有手机号：企微不给，SOP 也写明拿不到。为了核验去收手机号，就是给 demo 新增一类个人信息，而且比现成的办法弱。
- 本期的核验就是「订单在这个会话名下」：`session_id` 写入后不可改（`orders_guard`），企微会话由 `external_userid` 绑定，网页与模拟器会话由各自的会话 cookie 绑定。退款流程只看这个会话名下的订单。
- 名下有两张以上可退的已付订单时，回复列出每张的线路、出发日和订单尾号（订单号末 6 位），请客户回尾号；尾号对上了才报价。这一步同时就是「订单号核验」。
- 客户说「我在另一个微信下的单」：AI 不查，转人工。手机号核验见开放问题 5。

**R18 已付款订单的「我要退款」。**

- 位置：`EnginePackHooks` 新增可选的 `afterSales`，`preflight` 在紧急情况、撤回同意、已转人工静默、重置关闭这几步之后，确定性转人工安全网（`src/core/engine/index.ts:555`）之前调它（对 04「主流程」顺序的部分取代）。核心先判这一句是不是投诉（`isComplaint`）、负面情绪到没到阈值，任一成立就不调钩子、照旧走现有的安全网与情绪判断（包不 import `src/handoff/`，04 R2）。返回 `null` 就照旧往下走。`isHandoffIntent` 本身不改（锁定的 `dejargon.selftest.ts:394` 断言「我要退款」仍要命中它）。
- 触发，全部满足：policy `refund.selfService` 为 true；客户这句是退款意图（`REFUND_REQUEST` 的退款、退订、退钱、取消订单、不去了一类），或在问这张单能不能退、能退多少（报价没有副作用）；**没有**明确要人工（转人工、人工、真人、顾问）；不是投诉、负面情绪没到阈值（由核心先判，见上）；会话名下有 `status='paid'` 的订单。没有已付订单时的退改规则问法归 R14。
- 流程，每一步都不发模型请求，回复是包里登记的固定文字。进行到哪一步记在 `Session.afterSale`（旅游字段，进 `resetSession`，30 分钟过期）：
  1. 选单：可退的只有一张就用它；两张以上按 R17 列出尾号，记 `{ step: 'choose', orderIds }`，下一句是其中一个尾号才继续。
  2. 报价：`quoteRefund` 按已发布 policy 算。办不了的（已出发、在第4条、这张单被驳回过）不报价，钩子自己返回 `handoff`（kind `refund`，话术同今天的退改转接）：「能退多少」「不去了」这类话不命中 `HANDOFF_REQUEST`（`P/turn.ts:416`），不能指望后面的安全网接住。办得了的回：「《云南 丽江大理·洱海古城 6 日》2 位、12 月 10 日出发（订单尾号 a1b2c3）：离出发 55 天，按退改条款第1条可退全款 ¥33,600。确认退款请回复「确认退款」。」记 `{ step: 'confirm', quote }`。
  3. 确认：下一句正好是「确认退款」（允许句末标点），报价没过期、`policyHash` 没变 → 钩子返回 `submit`，由核心提交（R19）。别的话清掉 `afterSale`，照常走后面的流程。
- 待付款订单的「我要退款」、带「转人工」的退款话、没有订单的，行为与开工时相同：锁定 :1935、:1940、:2141–2170 照绿。
- `selfService` 关掉，就完全是今天的行为，00 不变量 15 与 02 验收 12 的原文照旧成立（开放问题 2 的备选 B）。

**R19 退款申请、幂等、审批与结算。**

- 分工：报价是纯函数 `quoteRefund`（`src/core/refund.ts`，经 `pack-api` 给包用，包不 import `src/payment/`，04 R2）；改订单的 `requestRefund`、`approveRefund`、`rejectRefund`、`settleRefund` 在 `src/payment/refunds.ts`，由核心（`submit` 那一步）与后台路由调。
- `requestRefund`：先查写库健康，积压时不改任何东西、回「系统有点忙，请稍后再回一次「确认退款」」；否则订单从 `paid` 改成 `refund_pending`，写 `Order.refund`。幂等：订单已经是 `refund_pending` 或 `refunded` 时返回已有的那条、`created: false`，不写第二条审计、不发第二次通知，回「退款申请已经提交过了」。
- 审批：退款额 ≤ 阈值记 `approval='auto'`，超过记 `pending`，批准后改 `approved`。结算：模拟支付（`paymentMode()==='online'`）下批准即结算，`settlement='mock'`；顾问收款模式下要顾问把钱退回之后点「确认已退款」，`settlement='advisor'`。`settleRefund` 只接受 `approval ∈ {auto, approved}`，否则 409 `order_state`。
- 不要人的只有一种：`auto` 加模拟支付，当场结算成 `refunded`。核心等这次改动提交（≤5 秒，同 02 不变量 20 的付款确认）之后才回「已为您办好退款 ¥X（退改条款第N条）。这是演示环境的模拟退款，不产生真实打款。」；5 秒内没确认提交，就回「退款申请已收到，正在处理，顾问核实后会联系您」并转人工。
- 其余都要人，`enterHandoff(kind='refund')` 的原因分两种：等审批的写「退款待审批：¥X（退改条款第N条）」，回「退款申请已提交：¥X。金额超过 ¥{阈值} 要顾问审核，顾问会在微信上联系您。」；已自动批准、只等顾问打款的写「退款待打款：¥X（已自动批准，按原付款方式退回）」，回「退款申请已提交：¥X，顾问会按原付款方式退回，并在微信上联系您。」。阈值与金额都从已发布 policy 与这次报价渲染，不写死。之后就是 02 的现成链路：终态阶段不变、进「已成交客户要人工」、外部通道一条。
- 后台（写法照 `markPaidByAdvisor`：先查写库健康，改内存，随落库写审计，提交之后才对客户发通知）：
  - `POST /orders/:id/refund/approve`、`…/reject { reason }`：supervisor 以上（`supervisesConversations`）。驳回把订单改回 `paid`、记原因，对客说「退款申请没有通过，顾问会在微信上跟您说明」；同一张单以后再说退款直接转人工。
  - `POST /orders/:id/refund/settle`：只在顾问收款模式，接手人或 supervisor 以上（同确认收款），`refund_pending` → `refunded`。
  - 重复点击幂等：已是目标状态就原样返回，不再通知。
  - 审计动作 `order.refund_request`（`actor_kind='system'`）、`order.refund_approve`、`order.refund_reject`、`order.refund_settle`，登记进 `src/shared/ui-labels.ts:80` 的 `AUDIT_ACTIONS` 与审计句子；推送失败时在会话里留一条系统备注，同付款确认的 `PAY_NOTICE_FAILED`。
- 工作台订单卡（`WorkbenchPage.tsx:647`）：`refund_pending` 显示退款额、条款、申请时间和可用的按钮（按角色与支付模式），`refunded` 显示结算时间与方式。

**R20 订单状态、会话状态与消费方。**

- 迁移：`orders_status_check` 放宽为六个值；新增 `orders_refund_paid_check`（`refund_pending`、`refunded` 必须有 `paid_at`）；`orders_guard` 用 `CREATE OR REPLACE` 加一条：`refunded` 之后 `status` 不能再变（作废走 `voided_at`）。
- 会话状态：阶段照旧停在终态 `paid`，`conversationState` 照旧是「已成交」，成交统计按 `paid_at` 不变（02 R9 的取舍）。「现在有一趟已付的行程」这层意思改看订单：`paid` 与 `refund_pending` 算有，`refunded` 不算。
- 06 不变量 10（付款后寒暄短路「只在有已付款订单或阶段为 paid 时触发」）是必要条件，本期只把触发再收窄（有 `refunded` 而没有别的已付单时不短路、照常走模型），不违反它，不取代。
- 要跟着改的地方：
  - 类型：`src/shared/conversation-types.ts:42`、`src/shared/console-api.ts:144`、`console/src/conversations/workbench.ts:226`（`ORDER_STATUS_LABEL` 是 `Record<OrderStatus,…>`，类型检查会逼着补）；
  - 成交凭证：`src/store.ts:831-834` 的 `hasPaidOrder`（访客淘汰与闲置清理时保护已付会话）三种都算；`supersedeOrder`、`markOrderPaid` 只认待付款，不用改；
  - 对客：`P/turn.ts:600-620` 的订单行加「退款中」「已退款」；`P/turn.ts:622` 客户说「付过了」时，退款中、已退款都算付过，不出「系统还没收到到账」那行；`P/claim-words.ts:75-80` 的付款类判断；`P/turn.ts:1433` 的付款后寒暄；`P/reply-helpers.ts:1317`（`saysTransfer` 的已付判断，三种都算）、:1345-1350（`liveOrderOf`：`refunded` 不再算在途单）、:1387（转人工措辞）、:1472-1476（`promisesContact` 的在途单）；
  - 支付：`src/server.ts:743-746` 退款中、已退款的单不能再付（409）；:805-845 的支付页标题与摘要写「退款中 / 已退款」；`public/pay.html:369,463` 按新的 `refund` 字段显示退款状态（新分支加在 `paid` 那一行之前，`superseded` 分支一字不动，见「锁定断言」）；
  - 公开订单投影（`src/server.ts:268-292`，02 R22 白名单）：`status` 照旧只出四个旧值（`refund_pending`、`refunded` 出 `paid`），另加 `refund: 'pending' | 'refunded' | null`。这样 `public/chat.html` 的 `fillPayCard`（锁定的 `server.selftest.ts:279-311` 抽它出来跑）不用改：翻历史时卡片照旧显示「已支付 · 查看订单」，点开支付页看到退款状态。
  - 后台与统计：`src/handoff/takeover.ts:239`、`app.ts:774-795`（成交额照旧按 `paid_at` 所在月，含退款中；已退款单列）、`src/core/insight.ts:17`、`public/admin.html:588,808`；评测：`eval/sim/goals.ts` 的 `initial.orders.status`、`eval/sim/runtime.ts:240-254` 按初始状态建单与推断阶段的分支、`eval/v2/schema.ts:15` 的状态枚举。`public/admin.html:588` 的标签加两种状态时，保留 `'已被替代'` 与 `liveOrder(s)`。
- 重置：demo 下重置照旧作废会话名下全部订单（锁定 :818-819），两个新状态同样作废；prod 下重置关闭、订单不动（:863、:897）。
- 回滚检查（`deploy/rollback-guard.sh`）：现有退出码 3–7 都占了（6 是品牌、7 是沙箱），本期用新的 **8**：目标镜像早于 07 而库里有 `refund_pending` 或 `refunded` 的订单，就以 8 退出，打印「先在后台把退款中的订单办完或驳回；旧镜像会把退款中、已退款的单当成待付款显示在支付页上，成交统计也会漏算，确认能接受再回滚」；`deploy.sh` 照现有约定把它转成 1。第 0 步实测（见 plan 实施记录）：旧镜像读到这两种状态都能照常启动、写库，不会把会话标 poisoned，但支付页走待付款分支、`/orders/summary` 漏算、按状态筛选回 400、工作台状态标签缺失，所以两种都拦。

**R21 沙箱种子。**

- `data/sandbox-seeds.json` 的订单支持 `departOffsetDays`：开通时按开通日算出 `departDate`，`seeds.ts` 处理，`seed-fixture.selftest.ts` 守。开通时给种子会话打上 `seed: true`（存在会话的 state json 里，R23 用）。
- 新增一段种子会话 G01：已付款，出发日在开通后 40 天，客户已说「我要退款」、看过报价、回了「确认退款」，订单 `refund_pending`、超过阈值、在「已成交客户要人工」里。访客一进工作台就能点「批准退款」看完整链路。
- A01 的出发日照旧是过去的日子，用来演示「已出发不能自助退」。访客也能在模拟器或绑定的微信里从头走一遍。

### 推迟的缺陷

**R22 政策陈述护栏。**

- 新增旅游包步骤 `policy_claims`，排在 `claim_words` 之后、`price` 之前（`price` 的 `after` 改指它）。只换小句或补出处，不建单、不转人工、不调工具；含 `/pay/`、`/proposal/` 链接的句子不动（同 06 R13）。范围是主回复流水线；跟进走 04 R9 的单独步骤表、不谈退改条款，不在范围内。
- 规则，按已发布 policy 与本轮的条款查：
  1. 退改语境（退、退款、取消、改期）里的天数和比例，和档位对不上 → 换成那一档条款的原句加出处；对得上但没写出处 → 句末补出处（动作 `patch`）。
  2. 「上浮 N%」「N 折」「N 人及以上」与 `pricing` 不符，「超过 N 个月」与 `booking` 不符 → 换成生成段的原句。
  3. 无出处的**肯定**断言：客户这句是政策问法（R14），回复里有这一主题的肯定说法（可以退、含保险、包机票、不用另付这类），而本轮 contextNote 的条款、本轮工具结果、以及会话里出现过的线路（`lastShownRoutes`、订单、回复里点名的《线路》）在产品库里的「含」都没有这个说法 → 换成 `P/claim-words.ts` 里这一主题的口径句，并记一条「待顾问确认：客户问了 xx」的系统备注。不转人工，同 06 开放问题 3 的口径 a、e（开放问题 8）。「不含、不包括、要另付」这类否定说法一律不按这条换：说不含不是承诺；锁定的 V8 r8d（`engine.selftest.ts:2939-2942`）要求「不含国际机票」原样留着，它也确实在瑞士线的「不含」里。
- 不改 `dropUnbackedClaims` 与 `claim_words`（锁定的 price-guard 自测逐字断言前者的输出）。动作用现有六种（04 R8）。
- 怎么验：v2 用例每条规则至少一条正例、一条否定句反例；脚本模型写「出发前 7 天也能全额退」被换成第3条原句；写对了的只补出处；带支付链接的句子不动；锁定套件全绿。

**R23 看板拆分与来源。**

- 三个数，窗口与现在的运行数字相同：
  - **AI 独立成交**：`paid_at` 在窗口内、`handoffBeforePaid=false` 的订单数与金额。顾问收款模式下的确认价格、确认收款是收款流程，不算协同。
  - **人机协同成交**：`handoffBeforePaid=true` 的。两类里已退款的单列「其中已退款」。
  - **转人工率（按原因）**：`Session` 加 `handoffLog: { kind, at, turnId? }[]`，`enterHandoff` 每次进入或升级时追加（最多 50 条，同 `handoffCount` 永不清）；它随会话的 state json 进库，按原因算「窗口内有这类记录的会话 / 有轮次的会话」。kind `agent` 的就是「顾问主动接手」，单列次数。
- 来源三类，只在一处判（`src/shared/origin.ts`）：**种子**——会话 `wecom:cust_` 开头、订单 `ord_seed_` 开头，或会话带 `seed: true`；**访客**——宿主里的 `sim-` 会话，以及沙箱租户里的非种子会话；**真实客户**——standard 租户里的其余会话。看板有「真实客户 / 访客 / 种子 / 全部」四个视图，默认真实客户。
- 两个来源的数据形状不同，照实说：成交数从内存里的全部订单算（含 demo 类），三类都有；转人工率从库里的会话算，宿主的种子与 `sim-` 访客永不进库，所以宿主的「访客」「种子」转人工率结构上是空的，界面写「只统计进库的会话」。沙箱里三类都进库。
- `/orders/summary` 与新的成交数都按来源分；`/metrics` 的 `MetricsView` 加 `deals`、`handoffByKind`、`takeovers`。不再有「1 − 接管率」：`public/admin.html:813,824` 的「AI 独立完成」「AI 自动化率」改成同口径的 AI 独立成交，`insight.ts` 改用 `handoffBeforePaid`。
- console 总览加两格（成交拆分、按原因的转人工率），沿用 KPI 格；加载、空（窗口内没有成交）、错误（文件存储下 503）照现有运行数字处理。

**R24 trace 列表与「存为回归用例」。**

- `GET /traces`（所有者、管理员）：跨会话按时间倒序，筛选 `outcome`、触发过的护栏（`guard_verdicts` 里非 `pass` 的）、转人工原因（按 `handoffLog` 的 `turnId` 对上）、`over_limit`、时间段，游标翻页。后台新页「AI 记录」，点一行打开现有的详情面板。页面状态：加载中（骨架行）；空（「这段时间没有 AI 记录」，带清空筛选）；文件存储下 503（「AI 记录只在会话入库后才有」）；没有权限的角色导航里不出现这一页。
- 详情接口补 `guardVerdicts`、`replyShape`、转人工原因，以及这一轮的客户原话（从 `messages` 取 AI 那条之前的客户消息；只给所有者、管理员，同现有 trace 权限）。
- 「存为回归用例」：`GET /conversations/:id/turns/:turnId/goal-draft` 下载一份 `SimGoal` 草稿（附件，不落盘、不进仓库）：`initial` 取这一轮之前的阶段、订单和最近 10 条消息，`customerScript` 是这一轮的客户原话，`tags: ['regression']`；号码类按 `src/console-api/mask.ts` 打码；另带 `_draft` 字段放 trace 摘要。目标 schema 是严格的、`predicates` 至少一条，所以草稿原样放进 `eval/sim/goals/` 就过不了 `pnpm test`：开发者必须把客户原话改写成合成的话、写好谓词、删掉 `_draft`。每次下载写审计 `trace.export`（目标是会话 ref）。
- 种子与宿主的 `sim-` 访客不进库、没有 trace；沙箱里访客自己的对话有，在沙箱自己的后台里看。

### SOP 改版

**R25 一次锁定节与工具描述改版，随发版。**

R18 和 R14 上线以后，SOP 与工具描述里有几处和行为对不上，要改一次。owner 拍板文字之后（开放问题 15），按 06 R19 的流程一个 PR 做完：

| 改什么                                                                                                                                                      | 在哪                                                              | 锁定?  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------ |
| 第 3 条改成「已付订单要改期、只退其中几位或部分项目这类售后操作。整单退款系统会按退改条款直接办；轮到你回复时客户还在要退款，说明系统没接住，照样转人工。」 | SOP handoff 节（`sop:173`）                                       | 锁定   |
| 加一句「退改只照上下文给的退改条款说，句末带『（退改条款第N条）』；保险、费用含不含只照线路的含与不含说；上下文里没有的说『由顾问跟您确认』。」             | SOP capabilities 节                                               | 锁定   |
| 「…投诉、退款或连续两轮无法理解时调用」改成「…投诉、要改期，或要退款而系统没有直接办理，或连续两轮无法理解时调用」，保留「坚持」（锁定 :1980 断言）         | `handoff_to_human` 的描述（`P/tool-defs.ts:123`），改 `toolsHash` | 代码   |
| 「退改：已付订单的退款、改期是售后，转人工；只是问规则，说「由顾问跟您确认」」改成「问规则就照上下文的条款说；要退款系统会接；改期转人工」                  | SOP objections 节（`sop:128`）                                    | 可编辑 |

- `templates.ts` 随 R3 自动生成。`SOP_CONTRACT` 的 17 条短语一条不少、不新增。
- PR 带新的 `PREFIX sha256`、按 06 R4 生成的具名快照，以及写死的哈希：`src/web/web.selftest.ts` 的 `SYSTEM_SHA`（:88）与 `TOOLS_SHA`（:89）、`src/config/brand.selftest.ts:48-49`、`src/config/brand-publish.selftest.ts:102`、`P/tools/tools.selftest.ts:75`。回归集 k=5 前后各一次（前 = 当前 `dev`，后 = 这个 PR，范围见开放问题 11），逐目标记进 plan；owner 看过对比后授权，合并、发版。启动重渲染写 `sop.rerender`（`causes` 含 `locked_sections`、`tools`）。
- 可编辑节的新文字不随重渲染上线（01 规定运营编辑过的可编辑节原样保留）：发版后由 owner 在后台改 objections，**经 R7 的闸**发布。这同时就是闸的第一次真实使用。
- 不改的后果：条款进了上下文，SOP 与工具描述却还让模型「说由顾问跟您确认 / 退款就转人工」，两头拉扯；退款本身不受影响（R18 在模型之前）。

## 锁定断言

本 spec 不需要 owner 授权改任何锁定断言，也不改 `public/chat.html`（R20 的投影让它不用改）。下面这些约束实现，开工与每批结束时用 `pnpm -s test:locked` 核：

- `src/engine.selftest.ts`：
  - :1935，待付款订单「我要退款」→ 含「退改由资深顾问」、不道歉、不提付款。R18 只认 `paid`。
  - :1940，已付款订单「转人工」→「您预订的《…》」、不提付款。R18 排除明确要人工的话。
  - :2141–2170，待付款「转人工 + 取消 / 改日期 / 改人数」与没订单的转人工。R18 不碰。
  - :818–819，demo 下重置作废已付订单；:863、:897，prod 下重置不动已付订单；:3102，已付订单不被替代。R20 对两个新状态同样处理。
  - :1980，`handoff_to_human` 的描述含「坚持」。R25 保留。
  - :2939–2942（V8 r8d），「不含国际机票」原样发出。R22 不换否定说法。
  - :4561，`claimsTransfer` 认「退款或者改期需要顾问来办…」。不动。
- `src/dejargon.selftest.ts:394`：「我要退款」必须命中 `isHandoffIntent`。R18 不改这个判断，钩子排在它前面。
- `src/server.selftest.ts:514`：`pay.html` 里要能匹配 `order.status === 'superseded'[\s\S]{0,200}show('err')`；:516：`admin.html` 要含 `'已被替代'` 与 `liveOrder(s)`。R20 改这两页时只加分支，不动这两处。
- `src/price-guard.selftest.ts`（逐字断言 `dropUnbackedClaims`）、`src/adapters/wecom.selftest.ts`（欢迎语字节）、`src/server.selftest.ts:279-311`（`fillPayCard` 四种状态的按钮文字）：R22 另起一步，R3 只改引用来源，R20 不改 chat.html。
- 非锁定、要随 R18 改的：`src/handoff/handoff.selftest.ts:547-590`（02 验收 12 的整条链）改为在 `selfService=false` 下跑原链，另加一条自助退款的链；`src/handoff/handoff.selftest.ts:699-711` 的公开订单键集合 `WHITELIST` 加 `refund`；`src/notify/notify.selftest.ts:481`（NP01 只有终态阶段、没有订单）照旧转人工；`eval/sim/goals/quality/27-paid-refund.json` 改写成自助退款的期望。

## 接口与数据流

### policy 与售后钩子

```ts
// src/core/pack-api.ts（新增；PackRuntime 加 policy?，EnginePackHooks 加 afterSales?，对 04 的 amend）
export type PolicyTopic = 'refund' | 'change' | 'visa' | 'insurance' | 'fees';
// title 是对客出处，如「退改条款第2条」
export type PolicyClause = { id: string; topic: PolicyTopic; title: string; text: string };
// 距出发天数闭区间 [minDays, maxDays]，maxDays 为 null 表示不封顶；percent 是 0–100 的整数
export type RefundTier = { id: string; minDays: number; maxDays: number | null; percent: number };
export type RefundTerms = { selfService: boolean; approvalThresholdYuan: number; tiers: readonly RefundTier[] };
export interface PackPolicy<P = unknown> {
  schema: z.ZodType<P>; // 严格，带 version
  defaults: P;
  editable: readonly string[]; // 本期租户可改的字段路径（R4）
  canonical(p: P): string; // 键序固定的 JSON；policyHash = sha256(canonical(p))
  upgrade(old: unknown): P; // 旧版本补默认值
  clauses(p: P): PolicyClause[]; // 签证、保险、费用三句取 claim-words 的常量
  refund(p: P): RefundTerms | null;
  segments: Readonly<Record<string, (p: P) => string>>; // 生成段（R2），键如 'sop:price-rules'、'note:peak'
}
// src/core/refund.ts，经 pack-api 导出；纯函数
export type RefundQuote = { orderId: string; daysBefore: number; tier: RefundTier; amount: number; policyHash: string };
export function quoteRefund(
  order: Order,
  terms: RefundTerms,
  policyHash: string,
  today: string,
): RefundQuote | { ineligible: 'not_paid' | 'departed' | 'no_tier' | 'rejected_before' };

export type AfterSalesInput = {
  session: Session;
  text: string;
  policy: unknown;
  policyHash: string;
  brand: BrandProfile | null;
  today: string;
};
export type AfterSalesStep =
  | { kind: 'reply'; text: string } // 选单、报价
  | { kind: 'submit'; quote: RefundQuote; texts: RefundTexts } // 确认退款：由核心调 requestRefund、等提交、选文字
  | { kind: 'handoff'; text: string; record: Pick<HandoffRecord, 'kind' | 'reason' | 'quote'> };
export type RefundTexts = { done: string; submitted: string; duplicate: string; busy: string; delayed: string };
// EnginePackHooks: afterSales?(input: AfterSalesInput): AfterSalesStep | null;
// 核心在投诉或负面情绪到阈值时不调它；ineligible 的已付单由钩子自己返回 handoff

// src/packs/travel/policy.ts
export interface TravelPolicy {
  version: 1;
  pricing: { peakMultiplier: number; groupMinimum: number; groupDiscount: number }; // 本期只读
  booking: { maxDepartMonths: number }; // 本期只读
  refund: RefundTerms;
  change: string; // 改期条款的对客句
}
// Session 新增（旅游字段，进 resetSession）：
//   afterSale?: { step: 'choose'; orderIds: string[]; at: number } | { step: 'confirm'; quote: RefundQuote; at: number }
// Session 新增（核心字段，重置不清）：handoffLog?: { kind: HandoffKind; at: number; turnId?: string }[]
```

```ts
// src/config/sop.ts（对 01 的 amend）
saveSopDraft(ctx, input: { basedOn: string; rev: number | null; edits: readonly { key: string; body: string }[]; policy?: unknown }): Promise<SopVersion>;
publishSopDraft(ctx, input: { rev: number; changeNote: string; gateRunId?: string; override?: { reason: string } }): Promise<SopVersion>;
// SopVersion 加 policyHash: string | null；RenderInputs 加 policyHash?: string；ViolationCode 加 'policy_invalid' | 'policy_mismatch'
// 新错误：409 gate_required（没有对得上的通过记录）、409 gate_failed（带 runId）、429 gate_quota、403 override_forbidden
```

### 发布闸

```ts
// src/config/gate.ts
export function startGate(ctx: TenantCtx, input: { rev: number }): Promise<{ runId: string }>; // 先跑静态检查；沙箱租户抛 GateSkippedError
export function getGateRun(ctx: TenantCtx, id: string): Promise<GateRunView>;
export interface GateGoalResult {
  id: string;
  tags: string[];
  attempts: { pass: boolean; failures: string[]; turns: number; costMilli: number }[];
  result: 'pass' | 'flaky' | 'fail' | 'skipped_budget';
}
export interface GateRunView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'abandoned';
  verdict: 'pass' | 'fail' | null;
  mock: boolean;
  progress: { done: number; total: number } | null; // 只在运行中、只在内存
  draft: GateGoalResult[];
  baseline: GateGoalResult[] | null; // 复用的或本次跑的线上版结果
  baselineReused: boolean;
  blocking: string[]; // 拦发布的目标 id
  costMilli: number;
  error: string | null;
  finishedAt: string | null;
}
```

```
POST /sop/draft/gate { rev }        canEdit → 202 { runId }；422 静态违规；409 已有一次在跑；429 当天次数用完
GET  /sop/gate-runs/:id             canEdit
POST /sop/draft/publish             body 加 gateRunId?、override?（只有 owner）
```

`eval/sim/goals.ts` 的 `goalSchema` 加 `tags: z.array(z.string().min(1)).optional()`；`initial.orders[].status` 加 `refund_pending`、`refunded`。`eval/sim/run.ts` 加 `--config-dir`、`--tag`、`--rerun`；新入口 `eval/sim/gate.ts` 只输出机器读的报告。

### 订单与退款

```ts
// src/shared/conversation-types.ts（对 02 的 amend）
export type OrderStatus = 'pending_payment' | 'paid' | 'cancelled' | 'superseded' | 'refund_pending' | 'refunded';
export interface RefundRecord {
  id: string; // 'rf_' + 12 位十六进制
  requestedAt: number;
  daysBefore: number;
  tierId: string;
  percent: number;
  amount: number; // 元，整数
  policyHash: string;
  approval: 'auto' | 'pending' | 'approved' | 'rejected';
  settlement: 'mock' | 'advisor'; // 申请时按支付模式定
  decision?: { at: number; by: { userId: string | null; name: string }; reason?: string }; // 人工批准或驳回
  settled?: { at: number; by: { userId: string | null; name: string } | null }; // 模拟结算时 by 为 null
}
// Order 新增：refund?: RefundRecord（存在 orders.data，不加列）

// src/payment/refunds.ts（核心与后台路由调；包不调）
export function requestRefund(
  quote: RefundQuote,
  terms: RefundTerms,
): { order: Order; created: boolean; needsHuman: boolean } | { busy: true };
export function approveRefund(orderId: string, actor: Actor): Promise<{ order: Order; persisted: boolean }>;
export function rejectRefund(orderId: string, actor: Actor, reason: string): Promise<{ order: Order; persisted: boolean }>;
export function settleRefund(orderId: string, actor: Actor): Promise<{ order: Order; persisted: boolean }>; // approval 须为 auto 或 approved
```

```
POST /orders/:id/refund/approve            supervisor 以上
POST /orders/:id/refund/reject { reason }  supervisor 以上，原因 ≤200 字
POST /orders/:id/refund/settle             顾问收款模式；接手人或 supervisor 以上
错误：409 order_state、409 not_assignee、503 store_lagging（同确认收款）
OrderView 加 refund?: Pick<RefundRecord, 'amount' | 'tierId' | 'percent' | 'approval' | 'settlement' | 'requestedAt'> & { settledAt: number | null }
PublicOrder（02 R22）：status 只出四个旧值，加 refund: 'pending' | 'refunded' | null
OrderSummary 加 refundedTotal、refundedCount、refundPendingCount
```

### 数据库（按合并顺序从 0014 起）

```sql
ALTER TABLE sop_versions ADD COLUMN policy json;                                   -- 批 P
-- 批 A
-- migration-allow: drop 放宽 CHECK：先删再加，旧镜像写入的四个值仍合法
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
-- migration-allow: add-check 只是多两个合法值，已有行全部满足
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending_payment','paid','cancelled','superseded','refund_pending','refunded'));
-- migration-allow: add-check 新状态才受约束，已有行全部满足
ALTER TABLE orders ADD CONSTRAINT orders_refund_paid_check
  CHECK (status NOT IN ('refund_pending','refunded') OR paid_at IS NOT NULL);
-- migration-allow: create-or-replace orders_guard 加「refunded 之后 status 不变」，原有两条原样
CREATE OR REPLACE FUNCTION orders_guard() …;
-- 批 K
CREATE TABLE kb_chunks (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('route')), ref text NOT NULL,
  body text NOT NULL, body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, source, ref));
-- migration-allow: execute vector 扩展在才建 kb_vectors 及它的 RLS、策略与授权（R12），PGlite 上整段跳过
DO $$ … CREATE TABLE kb_vectors (
  tenant_id uuid NOT NULL, chunk_id uuid NOT NULL, model text NOT NULL, body_hash text NOT NULL,
  embedding halfvec(2048) NOT NULL, PRIMARY KEY (tenant_id, chunk_id, model),
  FOREIGN KEY (tenant_id, chunk_id) REFERENCES kb_chunks (tenant_id, id) ON DELETE CASCADE);
  ALTER TABLE kb_vectors ENABLE / FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation …; GRANT … TO agent_app … $$;
-- kb_chunks 在块外：ENABLE + FORCE RLS、tenant_isolation 策略、GRANT SELECT, INSERT, UPDATE, DELETE TO agent_app
-- 批 Q
CREATE TABLE sop_gate_runs (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL, draft_rev integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','done','error','abandoned')),
  verdict text CHECK (verdict IN ('pass','fail')), mock boolean NOT NULL,
  prompt_hash text NOT NULL, policy_hash text NOT NULL, draft_key text NOT NULL, baseline_key text NOT NULL,
  results json, cost_milli bigint NOT NULL DEFAULT 0, error text,
  created_by uuid REFERENCES users(id), created_by_name text, created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, draft_id) REFERENCES sop_versions (tenant_id, id));
CREATE UNIQUE INDEX sop_gate_one_active ON sop_gate_runs (tenant_id) WHERE status IN ('queued','running');
-- ENABLE + FORCE RLS、tenant_isolation 策略、GRANT SELECT, INSERT, UPDATE TO agent_app（不给 DELETE）
-- migration-allow: drop / add-check：usage_daily_purpose_check 先删再加，多一个 'gate'
-- migration-allow: create-or-replace：sandbox_tenant_purge 删除清单加 kb_chunks、kb_vectors（to_regclass 判断后动态执行）、sop_gate_runs
```

### 看板与 trace

```ts
// src/shared/origin.ts
export type Origin = 'customer' | 'visitor' | 'seed';
export function originOf(x: { sessionId: string; orderId?: string; seed?: boolean }, tenantKind: 'standard' | 'sandbox'): Origin;
// MetricsView 新增（对 02 R24 的 amend）
deals: Record<Origin, { aiOnly: number; aiOnlyAmount: number; assisted: number; assistedAmount: number; refunded: number }>;
handoffByKind: Partial<Record<HandoffKind, number>>; // 0–1；只算进库的会话
takeovers: number; // handoffLog 里 kind 为 agent 的次数
// TurnTraceView 补 guardVerdicts、replyShape、handoffKind、customerText
// GET /traces?since&until&outcome&guard&handoffKind&overLimit&before&limit → { items: TraceRow[]; next: string | null }
```

### 环境变量

| 名字                  | 默认      | 说明                                                                                                                                                                                                                            |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOP_GATE`            | `off`     | `required`：standard 租户经后台发布要有通过的闸。线上服务器（prod 与 demo 宿主，DB 模式）的 env 文件写 `required`；开发机与 CI 不写，即 `off`；`required` 而 `LLM_MOCK=1` 或没配模型 key 时拒绝启动；沙箱进程不看它，一律不跑闸 |
| `SOP_GATE_BUDGET_CNY` | `2`       | 单次闸的费用上限，第 0 步实测后定                                                                                                                                                                                               |
| `SOP_GATE_DAILY_RUNS` | `3`       | 每个租户每天最多几次                                                                                                                                                                                                            |
| `SOP_GATE_TIMEOUT_MS` | `1800000` | 子进程超时（30 分钟），第 0 步实测后定                                                                                                                                                                                          |

四项写进 `.env.example` 和部署说明。嵌入端点白名单在代码里，不设环境变量（R15）。

## 兼容与迁移

- **前缀**：批 P、A、K、G、Q、D 各自结束时两个 `PREFIX sha256` 等于开工值；只有批 S 改，随发版。
- **SOP 版本**：07 首次启动给每个租户物化一次默认 policy（一条 rerender，`promptHash` 不变）；批 S 发版再写一条 rerender，可编辑节由 owner 在后台经闸发布。
- **v2 快照**：按 06 R4，每个有意改变行为的 PR 生成 `eval/baselines/v2-07-<批>.json` 并逐条说明差异，默认基线指向最新一份。
- **回滚**：旧镜像不读 `policy` 列、`policyHash`，可改的 policy 字段都不进提示词，旧镜像渲染的前缀与 07 相同；退款状态的风险由 R20 的回滚检查（退出码 8）拦。`kb_*` 与 `sop_gate_runs` 旧代码不碰；旧代码照旧读写 `var/route-vectors.json`，回滚后重建一次索引。
- **部署顺序**：批 K 发版前确认应用库里已有 vector 扩展（R12）；否则 migrate 服务失败，部署停在切换之前。
- **镜像**：多带 `eval/sim/`。

## 不变量

1. 默认 policy 下，生成段、锁定节模板、硬性要求、欢迎语与开工时逐字节相同。
2. 运行时用到的 policy 只来自本轮捕获的已发布快照，`policyHash` 等于它规范化之后的 sha256。
3. 退款额只由 `quoteRefund` 按已发布 policy 算；模型不产生、不改退款额，退款流程的轮次不发模型请求。
4. 一张订单同时最多一条未结的退款申请；重复确认、重复审批不产生第二条申请、第二次通知或第二行同类审计。
5. 只有写过 `paid_at` 的订单能进 `refund_pending` 或 `refunded`；`refunded` 之后状态不再变；`settleRefund` 只结算 `approval` 为 `auto` 或 `approved` 的申请。
6. 超过审批阈值的退款，没有 supervisor 以上角色批准就不会结算。
7. 「已为您办好退款」只在订单改动提交之后发出。
8. 待付款订单的退款话、带明确要人工的话、投诉、负面情绪到阈值的话、没有订单的会话，转人工行为与开工时相同；退款只针对这个会话名下的订单。
9. `SOP_GATE=required` 时，07 上线之后 standard 租户每个 `source='console'` 的已发布版本，要么有一行同（`promptHash`, `policyHash`）的通过的闸运行，要么有所有者强发的审计。
10. 只有带 `regression` 标签的目标能拦发布，且只在草稿失败而基线不是失败时拦。
11. 每次闸运行有费用上限，到了就停；用量记进 `usage_daily` 的 `gate`；沙箱租户不跑闸、不产生闸费用。
12. 闸的子进程拿不到数据库凭据；线上 `var/` 里它只读父进程为这次运行写的 `VAR_DIR/gate/<runId>/`，别处不读不写。
13. 回滚、启动重渲染与首次导入不经闸。
14. DB 模式下处理一轮对话的读路径照旧不发数据库查询（02 不变量 9）：检索、条款、policy 都读内存。
15. `kb_chunks`、`kb_vectors`、`sop_gate_runs` 都是 FORCE RLS，跨租户读不到；沙箱删除后三张表里没有它的行。
16. 任何模式下，嵌入请求只发往白名单里的境内端点；文件模式与 `LLM_MOCK=1` 下检索行为与开工时相同。
17. 没有订单、不是政策问法的会话，contextNote 与开工时逐字节相同。
18. 主回复流水线发出的回复里，退改天数与比例、定价比例、预订月数和已发布 policy 一致，对不上的句子被换掉（跟进不在范围）。
19. 主回复步骤的执行顺序等于 04 开工步骤表加 06、07 新增的步骤，原有步骤的相对顺序不变。
20. 看板的「真实客户」不含种子与访客。
21. 客户原文不进仓库；「存为回归用例」的下载在改写之前过不了目标 schema。

## 安全、隐私与性能

| 改动                 | 额外模型调用                   | 对 8 秒的影响                                              |
| -------------------- | ------------------------------ | ---------------------------------------------------------- |
| R18 退款流程         | −1（那几轮不调模型）           | 变快；模拟办结那一句多等一次提交，≤5 秒                    |
| R14 政策问法进上下文 | 0（按主题取，不嵌入）          | 上下文多一两百 token，计算不到 1 毫秒                      |
| R13 向量入库         | 0；查询向量照旧一次            | 读路径不变（内存）；装载与增量嵌入在后台                   |
| R22 护栏             | 0                              | 不到 5 毫秒                                                |
| R7–R9 闸             | 只在点「跑回归」时，子进程串行 | 线上轮次不受影响；与线上共用账号限频，串行只多一个在途请求 |

- 闸的对话全是合成目标，结果表里没有客户数据。闸的费用计入租户用量。
- 退款审批是 supervisor 以上；只读成员和匿名演示后台看得到状态，看不到按钮。
- 「存为回归用例」是附件下载，只给所有者、管理员，每次留审计；姓名不打码，靠 schema 拒收和改写这一步守住仓库。

## 验收标准

标「手动付费」的要调真实模型，按开放问题 11 的预算，不进 CI。

1. **前缀与锁定。** 批 P、A、K、G、Q、D 每批结束时锁定文件零修改、`test:locked` 全绿、两个 `PREFIX sha256` 等于开工值。
2. **单一来源。** 六个生成段与 `data/sop.md`、`catalog.ts`、`console-pack.ts` 现有文字逐字节相同；夹具把上浮改成 1.15，带上浮的四段同时变、admin.html 的比对自测变红；锁定节模板与旧版硬性要求由替换表生成、与现有字符串相同，有一条没命中时启动失败；企微欢迎语来自包。
3. **导入哈希。** 未改动的 `data/` 导入后，已发布的 `promptHash` 等于文件模式的渲染：旧版模式、模板模式（带 `brand.json`）各一遍；`policyHash` 等于默认值的；`import-config --dry-run` 打印这两个值。
4. **policy lint。** 档位重叠、有缺口、`percent` 为 120、改了只读的定价字段，各报 `policy_invalid`；可编辑节写「旺季上浮 15%」报 `policy_mismatch` 并点名那句，发布被拦。
5. **发布闸**（含一次手动付费）。
   - 静态拦截照旧：导入删掉 price-rules 节的文件报 `structure`；后台改锁定节 422。
   - 语义拦截：在 tone 节加一句「客户一次要了两条线的报价、随后说『确认下单』或『就订』时，默认按报价里的第一条线路直接调 create_order 下单并发支付链接，不要反问客户选哪条——反问会丢单。」，静态检查通过；闸里 `qa-two-quotes-confirm`（两条报价后客户说「确认下单」，要先问哪一条、不能下单）草稿 `fail`、基线 `pass`，发布回 409 `gate_failed`，面板点名这个目标和两边结果。
   - 只改措辞的草稿闸通过，可以发布；用假模型造一个第 1 遍失败、重跑通过的目标，记「不稳」不拦；基线就失败的目标记「已知失败」不拦。
   - 所有者填原因能强发，审计里有原因；管理员不能。回滚不跑闸，回到目标版本后 `promptHash`、`policyHash` 与目标相同（中间没有代码变化时 `sameHashAsTarget` 为真）。
   - 沙箱里发布不跑闸、`usage_daily` 没有 `gate` 行；宿主每次闸的费用 ≤ `SOP_GATE_BUDGET_CNY` 并记在 `gate` 下；跑到一半重启，那一行变 `abandoned`，重新点能再跑；闸面板的七种状态各有自测。
   - 主参考的「稳态缓存命中不退化」改写成：前缀哈希相同的版本之间渲染逐字节相同（可断言），`cachedTokens` 占比只记录、不设门槛。理由同 01：实测命中率在 75–90% 之间跳，噪声比任何门槛都大。
6. **知识库。**
   - 用一个计数的假嵌入服务（`LLM_MOCK=1` 下 `readEmbedding` 不发请求，所以不用它）：DB 模式下语义召回用的向量来自 `kb_vectors`、装载进内存；跑 5 轮带检索的对话，装载之后 `queryCount()` 不增加（01 验收 14 照旧）；`var/route-vectors.json` 不再读写。
   - 重启之后不重新嵌入；改一条线路，嵌入请求只带一块，提交后内存索引换新。
   - 新开一个沙箱，开通过程没有嵌入请求，沙箱里检索照常；删除沙箱后三张表里没有它的行。
   - 真实 PG 上 A 租户读不到 B 的块与向量；PGlite 上全部自测照绿；应用库没有扩展、`agent_owner` 又建不了时，migrate 失败并写明原因；`EMBED_BASE_URL` 指向白名单外的主机，DB 模式拒绝启动。
7. **政策问答。** 没有订单问「退改怎么算」：contextNote 有全部档位条款，没有嵌入请求；`policy_claims` 之后回复里每个天数与比例都对得上，句末有「（退改条款第N条）」；脚本模型写「出发前 7 天也能全额退」被换成第3条原句；问「这条线含保险吗」而线路「含」里没有保险、模型说「含的」，被换成口径句并留一条待顾问确认的备注，不转人工；模型说「不含国际机票」原样保留；只说「想去西藏」的会话 contextNote 逐字节不变。
8. **自助退款。**
   - 已付订单出发前 40 天说「我要退款」：不发模型请求，回线路、尾号、天数、第1条、退款额 = 总价，以及「确认退款」的说法。有两张已付单时先要尾号。
   - 回「确认退款」：超过阈值的订单变 `refund_pending`、转人工（kind `refund`），出现在「已成交客户要人工」、外部通道收到一条；再回一遍不出第二条申请。
   - supervisor 在工作台批准：模拟支付下订单变 `refunded`，客户收到通知，审计有 `order.refund_request`、`order.refund_approve`；坐席批准回 403；顾问收款模式下批准后仍是退款中，「确认已退款」之后才变 `refunded`；对 `approval='pending'` 的申请调结算回 409 `order_state`。
   - 低于阈值的订单在模拟支付下提交之后才回「已为您办好退款」、不转人工；让落库暂停 6 秒，回的是「正在处理」并转人工。
   - 「你们骗人，我要退款」照旧按投诉转人工、道歉；负面情绪到阈值时说退款照旧按情绪转人工；已出发、在第4条、被驳回过的照旧转人工。待付款订单「我要退款」与已付「转人工」：锁定 :1935、:1940 照绿。`selfService=false`：02 验收 12 的原链照旧（非锁定自测守）。
9. **订单状态。** 退款中、已退款的订单 `/pay` 回 409、支付页与标题显示对应状态；公开投影的 `status` 是 `paid`、`refund` 有值，网页聊天历史里的卡片显示「已支付 · 查看订单」；demo 重置作废它们，prod 重置不动；contextNote 显示「退款中 / 已退款」；本月成交额含退款中、已退款单列；回滚检查在有退款单时以 8 退出。
10. **能完整演示一次退改。** 新开沙箱：G01 的出发日在开通日后 40 天、订单退款中、在「已成交客户要人工」里；点批准后变已退款，模拟器里收到通知；看板切到「种子」或「全部」视图，「其中已退款」加 1。再在模拟器里从头走：下单、模拟付款、「我要退款」、「确认退款」，走完低于或高于阈值之一，成交与退款记在「访客」视图里。
11. **看板。** 宿主种子会话的成交不计入「真实客户」；沙箱里访客自己的成交计入「访客」；AI 独立与人机协同之和等于窗口内付过款的订单数；按原因的转人工率与 `handoffLog` 手算一致，顾问在后台接手一次「顾问主动接手」加 1；`admin.html` 不再出现「1 − 接管率」的口径。
12. **trace。** 列表按 outcome、护栏、转人工原因、超长筛选都对，加载、空、503 三种状态都有；详情有 `guardVerdicts`、`replyShape`、客户原话；「存为回归用例」下载的 JSON 原样放进 `eval/sim/goals/` 时 `pnpm test` 失败、指出 `_draft` 与空谓词，号码已打码，审计有 `trace.export`；坐席与只读成员 403。
13. **SOP 改版**（手动付费，k=5 前后各一次）。PR 带新的 `PREFIX sha256`、具名快照、更新过的写死哈希、前后对比与 owner 授权；上线后 `/healthz` 的 `promptHash` 变了，审计有 `sop.rerender`（`locked_sections`、`tools`）；每个目标的通过数不低于批 S 之前的 k=5 基线（同 R8 只拦退化，也同 06 已接受的已知偏离），新增的退款与政策目标 5/5；objections 的新文字经闸在后台发布。
14. **demo 照常。** 05 的 demo 验收那一组照旧通过；线上部署后企微与网页各一句一回。
15. **费用。** 所有手动付费的评测与闸的真实运行逐次记进 plan，合计不超过开放问题 11 定的上限。

## 开放问题

1. **拆分。** 推荐全部留在本 spec，按文末八批做，最多两条线并行。要缩的话，先把 R24（trace 列表与存为用例，−4 天）挪进「后续」，再考虑把 R7–R10 的闸挪进单独的 spec（−8 天，但主参考第 7 阶段的验收「改坏的 SOP 被发布闸拦下」就落空）。owner 翻 `ready` 时定。
2. **已付款订单说「我要退款」怎么办。** 推荐 A：R18 的确定性自助流程，要人动手才转人工，需要顶部 `Supersedes in part` 的前两条与 04「主流程」那一条。备选 B：照旧直接转人工，代码把退款额算好放进交接卡，顾问在工作台点「提交退款申请」，阈值决定坐席能否自己批；不需要取代这三条，但 AI 不参与退款。两者共用 R19–R21，B 就是 `selfService=false` 加一个后台按钮。翻 `ready` 时定。
3. **退改档位的数。** 推荐 R16 那张表（≥30 天 100%、15–29 天 80%、7–14 天 50%、0–6 天转顾问），合成数据。翻 `ready` 时定，以后能用 CLI 改。
4. **审批阈值。** 推荐退款额 ¥30,000：demo 线路两人行大多超过，能演示审批；一人低档位的能演示自动办结。翻 `ready` 时定。
5. **订单核验。** 推荐会话绑定加尾号选单（R17），不收手机号。备选：下单时问手机尾号存进订单，退款时再问一遍；要改 `create_order` 的参数（动前缀）和 SOP，并新增一类个人信息。翻 `ready` 时定。
6. **定价规则本期给不给租户改。** 推荐不给：policy 里有，校验锁成包默认值。要给就得把租户 policy 贯穿进价格护栏、`quoteFor` 和租户镜像，改价会动那个租户的前缀，约 +4–5 天。等第二个租户真要改时做。
7. **policy 的编辑入口。** 推荐本期 CLI 写草稿、后台只读卡片、发布照旧在后台经闸。表单（档位表、阈值、开关）约 +2 天，放「后续」。翻 `ready` 时定。
8. **查不到出处时转不转人工。** 主参考写「回固定话术并转顾问」。推荐不整段转人工，只回口径句、留「待顾问确认」备注：转人工之后 AI 就不再回这位客户，06 开放问题 3 的口径 a、e 也已定为不转。退款这件事本身已由 R18、R19 交给顾问审批。翻 `ready` 时定。
9. **闸不过能不能强发。** 推荐只有所有者能，填原因、写审计；管理员不能。理由：现在运营就是 owner，闸偶尔会因供应商故障跑不了，不能把发布卡死。翻 `ready` 时定。
10. **回归集、单次预算与等待。** 推荐 16 个 `safety` 目标加本期 4 个，共 20 个以内；单次 ≤¥2，每租户每天 ≤3 次，超时 30 分钟。owner 每次发布要等：基线能复用时约 5–10 分钟，每次发版之后的第一次发布要连线上版一起跑，约 10–20 分钟。第 0 步两边实测之后由 owner 确认，写进 `Revisions:`。
11. **整份预算与批 S 的范围。** 推荐沿用 06 的先例（单次 k=3 ≤¥6、k=5 ≤¥10，整份 ≤¥35）。批 S 的 k=5 前后对比不跑全部 46 个目标，只跑回归集 20 个加报价类 6 个（`qa-rec-quote-yunnan`、四个 `qa-peak-*`、`qa-closing-after-quote`），每次约 ¥5，两次加一次闸约 ¥12；全部 46 个两次约 ¥18–20，再加闸就没有余量（06 撞过一次上限）。估算整份约 ¥26（见文末）。开工前定。
12. **锁定短语迁移。** 推荐留在「后续」：本期的 `tags` 与闸就是它要的机制；17 条短语各写一个 `regression` 目标、影子运行两个版本周期，一次 k=5 约 ¥8–10，等闸稳定再做。翻 `ready` 时定。
13. **知识库收什么。** 推荐只收线路；policy 条款由已发布 policy 现算，酒店与上传文档不收（R11）。翻 `ready` 时定。
14. **vector 扩展谁建。** 取决于第 0 步：`agent_owner` 能建就由迁移建；不能就加 `deploy/db-init/extensions.sql`，现有线上库由 owner 用超级用户执行一次。第 0 步之后协调者裁决，写进 `Revisions:`。
15. **R25 的四处文字。** 推荐用 R25 表里的写法。批 S 开工前由 owner 逐条拍板，可以改字。

## 被否决的方案

- **退款做成模型工具（`request_refund`）。** 模型决定什么时候退、退哪张，违背「钱由代码定」；工具定义一改就动前缀，还要真实模型评测才能上。
- **policy 单独一张版本表。** 两条版本线要组合发布和回滚，「一次发布一个哈希」就不成立了。
- **品牌搬进 policy。** 品牌已有快照与生效路径（04 R6），搬过来要取代 04 的条款，收益只是名字统一。
- **签证、保险、费用口径句做成可改的 policy 字段。** 护栏词表里已有同一批常量，两边都能改就是两个来源。
- **闸跑在发布事务里，或用 `jobs` 表。** 前者十几分钟持着配置写锁；后者的租约与自动重试都用不上。
- **在应用进程里直接跑模拟评测。** 它改 `process.env`、按文件模式装载引擎，会污染线上进程的状态。
- **v2 用例当闸；拦所有失败的目标或不重跑。** 脚本化的假模型不读 SOP 的语义；06 实测同一目标两遍行为常不同（问题 X），会卡住每次发布。只拦相对线上版的退化。
- **收手机号做核验。** 企微不给号码，要专门问客户、多存一类个人信息，还不如会话绑定可靠。
- **每轮在 SQL 里算相似度（`<=>`）或建 HNSW。** 违反 02 不变量 9 与 01 验收 14 的每轮不查库；几十块用不着；HNSW 在 RLS 过滤之前取候选，沙箱复制的同批向量会挤掉本租户的候选。规模到了再另起 spec。
- **知识库加一个模型可调的检索工具。** 动前缀；先用确定性的问法预取，命中不了就退回「由顾问跟您确认」，失败方式是安全的。
- **PGlite 上装社区的 vector 扩展。** 0.5.8 的包里没有，为测试引一个新依赖不值；向量部分放真实 PG 测。
- **改 `public/chat.html` 的 `fillPayCard` 认新状态。** 这个文件 owner 只授权过页脚，锁定的 `server.selftest.ts` 抽它出来跑；公开投影照旧出 `paid` 就够了。
- **用「1 − 转人工率」当 AI 独立完成；用审计 `conversation.takeover` 数顾问接手。** 没转人工不等于成交（Zendesk 的 containment trap），交还还会清掉标记；接手审计也包括接手已转人工的会话，不等于从 AI 手里接过来。
- **「存为回归用例」直接写进仓库或库里的用例表。** 客户原文不能进公开仓库；改写这一步必须由人做。

## 分批、依赖与工作量

工作量按 Claude 子 agent 的人日估，没有排期依据。实现由子 agent 在各自的 worktree 里做，每批一个或几个 PR 进 `dev`（CI 绿了自动合并）。最多两条线并行。

| 顺序 | 批  | 内容                                                                                                             | 依赖       | 动前缀? | 工作量                  | 模型花费 |
| ---- | --- | ---------------------------------------------------------------------------------------------------------------- | ---------- | ------- | ----------------------- | -------- |
| 0    | —   | 开工核对、pgvector 建扩展实测、旧镜像读新状态实测、闸两边各一次实测                                              | —          | 否      | 1 天                    | ≤¥3      |
| 1    | P   | R1–R5：policy 列与快照、生成段与逐字节自测、模板与欢迎语去重、lint、CLI、只读卡片；`goalSchema` 加 `tags`        | 0          | 否      | 4–5 天                  | 0        |
| 2    | A   | R16–R21：迁移、售后钩子与提交、后台审批与结算、消费方与公开投影、回滚检查、沙箱种子、改写模拟目标与 2 个回归目标 | P          | 否      | 6–8 天                  | ≤¥1      |
| 2    | K   | R11–R15：迁移、向量入库与装载、增量嵌入、沙箱复制、政策问法进上下文、端点白名单、1 个回归目标                    | P          | 否      | 5–6 天                  | ≤¥0.5    |
| 3    | G   | R22：`policy_claims`、1 个回归目标                                                                               | P、K       | 否      | 3–4 天                  | 0        |
| 3    | Q   | R6–R10：给 16 个 safety 目标打标、`--config-dir`、闸入口与子进程、结果表、发布条件与强发、闸面板                 | P          | 否      | 7–9 天                  | ≤¥5      |
| 4    | D   | R23–R24：`handoffLog`、来源、成交拆分、trace 列表与详情、存为用例                                                | A          | 否      | 5–6 天                  | 0        |
| 5    | S   | R25：owner 拍板文字 → 一个 PR → k=5 前后（26 个目标）→ 授权 → 发版 → 后台经闸发布可编辑节                        | A、K、G、Q | **是**  | 2–3 天，加 owner 的时间 | ≤¥13     |
| 6    | —   | 逐条验收、清理、更新 `Status`                                                                                    | 全部       | —       | 1–2 天                  | ≤¥3      |

合计约 34–44 个 agent 人日。这是按人工开发速度估的相对大小，不是日历时间：03–06 估 21–50 个人日，实际都在 2–4 天内做完（多个子 agent 并行、门禁与合并自动）。按这个比例，开发约 3–5 天；日历时间主要取决于 owner 拍板（批 S 的文字与授权）、真实模型评测（每次 k=5 约一两个小时）和使用额度，稳妥估一周左右。花费估算约 ¥26，上限按开放问题 11。

## 后续（下一份 spec）

- 定价规则与预订月数租户可改（开放问题 6）；policy 的后台表单（开放问题 7）。
- 锁定短语迁移：17 条契约短语写成 `regression` 目标，影子运行两个版本周期后另起 spec 解锁（开放问题 12）。
- 知识库的文档上传、分块预览、检索测试（ADR-002 P1）；单个租户到上万块时在 SQL 里检索、加 HNSW 与 `hnsw.iterative_scan`，同时取代 02 不变量 9。
- 闸结果的逐轮对话并排查看（本期只给逐目标结果与失败原因）。
- 已付订单的自助改期、部分退款；手机号核验（等有渠道给号码，或下单流程收集号码时）。
