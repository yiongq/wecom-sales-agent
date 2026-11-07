# 18 · 实施计划

依据 [spec](./spec.md)。spec 已于 2026-11-07 定 `ready`（heavy）。

第 1–2 步（`eval/sim/`）、第 3 步（核心护栏与工业包）、第 4 步（检索）、第 7 步（数据库、配置、部署）改的文件互不重叠，可以分开并行；第 5–6 步要等第 1、3、4 步合入。第 9 步只要 owner 有空就能做。第 6.1 冻结之后到 6.2 跑完之前，不合入任何改 `src/` 的 PR（含第 7 步），否则留出集拒绝运行。

- [ ] 0. 开工核对
  - [x] 0.1 第 1、2、4、5 次 main、第 3 次中止、两次换客户模型、两次开发集的 journal 已复制到本 worktree 的 `var/eval-sim-archive/`（不提交），sha256 记在同目录 `SHA256SUMS`；`main-3.jsonl` 只有 763 字节（中止）
  - [x] 0.2 启动重渲染（01「启动重渲染」第 8 步，`src/config/source.ts`）发现【硬性要求】或工具哈希变了，会直接发布一个 `source='rerender'` 的新版本并记 `sop.rerender` 审计，不经过发布闸。所以 R1 的提示词改动靠第 6 次 main 与 v2 用例验证（AGENTS.md 要求的真实模型评测就是第 6 次 main）
  - [x] 0.3 入站认领：`src/channels/inbox.ts` 的 `insertInboxRows` 与 cursor 同一事务（`src/cli/channel-transfer.ts` 也写，但要求先停应用）。发送标记：`src/store/pg-backend.ts` 的 `markOutboundSending` → `src/db/repo/outbound.ts`。发请求：`src/adapters/wecom.ts` 的 `sendText`、`sendLinkCard`、`sendMenu`（`kf/send_msg`）与欢迎语 `kf/send_msg_on_event`；分段发送循环里 `alreadySending` 跳过标记、同段重试最多 3 次。会话落库在 `pg-backend.ts`，第 7.2 步再细到函数
  - [x] 0.4 已复核：`eval/sim/audit.ts` 的金额正则含「(单价|合计|总价|小计) 数字」且不要求「元」，独立审计能识别「小计 360.00」；只有产品护栏的 `parseMoney` 漏
  - [x] 0.5 按仓库价目表 `src/usage.ts`，`embedding-3` 每百万 token ¥0.5；5000 条加约 1000 条查询估 30 多万 token，约 ¥0.2（官方现价未另核，账本按同一张表记）
  - [ ] 0.6 等锁进程的内存占用：要等第 7.1 步做出等锁启动后才量得到，挪到 7.6 一起测
  - [ ] 0.7 请 owner 提供服务器 Caddy 的上游写法（或授权只读查看），定 spec 开放问题 2
  - [x] 0.8 `var/` 里的文件与写方：`usage.json`（`src/usage.ts`）、`budget.json`（`src/budget.ts`）、语义索引缓存（`src/core/retrieval.ts`）、发布闸临时目录 `var/gate/`（`src/config/gate.ts`）、会话 spill（`src/store/pg-backend.ts`）、渠道标记与恢复哨兵（`src/channels/markers.ts`）、`sessions-in-db` 标记（`src/store.ts`）、旧的 `wecom-cursor.json`（`src/adapters/wecom-state.ts`，文件状态时才用）。都由活动进程读写，符合 spec 的规则。第 7.1 步要核：等锁进程收到 SIGTERM 时直接退出、不跑停机钩子，否则 `usage.json`、`budget.json` 的定时落盘可能用空状态盖掉主进程的文件
  - [x] 0.9 工业包整段换成固定话术的分支（写 `blocksSuppressed`）：`guardedText` 待审带金额时整段换 `FIXED.pending`；`quote_claim` 自动建单后整段换成「报价单：链接 + 合计」；`money_provenance` 删空后用兜底句（动作 `replace`）；`turn_failure` 转人工。`quote_claim` 的 `correctClaim`（`ACCEPT_ASK`、`NOT_SUBMITTED`）只换那一句，属局部纠正，不写旗标。`rfq_trim` 的 `TRIM_FALLBACK` 在块计入预算后应很少出现，第 3 步定是否写旗标
