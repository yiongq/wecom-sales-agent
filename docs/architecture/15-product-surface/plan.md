# 15 · 产品门面 — 执行计划

Status: ready
Revisions: 2026-10-31 owner 对「宿主和定位都按推荐定吗」答「都按推荐」：不换宿主以免迁移 env 账号和文件归属，旅游保留宿主并停用、工业非宿主唯一映射 app；对外专注工业询价，旅游保留为第二个行业包与回归基线且不再加功能。删去宿主迁移、env 迁离、双目录切换、JSON 恢复及回退恢复宿主子任务，补 PG 种子、保留期豁免、两身份可恢复重置、通知守卫、工业拨测与两段上线；保持 ready、0–13 编号和最多三路，第 0 步只记静态结论、不勾完成。
Revisions: 2026-10-31 owner 明确批准「按推荐，15 改 ready」；落实共享试用消息与 7 天保留/手动清理、复用工业租户并保留停用旅游数据、旧旅游支付页不对外且字节不改。当时首步方案由本次不换宿主修订取代，14 R6 依赖保留；并行仍最多三路。
Revisions: 2026-10-31 按 owner 定案重排第 1 批：线上 prod、普通共享试用账号与手动白名单重置；移除成员邀请、渠道网页提交及在线演示的实现步骤，组织/成员/渠道只读；按最多三路划分依赖，用量页最后接 14 R9，补上 prod 与存量迁移/回退核对。原计划未开工，本次允许按新范围重新编号。

对应 [spec.md](./spec.md)。本文件是唯一进度与交接面；R 与验收均指本 spec。产品选择及本次宿主与定位均已定，owner 已点名批准 15 ready；第 0 步动态验证已通过；第 1 步共享契约、最小权限迁移与贯穿骨架已落地，本轮最终门禁与交接见下文。第 2 步及之后尚未实现。

## 开工条件

1. **已 ready**：owner 于 2026-10-31 明确批准，原话「按推荐，15 改 ready」。本次 owner 又对「宿主和定位都按推荐定吗」答「都按推荐」。旅游保持 DEFAULT_TENANT_SLUG 与宿主身份、工业非宿主唯一映射 app；第 0 步验证停用宿主仍能服务工业，走不通即停止报告，不自行换宿主、新建租户或改旧支付页。
2. 01/03/05/10/后台 UX 已加顶部反向标记，主参考阶段 8 已登记；08 的旧旅游字节契约不变，无需给 08 加取代标记。Caddy/VitePress 选型已登记 ADR-006；不改 AGENTS.md。
3. 11 代码与发布边界就绪；本轮基线 f7b2d877 已含 14 R6/R9 与评审修复，第 0 步已验证宿主 suspended、工业 app 正常服务。第 7 步仍须接 R9 真实接口与计数链路，不以本轮宿主验证替代用量验收。后续三路从第 0–1 步通过后的同一合入点分出。

4. 实施阶段可运行四门禁、一次性真实 PG、本地 HTTPS/浏览器及假企微传输端；真实 PG 使用当次专用 pgvector/pgvector:pg17，限时执行并清理，不碰已有容器。
5. 发布前实际域名映射、正式素材、法律正文、账号和渠道配置在私有记录就绪；11/14/15 联合发布须 owner 当次授权。未满足时保留本地结果，不声称上线或 implemented。

## 开工须知

- 先读 AGENTS.md、CLAUDE.md、spec、plan、git log -5 与 11/14 最新交接；代码引用按届时基线重核。
- 锁定套件与 eval/cases.json 一个字节不改；demo 档和四项演示行为保留，系统前缀、SOP、护栏和既有哈希契约不变。旧旅游支付 HTML、字节基线与测试完全不改；线上关闭旅游支付页，工业仍按原报价流程。
- 一名 agent 一个 worktree，最多三路同时工作；共享文件由整合者串行落地，不另起第四路改公共文件。进度只回写本 plan，不创建其他 todo。
- 迁移编号、journal、shared DTO、根 package/lock、挂载入口、router/导航、字体子集、部署入口集中整合；不允许各分支独立发明接口。新增 guard 配 durable 自测，复用 tsx，实施时接入 pnpm test。
- 不读取或输出真实凭据；真实地址、客服码、用户资料和部署材料留仓库外，公开文件只记脱敏结果。所有可能挂住的命令限时，结束后不留进程/容器。

## 第 1 批步骤

