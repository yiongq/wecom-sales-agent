# 01 · Postgres 底座 + 配置入库 + 后台 v0 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。括号里是工程日估算，合计约 35 个工程日。

- [x] 1. 开工核对（0.5）：
  - 记下开工提交的 sha，验收 1 的 diff 以它为基准。
  - 逐项核对 spec「前置条件」：四个门禁接的是真实工具；格式化排除 `data/sop.md`；`profile()`；【硬性要求】身份那一行不读 profile；`promptPrefix()` 和多轮逐字节断言；`deploy.sh <tag>` 与 `/healthz.revision`。缺一项就写进 Open 并停下。
  - 查 00 是否在 `server.selftest.ts` 里断言了「prod 下 `/api/admin/stream` 匿名可连」，结论记进实施记录（验收 1 的唯一例外）。
  - 本 spec 开放问题 1（`test` 新增三组）已由 owner 于 2026-09-25 确认，无需再问。
  - 00 开放问题 3（oxlint 的 suspicious 等类别什么时候开，约定「01 开工前定」）：按 00 验收后各类别在全仓的命中数，请 owner 定，结论记进 Open。
  - 00 开放问题 1（没设 `DEPLOY_PROFILE` 却配了企微凭据时是否拒绝启动）已被本 spec 部分回答：DB 模式要求显式写 `DEPLOY_PROFILE`，缺了以 `env_invalid` 拒绝启动（验收 13）。文件模式下要不要也拦，仍由 owner 在第一个 prod 实例上线前定。
- [x] 2. 数据库骨架，还不接任何运行时代码（3）：
  - 装 drizzle-orm、drizzle-kit、pg、@types/pg、zod、@electric-sql/pglite、@hono/zod-validator，全部钉精确版本（先按开放问题 9 的规则核实版本线）；根目录的 `hono` 也改成精确版本；提交 lockfile。
  - `src/db/schema.ts`（七张表）、`client.ts`（`openDb`、`withTenant` 与 AsyncLocalStorage、会话级泄漏断言、`lockTenantConfig`、`queryCount`、`holdTenantLock`）、`migrate.ts`、`testing.ts`（`openTestDb`）。先用 typecheck 验证 `Db` / `Tx` 取 `PgDatabase` / `PgTransaction` 基类的写法对两个驱动都成立。
  - drizzle-kit 生成初始迁移，外加 custom 迁移：RLS 模板、三个触发器、五个认证函数、GRANT / REVOKE / 默认权限。
  - `lint` 加：import 边界（spec「模块与依赖方向」全部规则）；`app.tenant_id` 的出现位置与 `sql.raw`；迁移检查脚本（破坏性语句清单、已提交迁移不许改、journal 的 `when` 单调，与 `origin/dev` 的 merge-base 比较）。
  - 新建 `src/db/db.selftest.ts`，先写 PGlite 部分：迁移连跑两遍、CHECK（含哈希）、三个触发器、两个部分唯一索引、复合外键。
  - 实测 PGlite 对 `CREATE ROLE`、`SECURITY DEFINER`、`GRANT`、`sha256()` 的支持，结论记进实施记录（开放问题 2）。
  - 对应验收 7 的约束与触发器部分、20 的迁移与 import 边界部分。
- [x] 3. 真实 Postgres、本地 db 与镜像骨架（3）：
  - `deploy/db-init/roles.sql` 与 `roles.sh`（口令从环境读，可重复执行）；`deploy/compose.yml` 先写 `db` 与 `migrate` 两个服务，db 不发布端口。
  - 多阶段 Dockerfile 的骨架（`deps` / 运行阶段，`COPY drizzle`），console 阶段留到第 12 步补。
  - `db.selftest.ts` 的真实 PG 部分：建临时库、执行 roles.sql、以 owner 跑迁移；按「各角色对各表的期望」逐格断言；按系统目录检查带 `tenant_id` 的表与豁免清单；认证函数、`search_path` 与临时表遮蔽、会话级 SET 泄漏；租户锁的 `lock_held`、断连后重取与 `held_by_other`。结束时删库。
  - `test` 在有 `PG_TEST_URL` 时跑这部分；`CI=true` 而没有它时失败。
  - `ci.yml` 的 `check` job 加 `services.postgres`（`pgvector/pgvector:pg17`）并设 `PG_TEST_URL`，步骤仍只调四个门禁名。
  - 手工验证一次：去掉某张表的 `ENABLE ROW LEVEL SECURITY`，套件变红；验证完还原。
  - 对应验收 12，以及 7 的权限部分。
- [x] 4. SOP 纯内核（2）：
  - `src/tool-defs.ts`：`toolDefs` 从 `tools.ts` 搬出，`tools.ts` 再导出；`promptPrefix().tools` 字节不变。
  - `src/prompt/system.ts`：从 `buildSystemPrompt` 拆出 `renderSystemPrompt(sop)`。`buildSystemPrompt` 仍走文件，`promptPrefix()` 和 `__engineTest` 不变；用 00 的前缀测试确认哈希没变。
  - `src/sop/sections.ts`：节表、`splitSop` / `joinSop` / `sectionBody` / `normalizeBody` / `withBody` / `mergeWithImage` / `editableChars`、编码检查。
  - `src/sop/contract.ts`：17 条断言原文照抄进清单，加上 `SOP_KNOWN_FIELDS`、`KNOWN_FIELD_SOURCES` 和 `checkSopContract`。
  - 仓库加 `.gitattributes`（`data/sop.md`、`data/*.json` 设 `text eol=lf`）。
  - 新建 `src/config/config.selftest.ts`（先设临时 `VAR_DIR` 再动态 import），写这些断言：`data/sop.md` 切成 11 节并逐字节往返；每节已是规范形，GET→PUT 往返不变；各类编码问题被拒；每种 violation code 各一例；源码扫描的漂移测试；`SOP_KNOWN_FIELDS` 出现在 `KNOWN_FIELD_SOURCES` 里；当前 `data/sop.md` 零 violation。
  - 对应验收 6 的纯函数部分，以及 3 的编码部分。
- [x] 5. 产品库纯内核（1.5）：
  - `src/shared/catalog-types.ts`：`Route`、`Hotel` 及嵌套类型搬出，`types.ts` 再导出；`Route` 补上 `overseas?: boolean`。
  - `src/shared/season.ts`：`peakMonths` 搬出，`tools.ts` 再导出。
  - `src/shared/catalog.ts`：strict 的 `RouteSchema` / `HotelSchema`（`itinerary` 条数等于 `days`、`bestSeason` 可解析、不用 coerce）、`ALWAYS_LOCKED`、`LOCKED_WHEN_ACTIVE`、`lockedFieldChanges`、递归的 `mergeKeyOrder`、补丁的应用函数。
  - `searchHotels` 改成先拷贝再排序；文件模式下 `loadRoutes` / `loadHotels` 也 deep-freeze。跑全部自测，发现别的原地修改就改成先拷贝，改动记进实施记录。
  - 断言写进 `config.selftest.ts`：现有全部条目都能过 schema；锁定字段比对；嵌套键序合并；表单往返不变。
  - 对应验收 4 的文件模式部分。
- [x] 6. 配置源、启动顺序、导入导出与运行时接线（4）：
  - `src/config/source.ts`：`configMode`、`productionConfigDeps`、`initConfig`（十步，前八步只读）、`currentSop` / `currentCatalog`、`onCatalogChanged`、锁状态机、`reloadFromDb` 单飞、`configHealth`、`__configTest.reset`。启动重渲染这时先用「不一致就以 `contract_failed` 拒绝启动」占位。
  - `src/boot.ts`；`server.ts` 改成顶层 `await boot({...})`，`startWecom()` 从模块顶层挪进 boot；那五处 catch 收窄；`/healthz` 加 `config`；`store.ts` 的 `onShutdown` 加 late 阶段并导出 `gracefulExit`，登记 `markConfigShuttingDown` 与 `closeConfig`。
  - `engine.ts` 的 `buildSystemPrompt`、`tools.ts` 的 `loadRoutes` / `loadHotels` 改走配置源，签名不变；每轮日志带 `sopVersion` 与 `prefixHash`。
  - `llm.ts` 加只读的请求观察钩子。
  - 命令行 `src/cli/tenant-create.ts`（platform）、`import-config.ts`、`export-config.ts`（含 `--image-sop`、`REPEATABLE READ`）。
  - `testing.ts` 加 `installSeededConfig`。`eval/run.ts` 在 `VAR_DIR` 赋值之后加 `CONFIG_TEST_DB=pglite` 开关和 `--cases <path>`。`test` 对现有 6 组和文件模式 eval 加 `CONFIG_SOURCE=file` 前缀，eval 跑两遍。
  - 真实 PG 部分补上：node-postgres 下的逐条字节比较；以子进程执行 import / export 并断言退出码。
  - `.env.example` 补上 spec 列的变量，注明 owner / platform 连接串不写进 `.env`。
  - 对应验收 1、2、3、4、13、14，以及 21 的自动部分。
- [x] 7. SOP 编辑流程（3）：
  - `src/db/repo/sop.ts`、`repo/audit.ts`；`src/config/sop.ts` 实现草稿（`rev`）、锁定节 422、检查（200 带 violations）、发布事务（配置写锁、三方 rebase、合并后写回 `sections`、发布时分配版本号、四个哈希与 `render_inputs`）、回滚（目标状态校验、`sameHashAsTarget`）、丢弃、审计。提交之后才替换缓存。
  - 启动重渲染从占位改成真实实现：完整性、渲染两遍、每次启动都跑契约、按 `render_inputs` 定 `causes`、最后一步才写入。
  - 对应验收 5、6、7 的其余部分、8，以及 10 的 SOP 部分，都先在 PGlite 上用函数调用测。
- [x] 8. 产品库编辑流程（2）：
  - `src/db/repo/catalog.ts`；`src/config/catalog.ts` 实现新建（draft）、字段级补丁（`rev`、锁定字段、递归键序、请求原值）、上架、23505 映射、审计 diff。
  - 提交之后用 `RETURNING` 的行调 `applyCatalogRow()`；COMMIT 结果不明时 `reloadFromDb()`。
  - 命令行 `src/cli/catalog-fix.ts`。
  - 对应验收 9，以及 10 的产品库部分。
- [x] 9. 检索（0.5）：
  - `invalidateIndex()`、按代际丢弃、失败退避重试、`indexHealth()`；缓存改成 tmp 加 rename 写入，格式不变。
  - `retrieval.ts` 注册 `onCatalogChanged`。
  - 计数的假 embedding 服务写进 `config.selftest.ts`。
  - 对应验收 11。
- [x] 10. 鉴权与账号命令行（2.5）：
  - `src/auth/password.ts`：scrypt、`maxmem`、并发上限 2 加 2 秒排队、假哈希、`needsRehash`。
  - `src/auth/session.ts`：`login` / `resolveSession` / `logout` / `csrfFor`，外加三路登录限流（LRU、IPv6 /64）和无效 cookie 的按 IP 限流。
  - `src/db/repo/auth.ts` 包装五个认证函数。
  - 平台命令行 `user-create`、`user-password`、`user-disable`、`member-role`、`member-remove`（口令只走 stdin 或 `/dev/tty`）。
  - prod 下 `/api/admin/stream` 要求有效后台会话。
  - 在目标服务器上实测两个并发登录的耗时和内存（开放问题 4），记进实施记录。
  - 对应验收 15 的函数部分。