- [x] 1. 检测器：`eval/sim/triage.ts` 与自测（每个检测器至少一正一反，用合成 journal 片段）；回溯第 1、2、4、5 次，逐条核对验收 7 的已知问题
  - #471：8 个检测器、73 项自测，`scripts/check-boundaries.ts` 强制不 import `src/packs`、`src/core/guards`。验收 7 列的已知问题全部命中，其中 j-change-03#2 在第 5 次换客户模型那一遍（spec 已改）
  - 回溯疑似数（第 1、2、4、5 次 main）：`price_withheld` 16、13、16、8；`correct_deleted` 70、70、69、58；`ask_after_accept` 1、1、34、1。rfq_trim 用裁剪说明盖住的第 10 行以后不算缺价，已排除这类误报
- [x] 2. 生成用例
  - [x] 2.1 16 的 journal 每轮写 `sessionBefore`（`eval/sim/runtime.ts`），旧字段不变
  - [x] 2.2 v2 工业夹具加 `moneyLedger` 与审批种子（`eval/v2/schema.ts`、worker）
  - [x] 2.3 `eval/sim/promote.ts` 与自测：订单 id 换序号、预取不进脚本、旧 journal 报「只能手写用例」
- [x] 3. 价格块
  - [x] 3.1 `pack-api` 的 `ReplyBlocks`、核心 `reply_blocks:render` / `reply_blocks:place` 两步，`blocksSuppressed` 旗标的读写声明与步骤表校验
  - [x] 3.2 工业包三种试算模板、档位价、应付金额；`quote_items` 结果加 `block` 与下一档；`find_parts` 加 `block`
  - [x] 3.3 `shape_check`、`rfq_trim` 按「正文 + 块」算预算、只改正文
  - [x] 3.4 按 0.9 的清单在固定话术分支写旗标
  - [x] 3.5 【硬性要求】与工具说明；trace `turn.blocks`
  - [x] 3.6 自测与 v2 用例（验收 1、6）；锁定套件、旅游 v2 快照 0 差异
- [x] 4. 混合检索
  - [x] 4.1 `eval/retrieval/` 生成器、手写查询、`run.ts`，假嵌入自测。5000 条产品（种子 1805，用种子重新生成逐字节一致），704 条查询，8 类各 88 条，其中手写 64 条。指标改为截断 recall@5 加 precision@5，定向三类查询的相关条目限 1–5 个，宽泛查询单列（spec 已改）
  - [x] 4.2 真实嵌入跑 `current` 基线：owner 11-07 授权。和 4.4 同一次付费运行，90 次请求、312,968 tokens、¥0.156；向量缓存后复跑 0 次请求，指标逐项一致。`run.ts --embed real` 与离线自测另由 Codex 落进检索分支
  - [x] 4.3 `src/core/retrieval-hybrid.ts`、`src/packs/industrial/attributes.ts`、`semanticScores`、`match.ts` 接线，状态登记，和检索报告同一个 PR。v2 回归 927/927，快照 0 差异
  - [x] 4.4 跑 `hybrid`，写检索报告（验收 16–18），见 [docs/reports/retrieval/2026-11-07](../../reports/retrieval/2026-11-07/report.md)
    - 截断 recall@5 91.0% → 98.5%，MRR@5 68.3% → 98.4%，误给型号 0/45，p95 32.3 → 15.8 ms，派生索引多 9.7 MB
    - 手写 64 条：recall 78.2% → 91.0%；口语/错别字只到 62.5%，是剩下最弱的一类
    - 验收 16–18 满足
