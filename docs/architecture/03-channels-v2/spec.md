# 03 · 渠道层 v2

Status: draft
Phase: 3 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」（2026-10-09 重排之后的编号）
Depends on: [02 · 会话入库 + 坐席工作台](../02-conversations-workbench/spec.md)（开工时须已 implemented：PG 会话存储与每会话写队列、spill、发送账本、清除与删除函数、任务表、告警）；[01 · Postgres 底座 + 配置入库 + 后台 v0](../01-pg-config-console/spec.md)（`withTenant`、三个角色、RLS 模板、租户锁、启动顺序、审计）。选型见 [ADR-001](../../adr/adr-001-postgres-drizzle.md)
Amends: 02 的「数据库」（新表 `channel_accounts`、`channel_inbox`；`outbound_sends` 的新列与三个新状态；`conversations.channel_account_id`；授权；清除与删除函数的删除范围加 `channel_inbox`，新函数 `purge_channel_inbox`）、「identity map 与写入 · 停机」（spill 条目多一段渠道行）、02 不变量 42（表清单加 `channel_inbox`）、02 R22（公开路由加企微按账号的回调与网页渠道三组）、「两种会话存储与启动」（`initChannels` 一步、新的启动拒绝原因、`/healthz` 的 `channels`）、02 R24 与「可观测性与告警」（日志脱敏认新的会话 id 形状、新告警键 `channel`、告警带账号 key）；01 的「审计」（新动作）；00 的「部署 profile 与开关」（新开关 `web_channel`，demo 默认开、prod 封顶为关）；后台 UX spec 的渠道中文名（加 `web`→「网页」，`simulator` 改叫「演示」）。只做新增或收紧
Supersedes in part: [02](../02-conversations-workbench/spec.md) 的 R7「企微 cursor：留在 `var/wecom-cursor.json`（开放问题 5），同时做三条缓解……」那一句与「推迟」格的 `channel_inbox`（04）；「identity map 与写入 · 一次落库」第 6 步把账本行整体写在存档点之内；「企微：发送账本、回执与去重」里「账本行随会话的下一次落库写（存档点之内……）」一句，与「去重与重放对齐」的五种情况；「identity map 与写入 · 停机」里 spill 文件「trace 与账本行不写」中的「账本行不写」（库里账号的出站行要进 spill，R21）。四处都只在企微状态「在库里」时（R1）被取代，文件存储、以及企微状态是「未导入」「已导出」的 db 存储下原文照旧。原因：02 第 26 步的恢复演练复现了重复回复（备份落在「回复已发出、账本行还没落库」那不到 2 秒的窗口里），02 开放问题 5 的裁决是「复现了就在接第一个真实租户之前另写 spec 提前做」，owner 2026-10-09 确认；这几处的机制本身就是那个窗口的来源，改成「先落库、后发送」才能消掉它，见「与 02 及更早 spec 的关系」

## 背景与问题

02 之后会话、消息、订单在 Postgres 里，企微的拉取状态还在 `var/wecom-cursor.json`：cursor、已处理的 msgid 集合（3 天、至多 5000 条）、在途表（已认领、没处理完的客户消息连同原文）。发送账本（`outbound_sends`）在 send_msg 有了结果之后才排进会话的下一次落库，而且写在 trace 的存档点里。02 的恢复演练（plan「实施记录 · 第 26 步」、「验收记录」第 31 条）把这两点合起来的后果跑了出来：备份恰好落在「回复已发出、账本行还没落库」的那一刻，恢复后的进程认为这条回复没送出，又发了一遍。现状里决定 03 必须先定死的几处：

- **cursor 和会话不在同一份存储里。** `pg_dump` 与打包 `var/` 不是同一时刻；进程崩溃时也只有文件那一侧是同步落盘的。02 的三条缓解（客户消息带 msgid 按五种情况去重、备份顺序、重放看账本）缩小了窗口，消不掉它。其中备份顺序一条没有落实：02 R7 写的是「先打包 `var/` 再 `pg_dump`」，`deploy/backup.sh` 实际是先 `pg_dump` 后打包 `var/`（本次读代码发现，R19 改回来）。
- **发送在记账之前。** 账本行要等 send_msg 回包才排进落库，再等一次落库才提交；这中间崩溃或被备份截住，重启后的进程看不到「发过」，按 02 的情况 4 补发，补发的还是一个新的 msgid（plan 第 26 步原话）。
- **企微是一个全局单例。** `src/adapters/wecom.ts` 的 access_token、cursor、去重集合、在途表、同步互斥、轮询定时器、欢迎语去重、缩略图缓存都是模块级变量；凭据每次从 `.env` 的 `WECOM_*` 现读；会话 id 是 `wecom:<external_userid>`，不带账号；回调只有一个 `/wecom/callback`。一个实例只能接一个客服账号，同一租户第二个客服账号进来就会串。
- **凭据只能放 env。** AGENTS.md 的硬规则给按租户的渠道凭据留了一个例外：可以加密存库、密钥在 env 文件（重排之前写的是 phase 04，本分支已改成 phase 03）。第一批「一家客户一个实例」用不上多租户，但换凭据、加第二个客服账号不该再改 env 重建容器。
- **网页模拟器不是渠道。** `sim-` 会话按 demo 数据处理：凭 id 匿名可读、闲置 24 小时删、总量 5000 封顶、永不进 PG（02 R6）。锁定的 `server.selftest.ts` 把它钉得很死（`chat.html` 的存储键与 id 生成、`/api/chat` 只认 `sim-`、访客清理与上限、`x-sim-session`），所以「转正」只能是照着它另起一个正式渠道，不能原地改。
- **话术是按企微写的。** 「顾问会在微信上联系您」写在旅游包 SOP 的锁定节里（能力边界、我们没有的目的地、转人工条件），console 改不了锁定节，SOP 契约检查还要求这句话存在（`src/sop/contract.ts` 里 id 为 `advisor-on-wechat` 的规则，它的 `text` 就是这句）；引擎的确定性回复、`create_order` 的 `payNote`、价格规则护栏的替换句也写着「在微信里」。网页渠道的客户不在微信里，这些对他们是错的承诺。

本阶段要把「之后改不起的东西」定下来：入站记录的去重键、顺序与状态机，cursor 与入站同一事务，出站「先落库后发送」的投递状态与状态迁移，渠道行与会话落库的事务边界（含 spill 与 poisoned），恢复截止点，渠道账号的表与凭据加密的格式，按账号拆开的运行时与会话 id 规则，按账号的回调路由，网页渠道的名字、id、凭据与页面安全，从 env 到库的导入与回退。粗估约 23 个工程日，plan 里细化。

## 目标

1. 企微状态在库里时（R1），企微的 cursor 只在把这一页消息写进 `channel_inbox` 的同一个事务里推进；客户消息写进会话与入站记录改状态在同一事务；出站分段在调 send_msg 之前已在库里。进程崩溃重启、按恢复手册从备份恢复之后，**同一条客户消息的回复不会发两遍**；崩溃恰好落在某一段的请求途中时，这一段可能漏发，库里记 `unknown`、工作台显示「可能没送达」，由顾问补（R5，开放问题 7 已接受为已知边界）。02 演练复现的窗口消失。「不重复」不覆盖两种已写明的例外：库写不进去期间（R6）照发之后、结果落库之前进程崩溃，这一组可能再发一次；会话已 poisoned、它的渠道行短事务也一直写不进去、进程又被硬杀（R21），这段时间的消息可能再答一遍。两种都有告警。
2. 出站消息记投递状态：在 02 的发送账本上补齐「待发送、发送中、已取消」，有一张所有写入方共用的状态迁移表，工作台按它显示；同一分段的每次尝试与重启后的补发都用同一个 msgid。
3. 企微凭据按账号存进 `channel_accounts`，加密存库、密钥在 env 文件；明文只在进程内存里。access_token、cursor、入站、同步互斥、轮询按账号拆开；回调路由按账号。本阶段线上仍是一个实例一个租户一个客服账号，但同一实例跑两个账号互不串。
4. 现有 `.env` 里的 `WECOM_*` 与 `var/wecom-cursor.json` 能导入库里，也能导出回去、回退到 02 的镜像；部署脚本的回滚检查认得这一步。
5. 网页渠道转正：新渠道 `web`、会话 id 前缀 `web:`、访客凭据放 HttpOnly cookie、会话进 PG、按保留期清理；demo 下按账号开；prod 下本阶段不开放（产品限制，开放问题 2 定 A：开关 `web_channel` 在 prod 封顶为关，阶段 4 的渠道中立锁定节出来之后再放开）。网页模拟器（`sim-`）与它的全部 demo 行为照旧。
6. 锁定套件零修改；`promptPrefix()` 不变；demo 行为（重置、匿名只读、种子保鲜、访客清理、模拟支付、AI 标识）照旧。

## 非目标

- 同一部署服务多个租户：公开路由按域名或 `SECURITY DEFINER` 函数解析租户、从模板开通租户、按租户的 LLM 预算、跨租户的进程内缓存泄漏测试（阶段 4）。本阶段只把键带上（R20）。
- 行业包抽取、cases v2 导出、中文通用解析与工具注册表（阶段 4）。
- 护栏重构成有序 Guard 流水线、阈值与币种改配置（阶段 4）。
- 链接由引擎显式产出、消息部件、渠道能力描述（阶段 4，R17）；渠道中立的 SOP 锁定节（阶段 4，R18；开放问题 2 定 A，本阶段 prod 不开放网页渠道）。
- 政策单一来源、知识库、售后退改、看板拆分、trace 查看器（阶段 5）。
- 多副本：fence read、每会话 advisory lock、企微拉取选主（阶段 6，按信号）。本阶段仍只跑单副本，靠 01 的租户锁拒绝第二个进程；`channel_inbox` 按（账号，msgid）冲突即跳过的写法不妨碍以后选主。
- 在 console 里增删改渠道账号：本阶段只有命令行，改完重启生效（R8）；console 的账号页随阶段 4 的开通一起做。
- 网页渠道嵌进第三方网站（iframe）：要按账号的 `frame-ancestors` 白名单、`SameSite=None; Partitioned` 的 cookie 与各浏览器第三方存储分区的兼容测试；本阶段只做独立页面 `/w/:key`（在浏览器或微信内置浏览器里打开），`frame-ancestors 'none'`。按需求另议。
- 网页渠道的自动跟进：客户关掉页面就没有触达通道，`followup.ts` 照旧只追企微。
- 认证服务号、海外渠道（阶段 6 的候选）。

## 前置条件

开工时逐项核对，缺一项就停下：

- 02 是 `Status: implemented`（owner 确认验收、02 plan 第 27 步已勾）。03 plan 第 1 步在 02 顶部加 `Superseded in part by:`（列本 spec 顶部 `Supersedes in part:` 的四处）与 `Amended by:`；00、01、后台 UX spec 顶部各加 `Amended by:`（00：部署开关 `web_channel`）。02 还没 implemented 时本 spec 不开工：它的条款要由 02 的最终文本来对。
- `AGENTS.md` 的凭据例外已写成 phase 03（本 spec 所在分支一并改了）。
- 线上 demo 以 `SESSION_STORE=db`、`CONFIG_SOURCE=db` 运行（02 第 27 步）。
- `pnpm test` 在开工提交上全绿；记下锁定文件清单与各自的 sha256（`src/*.selftest.ts` 的 6 个、`src/adapters/wecom.selftest.ts`、`eval/cases.json`）与 `PREFIX sha256` 的两个值。
- 开放问题 1–3、5–8 已由 owner 在 2026-10-09 全部定下（见「开放问题」开头的裁决表），不阻塞任何步骤；4 是接第一个真实租户之前在测试客服账号上做的实测（与 02 plan「上线清单」里企微额度实测那一项合并），不阻塞开工。

## 从总参考与 02 接过来的事项

| 事项                                                                     | 来源                                                         | 03 的处理                                                             | 见       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------- | -------- |
| `channel_inbox` 按（账号，msgid）去重；cursor、已处理集合、在途表搬进 PG | 总参考原阶段 4「渠道层 v2」；02 开放问题 5；02 plan 上线清单 | 与 cursor 同一事务插入；状态机；取代 handled 集合与在途表             | R2、R3   |
| 出站消息记投递状态                                                       | 总参考                                                       | 在 `outbound_sends` 上扩列与状态，先落库后发送                        | R4、R5   |
| 恢复后在途客户不重复收到回复                                             | 02 验收 31（未通过，按开放问题 5 处理）                      | 同一份 `pg_dump` 一致；恢复截止点与哨兵文件                           | R7       |
| 每账号加密存凭据，独立的拉取和回调路由                                   | 总参考                                                       | `channel_accounts`、AES-256-GCM、每账号运行时、`/wecom/callback/:key` | R8–R12   |
| 企微全局单例（access_token、cursor、在途表、同步互斥）按账号拆开         | 总参考原阶段 4「同一部署多租户」                             | 本阶段做                                                              | R10      |
| 网页渠道转正（新的渠道名和 id 前缀）                                     | 总参考                                                       | 新渠道 `web`，模拟器原样                                              | R14、R16 |
| 链接由引擎显式产出                                                       | 总参考                                                       | 推到阶段 4                                                            | R17      |
| 渠道中立的提示词只用于新租户，demo 租户逐字节不动                        | 总参考                                                       | 锁定节推到阶段 4（开放问题 2）；引擎固定话术与工具提示本阶段按渠道分  | R15、R18 |
| 回执把一条回复记成 failed 之后，重放时情况 4 会把它原样再发一次          | 02 plan「实施记录 · 第 12 步」顺带记下的一处                 | `failed`、`rejected` 都不补发                                         | R5       |
| 接手之后、发送之前崩溃，重启时会补发那条 AI 回复                         | 02 plan 第 12 步「注意（第 13 步）」                         | 已接手的会话里没发的分段记 `cancelled`；发送前后各比一次接手代次      | R5       |
| 02 R7 写「备份先打包 `var/` 再 `pg_dump`」，`backup.sh` 实际顺序相反     | 本次读代码发现                                               | 改回 02 R7 的顺序（env 账号的文件状态仍靠它）                         | R19      |
| 02 的在途重放只给每个客户的队头计次                                      | `src/adapters/wecom.ts` 的 `replayInflight`                  | 真正开始处理时才计次                                                  | R3       |
| 第一批真实客户一家一个实例，同部署多租户不在本阶段，但不能把单例写得更深 | owner 2026-10-09                                             | 新表都带 `tenant_id`，运行时按账号 uuid 建键                          | R20      |

## 开工前裁决

