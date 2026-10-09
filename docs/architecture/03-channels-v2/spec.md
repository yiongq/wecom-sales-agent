# 03 · 渠道层 v2

Status: draft
Phase: 3 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」（2026-10-09 重排之后的编号）
Depends on: [02 · 会话入库 + 坐席工作台](../02-conversations-workbench/spec.md)（开工时须已 implemented：PG 会话存储与每会话写队列、发送账本、清除与删除函数、任务表、告警）；[01 · Postgres 底座 + 配置入库 + 后台 v0](../01-pg-config-console/spec.md)（`withTenant`、三个角色、RLS 模板、租户锁、启动顺序、审计）。选型见 [ADR-001](../../adr/adr-001-postgres-drizzle.md)
Amends: 02 的「数据库」（新表 `channel_accounts`、`channel_inbox`；`outbound_sends` 的新列与三个新状态；`conversations.channel_account_id`；授权；清除与删除函数的删除范围加 `channel_inbox`，新函数 `purge_channel_inbox`）、不变量 42（表清单加 `channel_inbox`）、R22（公开路由加企微按账号的回调与网页渠道三组）、「两种会话存储与启动」（`initChannels` 一步、新的启动拒绝原因、`/healthz` 的 `channels`）、「可观测性与告警」（新告警键 `channel`、告警带账号 key）；01 的「审计」（新动作）；后台 UX spec 的渠道中文名（加 `web`）。只做新增或收紧
Supersedes in part: [02](../02-conversations-workbench/spec.md) 的 R7「企微 cursor：留在 `var/wecom-cursor.json`（开放问题 5），同时做三条缓解……」那一句与「推迟」格的 `channel_inbox`（04）；「identity map 与写入 · 一次落库」第 6 步把账本行写在存档点之内；「企微：发送账本、回执与去重」里「账本行随会话的下一次落库写（存档点之内……）」一句，与「去重与重放对齐」的五种情况。三处都只在库里有企微账号时（R1）被取代，文件存储、以及还没导入账号的 db 存储下原文照旧。原因：02 第 26 步的恢复演练复现了重复回复（备份落在「回复已发出、账本行还没落库」那不到 2 秒的窗口里），02 开放问题 5 的裁决是「复现了就在接第一个真实租户之前另写 spec 提前做」，owner 2026-10-09 确认；这几处的机制本身就是那个窗口的来源，改成「先落库、后发送」才能消掉它，见「与 02 及更早 spec 的关系」

## 背景与问题

02 之后会话、消息、订单在 Postgres 里，企微的拉取状态还在 `var/wecom-cursor.json`：cursor、已处理的 msgid 集合（3 天、至多 5000 条）、在途表（已认领、没处理完的客户消息连同原文）。发送账本（`outbound_sends`）在 send_msg 有了结果之后才排进会话的下一次落库，而且写在 trace 的存档点里。02 的恢复演练（plan「实施记录 · 第 26 步」、「验收记录」第 31 条）把这两点合起来的后果跑了出来：备份恰好落在「回复已发出、账本行还没落库」的那一刻，恢复后的进程认为这条回复没送出，又发了一遍。现状里决定 03 必须先定死的几处：

- **cursor 和会话不在同一份存储里。** `pg_dump` 与打包 `var/` 不是同一时刻；进程崩溃时也只有文件那一侧是同步落盘的。02 的三条缓解（客户消息带 msgid 按五种情况去重、备份顺序、重放看账本）缩小了窗口，消不掉它。顺带：02 R7 写的是「备份先打包 `var/` 再 `pg_dump`」，`deploy/backup.sh` 实际是先 `pg_dump` 后打包 `var/`（本次读代码发现）；渠道状态进库之后这个顺序不再相关。
- **发送在记账之前。** 账本行要等 send_msg 回包才排进落库，再等一次落库才提交；这中间崩溃或被备份截住，重启后的进程看不到「发过」，按 02 的情况 4 补发，补发的还是一个新的 msgid（plan 第 26 步原话）。
- **企微是一个全局单例。** `src/adapters/wecom.ts` 的 access_token、cursor、去重集合、在途表、同步互斥、轮询定时器、欢迎语去重、缩略图缓存都是模块级变量；凭据每次从 `.env` 的 `WECOM_*` 现读；会话 id 是 `wecom:<external_userid>`，不带账号；回调只有一个 `/wecom/callback`。一个实例只能接一个客服账号，同一租户第二个客服账号进来就会串。
- **凭据只能放 env。** AGENTS.md 的硬规则给按租户的渠道凭据留了一个例外：可以加密存库、密钥在 env 文件。04 的同部署多租户与以后的开通都要它，第一批「一家客户一个实例」用不上多租户，但换凭据、加第二个客服账号不该再改 env 重建容器。
- **网页模拟器不是渠道。** `sim-` 会话按 demo 数据处理：凭 id 匿名可读、闲置 24 小时删、总量 5000 封顶、永不进 PG（02 R6）。锁定的 `server.selftest.ts` 把它钉得很死（`chat.html` 的存储键与 id 生成、`/api/chat` 只认 `sim-`、访客清理与上限、`x-sim-session`），所以「转正」只能是照着它另起一个正式渠道，不能原地改。
- **SOP 是按企微写的。** 「在企业微信上接待」「顾问会在微信上联系您」写在 SOP 的锁定节里，前缀要逐字节稳定；网页渠道的客户不在微信里，这句话对他们是错的承诺。

本阶段要把「之后改不起的东西」定下来：入站记录的去重键与状态机、cursor 与入站同一事务、出站「先落库后发送」的投递状态、恢复截止点、渠道账号的表与凭据加密的格式、按账号拆开的运行时与会话 id 规则、按账号的回调路由、网页渠道的名字、id 与凭据、从 env 到库的导入与回退。粗估约 20 个工程日，plan 里细化。

## 目标

1. 库里有企微账号时，企微的 cursor 只在把这一页消息写进 `channel_inbox` 的同一个事务里推进；客户消息写进会话与入站记录改状态在同一事务；出站分段在调 send_msg 之前已在库里。进程崩溃重启、按恢复手册从备份恢复之后，每条客户消息恰好收到一次回复（结果不明的那一种除外，见 R5），02 演练复现的窗口消失。
2. 出站消息记投递状态：在 02 的发送账本上补齐「待发送、发送中、已取消」，工作台按它显示；同一分段的每次尝试与重启后的补发都用同一个 msgid。
3. 企微凭据按账号存进 `channel_accounts`，加密存库、密钥在 env 文件；明文只在进程内存里。access_token、cursor、入站、同步互斥、轮询按账号拆开；回调路由按账号。本阶段线上仍是一个实例一个租户一个客服账号，但同一实例跑两个账号互不串。
4. 现有 `.env` 里的 `WECOM_*` 与 `var/wecom-cursor.json` 能导入库里，也能导出回去、回退到 02 的镜像；部署脚本的回滚检查认得这一步。
5. 网页渠道转正：新渠道 `web`、会话 id 前缀 `web:`、访客凭据放 HttpOnly cookie、会话进 PG、按保留期清理；demo 与 prod 都能按账号开。网页模拟器（`sim-`）与它的全部 demo 行为照旧。
6. 锁定套件零修改；`promptPrefix()` 不变；demo 行为（重置、匿名只读、种子保鲜、访客清理、模拟支付、AI 标识）照旧。

## 非目标

- 同一部署服务多个租户：公开路由按域名或 `SECURITY DEFINER` 函数解析租户、从模板开通租户、按租户的 LLM 预算、跨租户的进程内缓存泄漏测试（阶段 4）。本阶段只把键带上（R20）。
- 行业包抽取、cases v2 导出、中文通用解析与工具注册表（阶段 4）。
- 护栏重构成有序 Guard 流水线、阈值与币种改配置（阶段 4）。
- 链接由引擎显式产出、消息部件、渠道能力描述（阶段 4，R17）；渠道中立的提示词模板（阶段 4，R18）。
- 政策单一来源、知识库、售后退改、看板拆分、trace 查看器（阶段 5）。
- 多副本：fence read、每会话 advisory lock、企微拉取选主（阶段 6，按信号）。本阶段仍只跑单副本，靠 01 的租户锁拒绝第二个进程；`channel_inbox` 按（账号，msgid）冲突即跳过的写法不妨碍以后选主。
- 在 console 里增删改渠道账号：本阶段只有命令行，改完重启生效（R8）；console 的账号页随阶段 4 的开通一起做。
- 网页渠道嵌进第三方网站（iframe）：要按账号的 `frame-ancestors` 白名单、`SameSite=None; Partitioned` 的 cookie 与各浏览器第三方存储分区的兼容测试；本阶段只做独立页面 `/w/:key`（在浏览器或微信内置浏览器里打开），`frame-ancestors 'none'`。按需求另议。
- 网页渠道的自动跟进：客户关掉页面就没有触达通道，`followup.ts` 照旧只追企微。
- 认证服务号、海外渠道（阶段 6 的候选）。

## 前置条件

开工时逐项核对，缺一项就停下：

- 02 是 `Status: implemented`（owner 确认验收、02 plan 第 27 步已勾）。03 plan 第 1 步在 02 顶部加 `Superseded in part by:`（列本 spec 顶部 `Supersedes in part:` 的三处）与 `Amended by:`；01、后台 UX spec 顶部各加 `Amended by:`。02 还没 implemented 时本 spec 不开工：它的条款要由 02 的最终文本来对。
- 线上 demo 以 `SESSION_STORE=db`、`CONFIG_SOURCE=db` 运行（02 第 27 步）。
- `pnpm test` 在开工提交上全绿；记下锁定文件清单与各自的 sha256（`src/*.selftest.ts` 的 6 个、`src/adapters/wecom.selftest.ts`、`eval/cases.json`）与 `PREFIX sha256` 的两个值。
- 开放问题 1 在开工前答复（决定网页渠道那几步与顶部 `Supersedes in part:` 要不要加 R6）；2、3 在给真实租户开网页账号之前；4 在接第一个真实租户之前在测试客服账号上实测（与 02 plan「上线清单」里企微额度实测那一项合并）；5 在写恢复手册那一步之前。到点没答复的按推荐先做，plan 里记一笔。

## 从总参考与 02 接过来的事项

