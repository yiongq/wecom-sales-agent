# 02 · 会话入库 + 坐席工作台 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。每步一个 PR 进 `dev`，CI 绿了再合；界面改动在 PR 里写 BEFORE / AFTER；新依赖钉精确版本；新自测与检查脚本必须串进 `test` 或 `lint`。括号里是工程日估算，合计约 70 个工程日。

开工须知（新会话从这里开始）：

- spec 的 `Status` 必须是 `ready` 才能开工；还是 `draft` 就停下，告诉 owner 等他翻。
- 先读：`AGENTS.md`；本目录 `spec.md` 全文；01 spec 的「两种模式与启动装载」「withTenant」「迁移纪律」「RLS、授权与认证函数」「测试与 CI」；后台 UX spec 的「外壳」「总览」「会话列表」「会话工作台」「依赖 02 的后端」；`docs/features/console-ux/design-system.md` 的 §5.6、§6.7、§10.0 与 A2、I、J 三页。然后 `git log -5`，再读本文件的「交接记录」与「Open」。
- **锁定套件**（断言一条不许改）：`src/engine.selftest.ts`、`src/dejargon.selftest.ts`、`src/engine-holiday.selftest.ts`、`src/price-guard.selftest.ts`、`src/llm.selftest.ts`、`src/server.selftest.ts`、`src/adapters/wecom.selftest.ts`，以及 `eval/cases.json`。任何一步让它们变红，都先找自己的改动；确认是 spec 与锁定断言冲突时，停下写进「Open」，不改断言。要改的非锁定断言只限 spec「测试与 CI」最后一条列的那些，PR 里写明理由。
- 前缀：除第 15 步的 SOP 改动外，每一步结束时 `engine.selftest.ts` 打印的 `PREFIX sha256` 都要等于第 1 步记下的值；第 15 步之后等于第 15 步记下的新值。
- spec 的 14 个开放问题 owner 已在 2026-10-02 全部定下（答复见本文件「Open」），不阻塞任何步骤；各步照 spec 里写定的结论做。
- 原地变异测试在隔离副本里跑（Stop 钩子会对工作区跑门禁）；复现卡死的脚本用单进程加超时，收尾查 `ps`，不留孤儿进程。

- [x] 1. 开工核对（0.5）：2026-10-02 完成，基准、盘点与要注意的事见「实施记录 · 第 1 步」，带出三处要 owner 定的记在「Open」（都不挡第 2 步）。
  - 确认 spec 是 `ready`。
  - 记下开工提交的 sha；记下锁定套件 8 个文件的 sha256（`shasum -a 256 <文件>`）。验收 1 以它们为基准。
  - 跑四个门禁，记下 `PREFIX sha256` 的 system 与 tools 两个哈希。
  - 只读盘点，结果写进「实施记录 · 第 1 步」，后面的步骤照着改：
    - 对 `session.messages` 的非 push 写：`grep -rnE "messages\s*=[^=]|messages\.splice|\.content\s*\+=|\.at\s*=[^=]" src --include=*.ts | grep -v selftest`；
    - 写死的 `'paid'` 阶段判断：`grep -rn "'paid'" src public/admin.html | grep -v selftest`；
    - 进入转人工与改 `handedOver` 的位置：`grep -rnE "enterHandoff\(|handedOver\s*=" src | grep -v selftest`；
    - 每一处 `kf/send_msg` 与 `sendText` / `sendRich` / `push` 的调用；每一处对客户文本、`reason`、`quote` 的截断（`.slice(`）；
    - 日志里引用客户原话的位置（`console.log/warn/error` 里拼了客户消息或回复原文的）；
    - 匿名可读、直接返回 store 原对象的旧接口；
    - 锁定套件与 `eval/cases.json` 里含「高反、受伤、骨折、护照、证件、丢了、被困、走丢、急救、失望、无语、垃圾、坑、离谱、不用了、别发了、不需要、撤回、删除」的客户原话，逐句写下它们现在的期望结果（第 11、16 步的规则不许改变这些结果）。
  - 文档收尾：01 spec 与后台 UX spec 顶部各加一行 `Amended by: [02 · 会话入库 + 坐席工作台](../../architecture/02-conversations-workbench/spec.md)`（路径按各自位置写对）。「部分取代」规则与两份 spec 的 `Superseded in part by:` 已在 2026-10-02 加好（开放问题 1 选 A），不再动。其余不动；后台 UX plan「Open」里交接卡措辞那一条标「已由 02 spec 解决（R12）」；总参考「开放问题」里 identity map、自测存储、`rerender` 三条写明「已由 02 spec 定」。
- [x] 2. store 门面、停机与启动顺序（2.5）：2026-10-02 完成，取舍与第 5、6 步要注意的事见「实施记录 · 第 2 步」。
  - `src/shutdown.ts`：从 `store.ts` 搬出信号接线、`onShutdown`、`runShutdownHooks`、`gracefulExit`，加 normal / drain / late 三段与各段时限；`store.ts` 原样再导出。
  - `src/store/backend.ts` 的 `StoreBackend`；`src/store/seq.ts` 的 `assignSeqs`（文件存储与 demo 类用宽松模式）；把 `src/store.ts` 现有的持久化抽成文件后端，导出的名字与行为不变，导入期副作用两种模式相同（R3）。
  - 新增 `sessionStoreMode()`、`isDemoClassId()`、`initSessionStore()`（文件分支：标记文件 → `sessions_in_db`）、`flushSession(id, { timeoutMs })`、`drainStore()`、`seqOf()`、`emitAfterCommit()` / `onCommitted()`（文件后端在落盘之后发）、`storeHealth()`；`SESSION_STORE` 的校验接进 01 的 `initConfigFromEnv`（非法值、`db` 而 `CONFIG_SOURCE` 不是 `db` → `env_invalid`）。
  - `src/boot.ts` 在 `initConfig` 与 `serve` 之间加 `initSessionStore`；`/healthz` 加 `store` 与 `ok` 的新条件；`.env.example` 加 `SESSION_STORE`。
  - `src/selftest-env.ts` 把 `SESSION_STORE` 钉成 `file`。
  - 新建 `src/store/store.selftest.ts`，先写文件后端的部分（`flushSession` 等到落盘、事件在落盘之后、`SESSION_STORE` 的各个非法组合与 `boot()` 的失败分支、三段停机的顺序与时限、`assignSeqs` 的两种模式），串进 `test`；在 `.env` 写着 `SESSION_STORE=db` 的副本里跑一遍 `pnpm test`。
  - 对应验收 1，以及不变量 1、2、8 的分配部分、15 的文件一半。
- [ ] 3. 与存储无关的引擎与类型改动（3）：
  - `src/shared/conversation-types.ts`（`HandoffKind`、`HandoffRecord`、`Assignee`、`MessageAuthor`、`OrderStatus`、`PaymentMode`、`OutboundKind`、`SendWindow`），`src/types.ts` 等从这里 import 再导出；`src/shared/text.ts` 的 `cleanText`，引擎的入口截断与企微重放对齐里的截断一起换成它。
  - `src/types.ts`：`ChatMessage.sentAt` / `author` / `authorId` / `authorName`；`Session` 与 `Order` 的新字段。
  - `src/handoff/record.ts`：新签名的 `enterHandoff`（`tools.ts` 再导出）；五条入口都带记录；`firstHandoffAt`、`handoffCount`；从未转人工进入时清接手人；终态会话按开放问题 12 的 A 处理（R9）；重置清掉接手人与计数；终态阶段不再被改回 `handoff`；`markOrderPaid` 写 `handoffBeforePaid`。
  - 五处非追加写里与存储无关的两处：转人工备注在工具执行前拼好；企微重放改传 `{ alreadyRecorded: true }`（有 msgid 按 msgid，旧数据按文本）。`handleMessage` 多可选的 `opts`，企微文本消息带上 `msgid` 与 `sentAt`。
  - `src/shared/conversation.ts`：四态的 `conversationState`（结构类型参数）、`paidNeedsHuman`、规范化的 `needSummary`；`src/shared/console-api.ts` 的 `CONVERSATION_STATES` 与 `ConversationRow` 新字段；`console.selftest.ts` 的「6 个投影字段」改成新键集合；`scripts/check-console-src.ts` 的状态白名单加 `assigned`；console 里用到 `TAB_RANK`、状态名表的地方先补上第四态（界面还不显示它，第 19 步再画）。
  - `/api/orders/:id` 改为白名单投影（R22）；匿名可读的旧接口改为去掉成员身份的投影；`profile.ts` 加开关 `legacy_admin_writes`（demo 开、prod 封顶关）并接到旧的 handoff、resume、reply 上。
  - 新建 `src/handoff/handoff.selftest.ts`：记录与五个入口、四态判定、终态会话转人工、重置清接手人、`handoffBeforePaid`、公开投影的键集合、匿名投影没有成员身份。
  - 锁定套件全绿、前缀哈希不变。对应验收 12，以及 7、13、16 在文件存储下的部分。