| #   | 问题                                           | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 本阶段落地                                                    | 推迟                       |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------- |
| R1  | 什么时候走渠道层 v2                            | 账号有两个来源、企微状态有两个后端。文件存储：`WECOM_*` 配齐就拼出一个 env 账号，状态在 `var/wecom-cursor.json`，行为与 02 相同（锁定的 W1 守它）。db 存储下按库里本租户的 `wecom_kf` 行分三种企微状态，互不混用：**未导入**（一行都没有）与 **已导出**（只有默认账号一行、状态 `exported`，`channel-export` 之后；这期间 `add-wecom`、`add-web` 以 2 拒绝，先 `--resync`）——同上（照 02），启动日志一行写明是哪一种；这让 03 的镜像能先按 02 的行为部署，再停机导入，与 02 的切换同一个拆法。**在库里**（有任何一行不是 `exported`，`active` 或 `disabled` 都算）——只用库里的账号，`active` 的起运行时、状态在 `channel_inbox`、出站先落库；全部 `disabled` 时不起企微（运维停用）；env 里的 `WECOM_*` 一律忽略，启动日志点名变量名（不写值）。下文「企微状态在库里」都指第三种。网页渠道只在 db 存储下、库里有 `web` 账号时存在。不另设开关                                                                                                                                                                     | `src/channels/registry.ts`                                    | —                          |
| R2  | 入站去重、顺序与 cursor                        | `channel_inbox` 以（`account_id`，`msgid`）唯一，另有自增的 `ord` 定顺序（同一页的 `received_at` 相同、`send_time` 只到秒，排不出先后）。`sync_msg` 拉到一页之后，一个事务里按页内顺序把要处理的条目插进去（冲突即跳过，只返回真正新插入的）并推进这个账号的 cursor，提交之后才派发。要记的：客户消息（含菜单点击）、发送失败回执、进入会话事件（直接记 `done`，只为去重）；其余事件照旧跳过、不记。取代 handled 集合与在途表。`done`、`abandoned` 的行 7 天后由清理函数删，超过 7 天还没结束的行由同一个函数记 `abandoned` 并清掉原文（与 02 的 7 天 msgid 集合同一口径，开放问题 4 实测之后可改）                                                                                                                                                                                                                                                                                                                                                                                                               | `src/channels/inbox.ts`                                       | —                          |
| R3  | 入站状态机与计次                               | `received`（已入库、还没进会话）→ `recorded`（客户消息已写进会话，同一次落库改状态并记下 seq）→ `replied`（回复的出站分段已落库，同一事务改状态）→ `done`；任一步可到 `abandoned`（带原因）。非文本占位、菜单点击、回执各有短路（「入站」一节）。插入时 `attempts = 0`；一行真正从会话的处理链里出队、开始处理时，单独一个短事务把它加 1 并提交，再调引擎——排在队头后面、从没开始处理的行不计次（02 只给队头计次的口径）。出队时已经是 3 的记 `abandoned`（`poison`，处理过三次都没走完，即第三次重启时停下，与 02 的「重放两次」同一口径），`sent_at` 早于 48 小时的记 `abandoned`（`too_old`），两种都给会话加一条 system 消息让顾问看见（02 的同一句）                                                                                                                                                                                                                                                                                                                                                         | 引擎多一个可选参数 `inboxId`                                  | —                          |
| R4  | 出站投递状态                                   | 在 02 的 `outbound_sends` 上扩，不另建表：状态加 `pending`（已落库、还没发）、`sending`（这一段已开始发）、`cancelled`（不会再发）。一条回复（以及人工回复、跟进、通知、同意菜单、老客户欢迎语）切好分段之后，每段一行 `pending`，带我们生成的 msgid 与要发的内容（`payload`），随会话落库写进主事务；之后每段先单独一个短事务改成 `sending`，再调 send_msg；结果照 02 记 `accepted`、`rejected`、`unknown`，回执记 `failed`。所有写入方（会话落库的 upsert、短事务、回执、恢复、导出）共用一张状态迁移表，只许表里的迁移，别的写入当无操作——晚到的写入盖不回终态。`payload` 只在 `pending`、`sending` 时有值。网页渠道没有账本（推送就是写进历史）                                                                                                                                                                                                                                                                                                                                                               | `src/quota/ledger.ts` 的 `planOutbound` 等                    | —                          |
| R5  | 重启后的补发规则；「不重复」的边界             | 启动时先按状态处理每个账号没结束的入站行与没结果的出站行，再拉新消息（同一客户的新消息排在它们后面）；处理表按入站的种类与出站的种类分（「重启、崩溃与恢复」）。要点：回复客户消息的 `pending` 段与通知按同一 msgid、同一内容补发，跟进、同意菜单、欢迎语的 `pending` 取消，人工回复照开放问题 6 的裁决（10 分钟内、接手人没变才补发）；`sending` 的段记 `unknown`、重启后不补发；`accepted`、`rejected`、`failed`、`cancelled` 永不再发，`unknown` 只在同一进程里那一段的重试中再发（02 的规则，同一 msgid）；已接手的会话里没发的分段记 `cancelled`。**边界**（开放问题 7，owner 接受为已知边界）：`markSending` 提交之后、请求真正到达企微之前进程崩溃，这一段记 `unknown`、不补发，客户少收这一段，工作台这条消息显示「可能没送达」，告警一条，由顾问补。企微按 msgid 去重（开放问题 4 的实测）核实为真之后，`RESEND_UNKNOWN` 改为真：重启时 `sending` 的段不转 `unknown`，保持 `sending` 按同一 msgid 补发，这条边界随之消失。「不重复」的成立条件与两种例外（R6、poisoned 加硬杀）统一写在目标 1 与不变量 5 | `src/channels/recovery.ts`                                    | —                          |
| R6  | 库写不进去时                                   | 发送前等这次落库提交，至多 5 秒（与 02 不变量 20 同一口径）；超时照发（可用性优先，客户不该因为库慢收不到回复），分段在内存里照常记账；改 `sending` 的短事务因库不可用失败、或库已恢复而这一组的 `pending` 还不在库里（`markSending` 返回 `absent`，这一组提交超时过）时同样照发。库恢复后按迁移表补写：`pending` 已提交的段，结果直接从 `pending` 迁过去；连 `pending` 都没提交的段，结果行直接插成结果状态，之后晚到的 `pending` 插入什么都不改。这期间进程崩溃：`pending` 已提交而 `sending` 没写成的段重启后按同一 msgid 再发一次，`pending` 也没提交的那一组由引擎重新生成、再发一组——这是「不重复」的例外，「不重复」只对「这一段的 `sending` 标记在发请求之前已提交」成立。每次「没落库就发」计数、10 分钟内有就告警（`channel`）                                                                                                                                                                                                                                                                          | 同上                                                          | —                          |
| R7  | 备份恢复                                       | 渠道状态全在库里之后，一份 `pg_dump`（单一快照）里 cursor、入站、会话、出站、任务彼此一致，恢复不再依赖 `var/` 里的渠道文件。剩下的问题是快照之后的事：旧实例在快照之后处理过的消息与发过的跟进，恢复后的进程不知道。恢复手册加一步 `channel-account restore-cutoff --until <时刻>`：`sent_at` 不晚于它的入站只补记进会话、不调模型、不发送；截止点之前建的出站 `pending` 记 `cancelled`、`sending` 记 `unknown`；`run_at` 不晚于它、还在 `pending` 或 `running` 的跟进任务记 `cancelled`（`running` 的在应用启动归位之前就处理掉，否则 02 的归位会把它改回 `pending` 再发一次）；每个涉及的会话加一条 system 说明、告警一条（只有会话数）。忘了这一步由哨兵文件拦住：`backup.sh` 打包 `var/` 时多放一个线上 `var/` 里没有的哨兵，恢复解开之后它在；企微状态在库里时它只由 `restore-cutoff` 删掉，其间有 `active` 的企微账号就拒绝启动（全部停用时照常起、不起企微、哨兵留着，之后启用账号再起时照样拦住）。截止点取值照开放问题 5 的裁决：旧实例最后一次正常回复的时刻，拿不准取恢复开始的时刻                   | `channel-account restore-cutoff`、`deploy/backup.sh`          | —                          |
| R8  | 渠道账号                                       | `channel_accounts` 一行一个入口：`wecom_kf`（一个客服账号）或 `web`（一个网页入口）。`key` 用在路由、日志与告警里，`kind`、`key`、`id_prefix`、`corp_id`、`open_kfid` 建好不改（触发器拦）；换客服账号就是新建一行、停用旧的。状态三种：`active`、`disabled`（运维停用）、`exported`（`channel-export` 把状态交回文件，`channel-import --resync` 改回 `active`）。`agent_app` 有 SELECT、INSERT 与列级 UPDATE，没有 DELETE（停用代替删除）。本阶段只经命令行管理，要求应用已停（取租户锁），改完重启生效；console 的账号页放到阶段 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `src/cli/channel-account.ts`                                  | console 管理（阶段 4）     |
| R9  | 凭据加密                                       | 要加密的是应用 secret、回调 Token、回调 EncodingAESKey，三项合成一个 JSON 一次加密：AES-256-GCM，12 字节随机 nonce，附加数据（AAD）是 `channel_accounts:v1:<tenant_id>:<账号 id>`，密文换到别的行就解不开。密钥环在 app 的 env 文件 `CHANNEL_SECRETS_KEY`：`<id>:<base64 的 32 字节>`，逗号分隔可放几把，第一把用来加密，按行上的 `secrets_key_id` 选钥解密；轮换 = 前面加一把新的、跑 `rekey`、再去掉旧的，去掉的那把离线保管到最后一份用它加密过的备份过期（异地保留 30 天）。`corp_id`、`open_kfid` 是标识不是密钥，明文存（仍不进仓库、不进日志）。access_token 只在内存里。明文、密文、token 都不进日志、审计、告警、`/healthz`、`/status` 与命令行输出；进程内的凭据与 token 包在打印时只显示「[已遮盖]」的对象里。泄露时先在企微后台重置 secret、回调 Token 与 EncodingAESKey，再 `set-secrets`                                                                                                                                                                                                            | `src/channels/secrets.ts`                                     | —                          |
| R10 | 按账号拆开的运行时                             | 每个启用的企微账号一个运行时：配置、access_token 与它的并发去重、状态后端（文件或 `channel_inbox`）、同步互斥与补拉标志、按客户的处理链、轮询定时器、停机截止、欢迎语去重表、缩略图缓存、启动恢复是否做完。注册表按账号 uuid 建键。一个账号取不到 token、拉取出错、被停用，不影响另一个账号收发。锁定的 `__test`（`STATE_FILE`、`resetForTest`、`inspectForTest`）照旧作用于 env 账号                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `src/adapters/wecom.ts`                                       | —                          |
| R11 | 会话 id 与账号                                 | 每个企微账号一个不可改的 id 前缀：租户的第一个企微账号（导入 env 的那个）用 `wecom:`，所以 02 的会话 id 一个都不变；之后建的用 `wecom:<key>:`。会话 id = 前缀 + `external_userid`，发往一个会话的消息只经前缀最长匹配到的那个账号发出。同一客户在同一租户两个客服账号上是两段会话：在客户的微信里它们本来就是两个对话窗口，发送窗口也按客服账号算（待核实，开放问题 4）。会话对象与 `conversations` 多一个 `channelAccountId`（`NULL` 表示渠道的默认账号）。种子 `wecom:cust_` 不受影响；新的 id 形状要进日志脱敏（R22）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `accountForSession()`                                         | —                          |
| R12 | 回调路由                                       | `/wecom/callback/:key` 用那个账号的回调 Token 与 EncodingAESKey 验签、解密，只认 `wecom_kf` 账号（`web` 账号的 key 当作不存在）；`/wecom/callback`（不带 key）留给前缀是 `wecom:` 的那个账号（文件存储与还没导入时是 env 账号），线上已配好的地址不用改。库里的账号遇到空的或不等于 `corp_id` 的 `receiveid` 不拉取。解密后按明文里的 `OpenKfId` 找本租户启用的、同一 `corp_id` 的企微账号去拉（几个客服账号共用一个自建应用时只能配一个回调地址）；找不到就只记日志。GET（企微后台校验地址）对不存在、停用或不是企微的 key 返回 404；POST 一律回 `success`（企微会重推），出错只记日志                                                                                                                                                                                                                                                                                                                                                                                                                           | `server.ts`                                                   | —                          |
| R13 | `WECOM_*` 的导入与回退                         | `channel-import` 把 `.env` 里的 `WECOM_*` 建成租户的第一个企微账号（前缀 `wecom:`），把 `var/wecom-cursor.json` 的 cursor、已处理集合、在途表合并导进 `channel_inbox`（同一 msgid 在两处时以在途为准），写标记文件 `var/channels-in-db.json`，把原文件移到 `--keep` 指定的、`var/` 以外的目录（不留在每晚打包的 `var/` 里）。`channel-export` 反过来，供回退到 02 的镜像：写回文件、默认账号改成 `exported`、删标记；有部分送达的回复、没发的人工回复与通知，或租户有默认企微账号以外的任何账号（不论状态，它们的会话 02 认不出）时拒绝。之后再切回用 `channel-import --resync`。导入之后 `.env` 里的 `WECOM_*` 留到 03 验收通过、确定不回退之后再删：留着时应用忽略它们，回退时不用手工加回                                                                                                                                                                                                                                                                                                                      | `src/cli/channel-import.ts`、`channel-export.ts`              | —                          |
| R14 | 网页渠道                                       | 新渠道 `web`，会话 id 是 `web:` 加 `sha256("<账号 id>:<访客凭据>")` 的前 32 位十六进制：id 不是凭据，出现在后台、日志里也读不到会话。访客凭据是 32 字节随机数，放在 `__Host-wv`（HttpOnly、Secure、SameSite=Lax）cookie 里，第一次发消息时发放；SSE 用同源 cookie，凭据不进 URL。路由 `/w/:key`、`/api/web/:key/messages`、`/history`、`/events`，账号启用、且开关 `web_channel` 开着时才开（demo 默认开，prod 封顶为关，R15）。页面与 console 同源、渲染的都是不可信内容，所以页面没有内联脚本与样式，CSP 写死（「网页渠道 · 页面安全」）；公开 SSE 按会话、按 IP、全局限并发。会话不是 demo 类：进 PG、按保留期清理、不受访客清理与上限管。网页模拟器（`sim-`、`chat.html`、`/api/chat`）原样保留：锁定的 `server.selftest.ts` 钉住了它                                                                                                                                                                                                                                                                         | `src/web/routes.ts`、`src/adapters/web.ts`、`public/web.html` | iframe 嵌入（另议）        |
| R15 | 渠道话术                                       | `promptPrefix()` 与 SOP 都不动。本阶段做两件：网页会话的 contextNote 末尾多一句（客户在网页上咨询、不在微信里，顾问会在这个页面里回复，不说「在微信上联系」）；引擎与工具里写给客户或模型的确定性文本凡提到「微信」的，按会话渠道分两套：`wecom`、`simulator` 原样（逐字节不变），`web` 用「在这个页面里」的说法（清单见「网页渠道 · 话术」）。SOP 锁定节里的「顾问会在微信上联系您」改不了（锁定、契约检查要求它在），所以 **prod 下本阶段不开放网页渠道**，这是产品限制（开放问题 2 定 A），不按 SOP 内容推断：00 的部署开关加一个 `web_channel`（环境变量 `FLAG_WEB_CHANNEL`），demo 默认开，prod 封顶为关；关着时网页账号一律不启用（`inactiveReason` 写明、`/status` 可见、启动时告警一条），网页路由 404，`add-web` 与把网页账号改成 `active` 的命令在 prod 下以 2 拒绝。阶段 4 的渠道中立锁定节出来之后，由那份 spec 放开 prod 的封顶。这个开关不进 00 的 `[profile]` 启动行（锁定的 `server.selftest.ts` 逐字比较那一行），与 02 的 `legacy_admin_writes` 一样另打一行                                    | `src/engine.ts`、`src/tools.ts`、`src/price-rules.ts`         | 渠道中立锁定节（阶段 4）   |
| R16 | demo、种子与访客                               | 种子（`wecom:cust_`）留在 JSON，不进库：保鲜每小时平移它们消息的时间戳，库里的消息只追加，进库就得每次删了重灌。网页模拟器的 `sim-` 访客照旧是 demo 类（02 R6 不取代）。demo 实例可以另开一个 `web` 账号演示正式渠道，那里的会话按真实会话处理。demo 的公开入口不改走正式网页渠道（开放问题 1 定 A）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                             | —                          |
| R17 | 链接由引擎显式产出（含消息部件、渠道能力描述） | 推到阶段 4。它改的是引擎到渠道的出口契约（回复从一段文本变成文本加部件），锁定的 `wecom.selftest.ts` 对 `extractCard` 的全等比较、引擎自测里对回复文本含链接的断言都钉在现在的形状上；阶段 4 把 13 道出口护栏包成流水线时出口本来就要重写，一起做只改一次。本阶段没有可靠性上的收益：网页渠道在页面里把站内链接渲染成卡片                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                             | 阶段 4                     |
| R18 | 渠道中立的 SOP 锁定节                          | 推到阶段 4，随行业包模板与「从模板开通租户」一起做：只用于新租户，demo 租户的 SOP 逐字节不动。原先的「第一个真实租户的 SOP 由运营在 console 里写成中立的」不成立：锁定节在 console 里改不了，发布时锁定节取镜像版本，契约检查还要求那句微信措辞在。开放问题 2 定 A：第一个真实租户本阶段只走企微，prod 不开放网页渠道（R15 的开关），中立锁定节随阶段 4 做                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                             | 阶段 4                     |
| R19 | 回滚检查、备份顺序与欢迎语                     | `deploy/rollback-guard.sh` 加一类风险：目标是 03 之前的镜像（镜像里没有 `src/channels/registry.ts`），而 `var/` 下有 `channels-in-db.json`、或标记不在但库里 `channel_accounts` 有任何一行不是「默认企微账号且 `exported`」（问库，脚本里已有的写法：`active`、`disabled` 的企微账号与任何网页账号都算有风险，与 `channel-export` 拒绝的范围一致；只有 `channel-export` 成功之后的那一行不算），拒绝（退出码 5）并打印回退步骤。`deploy/backup.sh` 改回 02 R7 的顺序：先打包 `var/`、再 `pg_dump`（env 账号的 cursor 仍在 `var/` 里，恢复出的 cursor 要比库旧、不能比库新），打包时放进 R7 的哨兵。欢迎语按账号：`settings.welcomeText`、`welcomeBackText` 不设就是现在的两段常量（demo 逐字节不变），设了要过 AI 显式标识的检查（第一句含「AI」、正文含转人工的说法），命令行写入时与启动装载时都校验，启动时不过就按没设处理并告警                                                                                                                                                                              | `deploy/rollback-guard.sh`、`deploy/backup.sh`                | —                          |
| R20 | 给阶段 4 留的缝                                | 新表都带 `tenant_id`、套 FORCE RLS；进程内的注册表、token、缩略图、欢迎语去重都按账号 uuid 建键，每个运行时带自己的 `tenantId`，库操作都经 `withTenant(account.tenantId)`；公开路由按 key 找账号（本阶段只在实例的租户里找，阶段 4 换成按 key 解析租户的 `SECURITY DEFINER` 函数，key 那时要么全局唯一、要么路由里带租户，阶段 4 定）；网页会话 id 的哈希里有账号 id。没有新的模块级单例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                             | 公开路由解析租户（阶段 4） |
| R21 | 渠道行与会话落库的事务边界                     | 分三类。必须和会话同一事务（主事务，不在存档点里）：入站状态变化（`recorded`、`replied`、`done`、`abandoned`）、出站 `pending` 的插入与 `cancelled`——丢了就会「已回复、没有分段」而悄悄漏回复。留在存档点里：出站的结果（`accepted`、`rejected`、`unknown`、attempts、errcode、`payload` 置空）——丢了只会让重启时那一段从 `sending` 变 `unknown`、不补发。单独短事务：`sending` 标记、回执、`acceptPage`、计次。为了不让渠道行把会话标成 poisoned，`planOutbound` 与入站状态变化在排进落库之前同步校验会撞约束的东西，不过就按这一组发送失败处理（会话加说明、告警），不进事务。会话已经 poisoned 时，它之后的渠道行改走单独短事务，渠道状态照样准确；spill 条目带上渠道行，回放时与会话同一事务写，会话部分回放失败时渠道部分单独写                                                                                                                                                                                                                                                                              | `src/store/pg-backend.ts`                                     | —                          |
| R22 | 日志与告警里的新 id 形状                       | 02 的脱敏正则（`src/log.ts` 的 `RAW_CONV_ID`）只认 `wecom:<id>` 与 `sim-<id>`，遇到 `wecom:<key>:<external_userid>` 会停在第二个冒号、把 `external_userid` 漏出去；`src/log.ts`、`src/server.ts` 的请求路径、`src/ops/alert.ts` 三处都用它。改成认 `wecom:(<key>:)?<id>`、`web:<id>` 与 `%3A` 编码的形式，换成 ref 或短码（02 不变量 32、48 照旧成立）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `src/log.ts`                                                  | —                          |
| R23 | 管理命令的身份与输入                           | 渠道命令行以 `agent_app` 身份运行，与 01 的平台命令行（`agent_platform`）不同：密钥只在 app 的 env 文件里，平台身份要读写凭据就得把密钥再放一份进 `.env.platform`；`channel_accounts` 的 cursor 本来就由应用写。审计的 `actor_kind` 记 `platform`、`name` 记命令名。凭据的输入：`channel-import` 是唯一读 env 的（它迁移的就是 env 里那几项）；其余命令从无回显的终端输入或一个 0600 权限的文件读，不收命令行参数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `src/cli/channel-account.ts`                                  | —                          |