- [x] 0. 不换宿主的静态核对与停用宿主动态验证。
  - 静态结论已核实：只有宿主读 env 企微账号，非宿主旧入口受 hostOnlyPath 限制（src/channels/registry.ts:297、src/tenancy/hosts.ts:74）；旅游继续拥有 DEFAULT_TENANT_SLUG、env、var 与 JSON，工业只改 public_host 到 app，不迁账号、不切双目录、不恢复 JSON。非宿主 publicBase 从 public_host 生成新链接（src/tenancy/hosts.ts:61），旧工业域固定上游 Host 改写兼容；旅游旧 Host 只留批准回调。
  - 静态结论已核实：文件后端仅宿主可用，演示类 id 不入 PG（src/store.ts:190、src/store/project.ts:17）；工业种子采用 R10 的 PG 契约，增加保留期豁免与通知守卫。旅游保留不等于冻结，原保留期/访客清理继续；共享 spill、恢复哨兵、锁、05 停沙箱及 11/14 回退约束仍在。
  - 静态风险已记录：旅游仍承担宿主文件、env、配置校验与健康详情，/healthz 不能证明工业可用（src/server.ts:398）；Basic 旧接口不因 suspended 自动关闭，/api/orders/:id/pay 不在 hostOnlyPath 中，仍要代理或代码收口。逐项覆盖 hostRuntime 调用方、告警、调度、文件写入、ADMIN_PASS、登录、拨测；14 R6 的启动/引擎/恢复覆盖以最终实现与验收为准，不能用核心合入代替。
  - 动态已验证：真实 pgvector/pgvector:pg17、prod/db/db 生产 server 路径下，旅游 active 启动，真实轮询 29287ms 内 suspended 生效，停用重启成功；工业普通登录/后台读取/签名回调/引擎回复、旅游停用优先级/跟进阻断、恢复与隔离均通过。镜像切换、代理与 live 仍留第 9–10 步；先发 R6 镜像且旅游 active、稳定后再 suspended，后续回退目标必须支持 R6，保持宿主/env/var 归属。
  - 数据待核实：工业只含合成或试用者消息，既有保留期、行权删除/附件清理路径可用；实际映射、配置、存量正式数据与发布窗口另记，未访问服务器，不把静态审查当成线上证据。
  - 验：上述动态链路通过、有独立工业拨测证据且不串租户才勾完成；R6 不可用、验证失败或发现无法归类的正式数据即停止报告，不清数据绕过。依赖开工条件 1–3；静态核对不构成完成。
- [x] 1. 共享契约与贯穿用例骨架（R1、R4、R6–R10、R12）。
  - 固定只读 DTO、URL、错误码、角色能力、query keys、受限成员读函数及最小授权；14 R9 类型直接引用，不另设计 UsageView。
  - 固定工业询价对外主线、静态产物/内容白名单、平台品牌输入、旧路径分类、工业旧域固定 Host 代理与旅游仅回调放行规则；登记已定静态选型 ADR。
  - 冻结非宿主工业 UUID/slug/pack 白名单、trialseed 批次随机 id、simulator/seed=true/无渠道绑定、订单批次随机 id、合成种子清单；不使用或扩展 isDemoClassId。明确真实消息三类 7 天、readPurgeCandidates 跳过 seed=true、手动一起清、共享告知与种子不外发/不通知。
  - 冻结 trial-reset 的 PG 可恢复批次承载与启动读取契约、agent_app 写入/platform 清理及撤销会话两身份分阶段、全程独占锁、共享 spill/哨兵检查、失败不开放与重启重建 identity map；不承诺单事务、不操作旅游文件。冻结旅游正常到期清理、两段上线与 R6 回退镜像边界。
  - 用不同 accountId/key/userId 建贯穿用例数据；仅模型和外部传输允许替身，不提交占位成功接口。依赖：0；后续分支统一从本步合入点分出。
- [ ] 2. 只读设置与新手状态后端（R4–R7、R9）。
  - 范围：组织、成员、渠道、onboarding 读模块；唯一必要权限迁移为受限成员投影函数，编号与 14 协调。没有邀请/渠道申请表或写接口。
  - 验：验收 3–4、5 的引导部分；真实 PG 检查会话、角色、租户、RLS 与最小授权；读取已发布品牌、装载状态和实际入站，凭据不进 DTO。
  - 依赖：1。可与 3、4 并行；公共 app 挂载由整合者串行合入。
- [ ] 3. 官网、文档与公开文案（R1–R3、R11）。
  - 范围：site、docs-site、白名单构建、六类 guides、双语 README 与品牌授权声明；官网、文档、README 主线只讲工业询价，旅游仅留开发者行业包/回归说明，不入对外主线；正式素材、实际链接和法律正文仅接私有构建输入。
  - 验：验收 1、2 的 README 部分、10 的内容部分；截图全合成，无 JS 可读，内链/搜索/错误/移动端可用，产物不含设计与运维资料，缺正式必填材料挡发布。
  - 依赖：1。可与 2、4 或后续 5、6 并行，但总数不超过三路；根依赖与锁文件交整合者处理。