| 事项                                                                     | 来源                                                         | 03 的处理                                                                                      | 见       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------- |
| `channel_inbox` 按（账号，msgid）去重；cursor、已处理集合、在途表搬进 PG | 总参考原阶段 4「渠道层 v2」；02 开放问题 5；02 plan 上线清单 | 与 cursor 同一事务插入；状态机；取代 handled 集合与在途表                                      | R2、R3   |
| 出站消息记投递状态                                                       | 总参考                                                       | 在 `outbound_sends` 上扩列与状态，先落库后发送                                                 | R4、R5   |
| 恢复后在途客户恰好收到一次回复                                           | 02 验收 31（未通过，按开放问题 5 处理）                      | 同一份 `pg_dump` 一致；恢复截止点                                                              | R7       |
| 每账号加密存凭据，独立的拉取和回调路由                                   | 总参考                                                       | `channel_accounts`、AES-256-GCM、每账号运行时、`/wecom/callback/:key`                          | R8–R12   |
| 企微全局单例（access_token、cursor、在途表、同步互斥）按账号拆开         | 总参考原阶段 4「同一部署多租户」                             | 本阶段做                                                                                       | R10      |
| 网页渠道转正（新的渠道名和 id 前缀）                                     | 总参考                                                       | 新渠道 `web`，模拟器原样                                                                       | R14、R16 |
| 链接由引擎显式产出                                                       | 总参考                                                       | 推到阶段 4                                                                                     | R17      |
| 渠道中立的提示词只用于新租户，demo 租户逐字节不动                        | 总参考                                                       | 模板推到阶段 4；本阶段只给网页会话的 contextNote 加一句                                        | R15、R18 |
| 回执把一条回复记成 failed 之后，重放时情况 4 会把它原样再发一次          | 02 plan「实施记录 · 第 12 步」顺带记下的一处                 | `failed`、`rejected` 都不补发                                                                  | R5       |
| 接手之后、发送之前崩溃，重启时会补发那条 AI 回复                         | 02 plan 第 12 步「注意（第 13 步）」                         | 已接手的会话里没发的分段记 `cancelled`                                                         | R5       |
| 02 R7 写「备份先打包 `var/` 再 `pg_dump`」，`backup.sh` 实际顺序相反     | 本次读代码发现                                               | 库里有企微账号之后渠道状态不在 `var/`，顺序不再相关；文件状态路径照旧，不改 `backup.sh` 的顺序 | R7       |
| 第一批真实客户一家一个实例，同部署多租户不在本阶段，但不能把单例写得更深 | owner 2026-10-09                                             | 新表都带 `tenant_id`，运行时按账号 uuid 建键                                                   | R20      |

## 开工前裁决

| #   | 问题                                           | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 本阶段落地                                                    | 推迟                       |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------- |
| R1  | 什么时候走渠道层 v2                            | 账号有两个来源、企微状态有两个后端。文件存储：`WECOM_*` 配齐就拼出一个 env 账号，状态在 `var/wecom-cursor.json`，行为与 02 逐字节相同（锁定的 W1 守它）。db 存储、库里没有企微账号：同上（照 02），启动日志一行提示「企微账号还没导入」；这让 03 的镜像能先按 02 的行为部署，再停机导入，与 02 的切换同一个拆法。db 存储、库里有企微账号：只用库里的账号，状态在 `channel_inbox`，出站先落库；env 里的 `WECOM_*` 被忽略，启动日志点名变量名（不写值）。网页渠道只在 db 存储下、库里有 `web` 账号时存在。不另设开关                                                                                                                                    | `src/channels/registry.ts`                                    | —                          |
| R2  | 入站去重与 cursor                              | `channel_inbox` 以（`account_id`，`msgid`）唯一。`sync_msg` 拉到一页之后，一个事务里把这一页要处理的条目插进去（冲突即跳过，只返回真正新插入的）并推进这个账号的 cursor，提交之后才派发。要记的：客户消息（含菜单点击）、发送失败回执、进入会话事件（直接记 `done`，只为去重）；其余事件照旧跳过、不记。取代 handled 集合与在途表。`done`、`abandoned` 的行 7 天后由清理函数删（与 02 的 7 天 msgid 集合同一口径，开放问题 4 实测之后可改）                                                                                                                                                                                                           | `src/channels/inbox.ts`                                       | —                          |
| R3  | 入站状态机                                     | `received`（已入库、还没进会话）→ `recorded`（客户消息已写进会话，同一次落库改状态并记下 seq）→ `replied`（回复的出站分段已落库，同一事务改状态）→ `done`；任一步可到 `abandoned`（带原因）。非文本占位、菜单点击、回执各有短路（「入站」一节）。插入时 `attempts` 是 1，重启后重新处理之前加 1 并提交；处理前已到 3 的记 `abandoned`（`poison`，即处理过三次都没走完，与 02 的「重放两次」同一口径），`sent_at` 早于 48 小时的记 `abandoned`（`too_old`），两种都给会话加一条 system 消息让顾问看见（02 的同一句）                                                                                                                                   | 引擎多一个可选参数 `inboxId`                                  | —                          |
| R4  | 出站投递状态                                   | 在 02 的 `outbound_sends` 上扩，不另建表：状态加 `pending`（已落库、还没发）、`sending`（这一段的第一次尝试已开始）、`cancelled`（不会再发）。一条回复（以及人工回复、跟进、通知、同意菜单、老客户欢迎语）切好分段之后，每段一行 `pending`，带我们生成的 msgid 与要发的内容（`payload`），随会话落库写进主事务——不在 trace 的存档点里，丢了就做不到恰好一次。提交之后，每段第一次尝试之前单独一个短事务把它改成 `sending`，再调 send_msg；结果照 02 记 `accepted`、`rejected`、`unknown`，回执记 `failed`。`payload` 在进终态时置空。网页渠道没有账本（推送就是写进历史）                                                                             | `src/quota/ledger.ts` 的 `planOutbound` 等                    | —                          |
| R5  | 重启后的补发规则                               | 启动时先按状态处理没结束的入站行，再拉新消息（同一客户的新消息排在它们后面）：`received` 照常处理；`recorded` 若会话里这句之后已有 AI 回复，就按那条回复补出分段再发，否则没转人工就以 `alreadyRecorded` 重跑、转了人工就记 `done`；`replied` 只发它名下 `pending` 的分段（同一 msgid、同一内容）、不调模型；`sending` 记 `unknown`、不补发；`accepted`、`rejected`、`unknown`、`failed` 都不补发。会话已有接手人时，没发的分段记 `cancelled` 并追加 02 的「本轮未发送（顾问已接手）」。企微按 msgid 去重（02 开放问题 8 的待核实点，本 spec 开放问题 4）核实为真之前，结果不明不补发；核实之后只改适配器里一个常量，`unknown` 改为按同一 msgid 补发  | `src/channels/recovery.ts`                                    | —                          |
| R6  | 库写不进去时                                   | 发送前等这次落库提交，至多 5 秒（与 02 不变量 20 同一口径）；超时照发（可用性优先，客户不该因为库慢收不到回复），分段在内存里照常记账，库恢复后随落库补写；改 `sending` 的短事务失败同样照发。这期间进程崩溃可能重复一次。每次「没落库就发」计数、10 分钟内有就告警（`channel`）。恰好一次的不变量只对「分段在发送前已提交」成立                                                                                                                                                                                                                                                                                                                      | 同上                                                          | —                          |
| R7  | 备份恢复                                       | 渠道状态全在库里之后，一份 `pg_dump`（单一快照）里 cursor、入站、会话、出站彼此一致，恢复不再依赖 `var/`。剩下的问题是快照之后的事：旧实例在快照之后处理过的消息，恢复后的进程从旧 cursor 重新拉到、不知道已经回过。恢复手册加一步：起应用之前用命令行给这个租户的企微账号设恢复截止点 `record_only_until`；`sent_at` 不晚于它的入站（重新拉到的，和快照里没结束的）只补记进会话、不调模型、不发送，没发的分段记 `cancelled`，每个涉及的会话加一条 system 说明、告警一条（只有会话数）；晚于它的照常处理。取值见开放问题 5                                                                                                                            | `channel-account restore-cutoff`                              | —                          |
| R8  | 渠道账号                                       | `channel_accounts` 一行一个入口：`wecom_kf`（一个客服账号）或 `web`（一个网页入口）。`key` 用在路由、日志与告警里，`kind`、`key`、`id_prefix`、`corp_id`、`open_kfid` 建好不改（触发器拦）；换客服账号就是新建一行、停用旧的。`agent_app` 有 SELECT、INSERT 与列级 UPDATE，没有 DELETE（停用代替删除）。本阶段只经命令行管理，要求应用已停（取租户锁），改完重启生效；console 的账号页放到阶段 4                                                                                                                                                                                                                                                      | `src/cli/channel-account.ts`                                  | console 管理（阶段 4）     |
| R9  | 凭据加密                                       | 要加密的是应用 secret、回调 Token、回调 EncodingAESKey，三项合成一个 JSON 一次加密：AES-256-GCM，12 字节随机 nonce，附加数据（AAD）是 `channel_accounts:v1:<tenant_id>:<账号 id>`，密文换到别的行就解不开。密钥环在 app 的 env 文件 `CHANNEL_SECRETS_KEY`：`<id>:<base64 的 32 字节>`，逗号分隔可放几把，第一把用来加密，列出的都能解；轮换 = 前面加一把新的、跑 `rekey`、再去掉旧的。`corp_id`、`open_kfid` 是标识不是密钥，明文存（仍不进仓库、不进日志）。access_token 只在内存里。明文、密文、token 都不进日志、审计、告警、`/healthz`、`/status` 与命令行输出；凭据只从标准输入读。密钥丢了只能重新录入凭据，恢复手册写明要连同 env 文件一起保管 | `src/channels/secrets.ts`                                     | —                          |
| R10 | 按账号拆开的运行时                             | 每个启用的企微账号一个运行时：配置、access_token 与它的并发去重、状态后端（文件或 `channel_inbox`）、同步互斥与补拉标志、按客户的处理链、轮询定时器、停机截止、欢迎语去重表、缩略图缓存。注册表按账号 uuid 建键。一个账号取不到 token、拉取出错、被停用，不影响另一个账号收发。锁定的 `__test`（`STATE_FILE`、`resetForTest`、`inspectForTest`）照旧作用于 env 账号                                                                                                                                                                                                                                                                                   | `src/adapters/wecom.ts`                                       | —                          |
| R11 | 会话 id 与账号                                 | 每个企微账号一个不可改的 id 前缀：租户的第一个企微账号（导入 env 的那个）用 `wecom:`，所以 02 的会话 id 一个都不变；之后建的用 `wecom:<key>:`。会话 id = 前缀 + `external_userid`，发往一个会话的消息只经前缀最长匹配到的那个账号发出。同一客户在同一租户两个客服账号上是两段会话：在客户的微信里它们本来就是两个对话窗口，发送窗口也按客服账号算（待核实，开放问题 4）。会话对象与 `conversations` 多一个 `channelAccountId`（`NULL` 表示渠道的默认账号）。种子 `wecom:cust_` 不受影响                                                                                                                                                               | `accountForSession()`                                         | —                          |
| R12 | 回调路由                                       | `/wecom/callback/:key` 用那个账号的回调 Token 与 EncodingAESKey 验签、解密；`/wecom/callback`（不带 key）留给前缀是 `wecom:` 的那个账号（文件存储与还没导入时是 env 账号），线上已配好的地址不用改。解密后按明文里的 `OpenKfId` 找本租户启用的、同一 `corp_id` 的企微账号去拉（几个客服账号共用一个自建应用时只能配一个回调地址）；找不到就只记日志。GET（企微后台校验地址）对不存在或停用的 key 返回 404；POST 一律回 `success`（企微会重推），出错只记日志                                                                                                                                                                                          | `server.ts`                                                   | —                          |
| R13 | `WECOM_*` 的导入与回退                         | `channel-import` 把 `.env` 里的 `WECOM_*` 建成租户的第一个企微账号（前缀 `wecom:`）并把 `var/wecom-cursor.json` 的 cursor、已处理集合、在途表导进 `channel_inbox`，写标记文件 `var/channels-in-db.json`，把原文件改名留底。`channel-export` 反过来，供回退到 02 的镜像。之后再切回用 `channel-import --resync`。导入之后 `.env` 里的 `WECOM_*` 留到 03 验收通过、确定不回退之后再删：留着时应用忽略它们，回退时不用手工加回                                                                                                                                                                                                                           | `src/cli/channel-import.ts`、`channel-export.ts`              | —                          |
| R14 | 网页渠道                                       | 新渠道 `web`，会话 id 是 `web:` 加 `sha256("<账号 id>:<访客凭据>")` 的前 32 位十六进制：id 不是凭据，出现在后台、日志里也读不到会话。访客凭据是 32 字节随机数，放在 `__Host-wv`（HttpOnly、Secure、SameSite=Lax）cookie 里，第一次发消息时发放；SSE 用同源 cookie，凭据不进 URL。路由 `/w/:key`、`/api/web/:key/messages`、`/history`、`/events`，账号启用就开，demo 与 prod 都一样。会话不是 demo 类：进 PG、按保留期清理、不受访客清理与上限管。网页模拟器（`sim-`、`chat.html`、`/api/chat`）原样保留：锁定的 `server.selftest.ts` 钉住了它                                                                                                        | `src/web/routes.ts`、`src/adapters/web.ts`、`public/web.html` | iframe 嵌入（另议）        |
| R15 | 网页会话的话术                                 | SOP 与 `promptPrefix()` 不动。`channel === 'web'` 的会话，contextNote 末尾多一句：客户在网页上咨询、不在微信里，转人工或要顾问跟进时说顾问会在这个页面里回复，不说「在微信上联系」（措辞实施时定，约束如上）。企微与模拟器会话的 contextNote 逐字节不变。接真实客户之前租户 SOP 里的渠道措辞怎么办见开放问题 2                                                                                                                                                                                                                                                                                                                                        | `src/engine.ts` 的 contextNote                                | 渠道中立模板（阶段 4）     |
| R16 | demo、种子与访客                               | 种子（`wecom:cust_`）留在 JSON，不进库：保鲜每小时平移它们消息的时间戳，库里的消息只追加，进库就得每次删了重灌。网页模拟器的 `sim-` 访客照旧是 demo 类（02 R6 不取代）。demo 实例可以另开一个 `web` 账号演示正式渠道，那里的会话按真实会话处理。demo 的公开入口要不要改走正式网页渠道，见开放问题 1（推荐不改）                                                                                                                                                                                                                                                                                                                                       | —                                                             | —                          |
| R17 | 链接由引擎显式产出（含消息部件、渠道能力描述） | 推到阶段 4。它改的是引擎到渠道的出口契约（回复从一段文本变成文本加部件），锁定的 `wecom.selftest.ts` 对 `extractCard` 的全等比较、引擎自测里对回复文本含链接的断言都钉在现在的形状上；阶段 4 把 13 道出口护栏包成流水线时出口本来就要重写，一起做只改一次。本阶段没有可靠性上的收益：网页渠道照 `chat.html` 的做法在页面里把链接渲染成卡片                                                                                                                                                                                                                                                                                                            | —                                                             | 阶段 4                     |
| R18 | 渠道中立的提示词                               | 推到阶段 4，随行业包模板与「从模板开通租户」一起做：只用于新租户，demo 租户的 SOP 逐字节不动。本阶段一家一个实例，第一个真实租户的 SOP 由运营在 console 里写（01），本来就可以写成中立的；网页会话靠 R15 那一句                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                             | 阶段 4                     |
| R19 | 回滚检查与欢迎语                               | `deploy/rollback-guard.sh` 加一类风险：目标是 03 之前的镜像（镜像里没有 `src/channels/registry.ts`），而 `var/` 下有 `channels-in-db.json`，拒绝（退出码 5）并打印回退步骤。欢迎语按账号：`settings.welcomeText`、`welcomeBackText` 不设就是现在的两段常量（demo 逐字节不变），设了要过 AI 显式标识的检查（第一句含「AI」、正文含转人工的说法），命令行写入时校验                                                                                                                                                                                                                                                                                     | `deploy/rollback-guard.sh`                                    | —                          |
| R20 | 给阶段 4 留的缝                                | 新表都带 `tenant_id`、套 FORCE RLS；进程内的注册表、token、缩略图、欢迎语去重都按账号 uuid 建键，每个运行时带自己的 `tenantId`，库操作都经 `withTenant(account.tenantId)`；公开路由按 key 找账号（本阶段只在实例的租户里找，阶段 4 换成按 key 解析租户的 `SECURITY DEFINER` 函数，key 那时要么全局唯一、要么路由里带租户，阶段 4 定）；网页会话 id 的哈希里有账号 id。没有新的模块级单例                                                                                                                                                                                                                                                              | —                                                             | 公开路由解析租户（阶段 4） |