## 接口与数据流

### 模块与依赖方向

```
src/
  channels/
    secrets.ts        KeyRing、sealSecrets、openSecrets、Redacted（纯函数，只依赖 node:crypto 与 node:util）
    accounts.ts       ChannelAccount、从库里读出与解密、env 账号的拼法、accountByKey、accountForSession
    registry.ts       initChannels、startChannels、运行时注册表、ChannelStartupError
    inbox.ts          PgInbox：load、acceptPage、beginAttempt（经 src/db/repo/channel-inbox.ts）；随会话落库的状态变化走 store 的 queueInboxState
    recovery.ts       启动时的入站与出站恢复；判定部分是纯函数
    transitions.ts    出站与入站的状态迁移表（纯数据，repo 的 SQL 条件与内存账本共用）
    markers.ts        var/channels-in-db.json 与恢复哨兵的读写（纯文件操作，命令行也用）
  adapters/
    wecom.ts          WecomRuntime（按账号）；文件状态层（cursor 文件、handled、在途表、02 的五种情况）挪进 file 后端，行为不变
    web.ts            网页渠道适配器：按会话的 SSE 推送与并发上限
  web/routes.ts       /w/:key、/api/web/:key/*
  quota/ledger.ts     多 planOutbound、commitOutbound、markSending、settleIntent、cancelIntents
  db/repo/            channel-accounts.ts、channel-inbox.ts；outbound.ts 扩
  cli/                channel-import.ts、channel-export.ts、channel-account.ts
  shared/channel-types.ts   ChannelKind、InboxState、OutboundStatus 等共享类型
public/web.html、public/web.js、public/web.css   网页渠道的页面（从 chat.html 改出来，不碰 chat.html；没有内联脚本与样式）
```

依赖规则（加进 `scripts/check-boundaries.ts`）：

- `src/channels/secrets.ts`、`markers.ts`、`transitions.ts` 与 `recovery.ts` 的判定函数是纯的：不 import `src/db/**`、`store`、`engine`、`llm`、`adapters/**`。
- `src/channels/**` 不 import `engine`、`llm`、`tools`；`src/db/**`、`src/cli/**` 不 import `src/channels/registry.ts` 与 `adapters/**`（命令行要的是 `secrets.ts`、`accounts.ts` 的读写与 `markers.ts`）。
- 字符串 `CHANNEL_SECRETS_KEY` 只出现在 `src/channels/secrets.ts`；`pg`、`drizzle-orm` 仍只被 `src/db/**` import（01 规则不变）。

### 渠道账号与凭据

```ts
// src/shared/channel-types.ts
export type ChannelKind = 'wecom_kf' | 'web';
export type ChannelAccountStatus = 'active' | 'disabled' | 'exported'; // exported：channel-export 把企微状态交回了文件（R8、R13）
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
  /** env：文件存储或还没导入时由 WECOM_* 拼出（id 固定为 ENV_ACCOUNT_ID、key 固定为 'env'，永不落库）；db：库里的一行 */
  source: 'env' | 'db';
  wecom: { corpId: string; openKfId: string; idPrefix: string; recordOnlyUntil: number | null; settings: WecomSettings } | null;
  web: WebSettings | null;
  /** 启动时判定这个账号不能启用的原因（web_channel 开关关着、欢迎语不合格按没设处理之类），给 /status 看；null 表示照常 */
  inactiveReason: string | null;
}
export const ENV_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';
/** 企微：前缀最长匹配到的账号；web：会话对象上的 channelAccountId；都没有时返回渠道的默认账号（前缀为 wecom: 的那个，文件存储下是 env 账号） */
export function accountForSession(sessionId: string, s?: Session): ChannelAccount | undefined;
export function accountByKey(key: string, kind: ChannelKind): ChannelAccount | undefined; // 只返回启用的、种类对得上的
```

```ts
// src/channels/secrets.ts
export interface KeyRing {
  current: { id: string; key: Buffer };
  all: ReadonlyMap<string, Buffer>;
}
/** 打印、JSON 序列化、util.inspect 都只显示「[已遮盖]」；取值只经 reveal() */
export class Redacted<T> {
  reveal(): T;
  toJSON(): string; // '[已遮盖]'
}
export interface WecomSecrets {
  appSecret: string;
  callbackToken: string;
  callbackAesKey: string;
}
/** 读 CHANNEL_SECRETS_KEY；没设返回 null。格式不对抛 ChannelKeyError（initChannels 报成 channel_key_invalid），只说第几项哪里不对，不带值 */
export function keyRingFromEnv(env: Readonly<Record<string, string | undefined>>): KeyRing | null;
/** 返回 nonce(12) ‖ 密文 ‖ tag(16) 与所用的 key id */
export function sealSecrets(ring: KeyRing, aad: { tenantId: string; accountId: string }, s: WecomSecrets): { ct: Buffer; keyId: string };
/** 按 keyId 选钥。解不开（key id 不在环里、tag 不对、AAD 不对、JSON 不对）抛 ChannelSecretError，message 里只有账号 key 与 key id */
export function openSecrets(ring: KeyRing, aad: { tenantId: string; accountId: string }, ct: Buffer, keyId: string): Redacted<WecomSecrets>;
```

access_token 在运行时里同样以 `Redacted<string>` 存放。

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
 * reject；否则 WECOM_* 配齐时拼一个 env 账号（状态在文件）。db 存储：读本租户的全部账号，按 R1 判企微状态。
 * 未导入、已导出：已导出而 var/ 下还有标记文件（导出没做完）→ channel_state_in_db；否则照 R1 拼 env 账号，有恢复哨兵就只记一行
 * 并删掉它（这两种状态下渠道状态在文件里，恢复照 02）。在库里：有 active 的企微账号而没有密钥环 → channel_key_missing；逐个解密
 * active 的，解不开 → channel_decrypt；var/ 下有恢复哨兵而有 active 的企微账号 → channel_restore_pending（没有 active 的：照常起、
 * 不起企微、哨兵留着、日志一行）；var/ 下有 wecom-cursor.json、没有标记文件 → channel_state_in_file；补写标记文件（写不进去只记日志），
 * 按 R15、R19 判定每个账号的 inactiveReason，读出每个企微账号没结束的入站行与没结果的出站行。
 * 任何一步失败都不留半装载状态
 */
export function initChannels(deps: ChannelDeps | null): Promise<void>;
/** 监听成功之后、任务与跟进扫描器之前调：每个启用的企微账号起运行时，先做启动恢复（R5），做完才开始拉取 */
export function startChannels(): void;
export class ChannelStartupError extends Error {
  constructor(
    readonly reason:
      | 'channel_key_missing'
      | 'channel_key_invalid'
      | 'channel_decrypt'
      | 'channel_restore_pending' // 从备份恢复之后还没跑 restore-cutoff（var/ 里有恢复哨兵）
      | 'channel_state_in_file' // 库里有企微账号，var/ 里还有没导入的 wecom-cursor.json：跑 channel-import（回退过就加 --resync）
      | 'channel_state_in_db', // var/ 里有 channels-in-db.json 而状态不在库里能用：文件存储下（先 channel-export），或导出没做完（重跑 channel-export 或 channel-import --resync）
    detail: string,
  );
}
```

启动顺序（`src/boot.ts`，02 之上多一步，失败分支相同）：

```
await initConfig()  →  await initSessionStore(deps | null)  →  await initChannels(deps | null)  →  serve()
  → 监听成功后：preflight、buildIndex、startChannels()（代替 startWecom）、startJobs() 或 startFollowUpScheduler()、startAlerts()
```

`initChannels` reject 时打印 reason 与 detail、`exit(1)`，其余一个都不调，cursor（文件或库里的）不动。spill 的回放在 `initSessionStore` 里、先于 `initChannels`，所以启动恢复看到的已是回放之后的入站与出站。

环境变量：

| 变量                  | 进哪个 compose 服务 | 说明                                                                                                            |
| --------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_SECRETS_KEY` | app                 | 密钥环（R9）。库里有企微账号时必填。等同密钥，只在服务器的 env 文件里；恢复备份要用同一把，丢了只能重新录入凭据 |
| `WEB_RATE_PER_MIN`    | app                 | 网页渠道每个来源 IP 每分钟最多几条消息，缺省 20（开放问题 3）                                                   |
| `WEB_NEW_PER_IP_HOUR` | app                 | 每个来源 IP 每小时最多新建几个网页会话，缺省 10                                                                 |
| `WEB_SSE_MAX_PER_IP`  | app                 | 每个来源 IP 同时开着的网页 SSE 连接数，缺省 10；每个会话另限 3 条                                               |
| `WEB_SSE_MAX_TOTAL`   | app                 | 全进程网页 SSE 连接总数，缺省 2000                                                                              |
| `FLAG_WEB_CHANNEL`    | app                 | 00 的部署开关写法，`on` / `off`；demo 缺省开，prod 封顶为关、设成 `on` 拒绝启动（R15）                          |
| `WECOM_*`             | app                 | 已有。文件存储、企微状态是「未导入」「已导出」时照旧用；企微状态在库里时被忽略（R1、R13）                       |

`/healthz` 加 `channels: { mode: 'env' | 'db', accounts, failing, stuck }`（只有个数，不带 key 与任何标识）；`failing` 是连续 10 分钟拉取失败或取不到 token 的启用企微账号数，`stuck` 是有入站行没结束超过 5 分钟（启动后宽限 1 分钟）的账号数，两者大于 0 时 `ok` 为 `false`（外部拨测据此通知）。console 的 `/status` 给成员多带每个账号的 `{ key, kind, status, inactiveReason, lastSyncAt, lastErrorCode, openInbox, oldestOpenInboxSec, staleOutbound, cursorAgeSec, unknownSends24h }`，`staleOutbound` 是 `pending` 或 `sending` 超过 2 分钟的出站行数。

### 入站：`channel_inbox`

```ts
// src/channels/inbox.ts —— 库里的企微账号用；env 账号照旧用 wecom-cursor.json
export interface InboxRow {
  id: string;
  ord: number; // 插入顺序；派发与恢复都按它
  accountId: string;
  msgid: string;
  kind: InboxKind;
  conversationId: string | null; // 消息、菜单点击、回执、进入会话事件：id 前缀 + external_userid
  sentAt: number | null; // 企微 send_time（毫秒）
  state: InboxState;
  attempts: number;
  messageSeq: number | null;
  payload: InboxPayload | null; // done、abandoned 时为 null
}
/** message、menu_click：企微原样的消息；send_fail：只有 { fail_msgid, fail_type }，不存 external_userid 以外的任何东西 */
export type InboxPayload = KfMessage | { fail_msgid: string; fail_type: number };
export interface PgInbox {
  /** 启动：这个账号的 cursor、恢复截止点、没结束的行（received、recorded、replied），按 ord */
  load(accountId: string): Promise<{ cursor: string; recordOnlyUntil: number | null; open: InboxRow[] }>;
  /** 一个事务：按页内顺序把要记的条目插进 channel_inbox（冲突即跳过）、推进 cursor；返回本次真正新插入的行。冷启动时早于截止的直接记 abandoned（cold_start） */
  acceptPage(accountId: string, msgs: readonly KfMessage[], nextCursor: string): Promise<InboxRow[]>;
  /** 出队开始处理时单独一个短事务：attempts + 1，返回加之后的值；库不可写时抛错，这一行留到下次（不处理） */
  beginAttempt(row: InboxRow): Promise<number>;
}

// src/store.ts（新增；随这个会话的下一次落库写进主事务，不在存档点里；会话已 poisoned 时改走单独短事务，R21）
export function queueInboxState(
  sessionId: string,
  change: { inboxId: string; state: 'recorded' | 'replied' | 'done' | 'abandoned'; message?: ChatMessage; reason?: InboxAbandonReason },
): void;
/** 没有会话可挂的状态变化（回执、没建出会话的毒消息）：单独一个短事务 */
export function writeInboxStateNow(change: { inboxId: string; state: 'done' | 'abandoned'; reason?: InboxAbandonReason }): Promise<void>;
```

- **一页的处理。** `sync_msg` 返回一页 → `acceptPage`（插入与推进 cursor 同一事务，`attempts = 0`）→ 提交 → 新插入的行按会话排进处理链（同一会话串行、跨会话并发，02 的写法）。拉取途中收到停机信号，这一页不提交（cursor 不动、不插入），新进程补拉时再拿到。`acceptPage` 失败（库写不进去）时这一页不派发，下一次拉取重来：入站必须先落库，这一点不走 R6 的「照发」。
- **出队。** 处理链轮到一行时依次判：`attempts` 已到 3（处理过三次都没走完）→ `abandoned`（`poison`）；`sent_at` 早于 48 小时 → `abandoned`（`too_old`）；`sent_at` 不晚于恢复截止点 → 只补记（见下）；其余先 `beginAttempt`（加 1 并提交），再按种类与状态处理。`replied` 的行（只补发分段、不调模型）同样走这一步，一组分段反复把进程带崩也会停下来。
- **客户文本消息**（`message`）：`handleMessage(sessionId, text, 'wecom', { msgid, sentAt, inboxId })`。引擎记客户消息的两处（重置口令分支与正常分支）都在把消息写进会话的那一段同步代码里调 `queueInboxState(…, { state: 'recorded', message })`，与这条消息同一次落库提交，`message_seq` 取它分到的 seq。回复回来之后：静默（转人工等）→ `done`；有回复 → 「出站」一节的 `planOutbound`，`replied` 与分段同一次落库；全部分段有了结果 → `done`。
- **非文本消息**：适配器自己写占位（同 02），占位与 `recorded` 同一次落库；引导提示同样走 `planOutbound`。
- **菜单点击**（`menu_click`）：`applyConsentDecision` 改了会话，同一次落库记 `done`；这个类别已经有结论的点击照 02 忽略，同样记 `done`。
- **发送失败回执**（`send_fail`）：插入时 `payload` 只存 `fail_msgid` 与 `fail_type`。处理是一个短事务：按 `fail_msgid` 把出站行迁到 `failed`（按迁移表）并把入站行记 `done`；会话里的说明照 02 经会话落库。重复的回执不再加说明（02 规则）。
- **进入会话事件**（`enter_session`）：`acceptPage` 里直接记 `done`，只为去重；欢迎语照 02（`welcome_code` 20 秒就过期，崩溃后不补）。
- **恢复截止点**：`sent_at` 不晚于账号的 `record_only_until` 的 `message`、`menu_click`，不调引擎：客户消息（不在会话里时）照常写进会话、追加一条 system「恢复备份之后补记的客户消息，AI 没有回复：备份之后的处理记录已丢失，请人工确认是否已回复」（同一会话一次恢复只加一条），入站行记 `abandoned`（`restore_cutoff`），同一次落库；菜单点击不补记。
- 带着 `external_userid` 的行（`conversation_id` 或 `payload` 里有）一律填 `conversation_id`，清除与行权删除按它删得干净；导入的 `legacy` 行只有 msgid，不填。
- 入站状态的 UPDATE 命中 0 行（会话与它的入站行已被清除）当无操作。
- `messages.msgid` 仍不建唯一索引（02 的理由不变）；去重在 `channel_inbox` 上做，会话里同一 msgid 不会写第二遍。

### 出站：投递状态

