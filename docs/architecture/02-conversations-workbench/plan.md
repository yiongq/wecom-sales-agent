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
- [x] 3. 与存储无关的引擎与类型改动（3）：2026-10-02 完成，结构、12 条裁定落成什么样与偏离见「实施记录 · 第 3 步」。
  - `src/shared/conversation-types.ts`（`HandoffKind`、`HandoffRecord`、`Assignee`、`MessageAuthor`、`OrderStatus`、`PaymentMode`、`OutboundKind`、`SendWindow`），`src/types.ts` 等从这里 import 再导出；`src/shared/text.ts` 的 `cleanText`，引擎的入口截断与企微重放对齐里的截断一起换成它。
  - `src/types.ts`：`ChatMessage.sentAt` / `author` / `authorId` / `authorName`；`Session` 与 `Order` 的新字段。
  - `src/handoff/record.ts`：新签名的 `enterHandoff`（`tools.ts` 再导出）；五条入口都带记录；`firstHandoffAt`、`handoffCount`；从未转人工进入时清接手人；终态会话按开放问题 12 的 A 处理（R9）；重置清掉接手人与计数；终态阶段不再被改回 `handoff`；`markOrderPaid` 写 `handoffBeforePaid`。
  - 五处非追加写里与存储无关的两处：转人工备注在工具执行前拼好；企微重放改传 `{ alreadyRecorded: true }`（有 msgid 按 msgid，旧数据按文本）。`handleMessage` 多可选的 `opts`，企微文本消息带上 `msgid` 与 `sentAt`。
  - `src/shared/conversation.ts`：四态的 `conversationState`（结构类型参数）、`paidNeedsHuman`、规范化的 `needSummary`；`src/shared/console-api.ts` 的 `CONVERSATION_STATES` 与 `ConversationRow` 新字段；`console.selftest.ts` 的「6 个投影字段」改成新键集合；`scripts/check-console-src.ts` 的状态白名单加 `assigned`；console 里用到 `TAB_RANK`、状态名表的地方先补上第四态（界面还不显示它，第 19 步再画）。
  - `/api/orders/:id` 改为白名单投影（R22）；匿名可读的旧接口改为去掉成员身份的投影；`profile.ts` 加开关 `legacy_admin_writes`（demo 开、prod 封顶关）并接到旧的 handoff、resume、reply 上。
  - 新建 `src/handoff/handoff.selftest.ts`：记录与五个入口、四态判定、终态会话转人工、重置清接手人、`handoffBeforePaid`、公开投影的键集合、匿名投影没有成员身份。
  - 锁定套件全绿、前缀哈希不变。对应验收 12，以及 7、13、16 在文件存储下的部分。
- [x] 4. 迁移：新表、RLS、授权、触发器、清除与删除函数（3.5）：2026-10-02 完成，迁移文件、函数与仓储的取舍、给后面哪一步用、真实 PG 结果见「实施记录 · 第 4 步」。审查之后改了三处（`orders` 触发器管住 `session_id`、清除与删除连带删会话的任务、`backup.sh` 只查库里已有的会话表），补了并发、列级授权与 5 分钟边界的自测，见该节「审查之后改的」；带出「Open」两条。
  - `src/db/schema.ts` 加 spec「数据库」与各节列出的全部表、`tenants` 三列、`catalog_items.version`；drizzle-kit 生成；custom 迁移写 RLS 模板、授权（spec 的授权表）、两个触发器、`orders` 带列清单的外键、四个清除与删除函数、`catalog_item_versions` 的按租户回填。
  - `scripts/check-migrations.ts` 通过（`tenants` 三列标 `-- migration-allow: add-check` 和原因）。
  - `src/db/client.ts`：`withTenant` 的 `longRunning` 选项、`inTenantTx()`；`src/db/repo/audit.ts` 加 `writeAuditAs`。
  - `src/db/repo/` 加 conversations、messages、orders、catalog-versions、traces、usage、jobs、outbound、quick-replies、consents、privacy、metrics 的仓储函数（只收发领域类型）。
  - `src/db/db.selftest.ts`：「七张表」的断言与权限期望表扩到新表；PGlite 上迁移连跑两遍、CHECK（含 `conversations.id` 拒绝 demo 类、`state.id` 一致）、`jobs` 的 open 唯一、复合外键与 `SET NULL (session_id)`、两个触发器。真实 PG 部分：新表逐格权限、没有 DELETE / TRUNCATE、清除函数拒删未到期数据与「未来的 now」、不在 `withTenant` 里调用报错、`erase_conversation` 只有 platform 能调。
  - `deploy/backup.sh` 的 TABLE DATA 校验加三张表（行数为 0 不告警；审查之后改成表在库里存在时才要求）。
  - 对应验收 5 的权限与清除函数部分，以及不变量 5、6、11。
- [x] 5. PG 后端（5）：2026-10-02 完成，结构、各条取舍与偏离、变异与真实 PG 结果、给第 6、7、9、10、12、13、14、16、17 步的入口与注意见「实施记录 · 第 5 步」。
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

### 第 3 步 · 与存储无关的引擎与类型改动（2026-10-02）

- 结构：
  - 类型：`src/shared/conversation-types.ts` 补 `HandoffRecord`、`Assignee`、`PaymentMode`、`OutboundKind`、`SendWindow`；`src/types.ts` 再导出全部会话契约类型，`Order.status` 改用 `OrderStatus`。`Session.consent` 的键先写成 `'health' | 'minor'`（spec 的 `SensitiveCategory` 定义在第 11、16 步的 `triggers.ts`，到时换成它）。
  - `src/shared/text.ts` 的 `cleanText(s, maxChars?)`：不给上限只清洗不截断（AI 回复全文用）；`toWellFormed()` 是 ES2024，tsconfig 的 lib 停在 ES2023，用类型断言调，不动全局 lib。
  - `src/handoff/record.ts`：`enterHandoff`、固定原因表 `HANDOFF_REASON`、判终态的帮手 `activePack()` / `isTerminalStage()` / `terminalStageKey()`（裁定 9）。`tools.ts` 再导出 `enterHandoff`，engine、server 原有的 import 不变。`terminalStages` 在 `src/shared/conversation.ts`（不在 `pack.ts`），帮手调它。
  - 引擎：`inboundText()`（入口与企微重放对齐共用的那一个调用）、`HandleOpts`；`handoffReply` 里的订单与类型判定抽成 `liveOrderOf` / `safetyNetKind`，措辞不变。`handoff_to_human` 要的本轮原话与出行时间经 `ToolHints.handoff` 在调工具之前传进去。
  - `server.ts`：`legacyWrites` 中间件排在三条旧写接口最前（关时匿名与带凭据都是 404，不先走 401）；`anonMessage` / `anonSession` / `anonOrder` 与 `publicOrder` 四个投影函数，只在这个文件里用。
  - console-api：列表行由 `conversationRow()` 投影，`needVocabulary()` 每次请求现算（产品库 active 线路的 `destination` 去重）；counts 的 `byState` 加 `assigned`。
  - console：`TAB_RANK` 按 spec 的顺序排进 `assigned`，`tabs()` 先把它滤掉（第 19 步再画）；`CONVERSATION_STATE`、`StatusKind`、`STATUS_LABEL` 补第四态，`.status-assigned` 的样式没加（第 19 步）。
  - 开关：`legacy_admin_writes` 排在 `DeployFlags` 最后（`DEMO_DEFAULTS` / `PROD_CEILING` 同序，锁定断言按 JSON 串比较照旧成立）；`profile.ts` 导出 `BASELINE_FLAG_NAMES`（00 的六个），`profile-boot` 只按它打那一行，新开关在 `logStartup` 里另打 `[profile] legacy_admin_writes=on|off`；`.env.example` 加一行。
