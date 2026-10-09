# 03 · 渠道层 v2 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；括号里的 R、不变量、验收编号都指 spec。每一步结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。每步一个 PR 进 `dev`，CI 绿了再合；新依赖钉精确版本；新自测与检查脚本必须串进 `test` 或 `lint`。括号里是工程日估算，合计约 26 个工程日（与 spec 的「粗估约 23」差在哪见「工作量、依赖与并行」）。

## 开工条件

缺一条就停下，告诉 owner：

1. **02 已发版到 main**：02 plan 第 30 步验收通过、spec 翻成 `implemented`、main 上打了发版 tag。在那之前 03 只能改文档，不写代码。
2. 本 spec 是 `Status: ready`（owner 2026-10-09 定）。
3. 线上 demo 以 `SESSION_STORE=db`、`CONFIG_SOURCE=db` 运行（02 第 27 步）。
4. 开放问题 1–3、5–8 已由 owner 在 2026-10-09 定下（spec「开放问题」开头的裁决表），各步照裁决做；开放问题 4 是上线清单里的实测项，不挡开工。

## 开工须知（新会话从这里开始）

- 先读：`AGENTS.md`；本目录 `spec.md` 全文；02 spec 的「identity map 与写入」「企微：发送账本、回执与去重」「任务表与跟进」「导入、导出与切换」「数据库」；02 plan 的「实施记录 · 第 5、6、12、26 步」。然后 `git log -5`，再读本文件的「交接记录」与「Open」。
- **锁定套件**（断言一条不许改）：`src/engine.selftest.ts`、`src/dejargon.selftest.ts`、`src/engine-holiday.selftest.ts`、`src/price-guard.selftest.ts`、`src/llm.selftest.ts`、`src/server.selftest.ts`、`src/adapters/wecom.selftest.ts`，以及 `eval/cases.json`。锁定套件经 `pnpm -s test:locked` 跑在固定时钟上（02 的做法）。任何一步让它们变红，先找自己的改动；确认是 spec 与锁定断言冲突时，停下写进「Open」，不改断言。要改的非锁定断言只限 spec「测试与 CI」列的那几处，PR 里写明理由。
- **前缀**：本阶段不改 SOP 与 system prompt，每一步结束时 `PREFIX sha256` 都要等于第 1 步记下的值（不变量 27、验收 1）。
- **两条状态路径**：文件存储与企微状态是「未导入」「已导出」时走 02 的老路（R1）；02 的 `wecom-02.selftest.ts`、`quota.selftest.ts` 断言不改，它们是老路的回归网。
- 真实 PG 的自测：设 `PG_TEST_URL` 指向本步临时起的 `pgvector/pgvector:pg17` 容器，跑完删掉，不碰本机别的容器（AGENTS.md）。
- 变异测试在隔离副本里跑；复现卡死与崩溃点的脚本用单进程加超时，收尾查 `ps`，不留孤儿进程。
- 沙箱下 tsx 报 `EPERM listen`（建不了本地 IPC 管道）是环境原因，与改动无关：在沙箱外重跑同一个门禁或提交即可。
- 「可派 Codex」的步骤：边界清楚、不碰线上、不需要 owner 拍板，可以交给 Codex 在独立 worktree 里做，Claude 审改动、跑门禁、合并。其余由 Claude 做：迁移顺序、事务边界、恢复语义与线上相关的步骤。

## 步骤

- [x] 1. 开工核对（0.5，Claude）：2026-10-09 完成，基准、盘点与给后面步骤的注意见「实施记录 · 第 1 步」；只改文档。
  - 逐条核对「开工条件」；记下开工提交的 sha、锁定套件 8 个文件的 sha256、四个门禁的结果与 `PREFIX sha256` 的两个值。验收 1 以它们为基准。
  - 只读盘点，结果写进「实施记录 · 第 1 步」，后面的步骤照着改：
    - `src/adapters/wecom.ts` 的模块级状态（token、cursor、handled、在途表、同步互斥、轮询、欢迎语去重、缩略图缓存）逐个列出，标明搬进 `WecomRuntime` 的哪一部分（第 7 步用）；
    - `rg '微信' src` 里写给客户或模型的确定性文本，对照 spec「网页渠道 · 话术」的清单，多出来的记下（第 5 步用）；
    - 每一处 `push`、`sendText`、`sendRich`、`sendMenu`、`send_msg_on_event` 的调用与它的 `kind`（第 8 步用）；
    - 引擎记客户消息的位置（spec 写的是重置分支与正常分支两处）与适配器自己写占位的位置（第 9 步用）；
    - 02 的 `src/store/pg-backend.ts` 一次落库的步骤、存档点、spill 条目的结构（第 8、11 步用）。
  - 文档收尾：02 spec 顶部加 `Superseded in part by:`（列本 spec 顶部 `Supersedes in part:` 的四处）与 `Amended by:`；00、01、后台 UX spec 顶部各加 `Amended by:`（00：部署开关 `web_channel`）。02 plan「上线清单」最后一条（`channel_inbox` 提前）写明「由 03 spec 做，03 implemented 之后勾」。
  - 完成标准：四个门禁全绿；只改文档。
- [x] 2. 迁移、RLS、授权与仓储（2，Claude）：2026-10-09 完成（Claude 子 agent 实现，协调者审查），见「实施记录 · 第 2 步」。
  - `src/db/schema.ts`：`channel_accounts`、`channel_inbox`（含 `ord` 自增列）、`outbound_sends` 的新列与新状态、`conversations.channel_account_id`；custom 迁移写 RLS 模板、授权与列级授权、两个触发器、`purge_channel_inbox`，改写 02 的 `purge_conversation`、`erase_conversation`（删除范围加 `channel_inbox`、`erase` 的返回值加 `inbox`），三处迁移 lint 标注照 spec「数据库」（R2、R4、R8）。
  - `src/channels/transitions.ts`：出站与入站的状态迁移表（纯数据）；`src/db/repo/channel-accounts.ts`、`channel-inbox.ts`，`outbound.ts` 的 upsert 与各短事务改成同一个迁移表 WHERE（R4）。
  - `deploy/backup.sh` 的 TABLE DATA 校验加两张表（表存在时才要求）。
  - 自测：`db.selftest.ts` 的表清单与权限期望表扩到新表；PGlite 上迁移连跑两遍、CHECK、`ord` 递增、迁移表每一格（允许的改了、表外的没改）。真实 PG：新表逐格授权、没有 DELETE / TRUNCATE、两个触发器（不可变列、入站终态不回退、`updated_at` 改不回去）、`purge_channel_inbox` 拒删未到期并把超期未结束的记 `abandoned`、清除与删除连带入站行。
  - 对应验收 19 的库部分、17 的迁移表部分；不变量 7、8、21、30 的库部分。依赖：第 1 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 再跑一遍 `pnpm test` 全绿；`scripts/check-migrations.ts` 通过。
- [x] 3. 凭据加密与密钥环（1，可派 Codex）：2026-10-09 完成（Codex 实现，Claude 审查、补跑门禁），见「实施记录 · 第 3 步」。
  - `src/channels/secrets.ts`：`keyRingFromEnv`、`sealSecrets`、`openSecrets`、`Redacted`；`src/log.ts` 的 `REDACT_KEYS` 加 spec「可观测性」列的字段名；`check-boundaries` 加「`CHANNEL_SECRETS_KEY` 只出现在 `secrets.ts`」与 `src/channels/` 纯模块的依赖规则（R9）。
  - 自测（`src/channels/channels.selftest.ts`，串进 `test`）：密钥环的解析与拒绝、往返、改一个字节、换 AAD、换 key id、旧密钥解、轮换后新密钥解、`Redacted` 在 `JSON.stringify`、`util.inspect`、模板字符串里都是「[已遮盖]」。
  - 对应验收 11 的加解密部分；不变量 16、17。依赖：第 1 步。
  - 完成标准：四个门禁全绿；纯模块，不碰库与运行时。
- [x] 4. 日志脱敏认新的会话 id 形状（0.5，可派 Codex）：2026-10-09 完成（Codex 实现，Claude 审查、补跑门禁），见「实施记录 · 第 4 步」。
  - `src/log.ts` 的 `RAW_CONV_ID` 认 `wecom:(<key>:)?<id>`、`web:<id>`、`sim-<id>` 与 `%3A` 编码的形式；`src/server.ts` 的请求路径与 `src/ops/alert.ts` 照旧经 `scrubConvIds`（R22）。
  - 自测：`ops.selftest.ts` 加这几种形状（含编码形式）在 JSON 行、请求路径与告警正文里都被换成 ref 或短码。
  - 对应验收 10 的日志部分；不变量 22。依赖：第 1 步。
  - 完成标准：四个门禁全绿。
- [x] 5. 部署开关 `web_channel` 与渠道话术分支（1，可派 Codex）：2026-10-09 完成（Codex 实现，Claude 审查、小改、补跑门禁），见「实施记录 · 第 5 步」。
  - `src/profile.ts` 加 `web_channel`（`FLAG_WEB_CHANNEL`，demo 缺省开、prod 封顶为关），不进 00 的 `[profile]` 启动行，生效值照 `legacy_admin_writes` 另打一行（R15）。
  - 话术：网页会话的 contextNote 末尾多一句；第 1 步盘点出的确定性文本按会话渠道分两套（`wecom`、`simulator` 逐字节不变）；console 的渠道中文名加 `web`、`simulator` 改「演示」，非锁定的 console 自测按 spec 改（R15）。
  - 自测：开关的解析与 prod 封顶；同一组对话在三种渠道上的 contextNote、工具结果、确定性文本与前缀哈希（验收 15 的自动部分）。
  - 对应验收 15 的自动部分、14 的「`[profile]` 一行不变」；不变量 27、28 的开关部分。依赖：第 1 步。
  - 完成标准：四个门禁全绿；锁定套件 sha256 不变、`PREFIX sha256` 不变（这一步碰引擎，最容易让锁定套件变红，PR 里贴出两项核对）。
- [x] 6. 账号装载、企微状态与启动（2，Claude）：2026-10-09 完成（Claude 子 agent 实现，协调者审查），spec 顶部记了一条实现期 `Revisions:`，见「实施记录 · 第 6 步」。
  - `src/channels/accounts.ts`（读出、解密 `active` 的账号、env 账号的拼法、`accountByKey`、`accountForSession`、`inactiveReason`）、`markers.ts`（标记文件与恢复哨兵）、`registry.ts` 的 `initChannels`：按 R1 判三种企微状态，六个拒绝原因，标记补写，哨兵的去留（R1、R7 的哨兵部分、R8、R19 的欢迎语校验）。
  - `src/boot.ts`：`initSessionStore` 之后加 `initChannels`；监听之后 `startChannels` 先于任务与跟进扫描器（这一步 `startChannels` 只起 env 账号的老路，库里账号的运行时第 7 步接上）。`/healthz` 加 `channels`（`failing`、`stuck` 先恒为 0，第 13 步接实数）；`.env.example` 加 `CHANNEL_SECRETS_KEY`、`FLAG_WEB_CHANNEL` 与网页限流的变量。
  - 自测：三种状态下走哪条路；六个拒绝原因与「不留半装载」；全部停用时照常起、哨兵留着、之后启用再起被拦；欢迎语不合格按没设处理。
  - 对应验收 2、11 的启动拒绝部分、13 的启动拒绝部分、22 的启动部分；不变量 13、14。依赖：第 2、3、5 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；文件存储与「未导入」下 `wecom.selftest.ts`、`wecom-02.selftest.ts`、`quota.selftest.ts` 照过。
- [x] 7. 按账号拆开的企微运行时与回调路由（2，Claude）：2026-10-09 完成（Claude 子 agent 实现，协调者审查），库里账号用的是过渡状态后端（第 9 步换），见「实施记录 · 第 7 步」。
  - `WecomRuntime`：第 1 步列的模块级状态搬进按账号的运行时，注册表按账号 uuid 建键；文件状态层（cursor 文件、handled、在途表、02 的五种情况）挪进 file 后端、行为不变，锁定的 `__test` 照旧作用于 env 账号（R10）。
  - 会话 id 按账号前缀拼、出站按 `accountForSession` 找账号；`conversations.channel_account_id` 的投影（R11）。
  - 回调：`/wecom/callback/:key` 与 `/wecom/callback`，按账号验签、`receiveid` 校验、`OpenKfId` 分派；公开路由白名单加这一条（R12）。
  - 自测（新建 `src/adapters/wecom-03.selftest.ts`，假企微服务端支持两个 corp、同一 corp 两个客服账号）：三个账号交错、token 失败与停用互不影响、回调各自验签与分派、空 `receiveid`。这一步库里账号的状态后端还接在 02 的发送路径上（第 8、9 步换）。
  - 对应验收 10（日志部分在第 4 步）、12；不变量 18、19、20。依赖：第 6 步。
  - 完成标准：四个门禁全绿，锁定的 `wecom.selftest.ts` 照过；带 `PG_TEST_URL` 跑一遍。
- [x] 8. 出站：先落库后发送（2.5，Claude）：2026-10-09 完成（Claude 子 agent 实现，协调者审查），spec 顶部记了一条实现期 `Revisions:`，见「实施记录 · 第 8 步」。
  - `src/quota/ledger.ts`：`planOutbound`（同步校验）、`commitOutbound`、`markSending` 的四种结果、`settleIntent`、`cancelIntents`；内存账本按账号种类映射状态，env 账号照 02 不改名（R4）。
  - 发送顺序照 spec「出站 · 发一条 AI 回复」第 1–6 步：缩略图之后切分、提交、`markSending` 前后都比接手与截止、`sending → cancelled`、`sending → pending`；人工回复、跟进、通知、同意菜单的 `pending` 加进它们那一次落库；运行时才补的段（R4、R6）。
  - PG 后端：出站 `pending` 与 `cancelled` 写进主事务，结果留在存档点（R21 的出站部分）；出站行的 `kind` 记组的种类；工作台的投递状态按 spec 的映射表（R4）。
  - 自测：迁移表的每条路径在内存与库里一致；`markSending` 四种结果；挂住 `markSending` 期间接手、跨过截止（含判为 `db_unavailable` 的那一种）；R6 的两种补写（验收 7 的 A、B，不含杀进程）；工作台的五种显示。
  - 对应验收 5、7（不含杀进程）、17、20；不变量 4、6、7、10。依赖：第 2、7 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；在隔离副本里做变异（至少：不比第二次接手、`absent` 一律照发、晚到的 `pending` 盖掉结果、结果写进主事务）。
- [x] 9. 入站：`channel_inbox` 与状态机（2.5，Claude）：2026-10-09 完成（Claude 子 agent 实现，协调者审查），spec 顶部记了一条实现期 `Revisions:`，见「实施记录 · 第 9 步」。
  - `src/channels/inbox.ts`：`acceptPage`（与 cursor 同一事务、冷启动）、`load`、`beginAttempt`；出队时的计次、`poison`、`too_old`、恢复截止判定（R2、R3）。
  - `store.queueInboxState` 与 `writeInboxStateNow`；引擎的 `inboxId` 选项，记客户消息的两处都排 `recorded`；适配器的非文本占位、菜单点击、回执、进入会话事件的短路（R3、R21 的入站部分）。
  - 库里账号的企微运行时改用 `channel_inbox`，不再写 `wecom-cursor.json`（不变量 13）。
  - 自测：一页的提交与回滚、`ord` 顺序、状态机每一格、出队计次（队尾不被连累）、四种入站种类的处理。
  - 对应验收 3、9；不变量 1、2、3、8、11、12。依赖：第 8 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；变异（至少：插入就计次、`recorded` 不和消息同一事务、cursor 先于插入提交）。
- [x] 10. 启动恢复与崩溃点（2，Claude）：2026-10-09 完成（Claude 子 agent 实现，协调者审查），spec 顶部记了一条实现期 `Revisions:`，见「实施记录 · 第 10 步」。
  - `src/channels/recovery.ts`：出站恢复表、入站恢复表（按种类与状态）、保底三条、恢复做完之前 `push` 排队等待、`RESEND_UNKNOWN` 常量与 `__channelTest`（R5、R21 的保底）。
  - 停机：截止之后留 `pending`，不再需要 02 的 deferred（spec「重启、崩溃与恢复」）。
  - 自测（真实 PG，子进程 `SIGKILL`，靠假企微、假模型与库连接的阻塞点造时刻）：验收 4 的全部杀点、验收 7 的两种杀进程、验收 18 的每一种出站行、恢复做完之前到期的跟进等待。
  - 对应验收 4、7（杀进程部分）、18、20 的重启部分；不变量 5、15。依赖：第 8、9 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；跑完 `ps` 里没有子进程残留；变异（至少：`sending` 重启后照发、有接手人仍补发、人工回复不看 10 分钟）。