```ts
// src/quota/ledger.ts（新增；库里的企微账号用，env 账号照 02）
export type OutboundPayload =
  | { msgtype: 'text'; text: { content: string } }
  | { msgtype: 'link'; link: { title: string; desc: string; url: string } } // 缩略图的 media_id 发送时现取，不进 payload
  | { msgtype: 'msgmenu'; msgmenu: { head_content: string; list: unknown[] } };
export interface OutboundIntent {
  msgid: string; // 我们生成：32 位十六进制；重试与重启后的补发都用它
  accountId: string;
  /** 会话 id；老客户欢迎语还没有会话时是将要用的那个 id（前缀 + external_userid，02 的写法），所以 outbound_sends.conversation_id 照旧非空 */
  sessionId: string;
  hasSession: boolean;
  inboxId: string | null; // 回的是哪条入站；人工回复、跟进、通知、同意菜单、欢迎语为 null
  kind: OutboundKind;
  segment: number; // 这一组里的第几段，从 0 起；运行时才补的段接在这一组最大段号之后
  message: ChatMessage | null;
  payload: OutboundPayload;
}
/**
 * 一组分段切好之后同步调用：校验（msgid 格式、kind、账号存在且与会话一致、每段 payload 序列化后 ≤16 KB、文本已过 cleanText），
 * 不过就抛 OutboundPlanError、什么都不排（调用方按这一组发送失败处理）；过了就生成 msgid、记进内存账本（pending，计入已用条数）、
 * 排进这个会话的落库（主事务）。inboxId 不为空时同一次落库把入站行改成 replied。02 的 holdSend 预占的那一行由第一段接过来（同一 msgid）
 */
export function planOutbound(
  account: ChannelAccount,
  target: { sessionId: string; hasSession: boolean },
  kind: OutboundKind,
  message: ChatMessage | null,
  inboxId: string | null,
  payloads: readonly OutboundPayload[],
): OutboundIntent[];
/** 等这一组的 pending 提交：有会话的等 flushSession，没有会话的单独一个短事务。至多 5 秒；超时返回 'timeout'，调用方照发（R6）并计数 */
export function commitOutbound(intents: readonly OutboundIntent[]): Promise<'committed' | 'timeout'>;
/**
 * 每段发之前单独一个短事务迁到 sending（UPDATE … WHERE status = 'pending'，命中 0 行时同一事务再看这一行在不在）。
 * marked：可以发。not_pending：行在、已经不是 pending（被取消、已有结果）——不发。absent：库里没有这一行——这一组的
 * commitOutbound 返回过 timeout（R6，pending 还没落库）就照发并计数，返回过 committed（行提交过又没了，只会是被清除）就不发、记一行错误。
 * db_unavailable：库不可用，照发（R6）并计数
 */
export function markSending(intent: OutboundIntent): Promise<'marked' | 'not_pending' | 'absent' | 'db_unavailable'>;
/** 结果：accepted / rejected / unknown，带 errcode 与尝试次数；随会话的下一次落库写进存档点，没有会话的单独短事务 */
export function settleIntent(intent: OutboundIntent, result: SendResult, detail: { errcode?: number; attempts: number }): void;
/** 不会再发：会话已有人接手，或所属入站行记了 abandoned（毒消息、过期、恢复截止），或恢复与导出时按规则取消。原因只进日志。
 *  停机截止不取消：没发的段留在 pending，重启后按出站恢复表处理 */
export function cancelIntents(intents: readonly OutboundIntent[], reason: 'taken_over' | 'inbox_abandoned' | 'restore' | 'export'): void;
```

状态迁移表（`src/channels/transitions.ts`；repo 的 upsert 与各个短事务都把它写成同一个 WHERE 条件，表外的写入什么都不改，不报错）：

| 从                                          | 到                                | 谁写                                                                                                                              |
| ------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| （没有这一行）                              | `pending`                         | `planOutbound` 排进的会话落库，或没有会话时的短事务；行已存在时什么都不改                                                         |
| （没有这一行）                              | `accepted`、`rejected`、`unknown` | `settleIntent`：R6 下 `pending` 还没落库就发了，结果先到库，直接插成结果状态（`payload` 为空）                                    |
| `pending`                                   | `sending`                         | `markSending`                                                                                                                     |
| `pending`                                   | `accepted`、`rejected`、`unknown` | `settleIntent`：R6 下 `markSending` 因库不可用没写成、照发之后的结果                                                              |
| `pending`                                   | `cancelled`                       | `cancelIntents`、启动恢复、`restore-cutoff`、`channel-export`                                                                     |
| `sending`                                   | `accepted`、`rejected`、`unknown` | `settleIntent`                                                                                                                    |
| `sending`                                   | `cancelled`                       | 本进程标了 `sending`、提交回来之后发现已被接手、还没发请求（下面「发一条 AI 回复」第 4 步）                                       |
| `sending`                                   | `pending`                         | 本进程标了 `sending`、提交回来之后发现已过停机截止、还没发请求（同上第 4 步）                                                     |
| `sending`                                   | `unknown`                         | 启动恢复（`RESEND_UNKNOWN` 为假时）、`restore-cutoff`、`channel-export`                                                           |
| `unknown`                                   | `accepted`、`unknown`             | 同一进程里那一段的重试（02 的规则：超时那一刻先记 `unknown`，重试成功升 `accepted`）                                              |
| `pending`、`sending`、`accepted`、`unknown` | `failed`                          | 回执；`failed` 之后任何写入都不改它                                                                                               |
| （没有这一行）                              | `failed`                          | 回执先于这一行落库（R6）：内存里排着的那一行先改成 `failed`，落库时直接插成 `failed`；之后晚到的 `pending` 插入与结果写入都不改它 |
| `rejected`、`failed`、`cancelled`           | —                                 | 终态                                                                                                                              |

- 结果只来自真正发过请求的进程（`settleIntent`），所以「`pending` → 结果」只在 R6 那条路上出现，不会把没发过的段记成发过。迁到 `accepted`、`rejected`、`failed`、`cancelled`、`unknown` 时同一条语句把 `payload` 置空。
- 回执先于这一行落库（R6）：照 02，直接改内存里排着的那一行；落库时按上表「没有这一行 → `failed`」插成 `failed`，回执的优先级（`failed` 之后不再变）由迁移表保证，与写入先后无关。
- 「不重复」的条件因此是「这一段的 `sending` 在发请求之前已提交」。R6 下 `pending` 已提交而 `sending` 没写成的段，进程在结果落库之前崩溃，重启后它还是 `pending`、会按同一 msgid 再发一次；`pending` 也没提交的，入站停在 `recorded`、重启后引擎重新生成一组再发。这两种是目标 1 写明的 R6 例外。

内存账本的状态：库里的账号用 03 的取值，库与内存相同；env 账号照 02 不改名（02 内存里的 `pending` 仍表示「结果还没出来」，写库照旧映射成 `unknown`，`quota.selftest.ts` 的断言因此不用改）。账本的每一行记着它属于哪种账号，计数与显示按下表映射：

| 库里的账号  | env 账号（02 的取值） | 计入已用条数 | 工作台               |
| ----------- | --------------------- | ------------ | -------------------- |
| `pending`   | —                     | 是           | 发送中               |
| `sending`   | `pending`             | 是           | 发送中               |
| `accepted`  | `accepted`            | 是           | 不显示               |
| `unknown`   | `unknown`             | 是           | 可能没送达           |
| `rejected`  | `rejected`            | 否           | 没送达               |
| `failed`    | `failed`              | 否           | 没送达               |
| `cancelled` | —                     | 否           | 未发送（全组都是时） |

- **发一条 AI 回复的顺序**：
  1. 引擎返回（回复已写进会话、排着落库）。
  2. 适配器先确定要不要卡片（要的话先取缩略图：传不上去就按 02 的规则整段原文发，所以切分在取缩略图之后），切分段，`planOutbound`，`commitOutbound`（R6）。
  3. 每段：先比停机截止（02），过了就停：这一段与之后的段都不发、留在 `pending`，入站留在 `replied`，重启后补发；再比接手代次，变了就把这一组没发的段 `cancelIntents`（`taken_over`）、按 02 记「本轮未发送」。
  4. `markSending`；`not_pending` 不发这一段；`absent` 按上面的注释（这一组提交超时过才继续，否则不发）。凡是要继续发的结果（`marked`、提交超时过的 `absent`、`db_unavailable`），**返回之后、发请求之前都再比一次接手代次与停机截止**（`markSending` 期间可能有人接手或到了截止）：被接手就不发，这一段与其余没发的一并取消；过了截止就不发，其余没发的不动，这一组留给重启后的出站恢复。返回 `marked` 的段库里已是 `sending`，被接手迁到 `cancelled`，过了截止迁回 `pending`；`absent`、`db_unavailable` 的段库里没有 `sending`，取消照 R6 的落库路径写，过了截止什么都不另写。这次比较与发请求之间没有 `await`，接手和截止都插不进来，所以 02「normal 段截止之后不再开始新的 send_msg」对每一种发送结果都成立。迁回 `pending` 的短事务写不成时，这一段留在 `sending`、重启后记 `unknown`（没发过，工作台显示「可能没送达」，告警一条）。
  5. send_msg（同一段的重试沿用 msgid；02 的退避重试里那一行可能先记 `unknown`，见迁移表）→ `settleIntent`。
  6. 全部分段有了结果 → 入站 `done`。
- 人工回复、跟进、付款确认、同意菜单本来就是「先落库后发送」（02 不变量 20、R17），分段的 `pending` 行加进它们那一次落库，之后同样走第 3–5 步。
- **运行时才补的段**（卡片发失败之后补的「标题 + 链接」文字）段号取这一组最大段号加 1，单独一个短事务写成 `pending` 之后再走第 4–5 步。
- **出站行的 `kind`**：库里账号的每一段都记这一组的种类（`ai`、`human`、`followup`、`notice`、`menu`、`welcome`），卡片段也一样，是不是卡片看 `payload.msgtype`；`card` 只出现在 env 账号与 02 留下的旧行上（它们没有 `pending`、`sending`）。恢复表按 `kind` 分支因此覆盖所有段。
- **窗口计数**（02 R18 的保守口径）：见上表「计入已用条数」。
- **工作台**：每条 AI 与人工消息下按它名下分段的最差状态显示：全部 `accepted` 不显示；有 `pending` 或 `sending` 显示「发送中」；有 `unknown` 显示「可能没送达」；有 `rejected` 或 `failed` 显示「没送达」（02 已有）；全是 `cancelled` 显示「未发送」。只读内存里的账本，不查库（02 不变量 9）。

### 渠道行与会话落库（R21）

- 会话的一次落库（02「一次落库」）多两步：在第 5 步（订单、审计、任务、同意记录）之后、存档点之前写入站状态变化、出站 `pending` 插入与 `cancelled`；存档点里在 trace、护栏事件之外写出站结果。主事务里的渠道行写失败与 02 一样按 SQLSTATE 分类（连接类重试，数据类把会话标成 poisoned）；同步校验让数据类失败只剩代码缺陷一种来源。
- **会话已 poisoned**：内存照旧服务客户（02），它之后排进来的渠道行（入站状态、出站行与结果）改走单独短事务，按迁移表写；这些短事务也写不进去时留在内存、1 秒后再试，停机时进 spill。这样重启之后渠道状态仍说得清「这句已回复、这一段已发」，不会被当成没处理过再答一遍。
- **spill**（02「停机」）：每个 spill 条目多一段 `channel: { inbox: InboxChange[]; outbound: OutboundRow[] }`，写的是还没提交的主事务渠道行与结果行；旧版 spill 没有这一段，按空处理。回放时与这个条目的会话部分同一个事务写（沿用条目的 `flush_id` 判定）；会话部分回放失败（02 会把 spill 改名 `.failed`）之前，渠道部分先单独一个短事务写进去。
- **保底**（启动恢复里）：`received` 的行，先看会话里有没有这个 msgid 的客户消息，有就按 `recorded` 处理；名下已有出站行的，按 `replied` 处理；`recorded` 而会话里找不到这条消息（会话部分没写进库）的，用 `payload` 把它补进会话再按 `recorded` 处理。这三条覆盖 R6、poisoned 与 spill 回放失败。
- 已知边界：poisoned 的会话在渠道部分的短事务也一直写不进去、进程又被硬杀（没有 spill）时，这段时间的消息重启后会再处理一遍，可能重复回复；这种情况 02 已经告警（poisoned、`/healthz` 的 `ok` 为 false），由运维先修库再重启。

### 重启、崩溃与恢复

启动时 `initChannels` 读出每个企微账号没结束的入站行与 `pending`、`sending` 的出站行（带 `payload`、`segment`、`inbox_id`；02 预载 `readOutboundAfterLastCustomer` 不读这几列，另加一条查询）。`startChannels` 对每个账号先做出站恢复、再做入站恢复，做完才开始拉取；做完之前，这个账号的 `push`（跟进、人工回复、通知）排队等待，至多 30 秒，超时返回 false（跟进按 02 的明确失败处理，人工回复记「未能发送」）。

入站恢复（按 `ord` 派发进各自会话的处理链，出队时照「入站 · 出队」计次与判过期、截止）：

| 种类与状态                                      | 处理                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`，`received`                           | 先过保底（R21）；照新消息处理                                                                                                                    |
| `message`，`recorded`，会话里这句之后有 AI 回复 | 按那条回复切分段、`planOutbound`、照常发（这条回复没进过 `replied`，说明一段都没发过）                                                           |
| `message`，`recorded`，没有 AI 回复，已转人工   | `done`                                                                                                                                           |
| `message`，`recorded`，没有 AI 回复             | 以 `alreadyRecorded` 重跑                                                                                                                        |
| `message`，`replied`                            | 会话有接手人 → 名下 `pending` 的段 `cancelled`、记「本轮未发送」；否则按同一 msgid、同一内容发名下 `pending` 的段，不调模型；都有结果之后 `done` |
| `menu_click`，`received`                        | 重做同意记录；这个类别已有结论的忽略；`done`                                                                                                     |
| `send_fail`，`received`                         | 重做回执的短事务（迁移表保证重复无害）；`done`                                                                                                   |
| 任何种类，记了 `abandoned`                      | 名下 `pending` 的出站一律 `cancelled`、`sending` 的记 `unknown`                                                                                  |

- 恢复里的每一次补发（入站 `replied` 的分段、通知、人工回复）都走「发一条 AI 回复」第 3–5 步：先比截止与接手，再 `markSending`，提交之后才发；`RESEND_UNKNOWN` 为真时补发的 `sending` 段本来就是 `sending`，直接走第 5 步。
- 「会话里这句之后有 AI 回复」按 seq 判：`message_seq` 之后、下一条客户消息之前，`role='agent'` 且 `author` 为空或 `ai` 的第一条（欢迎语不算，02 的规则）。

出站恢复（入站恢复之前、按账号一次扫完）：

| 出站行                                                                                               | 处理                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sending`（任何种类）                                                                                | `RESEND_UNKNOWN` 为假：`unknown`、不补发（R5 的边界），告警一条；为真：保持 `sending`，按同一 msgid 补发（已是 `sending`，满足「发之前已是 `sending`」） |
| `pending`，`sent_at` 不晚于恢复截止点                                                                | `cancelled`                                                                                                                                              |
| `pending`，有 `inbox_id`，入站行还没结束                                                             | 不在这里发，留给入站恢复：它的入站行出队时照常计次、判过期与截止，再按上表 `replied` 一行处理                                                            |
| `pending`，有 `inbox_id`，入站行已结束（`done`、`abandoned`，如 `--resync` 记的 `resync`）或已被清理 | `cancelled`：没有人会再处理这一组                                                                                                                        |
| `pending`，`followup`                                                                                | `cancelled`：对应的跟进任务在 `sending`，02 的启动归位把它记 `abandoned`、不重发，两边同一口径                                                           |
| `pending`，`notice`（付款确认等）                                                                    | 按同一 msgid 补发：从没发过，客户要知道钱到了                                                                                                            |
| `pending`，`human`                                                                                   | 开放问题 6 的裁决：建这一行起 10 分钟内、会话的接手人没变，按同一 msgid 补发；否则 `cancelled`、工作台显示「未发送」                                     |
| `pending`，`menu`、`welcome`、没有 `inbox_id` 的 `ai`（异常道歉）                                    | `cancelled`：同意菜单按 02「再问一次」的规则下次再问；欢迎语与道歉过时了就不该再发                                                                       |
| `pending`，`card`                                                                                    | 不会出现：库里账号的卡片段记的是它那一组的 `kind`（「出站」一节）；万一出现按 `cancelled` 处理、记一行日志                                               |

- 停机：normal 段截止之后不再开始新的 send_msg（02 的规则不变；「发一条 AI 回复」第 3 步在 `markSending` 之前比、第 4 步在它返回之后、发请求之前再比一次，所有要发的结果都比，截止之后标上的 `sending` 迁回 `pending`），没发的分段留在 `pending`、不取消，重启后按上面的出站恢复表处理；不再需要 02 的「deferred 留在在途表」。
- **恢复截止点**（`channel-account restore-cutoff --tenant <slug> --until <带时区的 ISO 时刻|now>`，要求应用已停）：一个事务里写全部企微账号的 `record_only_until`；把 `sent_at` 不晚于它的 `pending` 出站记 `cancelled`、`sending` 记 `unknown`；把 `run_at` 不晚于它、还在 `pending` 或 `running` 的跟进任务记 `cancelled`（`last_error='restore_cutoff'`；`running` 必须在这里处理，应用启动时 02 的归位会把 `running` 的跟进改回 `pending`、再发一次，`sending` 的照 02 记 `abandoned`、不重发）；打印受影响的入站行、出站行、任务数；删掉恢复哨兵。`--until` 晚于当前时刻 5 分钟、或没带时区，以 1 拒绝。
- **恢复哨兵**：`backup.sh` 打包 `var/` 时额外放进 `var/restored-from-backup.json`（`{ backupAt }`，只在归档里，线上 `var/` 没有）。恢复手册第 5 步解开 `var/` 之后它就在。企微状态在库里时，它只由 `restore-cutoff` 删掉：其间有 `active` 的企微账号，应用以 `channel_restore_pending` 拒绝启动；全部停用时照常起（不起企微）、哨兵留着，之后启用账号再起时照样被拦住——停用不清掉恢复风险。企微状态是「未导入」「已导出」（渠道状态在文件里，恢复照 02）时只记一行日志并删掉它。崩溃重启没有哨兵，照常按库里的状态恢复。
- 恢复手册（`deploy/backup.sh` 开头的恢复步骤）在第 5 步解开 `var/` 之后、第 6 步起应用之前加两步：确认 app 的 env 文件里有备份时用到的密钥（按 `secrets_key_id`，已轮换掉的从离线保管处取回）；以 app 身份跑 `restore-cutoff`（取值照开放问题 5 的裁决：旧实例最后一次正常回复的时刻，有告警时从「健康检查失败」「app 反复重启」那一条往前推，拿不准取恢复开始的时刻）。
- `deploy/backup.sh` 的 TABLE DATA 校验在表存在时加 `channel_accounts`、`channel_inbox`（02 的写法）。

