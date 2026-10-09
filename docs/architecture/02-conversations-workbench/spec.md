# 02 · 会话入库 + 坐席工作台

Status: implemented
Phase: 2 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」
Depends on: [01 · Postgres 底座 + 配置入库 + 后台 v0](../01-pg-config-console/spec.md)（implemented：`withTenant`、三个角色、RLS 模板、租户锁、启动顺序、`CONFIG_SOURCE`、后台子应用与鉴权）；[后台 UX 重做](../../features/console-ux/spec.md)（implemented：设计系统、`conversationState`、counts、外壳与铃铛，以及「依赖 02 的后端」移交清单）。选型见 [ADR-001](../../adr/adr-001-postgres-drizzle.md)、[ADR-002](../../adr/adr-002-console-vite-react.md)、[ADR-004](../../adr/adr-004-pack-field-rendering.md)
Amends: 01 的「两种模式与启动装载」（`SESSION_STORE` 的校验、条目版本的启动补写、`/healthz` 的新字段）、「数据库」（新表、`tenants` 三个保留期列、`catalog_items.version`）、「withTenant」（新选项 `longRunning`、`inTenantTx()`）、「产品库 · 编辑规则」（按 01 裁决 R8 与开放问题 5 的推迟条款，`LOCKED_WHEN_ACTIVE` 去掉五个计价与条款字段）、「审计」（新动作、`writeAuditAs`）、「后台 API 与页面」（新接口）；后台 UX spec 的「接口改动」（`CONVERSATION_STATES` 加 `assigned`、`ConversationRow` 新字段、`ConversationCounts.byState` 新键、`AUDIT_ACTIONS` 新动作）。只做新增，或执行 01、UX spec 自己写明「由 02 定 / 02 之后」的条款；改写已实现条款的几处不走 Amends，见下一行
Supersedes in part: [01](../01-pg-config-console/spec.md) 的不变量 4；[后台 UX 重做](../../features/console-ux/spec.md) 的不变量 27 最后一句、「外壳」铃铛新标签打开 `admin.html#s=<id>` 与计数的 30 秒轮询、「会话列表（I 页）」的状态句「接手和回复目前在工作台里完成」与新标签打开 `/admin.html`、验收 20 的「点一行，新标签页打开工作台并选中该会话」与同条 `ADMIN_PASS` 那一句（开放问题 1，owner 2026-10-02 选 A「部分取代」）。原因：db 存储下一轮里的 `saveSession` 要排出落库，01 不变量 4 只在读路径上还成立（本 spec 不变量 9）；J 页的详情接口要给成员看消息正文；UX spec 里这几处「今天 / 目前」是 J 页与 SSE 到位之前的过渡写法，本阶段交付了它们，点一行进的是 console 的 J 页，不再经过 `ADMIN_PASS` 登录。改成什么逐条见「与 01、后台 UX spec 的关系」
Revisions: 2026-10-02 首版草稿经三路评审（代码现实、数据完整性与运维、安全隐私与 spec 质量）后就地修订（draft，尚无代码依赖），同日加入 owner 定的「可观测性与告警」（R24）。主要改动：store 的导入期行为改为与存储模式无关，信号与停机钩子搬进 `src/shutdown.ts`，停机分 normal、drain、late 三段，排不空的改动写进 spill 文件（原为「db 存储下导入期什么都不做」「普通阶段排空，至多丢在途的一次」）；seq 改在 `saveSession` 时同步分配（原为提交时分配，发送账本、`reply` 拿不到）；确定性错误不再重试，会话标成 poisoned 并告警（原为一律退避重试）；切换加标记文件 `var/sessions-in-db.json` 与 `import-sessions --resync`（原为导出之后切不回去）；企微 msgid 去重分三种情况（原为「查到就当已处理」，会吞掉已入库未回复的重放）；`messages.msgid` 不建唯一索引；预载、导入、导出按批读写并放宽语句超时；清除函数改看 `agent_app` 改不了的数据（`updated_at` 只进不退、`paid_at` 写一次），清除时抹掉订单里的客户标识，审计不存会话 id；新增平台的行权删除与撤回同意（R23）；旧 `/handoff` 不设接手人，旧写接口在 prod 由新开关关掉（标记已付除外），匿名的旧读接口去掉成员身份；共享契约的类型挪进 `src/shared/`；`/api/orders/:id` 改为白名单投影；已付会话转人工保留终态并单列提醒（开放问题 12）；`?v=` 与隐私说明改从内存读；用量改挂在 `recordUsage` 上；跟进受 `FOLLOWUP_ENABLED` 控制、加 `sending` 状态；回滚检查加条目版本；改正「锁定断言要求链接后紧跟换行」的错误引用；开放问题按「什么时候定、没答复怎么办」重排，新增 12–14。
Revisions: 2026-10-02 owner 定下开放问题 1–14：1 选 A（「部分取代」，规则写进 `docs/spec-driven-dev.md` 与 AGENTS.md，01 与 UX spec 顶部各加 `Superseded in part by:`），2–14 照推荐（6、12 选 A）。各条就地标「已定」，选项与理由保留。随之改写（行为、接口、数据形状不变）：顶部加 `Supersedes in part:`，`Amends:` 末句改指它（原为「怎么落见开放问题 1」）；「前置条件」的答复规则改为「已全部定下」（原为 1、6、12 开工前必须答复，4、3 没答复就停在第 11.1、14 步，5、8、9、2、7、14 没答复按推荐先做，10、11、13 接真实租户之前定）；非目标、承接表、R9、R13、R15、R20、环境变量表、`negativeLevel` 注释、外部通道、保留期 DDL 注释、同意流程、外部拨测、OpenTelemetry 原文开关、「与 01、后台 UX spec 的关系」、验收 12、15、35 与被否决的方案里「由开放问题 N 定 / 推荐 / 选定的那个」的写法换成定下的结论
Revisions: 2026-10-02 评审之后再改两处。一、不变量 9 补上前半句「DB 模式下，处理一轮对话的读路径不发出数据库查询……会话与 trace 的写入只经这个会话的写队列」，「测试与 CI」的 store 自测随之加一项：「与 01、后台 UX spec 的关系」原已写明 01 不变量 4 改写后落在本 spec 不变量 9，不变量本身却漏了读路径，`SESSION_STORE=db` 下没有一条不变量守住它。二、对 UX 验收 20 的取代范围，本 spec 与 UX spec 顶部写成同一个：取代「点一行，新标签页打开工作台并选中该会话」与同条 `ADMIN_PASS` 那一句，其余照旧（原为本 spec 写整条、UX 顶部只写前一句）。01 顶部随之改指「与 01、后台 UX spec 的关系」，不再写「02 不变量 9」
Revisions: 2026-10-03 owner 确认 plan「Open」里标「已定」的八处，连同实施记录里比原文更严的几处（旧接口只认 `ADMIN_PASS`；import、export 的写序、目录 fsync、`--keep` 先验可写），就地补进本文；一的改写在第 13 步、三在第 15 步落地，其余以已实现的为准。一、匿名可读的旧接口把交还时按固定模板生成的「{姓名}把会话交还 AI」改写成「顾问把会话交还 AI」，旧接口只认 `ADMIN_PASS`、只带 console 登录的请求按匿名处理（原为「带 `ADMIN_PASS` 或成员登录的请求照旧返回原对象」，投影管不到正文里的姓名，与不变量 44 冲突）；二、`POST /api/orders/:id/pay` 两个分支响应体里的订单用 R22 的白名单投影（原文没管这个响应体，demo 下匿名可调，会带出成员身份），不变量 43 与验收 9 随之加这一句；三、advisor 模式下收款方式只经 `/pay/:orderId` 的服务端注入，`/pay.html?orderId=` 跳到 `/pay/:orderId`（原文没说页面从哪儿知道收款方式，R22 白名单里没有这个字段），验收 23 加这一句；四、`orders` 的触发器另拦非属主改已写的 `session_id`（原为只拦改 `paid_at`；`agent_app` 能把已付订单的 `session_id` 置空，会话就按线索的保留期被提前清除），R20、不变量 6、验收 5 与真实 PG 的测试项随之写进这一条；五、清除与行权删除一并删 payload 里 `sessionId` 是这个会话的任务，与会话有关的任务 payload 必带 `sessionId`，`erase_conversation` 的返回值含 `jobs`，不变量 42 加 `jobs`（原为删除范围不含任务；跟进任务的键里带着会话 id，过不了验收 27）；六、`spill_conflict` 也用于回放时文件系统出错、其余意外错误与 spill 不是本租户，`sessions_in_db` 也用于 PG 后端装上之后再调 `initSessionStore`（原为各只有一种含义；不另加拒绝原因，detail 写明实情）；七、db 存储启动时没有标记文件就补写（补写失败只记日志、照常启动），`SessionStoreDeps` 加 `tenantSlug`；import 先写标记再改写 JSON，export 先写订单再写会话最后删标记，改名之后对目录 fsync；`--keep` 在开事务之前先验可写；没有标记而 JSON 与库不一致时 export 以退出码 2 拒绝、一致时当无操作；回滚检查另看服务器 `.env` 的 `SESSION_STORE=db`（原为标记文件只由 import 写、回滚检查只看标记文件与 `catalogVersioned`，不经 import 直接以 db 存储起的实例两道检查都失效），验收 3、32 随之补。
Revisions: 2026-10-03 owner 定（第 11 步 Open）：交互失败的「重复提问」只认在问的话（问号、句末吗/呢/么（呢后来按精确优先不算，见下一行）、疑问词），重复回答不算；阈值不变。原为与前 2 条客户消息之一重复即算（锁定 engine.selftest V4 连说三遍「两位 12号」会被转人工）。
Revisions: 2026-10-03 owner 定（第 11 步第二轮审查）：确定性转人工的三类规则改为精确优先——只在高把握的说法上触发，目标是售前与一般咨询几乎零误判；漏判由主模型兜（第 15 步的 SOP 改动加一句：客户说自己或同行的人此刻遇到危险，或明显冲着我们发火时，先安抚再调 handoff_to_human），不变量 19 随之放宽为第 15 步那一次 SOP 改动含这一句。原为规则同时追求召回（留出集上紧急准确率 63%、售前误判 25%）。随之按开放问题 4 的原意收窄两处：负面情绪的弱词也要冲着我们，没有对象的不算（原为「失望 / 无语 / 太差了」这类词不看对象即算弱）；问句式的辱骂（「你是傻逼吗」）算强，只有打消疑虑的问法不算（原为疑问一律排除）。
Revisions: 2026-10-03 第 11 步第三轮盲测审查之后写明原文漏写的几处，并与代码对齐：「确定性转人工触发」的负面情绪一条写明情绪窗口是最近 3 条客户消息（紧急那一句、已转人工期间的、prod 下被关掉的重置口令那一句也记）、这一句本身负面才判阈值、情绪转人工后窗口清零（原文没写这三处；代码原先不记紧急那一句与被关掉的口令，这次照「最近 3 条客户消息」改了）；`emergencyOf` 注释的此刻标记「一直」改为「一直在」或「一直 + 症状动词」（原为「一直」，代码一直是后者）；开放问题 4 的已定结论后补一句按上一行的精确优先执行；验收 24 补主模型兜底的回归用例（原为只要求通过的用例集合不少，兜底那一句全部失败也能满足）。
Revisions: 2026-10-09 owner 定（第 27 步线上切换时）：开放问题 14 改为「验收用国内云厂商（腾讯云云拨测）的免费试用跑一次，长期用 UptimeRobot」。腾讯云拨测按次收费（1 个探测点每 5 分钟约 270 元/月），对 demo 不值得；demo 服务器在香港，境外探测点访问它不受跨境网络影响，原来担心的误报基本不存在。UptimeRobot 的通知走账号邮件、不推企微群，企微群里的主机告警由 `watch.sh` 负责。「可观测性与告警」的「外部拨测」一条与开放问题 14 照此改。

## 背景与问题

01 之后，SOP 和产品库在 Postgres 里，会话、消息、订单仍是进程内的两张 Map，落盘是 `var/sessions.json` 和 `var/orders.json` 的整文件重写（`src/store.ts`，200ms 去抖）。后台 UX spec 已经把工作台、总览 A2、第四种会话状态和实时通知设计好，等的就是这一层。现状里决定 02 必须先定死的几处：

- **调用方拿的是活对象。** `getSession` / `getOrder` 是同步的 Map 读取，引擎、工具、价格护栏、企微适配器、服务端路由都直接改返回的对象再 `saveSession`。「生成中顾问接管」（`engine.selftest.ts` E5）和「生成中客户付款」都靠多个写者改同一个对象成立。锁定的自测直接 import 这些同步函数。
- **五处非追加写。** 「重置」清空 `messages` 并真删订单（含已付的）；超过 400 条就 `splice` 到 300 条；`handoff_to_human` 之后在原地给 system 消息追加出行日期；企微重放时先删掉已记的客户消息再重跑；演示保鲜整体平移种子会话的时间戳。消息只追加（AGENTS.md 硬规则）之前，这五处都要改写。
- **分不清谁说的。** `ChatMessage.role` 只有 `customer | agent | system`。AI、顾问人工回复、自动跟进、付款确认都记成 `agent`，发给模型时都映射成 `assistant`：交还 AI 之后，模型把顾问的话当成自己说过的。客户在微信里也分不出哪条是真人回的。
- **转人工只有一个布尔值。** `enterHandoff` 只写 `handedOver`、`stage='handoff'` 和 `stageBeforeHandoff`；没有原因、时间、接手人，也没有「曾经转过人工」。确定性安全网、改行程转人工、后台接管这三条路径连原因都不写。AI 转人工和顾问点了接管写的是同一个布尔值，`admin.html` 打开就显示「已接管」，两位顾问同时接管都会成功。`/reply` 不检查会话状态。交还时清掉标记，转人工率被系统性低估。
- **付款与转人工互相打架。** `notifyPaid` 把阶段设成 `paid`，但 `handedOver` 仍为 true；客户再发一句话，引擎把阶段改回 `handoff`，会话从「已成交」退回「等人接手」（本次读代码发现）。
- **通知只有一个不带数据的 `change`。** `/api/admin/stream` 每次落盘推一次，分不出是不是转人工，也不按租户过滤。顾问不盯着后台，转人工的客户就没人接。
- **方案书按当前产品库重算。** 链接是 `/proposal/<线路>/<人数>[/<日期>]`，改价会让已发出的链接变价，所以 01 把计价与条款字段锁死了。已发出的链接要一直能打开；锁定的自测用 `includes('/proposal/r-yunnan-mid/2')` 和「`》` 后换行再接链接」钉住路径的形状，`wecom.selftest.ts` 对固定输入做 `extractCard` 的全等比较，所以版本 1 的链接要逐字节不变。
- **企微的硬约束没有账本。** 客户最后一条消息后 48 小时内最多发 5 条，接口返回成功不代表送达（官方文档）。适配器不存 send_msg 的 msgid，把 `msg_send_fail` 等系统事件全过滤掉了，也不数窗口里发了几条。
- **跟进靠进程内扫描加同步落盘保证「最多发一次」**，跟进话术不过出口护栏，也不识别「别发了」。
- **转人工的确定性触发只有「要人工、退款、投诉」。** SOP 里的「连续两轮无法理解」只是提示词；紧急情况和负面情绪没有任何判定。
- **出了事没人知道。** 日志是散落的 `console.log` 纯文本，带客户原话；备份失败、进程反复重启、模型连续超时、企微发不出去、磁盘将满，都只能靠人上机器看。
- **prod 还不能接真实客户。** 00 定的运行规则：02 交付收款流程和转人工即时推送之前，prod 实例只做验收和预演。「接真实租户之前必须有的」几项（隐私说明、敏感信息同意、保留期清理）都还没有。

本阶段要把「之后改不起的东西」定下来：会话、消息、订单三张表的形状和主键；消息只追加的实现方式（序号、窗口、作废代替删除）；identity map 的加载与写入顺序；转人工记录与四种状态的判定；接手、人工回复、交还的状态机；报价快照的形状（产品库条目版本）；逐轮 trace 与护栏事件；任务表；企微发送账本；收款流程；保留期清理与行权删除只经清除函数；日志、告警与追踪的形状。按 plan 的逐步估算约 70 个工程日，砍法见 plan。

## 目标

1. 会话、消息、订单可以存进 Postgres，由 `SESSION_STORE=db` 显式开启。不开时行为与开工时相同（本 spec 有意改变的引擎行为除外，逐条列在「接口与数据流」），锁定的自测与回归零断言修改。
2. 消息只追加：每会话自增序号，库里没有任何角色能改写或删除消息；删除只经清除函数，只删过了保留期的，或平台按个人请求删除的（R23）。
3. 同步 API 不变：`getSession`、`getOrder`、`saveSession` 仍是同步的，「生成中顾问接管」「生成中客户付款」两个并发行为在两种存储下都成立。进程正常停机不丢已发生的改动。
4. 转人工有完整记录（类型、原因、时间、客户原话、识别出的日期），交还不清「曾经转过人工」，付款时一并记录；会话有第四种状态「顾问处理中」。
5. 顾问在 console 的工作台（J 页）里接手、回复、交还；人工回复即接手，服务端校验接手人；两位顾问不能同时接手；交还之后 AI 分得清哪些话是人工说的。
6. 转人工在提交后 5 秒内出现在打开着的后台（铃铛、标签页标题、浏览器通知），并经 SSE 之外的一个通道推给顾问。
7. 方案书按产品库条目版本渲染，改价后已发出的链接不变价；随之开放五个计价与条款字段的编辑。
8. 每轮一条 trace，护栏每次改写一行事件，按租户、按天计量模型用量。
9. 跟进改由任务表驱动，保持最多发一次，跟进话术过出口护栏并识别拒绝。
10. 紧急情况、交互失败达到阈值、负面情绪三类确定性转人工。
11. 企微发送账本：每次 send_msg 一行，接收发送失败回执，工作台显示窗口与剩余条数，跟进和人工回复按额度放行。
12. 收款流程：prod 关掉站内支付，顾问确认价格、发收款方式、确认收款，每步留审计。
13. 隐私说明链接、敏感信息单独同意并记录、按保留期清理会话与 trace、按个人请求删除与撤回同意。本阶段范围内接第一个真实租户要的前置条件就绪；范围之外的（系统页、PIA、委托处理约定等）列在 plan 的「上线清单」，不作为本 spec implemented 的条件。
14. 可观测性（R24）：结构化日志、关键故障推到企微群机器人、外部拨测、console 里看得到回复延迟、转人工率、AI 出错率与费用；OpenTelemetry 埋点默认关闭，以后能接到 Langfuse。

## 非目标

- 系统页（平台管理员的只读诊断）与租户品牌色：接第一个真实租户之前另写 spec（后台 UX spec 开放问题 3，owner 2026-10-02 定）。
- `channel_inbox` 与渠道层 v2、按账号拆企微单例、同部署多租户（04）；本阶段只做开放问题 5 定下的三条缓解措施。
- 多副本：fence read、每会话 advisory lock、选主（05）。本阶段仍只跑单副本，靠 01 的租户锁拒绝第二个进程。
- 护栏重构成有序 Guard 流水线、阈值与币种改配置（04）。本阶段只在现有改写点记事件，不改护栏顺序与逻辑。
- 看板拆分（AI 独立成交、人机协同成交、按原因的转人工率，03）。本阶段把它们需要的数据存下来（`firstHandoffAt`、`handoffBeforePaid`、转人工类型），console 只给四个运行数字（R24）。
- trace 查看器与「存为回归用例」（03）；政策陈述护栏（03）；真实模型发布闸（03）。
- 部署 Langfuse、Prometheus 或任何时序数据库：运行数字由 SQL 从 `turn_traces` 与 `usage_daily` 算；Langfuse 以后在另一台境内机器上自建，本阶段只做埋点（开放问题 13，owner 2026-10-02 定）。
- 开放产品库的识别字段（`title`、`destination`、`days`、`aliases`、`segments`、`maxAltitude`、`overseas`、tags 里的「国内」）：要等护栏有「改名、改目的地」的回归用例（01 开放问题 5）。
- 顾问改订单价格、顾问新建订单：确认或取消 AI 建的单之外的收款操作留在系统外（开放问题 9）。
- 订单列表页：设计系统里没有这一页。订单出现在 J 页右栏和 A2「待付款」里；要做订单页先补设计系统。
- console 里的「AI 代拟回复」：现有 `insight.ts` 的代拟不过价格护栏，进 console 之前要先过出口护栏，另议。`admin.html` 里的代拟原样保留。
- 用企微原生的会话转接（`kf/service_state/trans` 到状态 3），见裁决 R10。
- 线路 CSV 的逐日行程平铺写法、线路的 `region` 字段（01 plan「Open」里「可以放到 02」的两条）：不是会话工作，归产品库后续 spec。
- 下架 active 条目（01 非目标里写的「02，有了报价快照之后」）：有了条目版本，已发出的方案书在下架后仍能按版本渲染，技术前提已具备；但它是产品库功能、不是会话工作，归产品库后续 spec。
- 合并 `admin.html` 与 console 的两套登录：本阶段 console 是唯一的工作台，`admin.html` 留作 demo 的匿名展示和 `ADMIN_PASS` 旧接口，见 R11。
- 行权请求的自助入口（客户在微信里自己删数据）：本阶段由租户收到请求后经平台命令行执行（R23）。

## 前置条件

开工时逐项核对，缺一项就停下：

- 01 与后台 UX spec 都是 `Status: implemented`，线上 demo 以 `CONFIG_SOURCE=db` 运行。
- `pnpm test` 在开工提交上全绿；记下锁定文件的清单与各自的 sha256：`src/*.selftest.ts` 的 6 个（engine、dejargon、engine-holiday、price-guard、llm、server）、`src/adapters/wecom.selftest.ts`、`eval/cases.json`。下文「锁定套件」指前 7 个。
- `src/db/client.ts` 的 `withTenant`、`holdTenantLock`、`queryCount`，`src/config/source.ts` 的 `configMode()` 与租户锁状态机，`src/boot.ts` 的启动顺序，与 01 spec 一致。
- 开放问题 1–14 已由 owner 在 2026-10-02 全部定下（见「开放问题」各条），不阻塞任何步骤。

## 从总参考、01 与后台 UX spec 接过来的事项

| 事项                                                                          | 来源                                        | 02 的处理                                                                      | 见               |
| ----------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ | ---------------- |
| identity map 全量预载还是懒加载；store 的导入期副作用                         | 总参考「本阶段 spec 必须处理的点」、ADR-001 | 全量预载；导入期行为与模式无关，db 存储另加 `initSessionStore()`               | R2、R3           |
| 三个同步落盘点                                                                | 总参考                                      | 退出：三段停机加 spill 文件；跟进：任务表；企微状态：留在文件加缓解            | R7               |
| 每会话一条写队列；不开跨越模型调用的长事务                                    | 总参考                                      | 每会话合并落库的写队列，一次落库一个短事务                                     | R4               |
| 五处非追加写                                                                  | 总参考                                      | 逐处改写                                                                       | R5               |
| 消息排序用自增 seq；迁入按数组下标写 seq                                      | 总参考                                      | `saveSession` 时同步分配，会话行上记 `last_seq`                                | R4、「导入」     |
| 种子会话和网页访客会话只放内存                                                | 总参考                                      | 不进 PG，仍由现有的 JSON 落盘管                                                | R6               |
| 启动时拒绝第二个进程                                                          | 总参考                                      | 01 的租户锁已做；落库撞上另一写者时优雅停机                                    | R4               |
| 后台 SSE 加鉴权、按租户过滤、提交后才发                                       | 总参考                                      | 新的 `/api/console/events`，每 60 秒复核登录；旧流改为提交后发                 | R12、「通知」    |
| 数据迁入：保留全部可选字段，订单不对产品库建外键，PG → JSON 导出供回滚        | 总参考                                      | `import-sessions` / `export-sessions`，加标记文件与 `--resync`                 | 「导入」         |
| 自测默认跑哪种存储                                                            | 总参考开放问题、01 R16                      | 沿用 R16：`selftest-env.ts` 钉成文件存储，PG 由新套件与 DB 模式 mock eval 覆盖 | R1               |
| `usage_daily`                                                                 | 01 R14                                      | 本阶段建表，挂在 `recordUsage` 上                                              | R16              |
| 一轮之内固定产品库快照                                                        | 01 R6                                       | 开放计价字段之前做                                                             | R14              |
| 锁定字段按什么顺序开放                                                        | 01 开放问题 5                               | 开放五个计价与条款字段，识别字段不动                                           | R14              |
| 生产实例的 `rerender` 是否改成先出草稿                                        | 01 开放问题 6（02 开工前定）                | 维持自动发布                                                                   | R21              |
| 线上内容的真实模型回归                                                        | 01 开放问题 10（接第一个真实租户之前定）    | 固定的回归步骤，不做发布闸（开放问题 10）                                      | —                |
| 下架或删除条目；线路 CSV 的逐日行程；线路的 `region` 字段                     | 01 非目标、01 plan「Open」                  | 不在 02，归产品库后续 spec                                                     | 非目标           |
| `admin.html` 列表 401 时自动弹登录框                                          | 01 非目标、00                               | 本阶段做，不改 `load()` 与 `sigOf()` 的源码                                    | R11              |
| 跟进过护栏、识别拒绝；交还不清标记；`/reply` 服务端校验；转人工即时推送       | 总参考「冻结阶段的小修范围」、00 非目标     | 全部本阶段做                                                                   | R8、R9、R17      |
| 付款确认不看转人工（00 非目标）                                               | 00                                          | 付款确认照发；终态不再被改回 `handoff`                                         | R9               |
| 人工回复和 AI 用同一账号发、客户分不清（00 非目标）                           | 00                                          | 人工回复在客户侧带「【顾问】」                                                 | R8               |
| prod 收款流程；「带凭据可以标记已付」的去留                                   | 00「mock_pay 与 prod 的真实客户」           | 顾问确认收款流程；旧凭据路径保留（锁定自测钉住）                               | R19              |
| demo 下「重置」的底线                                                         | 总参考开放问题、00 非目标                   | 不删数据：推进窗口、订单作废（开放问题 6）                                     | R5               |
| `channel_inbox` 是否提前                                                      | 总参考开放问题                              | 留在 04，做三条缓解（开放问题 5）                                              | R7               |
| SSE 之外的转人工推送通道                                                      | 总参考开放问题                              | 企微群机器人，与告警不同群（开放问题 3）                                       | R13              |
| 负面情绪的识别方式                                                            | 总参考                                      | 确定性的词表加规则（开放问题 4）                                               | R15              |
| 保留期多长；日志里的客户原话也要有保留期                                      | 总参考                                      | 线索 180、客户 730、trace 90 天（开放问题 2）；prod 日志不写原话               | R20、R24         |
| 依赖 02 的后端第 1–7、13 项；J 页、A2、四种状态、实时通知、接手交还、快捷回复 | 后台 UX spec 开放问题 2（owner 2026-10-02） | 本阶段做；第 8 项已满足，第 9、11 项不排期，第 10、12 项另写 spec              | 「后台」         |
| 第 1 项的「脱敏后的消息正文」                                                 | 后台 UX spec「依赖 02 的后端」              | 只读成员看到的正文按规则打码；SSE、通知、日志、告警里没有正文                  | 「后台接口」     |
| 原验收 26 的四条                                                              | 后台 UX spec 提交 `e8ab450`                 | 写进本 spec 验收 10、14、15、16                                                | —                |
| J 页交接卡「AI已转人工 · 14:18」含禁用词                                      | 后台 UX plan「Open」                        | 改为「AI交给人工 · 14:18」，工作台自测扫禁用词                                 | R12              |
| J 页「更多」菜单键盘打不开                                                    | 后台 UX plan「Open」第 1 条                 | 第 20.1 步（J 页之前）修好 `popupRegion` 的焦点                                | plan             |
| 结构化日志、告警、外部拨测、运行数字、OpenTelemetry                           | owner 2026-10-02                            | 本阶段做；Langfuse 不部署                                                      | R24、开放问题 13 |