- [x] 11. spill 与 poisoned 会话的渠道行（1，Claude）：2026-10-09 完成（Claude 子 agent 实现，协调者审查），见「实施记录 · 第 11 步」。
  - spill 条目加渠道段、回放与会话同一事务、会话部分失败时渠道部分单独写、旧版 spill 兼容；poisoned 会话的渠道行改走短事务（R21）。
  - 自测：验收 8 的三个场景（spill 回放、poisoned 之后 `SIGKILL`、旧版 spill）。
  - 对应验收 8；不变量 3 的 poisoned 例外。依赖：第 8、9 步（与第 10 步可以并行，见下文）。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍。
- [ ] 12. 恢复截止点、哨兵与备份顺序（1，Claude）
  - `channel-account restore-cutoff`：截止点、出站 `pending` / `sending`、`pending` 与 `running` 的跟进任务、删哨兵、`--until` 的校验（R7）。
  - `deploy/backup.sh`：改回先打包 `var/` 再 `pg_dump`，打包时放进哨兵；开头的恢复步骤加两步（R7、R19）；`ops.selftest.ts` 里步骤顺序的断言照 spec 改。
  - 自测：`restore-cutoff` 的每一类改动与退出码（子进程）；`backup.sh` 用假 `docker` 断言顺序与哨兵只在归档里。
  - 对应验收 6 的命令行与哨兵部分、21 的 `backup.sh` 部分；不变量 9、14。依赖：第 6、10 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍。
- [x] 13. 可观测性（0.5，可派 Codex）：2026-10-09 完成（Codex 实现，Claude 审查、改一处、补跑门禁），见「实施记录 · 第 13 步」。
  - `/healthz` 的 `failing`、`stuck` 接实数；console `/status` 的每账号字段；告警键 `channel` 的各条与 `wecom_send` 带账号 key（spec「可观测性」）。
  - 自测：`ops.selftest.ts` 加各条告警的触发与内容里没有凭据、`external_userid`。
  - 对应验收 23、10 的告警部分。依赖：第 6–10 步。
  - 完成标准：四个门禁全绿。
- [x] 14. 导入、导出与 `--resync`（1.5，Claude）：2026-10-09 完成（为省 Claude 额度改派 Codex 实现，协调者审查加一路交叉评审），spec 顶部记了一条实现期 `Revisions:`，见「实施记录 · 第 14 步」。
  - `src/cli/channel-import.ts`（合并 `handled` 与 `pending`、在途优先、队头计次、`--keep`、标记与删原件的顺序）、`channel-export.ts`（拒绝的几种、写回 02 格式、出站转换、默认账号改 `exported`）、`--resync`（R13）。
  - 自测（子进程，PGlite 与真实 PG）：验收 13 的导入、导出、`--resync` 与启动拒绝；两处真实重叠的夹具。
  - 对应验收 13；不变量 13。依赖：第 6、9 步（导出要用第 8 步的出站状态）。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍。
- [x] 15. 渠道账号管理命令行（0.5，可派 Codex）：2026-10-09 完成（Codex 实现，Claude 审查、补跑门禁），spec 顶部记了一条实现期 `Revisions:` 与一处部分取代，见「实施记录 · 第 15 步」。
  - `channel-account` 的 `list`、`add-wecom`、`add-web`、`set-secrets`、`set`、`rekey`：凭据从无回显输入或 0600 文件读、prod 下 `add-web` 被拒、「已导出」时加账号被拒、欢迎语校验、审计动作与 `actor_kind`（R8、R19、R23）。
  - 自测：各子命令的退出码与审计行；输出里没有凭据与 `corp_id`、`open_kfid`。
  - 对应验收 11 的命令行部分、22 的命令行部分。依赖：第 3、6 步。
  - 完成标准：四个门禁全绿。
- [x] 16. 回滚检查（0.5，可派 Codex）：2026-10-09 完成（Codex 实现，Claude 审查、补跑门禁），见「实施记录 · 第 16 步」。
  - `deploy/rollback-guard.sh` 加退出码 5 这一类：标记文件、以及标记不在时问库「有没有不是『默认企微账号且 `exported`』的行」（R19）。
  - 自测：`ops.selftest.ts` 用假 `docker`、`psql` 断言几种组合的退出码（标记在、只有 `exported`、有停用的账号、有网页账号、库问不到）。
  - 对应验收 21 的回滚检查部分。依赖：第 2 步。
  - 完成标准：四个门禁全绿。
- [x] 17. 网页渠道后端（1.5，可派 Codex，安全相关由 Claude 审）：2026-10-09 完成（Codex 实现，Claude 审查加一路只读安全评审，修了三处），见「实施记录 · 第 17 步」。
  - `src/adapters/web.ts`、`src/web/routes.ts`：会话 id 推导、`__Host-wv` cookie 的发放、续期与「结束咨询」、`x-web-chat`、`cid` 去重与重跑、历史投影、SSE 的鉴权、并发上限与空闲关闭、同意菜单、IP 限流与每日上限、开关 `web_channel` 关着时 404；`adapterFor('web')`；公开路由白名单加网页的几条（R14、开放问题 3、8 的裁决）。
  - 自测（`src/web/web.selftest.ts`）：验收 14 的后端部分与 prod profile 部分。
  - 对应验收 14 的后端部分；不变量 23、24、26、28。依赖：第 2、5、6 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍（网页会话落库与清理）。
- [x] 18. 网页页面与 CSP（1，可派 Codex）：2026-10-09 完成（Codex 实现，Claude 审查、补跑门禁）；完成标准里的浏览器实测挪到第 20 步，见「实施记录 · 第 18 步」。
  - `public/web.html`、`web.js`、`web.css`（从 `chat.html` 改出来，不碰 `chat.html`）：注入配置的转义、CSP 与安全头、`textContent` 渲染、只认站内链接、同意按钮、「结束咨询」（spec「网页渠道 · 页面安全」）。
  - 自测：页面契约（CSP 全等、没有内联脚本、样式与事件属性、恶意标题被转义、站外链接不可点、不读写 `localStorage` 里的凭据）。
  - 对应验收 14 的页面部分；不变量 25。依赖：第 17 步。
  - 完成标准：四个门禁全绿；本机浏览器里实际打开一次 `/w/<key>` 聊一句、刷新、点「结束咨询」，结果写进实施记录。
- [ ] 19. 压测（0.5，可派 Codex）
  - `scripts/load/run.ts` 加一组：两个客服账号各 25 个客户、各 10 轮；先在开工提交（02）上跑基线，再在 03 上跑，同一台机器、同一 PG 配置、同一负载与随机种子，各 3 遍取中位数（spec「测试与 CI」的压测）。
  - 对应验收 24。依赖：第 10、14 步。
  - 完成标准：数字（基线与 03）记进「验收记录」第 24 条；脚本不进 `test`。
- [ ] 20. 部署与演练（1，Claude）
  - 本机 compose 上照 spec「切换步骤」走一遍：以现状部署 → 加密钥 → 停 app → `channel-import --keep` → 起 → 测试消息 → `channel-export` → 部署 02 的镜像（回滚检查放行）→ 文件状态下聊几轮 → `--resync` 切回；回滚检查的几种拒绝；健康检查失败后的自动回滚。
  - 第 18 步挪过来的浏览器实测：本机浏览器里打开 `/w/<key>`，聊一句、刷新（历史还在）、点「结束咨询」（cookie 清掉、会话还在 console 里），结果记进实施记录。
  - 备份恢复演练照验收 6 的场景（A–F 六个客户、T 时刻、哨兵拦住、`restore-cutoff` 之后起），加不跑 `restore-cutoff` 的对照。
  - 对应验收 6 的本机部分、13 的端到端、16、21 的本机部分。依赖：第 1–18 步。
  - 完成标准：结果写进「实施记录 · 第 20 步」与「验收记录」；演练用的容器、数据卷、镜像、临时 tag 都清掉。
- [ ] 21. demo 线上切换（0.5，owner 执行，可授权协调者代办）
  - 照第 20 步演练过的切换步骤 1–4 在线上执行；切换前后的哈希、`channels.mode`、停机时长与不敏感的证据记进「验收记录」第 21 条，主机与路径另记。切换步骤 6、7 见「上线清单」。
  - 对应验收 21 的线上部分。依赖：第 20 步。
- [ ] 22. 对照 spec 当前全部验收标准逐条验证，结果记进「验收记录」（0.5，Claude）
  - 验收 15 的手动部分（真实模型、花钱）在这一步跑，结果记进 plan。
  - 依赖：第 1–21 步。
- [ ] 23. 清理临时探针与测试：隔离副本、本地分支、一次性 PG 容器与数据卷、演练项目、仓库外的运行目录（02 第 29 步的清单）。
- [ ] 24. owner 确认验收通过后，spec 顶部改 `Status: implemented`；同时在 02 plan「上线清单」勾掉 `channel_inbox` 那一条。

## 工作量、依赖与并行

合计约 26 个工程日：第 1–20、22 步 25.5 个，加第 21 步的线上切换 0.5 个（owner 的时间）。spec 首稿粗估 23 个工程日，三轮评审之后加进来的这些约 3 个工程日（spec 背景已随之改成 26）：spill 与 poisoned 的渠道行（第 11 步）、恢复截止点要管跟进任务与出站行、哨兵与备份顺序（第 12 步的大半）、`exported` 状态与导出的拒绝规则、`markSending` 的四种结果与两条回退迁移、网页页面的 CSP 与 SSE 并发上限、部署开关 `web_channel`。并行能缩短日历时间，工程日不变。

依赖（每一步要等哪几步合并）：

| 步骤                 | 依赖    | 步骤              | 依赖    |
| -------------------- | ------- | ----------------- | ------- |
| 2 迁移与仓储         | 1       | 13 可观测性       | 6–10    |
| 3 凭据加密           | 1       | 14 导入导出       | 6、8、9 |
| 4 日志脱敏           | 1       | 15 账号管理命令行 | 3、6    |
| 5 开关与话术         | 1       | 16 回滚检查       | 2       |
| 6 账号装载与启动     | 2、3、5 | 17 网页渠道后端   | 2、5、6 |
| 7 按账号拆运行时     | 6       | 18 网页页面       | 17      |
| 8 出站               | 2、7    | 19 压测           | 10、14  |
| 9 入站               | 8       | 20 部署与演练     | 1–18    |
| 10 启动恢复          | 8、9    | 21 线上切换       | 20      |
| 11 spill 与 poisoned | 8、9    | 22 验收           | 1–21    |
| 12 截止点与备份      | 6、10   | 23、24            | 22      |

分批（Claude 一条主线，Codex 并行；同一批里的步骤互不依赖）：

| 批  | Claude（核心：迁移顺序、事务边界、恢复语义）                                                                          | 可派 Codex（边界清楚、不碰线上、不用 owner 拍板） | 这一批结束时 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------ |
| 0   | 1 开工核对                                                                                                            | —                                                 | 约第 0.5 天  |
| 1   | 2 迁移与仓储                                                                                                          | 3 凭据加密、4 日志脱敏、5 开关与话术              | 约第 2.5 天  |
| 2   | 6 账号装载与启动                                                                                                      | 16 回滚检查                                       | 约第 4.5 天  |
| 3   | 7 按账号拆运行时与回调                                                                                                | 15 账号管理命令行、17 网页渠道后端                | 约第 6.5 天  |
| 4   | 8 出站先落库后发送                                                                                                    | 18 网页页面与 CSP                                 | 约第 9 天    |
| 5   | 9 入站状态机                                                                                                          | —                                                 | 约第 11.5 天 |
| 6   | 10 启动恢复（第 11 步可另开一个 Claude worktree 并行，两步改的文件不重叠：`recovery.ts` 对 `pg-backend.ts` 的 spill） | 13 可观测性（等第 10 步合并再开）                 | 约第 13.5 天 |
| 7   | 11 spill 与 poisoned、14 导入导出                                                                                     | —                                                 | 约第 16 天   |
| 8   | 12 恢复截止点与备份                                                                                                   | 19 压测                                           | 约第 17 天   |
| 9   | 20 部署与演练 → 21 线上切换（owner）→ 22 验收                                                                         | —                                                 | 约第 19 天   |

只有一条 Claude 主线时日历约 19 个工作日（Claude 那一列的估算之和，含 owner 的第 21 步）；Codex 那一列共约 7 个工程日，在主线之外并行。第 7、8、9 步依次改企微适配器与 PG 后端的同一片代码，只能串行；第 10、11 步改的文件不重叠（`recovery.ts` 对 `pg-backend.ts` 的 spill），有第二个 Claude worktree 时可以并行，表里按串行排。

**不能砍**：第 2、8、9、10、11 步（表的形状、先落库后发送、入站与会话同一事务、恢复规则、spill 带渠道行；以后补都要再迁一次数据或会重复回复）；第 12 步的哨兵与截止点（从备份恢复后会重复回复）；第 14、16 步（没有它们就回退不了）。要砍就砍网页渠道（第 17、18 步整块推到阶段 4，demo 照旧用模拟器）：spec 要改目标 5、R14、R16 的一句、不变量 23–26、验收 14、15，顶部写 `Revisions:`，只有 owner 能定。

## 上线清单（接第一个真实租户之前）

不是本 spec implemented 的条件。每项只记「已完成 / 未完成」与日期，内容另记：

- [ ] 开放问题 4 的实测，在测试客服账号上做，结论记进本文件「Open」，只改 `src/quota/ledger.ts` 与适配器里的常量：
  - 同一 msgid 重发时企微是去重还是当新消息——去重就把 `RESEND_UNKNOWN` 改为真（R5 的漏发边界随之消失）；
  - 回调明文里有没有 `OpenKfId`；
  - 48 小时 / 5 条是否按客服账号分开算；
  - `sync_msg` 能拉到多久以前的消息（入站行留 7 天够不够）。
  - 与 02 plan「上线清单」里企微额度实测那一项一起做。
- [ ] 线上切换（第 21 步，验收 21 的线上部分），连同回退步骤在本机演练过（第 20 步）。
- [ ] 切换后第一份每晚备份恢复到临时集群，跑完 `restore-cutoff` 起得来、会话数一致（验收 6 的线上部分）；之后删掉 `--keep` 里的 `wecom-cursor.json` 原件（spec 切换步骤 6）。
- [ ] `CHANNEL_SECRETS_KEY` 存进 owner 保管 env 文件的地方（另记）；轮换掉的密钥离线保管到最后一份用它加密过的备份过期（异地 30 天，R9）。
- [ ] 恢复手册（`deploy/backup.sh` 开头）按 R7 加了「确认密钥、跑 `restore-cutoff`」两步，并按开放问题 5 的裁决写明截止点怎么取。
- [ ] 03 验收通过、确定不回退到 02 之后，从服务器 `.env` 删掉 `WECOM_*`，重启一次核对仍正常（spec 切换步骤 7）。
- [ ] 02 plan「上线清单」里没勾的各项（PIA、委托处理约定、属地登记答复、隐私说明、保留期、同意细节复核、真实模型回归、值班成员）仍然有效，不在本文件重复。
- 不在本清单：prod 的网页渠道。本阶段 prod 不开放（开放问题 2 定 A），给真实租户开网页渠道要等阶段 4 的渠道中立锁定节，那时再按租户流量调开放问题 3 的几个数。

## 实施记录

（各步完成时按步骤追加：结构、本步定的、偏离、自测与变异结果、给后面步骤的注意。）

### 第 1 步 · 开工核对（2026-10-09）

**基准**

- 开工条件逐条核对通过：main 上有发版 tag `demo-v3`（合并 PR #108），02 spec `Status: implemented`、02 plan 第 30 步已勾；本 spec `Status: ready`；线上 demo 以 `SESSION_STORE=db`、`CONFIG_SOURCE=db` 运行（02 第 27 步，2026-10-09）；开放问题 1–3、5–8 已定。
- 开工提交 `5b697c2de2d237950358e4395388186f541da64b`（dev，合并 PR #109）。
- 锁定文件 sha256（验收 1 的基准，与 02 开工时相同）：

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