- 12 条裁定落成什么样：
  1. `claimed` 的原因是 `HANDOFF_REASON.claimed`，即 3739 原来的「回复里答应了转接顾问（引擎补记）」；system 消息从同一个常量拼，逐字不变。
  2. 三处 `AgentReply.stage` 的字面量 `'handoff'`（3309、3328、3502）都改成 `session.stage`：非终态时 `enterHandoff` 已把它改成 `handoff`，锁定断言照旧；终态会话返回 `paid`。
  3. 固定原因：request「客户要找顾问」、complaint「客户投诉」、refund「客户要退款或改订单」、promise「回复里答应了改行程，要顾问重排」、agent「共享工作台转人工」；model 取模型给的原因 `cleanText(…, 120)`，模型没给原因时兜底「AI 判断要请顾问处理」（裁定没写这种情况，补的）。system 消息「AI 已转人工：<reason>」的 reason 照旧截 200（`cleanText(…, 200)`），工具回给模型的 `reason` 也是这一截，与 02 之前相同。自测查固定原因里没有四个禁用词、都 ≤120。
  4. 引擎各入口的 `quote` 是 `cleanText(text, 200)`（`text` 已是 `inboundText` 的结果）；`agent` 没有 quote，也没有 departNote。
  5. `safetyNetKind(session, text)` 在 `enterHandoff` 之前算，`handoffReply(session, text, kind)` 收它；判定与措辞逐字不变。
  6. 不另写判断：`enterHandoff` 已在转人工中只升级 emergency，所以同一轮 model 之后的 promise 自然保留 model 记录、计数不加、不发第二条事件。自测覆盖。
  7. 旧 `/handoff` 已在转人工中直接返回原对象（不调 `enterHandoff`、不刷新 `updatedAt`、不落盘）；否则以 `{ kind: 'agent', reason: '共享工作台转人工' }` 进入，接手人是 `enterHandoff` 写的 `null`。
  8. 旧 `/resume` 多 `delete` 掉 `handoff`、`assignee`；「已付」照旧按订单读，写入的阶段取 `terminalStageKey()`（旅游包是 `paid`）。终态会话转人工后交还，阶段本来就停在终态、不进还原分支，留下的 `stageBeforeHandoff` 与 02 之前一样不清（无害，下一次进入转人工会覆盖）。
  9. `activePack()`：`configMode() === 'db'` 时取 `currentTenant().pack`（DB 模式还没装载完会抛 `ConfigNotReadyError`，与引擎读 SOP 同一口径），否则取注册表里的 `travel`。`engine.ts:72`（`deriveStage`）、`1568`、`3510` 两处、`3307`、`3493` 都改看 `isTerminalStage`；`enterHandoff` 判终态也用它。
  10. `POST /api/orders/:id/pay` 的 200 与 409 两个分支，响应体里的 `order` 都换成 `publicOrder()`（按「Open」的推荐先做，owner 另有决定再改）。
  11. 交还消息的姓名不在本步。`anonSession` 对 `messages` 逐条调 `anonMessage`，第 13 步在 `anonMessage` 里加「{姓名}把会话交还 AI」→「顾问把会话交还 AI」的改写。
  12. `confirmed` 是 `confirmedAt != null`；`paidAt`、`supersededBy` 没有时给 `null`，键集合恒为白名单。旧接口判「带凭据」只认 `isAdminReq`。
- 「实施记录 · 第 1 步」第 5 类的「第 3 步换 cleanText」逐处：`engine.ts:3264` 与 `adapters/wecom.ts:765`（同一个 `inboundText`）、`tools.ts:1246`、`engine.ts:2348`（截没截按码点比，截了才加「…」）、`3730`、`3830`、`3838`、`509`、`2972`、`3034`、`3133`、`2579`、`price-rules.ts:82`，可选的 `tools.ts:629`、`types.ts:55` 一起换了。第 1 步留下的二选一定在本步：引擎 push 进会话的 AI 回复全文（`visible`）、安全网与重发支付链接的回复、`notifyPaid` 的文本在 push 之前过 `cleanText`（不截长度），跟进话术在 `composeFollowUp` 里同样过一遍（第 1 步把它和 AI 回复列在同一条里）。重置与口令被关时的两句固定回复是常量，没包。日志里的 `.slice` 留给第 16 步。
- 两处非追加写：
  - 转人工备注：删掉 `executeTool(...).then` 里对 `rec.content` 的改写；`departNoteForHandoff` 在调工具前算好，工具把 system 消息一次写成整条。reason 为空时照旧不写这条消息（02 之前那时也不会附上出行时间）。
  - 企微重放：`alignSessionForReplay` 返回 `fresh` / `recorded` / `generated` 三种，不再 splice；「是不是这句」在记下的消息带 msgid 时按 msgid 比，没有 msgid 的旧数据按 `inboundText` 后的原文比。`recorded` 时以 `{ alreadyRecorded: true }` 调引擎，引擎不 push、也不做 400→300 的裁剪。第 1 步第 1 类的注意照实成立：这句留在原位、`at` 是原值；中间夹了欢迎语时，引擎只在发给模型的历史里把这句挪到末尾，模型输入与 02 之前逐字相同（审查之后改的，见下面「审查之后改的」第 3 条）。锁定的 W1 照旧通过；五种去重情况在第 12 步按账本重写。
  - 企微文本消息带上 `msgid` 与 `sentAt`（`send_time × 1000`），非文本占位补 `sentAt`。
- 偏离 spec 写法的地方：
  - `needSummary` 的客群词表：行业包里没有「客群 → 短标签」的词汇表；照 spec 的例子写「带爸妈」要把它加进 `IndustryPack.vocabulary`，而「爸」「妈」「娃」不在 UI 优先片里，进了 `console-pack.ts` 就要重切字体（`scripts/check-fonts.ts` 拦）。本步的词表在 `console-api/app.ts` 现拼，短标签就是旅游包五个客群值本身（「贵州银发4人」），第 19 步画列表时定短标签放哪儿、要不要重切字体。`needSummary` 本身按 spec 收词表，换词表不用改它。
  - `needSummary` 的人数「只取数字」写成：数值，或整句就是「4」「4人」「4位」；「2大1小」不取（取第一个数字会写成 2 人）。目的地「命中的第一个」按在原文里出现的位置取，同一位置取长的。
  - 匿名投影里 `assignee` 写成 `{ name: '顾问', at }`（去掉 `userId` 键，不是置 null）；共享工作台的人工回复 `authorName` 也写「顾问」（spec：姓名一律写「顾问」）。
  - 交还与重置用 `delete` 清 `handoff`、`assignee`（02 之前的会话本来就没有这两个键，JSON 不多出 `null`）；进入转人工照 spec 写 `assignee = null`。
  - `handoffBeforePaid`：spec「转人工记录与四种状态」写的是 `session.firstHandoffAt != null`，实现是 `firstHandoffAt != null || handedOver`（审查之后改的）。理由：spec 说新字段旧数据没有、又没写回填，02 之前就转了人工、付款时还在转人工中的会话（种子 F01、A01 与线上旧会话）照字面会记成 false，与不变量 26「等于会话当时是否曾经转过人工」不符；付款时正在转人工中显然转过。只对旧数据起作用：02 之后进入转人工一定写 `firstHandoffAt`。
- 改了的非锁定断言（都在 spec「测试与 CI」最后一条允许的范围里，或是 Amends 写明的接口扩展跟着变）：
  - `console.selftest.ts`：列表行「只有 6 个投影字段」的两条改成新的 10 个键（键的顺序一条、数目一条），「不带消息正文和客户画像」两条不动；counts 的 byState 键集合加 `assigned`、说明改成「四项之和」（UX spec 的 Amends：`ConversationCounts.byState` 新键）；「取值不合规 → 400」里的 `state=assigned` 现在合法，换成 `state=handoff`。
  - `console/src/parts/errors.selftest.ts`：「四种会话状态之外的叫法一个都没有」原来把「顾问处理中」列为禁用词，`STATUS_LABEL` 补了第四态（不补 typecheck 不过，第 1 步第 2 类已记）就必须改：改成断言四种叫法恰是「AI接待中、等人接手、顾问处理中、已成交」，其余四个禁用词照查。plan 把这类改动排在第 19 步，这一条提前到本步；`conversations.selftest.tsx`、`overview.selftest.tsx` 里禁止「顾问处理中」的断言没动，照旧成立（本步界面不画第四态）。
  - 只为类型补字段、没动断言的夹具：`conversations.selftest.tsx`、`overview.selftest.tsx`、`shell.selftest.ts` 的行夹具补四个新键（null），各处 `byState` 夹具补 `assigned: 0`（含 `login.selftest.tsx` 的假接口）。
