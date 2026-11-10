# 部署（按 git tag，rsync + Docker Compose + Caddy）

本文从 README 搬来（2026-10-27），按 09、10 补了多租户 Host 与回滚检查。服务器地址、站点域名与部署目录都不写进仓库，下文用 `<部署目录>` 指服务器上的部署目录（缺省值见 [deploy.sh](../../deploy.sh) 的 `REMOTE_DIR`）。

**首次部署前置条件**（换新服务器时逐项确认）：

1. 服务器已装 Docker（带 Compose 插件，2.30 及以上：compose 文件用 `env_file` 的 `format: raw`），且本机能 `ssh` 免密登录。服务器地址不入库：写在已 gitignore 的 `.deploy.env`（`SERVER=root@<你的服务器>`），或通过 `SERVER` 环境变量传入；**未设置时脚本直接中止**，没有内置默认值。
2. 服务器上创建 `<部署目录>/.env`（参考 `.env.example`）：至少填 `LLM_API_KEY`、`ADMIN_PASS`、`PUBLIC_BASE_URL`（发给微信客户的支付链接靠它拼完整 URL），并**显式写明 `DEPLOY_PROFILE=demo` 或 `DEPLOY_PROFILE=prod`**（不带引号）。deploy.sh 在同步之前检查它，缺 `.env` 或没写明 profile 会直接中止，不会打掉在跑的旧容器。
3. 同一目录下还有 `.env.db`、`.env.migrate`（数据库容器与迁移各自的凭据，写法见 [deploy/compose.yml](../../deploy/compose.yml) 开头），跑平台命令行时再加 `.env.platform`。应用的 `.env` 里不能有 owner、platform 或超级用户的口令，查到就拒绝启动。这几个文件都按 `docker run --env-file` 的规则读：值是 `=` 后面的整行，引号、`$`、`#` 都原样进容器，所以不要加引号和行尾注释。deploy.sh 也会查 `.env.db` 里四个口令都有、没有 `POSTGRES_DB`。
4. HTTPS 用宿主机 Caddy 直连专用 bridge 上的固定容器 IP（默认 `172.30.250.10:3200`，主备启用后再加 `172.30.250.11:3200`），SSE 透传；云防火墙放行 80/443。宿主发布的 3210/3212 仍仅绑定回环地址，供健康检查与巡检，不作为 Caddy 上游。网络参数及首次接入顺序见下文「18 主备切换」；站点地址仅在服务器配置，不写入仓库。
5. 应用库里要有 **vector 扩展**（07 起，迁移 0016 的 `kb_vectors` 用 pgvector 的 `halfvec`）。它不是 trusted 扩展，迁移用的 `agent_owner` 不是超级用户，建不了：新库首次初始化时 `deploy/db-init/roles.sh` 建完库会顺带调 `extensions.sh` 建好；**现有的线上库在第一次部署含迁移 0016 的版本之前，由 owner 手工执行一次**：`docker compose -f deploy/compose.yml exec db /db-init/extensions.sh`（可重复执行，用超级用户连应用库执行 `deploy/db-init/extensions.sql`）。没做这一步，migrate 服务报「先由超级用户在应用库里建 vector 扩展」并整批回退，部署停在切换之前，旧容器照常运行；`deploy.sh` 此时已把 `deploy/` 同步到服务器，补做上面那条命令后重新部署即可。也可以在第一次部署之前直接执行同一句 SQL（这时 `extensions.sh` 还不在服务器上）：`docker compose -f deploy/compose.yml exec -T db psql -X -v ON_ERROR_STOP=1 -U postgres -d agent -c 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;'`（库名按 `.env.db` 的 `AGENT_DB`，缺省 `agent`）。
6. 同一部署装多个 standard 租户时（例如旅游演示租户之外再开工业品询价演示租户 `industrial-demo`），公开路由严格按 Host 匹配：每个租户都要有 `public_host`，宿主租户的 `public_host` 要与 `PUBLIC_BASE_URL` 一致，否则拒绝启动（[src/tenancy/hosts.ts](../../src/tenancy/hosts.ts)）。用 `src/cli/tenant-host.ts set --tenant <slug> --host <host>` 以 platform 身份设置，下次启动生效。开通新租户前先核对：旅游的公开地址按 Host 都命中旅游租户，新租户的 Host 只命中它自己（10 R16）。

DB 模式的 prod 与 demo 宿主在应用环境中设置 `SOP_GATE=required`；开发与 CI 默认 `off`，沙箱忽略此开关。可调参数为 `SOP_GATE_BUDGET_CNY=2`（元）、`SOP_GATE_DAILY_RUNS=3`（每租户每天）、`SOP_GATE_TIMEOUT_MS=1800000`（30 分钟）。启用后必须配置模型密钥且不能使用 `LLM_MOCK=1`，否则以 `gate_unavailable` 拒绝启动。回归在后台单独运行，发布只认对应草稿和哈希的通过记录；所有者可填写原因强发，回滚、首次导入与启动重渲染跳过闸。预算达到上限后不发新请求，最后一次请求的费用如实记录，最多超出这一笔费用；中途取消、超时或子进程出错时，报告里已经出来的那部分花费照样记进 `gate` 用量（正在跑的那个目标还没出报告，拿不到）。报告保留在 `VAR_DIR/gate/<runId>/`，每次结束清理临时状态和配置副本；运维可按保留期删除旧报告，数据库结果不受影响。

之后每次发布：给要上线的提交打 tag，再按 tag 部署。

```bash
git tag demo-v1.2          # 打在要上线的那个提交上
bash deploy.sh demo-v1.2   # SERVER 由已忽略的 .deploy.env 或环境变量提供
```

