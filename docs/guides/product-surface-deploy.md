# 产品门面发布与试用维护

本文是平台运维手册，不在公开文档站六份内容白名单内。实际地址、品牌、法律正文、账号及发布记录另记。以下是待授权发布时执行的流程，本地验收不代表已经上线。

## 发布输入与职责

保持旅游为 `DEFAULT_TENANT_SLUG`，`PUBLIC_BASE_URL`、env 企微账号、原 var、JSON、cursor 仍归旅游；工业 standard 保持非宿主，唯一 `public_host` 指向 app。修改 Host 后必须重启。不能改全局基地址来把工业变成宿主，也不能同时跑两个进程拉同一客服。

app 使用分服务 env 中的 `agent_app`，不得带 platform/owner 凭据；`DEPLOY_PROFILE=prod`、`APP_ROLE=host`、`CONFIG_SOURCE=db`、`SESSION_STORE=db`，非空 `ADMIN_PASS` 仍是启动前置，不作为共享账号密码。真实模型 key、渠道密钥环、迁移、已发布配置与可写目录均须就绪；七个受限 `FLAG_*` 全 off，`web_channel` 不解禁。线上不设置 `LLM_MOCK`，发布闸 required 时不能缺真实 key。必要 DB 配置缺失由既有启动校验拒绝。

`deploy/product-surface/Caddyfile` 全部地址为私有占位。正式应用前填写 www/docs/app/旧工业/旅游五个不同 Host、批准的旅游渠道 key、仅本机可达的应用上游，以及 www/docs 的独立构建产物根；执行 `caddy adapt --validate` 后检查生成配置并平滑重载。静态根不能指仓库或 docs 源码。应用端口只绑定回环地址；未知 Host 在代理拒绝。新域重新登录，cookie 不扩 Domain。

旧工业 Host 的代理固定上游 Host 为 app，不信任客户端 Forwarded/X-Forwarded-Host；不 rewrite、不重定向回调 POST，保留路径、query、请求体及必要资源至少 30 天，安排负责人跟踪旧链接使用情况，再决定延长。应用显式关闭 prod 非宿主的旧演示页、旧管理接口与 `/api/orders/:id/pay`，有效 Basic 也不能绕过；工业 `/quote/:id`、`/api/quotes/:id`、必要订单读接口与成员操作仍按原鉴权/租户/审批/版本规则工作。