- 新自测 `src/handoff/handoff.selftest.ts`（90 项，审查之后 102 项，串在 `store.selftest.ts` 之后）：模型用本机假 `/chat/completions` 按脚本回话。在隔离副本里打了 42 个变异（终态改回 handoff 的三处、计数与 firstHandoffAt、清接手人、emergency 升级、重置与交还各清什么、各入口的类型与原话、固定原因、出行时间附不附、两处 cleanText、alreadyRecorded 与 msgid、handoffBeforePaid、白名单多一个键、匿名投影的各个字段与改活对象、开关接不接、prod 封顶、四态与 needSummary），全部杀掉；企微适配器的两个变异（不传 alreadyRecorded、认不出已记的这句）由锁定的 `wecom.selftest.ts` 杀掉。
- 锁定套件 8 个文件的 sha256 与第 1 步相同，断言零修改；`PREFIX sha256` 与第 1 步相同。`pnpm test` 的 PASS 行 59（多了本步的一行），审查之后 60（又多了 `wecom-02.selftest.ts`）。
- 注意（第 5 步）：`enterHandoff` 写的 `assignee = null`、`handoff`、计数，与 `markOrderPaid` 写的 `handoffBeforePaid` 都是对活对象的原地赋值，第 5 步的冻结只冻消息对象，会话与订单的这些字段照旧可改；`emitAfterCommit` 已经排在下一次落盘上，PG 后端接上同一个口子即可。
- 注意（第 5、6 步）：导入与预载不回填 `firstHandoffAt`、`handoffCount`；旧会话付款时的 `handoffBeforePaid` 靠 `markOrderPaid` 的 `|| handedOver` 兜住（上面的偏离）。PG 后端另写标记已付时照同一个判定。
- 注意（第 12 步）：重放对齐现在是「最后一条客户消息是不是这句」，按 msgid 优先；第 12 步的五种去重情况在这个函数上改，`ReplayAlignment` 可以直接扩。
- 注意（第 13 步）：旧 `/handoff` 已在转人工时什么都不改，`/resume` 只多清两样；`takeover` / `release` 接上之后这两条改调状态机。`anonMessage` 是交还消息改写的位置。种子保鲜已经跟着挪 `assignee.at`，接手写进去之后不用再改保鲜。
- 注意（第 15 步）：订单加 `confirmedAt` 时，`freshenDemoData` 要像 `createdAt`、`paidAt` 一样一起挪 `confirmedAt`。
- 注意（第 19 步）：`tabs()` 里滤掉 `assigned` 的那一行要换成「有这种会话或地址里选了它时才出现」；`needSummary` 的短标签见上面的偏离。
- 审查之后改的（2026-10-02）：
  - 代码三处：
    1. 种子保鲜（`store.ts` 的 `freshenDemoData`）：demo 会话的 `handoff.at`、`firstHandoffAt`、`assignee.at` 跟着 `createdAt`、`updatedAt` 与消息的 `at` 一起挪。不挪的话，旧 `/handoff`（demo 下开着）给种子转过人工之后，每保鲜一次 `handoff.at` 就离触发它的那句更远，`firstHandoffAt` 会早于 `createdAt`，第 19、21 步的等待时长越拉越长。`sentAt` 只有真实企微消息带，种子没有，不挪；订单的 `confirmedAt` 留给第 15 步（见上面的注意）。
    2. `markOrderPaid` 的 `handoffBeforePaid` 改成 `firstHandoffAt != null || handedOver`，理由见上面的偏离。
    3. 企微重放「已记下、回复还没生成」而这句后面夹了欢迎语：`engine.ts` 组 history 时，`alreadyRecorded` 为真、本轮这句（过滤 system 之后最后一条客户消息）不在末尾，就把它挪到 history 末尾再交给 `chat()`；`session.messages` 不动，消息仍只追加。原来发给模型的末尾是欢迎语，`buildWire` 把 contextNote 插在欢迎语后面，真实模型可能接着欢迎语往下说、不答客户这句；现在与 02 之前（适配器删掉这句再记到末尾）逐字相同。
  - 补的自测（都在非锁定文件，锁定套件一行没动）：
    - 新文件 `src/adapters/wecom-02.selftest.ts`（6 项，串在 `handoff.selftest.ts` 之后）：照 `wecom.selftest.ts` 的写法搭一份最小的假企微服务端（假 `fetch`、`syncFromCallback`、`__test.resetForTest` 当重启、往盘上的在途表写消息），驱动真正的适配器。断言：文本消息记下的 `msgid` 与原消息相同、`sentAt === send_time * 1000`；非文本占位带 `sentAt`；重放时原文相同、msgid 不同的判成新消息（记下、生成新回复、不重发回上一句的那条），msgid 相同的判成已记下（不重复记、只回一次）。`handoff.selftest.ts` 里原来叫「企微文本消息带上 msgid 与 sentAt」的那条是直接调引擎，改了名字，不再说成适配器。
    - `handoff.selftest.ts`（90 → 102 项）：保鲜之后 `handoff.at` 与触发它的客户消息间隔不变、`firstHandoffAt` 不早于 `createdAt`、`assignee.at` 一起挪；旧形状（`handedOver`、没有 `firstHandoffAt`）付款后 `handoffBeforePaid` 为 true（从没转过的为 false 原来就有）；重放夹欢迎语时，假模型抓到的请求里最后一条 user 是客户这句、排在欢迎语之后、contextNote 紧挨在它前面，会话里的顺序不变；安全网与模型两条入口的超长原话 quote 截到 200 个码点（第 200 个码点是 emoji，结果 well-formed）；模型不给 reason 时记录的原因是兜底文案，不写「AI 已转人工：」那条；安全网、promise、claimed 各配一句带日期的原话，记录都有 `departNote`，claimed 的 system 消息逐字等于「AI 已转人工：回复里答应了转接顾问（引擎补记）\n（出行时间）」；固定原因的期望值全部写成字面量，不再从 `HANDOFF_REASON` 取；带 `ADMIN_PASS` 的 `/api/sessions` 列表返回原对象。临时 `VAR_DIR` 照 `store.selftest.ts` 在退出时删掉。
    - `console.selftest.ts`（302 → 305 项）「会话只读列表」一段：一个会话带接手人、转人工记录、一条带 `sentAt` 的客户消息，后面再跟一条 agent 消息。断言行的 `assignee` 恰为 `{ userId, name }`，`handoff` 恰为 `{ kind, at（ISO）, reason }`（原话与出行时间备注不进列表），`lastCustomerAt` 是 `sentAt`；`byState.assigned` 为 1、四项之和等于 total，`?state=assigned` 只返回它。下一段按三态逐条核对，所以断言完把接手人摘掉。
  - `activePack` 的 DB 配置分支（审查 tests[5]）：在 `console.selftest.ts` 里借 `__configTest.swapPack` 把租户的包换成家装假包，断言 `isTerminalStage('deposit')` 为真、`'paid'` 为假、`terminalStageKey()` 是 `deposit`。
  - 变异（`git worktree add --detach` 到 scratchpad 的隔离副本，逐个打、跑完删掉）：共 31 个，全部杀掉，每个都由新加的那条断言报出。企微适配器的四个（不传 `msgid` / `sentAt`；两处 `send_time * 1000` 改成 `send_time`；重放对齐只比原文；占位去掉 `sentAt`）先确认在 `handoff.selftest.ts` 与锁定的 `wecom.selftest.ts` 下都存活，再由 `wecom-02.selftest.ts` 杀掉。三处代码改动各自撤回（保鲜三个字段整体与逐个撤回、判定去掉 `|| handedOver`、不挪 history）由 `handoff.selftest.ts` 杀掉，其中不挪 history 在锁定的 `engine.selftest.ts` 下存活。`ConversationRow` 七个（`lastCustomerAt` 不看 `sentAt` / 取任意角色的最后一条、`assignee` 恒 null / 原样展开、`handoff` 恒 null / `at` 不转 ISO、counts 把 assigned 算进 human）由 `console.selftest.ts` 杀掉。quote 与兜底六个（安全网不截 / 按码元截、引擎四处都不截、工具提示不截、去掉兜底原因、reason 为空也写 system 消息）、departNote 四个（三个入口不带、claimed 的 system 消息丢掉出行时间）、固定原因四个（request 与 complaint 互换、改 promise / model / refund 的文案）、带凭据的列表也走匿名投影一个，由 `handoff.selftest.ts` 杀掉。
  - 门禁四个全绿；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。

### 第 4 步 · 迁移、仓储函数与库自测（2026-10-02）

- 迁移两个：`drizzle/0002_conversations.sql`（drizzle-kit 生成：十二张表、索引、约束、`tenants` 三列、`catalog_items.version`）与 `drizzle/0003_conversations_rls.sql`（custom：RLS、`orders_session_fk`、两个触发器、四个函数、授权、回填）；编号、journal、snapshot 都是 drizzle-kit 的产物，之后再跑 `pnpm db:generate` 报 no schema changes。0002 生成之后只手加了三行注释：drizzle-kit 把 `tenants` 三列的 CHECK 拆成三条 `ALTER TABLE … ADD CONSTRAINT … CHECK`（不是 spec 写的同一句），三条各标一行 `-- migration-allow: add-check 新列带默认值且满足约束，旧镜像不写这几列`。
- 约束名：CHECK 是 `<表>_<列>_check`（`conversations_state_check`、`orders_data_check` 等）；复合外键 `messages_conversation_fk`、`turn_traces_conversation_fk`、`guard_events_turn_fk`、`consents_conversation_fk`、`catalog_item_versions_item_fk`，custom 里的 `orders_session_fk`。第 5 步按 SQLSTATE 与约束名记 poisoned 时用得上。
- spec 没写细、本步定的：
  - 两个触发器违反时报 `check_violation`（23514），消息以「conversations: 」「orders: 」开头，与 01 的触发器同一口径；第 5 步归数据类、不重试。
  - 四个函数：调用方的租户为空或不等于 `p_tenant` 报 `insufficient_privilege`（42501，与 01 认证函数同一口径）；`p_now` 为空或与 `now()` 差超过 5 分钟、`erase_conversation` 的原因为空报 `invalid_parameter_value`（22023）。预期值用 `IS DISTINCT FROM` 比，传 NULL 也算不符。保留期与「30 天」按 `n × 24 小时` 算，不随会话时区的夏令时变（与 01 会话期限同一写法）。
  - `purge_conversation` 先 `FOR UPDATE` 锁会话行；先改订单再删会话（删了之后外键已把 `session_id` 置空，就找不到这些订单）；会话不在了返回 false。
  - `purge_expired_traces` 返回 trace 与发送账本两类删除条数之和（spec 只写「删除条数」）。
  - `erase_conversation` 同样先锁行，级联的几类在删之前数；返回 `{conversations, messages, traces, guardEvents, consents, outboundSends, orders, jobs}`（`jobs` 是审查之后加的，见下）；会话不存在时各类为 0、审计照写（留下有过这次请求的记录），第 16 步的命令行看 `conversations` 是否为 0。审计行 `actor_kind=platform`、`actor_name='erase-conversation'`（与 01 平台命令行写命令名的做法一样）、`target_*` 为空，diff 是各类条数加 `reason`。
  - 0001 的默认权限已不给 PUBLIC 执行新函数；spec 写了「对 PUBLIC 撤销 EXECUTE」，四个函数仍显式 `REVOKE` 一次（标 `migration-allow: revoke`）。
  - 回填照 spec 用 `DO` 块按租户 `set_config` 后 `INSERT … SELECT`，另加 `ON CONFLICT DO NOTHING`，最后把租户设置清回空串（drizzle 把所有待跑的迁移放在一个事务里，后面的迁移不该带着最后一个租户）。
  - 订单 `data` 去掉 `sessionId` 照 spec 写 `(data::jsonb - 'sessionId')::json`：这几张单的键序会按 jsonb 重排，它们已经不进 identity map，不影响往返；`data` 里要是有 `\u0000`，jsonb 转换会报错，靠第 5 步的 `normalizeForStore` 兜住。
