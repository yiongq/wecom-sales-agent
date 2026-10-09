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
- [ ] 2. 迁移、RLS、授权与仓储（2，Claude）
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
- [ ] 5. 部署开关 `web_channel` 与渠道话术分支（1，可派 Codex）
  - `src/profile.ts` 加 `web_channel`（`FLAG_WEB_CHANNEL`，demo 缺省开、prod 封顶为关），不进 00 的 `[profile]` 启动行，生效值照 `legacy_admin_writes` 另打一行（R15）。
  - 话术：网页会话的 contextNote 末尾多一句；第 1 步盘点出的确定性文本按会话渠道分两套（`wecom`、`simulator` 逐字节不变）；console 的渠道中文名加 `web`、`simulator` 改「演示」，非锁定的 console 自测按 spec 改（R15）。
  - 自测：开关的解析与 prod 封顶；同一组对话在三种渠道上的 contextNote、工具结果、确定性文本与前缀哈希（验收 15 的自动部分）。
  - 对应验收 15 的自动部分、14 的「`[profile]` 一行不变」；不变量 27、28 的开关部分。依赖：第 1 步。
  - 完成标准：四个门禁全绿；锁定套件 sha256 不变、`PREFIX sha256` 不变（这一步碰引擎，最容易让锁定套件变红，PR 里贴出两项核对）。
- [ ] 6. 账号装载、企微状态与启动（2，Claude）
  - `src/channels/accounts.ts`（读出、解密 `active` 的账号、env 账号的拼法、`accountByKey`、`accountForSession`、`inactiveReason`）、`markers.ts`（标记文件与恢复哨兵）、`registry.ts` 的 `initChannels`：按 R1 判三种企微状态，六个拒绝原因，标记补写，哨兵的去留（R1、R7 的哨兵部分、R8、R19 的欢迎语校验）。
  - `src/boot.ts`：`initSessionStore` 之后加 `initChannels`；监听之后 `startChannels` 先于任务与跟进扫描器（这一步 `startChannels` 只起 env 账号的老路，库里账号的运行时第 7 步接上）。`/healthz` 加 `channels`（`failing`、`stuck` 先恒为 0，第 13 步接实数）；`.env.example` 加 `CHANNEL_SECRETS_KEY`、`FLAG_WEB_CHANNEL` 与网页限流的变量。
  - 自测：三种状态下走哪条路；六个拒绝原因与「不留半装载」；全部停用时照常起、哨兵留着、之后启用再起被拦；欢迎语不合格按没设处理。
  - 对应验收 2、11 的启动拒绝部分、13 的启动拒绝部分、22 的启动部分；不变量 13、14。依赖：第 2、3、5 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；文件存储与「未导入」下 `wecom.selftest.ts`、`wecom-02.selftest.ts`、`quota.selftest.ts` 照过。
- [ ] 7. 按账号拆开的企微运行时与回调路由（2，Claude）
  - `WecomRuntime`：第 1 步列的模块级状态搬进按账号的运行时，注册表按账号 uuid 建键；文件状态层（cursor 文件、handled、在途表、02 的五种情况）挪进 file 后端、行为不变，锁定的 `__test` 照旧作用于 env 账号（R10）。
  - 会话 id 按账号前缀拼、出站按 `accountForSession` 找账号；`conversations.channel_account_id` 的投影（R11）。
  - 回调：`/wecom/callback/:key` 与 `/wecom/callback`，按账号验签、`receiveid` 校验、`OpenKfId` 分派；公开路由白名单加这一条（R12）。
  - 自测（新建 `src/adapters/wecom-03.selftest.ts`，假企微服务端支持两个 corp、同一 corp 两个客服账号）：三个账号交错、token 失败与停用互不影响、回调各自验签与分派、空 `receiveid`。这一步库里账号的状态后端还接在 02 的发送路径上（第 8、9 步换）。
  - 对应验收 10（日志部分在第 4 步）、12；不变量 18、19、20。依赖：第 6 步。
  - 完成标准：四个门禁全绿，锁定的 `wecom.selftest.ts` 照过；带 `PG_TEST_URL` 跑一遍。
- [ ] 8. 出站：先落库后发送（2.5，Claude）
  - `src/quota/ledger.ts`：`planOutbound`（同步校验）、`commitOutbound`、`markSending` 的四种结果、`settleIntent`、`cancelIntents`；内存账本按账号种类映射状态，env 账号照 02 不改名（R4）。
  - 发送顺序照 spec「出站 · 发一条 AI 回复」第 1–6 步：缩略图之后切分、提交、`markSending` 前后都比接手与截止、`sending → cancelled`、`sending → pending`；人工回复、跟进、通知、同意菜单的 `pending` 加进它们那一次落库；运行时才补的段（R4、R6）。
  - PG 后端：出站 `pending` 与 `cancelled` 写进主事务，结果留在存档点（R21 的出站部分）；出站行的 `kind` 记组的种类；工作台的投递状态按 spec 的映射表（R4）。
  - 自测：迁移表的每条路径在内存与库里一致；`markSending` 四种结果；挂住 `markSending` 期间接手、跨过截止（含判为 `db_unavailable` 的那一种）；R6 的两种补写（验收 7 的 A、B，不含杀进程）；工作台的五种显示。
  - 对应验收 5、7（不含杀进程）、17、20；不变量 4、6、7、10。依赖：第 2、7 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；在隔离副本里做变异（至少：不比第二次接手、`absent` 一律照发、晚到的 `pending` 盖掉结果、结果写进主事务）。