- [ ] 5. 开发集（owner 当次授权）：跑完用检测器扫一遍；修在代码的用第 2 步生成用例（验收 8），修在提示词的按 spec R2 找开发集场景定向复跑
  - [x] 5.1 第 1 次（11-07，`dev` `4132f586`，owner「合入后跑」授权）：16 个场景 × 5，79/80，pass^5 15/16，¥1.400（封顶 ¥1.5；18 累计 ¥1.556 / ¥12）。检测器 38 条疑似，初裁确认 17、误报 21，详情见交接记录
  - [x] 5.2 修价格块的呈现问题与检测器缺陷，生成用例，定向复跑（owner「按推荐修」）：两条 promote 用例修复前失败、修复后通过；定向复跑 5 个场景 × 5，25/25，¥0.463（18 累计 ¥2.019 / ¥12）
- [ ] 6. 第 6 次 main
  - [ ] 6.1 重新冻结，`--prepare` 写开跑行并提交
  - [ ] 6.2 跑 main（owner 当次授权），再跑换客户模型（D6 已定 A）
  - [ ] 6.3 审计裁定、检测器、`triage-review.json`
  - [ ] 6.4 报告：16 格式加 R2 附表和「18 前后对比」（验收 2–5、9、19）
- [ ] 7. 主备切换
  - [ ] 7.1 `TENANT_LOCK_WAIT`、等锁启动、等锁时的 SIGTERM
  - [ ] 7.2 `process_epochs` 迁移与 RLS，`bumpProcessEpoch`、`fenceProcessEpoch`，按 0.3 的清单接栅栏
  - [ ] 7.3 发送前检查（含恢复补发、同段重试）、`markOutboundSending` 的 `stale` 结果、等锁模式下 03 R6 照发只在锁视图 `held` 时允许
  - [ ] 7.4 失锁即停收并关闭监听；重取成功后核对 epoch；等锁模式下失去主身份后的停机不写 spill
  - [ ] 7.5 compose `app-standby`、`deploy.sh` 滚动切换与回滚、`deploy/watch.sh` 探两个端口、运维手册、要求停应用的命令行提示、README 与总参考「从单实例到多租户」里单实例的说法
  - [ ] 7.6 真实 PG 演练自测：杀主进程、掐锁连接、重取时 epoch 已变、本机 compose 加 Caddy 容器的滚动发版（验收 10–14）
- [ ] 8. 主备上线前置（owner 点名才做）：服务器 Caddy 改上游、首次以主备方式部署
- [ ] 9. 企微去重实测：`src/cli/wecom-dedup-probe.ts`（每个间隔独立 msgid 的成对实验）；owner 授权后在服务器上跑，owner 手机看每一对；按结果改窗口规则与发送层截止检查（03 顶部标记已在 ready 时加）（验收 15）
- [ ] 10. 对照全部验收标准逐条验证，结果记在下面
- [ ] 11. 清理临时探针、演练容器与 `var/` 里的临时文件
- [ ] 12. owner 确认后改 spec 的 `Status`

## 交接记录

2026-11-07：spec 与 plan 首版起草（`dev` `406fe404`）。本机探针确认 `parseMoney` 不识别「小计 360.00」这种不带「元」的写法，已写进 spec 现状。第 1–5 次 main 的 journal 还在另一个 worktree 的 `var/eval-sim/`，第 0.1 步要先备份。下一步：owner 读 spec，定 7 张决策卡、档位和是否 `ready`。

2026-11-07：owner 对决策卡答「都按推荐」，D1–D7 全部定为 A，已记进 spec 顶部 `Revisions:`。还在等：Tier 是否按 heavy、是否改 `ready`。

2026-11-07：Codex 只读交叉评审 spec（3 blocker、8 major、1 minor）。其中 7 条我对照代码复核属实（局部纠正也返回 `replace`、12 行 600 字上限、恢复补发跳过 `markSending` 且标记失败会照发、journal 只存订单和阶段、10 验收 9 禁止 v2 审批种子、已知问题场景都在留出集、`watch.sh` 盯固定端口），其余是推理类问题，认同。12 条全部按评审改进 spec（见 spec 顶部第一条 `Revisions:`），plan 步骤随之重排。还在等：Tier 是否按 heavy、是否改 `ready`。