- [x] 11. 后台接口子应用（2.5）：
  - `src/shared/console-api.ts` 写请求与响应的 schema。
  - `src/console-api/app.ts` 链式注册：`securityHeaders`、`requireDbMode`、`loadSession`、`guardWrites`、权限矩阵、匿名投影（只读缓存与快照）、命名错误映射（含 23505 与 `lock_lost`）。
  - `server.ts` 用 `app.route('/', consoleApi)` 挂载，放在 serveStatic 兜底之前。
  - 新建 `src/console-api/console.selftest.ts`（先设临时 `VAR_DIR`），走 `app.request`，库用 PGlite。
  - 对应验收 5、6、9、15、16 的 HTTP 部分。
- [x] 12. console 工作区和三个核心页（4）：
  - `console/` 按 ADR-002 的栈搭起来，版本先核实再钉死（开放问题 9）；Dockerfile 补上 console 构建阶段。
  - `hc<ConsoleApp>` 客户端；页面：登录、SOP（不含 diff；过期草稿、rebase 与冲突提示；回滚哈希提示）、产品库（schema 生成的表单，锁定字段只读，只提交改过的字段，不含 CSV 导入）、审计日志；demo 匿名只读横幅。
  - `format:check` / `lint` / `typecheck` 覆盖 `console/`；`test` 末尾做生产构建并扫描产物；typecheck 范围内放 `@ts-expect-error` 夹具。
  - 实测开放问题 3（类型引用的耗时与冲突）和 8（`__Host-` 在本地 http 下的表现）。
  - 对应验收 17 的产物与类型部分、22。
- [x] 13. 会话只读列表：接口和页面（0.5，可砍）。
- [x] 14. SOP 的逐节 diff 视图：`@codemirror/merge`（1，可砍）。
- [x] 15. 产品库 CSV 导入：接口和页面（1，可砍）。
- [x] 16. 部署收尾（1.5）：
  - `deploy/compose.yml` 补上 `app` 与 `platform` 服务，按服务分 env，镜像名用 `APP_IMAGE`。
  - `/console` 的托管与 SPA 回退、安全头。
  - `deploy.sh` 的换容器改成 `docker compose up -d app`，回滚用 `--no-deps` 起 `:prev`。
  - `deploy/backup.sh`：超级用户经 socket 导出、TOC 与行数校验、age 加密、7 天本地轮转、异地 30 天与未配置告警。
  - 对应验收 17 的镜像部分，以及 23 的环境变量部分。
- [ ] 17. 演练与 demo 切换（2）：
  - 在本机 compose 上按 spec「导入、导出与回滚」完整走一遍：首次切换、两种手动回到文件模式（同一镜像、上一个 tag）、备份恢复。
  - 然后由 owner 在线上 demo 执行切换。
  - 恢复演练（验收 19）通过或不通过，以及不敏感的证据（例如 `/healthz` 哈希是否一致、四张 RLS 表的行数比对），记进本文件「验收记录」；主机、路径、异地目标等细节另记。
  - 真实模型对比（验收 21 的手动部分）按「文件 → DB → 文件」交替跑。
  - 对应验收 18、19、21、23。
- [ ] 18. 对照 spec 当前全部验收标准逐条验证，把每条的结果记在本文件「验收记录」一节
- [ ] 19. 清理临时探针与测试
- [ ] 20. owner 确认验收通过后，spec 顶部改 `Status: implemented`

## 工作量与砍法

累计估算：第 6 步结束约第 14 个工程日，第 10 步结束约第 22 个工程日，全部约 35 个工程日。

**第一级**：第 14 个工程日结束时第 6 步还没勾，就按顺序砍：

1. 第 15 步（CSV 导入）。spec 要改：接口列表去掉 `import-csv`，页面去掉 CSV 一条。
2. 第 14 步（diff 视图）。spec 要改：SOP 页去掉 diff 一条。
3. 第 13 步（会话只读列表）。spec 要改：目标 5 改成四页；接口列表去掉 `/conversations`；权限表去掉这一行；验收 16 的 `GET /conversations` 改成 404。
4. 第 11、12 步里的 demo 匿名只读：demo 的后台也要求登录，`admin.html` 仍然匿名可看。spec 要改：R15、权限表、匿名投影一段、不变量 31、验收 16 的 demo 部分、验收 22 的横幅一句。

**第二级**：第 22 个工程日结束时第 10 步还没勾，在第一级之外再砍：

1. 产品库表单只做可编辑字段，锁定字段只读展示；新建线路改用命令行 `catalog-add` 从 JSON 文件建 draft，后台只负责编辑和上架。spec 要改：产品库页面一段、验收 22 的新建一句，命令行列表加 `catalog-add`。
2. 命令行 `member-role`、`member-remove` 推到 02，`user-disable` 保留。spec 要改：命令行列表、审计表、授权表里 `agent_platform` 对 `memberships` 的 DELETE。
3. 验收 21 的手动部分推到 02，自动部分保留。

砍掉的项并入 02 的后台工作；每砍一项，都在 spec 顶部加一行 `Revisions:`，写明改了哪些目标、接口和验收编号。Hono RPC 不砍（spec 裁决 R17）。**第 2–12 步的核心和第 16、17 步不能砍**：表与角色的形状、锁定节与渲染语义、快照的字节与冻结、鉴权的存法、凭据隔离，以后都补不了；回滚和备份没有演练过，就不能切换 demo。

## 实施记录

按步骤号记下实施中的实测结论与偏离 spec 的取舍；不复述 spec。

### 第 1 步（2026-09-26）

- 开工提交：`f6f525c`（dev）。验收 1 的 diff 以它为基准；四个门禁在它上面全绿。
- 前置条件逐项核对，全部具备：`format:check` / `lint` / `typecheck` / `test` 接的是 oxfmt、oxlint + 公开边界脚本、tsc、6 组自测 + mock eval；`.oxfmtrc.json` 排除 `data/sop.md`；`profile().flags.anon_readonly_admin` 存在；`buildSystemPrompt` 不读 profile，`ai_disclosure` 只有 `always`、除启动日志外无人读取（欢迎语里的「AI 旅行顾问」是写死的）；`promptPrefix()` 已导出，`engine.selftest.ts` 有多轮与 prod/demo 逐字节断言；`deploy.sh <tag>` 只收 tag、保留 `:prev`，`/healthz` 返回 `revision`。
- 00 断言过「prod 下 `/api/admin/stream` 匿名可连」：`server.selftest.ts` 的 `PUBLIC` 表含这一项，按「prod 下有意匿名可达：/api/admin/stream 返回 200」检查。验收 1 的唯一例外成立，第 10 步把这一项改成 401。
- 00 开放问题 3 已由 owner 定（见 Open），同一步落地：`.oxlintrc.json` 开 suspicious，关掉 4 条规则；`**/*.selftest.ts` 与 `eval/run.ts` 另外豁免 `no-array-sort`、`no-array-reverse`，因为验收 1 锁住了它们的 diff。业务代码 39 处命中：`sort` / `reverse` 改成 `toSorted` / `toReversed`（都是对临时数组取返回值，语义不变；`searchHotels` 由此已不再原地排序，第 5 步那一条只剩 deep-freeze），`[...arr].sort` 去掉多余的拷贝；两处读 JSON 失败的 `throw` 带上 `cause`；5 处字面量拼接合成一个字面量（字节不变）；两处 `no-unmodified-loop-condition` 是误报（标志在回调或并发调用里改），加行内豁免并写明原因。`toSorted` 要 ES2023 的类型，`tsconfig.json` 的 `target` 从 ES2022 升到 ES2023（只影响类型检查，tsx 不读它）。
- 改完 `PREFIX sha256` 仍是 `system=6c202d63…a423 tools=64c16fc8…92d1`，与 00 记录相同；各组断言数不变（wecom 461、dejargon 333、price-guard 403、server 269，eval mock 19/19）。

### 第 2 步（2026-09-26）

- 版本（开放问题 9，按 npm `latest`）：drizzle-orm 0.45.3、drizzle-kit 0.31.11（1.0 仍是 rc，不取）、pg 8.23.0、@types/pg 8.23.1、zod 4.6.5（v4，自带 `z.toJSONSchema`）、@electric-sql/pglite 0.5.8、@hono/zod-validator 0.9.1；根目录 `hono` 钉成 4.13.9。
- 开放问题 2 的结论：PGlite 0.5.8（内核 PG 18.3）支持 `CREATE ROLE`、`GRANT`、`ALTER DEFAULT PRIVILEGES`、`SECURITY DEFINER`、`sha256()` 与触发器，`SET ROLE` 到非超级用户后 RLS 也生效。`openTestDb()` 因此不跳过任何语句：建三个角色，把库的属主改成 `agent_owner`，`SET ROLE agent_owner` 跑迁移，表和函数的属主、默认权限、授权都与生产相同；默认连接仍是超级用户。PGlite 是 PG 18，CI 与 compose 是 17，RLS 与授权的结论仍以第 3 步的真实 PG 套件为准。
- `Db` / `Tx` 的写法经 typecheck 验证：两个驱动都能赋给 `PgDatabase<PgQueryResultHKT, Schema>`；`PgTransaction` 的第三个类型参数默认是空 schema，`Tx` 要显式写 `ExtractTablesWithRelations<Schema>`。
- spec 没写、此处取定的地方：
  - `catalog_items_guard` 也禁止改 `id`（spec 只列了 `tenant_id`、`kind`、`code`、`ord`）。
  - `auth_session_touch`：会话属于别的租户时一律只返回空、不删行，哪怕它已经过期，不碰别的租户的数据。
  - 会话绝对期限写成 `interval '168 hours'` 而不是 `'7 days'`：timestamptz 加「天」按调用方时区的日历天算，跨夏令时差一小时（审查发现，自测在 `America/New_York` 下断言 168 小时）。
  - `audit_log_by_tenant` 显式写 `id DESC NULLS FIRST`：drizzle 的 `desc()` 默认生成 `NULLS LAST`，与 spec 的 `id DESC` 不一致，`order by id desc` 会多一次排序（审查发现）。
  - `withTenant` 发现会话级泄漏时，node-postgres 下 `release(true)` 销毁连接；PGlite 只有一条连接，退化为 `RESET` 租户设置。
  - 连接池给每条连接挂常驻 `error` 监听。借出的连接 Pool 不替它监听，`withTenant` 进行中库重启、连接被踢或事务空闲超时，都会以未处理的 `error` 事件让整个进程崩掉（审查发现，已在本机 PG 17 容器上复现，并验证修复后 `withTenant` 正常 reject、连接池照常可用）。
  - `holdTenantLock`：`reacquire` 单飞；锁连接还健康时直接返回 `ok`；重连期间被 `release` 会放掉新拿到的锁；锁连接 4 秒连接超时；首次取锁时查询本身出错照原样抛，不当成「锁在别人手里」。同样在 PG 17 容器上验证过：连接被踢后 `onLost` 触发一次，并发两次 `reacquire` 都是 `ok`，别的进程仍拿不到锁，`release` 之后别人能拿到。
  - `migrate.ts` 发现当前用户不是 `agent_owner` 就拒绝执行：换成超级用户跑，建出来的对象归超级用户，FORCE RLS 与权限表都不成立。
  - lint 的两处放宽：`app.tenant_id` 允许出现在 `src/db/**/*.selftest.ts`（RLS 套件要做会话级 SET 来测泄漏）；「配置层不 import 运行时模块」对 `*.selftest.ts` 豁免（spec 要求这些自测动态加载会连带 `store.ts` 的模块）。另外 `app.tenant_id` 也查所有 `.sql`（第 3 步的 `roles.sql` 在内）。
  - 迁移的标注写法：语句正上方的 `--` 行写 `-- migration-allow: <规则>[, <规则>…] <理由>`，规则名 drop、rename、alter-type、add-not-null、set-not-null、add-check、create-or-replace、alter-policy、revoke、execute；缺理由本身算违规。`DO` 块里字符串的内容也按规则查，其中的 `EXECUTE` 一律要标注（审查发现动态 SQL 能绕过）。`0001_rls_auth.sql` 里 `ALTER DEFAULT PRIVILEGES … REVOKE` 已标注。
  - 公开边界检查的误报：新装依赖的 sha512 integrity 哈希偶然撞上私有词表里的一条正则。扫描前把锁文件里的 integrity 值抹掉，包名与 registry 地址照查，行号不变（`19f00a2`）。
  - `drizzle/meta/**` 排除在格式化之外（drizzle-kit 每次生成都整份重写 `_journal.json`）；新增 `pnpm db:generate`；`tsconfig` 纳入 `drizzle.config.ts`。Dockerfile 还没有 `COPY drizzle`，第 3 步补。