- 照 spec 原文、记一笔的：`messages_author_human_check` 是 `author = 'human' OR (author_user_id IS NULL AND author_name IS NULL)`，`author` 为 NULL 时整式是 NULL、CHECK 视为通过，「没有 author 却带 `author_name`」的行拦不住，靠第 5 步的消息投影保证。不变量 11 在库里的保证是会话 id 的 CHECK 加 `orders_session_fk`（`session_id` 非空就必须是库里的真实会话）；`session_id` 为空的订单库不管，靠第 5 步只写真实会话的订单。spec 没列的索引一个没加：`orders (tenant_id, session_id)`、`consents (tenant_id, conversation_id)` 没有索引，删会话时这两条外键动作要扫表，第 25 步压测时看，要加就另写迁移。
- `client.ts`：导出 `WithTenantOpts`；`longRunning` 的两句 `SET LOCAL` 在事务开头、租户检查之前；`inTenantTx()` 返回布尔。`audit.ts`：`writeAudit` 改成调 `writeAuditAs(tx, 上下文的 actor, entry)`，行为不变。
- 仓储函数（只收发各文件里定义的行类型：时间是 `Date`，json 列是对象、键序靠驱动的 `JSON.parse` 保持；租户一律取 `currentTenantCtx()`，不收参数）。清单与给哪一步用：
  - `conversations.ts`：`readConversationsAfter(tx, afterId, limit)`（按 id keyset 分批，第 5 步预载、第 6 步导出）；`lockConversation`、`insertConversation(tx, values, seqs?)`、`updateConversation(tx, values, seqs)`（第 5 步一次落库的第 2、4 步；`insertConversation` 带 seqs 给第 6 步导入一次写好；`updateConversation` 不动 `created_at`）。
  - `messages.ts`：`insertMessages`（每 1,000 行一条 INSERT）、`readWindowMessages(tx, ids)`（第 5、6 步）。
  - `orders.ts`：`upsertOrders`（除主键外以这次为准，`--resync` 的作废也走它）、`readLiveOrders(tx, sessionIds)`（第 5、6 步）。
  - `catalog-versions.ts`：`insertCatalogVersion`、`readCatalogVersions`（第 8 步）。`catalog_items.version` 的改动留给第 8 步在 `catalog.ts` 里做；注意 01 的 `catalog_items_guard` 每次 UPDATE 都会让 `rev` 加 1。
  - `traces.ts`：`insertTurnTraces`、`insertGuardEvents`（第 9 步，经第 5 步的存档点）。`usage.ts`：`addUsage`（第 9 步；同一批里重复的键先合并，一条语句里同一行冲突两次会报错）。
  - `jobs.ts`：`enqueueJob`（冲突目标是部分唯一索引 `jobs_open_uq`，已有没结束的返回 null）、`claimDueJobs(tx, now, limit)`、`setJobStatus(tx, id, status, { from?, lastError?, attemptsDelta?, runAt? })`（改成结束的四种状态记 `finished_at`）、`cancelPendingJobs(tx, dedupeKey)`（第 10、14、16 步）。
  - `outbound.ts`：`insertOutboundSends`、`setOutboundStatus(tx, msgid, status, { errcode?, failType? })`（第 12 步）。
  - `quick-replies.ts`：`listQuickReplies`、`createQuickReply`、`updateQuickReply`、`archiveQuickReply`、`moveQuickReply`（第 22 步）。`consents.ts`：`appendConsents`；`privacy.ts`：`publishPrivacyNotice`（平台身份）、`readLatestPrivacyNotice`（第 16 步）。
  - `metrics.ts`：`readMetrics(tx, { since, sinceDay, today })`，四条 SQL，费用按千分之一元返回（第 18 步换算成元、缓存 60 秒、算服务器时区的日期）。
  - `audit.ts`：`writeAuditAs`（第 5 步）。
- 偏离与理由（都在签名层面，后面的步骤可以改）：`claimDueJobs` 的「现在」由调用方传（spec 写 `run_at <= now()`）：`runAt` 是进程的时钟算的，同一个时钟比较，自测也能认领到点的任务，`claimed_at` 也记它。`listQuickReplies` 不在 plan 列的「增改、归档、上下移」里，第 22 步「空表首次读取时写入」与 J 页都要读，增改也要读回才验得了，所以加上。spec 里本步没做的读法留给各自的步骤：7 天 msgid 集合与账本预载（第 5、12 步）、清理候选与清除函数的 TS 包装（第 16 步）、往前翻页读消息（第 13 步）、trace 原文（第 9、13 步）。
- 自测 `src/db/db.selftest.ts`：不带 PG 189 → 433 项，带 PG 329 → 802 项（+244 / +473）。01 的断言一条没删、没放宽：「七张表」改成十九张；函数检查多一类「清除与删除函数」（只授权给各自的角色、SECURITY DEFINER、钉 search_path）；`why()` 认触发器的前缀加上 conversations、orders；备份自测的假 `docker` 目录缺省多三张表（`FAKE_TOC` 可换）。新增的：
  - PGlite：第二个 PGlite 先只跑 0000、0001，造两个租户的 active / draft 条目，再跑全部，断言每个 active 条目一行版本 1、payload 文本逐字节相同、草稿不写；十二张表的 CHECK 与外键逐条按约束名断言（含 `sim-`、`wecom:cust_`、`state.id`、`data.id`、msgid 33 字节）；`jobs_open_uq`；删会话时级联与 `SET NULL (session_id)`（`tenant_id` 不被置空）；两个触发器；每个仓储函数至少一次冒烟（以 `agent_app` 经 `withTenant`）；`longRunning` 只管那一个事务；`inTenantTx`；`writeAuditAs`。
  - 清除与删除函数的行为写成 `purgeChecks`，PGlite 与真实 PG 各跑一遍：保留期设成线索 10、客户 30、trace 7 天（三个不同，取错列查得出）；不在 `withTenant` 里、别的租户、`p_now` 前后 10 分钟与 NULL 都报错；没到期、预期值不符、`updated_at` 改成 2000 年被挡回、已付订单改成取消，都返回 false 且库不变；到期时会话行、消息、trace、护栏事件、同意记录、发送账本都没了，订单留下、`session_id` 为空、`data` 没有 `sessionId`，别的租户的同 id 会话不动；trace 与没有会话的发送账本按 trace 保留期删；任务按 30 天删；`erase_conversation` 只有平台能调、不看保留期、审计只有条数与原因；三个会话清除或删除之后本租户各表里都搜不到它的 id（不变量 42）。
  - 真实 PG：新表逐格权限、两个角色对新表都没有 DELETE / TRUNCATE、`tenants` 三列的列级 UPDATE（平台能改、改别的列与应用改都报 permission denied）、函数 EXECUTE 逐个、没设租户时 SELECT 0 行与 INSERT 被 RLS 拒（十二张表）、A 的事务里看不到也改不到 B 的行、`agent_app` 与 `agent_platform` 对 `messages` 的 UPDATE / DELETE / TRUNCATE 报 permission denied、同一条池内连接上 `longRunning` 之后回到 5 秒与 10 秒。
- 真实 PG：本机 `pgvector/pgvector:pg17` 一次性容器（`127.0.0.1:55432`），`db.selftest` 802 项全过；`pnpm test` 带 `PG_TEST_URL` 与不带各跑一遍，都全绿，PASS 行 60（与第 3 步相同，本步没加新套件）。
- 变异（`git worktree add --detach` 到 scratchpad 的隔离副本，逐个打、只跑 `db.selftest`，授权类带真实 PG）：74 个，杀掉 73 个。覆盖两个触发器（去掉 `greatest`、5 分钟改 5 年、允许清空或改 `paid_at`）、外键动作（不带列清单、改成 CASCADE）、四个函数的租户与 `p_now` 校验、客户的判定（按 status 判）、保留期取错列、两个预期值、截止时间算反、订单不去 `sessionId`、不删账本、trace 函数的保留期列与「没有会话」条件与返回值、任务的 30 天与 failed、删除的原因、审计不记原因或记了 `target_id`、计数、函数与表的授权（给 messages 加 UPDATE / DELETE、jobs 加 TRUNCATE、tenants 整表 UPDATE、隐私说明给应用 INSERT、函数多授一个角色）、RLS（NO FORCE、`USING (true)`）、回填（不设租户、带上草稿）、0002 的四处约束、`client.ts` 三处（含 `SET LOCAL` 改成会话级）、`writeAuditAs`、各仓储函数一到三处、`backup.sh` 少查一张表。剩下的一个是等价变异：`purge_conversation` 删发送账本时去掉 `tenant_id` 条件，函数在 FORCE RLS 下以调用方的租户执行，别的租户的行本来就看不到。首轮另有一个存活（`insertConversation` 不理会带进来的 seqs），补了一条断言后杀掉。
- 锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。
- 注意（第 5 步）：
  - 触发器取 `greatest(OLD, NEW)`：库里的 `updated_at` 可能比这次写进去的大（内存里的时间回拨过），往返比对时以库为准。清除函数的预期 `updated_at` 要逐毫秒相等，只由 JS 写入（毫秒）时才成立，不要在 SQL 里写 `now()`。
  - `insertConversation` 是普通 INSERT，同一会话撞上报 23505（数据类）；靠「同一会话串行落库」不撞。写 `state`、订单 `data` 时 `id` 必须与行的 id 一致（CHECK）。
  - 一次落库里先插会话行（若没有），再插消息、订单（外键）；trace 先于护栏事件。