- 四个门禁在开工提交上全绿：`pnpm test` 退出码 0、PASS 行 70，mock eval 两遍各 19/19（跳过 32 条要真实模型的）。`PREFIX sha256 system=dd2c10ee4d4205c1938f7ebdd3a4258490828a146a30c9931c33e35872ffdd60 tools=64c16fc8f464d5757f02411b7f8a2a6ce6f43da63416283851a6e997819692d1`（与 02 第 15 步之后的值相同）：第 2–20 步每步结束时都要等于它。

**文档收尾**

- 02 spec 顶部加 `Superseded in part by:`（本 spec 顶部 `Supersedes in part:` 的四处）与 `Amended by:`；00、01、后台 UX spec 顶部各加 `Amended by:`（00：开关 `web_channel`；01：审计的新动作；UX：渠道中文名）。02 plan「上线清单」最后一条写明由本 spec 做、本 spec implemented 之后勾。

**盘点（行号以开工提交为准）**

1. `src/adapters/wecom.ts` 的模块级状态 → `WecomRuntime`（第 7 步）：
   - token：`cachedToken`、`tokenExpireAt`、`tokenInflight`（:76–78）。`tokenErrorListeners`（:84）留在进程级（告警订阅出口），回调要多带账号 key。
   - 状态后端（file 后端照留，库里账号换成 `channel_inbox` 与账号行的 cursor）：`cursor`（:165）、`handled`（:167，TTL 3 天、上限 5000）、`inflight`（:187）、`coldStartCutoff`（:199）、`saveChain`（:259）、`stateSaveTimer`（:282）。
   - 停机截止：`sendsClosedAt`（:345）、`stopping`（:1254）。同步互斥：`syncTask`、`pendingRequested`、`pendingToken`（:1250–1252）。处理链：`userChains`（:1213）、`eventTasks`（:1215）。恢复标志：`readyPromise`（:1372，现在表示「重放已派发」，不表示处理完）。轮询：`started`、`pollTimer`（:1400–1401）。欢迎语去重：`welcomeBackAt`（:390），窗口 `WELCOME_DEDUPE_MS`（:389，加载时读 env）。缩略图缓存：`thumbCache`、`thumbInflight`、`thumbFailUntil`（:444–448）。
   - 留进程级、不搬：`LEGACY_WELCOME_TEXTS`、`WELCOME_TEXTS`（静态）、各个匹配正则、`wecomAdapter` 门面与 `__test`（门面内部按会话路由到运行时，`__test` 指向 env 账号）。
   - 配置：`readConfig` 每次现读 `WECOM_CORP_ID`、`WECOM_APP_SECRET`、`WECOM_KF_OPEN_KFID`、`WECOM_POLL_INTERVAL_MS`、`PUBLIC_BASE_URL`（调用方 `isWecomEnabled`、`syncFromCallback`、`startWecom`、`push`）；`VAR_DIR`、`STATE_FILE`（:43、:56）归 env 账号的 file 后端。**适配器外**还有三处读企微 env：`src/server.ts:795`（`receiveid` 校验读 `WECOM_CORP_ID`）、`:800`、`:820`（回调读 `WECOM_CALLBACK_TOKEN`、`WECOM_CALLBACK_AES_KEY`），第 7 步改成按账号。
   - 退出钩子 `process.on('exit', flushStateSync)`（:308）与 `onShutdown(drainForShutdown)`（:1468）只管一套状态，拆开后要覆盖每个账号。
   - 锁定 `__test` 的出口：`STATE_FILE`、`resetForTest`（:1495；清 cursor、handled、inflight、冷启动、ready、同步互斥、停机、处理链、`welcomeBackAt`，**不清** token、缩略图、`started`、`pollTimer`、监听器，不删文件）、`inspectForTest`（:1517）、`splitForWecom`、`extractCard`、`stripLink`、`wechatify`、`WELCOME_BACK_TEXT`、`LEGACY_WELCOME_TEXTS`。
2. 「微信」话术（第 5 步）：要按渠道分的是 `src/engine.ts` 七处——:465 `resendPayReply`、:1250 价格护栏已转人工的兜底、:1324 `strandedReply`、:2031 `handoffReply`、:4001 与 :4051 成单安全网（已有订单、新建订单）、:4159 驳回转接的「会请顾问在微信上跟您确认」；`src/tools.ts:1036` `ADVISOR_PAY_NOTE`（工具结果，写给模型）；`src/price-rules.ts:423–425` `PHONE_PROMISE` 两条替换。spec 清单之外、判断为不改的：`src/prompt/system.ts:22,30`（前缀，spec 写明不动）；`src/llm.ts:871`（工具调用兜底的「用中文微信语气回复」，是文体，`llm.ts` 归锁定的 `llm.selftest.ts` 管）；`src/insight.ts:160`（给顾问起草，顾问发前会看）；`src/followup.ts:129`（跟进只追企微）；`src/engine.ts:4371`（给顾问的待办正文）；`src/sop/contract.ts:52`（SOP 契约）。另外 `src/engine.ts` :1874–1969、:4142、:4367、:4485 一带识别「顾问会在微信上联系您」的判定正则，网页会话里模型会说网页的说法，第 5 步要看漏判的后果（只在 `web` 下放宽）。
3. 出站调用点（第 8 步）：AI 回复 `src/adapters/wecom.ts:1171`（含 02 情况 4 的原样重发）、非文本引导 :1110 与异常兜底 :1203（都记 `ai`）；人工回复 `src/handoff/takeover.ts:370`（`human`）；跟进 `src/followup.ts:251`（文件）与 `src/jobs/followup.ts:237`（任务表），都是 `followup`；通知 `src/server.ts:640` 付款确认、`src/payment/orders.ts:107` 顾问确认收款、`src/adapters/wecom.ts:950` 不同意后的确认，都是 `notice`；同意菜单 `src/engine.ts:3497` → `src/adapters/wecom.ts:1488` `sendMenu`（`menu` 带 category）；老客户欢迎语 :982（`welcome`，无会话时独立短事务）。卡片段 :702、:706 记 `card`（spec 定库里账号改记组的种类）。`send_msg_on_event` 的欢迎语（:839、:970）不走发送账本。转发通道：`src/server.ts:109` `setReplyTransport`、:968 `pushFollowUp`、`src/handoff/takeover.ts:265` `pushToChannel`。`push` 的实现：wecom（:1473，默认 `notice`）、simulator（`src/adapters/simulator.ts:28`，不记账）、未知渠道兜底（`src/server.ts:101`，返回 false）。
4. 客户消息写进会话（第 9 步）：引擎只有两处，都在 `handleMessageInner`——重置分支 `src/engine.ts:3554`（要求 `opts.msgid && !opts.alreadyRecorded`）与正常分支 :3599（`!opts.alreadyRecorded`，有 msgid 才带）。适配器自己写的：非文本占位 `src/adapters/wecom.ts:1090`（customer，带入站 msgid）与随后的引导 :1114（agent）；菜单点击 :952 只写同意记录与不同意时的 agent 确认，点击本身不写消息；发送失败回执 :1300 → `src/quota/ledger.ts:443` 写 system 说明；进入会话 :987 只写欢迎语（agent），事件本身不写；接手说明 :1163、:1182，发送失败说明 :1191，在途放弃说明 :1358（都是 system）。
5. 02 PG 后端一次落库（第 8、11 步）：`takeSnapshot`（`src/store/pg-backend.ts:833`）→ `runFlush`（:944，`withTenant` 主事务）→ `writeSnap`（:896）：锁会话行、`flushId` 对齐判 `AlreadyCommitted` → 消息（:916）→ 会话投影（:918）→ 订单、审计、任务、同意（:921 → :517）→ `SAVEPOINT telemetry` 里 trace、护栏事件、`outbound_sends`（:926–929，失败整批丢弃、计数）→ `afterCommit`（:967）。`usage_daily` 不在会话落库里（:1223 独立短事务）。poisoned 判定在 :350、:816、:885、:1006；poisoned 之后新来的 telemetry（含账本）直接丢弃（:1210），没有渠道行的短事务路径。spill：外壳 `{ version: 1, tenant, at, sessions }`（:138），条目字段见 :104–127（没有 trace、账本、渠道段），写出 `spillEntryOf`、`spillSync`（:1058、:1370），回放 `replaySpills` → `replayFile` → `replayEntry`（:608、:665、:558），回放没有 telemetry 存档点。账本行的写法：`recordSend` → `queueTelemetry` → 存档点里 `insertOutboundSends`；没有会话的欢迎语走 `writeStandaloneOutbound`（:1250）；回执走 `markOutboundFailed` 短事务（:1264）。

**给后面步骤的注意**

- 第 8 步：spec「出站 · 发一条 AI 回复」说同意菜单「本来就是先落库后发送」，代码里发送前落库的只是「问过」的同意状态，菜单那条 agent 消息与账本行都在发送成功之后才写（`src/engine.ts:3497–3499`、`src/adapters/wecom.ts:790`）。所以菜单的 `pending` 要加进「问过」那一次落库，不是加进一条已有的消息落库。
- 第 9 步：spec R2 说入站行留 7 天「与 02 的 7 天 msgid 集合同一口径」；文件路径的 `handled` 是 3 天（:166–168），7 天说的是 02 PG 路径的最近客户 msgid 集合。按 spec 的 7 天做，不影响老路。
- 盘点 1、3、4、5 由 Codex 只读完成，Claude 抽查了 :166–168、引擎两处 customer 写入、存档点 :926–929 与 spec 第 398 行。

### 第 4 步 · 日志脱敏认新的会话 id 形状（2026-10-09）

- `src/log.ts` 的 `RAW_CONV_ID` 改成认 `wecom:<id>`、`wecom:<key>:<id>`（key 照 R8 的 `^[a-z][a-z0-9-]{1,30}$`）、`web:<32 位小写十六进制>`、`sim-<id>`，每个冒号都可以是 `%3A` / `%3a`（含混合编码）。`web:` 只认恰好 32 位十六进制、后面不接 id 字符，普通文本里的「web: 首页」「web:abc」不动。`scrubConvIds` 把匹配串里所有编码冒号解回 `:` 再交给 `convCode`（按完整会话 id 查 ref，查不到退回短码）。`shortIdOf` 不改：新形状只取最后 4 位字母数字，不含整段 `external_userid`。`src/server.ts` 的请求路径与 `src/ops/alert.ts` 本来就经它，不用改。
- 自测追加在 `src/ops/ops.selftest.ts`（不改已有断言）：6 个手写 id 展开成 28 种原文与编码组合，在 JSON 日志行（正文与嵌套字段）、prod 下的请求路径、告警正文三处都换成 ref 或短码，整份输出里搜不到原 id、`external_userid`、网页哈希与 `key:id` 残片；demo 下请求路径原样；普通网页文本与长度不对的 id 原样。
- 门禁：四个全绿，`pnpm test` PASS 70 行，`PREFIX sha256` 与第 1 步相同，锁定文件未动。Codex 沙箱里 `pnpm test` 末尾的 console 构建报 `EPERM`（`console/dist/.vite`），由 Claude 在沙箱外补跑。

### 第 3 步 · 凭据加密与密钥环（2026-10-09）

- `src/channels/secrets.ts`（只 import `node:crypto`、`node:util`）：`keyRingFromEnv` 解析 `<id>:<base64>`，逗号分隔、第一把是 `current`；拒绝缺冒号、id 不合 `^[A-Za-z0-9_-]{1,32}$`、id 重复、base64 不合法或非规范、长度不是 32 字节，错误只说第几项哪里不对。`sealSecrets` / `openSecrets` 照 R9：AES-256-GCM、12 字节随机 nonce、AAD `channel_accounts:v1:<tenant>:<account>`、`nonce ‖ 密文 ‖ tag`。`Redacted` 的值放在私有字段 `#v`，`toJSON`、`toString`、`Symbol.toPrimitive`、`util.inspect.custom` 都是「[已遮盖]」。
- 本步定的：`ChannelSecretError` 的 message 是「渠道凭据 `<keyId>`：<失败类别>」（密钥不存在、密文长度不足、认证失败、JSON 无效、凭据字段无效），带 `keyId` 字段，不保留底层异常（`JSON.parse` 的报错可能带明文片段）。spec 说 detail 里要有账号 key：`openSecrets` 拿不到 key，由第 6 步的 `initChannels` 包成 `channel_decrypt` 时拼上。
- `src/log.ts` 的 `REDACT_KEYS` 加 `appSecret`、`callbackToken`、`callbackAesKey`、`secrets`、`secretsCt`、`secrets_ct`；现有日志里没有叫 `secrets` 的字段。
- `scripts/check-boundaries.ts`：`secrets.ts`、`markers.ts`、`transitions.ts` 是纯模块（不 import `src/db/`、store、engine、llm、adapters，未建的先登记）；`src/channels/` 不 import engine、llm、tools；`src/db/`、`src/cli/` 不 import `src/channels/registry.ts` 与 adapters；`CHANNEL_SECRETS_KEY` 只出现在 `secrets.ts`（只管代码文件，`.env.example` 与文档不管，自测用字符串拼出这个名字）。`recovery.ts` 的判定部分等第 10 步拆文件后再登记。Codex 在隔离副本里故意违反七组规则，`pnpm lint` 都拦住了。
- 自测 `src/channels/channels.selftest.ts`（串进 `test`）54 项：密钥环的解析与每种拒绝（错误里没有密钥片段）、往返、改 nonce / 密文 / tag 各一字节、换 AAD、换 key id、旧密钥解、轮换后只剩新钥解不开旧密文、`Redacted` 在 JSON / inspect / 模板 / `String` / `console.log` 里遮盖、错误对象打印不含明文与密文的 base64 / hex / Buffer JSON、六个新字段的日志脱敏。
- 门禁：四个全绿，`PREFIX sha256` 与第 1 步相同，锁定文件未动。console 构建在 Codex 沙箱里 `EPERM`，由 Claude 在沙箱外补跑。

### 第 5 步 · 部署开关 `web_channel` 与渠道话术分支（2026-10-09）

- 开关：`src/profile.ts` 加 `web_channel`（`FLAG_WEB_CHANNEL`，demo 缺省开，prod 封顶为关、设 `on` 以 `ProfileConfigError` 拒绝启动），不进 `BASELINE_FLAG_NAMES`；`src/server.ts` 照 `legacy_admin_writes` 另打一行 `[profile] web_channel=on|off`。`PROFILE_ENV_NAMES` 自动带上它，自测与 eval 照常钉住。
- contextNote：`channel === 'web'` 的会话末尾多一句「客户正在网页上咨询，不在微信里；说到顾问跟进时，请说顾问会在这个页面里回复您，不要说在微信上联系。」（验收 15 手动部分的真实模型记录用的就是这一句）。
- 确定性文本：第 1 步清单的十处都按会话渠道分两套，`web` 的说法是「在这个页面里」（价格护栏已转人工的兜底是「顾问会在这个页面里回复您」，驳回转接是「会请顾问在这个页面里跟您确认」，`payNote` 是「顾问会在这个页面里跟客户核对价格并发收款方式」，`PHONE_PROMISE` 两条是「在这个页面里」「在这个页面里回复您」）；`wecom`、`simulator` 逐字节不变。`PHONE_PROMISE` 表的每一项直接带两套文字（Claude 审查时改的写法）。
- 判定正则（本步定的，spec 没写）：网页会话的模型会说「顾问会在这个页面里回复您」，只认微信说法的话「答应联系却没给顾问记待办」「驳回后没摘掉转接承诺」会漏判。所以加了 `WEB_CONTACT_CLAIM`（`CONTACT_CLAIM` 加页面里的「回复您 / 跟您确认 / 与您确认」），只在 `web` 下用：`transferClaim`、`saysTransfer`、`dropTransferClaims`（三个调用点都传会话）、`promisesContact`。转接动作、条件、选项、售后排除与锁定自测用的 `claimsTransfer` 照旧。
- console 渠道中文名：`src/shared/conversation.ts` 与 `console/src/shell/model.ts` 两张 `CHANNEL_SHORT` 加 `web: '网页'`，`simulator` 改「演示」；`src/notify/handoff.ts` 经同一张表随之变化。改了两条非锁定断言的期望（spec「测试与 CI」列的那一处）：`notify.selftest.ts` 的「网页学员」→「演示学员」，`conversations.selftest.tsx` 的「网页客户」→「演示客户」（测试名同步改）。
- 自测 `src/web/web.selftest.ts`（串进 `test`，第 17 步接着往里加）：开关的解析与 prod 封顶、`[profile]` 一行不含它；13 组场景 × 三种渠道（建单、重发、补发链接、转人工时订单还在、价格兜底、驳回转接、电话承诺两条等），`wecom`、`simulator` 的 contextNote、工具结果与回复等于从开工提交抄下来的字面量，`web` 的多那一句、没有「微信」；三者的 system、tools 哈希等于第 1 步的值；改过的判定正则每处一条 web 正例与 wecom 对照。
- 门禁：rebase 到含第 3、4 步的 dev 之后四个全绿，锁定文件 sha256 与第 1 步相同，`PREFIX sha256` 不变。