## 开工前裁决

| #   | 问题                                                 | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 本阶段落地                                                  | 推迟                      |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| R1  | 会话存储怎么开；锁定自测跑哪种                       | 另设 `SESSION_STORE`：未设、空串、`file` 是文件存储，`db` 是 PG 存储，其他值拒绝启动。`db` 要求 `CONFIG_SOURCE=db`，否则 `env_invalid`，绝不回落。不和 `CONFIG_SOURCE` 合成一个开关：切换要停机导入，先以文件存储部署新镜像才能把风险拆开，回滚也只动一个变量。`src/selftest-env.ts`（所有进程内自测与 eval 的第一个 import，不在锁定清单里）把 `SESSION_STORE` 钉成 `file`，本机 `.env` 进不来；以子进程跑 `src/store.ts` 的锁定断言不受它影响，因为导入期行为与模式无关（R3）。PG 路径由新套件、两种存储的等价套件和 DB 模式 mock eval 显式装上（沿用 01 R16）                                                                                                           | `sessionStoreMode()`；`selftest-env.ts`                     | —                         |
| R2  | identity map 全量预载还是懒加载                      | 全量预载：启动时读入全部真实会话的行和窗口内的消息、全部未作废订单。内存形状与今天读 `sessions.json` 相同，同步 API 不变。懒加载要么让 `getSession` 变异步（改锁定自测），要么让列表和计数漏掉冷会话。保留期清理给总量封了顶。预载按 500 个会话一批读，每条语句在 `agent_app` 的 5 秒语句超时之内。预载会话超过 50,000 个、预载超过 30 秒或常驻内存超过 1 GiB 时另写 spec 改成热窗口加懒加载                                                                                                                                                                                                                                                                               | `initSessionStore()`                                        | 热窗口（按信号）          |
| R3  | store 在 import 时的副作用                           | 导入期行为与存储模式无关，和今天相同：读 JSON、探针、`exit` 钩子、保鲜与清理定时器；信号接线、`onShutdown`、`gracefulExit` 搬进 `src/shutdown.ts`，`store.ts` 再导出，两种模式都在导入期注册。db 存储下 JSON 只装 demo 类，照做无害；`boot()` 在 `initConfig` 之后、`serve` 之前 `await initSessionStore(deps)`，它预载 PG 并换上 PG 后端，JSON 里出现真实会话时按标记文件处理（「导入」）                                                                                                                                                                                                                                                                                 | `src/boot.ts` 多一步；`src/shutdown.ts`                     | —                         |
| R4  | 写入顺序与事务边界                                   | 每会话一条写队列：`saveSession` 同步给新消息分配 seq、标脏并排队；同一会话至多一个落库在途，在途期间的改动合并成下一次。一次落库是一个短事务：锁会话行、插新消息、更新会话行、写订单与附带的审计和 trace，提交后才发事件。从不在模型调用期间持有事务。库里的 `last_seq` 与预期不一致，说明有另一写者：标记 `store_conflict` 并走优雅停机。连接与超时类失败按 1、5、30 秒、2 分钟退避重试；数据类错误（SQLSTATE 22、23 类）不重试，会话标成 poisoned、告警。`/healthz` 报积压                                                                                                                                                                                               | `src/store/pg-backend.ts`                                   | 多副本（05）              |
| R5  | 五处非追加写                                         | 重置：内存照旧清空，库里推进会话的窗口起点、订单记作废（不删）；裁剪：内存照旧截到 300 条，库里只推进窗口起点；改写转人工备注：在入库前拼好整条；重放对齐删句：改为「这句已经记过」的入参，不删再插；种子平移时间戳：种子不进 PG。db 存储下已落库的消息对象被冻结，任何原地修改都抛 `TypeError`；数组层面的错位（中间删除、换成副本）在分配 seq 时查出                                                                                                                                                                                                                                                                                                                     | 见「消息只追加」                                            | —                         |
| R6  | 种子与访客会话                                       | `sim-` 和 `wecom:cust_` 开头的会话及其订单（「demo 类」）永不进 PG，表上有 CHECK。两种存储下都由现有的 JSON 落盘、保鲜、清理负责；db 存储下 JSON 文件只装 demo 类。它们的 trace、发送账本、同意记录只在内存；对它们的 console 操作照常写审计，审计单独一个短事务。理由：保鲜每小时改写种子的时间戳；访客上限 5000、闲置 24 小时就删，进库只会制造写入；它们凭 id 匿名可读，是 demo 的公开数据                                                                                                                                                                                                                                                                              | `isDemoClassId()`                                           | 网页渠道转正（04）        |
| R7  | 三个同步落盘点                                       | 进程退出：停机分三段，normal（停企微拉取、等处理链、停任务认领）→ drain（排空写队列、写用量）→ late（关连接池、放锁），总上限仍是 8 秒；drain 超时、遇到冲突或租户锁已在别人手里时，`exit` 钩子把没落库的真实会话同步写进 `var/store-spill-<时间>.json`，下次启动回放。崩溃（没有停机）丢失自上次成功提交以来的改动，受 `lagMs` 约束。跟进记账：任务表的「记账提交后再推送」代替同步落盘。企微 cursor：留在 `var/wecom-cursor.json`（开放问题 5），同时做三条缓解：客户文本消息也记 `msgid`，处理前按三种情况去重（「企微」）；备份先打包 `var/` 再 `pg_dump`；重放对齐看发送账本，已送出的回复不再补发                                                                    | R4、R17、R18                                                | `channel_inbox`（04）     |
| R8  | 消息作者；交还后 AI 怎么分清人工说的话；客户怎么分清 | `ChatMessage` 加可选的 `author`（`ai` / `human` / `followup`，只用于 `role='agent'`，缺省视为 `ai`）。人工回复在客户侧和发给模型的历史里都带前缀「【顾问】」，正文入库时不带。窗口里有人工消息的轮次，contextNote 多一句说明。AI 出站文本开头的「【顾问】」由出口去掉。system prompt 不动                                                                                                                                                                                                                                                                                                                                                                                  | `src/engine.ts` 历史映射；渠道发送                          | 租户自定前缀（03）        |
| R9  | 转人工记录、曾经转过人工、付款与转人工               | `enterHandoff(session, record)` 必须带类型和原因，五条入口无一例外；`handoff` 在交还和重置时清，`firstHandoffAt` 与 `handoffCount` 永不清；订单付款时记 `handoffBeforePaid`。付款确认照发（客户要知道钱到了）。已在终态的会话进入转人工时阶段保留终态（成交统计不变），转人工记录照写、通知照发；它在列表和计数里仍是「已成交」，在铃铛弹层与 A2 里单列「已成交客户要人工」（开放问题 12，owner 2026-10-02 选 A）；客户再发消息不把阶段改回 `handoff`                                                                                                                                                                                                                      | `src/handoff/record.ts`                                     | —                         |
| R10 | 接手的语义；要不要用企微原生转接                     | 系统内部接手：企微侧保持「由智能助手接待」，顾问在 console 里回复，经 send_msg 以客服账号发出。原生转接（状态 3）下 API 发不了消息，也回不到智能助手（没有 3→1），交还 AI 只能结束会话。接手是内存里的同步比较并设置，单进程下两个并发接手恰有一个成功；`origin=5` 的消息（接待人员在企微客户端发的）只记日志                                                                                                                                                                                                                                                                                                                                                              | `src/handoff/takeover.ts`                                   | —                         |
| R11 | `admin.html` 与 console 两个工作台                   | console 的 J 页是唯一的成员工作台：I 页、铃铛、A2 都链到 J 页。`admin.html` 保留 demo 的匿名只读展示、深链和 `ADMIN_PASS` 旧写接口。旧 `/handoff` 只以 `kind='agent'` 进入转人工、不设接手人；旧 `/reply` 以「共享工作台」接手后回复；旧 `/resume` 按交还处理。「共享工作台」的权限与坐席相同（不能改派、不能交还成员接手的会话）。新开关 `legacy_admin_writes`（demo 开、prod 封顶关）管旧的 handoff、resume、reply；旧的标记已付不受它管，锁定的 `server.selftest.ts` 断言 prod 带凭据能标记已付。匿名可读的旧接口返回去掉成员身份的投影。列表 401 时弹登录框在 `load()` 之外实现                                                                                        | `server.ts` 旧路由改调状态机；`profile.ts`                  | 去掉 `ADMIN_PASS`（另写） |
| R12 | 第四种状态；措辞                                     | `conversationState` 加 `assigned`：终态 → `paid`；转人工且有接手人 → `assigned`；转人工且没有接手人 → `human`；其余 `ai`。没有接手人的数据上判定与今天逐个相同。「顾问处理中」在有这种会话时才出现（页签、分组都不画成灰的），所以后台 UX 验收 6 的 13 个种子场景照旧成立。交接卡第一行写「AI交给人工 · 14:18」，顾问主动接手写「小林接手 · 14:18」                                                                                                                                                                                                                                                                                                                        | `src/shared/conversation.ts`                                | —                         |
| R13 | 通知怎么到顾问手上                                   | 三层：console 打开时，SSE 推事件，铃铛、标题、浏览器通知在提交后 5 秒内更新；SSE 断了退回 30 秒轮询；console 没开时，推到企微群机器人（开放问题 3，与告警不同群），接口是 `Notifier`。推送内容只有短码、转人工类型和工作台链接，不含客户原话和 `external_userid`。10 分钟仍没人接手时再提醒一次，企微窗口剩不到 4 小时也提醒一次                                                                                                                                                                                                                                                                                                                                           | `src/notify/`                                               | —                         |
| R14 | 报价快照的形状；按轮固定快照；开放哪些字段           | 快照 = 产品库条目的不可改版本（`catalog_item_versions`）。active 条目每变一次内容生成新版本；方案书链接在版本大于 1 时追加 `?v=<版本>`，不带 `v` 等于版本 1。版本 1 的链接在文件存储和导入数据下逐字节不变（已发出的链接要能打开，锁定断言钉住路径形状，见「背景」）。全部版本在启动时读进内存，匿名请求不查库。订单本来就在下单时冻结金额和线路名。一轮之内 `loadRoutes()` / `loadHotels()` 返回同一代快照。之后开放 `priceFrom`、`bestSeason`、`nightlyFrom`、`inclusions`、`exclusions`                                                                                                                                                                                 | `catalog_item_versions`；`pinCatalogForTurn`                | 识别字段（另议）          |
| R15 | 三类确定性触发                                       | 紧急情况：固定应急话术、立即转人工、本轮不调模型；已转人工时不回话，只把记录升级为紧急并再次通知。交互失败：一轮里出现「模型没给出可用文本」「检索无结果」「客户重复提问」之一即算失败，价格或注入护栏命中的轮次不算；连续 2 轮失败或最近 6 轮里 3 轮失败就转人工。负面情绪：确定性的词表加规则（开放问题 4）。三类规则都精确优先：只在高把握的说法上触发，漏判由主模型兜（第 15 步 SOP 那一句：紧急或发火时先安抚再调 `handoff_to_human`）                                                                                                                                                                                                                                | `src/handoff/triggers.ts`                                   | —                         |
| R16 | trace、护栏事件、用量                                | 每处理一条客户消息收集一条轮次记录（含确定性路径），护栏只在改了文本时记一行；db 存储下随会话的下一次落库写进 `turn_traces` 与 `guard_events`，文件存储下只用于 OpenTelemetry 导出（R24）。字段名沿用 01 的 `sopVersion`、`prefixHash`；记本轮用到的产品库条目版本，不记进程内的代际号。用量挂在 `usage.ts` 的 `recordUsage` 上（所有模型调用的唯一汇聚点），按（租户、天、模型、用途）累加，每 30 秒和停机时 upsert 进 `usage_daily`；`usage.json` 照旧                                                                                                                                                                                                                   | `src/trace/`                                                | Guard 流水线（04）        |
| R17 | 跟进                                                 | db 存储下改由任务表驱动，同样受 `FOLLOWUP_ENABLED` 控制：AI 回复后按阶段阈值排一个 `followup` 任务，客户回话就取消；到点时在活对象上重判资格（复用抽出来的 `shouldFollowUp`）、生成话术、过出口护栏、记账并把任务改成 `sending` 一起提交，再推送；进程在 `sending` 之后崩溃，任务记 `abandoned`、不重发；之前停机或崩溃，任务回到 `pending`。文件存储下的扫描器照旧（锁定的 `llm.selftest.ts` F1 测它），两种存储共用资格判断、护栏和拒绝识别                                                                                                                                                                                                                              | `src/jobs/`                                                 | —                         |
| R18 | 企微额度                                             | 每次 send_msg 自带 msgid 并记一行 `outbound_sends`；同一分段重试时沿用同一个 msgid。窗口按保守口径算：客户最后一条消息的 `send_time` 起 48 小时，自那以后至多 5 次 send_msg，结果不明（超时、网络异常）的也计数；规则的细节待实测（开放问题 8）。AI 回复不受账本拦（客户刚说过话）；跟进要求剩余 ≥2 条且窗口剩余 ≥2 小时；人工回复在剩 0 条或窗口已过时拒绝并写明原因。接收 `msg_send_fail` 回执，按 msgid 记失败并给会话加一条 system 消息                                                                                                                                                                                                                                | `src/quota/ledger.ts`                                       | —                         |
| R19 | 收款                                                 | 收款方式随 `mock_pay`：开（demo）照旧；关（prod）是「顾问确认收款」：AI 建的单先由顾问确认价格，顾问在微信里发收款方式，客户付完由顾问在 console 确认收款，触发付款确认。system prompt 在两种方式下必须相同（00 不变量 12），所以 SOP 锁定节的成交措辞改成两种方式都成立的写法，这是本阶段唯一一次有意改变前缀。旧的 `ADMIN_PASS` 标记已付保留                                                                                                                                                                                                                                                                                                                             | `src/payment/`；`data/sop.md` 两处（同一次另加 R15 的一句） | 顾问改价（开放问题 9）    |
| R20 | 保留期                                               | 三个保留期存在 `tenants` 上，清理只经 SECURITY DEFINER 清除函数。函数自己按租户设置算截止时间、只删过期的行，判断只看 `agent_app` 改不了的数据：`conversations.updated_at` 由触发器保证只进不退、不超过「现在 + 5 分钟」，订单的 `paid_at` 写一次就不能改，订单已写的 `session_id` 只有属主（清除与删除函数、外键动作）能改。清除时一并抹掉订单 `data` 里的客户标识；会话类审计记不含客户标识的 `ref`。时长按开放问题 2：线索 180 天、客户 730 天、trace 90 天，写成迁移的默认值，按租户由平台命令行改                                                                                                                                                                     | `purge_conversation`、`purge_expired_traces`                | —                         |
| R21 | 01 开放问题 6：生产实例的 rerender                   | 维持自动发布。一个实例一个租户期间，rerender 只在运维发起的代码部署时发生；契约检查仍然拦着（不过就拒绝启动），每次 rerender 有审计和版本记录。改成「先出草稿、确认前拒绝启动」会让每次改了硬性要求的部署都变成一次需要人工介入的停服。04 同部署多租户时再按租户隔离（01 开放问题 6 原文）                                                                                                                                                                                                                                                                                                                                                                                 | —                                                           | 按租户隔离（04）          |
| R22 | 公开路由                                             | 白名单只加 `/privacy`。`/api/orders/:id` 改为白名单投影 `{ id, routeTitle, travelers, departDate, totalPrice, status, createdAt, paidAt, confirmed, supersededBy }`（`pay.html` 与 `chat.html` 用到的字段加 advisor 模式要的 `confirmed`），锁定断言只看 `id`。`POST /api/orders/:id/pay` 两个分支响应体里的订单也用这个投影。其余新接口都在管理面；新套件枚举全部路由，白名单以外的匿名请求在 prod 下一律 401 或 404                                                                                                                                                                                                                                                      | `server.ts`                                                 | —                         |
| R23 | 个人要求删除、撤回同意                               | 平台身份的删除路径：`erase_conversation`（SECURITY DEFINER，只 GRANT 给 `agent_platform`，不看保留期）与停机执行的 `erase-conversation` 命令行，删除范围与清除函数相同，审计只记条数与原因。同意记录多一个取值 `withdrawn`；客户说「撤回同意」「删除我的信息」这类话，记一条并转人工（`kind='consent'`），由租户按隐私说明里的行权方式处理。备份里的副本随备份的保留期滚掉，隐私说明里写明                                                                                                                                                                                                                                                                                 | `src/cli/erase-conversation.ts`                             | 客户自助行权（以后）      |
| R24 | 可观测性与告警（owner 2026-10-02）                   | 日志用 pino 输出 JSON，每行带租户、会话 id、请求 id，prod 下不写客户原话。告警推到企微群机器人 webhook（URL 只在服务器的 env 文件里）：备份失败、反复重启或健康检查失败、模型连续出错或超时、企微发送失败、租户锁丢失、磁盘将满，外加写库的冲突、poisoned 与积压。外部拨测探 `/healthz`。回复延迟 p90、转人工率、AI 出错率、每日费用由 SQL 从 `turn_traces` 与 `usage_daily` 算，在 console 总览里给所有者与管理员看，不上时序数据库。OpenTelemetry 埋点默认关闭（没配 OTLP 端点就不加载导出器）：每轮一条 trace，模型调用、工具调用、护栏各一个 span，属性用 OTel 的 `gen_ai.*` 加 Langfuse 的会话与用户属性；客户原文默认不进 span。Langfuse 本阶段不部署（开放问题 13） | `src/log.ts`、`src/ops/`、`src/otel/`、`deploy/watch.sh`    | Langfuse（开放问题 13）   |

## 接口与数据流

### 模块与依赖方向

```
src/
  store.ts                  门面：导出与开工时相同，另加 initSessionStore 等；文件后端仍在这里
  shutdown.ts               信号接线、onShutdown（normal / drain / late 三段）、gracefulExit；store.ts 再导出
  store/
    backend.ts              StoreBackend 接口
    seq.ts                  seq 的同步分配与窗口校验（两种后端共用）
    pg-backend.ts           PG 后端：预载、写队列、落库、冻结、提交后事件、停机排空、spill
    project.ts              Session / Order / ChatMessage ↔ 行 的投影与 normalizeForStore（纯函数，命令行也用）
    events.ts               提交后的领域事件总线
  handoff/
    record.ts               enterHandoff（从 tools.ts 搬出，tools.ts 再导出）
    triggers.ts             紧急、交互失败、负面情绪、敏感信息类别、撤回同意（纯函数）
    takeover.ts             接手、交还、人工回复的状态机（门面之上）
  trace/recorder.ts         轮次上下文（AsyncLocalStorage）、noteGuard、用量订阅
  jobs/                     runner.ts、followup.ts、purge.ts、notify.ts
  notify/                   Notifier 接口与实现
  quota/ledger.ts           企微发送账本
  payment/                  收款方式、订单确认与确认收款
  privacy/                  隐私说明、敏感信息同意
  log.ts                    pino、请求与轮次上下文、logQuote
  ops/                      alert.ts（告警去重与限流）、metrics.ts（运行数字的 SQL）
  otel/                     export.ts（只在配了 OTLP 端点时动态加载）
  db/repo/                  conversations、messages、orders、catalog-versions、traces、usage、jobs、outbound、
                            quick-replies、consents、privacy、metrics
  cli/                      import-sessions、export-sessions、tenant-retention、privacy-publish、erase-conversation
  shared/conversation.ts    conversationState 四态、needSummary
  shared/conversation-types.ts  HandoffKind、HandoffRecord、Assignee、MessageAuthor、OrderStatus、SendWindow、PaymentMode
  shared/text.ts            cleanText：去 NUL、按码点截断、修孤立代理项
console/src/workbench/      J 页
deploy/watch.sh             主机上的巡检：重启次数、健康检查、磁盘（cron 每分钟）
```

依赖规则（`lint` 守，加进 `scripts/check-boundaries.ts` 的两张表）：

- `src/store/project.ts`、`src/store/seq.ts`、`src/handoff/triggers.ts` 是纯函数：不 import `src/db/**`、`store`、`engine`、`tools`、`llm`、`adapters/**`。
- `src/store/pg-backend.ts` 经 `src/db/repo/**` 访问库；`pg`、`drizzle-orm` 仍只被 `src/db/**` import（01 规则不变）。
- `src/db/**`、`src/config/**`、`src/cli/**` 不 import `store`、`src/store/**`（`project.ts` 除外）、`engine`、`tools`、`llm`、`adapters/**`。
- `src/shared/**` 仍只 import `zod` 与 `src/shared/**`（`import type` 也一样）；共享契约用到的会话类型都定义在 `src/shared/conversation-types.ts`，`src/types.ts`、`src/handoff/**`、`src/quota/**`、`src/payment/**` 反过来从这里 import 并再导出。`console/src/**` 仍只 import `src/shared/**` 与 `ConsoleApp` 类型。
- `@opentelemetry/*` 只被 `src/otel/**` import，且只经动态 `import()`；`pino` 只被 `src/log.ts` import。
- 字符串 `app.tenant_id` 仍只出现在 `src/db/client.ts` 与迁移 SQL 里。

### 两种会话存储与启动

```ts
// src/store.ts（新增的导出；原有导出的签名与行为不变）
export type SessionStoreMode = 'file' | 'db';
/** 读 SESSION_STORE：未设、空串、'file' → 'file'；'db' → 'db'。其他值、或 'db' 而 CONFIG_SOURCE 不是 'db'，
 *  由 01 的 initConfigFromEnv 在装载配置之前以 ConfigStartupError('env_invalid') 拒绝启动 */
export function sessionStoreMode(): SessionStoreMode;

/** sim- 或 wecom:cust_ 开头：demo 类会话，永不进 PG（R6） */
export function isDemoClassId(id: string): boolean;

export interface SessionStoreDeps {
  db: Db;
  tenantId: string;
  /** 补写标记文件时记进 tenant（与 import-sessions 写的相同） */
  tenantSlug: string;
  varDir: string;
}
/**
 * 导入期已经按文件后端读好 JSON（两种模式相同，R3）。
 * deps 为 null（文件存储）：var/ 下有标记文件 sessions-in-db.json 时以 sessions_in_db reject，否则立即 resolve。
 * 否则依次：JSON 里有真实会话 → real_in_json → 分批预载真实会话与订单（R2）→ 校验（每个会话的 last_seq 与窗口一致、
 * 订单引用的会话都在）→ 回放 spill 文件 → 装上 PG 后端 → var/ 下没有标记文件就补写一份（写不进去只记一行错误、照常启动，
 * 下次启动再补，回滚检查另看服务器 .env 的 SESSION_STORE=db）→ 登记 drain 与 late 两段停机钩子。
 * （条目版本的启动补写属于配置装载，在 initConfig 里做，与会话存储无关，见「报价快照」）
 * 除补写标记文件外，任何一步失败都以 SessionStoreStartupError reject，不留半装载状态
 */
export function initSessionStore(deps: SessionStoreDeps | null): Promise<void>;

/** 等这个会话当前的改动落库（db）或落盘（file）。超时以 StoreLaggingError reject，改动仍在写队列里 */
export function flushSession(id: string, opts?: { timeoutMs?: number }): Promise<void>;
/** drain 阶段调用：排空所有写队列；超时返回还没落库的会话 id（日志只写短码） */
export function drainStore(timeoutMs: number): Promise<{ undrained: string[] }>;
/** 改动随这个会话的下一次落库提交；提交后才交给 onCommitted 的订阅者 */
export function emitAfterCommit(sessionId: string, ev: DomainEvent): void;
export function onCommitted(cb: (ev: DomainEvent) => void): () => void;
/** 消息的 seq：saveSession 时分配（「identity map 与写入」）；还没分配过的返回 undefined */
export function seqOf(m: ChatMessage): number | undefined;

export interface StoreHealth {
  mode: SessionStoreMode;
  /** 真实会话数（不含 demo 类）。只经 console 的 /status 给成员看，不进 /healthz */
  conversations: number;
  /** 有未落库改动的会话数，与其中最早一次改动距今的毫秒数 */
  dirty: number;
  lagMs: number;
  /** 最近一次失败：只有 SQLSTATE、约束名与会话短码，不带 err.detail 与 err.message */
  lastError: string | null;
  conflict: boolean;
  /** 因数据类错误停写的会话短码（「失败」） */
  poisoned: string[];
}
export function storeHealth(): StoreHealth;

export class SessionStoreStartupError extends Error {
  constructor(
    readonly reason:
      | 'db_unreachable'
      | 'preload_integrity'
      | 'demo_class_in_db'
      | 'orphan_order'
      | 'real_in_json' // db 存储而 JSON 里有真实会话：重跑 import-sessions（补完改写或提示 --resync）
      | 'sessions_in_db' // 文件存储而 var/ 里有标记文件：会话在库里，先 export-sessions；PG 后端已装上之后再调 initSessionStore 也用它（只能装一次）
      | 'spill_conflict', // spill 文件接不上库里的 last_seq；回放时文件系统出错、其余意外错误、spill 不是本租户的也用它（detail 只写文件名与错误码）
    detail: string,
  );
}
export class StoreLaggingError extends Error {} // console 写接口 → 503 store_lagging
```