- 注意（第 16 步）：`AUDIT_ACTIONS` 还没有 `platform.erase`、`system.purge`、`privacy.publish`，K 页显示要加。
- 审查之后改的（2026-10-02）：
  - 迁移两处。0002、0003 都还没发布，直接改了 0003（0002 没动）；custom 迁移的 snapshot 是上一份的原样拷贝，journal 不记 SQL 的哈希，两者都不受影响，`pnpm db:generate` 仍报 no schema changes，`check-migrations` 照过。
    1. `orders` 的 BEFORE UPDATE 触发器改名 `orders_guard`（原 `orders_guard_paid_at`），多管一条：`session_id` 非空之后改成别的值（置空或改挂到别的会话），而 `current_user` 不是 `agent_owner` 时报 `check_violation`（消息「orders: session_id 写入之后只有清除与删除函数能改」）。原因：`agent_app` 对 `orders` 是整表 UPDATE，清除函数判「客户」看的是这张单的 `session_id` 与 `paid_at`，把已付订单从会话上摘下来，会话就按线索的保留期提前清除，违反 R20「判断只看 agent_app 改不了的数据」与不变量 6。清除与删除函数是 SECURITY DEFINER，外键的 `SET NULL` 动作以表的属主执行，两处的 `current_user` 都是 `agent_owner`，照常放行；从空写成某个会话可以（孤儿订单后来挂上会话）。应用的写路径核过：`upsertOrders` 的 `session_id = excluded.session_id` 对已有订单写回的是同一个值，`IS DISTINCT FROM` 为假，不被拦；落库、重置作废、导入、`--resync` 都不改已有订单的 `session_id`。spec「数据库 · 触发器」原文只写了 `paid_at`，这一条超出原文，记进「Open」。
    2. `purge_conversation` 与 `erase_conversation` 一并删 `payload->>'sessionId' = p_id` 的任务（任何状态；agent_app 本身仍没有 DELETE）；`erase_conversation` 的返回值与审计 diff 多一项 `jobs`。约定：与会话有关的任务，`payload` 必带 `sessionId`（`enqueueJob` 的注释写明）。原因：跟进的 `dedupe_key` 是 `followup:<会话>:<阶段>`，会话 id 就是 `wecom:<external_userid>`，验收 27 要求删除之后库里搜不到它，原来的删除范围不含 `jobs`。这是按验收 27 扩了删除范围，记进「Open」。
  - `deploy/backup.sh`：导出之前，用查两张配置表行数的那一个 psql 一并查 `to_regclass('public.conversations')` 等三张表在不在；在的才要求导出里有它的数据段，不在的告警一行（「库里还没有 …（02 的迁移没跑成？），这次不查它们的数据段，备份照做」）、备份照做。原因：`deploy.sh` 第 5 步先装新版本脚本、第 6 步才迁移，构建或迁移失败时库停在 01，原来每晚的备份会整份不出（连 `var/` 都不备份），直到下一次部署成功。表在不在放在导出之前查：导出之后才建的表这次不要求，不会误报。自测里的假 docker 的 psql 输出可以换（`FAKE_PSQL`），见下。
  - 补的自测（`db.selftest.ts`，不带 PG 433 → 465 项，带 PG 802 → 861 项）：
    - 清除与删除（`purgeChecks`，PGlite 与真实 PG 各一遍）：`agent_app` 把已付订单的 `session_id` 置空、改挂到别的会话（直接 UPDATE 与照 `upsertOrders` 写的 upsert 两种）都被触发器拒，同值 upsert 能过；之后 11 天前的客户会话清除仍返回 false、订单仍挂在原会话上；超级用户直接删会话时已付订单照常置空，`erase` 照常置空（原有）。任务：清除之后这个会话 pending 与已结束的任务都没了，别的租户同 id 的、别的会话的、`purge_finished_jobs` 管的都不动；删除返回 `jobs: 3`（pending、running、done）。验收 27：删除之前对 `public` 下每张表做 `t::text LIKE '%<external_userid>%'`，在会话、消息、trace、同意记录、发送账本、订单、任务七张表里找得到，删除之后一张都没有（被扫的表含 orders、audit_log、outbound_sends、consents、turn_traces、jobs）；不变量 42 的逐表扫描加上 `jobs`。`p_now`：三个函数各补差 ±6 分钟报 22023，`purge_conversation` 另补差 ±4 分钟照常；`purge_expired_traces`、`purge_finished_jobs` 补「过去」与 NULL。
    - PGlite：`updated_at` 晚 6 分钟被拒、晚 4 分钟可以；`orders_data_check` 补「data 没有 id」；`upsertOrders` 写回同一个 `session_id`（连写两遍）能过，改挂、置空被拒。
    - 列级授权（`schemaChecks`，PGlite 与真实 PG 各一遍）：`public` 下 `aclexplode(pg_attribute.attacl)` 恰为 `tenants` 三个保留期列给 `agent_platform` 的 UPDATE。逐格表的 `has_table_privilege` 看不见列级授权，这一条补上。
    - 两条连接并发（真实 PG）：(a) 连接 1 锁住一个到期会话行，连接 2 拿旧预期值调 `purge_conversation`，在 `pg_stat_activity` 里看到它等锁之后，连接 1 插消息、推进 `last_seq` 与 `updated_at` 再提交：连接 2 返回 false，会话与两条消息都在。(b) 十二个到期任务，第一个 `withTenant` 认领 5 个后不提交，第二个 `withTenant` 3 秒内拿到另外 5 个，两边 id 不相交。
    - `backup.sh`：库里三张表都不存在时告警一行、三份密文照写；库里只有 `conversations` 而导出里缺它的数据段时非零退出；有它的数据段时照常备份、只为另两张告警。
  - 变异（`rsync` 到 scratchpad 的隔离副本，逐个打、只跑 `db.selftest`）：27 个变异、35 次运行（不带 PG 与带 PG 各算一次）全部杀掉。去掉 `session_id` 守卫、只拦置空、去掉 `agent_owner` 的豁免（清除与外键动作直接报错）；清除不删任务、删除不删任务、只删 pending、不计条数；去掉 `purge_conversation` 的 `FOR UPDATE`（并发用例 (a) 返回 true）；认领去掉 `SKIP LOCKED`、去掉整个行锁（并发用例 (b) 第二个认领被挡住）；四种多出来的列级 GRANT（含 `turn_traces`、`consents` 给 app 的 UPDATE，`orders.session_id` 给平台的 UPDATE）；触发器与三个函数的 5 分钟改 9 分钟，触发器与 `purge_conversation` 改 3 分钟；trace 与任务两个函数去掉「过去」、去掉 NULL 分支；去掉 `orders_data_check` 的 coalesce；`backup.sh` 三张表一律要求、一律不要求。
  - `pnpm test` 带 `PG_TEST_URL` 与不带各跑一遍，都全绿，PASS 行 60；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。
  - 注意（第 5、6 步）：已有订单的 `session_id` 只能写回原值（触发器）；内存里订单的 `sessionId` 不会变，照 `upsertOrders` 写即可。撞上它报 23514、消息以「orders: 」开头，归数据类。
  - 注意（第 10、14 步）：任务 `payload` 必带 `sessionId`（与会话有关的跟进、转人工通知都是），否则清除与删除带不走它，`dedupe_key` 里的 external_userid 会留在库里；`retention_purge` 不属于某个会话，不带。

### 第 5 步 · PG 后端（2026-10-02）