2026-11-07：owner「改 ready，heavy」，spec 改为 `ready`、Tier heavy；01、03、10、16 顶部补反向标记，总参考登记。下一步：第 0 步（0.7 要 owner 提供 Caddy 配置），之后按开头的分路并行，同时最多两路。

2026-11-07：开工。第 0 步除 0.6（挪到 7.6）、0.7（等 owner 给 Caddy 配置）外已完成，结论写在各子步骤上。派了两路 Codex：第 1 步检测器（worktree `codex-18-triage`，分支 `feat/18-triage`）、第 4.1 与 4.3 步检索（worktree `codex-18-retrieval`，分支 `feat/18-retrieval`），都从 `docs/18-draft` 拉。检索那路开工就发现 `PartSchema` 只有 4 个类目，spec R5 改为「4 个类目下至少 8 种子类型」后续跑。两路都会改 `package.json` 的 test 行，收尾时后开的 PR 先合入前一个再开，免得冲突后 CI 不跑。

2026-11-07：第 1 步与第 4 步完成。

- 检测器（#471）：CI 第 4 分片挂在 `src/db/rollback-guard.selftest.ts` 一条 180 ms 时限的超时用例上。这条用例和本 PR 无关，同一基线上 #470 的同一分片是绿的，所以只重跑了失败的 job，重跑通过后合入。
- 检索：评测口径中途改成截断 recall，假嵌入下先跑通。owner 授权后用真实嵌入跑了一次，费用 ¥0.156，报告在 `docs/reports/retrieval/2026-11-07/`。
- 真实嵌入的评测入口（`eval/retrieval/real-embed.ts`、`run.ts --embed real`）由 Codex 补进检索分支。#471 合入后，检索的两个提交和报告提交 cherry-pick 到从 `dev` 新建的分支，合成一个 PR；`package.json` 的 test 行两边各加的自测都保留。
- 下一步：第 2 步（`sessionBefore`、v2 字段、`promote.ts`）与第 3 步（价格块）可以并行。

2026-11-07：第 3 步完成。Codex 实现，Claude 审查后返工两轮，验收定位见下表。

- 返工一：需确认的行合成一行并始终保留，不计入「已算好」；全部不可报价只写一行「暂时报不了价」；没有交期不出残句；应付金额写明是客户接受的那份。
- 返工二：试算块会出现时，`rfq_trim` 裁正文不再补自己的裁剪说明，此前同一条回复里会出现两句「已算好」。
- 已有 v2 用例的客户输入和模型原稿保持不变，只改期望；占位符写法另加 `q18-blocks-basic.json`。`TRIM_FALLBACK` 是整段固定替换，写抑制旗标。
- 复跑：工业与核心护栏自测、回复管线、trace、锁定套件通过；v2 933/933，927 条快照 0 差异（旅游 857 条不变）；format、lint、typecheck 通过。
- 完整 `pnpm test` 在本机两次卡在 `src/store/store.selftest.ts` 的一条计时断言上，当时机器上同时跑着另一路 Codex。该断言没改过，交给 CI 判断。

### 第 3 步验收定位（2026-11-07）

验收 1 的六项均在 `src/industrial-replies.selftest.ts`，使用真实工具与整条主回复管线：

| 项                 | 断言位置（变量 / 断言标识）                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 三模板           | `complete` 的金额/下一档/交期逐字段断言；`partialBlock` 的「部分可报价不写合计」及单行需确认摘要；`noneBlock` 的「全不可报价没有金额」；`moqBlock` 起订量原因（含件）及全不可报价单行                                           |
| 2 缺占位符自动附后 | `appended` 的「没写占位符自动附后」及 trace `placed=appended`；`moneyDropped` 的「错价删句之后仍有价格块」                                                                                                                      |
| 3 无效占位符       | `unknownBlock` 的「未知或无数据占位符整句删除」和 `droppedTokens=2`；另测三个原型属性名与末次工具失败，不漏花括号                                                                                                               |
| 4 抑制旗标         | `suppressed` 的「抑制旗标不放块也不漏占位符」及空 rendered；另测待审、自动补建批准单、金额删空、失败转人工和裁剪兜底                                                                                                            |
| 5 局部 replace     | `corrected` 的 quote_claim 裁决 replace、旗标仍空、块照常附上；`shippingFixed` 的运费局部纠正保留块                                                                                                                             |
| 6 三十行长度       | `many` 的「三十行展开不超过12行600字」、正文两行保留、裁剪说明和 900.00 元合计；`longBody` 验剩余正文预算；`manyUnpriced` 验未报价警示不丢；`mixedBudget` 验只数被裁可报价行；`summaryOverflow/noneOverflow` 验单行省略及总预算 |