## 接口与数据流

### 模块与依赖方向

```
src/
  channels/
    secrets.ts        KeyRing、sealSecrets、openSecrets（纯函数，只依赖 node:crypto）
    accounts.ts       ChannelAccount、从库里读出与解密、env 账号的拼法、accountByKey、accountForSession
    registry.ts       initChannels、运行时注册表、ChannelStartupError
    inbox.ts          PgInbox：load、acceptPage、bumpAttempt（经 src/db/repo/channel-inbox.ts）；随会话落库的状态变化走 store 的 queueInboxState
    recovery.ts       启动时按状态机处理没结束的入站行；判定部分是纯函数
    markers.ts        var/channels-in-db.json 的读写（纯文件操作，命令行也用）
  adapters/
    wecom.ts          WecomRuntime（按账号）；文件状态层（cursor 文件、handled、在途表、02 的五种情况）挪进 file 后端，行为不变
    web.ts            网页渠道适配器：按会话的 SSE 推送
  web/routes.ts       /w/:key、/api/web/:key/*
  quota/ledger.ts     多 planOutbound、markSending、settleIntent、cancelIntents
  db/repo/            channel-accounts.ts、channel-inbox.ts；outbound.ts 扩
  cli/                channel-import.ts、channel-export.ts、channel-account.ts
  shared/channel-types.ts   ChannelKind、InboxState、OutboundStatus 等共享类型
public/web.html       网页渠道的页面（从 chat.html 改出来，不碰 chat.html）
```

依赖规则（加进 `scripts/check-boundaries.ts`）：

- `src/channels/secrets.ts`、`src/channels/markers.ts`、`src/channels/recovery.ts` 的判定函数是纯的：不 import `src/db/**`、`store`、`engine`、`llm`、`adapters/**`。
- `src/channels/**` 不 import `engine`、`llm`、`tools`；`src/db/**`、`src/cli/**` 不 import `src/channels/registry.ts` 与 `adapters/**`（命令行要的是 `secrets.ts`、`accounts.ts` 的读写与 `markers.ts`）。
- 字符串 `CHANNEL_SECRETS_KEY` 只出现在 `src/channels/secrets.ts`；`pg`、`drizzle-orm` 仍只被 `src/db/**` import（01 规则不变）。

### 渠道账号与凭据

```ts
// src/shared/channel-types.ts
export type ChannelKind = 'wecom_kf' | 'web';
export type ChannelAccountStatus = 'active' | 'disabled';
export type InboxKind = 'message' | 'menu_click' | 'enter_session' | 'send_fail' | 'legacy';
export type InboxState = 'received' | 'recorded' | 'replied' | 'done' | 'abandoned';
export type InboxAbandonReason = 'too_old' | 'poison' | 'cold_start' | 'restore_cutoff' | 'resync';
export type OutboundStatus = 'pending' | 'sending' | 'accepted' | 'rejected' | 'unknown' | 'failed' | 'cancelled';

// src/channels/accounts.ts
export interface WecomSettings {
  pollIntervalMs?: number; // 兜底轮询间隔，缺省同 WECOM_POLL_INTERVAL_MS 的规则（≥30 秒）
  welcomeText?: string; // 不设就是现在的 WELCOME_TEXT（R19）
  welcomeBackText?: string;
}
export interface WebSettings {
  title: string; // 页面标题与顶栏
  welcomeText?: string; // 不设就是 chat.html 的开场
  dailyNewConversations: number; // 每天新会话上限（开放问题 3），缺省 500
  dailyTurns: number; // 每天调模型的轮次上限，缺省 3000
}
export interface ChannelAccount {
  id: string; // uuid；进程内所有按账号的 Map 都用它做键
  tenantId: string;
  key: string; // ^[a-z][a-z0-9-]{1,30}$，路由、日志、告警里用
  kind: ChannelKind;
  name: string;
  status: ChannelAccountStatus;
  /** env：文件存储或还没导入时由 WECOM_* 拼出（id 固定为 ENV_ACCOUNT_ID，key 固定为 'env'）；db：库里的一行 */
  source: 'env' | 'db';
  wecom: { corpId: string; openKfId: string; idPrefix: string; recordOnlyUntil: number | null; settings: WecomSettings } | null;
  web: WebSettings | null;
}
export interface WecomSecrets {
  appSecret: string;
  callbackToken: string;
  callbackAesKey: string;
}
export const ENV_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';
/** 前缀最长匹配到的企微账号；web: 会话按会话对象上的 channelAccountId；都没有时返回渠道的默认账号（文件存储下就是 env 账号） */
export function accountForSession(sessionId: string, s?: Session): ChannelAccount | undefined;
export function accountByKey(key: string): ChannelAccount | undefined; // 只返回 active 的
```

```ts
// src/channels/secrets.ts
export interface KeyRing {
  current: { id: string; key: Buffer };
  all: ReadonlyMap<string, Buffer>;
}
/** 读 CHANNEL_SECRETS_KEY；没设返回 null。格式不对抛 ChannelKeyError（initChannels 报成 channel_key_invalid），只说第几项哪里不对，不带值 */
export function keyRingFromEnv(env: Readonly<Record<string, string | undefined>>): KeyRing | null;
/** 返回 nonce(12) ‖ 密文 ‖ tag(16) 与所用的 key id */
export function sealSecrets(ring: KeyRing, aad: { tenantId: string; accountId: string }, s: WecomSecrets): { ct: Buffer; keyId: string };
/** 解不开（key id 不在环里、tag 不对、AAD 不对、JSON 不对）抛 ChannelSecretError，message 里只有账号 key 与 key id */
export function openSecrets(ring: KeyRing, aad: { tenantId: string; accountId: string }, ct: Buffer, keyId: string): WecomSecrets;
```

```ts
// src/channels/registry.ts
export interface ChannelDeps {
  db: Db;
  tenantId: string;
  tenantSlug: string;
  varDir: string;
  keyRing: KeyRing | null;
}
/**
 * boot() 在 initSessionStore 之后、serve 之前调。deps 为 null（文件存储）：var/ 下有 channels-in-db.json 就以 channel_state_in_db
 * reject；否则 WECOM_* 配齐时拼一个 env 账号（状态在文件）。db 存储：读本租户的全部账号 → 有企微账号而没有密钥环 → channel_key_missing；
 * 逐个解密，解不开 → channel_decrypt；有企微账号而 var/ 下有 wecom-cursor.json、没有标记文件 → channel_state_in_file；
 * 没有企微账号时照 R1 拼 env 账号；有就补写标记文件（写不进去只记日志），建运行时、按 R5 加载没结束的入站行。
 * 任何一步失败都不留半装载状态
 */
export function initChannels(deps: ChannelDeps | null): Promise<void>;
export class ChannelStartupError extends Error {
  constructor(
    readonly reason:
      | 'channel_key_missing'
      | 'channel_key_invalid'
      | 'channel_decrypt'
      | 'channel_state_in_file' // 库里有企微账号，var/ 里还有没导入的 wecom-cursor.json：跑 channel-import（回退过就加 --resync）
      | 'channel_state_in_db', // 文件存储而 var/ 里有 channels-in-db.json：渠道状态在库里，先 channel-export
    detail: string,
  );
}
```

启动顺序（`src/boot.ts`，02 之上多一步，失败分支相同）：