### 第 16 步 · 回滚检查（2026-10-09）

- `deploy/rollback-guard.sh` 加渠道这一类风险：目标镜像里没有 `src/channels/registry.ts`（`pre03_image`，docker 出错按 03 之前算）、或 `<目标>` 是新的 `pre-03` / 原来的 `pre-02` 时，`var/channels-in-db.json` 在，或标记不在而库里 `channel_accounts` 有任何一行不是「`kind = 'wecom_kf'`、`id_prefix = 'wecom:'`、`status = 'exported'`」（`IS NOT TRUE`，网页账号的 NULL 前缀也算），拒绝，退出码 5。问库照条目版本那一条的写法（超级用户、先 `to_regclass`，表不在就没有这条风险）；库问不到时，正在跑的镜像明确是 03 之前才不算，否则按有风险。
- 退出码优先级 4 > 5 > 3：条目版本风险照旧只打印「只能回到 02 之后的镜像」；有渠道风险时打印 `channel-export` 的回退步骤（停 app → 用当前镜像跑 `channel-export --tenant <slug> --var /app/var --keep /keep` → 确认标记没了、默认账号 `exported`、`.env` 的 `WECOM_*` 还在 → 部署旧 tag 或直接起目标镜像），目标同时是 02 之前、会话在库里时接着打印 02 的「回到文件存储」步骤；只有会话风险照旧 3。
- `deploy.sh`：tag 里没有 `pg-backend.ts` 照旧 `pre-02`，有它而没有 `registry.ts` 是 `pre-03`；部署与自动回滚两处的 `case` 都加 `5)` 的提示。
- 自测在 `src/db/db.selftest.ts` 现有的 rollback-guard 测试台里追加（假 docker 加镜像里有没有 `registry.ts`、渠道问库 t / f / none / down 的开关），覆盖 plan 列的组合与优先级、两段步骤、deploy.sh 选 `pre-02` / `pre-03`。改了一条非锁定断言：自动回滚那段 `case` 的结构正则从 `[34*]` 三个分支放宽到 `[345*]` 四个分支（加 `5)` 是本步的本意，原说明「旧断言一条不改」与之冲突，Claude 答复后由 Codex 续做）。
- 门禁：四个全绿，`PREFIX sha256` 与第 1 步相同，锁定文件未动。Codex 实现，Claude 审查、补跑门禁。

### 第 2 步 · 迁移、RLS、授权与仓储（2026-10-09）

**结构**

- 迁移：`drizzle/0004_channels.sql`（drizzle-kit 生成的 DDL：`channel_accounts`、`channel_inbox`（`ord` 是 identity 列）、`outbound_sends` 的五个新列与七种状态、payload CHECK、账号外键与 `outbound_sends_open` 索引、`conversations.channel_account_id`）；`drizzle/0005_channels_rls.sql`（custom：两张表套 01 的 RLS 模板，两个 BEFORE UPDATE 触发器，`purge_channel_inbox`，`CREATE OR REPLACE` 改写 02 的 `purge_conversation`、`erase_conversation`，授权与列级授权）。
- 授权：`channel_accounts` 给 `agent_app` SELECT、INSERT 与 spec 列的 9 列列级 UPDATE；`channel_inbox` 给 SELECT、INSERT、UPDATE；`agent_platform` 对两张表没有权限；所有角色都没有 DELETE、TRUNCATE。`purge_channel_inbox` 只授权给 `agent_app`。
- 触发器（报 `check_violation`，报错不带列值）：`channel_accounts_guard` 拦 `key`、`kind`、`id_prefix`、`corp_id`、`open_kfid` 的修改并写 `updated_at`；`channel_inbox_guard` 对已是 `done`、`abandoned` 的行任何 UPDATE 都报错，否则写 `updated_at`。
- `purge_channel_inbox(p_tenant, p_now)`：照 02 的写法（SECURITY DEFINER、租户与 `p_now` ±5 分钟校验），先删结束超过 7 天的行，再把收到超过 7 天还没结束的记 `abandoned`（`too_old`）、清空 `payload`，返回两类条数之和。`purge_conversation`、`erase_conversation` 与 0003 逐行比过，只多删 `channel_inbox` 里这个会话的行（`send_fail` 行也必须带 `conversation_id`，CHECK 管着）；`erase` 的返回值与审计 diff 多一项 `inbox`。
- `src/shared/channel-types.ts`：spec 的六个共享类型（由 `as const` 数组推出）。`src/channels/transitions.ts`（纯数据，只 import `src/shared/`）：出站表每格 `{ from, to, by: 写入方[] }`，写入方七个（`plan`、`mark`、`settle`、`cancel`、`unmark`、`recover`、`receipt`），`from` 为 null 表示插入；入站表只往前走、任一步可到 `abandoned`、终态没有出边。
- 仓储：`src/db/repo/outbound.ts` 的落库 upsert 只用 `plan`、`settle`、`cancel`、`receipt` 四个写入方的格子，`ON CONFLICT … WHERE (status, excluded.status) IN (…)`；只插入允许直接插入的状态，`sending`、`cancelled` 只改已有行；同一批同一 msgid 的几次写按先后分轮判断；迁出 `pending` / `sending` 时同一条语句把 `payload` 置空。短事务 `transitionOutbound(tx, msgid, to, by)` 生成 `WHERE status IN (…)`，没有可出发的状态就不发 SQL；`markOutboundSending` 返回 `marked`、`not_pending`、`absent`。新增 `src/db/repo/channel-accounts.ts`（列出、新建、只改列级授权那几列）、`src/db/repo/channel-inbox.ts`（`insertInboxRows` 冲突即跳过、按 `ord` 返回，`setInboxState` 按迁移表，`bumpInboxAttempts`，`readOpenInbox`）。状态值都是绑定参数。
- 每日 `retention_purge`（`src/jobs/purge.ts`）多调一次 `purge_channel_inbox`；`erase-conversation` 的输出多一项 `inbox=`。`deploy/backup.sh` 的 TABLE DATA 校验在库里有这两张表时也要求它们（缺表只告警一行）。

**本步定的与偏离 spec 的地方**

- `channel_accounts_wecom_check` 写成 `coalesce(id_prefix IN (…), false)`：照 spec 原样，`id_prefix` 为 NULL 时 CHECK 得 NULL 会被放行。
- 重新加回的 `outbound_sends` status CHECK 也命中迁移 lint 的 `add-check`，标注写的是「放宽 status 的取值，旧镜像写的值都在新集合里」。
- 入站终态行的任何 UPDATE 都报错，写回原值也不行（对「任何改动」的严格读法）。`updated_at` 的触发器照 spec 只管 UPDATE；仓储从不写这一列。
- `purge_channel_inbox` 接进每日任务放在本步做（spec 写了由这个任务调用，plan 没有哪一步写这件事；协调者确认）。
- 02 老路上一处行为变了：对 `rejected` 的行收到回执，02 会改成 `failed`，03 的迁移表把 `rejected` 定为终态，现在是无操作。企微不会对自己拒收的消息发失败回执，实际碰不到，协调者确认接受。
- 子 agent 原先在入站表里多加了 `received → replied` 一格（非文本占位与引导提示同一次落库），spec 没有这一格，按 spec 删掉：同一次落库里先 `recorded` 再 `replied`，由第 9 步按顺序逐条写。

**自测**

- `src/db/db.selftest.ts` 有意改的非锁定断言（spec「测试与 CI」允许的表清单与权限期望表，以及 03 Amends 02 不变量 42 与 erase 返回值带出的几处）：表清单 +2；清除函数清单四个改五个；列级 ACL 期望 +9 列、改成按 JS 顺序比；权限期望表、DELETE / TRUNCATE 循环、RLS 插入表；`purgeChecks` 里 erase 的期望条数加 `inbox`、全库扫描与「不变量 42」的表清单加 `channel_inbox`；一条 02 断言的标签从「只有四种」改成「02 四种，03 起七种」（断言本身没改）；假 docker 的缺省输出加两张新表。
- 新增：从 02 的库升级上来、迁移连跑两遍、CHECK、`ord` 递增、出站短事务 343 格、upsert 56 格、入站 25 格（都对照 spec 原表的独立字面量，表外的是无操作）、两个触发器与 `purge_channel_inbox` 在 PGlite 与真实 PG 各一遍、真实 PG 上逐格授权、列级授权、隔离、没有 DELETE。
- 与第 16 步合在一起时撞了一处：第 16 步的假 docker 把命令里带 `channel_accounts` 的调用都当成回滚检查的查询（另记一类日志、回假结果），本步 `backup.sh` 的探测查询也带这个表名，被截走，「按项目名找 db」那条断言少数一次调用。假 docker 改成只认回滚检查独有的 `public.channel_accounts` 与 `from channel_accounts where`。
- 结果：四个门禁全绿（rebase 到含第 3、4、5、16 步的 dev 之后重跑）；带 `PG_TEST_URL` 的 `pnpm test` 全绿（DB SELFTEST 1133 项，STORE 452、JOBS 110、QUOTA 127、WECOM-02 15，DB 模式 19 个用例「0 处与内存不符」）；`wecom-02.selftest.ts`、`quota.selftest.ts` 断言不改照过；`PREFIX sha256` 与第 1 步相同，锁定文件未动。一次性 PG 容器与它的匿名卷已删。由 Claude 子 agent（Opus）实现，协调者审查。

**给后面步骤的注意**

- 第 6 步：`listChannelAccounts` 返回任何状态的账号，行里带 `secrets_ct`，不要整行打印；`readOpenInbox`、`readOpenOutbound(accountId | null)` 已可用。
- 第 8 步：落库用 `insertOutboundSends`，标 `sending` 用 `markOutboundSending`，截止后迁回 `pending` 用 `transitionOutbound(…, 'pending', 'unmark')`，标了 `sending` 又被接手用 `'cancelled', 'cancel'`；同一批里先 `pending` 后 `cancelled` 能正确落成 `cancelled`。`readOutboundForSeqs`、`readOutboundAfterLastCustomer` 仍按 02 的四种状态转型、也不按 `account_id` 过滤，工作台映射时要放宽。
- 第 9 步：同一次落库里同一入站行的几次状态变化按顺序逐条写；`abandoned` 必须带原因（否则发 SQL 之前就抛错）；别对终态行发不带状态条件的 UPDATE，触发器会报错。
- 第 12、14 步：`restore-cutoff` 与导出用 `transitionOutbound(…, 'cancelled' | 'unknown', 'recover')`；`--resync`「把没结束行的 `payload`、`attempts` 换成文件里的」还没有对应的仓储函数；导入的 `legacy` 行 `updated_at` 取 `now()`，导入后再留 7 天。

### 第 6 步 · 账号装载、企微状态与启动（2026-10-09）

**结构**

- `src/channels/accounts.ts`：spec 的类型与 `ENV_ACCOUNT_ID`；`envAccountFrom`（`WECOM_CORP_ID`、`WECOM_APP_SECRET`、`WECOM_KF_OPEN_KFID` 配齐才有，key 固定 `env`，文件存储下 `tenantId` 是空串）；`accountFromRow`；`readChannelAccounts`、`openAccountSecrets`；导出的欢迎语校验 `checkWelcomeText`；装上的账号表与 `accountByKey`、`accountForSession`。`src/channels/markers.ts`（纯模块）：`channels-in-db.json` 与恢复哨兵 `restored-from-backup.json` 的判断、读、写、删（临时文件改名、文件与目录 fsync，02 的写法）。`src/channels/startup-error.ts`：`ChannelStartupError`（同 02 的 `SessionStoreStartupError`，`boot.ts` 不必为它带上适配器与库），`registry.ts` 再导出。
- `src/channels/registry.ts`：`initChannels`、`startChannels`、`channelKeyRing`、`channelsHealth`、`channelsMode`、`loadedChannels`、`wecomState`、`channelStartupWarnings`，自测用 `__channelsTest.reset`。db 存储下在一个只读的 repeatable read 快照里读出本租户全部账号，以及启用企微账号没结束的入站与没结果的出站（默认账号连带 `account_id` 为 NULL 的出站行），按 `wecom_kf` 行判 R1 的三种状态。六种拒绝都在「装上」之前判，装上之后才换账号表、切换 env 账号、写删文件、打日志，所以拒绝时不留半装载。每种状态启动时打一行写明是哪一种；在库里时按名字列出被忽略的 `WECOM_*`，不写值。
- `src/boot.ts`：`initSessionStore` 之后 `initChannels`（`ChannelStartupError` 打印 reason 与 detail、`exit(1)`、后面一个都不调）；`startChannels` 代替 `startWecom`，排在任务与跟进扫描器之前。`src/server.ts`：`/healthz` 加 `channels: { mode, accounts, failing, stuck }`（`accounts` 是启用的账号数，env 与库里、企微与网页都算；`failing`、`stuck` 大于 0 时 `ok=false` 的逻辑已写好，数值第 13 步接）。`src/ops/alert.ts` 加告警键 `channel`，本步只推启动时判出的几条（合成一条）。`.env.example` 加 `CHANNEL_SECRETS_KEY`（只有名字与说明）、`FLAG_WEB_CHANNEL` 与网页限流四个变量（注释里写缺省值）。`src/types.ts` 的 `Session` 加可选字段 `channelAccountId`（只有类型，投影与写入是第 7、17 步）。
- 欢迎语（R19）：`checkWelcomeText` 要求非空、第一句（按 `[。！？!?\n]` 切）含区分大小写的「AI」、正文有转人工的说法（`/人工(?!智能)|真人/`，「人工智能」不算）。现在的两段常量都过。启动时不合格按没设处理、warn 一行并进 `channel` 告警；企微的两段与网页的 `welcomeText` 都校验。

**本步定的与临时代码**

- spec 实现期修订（顶部 `Revisions:`）：未导入而 `var/` 有标记也以 `channel_state_in_db` 拒绝；文件存储下有哨兵照未导入处理（记一行并删掉）；`inactiveReason` 只表示不能启用（本阶段只有 `web_channel` 关着的网页账号），欢迎语不合格不写进它。
- db 存储下密钥环格式不对，即使是未导入或已导出也以 `channel_key_invalid` 拒绝；文件存储不解析密钥环。`channel_decrypt` 的 detail 是账号 key、key id 与失败类别（「认证失败」「密钥不存在」），不含密文与明文。
- `accountForSession`：企微按前缀最长匹配，停用的账号也参与（免得停用账号的会话落到默认账号上），调用方再看是否启用；网页会话没有 `channelAccountId` 时返回 undefined（网页没有默认账号）；env 模式下 `accountByKey` 认 `env` 这个 key。
- 网页账号 `title` 缺了用账号名，`dailyNewConversations`、`dailyTurns` 不合法时取 500 / 3000。
- **临时**（第 7 步撤掉）：企微状态在库里时，`src/adapters/wecom.ts` 的 `retireEnvAccount` 让 `readConfig` 一律返回 null（不读 `WECOM_*`、不拉、不写 `wecom-cursor.json`，推送返回 false 并记一行），`/wecom/callback` 的 GET 回 404、POST 回 `success` 不拉，启动日志多一句「库里账号的收发这一版还没接上」。在库里这个状态要到第 14 步的导入之后才会出现，dev 上不受影响。

**自测与门禁**

- `src/channels/channels.selftest.ts` 追加第 6 步一节（PGlite 71 项，有 PG 时 81 项）：三种状态走哪条路；六种拒绝各一例且没有半装载；`channel_decrypt` 的 detail；全部停用照常起、哨兵留着、之后启用一个账号再起被 `channel_restore_pending` 拦住；欢迎语不合格按没设处理；`web_channel` 关着时网页账号的 `inactiveReason`；`accountForSession` 的前缀最长匹配与默认账号；`/healthz` 的 `channels` 只有个数；日志里没有凭据。
- 改了的非锁定断言：`config.selftest.ts`、`store.selftest.ts` 里 boot 的顺序字符串（spec 规定 `startChannels` 先于任务表与跟进扫描器），`ops.selftest.ts` 的 `BootDeps` 字段名。
- 四个门禁全绿；带 `PG_TEST_URL` 全绿（CHANNELS 81、DB 1168、STORE 452、QUOTA 127、WECOM-02 15、OPS 472）；锁定的 `wecom.selftest.ts`（461）与 `server.selftest.ts`（269，`[profile]` 一行不变）照过；`PREFIX sha256` 与第 1 步相同，锁定文件未动。一次性 PG 容器已连同数据卷删掉。

