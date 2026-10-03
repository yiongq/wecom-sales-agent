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
- [x] 5. PG 后端（5）：2026-10-02 完成，结构、各条取舍与偏离、变异与真实 PG 结果、给第 6、7、9、10、12、13、14、16、17 步的入口与注意见「实施记录 · 第 5 步」。审查之后改了九处（孤儿订单在 JSON 与 PG 之间的交接、同一段同步代码的改动合进一个事务、spill 不投影订单、回放的错误类型与 `.failed` 提示、新会话 COMMIT 晚到、`held_by_other` 之后不写库、`real_in_json` 提前到本步、db 存储下跟进先等落库），补了七组自测，见该节「审查之后改的」；带出「Open」一条。
  - `src/store/project.ts`：`sessionToRow` / `rowToSession`、`orderToRow` / `rowToOrder`、消息的行投影（未知键进 `extra`）、`normalizeForStore`。纯函数，先写往返自测。
  - `src/store/pg-backend.ts`：分批预载（`longRunning`）与 7 天 msgid 集合、每会话写队列与合并（`AsyncLocalStorage.snapshot()` 起落库）、一次落库的七步（spec「identity map 与写入」，含 `flush_id` 与存档点）、进快照即冻结、失败的两类与 poisoned、`StoreConflictError` → 优雅停机、drain 段排空、`spillSync` 与启动回放；`deleteOrdersOfSession` 在 db 存储下作废订单；重置与裁剪体现为窗口推进；demo 类会话仍走 JSON，对它们的审计单独一个事务。
  - `src/db/testing.ts` 加 `installPgSessionStore()`（PGlite 上装好 db 存储，只给自测与 `eval/run.ts` 用）。
  - `store.selftest.ts` 的 PGlite 部分：spec「测试与 CI」列的那些，含模拟崩溃后重启、SIGTERM 发生在一轮中间。
  - 对应验收 4、5、6、8、28 的存储部分，以及不变量 3、4、7–10、12、13、16。
- [x] 6. 导入导出与切换（2.5）：2026-10-02 完成，结构、本步定的九条、自测、变异与真实 PG 结果、给第 7、8、16、26 步的注意见「实施记录 · 第 6 步」。审查之后改了五处（改写 var/ 的顺序与目录 fsync、没有标记时 export 先比对、`--keep` 先验可写、回滚检查打印的命令带端口与租户并分出自动回滚那套步骤、db 存储启动补写标记与回滚检查看 `.env`），补了审查指出的八组自测，见该节「审查之后改的」；带出「Open」一条。
  - `src/cli/import-sessions.ts`（`--keep`、标记文件、`--resync`）、`export-sessions.ts`（删标记）；只用 `project.ts` 与 `src/db/repo/**`，不 import 运行时模块。
  - `initSessionStore` 的 `real_in_json` 拒绝。
  - 测试夹具：一份含真实会话、种子、访客、孤儿订单、`followup`、`quoteHistory`、昵称、旧格式订单号、NUL 与孤立代理项的 `var/`。
  - `store.selftest.ts`：往返、重复导入 0、补完改写 0、内容不同 2、持锁 3、导出 → 文件存储下再聊 → `--resync` → 一致、`--dry-run` 不写库、两个启动拒绝；真实 PG 部分以子进程执行两个命令行并断言退出码。
  - `deploy.sh` 回滚前检查：目标是 02 之前的镜像，而服务器 `var/` 里有标记文件或 `/healthz` 的 `config.catalogVersioned` 为 true 时拒绝，并打印 spec 的回退步骤（`catalogVersioned` 在第 8 步才有，先只查标记文件）。
  - 对应验收 3，以及不变量 14、15。
- [x] 7. 等价套件与 DB 模式 mock eval（1.5）：2026-10-03 完成，套件结构、怎么找漏网的原地修改与错位（没找到新的，产品代码没改）、两边有意不同的地方、变异与真实 PG 结果、留给第 9、10、12、13 步补的项见「实施记录 · 第 7 步」。审查之后改了五处（模型调工具那个转人工会话的原话带上出行时间，第 1 步第 4 处写入点在 PG 上真正兜住；库里核对按会话逐个要求在且通过；逐轮断言模型脚本恰好用完；两个子进程共用父进程定的钟；补记 grep 复查与夹具的 `updatedAt`），只改了测试与文档，见该节「审查之后改的」。
  - `src/store/parity.selftest.ts`：spec「测试与 CI」列的场景，会话 id 用 `wecom:parity-*`，各跑在文件存储与 PG 存储上并比较，断言 PG 里有这些会话。
  - `eval/run.ts` 的 `CONFIG_TEST_DB=pglite` 同时装上 PG 会话存储，会话 id 改用 `eval:<用例>-<时间>`；跑完断言库里有每个用例的会话、消息与内存一致。
  - 用 DB 模式 mock eval 与等价套件找出漏网的原地修改（冻结会抛 `TypeError`）与数组错位（`WindowCorruptError`），逐处改成只追加，改动记进实施记录。
  - 对应验收 2、7。到这一步，存储层的形状定下来了。
- [x] 8. 产品库版本、按轮固定快照、开放五个字段（3.5）：2026-10-03 完成，结构、本步定的十四条、改了的非锁定断言（含 spec 清单之外的几处）、自测、变异与真实 PG 结果、给第 9、10、13、24 步的注意见「实施记录 · 第 8 步」；带出「Open」三条。同日审查之后改了七处、补了五组自测（同一节「审查之后改的」），README 的改动撤回（第 28 步），「Open」另加三条。
  - 上架写版本 1，active 条目每次改动写新版本并更新 `catalog_items.version`（`src/config/catalog.ts` 与 `catalog-fix`），审计 `catalog.version`；全部版本读进内存；启动补写缺失的版本；`/healthz` 的 `config.catalogVersioned`。
  - `pinCatalogForTurn`；引擎的 `handleMessageInner` 与跟进生成包进去。
  - `generate_proposal` 在版本大于 1 时追加 `?v=`；链接白名单、`linksFromCalls`、企微卡片识别接受它；`public/proposal.html` 把 `v` 转给 `/api/proposal/:routeId`；`/proposal/*` 与 `/api/proposal/:routeId` 按版本渲染、只读内存；订单记 `catalogVersion`。
  - 以上都通过之后，`LOCKED_WHEN_ACTIVE` 去掉五个字段；行业包的锁定组与后台保存条的说明跟着改；`config.selftest.ts`、`console.selftest.ts` 里断言这五个字段 422 的用例改成断言能改且产生新版本。
  - 新自测：改价前后旧链接报价不变、新链接带 `?v=2`、`?v=3` 404 且不查库、订单不变、轮内快照一致、改 `title` 仍 422、删掉版本行后重启补写；文件模式下链接逐字节不变。
  - 对应验收 19，以及不变量 35–37。
- [x] 9. 逐轮 trace、护栏事件、用量（3）：2026-10-03 完成，结构、本步定的取舍（含 spec 名单之外记下的三处改写点、outcome 的口径、`endTurn` 多一个可选参数）、自测、变异与真实 PG 结果、给第 10–13、17、18 步的注意见「实施记录 · 第 9 步」。同日审查之后改了五处（连环改写读成相对原稿的净差、企微非文本消息也记一轮、poisoned 会话的遥测丢掉并计数、预载认回 turn_id 先按会话分组、usage_daily 写失败带原因码），补了对应自测，见该节「审查之后改的」。
  - `src/trace/recorder.ts`；`startTurn` / `noteGuard` / `endTurn` 接进引擎（确定性路径也记，两种存储都收集）；spec 列的改写点逐个调 `noteGuard`，名字照 spec；AI 回复经 `WeakMap` 关联 `turnId`；`catalogVersions`；模型调用的 `error` 类别。
  - `usage.ts` 的 `recordUsage` 加 `purpose` 与 `onUsage`；`completeText` 加 `opts`，洞察、建议、代拟、跟进各自传；`retrieval.ts` 传 `embedding`；`usage_daily` 的累加与 30 秒 upsert，drain 段写一次。
  - 后台读接口的仓储函数先写好（第 13 步挂接口）。
  - 新自测：价格护栏删句那一轮有 trace 与一行 `price` 事件、`removed` 正确；没改文本的护栏不记；用量合计与 `recordUsage` 收到的相同（含 embedding）。
  - 对应验收 20 的数据部分、21。
- [x] 10. 任务表与跟进（3）：2026-10-03 完成，结构、本步定的九条（签名、排程挂在落库上、执行体的顺序与明确失败后的重排、重启与停机、`guardOutbound` 的同一套护栏、拒绝识别的口径、两种只排程的任务、改了的非锁定自测）、自测、变异与真实 PG 结果、给第 12、13、14、16、17 步的注意见「实施记录 · 第 10 步」；同日审查之后改的九处（拒绝识别按整条消息判并先归一、重试用完与额度不够不再重排、认领令牌、结果补写、跟进话术的链接与联系承诺交给护栏、重置取消通知）见其中「审查之后改的」。
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
  - 旧接口匿名投影里，交还时那条「{姓名}把会话交还 AI」改写成「顾问把会话交还 AI」（spec「后台接口」匿名投影一条；`server.ts` 的 `anonMessage` 留了位置），自测覆盖接手并交还种子会话之后的匿名读。
  - 对应验收 9、10、11 的接口部分，以及不变量 17、20–25、27、28、31、39 的接口部分、41、43–45、47。
- [ ] 14. 外部通知（1.5）：`Notifier` 的企微群机器人实现（开放问题 3，与告警不同群）、`handoff_notify` 任务的执行体（立即、10 分钟仍没人接手、窗口剩不到 4 小时、advisor 模式下待确认的订单、已成交客户要人工）；带转人工的落库失败时的 `unsaved` 通知；`NOTIFY_WEBHOOK_URL` 进 `.env.example` 与 compose 的 app 服务说明，日志脱敏。自测用假的 webhook 服务断言内容里没有客户原话和 `external_userid`。对应验收 15 的外部通道部分，以及不变量 10 的例外、32。
- [ ] 15. 收款流程与 SOP 措辞（3.5）：
  - `src/payment/`：`paymentMode`、`confirmOrder`、`markPaidByAdvisor`、`cancelOrder`（坐席只限接手人本人；提交之后才发付款确认）；后台的三个订单接口接上；advisor 模式下 `create_order` 的 `payNote`、`/pay` 页的说明、价格规则护栏的替换句、`repairLinks` / `placeLinks` 的说明句、重发链接、成单安全网、企微支付卡片、跟进 closing 段的确定性文本；online 模式逐字节不变。
  - `data/sop.md` 锁定节的两处改动、`SOP_KNOWN_FIELDS` 与旅游包 `sopFields` 加 `payNote`；契约清单短语一条不删。记下改前改后的四个哈希（`/healthz` 与 `PREFIX sha256`）。
  - 真实模型回归（花钱，不进 CI）：按 01 交接里的「真实模型对比」跑法，`--cases` 指向仓库外的 realOnly 用例文件，文件、DB 交替各至少 3 遍，记 p90、命中率与通过的用例集合，和改动前比较。
  - advisor 模式下收款方式只经 `/pay/:orderId` 的服务端注入，`/pay.html?orderId=` 跳到 `/pay/:orderId`（spec「收款流程」、验收 23）。
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
- [x] 18. 可观测性：运行数字与 OpenTelemetry（2.5）：2026-10-03 完成（先于第 17 步，另开一条线与第 10–13 步并行，`ops.selftest.ts` 由本步新建），结构、依赖与版本、本步定的十一条（`days` 1–90 与自然日窗口、`exportTurn` 收 `FinishedTurn`、会话 ref 在内存里、spec 之外加的几个属性等）、自测、变异与真实 PG 结果、给第 13、17、21 步的注意见「实施记录 · 第 18 步」。同日审查之后改了七处（没有 ref 的会话用按会话 id 算的匿名引用、`gen_ai.provider.name` 不写 `_OTHER`、每个 span 带 `gen_ai.conversation.id` 与出错的根带 `error.type`、执行时抛错的工具记真实耗时与失败、核对依据改成 semantic-conventions-genai、窗口按租户的 trace 保留期截断、停机按 drain 段的截止时刻放弃导出），补了对应自测，见该节「审查之后改的」。
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
  - [x] 20.1 先修后台 UX plan「Open」第 1 条：`popupRegion` 包的下拉菜单键盘打不开（照列表筛选的写法，确认点弹层空白处不抢输入框焦点）；话术页、条目详情的「更多」一起受益（0.5）。2026-10-03 做完（分支 `fix/02-step20-1-popup-keyboard`），见「实施记录 · 第 20.1 步」。
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
  - 发版与 README（owner 2026-10-03 定）：02 全部做完、验收通过之后才发版到 main（连同 dev 上已有的后台 UX 改造）；README 在这时对照最终实现一次更新，之前不改。2026-10-03 核对过一遍 dev 上的 README，要改的要点：第 48 行「无数据库、无前端框架」已不成立（01 起有 Postgres 与 Vite + React 后台）；架构图只画了文件模式，缺后台、Postgres 与两种会话存储，`销售SOP.md` 应为 `data/sop.md`，`markPaid` 应为 `markOrderPaid`，工具框缺搜酒店与方案书；在线体验表缺 `/console/` 一行；可靠性设计缺价格规则与服务承诺护栏（`price-rules.ts`）、确定性转人工、注入防护与如实回答是 AI；区间写法 `~~` 在 GitHub 上渲染成删除线，改用 en dash；引导页是四步不是三步；本地跑法与门禁一节的自测数量、单独跑某组的命令、`lint` 与 `typecheck` 的组成、权限表与账号说明已过时；部署一节缺 `/console/` 账号与 DB 模式、会话存储切换与回滚检查；「生产化路径 / 当前刻意不做」里单实例、内存为权威、Redis、消息队列（任务表已在 02 做了）、限流计数几条要按 01、02 的现状重写；企微一节的回调地址写法要去掉「公网 IP」；部署一节「回到文件模式或更早的版本」加两条（第 8 步原来加在 README 里，2026-10-03 撤回、留到这时写）：后台改过已上架条目的内容（`/healthz` 的 `config.catalogVersioned` 为 true）之后，deploy.sh 拒绝回到 02 之前的镜像——02 之前的镜像不写条目版本，那期间发出的方案书链接回到 02 之后会按版本 1 显示旧价，回到文件存储也去不掉这一条，要回滚只能回到 02 之后的镜像；同一个 02 镜像去掉 `CONFIG_SOURCE=db` 回到文件模式时，`?v=2` 及以上的已发链接全部打不开（404）、不带 v 的旧链接按导出时的新内容显示（「Open」第 8 步审查带出的第三条，告警做没做以那时为准）。第 9 步带出的：可靠性 / 可观测的说明加上 db 存储下每轮的 trace 与护栏改写记进库（`turn_traces`、`guard_events`；trace 里有客户原话与工具参数，保留期见第 16 步），模型用量按天、按模型与用途累加进 `usage_daily`（每 30 秒与停机时写），`usage.json` 照旧；文件存储下 trace 只在内存。第 10 步带出的：自动跟进一节写明两种存储的调度不同（文件存储是每 `FOLLOWUP_SCAN_MS` 一次的扫描器，db 存储由任务表按阶段阈值排程、每 5 秒认领、客户回话即取消、夜间顺延到 9:00），两种存储下跟进话术都过与 AI 回复同一套出口护栏、客户说「不用了」「别发了」之后不再跟进、跟进消息在后台标「自动跟进」；可靠性设计里「跟进最多发一次」的说法改成「记账与任务的 sending 一起提交之后才推送，推送途中崩溃重启后记 abandoned、不重发」；「生产化路径 / 当前刻意不做」里消息队列一条按任务表（`jobs`，转人工通知与保留期清理也在里面）重写。第 18 步带出的：可观测一节加上后台的运行数字（`GET /api/console/metrics?days=`，所有者与管理员可看，只在 db 存储，60 秒缓存，四个数的口径）与 OpenTelemetry 埋点（设了 `OTEL_EXPORTER_OTLP_ENDPOINT` 才加载，每轮一条 trace，属性按 GenAI 约定加 Langfuse 的会话属性，会话用 ref（没有 ref 的文件存储与 demo 类会话用进程内的匿名引用）；默认不导出原文，`OTEL_CAPTURE_CONTENT=1` 才导出客户原话、最终回复与工具参数，任何时候不导出 external_userid），环境变量一节加 `OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_CAPTURE_CONTENT`。
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
  - `src/store.ts`：`initSessionStore` 的 db 分支（先拒绝重复装上与 `real_in_json`，再装上后端、登记 drain 段 `drainStore(剩余预算)` 与 late 段 `close()`）；`saveSession` 先经 `accepts` 查 identity；订单按 `pgFor`（db 存储、真实会话、而且会话在内存里）路由，否则归文件后端；`deleteOrdersOfSession` 在 db 存储下逐张 `voidOrder(o, 'reset')` 再移出内存；新导出 `queueAudit`、`queueJobs`、`queueConsents`、`queueTelemetry`、`recentMsgids`、`noteWindowReset`、`__storeTest.pgStats()`。文件存储下每个分支都退回原来的调用，行为逐字节不变（锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变）。
  - 其余：`src/engine.ts` 的重置在 `messages = []` 之前调 `noteWindowReset(session)`；`src/llm.ts` 的 `chat()` 入口 `inTenantTx()` 为真就抛；`src/db/client.ts` 加 `pgErrorOf`（沿 cause 链取错误码与约束名）与 `trySavepoint`（回到存档点成功就返回 `{ ok: false, error }`，回不去才抛）；`src/db/repo/messages.ts` 加 `readRecentCustomerMsgids`、`readMessagesFrom`；`src/config/source.ts` 加 `tenantLockTaken()`（重取得到 `held_by_other` 时置真）。
  - 测试装配（`src/db/testing.ts`）：`openTestDb({ dataDir })` 能落盘、能再打开（被 SIGKILL 之后也行）；`installPgSessionStore(t, { varDir })` 建租户、切成 `agent_app`，返回 `{ deps, faults, stats }`：`deps.db` 是同一个 PGlite 上另开的 drizzle 实例，故障注入（`acquire` 抛、`skipAcquires` 先放过几次、`gate` 卡、`releaseOnce` / `skipReleases` 模拟 COMMIT 之后回包丢失）与计数（含发过的 `set transaction …`）只管它，查询不进 `queryCount()`；调用方自己 `initSessionStore(fixture.deps)`（依赖规则不许 `src/db/` import store，没开例外）。另有 `fakeDbError(code)`、`openFlakyDb(url)`（node-postgres：放过 `skipCommits` 条之后让 COMMIT 照常执行、回包丢掉；`delayCommitMs` 时客户端先收到断线、COMMIT 稍后才到库）、`createRealPgFixture(superUrl)`（建临时库、按 `roles.sql` 建角色、迁移、建租户；`src/store/` 下的套件不能 import `pg`，所以放这里）。
- spec 写得不够、本步定的（选最小、最贴原文的）：
  1. **何时取快照**（审查之后改）：每个入口（`saveSession`、`voidOrder`、`scheduleOrder`、`emitAfterCommit`、`queue*`）只标脏，起落库推迟到 `queueMicrotask`：在 microtask 里同步取快照、起落库（不去抖）；有在途的就等它提交之后接着取下一次。同一段同步代码里的改动因此合进同一个快照、同一个事务（引擎重置里的作废订单、清转人工、重置回复与 `saveSession`；建单与 `orderIds.push`），库里不会留下半个重置。`schedule` 照旧同步分配 seq，并把分配到的消息当场 `Object.freeze`：「进快照即冻结」提前到 `saveSession` 返回之前，之后再改这条消息立刻抛 `TypeError`，与起落库的时机无关。
  2. **flush_id**：每个快照一个，同一快照的重试沿用（spec「flush_id 是上一次重试的值」）。重试时先看 flush_id：库里是本快照的且 last_seq 等于快照最后一条 → 已提交，回滚本事务、补做提交后的步骤；是本快照的而 last_seq 不对 → 冲突；不是本快照的再比 last_seq。先看 flush_id 是为了没有新消息的快照（只改会话投影、只带审计）：它的 last_seq 本来就等于「已提交到第几条」，按 last_seq 判会重写一遍、审计记两行。
  3. **重试**重做同一个快照；退避期间来的改动排在它提交之后的下一次，不并进重试。
  4. **失败分类**：SQLSTATE 22、23、42 类、`WindowCorruptError`、`ProjectionError`（时间不是有限的毫秒数）、不带 code 的 `TypeError` / `RangeError` / `SyntaxError` → 不重试、poisoned；`StoreConflictError` → 冲突；其余（spec 点名的 08、40001、40P01、57014、53、57P，spec 没点名的类，errno 码，不带 code 的「连接意外中断」）→ 退避重试。spec 没点名的类按重试处理：不丢数据，积压在 `/healthz` 看得见。`lastError` 形如 `23514 conversations_id_check · 7F3A`。
  5. **poisoned** 之后对这个会话改用 `assignSeqs(s, 'lenient')`，`flushSession` 立即以 `StoreLaggingError` reject；失败的那个快照留在「在途」位置不再重试，停机时连同之后的改动写进 spill。
  6. **spill 文件**（`var/store-spill-<ISO 时间，冒号与点换成 ->.json`，先写 `.tmp` 再改名）：每个会话一条，除了 spec 列的（已提交到第几条、没提交的消息连同 seq、会话投影、排着的订单与审计），还写在途那次的 `flushId` / `lastSeq` 与它的附带行（分开记）、一个回放用的 `flushId`、排着的任务与同意记录（spec 没列，按不变量 13「没落库的改动要么已提交，要么在 spill 里」一并写；trace 与账本行照 spec 不写）。回放按会话逐条：库里是这一条的回放 flush_id → 已回放过，跳过；库里是在途那次的 flush_id 与 last_seq → 在途那次其实提交了，只补它之后的消息与附带行；库里的 last_seq 等于「已提交到第几条」→ 按一次落库写入；库里已经等于文件里最后一条的 seq 且内容一致 → 跳过（spec 原文）；其余 `spill_conflict`（点名短码，文件留着）。别的租户的 spill → `spill_conflict`；读不出来（不是 JSON，或 `version`、`sessions` 对不上）的文件、有一条回放仍失败（数据类）的文件 → 改名 `.json.failed`、记一行（点名已回放与失败的会话短码，写明要人工处理、不要直接改回原名），从库里的状态起；读写文件出错与其余意外错误 → `spill_conflict`（detail 只有文件名与 `错误名/errno 码`）；回放时连不上库 → `db_unreachable`。全部成功就删掉文件，再预载一遍。订单在 spill 里存 `normalizeForStore` 之后的原始对象与作废信息，回放时才投影（审查之后改）。
  7. **预载**每批四条语句（会话行、窗口内消息、未作废订单、7 天 msgid），整个预载一个 `REPEATABLE READ READ ONLY` 的 `longRunning` 事务。校验：窗口内消息条数等于 `last_seq − window_start_seq + 1` 且 seq 逐条连续（否则 `preload_integrity`）；订单 `data.sessionId`、`data.id` 与列一致、会话在这一批里（否则 `orphan_order`）；有 demo 类 id（表上的 CHECK 本来就拦，纵深防御）→ `demo_class_in_db`；预载里的库错误一律 `db_unreachable`（带错误码）。企微去重集合 = 预载的最近 7 天（按 `at`，不看窗口）加上本进程分配过 seq 的客户消息的 msgid，`recentMsgids(id)` 读它（文件存储下为空）。
  8. **消息投影**：已知字段的取值放不进列的（customer 带 author、非 human 带 authorName / authorId、authorId 不是 uuid、msgid 不是串、sentAt 不是数）原值进 `extra`、列为 NULL，重建时 `extra` 盖在列上，`messages_author_human_check` 的 NULL 语义由此守住（自测断言行投影里没有一条「没有 author 却带操作者」）。`author='human'` 的消息重建时一定带 `authorId`（列为 NULL 时写 `null`）：共享工作台的 `authorId: null` 原样往返；没有 `authorId` 键的 human 消息往返后多一个 `null`（不变量 17 要求必带，02 之前的数据没有 human）。`assignee_user_id` 有外键到 `users`，写进不存在的 user id 会 23503、poisoned（第 13 步写入真实成员 id）。
  9. **identity map**：`saveSession` 收到同 id 的另一个对象 → `accepts` 拒绝（日志一行、`foreign` 计数），既不落库也不换掉 map 里的。
  10. **不是预载来的会话**只剩新建的这一种（审查之后：JSON 里的真实会话在启动时以 `real_in_json` 拒绝，提前到本步），seq 从 1 起。建写队列时窗口里已有 seq 的消息仍整段算没提交（防御，不会只写尾巴留下空洞；正常走不到）。
  11. **孤儿订单**：所属会话不在内存里的订单归文件后端（`orders.json`），改动照写；同 id 的会话建出来时被收养、转进它的写队列，随第一次落库写进库。审查之后：提交之前仍归文件后端，提交之后 orders.json 才去掉它；启动时 orders.json 里属于预载会话的订单以库为准（见下面「审查之后改的」第 1 条）。
  12. **附带行的入口**：`queueAudit`（真实会话随落库写，各自带操作者与 IP；db 存储下的 demo 类或内存里没有的会话单独一个短事务，只试一次、失败记一行；文件存储下不写，会话类审计在文件存储下的去处第 13 步定）；`queueJobs`（`enqueue` / `cancel` / `status` 三种，时间是毫秒）、`queueConsents`、`queueTelemetry`（`traces` / `guards` / `outbound`，写在 `SAVEPOINT telemetry` 里）只对 db 存储的真实会话，其余丢弃（R6、R16）。本步只有订单与审计有生产者，其余由自测直接调。
  13. **旧 `/api/admin/stream`**：db 存储下真实会话每次提交之后发 `storeEvents` 的 `change`（与文件后端一样约 200ms 合并一次），提交失败不发。不发的话 db 存储下 `admin.html` 对真实会话不再刷新；不变量 10 本来就要求「提交之后」。文件存储下仍是文件后端在每次去抖落盘后发（照旧不论成败，改成提交后发归第 13 步）。
  14. **停机**：drain 段把退避中的重试立即再试一次，在预算内等所有非 poisoned 的会话提交；已冲突或 `tenantLockTaken()` 时不写库，直接返回全部积压（日志只写短码）；审查之后 normal 段里也不写（`kick()` 与退避定时器都看 `writable()`）。late 段 `close()`：此后不起新的落库、退避的定时器清掉；还在途的那次要么提交（spill 里就没有它），要么失败（留给 spill）。冲突时 `onConflict` → `gracefulExit(1, 'store_conflict（会话 短码）：落库撞上另一写者')`。
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
  - `real_in_json` 拒绝已经在本步做了（审查之后提前：`initSessionStore` 的 db 分支在 `openPgBackend` 之前查内存里有没有不是 demo 类的会话，detail 提示 `import-sessions`）；第 6 步只加命令行与补完改写，别再加一份。
  - `insertConversation` 主键冲突时返回 null、不报错（审查之后改）：导入要自己先判断行在不在（重导比对、`--resync`），不能靠它报 23505。
  - 启动时 orders.json 里所属会话在库里的订单以库为准（库里有就删 JSON 副本、让文件后端重写，没有就挂到会话的写队列上）。导入改写 JSON 时照样去掉进了库的订单；`--resync` 作废时别把作废订单再当活订单 upsert：库里不拦 `voided_at` 写回 NULL，只有应用层守。
  - 命令行只用 `project.ts`（`isDemoClassId`、`SESSIONS_IN_DB_MARKER`、投影）与 `src/db/repo/**`：导入用 `insertConversation(tx, values, seqs)` 一次写好、`insertMessages`、`upsertOrders`；读回比对走预载同一条路（`readConversationsAfter` / `readWindowMessages` / `readLiveOrders` 加 `rowToSession` / `rowToMessage` / `rowToOrder`），两边都先 `normalizeForStore`；`--resync` 的作废用 `orderToRow(o, { at, reason: 'resync' })`。
  - 导入时 `var/` 里若有 `store-spill-*.json` 或 `.failed`，要先处理（回放或人工确认），否则切到 db 存储时会被回放进去。