```
await initConfig()  →  await initSessionStore(deps | null)  →  await initChannels(deps | null)  →  serve()
  → 监听成功后：preflight、buildIndex、startJobs() 或 startFollowUpScheduler()、startChannels()（代替 startWecom）、startAlerts()
```

`initChannels` reject 时打印 reason 与 detail、`exit(1)`，其余一个都不调，cursor（文件或库里的）不动。`startChannels()` 给每个启用的企微账号起运行时：先按 R5 派发没结束的入站行，再起兜底轮询；回调随时可以进来，进来先等这个账号的加载。

环境变量：

| 变量                  | 进哪个 compose 服务 | 说明                                                                                                            |
| --------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_SECRETS_KEY` | app                 | 密钥环（R9）。库里有企微账号时必填。等同密钥，只在服务器的 env 文件里；恢复备份要用同一把，丢了只能重新录入凭据 |
| `WEB_RATE_PER_MIN`    | app                 | 网页渠道每个来源 IP 每分钟最多几条消息，缺省 20（开放问题 3）                                                   |
| `WEB_NEW_PER_IP_HOUR` | app                 | 每个来源 IP 每小时最多新建几个网页会话，缺省 10                                                                 |
| `WECOM_*`             | app                 | 已有。文件存储与还没导入时照旧用；库里有企微账号之后被忽略（R1、R13）                                           |

`/healthz` 加 `channels: { mode: 'env' | 'db', accounts, failing }`（只有个数，不带 key 与任何标识）；`failing` 是连续 10 分钟拉取失败或取不到 token 的启用企微账号数，大于 0 时 `ok` 为 `false`（外部拨测据此通知）。console 的 `/status` 给成员多带每个账号的 `{ key, kind, status, lastSyncAt, lastErrorCode, openInbox, cursorAgeSec, unknownSends24h }`。

### 入站：`channel_inbox`

```ts
// src/channels/inbox.ts —— 库里的企微账号用；env 账号照旧用 wecom-cursor.json
export interface InboxRow {
  id: string;
  accountId: string;
  msgid: string;
  kind: InboxKind;
  conversationId: string | null; // 消息、菜单点击：id 前缀 + external_userid
  sentAt: number | null; // 企微 send_time（毫秒）
  state: InboxState;
  attempts: number;
  messageSeq: number | null;
  payload: KfMessage | null; // 企微原样的消息；done、abandoned 时为 null
}
export interface PgInbox {
  /** 启动：这个账号的 cursor、恢复截止点、没结束的行（received、recorded、replied），按 received_at */
  load(accountId: string): Promise<{ cursor: string; recordOnlyUntil: number | null; open: InboxRow[] }>;
  /** 一个事务：这一页要记的条目插进 channel_inbox（冲突即跳过）、推进 cursor；返回本次真正新插入的行。冷启动时早于截止的直接记 abandoned（cold_start） */
  acceptPage(accountId: string, msgs: readonly KfMessage[], nextCursor: string): Promise<InboxRow[]>;
  /** 重新处理之前单独一个短事务：attempts + 1，返回加之后的值 */
  bumpAttempt(row: InboxRow): Promise<number>;
}

// src/store.ts（新增；随这个会话的下一次落库写进主事务，不在存档点里）
export function queueInboxState(
  sessionId: string,
  change: { inboxId: string; state: 'recorded' | 'replied' | 'done' | 'abandoned'; message?: ChatMessage; reason?: InboxAbandonReason },
): void;
/** 没有会话可挂的状态变化（回执、没建出会话的毒消息）：单独一个短事务 */
export function writeInboxStateNow(change: { inboxId: string; state: 'done' | 'abandoned'; reason?: InboxAbandonReason }): Promise<void>;
```

- **一页的处理。** `sync_msg` 返回一页 → `acceptPage`（插入与推进 cursor 同一事务；`message`、`menu_click` 插成 `received`、`attempts = 1`）→ 提交 → 新插入的行按会话排进处理链（同一会话串行、跨会话并发，02 的写法）。拉取途中收到停机信号，这一页不提交（cursor 不动、不插入），新进程补拉时再拿到。`acceptPage` 失败（库写不进去）时这一页不派发，下一次拉取重来：入站必须先落库，这一点不走 R6 的「照发」。
- **客户文本消息**（`kind='message'`，`state='received'`）：`handleMessage(sessionId, text, 'wecom', { msgid, sentAt, inboxId })`。引擎把客户消息写进会话的那一段同步代码里调 `queueInboxState(…, { state: 'recorded', message })`，与这条消息同一次落库提交，`message_seq` 取它分到的 seq。回复回来之后：静默（转人工等）→ `done`；有回复 → 「出站」一节的 `planOutbound`，`replied` 与分段同一次落库；全部分段有了结果 → `done`。
- **非文本消息**：适配器自己写占位（同 02），占位与 `recorded` 同一次落库；引导提示同样走 `planOutbound`。
- **菜单点击**（`menu_click`）：`applyConsentDecision` 改了会话，同一次落库记 `done`。
- **发送失败回执**（`send_fail`）：一个短事务里按 `fail_msgid` 把出站行改成 `failed` 并把入站行记 `done`；会话里的说明照 02 经会话落库。重复的回执不再加说明（02 规则）。
- **进入会话事件**（`enter_session`）：`acceptPage` 里直接记 `done`，只为去重；欢迎语照 02（`welcome_code` 20 秒就过期，崩溃后不补）。
- **恢复截止点**：`sent_at` 不晚于账号的 `record_only_until` 的 `message`、`menu_click`，不调引擎：客户消息（不在会话里时）照常写进会话、追加一条 system「恢复备份之后补记的客户消息，AI 没有回复：备份之后的处理记录已丢失，请人工确认是否已回复」（同一会话一次恢复只加一条），入站行记 `abandoned`（`restore_cutoff`），同一次落库。
- `messages.msgid` 仍不建唯一索引（02 的理由不变）；去重在 `channel_inbox` 上做，会话里同一 msgid 不会写第二遍。

### 出站：投递状态

```ts
// src/quota/ledger.ts（新增；库里的企微账号用，env 账号照 02）
export type OutboundPayload =
  | { msgtype: 'text'; text: { content: string } }
  | { msgtype: 'link'; link: { title: string; desc: string; url: string } } // 缩略图的 media_id 发送时现取，不进 payload
  | { msgtype: 'msgmenu'; msgmenu: { head_content: string; list: unknown[] } };
export interface OutboundIntent {
  msgid: string; // 我们生成，≤32 字节；重试与重启后的补发都用它
  accountId: string;
  sessionId: string | null; // 老客户欢迎语可能还没有会话
  inboxId: string | null; // 回的是哪条入站；人工回复、跟进、通知为 null
  kind: OutboundKind;
  segment: number; // 这一组里的第几段，从 0 起
  message: ChatMessage | null;
  payload: OutboundPayload;
}
/**
 * 一组分段切好之后同步调用：生成 msgid、记进内存账本（pending，计入已用条数）、排进这个会话的落库（主事务）；
 * inboxId 不为空时同一次落库把入站行改成 replied。没有会话的（老客户欢迎语）单独一个短事务，提交之后才返回
 */
export function planOutbound(
  account: ChannelAccount,
  sessionId: string | null,
  kind: OutboundKind,
  message: ChatMessage | null,
  inboxId: string | null,
  payloads: readonly OutboundPayload[],
): OutboundIntent[];
/** 每段第一次尝试之前：单独一个短事务改成 sending。写不进库返回 false，调用方照发（R6）并计数 */
export function markSending(intent: OutboundIntent): Promise<boolean>;
/** 结果：accepted / rejected / unknown，带 errcode 与尝试次数；随会话的下一次落库写，没有会话的单独短事务 */
export function settleIntent(intent: OutboundIntent, result: SendResult, detail: { errcode?: number; attempts: number }): void;
/** 不会再发：会话已有人接手，或所属入站行记了 abandoned（毒消息、过期、恢复截止）。原因只进日志 */
export function cancelIntents(intents: readonly OutboundIntent[], reason: 'taken_over' | 'inbox_abandoned'): void;
```

- **发一条 AI 回复的顺序**：引擎返回（回复已写进会话、排着落库）→ 适配器先确定要不要卡片（要的话先取缩略图：传不上去就按 02 的规则整段原文发，所以切分在取缩略图之后）→ 切分段、`planOutbound` → `flushSession`（至多 5 秒，R6）→ 每段：比接手代次（02）→ `markSending` → send_msg（同一段的重试沿用 msgid）→ `settleIntent` → 全部有结果之后入站 `done`。人工回复、跟进、付款确认、同意菜单本来就是「先落库后发送」（02 不变量 20、R17），分段的 `pending` 行加进它们那一次落库。
- **运行时才决定的补发**（卡片发失败之后补的「标题 + 链接」文字）另起一行，单独一个短事务写成 `pending` 之后再发。
- **窗口计数**（R18 的保守口径）：`pending`、`sending`、`accepted`、`unknown` 计入已用条数；`rejected`、`failed`、`cancelled` 不计。
- **工作台**：每条 AI 与人工消息下按它名下分段的最差状态显示：全部 `accepted` 不显示；有 `pending` 或 `sending` 显示「发送中」；有 `unknown` 显示「可能没送达」；有 `rejected` 或 `failed` 显示「没送达」（02 已有）；全是 `cancelled` 显示「未发送」。只读内存里的账本，不查库（02 不变量 9）。

### 重启、崩溃与恢复

启动时 `initChannels` 读出每个企微账号没结束的入站行，`startChannels` 在第一次拉取之前按 received_at 派发进各自会话的处理链。每一行先看能不能处理，再看停在哪一步：

| 条件（按顺序判）                       | 处理                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `attempts` 已到 3                      | `abandoned`（`poison`），会话加 02 的「客户有一条消息 AI 未能处理……请人工回复」，告警                       |
| `sent_at` 早于 48 小时                 | `abandoned`（`too_old`），会话加同一句（原因换成超过 48 小时）                                              |
| `sent_at` 不晚于 `record_only_until`   | 只补记、不回复（「入站」一节），名下 `pending` 的分段 `cancelled`、`sending` 的 `unknown`                   |
| `received`                             | `bumpAttempt`，照新消息处理                                                                                 |
| `recorded`，会话里这句之后有 AI 回复   | 按那条回复切分段、`planOutbound`、照常发（这条回复没进过 `replied`，说明一段都没发过）                      |
| `recorded`，没有 AI 回复，会话已转人工 | `done`                                                                                                      |
| `recorded`，没有 AI 回复               | `bumpAttempt`，以 `alreadyRecorded` 重跑                                                                    |
| `replied`                              | 名下 `sending` → `unknown`；会话有接手人 → `pending` 的 `cancelled` 并记「本轮未发送」；否则发 `pending` 的 |

- 记 `abandoned` 的行（任何原因），名下 `pending` 的分段一律 `cancelled`、`sending` 的记 `unknown`。
- 「会话里这句之后有 AI 回复」按 seq 判：`message_seq` 之后、下一条客户消息之前，`role='agent'` 且 `author` 为空或 `ai` 的第一条（欢迎语不算，02 的规则）。
- 停机：normal 段截止之后不再开始新的 send_msg（02 的规则不变），没发的分段留在 `pending`，重启后发一次、用同一个 msgid；不再需要 02 的「deferred 留在在途表」。
- 恢复手册（`deploy/backup.sh` 开头的恢复步骤，第 5 步解开 `var/` 之后、第 6 步起应用之前）加两步：确认 app 的 env 文件里是备份时的 `CHANNEL_SECRETS_KEY`；以 app 身份跑 `channel-account restore-cutoff --tenant <slug> --until <时间>`（开放问题 5 定取值）。不跑这一步就起应用，等于把快照之后旧实例处理过的消息当成崩溃重来，可能重复回复；启动时不拦，因为崩溃重启与恢复从库里分不出来。
- `deploy/backup.sh` 的 TABLE DATA 校验在表存在时加 `channel_accounts`、`channel_inbox`（02 的写法）。

### 会话 id、账号与回调

- 企微会话 id = 账号的 `id_prefix` + `external_userid`。入站时按收到消息的那个账号拼；出站（人工回复、跟进、付款确认）经 `accountForSession` 找账号。企微的默认账号是前缀为 `wecom:` 的那个（文件存储与还没导入时是 env 账号）。`isDemoClassId` 不变：`wecom:<key>:cust_…` 不是种子。
- 会话对象新增可选字段 `channelAccountId?: string`：非默认企微账号与网页会话写，默认账号的旧会话不补写（`NULL` 就是默认账号）。`conversations.channel_account_id` 是它的投影。
- 回调：`GET|POST /wecom/callback/:key` 与 `GET|POST /wecom/callback`（R12）。验签、解密与 02 相同，换成按账号取 Token 与 AES Key；`receiveid` 不等于账号的 `corp_id` 时不拉取（02 在没配 `WECOM_CORP_ID` 时不查，库里的账号一定有 `corp_id`）。明文里的 `Token` 交给按 `OpenKfId` 找到的那个账号的运行时去拉。明文里没有 `OpenKfId` 时（开放问题 4 待核实）按路由的账号拉。
- 两个账号在同一进程里：各自的 `sync_msg` 只带自己的 `open_kfid` 与自己的 access_token；入站行带自己的 `account_id`；一个账号停用之后它的回调不拉、它名下会话的推送返回 false（人工回复照 02 记「未能发送」）。

### 网页渠道

```ts
// src/adapters/web.ts
export const webAdapter: ChannelAdapter; // name: 'web'；push 发给这个会话所有在线的 SSE 连接，人工回复加「【顾问】」；客户不在线也返回 true（消息在历史里）
export function webConversationId(accountId: string, token: string): string; // 'web:' + sha256 前 32 位十六进制
export function subscribeWeb(sessionId: string, send: (ev: WebEvent) => void): () => void;
export type WebEvent = { type: 'push'; text: string } | { type: 'menu'; text: string; buttons: { id: string; label: string }[] };