- 结构：
  - `src/store/project.ts`（纯函数）：`sessionState` / `sessionToRow` / `conversationValuesFrom` / `rowToSession`、`messageToRow` / `rowToMessage`、`orderToRow` / `rowToOrder`、`normalizeForStore`、`lastCustomerAtOf`、`ProjectionError`；`isDemoClassId` 与 `SESSIONS_IN_DB_MARKER` 搬到这里，`store.ts` 原样再导出（自测断言是同一个函数与值）。行的形状写成与 `src/db/repo/` 同构的接口（纯模块不能 import 那边，调用处按结构对上）。
  - `src/store/pg-backend.ts`：`openPgBackend(deps)` 做预载 → 校验 → 回放 spill（回放过就再预载一遍），返回还没装上的后端，不碰 identity map；`install()` 才把会话与订单放进 map。`PgBackend` 在 `StoreBackend` 之外多 `accepts`、`voidOrder`、`queueAudit` / `queueJobs` / `queueConsents` / `queueTelemetry`、`writeStandaloneAudit`、`recentMsgids`、`close`、`stats`。`StoreConflictError` 在 `backend.ts`。
  - `src/store.ts`：`initSessionStore` 的 db 分支（装上后端、登记 drain 段 `drainStore(剩余预算)` 与 late 段 `close()`）；`saveSession` 先经 `accepts` 查 identity；订单按 `pgFor`（db 存储、真实会话、而且会话在内存里）路由，否则归文件后端；`deleteOrdersOfSession` 在 db 存储下逐张 `voidOrder(o, 'reset')` 再移出内存；新导出 `queueAudit`、`queueJobs`、`queueConsents`、`queueTelemetry`、`recentMsgids`、`noteWindowReset`、`__storeTest.pgStats()`。文件存储下每个分支都退回原来的调用，行为逐字节不变（锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变）。
  - 其余：`src/engine.ts` 的重置在 `messages = []` 之前调 `noteWindowReset(session)`；`src/llm.ts` 的 `chat()` 入口 `inTenantTx()` 为真就抛；`src/db/client.ts` 加 `pgErrorOf`（沿 cause 链取错误码与约束名）与 `trySavepoint`（回到存档点成功就返回 `{ ok: false, error }`，回不去才抛）；`src/db/repo/messages.ts` 加 `readRecentCustomerMsgids`、`readMessagesFrom`；`src/config/source.ts` 加 `tenantLockTaken()`（重取得到 `held_by_other` 时置真）。
  - 测试装配（`src/db/testing.ts`）：`openTestDb({ dataDir })` 能落盘、能再打开（被 SIGKILL 之后也行）；`installPgSessionStore(t, { varDir })` 建租户、切成 `agent_app`，返回 `{ deps, faults, stats }`：`deps.db` 是同一个 PGlite 上另开的 drizzle 实例，故障注入（`acquire` 抛、`gate` 卡、`releaseOnce` / `skipReleases` 模拟 COMMIT 之后回包丢失）与计数只管它，查询不进 `queryCount()`；调用方自己 `initSessionStore(fixture.deps)`（依赖规则不许 `src/db/` import store，没开例外）。另有 `fakeDbError(code)`、`openFlakyDb(url)`（node-postgres：放过 `skipCommits` 条之后让 COMMIT 照常执行、回包丢掉）、`createRealPgFixture(superUrl)`（建临时库、按 `roles.sql` 建角色、迁移、建租户；`src/store/` 下的套件不能 import `pg`，所以放这里）。
- spec 写得不够、本步定的（选最小、最贴原文的）：
  1. **何时取快照**：没有在途的落库时，`saveSession` 当场同步取快照并起落库（不去抖）；有在途的就只标脏，提交之后接着取下一次。所以「进快照即冻结」发生在 `saveSession` 里：之后再改这条消息立刻抛 `TypeError`，不会有「改了但碰巧赶上快照」的不确定。
  2. **flush_id**：每个快照一个，同一快照的重试沿用（spec「flush_id 是上一次重试的值」）。重试时先看 flush_id：库里是本快照的且 last_seq 等于快照最后一条 → 已提交，回滚本事务、补做提交后的步骤；是本快照的而 last_seq 不对 → 冲突；不是本快照的再比 last_seq。先看 flush_id 是为了没有新消息的快照（只改会话投影、只带审计）：它的 last_seq 本来就等于「已提交到第几条」，按 last_seq 判会重写一遍、审计记两行。
  3. **重试**重做同一个快照；退避期间来的改动排在它提交之后的下一次，不并进重试。
  4. **失败分类**：SQLSTATE 22、23、42 类、`WindowCorruptError`、`ProjectionError`（时间不是有限的毫秒数）、不带 code 的 `TypeError` / `RangeError` / `SyntaxError` → 不重试、poisoned；`StoreConflictError` → 冲突；其余（spec 点名的 08、40001、40P01、57014、53、57P，spec 没点名的类，errno 码，不带 code 的「连接意外中断」）→ 退避重试。spec 没点名的类按重试处理：不丢数据，积压在 `/healthz` 看得见。`lastError` 形如 `23514 conversations_id_check · 7F3A`。
  5. **poisoned** 之后对这个会话改用 `assignSeqs(s, 'lenient')`，`flushSession` 立即以 `StoreLaggingError` reject；失败的那个快照留在「在途」位置不再重试，停机时连同之后的改动写进 spill。
  6. **spill 文件**（`var/store-spill-<ISO 时间，冒号与点换成 ->.json`，先写 `.tmp` 再改名）：每个会话一条，除了 spec 列的（已提交到第几条、没提交的消息连同 seq、会话投影、排着的订单与审计），还写在途那次的 `flushId` / `lastSeq` 与它的附带行（分开记）、一个回放用的 `flushId`、排着的任务与同意记录（spec 没列，按不变量 13「没落库的改动要么已提交，要么在 spill 里」一并写；trace 与账本行照 spec 不写）。回放按会话逐条：库里是这一条的回放 flush_id → 已回放过，跳过；库里是在途那次的 flush_id 与 last_seq → 在途那次其实提交了，只补它之后的消息与附带行；库里的 last_seq 等于「已提交到第几条」→ 按一次落库写入；库里已经等于文件里最后一条的 seq 且内容一致 → 跳过（spec 原文）；其余 `spill_conflict`（点名短码，文件留着）。别的租户的 spill → `spill_conflict`；读不出来的文件、有一条回放仍失败（数据类）的文件 → 改名 `.json.failed`、记一行，从库里的状态起；回放时连不上库 → `db_unreachable`。全部成功就删掉文件，再预载一遍。
  7. **预载**每批四条语句（会话行、窗口内消息、未作废订单、7 天 msgid），整个预载一个 `REPEATABLE READ READ ONLY` 的 `longRunning` 事务。校验：窗口内消息条数等于 `last_seq − window_start_seq + 1` 且 seq 逐条连续（否则 `preload_integrity`）；订单 `data.sessionId`、`data.id` 与列一致、会话在这一批里（否则 `orphan_order`）；有 demo 类 id（表上的 CHECK 本来就拦，纵深防御）→ `demo_class_in_db`；预载里的库错误一律 `db_unreachable`（带错误码）。企微去重集合 = 预载的最近 7 天（按 `at`，不看窗口）加上本进程分配过 seq 的客户消息的 msgid，`recentMsgids(id)` 读它（文件存储下为空）。
  8. **消息投影**：已知字段的取值放不进列的（customer 带 author、非 human 带 authorName / authorId、authorId 不是 uuid、msgid 不是串、sentAt 不是数）原值进 `extra`、列为 NULL，重建时 `extra` 盖在列上，`messages_author_human_check` 的 NULL 语义由此守住（自测断言行投影里没有一条「没有 author 却带操作者」）。`author='human'` 的消息重建时一定带 `authorId`（列为 NULL 时写 `null`）：共享工作台的 `authorId: null` 原样往返；没有 `authorId` 键的 human 消息往返后多一个 `null`（不变量 17 要求必带，02 之前的数据没有 human）。`assignee_user_id` 有外键到 `users`，写进不存在的 user id 会 23503、poisoned（第 13 步写入真实成员 id）。
  9. **identity map**：`saveSession` 收到同 id 的另一个对象 → `accepts` 拒绝（日志一行、`foreign` 计数），既不落库也不换掉 map 里的。
  10. **不是预载来的会话**（新建的，或第 6 步之前 JSON 里读来的真实会话）建写队列时，窗口里已有 seq 的消息整段算没提交：JSON 里来的真实会话第一次落库从 seq 1 写全窗口，不会只写尾巴留下空洞。第 6 步加 `real_in_json` 拒绝之后线上走不到这条。
  11. **孤儿订单**：所属会话不在内存里的订单归文件后端（`orders.json`），改动照写；同 id 的会话建出来时转进它的写队列，随第一次落库写进库。
  12. **附带行的入口**：`queueAudit`（真实会话随落库写，各自带操作者与 IP；db 存储下的 demo 类或内存里没有的会话单独一个短事务，只试一次、失败记一行；文件存储下不写，会话类审计在文件存储下的去处第 13 步定）；`queueJobs`（`enqueue` / `cancel` / `status` 三种，时间是毫秒）、`queueConsents`、`queueTelemetry`（`traces` / `guards` / `outbound`，写在 `SAVEPOINT telemetry` 里）只对 db 存储的真实会话，其余丢弃（R6、R16）。本步只有订单与审计有生产者，其余由自测直接调。
  13. **旧 `/api/admin/stream`**：db 存储下真实会话每次提交之后发 `storeEvents` 的 `change`（与文件后端一样约 200ms 合并一次），提交失败不发。不发的话 db 存储下 `admin.html` 对真实会话不再刷新；不变量 10 本来就要求「提交之后」。文件存储下仍是文件后端在每次去抖落盘后发（照旧不论成败，改成提交后发归第 13 步）。
  14. **停机**：drain 段把退避中的重试立即再试一次，在预算内等所有非 poisoned 的会话提交；已冲突或 `tenantLockTaken()` 时不写库，直接返回全部积压（日志只写短码）。late 段 `close()`：此后不起新的落库、退避的定时器清掉；还在途的那次要么提交（spill 里就没有它），要么失败（留给 spill）。冲突时 `onConflict` → `gracefulExit(1, 'store_conflict（会话 短码）：落库撞上另一写者')`。
  15. 单个落库事务超过 2 秒（从借连接算起）记一行 warn、`slowTx` 加 1；存档点里写失败 `telemetryDropped` 加 1；认出已提交 `recognized` 加 1（`__storeTest.pgStats()` 读）。