### 会话 id、账号与回调

- 企微会话 id = 账号的 `id_prefix` + `external_userid`。入站时按收到消息的那个账号拼；出站（人工回复、跟进、付款确认）经 `accountForSession` 找账号。企微的默认账号是前缀为 `wecom:` 的那个（文件存储与还没导入时是 env 账号）。`isDemoClassId` 不变：`wecom:<key>:cust_…` 不是种子。
- 会话对象新增可选字段 `channelAccountId?: string`：非默认企微账号与网页会话写，默认账号的旧会话不补写（`NULL` 就是默认账号）。`conversations.channel_account_id` 是它的投影；03 的预载与回退检查都以它为准。
- 回调：`GET|POST /wecom/callback/:key` 与 `GET|POST /wecom/callback`（R12）。验签、解密与 02 相同，换成按账号取 Token 与 AES Key；库里的账号遇到空的或不等于 `corp_id` 的 `receiveid` 不拉取（02 的 env 账号在没配 `WECOM_CORP_ID` 或 `receiveid` 为空时放行，照旧）。明文里的 `Token` 交给按 `OpenKfId` 找到的那个账号的运行时去拉。明文里没有 `OpenKfId` 时（开放问题 4 待核实）按路由的账号拉。
- 两个账号在同一进程里：各自的 `sync_msg` 只带自己的 `open_kfid` 与自己的 access_token；入站行带自己的 `account_id`；一个账号停用之后它的回调不拉、它名下会话的推送返回 false（人工回复照 02 记「未能发送」）。

### 网页渠道

```ts
// src/adapters/web.ts
export const webAdapter: ChannelAdapter; // name: 'web'；push 发给这个会话所有在线的 SSE 连接，人工回复加「【顾问】」；客户不在线也返回 true（消息在历史里）
export function webConversationId(accountId: string, token: string): string; // 'web:' + sha256 前 32 位十六进制
export function subscribeWeb(sessionId: string, clientKey: string, send: (ev: WebEvent) => void): (() => void) | 'too_many';
export type WebEvent = { type: 'push'; text: string } | { type: 'menu'; text: string; buttons: { id: string; label: string }[] };

// src/web/routes.ts 的响应类型（src/shared/channel-types.ts）
export interface WebMessage {
  role: 'customer' | 'agent'; // 不含 system
  text: string; // 人工回复带「【顾问】」前缀
  at: number;
}
```

| 路由                          | 鉴权与限流                                                                                                                                                        | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /w/:key`                 | 公开；账号不存在、停用、不是 `web`、`inactiveReason` 不为空或开关 `web_channel` 关着（prod）时 404                                                                | `public/web.html`，服务端注入配置（见「页面安全」）；安全头见「页面安全」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/web/:key/messages` | 要求 `x-web-chat: 1`（挡跨站表单，否则 403）；按 IP `WEB_RATE_PER_MIN`；新会话按 IP `WEB_NEW_PER_IP_HOUR` 与账号的 `dailyNewConversations`                        | 请求体 `{ text: string(1..1000), cid?: string }` 或 `{ menu: string, cid?: string }`。没有有效 cookie 就发一个（新会话超上限时 429、不发 cookie、不建会话）。`cid`（`^[A-Za-z0-9_-]{8,64}$`）记成客户消息的 `msgid`：同一 cid 已在会话里、后面有 AI 回复就直接返回那条；正在处理返回 409 `in_progress`；已在会话里、没有回复、会话没转人工（上一次处理途中崩溃）以 `alreadyRecorded` 重跑（02 情况 3）。返回 `{ reply: { text } \| null }`（转人工后为 null）。超过 `dailyTurns` 照开放问题 3 的裁决：客户的话照记、不调模型、回固定的一句，每个会话至多因此转一次人工 |
| `GET /api/web/:key/history`   | 没有 cookie 返回 `{ messages: [] }`；02 的 `lookupLimit`                                                                                                          | 这个凭据对应会话窗口内的客户与 agent 消息，`WebMessage[]`；没有画像、system 消息、成员身份                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/web/:key/events`    | 没有 cookie，或 cookie 推出的 `web:` 会话在这个账号下不存在，401；`lookupLimit`；并发超过每会话 3 条、每 IP `WEB_SSE_MAX_PER_IP`、全局 `WEB_SSE_MAX_TOTAL` 时 429 | SSE：`push`、`menu`、每 15 秒 `ping`；30 分钟没有任何 `push` 或 `menu` 就由服务端关闭（页面需要时重连）                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

- 公开路由白名单（02 R22）加：`/wecom/callback/:key`（验签）、`/w/:key`、`/api/web/:key/messages`、`/api/web/:key/history`、`/api/web/:key/events`、`/api/web/:key/end`。网页的几条只返回或只动 cookie 对应的那一段会话；prod 下本阶段开关 `web_channel` 封顶为关，它们一律 404（白名单照列，阶段 4 放开开关时不用再改白名单）；02 验收 9 的「枚举全部路由」自测随之更新。
- 每日上限的计数在内存里，按自然日清零；重启清零只会多放一些，不会误拦。
- cookie：`__Host-wv`，值是 32 字节随机数的 base64url，`HttpOnly; Secure; SameSite=Lax; Path=/`；有效期照开放问题 8 的裁决：滑动 30 天（`Max-Age` 30 天，每次发消息重新下发、续期）；页面有「结束咨询」按钮，`POST /api/web/:key/end`（同样要求 `x-web-chat: 1`）回一个过期的同名 cookie，会话不删、照保留期留在后台，之后再来就是新会话。格式不对当作没有。pino 的 `redact` 盖住 `cookie` 与 `set-cookie`（02 已在 `REDACT_KEYS` 里，这里加自测核对）。
- 会话：`getOrCreateSession(webConversationId(account.id, token), 'web')`，写 `channelAccountId`；`handleMessage(id, text, 'web', { msgid: cid })`。不是 demo 类：落库、预载、按保留期清理、清除与行权删除都与企微的真实会话相同。
- 引擎：访客预算（`tryReserveVisitorLLM`）仍只管 `simulator`；话术见下。
- 同意菜单：引擎 `push(id, text, { kind: 'menu', category })` 时网页适配器发 `menu` 事件，按钮 id 用 `consentMenuButtonId`；点了就 `POST { menu: <id> }`，按 `parseConsentMenuId` 认、`applyConsentDecision` 记。客户不在线（没有 SSE 连接）时返回 false，按 02「再问一次」的规则处理。
- 重置口令随 profile：demo 生效（02 R5，库里推进窗口）、prod 无效。
- console：渠道中文名加 `web` →「网页」，`simulator` 改为「演示」（只改 console 的文案，`admin.html` 不动）；工作台对网页会话不显示发送窗口与投递状态。

**页面安全。** `/w/:key` 与 console 同源（console 的 cookie `Path=/`，`/me` 返回 csrf），页面渲染的客户原话、AI 回复、标题都是不可信内容，一处 XSS 就能借顾问的登录态调后台接口：

- 脚本与样式都是独立的静态文件（`public/web.js`、`public/web.css`），HTML 里没有内联 `<script>`、`<style>`、`style=` 与 `on*=` 事件属性。
- 服务端注入的配置（`{ key, title, welcome, privacyLink }`）放进 `<script type="application/json" id="web-config">`，JSON 里的每个 `<` 输出成 `\u003c`（反斜杠加 u003c 六个字符，`JSON.parse` 读回来仍是 `<`，HTML 解析器却见不到 `</script>`）；页面用 `JSON.parse` 读。标题与欢迎语在写进去之前按 R19 校验过，渲染时一律 `textContent`。
- 安全头：`Content-Security-Policy` 恰为 01 的 `BASE_CSP` 加 `; style-src 'self'; base-uri 'none'; form-action 'self'`，不许 `unsafe-inline`；`Cache-Control: no-store`；`X-Content-Type-Options: nosniff`。
- 消息文本先按纯文本渲染（`textContent`），再只把站内的 `/pay/<id>`、`/proposal/<…>`（相对路径或 `PUBLIC_BASE_URL` 开头）换成链接或卡片；其余 URL 照文字显示、不可点。

**话术（R15）。** 网页会话的 contextNote 末尾多一句（措辞实施时定）。下面这些写给客户或模型、提到「微信」的确定性文本，`web` 会话换成「在这个页面里」的说法，`wecom` 与 `simulator` 会话逐字节不变：`src/engine.ts` 里重发订单链接、成单安全网、补发订单链接说明、改行程承诺、价格追问转人工、「请顾问在微信上跟您确认」几处的固定回复；`src/tools.ts` 的 `ADVISOR_PAY_NOTE`；`src/price-rules.ts` 把「电话联系」改写成「在微信上联系您」的两条替换。实施时用 `rg '微信' src` 核对一遍有没有漏的，清单记进 plan。`src/prompt/system.ts` 的硬性要求（「微信正文」「微信不渲染 markdown」）在前缀里，不动：对网页同样成立。

### 导入、导出与切换

```
# 以 app 身份运行（R23），要求应用已停（取租户锁）
src/cli/channel-import.ts   --tenant <slug> --key <key> --keep <dir> [--name <名字>] [--var <dir>] [--dry-run] [--resync]
src/cli/channel-export.ts   --tenant <slug> --var <dir> --keep <dir>
src/cli/channel-account.ts  list | add-wecom | add-web | set-secrets | set | rekey | restore-cutoff   --tenant <slug> …
```

退出码与 02 的命令行相同：0 成功或无操作，1 用法或读写出错（什么都不动），2 数据对不上（提示怎么办，什么都不动），3 拿不到租户锁。`--keep` 照 02：必须在 `var/` 之外，开事务之前先验可写，写不进去以 1 退出。

- **channel-import**：要求 `CHANNEL_SECRETS_KEY` 与 `WECOM_CORP_ID`、`WECOM_APP_SECRET`、`WECOM_KF_OPEN_KFID`、`WECOM_CALLBACK_TOKEN`、`WECOM_CALLBACK_AES_KEY` 都在。租户还没有企微账号时，一个事务：
  - 插入账号（前缀 `wecom:`，凭据加密，`WECOM_POLL_INTERVAL_MS` 进 `settings`）。
  - `var/wecom-cursor.json` 在就把 `cursor` 写进账号；`handled` 与 `pending` 按 msgid 合并（02 的在途消息同时在两处），每个 msgid 只插一行：在 `pending` 里的插成 `message`、`received`（`payload` 原样，`conversation_id` 取 `wecom:` + `external_userid`；每个客户在途表里的第一条 `attempts = tries + 1`，其余 `attempts = tries`，与 02 只给队头计次一致），按在途表的顺序插、`ord` 随之递增；只在 `handled` 里的插成 `legacy`、`done`（`received_at` 取记下的时间）。
  - 写一行 `channel.import` 审计（只有条数）。文件不在时 cursor 为空，第一次启动按 02 的冷启动处理。
  - 提交之后先把原文件复制进 `--keep`，再写标记文件，再删掉 `var/` 里的原文件（都先写临时文件再改名，之后对目录 fsync，02 的写法）。打印账号 key 与各类条数，不打印任何凭据与标识。
  - 已经有这个账号、是 `active`、有标记、没有 `wecom-cursor.json`：已经导入过，退出码 0。账号是 `exported`、有 `wecom-cursor.json`、没有标记（导出之后回退到 02 跑过一段）：退出码 2，提示加 `--resync`。`.env` 里的 `WECOM_CORP_ID`、`WECOM_KF_OPEN_KFID` 与库里的账号不一致：退出码 2。
  - `--resync`：先与首次导入一样把文件里的 `handled` 与 `pending` 按 msgid 合并、在途优先，再写库：`cursor` 换成文件里的；在途的 msgid 库里没有就插成 `received`，库里有而没结束就换成文件里的 `payload` 与 `attempts`（规则同上），库里已结束的不动（只会是导出之前 03 已处理完的，02 不会再认领它）；只在 `handled` 里的补插 `done`（已有的不动）；库里没结束、文件在途表里没有的入站行记 `abandoned`（`resync`：02 期间已经由文件状态处理过），它们名下 `pending` 的出站由下次启动的出站恢复记 `cancelled`。默认账号从 `exported` 改回 `active`。之后同样复制、写标记、删原文件，退出码 0。
  - `--dry-run` 只打印将写入的条数。
- **channel-export**（回退到 02 的镜像之前）：
  - 拒绝（退出码 2，什么都不动）的几种：标记文件不在而文件与库不一致；`.env` 里的 `WECOM_*` 与默认账号不一致（回退之后 02 的镜像只认 env）；租户有默认企微账号以外的任何账号，不论状态（它们的会话 02 认不出账号：02 的推送只去掉 `wecom:` 前缀，会把 `<key>:<external_userid>` 当收件人；`web` 渠道 02 不认，任务与通知会对着它们报错。回退到 02 因此只支持「只有默认企微账号」的租户，有过别的账号就只能回到 03 之后的镜像）；有「部分送达」的回复（同一条入站名下既有 `accepted`、`unknown` 或 `sending` 的段，又有 `pending` 的段——02 的情况 4 见到任一段已送出就跳过整条，剩下的段会永远漏发）；有没有 `inbox_id` 的 `pending` 出站（人工回复、通知，02 没有办法补发）。后两种的处理办法写在提示里：以 03 起一次应用，让启动恢复把它们发完，正常停机，再跑一次。
  - 照 02 的格式写 `var/wecom-cursor.json`：`cursor`；`handled` 是默认账号 3 天内的入站行（最新的 5000 条，`[msgid, 毫秒]`）；`pending` 是它没结束的 `message` 行，按 `ord`（`{ msg: payload, tries: max(attempts − 1, 0) }`）。
  - 同一事务把默认账号名下 `sending` 的出站行迁到 `unknown`、整条回复都还是 `pending` 的段迁到 `cancelled`（02 的镜像认 `unknown` 为可能已送达、不补发；`cancelled` 的那条回复在 02 的情况 4 里按「没送出」补发一次，02 内存账本不认得 `cancelled`，按不计入、不算送出处理，与 02 的 `rejected` 相同）。导出之后库里没有 03 才有的 `pending`、`sending`。
  - 同一事务把默认账号改成 `exported`：之后 03 的镜像起来也按 R1 走 env 与文件状态（与 02 相同），回滚检查不再把它算作「状态在库里」。`var/` 里已有同名文件时先复制进 `--keep`。提交之后写文件、再删标记文件。账号已是 `exported`、没有标记、文件在：已经导出过，当无操作返回 0。
- **channel-account**：
  - `add-wecom` 读 `{ corpId, openKfId, appSecret, callbackToken, callbackAesKey }`，租户还没有企微账号时前缀取 `wecom:`，否则取 `wecom:<key>:`；`add-web --title <标题>`；`set-secrets` 读三项凭据重新加密。凭据从无回显的终端输入或 `--secrets-file <0600 权限的文件>` 读（R23），文件权限宽于 0600 以 1 拒绝。
  - `set` 改 `name`、`status`、`settings` 里的单项（欢迎语按 R19 校验）；`rekey` 把全部账号用环里的第一把密钥重新加密；`restore-cutoff` 见上一节；`list` 只打印 key、kind、name、status、前缀、`inactiveReason` 与「凭据已设置」，不打印 `corp_id`、`open_kfid`。
  - 开关 `web_channel` 关着（prod 封顶）时，`add-web` 与把网页账号改成 `active` 以 2 拒绝并写明「本阶段 prod 不开放网页渠道」（R15）。企微状态是「已导出」时 `add-wecom`、`add-web` 以 2 拒绝，提示先 `channel-import --resync`（R1）。
  - 每个写操作一行审计（`channel.import`、`channel.export`、`channel.account_create`、`channel.account_update`、`channel.secrets_update`、`channel.rekey`、`channel.restore_cutoff`），`actor_kind` 记 `platform`，审计里只有 key 与改了哪几项的名字。
- **标记文件** `var/channels-in-db.json`（`{ tenant, account, at }`）表示「企微状态在库里」。`channel-import` 写、企微状态在库里时启动补写、`channel-export` 删。它决定启动时的两个拒绝（`channel_state_in_file`、`channel_state_in_db`）和 `deploy.sh` 的回滚检查（标记不在时回滚检查再问一次库，R19）。
- **切换步骤**（demo 由 owner 在线上执行，第一次在本机 compose 上演练）：
  1. 以现状部署 03 的镜像（不加任何 env）：`/healthz` 的 `channels.mode = env`，`config` 的四个哈希与切换前相同（本阶段不改前缀），企微照常收发。
  2. 生成 32 字节随机数，`.env` 加 `CHANNEL_SECRETS_KEY=k1:<base64>`，同时存进 owner 保管 env 文件的地方（另记）。
  3. `docker compose stop app`；以 app 身份跑 `channel-import --tenant demo --key kf-main --keep <var 之外的目录>`，核对打印的条数。
  4. `docker compose up -d app`：`/healthz` 的 `channels.mode = db`、`accounts = 1`、`failing = 0`、`stuck = 0`；console `/status` 里 `kf-main` 的 `lastSyncAt` 在一分钟内；用测试微信给 demo 客服发一句，收到一次回复，库里有它的入站行（`done`）与出站行（`accepted`）。第 3、4 步之间是停机，02 实测停 6 秒，这次多一个导入，预计半分钟以内，记进 plan；停机期间客户发的消息在起来之后按 cursor 补拉。
  5. 要演示正式网页渠道时：停 app，`channel-account add-web --tenant demo --key demo --title …`，起 app。注意建了网页账号之后就不能再用 `channel-export` 回退到 02（见下）。
  6. 切换后第一份每晚备份做完恢复验证（验收 6 的线上部分），删掉 `--keep` 里的原件。
  7. 03 验收通过、确定不回退之后，从 `.env` 删掉 `WECOM_*`，重启一次核对仍正常。
- **回退到 02 的镜像**：`stop app` → `channel-export --var /app/var --keep <var 之外的目录>`（被拒时照提示处理）→ 确认 `.env` 里的 `WECOM_*` 还在 → 部署 02 的 tag。再切回：`stop app` → `channel-import --resync --keep <…>` → `up -d app`。
- **回滚检查**（`deploy/rollback-guard.sh`，含健康检查失败后的自动回滚）：目标镜像里没有 `src/channels/registry.ts`（03 之前的镜像），而服务器 `var/` 里有 `channels-in-db.json`、或没有标记但库里 `channel_accounts` 有任何一行不是「前缀为 `wecom:` 的企微账号且 `exported`」（与条目版本同一种问库写法；停用的企微账号、第二个企微账号、任何网页账号都算有风险，与 `channel-export` 的拒绝范围一致；库问不到时，正在跑的是 03 之后的镜像就按有风险处理），拒绝，退出码 5，打印上面的回退步骤（带项目名与端口，02 的写法）。与 02 的会话、条目版本两类风险可以同时出现，各自打印。两个都是 03 之后的镜像时照常回滚。

### 数据库

DDL 由 drizzle-kit 生成表、索引和约束；RLS、策略、触发器、函数、授权与列级授权写在 custom 迁移里（01「迁移纪律」）。两张新表都带 `tenant_id`，都套 01 的 RLS 模板（ENABLE、FORCE、`tenant_isolation`）。

```sql
CREATE TABLE channel_accounts (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  key                text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  kind               text NOT NULL CHECK (kind IN ('wecom_kf','web')),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','exported')),
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
  ord              bigint GENERATED ALWAYS AS IDENTITY,   -- 插入顺序：同一页按页内顺序逐行分配
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
  payload          json,                  -- 见 InboxPayload；done、abandoned 时置空
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, account_id, msgid),
  FOREIGN KEY (tenant_id, account_id) REFERENCES channel_accounts (tenant_id, id),
  CHECK ((state = 'abandoned') = (reason IS NOT NULL)),
  CHECK (state NOT IN ('done','abandoned') OR payload IS NULL),
  CHECK (kind = 'legacy' OR conversation_id IS NOT NULL)
);
CREATE INDEX channel_inbox_open ON channel_inbox (tenant_id, account_id, ord)
  WHERE state IN ('received','recorded','replied');
