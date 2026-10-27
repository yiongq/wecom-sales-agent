# 部署（按 git tag，rsync + Docker Compose + Caddy）

本文从 README 搬来（2026-10-27），按 09、10 补了多租户 Host 与回滚检查。服务器地址、站点域名与部署目录都不写进仓库，下文用 `<部署目录>` 指服务器上的部署目录（缺省值见 [deploy.sh](../../deploy.sh) 的 `REMOTE_DIR`）。

**首次部署前置条件**（换新服务器时逐项确认）：

1. 服务器已装 Docker（带 Compose 插件，2.30 及以上：compose 文件用 `env_file` 的 `format: raw`），且本机能 `ssh` 免密登录。服务器地址不入库：写在已 gitignore 的 `.deploy.env`（`SERVER=root@<你的服务器>`），或通过 `SERVER` 环境变量传入；**未设置时脚本直接中止**，没有内置默认值。
2. 服务器上创建 `<部署目录>/.env`（参考 `.env.example`）：至少填 `LLM_API_KEY`、`ADMIN_PASS`、`PUBLIC_BASE_URL`（发给微信客户的支付链接靠它拼完整 URL），并**显式写明 `DEPLOY_PROFILE=demo` 或 `DEPLOY_PROFILE=prod`**（不带引号）。deploy.sh 在同步之前检查它，缺 `.env` 或没写明 profile 会直接中止，不会打掉在跑的旧容器。
3. 同一目录下还有 `.env.db`、`.env.migrate`（数据库容器与迁移各自的凭据，写法见 [deploy/compose.yml](../../deploy/compose.yml) 开头），跑平台命令行时再加 `.env.platform`。应用的 `.env` 里不能有 owner、platform 或超级用户的口令，查到就拒绝启动。这几个文件都按 `docker run --env-file` 的规则读：值是 `=` 后面的整行，引号、`$`、`#` 都原样进容器，所以不要加引号和行尾注释。deploy.sh 也会查 `.env.db` 里四个口令都有、没有 `POSTGRES_DB`。
4. HTTPS 用 Caddy 反代到宿主机 3210 端口（Compose 仅绑定本机回环地址），SSE 透传；云防火墙放行 80/443。站点地址仅在服务器配置，不写入仓库。
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
2. 检查服务器 `.env`（只读），不过就中止。
3. rsync 到服务器：按内容比对，`.env*`、`var/`、日志既不发送也不删除。
4. 把备份脚本装到部署目录之外（安装位置见 deploy.sh），给正在跑的容器所用镜像打 `:prev`，再 `docker build`（把 tag 写进镜像，后台前端 `console/` 也在这一步构建），并用新镜像试读一遍 `.env`。这几步失败就中止，旧容器照常跑。
5. 跑迁移（`docker compose run --rm migrate`，顺带拉起数据库）。失败就中止，旧容器照常跑，库没有变化。
6. `docker compose up -d app` 换容器（宿主 `3210` → 容器 `3200`，挂 `var/` 卷并自动校正属主，参数都在 compose 的 `app` 服务里），给新镜像打 `:current`，然后做健康检查：`/healthz` 的 `revision` 必须等于这个 tag。第一次换成 compose 时，原来 `docker run` 起的同名容器会先按同样的方式停掉。
7. 换容器或健康检查失败时，打印容器日志，先过回滚风险检查，允许时自动用 `:prev` 回滚（`up -d --no-deps app`，不跑迁移：迁移只增不删），`:current` 改指 `:prev`，并以非零退出。回滚后 `/healthz` 报的是上一版的 tag。

`:current` 总是 app 容器在用的镜像，compose 文件不给 `APP_IMAGE` 时就用它，所以下面这些手工的 `docker compose` 命令不用带 `APP_IMAGE`。别手写 `:latest`：自动回滚之后它指向的是那个没起来的坏镜像。

换容器按 SIGTERM，Compose 宽限 10 秒；`src/shutdown.ts` 分 normal / drain / late 三段，先等在途处理，再排空写队列，最后释放资源。DB 落库来不及时写 spill，启动回放；企微在途消息仍记在 `var/wecom-cursor.json`，先重放再拉新消息，是否补发按发送账本判断。恢复边界见 [运行机制与可靠性](how-it-works.md)「企微去重、发送账本与恢复」，不把 JSON 与数据库当成原子快照。

演练回滚可以在同一台服务器上起一个旁路实例：`NAME`、`REMOTE_DIR`、`HOST_PORT` 三个环境变量同时换成和线上不同的值（只换一两个会被拒绝，免得打到线上），它的 `.env` 不能配企微凭据，否则会和线上实例抢同一个客服账号的消息。

