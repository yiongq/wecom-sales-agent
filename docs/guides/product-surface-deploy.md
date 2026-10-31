# 产品门面发布与试用维护

本文是平台运维手册，不在公开文档站六份内容白名单内。实际地址、品牌、法律正文、账号及发布记录另记。以下是待授权发布时执行的流程，本地验收不代表已经上线。

## 发布输入与职责

保持旅游为 `DEFAULT_TENANT_SLUG`，`PUBLIC_BASE_URL`、env 企微账号、原 var、JSON、cursor 仍归旅游；工业 standard 保持非宿主，唯一 `public_host` 指向 app。修改 Host 后必须重启。不能改全局基地址来把工业变成宿主，也不能同时跑两个进程拉同一客服。

app 使用分服务 env 中的 `agent_app`，不得带 platform/owner 凭据；`DEPLOY_PROFILE=prod`、`APP_ROLE=host`、`CONFIG_SOURCE=db`、`SESSION_STORE=db`，非空 `ADMIN_PASS` 仍是启动前置，不作为共享账号密码。真实模型 key、渠道密钥环、迁移、已发布配置与可写目录均须就绪；七个受限 `FLAG_*` 全 off，`web_channel` 不解禁。线上不设置 `LLM_MOCK`，发布闸 required 时不能缺真实 key。必要 DB 配置缺失由既有启动校验拒绝。

`deploy/product-surface/Caddyfile` 全部地址为私有占位。正式应用前填写根域/www/docs/app/旧工业/旅游六个不同 Host、批准的旅游渠道 key、仅本机可达的应用上游，以及 www/docs 的独立构建产物根；同机有其他站点时，把这些块合并进现有配置，不能整份替换。执行 `caddy adapt --validate` 后检查生成配置并平滑重载。静态根不能指仓库或 docs 源码。应用端口只绑定回环地址；未知 Host 在代理拒绝。app 的 `/favicon.ico` 由代理从 www 产物提供，正式图标不进镜像。新域重新登录，cookie 不扩 Domain。

旧工业 Host 的代理固定上游 Host 为 app，不信任客户端 Forwarded/X-Forwarded-Host；不 rewrite、不重定向回调 POST，保留路径、query、请求体及必要资源至少 30 天，安排负责人跟踪旧链接使用情况，再决定延长。应用显式关闭 prod 非宿主的旧演示页、旧管理接口与 `/api/orders/:id/pay`，有效 Basic 也不能绕过；工业 `/quote/:id`、`/api/quotes/:id`、必要订单读接口与成员操作仍按原鉴权/租户/审批/版本规则工作。