CREATE INDEX channel_inbox_by_conv ON channel_inbox (tenant_id, conversation_id);
CREATE INDEX channel_inbox_finished ON channel_inbox (tenant_id, updated_at) WHERE state IN ('done','abandoned');

ALTER TABLE outbound_sends
  ADD COLUMN account_id uuid,             -- 02 的旧行为 NULL：前缀为 wecom: 的默认账号（ENV_ACCOUNT_ID 永不落库）
  ADD COLUMN inbox_id   uuid,
  ADD COLUMN segment    smallint NOT NULL DEFAULT 0,
  ADD COLUMN attempts   smallint NOT NULL DEFAULT 0,
  ADD COLUMN payload    json,             -- 只在 pending、sending 时有值
  ADD FOREIGN KEY (tenant_id, account_id) REFERENCES channel_accounts (tenant_id, id);
-- status 的 CHECK 换成 ('pending','sending','accepted','rejected','unknown','failed','cancelled')，另加
-- CHECK (status IN ('pending','sending') OR payload IS NULL)
CREATE INDEX outbound_sends_open ON outbound_sends (tenant_id, account_id) WHERE status IN ('pending','sending');

ALTER TABLE conversations
  ADD COLUMN channel_account_id uuid,     -- NULL：渠道的默认账号（R11）
  ADD FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts (tenant_id, id);
```

- `outbound_sends` 沿用 02 的两列语义：`conversation_id` 非空（没有会话的老客户欢迎语写将要用的会话 id，02 的写法）；`sent_at` 非空，`pending` 时是建这一行的时刻，之后每次尝试往后挪（02「按最后一次尝试计数」），窗口计数与 `purge_expired_traces` 照旧按它。
- 触发器（custom 迁移，属主 `agent_owner`）：
  - `channel_accounts` 的 BEFORE UPDATE：`key`、`kind`、`id_prefix`、`corp_id`、`open_kfid` 任何一个变了就报错；`updated_at := now()`。
  - `channel_inbox` 的 BEFORE UPDATE：`updated_at := now()`（清理按它删，`agent_app` 不能往回改）；`OLD.state` 是 `done` 或 `abandoned` 时任何改动都报错（终态不回退、`payload` 不复活）。
  - `outbound_sends` 的状态迁移由 repo 的 WHERE 条件守（迁移表），不另加触发器：02 的 upsert 已经是这个写法，改成认 03 的迁移表。
- 迁移 lint：换 `outbound_sends.status` 的 CHECK 要先 DROP 旧约束，标注 `-- migration-allow: drop 放宽 status 的取值，旧镜像写的值都在新集合里`；新加的 CHECK 命中 `add-check`，标注 `-- migration-allow: add-check 新列为空或取默认值，旧行都满足`；改写 02 的 `purge_conversation`、`erase_conversation` 命中 `create-or-replace`，标注 `-- migration-allow: create-or-replace 删除范围加 channel_inbox，签名与权限不变，旧镜像照常调用`。
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
  -- 删 state 为 done、abandoned 且 updated_at 早于 p_now − 7 天的入站行；
  -- received_at 早于 p_now − 7 天还没结束的行记 abandoned（too_old）、payload 置空（客户原文不无限期留着）；返回两类条数之和
-- 02 的 purge_conversation 与 erase_conversation：删除范围加 channel_inbox 里 conversation_id 是这个会话的行（任何状态），
-- erase_conversation 的返回值多一项 inbox
```

### 可观测性

- 日志：轮次与拉取里多带 `acct`（账号 key）；不写 `corp_id`、`open_kfid`、access_token、凭据与 cookie。企微接口出错只记接口名与 errcode，不记请求地址（地址里带 access_token）。`src/log.ts` 的 `REDACT_KEYS` 加 `appSecret`、`callbackToken`、`callbackAesKey`、`secrets`、`secretsCt`、`secrets_ct`（字段名同时进 pino 的 `redact` 与 JSON 行的兜底）；凭据与 token 在进程内是 `Redacted`，打印出来只有「[已遮盖]」。
- 会话 id 脱敏（R22）：`RAW_CONV_ID` 认 `wecom:(<key>:)?<id>`、`web:<id>`、`sim-<id>` 与 `%3A` 编码的形式，`scrubConvIds` 照旧换成 ref 或短码；`src/log.ts`、`src/server.ts` 的请求路径、`src/ops/alert.ts` 都经它。
- 告警（02 R24 加一个键 `channel`）：某个启用账号连续 10 分钟拉取失败或取不到 token；有入站行没结束超过 5 分钟（启动后宽限 1 分钟）；10 分钟内有「没落库就发」（R6）；重启时有 `sending` 转成 `unknown`（R5 的边界）；恢复截止点让 N 个会话只补记未回复（一次）；`poison`、`too_old`；网页账号因开关 `web_channel` 关着没有启用（prod，R15）。原有的 `wecom_send` 告警正文带账号 key。告警正文只有账号 key、计数与错误码。
- 运行数字不变；`unknownSends24h`、`oldestOpenInboxSec`、`staleOutbound` 只在 `/status` 里给成员看。

### 测试与 CI

- 锁定的 7 组自测与 `eval/cases.json` 一行不改。`wecom.selftest.ts` 跑在文件存储、env 账号上，靠 R1 的文件后端照旧过；02 的 `wecom-02.selftest.ts`、`quota.selftest.ts` 走的是「文件存储」与「db 存储、库里没有企微账号」两条照 02 的路，断言不改（env 账号的内存状态照 02 不改名，`quota.selftest.ts` 断言的 `pending` 仍是「结果还没出来」）。
- 新增套件，串进 `test`：
  - `src/channels/channels.selftest.ts`：密钥环的解析与拒绝；`sealSecrets` / `openSecrets` 往返、改一个字节、换 AAD、换 key id、旧密钥解、`rekey` 之后新密钥解；`Redacted` 在 `JSON.stringify`、`util.inspect`、模板字符串里都是「[已遮盖]」；`initChannels` 的六个拒绝原因与「不留半装载」；`web_channel` 开关的解析与 prod 封顶（prod 设 `on` 拒绝启动、不进 `[profile]` 启动行）；标记文件与哨兵；迁移表的每一格（允许的改了、表外的没改）；`channel-import` / `channel-export` / `--resync` 的往返、合并与退出码（子进程）；凭据不出现在命令行输出、审计行、日志（拦截 stdout、stderr，扫明文、密文的 base64、hex 与 Buffer 的 JSON 形式）。
  - `src/adapters/wecom-03.selftest.ts`：假企微服务端支持两个 corp 与两个客服账号（按 `open_kfid` 与 token 分开记账）、按 msgid 记送达、可以挂住某个请求的接收或回包；PGlite 与真实 PG（有 `PG_TEST_URL` 才跑）。覆盖：一页的提交与回滚、`ord` 顺序、状态机每一格、出队计次、出站的 `pending → sending → 结果`、`markSending` 前后的接手检查、回执、出站恢复表每一行、恢复截止点与哨兵、spill 带渠道行的写出与回放、poisoned 会话的渠道行短事务、两个账号交错与一个账号出错、回调按账号验签与 `OpenKfId` 分派、停机截止后留 `pending`、日志与告警里没有 `external_userid`。崩溃点用子进程加 `SIGKILL`，靠假企微、假模型与库连接的阻塞点造出时刻（02 `quota.selftest.ts` 的写法），不在产品代码里留按环境变量触发的钩子；`RESEND_UNKNOWN` 经适配器的 `__channelTest` 在子进程里设。
  - `src/web/web.selftest.ts`：路由、cookie 与 `x-web-chat`、`cid` 去重与重跑、历史投影、SSE 的鉴权与并发上限与空闲关闭、同意菜单、限流与每日上限、prod 下开关 `web_channel` 封顶为关、没有 cookie 读不到任何会话、响应里没有会话 id；页面契约：`/w/:key` 的 CSP 与上面那条全等、`web.html` 里没有内联脚本、样式与事件属性、恶意标题（`</script><img onerror=…>`）在注入的 JSON 里被转义、页面不读写 `localStorage` 里的凭据、站外链接不可点。
  - 02 的 `db.selftest.ts`（不锁）加新表的 RLS、授权逐格、触发器拒改不可变列、入站终态不回退、`updated_at` 改不回去、`purge_channel_inbox` 拒删未到期并把超期未结束的记 `abandoned`、清除与删除连带入站行。
- 有意修改的非锁定断言（每条在对应步骤的 PR 里写明理由）：`db.selftest.ts` 的表清单与权限期望表；console 自测里渠道中文名的期望（`simulator` 改「演示」、加 `web`）；`console.selftest.ts` 里枚举全部路由的公开白名单；`ops.selftest.ts` 里 `backup.sh` 的步骤顺序（先打包 `var/`）。
- 压测（`scripts/load/run.ts` 加一组，不进 `test`，结果记进 plan）：两个客服账号各 25 个客户、各 10 轮，mock LLM 2–8 秒，真实 PG，不杀进程：每条客户消息恰好一次回复，每个（客户、轮次）恰好一组 send_msg。渠道多出的事务（每页一次、每条入站一次计次、每段一次 `sending`）的代价按对照测：同一台机器、同一个 PG 容器配置、同样的负载脚本与随机种子，先在开工提交（02，env 账号、文件状态）上跑一遍记基线，再在 03（库里的账号）上跑；「客户消息到达假企微 → 第一段 send_msg 到达假企微」的 p99，03 比基线多不超过 50 毫秒。两边各跑 3 遍取中位数，原始数字记进 plan。

## 与 02 及更早 spec 的关系

- **部分取代**（顶部 `Supersedes in part:`）02 的四处，都只在企微状态在库里时（R1）：R7 里企微 cursor 留在文件与三条缓解那一句（改为 R2–R7）；「一次落库」第 6 步把账本行整体写在存档点里（改为 R21：`pending` 与 `cancelled` 进主事务，结果仍在存档点）；「企微：发送账本、回执与去重」里账本行随落库写进存档点那一句与五种情况（改为入站状态机与 R5 的恢复表）；「停机」里 spill「trace 与账本行不写」中的账本行（出站行随渠道段进 spill，R21；trace 照旧不写）。文件存储，以及企微状态是「未导入」「已导出」的 db 存储下，这四处原文照旧，02 的自测照旧守它们。
- **不取代 02 R6**：`sim-` 访客与种子照旧是 demo 类、永不进 PG（02 不变量 11 照旧）。正式网页渠道是新渠道 `web`，它的会话本来就不在 R6 的范围里。开放问题 1 已定 A（demo 入口不改），本阶段不取代 R6。
- **不取代 02 R11**：`admin.html` 的匿名只读、`x-sim-session`、旧写接口都不动。
- **02 R7 的备份顺序**：03 把 `backup.sh` 改回 R7 原本写的顺序（R19），是让实现符合 02 的条款，不是改条款。
- **新增**走 Amends（顶部 `Amends:`）：02 的新表、新列、新状态与授权，清除与删除函数的删除范围，spill 条目的渠道段，02 不变量 42 的表清单，02 R22 的公开路由，启动多一步与新的拒绝原因，`/healthz` 的 `channels`，日志脱敏认的 id 形状与告警键；01 的审计动作；00 的部署开关 `web_channel`；后台 UX spec 的渠道中文名（加 `web`、`simulator` 改叫「演示」）。
- 02 验收 31 的「恢复后在途客户恰好收到一次回复」在 03 由验收 6 重新验证（按本 spec 的「不重复」口径），02 那一条的记录不改。
- 02 里写的「（04）」「（05）」（如非目标里的 `channel_inbox` 与渠道层 v2、多副本）是 2026-10-09 重排之前的编号，见总参考「分阶段路线」开头。

## 不变量

每条都能写成断言或测试。

入站与出站：

1. 库里的企微账号，cursor 只在把这一页要记的每一条写进 `channel_inbox` 的那个事务里推进；cursor 之前、要记的每条企微消息，在被清理之前在 `channel_inbox` 里都有一行。
2. （`account_id`，`msgid`）在 `channel_inbox` 里至多一行；同一条企微客户消息至多写进会话一次。
3. 会话没有 poisoned 时，客户消息写进会话的那次落库提交，它的入站行同时是 `recorded` 且 `message_seq` 等于这条消息的 seq；回复的出站 `pending` 行写进库的那次提交，入站行同时是 `replied`。
4. 库可写时，库里的企微账号对一段发第一次请求之前，这一段在 `outbound_sends` 里已是 `sending`；同一进程里之后的重试、重启后的补发都用这一行的 msgid。
5. **不重复**：同一段的所有请求（同一进程里的重试、重启后的补发）都带同一个 msgid；`accepted`、`rejected`、`failed`、`cancelled` 的段永远不再发；`unknown` 的段只在同一进程里那一段的重试中再发；`RESEND_UNKNOWN` 为假时，重启时还是 `sending` 的段记 `unknown`、不再发。每一段的 `sending` 都在发请求之前提交了的话，同一条客户消息的回复至多发出一组。例外只有目标 1 列的两种：R6 下 `sending` 没写成就发了、结果落库之前崩溃；会话 poisoned、渠道短事务也写不进去、进程被硬杀。
6. **漏发可见**：任何没送达或可能没送达的段（`unknown`、`rejected`、`failed`、`cancelled`）在工作台对应消息上有状态；重启时由 `sending` 转来的 `unknown` 另有一条告警。
7. 出站行只按迁移表变化；`failed`、`rejected`、`cancelled` 之后不再变；`payload` 只在 `pending`、`sending` 时非空。
8. `done`、`abandoned` 的入站行不再被处理、不再变化，`payload` 为空；`updated_at` 只由库写。
9. `sent_at` 不晚于账号 `record_only_until` 的入站，不调模型、不发送；截止点之前建的出站 `pending`、`run_at` 不晚于它的 `pending` 与 `running` 跟进都不再发。
10. 有接手人的会话里，`markSending` 提交之后才发现被接手的段不发；重启后不补发 AI 回复的分段。停机截止之后没开始的段不取消，留在 `pending`，重启后按出站恢复表处理（AI 回复与通知补发；人工回复照开放问题 6 的裁决，10 分钟内、接手人没变才补发）。
11. 一行入站的 `attempts` 只在它真正出队开始处理时增加；从没开始处理的行不会因为别的消息崩溃而被记成 `poison`。
12. 同一会话的入站行按 `ord` 处理；重启后的派发顺序与第一次相同。
13. 文件存储、以及企微状态是「未导入」「已导出」的 db 存储下，企微的收发、去重与落盘与 02 相同（锁定的 `wecom.selftest.ts` 与 02 的企微自测不改断言照过）；企微状态在库里时进程不写 `var/wecom-cursor.json`、不读 `WECOM_*`。
14. 企微状态在库里时，恢复哨兵只由 `restore-cutoff` 删除；哨兵在而有 `active` 的企微账号时，应用不启动。
15. 启动恢复对库里每一行 `pending`、`sending` 的出站都给出处理（补发、`cancelled` 或 `unknown`）：入站行已结束或已被清理的、不挂入站的各个种类都在出站恢复表里，没有无人处理的行。

账号与凭据：