- [ ] 4. 试用公司、PG 合成种子与平台重置（R10）。
  - 范围：复用非宿主工业 standard 租户与工业询价包，CLI 配唯一共享 agent、真实消息三类 7 天保留与共享提示；种子按 trialseed 批次随机 id、simulator、seed=true、无渠道账号写 PG，订单用批次随机 id。readPurgeCandidates 跳过 seed=true；增加 seed 顾问通知守卫，含失败路径。
  - trial-reset 只接受白名单非宿主工业租户，只动 PG；agent_app 读写种子、platform 行权删除/撤销会话，复用既有 repo 与受控授权，不给 app 新 DELETE 权限。停应用、持全程独占锁、检查共享 spill/恢复哨兵，以可恢复批次编排两身份阶段，不能宣称单事务；失败不开放，重启前一致性检查并重新预加载 identity map。
  - 验：验收 2 的 agent 边界、6；共享告知、真实消息 7 天清理、种子过期仍展示、手动两类一起清并重建；错 UUID/slug/pack、宿主目标、正式数据混入或有 spill 时零修改。覆盖两身份阶段故障/重试、锁竞争、旧 cookie/合成链接失效、行权删除与保留订单，不复活已清消息；外发记录器确认种子客户发送及顾问群通知均为零、真实试用正常。旅游及其他租户不受重置影响，既有审计/用量/渠道配置不变，无定时重置。
  - 依赖：1 与第 0 步已验证的数据边界。可与 2、3 并行；普通账号凭据只在受控环境建立。
- [ ] 5. 品牌、登录、只读设置与引导前端（R4–R7、R9、R11）。
  - 范围：console 页面与查询、登录主标题、首帧标题、外壳标题及导航；只接第 2 步真实接口，不放邀请、凭据输入或组织保存表单。
  - 验：验收 2–4、5 的引导部分；风格 A、加载/空/错误、401/403 清缓存、深链接、窄屏/键盘、普通 agent 权限；demo 功能保留，线上 prod 无体验入口。
  - 依赖：2；可在第 2 步完成后接替该路，与仍运行的 3、4 并行。此步不提前做用量页。
- [ ] 6. prod 路径收口与发布配置（R10–R12）。
  - 范围：Caddy 静态/代理模板、非宿主 app 的旧路径与 /api/orders/:id/pay 等非 hostOnlyPath 接口收口；旅游旧 Host 仅放批准企微回调，其余客户页/支付页/API 给停用说明，不重定向工业。旧工业域上游 Host 固定改 app，保留路径/query/请求体，回调 POST 不重定向，兼容至少 30 天。
  - 同步 prod 必需配置、05 长期停用、两段上线/回退 runbook 与独立工业登录或收发拨测；保留旅游宿主/env/var、配置校验与健康依赖，不把 /healthz 当工业可用证据。先发 R6 镜像旅游 active，稳定后 suspended，此后回退目标须支持 R6；不操作生产。
  - 验：验收 7–8 的本机部分；prod 启动与越权 FLAG 拒绝，web_channel 封顶，工业客户读接口/历史链接可用；旅游旧 Host 与路径变体均按白名单关闭，旧旅游支付字节、demo 字节及测试保持。env 改名后部署不复活沙箱，镜像回退不能误当配置回退，旅游原保留期/访客清理照常。
  - 依赖：4 与第 0 步停用宿主/工业 app 动态验证；可接替第 4 步所在路，与 3、5 并行。公共文件变更按契约集中合入。
- [ ] 7. 最后接入用量页（R8，依赖 14 R9）。
  - 范围：settings/usage 页面、图表/可读表格、状态和刷新策略，导航最终收口；直接消费真实 UsageView。
  - 验：验收 5 的用量部分；真实计数、null/0、金额单位、月界、空月、陈旧数据、403，普通 agent 不提权；不能以静态 fixture 当成跨阶段完成证据。
  - 依赖：2–6 全部合入、14 R9 与计数链路通过其验收。本期最后一个实现步骤，之后只做验证、修复与发布。
- [ ] 8. 真实链路贯穿、评审与联合回归（R12）。
  - 执行 spec 的浏览器 → 普通认证 → 只读设置 → CLI/真实 PG → 重启 → 签名回调/拉取 → inbox/引擎/发送 → 会话/引导/14 用量整条链；另验证共享告知、同租户试用消息可见、真实消息 7 天保留、种子跳过保留期清理、两身份分阶段重置/故障恢复与 identity map 一致，手动同时清种子/试用消息且不触碰旅游或其他正式租户；外发记录器确认种子无客户发送和顾问通知。
  - 验：验收 9；宿主 suspended 时工业登录/收发拨测独立通过；失败/重试/失权与故意错配 id/key 可被整体用例发现；实际授权、渠道服务、计数均无 mock。记录审查结论与修复，11/14/15 合入后完整四门禁、严格租户与真实 PG 用例通过。
  - 依赖：7、11/14 相关链路就绪。整合验证串行，不与改公共文件并行。