- [ ] 4. 迁移：新表、RLS、授权、触发器、清除与删除函数（3.5）：
  - `src/db/schema.ts` 加 spec「数据库」与各节列出的全部表、`tenants` 三列、`catalog_items.version`；drizzle-kit 生成；custom 迁移写 RLS 模板、授权（spec 的授权表）、两个触发器、`orders` 带列清单的外键、四个清除与删除函数、`catalog_item_versions` 的按租户回填。
  - `scripts/check-migrations.ts` 通过（`tenants` 三列标 `-- migration-allow: add-check` 和原因）。
  - `src/db/client.ts`：`withTenant` 的 `longRunning` 选项、`inTenantTx()`；`src/db/repo/audit.ts` 加 `writeAuditAs`。
  - `src/db/repo/` 加 conversations、messages、orders、catalog-versions、traces、usage、jobs、outbound、quick-replies、consents、privacy、metrics 的仓储函数（只收发领域类型）。
  - `src/db/db.selftest.ts`：「七张表」的断言与权限期望表扩到新表；PGlite 上迁移连跑两遍、CHECK（含 `conversations.id` 拒绝 demo 类、`state.id` 一致）、`jobs` 的 open 唯一、复合外键与 `SET NULL (session_id)`、两个触发器。真实 PG 部分：新表逐格权限、没有 DELETE / TRUNCATE、清除函数拒删未到期数据与「未来的 now」、不在 `withTenant` 里调用报错、`erase_conversation` 只有 platform 能调。
  - `deploy/backup.sh` 的 TABLE DATA 校验加三张表（行数为 0 不告警）。
  - 对应验收 5 的权限与清除函数部分，以及不变量 5、6、11。
- [ ] 5. PG 后端（5）：
  - `src/store/project.ts`：`sessionToRow` / `rowToSession`、`orderToRow` / `rowToOrder`、消息的行投影（未知键进 `extra`）、`normalizeForStore`。纯函数，先写往返自测。
  - `src/store/pg-backend.ts`：分批预载（`longRunning`）与 7 天 msgid 集合、每会话写队列与合并（`AsyncLocalStorage.snapshot()` 起落库）、一次落库的七步（spec「identity map 与写入」，含 `flush_id` 与存档点）、进快照即冻结、失败的两类与 poisoned、`StoreConflictError` → 优雅停机、drain 段排空、`spillSync` 与启动回放；`deleteOrdersOfSession` 在 db 存储下作废订单；重置与裁剪体现为窗口推进；demo 类会话仍走 JSON，对它们的审计单独一个事务。
  - `src/db/testing.ts` 加 `installPgSessionStore()`（PGlite 上装好 db 存储，只给自测与 `eval/run.ts` 用）。
  - `store.selftest.ts` 的 PGlite 部分：spec「测试与 CI」列的那些，含模拟崩溃后重启、SIGTERM 发生在一轮中间。
  - 对应验收 4、5、6、8、28 的存储部分，以及不变量 3、4、7–10、12、13、16。
- [ ] 6. 导入导出与切换（2.5）：
  - `src/cli/import-sessions.ts`（`--keep`、标记文件、`--resync`）、`export-sessions.ts`（删标记）；只用 `project.ts` 与 `src/db/repo/**`，不 import 运行时模块。
  - `initSessionStore` 的 `real_in_json` 拒绝。
  - 测试夹具：一份含真实会话、种子、访客、孤儿订单、`followup`、`quoteHistory`、昵称、旧格式订单号、NUL 与孤立代理项的 `var/`。
  - `store.selftest.ts`：往返、重复导入 0、补完改写 0、内容不同 2、持锁 3、导出 → 文件存储下再聊 → `--resync` → 一致、`--dry-run` 不写库、两个启动拒绝；真实 PG 部分以子进程执行两个命令行并断言退出码。
  - `deploy.sh` 回滚前检查：目标是 02 之前的镜像，而服务器 `var/` 里有标记文件或 `/healthz` 的 `config.catalogVersioned` 为 true 时拒绝，并打印 spec 的回退步骤（`catalogVersioned` 在第 8 步才有，先只查标记文件）。
  - 对应验收 3，以及不变量 14、15。
- [ ] 7. 等价套件与 DB 模式 mock eval（1.5）：
  - `src/store/parity.selftest.ts`：spec「测试与 CI」列的场景，会话 id 用 `wecom:parity-*`，各跑在文件存储与 PG 存储上并比较，断言 PG 里有这些会话。
  - `eval/run.ts` 的 `CONFIG_TEST_DB=pglite` 同时装上 PG 会话存储，会话 id 改用 `eval:<用例>-<时间>`；跑完断言库里有每个用例的会话、消息与内存一致。
  - 用 DB 模式 mock eval 与等价套件找出漏网的原地修改（冻结会抛 `TypeError`）与数组错位（`WindowCorruptError`），逐处改成只追加，改动记进实施记录。
  - 对应验收 2、7。到这一步，存储层的形状定下来了。
- [ ] 8. 产品库版本、按轮固定快照、开放五个字段（3.5）：
  - 上架写版本 1，active 条目每次改动写新版本并更新 `catalog_items.version`（`src/config/catalog.ts` 与 `catalog-fix`），审计 `catalog.version`；全部版本读进内存；启动补写缺失的版本；`/healthz` 的 `config.catalogVersioned`。
  - `pinCatalogForTurn`；引擎的 `handleMessageInner` 与跟进生成包进去。
  - `generate_proposal` 在版本大于 1 时追加 `?v=`；链接白名单、`linksFromCalls`、企微卡片识别接受它；`public/proposal.html` 把 `v` 转给 `/api/proposal/:routeId`；`/proposal/*` 与 `/api/proposal/:routeId` 按版本渲染、只读内存；订单记 `catalogVersion`。
  - 以上都通过之后，`LOCKED_WHEN_ACTIVE` 去掉五个字段；行业包的锁定组与后台保存条的说明跟着改；`config.selftest.ts`、`console.selftest.ts` 里断言这五个字段 422 的用例改成断言能改且产生新版本。
  - 新自测：改价前后旧链接报价不变、新链接带 `?v=2`、`?v=3` 404 且不查库、订单不变、轮内快照一致、改 `title` 仍 422、删掉版本行后重启补写；文件模式下链接逐字节不变。
  - 对应验收 19，以及不变量 35–37。
- [ ] 9. 逐轮 trace、护栏事件、用量（3）：
  - `src/trace/recorder.ts`；`startTurn` / `noteGuard` / `endTurn` 接进引擎（确定性路径也记，两种存储都收集）；spec 列的改写点逐个调 `noteGuard`，名字照 spec；AI 回复经 `WeakMap` 关联 `turnId`；`catalogVersions`；模型调用的 `error` 类别。
  - `usage.ts` 的 `recordUsage` 加 `purpose` 与 `onUsage`；`completeText` 加 `opts`，洞察、建议、代拟、跟进各自传；`retrieval.ts` 传 `embedding`；`usage_daily` 的累加与 30 秒 upsert，drain 段写一次。
  - 后台读接口的仓储函数先写好（第 13 步挂接口）。
  - 新自测：价格护栏删句那一轮有 trace 与一行 `price` 事件、`removed` 正确；没改文本的护栏不记；用量合计与 `recordUsage` 收到的相同（含 embedding）。
  - 对应验收 20 的数据部分、21。
- [ ] 10. 任务表与跟进（3）：
  - `src/jobs/runner.ts`（认领、执行、重试、`sending`、启动时各类 `running` 与 `sending` 的去向、normal 段把没进 `sending` 的跟进改回 `pending`）；`startJobs()` 在 db 存储下代替 `startFollowUpScheduler()`。
  - `guardOutbound`（engine.ts 导出）；`shouldFollowUp` 导出并作为两种存储共用的资格判断（含 `FOLLOWUP_ENABLED`），文件存储下的扫描器也改调它和 `guardOutbound`；拒绝识别（两种存储都做）。
  - db 存储下 AI 回复落库时排跟进、客户回话时取消、夜间顺延；`retention_purge` 与 `handoff_notify` 两种任务先只排程、执行体留到第 14、16 步。
  - 新建 `src/jobs/jobs.selftest.ts`：排程与取消、开关关时不排、`sending` 前后「崩溃」的两种结果、编造金额的跟进话术被护栏拦下、拒绝之后不再排。锁定的 `llm.selftest.ts` F1 照旧通过。
  - 对应验收 22，以及不变量 38。
- [ ] 11. 确定性转人工：紧急情况与交互失败（2）：
  - `src/handoff/triggers.ts` 的 `emergencyOf`、`TurnSignals`、`turnFailed`、`failureThresholdReached`、`sensitiveCategoriesOf`、`consentWithdrawalOf`（后两个第 16 步用）；引擎接入（spec「确定性转人工触发」）。
  - 向量表写进 `handoff.selftest.ts`：命中、出行前提问、否定、转述、价格或注入护栏命中的轮次；第 1 步盘点出的锁定原话逐句跑一遍，结果与盘点相同。
  - 失败阈值让某条锁定断言变红时，停下写进「Open」，由 owner 在「阈值改 3」与别的办法之间定。
  - 对应验收 17 的紧急与交互失败部分，以及不变量 29、30。
  - [ ] 11.1 负面情绪（1.5）：按开放问题 4 定下的词表加规则实现 `negativeLevel` 与阈值，向量表同上。对应验收 17 的其余部分。