旅游旧 Host 只准模板中的精确 env 回调和批准 key 的库内回调 GET/POST，未使用的规则应删除，新增批准 key 逐条登记。其他请求返回无客户数据的 410，不跳工业、不转发订单 id/cookie。大小写、编码、尾斜杠等变体不额外放行。[Caddy path 匹配会规范化路径](https://caddyserver.com/docs/caddyfile/matchers)，模板因此按原始 URI 的路径部分严格比较。源站 `/healthz` 仅供内网运维，不经过旅游公开入口。

## 两段上线与长期停用沙箱

第一段与第二段使用同一个 tag；该 tag 必须同时支持以下全部保护，不在两段之间换版。旅游旧 Host 在第一段保持原路由，第二段才收窄；模板中的旅游白名单块只在第二段应用。

1. 取得 owner 对本次操作的授权，核对 11/14/15 验收、备份及异地副本可恢复性、私有发布输入、法律正文和回退 tag。先关闭对外试用，排空在途发送与入站恢复。
2. 按 05 长期停用：删除本实例 sandbox 容器及其匿名卷，将 `.env.sandbox` 改为 `.env.sandbox.off`；持沙箱进程锁执行既有 `sandbox purge --all`。从代理摘沙箱站点，去掉宿主体验链接与旧拨测；长期不用的体验客服在平台停用。清理失败继续关闭入口，不删除 spill/恢复哨兵来伪造成功。`deploy.sh` 的只读预检会拒绝 prod 仍有 `.env.sandbox` 或遗留 sandbox 容器（包括停止状态）；env 改名后部署不会进入沙箱启动分支，compose 默认 profile 不启动 sandbox。不要手动加 `--profile sandbox` 或把 off 文件改回原名；源码 demo 档仍可按 05 开沙箱。
3. **第一段，旅游保持 active。** 用 `tenant-host` 把工业改到 app → 部署一个支持完整 14 R6、PG 种子豁免、种子外发守卫和未完成批次启动检查的 tag → 平滑重载代理，加根域、app、旧工业三段，旅游旧 Host 此时不收窄 → 停 app 按文末「工业品名同步」处理，再起 → 重跑工业发布闸 → 验工业 app 普通登录、真实收发、两租户渠道、历史客户链接 → 记录验证通过的回退 tag 和不可变镜像 ID。根域 301 到 www 并保留路径和 query；新域重新登录。切换窗口旧工业回调暂时失败会延迟即时拉取；按 `src/adapters/wecom.ts` 的 `startRuntimeInScope`，重启先从持久 cursor 补拉，再以至少 30 秒（默认 60 秒）的兜底轮询补回调丢失，不能据此承诺零延迟或无限期无丢失。
4. 观察至少隔一晚，确认工业登录、真实收发、两租户渠道、历史链接与运维告警稳定，再进入第二段。
5. **第二段，仍使用第一段同一个 tag。** 把旅游改为 suspended，同时代理把旅游旧 Host 收窄到批准回调；验证 30 秒内普通登录失效、固定停用回复与紧急/撤回优先级、重启仍可装载宿主且工业继续服务。旅游原保留期和访客清理照常，到期仍删除；不主动清旅游，不拿旅游做试用重置。核对批准回调 GET/POST 可达，其他旧页面为 410、无客户数据且不转发给工业。
6. 按下节准备工业试用、7 天保留和 PG 种子，并通过 `privacy-publish` 发布与实际保留期一致的隐私说明；再发布 www、docs 静态产物，静态根放在部署目录之外（`deploy.sh` 的 rsync 带 `--delete`）。配置 `.env.ops` 的 PROBE 项；确认共享提示已接入、无线上演示入口、无沙箱进程，验报价读接口、用量、隔离和独立工业拨测后放量。

## 共享试用账号与签收清单

先通过既有 `user-create` CLI 创建唯一普通 agent，仅属于工业试用公司；独立 owner 不对外发放。用 `tenant-retention --tenant <slug> --lead 7 --customer 7 --trace 7` 设置三类保留期。不绑定真实 ERP，不把正式客户数据、凭据或其他租户成员混入。账号和客服码私下提供。

app 服务另设私有 `TRIAL_TENANT_ALLOWLIST`，值为签收 JSON 中 `allowlist` 数组的 JSON 文本。服务端精确比较 UUID、slug、industrial、standard、非宿主；未配置、格式错误或错配时不显示，不按名称推断。`/me` 和登录响应仅下发 `sharedTrial` 布尔值，白名单内容不下发。更改后重启，并验证试用成员有提示、旅游及其他租户没有提示。这只是告知开关，不授予任何权限。

后台外壳顶部常驻显示以下说明：

> 这是共享试用环境，会话可能被其他试用者看到，请不要发送个人信息。试用消息保留7天。

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

任何未完成或损坏批次都会在预载、spill 回放、渠道、任务和 HTTP 启动前拒绝开放；检查扫描全部分页。已完成批次也检查旧恢复材料：含已删 ref、缺 ref 或早于完成时间的本租户 spill，以及早于完成时间的备份哨兵均拒绝；文件原样留下，不能删文件绕过。新 spill 且不含已删 ref 时仍走既有回放。整库回灌仍属于被禁止的运维动作，不能靠进程内检查弥补丢失的审计历史。完成后重启，从 PG 重建 identity map，验证旧 cookie、旧合成报价链接失效、新种子五类可见。种子 `simulator/seed=true` 不绑账号，客户与顾问两个外发通道均拒绝；真实试用微信消息仍走标准链路。仅未超过 `seedBaselineSeq` 的纯种子不进会话保留期候选；追加人工回复等消息或缺失基线时，按普通保留期整段删除，`seed=true` 始终保留到删除。独立 trace 清理不豁免，种子报价有效期/审批规则照旧。无定时重置或定时保鲜。

## 拨测与回退

不能把宿主 `/healthz` 的 200、revision 或汇总 ok 当工业可用证据。[watch.sh](../../deploy/watch.sh) 复用原每分钟 cron，在第五项通过工业 app Host 正常登录 → `/api/console/me` 核对租户 → 读取普通成员可访问的 `conversations/counts` → 带 csrf 退出。中途失败也尽力退出，每请求限时 8 秒、不跳转、不关闭 TLS 验证；告警仅含步骤与 HTTP/curl 结果码，租户错配只记「租户不符」，不记响应体或配置值。

拨测账号用 `user-create` 建普通 agent，只属于工业租户，单独受控，不是共享试用账号；`trial-reset` 不改它的口令。配置在服务器 `.env.ops`，文件被 `source`，口令用单引号包裹（若口令本身含单引号，按 shell 单引号转义规则处理），不在命令行传入口令：

```sh
PROBE_APP_ORIGIN='https://app.example.test'
PROBE_TENANT_SLUG='<工业租户slug>'
PROBE_EMAIL='<专属拨测邮箱>'
PROBE_PASSWORD='<专属拨测口令>'
PROBE_EVERY_S=600
```

四个必填项全空时跳过；部分配置告警「业务拨测配置不完整」且不请求。健康时默认每 10 分钟登录一次，每天约 144 行 `auth.login` 审计；失败或恢复观察时每分钟重跑，连续 3 次失败告警、连续 3 次成功恢复，持续告警沿用 30 分钟去重。临时凭据文件仅本人可读并在成功、失败、超时后删除，口令、cookie、csrf 不进进程参数。

真实收发拨测在 owner 授权后用该工业客服扫码，验证回调/拉取/入站/引擎/发送，并核对无重复发送。维护窗口按同链路拨测，不能用共享账号 token 长期替代登录。

旧镜像重建会话时原样保留未知的 `seedBaselineSeq` 状态字段，不会因多一个字段而启动失败；旧候选查询仍整段跳过 `seed=true`，回退期间继续关闭试用，恢复放量前须前滚到含本次保留期修复的镜像。

回退先停止放量、排空在途，保持 prod 与沙箱关闭，执行 11/14 数据兼容和现有 pre-02/03/04/05/07/10/12 rollback guard。旅游已经 suspended 后必须继续 suspended，只可退到支持 R6、PG 种子和批次启动保护的已验证镜像；旧版不认识这些保护时优先前滚。镜像回退不会恢复 env/Host/代理/静态产物；需要时恢复工业原 public_host 与批准的代理映射并重启，原宿主/env/var 不迁。保留最新 PG、spill、cursor、幂等账本、审计和批次，不整库回灌复活已删消息；不得自动切 demo、复活 sandbox 或恢复旅游 active。回退后仍须验工业登录/收发、历史链接、租户隔离及用量连续性。

## 本机验证入口

使用一次性 `pgvector/pgvector:pg17` 的 `PG_TEST_URL`，执行 `src/cli/trial-reset.selftest.ts`、`src/db/repo/trial-reset.selftest.ts` 和 `src/tenancy/product-surface.selftest.ts`；`PRODUCT_CADDY_TEST=1` 执行 `src/tenancy/trial/deploy.selftest.ts` 的真实代理用例，需本机 Docker。测试只删除自己的 `wsa15-` 资源，结束核对资源已释放。该 shell 用例验证 env 改名与部署入口分支，不代替第 9 步完整镜像部署/回退演练。

## 一次性镜像、HTTPS 与回退演练

以下命令仅用于本机合成数据；不读取部署 env、不连接已有容器、不调用真实模型。Colima 使用独立可写 Docker 配置目录，避免 Docker CLI 写用户配置；若 compose 插件不可见，使用已安装的 `docker-compose` 可执行文件，通过 `DOCKER_COMPOSE_BIN` 传给代理自测。文档站是独立 package，安装时必须带 `--ignore-workspace`。

```sh
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
mkdir -p var/step89/docker-config var/step89/r6-source
export DOCKER_CONFIG="$PWD/var/step89/docker-config"
pnpm --dir docs-site install --ignore-workspace --frozen-lockfile
pnpm exec tsx scripts/product-sites/build.ts all --sample
# R6_REF 由操作者设为已验证支持 R6、PG 种子与批次启动保护的基线提交。
git archive "$R6_REF" | tar -x -C var/step89/r6-source
docker build -t wsa15-step89:r6 --build-arg APP_REVISION=15-r6-local var/step89/r6-source
docker build -t wsa15-step89:current --build-arg APP_REVISION=15-local .
PRODUCT_CURRENT_IMAGE=wsa15-step89:current PRODUCT_R6_IMAGE=wsa15-step89:r6 \
  perl -e 'alarm 600; exec @ARGV' pnpm exec tsx scripts/product-sites/rehearse.selftest.ts
```

本机演练使用 `*.example.test` 的 根域/www/app/docs、旧工业与旅游六个 Host，Caddy internal CA；不改系统 DNS、不安装系统证书。客户端仅信任当次 CA，同时验证不信任 CA 和未知 SNI 的握手失败。脚本真实执行 `caddy adapt --validate`、镜像启动/停止、已有渠道命令、双身份重置 CLI 与签名旧域回调；模型和企微传输为替身，认证、PG、渠道服务及计数是真实实现。普通 CI 未提供两个镜像时明确跳过镜像演练，不能据 CI 默认结果宣称完成第 9 步。

脚本先发 R6 基线镜像且旅游 active，经工业 HTTPS 普通登录稳定后发当前镜像，再设旅游 suspended 并重启。之后重置种子与试用消息，新增试用消息，再模拟坏配置导致进程退出和代理 502，切回已验证 R6 镜像。回退继续 prod、旅游 suspended、不启沙箱；核对新消息、cursor、审计、用量和重置记录，旧消息/旧链接不复活、不重复发送，工业仍可收发。

| 故障                                  | 可见结果               | 恢复与验证                                          |
| ------------------------------------- | ---------------------- | --------------------------------------------------- |
| app 配置打开受限 FLAG／切换到失败实例 | 启动退出、app 入口 502 | 换回已验证 R6 镜像，独立工业登录和收发恢复          |
| 未信任当次 CA／未知 SNI               | TLS 握手拒绝，不到应用 | 使用正确 CA/Host 后三个入口 200，不关闭证书校验     |
| 静态首页丢失                          | 静态请求 404           | 恢复原产物，首页 200                                |
| 无效 Caddy 配置                       | reload 非零退出        | 旧配置仍服务，已有首页 200                          |
| 未签收的回退镜像                      | 镜像 ID 校验失败       | 停止切换，选已动态验证的不可变镜像 ID；不能放宽签收 |

正式 runbook 也应在停用旅游前记录已验证 R6 镜像的不可变 ID，回退前重新比对；tag 可能被覆盖，不能只看名字。镜像内存在某个文件不能证明 R6 正确。演练中的拒绝分支会用不支持本服务的基础镜像验证 ID 校验确实失败；既有 rollback guard 和 11/14 数据兼容测试仍必须另跑，不能被此校验代替。所有实际映射与签收 ID 另记。本轮归档的 R6 基线尚无新增 sharedTrial/横幅，演练确认其旧 DTO 可兼容；回退期间继续关闭对外试用。重新放量前必须前滚或选择同时含共享告知的已验证产物，不能仅凭登录/收发恢复就重开共享试用。

脚本 finally 删除自己创建的容器、匿名卷与网络。退出后用 `docker ps -a --filter name=wsa15-rehearse-` 与对应网络过滤复核；失败中断时先查看当次合成日志，只清理该次资源。完成后可删除本次本机镜像 tag；不执行全局 prune。

## 工业品名同步

产品库文件的改动不会随镜像进入已有数据库，`import-config` 遇到不同内容退出 2，CSV 导入拒绝已有编码。维护窗口停 app 后，先核对数据库现状，再用 `catalog-fix` 按产品编码逐条更新 `name` 与 `certs`，保留文件之外的已有资料，然后启动 app。

- 每个已上架条目会新增版本、递增 rev 并记审计，不需要重发 SOP。
- 已有报价用订单行快照，金额、型号和历史链接不变。
- 发布校验不会因产品库变化自动作废已通过的记录，同步后要重新运行工业发布闸。
- 之后执行 `trial-reset` 前要重新盘点并生成签收 `baselineHash`。