- 注意（第 7 步）：等价套件与 DB 模式 eval 用 `installPgSessionStore(t, { varDir })` 后 `initSessionStore(fixture.deps)`；冻结会让漏网的原地修改抛 `TypeError`，数组错位会让会话 poisoned（`storeHealth().poisoned` 点名），两种都要当失败报出来。`server.selftest.ts:835` 那种原地改 `at` 的写法不能照搬。
- 注意（第 9 步）：trace 经 `queueTelemetry(sessionId, { traces, guards })`，行是 `TurnTraceRow` / `GuardEventRow`（护栏名要满足 `^[a-z_]{2,40}$`，否则那一批在存档点里丢掉）；demo 类与文件存储下这几行不入库。用量的 drain 段写入另挂一个 drain 钩子，不经会话写队列。
- 注意（第 10 步）：任务经 `queueJobs`（`enqueue` 的 `payload` 必带 `sessionId`，第 4 步约定），随会话落库提交、也写进 spill；认领（`claimDueJobs`）是任务自己的短事务，不经会话写队列。第 10 步之前，db 存储下的旧扫描器在推送前 `await flushSession(id, { timeoutMs: 5000 })`、记不上账就不推（`followup.ts`，审查之后加）；换成任务表的「记账提交后再推送」时连同这一段一起去掉。
- 注意（第 12 步）：去重的情况 2 读 `recentMsgids(id)`；账本行经 `queueTelemetry(id, { outbound })`，`msg_send_fail` 的状态更新（`setOutboundStatus`）单独一个短事务。
- 注意（第 13 步）：`reply` 等的「积压超过 5 秒、已冲突或 poisoned → 503」读 `storeHealth()`（`flushSession` 对 poisoned 与冲突立即 reject）；`/status` 的 poisoned 短码就是 `storeHealth().poisoned`；console 写接口的审计走 `queueAudit`，文件存储下会话类审计的去处在这一步定；`assignee.userId` 写真实的成员 id（外键到 `users`）。
- 注意（第 14 步）：带转人工的落库失败时的 `unsaved` 通知要挂在 `pg-backend.ts` 的 `failed()` / `poison()` 上（现在只记日志）。
- 注意（第 16 步）：清除函数删掉会话之后，内存与写队列都要同一个 tick 摘掉它（`pg-backend` 还没有 `forget(id)`，要加）；否则这个会话的下一次落库发现行不在了，按 `StoreConflictError` 处理，整个进程优雅停机。
- 注意（第 17 步）：告警挂在 `poison()`（poisoned）、`failed()` 的冲突分支（`store_conflict`）与 `storeHealth().lagMs`（积压）；慢事务与存档点丢弃有计数（`__storeTest.pgStats()` 是自测口子，告警另开读法）。
- 审查之后改的（2026-10-02）：
  1. **孤儿订单在 JSON 与 PG 之间的交接**（审查 spec[0]、equivalence[0]、concurrency[4]）。被收养的孤儿订单在它随所属会话在库里提交过一次之前仍归文件后端：PG 后端记「已收养、未提交」的订单 id，`ownsOrder` 也看它（`adoptedUncommitted`），这段时间 demo 落盘照写 orders.json，崩溃不丢；含它的那次落库提交之后，经新依赖 `ordersTaken` 通知 store，`fileBackend.markChanged` 让 orders.json 去掉它。启动时预载事务的最后按 id 查 orders.json 读进来、所属会话是预载会话的那些订单（`readOrderIdsIn`，作废的也查）：库里有就删掉内存里的 JSON 副本并 `markChanged`（没作废的由预载的那份顶上，作废的不再复活），库里没有就挂到这个会话的写队列上（提交之前同样归文件后端）。作废的订单不再进写队列：本进程记作废过的 id，`scheduleOrder`、取快照、spill 都跳过它，`upsertOrders` 不会把 `voided_at` 写回 NULL；只在应用层守，库里不拦（触发器只管 `paid_at` 与 `session_id`）。取舍：收养之后、提交之前对这张订单的改动只进 PG 的写队列，orders.json 那份要等下一次文件落盘才跟上，崩溃时 orders.json 里可能是改动之前的样子，与「没提交的落库随崩溃丢失」同一口径，没为它双写。
  2. **同一段同步代码里的复合改动合进一个事务**（spec[1]、concurrency[3]）：见上面取舍 1 的新说法。代价：`saveSession` 返回时落库还没起，自测要先让 microtask 跑完才算「在途」（用 `setImmediate` 等一下）；在 `withTenant` 回调里调 `saveSession`，microtask 排在回调的异步上下文里，起落库照旧进空上下文（有用例）。
  3. **spill 里的订单存原始对象**（spec[2]）：`SpillOrder` 存 `normalizeForStore(o)` 与作废信息，不在 spill 时投影；排着的作废（`voids`）也改存原始对象、取快照时才投影，投影失败只让会话 poisoned，作废照样写进 spill。回放时投影，失败照规则改名 `.failed`。
  4. **回放 spill 的错误类型**（spec[3]）：先校验 `version === 1` 与 `Array.isArray(sessions)`，对不上与 JSON 解析失败一样改名 `.failed`；`readdir`（`ENOENT` 以外）、读文件、改名、删除出错与其余不是 `SessionStoreStartupError` 的错误都包成 `SessionStoreStartupError('spill_conflict', '<文件名>：<错误名>/<errno 码>')`。`store.ts` 里重复装上改抛 `SessionStoreStartupError('sessions_in_db', …)`：现有几个 reason 里只有它的字面意思（会话已经由库管着）贴得上，只有调用方调两次才会碰到（自测、eval），detail 写明「只能调一次」。两处都没新增 reason，见「Open」。
  5. **`.failed` 的恢复提示**（concurrency[0]）：日志不再叫人「改回原名再启动」（文件里已回放的会话之后再写过库，改回原名必然 `spill_conflict`），改成写明要人工处理、不要直接改回原名，点名文件里哪些会话已回放、哪些失败（短码与错误码）。spec 原文只承诺「改名 `.failed`、告警、从库里的状态起」，没承诺改回原名能重放；怎么人工补（只重放失败的那几条，还要处理与之后新消息撞号的 seq）不在本步。
  6. **新会话首次落库 COMMIT 断线、服务端稍后才提交**（concurrency[1]）：`insertConversation` 改成 `ON CONFLICT (tenant_id, id) DO NOTHING`、冲突返回 null；`writeSnap` 拿到 null 就再 `lockConversation` 一次（插入在主键上等到对方提交才返回，这时锁得到），照常走 flush_id 与 last_seq 的判定；`replayEntry` 的插入同样，锁到之后按库里的行重新判定。
  7. **租户锁被别的进程拿走之后不写库**（concurrency[2]）：`kick()` 开头与退避定时器到点时都看 `d.writable()`，不可写就不起落库，改动（与失败那次的在途快照）留给 exit 时的 spill。从锁丢失到发现 `held_by_other` 之间（至少一个 `reacquireMs`）仍会写，这一段管不到。
  8. **db 存储下 JSON 里的真实会话**（equivalence[1]）：spec 的 `real_in_json` 拒绝提前到本步。`initSessionStore` 的 db 分支在预载之前看内存里（导入期读进来的 sessions.json）有没有不是 demo 类的会话，有就以 `real_in_json` reject，detail 给条数与至多 5 个短码、提示跑 `import-sessions`；JSON 原样不动，库不碰。第 6 步的命令行与补完改写照旧在第 6 步。取舍 10 照实改了。
  9. **db 存储下跟进的「先记账再推送」**（equivalence[2]、concurrency[5]）：`followup.ts` 在 `flushStoreNow()` 之后，`sessionStoreMode() === 'db'` 且是真实会话时 `await flushSession(id, { timeoutMs: 5000 })`，失败记一行、不推送（账已记在内存，宁可漏一条不重发，与 at-most-once 一致）。文件存储下不进这个分支，行为一个字节不变（锁定的 `llm.selftest` F1 照过）。没为它加自测：db 存储下的扫描器第 10 步就换成任务表。第 10 步的注意补了一句。
  - 没改的一条：concurrency[6]（另一写者只改投影、不推进 `last_seq` 时会被静默覆盖，建议另比 `committedFlushId`）。核实为与 spec 一致（一次落库第 2 步与 R4 只比 `last_seq`），属于纵深防御的增强，不做。
  - 补的自测（`store.selftest.ts`，不带 PG 256 → 294 项，带 PG 265 → 304 项，约 45 秒；`db.selftest.ts` 不带 PG 465 → 466、带 PG 861 → 862 项，多一条 `insertConversation` 冲突返回 null、不改那一行）：
    - drain 段接线（tests[0]）：20 轮之后停机前的最后一次落库用 `fakeDbError('08006')` 卡在 1 秒退避里，SIGTERM 之后只有 drain 段立即重试才排得空，断言没有 spill；mock LLM 延迟 6 秒的那一轮里回复那次落库同样卡在退避里，normal 段的钩子等这一轮结束才清故障，断言之后没有 spill、下一次启动没有回放。
    - spill 的在途附带行（tests[1]）：断库之后同一段同步代码里先 `queueAudit` / `createOrder` / `queueJobs` / `queueConsents` 再 say，让在途快照真带上它们；之后再排一份留在顶层；另一个会话断库前有一张提交过的订单，断库期间作废。断言 spill 里分开记了在途与顶层的附带行、作废带着作废信息；回放之后审计、任务、同意记录都在库里，作废已写，重启后 `getOrder` 拿不到作废单，在途快照里新会话的订单也进了库。回放单元用例补「inflight 带审计、库里 flush_id 不是它」。
    - 数据类错误不重试（tests[2]）：id 超长那条等过第一次退避（1.2 秒）之后断言 `retries` 不变、`attempts` 只加 1；分类表的 data 要求 poisoned 且重试增量为 0，retry 要求没有 poisoned 且增量为 1。
    - 别的租户的 spill（tests[3]）：用一条换成本租户就能干净写入的 entry，断言 detail 里写明不是本租户、库里没多出消息、文件留着。回放的接续判定另补两条手造的库状态：库里是这一条的回放 flush_id 而 last_seq 不对、库里是在途那次的 flush_id 而 last_seq 不对，都要 `spill_conflict`。
    - 孤儿订单（tests[4] 与第 1 条）：`markOrderPaid` 之后只 `drainStore`、在 demo 落盘之前读 orders.json；收养之后 PG 暂时不可写、先来一次 demo 落盘，orders.json 里仍有它、库里还没有；提交之后 orders.json 去掉它。落盘的 PGlite 上两次启动：收养 → 提交 → orders.json 去掉它 → 重置作废 → 重启时 orders.json 里塞回作废订单的旧副本：`getOrder` 是 undefined、改单与付款都不碰它、库里仍是作废、orders.json 重写之后没有它；另一张属于预载会话、库里没有的订单挂到写队列上，提交后进库、JSON 去掉它。
    - 复合改动（第 2 条）：真引擎「重置」一个带订单、已转人工的会话，第一次借连接放行、之后都失败：断言只借了一次连接、库里全是重置之后的样子（阶段、转人工、订单引用与作废、窗口起点、重置回复）。写队列补「同一段同步代码里十次 `saveSession` 合进一次落库」，原来的「在途期间合并成下一次」改用闸门卡住第一次。
    - spill 不投影订单（第 3 条）：收养一张 `createdAt` 为 null 的孤儿单 → 会话 poisoned → `spillSync` 照样写出这个会话的两条消息与原始订单。
    - 回放的错误类型与 `.failed`（第 4、5 条）：缺 `sessions`、`version` 不认识的文件改名 `.failed`、照常启动；同名目录（`EISDIR`）以 `spill_conflict` 拒绝、detail 只有文件名与错误码；一个文件里一条回放成功、一条失败，日志点名两边、要人工处理、不叫人改回原名；装上之后再调一次 `initSessionStore` 以 `sessions_in_db` 拒绝。
    - 新会话首次落库 COMMIT 晚到（第 6 条，真实 PG）：`openFlakyDb` 的 `delayCommitMs` 让客户端先收到断线、COMMIT 1.5 秒后才到库；1 秒后的重试认出已提交（`recognized` 1）、不 poisoned、seq 1–2 不重复、库里一行。
    - 租户锁被拿走（第 7 条）：`held_by_other` 之后 `saveSession` 不起落库；退避还没到点时 drain 也不提前试；退避到点的重试也不发，库里没有新写入；子进程退出时的 spill 里有这一句。附带行另补「在途期间排进来的审计随下一次落库写」（同步合并之后，原来的用例碰不到在途期间）。
    - `real_in_json`（第 8 条）：主进程的 sessions.json 里有两个真实会话，db 存储启动以 `real_in_json` 拒绝（db 给的是空对象，证明预载之前就拒了），detail 只有短码，JSON 两个文件原样不动。
    - 细节（tests[5]）：退避经 drain 立即重试连走五次，`lastRetryDelayMs` 依次 1000、5000、30000、120000、120000；late 段之后（落盘 PGlite 的最后一次启动里，排在 store 的 late 钩子之后）`saveSession` 不起落库；预载事务发出 `set transaction isolation level repeatable read read only`；在途期间 `lagMs` ≥ 20；带 msgid 的客户消息进去重集合。
    - 子进程链的诊断（tests[6]）：`JSON.stringify(undefined).slice` 那类写法换成能处理 undefined 的 `brief()`；disk 子进程的启动结果不是预期的那个时，把 `startup` 与 `startupDetail` 记成失败打出来（预期 `spill_conflict` 的两次照旧）。
  - 变异（源码拷进 scratchpad 的三个隔离副本，逐个打、只跑 `store.selftest`；真实 PG 的用例改密码会互相撞，带 `PG_TEST_URL` 的一个一个跑）：74 个，全部杀掉。审查报的存活变异 18 个（S02、S03、P20–P25、P31、P33、P36–P38、P40、P45、P46、S04、S07）都变红，各自死在上面对应的那条断言上（S03 由一轮中间 SIGTERM 那组杀掉：钩子挪进 normal 段时回复那次落库进了 spill）。这次改动的代表性变异 18 个也都杀掉：第 1 条 `ownsOrder` 不看已收养、提交后不通知、启动不删 JSON 副本、启动不收养、收养不记「未提交」；第 2 条同步起落库、`schedule` 不冻结；第 3 条 spill 时投影订单；第 4 条不校验结构、不包文件系统错误、重复装上抛普通错误；第 5 条日志改回「改回原名再启动」、不点名会话；第 6 条插入不带 `ON CONFLICT`、冲突后不再锁（这两个只有真实 PG 的用例杀得掉）；第 7 条 `kick()` 不看 `writable()`、退避定时器不看；第 8 条不查 `real_in_json`。审查那一轮的其余 38 个也都杀掉，其中 P29、P30（回放时 flush_id 对上而 last_seq 对不上，照样按已回放跳过、按在途已提交补写）当时也存活、不在清单里，补了上面两条手造库状态的用例。改的过程中漏过三个：P03b（在途期间排进来的审计在提交后被清掉）与 P39（drain 不看 `writable()`）被 microtask 合并与 `kick()` 的新检查盖住了，各补一条用例；F7b 是用例的等待差 40 毫秒没跨过 1 秒退避，拉长之后杀掉。没列的两个：P05（第一个 await 之后才取快照）不再适用；P41（非预载会话窗口里已有 seq 的消息不算未提交）在 `real_in_json` 提前到本步之后走不到，是等价变异。
  - `pnpm test` 带 `PG_TEST_URL` 与不带各跑一遍，都全绿，PASS 行 60；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。

### 第 6 步 · 导入导出与切换（2026-10-02）

- 结构：
  - `src/cli/session-transfer.ts`：`importSessions` / `exportSessions` 与退出码 `EXIT`，自测直接调；`src/cli/import-sessions.ts`、`export-sessions.ts` 是薄包装（`DATABASE_URL`、`holdTenantLock` 取锁，import 的 `--var` 缺省与应用相同：`VAR_DIR`，没设就是 `./var`）。只 import `src/store/project.ts`、`src/db/repo/**`、`src/db/client.ts` 与 `src/shared/**`，`isDemoClassId` 用 project.ts 的（check-boundaries 照过）。
  - 读法共用：`src/db/repo/conversations.ts` 加 `readSessionBatch`（会话行、窗口内消息、未作废订单三条语句）与 `orderLikeConversations`；`src/store/project.ts` 加 `rebuildSessions`（按会话分组、窗口与 `last_seq` / `window_start_seq` 对不对、`rowToSession`）与 `SESSIONS_JSON`、`ORDERS_JSON`、`SPILL_FILE_RE`。`pg-backend.ts` 的预载、`file-backend.ts` 的文件名改用它们，行为不变（第 5 步的预载与校验自测照过）。命令行的首次读回、「已有会话」的比对、`--resync` 之后的读回、export 都走这一条。
  - `deploy/rollback-guard.sh`（在服务器上跑）与 `deploy.sh` 的 `guard_rollback`（经 ssh 把本地这份交给 `bash -s`），两处调用；README「回到文件模式或更早的版本」与 `deploy/compose.yml` 开头补了用法。
- spec 写得不够、本步定的（选最小、最贴原文的）：
  1. **首次导入的分批与读回**：先用 `orderLikeConversations`（`unnest` 之后 `order by`，库的缺省排序规则，与 `readConversationsAfter` 的分页同序）把这些 id 排好，按这个顺序每 500 个一批写。库里本来没有会话，所以写完一批，「上一批最后一个 id 之后的 500 个」正好是这一批，也就是启动预载的那一页：每批写完按 `readSessionBatch` + `rebuildSessions` 读回、逐个与 `normalizeForStore` 之后的 JSON `deepStrictEqual`，再核对读回的个数。按 JS 的字符串序分批不行：它和库的排序规则（如 en_US.utf8）不同，写的一批和预载的一页对不上。点名的「第一个不等的」按库的顺序。
  2. **「逐个一致」**：JSON 里每个真实会话经 `normalizeForStore` 与按预载读法重建的库里那份 `deepStrictEqual`，它的订单（按 id 排）与库里这个会话的未作废订单相同；库里多出来的会话不影响判定。JSON 里没有真实会话、也没有标记（改写完 JSON、写标记之前崩了）同样算一致，补写标记、0。
  3. **原件**：每次在 `--keep` 下新建 `<import|resync|export>-<时间>-<随机>/` 再复制（`COPYFILE_EXCL`），不覆盖之前的原件：切换步骤第 4 步的 export 与之后的 `--resync` 多半用同一个 `--keep`，直接复制会把首次导入的原件盖掉。「`--keep` 在 var/ 之内」按真实路径判断（解析符号链接，还不存在的部分接在最近一个已有上级目录的 realpath 后面），等于或在 `--var` 之下都拒绝（1）。审查之后：子目录在开事务之前建好并试写（见下面「审查之后改的」第 3 条）。
  4. **顺序与拒绝**：查租户（没有 → 1）→ `--keep` → 取锁（拿不到 → 3）→ 数据目录里有没回放的 `store-spill-*.json` → 1（那是 db 存储停机时没落库的改动，导入导出都会把它们丢掉；先以 db 存储启动一次让它回放）；`.json.failed` 只提示一行 → 读 JSON（不是合法 JSON、不是数组、某条没有字符串 id → 1；不回显解析错误，里面带着出错处的原文片段）。锁一直持到改写完 JSON、写好标记。两个 JSON 的读法与文件后端相同（按 id，同 id 以后出现的为准）。审查之后：查完 spill 之后先试写 `--keep`（第 3 条）。
  5. **提交之后**：复制原件 → 改写两个 JSON（与文件后端同一种写法 `JSON.stringify(…, null, 2)`，先写 `.tmp`、fsync、再改名）→ 写标记 `{ tenant: <slug>, at: <ISO 时间>, sessions: <库里这个租户的真实会话数> }`。中途失败退出码 1，写明「库已提交，修好原因后再跑一次会按逐个一致补完改写，在那之前不要启动应用」。export 的标记最后删，中途失败时它还在，文件存储照旧拒绝启动。审查之后：import 改成先写标记再改写 JSON，export 先 orders.json 再 sessions.json，每次改名之后 fsync 目录（第 1 条）。
  6. **`--resync`**：「库里的窗口是文件窗口的前缀」按进库之后的样子比（文件里的消息经 `messageToRow` → `rowToMessage` 走一趟，与预载重建的库里窗口逐条 `isDeepStrictEqual`），条数够但有一条不同就不是前缀。`flush_id` 写 NULL（不是应用的快照）。库里有、文件里没有的未作废订单作废（`void_reason='resync'`）；文件里有、库里已作废的订单不恢复、单独计数（库里不拦 `voided_at` 写回 NULL，第 5 步的注意）。写完之后同样按预载读法读回、与 JSON 比对（期望里去掉没恢复的那几张），不等就回滚、退出码 2。`--dry-run` 与首次导入一样：写进事务、读回，最后回滚，打印条数。JSON 里没有真实会话而有标记时与不带 `--resync` 一样，0、不动。
  7. **export「同 id 以库为准」也管订单**：JSON 里 id 在库里、而库里已作废的订单从 JSON 里去掉（与预载对 orders.json 的处理同一口径），库里未作废的盖掉 JSON 里的同 id 副本；会话同样以库里的为准，JSON 里只有的照留。
  8. **回滚前检查**：判断抽成 `deploy/rollback-guard.sh <部署目录> <目标> [<compose 项目名>]`，没有标记文件就放行（不看镜像）；有标记时目标是镜像就 `docker run --rm --entrypoint /bin/sh <镜像> -c 'test -e /app/src/store/pg-backend.ts'`，0 放行、1 是 02 之前的、其余（docker 出错）也按 02 之前处理；目标是 `pre-02` 表示调用方已按 tag 的文件树判定。拒绝时退出码 3，按顺序打印 stop app → `export-sessions` → 去掉 `SESSION_STORE=db` 再起 → 部署旧 tag。`deploy.sh`：部署的 tag 里没有 `src/store/pg-backend.ts` 时，在第 3 步的服务器检查之后、rsync 之前 `guard_rollback pre-02`；健康检查失败后的自动回滚在确认 `:prev` 存在之后、起 `:prev` 之前 `guard_rollback "${NAME}:prev"`，被拒就以 1 退出（服务不可用，与「没有 :prev」同一处理）。`/healthz` 的 `config.catalogVersioned` 第 8 步才有：脚本里 `risks` 那一段留了注释。审查之后：多一个宿主端口参数、打印的命令带端口与租户、自动回滚被拒另一套步骤（第 4 条），`.env` 里是 `SESSION_STORE=db` 也算风险（第 5 条）。
  9. 命令行的事务：import 是一个 `longRunning` 读写事务（默认隔离级别）；export 是 `REPEATABLE READ READ ONLY` 的 `longRunning` 事务，读完才动文件。两个都不写审计（spec 没要求）。
- 偏离：没有与 spec 冲突的。比原文多的：上面 1 为了让「每批写完按预载同一条路径读回」字面成立多了一条只读语句；2 的「JSON 里没有真实会话也没有标记」与 7 的订单按库为准是 spec 没写到的情况，按同一口径补上。
- 自测：
  - `store.selftest.ts` 的 xfer 子进程链（落盘的 PGlite，一步一个子进程：import → dbstart → export → filechat → resync → dbstart2 → export2；export、resync、export2 不起 store，免得 store 退出时把命令行刚改写的 JSON 再写一遍）。夹具 `xferFixture()`：3 个真实会话（followup、quoteHistory、昵称、转人工记录、`author`、消息上的未知键、空窗口），种子与访客各一，孤儿订单，旧格式订单号 `ORD-20240501-0007`；NUL 与孤立代理项用 `String.fromCharCode` 构造，被规范化的字符串恰好 5 条，种子里另有一个 NUL 不计数。子进程设 `DEMO_PRUNE_HOURS=0`（夹具时间是固定的过去时刻，否则访客被闲置清理）。覆盖：dry-run 不写库不改文件不建 `--keep`；`--keep` 在 var 之下 / 就是 var / 经符号链接指进 var；import 与 export 拿不到锁 3；spill 在时 1；首次导入的 seq、`window_start_seq`、`last_seq`、`flush_id`、state 与订单 data 原样（昵称里的 NUL 去掉了）、JSON 逐字节是 demo 类与孤儿订单、标记内容、原件逐字节在 `--keep`、longRunning 的两条 `set local`；再导入 0；补完改写（原件放回、标记删掉）0；JSON 只剩 demo 类而没有标记 0 并补写标记；1001 个会话三批写入读回、提交之后复制原件失败 1 并说明、修好再跑补完改写 0；改一条消息 / 多一个会话 / 订单金额不同各 2 并点名短码、提示 `--resync`；首次导入读回不等（`at` 不是整数毫秒）回滚、2、点名第一个；import 写的标记让文件存储以 `sessions_in_db` 拒绝；补完改写之后 db 存储启动成功，identity map 与原 JSON 经 `normalizeForStore` 之后 `deepStrictEqual`（不变量 14），JSON 里没有真实会话（不变量 15）；db 存储下再聊两句；export 在只读快照里读、删标记、原件进 `--keep`、导出的就是 db 存储停机前的内存，再交给 `--resync --dry-run` 什么都不追加、不带 `--resync` 是逐个一致；文件存储照常启动，再聊几轮、重置一个、新来一个，db 存储而 JSON 里有真实会话以 `real_in_json` 拒绝；不带 `--resync` 2；条数够而有一条不同的变体推进窗口；写完读回不等的变体（新会话里一条 `at` 带小数）回滚、2；`--resync` 新写 1、追加 2 个会话、推进 1 个（窗口起点 = 原 `last_seq` + 1）、作废 1 张（`void_reason='resync'`）、已作废的不复活；db 存储启动之后内存与文件存储下聊完的经 JSON 规范化 `deepStrictEqual`，每个会话库里窗口内的消息与内存相同、seq 对得上，重置过的会话历史比窗口长；export 把 JSON 里真实会话的陈旧副本、已作废订单、改过金额的订单副本都换成库里的。
  - 真实 PG（有 `PG_TEST_URL` 才跑，与第 5 步的同一个临时库，另建租户 xfer 并 import-config）：以子进程跑两个命令行，`--dry-run` 0 且库不动 → 首次导入 0（打印条数与规范化 5 条）→ 再导入 0 → 真的 `server.ts` 以 db 存储起来、`/healthz` 报 db、这时 import 与 export 都是 3 → SIGTERM 143 → export 0、删标记 → 改一条消息后 import 2、点名短码 → `--resync` 0、窗口推到 7、`last_seq` 12、消息 17 条 → server.ts 再以 db 存储启动、SIGTERM 143。
  - `db.selftest.ts` 的部署脚本段：rollback-guard 六种情况（没有标记不看镜像、两个都是 02 之后放行、02 之前拒绝并按顺序打印步骤、docker 出错拒绝、`pre-02` 有无标记）；deploy.sh 用本机执行的假 ssh 与总成功的假 pnpm 跑到 rsync：02 之前的 tag 而有标记 1 且没碰 rsync、没有标记照常、02 之后的 tag 不做这道检查；自动回滚在起 `:prev` 之前检查并以 1 退出、两处是同一个 `guard_rollback`。
  - `src/db/testing.ts` 的 `txModes` 也记 `set local …`，看得到 longRunning 放宽的超时。
  - 计数：`store.selftest.ts` 不带 PG 294 → 363、带 PG 304 → 385；`db.selftest.ts` 不带 PG 466 → 477、带 PG 862 → 873。