- [ ] 12. 企微：发送账本、回执、去重、前缀（3.5）：
  - 开放问题 5、8 已定：做 R7 的三条缓解，额度按 R18 的保守口径算。
  - `ChannelAdapter.push` 的 `opts`；`src/quota/ledger.ts`；`sendText` / `sendRich` / 欢迎语 / 菜单每个分段自带 msgid（重试沿用）并记账，超时与网络异常记 `unknown`；没有会话的欢迎语单独一个事务；`sync_msg` 接收 `msg_send_fail`；去重与重放的五种情况；适配器在 `sendRich` 之前比较接手代次；人工回复在两个渠道的客户侧加「【顾问】」；`author='human'` 的历史映射与 contextNote 说明；出口去掉 AI 回复开头的「【顾问】」。
  - 新建 `src/quota/quota.selftest.ts`：窗口与剩余条数（`sentAt` 起算）、`unknown` 计数、重试同一 msgid、回执、跟进与人工回复的放行、五种去重情况（含「已入库未回复」重启后恰好回复一次）；历史里的「【顾问】」写进 `handoff.selftest.ts`。
  - 对应验收 18，以及不变量 18、28 的适配器部分、33、34。
- [ ] 13. 接手状态机与后台接口（4.5）：
  - `src/handoff/takeover.ts`（`takeover`、`release`、`reply`、接手代次、`clientId` 去重、`ForbiddenError`、`ConsentDeclinedError`、回复的「查健康 → 入库 → 等提交 → 发送」顺序）；引擎在 push AI 回复之前比较接手代次；旧接口 `/api/sessions/:id/handoff|resume|reply` 按 spec 改调它们（共享工作台）。
  - `src/console-api/app.ts` 按 spec「后台接口」链式加全部新接口、权限中间件、新错误码；写接口 `await flushSession(id, { timeoutMs: 5000 })`、超时 503 `store_lagging`；审计新动作（会话类记 `ref`）与 `AUDIT_ACTIONS`（含 K 页的「会话与订单」分段）；viewer 打码；`/orders` 的角色限制与从 identity map 计算；`/events` 的 SSE（环形缓冲、`resync`、心跳、每 60 秒复核登录）；`/api/admin/stream` 改为提交后发；`/status` 带会话数与 poisoned。
  - `console.selftest.ts` 新用例：spec「测试与 CI」列的那些（权限矩阵逐格含 403 与 409 的分界、路由枚举、并发接手恰一个成功、别人接手中回复 409 且没发送、自动接手、交还恢复阶段、不同意后交还 409、事件里没有正文、事件流登录失效后关闭、`order=waiting_first` 与 counts 四项之和）。
  - 开放问题 12（A）在接口上的部分（`paidNeedsHuman` 的数据）一起做。
  - 对应验收 9、10、11 的接口部分，以及不变量 17、20–25、27、28、31、39 的接口部分、41、43–45、47。
- [ ] 14. 外部通知（1.5）：`Notifier` 的企微群机器人实现（开放问题 3，与告警不同群）、`handoff_notify` 任务的执行体（立即、10 分钟仍没人接手、窗口剩不到 4 小时、advisor 模式下待确认的订单、已成交客户要人工）；带转人工的落库失败时的 `unsaved` 通知；`NOTIFY_WEBHOOK_URL` 进 `.env.example` 与 compose 的 app 服务说明，日志脱敏。自测用假的 webhook 服务断言内容里没有客户原话和 `external_userid`。对应验收 15 的外部通道部分，以及不变量 10 的例外、32。
- [ ] 15. 收款流程与 SOP 措辞（3.5）：
  - `src/payment/`：`paymentMode`、`confirmOrder`、`markPaidByAdvisor`、`cancelOrder`（坐席只限接手人本人；提交之后才发付款确认）；后台的三个订单接口接上；advisor 模式下 `create_order` 的 `payNote`、`/pay` 页的说明、价格规则护栏的替换句、`repairLinks` / `placeLinks` 的说明句、重发链接、成单安全网、企微支付卡片、跟进 closing 段的确定性文本；online 模式逐字节不变。
  - `data/sop.md` 锁定节的两处改动、`SOP_KNOWN_FIELDS` 与旅游包 `sopFields` 加 `payNote`；契约清单短语一条不删。记下改前改后的四个哈希（`/healthz` 与 `PREFIX sha256`）。
  - 真实模型回归（花钱，不进 CI）：按 01 交接里的「真实模型对比」跑法，`--cases` 指向仓库外的 realOnly 用例文件，文件、DB 交替各至少 3 遍，记 p90、命中率与通过的用例集合，和改动前比较。
  - 自测：prod profile 的整条链路（`payNote`、页面说明、替换句、匿名 404、未确认 409、非接手人坐席 409、审计两行、付款确认在提交之后）；demo profile 与开工时相同。
  - 对应验收 23、24，以及不变量 19、20 的付款部分、39。
- [ ] 16. 隐私说明、敏感信息同意、保留期、行权删除（4）：开放问题 2、7 已定：保留期用迁移的默认值（即裁决值），同意流程照 spec；PIA 要求改同意细节时另行修订 spec。
  - `privacy-publish`、`tenant-retention`、`erase-conversation` 三个 platform 命令行；隐私说明读进内存与 60 秒轮询；`GET /privacy`；欢迎语按发布与否加链接；同意菜单（用途、影响、可撤回、链接）、`menu_id` 回调记录、再问一次、不同意转人工（`kind='consent'`）且不能交还、撤回同意。
  - `retention_purge` 任务的执行体（跳过有动静的会话、带预期值调清除函数、同一个 tick 移出内存并记墓碑、`purge_expired_traces`、`purge_finished_jobs`、`system.purge` 审计）。
  - `logQuote()`：第 1 步盘点出的日志位置逐个改经它；compose 的 app 服务配日志轮转。
  - 新建 `src/privacy/privacy.selftest.ts`；保留期、清理竞争与行权删除的场景写进 `store.selftest.ts`（真实 PG）。
  - 对应验收 25、26、27，以及不变量 6、40、41、42。
- [ ] 17. 可观测性：结构化日志与告警（3）：
  - `src/log.ts`（`pino` 钉精确版本）：`LOG_FORMAT=json` 时输出 JSON、`boot()` 把 `console.*` 接过去；请求中间件生成 `req` 与 `x-request-id`；轮次里的 `tenant`、`conv`（`ref` 或短码）、`turn`；`redact` 盖住凭据字段。
  - `src/ops/alert.ts` 与 `startAlerts()`：spec「告警」表里 app 侧的五个键，去重、限流、恢复消息、推送失败不抛。
  - `deploy/watch.sh`（重启次数、健康检查、磁盘、备份是否超过 26 小时没成功）与 `deploy/backup.sh` 的失败告警；`ALERT_WEBHOOK_URL`、`INSTANCE_LABEL`、`LOG_FORMAT` 进 `.env.example` 与 compose 的说明；cron 的配置写进部署文档（路径另记）。
  - 由 owner 配好国内云厂商的外部拨测（开放问题 14，账号另记），停一次 app 确认通知能到，结果记进「验收记录」。
  - 新建 `src/ops/ops.selftest.ts` 的日志与告警部分（含 `watch.sh`、`backup.sh` 的子进程用例）。
  - 对应验收 34 的日志与告警部分，以及不变量 32、48、50。
- [ ] 18. 可观测性：运行数字与 OpenTelemetry（2.5）：
  - `src/db/repo/metrics.ts` 的 SQL、`GET /api/console/metrics`（60 秒缓存，文件存储 503）。
  - `src/otel/export.ts`（`@opentelemetry/*` 钉精确版本，只经动态 `import()`）：`startOtel`、`exportTurn`、属性按 spec，属性名按当时的 GenAI 语义约定与 Langfuse 文档核对、版本写进注释；`OTEL_CAPTURE_CONTENT`；`OTEL_*` 进 `.env.example`。
  - `ops.selftest.ts` 的运行数字（PGlite）与 OpenTelemetry 部分（没配端点时没加载、进程内假 OTLP 接收端收到的 span 与属性、默认没有原文）。
  - 对应验收 34 的其余部分，以及不变量 49。
- [ ] 19. 前端：外壳实时与 I 页（2.5）：
  - console 订阅 `/events`，断开退回 30 秒轮询，收到 `auth` 回登录页；铃铛弹层的原因与等待时长、「已成交客户要人工」一组、「开启桌面提醒」、浏览器通知；标签页标题前缀；I 页的第四个页签、行的新字段、点行进 J 页、状态句与主按钮。
  - 非锁定自测里禁止「顾问处理中」与「今天不画」的断言（`errors.selftest.ts`、`overview.selftest.tsx`、`conversations.selftest.tsx`）改成按四态断言，PR 里写明理由。
  - console 自测：四态与计数同源、标题前缀只数 `human`、禁用词扫描、13 个种子的 UX 验收 6 照旧。
  - 对应验收 10 的界面部分、15 的界面部分，以及不变量 45、46。
