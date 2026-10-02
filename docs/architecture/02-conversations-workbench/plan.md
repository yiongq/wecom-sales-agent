# 02 · 会话入库 + 坐席工作台 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。每步一个 PR 进 `dev`，CI 绿了再合；界面改动在 PR 里写 BEFORE / AFTER；新依赖钉精确版本；新自测与检查脚本必须串进 `test` 或 `lint`。括号里是工程日估算，合计约 70 个工程日。

开工须知（新会话从这里开始）：

- spec 的 `Status` 必须是 `ready` 才能开工；还是 `draft` 就停下，告诉 owner 等他翻。
- 先读：`AGENTS.md`；本目录 `spec.md` 全文；01 spec 的「两种模式与启动装载」「withTenant」「迁移纪律」「RLS、授权与认证函数」「测试与 CI」；后台 UX spec 的「外壳」「总览」「会话列表」「会话工作台」「依赖 02 的后端」；`docs/features/console-ux/design-system.md` 的 §5.6、§6.7、§10.0 与 A2、I、J 三页。然后 `git log -5`，再读本文件的「交接记录」与「Open」。
- **锁定套件**（断言一条不许改）：`src/engine.selftest.ts`、`src/dejargon.selftest.ts`、`src/engine-holiday.selftest.ts`、`src/price-guard.selftest.ts`、`src/llm.selftest.ts`、`src/server.selftest.ts`、`src/adapters/wecom.selftest.ts`，以及 `eval/cases.json`。任何一步让它们变红，都先找自己的改动；确认是 spec 与锁定断言冲突时，停下写进「Open」，不改断言。要改的非锁定断言只限 spec「测试与 CI」最后一条列的那些，PR 里写明理由。
- 前缀：除第 15 步的 SOP 改动外，每一步结束时 `engine.selftest.ts` 打印的 `PREFIX sha256` 都要等于第 1 步记下的值；第 15 步之后等于第 15 步记下的新值。
- spec 的 14 个开放问题 owner 已在 2026-10-02 全部定下（答复见本文件「Open」），不阻塞任何步骤；各步照 spec 里写定的结论做。
- 原地变异测试在隔离副本里跑（Stop 钩子会对工作区跑门禁）；复现卡死的脚本用单进程加超时，收尾查 `ps`，不留孤儿进程。

- [ ] 1. 开工核对（0.5）：
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
- [ ] 2. store 门面、停机与启动顺序（2.5）：
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

## 验收记录

（对照验收标准逐条验证时填写：编号 · 通过 / 未通过 · 证据）

## Open

（与 spec 的分歧、需要 owner 裁决的事；开放问题的答复也记在这里）

- 开放问题的答复（owner 2026-10-02，已写进 spec 各条与顶部 `Revisions:`）：1 选 A「部分取代」，规则进了 `docs/spec-driven-dev.md` 与 AGENTS.md，01 与 UX spec 顶部已加 `Superseded in part by:`；2 线索 180、客户 730、trace 90 天，按租户可改；3 企微群机器人，与告警不同群；4 词表加规则；5 `channel_inbox` 留在 04、做三条缓解；6 选 A；7 照推荐做，PIA 出结论后复核；8 保守口径；9 02 不做改价；10 固定的回归步骤，不做发布闸；11 仓库外事项全部完成才接第一个真实租户；12 选 A；13 以后在另一台境内机器上自建 Langfuse，02 只埋点；14 国内云厂商的拨测。

## 交接记录

<!-- 每次停下时按日期追加，格式（本注释保留给后来的 agent）：
## 交接（YYYY-MM-DD）
- 已完成：
- 半成品：第 K 步做到 …，代码停在 …（能否 build）
- 阻塞：
- 下一步：
-->