// src/web/routes.ts 的响应类型（src/shared/channel-types.ts）
export interface WebMessage {
  role: 'customer' | 'agent'; // 不含 system
  text: string; // 人工回复带「【顾问】」前缀
  at: number;
}
```

| 路由                          | 鉴权与限流                                                                                                                                 | 行为                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /w/:key`                 | 公开；账号不存在或停用 404                                                                                                                 | `public/web.html`，服务端注入 `{ key, title, welcome, privacyLink }`；响应头带 CSP（`default-src 'self'`、`frame-ancestors 'none'`）与 `X-Content-Type-Options`                                                                                                                                                                              |
| `POST /api/web/:key/messages` | 要求 `x-web-chat: 1`（挡跨站表单，否则 403）；按 IP `WEB_RATE_PER_MIN`；新会话按 IP `WEB_NEW_PER_IP_HOUR` 与账号的 `dailyNewConversations` | 请求体 `{ text: string(1..1000), cid?: string }` 或 `{ menu: string, cid?: string }`。没有有效 cookie 就发一个。`cid`（`^[A-Za-z0-9_-]{8,64}$`）记成客户消息的 `msgid`：同一 cid 已在会话里、后面有回复就直接返回那条，正在处理返回 409 `in_progress`。返回 `{ reply: { text } \| null }`（转人工后为 null）。超过 `dailyTurns` 见开放问题 3 |
| `GET /api/web/:key/history`   | 没有 cookie 返回 `{ messages: [] }`；02 的 `lookupLimit`                                                                                   | 这个凭据对应会话窗口内的客户与 agent 消息，`WebMessage[]`；没有画像、system 消息、成员身份                                                                                                                                                                                                                                                   |
| `GET /api/web/:key/events`    | 没有 cookie 401；`lookupLimit`                                                                                                             | SSE：`push`、`menu`、每 15 秒 `ping`                                                                                                                                                                                                                                                                                                         |

- 公开路由白名单（02 R22）加：`/wecom/callback/:key`（验签）、`/w/:key`、`/api/web/:key/messages`、`/api/web/:key/history`、`/api/web/:key/events`。prod 下照常匿名可达，网页的三条只返回 cookie 对应的那一段会话；02 验收 9 的「枚举全部路由」自测随之更新。
- 每日上限的计数在内存里，按自然日清零；重启清零只会多放一些，不会误拦。
- cookie：`__Host-wv`，值是 32 字节随机数的 base64url，`HttpOnly; Secure; SameSite=Lax; Path=/`，`Max-Age` 取租户的 `retention_lead_days`。格式不对当作没有。pino 的 `redact` 盖住 `cookie` 与 `set-cookie`（02 已盖 `*.cookie`，这里核对 `set-cookie`）。
- 会话：`getOrCreateSession(webConversationId(account.id, token), 'web')`，写 `channelAccountId`；`handleMessage(id, text, 'web', { msgid: cid })`。不是 demo 类：落库、预载、按保留期清理、清除与行权删除都与企微的真实会话相同。
- 引擎：`channel === 'web'` 时 contextNote 多 R15 那一句；访客预算（`tryReserveVisitorLLM`）仍只管 `simulator`；付款入口的措辞照 02 的非企微分支（「付款链接」）。
- 同意菜单：引擎 `push(id, text, { kind: 'menu', category })` 时网页适配器发 `menu` 事件，按钮 id 用 `consentMenuButtonId`；点了就 `POST { menu: <id> }`，按 `parseConsentMenuId` 认、`applyConsentDecision` 记。客户不在线（没有 SSE 连接）时返回 false，按 02「再问一次」的规则处理。
- 页面：顶栏「AI 顾问在线」与开场第一句写明 AI 身份（00「AI 显式标识」，与 `chat.html` 同一口径）；发布了隐私说明时开场末尾带链接（02 不变量 40 的同一规则）；链接在页面里渲染成卡片（照 `chat.html`）。重置口令随 profile：demo 生效（02 R5，库里推进窗口）、prod 无效。
- console：渠道中文名加 `web` →「网页」，`simulator` 改为「演示」（只改 console 的文案，`admin.html` 不动）；工作台对网页会话不显示发送窗口与投递状态。

### 导入、导出与切换

```
# 以 app 身份运行（要读 .env 里的 CHANNEL_SECRETS_KEY 与 WECOM_*），要求应用已停（取租户锁），凭据只从标准输入读
src/cli/channel-import.ts   --tenant <slug> --key <key> [--name <名字>] [--var <dir>] [--dry-run] [--resync]
src/cli/channel-export.ts   --tenant <slug> --var <dir>
src/cli/channel-account.ts  list | add-wecom | add-web | set-secrets | set | rekey | restore-cutoff   --tenant <slug> …
```

退出码与 02 的命令行相同：0 成功或无操作，1 用法或读写出错（什么都不动），2 数据对不上（提示怎么办，什么都不动），3 拿不到租户锁。

- **channel-import**：要求 `CHANNEL_SECRETS_KEY` 与 `WECOM_CORP_ID`、`WECOM_APP_SECRET`、`WECOM_KF_OPEN_KFID`、`WECOM_CALLBACK_TOKEN`、`WECOM_CALLBACK_AES_KEY` 都在。租户还没有企微账号时，一个事务：插入账号（前缀 `wecom:`，凭据加密，`WECOM_POLL_INTERVAL_MS` 进 `settings`）；`var/wecom-cursor.json` 在就把 `cursor` 写进账号，`handled` 的每一项插成 `legacy`、`done` 的入站行（`received_at` 取记下的时间），`pending` 的每一项插成 `message`、`received` 的入站行（`payload` 原样，`attempts` 取 `tries`，`conversation_id` 取 `wecom:` + `external_userid`）；写一行 `channel.import` 审计（只有条数）。文件不在时 cursor 为空，第一次启动按 02 的冷启动处理。提交之后写标记文件，再把 `wecom-cursor.json` 改名为 `wecom-cursor.json.imported-<时间>`（都先写临时文件再改名，之后对目录 fsync，02 的写法）。打印账号 key 与各类条数，不打印任何凭据与标识。
  - 已经有这个账号、有标记、没有 `wecom-cursor.json`：已经导入过，退出码 0。有 `wecom-cursor.json`、没有标记（回退到 02 跑过一段）：退出码 2，提示加 `--resync`。`.env` 里的 `WECOM_CORP_ID`、`WECOM_KF_OPEN_KFID` 与库里的账号不一致：退出码 2。
  - `--resync`：`cursor` 换成文件里的；`handled` 按（账号，msgid）补插 `done`（已有的不动）；`pending` 补插 `received`（已有且已结束的不动，没结束的换成文件里的 `payload` 与 `tries`）；库里没结束、文件里没有的入站行记 `abandoned`（`resync`：02 期间已经由文件状态处理过）。之后同样写标记、改名，退出码 0。
  - `--dry-run` 只打印将写入的条数。
- **channel-export**（回退到 02 的镜像之前）：要求标记文件在、`.env` 里的 `WECOM_*` 与默认账号一致（否则退出码 2：回退之后 02 的镜像只认 env）。按 02 的格式写 `var/wecom-cursor.json`：`cursor`；`handled` 是默认账号 3 天内的入站行（最新的 5000 条，`[msgid, 毫秒]`）；`pending` 是它没结束的 `message` 行（`{ msg: payload, tries: attempts }`）。同一事务把默认账号名下 `sending` 的出站行改成 `unknown`、`pending` 的改成 `cancelled`（02 的镜像认 `unknown` 为可能已送达、不补发；`cancelled` 的那条回复在 02 的情况 4 里会按「没送出」补发一次）。然后删标记文件。没有标记、文件与库里一致时当无操作返回 0。
- **channel-account**：`add-wecom` 从标准输入读 `{ corpId, openKfId, appSecret, callbackToken, callbackAesKey }`，租户还没有企微账号时前缀取 `wecom:`，否则取 `wecom:<key>:`；`add-web --title <标题>`；`set-secrets` 从标准输入读三项凭据重新加密；`set` 改 `name`、`status`、`settings` 里的单项（欢迎语按 R19 校验）；`rekey` 把全部账号用环里的第一把密钥重新加密；`restore-cutoff --until <ISO 时间|now>` 给全部企微账号写 `record_only_until`，打印受影响的没结束入站行数；`list` 只打印 key、kind、name、status、前缀与「凭据已设置」，不打印 `corp_id`、`open_kfid`。每个写操作一行审计（`channel.account_create`、`channel.account_update`、`channel.secrets_update`、`channel.rekey`、`channel.restore_cutoff`），审计里只有 key 与改了哪几项的名字。
- **标记文件** `var/channels-in-db.json`（`{ tenant, account, at }`）表示「企微状态在库里」。`channel-import` 写、db 存储下库里有企微账号的启动补写、`channel-export` 删。它决定启动时的两个拒绝（`channel_state_in_file`、`channel_state_in_db`）和 `deploy.sh` 的回滚检查。
- **切换步骤**（demo 由 owner 在线上执行，第一次在本机 compose 上演练）：
  1. 以现状部署 03 的镜像（不加任何 env）：`/healthz` 的 `channels.mode = env`，`config` 的四个哈希与切换前相同（本阶段不改前缀），企微照常收发。
  2. 生成 32 字节随机数，`.env` 加 `CHANNEL_SECRETS_KEY=k1:<base64>`，同时存进 owner 保管 env 文件的地方（另记）。
  3. `docker compose stop app`；以 app 身份跑 `channel-import --tenant demo --key kf-main`，核对打印的条数。
  4. `docker compose up -d app`：`/healthz` 的 `channels.mode = db`、`accounts = 1`、`failing = 0`；console `/status` 里 `kf-main` 的 `lastSyncAt` 在一分钟内；用测试微信给 demo 客服发一句，收到一次回复，库里有它的入站行（`done`）与出站行（`accepted`）。第 3、4 步之间是停机，02 实测停 6 秒，这次多一个导入，预计半分钟以内，记进 plan；停机期间客户发的消息在起来之后按 cursor 补拉。
  5. 要演示正式网页渠道时：停 app，`channel-account add-web --tenant demo --key demo --title …`，起 app。
  6. 03 验收通过、确定不回退之后，从 `.env` 删掉 `WECOM_*`，重启一次核对仍正常。