- [ ] 9. 本机镜像、域名切换与回退演练（R12）。
  - 一次性环境演练三个新 Host 与旧兼容入口、正式 cookie、工业旧回调/报价及已发方案链接；核验固定 Host 改写保留路径/query/请求体、回调 POST 不重定向，旅游只放批准回调、其余停用且不导向工业。演练先发 R6 镜像旅游 active、稳定后 suspended；模拟配置、证书、静态资源、服务切换失败。
  - 验：验收 10–11 的本机部分；保持 prod 与沙箱停用，旅游一旦停用不自动恢复 active、仍按原保留期/访客规则清理；必要时恢复工业 public_host 与代理并重启，宿主/env/var 不需迁回。拒绝不支持 R6 或本期种子/批次恢复保护的回退镜像，保留最新 PG、spill、cursor、幂等账本、批次与审计，不整库回灌复活已清消息；11/14 数据兼容和既有 rollback guard 全部执行，不能删旧租户绕过保护。回退后工业业务拨测仍通过。
  - 依赖：8；实际映射留私有 runbook，公开只记录可复现步骤与结果。
- [ ] 10. 与 11、14 联合上线（owner 当次授权）。
  - 发布前核对真实部署配置、旧两个租户处置、试用账号发放边界、品牌/法律材料和可回退版本；按 R12 两段顺序执行：先发支持完整 R6 的镜像、旅游 active，工业业务拨测稳定后固定 R6 回退镜像，再设旅游 suspended；不迁宿主/env/var，不把文档批准当服务器操作授权。
  - 真手机扫码客服走回调、一问一答、人工接手，普通账号登录与独立工业拨测、工业客户历史链接、旅游回调白名单/停用响应与用量实测；确认无演示入口、无沙箱服务，旧地址兼容至少 30 天并有后续观察责任人。
  - 验：验收 10–11 的 live 部分。没有当次授权则停在本步，交接本机证据；不能勾上线或 implemented。
  - 依赖：9、11/14 各自验收及当次上线授权。
- [ ] 11. 对照当前全部验收标准逐条验证并记录。
  - 将验收 1–12 的命令、结果、人工/live 证据与限制记入本 plan；四门禁完整执行，未执行或失败不得标通过，兼容观察安排明确。
  - 依赖：10。
- [ ] 12. 清理临时探针、测试与运行资源。
  - 保留 durable 自测，清理当次容器、浏览器、后台进程和临时环境；复核锁定文件、公开边界与最终 diff。开 PR 前按 AGENTS.md 扫完整 PR 范围，提交与合并由协调者负责。
  - 依赖：11。
- [ ] 13. owner 确认后翻 Status: implemented。
  - 全部验收有记录且 owner 明确确认后再修改状态，不自动选择下一份 spec。
  - 依赖：12。

## 共享契约与最多三路

| 两端                      | 先冻结的契约                                                                                                        | 合入后的共同验收                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2 后端 ↔ 5 前端           | R4 DTO/URL/query keys/401/403；成员函数授权；组织已发布与待生效、渠道配置与运行、引导事实来源                       | 真成员登录后从真 API 读到 CLI/启动后的数据，失权即拒绝；无网页写路径               |
| 3 静态站 ↔ 5/6 登录与部署 | 工业询价主线、www/app/docs 职责、普通登录路由、私有链接/素材/法律输入、公开构建白名单                               | 最终产物点击链走通、不跨域共享 cookie，站点搜索无设计资料                          |
| 4 试用 ↔ 6/8/9 发布与验收 | 非宿主工业白名单、PG 批次/id/seed 契约、两身份阶段与锁/spill/失败不开放、真实消息 7 天及种子豁免、共享告知/通知守卫 | 普通登录与扫码入库，PG 重置可恢复且种子不外发/通知；旅游及另一正式租户不受重置影响 |
| 14 ↔ 7/8 用量             | R9 原始 UsageView、权限、null/0、时间/费用单位与计数时点                                                            | 真实引擎回复使 API 与 UI 同时改变，agent 的 403 保持                               |
| 6 ↔ 9/10 迁移与发布       | prod/05 停沙箱、旅游宿主不变、旧 Host 路径规则、两段上线、工业拨测、11/14 与 R6 回退限制                            | 真实镜像切换失败能按批准路径回退，不误开 demo、不重复发送、不丢新消息              |

依赖图：`0 → 1 → {2,3,4}`；`2 → 5`、`4 → 6`；`{2,3,4,5,6, spec 14 R9} → 7 → 8 → 9 → 10 → 11 → 12 → 13`。

具体三路：A 为 `2 → 5`（只读后端后接 console），B 为 `3`（官网/文档），C 为 `4 → 6`（试用后接 prod 部署收口）。某路完成才能开新的工作，不把整合者计作额外第四路；共享文件合入串行。第 7 步等三路与 14 完成，用量接入后才整体贯穿与发布。

共 **14 步（0–13）**，其中 **6 个实现步骤（2–7）**；最多三路，邀请与渠道网页提交没有本期步骤、迁移或验收。真实 PG、外部验收与上线窗口仍须串行协调，不以三路并行代替跨模块集成。