```ts
// src/shutdown.ts（从 store.ts 搬来；store.ts 原样再导出 onShutdown、runShutdownHooks、gracefulExit）
/** normal：停企微拉取、等处理链、停任务认领；drain：排空写队列、写用量；late：关连接池、放租户锁 */
export function onShutdown(fn: () => unknown, opts?: { phase?: 'normal' | 'drain' | 'late' }): void;
```

- 三段依次跑，段内并发。总上限仍是 8 秒（小于 `docker stop -t 10`）：normal 最多到第 6 秒，drain 最多 1.5 秒，late 最多 0.5 秒；某段超时就进下一段。
- `exit` 钩子同步执行：文件后端照旧同步写 JSON；PG 后端把没落库的真实会话写进 spill 文件（「identity map 与写入 · 停机」）。
- 信号接线与这三个函数在两种存储下都在导入期注册；`followup.ts`、`wecom.ts` 等现有的钩子默认进 normal 段，01 的 `{ phase: 'late' }` 照旧是 late 段。

`deleteOrdersOfSession(id)` 的签名不变：文件存储下照旧删除；db 存储下把这些订单记作废（`voided_at`、`void_reason='reset'`）并移出内存，之后 `getOrder` 返回 `undefined`，与文件存储一致（锁定的 E6p 断言 demo 下已付订单也随重置消失）。

启动顺序（`src/boot.ts`，01 R18 之上多一步，失败分支同 01）：

```
await initConfig()  →  await initSessionStore(deps | null)  →  serve()
  → 监听成功后：preflight、buildIndex、startJobs()（db 存储）或 startFollowUpScheduler()（文件存储）、startWecom()、startAlerts()
```

`initSessionStore` reject 时打印 reason 与 detail、`exit(1)`，其余一个都不调，企微 cursor 不动。

环境变量：

| 变量                          | 进哪个 compose 服务                              | 说明                                                                                                          |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `SESSION_STORE`               | app                                              | `db` 开启 PG 会话存储，要求 `CONFIG_SOURCE=db`；未设、空串、`file` 都是文件存储                               |
| `NOTIFY_WEBHOOK_URL`          | app                                              | 转人工通知用的企微群机器人（开放问题 3），与告警不是同一个群。等同密钥，只在服务器 env 文件里，日志里一律脱敏 |
| `ALERT_WEBHOOK_URL`           | app；主机上 `watch.sh` 与 backup 服务的 env 文件 | 告警用的企微群机器人（R24）。等同密钥，同上                                                                   |
| `INSTANCE_LABEL`              | app、backup、`watch.sh`                          | 告警里的实例名（如「demo」），不写域名与 IP                                                                   |
| `LOG_FORMAT`                  | app                                              | `json` 输出 pino JSON；未设时照旧纯文本（自测与本机开发）。compose 里设 `json`                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | app                                              | 设了才加载 OpenTelemetry 导出器；未设时不导出、不加载（R24）                                                  |
| `OTEL_CAPTURE_CONTENT`        | app                                              | `1` 时 span 带客户与 AI 的原文；默认不带，自建的 Langfuse 有了保留期与权限之前不开（开放问题 13）             |
| `PUBLIC_BASE_URL`             | app                                              | 已有。隐私说明链接与通知里的工作台链接用它拼                                                                  |

`/healthz` 加 `store: { mode, dirty, lagMs, conflict, poisoned }`（`poisoned` 只是个数），不带会话数和任何会话 id；`ok` 在以下任一情况为 `false`：`store.conflict`、`poisoned > 0`、`lagMs > 120000`、租户锁不在本进程手里。HTTP 状态照旧 200（`deploy.sh` 只看 revision），外部拨测看 `ok`（R24）。console 的 `/status` 给成员多带 `conversations` 与 `poisoned` 的短码。

### identity map 与写入

```ts
// src/store/backend.ts
export interface StoreBackend {
  readonly mode: SessionStoreMode;
  /** saveSession 调：同步分配 seq（assignSeqs）、标脏并排进这个会话的写队列 */
  schedule(session: Session): void;
  /** 订单改动（createOrder、markOrderPaid、supersedeOrder、作废）排进订单所属会话的写队列 */
  scheduleOrder(orderId: string): void;
  flush(sessionId: string, opts?: { timeoutMs?: number }): Promise<void>;
  drain(timeoutMs: number): Promise<{ undrained: string[] }>;
  /** exit 钩子里同步调用：没落库的真实会话写进 spill 文件，返回会话数 */
  spillSync(): number;
  health(): StoreHealth;
}

// src/store/seq.ts
/**
 * 同步、幂等。给 session.messages 尾部还没有 seq 的消息依次分配「这个会话分配过的最大 seq + 1 …」，
 * 记进模块内的 WeakMap<ChatMessage, number>（不往对象上加字段），返回本次新分配的消息。
 * 已有 seq 的消息必须严格递增，且全部排在没有 seq 的消息之前；否则抛 WindowCorruptError（中间删除、插入、换成副本）
 */
export function assignSeqs(session: Session): ChatMessage[];
```

- **seq 分配。** `saveSession` 同步调 `assignSeqs`，两种存储都做。db 存储下「分配过的最大 seq」从预载的 `last_seq` 起；文件存储下从读 JSON 时的条数起，只在本进程有效（console 的 `seq`、`reply` 的返回值、账本的 `message_seq` 在文件存储下都只在本进程内有意义，跨重启前端会整体重取）。分配之后被重置或裁剪掉的消息照样落库（见「一次落库」），两次 `saveSession` 之间就被丢掉的消息不分配、不落库，与文件存储下不落盘相同。db 存储下的真实会话遇到 `WindowCorruptError` 时这个会话标成 poisoned（不再落库，告警），内存照旧服务客户；文件存储和 demo 类会话用宽松模式，不抛，只给尾部没有 seq 的消息分配（锁定自测里整体替换 `messages` 的写法照旧可用）。
- **预载。** 按会话 id 分批（每批 500 个会话，一条语句读会话行、一条读这批会话 `seq >= window_start_seq` 的消息、一条读它们的未作废订单），整个预载在一个 `REPEATABLE READ READ ONLY` 的 `withTenant(…, { longRunning: true })` 事务里。另读每个会话最近 7 天带 `msgid` 的客户消息的 msgid，作企微去重集合（「企微」）。会话对象由 `project.ts` 的 `rowToSession(row, messages)` 重建：`state` 列原样 `JSON.parse`，再挂上 `messages`；订单由 `data` 列重建。预载的消息记进 seq 的 WeakMap 并冻结。重建出的对象与导入时的 JSON 对象经 `normalizeForStore` 之后 `deepStrictEqual`（验收 3）。
- **每会话写队列。** 内存里的 Map 仍是本进程的权威；PG 是持久副本。`saveSession` 照旧同步返回，后端排一次落库。同一会话的落库串行，在途期间再来的改动合并成在途结束后的那一次。不同会话并发落库，连接池上限内并行。写队列在模块加载时用 `AsyncLocalStorage.snapshot()` 取一个空的异步上下文，每次落库都在它里面启动：在 `withTenant` 回调或轮次上下文里调 `saveSession`，排出的落库也不继承那个上下文（`withTenant` 不能嵌套）。
- **一次落库**（一个 `withTenant` 事务）：
  1. 第一个 `await` 之前同步取好快照：这个会话已分配 seq 而没提交的消息（含分配之后又被重置、裁剪掉的），进快照即 `Object.freeze`；会话投影（`normalizeForStore` 之后）；排进来的订单、审计行（各自带操作者与 IP）、任务的排程与状态变化、同意记录、trace 与护栏事件、账本行；一个新的 `flush_id`。
  2. `SELECT last_seq, window_start_seq, flush_id FROM conversations WHERE … FOR UPDATE`；没有这一行就插入（`last_seq = 0`）。库里的 `last_seq` 等于「已提交到第几条」就继续；等于本次快照的最后一条且 `flush_id` 是上一次重试的值，说明上一次提交其实成功了（COMMIT 时断线），回滚本事务并补做提交后的步骤；其余抛 `StoreConflictError`。
  3. 按 seq 插入快照里的消息。
  4. `UPDATE conversations SET <投影列>, state, last_seq, window_start_seq, updated_at = session.updatedAt, flush_id`。`window_start_seq` = 内存窗口里第一条消息的 seq（窗口为空时等于 `last_seq + 1`）；重置和裁剪都只体现为它的推进。
  5. 写订单（按 `id` upsert，`data` 列存整个订单对象）、审计（`writeAuditAs(tx, actor, entry)`，01 的 `writeAudit` 取事务的上下文，合批时分不清操作者）、任务、同意记录。
  6. `SAVEPOINT telemetry`，写 trace、护栏事件、账本行；这一段出错就回到存档点、丢掉这几行，日志一行（只有 SQLSTATE 与约束名）、计数加 1，会话本身照常提交。
  7. COMMIT。提交后：记下「已提交到第几条」；把排在这次落库上的领域事件交给订阅者。
- **失败。** 内存不动、事件不发。按 SQLSTATE 分两类：
  - 连接断开、`08` 类、`40001` / `40P01`、`57014`（语句超时）、`53` 类、`57P` 类：按 1 秒、5 秒、30 秒、2 分钟、之后每 2 分钟重试；期间 `/healthz` 的 `dirty`、`lagMs` 增长，日志每次失败一行（不带会话内容）。
  - `22` 类（数据，如 text 里的 NUL）、`23` 类（约束）、`42` 类（权限、语法）、`WindowCorruptError`：不重试。会话标成 poisoned，不再为它落库；内存照旧服务客户，停机时随 spill 写出；`/status` 点名短码，`/healthz` 的 `ok` 变 false，告警（R24）。修好原因后重启，spill 回放（回放仍失败就把 spill 文件改名 `.failed`、告警，从库里的状态起）。
  - `StoreConflictError` 不重试：`conflict = true`，走 `gracefulExit(1)`；drain 段跳过 PG 写入，直接 spill。
- **进内存之前的清洗。** 客户文本、人工回复、system 消息、转人工的 `quote` 与 `reason` 等所有截断，一律经 `src/shared/text.ts` 的 `cleanText(s, maxChars)`：去掉 U+0000，按码点截断（不切开代理对），`toWellFormed()`。引擎原来的 `text.slice(0, 2000)` 与企微重放对齐里的同一截断一起改成它。会话投影另经 `normalizeForStore`（同样的清洗，作用于 JSON 里的每个字符串），比对往返时两边都先过它。
- **长事务。** 落库事务的回调里只有 SQL：不调模型、不发企微、不等别的会话。`chat()` 入口断言当前不在任何 `withTenant` 里（01 的 `client.ts` 新增 `inTenantTx()`，读同一个 AsyncLocalStorage）；单个落库事务超过 2 秒记一行 warn 并计数。引擎在调模型前后各 `saveSession` 一次（与今天相同），两次落库各是一个短事务，可以与 `chat()` 在时间上重叠。
- **停机。** normal 段：先停企微拉取、等处理链、停任务认领（各自已有或新加的钩子）。drain 段：`drainStore(剩余预算)`，用量写入 `usage_daily`。late 段：关连接池、放锁（01）。租户锁已在别人手里（`held_by_other`）或已冲突时，drain 不写库。`exit` 钩子里 `spillSync()`：把仍有未提交改动的真实会话写进 `var/store-spill-<时间>.json`（每个会话：已提交到第几条、未提交的消息连同 seq、会话投影、排着的订单与审计行；trace 与账本行不写），先写临时文件再改名。
- **spill 回放。** `initSessionStore` 在预载之后按时间顺序读 spill 文件：库里的 `last_seq` 等于文件记的「已提交到第几条」，就按一次落库写入；已经等于文件里最后一条的 seq 且内容一致，跳过；其余以 `spill_conflict` 拒绝启动并点名会话短码。全部回放成功后删掉 spill 文件。

### 消息只追加

```ts
// src/shared/conversation-types.ts（src/types.ts 从这里 import 并再导出）
export type MessageAuthor = 'customer' | 'ai' | 'human' | 'followup' | 'system';

// src/types.ts（新增，均为可选字段，旧数据没有它们）
export interface ChatMessage {
  role: 'customer' | 'agent' | 'system';
  content: string;
  at: number;
  msgid?: string; // 02 起企微文本消息也带（R7），不只非文本占位
  /** 企微客户消息的 send_time（毫秒）：发送窗口从它起算（R18）；比处理时刻 at 早 */
  sentAt?: number;
  /** 只用于 role='agent'：ai（缺省）、human（顾问人工回复）、followup（自动跟进） */
  author?: 'ai' | 'human' | 'followup';
  /** author='human' 时：操作者的 user id（共享工作台为 null）与写入时的姓名快照 */
  authorId?: string | null;
  authorName?: string;
}
```

五处非追加写的改法，改完后两种存储下内存里的结果与今天逐字节相同（锁定断言据此不变）：

| 现状                                                                    | 改法                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 重置：`messages = []`，清画像与转人工，`deleteOrdersOfSession` 真删     | 内存照旧（E6、E6p 的断言全部照旧），另清 `handoff`、`assignee`、`turnSignals`、`negativeHits` 并取消待执行的 `handoff_notify`；`firstHandoffAt`、`handoffCount` 不清（R9）。db 存储下库里不删：窗口起点推进到重置回复那一条，订单记作废。demo 下的底线见开放问题 6 |
| 裁剪：超过 400 条 `splice(0, …)` 留 300 条                              | 内存照旧；库里全留，窗口起点推进。工作台按 seq 往前翻页时从库里读                                                                                                                                                                                                  |
| `handoff_to_human` 之后对已入库的 system 消息 `content += 出行时间原话` | `departNoteForHandoff` 在工具执行前算好，作为 `HandoffRecord.departNote` 传进工具，system 消息一次写成整条。最终文本与今天相同                                                                                                                                     |
| 企微重放：会话最后一条正是这句客户原话时 `splice` 删掉、再交给引擎重跑  | 按 msgid 对齐（「企微 · 去重」）：这句已记下、回复还没生成时，适配器传 `{ alreadyRecorded: true }`，引擎不再 push 这句；回复已生成时按发送账本判断要不要重发                                                                                                       |
| 保鲜：给 `wecom:cust_*` 会话与订单平移时间戳                            | 照旧。种子不进 PG（R6）                                                                                                                                                                                                                                            |

- db 存储下进过落库快照的消息对象是 frozen 的；数组层面的错位由 `assignSeqs` 查出。实施时用 DB 模式 mock eval 和等价套件把漏网的原地修改找出来，按上表的思路改，改动记进 plan。
- 引擎的 `handleMessage(sessionId, text, channel, opts?)` 多一个可选参数 `{ msgid?: string; sentAt?: number; alreadyRecorded?: boolean }`，旧调用不变。

### 转人工记录与四种状态

```ts
// src/shared/conversation-types.ts（共享契约用到的会话类型都在这里；服务端模块从这里 import）
export type HandoffKind =
  | 'request' // 客户要人工（isHandoffIntent 的普通诉求）
  | 'complaint' // 投诉
  | 'refund' // 要退款、退订
  | 'emergency' // 紧急情况（R15）
  | 'failure' // 交互失败达到阈值（R15）
  | 'sentiment' // 负面情绪（R15）
  | 'model' // 模型调了 handoff_to_human
  | 'promise' // 模型许诺改行程（CUSTOM_PROMISE），删句后转人工
  | 'claimed' // 回复里说了转接、引擎补转
  | 'consent' // 客户不同意或撤回同意处理敏感信息（R23）
  | 'agent'; // 顾问在后台接手，或旧工作台点了转人工

export interface HandoffRecord {
  kind: HandoffKind;
  at: number;
  /** 给顾问看的一句原因，≤120 字：model / claimed 取模型给的 reason，其余按 kind 写固定说明 */
  reason: string;
  /** 触发这次转人工的那句客户原话，≤200 字；agent 没有 */
  quote?: string;
  /** 客户原话里识别出的出行时间（departNoteForHandoff 的结果） */
  departNote?: string;
}

export interface Assignee {
  /** console 成员的 user id；共享工作台（ADMIN_PASS 旧接口）为 null */
  userId: string | null;
  /** 写入时的显示名快照；共享工作台写「共享工作台」 */
  name: string;
  at: number;
}
export type OrderStatus = 'pending_payment' | 'paid' | 'cancelled' | 'superseded';
export type PaymentMode = 'online' | 'advisor';
// SendWindow 见「企微」

// Session（src/types.ts）新增的可选字段
//   handoff?: HandoffRecord            本次转人工，交还、重置时清
//   firstHandoffAt?: number            第一次转人工的时间，永不清
//   handoffCount?: number              转人工次数，永不清
//   assignee?: Assignee | null         接手人
//   turnSignals?: number[]             最近 6 轮是否失败（0 / 1，新的在后），R15
//   negativeHits?: number[]            最近 3 条客户消息的负面情绪命中（0 / 1 / 2 = 无 / 弱 / 强），R15
//   followupOptOut?: { at: number; quote: string }
//   consent?: Partial<Record<SensitiveCategory, 'asked' | 'granted' | 'declined' | 'withdrawn'>>
// Order（src/types.ts）新增的可选字段
//   handoffBeforePaid?: boolean        标记已付时，会话是否曾经转过人工
//   catalogVersion?: number            下单时线路的条目版本
//   confirmedAt?: number; confirmedBy?: { userId: string | null; name: string }
//   paidMarkedBy?: { userId: string | null; name: string }
//   cancelReason?: string

// src/handoff/record.ts
/**
 * 进入转人工。已在转人工中：record 只在 kind 为 emergency 而原记录不是时覆盖（升级），其余保留第一次的记录。
 * 从「未转人工」进入时：assignee = null；stageBeforeHandoff 的写法与今天相同；阶段是行业包终态时保留终态（R9），
 * 否则改成 handoff；首次进入时 firstHandoffAt = record.at；handoffCount + 1。
 * 每次进入或升级都 emitAfterCommit({ type: 'handoff.started', … })
 */
export function enterHandoff(session: Session, record: HandoffRecord, prevStage?: SalesStage): void;
```

- 五条入口都改成带记录调用：确定性安全网（`request` / `complaint` / `refund`，由 `handoffReply` 已经算出的三类给出）、模型调工具（`model`）、改行程承诺（`promise`）、回复里说了转接（`claimed`）、后台接手（`agent`）；02 新增的 `emergency`、`failure`、`sentiment`、`consent` 同样经它。
- 引擎在已转人工时把阶段强制改回 `handoff` 的那一处，跳过终态阶段（行业包里标了 `terminal` 的）。
- `notifyPaid` 照旧发付款确认；`markOrderPaid` 记 `handoffBeforePaid = session.firstHandoffAt != null`。
- 终态会话的转人工（R9、开放问题 12）：状态仍是 `paid`，徽标、计数、「等人接手」页签都不含它；`handoff.started` 事件与外部通知照发；铃铛弹层与 A2「需要你处理」把「终态、`handedOver`、没有接手人」的会话单列一组「已成交客户要人工」，行内写原因与等待时长，点开进 J 页（UX 不变量 19 不受影响）。

```ts
// src/shared/conversation.ts（后台 UX spec 的同名函数，扩成四态）
export const CONVERSATION_STATES = ['ai', 'human', 'assigned', 'paid'] as const; // 在 console-api.ts
/** paid：stage 是行业包终态；assigned：handedOver 且有接手人；human：handedOver 且没有接手人；ai：其余。
 *  参数是结构类型：Session（assignee 可选）与 ConversationRow 都能直接传 */
export function conversationState(
  row: { stage: string; handedOver: boolean; assignee?: { userId: string | null; name: string } | null },
  pack: Pick<IndustryPack, 'stages'>,
): ConversationState;
/** 「已成交客户要人工」：终态、handedOver、没有接手人 */
export function paidNeedsHuman(
  row: { stage: string; handedOver: boolean; assignee?: unknown },
  pack: Pick<IndustryPack, 'stages'>,
): boolean;

export interface NeedProfile {
  destinationInterest?: string;
  segment?: string;
  travelers?: number | string;
}
export interface NeedVocabulary {
  /** 产品库里 active 条目的目的地名 */
  destinations: readonly string[];
  /** 行业包客群词表：键 → 短标签（如 elderly → 带爸妈） */
  segments: Readonly<Record<string, string>>;
}
/**
 * 会话标题后半段，如「贵州带爸妈4人」。只用规范化的取值：目的地取 destinationInterest 里命中的第一个词表目的地，
 * 客群只认词表里的键，人数只取数字；画像里的自由文本一个字也不回显。取不到的部分省略，全空时为 null。不含昵称
 */
export function needSummary(profile: NeedProfile, vocab: NeedVocabulary): string | null;
```

### 接手、人工回复与交还

```ts
// src/handoff/takeover.ts —— takeover、release 是同步的内存操作（比较并设置），之后 saveSession；
// reply 先同步检查，再入库、等提交、发送。调用方都再 await flushSession(id, { timeoutMs: 5000 })
export interface Actor { userId: string | null; name: string; role: Role | 'shared' }

/**
 * 没有接手人或接手人就是自己：成为接手人（未转人工时先以 kind='agent' 进入转人工）。
 * 别人接手中：不带 force 抛 AssignedToOtherError；带 force 而角色低于 supervisor（含 agent 与 shared）抛 ForbiddenError；
 * supervisor 以上改派。每次成为接手人（含改派）这个会话的接手代次加 1
 */
export function takeover(sessionId: string, actor: Actor, opts?: { force?: boolean }): TakeoverResult;
/**
 * 交还 AI：接手人本人、supervisor 以上，或会话转人工但没人接手时任何能处理会话的成员（含共享工作台）；其余抛 NotHandlingError。
 * session.consent 里任何类别的当前取值是 declined 或 withdrawn 时抛 ConsentDeclinedError（R23：客户不同意处理的信息不能再交给 AI）。
 * 清 handedOver、handoff、assignee；阶段按今天的规则恢复，判「已付」改看行业包终态
 */
export function release(sessionId: string, actor: Actor): void;
/**
 * 人工回复：
 * 1. 同步检查，不通过就什么都不改：别人接手中抛 AssignedToOtherError；企微渠道查发送账本，剩 0 条或窗口已过抛 SendWindowError；
 *    写库积压超过 5 秒、已冲突或这个会话 poisoned 时抛 StoreLaggingError。
 * 2. 没有接手人时先 takeover；push 一条 author='human' 的消息（cleanText，1–2000 字）并 saveSession。
 * 3. await flushSession(id, { timeoutMs: 5000 })，提交之后才发：崩溃时只会「库里有、客户没收到」（账本里没有 accepted，
 *    工作台显示没送达），不会「客户收到了、库里没有」。超时也照发，返回 persisted: false（改动仍在写队列里，停机时进 spill）。
 * 4. 经渠道发出（客户侧带「【顾问】」）；发送失败追加一条 system 消息并返回 { sent: false }（与今天相同）。
 * clientId 相同的重复提交在 10 分钟内返回第一次的结果，不重发
 */
export function reply(
  sessionId: string,
  actor: Actor,
  text: string,
  clientId: string,
): Promise<{ sent: boolean; seq: number; persisted: boolean }>;
/** 接手代次：进程内计数，不进 Session */
export function takeoverGen(sessionId: string): number;

export class AssignedToOtherError extends Error { constructor(readonly assigneeName: string) } // → 409 assigned_to_other
export class SendWindowError extends Error { constructor(readonly reason: 'window_closed' | 'quota_exhausted', readonly closesAt: number | null, readonly remaining: number) } // → 409
export class NotHandlingError extends Error {} // 角色够、但不是接手人 → 409 not_assignee
export class ForbiddenError extends Error {} // 角色不够 → 403 forbidden
export class ConsentDeclinedError extends Error {} // → 409 consent_declined
```

- 状态码的规则：角色不够做这件事是 403 `forbidden`；角色够、但会话不归你是 409（`assigned_to_other` 或 `not_assignee`）。权限表与这些函数一致。
- 旧接口 `/api/sessions/:id/handoff|resume|reply`（`ADMIN_PASS`，受开关 `legacy_admin_writes` 管，关时像不存在一样 404）改调同一组函数，操作者是共享工作台（`role: 'shared'`，权限同坐席）：
  - `handoff`：`enterHandoff(kind='agent', reason='共享工作台转人工')`，不设接手人，状态是 `human`；已在转人工中就什么都不改，返回 200。
  - `resume`：`release`。成员接手中的会话返回 409。
  - `reply`：`reply`（每个请求生成一个 clientId），没人接手时以共享工作台接手。响应形状照旧（`{ ok }`）。
  - 锁定的 `server.selftest.ts` 在没有 console 成员接手的 `sim-` 会话上依次调 handoff、resume、reply，结果照旧都是 200，人工回复落进会话。
- 生成途中被接手（E5）：接手改的是 identity map 里同一个对象，引擎调完模型后看到 `handedOver` 照旧静默。模型返回之后还有几次 `await`（`strandedReply`、`deterministicRecommend`、`repairLinks`），这期间的接手由接手代次兜住：引擎在轮次开始时记下 `takeoverGen`，在把 AI 回复 push 进会话之前同步比较一次，适配器在调 `sendRich` 之前再比较一次；变了就不发，记一条 system「本轮未发送（顾问已接手）」。
- 交还时不给客户发消息（与今天相同），记一条 system 消息「{姓名}把会话交还 AI」。这条消息由一个固定模板生成，匿名可读的旧接口把它改写成「顾问把会话交还 AI」（「后台接口」匿名投影一条）。
- 发给模型的历史：`author='human'` 的消息映射成 `assistant`，正文前加「【顾问】」。窗口里有这样的消息时，contextNote 末尾多一句：「历史里标【顾问】的话是人工顾问说的，不是你说的；顾问答应过的事以顾问为准，不要改口，也不要在自己的回复里写【顾问】。」出口在最后一步去掉 AI 回复开头的「【顾问】」。
- 人工回复正文不过价格护栏（人可以做承诺），只做渠道已有的去 markdown；长度 1–2000 字。

### 确定性转人工触发