- [ ] 20. 前端：J 页（4.5）：
  - [ ] 20.1 先修后台 UX plan「Open」第 1 条：`popupRegion` 包的下拉菜单键盘打不开（照列表筛选的写法，确认点弹层空白处不抢输入框焦点）；话术页、条目详情的「更多」一起受益（0.5）。
  - [ ] 20.2 照 spec「后台页面」与设计系统 J 页：三栏、分组列表、对话头与「更多」、五种消息呈现与 `handoff_note` 时间线、改写对照、「显示AI步骤」、交接卡、输入框与发送窗口（含 `persisted: false`）、右栏卡片与订单动作（订单相关部分等第 15 步合并，之前接桩）、「AI为什么这么回」、不同意时「交还AI」不可用、viewer 的打码正文、加载 / 空 / 出错。console 自测覆盖交接卡措辞、接手前输入框禁用、409 与 503 的说明、发送窗口为 0 时禁用、键盘打开「更多」（4）。
  - 对应验收 11、13、14 的界面部分，以及 20 的界面部分。
- [ ] 21. 前端：总览 A2 与运行数字格（2）：等人接手与已成交客户要人工的行、「接手」、待付款行（「等你确认价格」等第 15 步合并）、排序、「本月成交额」格与权限、四个运行数字格与权限。console 自测用 02 种子场景断言顺序与金额。对应验收 16 与 34 的界面部分。
- [ ] 22. 快捷回复：行业包默认模板与管理抽屉（1，可砍）：行业包配置加默认模板；空表首次读取时写入；J 页右栏的插入与 480 抽屉（新建、编辑、上移下移、归档，正文不许 markdown）。对应验收 33 的快捷回复部分。
- [ ] 23. `admin.html` 两处（0.5）：列表 401 时弹登录框（在 `load()` 之外判断，`server.selftest.ts` 抽取的 `load()` 与 `sigOf()` 源码不变）；db 配置模式下顶部提示链到 J 页。对应验收 29 的这一句。
- [ ] 24. 02 走查种子与走查（1）：`scripts/seed-demo.py` 加 `--scenario console-ux-02`（设计系统 §10.0 第 5 条：14 个会话、A01 由小林接手、F01 的原因、三张订单）；7F3A 不走种子，由走查脚本经假企微接口和脚本化的 mock LLM 真跑出来（要有一轮价格护栏删句，才有 trace 与改写对照）。Playwright 浅色、深色各走一遍，截图存到 `walkthrough/`，含只用键盘的交还。对应验收 33。
- [ ] 25. 压测（1.5）：`scripts/load/run.ts` 按 spec「压测」一节（含 5,000 × 300 的预载）；本机真实 Postgres、db 存储；结果与数字记进「验收记录」。对应验收 30。
- [ ] 26. 部署与演练（2）：
  - `deploy/backup.sh` 先打包 `var/` 再 `pg_dump`；`deploy.sh` 的回滚检查（第 6、8 步）在本机实测，含健康检查失败后的自动回滚与两个 02 镜像之间的回滚。
  - 在本机 compose 上按 spec「切换步骤」完整走一遍：以文件存储部署 → 停 app → 导入（`--keep`）→ db 存储起 → 回退（导出、去掉开关）→ 文件存储下聊几轮 → `--resync` 切回；然后做一次含会话的备份恢复演练，备份时让一轮在途，恢复后让假企微接口重放最近的消息，确认那位客户恰好收到一次回复、已回复的不重复。演练结论用来验证开放问题 5 的裁决（留在 04）；复现了重复或丢失就写进「Open」并告诉 owner。
  - 本机装上 `watch.sh` 的 cron，用一个测试群机器人把告警端到端走一遍。
  - 对应验收 31，以及 32 的本机部分。
- [ ] 27. demo 线上切换（1）：由 owner 在线上执行第 26 步的切换步骤；切换前后的哈希、会话数、停机时长与不敏感的证据记进「验收记录」，主机与路径另记；第一份备份验证通过后删掉 `--keep` 里的原件。对应验收 32。
- [ ] 28. 对照 spec 当前全部验收标准逐条验证，把每条的结果记在本文件「验收记录」一节
- [ ] 29. 清理临时探针与测试
- [ ] 30. owner 确认验收通过后，spec 顶部改 `Status: implemented`

## 工作量与砍法

累计估算：第 7 步结束约第 18.5 个工程日，第 13 步结束约第 39.5 个工程日，第 16 步结束约第 48.5 个工程日，第 18 步结束约第 54 个工程日，全部约 70 个工程日。第 19–24 步可以在第 13 步合并之后另开一个 worktree 与第 14–18 步并行；其中第 20.2 步右栏的订单动作与第 21 步的「等你确认价格」依赖第 15 步，先接桩，第 15 步合并后再接真接口。

**第一级**：第 22 个工程日结束时第 7 步还没勾，就按顺序砍：

1. 第 22 步的管理抽屉：快捷回复只读行业包默认模板，改模板走一个 platform 命令行。spec 要改：后台接口去掉快捷回复的四个写接口，权限表那一行，「后台页面」快捷回复管理一条，验收 33 去掉「快捷回复管理」。
2. J 页的「显示AI步骤」与 `/conversations/:id/turns` 摘要接口（trace 与改写对照保留）。spec 要改：接口列表一行、J 页一条。
3. A2 的排序细则改为「等人接手按等待时长、待付款按下单时间」。spec 要改：「后台页面」总览 A2 一条、验收 16 的顺序一句。

**第二级**：第 45 个工程日结束时第 13 步还没勾，在第一级之外再砍：

1. 浏览器通知（铃铛与标题的实时更新保留）。spec 要改：「通知」前端三条里的一条、验收 15 的一句、验收 33 的一项。
2. 压测的 429 风暴部分改为只记录、不设通过条件。spec 要改：「压测」与验收 30。
3. trace 不存工具结果的前 4 KB，只存工具名、参数与耗时。spec 要改：`TraceCall` 的一个字段。
4. `usage_daily.purpose` 只分 `chat` 与 `other`。spec 要改：DDL 的 CHECK 与「用量」一句。

**第三级**（只由 owner 决定）：

- owner 判断第一个真实租户在两个月以后，或第 14 步开工时已过第 53 个工程日，可以把第 14、15、16 步（外部通知、收款流程、隐私与同意、保留期清理、行权删除）拆成另一份 spec。spec 要改：目标 6 的后半句、目标 12、13，验收 15 的外部通道部分、23、25、26、27、35，开放问题 2、3、7、9；在顶部写 `Revisions:`。拆出去之后 prod 实例继续只做验收和预演（00 的运行规则），不接真实客户。
- OpenTelemetry 导出（第 18 步后半，约 1.5 天）推到自建 Langfuse 部署的时候（开放问题 13）：recorder 照收、trace 照存，只是不导出。spec 要改：R24 的 OpenTelemetry 一句、「可观测性与告警」的最后一节、不变量 49、验收 34 的 OpenTelemetry 一句。这是 owner 2026-10-02 定下的范围，只有 owner 能砍。

每砍一项，都在 spec 顶部加一行 `Revisions:`，写明改了哪些目标、接口和验收编号。**不能砍**：第 2–7 步（表的形状、只追加、identity map、写队列、三段停机与 spill、导入往返，以后补都要再迁一次数据或会丢数据）；第 3、13 步的转人工记录、四种状态、接手状态机与 `/reply` 校验；第 8 步的条目版本（之后才能开放计价字段）；第 11 步的紧急情况与交互失败；第 12 步的发送账本（没有它顾问会撞上看不见的 48 小时 / 5 条墙）；第 17 步的告警（出事没人知道，比少一个功能代价大）。

## 上线清单（接第一个真实租户之前）

不是本 spec implemented 的条件（验收 35）。每项只记「已完成 / 未完成」与日期，内容另记：

- [ ] PIA（个人信息保护影响评估）
- [ ] 与模型厂商的委托处理约定
- [ ] 地方网信办登记是否适用的书面答复
- [ ] 租户的隐私说明正文（含行权方式与备份保存期）已经 `privacy-publish`
- [ ] 租户的保留期已确认（默认是开放问题 2 的裁决值，要别的值用 `tenant-retention` 设）
- [ ] 系统页与租户品牌色的 spec（后台 UX spec 开放问题 3）
- [ ] PIA 出结论后复核同意细节（开放问题 7 的「要确认的点」），要改的已改
- [ ] 测试客服账号上实测企微额度与接口行为（开放问题 8），结论记进本文件
- [ ] 真实模型回归作为上线前的固定步骤跑过一次（开放问题 10），结果记在私有笔记
- [ ] 告警群与转人工通知群已建好，外部拨测已配（开放问题 14）
- [ ] 开放问题 5 的恢复演练没有复现重复回复或丢消息（第 26 步）