**给后面步骤的注意**

- 第 7 步：账号从 `loadedChannels()` 取（`secrets` 是 `Redacted`，`cursor` 是库里那一列）；撤掉上面三处临时代码，接上 `startChannels` 里的 TODO 与 `Session.channelAccountId` 的投影；停用账号的会话 `accountForSession` 返回那个停用账号，推送要据此返回 false；定 `/wecom/callback/env` 认不认 env 账号。
- 第 10 步：`openInbox`、`openOutbound` 是 `initChannels` 那一刻的快照，只覆盖启用的账号。
- 第 13 步：`channelsHealth()` 的 `failing`、`stuck` 留了 TODO；`/status` 的 `inactiveReason` 从 `loadedAccounts()` 取（含停用的账号）。
- 第 15 步：复用 `checkWelcomeText`、`accountFromRow`、`WEB_CHANNEL_OFF_REASON`、`readChannelAccounts`、`openAccountSecrets`，以及 markers 的 `removeRestoreSentinel`、`writeChannelsMarker`、`removeChannelsMarker`。加密的 AAD 里有账号 id，id 必须在插入之前生成：第 2 步的 `insertChannelAccount` 不收 `id`，要给它加一个可选的 `id`（本步自测是用超级用户 SQL 直接插行绕开的）。
- 第 17 步：`accountByKey(key, 'web')` 只返回启用的网页账号（`active` 且 `web_channel` 开着）；网页会话找账号时要把带 `channelAccountId` 的会话对象传给 `accountForSession`。

### 第 15 步 · 渠道账号管理命令行（2026-10-09）

- `src/cli/channel-account.ts`：`list`、`add-wecom`、`add-web`、`set-secrets`、`set`、`rekey`，用法 `node --import tsx src/cli/channel-account.ts <子命令> --tenant <slug> …`（照 02 的命令行直接跑 TS，没有 `package.json` 脚本先例，不加）。以 `agent_app` 身份运行、取租户锁，退出码照 02（0 / 1 / 2 / 3）。`restore-cutoff` 留了占位，以 1 退出、提示由第 12 步实现。
- 凭据只从无回显终端（Node raw 模式，90 秒超时，退出时恢复终端状态）或 `--secrets-file` 读：同一个 fd 上 `fstat` 校验再读（`O_NOFOLLOW`，拒绝符号链接与非普通文件，权限宽于 0600 或大于 64 KiB 以 1 拒绝）。`add-wecom` 读五项，`set-secrets` 读三项。账号 id 在插入之前生成、用作加密的 AAD（`insertChannelAccount` 加了可选 `id`）；第一个企微账号前缀 `wecom:`，之后 `wecom:<key>:`。
- 拒绝：企微状态「已导出」时加账号 2；`web_channel` 关着时 `add-web` 与启用网页账号 2；欢迎语不过 `checkWelcomeText` 1 且库不变；`set --status exported` 1；`rekey` 有解不开的 2、什么都不动。名称与网页标题沿用账号名称的 1–40 字限制。
- `list` 每个账号一行 JSON：key、kind、name、status、前缀、`inactiveReason`、「凭据已设置」，没有 `corp_id`、`open_kfid`、密文与 key id。审计 `actor_kind` 记 `platform`、`name` 记 `channel-account`，diff 只有账号 key 与改了哪几项的名字。
- 本步定的（spec 实现期修订，顶部 `Revisions:`）：`AUDIT_ACTIONS` 只登记有写入代码的四个渠道动作，`channel.import`、`channel.export`、`channel.restore_cutoff` 留给第 14、12 步登记（审计的一致性检查不许登记没有写入方的动作）；后台 UX spec 的 `AuditQuery.actions` 上限从 32 改为 64（四个动作加进来之后，审计页「全部类别、不显示登录记录」超过 32 个），是对该 spec 一处条款的部分取代，两份 spec 顶部各记一行。
- 自测追加在 `src/channels/channels.selftest.ts`（子进程，PGlite 84 项；有 PG 时 106 项）：各子命令的退出码与拒绝、前缀规则、事务回滚、审计行、`rekey` 之后去掉旧密钥能解；拦截 stdout、stderr 扫凭据明文、密文的 base64 / hex / Buffer JSON、`corp_id`、`open_kfid`，结果为零。改了的非锁定断言：`console.selftest.ts` 的 actions 上限边界（32 / 33 → 64 / 65）、`audit-text.selftest.ts` 的断言名。
- 门禁：四个全绿（console 构建在 Codex 沙箱里 `EPERM`，由 Claude 在沙箱外补跑），`PREFIX sha256` 与第 1 步相同，锁定文件未动。

### 第 7 步 · 按账号拆开的企微运行时与回调路由（2026-10-09）

**结构**

- `src/adapters/wecom.ts` 改成按账号的 `WecomRuntime` 加注册表（按账号 uuid 建键，env 账号在模块加载时登记在 `ENV_ACCOUNT_ID` 下）。每个运行时自己持有：配置的取法、access_token（`Redacted<string>`）与并发去重、缩略图缓存、欢迎语去重表与账号自己的欢迎语、停机截止与 stopping、同步互斥与补拉标志、处理链与 eventTasks、加载与重放、启动恢复状态（`done` / `blocked`）、轮询定时器、会话前缀、日志前缀。留在进程级的只有 `tokenErrorListeners`（回调改成 `(code, accountKey)`）；`onShutdown` 一个钩子收尾所有运行时，exit 钩子逐个 `flushSync`。锁定 `__test`（`resetForTest`、`inspectForTest`、`STATE_FILE`）作用于 env 运行时，清除范围与 02 相同，锁定的 `wecom.selftest.ts` 照过。
- 状态后端接口 `src/adapters/wecom-state.ts`：`FileWecomState`（env 账号，02 的 cursor 文件、handled、在途表、冷启动逐字照搬；重放与 02 的五种去重情况仍在 `wecom.ts`，两种后端共用）；`AccountCursorState`（库里账号的**过渡**后端，第 9 步整个换掉）：每拉一页先推进 cursor，再经 `withTenant(account.tenantId)` 写本账号行的 `channel_accounts.cursor`、`cursor_at`，写完才派发（写库排成链，值没变不发 UPDATE）；handled 与在途表只在内存里。不写 `wecom-cursor.json`、不读 `WECOM_*`（不变量 13）。
- 会话 id 取账号的 `idPrefix`；非默认账号的会话由适配器在调引擎之前建好并带上 `channelAccountId`，默认账号与 env 账号照 02 由引擎建。出站按 `accountForSession` 选账号，停用账号的会话推送返回 false。`conversations.channel_account_id` 的投影接上（`src/store/project.ts` 的 `rowToSession` 以列为准，`src/db/repo/conversations.ts` 预载读它）。库里账号的 `pollIntervalMs` 与欢迎语取账号设置，`PUBLIC_BASE_URL` 仍读 env（不是凭据）。
- 回调 `src/adapters/wecom-callback.ts`：`/wecom/callback/:key` 只认库里启用、凭据已装上的 `wecom_kf` 账号，用它的 Token 与 AESKey 验签解密，`receiveid` 为空或不等于 `corp_id` 不拉；明文里有 `OpenKfId` 就找同一 corp、启用、已装载的企微账号去拉（找不到只记一行），没有就按路由的账号拉，拉的时候带回调明文里的 Token。不带 key 的 `/wecom/callback`：企微状态在库里时给前缀是 `wecom:` 的账号，其余照 02 读 env（501 / 400 / 403 与锁定的 W1 照旧）。POST 一律回 `success`、记一行。`src/server.ts` 只动了回调那一块；撤掉了第 6 步的 `retireEnvAccount`、`callbackInDb` 与启动日志里那句临时说明，`startChannels` 给每个启用的库里企微账号起运行时。

**本步定的（协调者确认）**

- 库里账号的 GET 校验失败（参数不全、验签失败、解密失败、`receiveid` 不对）一律 404，与「不存在的 key」分不出来，不给逐个试 key 的人留信号；原因写进日志。env 账号照 02。
- `/wecom/callback/env` 不认 env 账号（404）：env 账号的线上地址就是不带 key 的那个，导入后 key 会变，再给一个 `/env` 地址会让企微后台配的地址失效。
- 启动恢复闸门：有没结束的入站行或没结果的出站行的库里账号只建运行时、不拉取（回调与轮询都不拉），记一行错误并追加一条启动告警（`channel`），等第 10 步的恢复。库里账号要到第 14 步导入之后才会真正出现，这个过渡不影响 dev 与线上。
- 库里账号的日志前缀是 `[wecom acct=<key>]`（不带冒号，免得被会话 id 脱敏当成 id）；结构化的 `acct` 字段留给第 13 步。新日志里来自请求的签名与时间戳只照抄形状合规的部分，防注入换行。

**已知缺口（后面的步骤补）**

- 第 8 步：库里账号的发送仍走 02 的账本（`account_id` 为空、没有 `pending` / `payload`、卡片记 `card`）。
- 第 9 步：过渡后端在「cursor 已推进、消息没处理完」时退出，这几条重启后不会再拉到；handled 不持久，cursor 写库失败时靠 02 的五种去重兜底；冷启动截止只在没有 cursor 时生效。`channels.selftest.ts` 里「第 7 步之前 GET 404、POST 回 success」「库里账号这一步不起企微」两处注释已过时（断言仍成立），第 9 步顺手改措辞。
- 第 10 步：被闸门挡住的账号靠真正的恢复接上（`startChannels` 留了 TODO）；恢复做完之前 `push` 还没有排队等待。
- 第 13 步：`/healthz` 的 `failing`、`stuck` 仍是 0；`wecom_send` 告警正文还没带账号 key。

**自测与门禁**

- 新建 `src/adapters/wecom-03.selftest.ts`（串在 `wecom-02` 之后；主进程另起 main、restart、prod、rpg 四个子进程）：假企微服务端两个 corp、同一 corp 两个客服账号；三个账号交错收发（三段会话、每段的 `open_kfid` 与 token 都是所属账号的、三个 cursor 各自推进）；一个账号 `gettoken` 一直失败或被停用，另两个照常；回调各自验签、别的账号 Token 签的不拉、按 `OpenKfId` 分派、空 `receiveid` 不拉、不存在 / 网页 / 停用的 key GET 404 与 POST `success`；prod、`LOG_FORMAT=json` 下非默认账号跑一轮，标准输出里搜不到 `external_userid` 与会话原 id（含 `%3A`）。PGlite 61 项，有 PG 时 65 项（`channel_account_id` 投影的写入与预载）。
- 变异：在隔离副本里做了 10 个，新自测抓到 9 个；漏掉的「路由查找去掉 isEnabled」行为不变（停用账号本来就不装凭据）。
- 门禁：四个全绿；带 `PG_TEST_URL` 全绿（WECOM-03 65、CHANNELS 81、DB 1168、STORE 452、QUOTA 127、WECOM-02 15、OPS 472、CONSOLE 435）；锁定的 `wecom.selftest.ts` 461、`server.selftest.ts` 269 照过；`PREFIX sha256` 与第 1 步相同，锁定文件未动。改了的非锁定断言：`console.selftest.ts` 的 `PUBLIC` 白名单企微那一条改成认 `/wecom/callback(/:key)?`。一次性 PG 容器已删。由 Claude 子 agent（Opus）实现，协调者审查。

### 第 17 步 · 网页渠道后端（2026-10-09）

- `src/adapters/web.ts`：`webConversationId`（`web:` + `sha256("<账号 id>:<凭据>")` 前 32 位）；`subscribeWeb` 同步占位判并发（每会话 3 条、每 IP `WEB_SSE_MAX_PER_IP`、全局 `WEB_SSE_MAX_TOTAL`），取消幂等；`webAdapter.push`：人工回复加「【顾问】」，同意菜单发 `menu` 事件（按钮 id 用 `consentMenuButtonId`），客户不在线时正文返回 true（在历史里）、菜单返回 false（引擎按「再问一次」处理）。
- `src/web/routes.ts`（`src/server.ts` 只挂路由与 `adapterFor('web')`）：`webOnly` 先于一切判开关与账号（`web_channel` 关着、账号不是启用的网页账号一律 404），所有响应 `Cache-Control: no-store`、`nosniff`。`/w/:key` 本步是占位文字（页面是第 18 步）。`POST /messages` 要 `x-web-chat: 1`，按 IP 每分钟限流在解析请求体之前；没有自己会话的请求先过「每 IP 每小时新会话」与账号的每日新会话（同步占位），再**由服务端生成**新凭据——格式正确但不对应任何会话的 cookie 不被采用，防固定凭据。`cid` 去重：已有 AI 回复直接返回，处理中 409，「已记、没回复、没转人工」以 `alreadyRecorded` 重跑。`/history` 只投影本会话的客户与 agent 消息（人工回复带前缀），没有 system、画像、成员、会话 id。`/events` 没有自己的会话 401、超并发 429、HEAD 直接 405（不占名额）、每 15 秒 `ping`、30 分钟没有推送就关、慢客户端积压满就关。`/end` 回过期 cookie、会话不删。cookie `__Host-wv`，32 字节随机数的 base64url，`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age` 30 天，每次发消息续期，同名 cookie 不止一个或格式不对当作没有。
- 轮次上限（开放问题 3）：调模型前同步预留、按 trace 核实，确定性回复退回预留。当天账号的轮次用完时，没转人工的会话与「因额度转过人工」的会话记下客户的话、不调模型、回固定的一句；转人工只在第一次（`webTurnLimited` 随会话状态落库，一辈子至多一次）；额度恢复后照常调模型；告警每个账号每天一条。超限路径也走引擎的窗口裁剪（抽成导出的 `trimSessionMessages`，引擎里原位置改调它，逻辑不变）。
- 审查（Claude 审代码，另派一路只读 Codex 做安全评审，两边意见合并后由 Codex 续改一轮）：一、原实现把「因额度转过人工」做成永久降级，额度恢复、顾问交还之后仍只回固定话——改成只在当天额度用完时生效；二、超限路径每条消息都往窗口追加、绕过 400 → 300 的裁剪，持续发能撑大内存（评审 major）——补裁剪；三、`HEAD /events` 被 Hono 当 GET 处理、流不取消，名额要约 4 分钟才释放（评审 minor）——订阅前判方法、回 405。评审看过、判断不是问题的：凭据的随机性与校验、凭据不进 URL / 响应 / 日志、跨账号隔离、两个 POST 的 CSRF 头、限流不能靠丢 cookie 或并发绕过（取 IP 与 `/api/chat` 同一个 `clientKey`）、`cid` 没有双重处理的竞态、SSE 名额在取消 / 断开 / 发送异常时都释放、开关关着时全部 404。
- 自测追加在 `src/web/web.selftest.ts`：验收 14 的后端部分与 prod profile 部分，加上三处审查意见各自的回归断言；`web:` 会话在 db 存储下落库、不受 `sim-` 访客清理影响，线索保留期 7 天时 8 天前的网页会话被清除（PGlite；真实 PG 由 CI 跑）。改了的非锁定断言：`console.selftest.ts` 的 `PUBLIC` 白名单加网页五条（spec「测试与 CI」列明）。
- 门禁：四个全绿（console 构建在 Codex 沙箱里 `EPERM`，由 Claude 在沙箱外补跑），锁定套件 sha256 与 `PREFIX sha256` 与第 1 步相同，`src/server.selftest.ts` 照过（网页模拟器行为不变）。
- 给后面步骤：第 18 步把 `/w/:key` 的占位换成页面、CSP 与注入配置，`webOnly` 与安全头已在。`channelAccountId` 由第 7 步投影进 `conversations.channel_account_id`（本步 rebase 在第 7 步之上，网页会话预载时靠它找回账号）。

### 第 18 步 · 网页页面与 CSP（2026-10-09）