```ts
// src/handoff/triggers.ts —— 纯函数，配向量表自测
export type EmergencyKind = 'altitude' | 'injury' | 'medical' | 'documents' | 'stranded';
/** 客户本人或同行的人此刻正处在危险或困境里：高反症状、受伤、急病、证件丢失、被困走失。精确优先，只认高把握的说法：
 *  主语是客户本人、家人或明确的同行，事件已经发生或正在发生（关键词带了、啦、咯，同一句里有现在、刚刚、突然、正在、
 *  一直在（或「一直 + 吐、烧、咳这类症状动词」）这类此刻标记，或吐个不停、高烧不退、喘不上气、被困在……上这类持续的说法），没有求助以外的问句；
 *  出行前的提问（「会不会高反」「高反怎么办」）、假设与将来、否定、差点与已经好了、转述别人或网上的事、价格俚语与玩笑、
 *  目的地的新闻都不算。拿不准就不判，交给主模型 */
export function emergencyOf(text: string): EmergencyKind | null;

export interface TurnSignals {
  emptyModelReply: boolean; // 模型没给出可用文本，落到兜底话术（engine.ts 里空回复那一处）
  noRetrievalResult: boolean; // 本轮 search_routes 什么也没返回，且不是 destinationMiss
  repeatedQuestion: boolean; // 这句是高把握的问句（问号、句末吗/么、正反问、多少钱几天几号哪里什么时候这类明确问法；句末呢、陈述里内嵌的疑问词与任指不算），且与前 2 条客户消息之一重复（去标点空白后相同，或字二元组 Jaccard ≥ 0.8，长度 ≥ 4 字）；重复回答不算
  guardHit: 'price' | 'injection' | null; // 有值时整轮不算失败
}
export function turnFailed(s: TurnSignals): boolean;
/** 最近 6 轮（新的在后）：最后 2 轮都失败，或其中 3 轮失败 */
export function failureThresholdReached(recent: readonly number[]): boolean;

/** 负面情绪（开放问题 4：词表加规则）：0 无、1 弱、2 强。精确优先，只认冲着我们（你们、你、客服、机器人、AI、这家）的重话：
 *  强是冲着我们的辱骂与单独成句的「滚」「垃圾」「骗子」这类（含叠说、问句式的「你是傻逼吗」），弱是冲着我们的抱怨
 *  （你们太差了、你们不靠谱、别敷衍我、答非所问、说了多少遍了）；没有对象的、点名别家的、自嘲与售前疑虑都不算 */
export function negativeLevel(text: string): 0 | 1 | 2;
/** 最近 3 条客户消息里有 1 次强或 2 次弱 */
export function sentimentThresholdReached(recent: readonly number[]): boolean;

export type SensitiveCategory = 'health' | 'minor';
/** 长辈病史、慢病、孕期、行动不便这类健康信息；14 周岁以下孩子的年龄等信息 */
export function sensitiveCategoriesOf(text: string): SensitiveCategory[];
/** 「撤回同意」「删除我的信息」「别保存我的资料」这类行权的话（R23）。按小句判，疑问与转述排除 */
export function consentWithdrawalOf(text: string): boolean;
```

- **紧急情况**在客户消息入库之后、「已转人工」判断之前判：
  - 未转人工：回固定应急话术，`enterHandoff(kind='emergency')`，本轮不调模型。话术：「您的安全最要紧。如果有生命危险，请马上拨打 120（在境外请拨当地的急救电话）；证件丢了先到就近的派出所或我国使领馆求助。我已经通知顾问，会尽快联系您。」客户同一句在问身份时照 00 不变量 16 先承认是 AI。
  - 已转人工：不回话（00 不变量 14 不变），记录升级为 `emergency`，再推一次通知。
  - 已付款、正在出行的客户最常遇到紧急情况：终态会话照样转人工、通知（R9），在铃铛与 A2 的「已成交客户要人工」里排第一。
- **交互失败**在本轮出口护栏之后判；达到阈值时这一轮的回复换成确定性的转人工话术（沿用 `handoffReply` 的「普通诉求」措辞），`enterHandoff(kind='failure')`。达到阈值后计数清零。
- **负面情绪**在客户消息入库后判，达到阈值时与「投诉」同样处理（`handoffReply` 的投诉措辞），`kind='sentiment'`；`isComplaint` 已经命中的不重复计。每条客户消息的强弱都记进窗口，窗口就是最近 3 条客户消息：紧急那一句、已转人工期间的、prod 下被关掉的重置口令那一句也记（只记不判）；这一句本身是负面的才判阈值（交还之后一句中性的话不按情绪转人工）；达到阈值转人工后窗口清零。
- 三类规则都精确优先（owner 2026-10-03）：只在高把握的说法上触发，宁可漏判、不能误判，目标是售前与一般咨询几乎零误判；漏掉的由主模型兜——第 15 步的 SOP 改动加一句：客户说自己或同行的人此刻遇到危险，或明显冲着我们发火时，先安抚再调 `handoff_to_human`（不加延迟、不多调模型）。已转人工期间客户的消息也进情绪窗口（只记不判），窗口是最近 3 条客户消息。
- 三类规则都不得改变锁定套件里任何一句的转人工结果：实施时先把锁定套件和 `eval/cases.json` 里的客户原话过一遍新规则，有冲突就停下记进 plan「Open」，不改断言。

### 报价快照与产品库字段开放

```sql
-- 每个 active 条目的每次内容变化一行，永不修改
CREATE TABLE catalog_item_versions (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL,
  code            text NOT NULL,
  version         int  NOT NULL CHECK (version > 0),
  payload         json NOT NULL,             -- 与 catalog_items.payload 同为 json，键序原样
  source          text NOT NULL CHECK (source IN ('backfill','activate','console','fix')),
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, code, version),
  FOREIGN KEY (tenant_id, kind, code) REFERENCES catalog_items (tenant_id, kind, code)
);
ALTER TABLE catalog_items ADD COLUMN version int NOT NULL DEFAULT 1;
-- 迁移里按租户回填：每个 active 条目以当前 payload 写 version 1（source='backfill'）
```

- 上架写版本 1；active 条目每次经后台或 `catalog-fix` 改动，在同一事务里写版本 `n + 1` 并把 `catalog_items.version` 改成它。草稿的编辑不产生版本。
- **启动补写**（DB 配置模式，`initConfig` 里、产品库快照装载之后，两种会话存储都做）：没有任何版本行的 active 条目（回滚到 01 镜像期间上架的）以当前 payload 写版本 1；最新版本的 payload 与 `catalog_items.payload` 不同的（01 镜像期间改过非锁定字段）写一个新版本，都记 `source='backfill'` 与 `catalog.version` 审计。
- 全部条目的全部版本在启动时读进内存，之后的新版本在写入事务提交后加进内存；匿名路由只读内存，不查库（01：匿名读取一律出自进程内缓存）。
- `generate_proposal` 与方案书相关的链接：线路当前版本是 1 时形状与今天逐字节相同；大于 1 时追加 `?v=<版本>`。链接白名单、`linksFromCalls`、企微卡片识别都接受这个后缀；`public/proposal.html` 把地址里的 `v` 原样转给 `/api/proposal/:routeId`。
- `/proposal/*`、`/api/proposal/:routeId`、页面标题与分享卡片：带 `v` 时按该版本的 payload 和代码里的定价规则渲染；`v` 不是正整数、或大于该条目当前版本时 404，不查库。不带 `v` 按版本 1。
- 订单的 `catalogVersion` 记下单时的版本；金额与线路名照旧冻结在订单上。
- **按轮固定快照**：`src/config/source.ts` 加 `pinCatalogForTurn<T>(fn: () => Promise<T>): Promise<T>`，用 AsyncLocalStorage 记下开始时的 `CatalogSnapshot`，`currentCatalog()` 在轮内返回它。引擎把 `handleMessageInner` 的正文包进去。跟进生成同样包一层。文件模式下什么都不做。
- 以上都落地之后，`LOCKED_WHEN_ACTIVE.route` 去掉 `priceFrom`、`bestSeason`、`inclusions`、`exclusions`，`.hotel` 去掉 `nightlyFrom`。后台的锁定组随之变化（行业包配置），这几个字段在 active 条目上可编辑，保存条写明「改价只影响之后的报价和方案书，已发出的方案书和订单不变」。价格护栏不改：会话里报过的价仍有出处（`quoteHistory`）。
- 回滚到 02 之前的镜像会让条目版本失真（那期间生成的链接不带 `v`、按当前内容渲染，回到 02 后被当成版本 1）：`deploy.sh` 的回滚检查见「导入、导出与切换」。

### 逐轮 trace、护栏事件与用量

```ts
// src/trace/recorder.ts
export interface TurnContext {
  turnId: string; // uuid
  conversationId: string;
  startedAt: number;
  sopVersion: number | null;
  prefixHash: string;
  /** 本轮工具结果里出现过的产品库条目与其版本，如 { 'route:r-guizhou': 2 } */
  catalogVersions: Record<string, number>;
  calls: TraceCall[]; // { name, args, ms, prefetch, resultHead: string（前 4,096 字节）, resultBytes }
  llm: TraceLlmCall[]; // CallTrace 加 usage：{ model, hedged, ms, tools, toolMs, reused, promptTokens, completionTokens, cachedTokens, reasoningTokens, error }
  guards: GuardEvent[];
  draft: string | null; // 模型原稿（chat() 的 raw）
}
/** error：这次模型调用的失败类别；成功为 null。AI 出错率按它算（R24） */
export type LlmErrorKind = 'timeout' | 'rate_limited' | 'http_5xx' | 'bad_response' | null;
export interface GuardEvent {
  guard: string; // 现有改写点的名字，如 link_whitelist、markdown、dejargon、custom_promise、repair_links、handoff_claims、injection、encyclopedia、unbacked_claims、price、stranded、adults、dangling、identity、post_handoff
  action: 'drop_sentence' | 'replace' | 'patch' | 'append' | 'strip' | 'handoff';
  removed: string[]; // 按句对比得出，每句 ≤200 字
  added: string[];
  at: number;
}
/** 引擎在 handleMessageInner 开头调；两种存储都收集（只在内存） */
export function startTurn(conversationId: string): void;
/** 出口每个改写点调一次；before === after 时什么都不记 */
export function noteGuard(guard: string, before: string, after: string, action: GuardEvent['action']): void;
/** 轮次结束：db 存储下把 trace 排进这个会话的下一次落库（demo 类会话不入库）；配了 OTLP 端点时导出（R24）；AI 回复消息经 WeakMap 关联 turnId */
export function endTurn(outcome: TurnOutcome, finalText: string, stageBefore: SalesStage, stageAfter: SalesStage): void;
export type TurnOutcome = 'replied' | 'silent' | 'handoff' | 'deterministic' | 'reset' | 'budget' | 'error';
```

- `onToolCall` 照旧，多一个订阅者把数据交给当前轮次。用量的汇聚点是 `usage.ts` 的 `recordUsage`（`llm.ts` 的 `recordCompletion` 是私有的、`retrieval.ts` 直接调 `recordUsage`）：它多一个可选的末参 `purpose`（缺省 `chat`）和一个订阅接口 `onUsage(cb)`；`completeText(system, user, opts?: { purpose; sessionId })` 多可选参数，洞察（`insight`）、建议（`suggestion`）、代拟（`draft`）、跟进（`followup`）各自传；`retrieval.ts` 传 `embedding`。轮次与 `usage_daily` 的累加器都订阅 `onUsage`。
- 用量：内存里按（天、模型、用途）累加，每 30 秒与停机的 drain 段以 `INSERT … ON CONFLICT DO UPDATE SET calls = usage_daily.calls + excluded.calls …` 写入；`cost_milli_cny` 由 `usage.ts` 现有的 `costOf` 算。天按服务器时区（`TZ`）。对冲输家的用量今天拿不到，照旧不记。
- 护栏事件只在文本变了的时候记。`removed` / `added` 由按句切分后对比得出，J 页的「AI原稿里删了1句 · 展开」就读它。
- trace 里有客户原话和工具参数，属于个人信息：保留期见 R20，只有所有者、管理员能读原文（权限表）。

### 任务表与跟进

```ts
// src/jobs/runner.ts
export type JobKind = 'followup' | 'handoff_notify' | 'retention_purge';
export type JobStatus = 'pending' | 'running' | 'sending' | 'done' | 'failed' | 'cancelled' | 'abandoned';
export interface JobSpec {
  kind: JobKind;
  dedupeKey: string;
  runAt: number;
  payload: unknown;
  maxAttempts: number;
}
/** 同一 dedupeKey 已有 pending、running 或 sending 的任务时什么都不做（唯一索引兜底） */
export function enqueue(spec: JobSpec): void; // 随会话落库提交（与会话有关时），否则单独一个事务
export function cancel(dedupeKey: string): void;
/** 每 5 秒认领一批：status='pending' AND run_at <= now() ORDER BY run_at LIMIT 10 FOR UPDATE SKIP LOCKED，改成 running 并提交，再执行 */
export function startJobs(): void;
```

```ts
// src/engine.ts（新增导出）：AI 回复所用的同一套出口护栏，供跟进等非对话轮次的出站文本使用
export function guardOutbound(session: Session, text: string, opts: { kind: 'followup' }): Promise<string>;
// src/followup.ts（从私有函数改为导出，两种存储共用）：FOLLOWUP_ENABLED、阶段阈值表、MAX_PER_SESSION、MAX_PUSH_FAILURES 都在里面
export function shouldFollowUp(s: Session, now: number): boolean;
```

- **跟进**（db 存储，`FOLLOWUP_ENABLED=1` 时才排，与文件存储的扫描器同一开关，默认关）：AI 回复落库时，若会话满足 `shouldFollowUp` 的静态条件（未转人工、企微渠道、非 demo 类、非终态、阶段在阈值表里、最后一条非 system 消息是我们发的、没有 `followupOptOut`、本阶段没跟过、未到 `MAX_PER_SESSION`、失败次数未到 `MAX_PUSH_FAILURES`），排 `followup:<会话>:<阶段>`，`runAt` = 最后动静 + 该阶段的阈值，落在 22:00–9:00 就顺延到 9:00。客户回话时取消。到点后：在活对象上重判 `shouldFollowUp` → 生成话术 → 过出口护栏（`guardOutbound`，与 AI 回复同一套：价格、链接白名单、内部用语、空头承诺、去 markdown）→ 查发送账本（R18）→ 记账（count、stages、pendingAt）并把任务改成 `sending`，随同一次会话落库提交 → 推送 → 成功则 `done`，明确失败则退账、`failed`、失败计数加 1。
- **重启与停机**：停机的 normal 段把还没进 `sending` 的 `running` 跟进改回 `pending`（下次启动再追，与今天相同）。启动时：`running` 的跟进改回 `pending`（还没记账，什么都没发）；`sending` 的跟进改记 `abandoned`、不重发（记过账，可能已经发了）；其余种类的 `running` 改回 `pending`、`attempts` 加 1，达到 `max_attempts` 记 `failed`。
- **拒绝识别**（两种存储都做）：客户说「不用了」「别发了」「不需要了」「已经订别家了」「不考虑了」这类话（按小句判，疑问与否定排除），记 `followupOptOut`，取消已排的跟进。
- 与会话有关的任务（`followup`、`handoff_notify`）`payload` 必带 `sessionId`：清除与行权删除据它把任务一并删掉，否则 `dedupe_key` 与 `payload` 里的会话 id（`wecom:<external_userid>`）会在删除之后留下来（验收 27、不变量 42）。
- `handoff_notify`：转人工提交后立即排一个，10 分钟后若仍没人接手再排一个；企微窗口剩不到 4 小时、仍在转人工中时排一个。至多重试 3 次。
- `retention_purge`：每天 3:30 一个，`dedupe_key` 是 `retention_purge:<日期>`，见 R20。

### 企微：发送账本、回执与去重

```sql
CREATE TABLE outbound_sends (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,              -- 不建外键：老客户进入会话时补发的欢迎语可能还没有会话；清除与删除函数按 id 显式删
  channel_msgid   text NOT NULL CHECK (octet_length(channel_msgid) <= 32),  -- 我们生成、随 send_msg 下发；同一分段重试沿用
  message_seq     int,                        -- 对应的会话消息；欢迎语、同意菜单为 NULL
  kind            text NOT NULL CHECK (kind IN ('ai','human','followup','notice','welcome','menu','card')),
  sent_at         timestamptz NOT NULL,
  status          text NOT NULL CHECK (status IN ('accepted','rejected','unknown','failed')),
  -- rejected：接口明确报错；unknown：超时或网络异常、结果不明（计入额度）；failed：收到 msg_send_fail
  errcode         int,
  fail_type       int,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel_msgid)
);
CREATE INDEX outbound_sends_by_conv ON outbound_sends (tenant_id, conversation_id, sent_at);
```

```ts
// src/shared/conversation-types.ts
export type OutboundKind = 'ai' | 'human' | 'followup' | 'notice' | 'welcome' | 'menu' | 'card';
export interface SendWindow {
  lastCustomerAt: number | null; // 客户最后一条消息的 sentAt（企微 send_time），没有就用 at
  closesAt: number | null; // lastCustomerAt + 48 小时
  used: number; // lastCustomerAt 之后 accepted 与 unknown 的分段数（send_msg_on_event 不计）
  remaining: number; // max(0, 5 - used)；窗口已过为 0
}

// src/types.ts：ChannelAdapter.push 多一个可选参数；锁定自测里两参数的调用照常编译
export interface ChannelAdapter {
  name: string;
  push(sessionId: string, text: string, opts?: { kind: OutboundKind; message?: ChatMessage }): Promise<boolean>;
}

// src/quota/ledger.ts
export function sendWindow(sessionId: string, now: number): SendWindow;
/** sendText 每个分段调一次：生成 msgid（重试沿用），settle 记 accepted / rejected / unknown。message 经 seqOf 换成 seq */
export function recordSend(
  sessionId: string,
  kind: OutboundKind,
  message: ChatMessage | null,
): { msgid: string; settle(result: 'accepted' | 'rejected' | 'unknown', errcode?: number): void };
export function onSendFail(channelMsgid: string, failType: number): void;
```

- `push` 不带 `opts` 时 `kind` 按 `'notice'` 记（付款确认等服务端推送）。`kind='human'` 时适配器在正文前加「【顾问】」，网页模拟器同样加。
- 账本在内存里（预载时读出每个会话最后一条客户消息之后的发送）。db 存储下：真实会话的账本行随会话的下一次落库写（存档点之内，「identity map 与写入」第 6 步）；还没有会话的欢迎语补发单独一个短事务；demo 类只在内存。文件存储下只在内存。
- 一条回复因分段或加卡片调用几次 send_msg 就记几行；同一分段的重试是同一行。
- 客户消息的 `sentAt` 取企微的 `send_time`：窗口从客户真正发出的时刻起算，比处理时刻早，算出的窗口只会偏窄。
- `sync_msg` 里 `origin=4` 的 `msg_send_fail` 事件不再丢弃：按 `fail_msgid` 找到账本行记 `failed` 与 `fail_type`，给会话追加 system 消息（4：「客户超过 48 小时没说话，这条发不出去了」；6：「这一轮已经发满 5 条，等客户回复后才能再发」；其余：「这条没送达（原因码 N）」），发 `send.failed` 事件。其他系统事件照旧只记日志。
- **去重与重放对齐**：客户文本消息带上 `msgid` 与 `sentAt` 入库。处理一条客户消息之前，除了现有的 `handled` 集合，按 msgid 分情况（新拉到的消息与启动时的在途重放用同一套规则）：
  1. 会话里没有这条 msgid，预载的 7 天 msgid 集合里也没有：照常处理。
  2. 只在 7 天集合里（已被重置或裁剪出窗口）：跳过。
  3. 窗口里有这条，后面没有 AI 回复，会话也没转人工：以 `{ alreadyRecorded: true }` 重跑，引擎不再 push 这句。
  4. 窗口里有这条，后面有 AI 回复，而账本里那条回复没有 accepted 或 unknown 的行：原样重发那条回复，不再跑一轮模型。
  5. 其余（回复已送出，或会话已转人工）：跳过。
  - 没有 msgid 的旧消息照旧按文本对齐（锁定的 `wecom.selftest.ts` W1 预置的消息不带 msgid）。
  - `messages.msgid` 不建唯一索引：重复的 msgid 万一漏进来，宁可历史里多一条，也不能让这个会话的落库卡死（「失败」）。

### 收款流程（价格确认闸）

```ts
// src/payment/mode.ts
/** mock_pay 开 → online（今天的模拟支付）；关 → advisor（顾问确认收款）。PaymentMode 定义在 conversation-types.ts */
export function paymentMode(): PaymentMode;

// src/payment/orders.ts —— 先查写库健康，改内存，await flushSession（≤5 秒），提交后再对客户发消息；随落库写一行审计
export function confirmOrder(orderId: string, actor: Actor): Order; // 只对未作废的 pending_payment；重复确认幂等
export function markPaidByAdvisor(orderId: string, actor: Actor): Promise<Order>; // advisor 模式要求已确认；调 markOrderPaid，提交后 notifyPaid
export function cancelOrder(orderId: string, actor: Actor, reason: string): Order; // pending_payment → cancelled
export class OrderStateError extends Error { constructor(readonly status: OrderStatus | 'voided' | 'unconfirmed') } // → 409 order_state
```

- 三个函数的操作者：owner、admin、supervisor 任何订单；agent 只限订单所属会话的接手人本人，否则抛 `NotHandlingError`（409 `not_assignee`）；会话已被清除（`session_id` 为空）的订单只许 supervisor 以上。
- **SOP**：`data/sop.md` 的锁定节里两处改成两种方式都成立的写法（措辞在实施时定，约束如下）：「能力边界」里「付款只走我们发给您的官方支付链接（就是 create_order 返回的那条）」改成「付款只认 create_order 返回的订单链接，或顾问在微信里发给您的收款方式」；「各阶段目标」的 closing 加一句「工具结果里有 payNote 时，按 payNote 跟客户说怎么付款」。同一次改动在锁定节里另加一句（R15 精确优先的模型兜底，owner 2026-10-03）：客户说自己或同行的人此刻遇到危险，或明显冲着我们发火时，先安抚再调 `handoff_to_human`。`SOP_KNOWN_FIELDS` 加 `payNote`，旅游包 `console-pack.ts` 的 `sopFields` 同步加（`packs.selftest.ts` 断言两者的键相同）。契约清单里的短语一条不删。这是本阶段唯一一次有意改变 system prompt，改前改后的四个哈希记进 plan；DB 模式下由 01 的启动重渲染生成 `rerender` 版本；要跑一遍真实模型回归（AGENTS.md）。
- **advisor 模式下变的东西**（online 模式逐字节不变）：
  - `create_order` 结果多一个 `payNote`：「这是订单确认链接：顾问会在微信里跟客户核对价格并发收款方式，不要说点链接付款。」
  - `/pay/:orderId` 页面：标题仍是「<线路> · 订单支付」（锁定断言）；没有付款按钮，按订单状态写「订单已提交 · 顾问会在微信里跟您核对价格，并发来收款方式」「价格已确认 · 请按顾问在微信里发的方式付款」「已收款」「已被替代」「已取消」。收款方式由 `/pay/:orderId` 的服务端注入告诉页面；`/pay.html?orderId=` 这条静态入口一律跳到 `/pay/:orderId`，R22 的白名单不为它加字段。
  - 价格规则护栏把「资金托管」一类说法换成的那句（`price-rules.ts`，今天是「付款只走我们发给您的官方支付链接。」）改成「付款以订单链接和顾问发给您的收款方式为准。」；锁定的 `price-guard.selftest.ts` 测的是 demo（online）下的输出，不变。
  - 出口修补（`repairLinks`、`placeLinks`）补发订单链接时的说明句、重发支付链接、成单安全网、企微支付卡片、跟进模板的 closing 段：同一意思的确定性文本，不说「点链接付款」。
  - 建单后排一次 `handoff_notify`（类型「待确认的订单」），A2 的「待付款」列出它。
- 顾问确认价格只是确认 AI 按规则算出的金额，不改金额；金额不对就取消，让 AI 重新报价，或在系统外处理（开放问题 9）。
- `POST /api/orders/:id/pay` 与带 `ADMIN_PASS` 的标记已付保持原样（锁定断言），只是两个分支（200 与 409）响应体里的订单换成 R22 的白名单投影（锁定断言不读响应体）；advisor 模式下这条旧路径不要求先确认，审计记共享工作台，付款确认同样在提交之后发。

### 通知

```ts
// src/store/events.ts
export type DomainEvent =
  | { type: 'conversation.changed'; id: string }
  | { type: 'message.appended'; id: string; seq: number; author: MessageAuthor }
  | { type: 'handoff.started'; id: string; kind: HandoffKind; at: number; escalated: boolean; paidCustomer: boolean }
  | { type: 'conversation.assigned'; id: string; assigneeName: string }
  | { type: 'conversation.released'; id: string }
  | { type: 'order.changed'; id: string; orderId: string; status: OrderStatus; confirmed: boolean }
  | { type: 'send.failed'; id: string; failType: number | null };

// src/notify/notifier.ts
export interface HandoffNotice {
  shortId: string; // shortIdOf(id)
  kind: HandoffKind | 'order_unconfirmed' | 'window_closing' | 'still_waiting';
  paidCustomer: boolean; // 已成交客户要人工（R9）
  at: number;
  /** 工作台链接：PUBLIC_BASE_URL + /console/conversations?state=human，不带会话 id */
  link: string;
  /** 这次转人工的记录还没写进库（见下）；提交之后不再补发 */
  unsaved: boolean;
}
export interface Notifier {
  send(n: HandoffNotice): Promise<void>;
}
```

- `/api/console/events`（SSE，成员）：
  - 事件：`counts`（提交后去抖 300ms 推一次完整的 `ConversationCounts`）、`handoff`、`conversation`、`message`、`order`、`send_failed`、`resync`、`auth`。只带 id、状态、类型、seq 与时间，不带消息正文、客户原话和画像。
  - `id:` 是「启动标识-序号」。重连带的 `Last-Event-ID` 不是本次启动的、或比环形缓冲（最近 500 条）还旧，就先发 `resync`，前端整体重取。每 20 秒一行注释心跳。
  - 每 60 秒用 01 的 `auth_session_touch` 复核一次登录（开着的事件流算活动，7 天的绝对期限照旧）：失效（过期、被移出、停用）就发 `event: auth` 并关闭连接，前端回登录页。