## 实施记录

按步骤号记下实施中的实测结论与偏离 spec 的取舍；不复述 spec。

### spec 评审（2026-10-02，开工之前）

- 首版草稿经三路评审（代码现实、数据完整性与运维、安全隐私与 spec 质量）后就地修订，改了什么见 spec 顶部 `Revisions:`。没有照原样采纳的几条：
  - `messages.msgid` 的唯一索引：评审建议保留并把冲突归为不可重试；改成不建唯一索引，去重放在进内存之前（撞上时宁可历史里多一条，不让会话的落库卡死）。
  - 预载时读出每个会话的全部 msgid：改为只读最近 7 天（`sync_msg` 能拉到的历史有限，全量读会随保留期线性增长），核实点并进开放问题 8。
  - 保留期判断另设 `last_activity_at` 列加列级授权：改为给 `updated_at` 加「只进不退」的触发器，「最后动静」的语义不变。
  - 库写不进去时先推一条「暂未入库」的 SSE：只对外部通道这样做，SSE 照旧只在提交后（库故障时 console 本身也登不进）。
  - 人工回复落库超时返回 503、不发送：改为照发并返回 `persisted: false`（「记下了没发」会让顾问重发，同样重复）；写库已积压时在改动之前就 503。
  - 没点同意菜单时「AI 不在回复里使用该信息」：做不到确定性保证，改为「再问一次、仍没点就照常接待并提示模型不主动提」，严格的做法列为开放问题 7 的备选。
  - 只读成员的正文「把敏感类别所在的消息折叠」：只做号码类打码，折叠留给 PIA 的结论。

### 第 1 步 · 开工核对（2026-10-02）

**基准**

- 前置条件逐项核对通过：spec `Status: ready`；01 与后台 UX spec 都是 implemented；线上 demo 自 2026-09-26 起 `CONFIG_SOURCE=db`（01 plan 验收 23）；`withTenant`、`holdTenantLock`、`queryCount`（`src/db/client.ts`）、`configMode()`（`src/config/source.ts`）与 `src/boot.ts` 的启动顺序与 01 spec 一致。
- 开工提交 `f5c895b82cbf808efa6b4e58dbd49f4d63e5af21`（dev，合并 PR #68）。
- 锁定文件 sha256（验收 1 的基准）：

  ```
  c71a4966983925bc422a55240b289675584485693a49d6410f5e5d5a2555a6e3  src/engine.selftest.ts
  166c124e28cec35a9b8b0e306bbda653e653ee5795fd186388185812e32a3941  src/dejargon.selftest.ts
  351fd745fcb65ed6f87605fe3deb4a60841598e983b44a6d91c9493571ff9cb8  src/engine-holiday.selftest.ts
  d3f11083704b51fc13bc6be93933a094c2e0abd0310da6f87021e3df4a8d92a1  src/price-guard.selftest.ts
  4a577bb23225aa54881c783ffe7bd41b1e115179a2f8b62044af21b70b07dc04  src/llm.selftest.ts
  f371ea7e93fd75bd0c3054b36276cb55476672b3462576edf8dfc3fd6c5f9f61  src/server.selftest.ts
  d37341de95e87956b643dfd6ef5aee28011e39a7ce5391148e0157f9800c7882  src/adapters/wecom.selftest.ts
  aa8f00693fa63182361d4a03e2020ad1743000d7e15167bca8c0451f49b7ea91  eval/cases.json
  ```

- 四个门禁在开工提交上全绿（mock eval 19/19，跳过 32 条 realOnly）。`PREFIX sha256 system=6c202d633b603a0b391634bcaf75da9d3ed42c30f848ad092a2467f713d9a423 tools=64c16fc8f464d5757f02411b7f8a2a6ce6f43da63416283851a6e997819692d1`：第 2–14 步每步结束时都要等于它。

**文档收尾**

- 01 spec、后台 UX spec 顶部各加一行 `Amended by: 02`；后台 UX plan「Open」交接卡措辞那一条标「已由 02 spec 解决（R12）」。
- 总参考：「本阶段 spec 必须处理的点」里 identity map 一条、「开放问题」里自测存储一条标「已由 02 spec 定」。plan 写的第三条「`rerender`」总参考里没有：它是 01 开放问题 6，由 02 R21 定，01 已 implemented、正文不动。另把开放问题里同样已由 02 定的三条（`channel_inbox`、SSE 之外的推送通道、demo 下重置的底线）一并标上。

**盘点**

行号按开工提交。每类由一个只读 agent 盘点、另一个 agent 换办法复核找漏找错，下面是合并之后的结果；「注意」是后面的步骤要照着做的。

1. 对 `session.messages` 的非 push 写：6 处，正好是 spec 的五类，没有别的写入点。
   - 重置 `engine.ts:3275`（`messages = []`），订单真删 `engine.ts:3278` → 第 3、5 步。
   - 裁剪 `engine.ts:3298`，另有 `adapters/wecom.ts:810`（非文本占位不经引擎，自带同样的 400→300，spec 没点名）→ 第 5 步；等价套件单独覆盖 810。
   - 转人工备注 `engine.ts:3398`（经 3395 的别名 `rec` 改 `tools.ts:1249` 写入的 system 消息）→ 第 3 步。db 存储下这一行会抛 `TypeError`：真实模型路径被 `llm.ts:792–796` 吞成工具错误（转人工已生效、备注缺失），mock 路径（`llm.ts:974`）整轮失败。
   - 企微重放对齐 `adapters/wecom.ts:771`（`splice` 删已记的客户原话）→ 第 3、12 步。
   - 保鲜 `store.ts:188–195`（会话时间、消息 `m.at += delta`、订单 `createdAt` / `paidAt`）→ 照旧，前提是 demo 类不进 PG、不冻结。plan 给的 grep 漏了 `+=`，第 7 步复查改用 `\.(content|at|role|msgid)\s*(\+|-)?=[^=]`；zsh 下 `--include` 要加引号。
   - 注意（第 2 步）：`assignSeqs` 的字面规则（已有 seq 的严格递增、排在没 seq 的前面）查不出中间删除（`[1,2,4]` 仍递增）与尾部删除，验收 5 却要求查出中间删除，所以还要校验「带 seq 的相邻差 1，最后一条等于已分配的最大 seq」。整体换成副本（`map` 出新对象）在 WeakMap 里查不到 seq，看起来和重置（`messages = []`）一样；要分清就得让重置路径显式告诉 store（推进窗口的调用），否则只能靠等价套件查。第 2 步定下做法记进本记录。
   - 注意（第 3 步）：改成 `alreadyRecorded` 之后，这句客户原话留在原位、`at` 是原值；今天是删掉再 push 到欢迎语之后、拿新的 `at`。锁定的 W1 只数条数（`wecom.selftest.ts:738–762` 是中间删除、660–681 是尾部删除，文件存储宽松模式下照旧通过），但 spec 说的「内存里的结果与今天逐字节相同」在这一处不成立。
   - 注意（第 7 步）：锁定的 `server.selftest.ts:835` 原地改非种子会话消息的 `at`，db 存储下会抛 `TypeError`；锁定套件钉文件存储所以不受影响，等价套件与 DB 模式 eval 不能照搬这种写法。

2. 写死的 `'paid'`：
   - 阶段判断，第 3 步改看行业包终态（旅游包下等价）：`engine.ts:72`（`deriveStage`，锁定 `engine.selftest:2500`、`2522` 钉住）、`1568`、`3510`（两处）；`followup.ts:72` 归第 10 步（资格「非终态」）；`server.ts:379–382` 旧 `/resume` 归第 13 步 `release`：订单读法留作「`stage=handoff` 而订单已付」的兜底（`scripts/seed-demo.py:156` 的 A01 就是这种形状），写入的 `'paid'` 改取终态 key。
   - 阶段写入保留：`engine.ts:3895` `notifyPaid`（锁定 `engine.selftest:191`、`2518`，`server.selftest:1253`）。多终态的包写哪个，本阶段只有旅游包，不处理。
   - 订单状态 `OrderStatus`，不改：`engine.ts:1868`、`1911`，`insight.ts:22`，`server.ts:464`，`store.ts:223`、`336`，`admin.html` / `chat.html` / `pay.html` 的订单标签。
   - 状态名 `paid`（会话状态，不是阶段），第 3 步补第四态 `assigned`：`shared/console-api.ts:85`、`console-api/app.ts:465`（counts 初值）、`scripts/check-console-src.ts:70`、`console/src/conversations/model.ts:34`（`TAB_RANK`）、`console/src/conversations-search.ts:8`、`console/src/parts/Status.tsx:6` 与 `STATUS_LABEL`（不补 typecheck 不过）；`shared/conversation.ts:19` 扩成四态。
   - 不改：表的键（`engine.ts:49`、`insight.ts:15`、`143`，`types.ts:15`，`console-pack.ts:335`）；`admin.html` 的阶段表与 701 的 `isDone`（R11）。