- 变异（源码拷进 scratchpad 的隔离副本，三个副本并行，只跑相关自测）：39 个，全部杀掉。读回：首次读回不比对、每批都从头读、读回只读第一批、`--resync` 之后不读回比对（首轮存活：正确的 `--resync` 写不出不等的库，补「写完读回不等」的变体之后杀掉）；补完改写误判：已有会话不判一致、「已经导入过」不看标记、比对不看订单；`--resync` 的前缀判定：只看条数、一律成立、推进窗口差一；作废：漏写、原因写错、已作废的复活；标记文件不写、不删；`--keep` 在 var 之内放行、不解析符号链接；持锁不拒（import 与 export）；dry-run 不回滚；不查 spill；原件不复制；导出不以库为准、留着已作废订单；改写 JSON 不滤掉真实会话；export 不用只读快照、import 不放宽超时；seq 从 0 起；规范化计数不算键；预载的 `rebuildSessions` 不校验窗口；回滚检查一律放行、02 之前的镜像放行、docker 出错放行、不看标记文件、部署旧 tag 不检查、自动回滚不检查。
- 真实 PG：本机 `pgvector/pgvector:pg17` 一次性容器（`127.0.0.1:55432`）。`pnpm test` 带 `PG_TEST_URL` 与不带各跑一遍都全绿，PASS 行 60（本步没加新套件）；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。
- 注意（第 7 步）：等价套件与 DB 模式 eval 不经命令行，照旧 `installPgSessionStore` + `initSessionStore`；要造「已导入」的库可以直接调 `importSessions`（`lock: async () => fakeLock()`，`db` 用 fixture 的那个会计数的）。
- 注意（第 8 步）：`deploy/rollback-guard.sh` 的 `risks` 加「正在运行的实例 `/healthz` 的 `config.catalogVersioned` 为 true」：宿主端口已经是脚本的第四个参数（`$port`，`guard_rollback` 传 `$HOST_PORT`，审查之后加的），自动回滚时正在跑的是没起来的新容器，`/healthz` 可能取不到，取不到按有风险处理；db.selftest 部署段的假 docker 旁边再加一个假 curl。
- 注意（第 16 步）：`erase-conversation` 同样「要求应用已停」，取锁与退出码 3 照 `session-transfer.ts` 的写法（先查租户、再取锁、`finally` 里放锁）。
- 注意（第 26 步）：演练与线上切换照 `deploy/compose.yml` 开头的命令；`--keep` 是挂进容器的宿主目录（`-v /root/sessions-keep-<日期>:/keep`），每跑一次多一个子目录，第 5 步删原件时整个目录删掉；导入打印的会话、消息、订单数与之后 console `/status` 的会话数对照。
- 审查之后改的（2026-10-03）：
  1. **改写 var/ 的顺序，中途崩溃都落在安全的中间态**（审查 integrity[0]、integrity[2]、tests[3]）。import 提交之后：复制原件 → 写标记 → `sessions.json` → `orders.json`（原来标记在最后：改写完 JSON、写标记之前崩了，文件存储照常启动，客户历史在应用里消失）。现在中途崩溃只有两种状态：还没有标记、JSON 是原件（库里那份由之后的 import 判逐个一致补完）；有标记、JSON 里还有真实会话（文件存储以 `sessions_in_db`、db 存储以 `real_in_json` 拒绝，重跑 import 走逐个一致补完）。export：复制原件 → `orders.json` → `sessions.json` → 删标记（原来先换 sessions.json：两次改名之间崩了，import 报订单不同，照提示 `--resync` 会作废这些会话的全部订单，含已付）；现在中途崩溃时多出的订单所属会话不在 JSON 里，下次 import 当孤儿留着，db 存储预载时认出库里已有而丢掉。`writeAtomic` 改名之后对所在目录 fsync，export 删标记之后也 fsync，改名与删除的先后在断电之后也成立。
  2. **没有标记文件时的 export**（integrity[1]、spec[0]）：没有标记而 JSON 里有真实会话时，在同一个只读快照里用 `firstDifference` 比 JSON 与库里重建的版本：有不一致就以 2 拒绝（「会话不在库里（没有 sessions-in-db.json），JSON 里的真实会话 <短码> 与库里不一致（…）：JSON 比库新，export 会覆盖它们；什么都没动。要切回 db 存储请用 import-sessions --resync」），全部一致就是已经导出过，0、什么都不动（不复制原件、不改文件）。本步多定的一处：全部一致、而库里还有 JSON 里没有的真实会话时照常导出（同 id 的与 JSON 相同，合并只把那几个补进来；当无操作的话它们在文件存储下看不见）。没有标记、JSON 里也没有真实会话（import 写标记之前崩了又以 db 存储跑过）时照常导出。export 因此多了退出码 2：spec「export-sessions」没列退出码（命令行约定是 0、1、3），这是按审查修复说明加的，spec 那一段要同步一句。
  3. **`--keep` 先验可写**（spec[1]、ops[4]）：import 与 export 取锁、查完 spill 之后，开事务之前在 `--keep` 下建好这次要用的子目录并试写一个文件再删掉；建不了或写不进去（宿主目录没先 `install -d -o 1000 -g 1000`，docker 以 root 建出了挂载源）以 1 退出，提示「什么都没动」，不发事务。这次没复制原件（dry-run、已经导入过、已经导出过、拒绝、出错）时，子目录与本次新建的上级目录删掉（只删空目录，复制到一半的留着），所以 `--dry-run` 只做写权限探测、探完删掉。`deploy/compose.yml` 开头 import-sessions 的示例补了 `install -d` 那一行。
  4. **回滚检查打印的命令**（spec[2]、ops[0]、ops[1]）：`guard_rollback` 多传 `$HOST_PORT`，脚本第四个参数（缺省 3210）；打印的 `dc` 带 `HOST_PORT=`，「确认 /healthz」写成 `curl -fsS http://127.0.0.1:<端口>/healthz`。`--tenant` 取标记文件的 `tenant`，没有就取 `.env` 的 `DEFAULT_TENANT_SLUG`，对不上 `tenants_slug_check` 的字符集时留 `<slug>`。目标是镜像（健康检查失败后的自动回滚被拒，这时 `:current` 已是刚没过健康检查的新镜像）时换一套第 3、4 步：导出那一步注明不带 `APP_IMAGE`、用的是 `:current`（新镜像）里的 `export-sessions`；去掉 `SESSION_STORE=db` 之后 `APP_IMAGE=<目标> … up -d --no-deps app && docker tag <目标> <项目>:current`（自动回滚本来要跑的那条）；第 4 步按端口确认 revision 是目标镜像的 `APP_REVISION`（`docker image inspect` 读出来，取不到写明）。部署旧 tag（`pre-02`）那套照旧是「再部署旧 tag」。
  5. **不经 import 直接以 db 存储起的实例没有标记文件**（spec[4]、ops[3]；超出 spec「标记文件由 import 写、export 删」的原文，见「Open」）：(a) `initSessionStore` 的 db 分支装上 PG 后端之后，`deps.varDir` 下没有标记就补写一份 `{ tenant, at, sessions: 预载的真实会话数 }`（先写 `.tmp` 再改名；已有的不动）。`SessionStoreDeps` 因此多了 `tenantSlug`（`server.ts` 取 `configRuntime().deps.tenantSlug`，`installPgSessionStore` 的 fixture 带上）。写不进去只记一行错误、照常启动：db 存储本身是好的，回滚检查另看 `.env`，下次启动再补；没有新增启动拒绝的 reason。(b) `rollback-guard.sh` 按 deploy.sh 第 3 步同一种读法读服务器 `.env`，`SESSION_STORE=db` 也算一条风险。
  - 补的自测（审查 tests[0]–[7] 与上面五条）：
    - `store.selftest.ts` 的 xfer 链：只改 state 的两种「内容不同」（beta 的 `stage`、alpha 的昵称）→ 2、点名短码、`字段 stage / profile 不同`，库与文件没动；`--resync --dry-run` 的 JSON 缺了 alpha 与它的订单 → 作废 1 张（只有 beta 的）；两个读回不等的输入各加 `--dry-run` → 2、点名 TA02 / TA04，库与文件没动；export 的 `--keep` 在 var/ 之内三种；记录时序的假锁：首次 import 与 export 每次 release 那一刻数据目录已是最终的样子；首次 import 与 export 的改名、删除与目录 fsync 按先后记下（打桩 `fs.renameSync` / `rmSync` / `fsyncSync`，照常执行）：import 是「标记、sessions.json、orders.json」，export 是「orders.json、sessions.json、删标记」，每步后面一次目录 fsync；标记的 `sessions` 在补完（3）、补写（3）、大租户（1001）三处。
    - demo3 的 1001 个会话：`--keep` 写不进去时 import、`import --dry-run`、export 都在开事务之前以 1 退出（没发事务），库与文件没动；`sessions.json.tmp` 被目录占着 → 写好标记（`sessions: 1001`）之后失败、1、库已提交、JSON 原样；修好补完改写 0；再 export 0，JSON 里 1001 个真实会话、标记删掉。
    - export 失败：复制原件失败（打桩 `fs.copyFileSync`）→ 1、标记与两个 JSON 逐字节没变、`--keep` 下没留空目录；`sessions.json.tmp` / `orders.json.tmp` 被目录占着 → 1、标记还在（前者 orders.json 已换、后者什么都没变），之后 import 与 `--resync` 都是 0、不作废任何订单。没有标记时再 export：逐个一致 → 0 什么都不动；JSON 里 alpha 多一句 → 2、点名 HA01、提示 `import-sessions --resync`，文件、库与 `--keep` 都没动；JSON 缺了 gamma → 照常导出、补回来。
    - 同一个落盘的 PGlite 上另两条子进程链：demo4 的 crash → crashstart → crashfix（写好标记、改写 JSON 之前失败 → 1；文件存储以 `sessions_in_db`、db 存储以 `real_in_json` 拒绝；重跑 import 0、补完改写）；demo5 的 fresh（库里已有 3 个会话、var/ 只有 demo 类而没有标记 → db 存储启动成功，补写 `{ tenant: 'demo5', at, sessions: 3 }`、没留临时文件，之后文件存储以 `sessions_in_db` 拒绝）。dbstart 里标记已在时 db 存储启动不重写它。真实 PG：`server.ts` 不经 import 以 db 存储起来之后 var/ 里补写了标记，`tenant` 是 `DEFAULT_TENANT_SLUG`。
    - `db.selftest.ts` 部署段：假 docker 加 `image inspect`；拒绝时的输出逐条断言带 `HOST_PORT=3999` 的 `dc` 与 `/healthz` 端口、`--tenant` 取自标记文件或 `.env`（deploy.sh 那条两边都没有时是 `<slug>`）；目标是镜像时是自动回滚那套步骤（`:current` 导出、`up -d --no-deps` 目标镜像并重打 `:current`、确认目标镜像的 `APP_REVISION`，不出现「部署旧 tag」）；`.env` 是 `SESSION_STORE=db` 而没有标记时 pre-02 与自动回滚都拒绝，`.env` 里同名以最后一行为准；`guard_rollback` 传 `$HOST_PORT`。
    - 计数：`store.selftest.ts` 不带 PG 363 → 402、带 PG 385 → 425；`db.selftest.ts` 477 → 480、873 → 876。
  - 变异（源码拷进 scratchpad 的三个隔离副本，只跑相关自测）：25 个，全部杀掉。审查报的存活变异 9 个（M03、M13、M23、M24b、M41、M43、M47、M48、M55）都变红；上面五条各自的代表性变异 16 个：import 先改写 JSON 再写标记、export 先 sessions.json、改名之后不 fsync 目录；没有标记也照常导出、全部一致也照常导出；import 到提交之后才建 `--keep` 子目录、export 读完库才建、没用上的子目录不删；`guard_rollback` 不传端口、`dc` 不带端口、自动回滚被拒也打印部署旧 tag 那套、租户不从标记文件取；db 存储启动不补写标记、补写的 `sessions` 恒为 0、已有标记也重写、回滚检查不看 `.env`。首轮存活两个（目录 fsync、export 读完库才建子目录：export 的事务只读，后果看不出来），补了「按先后记下改名与目录 fsync」与「`--keep` 写不进去时没发事务」两条断言之后杀掉。
  - `pnpm test` 带 `PG_TEST_URL` 与不带各跑一遍都全绿，PASS 行 60；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。

### 第 7 步 · 等价套件与 DB 模式 mock eval（2026-10-03）

- 结构：
  - `src/store/parity.selftest.ts`（串在 `store.selftest.ts` 之后，约 6 秒）：父进程带 `PARITY_CHILD=file|db` 再起两次自己（单进程 `node --import tsx`，`spawnSync` 带 `killSignal: 'SIGKILL'`、240 秒超时）。两个子进程跑同一份场景脚本：本机假模型（按脚本回话、可拖延、请求一到就通知场景，脚本多调少调都记下）、假企微接口（替换全局 `fetch`，只接 `qyapi.weixin.qq.com`，其余照发）、`app.request` 调旧写接口。两个子进程的配置源相同（PGlite 上 `installSeededConfig`，导入 `data/`），PG 那个另 `installPgSessionStore` + `initSessionStore`，只差会话存储；钟也相同（审查之后加的：父进程定的基准时刻，子进程以 `--import` 预加载 `src/store/parity-clock.ts` 从它起走）。子进程把原始结果写进文件：每一轮的回复（或抛出的错误）与没用完的脚本步数、发给企微的消息、`normalizeForStore` 之后的会话投影、订单、场景记下的观测；父进程规范化之后逐项比较。
  - 8 组场景、18 个会话（一律 `wecom:parity-*`）：E5 生成中接手（经企微适配器，假模型拖 400ms 期间调真的旧 `/handoff`）；模型返回后推送前接手（经企微适配器，见下面取舍 3）；生成中付款（拖 400ms 期间调真的 `POST /api/orders/:id/pay`，之后再聊一句）；重置（报价、安全网建单、付款、投诉转人工、重置、再聊）；裁剪（引擎的 400→300 与企微适配器非文本占位的 400→300 各一个会话，各先追加 400 条）；企微重放（已记下没回复、已回复没发出、后面夹了欢迎语，各在 `resetForTest` 之后从盘上的在途表重放）；跟进（一条送达、一条没送达，扫两轮）；转人工各入口（安全网 request / complaint / refund、模型调 `handoff_to_human`、改行程承诺、回复说了转接、旧 `/handoff` 两次加人工回复与交还，各自之后再说一句）。
  - 规范化只做两件事：九个时间键（`at`、`createdAt`、`updatedAt`、`paidAt`、`sentAt`、`lastAt`、`pendingAt`、`firstHandoffAt`、`confirmedAt`）的毫秒数取值换成占位，键照留；随机订单号按它在这个场景里第一次出现的顺序换成 `ord#N`（订单号出现在回复正文、`orderIds`、订单里，同一张单换成同一个编号）。seq 不在内存投影里（WeakMap），无须去掉。比较的五样是每一轮的回复、发出的消息、会话投影、订单、场景观测。
  - PG 子进程每组场景之后 `drainStore`，用新加的 `readStoredConversations`（`src/db/testing.ts`：以 `agent_app` 经 `withTenant` 走 `readSessionBatch` + `rebuildSessions`，即启动预载那条路；另以超级用户读全部消息的 seq 与作废订单）逐个会话断言：库里有；重建出的会话与内存 `normalizeForStore` 之后 `deepStrictEqual`；seq 从 1 到 `last_seq` 连续；内存里每条消息的 seq 对得上窗口；库里未作废的订单与内存相同；内存里的消息都已冻结；整体没有 poisoned、没有冲突、`foreign` 为 0。重置组另断言旧消息都在、窗口起点是重置回复、订单记作废（`void_reason='reset'`）；裁剪组另断言库里 402 条全留、窗口起点 102、内存 301 条。文件子进程断言消息没被冻结。审查之后：父进程按每组场景的 `ids` 逐个会话要求这些核对都在且通过（重置、裁剪两组的专项核对按名字要求），verify 跳过哪一组、哪个会话都会红。
  - 父进程另有三类自检：场景本身的期望（两边各验一遍：接手真的发生、付款落在生成途中、重放没有重记、跟进推送那一刻持久副本里已记账、六类入口的类型……场景悄悄失效时两边照样相同，要靠它们拦）；比较器对每个字段都敏感（在文件那份原始结果上，每一种字段形状改一处，经同一个 `compareScenario` 必须比得出来，338 处；按取值判断是毫秒时间戳的改了必须仍相同，81 处）；两边收集到的会话、消息、订单、回复的字段覆盖一张清单（防收集时就少收，比较器探不到）。审查之后另加逐轮的「模型脚本恰好用完、经企微的每一轮处理链排空」。合计 669 项，审查之后 743 项（不带 PG 与带 PG 相同）。
  - `eval/run.ts`：`CONFIG_TEST_DB=pglite` 时在同一个 PGlite 上 `installPgSessionStore` + `initSessionStore`；会话 id 改成 `eval:<用例 id>-<时间>`（文件模式照旧 `sim-eval-`，渠道两边都照旧 `simulator`）。跑完 `checkStoredSessions`：排空写队列，按预载那条路读回，逐个用例断言会话在库里、与内存一致、seq 连续、窗口对得上、订单相同，以及没有积压、poisoned 与冲突；打印「DB 模式：19 个用例的会话入库核对，0 处与内存不符」，有不符就以 1 退出（`pnpm test` 变红）。前缀哈希的核对没动；文件模式那一遍的输出与行为不变（只多记了一个会话 id 列表）。通过的用例集合两种模式相同（都是 19/19，跳过 32 条 realOnly）。
  - `package.json` 的 `test` 在 `store.selftest.ts` 之后加 `tsx src/store/parity.selftest.ts`。
- 找漏网的原地修改与数组错位：两个套件都跑在冻结与严格模式上，没有一轮抛 `TypeError`，没有会话 poisoned。本步没有找到第 1 步盘点的六处之外的原地修改或错位，所以没有改产品代码，文件存储下的行为一个字节没变。另按第 1 步给的正则 `\.(content|at|role|msgid)\s*(\+|-)?=[^=]` 复查了产品代码（`git grep -P`，不含自测；行号是本步提交的），命中的都是已知几处：`store.ts:273`、`276`、`278` 的保鲜三处（消息的 `at`、`handoff.at`、`assignee.at`，demo 类不进库、不冻结），`store/project.ts:217`、`242` 给新建的对象赋值（投影与重建）；数组层面只有 `engine.ts:3307` 的重置（`messages = []`）、`engine.ts:3343` 的裁剪与 `adapters/wecom.ts:810` 的裁剪（`splice`），都在下表里。六处在本步各由一组场景在 PG 存储上兜住：

  | 位置（开工提交的行号）           | 原来                                | 现在（第 3、5 步改的）                                 | 本步在 PG 上由谁兜住                                                                                                           |
  | -------------------------------- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
  | 重置 `engine.ts:3275`            | `messages = []`，订单真删           | 先 `noteWindowReset`，库里推进窗口、订单作废；内存照旧 | 「重置」：旧消息都在、窗口起点是重置回复、订单 `reset` 作废                                                                    |
  | 裁剪 `engine.ts:3298`            | `splice(0, …)` 留 300               | 内存照旧，库里全留、窗口推进                           | 「裁剪」引擎那个会话                                                                                                           |
  | 裁剪 `adapters/wecom.ts:810`     | 非文本占位自带 400→300              | 同上                                                   | 「裁剪」企微那个会话（第 1 步说的单独覆盖）                                                                                    |
  | 转人工备注 `engine.ts:3398`      | 对已入库的 system 消息 `content +=` | 工具执行前算好出行时间，system 消息一次写成            | 「转人工各入口」的 `wecom:parity-ho-model`（模型调工具，原话带出行时间；场景期望钉住 `departNote` 与 system 消息里的出行时间） |
  | 企微重放 `adapters/wecom.ts:771` | `splice` 删掉这句再重跑             | `{ alreadyRecorded: true }`，不删不重记                | 「企微重放」三种情况                                                                                                           |
  | 保鲜 `store.ts:188–195`          | 平移种子的时间戳                    | 照旧，种子不进 PG、不冻结                              | 不在本套件（demo 类不进库）                                                                                                    |

  另在 scratchpad 的隔离副本里做了一次探测（探针不进仓库）：一个 `--import` 预加载模块在自测本身之前给进程装上 PGlite 上的 PG 会话存储，再跑现有自测，让它们的每一条路径都走冻结与严格模式。`engine.selftest`、`handoff.selftest`、`wecom.selftest`、`wecom-02.selftest`、`dejargon.selftest`、`engine-holiday.selftest` 全过，冻结写入 0 次、poisoned 0 个；`llm.selftest` 到 F1 为止全过。碰到的三处都不在产品代码里：(1) `server.selftest.ts:835` 原地改非种子会话消息的 `at`，抛 `TypeError`（锁定自测自己的写法，第 1 步已记）；(2) `console.selftest.ts` 会话列表的夹具把 `updatedAt` 设在 2030 年（触发器拒绝晚于现在 5 分钟以上的 `updated_at`，23514）、接手人的 `userId` 是 `u-conv-d`（`assignee_user_id` 是 uuid 列，22P02），四个夹具会话 poisoned：夹具数据，不是写入路径，第 13 步写的是真实成员 id；(3) `llm.selftest` 在 F1 跑过一次停机钩子之后挂住：late 段已关掉 PG 后端，之后的跟进记不上账、一直不推送，是探针把停机之后的进程接着用造成的。

- 两边有意不同、不比的地方（都是 spec 写明的）：内存里两边逐字段相同（比了）。库里：重置与裁剪只推进窗口、旧消息全留，文件存储下内存之外什么都不留；重置时订单在库里记作废、文件存储下删掉（内存里两边都移出，`getOrder` 都是 undefined）；文件存储下消息不冻结、seq 只在本进程有效。跟进的持久化路径不同（文件：`flushStoreNow` 同步写 JSON；PG：等 `flushSession` 提交），推送那一刻各自持久副本里的记账两边相同（比了）。没有发现 spec 没写的差异。
- 取舍与偏离：
  1. 两个子进程都用 DB 配置模式，不用文件配置：只差会话存储，输入（SOP、产品库）逐字相同；生产上 `SESSION_STORE=db` 本来就要求 `CONFIG_SOURCE=db`，文件存储加 DB 配置也是 02 之前线上 demo 的组合。
  2. 订单号换成编号：订单号是随机的，两边必然不同；不是去掉字段，同一张单在回复正文、`orderIds`、订单里换成同一个编号，结构照比。
  3. 「模型返回后推送前接手」：`strandedReply` 里的 await（`create_quote` 是同步算价）没有 I/O 窗口，从外面插不进去。做法：`onToolCall` 观测者在模型最后一步已返回（脚本已空）、不是预取的那次 `create_quote` 调用时排一个 microtask，以旧 `/handoff` 同一套写法接手（`enterHandoff(kind='agent')` + `saveSession`）；microtask 在 `await runTool` 的续体之前跑完。今天的机制只有 `handedOver`：这一轮的 AI 回复照样写进会话、照样发出（两边相同，场景期望里写明了）。验收 7 的「同样不发出」要第 13 步的接手代次。
  4. 两处「生成途中」（E5 与付款）都在假模型拖延期间经 `app.request` 调真的旧接口，不直接改字段。
  5. DB 模式 eval 的渠道照旧是 `simulator`（访客日预算等按渠道走的逻辑两种模式相同），只换会话 id 的前缀。
  6. 交接标题按实际日期写 2026-10-03。
- 变异（源码拷进 scratchpad 的隔离副本，逐个打、跑等价套件或 DB 模式 eval、还原）：21 个，全部杀掉。首轮 19 个里存活 4 个，各补一处之后杀掉：逐项比少了 `orders`（比较器探测原来按同一张 `COMPARED` 取要探的字段，比较漏了哪一样就连探都不探；改成探子进程收集到的全部五样）；把人数当时间戳抹掉（探测原来按 `TIME_KEYS` 判断哪处是时间戳，同一张表给自己作证；改成按取值的量级判断）；只去掉 `saveSession` 时的冻结（取快照时照样冻结，场景结束时消息都是冻的，等价套件看不出，第 5 步 `store.selftest` 的「schedule 不冻结」变异管它；换成两处都不冻，由「内存里的消息都已冻结」杀掉）；企微重放不传 `alreadyRecorded`（两边都多记一遍、照样相同；为它加了「场景本身的期望」，由「客户这句都只记一次」杀掉）。其余首轮就杀掉：PG 下会话投影多一个字段、回复多一个字、重置不把订单移出内存、重置不作废订单、快照的最后一条不插库（等价套件与 DB 模式 eval 各一次）、eval 不装 PG 会话存储、eval 的 DB 模式仍用 `sim-eval-`、规范化丢掉 `stage`、收集时投影里没有 `stage`、引擎原地改一条已落库的消息（`TypeError`）、引擎裁剪改成删中间（`WindowCorruptError` → poisoned）、重置不调 `noteWindowReset`、PG 下跟进不等记账提交就推送、PG 子进程不做库里的核对。另补两个：会话行的 `state` 少存 `handoff`、预载重建消息时丢掉 `msgid`，都由等价套件杀掉（后者先在 eval 上跑时存活：eval 的用例走网页渠道，消息没有 `msgid`）。
- 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍，都全绿，PASS 行 61（多了本步一行）。等价套件 669 项，两次相同（只用 PGlite，不看 `PG_TEST_URL`）；DB 模式 eval「19 个用例的会话入库核对，0 处与内存不符」、前缀哈希 22 个请求 0 个不符；`store.selftest` 402 / 425、`db.selftest` 480 / 876 项照旧。文件模式 eval 与开工时的 `eval/run.ts` 对跑一次，输出（抹掉耗时与随机 id）逐行相同，`--json` 里的通过数、断言数、结果与失败相同。锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。
- 注意（第 9、10、12、13 步，以及之后改会话写入的步骤）：
  - 第 13 步：「模型返回后推送前接手」那组的场景期望改成「AI 回复不发出、记一条『本轮未发送（顾问已接手）』」（接手代次），E5 的 system 文案统一之后两边照比；`takeover` / `release` / `reply` 新接口各补一组场景（成员接手、人工回复带 `author='human'`、交还），两边比较、PG 那边照样核对库里；`console.selftest.ts` 的列表夹具要在 db 存储下跑的话，`assignee.userId` 得换成真实成员 id；console 自测夹具的 `updatedAt` 不能晚于现在 5 分钟以上（db 存储下触发器拒绝，23514），列表夹具设在 2030 年的那几个要改。
  - 第 10 步：db 存储下跟进改由任务表驱动之后，「跟进」那组的 PG 一边换成任务表的路径（排程、认领、`sending`、记账提交后推送），文件一边仍是扫描器；比较发出的跟进与记账照旧，PG 那边加「任务表里的状态」。
  - 第 9、12 步：trace、护栏事件、账本行有了生产者之后，PG 子进程的核对加「库里有这一轮的 trace / 账本行」，`readStoredConversations` 跟着读。
  - 之后新增的会话写入路径（第 11、13、14、16 步）都在本套件加一组场景：PG 存储下的冻结与严格模式会把原地修改与错位当场报出来；新路径也要进 eval 的用例或探针过一遍。