旅游旧 Host 只准模板中的精确 env 回调和批准 key 的库内回调 GET/POST，未使用的规则应删除，新增批准 key 逐条登记。其他请求返回无客户数据的 410，不跳工业、不转发订单 id/cookie。大小写、编码、尾斜杠等变体不额外放行。[Caddy path 匹配会规范化路径](https://caddyserver.com/docs/caddyfile/matchers)，模板因此按原始 URI 的路径部分严格比较。源站 `/healthz` 仅供内网运维，不经过旅游公开入口。

## 两段上线与长期停用沙箱

1. 取得 owner 对本次操作的授权，核对 11/14/15 验收、备份及异地副本可恢复性、私有发布输入、法律正文和回退 tag。先关闭对外试用，排空在途发送与入站恢复。
2. 按 05 长期停用：删除本实例 sandbox 容器及其匿名卷，将 `.env.sandbox` 改为 `.env.sandbox.off`；持沙箱进程锁执行既有 `sandbox purge --all`。从代理摘沙箱站点，去掉宿主体验链接与旧拨测；长期不用的体验客服在平台停用。清理失败继续关闭入口，不删除 spill/恢复哨兵来伪造成功。
3. `deploy.sh` 的只读预检会拒绝 prod 仍有 `.env.sandbox` 或遗留 sandbox 容器（包括停止状态）。env 改名后部署不会进入沙箱启动分支；compose 默认 profile 不启动 sandbox。不要手动加 `--profile sandbox` 或把 off 文件改回原名。源码 demo 档仍可按 05 开沙箱。
4. **先发支持完整 14 R6、PG 种子豁免、种子外发守卫和未完成批次启动检查的镜像，旅游保持 active。** 验工业 app 普通登录、真实收发、两租户渠道和历史客户链接。固定这个验证通过的回退 tag。
5. 稳定后才把旅游改为 suspended，验证 30 秒内普通登录失效、固定停用回复与紧急/撤回优先级、重启仍可装载宿主且工业继续服务。旅游原保留期和访客清理照常，到期仍删除；不主动清旅游，不拿旅游做试用重置。
6. 按下节准备工业试用、7 天保留和 PG 种子，再发布 www/docs 静态产物与 app 新域。确认共享提示已接入、无线上演示入口、无沙箱进程，验报价读接口、用量、隔离和独立工业拨测后放量。

## 共享试用账号与签收清单

先通过既有 `user-create` CLI 创建唯一普通 agent，仅属于工业试用公司；独立 owner 不对外发放。用 `tenant-retention --tenant <slug> --lead 7 --customer 7 --trace 7` 设置三类保留期。不绑定真实 ERP，不把正式客户数据、凭据或其他租户成员混入。账号和客服码私下提供。

后台在试用前显著显示以下文案（由 console 路集成）：

> 这是共享试用环境，会话可能被其他试用者看到，请勿发送个人信息。试用消息按 7 天保留设置清理；平台手动重置也会清理试用消息。合成示例会保留到下一次重置。

欢迎语可另补同样说明，须走现有渠道命令，不改系统提示词前缀。真实微信消息仍按原隐私说明和同意流程处理，不能称作全部合成；共享 agent 可接手/回复/处理订单，但不能改话术、产品或读设置，不称为只读。

停 app 后从真实共享挂载目录核对 spill/恢复哨兵；锁、在途发送、未结束入站任何一项未收尾均不能开始重置。使用 app repo `trialConversations` 获取内部 UUID refs，`trialOrderIds` 获取订单清单，`trialBaseline` 获取当前已发布合成工业配置的 hash；经过人工盘点确认只有合成材料和试用消息后，在仓库外保存签收 JSON。命令不会按名字、前缀或模型判断正式数据，也不提供一键自动签收。未签收的新会话/订单导致零修改拒绝。

```json
{
  "allowlist": [
    {
      "tenantId": "00000000-0000-4000-8000-000000000015",
      "slug": "synthetic-trial",
      "packId": "industrial",
      "kind": "standard",
      "isHost": false
    }
  ],
  "sharedEmail": "shared@trial.example.test",
  "reviewedConversationRefs": [],
  "reviewedOrderIds": [],
  "baselineHash": "<trialBaseline 返回的 64 位 hash>"
}
```

上例仅解释结构，不能直接上线使用。白名单逐项绑定 UUID/slug/pack/kind/非宿主；拒绝宿主和沙箱。签收文件与共享目录需由受控平台操作者提供，不能允许试用者上传或自行选择。配置 hash 包括发布版、有效产品及快照版本，产品需标为合成材料。批次开始后不允许换配置来继续重置。

## 重置、故障与恢复

仅在独立的受控运维进程中注入 `DATABASE_URL=agent_app` 与 `DATABASE_PLATFORM_URL=agent_platform`，两者必须指向同一端点和数据库；同时注入真实宿主 `DEFAULT_TENANT_SLUG`。不要把这份双身份 env 放进 app 服务。挂载应用实际共享 var 到命令的 `--var`，不可用空临时目录代替。口令从 stdin 或仅显示一次的终端读取，不进参数、日志或审计。

```sh
node --import tsx src/cli/trial-reset.ts \
  --tenant <试用slug> --approval <仓库外签收JSON> --var <实际共享目录> --password-stdin
```

命令持目标全程独占锁，依次追加 `planned → revoked → erased → seeded → verified → complete`。平台事务把改密、撤销旧会话与 revoked 一起提交；每次 `erase_conversation` 行权删除与该 ref 的进度一起提交，app 事务把整批种子和 seeded 一起提交。**两个身份全程不是单事务**。订单去关联留存，消息、trace、同意、附件、关联任务和发送/入站按既有行权函数删除；既有审计、配置、用量、渠道、密钥与 cursor 不清。种子随机批次 ID 不复用，所有消息 seq 使用既有投影写入。不能承诺整库归零。

失败退出 1 保持维护，别重开 app。受控读取本租户 audit_log 的 `trial_reset.checkpoint`，按 audit id 折叠各批，取得未完成 batch；保留原签收文件和原批次，修复原因后加 `--batch <16位hex>` 重跑。恢复不能换目标 ref 清单、种子 ID、配置版本或批次；冲突/部分状态不明时拒绝覆盖。已完成批次重跑也核验种子且不改密/重造 ID。命令输出失败不打印客户 id、消息、SQL 或凭据。

任何未完成或损坏批次都会在预载、spill 回放、渠道、任务和 HTTP 启动前拒绝开放；检查扫描全部分页。已完成批次也检查旧恢复材料：含已删 ref、缺 ref 或早于完成时间的本租户 spill，以及早于完成时间的备份哨兵均拒绝；文件原样留下，不能删文件绕过。新 spill 且不含已删 ref 时仍走既有回放。整库回灌仍属于被禁止的运维动作，不能靠进程内检查弥补丢失的审计历史。完成后重启，从 PG 重建 identity map，验证旧 cookie、旧合成报价链接失效、新种子五类可见。种子 `simulator/seed=true` 不绑账号，客户与顾问两个外发通道均拒绝；真实试用微信消息仍走标准链路。过期种子不进会话保留期候选，但独立 trace 清理不豁免，种子报价有效期/审批规则照旧。无定时重置或定时保鲜。

## 拨测与回退

不能把宿主 `/healthz` 的 200、revision 或汇总 ok 当工业可用证据。独立拨测必须请求工业 app Host：用专属受控普通账号正常登录，带其 Host-only cookie 读取会话或成员可访问资源，再退出；告警只记录结果码/耗时，不记录口令、cookie、消息或客户标识。真实收发拨测在 owner 授权后用该工业客服扫码，验证回调/拉取/入站/引擎/发送，并核对无重复发送。维护窗口按同链路拨测，不能用共享账号 token 长期替代登录。

回退先停止放量、排空在途，保持 prod 与沙箱关闭，执行 11/14 数据兼容和现有 pre-02/03/04/05/07/10/12 rollback guard。旅游已经 suspended 后必须继续 suspended，只可退到支持 R6、PG 种子和批次启动保护的已验证镜像；旧版不认识这些保护时优先前滚。镜像回退不会恢复 env/Host/代理/静态产物；需要时恢复工业原 public_host 与批准的代理映射并重启，原宿主/env/var 不迁。保留最新 PG、spill、cursor、幂等账本、审计和批次，不整库回灌复活已删消息；不得自动切 demo、复活 sandbox 或恢复旅游 active。回退后仍须验工业登录/收发、历史链接、租户隔离及用量连续性。

## 本机验证入口

使用一次性 `pgvector/pgvector:pg17` 的 `PG_TEST_URL`，执行 `src/cli/trial-reset.selftest.ts`、`src/db/repo/trial-reset.selftest.ts` 和 `src/tenancy/product-surface.selftest.ts`；`PRODUCT_CADDY_TEST=1` 执行 `src/tenancy/trial/deploy.selftest.ts` 的真实代理用例，需本机 Docker。测试只删除自己的 `wsa15-` 资源，结束核对资源已释放。该 shell 用例验证 env 改名与部署入口分支，不代替第 9 步完整镜像部署/回退演练。

## 工业品名同步

产品库文件的改动不会随镜像进入已有数据库，`import-config` 遇到不同内容退出 2，CSV 导入拒绝已有编码。维护窗口停 app 后，先核对数据库现状，再用 `catalog-fix` 按产品编码逐条更新 `name` 与 `certs`，保留文件之外的已有资料，然后启动 app。

- 每个已上架条目会新增版本、递增 rev 并记审计，不需要重发 SOP。
- 已有报价用订单行快照，金额、型号和历史链接不变。
- 发布校验不会因产品库变化自动作废已通过的记录，同步后要重新运行工业发布闸。
- 之后执行 `trial-reset` 前要重新盘点并生成签收 `baselineHash`。