- **回退到 02 的镜像**：`stop app` → `channel-export --var /app/var` → 确认 `.env` 里的 `WECOM_*` 还在 → 部署 02 的 tag。再切回：`stop app` → `channel-import --resync` → `up -d app`。
- **回滚检查**（`deploy/rollback-guard.sh`，含健康检查失败后的自动回滚）：目标镜像里没有 `src/channels/registry.ts`（03 之前的镜像），而服务器 `var/` 里有 `channels-in-db.json`，拒绝，退出码 5，打印上面的回退步骤（带项目名与端口，02 的写法）。与 02 的会话、条目版本两类风险可以同时出现，各自打印。两个都是 03 之后的镜像时照常回滚。

### 数据库

DDL 由 drizzle-kit 生成表、索引和约束；RLS、策略、触发器、函数、授权与列级授权写在 custom 迁移里（01「迁移纪律」）。两张新表都带 `tenant_id`，都套 01 的 RLS 模板（ENABLE、FORCE、`tenant_isolation`）。

```sql
CREATE TABLE channel_accounts (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  key                text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  kind               text NOT NULL CHECK (kind IN ('wecom_kf','web')),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  id_prefix          text,                -- wecom_kf：'wecom:' 或 'wecom:<key>:'
  corp_id            text,
  open_kfid          text,
  secrets_ct         bytea,               -- nonce(12) ‖ 密文 ‖ tag(16)（R9）
  secrets_key_id     text,
  cursor             text,                -- sync_msg 的 cursor；NULL 表示冷启动
  cursor_at          timestamptz,
  record_only_until  timestamptz,         -- 恢复截止点（R7）
  settings           json NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id_prefix),
  UNIQUE (tenant_id, open_kfid),
  CHECK (json_typeof(settings) = 'object'),
  CHECK (kind <> 'wecom_kf' OR (id_prefix IN ('wecom:', 'wecom:' || key || ':') AND corp_id IS NOT NULL
         AND open_kfid IS NOT NULL AND secrets_ct IS NOT NULL AND secrets_key_id IS NOT NULL)),
  CHECK (kind <> 'web' OR (id_prefix IS NULL AND corp_id IS NULL AND open_kfid IS NULL AND secrets_ct IS NULL
         AND cursor IS NULL AND record_only_until IS NULL))
);

CREATE TABLE channel_inbox (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL,
  msgid            text NOT NULL CHECK (octet_length(msgid) BETWEEN 1 AND 128),
  kind             text NOT NULL CHECK (kind IN ('message','menu_click','enter_session','send_fail','legacy')),
  conversation_id  text,                  -- 不建外键：会话可能还没建（同 outbound_sends）
  sent_at          timestamptz,           -- 企微 send_time
  received_at      timestamptz NOT NULL DEFAULT now(),
  state            text NOT NULL CHECK (state IN ('received','recorded','replied','done','abandoned')),
  reason           text CHECK (reason IN ('too_old','poison','cold_start','restore_cutoff','resync')),
  attempts         smallint NOT NULL DEFAULT 0,
  message_seq      int,
  payload          json,                  -- 企微原样的消息；done、abandoned 时置空
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, account_id, msgid),
  FOREIGN KEY (tenant_id, account_id) REFERENCES channel_accounts (tenant_id, id),
  CHECK ((state = 'abandoned') = (reason IS NOT NULL)),
  CHECK (state NOT IN ('done','abandoned') OR payload IS NULL)
);
CREATE INDEX channel_inbox_open ON channel_inbox (tenant_id, account_id, received_at)
  WHERE state IN ('received','recorded','replied');
CREATE INDEX channel_inbox_by_conv ON channel_inbox (tenant_id, conversation_id);
CREATE INDEX channel_inbox_finished ON channel_inbox (tenant_id, updated_at) WHERE state IN ('done','abandoned');

ALTER TABLE outbound_sends
  ADD COLUMN account_id uuid,             -- 02 的旧行为 NULL：env 账号
  ADD COLUMN inbox_id   uuid,
  ADD COLUMN segment    smallint NOT NULL DEFAULT 0,
  ADD COLUMN attempts   smallint NOT NULL DEFAULT 0,
  ADD COLUMN payload    json,             -- 进终态时置空
  ADD FOREIGN KEY (tenant_id, account_id) REFERENCES channel_accounts (tenant_id, id);
-- status 的 CHECK 换成 ('pending','sending','accepted','rejected','unknown','failed','cancelled')，另加
-- CHECK (status IN ('pending','sending','unknown') OR payload IS NULL)

ALTER TABLE conversations
  ADD COLUMN channel_account_id uuid,     -- NULL：渠道的默认账号（R11）
  ADD FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts (tenant_id, id);
```

- 触发器（custom 迁移，属主 `agent_owner`）：`channel_accounts` 的 BEFORE UPDATE，`key`、`kind`、`id_prefix`、`corp_id`、`open_kfid` 任何一个变了就报错；`updated_at` 由触发器写成 `now()`。
- `outbound_sends` 的 `payload` 在 `unknown` 时保留，供开放问题 4 核实之后按同一 msgid 补发；`account_id` 为 `NULL` 的旧行由 env 账号认领。
- 迁移 lint：换 `outbound_sends.status` 的 CHECK 要先 DROP 旧约束，标注 `-- migration-allow: drop-constraint 放宽 status 的取值，旧镜像写的值都在新集合里`；新加的两条 CHECK 命中 `add-check`，标注 `-- migration-allow: add-check 新列为空或取默认值，旧行都满足`。
- 01 的 `db.selftest.ts` 的表清单与权限期望表、`deploy/backup.sh` 的 TABLE DATA 校验同步扩充（都不在锁定清单里）。

授权（RLS 套件逐格断言；没有任何角色对新表有 DELETE 或 TRUNCATE）：

| 表                 | `agent_app`                                                                                                                                        | `agent_platform` |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `channel_accounts` | SELECT、INSERT；UPDATE 只限 `name`、`status`、`secrets_ct`、`secrets_key_id`、`cursor`、`cursor_at`、`record_only_until`、`settings`、`updated_at` | 无权限           |
| `channel_inbox`    | SELECT、INSERT、UPDATE                                                                                                                             | 无权限           |
| `outbound_sends`   | 沿用 02（SELECT、INSERT、UPDATE）                                                                                                                  | 无权限           |

清除与删除函数（沿用 02 的属主、`SECURITY DEFINER`、`search_path`、调用者须已在 `withTenant` 里、`p_now` 与 `now()` 相差不超过 5 分钟）：

```sql
-- 只 GRANT 给 agent_app；由 02 的每日 retention_purge 任务一并调用
purge_channel_inbox(p_tenant uuid, p_now timestamptz) RETURNS int
  -- 删 state 为 done、abandoned 且 updated_at 早于 p_now − 7 天的入站行；返回删除条数
-- 02 的 purge_conversation 与 erase_conversation：删除范围加 channel_inbox 里 conversation_id 是这个会话的行（任何状态），
-- erase_conversation 的返回值多一项 inbox
```

### 可观测性

- 日志：轮次与拉取里多带 `acct`（账号 key）；不写 `corp_id`、`open_kfid`、access_token、凭据与 cookie。企微接口出错只记接口名与 errcode，不记请求地址（地址里带 access_token）。pino 的 `redact` 加 `*.appSecret`、`*.callbackToken`、`*.callbackAesKey`、`*.access_token`、`*.secrets`。
- 告警（02 R24 加一个键 `channel`）：某个启用账号连续 10 分钟拉取失败或取不到 token；10 分钟内有「没落库就发」（R6）；恢复截止点让 N 个会话只补记未回复（一次）；毒消息（`poison`）。原有的 `wecom_send` 告警正文带账号 key。告警正文只有账号 key、计数与错误码。
- 运行数字不变；`unknownSends24h` 只在 `/status` 里给成员看。

### 测试与 CI

- 锁定的 7 组自测与 `eval/cases.json` 一行不改。`wecom.selftest.ts` 跑在文件存储、env 账号上，靠 R1 的文件后端照旧过；02 的 `wecom-02.selftest.ts`、`quota.selftest.ts` 走的是「文件存储」与「db 存储、库里没有企微账号」两条照 02 的路，断言不改。
- 新增套件，串进 `test`：
  - `src/channels/channels.selftest.ts`：密钥环的解析与拒绝；`sealSecrets` / `openSecrets` 往返、改一个字节、换 AAD、换 key id、旧密钥解、`rekey` 之后新密钥解；`initChannels` 的五个拒绝原因与「不留半装载」；标记文件的两个拒绝；`channel-import` / `channel-export` / `--resync` 的往返与退出码（子进程）；凭据明文不出现在命令行输出、审计行、日志（拦截 stdout、stderr 扫明文与密文的 base64）。
  - `src/adapters/wecom-03.selftest.ts`：假企微服务端支持两个 corp 与两个客服账号（按 `open_kfid` 与 token 分开记账）、按 msgid 记送达、可以挂住某个请求的回包；PGlite 与真实 PG（有 `PG_TEST_URL` 才跑）。覆盖：一页的提交与回滚、状态机每一格、出站的 `pending → sending → 结果`、回执、恢复截止点、两个账号交错与一个账号出错、回调按账号验签与 `OpenKfId` 分派、停机截止后留 `pending`。崩溃点用子进程加 `SIGKILL`，靠假企微与假模型的阻塞点造出时刻（02 `quota.selftest.ts` 的写法），不在产品代码里留按环境变量触发的钩子。
  - `src/web/web.selftest.ts`：路由、cookie 与 `x-web-chat`、`cid` 去重、历史投影、SSE、同意菜单、限流与每日上限、prod profile 下照常可用、没有 cookie 读不到任何会话、响应里没有会话 id、`web.html` 的页面契约（开场带 AI 身份、不读写 `localStorage` 里的凭据）。
  - 02 的 `db.selftest.ts`（不锁）加新表的 RLS、授权逐格、触发器拒改不可变列、`purge_channel_inbox` 拒删未到期、清除与删除连带入站行。