- 验证：`db.selftest.ts` 的 PGlite 部分 139 条断言，约 1.3 秒。断言尽量点名是哪条约束或触发器拒的，只比错误码时，一条约束拆掉、别的约束碰巧也拦得住，断言照样绿。变异测试拆掉约束、触发器分支、认证函数里的租户判断与恢复等 20 余处，每一处都让套件变红。验收 20 的 lint 部分在真实仓库上手工验过：迁移里加未标注的 `DROP COLUMN` 或 `SET NOT NULL`、`src/shared/` 引 `drizzle-orm`、`src/config/` 引 `store`、`src/db/` 以外出现 `app.tenant_id`，都失败并点名文件。「修改已提交的迁移」要等迁移进了 dev 才有基准，第 3 步开工时在真实仓库上复验（脚本已在临时仓库里验过）。
- 提交前做了一轮五个角度的对抗审查（SQL 与 spec 对照、安全、连接层、lint 脚本、测试充分性），确认 9 条，都已修掉（上面标了「审查发现」的几条，加上 4 处测试漏洞）；驳回 6 条，例如「`execute(string)` 能绕过 `sql.raw` 禁令」：spec 只禁 `sql.raw`。

### 第 3 步（2026-09-26）

- 开工时补验了第 2 步留下的一条：迁移进了 dev 之后，往 `drizzle/0000_init.sql` 追加一行，`lint` 失败并点名这个文件（验收 20）。
- `deploy/db-init/roles.sql` 是 `roles.sh` 与自测共用的契约：每条语句一行，变量只有三个口令和 `:"db_name"`。已存在的角色把行首 `CREATE ROLE` 换成 `ALTER ROLE`，已存在的库跳过 `CREATE DATABASE`；`roles.sh` 用 sed 做这个替换，自测用同样的规则逐行执行。比 spec 的 DDL 多两处：`agent_owner` 也写 `NOCREATEDB`，重跑时能纠正被改过的属性；加一行 `ALTER DATABASE … OWNER TO agent_owner`，库已存在但属主不对时（例如误设了 `POSTGRES_DB`）改回来。
- `roles.sh`：必须带可执行位（entrypoint 会 source 不可执行的脚本，脚本发现被 source 就拒绝执行）；口令用 psql 的 `\getenv` 读入，不上命令行；会话里设 `VERBOSITY terse` 与 `log_min_error_statement = panic`，语句出错时口令不进 psql 输出和 `docker logs`（实测过：不设时出错的 `ALTER ROLE … PASSWORD` 会写进服务端日志）。`roles.sql` 不能放进 `initdb.d`（entrypoint 会直接执行那里的 `*.sql`），compose 把 `db-init/` 挂到 `/db-init`，脚本另挂成 `initdb.d/10-roles.sh`。
- compose 的 env 文件放在服务器的仓库根目录：`.env.db`（超级用户与三个角色的口令）、`.env.migrate`（`DATABASE_OWNER_URL`）。这个命名已被 `.gitignore`、lint 的路径黑名单和 `deploy.sh` 的 rsync 保护规则覆盖，`.dockerignore` 补了 `.env.*`；放进 `deploy/env/` 会被下一次部署的 `rsync --delete` 删掉。db 的健康检查走 TCP：首次初始化时 entrypoint 的临时服务只开 socket，按 socket 探测会在建角色之前就报健康。项目名固定为 `wecom-sales-agent`。已知的小问题留给第 16 步：`image: ${APP_IMAGE:?}` 让不带 `APP_IMAGE` 的 `docker compose ps` 也报错。
- Dockerfile 拆成 `deps` 与运行两个阶段，运行阶段加 `COPY drizzle`，其余照旧；console 阶段留到第 12 步。
- 本机 docker 端到端验过：镜像能建，`/app/drizzle` 在，pnpm 的符号链接完好；空数据卷上 `run --rm migrate` 先拉起 db、等健康、以 `agent_owner` 迁移，退出 0，重跑也是 0；三个角色的属性、库的属主与编码、PUBLIC 没有 CONNECT 与 TEMP 都对；db 不发布端口。口令轮换从 compose 网络里另一个容器验证（容器内 127.0.0.1 是 trust，在里面试口令什么都证明不了）：改 `.env.db` 并重建 db 之后、跑 `roles.sh` 之前，旧口令仍有效；跑完之后旧口令失效、新口令可用；原样再跑一遍仍是 0。
- `db.selftest.ts` 的真实 PG 部分：有 `PG_TEST_URL` 才跑，`CI=true` 而没有它时失败。临时库建在 `PG_TEST_URL` 指向的集群里，跑完删掉；三个角色是集群级的，已存在就改口令，所以它只能指向专用的测试集群（CI 的服务容器，或本机的一次性容器），CONTRIBUTING 写了本机怎么跑。覆盖验收 12 全部条目与验收 7 的权限部分；另外核对了库级权限、角色属性、`agent_app` 登录后带着两个超时、函数的 EXECUTE 授权、迁移身份检查，以及 json 经 node-postgres 读回键序不变。系统目录那组检查加强为「每张 RLS 表只有一条策略、对所有命令和角色生效、USING 与 WITH CHECK 都是租户模板」：光看策略名，一条 `USING (true)` 的同名策略也能通过。
- 本机 PG 17 上整组 268 条断言（PGlite 150、真实 PG 118）全过，连跑两遍（第二遍角色已存在，走 `ALTER ROLE`）也全过，临时库都删干净了。手工验证：去掉 `catalog_items` 的 `ENABLE ROW LEVEL SECURITY`，10 条失败；新增一张带 `tenant_id` 却没开 RLS 的表，6 条失败；`CI=true` 而没有 `PG_TEST_URL`，失败。验证完已还原。

### 第 4 步（2026-09-26）

- `toolDefs` 原样搬到 `src/tool-defs.ts`，`tools.ts` 再导出同一个数组；`renderSystemPrompt(sop)` 从 `buildSystemPrompt` 拆到 `src/prompt/system.ts`（前缀缓存那段说明随之搬过去），`buildSystemPrompt` 仍读文件。`PREFIX sha256` 仍是 `system=6c202d63…a423 tools=64c16fc8…92d1`，与 00 记录相同。
- spec 没写、此处取定的地方：
  - `splitSop` 自己先做编码检查，再查结构与规范形：每个入口（导入、镜像的 `data/sop.md`、库里拼回来的 SOP）都经它，不靠调用方记得先查编码。
  - 行尾空白按 JS 的空白类去（含 NBSP、U+3000），换行除外。`normalizeBody` 在去空白之前先查孤立代理项、控制字符和行分隔符：否则行尾的 U+2028 会被 `trimEnd` 当空白悄悄删掉，而 spec 要求这几类直接拒绝。
  - `mergeWithImage` 对从库里取的可编辑节，按当前节表重建标题行与结尾：节表改了标题、在末尾加了节时拼出来仍能切回去；节表不变时与原文逐字节相同。
  - `checkSopContract` 多一个可选的 `spec` 参数（默认旅行节表）；结构违规按节报；`phrase_forbidden` 的 `sectionKey` 取第一个含该短语的节，只出现在硬性要求里时为 null；预算按「> 基线 × 1.2」精确比较，结构不对时不算预算。
  - `SOP_KNOWN_FIELDS` 取 SOP 现在点名的 10 个字段，加上工具参数里的 `maxBudgetPerPerson`、`maxNightlyPrice`、`routeId`，共 13 个。按 spec 的正则，`iPhone`、`eSIM` 这类小写开头的驼峰词在可编辑节里也会报 `unknown_field`；现在的 `data/sop.md` 没有这类词，先照 spec 执行，运营真碰到再议。
  - 仓库加了 `.gitattributes`。
- 源码里的特殊字符一律写成 `\u` 转义：写文件的工具会把输入里的 `\uXXXX` 先解码成真实字符，第一版 `sections.ts` 就这样混进了它自己要拒绝的 U+2028。顺带发现 `src/retrieval.ts` 的索引指纹用真实的 NUL / SOH 字符做分隔符（git 因此把它当二进制），换成了 `\u0000` / `\u0001` 转义，字符串的值与指纹都不变。
- `src/config/config.selftest.ts` 106 条断言，已接进 `test`。两条漂移守卫按 AST 扫描而不是正则：`engine.selftest.ts` 里 `sys` / `sop` 的每一处用法都必须认得出，`buildSystemPrompt()` 必须赋给 `sys` 或 `sop`，格式化器把长短语折成多行也照样认；`SOP_KNOWN_FIELDS` 只认源文件里的标识符与字符串字面量，注释里提到不算。手工验证（验收 6 的两条）：在 `engine.selftest.ts` 里加一条没进清单的 `sys.includes('…')`，测试失败并点出这个短语；在锁定节里点名 `routeMissReason`，测试失败并点出它。另验过：被 oxfmt 折行的长短语、换了变量名的断言、只在注释里还留着的旧字段名，都会失败。
- 提交前的对抗审查（spec 对照、构造边界输入、变异测试）确认 9 条，都在测试与漂移守卫上，已修；切分、规范化、契约逻辑本身没有确认成立的缺陷。驳回的包括 `iPhone` 这类词被当成字段（spec 规定如此）、零宽字符不在编码检查的拒绝清单里（spec 的清单里没有）。

### 第 5 步（2026-09-26）