3. 进入转人工与改 `handedOver`：现有 5 处 `enterHandoff` 调用正好是 spec 的五条入口。
   - 定义 `tools.ts:1039–1042`：1042 写死 `stage='handoff'`，第 3 步终态保留；锁定 `engine.selftest:644`（E1）钉住非终态仍是 `handoff`。
   - `request` / `complaint` / `refund`：`engine.ts:3324`。kind 现在是 `handoffReply` 的内部变量（1897–1901），第 3 步抽出来在 `enterHandoff` 之前算；quote 取本轮原话，departNote 可直接算。
   - `model`：`tools.ts:1243`；reason 在 1244–1246 截 200，记录要 ≤120；mock 的 `llm.ts:974` 也走这里。
   - `promise`：`engine.ts:3701`。同一轮模型已调过 `handoff_to_human` 时保留第一次的 `model` 记录，计数不加。
   - `claimed`：`engine.ts:3735`。模型没给 reason，用 3739 现有的固定说明「回复里答应了转接顾问（引擎补记）」。
   - `agent`：`server.ts:361` 旧 `/handoff`。reason「共享工作台转人工」，不设接手人；第 3 步接 `legacy_admin_writes`。
   - 强制改回 `handoff`：`engine.ts:3307`（客户再发消息）、`3493`（模型返回后看到 `handedOver`），第 3 步都跳过终态。`AgentReply.stage` 的字面量 3309、3328、3502：非终态照旧 `'handoff'`（锁定 `engine.selftest:196`、`199`、`680`、`1908`），终态会话 spec 没写，按 `session.stage` 返回。
   - 清标记：`engine.ts:3280–3282` 重置，另清 `handoff`、`assignee`、`turnSignals`、`negativeHits`（plan 第 3 步的「重置清掉接手人与计数」指这两个计数；`handoffCount` 不清）；`server.ts:372–385` 旧 `/resume`，第 3 步接开关、第 13 步改调 `release`；旧 `/reply` `server.ts:403` 同样。
   - 其余：`store.ts:336` `markOrderPaid` 写 `handoffBeforePaid`（第 3 步）；`engine.ts:3500`「顾问已接管会话，AI 本轮生成的回复未发送」与 spec 的「本轮未发送（顾问已接手）」在第 13 步统一；`insight.ts:26` 按当前标记算转人工成交额，归 03；`admin.html:1048` 的交还在第 13 步之后遇成员接手会收到 409，弹的是「服务端未响应」（R11 不改 `admin.html`，只记一笔）。

4. 发送（第 12 步）：
   - send_msg 请求点只有 `adapters/wecom.ts:607`（文本：602 按 2000 字节分段，604 每段至多 3 次，`callApi` 换 token 时再发一次）与 `452`（卡片，不重试）；`send_msg_on_event` 在 `637`，调用点 `726` 没有 uid，要把 718 算好的 uid 传进去。
   - 调用：`737` 老客户补发欢迎（`welcome`）、`820` 非文本引导、`845` AI 回复（含 836 的重放）、`864` 异常道歉、`584`/`589`/`591`/`595` 在 `sendRich` 里、`1122` push → `sendRich`。push 的实现：`wecom.ts:1113`、`simulator.ts:26`、`server.ts:59`（兜底，可不改）；接口 `types.ts:157`。push 的调用：`server.ts:412` 旧 `/reply`（`human`）、`470` 付款确认（`notice`）、`791` 跟进（`followup`，`followup.ts:194`）。
   - spec 没点名 kind 的：820 与 864 记 `ai`，595（卡片失败后补发的文本）记 `card`。发送时手上没有 `ChatMessage` 的：845（`AgentReply` 只有 text，重放只拿 content）、470（`notifyPaid` 只返回 text）、820 与跟进（发成功才写进会话），第 12 步把消息对象带出来。
   - 注意（会碰锁定断言）：一、`wecom.ts:1128` 的 `resetForTest` 只清适配器内存，卡死没出结果的分段不能算 `accepted` / `unknown`，否则 W1「停机超时」（`wecom.selftest:638–657`）与「队头」（704–731）变红；二、819 判断「引导提示发过没有」保留会话检查，账本只作补充（925–928）；三、`msg_send_fail` 在 958 处单独拦下，放在 `markHandled` 之后或让 `onSendFail` 幂等；只放宽 958 的过滤，它会进在途表、被当成非文本客户消息，给客户发一条引导（888）。
   - 注意（其余）：取 access_token 失败（`wecom.ts:75`，`callApi` 的 90、100 行）时 send_msg 根本没发，不算 `unknown`；625 是分段最终失败的汇合点，`settle` 与第 17 步的 `wecom_send` 告警挂在这里；按 msgid 判「后面有没有 AI 回复」要跳过 742 写进会话的欢迎语；跟进的额度检查放在重判之后、记账之前，额度不够不算失败；`engine.ts:3824` 是 AI 回复写进会话处，第 12 步在它之前去掉开头的「【顾问】」，第 13 步在它之前比较接手代次（`takeoverGen` 第 13 步才建，第 12 步先接桩）。
   - 状态层照旧（R7）：cursor `wecom.ts:110`、`162`、`945`、`971`；`handled` `112`、`197`、`221`、`959`；在途表 `965`、`899`；冷启动 `960`；重放 `995`、`1008`；落盘 `974`。

5. 截断：全部是按 UTF-16 码元的 `.slice(0, N)`；src 里没有任何去掉 U+0000 的代码，只有拒绝型的 `storableText`。
   - 第 3 步换 `cleanText`：入口 `engine.ts:3264` 与重放对齐 `adapters/wecom.ts:765`（必须是同一个调用）；`tools.ts:1246` reason；`engine.ts:2348` departNote 里的原话（40）；`engine.ts:3730`、`3830`、`3838` system 消息（60）；`engine.ts:509` 确定性推荐里的亮点（42）；工具结果与参数里的客户原话（第 9 步进 trace）`engine.ts:2972`、`3034`、`3133`、`2579`，`price-rules.ts:82`。可选：`tools.ts:629`、`types.ts:55`。
   - 没截断、进库前也要清洗：`server.ts:407` 旧 `/reply`（第 13 步 `cleanText` 1–2000）；`wecom.ts:664` 昵称、`engine.ts:247` `destinationInterest`（`normalizeForStore` 兜住）；AI 回复全文（`engine.ts:3824`）与跟进话术（`followup.ts:97`、`215`）不去 NUL，模型输出带 NUL 会让会话 poisoned：第 3 步在 push 之前过 `cleanText`（不截长度），或第 5 步在消息行投影里清洗，二选一并记进实施记录。
   - spec 长度对不上现状：`HandoffRecord.reason` ≤120（现截 200），`quote` ≤200（现在没有这一截）。
   - 不用改：`engine.ts:441`、`wecom.ts:320` 的分段（已防切开代理对）、`wecom.ts:456` 卡片、`server.ts:573`、`llm.ts:286`，以及各处数组截取。`engine.ts:666` 的 U+0001–U+0003 链接记号发出前已抹掉，第 9 步 `noteGuard` 的前后文可能带着它们。

6. 日志里的客户原话（第 16 步改经 `logQuote`，传原文而不是截过的串；`logQuote` 在第 17 步的 `src/log.ts` 里，第 16 步先把函数建出来）：
   - 19 处：`adapters/wecom.ts:830`；`engine.ts:414`、`1052`、`1537`、`1546`、`3156`（tags 那一段）、`3157`、`3381`、`3533`、`3691`、`3717`、`3723`、`3734`、`3756`（两段）、`3770`、`3787`、`3799`、`3805`；`followup.ts:219`。
   - 打会话原 id 的 33 处（第 17 步，不变量 48）：`engine.ts:178`、`188`、`414`、`1537`、`1546`、`3156`、`3157`、`3381`、`3533`、`3691`、`3717`、`3723`、`3734`、`3756`、`3770`、`3787`、`3799`、`3805`、`3844`、`3881`；`llm.ts:671`、`743`；`followup.ts:170`、`177`、`197`、`209`、`219`、`221`；`wecom.ts:849`、`999`、`1117`；`server.ts:60`、`704`（请求路径里的 id）。其中 3 处被锁定断言钉住原 id：`llm.ts:743`（`llm.selftest:734–736`）、`server.ts:60`（`server.selftest:705–706`）、`wecom.ts:1117`（`server.selftest:745–748`），所以第 17 步按 profile 处理：prod 写 ref 或短码，demo 原样，与 `logQuote` 同一口径。`wecom.ts:849` 在引擎轮次结束之后，上下文要包在 `handleCustomerMessage`（781）上。
   - 未验证、第 16、17 步复核：`store.ts:40`、`42`，`wecom.ts:175`、`177`，`usage.ts:93` 把 `JSON.parse` 的错误整个打出来，片段里可能带原话或会话 id，改成只打 `e.name` 与位置；`llm.ts:286` 的 `LlmHttpError` 带上游响应体前 300 字，`llm.ts:432`、`452`、`520`，`wecom.ts:863`，`server.ts:704` 打它。

