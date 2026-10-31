# 15 · 第 1 步共享契约

依据 [spec](./spec.md) R1、R4、R6–R10、R12。此文件固定三路交界，不记录进度；进度和验收只写 [plan](./plan.md)。本步只有类型、权限迁移与真实贯穿测试，没有设置 handler、页面或 trial-reset 命令。

## 只读设置

唯一 DTO/URL/query key 定义在 `src/shared/console-api.ts`：OrganizationView、MemberView、ChannelView、OnboardingView、SettingsResponses、SETTINGS_URLS、SETTINGS_ROLES、SETTINGS_ERRORS、settingsQueryKey。用量类型直接引用 14 的 UsageView，既有 `/api/console/usage` 不重写。

- 新设置接口均 GET；以 Host 与真实会话确定租户，不接收自报 tenantId/actor/role。owner/admin 可用；supervisor/agent/viewer、沙箱、匿名只读模式 403。prod 未登录或失效会话 401；既有 usage 的匿名 403 按 14 原样保留。
- 错误体沿用 ApiError：unauthorized 401、forbidden 403、db_disabled/store_file_mode 503、internal 500。不可把查询异常吞成空列表；不把 SQL/凭据放进 detail。没有新增写入错误或占位成功响应。
- 查询键 `['settings', tenantId, userId, page]` 只用于内存缓存，身份从真实认证结果取得；登出、401/403、切组织清 settings 前缀。用量 30 秒重取、页面隐藏暂停；其他配置在重新打开与聚焦时重取。
- 已发布品牌取启动的发布快照，待生效标记比较发布快照与持久配置。渠道 enabled 与 loaded 分开；env accountId 为 null，kind 从 wecom_kf 投影为 wecom，缺入站证据 lastInboundAt=null；不可序列化渠道行或凭据对象。
- onboarding 的 team/catalog/sop/channel 分别看另一有效成员、包定义的可用上架条目、已发布话术、实际装载企微账号且有入站记录。href 仅取 ONBOARDING_HREFS：产品库把 `:kind` 替换为当前包已登记且编码后的实体 kind；不输出模板占位符，不接收外部 URL。reason 为用户可读原因，不能放运维秘密。

### 成员函数

`drizzle/0025_console_members_read.sql` 接在 0024 后；journal 同步。`console_members_read(uuid,text)` 的 text 是现有 cookie 的 SHA-256 **64 位小写 hex**，不是 cookie、base64 或自报用户 id。后端仍经原认证中间件，再以 `withTenant` 调此函数；函数自身独立验证 token 的租户、绝对期限、12 小时空闲、用户启停、当前成员角色、standard 与租户非 suspended。

只返回 user_id/display_name/email/role/disabled，A 路映射到 MemberView。无权或 token 无效返回空行，事务已设其他租户则报 insufficient_privilege；后端不得凭空把空投影解释为成功授权。所有者投影至少含自己，认证与投影间降权导致空行时拒绝访问。固定 search_path，表名全限定，恢复原 app.tenant_id；仅 agent_app 有 EXECUTE，PUBLIC/platform 无权，users/memberships/auth_sessions 直接表权限不变，memberships FORCE RLS 不变。

## 静态发布与品牌输入

- 共用 `src/shared/product-surface.ts` 的 PRODUCT_NAME、PRODUCT_FOCUS、PUBLIC_SITE_PAGES、PUBLIC_GUIDES、ProductPublishInput；选型见 [ADR-006](../../adr/adr-006-product-static-sites.md)。完整地址、标识和法律正文只由私有构建输入注入，正式发布缺项失败；公开构建可以明确占位。
- B 路只新建六份批准的 guides：quick-start、bind-wecom、catalog、sales-sop、faq、changelog（文件名见常量）。唯一复制源是 `docs/guides/` 下这六个文件的完整使用者正文，不能把现有部署、模型或可观测性指南整篇带入。复用旧指南时重新编写使用者章节到这六个文件；不得通过 include/import、软链接或资源路径间接发布其他文档。
- 构建暂存目录只接这六份及其显式登记的合成图片；HTML、搜索索引、站点地图、source map 都检查无 spec/plan/ADR/设计/运维/私有文件。只显示工业询价主线；旅游仅为仓库开发者行业包/回归材料。
- www 的四类页面、申请说明、源码链接、品牌声明和 docs/app 入口使用同一私有输入。无账号领取、无公开密码；不扩大 cookie Domain，不读取成员 cookie。生产静态根必须指产物目录。