- `Route`、`Hotel` 连同 `SalesSegment`、`SALES_SEGMENTS` 搬到 `src/shared/catalog-types.ts`（`Route` 补上 `overseas?`），`peakMonths` 搬到 `src/shared/season.ts`，`types.ts` 与 `tools.ts` 再导出，原有 import 不用改。
- `src/shared/catalog.ts` 的 schema 比 spec 多几处收紧，现有 20 条线路、23 家酒店全部满足：`id` 与库里 `code` 的 CHECK 同一条正则；`highlights`、`segments` 至少一项；所有字符串非空；`itinerary` 必填，天号从 1 起连续（方案书和行程书按它排）。`tags` 允许为空。
- `mergeKeyOrder` 按「定义」而不是「赋值」写键：请求原文里的 `__proto__` 只是个普通键，随后被 strict schema 拒掉，不会改掉结果对象的原型。`applyCatalogPatch` 遇到同一字段既 `set` 又 `unset` 直接拒。
- `deepFreeze` 放在 `src/shared/freeze.ts`；已冻结的对象也往下走（子对象未必冻结），用 `WeakSet` 防环。文件模式下 `loadRoutes` / `loadHotels` 返回冻结对象后，全部自测照常通过，没有发现别的原地修改；`searchHotels` 在第 1 步已改成 `toSorted`。grep 过对条目对象的赋值、`push` / `splice` 与 `Object.assign`，也没有。
- `config.selftest.ts` 增至 154 条：现有条目都过 schema、14 种不合规被拒、锁定字段比对（含「国内」这一项、只换键序不算改、draft 只锁 `id`）、嵌套键序合并、补丁、每条线路和酒店的表单往返逐字节不变、验收 4 的文件模式部分。
- 提交前的审查 agent 没跑起来（子 agent 撞上了每周用量上限），改为自己做变异测试：拆掉冻结的递归、跳过已冻结的父对象、按赋值写键、忽略「国内」、数组不递归合并、丢掉新增键、不查天数、酒店 schema 不 strict、酒店不冻结，全部变红。「锁定字段按 JSON 比较」一条存活，是等价变异：锁定表里没有对象类型的字段。「不查天数」起初存活（测试删的是第一天，被天号检查先拦下），已改测试。

### 第 6 步（2026-09-26）

- `src/config/source.ts` 按 spec 的接口实现，多出来的几处：`ConfigDeps` 多两个可选项 `closeDb`（失败与停机时关连接池，spec 的接口里没有）和 `imageDataDir`（启动日志点名差异用）；`initConfigFromEnv` 包住「先校验 `CONFIG_SOURCE`、是 db 才构造依赖」；`assertConfigWritable()` 给第 7、8 步的写函数在锁丢失时抛 `ConfigLockLostError`；`prefixSummary()` 给 `/healthz`；`__configTest.setTimings()` 把重取锁间隔和重读退避调短，测试不用真等几秒。`applyCatalogRow`、`replacePublishedSop` 留到第 7、8 步和写函数一起加。
- 启动重渲染的写入（第 9 步）按 plan 先占位：渲染结果与存下来的不同就以 `contract_failed` 拒绝启动；`render_inputs` 的比较与 `causes` 已经算好，日志点名是哪类输入变了（`hard_rules` 等），第 7 步接上写入。
- `productionConfigDeps` 只把值非空的 `DATABASE_OWNER_URL` / `DATABASE_PLATFORM_URL` / `POSTGRES_PASSWORD` / `AGENT_*_PASSWORD` 算作特权凭据（`.env` 里留着空模板不算）。`env_invalid` 不回显非法的 `CONFIG_SOURCE` 值，除非它是个短词：冒烟时把整行环境变量配到了它上面，消息里就带出了连接串口令。
- 导入导出的逻辑在 `src/config/transfer.ts`，三个命令行（`tenant-create`、`import-config`、`export-config`）只做参数、环境与退出码。读 `sop.md` 一律按字节严格解码（新增 `decodeSopFile`）：`fs.readFileSync(…, 'utf8')` 会把非法 UTF-8 字节（编码过的孤立代理项）悄悄换成 U+FFFD，坏文件就被当成合法的导入了，自测当场抓到。导入的一致性判定两边按同一顺序比较（库里读出来 hotel 排在 route 前面）。
- 运行时接线：`server.ts` 顶层 `await boot({...})`，`startWecom()` 挪进 boot、在监听之后；`store.ts` 的 `onShutdown` 加 `{ phase: 'late' }`，导出 `gracefulExit`，SIGTERM 与「锁被别的进程拿走」走同一条路；五处 `try { loadRoutes() } catch {}` 收窄为 `ConfigNotReadyError` 照常抛；`/healthz` 加 `config`；引擎 DB 模式每轮一行日志带 `SOP v<n> · 前缀 <12 位>`，慢轮日志两种模式都带（文件模式记 `SOP file`）；`llm.ts` 加只读的 `observeRequests`。
- `testing.ts` 的 `installSeededConfig` 以 agent_app 身份导入并装载（之后这条 PGlite 连接一直是 agent_app，运行时读写受 RLS 约束），配 `fakeLock()` 可控的假锁。`eval/run.ts` 只多两处：`CONFIG_TEST_DB=pglite` 开关（装上配置源，并核对每个请求的 system 与 tools 哈希等于 `/healthz` 报的，22 个请求 0 个不符）和 `--cases`。`test` 对原有 6 组和文件模式 eval 加 `CONFIG_SOURCE=file`，eval 再以 DB 模式跑一遍，也是 19/19。
- 验收覆盖：验收 1（与 `f6f525c` 相比原有自测、适配器自测、`eval/cases.json` 零 diff，`eval/run.ts` 正好两处改动）；验收 2（PGlite 上全部四项，16 个观测项逐字节相同；node-postgres 上重做前两项）；验收 3（往返、七类坏文件、重复导入、内容不一致 → 2、持锁 → 3、`--dry-run`，真实 PG 上以子进程跑三个命令行；「先以 DB 模式启动产生 rerender 版本再导入仍是 0」要等第 7 步的重渲染写入）；验收 4、13（全部分支，含库里多一条迁移时照常启动并 warn、连接串口令不进日志、企微 cursor 不动）、14，以及 21 的自动部分。
- `config.selftest.ts` 247 条、`db.selftest.ts` 真实 PG 上 282 条。另在本机 pgvector:pg17 容器上按生产路径端到端走了一遍：roles.sql → 以 agent_owner 迁移 → `tenant-create` → `import-config` → `CONFIG_SOURCE=db` 起服务器，`/healthz` 报 `mode: db` 且哈希与文件模式相同，网页对话正常；第二个实例以 `lock_held` 拒绝启动；SIGTERM 优雅退出后锁释放，第三个实例正常装载。
- 子 agent 仍撞在每周用量上限上，审查改为自己做变异测试：不查完整性、拿不到锁照常启动、不查迁移、不查特权凭据、快照不冻结、锁丢了不标 lost、重读不单飞、不查 active 线路、导入不严格解码、导入不查锁定节、DB 模式下酒店仍读文件、装载失败后仍监听，全部变红。其中「酒店仍读文件」起初存活（两种模式数据相同，等价比较分不出来），已补「`loadHotels()` 返回快照本身」一条。

### 第 7 步（2026-09-26）

- `src/config/sop.ts` 按 spec 的接口实现，另加两个错误类：`SopRevConflictError`（草稿 rev 对不上、草稿或发布版本在打开之后变了 → 409）和 `SopInputError`（点名不存在的节、变更说明为空 → 422）。写函数共用一个外壳：先确认持着租户锁（`assertConfigWritable`），再开事务、取配置写锁；回调跑完而 COMMIT 抛错时结果不明，调 `reloadFromDb()`。提交之后才 `replacePublishedSop()`。
- 与验收 6 对齐的一处取舍：草稿保存只做规范化与编码检查（编码不合格直接拒，jsonb 也存不下），空正文、行首「## 」照存，由检查报 `structure`、发布时拒绝。为此 `sections.ts` 拆出不查结构的 `rebuildSection`，`mergeWithImage` 也改用它：结构合规与否统一交给契约检查，合法数据的合并结果逐字节不变。
- 启动重渲染从占位改成真实写入：全部只读检查和产品库装载都通过之后，一个事务里归档旧版本、发布 `source='rerender'` 的新版本（运营编辑的可编辑节原样保留）、写一行 system 审计（`causes`、新旧版本号与 `prompt_hash`）。
- 每个租户只能有一份草稿，「草稿打开期间别人发布了改动」在测试里用回滚制造：回滚直接插入已发布版本，草稿的 `based_on` 随之过期，发布时走三方 rebase。
- `config.selftest.ts` 增至 295 条，覆盖验收 5、6（五种草稿，另加 `create_refund`）、7 的其余部分、8（锁定节、硬性要求、工具定义三种输入各自的 `causes`；契约不过、`toolNames`/`knownFields` 去项、渲染不确定、没有 active 线路时库都不变）、10 的 SOP 部分，以及验收 3 最后那条（有 rerender 版本之后再导入仍是 0）。自己做了 10 个变异（发布后不换缓存、rebase 不取上游、不报冲突、发布不过闸、能保存锁定节、`sameHashAsTarget` 恒真、预算基线取自己、不写 rerender、重渲染丢了可编辑节、能回滚到草稿），全部变红。

### 第 8 步（2026-09-26）

- `src/config/catalog.ts` 按 spec 的接口实现：新建（draft，ord 取最大加 1，同 code 报 `catalog_code_taken`）、字段级补丁（rev 乐观锁；锁定字段按状态查，`unset` 锁定字段同样算改；写库的是旧 payload 应用补丁后按旧键序递归合并的对象，合并后整条再过 schema）、上架（重新过 schema；已上架的原样返回，不写库、不动快照）。唯一约束一律映射成 409。审计 `diff` 只放变了的顶层字段，原样提交回去时为 `{}`，但仍记一行。
- `source.ts` 加 `applyCatalogRow`：快照数组不带 ord，另存「code → ord」，替换同 code 的条目或按 ord 插入新上架的条目。快照代际改为「当前快照的代际加 1」：原先用模块级计数器，测试里重新装载后新快照从 0 起、计数器却接着涨，自测抓到。
- `catalog-fix` 的逻辑是 `fixLockedFields`（放宽到可以改 `LOCKED_WHEN_ACTIVE`，`id` 除外），命令行负责取租户锁、打印警告、退出码 0 / 1 / 3。
- `config.selftest.ts` 增至 337 条，覆盖验收 9（12 个锁定字段逐个点名、`unset` 锁定字段、改 highlights 只动这一处且 `get_route_detail` 立即返回新内容、表单重排键序后只改 `itinerary[0].detail`、原样提交审计 diff 为空、四类不合格补丁、draft 除 `id` 外都能改、上架后按 ord 进快照、允许的编辑前后方案书报价不变、`catalog-fix` 重启后快照是新值）与验收 10 的产品库部分（同 rev 第二次 PATCH 409、并发同 code 一个 409、并发不同 code 拿到不同 ord）。真实 PG 上以子进程验了 `catalog-fix`：应用持锁时退出码 3，停掉后 0，重新装载后是新值，审计带 reason。9 个变异（不查锁定字段、不按旧键序合并、补丁后不过 schema、提交后不更新快照、不查 rev、新建 ord 固定、审计记全部字段、快照不更新、catalog-fix 能改 id）全部变红。