## 实施与验证记录

### 首版起草（2026-10-31，历史记录）

- 首版按 `192ba6c7` 核对，曾提出演示入口、成员邀请和渠道申请；该范围已由本次修订替代，没有实施代码。
- 当时 format:check（973 文件）、lint、typecheck 通过；完整 test 在 600 秒后退出 142，最后记录 OUTBOUND SELFTEST 的 126 项通过，不代表完整 test 通过。没有运行真实 PG 或生产验证。
- 首版后来由协调者提交为 `2f243c59`；该历史验证不充当本轮或未来实现的验收证据。

### owner 十项定案后的修订（2026-10-31，历史记录）

- 已读取仓库规则、原任务和两份草案，并核对 profile、启动配置、Host、文件种子、账号权限、渠道、支付页面、05 长期停用、deploy.sh 与回滚保护源码；未读取实际 env、未访问服务器。
- 已按第 1 批重写范围、接口、验收与步骤；保留全部十项选项和 owner 结论，用独立「需要确认的问题」记录新发现的三个实施约束。Status 仍为 draft。
- 本轮验证：`pnpm -s format:check` 通过（973 个文件）；两份文档相对链接与代码引用位置有效，`git diff --check` 通过，未命中本机路径、长企微标识或实际地址。按 owner 指示未跑完整 pnpm test，也未运行 lint/typecheck/真实 PG/浏览器/live；仅两份文档有改动，未提交。

### owner 补充三条并批准 ready（2026-10-31，历史记录）

- 已落实试用消息/7 天保留与清理、工业复用和旅游停用保留、旅游支付字节不变；已补 01/03/05/10/后台 UX 顶部反向标记与主参考阶段 8 ready 记录。未修改关联 spec 正文或 08。
- 本轮验证：`pnpm -s format:check` 通过（973 个文件），`git diff --check` 通过；核对五份关联 spec 只有顶部新增行、正文逐字不变，主参考仅在阶段 8 候选前新增一条；新增链接及公开边界检查通过。按要求未跑完整测试、未提交，未执行第 0 步部署可行性演练或服务器操作。

### 不换宿主与工业询价定位修订（2026-10-31）

- owner 对「宿主和定位都按推荐定吗」答「都按推荐」；本次据此修订 15 spec/plan 与主参考，保留 ready、14 步及三路分组。01/05/10 顶部反向标记未涉及换宿主，保持原样；旅游支付字节约束不变。
- 前两轮只读静态核对与本轮结论已写入第 0 步和 R10/R12；当前基线 5d5fa3b2 的 14 核心已有合入，完整 R6 启动/引擎验收仍待完成。未跑容器、未访问服务器/真实 env，实际数据归类和动态可行性未核实，第 0 步不勾完成。
- 实现量变化：删除宿主/env/双目录/JSON 迁移及其回退子任务；增加 PG 种子写入、两身份可恢复重置、种子保留期豁免/通知守卫与外发记录器验收，工业拨测和两段上线仍需做。既有 repo/行权能力可复用，不把新增持久化与恢复工作当成零成本。
- 本轮仅文档；`pnpm -s format:check` 通过（975 个文件），`git diff --check` 通过。已全文核对「宿主」，无工业当宿主的残留要求；核对 ready、14 个未勾步骤、原依赖分组、01/05/10 原样及新增内容公开边界。首次格式检查发现两份文档格式问题，限定格式化后复查通过；未跑完整 test、容器或服务器操作，未提交，由协调者提交。

## Open

- 无产品决定待确认；第 0 步已在包含完整 R6 的基线上通过真实 PG/生产启动验证，不换宿主可继续。第 2 步及以后尚未实现，真实代理、镜像与 live 证据未取得。
- 14 R6/R9 已在当前基线；第 7 步须接真实 UsageView 与计数链路，联合发布不能用模型/传输替身替代 live。
- 工业实际数据归类、Host/配置与存量状态未核实，发布窗口确认；真实映射、法律正文、正式素材和上线当次授权仍是前置，真实值另记。PG 重置复用追加 audit_log 的批次承载、启动读取与阶段恢复契约已在第 1 步冻结，待 C 路实现，不得宣称跨身份单事务。
- 本轮按任务只跑新增/受影响套件与指定门禁，不跑完整 pnpm test；全量由 CI 承担，历史超时不算通过。

## 已定