7. 匿名可读、直接返回 store 原对象的旧接口（第 3 步改投影，只拷贝，不改 identity map 里的活对象）：
   - `GET /api/sessions` 的匿名分支 `server.ts:348`（346 带 `ADMIN_PASS` 照旧）、`GET /api/sessions/:id` `server.ts:354`（handler 不分匿名与管理员）：去掉 `assignee.userId`、消息的 `authorId`，姓名写「顾问」。
   - `GET /api/orders` 的匿名分支 `server.ts:434`：去掉 `confirmedBy`、`paidMarkedBy`、`cancelReason`。
   - `GET /api/orders/:id` `server.ts:441`：R22 白名单，带不带凭据一律投影；`confirmed` 取布尔（`confirmedAt` 有值），公开投影里不能有成员姓名。`pay.html:417`、`chat.html:531` 与 `/pay/:orderId` 的服务端注入用到的字段都在白名单里。
   - `POST /api/orders/:id/pay` 的响应体 `server.ts:462`、`483` 也带订单原对象（demo 下匿名可调），spec 没覆盖，见「Open」。
   - 成员身份的来源不只种子订单：`sim-` 访客订单也能被成员确认、取消，自测两类都要覆盖。
   - 旧接口只认 `ADMIN_PASS`（`isAdminReq`），不认 console 的 cookie：成员在旧接口上拿到的是投影，比 spec「成员登录的请求照旧返回原对象」更严，按 `isAdminReq` 判，不另加 cookie 查询。
   - console-api 在 demo 下的匿名分支（`/pack`、`/status`、`/sop`、`/catalog`）都是投影，不用改。
   - `chat.html:645–647` 恢复历史直接渲染 content，人工回复不带「【顾问】」，与实时推送不一致，第 12 或 13 步处理。

8. 锁定套件与 `eval/cases.json` 里含词表词的客户原话，逐句现在的期望（其余 18 个词在客户原话里零命中）：
   - `engine.selftest.ts:1226` p2b「先不用了」：模型调一次，回复等于模型原文、不补方案书链接，不转人工。
   - `engine.selftest.ts:2652` U7③「我们一家人想出去玩，我和老公，两个孩子，还有我婆婆72岁，孩子想看熊猫，婆婆也怕高反」：模型两步（脚本恰好用完），不转人工。
   - `engine.selftest.ts:2662` U7「我们俩度蜜月 听说高反挺吓人的 想去云南」：预取云南、模型一步，不转人工。
   - `engine.selftest.ts:4189` Y5「算了 听说高反挺吓人的 换云南吧」：模型一步，编价与高反担保被删，不转人工。
   - `engine.selftest.ts:420` planPrefetch，同一句：纯函数返回 `[{ destination: '云南' }]`。
   - `engine.selftest.ts:3618` W12「九寨海拔高吗 我妈怕高反」：纯函数不预取。
   - `engine.selftest.ts:3156` R3「另外，孩子要带护照吗」：纯正则，不算另一张单。
   - `dejargon.selftest.ts:565`「海拔三千米会不会高反」：`BUDGET_RE` 不匹配。
   - `eval/cases.json:699` retrieval-03「我们一家人，我和老公带两个孩子，还有婆婆72岁也怕高反，孩子想去成都看熊猫」（realOnly）：不转人工、调 `search_routes`、回复含 3,5xx 米的海拔。
   - `eval/cases.json:785` retrieval-05 第 2 轮「算了 听说高反挺吓人的 换云南吧」（realOnly）：本轮有 `search_routes`。
   - 注意（第 11 步）：`fakeSay`（`engine.selftest:610`）要求脚本恰好用完，任何「本轮不调模型」的规则误命中上面几句都会变红；两条 eval 只在第 15 步的真实模型回归里跑。向量表把以上 10 句都放进「不触发」（「怕高反」「听说高反」是出行前的顾虑，主定义要求此刻有症状），另加「支付链接找不到了」（`engine.selftest:3246`、`3544`，`dejargon.selftest:267`：证件丢失别写成宽松的「找不到」）与「先交钱然后人跑了咋整」（`cases.json:518`：被困走失别把「人跑了」算进去）。
   - 注意（第 11.1 步）：「你们这个是骗人的吧」（`cases.json:218` 的小句，现按打消疑虑处理）、「你们靠谱吗，不会是骗人的吧」（`cases.json:233`，mock 也跑，期望 discovery、不道歉不转接）：负面情绪要收「骗人」，就照 `DOUBT_CLAUSE` 排除疑问小句；不与 `isComplaint` 已命中的（`engine.selftest:195`、`679`、`1945`，`dejargon.selftest:384–424`）重复计数。
   - 注意（第 10 步）：拒绝识别别按子串收「不用」「算了」：「先不用发方案了，我再想想」（`engine.selftest:1225`）、「不用再看看了，就订这个」（`engine.selftest:3571`，W9 纯函数的反例）、「不用倒时差」（`engine.selftest:2091`、`4205`，`cases.json:40`、`128`）、「算了 就这个吧 订」（`cases.json:809`）、「别的不考虑」（`engine.selftest:385` 等）。
   - 注意（第 16 步）：撤回同意类的词零命中；同意菜单只在发布过隐私说明后启用，DB 模式 mock eval 的 `installSeededConfig` 不能顺手发布隐私说明。

### 第 2 步 · store 门面、停机与启动顺序（2026-10-02）

- 结构：`src/store.ts` 仍持有两张 Map，落盘搬进 `src/store/file-backend.ts`（读 JSON、损坏改名、探针、200ms 去抖、原子写、`exit` 时同步写出，内容与时机照旧）；`src/store/backend.ts` 是 `StoreBackend`、`StoreHealth`，以及 `SessionStoreStartupError`、`StoreLaggingError`（放这里而不是 store.ts：`boot.ts` 要认它们，又不该带上 store 的导入期副作用；store.ts 再导出）；`src/store/events.ts` 是 `DomainEvent` 与提交后的总线；`src/store/seq.ts` 是 seq 分配。门面按会话 id 选后端：装了 PG 后端（第 5 步）时真实会话走 PG，demo 类与文件存储走文件。
- 与 spec 写法不同、记在这里的取舍：
  - `sessionStoreMode()` 返回当前装着的后端（装上 PG 后端之后才是 `db`），不直接读 `SESSION_STORE`：第 5、7 步的自测要在 `selftest-env.ts` 钉着 `file` 的进程里显式装上 PG 存储，读环境变量就会在那里报错的模式。`SESSION_STORE` 的取值只在两处读：`initConfigFromEnv` 校验，`server.ts` 的 `boot` 接线据此给 `initSessionStore` 传依赖或 `null`。
  - `assignSeqs(session, mode)` 多一个 `'strict' | 'lenient'`（默认 strict），由后端选：文件后端一律 lenient，第 5 步的 PG 后端对真实会话用 strict。strict 按「实施记录 · 第 1 步」第 1 类的注意写：已有 seq 的必须是数组开头连续的一段、逐条加 1、最后一条等于分配过的最大 seq、第一条不早于上次的窗口起点；窗口里原有的消息全没了，只有先调过 `noteWindowReset(session)` 才算重置，否则当整体换成副本。引擎的重置路径在第 5 步接上 `noteWindowReset`（文件存储下不需要）。
  - `StoreBackend` 多一个 `emitAfterCommit(sessionId, ev)`：事件要排在那个后端的下一次提交上。
  - `initSessionStore(deps)` 在第 5 步之前直接拒绝启动（普通 `Error`，不借用 spec 的拒绝原因），不回落到文件存储。
  - 停机钩子收到 `{ deadline }`（这一段的截止时刻），drain 段的钩子按它算剩余预算；`runShutdownHooks(timeoutMs)` 按 6 : 1.5 : 0.5 分给三段，normal 从开始算、后两段从上一段结束时算，所以锁定自测里的 `runShutdownHooks(200)` / `(3000)` 照旧。日志前缀由 `[store]` 改成 `[shutdown]`（没有自测截这几行）。
  - `src/shared/conversation-types.ts` 提前建出，先放 `DomainEvent` 要的 `HandoffKind`、`MessageAuthor`、`OrderStatus`，第 3 步补其余。