- **密钥**：`LLM_API_KEY`、`WECOM_*` 全在服务器 `.env`，不在仓库、脚本不碰。
- **数据**：DB 模式下真实会话、消息、订单在数据库卷；`var/` 保留种子、访客、企微 cursor、spill、用量与客服二维码。文件存储下会话与订单也在 `var/`；rsync 既不同步也不删除它。DB 模式下线路的检索向量在库里（`kb_chunks`、`kb_vectors`），不再读写 `var/route-vectors.json`（文件模式照旧）；回滚到 07 之前的镜像时，旧代码照旧用那个文件，回滚后重建一次索引。
- **鉴权**：demo 作战室匿名只读，旧写接口要 `ADMIN_PASS`；成员工作台使用独立账号与角色权限（见 [后台、账号与权限](console-access.md)）。改了服务器 `.env` 要 `docker compose -f deploy/compose.yml up -d app`（或重新部署）重建容器才生效：env 只在创建容器时读一次，`docker restart` 读不到新值。
- **后台**：`/console/` 要求 `CONFIG_SOURCE=db`，并配置 `DATABASE_URL`、`DEFAULT_TENANT_SLUG`。平台凭据仅给 `platform` 服务；初始化命令见下，账号口令从 stdin 输入，勿写入命令历史。
- **备份**：宿主机 cron 每天凌晨跑部署时装好的那一份 [deploy/backup.sh](../../deploy/backup.sh)，cron 行的写法见脚本开头。导出数据库并校验、打包 `var/`，用 age 公钥加密后按日期存 7 天，配了异地目标再复制一份存 30 天。配置写在 `.env.backup`，恢复步骤写在脚本开头。装在部署目录之外，是为了回到旧版本时 cron 照样能跑。

**首次启用 DB 配置与成员后台**：先停 app、运行迁移，平台建租户，应用身份导入配置，平台建所有者账号（示例占位值请替换）。应用 `.env` 中配置前述 DB 变量；账号创建不等于导入会话。

```bash
docker compose -f deploy/compose.yml stop app
docker compose -f deploy/compose.yml run --rm migrate
docker compose -f deploy/compose.yml run --rm platform node --import tsx src/cli/tenant-create.ts --slug '<租户slug>' --name '演示旅行社' --pack travel
docker compose -f deploy/compose.yml run --rm app node --import tsx src/cli/import-config.ts --tenant '<租户slug>'
docker compose -f deploy/compose.yml run --rm platform node --import tsx src/cli/user-create.ts --tenant '<租户slug>' --email '<成员邮箱>' --name '<成员姓名>' --role owner --password-stdin
docker compose -f deploy/compose.yml up -d app
```

`--pack` 的可选值读行业包注册表（[src/packs/registry.ts](../../src/packs/registry.ts)），现有 `travel` 与 `industrial`；证明包只在 `PACK_FIXTURES=1` 时登记，线上不用。同一部署里的第二个租户还要按前置条件第 6 条设好 `public_host`。

**切换会话存储**（始终用 02 镜像）：

1. 先在 `SESSION_STORE=file` 部署，确认 `/healthz` 正常，记录 `promptHash`、`toolsHash`、`prefixHash`、`sopHash` 与会话数，备份数据库及 `var/`。
2. 停 app，准备部署目录、`var/` 之外且属主为容器 node 用户的宿主目录，挂成 `/keep`，运行导入：

   ```bash
   docker compose -f deploy/compose.yml stop app
   docker compose -f deploy/compose.yml run --rm -v '<宿主保留目录>:/keep' app node --import tsx src/cli/import-sessions.ts --tenant '<租户slug>' --keep /keep --var /app/var
   ```

3. 导入成功后在服务器 `.env` 写 `SESSION_STORE=db`，`docker compose -f deploy/compose.yml up -d app`；确认 `/healthz` 的 `store.mode=db`、四个哈希不变、会话数与导入一致，成员工作台能打开导入的会话。种子、访客仍在 JSON。
4. 若需回退，停 app、用 `src/cli/export-sessions.ts` 导出（参数与挂载同上），去掉 `SESSION_STORE=db` 再起，确认 `store.mode=file`。回退期间聊过的新消息再次切库时用 `import-sessions --resync` 合并。
5. 切换后第一份每晚备份完成恢复验证，才删除 `--keep` 原件。

**回到文件模式或更早的版本**（配置源与会话存储是两件事）：