- `public/web.html`、`web.js`、`web.css`（从 `chat.html` 改出来，`chat.html` 逐字节不变）：HTML 里只有两个 `<script>`——`type="application/json"` 的配置块与 `type="module" src="/web.js"`，没有 `<style>`、`style=`、`on*=`；事件一律在 `web.js` 里用监听器挂。标题、欢迎语、消息、按钮一律 `textContent`。
- `src/web/routes.ts` 的 `GET /w/:key`：注入 `{ key, title, welcome, privacyLink, base }`，JSON 里每个 `<` 输出成 `<`，用函数式替换（标题里的 `$` 不会被当成替换模式）；没设 `welcomeText` 时用 `chat.html` 的开场（第一句带 AI 身份）。`Content-Security-Policy` 恰为 `BASE_CSP` 加 `; style-src 'self'; base-uri 'none'; form-action 'self'`，另有 `no-store`、`nosniff`。
- 只认站内链接：`web.js` 的纯函数 `splitSiteLinks` 只把 `/pay/<id>`、`/proposal/<…>`（相对路径，或以注入的 `base` 即 `PUBLIC_BASE_URL` 开头、同源、不带账号密码的绝对地址，点击时用相对路径）换成链接；站外域名、伪协议、协议相对、路径穿越、编码路径都照文字显示。
- 交互：首屏欢迎语与隐私链接；加载时拉 `/history`；发消息带 `x-web-chat: 1` 与 `cid`（`crypto.randomUUID()`，失败重试复用）；SSE 收 `push`（人工回复已带「【顾问】」）与 `menu`（「同意 / 不同意」按钮，点了 `POST { menu }`），断线按 1、2、4、8、16 秒退避重连、封顶 30 秒；「结束咨询」调 `/end` 后清空界面。源码里没有 `localStorage`、`sessionStorage`、`document.cookie`。
- 自测追加在 `src/web/web.selftest.ts`：CSP 全等与安全头；模板里脚本白名单、属性扫描与运行时注入扫描；恶意标题 `</script><img src=x onerror=alert(1)>` 在配置块里没有裸 `<`、`JSON.parse` 读回原串；`splitSiteLinks` 的站内可点与各种站外不可点；不碰凭据存储；`web_channel` 关着时 404。改了一条第 17 步自己的断言：占位页「没有任何 script」改为「没有可执行的内联脚本」（页面现在有配置块与外部脚本）。
- 偏离：本步完成标准里的「本机浏览器里实际打开一次 `/w/<key>` 聊一句、刷新、点『结束咨询』」没在本步做——要在本机起整套 db 存储（角色、迁移、租户、网页账号）才打得开，第 20 步的本机 compose 演练本来就起这一整套，挪到那时做，结果记进「实施记录 · 第 20 步」（第 20 步的步骤里已加这一条）。
- 门禁：四个全绿（console 构建在 Codex 沙箱里 `EPERM`，由 Claude 在沙箱外补跑），锁定文件与 `PREFIX sha256` 与第 1 步相同。Codex 实现，Claude 审查（危险写入点、链接白名单、注入替换方式）。

### 第 8 步 · 出站：先落库后发送（2026-10-09）

**一条 AI 回复的顺序（库里账号）**

1. 引擎写回复并 `saveSession`（照 02）。
2. 适配器：有单条站内链接先取缩略图，再切分 → `planOutbound`：每段一行 `pending`（带 `payload`，`kind` 是这一组的种类，`account_id` 是账号 uuid），排进会话下一次落库的**主事务**（`src/store/pg-backend.ts` 新加的主事务出站队列，写在消息、会话、订单等之后、存档点之前；提交后回调 `outboundCommitted`）。
3. `commitOutbound`：等主事务提交，从 plan 那一刻起至多 5 秒。
4. 每段：先比停机截止（过了就停，这一段与之后的留在 `pending`）；再比接手代次（变了就 `cancelIntents`，`cancelled` 进下一次落库的主事务，会话记「本轮未发送」）。
5. 取 token（卡片段再取缩略图），然后 `markSending`：单独短事务，至多 5 秒，返回 `marked`、`not_pending`、`absent`、`db_unavailable`。
6. 返回之后同步再比一次接手与截止：`marked` 又被接手 → `sending → cancelled`（主事务）；又过了截止 → `sending → pending`（短事务）；都没变 → 不经过任何 `await` 直接发请求。
7. 重试沿用 msgid；超时那一刻 `noteUnknown`；最后 `settleIntent`，结果（`accepted`、`rejected`、`unknown`、attempts、errcode、`payload` 置空）走**存档点**；没有会话的走短事务。「全部有结果 → 入站 `done`」留给第 9 步。

其余几类的 `pending` 落在：人工回复与这条人工消息（以及接手、审计）同一次落库；跟进与记账、任务 `running → sending` 同一次；付款确认与这条确认消息同一次；同意菜单与「问过」那一行同意记录同一次（第 1 步盘点的注意）；不同意之后的确认与 `declined` 那一行同一次；欢迎语有会话的单独一次落库、没有会话的走短事务（`conversation_id` 填将要用的会话 id）；卡片发失败补的段走短事务，段号取这一组最大段号加 1。「同一次落库」在自测里用 xmin 相同断言。env 账号的老路一行没改，内存账本照 02 不改名（`quota.selftest.ts`、`wecom-02.selftest.ts` 断言不改照过）。

**R6 与工作台**

- 照发的情形：`commitOutbound` 超时；`markSending` 返回 `db_unavailable`（库报错、超时、已冲突、停机、租户锁在别人手里）；返回 `absent` 而这一组提交超时过。`absent` 但 `pending` 提交过：不发、记一行错误。决定照发的那一刻计数，`channel` 告警 10 分钟内至多一条（带 `escalate`，免得被启动告警的 30 分钟去重压掉）；`unsafeSendsIn10m()` 留给第 13 步的 `/status`。补写：结果跟着会话落库一起重试；`pending → 结果`、结果行先到时直接插入、晚到的 `pending` 什么都不改，三种都有测试。
- 工作台（`src/shared/conversation-types.ts` 的 `deliveryOfSegments`，内存与库两条路共用）：有段 `pending` / `sending` 显示「发送中」（env 账号还在发的也算），否则按 failed > rejected > unknown > cancelled > accepted 取最重的：accepted 不显示，unknown「可能没送达」，rejected / failed「没送达」，cancelled「未发送」。窗口剩余条数把 `pending`、`sending` 算进已用。`readOutboundForSeqs`、`readOutboundAfterLastCustomer` 放宽到七种状态并带 `account_id`。

**本步定的**

- 跨模块「加进它们那一次落库」的做法：`ChannelAdapter` 加 `prepare` / `release`（`PreparedPush` 句柄），`src/handoff/takeover.ts` 加 prepare 通道；人工回复在同一段同步代码里 prepare，`notifyPaid` 先 prepare 再 push，同意菜单在「问过」那次 `saveSession` 之后 prepare，跟进在 `saveWith(sending)` 之后 prepare、三条放弃的路径 release。网页渠道没有账本，prepare / release 对 `web` 是无操作。
- 接手检查（spec 实现期修订，顶部 `Revisions:`）：通知（`notice`）与人工回复（`human`）只比停机截止、不比接手代次；AI 回复、跟进、同意菜单、欢迎语照旧比接手。
- 卡片：prepare 是同步的，只能看缩略图在不在冷却期；发送时缩略图还是拿不到，卡片段记 `rejected`（attempts 0），再补「标题 + 链接」。取 token 失败这一段记 `rejected`（attempts 0），不进 `wecom_send` 计数（02 是直接丢掉这一行；库里先有 `pending`，必须给它一个结果）。
- `cancelIntents` 多一个原因 `aborted`（跟进放弃、人工回复写库不会再提交、`absent` 但提交过），原因只进日志。
- 5 秒从 plan 那一刻算，人工回复、跟进不叠两个 5 秒；`markSending` 上限也是 5 秒。生成期间被接手、截止之后才回包的也先落 `pending`：前者随后记 `cancelled`（「未发送」），后者留在 `pending`（02 在这两种情况下不记行）。「部分发出、其余取消」也显示「未发送」（不变量 6）。校验没过时会话加一条说明并推告警；一组段数上限 32000（`segment` 是 smallint）。
- `unknown` 的工作台文案从 02 的「结果不明，可能已经送达」改成 spec 映射表的「可能没送达」（验收 17），console 自测里对应的一条断言随之改。

**自测与变异**

- 结果：四个门禁全绿；带 `PG_TEST_URL` 全绿（WECOM-03 133、OUTBOUND 236、QUOTA 127、WECOM-02 15、CHANNELS 106、STORE 452、JOBS 110、DB 1168、CONSOLE 435、OPS 472）；网页自测照过（网页渠道 prepare 返回 null、release 无操作、push 照常，有断言）；锁定文件与 `PREFIX sha256` 与第 1 步相同。一次性 PG 容器已连卷删。由 Claude 子 agent（Opus）实现，协调者审查。接手按种类那条另有断言：prepare 之后有人接手，付款确认与人工回复照发、跟进照旧取消（隔离副本里把它改回恒比接手，两条新断言都失败）。

- 新套件 `src/quota/outbound.selftest.ts`（账本与落库层，PGlite 122 项，有 PG 时共 236 项，串在 `quota.selftest` 之后）；`src/adapters/wecom-03.selftest.ts` 加 `out` / `rout` 两个子进程测适配器的完整顺序（框架可挡借连接、在请求到达时查库、挂住回包）；`src/db/testing.ts` 加 `openGatedDb`（真实 PG 上挡借连接）；console 自测加 6 项（「发送中」「未发送」）。
- 变异（隔离副本）10 个全部被抓到：不比第二次接手、`absent` 一律照发、晚到的 `pending` 盖掉结果、结果写进主事务（plan 要求的四个），加上 pending / cancelled 写进存档点、跳过 `markSending`、截止之后不迁回 `pending`、内存账本不看迁移表、放弃之后 UPDATE 不回滚（PGlite 上存活，补了一条只在真实 PG 跑的行锁测试之后抓到）、人工回复的 prepare 推迟。

**交叉评审与 CI**

- 另派一路只读 Codex 交叉评审，找到 3 处 major，都带复现，由实现的子 agent 修掉、各补一条回归断言（撤回修复时断言失败）：一、退避重试期间收到失败回执、这一段已是 `failed`，重试前只比接手与截止，仍再发一次（违反不变量 5）——`ledger.ts` 加 `maySendAgain`，退避结束、重取 token、强刷 token 之后再请求之前都同步检查，终态就停；二、回执先于消息追加时，`message_seq` 补写被终态条件挡住，工作台按 seq 查不到这段失败——upsert 把「补 seq」与状态迁移分开判（状态、结果、`payload` 只在迁移表允许时改，`message_seq` 只能从 NULL 补成值），账本在回执早于结果、消息还没分到 seq 时等分到 seq 再写一行，迁移表一格没放宽；三、模型等待期间顾问接手、随后模型报错，异常兜底重新读了接手后的代次，「系统开小差」照发——本轮代次在 try 之前取、显式传给兜底。
- CI（UTC）上跟进相关的两条断言没触发：08 点落在跟进的夜间时段（22–9 点）被顺延。PGlite 子进程改为预加载 parity-clock、从当天本地 12:00 起走，真实 PG 子进程用 `FOLLOWUP_QUIET_START/END=0` 关掉夜间时段；在本机用 `TZ=UTC` 复现并确认修好。修后两轮 `pnpm test`（`TZ=UTC`，带与不带 `PG_TEST_URL`）全绿。

**给后面步骤的注意**

- 第 9 步：`planOutbound` 已收 `inboxId` 并写 `inbox_id`，适配器现在都传 null，入站 `replied` 还没写，要在 `planOutbound` 的同一次落库加上；`runGroup` 结束处补「全部有结果 → `done`」（`cancelled` 算不算结果 spec 没写，到时定）；入站 `abandoned` 时调 `cancelIntents(…, 'inbox_abandoned')`。
- 第 10 步：预载的 `pending` / `sending` 会进内存账本、显示「发送中」并计数，但还没有接口把它们变回可发的 intent；第 10 步之前正常停机过了截止或崩溃都会留下这类行，第 7 步的闸门会让这个账号重启后不拉取（库里账号要第 14 步导入之后才有）。人工回复的「10 分钟」可以用 `sent_at`（建 `pending` 的时刻）。
- 第 11 步：poisoned 之后渠道行被丢弃（只计 `channelDropped`），spill 不带渠道行，没有会话的结果短事务只试一次。
- 第 13 步：告警还不带账号 key；`unsafeSendsIn10m` 已有。
- 第 14 步：库里账号的行不会出现 `kind = card`。

### 第 9 步 · 入站：`channel_inbox` 与状态机（2026-10-09）

**一条客户文本从拉取到 `done`（库里账号）**

1. `sync_msg` 拉到一页（不开事务；已在停机就不提交这一页）。
2. 短事务 T1（`acceptPage`）：插入入站行（冲突即跳过，`received`，attempts 0）并推进 `channel_accounts.cursor`，同一个事务；提交之后内存里的 cursor 才推进；失败时不派发、cursor 不动、下一次拉取重来。
3. 按 `ord` 排进这个会话的处理链（内存）。
4. 出队依次判：attempts 已到 3 → `abandoned`（`poison`）；`sent_at` 早于 48 小时 → `abandoned`（`too_old`）；不晚于 `record_only_until` → 只补记；其余走 `beginAttempt`（短事务 T2，attempts 加 1）。
5. `handleMessage(…, { inboxId })`：客户消息、会话行与 `recorded`（`message_seq` 等于这条消息的 seq）在同一次会话落库的主事务里（引擎的重置分支与正常分支都在 `saveSession` 之后的同一段同步代码里排）。
6. 静默 → 下一次落库记 `done`；有回复 → `planOutbound(inboxId)`：每段的 `pending` 与 `replied` 在同一次落库主事务（`pending` 在前）。
7. 每段 `markSending` → `send_msg` → 结果走存档点（第 8 步）。
8. `runGroup` 结束：全部分段有了结果（被接手打断的 `cancelled` 也算）→ `done`；停机截止时还停在 `pending` → 入站留在 `replied`，交给第 10 步；计划校验没过、或处理时抛错（异常兜底，比较的是本轮开始时的接手代次）→ `done`。

其余几种：非文本——占位与 `recorded` 同一次落库，已转人工 → `done`，否则引导提示带 `inboxId` 走 `planOutbound`（同一次落库里先 `recorded` 再 `replied`）。菜单点击——同意记录与 `done` 同一个事务；没有隐私说明、认不出按钮、没有会话、这个类别已有同样结论 → `done`；「不同意」的确认是 notice，不挂入站。进入会话——T1 里直接插成 `done`（冷启动早于截止的插成 `abandoned` / `cold_start`），只有新插入的才发欢迎语。

**结构**

- `src/channels/inbox.ts`（新）：`PgInbox` 接口与 `AccountInbox`（`load`、`acceptPage`、`beginAttempt`）、`inboxKindOf`、`InboxWriteError`（只带错误码）、`InboxRowGone`、`onInboxAbandoned` 事件出口。`src/adapters/wecom.ts`：库里账号自己的拉取（`drainInbox`）、派发（`dispatchInboxRows`）、出队判定（`processInboxRow`）与四种入站；env 路径行为不变。删掉第 7 步的过渡后端 `AccountCursorState`。
- `src/store/pg-backend.ts`：`Entry` / `Snap` 加 `inbox`，主事务里在出站 `pending` / `cancelled` 之后、存档点之前写入站状态（`applyInboxStates` 按先后逐条按迁移表写）；`queueInbox`（poisoned 时丢弃、计 `inboxDropped`）、`writeInboxNow`、`channelTx`（与 `jobsTx` 同一套拒写规则）；`markOutboundFailed` 可带 `inboxId`，同一个事务里把回执行记 `done`。`src/store.ts`：`queueInboxState`（同步校验；`recorded` 取消息当时的 seq；内存里没有这个会话时改走短事务）、`writeInboxStateNow`（返回 `Promise<boolean>`）、`withChannelTx`。`src/db/repo/channel-inbox.ts` 的 `InboxStateWrite` 只含 JSON 值（第 11 步的 spill 可以直接用）。
- `src/quota/ledger.ts`：`planOutbound` 在 `pending` 的同一次落库排 `replied`；`cancelInboxIntents`、`onSendFailInbox`。`src/ops/alert.ts`：`channel` 告警加 `poison`、`too_old`（每种原因每个账号 10 分钟至多一条，带条数）。

**本步定的（协调者确认）**