不变量 1–6 的保证：

| 不变量                       | 自测或装载校验                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 只格式化字段、不补合计     | `literalFields` 刻意用不相乘的单价/行金额/合计，断言原字段输出；`partialBlock` / `noneBlock` 不写合计；`payable` 只用本轮接受订单；`tierBlock` 边界由工具给出                                                                                |
| 2 放置后不删块、正文仍过护栏 | `completeRun` 断言 place 后只有 takeover_check:post、turn_failure、final_clean；`syncBlocks` 断言两新步骤不返回 Promise；`moneyDropped` 验正文错价仍被删；validate 自测拒绝窗口倒置及 place 后任意删句步骤，execute 自测保留同步尾部竞态保护 |
| 3 最终不超 12 行 / 600 字    | `many`、`longBody`、`manyUnpriced`、`fallbackBlock`；最终 replyShape 与 turn.blocks.finalShape 等于展开后文本                                                                                                                                |
| 4 抑制即无块                 | `suppressed`、`pendingBlock`、`repaired`、`emptied`、`failureBlock`、`fallbackBlock`；`industrial-quotes.selftest.ts` 最终接受核验失效时 trace.suppressed 与固定替换一致                                                                     |
| 5 非声明包及跟进表不变       | 旅游主回复 33 步、旅游跟进 11 步、工业跟进 4 步逐项断言；857 条旅游 v2 保持原快照，全部锁定文件无 diff                                                                                                                                       |
| 6 对客无占位符               | `unknownBlock` / 原型属性占位符 / `noData` / `duplicate` / `suppressed` 及对客文本无花括号和 markdown 的汇总断言；新增 q18 v2 也断言不含花括号                                                                                               |

2026-11-07：第 2 步完成。Codex 实现，Claude 审查后一次通过。

- `eval/sim/runtime.ts` 在销售这一轮开始前深拷贝完整会话和订单，写进 journal 的 `sessionBefore`；旧字段不变，旧 journal 照常能读。
- v2 工业夹具新增可选的 `session.moneyLedger` 与 `orders[].approval`（`pending` / `approved`，可带 `decidedAt`）；没用新字段的用例行为不变。
- `eval/sim/promote.ts`：只接受唯一且带理由的 `confirmed` 裁定；订单 id（含 `acceptingOrderId`）换成序号引用，预取不进脚本，8 个检测器各有断言规则，生成后先在原回复上验证断言会失败，再过 `validateCase`；旧 journal 报「只能手写用例」。
- 验收 8 的合成路径：`promote.selftest.ts` 用合成 journal 生成用例，经 v2 runner 真跑。重复句用例在重复原稿上失败、去重后通过；缺价用例在第 2 步单独的提交上会失败，叠上第 3 步的价格块后通过（块补上了单价），自测现在断言它通过。第 5 步仍要用开发集的真实 journal 走一遍。
- 复跑：promote、journal、sim、triage、v2 runner、边界自测通过；v2 927/927，快照 0 差异；锁定套件与三项门禁通过。

2026-11-07：第 5 步开发集第 1 次（journal 在本机 `var/eval-sim/dev-3.jsonl`，不入库）。