- `/api/admin/stream` 的形状不变（`admin.html` 和锁定断言依赖它），只把「落盘后发」改成「提交后发」。
- 前端：
  - 铃铛徽标与标签页标题前缀「(N) 」，N 是等人接手数（只数 `human`）；N 为 0 时没有前缀。
  - 收到 `handoff` 事件时，用户授权过就弹浏览器通知：标题「企微客户 · 7F3A 等人接手」，紧急情况写「紧急 · 企微客户 · 7F3A」，已成交客户写「已成交客户要人工 · 企微客户 · 7F3A」；正文是转人工类型的中文（「客户要投诉」），不含客户原话；`tag` 为 `handoff:<id>`，点击聚焦窗口并打开 J 页。
  - 授权只在用户点铃铛弹层底部「开启桌面提醒」时申请；被拒绝时那一行改成说明，不再申请。
  - SSE 连不上或断开超过 30 秒，退回后台 UX spec 的 30 秒轮询，重连成功后停掉轮询。
- 外部通道（企微群机器人，开放问题 3）：消息体只有类型、短码、时间与链接。发送失败按任务重试，不影响 SSE。
- **库写不进去时的转人工**：SSE 与 `handoff_notify` 任务照旧只在提交之后发生。带 `handoff.started` 的那次落库失败时，外部通道先发一条 `unsaved: true` 的通知：`emergency` 立即，其余在失败持续 30 秒后；之后提交成功不再重发。库故障期间 console 本身也登不进（鉴权要查库），这条是顾问唯一能收到的提醒。

### 后台接口

全部链式加在 01 的 `consoleApi` 上（Hono RPC 照样推得出类型）：

```ts
// src/shared/console-api.ts（新增与扩展；用到的会话类型都 import 自 src/shared/conversation-types.ts）
export const CONVERSATION_STATES = ['ai', 'human', 'assigned', 'paid'] as const;

export interface ConversationRow {
  id: string;
  channel: string;
  stage: string;
  handedOver: boolean;
  messageCount: number;
  updatedAt: string;
  /** 02 新增 */
  needSummary: string | null;
  assignee: { userId: string | null; name: string } | null;
  handoff: { kind: HandoffKind; at: string; reason: string } | null;
  lastCustomerAt: string | null;
}

export interface MessageView {
  /** db 存储下是库里的 seq；文件存储下是本进程分配的 seq，跨重启不保证（「identity map 与写入」） */
  seq: number;
  role: 'customer' | 'agent' | 'system';
  author: MessageAuthor;
  authorName: string | null;
  /** 只读成员（viewer）看到的是打码后的正文：手机号、证件号、银行卡号只留后 4 位 */
  text: string;
  /** handoff_note：以「AI 已转人工」开头的 system 消息，界面按时间线行渲染，不显示原文（「后台页面」） */
  kind: 'message' | 'handoff_note';
  at: string;
  turnId: string | null;
  /** 护栏改过这条 AI 回复：删了几句、补了几处；展开时读 /conversations/:id/turns/:turnId/diff */
  guarded: { removed: number; added: number } | null;
  /** 发送账本里这条消息的状态（企微）：failed 时带原因码；账本里没有这条时为 null */
  delivery: { status: 'accepted' | 'rejected' | 'unknown' | 'failed'; failType: number | null } | null;
}

export interface ConversationDetail {
  row: ConversationRow;
  messages: MessageView[]; // 内存窗口，按 seq 升序
  hasEarlier: boolean;
  handoffCard: {
    kind: HandoffKind;
    at: string;
    reason: string;
    quote: string | null; // viewer 同样打码
    departNote: string | null;
    stageBefore: string | null;
    assigneeName: string | null;
  } | null;
  /** 需求要素：规范化的取值，与 needSummary 同源 */
  need: { destination: string | null; segment: string | null; travelers: string | null; dates: string | null; budget: string | null };
  quote: {
    routeId: string;
    routeTitle: string;
    travelers: number;
    perPerson: number | null;
    total: number | null;
    departDate: string | null;
  } | null;
  orders: OrderView[];
  sendWindow: SendWindow | null; // 企微渠道才有
  paymentMode: PaymentMode;
  can: {
    takeover: boolean;
    reply: boolean;
    release: boolean;
    reassign: boolean;
    confirmOrder: boolean;
    markPaid: boolean;
    traces: boolean;
  };
}

export interface OrderView {
  id: string;
  routeTitle: string;
  travelers: number;
  departDate: string;
  totalPrice: number;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  confirmed: { at: string; by: string } | null;
  handoffBeforePaid: boolean | null;
}

export const ReplyBody = z.strictObject({ text: str.min(1).max(2000), clientId: z.string().uuid() });
export const TakeoverBody = z.strictObject({ force: z.boolean().optional() });
export const CancelOrderBody = z.strictObject({ reason: str.min(1).max(200) });
export const MessagesQuery = z.object({ beforeSeq: intParam(INT4_MAX), limit: intParam(100).optional() });
export const OrdersQuery = z.object({
  status: z.enum(['pending_payment', 'paid', 'cancelled', 'superseded']).optional(),
  limit: intParam(100).optional(),
});
export const QuickReplyBody = z.strictObject({ title: str.min(1).max(20), body: str.min(1).max(500) });
export const MoveBody = z.strictObject({ direction: z.enum(['up', 'down']) });
export const MetricsQuery = z.object({ days: intParam(90).optional() });

export interface OrderSummary {
  month: string;
  paidTotal: number;
  paidCount: number;
  pendingTotal: number;
  pendingCount: number;
}
export interface QuickReply {
  id: string;
  ord: number;
  title: string;
  body: string;
}
// MetricsView 见「可观测性与告警」
```

```ts
// src/console-api/app.ts（新增的链式注册）
.get('/conversations/:id', canSeeCustomers, detailHandler)
.get('/conversations/:id/messages', canSeeCustomers, zValidator('query', MessagesQuery), earlierMessagesHandler) // 只在 db 存储
.get('/conversations/:id/turns', canSeeCustomers, turnStepsHandler)        // 每轮的工具步骤摘要（中文名），不含参数与耗时
.get('/conversations/:id/turns/:turnId/diff', canSeeCustomers, turnDiffHandler) // 护栏删去 / 补上的句子
.get('/conversations/:id/turns/:turnId', canSeeTraces, turnDetailHandler)  // 原稿、参数、耗时、模型、前缀
.post('/conversations/:id/takeover', canHandle, zValidator('json', TakeoverBody), takeoverHandler)
.post('/conversations/:id/release', canHandle, releaseHandler)
.post('/conversations/:id/reply', canHandle, zValidator('json', ReplyBody), replyHandler)
.get('/orders', canSeeCustomers, zValidator('query', OrdersQuery), listOrdersHandler)
.get('/orders/summary', canSeeMoney, orderSummaryHandler)
.post('/orders/:id/confirm', canHandle, confirmOrderHandler)
.post('/orders/:id/mark-paid', canHandle, markPaidHandler)
.post('/orders/:id/cancel', canHandle, zValidator('json', CancelOrderBody), cancelOrderHandler)
.get('/quick-replies', canSeeCustomers, listQuickRepliesHandler)
.post('/quick-replies', canManageReplies, zValidator('json', QuickReplyBody), createQuickReplyHandler)
.patch('/quick-replies/:id', canManageReplies, zValidator('json', QuickReplyBody.partial()), updateQuickReplyHandler)
.post('/quick-replies/:id/archive', canManageReplies, archiveQuickReplyHandler)
.post('/quick-replies/:id/move', canManageReplies, zValidator('json', MoveBody), moveQuickReplyHandler) // { direction: 'up' | 'down' }
.get('/metrics', canSeeMoney, zValidator('query', MetricsQuery), metricsHandler) // 只在 db 存储
.get('/events', canSeeCustomers, eventsHandler)
```

- 写接口在内存改动之后 `await flushSession(id, { timeoutMs: 5000 })`，提交成功才返回 200；超时返回 503 `store_lagging`（改动已在内存生效，稍后落库，界面照实说明）；`ConfigLockLostError` 照 01 返回 503。人工回复与订单动作的顺序另见各自一节（先查写库健康，提交之后才对客户发消息）。
- 权限中间件：`canHandle` 是 owner、admin、supervisor、agent；`canSeeTraces` 与 `canSeeMoney` 是 owner、admin；`canManageReplies` 是 owner、admin、supervisor。接手人本人的检查在 `takeover.ts` 与 `payment/orders.ts` 里，不在中间件里。
- 新错误码：403 `forbidden`（角色不够，如坐席带 `force` 接手）、409 `assigned_to_other`（带 `assigneeName`）、409 `not_assignee`、409 `consent_declined`、409 `send_window_closed` / `send_quota_exhausted`（带 `closesAt`、`remaining`）、409 `order_state`、404 `conversation_not_found`（含 `sim-` 访客会话：console 不列也不开它们）、503 `store_file_mode`（只在 db 存储有的接口：更早的消息、trace、运行数字；快捷回复只要求 01 的 DB 配置模式，两种会话存储下都可用）、503 `store_lagging`。
- `/orders` 与 `/orders/summary` 从 identity map 算（含 demo 类订单，作废的已不在内存里），不查 `orders` 表：种子订单不进库，A2 的「本月成交额」在 demo 上要算得出 207,440。所有者、管理员以外的角色，`/orders` 只接受 `status=pending_payment`（A2「待付款」只要这一类），其余 403。
- 种子会话（`wecom:cust_`）在 console 里照常可看、可接手（01 起会话列表就列它们），只是没有 trace，也没有窗口以外的旧消息：这两类接口对它们返回空。
- 匿名可读的旧接口（`/api/sessions`、`/api/sessions/:id`、`/api/orders` 的匿名分支，种子与访客本人）返回去掉成员身份的投影：去掉 `assignee.userId`、消息的 `authorId`、订单的 `confirmedBy`、`paidMarkedBy`、`cancelReason`，接手人与消息作者的姓名一律写「顾问」，交还时按固定模板生成的那条 system 消息「{姓名}把会话交还 AI」改写成「顾问把会话交还 AI」（01 不变量 31、本 spec 不变量 44）。带 `ADMIN_PASS` 的请求照旧返回原对象；旧接口不认 console 的登录，成员在旧接口上拿到的也是投影。
- `GET /conversations` 与 `/conversations/counts` 的语义照后台 UX spec，多了 `assigned`。`order=waiting_first` 把 `human` 排最前，其余照旧。
- 审计新动作：`conversation.takeover`、`conversation.reassign`、`conversation.release`、`order.confirm`、`order.mark_paid`、`order.cancel`、`quick_reply.create` / `update` / `archive` / `move`、`catalog.version`（随产品库写入）、`privacy.publish`、`platform.tenant_retention`、`platform.erase`（只记条数与原因）、`system.purge`（`actor_kind='system'`，diff 只有条数）。会话类动作的 `target_id` 是会话行的 `ref`（随机 uuid，不含客户标识），diff 里带短码；订单类是订单号。人工回复不记审计：消息本身带操作者。共享工作台的操作记 `actor_kind='user'`、`actor_user_id` 为空、`actor_name='共享工作台'`。`AUDIT_ACTIONS` 加这些动作的中文与分组，K 页的分段控件多一段「会话与订单」。

权限（在 01 与后台 UX spec 的矩阵上只增加行）：

| 操作                                                         | owner / admin | supervisor | agent                               | viewer        | 匿名（demo / prod） |
| ------------------------------------------------------------ | ------------- | ---------- | ----------------------------------- | ------------- | ------------------- |
| 会话列表、计数、详情、更早的消息、步骤摘要与改写对照、事件流 | ✓             | ✓          | ✓                                   | ✓（正文打码） | 401                 |
| trace 原文（原稿、参数、耗时、模型）                         | ✓             | 403        | 403                                 | 403           | 401                 |
| 接手没人接手的会话、人工回复、交还自己接手的或没人接手的     | ✓             | ✓          | ✓                                   | 403           | 401                 |
| 改派（带 `force` 接手别人接手中的）                          | ✓             | ✓          | 403                                 | 403           | 401                 |
| 交还别人接手的                                               | ✓             | ✓          | 409 `not_assignee`                  | 403           | 401                 |
| 确认价格、确认收款、取消订单                                 | ✓             | ✓          | 接手人本人，否则 409 `not_assignee` | 403           | 401                 |
| 订单列表                                                     | ✓ 全部状态    | 只待付款   | 只待付款                            | 只待付款      | 401                 |
| 本月成交额（`/orders/summary`）、运行数字（`/metrics`）      | ✓             | 403        | 403                                 | 403           | 401                 |
| 快捷回复：读 / 管理                                          | ✓ / ✓         | ✓ / ✓      | ✓ / 403                             | ✓ / 403       | 401                 |

### 后台页面

视觉与组件照后台 UX spec 的设计系统，不加新令牌；界面类覆盖加载、空、出错三态。

- **会话工作台（J 页，`/conversations/$id`，`$id` 经 `encodeURIComponent`）**，照设计系统 J 页：
  - 三栏：列表 320、对话、「客户与交接」360；进入时侧栏收起。
  - 列表按状态分组：等人接手（软徽标）、顾问处理中、AI接待中、已成交；没有会话的组不画。数据是 `GET /conversations?order=waiting_first&limit=100` 加 counts，事件到来时重取。行的第一行只放标题「企微客户 · 7F3A · 贵州带爸妈4人」（短码加 `needSummary`），占满整行；第二行依次是状态、上下文（等人接手写「原因：…」，顾问处理中写「接手人：小林」，已成交客户要人工写「要人工：…」，其余写「停在：报价」）、右对齐的等待时长（从 `handoff.at` 算，≥10 分钟 danger 字，否则 warning 字，前置钟表图标）或最后动静。
  - 对话头：标题、状态、等待时长；唯一的主按钮「接手会话」；「更多」里是「交还AI」「复制会话链接」，supervisor 以上另有「改由我处理」（二次确认）。别人接手中时「接手会话」不可用，旁边写「小林处理中」。客户不同意处理敏感信息的会话，「交还AI」不可用，写明「客户没有同意，不能交给AI」。
  - 消息：客户、AI、顾问、跟进、系统五种呈现；顾问的气泡标「顾问 · 小林」，跟进标「自动跟进」。`kind='handoff_note'` 的 system 消息不显示原文，渲染成一行时间线「AI交给人工 · 14:18 · 原因：…」（原因取原文冒号之后的部分）；其余 system 消息原样显示。护栏改过的 AI 回复在气泡下留一行「AI原稿里删了1句 · 展开」，展开是「删去 / 发出」对照，标注用文字。顶部「看更早的消息」按 seq 往前翻页。发送失败或结果不明的消息下写原因。
  - 「显示AI步骤」开关默认关；打开后在客户消息与 AI 回复之间插一行步骤摘要（「查了线路 · 报了价」，名字取行业包的工具词表），不含参数和耗时。
  - 交接卡固定在输入框上方：第一行「AI交给人工 · 14:18」（`agent` 有接手人写「小林接手 · 14:18」、没有接手人写「共享工作台转人工 · 14:18」，`emergency` 写「紧急情况 · AI交给人工 · 14:18」并用 danger），之后是原因（逐字）、客户原话、识别出的出行时间、停在哪个阶段。
  - 输入框：接手之前禁用，占位「接管后在此回复，客户在企业微信中看到」；接手后可用，下方一行写发送窗口「还能发3条 · 窗口到明天14:18」，剩 0 条或窗口已过时禁用并写明原因。发送时带 `clientId`，失败就地显示并可重试；返回 `persisted: false` 时在消息下写「已发出，记录稍后保存」。
  - 右栏「客户与交接」：需求、最近报价、订单与付款（advisor 模式下有「确认价格」「确认收款」，都用确认框写明后果；「取消订单」在「更多」里，用 `ConfirmDanger`）、转人工（原因、时间、由谁处理）、快捷回复（点一条插进输入框，不直接发送）。所有者、管理员另有页签「AI为什么这么回」：选中一条 AI 回复时显示模型、耗时、工具与参数、护栏事件、SOP 版本与前缀哈希（收在技术详情里）。
  - 「更多」菜单要能只用键盘打开、选中、关闭：后台 UX plan「Open」第 1 条记的 `popupRegion` 焦点问题在本页之前修好（plan 第 20 步）。
  - 状态：列表加载是 8 行骨架；详情加载是气泡骨架；会话不存在（过了保留期、被删除或不是本租户的）写「这个会话已经不在了」加返回列表；接口出错就地重试；SSE 断开不提示（退回轮询）；`store_lagging` 写「已生效，记录稍后保存」。
- **会话列表（I 页）**：页签在「等人接手」与「AI接待中」之间多出「顾问处理中」（只在有这种会话或地址里选了它时出现）；行的标题加 `needSummary`，等人接手的行阶段列写原因、最后动静列写等待时长；点一行与「打开工作台」改为在当前标签打开 J 页；状态句改为「企业微信里的客户会话 · 在工作台里接手和回复」，页头主按钮「打开工作台」打开 J 页（选中第一个等人接手的会话，没有就不选）。
- **外壳**：铃铛弹层每行加原因与等待时长，「打开工作台」改为打开 J 页；等人接手之后另起一组「已成交客户要人工」（只在有时出现，不计入徽标）；底部多「开启桌面提醒」；计数由 SSE 驱动，见「通知」。
- **总览 A2**：「需要你处理」照设计系统 A2：等人接手的行写原因与等待时长，操作换成次要小按钮「接手」（接手成功后打开 J 页）；「已成交客户要人工」的行同样写原因与等待时长、带「接手」，与等人接手的行一起按下面的规则排序，紧急情况一律排最前（多在出行途中）；加「待付款」行（`pending_payment` 且未作废的订单：「85,600元 · 下单2小时未付」，advisor 模式下未确认的写「等你确认价格」）；之后是话术草稿与待上架，照旧。排序：没人接手的在前，金额高的在前（待付款订单或最近报价的总价），沉默久的在前。「本月成交额（元）」KPI 格放在「需要你处理」右侧（宽 273），窄于 1280 时落到列表下方，只给所有者、管理员：口径「本月已付款订单的总额」，明细「另有待付85,600元」，按服务器时区的自然月，不含作废订单。运行数字的四个格见「可观测性与告警」。
- **快捷回复管理**：J 页右栏快捷回复卡片的「管理」打开 480 宽抽屉：列表、新建、编辑、上移下移、归档。正文不许 markdown（保存时校验）。新租户首次读到空表时，按行业包配置里的默认模板写入（行业包没有就为空）。
- **`admin.html`**：列表返回 401 时自动弹登录框（在 `load()` 之外判断，不改 `load()` 与 `sigOf()`）；db 配置模式下顶部加一条提示「成员请到后台的会话工作台处理」并链到 J 页；其余不变。

### 隐私说明、敏感信息同意、保留期与行权

```sql
CREATE TABLE privacy_notices (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  version           int  NOT NULL CHECK (version > 0),
  body              text NOT NULL,           -- 纯文本，租户提供；处理者名称、联系方式、目的、保存期限、行权方式、备份的保存期
  published_at      timestamptz NOT NULL DEFAULT now(),
  published_by_name text,
  PRIMARY KEY (tenant_id, version)
);
CREATE TABLE consents (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  category        text NOT NULL CHECK (category IN ('health','minor')),
  decision        text NOT NULL CHECK (decision IN ('asked','granted','declined','withdrawn')),
  notice_version  int  NOT NULL,
  evidence        text,                      -- 企微菜单的 menu_id 或客户原话，≤200 字
  at              timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE tenants
  ADD COLUMN retention_lead_days     int NOT NULL DEFAULT 180 CHECK (retention_lead_days BETWEEN 7 AND 3650),
  ADD COLUMN retention_customer_days int NOT NULL DEFAULT 730 CHECK (retention_customer_days BETWEEN 7 AND 3650),
  ADD COLUMN retention_trace_days    int NOT NULL DEFAULT 90  CHECK (retention_trace_days BETWEEN 7 AND 3650);
-- 默认值即开放问题 2 的裁决（owner 2026-10-02）；租户要别的值由 tenant-retention 设置；以后要改默认值就另写一个迁移
```

- **隐私说明**：`privacy-publish --tenant <slug> --file <path>`（platform 身份）发布新版本，记 `privacy.publish` 审计。DB 配置模式下，当前版本在 `initConfig` 之后读进内存，之后每 60 秒在后台查一次最大版本号（不在对话的轮次里）；`GET /privacy`、欢迎语、同意记录的 `notice_version` 都从内存取。`GET /privacy` 公开，返回当前版本的纯文本页面（转义、`no-store`），没有发布过就 404。文件配置模式（demo）下没有隐私说明。
- **欢迎语**：发布过隐私说明时，首次欢迎语与老客户补发的欢迎语末尾加一行「隐私说明：<PUBLIC_BASE_URL>/privacy」；没发布时欢迎语与今天逐字节相同（demo 不发布，锁定断言不变）。
- **敏感信息同意**（只在发布过隐私说明时启用；细节见开放问题 7）：客户消息里第一次出现某个类别（`sensitiveCategoriesOf`）而会话还没问过时，本轮回复之后追加一条企微菜单消息：「您提到了{家人的健康情况 / 孩子的信息}，这属于敏感个人信息。我们只用它来推荐合适的线路、安排行程强度和住宿，不做别的用途，按隐私说明保存，您可以随时撤回。不提供也能继续咨询，只是推荐可能没那么贴合。可以吗？隐私说明：<PUBLIC_BASE_URL>/privacy」。菜单两项「同意」「不同意」。客户点了就按 `menu_id` 记一条同意记录。没点：按开放问题 7 的裁决，下一次出现同类别信息时再问一次（至多两次），仍没点就记第二条 `asked`、照常接待，contextNote 提示模型不要在回复里主动提这一类信息。点「不同意」：回一句确认，`enterHandoff(kind='consent')`，由顾问处理；这个会话不能再交还 AI（`release` 返回 409 `consent_declined`），之后客户点了「同意」才解除。同意记录只追加。
- **撤回同意与删除请求**（R23）：客户的话命中 `consentWithdrawalOf`：对已问过的类别各记一条 `withdrawn`，回固定的一句「好的，已经记下您的要求，顾问会尽快联系您处理。」，`enterHandoff(kind='consent', reason='客户要求撤回同意或删除信息')`，本轮不调模型。删除由租户经平台执行：
  - `erase-conversation --tenant <slug> --id <会话 id> --reason <文字>`（platform 身份，要取租户锁，所以要求应用已停：在跑的话 identity map 会把会话写回去；`var/` 里有 spill 文件时拒绝）。
  - 调 `erase_conversation(p_tenant, p_id, p_reason)`：删除范围与清除函数相同（会话行连同消息、trace、护栏事件、同意记录，按 id 删发送账本与 payload 里 `sessionId` 是它的任务，订单的 `session_id` 置空、`data` 去掉 `sessionId`），不看保留期；写一行 `platform.erase` 审计，只有各类的条数与原因。
  - 文件存储下没有这条路径（demo 不接真实客户）。备份里的副本随备份的保留期滚掉，隐私说明正文写明。
- **保留期清理**：
  - 线索（订单里没有 `paid_at` 的）的会话在最后动静之后 `retention_lead_days` 天、客户（有任何一张订单写过 `paid_at`，作废、取消的也算）的在 `retention_customer_days` 天到期；到期会话连同消息、trace、护栏事件、发送账本、同意记录与 payload 里 `sessionId` 是它的任务删除；它的订单保留，`session_id` 置空、`data` 去掉 `sessionId`，不再进 identity map。「最后动静」是 `conversations.updated_at`，等于 `session.updatedAt`（跟进不刷新它，与今天相同）。
  - trace 与护栏事件另按 `retention_trace_days` 到期（早于会话到期）；没有会话的发送账本行（老客户进入会话但没说话）同样按它到期。
  - 每天一次 `retention_purge` 任务：列出候选会话（库里 `updated_at` 早于截止时间），逐个在它的写队列上处理：内存里这个会话有未落库的改动、内存里的 `updatedAt` 还在保留期内、有一轮正在处理或有任务在跑，就跳过；否则调 `purge_conversation(p_tenant, p_id, p_now, p_expected_last_seq, p_expected_updated_at)`（函数内再按租户设置与这两个预期值判一次，不符就返回 false），返回 true 就在同一个 tick 里移出内存，并把这个会话对象记进墓碑（`WeakSet`）：之后拿着旧对象的 `saveSession` 记一行日志、不执行；客户再来时 `getSession` 建的是新对象。最后调 `purge_expired_traces` 与 `purge_finished_jobs`。写一行 `system.purge` 审计，diff 只有各类的条数。
  - 日志：prod 下日志不写客户原话（R24）。现有护栏、转人工、跟进等日志里引用原话的地方改经 `logQuote(text)`：demo 照旧输出原文，prod 只写「«N字»」；新代码的日志只写会话短码或 `ref`。排查问题要看原话时查 trace（有保留期、有权限）。compose 另给 app 服务配 `json-file` 轮转（`max-size: 20m`、`max-file: 5`）。
  - 副本：导入、导出留下的 JSON 原件写到 `--keep` 指定的目录（必须在 `var/` 之外，不进每晚的备份），切换后第一份备份验证通过就删掉（切换步骤里有这一步）；spill 文件回放成功就删。
- PIA 与委托处理约定在仓库之外完成（另记），plan 的「上线清单」只记「已完成 / 未完成」。

### 数据库

DDL 由 drizzle-kit 生成表、索引和约束；RLS、策略、触发器、函数、授权，以及 drizzle 表达不了的约束（`orders` 那条带列清单的 `SET NULL`）写在 custom 迁移里（01「迁移纪律」）。所有新表都带 `tenant_id`，都套 01 的 RLS 模板（ENABLE、FORCE、`tenant_isolation`），豁免清单仍只有 `auth_sessions`。