- 有意修改的非锁定断言（每条在对应步骤的 PR 里写明理由）：`db.selftest.ts` 的表清单与权限期望表；console 自测里渠道中文名的期望（`simulator` 改「演示」、加 `web`）；`console.selftest.ts` 里枚举全部路由的公开白名单。
- 压测（`scripts/load/run.ts` 加一组，不进 `test`，结果记进 plan）：两个客服账号各 25 个客户、各 10 轮，mock LLM 2–8 秒，真实 PG：每条客户消息恰好一次回复，每个（客户、轮次）恰好一组 send_msg，渠道多出的事务（每页一次、每段一次 `sending`）让一轮的 p99 增加不超过 50 毫秒。

## 与 02 及更早 spec 的关系

- **部分取代**（顶部 `Supersedes in part:`）02 的三处，都只在库里有企微账号时：R7 里企微 cursor 留在文件与三条缓解那一句（改为 R2–R7）；「一次落库」第 6 步存档点里的账本行（出站行改进主事务，trace 与护栏事件照旧在存档点里）；「企微：发送账本、回执与去重」里账本行随落库写进存档点那一句与五种情况（改为入站状态机与 R5 的补发规则）。文件存储与还没导入的 db 存储下这三处原文照旧，02 的自测照旧守它们。
- **不取代 02 R6**：`sim-` 访客与种子照旧是 demo 类、永不进 PG（02 不变量 11 照旧）。正式网页渠道是新渠道 `web`，它的会话本来就不在 R6 的范围里。开放问题 1 选 B（demo 入口改走正式网页渠道、访客会话进库）时，顶部再加「02 R6 的『网页访客会话只放内存』与不变量 6 对 demo 租户网页访客的例外」，改法写在开放问题 1 里。
- **不取代 02 R11**：`admin.html` 的匿名只读、`x-sim-session`、旧写接口都不动。
- **新增**走 Amends（顶部 `Amends:`）：02 的新表、新列、新状态与授权，清除与删除函数的删除范围，不变量 42 的表清单，R22 的公开路由，启动多一步与新的拒绝原因，`/healthz` 的 `channels`，告警键；01 的审计动作；后台 UX spec 的渠道中文名。
- 02 验收 31 的「恢复后在途客户恰好收到一次回复」在 03 由验收 6 重新验证，02 那一条的记录不改。
- 02 里写的「（04）」「（05）」（如非目标里的 `channel_inbox` 与渠道层 v2、多副本）是 2026-10-09 重排之前的编号，见总参考「分阶段路线」开头。

## 不变量

每条都能写成断言或测试。

入站与出站：

1. 库里的企微账号，cursor 只在把这一页要记的每一条写进 `channel_inbox` 的那个事务里推进；cursor 之前、要记的每条企微消息在 `channel_inbox` 里都有一行。
2. （`account_id`，`msgid`）在 `channel_inbox` 里至多一行；同一条企微客户消息至多写进会话一次。
3. 客户消息写进会话的那次落库提交时，它的入站行同时是 `recorded` 且 `message_seq` 等于这条消息的 seq；回复的出站行写进库的那次提交，入站行同时是 `replied`。
4. 库可写时，库里的企微账号每次调 send_msg 之前，这一段在 `outbound_sends` 里已有一行、状态已是 `sending`；同一段的每次尝试与重启后的补发都用这一行的 msgid。
5. 进入 `sending` 而没有结果的段，重启后记 `unknown`，在 `RESEND_UNKNOWN` 为假时不再发；`accepted`、`rejected`、`failed`、`cancelled` 的段永远不再发。
6. `done`、`abandoned` 的入站行不再被处理，`payload` 为空；进入终态的出站行（`unknown` 除外）`payload` 为空。
7. `sent_at` 不晚于账号 `record_only_until` 的入站，不调模型、不发送。
8. 有接手人的会话里，重启后不补发 AI 回复的分段。
9. 文件存储、以及 db 存储下库里没有企微账号时，企微的收发、去重与落盘与 02 相同（锁定的 `wecom.selftest.ts` 与 02 的企微自测不改断言照过）；库里有企微账号之后进程不再写 `var/wecom-cursor.json`。

账号与凭据：

10. `channel_accounts` 里的凭据只以密文存在；明文只在进程内存里；日志、审计、告警、`/healthz`、`/status`、命令行输出与错误信息里既没有明文也没有密文，也没有 access_token。
11. 一个账号的密文换到别的行（别的账号或别的租户）解不开。
12. 每个账号的 access_token、cursor、入站、同步互斥、轮询互不共享；一个账号取 token 失败或停用，另一个账号照常收发。
13. 会话 id 等于账号前缀加 `external_userid`；发往企微会话的每个分段都带它所属账号的 `open_kfid` 与那个账号的 access_token。
14. 回调只用路由所指账号的 Token 与 AES Key 验签；`receiveid` 不等于账号的 `corp_id` 时不拉取。
15. `channel_accounts` 的 `key`、`kind`、`id_prefix`、`corp_id`、`open_kfid` 写入之后不变；任何角色对 `channel_accounts`、`channel_inbox` 都没有 DELETE，入站行只经 `purge_channel_inbox` 与 02 的清除、删除函数删除。

网页渠道：

16. 网页会话 id 由账号 id 与访客凭据的哈希推出；任何响应、日志、审计里都没有访客凭据；不带凭据或凭据对不上的请求读不到任何会话的内容。
17. 网页渠道的读接口只返回请求者自己会话里的客户与 agent 消息，没有 system 消息、画像与成员身份。
18. `web:` 会话不是 demo 类：落库、按保留期清理，访客清理与上限（`sim-`）不碰它。
19. 只有 `channel === 'web'` 的会话 contextNote 多 R15 那一句；企微与模拟器会话的 contextNote、以及所有会话的 `promptPrefix()` 与开工时逐字节相同。

demo 与清理：

20. `sim-` 与 `wecom:cust_` 开头的会话及其订单永不出现在 PG 里（02 不变量 11 照旧）。
21. 一个会话被清除或删除之后，`channel_inbox` 里也搜不到它的 `external_userid`（02 不变量 42 的表清单加这一张）。
22. 锁定套件零修改；demo profile 下重置、匿名只读、种子保鲜、访客清理、模拟支付、AI 标识的行为与开工时相同。

## 验收标准

1. **锁定套件零修改。** 与开工提交相比，锁定清单里的文件 diff 为空；`pnpm test` 全绿；`PREFIX sha256` 的两个值与开工时相同。
2. **两条状态路径。** 文件存储下与「db 存储、库里没有企微账号」下，02 的 `wecom-02.selftest.ts`、`quota.selftest.ts` 不改断言照过；导入账号之后同一个实例跑一组对话，`var/` 下不再出现 `wecom-cursor.json`。
3. **cursor 与入站同一事务。** 假企微返回一页 3 条，让 `acceptPage` 的事务在提交前失败：cursor 不变、`channel_inbox` 里没有这 3 行、没有派发，下一次拉取拿到同样 3 条并各处理一次；提交之后立刻 `SIGKILL`：重启后这 3 条各回复一次。
4. **崩溃重启恰好一次**（真实 PG，子进程 `SIGKILL`）。分别杀在：模型生成途中（入站 `recorded`）；回复已落库、第一段还没开始发（`replied`、`pending`）；两段回复发完第一段、第二段还没开始；`markSending` 之后、请求到达假企微之前（假企微延迟接收）。每种重启后客户在假企微上收到的分段恰好是一整组、没有重复，补发的段与原段同一个 msgid，引擎在第二、三种情况下没有再调模型。再杀在「请求已到假企微、回包被挂住」：重启后不重发，假企微上恰好一组，库里那一段是 `unknown`，工作台这条消息显示「可能没送达」；自测经适配器的 `__channelTest` 把 `RESEND_UNKNOWN` 设为真重跑这一种：按同一 msgid 补发，假企微按 msgid 去重之后仍恰好一组。
5. **毒消息与过期。** 一条每次处理都让进程崩溃的客户消息：第三次重启时记 `abandoned`（`poison`）、会话里多一条说明、告警收到一条，之后的消息照常处理；`sent_at` 在 49 小时前的没结束入站行，启动后记 `too_old`、不调模型。
6. **备份恢复恰好一次**（本机 compose，照 02 第 26 步的演练）。三个客户 A、B、C 经假企微聊天；B 的第一次 send_msg 让假企微收下之后挂住回包 15 秒，期间跑 `backup.sh`；备份之后 C 再发一句、旧实例回复；然后停掉旧实例，记下停的时刻 T。照恢复手册恢复到新集群（`var/` 里已没有在用的渠道状态），`restore-cutoff --until T`，起应用。结果：B 在假企微上恰好收到一组回复；A 没有补发；C 备份之后那句在新库的会话里有、带「恢复备份之后补记」的说明、没有第二次回复；T 之后 D 发的一句回复一次；`/healthz` 的 `config` 哈希、会话数与原库一致。同一份备份不跑 `restore-cutoff` 再恢复一次，C 那句被再回一次——作为对照记进 plan，说明这一步不能省。
7. **两个账号互不串。** 同一实例三个企微账号（两个假企业各一个客服账号，其中一个企业再加第二个客服账号），同一个 `external_userid` 在三个账号上交错各发 5 句：三段会话、id 分别是 `wecom:…`、`wecom:<key>:…`；每个分段的 `open_kfid` 与 access_token 都是会话所属账号的；三个 cursor 各自推进；让第二个 corp 的 `gettoken` 一直失败：它的告警收到一条、`/healthz` 的 `failing = 1`，另两个账号收发不受影响；停用一个账号重启：它的回调只记日志不拉取，其余照常。
8. **凭据不外泄。** 跑完验收 2–7 与 11 的全部场景后，在采集的标准输出、标准错误、`audit_log`、告警内容、`/healthz`、`/status`、命令行输出里搜三项凭据的明文、密文的 base64 与 access_token，结果为零。把一个账号的 `secrets_ct` 复制到另一行、改一个字节、换掉 `CHANNEL_SECRETS_KEY`：三种都以 `channel_decrypt` 拒绝启动，detail 里只有账号 key 与 key id；不设 `CHANNEL_SECRETS_KEY` 以 `channel_key_missing` 拒绝。`rekey` 之后去掉旧密钥照常启动。
9. **回调路由。** `/wecom/callback` 与 `/wecom/callback/<key>` 各自用自己账号的 Token 通过企微后台的地址校验（GET），用别的账号的 Token 签的请求不拉取；不存在的 key 的 GET 返回 404、POST 回 `success` 并记一行日志；同一 corp 的两个客服账号共用一个回调地址，事件按 `OpenKfId` 拉对应的账号。
10. **导入、导出与回退。** 用一份含 cursor、200 条 handled、2 条在途的 `var/wecom-cursor.json` 导入：条数对上，标记文件写了，原文件改了名；在途的 2 条重启后各回复一次；再导入一次退出码 0；应用持锁时退出码 3；`.env` 的 `WECOM_KF_OPEN_KFID` 改一位后 `--resync` 退出码 2。导出：生成的文件被 02 的镜像（或文件后端）读进来照常收发、没有重复回复；之后文件路径下再聊几轮、`--resync` 切回：库里的 cursor 是文件的，几轮里的消息都是 `done`，没有重复回复。文件存储下有标记文件以 `channel_state_in_db` 拒绝；库里有企微账号而 `var/` 里有未导入的 `wecom-cursor.json` 以 `channel_state_in_file` 拒绝。
11. **网页渠道。** 新浏览器打开 `/w/<key>`：开场第一句带 AI 身份；发一句收到回复，响应带 `__Host-wv`（HttpOnly、Secure、SameSite=Lax），库里有 `web:` 会话；刷新后历史在；顾问在 console 接手并回复，在线时 SSE 立即收到「【顾问】…」，关页再开历史里有；另一个浏览器（没有 cookie）读历史为空、连 SSE 得到 401；所有响应体里搜不到会话 id 与凭据；不带 `x-web-chat` 的 POST 403；同一 `cid` 连发两次只记一条、两次拿到同一条回复；提到「我妈有高血压」弹出同意按钮，点「同意」记 `granted`；超过每分钟条数返回 429；prod profile 下以上照常，`/chat.html` 仍是 404。清理：把租户的线索保留期设 7 天，一个 8 天前的网页会话连同消息、trace 被清除，console 里也没有它。
12. **网页话术。** 自动：同一组对话分别在 `wecom`、`simulator`、`web` 会话上跑 mock：前两者每轮发给模型的 contextNote 与开工时逐字节相同，`web` 多 R15 那一句，三者的 system 与 tools 哈希相同。手动（花钱，不进 CI）：真实模型在网页会话里跑 6 遍「我要人工」与 6 遍「能帮我问下顾问吗」，回复里说「在微信上联系」的次数记进 plan，作为开放问题 2 的依据。
13. **demo 照常。** 导入账号之后的 db 存储下：网页模拟器与企微的「重置」都生效；种子保鲜、`sim-` 访客清理与上限、`admin.html` 匿名只读（只见种子与自己的 `sim-`）与旧写接口、模拟支付、AI 标识都照旧；`admin.html` 匿名列表里没有 `web:` 会话。
14. **出站投递状态。** 工作台里：正常发出的回复不显示状态；让假企微挂住回包时显示「发送中」；回执 4 之后显示「没送达」（02 已有）；验收 4 的结果不明显示「可能没送达」；接手打断的那一组显示「未发送」。窗口剩余条数把 `pending`、`sending` 算进已用。
15. **清理与删除。** 每日任务之后，8 天前结束的入站行没了、6 天前结束的还在、没结束的不管多旧都在；`agent_app` 对 `channel_inbox`、`channel_accounts` 的 DELETE 报 permission denied；改 `channel_accounts.open_kfid` 报错；对一个企微会话执行 `erase-conversation` 之后，`channel_inbox` 里搜不到它的 `external_userid`，返回值带 `inbox` 条数。
16. **停机。** 模型在 normal 段截止之后才回包：不开始 send_msg，入站停在 `replied`、分段 `pending`；重启后发一次、msgid 与停机前生成的相同、不调模型。
17. **切换与回滚检查。** 本机演练与线上各按「切换步骤」走一遍：切换前后 `config` 的四个哈希相同；`channels.mode` 从 `env` 变 `db`；停机时长与条数记进 plan。本机演练里：有 `channels-in-db.json` 时 `deploy.sh` 拒绝回滚到 02 的镜像（退出码 5）并打印回退步骤；`channel-export` 之后放行；两个 03 镜像之间照常回滚。
18. **欢迎语按账号。** 不设 `welcomeText` 时新客户收到的欢迎语与开工时逐字节相同；`set --setting welcomeText=…` 设一段第一句不含「AI」的文字，命令行以 1 拒绝、库不变；设一段合格的，重启后新客户收到它。
19. **压测。** 按「测试与 CI」的压测一组跑完，通过条件全部满足，数字记进 plan。