## Host、旧路径与两段发布

| 请求类别            | 共同规则                                                                                                               | 第 0 步现状 / 第 6 步责任                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| app                 | 唯一非宿主工业租户，public_host 为私有 app Host；新链接取该租户 publicBase                                             | 工业普通登录/回调/引擎已验证；不得修改全局旅游 PUBLIC_BASE_URL                                                     |
| 非宿主 hostOnlyPath | admin.html、chat.html、kf-qr.png；api/chat、stream、sessions、精确 orders、admin、usage、insights 及该函数定义的子路径 | 第 0 步 404；用函数和 HTTP 断言守现状，不能泛化成所有旧 API 都关闭                                                 |
| 仍需显式收口        | try.html、旧支付 POST `/api/orders/:id/pay`；其他未被 profile/Host 规则拒绝的旧管理/演示页                             | try.html 仍 200；支付匿名 404，但有效 Basic 到达订单处理器。C 路代理或代码关闭，覆盖方法、编码、尾斜杠与规范化路径 |
| 工业客户读页        | 订单、报价单及已发客户链接与对应必要静态资源/API                                                                       | 不按 `/api/orders/*` 整段误封；批准读路径保留，同租户订单/版本校验照旧                                             |
| 批准旧工业 Host     | 上游 Host **固定**改为私有 app Host，路径/query/body 原样；不能从外部转发头选租户                                      | 证书与代理至少保留 30 天，回调 POST 不重定向；旧登录 GET 可去新域重登，旧 cookie 不迁域                            |
| 旅游旧 Host         | 仅批准的精确企微回调路径、批准 key 与 GET/POST；其余客户页、支付页、旧后台、API 返回无客户数据的停用说明               | 不用 `/wecom/*` 泛放行，不重定向工业，不转交订单 id/cookie；不修改旅游支付 HTML/测试字节                           |
| 未知 Host / 源站    | 代理拒绝未知 Host，源站不直接公开                                                                                      | 防止单租户回落或转发头绕过；运维本机 healthz 不经旅游公开入口规则                                                  |

旅游仍为 DEFAULT_TENANT_SLUG，保留 env/var/JSON/cursor；不主动清、不做试用清理，原保留期与访客清理继续。先发支持 R6 的镜像且旅游 active，工业业务拨测稳定后固定 R6 回退 tag，再 suspended；此后回退必须支持 R6 与本期 PG 种子/恢复保护。healthz 属于宿主，仅用它不能验工业；第 0 步测试的独立工业链路继续作为拨测依据。保持 05 停沙箱、11/14 数据兼容及既有 rollback guard；回退可恢复工业 public_host/代理并重启，不迁回宿主/env/目录，不回灌已删除消息。

## PG 种子与 trial-reset

唯一契约在 `src/shared/product-surface.ts`。白名单是私有显式列表，精确匹配 tenantId/slug/industrial/standard/isHost=false；空列表、身份冲突、正式数据混入都拒绝。不凭名字、前缀、状态推断，不给 standard 整租户删除权。

- 会话 `trialseed-<批次>-<随机串>`：批次为随机 8 字节的 16 位 hex，后缀随机 12 字节的 24 位 hex。channel=simulator、seed=true、无 channelAccountId；不是 isDemoClassId，不修改它或文件过滤规则。
- 订单 `ord_seed_<同批次>-<随机串>`：同样 24 位随机 hex，长度 50、符合现有 PG 字符/长度约束，复用 originOf 的种子订单识别，删除去关联后仍能识别来源。每批随机、固定清单后重试不重新生成 id；旧订单/链接不复用。
- 当前工业站内报价白名单只认 ord_ 后 24 位 hex（`src/packs/industrial/quotes.ts`）；C 路须补上述精确种子订单格式及对应资源匹配，沿用本租户、关联会话和批准状态校验，不能泛放宽订单路径。server 的报价页仍走既有订单读取，不新建种子客户接口；这个兼容项是种子实现的一部分，本步不改白名单。
- 合成清单 TRIAL_SEED_MANIFEST：询价待补规格、候选匹配、待审批报价、已批准报价、人工接手五类；C 路从当前已发布合成工业产品生成，不存个人信息、不接真实 ERP。订单审批快照、过期规则照常，保留种子不等于永久有效报价；手动重置可重建新批次。
- readPurgeCandidates 必须跳过 state.seed=true；真实 lead/customer/trace 仍为 7 天，独立 trace 清理不改。手动行权/重置仍删除种子和真实试用消息。工作台显示新 id，来源按 seed=true；所有种子客户发送与顾问通知（含报价/接手/写入失败）必须为零，以外发记录器验证，不能只靠 simulator 假定不会通知。