```sql
CREATE TABLE conversations (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                text NOT NULL CHECK (id !~ '^(sim-|wecom:cust_)' AND length(id) BETWEEN 1 AND 200),
  ref               uuid NOT NULL DEFAULT gen_random_uuid(),  -- 不含客户标识的引用：审计 target、日志、OpenTelemetry 用它
  channel           text NOT NULL,
  stage             text NOT NULL,
  handed_over       boolean NOT NULL,
  handoff_kind      text,                     -- 投影：state.handoff.kind
  handoff_at        timestamptz,
  first_handoff_at  timestamptz,
  assignee_user_id  uuid REFERENCES users(id),
  assignee_name     text,
  last_customer_at  timestamptz,
  last_seq          int NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  window_start_seq  int NOT NULL DEFAULT 1 CHECK (window_start_seq BETWEEN 1 AND last_seq + 1),
  state             json NOT NULL,            -- 会话对象去掉 messages 后的 JSON，键序原样；重建只读它
  flush_id          uuid,                     -- 最近一次提交的落库 id：COMMIT 时断线，重试据此认出已提交
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,     -- = session.updatedAt；触发器保证只进不退、不晚于 now() + 5 分钟
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK (json_typeof(state) = 'object' AND coalesce(state->>'id' = id, false))
);
CREATE INDEX conversations_by_updated ON conversations (tenant_id, updated_at);

CREATE TABLE messages (
  tenant_id       uuid NOT NULL,
  conversation_id text NOT NULL,
  seq             int  NOT NULL CHECK (seq > 0),
  role            text NOT NULL CHECK (role IN ('customer','agent','system')),
  author          text CHECK (author IN ('ai','human','followup')),
  author_user_id  uuid,
  author_name     text,
  content         text NOT NULL,
  at              timestamptz NOT NULL,       -- ChatMessage.at（毫秒）原样往返
  sent_at         timestamptz,                -- ChatMessage.sentAt（企微 send_time）
  msgid           text,                       -- 不建唯一索引（「企微 · 去重」）
  turn_id         uuid,                       -- 软引用 turn_traces：trace 比消息先到期
  extra           json,                       -- ChatMessage 上已知字段以外的键，原样往返；没有就是 NULL
  PRIMARY KEY (tenant_id, conversation_id, seq),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  CHECK (role = 'agent' OR author IS NULL),
  CHECK (author = 'human' OR (author_user_id IS NULL AND author_name IS NULL))
);

CREATE TABLE orders (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),   -- 新单是 ord_ 加 24 位十六进制；旧数据原样
  session_id         text,                    -- 会话被清除或删除后置空
  route_id           text NOT NULL,           -- 不对产品库建外键
  status             text NOT NULL CHECK (status IN ('pending_payment','paid','cancelled','superseded')),
  total_price        int  NOT NULL CHECK (total_price >= 0),
  created_at         timestamptz NOT NULL,
  paid_at            timestamptz,             -- 触发器：写入之后不能改、不能清空
  confirmed_at       timestamptz,
  voided_at          timestamptz,
  void_reason        text CHECK (void_reason IN ('reset','resync')),
  data               json NOT NULL,           -- 整个 Order 对象，键序原样；重建只读它
  PRIMARY KEY (tenant_id, id),
  CHECK (json_typeof(data) = 'object' AND coalesce(data->>'id' = id, false))
);
CREATE INDEX orders_by_status ON orders (tenant_id, status, created_at);
-- custom 迁移（drizzle 的外键动作不带列清单，普通 SET NULL 会把 tenant_id 也置空、违反 NOT NULL）：
-- ALTER TABLE orders ADD FOREIGN KEY (tenant_id, session_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (session_id);

CREATE TABLE turn_traces (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  conversation_id    text NOT NULL,
  started_at         timestamptz NOT NULL,
  duration_ms        int  NOT NULL,
  outcome            text NOT NULL CHECK (outcome IN ('replied','silent','handoff','deterministic','reset','budget','error')),
  sop_version        int,
  prefix_hash        text NOT NULL CHECK (prefix_hash ~ '^[0-9a-f]{64}$'),
  catalog_versions   json NOT NULL,           -- { 'route:r-guizhou': 2 }：本轮工具结果里出现过的条目版本
  stage_before       text,
  stage_after        text,
  draft              text,
  final_text         text,
  calls              json NOT NULL,
  llm                json NOT NULL,           -- 每次模型调用一项，带 error（R24 的 AI 出错率）
  signals            json,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX turn_traces_by_conv ON turn_traces (tenant_id, conversation_id, started_at);
CREATE INDEX turn_traces_by_time ON turn_traces (tenant_id, started_at);  -- 运行数字（R24）
CREATE TABLE guard_events (
  tenant_id uuid NOT NULL,
  turn_id   uuid NOT NULL,
  ord       smallint NOT NULL,
  guard     text NOT NULL CHECK (guard ~ '^[a-z_]{2,40}$'),
  action    text NOT NULL CHECK (action IN ('drop_sentence','replace','patch','append','strip','handoff')),
  removed   json NOT NULL,
  added     json NOT NULL,
  PRIMARY KEY (tenant_id, turn_id, ord),
  FOREIGN KEY (tenant_id, turn_id) REFERENCES turn_traces (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE usage_daily (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  day               date NOT NULL,
  model             text NOT NULL,
  purpose           text NOT NULL CHECK (purpose IN ('chat','followup','insight','suggestion','draft','embedding')),
  calls             int    NOT NULL DEFAULT 0,
  prompt_tokens     bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  cached_tokens     bigint NOT NULL DEFAULT 0,
  reasoning_tokens  bigint NOT NULL DEFAULT 0,
  cost_milli_cny    bigint NOT NULL DEFAULT 0,  -- 千分之一元，避免浮点
  PRIMARY KEY (tenant_id, day, model, purpose)
);

CREATE TABLE jobs (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('followup','handoff_notify','retention_purge')),
  dedupe_key   text NOT NULL,
  run_at       timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','sending','done','failed','cancelled','abandoned')),
  attempts     int  NOT NULL DEFAULT 0,
  max_attempts int  NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  payload      json NOT NULL,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  finished_at  timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX jobs_open_uq ON jobs (tenant_id, dedupe_key) WHERE status IN ('pending','running','sending');
CREATE INDEX jobs_due ON jobs (tenant_id, run_at) WHERE status = 'pending';

CREATE TABLE quick_replies (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  ord             int  NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 20),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  archived_at     timestamptz,
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- outbound_sends、catalog_item_versions、privacy_notices、consents 见上文各节
```

触发器（custom 迁移，属主 `agent_owner`）：

- `conversations` 的 BEFORE INSERT OR UPDATE：`NEW.updated_at > now() + interval '5 minutes'` 就报错；UPDATE 时 `NEW.updated_at := greatest(OLD.updated_at, NEW.updated_at)`。导入写入过去的时间不受影响。
- `orders` 的 BEFORE UPDATE：`OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at` 就报错；`OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id` 而当前角色不是 `agent_owner` 也报错（清除与删除函数、外键的 `SET NULL` 动作以属主执行，照常放行）。否则 `agent_app` 把已付订单的 `session_id` 置空或改挂，会话就会按线索的保留期被提前清除（R20、不变量 6）。

授权（RLS 套件逐格断言；没有任何角色对新表有 DELETE 或 TRUNCATE）：

| 表                                                                             | `agent_app`            | `agent_platform` |
| ------------------------------------------------------------------------------ | ---------------------- | ---------------- |
| `conversations`、`orders`                                                      | SELECT、INSERT、UPDATE | 无权限           |
| `messages`、`turn_traces`、`guard_events`、`consents`、`catalog_item_versions` | SELECT、INSERT         | 无权限           |
| `usage_daily`、`jobs`、`outbound_sends`、`quick_replies`                       | SELECT、INSERT、UPDATE | 无权限           |
| `privacy_notices`                                                              | SELECT                 | SELECT、INSERT   |
| `tenants` 的三个保留期列                                                       | SELECT（沿用）         | UPDATE（列级）   |

清除与删除函数（属主 `agent_owner`，SECURITY DEFINER，`SET search_path = pg_catalog, public, pg_temp`，表名全限定，对 PUBLIC 撤销 EXECUTE）。与 01 的认证函数不同，它们要求调用者已在 `withTenant` 里：`current_setting('app.tenant_id', true)` 为空或不等于 `p_tenant` 就报错，没有「替调用者设租户」的分支：

```sql
-- 只 GRANT 给 agent_app
purge_conversation(p_tenant uuid, p_id text, p_now timestamptz, p_expected_last_seq int, p_expected_updated_at timestamptz) RETURNS boolean
  -- |p_now − now()| 超过 5 分钟就报错（不许传一个未来的「现在」把没到期的数据删掉）；
  -- 库里的 last_seq、updated_at 与两个预期值不符就返回 false（清理时会话又有了动静）；
  -- 这个会话有没有任何一张订单写过 paid_at，取 retention_customer_days 或 retention_lead_days；
  -- updated_at 早于 p_now − 保留期才删：会话行（级联消息、trace、护栏事件、同意记录）、按 id 删发送账本与 payload 里 sessionId 是它的任务（任何状态），
  -- 订单 session_id 置空并 data := (data::jsonb - 'sessionId')::json，返回 true；否则 false
purge_expired_traces(p_tenant uuid, p_now timestamptz) RETURNS int
  -- 同样校验 p_now；删 started_at 早于 p_now − retention_trace_days 的 trace（级联护栏事件），
  -- 以及没有对应会话、sent_at 同样过期的发送账本行；返回删除条数
purge_finished_jobs(p_tenant uuid, p_now timestamptz) RETURNS int
  -- 删 finished_at 早于 30 天的 done、cancelled、abandoned、failed 任务
-- 只 GRANT 给 agent_platform（R23）
erase_conversation(p_tenant uuid, p_id text, p_reason text) RETURNS json
  -- 不看保留期；删除范围与 purge_conversation 相同；写一行 platform.erase 审计；返回各类的条数（含 jobs）
```

- 迁移 lint：`catalog_items.version` 是带 DEFAULT 的 NOT NULL，不用标注；回填用 `DO` 块按租户 `set_config` 后 `INSERT … SELECT`，不用动态 `EXECUTE`。`tenants` 的三列带 CHECK，会命中 `add-check` 规则（`ALTER TABLE` 与 `CHECK` 同句），标注 `-- migration-allow: add-check 新列带默认值且满足约束，旧镜像不写这几列`。
- 01 的 `db.selftest.ts` 写死了「七张表」与权限期望表，本阶段同步扩充（它不在锁定清单里）。`deploy/backup.sh` 的 TABLE DATA 校验加上 `conversations`、`messages`、`orders`（行数可以为 0，不告警）。
- 01 的 `withTenant` 加选项 `longRunning: true`：事务开头 `SET LOCAL statement_timeout = '60s'`、`SET LOCAL idle_in_transaction_session_timeout = '120s'`，只给预载、导入、导出、清理用（`agent_app` 默认的 5 秒与 10 秒在这几处会先于 R2 的信号断开连接）。`client.ts` 另导出 `inTenantTx()`。

### 导入、导出与切换

```
# 以 app 身份运行，要求应用已停（要取租户锁）
src/cli/import-sessions.ts  --tenant <slug> --keep <dir> [--var <dir>] [--dry-run] [--resync]
src/cli/export-sessions.ts  --tenant <slug> --keep <dir> --var <dir>
# 以 platform 身份运行
src/cli/tenant-retention.ts   --tenant <slug> [--lead <天>] [--customer <天>] [--trace <天>]
src/cli/privacy-publish.ts    --tenant <slug> --file <path>
src/cli/erase-conversation.ts --tenant <slug> --id <会话 id> --reason <文字>   # 要求应用已停
```

- **标记文件** `var/sessions-in-db.json`（`{ tenant, at, sessions }`）表示「真实会话在库里，JSON 只剩 demo 类」。import 在改写 JSON 之前写，db 存储启动时没有就补写（`sessions` 是预载的真实会话数），export 写完 JSON 后删掉。import 写标记、import 与 export 改写 JSON 都先写临时文件再改名，改名与 export 删标记之后对目录 fsync；启动时的补写只先写临时文件再改名。不经 import、一上来就以 db 存储起的实例因此也有它；补写失败时由回滚检查另看服务器 `.env` 兜住。它决定启动时的两个拒绝（`real_in_json`、`sessions_in_db`）和 `deploy.sh` 的回滚检查。
- **import-sessions**：
  - 读 `sessions.json`、`orders.json`，按 `isDemoClassId` 分成真实与 demo 类；订单跟着所属会话走，所属会话不在真实会话里的订单（孤儿订单）留在 JSON，由文件后端原样保留。
  - 库里这个租户还没有会话时：一个 `withTenant(…, { longRunning: true })` 事务，按 500 个会话一批写入：消息按数组下标写 `seq`（从 1 起），`window_start_seq = 1`，`last_seq = 消息条数`；`state` 与订单 `data` 原样；不对产品库建外键。每批写完在同一事务里按启动预载的同一条路径读回，经 `normalizeForStore` 后逐个 `deepStrictEqual`，不等就回滚、退出码 2 并点名第一个不等的会话短码；打印被规范化的字符串条数。
  - 提交后把两个原文件复制到 `--keep`，先写标记文件，再把 JSON 改写成只剩 demo 类（顺序是标记、`sessions.json`、`orders.json`。还没写标记时崩溃，JSON 仍是原件、文件存储照常能起；写了标记而 `sessions.json` 还没改写时，两种存储都拒绝启动；`sessions.json` 已改写而 `orders.json` 还没改写时，文件存储拒绝启动，db 存储照常启动、预载时以库为准接管 `orders.json` 里的真实订单。几种情况重跑 import 都能收尾），打印真实会话数、消息数、订单数。`--keep` 在开事务之前先验可写，写不进去就以 1 退出、什么都不动。
  - 库里已有会话时：JSON 里没有真实会话且有标记，退出码 0（已经导入过）；JSON 里的真实会话与库里逐个一致，补完改写与标记，退出码 0；不一致退出码 2，提示用 `--resync`。拿不到租户锁退出码 3。`--dry-run` 只打印将写入的条数与往返结果。
  - `--resync`（回退到文件存储跑过一段之后再切回）：JSON 里每个真实会话，库里没有就按首次导入写；库里有、而库里的窗口是文件窗口的前缀，就把多出来的消息追加上去；否则把 `window_start_seq` 推到 `last_seq + 1`，把文件窗口整个作为新消息追加（历史里会重复一段，不丢）。`state` 换成文件里的。订单按 `id` upsert，这些会话在库里有、文件里没有的订单作废（`void_reason='resync'`）。之后同样改写 JSON、写标记，退出码 0。
- **export-sessions**：在 `REPEATABLE READ READ ONLY` 的 `longRunning` 事务里按批读出全部真实会话（窗口内的消息）与未作废订单，把原 JSON 复制到 `--keep`，合并进 `--var` 下的两个 JSON（同 id 以库为准；先写订单、再写会话，最后删掉标记文件）。没有标记文件、而 JSON 里的真实会话与库里重建的不一致时以退出码 2 拒绝、什么都不动：多半是回退到文件存储之后又误跑了一次 export，照「同 id 以库为准」会盖掉文件存储期间的新消息与付款状态，提示改用 `import-sessions --resync`；全部一致、且库里没有 JSON 以外的真实会话时当无操作返回 0（不复制原件、不改文件）；库里另有 JSON 没有的真实会话时照常导出，把它们补进来；JSON 里没有真实会话时照常导出。`--keep` 与 import 一样在开事务之前先验可写，写不进去以 1 退出、什么都不动；拿不到租户锁以 3 退出。导出结果再交给 `import-sessions --resync`，退出码 0（验收 3）。窗口以外的旧消息不进 JSON，与文件存储的裁剪语义一致。
- **切换步骤**（demo 由 owner 在线上执行，第一次在本机 compose 上演练）：
  1. 以文件存储部署 02 的镜像（`SESSION_STORE` 不设），确认 `/healthz` 的 `store.mode = file`，记下 `config` 的四个哈希（这次部署会因为 SOP 改动产生一个 rerender 版本）。
  2. `docker compose stop app`；以 app 身份跑 `import-sessions --keep <var 之外的目录>`，核对打印的条数。
  3. `.env` 加 `SESSION_STORE=db`，`docker compose up -d app`；核对 `/healthz` 的 `store.mode = db`、console `/status` 的会话数等于导入的会话数，后台能打开一个导入的会话。
  4. 失败就 `stop app`，跑 `export-sessions`，去掉 `SESSION_STORE=db` 再起；导入之后 db 存储期间的新消息都在导出里。之后再切回：停 app，`import-sessions --resync`，回到第 3 步。
  5. 切换后第一份备份做完恢复验证（验收 31），就删掉 `--keep` 目录里的原件。
- **回滚到 02 之前的镜像**（`:prev` 或指定的旧 tag）：先按第 4 步回到文件存储，再部署旧 tag。01 的镜像不认识 `SESSION_STORE`，也不写条目版本：在 db 存储下回滚会让客户历史全部消失，在改过价之后回滚会让那期间发出的链接回来后按版本 1 显示旧价。所以 `deploy.sh` 回滚（含健康检查失败后的自动回滚）前检查：目标镜像里没有 `src/store/pg-backend.ts`（02 之前的镜像），而服务器 `var/` 里有标记文件、服务器 `.env` 里是 `SESSION_STORE=db`、或正在运行的实例 `/healthz` 的 `config.catalogVersioned` 为 true（有条目版本大于 1）时拒绝，并打印上面的步骤。两个都是 02 之后的镜像时照常回滚。

### 压测

`scripts/load/run.ts`（不进 `test`，结果记进 plan）在本机真实 Postgres、db 存储、假企微接口（照 `wecom.selftest.ts` 的写法）与 mock LLM 上跑：

- 50 个客户各 10 轮，mock LLM 每次延迟在 2–8 秒间均匀分布；20 个 console SSE 连接；其中 5 个客户触发转人工，2 个由顾问接手并回复。
- 429 风暴：中间 60 秒让 30% 的模型请求返回 429，观察 `llm-gate` 的排队与对冲。
- 预载：5,000 个会话、每个 300 条消息，以 `agent_app` 的默认超时启动，记下预载耗时。
- 通过条件：每条客户消息恰有一次回复或一条记录在案的兜底；每个（客户、轮次）至多一次 send_msg 组（不重复发）；库里的消息数等于内存；转人工事件从提交到 SSE 送达 p99 ≤ 1 秒；落库延迟 p99 ≤ 500ms；事件循环延迟 p99 ≤ 200ms；结束时常驻内存比开始时增长不超过 20%；风暴期间进程不崩，风暴之后 1 分钟内回到正常延迟；预载不被语句超时打断，耗时 ≤ 30 秒。

### 测试与 CI

- `src/selftest-env.ts` 把 `SESSION_STORE` 钉成 `file`（与它钉 profile 的做法相同）；锁定的 7 组自测、文件模式 eval 与其余进程内套件因此都跑文件存储，断言一条不改。以子进程跑的锁定断言靠「导入期行为与模式无关」（R3）。
- 新增套件，串进 `test`，每组先设临时 `VAR_DIR` 再动态 import：
  - `src/store/store.selftest.ts`：PGlite 部分（seq 分配与 `WindowCorruptError`、预载往返、写队列顺序与合并、冻结、窗口推进、重置作废、冲突退出、COMMIT 断线后认出已提交、数据类错误标 poisoned 而别的会话照常、NUL 与切开的 emoji 不堵队列、存档点里的 trace 写失败不影响会话、事件只在提交后、`chat()` 在 `withTenant` 里调用即断言失败、在 `withTenant` 回调里 `saveSession` 照常落库、连接池计数下一轮除写队列的落库外不发查询、三段停机与 spill 写出和回放、清理与新消息竞争、标记文件的两个拒绝、导入往返与 `--resync`）；真实 Postgres 部分，有 `PG_TEST_URL` 才跑（新表的 RLS 与授权逐格、触发器拒绝倒退 `updated_at`、改 `paid_at` 与非属主改已写的 `session_id`、清除函数拒删未到期数据、不在 `withTenant` 里调用报错、`agent_app` 对消息的 UPDATE / DELETE / TRUNCATE 报 permission denied、以子进程跑 `import-sessions` / `export-sessions` / `erase-conversation` 断言退出码）。
  - `src/store/parity.selftest.ts`：同一组场景（含 E5「生成中接管」、模型返回后推送前接管、生成中付款、重置、裁剪、重放、跟进、转人工各入口）分别跑在文件存储与 PG 存储上，会话 id 用非 demo 类的 `wecom:parity-*`，比较回复文本、会话投影与订单，并断言 PG 里确实有这些会话。
  - `src/handoff/handoff.selftest.ts`：三类触发与撤回同意的向量表（命中与不命中各一组）、四种状态、接手状态机（并发接手、自动接手、别人接手中 409、坐席带 force 403、交还恢复阶段、终态会话转人工保留终态、接手代次）、重置清掉接手人与计数、历史里的「【顾问】」与出口去前缀、敏感信息类别。
  - `src/jobs/jobs.selftest.ts`：跟进的排程、取消、`FOLLOWUP_ENABLED` 关时不排、最多发一次（`sending` 之后「崩溃」不重发、之前「崩溃」重来）、过护栏、拒绝识别；通知任务；清理任务；启动时 `running` 的各类任务的去向。
  - `src/quota/quota.selftest.ts`：窗口与剩余条数（从 `sentAt` 起算）、结果不明计数、重试沿用 msgid、回执、人工回复与跟进的放行、去重与重放的五种情况。
  - `src/privacy/privacy.selftest.ts`：隐私说明的发布与内存刷新、欢迎语、同意菜单与再问一次、不同意后交还 409、撤回同意。
  - `src/ops/ops.selftest.ts`：告警的触发、去重与限流、内容里没有客户原话和 `external_userid`、推送失败不抛；pino JSON 的字段；`logQuote`；OpenTelemetry 在没配端点时不加载、配了时用进程内的假 OTLP 接收端断言 span 与属性、默认没有原文；运行数字的 SQL（PGlite）。`deploy/watch.sh` 与 `backup.sh` 的告警用 PATH 里的假 `docker`、`curl`、`df` 以子进程测。
  - `src/console-api/console.selftest.ts` 新增的用例：新接口、权限矩阵逐格（含 403 与 409 的分界）、viewer 打码、prod 匿名 401（含 `/events`）、枚举 `server` 与 `consoleApi` 注册的全部路由断言白名单以外的匿名请求是 401 或 404、`/api/orders/:id` 的键集合、旧接口匿名分支没有成员身份、`legacy_admin_writes` 关时旧写接口 404、事件流的鉴权（删掉 auth_session 后 60 秒内关闭）与内容。
  - console 的工作台、总览、外壳自测：四态与计数同源、禁用词扫描（「待人工」「已转人工」「待接管」「需要介入」，含 `handoff_note` 时间线）、交接卡措辞、「已成交客户要人工」一组、运行数字格只给所有者与管理员。
- DB 模式 mock eval：`CONFIG_TEST_DB=pglite` 时同时装上 PGlite 上的 PG 会话存储，会话 id 改用非 demo 类的 `eval:<用例>-<时间>`（文件模式照旧 `sim-eval-`；`eval/run.ts` 不在锁定清单里）；核对每个请求的前缀哈希（01 验收 21 的自动部分）之外，跑完断言库里有每个用例的会话，且库里的消息与内存一致。
- `scripts/check-console-src.ts` 的会话状态白名单加 `assigned`。
- 有意修改的非锁定断言（每条在对应步骤的 PR 里写明理由）：`console.selftest.ts` 的「会话列表每条只有 6 个投影字段」改成新的键集合（「不带消息正文和客户画像」那两条照旧成立，`needSummary` 不回显自由文本）；`console/src/parts/errors.selftest.ts`、`overview/overview.selftest.tsx`、`conversations/conversations.selftest.tsx` 里禁止「顾问处理中」与「今天不画」的断言，改成按 02 的四态断言；`config.selftest.ts`、`console.selftest.ts` 断言五个计价字段 422 的用例；`db.selftest.ts` 的「七张表」；`packs.selftest.ts` 随 `sopFields` 加 `payNote` 自动成立。

### 可观测性与告警

owner 2026-10-02 定（R24）。一个实例一个租户期间，不上时序数据库、不部署 Langfuse；能定位问题、能在出事时叫醒人、老板能看到几个运行数字即可。

**结构化日志**

```ts
// src/log.ts
/** LOG_FORMAT=json：pino 输出 JSON 行；未设：照旧打纯文本（自测与本机开发不变） */
export const log: Logger;
/** prod profile 下返回「«N字»」，demo 下原样返回 */
export function logQuote(text: string): string;
/** 请求与轮次的上下文（AsyncLocalStorage）：pino 的 mixin 从这里取字段 */
export function withLogContext<T>(ctx: Partial<LogContext>, fn: () => T): T;
export interface LogContext {
  req: string;
  tenant: string;
  conv: string;
  turn: string;
}
```

- 每行带 `time`、`level`、`msg`，在 HTTP 请求里带 `req`（中间件生成，同时写进响应头 `x-request-id`），在一轮对话里带 `tenant`（slug）、`conv`、`turn`。`conv` 在 db 存储下是会话行的 `ref`，文件存储下是短码：日志里不出现会话原 id（里面是 `external_userid`）。
- `LOG_FORMAT=json` 时 `boot()` 把 `console.log / info / warn / error` 接到 pino（同一行 JSON，`msg` 是原来的字符串），现有日志不用逐行改就带上下文；客户原话由 `logQuote` 管（第 1 步盘点出的位置逐个改）。
- 不记密钥：pino 的 `redact` 盖住 `*.authorization`、`*.cookie`、webhook URL 一类字段；`NOTIFY_WEBHOOK_URL`、`ALERT_WEBHOOK_URL` 只出现在 env 文件里。
- compose 的 `json-file` 轮转（20m × 5）不变；日志里没有客户原话，所以不另设保留期。

**告警**

```ts
// src/ops/alert.ts
export type AlertKey = 'model_errors' | 'wecom_send' | 'tenant_lock' | 'store' | 'jobs';
/** 发到 ALERT_WEBHOOK_URL（企微群机器人，text 消息）。同一键在条件持续期间 30 分钟内至多一次；resolved 发一条「已恢复」。
 *  只发生在后台：5 秒超时、至多重试 2 次、失败只记日志，不抛、不阻塞请求与对话。没配 URL 时只写一行 warn 日志 */
export function alert(key: AlertKey, text: string, opts?: { resolved?: boolean }): void;
export function startAlerts(): void; // 挂上各处的订阅（模型、企微、租户锁、写库、任务）
```

告警内容是「[实例名] 中文说明 · 时间」，只有计数、短码、错误码，不含客户原话、`external_userid`、密钥和带凭据的地址。触发条件：