- 发送失败回执（spec 实现期修订，顶部 `Revisions:`）：不进处理链、不计次、不判 `poison` / `too_old`，照 02 马上处理——出站行改 `failed` 与入站行记 `done` 在同一个短事务（重试一次）。否则第 8 步的「重试前看到 `failed` 就停」赶不上：回执排在正在退避的那一句后面，这一段会再发一次。payload 只存 `fail_msgid` 与 `fail_type`；重复的回执不再给会话加说明。
- 冷启动对四种入站都记 `abandoned`（`cold_start`），照 spec 字面（02 的回执与菜单点击不受冷启动影响；冷启动只在全新账号第一次拉取时发生）。
- `beginAttempt` 写不进库时这一行在处理链里按 1 / 5 / 30 / 120 秒退避重试、停机时放下，不跳过（跳过会让同一会话后面的话先处理，违反不变量 12）。
- 处理时抛错按 02 算处理完（道歉 + `done`）；计划校验没过也记 `done`。`poison` / `too_old` 的说明与告警只对客户消息与菜单点击；回执只记 `abandoned` 与一行日志；没有会话的不建会话。
- `acceptPage`：存不进库的条目（msgid 或 `external_userid` 为空、带 NUL、msgid 超过 128 字节、回执没有 `fail_msgid`）记一行、不写入，免得整页永远提交不了；payload 里的字符串先过 `cleanText`；同一页重复的 msgid 只插一次；没有新行、cursor 也没变时不开事务。
- 恢复截止点之前的入站只补记、不计次，同一会话一次恢复只加一条说明。第 7 步的启动闸门保持原样（有没结束的入站或出站行就只建运行时、不拉取），`load` 读到没结束的行也会兜底挡住。
- 顺手：`channels.selftest.ts` 里两处第 7 步之前的过时注释改了措辞；`wecom-03.selftest.ts` 一条非锁定断言从 `account_cursor` 改为 `channel_inbox`。

**自测与变异**

- `src/adapters/wecom-03.selftest.ts` 加 `in`（PGlite）与 `rin`（真实 PG）两个子进程：用超级用户建的 SECURITY DEFINER 测试触发器记每次写入所在事务的 txid（入站行、消息、出站行、同意记录、cursor），并能让「插入入站」或「推进 cursor」在提交前失败。覆盖一页的提交与回滚、`ord` 顺序、状态机每一格、出队计次（第一句处理途中失败：第二句 attempts 1、第一句 2；队尾不被连累）、`poison`、`too_old`、恢复截止点、四种入站、各处「同一事务」。
- 变异（隔离副本）16 个全部被抓到，含 plan 要求的三个（插入就计次、`recorded` 不和消息同一事务、cursor 先于插入提交），另有派发就计次、`replied` 不和 `pending` 同一次落库、停机截止也记 `done`、内存 cursor 先于提交推进、`poison` 阈值差一、不判恢复截止点、菜单 / 回执的 `done` 拆开、不判 `too_old`、非文本 `recorded` 推到下一拍、去掉同步校验、回执排进处理链、异常兜底用当下的接手代次。
- 门禁：四个全绿；带 `PG_TEST_URL` 全绿（WECOM-03 217、CHANNELS 106、DB 1168、STORE 452、OUTBOUND 246、QUOTA 127、WECOM-02 15）；`TZ=UTC` 下 wecom-03 PGlite 137 项、真实 PG 217 项都过；锁定文件与 `PREFIX sha256` 与第 1 步相同。由 Claude 子 agent（Opus）实现，协调者审查。

**交叉评审与 CI**

- 另派一路只读 Codex 交叉评审，找到 3 处 major（故障注入下的边角路径），由实现的子 agent 修掉、各补一条回归断言（撤回修复时断言失败）：一、出站 `pending` 还没提交时收到失败回执，回执先把入站记 `done`，之后 `pending` 才落库，库里停在 `pending`、内存是 `failed`，重启可能补发已失败的段——本进程计划过的段，回执短事务按迁移表 upsert 整行 `failed`（没有就插入，有 `pending` 就迁），同一事务记回执行 `done`；未提交的 `pending` 会让这次插入等锁，之后晚到的 `pending` 与结果都改不了 `failed`；带入站的回执改成 1、5、30 秒重试三次，都失败时回执行留在 `received` 交给重启恢复。二、停机时队头计次失败被放下，同一会话的队尾照样出队——队头因停机放下时停下这个会话的处理链（`haltedChains`），整段按 `ord` 留给重启恢复。三、计次事务实际提交而回包丢失，重试又加一次——`bumpInboxAttempts` 带出队时读到的 attempts 做条件更新，没改到而库里已更大就读回、不再加。
- CI 上「重启后 cursor 从库里接着拉」读到空 cursor：`load` 改成异步读库后，读完之前运行时也算空闲，断言比 cursor 读回早——改为先等第一次 `sync_msg` 真的发出、再等空闲。
- 修后：`TZ=UTC` 加 `PG_TEST_URL` 的 `pnpm test` 全绿（WECOM-03 223、OUTBOUND 246、QUOTA 127、CHANNELS 106、DB 1168、STORE 452），PGlite 下 WECOM-03 140。

**给后面步骤的注意**

- 第 10 步：入口是 `startWecomAccount({ pull: false })`（`recovery = 'blocked'`）。恢复流程：先处理 `openOutbound`，再用 `dispatchInboxRows` 按 `ord` 派发没结束的入站，在 `processInboxRow` 里补上 `recorded` / `replied` 两种状态与保底（`received` 那一支已经能用，`__wecomTest.dispatchOpen` 是它的自测版本），最后把 recovery 改成 done 并 `startRuntime`。账本预载的出站行不带 inboxId、payload、segment，`cancelInboxIntents` 看不到它们，要用 `openOutbound`。回执重启后只需重做那个短事务。已知缺口：`acceptPage` 的 COMMIT 回包丢了时，这几行在本进程里不会派发，要等重启恢复。
- 第 11 步：poisoned 会话的入站状态改走短事务，在 `queueInbox` 的 poisoned 分支接上（可复用 `writeInboxNow`）；spill 条目带 `entry.inbox` 与 `inflight.inbox`。
- 第 12 步：运行时在 `load` 时读 `record_only_until`，设了要重启才生效（命令本来就要求应用已停）；「N 个会话只补记」那条告警没做，`onInboxAbandoned` 会发 `restore_cutoff` 事件，可以接上。
- 第 13 步：`poison` / `too_old` 告警已有；`stuck`、`oldestOpenInboxSec` 要查 `channel_inbox`。
- 第 14 步：导入的 `legacy` 行没有 `conversation_id`，派发时按 msgid 排队；有 `received` 的 `legacy` 行现在会走「不认识的种类 → `done`」，导入时要按 spec 处理在途的那几条。

### 第 11 步 · spill 与 poisoned 会话的渠道行（2026-10-09）

**spill 新格式**

- 外壳仍是 `version: 1`，版本标记放在条目上：第 11 步写出的条目与它的 `inflight` 总带 `channel: { inbox: InboxStateWrite[]; outbound: SpillOutboundRow[] }`（空的也带），没有这一段的就是旧版、按空处理。不升外壳版本是被逼的：锁定之外的 `store.selftest.ts` 断言「version 2 是不认识的版本 → 改名 `.failed`」，旧进程读到 version 2 也会把整个文件连会话部分一起丢掉。
- `SpillOutboundRow` 就是 `OutboundWriteRow`（`sentAt` 存毫秒）；主事务的行（`pending`、`cancelled`）在前，库里账号的结果在后。`inflight.channel` 是在途快照里的渠道行与结果，`channel` 是 poisoned 之后等短事务的（在途那一批在前）加上排着的。trace、护栏事件、env 账号（02）的账本行照旧不写。

**事务边界**

- 写出：时机不变（exit 钩子里的 `spillSync`），条目的选取是「脏的」或「poisoned 队列里还有行」。
- 回放成功时：渠道段与会话部分在同一个 `withTenant` 事务里，位置在附带行之后——出站主事务行 → 入站状态 → 结果（结果放在存档点 `channel_results` 里，坏的结果行不连累会话）。flush_id 判定沿用 02：库里的 flush_id 是这一条的就跳过（渠道段已随会话写过）；在途那次其实提交了就只写排着的；其余在途的和排着的都写、在途的在前；「内容一致而跳过」那一支也照写渠道段（重复写无害，迁移表兜住）。
- 会话部分回放失败（数据类错误）：先用 `replayChannelOnly` 单独开一个事务，锁会话行、套同一套 flush_id 判定、写渠道部分，再照 02 把文件改名 `.failed`；这个事务遇到连接类错误以 `db_unreachable` 拒绝启动、文件留着。
- poisoned 之后：每个会话一个短事务队列、每批一个短事务、同一时间至多一个在途（`nowTx`，`writeInboxNow` / `writeOutboundNow` 改用它）。来源：标 poisoned 时排着的行、以数据类错误失败的那次快照里的行（放队头）、之后的 `queueChannel` / `queueInbox`、`queueTelemetry` 里库里账号的结果。起短事务推迟一个 microtask，同一段同步代码排进来的行进同一个事务（`planOutbound` 的 `pending` 与 `replied` 同一次提交）；在途或等着重试的那次落库还活着时短事务先等它（不让后来的 `replied` 先到、被迁移表当成表外丢掉）；提交后经 `outboundCommitted` 报回，`commitOutbound`、`markSending` 照常。连接类失败或这次不写：放回队头、每秒再试（日志每次失败一行），停机或冲突之后不再试、exit 时进 spill，drain 段立刻再试一次。

**本步定的（协调者确认）**

- poisoned 短事务遇到数据类错误就丢掉这一批，计 `channelDropped` / `inboxDropped`、记一行日志，不每秒重试（重试也写不进去）；会话本身照 02 有 poisoned 告警。spec 写的「写不进去时留在内存、1 秒后再试」只用在连接类错误与「这次不写」上。
- 失败的那次快照里、以及标 poisoned 时排着的渠道行也走短事务（spec 只写了「它之后」的，不这样这些行会丢）。
- 已知边界：spill 里有一行坏的主事务渠道行时整条会话回放失败，与实时落库的语义一致（同一事务会把会话标 poisoned）；R21 的同步校验让这种情况只剩代码缺陷一种来源。
- 顺带的口径变化：poisoned 时一批只含库里账号结果的遥测不再计 `telemetryDropped`；`queuedChannel` / `queuedInbox` 把 poisoned 队列也算进去。

**自测与变异**

- 新套件 `src/store/spill-channel.selftest.ts`（串在 `store.selftest.ts` 之后；PGlite 55 项，带 PG 共 110 项，真实 PG 上「库连接断开」是真断开）：验收 8 的 spill 回放（入站行已提交、会话落库失败、停机写出 spill、恢复后回放：渠道行在、状态对上、客户消息只记一次）、poisoned 之后两句的渠道行经短事务落库、旧版 spill 照常回放，另加会话部分回放失败时渠道部分单独写。「poisoned 之后 SIGKILL、重启后由 `payload` 补记、不再回复」那一半交给第 10 步的恢复自测。
- 变异（隔离副本）13 个全部被抓到，含 plan 要求的四个（渠道段不进 spill、回放时与会话分两个事务、poisoned 之后渠道行仍丢弃、旧版 spill 回放报错），另有会话失败时渠道部分不单独写、短事务不等在途落库、`pending` 与 `replied` 分两个短事务（第一轮存活，测试改成先等 `recorded` 落库再回复后抓到）、短事务写不进去就丢、提交后不报 `outboundCommitted`、回放不沿用 flush_id 判定、spill 不带 poisoned 队列、poisoned 之后结果仍丢、spill 不带在途快照的渠道行。
- 门禁：四个全绿；带 `PG_TEST_URL` 全绿（STORE 452、SPILL-CHANNEL 110、OUTBOUND 246、WECOM-03 223、DB 1168、QUOTA 127、WECOM-02 15、CHANNELS 106、JOBS 110、OPS 472、CONSOLE 435）；`TZ=UTC` 加 PG 也过；`store.selftest.ts` 断言未改照过；锁定文件与 `PREFIX sha256` 与第 1 步相同。由 Claude 子 agent（Opus）实现，协调者审查。

**交叉评审**

- 另派一路只读 Codex 交叉评审，找到 1 处 major：会话部分回放失败、渠道段单独写进去时，以及「内容一致而跳过」那一支照写渠道段时，库已改而内存账本的预载没重新读（预载在回放之前、只有 `applied` 非零才重读），工作台一直「发送中」、已取消的段还占发送额度。修法：回放结果多报「这一条写过非空渠道段」（`channelWritten`），`applied || channelWritten` 就重新预载；补两条回归断言（两个租户各回放一次，每一支都必须自己触发重读）。修后带 `PG_TEST_URL` 与 `TZ=UTC` 全绿（SPILL-CHANNEL 114）。

**给后面步骤的注意**

- 第 10 步：回放在 `initSessionStore` 里、早于 `initChannels`，恢复看到的是回放之后的状态。单独写渠道部分之后、或 poisoned 短事务之后，入站行可能是 `recorded` / `replied` / `done` 而 `message_seq` 在 `messages` 里不存在，出站行的 `message_seq` 也可能指向不存在的消息——保底第三条（用 `payload` 补进会话）必不可少；会话行根本不在库里的 poisoned 会话补进会话时会再次 poisoned，恢复不能因此打转。`recorded` 的短事务早于 `pending` + `replied` 那一个，`recorded` 那次以数据类错误丢掉时会出现「`received` 但名下有出站行」，由保底第二条处理。
- 第 12 步：`restore-cutoff` 先于应用启动跑，spill 回放在它之后，可能插入 `sent_at` 不晚于截止点的 `pending` 行；出站恢复表「`pending`、`sent_at` 不晚于截止点 → `cancelled`」兜住。
- 第 14 步：`channel-export` / `channel-import` 在 `var/` 里有 spill 文件时应拒绝（照 02 `erase-conversation` 的做法），否则回放会在导出之后再往 `outbound_sends` / `channel_inbox` 写行。

### 第 10 步 · 启动恢复与崩溃点（2026-10-09）

**结构**

- `src/channels/recovery-rules.ts`（新，纯模块，`check-boundaries` 登记为纯）：出站恢复表、保底三条、入站恢复表（`recorded`、`replied`）、`RESEND_UNKNOWN = false`、人工回复的 10 分钟常量。`src/channels/recovery.ts`：出站恢复的逐行执行（`recoverOutbound`）、`RecoveryGate`（`push` 等恢复）、`RESEND_UNKNOWN` 的生效值与 `__channelTest`（子进程里设）。`src/quota/ledger.ts` 加 `adoptOpenOutbound`（把库里的 `pending`、`sending` 收进内存账本，补上 payload、段号、inbox_id）、`recoverAsUnknown`、`pendingIntentsOfInbox`；`src/db/repo/outbound.ts` 加 `readOutboundOfInboxes`；`src/channels/inbox.ts` 加 `loadForRecovery`（保底要的「名下有没有出站行」与 load 同一个短事务）。
- 启动顺序（`startChannels` → 适配器的 `runRecovery`）：每个库里启用的企微账号起运行时、`recovery = 'recovering'`、gate 关着 → 出站恢复（`initChannels` 读到的 `openOutbound`，按建行时刻与段号逐行判，补发逐段等完）→ `loadForRecovery` → 没结束的入站按 `ord` 派发进各自会话的处理链 → 派发完就 `recovery = done`、开 gate、开始拉取。读库失败按 1 / 5 / 30 / 120 秒退避，停机时放下；出站恢复中途出错只记日志、入站恢复照做。撤掉了第 7、9 步「有没结束行就不拉取」的闸门。

**出站恢复表**（自上而下第一行命中）

| 出站行                                     | 处理                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 指着它的失败回执还停在 `received`          | 不动，入站恢复重做回执、迁 `failed`                                                                                                                                                               |
| `sending`                                  | `RESEND_UNKNOWN` 为假：记 `unknown`、不补发、进启动告警；为真：保持 `sending` 按同一 msgid 补发，但会话有接手人时 AI 类段（`ai`、`followup`、`menu`、`welcome`）记 `unknown`、不补发（不变量 10） |
| `pending`，`sent_at` 不晚于恢复截止点      | `cancelled`                                                                                                                                                                                       |
| `pending`，有 inbox_id、入站没结束         | 留给入站恢复                                                                                                                                                                                      |
| `pending`，有 inbox_id、入站已结束或已清理 | `cancelled`                                                                                                                                                                                       |
| `followup`                                 | `cancelled`                                                                                                                                                                                       |
| `notice`                                   | 同一 msgid 补发                                                                                                                                                                                   |
| `human`                                    | 10 分钟内（含正好 10 分钟）且接手人没变才补发，否则 `cancelled`（工作台「未发送」）                                                                                                               |
| `menu`、`welcome`、没有 inbox_id 的 `ai`   | `cancelled`                                                                                                                                                                                       |
| `card`（env 账号与 02 的旧行）             | `cancelled`，记一行日志                                                                                                                                                                           |