- 结果：79/80，pass^5 15/16（`j-attachment-02` 一遍多余转人工），¥1.400。和 dev-2（11-01）比，每轮 p50 2.3→4.4 秒、p90 3.7→8.7 秒，单次模型调用 p50 1.5→3.9 秒，而每次调用的提示词只多 11%、推理 token 不变；提示词缓存占比 73%→49%（第 4、5 次 main 已在 55% 左右）。慢的大头更像模型服务这边（这次是北京时间周六上午），没法下定论；会影响第 6 次 main 的验收 4（p90 不比第 5 次高 0.5 秒以上）。
- 价格块在真实模型下的呈现问题（134 轮出了块）：67 轮正文里模型自己又写了商品金额，价格重复；14 轮占位符嵌在句子中间，句子被拆断（「小计 ⏎试算：…⏎，现货可发。」）；4 轮模型照对话历史抄了一份试算块，代码又附一份；1 轮占位符和无数据的 `{{档位价}}` 写在同一句，整句被删，客户没拿到价。
- 检测器缺陷（误报的主因）：`price_withheld` 读 `trace.turn.flags.blocksSuppressed`，但 trace 记在 `turn.blocks.suppressed`（第 1 步写在 trace 字段定下来之前）；「报价单」被当成问价；`duplicate_text` 把块内每行的「以顾问确认为准」当成重复句。
- 其余确认：2 轮接受后仍要求「在有效期内完成确认」；11 轮护栏删了对的内容，其中有块的轮次客户没丢关键信息，没有块的（跨档提示、现货说法）少了信息，属 16 已知问题。
- 裁定写在本机 `var/eval-sim/dev-3-triage-review.json`，owner 抽看。下一步待 owner 定修复范围。

2026-11-07：第 5.2 步完成（#477）。

- 价格块：试算块放进回复时，正文里的商品金额句和照抄的块由代码删掉；块放在占位符所在整行之后；因别的无效占位符被删的句子里，有效占位符照样放置；删掉开头金额句后去掉剩下的开头连接词。提示词写明占位符单独占一行、不要照抄试算明细。发布闸的 5 个工业回归目标把数量匹配放宽到也认「× N：」，工业目标集哈希随之变化。
- 回归用例（验收 8）：`promote.ts` 从 dev-3 生成 `q18-placeholder-dropped`（缺价）与 `q18-block-copied`（块出现两次），在 `4132f586` 上失败、修复后通过，随 `pnpm test` 运行。
- 检测器：`price_withheld` 也认 `blocks.suppressed`，「报价单」不算问价，`duplicate_text` 按整行比较块内价格行。dev-3 疑似 38 → 27，验收 7 的已知问题仍全部命中。
- 定向复跑（`j-tier-02`、`j-bargain-01`、`j-injection-02`、`j-writing-01`、`j-list-01`，各 5 遍，`88e6a4c7`），和 dev-3 里同样 5 个场景比：

|                             | 修复前（dev-3） |          修复后 |
| --------------------------- | --------------: | --------------: |
| 通过                        |           25/25 |           25/25 |
| 块出现两次                  |            3 轮 |               0 |
| 句子被拆断                  |            7 轮 |               0 |
| 缺价、重复句疑似            |            1、3 |            0、0 |
| 模型仍在正文写商品金额      |           32 轮 |           27 轮 |
| 每轮 p90 / 单次模型调用 p50 | 8.6 秒 / 3.9 秒 | 5.0 秒 / 1.6 秒 |
| 提示词缓存占比              |             45% |             67% |

- 读法：呈现问题已由代码收住，不依赖模型守规矩（模型仍有 27 轮在正文写了金额：带试算块的由代码删掉，只附「应付金额」的接受轮没删，见下）。延迟回到 11-01 的水平，而代码改动只是删句，说明 dev-3 的慢主要在模型服务一侧；第 6 次 main 要在和第 5 次相近的时段跑，报告里注明时段。
- 留下的：接受轮只附「应付金额」时，模型正文也写了合计，总价说两遍（16 轮）；这类句子常带税率、有效期，整句删会丢信息，先不改。复跑里出现过 1 轮开头「另外…」的残句，已修。「删对的内容」15 → 21 条是模型波动，都在有块的轮次，客户没丢价格。
- 下一步：第 6 步第 6 次 main（重新冻结、owner 当次授权），之后第 7 步主备、第 9 步企微实测。