| 键 / 来源                     | 条件                                                                                                                        | 恢复                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `model_errors`（app）         | 连续 5 次模型调用失败（超时、重试后仍 429、5xx、回包不可用），或最近 50 轮里 AI 出错率超过 20%                              | 连续 10 次成功        |
| `wecom_send`（app）           | 10 分钟内 3 个分段最终发送失败（rejected 或 unknown）；取不到 access_token 立即告警                                         | 10 分钟没有失败       |
| `tenant_lock`（app）          | 租户锁进入 lost；确认被别的进程持有、开始停机时再发一条                                                                     | 锁重新拿到            |
| `store`（app）                | `store_conflict`、会话 poisoned、`WindowCorruptError`、`lagMs` 超过 60 秒、停机写了 spill 文件、10 分钟内存档点里丢了遥测行 | `lagMs` 回到 5 秒以内 |
| `jobs`（app）                 | `retention_purge` 或 `handoff_notify` 用完重试次数记 `failed`                                                               | —                     |
| 备份（`deploy/backup.sh`）    | 任何一步失败（`trap` 在非零退出时发）；`watch.sh` 另查「上次成功的备份早于 26 小时」                                        | 下一次成功            |
| 反复重启（`deploy/watch.sh`） | app 容器的 `RestartCount` 10 分钟内增加 2 次以上                                                                            | 30 分钟没有重启       |
| 健康检查（`deploy/watch.sh`） | 本机 `curl /healthz` 连续 3 分钟失败，或 `ok` 为 false                                                                      | 连续 3 分钟正常       |
| 磁盘（`deploy/watch.sh`）     | 数据卷或根分区使用率 ≥ 85%，≥ 95% 再发一次                                                                                  | 回到 80% 以下         |

- `deploy/watch.sh` 由主机的 cron 每分钟跑一次，读服务器上运维 env 文件里的 `ALERT_WEBHOOK_URL` 与 `INSTANCE_LABEL`，去重状态存在一个小文件里；路径与 cron 配置另记。
- **外部拨测**：国内云厂商的拨测服务（开放问题 14，探测点在境内）每 1–5 分钟探一次公网 `/healthz`，非 200 或响应里没有 `"ok":true` 连续两次就通知（拨测服务自己的通知，能配 webhook 的话也推到同一个群）。它覆盖 app、主机和 `watch.sh` 一起挂掉的情况。2026-10-09 起（见顶部 `Revisions:`）：长期用 UptimeRobot 每 5 分钟探一次，通知走账号邮件；验收 34 的「停掉 app、通知在 10 分钟内到达」用腾讯云云拨测的试用版跑过一次（通知推到账号与告警群）。

**运行数字**

```ts
// src/shared/console-api.ts
export interface MetricsView {
  days: number; // 统计窗口，默认 7
  turns: number; // 窗口内的轮次数（库里只有真实会话）
  replyP90Ms: number | null; // outcome='replied' 的轮次 duration_ms 的 90 分位
  handoffRate: number | null; // 窗口内有 outcome='handoff' 轮次的会话 / 窗口内有轮次的会话
  aiErrorRate: number | null; // 有模型调用出错（llm 数组里 error 非空）或 outcome='error' 的轮次 / 全部轮次
  costTodayYuan: number; // usage_daily 今天的 cost_milli_cny 之和 / 1000
  costRangeYuan: number; // 窗口内之和
}
```

- `GET /api/console/metrics?days=7`（所有者、管理员）由 `src/db/repo/metrics.ts` 的几条 SQL 在 `turn_traces`、`usage_daily` 上现算（`percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms)`、`json_array_elements(llm)`），结果在内存里缓存 60 秒；文件存储下 503 `store_file_mode`。窗口受 trace 保留期限制。
- 总览：「需要你处理」那一行下面加一行四个 KPI 格（A 页 KPI 格的样式），只给所有者、管理员，文件存储下不画：「回复用时（秒）」口径「近7天，90%的回复在这之内」；「转人工率」口径「近7天有转人工的会话占比」；「AI出错率」口径「近7天出错的轮次占比」；「今天的AI费用（元）」明细「近7天共…元」。没有数据写「—」；加载用格子骨架，出错就地重试。文案不出现模型名。

**OpenTelemetry（默认关闭）**

```ts
// src/otel/export.ts —— 只在设了 OTEL_EXPORTER_OTLP_ENDPOINT 时由 boot() 动态 import
/** BasicTracerProvider + BatchSpanProcessor + OTLP/HTTP 导出器；resource：service.name=wecom-sales-agent、service.version=APP_REVISION */
export async function startOtel(): Promise<void>;
/** 由 recorder 的 endTurn 调：按 TurnContext 里记下的时间补建一棵 span 树（不在热路径上传播上下文） */
export function exportTurn(t: TurnContext, outcome: TurnOutcome, meta: { tenant: string; conversationRef: string; channel: string }): void;
```

- 每轮一条 trace：根 span `invoke_agent <行业包的助手名>`（`gen_ai.operation.name=invoke_agent`、`gen_ai.agent.name`、`gen_ai.conversation.id`、`app.turn.outcome`、`app.sop.version`、`app.prefix.hash`）；每次模型调用一个 `chat <模型>`（`gen_ai.operation.name=chat`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`app.llm.cached_tokens`、`app.llm.hedged`，失败带 `error.type`）；每次工具调用一个 `execute_tool <工具名>`（`gen_ai.operation.name=execute_tool`、`gen_ai.tool.name`、`app.tool.prefetch`）；每个护栏事件一个 `guard <名字>`（`app.guard.action`、删去与补上的句数）。
- Langfuse 的属性同时写上：`langfuse.session.id` 与 `langfuse.user.id` 都取会话的 `ref`（不用 `external_userid`），`langfuse.trace.name=turn`。属性名在实施时按当时的 OTel GenAI 语义约定与 Langfuse 文档核对（GenAI 约定仍在演进），版本写在代码注释里。
- 原文默认不进 span：不写 `gen_ai.input.messages`、`gen_ai.output.messages`、工具参数与结果。`OTEL_CAPTURE_CONTENT=1` 时才写本轮客户原话、最终回复和工具参数；自建的 Langfuse（开放问题 13）部署好、有了保留期与权限之前不开。
- 没设端点时：不加载任何 `@opentelemetry/*` 模块、不起导出线程、不向外连接；`endTurn` 里只有一次判断。导出失败只记日志，不影响对话。

## 与 01、后台 UX spec 的关系

- **新增**走 Amends（顶部 `Amends:` 一行）：新表、`tenants` 三列、`catalog_items.version`、`withTenant` 的 `longRunning` 选项与 `inTenantTx()`、`writeAuditAs`、新审计动作、新接口与共享类型、`/healthz` 的 `store` 与 `config.catalogVersioned`、`CONVERSATION_STATES` 的新值、`ConversationRow` 的新字段、`AUDIT_ACTIONS` 的新项与 K 页的新分段、铃铛弹层与 A2 的「已成交客户要人工」一组、总览的运行数字格。
- **01 与 UX spec 自己写明「由 02 定 / 02 之后」的条款**，本阶段照它们留下的口子执行：
  - 01 裁决 R8「推迟：有报价快照后逐字段开放（02）」与开放问题 5「由 02 的 spec 逐字段定」→ `LOCKED_WHEN_ACTIVE` 去掉五个字段。
  - 01 裁决 R6「按轮固定快照（02 放开计价字段之前）」→ `pinCatalogForTurn`。
  - 01 开放问题 6「02 spec 开工前定」→ R21。
  - UX spec「依赖 02 的后端」第 2 项「02 之后 `conversationState` 的返回值、`ConvQuery.state`、`ConversationCounts.byState` 都加第四种状态 `assigned`，`human` 改为『转人工且没有接手人』」→ R12。
- **改写了已 implemented 的条款**（不是新增，amendment 管不到；开放问题 1 定为「部分取代」，本 spec 顶部 `Supersedes in part:` 点名这几处）：
  - 01 不变量 4「DB 模式下，处理一轮对话不发出任何数据库查询」：`SESSION_STORE=db` 时一轮里的 `saveSession` 会排出落库（在写队列里、与 `chat()` 并行）。改写为「DB 模式下，一轮的读路径不查库；会话写入只经写队列，落库事务里不调模型」（本 spec 不变量 9）。`SESSION_STORE=file` 时原文照旧成立。
  - UX 不变量 27 的最后一句「会话接口的响应里没有客户画像字段和消息正文」：J 页的详情接口要给成员看消息正文和需求要素。改写为「会话列表与计数接口的响应里没有客户画像字段和消息正文（`needSummary` 只用规范化的取值）；详情接口只给成员，只读成员看到的正文打码」。
  - UX spec 会话列表与外壳里「今天 / 目前」的条款（新标签打开 `admin.html#s=`、状态句「接手和回复目前在工作台里完成」、铃铛 30 秒轮询）换成同一 spec 里已经设计好的 J 页与 SSE。UX 验收 20 的「点一行，新标签页打开工作台并选中该会话」因此在 02 之后按「在当前标签打开 J 页并选中该会话」验证；同条「带 `ADMIN_PASS` 时，对一个真实会话再走一次：登录框走完后仍然选中」不再适用（点一行进的是 console 的 J 页，不经过 `ADMIN_PASS` 登录；`admin.html` 自己的深链照旧，见 R11）；同条其余部分照旧。
- 01 与 UX spec 顶部已各加一行 `Superseded in part by:`（2026-10-02），列出上面这几处，正文不动；`Amended by:` 在开工时（plan 第 1 步）加，同时把 UX plan「Open」里交接卡措辞那一条标为由本 spec 解决。

## 不变量

每条都能写成断言或测试。

存储与写入：

1. `SESSION_STORE` 不是 `db` 时，store 是文件存储，进程不为会话建立数据库连接；两种模式下 store 的导入期行为相同。
2. `SESSION_STORE=db` 而 `CONFIG_SOURCE` 不是 `db` 时拒绝启动（`env_invalid`）；`initSessionStore` reject 时 `serve()`、预检、索引、任务、企微都没有启动，企微 cursor 文件不变。
3. db 存储下 `getSession`、`getOrder`、`listSessions`、`saveSession` 同步返回；同一个 id 两次 `getSession` 返回同一个对象。
4. 每个真实会话在库里的消息，seq 从 1 起连续、无空洞，`(tenant_id, conversation_id, seq)` 唯一；内存窗口里的消息顺序与 seq 顺序一致，`window_start_seq` 等于窗口第一条的 seq。
5. `agent_app` 与 `agent_platform` 对 `messages` 都没有 UPDATE、DELETE、TRUNCATE；对任何新表都没有 DELETE、TRUNCATE。
6. 保留期内的会话、消息、trace，`agent_app` 删不掉：清除函数只删已过保留期的行，判断依据的 `updated_at` 只进不退、`paid_at` 写一次不改、订单已写的 `session_id` 只有属主能改；只有平台身份经 `erase_conversation` 能删保留期内的。
7. db 存储下进过落库快照的消息对象是 frozen 的，任何字段写入都抛 `TypeError`；真实会话的数组错位在下一次 `saveSession` 时被查出。
8. 同一会话的落库按 `saveSession` 的发生顺序生效，任何时刻至多一个在途；`saveSession` 返回时新消息已有 seq。
9. DB 模式下，处理一轮对话的读路径不发出数据库查询（会话、订单、产品库版本都读内存），会话与 trace 的写入只经这个会话的写队列；落库事务的回调里不 await 任何模型调用、渠道发送或别的会话；`chat()` 被调用时当前异步上下文不在 `withTenant` 里。
10. 领域事件、SSE、`/api/admin/stream` 的 `change`、任务的排程，只在包含该改动的事务提交之后发生；提交失败时不发生。唯一的例外是带转人工的落库失败时外部通道的 `unsaved` 通知。
11. `sim-` 与 `wecom:cust_` 开头的会话及其订单永不出现在 PG 里。
12. 落库发现另一写者时，进程走优雅停机，不重试、不吞错；数据类错误不重试，只停这一个会话的落库并告警，其余会话照常落库。
13. 正常停机之后，没落库的改动要么已提交，要么在 spill 文件里；下次启动先回放 spill，接不上就拒绝启动。
14. 对导入的每个真实会话与订单，经启动预载路径重建出的对象与原 JSON 经 `normalizeForStore` 之后 `deepStrictEqual`。
15. db 存储启动之后 JSON 里没有真实会话；`var/` 里有标记文件时文件存储拒绝启动。
16. 进内存的客户文本与所有截断都经 `cleanText`：内存与库里的字符串相同，不含 U+0000 与孤立代理项。

消息与人工：

17. `author='human'` 的消息只经接手状态机写入，必带操作者；共享工作台的 `authorId` 为 null。
18. 发给模型的历史里，`author='human'` 的消息以「【顾问】」开头；发给客户的 AI 回复不以「【顾问】」开头；人工回复在客户侧以「【顾问】」开头。
19. 02 里 `promptPrefix()` 只因第 15 步那一次 SOP 改动（收款措辞，以及紧急或发火时调转人工工具的一句）而变化；其余所有改动前后逐字节相同，prod 与 demo 相同。
20. 人工回复与付款确认，在包含那次改动的落库提交之后（或等满 5 秒之后）才发给客户。

转人工与接手：

21. 会话状态只有四种，只由 `conversationState` 判定：终态 → `paid`；转人工且有接手人 → `assigned`；转人工且没有 → `human`；其余 `ai`。
22. 同一时刻一个会话至多一个接手人；两个并发的接手恰有一个成功。
23. 人工回复只在调用者是接手人时发出；没有接手人时调用者先成为接手人；别人接手中时返回 409，不发送、不改会话。
24. 每次进入转人工都有 `handoff` 记录（类型、时间、原因），所有入口无一例外；从「未转人工」进入时没有接手人。
25. `firstHandoffAt` 一旦写入永不清除，`handoffCount` 只增不减；交还只清 `handedOver`、`handoff`、`assignee`，重置另清失败与情绪计数。
26. 订单标记已付时写下 `handoffBeforePaid`，等于会话当时是否曾经转过人工。
27. 阶段已在终态的会话，进入转人工、客户再发消息之后，阶段仍是那个终态。
28. 一轮开始之后接手代次变了，这一轮的 AI 回复不发给客户。
29. 紧急情况命中且未转人工时，回复是固定应急话术并立即转人工，本轮没有模型请求；已转人工时不回话。
30. 价格或注入护栏命中的轮次不计入交互失败。

通知与额度：

31. 事件流只对本租户的成员开放，匿名 401，登录失效后 60 秒内关闭；事件里没有消息正文、客户原话和画像字段。
32. 外部通知与告警的内容里没有客户原话和 `external_userid`。
33. 每个 send_msg 分段在发送账本里恰有一行，带我们生成的 msgid；同一分段的重试沿用这一行与这个 msgid。
34. 跟进只在窗口剩余条数 ≥2 且剩余时间 ≥2 小时时发出；人工回复在剩 0 条或窗口已过时被拒并说明原因；结果不明的发送计入已用条数。

报价快照：

35. active 条目每次内容变化都产生一个新的、不可改的版本；带 `v` 的方案书按该版本渲染，不带 `v` 按版本 1；版本为 1 的线路，链接形状与开工时逐字节相同；匿名请求方案书不查库。
36. 一轮之内所有 `loadRoutes()` / `loadHotels()` 返回同一代快照。
37. 改价不改变已有订单的金额，也不改变已发出方案书链接显示的报价。

跟进、收款、隐私：

38. 进入 `sending` 的跟进任务不会被再次执行；跟进文本发出前过出口护栏；客户拒绝之后这个会话不再有跟进；`FOLLOWUP_ENABLED` 不是 `1` 时不排跟进任务。
39. `mock_pay` 关时，匿名请求改变不了订单状态；确认价格、确认收款、取消订单只经有权限的成员（坐席只限接手人本人）或带 `ADMIN_PASS` 的旧接口，每次一行审计。
40. 没有发布隐私说明时，欢迎语与开工时逐字节相同、不发同意菜单；发布了时首次欢迎语带 `/privacy` 链接。
41. 同意记录只追加；客户不同意或撤回同意的会话不能交还 AI。
42. 一个会话被清除或删除之后，`orders`、`audit_log`、`outbound_sends`、`consents`、`turn_traces`、`jobs` 里都搜不到它的 `external_userid`。

公开路由与后台：

43. `/api/orders/:id` 的响应键集合恰为 R22 的白名单，`POST /api/orders/:id/pay` 的 200 与 409 响应体里 `order` 的键集合同样；`server` 与 `consoleApi` 注册的路由里，白名单以外的在 prod 下匿名请求一律 401 或 404。
44. 匿名响应里没有成员的 user id 与姓名（01 不变量 31），旧接口的匿名分支同样。
45. counts 的 `byState` 四项之和等于 `total`，`aiByStage` 之和等于 `byState.ai`；徽标与标题前缀只数 `human`。
46. console 的界面文案与 `handoff_note` 时间线里没有「待人工」「已转人工」「待接管」「需要介入」。
47. 只读成员拿到的消息正文与客户原话里没有完整的手机号、证件号、银行卡号。

可观测性：

48. prod profile 下进程日志里没有客户原话；`LOG_FORMAT=json` 时每行是一个 JSON 对象，带 `time`、`level`、`msg`，请求里的带 `req`，轮次里的带 `tenant`、`conv`、`turn`，`conv` 不是会话原 id。
49. 没设 `OTEL_EXPORTER_OTLP_ENDPOINT` 时进程不加载任何 `@opentelemetry/*` 模块、不向外发 trace；设了而没设 `OTEL_CAPTURE_CONTENT=1` 时，span 里没有客户与 AI 的原文，任何时候都没有 `external_userid`。
50. 同一告警键在条件持续期间 30 分钟内至多推一次；告警推送失败不影响请求与对话。

## 验收标准