- 十项 owner 结论按 spec 保留；线上 prod，源码 demo 和 AGENTS.md 不改，沙箱长期停用。
- 一个普通 agent 共享试用账号，成员与渠道本期只读、变更继续 CLI；真实试用消息 lead/customer/trace 均为 7 天，seed=true 会话不参与保留期清理，手动两类一起清并重建，页面或欢迎语提示共享环境、勿发个人信息。
- 不换宿主：旅游保持 DEFAULT_TENANT_SLUG/宿主/env/var；工业为白名单非宿主 standard 试用租户、public_host 改到 app 且唯一映射。种子采用 trialseed 批次随机 id、simulator、seed=true、无渠道绑定、批次随机订单 id，不用/不扩展 isDemoClassId；只动 PG，两身份分阶段可恢复、独占锁/spill 检查/失败不开放，种子不发客户也不进顾问群。
- 旅游最终 suspended，不主动清、不做试用清理，原保留期与访客清理继续；先发 R6 镜像保持 active，稳定后再停用，此后回退目标必须支持 R6。旅游仍承担宿主依赖，故障可影响工业；上线必须独立验证工业业务，不能只看 /healthz。彻底下线旅游时另写迁宿主 spec。
- 对外官网、文档、双语 README 主线专注工业询价；平台保持多行业，旅游作为第二个行业包与回归基线保留代码/回归、不新增功能。owner 2026-10-31 对「宿主和定位都按推荐定吗」原话「都按推荐」。
- 不改旧旅游支付页字节约束、08 或自测基线；旅游旧 Host 仅放批准回调，其余客户页/API 给停用说明、不转工业。旧工业域固定上游 Host 改写为 app，保留路径/query/请求体至少 30 天、回调 POST 不重定向；app 非 hostOnlyPath 的旧支付接口另行收口。
- 官网 Caddy、文档 VitePress、品牌素材私有、仓库不改名；统一登录与第 2 批网页写能力另写 spec。
- owner 2026-10-31 原话「按推荐，15 改 ready」，本 spec/plan 保持 ready；用量最后消费 14 R9，11/14/15 联合上线仍需 owner 当次授权。

## 交接记录

### 交接（2026-10-31，首版起草，历史）

- 已完成：首版 spec/plan；当时没有实现代码，十项选择待定，完整 test 未完成。
- 下一步原为 owner 定案；现已收到决定，该交接由下条取代，不再据此恢复旧范围。

### 交接（2026-10-31，owner 十项定案后修订，历史）

- 已完成：第 1 批草案与 14 步计划重排、prod 源码核对、三个新约束、共享契约及三路依赖。
- 半成品状态：没有实施代码；仅本目录 spec.md、plan.md 有修改，未提交。格式验证结果见本轮记录。
- 阻塞：待确认 1–3 与 ready 尚未完成；14 R9、上线私有材料与当次授权未就绪。
- 下一步：协调者审阅并提交文档；owner 定新约束后在 spec 留修订记录，批准 ready 时补关联标注，从第 0 步开工。本轮不实施、不部署。

### 交接（2026-10-31，owner 批准 15 ready，历史）

- 已完成：三条决定落入 R10/R12、不变量与验收；spec/plan 改 ready，新增两条 spec Revisions（决定与原话授权），补反向标记和阶段 8 记录，保留最多三路分组。
- 半成品状态：只有文档改动，尚无实施代码，步骤 0–13 全部未开始；格式检查结果见本轮验证记录，未提交，由协调者提交。
- 阻塞：无产品决定待确认；当时的 R6/R9、首步部署验证及上线材料/当次授权尚未就绪；首步方案已由下条取代。
- 下一步原为协调者提交与第 0 步验证；本次按下条不换宿主方案继续，不恢复旧迁移子任务。

### 交接（2026-10-31，不换宿主、对外专注工业询价，历史）

- 已完成：owner 定案与连带项落入 15 spec/plan、主参考；第 0 步静态结论已记录，删去宿主迁移、env 迁离、双目录切换、JSON 恢复及回退恢复宿主子任务，新增 PG 种子/重置/保留期与通知保护、两段上线及业务拨测契约。
- 半成品状态：仅文档改动，无实现代码；步骤 0–13 均未勾，第 0 步只完成静态部分。检查结果见本轮实施记录，不跑完整 test、不提交，提交由协调者完成。
- 阻塞：无产品决定待确认；完整 14 R6 合入及第 0 步动态验证、14 R9 接入验收、实际数据归类和发布材料/当次授权尚待完成。
- 下一步：协调者审阅提交；待完整 R6 合入，在一次性环境验证宿主 suspended、工业 app 正常服务，通过第 0–1 步后按原 A（2→5）、B（3）、C（4→6）三路推进；7 最后接用量，再串行贯穿/演练，按 R12 两段联合上线。

### 第 0–1 步实施记录（2026-10-31）