### 第 9 步（2026-09-26）

- `retrieval.ts`：`buildIndex()` 改成单飞的构建循环，开始时记下快照代际、结束时代际变了就丢掉结果按新快照再建；DB 模式下失败保留过期标记，按 30 秒、2 分钟、10 分钟退避重试（首次构建失败同样如此）；`invalidateIndex()` 只在 DB 模式下起作用，标记过期并安排重建，旧索引继续服务；`indexHealth()` 多报一个 `stale`；缓存改成先写临时文件再 rename，格式和指纹不变。模块加载时登记 `onCatalogChanged(() => invalidateIndex())`。文件模式的行为与原来相同：建过就不再建，失败不重试。
- `__configTest.reset()` 不再清空 `onCatalogChanged` 的监听者：它们是模块加载时登记的，模块不会再加载一次，清掉之后检索就收不到快照变化了。
- 验收 11 的测试用一个计数的假 embedding 服务（只数建索引的请求，按字符码位生成向量，用罕见字让某条线路排第一）。embedding 走的网关自己会重试 5xx，所以「构建失败」要让假服务持续失败，看到过期之后再放行。`config.selftest.ts` 增至 352 条，连跑三遍稳定。6 个变异（不丢过期结果、不登记回调、文件模式也失效、失败不重试、失败不标过期）全部变红，其中「失败不标过期」要靠补上的「首次构建就失败」一条才抓得到。

### 第 10 步（2026-09-26）

- `src/auth/password.ts`：参数、`maxmem`、并发上限 2 加 2 秒排队（超时抛 `PasswordBusyError` → 429）、假哈希（进程内算一次）、`needsRehash` 都按 spec。口令不做 Unicode 规范化。
- `src/auth/session.ts`：`login` / `resolveSession` / `logout` / `csrfFor` 按 spec；限流器是进程内的固定窗口计数，键数到上限按 LRU 淘汰；另导出 `allowSessionLookup` / `noteInvalidSession` 给「带无效 cookie 的请求按 IP 限流」用，`ipBucket` 把 IPv6 归到 /64、IPv4 映射地址还原成 IPv4。登录与登出各写一行审计。`logout` 多一个可选的 `now` 参数，自测用假时钟。
- 平台账号命令行的逻辑在 `src/auth/accounts.ts`，五个命令行是薄包装：口令只从 stdin（`--password-stdin`）读，或者生成后只写到 `/dev/tty`，两者都没有就退出码 1；口令至少 10 个字符（spec 没写，这里取定）。`user-create` 遇到已有账号只加成员关系、不碰口令，已是同一角色算已一致（0），已是别的角色退出码 2（换角色走 `member-role`）。改口令、停用吊销这个人的全部会话，移除成员只吊销他在本租户的会话；审计 diff 里没有口令。
- prod 下 `/api/admin/stream` 要求有效的后台会话，否则 401。`server.selftest.ts` 相应改了验收 1 允许的那一处：prod「有意匿名可达」的列表去掉这条，改为断言匿名连返回 401（断言总数不变，仍是 269）。文件模式没有账号，prod 下后台 SSE 一律 401，`admin.html` 退回 30 秒轮询。
- 新建 `src/console-api/console.selftest.ts`（55 条，已接进 `test`）：口令格式与并发上限、账号命令行、登录与 cookie 明文不入库、空闲 12 小时与绝对 7 天过期（假时钟，失效行被删）、三路限流与防探测、口令升级、改口令 / 停用 / 移除成员吊销会话、prod 下后台 SSE 要求会话。真实 PG 上以子进程跑了 `user-create --password-stdin`、`user-disable`，没有终端时拒绝执行（在终端里跑测试时跳过这一条：子进程会继承控制终端）。7 个变异（不按 IP 限流、不锁邮箱加 IP、不升级旧哈希、无效 cookie 不限流、停用不吊销会话、并发上限放宽、prod 下 SSE 不要会话）全部变红；「停用不吊销会话」起初存活（认证函数本来就不认停用账号的会话），补了「会话行也被删掉」一条。
- 开放问题 4：本机（24 GiB 内存）实测单次校验约 165 ms，两个并发约 176 ms，峰值 RSS 增量 256 MiB。目标服务器上的实测需要登录服务器，我这边做不了，挂在 Open 里。

### 第 11 步（2026-09-26）

- `src/shared/console-api.ts`：请求体、查询串、路径参数用 zod（查询串里的数字按字符串收、再转数；`set` 与新建的 `payload` 用 `z.custom` 原样放行，写库取请求原文）；响应是纯类型。配置层的领域类型（`SopVersion`、`CatalogItem`、`ContractViolation`、`ViolationCode`、`Role`）挪到这里，`src/config`、`src/sop`、`src/db/repo/auth.ts` 改成再导出，只此一份。
- `src/console-api/app.ts` 链式注册，公共中间件是 `securityHeaders`、`requireDbMode`、`loadSession`、`guardWrites`，每个路由再挂 `canRead` / `signedIn` / `canEdit` / `canAudit`。与 spec 的几处取舍：
  - 版本历史和单个版本只给成员（`signedIn`），匿名投影只含当前已发布版本；spec 的投影条款没有列历史，历史里有变更说明和姓名。
  - 没匹配上的 `/api/console/*`：匿名 401，成员 404 JSON，不落到静态文件。prod 下「匿名除登录处处 401」靠的是每个路由都挂了权限、兜底也是 401；起初另写了一个 `anonGate` 中间件，变异测试发现它删掉也没有断言变红，是冗余，删了。验收 16 点名的 `/conversations` 在第 13 步之前走兜底，同样是 401。
  - 请求体、查询串、路径参数不合规回 400 `bad_request`（带 `issues`），与命名错误里的 422（条目不合格、契约不过）区分开。登录要求 `application/json`，否则 415。
  - 命名错误映射：`sop_conflict`（带 `keys`、`current`）、`rev_conflict`、`catalog_code_taken`、其余唯一约束 `conflict` → 409；`locked_section`、`contract`（带 `violations`）、`invalid_sop`（含编码与结构错误）、`locked_field`（带 `fields`）、`invalid_item`（带 `issues`）→ 422；`not_found` → 404；`rate_limited`、`busy` → 429；`lock_lost`、`not_ready` → 503；其余 500，不带内部信息。
  - 会话 cookie 与 CSRF 按 spec；`Sec-Fetch-Site` 的判定抽成 `isCrossSite`，与 `sameOriginOnly` 共用。审计与会话里的 ip 取 `clientKey`，不是合法地址就记 null（库里是 inet）。
  - 自测要用假时钟，子应用有一个可替换的 `clock`（`__consoleTest.setClock`）。
- `server.ts`：`clientKey`、`makeLimiter`、`lookupLimit`、`sameOriginOnly` 原样搬到 `src/http-guards.ts`，两边共用同一个查询限流桶；`consoleSession` 搬进子应用，`/api/admin/stream` 照旧用它。`app.route('/', consoleApi)` 挂在 kf 二维码之后、serveStatic 兜底之前。
- 配置层补了子应用要的几样：`getSopVersion`（id 不是 uuid 格式直接当不存在，回滚同样处理，免得库报类型错误变成 500）、`src/config/audit.ts` 的 `listAudit`（按 id 倒序、before 翻页、按 action 过滤，多取一行判断有没有下一页）、`PublishedSop.publishedAt`（匿名投影要显示，放进缓存免得查库）、`configDrift()`（`/status` 的「差异」：启动日志里那份按节、按条目的差异改成可复用的函数，每次现算）。
- `console.selftest.ts` 增至 173 条，后半走 `server.ts` 的 `app.request`：cookie 属性与 `token_hash`、假时钟下的空闲与绝对过期、三路限流与防探测（逐次比状态码和响应体）、CSRF 三种拒法、viewer 的 9 个写操作与审计都 403、登出、停用即 401；发布后 `/healthz` 与下一轮 `/api/chat` 的 system 立即跟着换、回滚到 v1 的哈希相同、回滚到草稿 / 丢弃版本 / 格式不对的 id 都是 404、每个操作一行审计且记下 ip；rebase 冲突 409 带当前正文、并发首次保存一个 409；六种过不了闸的草稿、锁定节、编码不合格；产品库 11 个锁定字段逐个点名加 tags「国内」、改 highlights 与 itinerary 只动那一处且键序保持、原样提交审计 diff 为空、四类不合格补丁、draft 的新建改 id 上架、并发同 code、方案书报价不变；匿名 demo 的投影形状、不查库、没有 uuid / 姓名 / 草稿、查询限流，匿名 prod 处处 401；锁丢失写入 503 `lock_lost`；文件模式 503 `db_disabled`；十种状态码的响应都带安全头；另有无效 cookie 先按 IP 限流再查库（第 61 次不查库）。
- 30 个变异全部变红：少一个安全头、安全头排到 `requireDbMode` 之后、文件模式不拦、不查 x-csrf、不拦跨站、登录不查 content-type、写请求不要求会话、匿名读不挂查询限流、prod 匿名能读、viewer 能写、cookie 少 `HttpOnly`、登出不清 cookie、登录不用可替换的时钟、冲突不带当前正文、`lock_lost` 不是 503、锁定节回 409、锁定字段不点名、坏 JSON 不回 400、参数错回 422、兜底不分匿名与成员、版本历史对匿名开放、匿名 SOP 给全哈希、匿名 `/status` 多给字段、匿名产品库多给 `status`、审计不记 ip、版本 id 不校验格式、`/status` 的差异不报 `onlyDb`、无效 cookie 不先限流、审计翻页差一、缓存的 `publishedAt` 取建草稿时间。最后三个起初存活，各补了一条断言（无效 cookie 第 61 次不查库、恰好剩 limit 行的那一页、后台发布的版本两个时间不同）。另有两个起初靠断言里的属性访问崩溃才变红，改成可空访问，失败落在具体断言上。变异在工作区的隔离副本里跑：原地改源码会让停机钩子的 lint / typecheck 变红。
- 用一个临时的 `hc` 探针确认 `ConsoleApp` 的类型推得出来：联合响应能按字段收窄，不存在的端点、非法的 `kind` 是类型错误。探针没提交，正式的类型夹具在第 12 步。

### 第 12 步（2026-09-26）