16. `channel_accounts` 里的凭据只以密文存在；明文只在进程内存里；日志、审计、告警、`/healthz`、`/status`、命令行输出与错误信息里既没有明文也没有密文，也没有 access_token。
17. 一个账号的密文换到别的行（别的账号或别的租户）解不开。
18. 每个账号的 access_token、cursor、入站、同步互斥、轮询互不共享；一个账号取 token 失败或停用，另一个账号照常收发。
19. 会话 id 等于账号前缀加 `external_userid`；发往企微会话的每个分段都带它所属账号的 `open_kfid` 与那个账号的 access_token。
20. 回调只用路由所指账号的 Token 与 AES Key 验签；库里的账号遇到空的或不等于 `corp_id` 的 `receiveid` 不拉取。
21. `channel_accounts` 的 `key`、`kind`、`id_prefix`、`corp_id`、`open_kfid` 写入之后不变；任何角色对 `channel_accounts`、`channel_inbox` 都没有 DELETE，入站行只经 `purge_channel_inbox` 与 02 的清除、删除函数删除。
22. prod profile 下的进程日志与告警里没有 `external_userid` 与会话原 id，包括 `wecom:<key>:<id>`、`web:<id>` 与它们的 `%3A` 编码形式（02 不变量 32、48 照旧）。

网页渠道：

23. 网页会话 id 由账号 id 与访客凭据的哈希推出；任何响应、日志、审计里都没有访客凭据；不带凭据或凭据对不上的请求读不到任何会话的内容，也连不上事件流。
24. 网页渠道的读接口只返回请求者自己会话里的客户与 agent 消息，没有 system 消息、画像与成员身份。
25. `/w/:key` 的响应头 CSP 恰为规定的那一条，页面没有内联脚本、样式与事件属性，注入的配置里没有未转义的 `<`。
26. `web:` 会话不是 demo 类：落库、按保留期清理，访客清理与上限（`sim-`）不碰它。
27. 只有 `channel === 'web'` 的会话 contextNote 多 R15 那一句、确定性文本走网页的说法；企微与模拟器会话的 contextNote 与确定性文本、以及所有会话的 `promptPrefix()` 与开工时逐字节相同。
28. 开关 `web_channel` 关着时（prod 封顶），没有网页账号是启用的，网页路由一律 404；`add-web` 与启用网页账号的命令被拒。

demo 与清理：

29. `sim-` 与 `wecom:cust_` 开头的会话及其订单永不出现在 PG 里（02 不变量 11 照旧）。
30. 一个会话被清除或删除之后，`channel_inbox` 里也搜不到它的 `external_userid`（02 不变量 42 的表清单加这一张）。
31. 锁定套件零修改；demo profile 下重置、匿名只读、种子保鲜、访客清理、模拟支付、AI 标识的行为与开工时相同。

## 验收标准

「不重复」与「漏发可见」是本 spec 对重放、崩溃与恢复的口径（目标 1、R5、不变量 5、6）：同一条客户消息的回复不会发两遍；进程崩溃恰好落在某一段请求途中时这一段可能漏发，库里是 `unknown`、工作台显示「可能没送达」、告警一条。两种情况明确排除在「不重复」之外、只要求有告警：库写不进去期间照发（R6）、结果落库之前崩溃；会话已 poisoned、它的渠道短事务也写不进去、进程又被硬杀（R21）。

1. **锁定套件零修改。** 与开工提交相比，锁定清单里的文件 diff 为空；`pnpm test` 全绿；`PREFIX sha256` 的两个值与开工时相同。
2. **两条状态路径。** 文件存储下与「db 存储、库里没有企微账号」下，02 的 `wecom-02.selftest.ts`、`quota.selftest.ts` 不改断言照过；导入账号之后同一个实例跑一组对话，`var/` 下不再出现 `wecom-cursor.json`。
3. **cursor 与入站同一事务、顺序。** 假企微返回一页 3 条，让 `acceptPage` 的事务在提交前失败：cursor 不变、`channel_inbox` 里没有这 3 行、没有派发，下一次拉取拿到同样 3 条并各处理一次；提交之后立刻 `SIGKILL`：重启后这 3 条各回复一次。同一客户一页两句、杀在第一句处理途中：重启后先处理第一句、再处理第二句，第二句的 `attempts` 是 1（第一次处理），第一句是 2。
4. **崩溃重启不重复、漏发可见**（真实 PG，子进程 `SIGKILL`）。
   - 杀在模型生成途中（入站 `recorded`）、回复已落库而第一段还没开始发（`replied`、`pending`）、两段回复发完第一段而第二段还没标 `sending`：重启后客户在假企微上收到的分段恰好是一整组、没有重复，补发的段与原段同一个 msgid，后两种没有再调模型。
   - 杀在「请求已到假企微、回包被挂住」：重启后不重发，假企微上恰好一组，库里那一段是 `unknown`，工作台显示「可能没送达」，告警一条。
   - 杀在 `markSending` 提交之后、请求到达假企微之前（假企微延迟接收、请求没进去）：重启后不重发，客户少收这一段，库里是 `unknown`，工作台显示「可能没送达」，告警一条——这是 R5 写明的边界。
   - 子进程里经 `__channelTest` 把 `RESEND_UNKNOWN` 设为真重跑后两种：重启时那一段保持 `sending`、按同一 msgid 补发，假企微按 msgid 去重之后都恰好一组。
5. **接手与发送的竞态。** 让 `markSending` 的短事务挂住，期间顾问在 console 接手，再放开：这一段迁到 `cancelled`，零发送，会话多一条「本轮未发送」。再挂一次、挂到 `markSending` 判为 `db_unavailable`，期间接手：同样零发送。
6. **备份恢复不重复**（本机 compose，照 02 第 26 步的演练）。
   - 场景：三个客户 A、B、C 经假企微聊天；客户 E 已排好一条 `run_at` 在备份之后、停机之前的跟进；B 的第一次 send_msg 让假企微收下之后挂住回包 15 秒，期间跑 `backup.sh`；同时顾问给 C 发一条人工回复，让它停在 `pending`；客户 F 的跟进在备份那一刻正好是 `running`（假模型挂住生成）；备份之后 C 再发一句、旧实例回复，E、F 的跟进被旧实例发出；然后停掉旧实例，记下停的时刻 T。
   - 照恢复手册恢复到新集群：不跑 `restore-cutoff` 直接起应用，以 `channel_restore_pending` 拒绝；跑 `restore-cutoff --until T` 之后起应用。
   - 结果：B 在假企微上恰好收到一组回复；A 没有补发；C 备份之后那句在新库的会话里有、带「恢复备份之后补记」的说明、没有第二次回复；给 C 的那条人工回复是 `cancelled`、工作台显示「未发送」；E、F 的跟进任务都是 `cancelled`（F 在应用启动归位之前就被 `restore-cutoff` 处理掉），没有第二次跟进；T 之后 D 发的一句回复一次；`/healthz` 的 `config` 哈希、会话数与原库一致。
   - 对照（记进 plan）：同一份备份删掉哨兵、不跑 `restore-cutoff` 再起一次，C 那句被再回一次，说明这一步不能省。
   - 线上：切换后第一份每晚备份恢复到临时集群，跑完 `restore-cutoff` 起得来，会话数一致。
7. **库写不进去时（R6）。** 故障注入的时点：入站行与这一行的计次照常提交、引擎开始生成之后，再挡住写库（另一个连接锁住这个会话的行与 `outbound_sends`，或让连接池拿不到连接），挡 6 秒。两种：
   - A：`pending` 赶在挡之前提交了，`markSending` 拿到 `db_unavailable`。回复照发，告警收到一条「没落库就发」；放开之后这一组从 `pending` 直接迁到 `accepted`，入站 `done`。
   - B：生成完时已经挡住，`commitOutbound` 等满 5 秒超时。回复照发；放开之后同一次落库先插 `pending`、存档点里再迁 `accepted`（或结果行先到、直接插成 `accepted`，之后晚到的 `pending` 插入什么都不改），入站 `done`。
   - 两种各在「回复已发、结果没落库」时 `SIGKILL` 一次：A 重启后那一段还是 `pending`，按同一 msgid 再发一次（假企微上多一组、msgid 相同）；B 重启后入站是 `recorded`，引擎重新生成一组再发（多一组、msgid 不同）。都至多多一组，告警各一条——目标 1 写明的 R6 例外。
8. **会话写不进去时（R21）。** 入站行已提交、会话的落库失败（库连接断开）、正常停机写出 spill、恢复 PG 后重启回放：spill 里带着渠道行，回放后入站与出站状态对上，零重复回复、客户消息只记一次。用一条违反 CHECK 的会话投影让会话 poisoned，之后客户再发两句：AI 照常回复，入站与出站行经短事务落库；`SIGKILL` 之后重启（spill 回放失败）：这两句不再回复，`recorded` 而会话里没有的那句由 `payload` 补进会话。旧版没有渠道段的 spill 照常回放。
9. **毒消息与过期。** 一条每次处理都让进程崩溃的客户消息：第三次重启时记 `abandoned`（`poison`）、会话里多一条说明、告警收到一条，之后的消息照常处理；排在它后面、同一客户的第二句不受连累（`attempts` 不会被它的崩溃累加）。`sent_at` 在 49 小时前的没结束入站行，出队时记 `too_old`、不调模型。
10. **两个账号互不串。** 同一实例三个企微账号（两个假企业各一个客服账号，其中一个企业再加第二个客服账号），同一个 `external_userid` 在三个账号上交错各发 5 句：三段会话、id 分别是 `wecom:…`、`wecom:<key>:…`；每个分段的 `open_kfid` 与 access_token 都是会话所属账号的；三个 cursor 各自推进；让第二个 corp 的 `gettoken` 一直失败：它的告警收到一条、`/healthz` 的 `failing = 1`，另两个账号收发不受影响；停用一个账号重启：它的回调只记日志不拉取，其余照常。prod profile、`LOG_FORMAT=json` 下用非默认账号跑一轮：标准输出与假 webhook 的告警里搜不到这个 `external_userid` 与会话原 id（含 `%3A` 编码形式）。
11. **凭据不外泄。** 跑完验收 2–10 与 13 的全部场景后，在采集的标准输出、标准错误、`audit_log`、告警内容、`/healthz`、`/status`、命令行输出里搜三项凭据的明文、`secrets_ct` 的 base64、hex 与 Buffer 的 JSON 形式、access_token，结果为零。把一个账号的 `secrets_ct` 复制到另一行、改一个字节、换掉 `CHANNEL_SECRETS_KEY`：三种都以 `channel_decrypt` 拒绝启动，detail 里只有账号 key 与 key id；不设 `CHANNEL_SECRETS_KEY` 以 `channel_key_missing` 拒绝。`rekey` 之后去掉旧密钥照常启动。`--secrets-file` 权限是 0644 时以 1 拒绝。
12. **回调路由。** `/wecom/callback` 与 `/wecom/callback/<key>` 各自用自己账号的 Token 通过企微后台的地址校验（GET），用别的账号的 Token 签的请求不拉取；不存在的 key、网页账号的 key 的 GET 返回 404、POST 回 `success` 并记一行日志；库里的账号收到 `receiveid` 为空的回调不拉取（env 账号照 02 放行，锁定的 W1 守它）；同一 corp 的两个客服账号共用一个回调地址，事件按 `OpenKfId` 拉对应的账号。
13. **导入、导出与回退。**
    - 导入：用一份含 cursor、200 条 handled、2 条在途（这 2 条同时也在 handled 里，与 02 真实的文件一样）的 `var/wecom-cursor.json`：没有撞唯一约束，库里 200 行、其中 2 行是 `received` 且 `attempts` 照规则；标记文件写了，原文件在 `--keep` 里、`var/` 里没有；在途的 2 条重启后各回复一次。再导入一次退出码 0；应用持锁时退出码 3；`--keep` 在 `var/` 之内以 1 拒绝；`.env` 的 `WECOM_KF_OPEN_KFID` 改一位后 `--resync` 退出码 2。
    - 导出：有一条两段回复只发出第一段（第二段 `pending`）时以 2 拒绝、什么都不动，照提示起一次 03、停机之后再导出成功；租户有一个网页账号或第二个企微账号（停用的也算）时以 2 拒绝。导出成功之后：默认账号是 `exported`、标记文件没了；同一个 03 镜像重启按 env 与文件状态收发（`channels.mode = env`）；导出的文件被 02 的镜像读进来照常收发、没有重复回复，也没有漏发的段。之后文件路径下再聊几轮、`--resync` 切回：库里的 cursor 是文件的，几轮里的消息都是 `done`，没有重复回复。
    - 文件存储下有标记文件以 `channel_state_in_db` 拒绝；企微状态在库里而 `var/` 里有未导入的 `wecom-cursor.json` 以 `channel_state_in_file` 拒绝；恢复之后企微账号全部停用时照常起、哨兵还在，之后启用一个账号再起，以 `channel_restore_pending` 拒绝；导出没做完（默认账号 `exported`、标记还在）以 `channel_state_in_db` 拒绝。
14. **网页渠道。**
    - 新浏览器打开 `/w/<key>`：开场第一句带 AI 身份；发一句收到回复，响应带 `__Host-wv`（HttpOnly、Secure、SameSite=Lax），库里有 `web:` 会话；刷新后历史在；顾问在 console 接手并回复，在线时 SSE 立即收到「【顾问】…」，关页再开历史里有；点「结束咨询」之后 cookie 清掉、会话还在 console 里。
    - 另一个浏览器（没有 cookie）读历史为空、连 SSE 得到 401；伪造一个格式正确的 cookie 连 SSE 得到 401；同一会话开第 4 条 SSE、同一 IP 开第 11 条得到 429；所有响应体里搜不到会话 id 与凭据；不带 `x-web-chat` 的 POST 403。
    - 同一 `cid` 连发两次只记一条、两次拿到同一条回复；处理途中杀进程、重启后同一 `cid` 再发：不再记一遍，以 `alreadyRecorded` 生成回复。
    - 提到「我妈有高血压」弹出同意按钮，点「同意」记 `granted`；超过每分钟条数返回 429；新会话超过每日上限返回 429 且没有建会话。
    - 页面安全：`/w/<key>` 的 CSP 与规定的那条全等；把账号标题设成 `</script><img src=x onerror=alert(1)>`，页面里它是文字、没有执行；一条带站外链接的 AI 回复里那条链接不可点。
    - prod profile：开关 `web_channel` 封顶为关，`FLAG_WEB_CHANNEL=on` 拒绝启动；库里已有的网页账号不启用、`/w/<key>` 与 `/api/web/<key>/*` 都是 404、`/status` 写明原因、告警一条；`add-web` 以 2 拒绝；`/chat.html` 仍是 404。启动日志的 `[profile]` 那一行与开工时逐字节相同（锁定的 `server.selftest.ts`）。
    - 清理：把租户的线索保留期设 7 天，一个 8 天前的网页会话连同消息、trace 被清除，console 里也没有它。
15. **网页话术。** 自动：同一组对话（含转人工、advisor 模式下建单与重发订单链接、客户说「电话联系我」）分别在 `wecom`、`simulator`、`web` 会话上跑 mock：前两者每轮发给模型的 contextNote、工具结果与客户收到的确定性文本与开工时逐字节相同；`web` 的 contextNote 多 R15 那一句，确定性文本里没有「微信」；三者的 system 与 tools 哈希相同。手动（花钱，不进 CI）：真实模型在 demo 的网页会话里跑 6 遍「我要人工」与 6 遍「能帮我问下顾问吗」，回复里说「在微信上联系」的次数记进 plan，作为 R15 那一句 contextNote 的效果记录（开放问题 2 已定 A，prod 不开放；demo 的网页渠道据此决定要不要调那一句）。
16. **demo 照常。** 导入账号之后的 db 存储下：网页模拟器与企微的「重置」都生效；种子保鲜、`sim-` 访客清理与上限、`admin.html` 匿名只读（只见种子与自己的 `sim-`）与旧写接口、模拟支付、AI 标识都照旧；`admin.html` 匿名列表里没有 `web:` 会话。
17. **出站投递状态。** 工作台里：正常发出的回复不显示状态；让假企微挂住回包时显示「发送中」；回执 4 之后显示「没送达」（02 已有）；验收 4 的结果不明显示「可能没送达」；接手打断的那一组显示「未发送」。窗口剩余条数把 `pending`、`sending` 算进已用。迁移表外的写入（对 `failed` 写 `accepted`、对 `cancelled` 写 `pending`）不改库。
18. **出站恢复。** 重启时库里有每种没结果的出站行（有入站的 `pending`、跟进、通知、人工回复、同意菜单、欢迎语，以及 `sending`）：处理结果与「出站恢复」表一致；恢复做完之前到期的跟进任务等到恢复做完才发。
19. **清理与删除。** 每日任务之后，8 天前结束的入站行没了、6 天前结束的还在、8 天前收到还没结束的记了 `abandoned` 且 `payload` 为空；`agent_app` 对 `channel_inbox`、`channel_accounts` 的 DELETE 报 permission denied；改 `channel_accounts.open_kfid`、把 `done` 的入站行改回 `received`、把 `updated_at` 往回改都不成；对一个企微会话执行 `erase-conversation` 之后，`channel_inbox` 里搜不到它的 `external_userid`（含 `send_fail` 行），返回值带 `inbox` 条数。
20. **停机。** 模型在 normal 段截止之后才回包：不开始 send_msg，入站停在 `replied`、分段 `pending`；重启后发一次、msgid 与停机前生成的相同、不调模型。让 `markSending` 的短事务挂住、期间跨过 normal 段截止再放开：这一段迁回 `pending`、假企微上没有请求；重启后按同一 msgid 发一次。挂到判为 `db_unavailable`、期间跨过截止：同样没有请求。
21. **切换与回滚检查。** 本机演练与线上各按「切换步骤」走一遍：切换前后 `config` 的四个哈希相同；`channels.mode` 从 `env` 变 `db`；停机时长与条数记进 plan。本机演练里：有 `channels-in-db.json` 时 `deploy.sh` 拒绝回滚到 02 的镜像（退出码 5）并打印回退步骤；删掉标记、库里仍有 `active` 的企微账号时照样拒绝；`channel-export` 之后（标记删了、默认账号 `exported`）放行，部署 02 的 tag 成功；两个 03 镜像之间照常回滚。`backup.sh` 先打包 `var/` 再导出（看日志里两步的时间），归档里有哨兵、线上 `var/` 里没有。
22. **欢迎语按账号。** 不设 `welcomeText` 时新客户收到的欢迎语与开工时逐字节相同；`set --setting welcomeText=…` 设一段第一句不含「AI」的文字，命令行以 1 拒绝、库不变；直接在库里改成不合格的再启动：按没设处理、告警一条；设一段合格的，重启后新客户收到它。`restore-cutoff --until` 写一个明天的时刻或不带时区，以 1 拒绝。
23. **卡住了能看见。** 让一个会话的处理链卡住 6 分钟：`/healthz` 的 `stuck = 1`、`ok = false`，告警收到一条；`/status` 的 `oldestOpenInboxSec` 超过 300。
24. **压测。** 按「测试与 CI」的压测一组跑完，通过条件全部满足；p99 的增量按那里写的基线对照（同一台机器、同样负载、开工提交对 03），基线与 03 的数字都记进 plan。