- 审查之后改的（2026-10-03，只改测试与文档，产品代码没动）：
  1. **第 1 步第 4 处写入点在 PG 上原来没被兜住**（审查 coverage[0]、validity[0]）：模型入口 `wecom:parity-ho-model` 的两句客户原话都不带出行时间，`departNoteForHandoff` 为空，原来那处 `rec.content += 出行时间原话` 的路径一次也没走到；改行程、说了转接两个入口的 system 消息本来就是一次写成的新消息。现在这个会话的第二句是「我们10月12号出发，想换几个景点」，场景期望加两条（两边各验）：`handoff.departNote` 含「10月12号」，「AI 已转人工」那条 system 消息含「客户原话里的出行时间」。上面表格第 4 行已改正。
  2. **库里核对的自检太松**（coverage[1]）：原来只要求 PG 子进程名字含「库里」的检查不少于 20 项，「转人工各入口」一组就够数。现在父进程按每组场景的 `ids` 逐个会话要求六项库里核对（库里有这个会话、按预载重建相同、seq 连续、窗口对得上、订单相同、已冻结）都在且通过，每组要求三项整体核对（排空、没有 poisoned 与冲突、没有副本）都在且通过；重置、裁剪两组再按名字要求各自的专项核对；文件一边逐个会话要求「消息不冻结」那项。核对项的名字提成常量，子进程与父进程共用。
  3. **「模型脚本恰好用完」原是恒真断言**（validity[1]）：每轮都清空脚本，收尾的 `script.length === 0` 恒真，少调模型只能靠两边不一致发现。现在父进程对两边每一轮断言 `leftover === 0`（跟进那组记在 notes 的 `leftover1`、`leftover2` 也算），经企微的每一轮断言 `idle === true`；子进程收尾只剩 `overrun === 0`，检查名照实改成「没有多出来的模型请求」。现在没有哪一轮该剩步数，以后真有，在场景里给那一轮标出期望值。
  4. **两个子进程没有共用的钟**（validity[3]）：原来各自现取 `todayIso()`，先后跑的两个子进程跨过本地零点时，转人工备注里的「按今天（…）算是」两边不同，报假差异。现在父进程定基准时刻（当天本地 12:00），经 `PARITY_CLOCK_MS` 传给两个子进程，子进程以 `--import` 预加载 `src/store/parity-clock.ts`（照 `engine-holiday.selftest.ts` 的写法换掉全局 `Date`：`Date.now()` 与无参 `new Date()` 从基准时刻起走，钟照常往前走；偏移按装上那一刻的 `Date.now()` 算）。PGlite 的 `now()` 取的也是 JS 的 `Date.now()`（实测预载拨快 6 小时，`now()` 与 `Date.now()` 相差不到 1 毫秒），库里「`updated_at` 不晚于现在 5 分钟」的触发器看的是同一个钟。子进程另断言两种取法都从基准时刻起走。套件也不再受在几点跑的影响。
  5. 文档：上面「找漏网的原地修改与数组错位」补了 grep 复查的结果，第 13 步的「注意」补了夹具的 `updatedAt`（coverage[2]）。
  - 计数：等价套件 669 → 743 项（第 1 条 4 项、比较器多探 1 种字段形状；第 2 条 44 项；第 3 条 24 项，去掉原来那条「≥20 项」；第 4 条 2 项）。
  - 变异（源码拷进 scratchpad 的隔离副本，只跑等价套件）：审查给的撤回变异（`tools.ts` 的 system 消息不带备注、`engine.ts` runTool 的 `.then` 里恢复 `rec.content +=`）红 2 项（`sessions.wecom:parity-ho-model.messages.3.content` 两边不同、PG 那边的场景期望）；verify 只核对「转人工各入口」一组红 29 项（只让 PG 一边跳过红 18 项）；给 `searchYunnan` 多加一步用不到的脚本红 8 项；子进程不预加载 `parity-clock.ts` 红 2 项（两边的时钟断言）。只把 db 子进程的时钟拨快一天（在 `parity-clock.ts` 之前多预加载一个 +24 小时的 `Date`）现在全绿、743 项；同一变异打在修之前的套件上报 `sessions.wecom:parity-ho-promise.handoff.departNote` 的假差异。对照：前三个变异打在修之前的套件上都是绿的（669、564、669 项）。
  - 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍都全绿，PASS 行 61；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256` 不变。

### 第 8 步 · 产品库版本、按轮固定快照、开放五个字段（2026-10-03）

- 结构：
  - 仓储：`src/db/repo/catalog.ts` 的 `CatalogRow` 多 `version`；`updateItemPayload` 多一个可选的 `version`，与 payload 在同一条 UPDATE 里改（分两条写，`catalog_items_guard` 会让 rev 加 2）；`activateItem` 一并把 `version` 写成 1（原有只给启动补写对齐用的 `setItemVersion`，审查之后删了，见「审查之后改的」第 4 条）。`catalog-versions.ts` 加 `maxCatalogVersion`。
  - 配置源 `src/config/source.ts`：`CatalogSnapshot` 加 `versions`（键 `route:<code>` / `hotel:<code>`，`catalogVersionKey`，与 `turn_traces.catalog_versions` 同一个写法），与 routes、hotels 是同一代；`Loaded.history` 存全部条目的全部版本（deep-frozen 的 payload），只追加。`initConfig` 在第 6、7 步的同一个 REPEATABLE READ 只读事务里多读一次 `catalog_item_versions`；第 9 步 rerender 之后是启动补写（`backfillPlan` + `writeBackfill`）。`applyCatalogRow` 收行上的 `version`，没见过的版本加进历史；`reloadOnce` 同样读版本并进历史。新增 `pinCatalogForTurn`（AsyncLocalStorage）、`catalogItemAt`（匿名路由按版本取 payload，只读内存）、`catalogVersioned`。
  - 写入 `src/config/catalog.ts`：`nextVersion` 只在 active 条目的 payload 文本真的变了时，在同一事务里取 `max(version) + 1`、写版本行（source `console` / `fix`，`created_by_name` 是操作者）；`versionAudit` 写 `catalog.version`（diff `{ version, source }`），排在 `catalog.update` / `catalog.locked_fix` 之后。上架写版本 1（source `activate`）与一行 `catalog.version`。`src/config/transfer.ts` 的 import-config 首次导入同一事务里给每条写版本 1（见下面第 3 条）。
  - 工具与引擎：`src/tools.ts` 加 `routeVersion`（DB 模式取 `currentCatalog().versions`，一轮之内是这一轮那一代；文件模式恒为 1）、`proposalVersionSuffix`（版本 1 是空串）、`routeForProposal`（链接上的 `v` → 那个版本的线路，不合法、大于当前版本、线路不在时 null，只读内存）、`quoteFor`（`createQuote` 抽出的按给定线路算价）；`generate_proposal` 的链接追加后缀，`create_order` 记 `catalogVersion`。`src/engine.ts`：`handleMessage` 把 `handleMessageInner` 包进 `pinCatalogForTurn`；链接白名单认 `?v=<n>`（`proposalSuffixOf`）。`src/followup.ts` 的话术生成包一层。
  - 渠道与页面：`src/adapters/wecom.ts` 的 `ALL_LINKS_RE` 与 `extractCard` 认后缀，卡片按链接的版本取线路；`src/server.ts` 的 `/api/proposal/:routeId`、`/proposal/*` 走 `routeForProposal` + `quoteFor`，`/healthz` 的 `config` 加 `catalogVersioned`；`public/proposal.html` 把地址里的 `v` 原样转给接口；`public/chat.html`、`public/admin.html` 的站内链接正则认后缀（第 10 条）。
  - 审计文案：`src/shared/ui-labels.ts` 的 `AUDIT_ACTIONS` 加 `catalog.version`（「记下新版本」，图标 `history`），`src/shared/audit-text.ts` 的句子「记下了线路「…」的第2版」。
  - 开放五个字段：`src/shared/catalog.ts` 的 `LOCKED_WHEN_ACTIVE` 去掉 `priceFrom`、`bestSeason`、`inclusions`、`exclusions` 与酒店的 `nightlyFrom`，另加 `REPRICE_FIELDS`（原有的 `isRepriceField` 审查之后删了：console 改看行业包字段上的 `reprices`，第 6 条）；旅游包（`src/packs/travel/console-pack.ts`）这五个字段去掉 `lockedWhenActive` 与 `lockGroup`，去掉线路的「计价」「条款」与酒店的「计价」三个锁定组；console 的保存条（`console/src/catalog/save.ts` 的 `saveCopy`、`REPRICE_NOTE`，`CatalogDetail.tsx` 给 `SaveBar` 传 `kind`）；`src/cli/catalog-fix.ts` 的警告改成「已上架的条目会写一个新的条目版本……已发出的方案书按发出时的版本」。
  - `deploy/rollback-guard.sh`：第 6 步留的位置补上 `catalogVersioned`（第 13 条）。README「回到文件模式或更早的版本」原来加的一条按 owner 2026-10-03 定撤回，发版时再写（第 28 步）。
- spec 写得不够、本步定的（选最小、最贴原文的）：
  1. **新版本号**：写入事务里取 `max(version) + 1`（条目行已 `FOR UPDATE` 锁住，同一条的写入串行；主键兜底），同一条 UPDATE 里把 `catalog_items.version` 改成它。快照里的版本取这一列与内存历史里最大版本号的大者（审查之后改的：启动补写不再改这一列，它可能落后，见第 4 条）。
  2. **「内容变化」** = payload 的 JSON 文本变了；原样提交回去（审计 diff 为空、rev 照旧加 1）不写版本。草稿的新建、编辑、CSV 导入都不写。
  3. **import-config 写版本 1**：首次导入直接是 active，等于上架：同一事务里每条写版本 1（source `activate`、`created_by_name` 是 `import-config`），不另记 `catalog.version`（`config.import` 那一行就是这次导入）。spec 的启动补写只为「01 镜像期间上架的」条目设；不写的话每个新租户第一次启动都要补写、给每一条记一行系统审计。
  4. **启动补写的位置与范围**：initConfig 第 9 步、rerender 之后（与 rerender 一样等前面只读的检查都通过才写），一个事务、取配置写锁。只写 spec 写的两类版本行与审计，不动 `catalog_items`（审查之后改的：原来一并对齐 `catalog_items.version`，`catalog_items_guard` 触发器会让 rev 加 1、把「更新于」写成启动时刻，后台显示成「小林更新于重启时刻」，打开着的编辑页下次保存 409）。这一列因此可能落后于版本历史，内存里的当前版本取两者的大者，新版本号照旧按 `max(version) + 1`、写入时同一条 UPDATE 把这一列改上来。补写的版本 `created_by_name` 是 `system`，审计的操作者是 system。补写失败以 `db_unreachable` 拒绝启动（与写 rerender 同一处理）。
  5. **文件模式**：没有版本，每条线就是版本 1：链接不带 `v`，`?v=1` 与不带 `v` 相同，`?v=2` 起 404；订单记 `catalogVersion: 1`（等价套件要两种存储的订单相同，PG 那边的租户也是版本 1）；`/healthz` 的 `catalogVersioned` 是 false。
  6. **`v` 不是正整数**按 `/^[1-9]\d{0,8}$/`：`01`、`1.0`、空串、负数、超过 9 位都算，404。页面 `/proposal/*` 带了 `v` 而没有这个版本时回 404，正文是原样的 proposal.html（客户端照常显示「方案不存在或已失效」）；不带 `v` 时与开工时相同（线路不存在也是 200 的页面）。
  7. **不带 `v` 在 DB 模式下按版本 1 的 payload 渲染**，标题与分享卡片也是；与 01 写的「已发出的方案书会显示改后的行程文案」不同，这是 02 spec「不带 v 按版本 1」的本意（console.selftest 一条断言因此改了，见下）。
  8. **链接白名单**：版本后缀要等于这一轮那次 `generate_proposal` 给的（版本 1 与出错的调用是空串）；模型抄丢或写错后缀的抹成空位，由出口修补换成工具给的链接；完整 URL 剥域名时留下 `?v=<n>`。版本 1 的链接判定与开工时相同。`linksFromCalls` 的正则本来只看前缀，不用改。同一线路本轮有成功的调用时只拿成功调用的后缀核对（审查之后改的第 3 条）；改写正文的护栏不在 `?v=` 的 `?` 处断句，最后还有一道补后缀的兜底（第 1 条）。
  9. **固定快照包在哪**：`handleMessage` 的 `serialize` 回调里包住 `handleMessageInner`（轮到这一轮真正开始时记快照），与包住它的正文等价，少一层缩进改动；跟进包住 `composeFollowUp`（第 10 步的出口护栏要包进同一层）。`currentCatalog()` 在轮内返回固定的那一代，匿名路由、后台写入、`/healthz` 不在轮内，看到的是最新的。
  10. **企微卡片与网页模拟器**：卡片按链接的版本取线路（不带 `v` 是版本 1），版本不存在不做卡片、原样发纯文本；`chat.html` 的「查看行程方案」链接与 `admin.html` 的卡片、链接正则一并认后缀——不认的话模拟器里点开的是版本 1 的旧价。spec 只点名了白名单、`linksFromCalls` 与企微卡片，这两处是同一个后缀的认法。旧后台的卡片也按链接上的版本取线路、版本不存在不画（审查之后改的第 7 条）。
  11. **保存条**：已上架、改动里有 `REPRICE_FIELDS` 的字段时，说明换成 spec 的那一句「改价只影响之后的报价和方案书，已发出的方案书和订单不变」；只改别的字段时照旧「销售助手下一条回复就用新内容」。理由：这一句说的是改价；只改亮点时原句仍然准确，后台 UX spec 与 fields.selftest 钉着原句。判断看行业包字段上的 `reprices` 标记，经 `/pack` 下发（审查之后改的第 6 条；原来 console 经 `src/shared/catalog.ts` 的 `isRepriceField` 按 kind 查写死的字段表，绕过了不变量 11）；服务端的开放清单仍是 `REPRICE_FIELDS`，`packs.selftest` 核对两边一致。
  12. **锁定组**：五个字段不再锁之后，线路的「计价」「条款」与酒店的「计价」三组没有字段了、原因（「改了会变价」）也不再成立，从旅游包里去掉；页面上它们本来就按「这一组有锁定的字段才画」，所以只是不再出现。
  13. **回滚检查**：`curl 127.0.0.1:<端口>/healthz`，`"catalogVersioned":false` 没有这条风险、true 有；取不到或没有这个字段时直接问库，库也问不到时看正在跑的容器是不是 02 之前的镜像（审查之后改的第 2 条；原来取不到、没有字段一律按有风险，首次上 02 失败后的自动回滚被它堵死）。有这条风险时退出码 4，不打印回到文件存储的步骤（帮不上忙），写明只能回到 02 之后的镜像；只有会话存储的风险时退出码 3、照旧打印那套步骤。目标是 02 之后的镜像时照常回滚。
  14. **审计**：每个版本行都有一行 `catalog.version`（上架、后台改、catalog-fix、补写）。时间线上它并进同一事务里的那次写入，每次保存仍是一句、连着改几条仍合成「修改了N条」，句尾写「（第N版）」；系统补写单独成句（审查之后改的第 5 条；原来交错着单独成句，合并失效）。
- 偏离：没有与 spec 冲突的。比原文多的：上面 3（import 写版本 1）、10 的 chat.html 与 admin.html、11 的只在改了计价与条款字段时换句、13 的问库与退出码 4（记进「Open」请 owner 确认）。
- 改了的非锁定断言：
  - spec「测试与 CI」允许的（`config.selftest.ts`、`console.selftest.ts` 断言五个计价与条款字段 422 的用例），都改成断言能改且产生新版本，或换成仍锁定的字段：config 的「active 改 priceFrom 被点名」→ 不再点名；「删掉 inclusions 算改」→ 不算、删 aliases 算；「酒店改 nightlyFrom 被点名」→ 不算、改 name 照旧点名；「锁定表与 spec 一致」→ 新的锁定表与 `REPRICE_FIELDS`；DB 段逐个 422 的清单去掉四项；「unset 锁定字段也拒」换成 aliases；「上架后锁定字段不能再改」换成 title。console 的逐个 422 清单去掉四项、「一次改多个」12 → 8；「上架之后 priceFrom 锁定」→ title 锁定、priceFrom 能改且写版本 2；另加「开放的字段逐个 200、各写一个新版本、不带 v 的报价不变、酒店 nightlyFrom 200 而 name 422」。
  - 清单之外、随 spec 写定的行为跟着变的（已按下面做了，记进「Open」请 owner 确认补进清单）：
    - `console.selftest.ts`「公开的方案书接口拿到新 highlights」→「不带 v 仍是改之前的、?v=2 拿到新 highlights，quote 都不变」（spec「不带 v 按版本 1」）。
    - `packs.selftest.ts` 两条改坏用例（「锁定组没写原因 / 标签」）：改坏的组从酒店的 `price` 换成 `id`（`price` 组随 nightlyFrom 开放去掉了），断言的仍是 checkPack 点名被改坏的那一组。
    - `console/src/fields/fields.selftest.tsx`：设计系统 E、F 页照 02 之前的旅游包画（计价、条款两组锁定，线路 13 项、酒店 4 项），原来的断言照页面写。照同一文件里假包「L 页版」的做法，在自测里从活的旅游包派生一份「E、F 页版」（五个字段加回锁定、加回两组原因），原来钉页面的断言一条没改；活的旅游包另加「9.0」一节（锁定组只剩识别 5、推荐 4，共 9 项，酒店 3 项；五个字段在已上架条目上是输入框；保存条按改动换句）与一段整页（状态句「9项上架后锁定」、卡片头只声明识别与推荐、只改亮点照旧、再改每人起价换句）。
    - 只改夹具：`config.selftest.ts`「没有 active 线路」删线路之前先删版本行（导入写了版本 1，外键指着它们）。
- 新自测（`config.selftest.ts` 末尾「条目版本、按版本渲染的方案书、按轮固定快照」一节，单开租户 `vers`；另有 `console.selftest.ts`、`db.selftest.ts` 的几条）：
  - 文件模式：链接（带不带日期）逐字节不变、`?v=1` 与不带相同、`?v=2` 404、订单记 1、`catalogVersioned` false。
  - 导入写版本 1、payload 逐字节相同；改 active 条目写版本 2（source、操作者、payload、`catalog_items.version`、rev 只加 1、审计）、内存跟着变、`catalogVersioned` true、原样提交不写；之后新链接带 `?v=2`；不带 `v` 按版本 1、`?v=2` 按新内容；`3`、`0`、`-1`、`01`、`1.0`、`abc`、空串、11 位数在接口与页面都 404；页面的分享卡片按版本写；这些匿名请求 `queryCount` 不变。
  - 草稿的新建与编辑不写版本；上架写版本 1 与审计。
  - 验收 19：后台改 `priceFrom` → 版本 3；改之前发出的两种链接报价不变、`?v=3` 新价、`?v=4` 404 且不查库；已有订单金额与版本不变；新订单新价、记 3；新链接带 `?v=3`；改 `title` 仍 422 且不写版本。其余三个开放字段各写一个版本；酒店 `nightlyFrom` 写版本 2、快照是新价；catalog-fix 改识别字段写版本（source fix）与审计；重启后全部版本进内存。
  - 启动补写：删掉 `r-guizhou` 的全部版本行后重启 → 版本 1（backfill、payload 是条目当前的、审计记 system），链接照常、不带 `v`；直接改 `r-sanya` 的 payload（模拟 01 镜像期间改过）后重启 → 版本 2、`catalog_items.version` 对齐、不带 `v` 仍是改之前的；再重启不写。
  - 按轮固定（本机假 `/chat/completions`）：模型先 `get_route_detail`，回第二步之前后台把这条线的价改了（版本 2），这一轮的 `generate_proposal` 仍是开始时那一代（链接不带 `?v=`、每人价是旧的），回复里的链接也是；模型照这一轮看到的报的「每人 28,800 元起，两位合计 57,600 元」被价格护栏原样放行（不固定的话护栏看的是新价，这两句会被删）；下一轮链接带 `?v=2`。
  - 链接白名单：丢了后缀、后缀写错（`?v=1`）的换成工具给的那条；完整 URL 剥掉域名留后缀；对得上的原样留着、只出现一次。企微卡片：带 `?v=2` 的卡片链接与挖掉的原文都带后缀、剥完正文不留；`?v=9` 不做卡片。重读：库里新提交、内存还没有的版本经 `reloadFromDb` 读进来。
  - `db.selftest.ts`：rollback-guard 七种情况（问的是宿主端口上的 `/healthz`；true 而部署 02 之前的 tag 拒绝、不打印导出步骤；true 而自动回滚到 02 之前的镜像拒绝；true 而目标是 02 之后的放行；连不上拒绝；没有这个字段拒绝；有标记又 true 两条都点名、照常打印步骤。后三种审查之后改了，见「审查之后改的」第 2 条），假 curl 缺省回 `catalogVersioned: false`，原来的用例不变；真实 PG 部分：import-config 写版本 1、catalog-fix 写版本 2（agent_app 有 INSERT），最新一版与条目的 json 文本逐字节相同。
  - 计数：`config.selftest.ts` 454 → 503；`console.selftest.ts` 306 → 310；`db.selftest.ts` 不带 PG 480 → 487、带 PG 876 → 884；`console/src/fields/fields.selftest.tsx` 1717 → 1724；等价套件 743 → 744（订单多了 `catalogVersion`，比较器多探一种字段形状）；`store.selftest.ts`（402 / 425）、`packs.selftest.ts`（222）、`audit-text.selftest.ts`（46）数目不变。
- 变异（源码拷进 scratchpad 的隔离副本，逐个打、只跑相关自测）：41 个，39 个杀掉。版本号：不加 1（撞主键）、`catalog_items.version` 不跟着改、内存里的版本号不变、历史不加新版本；草稿也写版本、原样提交也写版本；上架不写版本 1、import-config 不写版本 1、catalog-fix 不写版本、`catalog.version` 审计漏写；`?v=` 在版本 1 时也加、从来不加；`v` 大于当前版本照常渲染、`v` 不校验、不带 `v` 用当前内容；`v` 不合法时查库（`queryCount` 抓到）、页面带了不存在的版本不回 404、页面不按版本写分享卡片；固定快照不生效（`pinCatalogForTurn` 直接调 fn、`currentCatalog()` 不看固定的那份、引擎不包）——三个都由价格护栏那条红（回复被安全网换成按新价的整句）；补写漏没有版本行的、漏内容不同的、不对齐 `catalog_items.version`、不记审计；重读不读版本；订单不记版本；多开放 `title`、`segments`、酒店的 `name`，五个字段里还锁着一个；回滚检查不看 `catalogVersioned`、取不到按没有风险；`/healthz` 恒为 false；白名单不比版本后缀；企微卡片丢后缀、不按版本取线路；保存条不传 kind、一律换句。存活两个：白名单剥域名时丢掉后缀（等价变异：剥下来的 `/proposal/…/2` 随即被后面那道相对链接的检查抹成空位，出口修补放回同一个位置的是带后缀的真链接，结果逐字相同）；跟进生成不包 `pinCatalogForTurn`（`composeFollowUp` 现在不读产品库，没有可观察的差别；第 10 步把出口护栏包进同一层时补断言，见「注意（第 10 步）」）。没有自测的两处：`public/proposal.html` 把 `v` 转给接口、`chat.html` / `admin.html` 的链接正则（页面脚本，锁定的 `server.selftest.ts` 只抽了别的函数）。
- 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍都全绿；mock eval 19/19（文件与 DB 两种配置模式）；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变；`check-fonts` 通过（保存条新句与审计新句的字都在 UI 优先片里，没有重跑字体）。
- 注意（第 9 步）：trace 的 `catalogVersions` 用 `catalogVersionKey` 与轮内的 `currentCatalog().versions`（已固定），记本轮工具结果里出现过的条目；`routeVersion()` 可以直接用。
- 注意（第 10 步）：任务表驱动的跟进生成与出口护栏要包在同一个 `pinCatalogForTurn` 里（现在只包了 `composeFollowUp`）。
- 注意（第 13、20 步）：`CatalogItem`（后台接口）没有带 `version`；J 页或订单卡要显示「按第几版报价」时再加，订单上有 `catalogVersion`。
- 注意（第 24 步）：走查种子里改过价的线路，方案书链接带 `?v=`；`chat.html` 与 `admin.html` 已经认它。
- 审查之后改的（2026-10-03；审查报告 spec 2 条、compat 4 条、anon 5 条、tests 6 条，按修复说明的编号）：
  1. **`?v=` 的半角问号不当句末**（spec[0]、compat[0]，major）：`engine.ts` 的 `splitSentences`、`dropPostHandoffPromises`、`transferSentences` 改成 `?` 后面紧跟 `v=数字` 时不断句（`\?(?!v=\d)`），`trimDangling` 跳过这样的 `?`，`price-guard.ts` 的 `sentenceUnits`（`dropSentences` 与价格规则护栏共用）同理；正文里没有 `?v=` 时切法逐字相同，锁定的 `price-guard.selftest` 照旧全过。改写正文的护栏都跑完之后（`dropPostHandoffPromises` 之后、`cleanText` 之前）加 `restoreProposalSuffixes`：本轮这条线成功的 `generate_proposal` 给了后缀、正文里这条线的 `/proposal/<id>/<n>[/<日期>]` 没带（只剩悬着的 `?`、版本写错的也算）就补回去；版本 1、文件模式、只有出错的调用时原样返回。
     - 与修复说明不同的一处：说明要九种「链接后面同一行接着…」的写法都断言输出仍带完整的 `?v=2`。切句修好之后链接与后半句是同一句，规则词（名额紧张两种、儿童价）、编出来的价（两种，换成兜底报价行）、转接说法这六种由护栏连着链接整句删掉——版本 1 的同一句也是这样（在 r-guizhou 上逐条对照过，正文里同样没有链接）。要这六种也留下链接只能改这几道护栏按句删的规则，会改变版本 1 的结果，违反同一条里「正文里没有 `?v=` 时不得改变任何结果」。所以回归写成「与版本 1 同形」：输出里没有不带完整后缀的 `/proposal/r-beijing/2`；版本 1 留下链接的三种（提议发方案、两种半句截断）版本 2 留下带完整 `?v=2` 的链接、换掉链接之后与版本 1 逐字相同、企微 `extractCard` 的卡片 url 带后缀；版本 1 整句删的六种版本 2 也整句删。另有转人工那一轮（模型同时调了 `handoff_to_human`，走 `dropPostHandoffPromises`）一条、`sentenceUnits` 的正对照（`?vip`、`?v 不是后缀` 照常断句）、兜底函数直接测六种输入。兜底在现在的护栏下碰不到，是防线：只去掉出口那一行调用的变异存活（等价）。
  2. **回滚检查取不到 `/healthz` 时先问库**（spec[1]，major）：`rollback-guard.sh` 在 `/healthz` 取不到、或里面没有 `catalogVersioned` 时，按项目名找 db 服务（与 `backup.sh` 同一种找法，在 `/` 下执行 `docker compose -p <项目> exec -T db psql -U postgres -d <库>`），库名取服务器 `.env.db` 的 `AGENT_DB`（缺省 agent；修复说明给的命令没带 `-d`，连的是 postgres 库，那里永远没有这张表，会一律当成 02 之前的库放行）：先查 `to_regclass('public.catalog_item_versions')`，表不在是 02 之前的库、没有这条风险；在就查有没有版本大于 1 的行。库也问不到时，正在跑的容器（`docker inspect` 取它的镜像）本身是 02 之前的镜像就不算风险，否则按有风险处理。拒绝的退出码分开：3 只有会话在库里（照旧打印先回到文件存储的步骤）；4 有条目版本大于 1 或看不出来（写明只能回到 02 之后的镜像，看不出来时提示先确认 db 在跑；不打印回到文件存储的步骤——原来会话与条目版本两条都在时照常打印那套步骤，紧挨着「回到文件存储也去不掉这一条」，照着做完了照样拒绝）。`deploy.sh` 两处按退出码各写一句：3 说先回到文件存储，4 说只能部署 02 之后的 tag，其余说回滚前检查没跑完。这样首次上 02 失败后的自动回滚（新容器没过健康检查、`:prev` 是 01、库里只有回填的版本 1）照常回到 01，跑着 01 时部署 01 的 tag 也照常（`/healthz` 没有这个字段、库里没有这张表）。新判定记进「Open」请 owner 确认。
  3. **同一线路先失败再成功**（compat[1]）：`proposalPathOk` 在同一线路本轮有成功的调用（结果里有 `proposalUrl`）时只拿成功调用的后缀核对，只有出错的调用时照旧按空串放行；文件模式与版本 1 的判定不变。
  4. **启动补写不改 `catalog_items`**（anon[3]）：`writeBackfill` 只写版本行与审计，删了 `setItemVersion`。`catalog_items.version` 因此可能落后（回滚到 01 期间改过、回来补写出新版本时），内存里的当前版本取它与版本历史最大值的大者（`source.ts` 的 `currentVersionOf`，`snapshotOf` 与 `applyCatalogRow` 都用它：原样提交带回的是落后的这一列，照抄的话版本会退回去）；新版本号照旧按 `max(version) + 1`，写入时同一条 UPDATE 把这一列改上来。取舍第 1、4 条照此改了。
  5. **审计时间线**（anon[0]、原「Open」第 8 步第三条）：只改展示。`auditRuns` 先把紧挨在同一条目、同一操作者的 update / activate / locked_fix 前面（新的在前，版本行比它那次写入新）、相隔不超过 5 分钟的 `catalog.version` 并进那次写入，不出现在输出里；单条的句尾写「（第N版）」（总览一行写完的补充与审计页的摘要都接上，上架恒为第 1 版不写），合并的几条照旧「修改了N条线路」；`source='backfill'` 的系统补写前面没有写入，单独成句「系统 记下了线路「…」的第2版」。并掉的版本行按对象记在 `audit-text.ts` 的 WeakMap 里，`describeAudit` 按同一个对象取，console 的几处调用不用改。`auditMergeable` 也认 `catalog.version`：审计页按页取时页尾是它，那次写入在下一页，往后看一眼把它取进来。审计行照写。
  6. **保存条经 `/pack`**（anon[1]）：`FieldDef` 加 `reprices?: true`（`/pack` 原样下发整个包），旅游包给五个字段标上，`checkPack` 不许有序子项的子字段写它（与 `lockedWhenActive` 同一条）；`saveCopy(status, changes, entity)` 按改动所在字段的这个标记判断，`SaveBar` 改传实体；console 不再 import `isRepriceField`（删了，服务端只用 `REPRICE_FIELDS`）。`packs.selftest` 核对旅游包标了的（且没有上架后锁定的）字段等于 `REPRICE_FIELDS`；`fields.selftest` 的 E、F 页版旅游包把这五个字段锁回去时一并去掉标记。界面结果与改之前相同。
  7. **`admin.html` 的方案书卡片按版本**（anon[2]）：`loadRouteMeta(routeId, v)` 请求带上链接里的 `v`，缓存键是线路 + 版本，接口 404 记成 false：不画卡片、之后也不再请求；`cardOf` 取链接上的 `v`。锁定的 `server.selftest` 抽取的 `load()`、`sigOf()` 没动。
  8. 自测（都在非锁定套件）：`public/proposal.html` 把 `v` 转给接口（`config.selftest` 原有的 vm 写法跑页面脚本：带 `?v=2`、带日期又带 `?v=3`、不带三种，看请求 URL；M19）；价格护栏看的是开始时那一代（这一轮不调带价工具、回话之前改价：回旧价原样发出，回新价被删；G1）；启动补写也补酒店（M34）；固定包在 serialize 里面（同一会话两轮排队、第一轮挂在模型那儿时改价，第二轮按新价、链接带新版本；M29）；`chat.html`、`admin.html` 的链接正则（从页面里抽出 `renderContent`、`SITE_LINK_RE`、`linkify`、`LINK_RE`、`cardOf`、`loadRouteMeta` 原样在 vm 里跑，旧后台的卡片按版本那条一起测；M23、M24）；审计页翻页时页尾是版本行（`audit.selftest.tsx`）；`console.selftest` 拿这一轮写进库的真实审计记录核对每个 `catalog.version` 都并进了它那次写入。
  - README：按 owner 2026-10-03 定的「README 等 02 全部实现、发版时再改」，本步对 README 的改动全部撤回（与 origin/dev 相同）；原来加的那条回滚说明与审查带出的「改过价之后回到文件模式」的警示写进第 28 步「发版与 README」的要点。
  - 改了的非锁定断言（都是本步自己加的）：`config.selftest`「补写：…catalog_items.version 对齐成 2」→「内存里是版本 2」，另加「这一行不动」「原样提交不退回、再改写版本 3」；`db.selftest` 回滚检查的「连不上拒绝」「没有这个字段拒绝」换成问库的几种结果（库里没有大于 1 的、没有这张表、有；库也问不到而正在跑的是 02 之后的、看不出来的、02 之前的），catalogVersioned 为 true 的两条退出码 3 → 4，「有标记又 true」改成退出码 4、两条都点名、不打印回到文件存储的步骤；`deploy.sh` 自动回滚那段的结构断言跟着改；`fields.selftest` 的 `saveCopy` 改传实体（多一种「包里没标」）。
  - 计数：`config.selftest.ts` 503 → 529；`console.selftest.ts` 310 → 311；`db.selftest.ts` 不带 PG 487 → 497、带 PG 884 → 894；`audit-text.selftest.ts` 46 → 56；`console/src/audit/audit.selftest.tsx` 141 → 142；`fields.selftest.tsx` 1724 → 1725；`packs.selftest.ts` 222 → 224；其余不变。
  - 变异（源码拷进 scratchpad 的隔离副本，逐个打、只跑相关自测）：47 个，45 个杀掉。第 1 条：`splitSentences`、`transferSentences`、`dropPostHandoffPromises`、`sentenceUnits` 各自退回在 `?` 处断句、`trimDangling` 照旧截在 `?`，兜底什么都不做、不去掉悬着的 `?`、出错的调用也算进兜底；第 2 条：取不到 `/healthz` 不问库、不看正在跑的容器、表不存在也算有风险、问库不带库名、库里有版本大于 1 也放行、条目版本风险用退出码 3、`deploy.sh` 在退出码 4 时也说先回到文件存储；第 3 条：白名单照旧拿出错调用的空串核对（原来那条用例被出口补上的后缀盖住、结果逐字相同而存活，改成模型连日期一起丢、要换成工具给的那条之后杀掉）；第 4 条：补写照旧 UPDATE `catalog_items.version`、`applyCatalogRow` 照抄行上的版本、当前版本只看行上的；第 5 条：版本行不并、补写也并、并的时候不看条目、不看操作者、句尾不写版本号、上架也写版本号、翻页不认版本行；第 6 条：`saveCopy` 不看 `reprices`、改认字段名、旅游包漏标一个、多标一个；第 7 条：请求不带 v、缓存键不带 v、404 不记下、`cardOf` 不取 v、404 也画卡片；审查报的存活变异 M19、G1、M29、M34、M23（与 `chat.html` 的 `SITE_LINK_RE`）、M24（与 `admin.html` 的 `LINK_RE`）、U2、U3 重放全部变红。存活两个都等价：出口不调兜底（切句都修好之后兜底碰不到，见第 1 条）；快照只看版本历史、不与这一列取大（合法状态下历史里最大的版本总不小于这一列，取大只在版本行被人删掉时起作用）。
  - 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍都全绿，mock eval 19/19（文件与 DB 两种配置模式）；锁定套件 8 个文件的 sha256 与第 1 步相同，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变；`check-fonts` 通过（时间线新句「（第N版）」的字都在 UI 优先片里，没有重跑字体）。

### 第 9 步 · 逐轮 trace、护栏事件、用量（2026-10-03）

- 结构：
  - `src/trace/recorder.ts`：spec 的 `TurnContext`、`TraceCall`、`TraceLlmCall`、`LlmErrorKind`、`GuardEvent`、`TurnOutcome`，`startTurn` / `noteGuard` / `endTurn`。轮次上下文是一个 `AsyncLocalStorage`：`handleMessage` 在 `pinCatalogForTurn` 里面再包一层 `withTurnScope`（开一个空的轮次、这一轮抛错时记 `outcome='error'` 再原样抛出），`handleMessageInner` 开头的 `startTurn` 填上它；不在作用域里调这几个函数什么都不做。数据从四处来，都在这一轮的异步上下文里同步送到：引擎（`startTurn`、各改写点的 `noteGuard`、`notePrefix`、`noteDraft`、`noteToolResult`、`endTurn`），`onToolCall` 多一个订阅者 `traceToolCall`（引擎在模块加载时挂上），`llm.ts` 新增的 `onLlmCall`（主对话每次模型调用、含失败的那次，传的是 `CallTrace` 本身，之后的工具、复用照样记在它上面），`usage.ts` 的 `onUsage`（`purpose='chat'` 的一笔归最近一次还没有用量、同一模型的成功调用；`llm.ts` 先通知 `onLlmCall` 再记用量）。不 import `src/db/**`：落库只经 store 的 `queueTelemetry`。
  - `src/trace/usage-daily.ts`：`usage_daily` 的累加器。store 导入它，它在导入期订阅 `onUsage`，按（天、模型、用途）累加；`initSessionStore` 的 db 分支装上 PG 后端之后调 `startUsageDaily(writeUsage)`（每 30 秒一次，`unref`）并另挂一个 drain 段钩子 `flushUsageDaily`。写入函数是 PG 后端新加的 `writeUsage`：在空的异步上下文里起一个短事务调 `addUsage`，已冲突、late 段之后、租户锁在别人手里时直接 reject。
  - `usage.ts`：`recordUsage` 多可选末参 `purpose`（缺省 `chat`）与 `onUsage(cb)`；事件带记账日（`usage.json` 的 `day`，服务器时区）、夹过上下界的 token 与 `costOf` 算出的元。`usage.json` 的内容与写法不变。`llm.ts`：`recordCompletion` 带 `purpose`；`completeText(system, user, opts?)`；`CallTrace` 导出、多 `error`。`insight.ts` 三处传 `insight` / `suggestion` / `draft`，`followup.ts` 传 `followup`，`retrieval.ts` 传 `embedding`。
  - turn_id：WeakMap 在 `src/store/seq.ts`（`linkTurn` / `turnIdOf`，与 seq 同一个做法，store 再导出）；`endTurn` 关联回复消息；PG 后端取快照时 `messageToRow(m, seq, turnIdOf(m))`，预载按 `messages.turn_id` 关联回去（重启之后 J 页照样认得出哪条回复有 trace）。
  - `src/db/repo/traces.ts` 加后台读接口的四个读法（第 13 步挂接口）：`readTurnSteps`（每轮的工具名与是否预取，在库里用 `json_agg` 摘好，不读参数与结果）、`readTurnDiff`（这一轮的护栏事件与相对模型原稿的净差；这一轮不在这个会话名下或 id 不是 uuid 时为 null，不发查询）、`readTurnTrace`（整行）、`readGuardTotals`（J 页消息上的删了几句、补了几处，按净差数）。净差是审查之后改的，原来是逐事件相加，见「审查之后改的」第 1 条。运行数字复用第 4 步的 `readMetrics`。
  - `scripts/check-boundaries.ts` 加一条：`src/trace/` 不 import `src/db/`（自测除外）。
- 本步定的（spec 没写细，按最小、最贴原文的做法）：
  1. **记下的改写点**：spec 列的 15 个名字逐个调。spec 写的是「出口每个改写点调一次」、名单前面是「如」，所以名单之外、同样改了客户看到的文本的三处也记，名字自定：`order_net`（成单安全网换掉整条回复，两处：重发已有的单、新建的单）、`other_order`（在说给别人另订：摘掉「订好了」、补一句问）、`proposal_suffix`（第 8 步加的出口补后缀，现在碰不到）。一道护栏有几处改写点的各记各的：`custom_promise` 三处（删句转人工 `handoff`、「N 天版」改成「N 天这条」`replace`、末尾补上转人工说明 `append`），`handoff_claims` 两处（没坚持的摘掉 `drop_sentence`、记下待顾问确认 `patch`），`repair_links` 两处（`markLinkHoles` 之后整条被抹空换成兜底、出口修补 `repairLinks`）。动作：链接白名单、去 markdown、截半句是 `strip`，按句删的是 `drop_sentence`，整条换掉的是 `replace`，补一句或就地改几个字的是 `patch` / `append`。
  2. **「没改」的口径**：按句对比之后删去与补上都为空就不记（含 before === after）。按句切分用价格护栏的 `sentenceUnits`（与按句删的护栏同一套边界），每句去掉首尾空白、空句不要，链接空位记号（U+0001–U+0003）先抹掉；同一句出现几次按几次算（多重集）。所以只差首尾空白、只差空位记号的不记；句子里面的空白变了算改了（去 markdown 的多空格合并）。每句 `cleanText(s, 200)`。
  3. **模型自己说了转接、引擎补记转人工**（`claimed`）文本没变，照 spec 不记；确定性路径（重置、安全网转人工、重发支付链接、`reset_command` 关时的固定话术，审查之后加上企微非文本消息的固定提示）没有模型原稿，不记护栏事件（确定性回复里 `answerIdentity` 补的那句也不记）。
  4. **outcome**：重置 `reset`；安全网转人工 `handoff`（运行数字的转人工率按 `outcome='handoff'` 数，安全网是最常见的转人工，算成 `deterministic` 就漏了它）；重发支付链接与 `reset_command` 关时的固定话术 `deterministic`；开始时已转人工、生成期间被接手而回复没发 `silent`；企微非文本消息不经引擎，回固定提示 `deterministic`、已转人工 `silent`（审查之后改的第 2 条）；走模型的一轮结束时转了人工 `handoff`，访客日预算用完走离线脚本 `budget`，其余 `replied`；抛错 `error`（`stage_before` 用 `startTurn` 时会话的阶段，`stage_after` 用出错时的）。
  5. **`endTurn` 多一个可选末参 `reply?: ChatMessage`**：spec 写「AI 回复消息经 WeakMap 关联 turnId」，`endTurn` 要知道是哪条消息。引擎每个出口经 `done(outcome, reply, msg)` 在写进回复、`saveSession` 的同一段同步代码里调它，排出的那次落库取快照时已经关联上、trace 也在同一个快照里。确定性回复也关联；沉默的轮次没有回复、不关联。spill 不带 turn_id（trace 本来就不进 spill）。
  6. **前缀与版本**：DB 配置模式下 `startTurn` 先取已发布 SOP 的版本与前缀哈希（确定性路径也有），调模型时 `notePrefix` 换成 `turnPrefix()` 那一刻的（轮内发布了新版本以实际发出的为准）；文件配置模式下是这一轮请求的前缀哈希（与 `/healthz` 同一个算法），没调模型的轮次为空串、`sop_version` 为空（文件配置模式不会有 db 存储，不入库）。`catalogVersions` 只在 DB 配置模式下记：这一轮工具结果里（往下三层的 `id`、`routeId`、`hotelId`），加上没出错的那次调用参数里的 `routeId`，取已固定的 `currentCatalog().versions`；文件配置模式没有条目版本，为空。
  7. **工具调用**：参数取执行完时的那份（`search_routes` 执行时会补客群），`normalizeForStore`；结果前 4,096 个 UTF-8 字节、不切开字符，`resultBytes` 记全长。llm.ts 同参复用的那几次不经 `executeTool`，不进 `calls`（在 `llm[].reused` 里）；百科护栏里 `deterministicRecommend` 直接查库，不经 `runTool`，也不进（与 `onToolCall` 一致）。执行时抛错的那次参数照记，`ms` 为 0、没有结果。
  8. **模型调用的失败类别**：`LlmHttpError` 429 → `rate_limited`，5xx → `http_5xx`，别的 4xx → `bad_response`；`TimeoutError` / `AbortError`（单次超时与整轮墙钟）→ `timeout`；回包不是 JSON、缺 `choices[0].message` → `bad_response`；连不上、连接中断（`fetch failed`）归 `http_5xx`（上游不可用，spec 的四类里没有单列）。失败的那次记主模型、没有用量。`llm.ts` 另导出 `__llmTest`（只给自测）。
  9. **模型原稿**：`chat()` 的 raw 原样（含 `<state>` 块），`cleanText` 去 NUL 不截长度；没调模型的轮次为 null。`final_text` 沉默的轮次为 null。
  10. **用量**：`completeText` 的调用方只传 `purpose`、不传 `sessionId`：传了会改 `usage.json` 的 `bySession`（`avgCnyPerSession` 的分母），与「`usage.json` 照旧」不合。累加器在装上写入函数之前（启动时建检索索引的 embedding）记下的用量随第一次写入；文件存储下没有写入函数、不写库，只留当天的几项。金额按千分之一元写整数，零头留在累加器里到下一次（写进库的总是累计金额的整数部分；按次或按批四舍五入的话，每 30 秒只有几次便宜调用的实例永远记成 0）。写失败整批加回去、下一次再写；`COMMIT` 之后回包丢失时这一批会重写一次（与会话落库不同，usage_daily 没有 flush_id，只多记、不少记）。
  11. **两种存储都收集、只在内存**：文件存储与 demo 类会话不入库，也不另存一份（不留环形缓冲）；`onTurnEnd(cb)` 给自测与第 18 步的 OpenTelemetry 导出订阅，没人订阅时 `endTurn` 里只有一次判断（`endObservers.size`），本步不加载任何 `@opentelemetry/*`。
- 自测：
  - 新套件 `src/trace/trace.selftest.ts`（串在等价套件之后，约 3 秒，143 项）：PGlite 上装 DB 配置与 db 会话存储，模型与 embedding 是本机假服务（按脚本回话、每次回包带不同的用量，主模型用价格表里的 `glm-5.3-flashx` 才测得出金额）。按句对比与失败分类的向量；一轮里直接调 recorder（4 KB 截断不切开 emoji、文本没变不记、结束之后再记的不进来）；先在文件存储、文件配置模式下跑一轮（照样收集、前缀哈希、没有条目版本、WeakMap 关联）；验收 20 的数据部分（条目改成版本 2 之后价格护栏删一句：库里一条 trace 带 `catalog_versions`、前缀、原稿、工具调用与用量，一行 `price` 事件 `removed` 恰是那句，AI 回复的 `turn_id`，四个仓储读法）；没改文本不记；出口改写点的表（spec 的 15 个名字与 `order_net`、`other_order` 各有会话把它触发出来，`proposal_suffix` 碰不到；断言名字、动作与 `removed`/`added` 不空，改行程承诺三处各记各的、库里按 ord 排，成单安全网建的单也进 `calls`）；确定性路径（重置、安全网转人工、之后的沉默，outcome 依次对、回复关联 turn_id）；503、429、缺 `choices` 三种出错的轮次（`outcome='error'`、`llm[].error`，运行数字的 AI 出错率把它们算进去）；demo 类会话（照样收集、库里没有、没为它起 PG 落库）；存档点（临时加一条拒绝 `replied` 的 CHECK，真实 trace 写不进去、丢掉计数、会话照常提交，下一轮照写）；读路径不查库（配置连接上没有查询，store 的借连接次数等于落库次数）；轮次里的 embedding 不算进模型调用的用量；验收 21（一次跟进、洞察、建议、代拟、建索引与轮次里的 embedding 之后 `usage_daily` 当天各（模型、用途）的调用数、四种 token 与金额等于 `recordUsage` 收到的合计；紧接着再写一次不重复；有新用量只加新的；写库失败留在累加器、下一次补上；装上 db 存储之前不写、之后 30 秒一次）；重启预载认回 turn_id；drain 段写一次。
  - 等价套件：两个子进程都订阅 `onTurnEnd`，每组场景多比一样 `traces`（每一轮的 outcome、阶段、正文、条目版本、护栏事件、工具名与预取、模型调用的失败类别；turnId、时刻与耗时不比），比较器的探测跟着覆盖它；PG 子进程逐个会话多两项库里核对（库里每一轮的 trace 的 id、outcome 与护栏事件条数与内存相同；窗口内消息的 turn_id 与内存的关联相同、每条回复都关联到它那一轮）；场景期望加一条 trace 不是空比（至少 20 轮，有护栏事件、有工具调用，outcome 有 replied、handoff、silent、reset）。744 → 903 项。
  - 计数：其余套件数目不变（`store.selftest` 402 / 425、`db.selftest` 497 / 894）；`pnpm test` 的 PASS 行 61 → 62。
- 变异（源码拷进 scratchpad 的隔离副本，逐个打、只跑相关自测）：66 个，64 个杀掉。recorder 与接线 39 个：某个改写点不调 `noteGuard`、文本没变也记、`removed` / `added` 对调或记成全部句子、回复不交给 `endTurn`、关联到别的 turnId、快照不带 turn_id、预载不认回、跟进 / 洞察 / 代拟的 purpose 传错或漏传、检索漏传 `embedding` 或不记用量、累加器不计 embedding、写完不扣（重复累加）、drain 段不写、不起定时器、写失败不加回去、零头丢掉、两处都不挡 demo 类、轮次里查库、条目版本一律记 1 或不记、429 归错、缺 `choices` 不标、安全网转人工与重置的 outcome 记错、出错的轮次不记、不补工具结果、4 KB 截断差一个字符、每句不截 200 字、空位记号算改动、不记原稿、不记调模型时的前缀、轮次用量不看用途与模型、引擎不订阅 `onToolCall`、失败的调用不通知、安全网建单不补结果；首轮存活四个，其中三个补断言后杀掉（第四个等价，见下）：不起定时器（30 秒的检查原来排在自测自己 `rearm` 之后，挪到装上 db 存储那一刻）、不记调模型时的前缀（DB 配置模式下 `startTurn` 已取同一个值，补了文件配置模式那一轮）、安全网建单不补结果（补了安全网建单的场景）。逐个去掉引擎里 23 处 `noteGuard`：首轮存活四个（整条被抹空的兜底、「N 天版」、没坚持的转接、重发已有的单），给改写点的表补了这四个场景之后杀掉。等价套件 3 个（落库不写 trace、快照不带 turn_id、只在 db 存储下收集）杀掉；`src/trace/` 加一行 `import '../db/client.js'` 被 `check-boundaries` 拦下。存活两个都等价：recorder 不挡 demo 类（store 的 `queueTelemetry` 照样只给 db 存储的真实会话排）；去掉 `proposal_suffix` 那一处（第 8 步已记：出口补后缀在现在的护栏下碰不到）。
- 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍都全绿，mock eval 19/19（文件与 DB 两种配置模式）；锁定套件 8 个文件的 sha256 与第 1 步相同，断言零修改，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变。
- 注意（第 10 步）：跟进不是一轮（不在 `withTurnScope` 里），`guardOutbound` 里调的 `noteGuard` 什么都不做；任务表驱动的跟进生成照旧经 `completeText(…, { purpose: 'followup' })`。
- 注意（第 11 步）：`turn_traces.signals` 现在恒为 NULL，`TurnSignals` 有了之后在 recorder 里加一个 `noteSignals` 填进去（`TraceRow.signals`）。
- 注意（第 12 步）：账本行经 `queueTelemetry(id, { outbound })`，等价套件 PG 那边照 trace 的写法加「库里有这一轮的账本行」；poisoned 的会话上账本行与 trace 一样直接丢掉、计进 `telemetryDropped`（审查之后改的第 3 条）。企微非文本消息的固定提示现在也在一轮里（第 2 条），它的发送照样要进账本。
- 注意（第 13 步）：`MessageView.turnId` 取 `turnIdOf(m)`（store 再导出）；文件存储与 demo 类会话的回复在内存里也关联了 turnId，但库里没有 trace（trace 接口 503 / 返回空），这两种情况下返回 null。`guarded` 由 `readGuardTotals` 一次取这一屏消息的；步骤摘要的中文名在接口层翻。**逐事件的 `removed` / `added` 不能直接相加**：同一句先被一道护栏改、再被下一道改时（去掉站外链接之后整句换成兜底、去 markdown 之后出口修补换掉同一句），中间那句会被算成「删去」、句数多算。`guarded` 的句数与展开的「删去 / 发出」对照都读净差（`readGuardTotals`、`readTurnDiff` 的 `removed` / `added`，`netGuardDiff`）；`readTurnDiff` 的 `events` 是逐事件原样，只在按护栏逐条展示时用。
- 注意（第 17 步）：`model_errors` 可以挂 `onLlmCall`（`error` 非空即一次失败）或 `onTurnEnd`；丢遥测行的计数在 `__storeTest.pgStats().telemetryDropped`（存档点里写失败的批次，加上 poisoned 会话丢掉的批次），告警另开读法；`usage_daily` 写失败现在只有一行 warn，带原因码（SQLSTATE，或 `conflict` / `closed` / `held_by_other`，见「审查之后改的」第 5 条）。
- 注意（第 18 步）：OpenTelemetry 导出订阅 `onTurnEnd`（`FinishedTurn` 里有整轮与 outcome）。spec 说按 TurnContext 里记下的时间补建 span 树，现在工具调用与模型调用只有耗时、没有各自的开始时刻（护栏事件有 `at`），导出那一步要给 `TraceCall`、`TraceLlmCall` 补上开始时刻（只在内存，不进库）。运行数字的 SQL 用 `readMetrics`。
- 审查之后改的（2026-10-03；审查报告 spec 3 条、persist 3 条、attrib 2 条，其中 persist 与 attrib 重了两条；按修复说明的编号）：
  1. **连环改写读成相对原稿的净差**（spec[0]）：按事件存的 `guard_events` 不变（符合 spec）。`src/db/repo/traces.ts` 加纯函数 `netGuardDiff`：同一轮按 ord 串起来，后面的事件删掉的、本轮前面某个事件补上的句子互相抵消，删了又补回的也抵消，同一句按次数算。两种读法里选了这一种而不是「第一个事件的 before 对最后一个事件的 after」：库里只存了各事件的 removed / added，不存第一处改写前的可见文本（`draft` 带 `<state>` 块），抵消只用存着的行就算得出，结果与直接对比相同（自测里逐轮核对）。`readGuardTotals` 改为把这些轮次的事件读出来、按轮算净差的句数（净差为空的轮次不在结果里）；`readTurnDiff` 返回 `{ removed, added, events }`，前两项是净差（J 页展开的「删去 / 发出」对照读它），`events` 是逐事件原样。审查提到的 `wmG_empty` 其实不是连环：去 markdown 把「** **」抹成空白之后，兜底那一步的 before 没有句子，逐事件相加本来就对；所以另加了一轮真正连着改同一句的 `wmG_mdlink`（「**方案链接**我这就发您～」：去 markdown 改了这句，出口修补因为许了方案链接却定不下线路，把同一句换成问句）。
  2. **企微非文本消息也是一轮**（spec[1]）：`src/adapters/wecom.ts` 的非文本分支整段包进 `withTurnScope`，建好会话之后 `startTurn`；回了固定提示的记 `deterministic`，`endTurn` 与写进提示、`saveSession` 在同一段同步代码里、带上提示消息（turn_id 随那次落库写进去）；已转人工不回话的记 `silent`、不关联；提示没发出去（或会话已经不在）照样记 `deterministic`，没有可关联的消息；重放时提示已经发过、什么都不做的不算一轮（同重发已生成的回复，那条路也不经引擎、不记）。口径与引擎的确定性路径相同。客户收到的、记进会话的、推送的都不变，锁定的 `wecom.selftest` 照过；运行数字的 `turns` 与转人工率的分母现在算进只发图片的会话。等价套件里原有的 `parity-trim-img`（图片）轮次现在两边都有 trace、照样逐项相同。
  3. **poisoned 会话的遥测不再只进不出**（persist[0]、attrib[1]）：`queueTelemetry` 遇到 poisoned 的会话直接丢掉、`telemetryDropped` 加 1；`poison()` 里把排着的遥测（此后不再起落库，spill 也不带）现在就丢掉；以数据类错误失败的那次落库，快照里的遥测在 `failed` 里一并丢掉。在途的那次落库不在 `poison()` 里动：`schedule` 撞上 window_corrupt 时它还在跑、照样可能提交，提交了就照样写进去（修复说明写的是「已排着的在标 poisoned 时一并丢掉」，在途快照只在确定写不进去时丢）。计数口径与存档点里写失败的相同：一批（一次 `queueTelemetry`，或一个快照里的遥测）算一次。另加 `PgBackend.queuedTelemetry(id)` 与 `__storeTest.pgQueuedTelemetry`，只给自测看内存里还留着几行。
  4. **预载认回 turn_id 先按会话分组**（persist[1]、attrib[0]）：每批在会话循环之外把带 `turnId` 的消息行按 `conversationId` 分好组，每个会话只扫自己那组，不再每个会话扫一遍整批。结果不变（等价套件、原有的认回用例照过）；没让 `rebuildSessions` 交出分组，免得动 import / export 命令行共用的那条读法。
  5. **usage_daily 写失败带原因码**（persist[2]）：PG 后端加 `UsageWriteError`（`code`；`message` 里只有它），`writeUsage` 在 db 一侧归好类再抛：库报的错用 `pgErrorOf` 沿 cause 链取 SQLSTATE / errno 码（drizzle 把驱动错误包了一层，顶层没有 `code`），取不到用错误名；主动不写的三种各有固定码 `conflict`（已冲突）、`closed`（late 段之后）、`held_by_other`（租户锁不在本进程），同时成立时按这个顺序报。`src/trace/usage-daily.ts` 照旧只读顶层的 `code`，不 import `src/db/**`，日志只打原因码，不打错误原文与用量之外的内容。
  - 不改的：重试后仍 408 归 `bad_response`、对冲失败记 `hedged:false`（spec[2]），复核判为不成立：spec 没规定状态码怎么归类，四类都算进出错率与 `model_errors`；`hedged` 的含义是「由对冲模型答出」。
  - 自测（都在 `trace.selftest.ts`，db 存储）：`netGuardDiff` 三组向量（连着改同一句、删了又补回、同一句补两次删一次）；`wmG_link`（`link_whitelist` 接 `repair_links`）与 `wmG_mdlink`（`markdown` 接 `repair_links`）两轮，前提是逐事件相加删 2 补 2，断言 `readGuardTotals` 删 1 补 1、`readTurnDiff` 的「删去」只有模型原句、净差等于原稿与发出的直接 `sentenceDiff`、`events` 原样两条；价格护栏那一轮的对照净差就是那一条事件。企微非文本：假企微服务端驱动真正的适配器，发一张图片之后库里一条 `deterministic` 的 trace、`final_text` 是客户收到的那句提示、占位不关联、提示消息的 `turn_id` 是这一轮；标成已转人工再发一张，记一轮 `silent`、不回话、没有关联的消息。poisoned：id 超长让第一次落库就是数据类错误，落库卡在借连接上时排进来的一批、与会话改动进了同一个快照的一批，标 poisoned 时都丢掉、各计 1；落库在途时因为整体换成副本标 poisoned（window_corrupt），在途那次照常提交、它快照里的 trace 与护栏事件照样进库、不算丢；之后再跑三轮，内存里一行不留、计数涨 3。预载：重启预载之后，库里每个会话窗口里每条消息的 `turn_id` 与内存的关联逐条相同（同一批里十几个会话、几十条关联）。用量：给 `usage_daily` 临时加一条拒绝的 CHECK，经 drizzle 包了一层的 23514 在日志里打成「（23514）」、不带约束名，去掉之后这批补上、合计照对；另开两个后端，锁不在本进程、撞上另一写者、已停机三种拒绝分别是 `held_by_other`、`conflict`、`closed`。
  - 变异（源码拷进 scratchpad 的隔离副本，逐个打、只跑 `trace.selftest`，分组键那条另配等价套件）：17 个全部杀掉。第 1 条：净差不抵消、改写句数仍按逐事件相加、对照的「删去」按逐事件拼；第 2 条：回提示不记、已转人工不记、不开轮次、提示消息不关联；第 3 条：poisoned 仍入队、标 poisoned 时不丢排着的、数据类失败时不丢快照里的、标 poisoned 时连在途快照一起丢（window_corrupt 那条杀掉它）、丢了不计数；第 4 条：分组键写错（按 turnId 分组、取第一个会话的组）；第 5 条：日志不取 cause（只看顶层 `code`，日志变回「（Error）」）、三种拒绝不分原因、冲突报成已停机。
  - 计数：`trace.selftest.ts` 143 → 176，等价套件 903 → 906（图片轮次的 trace 进了比较），其余不变（`store.selftest` 402 / 425、`db.selftest` 497 / 894）；`pnpm test` 的 PASS 行仍是 62。
  - 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍都全绿，mock eval 19/19（文件与 DB 两种配置模式）；锁定套件 8 个文件的 sha256 与第 1 步相同，断言零修改，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变。

### 第 10 步 · 任务表与跟进（2026-10-03）

- 结构：
  - `src/jobs/runner.ts`：spec 的 `JobKind`、`JobStatus`、`JobSpec`、`enqueue`、`cancel`、`startJobs`。认领是 `withJobsTx(claimDueJobs(now, 10))`（第 4 步的仓储，`FOR UPDATE SKIP LOCKED`，改成 running 并提交），之后逐个执行；执行体返回结果（done / cancelled / failed / 改回 pending 带 runAt），认领者在一个短事务里只改仍是 running 的那条；跟进进了 sending 之后的状态由执行体经会话写队列改（`handled`），停机中放弃的留在 running（`stopped`）。执行体在 sending 之前抛错：attempts + 1，到 `max_attempts` 记 failed，否则按 1、5、15 分钟退避改回 pending。本进程认领了、还没写下结果的任务记在内存里（claimed / started / sending / settling）。启动归位在第一批认领之前做（没做成就不认领，下一拍再试：否则本进程认领的 running 会被当成上一个进程的）。上一批没跑完不叠一批。认领与归位失败的日志至多每分钟一行。
  - `src/jobs/followup.ts`：db 存储下跟进的排程与执行体。排程挂在 store 新加的 `onSessionSaved`（只为 db 存储的真实会话调，与 `saveSession` 同一段同步代码，排出的任务进同一次落库）；执行体见下面第 3 条。
  - `src/jobs/notify.ts`、`src/jobs/purge.ts`：`handoff_notify` 与 `retention_purge` 的排程与第 14、16 步之前的执行体（记一行、标 done）。`src/jobs/optout.ts`：拒绝识别（纯函数，`check-boundaries` 的纯函数表加上它）。
  - `src/followup.ts`：资格判断、话术、出口护栏与夜间时段两种存储共用：`shouldFollowUp(s, now)`、`followupStage(s)`（不看时间的静态条件，返回阶段与阈值）、`followUpText(s)`（生成 → `guardOutbound` → 删光了用阶段模板，包在同一个 `pinCatalogForTurn` 里，第 8 步的注意）、`inQuietHours`、`deferQuiet`、`FOLLOWUP_STAGES`、`FOLLOWUP_RETRY_MS`（= `FOLLOWUP_SCAN_MS`）。扫描器改调 `shouldFollowUp(s, Date.now())` 与 `followUpText`；db 存储下 `runFollowUpScan` 什么都不做（boot 也不起它），第 5 步加的「先等 `flushSession` 再推送」那段去掉（第 5 步的注意）。资格里写死的 `'paid'` 改成 `isTerminalStage`（第 1 步第 2 类的 `followup.ts:72`），种子判断改成 `isDemoClassId`。
  - `src/engine.ts`：`guardOutbound(session, text, { kind: 'followup' })`；链接白名单与去 markdown 抽成 `whitelistLinks`、`stripMarkdown`、`allowedPayLinks` 三个函数，对话轮次照旧按原顺序调它们（`noteGuard` 不变）；记下客户原话之后做拒绝识别。
  - store：`withJobsTx(fn)`（PG 后端新加的 `jobsTx`：空的异步上下文里起一个短事务；已冲突、late 段之后、租户锁在别人手里时以 `JobsTxRefused` reject）、`onSessionSaved(cb)`。仓储加 `recoverJobsAtStartup`。`boot.ts` 的依赖多 `storeMode()` 与 `startJobs()`，监听之后 db 存储起任务表、文件存储起扫描器（spec 的启动顺序）；`server.ts` 两者共用同一个 `pushFollowUp`。`enterHandoff` 排转人工通知。
- 本步定的（spec 没写细，按最小、最贴原文的做法）：
  1. **签名**：`startJobs(push)` 带推送函数（spec 写 `startJobs(): void`）：与 `startFollowUpScheduler(push)` 相同的理由，渠道适配器的 `adapterFor` 在 `server.ts` 里。`cancel(dedupeKey, sessionId?)` 多一个可选参数：给了就随那个会话的下一次落库提交，否则单独一个事务（spec 对 `enqueue` 写了「与会话有关时随会话落库提交」，`cancel` 只有 dedupeKey，拆不出会话）。`enqueue` 按 payload 里的 `sessionId` 判断与会话有没有关。
  2. **排程挂在落库上**：spec 写「AI 回复落库时，若会话满足静态条件就排；客户回话时取消」。做法是 `saveSession` 的订阅者看会话本身：最后一条非 system 消息是客户的 → 取消；否则满足 `followupStage` 就排 `followup:<会话>:<阶段>`，`runAt = deferQuiet(updatedAt + 阈值)`，payload `{ sessionId, stage }`，`max_attempts` 3。这样企微图片占位（不经引擎的客户消息）也会取消，判断条件与扫描器的「最后一条是我们发的」相同。订阅者在内存里记着本进程排过的那一个（键与 runAt）：同一个键、时刻不比它早就不动；换了阶段或最后动静往后挪了，先取消旧的再排；不知道（重启之后还没落过库）时客户回话按四个阶段的键都取消、排程不先取消（库里已有的留着，到点时重判、早了就顺延）。`FOLLOWUP_ENABLED` 不是 `1` 时订阅者什么都不做，`followupStage` 本身也看开关（到点时关了的取消、不发）。执行体自己的 `saveSession` 跳过订阅者（账与任务状态由执行体一并排）。
  3. **执行体**（spec 的顺序）：会话不在、不再满足静态条件、阶段变了 → cancelled；还没沉默够（排程之后又有动静）或正赶上夜里（停机期间错过、启动时是夜里）→ 改回 pending、`runAt` 顺延，不算一次尝试；生成话术（停机时可被叫醒放弃）→ 在活对象上重判 `shouldFollowUp`（生成期间客户回了话就 cancelled，`last_error='changed'`；认领者写下取消之后按活对象再排一次，因为生成期间那句 AI 回复的排程撞上了还没结束的这条）→ 额度（`followupQuotaAllows`，**第 12 步之前是桩、一律放行**，第 12 步换成 R18 的「剩余 ≥2 条且窗口剩余 ≥2 小时」，额度不够记 cancelled、不退账也不计失败）→ 记账（count、stages、lastAt、pendingAt）并把 running → sending 排进同一段同步代码 → `flushSession(5 秒)` 等它提交 → 推送。提交没等到：不推送，任务记 abandoned（`ledger_not_committed`），账留在内存里随之后的落库或 spill 写下（宁可漏一条）。推送成功：跟进写进会话（`author='followup'`，后台标「自动跟进」；扫描器写的同样带上），失败计数归零，任务 done。明确失败：退账、失败计数加 1、任务 failed（`push_failed`）；还没到 `MAX_PUSH_FAILURES` 就在同一批里按扫描器的节奏再排同一个键（`runAt` 不早于现在 + `FOLLOWUP_SCAN_MS`，夜间顺延）——spec 只写了「failed、失败计数加 1」，不再排的话一次网络抖动就让这个阶段永远不追，与扫描器不一致。推送抛异常（结果不明）：按已发处理，账不退、`pendingAt` 留着，任务记 abandoned（`push_unknown`），不重试。排程用认领时给的「现在」往后算（自测拨钟时也一致），账上记的时刻用真钟。
  4. **重启与停机**：照 spec 四条，一个事务（`recoverJobsAtStartup`）：跟进的 running → pending；跟进的 sending → abandoned（`restart_in_sending`）；其余种类的 running → attempts + 1，到 `max_attempts` 记 failed（`interrupted`），否则 pending。停机 normal 段的钩子：不再认领、叫醒正在生成话术的跟进、把本进程认领了而还没进 sending 的跟进改回 pending，再等手上那条推送回来（等不到也不影响会不会重发，F1 的口径）。其余种类认领了还没开始的照 spec 不动，下次启动归位（本步它们的执行体都是瞬时的）。
  5. **`guardOutbound`**：同一套护栏、同一批函数：链接白名单、去 markdown、空位与「说了发链接却没有链接」（这里不补链接，`dropLinkPromise` 删掉承诺那几句与空位）、内部用语（`dejargon`）、改行程的空头承诺（`neutralizeStandardDays` 之后 `keptBesideCustomPromise` 删句）、「为您转接」（`dropTransferClaims`）、价格规则与服务承诺（`dropUnbackedClaims`）、价格（`findUnbackedPriceHits` 命中的句子删掉）、半截句。没有本轮：工具调用为空（方案书链接一律抹掉，支付链接只认本会话没被替代的真订单），客户这一句为空串（金额只认会话里有出处的）。不补链接、不换兜底、不转人工；删完只剩残句（`strandedAfterDrop`）或删光返回空串，跟进换阶段模板。四条阶段模板原样通过（自测核对）。不在轮次里，`noteGuard` 什么都不记（第 9 步的注意）。
  6. **拒绝识别**：按小句（中英文标点与空白断开），整句去掉开头的应答词（好的、那就、算了、谢谢……）与句末客气话、语气词之后，必须整句就是这几种之一：「不用了 / 不需要了 / 不必了」、「别（再）发了 / 不要再给我发消息了 / 不用再联系我了 / 别打扰我了」、「已经在别家订了 / 已经订了别家的了」、「不考虑了」。排除：问号结尾、吗呢么嘛吧结尾（在问或在犹豫）、带否定（「不是不需要了」）、「先」「暂时」开头（「先不用了」「暂时不考虑了」：现在不要，跟进本来就隔几个小时）、带宾语（「不用发了」「方案不用再发了」说的是不用发某样东西）。第 1 步第 8 类列的反例与锁定原话都不算；锁定套件与 `eval/cases.json` 里 4,142 个中文字符串逐个跑过，没有一个命中，它们的期望不变。命中时记 `followupOptOut = { at, quote }`（原话 ≤200 字），这一轮照常回复；db 存储下排着的跟进随这次落库取消（客户回话即取消），之后 `followupStage` 一律不排。重置不清它（spec 的重置清单里没有，`followup` 的记账重置也不清）。
  7. **`handoff_notify`**：`enterHandoff` 在进入或升级转人工的同一段同步代码里 `queueJobs` 两个任务，随这次转人工的落库提交：`handoff_notify:<会话>:<转人工时刻>:started`（`runAt` = 转人工时刻）与 `…:unclaimed`（+10 分钟，到点时由第 14 步的执行体判断还有没有人接手），payload `{ sessionId, reason, handoffAt, escalated }`，`max_attempts` 4（首次加至多重试 3 次）；升级（emergency）只排立即的那一个。文件存储与 demo 类丢弃。「企微窗口剩不到 4 小时、仍在转人工中」那一个要发送窗口（第 12 步），留给第 12、14 步。第 14 步之前的执行体：记一行、**标 done**（留 pending 的话每 5 秒被认领一次）。
  8. **`retention_purge`**：第一批认领之前排下一个 3:30（服务器本地时间，`now` 正好是 3:30 也算当天的），之后每小时补排一次（已有就什么都不做），执行完在写 done 的同一个事务里排下一天的；键 `retention_purge:<本地日期>`，payload `{ day }`、不带 sessionId，`max_attempts` 3。第 16 步之前的执行体：记一行、标 done、排下一天的。
  9. **改了的非锁定自测**：`store.selftest`、`config.selftest` 的 `boot()` 依赖补 `storeMode` 与 `startJobs`，`store.selftest` 加一条「db 存储下监听之后起任务表」；`trace.selftest` 的那次跟进改走任务表（装上钩子、落库排上、认领一批，夜里跑时拨到 9:00）；等价套件的「跟进」组 PG 一边换成任务表（第 7 步的注意），文件一边仍是扫描器，没送达的那个会话改停在 objection（异议后 4 小时）：扫描器按 updatedAt 从新到旧、任务表按 run_at，两边才是同一个先后、吃同一份模型脚本；第二轮 PG 一边拨到扫描间隔之后；PG 一边另核对任务表（送达的 done，没送达的两次 failed、还排着下一次），比较项照旧。
- 自测：
  - 新套件 `src/jobs/jobs.selftest.ts`（串在 `trace.selftest` 之后，约 5 秒）：父进程跑拒绝识别的向量表（20 条该认、27 条不该认，含第 1 步第 8 类的反例与锁定原话），再起子进程（单进程、SIGKILL 超时、预加载等价套件的钟，从当天 12:00 起走）。main 子进程在 PGlite 上装 DB 配置与 db 会话存储、假模型按脚本回话：夜间顺延、清理时刻、通知任务的纯函数；`guardOutbound`（模板原样、去 markdown、站外链接与假支付链接、方案书链接、内部用语、改行程、转接、编造金额、残句返回空串）；经引擎的真实轮次排程与取消（payload、runAt、图片占位也取消、下一轮按新的最后动静再排）；换阶段；生成期间客户回话（重判取消、之后再排）；开关关时一个跟进任务都不排、排着之后关掉到点取消；到点发出（编造的 13,579 元不在发出的文本里，推送那一刻库里已记账且任务是 sending，done、写进会话、updatedAt 不动、同一阶段不再推）；明确失败三次（退账、计数、按扫描间隔重排、到上限不再排）；推送抛异常记 abandoned；「别发了」（记标记带原话、取消、不再排、之后不推）与「先不用发方案了，我再想想」照常排；夜间（排程时 23:00 顺延到 9:00、执行时 23:30 顺延到次日 9:00 不算尝试）；转人工通知（两个任务、立即的 done、10 分钟的到点 done、不排跟进）；清理（下一个 3:30、执行体带上下一天的、到点 done 并排下一天）；停机（生成途中 1 秒内结束、改回 pending 不推，已进 sending 的不动并等推送回来）；启动归位（四种去向各造一条）；执行体出错按 max_attempts 重试；db 存储下扫描器不动、`shouldFollowUp` 认 `followupOptOut`。落盘的 PGlite 一串四个进程：生成话术途中（任务 running、还没记账）被 SIGKILL → 重启照常发一次、done；推送途中（记账与 sending 已提交）被 SIGKILL → 重启记 abandoned、不重发、账还在。真实 PG 子进程：另一个认领者拿着 5 个任务不提交，runner 3 秒内拿到其余 7 个并做完，两边不相交、被拿着的 5 个仍是 running。
  - 计数：`jobs.selftest` 不带 PG 77 项、带 PG 80 项；`store.selftest` 402 / 425 → 403 / 426；等价套件 906 → 908；`trace.selftest` 176 不变；`pnpm test` 的 PASS 行 62 → 63。锁定的 `llm.selftest` F1（文件存储的扫描器）照过，断言零修改。
- 变异（源码拷进 scratchpad 的隔离副本，逐个打、只跑 `jobs.selftest`，认领那条带真实 PG）：33 个，32 个杀掉。brief 点名的几类：sending 之后崩溃仍重发（启动时把 sending 改回 pending：启动归位与重启那一边的 abandoned 断言都红；改回 pending 之后重判时账已记过、其实不会真重发，靠任务状态的断言杀掉）、认领不加 SKIP LOCKED（真实 PG 的两个认领者：runner 被拿着的行锁挡住 3 秒）、开关关时也排（共用资格与落库钩子两处一起去掉）、客户回话不取消、夜间不顺延（另两个：只是排程时不顺延、执行时不看夜里）、跟进不过护栏、拒绝识别按子串（另两个：不排除疑问、引擎不调拒绝识别）、opt-out 之后仍排。其余：推送之前不等记账提交、不进 sending、停机不改回 pending、停机不叫醒生成、推送失败不退账、不再排重试、重试不等扫描间隔、推送抛异常当明确失败、启动时其余种类不加 attempts、running 的跟进不改回 pending、不做启动归位、转人工不排通知、清理不排下一天、生成之后不在活对象上重判、取消之后不再排、不看失败次数上限、执行出错不重试、换阶段不取消旧的、db 存储下扫描器照样扫、跟进消息不带 author。首轮存活两个，补断言之后杀掉：停机不叫醒生成（原来只靠子进程的 240 秒超时才红，补了「生成途中停机 1 秒内结束」）、清理执行体不排下一天（每小时的补排盖住了它，补了执行体返回值的断言）。剩下一个等价：只去掉落库钩子里的开关判断（共用的 `followupStage` 照样看开关，只多几条取消的空 UPDATE）。
- 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍都全绿，mock eval 19/19（文件与 DB 两种配置模式）；锁定套件 8 个文件的 sha256 与第 1 步相同，断言零修改，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变。
- 注意（第 12 步）：`followupQuotaAllows`（`src/jobs/followup.ts`，审查之后它调的是 `quotaAllows` 这个桩）换成账本的判断。审查之后它在两处调：生成话术之前（不够就不调模型）与记账之前在活对象上再判一次（生成期间额度可能被顾问在后台的发送用掉）；额度不够记 cancelled（`quota`）、不退账不计失败，**不再排**（「审查之后改的」第 4 条）：窗口只在客户再开口时重开，那时客户回话取消、AI 回复落库重排。不要改回「cancelled 之后按活对象重排」，那是每 5 秒一次模型调用的循环（R18 的「剩余 ≥2 条」被分段回复压到 2 以下、48 小时窗口过了，都会一直不够）；真要顺延，返回 pending、`runAt` 设成额度恢复的时刻。跟进推送时手上还没有 `ChatMessage`（送达才写进会话），账本要的 `message_seq` 得先把消息对象带出来，与第 1 步第 4 类列的 820、845、470 同一类。`handoff_notify` 的「窗口剩不到 4 小时」那一个在有发送窗口之后排。
  企微推送的「结果不明」（审查 spec[1]，本步不改代码）：`src/adapters/wecom.ts` 的 `sendText` 把 `send_msg` 的超时与网络异常都 catch 成 `false`，所以跟进执行体「推送抛异常按已发处理」在企微通道上走不到；超时其实已送达时，执行体按明确失败退账，15 分钟后同键再发一条（文件存储的扫描器原来也一样）。做 msgid 与 `unknown` 记账时，`push` 要把「明确失败」与「结果不明」分开报给调用方（不改 `ChannelAdapter.push` 返回 `boolean` 的签名的话，用 `recordSend` 的 `settle` 结果或另一个出口），跟进执行体对结果不明按已发处理：账不退、不重排、任务记 abandoned（`push_unknown`）。
- 注意（第 13 步）：跟进消息带 `author='followup'`（两种存储），J 页标「自动跟进」；`followupOptOut` 在会话状态里（`state` 列），J 页要不要显示由第 13、20 步定。
- 注意（第 14 步）：换掉 `runHandoffNotifyJob`（`src/jobs/notify.ts`）：`reason='unclaimed'` 的到点时看会话还在不在转人工中、有没有接手人，没有就发，有了就 done；抛错由认领者按 `max_attempts` 4 重试，用完记 failed（第 17 步的 `jobs` 告警挂在这里）。payload 里有 `handoffAt`，同一会话交还之后再转人工是另一组键。重置会取消这个会话待执行的通知（「审查之后改的」第 9 条），已在执行的（running）取消不了，执行体到点照样要看会话的现状。
  一批串行执行（审查 spec[3]，本步不改代码）：runner 每拍认领一批、逐个 await，上一批没跑完不认领下一批；夜间顺延的跟进都排在 9:00:00，9 点刚过转人工的「立即」通知按 `run_at` 排在它们后面，要等若干批跟进生成话术（模型超时 45 秒起）、推送完才轮到。接上群机器人之前，按 kind 分道认领（`handoff_notify`、`retention_purge` 与 `followup` 各认领各的一批），或让跟进有限并发执行、不挡下一拍的认领。
- 注意（第 16 步）：换掉 `runRetentionPurgeJob`（`src/jobs/purge.ts`），返回值的 `enqueueNext` 照旧带下一天的。spec 的「有任务在跑就跳过」：本进程认领中的任务在 runner 的内存表里（`__jobsTest.mine()` 现在只给自测，要用就导出一个按会话查的函数）。清除与行权删除照第 4 步连带删 payload 里 `sessionId` 是这个会话的任务，跟进与通知的 payload 都带着。
- 注意（第 17 步）：`jobs` 告警（`retention_purge` 或 `handoff_notify` 用完重试记 failed）的两个出处：认领者写下 failed 的那一处（`settle`）与启动归位的 `otherFailed`。
- 注意（演示）：重置不清 `followupOptOut` 与 `followup` 的记账（与开工时相同）；跟进默认关，演示实例上要不要在重置时一并清掉，等 owner 需要时再改（审查 compat[3]、optout[4] 复核判为不是缺陷，照旧交给 owner；误判的根子在拒绝识别，已按「审查之后改的」第 1 条修好）。
- 审查之后改的（2026-10-03；审查报告 spec 4 条、once 4 条、compat 5 条、optout 5 条，其中重了四组；按修复说明的编号，审查原文的标号写在括号里）：
  1. **要成交、要继续聊的话不再记成拒绝**（compat[0]、optout[0]）：原来 `followupOptOutOf` 只要一个小句命中就算，「不用了，就订这个」「不用了，发我付款链接」「不考虑了，看看云南吧」「好的不用了，帮我改成3个人」都记了 `followupOptOut`，closing 阶段的催付跟进被永久关掉。改成按整条消息判：至少一个拒绝小句，其余每个有内容的小句要么也是拒绝、要么只是客气话或应答（`ACK`：谢谢、谢谢您的推荐、好的、好吧、行吧、嗯、哦、拜拜、再见、ok、thanks、收到、知道了、辛苦了、不好意思、「有需要再联系您」；去掉开头应答词与句末客气话之后为空的也算），有任何别的小句（成交、问询、改需求、看别的线路、「我再想想」）就不算。原「算」表里的「这个价位太高了，不考虑了」按这个口径不算了（带着价格异议，异议阶段的跟进正是为它），移进「不算」表。单独一句「不用了」照 spec 的例句仍算。
  2. **常见的「别发了」说法认得出**（optout[1]）：判之前先归一：NFKC（全角转半角）、英文转小写（「thank you」并成 thanks）、繁体常用字转简体（只收拒绝说法与客气话里会出现的三十来个字：別發慮經訂謝們給擾……嗎麼），emoji（`Extended_Pictographic`、肤色、变体选择符、零宽连接）与微信表情码（`[微笑]`、`[捂脸]`、`[OK]`）换成空格当分隔；小句边界加上破折号、连字符、括号、引号、冒号；小句里连说两遍的折成一遍（「不用了不用了」）。`LEAD` 加「以后、今后、往后、请、麻烦（你 / 您）、拜托（你 / 您）、求（求）你、ok」，`TAIL` 加「拜拜、再见、thx、thanks、ok、bye」。疑问照旧排除（spec「疑问与否定排除」）：「可以别发了吗」「别再发了好吗？」「能不能别再发了？」进「不算」表。向量表 49 条该认、57 条不该认（原 20、27）。锁定套件 7 个文件与 `eval/cases.json` 的中文字符串（整串，加上按行拆开的，共 4,423 个；原来的 4,142 只数整串）重扫一遍，零命中，锁定期望不变。
  3. **重试用完记 failed 之后不再同键重排**（spec[0]、once[1]、optout[2]）：`afterSettle` 原来对 failed 与 cancelled 一样处理，按活对象再排同一个键，`runAt` 早已过去、下一拍就认领，attempts 从 0 重来，`max_attempts` 封顶不了。现在只在 cancelled 且 `last_error='changed'`（本步定的第 3 条那种：生成期间客户回话，AI 回复的排程撞上了还没结束的这条）时再排；其余结束的（failed、`quota`、`not_eligible`、`no_session`）把本进程的 `known` 记成「确知没有」（重启之后不知道的也记成没有：之后哪次与客户无关的落库都不会把它立刻排出来），不排，等客户下一次回话、AI 回复落库时照正常排程再来。
  4. **额度不够不再变成每 5 秒一次模型调用**（spec[2]、once[2]）：额度判断挪到生成话术之前（R18 的判断不看话术；不够就不调模型，记 cancelled（`quota`）），记账之前在活对象上再判一次；两处不够都不再排（第 3 条）。现在的桩一律放行，自测经 `followupJobs.setQuotaForTest` 换成不放行；第 12 步换掉桩之后照样成立，见「注意（第 12 步）」。
  5. **认领令牌**（once[0]）：原来 running → sending 只看 `from: running`，`setJobStatus` 的返回值在 `writeSideRows` 里丢掉；租户锁丢失的窗口里另一个进程启动归位、重新认领同一行，两边都会推送。现在认领者写的每一次状态变化都带认领令牌：`setJobStatus` 多 `claimedAt` 选项（`claimed_at` 等于认领时写下的那个时刻才改），`JobOp` 的 status 多 `claimedAt` 与 `report`。跟进的 running → sending 带 `report`：PG 后端把 `setJobStatus` 的返回值记在这次落库的快照上，提交之后才交给 store 新导出的 `jobOpApplied(会话, 任务)`（取走一次；按 flush_id 认出上一次其实提交了的，快照上留着的正是提交了的那一次的结果）。执行体在 `flushSession` 之后据它判断，没改中就不推送、记一行，已提交的账不退（多记一次是安全的一侧）；之后的 done / failed / abandoned 与 runner 的 settle、停机时改回 pending 也带令牌，settle 没改中记一行 warn、以库里的为准。runner 在租户锁不在本进程手里（`configHealth().lock` 不是 `held`，或锁已被别的进程拿走）时不认领、不执行（这一拍连启动归位与补写都不做）；执行到一半锁丢了，这一批还没开始的带令牌放回 pending（`runAt` 不变、不算一次尝试）。令牌用现成的 `claimed_at`，不加列、不加迁移：只有同一毫秒里两个认领者先后认领同一行才会撞，而归位与重新认领之间隔着至少一个事务。
  6. **settle 写失败不再让任务永远停在 running**（once[3]）：认领者写结果的短事务失败时，结果进本进程的待补队列（`__jobsTest.unsettled()` 给自测看），下一拍在启动归位之后、认领之前带令牌补写一次，补上了才照常 `afterSettle`（「生成期间客户回话」的那条因此能按活对象再排）；补写也失败就留给下次启动归位，`followupJobs.forget` 把 `known` 里的这个键清成「不知道」。
  7. **跟进话术不先抹网址**（compat[1]）：`composeFollowUp` 去掉两条清网址的 replace，原文交给 `guardOutbound`，它的链接白名单才看得见「说了给链接」的地方：「方案链接：<站外网址> …」「详细方案：<方案书链接> …」连同承诺那句删掉，删光换阶段模板（原来发出「方案链接： 您看看哪天出发合适？」）。`ord_` 那条留着：订单号先抹掉，支付链接成了半截、按假支付链接抹成空位，所以跟进照旧不带链接（本会话的真支付链接也一样）。锁定 F1 照过（它的话术里没有链接）。
  8. **`guardOutbound` 删「由顾问确认」「顾问会联系您」**（compat[2]）：在删「为您转接」那一步之后，按句（`transferSentences`）删掉命中 `DEFER_TO_CONSULTANT` 或 `promisesContact` 的句子，条件与 AI 回复路径补记待办的相同（有活订单、售后对接、付款之后、选项行的不算），删光返回空串、由调用方换模板。选了删句、不补记待办：跟进是主动外发，不替顾问揽活。
  9. **重置取消待执行的 `handoff_notify`**（compat[4]、optout[3]）：`JobOp` 多一种 `cancelSession`（kind 与 sessionId），仓储 `cancelPendingJobsOfSession` 按 `payload->>'sessionId'` 取消这一种 pending 的任务；`src/jobs/notify.ts` 的 `cancelHandoffNotifyOps`，引擎重置分支在 `delete session.handoff` 之前 `queueJobs`，随重置那次落库提交。按 payload 认会话、不按 `session.handoff.at` 拼键：升级会覆盖转人工记录里的时刻，拼不全。只取消 pending 的（spec 写的是「待执行」），running 的已在执行，与 `cancel` 的口径相同。文件存储与 demo 类 `queueJobs` 什么都不做，E6、E6p 不受影响。
  - 只写进注意、本步不改代码的两条：企微推送的「结果不明」（spec[1]）见「注意（第 12 步）」，一批串行执行挡住「立即」的通知（spec[3]）见「注意（第 14 步）」。
  - 自测（都在 `jobs.selftest.ts`）：向量表按上面两条扩充。main 子进程新加：重试用完（记账之前那次额度判断抛错，即生成之后、模型已经调过）只留一条 failed（attempts 3），拨钟三天不再认领、模型调用不再增加；额度桩不放行时拨钟七拍模型调用 0 次、只有一条 cancelled（`quota`）；租户锁丢失时认领 0 条、重新取到之后照常发出（锁状态在进程内，PGlite 上测）；生成期间客户回话、认领者写结果时借连接失败 → 任务仍是 running、进待补队列 → 下一拍补成 cancelled（`changed`），同一个键按 AI 那句回复照常排出新的跟进；`followUpText` 经假模型：站外链接、方案书链接、「顾问会联系您」都换成阶段模板；`guardOutbound` 的三句联系类；转人工之后重置，这个会话的两个通知都是 cancelled。新的 `file` 子进程（文件存储、mock 引擎）：四川报价之后说「不用了，就订这个」，照常建单进 closing、不记拒绝，沉默过 closing 的 3 小时阈值之后扫描器发出催付跟进。真实 PG 子进程：生成话术途中另一条连接把这一行归位、认领成自己的，原认领者的落库照常提交但不推送，那一行仍是对方认领的 running，账不退。
  - 变异（源码拷进 scratchpad 的隔离副本，逐个打、只跑 `jobs.selftest`，令牌那四个带真实 PG）：22 个，21 个杀掉。第 1 条：只看一个小句、应答表放宽成吞掉任何小句（向量表与文件存储的端到端都红）；第 2 条：不归一表情、`LEAD` 不含「以后」、叠说不折叠、繁体不转简体、破折号连字符不当分隔；第 3 条：failed 也重排；第 4 条：额度检查放回生成之后（生成之前不判）、额度不够也重排；第 5 条：running → sending 不带令牌、不看改没改中照推、仓储的 `setJobStatus` 不比 `claimed_at`、PG 后端丢掉 `setJobStatus` 的返回值（一律当改中）、锁不在手里照样认领；第 6 条：settle 失败不补写；第 7 条：网址仍预清洗；第 8 条：联系类句子不删、只删「由顾问确认」不删「顾问会联系」；第 9 条：重置不取消通知、PG 后端不执行 `cancelSession`。存活的一个等价：settle 失败之后照旧立刻 `afterSettle`（不等补写）——那时任务还是 running，按活对象再排撞上它、什么都没排，补写之后的那次 `afterSettle` 照样排上，结果相同。
  - 计数：`jobs.selftest` 77 / 80 → 95 / 100（不带 / 带 PG），其余不变（`store.selftest` 403 / 426、等价套件 908、`trace.selftest` 176）；`pnpm test` 的 PASS 行仍是 63。
  - 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，`127.0.0.1:55432`）与不带各跑一遍都全绿，mock eval 19/19（文件与 DB 两种配置模式）；锁定套件 8 个文件的 sha256 与第 1 步相同，断言零修改，锁定的 `llm.selftest` F1 照过，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变。
  - PR #79 第一次 CI 红的两处（都是自测本身的问题，产品代码没动）：
    - main 子进程被 240 秒超时杀掉：N 组（生成话术期间客户回话）在 `waitFor(phase === 'started')` 之后、`releaseHung()` 之前没有 await，而 `started` 在调执行体之前就置上了，生成话术的请求这时可能还没到假模型服务器。CI 的机器慢一点，`releaseHung()` 放行了个空，请求随后到达、一直卡到 `LLM_TIMEOUT_MS`（600 秒）。给假服务器加 30ms 处理延迟在本机确定性复现（输出停在同一处）。改成 `releaseHung` 先等假模型真收到那个请求再放行（10 秒没收到记一条失败），四处调用都 await。这是第 10 步原有的竞态，不是 CI 慢在哪：本机整个子进程几秒跑完。
    - 真实 PG 的令牌两条：rpg 子进程用真钟（库的 `now()` 不跟着拨），CI 是 UTC、在 03:16 跑，跟进的 `runAt` 落在夜间时段、顺延到 9:00，根本没到点，没认领就没有可查的行。不是 `claimed_at` 的精度、时区或 PG 版本（CI 的服务与本机同是 `pgvector/pgvector:pg17`），也不依赖被杀的 main 子进程。rpg 子进程改为关掉夜间时段（`FOLLOWUP_QUIET_START` 与 `FOLLOWUP_QUIET_END` 都设 0），夜间顺延照旧由 main 在钉住的钟上测。
    - 本机复现与验证：`TZ=UTC`、本机时间 03:23 UTC 跑出同样的两条失败；修好之后 `TZ=UTC` 加真实 PG、假服务器加 30ms 延迟、压满 10 个核三种条件下 `jobs.selftest` 都是 100 项全过，`CI=true TZ=UTC` 带 PG 的完整 `pnpm test` 全绿。

### 第 18 步 · 运行数字与 OpenTelemetry（2026-10-03）

- 顺序调整：第 17 步（日志与告警）还没做，本步先做（另开一条线，与第 10–13 步并行）。`src/ops/ops.selftest.ts` 由本步新建，只有运行数字与 OpenTelemetry 两部分；第 17 步往里加日志与告警的部分（含 `watch.sh`、`backup.sh` 的子进程用例），套件已经串在 `test` 里（`trace.selftest` 之后）。
- 依赖（钉精确版本，进 `dependencies`：生产镜像要能在设了端点时加载）：`@opentelemetry/api` 1.9.1、`@opentelemetry/sdk-trace-base` 2.11.0、`@opentelemetry/resources` 2.11.0、`@opentelemetry/exporter-trace-otlp-http` 0.222.0（后三个是 2026-08-31 的稳定版，之后只有 development 预发布），间接带进 `sdk-trace`、`core`、`otlp-exporter-base`、`otlp-transformer`、`semantic-conventions` 1.43.0 等。lockfile 里 `drizzle-orm` 的可选 peer `@opentelemetry/api` 随之解析到了：它的 `tracing.js` 从不加载 otel（`otel` 恒为 undefined），没设端点的子进程用例照样一个 `@opentelemetry/*` 都没见到。
- 结构：
  - 运行数字：`src/db/repo/metrics.ts` 的四条 SQL 逐条核过与 spec 口径一致（p90 只算 `replied`、转人工率分子分母都按会话、出错率含 `llm` 里 `error` 非空或 `outcome='error'`、费用的「今天」由调用方给），没改。`src/ops/metrics.ts`：`metricsWindow(now, days)` 与 `readMetricsView(ctx, days, now)`（60 秒缓存、换算）。`GET /api/console/metrics` 挂在 `src/console-api/app.ts`，`MetricsView` 与 `MetricsQuery` 在 `src/shared/console-api.ts`。
  - OpenTelemetry：`src/otel/export.ts`（`startOtel`、`exportTurn`、`flushOtel`，静态 import `@opentelemetry/*`，它自己只经动态 import 加载）；`src/ops/otel.ts` 的 `startOtelExport`（动态 import 导出器、`startOtel`、订阅 `onTurnEnd`、每轮取会话引用与渠道）；`boot()` 多一个可选依赖 `startOtel`，只在 `OTEL_EXPORTER_OTLP_ENDPOINT` 非空时、会话存储就绪之后、监听之前调，`server.ts` 传 `startOtelExport`。
  - recorder：`TraceCall`、`TraceLlmCall` 各多一个只在内存的 `startedAt`（工具是调用那一刻，模型调用是收到 `onLlmCall` 时减去 `ms`），写 trace 行时去掉，`turn_traces.calls`、`llm` 的形状与第 9 步相同；`startTurn(conversationId, input?)` 收本轮客户原话（引擎改一处：`startTurn(sessionId, text)`；企微非文本消息那条路不给，是空串），`FinishedTurn.input` 交给订阅者，只给 `OTEL_CAPTURE_CONTENT=1` 用。
  - 会话 ref：PG 后端的写队列条目带上 `conversations.ref`：预载的取库里的；新会话在建写队列时生成（`randomUUID`），第一次落库插入时写进去（`insertConversation` 多收一个可选的 `ref`，导入命令行不给、仍由库生成），所以还没提交过的新会话第一轮就有；spill 带上它，回放插入时用。`store.conversationRef(id)`：db 存储的真实会话有，文件存储与 demo 类会话为 null。
  - `scripts/check-boundaries.ts` 加三条（`Imp` 多一个 `dynamic`）：`src/otel/` 之外不许 import `@opentelemetry/*`（静态、动态都不行，`import type` 除外）；`src/otel/**` 在外面只能动态 `import()`（自测也一样，`import type` 除外）；`src/otel/` 不 import `src/db/`（`import type` 也不行）。
  - `OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_CAPTURE_CONTENT` 进 `.env.example`（默认注释掉）。
- 本步定的（spec 没写细，按最小、最贴原文的做法）：
  1. **`days`**：1–90 的正整数，默认 7（上限照 spec 的 `intParam(90)`；实际天数再按租户的 trace 保留期截断，见「审查之后改的」第 6 条），不合规 400 `bad_request`。窗口是近 `days` 个自然日、含今天：起点是服务器时区 `days-1` 天前那天的 0 点，轮次取 `started_at >= 起点`（不设上限，库里没有未来的 trace），费用取 `day` 在 `sinceDay`…`today` 之间；「今天」与 `usage_daily.day` 同一个口径（`todayIso`，服务器 `TZ`）。
  2. `replyP90Ms` 取整到毫秒；两个比率原样（0–1），费用是千分之一元之和除以 1000。
  3. **缓存**：键是（租户、days）（审查之后改成（租户、实际天数），保留期按租户另缓存 60 秒，见第 6 条），按后台接口的 `clock` 计 60 秒；在算的那一次也共用（并发的请求不各查一遍），算失败不留缓存；时钟往回走就重算。最多每个租户 90 个键。
  4. **顺序**：权限先于存储模式（文件存储下 viewer 也是 403，不是 503）；`canSeeMoney` = owner、admin（权限表「本月成交额、运行数字」那一行；第 13 步的 `/orders/summary` 用同一个中间件）。文件存储 503 的 detail 写「运行数字只在 SESSION_STORE=db 时有」。
  5. **`exportTurn` 的签名**：spec 是 `(t: TurnContext, outcome, meta)`，实际是 `exportTurn(f: FinishedTurn, meta: TurnMeta)`：`onTurnEnd`（第 9 步）交的就是 `FinishedTurn`，`TurnContext` 与 `outcome` 都在里面，另有根 span 要的耗时、`OTEL_CAPTURE_CONTENT` 要的原话与最终回复。`meta` 在 spec 的 `tenant`、`conversationRef`、`channel` 之外多 `agent`、`provider`、`requestModel`（进程内不变，由接线取好；`src/otel/` 不碰 store 与配置）。
  6. **会话引用**：db 存储的真实会话用会话行的 `ref`；文件存储与 demo 类会话没有 ref，原来用短码（`shortIdOf`），审查之后改成按会话 id 算的匿名引用 `anon-<16 位十六进制>`（短码会撞，见「审查之后改的」第 1 条）。会话原 id 任何时候不进 span。
  7. **属性**（核对依据写在 `src/otel/export.ts` 文件头：`open-telemetry/semantic-conventions-genai` main 的 `e07f4eb`（2026-10-02）的 `gen-ai-spans.md` 与 `gen-ai-agent-spans.md`——审查之后改正，原来写的核心仓库 1.43.0 里 GenAI 部分已只剩「Moved」——与 Langfuse 文档「Native OpenTelemetry · Attribute Mapping」，2026-10-03 读取）：spec 列的逐个照写。spec 之外加的：根 span 也写 `gen_ai.provider.name`（进程内的 invoke_agent 是 internal span，约定的属性表里没有它：本项目自加，便于按厂商筛）；`gen_ai.conversation.id` 写在每个 span 上（审查之后改的第 3 条）；`app.turn.id`（turn_traces 的 id，接 Langfuse 之后能对回后台的 trace）、`app.tenant`（文件配置模式没有租户，不写）、`app.channel`（meta 里给的这两个落在这里）；`langfuse.session.id`、`langfuse.user.id`、`langfuse.trace.name` 写在每个 span 上（Langfuse 文档建议，按 span 过滤与聚合才准）。护栏的句数是 `app.guard.removed`、`app.guard.added`（整数）。缓存命中照 spec 写 `app.llm.cached_tokens`：约定里已有 `gen_ai.usage.cache_read.input_tokens`，换不换等接 Langfuse 时按它的计价口径定。`gen_ai.agent.name` 是行业包 id（行业包没有单独的助手名；文件配置模式是 `travel`）；`gen_ai.provider.name` 是 `LLM_PROVIDER`，没写时按 `LLM_BASE_URL` 的主机名推（`deepseek.com` 是约定的已知值 `deepseek`，`bigmodel.cn` 与没设是自定义值 `zhipu`，其余是自定义值 `openai_compatible`；原来写的「约定的 `_OTHER`」不对，`_OTHER` 只是 `error.type` 的兜底值，见「审查之后改的」第 2 条）；对冲答出时 `gen_ai.request.model` 是主模型、`gen_ai.response.model` 是对冲模型；出错的调用只有 `error.type`（四类失败原样）与 ERROR 状态，不写用量与 `response.model`；`outcome='error'` 的轮次根 span 标 ERROR 并写 `error.type`（审查之后加的）；执行时抛错的工具调用标 ERROR、`error.type=_OTHER`（同上）。span kind：`chat` 是 CLIENT，其余 INTERNAL。护栏是同步改写，起止都是事件的 `at`。
  8. **原文**：`OTEL_CAPTURE_CONTENT=1` 每轮读一次 env；开着时根 span 写 `gen_ai.input.messages`（客户原话）与 `gen_ai.output.messages`（最终回复），约定的 parts 写法；`execute_tool` 写 `gen_ai.tool.call.arguments`（执行时的那份参数）。工具结果、模型原稿任何时候都不写。
  9. **导出器配置全走 OpenTelemetry 的标准环境变量**（`OTEL_EXPORTER_OTLP_ENDPOINT` 补 `/v1/traces`、`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_EXPORTER_OTLP_TIMEOUT`、`OTEL_BSP_*`），不另造；只有 `OTEL_EXPORTER_OTLP_ENDPOINT` 打开导出（别的设了也什么都不加载）。resource 只有 `service.name=wecom-sales-agent`、`service.version=APP_REVISION`（没设是 `dev`，与 `/healthz` 的 revision 同一个来源）。
  10. **启动与失败**：设了端点时 `boot()` 在监听之前 `await startOtel()`（多一次动态 import 的时间，只在开着时）；它失败记一行、照常启动、不导出。导出失败（网络、HTTP 状态）由包了一层的导出器记一行 warn，一分钟至多一行，只写错误名与码（如 `Error ECONNREFUSED`、`OTLPExporterError 400`），不写原文与端点地址；`flushOtel` 与停机时的 shutdown 不 reject（BatchSpanProcessor 导出失败时会 reject，已记过日志）。`exportTurn` 自己兜错，recorder 本来也兜订阅者的错。
  11. **停机**：`startOtel` 挂一个 drain 段钩子（normal 段已等完在途的轮次，这时每一轮都交给了导出器）：`provider.shutdown()` flush 并关掉导出器，没导出完的丢掉。审查之后改成钩子按拿到的 `deadline` 自己守预算、到点放弃并记一行，drain 段不再被拖满（「审查之后改的」第 7 条）。
- 自测（`src/ops/ops.selftest.ts`，约 5 秒；不带 PG 89 项、带 PG 91 项）：
  - 边界 lint：夹具目录里每条新规则拦的与放行的各一例（静态、动态、`import type`、自测、`src/otel/` 里外）。
  - 没设端点：子进程（`OPS_SELFTEST_CHILD=no-otel`，异步起，好让它连得上本进程的接收端做对照）注册 `module.registerHooks` 的解析钩子、包一层 `net.Socket.prototype.connect`，import `server.ts` 的整张静态 import 图、跑一次 `boot()`（`startOtel` 是真的 `startOtelExport`）、`LLM_MOCK` 下跑一轮：钩子没见过、`require.cache` 里也没有任何 `@opentelemetry/*`，一次连接都没有，`startOtel` 没被调；另设的 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 与 `OTEL_CAPTURE_CONTENT=1` 不打开导出、接收端什么都没收到；对照：动态加载导出器之后钩子与缓存都看得见，连一次接收端也数得到。
  - 运行数字（PGlite，`TZ=Asia/Shanghai`，「现在」取最近一个 UTC 17:30，上海已是次日 01:30）：四个会话 13 轮窗口内、两轮窗口外（起点前 1 分钟、起点前 6 小时即 UTC 那天之内）、另一个租户两轮与大额用量；`/metrics?days=7` 的七个字段与手算逐个相等（p90 = 6400，全算是 78000；转人工率 2/4，按轮次是 3/13；出错率 2/13，B 的 error 那轮只有 outcome 认得出、C 的只有 llm 认得出；今天 1.3 元，按 UTC 的今天是 2.0；窗口 3.8 元），`days` 缺省 7、30、1 各对一遍；59 秒内再读是缓存那份（新插的一轮不在里面）且除了认会话不查库（与 `/me` 的查询数相同），days=6 另算一份、再读也不查库，满 60 秒重算；文件存储 503 `store_file_mode`、viewer 在文件存储下照样 403；supervisor、agent、viewer 403 `forbidden`，匿名 401；`days` 为 0、91、-1、7.5、abc、空串 400，90 可以。带 `PG_TEST_URL`：同一份数据在真实 Postgres 上以 `agent_app` 经 RLS 读，四个数相同；没有轮次的租户三个比率 null、费用 0。
  - 配了端点（进程内的假 OTLP/HTTP 接收端，JSON）：`boot()` 没设端点、只有空白都不调 `startOtel`，设了在会话存储之后、监听之前调，它抛错只记一行、照常监听与起企微；之前本进程没加载任何 `@opentelemetry/*`。一轮两次模型调用、模型要的工具与价格护栏删一句：恰好一条 trace、一个根，子 span 数等于模型调用、工具调用、护栏事件之和且父亲都是根；根、`chat`、`execute_tool`、`guard` 的名字、kind、属性逐项对，起止时刻精确到纳秒等于轮次里记下的（`startedAt`、`ms`、`durationMs`、`at`），子 span 都在根的起止之内；`langfuse.session.id` = `langfuse.user.id` = `gen_ai.conversation.id` = 库里这个新会话的 ref（第一轮就是）；导出的原文里搜不到客户原话、最终回复、被删的那句、工具参数，也没有 `gen_ai.input.messages` 等四个键，没有 external_userid 与 `wecom:`；trace 行的 `calls`、`llm` 里没有 `startedAt`。`OTEL_CAPTURE_CONTENT=1` 的一轮：根上的 input / output messages 正是客户原话与回复，`execute_tool` 的参数正是执行时那份，仍没有工具结果与 external_userid。模型 503 的一轮：根 ERROR、`chat` 带 `error.type=http_5xx`、ERROR、没有用量。demo 类会话的引用是短码 `DEMO`（审查之后改成匿名引用，用例见「审查之后改的」）。补建 span 时出错（`__otelTest.breakNextBuild()`）：这一轮照常回复、记一行「这一轮没导出」、没有它的 trace，下一轮照常导出。端点挂掉（接收端直接断开连接）：这一轮照常回复，只记一行不带地址的 warn，没有未处理的 rejection。停机：一轮排在批处理里还没导出，`runShutdownHooks` 之后接收端收到了它。
- 变异（源码拷进 scratchpad 本线专用的隔离副本，逐个打、跑 `ops.selftest`，静态 import 两个另跑 `check-boundaries`）：51 个。运行数字 15 个：p90 不过滤 outcome、转人工率按轮次算、出错率漏掉 llm 里的 error、漏掉 `outcome='error'`、今天的费用取整个窗口、今天与窗口按 UTC、窗口改成滚动的 7×24 小时、缓存不生效、不过期、不按 days 分、费用不换算成元、文件存储不 503、viewer 能读、admin 读不到、days 上限放到 365；OpenTelemetry 32 个：`boot()` 不看端点（没配端点也加载）、`startOtel` 失败抛进启动、`src/ops/otel.ts` 静态 import 导出器、`server.ts` 静态 import `@opentelemetry/api`（这两个子进程用例与边界 lint 都拦下）、会话引用用会话原 id、一律用短码、默认写原文、工具参数默认也写、capture 时写了工具结果、会话原 id 进属性、子 span 不挂在根上、护栏挂在 chat 下面、根的结束时刻没用耗时、chat 的 kind、出错不标 ERROR、不带 `error.type`、Langfuse 属性只在根上、trace 名写错、`langfuse.user.id` 用了租户、`service.version` 不是 APP_REVISION、停机不 flush、flush 把导出失败抛出来、导出失败不记日志、日志带端点地址、`exportTurn` 不兜错、input / output token 对调、chat 的开始时刻没减耗时、trace 行带上开始时刻、客户原话没交给订阅者、引擎不交客户原话、新会话插入时没写内存里的 ref、`refOf` 一律 null；边界规则 4 个（三条各去掉一条、动态 import 的判定反了）。首轮存活两个，补断言后杀掉：漏掉 `outcome='error'`（原来 error 那轮的 llm 里也有出错的一项，两种口径都认得出；改成只有 outcome 认得出）、`exportTurn` 不兜错（recorder 本来就兜订阅者的错，对话照常，原来没有断言看得出；加了只给自测的 `__otelTest.breakNextBuild()`，断言这一轮照常回复、记一行「这一轮没导出」、没有它的 trace、下一轮照常导出）。另有一个首轮靠崩溃杀掉的（`src/ops/otel.ts` 静态 import 导出器时，子进程那一行输出太长、`process.exit` 截断了管道，父进程解析失败），改成按包去重、写完管道再退出之后由断言杀掉。终轮 51 个全部杀掉。
- 门禁：四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器，本线用 `127.0.0.1:55442`）与不带各跑一遍都全绿，mock eval 19/19（文件与 DB 两种配置模式）；锁定套件 8 个文件断言零修改，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变。收尾时合并了 dev（第 10 步已合进去：`package.json` 的 `test` 两边各加一个套件、`store.ts` 与 `pg-backend.ts` 两边各加一个入口、plan 三处，都按两边的意图保留；`ops.selftest` 里 `boot()` 的依赖补上第 10 步加的 `storeMode`、`startJobs`），合并之后四个门禁与带不带 PG 的 `pnpm test` 再跑一遍都全绿，PASS 行 64（第 10 步 63，加本步一个）；其余套件的数目与 dev 上相同（`store.selftest` 403 / 426、`trace.selftest` 176、等价套件 908、`jobs.selftest` 95 / 100、`db.selftest` 497 / 894）。
- 注意（第 13 步）：`canSeeMoney` 已在 `app.ts`，`/orders/summary` 直接用；会话类审计的 `target_id` 要的会话 ref 在内存里有（`store.conversationRef(id)`，新会话还没提交过也有）。
- 注意（第 17 步）：`ops.selftest.ts` 的结构是「子进程分支在最前（`OPS_SELFTEST_CHILD`）→ 边界 lint → 子进程用例 → PGlite 运行数字 → 进程内 OpenTelemetry → 停机」，最后一段调了 `runShutdownHooks`，日志与告警的用例加在它前面；日志的 `conv` 归第 17 步定（spec 给文件存储下日志的 `conv` 写的是短码；db 存储的真实会话可以用 `store.conversationRef(id)`）；导出没有 ref 的会话时用的是 `src/ops/otel.ts` 里的匿名引用（进程内的 HMAC，审查之后改的第 1 条），与日志的短码不是同一口径，日志与 Langfuse 之间对不上 demo 类会话；`[otel]` 的几行是 `console.log` / `console.warn`，`LOG_FORMAT=json` 时照样接到 pino。告警要不要加「导出持续失败」spec 没列，本步没加。
- 注意（第 21 步）：`MetricsView` 在 `src/shared/console-api.ts`；文件存储 503 `store_file_mode` 时不画四个格，403 时（坐席等）本来就不该请求；`replyP90Ms` 是毫秒，界面换成秒；`days` 是实际天数（按租户的 trace 保留期截过，审查之后改的第 6 条），「近 N 天」照它写。
- 审查之后改的（2026-10-03；审查报告 spec 6 条、sql 2 条、privacy 3 条、robust 3 条，判为成立的九条并成七处，按修复说明的编号，审查原文的标号写在括号里）：
  1. **没有 ref 的会话不再用短码**（spec[1]、privacy[0]）：文件存储与 demo 类会话原来用 `shortIdOf`（会话 id 去前缀后的末 4 位），末 4 位相同的客户在 Langfuse 里并成同一个会话、同一个用户（`sim-` 访客只有 65536 种）。改成 `anon-` 加 `HMAC-SHA256(密钥, 会话 id)` 的前 16 个十六进制字符：密钥在 `startOtelExport` 里随机生成（只在开了导出时，没设端点的进程什么都不多做），不含客户标识、不会撞、同一进程里同一会话每轮相同、不用 Map 存；重启之后会变（文件存储下本来也没有跨重启的会话引用）。`langfuse.session.id`、`langfuse.user.id`、`gen_ai.conversation.id` 都用它；db 存储的真实会话照旧用 `ref`。日志的 `conv` 不归本步，第 17 步定（见「注意（第 17 步）」）。
  2. **`gen_ai.provider.name` 不再写 `_OTHER`**（spec[2]）：`_OTHER` 只是 `error.type` 的兜底值；provider.name 的约定是「已知值适用时必须用，否则可以用自定义值」。现在 `LLM_PROVIDER` 写了就用它；没写时按 `LLM_BASE_URL` 的主机名推：`deepseek.com`（含子域）是已知值 `deepseek`，`bigmodel.cn` 与没设（默认端点是智谱的）是自定义值 `zhipu`（已知值表里没有智谱），其余是自定义值 `openai_compatible`（约定说这个属性标识的是遥测格式的流派，别的地址都是按 OpenAI 兼容协议调的），写进 `src/ops/otel.ts` 的注释。上面第 7 条的说法已改正。
  3. **每个 span 都带 `gen_ai.conversation.id`，出错的根 span 带 `error.type`**（spec[3]）：`gen_ai.conversation.id` 挪进每个 span 都带的那组（与 `langfuse.*` 一起；约定里推理 span 与 execute_tool 是「有就写」），chat、execute_tool、guard 都有了。`outcome='error'` 的根 span 写 `error.type`：有出错的模型调用就取第一个的类别，没有就是 `_OTHER`；状态照旧 ERROR。出错的 chat 照旧。
  4. **执行时抛错的工具调用不再导出成 0 毫秒、状态正常**（robust[2]、spec[3] 后半）：recorder 加 `noteToolError(args)`，记下真实耗时、执行时的参数与只在内存的 `failed` 标记（`TraceCall.failed`，写 trace 行时与 `startedAt` 一起去掉；`resultBytes` 照旧是 0；trace 行的形状不变，只是这类调用的 `ms` 从 0 变成真实耗时）。`src/engine.ts` 只加了一处：`runTool` 里 `executeTool` 返回的 promise 另挂一个 `catch(() => noteToolError(args))`，错误照旧交给调用方（llm.ts 转成给模型的错误 JSON，这一轮照常继续）；另加一个 import。导出时这类 span 的结束时刻用真实耗时、写 `error.type=_OTHER`（recorder 不记错误原文，没有类别）、设 ERROR。没接的一处：成单安全网（引擎兜底建单那段 `try`）的 `executeTool` 抛错时仍走 finish 的老路（0 毫秒、状态正常）：修复说明只许在 engine.ts 加一处（主线在改这个文件），等主线不再动这段时在它的 `catch` 里补一句 `noteToolError(netArgs)`。
  5. **核对依据改正**（spec[4]）：代码注释与上面第 7 条改为依据 `open-telemetry/semantic-conventions-genai` main 的 `e07f4eb`（2026-10-02 的提交，2026-10-03 核对）的 `docs/gen-ai/gen-ai-spans.md` 与 `gen-ai-agent-spans.md`；核心仓库 1.43.0 起 GenAI 部分只剩「Moved」，原来写的依据只对得上 JS 包里的属性常量、对不上要求级别。属性名在新仓库里都没变。进程内的根 span 是「Invoke agent internal span」，它的属性表里没有 `gen_ai.provider.name`，「约定里 invoke_agent 必填」的理由删掉；属性留着，注释写成「本项目自加，便于按厂商筛」。只改注释与 plan。
  6. **窗口按租户的 trace 保留期截断**（spec[5]、sql[1]）：原来只用常量 90 卡 `days`，保留期调短之后（`retention_trace_days` 是 7–3650 可改的，清理任务第 16 步上线）三个比率只覆盖保留期内的 trace，费用却算满 `days`（`usage_daily` 不归保留期清理），`days` 照样返回请求的值。现在 `readMetricsView` 先读这个租户的 `retention_trace_days`（`src/db/repo/metrics.ts` 新加 `readTraceRetentionDays`：tenants 不带 RLS、agent_app 可读，在只读事务里读），实际天数 = `min(请求的 days, 保留期)`，trace 的三项与两项费用都按它算，`MetricsView.days` 返回它（调用方据此写「近 N 天」）。缓存：保留期按租户缓存 60 秒，运行数字的键改成（租户、实际天数），请求 60 与 90 截到同一个保留期时共用一份。`MetricsQuery` 的上限仍是 spec 的 90，注释改掉「再往前库里本来就没有 trace」。
  7. **端点不通时停机不再拖满 drain 段**（privacy[1]、robust[0]）：原来端点挂住、拒连（导出器把 ECONNREFUSED 当可重试）或回 503 时一直重试到 `OTEL_EXPORTER_OTLP_TIMEOUT`（默认 10 秒），drain 段每次被拖满 1.5 秒、`runShutdownHooks` 返回 false，日志只有「drain 段超时」，gracefulExit 还会打出「停机等待超时，强制退出」。现在 drain 段钩子是 `({ deadline }) => shutdownOtel(deadline)`：`provider.shutdown()` 与计时器赛跑，预算 `min(deadline − 现在 − 100 毫秒, 1000 毫秒)`（留 100 毫秒给同一段的写队列与用量钩子），到点就放弃、记一行 `[otel] 停机时导出未完成，已放弃 N 条`（N 是交给导出器还没有结果的 span 数，包了一层的导出器记着；不带端点地址，不节流），钩子按时返回。
  - 判为不成立、没改的四条：改 spec 契约只进实施记录不进 Open（spec[0]：`exportTurn` 收 `FinishedTurn` 是第 9 步定的订阅方式，其余是只加不改的内部参数）、`days=90` 在大数据量下慢（sql[0]：上限 90 是 spec 写的，审查用的数据量是 spec 压测规模的两倍以上）、`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 会改目的地（privacy[2]：第 9 条的取舍，导出器配置全走标准环境变量）、`OTEL_BSP_*` 与端点地址配错（robust[1]：给没文档化的标准变量填无意义的值，同一个 SDK 的通病）。
  - 自测（都在 `ops.selftest.ts`）：`providerName` 九种组合（`LLM_PROVIDER` 优先、deepseek 主域与子域、`deepseek.com.example.net` 不算、bigmodel、没设、本机地址、不是地址）；第一轮的根 span 没有 `error.type`、不是 ERROR，根与全部子 span 的 `gen_ai.conversation.id`、`langfuse.session.id`、`langfuse.user.id` 都是 ref；模型 503 的那轮根 `error.type=http_5xx`，同一轮改成模型调用都没出错、经 `exportTurn` 再导一次，根 `error.type=_OTHER`、ERROR。工具失败：recorder 直接造一轮，工具挂 40 毫秒后 `noteToolError`，`ms ≥ 40`、`failed`、没有结果，导出的 span 起止等于记下的时刻、`error.type=_OTHER`、ERROR；真引擎上模型要报一条不存在的线路（`create_quote` 抛错），这一轮照常回复，recorder 记了失败，`execute_tool create_quote` 带 `error.type=_OTHER`、ERROR，别的工具 span 正常，trace 行的 `calls` 里没有 `failed` 与 `startedAt`、`ms` 等于记下的。匿名引用：两个末 4 位相同的 demo 类会话（短码都是 `QZ7K`）导出的引用不同，同一会话两轮相同，格式是 `anon-<16 位十六进制>`，这一轮每个 span 的三个会话属性都是它，原 id 的每个 4 字符片段都不在引用里，导出里没有短码、`cust_`、`wecom:`。保留期（PGlite）：保留期 30、请求 90 → `days=30`，轮次 16、费用 12.8 元（40 天前的一轮与一笔 4 元用量不算；不截是 17 轮、16.8 元），再请求 60 用的是同一份（除了认会话不查库），请求 7 照旧 7；真实 PG 上 agent_app 在只读事务里读得到保留期（默认 90，改成 30 之后是 30）。停机：端点挂住、拒连、回 503 三种，导出器超时设回 10 秒，各起一个新的 provider、排一轮的 span，`runShutdownHooks(8000)` 返回 true、1.5 秒内结束，日志里正好有「[otel] 停机时导出未完成，已放弃 N 条」（N 是这一轮的 span 数），没有「drain 段超时」与端点地址。
  - 变异（源码拷进 scratchpad 本线专用的隔离副本，逐个打、只跑 `ops.selftest`）：19 个，全部杀掉。第 1 条：没有 ref 时仍用短码、每轮换一个密钥（同一会话两轮不同）、引用里带会话 id 的末段；第 2 条：其余地址写 `_OTHER`、不按主机名认 deepseek；第 3 条：子 span 不带 `gen_ai.conversation.id`（只在根上）、根 span 出错不写 `error.type`、根的 `error.type` 一律 `_OTHER`；第 4 条：引擎不在失败分支记、`noteToolError` 不记失败标记、不记耗时、导出不给失败的工具设 ERROR、失败标记进了 trace 行；第 6 条：窗口不截断、缓存键用请求的 days、保留期不缓存（每次请求都查库）；第 7 条：停机不看 deadline（等 shutdown 自己结束，三种端点都是 1.5 秒、返回 false、只有「drain 段超时」）、放弃时不记那一行、钩子不传 deadline（按 8 秒总上限算）。第 5 条只改注释，没有可打的变异。改好之后三种端点下 `runShutdownHooks(8000)` 都是约 1001 毫秒返回 true（隔离副本里探针量的）。
  - 计数：`ops.selftest` 89 / 91 → 111 / 114（不带 / 带 PG），其余套件不变；四个门禁全绿；`pnpm test` 带 `PG_TEST_URL`（本机 `pgvector/pgvector:pg17` 一次性容器 `pgtest-02s18fix`，`127.0.0.1:55442`）与不带各跑一遍都全绿，PASS 行 64，mock eval 19/19（文件与 DB 两种配置模式）；其余套件的数目与改之前相同（`store.selftest` 403 / 426、等价套件 908、`trace.selftest` 176、`jobs.selftest` 95 / 100、`db.selftest` 497 / 894）；锁定套件 8 个文件的 sha256 与基准相同、断言零修改，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变。开工时合并 `origin/dev` 没有新提交（已是最新）。

### 第 20.1 步 · popupRegion 的键盘（2026-10-03）

- 另开一条线做（与主线的第 11–13 步并行），只改 console 前端：`console/src/parts/popupRegion.tsx`、`shell/UserMenu.tsx`、`catalog/CatalogDetail.tsx`，新套件 `console/src/parts/popupRegion.selftest.tsx` 串进 `test`（登录页自测之后）。修法、取舍、自测覆盖、变异与 Chromium 实测都记在后台 UX plan「实施记录 · popupRegion 的键盘」，这里只记要点。
- 修法：`PopupRegion` 经 ref 接住 rc-dropdown 打开时与按 Tab 时调的 `focus()`，转给菜单项（勾着的那一项，没有就第一项），本身仍不可聚焦；上一下输入是指针时不转，鼠标点开的样子同改之前；Esc、Tab 把焦点还给开着菜单的菜单按钮（`aria-haspopup="menu"` 且 `aria-expanded="true"`），子菜单里的 Esc 只关子菜单。下拉选择与联想的弹层（也经它包）点四周的内边距不再让输入框失焦（origin/dev 上会）。用户菜单、条目详情的「更多」加 `autoFocus` 与 `destroyOnHidden`；用户菜单的 Enter 拦默认动作、「关于」之前焦点先回用户按钮。
- 自测：新套件 91 条；happy-dom 里先按浏览器的规矩补上焦点（不可聚焦的元素 `focus()` 无效）、默认动作与布局，原来的 bug 在没补的 happy-dom 里看不出来。现有 console 套件断言零修改、条数不变（shell 143、登录页 125、sop 811、fields 1,725）。变异 21 例（隔离副本，只跑本套件）都失败并点名。
- 浏览器：Chromium 151（Playwright 1.62）对仓库外的本机后台（PGlite + `server.ts` 的 app 托管 `console/dist`），浅色、深色各一轮，48/48；同样的操作对 origin/dev 的构建复现原来的 bug。
- 门禁：四个门禁全绿；`pnpm test` 不带 `PG_TEST_URL` 跑一遍（本步不碰服务端），新套件 91 条，其余 console 套件条数同 dev，mock eval 19/19（文件与 DB 两种配置模式）；`src/` 零改动，锁定套件 8 个文件与 README 零改动，`PREFIX sha256 system=6c202d63… tools=64c16fc8…` 不变。首屏 JS 326,483 / 420,000 B（同一时刻的 dev 是 325,954），换页最多 169,685 / 250,000 B（dev 169,683）。收尾时取了一次 `origin/dev`，没有新提交，合并是空操作。
- 带出的四条记进后台 UX plan「Open」（都不挡 02）：话术页编辑器光标停在软换行处、第一次自动保存以后会把焦点从页头拉回编辑器（CodeMirror 的 `enforceCursorAssoc`，origin/dev 上同样）；菜单项的焦点框偏移是 antd 的 1，设计系统 §3 写 −2；「丢弃草稿」不能点时键盘到不了它、读屏听不到原因；话术目录的下拉没经 `popupRegion`，点内边距输入框失焦。
- 注意（第 20.2 步）：J 页对话头的「更多」照这三个入口写：菜单按钮带 `aria-haspopup="menu"` 与 `aria-expanded`（「打开它的按钮」靠这两个找），Dropdown 带 `autoFocus`、`destroyOnHidden`、`popupRender={popupRegion(…)}`，菜单项的 `onClick` 在 keydown 时拦下默认动作（打开弹窗的那一下 Enter 不落到弹窗里的按钮上）；自测照 `popupRegion.selftest.tsx` 的做法（先补焦点规矩，Enter 打开、焦点在菜单项上、Esc 回按钮）。

## 验收记录

（对照验收标准逐条验证时填写：编号 · 通过 / 未通过 · 证据）

## Open

（与 spec 的分歧、需要 owner 裁决的事；开放问题的答复也记在这里）

- 2026-10-03 owner 确认下面标「已定」的八处照现在的做法（第 1 步带出的三处照各自的推荐），连同实施记录里比 spec 原文更严的几处（旧接口只认 `ADMIN_PASS`；第 6 步 import、export 的写序、目录 fsync、`--keep` 先验可写），已就地补进 spec（顶部 2026-10-03 的 `Revisions:`）。第 1 步的第一处在第 13 步写交还消息时落地，第三处在第 15 步落地，其余已实现。

- 开放问题的答复（owner 2026-10-02，已写进 spec 各条与顶部 `Revisions:`）：1 选 A「部分取代」，规则进了 `docs/spec-driven-dev.md` 与 AGENTS.md，01 与 UX spec 顶部已加 `Superseded in part by:`；2 线索 180、客户 730、trace 90 天，按租户可改；3 企微群机器人，与告警不同群；4 词表加规则；5 `channel_inbox` 留在 04、做三条缓解；6 选 A；7 照推荐做，PIA 出结论后复核；8 保守口径；9 02 不做改价；10 固定的回归步骤，不做发布闸；11 仓库外事项全部完成才接第一个真实租户；12 选 A；13 以后在另一台境内机器上自建 Langfuse，02 只埋点；14 国内云厂商的拨测。
- 第 1 步盘点带出、要 owner 定的三处（都不挡第 2 步）：
  - 已定 · **交还消息里的顾问姓名会经匿名旧接口漏出**（第 3 步写投影之前定；第 3 步没等到答复，投影函数按消息逐条写好，改写规则随第 13 步的交还消息一起加）。spec「接手、人工回复与交还」规定交还时记一条 system 消息「{姓名}把会话交还 AI」；种子会话既能被成员接手、又对匿名可读，「后台接口」规定的匿名投影只去掉 `assignee.userId` 与消息的 `authorId`、`authorName`，管不到正文，`admin.html:939` 会原样显示它，与不变量 44（匿名响应里没有成员姓名）冲突。推荐：匿名投影把 `release()` 按固定模板生成的这条改写成「顾问把会话交还 AI」（模板由同一个常量产生，确定性可测）。备选：正文本身就写「顾问把会话交还 AI」，姓名只在 J 页由结构化记录显示（spec 的那句文案要改）。
  - 已定 · **`POST /api/orders/:id/pay` 的响应体**（第 3 步；已按推荐先做，见「实施记录 · 第 3 步」裁定 10，owner 另有决定再改）。409 与 200 两个分支（`server.ts:462`、`483`）都带订单原对象，demo 下匿名可调；02 之后会带出 `confirmedBy`、`paidMarkedBy`、`cancelReason`。R22 只管 `GET /api/orders/:id`。推荐：改用同一个 R22 白名单投影（`pay.html` 只看状态码与 `res.ok`，锁定断言不读响应体）。
  - 已定 · **advisor 模式下支付页从哪儿知道收款方式**（第 15 步之前定）。R22 白名单里没有收款方式，`confirmed=false` 分不清「online 待付款」与「advisor 待确认」；`/pay/:orderId` 能由服务端注入，`/pay.html?orderId=` 这条静态兜底（`pay.html:314`，`server.ts:698`）注入不到。推荐：`/pay.html?orderId=` 跳到 `/pay/:id`，页面只靠服务端注入。备选：白名单加 `paymentMode`（改 R22；锁定断言只看 `id`，不受影响）。
- 第 8 步带出的（都已按下面做了，owner 不同意可以改回）：
  - **spec「测试与 CI」最后一条的清单漏了几处随本步写定的行为跟着变的非锁定断言**：`console.selftest.ts`「公开的方案书接口拿到新 highlights」（「不带 v 按版本 1」之后，不带 v 的是改之前的那份）；`packs.selftest.ts` 两条改坏用例改坏的组从酒店的 `price` 换成 `id`（`price` 组随 nightlyFrom 开放去掉了）；`console/src/fields/fields.selftest.tsx` 照设计系统 E、F 页写的锁定组断言（「13项上架后锁定」、计价与条款两组）改用自测里派生的「E、F 页版」旅游包核对（与假包 L 页版同一个做法，断言本身一条没改），活的旅游包另加断言。做法与理由见「实施记录 · 第 8 步」的「改了的非锁定断言」。请把这几处补进 spec 那份清单。
  - **设计系统 E、F 页与后台 UX spec 的示例数字是 02 之前的旅游包**：02 之后的旅游包线路是 9 项上架后锁定（识别 5、推荐 4），酒店 3 项，没有计价、条款两组；页面的写法与规则不变。UX spec 已 implemented，示例要不要改、怎么改（修订路径见 AGENTS.md）由 owner 定，本步没动这两份文档。
  - 已在本步处理 · **审计时间线不再合并连着改的几条**：`auditRuns` 把同一事务里接着记的 `catalog.version` 并进那次写入，每次保存仍是一句、连着改几条仍合成「修改了N条」，单条句尾写「（第N版）」，系统补写单独成句；审计行照写（「实施记录 · 第 8 步」审查之后改的第 5 条）。
- 第 8 步审查带出的（2026-10-03）：
  - **回滚检查的新判定**（已按下面做了，owner 不同意可以改回）：spec「回滚到 02 之前的镜像」只写了正在运行的实例 `/healthz` 的 `config.catalogVersioned` 为 true 时拒绝；第 8 步原来把取不到、没有这个字段也算有风险，结果首次上 02 失败后的自动回滚（新容器没过健康检查，`/healthz` 必然取不到，`:prev` 是 01）一律被拒、服务一直停着，跑着 01 时部署 01 的 tag 也被拒。现在取不到或没有这个字段时直接问库（`catalog_item_versions` 有没有版本大于 1 的行，表不存在算 02 之前的库），库也问不到时正在跑的容器是 02 之前的镜像就放行，否则拒绝；有条目版本这条风险时退出码 4、只说回到 02 之后的镜像，会话与条目版本两条都在时也不再打印回到文件存储的步骤（spec 写的「并打印上面的步骤」对这一条帮不上忙）。做法见「实施记录 · 第 8 步」审查之后改的第 2 条。请 owner 确认，并把 spec 那一句补成「……或正在运行的实例 `/healthz` 的 `config.catalogVersioned` 为 true（取不到时直接问库；库也问不到、而正在跑的不是 02 之前的镜像时同样拒绝）时拒绝；只有会话那一类风险时打印上面的步骤」。
  - **改价之后复述旧价会被价格护栏当成编价**（本步不改代码）：spec「报价快照」写「价格护栏不改：会话里报过的价仍有出处（`quoteHistory`）」，实际 `allowedAmounts`（`src/price-guard.ts`）只认产品库现价推出来的价、`lastQuote`、订单与客户说过的数，`quoteHistory` 只进 `routesInPlay` 与差额。01 锁着计价字段时报过的价总能从现价推出来，碰不到；本步开放之后会碰到：「之前方案书上是每人 28,800 元，这条线调价了，现在每人 29,800 元」整句被删、换成兜底报价行，客户问的「价格怎么变了」没人答。酒店的 `nightlyFrom` 一样。推荐：后续步骤里把 `quoteHistory` 每条的 `perPerson`、`total` 加进 `allowedAmounts` 的有出处金额（与 `lastQuote` 同等），`price-guard.selftest` 照旧全过。备选：改 spec 那句、接受删句。
  - **改过价之后回到文件配置模式**（本步不改代码）：同一个 02 镜像去掉 `CONFIG_SOURCE=db`（01 spec「导入、导出与回滚」第 3 种回滚），文件模式下每条线都是版本 1：`?v=2` 及以上的已发链接全部 404，不带 v 的旧链接按导出时的新内容显示，违反「已发出的链接要能打开」与不变量 37；回滚检查只管回到 02 之前的镜像，这种情况没人提示。推荐：启动时（文件模式而库里有版本大于 1 的条目）与 deploy 时给出告警；README 的警示等发版时一起写（已加进第 28 步「发版与 README」的要点）。
- 第 6 步审查带出的另一处（已按下面做了，owner 不同意可以改回）：已定 · **`export-sessions` 多了退出码 2**。spec「导入、导出与切换」的 export 只写了成功（0），命令行约定也只有 0、1、3；但没有标记文件、而 JSON 里的真实会话与库里不一致时（多半是回退到文件存储之后又误跑了一次 export），照「同 id 以库为准」会用库里的旧版本悄悄盖掉文件存储期间的新消息与付款状态。现在以 2 拒绝、什么都不动，提示改用 `import-sessions --resync`；全部一致就当无操作返回 0。spec 那一节要同步一句。
- 第 6 步审查带出的一处（已按下面做了，owner 不同意可以改回）：已定 · **没经过 import-sessions、直接以 db 存储起的实例也要有标记文件**。spec「导入、导出与切换」写的是标记文件「import 改写 JSON 时一起写，export 写完 JSON 后删掉」，回滚检查只看标记文件（与第 8 步的 `catalogVersioned`）。新实例、新租户一上来就设 `SESSION_STORE=db`（JSON 里本来没有真实会话），会话全在库里而 var/ 里没有标记：去掉 `SESSION_STORE` 之后文件存储照常启动、客户历史在应用里看不到（不变量 15 对这类实例失效）；deploy.sh 部署 01 的 tag 或自动回滚到 01 的 `:prev` 也放行（回滚检查失效）；之后再 `--resync` 还会把这些会话在库里、文件里没有的订单作废。现在：`initSessionStore` 的 db 分支装上 PG 后端之后，没有标记就补写一份（`sessions` 是预载的真实会话数）；`rollback-guard.sh` 另读服务器 `.env`，`SESSION_STORE=db` 也算有风险（做法与验证见「实施记录 · 第 6 步」的「审查之后改的」第 5 条）。请 owner 确认，并把 spec「标记文件」那句补成「import 改写 JSON 时写、db 存储启动时没有就补写，export 写完 JSON 后删掉」，回滚检查的条件加上「服务器 `.env` 里是 `SESSION_STORE=db`」。
- 第 5 步审查带出的一处（已按下面做了，owner 不同意可以改）：已定 · **两种启动失败借用了现有的 reason**。spill 回放时读写文件出错（`EISDIR`、`EACCES`、改名失败）与其余意外错误用 `spill_conflict`（spec 写的是「spill 文件接不上库里的 last_seq」），重复调 `initSessionStore` 用 `sessions_in_db`（spec 写的是「文件存储而 var/ 里有标记文件」）；两处 detail 都写明实情（文件名与错误码、「只能调一次」）。要分开的话给 spec 的 `SessionStoreStartupError` 加两个 reason（比如 `spill_unreadable`、`already_installed`），代码两处各改一行。
- 第 4 步审查带出的两处（都已按下面做了，owner 不同意可以改回）：
  - 已定 · **清除与删除连带删会话的任务（按验收 27 扩了删除范围）**。spec 写的是「删除范围与清除函数相同」，不变量 42 的表清单里也没有 `jobs`；但跟进的 `dedupe_key` 是 `followup:<会话>:<阶段>`，会话 id 就是 `wecom:<external_userid>`，验收 27 要求删除之后「库里搜不到它的 external_userid」，结束的任务还要再留 30 天，不删就过不了这条。现在的做法：约定与会话有关的任务 `payload` 必带 `sessionId`，`purge_conversation`、`erase_conversation` 一并删 `payload->>'sessionId' = p_id` 的任务（任何状态），`erase_conversation` 的返回值与审计多一项 `jobs`。owner 要改回原文的范围，就把这两条 DELETE 去掉、把验收 27 的「库里」收窄成不变量 42 的那几张表；或者改成不删、把任务的 `dedupe_key` 与 `payload` 改用不含会话 id 的引用。请 owner 把定下的写法补进 spec「数据库 · 清除与删除函数」与不变量 42。
  - 已定 · **`orders` 触发器多管了 `session_id`**。spec「数据库 · 触发器」只写了 `paid_at` 写一次；`agent_app` 对 `orders` 是整表 UPDATE，把已付订单的 `session_id` 置空或改挂，会话就按线索的保留期被提前清除，与 R20、不变量 6 矛盾。现在 `session_id` 非空之后只有 `agent_owner`（清除与删除函数、外键动作）能改，理由与验证见「实施记录 · 第 4 步」的「审查之后改的」第 1 条。请 owner 把这一句补进 spec 的触发器那一段。

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

- 已完成：第 5 步。`src/store/project.ts`（投影与 `normalizeForStore`，`isDemoClassId`、标记文件名搬来）、`src/store/pg-backend.ts`（预载与校验、每会话写队列与合并、一次落库七步、进快照即冻结、失败两类与 poisoned、冲突即优雅停机、drain、spill 与回放）、`initSessionStore` 的 db 分支、`deleteOrdersOfSession` 作废、重置调 `noteWindowReset`、`chat()` 的 `withTenant` 断言、附带行的入口；`src/db/testing.ts` 的 `installPgSessionStore`（返回依赖与故障注入）、`openFlakyDb`、`createRealPgFixture`、落盘的 PGlite；`store.selftest.ts` 不带 PG 294 项、带 PG 304 项。审查之后改了九处（孤儿订单在 JSON 与 PG 之间的交接、同一段同步代码的改动合进一个事务、spill 不投影订单、回放的错误类型与 `.failed` 提示、新会话 COMMIT 晚到、`held_by_other` 之后不写库、`real_in_json` 提前到本步、db 存储下跟进先等落库）并补了七组自测，见「实施记录 · 第 5 步」的「审查之后改的」；审查报的存活变异与这次改动的代表性变异全部杀掉。本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。
- 半成品：无。
- 阻塞：无。「Open」里第 1、4 步带出的五处照旧，第 5 步审查带出一处（两种启动失败借用了现有的 reason），都不挡第 6 步。
- 下一步：第 6 步「导入导出与切换」。先读「实施记录 · 第 5 步」的「注意（第 6 步）」：`real_in_json` 已在本步做了（别再加一份），`insertConversation` 冲突返回 null，命令行只用 `project.ts` 与 `src/db/repo/**`，读回比对走预载同一条路，`--resync` 别把作废订单当活订单 upsert。

### 交接（2026-10-02，第 6 步）

- 已完成：第 6 步，含审查之后的修复。`import-sessions`（首次导入按库的 id 排序每 500 个一批写、每批按预载的同一页读回比对，补完改写，内容不同 2，`--dry-run`，`--resync`）与 `export-sessions`（只读快照、合并进 JSON、同 id 以库为准、删标记），逻辑在 `src/cli/session-transfer.ts`；预载与命令行共用 `readSessionBatch` + `rebuildSessions`；`deploy/rollback-guard.sh` 与 `deploy.sh` 两处接线（部署 02 之前的 tag、自动回滚到 02 之前的 `:prev`）。审查之后改了五处（import 先写标记再改写 JSON、export 先 orders.json 后 sessions.json 再删标记、改名之后 fsync 目录；没有标记时 export 先与库里比对，JSON 比库新以 2 拒绝；`--keep` 在开事务之前建好并试写；回滚检查打印的命令带端口与租户、自动回滚被拒另一套步骤；db 存储启动时补写标记、回滚检查也看 `.env` 的 `SESSION_STORE=db`），见「实施记录 · 第 6 步」的「审查之后改的」。`store.selftest.ts` 不带 PG 402 项、带 PG 425 项，`db.selftest.ts` 480 / 876 项。首轮 39 个变异与审查修复的 25 个全部杀掉；本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。
- 半成品：无。
- 阻塞：无。第 6 步审查带出「Open」一条（不经 import 的 db 存储实例补写标记、回滚检查看 `.env`，已按推荐做了，等 owner 确认并补进 spec）；另外 export 多了退出码 2，spec「export-sessions」那段要同步一句。第 1、4、5 步带出的六处照旧，都不挡第 7 步。
- 下一步：第 7 步「等价套件与 DB 模式 mock eval」。先读「实施记录 · 第 5 步」的「注意（第 7 步）」与本步的「注意（第 7 步）」。

### 交接（2026-10-03，第 7 步）

- 已完成：第 7 步。`src/store/parity.selftest.ts`（8 组场景、18 个 `wecom:parity-*` 会话，文件存储与 PG 存储各起一个子进程跑同一份脚本，逐项比较回复、发出的消息、会话投影与订单，PG 那边按预载那条路核对库里与内存一致；另有场景期望、比较器对每个字段敏感、收集字段覆盖、逐个会话的库里核对在且通过、逐轮的模型脚本恰好用完几类自检，两个子进程共用父进程定的钟，共 743 项）；`eval/run.ts` 的 DB 模式装上 PG 会话存储、改用 `eval:` 会话、跑完核对库里；`src/db/testing.ts` 加 `readStoredConversations`。没有找到第 1 步那六处之外的原地修改与数组错位，产品代码没改；隔离副本里另用探针把现有自测跑在 PG 存储上，碰到的三处都在测试代码、夹具或探针本身。21 个变异全部杀掉。审查之后改了五处（模型入口的转人工会话原话带出行时间、第 1 步第 4 处写入点在 PG 上真正兜住；库里核对逐个会话要求在且通过；逐轮断言模型脚本用完；固定时钟；plan 补记），只改测试与文档，见「实施记录 · 第 7 步」的「审查之后改的」，对应变异都按预期红或绿。本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。
- 半成品：无。
- 阻塞：无。「Open」里第 1、4、5、6 步带出的几处照旧，本步没有新增，都不挡第 8 步。
- 下一步：第 8 步「产品库版本、按轮固定快照、开放五个字段」。先读 spec「报价快照与产品库字段开放」、R14、不变量 35–37、验收 19，「实施记录 · 第 4 步」仓储清单里的 `catalog-versions.ts`，与「实施记录 · 第 6 步」的「注意（第 8 步）」（`rollback-guard.sh` 的 `catalogVersioned`）。改了引擎读产品库的路径之后，等价套件与 DB 模式 eval 照跑；第 9、10、12、13 步要在等价套件里补的项见「实施记录 · 第 7 步」的「注意」。

### 交接（2026-10-03，第 8 步）

- 已完成：第 8 步。条目版本的写入（上架、后台改、catalog-fix、import-config 首次导入）与 `catalog.version` 审计、全部版本读进内存、启动补写（含对齐 `catalog_items.version`）、`/healthz` 的 `config.catalogVersioned`；`pinCatalogForTurn`，引擎一轮与跟进生成包进去；`generate_proposal` 在版本大于 1 时带 `?v=`，白名单、企微卡片、网页模拟器与后台旧页认它，`/proposal/*`、`/api/proposal/:routeId` 按版本渲染、只读内存、不合法或不存在的版本 404 不查库，订单记 `catalogVersion`；以上全绿之后开放五个计价与条款字段，旅游包的锁定组去掉计价、条款，保存条在改了它们时写明「改价只影响之后的报价和方案书，已发出的方案书和订单不变」；`rollback-guard.sh` 看 `catalogVersioned`。改了的非锁定断言（spec 允许的与清单之外的几处）逐条记在「实施记录 · 第 8 步」。本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。同日审查之后改了七处：`?v=` 的 `?` 不当句末、出口补后缀的兜底；回滚检查取不到 `/healthz` 时先问库、退出码按风险分 3 与 4；同一线路先失败再成功只认成功那次的后缀；启动补写不改 `catalog_items`、当前版本取大；审计时间线把版本行并进那次写入；保存条按经 `/pack` 下发的 `reprices`；旧后台的卡片按链接上的版本。补了五组自测（方案页转 v、护栏看开始那一代、补写补酒店、固定包在 serialize 里、两个页面的链接正则）。README 的改动撤回，要点进第 28 步。见「实施记录 · 第 8 步」的「审查之后改的」。
- 半成品：无。
- 阻塞：无。「Open」第 8 步带出的：spec 测试清单补几处断言、设计系统 E、F 页的示例数字（等 owner），审计时间线那条已在本步处理；审查带出的三条（回滚检查的新判定请确认、改价之后复述旧价被当成编价、改过价之后回到文件模式），都不挡第 9 步；第 1、4、5、6 步带出的几处照旧。
- 下一步：第 9 步「逐轮 trace、护栏事件、用量」。先读「实施记录 · 第 8 步」的「注意（第 9 步）」：trace 的 `catalogVersions` 用 `catalogVersionKey` 与轮内（已固定的）`currentCatalog().versions`；以及「实施记录 · 第 7 步」的「注意」里第 9 步要在等价套件里补的项。

### 交接（2026-10-03，第 9 步）

- 已完成：第 9 步。`src/trace/recorder.ts`（轮次上下文、`startTurn` / `noteGuard` / `endTurn`、工具与模型调用的订阅、条目版本、`onTurnEnd`）、`src/trace/usage-daily.ts`（usage_daily 的累加器，30 秒与 drain 段写）；`recordUsage` 的 `purpose` 与 `onUsage`、`completeText` 的 `opts`、`llm.ts` 的 `onLlmCall` 与失败类别；引擎接线（`withTurnScope`、每个出口经 `done` 结束这一轮、出口 23 处 `noteGuard`）；turn_id 经 WeakMap 落库与预载认回；PG 后端的 `writeUsage`；`src/db/repo/traces.ts` 的四个读法；`check-boundaries` 一条新规则；新套件 `src/trace/trace.selftest.ts`（176 项）与等价套件的 trace 比较和库里核对（906 项）。spec 名单之外记下的三处改写点、outcome 的口径、`endTurn` 多一个可选参数等取舍见「实施记录 · 第 9 步」。66 个变异杀掉 64 个，存活的两个等价。同日审查之后改了五处：J 页的改写句数与对照读相对模型原稿的净差（`netGuardDiff`，逐事件的不能直接相加）、企微非文本消息也记一轮（`deterministic` / `silent`，提示消息关联 turn_id）、poisoned 会话的遥测丢掉并计数、预载认回 turn_id 先按会话分组、usage_daily 写失败带原因码（`UsageWriteError`），对应自测与 17 个代表性变异全部杀掉，见「实施记录 · 第 9 步」的「审查之后改的」。本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。README 没动，要点记进第 28 步。
- 半成品：无。
- 阻塞：无。本步没有新的「Open」；第 1、4、5、6、8 步带出的几处照旧，都不挡第 10 步。
- 下一步：第 10 步「任务表与跟进」。先读「实施记录 · 第 8 步」的「注意（第 10 步）」（任务表驱动的跟进生成与出口护栏包在同一个 `pinCatalogForTurn` 里）、「实施记录 · 第 9 步」的「注意（第 10 步）」（跟进不在轮次里，`noteGuard` 什么都不做；照旧传 `purpose: 'followup'`），以及「实施记录 · 第 7 步」的「注意」里第 10 步要在等价套件里换的「跟进」那组。

### 交接（2026-10-03，第 10 步）

- 已完成：第 10 步。`src/jobs/runner.ts`（认领、执行、按 `max_attempts` 重试、启动归位、停机 normal 段把还没进 sending 的跟进改回 pending）与 `startJobs(push)`（db 存储下代替扫描器，boot 的启动顺序）；`src/jobs/followup.ts`（落库时排、客户回话即取消、夜间顺延；到点重判 → 生成并过护栏 → 额度桩 → 记账与 sending 一起提交 → 推送 → done / 退账 failed 并按扫描间隔重排 / 结果不明 abandoned）；`guardOutbound`（engine.ts）、`shouldFollowUp(s, now)` 等共用的资格与话术（followup.ts，扫描器也改调它们，db 存储下扫描器不动）；拒绝识别（`src/jobs/optout.ts`，两种存储都做）；`handoff_notify` 与 `retention_purge` 只排程、执行体记一行标 done；新套件 `jobs.selftest.ts`（含落盘 PGlite 上 sending 前后的 SIGKILL 与真实 PG 上的两个认领者）；等价套件「跟进」组 PG 一边换成任务表、`trace.selftest` 的跟进改走任务表。取舍见「实施记录 · 第 10 步」。同日审查之后改了九处：拒绝识别按整条消息判（拒绝之外只能是客气话或应答）并先归一（表情、繁体、叠说、破折号，`LEAD` 补「以后、请、麻烦、拜托」）；重试用完记 failed 与额度不够都不再同键重排，额度判断挪到生成话术之前；认领者的状态变化带认领令牌（`claimed_at`），running → sending 经 `jobOpApplied` 确认改中了才推送，租户锁不在手里不认领、不执行；settle 写失败进待补队列、下一拍补写；跟进话术不先抹网址，`guardOutbound` 删「顾问会联系您」类句子；重置取消待执行的 `handoff_notify`。企微推送的「结果不明」与一批串行挡住「立即」通知两条只写进第 12、14 步的注意。见「实施记录 · 第 10 步」的「审查之后改的」。`jobs.selftest` 95 / 100 项（不带 / 带 PG）。本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。README 没动，要点记进第 28 步。
- 半成品：无。
- 阻塞：无。本步没有新的「Open」；第 1、4、5、6、8 步带出的几处照旧，都不挡第 11 步。
- 下一步：第 11 步「确定性转人工：紧急情况与交互失败」。先读 spec「确定性转人工触发」、「实施记录 · 第 1 步」第 8 类（锁定原话逐句的期望与「注意（第 11 步）」）、「实施记录 · 第 9 步」的「注意（第 11 步）」（`turn_traces.signals`）。emergency 升级经 `enterHandoff` 时照样排 `handoff_notify`（只排立即的那一个，见「实施记录 · 第 10 步」第 7 条）；拒绝识别在 `src/jobs/optout.ts`，与第 11 步的触发规则互不相干，但同一句客户原话两边都会判。

### 交接（2026-10-03，第 18 步）

- 已完成：第 18 步（先于第 17 步，另开一条线；分支 `feat/02-step18-metrics-otel`）。运行数字：`readMetrics` 的口径核过不用改，`src/ops/metrics.ts`（自然日窗口按服务器时区、60 秒缓存、换算），`GET /api/console/metrics`（owner、admin，其余 403，`days` 1–90，文件存储 503 `store_file_mode`），`MetricsView` / `MetricsQuery` 进 `src/shared/console-api.ts`。OpenTelemetry：`src/otel/export.ts` 与 `src/ops/otel.ts`，`boot()` 只在设了端点时调，四个 `@opentelemetry/*` 钉精确版本；recorder 给工具与模型调用补了只在内存的开始时刻、`startTurn` 收客户原话；PG 后端在内存里带会话 ref（`store.conversationRef`）；`check-boundaries` 三条新规则；`OTEL_*` 进 `.env.example`。新套件 `src/ops/ops.selftest.ts` 串进 `test`。51 个变异终轮全部杀掉；本机真实 PG 上全过；锁定套件零修改，`PREFIX sha256` 与第 1 步相同。收尾合并了 dev（含第 10 步），合并之后门禁再跑一遍全绿。同日审查之后改了七处（没有 ref 的会话用 `anon-` 加按会话 id 算的 HMAC、`gen_ai.provider.name` 按 `LLM_PROVIDER` 与主机名取值不写 `_OTHER`、每个 span 带 `gen_ai.conversation.id`、出错的根带 `error.type`、执行时抛错的工具记真实耗时与失败（engine.ts 只加一处）、核对依据改成 semantic-conventions-genai `e07f4eb`、窗口按租户的 trace 保留期截断且 `days` 返回实际天数、停机按 drain 段的截止时刻放弃导出），`ops.selftest` 现在不带 PG 111 项、带 PG 114 项，见「实施记录 · 第 18 步」的「审查之后改的」。README 没动，要点记进第 28 步。
- 半成品：无。分支没 push。留着的一处：成单安全网那处 `executeTool` 抛错还没接 `noteToolError`（engine.ts 只许加一处），见「审查之后改的」第 4 条。
- 阻塞：无。本步没有新的「Open」。
- 下一步：主线照旧是第 10–13 步；第 17 步做的时候先读「实施记录 · 第 18 步」的「注意（第 17 步）」（往 `ops.selftest.ts` 里加用例的位置、日志的 `conv` 与导出的匿名引用不是同一口径）。第 21 步画四个运行数字格时读「注意（第 21 步）」。

### 交接（2026-10-03，第 20.1 步）

- 已完成：第 20.1 步（另开一条线，分支 `fix/02-step20-1-popup-keyboard`，没 push）。`popupRegion` 包的下拉菜单键盘打得开：用户菜单、话术页「更多」里的「丢弃草稿」、条目详情「更多」里的「复制为新草稿」只用键盘走得完；下拉选择与联想点弹层空白处焦点留在输入框里。后台 UX plan「Open」那一条已标成在本步处理，实施记录记在那边。只改 console 前端，README 没动，锁定套件零修改。
- 半成品：无。
- 阻塞：无。后台 UX plan「Open」新加四条（编辑器拉回焦点、菜单项焦点框偏移、禁用的「丢弃草稿」、话术目录的下拉），都不挡 02。
- 下一步：主线照旧；第 20.2 步做 J 页时先读「实施记录 · 第 20.1 步」的「注意（第 20.2 步）」。PR 合并时把后台 UX plan「Open」与本 plan 第 20.1 步里的分支名换成 PR 号。