- **工作区与版本（开放问题 9）。** `pnpm-workspace.yaml` 加 `packages: [console]`。按 npm `latest` 核实后钉精确版本：React 19.3.0、Vite 8.3.1（`@vitejs/plugin-react` 6.1.1）、TanStack Router 1.170.39 / Query 5.104.0、Ant Design 6.6.5（icons 6.3.4）、`@rjsf/*` 6.10.1、CodeMirror（state 6.7.6、view 6.43.13、commands 6.11.1）、dayjs 1.11.23，`hono` 与 `zod` 与根目录同一版本（4.13.9、4.6.5）。TypeScript 仍用根目录的 5.9（`latest` 已是 7.0，不在本阶段升级）。
- **页面。** 登录；SOP（左侧节列表，锁定节带锁、只读；右侧 CodeMirror 编辑正文；顶栏是基于哪一版、草稿 rev 与过期标记、字符预算条和「保存草稿 / 检查 / 发布 / 丢弃」；检查结果按节列 violation，rebase 与冲突单独标出，冲突时列出当前发布版本的正文；历史表可以「以此版本回滚」，哈希与目标不同时弹窗说明原因）；产品库（线路 / 酒店两个表，抽屉里是由 `RouteSchema` / `HotelSchema` 经 `z.toJSONSchema` 生成的 rjsf 表单，active 条目的锁定字段只读并注明「有报价快照后开放」，保存时只把改过的顶层字段放进 `set`、去掉的可选字段放进 `unset`，draft 可「上架」并二次确认列出将锁定的字段）；审计日志（before 游标分页、按 action 过滤、diff 展开看）。demo 匿名挂「演示只读」横幅、没有审计入口；非 owner / admin 看不到任何编辑按钮，表单整张只读。
- **客户端。** `hc<ConsoleApp>` 只经 `import type` 引服务端路由类型；写请求带 `x-csrf`（登录与 `/me` 给的值只放内存）。`unwrap()` 取 200 的响应体、其余状态抛带 `{ error, detail, … }` 的 `HttpError`。
- **门禁。** `typecheck` 改为 `tsc --noEmit && tsc --noEmit -p console`；`console/src/rpc-types.check.ts` 是 typecheck 范围内的夹具，四处 `@ts-expect-error`（不存在的端点、非法的 kind、缺 rev、没收窄的联合）。`test` 末尾 `pnpm --filter console build` 再跑 `scripts/check-console-dist.ts`：产物里搜不到 `drizzle-orm`、`pg-protocol`、`@electric-sql/pglite`，也搜不到带引号的 `node:` 模块名（压缩后的对象键 `{node:x}` 不算），index.html 的资源路径在 `/console/assets/` 下。oxlint 开 `react` 插件（关掉新 JSX 转换下无意义的 `react-in-jsx-scope`；`no-unstable-nested-components` 允许作为 props 传的 render 函数）。两处手工变异：夹具里一条不再报错时 typecheck 失败；把 `Me.displayName` 改名，`console/src/Shell.tsx` 与服务端 handler 同时报错。
- **Dockerfile。** `deps` 装整个 workspace；`console` 阶段只拷 `src/shared` 与 `console/`，`pnpm --filter console build`；运行阶段的依赖改由单独的 `rtdeps` 阶段 `pnpm install --filter wecom-sales-agent` 装，console 的依赖不进镜像（运行阶段 `node_modules` 里搜不到 react、antd、rjsf、vite、codemirror）；`COPY --from=console /app/console/dist ./console/dist`。`.dockerignore` 补上 `**/node_modules` 与 `console/dist`。本地构建镜像、以文件模式起来：`/healthz` 正常，`/api/console/*` 回 503 `db_disabled`。
- **开放问题 3（类型引用）。** console 的 tsc 连带检查服务端源码，冷跑 3.3 秒，DOM 与 `@types/node` 同时在也没有全局类型冲突，维持 `import type`，不改成 d.ts。
- **开放问题 8（`__Host-` 在本地 http 下）。** 用 Playwright 在三种内核里登录后刷新：Chromium、Firefox 在 `http://localhost` 上存下并带上 `__Host-sid`；WebKit（Safari）不存，刷新后 `/me` 401。按开放问题 8 的处理，开发服务器和 preview 改走 https（`@vitejs/plugin-basic-ssl` 自签证书），cookie 名不动；改后三种内核都能保持登录，`document.cookie` 里都看不到它（HttpOnly）。
- **CSP（与 spec 的分歧，已按下面实施，待 owner 复核）。** spec 规定的 `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'` 用在 `/console` 页面上，Ant Design 与 CodeMirror 运行时插的 `<style>` 全被拦下，整页没有样式（preview 实测 63 条违规）。处理：页面响应多一条 `style-src 'self' 'nonce-<每个响应现生成>'`，脚本仍只许本站文件；`/api/console/*` 的 CSP 不变。实现：`src/shared/security-headers.ts` 放 `consolePageHeaders(nonce)` 与 `renderConsoleIndex(html, nonce)`，vite 的 `html.cspNonce` 在构建产物里留占位符，托管页面的一方每次响应替换（preview 已按此实现，第 16 步 `server.ts` 托管 `/console` 时用同一组函数）；前端从 `<meta property="csp-nonce">` 读出交给 antd（`ConfigProvider csp`）与 CodeMirror（`EditorView.cspNonce`）。另外两处：`@rc-component/portal` 锁滚动时插的 `<style>` 不带 nonce，`console/src/setup.ts` 让 `document.createElement('style')` 出来的元素都带上页面的 nonce（只有本站脚本能调到，注入的标记仍被拦）；zod 默认会试一次 `Function('')` 探测能否 JIT，设 `jitless`。rjsf 默认的 ajv 校验器靠 `new Function` 编译 schema，CSP 下一校验就抛错，换成 `console/src/zodValidator.ts`：直接用共用的 zod schema 校验（与服务端同一份，连逐日行程条数、天号连续这类 ajv 表达不了的规则也一样），ajv 被 tree-shaking 掉（`@rjsf/core` 的测试工具 import 它，包还得装着）。改完之后 preview 在 Chromium、Firefox、WebKit 下打开 SOP 页与产品库抽屉，违规都是 0。
- **走查（验收 22）。** 本地真实 Postgres 上建库、迁移、`tenant-create`、`import-config`、建 owner / admin / viewer 三个账号，服务端以 DB 模式起、开发服务器代理过去，用 Playwright 走了一遍，截图在 [walkthrough/](walkthrough/)：匿名 demo 有横幅、没有审计入口（01）→ owner 登录看到锁定节与预算（02）→ 在「话术原则」里写进「明显超出我们现有线路的范围」，保存后「检查」按节列出 `phrase_forbidden`（03）→ 改掉、填变更说明发布，历史出现 v2 与新的 `prompt_hash`（04）→ 以 v1 回滚，生成 v3、提示哈希与 v1 相同（05）→ 产品库 active 条目的锁定字段只读、改 highlights 能保存（06）→ 新建 draft、上架前二次确认列出将锁定的字段（07）→ 审计页各有一行，`catalog.update` 的 diff 只有 `highlights`（08）。viewer 登录：没有审计入口、没有编辑按钮、编辑器与表单只读。
- 走查抓到并修掉的问题：外部替换编辑器正文时触发了 onChange，保存后本地改动被旧正文覆盖（改为给这类事务打标记、不回调）；rjsf 默认给可选的数组和对象预填空项、浏览器按 HTML `required` 拦下整张表单、`tags` 这种可以为空的必填数组不给初值（改为只预填必填项、关掉 HTML5 校验、新条目的必填数组给 `[]`、初值 memo 住）；Ant Design 6 的几处弃用（Alert `message`、Space `direction`、Drawer `width`、`List`）。
- 测试之外的临时产物（走查用的库、Playwright 探针脚本、下载的 WebKit / Firefox）都在仓库外，库已删掉。

### 第 13 步（2026-09-26）

- 没有砍。`GET /api/console/conversations` 挂 `canSeeCustomers`（所有成员，匿名在 demo 下也是 401），读现有的文件 store：按 `(updatedAt desc, id)` 排序、offset 分页（`limit` 1–100，默认 20），每条只投影 `id`、`channel`、`stage`、`handedOver`、消息条数、`updatedAt`，另给不含 `sim-` 的总数 `total` 供翻页；不列 `sim-` 会话，不带正文和画像。console 加「会话」页（成员可见，服务端分页），详情仍在 `admin.html` 里看。
- `console.selftest.ts` 增至 181 条：排序（同一时刻按 id 升序）、投影的键恰好是那六个、不带正文与画像、`total` 不含 `sim-`、逐页翻完与全量排序一致、越界空页、参数越界 400、agent 角色能看（审计仍 403）、匿名 401。7 个变异（不滤 `sim-`、不按 id 打破平局、多投影 `profile`、只给编辑角色、对匿名开放、`limit` 上限放宽、分页多给一条）全部变红。
- 页面没有在浏览器里单独走查（只经 typecheck 对上接口类型）；第 16 步托管 `/console` 之后的走查一并看。

### 第 14 步（2026-09-26）

- 没有砍。有草稿时，SOP 页多一张「与已发布 vN 的逐节对比」：只列正文与已发布版本不同的可编辑节，折叠面板展开才建编辑器；每节是 `@codemirror/merge`（6.12.2）的左右对比，两侧只读、自动换行，没改的长段落折叠成「N unchanged lines」。锁定节不参与（发布时取镜像）。
- 在 CSP 下的 preview 里走查：一份改了「话术原则」「异议处理」两节的草稿，对比面板列出这两节，增改行高亮，违规 0 条；截图 [walkthrough/09-draft-diff.jpg](walkthrough/09-draft-diff.jpg)。第 13 步的「会话」页顺带看了：viewer 有入口，页面在 CSP 下渲染正常。

### 第 15 步（2026-09-26）

- 没有砍。`POST /api/console/catalog/:kind/import-csv`（`canEdit`，请求体 `{ csv }`）：只建 draft，只收平铺字段——字符串、整数、布尔（是 / 否）、字符串数组（「、」分隔）；表头是字段名、列序随意，建出来的 payload 按 schema 的字段顺序排键（与 `data/` 里的文件一致）；空格子就是键不存在，必填的数组给 `[]`。整份先解析、逐行过共用的 zod schema、查文件内重复的 id，再在一个事务里（取配置写锁）查库里已有的 code，全部合格才按行序建出来（ord 接在最大值之后），任何一处不合格就一条也不建，422 `invalid_csv` 按行列出问题（row 0 是表头或整份文件）。每条写一行 `catalog.create` 审计，与后台新建相同。一次最多 200 行。
- 纯逻辑放在 `src/shared/`：`csv.ts` 是 RFC 4180 解析（引号里的逗号与换行、`""`、CRLF、BOM、末尾空行，引号没闭合就抛），`catalog-csv.ts` 由 schema 推出哪些字段是平铺的、把一行转成 payload、逐行校验；console 用同一份决定给不给入口、给出模板表头。
- **与 spec 的出入**：线路的必填字段 `itinerary` 是对象数组，按「只收平铺字段」线路没法用 CSV 建（draft 也要整条过 schema）。实现上对这种 kind 直接 422 并说明原因，界面上的按钮置灰、提示用「新建」；酒店全是平铺字段，照常导入。记进 Open。
- `console.selftest.ts` 增至 192 条：解析的边界、键序按 schema、数组切分与空的必填数组、引号里的逗号、ord 接续、不进快照、每条一行审计；七种不合格（没有的列、`__proto__` 列、数值写成文字、文件内 id 重复、库里已有、过不了 schema、只有表头）都 422 并点名行、且同一份里合格的行也没建；线路 422 并点名 `itinerary`；非编辑角色 403、匿名 401。9 个变异（不认 `""`、不去 BOM、按 CSV 列序排键、必填数组不给 `[]`、不查文件内重复、不查库里已有、跳过坏行照建好行、只要可读权限、不拦嵌套必填）全部变红。
- 在 CSP 下的 preview 里走查：线路页的「CSV 导入」置灰；酒店页弹窗给出模板表头，一份含坏行的 CSV 按行点名「第 2 行 nightlyFrom：要写整数」且没建，改好之后建成一条草稿出现在表里，违规 0 条；截图 [walkthrough/10-csv-import.jpg](walkthrough/10-csv-import.jpg)。