1. **锁定套件零修改。** 与开工提交相比，锁定清单里的文件 diff 为空；`pnpm test` 全绿。开发机 `.env` 里写着 `SESSION_STORE=db`、`CONFIG_SOURCE=db` 与 `DATABASE_URL` 时，`pnpm test` 的结果不变。
2. **两种存储等价。** 等价套件的每个场景在文件存储与 PG 存储上的回复文本、会话投影（去掉 seq 与时间戳）、订单都相同，PG 里确实有这些会话；DB 模式 mock eval（`eval:` 会话）通过的用例集合与文件模式相同，跑完后库里有每个用例的会话，库里的消息与内存一致。
3. **导入往返与切换。** 用一份含真实会话、种子、访客、孤儿订单、带可选字段（`followup`、`quoteHistory`、昵称）、含 NUL 与孤立代理项的 `var/` 做导入：每个真实会话与订单往返相等（规范化之后），打印规范化条数；demo 类与孤儿订单留在 JSON；写了标记文件，原件在 `--keep`；再导入一次退出码 0；改动一条消息后再导入退出码 2；应用持锁时退出码 3。导出（标记文件被删）→ 文件存储下再聊几轮 → `--resync` → db 存储启动：库里有导出之后的新消息，内存与库一致。db 存储下 JSON 里塞一个真实会话，启动以 `real_in_json` 拒绝；文件存储下有标记文件，以 `sessions_in_db` 拒绝。没有标记时再 export：JSON 与库逐个一致返回 0、什么都不动，JSON 比库新返回 2、什么都不动。库里已有会话而 `var/` 没有标记时以 db 存储启动，补写了标记，之后文件存储以 `sessions_in_db` 拒绝。真实 Postgres 上以子进程执行一遍。
4. **重启不丢。** db 存储下跑 20 轮，SIGTERM 后重启：identity map 与停机前经 `JSON.parse(JSON.stringify(…))` 规范化之后 `deepStrictEqual`。mock LLM 延迟 6 秒的一轮进行中发 SIGTERM：重启后这一轮的客户消息与回复都在库里。drain 段让 PG 不可写：停机写出 spill 文件，恢复 PG 后重启回放，库与停机前的内存一致；把 spill 文件的「已提交到第几条」改错一格，启动以 `spill_conflict` 拒绝。模拟崩溃（落库前丢弃进程）后重启：只少最后一次未提交的落库，库与内存一致。
5. **只追加与清除权限。** 以 `agent_app` 对 `messages` 执行 UPDATE、DELETE、TRUNCATE 都报 permission denied；`purge_conversation` 对没到期的会话返回 false 且库不变；先把 `updated_at` 改成 2000 年（被触发器挡回原值）或把已付订单改成取消，再调清除函数，仍返回 false；改 `paid_at` 报错；以 `agent_app` 把已付订单的 `session_id` 置空或改挂报错，之后对这个保留期内的客户会话清除仍返回 false；传一个 10 分钟之后的 `p_now` 报错；不在 `withTenant` 里调用报错。db 存储下改写一条已落库消息的 `content` 抛 `TypeError`，从会话中间删一条消息后 `saveSession`，会话标成 poisoned。重置之后库里旧消息仍在、窗口推进、订单作废，内存与 E6、E6p 的断言一致。
6. **顺序与事务边界。** 同一会话连续十次 `saveSession`，库里的消息顺序与内存相同；在 `withTenant` 回调里调 `chat()` 断言失败，在 `withTenant` 回调里 `saveSession` 照常落库；提交失败时没有事件发出，恢复后补上。
7. **并发行为在 PG 存储上成立。** 生成途中顾问在 console 接手：本轮 AI 回复不发出，记一条「本轮未发送」；模型返回之后、推送之前接手（在 `strandedReply` 的 await 里接手）：同样不发出；生成中客户付款：阶段停在已付，之后客户再发消息仍是已付。
8. **另一写者。** 真实 Postgres 上，第二个进程连同一个库拒绝启动；人为让库里的 `last_seq` 前进一格后再落库，进程以优雅停机退出，日志点名 `store_conflict`；让 COMMIT 之后的回包丢掉（假连接），重试认出已提交，不停机、不重复插入。
9. **prod 鉴权。** prod profile 下，管理面接口（`/api/console/*` 除登录外，含全部新接口与 `/events`；`/api/admin/*`；会话与订单列表）匿名请求一律 401；枚举全部注册路由，白名单以外的匿名请求都是 401 或 404；白名单里的每条公开路由逐条断言能匿名访问、只返回凭 id 能取到的那一条，`/api/orders/:id` 与 `POST /api/orders/:id/pay` 两个分支里 `order` 的键集合恰为白名单；`/privacy` 匿名 200（发布过）或 404；旧的 handoff、resume、reply 返回 404，带凭据的标记已付照旧 200。成员接手一个种子会话后，demo 匿名读它的响应里没有成员 uuid 与姓名。删掉一个成员的 auth_session，他的事件流在 60 秒内收到 `auth` 并关闭。
10. **四种状态一致**（原 UX 验收 26 第 1 条）。用 02 的种子场景（设计系统 §10.0 第 5 条：14 个会话）：在工作台接手一个等人接手的会话：它从铃铛弹层与 A2「需要你处理」里消失，侧栏与铃铛的徽标减 1，在列表与 J 页分组里显示为「顾问处理中」；会话页出现「顾问处理中」页签，counts 的 `byState.assigned` 加 1、四项之和仍等于 `total`；另一位顾问打开同一会话看到「小林处理中」，「接手会话」不可用并写明原因；两个浏览器同时点「接手会话」，恰有一个成功、另一个看到 409 的说明。用后台 UX 验收 4 的 13 个种子会话重跑 UX 验收 6（在 `admin.html` 里把 B01 转人工，它成为等人接手，四处计数都是 3，页面上不出现「顾问处理中」），照旧通过。
11. **人工回复即接手。** 在没人接手的会话上直接回复：调用者成为接手人，消息带「顾问 · 姓名」，客户侧收到「【顾问】…」；让落库暂停 3 秒，假企微接口在落库提交之后才收到这条；在别人接手中的会话上回复：409、客户没收到、会话没变；写库积压时回复 503、什么都没改；旧接口 `/api/sessions/:id/reply` 走同一套规则。交还 AI 之后的下一轮模型请求里，顾问那几句以「【顾问】」开头，contextNote 带说明。
12. **曾经转过人工与终态。** 转人工 → 接手 → 交还 → 再转人工：`firstHandoffAt` 是第一次的时间，`handoffCount` 为 2；交还后客户付款，订单的 `handoffBeforePaid` 为 true。已付的会话里客户说「我要退款」：阶段仍是「已支付」、状态仍是已成交、徽标不变，会话出现在铃铛弹层与 A2 的「已成交客户要人工」里，外部通道收到一条；客户再发一句，阶段与状态都不变；有人接手后它从那一组消失。重置一个已接手的会话后再触发转人工：状态是等人接手，不是顾问处理中。（开放问题 12 的 A。）
13. **交接卡。** 五种入口（要人工、投诉、模型转人工、改行程承诺、顾问主动接手）各造一个会话：交接卡的第一行、原因、客户原话、识别出的日期、停在哪个阶段都对；措辞是「AI交给人工 · hh:mm」或「小林接手 · hh:mm」；对话里「AI 已转人工：…」的 system 消息渲染成时间线行；工作台的禁用词扫描（界面文案加时间线）通过。
14. **工作台列表**（原 UX 验收 26 第 2 条）。每行的标题占满第一行、状态在第二行；320 宽下「企微客户 · 7F3A · 贵州带爸妈4人」不被截断；等人接手的行写原因和等待时长，≥10 分钟用 danger。
15. **5 秒内通知**（原 UX 验收 26 第 3 条）。后台开着时，在假企微接口上让客户说「我要投诉」：5 秒内铃铛徽标加 1、标签页标题出现「(N) 」；授权了浏览器通知时弹出一条，正文没有客户原话。断开 SSE 后 30 秒内由轮询补上。转人工通知群的机器人（开放问题 3）收到一条不含客户原话和 `external_userid` 的消息；10 分钟没人接手再收到一条。让 PG 不可写后客户说「我在山上头很疼喘不上气」：外部通道立即收到一条标「记录暂未保存」的紧急通知，PG 恢复后不再重发。
16. **A2**（原 UX 验收 26 第 4 条）。「本月成交额」等于当月已付且未作废订单的金额之和（种子场景 207,440），明细「另有待付85,600元」；「需要你处理」的顺序照设计系统 A2；坐席看不到本月成交额，请求 `/orders?status=paid` 得到 403。
17. **三类确定性触发。** 紧急、交互失败、负面情绪各有一张向量表：命中的句子确定性转人工、类型对；出行前的提问（「去西藏会不会高反」）、否定、转述、价格护栏命中的轮次都不触发。紧急情况那一轮没有模型请求；已转人工的会话里客户说紧急情况，不回话、记录升级、再通知一次。精确度按留出集衡量（售前与一般咨询的误判率、全部「不是」的误判率、明确正例的召回、全部正例的召回），数字记进 plan。
18. **发送账本与去重。** 客户一句话之后连发 5 次：第 6 次人工回复被拒并写明「这一轮已经发满 5 条」；假企微接口对一个分段先超时再成功：账本是一行、同一个 msgid，计 1 条；只超时：记 unknown、计入额度；回一个 `msg_send_fail`（`fail_type` 4）：对应消息显示没送达、会话多一条说明、前端收到 `send_failed`；剩 1 条时跟进不发。去重的五种情况各一个用例，其中「客户这句已入库、回复还没生成时进程被杀」重启后客户恰好收到一次回复；「回复已送出」的重放不补发。
19. **报价快照。** 给一条 active 线路改 `priceFrom`：改之前发出的 `/proposal/<线路>/2` 报价不变；之后新出的链接带 `?v=2`、按新价；`?v=3`（还不存在）返回 404，期间没有数据库查询；已有订单金额不变；改价发生在一轮中间时，这一轮的工具结果与护栏看到的是同一代快照。改 `title` 仍返回 422。删掉一个 active 条目的全部版本行（模拟 01 镜像期间上架）后重启，补写了版本 1，它的链接照常打开。
20. **trace。** 一轮里价格护栏删了一句：库里有这一轮的 trace（带 `catalog_versions`）和一行 `price` 护栏事件；J 页这条回复下出现「AI原稿里删了1句 · 展开」，展开是对照；所有者能看到「AI为什么这么回」里的模型、耗时和参数，坐席请求 trace 原文得到 403。
21. **用量。** 跑一组 mock 对话、一次跟进、一次洞察、一次检索向量化后，`usage_daily` 里本租户当天各（模型、用途）的调用数与 token 数等于 `recordUsage` 收到的合计。
22. **跟进。** db 存储、`FOLLOWUP_ENABLED=1` 下：AI 回复后排出跟进任务，客户回话后取消；到点发出的跟进过了价格护栏（造一个带编造金额的跟进话术，发出的文本里没有它）；进入 `sending` 后模拟崩溃，重启后不重发，记 `abandoned`；进入 `sending` 之前模拟崩溃，重启后照常发一次；客户说「别发了」之后不再排。`FOLLOWUP_ENABLED` 未设时不排任何跟进任务。文件存储下锁定的 F1 断言照旧。
23. **收款流程。** prod profile（advisor）：`create_order` 的结果带 `payNote`；`/pay/<单号>` 没有付款按钮、按状态写说明、标题仍是「<线路> · 订单支付」；`/pay.html?orderId=<单号>` 跳到 `/pay/<单号>`；价格护栏的替换句是 advisor 的写法；匿名 `POST /api/orders/:id/pay` 返回 404；未确认就「确认收款」返回 409；不是接手人的坐席确认价格得到 409 `not_assignee`；确认价格、确认收款各一行审计，客户收到付款确认，订单 `handoffBeforePaid` 正确。demo profile 下这条链路与开工时相同。
24. **前缀。** 自动：DB 模式 mock eval 每个请求的 system 与 tools 哈希等于 `/healthz` 报的值；SOP 改动之外的每一步提交，`promptPrefix()` 的两个哈希与上一步相同（plan 记下每次的值）。手动：SOP 改动后按「文件 → DB → 文件」交替跑 realOnly 用例各至少 3 遍，两种模式的 p90 都不超过 8 秒，通过的用例集合与改动前相比不少，数字记进 plan。同一次真实模型回归另加主模型兜底的用例：行程中的紧急与冲着我们发火的兜底用例，模型应调 `handoff_to_human`（售前的提问不调），结果记进 plan「验收记录」。
25. **保留期清理。** 把测试租户的保留期设成线索 7 天、客户 30 天、trace 7 天，造三个会话：最后动静在 8 天前的线索、6 天前的线索（它有一条 8 天前的 trace）、8 天前但有一张已付订单的客户。清理之后：第一个连同消息、trace、发送账本消失，内存与 console 里也没有它；第二个还在，只有那条 8 天前的 trace 没了；第三个原样，订单不受影响。`system.purge` 审计只有条数。另造一个有已付订单、最后动静在 31 天前的客户会话：会话被清除，订单还在、`session_id` 为空，`orders`、`audit_log`、`outbound_sends` 里搜不到它的 `external_userid`。清理时恰好有一条新消息进来的会话：这次不清，消息照常落库。prod profile 下跑一组含价格护栏命中与转人工的对话，日志里搜不到其中任何一句客户原话。
26. **隐私与同意。** 发布隐私说明后，新客户的欢迎语末尾有链接，`/privacy` 显示正文；客户说「我妈有高血压」，回复之后多一条同意菜单（写明用途、影响、可撤回与链接），点「同意」记一条 `granted`；没点的会话下一次提到同类信息再问一次，之后不再问；另一个会话点「不同意」，转人工（类型 consent）、AI 不再回复，交还 AI 返回 409；客户说「把我的信息删掉」，记 `withdrawn`、回固定的一句、转人工。重新发布一版隐私说明，60 秒内 `/privacy` 显示新版。没发布隐私说明的 demo 实例，欢迎语与开工时逐字节相同，不发同意菜单。
27. **行权删除。** 应用在跑时 `erase-conversation` 退出码 3；停掉应用后对一个保留期内、有已付订单的会话执行：会话、消息、trace、同意记录、发送账本都没了，订单还在、`session_id` 为空、`data` 里没有 `sessionId`，库里搜不到它的 `external_userid`；`platform.erase` 审计只有条数与原因；重启后 console 里没有这个会话。
28. **确定性错误不堵塞。** 一个会话里依次进来：含 U+0000 的客户消息、在第 2000 个字处被截断的 emoji、一条会触发非法护栏名的轮次：之后的消息照常落库，护栏事件那一行被丢弃并计数。用一条违反 CHECK 的投影让某个会话落库失败：它被标成 poisoned，`/status` 点名短码，`/healthz` 的 `ok` 为 false，告警收到一条；别的会话照常落库；停机写出它的 spill。
29. **demo 照常。** db 存储下：网页与企微的「重置」都生效（E6、E6p 的行为），种子保鲜、访客清理、`admin.html` 匿名只读与旧写接口、模拟支付、AI 标识都照旧；`admin.html` 的列表 401 时弹登录框。
30. **压测。** 按「压测」一节跑完，通过条件全部满足，数字记进 plan。
31. **备份与恢复。** 把一份含会话的加密备份恢复到新集群：`/healthz` 的 `config` 哈希与 console `/status` 的会话数与原库一致；`conversations`、`messages`、`orders` 行数相同；随机抽 3 个会话，console 里的消息与原库相同；备份时恰有一轮在途的那个客户，恢复后的第一次企微拉取让他恰好收到一次回复，已回复过的消息不重复回复。
32. **demo 切换与回滚检查。** 线上按「切换步骤」执行：切换前后 `config` 的四个哈希相同（SOP 改动那次 rerender 之后的值）；`store.mode = db`，console `/status` 的会话数等于导入数；后台能打开导入的会话；切换期间的停机时间记进 plan。本机演练里：有标记文件、服务器 `.env` 里是 `SESSION_STORE=db`（即使没有标记文件）或改过价时，`deploy.sh` 拒绝回滚到 01 的镜像并打印步骤；两个 02 镜像之间的回滚照常。
33. **走查。** 用 Playwright 在浅色、深色下各走一遍并截图：I 页四个页签 → J 页接手 → 回复 → 交还 → 交接卡 → 「AI原稿里删了1句」展开 → 铃铛与标题 → 浏览器通知 → A2（含「已成交客户要人工」与运行数字）→ 快捷回复管理；只用键盘经「更多」完成一次交还 AI；axe 的 `color-contrast` 0 条违规，截图存到 `docs/architecture/02-conversations-workbench/walkthrough/`。
34. **可观测性。** prod profile、`LOG_FORMAT=json` 下跑一组含价格护栏命中与转人工的对话：标准输出每行都能解析成 JSON，轮次里的行带 `tenant`、`conv`、`turn`，请求里的行带与响应头 `x-request-id` 相同的 `req`，搜不到客户原话与会话原 id。假 webhook 上：mock LLM 连续 5 次超时收到一条 `model_errors`，30 分钟内再 5 次不再收到，恢复后收到「已恢复」；假企微连续失败收到 `wecom_send`；租户锁丢失收到 `tenant_lock`；用假 `docker`、`curl`、`df` 跑 `watch.sh` 收到重启、健康检查、磁盘三类，`backup.sh` 中途失败收到备份告警；所有告警里没有客户原话与 `external_userid`。种好 `turn_traces` 与 `usage_daily` 后 `/metrics` 的四个数与手算一致，坐席请求得到 403，总览的四个格只有所有者、管理员看得到。没设 OTLP 端点时进程里没有加载 `@opentelemetry/*`；设成进程内的假接收端时每轮收到一条 trace，含 `chat`、`execute_tool`、`guard` 三类 span 与 `gen_ai.operation.name`、`langfuse.session.id`，没有客户原话；设了 `OTEL_CAPTURE_CONTENT=1` 才有。外部拨测配好后停掉 app，通知在 10 分钟内到达（手动，记进 plan）。
35. **02 范围内的上线前置条件。** 验收 15、17、23、25、26、27、34 都通过；plan「上线清单」逐项写明状态（PIA、委托处理约定、系统页 spec、租户的保留期、按 PIA 复核同意细节、企微额度实测、真实模型回归等）。上线清单是否清空不是本 spec implemented 的条件，是接第一个真实租户的条件。

## 开放问题

14 条已由 owner 在 2026-10-02 全部定下，裁决写在各条开头，选项与理由留着备查，不阻塞任何步骤。还要在接第一个真实租户之前核实或完成的（7 按 PIA 复核、8 的实测、10 的回归、11 的仓库外事项）记在 plan「上线清单」。

1. **本阶段改写 01、UX spec 的已实现条款，走哪条路** 已定（owner 2026-10-02：选 A。规则写进了 `docs/spec-driven-dev.md`「改变决定」与 AGENTS.md；本 spec 顶部 `Supersedes in part:` 点名取代的条款，01 与 UX spec 顶部各加了一行 `Superseded in part by:`）。依据 AGENTS.md：implemented 之后改决定要新 spec 取代，amendment 只能新增。涉及「与 01、后台 UX spec 的关系」里列的三处：01 不变量 4、UX 不变量 27 的最后一句、UX 会话列表与外壳里「今天」的条款（连同 UX 验收 20）。
   - A（推荐）：在 `docs/spec-driven-dev.md` 与 AGENTS.md 加「部分取代」：后来的 spec 可以点名取代已 implemented spec 的个别条款，被取代的 spec 顶部加一行 `Superseded in part by:` 列出条款号，原文不动。02 用它取代这三处，其余照 Amends。规则清楚，以后 03、04 还会遇到同样的事。
   - B：不改流程，owner 确认这几处本来就是「今天 / 01 范围内」的写法，02 的读法成立，在 01 与 UX spec 的 `Amended by:` 里点名。省事，但等于让 amendment 改了原有条款，开了口子。
   - 不可行：另写一份 spec 整份取代 01 或 UX spec（AGENTS.md 现有的取代只有整份，为三条改动作废两份已实现的 spec 不合理）。
2. **保留期多长** 已定（owner 2026-10-02：照推荐，线索 180 天、客户 730 天、trace 90 天，写成迁移的默认值，按租户可改）。依据个人信息保护法第 19、47 条的最短必要，以及行业下限。推荐：没有成交的线索 180 天；有过付款的客户 730 天（旅游包：《旅行社条例实施细则》第 50 条要求合同及相关资料保存不少于两年，聊天记录算不算「相关资料」未核实，按算处理）；trace 90 天；prod 的应用日志不写客户原话（R24），原话只留在有保留期、有权限的 trace 里。备选：线索 90 天（更少留存，但跟进周期长的客户会在成交前被清掉）；客户 3 年（覆盖诉讼时效，但超出最短必要要另写理由）。保留期按租户可改，不同行业包的下限另议。
3. **SSE 之外的转人工推送通道** 已定（owner 2026-10-02：照推荐，企微群机器人 webhook，与告警不在同一个群）。依据第一个真实租户的顾问人数与是否要「点了就接手」。推荐：企微群机器人 webhook，只要一个 URL、不用改企业的应用配置，顾问群里人人可见，适合几个人的顾问团队；与告警（R24）用同一种通道、不同的群。备选：企微应用消息（要 agentid、应用密钥、可见范围和可信 IP，能按人推、能做「接手」按钮并把别人的卡片置灰），顾问超过 5 人或要按人派单时再换。
4. **负面情绪怎么识别** 已定（owner 2026-10-02：选 A，确定性的词表加规则）。2026-10-03 起按顶部 Revisions 的精确优先执行。词表实施时先拿锁定原话与 eval 原话过一遍（「确定性转人工触发」最后一条）。推荐 A：确定性的词表加规则（强烈的辱骂与「垃圾 / 废物 / 滚」这类针对我们的话算强，「失望 / 无语 / 太差了 / 坑人 / 离谱 / 敷衍」这类算弱；按小句判，疑问、否定、转述别人的评价排除；最近 3 条里 1 强或 2 弱就转人工），可解释、可回归、零延迟。备选 B：每轮多一次模型分类，会突破 8 秒线、结果不稳定；备选 C：让主模型顺带打标签，要改工具定义或输出格式，改前缀且不确定。
5. **`channel_inbox` 是否从 04 提前** 已定（owner 2026-10-02：照推荐，留在 04，本阶段做三条缓解）。第 26 步的恢复演练验证；演练里复现了重复回复或丢消息，就在接第一个真实租户之前另写 spec 提前做。推荐：留在 04，本阶段做 R7 的三条缓解（客户消息带 msgid 并按五种情况去重、备份先打包 `var/` 再导出库、重放按发送账本判断已送出）；验收 31 要求恢复后在途的客户恰好收到一次回复。备选：提前到 02，把 cursor、已处理集合和在途表搬进 PG，与客户消息同一事务，约多 3–4 个工程日，并要改写企微适配器的状态层。
6. **demo 下「重置」的底线** 已定（owner 2026-10-02：选 A）。依据锁定的 E6 与 E6p：demo 下重置后已付订单也从 `getOrder` 消失。推荐 A：demo 下客户看到的行为不变（含已转人工也能重来、订单从会话里消失），实现上不删数据：消息窗口推进、订单记作废，已付的订单也作废但留在库里；prod 照旧关掉重置，不做白名单。备选 B「demo 下已付订单不作废、客户重来后仍能看到」与 E6p 冲突，不可选；备选 C「重置时调清除函数真删」要让清除函数能删没到期的数据，见「被否决的方案」。这一条实际上已由锁定断言定下。
7. **敏感信息同意的细节** 已定（owner 2026-10-02：照推荐做；PIA 出结论后按它复核下面「要确认的点」，要改就在接第一个真实租户之前改）。依据个人信息保护法第 28–31 条与 PIA 的结论。推荐：类别取健康信息与 14 周岁以下孩子的信息两类；第一次出现时用企微菜单问，写明用途、必要性、对个人的影响、可撤回与隐私说明链接；没点就在下一次出现同类信息时再问一次，仍没点就照常接待、提示模型不主动提这类信息；不同意就转人工，且不能交还 AI。要确认的点：带娃出游极常见，「孩子 5 岁」也要问是否太打扰；菜单点击能不能算「单独同意」（GB/T 45574-2025 的形式要求，未读到原文）；没点时照常接待是否够（备选：第二次仍没点就转人工，更稳妥但打扰大）。
8. **企微额度与接口行为的待核实点** 已定（owner 2026-10-02：照推荐，核实之前按 R18 的保守口径算；接第一个真实租户之前在测试客服账号上实测，结论记进 plan，只改 `src/quota/ledger.ts` 与适配器的常量）。待核实：客户每发一条消息后额度是恢复成 5 条还是累加；48 小时从哪一条起算；`send_msg_on_event` 发的欢迎语算不算进 5 条；同一 msgid 重发时接口是去重还是报错；`sync_msg` 能拉到多久以前的消息（决定去重集合留 7 天是否够）。推荐：核实之前按 R18 的保守口径算（只会少发，不会多发）。备选：按官方文档的字面口径算，发得多一些，但有撞墙的风险。
9. **顾问能不能改订单价格** 已定（owner 2026-10-02：照推荐，02 不做改价；以后依据试点商家的成交习惯要做，就按备选另写 spec）。推荐：02 不做；金额不对就取消订单，让 AI 按规则重新报价，或在系统外处理。备选：另写 spec 做改价：必须由人发起、写原因、留审计，价格护栏的出处要认这张单。
10. **线上内容的真实模型回归**（01 开放问题 10）已定（owner 2026-10-02：照推荐，写成固定的回归步骤，不做发布闸；第一次在接第一个真实租户之前跑）。不阻塞本阶段。推荐：把「`export-config` → 文件模式跑 realOnly 用例」写成上线前的固定步骤，此后每月一次、以及每次 prod 租户发布 SOP 之后一次，结果记在私有笔记；不做成发布闸（03 的真实模型发布闸会取代它）。备选：现在就做成发布闸，每次发布花钱、拖慢发布，且与 03 重复。
11. **接第一个真实租户之前、仓库之外的事项** 已定（owner 2026-10-02：照推荐，全部完成之后才接第一个真实租户）。owner 负责，不阻塞本阶段；依据总参考「接真实租户之前必须有的」。事项：PIA；与模型厂商的委托处理约定；地方网信办登记是否适用（以属地的书面答复为准）；租户的隐私说明正文（含行权方式与备份保存期）。推荐：全部完成之后才接第一个真实租户，进度记在 plan「上线清单」（只记完成与否，内容另记）。备选：试点期先签简版委托处理约定、PIA 随后补齐，风险由 owner 承担。
12. **已成交的会话又转人工，怎么呈现** 已定（owner 2026-10-02：选 A，保留「已成交」，铃铛弹层与 A2 单列「已成交客户要人工」）。第 3 步的 `enterHandoff` 依赖它；依据付款后的退款、投诉、出行中的紧急情况要不要进「等人接手」与徽标。推荐 A：阶段保留终态，状态仍是「已成交」，成交统计不受影响；转人工记录照写、通知照发，铃铛弹层与 A2 单列「已成交客户要人工」，徽标不变（UX 不变量 19 不动）。备选 B：照今天的做法把阶段改成 `handoff`，会话回到「等人接手」、计入徽标，交还后恢复终态；不用加界面，但「已成交」的数字会随转人工来回变，`console.selftest.ts` 里「付款以后又转人工的算已成交」要改。
13. **Langfuse 怎么接** 已定（owner 2026-10-02：选 A，以后在另一台境内机器上自建 Langfuse，OTLP 端点指过去；02 只做埋点、不部署）。本阶段的 OpenTelemetry 埋点默认关闭，属性已按 Langfuse 能识别的写。推荐 A：在另一台境内机器上自建 Langfuse，OTLP 端点指过去；数据不出境，以后要看对话原文（`OTEL_CAPTURE_CONTENT=1`）也能在同一套保留期与权限下开。代价：自建要 ClickHouse、Redis 与对象存储（另加 Postgres），多一台机器和一份运维。备选 B：用 Langfuse Cloud，只发元数据（耗时、token、成本、出错与否，会话与用户都用 `ref`，不发原文）；省事，但 Langfuse Cloud 没有中国区，哪怕只是可关联到个人的 `ref` 也可能算个人信息出境，要先过个人信息出境的合规评估。备选 C：暂不接，靠 console 的 trace 与运行数字，等排查需求真的出现再定。
14. **外部拨测用哪家** 已定（owner 2026-10-02：照推荐，国内云厂商的拨测服务）。**2026-10-09 改**（owner，见顶部 `Revisions:`）：验收用腾讯云云拨测的免费试用，长期用 UptimeRobot（国内拨测按次收费，demo 不值得；服务器在香港，境外探测点不会因跨境网络误报）。下面是原裁决的推荐与备选。第 17 步配；owner 选定账号，账号信息另记。推荐：国内云厂商的拨测服务，探测点在境内，能配 webhook 推到告警群。备选：海外的免费拨测服务，探测点在境外，访问境内站点的结果会受跨境网络影响，容易误报。

## 被否决的方案

- **`CONFIG_SOURCE=db` 同时决定会话存储**：切换要停机导入，和配置切换绑在一起就没法先无风险地部署新镜像；回滚也得同时回退配置源。
- **identity map 懒加载**（`getSession` 变异步，或冷会话按需加载）：前者要改锁定自测和二十多处同步调用；后者让列表、计数、总览漏掉冷会话，两份数据各说各话。
- **db 存储下导入期什么都不做**（上一稿）：以子进程跑 `src/store.ts` 的锁定断言不带 `SESSION_STORE`，`env.ts` 会把本机 `.env` 里的 `SESSION_STORE=db` 补进去，断言就变红；信号与停机钩子也是全进程的机制，不归会话存储管。
- **每次写入直接同步写库**（不要写队列）：每轮至少两次往返，同一会话的两个写者会乱序；`saveSession` 也就不再是同步的。
- **整会话一行 JSON（消息也放进 `state`）**：写一条消息要重写整个会话，做不到只追加，也没法按 seq 翻页和按保留期删消息。
- **用全局自增 id 给消息排序**：序号在提交前就分配，提交顺序与序号不一致；同一会话里也会出现空洞。会话行上的计数器加每会话串行的写队列，同一会话的提交顺序与 seq 一致。
- **seq 在落库事务里才分配**（上一稿）：发送账本、`reply` 的返回值、详情接口都在提交之前就要 seq。
- **落库失败一律重试**（上一稿）：NUL、约束冲突这类错误重试多少次都一样，会把这个会话之后的改动全堵住，重启就丢。
- **`messages.msgid` 建唯一索引兜底**：重复的 msgid 漏进来时，唯一冲突会让这个会话的落库卡死；去重放在进内存之前做。
- **保留期判断另设 `last_activity_at` 列、对它收回 UPDATE**：「最后动静」的语义是 `session.updatedAt`（跟进不刷新），另一列要么与它不一致，要么还得同步维护；对 `updated_at` 加「只进不退」的触发器就够了。
- **重置时调清除函数真删**：清除函数就得允许删没到期的数据，任何能发「重置」的客户都能触发删除；改成推进窗口加作废。
- **种子与访客会话也进库**：保鲜每小时改写时间戳，访客按 24 小时清理、上限 5000，进库只会制造写入，还要给匿名直读另开租户解析。
- **报价快照做成每次报价一行、链接里带快照 token**：已发出的链接要一直能打开，锁定断言也钉住了路径形状（`includes('/proposal/r-yunnan-mid/2')`、`》` 后换行接链接、`extractCard` 的全等比较），换形状就得改断言；每次报价一行也随流量增长。按条目版本做，版本 1 的链接一个字节都不变。
- **企微原生转接（状态 3）**：状态 3 下接口发不了消息，console 就没法回复；也没有 3→1，交还 AI 只能结束会话。
- **两位顾问的冲突靠数据库行锁或 advisory lock 解决**：单进程下内存里的同步比较并设置就够了；多副本时（05）再加每会话锁。
- **旧 `/handoff` 也以共享工作台接手**（上一稿）：B01 会变成「顾问处理中」，重跑 UX 验收 6 必然失败；「转人工」与「接手」本来就是两件事。
- **负面情绪每轮多调一次模型**：突破 8 秒线，结果不稳定，也没法写成回归向量表（见开放问题 4）。
- **跟进也用定时扫描、只把记账搬进库**：扫描器每 15 分钟全量遍历，到点不准；任务表按 `run_at` 排程，客户回话即取消，记账与 `sending` 一起提交天然给出「最多一次」。
- **跟进在两种存储下都换成任务表**：文件存储没有库，锁定的 F1 断言测的正是扫描器；两种存储共用资格、护栏和拒绝识别，只换调度。
- **SSE 事件带消息正文，省掉前端重取**：事件流的权限比详情接口宽（所有成员、长连接），正文和客户原话不该经它广播；重取详情一次请求就够。
- **浏览器 Web Push（Service Worker）**：Chrome 的推送依赖 FCM，大陆连不上；页面关着时的通知交给外部通道。
- **外部通知里带客户原话或会话 id**：群里的人不一定都该看客户原话；链接指向等人接手的列表，进后台再看。
- **prod 下保留全部 `ADMIN_PASS` 旧写接口**（上一稿）：锁定断言只钉住了「prod 带凭据能标记已付」；拿着共享口令的人能以「共享工作台」给真实客户发消息，没有必要。handoff、resume、reply 改由开关管，prod 关。
- **按 profile 给 demo 和 prod 不同的 SOP 措辞**：违反 00 不变量 12（prod 与 demo 的 system prompt 逐字节相同，锁定断言测它）。
- **顾问在确认价格时直接改金额**：改价是对客户的承诺，要由人发起、写原因、留审计，价格护栏也要认它；02 不做（开放问题 9）。
- **人工回复也过价格护栏**：顾问可以做承诺；护栏拦人只会让顾问绕开系统。
- **人工回复先发送、再落库**（今天的顺序）：发送之后、提交之前崩溃，客户看到了「【顾问】…」，库里却没有，顾问重做一遍客户就收到两次。改成提交之后再发；落库超时也照发，因为「记下了但没发」会让顾问重发，同样重复。
- **把「【顾问】」写进消息正文入库**：库里的正文就不再是顾问打的字，改前缀规则还得改历史数据。
- **保留期写死在代码或环境变量里**：不同租户、不同行业的下限不同，改它要留审计；放在 `tenants` 上由平台命令行改。
- **订单随会话一起删除**：订单是成交记录，删会话时只断开它与客户标识的关联（`session_id` 置空、`data` 去掉 `sessionId`）。
- **行权删除做成 console 里的一个按钮**：要么给 `agent_app` 删没到期数据的权限，不变量 6 就不成立；要么在应用运行中删，identity map 会把会话写回去。平台命令行加停机，频率低，代价可以接受。
- **运行数字进 Prometheus 或别的时序数据库**（owner 2026-10-02 否决）：一个实例一个租户，四个数用 SQL 现算就够，多一个组件多一份运维。
- **02 就部署 Langfuse**（owner 2026-10-02 否决）：自建要 ClickHouse、Redis、对象存储，Cloud 有出境问题；先把埋点做成默认关闭、属性对得上，以后在境内自建（开放问题 13）。
- **OpenTelemetry 默认打开、span 默认带原文**：没有接收端时白耗资源；原文进第三方系统就是一次新的个人信息处理，要先有保留期、权限和出境的结论。
- **告警走短信、邮件或自建告警平台**（owner 2026-10-02 选群机器人）：群机器人只要一个 URL，顾问与老板都在企业微信里。