- 偏离与理由：
  - `installPgSessionStore` 不装 store，只返回依赖（brief 与第 2 步记录给的第二种写法）；名字照 plan 留着，第 7 步的 `eval/run.ts` 用它再 `initSessionStore(fixture.deps)`。
  - spill 比 spec 多写了在途那次的 `flushId` 与回放用的 `flushId`、任务与同意记录（见上面第 6 条）。只是多写，spec 写的回放规则（「等于已提交到第几条就写」「等于最后一条且内容一致就跳过」「其余拒绝」）原样都在。
  - PG 的「另一写者」在自测里照真实写者的样子：锁行、插一条消息、推进 `last_seq`。只推 `last_seq` 不插消息的话库本身就不自洽了，之后每次启动都以 `preload_integrity` 拒绝（这也是对的，只是测不到 spill 那一步）。
- 自测（`store.selftest.ts`，第 4 步结束时 110 项）：投影往返（纯函数，24 项）；PG 的几组都跑在子进程里（本文件带 `STORE_SELFTEST_CHILD` 再起一次自己，结果同步写进文件，被信号杀掉之前也来得及）：
  - PGlite 进程内（97 项，含 `installSeededConfig` 的 DB 配置模式）：预载往返（窗口、seq、冻结、作废订单不进、7 天 msgid）、四种拒绝原因与 1001 个会话三批、spill 回放的接续判定（五种情况、`.failed`、别的租户、只有投影与审计的一条回放两遍）、库连不上时 `db_unreachable` 且不留半装载、写队列（十次合并成两次、在途期间不另起、不同会话并发）、冻结、裁剪推进窗口、引擎重置（窗口推进到重置回复、已付订单作废而 `paid_at` 不动、E6p 的内存行为）、事件与旧 `change` 只在提交后（在途、失败都不发，恢复后恰一次）、COMMIT 之后回包丢失（库里已有、store 当作没有，重试认出、不重复、事件一次）、数据类错误（id 超长、订单金额为负、中间删除）poisoned 且别的会话照常、`/healthz` 的 `ok` 为 false、identity map 拒绝副本、NUL / 第 2000 字的 emoji / 直接写进来的 NUL 与孤立代理项、存档点（非法护栏名丢一批并计数、合法的照写）、`chat()` 在 `withTenant` 里断言失败、`withTenant` 回调里 `saveSession` 一次成功（不靠重试）、一轮的读路径不查库、孤儿订单与 demo 类落盘、附带行三类与 demo 类审计的短事务、十二种错误的分类、慢事务计数、drain 立即重试与锁在别人手里时不写库。
  - 落盘的 PGlite 上一串「启动」（十个子进程交接同一个库）：20 轮后 SIGTERM（143，drain 排空，重启后 identity map 经 JSON 规范化后 `deepStrictEqual`）→ mock LLM 延迟 6 秒的一轮中间 SIGTERM（normal 段等这一轮，重启后客户消息与回复都在）→ drain 段 PG 不可写写出 spill（三个会话、订单、审计）→ 重启回放、库与停机前的内存一致、spill 删掉 → 「已提交到第几条」改错一格 `spill_conflict` → 改回照常 → SIGKILL 模拟崩溃（没有 spill，重启后只少最后一次没提交的落库）→ 另一写者（以 1 优雅退出、日志点名 `store_conflict`、drain 不写库、进 spill）→ 之后启动 `spill_conflict` → poisoned 的会话随 spill 写出 → 原因没修好就重启，`.failed`、从库里起。
  - 真实 PG（9 项，有 `PG_TEST_URL` 才跑；CI 下没有就失败）：真的 `server.ts` 以 `SESSION_STORE=db` 起、`/healthz` 报 `db`；第二个进程连同一个库以 `lock_held` 拒绝启动；第一个 SIGTERM 以 143 退出；另一写者让 `last_seq` 前进一格后再落库，以 1 优雅退出、日志点名 `store_conflict`、没落库的进 spill；COMMIT 之后回包丢掉（`openFlakyDb`），重试认出已提交、不停机、seq 1–4 不重复、事件一次。
  - 合计：不带 PG 256 项、带 PG 265 项，约 30 秒（`pnpm test` 由 144 秒到约 180 秒）。
- 变异（源码拷进 scratchpad 的三个隔离副本，逐个打、只跑 `store.selftest`）：38 个，全部杀掉。覆盖合并顺序（在途时另起、提交后不清已提交的）、冻结（快照、预载）、seq 预期、poisoned 分类（42 当重试、冲突当重试、连接类当数据类）、spill 回放的接续判定（认不出在途已提交、在途已提交时附带行也重写、认不出已回放、库里超前也照写、内容一致也不跳过、不删文件、不写在途那次的消息、「已提交到第几条」写错）、事件早发、`flush_id` 认领（不认、每次重试换新的）、drain 跳过 PG、空异步上下文、退避、identity map、孤儿订单转归、去重集合的天数、存档点、poisoned 之后仍用严格模式、预载校验两处、窗口起点、重置不作废、旧 `change`、`noteWindowReset`、`chat()` 断言、消息投影、`normalizeForStore`、慢事务计数、预载只读一批。首轮存活两个，补断言后杀掉：去掉空上下文（`withTenant` 回调里排出的落库嵌套报错，退避重试时又在空上下文里成功，掩盖了它；补「一次就成、没有重试」）；poisoned 之后仍用严格模式（没有用例对错位的会话再存一次；补上）。seq 预期、`flush_id` 的三个另在真实 PG 部分各被两到三项杀掉。
- 真实 PG：本机 `pgvector/pgvector:pg17` 一次性容器（`127.0.0.1:55432`）。`pnpm test` 带 `PG_TEST_URL` 与不带各跑一遍都全绿，PASS 行 60（本步没加新套件）；`db.selftest` 861 项照旧。锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。
- 注意（第 6 步）：
  - `real_in_json` 拒绝要排在 `openPgBackend` 之前（JSON 里的真实会话在导入期已经进了 map）；在那之前 db 存储下 JSON 里的真实会话会在第一次 `saveSession` 时整段写进库（上面第 10 条）。
  - 命令行只用 `project.ts`（`isDemoClassId`、`SESSIONS_IN_DB_MARKER`、投影）与 `src/db/repo/**`：导入用 `insertConversation(tx, values, seqs)` 一次写好、`insertMessages`、`upsertOrders`；读回比对走预载同一条路（`readConversationsAfter` / `readWindowMessages` / `readLiveOrders` 加 `rowToSession` / `rowToMessage` / `rowToOrder`），两边都先 `normalizeForStore`；`--resync` 的作废用 `orderToRow(o, { at, reason: 'resync' })`。
  - 导入时 `var/` 里若有 `store-spill-*.json` 或 `.failed`，要先处理（回放或人工确认），否则切到 db 存储时会被回放进去。
- 注意（第 7 步）：等价套件与 DB 模式 eval 用 `installPgSessionStore(t, { varDir })` 后 `initSessionStore(fixture.deps)`；冻结会让漏网的原地修改抛 `TypeError`，数组错位会让会话 poisoned（`storeHealth().poisoned` 点名），两种都要当失败报出来。`server.selftest.ts:835` 那种原地改 `at` 的写法不能照搬。
- 注意（第 9 步）：trace 经 `queueTelemetry(sessionId, { traces, guards })`，行是 `TurnTraceRow` / `GuardEventRow`（护栏名要满足 `^[a-z_]{2,40}$`，否则那一批在存档点里丢掉）；demo 类与文件存储下这几行不入库。用量的 drain 段写入另挂一个 drain 钩子，不经会话写队列。
- 注意（第 10 步）：任务经 `queueJobs`（`enqueue` 的 `payload` 必带 `sessionId`，第 4 步约定），随会话落库提交、也写进 spill；认领（`claimDueJobs`）是任务自己的短事务，不经会话写队列。
- 注意（第 12 步）：去重的情况 2 读 `recentMsgids(id)`；账本行经 `queueTelemetry(id, { outbound })`，`msg_send_fail` 的状态更新（`setOutboundStatus`）单独一个短事务。
- 注意（第 13 步）：`reply` 等的「积压超过 5 秒、已冲突或 poisoned → 503」读 `storeHealth()`（`flushSession` 对 poisoned 与冲突立即 reject）；`/status` 的 poisoned 短码就是 `storeHealth().poisoned`；console 写接口的审计走 `queueAudit`，文件存储下会话类审计的去处在这一步定；`assignee.userId` 写真实的成员 id（外键到 `users`）。
- 注意（第 14 步）：带转人工的落库失败时的 `unsaved` 通知要挂在 `pg-backend.ts` 的 `failed()` / `poison()` 上（现在只记日志）。
- 注意（第 16 步）：清除函数删掉会话之后，内存与写队列都要同一个 tick 摘掉它（`pg-backend` 还没有 `forget(id)`，要加）；否则这个会话的下一次落库发现行不在了，按 `StoreConflictError` 处理，整个进程优雅停机。
- 注意（第 17 步）：告警挂在 `poison()`（poisoned）、`failed()` 的冲突分支（`store_conflict`）与 `storeHealth().lagMs`（积压）；慢事务与存档点丢弃有计数（`__storeTest.pgStats()` 是自测口子，告警另开读法）。