库里的 payload 不合格时：`pending` 记 `cancelled`，`sending` 记 `unknown`。

**入站恢复**（在 `processInboxRow` 里，出队照常判 halted、poison、too_old、截止点，然后计次）：保底三条（`effectiveInboxState`）——`received` 而名下已有出站行按 `replied`；`received` 而会话里已有这句按 `recorded`（同一次落库补记 `recorded`）；`recorded` 而会话里找不到这句，先用 payload 补进会话再按 `recorded`。`recorded`：这句之后有 AI 回复就按那条回复切分段照常发、不调模型（会话有接手人时排进去随即取消，记「本轮未发送」）；没有回复、已转人工 → `done`；没有回复、没转人工 → 以 `alreadyRecorded` 重跑（非文本只补发引导提示）；这句只在 7 天集合里、已不在会话窗口 → `done`（02 去重情况 2）。`replied`：有接手人就把名下 `pending` 的段 `cancelled`、记「本轮未发送」、`done`；否则同一 msgid 补发，都有结果后 `done`。菜单点击与回执沿用第 9 步的路径，重做幂等。

**`push` 等恢复**：恢复做完之前，库里账号的 `push`（人工回复、跟进、通知）在 gate 上等，至多 30 秒（spec 原值）；超时返回 false，并把已 prepare 的 `pending` 段记 `cancelled`——跟进按「明确失败」处理、人工回复记「未能发送」、工作台「未发送」。回调在恢复期间不拉取，做完后第一拍补拉。

**本步定的（协调者确认，spec 实现期修订，顶部 `Revisions:`）**

- 「恢复做完」取「派发完」，不等入站行处理完：处理链按会话串行，同一客户的新消息照样排在后面（不变量 12）；等处理完的话一次慢的模型调用会卡住整个账号的拉取。
- 出站恢复表前多一行：指着它的失败回执还停在 `received`（第 9 步评审之后才会出现的情形）时，这一段不补发、交给入站恢复重做回执（守不变量 5）。
- `recorded`、这句之后已有 AI 回复、会话有接手人：把分段排进去随即取消（不变量 10，与 `replied` 那一行同一口径）。
- `RESEND_UNKNOWN` 为真时，有接手人的会话里还在 `sending` 的 AI 类段不补发、记 `unknown`（不变量 10）。
- 「接手人没变」：这条人工消息的 authorId 等于当前接手人的 userId（共享工作台的 null 等于 null，与 `takeover.ts` 的 `isMine` 同一口径）；会话交还了、或找不到这条消息都算变了。
- 小缺口：恢复补发的非文本引导提示发成功后不补写进会话（02 是发成功后才写）；恢复时卡片发失败补的「标题 + 链接」段号取那一段加 1，极端情况下可能与同组已有段号重复（段号没有唯一约束，不影响正确性）。`sending` 转 `unknown` 的告警并进启动告警（每个账号一句、带段数），没有单独 escalate。

**自测与变异**

- 新套件 `src/channels/recovery.selftest.ts`（串在 `wecom-03` 之后；`src/db/testing.ts` 加 `connectSuperQuery` 给子进程连同一个一次性库）：纯函数的恢复表每一格（352 项），真实 PG 加子进程 SIGKILL（共 426 项）。验收 4 的全部杀点（模型生成途中、回复已落库而第一段没开始、两段发完第一段、请求已到而回包挂住、`markSending` 之后请求没到，以及 `RESEND_UNKNOWN` 为真重跑后两种）、验收 7 的 A 与 B（都至多多一组、各有告警）、验收 18 的每一种出站行与恢复做完之前到期的跟进、验收 20 的重启部分、验收 3 的「一页 3 条提交之后立刻杀」、验收 9 的「毒消息连杀三次：第三次重启时 `poison`、说明与告警各一条、同一客户的第二句 attempts 不被累加」，另加失败回执停在 `received`、接手后的 `replied`、`recorded` 已有回复、`received` 已有出站行、`RESEND_UNKNOWN` 为真加有接手人。重启之后库里没有没结果的出站与没结束的入站（不变量 15）；跑完 `ps` 里没有残留子进程。
- 变异（隔离副本，真实 PG）20 个全部被抓到，含 plan 要求的三个（`sending` 重启后照发、有接手人仍补发、人工回复不看 10 分钟——规则层与调用处各一个），另有不看接手人、跟进补发、`push` 不等、gate 先开、保底不看出站行、`recorded` 有回复也重调模型、不看失败回执、`sending` 段也 `markSending`、不报 `unknown`、入站已结束照发、不看截止点、不派发入站、`replied` 补发后不记 `done`、出站补发不等完。
- 门禁：四个全绿；带 `PG_TEST_URL` 且 `TZ=UTC` 全绿（RECOVERY 426、WECOM-03 223、CHANNELS 106、QUOTA 127、OUTBOUND 246、DB 1168、STORE 452、JOBS 110、OPS 472、WECOM 461、WECOM-02 15，mock eval 两遍 19/19）；锁定文件与 `PREFIX sha256` 与第 1 步相同。由 Claude 子 agent（Opus）实现，协调者审查。

**交叉评审**

- 另派一路只读 Codex 交叉评审，找到 3 处 major，由实现的子 agent 修掉、各补回归断言（撤回修复时失败）：一、恢复补发卡片又失败时新建了一段降级补文（新 msgid），原有的补文也照发——补文的 msgid 改由卡片段的 msgid 加块号算出（`fallbackMsgid`），`planRuntimeSegment` 按它复用已有行、已有结果就不再发；二、`alreadySending` 让补发的 AI 段不再比接手，恢复期间才有的接手挡不住发送——它只用来跳过 `markSending`，AI 段照常比接手（代次取恢复判定那一刻），接手时历史 `sending` 段记 `unknown`、其余 `cancelled`；三、恢复补发的人工回复只在判定时查一次接手人，等 token 或 `markSending` 期间被交还、改派或过了 10 分钟仍会发——加 `stillEligible`，每次真正发请求前复核（10 分钟内且接手人仍是作者），不符合就 `cancelled`；普通人工发送照第 8 步不比接手。第三处在缺省配置下就会发生，前两处只在 `RESEND_UNKNOWN` 为真时。
- 顺带修了第 8 步的一处：`readOutboundForSeqs` 没有 ORDER BY，同一条消息两段都 `failed` 时原因码取决于库返回的行序，`outbound.selftest` 偶发失败；加了按消息 seq、段号排序。
- 修后带 `PG_TEST_URL` 且 `TZ=UTC` 全绿（RECOVERY 431）。rebase 到含第 11 步的 dev 之后由 CI 再验。

**给后面步骤的注意**

- 第 12 步：出站恢复的截止点读 `initChannels` 快照里的 `account.wecom.recordOnlyUntil`，入站读 `load` 的；`restore-cutoff` 用 `transitionOutbound(…, 'recover')`；「N 个会话只补记」的告警还没做。
- 第 13 步：「`sending` 转 `unknown`」并在启动检查那一条里，正文受 `safeText` 300 字截断，账号多时会截掉，可能要拆成单独一条；`recovery` 状态现在只在 `__wecomTest.inspect` 里看得到，恢复卡住（读库一直失败）时 `/healthz` 的 `stuck` 与 `/status` 要反映出来；`unsafeSendsIn10m`、`staleOutbound` 没动。
- 第 14 步：`legacy` 行仍走「不认识的种类 → `done`」；导入的在途行按 `received` 进入恢复，保底会查会话里有没有这句、名下有没有出站行；导出前的拒绝判断可以用 `adoptOpenOutbound` 那套数据形状。

### 第 14 步 · 导入、导出与 `--resync`（2026-10-09）

- 分工偏离：plan 原写由 Claude 做；当时已有两路 Claude 子 agent 在并行（第 10、11 步），为省 Claude 周额度改派 Codex，协调者审查并另派一路只读交叉评审。
- 文件：`src/cli/channel-import.ts`、`src/cli/channel-export.ts`（命令入口）与 `src/cli/channel-transfer.ts`（校验、事务、合并、审计、文件操作）；`src/db/repo/channel-inbox.ts` 加账号入站读取与没结束行的 payload / attempts 替换；`src/db/repo/outbound.ts` 加部分送达的检查；`AUDIT_ACTIONS` 登记 `channel.import`、`channel.export`。都以 `agent_app` 身份、取租户锁，开事务之前先验 `--keep` 在 `var/` 之外且可写。
- 首次导入：一个事务里建加密账号、写 cursor、`handled` 与 `pending` 按 msgid 合并且在途优先、按客户队头计次（第一条 `tries + 1`、其余 `tries`）、按在途表顺序插使 `ord` 递增、只在 `handled` 里的插 `legacy` / `done`、审计一行只有条数 → 提交 → 原文件原样备份进 `--keep`（每次一个独立子目录）→ 写标记 → 删原文件并 fsync 目录。提交后文件阶段失败时提示「数据库已提交」，用原参数重跑能补完。省略 `--name` 时用账号 key。
- `--resync`：一个事务里换 cursor、补插在途与只在 `handled` 里的、替换没结束行的 payload 与 attempts（已有的状态、seq、`ord` 保留，终态不动）、库里没结束而文件里没有的记 `abandoned`（`resync`）、默认账号回到 `active`、审计 → 提交 → 备份 → 写标记 → 删原文件。
- 导出：事务里先做全部拒绝检查、构造 02 格式（`handled` 是默认账号 3 天内最新 5000 条，`pending` 是没结束的 `message` 行按 `ord`、`tries = max(attempts − 1, 0)`）→ `var/` 里已有同名文件先备份进 `--keep` → 同一事务 `sending → unknown`、整条还是 `pending` 的段 `→ cancelled`（迁移表，写入方 `recover`）、默认账号 `exported`、审计 → 提交 → 原子写状态文件并 fsync → 删标记。已导出过（`exported`、无标记、文件在）当无操作返回 0，不覆盖 02 运行期间的新文件。
- 退出码：0 成功、重复执行无操作、补完文件阶段或 `--dry-run`；1 参数、必需配置、JSON、路径或读写错误（含 `--keep` 在 `var/` 内或不可写、spill 目录读不了）；2 状态对不上（需要 `--resync`、账号 / 标记 / env 标识不一致、导出的七种拒绝、有没回放的 spill）；3 租户锁被占或丢失。
- spec 实现期修订（顶部 `Revisions:`）：导出多拒绝两种（默认账号有没结束的非 `message` 入站；没结束的非文本消息名下已有出站行），导入导出在有 spill 时拒绝且取锁后复查。
- 交叉评审：另派一路只读 Codex 评审找到 3 处 major（导出漏掉没处理完的菜单点击与回执；非文本消息的引导提示可能已发、02 重放会再发；spill 检查读目录出错被吞、取锁前的间隙也没复查），即上面那条修订，由 Codex 续改、各补回归断言（撤回修复时失败）。实现第一轮之后另按第 11 步的提醒补了「有 spill 就拒绝」。
- 自测追加在 `src/channels/channels.selftest.ts`（子进程，PGlite；有 `PG_TEST_URL` 时另跑真实 PG）：验收 13 的导入、导出、`--resync` 与 `--dry-run`，往返一致性，各种拒绝的零变更断言，启动侧的两种拒绝能被本步写出的文件与标记触发，凭据与标识扫描为零。门禁：四个全绿（console 构建在 Codex 沙箱里 `EPERM`，由 Claude 在沙箱外补跑，`TZ=UTC`）；锁定文件与 `PREFIX sha256` 与第 1 步相同。

### 第 13 步 · 可观测性（2026-10-09）

- `/healthz` 的 `channels`：`failing` 是启用企微账号里拉取或取 token 失败持续至少 10 分钟的个数（成功一次就清掉计时）；`stuck` 是启动超过 1 分钟之后、有没结束的入站行超过 5 分钟或启动恢复持续超过 5 分钟的账号数（同一账号只计一次）。任一大于 0 时 `ok = false`；只有个数。
- `/healthz` 不碰库（Claude 审查时改的）：Codex 的第一版每次请求都 `await` 一次库查询，库慢或连不上时 `/healthz` 跟着卡，deploy.sh 的健康检查与外部拨测会被拖住。改成渠道启动后立即刷新一次统计、之后每 30 秒后台刷新（定时器 `unref`，停机清除），每次查询至多等 5 秒，失败或超时保留上一次的值、迟到的结果不覆盖、不叠加查询；统计太旧也不会把 `stuck` 清零；成员的 `/status` 同样有界等待。
- console `/status` 给成员多带每个账号的 11 个字段：`key`、`kind`、`status`、`inactiveReason` 取装载结果；`lastSyncAt`、`lastErrorCode` 取运行时（恢复中、没有别的错误时是 `recovering`）；`openInbox`、`oldestOpenInboxSec`、`staleOutbound`（`pending` / `sending` 超过 2 分钟）、`unknownSends24h` 查库；`cursorAgeSec` 取 `cursor_at`。按租户、按账号读，`account_id` 为空的旧出站归默认账号。匿名响应不带这些。
- 告警（键 `channel`，正文只有账号 key、计数与错误码）：拉取失败（10 分钟条件，每账号 30 分钟去重，恢复发一条）；卡住（同上）；重启时 `sending` 转 `unknown` 从启动检查那一条拆出来、按账号单独发；网页账号因 `web_channel` 关着未启用沿用启动检查。`wecom_send` 正文带账号 key。原有 R6、`poison` / `too_old` 的频率规则与全局限流照旧。
- 日志：轮次与拉取的 JSON 日志行多带 `acct`；企微接口异常收敛为安全错误码，不记请求地址。
- 自测追加在 `src/ops/ops.selftest.ts`（只追加）：可控时钟下卡住 6 分钟（`stuck = 1`、`ok = false`、告警一条、`oldestOpenInboxSec > 300`，验收 23）、单账号 `gettoken` 一直失败（告警一条、`failing = 1`、另一账号不受影响，验收 10 的告警部分）、恢复与去重、计数、成员鉴权、各条告警里没有凭据与客户标识、库挂住时 `/healthz` 100 毫秒内返回且没借连接、统计过旧保留旧值。`recovery.selftest.ts` 的重启告警断言随按账号单独发送调整，`overview.selftest.tsx` 的状态样例补 `channels` 字段。
- 门禁：四个全绿（`TZ=UTC`，console 构建在 Codex 沙箱里 `EPERM`，由 Claude 在沙箱外补跑），锁定文件与 `PREFIX sha256` 与第 1 步相同。

## 验收记录

（对照验收标准逐条验证时填写：编号 · 通过 / 未通过 · 证据）

## Open

（与 spec 的分歧、需要 owner 裁决的事；开放问题 4 的实测结论也记在这里）

## 交接记录

<!-- 每次停下时按日期追加，格式（本注释保留给后来的 agent）：
## 交接（YYYY-MM-DD）
- 已完成：
- 半成品：第 K 步做到 …，代码停在 …（能否 build）
- 阻塞：
- 下一步：
-->

### 交接（2026-10-09）

- 已完成：spec 经三轮评审，owner 定下开放问题 1–3、5–8 并翻成 `ready`；本 plan 写好。
- 半成品：无，还没写任何代码。
- 阻塞：「开工条件」第 1 条——02 还没发版到 main。
- 下一步：02 发版之后，新会话从第 1 步「开工核对」开始；第 1 批里第 3、4、5 步可以与第 2 步同时派给 Codex。

### 交接（2026-10-09，第 1 步完成时）

- 已完成：第 1 步（本 PR）。
- 半成品：第 1 批并行在做——第 2 步由 Claude 子 agent 在分支 `feat/03-db` 上做；第 3、4、5 步派给 Codex，分支依次是 `feat/03-secrets`、`feat/03-log-ids`、`feat/03-web-copy`（本机 worktree，还没推送）。各自合并时在本文件勾选、补实施记录。
- 阻塞：无。
- 下一步：审查并合并第 1 批；之后第 6 步（Claude）与第 16 步（Codex）。

### 交接（2026-10-09，第 1 批与第 6 步完成时）

- 已完成：第 1–6 步与第 16 步，都已合进 dev（第 6 步随本 PR）。
- 半成品：无。
- 阻塞：无。
- 下一步：第 3 批——第 7 步（按账号拆运行时与回调，Claude）；第 15 步（账号管理命令行）、第 17 步（网页渠道后端）派 Codex 并行。