### 第 16 步（2026-09-26）

- **compose。** 补上 `app`：镜像 `APP_IMAGE`，容器名 `APP_CONTAINER`（缺省 `wecom-sales-agent`，与原来 `docker run` 的容器同名，`:prev` 两种起法都按这个名字取），`env_file: ../.env`，`PORT` 写死 3200，端口只绑 `127.0.0.1:${HOST_PORT}`，挂 `../var`，`stop_grace_period: 10s`，依赖 db 健康、migrate 成功。补上 `platform`：`profiles: [cli]`，只注入 `.env.platform`。文件开头写清楚各服务的 env 文件与命令行的跑法。
- **`/console` 的托管。** `src/console-api/host.ts`：`/console` 301 到 `/console/`；dist 里有的文件照常返回（index.html 除外）；`/console/assets/*` 不存在就 404，不回退；其余一律返回 index.html，每次响应现生成 nonce、换掉占位符并带页面的 CSP（第 12 步定的那条）。不用 serveStatic：它在目录路径上会把带占位符的原文件吐出去。读文件那一层也拦跑出 dist 的路径。构建产物目录可由 `CONSOLE_DIST` 指定，自测用临时目录，不依赖先构建。挂在 `consoleApi` 之后、public 的 serveStatic 之前。
- **与验收的对齐。** 验收 17 要 `/api/console/nope` 回 404 JSON，验收 16 要 prod 下匿名处处 401：兜底改为成员与 demo 匿名 404、prod 匿名 401。
- **deploy.sh。** 门禁、同步、构建与 `:prev` 取法不变；服务器检查多查 `.env.db`、`.env.migrate`；迁移单列一步（`compose run --rm migrate`，顺带拉起 db），失败就中止、旧容器照常，不走回滚；换容器是 `compose -p <NAME> up -d app`，第一次换成 compose 时先按 SIGTERM 停掉原来 `docker run` 起的同名容器（按 compose 的项目标签判断）；回滚是 `APP_IMAGE=<NAME>:prev … up -d --no-deps app`。旁路实例用自己的项目名，数据库卷与线上分开。
- **backup.sh。** 按 spec：db 容器里以超级用户经 socket `pg_dump -Fc` 与 `pg_dumpall --globals-only --no-role-passwords`；`pg_restore --list` 查四张 RLS 表都有 TABLE DATA，`sop_versions`、`catalog_items` 为 0 行就告警并非零退出；`var/` 打 tar；age 公钥加密（明文只在 0700 的临时目录里短暂存在）；本地按日期目录、0700、保留 7 天（只清理按日期命名的目录）；rclone 复制到 `BACKUP_OFFSITE` 并删掉 30 天前的，没配就每次在 stderr 告警。配置在 `.env.backup`，恢复步骤写在脚本开头。
- **本机 compose 实跑**（本机 Docker 只能挂 /Users 下的目录，演练目录放在 `~/Library/Caches`，用完删掉）：构建镜像，起 db（roles.sh 建角色和库）→ migrate → `platform` 建租户 → `app` 跑 import-config → 加 `CONFIG_SOURCE=db` 起 app，`/healthz` 为 DB 模式、哈希与文件模式相同；`app` 容器的 env 里没有 owner、platform 与超级用户的凭据（验收 23 的环境变量部分）。验收 17 的路由部分在真镜像上逐条过：`/console` 301、`/console/` 与深链返回换过 nonce 的 index.html、资源文件是 JS、不存在的资源 404、`/api/console/nope` 404 JSON、`/chat.html` 照旧；运行阶段的 `node_modules` 里没有 console 的依赖（第 12 步已验）。backup.sh：三份都是 age 密文、目录与文件权限 0700 / 0600、旧的日期目录被清掉而非日期目录保留、没配异地时 stderr 告警、配了本地 rclone 目标后复制成功且 30 天前的文件被删、解密后 `pg_restore --list` 有四张表的数据段；另建一个迁移过但没有内容的库，备份以「有一张是空的」非零退出。deploy.sh 的换容器与回滚命令在本机照搬执行：先用 `docker run` 起一个不归 compose 管的同名容器，迁移、按标签判断后停掉、`compose up` 接管（容器带上项目标签），再以 `:prev` `--no-deps` 回滚，两次 `/healthz` 都正常。deploy.sh 本身没有对真服务器跑（`bash -n`、shellcheck 通过），第 17 步由 owner 在线上首次执行。
- `console.selftest.ts` 增至 205 条（托管 13 条）。7 个变异（去掉路径兜底、`/console/index.html` 吐原文件、缺资源回退成页面、nonce 固定、资源不带安全头、demo 匿名兜底回 401、不 301）全部变红；「去掉路径兜底」起初存活（路由层已把 `../` 规范掉），补了一条直接查读文件那一层的断言。
- README 的部署一节改成 compose 的流程，加上后台与备份两条。

### 第 17 步（2026-09-26，本机部分；线上切换与真实模型对比待 owner）

本机 compose 上按 spec「导入、导出与回滚」走了一遍，演练目录与镜像用完都删了。

- **首次切换。** 按 spec 的顺序：先以文件模式部署能读库的镜像（`up -d app` 顺带起 db、跑迁移）→ `platform` 建租户和 owner 账号 → app 的 env 加 `DATABASE_URL`、`DEFAULT_TENANT_SLUG` → 以 app 身份 import（文件模式的应用在跑，不持锁）→ 加 `CONFIG_SOURCE=db` 重启。切换前后 `/healthz` 的 `promptHash`、`toolsHash`、`prefixHash`、`sopHash` 相同，切换后 `mode = db`、`sopVersion = 1`，app 容器的 env 里没有 owner、platform 与超级用户的凭据。去掉 `CONFIG_SOURCE=db` 重启回到文件模式、哈希不变，再加回去又是 DB 模式。
- **同一镜像回到文件模式（验收 18 第一例）。** 经后台接口改「话术原则」并发布（v2）、改一条线路的 highlights；重启时日志按节、按条目点名与镜像的差异（「话术原则」「内容不同 r-sichuan-lux」）。应用照常在跑时 `export-config`，同一镜像以文件模式、`SOP_PATH` / `ROUTES_PATH` / `HOTELS_PATH` 指向导出目录起来：`promptHash`、`toolsHash`、`prefixHash`、`sopHash` 与 DB 模式最后的值相同，方案书接口返回改过的 highlights。
- **回到上一个 tag（验收 18 第二例）。** `demo-v1.1` 的分离 worktree（不建分支）：以它的 `data/sop.md` 作 `--image-sop` 导出，拷进它的 `data/`、按 spec 用 oxfmt 格式化两个 JSON，做了一次真实的提交（过了那一版的 pre-commit：format、lint、typecheck、commitlint），在那一版上跑 `pnpm test` 全过（代替 CI，没有推送），用它构建镜像、以文件模式起来：镜像里 `data/sop.md` 的 sha256 等于导出时打印的 `sopHash`，方案书接口返回改过的 highlights。`demo-v1.1` 的 `/healthz` 还没有 `config` 一栏，所以按文件的 sha256 核对，而不是按 `/healthz`。
- **备份与恢复（验收 19）。** 有两个访客会话、改过 SOP 与 highlights 的实例上跑 `backup.sh`：三份 age 密文，没配异地时 stderr 告警。在全新的 compose 项目（新口令）上按脚本开头的固定步骤恢复：解密 → db 首次初始化由 roles.sh 建角色和库 → 以超级用户 `pg_restore --exit-on-error`（不加 `--no-owner`）→ 以 agent_owner 跑迁移（空操作，成功）→ 解开 `var/` → DB 模式启动。`/healthz` 的 `sopVersion`、`promptHash`、`prefixHash`、`sopHash` 与原库一致；四张 RLS 表的行数相同（memberships 1、sop_versions 2、catalog_items 43、audit_log 7）；改过的 highlights 还在；原 owner 账号能登录；以 agent_app 不设租户读 `catalog_items` 得 0 行；`var/` 恢复后会话数相同（2）。按日期建目录、清理 7 天前的目录、异地复制与 30 天清理已在第 16 步实跑。
- **待 owner**：线上 demo 的切换（下面「交接」一节给了按步骤的命令），切换后在线上跑一次备份与恢复演练并把不敏感的证据记进「验收记录」；真实模型对比（验收 21 的手动部分）要花真实的 LLM 调用，按「文件 → DB → 文件」交替各至少 3 遍。

## 验收记录

（对照验收标准逐条验证时填写：编号 · 通过 / 未通过 · 证据）

第 18 步（2026-09-26）在 dev（`f6e051e`）的干净 clone 上逐条核对；「故意改坏」的几条都在 clone 里改、跑、还原，没碰工作区。