- 基线 f7b2d877（含 14 R6/R9 与评审修复），新增 product-surface 自测并串入 package.json；真实 pgvector/pgvector:pg17、prod/db/db 完整 server 启动，普通 HTTP 登录与签名回调，只有模型/企微外部传输替身。第 0 步六项通过，30 秒生产轮询最终复跑实测 29287ms，未手动刷新 limits。
- 工业普通 agent 登录、后台会话读取、真实回调/inbox/引擎回复通过；旅游 suspended 后登录失效、消息入库、固定句跨重启只发一次，紧急与撤回同意优先、到期跟进 cancelled/tenant_limit 且零外发；恢复 active 后旅游恢复，两向消息/cookie 隔离通过。隐私说明是既有行权前置，夹具经 PG 发布并由真实 boot 读取，没有替换隐私状态。
- env 账号只归旅游，工业 DB 账号的 UUID/key/userId 各不同。hostOnlyPath 代表路径均 404；/try.html 仍 200，旧支付 POST 匿名 404、有效 Basic 仍进入订单处理器，保留第 6 步显式收口要求。
- 第 1 步冻结 `src/shared/console-api.ts` 的只读 DTO/URL/角色/错误/query keys（直接引用 UsageView），`src/shared/product-surface.ts` 的公开白名单/私有品牌输入/工业白名单/种子清单与批次阶段。Host 分类、PG 写入/行权与两身份恢复/启动读取见 `contracts.md`；Caddy/VitePress 见 ADR-006。没有第 2 步及之后的 handler、页面、CLI 或假成功接口。
- 0025 成员投影与 journal 接在 0024 后：仅 agent_app 执行，验证真实 token hash、当前权限/有效期/standard/启停；返回五字段，未扩大登录表直读权限。新增 console-members 自测在 PGlite 与真实 PG 均通过，含 owner/admin、低权限、沙箱、跨租户、过期/撤销/降权、临时表遮蔽与 FORCE RLS；两份新增套件已串入 test 末尾。
- PG 批次冻结为追加 audit_log 检查点（内部 ref + 合成 id），全程锁与 spill/哨兵检查，agent_platform 撤销会话/改密/逐项行权，agent_app 写种子，未完成批次启动拒绝；不是跨身份单事务。实际 guard/CLI 留第 4 步，现有工业报价白名单须由 C 路精确兼容种子订单格式，不能扩大客户授权。
- 动态复现：为本次一次性 PG 设置 PG_TEST_URL 后执行 `pnpm exec tsx src/tenancy/product-surface.selftest.ts`；输出六项 PASS 与 PRODUCT SURFACE SELFTEST PASS。成员投影执行 `pnpm exec tsx src/db/console-members.selftest.ts`，PGlite/real-pg 均 PASS。生产 timer 未替换，数据库、认证、渠道、引擎与发送账本真实，模型和企微网络为外部替身。
- 四哈希断言通过：prompt `cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900`；tools `59e071568f5dd730398ac4b848a9ccdccc40633d3ae6698e0c1a7840f6793cdd`；prefix `6630127f79d7854ec7d3abe96f1eae65e7acbed09f12a5b1bc22b539fd17e19e`；sop `1f850038290b202f66573695faee972bd0b03a3da9ec3e62e665ff5fa6b81ba3`。锁定八文件与 spec 对 HEAD 字节一致。
- 文件/PGlite v2 最终复跑：分别执行 `CONFIG_SOURCE=file LLM_MOCK=1 pnpm exec tsx eval/run.ts` 与另加 `CONFIG_TEST_DB=pglite` 的同命令；各 923/923、9015 断言、快照 0 差异，DB 22 个请求的前缀与 healthz 0 差异。完整 pnpm test 未运行。
- 已通过 `pnpm -s format:check`（990 文件）、lint、typecheck，改前/改后 test:locked，以及 `pnpm exec tsx scripts/ci-shard.ts --check 4`（235 units、27 strict suites）与 `git diff --check`。首次 lint/类型检查指出新契约数组需不可变声明、测试 SQL 结果需明确投影类型，修正后通过，没有修改门禁或既有生产逻辑。数据库总套件随后指出新函数未列入既有权限白名单；已在 `src/db/db.selftest.ts` 精确登记成员函数及其签名的 app 专用权限，未知函数默认拒绝保持，重跑结果见最终交接。
- 按改动路径及新增导出名检索命中超过 15 套，采用通用约定的路径命中集：`scripts/ci-shard.selftest.ts`；`console/src/session.selftest.ts`、`console/src/parts/errors.selftest.ts`、`console/src/shell/shell.selftest.ts`；`src/ops/ops.selftest.ts`；`src/console-api/{console,attachments,traces}.selftest.ts`；`src/payment/legacy-bytes.selftest.ts`；`src/web/web.selftest.ts`；`src/core/link-bytes.selftest.ts`；`src/db/{attachments,db,rollback-guard}.selftest.ts`；`src/config/{gate,retrieval-kb}.selftest.ts`；`src/tenancy/events-channels.selftest.ts`；`src/{order-readers,quote-actions}.selftest.ts`；`src/tenancy/sandbox/{refund-seed,http}.selftest.ts`。共 21 套 ts；同时补跑路径命中的 10 套 tsx：`console/src/{audit/audit,conversations/conversations,conversations/pack-cards,conversations/workbench,fields/fields,overview/overview,pages/login,parts/popupRegion,sop/sop,traces/traces}.selftest.tsx`。合计 31 套既有受影响测试，各自保留 package 的时钟/tsconfig 参数，真实 PG 部分串行；本轮新增两套另跑。最终结果与清理见下方交接，未命中的全量留 CI。
- 实际线上配置与数据盘点仍留发布窗口，本机通过不代表 live。