## 开放问题

1. **demo 的公开网页入口要不要改走正式网页渠道。** 开工前定（决定网页渠道那几步与顶部要不要加 R6 的部分取代）。依据：demo 的用途（给潜在客户看产品、给公众试聊）与 02 R6、不变量 6 的取舍。
   - A（推荐）：不改。`guide.html` 照旧指向 `chat.html`，`sim-` 访客照旧是 demo 类（匿名可读、24 小时清理、5000 封顶、不进库），02 R6 不动。正式网页渠道在 demo 上另开一个 `web` 账号（`/w/demo`），要演示时把链接给对方。访客看到的回复与正式渠道是同一个引擎，差别只在存储；不用为 demo 在库里开删除通道。代价：公开流量不走正式渠道，正式渠道的问题要靠测试与真实租户暴露；两个聊天页面要分别维护（`chat.html` 本来就被锁定自测钉住，删不掉）。
   - B：`guide.html` 改指 `/w/demo`，demo 的公开访客走正式网页渠道、会话进库。要保住 demo 行为得另加：`tenants.demo_visitors`（只有 `agent_platform` 能改）与 SECURITY DEFINER 函数 `prune_web_visitor`，只在这个租户上、只删 `web:` 且没有已付订单的会话，闲置 24 小时或超过 5000 个时删最旧的（等于在 02 不变量 6 上为 demo 租户开一个口子）；匿名访客在 `admin.html` 实时看到自己的会话，可以由服务端在匿名列表里按 cookie 算出本人的 `web:` 会话（`admin.html` 一行不改，推荐），也可以在 console 加一个匿名只读视图（要给 console 加匿名路由与 J 页的只读变体，工作量大一截）；重置照 02 R5。约多 3–4 个工程日，顶部加「02 R6 的『网页访客会话只放内存』」的部分取代。
   - 种子会话两种选法都不进库（R16）。
2. **网页渠道接真实客户时，SOP 里的微信措辞怎么办。** 给第一个真实租户开 `web` 账号之前定。依据：验收 12 手动部分的结果，以及那个租户的 SOP。
   - A（推荐）：本阶段只加 R15 的 contextNote；开 `web` 账号之前，运营在 console 里把这个租户 SOP 里「在微信上联系」一类的说法改成渠道中立的（发布闸照旧），中立模板随阶段 4 做。
   - B：再加一道确定性护栏，`web` 会话的出站文本里「在微信上联系您」一类说法换成「顾问会在这里回复您」，带自测（AGENTS.md：新护栏必须带自测）。自然语言的替换容易漏，也容易误伤。
   - C：网页渠道等阶段 4 的中立模板再开给真实租户，本阶段只在 demo 上开。
3. **网页渠道的防刷与成本上限。** 开工前给出默认值（下面的推荐），接真实租户之前按它的流量改。依据：网页入口公开、匿名，每轮调真实模型。
   - 推荐：每个 IP 每分钟 20 条、每小时新建 10 个会话（env）；每个账号每天新会话 500 个、调模型的轮次 3000 次（账号设置）。超过 IP 限流返回 429；超过每日上限时客户的话照常记进会话、不调模型，回固定的一句「现在咨询的人有点多，顾问会在这里回复您」并转人工（类型 `request`），告警一条。
   - 备选：超过每日上限直接 503、不记客户的话（省事，但客户说的话没人看见）；或者像网页模拟器一样降级到离线脚本（真实客户拿到的是固定话术，02 说过真实客户永不降级）。
4. **企微接口行为的待核实点**（承接 02 开放问题 8）。接第一个真实租户之前在测试客服账号上实测，结论记进 plan，只改 `src/quota/ledger.ts` 与适配器里的常量。
   - 同一 msgid 重发时企微是去重还是当新消息：去重的话 `RESEND_UNKNOWN` 改为真，结果不明的段按同一 msgid 补发，崩溃落在请求途中也恰好一次；核实之前为假（只会少发）。
   - 回调明文里有没有 `OpenKfId`：有，几个客服账号共用一个自建应用时配一个回调地址就够；没有，每个账号各配一个应用与回调地址（R12 照样能用，只是分派那一步用不上）。
   - 48 小时 / 5 条是否按客服账号分开算：分开算，R11 的「两段会话、各自的窗口」就对；按企业算的话，同一客户在两个账号上的窗口要合并计数。
   - `sync_msg` 能拉到多久以前的消息：决定入站行留 7 天是否够（02 已列）。
5. **恢复截止点取什么时刻。** 写恢复手册那一步之前定。依据：恢复时宁可漏回（由顾问补）还是宁可重复回。
   - 推荐：取旧实例最后一次正常回复的时刻，有告警时从「健康检查失败」「app 反复重启」那一条往前推；拿不准就取恢复开始的时刻。之前的消息只补记、给顾问看，之后的照常回复。
   - 备选：取备份的时刻（快照之后旧实例回过的消息会再回一遍，但不会漏回）；或不设（同上，且旧实例停机之前那段也会再回）。

## 被否决的方案

- **只把去重集合搬进库、cursor 留在文件**：cursor 和入站记录还是两份存储、不在同一时刻，恢复与崩溃时照样一边新一边旧。
- **发送之后再记账本**（02 的做法）：「已发出、没记账」这个窗口就是 02 演练复现的那一个；崩溃或备份落在里面，重启就补发。
- **回复的 msgid 由入站 msgid 推出，恢复后重新生成的回复靠企微按 msgid 去重挡掉**：依赖还没核实的接口行为；重新生成的回复与客户实际收到的可能不同，库里记的就不是客户看到的；恢复截止点不依赖它。
- **恢复后按 `sync_msg` 里我们自己发出的消息对账**：没核实 API 发出的消息会不会出现在 `sync_msg` 里、带不带我们的 msgid；对不上的情况还要另一套规则。
- **按消息的年龄自动判「旧消息只记不回」，不要恢复截止点**：崩溃重启与恢复从库里分不出来；正常停机半小时后客户等着的消息也会被当成旧消息不回。
- **启动时发现 env 里有 `WECOM_*`、库里没有账号就自动导入**：镜像风险与数据迁移绑在同一次启动里；02 的切换就是先按旧行为部署新镜像、再停机导入，回退也只动一处。
- **凭据用 pgcrypto 在库里加解密，或把密钥也存进库**：密钥与密文同在备份里等于没加密；pgcrypto 让明文出现在 SQL 语句里，可能进慢查询日志。
- **access_token 存库**：两小时就过期，换进程重新取即可，没必要让它进备份。
- **每个账号一个进程或一个容器**：一家一个实例、账号个位数，进程内按账号建键就够；多进程要另做选主与共享状态。
- **原地改造网页模拟器（沿用 `sim-` 前缀或 `/api/chat`）**：锁定的 `server.selftest.ts` 钉住了 `chat.html` 的存储键与 id 生成、`/api/chat` 只认 `sim-`、`sim-` 的清理与上限；`sim-` 还是「凭 id 匿名可读、24 小时删」的 demo 数据。
- **网页会话 id 直接用访客凭据**（`sim-` 的做法）：id 会出现在后台、日志、审计和工作台的地址里，等于凭据外泄。
- **访客凭据放 `localStorage`、经请求头带**：SSE 带不了自定义请求头，只能进 URL（进反代访问日志）；HttpOnly cookie 页面脚本读不到。
- **同一客户在同一租户的几个企微账号上合成一段会话**：在客户的微信里它们是几个对话窗口；合成之后回复从哪个账号发、发送窗口怎么算、历史怎么合都要另定。
- **链接显式产出、消息部件放进 03**：改的是引擎出口契约，锁定断言钉住了现在的形状；阶段 4 的护栏流水线本来就要重写出口，一起做只改一次。
- **渠道中立的提示词放进 03**：demo 租户的 SOP 不能动，新租户本阶段只有一家一个实例、SOP 由运营直接写；中立模板属于行业包模板，随阶段 4 做。
- **种子会话进库**：保鲜每小时平移消息时间戳，库里的消息只追加；进库就得每次删了重灌，等于为 demo 开一条删除通道。
- **渠道账号放进 console 管理**：要做开通流程、凭据录入的界面与权限，属于阶段 4 的开通；本阶段命令行加停机够用。
- **用 Redis 或消息队列存入站**：02「不做的事」的理由不变，单副本下 Postgres 一张表就够，还能和会话同一事务。