- 文件后端的写库健康：`dirty` 与 `lagMs` 按「有没落盘改动的会话」算，落盘失败时 `lastError` 记 errno 码（如 `EISDIR`）；事件与 `flushSession` 的等待只在落盘成功之后放行，失败时留到下一次成功（不自动重试，与开工时相同：下一次改动才再落盘）；`exit` 时上次落盘失败留下的改动也再写一次。
- `/healthz`：加 `store: { mode, dirty, lagMs, conflict, poisoned }`（`poisoned` 是个数）；`ok` 在冲突、有 poisoned、积压超过 120 秒或租户锁是 `lost` 时为 false，HTTP 照旧 200。
- `scripts/check-boundaries.ts` 加两条：`src/store/project.ts`、`seq.ts`、`src/handoff/triggers.ts` 是纯函数；`src/db/`、`src/config/`、`src/cli/` 不 import `src/store/`（`project.ts` 除外）。
- 新自测 `src/store/store.selftest.ts` 串在 `server.selftest.ts` 之后。锁定套件全绿、断言零修改；`PREFIX sha256` 与第 1 步相同。
- 审查（四路，每路的发现另由一个 agent 反驳核实）之后改的：db 存储下孤儿订单（所属会话不在内存里）也归文件后端落盘，不再被过滤掉；`assignSeqs` / `seedSeqs` 跳过畸形的旧数据（没有 messages、数组里有 null），与开工时「碰到才出错、不在导入期崩」一致；drain、late 两段的截止不超过总上限（normal 的计时器因事件循环阻塞晚触发时不顺延）；自测补上落盘失败时事件确实没发、flush 的超时、积压按最早一次改动算、drain 的失败路径、宽松模式的中间插入、exit 时同步写出（含上次落盘失败后再写一次）、真实 `server.ts` 遇标记文件拒绝启动、导入期不发起网络连接与保鲜清理照常、`/healthz` 在锁 `lost` 时 `ok` 为 false（在 `config.selftest.ts` 的锁状态机里）。文件存储下 `storeEvents` 的 `change` 照旧不论落盘成败都发（R3），改成「提交后发」归第 13 步。
- 在隔离副本里重放审查者报的 14 个变异（落盘失败也发事件、三段都从开始算、去掉总上限、宽松模式从第一条没 seq 的起分配、flush 忽略超时、积压按最近一次改动算、server 不调 initSessionStore、drain 一律报空、exit 只在有定时器时写、导入期在 db 下连网或跳过保鲜、SESSION_STORE 只在非 DB 配置时校验、seq 不防畸形数据、去掉孤儿订单归属），`store.selftest.ts` 杀掉 13 个；剩下的孤儿订单归属要到第 5 步装上 PG 后端才测得到（见下）。
- 注意（第 5 步）：
  - 严格模式抛 `WindowCorruptError` 之后不改状态；PG 后端捕获后把会话标成 poisoned，之后对这个会话改用 `assignSeqs(s, 'lenient')`，新消息照样有 seq，spill 才写得出「未提交的消息连同 seq」。
  - 引擎的重置路径在 `messages = []` 之前调 `noteWindowReset(session)`（经 store 再导出）。
  - seq 的状态以会话对象为键：`saveSession` 收到与 identity map 里不是同一个对象的同 id 会话时，PG 后端要拒绝或迁移状态（不变量 3），否则宽松模式会编出重复的 seq。
  - 孤儿订单的归属：有了 `!sessions.has(o.sessionId)` 这一条，之后同 id 的真实会话又建出来时，这张订单要转归 PG 后端；补「db 存储下落盘之后孤儿订单仍在 orders.json」的用例。
  - `installPgSessionStore()` 写在 `src/db/testing.ts` 会撞上依赖规则（`src/db/` 不 import `store` 与 `src/store/**`）：让它只建 PGlite 库与租户、返回 `SessionStoreDeps`，由调用方 `initSessionStore(deps)`；或者放到 `src/store/testing.ts`。不为它在规则里开例外。
- 注意（第 6 步）：命令行不能 import `store.ts`（01 的配置层规则），`isDemoClassId` 与标记文件名要搬到纯模块（`project.ts`）再由 store.ts 再导出，不要在 CLI 里抄一份正则。
- 验收 1 的 `.env` 一项：在仓库副本里写 `SESSION_STORE=db`、`CONFIG_SOURCE=db`、`DATABASE_URL`（指向不存在的库）、`DEFAULT_TENANT_SLUG` 再跑 `pnpm test`，退出码 0，PASS 行数与工作区相同（58 行），`PREFIX sha256` 相同。

## 验收记录

（对照验收标准逐条验证时填写：编号 · 通过 / 未通过 · 证据）

## Open

（与 spec 的分歧、需要 owner 裁决的事；开放问题的答复也记在这里）

- 开放问题的答复（owner 2026-10-02，已写进 spec 各条与顶部 `Revisions:`）：1 选 A「部分取代」，规则进了 `docs/spec-driven-dev.md` 与 AGENTS.md，01 与 UX spec 顶部已加 `Superseded in part by:`；2 线索 180、客户 730、trace 90 天，按租户可改；3 企微群机器人，与告警不同群；4 词表加规则；5 `channel_inbox` 留在 04、做三条缓解；6 选 A；7 照推荐做，PIA 出结论后复核；8 保守口径；9 02 不做改价；10 固定的回归步骤，不做发布闸；11 仓库外事项全部完成才接第一个真实租户；12 选 A；13 以后在另一台境内机器上自建 Langfuse，02 只埋点；14 国内云厂商的拨测。
- 第 1 步盘点带出、要 owner 定的三处（都不挡第 2 步）：
  - **交还消息里的顾问姓名会经匿名旧接口漏出**（第 3 步写投影之前定）。spec「接手、人工回复与交还」规定交还时记一条 system 消息「{姓名}把会话交还 AI」；种子会话既能被成员接手、又对匿名可读，「后台接口」规定的匿名投影只去掉 `assignee.userId` 与消息的 `authorId`、`authorName`，管不到正文，`admin.html:939` 会原样显示它，与不变量 44（匿名响应里没有成员姓名）冲突。推荐：匿名投影把 `release()` 按固定模板生成的这条改写成「顾问把会话交还 AI」（模板由同一个常量产生，确定性可测）。备选：正文本身就写「顾问把会话交还 AI」，姓名只在 J 页由结构化记录显示（spec 的那句文案要改）。
  - **`POST /api/orders/:id/pay` 的响应体**（第 3 步）。409 与 200 两个分支（`server.ts:462`、`483`）都带订单原对象，demo 下匿名可调；02 之后会带出 `confirmedBy`、`paidMarkedBy`、`cancelReason`。R22 只管 `GET /api/orders/:id`。推荐：改用同一个 R22 白名单投影（`pay.html` 只看状态码与 `res.ok`，锁定断言不读响应体）。
  - **advisor 模式下支付页从哪儿知道收款方式**（第 15 步之前定）。R22 白名单里没有收款方式，`confirmed=false` 分不清「online 待付款」与「advisor 待确认」；`/pay/:orderId` 能由服务端注入，`/pay.html?orderId=` 这条静态兜底（`pay.html:314`，`server.ts:698`）注入不到。推荐：`/pay.html?orderId=` 跳到 `/pay/:id`，页面只靠服务端注入。备选：白名单加 `paymentMode`（改 R22；锁定断言只看 `id`，不受影响）。

## 交接记录

<!-- 每次停下时按日期追加，格式（本注释保留给后来的 agent）：
## 交接（YYYY-MM-DD）
- 已完成：
- 半成品：第 K 步做到 …，代码停在 …（能否 build）
- 阻塞：
- 下一步：
-->

### 交接（2026-10-02）

- 已完成：spec 与 plan 定稿；owner 当天答完 14 个开放问题（全部照推荐，Q1 选 A：「部分取代」规则已写进 AGENTS.md 与 docs/spec-driven-dev.md），并把 spec 翻成 `ready`。
- 半成品：无，还没写任何代码。
- 阻塞：无。plan 不再等任何答复；接第一个真实租户之前的仓库外事项在「上线清单」里，不挡开发。
- 下一步：新会话从第 1 步「开工核对」开始。线上仍是 `demo-v2`，后台 UX 改造只在 `dev`、owner 定先不发版；02 的第 27 步「demo 线上切换」由 owner 执行。

### 交接（2026-10-02，第 1 步）

- 已完成：第 1 步。基准哈希、前缀哈希、八类盘点记在「实施记录 · 第 1 步」；01、UX spec 的 `Amended by:` 与总参考的标注已加。
- 半成品：无。
- 阻塞：无。「Open」里新增三处待 owner 定，最早的一处在第 3 步写匿名投影之前要答复。
- 下一步：第 2 步「store 门面、停机与启动顺序」。先读「实施记录 · 第 1 步」第 1 类的「注意（第 2 步）」：`assignSeqs` 要校验连续，重置要显式告诉 store。

### 交接（2026-10-02，第 2 步）

- 已完成：第 2 步。store 门面与文件后端、三段停机、`SESSION_STORE` 校验、boot 多一步、`/healthz` 的 `store` 与 `ok`、`store.selftest.ts`（110 项）。锁定套件零修改，`PREFIX sha256` 与第 1 步相同。
- 半成品：无。
- 阻塞：无。「Open」里第 1 步带出的三处仍待 owner 定，最早的一处（交还消息里的顾问姓名）在第 3 步写匿名投影之前要答复；没答复就先按推荐做，投影函数留好改写的位置。
- 下一步：第 3 步「与存储无关的引擎与类型改动」。先读「实施记录 · 第 1 步」第 2、3、5、7 类与「Open」。