### 三路派活文件边界（第 0–1 步合入后生效）

以下是排他修改清单；其他文件只读。新文件可在列出的专属目录内按职责拆分，同名自测归同一路；公共入口变更由分路提交补丁说明，整合者串行落地。三路统一读取 `contracts.md` 和 shared 常量，不各自改合同；不得提前做第 7 步用量页。

- **A：2 → 5**。可改：新建 `src/console-api/settings.ts`、`src/console-api/settings.selftest.ts`、`src/db/repo/console-settings.ts` 及其自测；新建 `console/src/settings/**`；`console/src/overview/**`（引导）、`console/src/pages/LoginPage.tsx`、`console/src/pages/login.selftest.tsx`、`console/src/LoginForm.tsx`、`console/index.html`（品牌标题）。不能改 B/C 专属文件、静态站/部署/种子/通知/保留期，也不能改下列公共文件。router、导航与 app 挂载提供待整合补丁；用真实 API，不做网页写入。
- **B：3**。可改：新建 `site/**`、`docs-site/**`、`scripts/product-sites/**`；只新建 `docs/guides/quick-start.md`、`bind-wecom.md`、`catalog.md`、`sales-sop.md`、`faq.md`、`changelog.md`；`README.md`、`README.zh-CN.md`、新建 `BRAND.md`。不能改 console、src 业务模块、部署、其他指南/架构文档或公共文件；依赖/构建命令/锁文件提出精确变更交整合者，不能复制整个 docs。
- **C：4 → 6**。可改：新建 `src/cli/trial-reset.ts` 及其自测、`src/tenancy/trial/**`、`src/db/repo/trial-reset.ts` 及其自测；`src/db/repo/retention.ts`、`src/privacy/privacy.selftest.ts`、`src/notify/handoff.ts`、`src/notify/notify.selftest.ts`、`src/packs/industrial/quotes.ts`、`src/industrial-quotes.selftest.ts`、`src/site-links.selftest.ts`（种子订单精确匹配）；新建 `deploy/product-surface/**`（Caddy/发布模板）、`docs/guides/product-surface-deploy.md`（非公开构建白名单）。不能改 A/B 文件、旅游包/支付页/字节基线、登录表授权或其他租户数据。启动批次 gate、现有发送链与部署入口若需接线，交整合者串行修改，禁止给 app 增加 DELETE 权限。
- **整合者独占，A/B/C 均不直接改**：`src/shared/**`、`drizzle/**`、根及 console 的 package/lock/workspace 配置、`src/server.ts`、`src/boot.ts`、`src/config/source.ts`、`src/console-api/app.ts`、`src/store.ts`、`src/adapters/wecom.ts`、`src/quota/**`、`console/src/router.tsx`、`console/src/shell/**`、`console/src/api.ts`、`console/src/fonts/**`、已有 `deploy/**` 与 `deploy.sh`、本 spec/plan/contracts/ADR、`src/tenancy/product-surface.selftest.ts`、`src/db/console-members.selftest.ts`、`src/db/db.selftest.ts`。分路提交真实验收片段，由整合者扩展贯穿测试；不得复制占位成功接口。
- **所有路都不能改**：AGENTS.md/CLAUDE.md、锁定八文件、旧旅游支付 HTML/字节基线；不能接触服务器、真实 env/凭据/客户资料。独立 worktree、最多三路；整合者不另开第四路并发改公共文件。

### 本轮最终交接（2026-10-31）

- 已完成并勾选第 0–1 步：六项真实 PG/生产启动验证、新增两套及 31 套既有受影响自测全部通过；数据库总套件同步精确权限白名单后 1346 项通过，回退保护 702 项通过。全部指定门禁与文件/PGlite v2 通过，四哈希不变。第 2–13 步未开始，Status 保持 ready；spec 原样，未提交，由协调者提交并给三路同一合入点。
- 资源：本次 wsa15-step0-pg 容器及匿名卷已删除，docker ps -a 与 volume ls 的精确过滤结果为空；生产测试子进程已由 finally 等待退出，var 下本次运行目录为空。全机 ps 被沙箱拒绝，未声称完成全局进程核验；未碰其他容器、服务器、真实 env 或真实模型，未开浏览器。
- 下一步：按上表 A（2→5）、B（3）、C（4→6）派活；步骤数仍为 14（0–13）、实现步骤仍为 6（2–7）、并行分组不变。共享入口由整合者串行处理，7 最后接用量，8–10 再贯穿/镜像/经授权上线。
- 需要确认的问题：无。真实映射、材料和上线授权继续是发布前置，不是本轮静态合同的未定产品选择。