- **10、09 之前的镜像**：库里有工业数据（工业租户、`part` 条目、工业报价单，停用、草稿、终态与重置历史都算）时，回到 10 之前的镜像会被拒绝；库里有带审批的订单时，回到 09 之前的镜像会被拒绝。两者都以**退出码 9** 拒绝，查询无法确认时同样从严，提示「前滚修复，或者回滚到另一个含 10（或 09）的 tag」；pre-10 检查先于 pre-09，既有 pre-08 条件不变。目标版本按镜像或 tag 文件树里有没有 `src/packs/industrial/runtime.ts`、`src/core/site-links.ts` 判定（[10 spec](../architecture/10-industrial-rfq-pack/spec.md) R17、[09 spec](../architecture/09-quote-approval/spec.md) R15、[回滚检查脚本](../../deploy/rollback-guard.sh)）。
- **08 之前的镜像**：回滚检查以 `src/core/order-view.ts` 是否存在判定目标版本。库里有非旅游租户、通用单（`data->>'v' = '2'`）、kind 不在 `route` / `hotel` 的条目或 source 不是 `route` 的知识块时，[回滚检查脚本](../../deploy/rollback-guard.sh) 以 **退出码 9** 拒绝，`deploy.sh` 转成 1 并透出处理步骤。先停用并清理非旅游租户及其遗留数据，确认四项都为零、重跑检查通过后再回滚；镜像目标会打印手工起目标镜像并重打 `:current` 的命令，旧 tag 则在清理并检查通过后重新部署。库或查询结果无法确认时从严拒绝，仅明确正在运行的也是 08 之前的镜像时豁免未知项，已确认存在的风险仍拒绝。若新服务器库还没建、四项都无法确认，先部署 08 之后的 tag，或确认库里确实没有这四类数据后再处理。自动回滚同样适用，被拒时会明确提示「服务当前不可用！」。
- **先查条目版本**：后台修改已上架条目后（`/healthz` 的 `config.catalogVersioned=true`），`deploy.sh` 拒绝回到 02 之前的镜像。旧镜像不写条目版本，那期间发出的方案书回到 02 后会按版本 1 显示旧价；回到文件存储也去不掉风险，只能回滚到 02 之后的镜像。检查适用于手工部署与自动回滚，健康或数据库状态看不清时从严拒绝。
- **文件配置的链接损失**：同一 02 镜像去掉 `CONFIG_SOURCE=db` 后，已发 `?v=2` 及以上的方案书全部 404，不带 `v` 的旧链接按导出时的新内容显示，不能保持历史报价；仅把 `SESSION_STORE` 改为 file、仍保留 DB 配置则不改变条目版本。当前没有对此类配置切换的专门启动告警，操作前须人工核对。
- 会话在库里时（`.env` 为 `SESSION_STORE=db` 或 `var/` 有 `sessions-in-db.json`），先用 02 的镜像回到文件存储：`docker compose -f deploy/compose.yml stop app`，跑 `src/cli/export-sessions.ts`（用法见 [deploy/compose.yml](../../deploy/compose.yml) 开头），去掉 `SESSION_STORE=db` 再起。不做这一步，deploy.sh 拒绝部署 02 之前的 tag，也不会自动回滚到 02 之前的 `:prev`（[deploy/rollback-guard.sh](../../deploy/rollback-guard.sh)）。
- 先导出后台改过的内容。导出要写进挂进容器的宿主目录，写在容器里的文件会随 `--rm` 删掉：`install -d -o 1000 -g 1000 <宿主导出目录>`，再 `docker compose -f deploy/compose.yml run --rm -v <宿主导出目录>:/export app node --import tsx src/cli/export-config.ts --tenant <slug> --out /export`。回到旧 tag 时把那一版的 `data/sop.md` 先放进这个目录（例如 `target-sop.md`），加 `--image-sop /export/target-sop.md`。
- 把三个文件拷进要部署的那条线的 `data/`，两个 JSON 用 `pnpm exec oxfmt --write data/routes.json data/hotels.json` 格式化，提交、打 tag；`.env` 去掉 `CONFIG_SOURCE=db`，再部署这个 tag。
- 那条线是换成 compose 之前的版本时，deploy.sh 不收它的 tag（否则会先把服务器上的 `deploy/` 同步删掉，到迁移那一步才失败）：在那个 tag 的 worktree 里跑它自己的 `deploy.sh`，它用 `docker run` 换掉 compose 起的同名容器。之后再部署新的 tag，换容器那一步会接管这个容器。
- 旧 deploy.sh 的 rsync 也带 `--delete`，跑之前先看它保护哪些文件。demo-v1.1 及以后的线保护全部 `.env*`（`git show <tag>:deploy.sh | grep -F 'P /.env*'` 有输出）。demo-v1 和从它切出的线只保护名为 `.env` 的那一个，会删掉 `.env.db`、`.env.migrate`、`.env.platform`、`.env.backup`：之后每晚的备份停在「缺 BACKUP_AGE_RECIPIENTS」（只记在日志里），再部署新 tag 也会在检查服务器 `.env` 那一步中止。用这种线，先把这几个文件（有几个拷几个）拷到部署目录之外，跑完立刻拷回。
- 两种线都会删掉服务器上的 `deploy/`。db 容器照常在跑，cron 跑的是部署目录之外那份备份脚本，暂时都不受影响；但 db 容器一旦重启（宿主机重启、升级 Docker）就起不来，因为它挂载的 `deploy/db-init/roles.sh` 没了，之后每晚的备份在导出那一步失败，`var/` 也不再打包。所以跑完旧 deploy.sh 立刻只把这个目录放回去：`git archive <刚才在跑的 compose 版 tag> deploy/db-init | ssh <服务器> tar -x -C <部署目录>`。别把整个 `deploy/` 放回去：`deploy/compose.yml` 不在，手工的 compose 命令就会直接报错，而不会把 `:current` 的新镜像换回来。

数据库存储并不代表可以多副本：identity map、串行锁与若干限流计数仍在进程内；DB 配置的租户锁会拒绝第二个进程，当前必须单实例运行。