- 1 · 通过 · 干净 clone 上 `pnpm test` 全绿；clone 里写一份含 `CONFIG_SOURCE=db`、`DATABASE_URL`（指向不存在的库）的 `.env` 再跑，结果不变。与 `f6f525c` 相比，`src/*.selftest.ts`、`src/adapters/*.selftest.ts`、`eval/cases.json` 只有新增的三组，唯一的改动是 `server.selftest.ts` 里 prod 下匿名连 `/api/admin/stream` 改为 401；`eval/run.ts` 只多了 DB 开关和 `--cases`。
- 2 · 通过 · `config.selftest.ts`「两种模式逐字节等价」（`promptPrefix`、`loadRoutes` / `loadHotels`、5 个只读工具、`create_order` 与 `handoff_to_human` 遮掉单号与时间后的返回和会话状态）；DB 模式 mock eval 的用例集合与文件模式相同（19/19）；`db.selftest.ts` 在真实 PG 上经 node-postgres 重复前两项。
- 3 · 通过 · `config.selftest.ts`（往返逐字节、编码不合格的六种文件失败且库里没有新行、同一份再导入 0、rerender 之后再导入 0、内容不同 2）与 `db.selftest.ts`（真实 PG 上以子进程跑 import / export、持锁时 3）；镜像里 `import-config --dry-run` 跑通：打印将写入的内容与三个哈希，库里没有新行。
- 4 · 通过 · `config.selftest.ts` 两种模式下的快照冻结与 `search_hotels({})` 连调。
- 5 · 通过 · `config.selftest.ts`（下一轮 `chat()` 的 system 等于新版本 rendered_prompt、回滚两例的 `sameHashAsTarget`、回滚到 draft / discarded 404、每次操作一行审计）与 `console.selftest.ts` 的 HTTP 部分（`/healthz` 与 `/api/chat` 立即跟着换）。
- 6 · 通过 · 五种草稿（另加 `create_refund`）检查报 violation、发布 422、已发布版本不变，保存锁定节 422（`config.selftest.ts`、`console.selftest.ts`）；另两条在 clone 里实测：`engine.selftest.ts` 加一条 `sys.includes('…')` 不进清单，`config.selftest.ts` 失败并点出短语；`data/sop.md` 的「报价纪律」节里写一个未知的 camelCase 字段，失败并点出它。
- 7 · 通过 · `db.selftest.ts`（已发布行改不动、非法插入被拒、部分唯一索引、agent_app 不能 DELETE）与 `config.selftest.ts`（草稿期间插入 rollback 与 rerender 后发布，版本号更大）。
- 8 · 通过 · `config.selftest.ts`「启动重渲染」：三种输入各自的 causes、system 审计、可编辑节保留、只改工具时 prompt_hash 不变；契约不过、去掉 toolNames / knownFields 里的项、渲染不确定、没有 active 线路时都非零退出且库不变。
- 9 · 通过 · `config.selftest.ts` 与 `console.selftest.ts`（逐个锁定字段 422、highlights 与 itinerary[0].detail 只动那一处且键序保持、原样提交审计 diff 为空、四类不合格补丁、draft 改 id 422、没有下架删除、方案书报价不变）；catalog-fix 在真实 PG 上以子进程验过（第 8 步）。
- 10 · 通过 · `config.selftest.ts` 与 `console.selftest.ts`：同 rev 第二次 409、并发同 code 一个 409 且 ord 不同、并发首次保存一个 409、草稿期间 locked_sections rerender 后发布成功、上游改另一节自动 rebase、改同一节 409 并点名。
- 11 · 通过 · `config.selftest.ts`「检索」：上架后恰好一次全量构建、构建中又上架、首次构建失败标过期并退避重试、文件模式请求次数与缓存不变。
- 12 · 通过 · `db.selftest.ts` 的真实 PG 部分（CI 里总是跑）：角色与表的权限逐格、跨租户读写、事务后 0 行、会话级 SET 泄漏销毁连接、agent_app 直读认证表被拒、认证函数恢复 `app.tenant_id`、临时表遮蔽、系统目录扫出没开 RLS 的表就变红。
- 13 · 通过 · `config.selftest.ts`「启动顺序与各个失败分支」（各 reason、`serve()` 与 `startWecom()` 未调用、cursor 文件不变）；另一进程持锁在真实 PG 上测（`db.selftest.ts`）。
- 14 · 通过 · `config.selftest.ts`「每轮不查库」：5 轮 mock 对话（含报价、下单）后 `queryCount()` 不变。
- 15 · 通过 · `console.selftest.ts`：cookie 属性与 `token_hash`、假时钟下空闲 12 小时与绝对 7 天、三路限流与防探测、CSRF 三种拒法、viewer 发布 403、旧参数口令升级、停用即 401、prod 下后台 SSE 要求会话；`server.selftest.ts` 的 Basic 流程不变。
- 16 · 通过 · `console.selftest.ts`：prod 匿名处处 401（登录除外），demo 匿名的投影、不查库、没有 uuid 与姓名与草稿、`/status` 只有 mode、审计与会话列表与写请求 401、文件模式 503、安全头覆盖十种状态码（页面的 CSP 按第 12 步那条，见 Open）。
- 17 · 通过 · 镜像里的路由在第 16 步实测（`/console/` 与深链返回 index.html、资源文件是 JS、`/api/console/nope` 404 JSON、`/chat.html` 照旧）；产物扫描进 `test`；改名 `Me.displayName` 时 console 与服务端同时报错、`@ts-expect-error` 夹具在 typecheck 范围内（第 12 步）。
- 18 · 本机通过（同一镜像、上一个 tag 两例，外加启动日志点名差异）· 证据见第 17 步实施记录。线上部署旧 tag 的那一例待 owner。
- 19 · 本机通过 · `/healthz` 的 sopVersion 2、promptHash `551e69c20efc`、prefixHash `a32bdae5229e`、sopHash `46b9a7fde0d3` 恢复前后相同；四张 RLS 表行数 1 / 2 / 43 / 7 相同；原账号能登录；agent_app 不设租户读到 0 行；会话数 2 相同；backup.sh 的日期目录、7 天清理、密文、未配异地告警见第 16 步。线上的恢复演练待 owner。
- 20 · 通过 · 干净 clone 上四个门禁全过；clone 里实测：CI=true 而没有 `PG_TEST_URL` 时 `db.selftest.ts` 失败；迁移里加未标注的 `DROP COLUMN`、`SET NOT NULL`，或改已提交的迁移，`lint` 失败并点名文件；`src/shared/` 下 import `drizzle-orm`、`src/config/` 下 import `store`、`src/engine.ts` 里出现 `app.tenant_id`，`lint` 都失败。
- 21 · 自动部分通过（DB 模式 mock eval：22 个请求的前缀哈希与 `/healthz` 全部一致）· 手动部分（真实模型、P90 与缓存命中率）待 owner，命令见「交接」。
- 22 · 通过 · 第 12 步用 Playwright 走查，截图 [walkthrough/01–08](walkthrough/)（登录 → 编辑 → 检查按节列 violation → 发布 → 历史 → 回滚；产品库锁定字段只读、改 highlights、新建 draft 并二次确认上架；审计；demo 匿名横幅、无审计入口）。
- 23 · 本机通过 · 切换前后 promptHash `6c202d633b60`、toolsHash `64c16fc8f464`、prefixHash `cd3cc7dab87a` 相同，`mode = db`、`sopVersion = 1`，app 的 env 里没有特权凭据。线上 demo 的切换待 owner。

## Open

- 已定（owner，2026-09-26，00 开放问题 3）：oxlint 在 correctness 之外开 suspicious，但关掉 `no-shadow`（139 处，几乎都在自测里）、`consistent-function-scoping`（52）、`no-underscore-dangle`（与 spec 定的 `__configTest` 这类命名冲突）、`no-async-endpoint-handlers`（针对 Express，Hono 的 async handler 是正常写法）。pedantic、perf、style、restriction、nursery 不开：全仓命中 1332 / 136 / 11097 / 1891 / 584，基本是风格噪音或误报（nursery 的 583 条是 `no-undef` 不认 TS 类型）。
- 待 owner 在目标服务器上实测（开放问题 4，第 10 步）：两个并发登录的单次耗时与峰值 RSS 增量。本机数据见第 10 步实施记录（约 170 ms、256 MiB）。单次超过 500 ms，或峰值增量超过机器内存的 25%（1 GiB 的机器就是这条线），按开放问题 4 改用 N = 2^16、r = 8、p = 2，参数随哈希存，不用迁移。
- 待 owner 复核（第 12 步）：`/console` 页面的 CSP 在 spec 那条之外多一条 `style-src 'self' 'nonce-…'`（每个响应现生成），否则 Ant Design 与 CodeMirror 没有样式；`/api/console/*` 的 CSP 不变。验收 16 查安全头时按这条对页面核对。另一种做法是 `style-src 'self' 'unsafe-inline'`，简单但放开了所有内联样式；也可以换掉运行时插样式的组件库，代价是推翻 ADR-002 的 Ant Design。理由与实现见第 12 步实施记录。
- 供 owner 知悉（第 15 步）：spec 的 CSV 导入「只收平铺字段」，而线路的 `itinerary` 必填且是对象数组，所以线路没法用 CSV 建；现在对线路直接拒并提示用表单，酒店照常。要支持线路，得约定逐日行程的平铺写法（例如 `itinerary.1.title` 这样的列），可以放到 02。
- 仍挂在 owner 名下（00 开放问题 1 的余下部分）：文件模式下没设 `DEPLOY_PROFILE` 却配了企微凭据时，是否也拒绝启动。第一个 prod 实例上线前定。

## 交接（2026-09-26）

- 已完成：第 1–16 步（全部合进 dev）；第 17 步的本机演练（见实施记录）；第 18 步在干净 clone 上逐条核对了全部验收标准，除依赖线上的几处外都通过（见「验收记录」）。
- 半成品：无。
- 阻塞：第 17 步的线上部分要 owner 在服务器上执行；第 18 步里依赖线上的几条（19、23 的线上部分，21 的手动部分）随之等待。
- 下一步（owner）：
  1. **先以文件模式部署能读库的镜像。** 服务器部署目录里先写好 `.env.db`、`.env.migrate`、`.env.platform`（写法见 `deploy/compose.yml` 开头；口令只用字母数字），`.env` 暂不加数据库变量。本机打 tag 后 `bash deploy.sh <tag>`：第一次会起 db（roles.sh 建角色和库）、跑迁移，并接管原来 `docker run` 起的容器。核对 `/healthz`：`revision` 是新 tag、`config.mode = file`，记下 `promptHash`、`toolsHash`、`prefixHash`。
  2. **建租户和账号**（在部署目录里，下同；compose 命令都要带 `APP_IMAGE=wecom-sales-agent:latest`）：`docker compose -f deploy/compose.yml --profile cli run --rm -T platform node --import tsx src/cli/tenant-create.ts --slug <slug> --name <名称> --pack travel`；账号用 `user-create.ts --tenant <slug> --email … --name … --role owner`，口令经 `--password-stdin` 或在终端里生成。
  3. **写 app 的 env**：`.env` 加 `DATABASE_URL=postgres://agent_app:<口令>@db:5432/agent`、`DEFAULT_TENANT_SLUG=<slug>`，确认 `DEPLOY_PROFILE` 已显式设置。
  4. **以 app 身份导入**：`docker compose -f deploy/compose.yml run --rm -T app node --import tsx src/cli/import-config.ts --tenant <slug>`，打印的三个哈希应与第 1 步相同。
  5. **切换**：`.env` 加 `CONFIG_SOURCE=db`，`docker compose -f deploy/compose.yml up -d app`。核对 `/healthz`：`config.mode = db`、`sopVersion = 1`，三个哈希与第 1 步相同；`docker compose -f deploy/compose.yml exec app env` 里没有 owner、platform 或超级用户的凭据（验收 23）。失败就去掉 `CONFIG_SOURCE=db` 再 `up -d app` 回到文件模式，什么也不会丢。
  6. **备份**：服务器装 age（配异地的话再装 rclone），`.env.backup` 写 `BACKUP_AGE_RECIPIENTS`（私钥不放服务器）和 `BACKUP_OFFSITE`，cron 每晚 `bash deploy/backup.sh`；手动跑一次，按脚本开头的步骤在另一台机器或旁路项目上恢复演练，把不敏感的证据记进「验收记录」（验收 19）。
  7. **真实模型对比**（验收 21 的手动部分，要花真实的 LLM 调用）：从 `eval/cases.json` 过滤出 realOnly 用例写到仓库外的文件，按「文件 → DB → 文件」交替各至少跑 3 遍：文件模式 `CONFIG_SOURCE=file tsx eval/run.ts --cases <文件>`，DB 模式再加 `CONFIG_TEST_DB=pglite`。每遍记下输出里的 P90 和前缀缓存命中率，两种模式的 P90 都不超过 8 秒算通过，数字记进「验收记录」。
  8. 复核 Open 里第 12、15 步的两条。线上部分（验收 18、19、23 的线上一例与 21 的手动部分）做完把结果补进「验收记录」，我再勾第 17、18 步、做第 19 步。

<!-- 「交接」与「Open」两节在第一次停下时再追加，格式（本注释保留给后来的 agent）：
## 交接（YYYY-MM-DD）
- 已完成：
- 半成品：第 K 步做到 …，代码停在 …（能否 build）
- 阻塞：
- 下一步：

## Open
- 与 spec 的分歧、需要 owner 裁决的事
-->