- [ ] 9. 入站：`channel_inbox` 与状态机（2.5，Claude）
  - `src/channels/inbox.ts`：`acceptPage`（与 cursor 同一事务、冷启动）、`load`、`beginAttempt`；出队时的计次、`poison`、`too_old`、恢复截止判定（R2、R3）。
  - `store.queueInboxState` 与 `writeInboxStateNow`；引擎的 `inboxId` 选项，记客户消息的两处都排 `recorded`；适配器的非文本占位、菜单点击、回执、进入会话事件的短路（R3、R21 的入站部分）。
  - 库里账号的企微运行时改用 `channel_inbox`，不再写 `wecom-cursor.json`（不变量 13）。
  - 自测：一页的提交与回滚、`ord` 顺序、状态机每一格、出队计次（队尾不被连累）、四种入站种类的处理。
  - 对应验收 3、9；不变量 1、2、3、8、11、12。依赖：第 8 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；变异（至少：插入就计次、`recorded` 不和消息同一事务、cursor 先于插入提交）。
- [ ] 10. 启动恢复与崩溃点（2，Claude）
  - `src/channels/recovery.ts`：出站恢复表、入站恢复表（按种类与状态）、保底三条、恢复做完之前 `push` 排队等待、`RESEND_UNKNOWN` 常量与 `__channelTest`（R5、R21 的保底）。
  - 停机：截止之后留 `pending`，不再需要 02 的 deferred（spec「重启、崩溃与恢复」）。
  - 自测（真实 PG，子进程 `SIGKILL`，靠假企微、假模型与库连接的阻塞点造时刻）：验收 4 的全部杀点、验收 7 的两种杀进程、验收 18 的每一种出站行、恢复做完之前到期的跟进等待。
  - 对应验收 4、7（杀进程部分）、18、20 的重启部分；不变量 5、15。依赖：第 8、9 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍；跑完 `ps` 里没有子进程残留；变异（至少：`sending` 重启后照发、有接手人仍补发、人工回复不看 10 分钟）。
- [ ] 11. spill 与 poisoned 会话的渠道行（1，Claude）
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
- [ ] 13. 可观测性（0.5，可派 Codex）
  - `/healthz` 的 `failing`、`stuck` 接实数；console `/status` 的每账号字段；告警键 `channel` 的各条与 `wecom_send` 带账号 key（spec「可观测性」）。
  - 自测：`ops.selftest.ts` 加各条告警的触发与内容里没有凭据、`external_userid`。
  - 对应验收 23、10 的告警部分。依赖：第 6–10 步。
  - 完成标准：四个门禁全绿。
- [ ] 14. 导入、导出与 `--resync`（1.5，Claude）
  - `src/cli/channel-import.ts`（合并 `handled` 与 `pending`、在途优先、队头计次、`--keep`、标记与删原件的顺序）、`channel-export.ts`（拒绝的几种、写回 02 格式、出站转换、默认账号改 `exported`）、`--resync`（R13）。
  - 自测（子进程，PGlite 与真实 PG）：验收 13 的导入、导出、`--resync` 与启动拒绝；两处真实重叠的夹具。
  - 对应验收 13；不变量 13。依赖：第 6、9 步（导出要用第 8 步的出站状态）。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍。
- [ ] 15. 渠道账号管理命令行（0.5，可派 Codex）
  - `channel-account` 的 `list`、`add-wecom`、`add-web`、`set-secrets`、`set`、`rekey`：凭据从无回显输入或 0600 文件读、prod 下 `add-web` 被拒、「已导出」时加账号被拒、欢迎语校验、审计动作与 `actor_kind`（R8、R19、R23）。
  - 自测：各子命令的退出码与审计行；输出里没有凭据与 `corp_id`、`open_kfid`。
  - 对应验收 11 的命令行部分、22 的命令行部分。依赖：第 3、6 步。
  - 完成标准：四个门禁全绿。
- [ ] 16. 回滚检查（0.5，可派 Codex）
  - `deploy/rollback-guard.sh` 加退出码 5 这一类：标记文件、以及标记不在时问库「有没有不是『默认企微账号且 `exported`』的行」（R19）。
  - 自测：`ops.selftest.ts` 用假 `docker`、`psql` 断言几种组合的退出码（标记在、只有 `exported`、有停用的账号、有网页账号、库问不到）。
  - 对应验收 21 的回滚检查部分。依赖：第 2 步。
  - 完成标准：四个门禁全绿。
- [ ] 17. 网页渠道后端（1.5，可派 Codex，安全相关由 Claude 审）
  - `src/adapters/web.ts`、`src/web/routes.ts`：会话 id 推导、`__Host-wv` cookie 的发放、续期与「结束咨询」、`x-web-chat`、`cid` 去重与重跑、历史投影、SSE 的鉴权、并发上限与空闲关闭、同意菜单、IP 限流与每日上限、开关 `web_channel` 关着时 404；`adapterFor('web')`；公开路由白名单加网页的几条（R14、开放问题 3、8 的裁决）。
  - 自测（`src/web/web.selftest.ts`）：验收 14 的后端部分与 prod profile 部分。
  - 对应验收 14 的后端部分；不变量 23、24、26、28。依赖：第 2、5、6 步。
  - 完成标准：四个门禁全绿；带 `PG_TEST_URL` 跑一遍（网页会话落库与清理）。
- [ ] 18. 网页页面与 CSP（1，可派 Codex）
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