## 开放问题

8 条里的 1–3、5–8 已由 owner 在 2026-10-09 全部定下，裁决写在下表与各条开头，选项与理由留着备查，不阻塞任何步骤；4 是接第一个真实租户之前在测试客服账号上做的实测项，结论只改常量，不阻塞开工。

| #   | 问题                               | 裁决（owner 2026-10-09）                                                                                  | 落在哪                                  |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | demo 的公开网页入口                | 选 A：不改，`sim-` 模拟器照旧是 demo 入口，02 R6 不取代                                                   | R16、「与 02 及更早 spec 的关系」       |
| 2   | 真实租户的网页话术                 | 选 A：本阶段 prod 不开放网页渠道（产品限制，开关 `web_channel` 在 prod 封顶为关），渠道中立锁定节随阶段 4 | R15、R18、目标 5、不变量 28、验收 14    |
| 3   | 网页渠道的防刷与成本上限           | 照推荐的默认值与超限行为                                                                                  | 「网页渠道」、环境变量表、`WebSettings` |
| 4   | 企微接口行为的待核实点             | 照旧：接第一个真实租户之前实测，核实之前按保守口径                                                        | R5、R11、R12、02 plan「上线清单」       |
| 5   | 恢复截止点取什么时刻               | 照推荐：旧实例最后一次正常回复的时刻，拿不准取恢复开始的时刻                                              | R7、恢复手册                            |
| 6   | 崩溃时停在 `pending` 的人工回复    | 照推荐：10 分钟内、接手人没变就按同一 msgid 补发，否则 `cancelled`、工作台显示「未发送」                  | 出站恢复表                              |
| 7   | 「请求途中可能漏发」能不能翻 ready | 接受为 03 的已知边界；开放问题 4 的实测照旧在接第一个真实租户之前做                                       | 目标 1、R5、不变量 5、6、验收 4         |
| 8   | 网页访客凭据的有效期               | 照推荐：滑动 30 天，加「结束咨询」                                                                        | 「网页渠道」                            |

1. **demo 的公开网页入口要不要改走正式网页渠道。** 已定（owner 2026-10-09：选 A）。依据：demo 的用途（给潜在客户看产品、给公众试聊）与 02 R6、02 不变量 6 的取舍。
   - A（推荐）：不改。`guide.html` 照旧指向 `chat.html`，`sim-` 访客照旧是 demo 类（匿名可读、24 小时清理、5000 封顶、不进库），02 R6 不动。正式网页渠道在 demo 上另开一个 `web` 账号（`/w/demo`），要演示时把链接给对方。访客看到的回复与正式渠道是同一个引擎，差别只在存储；不用为 demo 在库里开删除通道。代价：公开流量不走正式渠道，正式渠道的问题要靠测试与真实租户暴露；两个聊天页面要分别维护（`chat.html` 本来就被锁定自测钉住，删不掉）。
   - B：`guide.html` 改指 `/w/demo`，demo 的公开访客走正式网页渠道、会话进库。要保住 demo 行为得另加：`tenants.demo_visitors`（只有 `agent_platform` 能改）与 SECURITY DEFINER 函数 `prune_web_visitor`，只在这个租户上、只删 `web:` 且没有已付订单的会话，闲置 24 小时或超过 5000 个时删最旧的（等于在 02 不变量 6 上为 demo 租户开一个口子）；匿名访客在 `admin.html` 实时看到自己的会话，可以由服务端在匿名列表里按 cookie 算出本人的 `web:` 会话（`admin.html` 一行不改，推荐），也可以在 console 加一个匿名只读视图（要给 console 加匿名路由与 J 页的只读变体，工作量大一截）；重置照 02 R5。约多 3–4 个工程日，顶部加「02 R6 的『网页访客会话只放内存』」的部分取代。
   - 种子会话两种选法都不进库（R16）。
2. **真实租户怎么拿到能用于网页渠道的话术。** 已定（owner 2026-10-09：选 A，写成产品限制：prod 下本阶段不开放网页渠道，阶段 4 的渠道中立锁定节出来之后再放开；不按 SOP 里的契约短语推断，见 R15）。依据：第一个真实租户要不要在 03 期间就上网页渠道，以及验收 15 手动部分的结果。前提（评审核实过）：「顾问会在微信上联系您」在旅游包 SOP 的锁定节里，console 改不了，契约检查要求它在；引擎固定话术与工具提示本阶段已按渠道分（R15）。
   - A（推荐）：本阶段 prod 租户不开网页渠道（R15：开关 `web_channel` 在 prod 封顶为关），第一个真实租户只走企微；渠道中立的锁定节随阶段 4 的行业包模板做——开通新租户时选「渠道中立」版本，契约清单按版本给，demo 租户留在原版本、前缀逐字节不动。
   - B：把旅游包的渠道中立锁定节提前到 03：在 `src/packs/travel/` 加一套中立版本的锁定节（「顾问会在这里或微信上联系您」一类按渠道都成立的写法），`tenant-create` 与一次性的平台命令能把一个租户的 SOP 切到这个版本，契约检查里 `advisor-on-wechat` 换成按版本的短语；demo 不切，前缀不变（自动断言）；切了的租户要跑一遍真实模型回归（AGENTS.md：大的 SOP 改动）。约多 3–4 个工程日。
   - C：不改锁定节，加一道确定性护栏把网页会话出站文本里的「在微信上联系」改写掉。自然语言的替换容易漏也容易误伤，SOP 里的指令仍会把模型往微信上带；不推荐。
3. **网页渠道的防刷与成本上限。** 已定（owner 2026-10-09：照推荐的默认值与超限行为；以后给真实租户开网页渠道时再按它的流量调这几个数）。依据：网页入口公开、匿名，每轮调真实模型；上限不能变成放大攻击的开关（评审 Minor 9）。
   - 推荐：每个 IP 每分钟 20 条、每小时新建 10 个会话（env）；每个账号每天新会话 500 个、调模型的轮次 3000 次（账号设置）。超过 IP 限流或新会话上限：429，不发 cookie、不建会话、不调模型。超过轮次上限只影响已有会话：客户的话照常记进会话、不调模型，回固定的一句「现在咨询的人有点多，顾问会在这里回复您」，每个会话至多因此转一次人工（类型 `request`），之后同一会话只回那一句；告警每个账号每天合并成一条。
   - 备选：超过轮次上限也直接 503、不记客户的话（省事，但已经在聊的客户说的话没人看见）；或者像网页模拟器一样降级到离线脚本（真实客户拿到的是固定话术，02 说过真实客户永不降级）。
4. **企微接口行为的待核实点**（承接 02 开放问题 8）。照旧（owner 2026-10-09）：接第一个真实租户之前在测试客服账号上实测，结论记进 plan，只改 `src/quota/ledger.ts` 与适配器里的常量。
   - 同一 msgid 重发时企微是去重还是当新消息：去重的话 `RESEND_UNKNOWN` 改为真，`sending` 的段按同一 msgid 补发，R5 的「请求途中可能漏发」随之消失（开放问题 7）；核实之前为假（只会少发）。
   - 回调明文里有没有 `OpenKfId`：有，几个客服账号共用一个自建应用时配一个回调地址就够；没有，每个账号各配一个应用与回调地址（R12 照样能用，只是分派那一步用不上）。
   - 48 小时 / 5 条是否按客服账号分开算：分开算，R11 的「两段会话、各自的窗口」就对；按企业算的话，同一客户在两个账号上的窗口要合并计数。
   - `sync_msg` 能拉到多久以前的消息：决定入站行留 7 天是否够（02 已列）。
5. **恢复截止点取什么时刻。** 已定（owner 2026-10-09：照推荐）。依据：恢复时宁可漏回（由顾问补）还是宁可重复回。
   - 推荐：取旧实例最后一次正常回复的时刻，有告警时从「健康检查失败」「app 反复重启」那一条往前推；拿不准就取恢复开始的时刻。之前的消息只补记、给顾问看，之后的照常回复。
   - 备选：取备份的时刻（快照之后旧实例回过的消息会再回一遍，但不会漏回）。不设截止点已经不可选：哨兵拦着起不来。
6. **人工回复在崩溃时还停在 `pending`，重启后怎么办。** 已定（owner 2026-10-09：照推荐）。依据：顾问的预期（点了发送就该发出去）与过时的风险（重启隔了很久、会话已经往下走了、别的顾问已经接手）。库可写、不在 R6 下时，`pending` 说明请求从没发出（包括停机截止之后从 `sending` 迁回的段），补发不会重复；R6 下 `sending` 没写成就发了的段也停在 `pending`，补发会多一次（目标 1 写明的 R6 例外）。
   - 推荐：这一行建起 10 分钟内、会话的接手人没变，就按同一 msgid 补发；否则记 `cancelled`，工作台这条显示「未发送」，由顾问决定重发。
   - 备选：一律补发（最省事，但可能隔很久冒出一条过时的话）；一律 `cancelled` 并提示顾问（最稳，但正常的几秒重启也要顾问重发一次）。
7. **「崩溃落在请求途中可能漏发」能不能作为 03 的已知边界翻 ready。** 已定（owner 2026-10-09：接受为已知边界）。依据：这个窗口有多大（一段 send_msg 请求的往返，通常几十到几百毫秒，只在进程被硬杀时命中），与开放问题 4 的实测什么时候能做。
   - 推荐：接受，作为已知边界写进本 spec（R5、不变量 5、6、验收 4）：漏发的那一段在工作台与告警里都看得见，由顾问补；开放问题 4 的实测照旧在接第一个真实租户之前做，结果是「去重」就把 `RESEND_UNKNOWN` 改为真、边界消失，结果是「不去重」就维持现状。
   - 备选：先做开放问题 4 的实测，再定 ready（要先有测试客服账号，ready 时间跟着它走）。
8. **网页访客凭据的有效期与「结束咨询」。** 已定（owner 2026-10-09：照推荐）。依据：同一台设备上的下一个人能不能看到上一个人的咨询（公共电脑、借来的手机），与客户隔几天回来接着聊的需要。
   - 推荐：滑动 30 天（每次发消息续期），页面上有「结束咨询」按钮：清掉 cookie、不删会话（会话照保留期在后台），之后再来就是新会话。
   - 备选：跟着线索保留期（缺省 180 天，太长）；只在浏览器会话内有效（关掉浏览器就丢，客户回来接不上之前的聊天）。

## 被否决的方案

- **只把去重集合搬进库、cursor 留在文件**：cursor 和入站记录还是两份存储、不在同一时刻，恢复与崩溃时照样一边新一边旧。
- **发送之后再记账本**（02 的做法）：「已发出、没记账」这个窗口就是 02 演练复现的那一个；崩溃或备份落在里面，重启就补发。
- **出站行整体留在存档点里**（02 的写法）：`pending` 丢了就成了「回复已在会话里、却没有分段」，重启后没人知道要发，悄悄漏回复；只把结果类留在存档点（R21）。
- **渠道行全部改走与会话无关的短事务**：「客户消息写进会话」与「入站行记 recorded」就不在同一事务，崩溃落在两者之间时一条消息会被记两遍或一遍都不记；只在会话 poisoned 时才改走短事务。
- **回复的 msgid 由入站 msgid 推出，恢复后重新生成的回复靠企微按 msgid 去重挡掉**：依赖还没核实的接口行为；重新生成的回复与客户实际收到的可能不同，库里记的就不是客户看到的；恢复截止点不依赖它。
- **恢复后按 `sync_msg` 里我们自己发出的消息对账**：没核实 API 发出的消息会不会出现在 `sync_msg` 里、带不带我们的 msgid；对不上的情况还要另一套规则。
- **按消息的年龄自动判「旧消息只记不回」，不要恢复截止点**：崩溃重启与恢复从库里分不出来；正常停机半小时后客户等着的消息也会被当成旧消息不回。哨兵文件解决的是「忘了设截止点」，取值仍由人定。
- **插入时就给入站行计一次**（草稿的写法）：一页里排在队头后面、从没开始处理的消息，会因为队头反复崩溃被一起记成 `poison`；02 修过同样的问题，改为出队时计次。
- **启动时发现 env 里有 `WECOM_*`、库里没有账号就自动导入**：镜像风险与数据迁移绑在同一次启动里；02 的切换就是先按旧行为部署新镜像、再停机导入，回退也只动一处。
- **导入时把原文件改名留在 `var/` 里**（草稿的写法）：`var/` 每晚打包进备份、异地留 30 天，留底的客户原文跟着进了备份；照 02 放进 `--keep`。
- **凭据用 pgcrypto 在库里加解密，或把密钥也存进库**：密钥与密文同在备份里等于没加密；pgcrypto 让明文出现在 SQL 语句里，可能进慢查询日志。
- **渠道命令行以 `agent_platform` 身份运行**（01 平台命令行的做法）：要读写凭据就得把密钥再放一份进 `.env.platform`，密钥多一个落点；cursor 等列本来就由应用写（R23）。
- **access_token 存库**：两小时就过期，换进程重新取即可，没必要让它进备份。
- **每个账号一个进程或一个容器**：一家一个实例、账号个位数，进程内按账号建键就够；多进程要另做选主与共享状态。
- **原地改造网页模拟器（沿用 `sim-` 前缀或 `/api/chat`）**：锁定的 `server.selftest.ts` 钉住了 `chat.html` 的存储键与 id 生成、`/api/chat` 只认 `sim-`、`sim-` 的清理与上限；`sim-` 还是「凭 id 匿名可读、24 小时删」的 demo 数据。
- **网页会话 id 直接用访客凭据**（`sim-` 的做法）：id 会出现在后台、日志、审计和工作台的地址里，等于凭据外泄。
- **访客凭据放 `localStorage`、经请求头带**：SSE 带不了自定义请求头，只能进 URL（进反代访问日志）；HttpOnly cookie 页面脚本读不到。
- **网页页面照 `chat.html` 用内联脚本，CSP 放开 `unsafe-inline`**：页面与 console 同源、渲染的是不可信内容，一处注入就能借顾问的登录态调后台。
- **同一客户在同一租户的几个企微账号上合成一段会话**：在客户的微信里它们是几个对话窗口；合成之后回复从哪个账号发、发送窗口怎么算、历史怎么合都要另定。
- **链接显式产出、消息部件放进 03**：改的是引擎出口契约，锁定断言钉住了现在的形状；阶段 4 的护栏流水线本来就要重写出口，一起做只改一次。
- **按租户 SOP 里有没有那句微信措辞来决定 prod 能不能开网页渠道**（上一稿）：把一个产品决定藏进 SOP 文本的推断里；判断还容易写错（规则的 id 与它的 `text` 是两回事）。owner 定了「本阶段 prod 不开放」（开放问题 2），直接写成部署开关的封顶，阶段 4 的 spec 放开它。
- **回滚检查只看标记文件**：02 吃过同样的亏（不经导入直接起 db 存储时没有标记，检查失效，02 顶部 2026-10-03 的 `Revisions:`）；标记不在时再问一次库，只认 `active` 的企微账号，`channel-export` 把默认账号改成 `exported`，导出之后检查才放行得了。
- **导出时把账号行删掉或清空**：`agent_app` 没有 DELETE，凭据与 cursor 之后 `--resync` 还要用；改状态就够。
- **env 账号的内存状态改名**（上一稿把 02 的 `pending` 改叫 `inflight`）：02 的 `quota.selftest.ts` 断言着 `pending`，改名就得改断言；两种账号的取值按表映射即可。
- **让运营在 console 里把真实租户的 SOP 改成渠道中立的**（草稿的推荐）：做不到，锁定节在 console 里改不了、契约检查要求那句微信措辞在；见开放问题 2。
- **种子会话进库**：保鲜每小时平移消息时间戳，库里的消息只追加；进库就得每次删了重灌，等于为 demo 开一条删除通道。
- **渠道账号放进 console 管理**：要做开通流程、凭据录入的界面与权限，属于阶段 4 的开通；本阶段命令行加停机够用。
- **用 Redis 或消息队列存入站**：02「不做的事」的理由不变，单副本下 Postgres 一张表就够，还能和会话同一事务。