## 验收记录

（对照验收标准逐条验证时填写：编号 · 通过 / 未通过 · 证据）

## Open

（与 spec 的分歧、需要 owner 裁决的事；开放问题的答复也记在这里）

- 开放问题的答复（owner 2026-10-02，已写进 spec 各条与顶部 `Revisions:`）：1 选 A「部分取代」，规则进了 `docs/spec-driven-dev.md` 与 AGENTS.md，01 与 UX spec 顶部已加 `Superseded in part by:`；2 线索 180、客户 730、trace 90 天，按租户可改；3 企微群机器人，与告警不同群；4 词表加规则；5 `channel_inbox` 留在 04、做三条缓解；6 选 A；7 照推荐做，PIA 出结论后复核；8 保守口径；9 02 不做改价；10 固定的回归步骤，不做发布闸；11 仓库外事项全部完成才接第一个真实租户；12 选 A；13 以后在另一台境内机器上自建 Langfuse，02 只埋点；14 国内云厂商的拨测。
- 第 1 步盘点带出、要 owner 定的三处（都不挡第 2 步）：
  - **交还消息里的顾问姓名会经匿名旧接口漏出**（第 3 步写投影之前定；第 3 步没等到答复，投影函数按消息逐条写好，改写规则随第 13 步的交还消息一起加）。spec「接手、人工回复与交还」规定交还时记一条 system 消息「{姓名}把会话交还 AI」；种子会话既能被成员接手、又对匿名可读，「后台接口」规定的匿名投影只去掉 `assignee.userId` 与消息的 `authorId`、`authorName`，管不到正文，`admin.html:939` 会原样显示它，与不变量 44（匿名响应里没有成员姓名）冲突。推荐：匿名投影把 `release()` 按固定模板生成的这条改写成「顾问把会话交还 AI」（模板由同一个常量产生，确定性可测）。备选：正文本身就写「顾问把会话交还 AI」，姓名只在 J 页由结构化记录显示（spec 的那句文案要改）。
  - **`POST /api/orders/:id/pay` 的响应体**（第 3 步；已按推荐先做，见「实施记录 · 第 3 步」裁定 10，owner 另有决定再改）。409 与 200 两个分支（`server.ts:462`、`483`）都带订单原对象，demo 下匿名可调；02 之后会带出 `confirmedBy`、`paidMarkedBy`、`cancelReason`。R22 只管 `GET /api/orders/:id`。推荐：改用同一个 R22 白名单投影（`pay.html` 只看状态码与 `res.ok`，锁定断言不读响应体）。
  - **advisor 模式下支付页从哪儿知道收款方式**（第 15 步之前定）。R22 白名单里没有收款方式，`confirmed=false` 分不清「online 待付款」与「advisor 待确认」；`/pay/:orderId` 能由服务端注入，`/pay.html?orderId=` 这条静态兜底（`pay.html:314`，`server.ts:698`）注入不到。推荐：`/pay.html?orderId=` 跳到 `/pay/:id`，页面只靠服务端注入。备选：白名单加 `paymentMode`（改 R22；锁定断言只看 `id`，不受影响）。
- 第 4 步审查带出的两处（都已按下面做了，owner 不同意可以改回）：
  - **清除与删除连带删会话的任务（按验收 27 扩了删除范围）**。spec 写的是「删除范围与清除函数相同」，不变量 42 的表清单里也没有 `jobs`；但跟进的 `dedupe_key` 是 `followup:<会话>:<阶段>`，会话 id 就是 `wecom:<external_userid>`，验收 27 要求删除之后「库里搜不到它的 external_userid」，结束的任务还要再留 30 天，不删就过不了这条。现在的做法：约定与会话有关的任务 `payload` 必带 `sessionId`，`purge_conversation`、`erase_conversation` 一并删 `payload->>'sessionId' = p_id` 的任务（任何状态），`erase_conversation` 的返回值与审计多一项 `jobs`。owner 要改回原文的范围，就把这两条 DELETE 去掉、把验收 27 的「库里」收窄成不变量 42 的那几张表；或者改成不删、把任务的 `dedupe_key` 与 `payload` 改用不含会话 id 的引用。请 owner 把定下的写法补进 spec「数据库 · 清除与删除函数」与不变量 42。
  - **`orders` 触发器多管了 `session_id`**。spec「数据库 · 触发器」只写了 `paid_at` 写一次；`agent_app` 对 `orders` 是整表 UPDATE，把已付订单的 `session_id` 置空或改挂，会话就按线索的保留期被提前清除，与 R20、不变量 6 矛盾。现在 `session_id` 非空之后只有 `agent_owner`（清除与删除函数、外键动作）能改，理由与验证见「实施记录 · 第 4 步」的「审查之后改的」第 1 条。请 owner 把这一句补进 spec 的触发器那一段。

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

### 交接（2026-10-02，第 3 步）

- 已完成：第 3 步。转人工记录与五条入口、四态与「已成交客户要人工」、终态会话保留终态、重置与交还清什么、`handoffBeforePaid`、两处非追加写改成只追加、`cleanText` 全部换上、`/api/orders/:id` 白名单、匿名投影、`legacy_admin_writes`、`handoff.selftest.ts`（102 项）与 `adapters/wecom-02.selftest.ts`（6 项）。审查之后改了三处代码（种子保鲜挪转人工的时刻、旧形状会话的 `handoffBeforePaid`、重放夹欢迎语时发给模型的历史顺序），补了审查指出的自测缺口，见「实施记录 · 第 3 步」的「审查之后改的」。锁定套件零修改，`PREFIX sha256` 与第 1 步相同。
- 半成品：无。
- 阻塞：无。「Open」第 1 步带出的三处：顾问姓名的改写留第 13 步，`/pay` 响应体已按推荐先做，advisor 模式的支付页仍在第 15 步之前定。
- 下一步：第 4 步「迁移：新表、RLS、授权、触发器、清除与删除函数」。先读 spec「数据库」与各节的 DDL、授权表，01 spec 的「迁移纪律」；`HandoffRecord`、`Assignee` 等的字段已定在 `src/shared/conversation-types.ts`，表的列照它们写。

### 交接（2026-10-02，第 4 步）

- 已完成：第 4 步，含审查之后的修复。迁移 `0002_conversations`（drizzle-kit）与 `0003_conversations_rls`（custom，`orders_guard` 管住 `paid_at` 与 `session_id`，清除与删除连带删会话的任务）；`withTenant` 的 `longRunning`、`inTenantTx()`、`writeAuditAs`；`src/db/repo/` 十二个新仓储文件；`deploy/backup.sh` 查库里已有的会话表的数据段（表不存在只告警）；`db.selftest.ts` 不带 PG 465 项、带 PG 861 项（含两条连接的并发用例与列级授权的目录断言）。本机真实 PG 上全过，审查修复的 27 个变异全部杀掉，锁定套件零修改，`PREFIX sha256` 与第 1 步相同。
- 半成品：无。仓储函数还没有调用方（不接进运行时），签名第 5 步起可按需调整。
- 阻塞：无。「Open」第 1 步带出的三处照旧（第 13、15 步之前定）；第 4 步审查带出两处（任务按验收 27 一并删、`orders` 触发器管 `session_id`），已按推荐做了，等 owner 确认并补进 spec，不挡第 5 步。
- 下一步：第 5 步「PG 后端」。先读「实施记录 · 第 4 步」的仓储清单、「注意（第 5 步）」与「审查之后改的」里给第 5、6、10、14 步的注意，以及「实施记录 · 第 2 步」「第 3 步」里给第 5 步的注意（`installPgSessionStore` 放哪儿、孤儿订单归属、`noteWindowReset`、poisoned 之后改宽松模式）。

### 交接（2026-10-02，第 5 步）

- 已完成：第 5 步。`src/store/project.ts`（投影与 `normalizeForStore`，`isDemoClassId`、标记文件名搬来）、`src/store/pg-backend.ts`（预载与校验、每会话写队列与合并、一次落库七步、进快照即冻结、失败两类与 poisoned、冲突即优雅停机、drain、spill 与回放）、`initSessionStore` 的 db 分支、`deleteOrdersOfSession` 作废、重置调 `noteWindowReset`、`chat()` 的 `withTenant` 断言、附带行的入口；`src/db/testing.ts` 的 `installPgSessionStore`（返回依赖与故障注入）、`openFlakyDb`、`createRealPgFixture`、落盘的 PGlite；`store.selftest.ts` 不带 PG 256 项、带 PG 265 项。38 个变异全部杀掉；本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。
- 半成品：无。
- 阻塞：无。「Open」里第 1、4 步带出的五处照旧，不挡第 6 步。
- 下一步：第 6 步「导入导出与切换」。先读「实施记录 · 第 5 步」的「注意（第 6 步）」：`real_in_json` 排在 `openPgBackend` 之前，命令行只用 `project.ts` 与 `src/db/repo/**`，读回比对走预载同一条路。