### 批次承载、权限与恢复

复用现有 `audit_log` 的 FORCE RLS、agent_app/platform SELECT+INSERT 权限与 `writeAudit`，不加业务表、不新增删除或插入业务表的授权。事件 action=`trial_reset.checkpoint`、target_type=`trial_reset`、target_id=批次；diff 为 TrialResetCheckpoint。只追加，不 UPDATE/DELETE 审计。目标清单用 conversations.ref 内部 UUID，禁止 raw 客户会话 id、external_userid、消息、凭据进入审计 diff；种子清单可存新生成的合成 id。

1. 停止装载目标租户的 app，全程持目标独占锁；真实共享目录 spill/恢复哨兵、在途发送和待恢复入站未收尾即拒绝，不能清文件绕过。agent_app 经 withTenant 读目标会话 refs 和配置版本，平台编排持久化 planned 检查点；生成的合成 id 与种子版本随计划固定。
2. agent_platform 撤销共享账号会话、按 user-password 现有受控路径改密，校验无其他租户成员关系，追加 revoked。凭据从不进批次记录。原会话清理走 eraseConversation/erase_conversation，逐项追加内部 ref 完成证据；全部清完追加 erased。订单去关联留存，审计、配置、用量、渠道、cursor 不清。
3. agent_app 经 withTenant + writeSeedSessions/现有 repo 写入整批新种子、消息 seq 与订单，在该次写事务追加 seeded；批次重跑先核对版本/id/已提交行，冲突或部分状态不明时拒绝覆盖，不因重复执行生成另一批。跨账号撤销/逐项删除/写种子的全程**不是单事务**。
4. 校验 PG 清单、旧链接失效、新种子引用与零外发守卫后追加 verified，再追加 complete；未完整校验不得 complete。启动读取本租户审计事件，按 audit id 折叠每批，任何非 complete 批次都拒绝开放；扫描完整分页，不能只读最近几十条便认定安全。应用只读此状态，不拿平台凭据。
5. 崩溃在阶段提交与检查点之间：恢复命令保持同一批次/锁，核对真实会话 ref、既有行权审计及种子行再补进度；无法证明完成时失败关闭。阶段幂等、失锁停止，重新启动从 PG 重建 identity map。禁止重放旧 spill/备份复活已清消息；启动检查完成前不启渠道、任务或 HTTP。

这些是 C 路的待实现合同：本步没有设置保留期豁免、通知 guard、启动 batch gate 或 reset CLI。验收必须覆盖每阶段崩溃/重试、锁竞争、失锁、跨租户、旧 cookie/链接、30 天代理兼容与两个外发通道。

## 贯穿用例与合入界面

`src/tenancy/product-surface.selftest.ts` 已贯穿真实 prod boot、普通认证、签名回调/入站/引擎/发送、PG 与隔离；账号 UUID、业务 key、用户 UUID 不同，未使用配置/认证/数据库替身。`src/db/console-members.selftest.ts` 验新增函数的真实 PG/PGlite 权限。A 路接真实设置后扩展这条贯穿链，C 路接真实种子/重置后扩展，最后第 7 步接 14 真用量；整合者持有贯穿测试文件，分路交验收片段，禁止并发改它或塞入成功 stub。

共享冻结文件（DTO、此契约、ADR、0025/journal、package/lock、入口挂载、字体子集）由整合者串行落地；逐路允许修改清单与排他边界见 plan 的本轮交接，不能自行改合同绕过集成失败。