以下部署流程默认在服务器部署目录操作，省略 `-f` 的流程描述由 `deploy.sh` 提供实际 Compose 参数。它只收本地已有的 tag，分支名和提交号都不收，所以线上跑的每一版都提交过、也过了四个门禁，工作区里没提交的改动上不了线。换成 compose 之前的 tag（里面没有 `deploy/compose.yml`）也不收，见下面「回到文件模式或更早的版本」。流程（见 [deploy.sh](../../deploy.sh)）：

1. `git archive <tag>` 解到临时目录，在那里 `pnpm install` 并跑四个门禁，任何一个不过就中止，服务器上什么都不动（本机要有 pnpm）。
2. 先做[旧 tag 的固定网络退版检查](#rollback-before-fixed-ip)，再检查服务器 `.env`（均只读），不过就中止。
3. rsync 到服务器：按内容比对，`.env*`、`var/`、日志既不发送也不删除。
4. 把备份脚本装到部署目录之外（安装位置见 deploy.sh），给正在跑的容器所用镜像打 `:prev`，再 `docker build`（把 tag 写进镜像，后台前端 `console/` 也在这一步构建），并用新镜像试读一遍 `.env`。这几步失败就中止，旧容器照常跑。
5. 跑迁移（`docker compose run --rm migrate`，顺带拉起数据库）。失败就中止，旧容器照常跑，库没有变化。
6. 18 起按下节主备流程滚动换容器；旧 tag 仍以 `docker compose up -d app` 换容器（宿主 `3210` → 容器 `3200`，挂 `var/` 卷并自动校正属主，参数都在 compose 的 `app` 服务里），给新镜像打 `:current`，然后做健康检查：`/healthz` 的 `revision` 必须等于这个 tag。第一次换成 compose 时，原来 `docker run` 起的同名容器会先按同样的方式停掉。
7. 换容器或健康检查失败时，打印容器日志，先过回滚风险检查，允许时自动用 `:prev` 回滚（`up -d --no-deps app`，不跑迁移：迁移只增不删），`:current` 改指 `:prev`，并以非零退出。回滚后 `/healthz` 报的是上一版的 tag。

`:current` 是最近一次成功上线或回滚的镜像，compose 文件不给 `APP_IMAGE` 时就用它，所以下面这些手工的 `docker compose` 命令不用带 `APP_IMAGE`。别手写 `:latest`：自动回滚之后它指向的是那个没起来的坏镜像。

换容器按 SIGTERM，Compose 宽限 10 秒；`src/shutdown.ts` 分 normal / drain / late 三段，先等在途处理，再排空写队列，最后释放资源。DB 落库来不及时写 spill，启动回放；企微在途消息仍记在 `var/wecom-cursor.json`，先重放再拉新消息，是否补发按发送账本判断。恢复边界见 [运行机制与可靠性](how-it-works.md)「企微去重、发送账本与恢复」，不把 JSON 与数据库当成原子快照。

演练回滚可以在同一台服务器上起一个旁路实例：`NAME`、`REMOTE_DIR`、`HOST_PORT` 三个环境变量同时换成和线上不同的值（只换一两个会被拒绝，免得打到线上），它的 `.env` 不能配企微凭据，否则会和线上实例抢同一个客服账号的消息。

- **密钥**：`LLM_API_KEY`、`WECOM_*` 全在服务器 `.env`，不在仓库、脚本不碰。
- **数据**：DB 模式下真实会话、消息、订单在数据库卷；`var/` 保留种子、访客、企微 cursor、spill、用量与客服二维码。文件存储下会话与订单也在 `var/`；rsync 既不同步也不删除它。DB 模式下线路的检索向量在库里（`kb_chunks`、`kb_vectors`），不再读写 `var/route-vectors.json`（文件模式照旧）；回滚到 07 之前的镜像时，旧代码照旧用那个文件，回滚后重建一次索引。
- **鉴权**：demo 作战室匿名只读，旧写接口要 `ADMIN_PASS`；成员工作台使用独立账号与角色权限（见 [后台、账号与权限](console-access.md)）。改了服务器 `.env` 要 `docker compose -f deploy/compose.yml up -d app`（或重新部署）重建容器才生效：env 只在创建容器时读一次，`docker restart` 读不到新值。
- **后台**：`/console/` 要求 `CONFIG_SOURCE=db`，并配置 `DATABASE_URL`、`DEFAULT_TENANT_SLUG`。平台凭据仅给 `platform` 服务；初始化命令见下，账号口令从 stdin 输入，勿写入命令历史。
- **备份**：宿主机 cron 每天凌晨跑部署时装好的那一份 [deploy/backup.sh](../../deploy/backup.sh)，cron 行的写法见脚本开头。导出数据库并校验、打包 `var/`，用 age 公钥加密后按日期存 7 天，配了异地目标再复制一份存 30 天。配置写在 `.env.backup`，恢复步骤写在脚本开头。装在部署目录之外，是为了回到旧版本时 cron 照样能跑。

**首次启用 DB 配置与成员后台**：先停 app 和 app-standby、运行迁移，平台建租户，应用身份导入配置，平台建所有者账号（示例占位值请替换）。应用 `.env` 中配置前述 DB 变量；账号创建不等于导入会话。

```bash
docker compose -f deploy/compose.yml stop app app-standby
docker compose -f deploy/compose.yml run --rm migrate
docker compose -f deploy/compose.yml run --rm platform node --import tsx src/cli/tenant-create.ts --slug '<租户slug>' --name '演示旅行社' --pack travel
docker compose -f deploy/compose.yml run --rm app-cli node --import tsx src/cli/import-config.ts --tenant '<租户slug>'
docker compose -f deploy/compose.yml run --rm platform node --import tsx src/cli/user-create.ts --tenant '<租户slug>' --email '<成员邮箱>' --name '<成员姓名>' --role owner --password-stdin
docker compose -f deploy/compose.yml up -d app
```

`--pack` 的可选值读行业包注册表（[src/packs/registry.ts](../../src/packs/registry.ts)），现有 `travel` 与 `industrial`；证明包只在 `PACK_FIXTURES=1` 时登记，线上不用。同一部署里的第二个租户还要按前置条件第 6 条设好 `public_host`。

**切换会话存储**（始终用 02 镜像）：

1. 先在 `SESSION_STORE=file` 部署，确认 `/healthz` 正常，记录 `promptHash`、`toolsHash`、`prefixHash`、`sopHash` 与会话数，备份数据库及 `var/`。
2. 停 app 和 app-standby，准备部署目录、`var/` 之外且属主为容器 node 用户的宿主目录，挂成 `/keep`，运行导入：

   ```bash
   docker compose -f deploy/compose.yml stop app app-standby
   docker compose -f deploy/compose.yml run --rm -v '<宿主保留目录>:/keep' app-cli node --import tsx src/cli/import-sessions.ts --tenant '<租户slug>' --keep /keep --var /app/var
   ```

3. 导入成功后在服务器 `.env` 写 `SESSION_STORE=db`，`docker compose -f deploy/compose.yml up -d app`；确认 `/healthz` 的 `store.mode=db`、四个哈希不变、会话数与导入一致，成员工作台能打开导入的会话。种子、访客仍在 JSON。
4. 若需回退，停 app 和 app-standby、用 `src/cli/export-sessions.ts` 导出（参数与挂载同上），去掉 `SESSION_STORE=db` 再起，确认 `store.mode=file`。回退期间聊过的新消息再次切库时用 `import-sessions --resync` 合并。
5. 切换后第一份每晚备份完成恢复验证，才删除 `--keep` 原件。

**回到文件模式或更早的版本**（配置源与会话存储是两件事）：

- **10、09 之前的镜像**：库里有工业数据（工业租户、`part` 条目、工业报价单，停用、草稿、终态与重置历史都算）时，回到 10 之前的镜像会被拒绝；库里有带审批的订单时，回到 09 之前的镜像会被拒绝。两者都以**退出码 9** 拒绝，查询无法确认时同样从严，提示「前滚修复，或者回滚到另一个含 10（或 09）的 tag」；pre-10 检查先于 pre-09，既有 pre-08 条件不变。目标版本按镜像或 tag 文件树里有没有 `src/packs/industrial/runtime.ts`、`src/core/site-links.ts` 判定（[10 spec](../architecture/10-industrial-rfq-pack/spec.md) R17、[09 spec](../architecture/09-quote-approval/spec.md) R15、[回滚检查脚本](../../deploy/rollback-guard.sh)）。
- **08 之前的镜像**：回滚检查以 `src/core/order-view.ts` 是否存在判定目标版本。库里有非旅游租户、通用单（`data->>'v' = '2'`）、kind 不在 `route` / `hotel` 的条目或 source 不是 `route` 的知识块时，[回滚检查脚本](../../deploy/rollback-guard.sh) 以 **退出码 9** 拒绝，`deploy.sh` 转成 1 并透出处理步骤。先停用并清理非旅游租户及其遗留数据，确认四项都为零、重跑检查通过后再回滚；镜像目标会打印手工起目标镜像并重打 `:current` 的命令，旧 tag 则在清理并检查通过后重新部署。库或查询结果无法确认时从严拒绝，仅明确正在运行的也是 08 之前的镜像时豁免未知项，已确认存在的风险仍拒绝。若新服务器库还没建、四项都无法确认，先部署 08 之后的 tag，或确认库里确实没有这四类数据后再处理。自动回滚同样适用，被拒时会明确提示「服务当前不可用！」。
- **先查条目版本**：后台修改已上架条目后（`/healthz` 的 `config.catalogVersioned=true`），`deploy.sh` 拒绝回到 02 之前的镜像。旧镜像不写条目版本，那期间发出的方案书回到 02 后会按版本 1 显示旧价；回到文件存储也去不掉风险，只能回滚到 02 之后的镜像。检查适用于手工部署与自动回滚，健康或数据库状态看不清时从严拒绝。
- **文件配置的链接损失**：同一 02 镜像去掉 `CONFIG_SOURCE=db` 后，已发 `?v=2` 及以上的方案书全部 404，不带 `v` 的旧链接按导出时的新内容显示，不能保持历史报价；仅把 `SESSION_STORE` 改为 file、仍保留 DB 配置则不改变条目版本。当前没有对此类配置切换的专门启动告警，操作前须人工核对。
- 会话在库里时（`.env` 为 `SESSION_STORE=db` 或 `var/` 有 `sessions-in-db.json`），先用 02 的镜像回到文件存储：`docker compose -f deploy/compose.yml stop app app-standby`，跑 `src/cli/export-sessions.ts`（用法见 [deploy/compose.yml](../../deploy/compose.yml) 开头），去掉 `SESSION_STORE=db` 再起。不做这一步，deploy.sh 拒绝部署 02 之前的 tag，也不会自动回滚到 02 之前的 `:prev`（[deploy/rollback-guard.sh](../../deploy/rollback-guard.sh)）。
- 先导出后台改过的内容。导出要写进挂进容器的宿主目录，写在容器里的文件会随 `--rm` 删掉：`install -d -o 1000 -g 1000 <宿主导出目录>`，再 `docker compose -f deploy/compose.yml run --rm -v <宿主导出目录>:/export app-cli node --import tsx src/cli/export-config.ts --tenant <slug> --out /export`。回到旧 tag 时把那一版的 `data/sop.md` 先放进这个目录（例如 `target-sop.md`），加 `--image-sop /export/target-sop.md`。
- 把三个文件拷进要部署的那条线的 `data/`，两个 JSON 用 `pnpm exec oxfmt --write data/routes.json data/hotels.json` 格式化，提交、打 tag；`.env` 去掉 `CONFIG_SOURCE=db`，再部署这个 tag。
- 那条线是换成 compose 之前的版本时，deploy.sh 不收它的 tag（否则会先把服务器上的 `deploy/` 同步删掉，到迁移那一步才失败）：在那个 tag 的 worktree 里跑它自己的 `deploy.sh`，它用 `docker run` 换掉 compose 起的同名容器。之后再部署新的 tag，换容器那一步会接管这个容器。
- 旧 deploy.sh 的 rsync 也带 `--delete`，跑之前先看它保护哪些文件。demo-v1.1 及以后的线保护全部 `.env*`（`git show <tag>:deploy.sh | grep -F 'P /.env*'` 有输出）。demo-v1 和从它切出的线只保护名为 `.env` 的那一个，会删掉 `.env.db`、`.env.migrate`、`.env.platform`、`.env.backup`：之后每晚的备份停在「缺 BACKUP_AGE_RECIPIENTS」（只记在日志里），再部署新 tag 也会在检查服务器 `.env` 那一步中止。用这种线，先把这几个文件（有几个拷几个）拷到部署目录之外，跑完立刻拷回。
- 两种线都会删掉服务器上的 `deploy/`。db 容器照常在跑，cron 跑的是部署目录之外那份备份脚本，暂时都不受影响；但 db 容器一旦重启（宿主机重启、升级 Docker）就起不来，因为它挂载的 `deploy/db-init/roles.sh` 没了，之后每晚的备份在导出那一步失败，`var/` 也不再打包。所以跑完旧 deploy.sh 立刻只把这个目录放回去：`git archive <刚才在跑的 compose 版 tag> deploy/db-init | ssh <服务器> tar -x -C <部署目录>`。别把整个 `deploy/` 放回去：`deploy/compose.yml` 不在，手工的 compose 命令就会直接报错，而不会把 `:current` 的新镜像换回来。

数据库存储并不代表可以多副本：identity map、串行锁与若干限流计数仍在进程内；DB 配置的租户锁会拒绝第二个进程，当前必须单实例运行。

## 可观测性开关与回滚

应用 env 的 `OPS_DIGEST_TENANTS` 开启每日摘要，`OPS_LATENCY_TENANTS` 开启回复延迟监测；均为逗号分隔的 standard 租户 slug，空值默认关闭，不存在或非 standard 的项报错跳过且不回显取值。真实值与租户映射另记；线上启用需要 owner 当次授权。群通知使用 `ALERT_WEBHOOK_URL`，定位链接只取当前租户 HTTPS `publicBase`，未配置合法地址时仅附手册编号。

镜像包含 `docs/ops`，手册 API 仅 owner/admin 可读。异常状态、显式重发及回滚前的 `ops-report prepare-rollback` 见[公共运维手册](../ops/observability.md)，unknown 不自动重发。

退回不含 17 的镜像后，摘要和延迟监测停止，主机巡检照常；旧镜像会忽略这两个 env，也不认领 `ops_daily_digest`。目标镜像必须含 14 R6 和 15 的试用删除保护。不要删日账本，也不要整库恢复；sent、unknown、failed 的账本在前滚后不会重发。旧镜像不跑 `purge_ops_data`，长期停在旧镜像时要在保留期内由运维在该租户事务里手动调用它，不能让账本和 coverage 活过保留期。

## 18 主备切换、滚动发布与回滚

同一时刻只有一个活动实例，另一个进程等租户锁。两边要求 `CONFIG_SOURCE=db`、`SESSION_STORE=db`、`TENANT_LOCK_WAIT=forever`，共用数据库与 `var/`。等锁期间不监听、不跑任务、不读写 `var/`；备用的 Docker HEALTHCHECK 显示 unhealthy 属预期，不能按它重启容器。沙箱和平台命令行沿用原方式。应用命令行统一用 `docker compose -f deploy/compose.yml run --rm app-cli node --import tsx src/cli/<name>.ts …`：`app-cli` 通过 YAML 共享配置取得与 app 相同的镜像、原样 `.env` 和 `var/` 挂载；它的 `environment` 只设 `PORT`、`LOG_FORMAT`，不设 `TENANT_LOCK_WAIT`（CLI 不走宿主等锁启动，没有进程 epoch）。等锁变量只在 app / app-standby 的服务配置中设置，不要写入共享 `.env`。`app-cli` 只接默认网络、没有固定 IP 或发布端口，`cli` profile 平时不启动。显式 `run app-cli` 不需要另加 `--profile cli`，只依赖 db，不触发迁移或启动应用。平台身份仍用 `platform`，不能拿平台凭据替代应用凭据。

首次切换前由 owner 按顺序完成：

1. 备份并完成 DB 配置与会话导入，确认两个镜像都含 18 进程侧实现。
2. 选定 `APP_UPSTREAM_SUBNET`、`APP_UPSTREAM_IP`、`STANDBY_UPSTREAM_IP`，在服务器只读查看已有 Docker 网段和宿主路由，确认没有重叠（含 VPN/静态路由）。不能只看两个 IP 有没有被使用。以下命令不修改网络：

   ```bash
   docker network ls -q | xargs -r docker network inspect --format '{{.Name}} {{json .IPAM.Config}}'
   ip -4 route show table all
   ```

3. 旧实例尚未接入固定 IP 网络时，先保持开关为 `0`，单容器部署一次含新网络的 tag，让 `app` 取得固定 IP；已有备用的实例须先按下文流程退回单容器、停止备用。此准备步骤会有单容器重启窗口。核对宿主主端口和 `http://<APP_UPSTREAM_IP>:3200/healthz` 均正常后，再配置 Caddy；否则新上游尚不存在，无法完成下一步访问确认。
4. 在服务器现有 Caddy 站点块内导入[上游片段](../../deploy/caddy-app-upstreams.snippet)，上游写 `<APP_UPSTREAM_IP>:3200 <STANDBY_UPSTREAM_IP>:3200`（默认 `172.30.250.10:3200 172.30.250.11:3200`）。先 `caddy validate --config <配置文件>`，成功后 `caddy reload --config <配置文件>`；宿主端口 3210/3212 留给巡检，3211 留给沙箱。
5. 确认经 Caddy 的实际入口能访问应用及 `/healthz`，再在**服务器部署目录**的 `.env.ops` 写入 `CADDY_DUAL_UPSTREAM=1`，最后运行 `deploy.sh <tag>`。从旧的宿主端口双上游迁移时，也须重新完成以上确认，旧开关不能证明 Caddy 已直连固定 IP。仓库脚本不修改或自动验证服务器 Caddy。

两个 app 同时接入默认网络（连接 db）与专用 `app-upstream` bridge（Caddy 直连），沙箱不接专用网络；固定地址与 IPAM 对应关系见 [Docker Compose 网络文档](https://docs.docker.com/compose/how-tos/networking/)。三个部署参数可写入本机 `.deploy.env`，或用环境变量覆盖（环境变量优先）；默认依次为 `172.30.250.0/28`、`172.30.250.10`、`172.30.250.11`。脚本在连接服务器之前校验规范 IPv4 CIDR、网络地址、两个不同且可用的子网内地址；网络地址、广播地址及首个可用地址（Docker 默认网关）不可用于 app，前缀最大 /29。目标 tag 不含此网络时保留旧部署参数要求。

旁路实例除同时更换 `NAME`、`REMOTE_DIR`、`HOST_PORT` 外，还须显式选另一组子网与 IP；脚本拒绝与线上默认子网有任何重叠。线上自定义网段及其他实例的子网由 owner 用上述命令核对，Docker IPAM 也会拒绝重叠网络；不能靠换 project 名复用同一子网。三个参数同步传给手工 compose（含回滚）并保留稳定，改变已用网段须另开维护窗口。Caddy 同步两个 IP，`watch.sh` 和部署 revision 核对继续用宿主端口。

`deploy.sh` 保留前六步，迁移只增不删，第七步先读服务器 `.env.ops` 的确认开关（不继承本机环境变量或 `.deploy.env` 的同名值，不执行 `.env.ops`，也不输出其中凭据）。只有字面值 `1` 才启用主备；兼容单/双引号、`export` 和行尾空白注释，重复键取最后一项。缺失或其他值都视为未确认，打印「Caddy 未确认双上游，本次不启用备用」，仅更新 `app`；此时若本 compose project 已有 `app-standby` 运行，或无法检查其状态，则拒绝换容器。停止的备用不会被启动。此模式失败时也只以 `:prev` 恢复 `app`，保持原来的回滚检查和健康检查。

开关为 `1` 且目标 tag 的 compose 包含备用时，第七步才走滚动切换：

1. 两个 `/healthz` 恰好一边 `ok: true` 才选主；双活拒绝操作，全断且已有容器拒绝猜测，两个容器均不存在才首次启动。
2. 从实际主容器的镜像重标 `:prev`；新镜像强制重建另一边（`--no-deps`，不重复迁移）。
3. 对主容器 `docker stop -t 10`，SIGTERM 等在途处理、落盘、放锁。
4. 在 60 秒观察窗口内等备用的 `ok: true`、`role: host`、`revision: 新 tag`。
5. 用新镜像重建原主，让它等锁，更新 `:current`。服务名与主备身份可以互换。

滚动模式健康检查或换容器失败：先停两边，完整执行既有版本判断、`rollback-guard.sh` 和 revision 核对，再以 `:prev`、`--no-deps` 重建原主，不回退迁移；失败部署始终非零退出。回滚成功后备用保持停止，修复后再次部署恢复双容器。回滚检查拒绝时按错误说明处理，不跳过保护。模式在本次第七步开始时确定，自动回滚沿用同一模式；部署和回滚期间不要修改开关。

回滚检查需要执行 `sandbox purge --all` 时，统一用 `app-cli`、实际运行容器的镜像及 `--no-deps`，不再使用单独的 `docker run --network` 绕法。服务挂载与 app 一致，purge 命令本身不读写 `var/`。同步前若服务器还是既无 `app-cli` 又无固定 IP 的旧 compose，脚本兼容其原应用 CLI 服务；已有固定 IP 却缺 `app-cli` 时拒绝 purge，先按本文件补齐共享配置与 `app-cli` 服务并确认解析结果，不运行 `up` 或改动活动容器。其他要求独占租户锁的命令仍先停 `app app-standby` 再通过 `app-cli` 运行。

手动回滚同样先停 `app app-standby`，用当前部署参数执行 `deploy/rollback-guard.sh` 核对目标镜像，通过后以 `APP_IMAGE=<已验证镜像>` 重建切换前的主服务并核对 revision。回到不认识等锁模式的旧 tag 前，必须停掉并删除备用容器，否则旧 compose 不再管理它；旧版本仍只起一份。

关闭开关、退回单容器时，安排维护窗口并保持 Caddy 双上游：先用当前部署参数停止 `app app-standby`，再以已验证的当前镜像和 `up -d --no-deps app` 只启动 `app`，核对主端口的 `ok` / `role` / `revision` 及经 Caddy 的访问均正常，确认备用已停止。然后把服务器 `.env.ops` 改为 `CADDY_DUAL_UPSTREAM=0`，再部署仍含固定网络的单容器版本；需要把 Caddy 改回单上游时，最后改为 `reverse_proxy <APP_UPSTREAM_IP>:3200`（默认 `reverse_proxy 172.30.250.10:3200`），再 validate / reload、验证访问，不能改回宿主发布端口。不能先关闭开关再指望部署脚本替正在运行的备用迁回主端口；脚本会拒绝。关闭后的手动回滚也只恢复 `app`。回退到尚无固定 IP 网络的旧版本须走下节手工流程；关闭开关、删除备用都不能使直接部署旧 tag 变安全。

<a id="rollback-before-fixed-ip"></a>

### 回退到不含固定 IP 网络的旧版本

`deploy.sh` 在任何服务器写操作之前（包括回滚检查可能触发的 purge、rsync、构建和换容器），检查目标归档的 compose；目标没有 `ipv4_address` 时，只读查询本 project 的 `app` 和 `app-standby`（含已停止容器）是否仍接着专用上游网络。任一接入即拒绝；SSH/Docker 失败、超时或返回无法识别的状态也拒绝。整个 SSH 检查限时 30 秒，各 Docker 查询限时 8 秒（另给 2 秒强杀宽限）。未采用固定网络的旧部署仍可按原流程升级/退版。开关关闭也不豁免检查。

owner 在维护窗口按以下步骤手动回滚，不用 `deploy.sh <旧 tag>` 同步旧 compose：

1. 在部署目录之外保存当前 `deploy/compose.yml`、固定网络与宿主端口参数、Caddy 配置；准备并验证目标旧镜像（可在独立目录从旧 tag 构建），保留当前部署目录。备份应用状态，明确目标镜像的 revision。
2. 用**当前 compose 与部署参数**停止 `app app-standby`。执行当前 `deploy/rollback-guard.sh <部署目录> <旧镜像> <NAME> <HOST_PORT>`，按其提示完成数据导出/其他前置处理；检查非零就停止回滚。
3. 确认备用停止，在服务器 `.env.ops` 设 `CADDY_DUAL_UPSTREAM=0`。保留当前 compose 和 `app-upstream` 网络，以 `APP_IMAGE=<已验证旧镜像>` 加原部署参数执行 `docker compose -p <NAME> -f deploy/compose.yml up -d --no-deps app`；旧镜像只启动一份，不重复迁移，不用旧 tag 的 compose 重建。
4. 逐一核对宿主主端口、`http://<APP_UPSTREAM_IP>:3200/healthz` 的 `ok` / `role`（目标版本支持时）/ `revision`，以及经 Caddy 的实际收发。全部通过后再把该镜像标记为 `<NAME>:current`。Caddy 可以保留双上游，或改为 `reverse_proxy <APP_UPSTREAM_IP>:3200`，validate / reload 后再次验证。不要改回宿主发布端口，不要断开固定网络。

自动健康检查失败回滚到 `:prev` 不受这道“同步旧 compose”检查影响：它不执行 rsync，沿用本次已经部署的 compose、固定 IP 和部署参数，仅切换镜像，仍执行既有回滚保护和 revision 检查。以上手工方式同样保留网络；未来恢复自动部署时使用含固定网络的 tag。

### 主备运维注意事项

`STANDBY_CONTAINER` 默认 `<NAME>-standby`；脚本的 `STANDBY_HOST_PORT` 默认 `HOST_PORT + 2`，compose 自身默认固定为 3212。旁路实例必须避开线上和沙箱的端口与容器名；自定义值也传给手工 compose 与巡检。catalog-fix、会话/渠道导入导出、channel-account、erp-connector、行权删除等需要独占租户锁的命令，都先 `docker compose -f deploy/compose.yml stop app app-standby`，否则备用会接过锁；操作结束再恢复两边。

`watch.sh` 两端口恰好一个 `ok: true` 正常，备用连不上正常；全断或双活连续三次告警，连续三次正常恢复，保留原去重窗口。沙箱独立探测。两个端口不能配置成相同值，切换前后均需检查巡检记录。

覆盖不了的四种情况：

- 整台服务器宕机。
- 进程卡死但锁连接仍在，锁不释放就不切换。
- 失去主身份时已经在路上的那一个请求。
- Postgres 重启期间，主进程锁视图仍为 held、按 03 R6 照发而没落库的段，新主可能再答一次，属于有告警的既有例外。

### Caddy 2.11.2 参数与边界

依据 [reverse_proxy 官方文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)，并核对 [v2.11.2 tryAgain 源码](https://github.com/caddyserver/caddy/blob/v2.11.2/modules/caddyhttp/reverseproxy/reverseproxy.go)：

| 参数                              | 作用                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `lb_policy first`                 | 按声明顺序选择可用的第一个上游。                                              |
| `lb_try_duration 15s`             | 寻找可用上游的重试预算，不是成功请求的响应总超时。                            |
| `lb_try_interval 250ms`           | 两次选择之间等待，防止两边都拒绝连接时空转。                                  |
| `fail_duration 1s`、`max_fails 1` | 一次失败排除该上游 1 秒，first 才能继续选另一边；短窗口允许接管进程重新入选。 |
| `lb_retry_match expression false` | 已连接后的失败不重发，任何方法均不匹配；拨号失败和暂时没有可用上游仍可重试。  |
| `dial_timeout 1s`                 | 限制单次拨号等待。                                                            |
| `keepalive off`                   | 每个请求重新拨号，避免复用失锁进程的旧连接及底层连接复用重试。                |

连接被拒的 POST 可以等另一个上游；已经送达的 POST 即使断开或返回 5xx，也不会由代理重发。15 秒是重试判断预算，末次拨号或等待间隔可能少量超出，不是精确请求总时限。上游必须写专用 bridge 的固定容器 IP 加 `:3200`，不能写宿主发布端口：即使等锁进程不监听，docker-proxy 也可能先接受 TCP 再重置，Caddy 视为已连接，不会重试。也不要写 Docker 容器名：容器刚被 kill / 停掉时，名称可能指向旧地址，连接后 EOF 同样不可重试。协调者已用固定 IP 直连完成 rolling 对照演练（14 发 14 收、0 reset）；仓库自测验证配置及测量逻辑，实际可用性须再跑容器演练。

服务器 Caddy 必须先升到 2.11.2 再接双上游，不能用发行版自带的旧包。2.6.2 实测（2026-11-10，同一演练只换 Caddy 镜像）：片段的 `{args[0]}` 不认，validate 能过、转发时 502；改成 `{args.0}` 后，首个上游拨号失败、改投另一边时报 `invalid Read on closed Body`，POST 丢一半，两边都不可用时立即 503。站点块里已有 `header_up` 等子指令时不整段 import 片段：上游写两个固定 IP，参数放进命名片段在 `reverse_proxy` 块内 import。

### 本机演练（协调者执行）

两种演练分开取数。需要 Node 22、pnpm；容器演练还需要本机 Docker、Compose 2.30+。进程侧 7.1–7.4 合入后执行：

```bash
# 含 Compose 文本结构/共享配置检查；不调用 Docker。
pnpm exec tsx scripts/failover-drill.selftest.ts
pnpm exec tsx scripts/failover-drill.ts kill > container-kill.json
pnpm exec tsx scripts/failover-drill.ts rolling > container-rolling.json
# 可选：仅导出当前演练栈的日志，路径相对仓库根目录，文件须尚不存在。
mkdir -p var/drill
DRILL_DUMP_LOGS=var/drill/rolling.log pnpm exec tsx scripts/failover-drill.ts rolling > var/drill/rolling.json
# PG_TEST_URL 由协调者注入：一次性 pgvector/pgvector:pg17 集群的超级用户 URL。
pnpm exec tsx scripts/failover-process-drill.ts kill > process-kill.json
pnpm exec tsx scripts/failover-process-drill.ts terminate > process-terminate.json
pnpm exec tsx scripts/failover-drill.ts report container-kill.json container-rolling.json process-kill.json process-terminate.json
```

结果文件放在仓库之外或 gitignored 的 `var/`。每次执行 stdout 只有一份 JSON，进度写 stderr；任何必要数字缺失为 null、任何检查失败或清理不完整都退出非零。每份结果含当前 `metrics`、`scopeComplete`、`cleanupComplete` 和四场景的 `acceptanceMetrics`（其他场景为 null）。离线 `report` 合并四份结果；只有四种结果各一份、数字齐全且达标、检查和清理均通过时，`acceptance10to12Complete` 才为 true。它是本节演练数字的汇总，旧进程三类写入的直接 epoch 栅栏回归仍由进程侧自测覆盖。

**容器演练只量对外可用性。** 脚本构建 drill-old、drill-new 两个 revision，使用随机 project、随机本机端口、临时随机凭据和 tmpfs PG，初始化合成旅游租户；`LLM_MOCK=1`，不读取部署 env、不调用 deploy.sh。数据库/mock 配置写入权限 0600 的临时应用 env 文件，两个常驻服务与 `app-cli` 共用，清理时删除；该文件不含等锁变量，只有常驻服务的 `environment` 设置 `TENANT_LOCK_WAIT=forever`。演练自己的临时 `.env.ops` 显式写入 `CADDY_DUAL_UPSTREAM=1`，经与 deploy.sh 共用的确认检查通过后才进入主备演练与回滚，JSON 的 `caddyDualUpstream` 记录确认结果。脚本通过 `docker network ls` / `inspect` 只读获取已有网段，从 `172.30/16`、`172.31/16` 的候选 /28 中选择无重叠子网；查不到或候选耗尽就明确报错、退出非零。先创建并标记本 project 的专用网络，再由 Compose 分配默认网络，避免自己的默认网络抢占所选网段。两个 app 都接默认网络连 PG、接专用网络取得固定 IP；Caddy 使用 host 网络并 import 同一片段，直连这两个 IP 的 3200 端口。JSON 的 `upstream` 记录 `subnet`、`appIP`、`standbyIP`。并发演练若在选网之后抢到同段，创建失败即退出，不删除其他网络。

`DRILL_DUMP_LOGS` 默认不导出；设置后，在 down 之前把本 project 的 `docker compose logs --no-color --timestamps` 写入指定文件。路径必须位于本仓库 `var/` 下（支持相对路径或该目录内的绝对路径），拒绝越界、符号链接和覆盖已有文件；父目录按需创建，文件权限 0600。写出前将本次临时密码的全部出现替换为 `[REDACTED]`。成功与失败场景均尝试导出；收集的是当时仍存在的容器日志，被重建删除的旧容器日志不在其中。JSON 的 `logDump` 记录是否请求、是否写出及相对路径；导出失败会令演练失败，但仍继续清理。输出 JSON 若也放 `var/drill/`，先 `mkdir -p var/drill` 再执行命令，shell 重定向不会替你建目录。

Colima 下 host 网络指虚拟机。演练先用 host 网络的 `probe` 在虚拟机回环地址选择三个空闲端口（主、备、Caddy），写入临时 compose env；app 重建时复用相同发布端口。Caddy 只监听虚拟机的回环地址，不配置 `ports`（[Docker 的 host 模式不支持端口映射](https://docs.docker.com/engine/network/drivers/host/)）。macOS 上的脚本通过 `docker compose exec -T probe` 在同一虚拟机网络内探测主备并经 Caddy 发消息，因此不依赖 Colima 向 macOS 自动转发 Caddy 端口，也不把 macOS 的 127.0.0.1 当成虚拟机。HTTP 客户端每次建新连接、不重试、不跟随重定向；`maxWaitMs` 在虚拟机内部从发请求到收完响应计时，不包含 Docker exec 启动开销。若探测进程失败，等待时间为 null，演练不通过。probe 与其余服务由同一个 project 的 down 一起清理；端口分配后若被其他进程抢占，compose 绑定失败即退出，不停止其他服务。

- kill：每秒经 Caddy 发一个独立 sim 会话，杀当前主；记录拿锁耗时（目标 1 秒）、拿锁到经 Caddy 健康时间（目标 5 秒）、逐条 HTTP 结果和最长等待。
- rolling：按迁移、重建备用、SIGTERM 主、验新 revision、重建原主切换，持续每秒发消息；全部有回复、最长等待目标 15 秒，切换前后恰好一个端口健康。流量统计结束后单独恢复旧版本基线，再给新备用错误 CONFIG_SOURCE、停主，验证健康超时；停坏容器，重建旧镜像，核对镜像名、revision 和 Caddy 服务恢复。

HTTP 失败不重发、不隐藏；网页一问一答不统计重复，也不查询网页历史或企微数据库行数充当去重证据。拿锁时间来自日志，缺日志为 null，可用 `DRILL_LOCK_EVENT` 对齐进程侧事件名。健康探测间隔 100ms，另有 Docker exec 调度开销；故障发起到拿锁包含 Docker 命令开销。

**进程演练量企微路径。** 两个 Node 进程都设置 `TENANT_LOCK_WAIT=forever`、`LLM_MOCK=1`，连接同一个新建测试库，共用临时 `VAR_DIR`。不运行 Docker；不改产品源码、企微地址或环境变量接口。脚本复制预加载模块到临时目录，`node --import` 在各进程替换 fetch：只把精确匹配的 HTTPS 企微 `/cgi-bin/` 请求转给本机假服务，其余 fetch 一律拒绝外联。假服务实现 gettoken、cursor 分页 sync_msg、发送账本和上传媒体；回调按真实 token 签名、AES 加密，经产品 `/wecom/callback/drill` 路由。

- kill：每秒排一条客户消息并回调两个端口（备用拒绝连接），使用独立客户会话关联每条入站。先确认主进程已回复，再挡住一条正在发送的请求，用 SIGKILL 杀主。通过测试库的 advisory 锁和 `application_name` 观察备用拿锁；首次健康、拉取和发送都完成才算恢复收发。按入站 msgid、会话、发送 msgid 和分段输出账本；合法多段算一条回复，同段多次请求保留计数，不能由假服务去重隐藏。只有故障前确认为 sending、恢复后为 unknown 的段计入 03 R5 边界，单列条数；其他缺回复或任何重复都失败。
- terminate：只终止本测试库中主进程的唯一 advisory 锁连接。记录主进程最后一次 sync_msg 相对故障的时间、TCP 明确拒绝连接的时间（两者目标 1 秒）、备用接管和恢复收发时间、旧进程退出、观察窗口、两个进程发送同一入站同一段的数量（包括换 msgid 重发）（目标 0）、失锁时在途请求数。退出前持续回调两侧并继续观察；共享 `var/` 用 fs.watch 记录 spill 创建/修改/删除，目标 0，避免文件被新主回放删除后漏检。

进程锁采样间隔 20ms，输出实际最大采样间隔和拿锁时间区间宽度；拿锁耗时取首次看到锁的上界，拿锁到恢复收发取最后一次确认未持锁到恢复的保守上界，非仅由健康推算。最长等待统计实际收到完整回复的客户，未收到的逐消息等待为 null；只有明确的 03 R5 边界可以豁免缺回复。当前分支尚无等锁代码时，在连接数据库前输出「等锁模式不可用」、未取得数字为 null、退出非零；合入后还会验证备用存活、不监听、不访问企微。

协调者须独占一次性 PG 测试集群。进程演练新建随机库和登录角色；只在基础角色不存在时创建，不修改已有角色密码，临时登录角色以 agent_app 权限执行应用。结束先停两个子进程（超时 SIGKILL），关闭假服务，再删本次库、角色和临时文件。容器演练只清自己的 project（down --volumes --remove-orphans）、镜像和临时 env，拒绝 SSH/TCP Docker endpoint。两种演练都有期限和 SIGINT/SIGTERM 清理；外部 SIGKILL 无法运行清理，Docker 清理失败按输出 project 名处理，不使用全局 prune。需要真实 PG / Docker 的演练均不进 pnpm test。
